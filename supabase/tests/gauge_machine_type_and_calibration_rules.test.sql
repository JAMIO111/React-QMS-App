-- Gauges: the machine link, the required type, and the calibration rules fixed after the module audit (migration 20260467100000).
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('33000000-0000-0000-0000-000000000101', 'owner@gm.test'), ('33000000-0000-0000-0000-000000000102', 'inspector@gm.test'),
  ('33000000-0000-0000-0000-000000000103', 'stranger@gm.test');

-- Runs a statement and answers 'ok' or "SQLSTATE: message"; then judges the deferred calibration rules the way the API does.
CREATE FUNCTION pg_temp.tries(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  EXECUTE 'SET CONSTRAINTS calibrations_after, calibration_readings_complete IMMEDIATE';
  EXECUTE 'SET CONSTRAINTS calibrations_after, calibration_readings_complete DEFERRED';
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  u_owner uuid := '33000000-0000-0000-0000-000000000101'; u_insp uuid := '33000000-0000-0000-0000-000000000102'; u_stranger uuid := '33000000-0000-0000-0000-000000000103';
  org uuid; site_a uuid; site_b uuid; dept uuid; m uuid;
  t uuid; t_off uuid; t_plain uuid; mach_a uuid; mach_b uuid; mach_none uuid; mach_off uuid;
  g1 uuid; g2 uuid; g_old uuid; g_dept uuid; gq uuid; gc uuid; gx uuid;
  k uuid; c1 uuid; c2 uuid; c3 uuid; c0 uuid; cx uuid; r text; d date := current_date;
BEGIN
  PERFORM pg_temp.login(u_owner);
  org := app.create_organisation('Gauge Rules', 'Plant A', 'PA', NULL);
  SELECT id INTO site_a FROM public.sites WHERE organisation_id = org;
  INSERT INTO public.sites (organisation_id, code, name) VALUES (org, 'PB', 'Plant B') RETURNING id INTO site_b;
  INSERT INTO public.departments (organisation_id, site_id, code, name) VALUES (org, site_a, 'MACH', 'Machining') RETURNING id INTO dept;
  INSERT INTO public.gauge_types (organisation_id, name) VALUES (org, 'Caliper') RETURNING id INTO t;
  INSERT INTO public.gauge_types (organisation_id, name) VALUES (org, 'Plain') RETURNING id INTO t_plain;
  INSERT INTO public.gauge_types (organisation_id, name, active) VALUES (org, 'Retired type', false) RETURNING id INTO t_off;
  INSERT INTO public.gauge_type_characteristics (organisation_id, gauge_type_id, sort_order, name, nominal, tolerance_minus, tolerance_plus, unit_code)
    VALUES (org, t, 1, '25 mm', 25, 0.02, 0.02, 'mm');
  INSERT INTO public.machines (organisation_id, code, name, site_id) VALUES (org, 'M-A', 'Lathe A', site_a) RETURNING id INTO mach_a;
  INSERT INTO public.machines (organisation_id, code, name, site_id) VALUES (org, 'M-B', 'Lathe B', site_b) RETURNING id INTO mach_b;
  INSERT INTO public.machines (organisation_id, code, name) VALUES (org, 'M-N', 'Mill, no site') RETURNING id INTO mach_none;
  INSERT INTO public.machines (organisation_id, code, name, site_id, active) VALUES (org, 'M-X', 'Old lathe', site_a, false) RETURNING id INTO mach_off;
  PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u_insp, 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'inspector';

  -- ---- A gauge needs a type ----
  PERFORM pg_temp.login(u_owner);
  r := pg_temp.tries(format($q$INSERT INTO public.gauges (organisation_id, asset_number, description, site_id) VALUES (%L, 'NT-1', 'No type', %L)$q$, org, site_a));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM006', 'a new gauge without a gauge type is refused');
  PERFORM pg_temp.assert_eq(r LIKE '%gauge type%', true, 'and says so');
  r := pg_temp.tries(format($q$INSERT INTO public.gauges (organisation_id, asset_number, description, gauge_type_id, site_id) VALUES (%L, 'NT-2', 'Old type', %L, %L)$q$, org, t_off, site_a));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM006', 'a switched-off gauge type cannot be given to a new gauge');
  INSERT INTO public.gauges (organisation_id, asset_number, description, gauge_type_id, site_id) VALUES (org, 'G-1', 'Caliper', t, site_a) RETURNING id INTO g1;
  r := pg_temp.tries(format($q$UPDATE public.gauges SET gauge_type_id = NULL WHERE id = %L$q$, g1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM006', 'a gauge type, once chosen, cannot be cleared');
  r := pg_temp.tries(format($q$UPDATE public.gauges SET gauge_type_id = %L WHERE id = %L$q$, t_off, g1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM006', 'or changed to a switched-off one');
  PERFORM pg_temp.assert_eq(pg_temp.tries(format($q$UPDATE public.gauges SET gauge_type_id = %L WHERE id = %L$q$, t_plain, g1)), 'ok', 'but changed to another active type');
  PERFORM pg_temp.assert_eq(pg_temp.tries(format($q$UPDATE public.gauges SET gauge_type_id = %L WHERE id = %L$q$, t, g1)), 'ok', 'and back');
  PERFORM pg_temp.logout();

  -- A gauge from before the rule (no type) can still be edited, and given a type.
  INSERT INTO public.gauges (organisation_id, asset_number, description, site_id) VALUES (org, 'OLD-1', 'Made before the rule', site_a) RETURNING id INTO g_old;
  PERFORM pg_temp.login(u_owner);
  PERFORM pg_temp.assert_eq(pg_temp.tries(format($q$UPDATE public.gauges SET notes = 'Still editable' WHERE id = %L$q$, g_old)), 'ok', 'a gauge with no type from before the rule can still be edited');
  PERFORM pg_temp.assert_eq(pg_temp.tries(format($q$UPDATE public.gauges SET gauge_type_id = %L WHERE id = %L$q$, t, g_old)), 'ok', 'and given a type');
  PERFORM pg_temp.logout();

  -- ---- The machine a gauge is fixed to ----
  PERFORM pg_temp.login(u_owner);
  INSERT INTO public.gauges (organisation_id, asset_number, description, gauge_type_id, machine_id) VALUES (org, 'G-M1', 'Probe on A', t, mach_a) RETURNING id INTO g2;
  PERFORM pg_temp.assert_eq((SELECT site_id FROM public.gauges WHERE id = g2), site_a, 'a gauge with no site takes the machine''s site');
  r := pg_temp.tries(format($q$INSERT INTO public.gauges (organisation_id, asset_number, description, gauge_type_id, site_id, machine_id) VALUES (%L, 'G-M2', 'Wrong site', %L, %L, %L)$q$, org, t, site_a, mach_b));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM006', 'a machine at another site is refused');
  PERFORM pg_temp.assert_eq(pg_temp.tries(format($q$INSERT INTO public.gauges (organisation_id, asset_number, description, gauge_type_id, site_id, machine_id) VALUES (%L, 'G-M3', 'No-site machine', %L, %L, %L)$q$, org, t, site_b, mach_none)), 'ok',
    'a machine with no site fits any site');
  r := pg_temp.tries(format($q$INSERT INTO public.gauges (organisation_id, asset_number, description, gauge_type_id, machine_id) VALUES (%L, 'G-M4', 'Off machine', %L, %L)$q$, org, t, mach_off));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM006', 'a switched-off machine cannot be chosen');
  PERFORM pg_temp.assert_eq(r LIKE '%switched off%', true, 'and the message says so');
  r := pg_temp.tries(format($q$UPDATE public.gauges SET machine_id = %L WHERE id = %L$q$, mach_b, g2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM006', 'moving a gauge to a machine at another site is refused');
  r := pg_temp.tries(format($q$UPDATE public.gauges SET site_id = %L WHERE id = %L$q$, site_b, g2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM006', 'and so is moving the gauge away from its machine''s site');
  PERFORM pg_temp.assert_eq(pg_temp.tries(format($q$UPDATE public.gauges SET machine_id = NULL WHERE id = %L$q$, g2)), 'ok', 'the machine link can be cleared');
  PERFORM pg_temp.logout();
  -- The machine is switched off later: the gauge can still be edited (the rule is about choosing, not about history).
  UPDATE public.gauges SET machine_id = mach_a WHERE id = g2;
  UPDATE public.machines SET active = false WHERE id = mach_a;
  PERFORM pg_temp.login(u_owner);
  PERFORM pg_temp.assert_eq(pg_temp.tries(format($q$UPDATE public.gauges SET notes = 'Machine retired' WHERE id = %L$q$, g2)), 'ok', 'a gauge on a machine switched off since can still be edited');
  PERFORM pg_temp.logout();
  -- A department that moved to another site no longer makes its gauges un-updatable.
  INSERT INTO public.gauges (organisation_id, asset_number, description, gauge_type_id, site_id, department_id) VALUES (org, 'G-D1', 'In machining', t, site_a, dept) RETURNING id INTO g_dept;
  UPDATE public.departments SET site_id = site_b WHERE id = dept;
  PERFORM pg_temp.login(u_owner);
  PERFORM pg_temp.assert_eq(pg_temp.tries(format($q$UPDATE public.gauges SET notes = 'Department moved' WHERE id = %L$q$, g_dept)), 'ok', 'a gauge whose department moved site can still be updated');
  PERFORM pg_temp.assert_eq(pg_temp.tries(format($q$UPDATE public.gauges SET site_id = %L WHERE id = %L$q$, site_b, g_dept)), 'ok', 'moving it to the department''s new site is fine');
  r := pg_temp.tries(format($q$UPDATE public.gauges SET site_id = %L WHERE id = %L$q$, site_a, g_dept));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM006', 'but changing its site to one the department is not at is refused');
  PERFORM pg_temp.logout();

  -- ---- The outcome looks at the final state ----
  PERFORM pg_temp.login(u_owner);
  INSERT INTO public.gauges (organisation_id, asset_number, description, gauge_type_id, site_id) VALUES (org, 'G-O1', 'Outcome', t, site_a) RETURNING id INTO gx;
  SELECT id INTO k FROM public.gauge_characteristics WHERE gauge_id = gx;
  INSERT INTO public.calibrations (organisation_id, gauge_id, reference, calibrated_on, outcome) VALUES (org, gx, 'x', d, 'pass') RETURNING id INTO cx;
  r := pg_temp.tries(format($q$INSERT INTO public.calibration_readings (organisation_id, calibration_id, characteristic_id, name, nominal, tolerance_minus, tolerance_plus, unit_code, as_found, as_left)
        VALUES (%L, %L, %L, 'x', 0, 0, 0, 'mm', 25.01, 25.5)$q$, org, cx, k));
  PERFORM pg_temp.assert_eq(r, 'ok', 'a reading in tolerance as found and out of tolerance as left is saved');
  PERFORM pg_temp.assert_eq((SELECT outcome FROM public.calibrations WHERE id = cx), 'fail', 'and the calibration fails (it used to read pass)');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.gauges WHERE id = gx), 'quarantined', 'so the gauge is quarantined');
  PERFORM pg_temp.assert_eq(pg_temp.tries(format($q$UPDATE public.calibration_readings SET as_left = 25.00 WHERE calibration_id = %L$q$, cx)), 'ok', 'adjusted again, in tolerance as left');
  PERFORM pg_temp.assert_eq((SELECT outcome FROM public.calibrations WHERE id = cx), 'pass', 'a reading that was in tolerance as found and is in tolerance as left is a pass');
  PERFORM pg_temp.logout();

  -- ---- The gauge follows its latest calibration, and only that ----
  PERFORM pg_temp.login(u_owner);
  INSERT INTO public.gauges (organisation_id, asset_number, description, gauge_type_id, site_id) VALUES (org, 'G-Q1', 'Follows', t_plain, site_a) RETURNING id INTO gq;
  INSERT INTO public.calibrations (organisation_id, gauge_id, reference, calibrated_on, outcome) VALUES (org, gq, 'x', d - 30, 'pass') RETURNING id INTO c1;
  PERFORM pg_temp.assert_eq(pg_temp.tries('SELECT 1'), 'ok', 'first calibration saved');
  PERFORM pg_temp.assert_eq((SELECT last_calibrated_on FROM public.gauges WHERE id = gq), d - 30, 'the gauge takes its dates from the latest calibration');
  INSERT INTO public.calibrations (organisation_id, gauge_id, reference, calibrated_on, outcome) VALUES (org, gq, 'x', d - 10, 'fail') RETURNING id INTO c2;
  PERFORM pg_temp.assert_eq(pg_temp.tries('SELECT 1'), 'ok', 'a failing calibration saved');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.gauges WHERE id = gq), 'quarantined', 'a failed latest calibration quarantines the gauge');
  PERFORM pg_temp.assert_eq((SELECT status_reason FROM public.gauges WHERE id = gq) LIKE 'Failed calibration CAL-%', true, 'with the record named');

  -- Leaving quarantine by hand needs a reason.
  r := pg_temp.tries(format($q$UPDATE public.gauges SET status = 'active' WHERE id = %L$q$, gq));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM006', 'releasing a quarantined gauge by hand without a new reason is refused');
  PERFORM pg_temp.assert_eq(r LIKE '%why%', true, 'and the message asks why');
  PERFORM pg_temp.assert_eq(left(pg_temp.tries(format($q$UPDATE public.gauges SET status = 'active', status_reason = 'Failed calibration' WHERE id = %L$q$, gq)), 5), 'ok'::text, 'a reason is required to be new');
  PERFORM pg_temp.logout();

  -- ---- A back-dated calibration does not move the gauge off its latest one ----
  PERFORM pg_temp.login(u_owner);
  INSERT INTO public.calibrations (organisation_id, gauge_id, reference, calibrated_on, outcome) VALUES (org, gq, 'x', d - 60, 'pass');
  PERFORM pg_temp.assert_eq(pg_temp.tries('SELECT 1'), 'ok', 'a back-dated calibration is saved');
  PERFORM pg_temp.assert_eq((SELECT last_calibrated_on FROM public.gauges WHERE id = gq), d - 10, 'the gauge still shows its latest calibration');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.gauges WHERE id = gq), 'active', 'and a manual release is not undone');

  -- A later passing calibration releases an automatic quarantine without a reason.
  INSERT INTO public.gauges (organisation_id, asset_number, description, gauge_type_id, site_id) VALUES (org, 'G-C1', 'Fails then passes', t_plain, site_a) RETURNING id INTO gc;
  INSERT INTO public.calibrations (organisation_id, gauge_id, reference, calibrated_on, outcome) VALUES (org, gc, 'x', d - 20, 'fail');
  PERFORM pg_temp.assert_eq(pg_temp.tries('SELECT 1'), 'ok', 'failing calibration saved');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.gauges WHERE id = gc), 'quarantined', 'quarantined by the failure');
  INSERT INTO public.calibrations (organisation_id, gauge_id, reference, calibrated_on, outcome) VALUES (org, gc, 'x', d - 1, 'pass');
  PERFORM pg_temp.assert_eq(pg_temp.tries('SELECT 1'), 'ok', 'passing calibration saved');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.gauges WHERE id = gc), 'active', 'a passing calibration lifts the quarantine without a reason');

  -- Deleting the only calibration clears the dates and lifts the automatic quarantine.
  INSERT INTO public.gauges (organisation_id, asset_number, description, gauge_type_id, site_id) VALUES (org, 'G-D2', 'Only calibration fails', t_plain, site_a) RETURNING id INTO g1;
  INSERT INTO public.calibrations (organisation_id, gauge_id, reference, calibrated_on, outcome) VALUES (org, g1, 'x', d - 5, 'fail') RETURNING id INTO c0;
  PERFORM pg_temp.assert_eq(pg_temp.tries('SELECT 1'), 'ok', 'only calibration saved');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.gauges WHERE id = g1), 'quarantined', 'gauge quarantined');
  PERFORM pg_temp.assert_eq(pg_temp.tries(format($q$UPDATE public.calibrations SET deleted_at = now(), delete_reason = 'Entered on the wrong gauge' WHERE id = %L$q$, c0)), 'ok', 'the calibration is deleted');
  PERFORM pg_temp.assert_eq((SELECT last_calibrated_on FROM public.gauges WHERE id = g1) IS NULL, true, 'the gauge has no last calibration date again');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.gauges WHERE id = g1), 'active', 'and the quarantine its failure caused is lifted');
  r := pg_temp.tries(format($q$UPDATE public.calibrations SET deleted_at = now(), delete_reason = 'Again' WHERE id = %L$q$, c0));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM006', 'deleting a calibration twice is refused');
  PERFORM pg_temp.assert_eq(pg_temp.tries(format($q$UPDATE public.gauges SET deleted_at = now(), delete_reason = 'Scrapped' WHERE id = %L$q$, g1)), 'ok', 'a gauge is deleted');
  r := pg_temp.tries(format($q$UPDATE public.gauges SET deleted_at = now(), delete_reason = 'Again' WHERE id = %L$q$, g1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM006', 'deleting a gauge twice is refused');

  -- The technician has to be one of the organisation's people.
  r := pg_temp.tries(format($q$INSERT INTO public.calibrations (organisation_id, gauge_id, reference, calibrated_on, outcome, technician_id) VALUES (%L, %L, 'x', %L, 'pass', %L)$q$, org, gc, d - 2, u_stranger));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM006', 'a technician who is not a member is refused');
  PERFORM pg_temp.assert_eq(pg_temp.tries(format($q$INSERT INTO public.calibrations (organisation_id, gauge_id, reference, calibrated_on, outcome, technician_id) VALUES (%L, %L, 'x', %L, 'pass', %L)$q$, org, gc, d - 2, u_insp)), 'ok', 'a member can be the technician');

  -- A gauge cannot hold the same type check twice.
  r := pg_temp.tries(format($q$INSERT INTO public.gauge_characteristics (organisation_id, gauge_id, template_id, sort_order, name, nominal, tolerance_minus, tolerance_plus, unit_code)
        SELECT organisation_id, gauge_id, template_id, 9, 'Again', nominal, tolerance_minus, tolerance_plus, unit_code FROM public.gauge_characteristics WHERE gauge_id = %L LIMIT 1$q$, g2));
  PERFORM pg_temp.assert_eq(left(r, 5), '23505', 'the same type check cannot be copied onto a gauge twice');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
