-- Supplier Quality SQ4c: material certificates (docs/supplier-quality-plan.md).
--
-- A material certificate (mill test report, certificate of conformance or analysis, test report) a supplier sends with material: it names the supplier, what it
-- covers (a part of ours or a material in words), and how it is traced - the receipt line it arrived on, the lot that became, and/or the heat number.
-- The certificate file itself is a supplier document (supplier_documents, private `supplier-files` bucket); the certificate links to it.
--
--  * Recorded by anyone who can record receipts (`receiving.manage`); REVIEWED (accepted / rejected, a note on a rejection) by `supplier_quality.manage`.
--    A reviewed certificate is frozen; a wrong one is withdrawn (reason) and a new one recorded. Nothing is deleted.
--  * No table writes at all: SECURITY DEFINER functions only. Errors QM020 -> 409 supplier_rule, a cross-tenant id P0002 -> 404.
--  * A receipt line, a lot and a part must agree with each other and with the supplier; the lot of a receipt line is filled in when it is not named.
--  * The state of a receipt line's certificates is information only (app.receipt_line_certificates): it does not block a disposition. A requirement that a
--    certificate must exist before accepting is a later decision.

CREATE TABLE public.supplier_material_certificates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  supplier_id uuid NOT NULL,
  certificate_number text NOT NULL CHECK (length(btrim(certificate_number)) BETWEEN 1 AND 100),
  kind text NOT NULL CHECK (kind IN ('mill_test_report', 'certificate_of_conformance', 'certificate_of_analysis', 'test_report', 'other')),
  part_id uuid,
  material text CHECK (material IS NULL OR length(btrim(material)) BETWEEN 1 AND 200),
  specification text CHECK (specification IS NULL OR length(btrim(specification)) BETWEEN 1 AND 200),
  heat_number text CHECK (heat_number IS NULL OR length(btrim(heat_number)) BETWEEN 1 AND 100),
  receipt_line_id uuid,
  lot_id uuid,
  issued_on date,
  document_id uuid,
  notes text CHECK (notes IS NULL OR length(btrim(notes)) BETWEEN 1 AND 2000),
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'accepted', 'rejected', 'withdrawn')),
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  review_note text CHECK (review_note IS NULL OR length(btrim(review_note)) BETWEEN 1 AND 1000),
  withdrawn_at timestamptz,
  withdrawn_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  withdrawal_reason text CHECK (withdrawal_reason IS NULL OR length(btrim(withdrawal_reason)) BETWEEN 3 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT supplier_material_certificates_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT smc_supplier_fkey FOREIGN KEY (supplier_id, organisation_id) REFERENCES public.suppliers (id, organisation_id),
  CONSTRAINT smc_part_fkey FOREIGN KEY (part_id, organisation_id) REFERENCES public.parts (id, organisation_id),
  CONSTRAINT smc_line_fkey FOREIGN KEY (receipt_line_id, organisation_id) REFERENCES public.goods_receipt_lines (id, organisation_id),
  CONSTRAINT smc_lot_fkey FOREIGN KEY (lot_id, organisation_id) REFERENCES public.lots (id, organisation_id),
  CONSTRAINT smc_document_fkey FOREIGN KEY (document_id, organisation_id) REFERENCES public.supplier_documents (id, organisation_id),
  CONSTRAINT smc_covers CHECK (part_id IS NOT NULL OR material IS NOT NULL),
  CONSTRAINT smc_traced CHECK (receipt_line_id IS NOT NULL OR lot_id IS NOT NULL OR heat_number IS NOT NULL),
  CONSTRAINT smc_review_shape CHECK (status = 'withdrawn' OR ((status IN ('accepted', 'rejected')) = (reviewed_at IS NOT NULL))),
  CONSTRAINT smc_reject_note CHECK (status <> 'rejected' OR length(btrim(coalesce(review_note, ''))) >= 3),
  CONSTRAINT smc_withdrawn CHECK ((status = 'withdrawn') = (withdrawn_at IS NOT NULL) AND (withdrawn_at IS NULL OR withdrawal_reason IS NOT NULL)),
  CONSTRAINT smc_reviewed CHECK ((reviewed_at IS NULL) = (reviewed_by IS NULL))
);
-- The same certificate (number + heat) is not recorded twice for a supplier while it still stands.
CREATE UNIQUE INDEX smc_live_unique ON public.supplier_material_certificates (organisation_id, supplier_id, lower(btrim(certificate_number)), lower(coalesce(btrim(heat_number), '')))
  WHERE status IN ('received', 'accepted');
CREATE INDEX smc_supplier_idx ON public.supplier_material_certificates (supplier_id, status);
CREATE INDEX smc_line_idx ON public.supplier_material_certificates (receipt_line_id) WHERE receipt_line_id IS NOT NULL;
CREATE INDEX smc_lot_idx ON public.supplier_material_certificates (lot_id) WHERE lot_id IS NOT NULL;

CREATE TRIGGER smc_stamp BEFORE INSERT ON public.supplier_material_certificates FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER smc_touch BEFORE UPDATE ON public.supplier_material_certificates FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER smc_org_immutable BEFORE UPDATE ON public.supplier_material_certificates FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.supplier_material_certificates FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.supplier_material_certificates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.supplier_material_certificates FROM anon, authenticated;
GRANT SELECT ON public.supplier_material_certificates TO authenticated;
CREATE POLICY supplier_material_certificates_select ON public.supplier_material_certificates FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'receiving.read'));

-- A reviewed certificate is frozen: only withdrawing it (status -> withdrawn) may change it, and then nothing else but the withdrawal fields.
CREATE FUNCTION app.smc_frozen() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF OLD.status IN ('accepted', 'rejected') AND NOT (NEW.status = 'withdrawn' AND (to_jsonb(NEW) - ARRAY['status', 'withdrawn_at', 'withdrawn_by', 'withdrawal_reason', 'updated_at', 'updated_by']) = (to_jsonb(OLD) - ARRAY['status', 'withdrawn_at', 'withdrawn_by', 'withdrawal_reason', 'updated_at', 'updated_by'])) THEN
    RAISE EXCEPTION 'A reviewed certificate cannot be changed; withdraw it and record a new one' USING ERRCODE = 'QM020';
  END IF;
  IF OLD.status = 'withdrawn' THEN RAISE EXCEPTION 'A withdrawn certificate cannot be changed' USING ERRCODE = 'QM020'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER smc_frozen BEFORE UPDATE ON public.supplier_material_certificates FOR EACH ROW EXECUTE FUNCTION app.smc_frozen();

-- ---------------------------------------------------------------------------
-- Validation shared by record and edit. Returns the resolved row values as jsonb.
-- p_data keys: certificateNumber, kind, partId, material, specification, heatNumber, receiptLineId, lotId, issuedOn, documentId, notes
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.smc_resolve(p_supplier public.suppliers, p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_line uuid := nullif(p_data ->> 'receiptLineId', '')::uuid; v_lot uuid := nullif(p_data ->> 'lotId', '')::uuid; v_part uuid := nullif(p_data ->> 'partId', '')::uuid;
  v_mat text := nullif(btrim(p_data ->> 'material'), ''); v_doc uuid := nullif(p_data ->> 'documentId', '')::uuid;
  l public.goods_receipt_lines%ROWTYPE; g public.goods_receipts%ROWTYPE; lt public.lots%ROWTYPE;
BEGIN
  IF jsonb_typeof(p_data) <> 'object' THEN RAISE EXCEPTION 'Details must be an object' USING ERRCODE = 'QM020'; END IF;
  IF v_line IS NOT NULL THEN
    SELECT * INTO l FROM public.goods_receipt_lines WHERE id = v_line AND organisation_id = p_supplier.organisation_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Receipt line not found' USING ERRCODE = 'P0002'; END IF;
    SELECT * INTO g FROM public.goods_receipts WHERE id = l.goods_receipt_id;
    IF g.supplier_id <> p_supplier.id THEN RAISE EXCEPTION 'That receipt line is from another supplier' USING ERRCODE = 'QM020'; END IF;
    IF g.status = 'cancelled' THEN RAISE EXCEPTION 'That receipt is cancelled' USING ERRCODE = 'QM020'; END IF;
    v_lot := coalesce(v_lot, l.lot_id);
    v_part := coalesce(v_part, l.part_id);
    IF v_part IS NULL THEN v_mat := coalesce(v_mat, l.material); END IF;
    IF l.part_id IS NOT NULL AND v_part IS DISTINCT FROM l.part_id THEN RAISE EXCEPTION 'The part does not match the receipt line' USING ERRCODE = 'QM020'; END IF;
    IF l.lot_id IS NOT NULL AND v_lot IS DISTINCT FROM l.lot_id THEN RAISE EXCEPTION 'The lot does not match the receipt line' USING ERRCODE = 'QM020'; END IF;
  END IF;
  IF v_lot IS NOT NULL THEN
    SELECT * INTO lt FROM public.lots WHERE id = v_lot AND organisation_id = p_supplier.organisation_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Lot not found' USING ERRCODE = 'P0002'; END IF;
    IF lt.origin <> 'received' OR lt.supplier_id IS DISTINCT FROM p_supplier.id THEN RAISE EXCEPTION 'That lot was not received from this supplier' USING ERRCODE = 'QM020'; END IF;
    IF v_part IS NOT NULL AND v_part <> lt.part_id THEN RAISE EXCEPTION 'The part does not match the lot' USING ERRCODE = 'QM020'; END IF;
    v_part := coalesce(v_part, lt.part_id);
  END IF;
  IF v_part IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.parts WHERE id = v_part AND organisation_id = p_supplier.organisation_id) THEN
    RAISE EXCEPTION 'Part not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_part IS NULL AND v_mat IS NULL THEN RAISE EXCEPTION 'Say what the certificate covers: a part or a material' USING ERRCODE = 'QM020'; END IF;
  IF v_line IS NULL AND v_lot IS NULL AND nullif(btrim(p_data ->> 'heatNumber'), '') IS NULL THEN
    RAISE EXCEPTION 'A certificate must be traceable: name the receipt line, the lot or the heat number' USING ERRCODE = 'QM020';
  END IF;
  IF v_doc IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.supplier_documents d WHERE d.id = v_doc AND d.supplier_id = p_supplier.id AND d.organisation_id = p_supplier.organisation_id AND d.status = 'current') THEN
    RAISE EXCEPTION 'The file must be a current document of this supplier' USING ERRCODE = 'QM020';
  END IF;
  RETURN jsonb_build_object('partId', v_part, 'material', v_mat, 'lotId', v_lot, 'receiptLineId', v_line, 'documentId', v_doc);
END $$;

CREATE FUNCTION app.record_material_certificate(p_supplier uuid, p_data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.suppliers%ROWTYPE; r jsonb; v_id uuid;
BEGIN
  SELECT * INTO s FROM public.suppliers WHERE id = p_supplier FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(s.organisation_id) THEN RAISE EXCEPTION 'Supplier not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(s.organisation_id, 'receiving.manage') THEN RAISE EXCEPTION 'You are not allowed to record material certificates' USING ERRCODE = '42501'; END IF;
  r := app.smc_resolve(s, p_data);
  IF EXISTS (SELECT 1 FROM public.supplier_material_certificates c WHERE c.supplier_id = s.id AND c.status IN ('received', 'accepted')
             AND lower(btrim(c.certificate_number)) = lower(btrim(p_data ->> 'certificateNumber')) AND lower(coalesce(btrim(c.heat_number), '')) = lower(coalesce(btrim(p_data ->> 'heatNumber'), ''))) THEN
    RAISE EXCEPTION 'This certificate (number and heat) is already recorded for the supplier' USING ERRCODE = 'QM020';
  END IF;
  INSERT INTO public.supplier_material_certificates (organisation_id, supplier_id, certificate_number, kind, part_id, material, specification, heat_number, receipt_line_id, lot_id, issued_on, document_id, notes)
  VALUES (s.organisation_id, s.id, btrim(p_data ->> 'certificateNumber'), p_data ->> 'kind', (r ->> 'partId')::uuid, r ->> 'material', nullif(btrim(p_data ->> 'specification'), ''),
          nullif(btrim(p_data ->> 'heatNumber'), ''), (r ->> 'receiptLineId')::uuid, (r ->> 'lotId')::uuid, (p_data ->> 'issuedOn')::date, (r ->> 'documentId')::uuid, nullif(btrim(p_data ->> 'notes'), ''))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Edit a certificate nobody has reviewed yet. Keys present are set; null clears the optional ones.
CREATE FUNCTION app.update_material_certificate(p_id uuid, p_data jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.supplier_material_certificates%ROWTYPE; s public.suppliers%ROWTYPE; merged jsonb; r jsonb;
BEGIN
  SELECT * INTO c FROM public.supplier_material_certificates WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(c.organisation_id) THEN RAISE EXCEPTION 'Certificate not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(c.organisation_id, 'receiving.manage') THEN RAISE EXCEPTION 'You are not allowed to change material certificates' USING ERRCODE = '42501'; END IF;
  IF c.status <> 'received' THEN RAISE EXCEPTION 'Only a certificate that has not been reviewed can be edited' USING ERRCODE = 'QM020'; END IF;
  SELECT * INTO s FROM public.suppliers WHERE id = c.supplier_id;
  merged := jsonb_build_object('certificateNumber', c.certificate_number, 'kind', c.kind, 'partId', c.part_id, 'material', c.material, 'specification', c.specification, 'heatNumber', c.heat_number,
    'receiptLineId', c.receipt_line_id, 'lotId', c.lot_id, 'issuedOn', c.issued_on, 'documentId', c.document_id, 'notes', c.notes) || p_data;
  r := app.smc_resolve(s, merged);
  IF EXISTS (SELECT 1 FROM public.supplier_material_certificates x WHERE x.supplier_id = c.supplier_id AND x.id <> c.id AND x.status IN ('received', 'accepted')
             AND lower(btrim(x.certificate_number)) = lower(btrim(merged ->> 'certificateNumber')) AND lower(coalesce(btrim(x.heat_number), '')) = lower(coalesce(btrim(merged ->> 'heatNumber'), ''))) THEN
    RAISE EXCEPTION 'This certificate (number and heat) is already recorded for the supplier' USING ERRCODE = 'QM020';
  END IF;
  UPDATE public.supplier_material_certificates SET
    certificate_number = btrim(merged ->> 'certificateNumber'), kind = merged ->> 'kind', part_id = (r ->> 'partId')::uuid, material = r ->> 'material',
    specification = nullif(btrim(merged ->> 'specification'), ''), heat_number = nullif(btrim(merged ->> 'heatNumber'), ''), receipt_line_id = (r ->> 'receiptLineId')::uuid,
    lot_id = (r ->> 'lotId')::uuid, issued_on = (merged ->> 'issuedOn')::date, document_id = (r ->> 'documentId')::uuid, notes = nullif(btrim(merged ->> 'notes'), '')
  WHERE id = p_id;
END $$;

-- Accept or reject a certificate (once). Needs supplier_quality.manage; a rejection needs a note.
CREATE FUNCTION app.review_material_certificate(p_id uuid, p_accept boolean, p_note text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.supplier_material_certificates%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.supplier_material_certificates WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(c.organisation_id) THEN RAISE EXCEPTION 'Certificate not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(c.organisation_id, 'supplier_quality.manage') THEN RAISE EXCEPTION 'You are not allowed to review material certificates' USING ERRCODE = '42501'; END IF;
  IF c.status <> 'received' THEN RAISE EXCEPTION 'This certificate has already been reviewed or withdrawn' USING ERRCODE = 'QM020'; END IF;
  IF NOT p_accept AND (p_note IS NULL OR length(btrim(p_note)) < 3 OR length(btrim(p_note)) > 1000) THEN
    RAISE EXCEPTION 'Say why the certificate is rejected (3 to 1000 characters)' USING ERRCODE = 'QM020';
  END IF;
  IF p_note IS NOT NULL AND length(btrim(p_note)) > 1000 THEN RAISE EXCEPTION 'The note is too long' USING ERRCODE = 'QM020'; END IF;
  UPDATE public.supplier_material_certificates SET status = CASE WHEN p_accept THEN 'accepted' ELSE 'rejected' END, reviewed_at = now(), reviewed_by = auth.uid(), review_note = nullif(btrim(p_note), '')
  WHERE id = p_id;
END $$;

CREATE FUNCTION app.withdraw_material_certificate(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.supplier_material_certificates%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.supplier_material_certificates WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(c.organisation_id) THEN RAISE EXCEPTION 'Certificate not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(c.organisation_id, 'receiving.manage') THEN RAISE EXCEPTION 'You are not allowed to withdraw material certificates' USING ERRCODE = '42501'; END IF;
  IF c.status = 'withdrawn' THEN RAISE EXCEPTION 'This certificate is already withdrawn' USING ERRCODE = 'QM020'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 3 OR length(btrim(p_reason)) > 1000 THEN RAISE EXCEPTION 'Give a reason (3 to 1000 characters)' USING ERRCODE = 'QM020'; END IF;
  UPDATE public.supplier_material_certificates SET status = 'withdrawn', withdrawn_at = now(), withdrawn_by = auth.uid(), withdrawal_reason = btrim(p_reason) WHERE id = p_id;
END $$;

-- What a receipt line has on file (information only): counts of live certificates by status; withdrawn ones are not counted.
CREATE FUNCTION app.receipt_line_certificates(p_line uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'received', count(*) FILTER (WHERE c.status = 'received'), 'accepted', count(*) FILTER (WHERE c.status = 'accepted'), 'rejected', count(*) FILTER (WHERE c.status = 'rejected'))
  FROM public.supplier_material_certificates c
  WHERE c.status <> 'withdrawn' AND (c.receipt_line_id = p_line OR (c.lot_id IS NOT NULL AND c.lot_id = (SELECT lot_id FROM public.goods_receipt_lines WHERE id = p_line)))
$$;

REVOKE ALL ON FUNCTION app.smc_frozen(), app.smc_resolve(public.suppliers, jsonb), app.record_material_certificate(uuid, jsonb), app.update_material_certificate(uuid, jsonb),
  app.review_material_certificate(uuid, boolean, text), app.withdraw_material_certificate(uuid, text), app.receipt_line_certificates(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.record_material_certificate(uuid, jsonb), app.update_material_certificate(uuid, jsonb), app.review_material_certificate(uuid, boolean, text),
  app.withdraw_material_certificate(uuid, text), app.receipt_line_certificates(uuid) TO authenticated;
