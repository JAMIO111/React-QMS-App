-- External portal, slice PT3b (docs/external-portal-plan.md §6): evidence files on a SCAR response.
--
--  * supplier_scar_files: a file the supplier's people upload against a SCAR while a response is awaited. It is first an unsent file (response_id empty, the
--    person may take it back); sending a response attaches every unsent file of that SCAR to it, and from then on it is frozen. Removed means marked, never
--    deleted. Written only by functions.
--  * Files are stored in the private scar-files bucket at <organisation>/scar/<scar id>/<uuid>-<name>. Staff read them through the ordinary /files routes
--    (supplier_quality.read); nobody writes the bucket directly: the supplier uploads through the API, which checks app.portal_scar_upload_allowed first
--    (their own live portal access to that SCAR, a response awaited, the right folder, at most ten unsent files) and signs the link with the service key.
--  * Downloads by the supplier go through app.portal_scar_file_path (a file of a SCAR they may see, not removed).
-- Errors use QM032 (409 portal_rule); a SCAR or file that is not the caller's is P0002 (404).

INSERT INTO storage.buckets (id, name, public) VALUES ('scar-files', 'scar-files', false) ON CONFLICT (id) DO NOTHING;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'storage' AND table_name = 'buckets' AND column_name = 'file_size_limit') THEN
    EXECUTE $q$UPDATE storage.buckets SET file_size_limit = 26214400 WHERE id = 'scar-files'$q$;
  END IF;
END $$;

CREATE TABLE public.supplier_scar_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  scar_id uuid NOT NULL,
  response_id uuid,
  storage_path text NOT NULL,
  file_name text NOT NULL CHECK (length(btrim(file_name)) BETWEEN 1 AND 255),
  content_type text CHECK (content_type IS NULL OR length(content_type) <= 150),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 26214400),
  uploaded_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  removed_at timestamptz,
  removed_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT supplier_scar_files_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT supplier_scar_files_scar_fkey FOREIGN KEY (scar_id, organisation_id) REFERENCES public.supplier_scars (id, organisation_id),
  CONSTRAINT supplier_scar_files_response_fkey FOREIGN KEY (response_id, organisation_id) REFERENCES public.supplier_scar_responses (id, organisation_id),
  CONSTRAINT supplier_scar_files_path_key UNIQUE (scar_id, storage_path),
  CONSTRAINT supplier_scar_files_path CHECK (storage_path LIKE organisation_id::text || '/scar/' || scar_id::text || '/%' AND storage_path NOT LIKE '%..%')
);
CREATE INDEX supplier_scar_files_scar_idx ON public.supplier_scar_files (scar_id);

CREATE FUNCTION app.supplier_scar_file_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A file is never deleted. It can be taken back before a response is sent.' USING ERRCODE = 'QM032'; END IF;
  IF NEW.scar_id <> OLD.scar_id OR NEW.storage_path <> OLD.storage_path OR NEW.file_name <> OLD.file_name OR NEW.size_bytes <> OLD.size_bytes
     OR NEW.content_type IS DISTINCT FROM OLD.content_type OR NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by THEN
    RAISE EXCEPTION 'A file cannot be changed' USING ERRCODE = 'QM032';
  END IF;
  IF OLD.response_id IS NOT NULL AND (NEW.response_id IS DISTINCT FROM OLD.response_id OR NEW.removed_at IS DISTINCT FROM OLD.removed_at) THEN
    RAISE EXCEPTION 'A file sent with a response is kept as it was sent' USING ERRCODE = 'QM032';
  END IF;
  IF OLD.removed_at IS NOT NULL AND (NEW.removed_at IS DISTINCT FROM OLD.removed_at OR NEW.response_id IS DISTINCT FROM OLD.response_id) THEN
    RAISE EXCEPTION 'A removed file stays removed' USING ERRCODE = 'QM032';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER supplier_scar_files_rules BEFORE UPDATE OR DELETE ON public.supplier_scar_files FOR EACH ROW EXECUTE FUNCTION app.supplier_scar_file_rules();
CREATE TRIGGER supplier_scar_files_stamp BEFORE INSERT ON public.supplier_scar_files FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER supplier_scar_files_touch BEFORE UPDATE ON public.supplier_scar_files FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER supplier_scar_files_org_immutable BEFORE UPDATE ON public.supplier_scar_files FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.supplier_scar_files FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.supplier_scar_files ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.supplier_scar_files FROM anon, authenticated;
GRANT SELECT ON public.supplier_scar_files TO authenticated;
CREATE POLICY supplier_scar_files_select ON public.supplier_scar_files FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'supplier_quality.read'));
REVOKE ALL ON FUNCTION app.supplier_scar_file_rules() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Storage: staff read; nobody writes directly (the API signs uploads after the portal rule)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.scar_file_allowed(p_object_name text, p_write boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT NOT p_write
     AND split_part(p_object_name, '/', 2) = 'scar'
     AND EXISTS (SELECT 1 FROM public.supplier_scars c
                  WHERE c.id = app.try_uuid(split_part(p_object_name, '/', 3))
                    AND c.organisation_id = app.try_uuid(split_part(p_object_name, '/', 1))
                    AND app.has_permission(c.organisation_id, 'supplier_quality.read'))
$$;
REVOKE ALL ON FUNCTION app.scar_file_allowed(text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.scar_file_allowed(text, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION app.storage_file_allowed(p_bucket text, p_name text, p_write boolean) RETURNS boolean
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT coalesce(CASE p_bucket
    WHEN 'audit-files'         THEN app.audit_file_allowed(p_name, p_write)
    WHEN 'calibration-files'   THEN app.calibration_file_allowed(p_name, CASE WHEN p_write THEN 'calibration.record' ELSE 'calibration.read' END)
    WHEN 'capa-files'          THEN app.capa_file_allowed(p_name, p_write)
    WHEN 'competence-files'    THEN app.competence_file_allowed(p_name, p_write)
    WHEN 'document-files'      THEN app.document_file_allowed(p_name, p_write)
    WHEN 'inspection-files'    THEN app.inspection_file_allowed(p_name, p_write)
    WHEN 'integration-files'   THEN app.integration_file_allowed(p_name, p_write)
    WHEN 'nc-files'            THEN app.ncr_file_allowed(p_name, CASE WHEN p_write THEN 'ncr.update' ELSE 'ncr.read' END)
    WHEN 'quality-alert-files' THEN app.quality_alert_file_allowed(p_name, p_write)
    WHEN 'scar-files'          THEN app.scar_file_allowed(p_name, p_write)
    WHEN 'supplier-files'      THEN app.supplier_file_allowed(p_name, p_write)
    WHEN 'org-logos'           THEN split_part(p_name, '/', 2) = 'logo' AND CASE WHEN p_write
                                      THEN app.has_permission(app.try_uuid(split_part(p_name, '/', 1)), 'organisation.manage')
                                      ELSE app.is_member(app.try_uuid(split_part(p_name, '/', 1))) END
    ELSE false
  END, false)
$$;

DROP POLICY IF EXISTS scar_files_insert ON storage.objects;
DROP POLICY IF EXISTS scar_files_select ON storage.objects;
CREATE POLICY scar_files_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'scar-files' AND app.storage_file_allowed(bucket_id, name, true) AND app.storage_direct_allowed(name));
CREATE POLICY scar_files_select ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'scar-files' AND app.storage_file_allowed(bucket_id, name, false) AND app.storage_direct_allowed(name));

-- ---------------------------------------------------------------------------
-- The supplier's side
-- ---------------------------------------------------------------------------
-- May the caller upload this path now? (false, never an error: the API answers 403)
CREATE FUNCTION app.portal_scar_upload_allowed(p_scar uuid, p_path text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.supplier_scars c
     WHERE c.id = p_scar AND c.issued_at IS NOT NULL AND c.status IN ('issued', 'acknowledged', 'revision_requested')
       AND EXISTS (SELECT 1 FROM app.portal_my_access(c.organisation_id) a WHERE a.supplier_id = c.supplier_id)
       AND p_path LIKE c.organisation_id::text || '/scar/' || c.id::text || '/%' AND p_path NOT LIKE '%..%'
       AND (SELECT count(*) FROM public.supplier_scar_files f WHERE f.scar_id = c.id AND f.response_id IS NULL AND f.removed_at IS NULL) < 10)
$$;
REVOKE ALL ON FUNCTION app.portal_scar_upload_allowed(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_scar_upload_allowed(uuid, text) TO authenticated;

CREATE FUNCTION app.portal_add_scar_file(p_scar uuid, p_path text, p_name text, p_type text, p_size bigint) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.supplier_scars%ROWTYPE; v_id uuid;
BEGIN
  c := app.portal_scar_for_external(p_scar, true);
  IF c.status NOT IN ('issued', 'acknowledged', 'revision_requested') THEN RAISE EXCEPTION 'Files can be added only while a response is awaited' USING ERRCODE = 'QM032'; END IF;
  IF p_path IS NULL OR p_path NOT LIKE c.organisation_id::text || '/scar/' || c.id::text || '/%' OR p_path LIKE '%..%' THEN RAISE EXCEPTION 'That file is not in this request''s folder' USING ERRCODE = 'QM032'; END IF;
  IF (SELECT count(*) FROM public.supplier_scar_files f WHERE f.scar_id = c.id AND f.response_id IS NULL AND f.removed_at IS NULL) >= 10 THEN
    RAISE EXCEPTION 'At most ten files can wait to be sent with a response' USING ERRCODE = 'QM032';
  END IF;
  IF p_size IS NULL OR p_size < 0 OR p_size > 26214400 THEN RAISE EXCEPTION 'A file can be up to 25 MB' USING ERRCODE = 'QM032'; END IF;
  IF p_name IS NULL OR length(btrim(p_name)) NOT BETWEEN 1 AND 255 THEN RAISE EXCEPTION 'The file needs a name' USING ERRCODE = 'QM032'; END IF;
  INSERT INTO public.supplier_scar_files (organisation_id, scar_id, storage_path, file_name, content_type, size_bytes)
  VALUES (c.organisation_id, c.id, p_path, btrim(p_name), nullif(btrim(coalesce(p_type, '')), ''), p_size) RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION app.portal_add_scar_file(uuid, text, text, text, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_add_scar_file(uuid, text, text, text, bigint) TO authenticated;

-- Take back a file that has not been sent yet (yours or a colleague's); answers with the SCAR.
CREATE FUNCTION app.portal_remove_scar_file(p_file uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE f public.supplier_scar_files%ROWTYPE; c public.supplier_scars%ROWTYPE;
BEGIN
  SELECT * INTO f FROM public.supplier_scar_files WHERE id = p_file FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'file not found' USING ERRCODE = 'no_data_found'; END IF;
  c := app.portal_scar_for_external(f.scar_id, true);
  IF f.response_id IS NOT NULL THEN RAISE EXCEPTION 'A file that was sent with a response stays with it' USING ERRCODE = 'QM032'; END IF;
  IF f.removed_at IS NOT NULL THEN RAISE EXCEPTION 'That file is already removed' USING ERRCODE = 'QM032'; END IF;
  UPDATE public.supplier_scar_files SET removed_at = now(), removed_by = auth.uid() WHERE id = f.id;
  RETURN c.id;
END $$;
REVOKE ALL ON FUNCTION app.portal_remove_scar_file(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_remove_scar_file(uuid) TO authenticated;

-- Where a file the supplier may see is stored, to sign a short link for it.
CREATE FUNCTION app.portal_scar_file_path(p_file uuid) RETURNS TABLE (storage_path text, file_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE f public.supplier_scar_files%ROWTYPE; c public.supplier_scars%ROWTYPE;
BEGIN
  SELECT * INTO f FROM public.supplier_scar_files WHERE id = p_file AND removed_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'file not found' USING ERRCODE = 'no_data_found'; END IF;
  c := app.portal_scar_for_external(f.scar_id);
  RETURN QUERY SELECT f.storage_path, f.file_name;
END $$;
REVOKE ALL ON FUNCTION app.portal_scar_file_path(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_scar_file_path(uuid) TO authenticated;

-- A response now takes the unsent files with it, and the supplier's view lists them.
CREATE OR REPLACE FUNCTION app.portal_respond_scar(p_scar uuid, p_root_cause text, p_containment text, p_corrective_action text, p_preventive_action text, p_planned_completion_on date,
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
  UPDATE public.supplier_scar_files SET response_id = v_id WHERE scar_id = c.id AND response_id IS NULL AND removed_at IS NULL;
  PERFORM app.scar_settle_pending_extension(c.id, 'The response arrived, so the extension is no longer needed');
  PERFORM app.scar_set_status(c, 'response_received', 'Response ' || v_seq || ' sent from the portal');
  PERFORM app.portal_note_activity(c.organisation_id, v_party, 'scar_response', 'scar', c.id, c.reference || ' · ' || c.title, 'Sent response ' || v_seq || ' for review');
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION app.portal_get_scar(p_scar uuid) RETURNS jsonb
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
                    'files', coalesce((SELECT jsonb_agg(jsonb_build_object('id', f.id, 'fileName', f.file_name, 'sizeBytes', f.size_bytes) ORDER BY f.created_at)
                                         FROM public.supplier_scar_files f WHERE f.response_id = r.id AND f.removed_at IS NULL), '[]'::jsonb),
                    'review', (SELECT jsonb_build_object('decision', v.decision, 'note', v.note, 'reviewedAt', v.reviewed_at) FROM public.supplier_scar_reviews v WHERE v.response_id = r.id))
                    ORDER BY r.seq) FROM public.supplier_scar_responses r WHERE r.scar_id = c.id), '[]'::jsonb),
    'extensions', coalesce((SELECT jsonb_agg(jsonb_build_object(
                    'id', x.id, 'previousDueOn', x.previous_due_on, 'newDueOn', x.new_due_on, 'reason', x.reason, 'status', x.status, 'requestedAt', x.extended_at,
                    'decidedAt', x.decided_at, 'decisionNote', CASE WHEN x.status IN ('approved', 'rejected') THEN x.decision_note END,
                    'mine', x.extended_by IS NOT DISTINCT FROM auth.uid())
                    ORDER BY x.extended_at) FROM public.supplier_scar_extensions x WHERE x.scar_id = c.id), '[]'::jsonb),
    'draftFiles', coalesce((SELECT jsonb_agg(jsonb_build_object('id', f.id, 'fileName', f.file_name, 'sizeBytes', f.size_bytes, 'mine', f.uploaded_by IS NOT DISTINCT FROM auth.uid()) ORDER BY f.created_at)
                              FROM public.supplier_scar_files f WHERE f.scar_id = c.id AND f.response_id IS NULL AND f.removed_at IS NULL), '[]'::jsonb),
    'canAcknowledge', c.status = 'issued',
    'canRespond', v_awaiting,
    'canRequestExtension', v_awaiting AND c.response_due_on IS NOT NULL AND NOT v_pending,
    'contact', v_contact
  );
END $$;

-- The two portal functions above keep their grants (CREATE OR REPLACE).
