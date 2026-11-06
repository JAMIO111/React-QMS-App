-- SPC demo data (not a migration). Run in the Supabase SQL editor after the PC6 migration
-- (20251108170000_spc.sql). Adds to ONE organisation:
--   * a part family "DEMO" with parts DEMO-100 and DEMO-200, two machines,
--   * an effective control plan CP-DEMO-001 (OP-020) with three SPC characteristics:
--       OD    25.000 ± 0.050 mm  I-MR     (in control, one spike, tool-wear drift, then a tool change)
--       BORE  10.000 ± 0.100 mm  X-bar/R  (subgroups of 5: a wide-range patch, then a small step shift)
--       RA     0.8 (0.2–1.6) µm  I-MR     (stable, slow cycle)
--   * 12 inspections of DEMO-100 (120 samples: 120 individuals, 24 subgroups) over the last ~5 weeks,
--     the newest still in progress, and 5 of DEMO-200 (a short run: provisional / trial limits).
-- Every reading is inside specification, so nothing needs an NC: the charts show a process that is
-- "in spec but not in control" — the point of SPC. Samples, readings and inspections are back-dated
-- afterwards so the time axis is meaningful (this step needs session_replication_role; if the
-- editor refuses it the data is still complete, just all stamped "now").
-- Safe to re-run: it stops if DEMO-100 already exists in the organisation.
--
-- Which organisation: put its name below. Left empty, the script uses the only organisation if
-- there is exactly one, and otherwise stops and lists the names.
DO $$
DECLARE
  v_org_name text := '';  -- e.g. 'Alpha Precision'
  v_org uuid; v_site uuid; v_owner uuid; v_names text;
  v_fam uuid; v_part uuid; v_plan uuid; v_rev uuid; v_op uuid;
  v_m1 uuid; v_m2 uuid; v_rec uuid; v_s uuid;
  v_od uuid; v_bore uuid; v_ra uuid;
  v_times jsonb := '[]'::jsonb;
  p record; k integer; s integer; g integer; v_ts timestamptz; v_incomplete boolean;
  v_od_val numeric; v_bore_val numeric; v_ra_val numeric; v_noise numeric;
  v_now timestamptz := now();
  -- Standard normal noise (Box–Muller) from two uniform draws.
  n1 numeric; n2 numeric;
BEGIN
  PERFORM setseed(0.37);

  IF coalesce(trim(v_org_name), '') <> '' THEN
    SELECT id INTO v_org FROM public.organisations WHERE lower(name) = lower(trim(v_org_name));
  ELSIF (SELECT count(*) FROM public.organisations) = 1 THEN
    SELECT id INTO v_org FROM public.organisations;
  END IF;
  IF v_org IS NULL THEN
    SELECT string_agg(format('"%s"', name), ', ' ORDER BY name) INTO v_names FROM public.organisations;
    RAISE EXCEPTION 'Set v_org_name at the top of this script to one of: %', v_names;
  END IF;
  IF EXISTS (SELECT 1 FROM public.parts WHERE organisation_id = v_org AND upper(part_number) = 'DEMO-100') THEN
    RAISE EXCEPTION 'DEMO-100 already exists in this organisation; nothing was added.';
  END IF;
  SELECT id INTO v_site FROM public.sites WHERE organisation_id = v_org ORDER BY created_at LIMIT 1;
  SELECT ou.user_id INTO v_owner FROM public.organisation_users ou
    JOIN public.user_role_assignments a ON a.membership_id = ou.id
    JOIN public.roles r ON r.id = a.role_id AND r.key = 'owner'
    WHERE ou.organisation_id = v_org AND ou.status = 'active' ORDER BY ou.created_at LIMIT 1;
  IF v_site IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'The organisation needs a site and an active owner.'; END IF;

  -- Act as the owner, with the normal rules (RLS, triggers, audit) in force.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SET CONSTRAINTS ALL IMMEDIATE;

  INSERT INTO public.part_families (organisation_id, code, name, description) VALUES (v_org, 'DEMO', 'Demo rods', 'SPC demo data') RETURNING id INTO v_fam;
  INSERT INTO public.machines (organisation_id, code, name, work_centre) VALUES (v_org, 'DEMO-LATHE-1', 'Demo CNC lathe 1', 'Turning') RETURNING id INTO v_m1;
  INSERT INTO public.machines (organisation_id, code, name, work_centre) VALUES (v_org, 'DEMO-LATHE-2', 'Demo CNC lathe 2', 'Turning') RETURNING id INTO v_m2;
  INSERT INTO public.parts (organisation_id, part_number, name, part_family_id)
    SELECT v_org, pn, nm, v_fam FROM (VALUES ('DEMO-100', 'Demo rod 100'), ('DEMO-200', 'Demo rod 200')) x(pn, nm);
  INSERT INTO public.part_revisions (organisation_id, part_id, revision) SELECT v_org, id, 'A' FROM public.parts WHERE organisation_id = v_org AND part_number LIKE 'DEMO-%';
  UPDATE public.part_revisions SET status = 'released' WHERE organisation_id = v_org AND part_id IN (SELECT id FROM public.parts WHERE part_number LIKE 'DEMO-%' AND organisation_id = v_org);

  INSERT INTO public.control_plans (organisation_id, plan_code, title) VALUES (v_org, 'CP-DEMO-001', 'Demo rods – turning') RETURNING id INTO v_plan;
  INSERT INTO public.control_plan_applicability (organisation_id, control_plan_id, part_family_id) VALUES (v_org, v_plan, v_fam);
  INSERT INTO public.control_plan_revisions (organisation_id, control_plan_id, revision_code, change_reason) VALUES (v_org, v_plan, 'A', 'Demo data') RETURNING id INTO v_rev;
  INSERT INTO public.control_plan_operations (organisation_id, control_plan_revision_id, operation_code, sequence, name) VALUES (v_org, v_rev, 'OP-020', 20, 'CNC turning') RETURNING id INTO v_op;
  INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, char_number, name,
      nominal, lower_limit, upper_limit, unit_code, method, criticality, spc_eligible, chart_type, subgroup_size, decimals)
    VALUES (v_org, v_rev, v_op, 'OD', '1', 'Outer diameter', 25, 24.95, 25.05, 'mm', 'Micrometer', 'major', true, 'imr', 1, 3),
           (v_org, v_rev, v_op, 'BORE', '2', 'Bore diameter', 10, 9.9, 10.1, 'mm', 'Bore gauge', 'major', true, 'xbar_r', 5, 3),
           (v_org, v_rev, v_op, 'RA', '3', 'Surface roughness Ra', 0.8, 0.2, 1.6, 'µm', 'Profilometer', 'minor', true, 'imr', 1, 2);
  INSERT INTO public.sampling_rules (organisation_id, control_plan_revision_id, plan_characteristic_id, trigger_type, interval_value, sample_size)
    SELECT v_org, control_plan_revision_id, id, 'every_n_parts', 50, CASE characteristic_key WHEN 'BORE' THEN 5 ELSE 1 END
    FROM public.control_plan_characteristics WHERE control_plan_revision_id = v_rev;
  INSERT INTO public.reaction_plans (organisation_id, control_plan_revision_id, plan_characteristic_id, trigger_type, action, instruction)
    SELECT v_org, control_plan_revision_id, id, 'spc_signal', 'notify', 'Tell the quality engineer and check the tool before the next batch; do not adjust on a single point'
    FROM public.control_plan_characteristics WHERE control_plan_revision_id = v_rev;
  UPDATE public.control_plan_revisions SET status = 'pending_approval' WHERE id = v_rev;
  UPDATE public.control_plan_revisions SET status = 'approved' WHERE id = v_rev;
  UPDATE public.control_plan_revisions SET status = 'effective' WHERE id = v_rev;

  -- ---- inspections -----------------------------------------------------------------------
  FOR p IN SELECT * FROM (VALUES ('DEMO-100', 12, 2.7, 0.0), ('DEMO-200', 5, 6.0, 4.0)) x(part_number, runs, spacing_days, start_offset_days) LOOP
    SELECT id INTO v_part FROM public.parts WHERE organisation_id = v_org AND part_number = p.part_number;
    FOR k IN 1..p.runs LOOP
      v_ts := v_now - interval '35 days' + (p.start_offset_days + (k - 1) * p.spacing_days) * interval '1 day' + (k % 3) * interval '3 hours';
      v_rec := app.start_inspection(v_site, v_part, 'OP-020', CASE WHEN k % 2 = 0 THEN v_m2 ELSE v_m1 END,
                                    'WO-' || (4000 + k + (CASE WHEN p.part_number = 'DEMO-200' THEN 100 ELSE 0 END)), 'LOT-' || (200 + k), NULL, 'every_n_parts', NULL, NULL, NULL);
      SELECT id INTO v_od   FROM public.resolved_inspection_requirements WHERE inspection_record_id = v_rec AND characteristic_key = 'OD';
      SELECT id INTO v_bore FROM public.resolved_inspection_requirements WHERE inspection_record_id = v_rec AND characteristic_key = 'BORE';
      SELECT id INTO v_ra   FROM public.resolved_inspection_requirements WHERE inspection_record_id = v_rec AND characteristic_key = 'RA';
      FOR s IN 1..10 LOOP
        g := (k - 1) * 10 + s;                                    -- running sample number for this part
        INSERT INTO public.inspection_samples (organisation_id, inspection_record_id, unit_reference, trigger_type)
          VALUES (v_org, v_rec, 'SN-' || lpad((p.runs * 0 + g)::text, 4, '0'), 'every_n_parts') RETURNING id INTO v_s;

        n1 := random(); n2 := random();
        v_noise := sqrt(-2 * ln(greatest(n1, 1e-9))) * cos(2 * pi() * n2);
        -- OD: centred slightly high, a spike (in spec, 4σ out), tool-wear drift, tool change at 93.
        v_od_val := 25.002 + 0.008 * v_noise
                    + CASE WHEN g = 47 THEN 0.032 ELSE 0 END
                    + CASE WHEN g BETWEEN 70 AND 92 THEN 0.0006 * (g - 69) ELSE 0 END;
        n1 := random(); n2 := random();
        v_noise := sqrt(-2 * ln(greatest(n1, 1e-9))) * cos(2 * pi() * n2);
        -- BORE: a wide-range patch (loose chuck) at 31–35, then a small step shift from 76.
        v_bore_val := 10.000 + 0.012 * v_noise
                      + CASE WHEN g BETWEEN 31 AND 35 THEN CASE WHEN g % 2 = 0 THEN 0.034 ELSE -0.034 END ELSE 0 END
                      + CASE WHEN g >= 76 THEN 0.012 ELSE 0 END;
        n1 := random(); n2 := random();
        v_noise := sqrt(-2 * ln(greatest(n1, 1e-9))) * cos(2 * pi() * n2);
        v_ra_val := least(1.55, greatest(0.25, 0.8 + 0.1 * v_noise + 0.06 * sin(g / 6.0)));

        INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_numeric)
          VALUES (v_org, v_rec, v_s, v_od, round(v_od_val, 3)), (v_org, v_rec, v_s, v_bore, round(v_bore_val, 3)), (v_org, v_rec, v_s, v_ra, round(v_ra_val, 2));
      END LOOP;
      -- The newest inspection of DEMO-100 is still being worked on.
      v_incomplete := (p.part_number = 'DEMO-100' AND k = p.runs);
      IF NOT v_incomplete THEN
        UPDATE public.inspection_records SET status = 'completed' WHERE id = v_rec;
      END IF;
      v_times := v_times || jsonb_build_object('id', v_rec, 'start', v_ts, 'open', v_incomplete);
    END LOOP;
  END LOOP;

  -- ---- back-date (needs triggers off for this session's last statements) ----------------------
  EXECUTE 'RESET ROLE';
  BEGIN
    EXECUTE 'SET LOCAL session_replication_role = replica';
    UPDATE public.inspection_records r SET started_at = (t ->> 'start')::timestamptz,
        completed_at = CASE WHEN (t ->> 'open')::boolean THEN NULL ELSE (t ->> 'start')::timestamptz + interval '90 minutes' END
      FROM jsonb_array_elements(v_times) t WHERE r.id = (t ->> 'id')::uuid;
    UPDATE public.inspection_samples s SET sampled_at = (t ->> 'start')::timestamptz + s.sample_number * interval '8 minutes'
      FROM jsonb_array_elements(v_times) t WHERE s.inspection_record_id = (t ->> 'id')::uuid;
    UPDATE public.inspection_measurements m SET measured_at = s.sampled_at + interval '1 minute'
      FROM public.inspection_samples s WHERE s.id = m.sample_id AND s.organisation_id = v_org AND s.inspection_record_id IN (SELECT (t ->> 'id')::uuid FROM jsonb_array_elements(v_times) t);
    EXECUTE 'SET LOCAL session_replication_role = origin';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'Could not back-date (session_replication_role not allowed): the readings are stamped with the time this script ran.';
  END;
  RAISE NOTICE 'Added the SPC demo data to organisation %. Open Process Control > SPC Charts and choose DEMO-100.', v_org;
END $$;
