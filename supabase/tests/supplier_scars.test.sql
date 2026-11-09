-- Supplier Quality SQ3: SCARs — idempotent creation, links to the supplier's own NCs, the ten statuses and their transitions, separate append-only response / review /
-- implementation / verification records, closing only on an effective verification, due-date extensions, tenant isolation.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('3f000000-0000-0000-0000-000000000a01', 'ann@scar.test'), ('3f000000-0000-0000-0000-000000000a02', 'bob@scar.test'), ('3f000000-0000-0000-0000-000000000a03', 'cat@scar.test'),
  ('3f000000-0000-0000-0000-000000000a04', 'dan@scar.test'), ('3f000000-0000-0000-0000-000000000a05', 'eve@scar.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '3f000000-0000-0000-0000-000000000a01'; bob uuid := '3f000000-0000-0000-0000-000000000a02'; cat uuid := '3f000000-0000-0000-0000-000000000a03';
  dan uuid := '3f000000-0000-0000-0000-000000000a04'; eve uuid := '3f000000-0000-0000-0000-000000000a05';
  org uuid; org2 uuid; s uuid; s2 uuid; sb uuid; m uuid; role_id uuid; contact uuid; contact2 uuid; nc1 uuid; nc2 uuid; nc_other uuid; nc_cancel uuid; nc_foreign uuid;
  c1 uuid; c2 uuid; c3 uuid; ext1 uuid; ext2 uuid; ext3 uuid; ext4 uuid; p1 uuid; p2 uuid; lot1 uuid; lot_other uuid; item1 uuid; r jsonb; link1 uuid; link2 uuid; resp uuid; resp2 uuid; due date := current_date + 14;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('SCAR Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('SCAR Beta'); PERFORM pg_temp.logout();
  FOREACH m IN ARRAY ARRAY[bob, cat, dan] LOOP
    INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, m, 'active');
    SELECT id INTO role_id FROM public.roles WHERE organisation_id = org AND key = CASE m WHEN bob THEN 'viewer' WHEN cat THEN 'quality_manager' ELSE 'quality_engineer' END;
    INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, ou.id, role_id FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id = m;
  END LOOP;

  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'ACME', 'Acme Metals') RETURNING id INTO s;
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'BOLT', 'Bolt Co') RETURNING id INTO s2;
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org2, 'BETA', 'Beta Ltd') RETURNING id INTO sb;
  INSERT INTO public.supplier_contacts (organisation_id, supplier_id, name) VALUES (org, s, 'Quality contact') RETURNING id INTO contact;
  INSERT INTO public.supplier_contacts (organisation_id, supplier_id, name) VALUES (org, s2, 'Other contact') RETURNING id INTO contact2;
  PERFORM pg_temp.login(dan);
  INSERT INTO public.nonconformances (organisation_id, source, title, description, severity, quantity_affected, supplier_id) VALUES (org, 'supplier', 'Bent bracket', 'x', 'major', 3, s) RETURNING id INTO nc1;
  INSERT INTO public.nonconformances (organisation_id, source, title, description, severity, quantity_affected, supplier_id) VALUES (org, 'supplier', 'Wrong finish', 'x', 'minor', 1, s) RETURNING id INTO nc2;
  INSERT INTO public.nonconformances (organisation_id, source, title, description, severity, quantity_affected, supplier_id) VALUES (org, 'supplier', 'Other supplier', 'x', 'minor', 1, s2) RETURNING id INTO nc_other;
  INSERT INTO public.nonconformances (organisation_id, source, title, description, severity, quantity_affected, supplier_id, category_id) VALUES (org, 'supplier', 'To cancel', 'x', 'minor', 1, s, pg_temp.cat(org)) RETURNING id INTO nc_cancel;
  UPDATE public.nonconformances SET stage = 'cancelled', stage_reason = 'Raised in error' WHERE id = nc_cancel;
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve);
  INSERT INTO public.nonconformances (organisation_id, source, title, description, severity, quantity_affected, supplier_id) VALUES (org2, 'supplier', 'Foreign', 'x', 'minor', 1, sb) RETURNING id INTO nc_foreign;
  PERFORM pg_temp.logout();

  -- ---- the backfill of the SQ3e migration (fixture loaded before it) ----
  PERFORM pg_temp.assert_eq((SELECT (status, decided_at IS NOT NULL, decision_note IS NOT NULL)::text FROM public.supplier_scar_extensions WHERE reason = 'Fixture extension'), '(approved,t,t)', 'an extension from before approvals is kept as approved');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.supplier_scars WHERE reference = 'SCAR-FIX-0001'), 1::bigint, 'and its SCAR is intact');

  -- ---- who may do what ----
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_supplier_scar(%L, 'Viewer SCAR', NULL, 'minor', NULL, NULL, NULL, NULL, NULL)$f$, s)), 5), '42501', 'a viewer cannot raise a SCAR');
  PERFORM pg_temp.assert_fails(format($f$INSERT INTO public.supplier_scars (organisation_id, reference, supplier_id, title) VALUES (%L, 'X', %L, 'Direct')$f$, org, s), 'SCARs are written only through functions');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login(dan);
  -- ---- creating: idempotent, validated, numbered ----
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_supplier_scar(%L, 'ab', NULL, 'minor', NULL, NULL, NULL, NULL, NULL)$f$, s)), 5), 'QM020', 'a title is needed');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_supplier_scar(%L, 'Past due', NULL, 'minor', current_date - 1, NULL, NULL, NULL, NULL)$f$, s)), 5), 'QM020', 'the due date cannot be in the past');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_supplier_scar(%L, 'Bad contact', NULL, 'minor', NULL, %L, NULL, NULL, NULL)$f$, s, contact2)), 5), 'QM020', 'the contact must belong to the supplier');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_supplier_scar(%L, 'Wrong supplier NC', NULL, 'minor', NULL, NULL, ARRAY[%L]::uuid[], NULL, NULL)$f$, s, nc_other)), 5), 'QM020', 'only the supplier''s own non-conformances can be linked');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.supplier_scars), 0::bigint, 'and a failed create leaves nothing behind');
  r := app.create_supplier_scar(s, 'Bent brackets', 'Brackets arrive bent', 'major', due, contact, ARRAY[nc1], NULL, 'client-key-0001');
  c1 := (r ->> 'id')::uuid;
  PERFORM pg_temp.assert_eq((r ->> 'created')::boolean, true, 'a new SCAR is created');
  PERFORM pg_temp.assert_eq((SELECT (status, reference ~ '^SCAR-[0-9]{2}-0001$', response_due_on = due)::text FROM public.supplier_scars WHERE id = c1), '(draft,t,t)', 'it starts as a draft with a number');
  r := app.create_supplier_scar(s, 'Bent brackets', 'Brackets arrive bent', 'major', due, contact, ARRAY[nc1], NULL, 'client-key-0001');
  PERFORM pg_temp.assert_eq(((r ->> 'id')::uuid = c1, (r ->> 'created')::boolean), (true, false), 'a retry with the same key returns the same SCAR');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.supplier_scars), 1::bigint, 'and creates no duplicate');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_supplier_scar(%L, 'Same key, other supplier', NULL, 'minor', NULL, NULL, NULL, NULL, 'client-key-0001')$f$, s2)), 5), 'QM020', 'a key cannot be reused for another supplier');
  PERFORM pg_temp.assert_eq((SELECT array_agg(to_status) FROM public.supplier_scar_status_history WHERE scar_id = c1), ARRAY['draft'], 'the history starts at draft');

  -- ---- links ----
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.link_scar_ncr(%L, %L)$f$, c1, nc_cancel)), 5), 'QM020', 'a cancelled non-conformance cannot be linked');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.link_scar_ncr(%L, %L)$f$, c1, nc_foreign)), 5), 'P0002', 'a foreign non-conformance is not found');
  PERFORM app.link_scar_ncr(c1, nc2); PERFORM app.link_scar_ncr(c1, nc2);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.supplier_scar_ncrs WHERE scar_id = c1 AND ended_at IS NULL), 2::bigint, 'linking twice is a no-op; one SCAR, many non-conformances');
  SELECT id INTO link2 FROM public.supplier_scar_ncrs WHERE scar_id = c1 AND ncr_id = nc2;
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.unlink_scar_ncr(%L, 'x')$f$, link2)), 5), 'QM020', 'unlinking needs a reason');
  PERFORM app.unlink_scar_ncr(link2, 'Raised against the wrong supplier');
  PERFORM pg_temp.assert_eq((SELECT (ended_at IS NOT NULL, end_reason)::text FROM public.supplier_scar_ncrs WHERE id = link2), '(t,"Raised against the wrong supplier")', 'an unlinked row is ended and kept, with the reason');
  PERFORM app.link_scar_ncr(c1, nc2);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.supplier_scar_ncrs WHERE scar_id = c1 AND ncr_id = nc2), 2::bigint, 'a non-conformance can be linked again, as a new row');

  -- ---- editing a draft ----
  PERFORM app.update_supplier_scar(c1, '{"title": "Bent brackets on pallet 4", "severity": "critical"}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT (title, severity)::text FROM public.supplier_scars WHERE id = c1), '("Bent brackets on pallet 4",critical)', 'a draft can be edited');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.update_supplier_scar(%L, '{"status": "closed"}'::jsonb)$f$, c1)), 5), 'QM020', 'the status is not a field');
  PERFORM pg_temp.assert_fails(format($f$UPDATE public.supplier_scars SET status = 'closed' WHERE id = %L$f$, c1), 'and cannot be written directly');

  -- ---- issuing ----
  c2 := (app.create_supplier_scar(s, 'No links yet', NULL, 'minor', due, NULL, NULL, NULL, NULL) ->> 'id')::uuid;
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.issue_supplier_scar(%L)$f$, c2)), 5), 'QM020', 'a SCAR with no non-conformance cannot be issued');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_scar_response(%L, 'Cause', NULL, 'Fix', NULL, NULL, current_date, 'Them', NULL)$f$, c1)), 5), 'QM020', 'a draft cannot receive a response');
  PERFORM app.issue_supplier_scar(c1);
  PERFORM pg_temp.assert_eq((SELECT (status, issued_at IS NOT NULL, issued_by = dan)::text FROM public.supplier_scars WHERE id = c1), '(issued,t,t)', 'issuing stamps who and when');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.update_supplier_scar(%L, '{"title": "Changed after issue"}'::jsonb)$f$, c1)), 5), 'QM020', 'an issued SCAR keeps its content');
  PERFORM app.update_supplier_scar(c1, jsonb_build_object('contactId', contact));
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.issue_supplier_scar(%L)$f$, c1)), 5), 'QM020', 'it cannot be issued twice');
  PERFORM app.unlink_scar_ncr((SELECT id FROM public.supplier_scar_ncrs WHERE scar_id = c1 AND ncr_id = nc2 AND ended_at IS NULL), 'Duplicate of the first');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.unlink_scar_ncr(%L, 'Remove the last one')$f$, (SELECT id FROM public.supplier_scar_ncrs WHERE scar_id = c1 AND ended_at IS NULL))), 5), 'QM020', 'an issued SCAR keeps at least one non-conformance');

  -- ---- the stages cannot be skipped; receiving a response never closes ----
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.start_scar_review(%L)$f$, c1)), 5), 'QM020', 'no review before a response');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_scar_implementation(%L, 'Fixed', current_date, NULL)$f$, c1)), 5), 'QM020', 'no implementation before acceptance');
  PERFORM pg_temp.logout(); PERFORM pg_temp.login(cat);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_scar_verification(%L, 'effective', 'Checked', 'Fine')$f$, c1)), 5), 'QM020', 'no verification before implementation, even for an approver');
  PERFORM pg_temp.logout(); PERFORM pg_temp.login(dan);
  PERFORM app.acknowledge_supplier_scar(c1, 'Supplier confirmed by phone');
  PERFORM pg_temp.assert_eq((SELECT (status, acknowledged_note)::text FROM public.supplier_scars WHERE id = c1), '(acknowledged,"Supplier confirmed by phone")', 'acknowledged by the supplier');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_scar_response(%L, NULL, NULL, 'Fix', NULL, NULL, current_date, 'Them', NULL)$f$, c1)), 5), 'QM020', 'a response needs a root cause');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_scar_response(%L, 'Cause', NULL, NULL, NULL, NULL, current_date, 'Them', NULL)$f$, c1)), 5), 'QM020', 'and a corrective action');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_scar_response(%L, 'Cause', NULL, 'Fix', NULL, NULL, current_date + 1, 'Them', NULL)$f$, c1)), 5), 'QM020', 'the response date cannot be in the future');
  resp := app.record_scar_response(c1, 'Jig worn', 'Quarantined stock', 'Replace the jig', 'Monthly jig check', current_date + 7, current_date, 'Their quality manager', contact);
  PERFORM pg_temp.assert_eq((SELECT status FROM public.supplier_scars WHERE id = c1), 'response_received', 'a response moves it to response received, not to closed');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.review_scar_response(%L, 'accepted', 'Looks fine')$f$, c1)), 5), 'QM020', 'the review is started before a decision');
  PERFORM pg_temp.assert_fails(format($f$UPDATE public.supplier_scar_responses SET root_cause = 'Changed' WHERE id = %L$f$, resp), 'a response is never edited');
  PERFORM app.start_scar_review(c1);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.review_scar_response(%L, 'maybe', 'Unsure')$f$, c1)), 5), 'QM020', 'a decision is accepted or revision requested');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.review_scar_response(%L, 'revision_requested', '')$f$, c1)), 5), 'QM020', 'a decision needs a note');
  PERFORM app.review_scar_response(c1, 'revision_requested', 'The preventive action is too vague');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.supplier_scars WHERE id = c1), 'revision_requested', 'a revision can be requested');
  resp2 := app.record_scar_response(c1, 'Jig worn and not on the PM plan', NULL, 'Replace the jig and add it to the PM plan', 'Weekly check recorded', current_date + 5, current_date, 'Their quality manager', contact);
  PERFORM pg_temp.assert_eq((SELECT array_agg(seq ORDER BY seq) FROM public.supplier_scar_responses WHERE scar_id = c1), ARRAY[1, 2], 'a second response is kept beside the first');
  PERFORM app.start_scar_review(c1);
  PERFORM app.review_scar_response(c1, 'accepted', 'Accepted');
  PERFORM pg_temp.assert_eq((SELECT array_agg(response_id = resp2 ORDER BY reviewed_at) FROM public.supplier_scar_reviews WHERE scar_id = c1 AND decision = 'accepted'), ARRAY[true], 'the review is of the latest response');
  PERFORM pg_temp.assert_fails(format($f$DELETE FROM public.supplier_scar_reviews WHERE scar_id = %L$f$, c1), 'a review cannot be deleted');

  -- ---- implementation and verification ----
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_scar_implementation(%L, 'Fixed', current_date + 1, NULL)$f$, c1)), 5), 'QM020', 'implementation cannot be dated in the future');
  PERFORM app.record_scar_implementation(c1, 'New jig fitted', current_date, 'Photo emailed');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.supplier_scars WHERE id = c1), 'verifying', 'recording implementation moves it to verifying');
  PERFORM app.record_scar_implementation(c1, 'PM plan updated', current_date, NULL);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.supplier_scar_implementations WHERE scar_id = c1), 2::bigint, 'more can be recorded while it waits');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_scar_verification(%L, 'effective', 'Checked next three deliveries', 'All good')$f$, c1)), 5), '42501', 'an engineer cannot verify effectiveness');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login(cat);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_scar_verification(%L, 'effective', 'ab', 'All good')$f$, c1)), 5), 'QM020', 'a method is needed');
  PERFORM app.record_scar_verification(c1, 'not_effective', 'Checked the next delivery', 'Two brackets still bent');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.supplier_scars WHERE id = c1), 'revision_requested', 'a failed verification sends it back for a new response');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.supplier_scar_verifications WHERE scar_id = c1 AND result = 'not_effective'), 1::bigint, 'and is kept');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(dan);
  PERFORM app.record_scar_response(c1, 'Wrong material grade', NULL, 'Change the material', NULL, current_date + 5, current_date, 'Them', NULL);
  PERFORM app.start_scar_review(c1);
  PERFORM app.review_scar_response(c1, 'accepted', 'Accepted');
  PERFORM app.record_scar_implementation(c1, 'Material changed', current_date, NULL);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.cancel_supplier_scar(%L, 'x')$f$, c1)), 5), 'QM020', 'cancelling needs a reason');
  PERFORM app.record_scar_verification(c1, 'effective', 'Checked the next three deliveries', 'All within tolerance');
  PERFORM pg_temp.assert_eq((SELECT (status, closed_at IS NOT NULL, closed_by = cat)::text FROM public.supplier_scars WHERE id = c1), '(closed,t,t)', 'an effective verification closes it, with who and when');
  PERFORM pg_temp.assert_eq((SELECT array_agg(to_status ORDER BY changed_at) FROM public.supplier_scar_status_history WHERE scar_id = c1),
    ARRAY['draft', 'issued', 'acknowledged', 'response_received', 'under_review', 'revision_requested', 'response_received', 'under_review', 'accepted', 'verifying', 'revision_requested', 'response_received', 'under_review', 'accepted', 'verifying', 'closed'],
    'the status history records every step');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.cancel_supplier_scar(%L, 'Too late to cancel')$f$, c1)), 5), 'QM020', 'a closed SCAR cannot be cancelled');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.link_scar_ncr(%L, %L)$f$, c1, nc2)), 5), 'QM020', 'or have links changed');
  PERFORM pg_temp.assert_fails(format($f$UPDATE public.supplier_scars SET status = 'issued' WHERE id = %L$f$, c1), 'or be reopened by writing the status');
  PERFORM pg_temp.logout();
  -- even the database owner cannot move a status along a path that does not exist
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$UPDATE public.supplier_scars SET status = 'issued' WHERE id = %L$f$, c1)), 5), 'QM020', 'an impossible transition is refused for everyone');

  -- ---- extensions: requested by one person, decided by a different approver ----
  PERFORM pg_temp.login(dan);
  c2 := (app.create_supplier_scar(s, 'Wrong finish', NULL, 'minor', due, NULL, ARRAY[nc2], NULL, NULL) ->> 'id')::uuid;
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.request_scar_extension(%L, %L, 'More time')$f$, c2, due + 7)), 5), 'QM020', 'a draft has no due date to extend');
  PERFORM app.issue_supplier_scar(c2);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.request_scar_extension(%L, %L, 'Earlier')$f$, c2, due - 1)), 5), 'QM020', 'an extension must move the date later');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.request_scar_extension(%L, %L, '')$f$, c2, due + 7)), 5), 'QM020', 'and needs a reason');
  ext1 := app.request_scar_extension(c2, due + 7, 'Supplier on holiday');
  PERFORM pg_temp.assert_eq((SELECT (e.status, c.response_due_on = due)::text FROM public.supplier_scar_extensions e JOIN public.supplier_scars c ON c.id = e.scar_id WHERE e.id = ext1), '(pending,t)', 'a request waits and the due date has not moved');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.request_scar_extension(%L, %L, 'Another')$f$, c2, due + 9)), 5), 'QM020', 'only one request waits at a time');
  PERFORM pg_temp.assert_fails(format($f$UPDATE public.supplier_scar_extensions SET status = 'approved' WHERE id = %L$f$, ext1), 'a request cannot be approved by writing to the table');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.decide_scar_extension(%L, true, 'Fine')$f$, ext1)), 5), '42501', 'an engineer cannot decide');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.decide_scar_extension(%L, true, 'x')$f$, ext1)), 5), 'QM020', 'a decision needs a note');
  PERFORM app.decide_scar_extension(ext1, true, 'Justified: holiday shutdown');
  PERFORM pg_temp.assert_eq((SELECT (response_due_on = due + 7, original_response_due_on = due)::text FROM public.supplier_scars WHERE id = c2), '(t,t)', 'approving moves the due date and the original is kept');
  PERFORM pg_temp.assert_eq((SELECT (previous_due_on = due, new_due_on = due + 7, reason, status, decided_by = cat)::text FROM public.supplier_scar_extensions WHERE id = ext1), '(t,t,"Supplier on holiday",approved,t)', 'the request and the decision are both kept');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.decide_scar_extension(%L, false, 'Changed my mind')$f$, ext1)), 5), 'QM020', 'a decided request is final');
  PERFORM pg_temp.assert_fails(format($f$DELETE FROM public.supplier_scar_extensions WHERE id = %L$f$, ext1), 'and cannot be deleted');
  -- the approver cannot decide a request they made themselves
  ext2 := app.request_scar_extension(c2, due + 14, 'Approver asks too');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.decide_scar_extension(%L, true, 'Approving my own request')$f$, ext2)), 5), 'QM020', 'nobody decides their own request');
  PERFORM app.withdraw_scar_extension(ext2, 'Asked in error');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.supplier_scar_extensions WHERE id = ext2), 'withdrawn', 'the person who asked can withdraw it');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(dan);
  ext3 := app.request_scar_extension(c2, due + 14, 'Still not ready');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  PERFORM app.decide_scar_extension(ext3, false, 'No: chase the supplier instead');
  PERFORM pg_temp.assert_eq((SELECT (e.status, c.response_due_on = due + 7)::text FROM public.supplier_scar_extensions e JOIN public.supplier_scars c ON c.id = e.scar_id WHERE e.id = ext3), '(rejected,t)', 'a rejected request leaves the due date alone');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(dan);
  ext4 := app.request_scar_extension(c2, due + 20, 'One more try');
  PERFORM app.record_scar_response(c2, 'Cause', NULL, 'Fix', NULL, NULL, current_date, 'Them', NULL);
  PERFORM pg_temp.assert_eq((SELECT status FROM public.supplier_scar_extensions WHERE id = ext4), 'withdrawn', 'a response settles a waiting request');
  PERFORM app.cancel_supplier_scar(c2, 'Raised against the wrong supplier');
  PERFORM pg_temp.assert_eq((SELECT (status, cancel_reason)::text FROM public.supplier_scars WHERE id = c2), '(cancelled,"Raised against the wrong supplier")', 'a SCAR is cancelled with a reason and kept');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.issue_supplier_scar(%L)$f$, c2)), 5), 'QM020', 'a cancelled SCAR stays cancelled');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.supplier_scars WHERE reference ~ '^SCAR-[0-9]{2}-000[1-3]$'), 3::bigint, 'numbers run on per organisation and year');
  PERFORM pg_temp.logout();

  -- ---- the fields the spec asks for: requirement, evidence, containment, owner, affected items ----
  PERFORM pg_temp.login(dan);
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'BRK-1', 'Bracket') RETURNING id INTO p1;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'BRK-2', 'Other part') RETURNING id INTO p2;
  PERFORM pg_temp.logout();
  INSERT INTO public.lots (organisation_id, lot_number, part_id, origin, supplier_id, quantity) VALUES (org, 'LOT-A', p1, 'received', s, 500) RETURNING id INTO lot1;
  INSERT INTO public.lots (organisation_id, lot_number, part_id, origin, supplier_id, quantity) VALUES (org, 'LOT-B', p2, 'received', s, 100) RETURNING id INTO lot_other;
  PERFORM pg_temp.login(dan);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_supplier_scar(%L, 'Bad owner', NULL, 'minor', NULL, NULL, NULL, NULL, NULL, jsonb_build_object('ownerId', %L))$f$, s, eve)), 5), 'QM020', 'the owner must be a member of this organisation');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_supplier_scar(%L, 'Unknown key', NULL, 'minor', NULL, NULL, NULL, NULL, NULL, '{"status":"closed"}'::jsonb)$f$, s)), 5), 'QM020', 'an unknown field is refused');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_supplier_scar(%L, 'Bad lot', NULL, 'minor', NULL, NULL, NULL, NULL, NULL, jsonb_build_object('items', jsonb_build_array(jsonb_build_object('lotId', %L, 'partId', %L))))$f$, s, lot1, p2)), 5), 'QM020', 'a lot and a part must agree');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.supplier_scars WHERE title IN ('Bad owner', 'Unknown key', 'Bad lot')), 0::bigint, 'and a refused create leaves nothing behind');
  c3 := (app.create_supplier_scar(s, 'Cracked castings', 'Cracks at the weld', 'critical', due, contact, ARRAY[nc1], NULL, NULL,
    jsonb_build_object('requirementBreached', 'Drawing note 4: no cracks', 'objectiveEvidence', 'Photos 1 to 3; inspection IPI-1', 'containmentRequirements', 'Quarantine stock and check shipments', 'ownerId', cat,
                       'items', jsonb_build_array(jsonb_build_object('lotId', lot1, 'quantity', 120, 'receiptReference', 'DN-4412'), jsonb_build_object('material', 'Steel bar 20mm', 'quantity', 15.5)))) ->> 'id')::uuid;
  PERFORM pg_temp.assert_eq((SELECT (requirement_breached, objective_evidence, containment_requirements, owner_user_id = cat)::text FROM public.supplier_scars WHERE id = c3),
    '("Drawing note 4: no cracks","Photos 1 to 3; inspection IPI-1","Quarantine stock and check shipments",t)', 'the requirement, evidence, containment and owner are kept');
  PERFORM pg_temp.assert_eq((SELECT owner_user_id = dan FROM public.supplier_scars WHERE id = c1), true, 'the owner defaults to whoever raised it');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.supplier_scar_items WHERE scar_id = c3 AND ended_at IS NULL), 2::bigint, 'affected items are listed');
  PERFORM pg_temp.assert_eq((SELECT part_id = p1 FROM public.supplier_scar_items WHERE scar_id = c3 AND lot_id = lot1), true, 'a lot brings its part');
  PERFORM pg_temp.assert_fails(format($f$INSERT INTO public.supplier_scar_items (organisation_id, scar_id, material) VALUES (%L, %L, 'Direct')$f$, org, c3), 'items are written only through functions');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.add_scar_item(%L, '{}'::jsonb)$f$, c3)), 5), 'QM020', 'an item must name something');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.add_scar_item(%L, '{"material":"x","quantity":"-3"}'::jsonb)$f$, c3)), 5), 'QM020', 'a quantity is not negative');
  item1 := app.add_scar_item(c3, jsonb_build_object('partId', p2, 'notes', 'Same pallet'));
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.remove_scar_item(%L, 'x')$f$, item1)), 5), 'QM020', 'removing an item needs a reason');
  PERFORM app.remove_scar_item(item1, 'Added in error');
  PERFORM pg_temp.assert_eq((SELECT (ended_at IS NOT NULL, end_reason)::text FROM public.supplier_scar_items WHERE id = item1), '(t,"Added in error")', 'a removed item is ended and kept');
  PERFORM app.update_supplier_scar(c3, jsonb_build_object('requirementBreached', 'Drawing note 5', 'ownerId', dan));
  PERFORM app.issue_supplier_scar(c3);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.update_supplier_scar(%L, '{"objectiveEvidence":"Changed after issue"}'::jsonb)$f$, c3)), 5), 'QM020', 'once issued the evidence is fixed');
  PERFORM app.update_supplier_scar(c3, jsonb_build_object('ownerId', cat));
  PERFORM pg_temp.assert_eq((SELECT owner_user_id = cat FROM public.supplier_scars WHERE id = c3), true, 'but the internal owner can be handed over');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.update_supplier_scar(%L, jsonb_build_object('ownerId', %L))$f$, c3, eve)), 5), 'QM020', 'to a member only');
  -- the supplier's response: extent of condition, escape point, responsible person, method
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_scar_response(%L, 'Cause', NULL, 'Fix', NULL, NULL, current_date, 'Them', NULL, NULL, NULL, NULL, 'guessing')$f$, c3)), 5), 'QM020', 'the root cause method is 5 whys, fishbone or other');
  resp := app.record_scar_response(c3, 'Weld parameters drifted', 'Stock quarantined', 'Re-qualify the weld procedure', 'Monthly weld audit', current_date + 10, current_date, 'Their quality manager', contact,
    'Lots 1180 to 1184 may be affected', 'Final inspection did not include a dye-penetrant check', 'Their welding engineer', 'five_whys');
  PERFORM pg_temp.assert_eq((SELECT (extent_of_condition, escape_point, responsible_name, root_cause_method)::text FROM public.supplier_scar_responses WHERE id = resp),
    '("Lots 1180 to 1184 may be affected","Final inspection did not include a dye-penetrant check","Their welding engineer",five_whys)', 'the response keeps extent, escape point, responsible person and method');
  PERFORM pg_temp.assert_fails(format($f$UPDATE public.supplier_scar_responses SET escape_point = 'Changed' WHERE id = %L$f$, resp), 'and stays frozen');
  PERFORM pg_temp.logout();

  -- ---- another organisation ----
  PERFORM pg_temp.login(eve);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.supplier_scars) + (SELECT count(*) FROM public.supplier_scar_responses) + (SELECT count(*) FROM public.supplier_scar_status_history) + (SELECT count(*) FROM public.supplier_scar_ncrs) + (SELECT count(*) FROM public.supplier_scar_items) + (SELECT count(*) FROM public.supplier_scar_extensions), 0::bigint, 'another organisation sees none of it');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_supplier_scar(%L, 'Foreign supplier', NULL, 'minor', NULL, NULL, NULL, NULL, NULL)$f$, s)), 5), 'P0002', 'it cannot raise a SCAR on a foreign supplier');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.cancel_supplier_scar(%L, 'Foreign cancel')$f$, c1)), 5), 'P0002', 'or change a foreign SCAR');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.link_scar_ncr(%L, %L)$f$, c1, nc1)), 5), 'P0002', 'or link to it');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) >= 10 FROM public.audit_events WHERE entity_type IN ('supplier_scars', 'supplier_scar_responses', 'supplier_scar_reviews', 'supplier_scar_verifications')), true, 'it is all audited');
END $$;
ROLLBACK;
