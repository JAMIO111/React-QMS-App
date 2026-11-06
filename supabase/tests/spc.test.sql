-- PC6: subgroup assignment on samples, SPC baselines (saved limits, supersession, frozen, permissions)
-- and the spc.* permissions.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('38000000-0000-0000-0000-000000000101', 'owner@spc.test'),
  ('38000000-0000-0000-0000-000000000102', 'inspector@spc.test'),
  ('38000000-0000-0000-0000-000000000103', 'other@spc.test');

CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);
GRANT SELECT ON ids TO authenticated;

DO $$
DECLARE
  org uuid; org2 uuid; site uuid; fam uuid; part uuid; plan uuid; rev uuid; op uuid; rec uuid; rec_i uuid; m uuid;
  s1 uuid; s2 uuid; s3 uuid; s4 uuid; s5 uuid; s6 uuid; b1 uuid; b2 uuid; ids5 uuid[];
BEGIN
  PERFORM pg_temp.login('38000000-0000-0000-0000-000000000101');
  org := app.create_organisation('SPC Works', 'Plant A', 'PA', NULL);
  SELECT id INTO site FROM public.sites WHERE organisation_id = org;
  INSERT INTO public.part_families (organisation_id, code, name) VALUES (org, 'HCR', 'Rods') RETURNING id INTO fam;
  INSERT INTO public.parts (organisation_id, part_number, name, part_family_id) VALUES (org, 'HCR-100', 'Rod 100', fam) RETURNING id INTO part;
  INSERT INTO public.part_revisions (organisation_id, part_id, revision) VALUES (org, part, 'A');
  UPDATE public.part_revisions SET status = 'released' WHERE organisation_id = org;
  INSERT INTO public.control_plans (organisation_id, plan_code, title) VALUES (org, 'CP-1', 'Rods') RETURNING id INTO plan;
  INSERT INTO public.control_plan_applicability (organisation_id, control_plan_id, part_family_id) VALUES (org, plan, fam);
  INSERT INTO public.control_plan_revisions (organisation_id, control_plan_id, revision_code, change_reason) VALUES (org, plan, 'A', 'First') RETURNING id INTO rev;
  INSERT INTO public.control_plan_operations (organisation_id, control_plan_revision_id, operation_code, name) VALUES (org, rev, 'OP-020', 'Turning') RETURNING id INTO op;
  INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, name, lower_limit, upper_limit, unit_code, criticality, spc_eligible, chart_type, subgroup_size)
    VALUES (org, rev, op, 'BORE', 'Bore', 9.9, 10.1, 'mm', 'major', true, 'xbar_r', 3);
  UPDATE public.control_plan_revisions SET status = 'pending_approval' WHERE id = rev;
  UPDATE public.control_plan_revisions SET status = 'approved' WHERE id = rev;
  UPDATE public.control_plan_revisions SET status = 'effective' WHERE id = rev;

  -- Subgroups: three samples of one check fill a subgroup, the fourth starts the next.
  rec := app.start_inspection(site, part, NULL, NULL, NULL, NULL, NULL, 'first_off');
  INSERT INTO public.inspection_samples (organisation_id, inspection_record_id) VALUES (org, rec) RETURNING id INTO s1;
  INSERT INTO public.inspection_samples (organisation_id, inspection_record_id) VALUES (org, rec) RETURNING id INTO s2;
  INSERT INTO public.inspection_samples (organisation_id, inspection_record_id) VALUES (org, rec) RETURNING id INTO s3;
  INSERT INTO public.inspection_samples (organisation_id, inspection_record_id) VALUES (org, rec) RETURNING id INTO s4;
  PERFORM pg_temp.assert_eq((SELECT array_agg(subgroup_number ORDER BY sample_number) FROM public.inspection_samples WHERE inspection_record_id = rec),
    ARRAY[1, 1, 1, 2], 'three samples fill a subgroup, the next starts another');
  -- A different trigger starts a new subgroup even when the last is not full.
  INSERT INTO public.inspection_samples (organisation_id, inspection_record_id, trigger_type) VALUES (org, rec, 'every_n_minutes') RETURNING id INTO s5;
  PERFORM pg_temp.assert_eq((SELECT subgroup_number FROM public.inspection_samples WHERE id = s5), 3, 'a different trigger starts a new subgroup');
  -- Explicit: join an existing one, start the next one; not skip ahead.
  INSERT INTO public.inspection_samples (organisation_id, inspection_record_id, trigger_type, subgroup_number) VALUES (org, rec, 'every_n_minutes', 4) RETURNING id INTO s6;
  PERFORM pg_temp.assert_eq((SELECT subgroup_number FROM public.inspection_samples WHERE id = s6), 4, 'explicit next subgroup');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.inspection_samples (organisation_id, inspection_record_id, subgroup_number) VALUES (%L, %L, 9)$q$, org, rec), 'cannot skip subgroup numbers');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.inspection_samples SET subgroup_number = 1 WHERE id = %L$q$, s4), 'subgroup number is not edited');
  -- Retest samples have no subgroup.
  INSERT INTO public.inspection_samples (organisation_id, inspection_record_id, is_retest) VALUES (org, rec, true) RETURNING id INTO m;
  PERFORM pg_temp.assert_eq((SELECT subgroup_number FROM public.inspection_samples WHERE id = m), NULL::integer, 'retests are in no subgroup');

  -- Baselines
  ids5 := ARRAY[gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid()];
  INSERT INTO public.spc_baselines (organisation_id, part_id, characteristic_key, operation_code, chart_type, subgroup_size, unit_code, window_from, window_to,
      n_points, provisional, measurement_ids, spec_nominal, spec_lower, spec_upper, centre, ucl, lcl, dispersion_centre, dispersion_ucl, dispersion_lcl, sigma)
    VALUES (org, part, 'BORE', 'OP-020', 'xbar_r', 3, 'mm', now() - interval '1 day', now(), 5, true, ids5, 10, 9.9, 10.1, 10.0, 10.05, 9.95, 0.05, 0.13, 0, 0.03)
    RETURNING id INTO b1;
  PERFORM pg_temp.assert_eq((SELECT (created_by = '38000000-0000-0000-0000-000000000101' AND superseded_at IS NULL)::text FROM public.spc_baselines WHERE id = b1), 'true', 'stamped and active');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.spc_baselines (organisation_id, part_id, characteristic_key, chart_type, subgroup_size, window_from, window_to, n_points, provisional, measurement_ids, centre, ucl, lcl, dispersion_centre, dispersion_ucl, dispersion_lcl, sigma)
      VALUES (%L, %L, 'X', 'imr', 3, now(), now(), 5, true, %L, 1, 2, 0, 1, 2, 0, 0.1)$q$, org, part, ids5), 'chart type and subgroup size must agree');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.spc_baselines (organisation_id, part_id, characteristic_key, chart_type, subgroup_size, window_from, window_to, n_points, provisional, measurement_ids, centre, ucl, lcl, dispersion_centre, dispersion_ucl, dispersion_lcl, sigma)
      VALUES (%L, %L, 'X', 'imr', 1, now(), now(), 5, true, %L, 5, 2, 0, 1, 2, 0, 0.1)$q$, org, part, ids5), 'centre must lie between the limits');
  -- Recalculating supersedes the previous baseline of the same scope; the old one stays.
  INSERT INTO public.spc_baselines (organisation_id, part_id, characteristic_key, operation_code, chart_type, subgroup_size, unit_code, window_from, window_to,
      n_points, provisional, measurement_ids, centre, ucl, lcl, dispersion_centre, dispersion_ucl, dispersion_lcl, sigma, rules)
    VALUES (org, part, 'BORE', 'OP-020', 'xbar_r', 3, 'mm', now() - interval '2 day', now(), 6, true, ids5 || gen_random_uuid(), 10.01, 10.06, 9.96, 0.05, 0.13, 0, 0.03, ARRAY['we1', 'we4'])
    RETURNING id INTO b2;
  PERFORM pg_temp.assert_eq((SELECT (superseded_by = b2 AND superseded_at IS NOT NULL)::text FROM public.spc_baselines WHERE id = b1), 'true', 'previous baseline superseded and kept');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.spc_baselines WHERE organisation_id = org AND superseded_at IS NULL), 1::bigint, 'one active baseline per scope');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.spc_baselines (organisation_id, part_id, characteristic_key, chart_type, subgroup_size, window_from, window_to, n_points, provisional, measurement_ids, centre, ucl, lcl, dispersion_centre, dispersion_ucl, dispersion_lcl, sigma, rules)
      VALUES (%L, %L, 'X', 'imr', 1, now(), now(), 5, true, %L, 1, 2, 0, 1, 2, 0, 0.1, ARRAY['we9'])$q$, org, part, ids5), 'unknown rules are refused');
  -- Frozen
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.spc_baselines SET centre = 11 WHERE id = %L$q$, b2), 'limits are never edited');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.spc_baselines SET notes = 'x' WHERE id = %L$q$, b1), 'a superseded baseline is never edited');
  PERFORM pg_temp.assert_fails(format($q$DELETE FROM public.spc_baselines WHERE id = %L$q$, b1), 'baselines are never deleted');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.spc_baselines SET superseded_at = NULL, superseded_by = NULL WHERE id = %L$q$, b1), 'supersession is not undone');
  -- Audited
  PERFORM pg_temp.assert_eq((SELECT count(*) >= 3 FROM public.audit_events WHERE entity_type = 'spc_baselines'), true, 'baseline changes are audited');

  -- Permissions: the inspector reads but cannot save a baseline; another organisation sees nothing.
  PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '38000000-0000-0000-0000-000000000102', 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'inspector';
  PERFORM pg_temp.login('38000000-0000-0000-0000-000000000102');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.spc_baselines), 2::bigint, 'an inspector reads baselines');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.spc_baselines (organisation_id, part_id, characteristic_key, chart_type, subgroup_size, window_from, window_to, n_points, provisional, measurement_ids, centre, ucl, lcl, dispersion_centre, dispersion_ucl, dispersion_lcl, sigma)
      VALUES (%L, %L, 'X', 'imr', 1, now(), now(), 5, true, %L, 1, 2, 0, 1, 2, 0, 0.1)$q$, org, part, ids5), 'only spc.manage saves baselines');
  PERFORM pg_temp.login('38000000-0000-0000-0000-000000000103');
  org2 := app.create_organisation('Other Works', 'Plant', 'PX', NULL);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.spc_baselines), 0::bigint, 'another organisation sees none');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.spc_baselines (organisation_id, part_id, characteristic_key, chart_type, subgroup_size, window_from, window_to, n_points, provisional, measurement_ids, centre, ucl, lcl, dispersion_centre, dispersion_ucl, dispersion_lcl, sigma)
      VALUES (%L, %L, 'X', 'imr', 1, now(), now(), 5, true, %L, 1, 2, 0, 1, 2, 0, 0.1)$q$, org, part, ids5), 'no baselines in a foreign organisation');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.role_permissions WHERE permission_code = 'spc.manage'
                              AND role_id IN (SELECT id FROM public.roles WHERE organisation_id = org AND key = 'inspector')), 0::bigint, 'inspectors cannot manage');
END $$;

ROLLBACK;
