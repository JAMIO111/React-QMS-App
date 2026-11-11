-- Merge the notification functions of two migrations written in parallel (docs/email-oauth-plan.md).
--
-- `20260130100000_competence_notice.sql` (event types gain `own_record`; the person assessed is told) and
-- `20260131200000_email_notifications.sql` (email choices, import alerts) both replaced app.emit_notification, list_notification_preferences and
-- set_notification_preference. They were applied live in that order, so the email versions had dropped the competence branch:
-- "You were assessed" notices were no longer written and an own-record event was not offered to people without the module permission.
-- This puts both together; nothing else changes:
-- * emit_notification = the competence version + the email migration's details keys (connection_id, run_id, kind) and no actor on import alerts;
-- * list_notification_preferences, set_notification_preference and set_notification_email offer own-record events to every member;
-- * "You were assessed" is emailed by default (it is addressed to one person, like the other personal notices).
-- app.notification_can_see already has the competence version (the email migration left it alone).

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
  v_comp_row jsonb;
BEGIN
  -- A recipient row also changes when they view or acknowledge: only the withdrawal notice is worth a notification.
  IF NEW.entity_type = 'quality_alert_recipients' AND NEW.action = 'update' AND NOT (coalesce(NEW.changed_fields, '{}') @> ARRAY['withdrawn_notified_at']) THEN
    RETURN NULL;
  END IF;

  -- An 8D action notifies the person it is assigned to, when it is added with someone on it or handed to someone else; nothing else about it does.
  IF NEW.entity_type = 'capa_actions' AND (NEW.action = 'delete' OR (NEW.action = 'update' AND NOT (coalesce(NEW.changed_fields, '{}') @> ARRAY['owner_team_member_id']))) THEN
    RETURN NULL;
  END IF;

  -- An assessment is announced once, when it is made; superseding the earlier one is not news.
  IF NEW.entity_type = 'competence_assessments' AND NEW.action <> 'insert' THEN
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

  -- An assessment tells the person assessed (their linked sign-in) the skill and the level; nobody else, and no one without a sign-in.
  IF NEW.entity_type = 'competence_assessments' THEN
    SELECT to_jsonb(a) || jsonb_build_object(
             'user_id', e.auth_id, 'skill_name', k.name,
             'level_label', CASE a.level WHEN 0 THEN 'None' WHEN 1 THEN 'Learning' WHEN 2 THEN 'Supervised' WHEN 3 THEN 'Competent' ELSE 'Can train others' END || ' (' || a.level || ')')
      INTO v_comp_row
      FROM public.competence_assessments a
      JOIN public."Employees" e ON e.id = a.employee_id AND e.organisation_id = a.organisation_id
      JOIN public.competence_skills k ON k.id = a.skill_id
     WHERE a.id = NEW.entity_id::uuid;
    IF v_comp_row IS NULL OR v_comp_row ->> 'user_id' IS NULL THEN RETURN NULL; END IF;
    v_row := v_comp_row;
  END IF;

  v_body := nullif(concat_ws(' — ', VARIADIC (
    SELECT coalesce(array_agg(nullif(v_row ->> f, '') ORDER BY ord), '{}') FROM unnest(v_type.label_fields) WITH ORDINALITY AS u(f, ord))), '');
  IF v_action = 'updated' AND NEW.changed_fields IS NOT NULL AND NEW.entity_type NOT IN ('quality_alert_recipients', 'capa_actions', 'competence_assessments') THEN
    v_what := 'Changed: ' || replace(array_to_string(NEW.changed_fields, ', '), '_', ' ');
    v_body := concat_ws('. ', v_body, left(v_what, 200));
  END IF;

  SELECT coalesce(jsonb_object_agg(k, v_row -> k), '{}'::jsonb) INTO v_details
    FROM unnest(ARRAY['site_id', 'gauge_id', 'control_plan_id', 'part_id', 'source', 'stage', 'status', 'alert_id', 'capa_id', 'connection_id', 'run_id', 'kind']) k
   WHERE v_row ->> k IS NOT NULL;

  -- Notices about one person's own alerts are for that person only.
  IF NEW.entity_type IN ('quality_alert_recipients', 'capa_actions', 'competence_assessments') THEN v_recipient := (v_row ->> 'user_id')::uuid; END IF;

  INSERT INTO public.notifications (organisation_id, event_type_id, audit_event_id, entity_type, entity_id, title, body, details, actor_user_id, recipient_user_id)
  VALUES (NEW.organisation_id, v_type.id, NEW.id, NEW.entity_type, NEW.entity_id, v_type.description, v_body, v_details,
          CASE WHEN NEW.entity_type = 'integration_alerts' THEN NULL ELSE NEW.actor_user_id END, v_recipient)
  ON CONFLICT (audit_event_id) DO NOTHING;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION app.list_notification_preferences(p_organisation_id uuid)
RETURNS TABLE (key text, group_name text, entity_label text, action text, description text,
               enabled boolean, default_enabled boolean, overridden boolean, display_order integer,
               email boolean, email_default boolean, email_overridden boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT t.key, t.group_name, t.entity_label, t.action, t.description,
         app.notification_wanted(p_organisation_id, t.id),
         t.default_on AND (t.default_permission_code IS NULL OR app.has_permission_somewhere(p_organisation_id, t.default_permission_code)),
         p.enabled IS NOT NULL,
         t.display_order,
         app.notification_email_wanted(p_organisation_id, t.id),
         t.email_default,
         p.email IS NOT NULL
  FROM public.notification_event_types t
  LEFT JOIN public.notification_preferences p ON p.organisation_id = p_organisation_id AND p.user_id = auth.uid() AND p.event_type_id = t.id
  WHERE app.is_member(p_organisation_id) AND (t.own_record OR app.has_permission_somewhere(p_organisation_id, t.permission_code))
  ORDER BY t.display_order, t.action
$$;

CREATE OR REPLACE FUNCTION app.set_notification_preference(p_organisation_id uuid, p_event_key text, p_enabled boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_type public.notification_event_types%ROWTYPE;
BEGIN
  IF NOT app.is_member(p_organisation_id) THEN
    RAISE EXCEPTION 'Not a member of this organisation' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_type FROM public.notification_event_types WHERE key = p_event_key;
  IF NOT FOUND OR NOT (v_type.own_record OR app.has_permission_somewhere(p_organisation_id, v_type.permission_code)) THEN
    RAISE EXCEPTION 'Unknown notification type' USING ERRCODE = 'QM010';
  END IF;
  IF p_enabled IS NULL THEN
    UPDATE public.notification_preferences SET enabled = NULL, updated_at = now()
     WHERE organisation_id = p_organisation_id AND user_id = auth.uid() AND event_type_id = v_type.id AND email IS NOT NULL;
    DELETE FROM public.notification_preferences
     WHERE organisation_id = p_organisation_id AND user_id = auth.uid() AND event_type_id = v_type.id AND email IS NULL;
  ELSE
    INSERT INTO public.notification_preferences (organisation_id, user_id, event_type_id, enabled)
    VALUES (p_organisation_id, auth.uid(), v_type.id, p_enabled)
    ON CONFLICT (organisation_id, user_id, event_type_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now();
  END IF;
END $$;

CREATE OR REPLACE FUNCTION app.set_notification_email(p_organisation_id uuid, p_event_key text, p_email boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_type public.notification_event_types%ROWTYPE;
BEGIN
  IF NOT app.is_member(p_organisation_id) THEN
    RAISE EXCEPTION 'Not a member of this organisation' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_type FROM public.notification_event_types WHERE key = p_event_key;
  IF NOT FOUND OR NOT (v_type.own_record OR app.has_permission_somewhere(p_organisation_id, v_type.permission_code)) THEN
    RAISE EXCEPTION 'Unknown notification type' USING ERRCODE = 'QM010';
  END IF;
  IF p_email IS NULL THEN
    UPDATE public.notification_preferences SET email = NULL, updated_at = now()
     WHERE organisation_id = p_organisation_id AND user_id = auth.uid() AND event_type_id = v_type.id AND enabled IS NOT NULL;
    DELETE FROM public.notification_preferences
     WHERE organisation_id = p_organisation_id AND user_id = auth.uid() AND event_type_id = v_type.id AND enabled IS NULL;
  ELSE
    INSERT INTO public.notification_preferences (organisation_id, user_id, event_type_id, email)
    VALUES (p_organisation_id, auth.uid(), v_type.id, p_email)
    ON CONFLICT (organisation_id, user_id, event_type_id) DO UPDATE SET email = EXCLUDED.email, updated_at = now();
  END IF;
END $$;

UPDATE public.notification_event_types SET email_default = true WHERE key = 'competence_assessments.created';
