-- Gauge type codes: the backfill of existing types (fixture), a code made from the name when none is given, required / trimmed / unique ignoring case,
-- editable by calibration managers only, and imports matching gauge types by code (then by name for older files).
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql
SET CONSTRAINTS ALL IMMEDIATE;

INSERT INTO auth.users (id, email) VALUES
  ('31500000-0000-0000-0000-000000000101', 'owner@gtc.test'),
  ('31500000-0000-0000-0000-000000000102', 'inspector@gtc.test');

DO $$
DECLARE org uuid; t1 uuid; t2 uuid; t3 uuid; m uuid;
BEGIN
  -- Backfill: every existing type has a code made from its name, unique in its organisation.
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.gauge_types WHERE code IS NULL)::text, '0', 'every gauge type has a code');
  PERFORM pg_temp.assert_eq((SELECT string_agg(code, ',' ORDER BY code) FROM public.gauge_types WHERE upper(name) LIKE 'FIXTURE MICROMETER%'),
    'FIXTURE-MICROMETER-0-25,FIXTURE-MICROMETER-0-25-2', 'codes are made from the names, a second name making the same code gets a number');
  PERFORM pg_temp.assert_eq((SELECT code FROM public.gauge_types WHERE name = '***'), 'TYPE', 'a name with nothing usable gives TYPE');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM audit.events WHERE entity_type = 'gauge_types' AND action = 'update')::text, '0', 'the backfill is not recorded as a person''s change');

  PERFORM pg_temp.login('31500000-0000-0000-0000-000000000101');
  org := app.create_organisation('Code Works', 'Plant A', 'PA', NULL);
  INSERT INTO public.gauge_types (organisation_id, code, name) VALUES (org, '  MIC-25 ', 'Micrometer 0-25') RETURNING id INTO t1;
  PERFORM pg_temp.assert_eq((SELECT code FROM public.gauge_types WHERE id = t1), 'MIC-25', 'a given code is trimmed');
  INSERT INTO public.gauge_types (organisation_id, name) VALUES (org, 'Height gauge') RETURNING id INTO t2;
  PERFORM pg_temp.assert_eq((SELECT code FROM public.gauge_types WHERE id = t2), 'HEIGHT-GAUGE', 'an insert without a code gets one from the name');
  INSERT INTO public.gauge_types (organisation_id, code, name) VALUES (org, '', 'Bore gauge') RETURNING id INTO t3;
  PERFORM pg_temp.assert_eq((SELECT code FROM public.gauge_types WHERE id = t3), 'BORE-GAUGE', 'an empty code is made from the name');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.gauge_types (organisation_id, code, name) VALUES (%L, 'mic-25', 'Other micrometer')$q$, org), 'codes are unique ignoring case');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.gauge_types (organisation_id, code, name) VALUES (%L, %L, 'Long')$q$, org, repeat('X', 41)), 'codes are at most 40 characters');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.gauge_types SET code = 'HEIGHT-GAUGE' WHERE id = %L$q$, t1), 'a change to another type''s code is refused');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.gauge_types SET code = NULL WHERE id = %L$q$, t1), 'a code cannot be cleared');
  UPDATE public.gauge_types SET code = 'MIC-0-25' WHERE id = t1;
  PERFORM pg_temp.assert_eq((SELECT code FROM public.gauge_types WHERE id = t1), 'MIC-0-25', 'a manager can change a code');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM audit.events WHERE entity_type = 'gauge_types' AND entity_id = t1::text AND action = 'update' AND 'code' = ANY (changed_fields))::text, '1', 'a code change is audited');

  -- Intervals run to ten years in days (exports from other systems keep 1,095 and 1,460 days).
  PERFORM pg_temp.login('31500000-0000-0000-0000-000000000101');
  INSERT INTO public.gauge_types (organisation_id, code, name, interval_value, interval_unit) VALUES (org, 'SFT', 'Surface table', 1460, 'days');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.gauge_types (organisation_id, code, name, interval_value, interval_unit) VALUES (%L, 'X', 'X', 3651, 'days')$q$, org), 'intervals stop at 3650');
  PERFORM pg_temp.logout();

  -- Imports find a gauge type by its code, then (older files) by its name.
  PERFORM pg_temp.assert_eq(app.integration_find_by_code(org, 'gauge_type', 'mic-0-25')::text, t1::text, 'found by code ignoring case');
  PERFORM pg_temp.assert_eq(app.integration_find_by_code(org, 'gauge_type', 'Height gauge')::text, t2::text, 'found by name when no code matches');
  PERFORM pg_temp.assert_eq(app.integration_record_code('gauge_type', '{"code": "X-1", "name": "X"}'), 'X-1', 'an imported type is matched by its code');

  -- Only calibration managers change codes.
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '31500000-0000-0000-0000-000000000102', 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'inspector';
  PERFORM pg_temp.login('31500000-0000-0000-0000-000000000102');
  UPDATE public.gauge_types SET code = 'HACKED' WHERE id = t1;
  PERFORM pg_temp.login('31500000-0000-0000-0000-000000000101');
  PERFORM pg_temp.assert_eq((SELECT code FROM public.gauge_types WHERE id = t1), 'MIC-0-25', 'an inspector cannot change a code');
END $$;

ROLLBACK;
