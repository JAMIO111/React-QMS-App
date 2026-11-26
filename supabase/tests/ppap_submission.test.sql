-- PPAP PP3: the warrant (typed, signed by someone who did not prepare it, frozen), submitting (everything frozen, one transaction), the customer's decision (events, status worked out
-- only through them), withdrawing what was sent, resubmitting, the periodic review; and the rules the tables hold even for SQL.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('50000000-0000-0000-0000-000000000e01', 'ann@ps.test'), ('50000000-0000-0000-0000-000000000e02', 'bob@ps.test'),
  ('50000000-0000-0000-0000-000000000e03', 'cat@ps.test'), ('50000000-0000-0000-0000-000000000e04', 'dan@ps.test'),
  ('50000000-0000-0000-0000-000000000e05', 'eve@ps.test'), ('50000000-0000-0000-0000-000000000e06', 'fay@ps.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '50000000-0000-0000-0000-000000000e01'; bob uuid := '50000000-0000-0000-0000-000000000e02';
  cat uuid := '50000000-0000-0000-0000-000000000e03'; dan uuid := '50000000-0000-0000-0000-000000000e04';
  eve uuid := '50000000-0000-0000-0000-000000000e05'; fay uuid := '50000000-0000-0000-0000-000000000e06';
  org uuid; org2 uuid; u uuid; part uuid; part2 uuid; part3 uuid; rev uuid; rev2 uuid; rev3 uuid; cust uuid; s1 uuid; s2 uuid; s3 uuid; s4 uuid; s5 uuid; s6 uuid; s_new uuid; r jsonb; t text; probs text[];
  e_psw uuid; e_design uuid; n integer; w public.ppap_psw%ROWTYPE; sub public.ppap_submissions%ROWTYPE; d_id uuid;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('PS Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('PS Beta'); PERFORM pg_temp.logout();
  -- Bob: viewer. Cat: quality engineer (prepares). Dan and Fay: quality managers (approve).
  FOREACH u IN ARRAY ARRAY[bob, cat, dan, fay] LOOP
    INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u, 'active');
  END LOOP;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = CASE WHEN ou.user_id IN (dan, fay) THEN 'quality_manager' WHEN ou.user_id = bob THEN 'viewer' ELSE 'quality_engineer' END)
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id IN (bob, cat, dan, fay);
  UPDATE public.profiles SET first_name = 'Dan', surname = 'Manager' WHERE id = dan;
  UPDATE public.profiles SET first_name = 'Fay', surname = 'Approver' WHERE id = fay;
  UPDATE public.profiles SET first_name = NULL, surname = NULL WHERE id = bob;

  PERFORM pg_temp.login(ann);
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'PS-P1', 'Bracket') RETURNING id INTO part;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'PS-P2', 'Housing') RETURNING id INTO part2;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'PS-P3', 'Clip') RETURNING id INTO part3;
  INSERT INTO public.part_revisions (organisation_id, part_id, revision) VALUES (org, part, 'A') RETURNING id INTO rev;
  UPDATE public.part_revisions SET status = 'released' WHERE id = rev;
  INSERT INTO public.part_revisions (organisation_id, part_id, revision) VALUES (org, part2, 'A') RETURNING id INTO rev2;
  UPDATE public.part_revisions SET status = 'released' WHERE id = rev2;
  INSERT INTO public.part_revisions (organisation_id, part_id, revision) VALUES (org, part3, 'A') RETURNING id INTO rev3;
  UPDATE public.part_revisions SET status = 'released' WHERE id = rev3;
  INSERT INTO public.customers (organisation_id, code, name) VALUES (org, 'PS-C1', 'Acme Motors') RETURNING id INTO cust;
  PERFORM pg_temp.logout();

  -- Level 1 for this customer: only the warrant is required, so the warrant is what these tests are about.
  PERFORM pg_temp.login(dan);
  PERFORM app.set_ppap_customer_rules(cust, '{"defaultLevel":1}'::jsonb);
  PERFORM pg_temp.logout();

  -- ---- the warrant is typed, then signed by someone else ----
  PERFORM pg_temp.login(cat);
  r := app.create_ppap(org, jsonb_build_object('partId', part, 'customerId', cust, 'reason', 'new_part'));
  s1 := (r ->> 'id')::uuid;
  SELECT id INTO e_psw FROM public.ppap_elements WHERE submission_id = s1 AND element_key = 'part_submission_warrant';
  probs := app.ppap_problems(s1);
  PERFORM pg_temp.assert_eq(probs[1] LIKE 'Part Submission Warrant: fill it in%', true, 'a submission with no warrant is told to fill it in');
  PERFORM pg_temp.assert_eq(cardinality(probs), 1, 'and that is all it needs at level 1');
  t := pg_temp.fails(format('SELECT app.mark_ppap_ready(%L)', s1));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'it cannot be marked ready without the warrant');
  t := pg_temp.fails(format($q$SELECT app.save_ppap_psw(%L, '{"nonsense": 1}'::jsonb)$q$, s1));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'an unknown field is refused');
  t := pg_temp.fails(format($q$SELECT app.save_ppap_psw(%L, '{"partWeight": -2}'::jsonb)$q$, s1));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'a weight must be more than zero');
  t := pg_temp.fails(format($q$SELECT app.save_ppap_psw(%L, '{"partWeight": 2, "weightUnit": "stone"}'::jsonb)$q$, s1));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'and in a known unit');
  PERFORM app.save_ppap_psw(s1, '{"partWeight": 1.25, "weightUnit": "kg", "purchaseOrder": "PO-77", "engineeringChangeLevel": "EC-3"}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT prepared_by FROM public.ppap_psw WHERE submission_id = s1), cat, 'the last person to save it prepared it');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.ppap_elements WHERE id = e_psw), 'in_progress', 'saving starts the warrant element');
  probs := app.ppap_problems(s1);
  PERFORM pg_temp.assert_eq(probs[1] LIKE 'Part Submission Warrant: fill in whether the results meet the requirements%', true, 'it still needs the results answer');
  t := pg_temp.fails(format('SELECT app.sign_ppap_psw(%L, %L)', s1, 'Quality Engineer'));
  PERFORM pg_temp.assert_eq(left(t, 5), '42501', 'someone without approval rights cannot sign');
  PERFORM app.save_ppap_psw(s1, '{"resultsMeetRequirements": false}'::jsonb);
  probs := app.ppap_problems(s1);
  PERFORM pg_temp.assert_eq(probs[1] LIKE '%what does not meet them%', true, 'results that do not meet the requirements need saying what');
  PERFORM app.save_ppap_psw(s1, '{"resultsMeetRequirements": true, "declaration": null}'::jsonb);
  probs := app.ppap_problems(s1);
  PERFORM pg_temp.assert_eq(probs[1] LIKE '%ask an approver who did not prepare%', true, 'a complete warrant waits for a signature');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login(bob);
  t := pg_temp.fails(format('SELECT app.sign_ppap_psw(%L, %L)', s1, 'Viewer'));
  PERFORM pg_temp.assert_eq(left(t, 5), '42501', 'a viewer cannot sign');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve);
  t := pg_temp.fails(format('SELECT app.sign_ppap_psw(%L, %L)', s1, 'Outsider'));
  PERFORM pg_temp.assert_eq(left(t, 5), 'P0002', 'another organisation cannot sign it');
  t := pg_temp.fails(format($q$SELECT app.save_ppap_psw(%L, '{"partWeight": 3}'::jsonb)$q$, s1));
  PERFORM pg_temp.assert_eq(left(t, 5), 'P0002', 'nor change it');
  PERFORM pg_temp.logout();

  -- Dan prepared nothing here, so he can sign
  PERFORM pg_temp.login(dan);
  t := pg_temp.fails(format('SELECT app.sign_ppap_psw(%L, NULL)', s1));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'a title is needed to sign');
  PERFORM app.sign_ppap_psw(s1, 'Quality Manager', '01234 567890');
  SELECT * INTO w FROM public.ppap_psw WHERE submission_id = s1;
  PERFORM pg_temp.assert_eq(w.signer_name, 'Dan Manager', 'the signer''s name comes from their profile, not from what they type');
  PERFORM pg_temp.assert_eq(w.signer_title || '/' || w.signer_phone, 'Quality Manager/01234 567890', 'with their title and phone');
  PERFORM pg_temp.assert_eq(w.signed_on, current_date, 'and the day');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.ppap_elements WHERE id = e_psw), 'ready', 'signing makes the warrant element ready');
  PERFORM pg_temp.assert_eq(cardinality(app.ppap_problems(s1)), 0, 'nothing is needed once it is signed');
  t := pg_temp.fails(format('SELECT app.sign_ppap_psw(%L, %L)', s1, 'Again'));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'it is signed once');
  PERFORM pg_temp.logout();

  -- the typed fields are frozen by the signature
  PERFORM pg_temp.login(cat);
  t := pg_temp.fails(format($q$SELECT app.save_ppap_psw(%L, '{"partWeight": 9}'::jsonb)$q$, s1));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'a signed warrant cannot be changed');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.ppap_psw SET part_weight = 9 WHERE submission_id = %L$q$, s1), 'not even by SQL');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.ppap_psw SET signer_name = 'Someone Else' WHERE submission_id = %L$q$, s1), 'and the signature cannot be rewritten by hand');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.ppap_psw SET signed_at = NULL, signer_user_id = NULL, signer_name = NULL, signed_on = NULL WHERE submission_id = %L$q$, s1), 'or removed by hand');
  PERFORM pg_temp.assert_fails(format($q$DELETE FROM public.ppap_psw WHERE submission_id = %L$q$, s1), 'a warrant is never deleted');

  -- unsigning: an approver, with a reason, while still being prepared
  PERFORM pg_temp.login(cat);
  t := pg_temp.fails(format('SELECT app.unsign_ppap_psw(%L, %L)', s1, 'Wrong weight'));
  PERFORM pg_temp.assert_eq(left(t, 5), '42501', 'only an approver takes a signature off');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(fay);
  t := pg_temp.fails(format('SELECT app.unsign_ppap_psw(%L, %L)', s1, 'x'));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'with a reason');
  PERFORM app.unsign_ppap_psw(s1, 'Wrong weight, to be corrected');
  SELECT * INTO w FROM public.ppap_psw WHERE submission_id = s1;
  PERFORM pg_temp.assert_eq(w.signed_at IS NULL AND w.signer_name IS NULL, true, 'the signature is gone');
  PERFORM pg_temp.assert_eq(w.unsign_reason, 'Wrong weight, to be corrected', 'with who took it off and why');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.ppap_elements WHERE id = e_psw), 'in_progress', 'and the element is no longer ready');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  PERFORM app.save_ppap_psw(s1, '{"partWeight": 1.5}'::jsonb);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(fay);
  PERFORM app.sign_ppap_psw(s1, 'Approver');
  PERFORM pg_temp.logout();

  -- ---- the signer is never the preparer ----
  PERFORM pg_temp.login(dan);
  r := app.create_ppap(org, jsonb_build_object('partId', part2, 'customerId', cust, 'reason', 'new_part'));
  s2 := (r ->> 'id')::uuid;
  PERFORM app.save_ppap_psw(s2, '{"partWeight": 2, "resultsMeetRequirements": true}'::jsonb);
  t := pg_temp.fails(format('SELECT app.sign_ppap_psw(%L, %L)', s2, 'Quality Manager'));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'the owner who created and prepared it cannot sign it');
  PERFORM pg_temp.assert_eq(t LIKE '%someone else%', true, 'and is told why');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(fay);
  PERFORM app.sign_ppap_psw(s2, 'Approver');
  PERFORM pg_temp.assert_eq((SELECT signer_name FROM public.ppap_psw WHERE submission_id = s2), 'Fay Approver', 'a different approver can');
  PERFORM pg_temp.logout();
  -- someone who last saved the typed fields has prepared it, even if they are not the owner
  PERFORM pg_temp.login(cat);
  r := app.create_ppap(org, jsonb_build_object('partId', part3, 'customerId', cust, 'reason', 'new_part', 'ownerId', cat));
  s3 := (r ->> 'id')::uuid;
  PERFORM app.save_ppap_psw(s3, '{"partWeight": 2, "resultsMeetRequirements": true}'::jsonb);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(dan);
  PERFORM app.save_ppap_psw(s3, '{"partWeight": 2.5}'::jsonb);
  t := pg_temp.fails(format('SELECT app.sign_ppap_psw(%L, %L)', s3, 'Quality Manager'));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'an approver who last saved the fields has prepared it');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(fay);
  PERFORM app.sign_ppap_psw(s3, 'Approver');
  PERFORM pg_temp.logout();
  -- a person with no name on their profile cannot sign
  PERFORM pg_temp.login(cat);
  r := app.create_ppap(org, jsonb_build_object('partId', part, 'customerId', cust, 'reason', 'tooling'));
  s4 := (r ->> 'id')::uuid;
  PERFORM app.save_ppap_psw(s4, '{"partWeight": 1, "resultsMeetRequirements": true}'::jsonb);
  PERFORM pg_temp.logout();

  -- ---- submitting ----
  PERFORM pg_temp.login(dan);
  t := pg_temp.fails(format('SELECT app.submit_ppap(%L)', s1));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'a submission that is not ready cannot be submitted');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  PERFORM app.mark_ppap_ready(s1);
  t := pg_temp.fails(format('SELECT app.submit_ppap(%L, %L)', s1, current_date + 1));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'it cannot be sent in the future');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(bob);
  t := pg_temp.fails(format('SELECT app.submit_ppap(%L)', s1));
  PERFORM pg_temp.assert_eq(left(t, 5), '42501', 'a viewer cannot submit');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  PERFORM app.submit_ppap(s1, (current_date - 2), 'Customer portal', 'Sent with the covering letter');
  SELECT * INTO sub FROM public.ppap_submissions WHERE id = s1;
  PERFORM pg_temp.assert_eq(sub.status, 'submitted', 'the status moves to submitted');
  PERFORM pg_temp.assert_eq(sub.submitted_by, cat, 'with who sent it');
  PERFORM pg_temp.assert_eq((SELECT kind || '/' || how || '/' || decided_on::text || '/' || seq::text FROM public.ppap_decisions WHERE submission_id = s1), 'submitted/Customer portal/' || (current_date - 2)::text || '/1', 'and the sending is the first decision');
  PERFORM pg_temp.assert_eq((SELECT frozen_at IS NOT NULL FROM public.ppap_psw WHERE submission_id = s1), true, 'the warrant is frozen');
  t := pg_temp.fails(format('SELECT app.submit_ppap(%L)', s1));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'it is sent once');
  t := pg_temp.fails(format($q$SELECT app.save_ppap_psw(%L, '{"partWeight": 4}'::jsonb)$q$, s1));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'a sent submission''s warrant cannot be changed');
  t := pg_temp.fails(format('SELECT app.update_ppap(%L, %L)', s1, '{"notes":"x"}'));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'nor the submission itself');
  PERFORM pg_temp.logout();
  -- the status never moves by hand, even for SQL
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.ppap_submissions SET status = 'approved' WHERE id = %L$q$, s1), 'a decision is recorded, not typed into the status');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.ppap_submissions SET status = 'submitted', submitted_at = now() WHERE id = %L$q$, s4), 'neither can a submission be marked sent by hand');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.ppap_submissions SET status = 'withdrawn', withdraw_reason = 'x tidy', withdrawn_at = now() WHERE id = %L$q$, s1), 'nor one that was sent withdrawn by hand');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.ppap_submissions SET next_review_on = current_date WHERE id = %L$q$, s1), 'nor the review date moved');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.ppap_psw SET frozen_at = NULL WHERE submission_id = %L$q$, s1), 'a frozen warrant cannot be thawed');

  -- ---- the customer's decision ----
  PERFORM pg_temp.login(cat);
  t := pg_temp.fails(format('SELECT app.record_ppap_decision(%L, %L, %L)', s1, 'approved', current_date));
  PERFORM pg_temp.assert_eq(left(t, 5), '42501', 'recording the customer''s decision needs approval rights');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(dan);
  t := pg_temp.fails(format('SELECT app.record_ppap_decision(%L, %L, %L)', s1, 'withdrawn', current_date));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'only approved, interim or rejected are the customer''s decisions');
  t := pg_temp.fails(format('SELECT app.record_ppap_decision(%L, %L, %L)', s1, 'approved', current_date + 1));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'not in the future');
  t := pg_temp.fails(format('SELECT app.record_ppap_decision(%L, %L, %L)', s1, 'approved', current_date - 3));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'not before it was sent');
  t := pg_temp.fails(format('SELECT app.record_ppap_decision(%L, %L, %L)', s1, 'interim_approved', current_date - 1));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'an interim approval needs its expiry');
  t := pg_temp.fails(format('SELECT app.record_ppap_decision(%L, %L, %L, NULL, %L, NULL)', s1, 'interim_approved', current_date - 1, current_date + 30));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'and its conditions');
  t := pg_temp.fails(format('SELECT app.record_ppap_decision(%L, %L, %L, NULL, %L, %L)', s1, 'interim_approved', current_date - 1, current_date - 1, 'Until the gauge study is done'));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'the expiry is after the day it was given');
  t := pg_temp.fails(format('SELECT app.record_ppap_decision(%L, %L, %L)', s1, 'rejected', current_date - 1));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'a rejection needs the reason');
  t := pg_temp.fails(format('SELECT app.record_ppap_decision(%L, %L, %L, NULL, %L)', s1, 'approved', current_date - 1, current_date + 10));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'only an interim approval has an expiry');
  t := pg_temp.fails(format($q$SELECT app.record_ppap_decision(%L, %L, %L, NULL, NULL, NULL, %L, 'psw.pdf', 'application/pdf', 10)$q$, s1, 'approved', current_date - 1, org || '/ppap/' || s2 || '/psw.pdf'));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'their file must be in this submission''s folder');
  PERFORM app.record_ppap_decision(s1, 'interim_approved', current_date - 1, 'ACME-INT-1', current_date + 30, 'Until the gauge study is done');
  SELECT * INTO sub FROM public.ppap_submissions WHERE id = s1;
  PERFORM pg_temp.assert_eq(sub.status, 'interim_approved', 'the status follows the decision');
  PERFORM pg_temp.assert_eq((SELECT their_reference || '/' || expires_on::text || '/' || seq::text FROM public.ppap_decisions WHERE submission_id = s1 AND kind = 'interim_approved'), 'ACME-INT-1/' || (current_date + 30)::text || '/2', 'with their reference and expiry');
  t := pg_temp.fails(format('SELECT app.record_ppap_decision(%L, %L, %L, NULL, %L, %L)', s1, 'interim_approved', current_date, current_date + 20, 'Shorter'));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'a new interim approval must run later than the one before');
  PERFORM app.record_ppap_decision(s1, 'interim_approved', current_date, 'ACME-INT-2', current_date + 60, 'Extended while the study completes');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.ppap_decisions WHERE submission_id = s1), 3::bigint, 'an extension is another decision, not an edit');
  PERFORM app.record_ppap_decision(s1, 'approved', current_date, 'ACME-OK-9', NULL, NULL, org || '/ppap/' || s1 || '/psw-signed.pdf', 'psw-signed.pdf', 'application/pdf', 1234);
  SELECT * INTO sub FROM public.ppap_submissions WHERE id = s1;
  PERFORM pg_temp.assert_eq(sub.status, 'approved', 'approved at last');
  PERFORM pg_temp.assert_eq(sub.next_review_on, (current_date + interval '12 months')::date, 'and a review is due in a year');
  PERFORM pg_temp.assert_eq((SELECT file_name FROM public.ppap_decisions WHERE submission_id = s1 AND kind = 'approved'), 'psw-signed.pdf', 'their signed warrant is kept with the decision');
  t := pg_temp.fails(format('SELECT app.record_ppap_decision(%L, %L, %L)', s1, 'rejected', current_date));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'approved is final');
  PERFORM pg_temp.logout();
  -- decisions are frozen, even for SQL
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.ppap_decisions SET their_reference = 'edited' WHERE submission_id = %L$q$, s1), 'a recorded decision is never edited');
  PERFORM pg_temp.assert_fails(format($q$DELETE FROM public.ppap_decisions WHERE submission_id = %L$q$, s1), 'or deleted');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.ppap_decisions (organisation_id, submission_id, seq, kind, decided_on) VALUES (%L, %L, 9, 'approved', current_date)$q$, org, s4), 'a decision cannot be inserted by hand either');
  PERFORM pg_temp.login(cat);
  PERFORM pg_temp.assert_eq(pg_temp.count_rows(format('SELECT 1 FROM public.ppap_decisions WHERE submission_id = %L', s1)), 4::bigint, 'readers see every decision');
  PERFORM pg_temp.logout();

  -- ---- a rejected one, and resubmitting it ----
  PERFORM pg_temp.login(fay);
  PERFORM app.sign_ppap_psw(s4, 'Approver');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  t := pg_temp.fails(format('SELECT app.start_ppap_resubmission(%L)', s4));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'one that was never sent cannot be resubmitted');
  PERFORM app.mark_ppap_ready(s4);
  PERFORM app.submit_ppap(s4);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(dan);
  PERFORM app.record_ppap_decision(s4, 'rejected', current_date, 'ACME-REJ-1', NULL, 'Dimensional results were missing');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.ppap_submissions WHERE id = s4), 'rejected', 'rejected');
  PERFORM pg_temp.assert_eq((SELECT next_review_on IS NULL FROM public.ppap_submissions WHERE id = s4), true, 'a rejected one has no review');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(bob);
  t := pg_temp.fails(format('SELECT app.start_ppap_resubmission(%L)', s4));
  PERFORM pg_temp.assert_eq(left(t, 5), '42501', 'a viewer cannot resubmit');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  t := pg_temp.fails(format($q$SELECT app.start_ppap_resubmission(%L, '{"customerId": "%s"}'::jsonb)$q$, s4, gen_random_uuid()));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'the customer cannot be changed on a resubmission');
  r := app.start_ppap_resubmission(s4);
  s_new := (r ->> 'id')::uuid;
  SELECT * INTO sub FROM public.ppap_submissions WHERE id = s_new;
  PERFORM pg_temp.assert_eq(sub.replaces_id, s4, 'the new submission names the one it replaces');
  PERFORM pg_temp.assert_eq(sub.status, 'draft', 'and starts as a draft');
  PERFORM pg_temp.assert_eq((SELECT part_weight FROM public.ppap_psw WHERE submission_id = s_new), 1::numeric, 'the warrant''s typed fields are carried over');
  PERFORM pg_temp.assert_eq((SELECT signed_at IS NULL FROM public.ppap_psw WHERE submission_id = s_new), true, 'but not the signature');
  PERFORM pg_temp.assert_eq((SELECT prepared_by FROM public.ppap_psw WHERE submission_id = s_new), cat, 'the person who started it prepared it');
  probs := app.ppap_problems(s_new);
  PERFORM pg_temp.assert_eq(probs[1] LIKE '%ask an approver who did not prepare%', true, 'and it waits for a signature again');
  t := pg_temp.fails(format('SELECT app.start_ppap_resubmission(%L)', s4));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'the same reason cannot be started twice while one is live');
  t := pg_temp.fails(format($q$SELECT app.create_ppap(%L, jsonb_build_object('partId', %L, 'customerId', %L, 'reason', 'other', 'replacesId', %L))$q$, org, part2, cust, s4));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'a submission of another part cannot claim to replace it');
  t := pg_temp.fails(format($q$SELECT app.create_ppap(%L, jsonb_build_object('partId', %L, 'customerId', %L, 'reason', 'other', 'replacesId', %L))$q$, org, part, cust, s_new));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'a draft cannot be replaced');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.ppap_submissions SET replaces_id = %L WHERE id = %L$q$, s1, s_new), 'what a submission replaces never changes');

  -- ---- withdrawing: before sending a manager, after sending an approver ----
  PERFORM pg_temp.login(cat);
  PERFORM app.withdraw_ppap(s_new, 'Not needed after all');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.ppap_submissions WHERE id = s_new), 'withdrawn', 'an unsent submission is withdrawn by a manager');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.ppap_decisions WHERE submission_id = s_new), 0::bigint, 'with nothing recorded as a decision');
  r := app.create_ppap(org, jsonb_build_object('partId', part3, 'customerId', cust, 'reason', 'process_change', 'ownerId', cat));
  s5 := (r ->> 'id')::uuid;
  PERFORM app.save_ppap_psw(s5, '{"partWeight": 3, "resultsMeetRequirements": true}'::jsonb);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(fay);
  PERFORM app.sign_ppap_psw(s5, 'Approver');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  PERFORM app.mark_ppap_ready(s5);
  PERFORM app.submit_ppap(s5);
  t := pg_temp.fails(format('SELECT app.withdraw_ppap(%L, %L)', s5, 'Pulled back'));
  PERFORM pg_temp.assert_eq(left(t, 5), '42501', 'once sent, only an approver withdraws it');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(dan);
  t := pg_temp.fails(format('SELECT app.withdraw_ppap(%L, %L)', s5, 'x'));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'with a reason');
  PERFORM app.withdraw_ppap(s5, 'The customer cancelled the programme');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.ppap_submissions WHERE id = s5), 'withdrawn', 'withdrawn');
  PERFORM pg_temp.assert_eq((SELECT kind || '/' || note FROM public.ppap_decisions WHERE submission_id = s5 ORDER BY seq DESC LIMIT 1), 'withdrawn/The customer cancelled the programme', 'and recorded as a decision');
  t := pg_temp.fails(format('SELECT app.withdraw_ppap(%L, %L)', s1, 'Too late'));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'an approved submission cannot be withdrawn');
  PERFORM pg_temp.logout();
  -- a withdrawn-after-sending one can be resubmitted
  PERFORM pg_temp.login(cat);
  r := app.start_ppap_resubmission(s5, '{"reason": "customer_request"}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT replaces_id FROM public.ppap_submissions WHERE id = (r ->> 'id')::uuid), s5, 'one withdrawn after it was sent can be replaced');
  PERFORM pg_temp.logout();

  -- ---- reviewing an approved submission ----
  PERFORM pg_temp.login(bob);
  t := pg_temp.fails(format('SELECT app.record_ppap_review(%L, %L)', s1, 'Checked'));
  PERFORM pg_temp.assert_eq(left(t, 5), '42501', 'a viewer cannot record a review');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  t := pg_temp.fails(format('SELECT app.record_ppap_review(%L, %L)', s5, 'Checked'));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'only an approved submission is reviewed');
  t := pg_temp.fails(format('SELECT app.record_ppap_review(%L, NULL)', s1));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'a review says what was checked');
  t := pg_temp.fails(format('SELECT app.record_ppap_review(%L, %L, %L)', s1, 'Checked', current_date));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'the next review is after today');
  t := pg_temp.fails(format('SELECT app.record_ppap_review(%L, %L, %L)', s1, 'Checked', current_date + 3000));
  PERFORM pg_temp.assert_eq(left(t, 5), 'QM037', 'and within five years');
  PERFORM app.record_ppap_review(s1, 'Process unchanged, studies still current', current_date + 200);
  PERFORM pg_temp.assert_eq((SELECT next_review_on FROM public.ppap_submissions WHERE id = s1), current_date + 200, 'the review moves the next date');
  PERFORM pg_temp.assert_eq((SELECT outcome FROM public.ppap_reviews WHERE submission_id = s1), 'no_change', 'and is kept');
  r := app.start_ppap_resubmission(s1, '{"reason": "engineering_change"}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.ppap_reviews WHERE submission_id = s1 AND outcome = 'resubmission_started' AND new_submission_id = (r ->> 'id')::uuid), 1::bigint, 'revalidating an approved one is recorded as a review of it');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.ppap_reviews SET note = 'edited' WHERE submission_id = %L$q$, s1), 'a review is never edited');
  PERFORM pg_temp.assert_fails(format($q$DELETE FROM public.ppap_reviews WHERE submission_id = %L$q$, s1), 'or deleted');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.ppap_reviews (organisation_id, submission_id, outcome, note, next_review_on) VALUES (%L, %L, 'no_change', 'by hand', current_date + 1)$q$, org, s1), 'and cannot be written by hand');

  -- ---- shape rules the tables hold even for SQL ----
  PERFORM pg_temp.login(cat);
  s6 := (app.create_ppap(org, jsonb_build_object('partId', part2, 'customerId', cust, 'reason', 'discrepancy_correction')) ->> 'id')::uuid;
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.ppap_psw SET part_weight = 5 WHERE submission_id = %L$q$, s5), 'a frozen warrant takes no typed change');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.ppap_psw (organisation_id, submission_id, part_weight, weight_unit, signed_at, signer_user_id, signer_name, signed_on)
    VALUES (%L, %L, 1, 'kg', now(), %L, 'Forged', current_date)$q$, org, s6, dan), 'a warrant cannot be made already signed');

  -- ---- who can read what ----
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq(pg_temp.count_rows(format('SELECT 1 FROM public.ppap_decisions WHERE submission_id = %L', s1)), 4::bigint, 'a viewer reads the decisions of a submission that was sent');
  PERFORM pg_temp.assert_eq(pg_temp.count_rows(format('SELECT 1 FROM public.ppap_psw WHERE submission_id = %L', s4)), 1::bigint, 'and its warrant');
  PERFORM pg_temp.assert_eq(pg_temp.count_rows(format('SELECT 1 FROM public.ppap_psw WHERE submission_id = %L', s3)), 0::bigint, 'but not one that is still being prepared');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve);
  PERFORM pg_temp.assert_eq(pg_temp.count_rows('SELECT 1 FROM public.ppap_decisions'), 0::bigint, 'another organisation sees no decisions');
  PERFORM pg_temp.assert_eq(pg_temp.count_rows('SELECT 1 FROM public.ppap_psw'), 0::bigint, 'no warrants');
  PERFORM pg_temp.assert_eq(pg_temp.count_rows('SELECT 1 FROM public.ppap_reviews'), 0::bigint, 'no reviews');
  t := pg_temp.fails(format('SELECT app.record_ppap_decision(%L, %L, %L)', s5, 'approved', current_date));
  PERFORM pg_temp.assert_eq(left(t, 5), 'P0002', 'and cannot record a decision on ours');
  t := pg_temp.fails(format('SELECT app.start_ppap_resubmission(%L)', s4));
  PERFORM pg_temp.assert_eq(left(t, 5), 'P0002', 'nor resubmit one');
  PERFORM pg_temp.logout();

  -- ---- who can run the internals ----
  PERFORM pg_temp.login(dan);
  t := pg_temp.fails(format('SELECT app.ppap_next_seq(%L)', s1));
  PERFORM pg_temp.assert_eq(left(t, 5), '42501', 'the decision counter is not callable by a person');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
