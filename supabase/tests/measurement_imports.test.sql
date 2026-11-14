-- CMM ingestion CM1: profiles (versions frozen), feature maps, imports stored as previews (the database works out each feature's result and
-- mismatch from the frozen requirement), matching, confirming mismatches, applying through the normal reading path with exact checks, the
-- same file only once, frozen once applied or discarded, storage folders, reading rights and organisation isolation.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('5d000000-0000-0000-0000-000000000a01', 'owner@cmm.test'), ('5d000000-0000-0000-0000-000000000a02', 'viewer@cmm.test'),
  ('5d000000-0000-0000-0000-000000000b01', 'other@cmm.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

-- An import body for inspection p_rec: one part with OD (25.02, file upper differs), LEN (40.3, fails), VIS (pass) and an unknown feature.
CREATE FUNCTION pg_temp.body(p_org uuid, p_rec uuid, p_sha text, p_part text DEFAULT 'CMM-100', p_wo text DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'filePath', p_org::text || '/inspection/' || p_rec::text || '/f-report.csv', 'fileName', 'report.csv', 'fileSha256', p_sha, 'sizeBytes', 1200,
    'format', 'table', 'header', jsonb_build_object('partNumber', p_part, 'serial', 'SN-7', 'workOrder', p_wo),
    'warnings', '[]'::jsonb,
    'units', jsonb_build_array(jsonb_build_object('position', 1, 'unitReference', 'SN-7', 'rows', jsonb_build_array(
      jsonb_build_object('position', 1, 'featureName', 'CIR_OD', 'charNumber', '1', 'valueText', '25.02', 'valueNumeric', 25.02, 'fileNominal', 25, 'fileLower', 24.95, 'fileUpper', 25.10,
                         'requirementId', (SELECT id FROM public.resolved_inspection_requirements WHERE inspection_record_id = p_rec AND characteristic_key = 'OD'), 'matchKind', 'balloon'),
      jsonb_build_object('position', 2, 'featureName', 'LEN_1', 'charNumber', '2', 'valueText', '40.3', 'valueNumeric', 40.3, 'fileNominal', 40, 'fileLower', 39.9, 'fileUpper', 40.1,
                         'requirementId', (SELECT id FROM public.resolved_inspection_requirements WHERE inspection_record_id = p_rec AND characteristic_key = 'LEN'), 'matchKind', 'balloon'),
      jsonb_build_object('position', 3, 'featureName', 'VISUAL', 'valueText', 'OK', 'valuePass', true,
                         'requirementId', (SELECT id FROM public.resolved_inspection_requirements WHERE inspection_record_id = p_rec AND characteristic_key = 'VIS'), 'matchKind', 'map'),
      jsonb_build_object('position', 4, 'featureName', 'DATUM_A', 'valueText', '0.001', 'valueNumeric', 0.001)))))
$$;

-- Apply an import as the API does: begin, record a sample with the readings (value offset by p_shift, optionally leaving one out), finish.
CREATE FUNCTION pg_temp.apply(p_import uuid, p_gauge uuid, p_shift numeric DEFAULT 0, p_skip_last boolean DEFAULT false, p_no_reading_gauge boolean DEFAULT false) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE plan jsonb; u jsonb; w jsonb; v_sample uuid; v_org uuid; v_rec uuid; units jsonb := '[]'::jsonb; n integer;
BEGIN
  SELECT organisation_id, inspection_record_id INTO v_org, v_rec FROM public.inspection_imports WHERE id = p_import;
  plan := app.begin_inspection_import_apply(p_import, p_gauge);
  FOR u IN SELECT value FROM jsonb_array_elements(plan -> 'units') LOOP
    INSERT INTO public.inspection_samples (organisation_id, inspection_record_id, unit_reference) VALUES (v_org, v_rec, u ->> 'unitReference') RETURNING id INTO v_sample;
    n := 0;
    FOR w IN SELECT value FROM jsonb_array_elements(u -> 'rows') LOOP
      n := n + 1;
      CONTINUE WHEN p_skip_last AND n = jsonb_array_length(u -> 'rows');
      INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_numeric, value_pass, gauge_id, import_id)
        VALUES (v_org, v_rec, v_sample, (w ->> 'requirementId')::uuid, (w ->> 'valueNumeric')::numeric + p_shift, (w ->> 'valuePass')::boolean, CASE WHEN p_no_reading_gauge THEN NULL ELSE p_gauge END, p_import);
    END LOOP;
    units := units || jsonb_build_array(jsonb_build_object('unitId', u ->> 'id', 'sampleId', v_sample));
  END LOOP;
  PERFORM app.finish_inspection_import_apply(p_import, units);
  RETURN v_sample;
END $$;

DO $$
DECLARE
  u_owner uuid := '5d000000-0000-0000-0000-000000000a01'; u_view uuid := '5d000000-0000-0000-0000-000000000a02'; u_other uuid := '5d000000-0000-0000-0000-000000000b01';
  org uuid; org_b uuid; site uuid; part uuid; plan uuid; rev uuid; op uuid; viewer_role uuid; m uuid; rec uuid; rec2 uuid; cmm uuid; prof uuid; prof_v uuid;
  map1 uuid; map2 uuid; imp uuid; imp2 uuid; imp3 uuid; r text; sample uuid; fail_reading uuid; plan_out jsonb;
  sha1 text := repeat('a', 64); sha2 text := repeat('b', 64); sha3 text := repeat('c', 64);
BEGIN
  PERFORM pg_temp.login(u_owner);
  org := app.create_organisation('CMM Works', 'Plant A', 'PA', NULL);
  SELECT id INTO site FROM public.sites WHERE organisation_id = org;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'CMM-100', 'Housing') RETURNING id INTO part;
  INSERT INTO public.part_revisions (organisation_id, part_id, revision) VALUES (org, part, 'A');
  UPDATE public.part_revisions SET status = 'released' WHERE part_id = part;
  INSERT INTO public.control_plans (organisation_id, plan_code, title) VALUES (org, 'CP-C', 'Housing plan') RETURNING id INTO plan;
  INSERT INTO public.control_plan_applicability (organisation_id, control_plan_id, part_id) VALUES (org, plan, part);
  INSERT INTO public.control_plan_revisions (organisation_id, control_plan_id, revision_code, change_reason) VALUES (org, plan, 'A', 'First') RETURNING id INTO rev;
  INSERT INTO public.control_plan_operations (organisation_id, control_plan_revision_id, operation_code, sequence, name) VALUES (org, rev, 'OP-10', 10, 'Machining') RETURNING id INTO op;
  INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, char_number, sequence, name, nominal, lower_limit, upper_limit, unit_code)
    VALUES (org, rev, op, 'OD', '1', 10, 'Outer diameter', 25, 24.95, 25.05, 'mm'), (org, rev, op, 'LEN', '2', 20, 'Length', 40, 39.9, 40.1, 'mm');
  INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, sequence, name, data_type)
    VALUES (org, rev, op, 'VIS', 30, 'Visual', 'attribute');
  UPDATE public.control_plan_revisions SET status = 'pending_approval' WHERE id = rev;
  UPDATE public.control_plan_revisions SET status = 'approved' WHERE id = rev;
  UPDATE public.control_plan_revisions SET status = 'effective' WHERE id = rev;
  INSERT INTO public.gauges (organisation_id, asset_number, description, site_id) VALUES (org, 'CMM-01', 'Bridge CMM', site) RETURNING id INTO cmm;
  rec := app.start_inspection(site, part);
  PERFORM pg_temp.logout();

  SELECT id INTO viewer_role FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  INSERT INTO public.organisation_users (organisation_id, user_id, status, joined_at) VALUES (org, u_view, 'active', now()) RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) VALUES (org, m, viewer_role);
  PERFORM pg_temp.login(u_other); org_b := app.create_organisation('Elsewhere Ltd'); PERFORM pg_temp.logout();

  -- ---- profiles ----
  PERFORM pg_temp.login(u_owner);
  prof := app.save_measurement_profile(org, jsonb_build_object('name', 'Calypso table', 'format', 'table', 'defaultGaugeId', cmm,
                                                              'settings', jsonb_build_object('delimiter', 'tab', 'columns', jsonb_build_object('feature', 'id', 'actual', 'actual'))));
  PERFORM pg_temp.assert_eq((SELECT current_version || '/' || default_gauge_id FROM public.measurement_import_profiles WHERE id = prof), '1/' || cmm, 'a profile starts at version 1 with its gauge');
  r := pg_temp.fails(format($q$SELECT app.save_measurement_profile(%L, '{"name": "calypso TABLE", "format": "table", "settings": {}}')$q$, org));
  PERFORM pg_temp.assert_eq(r LIKE 'QM008:%already exists%', true, 'names are unique ignoring case');
  r := pg_temp.fails(format($q$SELECT app.save_measurement_profile(%L, '{"name": "Calypso table", "settings": {"delimiter": "comma"}}', %L)$q$, org, prof));
  PERFORM pg_temp.assert_eq(r LIKE 'QM008:%why%', true, 'changing how a file is read needs a reason');
  PERFORM app.save_measurement_profile(org, '{"name": "Calypso table", "settings": {"delimiter": "comma"}, "reason": "New export"}', prof);
  PERFORM app.save_measurement_profile(org, '{"name": "Calypso (bridge CMM)", "description": "Room 2"}', prof);
  PERFORM pg_temp.assert_eq((SELECT name || '/' || current_version || '/' || description FROM public.measurement_import_profiles WHERE id = prof), 'Calypso (bridge CMM)/2/Room 2',
                            'a rename keeps the version, a settings change makes a new one');
  r := pg_temp.fails(format($q$SELECT app.save_measurement_profile(%L, '{"name": "X", "format": "qif"}', %L)$q$, org, prof));
  PERFORM pg_temp.assert_eq(r LIKE 'QM008:%layout cannot change%', true, 'the format is fixed');
  PERFORM pg_temp.logout();
  r := pg_temp.fails(format($q$UPDATE public.measurement_import_profile_versions SET reason = 'x' WHERE profile_id = %L$q$, prof));
  PERFORM pg_temp.assert_eq(r LIKE 'QM008:%cannot be changed%', true, 'saved versions are frozen, even for SQL');
  PERFORM pg_temp.login(u_owner);
  PERFORM app.retire_measurement_profile(prof, 'Machine replaced');
  r := pg_temp.fails(format($q$SELECT app.save_measurement_profile(%L, '{"name": "Y"}', %L)$q$, org, prof));
  PERFORM pg_temp.assert_eq(r LIKE 'QM008:%retired%', true, 'a retired profile cannot be changed');
  PERFORM app.reactivate_measurement_profile(prof);
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login(u_view);
  r := pg_temp.fails(format($q$SELECT app.save_measurement_profile(%L, '{"name": "Mine", "format": "table", "settings": {}}')$q$, org));
  PERFORM pg_temp.assert_eq(r LIKE '42501:%', true, 'a viewer cannot manage profiles');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.measurement_import_profiles WHERE id = prof), 1::bigint, 'but members can read them');
  r := pg_temp.fails(format('INSERT INTO public.measurement_import_profiles (organisation_id, name, format) VALUES (%L, %L, %L)', org, 'Direct', 'table'));
  PERFORM pg_temp.assert_eq(r LIKE '42501:%', true, 'no table writes');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_other);
  r := pg_temp.fails(format($q$SELECT app.retire_measurement_profile(%L, 'Not mine')$q$, prof));
  PERFORM pg_temp.assert_eq(r LIKE 'P0002:%', true, 'another organisation''s profile is not found');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.measurement_import_profiles WHERE id = prof), 0::bigint, 'nor readable');
  PERFORM pg_temp.logout();

  -- ---- feature maps ----
  PERFORM pg_temp.login(u_owner);
  map1 := app.save_feature_map(part, prof, ' VISUAL ', 'vis');
  PERFORM pg_temp.assert_eq((SELECT feature_name || '/' || characteristic_key FROM public.measurement_feature_maps WHERE id = map1), 'VISUAL/VIS', 'trimmed, key in capitals');
  PERFORM pg_temp.assert_eq(app.save_feature_map(part, prof, 'visual', 'VIS'), map1, 'the same match again is the same map');
  map2 := app.save_feature_map(part, prof, 'Visual', 'OD');
  PERFORM pg_temp.assert_eq((SELECT ended_at IS NOT NULL FROM public.measurement_feature_maps WHERE id = map1), true, 'a different characteristic ends the old map');
  PERFORM app.end_feature_map(map2);
  r := pg_temp.fails(format($q$UPDATE public.measurement_feature_maps SET characteristic_key = 'LEN' WHERE id = %L$q$, map2));
  PERFORM pg_temp.assert_eq(r LIKE '42501:%', true, 'maps are not written directly');
  r := pg_temp.fails(format($q$SELECT app.save_feature_map(%L, NULL, 'X', 'not a key')$q$, part));
  PERFORM pg_temp.assert_eq(r LIKE 'QM008:%characteristic key%', true, 'a bad key is refused');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_view);
  r := pg_temp.fails(format($q$SELECT app.save_feature_map(%L, NULL, 'X', 'OD')$q$, part));
  PERFORM pg_temp.assert_eq(r LIKE '42501:%', true, 'a viewer cannot save matches');
  PERFORM pg_temp.logout();

  -- ---- creating a preview ----
  PERFORM pg_temp.login(u_owner);
  r := pg_temp.fails(format('SELECT app.create_inspection_import(%L, %L)', rec, pg_temp.body(org, rec, sha1, 'OTHER-9')));
  PERFORM pg_temp.assert_eq(r LIKE 'QM008:%for part OTHER-9%', true, 'a file for another part is refused');
  r := pg_temp.fails(format('SELECT app.create_inspection_import(%L, %L)', rec, pg_temp.body(org, rec, sha1) || jsonb_build_object('filePath', org::text || '/inspection/' || gen_random_uuid() || '/x.csv')));
  PERFORM pg_temp.assert_eq(r LIKE 'QM008:%folder%', true, 'the file must be in this inspection''s folder');
  r := pg_temp.fails(format('SELECT app.create_inspection_import(%L, %L)', rec, pg_temp.body(org, rec, 'nope')));
  PERFORM pg_temp.assert_eq(r LIKE 'QM008:%fingerprint%', true, 'a file needs its fingerprint');
  PERFORM app.set_job_details(rec, 'WO-1');
  imp := app.create_inspection_import(rec, pg_temp.body(org, rec, sha1, 'cmm-100', 'WO-2') || jsonb_build_object('profileId', prof));
  PERFORM pg_temp.assert_eq((SELECT reference ~ '^IMP-\d\d-0001$' AND status = 'previewed' AND profile_version = 2 AND gauge_id = cmm FROM public.inspection_imports WHERE id = imp), true,
                            'numbered, a preview, with the profile''s version and default gauge');
  PERFORM pg_temp.assert_eq((SELECT warnings -> 0 ->> 'message' FROM public.inspection_imports WHERE id = imp), 'The file names work order WO-2; this inspection is on WO-1',
                            'a different work order is a warning');
  PERFORM pg_temp.assert_eq((SELECT string_agg(feature_name || ':' || coalesce(expected_result, '-') || ':' || mismatch || ':' || match_kind, ' ' ORDER BY position)
                               FROM public.inspection_import_rows WHERE import_id = imp),
                            'CIR_OD:pass:true:balloon LEN_1:fail:false:balloon VISUAL:pass:false:map DATUM_A:-:false:none',
                            'the database works out each result from our limits, and flags the file''s different upper limit');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.inspection_measurements WHERE inspection_record_id = rec), 0::bigint, 'a preview records nothing');

  -- ---- matching ----
  r := pg_temp.fails(format('SELECT app.set_inspection_import_match(%L, %L)',
        (SELECT id FROM public.inspection_import_rows WHERE import_id = imp AND feature_name = 'DATUM_A'),
        (SELECT id FROM public.resolved_inspection_requirements WHERE inspection_record_id = rec AND characteristic_key = 'OD')));
  PERFORM pg_temp.assert_eq(r LIKE 'QM008:%already matched to feature CIR_OD%', true, 'a check is matched to one feature of a part');
  r := pg_temp.fails(format('SELECT app.set_inspection_import_match(%L, %L)', (SELECT id FROM public.inspection_import_rows WHERE import_id = imp AND feature_name = 'VISUAL'), gen_random_uuid()));
  PERFORM pg_temp.assert_eq(r LIKE 'QM008:%not on this inspection%', true, 'only checks of this inspection');
  PERFORM app.set_inspection_import_match((SELECT id FROM public.inspection_import_rows WHERE import_id = imp AND feature_name = 'VISUAL'), NULL);
  PERFORM app.set_inspection_import_match((SELECT id FROM public.inspection_import_rows WHERE import_id = imp AND feature_name = 'DATUM_A'),
                                          (SELECT id FROM public.resolved_inspection_requirements WHERE inspection_record_id = rec AND characteristic_key = 'VIS'));
  PERFORM pg_temp.assert_eq((SELECT problem || '/' || match_kind FROM public.inspection_import_rows WHERE import_id = imp AND feature_name = 'DATUM_A'), 'Visual needs pass or fail/manual',
                            'a number matched to a pass/fail check is a problem, not a reading');
  PERFORM app.set_inspection_import_match((SELECT id FROM public.inspection_import_rows WHERE import_id = imp AND feature_name = 'DATUM_A'), NULL);
  PERFORM app.set_inspection_import_match((SELECT id FROM public.inspection_import_rows WHERE import_id = imp AND feature_name = 'VISUAL'),
                                          (SELECT id FROM public.resolved_inspection_requirements WHERE inspection_record_id = rec AND characteristic_key = 'VIS'));

  -- ---- mismatches must be confirmed ----
  r := pg_temp.fails(format('SELECT app.begin_inspection_import_apply(%L, %L)', imp, cmm));
  PERFORM pg_temp.assert_eq(r LIKE 'QM008:%confirm%', true, 'differences from the control plan must be confirmed first');
  PERFORM app.confirm_inspection_import_mismatches(imp);
  PERFORM app.set_inspection_import_match((SELECT id FROM public.inspection_import_rows WHERE import_id = imp AND feature_name = 'VISUAL'), NULL);
  PERFORM pg_temp.assert_eq((SELECT mismatches_confirmed_at IS NULL FROM public.inspection_imports WHERE id = imp), true, 'a changed match asks again');
  PERFORM app.set_inspection_import_match((SELECT id FROM public.inspection_import_rows WHERE import_id = imp AND feature_name = 'VISUAL'),
                                          (SELECT id FROM public.resolved_inspection_requirements WHERE inspection_record_id = rec AND characteristic_key = 'VIS'));
  PERFORM app.confirm_inspection_import_mismatches(imp);
  PERFORM pg_temp.logout();

  -- ---- reading rights ----
  PERFORM pg_temp.login(u_view);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.inspection_import_rows WHERE import_id = imp), 4::bigint, 'a reader sees the preview');
  r := pg_temp.fails(format('SELECT app.discard_inspection_import(%L)', imp));
  PERFORM pg_temp.assert_eq(r LIKE '42501:%', true, 'but cannot act on it');
  r := pg_temp.fails(format($q$UPDATE public.inspection_import_rows SET value_numeric = 1 WHERE import_id = %L$q$, imp));
  PERFORM pg_temp.assert_eq(r LIKE '42501:%', true, 'no table writes on rows');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_other);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.inspection_imports WHERE id = imp) + (SELECT count(*) FROM public.inspection_import_rows WHERE import_id = imp), 0::bigint,
                            'another organisation reads nothing');
  r := pg_temp.fails(format('SELECT app.begin_inspection_import_apply(%L, NULL)', imp));
  PERFORM pg_temp.assert_eq(r LIKE 'P0002:%', true, 'and finds nothing');
  r := pg_temp.fails(format('SELECT app.create_inspection_import(%L, %L)', rec, pg_temp.body(org, rec, sha2)));
  PERFORM pg_temp.assert_eq(r LIKE 'P0002:%', true, 'nor can import into it');
  PERFORM pg_temp.logout();

  -- ---- applying ----
  PERFORM pg_temp.login(u_owner);
  INSERT INTO public.inspection_samples (organisation_id, inspection_record_id) VALUES (org, rec) RETURNING id INTO sample;
  r := pg_temp.fails(format($q$INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_numeric, import_id)
      SELECT %L, %L, %L, id, 25, %L FROM public.resolved_inspection_requirements WHERE inspection_record_id = %L AND characteristic_key = 'OD'$q$, org, rec, sample, imp, rec));
  PERFORM pg_temp.assert_eq(r LIKE 'QM008:%only come from an import while it is applied%', true, 'a reading cannot claim an import outside applying');
  r := pg_temp.fails(format('SELECT pg_temp.apply(%L, %L, 0.001)', imp, cmm));
  PERFORM pg_temp.assert_eq(r LIKE 'QM008:%different value%', true, 'recording other values than the file is refused');
  r := pg_temp.fails(format('SELECT pg_temp.apply(%L, %L, 0, true)', imp, cmm));
  PERFORM pg_temp.assert_eq(r LIKE 'QM008:%was not recorded%', true, 'leaving a matched feature out is refused');
  r := pg_temp.fails(format('SELECT pg_temp.apply(%L, %L, 0, false, true)', imp, cmm));
  PERFORM pg_temp.assert_eq(r LIKE 'QM008:%import''s gauge%', true, 'readings carry the import''s gauge');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.inspection_imports WHERE id = imp), 'previewed', 'a failed apply leaves the preview as it was');
  sample := pg_temp.apply(imp, cmm);
  PERFORM pg_temp.assert_eq((SELECT status = 'applied' AND applied_by = u_owner AND apply_mode = 'new' FROM public.inspection_imports WHERE id = imp), true, 'applied');
  PERFORM pg_temp.assert_eq((SELECT string_agg(r.feature_name || ':' || m.result || ':' || m.gauge_asset_number, ' ' ORDER BY r.position)
                               FROM public.inspection_import_rows r JOIN public.inspection_measurements m ON m.id = r.measurement_id WHERE r.import_id = imp),
                            'CIR_OD:pass:CMM-01 LEN_1:fail:CMM-01 VISUAL:pass:CMM-01', 'each matched feature became a reading, with the CMM''s state copied');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.inspection_measurements WHERE import_id = imp), 3::bigint, 'the unmatched feature recorded nothing');
  PERFORM pg_temp.assert_eq((SELECT sample_id FROM public.inspection_import_units WHERE import_id = imp), sample, 'the part became the sample');
  r := pg_temp.fails(format('SELECT app.discard_inspection_import(%L)', imp));
  PERFORM pg_temp.assert_eq(r LIKE 'QM008:%only a preview%', true, 'an applied import cannot be discarded');
  PERFORM pg_temp.logout();
  r := pg_temp.fails(format($q$UPDATE public.inspection_import_rows SET requirement_id = NULL, match_kind = 'none' WHERE import_id = %L AND feature_name = 'LEN_1'$q$, imp));
  PERFORM pg_temp.assert_eq(r LIKE 'QM008:%applied%', true, 'an applied import is frozen, even for SQL');
  r := pg_temp.fails(format($q$UPDATE public.inspection_imports SET header = '{}' WHERE id = %L$q$, imp));
  PERFORM pg_temp.assert_eq(r LIKE 'QM008:%applied%', true, 'its header too');
  PERFORM pg_temp.assert_eq((SELECT count(*) > 0 FROM public.audit_events WHERE organisation_id = org AND entity_type = 'inspection_imports' AND entity_id = imp::text), true, 'audited');

  -- ---- the same file once; a retest and a correction ----
  PERFORM pg_temp.login(u_owner);
  imp2 := app.create_inspection_import(rec, pg_temp.body(org, rec, sha1, 'CMM-100'));
  PERFORM app.confirm_inspection_import_mismatches(imp2);
  r := pg_temp.fails(format('SELECT app.begin_inspection_import_apply(%L, %L)', imp2, cmm));
  PERFORM pg_temp.assert_eq(r LIKE 'QM008:%already imported on this inspection (IMP-%', true, 'the same file is applied once');
  PERFORM app.discard_inspection_import(imp2, 'Uploaded twice');
  PERFORM pg_temp.assert_eq((SELECT status || '/' || discard_reason FROM public.inspection_imports WHERE id = imp2), 'discarded/Uploaded twice', 'discarded with a reason, kept');

  -- A re-measure of LEN (new file) applied as a retest of the failed reading.
  SELECT id INTO fail_reading FROM public.inspection_measurements WHERE import_id = imp AND result = 'fail';
  imp3 := app.create_inspection_import(rec, jsonb_set(pg_temp.body(org, rec, sha3), '{units,0,rows}',
            jsonb_build_array(jsonb_build_object('position', 1, 'featureName', 'LEN_1', 'valueNumeric', 40.05, 'requirementId',
                              (SELECT id FROM public.resolved_inspection_requirements WHERE inspection_record_id = rec AND characteristic_key = 'LEN'), 'matchKind', 'balloon'))));
  plan_out := app.begin_inspection_import_apply(imp3, cmm, 'retest');
  INSERT INTO public.inspection_samples (organisation_id, inspection_record_id, is_retest) VALUES (org, rec, true) RETURNING id INTO sample;
  INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_numeric, gauge_id, retest_of_id, import_id)
    SELECT org, rec, sample, requirement_id, 40.05, cmm, fail_reading, imp3 FROM public.inspection_measurements WHERE id = fail_reading;
  PERFORM app.finish_inspection_import_apply(imp3, jsonb_build_array(jsonb_build_object('unitId', plan_out -> 'units' -> 0 ->> 'id', 'sampleId', sample)));
  PERFORM pg_temp.assert_eq((SELECT result FROM public.inspection_measurements WHERE import_id = imp3), 'pass', 'a retest from a file');

  -- A correction needs a reason.
  r := pg_temp.fails(format($q$SELECT app.begin_inspection_import_apply(%L, %L, 'correct')$q$, app.create_inspection_import(rec, pg_temp.body(org, rec, repeat('d', 64))), cmm));
  PERFORM pg_temp.assert_eq(r LIKE 'QM008:%why the readings are being corrected%', true, 'a correction needs a reason');

  -- An expired preview cannot be applied.
  imp2 := app.create_inspection_import(rec, pg_temp.body(org, rec, repeat('e', 64)));
  PERFORM pg_temp.logout();
  SET CONSTRAINTS public.inspection_imports_settled IMMEDIATE;
  SET CONSTRAINTS public.inspection_imports_settled DEFERRED;
  ALTER TABLE public.inspection_imports DISABLE TRIGGER inspection_imports_rules;
  UPDATE public.inspection_imports SET created_at = now() - interval '25 hours' WHERE id = imp2;
  ALTER TABLE public.inspection_imports ENABLE TRIGGER inspection_imports_rules;
  PERFORM pg_temp.login(u_owner);
  r := pg_temp.fails(format('SELECT app.begin_inspection_import_apply(%L, %L)', imp2, cmm));
  PERFORM pg_temp.assert_eq(r LIKE 'QM008:%over a day old%', true, 'a preview over a day old is refused');

  -- ---- storage folders ----
  PERFORM pg_temp.assert_eq(app.inspection_file_allowed(org::text || '/inspection/' || rec::text || '/x-report.csv', true), true, 'uploads go into the running inspection''s folder');
  PERFORM pg_temp.assert_eq(app.inspection_file_allowed(org::text || '/inspection/' || gen_random_uuid()::text || '/x.csv', true), false, 'not into a made-up one');
  PERFORM pg_temp.assert_eq(app.inspection_file_allowed(org::text || '/ncr/' || rec::text || '/x.csv', false), false, 'nor another kind of folder');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_view);
  PERFORM pg_temp.assert_eq(app.inspection_file_allowed(org::text || '/inspection/' || rec::text || '/x-report.csv', false), true, 'a reader can read the file');
  PERFORM pg_temp.assert_eq(app.inspection_file_allowed(org::text || '/inspection/' || rec::text || '/x-report.csv', true), false, 'but not upload');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_other);
  PERFORM pg_temp.assert_eq(app.inspection_file_allowed(org::text || '/inspection/' || rec::text || '/x-report.csv', false), false, 'another organisation cannot read it');
  PERFORM pg_temp.logout();

  -- ---- a finished inspection takes no imports ----
  PERFORM pg_temp.login(u_owner);
  rec2 := app.start_inspection(site, part);
  UPDATE public.inspection_records SET status = 'abandoned', abandon_reason = 'Wrong part loaded' WHERE id = rec2;
  r := pg_temp.fails(format('SELECT app.create_inspection_import(%L, %L)', rec2, pg_temp.body(org, rec2, sha1)));
  PERFORM pg_temp.assert_eq(r LIKE 'QM008:%abandoned%', true, 'not into an abandoned inspection');
  PERFORM pg_temp.assert_eq(app.inspection_file_allowed(org::text || '/inspection/' || rec2::text || '/x.csv', true), false, 'nor its folder');

  -- ---- left half applied: refused at commit ----
  imp3 := app.create_inspection_import(rec, pg_temp.body(org, rec, repeat('f', 64)));
  PERFORM app.confirm_inspection_import_mismatches(imp3);
  PERFORM app.begin_inspection_import_apply(imp3, cmm);
  PERFORM pg_temp.logout();
  r := pg_temp.fails('SET CONSTRAINTS public.inspection_imports_settled IMMEDIATE');
  PERFORM pg_temp.assert_eq(r LIKE 'QM008:%was not finished%', true, 'an import left half applied cannot be committed');
END $$;

ROLLBACK;
