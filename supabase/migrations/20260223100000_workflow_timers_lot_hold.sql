-- Workflow rules WF3 (docs/workflow-engine-plan.md §5, decisions W5–W7): escalation timers and putting a lot on hold.
--
--  * Action "later": after N days, re-read the record and, if the conditions still hold, do the actions inside it (tell people, give a task, hold the lot).
--    The worker queues a job to run at the time; when it runs it reads the record afresh (app.system_workflow_timer_facts) and does nothing when the rule has
--    been paused or retired, or the record is gone. Its inner actions are numbered 10 + 10 × the timer's place + their own place, so each still happens once.
--  * Action "hold_lot": put the lot of the record (a non-conformance's lot, or the lot of the inspection a failed reading belongs to) on hold, with a reason,
--    acting with the authority of the person who saved the rule version (W7): they must still be an active member holding production.manage at the lot's site
--    when it runs. Otherwise it is refused, recorded on the run, and that person is told (if they may read the record). A lot already on hold, or closed, is
--    left as it is. The change is made as that person, so the lot's own rules apply and the audit trail names them.
--  * system_workflow_notify / system_workflow_task take the record's facts as read now (for a timer), so "the record's owner" means the owner at that time.

ALTER TABLE public.workflow_notices DROP CONSTRAINT workflow_notices_action_index_check;
ALTER TABLE public.workflow_notices ADD CONSTRAINT workflow_notices_action_index_check CHECK (action_index BETWEEN 0 AND 199);
ALTER TABLE public.workflow_tasks DROP CONSTRAINT workflow_tasks_action_index_check;
ALTER TABLE public.workflow_tasks ADD CONSTRAINT workflow_tasks_action_index_check CHECK (action_index BETWEEN 0 AND 199);

-- ---------------------------------------------------------------------------
-- Notify and task, with the facts as read now (a timer) or as recorded on the run
-- ---------------------------------------------------------------------------
DROP FUNCTION app.system_workflow_notify(uuid, integer, jsonb, text);
CREATE FUNCTION app.system_workflow_notify(p_run uuid, p_action_index integer, p_recipients jsonb, p_message text, p_facts jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  w public.workflow_runs%ROWTYPE; f jsonb; v_perm text; v_name text; u uuid; v_told integer := 0; v_skipped integer := 0;
BEGIN
  SELECT * INTO w FROM public.workflow_runs WHERE id = p_run;
  IF NOT FOUND THEN RAISE EXCEPTION 'Run not found' USING ERRCODE = 'P0002'; END IF;
  f := coalesce(p_facts, w.facts);
  SELECT t.permission INTO v_perm FROM app.workflow_triggers() t WHERE t.event_type = w.event_type;
  SELECT r.name INTO v_name FROM public.workflow_rules r WHERE r.id = w.rule_id;
  IF jsonb_typeof(p_recipients) <> 'array' THEN RAISE EXCEPTION 'Recipients are a list' USING ERRCODE = '22023'; END IF;
  FOR u IN SELECT DISTINCT x FROM jsonb_array_elements(p_recipients) e(entry), app.workflow_recipient_users(w.organisation_id, e.entry, f) x LOOP
    IF app.workflow_may_tell(w.organisation_id, u, v_perm, (f ->> 'site_id')::uuid) THEN
      INSERT INTO public.workflow_notices (organisation_id, run_id, action_index, user_id, rule_name, message, record_kind, record_id, record_label)
      VALUES (w.organisation_id, w.id, p_action_index, u, v_name, left(coalesce(nullif(btrim(p_message), ''), v_name), 1000),
              coalesce(f ->> 'record_kind', w.entity_type), coalesce((f ->> 'record_id')::uuid, w.entity_id), left(coalesce(f ->> 'label', w.entity_type), 300))
      ON CONFLICT ON CONSTRAINT workflow_notices_once DO NOTHING;
      IF FOUND THEN v_told := v_told + 1; END IF;
    ELSE
      v_skipped := v_skipped + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('told', v_told, 'skipped', v_skipped);
END $$;

DROP FUNCTION app.system_workflow_task(uuid, integer, jsonb, text, text, integer);
CREATE FUNCTION app.system_workflow_task(p_run uuid, p_action_index integer, p_assignee jsonb, p_title text, p_detail text, p_due_days integer, p_facts jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  w public.workflow_runs%ROWTYPE; f jsonb; v_perm text; v_user uuid; v_year integer; v_n integer; v_id uuid; v_ref text; v_zone text;
BEGIN
  SELECT * INTO w FROM public.workflow_runs WHERE id = p_run;
  IF NOT FOUND THEN RAISE EXCEPTION 'Run not found' USING ERRCODE = 'P0002'; END IF;
  f := coalesce(p_facts, w.facts);
  SELECT id, reference INTO v_id, v_ref FROM public.workflow_tasks WHERE run_id = w.id AND action_index = p_action_index;
  IF v_id IS NOT NULL THEN RETURN jsonb_build_object('taskId', v_id, 'reference', v_ref, 'created', false); END IF;
  SELECT t.permission INTO v_perm FROM app.workflow_triggers() t WHERE t.event_type = w.event_type;
  IF p_assignee ->> 'kind' NOT IN ('person', 'record_owner') THEN RAISE EXCEPTION 'A task goes to one person or the record''s owner' USING ERRCODE = '22023'; END IF;
  SELECT x INTO v_user FROM app.workflow_recipient_users(w.organisation_id, p_assignee, f) x LIMIT 1;
  IF v_user IS NULL OR NOT app.workflow_may_tell(w.organisation_id, v_user, v_perm, (f ->> 'site_id')::uuid) THEN
    RETURN jsonb_build_object('created', false, 'skipped', 'Nobody who may read the record to give it to');
  END IF;
  v_zone := app.organisation_time_zone(w.organisation_id);
  v_year := extract(year FROM (now() AT TIME ZONE v_zone))::int % 100;
  INSERT INTO app.workflow_task_counters AS c (organisation_id, year, last_value) VALUES (w.organisation_id, v_year, 1)
  ON CONFLICT (organisation_id, year) DO UPDATE SET last_value = c.last_value + 1 RETURNING last_value INTO v_n;
  v_ref := 'TSK-' || lpad(v_year::text, 2, '0') || '-' || app.pad_number(v_n, 4);
  INSERT INTO public.workflow_tasks (organisation_id, reference, run_id, action_index, rule_id, rule_name, title, detail, record_kind, record_id, record_label, site_id, permission,
                                     assignee_user_id, due_on)
  VALUES (w.organisation_id, v_ref, w.id, p_action_index, w.rule_id, (SELECT r.name FROM public.workflow_rules r WHERE r.id = w.rule_id),
          left(coalesce(nullif(btrim(p_title), ''), 'Follow up'), 200), nullif(left(btrim(coalesce(p_detail, '')), 2000), ''),
          coalesce(f ->> 'record_kind', w.entity_type), coalesce((f ->> 'record_id')::uuid, w.entity_id), left(coalesce(f ->> 'label', w.entity_type), 300),
          (f ->> 'site_id')::uuid, v_perm, v_user,
          CASE WHEN p_due_days IS NULL THEN NULL ELSE (now() AT TIME ZONE v_zone)::date + least(greatest(p_due_days, 0), 365) END)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('taskId', v_id, 'reference', v_ref, 'created', true);
END $$;

-- ---------------------------------------------------------------------------
-- Timers: the record as it is now
-- ---------------------------------------------------------------------------
-- When a timer runs: is the rule still on, and what does the record say now? {active, reason?, eventType, facts} (facts null when the record is gone).
CREATE FUNCTION app.system_workflow_timer_facts(p_run uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE w public.workflow_runs%ROWTYPE; v_status text; v_payload jsonb;
BEGIN
  SELECT * INTO w FROM public.workflow_runs WHERE id = p_run;
  IF NOT FOUND THEN RAISE EXCEPTION 'Run not found' USING ERRCODE = 'P0002'; END IF;
  SELECT r.status INTO v_status FROM public.workflow_rules r WHERE r.id = w.rule_id;
  IF v_status <> 'active' THEN
    RETURN jsonb_build_object('active', false, 'reason', 'The rule is ' || v_status || ' now', 'eventType', w.event_type, 'facts', NULL);
  END IF;
  SELECT o.payload INTO v_payload FROM public.outbox_events o WHERE o.id = w.event_id;
  RETURN jsonb_build_object('active', true, 'eventType', w.event_type,
    'facts', app.system_workflow_facts(w.organisation_id, w.entity_type, w.entity_id, coalesce(v_payload, '{}'::jsonb)));
END $$;

-- ---------------------------------------------------------------------------
-- Hold the lot, with the authority of the person who saved the rule version
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.system_workflow_hold_lot(p_run uuid, p_action_index integer, p_reason text, p_facts jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  w public.workflow_runs%ROWTYPE; f jsonb; v_saver uuid; v_name text; v_perm text; v_lot uuid; lt public.lots%ROWTYPE; v_ok boolean;
  v_claims text := coalesce(current_setting('request.jwt.claims', true), ''); v_reason text; v_refusal text;
BEGIN
  SELECT * INTO w FROM public.workflow_runs WHERE id = p_run;
  IF NOT FOUND THEN RAISE EXCEPTION 'Run not found' USING ERRCODE = 'P0002'; END IF;
  f := coalesce(p_facts, w.facts);
  SELECT v.created_by INTO v_saver FROM public.workflow_rule_versions v WHERE v.id = w.rule_version_id;
  SELECT r.name INTO v_name FROM public.workflow_rules r WHERE r.id = w.rule_id;
  SELECT t.permission INTO v_perm FROM app.workflow_triggers() t WHERE t.event_type = w.event_type;
  v_reason := left(coalesce(nullif(btrim(p_reason), ''), 'Held by a workflow rule') || ' (' || v_name || ')', 1000);

  IF f ->> 'record_kind' = 'nonconformance' THEN
    SELECT n.lot_id INTO v_lot FROM public.nonconformances n WHERE n.id = (f ->> 'record_id')::uuid AND n.organisation_id = w.organisation_id;
  ELSIF f ->> 'record_kind' = 'inspection' THEN
    SELECT i.lot_id INTO v_lot FROM public.inspection_records i WHERE i.id = (f ->> 'record_id')::uuid AND i.organisation_id = w.organisation_id;
  END IF;
  IF v_lot IS NULL THEN RETURN jsonb_build_object('held', false, 'skipped', 'The record names no lot'); END IF;
  SELECT * INTO lt FROM public.lots WHERE id = v_lot AND organisation_id = w.organisation_id FOR UPDATE;
  IF lt.status = 'on_hold' THEN RETURN jsonb_build_object('held', false, 'lot', lt.lot_number, 'skipped', 'The lot is already on hold'); END IF;
  IF lt.status = 'closed' THEN RETURN jsonb_build_object('held', false, 'lot', lt.lot_number, 'skipped', 'The lot is closed'); END IF;

  -- Act as the person who saved this version of the rule (W7).
  IF v_saver IS NULL THEN
    v_refusal := 'Nobody is recorded as having saved this version of the rule';
  ELSE
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_saver, 'role', 'authenticated', 'aal', 'aal2')::text, true);
    v_ok := app.is_member(w.organisation_id) AND app.has_permission(w.organisation_id, 'production.manage', lt.site_id);
    IF NOT coalesce(v_ok, false) THEN
      v_refusal := 'The person who saved this version of the rule may no longer put lots on hold here';
    ELSE
      BEGIN
        UPDATE public.lots SET status = 'on_hold', status_reason = v_reason, updated_at = now(), updated_by = v_saver WHERE id = lt.id;
      EXCEPTION WHEN OTHERS THEN
        v_refusal := SQLERRM;
      END;
    END IF;
    PERFORM set_config('request.jwt.claims', v_claims, true);
  END IF;

  IF v_refusal IS NOT NULL THEN
    -- Tell the person whose authority it needed, when they may read the record.
    IF v_saver IS NOT NULL AND app.workflow_may_tell(w.organisation_id, v_saver, v_perm, (f ->> 'site_id')::uuid) THEN
      INSERT INTO public.workflow_notices (organisation_id, run_id, action_index, user_id, rule_name, message, record_kind, record_id, record_label)
      VALUES (w.organisation_id, w.id, p_action_index, v_saver, v_name, left('Lot ' || lt.lot_number || ' was not put on hold: ' || v_refusal, 1000),
              coalesce(f ->> 'record_kind', w.entity_type), coalesce((f ->> 'record_id')::uuid, w.entity_id), left(coalesce(f ->> 'label', w.entity_type), 300))
      ON CONFLICT ON CONSTRAINT workflow_notices_once DO NOTHING;
    END IF;
    RETURN jsonb_build_object('held', false, 'lot', lt.lot_number, 'refused', v_refusal);
  END IF;
  RETURN jsonb_build_object('held', true, 'lot', lt.lot_number, 'lotId', lt.id);
END $$;

REVOKE ALL ON FUNCTION app.system_workflow_notify(uuid, integer, jsonb, text, jsonb), app.system_workflow_task(uuid, integer, jsonb, text, text, integer, jsonb),
  app.system_workflow_timer_facts(uuid), app.system_workflow_hold_lot(uuid, integer, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.system_workflow_notify(uuid, integer, jsonb, text, jsonb), app.system_workflow_task(uuid, integer, jsonb, text, text, integer, jsonb),
  app.system_workflow_timer_facts(uuid), app.system_workflow_hold_lot(uuid, integer, text, jsonb) TO qms_api;
