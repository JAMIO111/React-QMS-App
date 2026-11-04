-- Calibration demo data (not a migration). Run in the Supabase SQL editor after the calibration
-- migrations (20251106100000, 20251107100000). Adds to ONE organisation:
--   * a calibration supplier "Precision Calibration Services" (code PCAL) if missing,
--   * 7 gauge types with measured and pass/fail template characteristics,
--   * 22 gauges (asset numbers G-1001 … G-1022) with 1–4 calibrations each — a mix of passes,
--     adjustments and failures, overdue / due soon / in date, quarantined, in calibration,
--     out of service, retired and lost — so the dashboard and register have something to show.
-- Safe to re-run: it stops if G-1001 already exists in the organisation.
--
-- Which organisation: put its name below. Left empty, the script uses the only organisation if
-- there is exactly one, and otherwise stops and lists the names.
DO $$
DECLARE
  v_org_name text := '';  -- e.g. 'Alpha Precision'
  v_org uuid;
  v_site uuid;
  v_owner uuid;
  v_supplier uuid;
  v_type uuid;
  v_gauge uuid;
  v_cal uuid;
  v_names text;
  t record;
  g record;
  k record;
  i integer;
  v_date date;
  v_interval_days integer;
  v_last boolean;
  v_scenario text;
  v_digits integer;
  v_value numeric;
  v_first_var uuid;
  v_first_attr uuid;
BEGIN
  -- Judge each statement as it runs (gauge dates and status follow each calibration).
  SET CONSTRAINTS ALL IMMEDIATE;
  PERFORM setseed(0.42);

  -- ---- organisation ----------------------------------------------------------------------
  IF coalesce(trim(v_org_name), '') <> '' THEN
    SELECT id INTO v_org FROM public.organisations WHERE lower(name) = lower(trim(v_org_name));
  ELSIF (SELECT count(*) FROM public.organisations) = 1 THEN
    SELECT id INTO v_org FROM public.organisations;
  END IF;
  IF v_org IS NULL THEN
    SELECT string_agg(format('"%s"', name), ', ' ORDER BY name) INTO v_names FROM public.organisations;
    RAISE EXCEPTION 'Set v_org_name at the top of this script to one of: %', v_names;
  END IF;
  IF EXISTS (SELECT 1 FROM public.gauges WHERE organisation_id = v_org AND upper(asset_number) = 'G-1001') THEN
    RAISE NOTICE 'Demo gauges already exist in this organisation (G-1001); nothing added.';
    RETURN;
  END IF;

  SELECT id INTO v_site FROM public.sites WHERE organisation_id = v_org AND active ORDER BY created_at LIMIT 1;
  -- Records are attributed to an Owner of the organisation.
  SELECT m.user_id INTO v_owner
  FROM public.organisation_users m
  JOIN public.user_role_assignments a ON a.membership_id = m.id
  JOIN public.roles r ON r.id = a.role_id AND r.key = 'owner'
  WHERE m.organisation_id = v_org AND m.status = 'active' AND m.user_id IS NOT NULL
  ORDER BY m.created_at LIMIT 1;

  INSERT INTO public.suppliers (organisation_id, code, name, notes, created_by)
  VALUES (v_org, 'PCAL', 'Precision Calibration Services Ltd', 'UKAS-accredited calibration laboratory (demo data)', v_owner)
  ON CONFLICT (organisation_id, code) DO NOTHING;
  SELECT id INTO v_supplier FROM public.suppliers WHERE organisation_id = v_org AND code = 'PCAL';

  -- ---- gauge types and template characteristics -----------------------------------------
  -- characteristics: name | kind | nominal | tol- | tol+ | unit | method
  FOR t IN
    SELECT * FROM (VALUES
      ('Digital caliper 0–150 mm', 'Digital and vernier calipers up to 150 mm', 6, 'months', jsonb_build_array(
        jsonb_build_array('25 mm gauge block (outside jaws)', 'variable', 25, 0.02, 0.02, 'mm', 'Grade 1 gauge block, 3 positions along the jaw'),
        jsonb_build_array('100 mm gauge block (outside jaws)', 'variable', 100, 0.03, 0.03, 'mm', null),
        jsonb_build_array('50 mm setting ring (inside jaws)', 'variable', 50, 0.03, 0.03, 'mm', null),
        jsonb_build_array('Depth rod at 50 mm', 'variable', 50, 0.03, 0.03, 'mm', null),
        jsonb_build_array('Free from damage, jaws not worn', 'attribute', null, null, null, null, 'Visual; no light gap when closed'))),
      ('Outside micrometer 0–25 mm', 'Outside micrometers, 0.001 mm resolution', 12, 'months', jsonb_build_array(
        jsonb_build_array('Zero setting', 'variable', 0, 0.002, 0.002, 'mm', null),
        jsonb_build_array('12.5 mm gauge block', 'variable', 12.5, 0.002, 0.002, 'mm', null),
        jsonb_build_array('25 mm gauge block', 'variable', 25, 0.002, 0.002, 'mm', null),
        jsonb_build_array('Ratchet / friction thimble operates smoothly', 'attribute', null, null, null, null, null),
        jsonb_build_array('Free from damage', 'attribute', null, null, null, null, null))),
      ('Plug gauge GO / NO-GO Ø12 H7', 'Double-ended plain plug gauges', 12, 'months', jsonb_build_array(
        jsonb_build_array('GO member diameter', 'variable', 12.002, 0.002, 0.002, 'mm', 'Measured on bench comparator'),
        jsonb_build_array('NO-GO member diameter', 'variable', 12.018, 0.002, 0.002, 'mm', null),
        jsonb_build_array('No wear marks or burrs', 'attribute', null, null, null, null, null))),
      ('Torque wrench 20–100 N·m', 'Click-type torque wrenches (ISO 6789, ±4%)', 12, 'months', jsonb_build_array(
        jsonb_build_array('20 N·m', 'variable', 20, 0.8, 0.8, 'N·m', 'Torque analyser, 5 clicks averaged'),
        jsonb_build_array('60 N·m', 'variable', 60, 2.4, 2.4, 'N·m', null),
        jsonb_build_array('100 N·m', 'variable', 100, 4, 4, 'N·m', null),
        jsonb_build_array('Valid calibration certificate received', 'attribute', null, null, null, null, null),
        jsonb_build_array('Free from damage', 'attribute', null, null, null, null, null))),
      ('Pressure gauge 0–10 bar', 'Bourdon tube pressure gauges, class 1.0', 12, 'months', jsonb_build_array(
        jsonb_build_array('2 bar', 'variable', 2, 0.1, 0.1, 'bar', 'Dead-weight tester'),
        jsonb_build_array('5 bar', 'variable', 5, 0.1, 0.1, 'bar', null),
        jsonb_build_array('8 bar', 'variable', 8, 0.1, 0.1, 'bar', null),
        jsonb_build_array('Needle returns to zero', 'attribute', null, null, null, null, null))),
      ('Height gauge 0–300 mm', 'Digital height gauges', 12, 'months', jsonb_build_array(
        jsonb_build_array('50 mm gauge block', 'variable', 50, 0.03, 0.03, 'mm', 'On grade 0 surface plate'),
        jsonb_build_array('150 mm gauge block', 'variable', 150, 0.04, 0.04, 'mm', null),
        jsonb_build_array('300 mm gauge block', 'variable', 300, 0.05, 0.05, 'mm', null),
        jsonb_build_array('Free from damage, scriber sharp', 'attribute', null, null, null, null, null))),
      ('Dial indicator 0–10 mm', 'Plunger dial indicators, 0.01 mm', 6, 'months', jsonb_build_array(
        jsonb_build_array('1 mm travel', 'variable', 1, 0.01, 0.01, 'mm', 'Indicator calibrator'),
        jsonb_build_array('5 mm travel', 'variable', 5, 0.01, 0.01, 'mm', null),
        jsonb_build_array('10 mm travel', 'variable', 10, 0.015, 0.015, 'mm', null),
        jsonb_build_array('Smooth travel, no sticking', 'attribute', null, null, null, null, null)))
    ) AS v(name, description, interval_value, interval_unit, chars)
  LOOP
    INSERT INTO public.gauge_types (organisation_id, name, description, interval_value, interval_unit, created_by)
    VALUES (v_org, t.name, t.description, t.interval_value, t.interval_unit, v_owner)
    ON CONFLICT DO NOTHING;
    SELECT id INTO v_type FROM public.gauge_types WHERE organisation_id = v_org AND upper(name) = upper(t.name);
    IF NOT EXISTS (SELECT 1 FROM public.gauge_type_characteristics WHERE gauge_type_id = v_type) THEN
      FOR i IN 0 .. jsonb_array_length(t.chars) - 1 LOOP
        INSERT INTO public.gauge_type_characteristics (organisation_id, gauge_type_id, sort_order, name, kind, nominal, tolerance_minus, tolerance_plus, unit_code, method, created_by)
        VALUES (v_org, v_type, i + 1, t.chars -> i ->> 0, t.chars -> i ->> 1, (t.chars -> i ->> 2)::numeric, (t.chars -> i ->> 3)::numeric,
                (t.chars -> i ->> 4)::numeric, t.chars -> i ->> 5, t.chars -> i ->> 6, v_owner);
      END LOOP;
    END IF;
  END LOOP;

  -- ---- gauges and their calibration history ----------------------------------------------
  -- days_ago: days since the latest calibration (with the type's interval this sets the due
  -- state); history: number of calibrations; latest: pass | adjusted | fail | fail_check;
  -- status: set afterwards (null = follows the calibrations).
  FOR g IN
    SELECT * FROM (VALUES
      ('G-1001', 'Digital caliper 0–150 mm', 'Mitutoyo', 'CD-15APX', 'QA lab, cabinet 1', 'internal', 40, 4, 'pass', null),
      ('G-1002', 'Digital caliper 0–150 mm', 'Mitutoyo', 'CD-15APX', 'Cell 1 — CNC turning', 'internal', 175, 3, 'pass', null),
      ('G-1003', 'Digital caliper 0–150 mm', 'Sylvac', 'S_Cal EVO', 'Cell 2 — milling', 'internal', 200, 3, 'pass', null),
      ('G-1004', 'Digital caliper 0–150 mm', 'Mitutoyo', 'CD-15APX', 'Goods in', 'internal', 12, 2, 'adjusted', null),
      ('G-1005', 'Outside micrometer 0–25 mm', 'Mitutoyo', '293-240-30', 'QA lab, cabinet 2', 'internal', 90, 3, 'pass', null),
      ('G-1006', 'Outside micrometer 0–25 mm', 'Moore & Wright', 'MW200-01DDL', 'Cell 1 — CNC turning', 'internal', 350, 2, 'pass', null),
      ('G-1007', 'Outside micrometer 0–25 mm', 'Mitutoyo', '293-240-30', 'Cell 3 — grinding', 'internal', 5, 3, 'fail', null),
      ('G-1008', 'Plug gauge GO / NO-GO Ø12 H7', 'Bowers', 'PG12H7', 'Cell 2 — milling', 'external', 300, 2, 'pass', null),
      ('G-1009', 'Plug gauge GO / NO-GO Ø12 H7', 'Bowers', 'PG12H7', 'Cell 3 — grinding', 'external', 380, 2, 'pass', null),
      ('G-1010', 'Torque wrench 20–100 N·m', 'Norbar', 'TTi 100', 'Assembly bench A', 'external', 120, 3, 'pass', null),
      ('G-1011', 'Torque wrench 20–100 N·m', 'Norbar', 'TTi 100', 'Assembly bench B', 'external', 20, 2, 'fail_check', null),
      ('G-1012', 'Torque wrench 20–100 N·m', 'Gedore', 'Dremaster 20–100', 'Maintenance', 'external', 340, 2, 'adjusted', null),
      ('G-1013', 'Pressure gauge 0–10 bar', 'WIKA', '213.53', 'Hydro test rig', 'external', 60, 3, 'pass', null),
      ('G-1014', 'Pressure gauge 0–10 bar', 'WIKA', '213.53', 'Compressor room', 'external', 395, 2, 'pass', null),
      ('G-1015', 'Height gauge 0–300 mm', 'Mitutoyo', 'QM-Height 300', 'CMM room', 'internal', 150, 3, 'pass', null),
      ('G-1016', 'Dial indicator 0–10 mm', 'Mitutoyo', '2046AB', 'Cell 1 — CNC turning', 'internal', 30, 4, 'pass', null),
      ('G-1017', 'Dial indicator 0–10 mm', 'Baty', 'DI-10', 'Cell 2 — milling', 'internal', 160, 3, 'adjusted', null),
      ('G-1018', 'Dial indicator 0–10 mm', 'Mitutoyo', '2046AB', 'With calibration lab', 'internal', 185, 2, 'pass', 'in_calibration'),
      ('G-1019', 'Height gauge 0–300 mm', 'Trimos', 'V3', 'Inspection room', 'internal', 100, 2, 'pass', 'out_of_service'),
      ('G-1020', 'Digital caliper 0–150 mm', 'Draper', 'DVC150', 'Stores', 'internal', 600, 2, 'pass', 'retired'),
      ('G-1021', 'Outside micrometer 0–25 mm', 'Mitutoyo', '293-240-30', 'Unknown', 'internal', 420, 1, 'pass', 'lost'),
      ('G-1022', 'Pressure gauge 0–10 bar', 'WIKA', '213.53', 'Paint line', 'external', 190, 1, 'pass', null)
    ) AS v(asset, type_name, manufacturer, model, location, source, days_ago, history, latest, status)
  LOOP
    SELECT id, interval_value, interval_unit INTO t FROM public.gauge_types WHERE organisation_id = v_org AND upper(name) = upper(g.type_name);
    v_interval_days := CASE t.interval_unit WHEN 'months' THEN round(t.interval_value * 30.44) WHEN 'years' THEN t.interval_value * 365
                                            WHEN 'weeks' THEN t.interval_value * 7 ELSE t.interval_value END;
    INSERT INTO public.gauges (organisation_id, asset_number, description, gauge_type_id, manufacturer, model, serial_number, site_id, location,
                               custodian_id, calibration_source, supplier_id, commissioned_on, notes, created_by)
    VALUES (v_org, g.asset, g.type_name, t.id, g.manufacturer, g.model, upper(substr(md5(g.asset), 1, 8)), v_site, g.location, v_owner,
            g.source, CASE WHEN g.source = 'external' THEN v_supplier END,
            current_date - (g.days_ago + g.history * v_interval_days + 30), 'Demo data', v_owner)
    RETURNING id INTO v_gauge;
    SELECT id INTO v_first_var FROM public.gauge_characteristics WHERE gauge_id = v_gauge AND kind = 'variable' ORDER BY sort_order LIMIT 1;
    SELECT id INTO v_first_attr FROM public.gauge_characteristics WHERE gauge_id = v_gauge AND kind = 'attribute' ORDER BY sort_order LIMIT 1;

    -- Oldest first; the last one is the latest calibration.
    FOR i IN REVERSE g.history - 1 .. 0 LOOP
      v_date := current_date - (g.days_ago + i * v_interval_days + (random() * 6)::int);
      IF i = 0 THEN v_date := current_date - g.days_ago; END IF;
      v_last := i = 0;
      -- Older calibrations are mostly passes, with the occasional adjustment.
      v_scenario := CASE WHEN v_last THEN g.latest WHEN random() < 0.15 THEN 'adjusted' ELSE 'pass' END;
      INSERT INTO public.calibrations (organisation_id, gauge_id, reference, calibrated_on, performed_by, technician_id, supplier_id,
                                       certificate_number, procedure_ref, reference_standards, temperature_c, humidity_pct, outcome, notes, created_at, created_by)
      VALUES (v_org, v_gauge,
              'CAL-' || to_char(v_date, 'YY') || '-D' || lpad((SELECT count(*) + 1 FROM public.calibrations WHERE organisation_id = v_org AND reference LIKE 'CAL-' || to_char(v_date, 'YY') || '-D%')::text, 3, '0'),
              v_date, g.source, CASE WHEN g.source = 'internal' THEN v_owner END, CASE WHEN g.source = 'external' THEN v_supplier END,
              CASE WHEN g.source = 'external' THEN 'PCS-' || to_char(v_date, 'YYMM') || '-' || lpad((random() * 9999)::int::text, 4, '0') END,
              'WI-CAL-' || lpad((1 + (SELECT count(*) FROM public.gauge_types gt WHERE gt.organisation_id = v_org AND gt.name < g.type_name))::text, 3, '0'),
              CASE WHEN g.type_name LIKE 'Torque%' THEN 'Norbar TTT torque analyser (cert N-5521)'
                   WHEN g.type_name LIKE 'Pressure%' THEN 'Budenberg dead-weight tester (cert B-1180)'
                   WHEN g.type_name LIKE 'Dial%' THEN 'Mitutoyo indicator calibrator 170-102 (cert M-2290)'
                   ELSE 'Grade 1 gauge block set GB-01 (cert 8812)' END,
              round((19.5 + random())::numeric, 1), round((40 + random() * 15)::numeric, 0), 'pass',
              CASE v_scenario WHEN 'adjusted' THEN 'Adjusted and re-checked.' WHEN 'fail' THEN 'Out of tolerance; removed from use.'
                              WHEN 'fail_check' THEN 'Damage found on inspection.' END,
              v_date + time '10:00', v_owner)
      RETURNING id INTO v_cal;

      FOR k IN SELECT * FROM public.gauge_characteristics WHERE gauge_id = v_gauge AND active ORDER BY sort_order LOOP
        IF k.kind = 'attribute' THEN
          INSERT INTO public.calibration_readings (organisation_id, calibration_id, characteristic_id, as_found_pass, as_left_pass, created_by)
          VALUES (v_org, v_cal, k.id, NOT (v_scenario = 'fail_check' AND k.id = v_first_attr), NULL, v_owner);
        ELSE
          v_digits := CASE WHEN k.tolerance_plus >= 0.5 THEN 1 WHEN k.tolerance_plus >= 0.05 THEN 2 WHEN k.tolerance_plus >= 0.005 THEN 3 ELSE 4 END;
          -- In tolerance: within 70% of the band.
          v_value := round(k.nominal + (random() * 1.4 - 0.7)::numeric * k.tolerance_plus, v_digits);
          IF k.id = v_first_var AND v_scenario IN ('fail', 'adjusted') THEN
            v_value := round(k.nominal + k.tolerance_plus * 1.6, v_digits);
          END IF;
          INSERT INTO public.calibration_readings (organisation_id, calibration_id, characteristic_id, as_found, as_left, created_by)
          VALUES (v_org, v_cal, k.id, v_value,
                  CASE WHEN k.id = v_first_var AND v_scenario = 'adjusted' THEN round(k.nominal + k.tolerance_plus * 0.2, v_digits) END, v_owner);
        END IF;
      END LOOP;
    END LOOP;

    IF g.status IS NOT NULL THEN
      UPDATE public.gauges
      SET status = g.status,
          status_reason = CASE g.status WHEN 'in_calibration' THEN 'Sent to Precision Calibration Services'
                                        WHEN 'out_of_service' THEN 'Damaged scriber; awaiting repair'
                                        WHEN 'retired' THEN 'Replaced by G-1004'
                                        WHEN 'lost' THEN 'Not found at stock check' END
      WHERE id = v_gauge;
    END IF;
  END LOOP;

  -- A gauge without a type: calibrated externally, recorded with the certificate only.
  INSERT INTO public.gauges (organisation_id, asset_number, description, manufacturer, model, site_id, location, custodian_id, calibration_source,
                             supplier_id, interval_value, interval_unit, notes, created_by)
  VALUES (v_org, 'G-1023', 'Granite surface plate 1000 × 630 mm, grade 0', 'Eley', 'GP-1006', v_site, 'CMM room', v_owner, 'external', v_supplier,
          2, 'years', 'Demo data', v_owner)
  RETURNING id INTO v_gauge;
  INSERT INTO public.calibrations (organisation_id, gauge_id, reference, calibrated_on, performed_by, supplier_id, certificate_number, outcome, notes, created_by)
  VALUES (v_org, v_gauge, 'CAL-' || to_char(current_date - 250, 'YY') || '-D900', current_date - 250, 'external', v_supplier, 'PCS-SP-0412', 'pass',
          'Flatness within grade 0 (certificate only).', v_owner);

  RAISE NOTICE 'Added % gauges, % calibrations and % gauge types to the organisation.',
    (SELECT count(*) FROM public.gauges WHERE organisation_id = v_org AND notes = 'Demo data'),
    (SELECT count(*) FROM public.calibrations c JOIN public.gauges gg ON gg.id = c.gauge_id WHERE gg.organisation_id = v_org AND gg.notes = 'Demo data'),
    (SELECT count(*) FROM public.gauge_types WHERE organisation_id = v_org);
END $$;
