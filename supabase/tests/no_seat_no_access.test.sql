-- No seat, no access (docs/seats-and-member-onboarding-plan.md SM3, SM5): in an organisation that enforces packages, an active member without a
-- seat is not a member (two-factor / single sign-on gate), unless their role holds an admin right; the people who give seats are told when
-- someone joins without one, and the waiting person can remind them once a day; giving a seat lets them in. Grandfathered organisations are
-- unchanged.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

CREATE FUNCTION pg_temp.fails_with(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

INSERT INTO auth.users (id, email) VALUES
  ('5f500000-0000-0000-0000-000000000101', 'owner@seats.test'),
  ('5f500000-0000-0000-0000-000000000102', 'new@seats.test'),
  ('5f500000-0000-0000-0000-000000000103', 'admin@seats.test'),
  ('5f500000-0000-0000-0000-000000000104', 'old@seats.test');
INSERT INTO public.profiles (id, first_name, surname) VALUES ('5f500000-0000-0000-0000-000000000102', 'Nina', 'New')
  ON CONFLICT (id) DO UPDATE SET first_name = EXCLUDED.first_name, surname = EXCLUDED.surname;
INSERT INTO public.profiles (id, first_name, surname) VALUES ('5f500000-0000-0000-0000-000000000101', 'Olga', 'Owner')
  ON CONFLICT (id) DO UPDATE SET first_name = EXCLUDED.first_name, surname = EXCLUDED.surname;

CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);
GRANT SELECT ON ids TO authenticated;

DO $$
DECLARE org uuid; old_org uuid; inv uuid; adm uuid; r text;
BEGIN
  PERFORM pg_temp.login('5f500000-0000-0000-0000-000000000101');
  org := app.create_organisation('Seat Works', 'Plant A', 'PA', NULL);
  old_org := app.create_organisation('Old Works', 'Plant B', 'PB', NULL);
  PERFORM app.set_subscription_seats(org, 'controller', 2);
  PERFORM app.assign_subscription_package((SELECT id FROM public.organisation_users WHERE organisation_id = org AND user_id = '5f500000-0000-0000-0000-000000000101'), 'controller');
  PERFORM pg_temp.logout();
  UPDATE public.organisation_settings SET entitlements_enforced = true WHERE organisation_id = org;

  -- an invitation with no seat reserved, and an admin with no seat
  INSERT INTO public.organisation_users (organisation_id, invited_email, status, invited_at) VALUES (org, 'new@seats.test', 'invited', now()) RETURNING id INTO inv;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, inv, id FROM public.roles WHERE organisation_id = org AND key = 'quality_manager';
  INSERT INTO public.organisation_users (organisation_id, user_id, status, joined_at) VALUES (org, '5f500000-0000-0000-0000-000000000103', 'active', now()) RETURNING id INTO adm;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, adm, id FROM public.roles WHERE organisation_id = org AND key = 'admin';
  -- a grandfathered organisation: a member without a seat
  INSERT INTO public.organisation_users (organisation_id, user_id, status, joined_at) VALUES (old_org, '5f500000-0000-0000-0000-000000000104', 'active', now());
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT old_org, (SELECT id FROM public.organisation_users WHERE organisation_id = old_org AND user_id = '5f500000-0000-0000-0000-000000000104'), id
      FROM public.roles WHERE organisation_id = old_org AND key = 'viewer';
  SET CONSTRAINTS public.organisation_users_seat_request IMMEDIATE;
  SET CONSTRAINTS public.organisation_users_seat_request DEFERRED;
  INSERT INTO ids VALUES ('org', org), ('old', old_org), ('inv', inv), ('adm', adm);

  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.seat_requests WHERE organisation_id = org), 0::bigint,
    'nobody is waiting yet: the owner has a seat, the admin an admin right, the invitation is not accepted');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.seat_requests WHERE organisation_id = old_org), 0::bigint, 'grandfathered: nobody waits');
END $$;

-- ---- accepting the invitation without a seat ----
DO $$
DECLARE org uuid := (SELECT v FROM ids WHERE k = 'org'); r text; n int;
BEGIN
  PERFORM pg_temp.login('5f500000-0000-0000-0000-000000000102');
  PERFORM app.accept_invitation((SELECT v FROM ids WHERE k = 'inv'));
  PERFORM pg_temp.logout();
  SET CONSTRAINTS public.organisation_users_seat_request IMMEDIATE;
  SET CONSTRAINTS public.organisation_users_seat_request DEFERRED;
  PERFORM pg_temp.assert_eq((SELECT summary FROM public.seat_requests WHERE organisation_id = org AND kind = 'joined'),
    'Nina New joined and is waiting for a seat', 'the wait is written down');

  PERFORM pg_temp.login('5f500000-0000-0000-0000-000000000102');
  PERFORM pg_temp.assert_eq(app.is_member(org), false, 'without a seat they are not a member');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'ncr.read'), false, 'nor hold any right');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.my_visible_permissions(org)), 0::bigint, 'and nothing is shown');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.organisation_settings WHERE organisation_id = org), 0::bigint, 'RLS follows');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.seat_blocked_organisations() WHERE organisation_id = org), 1::bigint, 'the API is told why');
  PERFORM pg_temp.assert_eq((app.my_seat_wait(org)) ->> 'waiting', 'true', 'the waiting screen knows');
  PERFORM pg_temp.assert_eq((app.my_seat_wait(org)) -> 'managers', '["Olga Owner", "admin@seats.test"]'::jsonb, 'and who can give a seat (owners and admins)');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.seat_requests WHERE organisation_id = org), 1::bigint, 'they read their own wait');
  r := pg_temp.fails_with(format($f$SELECT app.remind_seat_managers(%L)$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM009', 'not reminded twice in a day');
  PERFORM pg_temp.logout();

  -- the owner is told
  PERFORM pg_temp.login('5f500000-0000-0000-0000-000000000101');
  SELECT count(*) INTO n FROM app.visible_notifications(org) WHERE entity_type = 'seat_requests';
  PERFORM pg_temp.assert_eq(n, 1, 'the people who give seats are told');
  PERFORM pg_temp.logout();

  -- a day later they may remind them
  ALTER TABLE public.seat_requests DISABLE TRIGGER seat_requests_frozen;
  UPDATE public.seat_requests SET created_at = now() - interval '25 hours' WHERE organisation_id = org;
  ALTER TABLE public.seat_requests ENABLE TRIGGER seat_requests_frozen;
  PERFORM pg_temp.login('5f500000-0000-0000-0000-000000000102');
  PERFORM app.remind_seat_managers(org);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.seat_requests WHERE organisation_id = org AND kind = 'reminder'), 1::bigint, 'reminded');
  PERFORM pg_temp.assert_fails('UPDATE public.seat_requests SET summary = ''x''', 'a seat request is frozen');
END $$;

-- ---- an admin without a seat runs the account, nothing else ----
DO $$
DECLARE org uuid := (SELECT v FROM ids WHERE k = 'org');
BEGIN
  PERFORM pg_temp.login('5f500000-0000-0000-0000-000000000103');
  PERFORM pg_temp.assert_eq(app.is_member(org), true, 'an admin without a seat stays a member');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'subscription.seats'), true, 'and can give seats');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'members.manage'), true, 'and manage members');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'ncr.read'), false, 'but uses nothing priced');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.seat_blocked_organisations()), 0::bigint, 'and is not held back');
  PERFORM pg_temp.logout();
  -- grandfathered: a member without a seat is a member as before
  PERFORM pg_temp.login('5f500000-0000-0000-0000-000000000104');
  PERFORM pg_temp.assert_eq(app.is_member((SELECT v FROM ids WHERE k = 'old')), true, 'grandfathered organisations are unchanged');
  PERFORM pg_temp.logout();
END $$;

-- ---- a seat lets them in ----
DO $$
DECLARE org uuid := (SELECT v FROM ids WHERE k = 'org');
BEGIN
  PERFORM pg_temp.login('5f500000-0000-0000-0000-000000000103');
  PERFORM app.assign_subscription_package((SELECT v FROM ids WHERE k = 'inv'), 'controller');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login('5f500000-0000-0000-0000-000000000102');
  PERFORM pg_temp.assert_eq(app.is_member(org), true, 'given a seat, they are in');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'ncr.read'), true, 'with what their role and package allow');
  PERFORM pg_temp.assert_eq((app.my_seat_wait(org)) ->> 'waiting', 'false', 'and no longer waiting');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.seat_blocked_organisations()), 0::bigint, 'nothing holds them back');
  PERFORM pg_temp.assert_fails(format($f$SELECT app.remind_seat_managers(%L)$f$, org), 'nothing to remind about');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
