-- Workflow rules WF2 (docs/workflow-engine-plan.md §5, decision W8): test a rule against a recent event before saving it. Nothing is written.
--
--  * app.workflow_recent_events(org, trigger, limit): the latest events of that kind (90 days) whose record the caller may read, with the facts a rule would test
--    (read as the record is now, the same as when a rule runs). workflows.manage.
--  * app.workflow_preview_people(org, event, actions): for each action, the people it would reach for that event and whether each may be told (an active member
--    holding the trigger's permission at the record's site, checked as that person — the same rule the worker applies). A task names its first person only.
--    workflows.manage; the caller must be able to read the record. The conditions are evaluated by the API with the same code the worker uses.

CREATE FUNCTION app.workflow_recent_events(p_organisation_id uuid, p_event_type text, p_limit integer DEFAULT 20)
RETURNS TABLE (event_id bigint, created_at timestamptz, facts jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_perm text; v_entity text; e record; v_facts jsonb; v_n integer := 0; v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
BEGIN
  IF NOT app.has_permission(p_organisation_id, 'workflows.manage') THEN RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501'; END IF;
  SELECT t.permission, t.entity_type INTO v_perm, v_entity FROM app.workflow_triggers() t WHERE t.event_type = p_event_type;
  IF NOT FOUND THEN RAISE EXCEPTION 'Choose what starts the rule' USING ERRCODE = 'QM028'; END IF;
  FOR e IN
    SELECT o.id, o.entity_id, o.payload, o.created_at FROM public.outbox_events o
     WHERE o.organisation_id = p_organisation_id AND o.event_type = p_event_type AND o.created_at > now() - interval '90 days'
     ORDER BY o.id DESC LIMIT 200
  LOOP
    v_facts := app.system_workflow_facts(p_organisation_id, v_entity, e.entity_id, coalesce(e.payload, '{}'::jsonb));
    CONTINUE WHEN v_facts IS NULL OR NOT app.has_permission(p_organisation_id, v_perm, (v_facts ->> 'site_id')::uuid);
    event_id := e.id; created_at := e.created_at; facts := v_facts;
    RETURN NEXT;
    v_n := v_n + 1;
    EXIT WHEN v_n >= v_limit;
  END LOOP;
END $$;

CREATE FUNCTION app.workflow_preview_people(p_organisation_id uuid, p_event_id bigint, p_actions jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  o public.outbox_events%ROWTYPE; v_perm text; v_entity text; v_facts jsonb; v_site uuid; a jsonb; v_index integer := 0; v_entries jsonb;
  v_people jsonb; v_out jsonb := '[]'::jsonb; u uuid; v_name text; v_told boolean; v_count integer;
BEGIN
  IF NOT app.has_permission(p_organisation_id, 'workflows.manage') THEN RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501'; END IF;
  IF jsonb_typeof(p_actions) <> 'array' THEN RAISE EXCEPTION 'Actions are a list' USING ERRCODE = '22023'; END IF;
  SELECT * INTO o FROM public.outbox_events WHERE id = p_event_id AND organisation_id = p_organisation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Event not found' USING ERRCODE = 'P0002'; END IF;
  SELECT t.permission, t.entity_type INTO v_perm, v_entity FROM app.workflow_triggers() t WHERE t.event_type = o.event_type;
  IF NOT FOUND THEN RAISE EXCEPTION 'Event not found' USING ERRCODE = 'P0002'; END IF;
  v_facts := app.system_workflow_facts(p_organisation_id, v_entity, o.entity_id, coalesce(o.payload, '{}'::jsonb));
  IF v_facts IS NULL THEN RAISE EXCEPTION 'The record behind this event is gone' USING ERRCODE = 'P0002'; END IF;
  v_site := (v_facts ->> 'site_id')::uuid;
  IF NOT app.has_permission(p_organisation_id, v_perm, v_site) THEN RAISE EXCEPTION 'Event not found' USING ERRCODE = 'P0002'; END IF;

  FOR a IN SELECT x FROM jsonb_array_elements(p_actions) x LOOP
    v_entries := CASE WHEN a ->> 'type' = 'task' THEN jsonb_build_array(a -> 'assignee') ELSE coalesce(a -> 'recipients', '[]'::jsonb) END;
    IF jsonb_typeof(v_entries) <> 'array' THEN v_entries := '[]'::jsonb; END IF;
    v_people := '[]'::jsonb;
    v_count := 0;
    FOR u IN
      SELECT DISTINCT x FROM jsonb_array_elements(v_entries) e(entry), app.workflow_recipient_users(p_organisation_id, e.entry, v_facts) x
       WHERE x IS NOT NULL
    LOOP
      v_count := v_count + 1;
      CONTINUE WHEN v_count > 50;
      SELECT coalesce(nullif(trim(concat_ws(' ', p.first_name, p.surname)), ''), 'Someone') INTO v_name FROM public.profiles p WHERE p.id = u;
      v_told := app.workflow_may_tell(p_organisation_id, u, v_perm, v_site);
      v_people := v_people || jsonb_build_object('userId', u, 'name', coalesce(v_name, 'Someone'), 'told', v_told);
      EXIT WHEN a ->> 'type' = 'task';
    END LOOP;
    v_out := v_out || jsonb_build_object('index', v_index, 'type', a ->> 'type', 'people', v_people, 'total', CASE WHEN a ->> 'type' = 'task' THEN least(v_count, 1) ELSE v_count END);
    v_index := v_index + 1;
  END LOOP;
  RETURN jsonb_build_object('eventId', o.id, 'eventType', o.event_type, 'createdAt', o.created_at, 'facts', v_facts, 'actions', v_out);
END $$;

REVOKE ALL ON FUNCTION app.workflow_recent_events(uuid, text, integer), app.workflow_preview_people(uuid, bigint, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.workflow_recent_events(uuid, text, integer), app.workflow_preview_people(uuid, bigint, jsonb) TO authenticated;
