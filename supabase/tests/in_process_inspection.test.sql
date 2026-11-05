-- PC4: starting an inspection (resolver inside, blocked when the resolver blocks, frozen snapshot),
-- samples and readings (unrounded values, inclusive limits, units, pass/fail checks, not-applicable
-- checks refused), gauges (status copied, invalid gauges need an authorised override), corrections
-- and retests as new rows, completion (all checks measured, result), abandonment, permissions,
-- site scoping and events.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('36000000-0000-0000-0000-000000000101', 'owner@ipi.test'),
  ('36000000-0000-0000-0000-000000000102', 'inspector@ipi.test'),
  ('36000000-0000-0000-0000-000000000103', 'viewer@ipi.test');

CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);
GRANT SELECT ON ids TO authenticated;

DO $$
DECLARE
  org uuid; site uuid; site_b uuid; fam uuid; p100 uuid; p200 uuid; plan uuid; rev uuid; op uuid; op30 uuid; groove uuid; mic_type uuid;
  mic uuid; old_mic uuid; caliper uuid; rec uuid; s1 uuid; s2 uuid; od uuid; len uuid; vis uuid; m_od uuid; m_fix uuid; m uuid; m_len uuid;
  r jsonb; m_id uuid;
BEGIN
  PERFORM pg_temp.login('36000000-0000-0000-0000-000000000101');
  org := app.create_organisation('IPI Works', 'Plant A', 'PA', NULL);
  SELECT id INTO site FROM public.sites WHERE organisation_id = org;
  INSERT INTO public.sites (organisation_id, code, name) VALUES (org, 'PB', 'Plant B') RETURNING id INTO site_b;

  -- Gauges: a valid micrometer, an overdue one, and a caliper (wrong type).
  INSERT INTO public.gauge_types (organisation_id, name) VALUES (org, 'Micrometer 0-25') RETURNING id INTO mic_type;
  INSERT INTO public.gauges (organisation_id, asset_number, description, gauge_type_id, next_due_on) VALUES (org, 'MIC-1', 'Mic', mic_type, current_date + 30) RETURNING id INTO mic;
  INSERT INTO public.gauges (organisation_id, asset_number, description, gauge_type_id, next_due_on) VALUES (org, 'MIC-2', 'Old mic', mic_type, current_date - 1) RETURNING id INTO old_mic;
  INSERT INTO public.gauges (organisation_id, asset_number, description, next_due_on) VALUES (org, 'CAL-9', 'Caliper', current_date + 30) RETURNING id INTO caliper;

  -- Parts and plan: OD fixed (micrometer required), LENGTH part-specific, GROOVE_POS only for HCR-200, VISUAL pass/fail.
  INSERT INTO public.part_families (organisation_id, code, name) VALUES (org, 'HCR', 'Rods') RETURNING id INTO fam;
  INSERT INTO public.parts (organisation_id, part_number, name, part_family_id) VALUES (org, 'HCR-100', 'Rod 100', fam) RETURNING id INTO p100;
  INSERT INTO public.parts (organisation_id, part_number, name, part_family_id) VALUES (org, 'HCR-200', 'Rod 200', fam) RETURNING id INTO p200;
  INSERT INTO public.part_revisions (organisation_id, part_id, revision) SELECT org, id, 'A' FROM public.parts WHERE organisation_id = org;
  INSERT INTO public.part_revision_characteristics (organisation_id, part_revision_id, characteristic_key, nominal, lower_limit, upper_limit, unit_code)
    SELECT org, r2.id, 'LENGTH', 100, 99.9, 100.1, 'mm' FROM public.part_revisions r2 WHERE r2.part_id = p100;
  UPDATE public.part_revisions SET status = 'released' WHERE organisation_id = org AND part_id = p100;

  INSERT INTO public.control_plans (organisation_id, plan_code, title) VALUES (org, 'CP-1', 'Rods') RETURNING id INTO plan;
  INSERT INTO public.control_plan_applicability (organisation_id, control_plan_id, part_family_id) VALUES (org, plan, fam);
  INSERT INTO public.control_plan_revisions (organisation_id, control_plan_id, revision_code, change_reason) VALUES (org, plan, 'A', 'First') RETURNING id INTO rev;
  INSERT INTO public.control_plan_operations (organisation_id, control_plan_revision_id, operation_code, sequence, name) VALUES (org, rev, 'OP-020', 20, 'Turning') RETURNING id INTO op;
  INSERT INTO public.control_plan_operations (organisation_id, control_plan_revision_id, operation_code, sequence, name) VALUES (org, rev, 'OP-030', 30, 'Grooving') RETURNING id INTO op30;
  INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, sequence, name, nominal, lower_limit, upper_limit, unit_code, gauge_type_id)
    VALUES (org, rev, op, 'OD', 10, 'Outer diameter', 25, 24.95, 25.05, 'mm', mic_type);
  INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, sequence, name, value_source, spec_key, unit_code)
    VALUES (org, rev, op, 'LENGTH', 20, 'Overall length', 'part_spec', 'LENGTH', 'mm');
  INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, sequence, name, value_source, applies_to, spec_key, unit_code)
    VALUES (org, rev, op30, 'GROOVE_POS', 10, 'Groove position', 'part_spec', 'selected', 'GROOVE_POS', 'mm') RETURNING id INTO groove;
  INSERT INTO public.characteristic_applicability (organisation_id, control_plan_revision_id, plan_characteristic_id, part_id) VALUES (org, rev, groove, p200);
  INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, sequence, name, data_type)
    VALUES (org, rev, op30, 'VISUAL', 20, 'No chatter marks', 'attribute');

  -- Nothing can start before the plan is effective; HCR-200 has no released revision at all.
  PERFORM pg_temp.assert_fails(format('SELECT app.start_inspection(%L, %L)', site, p100), 'blocked resolver blocks the start');
  UPDATE public.control_plan_revisions SET status = 'pending_approval' WHERE id = rev;
  UPDATE public.control_plan_revisions SET status = 'approved' WHERE id = rev;
  UPDATE public.control_plan_revisions SET status = 'effective' WHERE id = rev;
  PERFORM pg_temp.assert_fails(format('SELECT app.start_inspection(%L, %L)', site, p200), 'HCR-200 has no released revision');
  BEGIN
    PERFORM app.start_inspection(site, p200);
  EXCEPTION WHEN SQLSTATE 'QM008' THEN
    PERFORM pg_temp.assert_eq(SQLERRM LIKE 'The inspection cannot start: Part HCR-200 has no released revision%', true, 'says why it cannot start');
  END;
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.inspection_records (organisation_id, reference, site_id, part_id, part_revision_id, control_plan_id, control_plan_revision_id, snapshot) SELECT %L, 'X', %L, %L, id, %L, %L, '{}' FROM public.part_revisions WHERE part_id = %L$q$, org, site, p100, plan, rev, p100), 'records only through start_inspection');

  -- Start: snapshot frozen, reference generated.
  rec := app.start_inspection(site, p100, NULL, NULL, 'WO-1001', 'LOT-7', NULL, 'first_off');
  PERFORM pg_temp.assert_eq((SELECT reference LIKE 'IPI-__-0001' AND status = 'in_progress' AND trigger_type = 'first_off' AND work_order = 'WO-1001' FROM public.inspection_records WHERE id = rec), true, 'record started');
  PERFORM pg_temp.assert_eq((SELECT string_agg(characteristic_key || ':' || applicable, ',' ORDER BY sequence) FROM public.resolved_inspection_requirements WHERE inspection_record_id = rec),
    'OD:true,LENGTH:true,GROOVE_POS:false,VISUAL:true', 'requirements frozen, not-applicable kept');
  SELECT id INTO od FROM public.resolved_inspection_requirements WHERE inspection_record_id = rec AND characteristic_key = 'OD';
  SELECT id INTO len FROM public.resolved_inspection_requirements WHERE inspection_record_id = rec AND characteristic_key = 'LENGTH';
  SELECT id INTO vis FROM public.resolved_inspection_requirements WHERE inspection_record_id = rec AND characteristic_key = 'VISUAL';
  PERFORM pg_temp.assert_eq((SELECT upper_limit FROM public.resolved_inspection_requirements WHERE id = len), 100.1, 'part value frozen');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.resolved_inspection_requirements SET upper_limit = 9 WHERE id = %L$q$, len), 'requirements cannot change');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.inspection_records SET lot = 'LOT-8' WHERE id = %L$q$, rec), 'context cannot change');
  -- Changing the plan or the part afterwards does not touch the snapshot.
  PERFORM pg_temp.logout();  -- a data fix by the system (users cannot change a released revision)
  UPDATE public.part_revision_characteristics SET upper_limit = 999 WHERE characteristic_key = 'LENGTH';
  PERFORM pg_temp.login('36000000-0000-0000-0000-000000000101');
  PERFORM pg_temp.assert_eq((SELECT upper_limit FROM public.resolved_inspection_requirements WHERE id = len), 100.1, 'snapshot unaffected by later changes');

  -- Sample 1.
  INSERT INTO public.inspection_samples (organisation_id, inspection_record_id, unit_reference) VALUES (org, rec, 'S/N 1') RETURNING id INTO s1;
  PERFORM pg_temp.assert_eq((SELECT sample_number FROM public.inspection_samples WHERE id = s1), 1, 'samples numbered');
  -- OD needs a micrometer: none, the wrong type and an overdue one are refused; on the limit passes.
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_numeric) VALUES (%L, %L, %L, %L, 25.05)$q$, org, rec, s1, od), 'required gauge type needs a gauge');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_numeric, gauge_id) VALUES (%L, %L, %L, %L, 25.05, %L)$q$, org, rec, s1, od, caliper), 'wrong gauge type refused');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_numeric, gauge_id) VALUES (%L, %L, %L, %L, 25.05, %L)$q$, org, rec, s1, od, old_mic), 'overdue gauge refused without override');
  INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_numeric, gauge_id) VALUES (org, rec, s1, od, 25.05, mic) RETURNING id INTO m_od;
  PERFORM pg_temp.assert_eq((SELECT (result, unit_code, gauge_asset_number, gauge_valid)::text FROM public.inspection_measurements WHERE id = m_od), '(pass,mm,MIC-1,t)', 'on the limit passes; gauge copied');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_numeric, gauge_id) VALUES (%L, %L, %L, %L, 25.0, %L)$q$, org, rec, s1, od, mic), 'one reading per check per sample');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.inspection_measurements SET value_numeric = 25 WHERE id = %L$q$, m_od), 'readings never change');
  -- LENGTH: unrounded value just over the limit fails; another unit is refused.
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_numeric, unit_code) VALUES (%L, %L, %L, %L, 3.94, 'in')$q$, org, rec, s1, len), 'unit must match');
  INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_numeric) VALUES (org, rec, s1, len, 100.1000001) RETURNING id INTO m_len;
  PERFORM pg_temp.assert_eq((SELECT (result, value_numeric)::text FROM public.inspection_measurements WHERE id = m_len), '(fail,100.1000001)', 'unrounded value fails and is kept');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.outbox_events WHERE organisation_id = org AND event_type = 'inspection.measurement.failed'), 1::bigint, 'failure event');
  -- VISUAL needs pass/fail; GROOVE_POS does not apply to HCR-100.
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_numeric) VALUES (%L, %L, %L, %L, 1)$q$, org, rec, s1, vis), 'pass/fail check needs pass/fail');
  INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_pass) VALUES (org, rec, s1, vis, true);
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_numeric) SELECT %L, %L, %L, id, 40 FROM public.resolved_inspection_requirements WHERE inspection_record_id = %L AND characteristic_key = 'GROOVE_POS'$q$, org, rec, s1, rec), 'not-applicable check refused');

  -- Correction (with reason) of the LENGTH typo; a retest in a new sample keeps the failed reading.
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_numeric, supersedes_id) VALUES (%L, %L, %L, %L, 100.0, %L)$q$, org, rec, s1, len, m_len), 'correction needs a reason');
  INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_numeric, supersedes_id, correction_reason)
    VALUES (org, rec, s1, len, 100.0, m_len, 'Typed 100.1000001 for 100.0') RETURNING id INTO m_fix;
  PERFORM pg_temp.assert_eq((SELECT result FROM public.inspection_measurements WHERE id = m_fix), 'pass', 'corrected reading passes');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.inspection_measurements WHERE requirement_id = len), 2::bigint, 'original reading kept');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_numeric, supersedes_id, correction_reason) VALUES (%L, %L, %L, %L, 100.0, %L, 'again')$q$, org, rec, s1, len, m_len), 'a reading is corrected once');

  INSERT INTO public.inspection_samples (organisation_id, inspection_record_id, is_retest) VALUES (org, rec, true) RETURNING id INTO s2;
  INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_numeric, gauge_id) VALUES (org, rec, s2, od, 25.06, mic) RETURNING id INTO m;
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_numeric, gauge_id, retest_of_id) VALUES (%L, %L, %L, %L, 25.0, %L, %L)$q$, org, rec, s2, od, mic, m_od), 'retest only of a failed reading');
  -- Overdue gauge with an override reason (owner may override): recorded with its state.
  INSERT INTO public.inspection_samples (organisation_id, inspection_record_id, is_retest) VALUES (org, rec, true) RETURNING id INTO s1;
  INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_numeric, gauge_id, retest_of_id, gauge_override_reason)
    VALUES (org, rec, s1, od, 25.00, old_mic, m, 'Only micrometer on shift; checked against slip gauge') RETURNING id INTO m_id;
  PERFORM pg_temp.assert_eq((SELECT (result, gauge_valid, gauge_status)::text FROM public.inspection_measurements WHERE id = m_id), '(pass,f,active)', 'override recorded with the gauge state');

  -- Completion: the failed OD reading in sample 2 stays current, so the result is fail.
  UPDATE public.inspection_records SET status = 'completed' WHERE id = rec;
  PERFORM pg_temp.assert_eq((SELECT (status, result, completed_by IS NOT NULL)::text FROM public.inspection_records WHERE id = rec), '(completed,fail,t)', 'completed with result fail');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.inspection_samples (organisation_id, inspection_record_id) VALUES (%L, %L)$q$, org, rec), 'no samples after completion');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.inspection_records SET status = 'in_progress' WHERE id = %L$q$, rec), 'completed stays completed');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.outbox_events WHERE organisation_id = org AND event_type IN ('inspection.started', 'inspection.completed')), 2::bigint, 'start and completion events');

  -- A second inspection: completing with missing checks is refused; abandoning needs a reason.
  m_id := app.start_inspection(site, p100, 'OP-020');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.resolved_inspection_requirements WHERE inspection_record_id = m_id), 2::bigint, 'one operation only');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.inspection_records SET status = 'completed' WHERE id = %L$q$, m_id), 'unmeasured checks block completion');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.inspection_records SET status = 'abandoned' WHERE id = %L$q$, m_id), 'abandon needs a reason');
  UPDATE public.inspection_records SET status = 'abandoned', abandon_reason = 'Wrong lot' WHERE id = m_id;

  -- Members: an inspector at Plant B only, and a viewer.
  PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '36000000-0000-0000-0000-000000000102', 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id, site_id)
    SELECT org, m, id, site_b FROM public.roles WHERE organisation_id = org AND key = 'inspector';
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '36000000-0000-0000-0000-000000000103', 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  INSERT INTO ids VALUES ('org', org), ('site', site), ('site_b', site_b), ('p100', p100), ('rec', rec), ('old_mic', old_mic), ('mic', mic);
END $$;

-- Plant B inspector: cannot see or start Plant A inspections; at Plant B records, but cannot override gauges.
DO $$
DECLARE org uuid := (SELECT v FROM ids WHERE k = 'org'); rec uuid; s uuid; od uuid;
BEGIN
  PERFORM pg_temp.login('36000000-0000-0000-0000-000000000102');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.inspection_records WHERE id = (SELECT v FROM ids WHERE k = 'rec')), 0::bigint, 'Plant A inspection hidden');
  PERFORM pg_temp.assert_fails(format('SELECT app.start_inspection(%L, %L)', (SELECT v FROM ids WHERE k = 'site'), (SELECT v FROM ids WHERE k = 'p100')), 'cannot start at Plant A');
  rec := app.start_inspection((SELECT v FROM ids WHERE k = 'site_b'), (SELECT v FROM ids WHERE k = 'p100'));
  INSERT INTO public.inspection_samples (organisation_id, inspection_record_id) VALUES (org, rec) RETURNING id INTO s;
  SELECT id INTO od FROM public.resolved_inspection_requirements WHERE inspection_record_id = rec AND characteristic_key = 'OD';
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_numeric, gauge_id, gauge_override_reason) VALUES (%L, %L, %L, %L, 25, %L, 'please')$q$, org, rec, s, od, (SELECT v FROM ids WHERE k = 'old_mic')), 'inspector cannot override a gauge');
  INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_numeric, gauge_id) VALUES (org, rec, s, od, 25.2, (SELECT v FROM ids WHERE k = 'mic'));
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_numeric, gauge_id, supersedes_id, correction_reason) SELECT %L, %L, %L, %L, 25, %L, id, 'typo' FROM public.inspection_measurements WHERE sample_id = %L$q$, org, rec, s, od, (SELECT v FROM ids WHERE k = 'mic'), s), 'inspector cannot correct');
  PERFORM pg_temp.logout();
END $$;

-- Viewer: reads, records nothing.
DO $$
DECLARE org uuid := (SELECT v FROM ids WHERE k = 'org'); rec uuid := (SELECT v FROM ids WHERE k = 'rec');
BEGIN
  PERFORM pg_temp.login('36000000-0000-0000-0000-000000000103');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.inspection_measurements WHERE inspection_record_id = rec) >= 5, true, 'viewer reads readings');
  PERFORM pg_temp.assert_fails(format('SELECT app.start_inspection(%L, %L)', (SELECT v FROM ids WHERE k = 'site'), (SELECT v FROM ids WHERE k = 'p100')), 'viewer cannot start');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
