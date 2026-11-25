-- Change management, slice CH6a (docs/change-management-plan.md §8h, decision CH2): a customer sends a change request on one of their parts, and a
-- supplier notifies us of a process change (a PCN). Each arrives as a DRAFT change that staff review, complete and take through assessment — exactly as a
-- portal complaint arrives as a draft non-conformance. Nothing is submitted, assessed or decided for them.
--
--  * portal_change_requests links a portal request to its draft change and to who raised it (kind customer_request | supplier_notice). No table writes:
--    functions only, audited, never changed or deleted. Staff read it with external_access.share or change.read.
--  * app.portal_raise_change(...) checks the caller's own live portal access to the party (the party's customer or supplier comes from that access row,
--    never from the request); a customer's part must be one we make for them (part_customers), a supplier's one they supply (supplier_product_links);
--    a client key makes a retry return the same request. The draft change covers the part (when named) and the party, and tells staff (portal_activity).
--  * app.portal_change_parts / app.portal_list_change_requests give the picker and the party's own requests with a plain status worked out from the
--    change's stage (no internal reasons, owners or notes).
--  * app.portal_change_origin(id) names the request for staff on the change page ("Customer request from Wayne Ltd · Pat").
-- A party can be stopped from sending requests with the tile "changes" = false (portal_parties.tiles); on by default.
-- Errors QM032 (409 portal_rule); another party's or organisation's record is P0002 (404).

-- ---------------------------------------------------------------------------
-- 1. What can come from the portal
-- ---------------------------------------------------------------------------
ALTER TABLE public.change_requests DROP CONSTRAINT change_requests_origin_kind_check;
ALTER TABLE public.change_requests ADD CONSTRAINT change_requests_origin_kind_check
  CHECK (origin_kind IS NULL OR origin_kind IN ('ncr', 'capa', 'capa_action', 'audit_finding', 'risk', 'document_change_request', 'management_review_decision', 'portal_request'));

ALTER TABLE public.portal_activity DROP CONSTRAINT IF EXISTS portal_activity_kind_check;
ALTER TABLE public.portal_activity DROP CONSTRAINT IF EXISTS portal_activity_record_kind_check;
ALTER TABLE public.portal_activity
  ADD CONSTRAINT portal_activity_kind_check CHECK (kind IN ('scar_acknowledged', 'scar_response', 'scar_extension_requested', 'scar_extension_withdrawn', 'comment', 'acknowledged',
                                                             'scar_action_done', 'complaint_raised', 'closure_confirmed', 'closure_declined', 'change_requested')),
  ADD CONSTRAINT portal_activity_record_kind_check CHECK (record_kind IN ('scar', 'ncr', 'capa', 'document', 'quality_alert', 'change'));

-- ---------------------------------------------------------------------------
-- 2. The link between a portal request and its draft change
-- ---------------------------------------------------------------------------
CREATE TABLE public.portal_change_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  party_id uuid NOT NULL,
  change_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('customer_request', 'supplier_notice')),
  part_id uuid,
  wanted_on date,
  raised_by uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE CASCADE,
  client_key text CHECK (client_key IS NULL OR length(client_key) BETWEEN 8 AND 80),
  raised_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT portal_change_requests_party_fkey FOREIGN KEY (party_id, organisation_id) REFERENCES public.portal_parties (id, organisation_id),
  CONSTRAINT portal_change_requests_change_fkey FOREIGN KEY (change_id, organisation_id) REFERENCES public.change_requests (id, organisation_id),
  CONSTRAINT portal_change_requests_part_fkey FOREIGN KEY (part_id, organisation_id) REFERENCES public.parts (id, organisation_id),
  CONSTRAINT portal_change_requests_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT portal_change_requests_change_key UNIQUE (change_id)
);
CREATE UNIQUE INDEX portal_change_requests_client_key ON public.portal_change_requests (party_id, client_key) WHERE client_key IS NOT NULL;
CREATE INDEX portal_change_requests_party_idx ON public.portal_change_requests (party_id, raised_at DESC);
CREATE FUNCTION app.portal_change_request_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN RAISE EXCEPTION 'A portal change request record is never changed or deleted' USING ERRCODE = 'QM032'; END $$;
CREATE TRIGGER portal_change_requests_frozen BEFORE UPDATE OR DELETE ON public.portal_change_requests FOR EACH ROW EXECUTE FUNCTION app.portal_change_request_frozen();
CREATE TRIGGER portal_change_requests_stamp BEFORE INSERT ON public.portal_change_requests FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER audit_changes AFTER INSERT ON public.portal_change_requests FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.portal_change_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.portal_change_requests FROM anon, authenticated;
GRANT SELECT ON public.portal_change_requests TO authenticated;
CREATE POLICY portal_change_requests_select ON public.portal_change_requests FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'external_access.share') OR app.has_permission(organisation_id, 'change.read'));
REVOKE ALL ON FUNCTION app.portal_change_request_frozen() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. The caller's own party, and the parts they may name
-- ---------------------------------------------------------------------------
-- The caller's own live access to this party (customer or supplier); no_data_found (404) otherwise.
CREATE FUNCTION app.portal_change_party(p_org uuid, p_party uuid) RETURNS public.portal_parties
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE a record; p public.portal_parties%ROWTYPE;
BEGIN
  SELECT * INTO a FROM app.portal_my_access(p_org) WHERE party_id = p_party LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'Party not found' USING ERRCODE = 'no_data_found'; END IF;
  SELECT * INTO p FROM public.portal_parties WHERE id = p_party AND organisation_id = p_org;
  RETURN p;
END $$;
REVOKE ALL ON FUNCTION app.portal_change_party(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- A customer's parts are those we make for them; a supplier's are the parts they supply us. Our number and name, and their own number for it.
CREATE FUNCTION app.portal_change_parts(p_org uuid, p_party uuid)
RETURNS TABLE (part_id uuid, part_number text, part_name text, their_part_number text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE p public.portal_parties := app.portal_change_party(p_org, p_party);
BEGIN
  IF p.party_kind = 'customer' THEN
    RETURN QUERY
    SELECT x.id, x.part_number, x.name, pc.customer_part_number
      FROM public.part_customers pc JOIN public.parts x ON x.id = pc.part_id AND x.organisation_id = pc.organisation_id
     WHERE pc.organisation_id = p_org AND pc.customer_id = p.customer_id AND x.active
     ORDER BY x.part_number LIMIT 500;
  ELSE
    RETURN QUERY
    SELECT DISTINCT ON (x.part_number) x.id, x.part_number, x.name, l.supplier_part_number
      FROM public.supplier_product_links l JOIN public.parts x ON x.id = l.part_id AND x.organisation_id = l.organisation_id
     WHERE l.organisation_id = p_org AND l.supplier_id = p.supplier_id AND l.kind = 'part' AND l.active AND x.active
     ORDER BY x.part_number LIMIT 500;
  END IF;
END $$;
REVOKE ALL ON FUNCTION app.portal_change_parts(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_change_parts(uuid, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Sending a request
-- ---------------------------------------------------------------------------
-- A draft change in the party's own words. Type, urgency, board and everything else are staff's to decide (a customer's request starts as "Product design",
-- a supplier's notice as "Material or supplier"; staff can change the type while it is a draft).
CREATE FUNCTION app.portal_raise_change(p_org uuid, p_party uuid, p_title text, p_description text, p_reason text, p_part uuid, p_wanted_on date, p_client_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  p public.portal_parties := app.portal_change_party(p_org, p_party);
  v_existing record; v_kind text; v_type uuid; v_id uuid; v_change uuid; v_ref text; v_n integer; v_yy smallint := (extract(year FROM current_date)::integer % 100)::smallint;
  v_new uuid := gen_random_uuid(); v_title text := btrim(coalesce(p_title, '')); v_desc text := btrim(coalesce(p_description, '')); v_reason text := btrim(coalesce(p_reason, '')); v_who text;
BEGIN
  IF (coalesce(p.tiles, '{}'::jsonb) ->> 'changes') = 'false' THEN RAISE EXCEPTION 'Sending change requests is not switched on for you' USING ERRCODE = 'QM032'; END IF;
  IF p_client_key IS NOT NULL THEN
    SELECT c.id INTO v_existing FROM public.portal_change_requests c WHERE c.party_id = p_party AND c.client_key = p_client_key;
    IF FOUND THEN RETURN jsonb_build_object('id', v_existing.id, 'created', false); END IF;
  END IF;
  IF length(v_title) < 3 OR length(v_title) > 200 THEN RAISE EXCEPTION 'The title is 3 to 200 characters' USING ERRCODE = 'QM032'; END IF;
  IF length(v_desc) < 10 OR length(v_desc) > 4000 THEN RAISE EXCEPTION 'Describe the change in 10 to 4,000 characters' USING ERRCODE = 'QM032'; END IF;
  IF length(v_reason) > 2000 THEN RAISE EXCEPTION 'The reason is at most 2,000 characters' USING ERRCODE = 'QM032'; END IF;
  IF p_wanted_on IS NOT NULL AND (p_wanted_on < current_date OR p_wanted_on > current_date + 3650) THEN RAISE EXCEPTION 'The date you want it from must be today or later, within ten years' USING ERRCODE = 'QM032'; END IF;
  IF p_part IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.portal_change_parts(p_org, p_party) x WHERE x.part_id = p_part) THEN
    RAISE EXCEPTION 'That is not one of your parts' USING ERRCODE = 'QM032';
  END IF;

  v_kind := CASE WHEN p.party_kind = 'customer' THEN 'customer_request' ELSE 'supplier_notice' END;
  SELECT t.id INTO v_type FROM public.change_types t
   WHERE t.organisation_id = p_org AND t.active
   ORDER BY (t.key = CASE WHEN v_kind = 'customer_request' THEN 'product_design' ELSE 'material' END) DESC, t.sequence LIMIT 1;
  IF v_type IS NULL THEN RAISE EXCEPTION 'Change requests are not set up yet' USING ERRCODE = 'QM032'; END IF;

  v_who := coalesce((SELECT name FROM public.customers WHERE id = p.customer_id), (SELECT name FROM public.suppliers WHERE id = p.supplier_id), 'A customer or supplier');
  INSERT INTO app.change_counters AS c (organisation_id, year, last_value) VALUES (p_org, v_yy, 1)
  ON CONFLICT (organisation_id, year) DO UPDATE SET last_value = c.last_value + 1 RETURNING last_value INTO v_n;
  INSERT INTO public.change_requests (organisation_id, reference, title, description, reason, type_id, urgency, origin_kind, origin_id)
  VALUES (p_org, 'ECR-' || lpad(v_yy::text, 2, '0') || '-' || app.pad_number(v_n, 4), v_title, v_desc,
          nullif(btrim(concat_ws(E'\n', CASE WHEN v_kind = 'customer_request' THEN 'Requested by ' ELSE 'Notified by ' END || v_who || '.',
                                 CASE WHEN p_wanted_on IS NOT NULL THEN 'They asked for it from ' || to_char(p_wanted_on, 'DD Mon YYYY') || '.' END, nullif(v_reason, ''))), ''),
          v_type, 'normal', 'portal_request', v_new)
  RETURNING id, reference INTO v_change, v_ref;
  -- The change's origin names this request (its id was chosen first), so the origin is never changed afterwards.
  INSERT INTO public.portal_change_requests (id, organisation_id, party_id, change_id, kind, part_id, wanted_on, client_key)
  VALUES (v_new, p_org, p_party, v_change, v_kind, p_part, p_wanted_on, p_client_key) RETURNING id INTO v_id;
  IF p_part IS NOT NULL THEN INSERT INTO public.change_links (organisation_id, change_id, kind, part_id) VALUES (p_org, v_change, 'part', p_part); END IF;
  IF p.party_kind = 'customer' THEN INSERT INTO public.change_links (organisation_id, change_id, kind, customer_id) VALUES (p_org, v_change, 'customer', p.customer_id);
  ELSE INSERT INTO public.change_links (organisation_id, change_id, kind, supplier_id) VALUES (p_org, v_change, 'supplier', p.supplier_id); END IF;
  PERFORM app.portal_note_activity(p_org, p_party, 'change_requested', 'change', v_change, v_ref || ' · ' || v_title,
                                   CASE WHEN v_kind = 'customer_request' THEN 'Sent a change request: ' ELSE 'Notified a process change: ' END || left(v_desc, 120));
  RETURN jsonb_build_object('id', v_id, 'created', true);
END $$;
REVOKE ALL ON FUNCTION app.portal_raise_change(uuid, uuid, text, text, text, uuid, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_raise_change(uuid, uuid, text, text, text, uuid, date, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. The party's own requests (named columns only)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.portal_list_change_requests(p_org uuid, p_party uuid)
RETURNS TABLE (request_id uuid, reference text, kind text, title text, description text, status text, raised_at timestamptz, raised_by_me boolean,
               part_number text, part_name text, wanted_on date)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE p public.portal_parties := app.portal_change_party(p_org, p_party);
BEGIN
  RETURN QUERY
  SELECT r.id, c.reference, r.kind, c.title, c.description,
         CASE c.stage WHEN 'draft' THEN 'received' WHEN 'assessment' THEN 'under_review' WHEN 'approval' THEN 'under_review'
                      WHEN 'approved' THEN 'accepted' WHEN 'implementing' THEN 'accepted' WHEN 'verifying' THEN 'accepted'
                      WHEN 'closed' THEN 'done' WHEN 'rejected' THEN 'declined' ELSE 'cancelled' END,
         r.raised_at, r.raised_by = auth.uid(), x.part_number, x.name, r.wanted_on
    FROM public.portal_change_requests r
    JOIN public.change_requests c ON c.id = r.change_id AND c.organisation_id = r.organisation_id
    LEFT JOIN public.parts x ON x.id = r.part_id AND x.organisation_id = r.organisation_id
   WHERE r.organisation_id = p_org AND r.party_id = p.id
   ORDER BY r.raised_at DESC LIMIT 200;
END $$;
REVOKE ALL ON FUNCTION app.portal_list_change_requests(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_list_change_requests(uuid, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. For staff: where a change came from
-- ---------------------------------------------------------------------------
-- "Customer request from Wayne Ltd" and the person who sent it; null unless the caller may read changes in that organisation.
CREATE FUNCTION app.portal_change_origin(p_request uuid) RETURNS TABLE (kind text, party_name text, person_name text, party_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.portal_change_requests%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.portal_change_requests WHERE id = p_request;
  IF NOT FOUND OR NOT (app.has_permission(r.organisation_id, 'change.read') OR app.has_permission(r.organisation_id, 'external_access.share')) THEN RETURN; END IF;
  RETURN QUERY
  SELECT r.kind, coalesce(cus.name, sup.name),
         coalesce(nullif(trim(coalesce(pr.first_name, '') || ' ' || coalesce(pr.surname, '')), ''), (SELECT split_part(u.email, '@', 1) FROM auth.users u WHERE u.id = r.raised_by), 'Someone'),
         r.party_id
    FROM public.portal_parties pp LEFT JOIN public.customers cus ON cus.id = pp.customer_id LEFT JOIN public.suppliers sup ON sup.id = pp.supplier_id
    LEFT JOIN public.profiles pr ON pr.id = r.raised_by
   WHERE pp.id = r.party_id;
END $$;
REVOKE ALL ON FUNCTION app.portal_change_origin(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_change_origin(uuid) TO authenticated;
