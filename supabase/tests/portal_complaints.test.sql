-- External portal PT5a: a customer raises a complaint that becomes a draft non-conformance; only their own parts; named fields only; retries are safe.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
  ('5f000000-0000-0000-0000-000000000f01', 'ann@pt5.test', now()), ('5f000000-0000-0000-0000-000000000f04', 'sam@acme.pt5.test', now()),
  ('5f000000-0000-0000-0000-000000000f05', 'cus@wayne.pt5.test', now()), ('5f000000-0000-0000-0000-000000000f06', 'cus2@other.pt5.test', now());

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '5f000000-0000-0000-0000-000000000f01'; sam uuid := '5f000000-0000-0000-0000-000000000f04'; cus uuid := '5f000000-0000-0000-0000-000000000f05'; cus2 uuid := '5f000000-0000-0000-0000-000000000f06';
  org uuid; acme uuid; wayne uuid; other uuid; p_acme uuid; p_wayne uuid; p_other uuid; a_sam uuid; a_cus uuid; a_cus2 uuid; part_a uuid; part_b uuid; j jsonb; r text; k text; n int; ncr uuid; ckey text := 'client-key-0001';
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('PT5 Alpha'); PERFORM pg_temp.logout();
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'ACME', 'Acme Castings');
  INSERT INTO public.customers (organisation_id, code, name) VALUES (org, 'WAYNE', 'Wayne Ltd'), (org, 'OTHER', 'Other Co');
  SELECT id INTO acme FROM public.suppliers WHERE organisation_id = org AND code = 'ACME';
  SELECT id INTO wayne FROM public.customers WHERE organisation_id = org AND code = 'WAYNE';
  SELECT id INTO other FROM public.customers WHERE organisation_id = org AND code = 'OTHER';
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'P-100', 'Bracket'), (org, 'P-200', 'Housing');
  SELECT id INTO part_a FROM public.parts WHERE organisation_id = org AND part_number = 'P-100';
  SELECT id INTO part_b FROM public.parts WHERE organisation_id = org AND part_number = 'P-200';
  INSERT INTO public.part_customers (organisation_id, part_id, customer_id, customer_part_number, is_primary) VALUES (org, part_a, wayne, 'W-77', true), (org, part_b, other, NULL, true);
  PERFORM pg_temp.login(ann);
  PERFORM app.set_portal_settings(org, true, NULL, false);
  p_acme := app.set_portal_party(org, 'supplier', acme, true);
  p_wayne := app.set_portal_party(org, 'customer', wayne, true, 'Pat in Quality');
  p_other := app.set_portal_party(org, 'customer', other, true);
  a_sam := app.invite_external_user(p_acme, 'sam@acme.pt5.test', 'admin', NULL);
  a_cus := app.invite_external_user(p_wayne, 'cus@wayne.pt5.test', 'admin', NULL);
  a_cus2 := app.invite_external_user(p_other, 'cus2@other.pt5.test', 'admin', NULL);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(sam); PERFORM app.accept_portal_invitation(a_sam); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cus); PERFORM app.accept_portal_invitation(a_cus); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cus2); PERFORM app.accept_portal_invitation(a_cus2); PERFORM pg_temp.logout();

  -- ---- the customer sees only the parts we make for them ----
  PERFORM pg_temp.login(cus);
  PERFORM pg_temp.assert_eq((SELECT string_agg(part_number || ':' || coalesce(customer_part_number, ''), ',') FROM app.portal_my_parts(org, p_wayne)), 'P-100:W-77', 'their own parts only');
  r := pg_temp.fails(format($f$SELECT * FROM app.portal_my_parts(%L, %L)$f$, org, p_other));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'another customer''s parts are not theirs');
  PERFORM pg_temp.logout();

  -- ---- raising a complaint ----
  PERFORM pg_temp.login(cus);
  j := app.portal_raise_complaint(org, p_wayne, 'Bracket cracked on arrival', 'Three brackets in the delivery had cracks at the bend.', part_a, 3, 'LOT-9', 'RMA-123', current_date - 1, ckey);
  PERFORM pg_temp.assert_eq((j ->> 'created')::boolean, true, 'a complaint is made');
  PERFORM pg_temp.assert_eq(app.portal_raise_complaint(org, p_wayne, 'Bracket cracked on arrival', 'Three brackets in the delivery had cracks at the bend.', part_a, 3, 'LOT-9', 'RMA-123', current_date - 1, ckey) ->> 'id', j ->> 'id', 'a retry with the same key gives the same complaint');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.portal_complaints), 0::bigint, 'the person reads no tables');
  PERFORM pg_temp.logout();

  SELECT nonconformance_id INTO ncr FROM public.portal_complaints WHERE id = (j ->> 'id')::uuid;
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.nonconformances WHERE id = ncr AND stage = 'draft' AND source = 'customer' AND customer_id = wayne AND part_id = part_a AND quantity_affected = 3 AND lot_number = 'LOT-9' AND customer_reference = 'RMA-123'), 1::bigint, 'a draft customer non-conformance in their words');
  PERFORM pg_temp.assert_eq((SELECT severity IS NULL AND category_id IS NULL AND site_id IS NULL FROM public.nonconformances WHERE id = ncr), true, 'severity, category and site are for staff');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.portal_activity WHERE kind = 'complaint_raised' AND record_id = ncr), 1::bigint, 'staff are told');

  -- ---- what is refused ----
  PERFORM pg_temp.login(cus);
  r := pg_temp.fails(format($f$SELECT app.portal_raise_complaint(%L, %L, 'Wrong part', 'This is not even their part at all.', %L, 1, NULL, NULL, NULL, NULL)$f$, org, p_wayne, part_b));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'a part that is not theirs');
  r := pg_temp.fails(format($f$SELECT app.portal_raise_complaint(%L, %L, 'xx', 'A description that is long enough.', NULL, NULL, NULL, NULL, NULL, NULL)$f$, org, p_wayne));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'a title that is too short');
  r := pg_temp.fails(format($f$SELECT app.portal_raise_complaint(%L, %L, 'Future dated', 'A description that is long enough.', NULL, NULL, NULL, NULL, current_date + 1, NULL)$f$, org, p_wayne));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'a date in the future');
  r := pg_temp.fails(format($f$SELECT app.portal_raise_complaint(%L, %L, 'Not my party', 'A description that is long enough.', NULL, NULL, NULL, NULL, NULL, NULL)$f$, org, p_other));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'another customer''s party');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(sam);
  r := pg_temp.fails(format($f$SELECT app.portal_raise_complaint(%L, %L, 'From a supplier', 'A description that is long enough.', NULL, NULL, NULL, NULL, NULL, NULL)$f$, org, p_acme));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'a supplier cannot raise a complaint');
  PERFORM pg_temp.logout();

  -- ---- the list: own complaints, named fields, a plain status ----
  PERFORM pg_temp.login(cus);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.portal_list_complaints(org, p_wayne)), 1::bigint, 'one complaint');
  PERFORM pg_temp.assert_eq((SELECT status FROM app.portal_list_complaints(org, p_wayne)), 'received', 'a draft is "received"');
  PERFORM pg_temp.assert_eq((SELECT raised_by_me FROM app.portal_list_complaints(org, p_wayne)), true, 'and it is theirs');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cus2);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.portal_list_complaints(org, p_other)), 0::bigint, 'another customer sees none of it');
  PERFORM pg_temp.logout();

  -- ---- staff can stop a customer raising complaints ----
  PERFORM pg_temp.login(ann);
  PERFORM app.set_portal_party(org, 'customer', wayne, NULL, NULL, '{"complaints": false}'::jsonb);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cus);
  r := pg_temp.fails(format($f$SELECT app.portal_raise_complaint(%L, %L, 'Switched off', 'A description that is long enough.', NULL, NULL, NULL, NULL, NULL, NULL)$f$, org, p_wayne));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'switched off');
  PERFORM pg_temp.logout();

  -- ---- the record is frozen ----
  r := pg_temp.fails(format($f$DELETE FROM public.portal_complaints WHERE id = %L$f$, j ->> 'id'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'never deleted');
END $$;

ROLLBACK;
