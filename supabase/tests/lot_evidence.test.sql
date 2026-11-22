-- External portal PT5f: staff share a file on a lot with one customer; the customer sees only their own, nothing else; removal hides it at once; never deleted.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
  ('64000000-0000-0000-0000-000000000f01', 'ann@pt5f.test', now()), ('64000000-0000-0000-0000-000000000f02', 'insp@pt5f.test', now()),
  ('64000000-0000-0000-0000-000000000f05', 'cus@wayne.pt5f.test', now()), ('64000000-0000-0000-0000-000000000f06', 'cus2@other.pt5f.test', now());

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '64000000-0000-0000-0000-000000000f01'; insp uuid := '64000000-0000-0000-0000-000000000f02'; cus uuid := '64000000-0000-0000-0000-000000000f05'; cus2 uuid := '64000000-0000-0000-0000-000000000f06';
  org uuid; wayne uuid; other uuid; part uuid; lot uuid; lot2 uuid; p_wayne uuid; p_other uuid; a_cus uuid; a_cus2 uuid; f1 uuid; r text; k text; path text;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('PT5f Alpha'); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, insp, 'active');
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = 'inspector') FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id = insp;
  INSERT INTO public.customers (organisation_id, code, name) VALUES (org, 'WAYNE', 'Wayne Ltd'), (org, 'OTHER', 'Other Co');
  SELECT id INTO wayne FROM public.customers WHERE organisation_id = org AND code = 'WAYNE';
  SELECT id INTO other FROM public.customers WHERE organisation_id = org AND code = 'OTHER';
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'P-100', 'Bracket');
  SELECT id INTO part FROM public.parts WHERE organisation_id = org AND part_number = 'P-100';
  INSERT INTO public.part_customers (organisation_id, part_id, customer_id, is_primary) VALUES (org, part, wayne, true);
  INSERT INTO public.lots (organisation_id, lot_number, origin, part_id, quantity) VALUES (org, 'LOT-9', 'received', part, 10) RETURNING id INTO lot;
  PERFORM pg_temp.login(ann);
  PERFORM app.set_portal_settings(org, true, NULL, false);
  p_wayne := app.set_portal_party(org, 'customer', wayne, true);
  p_other := app.set_portal_party(org, 'customer', other, true);
  a_cus := app.invite_external_user(p_wayne, 'cus@wayne.pt5f.test', 'admin', NULL);
  a_cus2 := app.invite_external_user(p_other, 'cus2@other.pt5f.test', 'admin', NULL);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cus); PERFORM app.accept_portal_invitation(a_cus); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cus2); PERFORM app.accept_portal_invitation(a_cus2); PERFORM pg_temp.logout();

  -- ---- who a lot is for ----
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq((SELECT string_agg(customer_name, ',') FROM app.lot_evidence_customers(lot)), 'Wayne Ltd', 'only the customer its part is supplied to');
  path := org::text || '/lot/' || lot::text || '/aaaa-coc.pdf';
  PERFORM pg_temp.assert_eq(app.lot_evidence_file_allowed(path, true), true, 'staff may upload into the lot''s folder');
  r := pg_temp.fails(format($f$SELECT app.add_lot_evidence(%L, %L, 'certificate_of_conformance', 'Certificate', %L, 'coc.pdf', 'application/pdf', 100)$f$, lot, other, path));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'not to a customer the lot is not for');
  r := pg_temp.fails(format($f$SELECT app.add_lot_evidence(%L, %L, 'certificate_of_conformance', NULL, %L, 'coc.pdf', NULL, 100)$f$, lot, wayne, org::text || '/lot/' || gen_random_uuid()::text || '/x.pdf'));
  PERFORM pg_temp.assert_eq(left(r, 5), '23514', 'the file must sit in the lot''s folder');
  f1 := app.add_lot_evidence(lot, wayne, 'certificate_of_conformance', 'Certificate for LOT-9', path, 'coc.pdf', 'application/pdf', 100);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.lot_evidence_files), 1::bigint, 'staff read it');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login(insp);
  r := pg_temp.fails(format($f$SELECT app.add_lot_evidence(%L, %L, 'other', NULL, %L, 'x.pdf', NULL, 1)$f$, lot, wayne, org::text || '/lot/' || lot::text || '/x.pdf'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'an inspector cannot share');
  PERFORM pg_temp.assert_eq(app.lot_evidence_file_allowed(path, false), false, 'nor read the files');
  PERFORM pg_temp.logout();

  -- ---- the customer ----
  PERFORM pg_temp.login(cus);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.portal_list_evidence(org, p_wayne)), 1::bigint, 'they see the file shared with them');
  PERFORM pg_temp.assert_eq((SELECT lot_number || '/' || part_number || '/' || kind FROM app.portal_list_evidence(org, p_wayne)), 'LOT-9/P-100/certificate_of_conformance', 'with the lot and the part');
  PERFORM pg_temp.assert_eq((SELECT file_name FROM app.portal_evidence_file_path(f1)), 'coc.pdf', 'and can be given a link');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.lot_evidence_files), 0::bigint, 'they read no tables');
  r := pg_temp.fails(format($f$SELECT * FROM app.portal_list_evidence(%L, %L)$f$, org, p_other));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'not another customer''s party');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cus2);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.portal_list_evidence(org, p_other)), 0::bigint, 'another customer sees none');
  r := pg_temp.fails(format($f$SELECT * FROM app.portal_evidence_file_path(%L)$f$, f1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'and cannot open it');
  PERFORM pg_temp.logout();

  -- ---- taking it back hides it at once; nothing is deleted ----
  PERFORM pg_temp.login(ann);
  r := pg_temp.fails(format($f$SELECT app.remove_lot_evidence(%L, 'x')$f$, f1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'a reason is needed');
  PERFORM app.remove_lot_evidence(f1, 'Wrong certificate attached');
  PERFORM pg_temp.assert_eq((SELECT remove_reason FROM app.list_lot_evidence(lot)), 'Wrong certificate attached', 'staff still see it, with the reason');
  r := pg_temp.fails(format($f$DELETE FROM public.lot_evidence_files WHERE id = %L$f$, f1));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'never deleted');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cus);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.portal_list_evidence(org, p_wayne)), 0::bigint, 'the customer no longer sees it');
  r := pg_temp.fails(format($f$SELECT * FROM app.portal_evidence_file_path(%L)$f$, f1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'or opens it');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
