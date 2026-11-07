-- CAPA6 (docs/capa-8d-plan.md §10): a completed step is read-only until it is reopened, and actions are given to a person who works them.
--
--  * Locks (amends decision C5, "nothing locks"): while a step is complete, what belongs to it cannot change. Reopen the step first (with a reason), as for the
--    8D itself. D0: the initiation details and the linked non-conformances. D1: the team. D2: the 5W2H and the Is / Is-Not. D3: containment actions and the
--    "no containment" reason. D4: root causes, Ishikawa and 5 Whys. D5: the corrective action plan (what, why, who). D6: carrying out and closing corrective
--    actions, and verifications. D7: preventive actions, the "no preventive action" reason and the lessons learned. Who and when can still be changed while the
--    plan step OR the doing step of an action is open (reassigning during implementation). Enforced by triggers, so it holds for every caller.
--  * Actions are actionable: managers (capa.manage) write the action and assign it to a team member (the actionee); the actionee, with capa.read only, can update
--    the findings and close the action (and reopen it), but cannot change what it is, who has it or when it is due. Closing needs the findings written.
--  * The actionee gets an in-app notice when an action is assigned to them (event types capa_actions.created and .updated, the latter only for a reassignment).

CREATE FUNCTION app.capa_step_complete(p_capa uuid, p_step text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.capa_steps WHERE capa_id = p_capa AND step = p_step AND completed_at IS NOT NULL)
$$;

CREATE FUNCTION app.assert_capa_step_open(p_capa uuid, p_step text, p_what text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF app.capa_step_complete(p_capa, p_step) THEN
    RAISE EXCEPTION '% is complete; reopen it to change %', upper(p_step), p_what USING ERRCODE = 'QM013';
  END IF;
END $$;

-- The 8D itself: initiation details (D0), 5W2H (D2), containment reason (D3), prevention (D7).
CREATE FUNCTION app.capa_header_step_lock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF (NEW.title, NEW.problem_statement, NEW.source, NEW.severity, NEW.external_reference, NEW.owner_membership_id, NEW.due_date)
     IS DISTINCT FROM (OLD.title, OLD.problem_statement, OLD.source, OLD.severity, OLD.external_reference, OLD.owner_membership_id, OLD.due_date) THEN
    PERFORM app.assert_capa_step_open(NEW.id, 'd0', 'the initiation details');
  END IF;
  IF (NEW.d2_who, NEW.d2_what, NEW.d2_where, NEW.d2_when, NEW.d2_why, NEW.d2_how, NEW.d2_how_many)
     IS DISTINCT FROM (OLD.d2_who, OLD.d2_what, OLD.d2_where, OLD.d2_when, OLD.d2_why, OLD.d2_how, OLD.d2_how_many) THEN
    PERFORM app.assert_capa_step_open(NEW.id, 'd2', 'the problem description');
  END IF;
  IF NEW.d3_no_containment_reason IS DISTINCT FROM OLD.d3_no_containment_reason THEN
    PERFORM app.assert_capa_step_open(NEW.id, 'd3', 'the containment');
  END IF;
  IF (NEW.d7_lessons_learned, NEW.d7_no_preventive_reason) IS DISTINCT FROM (OLD.d7_lessons_learned, OLD.d7_no_preventive_reason) THEN
    PERFORM app.assert_capa_step_open(NEW.id, 'd7', 'the prevention');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER capas_step_lock BEFORE UPDATE ON public.capas FOR EACH ROW EXECUTE FUNCTION app.capa_header_step_lock();

CREATE FUNCTION app.capa_team_step_lock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.assert_capa_step_open(NEW.capa_id, 'd1', 'the team');
  RETURN NEW;
END $$;
CREATE TRIGGER capa_team_members_step_lock BEFORE INSERT OR UPDATE ON public.capa_team_members FOR EACH ROW EXECUTE FUNCTION app.capa_team_step_lock();

CREATE FUNCTION app.capa_link_step_lock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.assert_capa_step_open(NEW.capa_id, 'd0', 'the linked non-conformances');
  RETURN NEW;
END $$;
CREATE TRIGGER capa_ncr_links_step_lock BEFORE INSERT OR UPDATE ON public.capa_ncr_links FOR EACH ROW EXECUTE FUNCTION app.capa_link_step_lock();

-- Analyses belong to the step they are stored under (D2 for Is / Is-Not, D4 for Ishikawa and 5 Whys).
CREATE FUNCTION app.capa_analysis_step_lock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.assert_capa_step_open(NEW.capa_id, NEW.step, 'its analyses');
  RETURN NEW;
END $$;
CREATE TRIGGER capa_analyses_step_lock BEFORE INSERT OR UPDATE ON public.capa_analyses FOR EACH ROW EXECUTE FUNCTION app.capa_analysis_step_lock();

CREATE FUNCTION app.capa_root_cause_step_lock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.assert_capa_step_open(NEW.capa_id, 'd4', 'the root causes');
  RETURN NEW;
END $$;
CREATE TRIGGER capa_root_causes_step_lock BEFORE INSERT OR UPDATE ON public.capa_root_causes FOR EACH ROW EXECUTE FUNCTION app.capa_root_cause_step_lock();

-- An effective verification is recorded while D6 is open; a failed one is always accepted (it reopens D5 and D6).
CREATE FUNCTION app.capa_verification_step_lock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.effective THEN
    PERFORM app.assert_capa_step_open(NEW.capa_id, 'd6', 'the verification');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER capa_verifications_step_lock BEFORE INSERT ON public.capa_verifications FOR EACH ROW EXECUTE FUNCTION app.capa_verification_step_lock();

-- Actions: the planning step guards what the action is (and, for a new one, that it exists); the doing step guards findings, closing and cancelling.
-- interim: D3 for both; corrective: plan D5, doing D6; preventive: D7 for both. A non-manager (the actionee) may only write findings and close or reopen.
CREATE FUNCTION app.capa_action_step_lock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_plan text := CASE NEW.phase WHEN 'interim' THEN 'd3' WHEN 'corrective' THEN 'd5' ELSE 'd7' END;
        v_doing text := CASE NEW.phase WHEN 'interim' THEN 'd3' WHEN 'corrective' THEN 'd6' ELSE 'd7' END;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM app.assert_capa_step_open(NEW.capa_id, v_plan, 'the actions');
    RETURN NEW;
  END IF;
  IF auth.uid() IS NOT NULL AND NOT app.has_permission(NEW.organisation_id, 'capa.manage') THEN
    IF (NEW.description, NEW.root_cause_id, NEW.owner_team_member_id, NEW.due_date) IS DISTINCT FROM (OLD.description, OLD.root_cause_id, OLD.owner_team_member_id, OLD.due_date) THEN
      RAISE EXCEPTION 'Only people who manage 8Ds can change what an action is, who has it or when it is due' USING ERRCODE = 'QM013';
    END IF;
    IF NEW.status = 'cancelled' OR OLD.status = 'cancelled' THEN
      RAISE EXCEPTION 'Only people who manage 8Ds can cancel an action or bring a cancelled one back' USING ERRCODE = 'QM013';
    END IF;
  END IF;
  IF (NEW.description, NEW.root_cause_id) IS DISTINCT FROM (OLD.description, OLD.root_cause_id) THEN
    PERFORM app.assert_capa_step_open(NEW.capa_id, v_plan, 'the actions');
  END IF;
  IF (NEW.owner_team_member_id, NEW.due_date) IS DISTINCT FROM (OLD.owner_team_member_id, OLD.due_date)
     AND app.capa_step_complete(NEW.capa_id, v_plan) THEN
    PERFORM app.assert_capa_step_open(NEW.capa_id, v_doing, 'who has an action or when it is due');
  END IF;
  IF (NEW.status, NEW.evidence_note, NEW.cancel_reason) IS DISTINCT FROM (OLD.status, OLD.evidence_note, OLD.cancel_reason) THEN
    PERFORM app.assert_capa_step_open(NEW.capa_id, v_doing, 'the actions');
  END IF;
  IF NEW.status = 'done' AND OLD.status IS DISTINCT FROM 'done' AND nullif(btrim(coalesce(NEW.evidence_note, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Write what was done and found before closing the action' USING ERRCODE = 'QM013';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER capa_actions_step_lock BEFORE INSERT OR UPDATE ON public.capa_actions FOR EACH ROW EXECUTE FUNCTION app.capa_action_step_lock();

-- The actionee: the person an action is assigned to (an active member on the team of the 8D) may update and close it.
CREATE FUNCTION app.is_capa_action_assignee(p_action uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.capa_actions a
      JOIN public.capa_team_members t ON t.id = a.owner_team_member_id AND t.ended_at IS NULL
      JOIN public.organisation_users m ON m.id = t.membership_id AND m.status = 'active'
     WHERE a.id = p_action AND m.user_id = auth.uid() AND app.has_permission(a.organisation_id, 'capa.read'))
$$;
CREATE POLICY capa_actions_update_assignee ON public.capa_actions FOR UPDATE TO authenticated
  USING (app.is_capa_action_assignee(id)) WITH CHECK (app.is_capa_action_assignee(id));

-- ---------------------------------------------------------------------------
-- Notices for the actionee
-- ---------------------------------------------------------------------------
INSERT INTO public.notification_event_types
  (key, entity_type, action, group_name, entity_label, description, permission_code, default_on, default_permission_code, label_fields, display_order)
VALUES
  ('capa_actions.created', 'capa_actions', 'created', 'Corrective actions', '8D action', '8D action assigned to you', 'capa.read', true, NULL,
   ARRAY['capa_reference', 'capa_title', 'description'], 90),
  ('capa_actions.updated', 'capa_actions', 'updated', 'Corrective actions', '8D action', '8D action assigned to you', 'capa.read', true, NULL,
   ARRAY['capa_reference', 'capa_title', 'description'], 90);

CREATE OR REPLACE FUNCTION app.emit_notification() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_action text;
  v_type public.notification_event_types%ROWTYPE;
  v_row jsonb := coalesce(NEW.new_values, NEW.previous_values);
  v_what text;
  v_body text;
  v_details jsonb;
  v_recipient uuid;
  v_capa_row jsonb;
BEGIN
  -- A recipient row also changes when they view or acknowledge: only the withdrawal notice is worth a notification.
  IF NEW.entity_type = 'quality_alert_recipients' AND NEW.action = 'update' AND NOT (coalesce(NEW.changed_fields, '{}') @> ARRAY['withdrawn_notified_at']) THEN
    RETURN NULL;
  END IF;

  -- An 8D action notifies the person it is assigned to, when it is added with someone on it or handed to someone else; nothing else about it does.
  IF NEW.entity_type = 'capa_actions' AND (NEW.action = 'delete' OR (NEW.action = 'update' AND NOT (coalesce(NEW.changed_fields, '{}') @> ARRAY['owner_team_member_id']))) THEN
    RETURN NULL;
  END IF;

  v_action := CASE
    WHEN NEW.action = 'insert' THEN 'created'
    WHEN NEW.action = 'delete' THEN 'deleted'
    WHEN NEW.changed_fields @> ARRAY['deleted_at'] AND NEW.new_values ->> 'deleted_at' IS NOT NULL THEN 'deleted'
    ELSE 'updated' END;

  SELECT * INTO v_type FROM public.notification_event_types t WHERE t.entity_type = NEW.entity_type AND t.action = v_action;
  IF NOT FOUND THEN RETURN NULL; END IF;

  v_row := coalesce(NEW.previous_values, '{}'::jsonb) || coalesce(NEW.new_values, '{}'::jsonb);
  IF NEW.action = 'insert' THEN v_row := NEW.new_values; END IF;
  IF NEW.action = 'delete' THEN v_row := NEW.previous_values; END IF;
  -- An update records only what changed; a recipient notice needs the person and the alert too.
  IF NEW.entity_type = 'quality_alert_recipients' AND NEW.action = 'update' THEN
    v_row := coalesce((SELECT to_jsonb(r) FROM public.quality_alert_recipients r WHERE r.id = NEW.entity_id::uuid), '{}'::jsonb) || v_row;
  END IF;

  IF NEW.entity_type = 'capa_actions' THEN
    SELECT to_jsonb(a) || jsonb_build_object('capa_reference', c.reference, 'capa_title', c.title, 'user_id', m.user_id)
      INTO v_capa_row
      FROM public.capa_actions a
      JOIN public.capas c ON c.id = a.capa_id
      LEFT JOIN public.capa_team_members t ON t.id = a.owner_team_member_id
      LEFT JOIN public.organisation_users m ON m.id = t.membership_id
     WHERE a.id = NEW.entity_id::uuid;
    IF v_capa_row IS NULL OR v_capa_row ->> 'user_id' IS NULL THEN RETURN NULL; END IF;
    v_row := v_capa_row;
  END IF;

  v_body := nullif(concat_ws(' — ', VARIADIC (
    SELECT coalesce(array_agg(nullif(v_row ->> f, '') ORDER BY ord), '{}') FROM unnest(v_type.label_fields) WITH ORDINALITY AS u(f, ord))), '');
  IF v_action = 'updated' AND NEW.changed_fields IS NOT NULL AND NEW.entity_type NOT IN ('quality_alert_recipients', 'capa_actions') THEN
    v_what := 'Changed: ' || replace(array_to_string(NEW.changed_fields, ', '), '_', ' ');
    v_body := concat_ws('. ', v_body, left(v_what, 200));
  END IF;

  SELECT coalesce(jsonb_object_agg(k, v_row -> k), '{}'::jsonb) INTO v_details
    FROM unnest(ARRAY['site_id', 'gauge_id', 'control_plan_id', 'part_id', 'source', 'stage', 'status', 'alert_id', 'capa_id']) k
   WHERE v_row ->> k IS NOT NULL;

  -- Notices about one person's own alerts are for that person only.
  IF NEW.entity_type IN ('quality_alert_recipients', 'capa_actions') THEN v_recipient := (v_row ->> 'user_id')::uuid; END IF;

  INSERT INTO public.notifications (organisation_id, event_type_id, audit_event_id, entity_type, entity_id, title, body, details, actor_user_id, recipient_user_id)
  VALUES (NEW.organisation_id, v_type.id, NEW.id, NEW.entity_type, NEW.entity_id, v_type.description, v_body, v_details, NEW.actor_user_id, v_recipient)
  ON CONFLICT (audit_event_id) DO NOTHING;
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION app.capa_step_complete(uuid, text), app.assert_capa_step_open(uuid, text, text), app.capa_header_step_lock(), app.capa_team_step_lock(),
  app.capa_link_step_lock(), app.capa_analysis_step_lock(), app.capa_root_cause_step_lock(), app.capa_verification_step_lock(), app.capa_action_step_lock(),
  app.is_capa_action_assignee(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.is_capa_action_assignee(uuid) TO authenticated;
