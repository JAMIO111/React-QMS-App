-- Change management, slice CH6b (docs/change-management-plan.md §8j): staff ask a CUSTOMER to approve a change in the portal, and the customer's people approve
-- it or say they do not, with a note — as closure confirmation works on a shared non-conformance (PT5b).
--
--  * What the customer approves is the CHANGE'S OWN customer-approval record (change_requests.customer_approval, CH2). Asking sets it to "requested"; the
--    customer's answer sets it to "approved" (with their reference and the day) or "rejected" (with their note kept here). Staff can still record the
--    customer's answer by hand exactly as before; the portal is one more way of getting it, never the only one.
--  * INFORMATION ONLY: nothing is submitted, approved, sent back or closed for anyone. The existing rule stands that a change cannot be CLOSED while the
--    customer's approval is required, requested or rejected (app.change_problems), so a "no" has to be dealt with by staff (take the change back, record a
--    waiver with a reason, or ask again).
--  * portal_change_approvals: functions only, audited, never deleted. A request waits at a time per change and customer; staff withdraw it with a reason;
--    pending -> approved | rejected | withdrawn and then it never changes (trigger).
--  * Who can be asked: customers whose portal and party are on and which the change is FOR (it names the customer, or a part or part family they buy).
--    Staff need change.manage; the customer's side checks the caller's own live portal access to that party (app.portal_change_party).
--  * The customer sees named fields only: the change's title, what is changing, why, its type, whether it is expedited, from when it applies and what
--    happens to stock already made (the action, not the note), the parts of theirs it covers and who to contact. Never impacts, the board, tasks, other
--    customers, suppliers, machines, people of ours or any internal note.
--  * Staff are told when the customer answers (portal_activity kinds change_approved / change_declined, record kind change).
-- Errors QM032 (409 portal_rule); another party's or organisation's record is P0002 (404).

ALTER TABLE public.portal_activity DROP CONSTRAINT IF EXISTS portal_activity_kind_check;
ALTER TABLE public.portal_activity
  ADD CONSTRAINT portal_activity_kind_check CHECK (kind IN ('scar_acknowledged', 'scar_response', 'scar_extension_requested', 'scar_extension_withdrawn', 'comment', 'acknowledged',
                                                             'scar_action_done', 'complaint_raised', 'closure_confirmed', 'closure_declined', 'change_requested',
                                                             'change_approved', 'change_declined'));

-- ---------------------------------------------------------------------------
-- 1. The requests
-- ---------------------------------------------------------------------------
CREATE TABLE public.portal_change_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  change_id uuid NOT NULL,
  party_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  requested_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  request_note text CHECK (request_note IS NULL OR length(btrim(request_note)) BETWEEN 1 AND 500),
  decided_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  decided_at timestamptz,
  decision_note text CHECK (decision_note IS NULL OR length(btrim(decision_note)) BETWEEN 1 AND 2000),
  customer_reference text CHECK (customer_reference IS NULL OR length(btrim(customer_reference)) BETWEEN 1 AND 200),
  withdrawn_reason text CHECK (withdrawn_reason IS NULL OR length(btrim(withdrawn_reason)) BETWEEN 3 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT portal_change_approvals_change_fkey FOREIGN KEY (change_id, organisation_id) REFERENCES public.change_requests (id, organisation_id),
  CONSTRAINT portal_change_approvals_party_fkey FOREIGN KEY (party_id, organisation_id) REFERENCES public.portal_parties (id, organisation_id),
  CONSTRAINT portal_change_approvals_state CHECK (
    (status = 'pending' AND decided_at IS NULL AND withdrawn_reason IS NULL)
    OR (status IN ('approved', 'rejected') AND decided_at IS NOT NULL AND decided_by IS NOT NULL AND withdrawn_reason IS NULL AND (status = 'approved' OR decision_note IS NOT NULL))
    OR (status = 'withdrawn' AND withdrawn_reason IS NOT NULL AND decided_at IS NULL))
);
CREATE UNIQUE INDEX portal_change_approvals_one_pending ON public.portal_change_approvals (change_id, party_id) WHERE status = 'pending';
CREATE INDEX portal_change_approvals_change_idx ON public.portal_change_approvals (change_id, requested_at DESC);
CREATE INDEX portal_change_approvals_party_idx ON public.portal_change_approvals (party_id, requested_at DESC);

CREATE FUNCTION app.portal_change_approval_moves() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A request for a customer''s approval is never deleted' USING ERRCODE = 'QM032'; END IF;
  IF OLD.status <> 'pending' THEN RAISE EXCEPTION 'A request that has been answered or withdrawn does not change' USING ERRCODE = 'QM032'; END IF;
  IF NEW.change_id IS DISTINCT FROM OLD.change_id OR NEW.party_id IS DISTINCT FROM OLD.party_id OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by THEN
    RAISE EXCEPTION 'A request keeps its change, its customer and who asked' USING ERRCODE = 'QM032';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER portal_change_approvals_moves BEFORE UPDATE OR DELETE ON public.portal_change_approvals FOR EACH ROW EXECUTE FUNCTION app.portal_change_approval_moves();
CREATE TRIGGER portal_change_approvals_stamp BEFORE INSERT ON public.portal_change_approvals FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER portal_change_approvals_touch BEFORE UPDATE ON public.portal_change_approvals FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE ON public.portal_change_approvals FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.portal_change_approvals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.portal_change_approvals FROM anon, authenticated;
GRANT SELECT ON public.portal_change_approvals TO authenticated;
CREATE POLICY portal_change_approvals_select ON public.portal_change_approvals FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'change.read') OR app.has_permission(organisation_id, 'external_access.share'));
REVOKE ALL ON FUNCTION app.portal_change_approval_moves() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Who a change is for
-- ---------------------------------------------------------------------------
-- Customers (portal and party on) the change is FOR: it names the customer, or a part, or a part family, that they buy. Staff with change.read.
CREATE FUNCTION app.change_customer_parties(p_change uuid) RETURNS TABLE (party_id uuid, customer_id uuid, party_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.change_requests%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.change_requests WHERE id = p_change;
  IF NOT FOUND OR NOT app.has_permission(c.organisation_id, 'change.read') THEN RAISE EXCEPTION 'Change not found' USING ERRCODE = 'P0002'; END IF;
  RETURN QUERY
  SELECT p.id, p.customer_id, cus.name
    FROM public.portal_parties p
    JOIN public.customers cus ON cus.id = p.customer_id AND cus.organisation_id = p.organisation_id
    JOIN public.organisation_settings s ON s.organisation_id = p.organisation_id AND s.portal_enabled
   WHERE p.organisation_id = c.organisation_id AND p.party_kind = 'customer' AND p.enabled
     AND (EXISTS (SELECT 1 FROM public.change_links l WHERE l.change_id = c.id AND l.customer_id = p.customer_id)
          OR EXISTS (SELECT 1 FROM public.change_links l JOIN public.part_customers pc ON pc.part_id = l.part_id AND pc.organisation_id = l.organisation_id
                      WHERE l.change_id = c.id AND l.kind = 'part' AND pc.customer_id = p.customer_id)
          OR EXISTS (SELECT 1 FROM public.change_links l JOIN public.parts x ON x.part_family_id = l.part_family_id AND x.organisation_id = l.organisation_id
                       JOIN public.part_customers pc ON pc.part_id = x.id AND pc.organisation_id = x.organisation_id
                      WHERE l.change_id = c.id AND l.kind = 'part_family' AND pc.customer_id = p.customer_id))
   ORDER BY cus.name;
END $$;
REVOKE ALL ON FUNCTION app.change_customer_parties(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.change_customer_parties(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. Staff: ask, withdraw, read
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.request_customer_change_approval(p_change uuid, p_party uuid, p_note text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.change_requests%ROWTYPE; v_id uuid; v_note text := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  c := app.change_for_write(p_change);
  IF c.stage NOT IN ('assessment', 'approval', 'approved', 'implementing', 'verifying') THEN
    RAISE EXCEPTION '% is % and cannot be put to a customer now', c.reference, c.stage USING ERRCODE = 'QM032';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.change_customer_parties(p_change) x WHERE x.party_id = p_party) THEN
    RAISE EXCEPTION 'That customer is not set up for the portal, or this change is not about them' USING ERRCODE = 'QM032';
  END IF;
  IF length(coalesce(v_note, '')) > 500 THEN RAISE EXCEPTION 'The message is up to 500 characters' USING ERRCODE = 'QM032'; END IF;
  IF c.customer_approval = 'approved' THEN RAISE EXCEPTION 'The customer''s approval is already recorded as approved' USING ERRCODE = 'QM032'; END IF;
  IF EXISTS (SELECT 1 FROM public.portal_change_approvals r WHERE r.change_id = c.id AND r.party_id = p_party AND r.status = 'pending') THEN
    RAISE EXCEPTION 'A request is already waiting for that customer''s answer' USING ERRCODE = 'QM032';
  END IF;
  INSERT INTO public.portal_change_approvals (organisation_id, change_id, party_id, request_note) VALUES (c.organisation_id, c.id, p_party, v_note) RETURNING id INTO v_id;
  PERFORM app.set_change_customer_approval(c.id, 'requested');
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION app.request_customer_change_approval(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.request_customer_change_approval(uuid, uuid, text) TO authenticated;

CREATE FUNCTION app.withdraw_customer_change_approval(p_request uuid, p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.portal_change_approvals%ROWTYPE; c public.change_requests%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.portal_change_approvals WHERE id = p_request FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'request not found' USING ERRCODE = 'no_data_found'; END IF;
  c := app.change_for_write(r.change_id);
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'That request has already been answered or withdrawn' USING ERRCODE = 'QM032'; END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 3 OR length(btrim(p_reason)) > 500 THEN RAISE EXCEPTION 'Give a reason of 3 to 500 characters' USING ERRCODE = 'QM032'; END IF;
  UPDATE public.portal_change_approvals SET status = 'withdrawn', withdrawn_reason = btrim(p_reason) WHERE id = p_request;
  -- Nobody is being asked any more: the change goes back to "required" so it is not left saying "requested".
  IF c.customer_approval = 'requested' AND c.stage NOT IN ('closed', 'rejected', 'cancelled')
     AND NOT EXISTS (SELECT 1 FROM public.portal_change_approvals x WHERE x.change_id = c.id AND x.status = 'pending') THEN
    PERFORM app.set_change_customer_approval(c.id, 'required');
  END IF;
  RETURN r.change_id;
END $$;
REVOKE ALL ON FUNCTION app.withdraw_customer_change_approval(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.withdraw_customer_change_approval(uuid, text) TO authenticated;

-- The requests on one change, newest first, as staff see them (who asked, who answered). change.read.
CREATE FUNCTION app.change_customer_approvals(p_change uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.change_requests%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.change_requests WHERE id = p_change;
  IF NOT FOUND OR NOT app.has_permission(c.organisation_id, 'change.read') THEN RAISE EXCEPTION 'Change not found' USING ERRCODE = 'P0002'; END IF;
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id', r.id, 'partyId', r.party_id, 'customer', cus.name, 'status', r.status, 'requestedAt', r.requested_at, 'requestNote', r.request_note,
      'requestedBy', app.portal_person_name(r.requested_by), 'decidedAt', r.decided_at, 'decidedBy', app.portal_person_name(r.decided_by),
      'decisionNote', r.decision_note, 'customerReference', r.customer_reference, 'withdrawnReason', r.withdrawn_reason) ORDER BY r.requested_at DESC)
    FROM (SELECT * FROM public.portal_change_approvals WHERE change_id = p_change ORDER BY requested_at DESC LIMIT 20) r
    JOIN public.portal_parties p ON p.id = r.party_id JOIN public.customers cus ON cus.id = p.customer_id), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION app.change_customer_approvals(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.change_customer_approvals(uuid) TO authenticated;

-- Who to email when a customer is asked: the party's active people with a confirmed address (staff who may manage the change only).
CREATE FUNCTION app.change_approval_recipients(p_request uuid) RETURNS TABLE (email text, name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.portal_change_approvals%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.portal_change_approvals WHERE id = p_request;
  IF NOT FOUND OR NOT app.has_permission(r.organisation_id, 'change.manage') THEN RAISE EXCEPTION 'request not found' USING ERRCODE = 'no_data_found'; END IF;
  RETURN QUERY
  SELECT u.email::text, app.portal_person_name(u.id)
    FROM public.external_access a JOIN auth.users u ON u.id = a.user_id
   WHERE a.party_id = r.party_id AND a.organisation_id = r.organisation_id AND a.status = 'active' AND u.email_confirmed_at IS NOT NULL AND r.status = 'pending';
END $$;
REVOKE ALL ON FUNCTION app.change_approval_recipients(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.change_approval_recipients(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. The customer
-- ---------------------------------------------------------------------------
-- The caller's own live access to the request's party, else no_data_found; the request.
CREATE FUNCTION app.portal_change_approval_for_external(p_request uuid) RETURNS public.portal_change_approvals
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.portal_change_approvals%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.portal_change_approvals WHERE id = p_request;
  IF NOT FOUND THEN RAISE EXCEPTION 'request not found' USING ERRCODE = 'no_data_found'; END IF;
  PERFORM app.portal_customer_party(r.organisation_id, r.party_id);
  RETURN r;
END $$;
REVOKE ALL ON FUNCTION app.portal_change_approval_for_external(uuid) FROM PUBLIC, anon, authenticated;

-- A customer's answer: final. "No" needs a note. Writes the change's own customer-approval record (approved with their reference, or rejected) and tells staff.
CREATE FUNCTION app.portal_decide_change_approval(p_request uuid, p_approve boolean, p_note text DEFAULT NULL, p_reference text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.portal_change_approvals%ROWTYPE; c public.change_requests%ROWTYPE; v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_ref text := nullif(btrim(coalesce(p_reference, '')), '');
BEGIN
  r := app.portal_change_approval_for_external(p_request);
  SELECT * INTO r FROM public.portal_change_approvals WHERE id = p_request FOR UPDATE;
  SELECT * INTO c FROM public.change_requests WHERE id = r.change_id FOR UPDATE;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'That request has already been answered or withdrawn' USING ERRCODE = 'QM032'; END IF;
  IF c.stage IN ('closed', 'rejected', 'cancelled') THEN RAISE EXCEPTION 'This change is no longer open, so it no longer needs your answer' USING ERRCODE = 'QM032'; END IF;
  IF p_approve IS NULL THEN RAISE EXCEPTION 'Approve the change or say you do not' USING ERRCODE = 'QM032'; END IF;
  IF length(coalesce(v_note, '')) > 2000 THEN RAISE EXCEPTION 'A note is up to 2,000 characters' USING ERRCODE = 'QM032'; END IF;
  IF length(coalesce(v_ref, '')) > 200 THEN RAISE EXCEPTION 'Your reference is up to 200 characters' USING ERRCODE = 'QM032'; END IF;
  IF NOT p_approve AND length(coalesce(v_note, '')) < 3 THEN RAISE EXCEPTION 'Say what you cannot accept' USING ERRCODE = 'QM032'; END IF;
  UPDATE public.portal_change_approvals
     SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END, decided_by = auth.uid(), decided_at = now(), decision_note = v_note,
         customer_reference = CASE WHEN p_approve THEN v_ref END
   WHERE id = p_request;
  UPDATE public.change_requests
     SET customer_approval = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END, customer_reference = CASE WHEN p_approve THEN v_ref END,
         customer_waived_reason = NULL, customer_approval_on = current_date
   WHERE id = c.id;
  PERFORM app.portal_note_activity(r.organisation_id, r.party_id, CASE WHEN p_approve THEN 'change_approved' ELSE 'change_declined' END, 'change', c.id,
                                   c.reference || ' · ' || c.title, CASE WHEN p_approve THEN 'Approved the change' ELSE 'Does not approve: ' || left(v_note, 120) END);
  RETURN c.id;
END $$;
REVOKE ALL ON FUNCTION app.portal_decide_change_approval(uuid, boolean, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_decide_change_approval(uuid, boolean, text, text) TO authenticated;

-- The requests for the caller's own customer party (named columns only), newest first. Withdrawn ones are not shown.
CREATE FUNCTION app.portal_list_change_approvals(p_org uuid)
RETURNS TABLE (request_id uuid, reference text, title text, status text, requested_at timestamptz, decided_at timestamptz, can_decide boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT r.id, c.reference, c.title, r.status, r.requested_at, r.decided_at,
         (r.status = 'pending' AND c.stage NOT IN ('closed', 'rejected', 'cancelled'))
    FROM public.portal_change_approvals r
    JOIN public.change_requests c ON c.id = r.change_id AND c.organisation_id = r.organisation_id
    JOIN app.portal_my_access(p_org) a ON a.party_id = r.party_id AND a.party_kind = 'customer'
   WHERE r.organisation_id = p_org AND r.status <> 'withdrawn'
   ORDER BY r.requested_at DESC LIMIT 200
$$;
REVOKE ALL ON FUNCTION app.portal_list_change_approvals(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_list_change_approvals(uuid) TO authenticated;

-- One request with the change as the customer may see it. NAMED FIELDS ONLY (the SQL test and the e2e list the exact keys): no impacts, board, tasks, other
-- customers, suppliers, machines, orders or people of ours; the stock note stays inside.
CREATE FUNCTION app.portal_get_change_approval(p_request uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  r public.portal_change_approvals%ROWTYPE; c public.change_requests%ROWTYPE; p public.portal_parties%ROWTYPE; v_customer uuid; v_cut text; v_parts jsonb; v_type text;
BEGIN
  r := app.portal_change_approval_for_external(p_request);
  IF r.status = 'withdrawn' THEN RAISE EXCEPTION 'request not found' USING ERRCODE = 'no_data_found'; END IF;
  SELECT * INTO c FROM public.change_requests WHERE id = r.change_id AND organisation_id = r.organisation_id;
  SELECT * INTO p FROM public.portal_parties WHERE id = r.party_id;
  v_customer := p.customer_id;
  SELECT t.label INTO v_type FROM public.change_types t WHERE t.id = c.type_id;
  v_cut := CASE c.cut_in_kind
    WHEN 'date' THEN 'From ' || to_char(c.cut_in_date, 'DD Mon YYYY')
    WHEN 'order' THEN 'From a production order'
    WHEN 'lot' THEN 'From lot ' || (SELECT l.lot_number FROM public.lots l WHERE l.id = c.cut_in_lot_id)
    WHEN 'serial' THEN 'From serial number ' || (SELECT s.serial_number FROM public.serial_numbers s WHERE s.id = c.cut_in_serial_id)
    ELSE NULL END;
  SELECT coalesce(jsonb_agg(jsonb_build_object('partNumber', q.part_number, 'name', q.name, 'theirPartNumber', q.customer_part_number) ORDER BY q.part_number), '[]'::jsonb) INTO v_parts
    FROM (SELECT DISTINCT x.part_number, x.name, pc.customer_part_number
            FROM public.change_links l
            JOIN public.parts x ON x.organisation_id = l.organisation_id AND (x.id = l.part_id OR (l.kind = 'part_family' AND x.part_family_id = l.part_family_id))
            JOIN public.part_customers pc ON pc.part_id = x.id AND pc.organisation_id = x.organisation_id AND pc.customer_id = v_customer
           WHERE l.change_id = c.id AND l.kind IN ('part', 'part_family')) q;
  RETURN jsonb_build_object(
    'id', r.id, 'status', r.status, 'requestedAt', r.requested_at, 'requestNote', r.request_note,
    'reference', c.reference, 'title', c.title, 'whatIsChanging', c.description, 'why', c.reason, 'type', v_type, 'expedited', c.urgency = 'expedited',
    'appliesFrom', v_cut, 'stock', CASE c.stock_action WHEN 'use_up' THEN 'Use up what we have' WHEN 'rework' THEN 'Rework it' WHEN 'scrap' THEN 'Scrap it' WHEN 'return' THEN 'Return it' END,
    'parts', v_parts, 'contact', p.contact_name,
    'decidedAt', r.decided_at, 'decidedBy', app.portal_person_name(r.decided_by), 'decisionNote', r.decision_note, 'yourReference', r.customer_reference,
    'open', c.stage NOT IN ('closed', 'rejected', 'cancelled'),
    'canDecide', r.status = 'pending' AND c.stage NOT IN ('closed', 'rejected', 'cancelled'));
END $$;
REVOKE ALL ON FUNCTION app.portal_get_change_approval(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_get_change_approval(uuid) TO authenticated;
