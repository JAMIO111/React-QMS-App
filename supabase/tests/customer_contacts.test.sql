-- External portal PT5c (X17): customer contacts — several per customer, one primary, never deleted, staff only, tenant-isolated.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
  ('61000000-0000-0000-0000-000000000f01', 'ann@pt5c.test', now()), ('61000000-0000-0000-0000-000000000f02', 'viewer@pt5c.test', now()), ('61000000-0000-0000-0000-000000000f03', 'eve@pt5c.test', now());

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '61000000-0000-0000-0000-000000000f01'; viewer uuid := '61000000-0000-0000-0000-000000000f02'; eve uuid := '61000000-0000-0000-0000-000000000f03';
  org uuid; org2 uuid; wayne uuid; c1 uuid; c2 uuid; r text;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('PT5c Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('PT5c Beta'); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, viewer, 'active');
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = 'viewer') FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id = viewer;
  INSERT INTO public.customers (organisation_id, code, name) VALUES (org, 'WAYNE', 'Wayne Ltd');
  SELECT id INTO wayne FROM public.customers WHERE organisation_id = org AND code = 'WAYNE';

  PERFORM pg_temp.login(ann);
  INSERT INTO public.customer_contacts (organisation_id, customer_id, name, role, email, is_primary) VALUES (org, wayne, 'Pat Quality', 'quality', 'pat@wayne.test', true) RETURNING id INTO c1;
  INSERT INTO public.customer_contacts (organisation_id, customer_id, name, role, is_primary) VALUES (org, wayne, 'Sam Buyer', 'purchasing', true) RETURNING id INTO c2;
  PERFORM pg_temp.assert_eq((SELECT is_primary FROM public.customer_contacts WHERE id = c1), false, 'a new primary replaces the old');
  PERFORM pg_temp.assert_eq((SELECT is_primary FROM public.customer_contacts WHERE id = c2), true, 'and is the primary');
  UPDATE public.customer_contacts SET active = false WHERE id = c2;
  PERFORM pg_temp.assert_eq((SELECT is_primary FROM public.customer_contacts WHERE id = c2), false, 'an inactive contact cannot stay primary');
  r := pg_temp.fails(format($f$DELETE FROM public.customer_contacts WHERE id = %L$f$, c1));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'contacts are never deleted');
  r := pg_temp.fails(format($f$UPDATE public.customer_contacts SET customer_id = gen_random_uuid() WHERE id = %L$f$, c1));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a contact keeps its customer');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login(viewer);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.customer_contacts), 2::bigint, 'a viewer reads them');
  r := pg_temp.fails(format($f$INSERT INTO public.customer_contacts (organisation_id, customer_id, name) VALUES (%L, %L, 'Nope')$f$, org, wayne));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'but cannot add one');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login(eve);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.customer_contacts), 0::bigint, 'another organisation sees none');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
