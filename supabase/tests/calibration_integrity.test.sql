-- Calibration integrity (audit report H2, H3): every check needs a reading; a saved calibration is corrected only by someone who manages calibration.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('32000000-0000-0000-0000-000000000101', 'owner@ci.test'), ('32000000-0000-0000-0000-000000000102', 'inspector@ci.test');

-- Runs the statement, then judges the readings check (the API does the same before it saves); returns 'ok' or the error.
CREATE FUNCTION pg_temp.saves(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; EXECUTE 'SET CONSTRAINTS calibration_readings_complete IMMEDIATE'; EXECUTE 'SET CONSTRAINTS calibration_readings_complete DEFERRED'; RETURN 'ok';
EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  u_owner uuid := '32000000-0000-0000-0000-000000000101'; u_insp uuid := '32000000-0000-0000-0000-000000000102';
  org uuid; site uuid; t uuid; g uuid; m uuid; c uuid; c_none uuid; k1 uuid; k2 uuid; k3 uuid; r text;
BEGIN
  PERFORM pg_temp.login(u_owner);
  org := app.create_organisation('Cal Integrity', 'Plant A', 'PA', NULL);
  SELECT id INTO site FROM public.sites WHERE organisation_id = org;
  INSERT INTO public.gauge_types (organisation_id, name) VALUES (org, 'Caliper') RETURNING id INTO t;
  INSERT INTO public.gauge_type_characteristics (organisation_id, gauge_type_id, sort_order, name, nominal, tolerance_minus, tolerance_plus, unit_code)
    VALUES (org, t, 1, '25 mm', 25, 0.02, 0.02, 'mm'), (org, t, 2, '50 mm', 50, 0.02, 0.02, 'mm'), (org, t, 3, '100 mm', 100, 0.03, 0.03, 'mm');
  INSERT INTO public.gauges (organisation_id, asset_number, description, gauge_type_id, site_id) VALUES (org, 'G-1', 'Caliper', t, site) RETURNING id INTO g;
  SELECT id INTO k1 FROM public.gauge_characteristics WHERE gauge_id = g AND name = '25 mm';
  SELECT id INTO k2 FROM public.gauge_characteristics WHERE gauge_id = g AND name = '50 mm';
  SELECT id INTO k3 FROM public.gauge_characteristics WHERE gauge_id = g AND name = '100 mm';
  PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u_insp, 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'inspector';

  -- ---- H2: a reading for every check ----
  PERFORM pg_temp.login(u_insp);
  INSERT INTO public.calibrations (organisation_id, gauge_id, reference, calibrated_on, outcome) VALUES (org, g, 'x', current_date, 'pass') RETURNING id INTO c;
  r := pg_temp.saves(format($q$INSERT INTO public.calibration_readings (organisation_id, calibration_id, characteristic_id, name, nominal, tolerance_minus, tolerance_plus, unit_code, as_found)
        VALUES (%L, %L, %L, 'x', 0, 0, 0, 'mm', 25)$q$, org, c, k1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM006', 'one reading out of three checks is refused');
  PERFORM pg_temp.assert_eq(r LIKE '%50 mm%' AND r LIKE '%100 mm%' AND r NOT LIKE '%Missing: 25 mm%', true, 'and says which checks are missing');
  PERFORM pg_temp.assert_eq(pg_temp.saves(format($q$INSERT INTO public.calibration_readings (organisation_id, calibration_id, characteristic_id, name, nominal, tolerance_minus, tolerance_plus, unit_code, as_found)
        SELECT %L, %L, id, 'x', 0, 0, 0, 'mm', nominal FROM public.gauge_characteristics WHERE gauge_id = %L$q$, org, c, g)), 'ok', 'a reading for every check is saved');
  PERFORM pg_temp.assert_eq((SELECT outcome FROM public.calibrations WHERE id = c), 'pass', 'and the outcome is worked out from all of them');
  INSERT INTO public.calibrations (organisation_id, gauge_id, reference, calibrated_on, outcome) VALUES (org, g, 'x', current_date - 1, 'pass') RETURNING id INTO c_none;
  PERFORM pg_temp.assert_eq(pg_temp.saves('SELECT 1'), 'ok', 'a calibration with no readings keeps the outcome it was given');
  PERFORM pg_temp.logout();

  -- ---- H3: a saved calibration is corrected by a manager only ----
  UPDATE public.calibrations SET created_at = now() - interval '2 days' WHERE id IN (c, c_none);
  -- A check added to the gauge after the calibration was recorded does not count against it.
  INSERT INTO public.gauge_characteristics (organisation_id, gauge_id, name, nominal, tolerance_minus, tolerance_plus, unit_code) VALUES (org, g, 'Added later', 5, 0.1, 0.1, 'mm');

  PERFORM pg_temp.login(u_insp);
  r := pg_temp.saves(format($q$UPDATE public.calibration_readings SET as_found = 99 WHERE calibration_id = %L AND name = '100 mm'$q$, c));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM006', 'someone who may only record cannot rewrite a reading afterwards');
  PERFORM pg_temp.assert_eq(r LIKE '%calibration.manage%', true, 'and is told why');
  PERFORM pg_temp.assert_eq((SELECT as_found FROM public.calibration_readings WHERE calibration_id = c AND name = '100 mm'), 100::numeric, 'the reading is unchanged');
  PERFORM pg_temp.assert_eq(left(pg_temp.saves(format($q$UPDATE public.calibrations SET outcome = 'fail' WHERE id = %L$q$, c)), 5), 'QM006', 'or the outcome');
  PERFORM pg_temp.assert_eq(left(pg_temp.saves(format($q$UPDATE public.calibrations SET calibrated_on = current_date - 3 WHERE id = %L$q$, c)), 5), 'QM006', 'or the date');
  PERFORM pg_temp.assert_eq(left(pg_temp.saves(format($q$UPDATE public.calibrations SET deleted_at = now(), delete_reason = 'oops' WHERE id = %L$q$, c)), 5), 'QM006', 'or delete the record');
  PERFORM pg_temp.assert_eq(pg_temp.saves(format($q$UPDATE public.calibrations SET notes = 'Checked twice' WHERE id = %L$q$, c)), 'ok', 'their own notes stay open to them');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login(u_owner);
  PERFORM pg_temp.assert_eq(pg_temp.saves(format($q$UPDATE public.calibration_readings SET as_found = 100.5 WHERE calibration_id = %L AND name = '100 mm'$q$, c)), 'ok', 'a manager corrects a reading');
  PERFORM pg_temp.assert_eq((SELECT outcome FROM public.calibrations WHERE id = c), 'fail', 'and the outcome follows');
  PERFORM pg_temp.assert_eq(pg_temp.saves(format($q$UPDATE public.calibrations SET calibrated_on = current_date - 2 WHERE id = %L$q$, c_none)), 'ok', 'a manager corrects the date of a record');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
