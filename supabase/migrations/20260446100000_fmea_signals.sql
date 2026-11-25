-- FMEA, slice FM6c (docs/fmea-plan.md §7): what a workflow rule can start from, and two reminders areas. Information only: nothing here changes an FMEA.
--
--  * Workflow trigger fmea.approved: a submitted revision is approved (written to the outbox by one AFTER trigger on fmea_revisions; it may take effect the same day).
--    Facts a rule can test: the kind of FMEA, the revision's number, how many of its causes need attention and how many are of high priority, the title.
--  * Workflow triggers fmea.action_overdue and fmea.review_due. A date is not an event, so the worker's daily step writes them: app.system_emit_fmea_due_events()
--    (API login only) writes an event for each open action that went overdue in the last three days, and for each FMEA in force whose review date was reached in the
--    last three days, in the organisation's own day. Once for each due date: an event already in the outbox for that record and date is not written again.
--    Facts: the kind, the title, how many days late; for an action also its kind (prevention or detection).
--  * Reminders area fmea_actions: an open action on an FMEA that is a draft or in force, for the person it was given to (a member, or the sign-in of an employee).
--    Reminders area fmea_reviews: an FMEA in force, for its owner, when its periodic review is near or past.
-- app.workflow_triggers(), app.system_workflow_facts(), app.reminder_areas() and app.reminder_candidates() are shared, so they are changed by a checked text patch from
-- their live definitions (the migration refuses to finish unless the anchor is found exactly once, and does nothing when its marker is already there): nothing a later
-- migration changed is lost, and running it again is safe.
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
-- The approval event (the trigger only writes to the outbox)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.workflow_emit_fmea_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF OLD.status = 'pending_approval' AND NEW.status = 'approved' THEN
    PERFORM app.emit_event(NEW.organisation_id, 'fmea.approved', 'fmea_revision', NEW.id,
      jsonb_build_object('fmea_id', NEW.fmea_id, 'sequence', NEW.sequence, 'letter', NEW.letter, 'effective_from', NEW.effective_from));
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS fmea_revisions_workflow_event ON public.fmea_revisions;
CREATE TRIGGER fmea_revisions_workflow_event AFTER UPDATE OF status ON public.fmea_revisions
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION app.workflow_emit_fmea_revision();
REVOKE ALL ON FUNCTION app.workflow_emit_fmea_revision() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The dates the worker turns into events: an action gone overdue, a review reached
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.system_emit_fmea_due_events(p_limit integer DEFAULT 200) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  o record; a record; f record; v_today date; v_orgs integer := 0; v_actions integer := 0; v_reviews integer := 0;
BEGIN
  FOR o IN SELECT og.id FROM public.organisations og WHERE og.status = 'active' ORDER BY og.created_at LOOP
    EXIT WHEN v_orgs >= least(greatest(coalesce(p_limit, 200), 1), 500);
    v_orgs := v_orgs + 1;
    v_today := (now() AT TIME ZONE app.organisation_time_zone(o.id))::date;

    -- An open action on a live FMEA that went overdue in the last three days: one event for each due date.
    FOR a IN
      SELECT x.id, x.due_on, f2.number FROM public.fmea_actions x
        JOIN public.fmea_revisions r ON r.id = x.revision_id AND r.status IN ('draft', 'effective')
        JOIN public.fmeas f2 ON f2.id = r.fmea_id AND f2.status IN ('draft', 'active')
       WHERE x.organisation_id = o.id AND x.status = 'open' AND x.due_on < v_today AND x.due_on >= v_today - 3
         AND NOT EXISTS (SELECT 1 FROM public.outbox_events e WHERE e.organisation_id = o.id AND e.event_type = 'fmea.action_overdue' AND e.entity_id = x.id
                            AND e.payload ->> 'due_on' = x.due_on::text)
    LOOP
      PERFORM app.emit_event(o.id, 'fmea.action_overdue', 'fmea_action', a.id, jsonb_build_object('reference', a.number, 'due_on', a.due_on));
      v_actions := v_actions + 1;
    END LOOP;

    -- An FMEA in force whose review date was reached in the last three days: one event for each date.
    FOR f IN
      SELECT x.id, x.number, x.next_review_on FROM public.fmeas x
       WHERE x.organisation_id = o.id AND x.status = 'active' AND x.next_review_on <= v_today AND x.next_review_on >= v_today - 3
         AND NOT EXISTS (SELECT 1 FROM public.outbox_events e WHERE e.organisation_id = o.id AND e.event_type = 'fmea.review_due' AND e.entity_id = x.id
                            AND e.payload ->> 'due_on' = x.next_review_on::text)
    LOOP
      PERFORM app.emit_event(o.id, 'fmea.review_due', 'fmea', f.id, jsonb_build_object('reference', f.number, 'due_on', f.next_review_on));
      v_reviews := v_reviews + 1;
    END LOOP;
  END LOOP;
  RETURN jsonb_build_object('organisations', v_orgs, 'actionEvents', v_actions, 'reviewEvents', v_reviews);
END $$;
REVOKE ALL ON FUNCTION app.system_emit_fmea_due_events(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.system_emit_fmea_due_events(integer) TO qms_api;

-- ---------------------------------------------------------------------------
-- What a rule can start from, and its facts
-- ---------------------------------------------------------------------------
SELECT pg_temp.patch('app.workflow_triggers()'::regprocedure,
  $a$('quality_alert.issued',$a$,
  $b$('fmea.approved',                      'fmea_revision',              'An FMEA revision is approved',                  'fmea.read'),
    ('fmea.action_overdue',                 'fmea_action',                'An FMEA action goes overdue',                   'fmea.read'),
    ('fmea.review_due',                     'fmea',                       'An FMEA is due for its periodic review',        'fmea.read'),
    ('quality_alert.issued',$b$,
  $m$'fmea.approved'$m$);

SELECT pg_temp.patch('app.system_workflow_facts(uuid, text, uuid, jsonb)'::regprocedure,
  $a$ELSIF p_entity_type = 'quality_alert' THEN$a$,
  $b$ELSIF p_entity_type = 'fmea_revision' THEN
    SELECT jsonb_build_object('label', f.number || ' ' || coalesce('rev ' || r.letter, 'draft') || ' · ' || f.title, 'record_kind', 'fmea', 'record_id', f.id, 'site_id', NULL, 'owner_user_id', f.owner_user_id,
             'fmea_kind', f.kind, 'revision_number', r.sequence, 'title', f.title,
             'need_attention', (SELECT count(*) FROM public.fmea_causes c WHERE c.revision_id = r.id AND c.organisation_id = r.organisation_id AND c.needs_attention),
             'high_priority', (SELECT count(*) FROM public.fmea_causes c WHERE c.revision_id = r.id AND c.organisation_id = r.organisation_id AND c.priority = 'high'))
      INTO v FROM public.fmea_revisions r JOIN public.fmeas f ON f.id = r.fmea_id AND f.organisation_id = r.organisation_id
     WHERE r.id = p_entity_id AND r.organisation_id = p_organisation_id AND r.status IN ('approved', 'effective');
  ELSIF p_entity_type = 'fmea_action' THEN
    SELECT jsonb_build_object('label', f.number || ' · ' || left(a.description, 120), 'record_kind', 'fmea', 'record_id', f.id, 'site_id', NULL, 'owner_user_id', coalesce(a.owner_user_id, e.auth_id),
             'fmea_kind', f.kind, 'title', f.title, 'action_kind', a.kind, 'days_late', greatest(current_date - coalesce((p_payload ->> 'due_on')::date, a.due_on), 0))
      INTO v FROM public.fmea_actions a
      JOIN public.fmea_revisions r ON r.id = a.revision_id AND r.organisation_id = a.organisation_id
      JOIN public.fmeas f ON f.id = r.fmea_id AND f.organisation_id = a.organisation_id
      LEFT JOIN public."Employees" e ON e.id = a.owner_employee_id AND e.organisation_id = a.organisation_id
     WHERE a.id = p_entity_id AND a.organisation_id = p_organisation_id AND a.status = 'open';
  ELSIF p_entity_type = 'fmea' THEN
    SELECT jsonb_build_object('label', f.number || ' · ' || f.title || ' (periodic review)', 'record_kind', 'fmea', 'record_id', f.id, 'site_id', NULL, 'owner_user_id', f.owner_user_id,
             'fmea_kind', f.kind, 'title', f.title, 'days_overdue', greatest(current_date - coalesce((p_payload ->> 'due_on')::date, f.next_review_on), 0))
      INTO v FROM public.fmeas f WHERE f.id = p_entity_id AND f.organisation_id = p_organisation_id AND f.status = 'active';
  ELSIF p_entity_type = 'quality_alert' THEN$b$,
  $m$p_entity_type = 'fmea_revision'$m$);

-- ---------------------------------------------------------------------------
-- The reminders areas
-- ---------------------------------------------------------------------------
SELECT pg_temp.patch('app.reminder_areas()'::regprocedure,
  $a$('competence',$a$,
  $b$('fmea_actions',    16, 'FMEA actions',               'Actions on an FMEA that were given to you',                        7),
    ('fmea_reviews',    17, 'FMEA reviews',               'FMEAs you own that are due for their periodic review',            30),
    ('competence',$b$,
  $m$'fmea_actions'$m$);

SELECT pg_temp.patch('app.reminder_candidates(uuid, date)'::regprocedure,
  $a$-- Gauge R&R studies that expire:$a$,
  $b$-- FMEA actions: an open action on an FMEA that is a draft or in force, for the member or the employee's sign-in it was given to.
    SELECT coalesce(a.owner_user_id, e.auth_id), 'fmea_actions'::text, a.id, f.id, f.number || ' · ' || left(a.description, 120), a.due_on, 'fmea.read'::text, NULL::uuid
      FROM public.fmea_actions a
      JOIN public.fmea_revisions r ON r.id = a.revision_id AND r.organisation_id = a.organisation_id AND r.status IN ('draft', 'effective')
      JOIN public.fmeas f ON f.id = r.fmea_id AND f.organisation_id = a.organisation_id AND f.status IN ('draft', 'active')
      LEFT JOIN public."Employees" e ON e.id = a.owner_employee_id AND e.organisation_id = a.organisation_id AND e.auth_id IS NOT NULL
     WHERE a.organisation_id = p_organisation_id AND a.status = 'open'
    UNION ALL
    -- FMEA reviews: an FMEA in force, for its owner.
    SELECT f.owner_user_id, 'fmea_reviews'::text, f.id, f.id, f.number || ' · ' || left(f.title, 120) || ' (periodic review)', f.next_review_on, 'fmea.read'::text, NULL::uuid
      FROM public.fmeas f
     WHERE f.organisation_id = p_organisation_id AND f.status = 'active' AND f.next_review_on IS NOT NULL
    UNION ALL
    -- Gauge R&R studies that expire:$b$,
  $m$-- FMEA actions:$m$);
