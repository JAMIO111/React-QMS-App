-- PPAP, slice PP4 (docs/ppap-plan.md PP12): a CUSTOMER sees a PPAP submission we sent them in the portal and answers it — approved, interim approved or rejected — with a note
-- and their own reference, as closure confirmation (PT5b) and change approvals (CH6b) work.
--
--  * Staff (ppap.manage) ask a customer to answer a submission that has been SENT (status submitted or interim approved). A request waits at a time per submission; staff withdraw
--    it with a reason, or it is settled when the decision is recorded some other way (staff record the customer's answer by hand exactly as before).
--  * The customer's answer IS the customer's decision: it is recorded as an ordinary row of ppap_decisions by the same rules staff use (app.ppap_apply_decision, shared; the
--    decision names the request it came from and the person who answered). So the status, the review date and the history move exactly as for a decision staff record. The
--    customer decides today (the day of their answer); an interim approval needs its expiry and conditions, a rejection its reason.
--  * The customer sees named fields only: the submission's reference, their part and our revision, the level and reason in words, when it was sent, the 18 elements by name with
--    whether each was provided (never evidence, files, links, notes, waiver reasons or who prepared them), the signed Part Submission Warrant and who to contact. Never other
--    customers, suppliers, FMEAs, studies, costs, people of ours apart from the warrant's signer (their name is on the form). Files are not shown in this slice.
--  * Staff are told when the customer answers (portal_activity kinds ppap_approved / ppap_interim / ppap_rejected, record kind ppap).
-- Errors QM032 (409 portal_rule) for the portal's rules, QM037 (409 ppap_rule) for the PPAP's own; another party's or organisation's record is no_data_found / P0002 (404).

ALTER TABLE public.portal_activity DROP CONSTRAINT IF EXISTS portal_activity_kind_check;
ALTER TABLE public.portal_activity DROP CONSTRAINT IF EXISTS portal_activity_record_kind_check;
ALTER TABLE public.portal_activity
  ADD CONSTRAINT portal_activity_kind_check CHECK (kind IN ('scar_acknowledged', 'scar_response', 'scar_extension_requested', 'scar_extension_withdrawn', 'comment', 'acknowledged',
                                                             'scar_action_done', 'complaint_raised', 'closure_confirmed', 'closure_declined', 'change_requested',
                                                             'change_approved', 'change_declined', 'ppap_approved', 'ppap_interim', 'ppap_rejected')),
  ADD CONSTRAINT portal_activity_record_kind_check CHECK (record_kind IN ('scar', 'ncr', 'capa', 'document', 'quality_alert', 'change', 'ppap'));

-- ---------------------------------------------------------------------------
-- 1. The requests
-- ---------------------------------------------------------------------------
ALTER TABLE public.ppap_decisions ADD CONSTRAINT ppap_decisions_id_org_key UNIQUE (id, organisation_id);

CREATE TABLE public.portal_ppap_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  submission_id uuid NOT NULL,
  party_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'answered', 'withdrawn')),
  requested_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  request_note text CHECK (request_note IS NULL OR length(btrim(request_note)) BETWEEN 1 AND 500),
  answered_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  answered_at timestamptz,
  decision_id uuid,
  withdrawn_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  withdrawn_reason text CHECK (withdrawn_reason IS NULL OR length(btrim(withdrawn_reason)) BETWEEN 3 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT portal_ppap_requests_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT portal_ppap_requests_submission_fkey FOREIGN KEY (submission_id, organisation_id) REFERENCES public.ppap_submissions (id, organisation_id),
  CONSTRAINT portal_ppap_requests_party_fkey FOREIGN KEY (party_id, organisation_id) REFERENCES public.portal_parties (id, organisation_id),
  CONSTRAINT portal_ppap_requests_state CHECK (
    (status = 'pending' AND answered_at IS NULL AND decision_id IS NULL AND withdrawn_reason IS NULL)
    OR (status = 'answered' AND answered_at IS NOT NULL AND answered_by IS NOT NULL AND decision_id IS NOT NULL AND withdrawn_reason IS NULL)
    OR (status = 'withdrawn' AND withdrawn_reason IS NOT NULL AND answered_at IS NULL AND decision_id IS NULL))
);
CREATE UNIQUE INDEX portal_ppap_requests_one_pending ON public.portal_ppap_requests (submission_id) WHERE status = 'pending';
CREATE INDEX portal_ppap_requests_submission_idx ON public.portal_ppap_requests (submission_id, requested_at DESC);
CREATE INDEX portal_ppap_requests_party_idx ON public.portal_ppap_requests (party_id, requested_at DESC);

-- A decision can name the request it answers.
ALTER TABLE public.ppap_decisions ADD COLUMN portal_request_id uuid;
ALTER TABLE public.ppap_decisions
  ADD CONSTRAINT ppap_decisions_portal_request_fkey FOREIGN KEY (portal_request_id, organisation_id) REFERENCES public.portal_ppap_requests (id, organisation_id);
ALTER TABLE public.portal_ppap_requests
  ADD CONSTRAINT portal_ppap_requests_decision_fkey FOREIGN KEY (decision_id, organisation_id) REFERENCES public.ppap_decisions (id, organisation_id);

CREATE FUNCTION app.portal_ppap_request_moves() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A request for a customer''s answer is never deleted' USING ERRCODE = 'QM032'; END IF;
  IF OLD.status <> 'pending' THEN RAISE EXCEPTION 'A request that has been answered or withdrawn does not change' USING ERRCODE = 'QM032'; END IF;
  IF NEW.submission_id IS DISTINCT FROM OLD.submission_id OR NEW.party_id IS DISTINCT FROM OLD.party_id OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by THEN
    RAISE EXCEPTION 'A request keeps its submission, its customer and who asked' USING ERRCODE = 'QM032';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER portal_ppap_requests_moves BEFORE UPDATE OR DELETE ON public.portal_ppap_requests FOR EACH ROW EXECUTE FUNCTION app.portal_ppap_request_moves();
CREATE TRIGGER portal_ppap_requests_stamp BEFORE INSERT ON public.portal_ppap_requests FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER portal_ppap_requests_touch BEFORE UPDATE ON public.portal_ppap_requests FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE ON public.portal_ppap_requests FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.portal_ppap_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.portal_ppap_requests FROM anon, authenticated;
GRANT SELECT ON public.portal_ppap_requests TO authenticated;
CREATE POLICY portal_ppap_requests_select ON public.portal_ppap_requests FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'ppap.read') OR app.has_permission(organisation_id, 'external_access.share'));
REVOKE ALL ON FUNCTION app.portal_ppap_request_moves() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. The one place a decision is applied (staff recording the customer's answer, or the customer answering in the portal)
-- ---------------------------------------------------------------------------
-- No permission check here: the callers decide who may. It validates, moves the status and the review date, writes the decision and settles any waiting request.
CREATE FUNCTION app.ppap_apply_decision(p_submission uuid, p_kind text, p_decided_on date, p_their_reference text, p_expires_on date, p_note text,
                                        p_storage_path text, p_file_name text, p_content_type text, p_size_bytes bigint, p_request uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.ppap_submissions%ROWTYPE; v_sent date; v_last public.ppap_decisions%ROWTYPE; v_ref text := nullif(btrim(coalesce(p_their_reference, '')), ''); v_note text := nullif(btrim(coalesce(p_note, '')), '');
        v_review date; v_id uuid;
BEGIN
  SELECT * INTO s FROM public.ppap_submissions WHERE id = p_submission FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Submission not found' USING ERRCODE = 'P0002'; END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('approved', 'interim_approved', 'rejected') THEN RAISE EXCEPTION 'The customer''s decision is approved, interim approved or rejected' USING ERRCODE = 'QM037'; END IF;
  IF s.status NOT IN ('submitted', 'interim_approved') THEN RAISE EXCEPTION '% is %, so it takes no decision from the customer', s.reference, replace(s.status, '_', ' ') USING ERRCODE = 'QM037'; END IF;
  IF p_decided_on IS NULL THEN RAISE EXCEPTION 'Say the day the customer decided' USING ERRCODE = 'QM037'; END IF;
  IF p_decided_on > current_date THEN RAISE EXCEPTION 'The decision cannot be in the future' USING ERRCODE = 'QM037'; END IF;
  SELECT decided_on INTO v_sent FROM public.ppap_decisions WHERE submission_id = s.id AND kind = 'submitted' ORDER BY seq LIMIT 1;
  IF v_sent IS NOT NULL AND p_decided_on < v_sent THEN RAISE EXCEPTION 'The customer cannot have decided before it was sent (%)', to_char(v_sent, 'DD Mon YYYY') USING ERRCODE = 'QM037'; END IF;
  SELECT * INTO v_last FROM public.ppap_decisions WHERE submission_id = s.id ORDER BY seq DESC LIMIT 1;
  IF p_decided_on < v_last.decided_on THEN RAISE EXCEPTION 'That is earlier than the last decision recorded (%)', to_char(v_last.decided_on, 'DD Mon YYYY') USING ERRCODE = 'QM037'; END IF;
  IF v_ref IS NOT NULL AND length(v_ref) > 100 THEN RAISE EXCEPTION 'Their reference is up to 100 characters' USING ERRCODE = 'QM037'; END IF;
  IF v_note IS NOT NULL AND length(v_note) > 2000 THEN RAISE EXCEPTION 'The note is up to 2000 characters' USING ERRCODE = 'QM037'; END IF;
  IF p_kind = 'interim_approved' THEN
    IF p_expires_on IS NULL THEN RAISE EXCEPTION 'An interim approval needs the date it runs to' USING ERRCODE = 'QM037'; END IF;
    IF p_expires_on <= p_decided_on THEN RAISE EXCEPTION 'The interim approval must run past the day it was given' USING ERRCODE = 'QM037'; END IF;
    IF v_note IS NULL THEN RAISE EXCEPTION 'Write the conditions of the interim approval' USING ERRCODE = 'QM037'; END IF;
    IF s.status = 'interim_approved' AND p_expires_on <= coalesce((SELECT max(expires_on) FROM public.ppap_decisions WHERE submission_id = s.id), p_decided_on) THEN
      RAISE EXCEPTION 'A new interim approval must run later than the one before' USING ERRCODE = 'QM037';
    END IF;
  ELSE
    IF p_expires_on IS NOT NULL THEN RAISE EXCEPTION 'Only an interim approval has an expiry date' USING ERRCODE = 'QM037'; END IF;
    IF p_kind = 'rejected' AND v_note IS NULL THEN RAISE EXCEPTION 'Write why the customer rejected it' USING ERRCODE = 'QM037'; END IF;
  END IF;
  IF p_storage_path IS NOT NULL AND (p_file_name IS NULL OR p_size_bytes IS NULL OR p_storage_path NOT LIKE s.organisation_id::text || '/ppap/' || s.id::text || '/%' OR p_storage_path LIKE '%..%') THEN
    RAISE EXCEPTION 'The file must be stored in this submission''s folder' USING ERRCODE = 'QM037';
  END IF;
  PERFORM set_config('app.ppap_lifecycle', 'on', true);
  IF p_kind = 'approved' THEN v_review := (p_decided_on + make_interval(months => app.ppap_review_months()))::date; END IF;
  UPDATE public.ppap_submissions SET status = p_kind, next_review_on = v_review WHERE id = s.id;
  INSERT INTO public.ppap_decisions (organisation_id, submission_id, seq, kind, decided_on, their_reference, expires_on, note, storage_path, file_name, content_type, size_bytes, portal_request_id)
  VALUES (s.organisation_id, s.id, app.ppap_next_seq(s.id), p_kind, p_decided_on, v_ref, CASE WHEN p_kind = 'interim_approved' THEN p_expires_on END, v_note,
          p_storage_path, nullif(btrim(coalesce(p_file_name, '')), ''), p_content_type, p_size_bytes, p_request)
  RETURNING id INTO v_id;
  PERFORM set_config('app.ppap_lifecycle', 'off', true);
  -- Whoever answered, nobody is being asked any more: settle the waiting request.
  IF p_request IS NOT NULL THEN
    UPDATE public.portal_ppap_requests SET status = 'answered', answered_by = auth.uid(), answered_at = now(), decision_id = v_id WHERE id = p_request;
  ELSE
    UPDATE public.portal_ppap_requests SET status = 'withdrawn', withdrawn_by = auth.uid(), withdrawn_reason = 'The decision was recorded by us'
     WHERE submission_id = s.id AND status = 'pending';
  END IF;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION app.ppap_apply_decision(uuid, text, date, text, date, text, text, text, text, bigint, uuid) FROM PUBLIC, anon, authenticated;

-- The staff recorder of PP3, now a thin wrapper (same signature, same rules, same permission).
CREATE OR REPLACE FUNCTION app.record_ppap_decision(p_submission uuid, p_kind text, p_decided_on date, p_their_reference text DEFAULT NULL, p_expires_on date DEFAULT NULL, p_note text DEFAULT NULL,
                                                   p_storage_path text DEFAULT NULL, p_file_name text DEFAULT NULL, p_content_type text DEFAULT NULL, p_size_bytes bigint DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.ppap_for_write(p_submission, true);
  PERFORM app.ppap_apply_decision(p_submission, p_kind, p_decided_on, p_their_reference, p_expires_on, p_note, p_storage_path, p_file_name, p_content_type, p_size_bytes, NULL);
END $$;

-- ---------------------------------------------------------------------------
-- 3. Who a submission is for, and staff: ask, withdraw, read
-- ---------------------------------------------------------------------------
-- The customer party (portal and party both on) the submission was sent to. Staff with ppap.read.
CREATE FUNCTION app.ppap_customer_party(p_submission uuid) RETURNS TABLE (party_id uuid, customer_id uuid, party_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.ppap_submissions%ROWTYPE;
BEGIN
  SELECT * INTO s FROM public.ppap_submissions WHERE id = p_submission;
  IF NOT FOUND OR NOT app.ppap_readable(p_submission) THEN RAISE EXCEPTION 'Submission not found' USING ERRCODE = 'P0002'; END IF;
  RETURN QUERY
  SELECT p.id, p.customer_id, cus.name
    FROM public.portal_parties p
    JOIN public.customers cus ON cus.id = p.customer_id AND cus.organisation_id = p.organisation_id
    JOIN public.organisation_settings st ON st.organisation_id = p.organisation_id AND st.portal_enabled
   WHERE p.organisation_id = s.organisation_id AND p.party_kind = 'customer' AND p.enabled AND s.direction = 'submitted' AND p.customer_id = s.customer_id;
END $$;
REVOKE ALL ON FUNCTION app.ppap_customer_party(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.ppap_customer_party(uuid) TO authenticated;

CREATE FUNCTION app.request_ppap_customer_answer(p_submission uuid, p_note text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.ppap_submissions%ROWTYPE; v_party uuid; v_id uuid; v_note text := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  s := app.ppap_for_write(p_submission);
  IF s.direction <> 'submitted' THEN RAISE EXCEPTION 'Only a submission we sent to a customer can be put to them' USING ERRCODE = 'QM032'; END IF;
  IF s.status NOT IN ('submitted', 'interim_approved') THEN
    RAISE EXCEPTION '% is %, so it cannot be put to the customer for an answer', s.reference, replace(s.status, '_', ' ') USING ERRCODE = 'QM032';
  END IF;
  SELECT x.party_id INTO v_party FROM app.ppap_customer_party(p_submission) x;
  IF v_party IS NULL THEN RAISE EXCEPTION 'That customer is not set up for the portal' USING ERRCODE = 'QM032'; END IF;
  IF length(coalesce(v_note, '')) > 500 THEN RAISE EXCEPTION 'The message is up to 500 characters' USING ERRCODE = 'QM032'; END IF;
  IF EXISTS (SELECT 1 FROM public.portal_ppap_requests r WHERE r.submission_id = s.id AND r.status = 'pending') THEN
    RAISE EXCEPTION 'A request is already waiting for the customer''s answer' USING ERRCODE = 'QM032';
  END IF;
  INSERT INTO public.portal_ppap_requests (organisation_id, submission_id, party_id, request_note) VALUES (s.organisation_id, s.id, v_party, v_note) RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION app.request_ppap_customer_answer(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.request_ppap_customer_answer(uuid, text) TO authenticated;

CREATE FUNCTION app.withdraw_ppap_customer_request(p_request uuid, p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.portal_ppap_requests%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.portal_ppap_requests WHERE id = p_request FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'request not found' USING ERRCODE = 'no_data_found'; END IF;
  PERFORM app.ppap_for_write(r.submission_id);
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'That request has already been answered or withdrawn' USING ERRCODE = 'QM032'; END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 3 OR length(btrim(p_reason)) > 500 THEN RAISE EXCEPTION 'Give a reason of 3 to 500 characters' USING ERRCODE = 'QM032'; END IF;
  UPDATE public.portal_ppap_requests SET status = 'withdrawn', withdrawn_by = auth.uid(), withdrawn_reason = btrim(p_reason) WHERE id = p_request;
  RETURN r.submission_id;
END $$;
REVOKE ALL ON FUNCTION app.withdraw_ppap_customer_request(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.withdraw_ppap_customer_request(uuid, text) TO authenticated;

-- The requests on one submission, newest first, as staff see them (who asked, who answered, what they said). ppap.read.
CREATE FUNCTION app.ppap_customer_requests(p_submission uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.ppap_submissions WHERE id = p_submission) OR NOT app.ppap_readable(p_submission) THEN RAISE EXCEPTION 'Submission not found' USING ERRCODE = 'P0002'; END IF;
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id', r.id, 'partyId', r.party_id, 'customer', cus.name, 'status', r.status, 'requestedAt', r.requested_at, 'requestNote', r.request_note,
      'requestedBy', app.portal_person_name(r.requested_by), 'answeredAt', r.answered_at, 'answeredBy', app.portal_person_name(r.answered_by),
      'decision', d.kind, 'decisionNote', d.note, 'customerReference', d.their_reference, 'expiresOn', d.expires_on,
      'withdrawnReason', r.withdrawn_reason) ORDER BY r.requested_at DESC)
    FROM (SELECT * FROM public.portal_ppap_requests WHERE submission_id = p_submission ORDER BY requested_at DESC LIMIT 20) r
    JOIN public.portal_parties p ON p.id = r.party_id JOIN public.customers cus ON cus.id = p.customer_id
    LEFT JOIN public.ppap_decisions d ON d.id = r.decision_id), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION app.ppap_customer_requests(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.ppap_customer_requests(uuid) TO authenticated;

-- Who to email when a customer is asked: the party's active people with a confirmed address (staff who may manage PPAP only).
CREATE FUNCTION app.ppap_request_recipients(p_request uuid) RETURNS TABLE (email text, name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.portal_ppap_requests%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.portal_ppap_requests WHERE id = p_request;
  IF NOT FOUND OR NOT app.has_permission(r.organisation_id, 'ppap.manage') THEN RAISE EXCEPTION 'request not found' USING ERRCODE = 'no_data_found'; END IF;
  RETURN QUERY
  SELECT u.email::text, app.portal_person_name(u.id)
    FROM public.external_access a JOIN auth.users u ON u.id = a.user_id
   WHERE a.party_id = r.party_id AND a.organisation_id = r.organisation_id AND a.status = 'active' AND u.email_confirmed_at IS NOT NULL AND r.status = 'pending';
END $$;
REVOKE ALL ON FUNCTION app.ppap_request_recipients(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.ppap_request_recipients(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. The customer
-- ---------------------------------------------------------------------------
-- The caller's own live access to the request's party, else no_data_found; the request.
CREATE FUNCTION app.portal_ppap_for_external(p_request uuid) RETURNS public.portal_ppap_requests
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.portal_ppap_requests%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.portal_ppap_requests WHERE id = p_request;
  IF NOT FOUND THEN RAISE EXCEPTION 'request not found' USING ERRCODE = 'no_data_found'; END IF;
  PERFORM app.portal_customer_party(r.organisation_id, r.party_id);
  RETURN r;
END $$;
REVOKE ALL ON FUNCTION app.portal_ppap_for_external(uuid) FROM PUBLIC, anon, authenticated;

-- A customer's answer: final. Approved, interim approved (with the day it runs to and its conditions) or rejected (with why). Recorded as the submission's decision, today.
CREATE FUNCTION app.portal_decide_ppap(p_request uuid, p_kind text, p_note text DEFAULT NULL, p_reference text DEFAULT NULL, p_expires_on date DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.portal_ppap_requests%ROWTYPE; s public.ppap_submissions%ROWTYPE; v_label text;
BEGIN
  r := app.portal_ppap_for_external(p_request);
  SELECT * INTO r FROM public.portal_ppap_requests WHERE id = p_request FOR UPDATE;
  SELECT * INTO s FROM public.ppap_submissions WHERE id = r.submission_id FOR UPDATE;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'That request has already been answered or withdrawn' USING ERRCODE = 'QM032'; END IF;
  IF s.status NOT IN ('submitted', 'interim_approved') THEN RAISE EXCEPTION 'This submission no longer needs your answer' USING ERRCODE = 'QM032'; END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('approved', 'interim_approved', 'rejected') THEN RAISE EXCEPTION 'Approve it, approve it for now, or say you reject it' USING ERRCODE = 'QM032'; END IF;
  IF p_kind = 'rejected' AND length(coalesce(btrim(p_note), '')) < 3 THEN RAISE EXCEPTION 'Say what you cannot accept' USING ERRCODE = 'QM032'; END IF;
  IF p_kind = 'interim_approved' AND length(coalesce(btrim(p_note), '')) < 3 THEN RAISE EXCEPTION 'Write the conditions of the interim approval' USING ERRCODE = 'QM032'; END IF;
  PERFORM app.ppap_apply_decision(s.id, p_kind, current_date, p_reference, p_expires_on, p_note, NULL, NULL, NULL, NULL, r.id);
  v_label := s.reference || ' · ' || (SELECT pt.part_number FROM public.parts pt WHERE pt.id = s.part_id);
  PERFORM app.portal_note_activity(r.organisation_id, r.party_id,
    CASE p_kind WHEN 'approved' THEN 'ppap_approved' WHEN 'interim_approved' THEN 'ppap_interim' ELSE 'ppap_rejected' END, 'ppap', s.id, v_label,
    CASE p_kind WHEN 'approved' THEN 'Approved the submission' WHEN 'interim_approved' THEN 'Gave an interim approval' ELSE 'Rejected: ' || left(btrim(p_note), 120) END);
  RETURN s.id;
END $$;
REVOKE ALL ON FUNCTION app.portal_decide_ppap(uuid, text, text, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_decide_ppap(uuid, text, text, text, date) TO authenticated;

-- The requests for the caller's own customer party (named columns only), newest first. Withdrawn ones are not shown.
CREATE FUNCTION app.portal_list_ppaps(p_org uuid)
RETURNS TABLE (request_id uuid, reference text, part_number text, part_name text, their_part_number text, level integer, status text, submission_status text, requested_at timestamptz,
               answered_at timestamptz, can_decide boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT r.id, s.reference, pt.part_number, pt.name, pc.customer_part_number, s.level, r.status, s.status, r.requested_at, r.answered_at,
         (r.status = 'pending' AND s.status IN ('submitted', 'interim_approved'))
    FROM public.portal_ppap_requests r
    JOIN public.ppap_submissions s ON s.id = r.submission_id AND s.organisation_id = r.organisation_id
    JOIN public.parts pt ON pt.id = s.part_id AND pt.organisation_id = s.organisation_id
    JOIN app.portal_my_access(p_org) a ON a.party_id = r.party_id AND a.party_kind = 'customer'
    JOIN public.portal_parties p ON p.id = r.party_id
    LEFT JOIN public.part_customers pc ON pc.part_id = s.part_id AND pc.organisation_id = s.organisation_id AND pc.customer_id = p.customer_id
   WHERE r.organisation_id = p_org AND r.status <> 'withdrawn'
   ORDER BY r.requested_at DESC LIMIT 200
$$;
REVOKE ALL ON FUNCTION app.portal_list_ppaps(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_list_ppaps(uuid) TO authenticated;

-- One request with the submission as the customer may see it. NAMED FIELDS ONLY (the SQL test and the e2e list the exact keys): no evidence, files, links, notes, waiver
-- reasons, FMEAs, studies, people of ours (but for the warrant's signer, whose name is on the form), other customers or suppliers.
CREATE FUNCTION app.portal_get_ppap(p_request uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  r public.portal_ppap_requests%ROWTYPE; s public.ppap_submissions%ROWTYPE; p public.portal_parties%ROWTYPE; w public.ppap_psw%ROWTYPE;
  pt public.parts%ROWTYPE; pr public.part_revisions%ROWTYPE; v_theirs text; v_sent date; v_elements jsonb; v_last public.ppap_decisions%ROWTYPE; v_answer public.ppap_decisions%ROWTYPE;
BEGIN
  r := app.portal_ppap_for_external(p_request);
  IF r.status = 'withdrawn' THEN RAISE EXCEPTION 'request not found' USING ERRCODE = 'no_data_found'; END IF;
  SELECT * INTO s FROM public.ppap_submissions WHERE id = r.submission_id AND organisation_id = r.organisation_id;
  SELECT * INTO p FROM public.portal_parties WHERE id = r.party_id;
  SELECT * INTO pt FROM public.parts WHERE id = s.part_id;
  SELECT * INTO pr FROM public.part_revisions WHERE id = s.part_revision_id;
  SELECT pc.customer_part_number INTO v_theirs FROM public.part_customers pc WHERE pc.part_id = s.part_id AND pc.organisation_id = s.organisation_id AND pc.customer_id = p.customer_id;
  SELECT d.decided_on INTO v_sent FROM public.ppap_decisions d WHERE d.submission_id = s.id AND d.kind = 'submitted' ORDER BY d.seq LIMIT 1;
  SELECT * INTO w FROM public.ppap_psw WHERE submission_id = s.id;
  SELECT * INTO v_last FROM public.ppap_decisions d WHERE d.submission_id = s.id ORDER BY d.seq DESC LIMIT 1;
  SELECT * INTO v_answer FROM public.ppap_decisions d WHERE d.id = r.decision_id;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'name', t.label,
           'requirement', CASE e.requirement WHEN 'required' THEN 'Submitted' WHEN 'retain' THEN 'Kept on file' ELSE 'Not required' END,
           'provided', e.status = 'ready',
           'waived', e.status = 'waived') ORDER BY t.ordinal), '[]'::jsonb)
    INTO v_elements
    FROM public.ppap_elements e JOIN app.ppap_element_types() t ON t.key = e.element_key
   WHERE e.submission_id = s.id AND e.requirement IN ('required', 'retain');
  RETURN jsonb_build_object(
    'id', r.id, 'status', r.status, 'requestedAt', r.requested_at, 'requestNote', r.request_note,
    'reference', s.reference, 'partNumber', pt.part_number, 'partName', pt.name, 'theirPartNumber', v_theirs,
    'revision', pr.revision || CASE WHEN pr.version > 1 THEN ' v' || pr.version ELSE '' END,
    'level', s.level,
    'reason', CASE s.reason WHEN 'new_part' THEN 'New part' WHEN 'engineering_change' THEN 'Engineering change' WHEN 'tooling' THEN 'Tooling' WHEN 'discrepancy_correction' THEN 'Correction of a discrepancy'
                            WHEN 'alternate_material_or_supplier' THEN 'Alternate material or supplier' WHEN 'process_change' THEN 'Process change' WHEN 'not_produced_12_months' THEN 'Not produced for 12 months'
                            WHEN 'customer_request' THEN 'Customer request' ELSE 'Other' END,
    'sentOn', v_sent, 'submissionStatus', s.status,
    'interimExpiresOn', CASE WHEN s.status = 'interim_approved' THEN v_last.expires_on END,
    'elements', v_elements,
    'warrant', CASE WHEN w.id IS NOT NULL AND w.signed_at IS NOT NULL THEN jsonb_build_object(
        'partWeight', w.part_weight, 'weightUnit', w.weight_unit, 'purchaseOrder', w.purchase_order, 'engineeringChangeLevel', w.engineering_change_level,
        'resultsMeetRequirements', w.results_meet_requirements, 'declaration', w.declaration,
        'signerName', w.signer_name, 'signerTitle', w.signer_title, 'signerPhone', w.signer_phone, 'signedOn', w.signed_on) END,
    'contact', p.contact_name,
    'answeredAt', r.answered_at, 'answeredBy', app.portal_person_name(r.answered_by), 'decision', v_answer.kind, 'decisionNote', v_answer.note,
    'yourReference', v_answer.their_reference, 'decisionExpiresOn', v_answer.expires_on,
    'canDecide', r.status = 'pending' AND s.status IN ('submitted', 'interim_approved'));
END $$;
REVOKE ALL ON FUNCTION app.portal_get_ppap(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_get_ppap(uuid) TO authenticated;
