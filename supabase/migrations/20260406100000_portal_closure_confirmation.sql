-- External portal PT5b (docs/external-portal-plan.md §6, decision X3: customers "confirm closure"): staff ask a customer to confirm that a shared
-- non-conformance or 8D can be closed; the customer's people confirm it or say they are not satisfied, with a note.
--
--  * INFORMATION ONLY: a confirmation never closes, reopens or blocks anything internally. It is the customer's recorded answer, shown to staff beside
--    the record; the organisation decides what to do with a refusal.
--  * Only for a CUSTOMER party's live share. One request waits at a time per share; staff may withdraw it with a reason; a decision is final.
--  * portal_closure_requests: functions only, audited, never deleted. A trigger holds the moves (pending -> confirmed | declined | withdrawn, nothing after).
--  * The customer's side checks the caller's own live portal access to the share's party (app.portal_share_for_external); staff need external_access.share.
--  * Staff are told (portal_activity kinds closure_confirmed / closure_declined).

ALTER TABLE public.portal_activity DROP CONSTRAINT IF EXISTS portal_activity_kind_check;
ALTER TABLE public.portal_activity
  ADD CONSTRAINT portal_activity_kind_check CHECK (kind IN ('scar_acknowledged', 'scar_response', 'scar_extension_requested', 'scar_extension_withdrawn', 'comment', 'acknowledged', 'scar_action_done', 'complaint_raised',
                                                             'closure_confirmed', 'closure_declined'));

CREATE TABLE public.portal_closure_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  share_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'declined', 'withdrawn')),
  requested_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  request_note text CHECK (request_note IS NULL OR length(btrim(request_note)) BETWEEN 1 AND 500),
  decided_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  decided_at timestamptz,
  decision_note text CHECK (decision_note IS NULL OR length(btrim(decision_note)) BETWEEN 1 AND 2000),
  withdrawn_reason text CHECK (withdrawn_reason IS NULL OR length(btrim(withdrawn_reason)) BETWEEN 3 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT portal_closure_requests_share_fkey FOREIGN KEY (share_id, organisation_id) REFERENCES public.portal_shares (id, organisation_id),
  CONSTRAINT portal_closure_requests_state CHECK (
    (status = 'pending' AND decided_at IS NULL AND withdrawn_reason IS NULL)
    OR (status IN ('confirmed', 'declined') AND decided_at IS NOT NULL AND decided_by IS NOT NULL AND withdrawn_reason IS NULL AND (status = 'confirmed' OR decision_note IS NOT NULL))
    OR (status = 'withdrawn' AND withdrawn_reason IS NOT NULL))
);
CREATE UNIQUE INDEX portal_closure_requests_one_pending ON public.portal_closure_requests (share_id) WHERE status = 'pending';
CREATE INDEX portal_closure_requests_share_idx ON public.portal_closure_requests (share_id, requested_at DESC);
CREATE FUNCTION app.portal_closure_moves() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A closure request is never deleted' USING ERRCODE = 'QM032'; END IF;
  IF OLD.status <> 'pending' THEN RAISE EXCEPTION 'A closure request that has been answered or withdrawn does not change' USING ERRCODE = 'QM032'; END IF;
  IF NEW.share_id IS DISTINCT FROM OLD.share_id OR NEW.requested_at IS DISTINCT FROM OLD.requested_at OR NEW.requested_by IS DISTINCT FROM OLD.requested_by THEN
    RAISE EXCEPTION 'A closure request keeps its share and who asked' USING ERRCODE = 'QM032';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER portal_closure_requests_moves BEFORE UPDATE OR DELETE ON public.portal_closure_requests FOR EACH ROW EXECUTE FUNCTION app.portal_closure_moves();
CREATE TRIGGER portal_closure_requests_stamp BEFORE INSERT ON public.portal_closure_requests FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER portal_closure_requests_touch BEFORE UPDATE ON public.portal_closure_requests FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE ON public.portal_closure_requests FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.portal_closure_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.portal_closure_requests FROM anon, authenticated;
GRANT SELECT ON public.portal_closure_requests TO authenticated;
CREATE POLICY portal_closure_requests_select ON public.portal_closure_requests FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'external_access.share'));
REVOKE ALL ON FUNCTION app.portal_closure_moves() FROM PUBLIC, anon, authenticated;

-- A label for a share's record, for notices.
CREATE FUNCTION app.portal_share_label(s public.portal_shares) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(n.reference, c.reference) || ' · ' || coalesce(n.title, c.title)
    FROM (SELECT 1) one LEFT JOIN public.nonconformances n ON n.id = s.nonconformance_id LEFT JOIN public.capas c ON c.id = s.capa_id
$$;
REVOKE ALL ON FUNCTION app.portal_share_label(public.portal_shares) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Staff
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.request_portal_closure(p_share uuid, p_note text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.portal_shares; v_kind text; v_id uuid;
BEGIN
  SELECT * INTO s FROM public.portal_shares WHERE id = p_share;
  IF NOT FOUND OR NOT app.has_permission(s.organisation_id, 'external_access.share') THEN RAISE EXCEPTION 'share not found' USING ERRCODE = 'no_data_found'; END IF;
  IF s.withdrawn_at IS NOT NULL THEN RAISE EXCEPTION 'This record is no longer shared' USING ERRCODE = 'QM032'; END IF;
  SELECT party_kind INTO v_kind FROM public.portal_parties WHERE id = s.party_id;
  IF v_kind <> 'customer' THEN RAISE EXCEPTION 'Only a customer is asked to confirm closure' USING ERRCODE = 'QM032'; END IF;
  IF p_note IS NOT NULL AND length(btrim(p_note)) > 500 THEN RAISE EXCEPTION 'The message is up to 500 characters' USING ERRCODE = 'QM032'; END IF;
  IF EXISTS (SELECT 1 FROM public.portal_closure_requests r WHERE r.share_id = p_share AND r.status = 'pending') THEN
    RAISE EXCEPTION 'A request for confirmation is already waiting for an answer' USING ERRCODE = 'QM032';
  END IF;
  INSERT INTO public.portal_closure_requests (organisation_id, share_id, request_note) VALUES (s.organisation_id, p_share, nullif(btrim(coalesce(p_note, '')), '')) RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION app.request_portal_closure(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.request_portal_closure(uuid, text) TO authenticated;

CREATE FUNCTION app.withdraw_portal_closure(p_request uuid, p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.portal_closure_requests;
BEGIN
  SELECT * INTO r FROM public.portal_closure_requests WHERE id = p_request FOR UPDATE;
  IF NOT FOUND OR NOT app.has_permission(r.organisation_id, 'external_access.share') THEN RAISE EXCEPTION 'request not found' USING ERRCODE = 'no_data_found'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'That request has already been answered or withdrawn' USING ERRCODE = 'QM032'; END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 3 OR length(btrim(p_reason)) > 500 THEN RAISE EXCEPTION 'Give a reason of 3 to 500 characters' USING ERRCODE = 'QM032'; END IF;
  UPDATE public.portal_closure_requests SET status = 'withdrawn', withdrawn_reason = btrim(p_reason) WHERE id = p_request;
  RETURN r.share_id;
END $$;
REVOKE ALL ON FUNCTION app.withdraw_portal_closure(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.withdraw_portal_closure(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- The customer
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.portal_decide_closure(p_request uuid, p_confirm boolean, p_note text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.portal_closure_requests; s public.portal_shares;
BEGIN
  SELECT * INTO r FROM public.portal_closure_requests WHERE id = p_request FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'request not found' USING ERRCODE = 'no_data_found'; END IF;
  s := app.portal_share_for_external(r.share_id);
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'That request has already been answered or withdrawn' USING ERRCODE = 'QM032'; END IF;
  IF p_confirm IS NULL THEN RAISE EXCEPTION 'Confirm or say you are not satisfied' USING ERRCODE = 'QM032'; END IF;
  IF p_note IS NOT NULL AND length(btrim(p_note)) > 2000 THEN RAISE EXCEPTION 'A note is up to 2,000 characters' USING ERRCODE = 'QM032'; END IF;
  IF NOT p_confirm AND length(btrim(coalesce(p_note, ''))) < 3 THEN RAISE EXCEPTION 'Say what is still wrong' USING ERRCODE = 'QM032'; END IF;
  UPDATE public.portal_closure_requests
     SET status = CASE WHEN p_confirm THEN 'confirmed' ELSE 'declined' END, decided_by = auth.uid(), decided_at = now(), decision_note = nullif(btrim(coalesce(p_note, '')), '')
   WHERE id = p_request;
  PERFORM app.portal_note_activity(s.organisation_id, s.party_id, CASE WHEN p_confirm THEN 'closure_confirmed' ELSE 'closure_declined' END, s.record_kind, coalesce(s.nonconformance_id, s.capa_id),
                                   app.portal_share_label(s), CASE WHEN p_confirm THEN 'Confirmed the closure' ELSE 'Not satisfied: ' || left(btrim(p_note), 120) END);
  RETURN r.share_id;
END $$;
REVOKE ALL ON FUNCTION app.portal_decide_closure(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_decide_closure(uuid, boolean, text) TO authenticated;

-- The requests on one share, newest first, as the caller's side may see them: staff see who asked and who answered, the customer sees their own people's names
-- and "the organisation" for staff (PT0: staff are never named to the other side). Named fields only.
CREATE FUNCTION app.portal_share_closures(p_share uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.portal_shares; v_staff boolean;
BEGIN
  SELECT * INTO s FROM public.portal_shares WHERE id = p_share;
  IF NOT FOUND THEN RAISE EXCEPTION 'share not found' USING ERRCODE = 'no_data_found'; END IF;
  v_staff := app.has_permission(s.organisation_id, 'external_access.share');
  IF NOT v_staff THEN s := app.portal_share_for_external(p_share); END IF;
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id', r.id, 'status', r.status, 'requestedAt', r.requested_at, 'requestNote', r.request_note,
      'requestedBy', CASE WHEN v_staff THEN app.portal_person_name(r.requested_by) END,
      'decidedAt', r.decided_at, 'decisionNote', r.decision_note, 'decidedBy', app.portal_person_name(r.decided_by),
      'withdrawnReason', CASE WHEN v_staff THEN r.withdrawn_reason END,
      'canDecide', (NOT v_staff AND r.status = 'pending')) ORDER BY r.requested_at DESC)
    FROM (SELECT * FROM public.portal_closure_requests WHERE share_id = p_share AND (v_staff OR status <> 'withdrawn') ORDER BY requested_at DESC LIMIT 20) r), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION app.portal_share_closures(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_share_closures(uuid) TO authenticated;

-- Shares of the caller's party with a request waiting for their answer.
CREATE FUNCTION app.portal_pending_closures(p_org uuid) RETURNS TABLE (share_id uuid, request_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT x.id, r.id
    FROM public.portal_closure_requests r
    JOIN public.portal_shares x ON x.id = r.share_id AND x.organisation_id = r.organisation_id AND x.withdrawn_at IS NULL
    JOIN app.portal_my_access(p_org) a ON a.party_id = x.party_id
   WHERE r.organisation_id = p_org AND r.status = 'pending'
$$;
REVOKE ALL ON FUNCTION app.portal_pending_closures(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_pending_closures(uuid) TO authenticated;
