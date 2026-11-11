-- Audits demo data (not a migration). Run in the Supabase SQL editor after the audit migrations (up to 20251219100000). Adds to ONE organisation:
--   * 5 audit templates (layered process audit, 5S housekeeping, final product audit, calibration system audit, supplier process audit),
--     each with a checklist of mixed answer types, what it is relevant to, a frequency and a pass mark, and its first version;
--   * the schedule for the last ~13 weeks and the next 6 (weekly, every 14 days, monthly, quarterly; one slot skipped with a reason);
--   * about 20 audit records over that time: most on time and passed, some late, some failed (one with a critical failure), one in progress,
--     some scheduled audits never done (overdue and missed) — so the audit dashboard, schedule and registers all have something to show;
--   * findings on every failed answer (major / minor non-conformities), some closed, some open, some past their due date;
--   * a second version of two templates (a pass mark and a purpose changed, with a reason) for the dashboard's template changes.
-- Everything goes through the same functions the app uses, acting as an Owner of the organisation, so every rule is applied.
-- Safe to re-run: it stops if the first demo audit already exists in the organisation. To remove it again, ask for the matching clean-up script.
--
-- Which organisation: put its name below. Left empty, the script uses the only organisation if there is exactly one, and otherwise stops
-- and lists the names.

-- Answers every question of a record by its type. `p_fail` = the question numbers that fail; `p_na` marks the yes / no / not applicable ones n/a.
CREATE OR REPLACE FUNCTION pg_temp.demo_answer(p_record uuid, p_fail integer[], p_na boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  q public.audit_record_questions%ROWTYPE;
  v_fail boolean;
  v_mid numeric;
  v_note text;
BEGIN
  FOR q IN SELECT * FROM public.audit_record_questions WHERE audit_record_id = p_record ORDER BY sequence LOOP
    v_fail := q.sequence = ANY (coalesce(p_fail, ARRAY[]::integer[]));
    v_note := CASE WHEN v_fail THEN 'Found during the walk-round: ' || lower(left(q.question, 80)) END;
    IF q.answer_type = 'pass_fail' THEN
      PERFORM app.record_audit_response(p_record, q.id, CASE WHEN v_fail THEN 'fail' ELSE 'pass' END, NULL, v_note);
    ELSIF q.answer_type IN ('yes_no', 'yes_no_na') THEN
      IF q.answer_type = 'yes_no_na' AND p_na AND NOT v_fail AND q.sequence % 4 = 0 THEN
        PERFORM app.record_audit_response(p_record, q.id, 'na', NULL, NULL);
      ELSE
        PERFORM app.record_audit_response(p_record, q.id, CASE WHEN v_fail THEN (CASE q.pass_answer WHEN 'yes' THEN 'no' ELSE 'yes' END) ELSE q.pass_answer END, NULL, v_note);
      END IF;
    ELSIF q.answer_type = 'compliant' THEN
      PERFORM app.record_audit_response(p_record, q.id, CASE WHEN v_fail THEN 'non_compliant' ELSE 'compliant' END, NULL, v_note);
    ELSIF q.answer_type IN ('numeric', 'measurement') THEN
      v_mid := coalesce((q.lower_limit + q.upper_limit) / 2, q.lower_limit, q.upper_limit, 0);
      PERFORM app.record_audit_response(p_record, q.id, NULL,
        CASE WHEN v_fail THEN coalesce(q.upper_limit, q.lower_limit, 0) + (CASE WHEN q.upper_limit IS NOT NULL THEN 0.5 ELSE -0.5 END) ELSE v_mid END, v_note);
    ELSIF q.answer_type = 'text' THEN
      PERFORM app.record_audit_response(p_record, q.id, NULL, NULL, 'No concerns noted.');
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE
  v_org_name text := '';  -- e.g. 'Alpha Precision'
  v_org uuid;
  v_site uuid;
  v_owner uuid;
  v_names text;
  v_emp uuid;
  v_machines uuid[];
  v_depts uuid[];
  v_targets jsonb;
  v_targets_b jsonb;
  v_cls_major uuid;
  v_cls_minor uuid;
  v_cls_obs uuid;
  d record;
  s record;
  x record;
  v_def uuid;
  v_defs uuid[] := ARRAY[]::uuid[];
  v_rec uuid;
  v_plan text[];
  v_what text;
  v_date date;
  v_fail integer[];
  v_find uuid;
  v_i integer;
  v_cnt integer;
  v_slot_total integer;
  v_skipped boolean := false;
  v_days_to_close integer;
BEGIN
  PERFORM setseed(0.37);

  -- ---- organisation and owner -------------------------------------------------------------
  IF coalesce(trim(v_org_name), '') <> '' THEN
    SELECT id INTO v_org FROM public.organisations WHERE lower(name) = lower(trim(v_org_name));
  ELSIF (SELECT count(*) FROM public.organisations) = 1 THEN
    SELECT id INTO v_org FROM public.organisations;
  END IF;
  IF v_org IS NULL THEN
    SELECT string_agg(format('"%s"', name), ', ' ORDER BY name) INTO v_names FROM public.organisations;
    RAISE EXCEPTION 'Set v_org_name at the top of this script to one of: %', v_names;
  END IF;
  IF EXISTS (SELECT 1 FROM public.audit_definitions WHERE organisation_id = v_org AND title = 'Layered process audit — CNC cell') THEN
    RAISE NOTICE 'The demo audits already exist in this organisation; nothing added.';
    RETURN;
  END IF;
  SELECT m.user_id INTO v_owner
    FROM public.organisation_users m
    JOIN public.user_role_assignments a ON a.membership_id = m.id
    JOIN public.roles r ON r.id = a.role_id AND r.key = 'owner'
   WHERE m.organisation_id = v_org AND m.status = 'active' AND m.user_id IS NOT NULL
   ORDER BY m.created_at LIMIT 1;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'This organisation has no active Owner to carry the audits out as.';
  END IF;

  -- ---- what the audits are relevant to: two or three machines and up to two departments ---
  SELECT id INTO v_site FROM public.sites WHERE organisation_id = v_org AND active ORDER BY created_at LIMIT 1;
  IF (SELECT count(*) FROM public.machines WHERE organisation_id = v_org AND active) < 2 THEN
    INSERT INTO public.machines (organisation_id, code, name, site_id)
    VALUES (v_org, 'DEMO-CNC1', 'CNC lathe 1 (demo)', v_site), (v_org, 'DEMO-CNC2', 'CNC mill 2 (demo)', v_site), (v_org, 'DEMO-PRESS', 'Press brake (demo)', v_site)
    ON CONFLICT DO NOTHING;
  END IF;
  SELECT array_agg(id) INTO v_machines FROM (SELECT id FROM public.machines WHERE organisation_id = v_org AND active ORDER BY created_at LIMIT 3) m;
  SELECT array_agg(id) INTO v_depts FROM (SELECT id FROM public.departments WHERE organisation_id = v_org AND active ORDER BY created_at LIMIT 2) q;
  SELECT id INTO v_emp FROM public."Employees" WHERE organisation_id = v_org ORDER BY id LIMIT 1;

  -- machines 1 and 2 (and the first department) for the process audits; the third machine only for an audit that is never done (shows as uncovered)
  v_targets := (SELECT coalesce(jsonb_agg(jsonb_build_object('kind', 'machine', 'machineId', m)), '[]'::jsonb) FROM unnest(v_machines[1:2]) m)
    || (SELECT coalesce(jsonb_agg(jsonb_build_object('kind', 'department', 'departmentId', dpt)), '[]'::jsonb) FROM unnest(v_depts[1:1]) dpt);
  v_targets_b := (SELECT coalesce(jsonb_agg(jsonb_build_object('kind', 'department', 'departmentId', dpt)), '[]'::jsonb) FROM unnest(v_depts) dpt);

  -- ---- act as the Owner: the same rules as in the app -------------------------------------
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  PERFORM set_config('role', 'authenticated', true);

  SELECT id INTO v_cls_major FROM public.audit_finding_classifications WHERE organisation_id = v_org AND key = 'major_nc';
  SELECT id INTO v_cls_minor FROM public.audit_finding_classifications WHERE organisation_id = v_org AND key = 'minor_nc';
  SELECT id INTO v_cls_obs FROM public.audit_finding_classifications WHERE organisation_id = v_org AND key = 'observation';

  -- ---- the templates ------------------------------------------------------------------------
  -- 1. Layered process audit, weekly (Monday to Friday), the main source of data.
  INSERT INTO public.audit_definitions (organisation_id, title, audit_type, purpose, procedure, frequency_kind, first_due_on, grace_days, weekdays_only, pass_mark)
  VALUES (v_org, 'Layered process audit — CNC cell', 'layered_process',
    'Check every week that the cell is run to its standard work and that the first-line controls are in place.',
    E'1. Walk the cell with the team leader.\n2. Check each item on the list against what you see, not what you are told.\n3. Note the evidence for every failure and agree an owner and a date.',
    'weekly', (date_trunc('week', current_date - 84))::date, 2, true, 90) RETURNING id INTO v_def;
  v_defs := v_defs || v_def;
  PERFORM app.set_audit_checklist(v_def, '[
    {"question":"Machine guards are fitted and interlocks work","answerType":"pass_fail","critical":true,"guidance":"Open each guard and confirm the machine stops."},
    {"question":"Work instruction is displayed and is the current revision","answerType":"yes_no"},
    {"question":"First-off approval is signed for the running job","answerType":"yes_no_na"},
    {"question":"Gauges in use are in calibration (label in date)","answerType":"compliant","critical":true},
    {"question":"Coolant concentration (%)","answerType":"numeric","unit":"%","lowerLimit":6,"upperLimit":10},
    {"question":"Floor and walkways are clear of swarf and oil","answerType":"pass_fail"},
    {"question":"Non-conforming parts are in the red bin and tagged","answerType":"yes_no"},
    {"question":"Operator can explain the reaction plan for an out-of-tolerance part","answerType":"yes_no"},
    {"question":"Anything the auditor wants to record","answerType":"text"}
  ]'::jsonb);
  PERFORM app.set_audit_targets(v_def, v_targets);

  -- 2. 5S housekeeping, monthly.
  INSERT INTO public.audit_definitions (organisation_id, title, audit_type, purpose, frequency_kind, first_due_on, grace_days, pass_mark)
  VALUES (v_org, '5S housekeeping audit — goods inwards', 'housekeeping', 'Keep the goods-inwards area tidy, labelled and safe.', 'monthly', current_date - 95, 5, 80) RETURNING id INTO v_def;
  v_defs := v_defs || v_def;
  PERFORM app.set_audit_checklist(v_def, '[
    {"question":"Quarantine area is marked and nothing unlabelled is in it","answerType":"pass_fail","critical":true},
    {"question":"Pallets are stacked within the marked areas","answerType":"yes_no"},
    {"question":"Aisles and fire exits are clear","answerType":"pass_fail"},
    {"question":"Material is stored on its labelled shelf","answerType":"yes_no"},
    {"question":"Receiving paperwork is filed the same day","answerType":"yes_no_na"},
    {"question":"Cleaning schedule is signed up to date","answerType":"compliant"},
    {"question":"Comments","answerType":"text"}
  ]'::jsonb);
  PERFORM app.set_audit_targets(v_def, v_targets_b);

  -- 3. Final product audit every 14 days, with measurements.
  INSERT INTO public.audit_definitions (organisation_id, title, audit_type, purpose, frequency_kind, frequency_interval, first_due_on, grace_days, pass_mark)
  VALUES (v_org, 'Final product audit — packed parts', 'product', 'Re-inspect a sample of packed parts to prove the final inspection is catching what it should.', 'every_n_days', 14, current_date - 90, 3, 95) RETURNING id INTO v_def;
  v_defs := v_defs || v_def;
  PERFORM app.set_audit_checklist(v_def, '[
    {"question":"Part number and revision on the label match the order","answerType":"pass_fail","critical":true},
    {"question":"Quantity in the box matches the packing list","answerType":"yes_no"},
    {"question":"Critical bore diameter (mm)","answerType":"measurement","unit":"mm","nominal":12.000,"lowerLimit":11.98,"upperLimit":12.02,"critical":true},
    {"question":"Surface finish Ra (µm)","answerType":"numeric","unit":"µm","upperLimit":1.6},
    {"question":"No burrs or visible damage","answerType":"pass_fail"},
    {"question":"Certificate of conformance is in the box","answerType":"yes_no"}
  ]'::jsonb);
  PERFORM app.set_audit_targets(v_def, v_targets);

  -- 4. Calibration system audit, quarterly.
  INSERT INTO public.audit_definitions (organisation_id, title, audit_type, purpose, frequency_kind, first_due_on, grace_days, pass_mark)
  VALUES (v_org, 'Calibration and gauge control system audit', 'system', 'Confirm the calibration system is followed: records, labels, quarantine and traceability.', 'quarterly', current_date - 100, 14, 85) RETURNING id INTO v_def;
  v_defs := v_defs || v_def;
  PERFORM app.set_audit_checklist(v_def, '[
    {"question":"Every gauge on the shop floor has a unique asset number and a calibration label","answerType":"compliant"},
    {"question":"No gauge is past its due date and still in use","answerType":"compliant","critical":true},
    {"question":"Out-of-tolerance results trigger a review of work measured since the last calibration","answerType":"compliant"},
    {"question":"Quarantined gauges are physically separated","answerType":"compliant"},
    {"question":"Calibration certificates trace to national standards","answerType":"compliant"},
    {"question":"Gauge handling and storage prevent damage","answerType":"compliant"}
  ]'::jsonb);
  PERFORM app.set_audit_targets(v_def, v_targets_b);

  -- 5. Supplier process audit: on demand, never carried out here, and relevant to a machine no other audit covers.
  INSERT INTO public.audit_definitions (organisation_id, title, audit_type, purpose, frequency_kind, pass_mark)
  VALUES (v_org, 'Supplier process audit — template', 'supplier', 'Checklist for an on-site audit of a supplier''s process controls.', 'on_demand', 85) RETURNING id INTO v_def;
  v_defs := v_defs || v_def;
  PERFORM app.set_audit_checklist(v_def, '[
    {"question":"A quality manual or equivalent is available","answerType":"yes_no_na"},
    {"question":"Goods-in inspection is carried out and recorded","answerType":"yes_no_na"},
    {"question":"Non-conformances are contained, recorded and closed out","answerType":"yes_no_na","critical":true},
    {"question":"Measuring equipment is calibrated","answerType":"yes_no_na"},
    {"question":"Corrective actions are followed up","answerType":"yes_no_na"}
  ]'::jsonb);
  PERFORM app.set_audit_targets(v_def, (SELECT coalesce(jsonb_agg(jsonb_build_object('kind', 'machine', 'machineId', m)), '[]'::jsonb) FROM unnest(v_machines[3:3]) m));

  -- Every template's first version (a signed-in person's content change must be saved as a version).
  FOREACH v_def IN ARRAY v_defs LOOP
    PERFORM app.save_audit_version(v_def, NULL);
  END LOOP;

  -- ---- make the audits older, so there is a schedule to show ---------------------------------
  PERFORM set_config('role', session_user, true);
  UPDATE public.audit_definitions SET created_at = now() - interval '110 days' WHERE id = ANY (v_defs);
  PERFORM set_config('role', 'authenticated', true);
  PERFORM app.generate_audit_occurrences(v_org, current_date + 45);

  -- ---- carry the audits out -------------------------------------------------------------------
  -- Per slot, in order: pass | late (done after its grace) | fail (a minor failure) | crit (the critical question fails) | na (passes, some not applicable) | missed (never done)
  FOR d IN SELECT id, reference, title, grace_days, frequency_kind FROM public.audit_definitions WHERE id = ANY (v_defs) AND frequency_kind <> 'on_demand' ORDER BY audit_number LOOP
    v_plan := CASE d.frequency_kind
      WHEN 'weekly' THEN ARRAY['pass','pass','fail','pass','late','pass','missed','crit','pass','na','pass','fail']
      WHEN 'every_n_days' THEN ARRAY['pass','fail','pass','late','pass','pass','crit']
      WHEN 'monthly' THEN ARRAY['pass','fail','pass','na','pass']
      ELSE ARRAY['pass','pass'] END;
    SELECT count(*) INTO v_slot_total FROM public.audit_occurrences WHERE audit_definition_id = d.id AND due_on <= current_date;
    v_i := 0;
    FOR s IN SELECT id, due_on FROM public.audit_occurrences WHERE audit_definition_id = d.id AND due_on <= current_date ORDER BY due_on LOOP
      v_i := v_i + 1;
      v_what := v_plan[1 + (v_i - 1) % array_length(v_plan, 1)];

      -- one monthly slot is skipped with a reason; the last slot of the others is left undone (overdue or missed), the weekly one is started and left in progress
      IF d.frequency_kind = 'monthly' AND v_i = 2 AND NOT v_skipped THEN
        PERFORM app.skip_audit_occurrence(s.id, 'Goods inwards was closed for the stocktake that week');
        v_skipped := true;
        CONTINUE;
      END IF;
      IF v_i = v_slot_total AND d.frequency_kind <> 'weekly' THEN CONTINUE; END IF;
      IF v_what = 'missed' AND v_i < v_slot_total THEN CONTINUE; END IF;

      v_date := CASE WHEN v_what = 'late' THEN least(current_date, s.due_on + d.grace_days + 3) ELSE least(current_date, s.due_on - (v_i % 2)) END;
      v_rec := app.start_audit(d.id, s.id, CASE WHEN d.frequency_kind IN ('monthly', 'quarterly') THEN v_targets_b ELSE v_targets END);

      IF v_i = v_slot_total AND d.frequency_kind = 'weekly' THEN
        -- left in progress: only the first questions answered
        PERFORM app.update_audit_record(v_rec, NULL, current_date);
        FOR x IN SELECT id, answer_type FROM public.audit_record_questions WHERE audit_record_id = v_rec AND sequence <= 3 AND answer_type IN ('pass_fail', 'yes_no', 'yes_no_na') ORDER BY sequence LOOP
          PERFORM app.record_audit_response(v_rec, x.id, CASE x.answer_type WHEN 'pass_fail' THEN 'pass' ELSE 'yes' END);
        END LOOP;
        CONTINUE;
      END IF;

      PERFORM app.update_audit_record(v_rec, CASE WHEN v_what = 'late' THEN 'Done after its slot: the cell was down for a tool change.' END, v_date, v_what = 'late');
      v_fail := CASE v_what
        WHEN 'fail' THEN (SELECT array_agg(sequence) FROM (SELECT sequence FROM public.audit_record_questions WHERE audit_record_id = v_rec AND NOT critical AND answer_type <> 'text' ORDER BY sequence DESC LIMIT 1) z)
        WHEN 'crit' THEN (SELECT array_agg(sequence) FROM (SELECT sequence FROM public.audit_record_questions WHERE audit_record_id = v_rec AND critical ORDER BY sequence LIMIT 1) z)
        ELSE ARRAY[]::integer[] END;
      PERFORM pg_temp.demo_answer(v_rec, v_fail, v_what = 'na');

      -- a finding on every failed answer: a major non-conformity for a critical question, otherwise minor; a few are observations
      v_cnt := 0;
      FOR x IN SELECT r.id AS response_id, q.question, q.critical, r.note
                 FROM public.audit_responses r JOIN public.audit_record_questions q ON q.id = r.record_question_id
                WHERE r.audit_record_id = v_rec AND r.result = 'fail' ORDER BY q.sequence LOOP
        v_cnt := v_cnt + 1;
        v_find := app.create_audit_finding(v_rec,
          x.response_id,
          CASE WHEN x.critical THEN v_cls_major WHEN v_i % 3 = 0 THEN v_cls_obs ELSE v_cls_minor END,
          left(x.question, 120),
          coalesce(x.note, 'Failed at audit') || '. Agreed with the team leader on the day.',
          NULL, v_emp, v_date + CASE WHEN x.critical THEN 7 ELSE 21 END);
        -- older findings are closed once corrected; the recent ones stay open (some already past their date)
        IF v_date < current_date - 50 THEN
          PERFORM app.close_audit_finding(v_find, 'Corrected and checked at the following audit');
        END IF;
      END LOOP;

      PERFORM app.complete_audit(v_rec);
    END LOOP;
  END LOOP;

  -- ---- change two templates, so there are recent template changes to show ----------------------
  UPDATE public.audit_definitions SET pass_mark = 95 WHERE id = v_defs[1];
  PERFORM app.save_audit_version(v_defs[1], 'Raised the pass mark to 95% after three weeks of failures at the same station');
  UPDATE public.audit_definitions SET purpose = 'Keep the goods-inwards area tidy, labelled and safe, with the quarantine area checked at every audit.' WHERE id = v_defs[2];
  PERFORM app.save_audit_version(v_defs[2], 'Made the quarantine check part of the stated purpose');

  PERFORM set_config('role', session_user, true);
  PERFORM set_config('request.jwt.claims', '', true);

  RAISE NOTICE 'Added % demo audits, % records and % findings to this organisation.',
    (SELECT count(*) FROM public.audit_definitions WHERE id = ANY (v_defs)),
    (SELECT count(*) FROM public.audit_records WHERE audit_definition_id = ANY (v_defs)),
    (SELECT count(*) FROM public.audit_findings f JOIN public.audit_records r ON r.id = f.audit_record_id WHERE r.audit_definition_id = ANY (v_defs));
END $$;
