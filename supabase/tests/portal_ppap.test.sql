-- PPAP PP4: staff ask a customer to answer a submission in the portal; the customer sees named fields only and answers (approved, interim approved, rejected); the answer is
-- recorded as the submission's own decision by the same rules staff use; one request waits at a time; staff recording the answer by hand settles it; nothing is shown to others.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
  ('7d000000-0000-0000-0000-000000000f01', 'ann@pp4.test', now()), ('7d000000-0000-0000-0000-000000000f02', 'bob@pp4.test', now()),
  ('7d000000-0000-0000-0000-000000000f03', 'cat@pp4.test', now()), ('7d000000-0000-0000-0000-000000000f04', 'dan@pp4.test', now()),
  ('7d000000-0000-0000-0000-000000000f05', 'cus@wayne.pp4.test', now()), ('7d000000-0000-0000-0000-000000000f06', 'cus2@other.pp4.test', now()),
  ('7d000000-0000-0000-0000-000000000f07', 'sam@acme.pp4.test', now());

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

-- A level-1 submission for the customer, prepared by cat, warrant signed by dan, marked ready and sent.
CREATE FUNCTION pg_temp.send_ppap(p_org uuid, p_part uuid, p_customer uuid, p_cat uuid, p_dan uuid, p_sent date) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE s uuid;
BEGIN
  PERFORM pg_temp.login(p_cat);
  s := (app.create_ppap(p_org, jsonb_build_object('partId', p_part, 'customerId', p_customer, 'reason', 'new_part')) ->> 'id')::uuid;
  PERFORM app.save_ppap_psw(s, '{"partWeight": 1.25, "weightUnit": "kg", "purchaseOrder": "PO-77", "resultsMeetRequirements": true}'::jsonb);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(p_dan); PERFORM app.sign_ppap_psw(s, 'Quality Manager', '01234 567890'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(p_cat); PERFORM app.mark_ppap_ready(s); PERFORM app.submit_ppap(s, p_sent, 'Customer portal', NULL); PERFORM pg_temp.logout();
  RETURN s;
END $$;

DO $$
DECLARE
  ann uuid := '7d000000-0000-0000-0000-000000000f01'; bob uuid := '7d000000-0000-0000-0000-000000000f02'; cat uuid := '7d000000-0000-0000-0000-000000000f03';
  dan uuid := '7d000000-0000-0000-0000-000000000f04'; cus uuid := '7d000000-0000-0000-0000-000000000f05'; cus2 uuid := '7d000000-0000-0000-0000-000000000f06';
  sam uuid := '7d000000-0000-0000-0000-000000000f07';
  org uuid; u uuid; wayne uuid; other uuid; acme uuid; p_wayne uuid; p_other uuid; p_acme uuid; a_cus uuid; a_cus2 uuid; a_sam uuid;
  part1 uuid; part2 uuid; part3 uuid; part4 uuid; part5 uuid; s1 uuid; s2 uuid; s3 uuid; s4 uuid; s5 uuid; req uuid; req2 uuid; req3 uuid; j jsonb; r text; k text; sub public.ppap_submissions%ROWTYPE;
  d public.ppap_decisions%ROWTYPE;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('PP4 Alpha'); PERFORM pg_temp.logout();
  -- Bob: viewer. Cat: quality engineer (prepares and sends). Dan: quality manager (signs and records decisions).
  FOREACH u IN ARRAY ARRAY[bob, cat, dan] LOOP
    INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u, 'active');
  END LOOP;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = CASE WHEN ou.user_id = dan THEN 'quality_manager' WHEN ou.user_id = bob THEN 'viewer' ELSE 'quality_engineer' END)
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id IN (bob, cat, dan);
  UPDATE public.profiles SET first_name = 'Dan', surname = 'Manager' WHERE id = dan;
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'ACME', 'Acme Castings');
  INSERT INTO public.customers (organisation_id, code, name) VALUES (org, 'WAYNE', 'Wayne Ltd'), (org, 'OTHER', 'Other Co');
  SELECT id INTO acme FROM public.suppliers WHERE organisation_id = org AND code = 'ACME';
  SELECT id INTO wayne FROM public.customers WHERE organisation_id = org AND code = 'WAYNE';
  SELECT id INTO other FROM public.customers WHERE organisation_id = org AND code = 'OTHER';
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'P4-100', 'Bracket'), (org, 'P4-200', 'Housing'), (org, 'P4-300', 'Clip'), (org, 'P4-400', 'Plate'), (org, 'P4-500', 'Cap');
  SELECT id INTO part1 FROM public.parts WHERE organisation_id = org AND part_number = 'P4-100';
  SELECT id INTO part2 FROM public.parts WHERE organisation_id = org AND part_number = 'P4-200';
  SELECT id INTO part3 FROM public.parts WHERE organisation_id = org AND part_number = 'P4-300';
  SELECT id INTO part4 FROM public.parts WHERE organisation_id = org AND part_number = 'P4-400';
  SELECT id INTO part5 FROM public.parts WHERE organisation_id = org AND part_number = 'P4-500';
  INSERT INTO public.part_revisions (organisation_id, part_id, revision) SELECT org, id, 'A' FROM public.parts WHERE organisation_id = org;
  UPDATE public.part_revisions SET status = 'released' WHERE organisation_id = org;
  INSERT INTO public.part_customers (organisation_id, part_id, customer_id, customer_part_number, is_primary) VALUES (org, part1, wayne, 'W-77', true);

  PERFORM pg_temp.login(ann);
  PERFORM app.set_portal_settings(org, true, NULL, false);
  p_acme := app.set_portal_party(org, 'supplier', acme, true);
  p_wayne := app.set_portal_party(org, 'customer', wayne, true, 'Pat in Quality');
  p_other := app.set_portal_party(org, 'customer', other, true);
  a_sam := app.invite_external_user(p_acme, 'sam@acme.pp4.test', 'admin', NULL);
  a_cus := app.invite_external_user(p_wayne, 'cus@wayne.pp4.test', 'admin', NULL);
  a_cus2 := app.invite_external_user(p_other, 'cus2@other.pp4.test', 'admin', NULL);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(sam); PERFORM app.accept_portal_invitation(a_sam); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cus); PERFORM app.accept_portal_invitation(a_cus); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cus2); PERFORM app.accept_portal_invitation(a_cus2); PERFORM pg_temp.logout();

  -- Level 1 for both customers: only the warrant is required.
  PERFORM pg_temp.login(dan);
  PERFORM app.set_ppap_customer_rules(wayne, '{"defaultLevel":1}'::jsonb);
  PERFORM app.set_ppap_customer_rules(other, '{"defaultLevel":1}'::jsonb);
  PERFORM pg_temp.logout();

  -- A submission still being prepared cannot be put to the customer.
  PERFORM pg_temp.login(cat);
  s2 := (app.create_ppap(org, jsonb_build_object('partId', part2, 'customerId', wayne, 'reason', 'new_part')) ->> 'id')::uuid;
  r := pg_temp.fails(format($f$SELECT app.request_ppap_customer_answer(%L, NULL)$f$, s2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'a submission not yet sent is not put to the customer');
  PERFORM pg_temp.logout();

  s1 := pg_temp.send_ppap(org, part1, wayne, cat, dan, current_date - 2);

  -- ---- staff: ask ----
  PERFORM pg_temp.login(bob);
  r := pg_temp.fails(format($f$SELECT app.request_ppap_customer_answer(%L, NULL)$f$, s1));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a viewer cannot ask');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  PERFORM pg_temp.assert_eq((SELECT string_agg(party_name, ',') FROM app.ppap_customer_party(s1)), 'Wayne Ltd', 'the submission is for the customer it was sent to');
  req := app.request_ppap_customer_answer(s1, 'Please approve the submission.');
  r := pg_temp.fails(format($f$SELECT app.request_ppap_customer_answer(%L, NULL)$f$, s1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'one request waits at a time');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.ppap_request_recipients(req)), 1::bigint, 'the customer''s people are emailed');
  PERFORM pg_temp.assert_eq(jsonb_array_length(app.ppap_customer_requests(s1)), 1, 'staff see the request');
  PERFORM pg_temp.logout();

  -- ---- an external person cannot ask or read staff data ----
  PERFORM pg_temp.login(sam);
  r := pg_temp.fails(format($f$SELECT app.request_ppap_customer_answer(%L, NULL)$f$, s1));
  PERFORM pg_temp.assert_eq(r NOT LIKE 'ok%', true, 'an external person cannot ask');
  r := pg_temp.fails(format($f$SELECT app.ppap_customer_requests(%L)$f$, s1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'nor read staff''s list');
  r := pg_temp.fails(format($f$SELECT app.portal_get_ppap(%L)$f$, req));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'a supplier''s person cannot open a customer''s request');
  PERFORM pg_temp.logout();

  -- ---- what the customer sees: named fields only ----
  PERFORM pg_temp.login(cus);
  j := app.portal_get_ppap(req);
  SELECT string_agg(x, ',' ORDER BY x) INTO k FROM jsonb_object_keys(j) x;
  PERFORM pg_temp.assert_eq(k, 'answeredAt,answeredBy,canDecide,contact,decision,decisionExpiresOn,decisionNote,elements,id,interimExpiresOn,level,partName,partNumber,reason,reference,requestNote,requestedAt,revision,sentOn,status,submissionStatus,theirPartNumber,warrant,yourReference', 'the exact keys');
  SELECT string_agg(x, ',' ORDER BY x) INTO k FROM jsonb_object_keys(j -> 'warrant') x;
  PERFORM pg_temp.assert_eq(k, 'declaration,engineeringChangeLevel,partWeight,purchaseOrder,resultsMeetRequirements,signedOn,signerName,signerPhone,signerTitle,weightUnit', 'the warrant''s exact keys');
  SELECT string_agg(x, ',' ORDER BY x) INTO k FROM jsonb_object_keys(j -> 'elements' -> 0) x;
  PERFORM pg_temp.assert_eq(k, 'name,provided,requirement,waived', 'an element shows its name, whether it was provided and nothing behind it');
  PERFORM pg_temp.assert_eq(j ->> 'contact', 'Pat in Quality', 'who to contact');
  PERFORM pg_temp.assert_eq(j ->> 'theirPartNumber', 'W-77', 'their own part number');
  PERFORM pg_temp.assert_eq(j ->> 'partNumber', 'P4-100', 'our part number');
  PERFORM pg_temp.assert_eq(j -> 'warrant' ->> 'signerName', 'Dan Manager', 'the signed warrant');
  PERFORM pg_temp.assert_eq((j ->> 'canDecide')::boolean, true, 'they may answer');
  PERFORM pg_temp.assert_eq(j ->> 'sentOn', to_char(current_date - 2, 'YYYY-MM-DD'), 'when it was sent');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.portal_list_ppaps(org)), 1::bigint, 'it is in their list');
  SELECT string_agg(c, ',' ORDER BY c) INTO k FROM jsonb_object_keys((SELECT to_jsonb(x) FROM app.portal_list_ppaps(org) x)) c;
  PERFORM pg_temp.assert_eq(k, 'answered_at,can_decide,level,part_name,part_number,reference,request_id,requested_at,status,submission_status,their_part_number', 'the list is named fields only');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.portal_ppap_requests), 0::bigint, 'they read no tables');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.ppap_submissions), 0::bigint, 'nor the submissions');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.ppap_decisions), 0::bigint, 'nor the decisions');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cus2);
  r := pg_temp.fails(format($f$SELECT app.portal_get_ppap(%L)$f$, req));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'another customer sees nothing of it');
  r := pg_temp.fails(format($f$SELECT app.portal_decide_ppap(%L, 'approved')$f$, req));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'nor can they answer it');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.portal_list_ppaps(org)), 0::bigint, 'their list is empty');
  PERFORM pg_temp.logout();

  -- ---- the customer answers: the rules are the decision's own ----
  PERFORM pg_temp.login(cus);
  r := pg_temp.fails(format($f$SELECT app.portal_decide_ppap(%L, 'withdrawn')$f$, req));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'only approve, approve for now or reject');
  r := pg_temp.fails(format($f$SELECT app.portal_decide_ppap(%L, 'rejected')$f$, req));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'a rejection needs a reason');
  r := pg_temp.fails(format($f$SELECT app.portal_decide_ppap(%L, 'interim_approved', 'Conditions apply', NULL, NULL)$f$, req));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM037', 'an interim approval needs the day it runs to');
  r := pg_temp.fails(format($f$SELECT app.portal_decide_ppap(%L, 'interim_approved', NULL, NULL, %L)$f$, req, current_date + 90));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'and its conditions');
  r := pg_temp.fails(format($f$SELECT app.portal_decide_ppap(%L, 'approved', NULL, NULL, %L)$f$, req, current_date + 90));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM037', 'an approval has no expiry date');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.ppap_submissions WHERE id = s1) IS NULL, true, 'refusals changed nothing they can see');
  PERFORM app.portal_decide_ppap(req, 'interim_approved', 'Until our line trial is done.', 'WAYNE-INT-1', current_date + 90);
  j := app.portal_get_ppap(req);
  PERFORM pg_temp.assert_eq(j ->> 'status', 'answered', 'the request is answered');
  PERFORM pg_temp.assert_eq(j ->> 'decision', 'interim_approved', 'with their decision');
  PERFORM pg_temp.assert_eq(j ->> 'yourReference', 'WAYNE-INT-1', 'and their reference');
  PERFORM pg_temp.assert_eq((j ->> 'canDecide')::boolean, false, 'it cannot be answered twice');
  r := pg_temp.fails(format($f$SELECT app.portal_decide_ppap(%L, 'approved')$f$, req));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'an answer is final');
  PERFORM pg_temp.logout();
  SELECT * INTO sub FROM public.ppap_submissions WHERE id = s1;
  PERFORM pg_temp.assert_eq(sub.status, 'interim_approved', 'the submission is interim approved');
  SELECT * INTO d FROM public.ppap_decisions WHERE submission_id = s1 AND kind = 'interim_approved';
  PERFORM pg_temp.assert_eq(d.portal_request_id, req, 'the decision names the request');
  PERFORM pg_temp.assert_eq(d.created_by, cus, 'and the person who answered');
  PERFORM pg_temp.assert_eq(d.decided_on, current_date, 'they decided today');
  PERFORM pg_temp.assert_eq(d.expires_on, current_date + 90, 'with its expiry');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.portal_activity WHERE kind = 'ppap_interim' AND record_id = s1 AND record_kind = 'ppap'), 1::bigint, 'staff are told');

  -- ---- asked again once interim; approved with their own reference ----
  PERFORM pg_temp.login(cat);
  req2 := app.request_ppap_customer_answer(s1, NULL);
  PERFORM pg_temp.assert_eq(jsonb_array_length(app.ppap_customer_requests(s1)), 2, 'staff see both');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cus);
  PERFORM app.portal_decide_ppap(req2, 'approved', 'Fine after our trial.', 'WAYNE-PPAP-9');
  PERFORM pg_temp.logout();
  SELECT * INTO sub FROM public.ppap_submissions WHERE id = s1;
  PERFORM pg_temp.assert_eq(sub.status, 'approved', 'approved');
  PERFORM pg_temp.assert_eq(sub.next_review_on, (current_date + interval '12 months')::date, 'and the review date is set as for any approval');
  PERFORM pg_temp.assert_eq((SELECT their_reference FROM public.ppap_decisions WHERE submission_id = s1 AND kind = 'approved'), 'WAYNE-PPAP-9', 'with their reference');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.portal_activity WHERE kind = 'ppap_approved' AND record_id = s1), 1::bigint, 'staff are told');
  PERFORM pg_temp.login(cat);
  r := pg_temp.fails(format($f$SELECT app.request_ppap_customer_answer(%L, NULL)$f$, s1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'no need to ask once approved');
  PERFORM pg_temp.assert_eq(jsonb_array_length(app.ppap_customer_requests(s1)), 2, 'both answered');
  PERFORM pg_temp.assert_eq(app.ppap_customer_requests(s1) -> 0 ->> 'decision', 'approved', 'staff see what the customer said');
  PERFORM pg_temp.logout();

  -- ---- a rejection with a reason ----
  INSERT INTO public.part_customers (organisation_id, part_id, customer_id, is_primary) VALUES (org, part3, wayne, true);
  s3 := pg_temp.send_ppap(org, part3, wayne, cat, dan, current_date - 1);
  PERFORM pg_temp.login(cat); req3 := app.request_ppap_customer_answer(s3, NULL); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cus);
  PERFORM app.portal_decide_ppap(req3, 'rejected', 'The weight is wrong on the warrant.');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT status FROM public.ppap_submissions WHERE id = s3), 'rejected', 'rejected');
  PERFORM pg_temp.assert_eq((SELECT note FROM public.ppap_decisions WHERE submission_id = s3 AND kind = 'rejected'), 'The weight is wrong on the warrant.', 'with their reason');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.portal_activity WHERE kind = 'ppap_rejected' AND record_id = s3), 1::bigint, 'staff are told');

  -- ---- staff recording the answer by hand settles a waiting request ----
  INSERT INTO public.part_customers (organisation_id, part_id, customer_id, is_primary) VALUES (org, part4, wayne, true);
  s4 := pg_temp.send_ppap(org, part4, wayne, cat, dan, current_date - 1);
  PERFORM pg_temp.login(cat); req := app.request_ppap_customer_answer(s4, NULL); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(dan);
  PERFORM app.record_ppap_decision(s4, 'approved', current_date, 'W-BY-HAND');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT status || '|' || withdrawn_reason FROM public.portal_ppap_requests WHERE id = req), 'withdrawn|The decision was recorded by us', 'the waiting request is settled');
  PERFORM pg_temp.assert_eq((SELECT portal_request_id IS NULL FROM public.ppap_decisions WHERE submission_id = s4 AND kind = 'approved'), true, 'the hand-made decision names no request');
  PERFORM pg_temp.login(cus);
  r := pg_temp.fails(format($f$SELECT app.portal_get_ppap(%L)$f$, req));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'a withdrawn request is gone for the customer');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.portal_list_ppaps(org)), 3::bigint, 'and not listed');
  PERFORM pg_temp.logout();

  -- ---- withdrawing a request needs a reason and only a waiting one ----
  INSERT INTO public.part_customers (organisation_id, part_id, customer_id, is_primary) VALUES (org, part5, wayne, true);
  s5 := pg_temp.send_ppap(org, part5, wayne, cat, dan, current_date - 1);
  PERFORM pg_temp.login(cat);
  req := app.request_ppap_customer_answer(s5, NULL);
  r := pg_temp.fails(format($f$SELECT app.withdraw_ppap_customer_request(%L, 'x')$f$, req));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'a withdrawal needs a reason');
  PERFORM app.withdraw_ppap_customer_request(req, 'Raised too early');
  r := pg_temp.fails(format($f$SELECT app.withdraw_ppap_customer_request(%L, 'Again for no reason')$f$, req));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'only a waiting request can be withdrawn');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.ppap_submissions WHERE id = s5), 'submitted', 'withdrawing the request changes nothing on the submission');
  req := app.request_ppap_customer_answer(s5, NULL);
  PERFORM pg_temp.assert_eq(jsonb_array_length(app.ppap_customer_requests(s5)), 2, 'it can be asked again');
  PERFORM pg_temp.logout();

  -- ---- a hand-made decision does not let the customer answer after it: a withdrawn submission no longer needs an answer ----
  PERFORM pg_temp.login(dan);
  PERFORM app.withdraw_ppap(s5, 'Sent to the wrong customer');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cus);
  r := pg_temp.fails(format($f$SELECT app.portal_decide_ppap(%L, 'approved')$f$, req));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'a withdrawn submission needs no answer');
  PERFORM pg_temp.assert_eq((app.portal_get_ppap(req) ->> 'canDecide')::boolean, false, 'and says so');
  PERFORM pg_temp.logout();

  -- ---- frozen ----
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($f$DELETE FROM public.portal_ppap_requests WHERE id = %L$f$, req2)) LIKE 'QM032%', true, 'never deleted');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($f$UPDATE public.portal_ppap_requests SET status = 'pending', answered_at = NULL, answered_by = NULL, decision_id = NULL WHERE id = %L$f$, req2)) LIKE 'QM032%', true, 'an answered request does not change');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($f$INSERT INTO public.ppap_decisions (organisation_id, submission_id, seq, kind, decided_on) VALUES (%L, %L, 99, 'approved', current_date)$f$, org, s5)) LIKE 'QM037%', true, 'a decision cannot be slipped in by hand');
END $$;
ROLLBACK;
