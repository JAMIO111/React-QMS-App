-- A suspended member is told who suspended them and when (app.my_suspensions): own memberships only, suspended only, nothing else.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('5f700000-0000-0000-0000-000000000101', 'owner@susp.test'),
  ('5f700000-0000-0000-0000-000000000102', 'member@susp.test'),
  ('5f700000-0000-0000-0000-000000000103', 'other@susp.test');
UPDATE public.profiles SET first_name = 'Olga', surname = 'Owner' WHERE id = '5f700000-0000-0000-0000-000000000101';

CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);
GRANT SELECT ON ids TO authenticated;

DO $$
DECLARE org uuid; m uuid;
BEGIN
  PERFORM pg_temp.login('5f700000-0000-0000-0000-000000000101');
  org := app.create_organisation('Susp Works', 'Plant A', 'PA', NULL);
  PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status, joined_at) VALUES (org, '5f700000-0000-0000-0000-000000000102', 'active', now()) RETURNING id INTO m;
  INSERT INTO ids VALUES ('org', org), ('m', m);

  PERFORM pg_temp.login('5f700000-0000-0000-0000-000000000102');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.my_suspensions()), 0::bigint, 'an active member is not suspended');
  PERFORM pg_temp.logout();
END $$;

-- the owner suspends them
DO $$
DECLARE org uuid := (SELECT v FROM ids WHERE k = 'org'); m uuid := (SELECT v FROM ids WHERE k = 'm'); r record;
BEGIN
  PERFORM pg_temp.login('5f700000-0000-0000-0000-000000000101');
  UPDATE public.organisation_users SET status = 'suspended' WHERE id = m;
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login('5f700000-0000-0000-0000-000000000102');
  SELECT * INTO r FROM app.my_suspensions();
  PERFORM pg_temp.assert_eq(r.organisation_id, org, 'the organisation they were suspended from');
  PERFORM pg_temp.assert_eq(r.name, 'Susp Works', 'by name');
  PERFORM pg_temp.assert_eq(r.suspended_by_name, 'Olga Owner', 'who suspended them');
  PERFORM pg_temp.assert_eq(r.suspended_by, '5f700000-0000-0000-0000-000000000101'::uuid, 'by id');
  PERFORM pg_temp.assert_eq(r.suspended_at IS NOT NULL AND r.suspended_at > now() - interval '1 hour', true, 'and when');
  PERFORM pg_temp.logout();

  -- nobody else sees it
  PERFORM pg_temp.login('5f700000-0000-0000-0000-000000000103');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.my_suspensions()), 0::bigint, 'someone else is not told about it');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login('5f700000-0000-0000-0000-000000000101');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.my_suspensions()), 0::bigint, 'the person who suspended them has nothing of their own');
  PERFORM pg_temp.logout();
END $$;

-- suspended twice: the latest suspension is the one named
DO $$
DECLARE m uuid := (SELECT v FROM ids WHERE k = 'm'); first_at timestamptz; r record;
BEGIN
  PERFORM pg_temp.login('5f700000-0000-0000-0000-000000000102');
  SELECT suspended_at INTO first_at FROM app.my_suspensions();
  PERFORM pg_temp.logout();
  UPDATE public.organisation_users SET status = 'active' WHERE id = m;
  PERFORM pg_temp.login('5f700000-0000-0000-0000-000000000102');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.my_suspensions()), 0::bigint, 'reactivated: no longer suspended');
  PERFORM pg_temp.logout();
  PERFORM pg_sleep(0.01);
  UPDATE public.organisation_users SET status = 'suspended' WHERE id = m;
  PERFORM pg_temp.login('5f700000-0000-0000-0000-000000000102');
  SELECT * INTO r FROM app.my_suspensions();
  PERFORM pg_temp.assert_eq(r.suspended_at >= first_at, true, 'the later suspension is the one reported');
  PERFORM pg_temp.logout();
END $$;

-- a signed-out caller gets nothing
DO $$
BEGIN
  PERFORM pg_temp.login_anon();
  PERFORM pg_temp.assert_fails('SELECT * FROM app.my_suspensions()', 'anon cannot call it');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
