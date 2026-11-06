-- Quality alert recipients and acknowledgement (DOC2, docs/documentation-plan.md §7).
--
-- Design
--  * The people an alert must reach are worked out ONCE, when the alert is issued, from its targets (departments → their active
--    members, roles → everyone holding the role, named people), and stored in quality_alert_recipients: the evidence of who was
--    asked. Someone who joins a department later is not added silently; a manager can add a person to an active alert (audited).
--    A revision is a new alert row, so its recipients are resolved afresh and must acknowledge again.
--  * Only the recipient can say they have seen or acknowledged an alert (never on someone's behalf), once, with an optional note.
--    Rows are written only by the functions below; managers (documentation.manage) read all recipients, everyone else only their own.
--  * Notifications: a recipient is told when an alert is addressed to them and when it is withdrawn. The notification mechanism is
--    event-per-row, so notifications gain recipient_user_id: a notice with one is visible to that person only. The person who issued
--    it is not told of their own action, as for every notification.
--  * Errors QM012 → 409 documentation_rule.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.revision_letter(p_revision integer) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v_out text := ''; v_n integer := p_revision;
BEGIN
  WHILE v_n > 0 LOOP
    v_out := chr(65 + ((v_n - 1) % 26)) || v_out;
    v_n := (v_n - 1) / 26;
  END LOOP;
  RETURN v_out;
END $$;

-- ---------------------------------------------------------------------------
-- Recipients
-- ---------------------------------------------------------------------------
CREATE TABLE public.quality_alert_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  alert_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  reached_via text[] NOT NULL CHECK (cardinality(reached_via) >= 1),
  -- What the alert said when it was issued (the alert itself is frozen, but a notice should not need a join).
  alert_reference text NOT NULL,
  alert_title text NOT NULL,
  alert_severity text NOT NULL,
  first_viewed_at timestamptz,
  acknowledged_at timestamptz,
  acknowledgement_note text CHECK (acknowledgement_note IS NULL OR length(btrim(acknowledgement_note)) BETWEEN 1 AND 2000),
  withdrawn_notified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT quality_alert_recipients_alert_fkey FOREIGN KEY (alert_id, organisation_id) REFERENCES public.quality_alerts (id, organisation_id) ON DELETE CASCADE,
  CONSTRAINT quality_alert_recipients_membership_fkey FOREIGN KEY (membership_id, organisation_id) REFERENCES public.organisation_users (id, organisation_id),
  CONSTRAINT quality_alert_recipients_key UNIQUE (alert_id, membership_id),
  CONSTRAINT quality_alert_recipients_ack CHECK (acknowledged_at IS NULL OR first_viewed_at IS NOT NULL),
  CONSTRAINT quality_alert_recipients_note_needs_ack CHECK (acknowledgement_note IS NULL OR acknowledged_at IS NOT NULL)
);
CREATE INDEX quality_alert_recipients_user_idx ON public.quality_alert_recipients (organisation_id, user_id);
CREATE INDEX quality_alert_recipients_open_idx ON public.quality_alert_recipients (alert_id) WHERE acknowledged_at IS NULL;

CREATE FUNCTION app.quality_alert_recipient_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['first_viewed_at', 'acknowledged_at', 'acknowledgement_note', 'withdrawn_notified_at', 'updated_at', 'updated_by'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['first_viewed_at', 'acknowledged_at', 'acknowledgement_note', 'withdrawn_notified_at', 'updated_at', 'updated_by']) THEN
    RAISE EXCEPTION 'Only viewing, acknowledging and withdrawal notices can change a recipient' USING ERRCODE = 'QM012';
  END IF;
  IF OLD.first_viewed_at IS NOT NULL AND NEW.first_viewed_at IS DISTINCT FROM OLD.first_viewed_at THEN
    RAISE EXCEPTION 'The time an alert was first viewed is never changed' USING ERRCODE = 'QM012';
  END IF;
  IF OLD.acknowledged_at IS NOT NULL AND (NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at OR NEW.acknowledgement_note IS DISTINCT FROM OLD.acknowledgement_note) THEN
    RAISE EXCEPTION 'An acknowledgement is never changed' USING ERRCODE = 'QM012';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION app.quality_alert_recipient_no_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'Recipients of a quality alert are never removed' USING ERRCODE = 'QM012';
END $$;

CREATE TRIGGER quality_alert_recipients_stamp BEFORE INSERT ON public.quality_alert_recipients FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER quality_alert_recipients_rules BEFORE UPDATE ON public.quality_alert_recipients FOR EACH ROW EXECUTE FUNCTION app.quality_alert_recipient_rules();
CREATE TRIGGER quality_alert_recipients_touch BEFORE UPDATE ON public.quality_alert_recipients FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER quality_alert_recipients_org_immutable BEFORE UPDATE ON public.quality_alert_recipients FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER quality_alert_recipients_no_delete BEFORE DELETE ON public.quality_alert_recipients FOR EACH ROW EXECUTE FUNCTION app.quality_alert_recipient_no_delete();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.quality_alert_recipients
  FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');

ALTER TABLE public.quality_alert_recipients ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.quality_alert_recipients FROM anon, authenticated;
GRANT SELECT ON public.quality_alert_recipients TO authenticated;
CREATE POLICY quality_alert_recipients_select ON public.quality_alert_recipients FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'documentation.manage')
         OR (user_id = auth.uid() AND app.is_member(organisation_id)));

-- ---------------------------------------------------------------------------
-- Who do the targets reach?
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.resolve_quality_alert_targets(p_alert_id uuid)
RETURNS TABLE (membership_id uuid, user_id uuid, via text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH alert AS (SELECT organisation_id FROM public.quality_alerts WHERE id = p_alert_id),
  hits AS (
    SELECT dm.membership_id, 'Department: ' || d.name AS via
      FROM public.quality_alert_targets t
      JOIN public.department_members dm ON dm.department_id = t.department_id AND dm.ended_at IS NULL
      JOIN public.departments d ON d.id = t.department_id
     WHERE t.alert_id = p_alert_id
    UNION ALL
    SELECT a.membership_id, 'Role: ' || r.name
      FROM public.quality_alert_targets t
      JOIN public.user_role_assignments a ON a.role_id = t.role_id
      JOIN public.roles r ON r.id = t.role_id
     WHERE t.alert_id = p_alert_id
    UNION ALL
    SELECT t.membership_id, 'Named'
      FROM public.quality_alert_targets t
     WHERE t.alert_id = p_alert_id AND t.membership_id IS NOT NULL
  )
  SELECT m.id, m.user_id, array_agg(DISTINCT h.via ORDER BY h.via)
    FROM hits h
    JOIN public.organisation_users m ON m.id = h.membership_id
    JOIN alert ON alert.organisation_id = m.organisation_id
   WHERE m.status = 'active' AND m.user_id IS NOT NULL
   GROUP BY m.id, m.user_id
$$;

-- For the draft screen: how many people each target reaches, and in total (needs documentation.manage).
CREATE FUNCTION app.preview_quality_alert_recipients(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.quality_alerts%ROWTYPE; v_targets jsonb; v_total integer;
BEGIN
  SELECT * INTO a FROM public.quality_alerts WHERE id = p_id AND deleted_at IS NULL;
  IF NOT FOUND OR NOT app.has_permission(a.organisation_id, 'documentation.manage') THEN
    RAISE EXCEPTION 'Quality alert not found' USING ERRCODE = 'QM012';
  END IF;
  SELECT count(*) INTO v_total FROM app.resolve_quality_alert_targets(p_id);
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', t.id,
           'kind', CASE WHEN t.department_id IS NOT NULL THEN 'department' WHEN t.role_id IS NOT NULL THEN 'role' ELSE 'person' END,
           'label', coalesce(d.name, ro.name, p.first_name || ' ' || p.surname, 'Unknown'),
           'count', (SELECT count(DISTINCT m.id)
                       FROM public.organisation_users m
                      WHERE m.organisation_id = a.organisation_id AND m.status = 'active' AND m.user_id IS NOT NULL AND (
                            (t.department_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.department_members dm WHERE dm.membership_id = m.id AND dm.department_id = t.department_id AND dm.ended_at IS NULL))
                         OR (t.role_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.user_role_assignments ura WHERE ura.membership_id = m.id AND ura.role_id = t.role_id))
                         OR (t.membership_id IS NOT NULL AND m.id = t.membership_id)))) ORDER BY t.created_at), '[]'::jsonb)
    INTO v_targets
    FROM public.quality_alert_targets t
    LEFT JOIN public.departments d ON d.id = t.department_id
    LEFT JOIN public.roles ro ON ro.id = t.role_id
    LEFT JOIN public.organisation_users om ON om.id = t.membership_id
    LEFT JOIN public.profiles p ON p.id = om.user_id
   WHERE t.alert_id = p_id;
  RETURN jsonb_build_object('total', v_total, 'targets', v_targets);
END $$;

-- ---------------------------------------------------------------------------
-- Issuing and withdrawing now create and notify recipients
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.issue_quality_alert(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.quality_alerts%ROWTYPE;
BEGIN
  a := app.quality_alert_for_update(p_id, 'documentation.issue', true);
  IF a.description IS NULL OR a.required_action IS NULL THEN
    RAISE EXCEPTION 'Describe the issue and the action people must take before issuing' USING ERRCODE = 'QM012';
  END IF;
  IF a.effective_date IS NULL THEN
    RAISE EXCEPTION 'Give an effective date before issuing' USING ERRCODE = 'QM012';
  END IF;
  IF a.severity IN ('high', 'critical') AND a.acknowledge_by IS NULL THEN
    RAISE EXCEPTION 'High and critical alerts need an acknowledge-by date' USING ERRCODE = 'QM012';
  END IF;
  IF a.acknowledge_by IS NOT NULL AND a.acknowledge_by < a.effective_date THEN
    RAISE EXCEPTION 'The acknowledge-by date cannot be before the effective date' USING ERRCODE = 'QM012';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.quality_alert_targets WHERE alert_id = p_id) THEN
    RAISE EXCEPTION 'Choose who must acknowledge this alert (a department, a role or named people)' USING ERRCODE = 'QM012';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.resolve_quality_alert_targets(p_id)) THEN
    RAISE EXCEPTION 'The people chosen reach nobody: nobody active is in those departments or holds those roles' USING ERRCODE = 'QM012';
  END IF;
  IF a.expiry_date IS NOT NULL AND a.expiry_date < current_date THEN
    RAISE EXCEPTION 'The expiry date has already passed' USING ERRCODE = 'QM012';
  END IF;
  IF a.supersedes_id IS NOT NULL THEN
    UPDATE public.quality_alerts SET status = 'superseded' WHERE id = a.supersedes_id AND status IN ('active', 'expired');
  END IF;
  UPDATE public.quality_alerts SET status = 'active', issued_at = now(), issued_by = auth.uid() WHERE id = p_id;
  -- Who was asked is fixed now.
  INSERT INTO public.quality_alert_recipients (organisation_id, alert_id, membership_id, user_id, reached_via, alert_reference, alert_title, alert_severity)
  SELECT a.organisation_id, p_id, r.membership_id, r.user_id, r.via,
         a.reference || ' rev ' || app.revision_letter(a.revision), a.title, a.severity
    FROM app.resolve_quality_alert_targets(p_id) r;
END $$;

CREATE OR REPLACE FUNCTION app.withdraw_quality_alert(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.quality_alerts%ROWTYPE;
BEGIN
  a := app.quality_alert_for_update(p_id, 'documentation.issue', false);
  IF a.status NOT IN ('active', 'expired') THEN
    RAISE EXCEPTION 'Only an issued alert can be withdrawn' USING ERRCODE = 'QM012';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'Say why the alert is withdrawn' USING ERRCODE = 'QM012';
  END IF;
  UPDATE public.quality_alerts SET status = 'withdrawn', withdrawn_at = now(), withdrawn_by = auth.uid(), withdrawn_reason = btrim(p_reason) WHERE id = p_id;
  -- Recipients are told it no longer applies.
  UPDATE public.quality_alert_recipients SET withdrawn_notified_at = now() WHERE alert_id = p_id;
END $$;

-- ---------------------------------------------------------------------------
-- Viewing, acknowledging, adding people
-- ---------------------------------------------------------------------------
-- Records the first time a recipient opens an issued alert. Anyone else: nothing happens.
CREATE FUNCTION app.mark_quality_alert_viewed(p_alert_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  UPDATE public.quality_alert_recipients r SET first_viewed_at = now()
   WHERE r.alert_id = p_alert_id AND r.user_id = auth.uid() AND r.first_viewed_at IS NULL
$$;

-- "I have read and understood": by the recipient themselves, while the alert is active, once.
CREATE FUNCTION app.acknowledge_quality_alert(p_alert_id uuid, p_note text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.quality_alert_recipients%ROWTYPE; v_status text;
BEGIN
  SELECT * INTO r FROM public.quality_alert_recipients WHERE alert_id = p_alert_id AND user_id = auth.uid() FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This alert is not addressed to you' USING ERRCODE = 'QM012';
  END IF;
  SELECT status INTO v_status FROM public.quality_alerts WHERE id = p_alert_id;
  IF v_status <> 'active' THEN
    RAISE EXCEPTION 'This alert is no longer in force, so it cannot be acknowledged' USING ERRCODE = 'QM012';
  END IF;
  IF r.acknowledged_at IS NOT NULL THEN
    RAISE EXCEPTION 'You have already acknowledged this alert' USING ERRCODE = 'QM012';
  END IF;
  UPDATE public.quality_alert_recipients
     SET acknowledged_at = now(), first_viewed_at = coalesce(first_viewed_at, now()), acknowledgement_note = nullif(btrim(coalesce(p_note, '')), '')
   WHERE id = r.id;
END $$;

-- A manager adds someone to an issued alert (they join after it was issued, or were missed). Audited, and the person is notified.
CREATE FUNCTION app.add_quality_alert_recipient(p_alert_id uuid, p_membership_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.quality_alerts%ROWTYPE; m public.organisation_users%ROWTYPE;
BEGIN
  a := app.quality_alert_for_update(p_alert_id, 'documentation.issue', false);
  IF a.status <> 'active' THEN
    RAISE EXCEPTION 'People can only be added to an active alert' USING ERRCODE = 'QM012';
  END IF;
  SELECT * INTO m FROM public.organisation_users WHERE id = p_membership_id AND organisation_id = a.organisation_id;
  IF NOT FOUND OR m.status <> 'active' OR m.user_id IS NULL THEN
    RAISE EXCEPTION 'That person is not an active member of the organisation' USING ERRCODE = 'QM012';
  END IF;
  IF EXISTS (SELECT 1 FROM public.quality_alert_recipients WHERE alert_id = p_alert_id AND membership_id = p_membership_id) THEN
    RAISE EXCEPTION 'That person is already asked to acknowledge this alert' USING ERRCODE = 'QM012';
  END IF;
  INSERT INTO public.quality_alert_recipients (organisation_id, alert_id, membership_id, user_id, reached_via, alert_reference, alert_title, alert_severity)
  VALUES (a.organisation_id, p_alert_id, p_membership_id, m.user_id, ARRAY['Added later'],
          a.reference || ' rev ' || app.revision_letter(a.revision), a.title, a.severity);
END $$;

-- ---------------------------------------------------------------------------
-- Notifications addressed to one person
-- ---------------------------------------------------------------------------
ALTER TABLE public.notifications ADD COLUMN recipient_user_id uuid REFERENCES auth.users (id) ON DELETE CASCADE;

DROP POLICY notifications_select ON public.notifications;
CREATE POLICY notifications_select ON public.notifications FOR SELECT TO authenticated
  USING (app.notification_can_see(organisation_id, event_type_id, details)
         AND (recipient_user_id IS NULL OR recipient_user_id = auth.uid()));

INSERT INTO public.notification_event_types
  (key, entity_type, action, group_name, entity_label, description, permission_code, default_on, default_permission_code, label_fields, display_order)
VALUES
  ('quality_alert_recipients.created', 'quality_alert_recipients', 'created', 'Documentation', 'Quality alert', 'Quality alert addressed to you', 'documentation.read', true, NULL,
   ARRAY['alert_reference', 'alert_title'], 80),
  ('quality_alert_recipients.updated', 'quality_alert_recipients', 'updated', 'Documentation', 'Quality alert', 'Quality alert withdrawn', 'documentation.read', true, NULL,
   ARRAY['alert_reference', 'alert_title'], 80);

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
BEGIN
  -- A recipient row also changes when they view or acknowledge: only the withdrawal notice is worth a notification.
  IF NEW.entity_type = 'quality_alert_recipients' AND NEW.action = 'update' AND NOT (coalesce(NEW.changed_fields, '{}') @> ARRAY['withdrawn_notified_at']) THEN
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

  v_body := nullif(concat_ws(' — ', VARIADIC (
    SELECT coalesce(array_agg(nullif(v_row ->> f, '') ORDER BY ord), '{}') FROM unnest(v_type.label_fields) WITH ORDINALITY AS u(f, ord))), '');
  IF v_action = 'updated' AND NEW.changed_fields IS NOT NULL AND NEW.entity_type <> 'quality_alert_recipients' THEN
    v_what := 'Changed: ' || replace(array_to_string(NEW.changed_fields, ', '), '_', ' ');
    v_body := concat_ws('. ', v_body, left(v_what, 200));
  END IF;

  SELECT coalesce(jsonb_object_agg(k, v_row -> k), '{}'::jsonb) INTO v_details
    FROM unnest(ARRAY['site_id', 'gauge_id', 'control_plan_id', 'part_id', 'source', 'stage', 'status', 'alert_id']) k
   WHERE v_row ->> k IS NOT NULL;

  -- Notices about one person's own alerts are for that person only.
  IF NEW.entity_type = 'quality_alert_recipients' THEN v_recipient := (v_row ->> 'user_id')::uuid; END IF;

  INSERT INTO public.notifications (organisation_id, event_type_id, audit_event_id, entity_type, entity_id, title, body, details, actor_user_id, recipient_user_id)
  VALUES (NEW.organisation_id, v_type.id, NEW.id, NEW.entity_type, NEW.entity_id, v_type.description, v_body, v_details, NEW.actor_user_id, v_recipient)
  ON CONFLICT (audit_event_id) DO NOTHING;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION app.visible_notifications(p_organisation_id uuid)
RETURNS TABLE (id uuid, event_key text, entity_type text, entity_id text, title text, body text, details jsonb,
               actor_user_id uuid, created_at timestamptz, read_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT n.id, t.key, n.entity_type, n.entity_id, n.title, n.body, n.details, n.actor_user_id, n.created_at, r.read_at
  FROM public.notifications n
  JOIN public.notification_event_types t ON t.id = n.event_type_id
  LEFT JOIN public.notification_reads r ON r.notification_id = n.id AND r.user_id = auth.uid()
  WHERE n.organisation_id = p_organisation_id
    AND app.is_member(p_organisation_id)
    AND n.created_at > now() - interval '90 days'
    AND n.actor_user_id IS DISTINCT FROM auth.uid()
    AND (n.recipient_user_id IS NULL OR n.recipient_user_id = auth.uid())
    AND app.notification_can_see(n.organisation_id, n.event_type_id, n.details)
    AND app.notification_wanted(n.organisation_id, n.event_type_id)
$$;

REVOKE ALL ON FUNCTION app.revision_letter(integer), app.quality_alert_recipient_rules(), app.quality_alert_recipient_no_delete(),
  app.resolve_quality_alert_targets(uuid), app.preview_quality_alert_recipients(uuid), app.mark_quality_alert_viewed(uuid),
  app.acknowledge_quality_alert(uuid, text), app.add_quality_alert_recipient(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.revision_letter(integer), app.preview_quality_alert_recipients(uuid), app.mark_quality_alert_viewed(uuid),
  app.acknowledge_quality_alert(uuid, text), app.add_quality_alert_recipient(uuid, uuid) TO authenticated;
