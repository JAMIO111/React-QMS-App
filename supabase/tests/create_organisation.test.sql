-- app.create_organisation: a signed-in user creates an organisation and becomes its Owner.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('20000000-0000-0000-0000-0000000000c1', 'founder@example.test'),
  ('20000000-0000-0000-0000-0000000000c2', 'other@example.test');

DO $$
DECLARE
  org uuid;
  again uuid;
  second uuid;
BEGIN
  PERFORM pg_temp.login('20000000-0000-0000-0000-0000000000c1');
  org := app.create_organisation('  Acme Fabrication Ltd  ', 'Leeds plant', 'lds', 'key-1');

  -- The founder sees it as an active Owner, with settings, a site, roles and starter statuses.
  PERFORM pg_temp.assert_eq((SELECT name || '|' || slug FROM public.organisations WHERE id = org), 'Acme Fabrication Ltd|acme-fabrication-ltd', 'name and slug');
  PERFORM pg_temp.assert_eq((SELECT base_currency FROM public.organisation_settings WHERE organisation_id = org), 'GBP', 'default settings');
  PERFORM pg_temp.assert_eq((SELECT code || '|' || name FROM public.sites WHERE organisation_id = org), 'LDS|Leeds plant', 'default site');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.roles WHERE organisation_id = org), 6::bigint, 'standard roles');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'roles.manage'), true, 'founder is owner');

  -- Same idempotency key: same organisation, nothing duplicated.
  again := app.create_organisation('Acme Fabrication Ltd', 'Leeds plant', 'LDS', 'key-1');
  PERFORM pg_temp.assert_eq(again, org, 'idempotent repeat');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.organisations WHERE name = 'Acme Fabrication Ltd'), 1::bigint, 'no duplicate');

  -- Without a key a second organisation with the same name gets a distinct slug.
  second := app.create_organisation('Acme Fabrication Ltd');
  PERFORM pg_temp.assert_eq((SELECT slug FROM public.organisations WHERE id = second), 'acme-fabrication-ltd-2', 'slug de-duplicated');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.organisations), 2::bigint, 'founder sees both of their organisations');

  PERFORM pg_temp.assert_fails($q$SELECT app.create_organisation(' x ')$q$, 'name too short');
  PERFORM pg_temp.logout();

  -- The audit trail records the founder as actor.
  PERFORM pg_temp.assert_eq((SELECT actor_user_id FROM audit.events WHERE entity_type = 'organisations' AND entity_id = org::text AND action = 'insert'), '20000000-0000-0000-0000-0000000000c1'::uuid, 'audited with actor');

  -- Another user's key space is separate and they cannot see the founder's organisations.
  PERFORM pg_temp.login('20000000-0000-0000-0000-0000000000c2');
  PERFORM pg_temp.assert_eq(pg_temp.count_rows($q$SELECT 1 FROM public.organisations WHERE name = 'Acme Fabrication Ltd'$q$), 0::bigint, 'other user sees nothing');
  PERFORM pg_temp.assert_eq(app.create_organisation('Other Works', 'Main site', 'MAIN', 'key-1') <> org, true, 'idempotency keys are per user');
  PERFORM pg_temp.assert_fails($q$SELECT * FROM app.idempotency_keys$q$, 'idempotency table is private');
  PERFORM pg_temp.logout();

  -- Anonymous callers cannot create organisations.
  PERFORM pg_temp.login_anon();
  PERFORM pg_temp.assert_fails($q$SELECT app.create_organisation('Anon Ltd')$q$, 'anon');
  PERFORM pg_temp.logout();
END $$;

-- Abuse limit: the eleventh organisation in a day is refused.
DO $$
BEGIN
  PERFORM pg_temp.login('20000000-0000-0000-0000-0000000000c2');
  FOR i IN 2..10 LOOP
    PERFORM app.create_organisation('Bulk ' || i);
  END LOOP;
  PERFORM pg_temp.assert_fails($q$SELECT app.create_organisation('One too many')$q$, 'daily limit');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
