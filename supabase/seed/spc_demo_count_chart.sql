-- NP, C and U chart demo data (not a migration). Run in the Supabase SQL editor after the PC8 migration
-- (20251115100000_count_checks.sql). Adds to ONE organisation:
--   * a part family "DEMO-CF" with part DEMO-400 and an effective control plan CP-DEMO-005 (OP-040 surface check)
--     with three checks charted for SPC:
--       SCRATCH  defect count (at most 3 per unit), 10 units every inspection  -> a C chart (equal subgroups)
--       DENTS    defect count, 5-15 units per inspection                        -> a U chart (subgroups differ)
--       FLASH    pass/fail, 50 checks per inspection (a few of 30)              -> P chart, or NP chart (size 50, calculated)
--   * 24 inspections over the last ~8 weeks, in 9 lots. SCRATCH runs at about 0.6 defects per unit and rises to about
--     1.8 for two weeks while a tool wears (weeks 3-5), then recovers; DENTS runs at about 0.6 per unit with one bad lot
--     (lot 6, about 1.8); FLASH fails about 12 % of checks, 30 % in lot 6. Every failed reading carries an acknowledgement, so the
--     inspections complete normally (the newest stays open).
-- Two parts (DEMO-400, DEMO-401, every third inspection) and two machines (DEMO-INSP-2, and DEMO-INSP-3 on every other
-- inspection, which runs about 1.7 times as many defects and failures) so Process Control > Machine & family analysis has
-- something to compare.
-- Charts to try: by inspection (default), by day and by lot; on FLASH switch between P and NP and leave the NP size
-- on "Calculated" or type 30 to see the other size.
-- Samples, readings and inspections are back-dated afterwards (the audit trail does not record that step).
-- Safe to re-run: it stops if DEMO-400 already exists in the organisation.
--
-- Which organisation: put its name below. Left empty, the script uses the only organisation if
-- there is exactly one, and otherwise stops and lists the names.
DO $$
DECLARE
  v_org_name text := '';  -- e.g. 'Alpha Precision'
  v_org uuid; v_site uuid; v_owner uuid; v_names text;
  v_fam uuid; v_part uuid; v_plan uuid; v_rev uuid; v_op uuid;
  v_m1 uuid; v_m2 uuid; v_part2 uuid; v_use_part uuid; v_use_m uuid; v_mult numeric; v_rec uuid; v_s uuid; v_scr uuid; v_dnt uuid; v_fls uuid;
  v_times jsonb := '[]'::jsonb;
  k integer; s integer; u integer; v_week numeric; v_ts timestamptz; v_lot integer;
  v_lam_s numeric; v_lam_d numeric; v_pf numeric; v_units_d integer; v_checks integer;
  v_now timestamptz := now();
  -- Poisson-distributed count with mean lam (Knuth's method).
  poisson integer;
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
  IF EXISTS (SELECT 1 FROM public.parts WHERE organisation_id = v_org AND upper(part_number) = 'DEMO-400') THEN
    RAISE EXCEPTION 'DEMO-400 already exists in this organisation; nothing was added.';
  END IF;
  SELECT id INTO v_site FROM public.sites WHERE organisation_id = v_org ORDER BY created_at LIMIT 1;
  SELECT ou.user_id INTO v_owner FROM public.organisation_users ou
    JOIN public.user_role_assignments a ON a.membership_id = ou.id
    JOIN public.roles r ON r.id = a.role_id AND r.key = 'owner'
    WHERE ou.organisation_id = v_org AND ou.status = 'active' ORDER BY ou.created_at LIMIT 1;
  IF v_site IS NULL OR v_owner IS NULL THEN RAISE EXCEPTION 'The organisation needs a site and an active owner.'; END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SET CONSTRAINTS ALL IMMEDIATE;

  INSERT INTO public.part_families (organisation_id, code, name, description) VALUES (v_org, 'DEMO-CF', 'Demo defect counts', 'NP / C / U chart demo data') RETURNING id INTO v_fam;
  INSERT INTO public.parts (organisation_id, part_number, name, part_family_id) VALUES (v_org, 'DEMO-400', 'Demo panel 400', v_fam) RETURNING id INTO v_part;
  INSERT INTO public.parts (organisation_id, part_number, name, part_family_id) VALUES (v_org, 'DEMO-401', 'Demo panel 401', v_fam) RETURNING id INTO v_part2;
  INSERT INTO public.part_revisions (organisation_id, part_id, revision) VALUES (v_org, v_part2, 'A');
  UPDATE public.part_revisions SET status = 'released' WHERE organisation_id = v_org AND part_id = v_part2;
  INSERT INTO public.part_revisions (organisation_id, part_id, revision) VALUES (v_org, v_part, 'A');
  UPDATE public.part_revisions SET status = 'released' WHERE organisation_id = v_org AND part_id = v_part;
  INSERT INTO public.machines (organisation_id, code, name, work_centre) VALUES (v_org, 'DEMO-INSP-2', 'Demo surface bench', 'Surface check') RETURNING id INTO v_m1;
  INSERT INTO public.machines (organisation_id, code, name, work_centre) VALUES (v_org, 'DEMO-INSP-3', 'Demo surface bench 2', 'Surface check') RETURNING id INTO v_m2;

  INSERT INTO public.control_plans (organisation_id, plan_code, title) VALUES (v_org, 'CP-DEMO-005', 'Demo panels – surface check') RETURNING id INTO v_plan;
  INSERT INTO public.control_plan_applicability (organisation_id, control_plan_id, part_family_id) VALUES (v_org, v_plan, v_fam);
  INSERT INTO public.control_plan_revisions (organisation_id, control_plan_id, revision_code, change_reason) VALUES (v_org, v_plan, 'A', 'Demo data') RETURNING id INTO v_rev;
  INSERT INTO public.control_plan_operations (organisation_id, control_plan_revision_id, operation_code, sequence, name) VALUES (v_org, v_rev, 'OP-040', 40, 'Surface check') RETURNING id INTO v_op;
  INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, char_number, name, data_type, upper_limit, criticality, spc_eligible, chart_type, subgroup_size)
    VALUES (v_org, v_rev, v_op, 'SCRATCH', '1', 'Scratches per unit', 'count', 3, 'minor', true, 'defects', NULL),
           (v_org, v_rev, v_op, 'DENTS', '2', 'Dents per unit', 'count', NULL, 'minor', true, 'defects', NULL);
  INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, char_number, name, data_type, criticality, spc_eligible, chart_type, subgroup_size)
    VALUES (v_org, v_rev, v_op, 'FLASH', '3', 'No flash on the edge', 'attribute', 'major', true, 'p', NULL);
  INSERT INTO public.reaction_plans (organisation_id, control_plan_revision_id, plan_characteristic_id, trigger_type, action, instruction)
    SELECT v_org, control_plan_revision_id, id, 'spc_signal', 'notify', 'Tell the quality engineer; check the tool and the last setup before the next lot'
    FROM public.control_plan_characteristics WHERE control_plan_revision_id = v_rev;
  UPDATE public.control_plan_revisions SET status = 'pending_approval' WHERE id = v_rev;
  UPDATE public.control_plan_revisions SET status = 'approved' WHERE id = v_rev;
  UPDATE public.control_plan_revisions SET status = 'effective' WHERE id = v_rev;

  FOR k IN 1..24 LOOP
    v_week := (k - 1) / 3.0;                                  -- three inspections a week for eight weeks
    v_ts := v_now - interval '56 days' + (k - 1) * interval '56 hours' + (k % 3) * interval '2 hours';
    v_lot := (k + 2) / 3;                                     -- nine lots of up to three inspections
    v_lam_s := CASE WHEN v_week >= 3.0 AND v_week < 5.0 THEN 1.8 ELSE 0.6 END;   -- scratches per unit: a tool wears, then is changed
    v_lam_d := CASE WHEN v_lot = 6 THEN 1.8 ELSE 0.6 END;                          -- dents per unit: one bad lot
    v_pf := CASE WHEN v_lot = 6 THEN 0.30 ELSE 0.12 END;                           -- flash: one bad lot
    v_units_d := 5 + ((k * 7) % 11);                                               -- 5 to 15 units checked for dents
    v_checks := CASE WHEN k % 8 = 0 THEN 30 ELSE 50 END;                           -- 50 flash checks, a few of 30
    v_use_part := CASE WHEN k % 3 = 0 THEN v_part2 ELSE v_part END;
    v_use_m := CASE WHEN k % 2 = 0 THEN v_m2 ELSE v_m1 END;
    v_mult := CASE WHEN k % 2 = 0 THEN 1.7 ELSE 1 END;
    v_lam_s := v_lam_s * v_mult; v_lam_d := v_lam_d * v_mult; v_pf := least(0.6, v_pf * v_mult);
    v_rec := app.start_inspection(v_site, v_use_part, 'OP-040', v_use_m, 'WO-' || (6000 + k), 'LOT-4' || lpad(v_lot::text, 2, '0'), NULL, 'every_n_parts', NULL, NULL, NULL);
    SELECT id INTO v_scr FROM public.resolved_inspection_requirements WHERE inspection_record_id = v_rec AND characteristic_key = 'SCRATCH';
    SELECT id INTO v_dnt FROM public.resolved_inspection_requirements WHERE inspection_record_id = v_rec AND characteristic_key = 'DENTS';
    SELECT id INTO v_fls FROM public.resolved_inspection_requirements WHERE inspection_record_id = v_rec AND characteristic_key = 'FLASH';
    -- Scratches: 10 units every time. Dents: the units checked vary. Flash: pass/fail checks.
    FOR s IN 1..greatest(10, v_units_d, v_checks) LOOP
      INSERT INTO public.inspection_samples (organisation_id, inspection_record_id, unit_reference, trigger_type)
        VALUES (v_org, v_rec, 'SN-' || lpad(((k - 1) * 50 + s)::text, 5, '0'), 'every_n_parts') RETURNING id INTO v_s;
      IF s <= 10 THEN
        poisson := -1;
        DECLARE v_l numeric := exp(-v_lam_s); v_p numeric := 1; BEGIN
          LOOP poisson := poisson + 1; v_p := v_p * random(); EXIT WHEN v_p <= v_l; END LOOP;
        END;
        INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_count) VALUES (v_org, v_rec, v_s, v_scr, poisson);
      END IF;
      IF s <= v_units_d THEN
        poisson := -1;
        DECLARE v_l numeric := exp(-v_lam_d); v_p numeric := 1; BEGIN
          LOOP poisson := poisson + 1; v_p := v_p * random(); EXIT WHEN v_p <= v_l; END LOOP;
        END;
        INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_count) VALUES (v_org, v_rec, v_s, v_dnt, poisson);
      END IF;
      IF s <= v_checks THEN
        INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_pass) VALUES (v_org, v_rec, v_s, v_fls, random() >= v_pf);
      END IF;
    END LOOP;
    -- Every failed reading has been looked at.
    INSERT INTO public.inspection_failure_acknowledgements (organisation_id, inspection_record_id, measurement_id, note)
      SELECT v_org, v_rec, m.id, 'Demo data: reviewed at final inspection'
      FROM public.inspection_measurements m WHERE m.inspection_record_id = v_rec AND m.result = 'fail';
    IF k < 24 THEN
      UPDATE public.inspection_records SET status = 'completed' WHERE id = v_rec;   -- the newest stays open
    END IF;
    v_times := v_times || jsonb_build_object('id', v_rec, 'start', v_ts, 'open', k = 24);
  END LOOP;

  EXECUTE 'RESET ROLE';
  ALTER TABLE public.inspection_records DISABLE TRIGGER USER;
  ALTER TABLE public.inspection_samples DISABLE TRIGGER USER;
  ALTER TABLE public.inspection_measurements DISABLE TRIGGER USER;
  UPDATE public.inspection_records r SET started_at = (t ->> 'start')::timestamptz,
      completed_at = CASE WHEN (t ->> 'open')::boolean THEN NULL ELSE (t ->> 'start')::timestamptz + interval '3 hours' END
    FROM jsonb_array_elements(v_times) t WHERE r.id = (t ->> 'id')::uuid;
  UPDATE public.inspection_samples s SET sampled_at = (t ->> 'start')::timestamptz + s.sample_number * interval '4 minutes'
    FROM jsonb_array_elements(v_times) t WHERE s.inspection_record_id = (t ->> 'id')::uuid;
  UPDATE public.inspection_measurements m SET measured_at = s.sampled_at + interval '30 seconds'
    FROM public.inspection_samples s WHERE s.id = m.sample_id AND s.organisation_id = v_org
      AND s.inspection_record_id IN (SELECT (t ->> 'id')::uuid FROM jsonb_array_elements(v_times) t);
  ALTER TABLE public.inspection_records ENABLE TRIGGER USER;
  ALTER TABLE public.inspection_samples ENABLE TRIGGER USER;
  ALTER TABLE public.inspection_measurements ENABLE TRIGGER USER;
  RAISE NOTICE 'Added the NP / C / U chart demo data to organisation %. Open Process Control > SPC Charts, choose DEMO-400 and try each characteristic.', v_org;
END $$;
