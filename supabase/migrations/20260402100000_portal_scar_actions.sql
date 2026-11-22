-- External portal, slice PT3d (docs/external-portal-plan.md §6, decisions X2, X3): actions staff set on a corrective action request (SCAR) that the
-- supplier's people see in the portal and complete with a result note.
--
--  * supplier_scar_actions: "what we ask you to do, by when". Written by staff with supplier_quality.manage (add, edit while open, cancel with a reason,
--    reopen a finished one with a reason) and **completed by the supplier's people through app.portal_complete_scar_action**, which checks the caller's own
--    live portal access to the SCAR's supplier (the party comes from the SCAR, never the request). Nothing is ever deleted. A SCAR that is closed or cancelled
--    keeps its actions as they were. Actions never move the SCAR's status: the response and its review stay the way a SCAR moves.
--  * The supplier sees an action's wording, due date, state and its own result note; never who set it, cancelled actions, or staff names.
--  * Staff are told when the supplier completes one (portal_activity, as for the rest of the SCAR).
-- Errors use QM020 (409 supplier_rule) for staff rules, QM032 (409 portal_rule) for the supplier's side; another organisation's ids are P0002 (404).

CREATE TABLE public.supplier_scar_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  scar_id uuid NOT NULL,
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 3 AND 1000),
  due_on date,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  result_note text CHECK (result_note IS NULL OR length(btrim(result_note)) BETWEEN 3 AND 2000),
  done_at timestamptz,
  done_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  done_by_name text CHECK (done_by_name IS NULL OR length(done_by_name) <= 200),
  cancel_reason text CHECK (cancel_reason IS NULL OR length(btrim(cancel_reason)) BETWEEN 3 AND 1000),
  cancelled_at timestamptz,
  cancelled_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  reopen_reason text CHECK (reopen_reason IS NULL OR length(btrim(reopen_reason)) BETWEEN 3 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT supplier_scar_actions_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT supplier_scar_actions_scar_fkey FOREIGN KEY (scar_id, organisation_id) REFERENCES public.supplier_scars (id, organisation_id),
  CONSTRAINT supplier_scar_actions_state CHECK (
    (status = 'open' AND done_at IS NULL AND result_note IS NULL AND cancelled_at IS NULL)
 OR (status = 'done' AND done_at IS NOT NULL AND result_note IS NOT NULL AND cancelled_at IS NULL)
 OR (status = 'cancelled' AND cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL AND done_at IS NULL))
);
CREATE INDEX supplier_scar_actions_scar_idx ON public.supplier_scar_actions (scar_id, status);

CREATE FUNCTION app.supplier_scar_action_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'An action is never deleted. Cancel it with a reason.' USING ERRCODE = 'QM020'; END IF;
  IF NEW.scar_id <> OLD.scar_id THEN RAISE EXCEPTION 'An action cannot move to another SCAR' USING ERRCODE = 'QM020'; END IF;
  IF OLD.status = 'cancelled' THEN RAISE EXCEPTION 'A cancelled action stays cancelled. Add a new one.' USING ERRCODE = 'QM020'; END IF;
  IF OLD.status = 'done' AND NEW.status = 'done' AND (NEW.description <> OLD.description OR NEW.due_on IS DISTINCT FROM OLD.due_on OR NEW.result_note IS DISTINCT FROM OLD.result_note) THEN
    RAISE EXCEPTION 'A finished action is kept as it was. Reopen it first.' USING ERRCODE = 'QM020';
  END IF;
  IF OLD.status = 'done' AND NEW.status = 'cancelled' THEN RAISE EXCEPTION 'A finished action cannot be cancelled. Reopen it first.' USING ERRCODE = 'QM020'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER supplier_scar_actions_rules BEFORE UPDATE OR DELETE ON public.supplier_scar_actions FOR EACH ROW EXECUTE FUNCTION app.supplier_scar_action_rules();
CREATE TRIGGER supplier_scar_actions_stamp BEFORE INSERT ON public.supplier_scar_actions FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER supplier_scar_actions_touch BEFORE UPDATE ON public.supplier_scar_actions FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER supplier_scar_actions_org_immutable BEFORE UPDATE ON public.supplier_scar_actions FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.supplier_scar_actions FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.supplier_scar_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.supplier_scar_actions FROM anon, authenticated;
GRANT SELECT ON public.supplier_scar_actions TO authenticated;
CREATE POLICY supplier_scar_actions_select ON public.supplier_scar_actions FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'supplier_quality.read'));
REVOKE ALL ON FUNCTION app.supplier_scar_action_rules() FROM PUBLIC, anon, authenticated;

-- Activity can now be "completed an action".
ALTER TABLE public.portal_activity DROP CONSTRAINT IF EXISTS portal_activity_kind_check;
ALTER TABLE public.portal_activity
  ADD CONSTRAINT portal_activity_kind_check CHECK (kind IN ('scar_acknowledged', 'scar_response', 'scar_extension_requested', 'scar_extension_withdrawn', 'comment', 'acknowledged', 'scar_action_done'));

-- ---------------------------------------------------------------------------
-- Staff
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.add_scar_action(p_scar uuid, p_description text, p_due_on date) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.supplier_scars%ROWTYPE; v_id uuid;
BEGIN
  c := app.scar_for_write(p_scar);
  IF c.status IN ('closed', 'cancelled') THEN RAISE EXCEPTION 'A % SCAR cannot be changed', c.status USING ERRCODE = 'QM020'; END IF;
  IF length(btrim(coalesce(p_description, ''))) < 3 OR length(btrim(p_description)) > 1000 THEN RAISE EXCEPTION 'Say what is asked, in 3 to 1,000 characters' USING ERRCODE = 'QM020'; END IF;
  IF p_due_on IS NOT NULL AND p_due_on < current_date THEN RAISE EXCEPTION 'The due date cannot be in the past' USING ERRCODE = 'QM020'; END IF;
  INSERT INTO public.supplier_scar_actions (organisation_id, scar_id, description, due_on) VALUES (c.organisation_id, c.id, btrim(p_description), p_due_on) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION app.supplier_scar_action_for_write(p_action uuid) RETURNS public.supplier_scar_actions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.supplier_scar_actions%ROWTYPE; c public.supplier_scars%ROWTYPE;
BEGIN
  SELECT * INTO a FROM public.supplier_scar_actions WHERE id = p_action;
  IF NOT FOUND OR NOT app.is_member(a.organisation_id) THEN RAISE EXCEPTION 'Action not found' USING ERRCODE = 'P0002'; END IF;
  c := app.scar_for_write(a.scar_id);
  IF c.status IN ('closed', 'cancelled') THEN RAISE EXCEPTION 'A % SCAR cannot be changed', c.status USING ERRCODE = 'QM020'; END IF;
  SELECT * INTO a FROM public.supplier_scar_actions WHERE id = p_action FOR UPDATE;
  RETURN a;
END $$;
REVOKE ALL ON FUNCTION app.supplier_scar_action_for_write(uuid) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION app.update_scar_action(p_action uuid, p_description text, p_due_on date) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.supplier_scar_actions%ROWTYPE;
BEGIN
  a := app.supplier_scar_action_for_write(p_action);
  IF a.status <> 'open' THEN RAISE EXCEPTION 'Only an open action can be changed' USING ERRCODE = 'QM020'; END IF;
  IF length(btrim(coalesce(p_description, ''))) < 3 OR length(btrim(p_description)) > 1000 THEN RAISE EXCEPTION 'Say what is asked, in 3 to 1,000 characters' USING ERRCODE = 'QM020'; END IF;
  IF p_due_on IS NOT NULL AND p_due_on < current_date AND p_due_on IS DISTINCT FROM a.due_on THEN RAISE EXCEPTION 'The due date cannot be in the past' USING ERRCODE = 'QM020'; END IF;
  UPDATE public.supplier_scar_actions SET description = btrim(p_description), due_on = p_due_on WHERE id = a.id;
END $$;

CREATE FUNCTION app.cancel_scar_action(p_action uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.supplier_scar_actions%ROWTYPE;
BEGIN
  a := app.supplier_scar_action_for_write(p_action);
  IF a.status <> 'open' THEN RAISE EXCEPTION 'Only an open action can be cancelled' USING ERRCODE = 'QM020'; END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 3 OR length(btrim(p_reason)) > 1000 THEN RAISE EXCEPTION 'Give a reason, in 3 to 1,000 characters' USING ERRCODE = 'QM020'; END IF;
  UPDATE public.supplier_scar_actions SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), cancel_reason = btrim(p_reason) WHERE id = a.id;
END $$;

CREATE FUNCTION app.reopen_scar_action(p_action uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.supplier_scar_actions%ROWTYPE;
BEGIN
  a := app.supplier_scar_action_for_write(p_action);
  IF a.status <> 'done' THEN RAISE EXCEPTION 'Only a finished action can be reopened' USING ERRCODE = 'QM020'; END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 3 OR length(btrim(p_reason)) > 1000 THEN RAISE EXCEPTION 'Say why it is reopened, in 3 to 1,000 characters' USING ERRCODE = 'QM020'; END IF;
  UPDATE public.supplier_scar_actions SET status = 'open', done_at = NULL, done_by = NULL, done_by_name = NULL, result_note = NULL, reopen_reason = btrim(p_reason) WHERE id = a.id;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['add_scar_action(uuid,text,date)', 'update_scar_action(uuid,text,date)', 'cancel_scar_action(uuid,text)', 'reopen_scar_action(uuid,text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION app.%s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION app.%s TO authenticated', f);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- The supplier's side
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.portal_complete_scar_action(p_action uuid, p_note text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.supplier_scar_actions%ROWTYPE; c public.supplier_scars%ROWTYPE; v_scar uuid; v_party uuid;
BEGIN
  SELECT scar_id INTO v_scar FROM public.supplier_scar_actions WHERE id = p_action;
  IF NOT FOUND THEN RAISE EXCEPTION 'Action not found' USING ERRCODE = 'no_data_found'; END IF;
  c := app.portal_scar_for_external(v_scar, true);
  SELECT * INTO a FROM public.supplier_scar_actions WHERE id = p_action AND scar_id = c.id AND status <> 'cancelled' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Action not found' USING ERRCODE = 'no_data_found'; END IF;
  IF c.status IN ('closed', 'cancelled') THEN RAISE EXCEPTION 'This request is %, so the action cannot be changed', c.status USING ERRCODE = 'QM032'; END IF;
  IF a.status <> 'open' THEN RAISE EXCEPTION 'That action is already done' USING ERRCODE = 'QM032'; END IF;
  IF length(btrim(coalesce(p_note, ''))) < 3 OR length(btrim(p_note)) > 2000 THEN RAISE EXCEPTION 'Say what was done, in 3 to 2,000 characters' USING ERRCODE = 'QM032'; END IF;
  UPDATE public.supplier_scar_actions SET status = 'done', done_at = now(), done_by = auth.uid(), done_by_name = left(app.portal_person_name(auth.uid()), 200), result_note = btrim(p_note) WHERE id = a.id;
  v_party := app.portal_scar_party(c);
  PERFORM app.portal_note_activity(c.organisation_id, v_party, 'scar_action_done', 'scar', c.id, c.reference || ' · ' || c.title, 'Completed an action: ' || left(a.description, 120));
  RETURN c.id;
END $$;
REVOKE ALL ON FUNCTION app.portal_complete_scar_action(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_complete_scar_action(uuid, text) TO authenticated;

-- Open and late actions per SCAR for the portal home (a separate answer, so the SCAR list keeps its shape).
CREATE FUNCTION app.portal_scar_action_counts(p_organisation_id uuid) RETURNS TABLE (scar_id uuid, open_actions integer, late_actions integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT x.scar_id, count(*) FILTER (WHERE x.status = 'open')::int, count(*) FILTER (WHERE x.status = 'open' AND x.due_on IS NOT NULL AND x.due_on < current_date)::int
    FROM public.supplier_scar_actions x
    JOIN public.supplier_scars c ON c.id = x.scar_id AND c.organisation_id = x.organisation_id AND c.issued_at IS NOT NULL AND c.status NOT IN ('closed', 'cancelled')
   WHERE x.organisation_id = p_organisation_id
     AND EXISTS (SELECT 1 FROM app.portal_my_access(p_organisation_id) a WHERE a.supplier_id = c.supplier_id)
   GROUP BY x.scar_id
$$;
REVOKE ALL ON FUNCTION app.portal_scar_action_counts(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_scar_action_counts(uuid) TO authenticated;

-- The curated SCAR view (PT3b's) plus the actions: named fields only.
CREATE OR REPLACE FUNCTION app.portal_get_scar(p_scar uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.supplier_scars%ROWTYPE; v_party uuid; v_contact text; v_awaiting boolean; v_pending boolean; v_running boolean;
BEGIN
  c := app.portal_scar_for_external(p_scar);
  v_party := app.portal_scar_party(c);
  SELECT coalesce(p.contact_name, o.name) INTO v_contact FROM public.portal_parties p JOIN public.organisations o ON o.id = p.organisation_id WHERE p.id = v_party;
  v_awaiting := c.status IN ('issued', 'acknowledged', 'revision_requested');
  v_running := c.status NOT IN ('closed', 'cancelled');
  v_pending := EXISTS (SELECT 1 FROM public.supplier_scar_extensions x WHERE x.scar_id = c.id AND x.status = 'pending');
  RETURN jsonb_build_object(
    'reference', c.reference,
    'title', c.title,
    'severity', c.severity,
    'status', c.status,
    'issuedAt', c.issued_at,
    'responseDueOn', c.response_due_on,
    'originalResponseDueOn', c.original_response_due_on,
    'overdue', v_awaiting AND c.response_due_on IS NOT NULL AND c.response_due_on < current_date,
    'problemDescription', c.problem_description,
    'requirementBreached', c.requirement_breached,
    'objectiveEvidence', c.objective_evidence,
    'containmentRequirements', c.containment_requirements,
    'cancelReason', CASE WHEN c.status = 'cancelled' THEN c.cancel_reason END,
    'items', coalesce((SELECT jsonb_agg(jsonb_build_object('partNumber', pt.part_number, 'partName', pt.name, 'material', i.material, 'lotNumber', l.lot_number,
                                                          'receiptReference', i.receipt_reference, 'quantity', i.quantity, 'notes', i.notes) ORDER BY i.created_at)
                         FROM public.supplier_scar_items i
                         LEFT JOIN public.parts pt ON pt.id = i.part_id
                         LEFT JOIN public.lots l ON l.id = i.lot_id
                        WHERE i.scar_id = c.id AND i.ended_at IS NULL), '[]'::jsonb),
    'responses', coalesce((SELECT jsonb_agg(jsonb_build_object(
                    'seq', r.seq, 'respondedOn', r.responded_on, 'respondedBy', r.responded_by_name,
                    'rootCause', r.root_cause, 'rootCauseMethod', r.root_cause_method, 'extentOfCondition', r.extent_of_condition, 'escapePoint', r.escape_point,
                    'containment', r.containment, 'correctiveAction', r.corrective_action, 'preventiveAction', r.preventive_action,
                    'plannedCompletionOn', r.planned_completion_on, 'responsibleName', r.responsible_name,
                    'files', coalesce((SELECT jsonb_agg(jsonb_build_object('id', f.id, 'fileName', f.file_name, 'sizeBytes', f.size_bytes) ORDER BY f.created_at)
                                         FROM public.supplier_scar_files f WHERE f.response_id = r.id AND f.removed_at IS NULL), '[]'::jsonb),
                    'review', (SELECT jsonb_build_object('decision', v.decision, 'note', v.note, 'reviewedAt', v.reviewed_at) FROM public.supplier_scar_reviews v WHERE v.response_id = r.id))
                    ORDER BY r.seq) FROM public.supplier_scar_responses r WHERE r.scar_id = c.id), '[]'::jsonb),
    'extensions', coalesce((SELECT jsonb_agg(jsonb_build_object(
                    'id', x.id, 'previousDueOn', x.previous_due_on, 'newDueOn', x.new_due_on, 'reason', x.reason, 'status', x.status, 'requestedAt', x.extended_at,
                    'decidedAt', x.decided_at, 'decisionNote', CASE WHEN x.status IN ('approved', 'rejected') THEN x.decision_note END,
                    'mine', x.extended_by IS NOT DISTINCT FROM auth.uid())
                    ORDER BY x.extended_at) FROM public.supplier_scar_extensions x WHERE x.scar_id = c.id), '[]'::jsonb),
    'actions', coalesce((SELECT jsonb_agg(jsonb_build_object(
                    'id', x.id, 'description', x.description, 'dueOn', x.due_on, 'status', x.status,
                    'overdue', x.status = 'open' AND x.due_on IS NOT NULL AND x.due_on < current_date,
                    'resultNote', x.result_note, 'completedAt', x.done_at, 'completedBy', x.done_by_name,
                    'canComplete', x.status = 'open' AND v_running)
                    ORDER BY x.status = 'done', x.due_on NULLS LAST, x.created_at)
                  FROM public.supplier_scar_actions x WHERE x.scar_id = c.id AND x.status <> 'cancelled'), '[]'::jsonb),
    'draftFiles', coalesce((SELECT jsonb_agg(jsonb_build_object('id', f.id, 'fileName', f.file_name, 'sizeBytes', f.size_bytes, 'mine', f.uploaded_by IS NOT DISTINCT FROM auth.uid()) ORDER BY f.created_at)
                              FROM public.supplier_scar_files f WHERE f.scar_id = c.id AND f.response_id IS NULL AND f.removed_at IS NULL), '[]'::jsonb),
    'canAcknowledge', c.status = 'issued',
    'canRespond', v_awaiting,
    'canRequestExtension', v_awaiting AND c.response_due_on IS NOT NULL AND NOT v_pending,
    'contact', v_contact
  );
END $$;
