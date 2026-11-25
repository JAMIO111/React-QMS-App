-- Change management CH6a: a customer's change request and a supplier's process-change notice arrive as DRAFT changes; only their own parts; a retry is safe;
-- the party reads named fields only; staff are told; the origin names the request and never changes.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
  ('6c000000-0000-0000-0000-000000000c01', 'ann@ch6.test', now()), ('6c000000-0000-0000-0000-000000000c04', 'sam@acme.ch6.test', now()),
  ('6c000000-0000-0000-0000-000000000c05', 'cus@wayne.ch6.test', now()), ('6c000000-0000-0000-0000-000000000c06', 'cus2@other.ch6.test', now());

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '6c000000-0000-0000-0000-000000000c01'; sam uuid := '6c000000-0000-0000-0000-000000000c04'; cus uuid := '6c000000-0000-0000-0000-000000000c05'; cus2 uuid := '6c000000-0000-0000-0000-000000000c06';
  org uuid; acme uuid; wayne uuid; other uuid; p_acme uuid; p_wayne uuid; p_other uuid; a_sam uuid; a_cus uuid; a_cus2 uuid; part_a uuid; part_b uuid; part_c uuid;
  j jsonb; j2 jsonb; r text; chg uuid; ckey text := 'client-key-c001'; keys text;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('CH6 Alpha'); PERFORM pg_temp.logout();
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'ACME', 'Acme Castings');
  INSERT INTO public.customers (organisation_id, code, name) VALUES (org, 'WAYNE', 'Wayne Ltd'), (org, 'OTHER', 'Other Co');
  SELECT id INTO acme FROM public.suppliers WHERE organisation_id = org AND code = 'ACME';
  SELECT id INTO wayne FROM public.customers WHERE organisation_id = org AND code = 'WAYNE';
  SELECT id INTO other FROM public.customers WHERE organisation_id = org AND code = 'OTHER';
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'P-100', 'Bracket'), (org, 'P-200', 'Housing'), (org, 'P-300', 'Casting');
  SELECT id INTO part_a FROM public.parts WHERE organisation_id = org AND part_number = 'P-100';
  SELECT id INTO part_b FROM public.parts WHERE organisation_id = org AND part_number = 'P-200';
  SELECT id INTO part_c FROM public.parts WHERE organisation_id = org AND part_number = 'P-300';
  INSERT INTO public.part_customers (organisation_id, part_id, customer_id, customer_part_number, is_primary) VALUES (org, part_a, wayne, 'W-77', true), (org, part_b, other, NULL, true);
  INSERT INTO public.supplier_product_links (organisation_id, supplier_id, kind, part_id, supplier_part_number) VALUES (org, acme, 'part', part_c, 'AC-3');
  PERFORM pg_temp.login(ann);
  PERFORM app.set_portal_settings(org, true, NULL, false);
  p_acme := app.set_portal_party(org, 'supplier', acme, true);
  p_wayne := app.set_portal_party(org, 'customer', wayne, true);
  p_other := app.set_portal_party(org, 'customer', other, true);
  a_sam := app.invite_external_user(p_acme, 'sam@acme.ch6.test', 'admin', NULL);
  a_cus := app.invite_external_user(p_wayne, 'cus@wayne.ch6.test', 'admin', NULL);
  a_cus2 := app.invite_external_user(p_other, 'cus2@other.ch6.test', 'admin', NULL);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(sam); PERFORM app.accept_portal_invitation(a_sam); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cus); PERFORM app.accept_portal_invitation(a_cus); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cus2); PERFORM app.accept_portal_invitation(a_cus2); PERFORM pg_temp.logout();

  -- ---- the parts each side may name ----
  PERFORM pg_temp.login(cus);
  PERFORM pg_temp.assert_eq((SELECT string_agg(part_number || ':' || coalesce(their_part_number, ''), ',') FROM app.portal_change_parts(org, p_wayne)), 'P-100:W-77', 'a customer sees the parts we make for them');
  r := pg_temp.fails(format($f$SELECT * FROM app.portal_change_parts(%L, %L)$f$, org, p_other));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'another customer''s parts are not theirs');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(sam);
  PERFORM pg_temp.assert_eq((SELECT string_agg(part_number || ':' || coalesce(their_part_number, ''), ',') FROM app.portal_change_parts(org, p_acme)), 'P-300:AC-3', 'a supplier sees the parts they supply');
  PERFORM pg_temp.logout();

  -- ---- a customer sends a request ----
  PERFORM pg_temp.login(cus);
  j := app.portal_raise_change(org, p_wayne, 'Tighten the bend radius', 'Please reduce the bend radius on the bracket from 3 mm to 2 mm.', 'Fits our new assembly', part_a, current_date + 30, ckey);
  PERFORM pg_temp.assert_eq((j ->> 'created')::boolean, true, 'a request is made');
  PERFORM pg_temp.assert_eq(app.portal_raise_change(org, p_wayne, 'Tighten the bend radius', 'Please reduce the bend radius on the bracket from 3 mm to 2 mm.', NULL, part_a, NULL, ckey) ->> 'id', j ->> 'id', 'a retry with the same key gives the same request');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.portal_change_requests), 0::bigint, 'the person reads no tables');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.change_requests), 0::bigint, 'nor the changes');
  r := pg_temp.fails(format($f$SELECT app.portal_raise_change(%L, %L, 'Not my part', 'This part is not one of theirs at all.', NULL, %L, NULL)$f$, org, p_wayne, part_b));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'a part that is not theirs is refused');
  r := pg_temp.fails(format($f$SELECT app.portal_raise_change(%L, %L, 'x', 'A short title is not enough here.', NULL, NULL, NULL)$f$, org, p_wayne));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'the title needs three characters');
  r := pg_temp.fails(format($f$SELECT app.portal_raise_change(%L, %L, 'Past date', 'The date asked for is already in the past.', NULL, NULL, current_date - 1)$f$, org, p_wayne));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'a date in the past is refused');
  PERFORM pg_temp.logout();

  SELECT change_id INTO chg FROM public.portal_change_requests WHERE id = (j ->> 'id')::uuid;
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.change_requests c JOIN public.change_types t ON t.id = c.type_id
                              WHERE c.id = chg AND c.stage = 'draft' AND c.urgency = 'normal' AND c.origin_kind = 'portal_request' AND c.origin_id = (j ->> 'id')::uuid AND t.key = 'product_design'
                                AND c.title = 'Tighten the bend radius' AND c.reason LIKE '%Requested by Wayne Ltd.%' AND c.reason LIKE '%Fits our new assembly%'), 1::bigint, 'a draft change in their words, from the portal');
  PERFORM pg_temp.assert_eq((SELECT string_agg(kind, ',' ORDER BY kind) FROM public.change_links WHERE change_id = chg), 'customer,part', 'it covers the part and the customer');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.portal_activity WHERE kind = 'change_requested' AND record_kind = 'change' AND record_id = chg), 1::bigint, 'staff are told');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($f$UPDATE public.change_requests SET origin_id = gen_random_uuid() WHERE id = %L$f$, chg)) LIKE 'QM035%', true, 'the origin never changes');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($f$UPDATE public.portal_change_requests SET wanted_on = NULL WHERE id = %L$f$, j ->> 'id')) LIKE 'QM032%', true, 'the record is never changed');

  -- ---- a supplier notifies a process change ----
  PERFORM pg_temp.login(sam);
  j2 := app.portal_raise_change(org, p_acme, 'New furnace for the casting', 'We are moving this casting to a new furnace in March; the alloy is unchanged.', NULL, part_c, NULL);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT kind FROM public.portal_change_requests WHERE id = (j2 ->> 'id')::uuid), 'supplier_notice', 'a supplier''s request is a notice');
  PERFORM pg_temp.assert_eq((SELECT t.key FROM public.change_requests c JOIN public.change_types t ON t.id = c.type_id JOIN public.portal_change_requests r ON r.change_id = c.id WHERE r.id = (j2 ->> 'id')::uuid), 'material', 'it starts as a material or supplier change');
  PERFORM pg_temp.assert_eq((SELECT string_agg(l.kind, ',' ORDER BY l.kind) FROM public.change_links l JOIN public.portal_change_requests r ON r.change_id = l.change_id WHERE r.id = (j2 ->> 'id')::uuid), 'part,supplier', 'it covers the part and the supplier');
  PERFORM pg_temp.login(sam);
  r := pg_temp.fails(format($f$SELECT app.portal_raise_change(%L, %L, 'Another one', 'A part that they do not supply to us.', NULL, %L, NULL)$f$, org, p_acme, part_a));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'a supplier cannot name a part they do not supply');
  PERFORM pg_temp.logout();

  -- ---- each party reads only its own, in named fields, with a plain status ----
  PERFORM pg_temp.login(cus);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.portal_list_change_requests(org, p_wayne)), 1::bigint, 'the customer sees their own request');
  PERFORM pg_temp.assert_eq((SELECT status FROM app.portal_list_change_requests(org, p_wayne)), 'received', 'a draft reads as received');
  PERFORM pg_temp.assert_eq((SELECT array_agg(c ORDER BY c) FROM jsonb_object_keys((SELECT to_jsonb(x) FROM app.portal_list_change_requests(org, p_wayne) x)) c),
    ARRAY['description','kind','part_name','part_number','raised_at','raised_by_me','reference','request_id','status','title','wanted_on'], 'named fields only');
  r := pg_temp.fails(format($f$SELECT * FROM app.portal_list_change_requests(%L, %L)$f$, org, p_acme));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'another party''s list is not theirs');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cus2);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.portal_list_change_requests(org, p_other)), 0::bigint, 'another customer sees nothing of it');
  PERFORM pg_temp.logout();

  -- ---- the status follows the change, without its reasons ----
  UPDATE public.change_requests SET stage = 'assessment' WHERE id = chg;
  PERFORM pg_temp.login(cus);
  PERFORM pg_temp.assert_eq((SELECT status FROM app.portal_list_change_requests(org, p_wayne)), 'under_review', 'in assessment it is under review');
  PERFORM pg_temp.logout();
  UPDATE public.change_requests SET stage = 'cancelled', cancel_reason = 'Duplicate of another request', cancelled_at = now() WHERE id = chg;
  PERFORM pg_temp.login(cus);
  PERFORM pg_temp.assert_eq((SELECT status FROM app.portal_list_change_requests(org, p_wayne)), 'cancelled', 'a cancelled change reads as cancelled');
  PERFORM pg_temp.logout();

  -- ---- staff see where it came from ----
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq((SELECT party_name || '|' || kind FROM app.portal_change_origin((j ->> 'id')::uuid)), 'Wayne Ltd|customer_request', 'staff see which customer sent it');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.portal_change_requests), 2::bigint, 'staff read the records');
  PERFORM pg_temp.logout();

  -- ---- a party switched off cannot send; the tile can stop it ----
  PERFORM pg_temp.login(ann); PERFORM app.set_portal_party(org, 'customer', wayne, true, NULL, '{"changes": false}'::jsonb); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cus);
  r := pg_temp.fails(format($f$SELECT app.portal_raise_change(%L, %L, 'Blocked request', 'The tile has been switched off for us.', NULL, NULL, NULL)$f$, org, p_wayne));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'the tile stops requests');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
