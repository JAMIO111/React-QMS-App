-- Change management, slice CH5a (docs/change-management-plan.md §8): workflow triggers for a change and two reminders areas. Information only.
--
--  * Three things a workflow rule can start from, written to the outbox by one AFTER trigger on change_requests (nothing else changes):
--      change.submitted  a draft goes to assessment            change.approved  the board's last approval makes it approved (the first time only)
--      change.closed     the effectiveness check closes it
--    Facts a rule can test: the stage it came from and went to, urgency, the type (key), whether the type usually needs the customer, the customer approval
--    state, the cut-in kind, and, once closed, the result of the latest effectiveness check. Rules still only tell people, give tasks and hold lots (W6).
--  * Reminders area change_tasks: the open tasks of a change that is still running, for the person each was given to (due date set on the task).
--  * Reminders area change_signoffs: a sign-off waiting in the current round of a change at the board, for the signer. A sign-off has no due date, so the rule is
--    stated here: it counts as due seven days after it was asked for (the person is reminded from five days). Nothing is decided for the signer.
-- app.workflow_triggers(), app.system_workflow_facts(), app.reminder_areas() and app.reminder_candidates() are shared, so they are changed by a checked text patch
-- from their live definitions (the migration refuses to finish unless the anchor is found exactly once): nothing a later migration changed is lost.
CREATE OR REPLACE FUNCTION pg_temp.patch(p_fn regprocedure, p_old text, p_new text, p_marker text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_def text := replace(pg_get_functiondef(p_fn), E'\r', ''); v_n integer;
BEGIN
  -- Already applied (this migration has been run before): nothing to do.
  IF p_marker IS NOT NULL AND position(p_marker IN v_def) > 0 THEN RETURN; END IF;
  v_n := (length(v_def) - length(replace(v_def, p_old, ''))) / length(p_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'Expected to find % exactly once in %, found % times', p_old, p_fn, v_n; END IF;
  EXECUTE replace(v_def, p_old, p_new);
END $$;

-- Repair: a migration that patches a function by text (20260429100000, Gauge R&R) adds its piece again every time it is run, because its anchor is still there
-- afterwards. If it was run more than once, the function holds the piece twice (a trigger or area listed twice, a branch twice). Every copy of a piece after
-- the first is removed, wherever it sits; nothing changes when there is no duplicate. `p_block` is a regular expression for one whole piece.
CREATE OR REPLACE FUNCTION pg_temp.dedupe(p_fn regprocedure, p_block text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_orig text := replace(pg_get_functiondef(p_fn), E'\r', ''); v_def text := v_orig; v_piece text; v_pos integer;
BEGIN
  FOR v_piece IN SELECT DISTINCT m[1] FROM regexp_matches(v_def, '(' || p_block || ')', 'g') AS m LOOP
    v_pos := strpos(v_def, v_piece);
    IF v_pos > 0 THEN
      v_def := left(v_def, v_pos - 1 + length(v_piece)) || replace(substr(v_def, v_pos + length(v_piece)), v_piece, '');
    END IF;
  END LOOP;
  IF v_def <> v_orig THEN EXECUTE v_def; END IF;
END $$;

SELECT pg_temp.dedupe('app.workflow_triggers()'::regprocedure, '\n[^\n]*''msa\.study\.completed''[^\n]*');
SELECT pg_temp.dedupe('app.reminder_areas()'::regprocedure, '\n[^\n]*''msa_studies'',[^\n]*');
SELECT pg_temp.dedupe('app.system_workflow_facts(uuid, text, uuid, jsonb)'::regprocedure, 'ELSIF p_entity_type = ''msa_study'' THEN(?:(?!ELSIF).)*');
SELECT pg_temp.dedupe('app.reminder_candidates(uuid, date)'::regprocedure, '-- Gauge R&R studies that expire:(?:(?!-- ).)*');

-- ---------------------------------------------------------------------------
-- The events (the trigger only writes to the outbox)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.workflow_emit_change_stage() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_event text;
BEGIN
  IF OLD.stage = 'draft' AND NEW.stage = 'assessment' THEN v_event := 'change.submitted';
  ELSIF OLD.stage = 'approval' AND NEW.stage = 'approved' THEN v_event := 'change.approved';
  ELSIF OLD.stage <> 'closed' AND NEW.stage = 'closed' THEN v_event := 'change.closed';
  END IF;
  IF v_event IS NOT NULL THEN
    PERFORM app.emit_event(NEW.organisation_id, v_event, 'change_request', NEW.id, jsonb_build_object('reference', NEW.reference, 'from', OLD.stage, 'to', NEW.stage));
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS change_requests_workflow_event ON public.change_requests;
CREATE TRIGGER change_requests_workflow_event AFTER UPDATE OF stage ON public.change_requests
  FOR EACH ROW WHEN (OLD.stage IS DISTINCT FROM NEW.stage) EXECUTE FUNCTION app.workflow_emit_change_stage();
REVOKE ALL ON FUNCTION app.workflow_emit_change_stage() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- What a rule can start from, and its facts
-- ---------------------------------------------------------------------------
SELECT pg_temp.patch('app.workflow_triggers()'::regprocedure,
  '(''quality_alert.issued'',',
  '(''change.submitted'',                    ''change_request'',           ''A change is submitted for assessment'',        ''change.read''),
    (''change.approved'',                     ''change_request'',           ''A change is approved'',                        ''change.read''),
    (''change.closed'',                       ''change_request'',           ''A change is closed'',                          ''change.read''),
    (''quality_alert.issued'',',
  '''change.submitted''');

SELECT pg_temp.patch('app.system_workflow_facts(uuid, text, uuid, jsonb)'::regprocedure,
  'ELSIF p_entity_type = ''quality_alert'' THEN',
  'ELSIF p_entity_type = ''change_request'' THEN
    SELECT jsonb_build_object(''label'', c.reference || '' · '' || c.title, ''record_kind'', ''change'', ''record_id'', c.id, ''site_id'', NULL, ''owner_user_id'', c.raised_by,
             ''from_stage'', p_payload ->> ''from'', ''to_stage'', coalesce(p_payload ->> ''to'', c.stage), ''urgency'', c.urgency, ''type_key'', t.key,
             ''type_needs_customer'', t.needs_customer_approval, ''customer_approval'', c.customer_approval, ''cut_in_kind'', c.cut_in_kind, ''title'', c.title,
             ''review_result'', (SELECT r.result FROM public.change_reviews r WHERE r.change_id = c.id AND r.organisation_id = c.organisation_id ORDER BY r.created_at DESC, (c.stage = ''closed'' AND r.result = ''effective'') DESC, r.id DESC LIMIT 1))
      INTO v FROM public.change_requests c JOIN public.change_types t ON t.id = c.type_id AND t.organisation_id = c.organisation_id
     WHERE c.id = p_entity_id AND c.organisation_id = p_organisation_id;
  ELSIF p_entity_type = ''quality_alert'' THEN',
  'p_entity_type = ''change_request''');

-- ---------------------------------------------------------------------------
-- The reminders areas
-- ---------------------------------------------------------------------------
SELECT pg_temp.patch('app.reminder_areas()'::regprocedure,
  '(''competence'',',
  '(''change_tasks'',    14, ''Change tasks'',             ''Tasks on a change that were given to you'',                       3),
    (''change_signoffs'',  15, ''Change sign-offs'',         ''Changes waiting for your sign-off as a board member'',            2),
    (''competence'',',
  '''change_tasks''');

SELECT pg_temp.patch('app.reminder_candidates(uuid, date)'::regprocedure,
  '-- Gauge R&R studies that expire:',
  '-- Change tasks: the person''s own open tasks on a change that is still running (they may hold no change permission).
    SELECT t.owner_user_id, ''change_tasks''::text, t.id, c.id, c.reference || '' · '' || left(t.description, 120), t.due_on, NULL::text, NULL::uuid
      FROM public.change_tasks t JOIN public.change_requests c ON c.id = t.change_id AND c.organisation_id = t.organisation_id
                                                           AND c.stage IN (''approved'', ''implementing'', ''verifying'')
     WHERE t.organisation_id = p_organisation_id AND t.status = ''open'' AND t.due_on IS NOT NULL
    UNION ALL
    -- Change sign-offs: a signer''s pending sign-off in the current round, due seven days after it was asked for.
    SELECT s.signer_user_id, ''change_signoffs''::text, s.id, c.id, c.reference || '' · '' || left(c.title, 120) || '' (sign-off)'', (s.created_at AT TIME ZONE ''UTC'')::date + 7, ''change.approve''::text, NULL::uuid
      FROM public.change_signoffs s JOIN public.change_requests c ON c.id = s.change_id AND c.organisation_id = s.organisation_id AND c.stage = ''approval'' AND c.review_round = s.round
     WHERE s.organisation_id = p_organisation_id AND s.status = ''pending''
    UNION ALL
    -- Gauge R&R studies that expire:',
  '''change_signoffs''');
