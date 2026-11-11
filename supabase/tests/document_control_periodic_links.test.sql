-- Document control DC4: next review dates (type interval, document override), periodic reviews (no change / revision started), change requests
-- (raise, accept into a draft, decline with a reason, withdraw, who reads them, the notice to the person who asked), and links.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('40000000-0000-0000-0000-000000000b01', 'ann@pl.test'), ('40000000-0000-0000-0000-000000000b02', 'bob@pl.test'),
  ('40000000-0000-0000-0000-000000000b03', 'cat@pl.test'), ('40000000-0000-0000-0000-000000000b04', 'dan@pl.test'),
  ('40000000-0000-0000-0000-000000000b05', 'eve@pl.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

-- Writes a body if needed, then reviews (cat) and approves (bob) a revision for today.
CREATE FUNCTION pg_temp.issue(p_rev uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_temp.login('40000000-0000-0000-0000-000000000b01');
  IF (SELECT body_text IS NULL FROM public.document_revisions WHERE id = p_rev) THEN
    PERFORM app.update_document_revision(p_rev, '{"body":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Text"}]}]}}'::jsonb);
  END IF;
  PERFORM app.set_document_signers(p_rev, ARRAY['40000000-0000-0000-0000-000000000b03']::uuid[], '40000000-0000-0000-0000-000000000b02');
  PERFORM app.submit_document_revision(p_rev);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login('40000000-0000-0000-0000-000000000b03'); PERFORM app.review_document_revision(p_rev, true); PERFORM pg_temp.logout();
  PERFORM pg_temp.login('40000000-0000-0000-0000-000000000b02'); PERFORM app.approve_document_revision(p_rev, current_date); PERFORM pg_temp.logout();
END $$;

DO $$
DECLARE
  ann uuid := '40000000-0000-0000-0000-000000000b01'; bob uuid := '40000000-0000-0000-0000-000000000b02'; cat uuid := '40000000-0000-0000-0000-000000000b03';
  dan uuid := '40000000-0000-0000-0000-000000000b04'; eve uuid := '40000000-0000-0000-0000-000000000b05';
  org uuid; org2 uuid; sop uuid; d1 uuid; r1 uuid; r2 uuid; r3 uuid; cr1 uuid; cr2 uuid; cr3 uuid; part uuid; fam uuid; mach uuid; r text; v uuid;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('PL Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('PL Beta'); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, bob, 'active'), (org, cat, 'active'), (org, dan, 'active');
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = CASE ou.user_id WHEN bob THEN 'quality_manager' WHEN cat THEN 'quality_engineer' ELSE 'viewer' END)
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id IN (bob, cat, dan);

  PERFORM pg_temp.login(ann);
  SELECT id INTO sop FROM public.document_types WHERE organisation_id = org AND prefix = 'SOP';
  d1 := app.create_document(org, jsonb_build_object('typeId', sop, 'title', 'Deburring', 'contentKind', 'text'));
  SELECT id INTO r1 FROM public.document_revisions WHERE document_id = d1;
  PERFORM pg_temp.logout();

  -- ---- next review date ----
  PERFORM pg_temp.assert_eq((SELECT next_review_on FROM public.documents WHERE id = d1), NULL::date, 'no review date before it is in force');
  PERFORM pg_temp.issue(r1);
  PERFORM pg_temp.assert_eq((SELECT next_review_on FROM public.documents WHERE id = d1), (current_date + interval '24 months')::date, 'effective date + the type''s 24 months');
  PERFORM pg_temp.login(ann);
  PERFORM app.update_document(d1, '{"reviewMonths":6}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT next_review_on FROM public.documents WHERE id = d1), (current_date + interval '6 months')::date, 'a document''s own interval moves the date');
  r := pg_temp.fails(format($f$SELECT app.update_document(%L, '{"reviewMonths":0}'::jsonb)$f$, d1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', '1 to 120 months');

  -- ---- periodic reviews ----
  r := pg_temp.fails(format('SELECT app.record_document_review(%L, %L, %L)', d1, 'no_change', ''));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'no change needs a note');
  v := app.record_document_review(d1, 'no_change', 'Checked against the current drawing; still right');
  PERFORM pg_temp.assert_eq(v, NULL::uuid, 'no revision started');
  PERFORM pg_temp.assert_eq((SELECT next_review_on FROM public.documents WHERE id = d1), (current_date + interval '6 months')::date, 'next review from today');
  PERFORM pg_temp.assert_eq((SELECT outcome || '/' || (revision_id = r1) FROM public.document_periodic_reviews WHERE document_id = d1), 'no_change/true', 'recorded against the revision in force');
  r2 := app.record_document_review(d1, 'revision_started', NULL);
  PERFORM pg_temp.assert_eq((SELECT status || '/' || (previous_revision_id = r1) FROM public.document_revisions WHERE id = r2), 'draft/true', 'a review can start a revision');
  r := pg_temp.fails(format('SELECT app.record_document_review(%L, %L, NULL)', d1, 'revision_started'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'not while one is in progress');
  PERFORM pg_temp.logout();
  r := pg_temp.fails(format($f$UPDATE public.document_periodic_reviews SET note = 'x' WHERE document_id = %L$f$, d1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'a review is frozen, for SQL too');
  PERFORM pg_temp.login(dan);
  r := pg_temp.fails(format('SELECT app.record_document_review(%L, %L, %L)', d1, 'no_change', 'fine'));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'reviews need documentation.manage');

  -- ---- change requests ----
  r := pg_temp.fails(format('SELECT app.raise_document_change_request(%L, %L, %L)', d1, 'x', 'Because'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'say what should change');
  cr1 := app.raise_document_change_request(d1, 'Add the burr height limit', 'Customer complaint about sharp edges');
  cr2 := app.raise_document_change_request(d1, 'Mention the new tool', 'New deburring tool since March');
  cr3 := app.raise_document_change_request(d1, 'Typo in step 2', 'Reads badly');
  PERFORM pg_temp.assert_eq((SELECT reference FROM public.document_change_requests WHERE id = cr1), 'DCR-' || to_char(current_date, 'YY') || '-0001', 'numbered per organisation and year');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.document_change_requests), 3::bigint, 'the person who asked reads their own');
  r := pg_temp.fails(format('SELECT app.accept_document_change_request(%L)', cr1));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a reader cannot accept');
  PERFORM app.withdraw_document_change_request(cr3);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.document_change_requests WHERE document_id = d1), 3::bigint, 'managers read them all');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  r := pg_temp.fails(format('SELECT app.withdraw_document_change_request(%L)', cr2));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'only the person who asked withdraws');
  v := app.accept_document_change_request(cr1);
  PERFORM pg_temp.assert_eq(v, r2, 'accepting uses the draft already in progress');
  r := pg_temp.fails(format('SELECT app.decline_document_change_request(%L, %L)', cr2, 'no'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'declining needs a reason');
  PERFORM app.decline_document_change_request(cr2, 'Covered by the tool manual');
  r := pg_temp.fails(format('SELECT app.accept_document_change_request(%L)', cr2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'a decided request is final');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT string_agg(reference || ':' || status, ',' ORDER BY reference) FROM public.document_change_requests),
    'DCR-' || to_char(current_date, 'YY') || '-0001:accepted,DCR-' || to_char(current_date, 'YY') || '-0002:declined,DCR-' || to_char(current_date, 'YY') || '-0003:withdrawn', 'each decided');
  PERFORM pg_temp.assert_eq((SELECT string_agg(n.body, ' | ' ORDER BY n.created_at) FROM public.notifications n WHERE n.entity_type = 'document_change_requests' AND n.recipient_user_id = dan),
    'DCR-' || to_char(current_date, 'YY') || '-0001 · SOP-001 Deburring — Accepted: a revision is being written | DCR-' || to_char(current_date, 'YY') || '-0002 · SOP-001 Deburring — Declined: Covered by the tool manual',
    'the person who asked is told of each decision (not of their own withdrawal)');
  r := pg_temp.fails(format($f$UPDATE public.document_change_requests SET what = 'changed' WHERE id = %L$f$, cr1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'the wording never changes');

  -- accepting with nothing in progress starts a draft; with a revision in review it is refused
  PERFORM pg_temp.login(ann); PERFORM app.update_document_revision(r2, '{"changeSummary":"Burr height limit added"}'::jsonb); PERFORM pg_temp.logout();
  PERFORM pg_temp.issue(r2);
  PERFORM pg_temp.login(dan); cr1 := app.raise_document_change_request(d1, 'Another change', 'Another reason'); cr2 := app.raise_document_change_request(d1, 'And another', 'Reasons'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ann);
  r3 := app.accept_document_change_request(cr1);
  PERFORM pg_temp.assert_eq((SELECT status || '/' || (previous_revision_id = r2) FROM public.document_revisions WHERE id = r3), 'draft/true', 'accepting starts a draft from the revision in force');
  PERFORM app.update_document_revision(r3, '{"changeSummary":"Another change"}'::jsonb);
  PERFORM app.set_document_signers(r3, ARRAY[cat], bob);
  PERFORM app.submit_document_revision(r3);
  r := pg_temp.fails(format('SELECT app.accept_document_change_request(%L)', cr2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'not into a revision already in review');

  -- ---- links ----
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'P-100', 'Bracket') RETURNING id INTO part;
  INSERT INTO public.part_families (organisation_id, code, name) VALUES (org, 'BRK', 'Brackets') RETURNING id INTO fam;
  INSERT INTO public.machines (organisation_id, code, name) VALUES (org, 'M-1', 'Deburr cell') RETURNING id INTO mach;
  PERFORM app.set_document_links(d1, jsonb_build_array(jsonb_build_object('partId', part), jsonb_build_object('partFamilyId', fam), jsonb_build_object('machineId', mach),
    jsonb_build_object('operationCode', 'OP-20'), jsonb_build_object('operationCode', 'OP-20')));
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.document_links WHERE document_id = d1), 4::bigint, 'four links (a repeated one is kept once)');
  r := pg_temp.fails(format($f$SELECT app.set_document_links(%L, jsonb_build_array(jsonb_build_object('partId', %L, 'machineId', %L)))$f$, d1, part, mach));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'one thing per link');
  r := pg_temp.fails(format($f$SELECT app.set_document_links(%L, jsonb_build_array(jsonb_build_object('partId', %L)))$f$, d1, gen_random_uuid()));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'a part of this organisation');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(dan);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.document_links WHERE document_id = d1), 4::bigint, 'readers see the links');
  PERFORM pg_temp.logout();

  -- ---- withdrawing clears the review date; another organisation finds nothing ----
  PERFORM pg_temp.login(ann);
  PERFORM app.withdraw_document(d1, 'Superseded by the cell manual');
  PERFORM pg_temp.assert_eq((SELECT next_review_on FROM public.documents WHERE id = d1), NULL::date, 'a withdrawn document is not reviewed');
  r := pg_temp.fails(format('SELECT app.record_document_review(%L, %L, %L)', d1, 'no_change', 'fine'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'nor can it be');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve);
  r := pg_temp.fails(format('SELECT app.raise_document_change_request(%L, %L, %L)', d1, 'Hijack', 'Hijack'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'another organisation finds nothing');
  r := pg_temp.fails(format('SELECT app.decline_document_change_request(%L, %L)', cr2, 'Hijack'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'nor its requests');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
