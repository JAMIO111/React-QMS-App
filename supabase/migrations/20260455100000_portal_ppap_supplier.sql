-- PPAP, slice PP5b (docs/ppap-plan.md PP12): a SUPPLIER prepares and submits a package we asked for, in the portal.
--
--  * Staff (ppap.manage) start a received package (PP5a) and ask the supplier for it. The request is the same row a customer's request is (portal_ppap_requests, PP4): pending until
--    the supplier submits (answered, naming the 'submitted' decision it wrote) or staff withdraw it. One waits at a time per package.
--  * The supplier sees the package in named fields only: the part and our revision, the level and reason in words, the elements by name with what is asked of each, and THEIR OWN files
--    (the files people of their party added; never files or links we added, notes, waiver reasons, other suppliers, people of ours). They add files to an element (the API chooses
--    the path and signs the upload after app.portal_ppap_upload_allowed), take their own files back while it is still being prepared, and submit.
--  * Submitting needs every required, non-waived element to have evidence (a file of theirs, or what staff attached). It then moves the package from being prepared to SUBMITTED
--    in one transaction, exactly as recording it as received does: links frozen, a 'submitted' decision written (by the supplier's person, "Supplier portal"), the request answered.
--    From then on it is ours: OUR decision (approved, interim, rejected) is recorded as in PP5a, and the supplier sees the outcome (the reason or conditions only for a rejection or an
--    interim approval).
--  * INFORMATION ONLY: nothing about the supplier's approval status moves (decision D3 of supplier quality).
-- Errors QM032 (409 portal_rule); another party's or organisation's record is no_data_found / P0002 (404).

ALTER TABLE public.portal_activity DROP CONSTRAINT IF EXISTS portal_activity_kind_check;
ALTER TABLE public.portal_activity
  ADD CONSTRAINT portal_activity_kind_check CHECK (kind IN ('scar_acknowledged', 'scar_response', 'scar_extension_requested', 'scar_extension_withdrawn', 'comment', 'acknowledged',
                                                             'scar_action_done', 'complaint_raised', 'closure_confirmed', 'closure_declined', 'change_requested',
                                                             'change_approved', 'change_declined', 'ppap_approved', 'ppap_interim', 'ppap_rejected', 'ppap_submitted'));

-- ---------------------------------------------------------------------------
-- 1. Staff: who a received package is from, asking, and what was asked
-- ---------------------------------------------------------------------------
-- The supplier party (portal and party both on) a received package is from. Staff with ppap.read.
CREATE FUNCTION app.ppap_supplier_party(p_submission uuid) RETURNS TABLE (party_id uuid, supplier_id uuid, party_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.ppap_submissions%ROWTYPE;
BEGIN
  SELECT * INTO s FROM public.ppap_submissions WHERE id = p_submission;
  IF NOT FOUND OR NOT app.ppap_readable(p_submission) THEN RAISE EXCEPTION 'Submission not found' USING ERRCODE = 'P0002'; END IF;
  RETURN QUERY
  SELECT p.id, p.supplier_id, sup.name
    FROM public.portal_parties p
    JOIN public.suppliers sup ON sup.id = p.supplier_id AND sup.organisation_id = p.organisation_id
    JOIN public.organisation_settings st ON st.organisation_id = p.organisation_id AND st.portal_enabled
   WHERE p.organisation_id = s.organisation_id AND p.party_kind = 'supplier' AND p.enabled AND s.direction = 'received' AND p.supplier_id = s.supplier_id;
END $$;
REVOKE ALL ON FUNCTION app.ppap_supplier_party(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.ppap_supplier_party(uuid) TO authenticated;

-- Ask the supplier to prepare and submit the package. It must still be being prepared.
CREATE FUNCTION app.request_ppap_supplier_package(p_submission uuid, p_note text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.ppap_submissions%ROWTYPE; v_party uuid; v_id uuid; v_note text := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  s := app.ppap_for_write(p_submission);
  IF s.direction <> 'received' THEN RAISE EXCEPTION 'Only a package from a supplier is asked of the supplier' USING ERRCODE = 'QM032'; END IF;
  IF s.status NOT IN ('draft', 'in_preparation') THEN
    RAISE EXCEPTION '% is %, so it cannot be asked of the supplier now', s.reference, replace(s.status, '_', ' ') USING ERRCODE = 'QM032';
  END IF;
  SELECT x.party_id INTO v_party FROM app.ppap_supplier_party(p_submission) x;
  IF v_party IS NULL THEN RAISE EXCEPTION 'That supplier is not set up for the portal' USING ERRCODE = 'QM032'; END IF;
  IF length(coalesce(v_note, '')) > 500 THEN RAISE EXCEPTION 'The message is up to 500 characters' USING ERRCODE = 'QM032'; END IF;
  IF EXISTS (SELECT 1 FROM public.portal_ppap_requests r WHERE r.submission_id = s.id AND r.status = 'pending') THEN
    RAISE EXCEPTION 'A request is already waiting for the supplier' USING ERRCODE = 'QM032';
  END IF;
  INSERT INTO public.portal_ppap_requests (organisation_id, submission_id, party_id, request_note) VALUES (s.organisation_id, s.id, v_party, v_note) RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION app.request_ppap_supplier_package(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.request_ppap_supplier_package(uuid, text) TO authenticated;

-- The requests on one submission, newest first, as staff see them: either party's, with what they answered. ppap.read. (Replaces the PP4 list, which knew customers only.)
CREATE OR REPLACE FUNCTION app.ppap_customer_requests(p_submission uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.ppap_submissions WHERE id = p_submission) OR NOT app.ppap_readable(p_submission) THEN RAISE EXCEPTION 'Submission not found' USING ERRCODE = 'P0002'; END IF;
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id', r.id, 'partyId', r.party_id, 'customer', coalesce(cus.name, sup.name), 'status', r.status, 'requestedAt', r.requested_at, 'requestNote', r.request_note,
      'requestedBy', app.portal_person_name(r.requested_by), 'answeredAt', r.answered_at, 'answeredBy', app.portal_person_name(r.answered_by),
      'decision', d.kind, 'decisionNote', d.note, 'customerReference', d.their_reference, 'expiresOn', d.expires_on,
      'withdrawnReason', r.withdrawn_reason) ORDER BY r.requested_at DESC)
    FROM (SELECT * FROM public.portal_ppap_requests WHERE submission_id = p_submission ORDER BY requested_at DESC LIMIT 20) r
    JOIN public.portal_parties p ON p.id = r.party_id
    LEFT JOIN public.customers cus ON cus.id = p.customer_id
    LEFT JOIN public.suppliers sup ON sup.id = p.supplier_id
    LEFT JOIN public.ppap_decisions d ON d.id = r.decision_id), '[]'::jsonb);
END $$;

-- ---------------------------------------------------------------------------
-- 2. The supplier
-- ---------------------------------------------------------------------------
-- The caller's own live access to the request's SUPPLIER party, else no_data_found; the request.
CREATE FUNCTION app.portal_ppap_for_supplier(p_request uuid, p_lock boolean DEFAULT false) RETURNS public.portal_ppap_requests
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.portal_ppap_requests%ROWTYPE;
BEGIN
  IF p_lock THEN SELECT * INTO r FROM public.portal_ppap_requests WHERE id = p_request FOR UPDATE;
  ELSE SELECT * INTO r FROM public.portal_ppap_requests WHERE id = p_request; END IF;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM app.portal_my_access(r.organisation_id) a WHERE a.party_id = r.party_id AND a.party_kind = 'supplier') THEN
    RAISE EXCEPTION 'request not found' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN r;
END $$;
REVOKE ALL ON FUNCTION app.portal_ppap_for_supplier(uuid, boolean) FROM PUBLIC, anon, authenticated;

-- The packages asked of the caller's own supplier party (named columns only), newest first. Withdrawn requests are not shown.
CREATE FUNCTION app.portal_list_ppap_packages(p_org uuid)
RETURNS TABLE (request_id uuid, reference text, part_number text, part_name text, level integer, status text, submission_status text, requested_at timestamptz, answered_at timestamptz, can_edit boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT r.id, s.reference, pt.part_number, pt.name, s.level, r.status, s.status, r.requested_at, r.answered_at,
         (r.status = 'pending' AND s.status IN ('draft', 'in_preparation'))
    FROM public.portal_ppap_requests r
    JOIN public.ppap_submissions s ON s.id = r.submission_id AND s.organisation_id = r.organisation_id
    JOIN public.parts pt ON pt.id = s.part_id AND pt.organisation_id = s.organisation_id
    JOIN app.portal_my_access(p_org) a ON a.party_id = r.party_id AND a.party_kind = 'supplier'
   WHERE r.organisation_id = p_org AND r.status <> 'withdrawn' AND s.direction = 'received'
   ORDER BY r.requested_at DESC LIMIT 200
$$;
REVOKE ALL ON FUNCTION app.portal_list_ppap_packages(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_list_ppap_packages(uuid) TO authenticated;

-- The files the people of the supplier's party added to a package, by element. Internal.
CREATE FUNCTION app.portal_ppap_party_evidence(p_submission uuid, p_party uuid) RETURNS SETOF public.ppap_evidence
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT v.* FROM public.ppap_evidence v
   WHERE v.submission_id = p_submission AND v.kind = 'file' AND v.removed_at IS NULL
     AND EXISTS (SELECT 1 FROM public.external_access a WHERE a.user_id = v.created_by AND a.party_id = p_party)
$$;
REVOKE ALL ON FUNCTION app.portal_ppap_party_evidence(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- What a required, non-waived element still lacks: any live evidence at all (theirs or what staff attached). Internal; the names of the elements.
CREATE FUNCTION app.portal_ppap_missing(p_submission uuid) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(array_agg(t.label ORDER BY t.ordinal), '{}'::text[])
    FROM public.ppap_elements e JOIN app.ppap_element_types() t ON t.key = e.element_key
   WHERE e.submission_id = p_submission AND e.requirement = 'required' AND e.status <> 'waived'
     AND NOT EXISTS (SELECT 1 FROM public.ppap_evidence v WHERE v.element_id = e.id AND v.removed_at IS NULL)
$$;
REVOKE ALL ON FUNCTION app.portal_ppap_missing(uuid) FROM PUBLIC, anon, authenticated;

-- One package as the supplier may see it. NAMED FIELDS ONLY (the SQL test and the e2e list the exact keys): no files or links of ours, notes, waiver reasons, other suppliers,
-- levels' rules, or people of ours. Our reason for a rejection or the conditions of an interim approval are shown; an approval's note is not.
CREATE FUNCTION app.portal_get_ppap_package(p_request uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  r public.portal_ppap_requests%ROWTYPE; s public.ppap_submissions%ROWTYPE; p public.portal_parties%ROWTYPE; pt public.parts%ROWTYPE; pr public.part_revisions%ROWTYPE;
  v_elements jsonb; v_missing text[]; v_sent date; v_last public.ppap_decisions%ROWTYPE; v_edit boolean;
BEGIN
  r := app.portal_ppap_for_supplier(p_request);
  IF r.status = 'withdrawn' THEN RAISE EXCEPTION 'request not found' USING ERRCODE = 'no_data_found'; END IF;
  SELECT * INTO s FROM public.ppap_submissions WHERE id = r.submission_id AND organisation_id = r.organisation_id;
  SELECT * INTO p FROM public.portal_parties WHERE id = r.party_id;
  SELECT * INTO pt FROM public.parts WHERE id = s.part_id;
  SELECT * INTO pr FROM public.part_revisions WHERE id = s.part_revision_id;
  SELECT d.decided_on INTO v_sent FROM public.ppap_decisions d WHERE d.submission_id = s.id AND d.kind = 'submitted' ORDER BY d.seq LIMIT 1;
  SELECT * INTO v_last FROM public.ppap_decisions d WHERE d.submission_id = s.id ORDER BY d.seq DESC LIMIT 1;
  v_edit := r.status = 'pending' AND s.status IN ('draft', 'in_preparation');
  v_missing := app.portal_ppap_missing(s.id);
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'key', e.element_key, 'name', t.label,
           'requirement', CASE e.requirement WHEN 'required' THEN 'Required' ELSE 'Keep on file' END,
           'waived', e.status = 'waived',
           'provided', e.status = 'waived' OR EXISTS (SELECT 1 FROM public.ppap_evidence v WHERE v.element_id = e.id AND v.removed_at IS NULL),
           'files', coalesce((SELECT jsonb_agg(jsonb_build_object('id', f.id, 'name', f.file_name, 'sizeBytes', f.size_bytes, 'addedAt', f.created_at, 'mine', f.created_by = auth.uid()) ORDER BY f.created_at)
                                FROM app.portal_ppap_party_evidence(s.id, r.party_id) f WHERE f.element_id = e.id), '[]'::jsonb)
         ) ORDER BY t.ordinal), '[]'::jsonb)
    INTO v_elements
    FROM public.ppap_elements e JOIN app.ppap_element_types() t ON t.key = e.element_key
   WHERE e.submission_id = s.id AND e.requirement IN ('required', 'retain');
  RETURN jsonb_build_object(
    'id', r.id, 'status', r.status, 'requestedAt', r.requested_at, 'requestNote', r.request_note,
    'reference', s.reference, 'partNumber', pt.part_number, 'partName', pt.name,
    'revision', pr.revision || CASE WHEN pr.version > 1 THEN ' v' || pr.version ELSE '' END,
    'level', s.level,
    'reason', CASE s.reason WHEN 'new_part' THEN 'New part' WHEN 'engineering_change' THEN 'Engineering change' WHEN 'tooling' THEN 'Tooling' WHEN 'discrepancy_correction' THEN 'Correction of a discrepancy'
                            WHEN 'alternate_material_or_supplier' THEN 'Alternate material or supplier' WHEN 'process_change' THEN 'Process change' WHEN 'not_produced_12_months' THEN 'Not produced for 12 months'
                            WHEN 'customer_request' THEN 'Customer request' ELSE 'Other' END,
    'submissionStatus', s.status, 'submittedOn', v_sent,
    'elements', v_elements, 'missing', to_jsonb(v_missing),
    'contact', p.contact_name,
    'answeredAt', r.answered_at,
    'decision', CASE WHEN v_last.kind IN ('approved', 'interim_approved', 'rejected') THEN v_last.kind END,
    'decisionNote', CASE WHEN v_last.kind IN ('interim_approved', 'rejected') THEN v_last.note END,
    'decisionExpiresOn', CASE WHEN v_last.kind = 'interim_approved' THEN v_last.expires_on END,
    'decidedOn', CASE WHEN v_last.kind IN ('approved', 'interim_approved', 'rejected') THEN v_last.decided_on END,
    'canEdit', v_edit, 'canSubmit', v_edit AND cardinality(v_missing) = 0);
END $$;
REVOKE ALL ON FUNCTION app.portal_get_ppap_package(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_get_ppap_package(uuid) TO authenticated;

-- Files -----------------------------------------------------------------------------------------------------------------------------------------------------------------
-- The folder a package's files go in (the submission id), for the API to build a path: only for a request the caller may edit.
CREATE FUNCTION app.portal_ppap_package_folder(p_request uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.portal_ppap_requests%ROWTYPE;
BEGIN
  r := app.portal_ppap_for_supplier(p_request);
  RETURN r.submission_id;
END $$;
REVOKE ALL ON FUNCTION app.portal_ppap_package_folder(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_ppap_package_folder(uuid) TO authenticated;

-- May this person add a file at this path to this element now? Their own party's package, still being prepared, the element asked for and not waived, the package's own folder,
-- and at most ten live files of theirs on the element.
CREATE FUNCTION app.portal_ppap_upload_allowed(p_request uuid, p_element_key text, p_path text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.portal_ppap_requests%ROWTYPE; s public.ppap_submissions%ROWTYPE; e public.ppap_elements%ROWTYPE;
BEGIN
  r := app.portal_ppap_for_supplier(p_request);
  SELECT * INTO s FROM public.ppap_submissions WHERE id = r.submission_id;
  IF r.status <> 'pending' OR s.status NOT IN ('draft', 'in_preparation') THEN RETURN false; END IF;
  SELECT * INTO e FROM public.ppap_elements WHERE submission_id = s.id AND element_key = p_element_key;
  IF NOT FOUND OR e.requirement NOT IN ('required', 'retain') OR e.status = 'waived' THEN RETURN false; END IF;
  IF p_path IS NULL OR p_path NOT LIKE s.organisation_id::text || '/ppap/' || s.id::text || '/%' OR p_path LIKE '%..%' THEN RETURN false; END IF;
  RETURN (SELECT count(*) FROM app.portal_ppap_party_evidence(s.id, r.party_id) f WHERE f.element_id = e.id) < 10;
END $$;
REVOKE ALL ON FUNCTION app.portal_ppap_upload_allowed(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_ppap_upload_allowed(uuid, text, text) TO authenticated;

-- Records a file the browser has uploaded. A required element with a file is ready; a kept-on-file one is in progress.
CREATE FUNCTION app.portal_add_ppap_file(p_request uuid, p_element_key text, p_path text, p_file_name text, p_content_type text, p_size_bytes bigint) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.portal_ppap_requests%ROWTYPE; s public.ppap_submissions%ROWTYPE; e public.ppap_elements%ROWTYPE; v_id uuid;
BEGIN
  IF NOT app.portal_ppap_upload_allowed(p_request, p_element_key, p_path) THEN
    RAISE EXCEPTION 'Files can be added to this package only while you are preparing it, to an element asked of you, and at most ten to an element' USING ERRCODE = 'QM032';
  END IF;
  r := app.portal_ppap_for_supplier(p_request);
  SELECT * INTO s FROM public.ppap_submissions WHERE id = r.submission_id FOR UPDATE;
  SELECT * INTO e FROM public.ppap_elements WHERE submission_id = s.id AND element_key = p_element_key FOR UPDATE;
  IF p_size_bytes IS NULL OR p_size_bytes < 0 OR p_size_bytes > 26214400 THEN RAISE EXCEPTION 'A file is up to 25 MB' USING ERRCODE = 'QM032'; END IF;
  IF length(btrim(coalesce(p_file_name, ''))) NOT BETWEEN 1 AND 255 THEN RAISE EXCEPTION 'Give the file a name' USING ERRCODE = 'QM032'; END IF;
  BEGIN
    INSERT INTO public.ppap_evidence (organisation_id, submission_id, element_id, kind, storage_path, file_name, content_type, size_bytes)
    VALUES (s.organisation_id, s.id, e.id, 'file', p_path, btrim(p_file_name), p_content_type, p_size_bytes) RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'That file is already recorded' USING ERRCODE = 'QM032';
  END;
  UPDATE public.ppap_elements SET status = CASE WHEN e.requirement = 'required' THEN 'ready' ELSE 'in_progress' END WHERE id = e.id AND status IN ('not_started', 'in_progress');
  PERFORM app.ppap_touch(s.id);
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION app.portal_add_ppap_file(uuid, text, text, text, text, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_add_ppap_file(uuid, text, text, text, text, bigint) TO authenticated;

-- Takes back a file of their party's while the package is still being prepared. The element goes back to in progress when its last evidence goes.
CREATE FUNCTION app.portal_remove_ppap_file(p_evidence uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.ppap_evidence%ROWTYPE; r public.portal_ppap_requests%ROWTYPE; s public.ppap_submissions%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.ppap_evidence WHERE id = p_evidence AND kind = 'file' AND removed_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'file not found' USING ERRCODE = 'no_data_found'; END IF;
  SELECT * INTO r FROM public.portal_ppap_requests WHERE submission_id = v.submission_id AND status = 'pending' ORDER BY requested_at DESC LIMIT 1;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM app.portal_my_access(v.organisation_id) a WHERE a.party_id = r.party_id AND a.party_kind = 'supplier')
     OR NOT EXISTS (SELECT 1 FROM app.portal_ppap_party_evidence(v.submission_id, r.party_id) f WHERE f.id = v.id) THEN
    RAISE EXCEPTION 'file not found' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT * INTO s FROM public.ppap_submissions WHERE id = v.submission_id FOR UPDATE;
  IF s.status NOT IN ('draft', 'in_preparation') THEN RAISE EXCEPTION 'The package has been submitted, so its files can no longer be taken back' USING ERRCODE = 'QM032'; END IF;
  UPDATE public.ppap_evidence SET removed_at = now(), removed_by = auth.uid(), remove_reason = 'Taken back by the supplier' WHERE id = v.id;
  UPDATE public.ppap_elements e SET status = 'in_progress'
   WHERE e.id = v.element_id AND e.status = 'ready' AND NOT EXISTS (SELECT 1 FROM public.ppap_evidence x WHERE x.element_id = e.id AND x.removed_at IS NULL);
  PERFORM app.ppap_touch(s.id);
  RETURN r.id;
END $$;
REVOKE ALL ON FUNCTION app.portal_remove_ppap_file(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_remove_ppap_file(uuid) TO authenticated;

-- A file of their party's on a package they may see (not taken back), for a ten-minute link.
CREATE FUNCTION app.portal_ppap_package_file_path(p_evidence uuid) RETURNS TABLE (storage_path text, file_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.ppap_evidence%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.ppap_evidence WHERE id = p_evidence AND kind = 'file' AND removed_at IS NULL;
  IF NOT FOUND OR NOT EXISTS (
       SELECT 1 FROM public.portal_ppap_requests r JOIN app.portal_my_access(v.organisation_id) a ON a.party_id = r.party_id AND a.party_kind = 'supplier'
        WHERE r.submission_id = v.submission_id AND r.status <> 'withdrawn' AND EXISTS (SELECT 1 FROM app.portal_ppap_party_evidence(v.submission_id, r.party_id) f WHERE f.id = v.id)) THEN
    RAISE EXCEPTION 'file not found' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN QUERY SELECT v.storage_path, v.file_name;
END $$;
REVOKE ALL ON FUNCTION app.portal_ppap_package_file_path(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_ppap_package_file_path(uuid) TO authenticated;

-- Submitting -----------------------------------------------------------------------------------------------------------------------------------------------------------
-- The supplier submits the package: every required element has evidence; the package is then submitted exactly as recording it as received does, written by their person.
CREATE FUNCTION app.portal_submit_ppap_package(p_request uuid, p_note text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.portal_ppap_requests%ROWTYPE; s public.ppap_submissions%ROWTYPE; v_missing text[]; v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_dec uuid; v_label text;
BEGIN
  r := app.portal_ppap_for_supplier(p_request, true);
  SELECT * INTO s FROM public.ppap_submissions WHERE id = r.submission_id FOR UPDATE;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'That request has already been answered or withdrawn' USING ERRCODE = 'QM032'; END IF;
  IF s.status NOT IN ('draft', 'in_preparation') THEN RAISE EXCEPTION 'This package is % and cannot be submitted now', replace(s.status, '_', ' ') USING ERRCODE = 'QM032'; END IF;
  IF length(coalesce(v_note, '')) > 2000 THEN RAISE EXCEPTION 'The note is up to 2,000 characters' USING ERRCODE = 'QM032'; END IF;
  v_missing := app.portal_ppap_missing(s.id);
  IF cardinality(v_missing) > 0 THEN RAISE EXCEPTION 'Still needed: %', array_to_string(v_missing, ', ') USING ERRCODE = 'QM032'; END IF;
  PERFORM app.ppap_freeze_links(s.id);
  PERFORM set_config('app.ppap_lifecycle', 'on', true);
  IF s.status = 'draft' THEN UPDATE public.ppap_submissions SET status = 'in_preparation' WHERE id = s.id; END IF;
  UPDATE public.ppap_submissions SET status = 'ready', ready_at = now() WHERE id = s.id;
  UPDATE public.ppap_submissions SET status = 'submitted', submitted_at = now(), submitted_by = auth.uid() WHERE id = s.id;
  INSERT INTO public.ppap_decisions (organisation_id, submission_id, seq, kind, decided_on, how, note, portal_request_id)
  VALUES (s.organisation_id, s.id, app.ppap_next_seq(s.id), 'submitted', current_date, 'Supplier portal', v_note, r.id) RETURNING id INTO v_dec;
  PERFORM set_config('app.ppap_lifecycle', 'off', true);
  UPDATE public.portal_ppap_requests SET status = 'answered', answered_by = auth.uid(), answered_at = now(), decision_id = v_dec WHERE id = r.id;
  v_label := s.reference || ' · ' || (SELECT pt.part_number FROM public.parts pt WHERE pt.id = s.part_id);
  PERFORM app.portal_note_activity(s.organisation_id, r.party_id, 'ppap_submitted', 'ppap', s.id, v_label, 'Submitted the package' || coalesce(': ' || left(v_note, 120), ''));
  RETURN s.id;
END $$;
REVOKE ALL ON FUNCTION app.portal_submit_ppap_package(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_submit_ppap_package(uuid, text) TO authenticated;
