-- External portal, slice PT3a (docs/external-portal-plan.md §6, decisions X2, X3, X9, X11, X12; PT0 §8): a supplier's people see the SCARs raised against
-- their company and answer them in the portal, and staff are told when a supplier acts.
--
--  * Visibility is automatic (X2): a SCAR that has been issued, for the party whose supplier it names, whatever its status afterwards. A draft is never shown.
--  * The supplier's side is five functions, each checking the caller's own live portal access to the party (the party comes from the SCAR, never from the
--    request): acknowledge, respond, request more time, withdraw that request, and the two reads. They write the SAME rows the staff functions write
--    (supplier_scar_responses, supplier_scar_extensions, the status and its history), so internal review, extension decisions and the SCAR page work unchanged.
--    The person who acted is the external account, so staff see who answered; the response also names the supplier.
--  * The external view is one function returning NAMED fields only (PT0 T3): no owner, 8D, implementation or verification detail, no linked non-conformances,
--    no staff names (a staff review note is shown as the organisation's).
--  * portal_activity: one row each time a party acts (acknowledged, responded, asked for more time, commented). It is audited, so the existing notification
--    path tells people holding external_access.share ("Acme Castings responded to SCAR-26-0004"). Written only by these functions.
-- Errors use QM032 (409 portal_rule); a SCAR that is not the caller's is P0002 (404).

-- ---------------------------------------------------------------------------
-- Activity (what staff are told)
-- ---------------------------------------------------------------------------
CREATE TABLE public.portal_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  party_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('scar_acknowledged', 'scar_response', 'scar_extension_requested', 'scar_extension_withdrawn', 'comment')),
  record_kind text NOT NULL CHECK (record_kind IN ('scar', 'ncr', 'capa')),
  record_id uuid NOT NULL,
  party_name text NOT NULL,
  record_label text NOT NULL,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT portal_activity_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT portal_activity_party_fkey FOREIGN KEY (party_id, organisation_id) REFERENCES public.portal_parties (id, organisation_id)
);
CREATE INDEX portal_activity_record_idx ON public.portal_activity (record_kind, record_id, created_at DESC);

CREATE FUNCTION app.portal_activity_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN RAISE EXCEPTION 'Portal activity is never changed or deleted' USING ERRCODE = 'QM032'; END $$;
CREATE TRIGGER portal_activity_frozen BEFORE UPDATE OR DELETE ON public.portal_activity FOR EACH ROW EXECUTE FUNCTION app.portal_activity_frozen();
CREATE TRIGGER portal_activity_stamp BEFORE INSERT ON public.portal_activity FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER audit_changes AFTER INSERT ON public.portal_activity FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.portal_activity ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.portal_activity FROM anon, authenticated;
GRANT SELECT ON public.portal_activity TO authenticated;
CREATE POLICY portal_activity_select ON public.portal_activity FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'external_access.share'));

INSERT INTO public.notification_event_types
  (key, entity_type, action, group_name, entity_label, description, permission_code, default_on, default_permission_code, label_fields, display_order, own_record, email_default)
VALUES
  ('portal_activity.created', 'portal_activity', 'created', 'External portal', 'Portal activity', 'A supplier or customer acted on something you shared or raised',
   'external_access.share', true, 'external_access.share', ARRAY['party_name', 'record_label', 'message'], 1, false, false);

-- Staff are told only once, when it is written.
CREATE FUNCTION app.portal_note_activity(p_org uuid, p_party uuid, p_kind text, p_record_kind text, p_record uuid, p_label text, p_message text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_party text;
BEGIN
  SELECT coalesce(sup.name, cus.name) INTO v_party FROM public.portal_parties p
    LEFT JOIN public.suppliers sup ON sup.id = p.supplier_id LEFT JOIN public.customers cus ON cus.id = p.customer_id WHERE p.id = p_party;
  INSERT INTO public.portal_activity (organisation_id, party_id, kind, record_kind, record_id, party_name, record_label, message)
  VALUES (p_org, p_party, p_kind, p_record_kind, p_record, coalesce(v_party, 'A supplier'), left(p_label, 200), left(p_message, 300));
END $$;
REVOKE ALL ON FUNCTION app.portal_note_activity(uuid, uuid, text, text, uuid, text, text) FROM PUBLIC, anon, authenticated;

-- A party's comment on a shared NC or 8D now tells staff too (PT2 left it to be found on the record).
CREATE OR REPLACE FUNCTION app.add_portal_comment(p_share uuid, p_body text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.portal_shares; v_id uuid; v_side text; v_label text;
BEGIN
  SELECT * INTO s FROM public.portal_shares WHERE id = p_share;
  IF NOT FOUND THEN RAISE EXCEPTION 'share not found' USING ERRCODE = 'no_data_found'; END IF;
  IF app.has_permission(s.organisation_id, 'external_access.share') THEN v_side := 'staff';
  ELSIF EXISTS (SELECT 1 FROM app.portal_my_access(s.organisation_id) a WHERE a.party_id = s.party_id) THEN v_side := 'external';
  ELSE RAISE EXCEPTION 'share not found' USING ERRCODE = 'no_data_found'; END IF;
  IF s.withdrawn_at IS NOT NULL THEN
    IF v_side = 'external' THEN RAISE EXCEPTION 'share not found' USING ERRCODE = 'no_data_found'; END IF;
    RAISE EXCEPTION 'This record is no longer shared, so it cannot be commented on' USING ERRCODE = 'QM032';
  END IF;
  IF length(btrim(coalesce(p_body, ''))) < 1 OR length(btrim(p_body)) > 4000 THEN RAISE EXCEPTION 'A comment is 1 to 4,000 characters' USING ERRCODE = 'QM032'; END IF;
  INSERT INTO public.portal_comments (organisation_id, share_id, author_side, body) VALUES (s.organisation_id, p_share, v_side, btrim(p_body)) RETURNING id INTO v_id;
  IF v_side = 'external' THEN
    SELECT coalesce(n.reference, c.reference) || ' · ' || coalesce(n.title, c.title) INTO v_label
      FROM (SELECT 1) one LEFT JOIN public.nonconformances n ON n.id = s.nonconformance_id LEFT JOIN public.capas c ON c.id = s.capa_id;
    PERFORM app.portal_note_activity(s.organisation_id, s.party_id, 'comment', s.record_kind::text, coalesce(s.nonconformance_id, s.capa_id), v_label,
                                     'Commented: ' || left(btrim(p_body), 120));
  END IF;
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------
-- The caller's own SCAR
-- ---------------------------------------------------------------------------
-- An issued SCAR for a supplier the caller has live portal access to; P0002 (404) otherwise. p_lock takes the row for an update.
CREATE FUNCTION app.portal_scar_for_external(p_scar uuid, p_lock boolean DEFAULT false) RETURNS public.supplier_scars
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.supplier_scars%ROWTYPE;
BEGIN
  IF p_lock THEN SELECT * INTO c FROM public.supplier_scars WHERE id = p_scar AND issued_at IS NOT NULL FOR UPDATE;
  ELSE SELECT * INTO c FROM public.supplier_scars WHERE id = p_scar AND issued_at IS NOT NULL; END IF;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM app.portal_my_access(c.organisation_id) a WHERE a.supplier_id = c.supplier_id) THEN
    RAISE EXCEPTION 'SCAR not found' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN c;
END $$;
REVOKE ALL ON FUNCTION app.portal_scar_for_external(uuid, boolean) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION app.portal_scar_party(p_scar public.supplier_scars) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT a.party_id FROM app.portal_my_access(p_scar.organisation_id) a WHERE a.supplier_id = p_scar.supplier_id LIMIT 1
$$;
REVOKE ALL ON FUNCTION app.portal_scar_party(public.supplier_scars) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.portal_list_scars(p_organisation_id uuid)
RETURNS TABLE (scar_id uuid, reference text, title text, severity text, status text, issued_at timestamptz, response_due_on date, awaiting_response boolean, overdue boolean,
               extension_waiting boolean, responses integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT c.id, c.reference, c.title, c.severity, c.status, c.issued_at, c.response_due_on,
         c.status IN ('issued', 'acknowledged', 'revision_requested'),
         c.status IN ('issued', 'acknowledged', 'revision_requested') AND c.response_due_on IS NOT NULL AND c.response_due_on < current_date,
         EXISTS (SELECT 1 FROM public.supplier_scar_extensions x WHERE x.scar_id = c.id AND x.status = 'pending'),
         (SELECT count(*)::int FROM public.supplier_scar_responses r WHERE r.scar_id = c.id)
    FROM public.supplier_scars c
   WHERE c.organisation_id = p_organisation_id AND c.issued_at IS NOT NULL
     AND EXISTS (SELECT 1 FROM app.portal_my_access(p_organisation_id) a WHERE a.supplier_id = c.supplier_id)
   ORDER BY c.status IN ('closed', 'cancelled'), c.response_due_on NULLS LAST, c.issued_at DESC
$$;
REVOKE ALL ON FUNCTION app.portal_list_scars(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_list_scars(uuid) TO authenticated;

-- The SCAR as the supplier sees it: named fields only.
CREATE FUNCTION app.portal_get_scar(p_scar uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.supplier_scars%ROWTYPE; v_party uuid; v_contact text; v_awaiting boolean; v_pending boolean;
BEGIN
  c := app.portal_scar_for_external(p_scar);
  v_party := app.portal_scar_party(c);
  SELECT coalesce(p.contact_name, o.name) INTO v_contact FROM public.portal_parties p JOIN public.organisations o ON o.id = p.organisation_id WHERE p.id = v_party;
  v_awaiting := c.status IN ('issued', 'acknowledged', 'revision_requested');
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
                    'review', (SELECT jsonb_build_object('decision', v.decision, 'note', v.note, 'reviewedAt', v.reviewed_at) FROM public.supplier_scar_reviews v WHERE v.response_id = r.id))
                    ORDER BY r.seq) FROM public.supplier_scar_responses r WHERE r.scar_id = c.id), '[]'::jsonb),
    'extensions', coalesce((SELECT jsonb_agg(jsonb_build_object(
                    'id', x.id, 'previousDueOn', x.previous_due_on, 'newDueOn', x.new_due_on, 'reason', x.reason, 'status', x.status, 'requestedAt', x.extended_at,
                    'decidedAt', x.decided_at, 'decisionNote', CASE WHEN x.status IN ('approved', 'rejected') THEN x.decision_note END,
                    'mine', x.extended_by IS NOT DISTINCT FROM auth.uid())
                    ORDER BY x.extended_at) FROM public.supplier_scar_extensions x WHERE x.scar_id = c.id), '[]'::jsonb),
    'canAcknowledge', c.status = 'issued',
    'canRespond', v_awaiting,
    'canRequestExtension', v_awaiting AND c.response_due_on IS NOT NULL AND NOT v_pending,
    'contact', v_contact
  );
END $$;
REVOKE ALL ON FUNCTION app.portal_get_scar(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_get_scar(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- The supplier acts
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.portal_acknowledge_scar(p_scar uuid, p_note text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.supplier_scars%ROWTYPE;
BEGIN
  c := app.portal_scar_for_external(p_scar, true);
  IF c.status <> 'issued' THEN RAISE EXCEPTION 'Only a SCAR you have not yet acknowledged can be acknowledged' USING ERRCODE = 'QM032'; END IF;
  IF p_note IS NOT NULL AND length(btrim(p_note)) > 1000 THEN RAISE EXCEPTION 'A note is up to 1,000 characters' USING ERRCODE = 'QM032'; END IF;
  PERFORM app.scar_set_status(c, 'acknowledged', coalesce(nullif(btrim(coalesce(p_note, '')), ''), 'Acknowledged in the portal'));
  PERFORM app.portal_note_activity(c.organisation_id, app.portal_scar_party(c), 'scar_acknowledged', 'scar', c.id, c.reference || ' · ' || c.title, 'Acknowledged the SCAR');
END $$;
REVOKE ALL ON FUNCTION app.portal_acknowledge_scar(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_acknowledge_scar(uuid, text) TO authenticated;

-- A response from the supplier's own people. It never closes the SCAR: it waits for our review (as for a response we record for them).
CREATE FUNCTION app.portal_respond_scar(p_scar uuid, p_root_cause text, p_containment text, p_corrective_action text, p_preventive_action text, p_planned_completion_on date,
                                        p_extent_of_condition text DEFAULT NULL, p_escape_point text DEFAULT NULL, p_responsible_name text DEFAULT NULL, p_root_cause_method text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.supplier_scars%ROWTYPE; v_seq integer; v_id uuid; v_party uuid; v_who text; v_name text;
BEGIN
  c := app.portal_scar_for_external(p_scar, true);
  v_party := app.portal_scar_party(c);
  IF c.status NOT IN ('issued', 'acknowledged', 'revision_requested') THEN RAISE EXCEPTION 'A response cannot be sent while the SCAR is %', replace(c.status, '_', ' ') USING ERRCODE = 'QM032'; END IF;
  IF p_root_cause IS NULL OR length(btrim(p_root_cause)) NOT BETWEEN 3 AND 4000 THEN RAISE EXCEPTION 'The response needs a root cause (up to 4000 characters)' USING ERRCODE = 'QM032'; END IF;
  IF p_corrective_action IS NULL OR length(btrim(p_corrective_action)) NOT BETWEEN 3 AND 4000 THEN RAISE EXCEPTION 'The response needs a corrective action (up to 4000 characters)' USING ERRCODE = 'QM032'; END IF;
  IF length(coalesce(p_containment, '')) > 4000 OR length(coalesce(p_preventive_action, '')) > 4000 OR length(coalesce(p_extent_of_condition, '')) > 4000
     OR length(coalesce(p_escape_point, '')) > 4000 OR length(coalesce(p_responsible_name, '')) > 200 THEN
    RAISE EXCEPTION 'One of the answers is too long' USING ERRCODE = 'QM032';
  END IF;
  IF p_planned_completion_on IS NOT NULL AND p_planned_completion_on < current_date THEN RAISE EXCEPTION 'The planned completion date cannot be in the past' USING ERRCODE = 'QM032'; END IF;
  IF p_root_cause_method IS NOT NULL AND p_root_cause_method NOT IN ('five_whys', 'fishbone', 'other') THEN RAISE EXCEPTION 'The root cause method is 5 whys, fishbone or other' USING ERRCODE = 'QM032'; END IF;
  SELECT coalesce(sup.name, '') INTO v_name FROM public.suppliers sup WHERE sup.id = c.supplier_id;
  v_who := left(app.portal_person_name(auth.uid()) || ' (' || v_name || ')', 200);
  SELECT coalesce(max(seq), 0) + 1 INTO v_seq FROM public.supplier_scar_responses WHERE scar_id = c.id;
  INSERT INTO public.supplier_scar_responses (organisation_id, scar_id, seq, root_cause, containment, corrective_action, preventive_action, planned_completion_on, responded_on, responded_by_name,
                                              extent_of_condition, escape_point, responsible_name, root_cause_method)
  VALUES (c.organisation_id, c.id, v_seq, btrim(p_root_cause), nullif(btrim(coalesce(p_containment, '')), ''), btrim(p_corrective_action), nullif(btrim(coalesce(p_preventive_action, '')), ''),
          p_planned_completion_on, current_date, v_who,
          nullif(btrim(coalesce(p_extent_of_condition, '')), ''), nullif(btrim(coalesce(p_escape_point, '')), ''), nullif(btrim(coalesce(p_responsible_name, '')), ''), p_root_cause_method)
  RETURNING id INTO v_id;
  PERFORM app.scar_settle_pending_extension(c.id, 'The response arrived, so the extension is no longer needed');
  PERFORM app.scar_set_status(c, 'response_received', 'Response ' || v_seq || ' sent from the portal');
  PERFORM app.portal_note_activity(c.organisation_id, v_party, 'scar_response', 'scar', c.id, c.reference || ' · ' || c.title, 'Sent response ' || v_seq || ' for review');
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION app.portal_respond_scar(uuid, text, text, text, text, date, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_respond_scar(uuid, text, text, text, text, date, text, text, text, text) TO authenticated;

-- Asking for more time. The date does not move: someone with supplier_quality.approve (never the one who asked) decides, as ever.
CREATE FUNCTION app.portal_request_scar_extension(p_scar uuid, p_new_due_on date, p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.supplier_scars%ROWTYPE; v_id uuid;
BEGIN
  c := app.portal_scar_for_external(p_scar, true);
  IF c.status NOT IN ('issued', 'acknowledged', 'revision_requested') THEN RAISE EXCEPTION 'More time can be asked for only while a response is awaited' USING ERRCODE = 'QM032'; END IF;
  IF p_new_due_on IS NULL OR c.response_due_on IS NULL OR p_new_due_on <= c.response_due_on THEN RAISE EXCEPTION 'The new date must be later than the current one' USING ERRCODE = 'QM032'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'Say why more time is needed (3 to 1000 characters)' USING ERRCODE = 'QM032'; END IF;
  IF EXISTS (SELECT 1 FROM public.supplier_scar_extensions WHERE scar_id = c.id AND status = 'pending') THEN RAISE EXCEPTION 'A request for more time is already waiting for a decision' USING ERRCODE = 'QM032'; END IF;
  INSERT INTO public.supplier_scar_extensions (organisation_id, scar_id, previous_due_on, new_due_on, reason, status)
  VALUES (c.organisation_id, c.id, c.response_due_on, p_new_due_on, btrim(p_reason), 'pending') RETURNING id INTO v_id;
  PERFORM app.portal_note_activity(c.organisation_id, app.portal_scar_party(c), 'scar_extension_requested', 'scar', c.id, c.reference || ' · ' || c.title,
                                   'Asked for more time, until ' || to_char(p_new_due_on, 'FMDD Mon YYYY'));
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION app.portal_request_scar_extension(uuid, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_request_scar_extension(uuid, date, text) TO authenticated;

-- The person who asked takes the request back while it waits.
CREATE FUNCTION app.portal_withdraw_scar_extension(p_extension uuid, p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE x public.supplier_scar_extensions%ROWTYPE; c public.supplier_scars%ROWTYPE;
BEGIN
  SELECT * INTO x FROM public.supplier_scar_extensions WHERE id = p_extension FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SCAR not found' USING ERRCODE = 'no_data_found'; END IF;
  c := app.portal_scar_for_external(x.scar_id, true);
  IF x.status <> 'pending' THEN RAISE EXCEPTION 'Only a request waiting for a decision can be withdrawn' USING ERRCODE = 'QM032'; END IF;
  IF x.extended_by IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'Only the person who asked can take the request back' USING ERRCODE = 'QM032'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'Give a reason (3 to 1000 characters)' USING ERRCODE = 'QM032'; END IF;
  UPDATE public.supplier_scar_extensions SET status = 'withdrawn', decided_at = now(), decided_by = auth.uid(), decision_note = btrim(p_reason) WHERE id = x.id;
  PERFORM app.portal_note_activity(c.organisation_id, app.portal_scar_party(c), 'scar_extension_withdrawn', 'scar', c.id, c.reference || ' · ' || c.title, 'Took back the request for more time');
  RETURN c.id;
END $$;
REVOKE ALL ON FUNCTION app.portal_withdraw_scar_extension(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_withdraw_scar_extension(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Staff: who to email when we issue, review or decide (the party's active people with a confirmed address)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.portal_scar_recipients(p_scar uuid) RETURNS TABLE (email text, name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.supplier_scars%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.supplier_scars WHERE id = p_scar;
  IF NOT FOUND OR NOT app.has_permission(c.organisation_id, 'supplier_quality.manage') THEN RAISE EXCEPTION 'SCAR not found' USING ERRCODE = 'no_data_found'; END IF;
  RETURN QUERY
  SELECT u.email::text, app.portal_person_name(u.id)
    FROM public.portal_parties p
    JOIN public.organisation_settings s ON s.organisation_id = p.organisation_id AND s.portal_enabled
    JOIN public.external_access a ON a.party_id = p.id AND a.organisation_id = p.organisation_id AND a.status = 'active'
    JOIN auth.users u ON u.id = a.user_id AND u.email_confirmed_at IS NOT NULL
   WHERE p.organisation_id = c.organisation_id AND p.supplier_id = c.supplier_id AND p.enabled AND c.issued_at IS NOT NULL;
END $$;
REVOKE ALL ON FUNCTION app.portal_scar_recipients(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_scar_recipients(uuid) TO authenticated;

REVOKE ALL ON FUNCTION app.portal_activity_frozen() FROM PUBLIC, anon, authenticated;

-- The sign-in drift check (SS4): portal_activity.created_by is a stamp like every other table's, so nothing new to classify.
