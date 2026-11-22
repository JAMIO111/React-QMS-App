-- External portal PT5f (docs/external-portal-plan.md §6 "Performance (customer)": inspection and certificate-of-conformance evidence they were shared): staff attach
-- a certificate of conformance, an inspection report or another file to a LOT and share it with one CUSTOMER; that customer sees and downloads only those files.
--
--  * lot_evidence_files: one row per file per customer it is shared with. Functions only, audited, never deleted (a withdrawn file keeps its row with a reason and
--    disappears from the customer at once). Kinds: certificate_of_conformance, inspection_report, other.
--  * Who may share: external_access.share AND production.read at the lot's site; the customer must be one the lot is FOR — the customer of its production
--    order, or one the lot's part is supplied to (part_customers) — and have the portal and party switched on.
--  * Files live in the new private lot-evidence bucket at <org>/lot/<lot id>/<uuid>-<name>. Staff with external_access.share read and upload through the
--    ordinary /files routes (the shared rule below); a customer never touches storage: the API signs a short download link after app.portal_evidence_file_path.
--  * The customer sees the lot number, the part, the kind, a description, the file name, size and date. No order, no site, no staff names, no other customer.

INSERT INTO storage.buckets (id, name, public) VALUES ('lot-evidence', 'lot-evidence', false) ON CONFLICT (id) DO NOTHING;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'storage' AND table_name = 'buckets' AND column_name = 'file_size_limit') THEN
    EXECUTE $q$UPDATE storage.buckets SET file_size_limit = 26214400 WHERE id = 'lot-evidence'$q$;
  END IF;
END $$;

CREATE TABLE public.lot_evidence_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  lot_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('certificate_of_conformance', 'inspection_report', 'other')),
  description text CHECK (description IS NULL OR length(btrim(description)) BETWEEN 1 AND 300),
  storage_path text NOT NULL UNIQUE,
  file_name text NOT NULL CHECK (length(btrim(file_name)) BETWEEN 1 AND 255),
  content_type text,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 26214400),
  removed_at timestamptz,
  removed_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  remove_reason text CHECK (remove_reason IS NULL OR length(btrim(remove_reason)) BETWEEN 3 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT lot_evidence_files_lot_fkey FOREIGN KEY (lot_id, organisation_id) REFERENCES public.lots (id, organisation_id),
  CONSTRAINT lot_evidence_files_customer_fkey FOREIGN KEY (customer_id, organisation_id) REFERENCES public.customers (id, organisation_id),
  CONSTRAINT lot_evidence_files_path CHECK (storage_path LIKE organisation_id::text || '/lot/' || lot_id::text || '/%' AND storage_path NOT LIKE '%..%'),
  CONSTRAINT lot_evidence_files_removed CHECK ((removed_at IS NULL) = (remove_reason IS NULL))
);
CREATE INDEX lot_evidence_files_lot_idx ON public.lot_evidence_files (lot_id);
CREATE INDEX lot_evidence_files_customer_idx ON public.lot_evidence_files (customer_id) WHERE removed_at IS NULL;
CREATE FUNCTION app.lot_evidence_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Evidence is never deleted' USING ERRCODE = 'QM032'; END IF;
  IF OLD.removed_at IS NOT NULL THEN RAISE EXCEPTION 'A removed file does not change' USING ERRCODE = 'QM032'; END IF;
  IF NEW.lot_id IS DISTINCT FROM OLD.lot_id OR NEW.customer_id IS DISTINCT FROM OLD.customer_id OR NEW.storage_path IS DISTINCT FROM OLD.storage_path
     OR NEW.file_name IS DISTINCT FROM OLD.file_name OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes OR NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'A shared file keeps its lot, customer and content' USING ERRCODE = 'QM032';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lot_evidence_files_rules BEFORE UPDATE OR DELETE ON public.lot_evidence_files FOR EACH ROW EXECUTE FUNCTION app.lot_evidence_rules();
CREATE TRIGGER lot_evidence_files_stamp BEFORE INSERT ON public.lot_evidence_files FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER lot_evidence_files_touch BEFORE UPDATE ON public.lot_evidence_files FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER lot_evidence_files_org_immutable BEFORE UPDATE ON public.lot_evidence_files FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.lot_evidence_files FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.lot_evidence_files ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.lot_evidence_files FROM anon, authenticated;
GRANT SELECT ON public.lot_evidence_files TO authenticated;
CREATE POLICY lot_evidence_files_select ON public.lot_evidence_files FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'external_access.share'));
REVOKE ALL ON FUNCTION app.lot_evidence_rules() FROM PUBLIC, anon, authenticated;

-- Storage rule: staff who share read and upload; nobody else (a customer is served by the API's short links).
CREATE FUNCTION app.lot_evidence_file_allowed(p_object_name text, p_write boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT split_part(p_object_name, '/', 2) = 'lot'
     AND EXISTS (SELECT 1 FROM public.lots l
                  WHERE l.id = app.try_uuid(split_part(p_object_name, '/', 3))
                    AND l.organisation_id = app.try_uuid(split_part(p_object_name, '/', 1))
                    AND app.has_permission(l.organisation_id, 'external_access.share')
                    AND app.has_permission(l.organisation_id, 'production.read', l.site_id))
$$;
REVOKE ALL ON FUNCTION app.lot_evidence_file_allowed(text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.lot_evidence_file_allowed(text, boolean) TO authenticated;

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
    WHEN 'lot-evidence'        THEN app.lot_evidence_file_allowed(p_name, p_write)
    WHEN 'scar-files'          THEN app.scar_file_allowed(p_name, p_write)
    WHEN 'supplier-files'      THEN app.supplier_file_allowed(p_name, p_write)
    WHEN 'org-logos'           THEN split_part(p_name, '/', 2) = 'logo' AND CASE WHEN p_write
                                      THEN app.has_permission(app.try_uuid(split_part(p_name, '/', 1)), 'organisation.manage')
                                      ELSE app.is_member(app.try_uuid(split_part(p_name, '/', 1))) END
    ELSE false
  END, false)
$$;

DROP POLICY IF EXISTS lot_evidence_insert ON storage.objects;
DROP POLICY IF EXISTS lot_evidence_select ON storage.objects;
CREATE POLICY lot_evidence_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'lot-evidence' AND app.storage_file_allowed(bucket_id, name, true) AND app.storage_direct_allowed(name));
CREATE POLICY lot_evidence_select ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'lot-evidence' AND app.storage_file_allowed(bucket_id, name, false) AND app.storage_direct_allowed(name));

-- Customers a lot is for (portal on, party on): the customer of its order, or one its part is supplied to.
CREATE FUNCTION app.lot_evidence_customers(p_lot uuid) RETURNS TABLE (customer_id uuid, customer_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE l public.lots;
BEGIN
  SELECT * INTO l FROM public.lots WHERE id = p_lot;
  IF NOT FOUND OR NOT app.has_permission(l.organisation_id, 'external_access.share') OR NOT app.has_permission(l.organisation_id, 'production.read', l.site_id) THEN
    RAISE EXCEPTION 'lot not found' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN QUERY
  SELECT c.id, c.name
    FROM public.customers c
    JOIN public.portal_parties p ON p.customer_id = c.id AND p.organisation_id = c.organisation_id AND p.enabled
    JOIN public.organisation_settings s ON s.organisation_id = c.organisation_id AND s.portal_enabled
   WHERE c.organisation_id = l.organisation_id
     AND (c.id = (SELECT o.customer_id FROM public.production_orders o WHERE o.id = l.production_order_id)
          OR EXISTS (SELECT 1 FROM public.part_customers pc WHERE pc.part_id = l.part_id AND pc.customer_id = c.id AND pc.organisation_id = l.organisation_id))
   ORDER BY c.name;
END $$;
REVOKE ALL ON FUNCTION app.lot_evidence_customers(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.lot_evidence_customers(uuid) TO authenticated;

-- Staff: attach and share one uploaded file with one customer; take it back with a reason; list a lot's files.
CREATE FUNCTION app.add_lot_evidence(p_lot uuid, p_customer uuid, p_kind text, p_description text, p_path text, p_name text, p_type text, p_size bigint) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE l public.lots; v_id uuid;
BEGIN
  SELECT * INTO l FROM public.lots WHERE id = p_lot;
  IF NOT FOUND OR NOT app.has_permission(l.organisation_id, 'external_access.share') OR NOT app.has_permission(l.organisation_id, 'production.read', l.site_id) THEN
    RAISE EXCEPTION 'lot not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.lot_evidence_customers(p_lot) x WHERE x.customer_id = p_customer) THEN
    RAISE EXCEPTION 'That lot is not for that customer, or the customer is not on the portal' USING ERRCODE = 'QM032';
  END IF;
  INSERT INTO public.lot_evidence_files (organisation_id, lot_id, customer_id, kind, description, storage_path, file_name, content_type, size_bytes)
  VALUES (l.organisation_id, p_lot, p_customer, p_kind, nullif(btrim(coalesce(p_description, '')), ''), p_path, btrim(p_name), p_type, p_size) RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION app.add_lot_evidence(uuid, uuid, text, text, text, text, text, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.add_lot_evidence(uuid, uuid, text, text, text, text, text, bigint) TO authenticated;

CREATE FUNCTION app.remove_lot_evidence(p_file uuid, p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE f public.lot_evidence_files; l public.lots;
BEGIN
  SELECT * INTO f FROM public.lot_evidence_files WHERE id = p_file FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'file not found' USING ERRCODE = 'no_data_found'; END IF;
  SELECT * INTO l FROM public.lots WHERE id = f.lot_id;
  IF NOT app.has_permission(f.organisation_id, 'external_access.share') OR NOT app.has_permission(f.organisation_id, 'production.read', l.site_id) THEN RAISE EXCEPTION 'file not found' USING ERRCODE = 'no_data_found'; END IF;
  IF f.removed_at IS NOT NULL THEN RAISE EXCEPTION 'That file is already removed' USING ERRCODE = 'QM032'; END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 3 OR length(btrim(p_reason)) > 500 THEN RAISE EXCEPTION 'Give a reason of 3 to 500 characters' USING ERRCODE = 'QM032'; END IF;
  UPDATE public.lot_evidence_files SET removed_at = now(), removed_by = auth.uid(), remove_reason = btrim(p_reason) WHERE id = p_file;
  RETURN f.lot_id;
END $$;
REVOKE ALL ON FUNCTION app.remove_lot_evidence(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.remove_lot_evidence(uuid, text) TO authenticated;

CREATE FUNCTION app.list_lot_evidence(p_lot uuid)
RETURNS TABLE (file_id uuid, customer_id uuid, customer_name text, kind text, description text, file_name text, size_bytes bigint, storage_path text, added_at timestamptz, added_by text, removed_at timestamptz, remove_reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE l public.lots;
BEGIN
  SELECT * INTO l FROM public.lots WHERE id = p_lot;
  IF NOT FOUND OR NOT app.has_permission(l.organisation_id, 'external_access.share') OR NOT app.has_permission(l.organisation_id, 'production.read', l.site_id) THEN
    RAISE EXCEPTION 'lot not found' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN QUERY
  SELECT f.id, f.customer_id, c.name, f.kind, f.description, f.file_name, f.size_bytes, f.storage_path, f.created_at, app.portal_person_name(f.created_by), f.removed_at, f.remove_reason
    FROM public.lot_evidence_files f JOIN public.customers c ON c.id = f.customer_id AND c.organisation_id = f.organisation_id
   WHERE f.lot_id = p_lot ORDER BY f.removed_at NULLS FIRST, f.created_at DESC;
END $$;
REVOKE ALL ON FUNCTION app.list_lot_evidence(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.list_lot_evidence(uuid) TO authenticated;

-- The customer's side: files shared with their party's customer, and one file's path for a short link. Named fields only.
CREATE FUNCTION app.portal_list_evidence(p_org uuid, p_party uuid)
RETURNS TABLE (file_id uuid, lot_number text, part_number text, part_name text, kind text, description text, file_name text, size_bytes bigint, added_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_customer uuid := app.portal_customer_party(p_org, p_party);
BEGIN
  RETURN QUERY
  SELECT f.id, l.lot_number, p.part_number, p.name, f.kind, f.description, f.file_name, f.size_bytes, f.created_at
    FROM public.lot_evidence_files f
    JOIN public.lots l ON l.id = f.lot_id AND l.organisation_id = f.organisation_id
    JOIN public.parts p ON p.id = l.part_id AND p.organisation_id = l.organisation_id
   WHERE f.organisation_id = p_org AND f.customer_id = v_customer AND f.removed_at IS NULL
   ORDER BY f.created_at DESC LIMIT 200;
END $$;
REVOKE ALL ON FUNCTION app.portal_list_evidence(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_list_evidence(uuid, uuid) TO authenticated;

CREATE FUNCTION app.portal_evidence_file_path(p_file uuid) RETURNS TABLE (storage_path text, file_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE f public.lot_evidence_files;
BEGIN
  SELECT * INTO f FROM public.lot_evidence_files WHERE id = p_file AND removed_at IS NULL;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM app.portal_my_access(f.organisation_id) a WHERE a.customer_id = f.customer_id AND a.party_kind = 'customer') THEN
    RAISE EXCEPTION 'file not found' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN QUERY SELECT f.storage_path, f.file_name;
END $$;
REVOKE ALL ON FUNCTION app.portal_evidence_file_path(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_evidence_file_path(uuid) TO authenticated;
