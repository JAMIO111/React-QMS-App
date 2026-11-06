-- P chart demo data (not a migration). Run in the Supabase SQL editor after the PC7 migration
-- (20251114100000_p_charts.sql). Adds to ONE organisation:
--   * a part family "DEMO-PF" with part DEMO-300 and an effective control plan CP-DEMO-004 (OP-030 final visual)
--     with two pass/fail checks charted as P charts: VISUAL (no chatter marks) and BURR (burr-free groove),
--   * 24 inspections over the last ~8 weeks with 20–60 checks each (so subgroup sizes differ and the limits
--     step), grouped into 9 lots. VISUAL runs at about 4 % failures, jumps to about 17 % for two weeks while a tool
--     wears (weeks 3–5) and recovers; BURR runs at about 1.5 % with one bad lot (lot 306). Every failure carries an
--     acknowledgement, so the inspections complete normally.
-- Charts to try: by inspection (default), by day and by lot — the signals differ with the subgroup.
-- Samples, readings and inspections are back-dated afterwards (the audit trail does not record that step).
-- Safe to re-run: it stops if DEMO-300 already exists in the organisation.
--
-- Which organisation: put its name below. Left empty, the script uses the only organisation if
-- there is exactly one, and otherwise stops and lists the names.
DO $$
DECLARE
  v_org_name text := '';  -- e.g. 'Alpha Precision'
  v_org uuid; v_site uuid; v_owner uuid; v_names text;
  v_fam uuid; v_part uuid; v_plan uuid; v_rev uuid; v_op uuid;
  v_m1 uuid; v_rec uuid; v_s uuid; v_vis uuid; v_bur uuid; v_mid uuid;
  v_times jsonb := '[]'::jsonb;
  k integer; s integer; n integer; v_week numeric; v_pv numeric; v_pb numeric; v_ts timestamptz; v_lot integer;
  v_now timestamptz := now();
BEGIN
  PERFORM setseed(0.61);
  IF coalesce(trim(v_org_name), '') <> '' THEN
    SELECT id INTO v_org FROM public.organisations WHERE lower(name) = lower(trim(v_org_name));
  ELSIF (SELECT count(*) FROM public.organisations) = 1 THEN
    SELECT id INTO v_org FROM public.organisations;
  END IF;
  IF v_org IS NULL THEN
    SELECT string_agg(format('"%s"', name), ', ' ORDER BY name) INTO v_names FROM public.organisations;
    RAISE EXCEPTION 'Set v_org_name at the top of this script to one of: %', v_names;
  END IF;
  IF EXISTS (SELECT 1 FROM public.parts WHERE organisation_id = v_org AND upper(part_number) = 'DEMO-300') THEN
    RAISE EXCEPTION 'DEMO-300 already exists in this organisation; nothing was added.';
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

  INSERT INTO public.part_families (organisation_id, code, name, description) VALUES (v_org, 'DEMO-PF', 'Demo pass/fail', 'P chart demo data') RETURNING id INTO v_fam;
  INSERT INTO public.parts (organisation_id, part_number, name, part_family_id) VALUES (v_org, 'DEMO-300', 'Demo rod 300', v_fam) RETURNING id INTO v_part;
  INSERT INTO public.part_revisions (organisation_id, part_id, revision) VALUES (v_org, v_part, 'A');
  UPDATE public.part_revisions SET status = 'released' WHERE organisation_id = v_org AND part_id = v_part;
  INSERT INTO public.machines (organisation_id, code, name, work_centre) VALUES (v_org, 'DEMO-INSP-1', 'Demo inspection bench', 'Final inspection') RETURNING id INTO v_m1;

  INSERT INTO public.control_plans (organisation_id, plan_code, title) VALUES (v_org, 'CP-DEMO-004', 'Demo rods – final visual') RETURNING id INTO v_plan;
  INSERT INTO public.control_plan_applicability (organisation_id, control_plan_id, part_family_id) VALUES (v_org, v_plan, v_fam);
  INSERT INTO public.control_plan_revisions (organisation_id, control_plan_id, revision_code, change_reason) VALUES (v_org, v_plan, 'A', 'Demo data') RETURNING id INTO v_rev;
  INSERT INTO public.control_plan_operations (organisation_id, control_plan_revision_id, operation_code, sequence, name) VALUES (v_org, v_rev, 'OP-030', 30, 'Final visual') RETURNING id INTO v_op;
  INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, char_number, name, data_type, criticality, spc_eligible, chart_type, subgroup_size)
    VALUES (v_org, v_rev, v_op, 'VISUAL', '1', 'No chatter marks', 'attribute', 'minor', true, 'p', NULL),
           (v_org, v_rev, v_op, 'BURR', '2', 'Burr-free groove', 'attribute', 'major', true, 'p', NULL);
  INSERT INTO public.reaction_plans (organisation_id, control_plan_revision_id, plan_characteristic_id, trigger_type, action, instruction)
    SELECT v_org, control_plan_revision_id, id, 'spc_signal', 'notify', 'Tell the quality engineer; check the tool and the last setup before the next lot'
    FROM public.control_plan_characteristics WHERE control_plan_revision_id = v_rev;
  UPDATE public.control_plan_revisions SET status = 'pending_approval' WHERE id = v_rev;
  UPDATE public.control_plan_revisions SET status = 'approved' WHERE id = v_rev;
  UPDATE public.control_plan_revisions SET status = 'effective' WHERE id = v_rev;

  FOR k IN 1..24 LOOP
    v_week := (k - 1) / 3.0;                                  -- three inspections a week for eight weeks
    v_ts := v_now - interval '56 days' + (k - 1) * interval '56 hours' + (k % 3) * interval '2 hours';
    n := 20 + ((k * 7) % 5) * 10;                             -- 20, 30, 40, 50 or 60 checks
    v_lot := (k + 2) / 3;                                     -- nine lots of up to three inspections
    -- VISUAL: ~4 %, jumping to ~17 % for two weeks while a tool wears (weeks 3-5), back to normal after a tool change.
    v_pv := CASE WHEN v_week >= 3.0 AND v_week < 5.0 THEN 0.17 ELSE 0.035 END;
    -- BURR: ~2 %, one bad lot (lot 6).
    v_pb := CASE WHEN v_lot = 6 THEN 0.15 ELSE 0.015 END;
    v_rec := app.start_inspection(v_site, v_part, 'OP-030', v_m1, 'WO-' || (5000 + k), 'LOT-3' || lpad(v_lot::text, 2, '0'), NULL, 'every_n_parts', NULL, NULL, NULL);
    SELECT id INTO v_vis FROM public.resolved_inspection_requirements WHERE inspection_record_id = v_rec AND characteristic_key = 'VISUAL';
    SELECT id INTO v_bur FROM public.resolved_inspection_requirements WHERE inspection_record_id = v_rec AND characteristic_key = 'BURR';
    FOR s IN 1..n LOOP
      INSERT INTO public.inspection_samples (organisation_id, inspection_record_id, unit_reference, trigger_type)
        VALUES (v_org, v_rec, 'SN-' || lpad(((k - 1) * 60 + s)::text, 5, '0'), 'every_n_parts') RETURNING id INTO v_s;
      INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_pass)
        VALUES (v_org, v_rec, v_s, v_vis, random() >= v_pv), (v_org, v_rec, v_s, v_bur, random() >= v_pb);
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
  RAISE NOTICE 'Added the P chart demo data to organisation %. Open Process Control > SPC Charts, choose DEMO-300 and try the three subgroup choices.', v_org;
END $$;
