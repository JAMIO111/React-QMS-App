-- External portal PT5d: a customer's own quality figures — counts only, their NCs and the 8Ds linked to them, nobody else's.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
  ('62000000-0000-0000-0000-000000000f01', 'ann@pt5d.test', now()), ('62000000-0000-0000-0000-000000000f04', 'sam@acme.pt5d.test', now()),
  ('62000000-0000-0000-0000-000000000f05', 'cus@wayne.pt5d.test', now()), ('62000000-0000-0000-0000-000000000f06', 'cus2@other.pt5d.test', now());

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '62000000-0000-0000-0000-000000000f01'; sam uuid := '62000000-0000-0000-0000-000000000f04'; cus uuid := '62000000-0000-0000-0000-000000000f05'; cus2 uuid := '62000000-0000-0000-0000-000000000f06';
  org uuid; site uuid; acme uuid; wayne uuid; other uuid; p_acme uuid; p_wayne uuid; p_other uuid; a_sam uuid; a_cus uuid; a_cus2 uuid; n1 uuid; n2 uuid; j jsonb; r text; k text;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('PT5d Alpha'); PERFORM pg_temp.logout();
  SELECT id INTO site FROM public.sites WHERE organisation_id = org LIMIT 1;
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'ACME', 'Acme Castings');
  INSERT INTO public.customers (organisation_id, code, name) VALUES (org, 'WAYNE', 'Wayne Ltd'), (org, 'OTHER', 'Other Co');
  SELECT id INTO acme FROM public.suppliers WHERE organisation_id = org AND code = 'ACME';
  SELECT id INTO wayne FROM public.customers WHERE organisation_id = org AND code = 'WAYNE';
  SELECT id INTO other FROM public.customers WHERE organisation_id = org AND code = 'OTHER';
  PERFORM pg_temp.login(ann);
  PERFORM app.set_portal_settings(org, true, NULL, false);
  p_acme := app.set_portal_party(org, 'supplier', acme, true);
  p_wayne := app.set_portal_party(org, 'customer', wayne, true);
  p_other := app.set_portal_party(org, 'customer', other, true);
  a_sam := app.invite_external_user(p_acme, 'sam@acme.pt5d.test', 'admin', NULL);
  a_cus := app.invite_external_user(p_wayne, 'cus@wayne.pt5d.test', 'admin', NULL);
  a_cus2 := app.invite_external_user(p_other, 'cus2@other.pt5d.test', 'admin', NULL);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(sam); PERFORM app.accept_portal_invitation(a_sam); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cus); PERFORM app.accept_portal_invitation(a_cus); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cus2); PERFORM app.accept_portal_invitation(a_cus2); PERFORM pg_temp.logout();

  INSERT INTO public.nonconformances (organisation_id, reference, source, stage, category_id, title, severity, quantity_affected, site_id, customer_id, detected_at)
    VALUES (org, 'PT5D-1', 'customer', 'open', pg_temp.cat(org), 'Open major', 'major', 3, site, wayne, current_date - 10) RETURNING id INTO n1;
  INSERT INTO public.nonconformances (organisation_id, reference, source, stage, category_id, title, severity, quantity_affected, site_id, customer_id, detected_at)
    VALUES (org, 'PT5D-2', 'customer', 'open', pg_temp.cat(org), 'Minor', 'minor', 1, site, wayne, current_date - 4) RETURNING id INTO n2;
  INSERT INTO public.nonconformances (organisation_id, reference, source, stage, category_id, title, severity, quantity_affected, site_id, customer_id, detected_at)
    VALUES (org, 'PT5D-3', 'customer', 'open', pg_temp.cat(org), 'Someone else', 'critical', 1, site, other, current_date - 2);
  INSERT INTO public.nonconformances (organisation_id, reference, source, title, severity, quantity_affected, site_id, customer_id)
    VALUES (org, 'PT5D-4', 'customer', 'A draft', 'critical', 1, site, wayne);

  -- ---- their figures: counts only, their own ----
  PERFORM pg_temp.login(cus);
  j := app.portal_get_customer_figures(org, p_wayne, 90);
  SELECT string_agg(x, ',' ORDER BY x) INTO k FROM jsonb_object_keys(j) x;
  PERFORM pg_temp.assert_eq(k, 'available,capas,ncs,period', 'the top-level keys');
  SELECT string_agg(x, ',' ORDER BY x) INTO k FROM jsonb_object_keys(j -> 'ncs') x;
  PERFORM pg_temp.assert_eq(k, 'averageDaysToClose,averageOpenDays,closedInPeriod,critical,major,minor,oldestOpenDays,open,raised', 'NC figures: counts and averages only');
  SELECT string_agg(x, ',' ORDER BY x) INTO k FROM jsonb_object_keys(j -> 'capas') x;
  PERFORM pg_temp.assert_eq(k, 'averageDaysToClose,closedInPeriod,inProgress,started', '8D figures');
  PERFORM pg_temp.assert_eq((j -> 'ncs' ->> 'raised')::int, 2, 'two raised against them (a draft and another customer''s are not counted)');
  PERFORM pg_temp.assert_eq((j -> 'ncs' ->> 'major')::int, 1, 'one major');
  PERFORM pg_temp.assert_eq((j -> 'ncs' ->> 'open')::int, 2, 'two open');
  PERFORM pg_temp.assert_eq((j -> 'ncs' ->> 'oldestOpenDays')::int, 10, 'the oldest is ten days old');
  PERFORM pg_temp.assert_eq((j -> 'capas' ->> 'started')::int, 0, 'no 8D yet');
  PERFORM pg_temp.assert_eq((app.portal_get_customer_figures(org, p_wayne, 30) -> 'period' ->> 'days')::int, 30, 'the period asked for');
  r := pg_temp.fails(format($f$SELECT app.portal_get_customer_figures(%L, %L, 45)$f$, org, p_wayne));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'only 30, 90 or 365 days');
  r := pg_temp.fails(format($f$SELECT app.portal_get_customer_figures(%L, %L, 90)$f$, org, p_other));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'another customer''s party is not theirs');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login(cus2);
  PERFORM pg_temp.assert_eq((app.portal_get_customer_figures(org, p_other, 90) -> 'ncs' ->> 'raised')::int, 1, 'another customer sees only theirs');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(sam);
  r := pg_temp.fails(format($f$SELECT app.portal_get_customer_figures(%L, %L, 90)$f$, org, p_acme));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'a supplier has no customer figures');
  PERFORM pg_temp.logout();

  -- ---- staff can switch the figures off ----
  PERFORM pg_temp.login(ann);
  PERFORM app.set_portal_party(org, 'customer', wayne, NULL, NULL, '{"figures": false}'::jsonb);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cus);
  j := app.portal_get_customer_figures(org, p_wayne, 90);
  PERFORM pg_temp.assert_eq((j ->> 'available')::boolean, false, 'switched off');
  PERFORM pg_temp.assert_eq(j ? 'ncs', false, 'and nothing else is given');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
