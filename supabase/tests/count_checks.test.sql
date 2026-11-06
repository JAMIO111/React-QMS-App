-- PC8: the defect-count check type — plan rules, readings and their result, and baselines for C / U charts.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES ('3b000000-0000-0000-0000-000000000101', 'owner@count.test');

DO $$
DECLARE
  org uuid; site uuid; fam uuid; part uuid; plan uuid; rev uuid; op uuid; rec uuid; q_def uuid; q_od uuid; q_nolimit uuid;
  s1 uuid; s2 uuid; s3 uuid; s4 uuid; m1 uuid; ids5 uuid[];
BEGIN
  PERFORM pg_temp.login('3b000000-0000-0000-0000-000000000101');
  org := app.create_organisation('Count Works', 'Plant A', 'PA', NULL);
  SELECT id INTO site FROM public.sites WHERE organisation_id = org;
  INSERT INTO public.part_families (organisation_id, code, name) VALUES (org, 'HCR', 'Rods') RETURNING id INTO fam;
  INSERT INTO public.parts (organisation_id, part_number, name, part_family_id) VALUES (org, 'HCR-100', 'Rod 100', fam) RETURNING id INTO part;
  INSERT INTO public.part_revisions (organisation_id, part_id, revision) VALUES (org, part, 'A');
  UPDATE public.part_revisions SET status = 'released' WHERE organisation_id = org;
  INSERT INTO public.control_plans (organisation_id, plan_code, title) VALUES (org, 'CP-1', 'Rods') RETURNING id INTO plan;
  INSERT INTO public.control_plan_applicability (organisation_id, control_plan_id, part_family_id) VALUES (org, plan, fam);
  INSERT INTO public.control_plan_revisions (organisation_id, control_plan_id, revision_code, change_reason) VALUES (org, plan, 'A', 'First') RETURNING id INTO rev;
  INSERT INTO public.control_plan_operations (organisation_id, control_plan_revision_id, operation_code, name) VALUES (org, rev, 'OP-020', 'Turning') RETURNING id INTO op;

  -- A count check: no unit or lower limit; the upper limit (most allowed) is optional; marked for SPC it is a 'defects' chart.
  INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, name, data_type, upper_limit, criticality, spc_eligible, chart_type, subgroup_size)
    VALUES (org, rev, op, 'SCRATCH', 'Scratches', 'count', 2, 'minor', true, 'defects', NULL);
  INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, name, data_type, criticality, spc_eligible, chart_type, subgroup_size)
    VALUES (org, rev, op, 'DENTS', 'Dents (recorded only)', 'count', 'minor', false, NULL, NULL);
  INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, name, nominal, lower_limit, upper_limit, unit_code, criticality)
    VALUES (org, rev, op, 'OD', 'Outer diameter', 25, 24.95, 25.05, 'mm', 'minor');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, name, data_type, unit_code, criticality)
    VALUES (%L, %L, %L, 'C1', 'x', 'count', 'mm', 'minor')$q$, org, rev, op), 'a count has no unit');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, name, data_type, lower_limit, upper_limit, criticality)
    VALUES (%L, %L, %L, 'C2', 'x', 'count', 1, 3, 'minor')$q$, org, rev, op), 'a count has no lower limit');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, name, data_type, upper_limit, criticality)
    VALUES (%L, %L, %L, 'C3', 'x', 'count', -1, 'minor')$q$, org, rev, op), 'the most allowed cannot be negative');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, name, data_type, criticality, spc_eligible, chart_type, subgroup_size)
    VALUES (%L, %L, %L, 'C4', 'x', 'count', 'minor', true, 'p', NULL)$q$, org, rev, op), 'a count cannot have a P chart');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, name, data_type, criticality, spc_eligible, chart_type, subgroup_size)
    VALUES (%L, %L, %L, 'C5', 'x', 'count', 'minor', true, 'defects', 5)$q$, org, rev, op), 'a defects chart has no subgroup size');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, name, data_type, criticality, spc_eligible, chart_type, subgroup_size)
    VALUES (%L, %L, %L, 'C6', 'x', 'attribute', 'minor', true, 'defects', NULL)$q$, org, rev, op), 'a pass/fail check cannot have a defects chart');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, name, nominal, lower_limit, upper_limit, unit_code, criticality, spc_eligible, chart_type, subgroup_size)
    VALUES (%L, %L, %L, 'C7', 'x', 25, 24, 26, 'mm', 'minor', true, 'defects', NULL)$q$, org, rev, op), 'a measured check cannot have a defects chart');
  INSERT INTO public.characteristic_templates (organisation_id, characteristic_key, name, data_type, upper_limit, criticality, spc_eligible, chart_type, subgroup_size)
    VALUES (org, 'SCRATCH', 'Scratches', 'count', 2, 'minor', true, 'defects', NULL);

  UPDATE public.control_plan_revisions SET status = 'pending_approval' WHERE id = rev;
  UPDATE public.control_plan_revisions SET status = 'approved' WHERE id = rev;
  UPDATE public.control_plan_revisions SET status = 'effective' WHERE id = rev;
  rec := app.start_inspection(site, part, NULL, NULL, 'WO-1', 'LOT-1', NULL, 'first_off');
  SELECT id INTO q_def FROM public.resolved_inspection_requirements WHERE inspection_record_id = rec AND characteristic_key = 'SCRATCH';
  SELECT id INTO q_nolimit FROM public.resolved_inspection_requirements WHERE inspection_record_id = rec AND characteristic_key = 'DENTS';
  SELECT id INTO q_od FROM public.resolved_inspection_requirements WHERE inspection_record_id = rec AND characteristic_key = 'OD';
  PERFORM pg_temp.assert_eq((SELECT (data_type, chart_type, upper_limit, unit_code IS NULL)::text FROM public.resolved_inspection_requirements WHERE id = q_def), '(count,defects,2,t)', 'the frozen requirement carries the count settings');

  -- Readings: result from the limit; limits inclusive; no limit never fails.
  INSERT INTO public.inspection_samples (organisation_id, inspection_record_id) VALUES (org, rec) RETURNING id INTO s1;
  INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_count) VALUES (org, rec, s1, q_def, 0);
  INSERT INTO public.inspection_samples (organisation_id, inspection_record_id) VALUES (org, rec) RETURNING id INTO s2;
  INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_count) VALUES (org, rec, s2, q_def, 2);
  INSERT INTO public.inspection_samples (organisation_id, inspection_record_id) VALUES (org, rec) RETURNING id INTO s3;
  INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_count) VALUES (org, rec, s3, q_def, 3) RETURNING id INTO m1;
  INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_count) VALUES (org, rec, s3, q_nolimit, 40);
  PERFORM pg_temp.assert_eq((SELECT array_agg(result ORDER BY value_count) FROM public.inspection_measurements WHERE requirement_id = q_def), ARRAY['pass', 'pass', 'fail'], '0 and 2 pass, 3 fails the limit of 2');
  PERFORM pg_temp.assert_eq((SELECT result FROM public.inspection_measurements WHERE requirement_id = q_nolimit), 'pass', 'a count with no limit never fails');
  PERFORM pg_temp.assert_eq((SELECT unit_code FROM public.inspection_measurements WHERE id = m1), NULL::text, 'no unit');

  -- Refusals.
  INSERT INTO public.inspection_samples (organisation_id, inspection_record_id) VALUES (org, rec) RETURNING id INTO s4;
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_count) VALUES (%L, %L, %L, %L, -1)$q$, org, rec, s4, q_def), 'a count cannot be negative');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_numeric) VALUES (%L, %L, %L, %L, 1.5)$q$, org, rec, s4, q_def), 'a count is not a measured value');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_pass) VALUES (%L, %L, %L, %L, true)$q$, org, rec, s4, q_def), 'a count is not pass/fail');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_count) VALUES (%L, %L, %L, %L, 2)$q$, org, rec, s4, q_od), 'a measured check needs a measured value, not a count');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_numeric, value_count) VALUES (%L, %L, %L, %L, 1, 1)$q$, org, rec, s4, q_def), 'exactly one value per reading');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_count) VALUES (%L, %L, %L, %L, 1)$q$, org, rec, s1, q_def), 'one reading per sample and check');
  -- The over-limit count is a failure: it must be acknowledged before completing.
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.inspection_measurements WHERE inspection_record_id = rec AND result = 'fail'), 1::bigint, 'one failed reading');
  -- Corrections work like other readings.
  INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_count, supersedes_id, correction_reason)
    VALUES (org, rec, s3, q_def, 1, m1, 'Recounted');
  PERFORM pg_temp.assert_eq((SELECT result FROM public.inspection_measurements WHERE supersedes_id = m1), 'pass', 'a corrected count is judged afresh');

  -- Baselines for a defects chart: ū ≥ 0 (may exceed 1), the basis and mean units recorded, no dispersion limits.
  ids5 := ARRAY[gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid()];
  INSERT INTO public.spc_baselines (organisation_id, part_id, characteristic_key, operation_code, chart_type, subgroup_size, subgroup_basis, mean_subgroup_size,
      window_from, window_to, n_points, provisional, measurement_ids, centre, ucl, lcl, sigma)
    VALUES (org, part, 'SCRATCH', 'OP-020', 'defects', NULL, 'inspection', 25, now() - interval '1 day', now(), 5, true, ids5, 1.8, 2.7, 0.9, 0.27);
  PERFORM pg_temp.assert_eq((SELECT (subgroup_basis, mean_subgroup_size)::text FROM public.spc_baselines WHERE characteristic_key = 'SCRATCH'), '(inspection,25)', 'defects baseline stored');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.spc_baselines (organisation_id, part_id, characteristic_key, operation_code, chart_type, subgroup_size, subgroup_basis, mean_subgroup_size, window_from, window_to, n_points, provisional, measurement_ids, centre, ucl, lcl, sigma)
    VALUES (%L, %L, 'S2', 'OP-020', 'defects', NULL, NULL, 25, now(), now(), 5, true, %L, 1.8, 2.7, 0.9, 0.27)$q$, org, part, ids5), 'a defects baseline needs its subgroup basis');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.spc_baselines (organisation_id, part_id, characteristic_key, operation_code, chart_type, subgroup_size, subgroup_basis, mean_subgroup_size, window_from, window_to, n_points, provisional, measurement_ids, centre, ucl, lcl, dispersion_centre, dispersion_ucl, dispersion_lcl, sigma)
    VALUES (%L, %L, 'S2', 'OP-020', 'defects', NULL, 'day', 25, now(), now(), 5, true, %L, 1.8, 2.7, 0.9, 0.1, 0.2, 0, 0.27)$q$, org, part, ids5), 'no dispersion limits on a defects baseline');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.spc_baselines (organisation_id, part_id, characteristic_key, operation_code, chart_type, subgroup_size, subgroup_basis, mean_subgroup_size, window_from, window_to, n_points, provisional, measurement_ids, centre, ucl, lcl, sigma)
    VALUES (%L, %L, 'S2', 'OP-020', 'defects', NULL, 'day', 25, now(), now(), 5, true, %L, -0.1, 0.5, 0, 0.27)$q$, org, part, ids5), 'ū cannot be negative');
END $$;

ROLLBACK;
