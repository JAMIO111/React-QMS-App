-- Change management (ECR / ECN), slice CH1 (docs/change-management-plan.md): the module, its permissions and package rows, the lists it is set up with,
-- the change record itself (draft or cancelled in this slice), its scope links, its files and where it came from.
--
--  * Module change_management. Permissions change.read (view), change.approve (sign for a function: operational, so Contributor and up) and change.manage
--    (everything else: full, Controller). Owner, admin, quality manager and quality engineer hold all three by role, inspector and viewer read.
--  * Lists, seeded per organisation and switched on and off by change.manage (key fixed, nothing deleted): change_types (with "needs customer approval"),
--    change_functions (who signs: used from CH2), change_areas (the fixed list of impact areas, used from CH2; only active can be changed).
--  * change_requests: ECR-YY-NNNN per organisation and year. Stage draft -> assessment -> approval -> approved -> implementing -> verifying -> closed, or
--    rejected / cancelled (the later stages come with CH2 and CH3; here a change is a draft or cancelled). The title, what, why, urgency and type change only while
--    it is a draft. Where it came from (origin_kind + origin_id: an NC, an 8D, an audit finding, a risk, a document change request) is set at creation and never
--    changes; who raised it (raised_by) never changes. Written only by functions (change.manage).
--  * change_links: what the change covers (parts, part families, machines, suppliers, customers, production orders, operation codes), replaced as a whole.
--  * change_attachments: files on a change (private change-files bucket at <org>/change/<change id>/<uuid>-<name>), written by functions, removed with a reason,
--    never deleted.
-- Errors QM035 (409 change_rule); another organisation's id is P0002 (404).

-- ---------------------------------------------------------------------------
-- 1. Module, permissions, packages
-- ---------------------------------------------------------------------------
INSERT INTO public.modules (slug, name, status, navigation_group, display_order) VALUES
  ('change_management', 'Change management', 'active', 'Quality', 17)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.permissions (code, description) VALUES
  ('change.read',    'View changes: requests, their scope, assessment, sign-offs, tasks and files'),
  ('change.approve', 'Sign off a change for a function you are named to sign for'),
  ('change.manage',  'Raise and manage changes: assess, set scope, choose the board, set tasks, close, and set up the lists');

WITH grants(key, perms) AS (VALUES
  ('owner',            ARRAY['change.read', 'change.approve', 'change.manage']),
  ('admin',            ARRAY['change.read', 'change.approve', 'change.manage']),
  ('quality_manager',  ARRAY['change.read', 'change.approve', 'change.manage']),
  ('quality_engineer', ARRAY['change.read', 'change.approve', 'change.manage']),
  ('inspector',        ARRAY['change.read']),
  ('viewer',           ARRAY['change.read'])
)
INSERT INTO public.role_permissions (role_id, permission_code)
SELECT r.id, unnest(g.perms) FROM public.roles r JOIN grants g ON g.key = r.key WHERE r.is_system
ON CONFLICT DO NOTHING;

-- Every permission is tied to a package (supabase/tests/every_feature_priced.test.sql): view reads, operational signs, full does everything.
INSERT INTO public.features (module_id, slug, name, min_access_level, permission_code)
SELECT m.id, f.slug, f.name, f.level, f.perm
  FROM (VALUES
    ('view_changes',   'View changes',                     'view',        'change.read'),
    ('sign_changes',   'Sign off changes for a function',  'operational', 'change.approve'),
    ('manage_changes', 'Raise and manage changes',         'full',        'change.manage')
  ) AS f(slug, name, level, perm)
  JOIN public.modules m ON m.slug = 'change_management';

INSERT INTO public.subscription_entitlements (subscription_plan_id, module_id, access_level)
SELECT p.id, m.id, CASE WHEN p.slug = 'controller' THEN 'full' WHEN p.slug = 'observer' THEN 'view' ELSE 'operational' END
  FROM public.subscription_plans p CROSS JOIN public.modules m
 WHERE m.slug = 'change_management'
   AND NOT EXISTS (SELECT 1 FROM public.subscription_entitlements e WHERE e.subscription_plan_id = p.id AND e.module_id = m.id AND e.feature_id IS NULL);

-- ---------------------------------------------------------------------------
-- 2. The lists (types, functions, impact areas), seeded per organisation
-- ---------------------------------------------------------------------------
CREATE TABLE public.change_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 60),
  description text CHECK (description IS NULL OR length(btrim(description)) BETWEEN 1 AND 300),
  needs_customer_approval boolean NOT NULL DEFAULT false,
  sequence integer NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT change_types_key UNIQUE (organisation_id, key),
  CONSTRAINT change_types_id_org_key UNIQUE (id, organisation_id)
);
CREATE UNIQUE INDEX change_types_label_key ON public.change_types (organisation_id, lower(btrim(label)));

CREATE TABLE public.change_functions (
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
  CONSTRAINT change_functions_key UNIQUE (organisation_id, key),
  CONSTRAINT change_functions_id_org_key UNIQUE (id, organisation_id)
);
CREATE UNIQUE INDEX change_functions_label_key ON public.change_functions (organisation_id, lower(btrim(label)));

-- The impact areas are a fixed list (the organisation can switch one off, not add one).
CREATE TABLE public.change_areas (
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
  CONSTRAINT change_areas_key UNIQUE (organisation_id, key),
  CONSTRAINT change_areas_id_org_key UNIQUE (id, organisation_id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['change_types', 'change_functions', 'change_areas'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION app.stamp_created()', t || '_stamp', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.touch_updated()', t || '_touch', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change()', t || '_org_immutable', t);
    EXECUTE format('CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION audit.record_change(''organisation_id'')', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (app.has_permission(organisation_id, ''change.read''))', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (app.has_permission(organisation_id, ''change.manage'')) WITH CHECK (app.has_permission(organisation_id, ''change.manage''))', t || '_update', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT ON public.change_types, public.change_functions TO authenticated;
GRANT SELECT ON public.change_areas TO authenticated;
GRANT UPDATE (label, description, needs_customer_approval, sequence, active) ON public.change_types TO authenticated;
GRANT UPDATE (label, description, sequence, active) ON public.change_functions TO authenticated;
GRANT UPDATE (active) ON public.change_areas TO authenticated;
CREATE POLICY change_types_insert ON public.change_types FOR INSERT TO authenticated WITH CHECK (app.has_permission(organisation_id, 'change.manage'));
CREATE POLICY change_functions_insert ON public.change_functions FOR INSERT TO authenticated WITH CHECK (app.has_permission(organisation_id, 'change.manage'));

CREATE FUNCTION app.seed_change_lists(p_organisation_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO public.change_types (organisation_id, key, label, description, needs_customer_approval, sequence) VALUES
    (p_organisation_id, 'product_design',  'Product design',          'A change to the product, its drawing or its specification',           true,  1),
    (p_organisation_id, 'process',         'Process',                 'A change to how the product is made',                                  true,  2),
    (p_organisation_id, 'tooling',         'Tooling or equipment',    'New, changed or moved tooling, fixtures or machines',                  false, 3),
    (p_organisation_id, 'material',        'Material or supplier',    'A change of material, source or supplier process',                    true,  4),
    (p_organisation_id, 'measurement',     'Measurement or inspection', 'A change to how the product is measured, inspected or accepted',   false, 5),
    (p_organisation_id, 'documentation',   'Documentation or QMS',    'A change to a procedure, work instruction, form or the quality system', false, 6),
    (p_organisation_id, 'other',           'Software or other',       'Anything else that needs agreeing before it is done',                  false, 7)
  ON CONFLICT (organisation_id, key) DO NOTHING;
  INSERT INTO public.change_functions (organisation_id, key, label, description, sequence) VALUES
    (p_organisation_id, 'quality',     'Quality',               'Quality assurance and the quality system',          1),
    (p_organisation_id, 'engineering', 'Engineering',           'Design, process and manufacturing engineering',     2),
    (p_organisation_id, 'production',  'Production',            'The shop floor and its planning',                   3),
    (p_organisation_id, 'purchasing',  'Purchasing',            'Buying and supplier management',                    4),
    (p_organisation_id, 'sales',       'Sales and customers',   'The customer relationship and contracts',           5)
  ON CONFLICT (organisation_id, key) DO NOTHING;
  INSERT INTO public.change_areas (organisation_id, key, label, description, sequence) VALUES
    (p_organisation_id, 'design',        'Design and drawing',           'The drawing, specification or part revision',                    1),
    (p_organisation_id, 'process',       'Process and control plan',     'The process, its control plan and reaction plans',               2),
    (p_organisation_id, 'inspection',    'Inspection requirements',      'What is inspected, how often, and the acceptance rules',         3),
    (p_organisation_id, 'tooling',       'Tooling and equipment',        'Tooling, fixtures, machines and their maintenance',              4),
    (p_organisation_id, 'gauges',        'Gauges and measurement',       'Gauges, calibration and measurement system studies',             5),
    (p_organisation_id, 'documents',     'Documents',                    'Procedures, work instructions and forms',                        6),
    (p_organisation_id, 'training',      'Training',                     'What people need to be trained or re-assessed in',               7),
    (p_organisation_id, 'supplier',      'Supplier and purchasing',      'Suppliers, purchase orders and incoming inspection',             8),
    (p_organisation_id, 'customer',      'Customer',                     'Notification, approval or agreement with the customer',          9),
    (p_organisation_id, 'risk',          'Risk assessment',              'Risks and opportunities the change creates or changes',         10),
    (p_organisation_id, 'packaging',     'Packaging and labelling',      'Packaging, labels and shipping',                                11),
    (p_organisation_id, 'stock',         'Stock and cost',               'Existing stock, work in progress and cost',                     12)
  ON CONFLICT (organisation_id, key) DO NOTHING
$$;

CREATE FUNCTION app.seed_change_lists_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.seed_change_lists(NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER organisations_seed_change_lists AFTER INSERT ON public.organisations FOR EACH ROW EXECUTE FUNCTION app.seed_change_lists_trg();
SELECT app.seed_change_lists(o.id) FROM public.organisations o;

-- ---------------------------------------------------------------------------
-- 3. The change itself
-- ---------------------------------------------------------------------------
CREATE TABLE app.change_counters (
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  year smallint NOT NULL,
  last_value integer NOT NULL DEFAULT 0,
  PRIMARY KEY (organisation_id, year)
);
REVOKE ALL ON app.change_counters FROM PUBLIC, anon, authenticated;

CREATE TABLE public.change_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  reference text NOT NULL CHECK (reference ~ '^ECR-[0-9]{2}-[0-9]{4,}$'),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  description text CHECK (description IS NULL OR length(btrim(description)) BETWEEN 1 AND 4000),
  reason text CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 4000),
  type_id uuid NOT NULL,
  urgency text NOT NULL DEFAULT 'normal' CHECK (urgency IN ('normal', 'expedited')),
  stage text NOT NULL DEFAULT 'draft' CHECK (stage IN ('draft', 'assessment', 'approval', 'approved', 'implementing', 'verifying', 'closed', 'rejected', 'cancelled')),
  origin_kind text CHECK (origin_kind IS NULL OR origin_kind IN ('ncr', 'capa', 'audit_finding', 'risk', 'document_change_request')),
  origin_id uuid,
  raised_by uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users (id),
  cancel_reason text CHECK (cancel_reason IS NULL OR length(btrim(cancel_reason)) BETWEEN 3 AND 500),
  cancelled_at timestamptz,
  cancelled_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT change_requests_reference_key UNIQUE (organisation_id, reference),
  CONSTRAINT change_requests_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT change_requests_type_fkey FOREIGN KEY (type_id, organisation_id) REFERENCES public.change_types (id, organisation_id),
  CONSTRAINT change_requests_origin_state CHECK ((origin_kind IS NULL) = (origin_id IS NULL)),
  CONSTRAINT change_requests_cancel_state CHECK ((stage = 'cancelled') = (cancel_reason IS NOT NULL AND cancelled_at IS NOT NULL))
);
CREATE INDEX change_requests_stage_idx ON public.change_requests (organisation_id, stage);
CREATE INDEX change_requests_raised_idx ON public.change_requests (organisation_id, raised_by);
CREATE INDEX change_requests_origin_idx ON public.change_requests (origin_kind, origin_id) WHERE origin_id IS NOT NULL;

CREATE TABLE public.change_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  change_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('part', 'part_family', 'machine', 'supplier', 'customer', 'production_order', 'operation_code')),
  part_id uuid,
  part_family_id uuid,
  machine_id uuid,
  supplier_id uuid,
  customer_id uuid,
  production_order_id uuid,
  operation_code text CHECK (operation_code IS NULL OR (length(btrim(operation_code)) BETWEEN 1 AND 40 AND operation_code = btrim(operation_code))),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT change_links_change_fkey FOREIGN KEY (change_id, organisation_id) REFERENCES public.change_requests (id, organisation_id),
  CONSTRAINT change_links_part_fkey FOREIGN KEY (part_id, organisation_id) REFERENCES public.parts (id, organisation_id),
  CONSTRAINT change_links_family_fkey FOREIGN KEY (part_family_id, organisation_id) REFERENCES public.part_families (id, organisation_id),
  CONSTRAINT change_links_machine_fkey FOREIGN KEY (machine_id, organisation_id) REFERENCES public.machines (id, organisation_id),
  CONSTRAINT change_links_supplier_fkey FOREIGN KEY (supplier_id, organisation_id) REFERENCES public.suppliers (id, organisation_id),
  CONSTRAINT change_links_customer_fkey FOREIGN KEY (customer_id, organisation_id) REFERENCES public.customers (id, organisation_id),
  CONSTRAINT change_links_order_fkey FOREIGN KEY (production_order_id, organisation_id) REFERENCES public.production_orders (id, organisation_id),
  CONSTRAINT change_links_target_check CHECK (
    num_nonnulls(part_id, part_family_id, machine_id, supplier_id, customer_id, production_order_id, operation_code) = 1
    AND CASE kind
      WHEN 'part' THEN part_id IS NOT NULL WHEN 'part_family' THEN part_family_id IS NOT NULL WHEN 'machine' THEN machine_id IS NOT NULL
      WHEN 'supplier' THEN supplier_id IS NOT NULL WHEN 'customer' THEN customer_id IS NOT NULL WHEN 'production_order' THEN production_order_id IS NOT NULL
      ELSE operation_code IS NOT NULL END)
);
CREATE UNIQUE INDEX change_links_target_key ON public.change_links (change_id, kind,
  coalesce(part_id, part_family_id, machine_id, supplier_id, customer_id, production_order_id, '00000000-0000-0000-0000-000000000000'::uuid),
  upper(coalesce(operation_code, '')));
CREATE INDEX change_links_change_idx ON public.change_links (organisation_id, change_id);
CREATE INDEX change_links_part_idx ON public.change_links (part_id) WHERE part_id IS NOT NULL;
CREATE INDEX change_links_family_idx ON public.change_links (part_family_id) WHERE part_family_id IS NOT NULL;
CREATE INDEX change_links_machine_idx ON public.change_links (machine_id) WHERE machine_id IS NOT NULL;
CREATE INDEX change_links_supplier_idx ON public.change_links (supplier_id) WHERE supplier_id IS NOT NULL;
CREATE INDEX change_links_customer_idx ON public.change_links (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX change_links_order_idx ON public.change_links (production_order_id) WHERE production_order_id IS NOT NULL;

CREATE TABLE public.change_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  change_id uuid NOT NULL,
  storage_path text NOT NULL,
  file_name text NOT NULL CHECK (length(btrim(file_name)) BETWEEN 1 AND 255),
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
  CONSTRAINT change_attachments_change_fkey FOREIGN KEY (change_id, organisation_id) REFERENCES public.change_requests (id, organisation_id),
  CONSTRAINT change_attachments_key UNIQUE (change_id, storage_path),
  CONSTRAINT change_attachments_path CHECK (storage_path LIKE organisation_id::text || '/change/%/%' AND storage_path NOT LIKE '%..%')
);
CREATE INDEX change_attachments_change_idx ON public.change_attachments (change_id);

-- Rules the table holds even for SQL: a change is never deleted, its reference, raiser and origin never change, a cancelled change is final, and what it says
-- (title, what, why, urgency, type) changes only while it is a draft.
CREATE FUNCTION app.change_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A change is never deleted. Cancel it with a reason.' USING ERRCODE = 'QM035'; END IF;
  IF NEW.reference IS DISTINCT FROM OLD.reference THEN RAISE EXCEPTION 'A change''s reference never changes' USING ERRCODE = 'QM035'; END IF;
  IF NEW.raised_by IS DISTINCT FROM OLD.raised_by THEN RAISE EXCEPTION 'Who raised a change never changes' USING ERRCODE = 'QM035'; END IF;
  IF (NEW.origin_kind, NEW.origin_id) IS DISTINCT FROM (OLD.origin_kind, OLD.origin_id) THEN
    RAISE EXCEPTION 'The record a change was raised from never changes' USING ERRCODE = 'QM035';
  END IF;
  IF OLD.stage = 'cancelled' AND (to_jsonb(NEW) - 'updated_at' - 'updated_by') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at' - 'updated_by') THEN
    RAISE EXCEPTION '% is cancelled and cannot be changed', OLD.reference USING ERRCODE = 'QM035';
  END IF;
  IF OLD.stage <> 'draft' AND (NEW.title, NEW.description, NEW.reason, NEW.urgency, NEW.type_id) IS DISTINCT FROM (OLD.title, OLD.description, OLD.reason, OLD.urgency, OLD.type_id) THEN
    RAISE EXCEPTION 'Once a change has left draft its title, what, why, urgency and type no longer change' USING ERRCODE = 'QM035';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER change_requests_rules BEFORE UPDATE OR DELETE ON public.change_requests FOR EACH ROW EXECUTE FUNCTION app.change_rules();

-- Links follow their change: only while it is a draft.
CREATE FUNCTION app.change_link_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_stage text;
BEGIN
  SELECT stage INTO v_stage FROM public.change_requests WHERE id = coalesce(NEW.change_id, OLD.change_id);
  IF v_stage IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'What a change covers can be changed only while it is a draft' USING ERRCODE = 'QM035'; END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER change_links_rules BEFORE INSERT OR UPDATE OR DELETE ON public.change_links FOR EACH ROW EXECUTE FUNCTION app.change_link_rules();

-- A file is a record: only the removal marks change, and nothing is deleted.
CREATE FUNCTION app.change_attachment_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A file on a change is never deleted. Remove it with a reason.' USING ERRCODE = 'QM035'; END IF;
  IF (to_jsonb(NEW) - 'deleted_at' - 'deleted_by' - 'delete_reason' - 'updated_at' - 'updated_by')
     IS DISTINCT FROM (to_jsonb(OLD) - 'deleted_at' - 'deleted_by' - 'delete_reason' - 'updated_at' - 'updated_by') THEN
    RAISE EXCEPTION 'A file on a change cannot be changed' USING ERRCODE = 'QM035';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER change_attachments_rules BEFORE UPDATE OR DELETE ON public.change_attachments FOR EACH ROW EXECUTE FUNCTION app.change_attachment_rules();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['change_requests', 'change_links', 'change_attachments'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION app.stamp_created()', t || '_stamp', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.touch_updated()', t || '_touch', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change()', t || '_org_immutable', t);
    EXECUTE format('CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION audit.record_change(''organisation_id'')', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (app.has_permission(organisation_id, ''change.read''))', t || '_select', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Files: the bucket and who may read and write in it
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public) VALUES ('change-files', 'change-files', false) ON CONFLICT (id) DO NOTHING;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'storage' AND table_name = 'buckets' AND column_name = 'file_size_limit') THEN
    EXECUTE $q$UPDATE storage.buckets SET file_size_limit = 26214400 WHERE id = 'change-files'$q$;
  END IF;
END $$;

-- <org>/change/<change id>/...: anyone who may read changes reads; change.manage uploads while the change is not closed, rejected or cancelled.
CREATE FUNCTION app.change_file_allowed(p_object_name text, p_upload boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT split_part(p_object_name, '/', 2) = 'change'
     AND EXISTS (
       SELECT 1 FROM public.change_requests c
        WHERE c.id = app.try_uuid(split_part(p_object_name, '/', 3))
          AND c.organisation_id = app.try_uuid(split_part(p_object_name, '/', 1))
          AND CASE WHEN p_upload
                   THEN c.stage NOT IN ('closed', 'rejected', 'cancelled') AND app.has_permission(c.organisation_id, 'change.manage')
                   ELSE app.has_permission(c.organisation_id, 'change.read') END)
$$;

CREATE OR REPLACE FUNCTION app.storage_file_allowed(p_bucket text, p_name text, p_write boolean) RETURNS boolean
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT coalesce(CASE p_bucket
    WHEN 'audit-files'         THEN app.audit_file_allowed(p_name, p_write)
    WHEN 'calibration-files'   THEN app.calibration_file_allowed(p_name, CASE WHEN p_write THEN 'calibration.record' ELSE 'calibration.read' END)
    WHEN 'capa-files'          THEN app.capa_file_allowed(p_name, p_write)
    WHEN 'change-files'        THEN app.change_file_allowed(p_name, p_write)
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

DROP POLICY IF EXISTS change_files_insert ON storage.objects;
DROP POLICY IF EXISTS change_files_select ON storage.objects;
CREATE POLICY change_files_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'change-files' AND app.storage_file_allowed(bucket_id, name, true) AND app.storage_direct_allowed(name));
CREATE POLICY change_files_select ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'change-files' AND app.storage_file_allowed(bucket_id, name, false) AND app.storage_direct_allowed(name));

-- ---------------------------------------------------------------------------
-- 5. Functions (SECURITY DEFINER): the only way to write a change
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.assert_change_manager(p_organisation_id uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT app.is_member(p_organisation_id) THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(p_organisation_id, 'change.manage') THEN RAISE EXCEPTION 'You are not allowed to manage changes' USING ERRCODE = '42501'; END IF;
END $$;

-- Locks a change for writing and checks the caller may manage changes in its organisation.
CREATE FUNCTION app.change_for_write(p_change uuid) RETURNS public.change_requests
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.change_requests%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.change_requests WHERE id = p_change FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(c.organisation_id) THEN RAISE EXCEPTION 'Change not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_change_manager(c.organisation_id);
  RETURN c;
END $$;

-- Whether the caller may read the record a change could be raised from (and that it is in that organisation): its organisation, else NULL.
CREATE FUNCTION app.change_source_org(p_kind text, p_id uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid; v_site uuid;
BEGIN
  IF p_kind = 'ncr' THEN
    SELECT organisation_id, site_id INTO v_org, v_site FROM public.nonconformances WHERE id = p_id AND deleted_at IS NULL;
    RETURN CASE WHEN v_org IS NOT NULL AND app.has_permission(v_org, 'ncr.read', v_site) THEN v_org END;
  ELSIF p_kind = 'capa' THEN
    SELECT organisation_id INTO v_org FROM public.capas WHERE id = p_id;
    RETURN CASE WHEN v_org IS NOT NULL AND app.has_permission(v_org, 'capa.read') THEN v_org END;
  ELSIF p_kind = 'audit_finding' THEN
    SELECT organisation_id INTO v_org FROM public.audit_findings WHERE id = p_id;
    RETURN CASE WHEN v_org IS NOT NULL AND app.has_permission(v_org, 'audits.read') THEN v_org END;
  ELSIF p_kind = 'risk' THEN
    SELECT organisation_id INTO v_org FROM public.risks WHERE id = p_id;
    RETURN CASE WHEN v_org IS NOT NULL AND app.has_permission(v_org, 'risk.read') THEN v_org END;
  ELSIF p_kind = 'document_change_request' THEN
    SELECT organisation_id INTO v_org FROM public.document_change_requests WHERE id = p_id;
    RETURN CASE WHEN v_org IS NOT NULL AND app.has_permission(v_org, 'documentation.manage') THEN v_org END;
  END IF;
  RETURN NULL;
END $$;

-- Replaces what a change covers. Items: {kind, id} or {kind: 'operation_code', code}. Duplicates are dropped. Drafts only.
CREATE FUNCTION app.set_change_links(p_change uuid, p_links jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.change_requests%ROWTYPE; e jsonb; v_kind text; v_id uuid; v_code text;
BEGIN
  c := app.change_for_write(p_change);
  IF c.stage <> 'draft' THEN RAISE EXCEPTION 'What % covers can be changed only while it is a draft', c.reference USING ERRCODE = 'QM035'; END IF;
  IF jsonb_typeof(coalesce(p_links, '[]'::jsonb)) <> 'array' THEN RAISE EXCEPTION 'Send the links as a list' USING ERRCODE = 'QM035'; END IF;
  IF jsonb_array_length(coalesce(p_links, '[]'::jsonb)) > 100 THEN RAISE EXCEPTION 'A change covers at most 100 things' USING ERRCODE = 'QM035'; END IF;
  DELETE FROM public.change_links WHERE change_id = c.id;
  FOR e IN SELECT * FROM jsonb_array_elements(coalesce(p_links, '[]'::jsonb)) LOOP
    v_kind := e ->> 'kind';
    IF v_kind IS NULL OR v_kind NOT IN ('part', 'part_family', 'machine', 'supplier', 'customer', 'production_order', 'operation_code') THEN
      RAISE EXCEPTION 'A change covers parts, part families, machines, suppliers, customers, production orders or operations' USING ERRCODE = 'QM035';
    END IF;
    IF v_kind = 'operation_code' THEN
      v_code := btrim(coalesce(e ->> 'code', ''));
      IF length(v_code) NOT BETWEEN 1 AND 40 THEN RAISE EXCEPTION 'An operation code is 1 to 40 characters' USING ERRCODE = 'QM035'; END IF;
      INSERT INTO public.change_links (organisation_id, change_id, kind, operation_code) VALUES (c.organisation_id, c.id, v_kind, v_code) ON CONFLICT DO NOTHING;
    ELSE
      BEGIN v_id := (e ->> 'id')::uuid; EXCEPTION WHEN others THEN v_id := NULL; END;
      IF v_id IS NULL THEN RAISE EXCEPTION 'Each link names the record it is to' USING ERRCODE = 'QM035'; END IF;
      BEGIN
        EXECUTE format('INSERT INTO public.change_links (organisation_id, change_id, kind, %I) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', v_kind || '_id')
          USING c.organisation_id, c.id, v_kind, v_id;
      EXCEPTION WHEN foreign_key_violation THEN
        RAISE EXCEPTION 'That % is not in this organisation', replace(v_kind, '_', ' ') USING ERRCODE = 'QM035';
      END;
    END IF;
  END LOOP;
  UPDATE public.change_requests SET updated_at = now() WHERE id = c.id;
END $$;

-- Keys: title, description (what), reason (why), typeId, urgency, origin {kind, id}, links [{kind, id | code}].
CREATE FUNCTION app.create_change(p_organisation_id uuid, p_data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE k text; v_n integer; v_yy smallint := (extract(year FROM current_date)::integer % 100)::smallint; v_id uuid; v_title text; v_type uuid; v_urgency text;
        v_kind text; v_src uuid; v_origin jsonb;
BEGIN
  PERFORM app.assert_change_manager(p_organisation_id);
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Send the change as an object' USING ERRCODE = 'QM035'; END IF;
  FOR k IN SELECT jsonb_object_keys(p_data) LOOP
    IF k NOT IN ('title', 'description', 'reason', 'typeId', 'urgency', 'origin', 'links') THEN RAISE EXCEPTION 'Unknown field %', k USING ERRCODE = 'QM035'; END IF;
  END LOOP;
  v_title := btrim(coalesce(p_data ->> 'title', ''));
  IF length(v_title) = 0 THEN RAISE EXCEPTION 'Give the change a title' USING ERRCODE = 'QM035'; END IF;
  IF length(v_title) > 200 THEN RAISE EXCEPTION 'The title is up to 200 characters' USING ERRCODE = 'QM035'; END IF;
  v_type := nullif(p_data ->> 'typeId', '')::uuid;
  IF v_type IS NULL THEN RAISE EXCEPTION 'Choose the type of change' USING ERRCODE = 'QM035'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.change_types t WHERE t.id = v_type AND t.organisation_id = p_organisation_id AND t.active) THEN
    RAISE EXCEPTION 'Choose an active type of change of this organisation' USING ERRCODE = 'QM035';
  END IF;
  v_urgency := coalesce(p_data ->> 'urgency', 'normal');
  IF v_urgency NOT IN ('normal', 'expedited') THEN RAISE EXCEPTION 'A change is normal or expedited' USING ERRCODE = 'QM035'; END IF;
  v_origin := p_data -> 'origin';
  IF v_origin IS NOT NULL AND jsonb_typeof(v_origin) <> 'null' THEN
    v_kind := v_origin ->> 'kind';
    BEGIN v_src := (v_origin ->> 'id')::uuid; EXCEPTION WHEN others THEN v_src := NULL; END;
    IF v_kind IS NULL OR v_src IS NULL OR v_kind NOT IN ('ncr', 'capa', 'audit_finding', 'risk', 'document_change_request') THEN
      RAISE EXCEPTION 'A change is raised from a non-conformance, an 8D, an audit finding, a risk or a document change request' USING ERRCODE = 'QM035';
    END IF;
    IF app.change_source_org(v_kind, v_src) IS DISTINCT FROM p_organisation_id THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
  END IF;
  INSERT INTO app.change_counters AS c (organisation_id, year, last_value) VALUES (p_organisation_id, v_yy, 1)
  ON CONFLICT (organisation_id, year) DO UPDATE SET last_value = c.last_value + 1 RETURNING last_value INTO v_n;
  INSERT INTO public.change_requests (organisation_id, reference, title, description, reason, type_id, urgency, origin_kind, origin_id)
  VALUES (p_organisation_id, 'ECR-' || lpad(v_yy::text, 2, '0') || '-' || app.pad_number(v_n, 4), v_title,
          nullif(btrim(coalesce(p_data ->> 'description', '')), ''), nullif(btrim(coalesce(p_data ->> 'reason', '')), ''), v_type, v_urgency, v_kind, v_src)
  RETURNING id INTO v_id;
  IF p_data ? 'links' THEN PERFORM app.set_change_links(v_id, p_data -> 'links'); END IF;
  RETURN v_id;
END $$;

-- Keys present are set (null clears description and reason). Drafts only.
CREATE FUNCTION app.update_change(p_change uuid, p_data jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.change_requests%ROWTYPE; k text; v_title text; v_type uuid; v_urgency text;
BEGIN
  c := app.change_for_write(p_change);
  IF c.stage <> 'draft' THEN RAISE EXCEPTION '% has left draft and its wording no longer changes', c.reference USING ERRCODE = 'QM035'; END IF;
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Send the changes as an object' USING ERRCODE = 'QM035'; END IF;
  FOR k IN SELECT jsonb_object_keys(p_data) LOOP
    IF k NOT IN ('title', 'description', 'reason', 'typeId', 'urgency') THEN RAISE EXCEPTION 'Unknown field %', k USING ERRCODE = 'QM035'; END IF;
  END LOOP;
  v_title := CASE WHEN p_data ? 'title' THEN btrim(coalesce(p_data ->> 'title', '')) ELSE c.title END;
  IF length(v_title) = 0 THEN RAISE EXCEPTION 'Give the change a title' USING ERRCODE = 'QM035'; END IF;
  IF length(v_title) > 200 THEN RAISE EXCEPTION 'The title is up to 200 characters' USING ERRCODE = 'QM035'; END IF;
  v_type := CASE WHEN p_data ? 'typeId' THEN nullif(p_data ->> 'typeId', '')::uuid ELSE c.type_id END;
  IF v_type IS NULL OR NOT EXISTS (SELECT 1 FROM public.change_types t WHERE t.id = v_type AND t.organisation_id = c.organisation_id AND (t.active OR t.id = c.type_id)) THEN
    RAISE EXCEPTION 'Choose an active type of change of this organisation' USING ERRCODE = 'QM035';
  END IF;
  v_urgency := CASE WHEN p_data ? 'urgency' THEN p_data ->> 'urgency' ELSE c.urgency END;
  IF v_urgency IS NULL OR v_urgency NOT IN ('normal', 'expedited') THEN RAISE EXCEPTION 'A change is normal or expedited' USING ERRCODE = 'QM035'; END IF;
  UPDATE public.change_requests SET
    title = v_title, type_id = v_type, urgency = v_urgency,
    description = CASE WHEN p_data ? 'description' THEN nullif(btrim(coalesce(p_data ->> 'description', '')), '') ELSE description END,
    reason = CASE WHEN p_data ? 'reason' THEN nullif(btrim(coalesce(p_data ->> 'reason', '')), '') ELSE reason END
  WHERE id = c.id;
END $$;

-- A draft or a change in progress is cancelled with a reason; a closed, rejected or cancelled one cannot be.
CREATE FUNCTION app.cancel_change(p_change uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.change_requests%ROWTYPE; v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  c := app.change_for_write(p_change);
  IF c.stage IN ('closed', 'rejected', 'cancelled') THEN RAISE EXCEPTION '% is % and cannot be cancelled', c.reference, c.stage USING ERRCODE = 'QM035'; END IF;
  IF length(v_reason) < 3 THEN RAISE EXCEPTION 'Say why it is cancelled (at least 3 characters)' USING ERRCODE = 'QM035'; END IF;
  UPDATE public.change_requests SET stage = 'cancelled', cancel_reason = left(v_reason, 500), cancelled_at = now(), cancelled_by = auth.uid() WHERE id = c.id;
END $$;

-- Files: recorded after the browser has uploaded them to the change's own folder.
CREATE FUNCTION app.add_change_attachment(p_change uuid, p_storage_path text, p_file_name text, p_content_type text, p_size_bytes bigint, p_description text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.change_requests%ROWTYPE; v_id uuid;
BEGIN
  c := app.change_for_write(p_change);
  IF c.stage IN ('closed', 'rejected', 'cancelled') THEN RAISE EXCEPTION '% is % and takes no more files', c.reference, c.stage USING ERRCODE = 'QM035'; END IF;
  IF p_storage_path NOT LIKE c.organisation_id::text || '/change/' || c.id::text || '/%' THEN
    RAISE EXCEPTION 'The file must be stored in this change''s folder' USING ERRCODE = 'QM035';
  END IF;
  INSERT INTO public.change_attachments (organisation_id, change_id, storage_path, file_name, content_type, size_bytes, description)
  VALUES (c.organisation_id, c.id, p_storage_path, btrim(p_file_name), p_content_type, p_size_bytes, nullif(btrim(coalesce(p_description, '')), ''))
  RETURNING id INTO v_id;
  UPDATE public.change_requests SET updated_at = now() WHERE id = c.id;
  RETURN v_id;
END $$;

CREATE FUNCTION app.remove_change_attachment(p_attachment uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_change uuid; v_removed timestamptz; v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  SELECT change_id, deleted_at INTO v_change, v_removed FROM public.change_attachments WHERE id = p_attachment;
  IF NOT FOUND THEN RAISE EXCEPTION 'File not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.change_for_write(v_change);
  IF v_removed IS NOT NULL THEN RAISE EXCEPTION 'That file is already removed' USING ERRCODE = 'QM035'; END IF;
  IF length(v_reason) < 3 THEN RAISE EXCEPTION 'Say why the file is removed (at least 3 characters)' USING ERRCODE = 'QM035'; END IF;
  UPDATE public.change_attachments SET deleted_at = now(), deleted_by = auth.uid(), delete_reason = left(v_reason, 500) WHERE id = p_attachment;
END $$;

CREATE FUNCTION app.restore_change_attachment(p_attachment uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_change uuid; v_removed timestamptz;
BEGIN
  SELECT change_id, deleted_at INTO v_change, v_removed FROM public.change_attachments WHERE id = p_attachment;
  IF NOT FOUND THEN RAISE EXCEPTION 'File not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.change_for_write(v_change);
  IF v_removed IS NULL THEN RAISE EXCEPTION 'That file is not removed' USING ERRCODE = 'QM035'; END IF;
  UPDATE public.change_attachments SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL WHERE id = p_attachment;
END $$;

REVOKE ALL ON FUNCTION app.change_rules(), app.change_link_rules(), app.change_attachment_rules(), app.seed_change_lists(uuid), app.seed_change_lists_trg(),
  app.assert_change_manager(uuid), app.change_for_write(uuid), app.change_source_org(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.set_change_links(uuid, jsonb), app.create_change(uuid, jsonb), app.update_change(uuid, jsonb), app.cancel_change(uuid, text),
  app.add_change_attachment(uuid, text, text, text, bigint, text), app.remove_change_attachment(uuid, text), app.restore_change_attachment(uuid),
  app.change_file_allowed(text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.set_change_links(uuid, jsonb), app.create_change(uuid, jsonb), app.update_change(uuid, jsonb), app.cancel_change(uuid, text),
  app.add_change_attachment(uuid, text, text, text, bigint, text), app.remove_change_attachment(uuid, text), app.restore_change_attachment(uuid),
  app.change_file_allowed(text, boolean) TO authenticated;
