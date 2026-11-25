-- Change management CH1: permissions and role defaults, the seeded lists, raising a change (reference, origin, scope links), drafts only, cancelling,
-- files, tenancy.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('4c000000-0000-0000-0000-000000000c01', 'ann@ch.test'), ('4c000000-0000-0000-0000-000000000c02', 'bob@ch.test'),
  ('4c000000-0000-0000-0000-000000000c03', 'eve@ch.test'), ('4c000000-0000-0000-0000-000000000c04', 'cat@ch.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '4c000000-0000-0000-0000-000000000c01'; bob uuid := '4c000000-0000-0000-0000-000000000c02';
  eve uuid := '4c000000-0000-0000-0000-000000000c03'; cat uuid := '4c000000-0000-0000-0000-000000000c04';
  org uuid; org2 uuid; t_proc uuid; t_inactive uuid; c1 uuid; c2 uuid; c3 uuid; part uuid; part2 uuid; fam uuid; r text; u uuid; att uuid; ncr uuid; n bigint;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('CH Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('CH Beta'); PERFORM pg_temp.logout();
  -- Bob: viewer (reads). Cat: quality engineer (manages).
  FOREACH u IN ARRAY ARRAY[bob, cat] LOOP
    INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u, 'active');
  END LOOP;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = CASE ou.user_id WHEN cat THEN 'quality_engineer' ELSE 'viewer' END)
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id IN (bob, cat);

  -- ---- permissions and role defaults ----
  PERFORM pg_temp.assert_eq((SELECT array_agg(rp.permission_code ORDER BY rp.permission_code) FROM public.role_permissions rp JOIN public.roles r ON r.id = rp.role_id
    WHERE r.organisation_id = org AND r.key = 'quality_manager' AND rp.permission_code LIKE 'change.%'), ARRAY['change.approve','change.manage','change.read'], 'a quality manager holds all three');
  PERFORM pg_temp.assert_eq((SELECT array_agg(rp.permission_code ORDER BY rp.permission_code) FROM public.role_permissions rp JOIN public.roles r ON r.id = rp.role_id
    WHERE r.organisation_id = org AND r.key = 'viewer' AND rp.permission_code LIKE 'change.%'), ARRAY['change.read'], 'a viewer reads');
  PERFORM pg_temp.assert_eq((SELECT array_agg(rp.permission_code ORDER BY rp.permission_code) FROM public.role_permissions rp JOIN public.roles r ON r.id = rp.role_id
    WHERE r.organisation_id = org AND r.key = 'inspector' AND rp.permission_code LIKE 'change.%'), ARRAY['change.read'], 'an inspector reads');

  -- ---- the seeded lists ----
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.change_types WHERE organisation_id = org), 7::bigint, 'seven types are seeded');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.change_functions WHERE organisation_id = org), 5::bigint, 'five functions are seeded');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.change_areas WHERE organisation_id = org), 12::bigint, 'twelve impact areas are seeded');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.change_types WHERE organisation_id = org2), 0::bigint, 'another organisation''s lists are invisible');
  SELECT id INTO t_proc FROM public.change_types WHERE organisation_id = org AND key = 'process';
  SELECT id INTO t_inactive FROM public.change_types WHERE organisation_id = org AND key = 'other';
  UPDATE public.change_types SET active = false WHERE id = t_inactive;
  PERFORM pg_temp.assert_eq((SELECT needs_customer_approval FROM public.change_types WHERE id = t_proc), true, 'a process change needs the customer by default');
  PERFORM pg_temp.logout();

  -- A viewer cannot edit a list.
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq(pg_temp.affected(format('UPDATE public.change_types SET label = ''Hacked'' WHERE id = %L', t_proc)), 0::bigint, 'a viewer cannot change a type');
  PERFORM pg_temp.logout();

  SELECT id INTO part FROM public.parts WHERE organisation_id = org LIMIT 1;
  PERFORM pg_temp.login(ann);
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'CH-P1', 'Bracket') RETURNING id INTO part;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'CH-P2', 'Plate') RETURNING id INTO part2;
  INSERT INTO public.part_families (organisation_id, code, name) VALUES (org, 'CH-F1', 'Brackets') RETURNING id INTO fam;
  PERFORM pg_temp.logout();

  -- ---- raising a change ----
  PERFORM pg_temp.login(bob);
  r := pg_temp.fails(format($f$SELECT app.create_change(%L, jsonb_build_object('title', 'x', 'typeId', %L))$f$, org, t_proc));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a viewer cannot raise a change');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login(cat);
  r := pg_temp.fails(format($f$SELECT app.create_change(%L, jsonb_build_object('typeId', %L))$f$, org, t_proc));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'a title is needed');
  r := pg_temp.fails(format($f$SELECT app.create_change(%L, jsonb_build_object('title', 'x'))$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'a type is needed');
  r := pg_temp.fails(format($f$SELECT app.create_change(%L, jsonb_build_object('title', 'x', 'typeId', %L))$f$, org, t_inactive));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'a switched-off type is refused');
  r := pg_temp.fails(format($f$SELECT app.create_change(%L, jsonb_build_object('title', 'x', 'typeId', %L, 'urgency', 'now'))$f$, org, t_proc));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'urgency is normal or expedited');
  r := pg_temp.fails(format($f$SELECT app.create_change(%L, jsonb_build_object('title', 'x', 'typeId', %L, 'colour', 'red'))$f$, org, t_proc));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'an unknown field is refused');

  c1 := app.create_change(org, jsonb_build_object('title', 'Move bracket to the new CNC', 'description', 'Run it on machine 7', 'reason', 'Capacity', 'typeId', t_proc,
    'links', jsonb_build_array(jsonb_build_object('kind', 'part', 'id', part), jsonb_build_object('kind', 'part', 'id', part),
                               jsonb_build_object('kind', 'part_family', 'id', fam), jsonb_build_object('kind', 'operation_code', 'code', 'OP10'))));
  PERFORM pg_temp.assert_eq((SELECT reference FROM public.change_requests WHERE id = c1), 'ECR-' || lpad((extract(year FROM current_date)::integer % 100)::text, 2, '0') || '-0001', 'the first reference');
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.change_requests WHERE id = c1), 'draft', 'it starts as a draft');
  PERFORM pg_temp.assert_eq((SELECT raised_by FROM public.change_requests WHERE id = c1), cat, 'it names who raised it');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.change_links WHERE change_id = c1), 3::bigint, 'a duplicate link is dropped');
  c2 := app.create_change(org, jsonb_build_object('title', 'Second', 'typeId', t_proc));
  PERFORM pg_temp.assert_eq((SELECT right(reference, 4) FROM public.change_requests WHERE id = c2), '0002', 'the next reference follows');

  -- Scope links.
  r := pg_temp.fails(format($f$SELECT app.set_change_links(%L, '[{"kind":"part","id":"00000000-0000-0000-0000-0000000000aa"}]'::jsonb)$f$, c1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'a part that is not there is refused');
  r := pg_temp.fails(format($f$SELECT app.set_change_links(%L, '[{"kind":"banana","id":"00000000-0000-0000-0000-0000000000aa"}]'::jsonb)$f$, c1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'an unknown kind is refused');
  PERFORM app.set_change_links(c1, jsonb_build_array(jsonb_build_object('kind', 'part', 'id', part2)));
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.change_links WHERE change_id = c1), 1::bigint, 'the links are replaced as a whole');
  PERFORM pg_temp.assert_eq((SELECT part_id FROM public.change_links WHERE change_id = c1), part2, 'with the new one');

  -- Editing a draft.
  PERFORM app.update_change(c1, jsonb_build_object('title', 'Move bracket to CNC 7', 'reason', NULL, 'urgency', 'expedited'));
  PERFORM pg_temp.assert_eq((SELECT title FROM public.change_requests WHERE id = c1), 'Move bracket to CNC 7', 'the title changes');
  PERFORM pg_temp.assert_eq((SELECT reason IS NULL FROM public.change_requests WHERE id = c1), true, 'null clears the why');
  PERFORM pg_temp.assert_eq((SELECT urgency FROM public.change_requests WHERE id = c1), 'expedited', 'urgency changes');
  r := pg_temp.fails(format($f$SELECT app.update_change(%L, '{"title":""}'::jsonb)$f$, c1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'the title cannot be blanked');
  PERFORM pg_temp.logout();

  -- ---- origin: only a record the person may read, in this organisation, and never changed ----
  PERFORM pg_temp.login(ann);
  ncr := (SELECT id FROM public.nonconformances WHERE organisation_id = org LIMIT 1);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  r := pg_temp.fails(format($f$SELECT app.create_change(%L, jsonb_build_object('title', 'x', 'typeId', %L, 'origin', jsonb_build_object('kind', 'ncr', 'id', '00000000-0000-0000-0000-0000000000bb')))$f$, org, t_proc));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'an origin that is not there is not found');
  r := pg_temp.fails(format($f$SELECT app.create_change(%L, jsonb_build_object('title', 'x', 'typeId', %L, 'origin', jsonb_build_object('kind', 'supplier', 'id', %L)))$f$, org, t_proc, part));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'an origin must be one of the five kinds');
  PERFORM pg_temp.logout();

  -- ---- the rules the table holds even for SQL ----
  r := pg_temp.fails(format('UPDATE public.change_requests SET reference = ''ECR-99-0001'' WHERE id = %L', c1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'the reference never changes');
  r := pg_temp.fails(format('UPDATE public.change_requests SET raised_by = %L WHERE id = %L', bob, c1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'who raised it never changes');
  r := pg_temp.fails(format('UPDATE public.change_requests SET origin_kind = ''risk'', origin_id = gen_random_uuid() WHERE id = %L', c1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'the origin never changes');
  r := pg_temp.fails(format('DELETE FROM public.change_requests WHERE id = %L', c1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'a change is never deleted');
  PERFORM pg_temp.login(cat);
  r := pg_temp.fails(format('UPDATE public.change_requests SET title = ''Direct'' WHERE id = %L', c1));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'there is no table write for people');
  PERFORM pg_temp.logout();

  -- ---- files ----
  PERFORM pg_temp.login(cat);
  r := pg_temp.fails(format($f$SELECT app.add_change_attachment(%L, 'elsewhere/x.pdf', 'x.pdf', 'application/pdf', 10)$f$, c1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'a file must sit in the change''s own folder');
  att := app.add_change_attachment(c1, org || '/change/' || c1 || '/' || gen_random_uuid() || '-drawing.pdf', 'drawing.pdf', 'application/pdf', 1000, 'New drawing');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.change_attachments WHERE change_id = c1), 1::bigint, 'the file is recorded');
  r := pg_temp.fails(format($f$SELECT app.remove_change_attachment(%L, 'x')$f$, att));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'a reason is needed to remove a file');
  PERFORM app.remove_change_attachment(att, 'Wrong drawing');
  PERFORM pg_temp.assert_eq((SELECT delete_reason FROM public.change_attachments WHERE id = att), 'Wrong drawing', 'the removal is marked');
  r := pg_temp.fails(format($f$SELECT app.remove_change_attachment(%L, 'Again please')$f$, att));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'it cannot be removed twice');
  PERFORM app.restore_change_attachment(att);
  PERFORM pg_temp.assert_eq((SELECT deleted_at IS NULL FROM public.change_attachments WHERE id = att), true, 'it can be brought back');
  PERFORM pg_temp.logout();
  r := pg_temp.fails(format('DELETE FROM public.change_attachments WHERE id = %L', att));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'a file is never deleted');
  r := pg_temp.fails(format('UPDATE public.change_attachments SET file_name = ''other.pdf'' WHERE id = %L', att));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'a file''s details never change');
  PERFORM pg_temp.assert_eq(app.change_file_allowed(org || '/change/' || c1 || '/x', false), false, 'the file helper answers false outside a session');

  -- The storage rule: a member who may read changes reads, only a manager uploads.
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq(app.storage_file_allowed('change-files', org || '/change/' || c1 || '/x', false), true, 'a viewer may read a change''s files');
  PERFORM pg_temp.assert_eq(app.storage_file_allowed('change-files', org || '/change/' || c1 || '/x', true), false, 'a viewer may not upload');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  PERFORM pg_temp.assert_eq(app.storage_file_allowed('change-files', org || '/change/' || c1 || '/x', true), true, 'a manager uploads');
  PERFORM pg_temp.assert_eq(app.storage_file_allowed('change-files', org || '/change/' || gen_random_uuid() || '/x', true), false, 'not into a change that is not there');
  PERFORM pg_temp.logout();

  -- ---- cancelling ----
  PERFORM pg_temp.login(cat);
  r := pg_temp.fails(format($f$SELECT app.cancel_change(%L, 'x')$f$, c2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'a reason is needed');
  PERFORM app.cancel_change(c2, 'Raised twice by mistake');
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.change_requests WHERE id = c2), 'cancelled', 'it is cancelled');
  PERFORM pg_temp.assert_eq((SELECT cancelled_by FROM public.change_requests WHERE id = c2), cat, 'who cancelled it is kept');
  r := pg_temp.fails(format($f$SELECT app.cancel_change(%L, 'again please')$f$, c2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'a cancelled change cannot be cancelled again');
  r := pg_temp.fails(format($f$SELECT app.update_change(%L, '{"title":"Revived"}'::jsonb)$f$, c2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'a cancelled change cannot be edited');
  r := pg_temp.fails(format($f$SELECT app.set_change_links(%L, '[]'::jsonb)$f$, c2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'its scope cannot change');
  r := pg_temp.fails(format($f$SELECT app.add_change_attachment(%L, %L, 'a.pdf', 'application/pdf', 1)$f$, c2, org || '/change/' || c2 || '/a.pdf'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'a cancelled change takes no more files');
  PERFORM pg_temp.logout();
  r := pg_temp.fails(format('UPDATE public.change_requests SET title = ''Revived'' WHERE id = %L', c2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'the table holds that too, even for SQL');

  -- ---- tenancy ----
  PERFORM pg_temp.login(eve);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.change_requests WHERE organisation_id = org), 0::bigint, 'another organisation cannot see the changes');
  r := pg_temp.fails(format($f$SELECT app.update_change(%L, '{"title":"Stolen"}'::jsonb)$f$, c1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'another organisation''s change is not found');
  r := pg_temp.fails(format($f$SELECT app.cancel_change(%L, 'Not yours at all')$f$, c1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'nor can it be cancelled');
  r := pg_temp.fails(format($f$SELECT app.create_change(%L, jsonb_build_object('title', 'x', 'typeId', %L))$f$, org, t_proc));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'nor raised in');
  c3 := app.create_change(org2, jsonb_build_object('title', 'Mine', 'typeId', (SELECT id FROM public.change_types WHERE organisation_id = org2 AND key = 'process')));
  PERFORM pg_temp.assert_eq((SELECT right(reference, 4) FROM public.change_requests WHERE id = c3), '0001', 'numbers run per organisation');
  r := pg_temp.fails(format($f$SELECT app.create_change(%L, jsonb_build_object('title', 'x', 'typeId', %L))$f$, org2, t_proc));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'another organisation''s type is refused');
  PERFORM pg_temp.logout();
  RAISE NOTICE 'change management core: ok';
END $$;
ROLLBACK;
