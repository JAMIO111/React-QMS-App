-- Supplier Quality, slice SQ1 (docs/supplier-quality-plan.md): register and profile.
--
--  * suppliers gains what the register needs: type, address, contact details, purchasing reference, an **approval status** and a risk rating. Approval status is **never implied**:
--    every supplier starts Pending Approval (existing ones too), it is not in the column-level UPDATE grant, and it moves only through app.change_supplier_status, which checks the
--    transition, needs supplier_quality.approve and a reason, and writes supplier_status_history (append-only). It is separate from `active` (operational activity), which is unchanged.
--    risk_rating is a placeholder for the risk assessments of SQ2: nobody can write it yet.
--  * supplier_classifications: per organisation, seeded, switched on/off and renamed under supplier_quality.configure (key fixed, nothing deleted); a supplier has several
--    (supplier_classification_links, replaced as a whole by app.set_supplier_classifications).
--  * supplier_contacts (several per supplier, one primary, deactivated not deleted) and supplier_product_links (supplier ↔ part, or a material / service described in words).
--  * Permissions supplier_quality.read / .manage / .approve / .configure. suppliers can also be created and edited by supplier_quality.manage (as well as master_data.manage).
--  * The supplier_quality module is switched to active. No subscription feature is mapped yet (as for CAPA, audits and production): packaging is a separate decision.
-- Errors QM020 → 409 supplier_rule.

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------
INSERT INTO public.permissions (code, description) VALUES
  ('supplier_quality.read',      'View supplier quality: approval status, classifications, contacts and products'),
  ('supplier_quality.manage',    'Edit suppliers, their classifications, contacts and the products and services they supply'),
  ('supplier_quality.approve',   'Approve, conditionally approve, suspend, disqualify and archive suppliers'),
  ('supplier_quality.configure', 'Configure supplier quality: classifications and (later) assessment, scoring and inspection rules');

WITH grants(key, perms) AS (VALUES
  ('owner',            ARRAY['supplier_quality.read', 'supplier_quality.manage', 'supplier_quality.approve', 'supplier_quality.configure']),
  ('admin',            ARRAY['supplier_quality.read', 'supplier_quality.manage', 'supplier_quality.approve', 'supplier_quality.configure']),
  ('quality_manager',  ARRAY['supplier_quality.read', 'supplier_quality.manage', 'supplier_quality.approve', 'supplier_quality.configure']),
  ('quality_engineer', ARRAY['supplier_quality.read', 'supplier_quality.manage']),
  ('inspector',        ARRAY['supplier_quality.read']),
  ('viewer',           ARRAY['supplier_quality.read'])
)
INSERT INTO public.role_permissions (role_id, permission_code)
SELECT r.id, unnest(g.perms) FROM public.roles r JOIN grants g ON g.key = r.key WHERE r.is_system
ON CONFLICT DO NOTHING;

UPDATE public.modules SET status = 'active' WHERE slug = 'supplier_quality';

-- ---------------------------------------------------------------------------
-- The supplier record
-- ---------------------------------------------------------------------------
ALTER TABLE public.suppliers
  ADD COLUMN supplier_type text CHECK (supplier_type IS NULL OR supplier_type IN
    ('manufacturer', 'distributor', 'subcontractor', 'service_provider', 'calibration_provider', 'logistics_provider', 'other')),
  ADD COLUMN country text CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  ADD COLUMN address_line1 text CHECK (address_line1 IS NULL OR length(btrim(address_line1)) BETWEEN 1 AND 120),
  ADD COLUMN address_line2 text CHECK (address_line2 IS NULL OR length(btrim(address_line2)) BETWEEN 1 AND 120),
  ADD COLUMN city text CHECK (city IS NULL OR length(btrim(city)) BETWEEN 1 AND 80),
  ADD COLUMN region text CHECK (region IS NULL OR length(btrim(region)) BETWEEN 1 AND 80),
  ADD COLUMN postcode text CHECK (postcode IS NULL OR length(btrim(postcode)) BETWEEN 1 AND 20),
  ADD COLUMN website text CHECK (website IS NULL OR length(btrim(website)) BETWEEN 1 AND 200),
  ADD COLUMN email text CHECK (email IS NULL OR length(btrim(email)) BETWEEN 3 AND 200),
  ADD COLUMN phone text CHECK (phone IS NULL OR length(btrim(phone)) BETWEEN 3 AND 40),
  ADD COLUMN purchasing_reference text CHECK (purchasing_reference IS NULL OR length(btrim(purchasing_reference)) BETWEEN 1 AND 60),
  ADD COLUMN approval_status text NOT NULL DEFAULT 'pending_approval'
    CHECK (approval_status IN ('pending_approval', 'approved', 'conditional', 'suspended', 'disqualified', 'archived')),
  ADD COLUMN approval_status_changed_at timestamptz,
  ADD COLUMN approval_status_changed_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  ADD COLUMN risk_rating text CHECK (risk_rating IS NULL OR risk_rating IN ('low', 'medium', 'high', 'critical'));

CREATE INDEX suppliers_org_status_idx ON public.suppliers (organisation_id, approval_status);

-- Whatever a client sends on INSERT, a supplier starts Pending Approval with no risk rating: a record never implies approval. (Operator SQL is not blocked.)
CREATE FUNCTION app.suppliers_new_defaults() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NOT NULL THEN
    NEW.approval_status := 'pending_approval';
    NEW.approval_status_changed_at := NULL;
    NEW.approval_status_changed_by := NULL;
    NEW.risk_rating := NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER suppliers_new_defaults BEFORE INSERT ON public.suppliers FOR EACH ROW EXECUTE FUNCTION app.suppliers_new_defaults();

-- Editing: the old columns plus the new descriptive ones. approval_status, its stamps and risk_rating are not in the grant.
GRANT UPDATE (supplier_type, country, address_line1, address_line2, city, region, postcode, website, email, phone, purchasing_reference)
  ON public.suppliers TO authenticated;

-- Suppliers may be created and edited by master data managers and by supplier quality managers.
DROP POLICY suppliers_insert ON public.suppliers;
DROP POLICY suppliers_update ON public.suppliers;
CREATE POLICY suppliers_insert ON public.suppliers FOR INSERT TO authenticated
  WITH CHECK (app.has_permission(organisation_id, 'master_data.manage') OR app.has_permission(organisation_id, 'supplier_quality.manage'));
CREATE POLICY suppliers_update ON public.suppliers FOR UPDATE TO authenticated
  USING (app.has_permission(organisation_id, 'master_data.manage') OR app.has_permission(organisation_id, 'supplier_quality.manage'))
  WITH CHECK (app.has_permission(organisation_id, 'master_data.manage') OR app.has_permission(organisation_id, 'supplier_quality.manage'));

-- ---------------------------------------------------------------------------
-- Approval status history (append-only) and the one function that changes the status
-- ---------------------------------------------------------------------------
CREATE TABLE public.supplier_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  supplier_id uuid NOT NULL,
  from_status text CHECK (from_status IS NULL OR from_status IN ('pending_approval', 'approved', 'conditional', 'suspended', 'disqualified', 'archived')),
  to_status text NOT NULL CHECK (to_status IN ('pending_approval', 'approved', 'conditional', 'suspended', 'disqualified', 'archived')),
  reason text CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 3 AND 1000),
  conditions text CHECK (conditions IS NULL OR length(btrim(conditions)) BETWEEN 1 AND 2000),
  review_on date,
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT supplier_status_history_supplier_fkey FOREIGN KEY (supplier_id, organisation_id) REFERENCES public.suppliers (id, organisation_id),
  CONSTRAINT supplier_status_history_reason CHECK (from_status IS NULL OR reason IS NOT NULL),
  CONSTRAINT supplier_status_history_conditions CHECK (to_status <> 'conditional' OR conditions IS NOT NULL)
);
CREATE INDEX supplier_status_history_supplier_idx ON public.supplier_status_history (supplier_id, changed_at DESC);
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.supplier_status_history FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.supplier_status_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.supplier_status_history FROM anon, authenticated;
GRANT SELECT ON public.supplier_status_history TO authenticated;
CREATE POLICY supplier_status_history_select ON public.supplier_status_history FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'supplier_quality.read'));

-- The first row of every supplier: recorded as Pending Approval.
CREATE FUNCTION app.suppliers_first_status() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.supplier_status_history (organisation_id, supplier_id, from_status, to_status, reason, changed_at, changed_by)
  VALUES (NEW.organisation_id, NEW.id, NULL, NEW.approval_status, NULL, now(), auth.uid());
  RETURN NEW;
END $$;
CREATE TRIGGER suppliers_first_status AFTER INSERT ON public.suppliers FOR EACH ROW EXECUTE FUNCTION app.suppliers_first_status();

-- Suppliers that exist now: one row saying so (their status is Pending Approval; nothing is assumed).
INSERT INTO public.supplier_status_history (organisation_id, supplier_id, from_status, to_status, reason, changed_at, changed_by)
SELECT s.organisation_id, s.id, NULL, s.approval_status, NULL, now(), NULL FROM public.suppliers s;

-- Allowed moves. Archived suppliers can only be restored to Pending Approval; a disqualified one can be re-opened the same way or archived.
CREATE FUNCTION app.supplier_status_allowed(p_from text, p_to text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE p_from
    WHEN 'pending_approval' THEN p_to IN ('approved', 'conditional', 'disqualified', 'archived')
    WHEN 'approved'         THEN p_to IN ('conditional', 'suspended', 'disqualified', 'archived')
    WHEN 'conditional'      THEN p_to IN ('approved', 'suspended', 'disqualified', 'archived')
    WHEN 'suspended'        THEN p_to IN ('approved', 'conditional', 'disqualified', 'archived')
    WHEN 'disqualified'     THEN p_to IN ('pending_approval', 'archived')
    WHEN 'archived'         THEN p_to IN ('pending_approval')
    ELSE false END
$$;

CREATE FUNCTION app.change_supplier_status(
  p_supplier uuid, p_status text, p_reason text, p_conditions text DEFAULT NULL, p_review_on date DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  s public.suppliers%ROWTYPE;
  v_id uuid;
BEGIN
  SELECT * INTO s FROM public.suppliers WHERE id = p_supplier FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(s.organisation_id) THEN
    RAISE EXCEPTION 'Supplier not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT app.has_permission(s.organisation_id, 'supplier_quality.approve') THEN
    RAISE EXCEPTION 'You are not allowed to change a supplier''s approval status' USING ERRCODE = '42501';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('pending_approval', 'approved', 'conditional', 'suspended', 'disqualified', 'archived') THEN
    RAISE EXCEPTION 'Unknown approval status' USING ERRCODE = 'QM020';
  END IF;
  IF p_status = s.approval_status THEN
    RAISE EXCEPTION 'The supplier is already %', replace(p_status, '_', ' ') USING ERRCODE = 'QM020';
  END IF;
  IF NOT app.supplier_status_allowed(s.approval_status, p_status) THEN
    RAISE EXCEPTION 'A supplier that is % cannot be moved to %', replace(s.approval_status, '_', ' '), replace(p_status, '_', ' ') USING ERRCODE = 'QM020';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 3 OR length(btrim(p_reason)) > 1000 THEN
    RAISE EXCEPTION 'Give a reason (3 to 1000 characters)' USING ERRCODE = 'QM020';
  END IF;
  IF p_status = 'conditional' AND (p_conditions IS NULL OR length(btrim(p_conditions)) < 1) THEN
    RAISE EXCEPTION 'State the conditions or restrictions of a conditional approval' USING ERRCODE = 'QM020';
  END IF;
  IF p_review_on IS NOT NULL AND p_review_on < current_date THEN
    RAISE EXCEPTION 'The review date cannot be in the past' USING ERRCODE = 'QM020';
  END IF;

  UPDATE public.suppliers SET approval_status = p_status, approval_status_changed_at = now(), approval_status_changed_by = auth.uid() WHERE id = s.id;
  INSERT INTO public.supplier_status_history (organisation_id, supplier_id, from_status, to_status, reason, conditions, review_on, changed_at, changed_by)
  VALUES (s.organisation_id, s.id, s.approval_status, p_status, btrim(p_reason),
          CASE WHEN p_status = 'conditional' THEN btrim(p_conditions) ELSE NULL END, p_review_on, now(), auth.uid())
  RETURNING id INTO v_id;
  PERFORM app.emit_event(s.organisation_id, 'supplier.approval_status_changed', 'supplier', s.id,
    jsonb_build_object('from', s.approval_status, 'to', p_status, 'code', s.code));
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------
-- Classifications (organisation-configurable, multi-select on a supplier)
-- ---------------------------------------------------------------------------
CREATE TABLE public.supplier_classifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 60),
  description text CHECK (description IS NULL OR length(btrim(description)) BETWEEN 1 AND 300),
  sequence integer NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT supplier_classifications_key UNIQUE (organisation_id, key),
  CONSTRAINT supplier_classifications_id_org_key UNIQUE (id, organisation_id)
);
CREATE UNIQUE INDEX supplier_classifications_label_key ON public.supplier_classifications (organisation_id, lower(btrim(label)));
CREATE TRIGGER supplier_classifications_stamp BEFORE INSERT ON public.supplier_classifications FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER supplier_classifications_touch BEFORE UPDATE ON public.supplier_classifications FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER supplier_classifications_org_immutable BEFORE UPDATE ON public.supplier_classifications FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.supplier_classifications FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.supplier_classifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.supplier_classifications FROM anon, authenticated;
GRANT SELECT, INSERT ON public.supplier_classifications TO authenticated;
GRANT UPDATE (label, description, sequence, active) ON public.supplier_classifications TO authenticated;
CREATE POLICY supplier_classifications_select ON public.supplier_classifications FOR SELECT TO authenticated USING (app.has_permission(organisation_id, 'supplier_quality.read'));
CREATE POLICY supplier_classifications_insert ON public.supplier_classifications FOR INSERT TO authenticated WITH CHECK (app.has_permission(organisation_id, 'supplier_quality.configure'));
CREATE POLICY supplier_classifications_update ON public.supplier_classifications FOR UPDATE TO authenticated
  USING (app.has_permission(organisation_id, 'supplier_quality.configure')) WITH CHECK (app.has_permission(organisation_id, 'supplier_quality.configure'));

CREATE FUNCTION app.seed_supplier_classifications(p_organisation_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO public.supplier_classifications (organisation_id, key, label, sequence) VALUES
    (p_organisation_id, 'raw_material',             'Raw material',              1),
    (p_organisation_id, 'component_manufacturer',   'Component manufacturer',    2),
    (p_organisation_id, 'machining_subcontractor',  'Machining subcontractor',   3),
    (p_organisation_id, 'heat_treatment',           'Heat treatment',            4),
    (p_organisation_id, 'welding',                  'Welding',                   5),
    (p_organisation_id, 'surface_treatment',        'Surface treatment',         6),
    (p_organisation_id, 'distributor',              'Distributor',               7),
    (p_organisation_id, 'calibration_provider',     'Calibration provider',      8),
    (p_organisation_id, 'transport_packaging',      'Transport and packaging',   9)
  ON CONFLICT (organisation_id, key) DO NOTHING
$$;
CREATE FUNCTION app.seed_supplier_classifications_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.seed_supplier_classifications(NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER organisations_seed_supplier_classifications AFTER INSERT ON public.organisations FOR EACH ROW EXECUTE FUNCTION app.seed_supplier_classifications_trg();
SELECT app.seed_supplier_classifications(o.id) FROM public.organisations o;

CREATE TABLE public.supplier_classification_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  supplier_id uuid NOT NULL,
  classification_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT supplier_classification_links_supplier_fkey FOREIGN KEY (supplier_id, organisation_id) REFERENCES public.suppliers (id, organisation_id),
  CONSTRAINT supplier_classification_links_class_fkey FOREIGN KEY (classification_id, organisation_id) REFERENCES public.supplier_classifications (id, organisation_id),
  CONSTRAINT supplier_classification_links_key UNIQUE (supplier_id, classification_id)
);
CREATE INDEX supplier_classification_links_class_idx ON public.supplier_classification_links (classification_id);
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.supplier_classification_links FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.supplier_classification_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.supplier_classification_links FROM anon, authenticated;
GRANT SELECT ON public.supplier_classification_links TO authenticated;
CREATE POLICY supplier_classification_links_select ON public.supplier_classification_links FOR SELECT TO authenticated USING (app.has_permission(organisation_id, 'supplier_quality.read'));

-- Replaces a supplier's classifications as a whole. Classifications switched off cannot be added (those already held stay until removed).
CREATE FUNCTION app.set_supplier_classifications(p_supplier uuid, p_classifications uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  s public.suppliers%ROWTYPE;
  v_ids uuid[] := coalesce(p_classifications, ARRAY[]::uuid[]);
  v_bad integer;
BEGIN
  SELECT * INTO s FROM public.suppliers WHERE id = p_supplier FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(s.organisation_id) THEN
    RAISE EXCEPTION 'Supplier not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT app.has_permission(s.organisation_id, 'supplier_quality.manage') THEN
    RAISE EXCEPTION 'You are not allowed to change supplier classifications' USING ERRCODE = '42501';
  END IF;
  SELECT count(*) INTO v_bad FROM unnest(v_ids) AS x(id)
   WHERE NOT EXISTS (SELECT 1 FROM public.supplier_classifications c WHERE c.id = x.id AND c.organisation_id = s.organisation_id
                       AND (c.active OR EXISTS (SELECT 1 FROM public.supplier_classification_links l WHERE l.supplier_id = s.id AND l.classification_id = c.id)));
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'A classification is unknown or switched off' USING ERRCODE = 'QM020';
  END IF;
  DELETE FROM public.supplier_classification_links WHERE supplier_id = s.id AND NOT (classification_id = ANY (v_ids));
  INSERT INTO public.supplier_classification_links (organisation_id, supplier_id, classification_id)
  SELECT s.organisation_id, s.id, d.x FROM (SELECT DISTINCT unnest(v_ids) AS x) d
  ON CONFLICT (supplier_id, classification_id) DO NOTHING;
END $$;

-- ---------------------------------------------------------------------------
-- Contacts
-- ---------------------------------------------------------------------------
CREATE TABLE public.supplier_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  supplier_id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  job_title text CHECK (job_title IS NULL OR length(btrim(job_title)) BETWEEN 1 AND 120),
  role text NOT NULL DEFAULT 'other' CHECK (role IN ('quality', 'purchasing', 'sales', 'technical', 'accounts', 'logistics', 'management', 'other')),
  email text CHECK (email IS NULL OR length(btrim(email)) BETWEEN 3 AND 200),
  phone text CHECK (phone IS NULL OR length(btrim(phone)) BETWEEN 3 AND 40),
  is_primary boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  notes text CHECK (notes IS NULL OR length(btrim(notes)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT supplier_contacts_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT supplier_contacts_supplier_fkey FOREIGN KEY (supplier_id, organisation_id) REFERENCES public.suppliers (id, organisation_id),
  CONSTRAINT supplier_contacts_primary_active CHECK (NOT is_primary OR active)
);
CREATE INDEX supplier_contacts_supplier_idx ON public.supplier_contacts (supplier_id);
CREATE UNIQUE INDEX supplier_contacts_one_primary ON public.supplier_contacts (supplier_id) WHERE is_primary;

-- Making a contact primary (or inactive) keeps the rule of one primary per supplier.
CREATE FUNCTION app.supplier_contacts_primary() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.is_primary AND NOT NEW.active THEN NEW.is_primary := false; END IF;
  IF NEW.is_primary THEN
    UPDATE public.supplier_contacts SET is_primary = false WHERE supplier_id = NEW.supplier_id AND id <> NEW.id AND is_primary;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER supplier_contacts_primary BEFORE INSERT OR UPDATE ON public.supplier_contacts FOR EACH ROW EXECUTE FUNCTION app.supplier_contacts_primary();
CREATE TRIGGER supplier_contacts_stamp BEFORE INSERT ON public.supplier_contacts FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER supplier_contacts_touch BEFORE UPDATE ON public.supplier_contacts FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER supplier_contacts_org_immutable BEFORE UPDATE ON public.supplier_contacts FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.supplier_contacts FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.supplier_contacts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.supplier_contacts FROM anon, authenticated;
GRANT SELECT, INSERT ON public.supplier_contacts TO authenticated;
GRANT UPDATE (name, job_title, role, email, phone, is_primary, active, notes) ON public.supplier_contacts TO authenticated;
CREATE POLICY supplier_contacts_select ON public.supplier_contacts FOR SELECT TO authenticated USING (app.has_permission(organisation_id, 'supplier_quality.read'));
CREATE POLICY supplier_contacts_insert ON public.supplier_contacts FOR INSERT TO authenticated WITH CHECK (app.has_permission(organisation_id, 'supplier_quality.manage'));
CREATE POLICY supplier_contacts_update ON public.supplier_contacts FOR UPDATE TO authenticated
  USING (app.has_permission(organisation_id, 'supplier_quality.manage')) WITH CHECK (app.has_permission(organisation_id, 'supplier_quality.manage'));

-- ---------------------------------------------------------------------------
-- Products and services a supplier supplies: a part of ours, or a material / service described in words (until there is a materials model).
-- ---------------------------------------------------------------------------
CREATE TABLE public.supplier_product_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  supplier_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('part', 'material', 'service')),
  part_id uuid,
  description text CHECK (description IS NULL OR length(btrim(description)) BETWEEN 1 AND 200),
  supplier_part_number text CHECK (supplier_part_number IS NULL OR length(btrim(supplier_part_number)) BETWEEN 1 AND 60),
  notes text CHECK (notes IS NULL OR length(btrim(notes)) BETWEEN 1 AND 1000),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT supplier_product_links_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT supplier_product_links_supplier_fkey FOREIGN KEY (supplier_id, organisation_id) REFERENCES public.suppliers (id, organisation_id),
  CONSTRAINT supplier_product_links_part_fkey FOREIGN KEY (part_id, organisation_id) REFERENCES public.parts (id, organisation_id),
  CONSTRAINT supplier_product_links_shape CHECK ((kind = 'part' AND part_id IS NOT NULL) OR (kind <> 'part' AND part_id IS NULL AND description IS NOT NULL))
);
CREATE UNIQUE INDEX supplier_product_links_part_key ON public.supplier_product_links (supplier_id, part_id) WHERE part_id IS NOT NULL;
CREATE INDEX supplier_product_links_supplier_idx ON public.supplier_product_links (supplier_id);
CREATE INDEX supplier_product_links_part_idx ON public.supplier_product_links (part_id) WHERE part_id IS NOT NULL;
CREATE TRIGGER supplier_product_links_stamp BEFORE INSERT ON public.supplier_product_links FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER supplier_product_links_touch BEFORE UPDATE ON public.supplier_product_links FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER supplier_product_links_org_immutable BEFORE UPDATE ON public.supplier_product_links FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.supplier_product_links FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.supplier_product_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.supplier_product_links FROM anon, authenticated;
GRANT SELECT, INSERT ON public.supplier_product_links TO authenticated;
-- What is supplied (the part or the words) is fixed once linked: end the link and add another. Notes, the supplier's own number and the active flag can change.
GRANT UPDATE (supplier_part_number, notes, active) ON public.supplier_product_links TO authenticated;
CREATE POLICY supplier_product_links_select ON public.supplier_product_links FOR SELECT TO authenticated USING (app.has_permission(organisation_id, 'supplier_quality.read'));
CREATE POLICY supplier_product_links_insert ON public.supplier_product_links FOR INSERT TO authenticated WITH CHECK (app.has_permission(organisation_id, 'supplier_quality.manage'));
CREATE POLICY supplier_product_links_update ON public.supplier_product_links FOR UPDATE TO authenticated
  USING (app.has_permission(organisation_id, 'supplier_quality.manage')) WITH CHECK (app.has_permission(organisation_id, 'supplier_quality.manage'));

-- ---------------------------------------------------------------------------
-- Function privileges: nobody (anon included) runs the helpers; signed-in users run the two commands, which check rights themselves.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app.suppliers_new_defaults(), app.suppliers_first_status(), app.supplier_status_allowed(text, text),
  app.seed_supplier_classifications(uuid), app.seed_supplier_classifications_trg(), app.supplier_contacts_primary() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.change_supplier_status(uuid, text, text, text, date), app.set_supplier_classifications(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.change_supplier_status(uuid, text, text, text, date), app.set_supplier_classifications(uuid, uuid[]) TO authenticated;
