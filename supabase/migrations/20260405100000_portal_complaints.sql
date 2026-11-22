-- External portal PT5a (docs/external-portal-plan.md §6, decisions X3, X14): a customer's people raise a complaint in the portal. It becomes a DRAFT
-- non-conformance (source customer, the customer's own words) that staff review, complete and open; nothing is opened or decided for them.
--
--  * portal_complaints links each complaint to its non-conformance and to who raised it. No table writes: functions only, audited, never deleted.
--    Staff read it with external_access.share (the draft NC itself is on the NC register as ever).
--  * app.portal_raise_complaint(...) checks the caller's own live portal access to a CUSTOMER party; the customer comes from the access row, never the
--    request. A client key makes a retry return the same complaint. Staff are told by portal_activity.
--  * app.portal_my_parts(org) offers only parts linked to that customer (part_customers) for the complaint's part picker.
--  * app.portal_list_complaints(org): the party's own complaints with a plain status worked out from the NC's stage; no internal fields.
-- A party can be stopped from raising complaints with the tile "complaints" = false (portal_parties.tiles); on by default.

ALTER TABLE public.portal_activity DROP CONSTRAINT IF EXISTS portal_activity_kind_check;
ALTER TABLE public.portal_activity
  ADD CONSTRAINT portal_activity_kind_check CHECK (kind IN ('scar_acknowledged', 'scar_response', 'scar_extension_requested', 'scar_extension_withdrawn', 'comment', 'acknowledged', 'scar_action_done', 'complaint_raised'));

CREATE TABLE public.portal_complaints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  party_id uuid NOT NULL,
  nonconformance_id uuid NOT NULL,
  raised_by uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE CASCADE,
  client_key text CHECK (client_key IS NULL OR length(client_key) BETWEEN 8 AND 80),
  raised_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT portal_complaints_party_fkey FOREIGN KEY (party_id, organisation_id) REFERENCES public.portal_parties (id, organisation_id),
  CONSTRAINT portal_complaints_ncr_fkey FOREIGN KEY (nonconformance_id, organisation_id) REFERENCES public.nonconformances (id, organisation_id),
  CONSTRAINT portal_complaints_ncr_key UNIQUE (nonconformance_id)
);
CREATE UNIQUE INDEX portal_complaints_client_key ON public.portal_complaints (party_id, client_key) WHERE client_key IS NOT NULL;
CREATE INDEX portal_complaints_party_idx ON public.portal_complaints (party_id, raised_at DESC);
CREATE FUNCTION app.portal_complaint_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN RAISE EXCEPTION 'A complaint record is never changed or deleted' USING ERRCODE = 'QM032'; END $$;
CREATE TRIGGER portal_complaints_frozen BEFORE UPDATE OR DELETE ON public.portal_complaints FOR EACH ROW EXECUTE FUNCTION app.portal_complaint_frozen();
CREATE TRIGGER portal_complaints_stamp BEFORE INSERT ON public.portal_complaints FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER audit_changes AFTER INSERT ON public.portal_complaints FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.portal_complaints ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.portal_complaints FROM anon, authenticated;
GRANT SELECT ON public.portal_complaints TO authenticated;
CREATE POLICY portal_complaints_select ON public.portal_complaints FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'external_access.share'));
REVOKE ALL ON FUNCTION app.portal_complaint_frozen() FROM PUBLIC, anon, authenticated;

-- The customer party of the caller (their own live access), or no_data_found (404).
CREATE FUNCTION app.portal_customer_party(p_org uuid, p_party uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE a record;
BEGIN
  SELECT * INTO a FROM app.portal_my_access(p_org) WHERE party_id = p_party AND party_kind = 'customer' AND customer_id IS NOT NULL LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found' USING ERRCODE = 'no_data_found'; END IF;
  RETURN a.customer_id;
END $$;
REVOKE ALL ON FUNCTION app.portal_customer_party(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- The parts we make for this customer (to pick from when raising a complaint): our number and name, and their own number for it.
CREATE FUNCTION app.portal_my_parts(p_org uuid, p_party uuid)
RETURNS TABLE (part_id uuid, part_number text, part_name text, customer_part_number text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_customer uuid := app.portal_customer_party(p_org, p_party);
BEGIN
  RETURN QUERY
  SELECT p.id, p.part_number, p.name, pc.customer_part_number
    FROM public.part_customers pc JOIN public.parts p ON p.id = pc.part_id AND p.organisation_id = pc.organisation_id
   WHERE pc.organisation_id = p_org AND pc.customer_id = v_customer AND p.active
   ORDER BY p.part_number LIMIT 500;
END $$;
REVOKE ALL ON FUNCTION app.portal_my_parts(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_my_parts(uuid, uuid) TO authenticated;

-- Raise a complaint: a draft non-conformance in the customer's words. Severity, category, site and the rest are staff's to decide.
CREATE FUNCTION app.portal_raise_complaint(p_org uuid, p_party uuid, p_title text, p_description text, p_part uuid, p_quantity numeric, p_lot text,
                                           p_customer_reference text, p_detected_on date, p_client_key text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_customer uuid := app.portal_customer_party(p_org, p_party); v_tiles jsonb; v_existing record; v_ncr uuid; v_id uuid; v_ref text; v_title text := btrim(coalesce(p_title, ''));
BEGIN
  SELECT coalesce(tiles, '{}'::jsonb) INTO v_tiles FROM public.portal_parties WHERE id = p_party;
  IF (v_tiles ->> 'complaints') = 'false' THEN RAISE EXCEPTION 'Raising complaints is not switched on for you' USING ERRCODE = 'QM032'; END IF;
  IF p_client_key IS NOT NULL THEN
    SELECT c.id, c.nonconformance_id INTO v_existing FROM public.portal_complaints c WHERE c.party_id = p_party AND c.client_key = p_client_key;
    IF FOUND THEN RETURN jsonb_build_object('id', v_existing.id, 'created', false); END IF;
  END IF;
  IF length(v_title) < 3 OR length(v_title) > 200 THEN RAISE EXCEPTION 'The title is 3 to 200 characters' USING ERRCODE = 'QM032'; END IF;
  IF length(btrim(coalesce(p_description, ''))) < 10 OR length(btrim(p_description)) > 4000 THEN RAISE EXCEPTION 'Describe the problem in 10 to 4,000 characters' USING ERRCODE = 'QM032'; END IF;
  IF p_quantity IS NOT NULL AND (p_quantity < 0 OR p_quantity > 100000000) THEN RAISE EXCEPTION 'The quantity is not valid' USING ERRCODE = 'QM032'; END IF;
  IF p_detected_on IS NOT NULL AND (p_detected_on > current_date OR p_detected_on < current_date - 3650) THEN RAISE EXCEPTION 'The date found must be in the past ten years and not in the future' USING ERRCODE = 'QM032'; END IF;
  IF length(coalesce(p_lot, '')) > 100 OR length(coalesce(p_customer_reference, '')) > 100 THEN RAISE EXCEPTION 'The lot and your reference are at most 100 characters' USING ERRCODE = 'QM032'; END IF;
  IF p_part IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.part_customers pc WHERE pc.part_id = p_part AND pc.customer_id = v_customer AND pc.organisation_id = p_org) THEN
    RAISE EXCEPTION 'That is not one of your parts' USING ERRCODE = 'QM032';
  END IF;

  INSERT INTO public.nonconformances (organisation_id, reference, source, stage, title, description, customer_id, part_id, quantity_affected, lot_number, customer_reference, detected_at)
  VALUES (p_org, 'pending', 'customer', 'draft', v_title, btrim(p_description), v_customer, p_part, p_quantity, nullif(btrim(coalesce(p_lot, '')), ''),
          nullif(btrim(coalesce(p_customer_reference, '')), ''), coalesce(p_detected_on, current_date))
  RETURNING id, reference INTO v_ncr, v_ref;
  INSERT INTO public.portal_complaints (organisation_id, party_id, nonconformance_id, client_key) VALUES (p_org, p_party, v_ncr, p_client_key) RETURNING id INTO v_id;
  PERFORM app.portal_note_activity(p_org, p_party, 'complaint_raised', 'ncr', v_ncr, v_ref || ' · ' || v_title, 'Raised a complaint: ' || left(btrim(p_description), 120));
  RETURN jsonb_build_object('id', v_id, 'created', true);
END $$;
REVOKE ALL ON FUNCTION app.portal_raise_complaint(uuid, uuid, text, text, uuid, numeric, text, text, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_raise_complaint(uuid, uuid, text, text, uuid, numeric, text, text, date, text) TO authenticated;

-- The party's own complaints with a plain status. Named columns only; staff's severity, category, owner and notes are not here.
CREATE FUNCTION app.portal_list_complaints(p_org uuid, p_party uuid)
RETURNS TABLE (complaint_id uuid, reference text, title text, description text, status text, raised_at timestamptz, raised_by_me boolean, part_number text, part_name text,
               quantity numeric, lot_number text, customer_reference text, detected_on date, share_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_customer uuid := app.portal_customer_party(p_org, p_party);
BEGIN
  RETURN QUERY
  SELECT c.id, n.reference, n.title, n.description,
         CASE WHEN n.deleted_at IS NOT NULL OR n.stage = 'cancelled' THEN 'cancelled' WHEN n.stage = 'draft' THEN 'received' WHEN n.stage = 'closed' THEN 'closed' ELSE 'in_progress' END,
         c.raised_at, c.raised_by = auth.uid(), p.part_number, p.name, n.quantity_affected, n.lot_number, n.customer_reference, n.detected_at,
         (SELECT s.id FROM public.portal_shares s WHERE s.nonconformance_id = n.id AND s.party_id = p_party AND s.withdrawn_at IS NULL LIMIT 1)
    FROM public.portal_complaints c JOIN public.nonconformances n ON n.id = c.nonconformance_id AND n.organisation_id = c.organisation_id
    LEFT JOIN public.parts p ON p.id = n.part_id AND p.organisation_id = n.organisation_id
   WHERE c.organisation_id = p_org AND c.party_id = p_party AND n.customer_id = v_customer
   ORDER BY c.raised_at DESC LIMIT 200;
END $$;
REVOKE ALL ON FUNCTION app.portal_list_complaints(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_list_complaints(uuid, uuid) TO authenticated;
