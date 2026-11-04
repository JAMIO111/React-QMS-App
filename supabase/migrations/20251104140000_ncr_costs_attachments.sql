-- Phase 2 / slice 2.5 (part, brought forward with the old NC form layout): costs and attachments
-- on non-conformances. Replaces the legacy "Costs" and "NC Files" tables (both empty when this
-- was written, so nothing is copied).
--
-- Costs: amounts are entered in any currency with a VAT treatment; net / VAT / gross and the
-- organisation-base-currency values are worked out here, so every client agrees.
-- Attachments: files live in the private "nc-files" bucket at <org>/ncr/<ncr id>/<name>; this
-- table holds their metadata. Removing a file from an NCR is a soft delete — the stored object is
-- kept as evidence.

-- The site of an NCR, for policies on its child records (SECURITY DEFINER: the policy must not
-- depend on the caller seeing the NCR row through another policy).
CREATE FUNCTION app.ncr_site(p_ncr_id uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT site_id FROM public.nonconformances WHERE id = p_ncr_id
$$;

-- Child records may change only while their NCR is editable (not closed, cancelled or deleted).
CREATE FUNCTION app.assert_ncr_editable(p_ncr_id uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  n record;
BEGIN
  SELECT stage, deleted_at INTO n FROM public.nonconformances WHERE id = p_ncr_id;
  IF n.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'This non-conformance is deleted; restore it first' USING ERRCODE = 'QM005';
  END IF;
  IF n.stage IN ('closed', 'cancelled') THEN
    RAISE EXCEPTION 'This non-conformance is %; reopen it to make changes', n.stage USING ERRCODE = 'QM005';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Costs
-- ---------------------------------------------------------------------------
CREATE TABLE public.ncr_costs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  nonconformance_id uuid NOT NULL,
  cost_type text NOT NULL CHECK (cost_type IN (
    'material', 'labour', 'scrap', 'rework', 'transport', 'inspection', 'sorting', 'customer_charge',
    'supplier_recovery', 'admin', 'tools_equipment', 'consultancy', 'packaging', 'waste_disposal', 'other')),
  description text CHECK (description IS NULL OR length(description) <= 500),
  incurred_on date NOT NULL DEFAULT current_date,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  vat_treatment text NOT NULL DEFAULT 'none' CHECK (vat_treatment IN ('none', 'inclusive', 'exclusive')),
  vat_rate numeric NOT NULL DEFAULT 0 CHECK (vat_rate >= 0 AND vat_rate < 1),
  amount numeric NOT NULL CHECK (amount >= 0 AND amount < 1e12),
  exchange_rate numeric NOT NULL DEFAULT 1 CHECK (exchange_rate > 0),
  -- Worked out by app.ncr_cost_amounts():
  net_amount numeric NOT NULL DEFAULT 0,
  vat_amount numeric NOT NULL DEFAULT 0,
  gross_amount numeric NOT NULL DEFAULT 0,
  base_currency text NOT NULL DEFAULT 'GBP',
  net_base numeric NOT NULL DEFAULT 0,
  gross_base numeric NOT NULL DEFAULT 0,
  deleted_at timestamptz,
  deleted_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  delete_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT ncr_costs_ncr_fkey FOREIGN KEY (nonconformance_id, organisation_id)
    REFERENCES public.nonconformances (id, organisation_id),
  CONSTRAINT ncr_costs_deleted_has_reason CHECK (deleted_at IS NULL OR length(trim(delete_reason)) > 0)
);
CREATE INDEX ncr_costs_ncr_idx ON public.ncr_costs (nonconformance_id);

CREATE FUNCTION app.ncr_cost_amounts() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  rate numeric := CASE WHEN NEW.vat_treatment = 'none' THEN 0 ELSE NEW.vat_rate END;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.nonconformance_id <> OLD.nonconformance_id THEN
    RAISE EXCEPTION 'A cost cannot move to another non-conformance' USING ERRCODE = 'QM005';
  END IF;
  -- User changes need an editable NCR, the right permission and (to delete) a reason.
  IF coalesce(auth.role(), '') = 'authenticated' THEN
    PERFORM app.assert_ncr_editable(NEW.nonconformance_id);
    IF TG_OP = 'UPDATE' AND OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'This cost is deleted' USING ERRCODE = 'QM005';
    END IF;
    IF NEW.deleted_at IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.deleted_at IS NULL) THEN
      IF coalesce(trim(NEW.delete_reason), '') = '' THEN
        RAISE EXCEPTION 'Give a reason for deleting' USING ERRCODE = 'QM005';
      END IF;
      NEW.deleted_at := now();
      NEW.deleted_by := auth.uid();
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.deleted_at IS NULL AND OLD.deleted_at IS NOT NULL THEN
      NEW.deleted_by := NULL;
      NEW.delete_reason := NULL;
    END IF;
  END IF;

  IF NEW.vat_treatment = 'inclusive' THEN
    NEW.gross_amount := round(NEW.amount, 2);
    NEW.net_amount := round(NEW.amount / (1 + rate), 2);
  ELSIF NEW.vat_treatment = 'exclusive' THEN
    NEW.net_amount := round(NEW.amount, 2);
    NEW.gross_amount := round(NEW.amount * (1 + rate), 2);
  ELSE
    NEW.net_amount := round(NEW.amount, 2);
    NEW.gross_amount := round(NEW.amount, 2);
  END IF;
  NEW.vat_amount := NEW.gross_amount - NEW.net_amount;
  IF NEW.vat_treatment = 'none' THEN
    NEW.vat_rate := 0;
  END IF;

  SELECT coalesce(s.base_currency, 'GBP') INTO NEW.base_currency
  FROM public.organisation_settings s WHERE s.organisation_id = NEW.organisation_id;
  NEW.base_currency := coalesce(NEW.base_currency, 'GBP');
  IF NEW.currency = NEW.base_currency THEN
    NEW.exchange_rate := 1;
  END IF;
  NEW.net_base := round(NEW.net_amount * NEW.exchange_rate, 2);
  NEW.gross_base := round(NEW.gross_amount * NEW.exchange_rate, 2);
  RETURN NEW;
END $$;

CREATE TRIGGER ncr_costs_amounts BEFORE INSERT OR UPDATE ON public.ncr_costs
  FOR EACH ROW EXECUTE FUNCTION app.ncr_cost_amounts();

-- ---------------------------------------------------------------------------
-- Attachments
-- ---------------------------------------------------------------------------
CREATE TABLE public.ncr_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  nonconformance_id uuid NOT NULL,
  storage_path text NOT NULL UNIQUE,
  file_name text NOT NULL CHECK (length(trim(file_name)) BETWEEN 1 AND 255),
  content_type text,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 26214400),
  description text CHECK (description IS NULL OR length(description) <= 500),
  deleted_at timestamptz,
  deleted_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  delete_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT ncr_attachments_ncr_fkey FOREIGN KEY (nonconformance_id, organisation_id)
    REFERENCES public.nonconformances (id, organisation_id),
  -- The file must sit in this NCR's folder of the organisation's bucket area.
  CONSTRAINT ncr_attachments_path_in_folder CHECK (
    storage_path LIKE organisation_id::text || '/ncr/' || nonconformance_id::text || '/%'
    AND storage_path NOT LIKE '%..%'),
  CONSTRAINT ncr_attachments_deleted_has_reason CHECK (deleted_at IS NULL OR length(trim(delete_reason)) > 0)
);
CREATE INDEX ncr_attachments_ncr_idx ON public.ncr_attachments (nonconformance_id);

CREATE FUNCTION app.ncr_attachment_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.nonconformance_id <> OLD.nonconformance_id OR NEW.storage_path <> OLD.storage_path) THEN
    RAISE EXCEPTION 'An attachment cannot move' USING ERRCODE = 'QM005';
  END IF;
  IF coalesce(auth.role(), '') <> 'authenticated' THEN
    RETURN NEW;
  END IF;
  PERFORM app.assert_ncr_editable(NEW.nonconformance_id);
  IF TG_OP = 'INSERT' THEN
    NEW.deleted_at := NULL; NEW.deleted_by := NULL; NEW.delete_reason := NULL;
    RETURN NEW;
  END IF;
  IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'This file is removed' USING ERRCODE = 'QM005';
  END IF;
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    IF coalesce(trim(NEW.delete_reason), '') = '' THEN
      RAISE EXCEPTION 'Give a reason for removing the file' USING ERRCODE = 'QM005';
    END IF;
    NEW.deleted_at := now();
    NEW.deleted_by := auth.uid();
  ELSIF NEW.deleted_at IS NULL AND OLD.deleted_at IS NOT NULL THEN
    NEW.deleted_by := NULL;
    NEW.delete_reason := NULL;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER ncr_attachments_rules BEFORE INSERT OR UPDATE ON public.ncr_attachments
  FOR EACH ROW EXECUTE FUNCTION app.ncr_attachment_rules();

-- Bookkeeping and audit.
CREATE TRIGGER ncr_costs_stamp BEFORE INSERT ON public.ncr_costs FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER ncr_attachments_stamp BEFORE INSERT ON public.ncr_attachments FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER ncr_costs_touch BEFORE UPDATE ON public.ncr_costs FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER ncr_attachments_touch BEFORE UPDATE ON public.ncr_attachments FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.ncr_costs
  FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.ncr_attachments
  FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');

-- ---------------------------------------------------------------------------
-- Row level security and privileges (site-aware through the parent NCR)
-- ---------------------------------------------------------------------------
ALTER TABLE public.ncr_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ncr_attachments ENABLE ROW LEVEL SECURITY;

CREATE POLICY ncr_costs_select ON public.ncr_costs FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'ncr.read', app.ncr_site(nonconformance_id)));
CREATE POLICY ncr_costs_insert ON public.ncr_costs FOR INSERT TO authenticated
  WITH CHECK (app.has_permission(organisation_id, 'ncr.update', app.ncr_site(nonconformance_id)));
CREATE POLICY ncr_costs_update ON public.ncr_costs FOR UPDATE TO authenticated
  USING (app.has_permission(organisation_id, 'ncr.update', app.ncr_site(nonconformance_id)))
  WITH CHECK (app.has_permission(organisation_id, 'ncr.update', app.ncr_site(nonconformance_id)));

CREATE POLICY ncr_attachments_select ON public.ncr_attachments FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'ncr.read', app.ncr_site(nonconformance_id)));
CREATE POLICY ncr_attachments_insert ON public.ncr_attachments FOR INSERT TO authenticated
  WITH CHECK (app.has_permission(organisation_id, 'ncr.update', app.ncr_site(nonconformance_id)));
CREATE POLICY ncr_attachments_update ON public.ncr_attachments FOR UPDATE TO authenticated
  USING (app.has_permission(organisation_id, 'ncr.update', app.ncr_site(nonconformance_id)))
  WITH CHECK (app.has_permission(organisation_id, 'ncr.update', app.ncr_site(nonconformance_id)));

REVOKE ALL ON public.ncr_costs, public.ncr_attachments FROM anon, authenticated;
GRANT SELECT, INSERT ON public.ncr_costs, public.ncr_attachments TO authenticated;
GRANT UPDATE (cost_type, description, incurred_on, currency, vat_treatment, vat_rate, amount, exchange_rate,
              deleted_at, delete_reason) ON public.ncr_costs TO authenticated;
GRANT UPDATE (description, deleted_at, delete_reason) ON public.ncr_attachments TO authenticated;

REVOKE ALL ON FUNCTION app.ncr_site(uuid), app.assert_ncr_editable(uuid), app.ncr_cost_amounts(),
  app.ncr_attachment_rules() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ncr_site(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Storage: NCR files at <org>/ncr/<ncr id>/..., readable with ncr.read and added with ncr.update
-- at the NCR's site. Objects are never updated or deleted by users (evidence is kept).
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.ncr_file_allowed(p_object_name text, p_permission text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT split_part(p_object_name, '/', 2) = 'ncr'
     AND EXISTS (
       SELECT 1 FROM public.nonconformances n
       WHERE n.id = app.try_uuid(split_part(p_object_name, '/', 3))
         AND n.organisation_id = app.try_uuid(split_part(p_object_name, '/', 1))
         AND app.has_permission(n.organisation_id, p_permission, n.site_id))
$$;
REVOKE ALL ON FUNCTION app.ncr_file_allowed(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ncr_file_allowed(text, text) TO authenticated;

DROP POLICY IF EXISTS nc_files_select ON storage.objects;
DROP POLICY IF EXISTS nc_files_insert ON storage.objects;
DROP POLICY IF EXISTS nc_files_update ON storage.objects;
DROP POLICY IF EXISTS nc_files_delete ON storage.objects;
CREATE POLICY nc_files_select ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'nc-files' AND app.ncr_file_allowed(name, 'ncr.read'));
CREATE POLICY nc_files_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'nc-files' AND app.ncr_file_allowed(name, 'ncr.update'));
