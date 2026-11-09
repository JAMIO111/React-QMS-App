-- Supplier Quality SQ2a: certifications and documents (docs/supplier-quality-plan.md).
--
--  * supplier_documents: one stored file per row (private `supplier-files` bucket at <org>/supplier/<supplier id>/<uuid>-<name>) with type, title, revision,
--    document date, optional expiry and a verification (who checked it, when, a note). A new version replaces the old one, which stays as "superseded";
--    removing needs a reason and keeps the row. Nothing is deleted.
--  * supplier_certifications: type, number, issuing body, scope, issued and expiry dates, optional evidence document, verification. Renewing makes a new row and
--    supersedes the old one; withdrawing needs a reason. Nothing is deleted.
--  * Both tables have NO table writes: SECURITY DEFINER functions only (`supplier_quality.manage`; a cross-tenant id is P0002 -> 404, a rule is QM020 -> 409).
--    A verified record cannot be edited: replace or renew it. Expiry is worked out when read (the API) and never changes a supplier's approval status.

-- ---------------------------------------------------------------------------
-- Documents
-- ---------------------------------------------------------------------------
CREATE TABLE public.supplier_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  supplier_id uuid NOT NULL,
  doc_type text NOT NULL CHECK (doc_type IN ('certificate', 'quality_manual', 'questionnaire', 'agreement', 'insurance', 'audit_report', 'test_report', 'drawing_agreement', 'other')),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  revision text CHECK (revision IS NULL OR length(btrim(revision)) BETWEEN 1 AND 40),
  document_date date,
  expires_on date,
  notes text CHECK (notes IS NULL OR length(btrim(notes)) BETWEEN 1 AND 2000),
  storage_path text NOT NULL,
  file_name text NOT NULL CHECK (length(btrim(file_name)) BETWEEN 1 AND 255),
  content_type text,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 26214400),
  status text NOT NULL DEFAULT 'current' CHECK (status IN ('current', 'superseded', 'removed')),
  replaces_id uuid,
  verified_at timestamptz,
  verified_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  verification_note text CHECK (verification_note IS NULL OR length(btrim(verification_note)) BETWEEN 1 AND 1000),
  removed_at timestamptz,
  removed_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  removal_reason text CHECK (removal_reason IS NULL OR length(btrim(removal_reason)) BETWEEN 3 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT supplier_documents_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT supplier_documents_supplier_fkey FOREIGN KEY (supplier_id, organisation_id) REFERENCES public.suppliers (id, organisation_id),
  CONSTRAINT supplier_documents_replaces_fkey FOREIGN KEY (replaces_id, organisation_id) REFERENCES public.supplier_documents (id, organisation_id),
  CONSTRAINT supplier_documents_path CHECK (storage_path LIKE organisation_id::text || '/supplier/' || supplier_id::text || '/%' AND storage_path NOT LIKE '%..%'),
  CONSTRAINT supplier_documents_dates CHECK (expires_on IS NULL OR document_date IS NULL OR expires_on >= document_date),
  CONSTRAINT supplier_documents_removed CHECK ((status = 'removed') = (removed_at IS NOT NULL) AND (removed_at IS NULL OR removal_reason IS NOT NULL)),
  CONSTRAINT supplier_documents_verified CHECK ((verified_at IS NULL) = (verified_by IS NULL))
);
CREATE INDEX supplier_documents_supplier_idx ON public.supplier_documents (supplier_id, status);
CREATE INDEX supplier_documents_expiry_idx ON public.supplier_documents (organisation_id, expires_on) WHERE status = 'current' AND expires_on IS NOT NULL;

CREATE TABLE public.supplier_certifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  supplier_id uuid NOT NULL,
  cert_type text NOT NULL CHECK (cert_type IN ('iso_9001', 'iatf_16949', 'as9100', 'iso_13485', 'iso_14001', 'iso_45001', 'nadcap', 'rohs_reach', 'other')),
  title text CHECK (title IS NULL OR length(btrim(title)) BETWEEN 1 AND 200),
  certificate_number text NOT NULL CHECK (length(btrim(certificate_number)) BETWEEN 1 AND 100),
  issuing_body text NOT NULL CHECK (length(btrim(issuing_body)) BETWEEN 1 AND 200),
  scope text CHECK (scope IS NULL OR length(btrim(scope)) BETWEEN 1 AND 2000),
  issued_on date,
  expires_on date,
  document_id uuid,
  notes text CHECK (notes IS NULL OR length(btrim(notes)) BETWEEN 1 AND 2000),
  status text NOT NULL DEFAULT 'current' CHECK (status IN ('current', 'superseded', 'withdrawn')),
  replaces_id uuid,
  verified_at timestamptz,
  verified_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  verification_note text CHECK (verification_note IS NULL OR length(btrim(verification_note)) BETWEEN 1 AND 1000),
  withdrawn_at timestamptz,
  withdrawn_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  withdrawal_reason text CHECK (withdrawal_reason IS NULL OR length(btrim(withdrawal_reason)) BETWEEN 3 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT supplier_certifications_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT supplier_certifications_supplier_fkey FOREIGN KEY (supplier_id, organisation_id) REFERENCES public.suppliers (id, organisation_id),
  CONSTRAINT supplier_certifications_document_fkey FOREIGN KEY (document_id, organisation_id) REFERENCES public.supplier_documents (id, organisation_id),
  CONSTRAINT supplier_certifications_replaces_fkey FOREIGN KEY (replaces_id, organisation_id) REFERENCES public.supplier_certifications (id, organisation_id),
  CONSTRAINT supplier_certifications_dates CHECK (expires_on IS NULL OR issued_on IS NULL OR expires_on >= issued_on),
  CONSTRAINT supplier_certifications_withdrawn CHECK ((status = 'withdrawn') = (withdrawn_at IS NOT NULL) AND (withdrawn_at IS NULL OR withdrawal_reason IS NOT NULL)),
  CONSTRAINT supplier_certifications_verified CHECK ((verified_at IS NULL) = (verified_by IS NULL))
);
CREATE INDEX supplier_certifications_supplier_idx ON public.supplier_certifications (supplier_id, status);
CREATE INDEX supplier_certifications_expiry_idx ON public.supplier_certifications (organisation_id, expires_on) WHERE status = 'current' AND expires_on IS NOT NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['supplier_documents', 'supplier_certifications'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION app.stamp_created()', t || '_stamp', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.touch_updated()', t || '_touch', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change()', t || '_org_immutable', t);
    EXECUTE format('CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION audit.record_change(%L)', t, 'organisation_id');
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format($p$CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (app.has_permission(organisation_id, 'supplier_quality.read'))$p$, t || '_select', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
-- The supplier, locked, after checking the caller may do `p_permission` in its organisation.
CREATE FUNCTION app.supplier_for_write(p_supplier uuid, p_permission text) RETURNS public.suppliers
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.suppliers%ROWTYPE;
BEGIN
  SELECT * INTO s FROM public.suppliers WHERE id = p_supplier FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(s.organisation_id) THEN
    RAISE EXCEPTION 'Supplier not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT app.has_permission(s.organisation_id, p_permission) THEN
    RAISE EXCEPTION 'You are not allowed to change this supplier''s qualification records' USING ERRCODE = '42501';
  END IF;
  RETURN s;
END $$;

-- ---------------------------------------------------------------------------
-- Documents: add, edit (until verified), replace with a new version, verify, remove
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.add_supplier_document(
  p_supplier uuid, p_doc_type text, p_title text, p_revision text, p_document_date date, p_expires_on date, p_notes text,
  p_storage_path text, p_file_name text, p_content_type text, p_size_bytes bigint, p_replaces uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.suppliers%ROWTYPE; old public.supplier_documents%ROWTYPE; v_id uuid;
BEGIN
  s := app.supplier_for_write(p_supplier, 'supplier_quality.manage');
  IF p_replaces IS NOT NULL THEN
    SELECT * INTO old FROM public.supplier_documents WHERE id = p_replaces AND supplier_id = s.id AND organisation_id = s.organisation_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'The document to replace was not found' USING ERRCODE = 'P0002'; END IF;
    IF old.status <> 'current' THEN RAISE EXCEPTION 'Only a current document can be replaced' USING ERRCODE = 'QM020'; END IF;
  END IF;
  IF p_expires_on IS NOT NULL AND p_document_date IS NOT NULL AND p_expires_on < p_document_date THEN
    RAISE EXCEPTION 'The expiry date cannot be before the document date' USING ERRCODE = 'QM020';
  END IF;
  INSERT INTO public.supplier_documents (organisation_id, supplier_id, doc_type, title, revision, document_date, expires_on, notes, storage_path, file_name, content_type, size_bytes, replaces_id)
  VALUES (s.organisation_id, s.id, p_doc_type, btrim(p_title), nullif(btrim(p_revision), ''), p_document_date, p_expires_on, nullif(btrim(p_notes), ''),
          p_storage_path, btrim(p_file_name), p_content_type, p_size_bytes, p_replaces)
  RETURNING id INTO v_id;
  IF p_replaces IS NOT NULL THEN
    UPDATE public.supplier_documents SET status = 'superseded' WHERE id = p_replaces;
  END IF;
  RETURN v_id;
END $$;

-- Descriptive details of a document that nobody has verified yet (a verified one is replaced by a new version).
CREATE FUNCTION app.update_supplier_document(p_id uuid, p_data jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE d public.supplier_documents%ROWTYPE; s public.suppliers%ROWTYPE;
BEGIN
  SELECT * INTO d FROM public.supplier_documents WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(d.organisation_id) THEN RAISE EXCEPTION 'Document not found' USING ERRCODE = 'P0002'; END IF;
  s := app.supplier_for_write(d.supplier_id, 'supplier_quality.manage');
  IF d.status <> 'current' THEN RAISE EXCEPTION 'Only a current document can be edited' USING ERRCODE = 'QM020'; END IF;
  IF d.verified_at IS NOT NULL THEN RAISE EXCEPTION 'A verified document cannot be edited; upload a new version' USING ERRCODE = 'QM020'; END IF;
  IF jsonb_typeof(p_data) <> 'object' THEN RAISE EXCEPTION 'Details must be an object' USING ERRCODE = 'QM020'; END IF;
  UPDATE public.supplier_documents SET
    doc_type = CASE WHEN p_data ? 'docType' THEN p_data ->> 'docType' ELSE doc_type END,
    title = CASE WHEN p_data ? 'title' THEN btrim(p_data ->> 'title') ELSE title END,
    revision = CASE WHEN p_data ? 'revision' THEN nullif(btrim(p_data ->> 'revision'), '') ELSE revision END,
    document_date = CASE WHEN p_data ? 'documentDate' THEN (p_data ->> 'documentDate')::date ELSE document_date END,
    expires_on = CASE WHEN p_data ? 'expiresOn' THEN (p_data ->> 'expiresOn')::date ELSE expires_on END,
    notes = CASE WHEN p_data ? 'notes' THEN nullif(btrim(p_data ->> 'notes'), '') ELSE notes END
  WHERE id = p_id;
END $$;

CREATE FUNCTION app.verify_supplier_document(p_id uuid, p_note text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE d public.supplier_documents%ROWTYPE; s public.suppliers%ROWTYPE;
BEGIN
  SELECT * INTO d FROM public.supplier_documents WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(d.organisation_id) THEN RAISE EXCEPTION 'Document not found' USING ERRCODE = 'P0002'; END IF;
  s := app.supplier_for_write(d.supplier_id, 'supplier_quality.manage');
  IF d.status <> 'current' THEN RAISE EXCEPTION 'Only a current document can be verified' USING ERRCODE = 'QM020'; END IF;
  IF d.verified_at IS NOT NULL THEN RAISE EXCEPTION 'This document is already verified' USING ERRCODE = 'QM020'; END IF;
  UPDATE public.supplier_documents SET verified_at = now(), verified_by = auth.uid(), verification_note = nullif(btrim(p_note), '') WHERE id = p_id;
END $$;

CREATE FUNCTION app.remove_supplier_document(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE d public.supplier_documents%ROWTYPE; s public.suppliers%ROWTYPE;
BEGIN
  SELECT * INTO d FROM public.supplier_documents WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(d.organisation_id) THEN RAISE EXCEPTION 'Document not found' USING ERRCODE = 'P0002'; END IF;
  s := app.supplier_for_write(d.supplier_id, 'supplier_quality.manage');
  IF d.status <> 'current' THEN RAISE EXCEPTION 'Only a current document can be removed' USING ERRCODE = 'QM020'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 3 OR length(btrim(p_reason)) > 1000 THEN
    RAISE EXCEPTION 'Give a reason (3 to 1000 characters)' USING ERRCODE = 'QM020';
  END IF;
  IF EXISTS (SELECT 1 FROM public.supplier_certifications c WHERE c.document_id = p_id AND c.status = 'current') THEN
    RAISE EXCEPTION 'A current certification uses this document as its evidence' USING ERRCODE = 'QM020';
  END IF;
  UPDATE public.supplier_documents SET status = 'removed', removed_at = now(), removed_by = auth.uid(), removal_reason = btrim(p_reason) WHERE id = p_id;
END $$;

-- ---------------------------------------------------------------------------
-- Certifications: add, edit (until verified), renew, verify, withdraw
-- p_data keys: certType, title, certificateNumber, issuingBody, scope, issuedOn, expiresOn, documentId, notes
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.supplier_certification_write(p_supplier public.suppliers, p_data jsonb, p_replaces uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_doc uuid := nullif(p_data ->> 'documentId', '')::uuid; v_issued date := (p_data ->> 'issuedOn')::date; v_expires date := (p_data ->> 'expiresOn')::date; v_id uuid;
BEGIN
  IF jsonb_typeof(p_data) <> 'object' THEN RAISE EXCEPTION 'Details must be an object' USING ERRCODE = 'QM020'; END IF;
  IF v_expires IS NOT NULL AND v_issued IS NOT NULL AND v_expires < v_issued THEN
    RAISE EXCEPTION 'The expiry date cannot be before the issue date' USING ERRCODE = 'QM020';
  END IF;
  IF v_doc IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.supplier_documents d WHERE d.id = v_doc AND d.supplier_id = p_supplier.id AND d.organisation_id = p_supplier.organisation_id AND d.status = 'current') THEN
    RAISE EXCEPTION 'The evidence document must be a current document of this supplier' USING ERRCODE = 'QM020';
  END IF;
  INSERT INTO public.supplier_certifications (organisation_id, supplier_id, cert_type, title, certificate_number, issuing_body, scope, issued_on, expires_on, document_id, notes, replaces_id)
  VALUES (p_supplier.organisation_id, p_supplier.id, p_data ->> 'certType', nullif(btrim(p_data ->> 'title'), ''), btrim(p_data ->> 'certificateNumber'),
          btrim(p_data ->> 'issuingBody'), nullif(btrim(p_data ->> 'scope'), ''), v_issued, v_expires, v_doc, nullif(btrim(p_data ->> 'notes'), ''), p_replaces)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION app.add_supplier_certification(p_supplier uuid, p_data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.suppliers%ROWTYPE;
BEGIN
  s := app.supplier_for_write(p_supplier, 'supplier_quality.manage');
  RETURN app.supplier_certification_write(s, p_data, NULL);
END $$;

CREATE FUNCTION app.renew_supplier_certification(p_id uuid, p_data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.supplier_certifications%ROWTYPE; s public.suppliers%ROWTYPE; v_id uuid;
BEGIN
  SELECT * INTO c FROM public.supplier_certifications WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(c.organisation_id) THEN RAISE EXCEPTION 'Certification not found' USING ERRCODE = 'P0002'; END IF;
  s := app.supplier_for_write(c.supplier_id, 'supplier_quality.manage');
  IF c.status <> 'current' THEN RAISE EXCEPTION 'Only a current certification can be renewed' USING ERRCODE = 'QM020'; END IF;
  v_id := app.supplier_certification_write(s, jsonb_build_object('certType', c.cert_type) || p_data, p_id);
  UPDATE public.supplier_certifications SET status = 'superseded' WHERE id = p_id;
  RETURN v_id;
END $$;

CREATE FUNCTION app.update_supplier_certification(p_id uuid, p_data jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.supplier_certifications%ROWTYPE; s public.suppliers%ROWTYPE; v_doc uuid; v_issued date; v_expires date;
BEGIN
  SELECT * INTO c FROM public.supplier_certifications WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(c.organisation_id) THEN RAISE EXCEPTION 'Certification not found' USING ERRCODE = 'P0002'; END IF;
  s := app.supplier_for_write(c.supplier_id, 'supplier_quality.manage');
  IF c.status <> 'current' THEN RAISE EXCEPTION 'Only a current certification can be edited' USING ERRCODE = 'QM020'; END IF;
  IF c.verified_at IS NOT NULL THEN RAISE EXCEPTION 'A verified certification cannot be edited; renew it' USING ERRCODE = 'QM020'; END IF;
  IF jsonb_typeof(p_data) <> 'object' THEN RAISE EXCEPTION 'Details must be an object' USING ERRCODE = 'QM020'; END IF;
  v_doc := CASE WHEN p_data ? 'documentId' THEN nullif(p_data ->> 'documentId', '')::uuid ELSE c.document_id END;
  v_issued := CASE WHEN p_data ? 'issuedOn' THEN (p_data ->> 'issuedOn')::date ELSE c.issued_on END;
  v_expires := CASE WHEN p_data ? 'expiresOn' THEN (p_data ->> 'expiresOn')::date ELSE c.expires_on END;
  IF v_expires IS NOT NULL AND v_issued IS NOT NULL AND v_expires < v_issued THEN
    RAISE EXCEPTION 'The expiry date cannot be before the issue date' USING ERRCODE = 'QM020';
  END IF;
  IF v_doc IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.supplier_documents d WHERE d.id = v_doc AND d.supplier_id = c.supplier_id AND d.organisation_id = c.organisation_id AND d.status = 'current') THEN
    RAISE EXCEPTION 'The evidence document must be a current document of this supplier' USING ERRCODE = 'QM020';
  END IF;
  UPDATE public.supplier_certifications SET
    cert_type = CASE WHEN p_data ? 'certType' THEN p_data ->> 'certType' ELSE cert_type END,
    title = CASE WHEN p_data ? 'title' THEN nullif(btrim(p_data ->> 'title'), '') ELSE title END,
    certificate_number = CASE WHEN p_data ? 'certificateNumber' THEN btrim(p_data ->> 'certificateNumber') ELSE certificate_number END,
    issuing_body = CASE WHEN p_data ? 'issuingBody' THEN btrim(p_data ->> 'issuingBody') ELSE issuing_body END,
    scope = CASE WHEN p_data ? 'scope' THEN nullif(btrim(p_data ->> 'scope'), '') ELSE scope END,
    issued_on = v_issued, expires_on = v_expires, document_id = v_doc,
    notes = CASE WHEN p_data ? 'notes' THEN nullif(btrim(p_data ->> 'notes'), '') ELSE notes END
  WHERE id = p_id;
END $$;

CREATE FUNCTION app.verify_supplier_certification(p_id uuid, p_note text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.supplier_certifications%ROWTYPE; s public.suppliers%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.supplier_certifications WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(c.organisation_id) THEN RAISE EXCEPTION 'Certification not found' USING ERRCODE = 'P0002'; END IF;
  s := app.supplier_for_write(c.supplier_id, 'supplier_quality.manage');
  IF c.status <> 'current' THEN RAISE EXCEPTION 'Only a current certification can be verified' USING ERRCODE = 'QM020'; END IF;
  IF c.verified_at IS NOT NULL THEN RAISE EXCEPTION 'This certification is already verified' USING ERRCODE = 'QM020'; END IF;
  UPDATE public.supplier_certifications SET verified_at = now(), verified_by = auth.uid(), verification_note = nullif(btrim(p_note), '') WHERE id = p_id;
END $$;

CREATE FUNCTION app.withdraw_supplier_certification(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.supplier_certifications%ROWTYPE; s public.suppliers%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.supplier_certifications WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(c.organisation_id) THEN RAISE EXCEPTION 'Certification not found' USING ERRCODE = 'P0002'; END IF;
  s := app.supplier_for_write(c.supplier_id, 'supplier_quality.manage');
  IF c.status <> 'current' THEN RAISE EXCEPTION 'Only a current certification can be withdrawn' USING ERRCODE = 'QM020'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 3 OR length(btrim(p_reason)) > 1000 THEN
    RAISE EXCEPTION 'Give a reason (3 to 1000 characters)' USING ERRCODE = 'QM020';
  END IF;
  UPDATE public.supplier_certifications SET status = 'withdrawn', withdrawn_at = now(), withdrawn_by = auth.uid(), withdrawal_reason = btrim(p_reason) WHERE id = p_id;
END $$;

-- ---------------------------------------------------------------------------
-- Storage: <org>/supplier/<supplier id>/<uuid>-<name>. Read with supplier_quality.read; upload with supplier_quality.manage into a supplier of the
-- organisation; objects are never updated or deleted by users.
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public) VALUES ('supplier-files', 'supplier-files', false) ON CONFLICT (id) DO NOTHING;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'storage' AND table_name = 'buckets' AND column_name = 'file_size_limit') THEN
    EXECUTE $q$UPDATE storage.buckets SET file_size_limit = 26214400 WHERE id = 'supplier-files'$q$;
  END IF;
END $$;

CREATE FUNCTION app.supplier_file_allowed(p_object_name text, p_upload boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT split_part(p_object_name, '/', 2) = 'supplier'
     AND EXISTS (
       SELECT 1 FROM public.suppliers s
       WHERE s.id = app.try_uuid(split_part(p_object_name, '/', 3))
         AND s.organisation_id = app.try_uuid(split_part(p_object_name, '/', 1))
         AND app.has_permission(s.organisation_id, CASE WHEN p_upload THEN 'supplier_quality.manage' ELSE 'supplier_quality.read' END))
$$;

CREATE POLICY supplier_files_select ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'supplier-files' AND app.supplier_file_allowed(name, false));
CREATE POLICY supplier_files_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'supplier-files' AND app.supplier_file_allowed(name, true));

REVOKE ALL ON FUNCTION app.supplier_for_write(uuid, text), app.supplier_certification_write(public.suppliers, jsonb, uuid), app.supplier_file_allowed(text, boolean),
  app.add_supplier_document(uuid, text, text, text, date, date, text, text, text, text, bigint, uuid), app.update_supplier_document(uuid, jsonb),
  app.verify_supplier_document(uuid, text), app.remove_supplier_document(uuid, text),
  app.add_supplier_certification(uuid, jsonb), app.renew_supplier_certification(uuid, jsonb), app.update_supplier_certification(uuid, jsonb),
  app.verify_supplier_certification(uuid, text), app.withdraw_supplier_certification(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.supplier_file_allowed(text, boolean),
  app.add_supplier_document(uuid, text, text, text, date, date, text, text, text, text, bigint, uuid), app.update_supplier_document(uuid, jsonb),
  app.verify_supplier_document(uuid, text), app.remove_supplier_document(uuid, text),
  app.add_supplier_certification(uuid, jsonb), app.renew_supplier_certification(uuid, jsonb), app.update_supplier_certification(uuid, jsonb),
  app.verify_supplier_certification(uuid, text), app.withdraw_supplier_certification(uuid, text) TO authenticated;
