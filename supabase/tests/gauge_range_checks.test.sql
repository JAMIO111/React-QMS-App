-- Gauge type checks placed across the gauge's range, and tolerances worked out four ways (migration 20260468100000, docs/gauge-range-checks-plan.md).
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('34000000-0000-0000-0000-000000000101', 'owner@rc.test'), ('34000000-0000-0000-0000-000000000102', 'inspector@rc.test'),
  ('34000000-0000-0000-0000-000000000103', 'stranger@rc.test');

-- Runs a statement and answers 'ok' or "SQLSTATE: message"; then judges the deferred calibration rules the way the API does.
CREATE FUNCTION pg_temp.tries(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  EXECUTE 'SET CONSTRAINTS calibrations_after, calibration_readings_complete IMMEDIATE';
  EXECUTE 'SET CONSTRAINTS calibrations_after, calibration_readings_complete DEFERRED';
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

-- One gauge check by name.
CREATE FUNCTION pg_temp.chk(p_gauge uuid, p_name text) RETURNS public.gauge_characteristics LANGUAGE sql AS $$
  SELECT k FROM public.gauge_characteristics k WHERE k.gauge_id = p_gauge AND k.name = p_name
$$;

DO $$
DECLARE
  u_owner uuid := '34000000-0000-0000-0000-000000000101'; u_insp uuid := '34000000-0000-0000-0000-000000000102'; u_stranger uuid := '34000000-0000-0000-0000-000000000103';
  org uuid; org_x uuid; site uuid; m uuid;
  t_fixed uuid; t uuid; t_zero uuid; t_read uuid; t_mix uuid; t_ap uuid;
  k_mid uuid;
  g_fixed uuid; ga uuid; gb uuid; gc uuid; g_in uuid; g_forge uuid; g_ap1 uuid; g_ap2 uuid;
  r text; j jsonb; ch public.gauge_characteristics; cal uuid; rd uuid; n integer;
BEGIN
  PERFORM pg_temp.login(u_owner);
  org := app.create_organisation('Range Checks', 'Plant A', 'PA', NULL);
  SELECT id INTO site FROM public.sites WHERE organisation_id = org;
  PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u_insp, 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'inspector';
  PERFORM pg_temp.login(u_stranger);
  org_x := app.create_organisation('Other Works', 'Plant X', 'PX', NULL);
  PERFORM pg_temp.logout();

  -- ---- Types ----
  INSERT INTO public.gauge_types (organisation_id, name, code) VALUES (org, 'Plain caliper', 'CAL') RETURNING id INTO t_fixed;
  INSERT INTO public.gauge_type_characteristics (organisation_id, gauge_type_id, sort_order, name, nominal, tolerance_minus, tolerance_plus, unit_code)
    VALUES (org, t_fixed, 1, '25 mm', 25, 0.02, 0.03, 'mm');

  INSERT INTO public.gauge_types (organisation_id, name, code) VALUES (org, 'Micrometer', 'MIC') RETURNING id INTO t;
  INSERT INTO public.gauge_type_characteristics (organisation_id, gauge_type_id, sort_order, name, nominal_basis, nominal, tolerance_minus, tolerance_plus, unit_code, tolerance_source)
    VALUES (org, t, 1, 'Start', 'span_percent', 0, 0.004, 0.004, NULL, NULL);
  INSERT INTO public.gauge_type_characteristics (organisation_id, gauge_type_id, sort_order, name, nominal_basis, nominal, tolerance_basis, tolerance_minus, tolerance_plus, unit_code, tolerance_source)
    VALUES (org, t, 2, 'Odd', 'span_percent', 20.4, 'value', 0.004, 0.004, NULL, NULL),
           (org, t, 3, 'Mid', 'span_percent', 50, 'span_percent', 1, 1, NULL, 'Maker datasheet');
  INSERT INTO public.gauge_type_characteristics (organisation_id, gauge_type_id, sort_order, name, nominal_basis, nominal, tolerance_basis, tolerance_minus, tolerance_plus, tolerance_reading_percent, unit_code)
    VALUES (org, t, 5, 'End', 'span_percent', 100, 'value_plus_reading_percent', 0.003, 0.003, 0.01, NULL);
  INSERT INTO public.gauge_type_characteristics (organisation_id, gauge_type_id, sort_order, name, nominal_basis, nominal, tolerance_minus, tolerance_plus, unit_code)
    VALUES (org, t, 4, 'Third', 'span_percent', 33.333, 0.004, 0.004, NULL);
  INSERT INTO public.gauge_type_characteristics (organisation_id, gauge_type_id, sort_order, name, nominal, tolerance_basis, tolerance_minus, tolerance_plus, unit_code)
    VALUES (org, t, 6, 'Fixed 20', 20, 'reading_percent', 4, 4, 'mm');
  INSERT INTO public.gauge_type_characteristics (organisation_id, gauge_type_id, sort_order, kind, name)
    VALUES (org, t, 7, 'attribute', 'Free from damage');
  SELECT id INTO k_mid FROM public.gauge_type_characteristics WHERE gauge_type_id = t AND name = 'Mid';

  INSERT INTO public.gauge_types (organisation_id, name, code) VALUES (org, 'Zero point', 'ZER') RETURNING id INTO t_zero;
  INSERT INTO public.gauge_type_characteristics (organisation_id, gauge_type_id, sort_order, name, nominal_basis, nominal, tolerance_basis, tolerance_minus, tolerance_plus, unit_code)
    VALUES (org, t_zero, 1, 'At zero', 'span_percent', 0, 'reading_percent', 1, 1, NULL);

  INSERT INTO public.gauge_types (organisation_id, name, code) VALUES (org, 'Torque tool', 'TOR') RETURNING id INTO t_read;
  INSERT INTO public.gauge_type_characteristics (organisation_id, gauge_type_id, sort_order, name, nominal, tolerance_basis, tolerance_minus, tolerance_plus, unit_code)
    VALUES (org, t_read, 1, '20 N.m', 20, 'reading_percent', 4, 4, 'mm');

  INSERT INTO public.gauge_types (organisation_id, name, code) VALUES (org, 'Fixed point, span tolerance', 'MIX') RETURNING id INTO t_mix;
  INSERT INTO public.gauge_type_characteristics (organisation_id, gauge_type_id, sort_order, name, nominal, tolerance_basis, tolerance_minus, tolerance_plus, unit_code)
    VALUES (org, t_mix, 1, '25 mm +-1 % of span', 25, 'span_percent', 1, 1, 'mm');

  -- ---- The shape of a check is held by the table ----
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.gauge_type_characteristics (organisation_id, gauge_type_id, name, nominal_basis, nominal, tolerance_minus, tolerance_plus) VALUES (%L, %L, 'x', 'span_percent', 101, 1, 1)$q$, org, t),
    'a point cannot be more than 100 % of the range');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.gauge_type_characteristics (organisation_id, gauge_type_id, name, nominal_basis, nominal, tolerance_minus, tolerance_plus) VALUES (%L, %L, 'x', 'span_percent', 12.3456, 1, 1)$q$, org, t),
    'a point percentage has at most three decimals');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.gauge_type_characteristics (organisation_id, gauge_type_id, name, nominal_basis, nominal, tolerance_minus, tolerance_plus, unit_code) VALUES (%L, %L, 'x', 'span_percent', 50, 1, 1, 'mm')$q$, org, t),
    'a point that is a percentage of the range takes the gauge''s unit, not its own');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.gauge_type_characteristics (organisation_id, gauge_type_id, name, nominal, tolerance_basis, tolerance_minus, tolerance_plus, unit_code) VALUES (%L, %L, 'x', 5, 'span_percent', 1, 2, 'mm')$q$, org, t),
    'a percentage tolerance is the same on both sides');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.gauge_type_characteristics (organisation_id, gauge_type_id, name, nominal, tolerance_basis, tolerance_minus, tolerance_plus, unit_code) VALUES (%L, %L, 'x', 5, 'reading_percent', 0, 0, 'mm')$q$, org, t),
    'a percentage tolerance is above zero');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.gauge_type_characteristics (organisation_id, gauge_type_id, name, nominal, tolerance_basis, tolerance_minus, tolerance_plus, unit_code) VALUES (%L, %L, 'x', 5, 'value_plus_reading_percent', 0.1, 0.1, 'mm')$q$, org, t),
    'a fixed part plus a percentage needs the percentage');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.gauge_type_characteristics (organisation_id, gauge_type_id, name, nominal, tolerance_minus, tolerance_plus, unit_code, tolerance_reading_percent) VALUES (%L, %L, 'x', 5, 0.1, 0.1, 'mm', 1)$q$, org, t),
    'a fixed tolerance has no reading percentage');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.gauge_type_characteristics (organisation_id, gauge_type_id, kind, name, tolerance_basis) VALUES (%L, %L, 'attribute', 'x', 'reading_percent')$q$, org, t),
    'a pass/fail check has no basis');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.gauge_type_characteristics (organisation_id, gauge_type_id, name, nominal, tolerance_minus, tolerance_plus, unit_code, tolerance_source) VALUES (%L, %L, 'x', 5, 0.1, 0.1, 'mm', repeat('a', 201))$q$, org, t),
    'the source note is at most 200 characters');

  -- ---- A type that does not use ranges changes nothing ----
  PERFORM pg_temp.login(u_owner);
  INSERT INTO public.gauges (organisation_id, asset_number, description, gauge_type_id, site_id) VALUES (org, 'F-1', 'Caliper', t_fixed, site) RETURNING id INTO g_fixed;
  PERFORM pg_temp.logout();
  ch := pg_temp.chk(g_fixed, '25 mm');
  PERFORM pg_temp.assert_eq((ch.nominal, ch.tolerance_minus, ch.tolerance_plus, ch.unit_code), (25::numeric, 0.02::numeric, 0.03::numeric, 'mm'::text), 'a fixed check is copied exactly as before');
  PERFORM pg_temp.assert_eq((ch.follows_range, ch.derivation IS NULL, ch.tolerance_source IS NULL), (false, true, true), 'and does not follow a range');

  -- ---- A gauge of a type that places checks across the range needs the range and unit ----
  PERFORM pg_temp.login(u_owner);
  r := pg_temp.tries(format($q$INSERT INTO public.gauges (organisation_id, asset_number, description, gauge_type_id, site_id) VALUES (%L, 'R-0', 'No range', %L, %L)$q$, org, t, site));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM006', 'a gauge with no range is refused when its type places checks across the range');
  PERFORM pg_temp.assert_eq(r LIKE '%range%', true, 'and the message names the range');
  r := pg_temp.tries(format($q$INSERT INTO public.gauges (organisation_id, asset_number, description, gauge_type_id, site_id, range_min, range_max) VALUES (%L, 'R-0', 'No unit', %L, %L, 50, 100)$q$, org, t, site));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM006', 'a range with no unit is refused');
  r := pg_temp.tries(format($q$INSERT INTO public.gauges (organisation_id, asset_number, description, gauge_type_id, site_id, range_min, range_max, unit_code) VALUES (%L, 'R-0', 'Backwards', %L, %L, 100, 50, 'mm')$q$, org, t, site));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM006', 'a range whose largest is not above its smallest is refused');
  PERFORM pg_temp.assert_eq(pg_temp.tries(format($q$INSERT INTO public.gauges (organisation_id, asset_number, description, gauge_type_id, site_id) VALUES (%L, 'T-0', 'Torque, no range', %L, %L)$q$, org, t_read, site)), 'ok',
    'a type whose only range-free checks use a percentage of the reading needs no range');
  PERFORM pg_temp.assert_eq((SELECT tolerance_minus FROM public.gauge_characteristics WHERE name = '20 N.m' AND gauge_id = (SELECT id FROM public.gauges WHERE asset_number = 'T-0')), 0.8::numeric,
    '4 % of the reading 20 is 0.8');
  PERFORM pg_temp.assert_eq((SELECT follows_range FROM public.gauge_characteristics WHERE name = '20 N.m' AND gauge_id = (SELECT id FROM public.gauges WHERE asset_number = 'T-0')), false,
    'and a check that does not depend on the range does not follow it');
  PERFORM pg_temp.logout();

  -- ---- The points and tolerances for a 50-100 mm micrometer, 0.01 resolution ----
  PERFORM pg_temp.login(u_owner);
  INSERT INTO public.gauges (organisation_id, asset_number, description, gauge_type_id, site_id, range_min, range_max, unit_code, resolution)
    VALUES (org, 'M-50', 'Micrometer 50-100', t, site, 50, 100, 'mm', 0.01) RETURNING id INTO ga;
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.gauge_characteristics WHERE gauge_id = ga), 7::bigint, 'every check of the type is copied');
  ch := pg_temp.chk(ga, 'Start');
  PERFORM pg_temp.assert_eq((ch.nominal, ch.tolerance_minus, ch.tolerance_plus, ch.unit_code, ch.follows_range, ch.derivation),
    (50::numeric, 0.004::numeric, 0.004::numeric, 'mm'::text, true, '0 % of range'::text), '0 % of 50-100 is the range minimum (50), not 0');
  ch := pg_temp.chk(ga, 'Odd');
  PERFORM pg_temp.assert_eq(ch.nominal, 60.2::numeric, '20.4 % of 50-100 is 60.2');
  ch := pg_temp.chk(ga, 'Third');
  PERFORM pg_temp.assert_eq(ch.nominal, 66.67::numeric, '33.333 % of 50-100 is 66.6665, shown to the gauge''s 0.01 resolution');
  ch := pg_temp.chk(ga, 'Mid');
  PERFORM pg_temp.assert_eq((ch.nominal, ch.tolerance_minus, ch.tolerance_plus, ch.derivation, ch.tolerance_source),
    (75::numeric, 0.5::numeric, 0.5::numeric, '50 % of range; ±1 % of span'::text, 'Maker datasheet'::text),
    '50 % is 75, and ±1 % of the 50 mm span is ±0.5, with the source note kept');
  ch := pg_temp.chk(ga, 'End');
  PERFORM pg_temp.assert_eq((ch.nominal, ch.tolerance_minus, ch.tolerance_plus, ch.derivation),
    (100::numeric, 0.013::numeric, 0.013::numeric, '100 % of range; ±(0.003 mm + 0.01 % of reading)'::text),
    '100 % is 100, and ±(0.003 + 0.01 % of 100) is ±0.013 (49.992 to 50.008 style)');
  ch := pg_temp.chk(ga, 'Fixed 20');
  PERFORM pg_temp.assert_eq((ch.nominal, ch.tolerance_minus, ch.unit_code, ch.follows_range, ch.derivation), (20::numeric, 0.8::numeric, 'mm'::text, false, '±4 % of reading'::text),
    'a fixed point with a percentage-of-reading tolerance is worked out and does not follow the range');
  ch := pg_temp.chk(ga, 'Free from damage');
  PERFORM pg_temp.assert_eq((ch.kind, ch.nominal IS NULL, ch.follows_range, ch.derivation IS NULL), ('attribute'::text, true, false, true), 'a pass/fail check is copied as before');

  -- The 0-25 mm micrometer (no resolution: four decimals) and the "uneven sequence" of micrometer calibration.
  PERFORM pg_temp.login(u_owner);
  INSERT INTO public.gauges (organisation_id, asset_number, description, gauge_type_id, site_id, range_min, range_max, unit_code)
    VALUES (org, 'M-0', 'Micrometer 0-25', t, site, 0, 25, 'mm') RETURNING id INTO gb;
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((pg_temp.chk(gb, 'Start')).nominal, 0::numeric, 'on a 0-25 gauge 0 % is 0');
  PERFORM pg_temp.assert_eq((pg_temp.chk(gb, 'Odd')).nominal, 5.1::numeric, '20.4 % of 25 is 5.1');
  PERFORM pg_temp.assert_eq((pg_temp.chk(gb, 'Third')).nominal, 8.3333::numeric, 'with no resolution the point is rounded to four decimals');
  PERFORM pg_temp.assert_eq((pg_temp.chk(gb, 'Mid')).tolerance_minus, 0.25::numeric, '±1 % of a 25 mm span is ±0.25');
  PERFORM pg_temp.assert_eq((pg_temp.chk(gb, 'End')).tolerance_minus, 0.0055::numeric, '±(0.003 + 0.01 % of 25) is ±0.0055');

  -- A negative range and another unit.
  PERFORM pg_temp.login(u_owner);
  INSERT INTO public.gauges (organisation_id, asset_number, description, gauge_type_id, site_id, range_min, range_max, unit_code)
    VALUES (org, 'M-IN', 'Inch micrometer', t, site, -1, 1, 'in') RETURNING id INTO g_in;
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(((pg_temp.chk(g_in, 'Start')).nominal, (pg_temp.chk(g_in, 'Start')).unit_code), (-1::numeric, 'in'::text), 'a symmetric range starts at its negative end, in the gauge''s unit');
  PERFORM pg_temp.assert_eq((pg_temp.chk(g_in, 'Mid')).nominal, 0::numeric, 'and 50 % is zero');
  PERFORM pg_temp.assert_eq((pg_temp.chk(g_in, 'Mid')).tolerance_minus, 0.02::numeric, '±1 % of a span of 2 is ±0.02');
  PERFORM pg_temp.assert_eq((pg_temp.chk(g_in, 'Fixed 20')).unit_code, 'mm'::text, 'a fixed point keeps its own unit');

  -- ---- A tolerance that works out to nothing is refused, naming the check ----
  PERFORM pg_temp.login(u_owner);
  r := pg_temp.tries(format($q$INSERT INTO public.gauges (organisation_id, asset_number, description, gauge_type_id, site_id, range_min, range_max, unit_code) VALUES (%L, 'Z-0', 'Zero start', %L, %L, 0, 25, 'mm')$q$, org, t_zero, site));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM006', 'a "% of reading" tolerance at a point that is 0 is refused');
  PERFORM pg_temp.assert_eq(r LIKE '%At zero%nothing%', true, 'and names the check');
  PERFORM pg_temp.assert_eq(pg_temp.tries(format($q$INSERT INTO public.gauges (organisation_id, asset_number, description, gauge_type_id, site_id, range_min, range_max, unit_code) VALUES (%L, 'Z-1', 'Offset start', %L, %L, 50, 100, 'mm')$q$, org, t_zero, site)), 'ok',
    'the same check is fine on a range that does not start at 0');
  PERFORM pg_temp.assert_eq((SELECT tolerance_minus FROM public.gauge_characteristics WHERE name = 'At zero'), 0.5::numeric, '1 % of 50 is 0.5');
  -- A fixed point with a span tolerance needs the span in its own unit.
  r := pg_temp.tries(format($q$INSERT INTO public.gauges (organisation_id, asset_number, description, gauge_type_id, site_id, range_min, range_max, unit_code) VALUES (%L, 'X-0', 'Wrong unit', %L, %L, 0, 1, 'in')$q$, org, t_mix, site));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM006', 'a span tolerance on a point in mm is refused for a gauge in inches');
  PERFORM pg_temp.assert_eq(r LIKE '%unit%', true, 'and says the units differ');
  PERFORM pg_temp.assert_eq(pg_temp.tries(format($q$INSERT INTO public.gauges (organisation_id, asset_number, description, gauge_type_id, site_id, range_min, range_max, unit_code) VALUES (%L, 'X-1', 'Same unit', %L, %L, 0, 100, 'mm')$q$, org, t_mix, site)), 'ok',
    'and fine in the same unit');
  PERFORM pg_temp.assert_eq((SELECT tolerance_minus FROM public.gauge_characteristics WHERE name = '25 mm +-1 % of span'), 1::numeric, '±1 % of a 100 mm span is ±1');
  PERFORM pg_temp.logout();
  -- The copy refuses system SQL too: nothing is left half done.
  r := pg_temp.tries(format($q$INSERT INTO public.gauges (organisation_id, asset_number, description, gauge_type_id, site_id) VALUES (%L, 'Z-2', 'No range, system', %L, %L)$q$, org, t, site));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM006', 'a gauge made by system SQL with no range is refused by the copy as well');

  -- ---- Editing a following check by hand makes it an ordinary fixed check; following cannot be forged ----
  PERFORM pg_temp.login(u_owner);
  INSERT INTO public.gauges (organisation_id, asset_number, description, gauge_type_id, site_id, range_min, range_max, unit_code)
    VALUES (org, 'M-EDIT', 'Edited by hand', t, site, 50, 100, 'mm') RETURNING id INTO g_forge;
  PERFORM pg_temp.assert_eq(pg_temp.tries(format($q$UPDATE public.gauge_characteristics SET method = 'Use the ratchet' WHERE gauge_id = %L AND name = 'Mid'$q$, g_forge)), 'ok', 'a note changed on a following check');
  PERFORM pg_temp.assert_eq((pg_temp.chk(g_forge, 'Mid')).follows_range, true, 'does not stop it following the range');
  PERFORM pg_temp.assert_eq(pg_temp.tries(format($q$UPDATE public.gauge_characteristics SET nominal = 75.5 WHERE gauge_id = %L AND name = 'Mid'$q$, g_forge)), 'ok', 'a value changed by hand');
  ch := pg_temp.chk(g_forge, 'Mid');
  PERFORM pg_temp.assert_eq((ch.follows_range, ch.derivation IS NULL, ch.nominal), (false, true, 75.5::numeric), 'turns it into an ordinary fixed check');
  PERFORM pg_temp.assert_eq((pg_temp.chk(g_forge, 'End')).follows_range, true, 'and leaves the other checks following');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.gauge_characteristics SET follows_range = true WHERE gauge_id = %L AND name = 'Mid'$q$, g_forge), 'a person cannot switch following on');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.gauge_characteristics SET derivation = 'invented' WHERE gauge_id = %L AND name = 'End'$q$, g_forge), 'or write a derivation');
  PERFORM pg_temp.assert_eq(pg_temp.tries(format($q$UPDATE public.gauge_characteristics SET tolerance_source = 'ISO 3611' WHERE gauge_id = %L AND name = 'End'$q$, g_forge)), 'ok', 'the source note can be written');
  INSERT INTO public.gauge_characteristics (organisation_id, gauge_id, sort_order, name, nominal, tolerance_minus, tolerance_plus, unit_code, follows_range, derivation)
    VALUES (org, g_forge, 20, 'Own check', 10, 0.1, 0.1, 'mm', true, 'forged');
  ch := pg_temp.chk(g_forge, 'Own check');
  PERFORM pg_temp.assert_eq((ch.follows_range, ch.derivation IS NULL), (false, true), 'a check a person adds cannot claim to follow a range');
  PERFORM pg_temp.logout();

  -- ---- A reading keeps the limits, where they came from and how they were worked out ----
  PERFORM pg_temp.login(u_owner);
  INSERT INTO public.gauges (organisation_id, asset_number, description, gauge_type_id, site_id, range_min, range_max, unit_code)
    VALUES (org, 'M-CAL', 'Calibrated', t, site, 50, 100, 'mm') RETURNING id INTO gc;
  INSERT INTO public.calibrations (organisation_id, gauge_id, reference, calibrated_on, outcome) VALUES (org, gc, 'x', current_date, 'pass') RETURNING id INTO cal;
  INSERT INTO public.calibration_readings (organisation_id, calibration_id, characteristic_id, name, nominal, tolerance_minus, tolerance_plus, unit_code, as_found, derivation, tolerance_source)
    SELECT org, cal, k.id, 'x', 0, 0, 0, 'mm', 75, 'forged', 'forged' FROM public.gauge_characteristics k WHERE k.gauge_id = gc AND k.name = 'Mid'
    RETURNING id INTO rd;
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT (nominal, tolerance_minus, derivation, tolerance_source) FROM public.calibration_readings WHERE id = rd),
    (75::numeric, 0.5::numeric, '50 % of range; ±1 % of span'::text, 'Maker datasheet'::text), 'a reading takes the limits, derivation and source from its characteristic (what the person sent is ignored)');
  PERFORM pg_temp.login(u_owner);
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.calibration_readings SET derivation = 'changed' WHERE id = %L$q$, rd), 'a reading''s derivation cannot be changed');
  PERFORM pg_temp.logout();

  -- ---- The range changes later: the checks do not move until someone recalculates ----
  PERFORM pg_temp.login(u_owner);
  UPDATE public.gauges SET range_max = 150 WHERE id = gc;
  PERFORM pg_temp.assert_eq((pg_temp.chk(gc, 'Mid')).nominal, 75::numeric, 'changing the range does not change the checks by itself');
  SELECT count(*) INTO n FROM app.gauge_range_check_state(gc) WHERE stale;
  PERFORM pg_temp.assert_eq(n, 4, 'the checks the new range would change are reported stale (Odd, Mid, Third, End; Start is still 50)');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.gauge_range_check_state(gc)), 5::bigint, 'and only the checks that follow the range are listed');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_insp);
  r := pg_temp.tries(format('SELECT app.recalculate_gauge_range_checks(%L)', gc));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'someone who may not manage calibration cannot recalculate');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_stranger);
  r := pg_temp.tries(format('SELECT app.recalculate_gauge_range_checks(%L)', gc));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'and a stranger finds no such gauge');
  PERFORM pg_temp.logout();
  UPDATE public.gauge_type_characteristics SET tolerance_source = 'ISO 3611, 2010' WHERE id = k_mid;
  PERFORM pg_temp.login(u_owner);
  j := app.recalculate_gauge_range_checks(gc);
  PERFORM pg_temp.assert_eq(((j ->> 'updated')::int, (j ->> 'unchanged')::int, jsonb_array_length(j -> 'problems')), (4, 1, 0), 'recalculating refreshes the four that changed and leaves Start alone');
  ch := pg_temp.chk(gc, 'Mid');
  PERFORM pg_temp.assert_eq((ch.nominal, ch.tolerance_minus, ch.tolerance_source), (100::numeric, 1::numeric, 'ISO 3611, 2010'::text), '50 % of 50-150 is 100, ±1 % of a 100 span is ±1, and the source is the type''s current one');
  PERFORM pg_temp.assert_eq((pg_temp.chk(gc, 'End')).tolerance_minus, 0.018::numeric, '±(0.003 + 0.01 % of 150) is ±0.018');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.gauge_range_check_state(gc) WHERE stale), 0::bigint, 'nothing is stale afterwards');
  PERFORM pg_temp.assert_eq((SELECT (nominal, tolerance_minus, tolerance_source) FROM public.calibration_readings WHERE id = rd),
    (75::numeric, 0.5::numeric, 'Maker datasheet'::text), 'the recorded reading keeps the limits and source it was recorded with');
  j := app.recalculate_gauge_range_checks(gc);
  PERFORM pg_temp.assert_eq(((j ->> 'updated')::int, (j ->> 'unchanged')::int), (0, 5), 'recalculating again changes nothing');
  -- Remove the range: nothing is changed and the problem is named.
  UPDATE public.gauges SET range_min = NULL WHERE id = gc;
  j := app.recalculate_gauge_range_checks(gc);
  PERFORM pg_temp.assert_eq(((j ->> 'updated')::int, jsonb_array_length(j -> 'problems')), (0, 5), 'a gauge whose range was removed is left as it is and the checks are named');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.gauge_range_check_state(gc) WHERE problem IS NOT NULL), 5::bigint, 'and the state says so');
  PERFORM pg_temp.logout();

  -- ---- Apply the checks to the gauges that lack them ----
  PERFORM pg_temp.login(u_owner);
  INSERT INTO public.gauge_types (organisation_id, name, code) VALUES (org, 'Late type', 'LAT') RETURNING id INTO t_ap;
  INSERT INTO public.gauge_type_characteristics (organisation_id, gauge_type_id, sort_order, name, nominal, tolerance_minus, tolerance_plus, unit_code)
    VALUES (org, t_ap, 1, 'Fixed', 25, 0.02, 0.02, 'mm');
  INSERT INTO public.gauges (organisation_id, asset_number, description, gauge_type_id, site_id, range_min, range_max, unit_code)
    VALUES (org, 'AP-1', 'Has a range', t_ap, site, 0, 25, 'mm') RETURNING id INTO g_ap1;
  INSERT INTO public.gauges (organisation_id, asset_number, description, gauge_type_id, site_id) VALUES (org, 'AP-2', 'No range', t_ap, site) RETURNING id INTO g_ap2;
  PERFORM pg_temp.logout();
  INSERT INTO public.gauge_type_characteristics (organisation_id, gauge_type_id, sort_order, name, nominal_basis, nominal, tolerance_minus, tolerance_plus, unit_code)
    VALUES (org, t_ap, 2, 'Half', 'span_percent', 50, 0.01, 0.01, NULL);
  PERFORM pg_temp.login(u_insp);
  j := app.apply_type_checks(t_ap);
  PERFORM pg_temp.assert_eq(((j ->> 'gaugesUpdated')::int, (j ->> 'gaugesSkipped')::int), (0, 2), 'someone who may not manage calibration changes nothing and the gauges are counted as skipped');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_stranger);
  r := pg_temp.tries(format('SELECT app.apply_type_checks(%L)', t_ap));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'a stranger finds no such type');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_owner);
  j := app.apply_type_checks(t_ap);
  PERFORM pg_temp.assert_eq(((j ->> 'gaugesUpdated')::int, (j ->> 'checksAdded')::int, (j ->> 'gaugesWithProblems')::int, (j ->> 'gaugesSkipped')::int), (1, 1, 1, 0),
    'the gauge with a range gets the new check, the one without is reported and left');
  PERFORM pg_temp.assert_eq((j -> 'problems' -> 0 ->> 'assetNumber', (j -> 'problems' -> 0 ->> 'problem') LIKE '%range%'), ('AP-2'::text, true), 'naming the gauge and the reason');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((pg_temp.chk(g_ap1, 'Half')).nominal, 12.5::numeric, 'the applied check is worked out for that gauge''s range');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.gauge_characteristics WHERE gauge_id = g_ap2), 1::bigint, 'the gauge with no range still has only the check it had');
  PERFORM pg_temp.login(u_owner);
  j := app.apply_type_checks(t_ap);
  PERFORM pg_temp.assert_eq(((j ->> 'gaugesUpdated')::int, (j ->> 'checksAdded')::int), (0, 0), 'applying again adds nothing');
  -- Once it has a range the gauge takes the check on the next apply.
  UPDATE public.gauges SET range_min = 0, range_max = 10, unit_code = 'mm' WHERE id = g_ap2;
  j := app.apply_type_checks(t_ap);
  PERFORM pg_temp.assert_eq(((j ->> 'gaugesUpdated')::int, (j ->> 'gaugesWithProblems')::int), (1, 0), 'and once it has a range the gauge is given the check');
  PERFORM pg_temp.assert_eq((pg_temp.chk(g_ap2, 'Half')).nominal, 5::numeric, 'at 50 % of its own range');
  PERFORM pg_temp.logout();

  -- ---- Preview, and retyping ----
  PERFORM pg_temp.login(u_owner);
  j := app.preview_type_checks(t, 50, 100, 'mm', 0.01);
  PERFORM pg_temp.assert_eq(((j ->> 'needsRange')::boolean, (j ->> 'hasRange')::boolean, jsonb_array_length(j -> 'checks')), (true, true, 7), 'the preview lists every active check and knows the type needs a range');
  PERFORM pg_temp.assert_eq((j -> 'checks' -> 0 ->> 'name', (j -> 'checks' -> 0 ->> 'nominal')::numeric), ('Start'::text, 50::numeric), 'worked out for the range given');
  j := app.preview_type_checks(t, NULL, NULL, NULL, NULL);
  PERFORM pg_temp.assert_eq(((j ->> 'hasRange')::boolean, (j -> 'checks' -> 0 ->> 'problem') IS NOT NULL), (false, true), 'with no range the checks that need one say so');
  j := app.preview_type_checks(t_fixed, NULL, NULL, NULL, NULL);
  PERFORM pg_temp.assert_eq(((j ->> 'needsRange')::boolean, (j -> 'checks' -> 0 ->> 'problem') IS NULL), (false, true), 'a fixed type needs no range');
  r := pg_temp.tries(format($q$UPDATE public.gauges SET gauge_type_id = %L WHERE id = %L$q$, t, g_fixed));
  PERFORM pg_temp.assert_eq((left(r, 5), r LIKE '%across the gauge''s range%'), ('QM006'::text, true), 'retyping a gauge with no range to a type that needs one is refused, saying why');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_stranger);
  r := pg_temp.tries(format('SELECT app.preview_type_checks(%L, 0, 1, ''mm'', NULL)', t));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'a stranger cannot preview another organisation''s type');
  PERFORM pg_temp.logout();

  -- ---- The new functions are not open to everyone ----
  PERFORM pg_temp.login(u_owner);
  r := pg_temp.tries(format('SELECT app.resolve_type_check(%L, 0, 25, ''mm'', NULL)', k_mid));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'the arithmetic is internal: a signed-in person cannot call it directly');
  r := pg_temp.tries(format('SELECT app.copy_type_checks_to_gauge(%L, false, false)', ga));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'nor can they copy checks onto a gauge outside the checks above');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
