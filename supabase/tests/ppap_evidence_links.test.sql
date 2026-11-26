-- PPAP PP2: evidence that is a link to a live record: which records are evidence for which element, adding a link (kind, organisation, reading right, the right part, once), the live
-- state of a link (in good standing or why not), the "still needed" list with link lines, freezing at submission (once, the frozen columns never change), "changed since submission",
-- the shape rules the table holds even for SQL.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('4f000000-0000-0000-0000-000000000e01', 'ann@pl.test'), ('4f000000-0000-0000-0000-000000000e02', 'bob@pl.test'),
  ('4f000000-0000-0000-0000-000000000e03', 'cat@pl.test'), ('4f000000-0000-0000-0000-000000000e04', 'dan@pl.test'),
  ('4f000000-0000-0000-0000-000000000e05', 'eve@pl.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '4f000000-0000-0000-0000-000000000e01'; bob uuid := '4f000000-0000-0000-0000-000000000e02';
  cat uuid := '4f000000-0000-0000-0000-000000000e03'; dan uuid := '4f000000-0000-0000-0000-000000000e04';
  eve uuid := '4f000000-0000-0000-0000-000000000e05';
  org uuid; org2 uuid; u uuid; part uuid; part2 uuid; part_other uuid; rev uuid; rev_old uuid; rev_p2 uuid; rev_other uuid; cust uuid; s1 uuid; r jsonb; t text;
  e_design uuid; e_check uuid; e_dfmea uuid; e_dim uuid; ev_rev uuid; ev_gauge uuid; ev2 uuid; g_ok uuid; g_other uuid; st jsonb; n integer; probs text[];
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('PL Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('PL Beta'); PERFORM pg_temp.logout();
  -- Bob: viewer. Cat: quality engineer (prepares). Dan: quality manager (approves).
  FOREACH u IN ARRAY ARRAY[bob, cat, dan] LOOP
    INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u, 'active');
  END LOOP;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = CASE ou.user_id WHEN dan THEN 'quality_manager' WHEN bob THEN 'viewer' ELSE 'quality_engineer' END)
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id IN (bob, cat, dan);

  -- ---- which records are evidence for which element ----
  PERFORM pg_temp.assert_eq(app.ppap_link_kinds('design_records'), ARRAY['part_revision', 'document_revision'], 'design records: a part revision or a document');
  PERFORM pg_temp.assert_eq(app.ppap_link_kinds('dfmea'), ARRAY['fmea_revision'], 'a design FMEA is an FMEA revision');
  PERFORM pg_temp.assert_eq(app.ppap_link_kinds('msa_studies'), ARRAY['msa_study'], 'measurement system studies are gauge R&R studies');
  PERFORM pg_temp.assert_eq(app.ppap_link_kinds('initial_process_studies'), ARRAY['plan_characteristic'], 'initial process studies point at a plan characteristic');
  PERFORM pg_temp.assert_eq(app.ppap_link_kinds('part_submission_warrant'), ARRAY[]::text[], 'the warrant is made, not linked');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.ppap_element_types() t WHERE t.key <> 'part_submission_warrant' AND cardinality(app.ppap_link_kinds(t.key)) = 0), 0::bigint, 'every other element can take a link');

  -- fixtures
  PERFORM pg_temp.login(ann);
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'PL-P1', 'Bracket') RETURNING id INTO part;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'PL-P2', 'Housing') RETURNING id INTO part2;
  INSERT INTO public.part_revisions (organisation_id, part_id, revision) VALUES (org, part, 'A') RETURNING id INTO rev_old;
  UPDATE public.part_revisions SET status = 'released' WHERE id = rev_old;
  INSERT INTO public.part_revisions (organisation_id, part_id, revision) VALUES (org, part, 'B') RETURNING id INTO rev;
  UPDATE public.part_revisions SET status = 'released' WHERE id = rev;   -- releasing B supersedes A
  INSERT INTO public.part_revisions (organisation_id, part_id, revision) VALUES (org, part2, 'A') RETURNING id INTO rev_p2;
  UPDATE public.part_revisions SET status = 'released' WHERE id = rev_p2;
  INSERT INTO public.customers (organisation_id, code, name) VALUES (org, 'PL-C1', 'Acme Motors') RETURNING id INTO cust;
  INSERT INTO public.gauges (organisation_id, asset_number, description) VALUES (org, 'PL-G1', 'Micrometer') RETURNING id INTO g_ok;
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve);
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org2, 'PL-X1', 'Other') RETURNING id INTO part_other;
  INSERT INTO public.part_revisions (organisation_id, part_id, revision) VALUES (org2, part_other, 'A') RETURNING id INTO rev_other;
  UPDATE public.part_revisions SET status = 'released' WHERE id = rev_other;
  INSERT INTO public.gauges (organisation_id, asset_number, description) VALUES (org2, 'PL-GX', 'Other gauge') RETURNING id INTO g_other;
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login(cat);
  r := app.create_ppap(org, jsonb_build_object('partId', part, 'customerId', cust, 'reason', 'new_part'));
  s1 := (r ->> 'id')::uuid;
  SELECT id INTO e_design FROM public.ppap_elements WHERE submission_id = s1 AND element_key = 'design_records';
  SELECT id INTO e_check FROM public.ppap_elements WHERE submission_id = s1 AND element_key = 'checking_aids';
  SELECT id INTO e_dfmea FROM public.ppap_elements WHERE submission_id = s1 AND element_key = 'dfmea';
  SELECT id INTO e_dim FROM public.ppap_elements WHERE submission_id = s1 AND element_key = 'dimensional_results';

  -- ---- adding a link ----
  t := pg_temp.fails(format('SELECT app.add_ppap_link(%L, %L, %L)', e_design, 'gauge', g_ok));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'a gauge is not evidence of the design records');
  t := pg_temp.fails(format('SELECT app.add_ppap_link(%L, %L, %L)', e_design, 'part_revision', rev_other));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'a record of another organisation is not found');
  t := pg_temp.fails(format('SELECT app.add_ppap_link(%L, %L, %L)', e_design, 'part_revision', rev_p2));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'a revision of another part is refused');
  PERFORM pg_temp.assert_eq(t LIKE '%another part%', true, 'and says why');
  t := pg_temp.fails(format('SELECT app.add_ppap_link(%L, %L, %L)', e_design, 'part_revision', gen_random_uuid()));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'a record that does not exist is not found');
  t := pg_temp.fails(format('SELECT app.add_ppap_link(%L, %L, %L)', e_design, 'part_revision', NULL));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'a link needs a record');
  ev_rev := app.add_ppap_link(e_design, 'part_revision', rev, 'The released drawing');
  PERFORM pg_temp.assert_eq((SELECT kind || '/' || target_kind || '/' || description FROM public.ppap_evidence WHERE id = ev_rev), 'link/part_revision/The released drawing', 'the link is recorded');
  PERFORM pg_temp.assert_eq((SELECT storage_path IS NULL AND file_name IS NULL AND size_bytes IS NULL FROM public.ppap_evidence WHERE id = ev_rev), true, 'a link has no file');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.ppap_elements WHERE id = e_design), 'in_progress', 'adding evidence starts the element');
  t := pg_temp.fails(format('SELECT app.add_ppap_link(%L, %L, %L)', e_design, 'part_revision', rev));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'the same record is linked once per element');
  ev_gauge := app.add_ppap_link(e_check, 'gauge', g_ok);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.ppap_evidence WHERE submission_id = s1 AND kind = 'link'), 2::bigint, 'two links');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(bob);
  t := pg_temp.fails(format('SELECT app.add_ppap_link(%L, %L, %L)', e_dim, 'gauge', g_ok));
  PERFORM pg_temp.assert_eq(left(t, 5), '42501', 'a viewer cannot add evidence');
  PERFORM pg_temp.logout();

  -- ---- what can be linked ----
  PERFORM pg_temp.login(cat);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.ppap_candidates(e_design, 'part_revision')), 2::bigint, 'the part''s two revisions are offered, not another part''s');
  PERFORM pg_temp.assert_eq((SELECT linked FROM app.ppap_candidates(e_design, 'part_revision') c WHERE c.target_id = rev), true, 'one is marked as already linked');
  PERFORM pg_temp.assert_eq((SELECT ok FROM app.ppap_candidates(e_design, 'part_revision') c WHERE c.target_id = rev_old), false, 'a superseded revision is shown as not in good standing');
  PERFORM pg_temp.assert_eq((SELECT problem FROM app.ppap_candidates(e_design, 'part_revision') c WHERE c.target_id = rev_old), 'is superseded', 'with the reason');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.ppap_candidates(e_check, 'gauge', 'micro')), 1::bigint, 'a search finds the gauge by its description');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.ppap_candidates(e_check, 'gauge', '%')), 0::bigint, 'a percent sign in a search is just a character');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.ppap_candidates(e_check, 'gauge', 'pl-gx')), 0::bigint, 'another organisation''s gauge is never offered');
  t := pg_temp.fails(format('SELECT * FROM app.ppap_candidates(%L, %L)', e_design, 'gauge'));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'a kind that is not evidence for the element is refused');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(bob);
  t := pg_temp.fails(format('SELECT * FROM app.ppap_candidates(%L, %L)', e_check, 'gauge'));
  PERFORM pg_temp.assert_eq(left(t, 5), 'P0002', 'a viewer cannot see an unsubmitted submission, so cannot list candidates for it');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve);
  t := pg_temp.fails(format('SELECT * FROM app.ppap_candidates(%L, %L)', e_check, 'gauge'));
  PERFORM pg_temp.assert_eq(left(t, 5), 'P0002', 'another organisation cannot list them');
  PERFORM pg_temp.logout();

  -- ---- the shape rules the table holds even for SQL ----
  t := pg_temp.fails(format($q$INSERT INTO public.ppap_evidence (organisation_id, submission_id, element_id, kind, target_kind, target_id, storage_path, file_name, size_bytes)
    VALUES (%L, %L, %L, 'link', 'gauge', %L, %L, 'x.pdf', 1)$q$, org, s1, e_dim, g_ok, org || '/ppap/' || s1 || '/z-x.pdf'));
  PERFORM pg_temp.assert_eq(left(t, 5), '23514', 'a link cannot also be a file');
  t := pg_temp.fails(format($q$INSERT INTO public.ppap_evidence (organisation_id, submission_id, element_id, kind, storage_path, file_name, size_bytes, target_kind, target_id)
    VALUES (%L, %L, %L, 'file', %L, 'x.pdf', 1, 'gauge', %L)$q$, org, s1, e_dim, org || '/ppap/' || s1 || '/y-x.pdf', g_ok));
  PERFORM pg_temp.assert_eq(left(t, 5), '23514', 'a file cannot also be a link');
  t := pg_temp.fails(format($q$INSERT INTO public.ppap_evidence (organisation_id, submission_id, element_id, kind, target_kind, target_id)
    VALUES (%L, %L, %L, 'link', 'something_else', %L)$q$, org, s1, e_dim, g_ok));
  PERFORM pg_temp.assert_eq(left(t, 5), '23514', 'only the known kinds of record can be linked');
  t := pg_temp.fails(format($q$INSERT INTO public.ppap_evidence (organisation_id, submission_id, element_id, kind, target_kind, target_id, frozen_at, frozen_label, frozen_status, frozen_fingerprint)
    VALUES (%L, %L, %L, 'link', 'gauge', %L, now(), 'x', 'active', 'abc')$q$, org, s1, e_dim, g_ok));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'a link cannot be made already frozen');

  -- ---- the live state of a link ----
  PERFORM pg_temp.login(cat);
  st := app.ppap_link_state(ev_rev);
  PERFORM pg_temp.assert_eq((st ->> 'available')::boolean, true, 'a readable record is available');
  PERFORM pg_temp.assert_eq((st ->> 'ok')::boolean, true, 'a released revision is in good standing');
  PERFORM pg_temp.assert_eq(st ->> 'label', 'PL-P1 rev B', 'with its own label');
  PERFORM pg_temp.assert_eq((st ->> 'frozen')::boolean, false, 'not frozen before submission');
  PERFORM pg_temp.assert_eq((app.ppap_link_state(ev_gauge) ->> 'ok')::boolean, true, 'an active gauge with no calibration due is in good standing');
  PERFORM pg_temp.logout();

  -- a gauge that goes out of good standing after it was linked
  PERFORM pg_temp.login(ann);
  UPDATE public.gauges SET status = 'quarantined', status_reason = 'Dropped' WHERE id = g_ok;
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  st := app.ppap_link_state(ev_gauge);
  PERFORM pg_temp.assert_eq((st ->> 'ok')::boolean, false, 'a quarantined gauge is not in good standing');
  PERFORM pg_temp.assert_eq(st ->> 'problem', 'is quarantined', 'and the state says why');
  PERFORM pg_temp.logout();

  -- ---- the "still needed" list names a link that is not in good standing ----
  PERFORM pg_temp.login(cat);
  PERFORM app.set_ppap_element(e_check, '{"status":"ready"}'::jsonb);
  probs := app.ppap_problems(s1);
  PERFORM pg_temp.assert_eq(probs @> ARRAY['Checking aids: PL-G1 — Micrometer is quarantined'], true, 'a linked gauge that is quarantined is a line');
  PERFORM pg_temp.assert_eq(probs @> ARRAY['Design records: mark it ready'], true, 'a linked element that is good still needs marking ready');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ann);
  UPDATE public.gauges SET status = 'active', status_reason = NULL WHERE id = g_ok;
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  PERFORM pg_temp.assert_eq((app.ppap_problems(s1)) @> ARRAY['Checking aids: PL-G1 — Micrometer is quarantined'], false, 'the line goes when the gauge is back in service');
  PERFORM app.set_ppap_element(e_design, '{"status":"ready"}'::jsonb);
  PERFORM pg_temp.assert_eq((app.ppap_problems(s1)) @> ARRAY['Design records: mark it ready'], false, 'marked ready, the element is done');
  PERFORM pg_temp.logout();

  -- ---- freezing at submission ----
  PERFORM pg_temp.assert_eq(app.ppap_freeze_links(s1), 2, 'both live links are frozen');
  PERFORM pg_temp.assert_eq(app.ppap_freeze_links(s1), 0, 'freezing is done once');
  PERFORM pg_temp.assert_eq((SELECT frozen_label || '/' || frozen_status FROM public.ppap_evidence WHERE id = ev_rev), 'PL-P1 rev B/released', 'the label and status as they were');
  PERFORM pg_temp.assert_eq((SELECT frozen_fingerprint IS NOT NULL AND frozen_version IS NOT NULL AND frozen_at IS NOT NULL FROM public.ppap_evidence WHERE id = ev_rev), true, 'a fingerprint, a version and a time');
  PERFORM pg_temp.login(cat);
  st := app.ppap_link_state(ev_gauge);
  PERFORM pg_temp.assert_eq((st ->> 'frozen')::boolean, true, 'the state says it is frozen');
  PERFORM pg_temp.assert_eq((st ->> 'changedSince')::boolean, false, 'nothing has changed since');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ann);
  UPDATE public.gauges SET status = 'out_of_service', status_reason = 'Worn' WHERE id = g_ok;
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  st := app.ppap_link_state(ev_gauge);
  PERFORM pg_temp.assert_eq((st ->> 'changedSince')::boolean, true, 'a change to the record after submission shows');
  PERFORM pg_temp.assert_eq(st ->> 'frozenStatus', 'active', 'the frozen status stays as it was');
  PERFORM pg_temp.assert_eq(st ->> 'status', 'out_of_service', 'beside what it is now');
  PERFORM pg_temp.logout();
  -- the frozen columns never change again, even for SQL
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.ppap_evidence SET frozen_status = 'x' WHERE id = %L$q$, ev_gauge), 'frozen columns cannot be rewritten');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.ppap_evidence SET frozen_at = NULL, frozen_label = NULL, frozen_status = NULL, frozen_version = NULL, frozen_fingerprint = NULL WHERE id = %L$q$, ev_gauge), 'and cannot be cleared');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.ppap_evidence SET target_id = %L WHERE id = %L$q$, g_other, ev_gauge), 'the record a link points at never changes');

  -- ---- who can run the internals ----
  PERFORM pg_temp.login(cat);
  t := pg_temp.fails(format('SELECT app.ppap_freeze_links(%L)', s1));
  PERFORM pg_temp.assert_eq(left(t, 5), '42501', 'a person cannot freeze links directly');
  t := pg_temp.fails(format('SELECT app.ppap_target_info(%L, %L)', 'gauge', g_ok));
  PERFORM pg_temp.assert_eq(left(t, 5), '42501', 'nor read a record''s state without the reading check');
  PERFORM pg_temp.logout();

  -- ---- another organisation sees nothing ----
  PERFORM pg_temp.login(eve);
  t := pg_temp.fails(format('SELECT app.ppap_link_state(%L)', ev_rev));
  PERFORM pg_temp.assert_eq(left(t, 5), 'P0002', 'another organisation cannot ask about a link');
  t := pg_temp.fails(format('SELECT app.add_ppap_link(%L, %L, %L)', e_dim, 'gauge', g_other));
  PERFORM pg_temp.assert_eq(left(t, 5), 'P0002', 'nor add one');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
