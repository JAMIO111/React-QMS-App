-- Organisation security SE5 (docs/security-plan.md, decision S6): recovery when everyone is locked out, and owners and admins told of every change.
--
-- 1. network_policy_changes: one row per change of an organisation's network policy (who, from, to, when; for an operator's recovery also the reason
--    and how ownership was verified). Written only by a trigger on organisation_settings; read with security.read; audited; never changed or deleted.
-- 2. app.platform_recover_network_policy(org, reason, verification): a platform operator (allow-list AND an MFA session) puts an ENFORCED policy back
--    to MONITOR, never off, so the approved networks are kept and nothing is opened for good. No public endpoint, no standing bypass.
-- 3. Every change is a notice to the organisation's owners and admins (security.read), emailed by default, with no actor, so the person who enforced
--    is told too: the notice says what to do if everyone is locked out. These notices are the one kind sent in full while enforced (they hold no
--    quality data, and the lockout guidance must reach the inbox).
-- 4. app.platform_network_policies(orgs): the policy of each organisation for the operator panel (admins only).

CREATE TABLE public.network_policy_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('change', 'recovery')),
  from_mode text NOT NULL CHECK (from_mode IN ('off', 'monitor', 'enforce')),
  to_mode text NOT NULL CHECK (to_mode IN ('off', 'monitor', 'enforce')),
  changed_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  changed_by_name text,
  reason text CHECK (reason IS NULL OR length(reason) <= 1000),
  verification text CHECK (verification IS NULL OR length(verification) <= 1000),
  summary text NOT NULL,
  guidance text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind = 'change' OR (reason IS NOT NULL AND verification IS NOT NULL))
);
CREATE INDEX network_policy_changes_org_idx ON public.network_policy_changes (organisation_id, created_at DESC);
ALTER TABLE public.network_policy_changes ENABLE ROW LEVEL SECURITY;
CREATE POLICY network_policy_changes_select ON public.network_policy_changes FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'security.read'));
REVOKE ALL ON public.network_policy_changes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.network_policy_changes TO authenticated;
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.network_policy_changes FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');

CREATE FUNCTION app.network_policy_changes_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'The history of network policy changes is never changed or deleted' USING ERRCODE = 'QM029';
END $$;
CREATE TRIGGER network_policy_changes_frozen BEFORE UPDATE OR DELETE ON public.network_policy_changes FOR EACH ROW EXECUTE FUNCTION app.network_policy_changes_frozen();

-- Every change of the policy, whoever makes it, is written down here (app.set_network_policy and the operator's recovery are the only writers).
CREATE FUNCTION app.record_network_policy_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_kind text := CASE WHEN current_setting('app.network_recovery', true) = 'on' THEN 'recovery' ELSE 'change' END;
  v_name text := (SELECT nullif(btrim(concat_ws(' ', p.first_name, p.surname)), '') FROM public.profiles p WHERE p.id = NEW.network_policy_changed_by);
  v_label text := CASE NEW.network_policy WHEN 'off' THEN 'off' WHEN 'monitor' THEN 'monitor (nobody blocked)' ELSE 'enforced (only approved networks)' END;
BEGIN
  IF NEW.network_policy IS NOT DISTINCT FROM OLD.network_policy THEN RETURN NEW; END IF;
  INSERT INTO public.network_policy_changes (organisation_id, kind, from_mode, to_mode, changed_by, changed_by_name, reason, verification, summary, guidance)
  VALUES (NEW.organisation_id, v_kind, OLD.network_policy, NEW.network_policy, NEW.network_policy_changed_by, v_name,
          nullif(current_setting('app.network_recovery_reason', true), ''), nullif(current_setting('app.network_recovery_verification', true), ''),
          CASE WHEN v_kind = 'recovery'
               THEN 'Fortress support put network restrictions back to monitor because nobody could get in: ' || coalesce(current_setting('app.network_recovery_reason', true), '')
               ELSE 'Network restrictions are now ' || v_label || coalesce(' — changed by ' || v_name, '') END,
          CASE WHEN NEW.network_policy = 'enforce'
               THEN 'If everyone is locked out, an owner can ask Fortress support to put restrictions back to monitor. Check the approved networks in Settings → Security first.'
               WHEN v_kind = 'recovery'
               THEN 'Nobody is blocked now. Check the approved networks in Settings → Security before enforcing again.'
               ELSE 'Settings → Security shows the approved networks and recent blocked attempts.' END);
  RETURN NEW;
END $$;
CREATE TRIGGER organisation_settings_network_policy_history AFTER UPDATE OF network_policy ON public.organisation_settings
  FOR EACH ROW EXECUTE FUNCTION app.record_network_policy_change();

-- ---------------------------------------------------------------------------
-- The operator's recovery
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.platform_recover_network_policy(p_organisation_id uuid, p_reason text, p_verification text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_policy text; v_reason text := btrim(coalesce(p_reason, '')); v_verification text := btrim(coalesce(p_verification, '')); v_id uuid;
BEGIN
  IF NOT app.is_platform_admin() THEN RAISE EXCEPTION 'Platform administrators only' USING ERRCODE = '42501'; END IF;
  SELECT s.network_policy INTO v_policy FROM public.organisation_settings s WHERE s.organisation_id = p_organisation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Organisation not found' USING ERRCODE = 'P0002'; END IF;
  IF v_policy <> 'enforce' THEN RAISE EXCEPTION 'This organisation is not enforcing network restrictions, so there is nothing to recover' USING ERRCODE = 'QM029'; END IF;
  IF length(v_reason) < 10 OR length(v_reason) > 1000 THEN RAISE EXCEPTION 'Say why access is being recovered (10 to 1000 characters)' USING ERRCODE = 'QM029'; END IF;
  IF length(v_verification) < 10 OR length(v_verification) > 1000 THEN RAISE EXCEPTION 'Say how you checked the request came from an owner (10 to 1000 characters)' USING ERRCODE = 'QM029'; END IF;
  PERFORM set_config('app.network_recovery', 'on', true);
  PERFORM set_config('app.network_recovery_reason', v_reason, true);
  PERFORM set_config('app.network_recovery_verification', v_verification, true);
  UPDATE public.organisation_settings
     SET network_policy = 'monitor', network_policy_changed_at = now(), network_policy_changed_by = auth.uid()
   WHERE organisation_id = p_organisation_id;
  PERFORM set_config('app.network_recovery', 'off', true);
  SELECT c.id INTO v_id FROM public.network_policy_changes c WHERE c.organisation_id = p_organisation_id ORDER BY c.created_at DESC, c.id DESC LIMIT 1;
  RETURN v_id;
END $$;

-- The policy of each organisation, for the operator panel (no networks, no addresses).
CREATE FUNCTION app.platform_network_policies(p_organisation_ids uuid[])
RETURNS TABLE (organisation_id uuid, network_policy text, changed_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT app.is_platform_admin() THEN RAISE EXCEPTION 'Platform administrators only' USING ERRCODE = '42501'; END IF;
  RETURN QUERY SELECT s.organisation_id, s.network_policy, s.network_policy_changed_at
                 FROM public.organisation_settings s WHERE s.organisation_id = ANY (coalesce(p_organisation_ids, '{}'));
END $$;

REVOKE ALL ON FUNCTION app.network_policy_changes_frozen(), app.record_network_policy_change(), app.platform_recover_network_policy(uuid, text, text),
  app.platform_network_policies(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.platform_recover_network_policy(uuid, text, text), app.platform_network_policies(uuid[]) TO authenticated;

-- ---------------------------------------------------------------------------
-- Notices to owners and admins
-- ---------------------------------------------------------------------------
INSERT INTO public.notification_event_types
  (key, entity_type, action, group_name, entity_label, description, permission_code, default_on, default_permission_code, label_fields, display_order, own_record, email_default)
VALUES
  ('network_policy_changes.created', 'network_policy_changes', 'created', 'Security', 'Network restrictions', 'Network restrictions changed',
   'security.read', true, NULL, ARRAY['summary', 'guidance'], 1, false, true);

-- The notification trigger: the 20260221100000_workflow_rules.sql version, with network_policy_changes among the notices that have no actor (so the
-- person who enforced is told what to do if everyone is locked out).
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
  v_doc_row jsonb;
  v_risk_row jsonb;
  v_mr_row jsonb;
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

  -- A sign-off, or a document to read, is announced to its person when it is created; their own view, decision or acknowledgement is not news to them.
  IF NEW.entity_type IN ('document_signoffs', 'document_recipients') AND NEW.action <> 'insert' THEN
    RETURN NULL;
  END IF;

  -- A change request is news to the person who asked only when it is accepted or declined.
  IF NEW.entity_type = 'document_change_requests' AND NOT (NEW.action = 'update' AND NEW.new_values ->> 'status' IN ('accepted', 'declined')) THEN
    RETURN NULL;
  END IF;

  -- A risk action is news to the person it is given to, when it is added or handed to them; a risk to its owner, likewise. Nothing else about either is.
  IF NEW.entity_type IN ('risk_actions', 'risks', 'management_review_actions') AND (NEW.action = 'delete' OR (NEW.action = 'update' AND NOT (coalesce(NEW.changed_fields, '{}') @> ARRAY['owner_user_id']))) THEN
    RETURN NULL;
  END IF;

  -- Reminders, workflow notices and workflow tasks are announced once, when written (a task's own progress is not news to its person).
  IF NEW.entity_type IN ('reminder_digests', 'reminder_overdue_notices', 'workflow_notices', 'workflow_tasks') AND NEW.action <> 'insert' THEN
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

  -- A sign-off tells its reviewer or approver which document (number, letter and title) and what is asked of them.
  IF NEW.entity_type = 'document_signoffs' THEN
    SELECT to_jsonb(s) || jsonb_build_object(
             'document_id', d.id, 'revision_id', r.id,
             'document_label', d.number || ' rev ' || coalesce(r.letter, '?') || ' · ' || d.title,
             'role_label', CASE s.role WHEN 'reviewer' THEN 'Review it' ELSE 'Approve it' END)
      INTO v_doc_row
      FROM public.document_signoffs s
      JOIN public.document_revisions r ON r.id = s.revision_id
      JOIN public.documents d ON d.id = r.document_id
     WHERE s.id = NEW.entity_id::uuid;
    IF v_doc_row IS NULL THEN RETURN NULL; END IF;
    v_row := v_doc_row;
  END IF;

  -- A document to read tells its reader which revision and by when.
  IF NEW.entity_type = 'document_recipients' THEN
    SELECT to_jsonb(x) || jsonb_build_object(
             'document_id', d.id, 'revision_id', r.id,
             'document_label', d.number || ' rev ' || coalesce(r.letter, '?') || ' · ' || d.title,
             'due_label', CASE WHEN x.due_on IS NULL THEN NULL ELSE 'Acknowledge by ' || to_char(x.due_on, 'FMDD Mon YYYY') END)
      INTO v_doc_row
      FROM public.document_recipients x
      JOIN public.document_revisions r ON r.id = x.revision_id
      JOIN public.documents d ON d.id = r.document_id
     WHERE x.id = NEW.entity_id::uuid;
    IF v_doc_row IS NULL THEN RETURN NULL; END IF;
    v_row := v_doc_row;
  END IF;

  -- A decided change request tells the person who asked: which request, for which document, and the decision (with the reason when declined).
  IF NEW.entity_type = 'document_change_requests' THEN
    SELECT to_jsonb(c) || jsonb_build_object(
             'user_id', c.requested_by, 'document_id', d.id, 'revision_id', c.revision_id,
             'request_label', c.reference || ' · ' || d.number || ' ' || d.title,
             'decision_label', CASE c.status WHEN 'accepted' THEN 'Accepted: a revision is being written' ELSE 'Declined: ' || coalesce(c.decision_reason, '') END)
      INTO v_doc_row
      FROM public.document_change_requests c
      JOIN public.documents d ON d.id = c.document_id
     WHERE c.id = NEW.entity_id::uuid;
    IF v_doc_row IS NULL THEN RETURN NULL; END IF;
    v_row := v_doc_row;
  END IF;

  -- A risk action tells its person which risk, what to do and by when; a risk tells its new owner which one.
  IF NEW.entity_type = 'risk_actions' THEN
    SELECT to_jsonb(a) || jsonb_build_object(
             'user_id', a.owner_user_id, 'risk_id', r.id, 'risk_label', r.reference || ' · ' || r.title,
             'due_label', CASE WHEN a.due_date IS NULL THEN NULL ELSE 'Due ' || to_char(a.due_date, 'FMDD Mon YYYY') END)
      INTO v_risk_row
      FROM public.risk_actions a JOIN public.risks r ON r.id = a.risk_id
     WHERE a.id = NEW.entity_id::uuid AND a.status = 'open';
    -- Given to yourself: the notice would be for the person who did it, who is never told of their own action.
    IF v_risk_row IS NULL OR (v_risk_row ->> 'user_id')::uuid IS NOT DISTINCT FROM NEW.actor_user_id THEN RETURN NULL; END IF;
    v_row := v_risk_row;
  END IF;
  IF NEW.entity_type = 'risks' THEN
    SELECT to_jsonb(r) || jsonb_build_object('user_id', r.owner_user_id, 'risk_id', r.id, 'risk_label', r.reference || ' · ' || r.title,
             'kind_label', CASE r.kind WHEN 'opportunity' THEN 'Opportunity' ELSE 'Risk' END)
      INTO v_risk_row
      FROM public.risks r
     WHERE r.id = NEW.entity_id::uuid AND r.status NOT IN ('closed', 'retired');
    IF v_risk_row IS NULL OR (v_risk_row ->> 'user_id')::uuid IS NOT DISTINCT FROM NEW.actor_user_id THEN RETURN NULL; END IF;
    v_row := v_risk_row;
  END IF;

  -- A management review action tells its person which review, what to do and by when (they may hold no management review permission: own_record).
  IF NEW.entity_type = 'management_review_actions' THEN
    SELECT to_jsonb(a) || jsonb_build_object(
             'user_id', a.owner_user_id, 'review_id', m.id, 'review_label', m.reference || ' · ' || m.title,
             'due_label', CASE WHEN a.due_date IS NULL THEN NULL ELSE 'Due ' || to_char(a.due_date, 'FMDD Mon YYYY') END)
      INTO v_mr_row
      FROM public.management_review_actions a JOIN public.management_reviews m ON m.id = a.review_id
     WHERE a.id = NEW.entity_id::uuid AND a.status = 'open';
    IF v_mr_row IS NULL OR (v_mr_row ->> 'user_id')::uuid IS NOT DISTINCT FROM NEW.actor_user_id THEN RETURN NULL; END IF;
    v_row := v_mr_row;
  END IF;

  -- An overdue notice says what and since when; the area and the record behind it lead the link.
  IF NEW.entity_type = 'reminder_overdue_notices' THEN
    v_row := v_row || jsonb_build_object('due_label', 'Was due ' || to_char((v_row ->> 'due_on')::date, 'FMDD Mon YYYY'));
  END IF;

  -- A workflow task goes to its person (user_id) with when it is due; a workflow notice already names its person.
  IF NEW.entity_type = 'workflow_tasks' THEN
    v_row := v_row || jsonb_build_object('user_id', v_row ->> 'assignee_user_id', 'task_id', v_row ->> 'id',
                                         'due_label', CASE WHEN v_row ->> 'due_on' IS NULL THEN NULL ELSE 'Due ' || to_char((v_row ->> 'due_on')::date, 'FMDD Mon YYYY') END);
  END IF;

  v_body := nullif(concat_ws(' — ', VARIADIC (
    SELECT coalesce(array_agg(nullif(v_row ->> f, '') ORDER BY ord), '{}') FROM unnest(v_type.label_fields) WITH ORDINALITY AS u(f, ord))), '');
  IF v_action = 'updated' AND NEW.changed_fields IS NOT NULL
     AND NEW.entity_type NOT IN ('quality_alert_recipients', 'capa_actions', 'competence_assessments', 'document_signoffs', 'document_recipients', 'document_change_requests', 'risk_actions', 'risks', 'management_review_actions') THEN
    v_what := 'Changed: ' || replace(array_to_string(NEW.changed_fields, ', '), '_', ' ');
    v_body := concat_ws('. ', v_body, left(v_what, 200));
  END IF;

  SELECT coalesce(jsonb_object_agg(k, v_row -> k), '{}'::jsonb) INTO v_details
    FROM unnest(ARRAY['site_id', 'gauge_id', 'control_plan_id', 'part_id', 'source', 'stage', 'status', 'alert_id', 'capa_id', 'connection_id', 'run_id', 'kind',
                      'document_id', 'revision_id', 'role', 'risk_id', 'review_id', 'area', 'target_id', 'record_kind', 'record_id', 'task_id']) k
   WHERE v_row ->> k IS NOT NULL;

  -- Notices about one person's own alerts are for that person only.
  IF NEW.entity_type IN ('quality_alert_recipients', 'capa_actions', 'competence_assessments', 'document_signoffs', 'document_recipients', 'document_change_requests', 'risk_actions', 'risks', 'management_review_actions',
                         'reminder_digests', 'reminder_overdue_notices', 'workflow_notices', 'workflow_tasks') THEN
    v_recipient := (v_row ->> 'user_id')::uuid;
  END IF;

  INSERT INTO public.notifications (organisation_id, event_type_id, audit_event_id, entity_type, entity_id, title, body, details, actor_user_id, recipient_user_id)
  VALUES (NEW.organisation_id, v_type.id, NEW.id, NEW.entity_type, NEW.entity_id, v_type.description, v_body, v_details,
          CASE WHEN NEW.entity_type IN ('integration_alerts', 'document_recipients', 'reminder_digests', 'reminder_overdue_notices', 'workflow_notices', 'workflow_tasks', 'network_policy_changes') THEN NULL ELSE NEW.actor_user_id END,
          v_recipient)
  ON CONFLICT (audit_event_id) DO NOTHING;
  RETURN NULL;
END $$;

-- The email lease: the 20260302100000 version, except that notices about network restrictions themselves are always sent in full.
CREATE OR REPLACE FUNCTION app.system_lease_emails(p_limit integer DEFAULT 50, p_lease_seconds integer DEFAULT 120)
RETURNS TABLE (id uuid, organisation_id uuid, organisation_name text, to_address text, recipient_name text, attempts integer,
               event_key text, entity_type text, entity_id text, title text, body text, details jsonb, created_at timestamptz,
               network_restricted boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT e.id FROM public.email_outbox e
     WHERE e.status = 'queued' AND e.next_attempt_at <= now() AND (e.leased_until IS NULL OR e.leased_until < now())
     ORDER BY e.next_attempt_at LIMIT least(greatest(coalesce(p_limit, 50), 1), 200) FOR UPDATE SKIP LOCKED
  ), leased AS (
    UPDATE public.email_outbox e SET leased_until = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 120), 10), 900)), updated_at = now()
      FROM due WHERE e.id = due.id RETURNING e.*
  )
  SELECT l.id, l.organisation_id, o.name, l.to_address, nullif(btrim(concat_ws(' ', p.first_name, p.surname)), ''), l.attempts,
         t.key, n.entity_type, n.entity_id, n.title, n.body, n.details, n.created_at,
         coalesce(s.network_policy = 'enforce' AND t.key <> 'network_policy_changes.created', false)
    FROM leased l
    JOIN public.notifications n ON n.id = l.notification_id
    JOIN public.notification_event_types t ON t.id = n.event_type_id
    JOIN public.organisations o ON o.id = l.organisation_id
    LEFT JOIN public.organisation_settings s ON s.organisation_id = l.organisation_id
    LEFT JOIN public.profiles p ON p.id = l.user_id;
END $$;
