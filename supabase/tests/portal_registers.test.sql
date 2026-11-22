-- External portal PT6: the portal's NC and 8D registers list only records shared with the caller's own party, with named fields only.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
  ('60000000-0000-0000-0000-000000000e01', 'ann@pt6.test', now()), ('60000000-0000-0000-0000-000000000e04', 'sam@acme.pt6.test', now()),
  ('60000000-0000-0000-0000-000000000e05', 'cus@wayne.pt6.test', now());

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '60000000-0000-0000-0000-000000000e01'; sam uuid := '60000000-0000-0000-0000-000000000e04'; cus uuid := '60000000-0000-0000-0000-000000000e05';
  org uuid; site uuid; acme uuid; wayne uuid; p_acme uuid; p_wayne uuid; a_sam uuid; a_cus uuid;
  nc_s uuid; nc_s2 uuid; nc_c uuid; nc_draft uuid; capa uuid; sh_s uuid; sh_c uuid; sh_capa uuid; k text; cnt bigint;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('PT6 Alpha'); PERFORM pg_temp.logout();
  SELECT id INTO site FROM public.sites WHERE organisation_id = org LIMIT 1;
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'ACME', 'Acme Castings');
  INSERT INTO public.customers (organisation_id, code, name) VALUES (org, 'WAYNE', 'Wayne Ltd');
  SELECT id INTO acme FROM public.suppliers WHERE organisation_id = org AND code = 'ACME';
  SELECT id INTO wayne FROM public.customers WHERE organisation_id = org AND code = 'WAYNE';
  PERFORM pg_temp.login(ann);
  PERFORM app.set_portal_settings(org, true, NULL, false);
  p_acme := app.set_portal_party(org, 'supplier', acme, true);
  p_wayne := app.set_portal_party(org, 'customer', wayne, true);
  a_sam := app.invite_external_user(p_acme, 'sam@acme.pt6.test', 'admin', NULL);
  a_cus := app.invite_external_user(p_wayne, 'cus@wayne.pt6.test', 'admin', NULL);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(sam); PERFORM app.accept_portal_invitation(a_sam); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cus); PERFORM app.accept_portal_invitation(a_cus); PERFORM pg_temp.logout();

  INSERT INTO public.nonconformances (organisation_id, reference, source, stage, category_id, title, severity, quantity_affected, site_id, supplier_id, lot_number)
    VALUES (org, 'PT6-NC-1', 'supplier', 'open', pg_temp.cat(org), 'Bar stock out of size', 'major', 4, site, acme, 'L-77') RETURNING id INTO nc_s;
  INSERT INTO public.nonconformances (organisation_id, reference, source, stage, category_id, title, severity, quantity_affected, site_id, supplier_id)
    VALUES (org, 'PT6-NC-2', 'supplier', 'open', pg_temp.cat(org), 'Not shared', 'minor', 1, site, acme) RETURNING id INTO nc_s2;
  INSERT INTO public.nonconformances (organisation_id, reference, source, stage, category_id, title, severity, quantity_affected, site_id, customer_id, customer_reference)
    VALUES (org, 'PT6-NC-3', 'customer', 'open', pg_temp.cat(org), 'Bracket cracked', 'major', 3, site, wayne, 'WAY-9') RETURNING id INTO nc_c;
  PERFORM pg_temp.login(ann);
  sh_s := app.share_with_portal('ncr', nc_s, p_acme);
  sh_c := app.share_with_portal('ncr', nc_c, p_wayne);
  capa := app.start_capa(org, NULL, NULL, NULL, NULL, nc_s);
  sh_capa := app.share_with_portal('capa', capa, p_acme);
  PERFORM pg_temp.logout();

  -- ---- the supplier sees only its own shared NC, with the named fields ----
  PERFORM pg_temp.login(sam);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.portal_list_ncrs(org)), 1::bigint, 'one shared NC, not the unshared one, not the customer''s');
  SELECT string_agg(x, ',' ORDER BY x) INTO k FROM jsonb_object_keys((SELECT to_jsonb(r) FROM app.portal_list_ncrs(org) r LIMIT 1)) x;
  PERFORM pg_temp.assert_eq(k, 'closure_pending,comments,customer_reference,detected_at,last_comment_at,lot_number,new_comments,part_name,part_number,purchase_order,quantity_affected,reference,severity,share_id,shared_at,stage,title,viewed', 'the exact columns');
  PERFORM pg_temp.assert_eq((SELECT reference FROM app.portal_list_ncrs(org)), 'PT6-NC-1', 'its own NC');
  PERFORM pg_temp.assert_eq((SELECT lot_number FROM app.portal_list_ncrs(org)), 'L-77', 'with its lot');
  PERFORM pg_temp.assert_eq((SELECT viewed FROM app.portal_list_ncrs(org)), false, 'not opened yet');
  PERFORM app.portal_mark_viewed(sh_s);
  PERFORM pg_temp.assert_eq((SELECT viewed FROM app.portal_list_ncrs(org)), true, 'opened');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.portal_list_capas(org)), 1::bigint, 'the shared 8D');
  SELECT string_agg(x, ',' ORDER BY x) INTO k FROM jsonb_object_keys((SELECT to_jsonb(r) FROM app.portal_list_capas(org) r LIMIT 1)) x;
  PERFORM pg_temp.assert_eq(k, 'closed_at,closure_pending,comments,last_comment_at,new_comments,reference,severity,share_id,shared_at,stage,started_at,title,viewed', 'the exact 8D columns');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.nonconformances), 0::bigint, 'they read no tables');
  PERFORM pg_temp.logout();

  -- ---- the customer sees its own NC and no 8D ----
  PERFORM pg_temp.login(cus);
  PERFORM pg_temp.assert_eq((SELECT reference FROM app.portal_list_ncrs(org)), 'PT6-NC-3', 'the customer sees its own NC');
  PERFORM pg_temp.assert_eq((SELECT customer_reference FROM app.portal_list_ncrs(org)), 'WAY-9', 'with its own reference');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.portal_list_capas(org)), 0::bigint, 'and none of the supplier''s 8Ds');
  PERFORM pg_temp.logout();

  -- ---- stop sharing: it leaves the list at once ----
  PERFORM pg_temp.login(ann); PERFORM app.withdraw_portal_share(sh_s, 'No longer needed'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(sam);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.portal_list_ncrs(org)), 0::bigint, 'a withdrawn share is gone');
  PERFORM pg_temp.logout();

  -- ---- anyone else, a staff member and anon get nothing ----
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.portal_list_ncrs(org)), 0::bigint, 'staff are not listed here: they have no portal access');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(has_function_privilege('anon', 'app.portal_list_ncrs(uuid)', 'execute'), false, 'anon cannot run the NC list');
  PERFORM pg_temp.assert_eq(has_function_privilege('anon', 'app.portal_list_capas(uuid)', 'execute'), false, 'anon cannot run the 8D list');
END $$;
ROLLBACK;
