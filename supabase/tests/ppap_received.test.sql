-- PPAP PP5a: a package received from a supplier, recorded by staff: made with a supplier and no customer, no warrant of ours (the supplier's own is a file), the warrant element
-- behaves like the others, our decision is recorded by the same function, and a rejected package is replaced by a new one from the same supplier.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('8e000000-0000-0000-0000-000000000a01', 'ann@pr.test'), ('8e000000-0000-0000-0000-000000000a02', 'bob@pr.test'),
  ('8e000000-0000-0000-0000-000000000a03', 'cat@pr.test'), ('8e000000-0000-0000-0000-000000000a04', 'dan@pr.test'),
  ('8e000000-0000-0000-0000-000000000a05', 'eve@pr.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '8e000000-0000-0000-0000-000000000a01'; bob uuid := '8e000000-0000-0000-0000-000000000a02'; cat uuid := '8e000000-0000-0000-0000-000000000a03';
  dan uuid := '8e000000-0000-0000-0000-000000000a04'; eve uuid := '8e000000-0000-0000-0000-000000000a05';
  org uuid; org2 uuid; u uuid; part uuid; part2 uuid; rev uuid; rev2 uuid; acme uuid; other uuid; cust uuid; s1 uuid; s2 uuid; s3 uuid; s4 uuid; r jsonb; t text; e_psw uuid; ev uuid; n integer;
  sub public.ppap_submissions%ROWTYPE; probs text[];
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('PR Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('PR Beta'); PERFORM pg_temp.logout();
  FOREACH u IN ARRAY ARRAY[bob, cat, dan] LOOP
    INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u, 'active');
  END LOOP;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = CASE WHEN ou.user_id = dan THEN 'quality_manager' WHEN ou.user_id = bob THEN 'viewer' ELSE 'quality_engineer' END)
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id IN (bob, cat, dan);
  PERFORM pg_temp.login(ann);
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'PR-P1', 'Bracket') RETURNING id INTO part;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'PR-P2', 'Housing') RETURNING id INTO part2;
  INSERT INTO public.part_revisions (organisation_id, part_id, revision) VALUES (org, part, 'A') RETURNING id INTO rev;
  INSERT INTO public.part_revisions (organisation_id, part_id, revision) VALUES (org, part2, 'A') RETURNING id INTO rev2;
  UPDATE public.part_revisions SET status = 'released' WHERE id IN (rev, rev2);
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'ACME', 'Acme Castings') RETURNING id INTO acme;
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'OTHER', 'Other Metals') RETURNING id INTO other;
  INSERT INTO public.customers (organisation_id, code, name) VALUES (org, 'WAYNE', 'Wayne Ltd') RETURNING id INTO cust;
  PERFORM pg_temp.logout();

  -- ---- starting a received package ----
  PERFORM pg_temp.login(cat);
  t := pg_temp.fails(format($q$SELECT app.create_ppap(%L, jsonb_build_object('direction', 'received', 'partId', %L, 'reason', 'new_part'))$q$, org, part));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'a received package needs a supplier');
  t := pg_temp.fails(format($q$SELECT app.create_ppap(%L, jsonb_build_object('direction', 'received', 'partId', %L, 'supplierId', %L, 'customerId', %L, 'reason', 'new_part'))$q$, org, part, acme, cust));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'and no customer');
  t := pg_temp.fails(format($q$SELECT app.create_ppap(%L, jsonb_build_object('partId', %L, 'supplierId', %L, 'customerId', %L, 'reason', 'new_part'))$q$, org, part, acme, cust));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'a submission to a customer names no supplier');
  t := pg_temp.fails(format($q$SELECT app.create_ppap(%L, jsonb_build_object('direction', 'received', 'partId', %L, 'supplierId', %L, 'reason', 'new_part'))$q$, org2, part, acme));
  PERFORM pg_temp.assert_eq(t NOT LIKE 'ok%', true, 'another organisation is refused');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(bob);
  t := pg_temp.fails(format($q$SELECT app.create_ppap(%L, jsonb_build_object('direction', 'received', 'partId', %L, 'supplierId', %L, 'reason', 'new_part'))$q$, org, part, acme));
  PERFORM pg_temp.assert_eq(left(t, 5), '42501', 'a viewer cannot start one');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login(cat);
  r := app.create_ppap(org, jsonb_build_object('direction', 'received', 'partId', part, 'supplierId', acme, 'reason', 'new_part'));
  s1 := (r ->> 'id')::uuid;
  SELECT * INTO sub FROM public.ppap_submissions WHERE id = s1;
  PERFORM pg_temp.assert_eq(sub.direction || '|' || sub.level, 'received|3', 'it starts at the organisation''s default level');
  PERFORM pg_temp.assert_eq(sub.customer_id IS NULL AND sub.supplier_id = acme, true, 'for the supplier');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.ppap_elements WHERE submission_id = s1), 18::bigint, 'with its 18 elements');
  PERFORM pg_temp.assert_eq(cardinality(app.ppap_problems(s1)) > 1, true, 'and a list of what it still needs');
  PERFORM pg_temp.assert_eq((SELECT bool_and(requirement <> 'n_a') FROM public.ppap_elements WHERE submission_id = s1), true, 'elements start from the requirement set');
  s2 := (app.create_ppap(org, jsonb_build_object('direction', 'received', 'partId', part2, 'supplierId', acme, 'reason', 'new_part', 'level', 1)) ->> 'id')::uuid;
  PERFORM pg_temp.assert_eq((SELECT level FROM public.ppap_submissions WHERE id = s2), 1, 'a level can be given');
  t := pg_temp.fails(format($q$SELECT app.create_ppap(%L, jsonb_build_object('direction', 'received', 'partId', %L, 'supplierId', %L, 'reason', 'new_part'))$q$, org, part, acme));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'one live package per part revision, supplier and reason');
  PERFORM app.create_ppap(org, jsonb_build_object('direction', 'received', 'partId', part, 'supplierId', other, 'reason', 'new_part'));

  -- ---- no warrant of ours ----
  t := pg_temp.fails(format($q$SELECT app.save_ppap_psw(%L, '{"partWeight": 1}'::jsonb)$q$, s2));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'a received package takes no typed warrant');
  PERFORM pg_temp.assert_eq(t LIKE '%supplier''s own%', true, 'and says the supplier''s is a file');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.ppap_psw (organisation_id, submission_id) VALUES (%L, %L)$q$, org, s2), 'not even by SQL');

  -- ---- the warrant element is evidence like the rest ----
  SELECT id INTO e_psw FROM public.ppap_elements WHERE submission_id = s2 AND element_key = 'part_submission_warrant';
  probs := app.ppap_problems(s2);
  PERFORM pg_temp.assert_eq(probs, ARRAY['Part Submission Warrant: add evidence, or ask an approver to waive it'], 'level 1 needs the supplier''s warrant as evidence');
  t := pg_temp.fails(format($q$SELECT app.set_ppap_element(%L, '{"status": "ready"}'::jsonb)$q$, e_psw));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'it is not ready without a file');
  t := pg_temp.fails(format('SELECT app.mark_ppap_ready(%L)', s2));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'so the package cannot be marked ready');
  ev := app.add_ppap_file(e_psw, org || '/ppap/' || s2 || '/aaaa-warrant.pdf', 'warrant.pdf', 'application/pdf', 1000, 'The supplier''s signed warrant');
  PERFORM app.set_ppap_element(e_psw, '{"status": "ready"}'::jsonb);
  PERFORM pg_temp.assert_eq(cardinality(app.ppap_problems(s2)), 0, 'with the file and the ready mark nothing is needed');
  PERFORM app.remove_ppap_evidence(ev, 'Wrong file');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.ppap_elements WHERE id = e_psw), 'in_progress', 'removing the only file takes the ready mark off');
  ev := app.add_ppap_file(e_psw, org || '/ppap/' || s2 || '/bbbb-warrant.pdf', 'warrant.pdf', 'application/pdf', 1000, 'The supplier''s signed warrant');
  PERFORM app.set_ppap_element(e_psw, '{"status": "ready"}'::jsonb);
  PERFORM app.mark_ppap_ready(s2);
  PERFORM app.submit_ppap(s2, current_date - 2, 'Emailed by the supplier', 'Received with their covering letter');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.ppap_submissions WHERE id = s2), 'submitted', 'receiving it records the day');
  PERFORM pg_temp.assert_eq((SELECT decided_on FROM public.ppap_decisions WHERE submission_id = s2 AND kind = 'submitted'), current_date - 2, 'received on the day given');
  PERFORM pg_temp.logout();

  -- ---- our decision ----
  PERFORM pg_temp.login(cat);
  t := pg_temp.fails(format($q$SELECT app.record_ppap_decision(%L, 'approved', current_date)$q$, s2));
  PERFORM pg_temp.assert_eq(left(t, 5), '42501', 'only an approver decides');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(dan);
  PERFORM app.record_ppap_decision(s2, 'approved', current_date, 'OUR-OK-1');
  SELECT * INTO sub FROM public.ppap_submissions WHERE id = s2;
  PERFORM pg_temp.assert_eq(sub.status, 'approved', 'approved');
  PERFORM pg_temp.assert_eq(sub.next_review_on, (current_date + interval '12 months')::date, 'with the review date');
  PERFORM pg_temp.assert_eq(app.ppap_replaceable(s2), true, 'an approved received package can be revalidated');
  PERFORM pg_temp.logout();

  -- ---- rejected, then replaced from the same supplier ----
  PERFORM pg_temp.login(cat);
  PERFORM app.set_ppap_level(s1, 1);
  SELECT id INTO e_psw FROM public.ppap_elements WHERE submission_id = s1 AND element_key = 'part_submission_warrant';
  PERFORM app.add_ppap_file(e_psw, org || '/ppap/' || s1 || '/cccc-warrant.pdf', 'warrant.pdf', 'application/pdf', 1000);
  PERFORM app.set_ppap_element(e_psw, '{"status": "ready"}'::jsonb);
  PERFORM app.mark_ppap_ready(s1);
  PERFORM app.submit_ppap(s1, current_date - 3, 'Portal', NULL);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(dan);
  PERFORM app.record_ppap_decision(s1, 'rejected', current_date - 1, NULL, NULL, 'The capability study is missing.');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  r := app.start_ppap_resubmission(s1, '{}'::jsonb);
  s3 := (r ->> 'id')::uuid;
  SELECT * INTO sub FROM public.ppap_submissions WHERE id = s3;
  PERFORM pg_temp.assert_eq(sub.direction || '|' || (sub.supplier_id = acme) || '|' || (sub.customer_id IS NULL) || '|' || (sub.replaces_id = s1), 'received|true|true|true', 'a replacement is again received from the same supplier and names the old one');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.ppap_psw WHERE submission_id = s3), 0::bigint, 'with no warrant of ours');
  -- a package of another supplier cannot be named as the one replaced
  t := pg_temp.fails(format($q$SELECT app.create_ppap(%L, jsonb_build_object('direction', 'received', 'partId', %L, 'supplierId', %L, 'reason', 'tooling', 'replacesId', %L))$q$, org, part, other, s1));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'only the same supplier''s package can be replaced');
  PERFORM pg_temp.logout();

  -- ---- a submission to a customer is unchanged ----
  PERFORM pg_temp.login(dan);
  PERFORM app.set_ppap_customer_rules(cust, '{"defaultLevel":1}'::jsonb);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  s4 := (app.create_ppap(org, jsonb_build_object('partId', part2, 'customerId', cust, 'reason', 'new_part')) ->> 'id')::uuid;
  PERFORM pg_temp.assert_eq((SELECT direction FROM public.ppap_submissions WHERE id = s4), 'submitted', 'a package to a customer still starts as before');
  PERFORM pg_temp.assert_eq((app.ppap_problems(s4))[1] LIKE 'Part Submission Warrant: fill it in%', true, 'and still needs its own warrant');
  PERFORM app.save_ppap_psw(s4, '{"partWeight": 1}'::jsonb);
  PERFORM pg_temp.logout();

  -- ---- another organisation sees nothing ----
  PERFORM pg_temp.login(eve);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.ppap_submissions), 0::bigint, 'another organisation sees none of it');
  PERFORM pg_temp.logout();
END $$;
ROLLBACK;
