-- Gauge R&R, slice MS5: the workflow trigger for a completed study (and the facts a rule can test) and the reminders area for studies about to expire.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('5c000000-0000-0000-0000-000000000e01', 'ann@ms5.test'), ('5c000000-0000-0000-0000-000000000e02', 'bob@ms5.test');

CREATE FUNCTION pg_temp.hash_of(p_study uuid) RETURNS text LANGUAGE sql AS $$
  SELECT encode(sha256(convert_to(app.msa_data_canonical(p_study), 'UTF8')), 'hex')
$$;

-- A Type 1 study on the gauge for the characteristic, completed by `who`, valid until `p_until`.
CREATE FUNCTION pg_temp.completed_study(p_org uuid, p_gauge uuid, p_who uuid, p_key text, p_until date, p_result jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE st uuid;
BEGIN
  PERFORM pg_temp.login(p_who);
  st := app.create_msa_study(p_org, jsonb_build_object('studyType', 'type1', 'gaugeId', p_gauge, 'characteristicKey', p_key, 'characteristicName', 'Bore ' || p_key, 'referenceValue', 5, 'trialCount', 2));
  PERFORM app.start_msa_collection(st);
  PERFORM app.record_msa_measurements(st, '[{"appraiser":1,"part":1,"trial":1,"value":5.001},{"appraiser":1,"part":1,"trial":2,"value":4.999}]'::jsonb);
  PERFORM pg_temp.logout();
  PERFORM app.system_complete_msa_study(p_org, st, p_who, 'accepted', 'For the test', p_until, p_result, pg_temp.hash_of(st));
  RETURN st;
END $$;

DO $$
DECLARE
  ann uuid := '5c000000-0000-0000-0000-000000000e01'; bob uuid := '5c000000-0000-0000-0000-000000000e02';
  org uuid; g uuid; g_free uuid; st1 uuid; st2 uuid; st3 uuid; f jsonb; n integer; today date := current_date;
  res jsonb := '{"algorithm":"msa-1","criteria":"aiag-msa-4","verdict":{"band":"acceptable"},"cgk":1.7,"variation":[{"name":"grr","pctStudyVar":12.5}],"overall":{"effectiveness":0.95}}';
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('MS5 Works', 'Plant', 'PL', NULL); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, bob, 'active');
  INSERT INTO public.gauges (organisation_id, asset_number, description, resolution, unit_code, custodian_id) VALUES (org, 'MS5-G', 'Bore gauge', 0.001, 'mm', bob) RETURNING id INTO g;
  INSERT INTO public.gauges (organisation_id, asset_number, description, resolution, unit_code) VALUES (org, 'MS5-NOCUST', 'No custodian', 0.001, 'mm') RETURNING id INTO g_free;

  -- ---- the trigger ----
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.workflow_triggers() WHERE event_type = 'msa.study.completed' AND entity_type = 'msa_study' AND permission = 'calibration.read'), 1::bigint, 'the new trigger is in the catalogue');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.workflow_triggers()) >= 22, true, 'and every earlier trigger is still there');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.workflow_triggers() WHERE event_type = 'quality_alert.issued'), 1::bigint, 'including the one it was put beside');

  -- ---- the facts ----
  st1 := pg_temp.completed_study(org, g, ann, 'BORE', today + 10, res);
  f := app.system_workflow_facts(org, 'msa_study', st1, '{}'::jsonb);
  PERFORM pg_temp.assert_eq(f ->> 'record_kind', 'msa_study', 'the record the notice leads to');
  PERFORM pg_temp.assert_eq((f ->> 'record_id')::uuid, st1, 'its id');
  PERFORM pg_temp.assert_eq(f ->> 'verdict', 'acceptable', 'the verdict');
  PERFORM pg_temp.assert_eq(f ->> 'conclusion', 'accepted', 'the person''s conclusion');
  PERFORM pg_temp.assert_eq(f ->> 'study_type', 'type1', 'the kind of study');
  PERFORM pg_temp.assert_eq((f ->> 'pct_grr')::numeric, 12.5, '%study variation of the gauge R&R');
  PERFORM pg_temp.assert_eq((f ->> 'cgk')::numeric, 1.7, 'Cgk');
  PERFORM pg_temp.assert_eq((f ->> 'effectiveness')::numeric, 0.95, 'effectiveness');
  PERFORM pg_temp.assert_eq(f ->> 'characteristic_key', 'BORE', 'the characteristic');
  PERFORM pg_temp.assert_eq((f ->> 'owner_user_id')::uuid, ann, 'whoever completed it');
  PERFORM pg_temp.assert_eq(jsonb_typeof(f -> 'cgk'), 'number', 'numbers are JSON numbers, so a rule can compare them');
  PERFORM pg_temp.assert_eq(app.system_workflow_facts(org, 'msa_study', gen_random_uuid(), '{}'::jsonb) IS NULL, true, 'an unknown study has no facts');
  PERFORM pg_temp.assert_eq(app.system_workflow_facts((SELECT id FROM public.organisations WHERE id <> org LIMIT 1), 'msa_study', st1, '{}'::jsonb) IS NULL, true, 'nor does another organisation''s');
  PERFORM pg_temp.assert_eq(app.system_workflow_facts(org, 'quality_alert', gen_random_uuid(), '{}'::jsonb) IS NULL, true, 'the other kinds are still answered (nothing for an unknown record)');

  -- ---- the reminders area ----
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.reminder_areas() WHERE key = 'msa_studies' AND soon_days = 30), 1::bigint, 'the area exists');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.reminder_areas()) >= 13, true, 'beside the twelve before it');
  SELECT count(*) INTO n FROM app.reminder_candidates(org, today) WHERE area = 'msa_studies' AND record_id = st1 AND user_id = bob AND due_on = today + 10 AND permission = 'calibration.read';
  PERFORM pg_temp.assert_eq(n, 1, 'the custodian is told about a study that expires within 30 days');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.reminder_candidates(org, today) WHERE area = 'competence' OR area = 'gauges'), 0::bigint, 'the other areas still run (and have nothing here)');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.reminder_candidates(org, today - 60) WHERE area = 'msa_studies'), 0::bigint, 'and not before the window opens');

  -- a gauge with no custodian has nobody to tell
  st3 := pg_temp.completed_study(org, g_free, ann, 'BORE', today + 5, res);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.reminder_candidates(org, today) WHERE area = 'msa_studies' AND record_id = st3), 0::bigint, 'nobody to tell without a custodian');

  -- a newer study of the same gauge and characteristic replaces the older one: only the current one is asked about
  st2 := pg_temp.completed_study(org, g, ann, 'BORE', today + 300, res);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.reminder_candidates(org, today) WHERE area = 'msa_studies' AND record_id = st1), 0::bigint, 'the replaced study is no longer asked about');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.reminder_candidates(org, today) WHERE area = 'msa_studies' AND record_id = st2), 0::bigint, 'the current one is far from expiring');
  -- another characteristic on the same gauge is its own study
  PERFORM pg_temp.completed_study(org, g, ann, 'OTHER', today + 3, res);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.reminder_candidates(org, today) WHERE area = 'msa_studies' AND user_id = bob), 1::bigint, 'a different characteristic is not replaced');

  -- once expired it is still asked about (overdue) until someone repeats the study
  SET LOCAL session_replication_role = replica;
  UPDATE public.msa_studies SET valid_until = today - 4 WHERE id = st2;
  SET LOCAL session_replication_role = origin;
  PERFORM pg_temp.assert_eq((SELECT due_on FROM app.reminder_candidates(org, today) WHERE area = 'msa_studies' AND record_id = st2), today - 4, 'an expired study is overdue');
END $$;

ROLLBACK;
