-- External portal PT5b: staff ask a customer to confirm closure of a shared NC; the customer confirms or declines with a note; suppliers are never asked;
-- one request waits at a time; a decision is final; nothing internal changes.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
  ('60000000-0000-0000-0000-000000000f01', 'ann@pt5b.test', now()), ('60000000-0000-0000-0000-000000000f04', 'sam@acme.pt5b.test', now()),
  ('60000000-0000-0000-0000-000000000f05', 'cus@wayne.pt5b.test', now()), ('60000000-0000-0000-0000-000000000f06', 'cus2@other.pt5b.test', now());

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '60000000-0000-0000-0000-000000000f01'; sam uuid := '60000000-0000-0000-0000-000000000f04'; cus uuid := '60000000-0000-0000-0000-000000000f05'; cus2 uuid := '60000000-0000-0000-0000-000000000f06';
  org uuid; site uuid; acme uuid; wayne uuid; other uuid; p_acme uuid; p_wayne uuid; p_other uuid; a_sam uuid; a_cus uuid; a_cus2 uuid; nc_c uuid; nc_s uuid;
  sh_c uuid; sh_s uuid; req uuid; req2 uuid; r text; j jsonb; k text; stage_before text;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('PT5b Alpha'); PERFORM pg_temp.logout();
  SELECT id INTO site FROM public.sites WHERE organisation_id = org LIMIT 1;
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'ACME', 'Acme Castings');
  INSERT INTO public.customers (organisation_id, code, name) VALUES (org, 'WAYNE', 'Wayne Ltd'), (org, 'OTHER', 'Other Co');
  SELECT id INTO acme FROM public.suppliers WHERE organisation_id = org AND code = 'ACME';
  SELECT id INTO wayne FROM public.customers WHERE organisation_id = org AND code = 'WAYNE';
  SELECT id INTO other FROM public.customers WHERE organisation_id = org AND code = 'OTHER';
  PERFORM pg_temp.login(ann);
  PERFORM app.set_portal_settings(org, true, NULL, false);
  p_acme := app.set_portal_party(org, 'supplier', acme, true);
  p_wayne := app.set_portal_party(org, 'customer', wayne, true, 'Pat in Quality');
  p_other := app.set_portal_party(org, 'customer', other, true);
  a_sam := app.invite_external_user(p_acme, 'sam@acme.pt5b.test', 'admin', NULL);
  a_cus := app.invite_external_user(p_wayne, 'cus@wayne.pt5b.test', 'admin', NULL);
  a_cus2 := app.invite_external_user(p_other, 'cus2@other.pt5b.test', 'admin', NULL);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(sam); PERFORM app.accept_portal_invitation(a_sam); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cus); PERFORM app.accept_portal_invitation(a_cus); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cus2); PERFORM app.accept_portal_invitation(a_cus2); PERFORM pg_temp.logout();
  INSERT INTO public.nonconformances (organisation_id, reference, source, stage, category_id, title, description, severity, quantity_affected, site_id, customer_id)
    VALUES (org, 'PT5B-NC-1', 'customer', 'open', pg_temp.cat(org), 'Bracket cracked', 'Cracks at the bend', 'major', 3, site, wayne) RETURNING id INTO nc_c;
  INSERT INTO public.nonconformances (organisation_id, reference, source, stage, category_id, title, severity, quantity_affected, site_id, supplier_id)
    VALUES (org, 'PT5B-NC-2', 'supplier', 'open', pg_temp.cat(org), 'Bar stock', 'minor', 1, site, acme) RETURNING id INTO nc_s;
  PERFORM pg_temp.login(ann);
  sh_c := app.share_with_portal('ncr', nc_c, p_wayne);
  sh_s := app.share_with_portal('ncr', nc_s, p_acme);
  PERFORM pg_temp.logout();

  -- ---- staff ask the customer; a supplier is never asked ----
  PERFORM pg_temp.login(ann);
  r := pg_temp.fails(format($f$SELECT app.request_portal_closure(%L, 'Please confirm')$f$, sh_s));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'a supplier is not asked to confirm closure');
  req := app.request_portal_closure(sh_c, 'We believe this is resolved. Please confirm.');
  r := pg_temp.fails(format($f$SELECT app.request_portal_closure(%L, NULL)$f$, sh_c));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'one request waits at a time');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(sam);
  r := pg_temp.fails(format($f$SELECT app.request_portal_closure(%L, NULL)$f$, sh_c));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'an external person cannot ask');
  PERFORM pg_temp.logout();

  -- ---- what the customer sees ----
  PERFORM pg_temp.login(cus);
  j := app.portal_share_closures(sh_c);
  PERFORM pg_temp.assert_eq(jsonb_array_length(j), 1, 'one request');
  SELECT string_agg(x, ',' ORDER BY x) INTO k FROM jsonb_object_keys(j -> 0) x;
  PERFORM pg_temp.assert_eq(k, 'canDecide,decidedAt,decidedBy,decisionNote,id,requestNote,requestedAt,requestedBy,status,withdrawnReason', 'the keys (staff names and withdrawal reasons are null for the customer)');
  PERFORM pg_temp.assert_eq((j -> 0 ->> 'canDecide')::boolean, true, 'they may answer');
  PERFORM pg_temp.assert_eq(j -> 0 -> 'requestedBy' = 'null'::jsonb, true, 'staff are not named to them');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.portal_pending_closures(org)), 1::bigint, 'it is waiting for them');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.portal_closure_requests), 0::bigint, 'they read no tables');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cus2);
  r := pg_temp.fails(format($f$SELECT app.portal_share_closures(%L)$f$, sh_c));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'another customer sees nothing of it');
  r := pg_temp.fails(format($f$SELECT app.portal_decide_closure(%L, true, NULL)$f$, req));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'nor can they answer it');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.portal_pending_closures(org)), 0::bigint, 'nothing waits for them');
  PERFORM pg_temp.logout();

  -- ---- the customer is not satisfied: a note is needed, and the decision is final ----
  SELECT stage INTO stage_before FROM public.nonconformances WHERE id = nc_c;
  PERFORM pg_temp.login(cus);
  r := pg_temp.fails(format($f$SELECT app.portal_decide_closure(%L, false, NULL)$f$, req));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'declining needs a reason');
  PERFORM app.portal_decide_closure(req, false, 'Two more brackets cracked last week.');
  r := pg_temp.fails(format($f$SELECT app.portal_decide_closure(%L, true, NULL)$f$, req));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'a decision is final');
  j := app.portal_share_closures(sh_c);
  PERFORM pg_temp.assert_eq(j -> 0 ->> 'status', 'declined', 'declined');
  PERFORM pg_temp.assert_eq(j -> 0 ->> 'decisionNote', 'Two more brackets cracked last week.', 'with their words');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.nonconformances WHERE id = nc_c), stage_before, 'nothing internal changed');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.portal_activity WHERE kind = 'closure_declined' AND record_id = nc_c), 1::bigint, 'staff are told');

  -- ---- a second request, confirmed; staff withdraw a third ----
  PERFORM pg_temp.login(ann);
  req2 := app.request_portal_closure(sh_c, NULL);
  PERFORM pg_temp.assert_eq(jsonb_array_length(app.portal_share_closures(sh_c)), 2, 'staff see both');
  PERFORM pg_temp.assert_eq(app.portal_share_closures(sh_c) -> 1 ->> 'decidedBy', 'cus', 'and who answered');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cus);
  PERFORM app.portal_decide_closure(req2, true, NULL);
  PERFORM pg_temp.assert_eq(app.portal_share_closures(sh_c) -> 0 ->> 'status', 'confirmed', 'confirmed');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.portal_activity WHERE kind = 'closure_confirmed' AND record_id = nc_c), 1::bigint, 'staff are told');
  PERFORM pg_temp.login(ann);
  req := app.request_portal_closure(sh_c, NULL);
  r := pg_temp.fails(format($f$SELECT app.withdraw_portal_closure(%L, 'x')$f$, req));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'a withdrawal needs a reason');
  PERFORM app.withdraw_portal_closure(req, 'Raised too early');
  r := pg_temp.fails(format($f$SELECT app.withdraw_portal_closure(%L, 'Again for no reason')$f$, req));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'only a waiting request can be withdrawn');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cus);
  PERFORM pg_temp.assert_eq(jsonb_array_length(app.portal_share_closures(sh_c)), 2, 'a withdrawn request is not shown to the customer');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.portal_pending_closures(org)), 0::bigint, 'and nothing waits');
  PERFORM pg_temp.logout();

  -- ---- frozen, and a withdrawn share hides it ----
  r := pg_temp.fails(format($f$DELETE FROM public.portal_closure_requests WHERE id = %L$f$, req2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'never deleted');
  r := pg_temp.fails(format($f$UPDATE public.portal_closure_requests SET status = 'pending', decided_at = NULL WHERE id = %L$f$, req2));
  PERFORM pg_temp.assert_eq(left(r, 5) IN ('QM032', '23514'), true, 'an answered request does not change');
END $$;

ROLLBACK;
