-- Calibration: gauge types and template characteristics, gauges (copying the template), readings
-- judged against limits, outcome and its effect on the gauge (dates, quarantine, reinstatement),
-- references, locking, soft delete, permissions, site scoping, storage rules and isolation.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql
-- Judge each statement as it runs (the API flushes the deferred gauge refresh the same way).
SET CONSTRAINTS ALL IMMEDIATE;
-- The "a reading for every check" rule is judged when a calibration is saved (see calibration_integrity.test.sql); these tests add readings one at a time.
SET CONSTRAINTS calibration_readings_complete DEFERRED;

INSERT INTO auth.users (id, email) VALUES
  ('31000000-0000-0000-0000-000000000101', 'owner@cal.test'),
  ('31000000-0000-0000-0000-000000000102', 'inspector@cal.test'),
  ('31000000-0000-0000-0000-000000000103', 'viewer@cal.test'),
  ('31000000-0000-0000-0000-000000000104', 'other@cal.test');

CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);
GRANT SELECT ON ids TO authenticated;

DO $$
DECLARE
  org uuid; site_a uuid; site_b uuid; t uuid; g uuid; g2 uuid; c uuid; c2 uuid; k uuid; r uuid; m uuid;
BEGIN
  PERFORM pg_temp.login('31000000-0000-0000-0000-000000000101');
  org := app.create_organisation('Cal Works', 'Plant A', 'PA', NULL);
  SELECT id INTO site_a FROM public.sites WHERE organisation_id = org;
  INSERT INTO public.sites (organisation_id, code, name) VALUES (org, 'PB', 'Plant B') RETURNING id INTO site_b;

  -- Owners get the calibration permissions with the system roles.
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'calibration.manage'), true, 'owner may manage calibration');

  -- Gauge type with two template characteristics (one inactive).
  INSERT INTO public.gauge_types (organisation_id, name, interval_value, interval_unit) VALUES (org, 'Digital caliper 0-150', 6, 'months') RETURNING id INTO t;
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.gauge_types (organisation_id, name) VALUES (%L, 'digital CALIPER 0-150')$q$, org), 'type names are unique ignoring case');
  INSERT INTO public.gauge_type_characteristics (organisation_id, gauge_type_id, sort_order, name, nominal, tolerance_minus, tolerance_plus, unit_code)
    VALUES (org, t, 1, '25 mm block', 25, 0.02, 0.02, 'mm'), (org, t, 2, '100 mm block', 100, 0.03, 0.03, 'mm');
  INSERT INTO public.gauge_type_characteristics (organisation_id, gauge_type_id, sort_order, name, nominal, tolerance_minus, tolerance_plus, unit_code, active)
    VALUES (org, t, 3, 'Retired check', 1, 0, 0, 'mm', false);
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.gauge_type_characteristics (organisation_id, gauge_type_id, name, nominal, tolerance_minus, tolerance_plus, unit_code) VALUES (%L, %L, 'x', 1, -1, 0, 'mm')$q$, org, t), 'tolerances are not negative');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.gauge_type_characteristics (organisation_id, gauge_type_id, name, nominal, tolerance_minus, tolerance_plus, unit_code) VALUES (%L, %L, 'x', 1, 0, 0, 'furlong')$q$, org, t), 'units come from the catalogue');

  -- Gauge of that type: interval and active characteristics copied.
  INSERT INTO public.gauges (organisation_id, asset_number, description, gauge_type_id, site_id) VALUES (org, 'G-001', 'Caliper', t, site_a) RETURNING id INTO g;
  PERFORM pg_temp.assert_eq((SELECT interval_value || ' ' || interval_unit || '|' || status FROM public.gauges WHERE id = g), '6 months|active', 'interval from the type');
  PERFORM pg_temp.assert_eq((SELECT string_agg(name, ',' ORDER BY sort_order) FROM public.gauge_characteristics WHERE gauge_id = g), '25 mm block,100 mm block', 'active template characteristics copied');
  PERFORM pg_temp.assert_eq((SELECT created_by FROM public.gauge_characteristics WHERE gauge_id = g LIMIT 1), '31000000-0000-0000-0000-000000000101'::uuid, 'copies stamped with the creator');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.gauges (organisation_id, asset_number, description) VALUES (%L, 'g-001', 'Duplicate')$q$, org), 'asset numbers are unique ignoring case');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.gauges (organisation_id, asset_number, description, range_min, range_max) VALUES (%L, 'G-X', 'Bad range', 10, 1)$q$, org), 'range max at least min');
  INSERT INTO public.gauges (organisation_id, asset_number, description, site_id) VALUES (org, 'G-002', 'Plant B micrometer', site_b) RETURNING id INTO g2;
  PERFORM pg_temp.assert_eq((SELECT interval_value || ' ' || interval_unit FROM public.gauges WHERE id = g2), '12 months', 'default interval without a type');
  INSERT INTO public.gauge_characteristics (organisation_id, gauge_id, name, nominal, tolerance_minus, tolerance_plus, unit_code) VALUES (org, g2, 'Zero', 0, 0.002, 0.002, 'mm');
  INSERT INTO public.departments (organisation_id, site_id, code, name) VALUES (org, site_b, 'QB', 'Quality B');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.gauges SET department_id = (SELECT id FROM public.departments WHERE code = 'QB') WHERE id = %L$q$, g), 'department must be at the gauge''s site');

  -- A passing calibration: reference, readings judged, outcome, gauge dates.
  INSERT INTO public.calibrations (organisation_id, gauge_id, reference, calibrated_on, outcome) VALUES (org, g, 'ignored', '2026-01-10', 'fail') RETURNING id INTO c;
  PERFORM pg_temp.assert_eq((SELECT reference ~ '^CAL-\d{2}-001$' FROM public.calibrations WHERE id = c), true, 'reference generated');
  PERFORM pg_temp.assert_eq((SELECT to_char(next_due_on, 'YYYY-MM-DD') FROM public.calibrations WHERE id = c), '2026-07-10', 'next due from the gauge interval');
  INSERT INTO public.calibration_readings (organisation_id, calibration_id, characteristic_id, name, nominal, tolerance_minus, tolerance_plus, unit_code, as_found)
    SELECT org, c, id, 'forged', 0, 99, 99, 'mm', CASE WHEN nominal = 25 THEN 25.015 ELSE 99.98 END FROM public.gauge_characteristics WHERE gauge_id = g;
  PERFORM pg_temp.assert_eq((SELECT string_agg(name || '=' || as_found_ok || '/' || tolerance_minus, ',' ORDER BY sort_order) FROM public.calibration_readings WHERE calibration_id = c),
    '25 mm block=true/0.02,100 mm block=true/0.03', 'limits copied from the characteristic and judged');
  PERFORM pg_temp.assert_eq((SELECT outcome FROM public.calibrations WHERE id = c), 'pass', 'outcome worked out from readings');
  PERFORM pg_temp.assert_eq((SELECT last_calibrated_on || '|' || next_due_on FROM public.gauges WHERE id = g), '2026-01-10|2026-07-10', 'gauge dates follow the calibration');
  UPDATE public.calibrations SET outcome = 'fail' WHERE id = c;
  PERFORM pg_temp.assert_eq((SELECT outcome FROM public.calibrations WHERE id = c), 'pass', 'outcome with readings cannot be overridden');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.calibration_readings SET nominal = 0 WHERE calibration_id = %L$q$, c), 'limits are not editable');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.calibrations (organisation_id, gauge_id, reference, calibrated_on, outcome) VALUES (%L, %L, 'x', current_date + 1, 'pass')$q$, org, g), 'not in the future');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.calibration_readings (organisation_id, calibration_id, characteristic_id, name, nominal, tolerance_minus, tolerance_plus, unit_code, as_found) SELECT %L, %L, id, 'x', 0, 0, 0, 'mm', 0 FROM public.gauge_characteristics WHERE gauge_id = %L$q$, org, c, g2), 'characteristic must be of this gauge');
  PERFORM pg_temp.assert_fails(format($q$DELETE FROM public.calibrations WHERE id = %L$q$, c), 'calibrations are never hard-deleted');

  -- A failing calibration quarantines the gauge; adjusting it back into tolerance is "adjusted".
  INSERT INTO public.calibrations (organisation_id, gauge_id, reference, calibrated_on, outcome) VALUES (org, g, 'x', '2026-03-01', 'pass') RETURNING id INTO c2;
  INSERT INTO public.calibration_readings (organisation_id, calibration_id, characteristic_id, name, nominal, tolerance_minus, tolerance_plus, unit_code, as_found)
    SELECT org, c2, id, 'x', 0, 0, 0, 'mm', CASE WHEN nominal = 25 THEN 25.05 ELSE 100 END FROM public.gauge_characteristics WHERE gauge_id = g;
  PERFORM pg_temp.assert_eq((SELECT outcome FROM public.calibrations WHERE id = c2), 'fail', 'out of tolerance fails');
  PERFORM pg_temp.assert_eq((SELECT status || '|' || status_reason || '|' || last_calibrated_on FROM public.gauges WHERE id = g),
    'quarantined|Failed calibration ' || (SELECT reference FROM public.calibrations WHERE id = c2) || '|2026-03-01', 'failed gauge quarantined');
  UPDATE public.calibration_readings SET as_left = 25.01 WHERE calibration_id = c2 AND nominal = 25;
  PERFORM pg_temp.assert_eq((SELECT outcome FROM public.calibrations WHERE id = c2), 'adjusted', 'in tolerance as left: adjusted');
  PERFORM pg_temp.assert_eq((SELECT status || '|' || coalesce(status_reason, '-') FROM public.gauges WHERE id = g), 'active|-', 'reinstated after adjustment');

  -- Soft delete of a calibration needs a reason; the gauge follows the previous one.
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.calibrations SET deleted_at = now() WHERE id = %L$q$, c2), 'deleting needs a reason');
  UPDATE public.calibrations SET deleted_at = now(), delete_reason = 'Entered against the wrong gauge' WHERE id = c2;
  PERFORM pg_temp.assert_eq((SELECT last_calibrated_on::text FROM public.gauges WHERE id = g), '2026-01-10', 'gauge falls back to the previous calibration');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.calibrations SET notes = 'x' WHERE id = %L$q$, c2), 'deleted records are locked');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.calibration_readings SET as_found = 25 WHERE calibration_id = %L$q$, c2), 'readings of a deleted record are locked');
  UPDATE public.calibrations SET deleted_at = NULL WHERE id = c2;

  -- A record without readings keeps the outcome given (e.g. an external certificate).
  INSERT INTO public.calibrations (organisation_id, gauge_id, reference, calibrated_on, performed_by, certificate_number, outcome, next_due_on)
    VALUES (org, g2, 'x', '2026-02-01', 'external', 'UKAS-123', 'fail', '2027-02-01') RETURNING id INTO r;
  PERFORM pg_temp.assert_eq((SELECT c.outcome || '|' || gg.status || '|' || c.next_due_on FROM public.calibrations c JOIN public.gauges gg ON gg.id = c.gauge_id WHERE c.id = r),
    'fail|quarantined|2027-02-01', 'outcome given without readings; next due as entered');
  -- Retired gauges keep their status.
  UPDATE public.gauges SET status = 'retired' WHERE id = g2;
  UPDATE public.calibrations SET outcome = 'pass' WHERE id = r;
  PERFORM pg_temp.assert_eq((SELECT status FROM public.gauges WHERE id = g2), 'retired', 'retired gauges are not reinstated');
  UPDATE public.gauges SET status = 'active' WHERE id = g2;

  -- Soft delete of a gauge: reason, on its own, locks children until restored.
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.gauges SET deleted_at = now(), description = 'x', delete_reason = 'Lost' WHERE id = %L$q$, g2), 'delete on its own');
  UPDATE public.gauges SET deleted_at = now(), delete_reason = 'Duplicate entry' WHERE id = g2;
  PERFORM pg_temp.assert_eq((SELECT deleted_by FROM public.gauges WHERE id = g2), '31000000-0000-0000-0000-000000000101'::uuid, 'deletion stamped');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.gauges SET location = 'x' WHERE id = %L$q$, g2), 'deleted gauges are locked');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.calibrations (organisation_id, gauge_id, reference, outcome) VALUES (%L, %L, 'x', 'pass')$q$, org, g2), 'no calibrations on a deleted gauge');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.gauge_characteristics SET nominal = 1 WHERE gauge_id = %L$q$, g2), 'characteristics of a deleted gauge are locked');
  UPDATE public.gauges SET deleted_at = NULL WHERE id = g2;
  PERFORM pg_temp.assert_fails(format($q$DELETE FROM public.gauges WHERE id = %L$q$, g), 'gauges are never hard-deleted');

  -- Certificates: only in this record's folder.
  INSERT INTO public.calibration_attachments (organisation_id, calibration_id, storage_path, file_name, size_bytes) VALUES (org, c, org || '/calibration/' || c || '/a-cert.pdf', 'cert.pdf', 100);
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.calibration_attachments (organisation_id, calibration_id, storage_path, file_name, size_bytes) VALUES (%L, %L, %L, 'x', 1)$q$,
    org, c, org || '/calibration/' || c2 || '/x.pdf'), 'file must be in this record''s folder');
  INSERT INTO storage.buckets (id, name) VALUES ('calibration-files', 'calibration-files') ON CONFLICT DO NOTHING;
  PERFORM pg_temp.assert_ok(format($q$INSERT INTO storage.objects (bucket_id, name) VALUES ('calibration-files', %L)$q$, org || '/calibration/' || c || '/a-cert.pdf'), 'upload into the record folder');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO storage.objects (bucket_id, name) VALUES ('calibration-files', %L)$q$, org || '/calibration/' || gen_random_uuid() || '/x.pdf'), 'no folder for a missing record');

  -- History of the gauge covers the gauge and its characteristics.
  PERFORM pg_temp.assert_eq((SELECT count(DISTINCT entity_type) FROM app.gauge_history(g)), 2::bigint, 'gauge history');

  -- Events.
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.outbox_events WHERE organisation_id = org AND event_type = 'calibration.recorded'), 3::bigint, 'recorded events');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.outbox_events WHERE organisation_id = org AND event_type = 'gauge.status_changed') >= 2, true, 'status change events');

  -- Members: an inspector scoped to Plant B, a viewer, an outsider.
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '31000000-0000-0000-0000-000000000102', 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id, site_id)
    SELECT org, m, id, site_b FROM public.roles WHERE organisation_id = org AND key = 'inspector';
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '31000000-0000-0000-0000-000000000103', 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  INSERT INTO ids VALUES ('org', org), ('g', g), ('g2', g2), ('c', c), ('t', t);
END $$;

DO $$
DECLARE
  org uuid := (SELECT v FROM ids WHERE k = 'org');
  g uuid := (SELECT v FROM ids WHERE k = 'g');
  g2 uuid := (SELECT v FROM ids WHERE k = 'g2');
  other uuid;
BEGIN
  -- Plant B inspector: sees and calibrates only Plant B gauges; cannot manage gauges or types.
  PERFORM pg_temp.login('31000000-0000-0000-0000-000000000102');
  PERFORM pg_temp.assert_eq((SELECT string_agg(asset_number, ',') FROM public.gauges), 'G-002', 'site-scoped gauges');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.calibrations WHERE gauge_id = g), 0::bigint, 'no Plant A calibrations');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.gauge_types), 1::bigint, 'types are visible to members');
  PERFORM pg_temp.assert_ok(format($q$INSERT INTO public.calibrations (organisation_id, gauge_id, reference, calibrated_on, outcome) VALUES (%L, %L, 'x', current_date, 'pass')$q$, org, g2), 'inspector records a calibration');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.calibrations (organisation_id, gauge_id, reference, outcome) VALUES (%L, %L, 'x', 'pass')$q$, org, g), 'not at another site');
  PERFORM pg_temp.assert_eq(pg_temp.affected(format($q$UPDATE public.gauges SET location = 'Bench' WHERE id = %L$q$, g2)), 0::bigint, 'inspector cannot edit gauges');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.gauge_types (organisation_id, name) VALUES (%L, 'Mine')$q$, org), 'inspector cannot add types');

  -- Viewer: reads everything, changes nothing.
  PERFORM pg_temp.login('31000000-0000-0000-0000-000000000103');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.gauges), 2::bigint, 'viewer reads gauges');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.calibrations (organisation_id, gauge_id, reference, outcome) VALUES (%L, %L, 'x', 'pass')$q$, org, g2), 'viewer cannot record');

  -- Another organisation sees nothing.
  PERFORM pg_temp.login('31000000-0000-0000-0000-000000000104');
  other := app.create_organisation('Other Cal', 'Main', 'MN', NULL);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.gauges WHERE organisation_id = org), 0::bigint, 'other organisation: no gauges');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.gauge_types WHERE organisation_id = org), 0::bigint, 'other organisation: no types');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.gauge_history(g)), 0::bigint, 'other organisation: no history');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.calibrations (organisation_id, gauge_id, reference, outcome) VALUES (%L, %L, 'x', 'pass')$q$, other, g), 'cannot calibrate another organisation''s gauge');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM audit.events WHERE entity_type IN ('gauges', 'calibrations', 'calibration_readings')) > 5, true, 'calibration audited');
END $$;

-- Attribute (pass/fail) characteristics: copied from the template, recorded as pass/fail.
DO $$
DECLARE
  org uuid := (SELECT v FROM ids WHERE k = 'org');
  t uuid := (SELECT v FROM ids WHERE k = 't');
  g3 uuid; c uuid; k_var uuid; k_attr uuid;
BEGIN
  PERFORM pg_temp.login('31000000-0000-0000-0000-000000000101');
  INSERT INTO public.gauge_type_characteristics (organisation_id, gauge_type_id, sort_order, kind, name) VALUES (org, t, 4, 'attribute', 'Free from damage');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.gauge_type_characteristics (organisation_id, gauge_type_id, kind, name, nominal, tolerance_minus, tolerance_plus, unit_code) VALUES (%L, %L, 'attribute', 'x', 1, 0, 0, 'mm')$q$, org, t), 'attributes have no limits');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.gauge_type_characteristics (organisation_id, gauge_type_id, kind, name) VALUES (%L, %L, 'variable', 'x')$q$, org, t), 'variables need limits');
  INSERT INTO public.gauges (organisation_id, asset_number, description, gauge_type_id) VALUES (org, 'G-003', 'Caliper 3', t) RETURNING id INTO g3;
  PERFORM pg_temp.assert_eq((SELECT kind FROM public.gauge_characteristics WHERE gauge_id = g3 AND name = 'Free from damage'), 'attribute', 'kind copied from the template');
  SELECT id INTO k_var FROM public.gauge_characteristics WHERE gauge_id = g3 AND name = '25 mm block';
  SELECT id INTO k_attr FROM public.gauge_characteristics WHERE gauge_id = g3 AND kind = 'attribute';

  INSERT INTO public.calibrations (organisation_id, gauge_id, reference, outcome) VALUES (org, g3, 'x', 'pass') RETURNING id INTO c;
  INSERT INTO public.calibration_readings (organisation_id, calibration_id, characteristic_id, as_found) VALUES (org, c, k_var, 25.0);
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.calibration_readings (organisation_id, calibration_id, characteristic_id, as_found) VALUES (%L, %L, %L, 1)$q$, org, c, k_attr), 'attribute reading is not a value');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.calibration_readings (organisation_id, calibration_id, characteristic_id) VALUES (%L, %L, %L)$q$, org, c, k_attr), 'attribute reading needs pass or fail');
  INSERT INTO public.calibration_readings (organisation_id, calibration_id, characteristic_id, as_found_pass) VALUES (org, c, k_attr, false);
  PERFORM pg_temp.assert_eq((SELECT outcome FROM public.calibrations WHERE id = c), 'fail', 'a failed check fails the calibration');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.gauges WHERE id = g3), 'quarantined', 'and quarantines the gauge');
  UPDATE public.calibration_readings SET as_left_pass = true WHERE characteristic_id = k_attr;
  PERFORM pg_temp.assert_eq((SELECT outcome FROM public.calibrations WHERE id = c), 'adjusted', 'passing after rework: adjusted');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.calibration_readings SET as_found_pass = true WHERE characteristic_id = %L$q$, k_var), 'a measured reading takes no pass/fail');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
