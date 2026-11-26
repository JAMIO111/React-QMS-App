-- PPAP PP5b: staff ask a supplier for a package; the supplier sees named fields only, adds files to the elements asked of them, takes their own back, and submits; the package is then
-- submitted exactly as recording it as received does; our decision is shown to them (a reason or conditions only for a rejection or an interim approval).
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
  ('9a000000-0000-0000-0000-000000000b01', 'ann@pp5b.test', now()), ('9a000000-0000-0000-0000-000000000b02', 'bob@pp5b.test', now()),
  ('9a000000-0000-0000-0000-000000000b03', 'cat@pp5b.test', now()), ('9a000000-0000-0000-0000-000000000b04', 'dan@pp5b.test', now()),
  ('9a000000-0000-0000-0000-000000000b05', 'sam@acme.pp5b.test', now()), ('9a000000-0000-0000-0000-000000000b06', 'sue@other.pp5b.test', now()),
  ('9a000000-0000-0000-0000-000000000b07', 'cus@wayne.pp5b.test', now());

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '9a000000-0000-0000-0000-000000000b01'; bob uuid := '9a000000-0000-0000-0000-000000000b02'; cat uuid := '9a000000-0000-0000-0000-000000000b03';
  dan uuid := '9a000000-0000-0000-0000-000000000b04'; sam uuid := '9a000000-0000-0000-0000-000000000b05'; sue uuid := '9a000000-0000-0000-0000-000000000b06';
  cus uuid := '9a000000-0000-0000-0000-000000000b07';
  org uuid; u uuid; acme uuid; other uuid; nopo uuid; wayne uuid; p_acme uuid; p_other uuid; p_wayne uuid; a_sam uuid; a_sue uuid; a_cus uuid; part1 uuid; part2 uuid; part3 uuid;
  s1 uuid; s2 uuid; s3 uuid; s_cust uuid; req uuid; req2 uuid; req3 uuid; e_psw uuid; e_dim uuid; e_dfmea uuid; ev1 uuid; ev2 uuid; j jsonb; r text; k text; n integer;
  path text; sub public.ppap_submissions%ROWTYPE; d public.ppap_decisions%ROWTYPE;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('PB Alpha'); PERFORM pg_temp.logout();
  FOREACH u IN ARRAY ARRAY[bob, cat, dan] LOOP
    INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u, 'active');
  END LOOP;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = CASE WHEN ou.user_id = dan THEN 'quality_manager' WHEN ou.user_id = bob THEN 'viewer' ELSE 'quality_engineer' END)
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id IN (bob, cat, dan);
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'ACME', 'Acme Castings'), (org, 'OTHER', 'Other Metals'), (org, 'NOPO', 'No Portal Ltd');
  INSERT INTO public.customers (organisation_id, code, name) VALUES (org, 'WAYNE', 'Wayne Ltd');
  SELECT id INTO acme FROM public.suppliers WHERE organisation_id = org AND code = 'ACME';
  SELECT id INTO other FROM public.suppliers WHERE organisation_id = org AND code = 'OTHER';
  SELECT id INTO nopo FROM public.suppliers WHERE organisation_id = org AND code = 'NOPO';
  SELECT id INTO wayne FROM public.customers WHERE organisation_id = org AND code = 'WAYNE';
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'PB-100', 'Bracket'), (org, 'PB-200', 'Housing'), (org, 'PB-300', 'Clip');
  SELECT id INTO part1 FROM public.parts WHERE organisation_id = org AND part_number = 'PB-100';
  SELECT id INTO part2 FROM public.parts WHERE organisation_id = org AND part_number = 'PB-200';
  SELECT id INTO part3 FROM public.parts WHERE organisation_id = org AND part_number = 'PB-300';
  INSERT INTO public.part_revisions (organisation_id, part_id, revision) SELECT org, id, 'A' FROM public.parts WHERE organisation_id = org;
  UPDATE public.part_revisions SET status = 'released' WHERE organisation_id = org;

  PERFORM pg_temp.login(ann);
  PERFORM app.set_portal_settings(org, true, NULL, false);
  p_acme := app.set_portal_party(org, 'supplier', acme, true, 'Pat in Purchasing');
  p_other := app.set_portal_party(org, 'supplier', other, true);
  p_wayne := app.set_portal_party(org, 'customer', wayne, true);
  a_sam := app.invite_external_user(p_acme, 'sam@acme.pp5b.test', 'admin', NULL);
  a_sue := app.invite_external_user(p_other, 'sue@other.pp5b.test', 'admin', NULL);
  a_cus := app.invite_external_user(p_wayne, 'cus@wayne.pp5b.test', 'admin', NULL);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(sam); PERFORM app.accept_portal_invitation(a_sam); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(sue); PERFORM app.accept_portal_invitation(a_sue); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cus); PERFORM app.accept_portal_invitation(a_cus); PERFORM pg_temp.logout();

  -- ---- staff: a received package, asked of the supplier ----
  PERFORM pg_temp.login(cat);
  s1 := (app.create_ppap(org, jsonb_build_object('direction', 'received', 'partId', part1, 'supplierId', acme, 'reason', 'new_part', 'level', 1)) ->> 'id')::uuid;
  SELECT id INTO e_psw FROM public.ppap_elements WHERE submission_id = s1 AND element_key = 'part_submission_warrant';
  SELECT id INTO e_dim FROM public.ppap_elements WHERE submission_id = s1 AND element_key = 'dimensional_results';
  SELECT id INTO e_dfmea FROM public.ppap_elements WHERE submission_id = s1 AND element_key = 'dfmea';
  PERFORM app.set_ppap_element(e_dim, '{"requirement": "required"}'::jsonb);
  PERFORM app.set_ppap_element((SELECT id FROM public.ppap_elements WHERE submission_id = s1 AND element_key = 'master_sample'), '{"requirement": "retain"}'::jsonb);
  s2 := (app.create_ppap(org, jsonb_build_object('direction', 'received', 'partId', part2, 'supplierId', nopo, 'reason', 'new_part', 'level', 1)) ->> 'id')::uuid;
  s_cust := (app.create_ppap(org, jsonb_build_object('partId', part3, 'customerId', wayne, 'reason', 'new_part', 'level', 1)) ->> 'id')::uuid;
  r := pg_temp.fails(format($f$SELECT app.request_ppap_supplier_package(%L, NULL)$f$, s2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'a supplier that is not set up for the portal cannot be asked');
  r := pg_temp.fails(format($f$SELECT app.request_ppap_supplier_package(%L, NULL)$f$, s_cust));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'a package to a customer is not asked of a supplier');
  PERFORM pg_temp.assert_eq((SELECT string_agg(party_name, ',') FROM app.ppap_supplier_party(s1)), 'Acme Castings', 'the package is from the supplier');
  req := app.request_ppap_supplier_package(s1, 'Please send the package for the new bracket.');
  r := pg_temp.fails(format($f$SELECT app.request_ppap_supplier_package(%L, NULL)$f$, s1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'one request waits at a time');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.ppap_request_recipients(req)), 1::bigint, 'the supplier''s people are emailed');
  PERFORM pg_temp.assert_eq(app.ppap_customer_requests(s1) -> 0 ->> 'customer', 'Acme Castings', 'staff see the request with the supplier''s name');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(bob);
  r := pg_temp.fails(format($f$SELECT app.request_ppap_supplier_package(%L, NULL)$f$, s1));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a viewer cannot ask');
  PERFORM pg_temp.logout();

  -- ---- who sees it ----
  PERFORM pg_temp.login(sue);
  r := pg_temp.fails(format($f$SELECT app.portal_get_ppap_package(%L)$f$, req));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'another supplier sees nothing of it');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.portal_list_ppap_packages(org)), 0::bigint, 'their list is empty');
  r := pg_temp.fails(format($f$SELECT app.portal_submit_ppap_package(%L, NULL)$f$, req));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'nor can they submit it');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cus);
  r := pg_temp.fails(format($f$SELECT app.portal_get_ppap_package(%L)$f$, req));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'a customer sees nothing of it');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login(sam);
  j := app.portal_get_ppap_package(req);
  SELECT string_agg(x, ',' ORDER BY x) INTO k FROM jsonb_object_keys(j) x;
  PERFORM pg_temp.assert_eq(k, 'answeredAt,canEdit,canSubmit,contact,decidedOn,decision,decisionExpiresOn,decisionNote,elements,id,level,missing,partName,partNumber,reason,reference,requestNote,requestedAt,revision,status,submissionStatus,submittedOn', 'the exact keys');
  SELECT string_agg(x, ',' ORDER BY x) INTO k FROM jsonb_object_keys(j -> 'elements' -> 0) x;
  PERFORM pg_temp.assert_eq(k, 'files,key,name,provided,requirement,waived', 'an element shows its name, what is asked, and their own files');
  PERFORM pg_temp.assert_eq((SELECT string_agg(e ->> 'name', ',' ORDER BY e ->> 'name') FROM jsonb_array_elements(j -> 'elements') e), 'Dimensional results,Master sample,Part Submission Warrant', 'only the elements asked of them');
  PERFORM pg_temp.assert_eq(j ->> 'contact', 'Pat in Purchasing', 'who to contact');
  PERFORM pg_temp.assert_eq((j ->> 'canEdit')::boolean AND NOT (j ->> 'canSubmit')::boolean, true, 'they may prepare it but not yet submit it');
  PERFORM pg_temp.assert_eq(j -> 'missing', '["Dimensional results", "Part Submission Warrant"]'::jsonb, 'with what is still missing');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.portal_list_ppap_packages(org)), 1::bigint, 'it is in their list');
  SELECT string_agg(c, ',' ORDER BY c) INTO k FROM jsonb_object_keys((SELECT to_jsonb(x) FROM app.portal_list_ppap_packages(org) x)) c;
  PERFORM pg_temp.assert_eq(k, 'answered_at,can_edit,level,part_name,part_number,reference,request_id,requested_at,status,submission_status', 'the list is named fields only');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.portal_ppap_requests) + (SELECT count(*) FROM public.ppap_submissions) + (SELECT count(*) FROM public.ppap_evidence), 0::bigint, 'they read no tables');
  r := pg_temp.fails(format($f$SELECT app.portal_submit_ppap_package(%L, NULL)$f$, req));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'it cannot be submitted while something is missing');
  PERFORM pg_temp.assert_eq(r LIKE '%Dimensional results%' AND r LIKE '%Part Submission Warrant%', true, 'and says what');

  -- ---- files ----
  path := org || '/ppap/' || s1 || '/' || gen_random_uuid() || '-warrant.pdf';
  PERFORM pg_temp.assert_eq(app.portal_ppap_package_folder(req), s1, 'the folder is the package''s own');
  PERFORM pg_temp.assert_eq(app.portal_ppap_upload_allowed(req, 'part_submission_warrant', path), true, 'a file may go to an element asked of them');
  PERFORM pg_temp.assert_eq(app.portal_ppap_upload_allowed(req, 'dfmea', path), false, 'not to an element not asked of them');
  PERFORM pg_temp.assert_eq(app.portal_ppap_upload_allowed(req, 'part_submission_warrant', org || '/ppap/' || s2 || '/x.pdf'), false, 'not into another package''s folder');
  PERFORM pg_temp.assert_eq(app.portal_ppap_upload_allowed(req, 'part_submission_warrant', org || '/ppap/' || s1 || '/../x.pdf'), false, 'nor out of it');
  r := pg_temp.fails(format($f$SELECT app.portal_add_ppap_file(%L, 'dfmea', %L, 'x.pdf', 'application/pdf', 10)$f$, req, path));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'a file for an element not asked of them is refused');
  ev1 := app.portal_add_ppap_file(req, 'part_submission_warrant', path, 'warrant.pdf', 'application/pdf', 1000);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT status FROM public.ppap_elements WHERE id = e_psw), 'ready', 'a required element with a file is ready');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.ppap_submissions WHERE id = s1), 'in_preparation', 'and the package is being prepared');
  PERFORM pg_temp.login(sam);
  j := app.portal_get_ppap_package(req);
  PERFORM pg_temp.assert_eq(j -> 'missing', '["Dimensional results"]'::jsonb, 'one thing less is missing');
  PERFORM pg_temp.assert_eq(((SELECT e FROM jsonb_array_elements(j -> 'elements') e WHERE e ->> 'key' = 'part_submission_warrant') -> 'files' -> 0 ->> 'mine')::boolean, true, 'the file is theirs');
  PERFORM pg_temp.assert_eq((SELECT file_name FROM app.portal_ppap_package_file_path(ev1)), 'warrant.pdf', 'they can open it');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(sue);
  r := pg_temp.fails(format($f$SELECT * FROM app.portal_ppap_package_file_path(%L)$f$, ev1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'another supplier cannot open it');
  r := pg_temp.fails(format($f$SELECT app.portal_remove_ppap_file(%L)$f$, ev1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'nor take it back');
  PERFORM pg_temp.logout();
  -- a file of ours on the package is not shown to the supplier
  PERFORM pg_temp.login(cat);
  PERFORM app.add_ppap_file(e_dim, org || '/ppap/' || s1 || '/ours-internal.pdf', 'ours-internal.pdf', 'application/pdf', 10, 'Our own note file');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(sam);
  j := app.portal_get_ppap_package(req);
  PERFORM pg_temp.assert_eq(jsonb_array_length(((SELECT e FROM jsonb_array_elements(j -> 'elements') e WHERE e ->> 'key' = 'dimensional_results') -> 'files')), 0, 'files of ours are not shown');
  PERFORM pg_temp.assert_eq((j -> 'missing')::text, '[]', 'though evidence of ours counts as evidence');
  PERFORM app.portal_remove_ppap_file(ev1);
  PERFORM pg_temp.assert_eq(app.portal_get_ppap_package(req) -> 'missing', '["Part Submission Warrant"]'::jsonb, 'taking a file back makes the element missing again');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT status FROM public.ppap_elements WHERE id = e_psw), 'in_progress', 'and not ready');
  PERFORM pg_temp.login(sam);
  ev2 := app.portal_add_ppap_file(req, 'part_submission_warrant', org || '/ppap/' || s1 || '/' || gen_random_uuid() || '-warrant2.pdf', 'warrant.pdf', 'application/pdf', 1000);
  FOR n IN 1..9 LOOP
    PERFORM app.portal_add_ppap_file(req, 'master_sample', org || '/ppap/' || s1 || '/' || gen_random_uuid() || '-m.pdf', 'm.pdf', 'application/pdf', 1);
  END LOOP;
  PERFORM pg_temp.assert_eq(app.portal_ppap_upload_allowed(req, 'master_sample', org || '/ppap/' || s1 || '/' || gen_random_uuid() || '-m.pdf'), true, 'nine files, a tenth is allowed');
  PERFORM app.portal_add_ppap_file(req, 'master_sample', org || '/ppap/' || s1 || '/' || gen_random_uuid() || '-m.pdf', 'm.pdf', 'application/pdf', 1);
  PERFORM pg_temp.assert_eq(app.portal_ppap_upload_allowed(req, 'master_sample', org || '/ppap/' || s1 || '/' || gen_random_uuid() || '-m.pdf'), false, 'an eleventh is not');
  PERFORM pg_temp.assert_eq((app.portal_get_ppap_package(req) ->> 'canSubmit')::boolean, true, 'now they can submit');

  -- ---- submitting ----
  PERFORM app.portal_submit_ppap_package(req, 'All documents attached.');
  PERFORM pg_temp.assert_eq(app.portal_get_ppap_package(req) ->> 'submissionStatus', 'submitted', 'the package is submitted');
  PERFORM pg_temp.assert_eq((app.portal_get_ppap_package(req) ->> 'canEdit')::boolean, false, 'and no longer open to change');
  r := pg_temp.fails(format($f$SELECT app.portal_submit_ppap_package(%L, NULL)$f$, req));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'it is submitted once');
  r := pg_temp.fails(format($f$SELECT app.portal_remove_ppap_file(%L)$f$, ev2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'a file cannot be taken back after');
  PERFORM pg_temp.assert_eq(app.portal_ppap_upload_allowed(req, 'part_submission_warrant', org || '/ppap/' || s1 || '/' || gen_random_uuid() || '-late.pdf'), false, 'nor another added');
  PERFORM pg_temp.logout();
  SELECT * INTO sub FROM public.ppap_submissions WHERE id = s1;
  PERFORM pg_temp.assert_eq(sub.status || '|' || (sub.submitted_by = sam), 'submitted|true', 'recorded as submitted by their person');
  SELECT * INTO d FROM public.ppap_decisions WHERE submission_id = s1 AND kind = 'submitted';
  PERFORM pg_temp.assert_eq(d.how || '|' || d.note || '|' || (d.portal_request_id = req) || '|' || (d.created_by = sam), 'Supplier portal|All documents attached.|true|true', 'with the decision written as theirs');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.portal_ppap_requests WHERE id = req), 'answered', 'the request is answered');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.portal_activity WHERE kind = 'ppap_submitted' AND record_id = s1 AND record_kind = 'ppap'), 1::bigint, 'staff are told');

  -- ---- our decision, and what the supplier sees of it ----
  PERFORM pg_temp.login(dan);
  PERFORM app.record_ppap_decision(s1, 'approved', current_date, 'OUR-1', NULL, 'Internal remark that stays with us');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(sam);
  j := app.portal_get_ppap_package(req);
  PERFORM pg_temp.assert_eq(j ->> 'decision', 'approved', 'they see we approved it');
  PERFORM pg_temp.assert_eq(j ->> 'decisionNote' IS NULL, true, 'but not the note on an approval');
  PERFORM pg_temp.logout();

  -- ---- a rejection shows its reason; a withdrawn request disappears ----
  PERFORM pg_temp.login(cat);
  s3 := (app.create_ppap(org, jsonb_build_object('direction', 'received', 'partId', part2, 'supplierId', acme, 'reason', 'new_part', 'level', 1)) ->> 'id')::uuid;
  req3 := app.request_ppap_supplier_package(s3, NULL);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(sam);
  PERFORM app.portal_add_ppap_file(req3, 'part_submission_warrant', org || '/ppap/' || s3 || '/' || gen_random_uuid() || '-w.pdf', 'w.pdf', 'application/pdf', 1);
  PERFORM app.portal_submit_ppap_package(req3, NULL);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(dan);
  PERFORM app.record_ppap_decision(s3, 'rejected', current_date, NULL, NULL, 'The capability study is missing.');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(sam);
  j := app.portal_get_ppap_package(req3);
  PERFORM pg_temp.assert_eq(j ->> 'decision' || '|' || (j ->> 'decisionNote'), 'rejected|The capability study is missing.', 'a rejection shows its reason');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  s2 := (app.create_ppap(org, jsonb_build_object('direction', 'received', 'partId', part3, 'supplierId', acme, 'reason', 'new_part', 'level', 1)) ->> 'id')::uuid;
  req2 := app.request_ppap_supplier_package(s2, NULL);
  r := pg_temp.fails(format($f$SELECT app.withdraw_ppap_customer_request(%L, 'x')$f$, req2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'a withdrawal needs a reason');
  PERFORM app.withdraw_ppap_customer_request(req2, 'Asked too early');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(sam);
  r := pg_temp.fails(format($f$SELECT app.portal_get_ppap_package(%L)$f$, req2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'a withdrawn request is gone for the supplier');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.portal_list_ppap_packages(org)), 2::bigint, 'and not listed');
  PERFORM pg_temp.logout();
END $$;
ROLLBACK;
