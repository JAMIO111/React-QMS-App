-- Adding later failed readings of an inspection to an NC already raised from it.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('39000000-0000-0000-0000-000000000101', 'owner@ncradd.test'),
  ('39000000-0000-0000-0000-000000000102', 'viewer@ncradd.test');

CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);
GRANT SELECT ON ids TO authenticated;

DO $$
DECLARE
  org uuid; site uuid; fam uuid; part uuid; plan uuid; rev uuid; op uuid; od uuid; od2 uuid;
  rec uuid; rec2 uuid; s1 uuid; s2 uuid; s3 uuid; s4 uuid; s5 uuid; m_good uuid; m_a uuid; m_b uuid; m_c uuid; m_d uuid; m_other uuid; ncr uuid; ncr2 uuid; m uuid;
BEGIN
  PERFORM pg_temp.login('39000000-0000-0000-0000-000000000101');
  org := app.create_organisation('NCR Add Works', 'Plant A', 'PA', NULL);
  SELECT id INTO site FROM public.sites WHERE organisation_id = org;
  INSERT INTO public.part_families (organisation_id, code, name) VALUES (org, 'HCR', 'Rods') RETURNING id INTO fam;
  INSERT INTO public.parts (organisation_id, part_number, name, part_family_id) VALUES (org, 'HCR-100', 'Rod 100', fam) RETURNING id INTO part;
  INSERT INTO public.part_revisions (organisation_id, part_id, revision) VALUES (org, part, 'A');
  UPDATE public.part_revisions SET status = 'released' WHERE organisation_id = org;
  INSERT INTO public.control_plans (organisation_id, plan_code, title) VALUES (org, 'CP-1', 'Rods') RETURNING id INTO plan;
  INSERT INTO public.control_plan_applicability (organisation_id, control_plan_id, part_family_id) VALUES (org, plan, fam);
  INSERT INTO public.control_plan_revisions (organisation_id, control_plan_id, revision_code, change_reason) VALUES (org, plan, 'A', 'First') RETURNING id INTO rev;
  INSERT INTO public.control_plan_operations (organisation_id, control_plan_revision_id, operation_code, name) VALUES (org, rev, 'OP-020', 'Turning') RETURNING id INTO op;
  INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, name, lower_limit, upper_limit, unit_code, criticality)
    VALUES (org, rev, op, 'OD', 'Outer diameter', 24.95, 25.05, 'mm', 'critical');
  UPDATE public.control_plan_revisions SET status = 'pending_approval' WHERE id = rev;
  UPDATE public.control_plan_revisions SET status = 'approved' WHERE id = rev;
  UPDATE public.control_plan_revisions SET status = 'effective' WHERE id = rev;

  rec := app.start_inspection(site, part, NULL, NULL, 'WO-1', 'LOT-1', NULL, 'first_off');
  SELECT id INTO od FROM public.resolved_inspection_requirements WHERE inspection_record_id = rec;
  INSERT INTO public.inspection_samples (organisation_id, inspection_record_id) VALUES (org, rec) RETURNING id INTO s1;
  INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_numeric) VALUES (org, rec, s1, od, 25.0) RETURNING id INTO m_good;
  INSERT INTO public.inspection_samples (organisation_id, inspection_record_id) VALUES (org, rec) RETURNING id INTO s2;
  INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_numeric) VALUES (org, rec, s2, od, 25.07) RETURNING id INTO m_a;
  INSERT INTO public.inspection_samples (organisation_id, inspection_record_id) VALUES (org, rec) RETURNING id INTO s3;
  INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_numeric) VALUES (org, rec, s3, od, 25.08) RETURNING id INTO m_b;
  INSERT INTO public.inspection_samples (organisation_id, inspection_record_id) VALUES (org, rec) RETURNING id INTO s4;
  INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_numeric) VALUES (org, rec, s4, od, 25.09) RETURNING id INTO m_c;
  INSERT INTO public.inspection_samples (organisation_id, inspection_record_id) VALUES (org, rec) RETURNING id INTO s5;
  INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_numeric) VALUES (org, rec, s5, od, 25.10) RETURNING id INTO m_d;

  -- The NC raised for the first failure.
  ncr := app.raise_ncr_from_inspection(rec, ARRAY[m_a], 'Outer diameter above USL', NULL, 'critical', 1, NULL, NULL, false);
  PERFORM pg_temp.assert_eq((SELECT quantity_affected FROM public.nonconformances WHERE id = ncr), 1::numeric, 'quantity starts at one sample');

  -- Adding: links the reading, updates the quantity, emits an event.
  PERFORM pg_temp.assert_eq(app.add_readings_to_ncr(ncr, ARRAY[m_b], 2), 1, 'one reading added');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.inspection_ncr_links WHERE nonconformance_id = ncr AND measurement_id IN (m_a, m_b)), 2::bigint, 'both readings are on the NC');
  PERFORM pg_temp.assert_eq((SELECT quantity_affected FROM public.nonconformances WHERE id = ncr), 2::numeric, 'quantity updated');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.outbox_events WHERE organisation_id = org AND event_type = 'inspection.ncr_readings_added'), 1::bigint, 'event emitted');
  -- Without a quantity the NC's own figure is left alone.
  PERFORM app.add_readings_to_ncr(ncr, ARRAY[m_c]);
  PERFORM pg_temp.assert_eq((SELECT quantity_affected FROM public.nonconformances WHERE id = ncr), 2::numeric, 'quantity untouched when not given');

  -- Refusals.
  PERFORM pg_temp.assert_fails(format('SELECT app.add_readings_to_ncr(%L, ARRAY[%L]::uuid[])', ncr, m_c), 'already on the NC');
  PERFORM pg_temp.assert_fails(format('SELECT app.add_readings_to_ncr(%L, ARRAY[%L]::uuid[])', ncr, m_good), 'a passing reading cannot be added');
  PERFORM pg_temp.assert_fails(format('SELECT app.add_readings_to_ncr(%L, ARRAY[]::uuid[])', ncr), 'at least one reading');
  PERFORM pg_temp.assert_fails(format('SELECT app.add_readings_to_ncr(%L, ARRAY[%L]::uuid[])', gen_random_uuid(), m_d), 'unknown NC');
  -- A corrected reading is not added (add the current one).
  INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_numeric, supersedes_id, correction_reason)
    VALUES (org, rec, s5, od, 25.2, m_d, 'Re-read') RETURNING id INTO m;
  PERFORM pg_temp.assert_fails(format('SELECT app.add_readings_to_ncr(%L, ARRAY[%L]::uuid[])', ncr, m_d), 'a corrected reading is refused');
  PERFORM pg_temp.assert_eq(app.add_readings_to_ncr(ncr, ARRAY[m]), 1, 'the current reading of that sample is accepted');

  -- An NC raised from another inspection (or a manual one for a different one) cannot take these readings.
  rec2 := app.start_inspection(site, part, NULL, NULL, 'WO-2', 'LOT-2', NULL, 'first_off');
  SELECT id INTO od2 FROM public.resolved_inspection_requirements WHERE inspection_record_id = rec2;
  INSERT INTO public.inspection_samples (organisation_id, inspection_record_id) VALUES (org, rec2) RETURNING id INTO s1;
  INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_numeric) VALUES (org, rec2, s1, od2, 24.0) RETURNING id INTO m_other;
  PERFORM pg_temp.assert_fails(format('SELECT app.add_readings_to_ncr(%L, ARRAY[%L]::uuid[])', ncr, m_other), 'the NC was not raised from that inspection');
  PERFORM pg_temp.assert_fails(format('SELECT app.add_readings_to_ncr(%L, ARRAY[%L, %L]::uuid[])', ncr, m_other, m_d), 'readings of two inspections are refused');

  -- Stage rules: draft and open take readings; cancelled and closed do not.
  ncr2 := app.raise_ncr_from_inspection(rec, ARRAY[]::uuid[], 'Second NC', NULL, 'minor', 1, NULL, NULL, true);
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.nonconformances WHERE id = ncr2), 'open', 'second NC is open');
  INSERT INTO public.inspection_samples (organisation_id, inspection_record_id) VALUES (org, rec) RETURNING id INTO s5;
  INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_numeric) VALUES (org, rec, s5, od, 25.3) RETURNING id INTO m_d;
  PERFORM pg_temp.assert_eq(app.add_readings_to_ncr(ncr2, ARRAY[m_d]), 1, 'an open NC takes the reading');
  UPDATE public.nonconformances SET stage = 'cancelled', stage_reason = 'Raised in error' WHERE id = ncr2;
  INSERT INTO public.inspection_samples (organisation_id, inspection_record_id) VALUES (org, rec) RETURNING id INTO s5;
  INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_numeric) VALUES (org, rec, s5, od, 25.4) RETURNING id INTO m_d;
  BEGIN
    PERFORM app.add_readings_to_ncr(ncr2, ARRAY[m_d]);
    RAISE EXCEPTION 'a cancelled NC took a reading';
  EXCEPTION WHEN SQLSTATE 'QM008' THEN
    PERFORM pg_temp.assert_eq(position('cancelled' IN SQLERRM) > 0, true, 'cancelled NC is refused with the reason');
  END;

  -- Members: a viewer reads but cannot add.
  PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '39000000-0000-0000-0000-000000000102', 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  INSERT INTO ids VALUES ('ncr', ncr), ('m_d', m_d);
END $$;

DO $$
BEGIN
  PERFORM pg_temp.login('39000000-0000-0000-0000-000000000102');
  PERFORM pg_temp.assert_fails(format('SELECT app.add_readings_to_ncr(%L, ARRAY[%L]::uuid[])', (SELECT v FROM ids WHERE k = 'ncr'), (SELECT v FROM ids WHERE k = 'm_d')), 'a viewer cannot add readings');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
