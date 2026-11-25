-- Gauge R&R, slice MS2: studies, design, run order, readings, completion, freezing, tenancy and site scoping.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('5b000000-0000-0000-0000-000000000d01', 'ann@ms2.test'), ('5b000000-0000-0000-0000-000000000d02', 'bob@ms2.test'),
  ('5b000000-0000-0000-0000-000000000d03', 'cat@ms2.test'), ('5b000000-0000-0000-0000-000000000d04', 'dan@ms2.test'),
  ('5b000000-0000-0000-0000-000000000d05', 'eve@ms2.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

-- Hash of what the database holds now, the way the API computes it from the rows it read.
CREATE FUNCTION pg_temp.hash_of(p_study uuid) RETURNS text LANGUAGE sql AS $$
  SELECT encode(sha256(convert_to(app.msa_data_canonical(p_study), 'UTF8')), 'hex')
$$;

DO $$
DECLARE
  ann uuid := '5b000000-0000-0000-0000-000000000d01'; bob uuid := '5b000000-0000-0000-0000-000000000d02'; cat uuid := '5b000000-0000-0000-0000-000000000d03';
  dan uuid := '5b000000-0000-0000-0000-000000000d04'; eve uuid := '5b000000-0000-0000-0000-000000000d05';
  miss uuid; org uuid; org2 uuid; site_a uuid; site_b uuid; g_a uuid; g_b uuid; g2 uuid; emp uuid; emp2 uuid; u uuid;
  st uuid; t1 uuid; at1 uuid; rep uuid; r text; n integer; v_hash text; v_result jsonb := '{"algorithm":"msa-1","criteria":"aiag-msa-4","verdict":{"band":"marginal"}}';
  cells jsonb;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('MS2 Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('MS2 Beta'); PERFORM pg_temp.logout();
  -- Bob: viewer (reads). Cat: inspector (records readings). Dan: inspector limited to site B.
  FOREACH u IN ARRAY ARRAY[bob, cat, dan] LOOP INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u, 'active'); END LOOP;
  INSERT INTO public.sites (organisation_id, code, name) VALUES (org, 'A', 'Site A') RETURNING id INTO site_a;
  INSERT INTO public.sites (organisation_id, code, name) VALUES (org, 'B', 'Site B') RETURNING id INTO site_b;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id, site_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = CASE ou.user_id WHEN bob THEN 'viewer' ELSE 'inspector' END), CASE ou.user_id WHEN dan THEN site_b END
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id IN (bob, cat, dan);
  INSERT INTO public.gauges (organisation_id, asset_number, description, site_id, resolution, unit_code) VALUES (org, 'MS2-A', 'Caliper at A', site_a, 0.01, 'mm') RETURNING id INTO g_a;
  INSERT INTO public.gauges (organisation_id, asset_number, description, site_id) VALUES (org, 'MS2-B', 'Caliper at B', site_b) RETURNING id INTO g_b;
  INSERT INTO public.gauges (organisation_id, asset_number, description) VALUES (org2, 'MS2-X', 'Other organisation') RETURNING id INTO g2;
  INSERT INTO public."Employees" (organisation_id, first_name, surname, active) VALUES (org, 'Ada', 'Lovelace', true) RETURNING id INTO emp;
  INSERT INTO public."Employees" (organisation_id, first_name, surname, active) VALUES (org, 'Gone', 'Person', false) RETURNING id INTO emp2;

  -- ---- who may design ----
  PERFORM pg_temp.login(bob);
  r := pg_temp.fails(format($f$SELECT app.create_msa_study(%L, jsonb_build_object('studyType', 'grr_crossed', 'gaugeId', %L))$f$, org, g_a));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a viewer reads but does not design');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  r := pg_temp.fails(format($f$SELECT app.create_msa_study(%L, jsonb_build_object('studyType', 'grr_crossed', 'gaugeId', %L))$f$, org, g_a));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'an inspector records but does not design');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ann);
  r := pg_temp.fails(format($f$SELECT app.create_msa_study(%L, jsonb_build_object('studyType', 'grr_crossed', 'gaugeId', %L))$f$, org, g2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'another organisation''s gauge is not found');
  r := pg_temp.fails(format($f$SELECT app.create_msa_study(%L, jsonb_build_object('studyType', 'made_up', 'gaugeId', %L))$f$, org, g_a));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM034', 'only the three study types');
  r := pg_temp.fails(format($f$SELECT app.create_msa_study(%L, jsonb_build_object('studyType', 'grr_crossed', 'gaugeId', %L, 'colour', 'red'))$f$, org, g_a));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM034', 'unknown fields are refused');
  r := pg_temp.fails(format($f$SELECT app.create_msa_study(%L, jsonb_build_object('studyType', 'grr_crossed', 'gaugeId', %L, 'partCount', 1))$f$, org, g_a));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM034', 'a crossed study needs at least 2 parts');
  r := pg_temp.fails(format($f$SELECT app.create_msa_study(%L, jsonb_build_object('studyType', 'attribute', 'gaugeId', %L, 'appraiserCount', 1, 'trialCount', 1))$f$, org, g_a));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM034', 'an attribute study needs two appraisers or two trials');
  r := pg_temp.fails(format($f$SELECT app.create_msa_study(%L, jsonb_build_object('studyType', 'grr_crossed', 'gaugeId', %L, 'lowerLimit', 5, 'upperLimit', 4))$f$, org, g_a));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM034', 'the upper limit is above the lower one');
  r := pg_temp.fails(format($f$SELECT app.create_msa_study(%L, jsonb_build_object('studyType', 'grr_crossed', 'gaugeId', %L, 'sigmaMultiplier', 4))$f$, org, g_a));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM034', 'the multiplier is 6 or 5.15');
  r := pg_temp.fails(format($f$SELECT app.create_msa_study(%L, jsonb_build_object('studyType', 'grr_crossed', 'gaugeId', %L, 'appraisers', jsonb_build_array(jsonb_build_object('employeeId', %L), jsonb_build_object('name', 'B'))))$f$, org, g_a, emp2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM034', 'an appraiser must be an active employee');
  r := pg_temp.fails(format($f$SELECT app.create_msa_study(%L, jsonb_build_object('studyType', 'grr_crossed', 'gaugeId', %L, 'appraisers', '[{"name":"Same"},{"name":"same"}]'::jsonb))$f$, org, g_a));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM034', 'appraisers have different names');

  -- ---- a crossed study: 3 parts x 2 appraisers x 2 trials ----
  st := app.create_msa_study(org, jsonb_build_object('studyType', 'grr_crossed', 'gaugeId', g_a, 'characteristicName', 'Bore diameter', 'nominal', 25, 'lowerLimit', 24.9, 'upperLimit', 25.1,
    'partCount', 3, 'trialCount', 2, 'appraisers', jsonb_build_array(jsonb_build_object('employeeId', emp), jsonb_build_object('name', 'Visitor'))));
  PERFORM pg_temp.assert_eq((SELECT reference FROM public.msa_studies WHERE id = st), 'MSA-' || to_char(current_date, 'YY') || '-0001', 'numbered MSA-YY-NNNN');
  PERFORM pg_temp.assert_eq((SELECT status || '|' || part_count || '|' || appraiser_count || '|' || trial_count || '|' || coalesce(unit_code, '') || '|' || gauge_resolution::text FROM public.msa_studies WHERE id = st),
                            'draft|3|2|2|mm|0.01', 'a draft; the unit and the resolution are copied from the gauge');
  PERFORM pg_temp.assert_eq((SELECT string_agg(position || ':' || name || ':' || (employee_id IS NOT NULL)::text, ',' ORDER BY position) FROM public.msa_study_appraisers WHERE study_id = st),
                            '1:Ada Lovelace:true,2:Visitor:false', 'the employee''s name is copied; a typed name has no employee');
  PERFORM pg_temp.assert_eq((SELECT string_agg(label, ',' ORDER BY position) FROM public.msa_study_parts WHERE study_id = st), 'Part 1,Part 2,Part 3', 'default part labels');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.msa_study_measurements WHERE study_id = st), 0::bigint, 'no cells before collection starts');
  PERFORM pg_temp.assert_eq((SELECT count(*) >= 1 FROM public.audit_events WHERE entity_type = 'msa_studies' AND entity_id = st::text), true, 'the creation is audited');

  -- the design can change while it is a draft, by name or by count
  PERFORM app.update_msa_design(st, '{"characteristicName":"Bore diameter (final)","partCount":4}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.msa_study_parts WHERE study_id = st), 4::bigint, 'a new part count makes the parts again');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.msa_study_appraisers WHERE study_id = st), 2::bigint, 'the appraisers are kept when only the parts change');
  r := pg_temp.fails(format($f$SELECT app.update_msa_design(%L, '{"parts":[{"label":"X"},{"label":"x"}]}'::jsonb)$f$, st));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM034', 'part labels differ');
  PERFORM app.update_msa_design(st, '{"parts":[{"label":"P1"},{"label":"P2"},{"label":"P3"}]}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT part_count FROM public.msa_studies WHERE id = st), 3, 'a list sets the count');
  r := pg_temp.fails(format($f$SELECT app.update_msa_design(%L, '{"parts":[{"label":"A","referenceDecision":true},{"label":"B"},{"label":"C"}]}'::jsonb)$f$, st));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM034', 'only an attribute study has reference decisions');
  r := pg_temp.fails(format('UPDATE public.msa_studies SET characteristic_name = %L WHERE id = %L', 'Hack', st));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'nobody writes the table directly');
  PERFORM pg_temp.logout();

  -- ---- readers see it, others do not ----
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq(pg_temp.count_rows('SELECT 1 FROM public.msa_studies'), 1::bigint, 'a viewer reads the study');
  PERFORM pg_temp.assert_eq(pg_temp.count_rows('SELECT 1 FROM public.msa_study_parts'), 3::bigint, 'and its parts');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(dan);
  PERFORM pg_temp.assert_eq(pg_temp.count_rows('SELECT 1 FROM public.msa_studies'), 0::bigint, 'a person limited to site B does not see a study of a gauge at site A');
  r := pg_temp.fails(format($f$SELECT app.start_msa_collection(%L)$f$, st));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'and is told it does not exist');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve);
  PERFORM pg_temp.assert_eq(pg_temp.count_rows('SELECT 1 FROM public.msa_studies'), 0::bigint, 'another organisation sees nothing');
  r := pg_temp.fails(format($f$SELECT app.cancel_msa_study(%L, 'not mine to cancel')$f$, st));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'and cannot reach it');
  PERFORM pg_temp.logout();

  -- ---- start collecting ----
  PERFORM pg_temp.login(cat);
  r := pg_temp.fails(format($f$SELECT app.start_msa_collection(%L)$f$, st));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'an inspector does not start a study');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ann);
  PERFORM app.start_msa_collection(st);
  PERFORM pg_temp.assert_eq((SELECT status FROM public.msa_studies WHERE id = st), 'collecting', 'collecting');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.msa_study_measurements WHERE study_id = st), 12::bigint, '3 parts x 2 appraisers x 2 trials = 12 empty cells');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.msa_study_measurements WHERE study_id = st AND value IS NULL AND decision IS NULL), 12::bigint, 'all empty');
  -- the run order is a permutation of the parts for each appraiser and trial, and repeatable
  PERFORM pg_temp.assert_eq((SELECT bool_and(orders = '1,2,3') FROM (SELECT string_agg(run_order::text, ',' ORDER BY run_order) AS orders FROM public.msa_study_measurements WHERE study_id = st GROUP BY appraiser_id, trial) x),
                            true, 'the run order is 1..3 for every appraiser and trial');
  PERFORM pg_temp.assert_eq((SELECT run_order FROM public.msa_study_measurements m JOIN public.msa_study_parts p ON p.id = m.part_id JOIN public.msa_study_appraisers a ON a.id = m.appraiser_id
                               WHERE m.study_id = st AND a.position = 1 AND p.position = 1 AND m.trial = 1),
                            (SELECT row_number FROM (SELECT p.position AS pos, row_number() OVER (ORDER BY md5(st::text || ':1:1:' || p.position)) FROM public.msa_study_parts p WHERE p.study_id = st) x WHERE pos = 1)::integer,
                            'the order comes from a hash of the study id');
  r := pg_temp.fails(format($f$SELECT app.update_msa_design(%L, '{"partCount":5}'::jsonb)$f$, st));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM034', 'the design is locked once collecting');
  r := pg_temp.fails(format($f$SELECT app.start_msa_collection(%L)$f$, st));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM034', 'it cannot be started twice');
  r := pg_temp.fails(format('DELETE FROM public.msa_study_parts WHERE study_id = %L', st));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'parts cannot be deleted by a person');
  PERFORM pg_temp.logout();
  -- ... and not by SQL either
  r := pg_temp.fails(format('DELETE FROM public.msa_study_parts WHERE study_id = %L', st));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM034', 'nor by SQL once collecting');
  r := pg_temp.fails(format('DELETE FROM public.msa_study_measurements WHERE study_id = %L', st));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM034', 'a reading is never deleted');
  r := pg_temp.fails(format('UPDATE public.msa_studies SET part_count = 9 WHERE id = %L', st));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM034', 'the design of a collecting study does not change even for SQL');

  -- ---- readings ----
  PERFORM pg_temp.login(bob);
  r := pg_temp.fails(format($f$SELECT app.record_msa_measurements(%L, '[{"appraiser":1,"part":1,"trial":1,"value":25}]'::jsonb)$f$, st));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a viewer does not record');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  n := app.record_msa_measurements(st, '[{"appraiser":1,"part":1,"trial":1,"value":"25.010"},{"appraiser":1,"part":2,"trial":1,"value":24.98}]'::jsonb);
  PERFORM pg_temp.assert_eq(n, 2, 'two readings recorded');
  PERFORM pg_temp.assert_eq((SELECT m.value::text FROM public.msa_study_measurements m JOIN public.msa_study_appraisers a ON a.id = m.appraiser_id JOIN public.msa_study_parts p ON p.id = m.part_id
                               WHERE m.study_id = st AND a.position = 1 AND p.position = 1 AND m.trial = 1), '25.010', 'a value is kept exactly as written');
  PERFORM pg_temp.assert_eq((SELECT source || '|' || (entered_by = cat)::text FROM public.msa_study_measurements m JOIN public.msa_study_appraisers a ON a.id = m.appraiser_id JOIN public.msa_study_parts p ON p.id = m.part_id
                               WHERE m.study_id = st AND a.position = 1 AND p.position = 2 AND m.trial = 1), 'grid|true', 'who entered it and how');
  r := pg_temp.fails(format($f$SELECT app.record_msa_measurements(%L, '[{"appraiser":9,"part":1,"trial":1,"value":25}]'::jsonb)$f$, st));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM034', 'a cell that does not exist');
  r := pg_temp.fails(format($f$SELECT app.record_msa_measurements(%L, '[{"appraiser":1,"part":1,"trial":1,"value":"abc"}]'::jsonb)$f$, st));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM034', 'a value must be a number');
  r := pg_temp.fails(format($f$SELECT app.record_msa_measurements(%L, '[{"appraiser":1,"part":1,"trial":1,"value":"NaN"}]'::jsonb)$f$, st));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM034', 'not NaN');
  r := pg_temp.fails(format($f$SELECT app.record_msa_measurements(%L, '[{"appraiser":1,"part":1,"trial":1,"decision":true}]'::jsonb)$f$, st));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM034', 'a variable study takes values, not decisions');
  r := pg_temp.fails(format($f$SELECT app.record_msa_measurements(%L, '[{"appraiser":1,"part":1.5,"trial":1,"value":25}]'::jsonb)$f$, st));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM034', 'positions are whole numbers');
  r := pg_temp.fails(format($f$SELECT app.record_msa_measurements(%L, '[{"appraiser":1,"part":1,"trial":1,"value":25},{"appraiser":1,"part":1,"trial":1,"value":26}]'::jsonb)$f$, st));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM034', 'the same cell twice in one call');
  r := pg_temp.fails(format($f$SELECT app.record_msa_measurements(%L, '[]'::jsonb)$f$, st));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM034', 'nothing to record');
  r := pg_temp.fails(format($f$SELECT app.record_msa_measurements(%L, '[{"appraiser":1,"part":1,"trial":1,"value":25}]'::jsonb, 'typed')$f$, st));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM034', 'the source is grid or paste');
  PERFORM pg_temp.assert_eq((SELECT m.value::text FROM public.msa_study_measurements m JOIN public.msa_study_appraisers a ON a.id = m.appraiser_id JOIN public.msa_study_parts p ON p.id = m.part_id
                               WHERE m.study_id = st AND a.position = 1 AND p.position = 1 AND m.trial = 1), '25.010', 'a refused call changed nothing');
  r := pg_temp.fails(format($f$SELECT app.start_msa_collection(%L)$f$, st));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'an inspector cannot complete or restart');
  PERFORM pg_temp.logout();

  -- overwriting a cell is allowed and audited
  PERFORM pg_temp.login(cat);
  PERFORM app.record_msa_measurements(st, '[{"appraiser":1,"part":1,"trial":1,"value":25.012}]'::jsonb, 'paste');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_events WHERE entity_type = 'msa_study_measurements' AND organisation_id = org), 3::bigint, 'each entry or overwrite is audited (2 entries + 1 overwrite; the empty cells are not)');

  -- fill the rest (10 more cells) in one paste
  SELECT jsonb_agg(jsonb_build_object('appraiser', a, 'part', p, 'trial', t, 'value', 25 + (a * 0.01) + (p * 0.002) + (t * 0.001)))
    INTO cells FROM generate_series(1, 2) a, generate_series(1, 3) p, generate_series(1, 2) t WHERE NOT (a = 1 AND p = 1 AND t = 1) AND NOT (a = 1 AND p = 2 AND t = 1);
  PERFORM pg_temp.login(cat);
  PERFORM app.record_msa_measurements(st, cells, 'paste');
  PERFORM pg_temp.logout();

  -- ---- completing: API login only, every check re-made ----
  v_hash := pg_temp.hash_of(st);
  PERFORM pg_temp.login(ann);
  r := pg_temp.fails(format($f$SELECT app.system_complete_msa_study(%L, %L, %L, 'accepted', 'Fine', NULL, %L::jsonb, %L)$f$, org, st, ann, v_result, v_hash));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a signed-in person cannot call the system function');
  PERFORM pg_temp.logout();
  r := pg_temp.fails(format($f$SELECT app.system_complete_msa_study(%L, %L, %L, 'accepted', 'Fine', NULL, %L::jsonb, %L)$f$, org2, st, ann, v_result, v_hash));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'the organisation must be the study''s');
  r := pg_temp.fails(format($f$SELECT app.system_complete_msa_study(%L, %L, %L, 'accepted', 'Fine', NULL, %L::jsonb, %L)$f$, org, st, cat, v_result, v_hash));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'the person must still hold calibration.manage (an inspector does not)');
  r := pg_temp.fails(format($f$SELECT app.system_complete_msa_study(%L, %L, %L, 'accepted', 'Fine', NULL, %L::jsonb, %L)$f$, org, st, ann, v_result, repeat('0', 64)));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM034', 'a result for other data is refused (wrong hash)');
  r := pg_temp.fails(format($f$SELECT app.system_complete_msa_study(%L, %L, %L, 'accepted', 'Fine', NULL, '{"algorithm":"msa-1"}'::jsonb, %L)$f$, org, st, ann, v_hash));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM034', 'the result names its criteria');
  r := pg_temp.fails(format($f$SELECT app.system_complete_msa_study(%L, %L, %L, 'maybe', 'Fine', NULL, %L::jsonb, %L)$f$, org, st, ann, v_result, v_hash));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM034', 'a known conclusion');
  r := pg_temp.fails(format($f$SELECT app.system_complete_msa_study(%L, %L, %L, 'accepted', ' ', NULL, %L::jsonb, %L)$f$, org, st, ann, v_result, v_hash));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM034', 'a written conclusion');
  r := pg_temp.fails(format($f$SELECT app.system_complete_msa_study(%L, %L, %L, 'accepted', 'Fine', current_date - 1, %L::jsonb, %L)$f$, org, st, ann, v_result, v_hash));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM034', 'valid from today');
  r := pg_temp.fails(format($f$SELECT app.system_complete_msa_study(%L, %L, %L, 'accepted', 'Fine', NULL, '{"algorithm":"msa-1","criteria":"c","verdict":{"band":"great"}}'::jsonb, %L)$f$, org, st, ann, v_hash));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM034', 'a known verdict band');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.msa_studies WHERE id = st), 'collecting', 'every refusal left the study collecting');

  -- the hash notices a reading that changed after it was taken (a cell may be overwritten while collecting)
  PERFORM pg_temp.login(cat);
  PERFORM app.record_msa_measurements(st, '[{"appraiser":2,"part":3,"trial":2,"value":25.5}]'::jsonb);
  PERFORM pg_temp.logout();
  r := pg_temp.fails(format($f$SELECT app.system_complete_msa_study(%L, %L, %L, 'accepted', 'Fine', NULL, %L::jsonb, %L)$f$, org, st, ann, v_result, v_hash));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM034', 'a hash taken before a reading changed no longer matches');
  PERFORM pg_temp.assert_eq(r ~ 'worked out from the readings', true, 'and says why');
  -- a missing reading blocks completion (a second study with one of two readings in)
  PERFORM pg_temp.login(ann);
  miss := app.create_msa_study(org, jsonb_build_object('studyType', 'type1', 'gaugeId', g_a, 'characteristicName', 'Half done', 'referenceValue', 5, 'trialCount', 2));
  PERFORM app.start_msa_collection(miss);
  PERFORM app.record_msa_measurements(miss, '[{"appraiser":1,"part":1,"trial":1,"value":5.001}]'::jsonb);
  PERFORM pg_temp.logout();
  r := pg_temp.fails(format($f$SELECT app.system_complete_msa_study(%L, %L, %L, 'accepted', 'Fine', NULL, %L::jsonb, %L)$f$, org, miss, ann, v_result, pg_temp.hash_of(miss)));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM034', 'an empty cell blocks completion');
  PERFORM pg_temp.assert_eq(r ~ '1 readings are still missing', true, 'and says how many');

  v_hash := pg_temp.hash_of(st);
  PERFORM app.system_complete_msa_study(org, st, ann, 'accepted_with_conditions', ' Marginal: repeat after the next calibration ', NULL, v_result, v_hash);
  PERFORM pg_temp.assert_eq((SELECT status || '|' || conclusion || '|' || conclusion_note || '|' || (completed_by = ann)::text || '|' || (valid_until = (current_date + interval '12 months')::date)::text FROM public.msa_studies WHERE id = st),
                            'completed|accepted_with_conditions|Marginal: repeat after the next calibration|true|true', 'completed, trimmed, valid for 12 months by default');
  PERFORM pg_temp.assert_eq((SELECT verdict || '|' || algorithm_version || '|' || criteria_id || '|' || (data_hash = v_hash)::text FROM public.msa_study_results WHERE study_id = st), 'marginal|msa-1|aiag-msa-4|true', 'the frozen result');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.outbox_events WHERE organisation_id = org AND event_type = 'msa.study.completed' AND entity_id = st AND actor_user_id = ann), 1::bigint, 'the outbox event, with the person as the actor');
  PERFORM pg_temp.assert_eq(coalesce(current_setting('request.jwt.claims', true), ''), '', 'the claims are put back');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_events WHERE entity_type = 'msa_study_results' AND entity_id = (SELECT id::text FROM public.msa_study_results WHERE study_id = st)), 1::bigint, 'the result is audited');

  -- ---- frozen, even for SQL ----
  r := pg_temp.fails(format('UPDATE public.msa_studies SET conclusion = %L WHERE id = %L', 'accepted', st));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM034', 'a completed study cannot change');
  r := pg_temp.fails(format('UPDATE public.msa_study_measurements SET value = 1 WHERE id = (SELECT id FROM public.msa_study_measurements WHERE study_id = %L LIMIT 1)', st));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM034', 'a reading of a completed study cannot change');
  r := pg_temp.fails(format('UPDATE public.msa_study_results SET verdict = %L WHERE study_id = %L', 'acceptable', st));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM034', 'the result cannot be edited');
  r := pg_temp.fails(format('DELETE FROM public.msa_study_results WHERE study_id = %L', st));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM034', 'nor deleted');
  r := pg_temp.fails(format('DELETE FROM public.msa_studies WHERE id = %L', st));
  PERFORM pg_temp.assert_eq(left(r, 5) || (r ~ 'never deleted')::text, 'QM034true', 'a study is never deleted');
  r := pg_temp.fails(format('UPDATE public.msa_studies SET reference = %L WHERE id = %L', 'MSA-00-9999', st));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM034', 'the reference never changes');
  r := pg_temp.fails(format('UPDATE public.msa_study_appraisers SET name = %L WHERE study_id = %L', 'Renamed', st));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM034', 'the appraisers are frozen');
  PERFORM pg_temp.login(ann);
  r := pg_temp.fails(format($f$SELECT app.cancel_msa_study(%L, 'too late to cancel')$f$, st));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM034', 'a completed study is not cancelled');
  r := pg_temp.fails(format($f$SELECT app.record_msa_measurements(%L, '[{"appraiser":1,"part":1,"trial":1,"value":25}]'::jsonb)$f$, st));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM034', 'and takes no more readings');

  -- ---- a repeat is a new study ----
  rep := app.repeat_msa_study(st);
  PERFORM pg_temp.assert_eq((SELECT reference || '|' || status || '|' || (repeat_of_id = st)::text || '|' || part_count || appraiser_count || trial_count FROM public.msa_studies WHERE id = rep),
                            'MSA-' || to_char(current_date, 'YY') || '-0003|draft|true|322', 'a new draft that points at the one it repeats');
  PERFORM pg_temp.assert_eq((SELECT string_agg(name || ':' || (employee_id IS NOT NULL)::text, ',' ORDER BY position) FROM public.msa_study_appraisers WHERE study_id = rep), 'Ada Lovelace:true,Visitor:false', 'with the same appraisers');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.msa_study_measurements WHERE study_id = rep), 0::bigint, 'and no readings');
  r := pg_temp.fails(format($f$SELECT app.repeat_msa_study(%L)$f$, rep));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM034', 'only a completed study is repeated');
  -- cancelling a draft needs a reason
  r := pg_temp.fails(format($f$SELECT app.cancel_msa_study(%L, 'no')$f$, rep));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM034', 'a cancellation needs a reason');
  PERFORM app.cancel_msa_study(rep, 'Started by mistake');
  PERFORM pg_temp.assert_eq((SELECT status || '|' || cancel_reason FROM public.msa_studies WHERE id = rep), 'cancelled|Started by mistake', 'cancelled with its reason');
  PERFORM pg_temp.logout();

  -- ---- an attribute study ----
  PERFORM pg_temp.login(ann);
  at1 := app.create_msa_study(org, jsonb_build_object('studyType', 'attribute', 'gaugeId', g_a, 'characteristicName', 'Go / no-go',
    'parts', '[{"label":"S1","referenceDecision":true},{"label":"S2","referenceDecision":false},{"label":"S3"}]'::jsonb, 'appraiserCount', 2, 'trialCount', 2));
  r := pg_temp.fails(format($f$SELECT app.start_msa_collection(%L)$f$, at1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM034', 'every sample needs its reference decision before the study starts');
  PERFORM pg_temp.assert_eq(r ~ '1 of the samples', true, 'and says how many');
  PERFORM app.update_msa_design(at1, '{"parts":[{"label":"S1","referenceDecision":true},{"label":"S2","referenceDecision":false},{"label":"S3","referenceDecision":true}]}'::jsonb);
  PERFORM app.start_msa_collection(at1);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.msa_study_measurements WHERE study_id = at1), 12::bigint, '3 samples x 2 appraisers x 2 trials');
  r := pg_temp.fails(format($f$SELECT app.record_msa_measurements(%L, '[{"appraiser":1,"part":1,"trial":1,"value":1}]'::jsonb)$f$, at1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM034', 'an attribute study takes decisions, not values');
  r := pg_temp.fails(format($f$SELECT app.record_msa_measurements(%L, '[{"appraiser":1,"part":1,"trial":1,"decision":"accept"}]'::jsonb)$f$, at1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM034', 'a decision is true or false');
  PERFORM app.record_msa_measurements(at1, '[{"appraiser":1,"part":1,"trial":1,"decision":true},{"appraiser":1,"part":2,"trial":1,"decision":false}]'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.msa_study_measurements WHERE study_id = at1 AND decision IS NOT NULL), 2::bigint, 'decisions recorded');
  PERFORM pg_temp.logout();
  -- the hash covers the reference decisions
  v_hash := pg_temp.hash_of(at1);
  PERFORM pg_temp.assert_eq(pg_temp.hash_of(at1) = v_hash, true, 'the hash is stable');
  PERFORM pg_temp.assert_eq(app.msa_data_canonical(at1) ~ E'\nP\\|1\\|a\n', true, 'the canonical text carries the reference decisions');

  -- ---- Type 1 needs its reference value ----
  PERFORM pg_temp.login(ann);
  t1 := app.create_msa_study(org, jsonb_build_object('studyType', 'type1', 'gaugeId', g_a, 'characteristicName', 'Master ring', 'trialCount', 25));
  PERFORM pg_temp.assert_eq((SELECT part_count || '|' || appraiser_count || '|' || trial_count || '|' || k_percent::text || '|' || l_multiplier::text FROM public.msa_studies WHERE id = t1), '1|1|25|20.00|6.00', 'one part, one appraiser, K = 20 and L = 6 by default');
  r := pg_temp.fails(format($f$SELECT app.start_msa_collection(%L)$f$, t1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM034', 'a Type 1 study needs the reference value');
  PERFORM app.update_msa_design(t1, '{"referenceValue":"10.000","kPercent":10,"lMultiplier":5.15}'::jsonb);
  PERFORM app.start_msa_collection(t1);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.msa_study_measurements WHERE study_id = t1), 25::bigint, '25 readings of the one part');
  PERFORM pg_temp.assert_eq((SELECT string_agg(run_order::text, ',' ORDER BY trial) FROM public.msa_study_measurements WHERE study_id = t1 AND trial <= 3), '1,1,1', 'one part: the run order is the trial');
  PERFORM pg_temp.logout();

  -- ---- a gauge that is retired cannot be studied ----
  UPDATE public.gauges SET status = 'retired' WHERE id = g_b;
  PERFORM pg_temp.login(ann);
  r := pg_temp.fails(format($f$SELECT app.create_msa_study(%L, jsonb_build_object('studyType', 'grr_crossed', 'gaugeId', %L))$f$, org, g_b));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM034', 'a retired gauge cannot be studied');
  PERFORM pg_temp.logout();

  -- ---- the site-limited inspector sees and records for site B only ----
  UPDATE public.gauges SET status = 'active' WHERE id = g_b;
  PERFORM pg_temp.login(ann);
  PERFORM app.create_msa_study(org, jsonb_build_object('studyType', 'type1', 'gaugeId', g_b, 'characteristicName', 'At B', 'referenceValue', 1));
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(dan);
  PERFORM pg_temp.assert_eq(pg_temp.count_rows('SELECT 1 FROM public.msa_studies'), 1::bigint, 'the person limited to site B sees the study of the gauge at site B');
  PERFORM pg_temp.logout();

  -- ---- anon and the counters ----
  PERFORM pg_temp.login_anon();
  r := pg_temp.fails('SELECT count(*) FROM public.msa_studies');
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'anon reads nothing');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ann);
  r := pg_temp.fails('SELECT * FROM app.msa_study_counters');
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'the counters are not for people');
  PERFORM pg_temp.logout();
END $$;
ROLLBACK;
