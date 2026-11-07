-- Sites carry a currency: new sites start with the organisation's currency, an explicit one is kept, it must be a 3-letter code, admins change it, others cannot.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES ('20000000-0000-0000-0000-0000000000e1', 'owner@cur.test'), ('20000000-0000-0000-0000-0000000000e2', 'viewer@cur.test');

DO $$
DECLARE
  u_owner uuid := '20000000-0000-0000-0000-0000000000e1'; u_view uuid := '20000000-0000-0000-0000-0000000000e2';
  org uuid; s1 uuid; s2 uuid; s3 uuid; m uuid; viewer_role uuid; ok boolean;
BEGIN
  PERFORM pg_temp.login(u_owner);
  org := app.create_organisation('Currency Works', 'Plant', 'PL', NULL);
  PERFORM pg_temp.assert_eq((SELECT currency FROM public.sites WHERE organisation_id = org AND code = 'PL'), 'GBP', 'the first site takes the organisation currency');

  UPDATE public.organisation_settings SET base_currency = 'EUR' WHERE organisation_id = org;
  INSERT INTO public.sites (organisation_id, code, name) VALUES (org, 'DE', 'Germany') RETURNING id INTO s1;
  PERFORM pg_temp.assert_eq((SELECT currency FROM public.sites WHERE id = s1), 'EUR', 'a new site starts with the organisation currency as it is now');
  PERFORM pg_temp.assert_eq((SELECT currency FROM public.sites WHERE organisation_id = org AND code = 'PL'), 'GBP', 'changing the organisation currency leaves existing sites alone');

  INSERT INTO public.sites (organisation_id, code, name, currency) VALUES (org, 'US', 'America', 'USD') RETURNING id INTO s2;
  PERFORM pg_temp.assert_eq((SELECT currency FROM public.sites WHERE id = s2), 'USD', 'an explicit currency is kept');

  UPDATE public.sites SET currency = 'PLN' WHERE id = s2;
  PERFORM pg_temp.assert_eq((SELECT currency FROM public.sites WHERE id = s2), 'PLN', 'an admin can change it');

  ok := false;
  BEGIN INSERT INTO public.sites (organisation_id, code, name, currency) VALUES (org, 'XX', 'Bad', 'usd'); EXCEPTION WHEN check_violation THEN ok := true; END;
  PERFORM pg_temp.assert_eq(ok, true, 'lower case is refused');
  ok := false;
  BEGIN UPDATE public.sites SET currency = 'POUNDS' WHERE id = s2; EXCEPTION WHEN check_violation THEN ok := true; END;
  PERFORM pg_temp.assert_eq(ok, true, 'a long code is refused');
  ok := false;
  BEGIN UPDATE public.sites SET currency = NULL WHERE id = s2; EXCEPTION WHEN not_null_violation THEN ok := true; END;
  PERFORM pg_temp.assert_eq(ok, true, 'it cannot be removed');
  PERFORM pg_temp.logout();

  -- A member without rights over the organisation's structure cannot change it.
  SELECT id INTO viewer_role FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  INSERT INTO public.organisation_users (organisation_id, user_id, status, joined_at) VALUES (org, u_view, 'active', now()) RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) VALUES (org, m, viewer_role);
  PERFORM pg_temp.login(u_view);
  UPDATE public.sites SET currency = 'JPY' WHERE id = s2;
  PERFORM pg_temp.assert_eq((SELECT currency FROM public.sites WHERE id = s2), 'PLN', 'a viewer cannot change it');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.assert_eq((SELECT count(*) > 0 FROM public.audit_events WHERE organisation_id = org AND entity_type = 'sites' AND action = 'update' AND changed_fields @> ARRAY['currency']), true, 'the change is audited');
END $$;
ROLLBACK;
