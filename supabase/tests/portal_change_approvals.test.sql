-- Change management CH6b: staff ask a customer to approve a change in the portal; the customer approves or says what they cannot accept; the answer
-- writes the change's own customer-approval record; named fields only; one request waits at a time; nothing is closed or decided internally.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
  ('6d000000-0000-0000-0000-000000000d01', 'ann@ch6b.test', now()), ('6d000000-0000-0000-0000-000000000d04', 'sam@acme.ch6b.test', now()),
  ('6d000000-0000-0000-0000-000000000d05', 'cus@wayne.ch6b.test', now()), ('6d000000-0000-0000-0000-000000000d06', 'cus2@other.ch6b.test', now());

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '6d000000-0000-0000-0000-000000000d01'; sam uuid := '6d000000-0000-0000-0000-000000000d04'; cus uuid := '6d000000-0000-0000-0000-000000000d05'; cus2 uuid := '6d000000-0000-0000-0000-000000000d06';
  org uuid; acme uuid; wayne uuid; other uuid; p_acme uuid; p_wayne uuid; p_other uuid; a_sam uuid; a_cus uuid; a_cus2 uuid; part_a uuid; part_b uuid; t_design uuid;
  c1 uuid; c2 uuid; req uuid; req2 uuid; j jsonb; r text; k text; stage_before text;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('CH6b Alpha'); PERFORM pg_temp.logout();
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'ACME', 'Acme Castings');
  INSERT INTO public.customers (organisation_id, code, name) VALUES (org, 'WAYNE', 'Wayne Ltd'), (org, 'OTHER', 'Other Co');
  SELECT id INTO acme FROM public.suppliers WHERE organisation_id = org AND code = 'ACME';
  SELECT id INTO wayne FROM public.customers WHERE organisation_id = org AND code = 'WAYNE';
  SELECT id INTO other FROM public.customers WHERE organisation_id = org AND code = 'OTHER';
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'P-100', 'Bracket'), (org, 'P-200', 'Housing');
  SELECT id INTO part_a FROM public.parts WHERE organisation_id = org AND part_number = 'P-100';
  SELECT id INTO part_b FROM public.parts WHERE organisation_id = org AND part_number = 'P-200';
  INSERT INTO public.part_customers (organisation_id, part_id, customer_id, customer_part_number, is_primary) VALUES (org, part_a, wayne, 'W-77', true), (org, part_b, other, NULL, true);
  SELECT id INTO t_design FROM public.change_types WHERE organisation_id = org AND key = 'product_design';
  PERFORM pg_temp.login(ann);
  PERFORM app.set_portal_settings(org, true, NULL, false);
  p_acme := app.set_portal_party(org, 'supplier', acme, true);
  p_wayne := app.set_portal_party(org, 'customer', wayne, true, 'Pat in Quality');
  p_other := app.set_portal_party(org, 'customer', other, true);
  a_sam := app.invite_external_user(p_acme, 'sam@acme.ch6b.test', 'admin', NULL);
  a_cus := app.invite_external_user(p_wayne, 'cus@wayne.ch6b.test', 'admin', NULL);
  a_cus2 := app.invite_external_user(p_other, 'cus2@other.ch6b.test', 'admin', NULL);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(sam); PERFORM app.accept_portal_invitation(a_sam); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cus); PERFORM app.accept_portal_invitation(a_cus); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cus2); PERFORM app.accept_portal_invitation(a_cus2); PERFORM pg_temp.logout();

  PERFORM pg_temp.login(ann);
  c1 := app.create_change(org, jsonb_build_object('title', 'Tighten the bend radius', 'typeId', t_design, 'description', 'Bend radius from 3 mm to 2 mm', 'reason', 'Customer asked for it',
          'links', jsonb_build_array(jsonb_build_object('kind', 'part', 'id', part_a))));
  c2 := app.create_change(org, jsonb_build_object('title', 'Other change', 'typeId', t_design, 'description', 'x change', 'reason', 'y reason', 'links', jsonb_build_array(jsonb_build_object('kind', 'part', 'id', part_b))));
  -- a draft cannot be put to a customer
  r := pg_temp.fails(format($f$SELECT app.request_customer_change_approval(%L, %L, NULL)$f$, c1, p_wayne));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'a draft is not put to a customer');
  PERFORM app.submit_change(c1);
  PERFORM app.submit_change(c2);
  PERFORM pg_temp.assert_eq((SELECT string_agg(party_name, ',') FROM app.change_customer_parties(c1)), 'Wayne Ltd', 'the change is for the customer who buys the part');
  r := pg_temp.fails(format($f$SELECT app.request_customer_change_approval(%L, %L, NULL)$f$, c1, p_other));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'a customer the change is not about cannot be asked');
  r := pg_temp.fails(format($f$SELECT app.request_customer_change_approval(%L, %L, NULL)$f$, c1, p_acme));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'a supplier is not asked');
  req := app.request_customer_change_approval(c1, p_wayne, 'Please approve the tighter radius.');
  PERFORM pg_temp.assert_eq((SELECT customer_approval FROM public.change_requests WHERE id = c1), 'requested', 'the change says it is requested');
  r := pg_temp.fails(format($f$SELECT app.request_customer_change_approval(%L, %L, NULL)$f$, c1, p_wayne));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'one request waits at a time');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.change_approval_recipients(req)), 1::bigint, 'the customer''s people are emailed');
  PERFORM pg_temp.assert_eq(jsonb_array_length(app.change_customer_approvals(c1)), 1, 'staff see the request');
  PERFORM pg_temp.logout();

  -- ---- an external person cannot ask or read staff data ----
  PERFORM pg_temp.login(sam);
  r := pg_temp.fails(format($f$SELECT app.request_customer_change_approval(%L, %L, NULL)$f$, c1, p_wayne));
  PERFORM pg_temp.assert_eq(r NOT LIKE 'ok%', true, 'an external person cannot ask');
  r := pg_temp.fails(format($f$SELECT app.change_customer_approvals(%L)$f$, c1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'nor read staff''s list');
  PERFORM pg_temp.logout();

  -- ---- what the customer sees: named fields only ----
  PERFORM pg_temp.login(cus);
  j := app.portal_get_change_approval(req);
  SELECT string_agg(x, ',' ORDER BY x) INTO k FROM jsonb_object_keys(j) x;
  PERFORM pg_temp.assert_eq(k, 'appliesFrom,canDecide,contact,decidedAt,decidedBy,decisionNote,expedited,id,open,parts,reference,requestNote,requestedAt,status,stock,title,type,whatIsChanging,why,yourReference', 'the exact keys');
  PERFORM pg_temp.assert_eq(j ->> 'contact', 'Pat in Quality', 'who to contact');
  PERFORM pg_temp.assert_eq(j -> 'parts' -> 0 ->> 'theirPartNumber', 'W-77', 'their own part number');
  PERFORM pg_temp.assert_eq(jsonb_array_length(j -> 'parts'), 1, 'only their parts');
  PERFORM pg_temp.assert_eq((j ->> 'canDecide')::boolean, true, 'they may answer');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.portal_list_change_approvals(org)), 1::bigint, 'it is in their list');
  SELECT string_agg(c, ',' ORDER BY c) INTO k FROM jsonb_object_keys((SELECT to_jsonb(x) FROM app.portal_list_change_approvals(org) x)) c;
  PERFORM pg_temp.assert_eq(k, 'can_decide,decided_at,reference,request_id,requested_at,status,title', 'the list is named fields only');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.portal_change_approvals), 0::bigint, 'they read no tables');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.change_requests), 0::bigint, 'nor the changes');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cus2);
  r := pg_temp.fails(format($f$SELECT app.portal_get_change_approval(%L)$f$, req));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'another customer sees nothing of it');
  r := pg_temp.fails(format($f$SELECT app.portal_decide_change_approval(%L, true, NULL, NULL)$f$, req));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'nor can they answer it');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.portal_list_change_approvals(org)), 0::bigint, 'their list is empty');
  PERFORM pg_temp.logout();

  -- ---- the customer says no: a note is needed; final; staff are told; the change is not closed or moved ----
  SELECT stage INTO stage_before FROM public.change_requests WHERE id = c1;
  PERFORM pg_temp.login(cus);
  r := pg_temp.fails(format($f$SELECT app.portal_decide_change_approval(%L, false, NULL, NULL)$f$, req));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'saying no needs a reason');
  PERFORM app.portal_decide_change_approval(req, false, 'A 2 mm radius cracks on our press.', NULL);
  r := pg_temp.fails(format($f$SELECT app.portal_decide_change_approval(%L, true, NULL, NULL)$f$, req));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'an answer is final');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT customer_approval FROM public.change_requests WHERE id = c1), 'rejected', 'the change records the customer''s no');
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.change_requests WHERE id = c1), stage_before, 'nothing else moved');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.portal_activity WHERE kind = 'change_declined' AND record_id = c1), 1::bigint, 'staff are told');

  -- ---- asked again; approved with their own reference ----
  PERFORM pg_temp.login(ann);
  req2 := app.request_customer_change_approval(c1, p_wayne, NULL);
  PERFORM pg_temp.assert_eq(jsonb_array_length(app.change_customer_approvals(c1)), 2, 'staff see both');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cus);
  PERFORM app.portal_decide_change_approval(req2, true, 'Fine after our trial.', 'WAYNE-ECN-12');
  j := app.portal_get_change_approval(req2);
  PERFORM pg_temp.assert_eq(j ->> 'status', 'approved', 'approved');
  PERFORM pg_temp.assert_eq(j ->> 'yourReference', 'WAYNE-ECN-12', 'with their reference');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT customer_approval || '|' || customer_reference FROM public.change_requests WHERE id = c1), 'approved|WAYNE-ECN-12', 'the change records the approval');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.portal_activity WHERE kind = 'change_approved' AND record_id = c1), 1::bigint, 'staff are told');
  PERFORM pg_temp.login(ann);
  r := pg_temp.fails(format($f$SELECT app.request_customer_change_approval(%L, %L, NULL)$f$, c1, p_wayne));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'no need to ask once approved');
  PERFORM pg_temp.logout();

  -- ---- withdrawing puts the change back to required; the customer no longer sees it ----
  INSERT INTO public.part_customers (organisation_id, part_id, customer_id, is_primary) VALUES (org, part_b, wayne, false);
  PERFORM pg_temp.login(ann);
  PERFORM app.set_change_customer_approval(c2, 'required');
  req := app.request_customer_change_approval(c2, p_wayne, NULL);
  r := pg_temp.fails(format($f$SELECT app.withdraw_customer_change_approval(%L, 'x')$f$, req));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'a withdrawal needs a reason');
  PERFORM app.withdraw_customer_change_approval(req, 'Raised too early');
  PERFORM pg_temp.assert_eq((SELECT customer_approval FROM public.change_requests WHERE id = c2), 'required', 'back to required');
  r := pg_temp.fails(format($f$SELECT app.withdraw_customer_change_approval(%L, 'Again for no reason')$f$, req));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'only a waiting request can be withdrawn');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cus);
  r := pg_temp.fails(format($f$SELECT app.portal_get_change_approval(%L)$f$, req));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'a withdrawn request is gone for the customer');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.portal_list_change_approvals(org)), 2::bigint, 'and not listed');
  PERFORM pg_temp.logout();

  -- ---- frozen ----
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($f$DELETE FROM public.portal_change_approvals WHERE id = %L$f$, req2)) LIKE 'QM032%', true, 'never deleted');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($f$UPDATE public.portal_change_approvals SET status = 'pending', decided_at = NULL, decided_by = NULL WHERE id = %L$f$, req2)) LIKE 'QM032%', true, 'an answered request does not change');
END $$;
ROLLBACK;
