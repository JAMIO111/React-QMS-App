-- Edit conflicts EC1 (docs/edit-conflicts-plan.md): a save based on an older version of a record is refused (QM031) by app.touch_updated(), for
-- an update under RLS and inside a SECURITY DEFINER function alike; a matching version saves and is consumed, so later updates of the same row in
-- the same request pass; no setting = last write wins as before; app.edit_conflict_details says what changed since, only to members.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

CREATE FUNCTION pg_temp.fails_with(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE; END $$;
CREATE FUNCTION pg_temp.expect(p_table text, p_id uuid, p_version text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('app.expected_versions', jsonb_build_object(p_table || ':' || p_id, p_version)::text, true)::text IS NOT NULL AND true;
$$;

INSERT INTO auth.users (id, email) VALUES
  ('ec100000-0000-0000-0000-000000000101', 'owner@edits.test'),
  ('ec100000-0000-0000-0000-000000000102', 'outsider@edits.test');
INSERT INTO public.profiles (id, first_name, surname) VALUES ('ec100000-0000-0000-0000-000000000101', 'Olga', 'Owner')
  ON CONFLICT (id) DO UPDATE SET first_name = EXCLUDED.first_name, surname = EXCLUDED.surname;

CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);
GRANT SELECT ON ids TO authenticated;

DO $$
DECLARE org uuid; cust uuid; risk uuid;
BEGIN
  PERFORM pg_temp.login('ec100000-0000-0000-0000-000000000101');
  org := app.create_organisation('Edit Works', 'Plant A', 'PA', NULL);
  INSERT INTO public.customers (organisation_id, code, name) VALUES (org, 'C1', 'First name') RETURNING id INTO cust;
  risk := app.create_risk(org, jsonb_build_object('title', 'Supplier may fail',
            'categoryId', (SELECT id FROM public.risk_categories WHERE organisation_id = org ORDER BY key LIMIT 1)));
  PERFORM pg_temp.logout();
  INSERT INTO ids VALUES ('org', org), ('cust', cust), ('risk', risk);
  -- the records as two people opened them earlier (the test runs in one transaction, so now() never moves inside it)
  SET LOCAL session_replication_role = replica;
  UPDATE public.customers SET updated_at = '2026-01-01 10:00:00.123456+00' WHERE id = cust;
  UPDATE public.risks SET updated_at = '2026-01-01 10:00:00.123456+00' WHERE id = risk;
  SET LOCAL session_replication_role = DEFAULT;
END $$;

-- ---- the version ----
DO $$
BEGIN
  PERFORM pg_temp.assert_eq(app.row_version('2026-01-01 10:00:00.123456+00'), '1767261600123456', 'the version is the microseconds since 1970');
  PERFORM pg_temp.assert_eq(app.row_version(NULL), '0', 'no timestamp = 0');
END $$;

-- ---- an update under RLS ----
DO $$
DECLARE cust uuid := (SELECT v FROM ids WHERE k = 'cust'); old text := '1767261600123456'; now_v text;
BEGIN
  PERFORM pg_temp.login('ec100000-0000-0000-0000-000000000101');

  -- A saves on the version they opened: allowed, and the version moves
  PERFORM pg_temp.expect('customers', cust, old);
  PERFORM pg_temp.assert_eq(pg_temp.fails_with(format('UPDATE public.customers SET name = %L WHERE id = %L', 'A''s name', cust)), 'ok', 'a save on the current version passes');
  PERFORM pg_temp.assert_eq(current_setting('app.expected_versions'), '{}', 'the expectation is used up by the first update');
  PERFORM pg_temp.assert_eq(pg_temp.fails_with(format('UPDATE public.customers SET name = %L WHERE id = %L', 'A again', cust)), 'ok',
    'a further update of the same row in the same request is not a conflict');
  now_v := (SELECT app.row_version(updated_at) FROM public.customers WHERE id = cust);
  PERFORM pg_temp.assert_eq(now_v <> old, true, 'the version moved');

  -- B saves on the version they opened before A's save: refused
  PERFORM pg_temp.expect('customers', cust, old);
  PERFORM pg_temp.assert_eq(pg_temp.fails_with(format('UPDATE public.customers SET name = %L WHERE id = %L', 'B''s name', cust)), 'QM031',
    'a save on an older version is refused');
  PERFORM pg_temp.assert_eq((SELECT name FROM public.customers WHERE id = cust), 'A again', 'and changes nothing');

  -- B saves again on the current version: allowed
  PERFORM pg_temp.expect('customers', cust, now_v);
  PERFORM pg_temp.assert_eq(pg_temp.fails_with(format('UPDATE public.customers SET name = %L WHERE id = %L', 'B''s name', cust)), 'ok',
    'a save on the version now current passes');

  -- an expectation for another record does not stop this one
  PERFORM pg_temp.expect('customers', gen_random_uuid(), old);
  PERFORM pg_temp.assert_eq(pg_temp.fails_with(format('UPDATE public.customers SET code = %L WHERE id = %L', 'C2', cust)), 'ok', 'another row''s expectation is ignored');

  -- no expectation: last write wins, as before
  PERFORM set_config('app.expected_versions', '', true);
  PERFORM pg_temp.assert_eq(pg_temp.fails_with(format('UPDATE public.customers SET name = %L WHERE id = %L', 'Last', cust)), 'ok', 'no version = as before');
  PERFORM pg_temp.logout();
END $$;

-- ---- an update inside a SECURITY DEFINER function ----
DO $$
DECLARE risk uuid := (SELECT v FROM ids WHERE k = 'risk'); old text := '1767261600123456'; now_v text;
BEGIN
  PERFORM pg_temp.login('ec100000-0000-0000-0000-000000000101');
  PERFORM pg_temp.expect('risks', risk, old);
  PERFORM pg_temp.assert_eq(pg_temp.fails_with(format('SELECT app.update_risk(%L, %L)', risk, '{"title":"Supplier may fail to deliver"}')), 'ok',
    'a function update on the current version passes');
  now_v := (SELECT app.row_version(updated_at) FROM public.risks WHERE id = risk);
  PERFORM pg_temp.expect('risks', risk, old);
  PERFORM pg_temp.assert_eq(pg_temp.fails_with(format('SELECT app.update_risk(%L, %L)', risk, '{"title":"Stale title"}')), 'QM031',
    'a function update on an older version is refused');
  PERFORM pg_temp.assert_eq((SELECT title FROM public.risks WHERE id = risk), 'Supplier may fail to deliver', 'and changes nothing');
  PERFORM pg_temp.expect('risks', risk, now_v);
  PERFORM pg_temp.assert_eq(pg_temp.fails_with(format('SELECT app.update_risk(%L, %L)', risk, '{"title":"Fresh title"}')), 'ok', 'current version passes');
  PERFORM set_config('app.expected_versions', '', true);
  PERFORM pg_temp.logout();
END $$;

-- ---- what changed since ----
DO $$
DECLARE cust uuid := (SELECT v FROM ids WHERE k = 'cust'); d jsonb;
BEGIN
  PERFORM pg_temp.login('ec100000-0000-0000-0000-000000000101');
  d := app.edit_conflict_details('customers', cust, '1767261600123456');
  PERFORM pg_temp.assert_eq(d -> 'fields', '["code", "name"]'::jsonb, 'the fields changed since the version, bookkeeping left out');
  PERFORM pg_temp.assert_eq(d -> 'changedBy' ->> 'name', 'Olga Owner', 'who changed it last');
  PERFORM pg_temp.assert_eq(d ->> 'version', (SELECT app.row_version(updated_at) FROM public.customers WHERE id = cust), 'the current version');
  PERFORM pg_temp.assert_eq(jsonb_array_length(d -> 'people'), 1, 'everyone who changed it since');
  d := app.edit_conflict_details('customers', cust, (SELECT app.row_version(updated_at) FROM public.customers WHERE id = cust));
  PERFORM pg_temp.assert_eq(d -> 'fields', '[]'::jsonb, 'nothing changed since the current version');
  PERFORM pg_temp.assert_eq(pg_temp.fails_with('SELECT app.edit_conflict_details(''pg_class'', gen_random_uuid(), ''0'')'), 'P0002', 'only tables with the check');
  PERFORM pg_temp.assert_eq(pg_temp.fails_with(format('SELECT app.edit_conflict_details(%L, %L, ''0'')', 'customers', gen_random_uuid())), 'P0002', 'an unknown row');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login('ec100000-0000-0000-0000-000000000102');
  PERFORM pg_temp.assert_eq(pg_temp.fails_with(format('SELECT app.edit_conflict_details(%L, %L, ''0'')', 'customers', cust)), 'P0002',
    'someone outside the organisation learns nothing');
  PERFORM pg_temp.logout();
END $$;

-- ---- the two tables that keep their own updated_at carry the check too ----
DO $$
BEGIN
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM pg_trigger WHERE tgfoid = 'app.check_edit_version()'::regprocedure), 2,
    'integration_connections and workflow_rules are checked');
  PERFORM pg_temp.assert_eq(has_function_privilege('anon', 'app.edit_conflict_details(text, uuid, text)', 'EXECUTE'), false, 'not for anon');
END $$;

ROLLBACK;
