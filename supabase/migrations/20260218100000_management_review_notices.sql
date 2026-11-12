-- Management review MR3 (docs/risk-management-plan.md §17): the person a management review action is given to is told.
--
--   management_review_actions.created / .updated  "A management review action was given to you": an open action added with someone on it, or handed to someone else.
-- own_record: the person may hold no management review permission (they read and close their own action), so the event is offered to every member and the notice is
-- addressed to that one person; never written when they gave it to themselves; emailed by default; links to "My review actions".

INSERT INTO public.notification_event_types
  (key, entity_type, action, group_name, entity_label, description, permission_code, default_on, default_permission_code, label_fields, display_order, own_record, email_default)
VALUES
  ('management_review_actions.created', 'management_review_actions', 'created', 'Management review', 'Management review action', 'A management review action was given to you',
   'management_review.read', true, NULL, ARRAY['review_label', 'description', 'due_label'], 97, true, true),
  ('management_review_actions.updated', 'management_review_actions', 'updated', 'Management review', 'Management review action', 'A management review action was given to you',
   'management_review.read', true, NULL, ARRAY['review_label', 'description', 'due_label'], 97, true, true);

-- emit_notification as in 20260215100000, plus the management review action branch.
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

  v_body := nullif(concat_ws(' — ', VARIADIC (
    SELECT coalesce(array_agg(nullif(v_row ->> f, '') ORDER BY ord), '{}') FROM unnest(v_type.label_fields) WITH ORDINALITY AS u(f, ord))), '');
  IF v_action = 'updated' AND NEW.changed_fields IS NOT NULL
     AND NEW.entity_type NOT IN ('quality_alert_recipients', 'capa_actions', 'competence_assessments', 'document_signoffs', 'document_recipients', 'document_change_requests', 'risk_actions', 'risks', 'management_review_actions') THEN
    v_what := 'Changed: ' || replace(array_to_string(NEW.changed_fields, ', '), '_', ' ');
    v_body := concat_ws('. ', v_body, left(v_what, 200));
  END IF;

  SELECT coalesce(jsonb_object_agg(k, v_row -> k), '{}'::jsonb) INTO v_details
    FROM unnest(ARRAY['site_id', 'gauge_id', 'control_plan_id', 'part_id', 'source', 'stage', 'status', 'alert_id', 'capa_id', 'connection_id', 'run_id', 'kind',
                      'document_id', 'revision_id', 'role', 'risk_id', 'review_id']) k
   WHERE v_row ->> k IS NOT NULL;

  -- Notices about one person's own alerts are for that person only.
  IF NEW.entity_type IN ('quality_alert_recipients', 'capa_actions', 'competence_assessments', 'document_signoffs', 'document_recipients', 'document_change_requests', 'risk_actions', 'risks', 'management_review_actions') THEN
    v_recipient := (v_row ->> 'user_id')::uuid;
  END IF;

  INSERT INTO public.notifications (organisation_id, event_type_id, audit_event_id, entity_type, entity_id, title, body, details, actor_user_id, recipient_user_id)
  VALUES (NEW.organisation_id, v_type.id, NEW.id, NEW.entity_type, NEW.entity_id, v_type.description, v_body, v_details,
          CASE WHEN NEW.entity_type IN ('integration_alerts', 'document_recipients') THEN NULL ELSE NEW.actor_user_id END, v_recipient)
  ON CONFLICT (audit_event_id) DO NOTHING;
  RETURN NULL;
END $$;


-- The reviews the caller holds an action from: number, title and status only. An action's owner may hold no management review permission and so cannot read the
-- review itself, but their own action is shown with which review it came from.
CREATE FUNCTION app.my_review_action_reviews(p_organisation_id uuid) RETURNS TABLE (id uuid, reference text, title text, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT m.id, m.reference, m.title, m.status
    FROM public.management_reviews m
   WHERE m.organisation_id = p_organisation_id AND app.is_member(p_organisation_id)
     AND EXISTS (SELECT 1 FROM public.management_review_actions a WHERE a.review_id = m.id AND a.owner_user_id = (SELECT auth.uid()))
$$;
REVOKE ALL ON FUNCTION app.my_review_action_reviews(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.my_review_action_reviews(uuid) TO authenticated;
