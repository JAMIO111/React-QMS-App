-- Supplier Quality SQ3e: the SCAR fields and workflow the spec asks for and SQ3 left out (docs/supplier-quality-plan.md).
--
--  * supplier_scars: requirement breached, objective evidence, containment requirements and an INTERNAL OWNER (an active member; defaults to whoever raised it).
--  * supplier_scar_items: what is affected — parts, materials (in words), lots and receipts (a typed reference until receiving exists), quantities. Added while the SCAR runs, ended with a reason, never deleted.
--  * supplier_scar_responses: extent of condition, escape-point analysis, who at the supplier is responsible, and the method used for the root cause (5 Whys, fishbone, other).
--  * supplier_scar_extensions: a due-date extension is now REQUESTED (by whoever records the supplier's request) and DECIDED by a different person with supplier_quality.approve,
--    approved or rejected with a note, or withdrawn. The due date moves only when it is approved. Extensions recorded before this change stay as approved.
-- The create and record-response functions keep their old calls working (new arguments have defaults).

-- ---------------------------------------------------------------------------
-- The SCAR itself
-- ---------------------------------------------------------------------------
ALTER TABLE public.supplier_scars
  ADD COLUMN requirement_breached text CHECK (requirement_breached IS NULL OR length(btrim(requirement_breached)) BETWEEN 1 AND 2000),
  ADD COLUMN objective_evidence text CHECK (objective_evidence IS NULL OR length(btrim(objective_evidence)) BETWEEN 1 AND 4000),
  ADD COLUMN containment_requirements text CHECK (containment_requirements IS NULL OR length(btrim(containment_requirements)) BETWEEN 1 AND 4000),
  ADD COLUMN owner_user_id uuid REFERENCES auth.users (id) ON DELETE SET NULL;
UPDATE public.supplier_scars SET owner_user_id = created_by WHERE owner_user_id IS NULL;
CREATE INDEX supplier_scars_owner_idx ON public.supplier_scars (owner_user_id) WHERE owner_user_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Affected items
-- ---------------------------------------------------------------------------
CREATE TABLE public.supplier_scar_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  scar_id uuid NOT NULL,
  part_id uuid,
  material text CHECK (material IS NULL OR length(btrim(material)) BETWEEN 1 AND 200),
  lot_id uuid,
  receipt_reference text CHECK (receipt_reference IS NULL OR length(btrim(receipt_reference)) BETWEEN 1 AND 100),
  quantity numeric(14, 3) CHECK (quantity IS NULL OR quantity >= 0),
  notes text CHECK (notes IS NULL OR length(btrim(notes)) BETWEEN 1 AND 1000),
  ended_at timestamptz,
  ended_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  end_reason text CHECK (end_reason IS NULL OR length(btrim(end_reason)) BETWEEN 3 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT supplier_scar_items_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT supplier_scar_items_scar_fkey FOREIGN KEY (scar_id, organisation_id) REFERENCES public.supplier_scars (id, organisation_id),
  CONSTRAINT supplier_scar_items_part_fkey FOREIGN KEY (part_id, organisation_id) REFERENCES public.parts (id, organisation_id),
  CONSTRAINT supplier_scar_items_lot_fkey FOREIGN KEY (lot_id, organisation_id) REFERENCES public.lots (id, organisation_id),
  CONSTRAINT supplier_scar_items_something CHECK (part_id IS NOT NULL OR material IS NOT NULL OR lot_id IS NOT NULL OR receipt_reference IS NOT NULL),
  CONSTRAINT supplier_scar_items_ended CHECK ((ended_at IS NULL) = (end_reason IS NULL))
);
CREATE INDEX supplier_scar_items_scar_idx ON public.supplier_scar_items (scar_id);
CREATE INDEX supplier_scar_items_lot_idx ON public.supplier_scar_items (lot_id) WHERE lot_id IS NOT NULL;
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.supplier_scar_items FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.supplier_scar_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.supplier_scar_items FROM anon, authenticated;
GRANT SELECT ON public.supplier_scar_items TO authenticated;
CREATE POLICY supplier_scar_items_select ON public.supplier_scar_items FOR SELECT TO authenticated USING (app.has_permission(organisation_id, 'supplier_quality.read'));
CREATE TRIGGER supplier_scar_items_stamp BEFORE INSERT ON public.supplier_scar_items FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER supplier_scar_items_touch BEFORE UPDATE ON public.supplier_scar_items FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER supplier_scar_items_org_immutable BEFORE UPDATE ON public.supplier_scar_items FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();

-- Add an affected item to a SCAR that is not closed or cancelled. p_item keys: partId, material, lotId, receiptReference, quantity, notes. A lot brings its part along; a part and a lot must agree.
CREATE FUNCTION app.add_scar_item(p_scar uuid, p_item jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.supplier_scars%ROWTYPE; v_part uuid := nullif(p_item ->> 'partId', '')::uuid; v_lot uuid := nullif(p_item ->> 'lotId', '')::uuid; l public.lots%ROWTYPE; v_id uuid; v_qty numeric;
BEGIN
  c := app.scar_for_write(p_scar);
  IF c.status IN ('closed', 'cancelled') THEN RAISE EXCEPTION 'A % SCAR cannot be changed', c.status USING ERRCODE = 'QM020'; END IF;
  IF jsonb_typeof(p_item) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Describe the affected item' USING ERRCODE = 'QM020'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_item) k WHERE k NOT IN ('partId', 'material', 'lotId', 'receiptReference', 'quantity', 'notes')) THEN RAISE EXCEPTION 'Unknown field in the affected item' USING ERRCODE = 'QM020'; END IF;
  IF v_lot IS NOT NULL THEN
    SELECT * INTO l FROM public.lots WHERE id = v_lot AND organisation_id = c.organisation_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Lot not found' USING ERRCODE = 'P0002'; END IF;
    IF v_part IS NOT NULL AND v_part <> l.part_id THEN RAISE EXCEPTION 'That lot is of another part' USING ERRCODE = 'QM020'; END IF;
    v_part := l.part_id;
  END IF;
  IF v_part IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.parts WHERE id = v_part AND organisation_id = c.organisation_id) THEN RAISE EXCEPTION 'Part not found' USING ERRCODE = 'P0002'; END IF;
  IF p_item ->> 'quantity' IS NOT NULL THEN
    IF (p_item ->> 'quantity') !~ '^[0-9]+(\.[0-9]{1,3})?$' THEN RAISE EXCEPTION 'The quantity is a number, zero or more' USING ERRCODE = 'QM020'; END IF;
    v_qty := (p_item ->> 'quantity')::numeric;
  END IF;
  IF v_part IS NULL AND nullif(btrim(coalesce(p_item ->> 'material', '')), '') IS NULL AND nullif(btrim(coalesce(p_item ->> 'receiptReference', '')), '') IS NULL THEN
    RAISE EXCEPTION 'Name a part, a material, a lot or a receipt' USING ERRCODE = 'QM020';
  END IF;
  INSERT INTO public.supplier_scar_items (organisation_id, scar_id, part_id, material, lot_id, receipt_reference, quantity, notes)
  VALUES (c.organisation_id, c.id, v_part, nullif(btrim(coalesce(p_item ->> 'material', '')), ''), v_lot, nullif(btrim(coalesce(p_item ->> 'receiptReference', '')), ''), v_qty, nullif(btrim(coalesce(p_item ->> 'notes', '')), ''))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION app.remove_scar_item(p_item uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE i public.supplier_scar_items%ROWTYPE; c public.supplier_scars%ROWTYPE;
BEGIN
  SELECT * INTO i FROM public.supplier_scar_items WHERE id = p_item;
  IF NOT FOUND THEN RAISE EXCEPTION 'Item not found' USING ERRCODE = 'P0002'; END IF;
  c := app.scar_for_write(i.scar_id);
  IF c.status IN ('closed', 'cancelled') THEN RAISE EXCEPTION 'A % SCAR cannot be changed', c.status USING ERRCODE = 'QM020'; END IF;
  IF i.ended_at IS NOT NULL THEN RAISE EXCEPTION 'That item has already been removed' USING ERRCODE = 'QM020'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'Say why the item is being removed (3 to 1000 characters)' USING ERRCODE = 'QM020'; END IF;
  UPDATE public.supplier_scar_items SET ended_at = now(), ended_by = auth.uid(), end_reason = btrim(p_reason) WHERE id = i.id;
END $$;

-- ---------------------------------------------------------------------------
-- Creating and editing a SCAR with the new fields
-- ---------------------------------------------------------------------------
DROP FUNCTION app.create_supplier_scar(uuid, text, text, text, date, uuid, uuid[], uuid, text);
-- p_extra keys: requirementBreached, objectiveEvidence, containmentRequirements, ownerId (an active member; default the caller), items (an array as add_scar_item takes).
CREATE FUNCTION app.create_supplier_scar(p_supplier uuid, p_title text, p_description text, p_severity text, p_response_due_on date, p_contact uuid, p_ncrs uuid[], p_capa uuid, p_client_key text, p_extra jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.suppliers%ROWTYPE; v_year integer := extract(year FROM now())::int; v_n integer; v_id uuid; n uuid; it jsonb; v_extra jsonb := coalesce(p_extra, '{}'::jsonb); v_owner uuid;
BEGIN
  s := app.supplier_for_write(p_supplier, 'supplier_quality.manage');
  IF p_client_key IS NOT NULL THEN
    SELECT id INTO v_id FROM public.supplier_scars WHERE organisation_id = s.organisation_id AND client_key = p_client_key;
    IF FOUND THEN
      IF (SELECT supplier_id FROM public.supplier_scars WHERE id = v_id) <> s.id THEN RAISE EXCEPTION 'That request key was used for another supplier' USING ERRCODE = 'QM020'; END IF;
      RETURN jsonb_build_object('id', v_id, 'created', false);
    END IF;
  END IF;
  IF p_title IS NULL OR length(btrim(p_title)) NOT BETWEEN 3 AND 200 THEN RAISE EXCEPTION 'Give the SCAR a title (3 to 200 characters)' USING ERRCODE = 'QM020'; END IF;
  IF p_response_due_on IS NOT NULL AND p_response_due_on < current_date THEN RAISE EXCEPTION 'The response due date cannot be in the past' USING ERRCODE = 'QM020'; END IF;
  IF p_contact IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.supplier_contacts WHERE id = p_contact AND supplier_id = s.id AND organisation_id = s.organisation_id) THEN
    RAISE EXCEPTION 'That contact does not belong to this supplier' USING ERRCODE = 'QM020';
  END IF;
  IF p_capa IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.capas WHERE id = p_capa AND organisation_id = s.organisation_id) THEN RAISE EXCEPTION '8D not found' USING ERRCODE = 'P0002'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_extra) k WHERE k NOT IN ('requirementBreached', 'objectiveEvidence', 'containmentRequirements', 'ownerId', 'items')) THEN RAISE EXCEPTION 'Unknown field' USING ERRCODE = 'QM020'; END IF;
  v_owner := coalesce(nullif(v_extra ->> 'ownerId', '')::uuid, auth.uid());
  IF v_owner IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.organisation_users WHERE organisation_id = s.organisation_id AND user_id = v_owner AND status = 'active') THEN
    RAISE EXCEPTION 'The internal owner must be an active member of this organisation' USING ERRCODE = 'QM020';
  END IF;
  INSERT INTO app.supplier_scar_counters AS k (organisation_id, year, last_value) VALUES (s.organisation_id, v_year, 1)
  ON CONFLICT (organisation_id, year) DO UPDATE SET last_value = k.last_value + 1 RETURNING last_value INTO v_n;
  INSERT INTO public.supplier_scars (organisation_id, reference, supplier_id, title, problem_description, severity, contact_id, capa_id, original_response_due_on, response_due_on, client_key,
                                     requirement_breached, objective_evidence, containment_requirements, owner_user_id)
  VALUES (s.organisation_id, 'SCAR-' || to_char(make_date(v_year, 1, 1), 'YY') || '-' || lpad(v_n::text, 4, '0'), s.id, btrim(p_title), nullif(btrim(coalesce(p_description, '')), ''),
          coalesce(p_severity, 'minor'), p_contact, p_capa, p_response_due_on, p_response_due_on, p_client_key,
          nullif(btrim(coalesce(v_extra ->> 'requirementBreached', '')), ''), nullif(btrim(coalesce(v_extra ->> 'objectiveEvidence', '')), ''), nullif(btrim(coalesce(v_extra ->> 'containmentRequirements', '')), ''), v_owner)
  RETURNING id INTO v_id;
  INSERT INTO public.supplier_scar_status_history (organisation_id, scar_id, from_status, to_status, reason) VALUES (s.organisation_id, v_id, NULL, 'draft', 'Created');
  IF p_ncrs IS NOT NULL THEN
    FOREACH n IN ARRAY p_ncrs LOOP PERFORM app.link_scar_ncr(v_id, n); END LOOP;
  END IF;
  IF jsonb_typeof(v_extra -> 'items') = 'array' THEN
    FOR it IN SELECT x FROM jsonb_array_elements(v_extra -> 'items') x LOOP PERFORM app.add_scar_item(v_id, it); END LOOP;
  END IF;
  RETURN jsonb_build_object('id', v_id, 'created', true);
END $$;

-- A draft may change everything; once issued only the contact, the internal owner and the 8D link.
CREATE OR REPLACE FUNCTION app.update_supplier_scar(p_scar uuid, p_changes jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.supplier_scars%ROWTYPE; k text; v_contact uuid; v_capa uuid; v_owner uuid;
BEGIN
  c := app.scar_for_write(p_scar);
  IF c.status IN ('closed', 'cancelled') THEN RAISE EXCEPTION 'A % SCAR cannot be changed', c.status USING ERRCODE = 'QM020'; END IF;
  FOR k IN SELECT jsonb_object_keys(p_changes) LOOP
    IF k NOT IN ('title', 'problemDescription', 'severity', 'responseDueOn', 'contactId', 'capaId', 'ownerId', 'requirementBreached', 'objectiveEvidence', 'containmentRequirements') THEN RAISE EXCEPTION 'Unknown field %', k USING ERRCODE = 'QM020'; END IF;
    IF c.status <> 'draft' AND k NOT IN ('contactId', 'capaId', 'ownerId') THEN RAISE EXCEPTION 'Once issued only the contact, the owner and the 8D link can change (use an extension to move the due date)' USING ERRCODE = 'QM020'; END IF;
  END LOOP;
  IF p_changes ? 'title' AND length(btrim(coalesce(p_changes ->> 'title', ''))) NOT BETWEEN 3 AND 200 THEN RAISE EXCEPTION 'Give the SCAR a title (3 to 200 characters)' USING ERRCODE = 'QM020'; END IF;
  IF p_changes ? 'severity' AND coalesce(p_changes ->> 'severity', '') NOT IN ('minor', 'major', 'critical') THEN RAISE EXCEPTION 'Severity is minor, major or critical' USING ERRCODE = 'QM020'; END IF;
  IF p_changes ? 'responseDueOn' AND (p_changes ->> 'responseDueOn') IS NOT NULL AND (p_changes ->> 'responseDueOn')::date < current_date THEN RAISE EXCEPTION 'The response due date cannot be in the past' USING ERRCODE = 'QM020'; END IF;
  v_contact := CASE WHEN p_changes ? 'contactId' THEN nullif(p_changes ->> 'contactId', '')::uuid ELSE c.contact_id END;
  v_capa := CASE WHEN p_changes ? 'capaId' THEN nullif(p_changes ->> 'capaId', '')::uuid ELSE c.capa_id END;
  v_owner := CASE WHEN p_changes ? 'ownerId' THEN nullif(p_changes ->> 'ownerId', '')::uuid ELSE c.owner_user_id END;
  IF v_contact IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.supplier_contacts WHERE id = v_contact AND supplier_id = c.supplier_id AND organisation_id = c.organisation_id) THEN
    RAISE EXCEPTION 'That contact does not belong to this supplier' USING ERRCODE = 'QM020';
  END IF;
  IF v_capa IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.capas WHERE id = v_capa AND organisation_id = c.organisation_id) THEN RAISE EXCEPTION '8D not found' USING ERRCODE = 'P0002'; END IF;
  IF v_owner IS NULL AND p_changes ? 'ownerId' THEN RAISE EXCEPTION 'A SCAR needs an internal owner' USING ERRCODE = 'QM020'; END IF;
  IF v_owner IS DISTINCT FROM c.owner_user_id AND NOT EXISTS (SELECT 1 FROM public.organisation_users WHERE organisation_id = c.organisation_id AND user_id = v_owner AND status = 'active') THEN
    RAISE EXCEPTION 'The internal owner must be an active member of this organisation' USING ERRCODE = 'QM020';
  END IF;
  UPDATE public.supplier_scars SET
    title = CASE WHEN p_changes ? 'title' THEN btrim(p_changes ->> 'title') ELSE title END,
    problem_description = CASE WHEN p_changes ? 'problemDescription' THEN nullif(btrim(coalesce(p_changes ->> 'problemDescription', '')), '') ELSE problem_description END,
    requirement_breached = CASE WHEN p_changes ? 'requirementBreached' THEN nullif(btrim(coalesce(p_changes ->> 'requirementBreached', '')), '') ELSE requirement_breached END,
    objective_evidence = CASE WHEN p_changes ? 'objectiveEvidence' THEN nullif(btrim(coalesce(p_changes ->> 'objectiveEvidence', '')), '') ELSE objective_evidence END,
    containment_requirements = CASE WHEN p_changes ? 'containmentRequirements' THEN nullif(btrim(coalesce(p_changes ->> 'containmentRequirements', '')), '') ELSE containment_requirements END,
    severity = CASE WHEN p_changes ? 'severity' THEN p_changes ->> 'severity' ELSE severity END,
    original_response_due_on = CASE WHEN p_changes ? 'responseDueOn' THEN (p_changes ->> 'responseDueOn')::date ELSE original_response_due_on END,
    response_due_on = CASE WHEN p_changes ? 'responseDueOn' THEN (p_changes ->> 'responseDueOn')::date ELSE response_due_on END,
    contact_id = v_contact, capa_id = v_capa, owner_user_id = v_owner, updated_by = auth.uid()
  WHERE id = c.id;
END $$;

-- ---------------------------------------------------------------------------
-- The supplier's response: extent of condition, escape point, who is responsible, method
-- ---------------------------------------------------------------------------
ALTER TABLE public.supplier_scar_responses
  ADD COLUMN extent_of_condition text CHECK (extent_of_condition IS NULL OR length(btrim(extent_of_condition)) BETWEEN 1 AND 4000),
  ADD COLUMN escape_point text CHECK (escape_point IS NULL OR length(btrim(escape_point)) BETWEEN 1 AND 4000),
  ADD COLUMN responsible_name text CHECK (responsible_name IS NULL OR length(btrim(responsible_name)) BETWEEN 1 AND 200),
  ADD COLUMN root_cause_method text CHECK (root_cause_method IS NULL OR root_cause_method IN ('five_whys', 'fishbone', 'other'));

-- Extensions are decided by a different person, so a pending one may change (once) while every other kind of SCAR record stays frozen. Defined before the function that settles them.
ALTER TABLE public.supplier_scar_extensions
  ADD COLUMN status text NOT NULL DEFAULT 'approved' CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  ADD COLUMN decided_at timestamptz,
  ADD COLUMN decided_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  ADD COLUMN decision_note text CHECK (decision_note IS NULL OR length(btrim(decision_note)) BETWEEN 3 AND 1000);
ALTER TABLE public.supplier_scar_extensions DISABLE TRIGGER supplier_scar_extensions_frozen;
UPDATE public.supplier_scar_extensions SET decided_at = extended_at, decided_by = extended_by, decision_note = 'Recorded before extensions needed approval';
ALTER TABLE public.supplier_scar_extensions ENABLE TRIGGER supplier_scar_extensions_frozen;
DROP TRIGGER supplier_scar_extensions_frozen ON public.supplier_scar_extensions;
ALTER TABLE public.supplier_scar_extensions ADD CONSTRAINT supplier_scar_extensions_state CHECK (
  (status = 'pending' AND decided_at IS NULL) OR (status <> 'pending' AND decided_at IS NOT NULL AND decision_note IS NOT NULL));
CREATE UNIQUE INDEX supplier_scar_extensions_one_pending ON public.supplier_scar_extensions (scar_id) WHERE status = 'pending';

CREATE FUNCTION app.scar_extension_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'SCAR records are never changed or deleted once written' USING ERRCODE = 'QM020'; END IF;
  IF OLD.status <> 'pending' OR NEW.status NOT IN ('approved', 'rejected', 'withdrawn')
     OR NEW.scar_id IS DISTINCT FROM OLD.scar_id OR NEW.previous_due_on IS DISTINCT FROM OLD.previous_due_on OR NEW.new_due_on IS DISTINCT FROM OLD.new_due_on
     OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.extended_by IS DISTINCT FROM OLD.extended_by OR NEW.extended_at IS DISTINCT FROM OLD.extended_at THEN
    RAISE EXCEPTION 'SCAR records are never changed or deleted once written' USING ERRCODE = 'QM020';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER supplier_scar_extensions_guard BEFORE UPDATE OR DELETE ON public.supplier_scar_extensions FOR EACH ROW EXECUTE FUNCTION app.scar_extension_guard();

-- A response or a cancellation makes a waiting request pointless: it is withdrawn with a note.
CREATE FUNCTION app.scar_settle_pending_extension(p_scar uuid, p_note text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.supplier_scar_extensions SET status = 'withdrawn', decided_at = now(), decided_by = auth.uid(), decision_note = p_note WHERE scar_id = p_scar AND status = 'pending';
END $$;

DROP FUNCTION app.record_scar_response(uuid, text, text, text, text, date, date, text, uuid);
CREATE FUNCTION app.record_scar_response(p_scar uuid, p_root_cause text, p_containment text, p_corrective_action text, p_preventive_action text, p_planned_completion_on date, p_responded_on date, p_responded_by text, p_contact uuid,
                                         p_extent_of_condition text DEFAULT NULL, p_escape_point text DEFAULT NULL, p_responsible_name text DEFAULT NULL, p_root_cause_method text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.supplier_scars%ROWTYPE; v_seq integer; v_id uuid;
BEGIN
  c := app.scar_for_write(p_scar);
  IF c.status NOT IN ('issued', 'acknowledged', 'revision_requested') THEN RAISE EXCEPTION 'A response cannot be recorded while the SCAR is %', replace(c.status, '_', ' ') USING ERRCODE = 'QM020'; END IF;
  IF p_root_cause IS NULL OR length(btrim(p_root_cause)) NOT BETWEEN 3 AND 4000 THEN RAISE EXCEPTION 'The response needs a root cause (up to 4000 characters)' USING ERRCODE = 'QM020'; END IF;
  IF p_corrective_action IS NULL OR length(btrim(p_corrective_action)) NOT BETWEEN 3 AND 4000 THEN RAISE EXCEPTION 'The response needs a corrective action (up to 4000 characters)' USING ERRCODE = 'QM020'; END IF;
  IF p_responded_on IS NULL OR p_responded_on > current_date THEN RAISE EXCEPTION 'Say when the supplier responded (not in the future)' USING ERRCODE = 'QM020'; END IF;
  IF p_root_cause_method IS NOT NULL AND p_root_cause_method NOT IN ('five_whys', 'fishbone', 'other') THEN RAISE EXCEPTION 'The root cause method is 5 whys, fishbone or other' USING ERRCODE = 'QM020'; END IF;
  IF p_contact IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.supplier_contacts WHERE id = p_contact AND supplier_id = c.supplier_id AND organisation_id = c.organisation_id) THEN
    RAISE EXCEPTION 'That contact does not belong to this supplier' USING ERRCODE = 'QM020';
  END IF;
  SELECT coalesce(max(seq), 0) + 1 INTO v_seq FROM public.supplier_scar_responses WHERE scar_id = c.id;
  INSERT INTO public.supplier_scar_responses (organisation_id, scar_id, seq, root_cause, containment, corrective_action, preventive_action, planned_completion_on, responded_on, responded_by_name, contact_id,
                                              extent_of_condition, escape_point, responsible_name, root_cause_method)
  VALUES (c.organisation_id, c.id, v_seq, btrim(p_root_cause), nullif(btrim(coalesce(p_containment, '')), ''), btrim(p_corrective_action), nullif(btrim(coalesce(p_preventive_action, '')), ''),
          p_planned_completion_on, p_responded_on, nullif(btrim(coalesce(p_responded_by, '')), ''), p_contact,
          nullif(btrim(coalesce(p_extent_of_condition, '')), ''), nullif(btrim(coalesce(p_escape_point, '')), ''), nullif(btrim(coalesce(p_responsible_name, '')), ''), p_root_cause_method) RETURNING id INTO v_id;
  PERFORM app.scar_settle_pending_extension(c.id, 'The response arrived, so the extension is no longer needed');
  PERFORM app.scar_set_status(c, 'response_received', 'Response ' || v_seq || ' received');
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------
-- Due-date extensions: requested, then decided by a different approver
-- ---------------------------------------------------------------------------
DROP FUNCTION app.extend_scar_due_date(uuid, date, text);

CREATE FUNCTION app.request_scar_extension(p_scar uuid, p_new_due_on date, p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.supplier_scars%ROWTYPE; v_id uuid;
BEGIN
  c := app.scar_for_write(p_scar);
  IF c.status NOT IN ('issued', 'acknowledged', 'revision_requested') THEN RAISE EXCEPTION 'The due date can only move while a response is awaited' USING ERRCODE = 'QM020'; END IF;
  IF p_new_due_on IS NULL OR c.response_due_on IS NULL OR p_new_due_on <= c.response_due_on THEN RAISE EXCEPTION 'The new due date must be later than the current one' USING ERRCODE = 'QM020'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'Say why more time is needed (3 to 1000 characters)' USING ERRCODE = 'QM020'; END IF;
  IF EXISTS (SELECT 1 FROM public.supplier_scar_extensions WHERE scar_id = c.id AND status = 'pending') THEN RAISE EXCEPTION 'An extension is already waiting for a decision' USING ERRCODE = 'QM020'; END IF;
  INSERT INTO public.supplier_scar_extensions (organisation_id, scar_id, previous_due_on, new_due_on, reason, status) VALUES (c.organisation_id, c.id, c.response_due_on, p_new_due_on, btrim(p_reason), 'pending') RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Approve (the due date moves) or reject. Needs supplier_quality.approve and is never the person who asked.
CREATE FUNCTION app.decide_scar_extension(p_extension uuid, p_approve boolean, p_note text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE x public.supplier_scar_extensions%ROWTYPE; c public.supplier_scars%ROWTYPE; v_note text := btrim(coalesce(p_note, ''));
BEGIN
  SELECT * INTO x FROM public.supplier_scar_extensions WHERE id = p_extension FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Extension not found' USING ERRCODE = 'P0002'; END IF;
  c := app.scar_for_write(x.scar_id, 'supplier_quality.approve');
  IF x.status <> 'pending' THEN RAISE EXCEPTION 'That request has already been decided' USING ERRCODE = 'QM020'; END IF;
  IF x.extended_by IS NOT DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'Someone else decides: you cannot approve an extension you asked for' USING ERRCODE = 'QM020'; END IF;
  IF length(v_note) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'Give a reason for the decision (3 to 1000 characters)' USING ERRCODE = 'QM020'; END IF;
  IF p_approve THEN
    IF c.status NOT IN ('issued', 'acknowledged', 'revision_requested') THEN RAISE EXCEPTION 'The SCAR is no longer waiting for a response' USING ERRCODE = 'QM020'; END IF;
    IF c.response_due_on IS NOT NULL AND x.new_due_on <= c.response_due_on THEN RAISE EXCEPTION 'The due date is already that late or later' USING ERRCODE = 'QM020'; END IF;
    UPDATE public.supplier_scars SET response_due_on = x.new_due_on, updated_by = auth.uid() WHERE id = c.id;
  END IF;
  UPDATE public.supplier_scar_extensions SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END, decided_at = now(), decided_by = auth.uid(), decision_note = v_note WHERE id = x.id;
END $$;

CREATE FUNCTION app.withdraw_scar_extension(p_extension uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE x public.supplier_scar_extensions%ROWTYPE; c public.supplier_scars%ROWTYPE;
BEGIN
  SELECT * INTO x FROM public.supplier_scar_extensions WHERE id = p_extension FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Extension not found' USING ERRCODE = 'P0002'; END IF;
  c := app.scar_for_write(x.scar_id);
  IF x.status <> 'pending' THEN RAISE EXCEPTION 'Only a request waiting for a decision can be withdrawn' USING ERRCODE = 'QM020'; END IF;
  IF NOT (x.extended_by IS NOT DISTINCT FROM auth.uid() OR app.has_permission(c.organisation_id, 'supplier_quality.approve')) THEN
    RAISE EXCEPTION 'Only the person who asked, or an approver, can withdraw it' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'Give a reason (3 to 1000 characters)' USING ERRCODE = 'QM020'; END IF;
  UPDATE public.supplier_scar_extensions SET status = 'withdrawn', decided_at = now(), decided_by = auth.uid(), decision_note = btrim(p_reason) WHERE id = x.id;
END $$;

-- Cancelling settles a waiting request too.
CREATE OR REPLACE FUNCTION app.cancel_supplier_scar(p_scar uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.supplier_scars%ROWTYPE;
BEGIN
  c := app.scar_for_write(p_scar);
  IF c.status IN ('closed', 'cancelled') THEN RAISE EXCEPTION 'A % SCAR cannot be cancelled', c.status USING ERRCODE = 'QM020'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'Say why the SCAR is being cancelled (3 to 1000 characters)' USING ERRCODE = 'QM020'; END IF;
  PERFORM app.scar_settle_pending_extension(c.id, 'The SCAR was cancelled');
  PERFORM app.scar_set_status(c, 'cancelled', p_reason);
END $$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app.scar_extension_guard(), app.scar_settle_pending_extension(uuid, text) FROM PUBLIC, anon, authenticated;
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'add_scar_item(uuid,jsonb)', 'remove_scar_item(uuid,text)',
    'create_supplier_scar(uuid,text,text,text,date,uuid,uuid[],uuid,text,jsonb)', 'update_supplier_scar(uuid,jsonb)',
    'record_scar_response(uuid,text,text,text,text,date,date,text,uuid,text,text,text,text)',
    'request_scar_extension(uuid,date,text)', 'decide_scar_extension(uuid,boolean,text)', 'withdraw_scar_extension(uuid,text)', 'cancel_supplier_scar(uuid,text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION app.%s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION app.%s TO authenticated', f);
  END LOOP;
END $$;
