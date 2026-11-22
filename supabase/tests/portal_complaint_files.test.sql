-- External portal PT5e: a customer adds files to a complaint they raised — only while it is a draft, at most ten, only their own party's, never staff's files.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
  ('63000000-0000-0000-0000-000000000f01', 'ann@pt5e.test', now()), ('63000000-0000-0000-0000-000000000f05', 'cus@wayne.pt5e.test', now()), ('63000000-0000-0000-0000-000000000f06', 'cus2@other.pt5e.test', now());

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '63000000-0000-0000-0000-000000000f01'; cus uuid := '63000000-0000-0000-0000-000000000f05'; cus2 uuid := '63000000-0000-0000-0000-000000000f06';
  org uuid; wayne uuid; other uuid; p_wayne uuid; p_other uuid; a_cus uuid; a_cus2 uuid; j jsonb; comp uuid; ncr uuid; f1 uuid; f2 uuid; staff_file uuid; r text; i int; path text;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('PT5e Alpha'); PERFORM pg_temp.logout();
  INSERT INTO public.customers (organisation_id, code, name) VALUES (org, 'WAYNE', 'Wayne Ltd'), (org, 'OTHER', 'Other Co');
  SELECT id INTO wayne FROM public.customers WHERE organisation_id = org AND code = 'WAYNE';
  SELECT id INTO other FROM public.customers WHERE organisation_id = org AND code = 'OTHER';
  PERFORM pg_temp.login(ann);
  PERFORM app.set_portal_settings(org, true, NULL, false);
  p_wayne := app.set_portal_party(org, 'customer', wayne, true);
  p_other := app.set_portal_party(org, 'customer', other, true);
  a_cus := app.invite_external_user(p_wayne, 'cus@wayne.pt5e.test', 'admin', NULL);
  a_cus2 := app.invite_external_user(p_other, 'cus2@other.pt5e.test', 'admin', NULL);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cus); PERFORM app.accept_portal_invitation(a_cus); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cus2); PERFORM app.accept_portal_invitation(a_cus2); PERFORM pg_temp.logout();

  PERFORM pg_temp.login(cus);
  j := app.portal_raise_complaint(org, p_wayne, 'Bracket cracked', 'Three brackets cracked at the bend.', NULL, NULL, NULL, NULL, NULL, NULL);
  comp := (j ->> 'id')::uuid;
  PERFORM pg_temp.logout();
  SELECT nonconformance_id INTO ncr FROM public.portal_complaints WHERE id = comp;
  -- a staff file already on the NC, which the customer must never see
  INSERT INTO public.ncr_attachments (organisation_id, nonconformance_id, storage_path, file_name, size_bytes, created_by)
    VALUES (org, ncr, org::text || '/ncr/' || ncr::text || '/staff-internal.pdf', 'staff-internal.pdf', 10, ann) RETURNING id INTO staff_file;

  -- ---- adding files ----
  PERFORM pg_temp.login(cus);
  path := org::text || '/ncr/' || ncr::text || '/aaaa-photo.jpg';
  PERFORM pg_temp.assert_eq(app.portal_complaint_upload_allowed(comp, path), true, 'a file in the complaint''s folder is allowed');
  PERFORM pg_temp.assert_eq(app.portal_complaint_upload_allowed(comp, org::text || '/ncr/' || gen_random_uuid()::text || '/x.jpg'), false, 'not in another record''s folder');
  PERFORM pg_temp.assert_eq(app.portal_complaint_upload_allowed(comp, org::text || '/ncr/' || ncr::text || '/../x.jpg'), false, 'no path tricks');
  f1 := app.portal_add_complaint_file(comp, path, 'photo.jpg', 'image/jpeg', 1000);
  r := pg_temp.fails(format($f$SELECT app.portal_add_complaint_file(%L, %L, 'big.bin', NULL, 99999999)$f$, comp, org::text || '/ncr/' || ncr::text || '/bbbb-big.bin'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'over 25 MB is refused');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.portal_complaint_files(org, p_wayne)), 1::bigint, 'they see their own file only, not staff''s');
  PERFORM pg_temp.assert_eq((SELECT can_remove FROM app.portal_complaint_files(org, p_wayne)), true, 'and may take it back while it is a draft');
  PERFORM pg_temp.assert_eq((SELECT file_name FROM app.portal_complaint_file_path(f1)), 'photo.jpg', 'a download link can be made for it');
  r := pg_temp.fails(format($f$SELECT * FROM app.portal_complaint_file_path(%L)$f$, staff_file));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'but not for a staff file');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.ncr_attachments WHERE nonconformance_id = ncr AND deleted_at IS NULL), 2::bigint, 'staff see both on the NC page');

  -- ---- the limit of ten ----
  PERFORM pg_temp.login(cus);
  FOR i IN 2..10 LOOP
    PERFORM app.portal_add_complaint_file(comp, org::text || '/ncr/' || ncr::text || '/f' || i || '-x.jpg', 'x' || i || '.jpg', NULL, 10);
  END LOOP;
  r := pg_temp.fails(format($f$SELECT app.portal_add_complaint_file(%L, %L, 'eleven.jpg', NULL, 10)$f$, comp, org::text || '/ncr/' || ncr::text || '/f11-x.jpg'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'the eleventh is refused');
  f2 := app.portal_remove_complaint_file(f1);
  PERFORM pg_temp.assert_eq(f2, comp, 'taking one back answers with the complaint');
  PERFORM app.portal_add_complaint_file(comp, org::text || '/ncr/' || ncr::text || '/f11-x.jpg', 'eleven.jpg', NULL, 10);
  r := pg_temp.fails(format($f$SELECT app.portal_remove_complaint_file(%L)$f$, staff_file));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'a staff file cannot be taken back');
  PERFORM pg_temp.logout();

  -- ---- another customer ----
  PERFORM pg_temp.login(cus2);
  r := pg_temp.fails(format($f$SELECT app.portal_complaint_upload_allowed(%L, 'x')$f$, comp));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'another customer cannot add to it');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.portal_complaint_files(org, p_other)), 0::bigint, 'nor see its files');
  PERFORM pg_temp.logout();

  -- ---- once staff open it, the customer's files are fixed ----
  UPDATE public.nonconformances SET stage = 'open', severity = 'minor', category_id = pg_temp.cat(org), quantity_affected = 3, site_id = (SELECT id FROM public.sites WHERE organisation_id = org LIMIT 1) WHERE id = ncr;
  PERFORM pg_temp.login(cus);
  PERFORM pg_temp.assert_eq(app.portal_complaint_upload_allowed(comp, org::text || '/ncr/' || ncr::text || '/late.jpg'), false, 'no more files once we are working on it');
  PERFORM pg_temp.assert_eq((SELECT bool_or(can_remove) FROM app.portal_complaint_files(org, p_wayne)), false, 'and none can be taken back');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
