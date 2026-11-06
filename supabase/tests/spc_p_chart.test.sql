-- PC7: P charts — which characteristics may be marked for one, and what a P baseline stores.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES ('3a000000-0000-0000-0000-000000000101', 'owner@pchart.test');

DO $$
DECLARE
  org uuid; fam uuid; part uuid; plan uuid; rev uuid; op uuid; ids5 uuid[];
BEGIN
  PERFORM pg_temp.login('3a000000-0000-0000-0000-000000000101');
  org := app.create_organisation('P Chart Works', 'Plant A', 'PA', NULL);
  INSERT INTO public.part_families (organisation_id, code, name) VALUES (org, 'HCR', 'Rods') RETURNING id INTO fam;
  INSERT INTO public.parts (organisation_id, part_number, name, part_family_id) VALUES (org, 'HCR-100', 'Rod 100', fam) RETURNING id INTO part;
  INSERT INTO public.control_plans (organisation_id, plan_code, title) VALUES (org, 'CP-1', 'Rods') RETURNING id INTO plan;
  INSERT INTO public.control_plan_revisions (organisation_id, control_plan_id, revision_code, change_reason) VALUES (org, plan, 'A', 'First') RETURNING id INTO rev;
  INSERT INTO public.control_plan_operations (organisation_id, control_plan_revision_id, operation_code, name) VALUES (org, rev, 'OP-020', 'Turning') RETURNING id INTO op;

  -- A pass/fail check can be marked for a P chart (no subgroup size: it is whatever was checked).
  INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, name, data_type, criticality, spc_eligible, chart_type, subgroup_size)
    VALUES (org, rev, op, 'VISUAL', 'No chatter marks', 'attribute', 'minor', true, 'p', NULL);
  PERFORM pg_temp.assert_eq((SELECT chart_type FROM public.control_plan_characteristics WHERE characteristic_key = 'VISUAL'), 'p', 'attribute check accepts chart type p');

  -- Not otherwise.
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, name, data_type, criticality, spc_eligible, chart_type, subgroup_size)
    VALUES (%L, %L, %L, 'V2', 'x', 'attribute', 'minor', true, 'p', 5)$q$, org, rev, op), 'a P chart has no fixed subgroup size');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, name, data_type, criticality, spc_eligible, chart_type, subgroup_size)
    VALUES (%L, %L, %L, 'V3', 'x', 'attribute', 'minor', true, 'imr', 1)$q$, org, rev, op), 'an attribute check cannot have an I-MR chart');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, name, data_type, nominal, lower_limit, upper_limit, unit_code, criticality, spc_eligible, chart_type, subgroup_size)
    VALUES (%L, %L, %L, 'OD', 'Outer diameter', 'variable', 25, 24.95, 25.05, 'mm', 'minor', true, 'p', NULL)$q$, org, rev, op), 'a measured check cannot have a P chart');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, name, data_type, criticality, spc_eligible, chart_type, subgroup_size)
    VALUES (%L, %L, %L, 'V4', 'x', 'attribute', 'minor', false, 'p', NULL)$q$, org, rev, op), 'chart type needs the SPC switch');
  -- Existing rules still hold.
  INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, name, nominal, lower_limit, upper_limit, unit_code, criticality, spc_eligible, chart_type, subgroup_size)
    VALUES (org, rev, op, 'OD', 'Outer diameter', 25, 24.95, 25.05, 'mm', 'minor', true, 'xbar_r', 5);
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, name, nominal, lower_limit, upper_limit, unit_code, criticality, spc_eligible, chart_type, subgroup_size)
    VALUES (%L, %L, %L, 'LEN', 'Length', 100, 99, 101, 'mm', 'minor', true, 'xbar_r', 1)$q$, org, rev, op), 'X-bar/R still needs 2 to 10');

  -- Templates follow the same rules.
  INSERT INTO public.characteristic_templates (organisation_id, characteristic_key, name, data_type, criticality, spc_eligible, chart_type, subgroup_size)
    VALUES (org, 'VISUAL', 'Visual check', 'attribute', 'minor', true, 'p', NULL);
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.characteristic_templates (organisation_id, characteristic_key, name, data_type, criticality, spc_eligible, chart_type, subgroup_size)
    VALUES (%L, 'BAD', 'Bad template', 'attribute', 'minor', true, 'xbar_r', 5)$q$, org), 'a template cannot give an attribute check an X-bar/R chart');

  -- Baselines for a P chart: p̄ in 0…1, no dispersion limits, the subgroup basis and mean size recorded.
  ids5 := ARRAY[gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid()];
  INSERT INTO public.spc_baselines (organisation_id, part_id, characteristic_key, operation_code, chart_type, subgroup_size, subgroup_basis, mean_subgroup_size,
      window_from, window_to, n_points, provisional, measurement_ids, centre, ucl, lcl, sigma)
    VALUES (org, part, 'VISUAL', 'OP-020', 'p', NULL, 'inspection', 40, now() - interval '1 day', now(), 5, true, ids5, 0.05, 0.15, 0, 0.034);
  PERFORM pg_temp.assert_eq((SELECT (subgroup_basis, mean_subgroup_size, dispersion_centre IS NULL)::text FROM public.spc_baselines WHERE characteristic_key = 'VISUAL'), '(inspection,40,t)', 'P baseline stored');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.spc_baselines (organisation_id, part_id, characteristic_key, operation_code, chart_type, subgroup_size, subgroup_basis, mean_subgroup_size, window_from, window_to, n_points, provisional, measurement_ids, centre, ucl, lcl, sigma)
    VALUES (%L, %L, 'V9', 'OP-020', 'p', NULL, NULL, 40, now(), now(), 5, true, %L, 0.05, 0.15, 0, 0.03)$q$, org, part, ids5), 'a P baseline needs its subgroup basis');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.spc_baselines (organisation_id, part_id, characteristic_key, operation_code, chart_type, subgroup_size, subgroup_basis, mean_subgroup_size, window_from, window_to, n_points, provisional, measurement_ids, centre, ucl, lcl, sigma)
    VALUES (%L, %L, 'V9', 'OP-020', 'p', NULL, 'day', 40, now(), now(), 5, true, %L, 1.5, 2, 1, 0.03)$q$, org, part, ids5), 'p̄ cannot exceed 1');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.spc_baselines (organisation_id, part_id, characteristic_key, operation_code, chart_type, subgroup_size, subgroup_basis, mean_subgroup_size, window_from, window_to, n_points, provisional, measurement_ids, centre, ucl, lcl, dispersion_centre, dispersion_ucl, dispersion_lcl, sigma)
    VALUES (%L, %L, 'V9', 'OP-020', 'p', NULL, 'day', 40, now(), now(), 5, true, %L, 0.05, 0.15, 0, 0.1, 0.2, 0, 0.03)$q$, org, part, ids5), 'a P baseline has no dispersion limits');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.spc_baselines (organisation_id, part_id, characteristic_key, operation_code, chart_type, subgroup_size, subgroup_basis, window_from, window_to, n_points, provisional, measurement_ids, centre, ucl, lcl, dispersion_centre, dispersion_ucl, dispersion_lcl, sigma)
    VALUES (%L, %L, 'OD', 'OP-020', 'imr', 1, 'day', now(), now(), 5, true, %L, 25, 25.1, 24.9, 0.1, 0.3, 0, 0.1)$q$, org, part, ids5), 'only P baselines carry a subgroup basis');
  -- Replacing a P baseline supersedes it like the others.
  INSERT INTO public.spc_baselines (organisation_id, part_id, characteristic_key, operation_code, chart_type, subgroup_size, subgroup_basis, mean_subgroup_size,
      window_from, window_to, n_points, provisional, measurement_ids, centre, ucl, lcl, sigma)
    VALUES (org, part, 'VISUAL', 'OP-020', 'p', NULL, 'day', 80, now() - interval '2 day', now(), 6, true, ids5 || gen_random_uuid(), 0.04, 0.12, 0, 0.02);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.spc_baselines WHERE characteristic_key = 'VISUAL' AND superseded_at IS NULL), 1::bigint, 'one active P baseline');
END $$;

ROLLBACK;
