-- PPAP PP1: permissions and role defaults, the requirement set (seeded, versions, frozen), customer rules, creating a submission (reference, the 18 elements, levels, idempotency,
-- one live per part revision / customer / reason), elements, file evidence, waivers by an approver, the "still needed" list, ready / reopen / withdraw, the rules the tables
-- hold even for SQL, who reads what, tenancy.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('4e000000-0000-0000-0000-000000000e01', 'ann@pp.test'), ('4e000000-0000-0000-0000-000000000e02', 'bob@pp.test'),
  ('4e000000-0000-0000-0000-000000000e03', 'cat@pp.test'), ('4e000000-0000-0000-0000-000000000e04', 'dan@pp.test'),
  ('4e000000-0000-0000-0000-000000000e05', 'eve@pp.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '4e000000-0000-0000-0000-000000000e01'; bob uuid := '4e000000-0000-0000-0000-000000000e02';
  cat uuid := '4e000000-0000-0000-0000-000000000e03'; dan uuid := '4e000000-0000-0000-0000-000000000e04';
  eve uuid := '4e000000-0000-0000-0000-000000000e05';
  org uuid; org2 uuid; u uuid; part uuid; part_nr uuid; part_other uuid; rev uuid; rev_draft uuid; cust uuid; cust2 uuid; cust_other uuid; site uuid;
  s1 uuid; s2 uuid; s3 uuid; s4 uuid; r jsonb; t text; e1 uuid; e2 uuid; ev uuid; set1 uuid; set2 uuid; cfg jsonb; v_year text := to_char(current_date, 'YY');
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('PP Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('PP Beta'); PERFORM pg_temp.logout();
  -- Bob: viewer (reads). Cat: quality engineer (prepares). Dan: quality manager (approves).
  FOREACH u IN ARRAY ARRAY[bob, cat, dan] LOOP
    INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u, 'active');
  END LOOP;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = CASE ou.user_id WHEN dan THEN 'quality_manager' WHEN bob THEN 'viewer' ELSE 'quality_engineer' END)
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id IN (bob, cat, dan);

  -- ---- permissions and role defaults ----
  PERFORM pg_temp.assert_eq((SELECT array_agg(rp.permission_code ORDER BY rp.permission_code) FROM public.role_permissions rp JOIN public.roles r ON r.id = rp.role_id
    WHERE r.organisation_id = org AND r.key = 'quality_manager' AND rp.permission_code LIKE 'ppap.%'), ARRAY['ppap.approve','ppap.manage','ppap.read'], 'a quality manager holds all three');
  PERFORM pg_temp.assert_eq((SELECT array_agg(rp.permission_code ORDER BY rp.permission_code) FROM public.role_permissions rp JOIN public.roles r ON r.id = rp.role_id
    WHERE r.organisation_id = org AND r.key = 'quality_engineer' AND rp.permission_code LIKE 'ppap.%'), ARRAY['ppap.manage','ppap.read'], 'a quality engineer prepares but does not approve');
  PERFORM pg_temp.assert_eq((SELECT array_agg(rp.permission_code ORDER BY rp.permission_code) FROM public.role_permissions rp JOIN public.roles r ON r.id = rp.role_id
    WHERE r.organisation_id = org AND r.key = 'viewer' AND rp.permission_code LIKE 'ppap.%'), ARRAY['ppap.read'], 'a viewer reads');

  -- ---- the requirement set is seeded, valid and neutral ----
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.ppap_requirement_sets WHERE organisation_id = org AND current AND version = 1), 1::bigint, 'version 1 is seeded for the organisation');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.ppap_requirement_sets WHERE organisation_id = org2), 1::bigint, 'and for the other one');
  SELECT id, config INTO set1, cfg FROM public.ppap_requirement_sets WHERE organisation_id = org AND current;
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM jsonb_object_keys(cfg -> 'rows')), 18::bigint, 'a row for each of the 18 elements');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM jsonb_each(cfg -> 'rows') x WHERE x.value ->> '1' = 'submit'), 1::bigint, 'level 1 sends only the warrant');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM jsonb_each(cfg -> 'rows') x WHERE x.value ->> '3' = 'submit'), 18::bigint, 'level 3 sends every element');
  PERFORM pg_temp.assert_eq(app.ppap_requirement_problem(cfg), NULL::text, 'the default is valid');
  PERFORM pg_temp.assert_eq(app.ppap_requirement_problem(cfg #- '{rows,dfmea}') IS NOT NULL, true, 'a missing element row is a problem');
  PERFORM pg_temp.assert_eq(app.ppap_requirement_problem(jsonb_set(cfg, '{rows,dfmea,3}', '"maybe"')) IS NOT NULL, true, 'a value other than submit, retain or none is a problem');
  PERFORM pg_temp.assert_eq(app.ppap_requirement_problem(jsonb_set(cfg, '{minCpkInitial}', '0')) IS NOT NULL, true, 'a Cpk below 0.1 is a problem');
  PERFORM pg_temp.assert_eq(app.ppap_requirement_problem(cfg || '{"colour":"red"}') IS NOT NULL, true, 'an unknown setting is a problem');

  -- fixtures: parts, a released and a draft revision, customers, a site
  PERFORM pg_temp.login(ann);
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'PP-P1', 'Bracket') RETURNING id INTO part;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'PP-P2', 'No release yet') RETURNING id INTO part_nr;
  INSERT INTO public.part_revisions (organisation_id, part_id, revision) VALUES (org, part, 'A') RETURNING id INTO rev;
  UPDATE public.part_revisions SET status = 'released' WHERE id = rev;
  INSERT INTO public.part_revisions (organisation_id, part_id, revision) VALUES (org, part_nr, 'A') RETURNING id INTO rev_draft;
  INSERT INTO public.customers (organisation_id, code, name) VALUES (org, 'PP-C1', 'Acme Motors') RETURNING id INTO cust;
  INSERT INTO public.customers (organisation_id, code, name) VALUES (org, 'PP-C2', 'Beta Aero') RETURNING id INTO cust2;
  SELECT id INTO site FROM public.sites WHERE organisation_id = org LIMIT 1;
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve);
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org2, 'PP-X1', 'Other') RETURNING id INTO part_other;
  INSERT INTO public.customers (organisation_id, code, name) VALUES (org2, 'PP-CX', 'Other customer') RETURNING id INTO cust_other;
  PERFORM pg_temp.logout();

  -- ---- creating a submission ----
  PERFORM pg_temp.login(bob);
  t := pg_temp.fails(format($f$SELECT app.create_ppap(%L, %L::jsonb)$f$, org, jsonb_build_object('partId', part, 'customerId', cust, 'reason', 'new_part')::text));
  PERFORM pg_temp.assert_eq(left(t, 5), '42501', 'a viewer cannot prepare a submission');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login(cat);
  t := pg_temp.fails(format($f$SELECT app.create_ppap(%L, %L::jsonb)$f$, org, jsonb_build_object('partId', part, 'customerId', cust)::text));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'the reason is needed');
  t := pg_temp.fails(format($f$SELECT app.create_ppap(%L, %L::jsonb)$f$, org, jsonb_build_object('partId', part, 'customerId', cust, 'reason', 'new_part', 'colour', 'red')::text));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'an unknown field is refused');
  t := pg_temp.fails(format($f$SELECT app.create_ppap(%L, %L::jsonb)$f$, org, jsonb_build_object('partId', part_other, 'customerId', cust, 'reason', 'new_part')::text));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'another organisation''s part is refused');
  t := pg_temp.fails(format($f$SELECT app.create_ppap(%L, %L::jsonb)$f$, org, jsonb_build_object('partId', part, 'customerId', cust_other, 'reason', 'new_part')::text));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'another organisation''s customer is refused');
  t := pg_temp.fails(format($f$SELECT app.create_ppap(%L, %L::jsonb)$f$, org, jsonb_build_object('partId', part, 'reason', 'new_part')::text));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'the customer is needed');
  t := pg_temp.fails(format($f$SELECT app.create_ppap(%L, %L::jsonb)$f$, org, jsonb_build_object('partId', part_nr, 'customerId', cust, 'reason', 'new_part')::text));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'a part with no released revision needs one chosen');
  t := pg_temp.fails(format($f$SELECT app.create_ppap(%L, %L::jsonb)$f$, org, jsonb_build_object('partId', part, 'partRevisionId', rev_draft, 'customerId', cust, 'reason', 'new_part')::text));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'a revision of another part is refused');
  t := pg_temp.fails(format($f$SELECT app.create_ppap(%L, %L::jsonb)$f$, org, jsonb_build_object('partId', part, 'customerId', cust, 'reason', 'new_part', 'level', 7)::text));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'the level is 1 to 5');
  t := pg_temp.fails(format($f$SELECT app.create_ppap(%L, %L::jsonb)$f$, org, jsonb_build_object('partId', part, 'customerId', cust, 'reason', 'new_part', 'direction', 'received')::text));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'a received package is not available yet');
  t := pg_temp.fails(format($f$SELECT app.create_ppap(%L, %L::jsonb)$f$, org, jsonb_build_object('partId', part, 'customerId', cust, 'reason', 'new_part', 'ownerId', eve)::text));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'the owner must be a member');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.ppap_submissions WHERE organisation_id = org), 0::bigint, 'a refused create leaves nothing behind');

  r := app.create_ppap(org, jsonb_build_object('partId', part, 'customerId', cust, 'reason', 'new_part', 'siteId', site, 'notes', 'First sample run', 'clientKey', 'retry-key-0001'));
  s1 := (r ->> 'id')::uuid;
  PERFORM pg_temp.assert_eq((r ->> 'created')::boolean, true, 'created');
  PERFORM pg_temp.assert_eq((SELECT reference FROM public.ppap_submissions WHERE id = s1), 'PPAP-' || v_year || '-0001', 'the first reference');
  PERFORM pg_temp.assert_eq((SELECT status || '/' || level || '/' || direction FROM public.ppap_submissions WHERE id = s1), 'draft/3/submitted', 'a draft at the default level 3');
  PERFORM pg_temp.assert_eq((SELECT part_revision_id FROM public.ppap_submissions WHERE id = s1), rev, 'the released revision is the default');
  PERFORM pg_temp.assert_eq((SELECT owner_user_id FROM public.ppap_submissions WHERE id = s1), cat, 'the owner defaults to the preparer');
  PERFORM pg_temp.assert_eq((SELECT requirement_set_id FROM public.ppap_submissions WHERE id = s1), set1, 'it is built on the current requirement set');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.ppap_elements WHERE submission_id = s1), 18::bigint, 'it has its 18 elements');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.ppap_elements WHERE submission_id = s1 AND requirement = 'required' AND status = 'not_started'), 18::bigint, 'all required at level 3');
  r := app.create_ppap(org, jsonb_build_object('partId', part, 'customerId', cust, 'reason', 'new_part', 'clientKey', 'retry-key-0001'));
  PERFORM pg_temp.assert_eq((r ->> 'id')::uuid, s1, 'a retried request returns the same submission');
  PERFORM pg_temp.assert_eq((r ->> 'created')::boolean, false, 'and says it was not created again');
  t := pg_temp.fails(format($f$SELECT app.create_ppap(%L, %L::jsonb)$f$, org, jsonb_build_object('partId', part, 'customerId', cust, 'reason', 'new_part')::text));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'one live submission for a part revision, customer and reason');
  s2 := (app.create_ppap(org, jsonb_build_object('partId', part, 'customerId', cust, 'reason', 'tooling', 'level', 1)) ->> 'id')::uuid;
  PERFORM pg_temp.assert_eq((SELECT reference FROM public.ppap_submissions WHERE id = s2), 'PPAP-' || v_year || '-0002', 'the next number follows');
  PERFORM pg_temp.assert_eq((SELECT array_agg(element_key) FROM public.ppap_elements WHERE submission_id = s2 AND requirement = 'required'), ARRAY['part_submission_warrant'], 'level 1: only the warrant');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.ppap_elements WHERE submission_id = s2 AND requirement = 'not_required'), 17::bigint, 'the rest are not required');
  PERFORM pg_temp.logout();

  -- ---- customer rules: an approver sets them, a new submission starts from them ----
  PERFORM pg_temp.login(cat);
  t := pg_temp.fails(format($f$SELECT app.set_ppap_customer_rules(%L, '{"defaultLevel":2}'::jsonb)$f$, cust2));
  PERFORM pg_temp.assert_eq(left(t, 5), '42501', 'preparing is not enough to set a customer''s rules');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(dan);
  t := pg_temp.fails(format($f$SELECT app.set_ppap_customer_rules(%L, '{"defaultLevel":9}'::jsonb)$f$, cust2));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'the level is 1 to 5');
  t := pg_temp.fails(format($f$SELECT app.set_ppap_customer_rules(%L, '{"extraElements":["nonsense"]}'::jsonb)$f$, cust2));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'an unknown element is refused');
  t := pg_temp.fails(format($f$SELECT app.set_ppap_customer_rules(%L, '{"defaultLevel":2}'::jsonb)$f$, cust_other));
  PERFORM pg_temp.assert_eq(left(t, 5), 'P0002', 'another organisation''s customer is not found');
  PERFORM app.set_ppap_customer_rules(cust2, '{"defaultLevel":2,"extraElements":["dfmea"],"minCpkInitial":2,"note":"Wants the design FMEA"}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT default_level || '/' || min_cpk_initial FROM public.ppap_customer_rules WHERE customer_id = cust2), '2/2', 'the rules are kept');
  PERFORM app.set_ppap_customer_rules(cust2, '{"defaultLevel":2,"extraElements":["dfmea"],"minCpkInitial":2,"note":"Wants the design FMEA"}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.ppap_customer_rules WHERE customer_id = cust2), 1::bigint, 'setting them again replaces them');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  s3 := (app.create_ppap(org, jsonb_build_object('partId', part, 'customerId', cust2, 'reason', 'customer_request')) ->> 'id')::uuid;
  PERFORM pg_temp.assert_eq((SELECT level FROM public.ppap_submissions WHERE id = s3), 2, 'the customer''s level is the starting level');
  PERFORM pg_temp.assert_eq((SELECT requirement FROM public.ppap_elements WHERE submission_id = s3 AND element_key = 'dfmea'), 'required', 'the customer''s extra element is required');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.ppap_elements WHERE submission_id = s3 AND requirement = 'required'), 6::bigint, 'level 2 sends five, plus the extra one');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.ppap_elements WHERE submission_id = s3 AND requirement = 'retain'), 12::bigint, 'the others are kept, not sent');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.ppap_submissions WHERE id = s3 AND level = 2), 1::bigint, 'an explicit level beats the customer''s');
  t := pg_temp.fails(format($f$SELECT app.update_ppap(%L, '{"colour":"red"}'::jsonb)$f$, s1));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'an unknown field is refused on update');

  -- ---- changing the level re-applies the rules to untouched elements only ----
  SELECT id INTO e1 FROM public.ppap_elements WHERE submission_id = s1 AND element_key = 'control_plan';
  PERFORM app.set_ppap_element(e1, '{"note":"Plan CP-100 rev C"}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT status FROM public.ppap_submissions WHERE id = s1), 'in_preparation', 'touching a draft starts the preparation');
  PERFORM app.set_ppap_level(s1, 1);
  PERFORM pg_temp.assert_eq((SELECT level FROM public.ppap_submissions WHERE id = s1), 1, 'the level changed');
  PERFORM pg_temp.assert_eq((SELECT requirement FROM public.ppap_elements WHERE id = e1), 'required', 'an element with a note is left as it was');
  PERFORM pg_temp.assert_eq((SELECT requirement FROM public.ppap_elements WHERE submission_id = s1 AND element_key = 'dfmea'), 'not_required', 'an untouched one follows the new level');
  PERFORM pg_temp.assert_eq((SELECT requirement FROM public.ppap_elements WHERE submission_id = s1 AND element_key = 'part_submission_warrant'), 'required', 'the warrant stays required');
  t := pg_temp.fails(format('SELECT app.set_ppap_level(%L, 6)', s1));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'the level is 1 to 5');
  PERFORM app.set_ppap_level(s1, 3);
  PERFORM pg_temp.assert_eq((SELECT requirement FROM public.ppap_elements WHERE submission_id = s1 AND element_key = 'dfmea'), 'required', 'and back again');

  -- ---- elements and file evidence ----
  SELECT id INTO e2 FROM public.ppap_elements WHERE submission_id = s1 AND element_key = 'design_records';
  t := pg_temp.fails(format($f$SELECT app.set_ppap_element(%L, '{"colour":"red"}'::jsonb)$f$, e2));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'an unknown field is refused');
  t := pg_temp.fails(format($f$SELECT app.set_ppap_element(%L, '{"status":"waived"}'::jsonb)$f$, e2));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'only an approver waives');
  t := pg_temp.fails(format($f$SELECT app.set_ppap_element(%L, '{"status":"ready"}'::jsonb)$f$, e2));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'a required element is not ready without evidence');
  t := pg_temp.fails(format($f$SELECT app.add_ppap_file(%L, %L, 'drawing.pdf', 'application/pdf', 1000)$f$, e2, org || '/ppap/' || s2 || '/' || gen_random_uuid() || '-drawing.pdf'));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'a file must be in this submission''s folder');
  t := pg_temp.fails(format($f$SELECT app.add_ppap_file(%L, %L, 'drawing.pdf', 'application/pdf', 99999999999)$f$, e2, org || '/ppap/' || s1 || '/' || gen_random_uuid() || '-drawing.pdf'));
  PERFORM pg_temp.assert_eq(left(t, 5), '23514', 'a file over 25 MB is refused');
  ev := app.add_ppap_file(e2, org || '/ppap/' || s1 || '/aaaa-drawing.pdf', 'drawing.pdf', 'application/pdf', 1000, 'Customer drawing');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.ppap_elements WHERE id = e2), 'in_progress', 'adding evidence starts the element');
  t := pg_temp.fails(format($f$SELECT app.add_ppap_file(%L, %L, 'drawing.pdf', 'application/pdf', 1000)$f$, e2, org || '/ppap/' || s1 || '/aaaa-drawing.pdf'));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'the same file is not recorded twice');
  PERFORM app.set_ppap_element(e2, '{"status":"ready"}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT status FROM public.ppap_elements WHERE id = e2), 'ready', 'with evidence it can be marked ready');
  t := pg_temp.fails(format('SELECT app.remove_ppap_evidence(%L, %L)', ev, 'x'));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'removing needs a reason');
  PERFORM app.remove_ppap_evidence(ev, 'Wrong drawing issue');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.ppap_elements WHERE id = e2), 'in_progress', 'losing its only evidence takes the ready mark off');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.ppap_evidence WHERE id = ev AND removed_at IS NOT NULL AND remove_reason = 'Wrong drawing issue'), 1::bigint, 'the evidence is kept, marked removed');
  t := pg_temp.fails(format('SELECT app.remove_ppap_evidence(%L, %L)', ev, 'Wrong drawing issue'));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'it is removed once');
  PERFORM app.set_ppap_element(e2, '{"requirement":"retain"}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT requirement || '/' || requirement_edited FROM public.ppap_elements WHERE id = e2), 'retain/true', 'a hand-made requirement is remembered');
  PERFORM app.set_ppap_element(e2, '{"requirement":"required"}'::jsonb);

  -- ---- waivers ----
  t := pg_temp.fails(format('SELECT app.waive_ppap_element(%L, %L)', e2, 'The customer does not need it'));
  PERFORM pg_temp.assert_eq(left(t, 5), '42501', 'a preparer cannot waive');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(dan);
  t := pg_temp.fails(format('SELECT app.waive_ppap_element(%L, %L)', e2, 'short'));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'a waiver needs a reason of substance');
  PERFORM app.waive_ppap_element(e2, 'Customer confirmed the drawing is held by them');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.ppap_elements WHERE id = e2), 'waived', 'waived');
  PERFORM pg_temp.assert_eq((SELECT waived_by FROM public.ppap_elements WHERE id = e2), dan, 'by the approver');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  t := pg_temp.fails(format($f$SELECT app.set_ppap_element(%L, '{"note":"x"}'::jsonb)$f$, e2));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'a waived element is left alone');
  t := pg_temp.fails(format($f$SELECT app.add_ppap_file(%L, %L, 'x.pdf', 'application/pdf', 10)$f$, e2, org || '/ppap/' || s1 || '/bbbb-x.pdf'));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'and takes no evidence');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(dan);
  PERFORM app.unwaive_ppap_element(e2);
  PERFORM pg_temp.assert_eq((SELECT status FROM public.ppap_elements WHERE id = e2), 'not_started', 'the waiver comes off');
  t := pg_temp.fails(format('SELECT app.waive_ppap_element((SELECT id FROM public.ppap_elements WHERE submission_id = %L AND element_key = ''master_sample''), %L)', s2, 'Not needed at this level at all'));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'a not-required element needs no waiver');
  PERFORM app.waive_ppap_element(e2, 'Customer confirmed the drawing is held by them');
  PERFORM pg_temp.logout();

  -- ---- what is still needed, ready, reopen, withdraw ----
  PERFORM pg_temp.login(cat);
  PERFORM pg_temp.assert_eq(cardinality(app.ppap_problems(s1)), 16, 'level 3: seventeen required elements besides the warrant, one waived, so sixteen are left');
  PERFORM pg_temp.assert_eq((app.ppap_problems(s1))[1], 'Engineering change documents: add evidence, or ask an approver to waive it', 'the list says what to do, in order');
  t := pg_temp.fails(format('SELECT app.mark_ppap_ready(%L)', s1));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'it cannot be marked ready while something is needed');
  PERFORM pg_temp.assert_eq(app.ppap_problems(s2), '{}'::text[], 'level 1 needs nothing yet (the warrant comes with PP3)');
  PERFORM app.mark_ppap_ready(s2);
  PERFORM pg_temp.assert_eq((SELECT status FROM public.ppap_submissions WHERE id = s2), 'ready', 'ready');
  PERFORM pg_temp.assert_eq((SELECT ready_by FROM public.ppap_submissions WHERE id = s2), cat, 'by the preparer');
  t := pg_temp.fails(format($f$SELECT app.update_ppap(%L, '{"notes":"late change"}'::jsonb)$f$, s2));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'a ready submission is not edited');
  t := pg_temp.fails(format('SELECT app.set_ppap_level(%L, 2)', s2));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'nor re-levelled');
  PERFORM app.reopen_ppap(s2);
  PERFORM pg_temp.assert_eq((SELECT status || '/' || (ready_at IS NULL) FROM public.ppap_submissions WHERE id = s2), 'in_preparation/true', 'reopened');
  PERFORM app.update_ppap(s2, '{"notes":"Reworded","siteId":null}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT notes FROM public.ppap_submissions WHERE id = s2), 'Reworded', 'and editable again');
  t := pg_temp.fails(format('SELECT app.withdraw_ppap(%L, %L)', s2, 'x'));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'withdrawing needs a reason');
  PERFORM app.withdraw_ppap(s2, 'Customer cancelled the programme');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.ppap_submissions WHERE id = s2), 'withdrawn', 'withdrawn');
  t := pg_temp.fails(format('SELECT app.reopen_ppap(%L)', s2));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'a withdrawn submission is final');
  s4 := (app.create_ppap(org, jsonb_build_object('partId', part, 'customerId', cust, 'reason', 'tooling', 'level', 1)) ->> 'id')::uuid;
  PERFORM pg_temp.assert_eq((SELECT reference FROM public.ppap_submissions WHERE id = s4), 'PPAP-' || v_year || '-0004', 'after a withdrawal the same reason can start again');
  PERFORM app.mark_ppap_ready(s4);
  PERFORM pg_temp.logout();

  -- ---- the rules the tables hold even for SQL ----
  PERFORM pg_temp.assert_fails(format('DELETE FROM public.ppap_submissions WHERE id = %L', s1), 'a submission is never deleted');
  PERFORM pg_temp.assert_fails(format('UPDATE public.ppap_submissions SET part_revision_id = %L WHERE id = %L', rev_draft, s1), 'the part revision never changes');
  PERFORM pg_temp.assert_fails(format('UPDATE public.ppap_submissions SET customer_id = %L WHERE id = %L', cust2, s1), 'the customer never changes');
  PERFORM pg_temp.assert_fails(format('UPDATE public.ppap_submissions SET reference = ''PPAP-99-9999'' WHERE id = %L', s1), 'the reference never changes');
  PERFORM pg_temp.assert_fails(format('UPDATE public.ppap_submissions SET status = ''approved'' WHERE id = %L', s1), 'draft cannot jump to approved');
  PERFORM pg_temp.assert_fails(format('UPDATE public.ppap_submissions SET status = ''submitted'' WHERE id = %L', s1), 'a submission in preparation cannot be submitted without being ready');
  PERFORM pg_temp.assert_fails(format('UPDATE public.ppap_submissions SET notes = ''x'' WHERE id = %L', s4), 'a ready submission''s content is frozen');
  PERFORM pg_temp.assert_fails(format('UPDATE public.ppap_submissions SET status = ''submitted'' WHERE id = %L', s4), 'submitting needs a submitted date');
  PERFORM pg_temp.assert_fails(format('UPDATE public.ppap_submissions SET status = ''withdrawn'' WHERE id = %L', s1), 'withdrawing needs a reason and a date');
  PERFORM pg_temp.assert_fails(format('DELETE FROM public.ppap_elements WHERE id = %L', e1), 'an element is never deleted');
  PERFORM pg_temp.assert_fails(format('UPDATE public.ppap_elements SET element_key = ''dfmea'' WHERE id = %L', e1), 'an element''s key never changes');
  PERFORM pg_temp.assert_fails(format('UPDATE public.ppap_elements SET note = ''x'' WHERE submission_id = %L AND element_key = ''dfmea''', s4), 'a ready submission''s elements are frozen');
  PERFORM pg_temp.assert_fails(format('DELETE FROM public.ppap_evidence WHERE id = %L', ev), 'evidence is never deleted');
  PERFORM pg_temp.assert_fails(format('UPDATE public.ppap_evidence SET file_name = ''x.pdf'' WHERE id = %L', ev), 'evidence cannot be rewritten');
  PERFORM pg_temp.assert_fails(format('DELETE FROM public.ppap_requirement_sets WHERE id = %L', set1), 'a requirement set is never deleted');
  PERFORM pg_temp.assert_fails(format('UPDATE public.ppap_requirement_sets SET config = config || ''{"defaultLevel":1}'' WHERE id = %L', set1), 'a requirement set is frozen');
  PERFORM pg_temp.assert_fails(format('INSERT INTO public.ppap_elements (organisation_id, submission_id, element_key, requirement) VALUES (%L, %L, ''dfmea'', ''required'')', org, s4), 'elements cannot be added later');
  PERFORM pg_temp.assert_fails(format('DELETE FROM public.ppap_customer_rules WHERE customer_id = %L', cust2), 'a customer''s rules are never deleted');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.ppap_evidence (organisation_id, submission_id, element_id, storage_path, file_name, size_bytes) VALUES (%L, %L, %L, %L, 'x.pdf', 1)$q$,
    org, s4, (SELECT id FROM public.ppap_elements WHERE submission_id = s4 LIMIT 1), org || '/ppap/' || s4 || '/y.pdf'), 'evidence cannot be added to a ready submission');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.ppap_evidence (organisation_id, submission_id, element_id, storage_path, file_name, size_bytes) VALUES (%L, %L, %L, %L, 'x.pdf', 1)$q$,
    org, s1, e1, org || '/ppap/' || s2 || '/y.pdf'), 'a file path outside the submission''s folder is refused');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.ppap_submissions (organisation_id, reference, part_id, part_revision_id, customer_id, level, reason, requirement_set_id, owner_user_id)
    VALUES (%L, 'PPAP-99-0001', %L, %L, NULL, 3, 'other', %L, %L)$q$, org, part, rev, set1, ann), 'a submitted package needs a customer');

  -- ---- who reads what ----
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.ppap_submissions WHERE organisation_id = org), 0::bigint, 'a viewer does not see a submission that has not been sent');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.ppap_elements WHERE organisation_id = org), 0::bigint, 'nor its elements');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.ppap_requirement_sets WHERE organisation_id = org), 1::bigint, 'but reads the requirements');
  PERFORM pg_temp.assert_eq(app.ppap_file_allowed(org || '/ppap/' || s4 || '/y.pdf', false), false, 'and cannot read its files');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(dan);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.ppap_submissions WHERE organisation_id = org), 4::bigint, 'an approver reads them all');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  PERFORM pg_temp.assert_eq(app.ppap_file_allowed(org || '/ppap/' || s1 || '/y.pdf', true), true, 'a preparer uploads while it is being prepared');
  PERFORM pg_temp.assert_eq(app.ppap_file_allowed(org || '/ppap/' || s4 || '/y.pdf', true), false, 'not once it is ready');
  PERFORM pg_temp.assert_eq(app.ppap_file_allowed(org2 || '/ppap/' || s1 || '/y.pdf', false), false, 'and the path must name its own organisation');
  PERFORM pg_temp.logout();
  -- Sent (written here as the system would in PP3): the viewer now reads it, and its files, but still cannot write.
  UPDATE public.ppap_submissions SET status = 'submitted', submitted_at = now(), submitted_by = cat WHERE id = s4;
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.ppap_submissions WHERE organisation_id = org), 1::bigint, 'a viewer reads what has been sent');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.ppap_elements WHERE submission_id = s4), 18::bigint, 'with its elements');
  PERFORM pg_temp.assert_eq(app.ppap_file_allowed(org || '/ppap/' || s4 || '/y.pdf', false), true, 'and its files');
  t := pg_temp.fails(format('SELECT app.reopen_ppap(%L)', s4));
  PERFORM pg_temp.assert_eq(left(t, 5), '42501', 'but cannot change it');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  t := pg_temp.fails(format('SELECT app.reopen_ppap(%L)', s4));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'a sent submission cannot be reopened');
  PERFORM pg_temp.logout();

  -- ---- tenancy ----
  PERFORM pg_temp.login(eve);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.ppap_submissions), 0::bigint, 'another organisation sees none of them');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.ppap_requirement_sets), 1::bigint, 'only its own requirements');
  t := pg_temp.fails(format('SELECT app.mark_ppap_ready(%L)', s1));
  PERFORM pg_temp.assert_eq(left(t, 5), 'P0002', 'another organisation''s submission is not found');
  t := pg_temp.fails(format('SELECT app.set_ppap_element(%L, ''{"note":"x"}''::jsonb)', e1));
  PERFORM pg_temp.assert_eq(left(t, 5), 'P0002', 'nor its element');
  t := pg_temp.fails(format($f$SELECT app.create_ppap(%L, %L::jsonb)$f$, org, jsonb_build_object('partId', part, 'customerId', cust, 'reason', 'other')::text));
  PERFORM pg_temp.assert_eq(left(t, 5), 'P0002', 'nor can it create in another organisation');
  PERFORM pg_temp.logout();

  -- ---- requirement versions ----
  PERFORM pg_temp.login(cat);
  t := pg_temp.fails(format($f$SELECT app.save_ppap_requirement_set(%L, %L::jsonb, 'x changes')$f$, org, cfg::text));
  PERFORM pg_temp.assert_eq(left(t, 5), '42501', 'preparing is not enough to change the requirements');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(dan);
  t := pg_temp.fails(format($f$SELECT app.save_ppap_requirement_set(%L, %L::jsonb, 'No change at all')$f$, org, cfg::text));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'an unchanged set is refused');
  t := pg_temp.fails(format($f$SELECT app.save_ppap_requirement_set(%L, %L::jsonb, 'Remove a row')$f$, org, (cfg #- '{rows,dfmea}')::text));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'an invalid set is refused');
  t := pg_temp.fails(format($f$SELECT app.save_ppap_requirement_set(%L, %L::jsonb, 'x')$f$, org, jsonb_set(cfg, '{defaultLevel}', '4')::text));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'a reason is needed');
  set2 := app.save_ppap_requirement_set(org, jsonb_set(jsonb_set(cfg, '{defaultLevel}', '4'), '{rows,master_sample,3}', '"retain"'), 'Customers want the master sample kept, not sent');
  PERFORM pg_temp.assert_eq((SELECT version FROM public.ppap_requirement_sets WHERE id = set2), 2, 'a new version');
  PERFORM pg_temp.assert_eq((SELECT current FROM public.ppap_requirement_sets WHERE id = set1), false, 'the old one is no longer current');
  PERFORM pg_temp.assert_eq((SELECT requirement_set_id FROM public.ppap_submissions WHERE id = s1), set1, 'a submission keeps the version it was built on');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  s1 := (app.create_ppap(org, jsonb_build_object('partId', part, 'customerId', cust, 'reason', 'process_change')) ->> 'id')::uuid;
  PERFORM pg_temp.assert_eq((SELECT level || '/' || requirement_set_id::text FROM public.ppap_submissions WHERE id = s1), '4/' || set2::text, 'a new submission uses the new default and version');
  PERFORM pg_temp.assert_eq((SELECT requirement FROM public.ppap_elements WHERE submission_id = s1 AND element_key = 'customer_specific_requirements'), 'required', 'level 4 asks for the customer''s own requirements');
  PERFORM pg_temp.assert_eq((SELECT requirement FROM public.ppap_elements WHERE submission_id = s1 AND element_key = 'master_sample'), 'not_required', 'and not the master sample');
  PERFORM pg_temp.logout();

  -- ---- storage policies ----
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname LIKE 'ppap_files_%'
                              AND coalesce(qual, with_check) LIKE '%storage_file_allowed%' AND coalesce(qual, with_check) LIKE '%storage_direct_allowed%'), 2::bigint, 'the bucket''s policies use the shared rule');
  PERFORM pg_temp.assert_eq(app.storage_file_allowed('ppap-files', org || '/ppap/' || s1 || '/z.pdf', false) IS NOT NULL, true, 'the shared rule knows the bucket');
END $$;

ROLLBACK;
