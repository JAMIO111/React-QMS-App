-- Legacy calibration records (import): an outcome-only calibration written by the import, marked legacy, add only, no readings, no "recorded" event,
-- and the gauge follows it exactly as it follows any calibration.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('5f600000-0000-0000-0000-000000000a01', 'ann@legacycal.test'), ('5f600000-0000-0000-0000-000000000a02', 'viv@legacycal.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

CREATE FUNCTION pg_temp.import_one(p_org uuid, p_conn uuid, p_user uuid, p_entity text, p_ext text, p_canonical jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE run uuid; owner uuid := gen_random_uuid(); todo jsonb; v_id uuid; row_id uuid; i public.integration_inbox%ROWTYPE;
BEGIN
  PERFORM pg_temp.login(p_user); run := app.request_integration_run(p_conn, p_entity, 'full', NULL, NULL); PERFORM pg_temp.logout();
  PERFORM app.system_lease_integration_run(p_org, run, owner, 30);
  PERFORM app.system_stage_integration_records(p_org, run, owner,
    jsonb_build_array(jsonb_build_object('externalId', p_ext, 'payload', jsonb_build_object('id', p_ext), 'canonical', p_canonical)), NULL, true);
  todo := app.system_integration_rows_to_apply(p_org, run, owner, 10);
  IF jsonb_array_length(todo) = 1 THEN
    row_id := (todo -> 0 ->> 'id')::uuid;
    BEGIN
      v_id := app.system_import_record(p_org, run, owner, row_id, (todo -> 0 ->> 'internalId')::uuid, todo -> 0 -> 'canonical');
      PERFORM app.system_apply_integration_row(p_org, run, owner, row_id, v_id, todo -> 0 ->> 'action');
    EXCEPTION WHEN OTHERS THEN
      PERFORM app.system_fail_integration_row(p_org, run, owner, row_id, SQLERRM, NULL);
    END;
  END IF;
  PERFORM pg_temp.logout();
  PERFORM app.system_finish_integration_run(p_org, run, owner);
  SELECT * INTO i FROM public.integration_inbox WHERE run_id = run;
  RETURN jsonb_build_object('status', i.status, 'internal', i.internal_id, 'errors', i.errors, 'action', i.action, 'run', run);
END $$;

DO $$
DECLARE
  ann uuid := '5f600000-0000-0000-0000-000000000a01'; viv uuid := '5f600000-0000-0000-0000-000000000a02';
  org uuid; api uuid; t uuid; g uuid; res jsonb; c uuid; c2 uuid; v_ref text;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('Legacy Cal Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.give_controller_seat(org, ann);
  INSERT INTO public.gauge_types (organisation_id, name, interval_value, interval_unit) VALUES (org, 'Caliper', 6, 'months') RETURNING id INTO t;
  INSERT INTO public.gauges (organisation_id, asset_number, description, gauge_type_id) VALUES (org, 'G-001', 'Caliper', t) RETURNING id INTO g;

  PERFORM pg_temp.login(ann);
  api := app.create_integration_connection(org, 'rest_api', 'ERP', 'erp', '{"baseUrl": "https://erp.example.com", "authType": "none"}'::jsonb);
  PERFORM app.record_integration_connection_test(api, true, 'ok');
  PERFORM app.mark_integration_ready(api);
  PERFORM app.activate_integration_connection(api);
  PERFORM pg_temp.logout();

  PERFORM pg_temp.assert_eq('calibration' = ANY (app.integration_entity_types()), true, 'calibration is an importable kind');
  PERFORM pg_temp.assert_eq(app.integration_settings_for(api, 'calibration') ->> 'writeMode', 'add_only', 'always add only');
  PERFORM pg_temp.assert_eq(app.integration_entity_tracks_missing('calibration'), false, 'a source leaving out old calibrations is not a disappearance');

  -- a legacy record
  res := pg_temp.import_one(org, api, ann, 'calibration', 'CAL-OLD-1', jsonb_build_object('gauge', 'G-001', 'gaugeId', g, 'calibratedOn', '2026-06-01', 'outcome', 'pass',
    'nextDueOn', '2026-12-01', 'certificateNumber', 'CERT-77', 'performedBy', 'external', 'technicianName', 'A. Hand'));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'applied', 'the record is imported: ' || coalesce(res ->> 'errors', ''));
  c := (res ->> 'internal')::uuid;
  PERFORM pg_temp.assert_eq((SELECT is_legacy FROM public.calibrations WHERE id = c), true, 'it is marked legacy');
  PERFORM pg_temp.assert_eq((SELECT imported_from FROM public.calibrations WHERE id = c), 'erp', 'with where it came from');
  PERFORM pg_temp.assert_eq((SELECT imported_technician FROM public.calibrations WHERE id = c), 'A. Hand', 'and who the source says did it');
  PERFORM pg_temp.assert_eq((SELECT outcome FROM public.calibrations WHERE id = c), 'pass', 'the outcome is the source''s');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.calibration_readings WHERE calibration_id = c), 0, 'with no readings');
  SELECT reference INTO v_ref FROM public.calibrations WHERE id = c;
  PERFORM pg_temp.assert_eq(v_ref LIKE 'CAL-%', true, 'and a Fortress reference');
  SET CONSTRAINTS ALL IMMEDIATE;
  PERFORM pg_temp.assert_eq((SELECT next_due_on FROM public.gauges WHERE id = g), '2026-12-01'::date, 'the gauge shows when it is next due');
  PERFORM pg_temp.assert_eq((SELECT last_calibrated_on FROM public.gauges WHERE id = g), '2026-06-01'::date, 'and when it was last calibrated');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.outbox_events WHERE organisation_id = org AND event_type = 'calibration.recorded'), 0, 'history raises no "recorded" event');

  -- an older record does not take the gauge's dates back
  res := pg_temp.import_one(org, api, ann, 'calibration', 'CAL-OLD-0', jsonb_build_object('gauge', 'G-001', 'gaugeId', g, 'calibratedOn', '2025-12-01', 'outcome', 'adjusted', 'nextDueOn', '2026-06-01'));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'applied', 'an older one is imported too');
  SET CONSTRAINTS ALL IMMEDIATE;
  PERFORM pg_temp.assert_eq((SELECT last_calibrated_on FROM public.gauges WHERE id = g), '2026-06-01'::date, 'the latest calibration still decides the gauge');

  -- rules
  res := pg_temp.import_one(org, api, ann, 'calibration', 'CAL-BAD-1', jsonb_build_object('gauge', 'G-001', 'gaugeId', g, 'calibratedOn', '2026-06-01', 'outcome', 'maybe'));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'an outcome that is not pass, adjusted or fail is refused');
  res := pg_temp.import_one(org, api, ann, 'calibration', 'CAL-BAD-2', jsonb_build_object('gauge', 'G-001', 'gaugeId', g, 'calibratedOn', '2999-01-01', 'outcome', 'pass'));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'a date in the future is refused by the table rules');
  res := pg_temp.import_one(org, api, ann, 'calibration', 'CAL-BAD-3', jsonb_build_object('calibratedOn', '2026-06-01', 'outcome', 'pass'));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'a record with no gauge is refused');

  -- nobody else can make or alter the mark
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($q$INSERT INTO public.calibrations (organisation_id, gauge_id, reference, outcome, is_legacy) VALUES (%L, %L, 'x', 'pass', true)$q$, org, g)), 5), 'QM006', 'a person cannot insert a legacy record');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($q$UPDATE public.calibrations SET is_legacy = false WHERE id = %L$q$, c)), 5), '42501', 'the mark is not in the update grant');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($q$INSERT INTO public.calibration_readings (organisation_id, calibration_id, name, as_found) VALUES (%L, %L, 'x', 1)$q$, org, c)), 5), 'QM006', 'readings cannot be added to a legacy record');
  PERFORM pg_temp.logout();

  -- a record made by a person is not legacy and cannot carry the marks
  PERFORM pg_temp.login(ann);
  INSERT INTO public.calibrations (organisation_id, gauge_id, reference, outcome, imported_from) VALUES (org, g, 'x', 'pass', 'erp') RETURNING id INTO c2;
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT is_legacy FROM public.calibrations WHERE id = c2), false, 'recorded in Fortress, not legacy');
  PERFORM pg_temp.assert_eq((SELECT imported_from FROM public.calibrations WHERE id = c2), NULL, 'and the import marks are cleared');

  -- re-importing the same source record writes nothing new (add only)
  res := pg_temp.import_one(org, api, ann, 'calibration', 'CAL-OLD-1', jsonb_build_object('gauge', 'G-001', 'gaugeId', g, 'calibratedOn', '2026-06-01', 'outcome', 'fail'));
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.calibrations WHERE organisation_id = org AND is_legacy), 2, 'a second import does not add the record again');

  PERFORM pg_temp.assert_eq(has_function_privilege('authenticated', 'app.import_calibration(uuid, uuid, jsonb, uuid)', 'EXECUTE'), false, 'nobody signed in can call the importer');
END $$;

ROLLBACK;
