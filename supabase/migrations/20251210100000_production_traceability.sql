-- Manufacturing traceability, slice TR1 (docs/phase-3-plan.md): production orders, their operations, lots and serial numbers as master records, and real links from
-- inspections (jobs) and non-conformances to them. The free-text work order / lot / serial columns stay as the snapshot of what was typed; picking a record fills them.
--
-- Conventions as earlier slices: organisation_id NOT NULL with composite keys, RLS site-aware through each row's own site, table-level INSERT stamped by
-- app.stamp_created(), column-level UPDATE, no DELETE (status instead), audit_changes everywhere. Rule violations raise QM017 (API: 409 production_rule).
-- Nothing here blocks work: a lot on hold or an order that is closed is information for people; only the record being edited is protected.

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------
INSERT INTO public.permissions (code, description) VALUES
  ('production.read',   'View production orders, lots and serial numbers'),
  ('production.manage', 'Create and change production orders, operations, lots and serial numbers');

WITH grants(key, perms) AS (VALUES
  ('owner',            ARRAY['production.read', 'production.manage']),
  ('admin',            ARRAY['production.read', 'production.manage']),
  ('quality_manager',  ARRAY['production.read', 'production.manage']),
  ('quality_engineer', ARRAY['production.read', 'production.manage']),
  ('inspector',        ARRAY['production.read']),
  ('viewer',           ARRAY['production.read'])
)
INSERT INTO public.role_permissions (role_id, permission_code)
SELECT r.id, unnest(g.perms) FROM public.roles r JOIN grants g ON g.key = r.key WHERE r.is_system
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Production orders and their operations
-- ---------------------------------------------------------------------------
CREATE TABLE public.production_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  order_number text NOT NULL CHECK (order_number ~ '^\S(.{0,58}\S)?$'),
  part_id uuid NOT NULL,
  part_revision_id uuid,
  customer_id uuid,
  site_id uuid,
  quantity_planned numeric NOT NULL CHECK (quantity_planned > 0),
  due_date date,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'released', 'in_progress', 'completed', 'closed', 'cancelled')),
  status_reason text CHECK (status_reason IS NULL OR length(status_reason) <= 1000),
  notes text CHECK (notes IS NULL OR length(notes) <= 2000),
  -- Reserved for imports (design brief §7.5: the ERP will own the number); people cannot set them.
  external_system text CHECK (external_system IS NULL OR length(external_system) <= 40),
  external_id text CHECK (external_id IS NULL OR length(external_id) <= 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT production_orders_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT production_orders_part_fkey FOREIGN KEY (part_id, organisation_id) REFERENCES public.parts (id, organisation_id),
  CONSTRAINT production_orders_revision_fkey FOREIGN KEY (part_revision_id, organisation_id) REFERENCES public.part_revisions (id, organisation_id),
  CONSTRAINT production_orders_customer_fkey FOREIGN KEY (customer_id, organisation_id) REFERENCES public.customers (id, organisation_id),
  CONSTRAINT production_orders_site_fkey FOREIGN KEY (site_id, organisation_id) REFERENCES public.sites (id, organisation_id),
  CONSTRAINT production_orders_external_pair CHECK ((external_system IS NULL) = (external_id IS NULL)),
  CONSTRAINT production_orders_cancel_reason CHECK (status <> 'cancelled' OR length(trim(coalesce(status_reason, ''))) > 0)
);
CREATE UNIQUE INDEX production_orders_org_number_key ON public.production_orders (organisation_id, upper(order_number));
CREATE UNIQUE INDEX production_orders_external_key ON public.production_orders (organisation_id, external_system, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX production_orders_part_idx ON public.production_orders (part_id);

CREATE TABLE public.production_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  production_order_id uuid NOT NULL,
  site_id uuid,
  sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 9999),
  operation_code text NOT NULL CHECK (operation_code ~ '^\S(.{0,38}\S)?$'),
  description text CHECK (description IS NULL OR length(description) <= 200),
  machine_id uuid,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'skipped')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT production_operations_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT production_operations_order_fkey FOREIGN KEY (production_order_id, organisation_id) REFERENCES public.production_orders (id, organisation_id),
  CONSTRAINT production_operations_machine_fkey FOREIGN KEY (machine_id, organisation_id) REFERENCES public.machines (id, organisation_id),
  CONSTRAINT production_operations_site_fkey FOREIGN KEY (site_id, organisation_id) REFERENCES public.sites (id, organisation_id),
  CONSTRAINT production_operations_order_sequence_key UNIQUE (production_order_id, sequence)
);
CREATE INDEX production_operations_machine_idx ON public.production_operations (machine_id) WHERE machine_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Lots and serial numbers
-- ---------------------------------------------------------------------------
CREATE TABLE public.lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  lot_number text NOT NULL CHECK (lot_number ~ '^\S(.{0,58}\S)?$'),
  part_id uuid NOT NULL,
  origin text NOT NULL CHECK (origin IN ('produced', 'received')),
  production_order_id uuid,
  supplier_id uuid,
  site_id uuid,
  quantity numeric CHECK (quantity IS NULL OR quantity > 0),
  received_on date,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'on_hold', 'released', 'closed')),
  status_reason text CHECK (status_reason IS NULL OR length(status_reason) <= 1000),
  notes text CHECK (notes IS NULL OR length(notes) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT lots_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT lots_part_fkey FOREIGN KEY (part_id, organisation_id) REFERENCES public.parts (id, organisation_id),
  CONSTRAINT lots_order_fkey FOREIGN KEY (production_order_id, organisation_id) REFERENCES public.production_orders (id, organisation_id),
  CONSTRAINT lots_supplier_fkey FOREIGN KEY (supplier_id, organisation_id) REFERENCES public.suppliers (id, organisation_id),
  CONSTRAINT lots_site_fkey FOREIGN KEY (site_id, organisation_id) REFERENCES public.sites (id, organisation_id),
  CONSTRAINT lots_origin_shape CHECK ((origin = 'produced' AND supplier_id IS NULL) OR (origin = 'received' AND production_order_id IS NULL)),
  CONSTRAINT lots_hold_reason CHECK (status <> 'on_hold' OR length(trim(coalesce(status_reason, ''))) > 0)
);
CREATE UNIQUE INDEX lots_org_part_number_key ON public.lots (organisation_id, part_id, upper(lot_number));
CREATE INDEX lots_order_idx ON public.lots (production_order_id) WHERE production_order_id IS NOT NULL;
CREATE INDEX lots_supplier_idx ON public.lots (supplier_id) WHERE supplier_id IS NOT NULL;

CREATE TABLE public.serial_numbers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  serial_number text NOT NULL CHECK (serial_number ~ '^\S(.{0,58}\S)?$'),
  part_id uuid NOT NULL,
  lot_id uuid,
  production_order_id uuid,
  site_id uuid,
  status text NOT NULL DEFAULT 'in_production' CHECK (status IN ('in_production', 'completed', 'scrapped')),
  status_reason text CHECK (status_reason IS NULL OR length(status_reason) <= 1000),
  notes text CHECK (notes IS NULL OR length(notes) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT serial_numbers_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT serial_numbers_part_fkey FOREIGN KEY (part_id, organisation_id) REFERENCES public.parts (id, organisation_id),
  CONSTRAINT serial_numbers_lot_fkey FOREIGN KEY (lot_id, organisation_id) REFERENCES public.lots (id, organisation_id),
  CONSTRAINT serial_numbers_order_fkey FOREIGN KEY (production_order_id, organisation_id) REFERENCES public.production_orders (id, organisation_id),
  CONSTRAINT serial_numbers_site_fkey FOREIGN KEY (site_id, organisation_id) REFERENCES public.sites (id, organisation_id),
  CONSTRAINT serial_numbers_scrap_reason CHECK (status <> 'scrapped' OR length(trim(coalesce(status_reason, ''))) > 0)
);
CREATE UNIQUE INDEX serial_numbers_org_part_serial_key ON public.serial_numbers (organisation_id, part_id, upper(serial_number));
CREATE INDEX serial_numbers_lot_idx ON public.serial_numbers (lot_id) WHERE lot_id IS NOT NULL;
CREATE INDEX serial_numbers_order_idx ON public.serial_numbers (production_order_id) WHERE production_order_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Links from quality records (the free text stays as the snapshot)
-- ---------------------------------------------------------------------------
ALTER TABLE public.inspection_records
  ADD COLUMN production_order_id uuid,
  ADD COLUMN lot_id uuid,
  ADD COLUMN serial_id uuid,
  ADD CONSTRAINT inspection_records_order_fkey FOREIGN KEY (production_order_id, organisation_id) REFERENCES public.production_orders (id, organisation_id),
  ADD CONSTRAINT inspection_records_lot_fkey FOREIGN KEY (lot_id, organisation_id) REFERENCES public.lots (id, organisation_id),
  ADD CONSTRAINT inspection_records_serial_fkey FOREIGN KEY (serial_id, organisation_id) REFERENCES public.serial_numbers (id, organisation_id);
CREATE INDEX inspection_records_order_idx ON public.inspection_records (production_order_id) WHERE production_order_id IS NOT NULL;
CREATE INDEX inspection_records_lot_idx ON public.inspection_records (lot_id) WHERE lot_id IS NOT NULL;
CREATE INDEX inspection_records_serial_idx ON public.inspection_records (serial_id) WHERE serial_id IS NOT NULL;

ALTER TABLE public.nonconformances
  ADD COLUMN production_order_id uuid,
  ADD COLUMN lot_id uuid,
  ADD COLUMN serial_id uuid,
  ADD CONSTRAINT nonconformances_order_fkey FOREIGN KEY (production_order_id, organisation_id) REFERENCES public.production_orders (id, organisation_id),
  ADD CONSTRAINT nonconformances_lot_fkey FOREIGN KEY (lot_id, organisation_id) REFERENCES public.lots (id, organisation_id),
  ADD CONSTRAINT nonconformances_serial_fkey FOREIGN KEY (serial_id, organisation_id) REFERENCES public.serial_numbers (id, organisation_id);
CREATE INDEX nonconformances_order_idx ON public.nonconformances (production_order_id) WHERE production_order_id IS NOT NULL;
CREATE INDEX nonconformances_lot_idx ON public.nonconformances (lot_id) WHERE lot_id IS NOT NULL;
CREATE INDEX nonconformances_serial_idx ON public.nonconformances (serial_id) WHERE serial_id IS NOT NULL;
GRANT UPDATE (production_order_id, lot_id, serial_id) ON public.nonconformances TO authenticated;

-- ---------------------------------------------------------------------------
-- Rules
-- ---------------------------------------------------------------------------
-- Works out and checks the production context a record names. p_changed says which link the person just picked ('serial', 'lot', 'order'): the others are filled in from it
-- when empty (a serial implies its lot and order, a lot its order, each its part). Any two links that are both given must agree. Returns the resolved ids and the numbers.
CREATE FUNCTION app.production_link_resolve(p_org uuid, p_part uuid, p_order uuid, p_lot uuid, p_serial uuid, p_changed text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  o public.production_orders;
  l public.lots;
  s public.serial_numbers;
  v_part uuid := p_part;
  v_order uuid := p_order;
  v_lot uuid := p_lot;
BEGIN
  IF p_serial IS NOT NULL THEN
    SELECT * INTO s FROM public.serial_numbers WHERE id = p_serial AND organisation_id = p_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'The serial number was not found' USING ERRCODE = 'QM017';
    END IF;
    IF p_changed = 'serial' THEN
      v_lot := coalesce(v_lot, s.lot_id);
      v_order := coalesce(v_order, s.production_order_id);
      v_part := coalesce(v_part, s.part_id);
    END IF;
  END IF;
  IF v_lot IS NOT NULL THEN
    SELECT * INTO l FROM public.lots WHERE id = v_lot AND organisation_id = p_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'The lot was not found' USING ERRCODE = 'QM017';
    END IF;
    IF p_changed IN ('serial', 'lot') THEN
      v_order := coalesce(v_order, l.production_order_id);
      v_part := coalesce(v_part, l.part_id);
    END IF;
  END IF;
  IF v_order IS NOT NULL THEN
    SELECT * INTO o FROM public.production_orders WHERE id = v_order AND organisation_id = p_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'The production order was not found' USING ERRCODE = 'QM017';
    END IF;
    v_part := coalesce(v_part, o.part_id);
  END IF;

  IF p_serial IS NOT NULL THEN
    IF s.part_id IS DISTINCT FROM v_part THEN
      RAISE EXCEPTION 'Serial number % is for another part', s.serial_number USING ERRCODE = 'QM017';
    END IF;
    IF s.lot_id IS NOT NULL AND v_lot IS NOT NULL AND s.lot_id <> v_lot THEN
      RAISE EXCEPTION 'Serial number % belongs to another lot', s.serial_number USING ERRCODE = 'QM017';
    END IF;
    IF s.production_order_id IS NOT NULL AND v_order IS NOT NULL AND s.production_order_id <> v_order THEN
      RAISE EXCEPTION 'Serial number % belongs to another production order', s.serial_number USING ERRCODE = 'QM017';
    END IF;
  END IF;
  IF v_lot IS NOT NULL THEN
    IF l.part_id IS DISTINCT FROM v_part THEN
      RAISE EXCEPTION 'Lot % is for another part', l.lot_number USING ERRCODE = 'QM017';
    END IF;
    IF l.production_order_id IS NOT NULL AND v_order IS NOT NULL AND l.production_order_id <> v_order THEN
      RAISE EXCEPTION 'Lot % belongs to another production order', l.lot_number USING ERRCODE = 'QM017';
    END IF;
  END IF;
  IF v_order IS NOT NULL AND o.part_id IS DISTINCT FROM v_part THEN
    RAISE EXCEPTION 'Production order % is for another part', o.order_number USING ERRCODE = 'QM017';
  END IF;

  RETURN jsonb_build_object('part_id', v_part, 'order_id', v_order, 'lot_id', v_lot,
                            'order_number', o.order_number, 'lot_number', l.lot_number, 'serial_number', s.serial_number);
END $$;

CREATE FUNCTION app.production_order_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  user_change boolean := coalesce(auth.role(), '') = 'authenticated';
  v_open text;
  allowed text[] := ARRAY['planned>released', 'planned>cancelled', 'released>planned', 'released>in_progress', 'released>cancelled',
                          'in_progress>completed', 'in_progress>cancelled', 'completed>closed', 'completed>in_progress'];
BEGIN
  IF NEW.part_revision_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.part_revisions r WHERE r.id = NEW.part_revision_id AND r.part_id = NEW.part_id) THEN
    RAISE EXCEPTION 'The revision does not belong to the order''s part' USING ERRCODE = 'QM017';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF user_change THEN
      NEW.status := 'planned'; NEW.status_reason := NULL;
      NEW.external_system := NULL; NEW.external_id := NULL;
    END IF;
    RETURN NEW;
  END IF;
  IF NOT user_change THEN
    RETURN NEW;
  END IF;
  IF OLD.status IN ('closed', 'cancelled') THEN
    IF (to_jsonb(NEW) - ARRAY['updated_at', 'updated_by']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['updated_at', 'updated_by']) THEN
      RAISE EXCEPTION 'Order % is %; it can no longer be changed', OLD.order_number, OLD.status USING ERRCODE = 'QM017';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status <> OLD.status THEN
    IF NOT ((OLD.status || '>' || NEW.status) = ANY (allowed)) THEN
      RAISE EXCEPTION 'An order that is % cannot become %', replace(OLD.status, '_', ' '), replace(NEW.status, '_', ' ') USING ERRCODE = 'QM017';
    END IF;
    IF NEW.status = 'cancelled' THEN
      IF length(trim(coalesce(NEW.status_reason, ''))) = 0 THEN
        RAISE EXCEPTION 'Give a reason for cancelling the order' USING ERRCODE = 'QM017';
      END IF;
    ELSE
      NEW.status_reason := NULL;
    END IF;
    IF NEW.status = 'completed' THEN
      SELECT string_agg(operation_code, ', ' ORDER BY sequence) INTO v_open
        FROM public.production_operations WHERE production_order_id = NEW.id AND status IN ('pending', 'in_progress');
      IF v_open IS NOT NULL THEN
        RAISE EXCEPTION 'Complete or skip every operation first; still open: %', v_open USING ERRCODE = 'QM017';
      END IF;
    END IF;
  ELSIF NEW.status_reason IS DISTINCT FROM OLD.status_reason THEN
    RAISE EXCEPTION 'The reason is given with the status' USING ERRCODE = 'QM017';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION app.production_operation_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  o public.production_orders;
  v_machine_site uuid;
BEGIN
  SELECT * INTO o FROM public.production_orders WHERE id = NEW.production_order_id;
  IF TG_OP = 'UPDATE' AND NEW.production_order_id <> OLD.production_order_id THEN
    RAISE EXCEPTION 'An operation cannot move to another order' USING ERRCODE = 'QM017';
  END IF;
  NEW.site_id := o.site_id;
  IF coalesce(auth.role(), '') = 'authenticated' AND o.status NOT IN ('planned', 'released', 'in_progress') THEN
    RAISE EXCEPTION 'Order % is %; its operations can no longer be changed', o.order_number, replace(o.status, '_', ' ') USING ERRCODE = 'QM017';
  END IF;
  IF NEW.machine_id IS NOT NULL AND o.site_id IS NOT NULL THEN
    SELECT site_id INTO v_machine_site FROM public.machines WHERE id = NEW.machine_id;
    IF v_machine_site IS NOT NULL AND v_machine_site <> o.site_id THEN
      RAISE EXCEPTION 'That machine is at another site than the order' USING ERRCODE = 'QM017';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION app.lot_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  user_change boolean := coalesce(auth.role(), '') = 'authenticated';
  o public.production_orders;
  allowed text[] := ARRAY['open>on_hold', 'open>released', 'open>closed', 'on_hold>open', 'on_hold>released', 'on_hold>closed', 'released>on_hold', 'released>closed'];
BEGIN
  IF NEW.production_order_id IS NOT NULL THEN
    SELECT * INTO o FROM public.production_orders WHERE id = NEW.production_order_id;
    IF o.part_id <> NEW.part_id THEN
      RAISE EXCEPTION 'Production order % is for another part', o.order_number USING ERRCODE = 'QM017';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF user_change THEN
      IF o.status IN ('closed', 'cancelled') THEN
        RAISE EXCEPTION 'Order % is %; no more lots can be made for it', o.order_number, o.status USING ERRCODE = 'QM017';
      END IF;
      NEW.status := 'open'; NEW.status_reason := NULL;
    END IF;
    NEW.site_id := coalesce(NEW.site_id, o.site_id);
    RETURN NEW;
  END IF;
  IF NOT user_change THEN
    RETURN NEW;
  END IF;
  IF NEW.supplier_id IS DISTINCT FROM OLD.supplier_id AND NEW.origin <> 'received' THEN
    RAISE EXCEPTION 'Only a received lot has a supplier' USING ERRCODE = 'QM017';
  END IF;
  IF OLD.status = 'closed' THEN
    IF (to_jsonb(NEW) - ARRAY['updated_at', 'updated_by']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['updated_at', 'updated_by']) THEN
      RAISE EXCEPTION 'Lot % is closed; it can no longer be changed', OLD.lot_number USING ERRCODE = 'QM017';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status <> OLD.status THEN
    IF NOT ((OLD.status || '>' || NEW.status) = ANY (allowed)) THEN
      RAISE EXCEPTION 'A lot that is % cannot become %', replace(OLD.status, '_', ' '), replace(NEW.status, '_', ' ') USING ERRCODE = 'QM017';
    END IF;
    IF NEW.status = 'on_hold' AND length(trim(coalesce(NEW.status_reason, ''))) = 0 THEN
      RAISE EXCEPTION 'Say why the lot is on hold' USING ERRCODE = 'QM017';
    END IF;
    IF NEW.status IN ('open', 'released') THEN
      NEW.status_reason := NULL;
    END IF;
  ELSIF NEW.status_reason IS DISTINCT FROM OLD.status_reason THEN
    RAISE EXCEPTION 'The reason is given with the status' USING ERRCODE = 'QM017';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION app.serial_number_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  user_change boolean := coalesce(auth.role(), '') = 'authenticated';
  r jsonb;
  l public.lots;
  v_changed text;
  allowed text[] := ARRAY['in_production>completed', 'in_production>scrapped', 'completed>in_production', 'completed>scrapped'];
BEGIN
  IF TG_OP = 'UPDATE' AND user_change AND OLD.status = 'scrapped' THEN
    IF (to_jsonb(NEW) - ARRAY['updated_at', 'updated_by']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['updated_at', 'updated_by']) THEN
      RAISE EXCEPTION 'Serial number % is scrapped; it can no longer be changed', OLD.serial_number USING ERRCODE = 'QM017';
    END IF;
    RETURN NEW;
  END IF;
  -- The lot and order must agree with the part (and each other); a lot supplies its order and site when they are empty.
  IF NEW.lot_id IS NOT NULL OR NEW.production_order_id IS NOT NULL THEN
    v_changed := CASE WHEN NEW.lot_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.lot_id IS DISTINCT FROM OLD.lot_id) THEN 'lot' ELSE 'order' END;
    r := app.production_link_resolve(NEW.organisation_id, NEW.part_id, NEW.production_order_id, NEW.lot_id, NULL, v_changed);
    NEW.production_order_id := (r->>'order_id')::uuid;
    IF NEW.lot_id IS NOT NULL AND NEW.site_id IS NULL THEN
      SELECT site_id INTO NEW.site_id FROM public.lots WHERE id = NEW.lot_id;
    END IF;
    IF NEW.production_order_id IS NOT NULL AND NEW.site_id IS NULL THEN
      SELECT site_id INTO NEW.site_id FROM public.production_orders WHERE id = NEW.production_order_id;
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF user_change THEN
      NEW.status := 'in_production'; NEW.status_reason := NULL;
    END IF;
    RETURN NEW;
  END IF;
  IF NOT user_change THEN
    RETURN NEW;
  END IF;
  IF NEW.status <> OLD.status THEN
    IF NOT ((OLD.status || '>' || NEW.status) = ANY (allowed)) THEN
      RAISE EXCEPTION 'A serial number that is % cannot become %', replace(OLD.status, '_', ' '), replace(NEW.status, '_', ' ') USING ERRCODE = 'QM017';
    END IF;
    IF NEW.status = 'scrapped' AND length(trim(coalesce(NEW.status_reason, ''))) = 0 THEN
      RAISE EXCEPTION 'Say why the serial number is scrapped' USING ERRCODE = 'QM017';
    END IF;
    IF NEW.status <> 'scrapped' THEN
      NEW.status_reason := NULL;
    END IF;
  ELSIF NEW.status_reason IS DISTINCT FROM OLD.status_reason THEN
    RAISE EXCEPTION 'The reason is given with the status' USING ERRCODE = 'QM017';
  END IF;
  RETURN NEW;
END $$;

-- Inspections: the context is frozen with the record, but while a job runs its production links (like its typed work order, lot and serial) can be set (app.set_job_links).
CREATE FUNCTION app.inspection_production_links() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_old_order uuid; v_old_lot uuid; v_old_serial uuid;
  v_changed text;
  r jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_old_order := OLD.production_order_id; v_old_lot := OLD.lot_id; v_old_serial := OLD.serial_id;
  END IF;
  IF (NEW.production_order_id, NEW.lot_id, NEW.serial_id) IS NOT DISTINCT FROM (v_old_order, v_old_lot, v_old_serial) THEN
    RETURN NEW;
  END IF;
  v_changed := CASE WHEN NEW.serial_id IS NOT NULL AND NEW.serial_id IS DISTINCT FROM v_old_serial THEN 'serial'
                    WHEN NEW.lot_id IS NOT NULL AND NEW.lot_id IS DISTINCT FROM v_old_lot THEN 'lot'
                    WHEN NEW.production_order_id IS NOT NULL AND NEW.production_order_id IS DISTINCT FROM v_old_order THEN 'order' END;
  IF NEW.production_order_id IS NOT NULL OR NEW.lot_id IS NOT NULL OR NEW.serial_id IS NOT NULL THEN
    r := app.production_link_resolve(NEW.organisation_id, NEW.part_id, NEW.production_order_id, NEW.lot_id, NEW.serial_id, v_changed);
    NEW.production_order_id := (r->>'order_id')::uuid;
    NEW.lot_id := (r->>'lot_id')::uuid;
  END IF;
  IF NEW.production_order_id IS NOT NULL AND NEW.production_order_id IS DISTINCT FROM v_old_order THEN NEW.work_order := r->>'order_number'; END IF;
  IF NEW.lot_id IS NOT NULL AND NEW.lot_id IS DISTINCT FROM v_old_lot THEN NEW.lot := r->>'lot_number'; END IF;
  IF NEW.serial_id IS NOT NULL AND NEW.serial_id IS DISTINCT FROM v_old_serial THEN NEW.serial := r->>'serial_number'; END IF;
  RETURN NEW;
END $$;

-- Non-conformances: the same, and the part is filled in from the picked record when the NC has none yet.
CREATE FUNCTION app.ncr_production_links() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_old_order uuid; v_old_lot uuid; v_old_serial uuid;
  v_changed text;
  r jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_old_order := OLD.production_order_id; v_old_lot := OLD.lot_id; v_old_serial := OLD.serial_id;
  END IF;
  IF (NEW.production_order_id, NEW.lot_id, NEW.serial_id) IS NOT DISTINCT FROM (v_old_order, v_old_lot, v_old_serial) THEN
    RETURN NEW;
  END IF;
  v_changed := CASE WHEN NEW.serial_id IS NOT NULL AND NEW.serial_id IS DISTINCT FROM v_old_serial THEN 'serial'
                    WHEN NEW.lot_id IS NOT NULL AND NEW.lot_id IS DISTINCT FROM v_old_lot THEN 'lot'
                    WHEN NEW.production_order_id IS NOT NULL AND NEW.production_order_id IS DISTINCT FROM v_old_order THEN 'order' END;
  IF NEW.production_order_id IS NOT NULL OR NEW.lot_id IS NOT NULL OR NEW.serial_id IS NOT NULL THEN
    r := app.production_link_resolve(NEW.organisation_id, NEW.part_id, NEW.production_order_id, NEW.lot_id, NEW.serial_id, v_changed);
    NEW.production_order_id := (r->>'order_id')::uuid;
    NEW.lot_id := (r->>'lot_id')::uuid;
    NEW.part_id := coalesce(NEW.part_id, (r->>'part_id')::uuid);
  END IF;
  IF NEW.production_order_id IS NOT NULL AND NEW.production_order_id IS DISTINCT FROM v_old_order THEN NEW.work_order := r->>'order_number'; END IF;
  IF NEW.lot_id IS NOT NULL AND NEW.lot_id IS DISTINCT FROM v_old_lot THEN NEW.lot_number := r->>'lot_number'; END IF;
  IF NEW.serial_id IS NOT NULL AND NEW.serial_id IS DISTINCT FROM v_old_serial THEN NEW.serial_number := r->>'serial_number'; END IF;
  RETURN NEW;
END $$;

-- The inspection rules (job_details migration) with the three link columns joining the ones a running job may change.
CREATE OR REPLACE FUNCTION app.inspection_record_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_missing text;
  v_unhandled text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Only app.start_inspection inserts (users have no INSERT privilege); keep it consistent.
    NEW.status := 'in_progress'; NEW.result := NULL; NEW.completed_at := NULL; NEW.completed_by := NULL; NEW.abandon_reason := NULL;
    NEW.started_at := now();
    RETURN NEW;
  END IF;
  -- While the job is running its work order, lot, lot size, serial and production links can be filled in or corrected (app.set_job_details, app.set_job_links);
  -- every other context column is frozen.
  IF (to_jsonb(NEW) - ARRAY['status', 'result', 'completed_at', 'completed_by', 'abandon_reason', 'notes', 'updated_at', 'updated_by']
        - CASE WHEN OLD.status = 'in_progress' AND NEW.status = 'in_progress'
               THEN ARRAY['work_order', 'lot', 'lot_size', 'serial', 'production_order_id', 'lot_id', 'serial_id'] ELSE ARRAY[]::text[] END)
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'result', 'completed_at', 'completed_by', 'abandon_reason', 'notes', 'updated_at', 'updated_by']
        - CASE WHEN OLD.status = 'in_progress' AND NEW.status = 'in_progress'
               THEN ARRAY['work_order', 'lot', 'lot_size', 'serial', 'production_order_id', 'lot_id', 'serial_id'] ELSE ARRAY[]::text[] END) THEN
    RAISE EXCEPTION 'The context and requirements of an inspection cannot change' USING ERRCODE = 'QM008';
  END IF;
  IF OLD.status <> 'in_progress' THEN
    IF NEW IS DISTINCT FROM OLD AND (NEW.status, NEW.result, NEW.notes, NEW.abandon_reason) IS DISTINCT FROM (OLD.status, OLD.result, OLD.notes, OLD.abandon_reason) THEN
      RAISE EXCEPTION 'Inspection % is %', OLD.reference, OLD.status USING ERRCODE = 'QM008';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'in_progress' THEN
    IF (NEW.result, NEW.completed_at, NEW.completed_by, NEW.abandon_reason) IS DISTINCT FROM (OLD.result, OLD.completed_at, OLD.completed_by, OLD.abandon_reason) THEN
      RAISE EXCEPTION 'The result is worked out when the inspection is completed' USING ERRCODE = 'QM008';
    END IF;
    RETURN NEW;
  END IF;
  NEW.completed_at := now();
  NEW.completed_by := auth.uid();
  IF NEW.status = 'abandoned' THEN
    IF coalesce(trim(NEW.abandon_reason), '') = '' THEN
      RAISE EXCEPTION 'Give a reason for abandoning the inspection' USING ERRCODE = 'QM008';
    END IF;
    NEW.result := NULL;
    RETURN NEW;
  END IF;
  -- Completed.
  NEW.abandon_reason := NULL;
  SELECT string_agg(q.name, ', ' ORDER BY q.sequence) INTO v_missing
  FROM public.resolved_inspection_requirements q
  WHERE q.inspection_record_id = NEW.id AND q.applicable
    AND NOT EXISTS (SELECT 1 FROM public.inspection_measurements m WHERE m.requirement_id = q.id);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Measure every check before completing; missing: %', v_missing USING ERRCODE = 'QM008';
  END IF;
  -- Every current failed reading needs an acknowledgement or a live NC (one that is not cancelled or deleted).
  SELECT string_agg(q.name || ' (sample ' || s.sample_number || ')', ', ' ORDER BY s.sample_number, q.sequence) INTO v_unhandled
  FROM public.inspection_measurements m
  JOIN public.resolved_inspection_requirements q ON q.id = m.requirement_id
  JOIN public.inspection_samples s ON s.id = m.sample_id
  WHERE m.inspection_record_id = NEW.id AND m.result = 'fail'
    AND NOT EXISTS (SELECT 1 FROM public.inspection_measurements c WHERE c.supersedes_id = m.id)
    AND NOT EXISTS (SELECT 1 FROM public.inspection_failure_acknowledgements a WHERE a.measurement_id = m.id)
    AND app.reading_live_ncr(m.id) IS NULL;
  IF v_unhandled IS NOT NULL THEN
    RAISE EXCEPTION 'Acknowledge or raise an NC for each failed reading before completing: %', v_unhandled USING ERRCODE = 'QM008';
  END IF;
  NEW.result := CASE WHEN EXISTS (
      SELECT 1 FROM public.inspection_measurements m
      WHERE m.inspection_record_id = NEW.id AND m.result = 'fail'
        AND NOT EXISTS (SELECT 1 FROM public.inspection_measurements c WHERE c.supersedes_id = m.id))
    THEN 'fail' ELSE 'pass' END;
  RETURN NEW;
END $$;

-- Set, change or clear the production order, lot and serial a running job is for. p_links holds any of productionOrderId, lotId, serialId: a key present with null
-- clears that link, an absent key keeps it. Needs inspection.record at the job's site and production.read for what is being linked. Fills the typed work order / lot /
-- serial from the picked records.
CREATE FUNCTION app.set_job_links(p_inspection_id uuid, p_links jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.inspection_records%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.inspection_records WHERE id = p_inspection_id;
  IF NOT FOUND OR NOT app.has_permission(r.organisation_id, 'inspection.record', r.site_id) THEN
    RAISE EXCEPTION 'Inspection not found' USING ERRCODE = 'P0002';
  END IF;
  IF r.status <> 'in_progress' THEN
    RAISE EXCEPTION 'Inspection % is %', r.reference, r.status USING ERRCODE = 'QM008';
  END IF;
  IF NOT app.has_permission(r.organisation_id, 'production.read', r.site_id) THEN
    RAISE EXCEPTION 'Linking production records needs the production.read permission' USING ERRCODE = '42501';
  END IF;
  UPDATE public.inspection_records
     SET production_order_id = CASE WHEN p_links ? 'productionOrderId' THEN nullif(p_links->>'productionOrderId', '')::uuid ELSE production_order_id END,
         lot_id = CASE WHEN p_links ? 'lotId' THEN nullif(p_links->>'lotId', '')::uuid ELSE lot_id END,
         serial_id = CASE WHEN p_links ? 'serialId' THEN nullif(p_links->>'serialId', '')::uuid ELSE serial_id END
   WHERE id = p_inspection_id;
END $$;

-- ---------------------------------------------------------------------------
-- Triggers, bookkeeping and audit
-- ---------------------------------------------------------------------------
CREATE TRIGGER production_orders_rules BEFORE INSERT OR UPDATE ON public.production_orders FOR EACH ROW EXECUTE FUNCTION app.production_order_rules();
CREATE TRIGGER production_operations_rules BEFORE INSERT OR UPDATE ON public.production_operations FOR EACH ROW EXECUTE FUNCTION app.production_operation_rules();
CREATE TRIGGER lots_rules BEFORE INSERT OR UPDATE ON public.lots FOR EACH ROW EXECUTE FUNCTION app.lot_rules();
CREATE TRIGGER serial_numbers_rules BEFORE INSERT OR UPDATE ON public.serial_numbers FOR EACH ROW EXECUTE FUNCTION app.serial_number_rules();
CREATE TRIGGER inspection_records_production_links BEFORE INSERT OR UPDATE ON public.inspection_records FOR EACH ROW EXECUTE FUNCTION app.inspection_production_links();
CREATE TRIGGER nonconformances_production_links BEFORE INSERT OR UPDATE ON public.nonconformances FOR EACH ROW EXECUTE FUNCTION app.ncr_production_links();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['production_orders', 'production_operations', 'lots', 'serial_numbers'] LOOP
    EXECUTE format('CREATE TRIGGER %1$s_stamp BEFORE INSERT ON public.%1$I FOR EACH ROW EXECUTE FUNCTION app.stamp_created()', t);
    EXECUTE format('CREATE TRIGGER %1$s_touch BEFORE UPDATE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION app.touch_updated()', t);
    EXECUTE format('CREATE TRIGGER %1$s_org_immutable BEFORE UPDATE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change()', t);
    EXECUTE format('CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.%I '
                   'FOR EACH ROW EXECUTE FUNCTION audit.record_change(''organisation_id'')', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT, INSERT ON public.%I TO authenticated', t);
    EXECUTE format('CREATE POLICY %1$s_select ON public.%1$I FOR SELECT TO authenticated '
                   'USING (app.has_permission(organisation_id, ''production.read'', site_id))', t);
    EXECUTE format('CREATE POLICY %1$s_insert ON public.%1$I FOR INSERT TO authenticated '
                   'WITH CHECK (app.has_permission(organisation_id, ''production.manage'', site_id))', t);
    EXECUTE format('CREATE POLICY %1$s_update ON public.%1$I FOR UPDATE TO authenticated '
                   'USING (app.has_permission(organisation_id, ''production.manage'', site_id)) '
                   'WITH CHECK (app.has_permission(organisation_id, ''production.manage'', site_id))', t);
  END LOOP;
END $$;

GRANT UPDATE (part_revision_id, customer_id, quantity_planned, due_date, notes, status, status_reason) ON public.production_orders TO authenticated;
GRANT UPDATE (sequence, operation_code, description, machine_id, status) ON public.production_operations TO authenticated;
GRANT UPDATE (supplier_id, quantity, received_on, notes, status, status_reason) ON public.lots TO authenticated;
GRANT UPDATE (lot_id, production_order_id, notes, status, status_reason) ON public.serial_numbers TO authenticated;

REVOKE ALL ON FUNCTION app.production_link_resolve(uuid, uuid, uuid, uuid, uuid, text), app.production_order_rules(), app.production_operation_rules(), app.lot_rules(),
  app.serial_number_rules(), app.inspection_production_links(), app.ncr_production_links() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.set_job_links(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.set_job_links(uuid, jsonb) TO authenticated;
