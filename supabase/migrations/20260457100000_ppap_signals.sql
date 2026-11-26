-- PPAP, slice PP6b (docs/ppap-plan.md PP13, PP14): what a workflow rule can start from, two reminders areas and a notice to the person who owns a submission.
-- Information only: nothing here changes a submission, a decision or a part.
--
--  * Workflow triggers ppap.submitted, ppap.approved, ppap.interim_approved and ppap.rejected: one AFTER trigger on ppap_submissions writes the event when the status moves
--    to that state (a package sent to a customer, a package received from a supplier, the customer's or our decision). The portal's answer and a staff-recorded decision
--    both move the status, so both write it.
--  * Workflow triggers ppap.interim_expiring and ppap.review_due. A date is not an event, so the worker's daily step writes them: app.system_emit_ppap_due_events()
--    (API login only) writes an event for each interim approval that is within 14 days of running out (or ran out in the last three days) and for each approved
--    submission whose review date was reached in the last three days, in the organisation's own day. Once for each date: an event already in the outbox for that
--    record and date is not written again, and a new expiry date is a new event.
--    Facts a rule can test: direction, level, reason, status, part number, the customer or supplier's name, the days left or overdue.
--  * Reminders area ppap_interim: an interim approval for the submission's owner, from 30 days before it runs out. Reminders area ppap_reviews: an approved submission
--    for its owner, from 30 days before its revalidation date.
--  * Notice ppap_submissions.updated: to the owner when someone else (a member of the organisation, not the customer in the portal, whose answer already tells staff
--    through portal_activity) records an approval, an interim approval or a rejection. Never to the person who recorded it.
-- app.workflow_triggers(), app.system_workflow_facts(), app.reminder_areas(), app.reminder_candidates() and app.emit_notification() are shared, so they are changed by a
-- checked text patch from their live definitions (the migration refuses to finish unless the anchor is found exactly once, and does nothing when its marker is already
-- there): nothing a later migration changed is lost, and running it again is safe.
CREATE OR REPLACE FUNCTION pg_temp.patch(p_fn regprocedure, p_old text, p_new text, p_marker text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_def text := replace(pg_get_functiondef(p_fn), E'\r', ''); v_n integer;
BEGIN
  IF position(p_marker IN v_def) > 0 THEN RETURN; END IF;
  v_n := (length(v_def) - length(replace(v_def, p_old, ''))) / length(p_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'Expected to find % exactly once in %, found % times', p_old, p_fn, v_n; END IF;
  EXECUTE replace(v_def, p_old, p_new);
END $$;

-- ---------------------------------------------------------------------------
-- The status events (the trigger only writes to the outbox)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.workflow_emit_ppap_status() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_event text;
BEGIN
  v_event := CASE NEW.status
    WHEN 'submitted' THEN 'ppap.submitted'
    WHEN 'approved' THEN 'ppap.approved'
    WHEN 'interim_approved' THEN 'ppap.interim_approved'
    WHEN 'rejected' THEN 'ppap.rejected'
    ELSE NULL END;
  IF v_event IS NOT NULL THEN
    PERFORM app.emit_event(NEW.organisation_id, v_event, 'ppap', NEW.id,
      jsonb_build_object('reference', NEW.reference, 'from', OLD.status, 'to', NEW.status));
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS ppap_submissions_workflow_event ON public.ppap_submissions;
CREATE TRIGGER ppap_submissions_workflow_event AFTER UPDATE OF status ON public.ppap_submissions
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION app.workflow_emit_ppap_status();
REVOKE ALL ON FUNCTION app.workflow_emit_ppap_status() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The dates the worker turns into events: an interim approval about to run out, a revalidation reached
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.system_emit_ppap_due_events(p_limit integer DEFAULT 200) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  o record; i record; f record; v_today date; v_orgs integer := 0; v_interim integer := 0; v_reviews integer := 0;
BEGIN
  FOR o IN SELECT og.id FROM public.organisations og WHERE og.status = 'active' ORDER BY og.created_at LOOP
    EXIT WHEN v_orgs >= least(greatest(coalesce(p_limit, 200), 1), 500);
    v_orgs := v_orgs + 1;
    v_today := (now() AT TIME ZONE app.organisation_time_zone(o.id))::date;

    -- An interim approval within 14 days of running out, or that ran out in the last three days: one event for each expiry date.
    FOR i IN
      SELECT s.id, s.reference, d.expires_on
        FROM public.ppap_submissions s
        JOIN LATERAL (SELECT x.expires_on FROM public.ppap_decisions x WHERE x.submission_id = s.id AND x.organisation_id = s.organisation_id AND x.kind = 'interim_approved'
                       ORDER BY x.seq DESC LIMIT 1) d ON true
       WHERE s.organisation_id = o.id AND s.status = 'interim_approved' AND d.expires_on - 14 <= v_today AND d.expires_on >= v_today - 3
         AND NOT EXISTS (SELECT 1 FROM public.outbox_events e WHERE e.organisation_id = o.id AND e.event_type = 'ppap.interim_expiring' AND e.entity_id = s.id
                            AND e.payload ->> 'due_on' = d.expires_on::text)
    LOOP
      PERFORM app.emit_event(o.id, 'ppap.interim_expiring', 'ppap', i.id, jsonb_build_object('reference', i.reference, 'due_on', i.expires_on));
      v_interim := v_interim + 1;
    END LOOP;

    -- An approved submission whose revalidation date was reached in the last three days: one event for each date.
    FOR f IN
      SELECT s.id, s.reference, s.next_review_on FROM public.ppap_submissions s
       WHERE s.organisation_id = o.id AND s.status = 'approved' AND s.next_review_on <= v_today AND s.next_review_on >= v_today - 3
         AND NOT EXISTS (SELECT 1 FROM public.outbox_events e WHERE e.organisation_id = o.id AND e.event_type = 'ppap.review_due' AND e.entity_id = s.id
                            AND e.payload ->> 'due_on' = s.next_review_on::text)
    LOOP
      PERFORM app.emit_event(o.id, 'ppap.review_due', 'ppap', f.id, jsonb_build_object('reference', f.reference, 'due_on', f.next_review_on));
      v_reviews := v_reviews + 1;
    END LOOP;
  END LOOP;
  RETURN jsonb_build_object('organisations', v_orgs, 'interimEvents', v_interim, 'reviewEvents', v_reviews);
END $$;
REVOKE ALL ON FUNCTION app.system_emit_ppap_due_events(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.system_emit_ppap_due_events(integer) TO qms_api;

-- ---------------------------------------------------------------------------
-- What a rule can start from, and its facts
-- ---------------------------------------------------------------------------
SELECT pg_temp.patch('app.workflow_triggers()'::regprocedure,
  $a$('quality_alert.issued',$a$,
  $b$('ppap.submitted',                      'ppap',                       'A part approval package is sent or received',   'ppap.read'),
    ('ppap.approved',                       'ppap',                       'A part approval is granted',                    'ppap.read'),
    ('ppap.interim_approved',               'ppap',                       'A part approval is granted for now only',       'ppap.read'),
    ('ppap.rejected',                       'ppap',                       'A part approval is rejected',                   'ppap.read'),
    ('ppap.interim_expiring',               'ppap',                       'An interim part approval is about to run out',  'ppap.read'),
    ('ppap.review_due',                     'ppap',                       'A part approval is due for revalidation',       'ppap.read'),
    ('quality_alert.issued',$b$,
  $m$'ppap.submitted'$m$);

SELECT pg_temp.patch('app.system_workflow_facts(uuid, text, uuid, jsonb)'::regprocedure,
  $a$ELSIF p_entity_type = 'quality_alert' THEN$a$,
  $b$ELSIF p_entity_type = 'ppap' THEN
    SELECT jsonb_build_object('label', s.reference || ' · ' || p.part_number, 'record_kind', 'ppap', 'record_id', s.id, 'site_id', s.site_id, 'owner_user_id', s.owner_user_id,
             'direction', s.direction, 'level', s.level, 'reason', s.reason, 'status', s.status, 'part_number', p.part_number,
             'party', coalesce(c.name, su.name),
             'from_status', p_payload ->> 'from', 'to_status', coalesce(p_payload ->> 'to', s.status),
             'days_to_expiry', CASE WHEN s.status = 'interim_approved' THEN coalesce((p_payload ->> 'due_on')::date, (SELECT x.expires_on FROM public.ppap_decisions x WHERE x.submission_id = s.id AND x.organisation_id = s.organisation_id AND x.kind = 'interim_approved' ORDER BY x.seq DESC LIMIT 1)) - current_date END,
             'days_overdue', CASE WHEN s.status = 'approved' AND s.next_review_on IS NOT NULL THEN greatest(current_date - coalesce((p_payload ->> 'due_on')::date, s.next_review_on), 0) END)
      INTO v FROM public.ppap_submissions s
      JOIN public.parts p ON p.id = s.part_id AND p.organisation_id = s.organisation_id
      LEFT JOIN public.customers c ON c.id = s.customer_id AND c.organisation_id = s.organisation_id
      LEFT JOIN public.suppliers su ON su.id = s.supplier_id AND su.organisation_id = s.organisation_id
     WHERE s.id = p_entity_id AND s.organisation_id = p_organisation_id;
  ELSIF p_entity_type = 'quality_alert' THEN$b$,
  $m$p_entity_type = 'ppap'$m$);

-- ---------------------------------------------------------------------------
-- The reminders areas
-- ---------------------------------------------------------------------------
SELECT pg_temp.patch('app.reminder_areas()'::regprocedure,
  $a$('competence',$a$,
  $b$('ppap_interim',    18, 'Interim part approvals',     'Part approvals you own that are approved for now only and about to run out', 30),
    ('ppap_reviews',    19, 'Part approval revalidation', 'Part approvals you own that are due for revalidation',                       30),
    ('competence',$b$,
  $m$'ppap_interim'$m$);

SELECT pg_temp.patch('app.reminder_candidates(uuid, date)'::regprocedure,
  $a$-- FMEA actions: an open action on an FMEA that is a draft or in force$a$,
  $b$-- Interim part approvals: approved for now only, for the submission's owner, until the day it runs to.
    SELECT s.owner_user_id, 'ppap_interim'::text, s.id, s.id, s.reference || ' · ' || p.part_number || ' (interim approval)', d.expires_on, 'ppap.read'::text, NULL::uuid
      FROM public.ppap_submissions s
      JOIN public.parts p ON p.id = s.part_id AND p.organisation_id = s.organisation_id
      JOIN LATERAL (SELECT x.expires_on FROM public.ppap_decisions x WHERE x.submission_id = s.id AND x.organisation_id = s.organisation_id AND x.kind = 'interim_approved'
                     ORDER BY x.seq DESC LIMIT 1) d ON true
     WHERE s.organisation_id = p_organisation_id AND s.status = 'interim_approved'
    UNION ALL
    -- Part approval revalidation: an approved submission, for its owner, when its review date is near or past.
    SELECT s.owner_user_id, 'ppap_reviews'::text, s.id, s.id, s.reference || ' · ' || p.part_number || ' (revalidation)', s.next_review_on, 'ppap.read'::text, NULL::uuid
      FROM public.ppap_submissions s
      JOIN public.parts p ON p.id = s.part_id AND p.organisation_id = s.organisation_id
     WHERE s.organisation_id = p_organisation_id AND s.status = 'approved' AND s.next_review_on IS NOT NULL
    UNION ALL
    -- FMEA actions: an open action on an FMEA that is a draft or in force$b$,
  $m$'ppap_interim'::text$m$);

-- ---------------------------------------------------------------------------
-- The notice to the owner when someone else records a decision
-- ---------------------------------------------------------------------------
INSERT INTO public.notification_event_types
  (key, entity_type, action, group_name, entity_label, description, permission_code, default_on, default_permission_code, label_fields, display_order, own_record, email_default)
VALUES
  ('ppap_submissions.updated', 'ppap_submissions', 'updated', 'PPAP', 'Part approval', 'A part approval you own was decided', 'ppap.read', true, NULL,
   ARRAY['ppap_label', 'decision_label'], 22, true, true)
ON CONFLICT (key) DO NOTHING;

SELECT pg_temp.patch('app.emit_notification()'::regprocedure,
  E'  IF NEW.entity_type = ''change_signoffs'' AND NEW.action <> ''insert'' THEN RETURN NULL; END IF;\n',
  E'  IF NEW.entity_type = ''change_signoffs'' AND NEW.action <> ''insert'' THEN RETURN NULL; END IF;\n'
  || E'  IF NEW.entity_type = ''ppap_submissions'' AND NOT (NEW.action = ''update'' AND coalesce(NEW.changed_fields, ''{}'') @> ARRAY[''status'']) THEN RETURN NULL; END IF;\n',
  E'NEW.entity_type = ''ppap_submissions'' AND NOT');
SELECT pg_temp.patch('app.emit_notification()'::regprocedure,
  E'  -- An overdue notice says what and since when; the area and the record behind it lead the link.',
  E'  -- A decided part approval tells its owner which one and what was decided, unless a member of the organisation did it themselves. The customer answering in the portal\n'
  || E'  -- is not a member and is not told of here: staff already hear of that through the portal activity notice.\n'
  || E'  IF NEW.entity_type = ''ppap_submissions'' THEN\n'
  || E'    SELECT to_jsonb(t) || jsonb_build_object(''user_id'', t.owner_user_id, ''ppap_id'', t.id, ''ppap_label'', t.reference || '' · '' || p.part_number,\n'
  || E'             ''decision_label'', CASE t.status WHEN ''approved'' THEN ''Approved'' WHEN ''interim_approved'' THEN ''Approved for now'' ELSE ''Rejected'' END)\n'
  || E'      INTO v_change_row FROM public.ppap_submissions t JOIN public.parts p ON p.id = t.part_id AND p.organisation_id = t.organisation_id\n'
  || E'     WHERE t.id = NEW.entity_id::uuid AND t.status IN (''approved'', ''interim_approved'', ''rejected'');\n'
  || E'    IF v_change_row IS NULL OR (v_change_row ->> ''user_id'')::uuid IS NOT DISTINCT FROM NEW.actor_user_id\n'
  || E'       OR NOT EXISTS (SELECT 1 FROM public.organisation_users ou WHERE ou.organisation_id = NEW.organisation_id AND ou.user_id = NEW.actor_user_id AND ou.status = ''active'') THEN RETURN NULL; END IF;\n'
  || E'    v_row := v_change_row;\n  END IF;\n\n'
  || E'  -- An overdue notice says what and since when; the area and the record behind it lead the link.',
  E'NEW.entity_type = ''ppap_submissions'' THEN\n    SELECT to_jsonb(t)');
SELECT pg_temp.patch('app.emit_notification()'::regprocedure,
  E'''record_kind'', ''record_id'', ''task_id'', ''change_id'', ''fmea_id'']) k',
  E'''record_kind'', ''record_id'', ''task_id'', ''change_id'', ''fmea_id'', ''ppap_id'']) k',
  E'''fmea_id'', ''ppap_id'']) k');
SELECT pg_temp.patch('app.emit_notification()'::regprocedure,
  E'''change_tasks'', ''fmea_actions'') THEN\n    v_what := ''Changed: ''',
  E'''change_tasks'', ''fmea_actions'', ''ppap_submissions'') THEN\n    v_what := ''Changed: ''',
  E'''fmea_actions'', ''ppap_submissions'') THEN\n    v_what');
SELECT pg_temp.patch('app.emit_notification()'::regprocedure,
  E'  IF NEW.entity_type IN (''change_signoffs'', ''change_requests'', ''change_tasks'', ''fmea_actions'') THEN v_recipient := (v_row ->> ''user_id'')::uuid; END IF;',
  E'  IF NEW.entity_type IN (''change_signoffs'', ''change_requests'', ''change_tasks'', ''fmea_actions'', ''ppap_submissions'') THEN v_recipient := (v_row ->> ''user_id'')::uuid; END IF;',
  E'''fmea_actions'', ''ppap_submissions'') THEN v_recipient');
