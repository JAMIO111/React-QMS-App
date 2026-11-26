-- app.orgs_permitted: lists the organisations where the caller holds a permission for the whole organisation (not a site-limited grant, not a suspended
-- membership, not another organisation), and is not callable without signing in. The policies built on it are exercised by in_process_inspection.test.sql
-- (an organisation-wide viewer reads, a Plant B inspector cannot see Plant A) and the tenancy sweep.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('48000000-0000-0000-0000-000000000101', 'owner@fp.test'),
  ('48000000-0000-0000-0000-000000000102', 'siteonly@fp.test'),
  ('48000000-0000-0000-0000-000000000103', 'suspended@fp.test'),
  ('48000000-0000-0000-0000-000000000104', 'other@fp.test');

CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);
GRANT SELECT ON ids TO authenticated;

DO $$
DECLARE org uuid; org2 uuid; site_b uuid; m uuid;
BEGIN
  PERFORM pg_temp.login('48000000-0000-0000-0000-000000000101');
  org := app.create_organisation('Fast Path Works', 'Plant A', 'PA', NULL);
  PERFORM pg_temp.login('48000000-0000-0000-0000-000000000104');
  org2 := app.create_organisation('Other Works', 'Plant X', 'PX', NULL);
  PERFORM pg_temp.logout();
  INSERT INTO public.sites (organisation_id, code, name) VALUES (org, 'PB', 'Plant B') RETURNING id INTO site_b;
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '48000000-0000-0000-0000-000000000102', 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id, site_id)
    SELECT org, m, id, site_b FROM public.roles WHERE organisation_id = org AND key = 'inspector';
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '48000000-0000-0000-0000-000000000103', 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'inspector';
  UPDATE public.organisation_users SET status = 'suspended' WHERE id = m;
  INSERT INTO ids VALUES ('org', org), ('org2', org2);
END $$;

DO $$
DECLARE org uuid := (SELECT v FROM ids WHERE k = 'org'); org2 uuid := (SELECT v FROM ids WHERE k = 'org2');
BEGIN
  -- The owner holds it for the whole organisation (and only their own).
  PERFORM pg_temp.login('48000000-0000-0000-0000-000000000101');
  PERFORM pg_temp.assert_eq((SELECT array_agg(o) FROM app.orgs_permitted('inspection.read') o), ARRAY[org], 'owner: their organisation');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.orgs_permitted('no.such.permission')), 0::bigint, 'an unknown permission lists nothing');
  -- A grant limited to one site is not organisation-wide: it falls through to the per-row check.
  PERFORM pg_temp.login('48000000-0000-0000-0000-000000000102');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.orgs_permitted('inspection.read')), 0::bigint, 'site-limited: not listed');
  -- A suspended member holds nothing.
  PERFORM pg_temp.login('48000000-0000-0000-0000-000000000103');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.orgs_permitted('inspection.read')), 0::bigint, 'suspended: not listed');
  -- Another organisation's owner never sees this one.
  PERFORM pg_temp.login('48000000-0000-0000-0000-000000000104');
  PERFORM pg_temp.assert_eq((SELECT array_agg(o) FROM app.orgs_permitted('inspection.read') o), ARRAY[org2], 'other owner: only theirs');
  -- Not callable without signing in.
  PERFORM pg_temp.login_anon();
  PERFORM pg_temp.assert_fails($q$SELECT count(*) FROM app.orgs_permitted('inspection.read')$q$, 'anon cannot call it');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
