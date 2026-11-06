-- PC5: raising an NC from an inspection (pre-filled from the inspection, readings linked, manual NC
-- without readings), acknowledgements of failures, the completion rule, permanent links, permissions
-- and the gauge-usage impact report.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('37000000-0000-0000-0000-000000000101', 'owner@ipn.test'),
  ('37000000-0000-0000-0000-000000000102', 'inspector@ipn.test'),
  ('37000000-0000-0000-0000-000000000103', 'viewer@ipn.test');

CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);
GRANT SELECT ON ids TO authenticated;

DO $$
DECLARE
  org uuid; site uuid; site_b uuid; fam uuid; part uuid; plan uuid; rev uuid; op uuid; mic_type uuid; mic uuid; od uuid;
  rec uuid; rec2 uuid; s1 uuid; s2 uuid; s3 uuid; m_good uuid; m_bad uuid; m_bad2 uuid; m_other uuid; ncr uuid; ncr2 uuid; m uuid;
  n bigint;
BEGIN
  PERFORM pg_temp.login('37000000-0000-0000-0000-000000000101');
  org := app.create_organisation('IPN Works', 'Plant A', 'PA', NULL);
  SELECT id INTO site FROM public.sites WHERE organisation_id = org;
  INSERT INTO public.sites (organisation_id, code, name) VALUES (org, 'PB', 'Plant B') RETURNING id INTO site_b;
  INSERT INTO public.gauge_types (organisation_id, name) VALUES (org, 'Micrometer') RETURNING id INTO mic_type;
  INSERT INTO public.gauges (organisation_id, asset_number, description, gauge_type_id, site_id, next_due_on)
    VALUES (org, 'MIC-1', 'Mic', mic_type, site, current_date + 30) RETURNING id INTO mic;

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

  rec := app.start_inspection(site, part, NULL, NULL, 'WO-9', 'LOT-3', 'SN-77', 'first_off');
  SELECT id INTO od FROM public.resolved_inspection_requirements WHERE inspection_record_id = rec;
  INSERT INTO public.inspection_samples (organisation_id, inspection_record_id, unit_reference) VALUES (org, rec, 'S/N 1') RETURNING id INTO s1;
  INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_numeric, gauge_id) VALUES (org, rec, s1, od, 25.0, mic) RETURNING id INTO m_good;
  INSERT INTO public.inspection_samples (organisation_id, inspection_record_id, unit_reference) VALUES (org, rec, 'S/N 2') RETURNING id INTO s2;
  INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_numeric, gauge_id) VALUES (org, rec, s2, od, 25.07, mic) RETURNING id INTO m_bad;
  INSERT INTO public.inspection_samples (organisation_id, inspection_record_id, unit_reference) VALUES (org, rec, 'S/N 3') RETURNING id INTO s3;
  INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_numeric, gauge_id) VALUES (org, rec, s3, od, 25.08, mic) RETURNING id INTO m_bad2;

  -- Acknowledgements: failed, current readings only; a note is required.
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.inspection_failure_acknowledgements (organisation_id, inspection_record_id, measurement_id, note) VALUES (%L, %L, %L, 'ok')$q$, org, rec, m_good), 'only a failed reading is acknowledged');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.inspection_failure_acknowledgements (organisation_id, inspection_record_id, measurement_id, note) VALUES (%L, %L, %L, '  ')$q$, org, rec, m_bad), 'a note is required');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.inspection_failure_acknowledgements SET note = 'x'$q$), 'acknowledgements are not edited');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.inspection_records SET status = 'completed' WHERE id = %L$q$, rec), 'unhandled failures block completion');
  BEGIN
    UPDATE public.inspection_records SET status = 'completed' WHERE id = rec;
  EXCEPTION WHEN SQLSTATE 'QM008' THEN
    PERFORM pg_temp.assert_eq(SQLERRM, 'Acknowledge or raise an NC for each failed reading before completing: Outer diameter (sample 2), Outer diameter (sample 3)', 'lists the unhandled failures');
  END;
  INSERT INTO public.inspection_failure_acknowledgements (organisation_id, inspection_record_id, measurement_id, note) VALUES (org, rec, m_bad, 'Tool wear; offset changed');
  PERFORM pg_temp.assert_eq((SELECT acknowledged_at IS NOT NULL AND created_by = '37000000-0000-0000-0000-000000000101' FROM public.inspection_failure_acknowledgements WHERE measurement_id = m_bad), true, 'who and when are stamped');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.inspection_failure_acknowledgements (organisation_id, inspection_record_id, measurement_id, note) VALUES (%L, %L, %L, 'again')$q$, org, rec, m_bad), 'one acknowledgement per reading');

  -- Raise an NC for the batch: title required, only failed readings of this inspection, links made.
  PERFORM pg_temp.assert_fails(format('SELECT app.raise_ncr_from_inspection(%L, ARRAY[%L]::uuid[], NULL)', rec, m_bad), 'a title is required');
  PERFORM pg_temp.assert_fails(format('SELECT app.raise_ncr_from_inspection(%L, ARRAY[%L]::uuid[], %L)', rec, m_good, 'x'), 'a passing reading cannot be linked');
  ncr := app.raise_ncr_from_inspection(rec, ARRAY[m_bad, m_bad2], 'Outer diameter above USL on HCR-100', 'Two units over the limit', 'critical', 2,
                                       'Outer diameter 24.95 to 25.05 mm', 'Sample 2: 25.07 mm; sample 3: 25.08 mm', false);
  PERFORM pg_temp.assert_eq((SELECT (source, stage, severity, part_id = part, work_order, lot_number, serial_number, quantity_affected,
                                       site_id = site, detected_by = '37000000-0000-0000-0000-000000000101')::text
                             FROM public.nonconformances WHERE id = ncr),
    '(internal,draft,critical,t,WO-9,LOT-3,SN-77,2,t,t)', 'NC pre-filled from the inspection');
  PERFORM pg_temp.assert_eq((SELECT part_revision_id = (SELECT part_revision_id FROM public.inspection_records WHERE id = rec) FROM public.nonconformances WHERE id = ncr), true, 'part revision from the inspection');
  PERFORM pg_temp.assert_eq((SELECT reference FROM public.nonconformances WHERE id = ncr) <> 'pending', true, 'reference generated');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.inspection_ncr_links WHERE nonconformance_id = ncr AND measurement_id IN (m_bad, m_bad2)), 2::bigint, 'both readings linked');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.outbox_events WHERE organisation_id = org AND event_type = 'inspection.ncr_raised'), 1::bigint, 'event emitted');
  -- Links are permanent; the NC can change freely without losing them.
  PERFORM pg_temp.assert_fails(format($q$DELETE FROM public.inspection_ncr_links WHERE nonconformance_id = %L$q$, ncr), 'links are never deleted');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.inspection_ncr_links SET measurement_id = NULL WHERE nonconformance_id = %L$q$, ncr), 'links are never changed');
  UPDATE public.nonconformances SET title = 'Renamed', severity = 'major' WHERE id = ncr;
  UPDATE public.nonconformances SET stage = 'open' WHERE id = ncr;
  UPDATE public.nonconformances SET stage = 'cancelled', stage_reason = 'Raised in error' WHERE id = ncr;
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.inspection_ncr_links WHERE nonconformance_id = ncr), 2::bigint, 'links survive edits and cancellation');

  -- Now every current failure is handled (m_bad acknowledged, m_bad2 linked): completion works.
  UPDATE public.inspection_records SET status = 'completed' WHERE id = rec;
  PERFORM pg_temp.assert_eq((SELECT (status, result)::text FROM public.inspection_records WHERE id = rec), '(completed,fail)', 'completed with result fail');
  -- A completed inspection can still raise an NC (a failure found on review) — manual, with no readings.
  ncr2 := app.raise_ncr_from_inspection(rec, ARRAY[]::uuid[], 'Burr found on the groove', 'Seen at final check; no measurement covers it', NULL, NULL, NULL, NULL, false);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.inspection_ncr_links WHERE nonconformance_id = ncr2 AND measurement_id IS NULL), 1::bigint, 'manual NC linked to the inspection');
  -- Opening needs the usual minimum (severity, quantity).
  PERFORM pg_temp.assert_fails(format('SELECT app.raise_ncr_from_inspection(%L, ARRAY[]::uuid[], %L, NULL, NULL, NULL, NULL, NULL, true)', rec, 'Open without content'), 'open needs severity and quantity');
  PERFORM app.raise_ncr_from_inspection(rec, ARRAY[]::uuid[], 'Open with content', NULL, 'minor', 1, NULL, NULL, true);
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.nonconformances WHERE title = 'Open with content'), 'open', 'raised straight to open');
  -- Acknowledging after completion is allowed for a current failure (none left unhandled here, so test on a second inspection).

  rec2 := app.start_inspection(site, part);
  INSERT INTO public.inspection_samples (organisation_id, inspection_record_id) VALUES (org, rec2) RETURNING id INTO s1;
  SELECT id INTO od FROM public.resolved_inspection_requirements WHERE inspection_record_id = rec2;
  INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_numeric, gauge_id) VALUES (org, rec2, s1, od, 24.0, mic) RETURNING id INTO m_other;
  PERFORM pg_temp.assert_fails(format('SELECT app.raise_ncr_from_inspection(%L, ARRAY[%L]::uuid[], %L)', rec, m_other, 'wrong inspection'), 'readings of another inspection are refused');
  -- Correcting a failed reading: the corrected (passing) value needs no acknowledgement; the original stays linked if it was.
  INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_numeric, gauge_id, supersedes_id, correction_reason)
    VALUES (org, rec2, s1, od, 25.0, mic, m_other, 'Misread');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.inspection_failure_acknowledgements (organisation_id, inspection_record_id, measurement_id, note) VALUES (%L, %L, %L, 'late')$q$, org, rec2, m_other), 'a corrected reading is not acknowledged');
  UPDATE public.inspection_records SET status = 'completed' WHERE id = rec2;
  PERFORM pg_temp.assert_eq((SELECT result FROM public.inspection_records WHERE id = rec2), 'pass', 'corrected failure does not block completion');

  -- Gauge usage: both inspections used MIC-1.
  SELECT count(*) INTO n FROM app.gauge_usage(mic);
  PERFORM pg_temp.assert_eq(n, 2::bigint, 'two inspections used the gauge');
  PERFORM pg_temp.assert_eq((SELECT readings || '/' || failed_readings FROM app.gauge_usage(mic) WHERE inspection_record_id = rec), '3/2', 'reading and failure counts');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.gauge_usage(mic, now() + interval '1 day')), 0::bigint, 'period filter');

  -- Members: an inspector at Plant B only, an inspector (org-wide) and a viewer.
  PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '37000000-0000-0000-0000-000000000102', 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id, site_id)
    SELECT org, m, id, site_b FROM public.roles WHERE organisation_id = org AND key = 'inspector';
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '37000000-0000-0000-0000-000000000103', 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  INSERT INTO ids VALUES ('org', org), ('rec', rec), ('mic', mic), ('m_bad', m_bad);
END $$;

-- Plant B inspector: cannot see Plant A's inspection, so cannot raise from it or read its links.
DO $$
BEGIN
  PERFORM pg_temp.login('37000000-0000-0000-0000-000000000102');
  PERFORM pg_temp.assert_fails(format('SELECT app.raise_ncr_from_inspection(%L, ARRAY[]::uuid[], %L)', (SELECT v FROM ids WHERE k = 'rec'), 'nope'), 'inspector of another site cannot raise');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.inspection_ncr_links), 0::bigint, 'links hidden from another site');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.gauge_usage((SELECT v FROM ids WHERE k = 'mic'))), 0::bigint, 'gauge usage hidden from another site');
  PERFORM pg_temp.logout();
END $$;

-- Viewer: reads links, cannot raise or acknowledge.
DO $$
DECLARE org uuid := (SELECT v FROM ids WHERE k = 'org'); rec uuid := (SELECT v FROM ids WHERE k = 'rec');
BEGIN
  PERFORM pg_temp.login('37000000-0000-0000-0000-000000000103');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.inspection_ncr_links WHERE inspection_record_id = rec) >= 3, true, 'viewer reads the links');
  PERFORM pg_temp.assert_fails(format('SELECT app.raise_ncr_from_inspection(%L, ARRAY[]::uuid[], %L)', rec, 'nope'), 'viewer cannot raise an NC');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.inspection_failure_acknowledgements (organisation_id, inspection_record_id, measurement_id, note) VALUES (%L, %L, %L, 'x')$q$, org, rec, (SELECT v FROM ids WHERE k = 'm_bad')), 'viewer cannot acknowledge');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
