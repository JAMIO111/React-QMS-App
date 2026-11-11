-- Document control DC3: readers (targets) fixed when a revision takes effect, viewing and acknowledging, due dates, restricted documents,
-- people added later, skills and the competence evidence, the "for you to read" notice.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('3f000000-0000-0000-0000-000000000b01', 'ann@rd.test'), ('3f000000-0000-0000-0000-000000000b02', 'bob@rd.test'),
  ('3f000000-0000-0000-0000-000000000b03', 'cat@rd.test'), ('3f000000-0000-0000-0000-000000000b04', 'dan@rd.test'),
  ('3f000000-0000-0000-0000-000000000b05', 'eve@rd.test'), ('3f000000-0000-0000-0000-000000000b06', 'fay@rd.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

-- Makes a revision effective today: reviewer cat, approver bob (quality manager).
CREATE FUNCTION pg_temp.issue(p_rev uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000b01');
  PERFORM app.set_document_signers(p_rev, ARRAY['3f000000-0000-0000-0000-000000000b03']::uuid[], '3f000000-0000-0000-0000-000000000b02');
  PERFORM app.submit_document_revision(p_rev);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000b03'); PERFORM app.review_document_revision(p_rev, true); PERFORM pg_temp.logout();
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000b02'); PERFORM app.approve_document_revision(p_rev, current_date); PERFORM pg_temp.logout();
END $$;

DO $$
DECLARE
  -- ann owner (writes); bob quality manager (approves); cat quality engineer (reviews); dan viewer in Assembly; fay viewer, not a reader; eve other org.
  ann uuid := '3f000000-0000-0000-0000-000000000b01'; bob uuid := '3f000000-0000-0000-0000-000000000b02'; cat uuid := '3f000000-0000-0000-0000-000000000b03';
  dan uuid := '3f000000-0000-0000-0000-000000000b04'; eve uuid := '3f000000-0000-0000-0000-000000000b05'; fay uuid := '3f000000-0000-0000-0000-000000000b06';
  org uuid; org2 uuid; sop uuid; site uuid; dept uuid; dan_m uuid; fay_m uuid; viewer_role uuid; d1 uuid; r1 uuid; r2 uuid; d2 uuid; r3 uuid; emp uuid; sk uuid; r text;
  v_body jsonb := '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Read me"}]}]}';
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('RD Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('RD Beta'); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, bob, 'active'), (org, cat, 'active'), (org, dan, 'active'), (org, fay, 'active');
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = CASE ou.user_id WHEN bob THEN 'quality_manager' WHEN cat THEN 'quality_engineer' ELSE 'viewer' END)
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id IN (bob, cat, dan, fay);
  SELECT id INTO dan_m FROM public.organisation_users WHERE organisation_id = org AND user_id = dan;
  SELECT id INTO fay_m FROM public.organisation_users WHERE organisation_id = org AND user_id = fay;
  SELECT id INTO site FROM public.sites WHERE organisation_id = org LIMIT 1;
  INSERT INTO public.departments (organisation_id, site_id, code, name) VALUES (org, site, 'ASM', 'Assembly') RETURNING id INTO dept;
  INSERT INTO public.department_members (organisation_id, department_id, membership_id, is_primary) VALUES (org, dept, dan_m, true);
  SELECT id INTO viewer_role FROM public.roles WHERE organisation_id = org AND key = 'viewer';

  PERFORM pg_temp.login(ann);
  SELECT id INTO sop FROM public.document_types WHERE organisation_id = org AND prefix = 'SOP';
  d1 := app.create_document(org, jsonb_build_object('typeId', sop, 'title', 'Torque procedure', 'contentKind', 'text'));
  SELECT id INTO r1 FROM public.document_revisions WHERE document_id = d1;
  PERFORM app.update_document_revision(r1, jsonb_build_object('body', v_body, 'acknowledgeWithinDays', 14));
  r := pg_temp.fails(format($f$SELECT app.update_document_revision(%L, '{"acknowledgeWithinDays":0}'::jsonb)$f$, r1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', '1 to 365 days');
  PERFORM app.set_document_targets(d1, jsonb_build_array(jsonb_build_object('departmentId', dept), jsonb_build_object('membershipId', (SELECT id FROM public.organisation_users WHERE organisation_id = org AND user_id = cat))));
  r := pg_temp.fails(format($f$SELECT app.set_document_targets(%L, '[{"departmentId":%s,"roleId":%s}]'::jsonb)$f$, d1, to_json(dept::text), to_json(viewer_role::text)));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'one department, role or person per entry');
  r := pg_temp.fails(format($f$SELECT app.set_document_targets(%L, '[{"departmentId":%s}]'::jsonb)$f$, d1, to_json(gen_random_uuid()::text)));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'an unknown department is refused');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.resolve_document_targets(d1)), 2::bigint, 'Assembly reaches dan; cat is named');

  -- ---- nobody is asked until a revision takes effect ----
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.document_recipients), 0::bigint, 'no recipients before it takes effect');
  PERFORM pg_temp.issue(r1);
  PERFORM pg_temp.assert_eq((SELECT string_agg(x.user_id::text || ':' || array_to_string(x.reached_via, '+') || ':' || (x.due_on - current_date), ',' ORDER BY x.user_id)
                               FROM public.document_recipients x WHERE x.revision_id = r1),
    cat || ':Named:14,' || dan || ':Department: Assembly:14', 'fixed when it takes effect, with how they were reached and a due date');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.notifications WHERE entity_type = 'document_recipients' AND recipient_user_id = dan AND actor_user_id IS NULL), 1::bigint,
    'dan is told, with no actor');
  PERFORM pg_temp.assert_eq((SELECT body FROM public.notifications WHERE entity_type = 'document_recipients' AND recipient_user_id = dan),
    'SOP-001 rev A · Torque procedure — Acknowledge by ' || to_char(current_date + 14, 'FMDD Mon YYYY'), 'naming the revision and the date');

  -- ---- viewing and acknowledging ----
  PERFORM pg_temp.login(dan);
  PERFORM app.mark_document_viewed(r1);
  PERFORM app.mark_document_viewed(r1);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.document_recipients WHERE first_viewed_at IS NOT NULL), 1::bigint, 'dan reads only their own row; the first view is kept');
  r := pg_temp.fails(format($f$SELECT app.acknowledge_document(%L, repeat('x', 1001))$f$, r1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'a note is up to 1000 characters');
  PERFORM app.acknowledge_document(r1, 'Read at the toolbox talk');
  r := pg_temp.fails(format('SELECT app.acknowledge_document(%L)', r1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'once');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(fay);
  r := pg_temp.fails(format('SELECT app.acknowledge_document(%L)', r1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'someone not asked cannot acknowledge');
  PERFORM app.mark_document_viewed(r1);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.document_recipients), 0::bigint, 'fay sees no one''s rows');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.documents WHERE id = d1), 1::bigint, 'an unrestricted document is read by every reader');
  PERFORM pg_temp.logout();

  -- ---- restricted ----
  PERFORM pg_temp.login(ann);
  PERFORM app.update_document(d1, '{"restricted":true}'::jsonb);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(fay);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.documents WHERE id = d1), 0::bigint, 'restricted: hidden from someone it does not reach');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.document_revisions WHERE id = r1), 0::bigint, 'and its revisions');
  PERFORM pg_temp.assert_eq(app.document_file_allowed(org || '/document/' || r1 || '/x.pdf', false), false, 'and its files');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(dan);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.documents WHERE id = d1), 1::bigint, 'a reader still opens it');
  PERFORM pg_temp.logout();

  -- ---- added later; a new revision asks everyone again ----
  PERFORM pg_temp.login(ann);
  PERFORM app.add_document_recipient(r1, fay);
  r := pg_temp.fails(format('SELECT app.add_document_recipient(%L, %L)', r1, fay));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'once');
  r := pg_temp.fails(format('SELECT app.add_document_recipient(%L, %L)', r1, eve));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'only members');
  PERFORM pg_temp.assert_eq((SELECT reached_via[1] FROM public.document_recipients WHERE revision_id = r1 AND user_id = fay), 'Added', 'added later');
  r2 := app.start_document_revision(d1);
  PERFORM app.update_document_revision(r2, '{"changeSummary":"Torque values updated"}'::jsonb);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(fay);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.documents WHERE id = d1), 1::bigint, 'someone added reads the restricted document');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.issue(r2);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.document_recipients WHERE revision_id = r2 AND acknowledged_at IS NULL), 2::bigint, 'rev B asks the targets again');
  PERFORM pg_temp.assert_eq((SELECT due_on IS NULL FROM public.document_recipients WHERE revision_id = r2 LIMIT 1), true, 'rev B set no deadline');
  PERFORM pg_temp.login(dan);
  r := pg_temp.fails(format('SELECT app.acknowledge_document(%L)', r1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'a superseded revision is not acknowledged');
  PERFORM pg_temp.logout();

  -- ---- skills and the competence evidence ----
  PERFORM pg_temp.login(ann);
  sk := app.save_competence_skill(org, jsonb_build_object('code', 'TORQ', 'name', 'Torque tightening', 'categoryId', (SELECT id FROM public.competence_categories WHERE organisation_id = org AND key = 'machine_operation')));
  PERFORM app.set_document_skills(d1, ARRAY[sk]);
  r := pg_temp.fails(format('SELECT app.set_document_skills(%L, ARRAY[%L]::uuid[])', d1, gen_random_uuid()));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'only active skills of the organisation');
  PERFORM pg_temp.logout();
  INSERT INTO public."Employees" (organisation_id, first_name, surname, auth_id) VALUES (org, 'Dan', 'D', dan) RETURNING id INTO emp;
  PERFORM pg_temp.login(dan);
  PERFORM pg_temp.assert_eq((SELECT number || ' rev ' || letter || ' ' || (skills -> 0 ->> 'code') FROM app.competence_document_evidence(emp)), 'SOP-001 rev A TORQ',
    'the person sees their acknowledgement as evidence for the skill');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(fay);
  r := pg_temp.fails(format('SELECT * FROM app.competence_document_evidence(%L)', emp));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'nobody else without competence.read');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.competence_document_evidence(emp)), 1::bigint, 'competence readers see it');
  PERFORM pg_temp.logout();

  -- ---- the database holds the rules ----
  r := pg_temp.fails(format($f$UPDATE public.document_recipients SET acknowledged_at = now() + interval '1 day' WHERE revision_id = %L AND user_id = %L$f$, r1, dan));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'an acknowledgement is frozen');
  r := pg_temp.fails(format($f$UPDATE public.document_recipients SET due_on = current_date WHERE revision_id = %L$f$, r2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'who was asked and by when never changes');
  r := pg_temp.fails(format($f$DELETE FROM public.document_recipients WHERE revision_id = %L$f$, r2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'never deleted');
  PERFORM pg_temp.login(dan);
  r := pg_temp.fails(format($f$UPDATE public.document_recipients SET acknowledge_note = 'x' WHERE revision_id = %L$f$, r2));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'no direct writes');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve);
  r := pg_temp.fails(format($f$SELECT app.set_document_targets(%L, '[]'::jsonb)$f$, d1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'another organisation finds nothing');
  PERFORM pg_temp.logout();
  -- a document with no readers named takes effect and asks nobody
  PERFORM pg_temp.login(ann);
  d2 := app.create_document(org, jsonb_build_object('typeId', sop, 'title', 'No readers', 'contentKind', 'text'));
  SELECT id INTO r3 FROM public.document_revisions WHERE document_id = d2;
  PERFORM app.update_document_revision(r3, jsonb_build_object('body', v_body));
  PERFORM pg_temp.logout();
  PERFORM pg_temp.issue(r3);
  PERFORM pg_temp.assert_eq((SELECT status FROM public.document_revisions WHERE id = r3) || '/' || (SELECT count(*) FROM public.document_recipients WHERE revision_id = r3), 'effective/0',
    'allowed to reach nobody');
END $$;

ROLLBACK;
