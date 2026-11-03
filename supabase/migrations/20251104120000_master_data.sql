-- Phase 2 / slice 2.1 — master data: units, customers, suppliers, parts and part revisions, plus the
-- transactional outbox (docs/phase-2-plan.md §2.1, §2.6).
--
-- Conventions (as Phase 1): tenant-owned tables carry organisation_id NOT NULL with composite
-- (id, organisation_id) keys for references; RLS on every table; reads for members, writes for
-- master_data.manage; no deletes (deactivate instead); column-level grants so organisation_id and
-- the bookkeeping columns cannot be changed; audit_changes trigger on everything quality-relevant.

-- ---------------------------------------------------------------------------
-- Units of measure: global, read-only catalogue. Results are entered in the characteristic's unit;
-- there are no conversions in Phase 2 (brief §6.4: never silently compare different units).
-- ---------------------------------------------------------------------------
CREATE TABLE public.units (
  code text PRIMARY KEY CHECK (code ~ '^\S{1,16}$'),
  name text NOT NULL,
  quantity_kind text NOT NULL CHECK (quantity_kind IN (
    'length', 'angle', 'mass', 'force', 'torque', 'pressure', 'temperature', 'time', 'ratio',
    'count', 'hardness', 'electrical', 'other')),
  sort_order integer NOT NULL DEFAULT 0
);
INSERT INTO public.units (code, name, quantity_kind, sort_order) VALUES
  ('mm', 'Millimetre', 'length', 10), ('µm', 'Micrometre', 'length', 11), ('m', 'Metre', 'length', 12),
  ('in', 'Inch', 'length', 13), ('thou', 'Thousandth of an inch', 'length', 14),
  ('deg', 'Degree', 'angle', 20), ('arcmin', 'Arcminute', 'angle', 21),
  ('g', 'Gram', 'mass', 30), ('kg', 'Kilogram', 'mass', 31),
  ('N', 'Newton', 'force', 40), ('kN', 'Kilonewton', 'force', 41),
  ('N·m', 'Newton metre', 'torque', 50),
  ('bar', 'Bar', 'pressure', 60), ('MPa', 'Megapascal', 'pressure', 61), ('psi', 'Pound per square inch', 'pressure', 62),
  ('°C', 'Degree Celsius', 'temperature', 70),
  ('s', 'Second', 'time', 80), ('min', 'Minute', 'time', 81),
  ('%', 'Percent', 'ratio', 90),
  ('count', 'Count', 'count', 100),
  ('HRC', 'Rockwell hardness C', 'hardness', 110), ('HV', 'Vickers hardness', 'hardness', 111),
  ('V', 'Volt', 'electrical', 120), ('A', 'Ampere', 'electrical', 121), ('Ω', 'Ohm', 'electrical', 122);

ALTER TABLE public.units ENABLE ROW LEVEL SECURITY;
CREATE POLICY units_select ON public.units FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.units FROM anon, authenticated;
GRANT SELECT ON public.units TO authenticated;

-- ---------------------------------------------------------------------------
-- Customers and suppliers
-- ---------------------------------------------------------------------------
CREATE TABLE public.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  code text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  display_name text CHECK (display_name IS NULL OR length(trim(display_name)) BETWEEN 1 AND 100),
  company_number text,
  vat_number text,
  notes text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT customers_org_code_key UNIQUE (organisation_id, code),
  CONSTRAINT customers_id_org_key UNIQUE (id, organisation_id)
);

CREATE TABLE public.suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  code text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  display_name text CHECK (display_name IS NULL OR length(trim(display_name)) BETWEEN 1 AND 100),
  company_number text,
  vat_number text,
  notes text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT suppliers_org_code_key UNIQUE (organisation_id, code),
  CONSTRAINT suppliers_id_org_key UNIQUE (id, organisation_id)
);

-- ---------------------------------------------------------------------------
-- Parts and revisions. Inspection plans and NCRs point at a revision.
-- ---------------------------------------------------------------------------
CREATE TABLE public.parts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  part_number text NOT NULL CHECK (part_number ~ '^\S(.{0,58}\S)?$'),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  description text,
  customer_id uuid,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT parts_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT parts_customer_fkey FOREIGN KEY (customer_id, organisation_id)
    REFERENCES public.customers (id, organisation_id)
);
-- Part numbers are unique per organisation regardless of letter case.
CREATE UNIQUE INDEX parts_org_part_number_key ON public.parts (organisation_id, upper(part_number));
CREATE INDEX parts_customer_idx ON public.parts (customer_id) WHERE customer_id IS NOT NULL;

CREATE TABLE public.part_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  part_id uuid NOT NULL,
  revision text NOT NULL CHECK (revision ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,9}$'),
  drawing_ref text,
  change_summary text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'released', 'superseded', 'obsolete')),
  released_at timestamptz,
  released_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT part_revisions_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT part_revisions_part_fkey FOREIGN KEY (part_id, organisation_id)
    REFERENCES public.parts (id, organisation_id) ON DELETE CASCADE,
  CONSTRAINT part_revisions_released_has_date CHECK (status IN ('draft', 'obsolete') OR released_at IS NOT NULL)
);
CREATE UNIQUE INDEX part_revisions_part_revision_key ON public.part_revisions (part_id, upper(revision));
-- At most one released revision per part.
CREATE UNIQUE INDEX part_revisions_one_released ON public.part_revisions (part_id) WHERE status = 'released';
CREATE INDEX part_revisions_organisation_idx ON public.part_revisions (organisation_id);

-- ---------------------------------------------------------------------------
-- Transactional outbox (decision Q3): events written in the same transaction as the change, by
-- SECURITY DEFINER trigger functions only. Nothing processes them yet (Phase 5).
-- ---------------------------------------------------------------------------
CREATE TABLE public.outbox_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type ~ '^[a-z_]+(\.[a-z_]+)+$'),
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id uuid,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX outbox_events_unprocessed_idx ON public.outbox_events (created_at) WHERE processed_at IS NULL;
CREATE INDEX outbox_events_organisation_idx ON public.outbox_events (organisation_id, created_at);

CREATE FUNCTION app.emit_event(
  p_organisation_id uuid, p_event_type text, p_entity_type text, p_entity_id uuid, p_payload jsonb
) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO public.outbox_events (organisation_id, event_type, entity_type, entity_id, payload, actor_user_id, correlation_id)
  VALUES (p_organisation_id, p_event_type, p_entity_type, p_entity_id,
          jsonb_build_object('v', 1) || coalesce(p_payload, '{}'::jsonb),
          auth.uid(), nullif(current_setting('app.correlation_id', true), ''))
$$;

-- ---------------------------------------------------------------------------
-- Revision lifecycle: draft → released → superseded → obsolete (draft → obsolete too).
-- Releasing supersedes the previously released revision of the part. Only drafts can be edited.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.part_revision_lifecycle() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  allowed boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Signed-in users create drafts; data migrations (no JWT) may load history as it was.
    IF auth.role() = 'authenticated' THEN
      IF NEW.status <> 'draft' THEN
        RAISE EXCEPTION 'New revisions start as draft' USING ERRCODE = 'QM003';
      END IF;
      NEW.released_at := NULL;
      NEW.released_by := NULL;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.part_id <> OLD.part_id THEN
    RAISE EXCEPTION 'A revision cannot move to another part' USING ERRCODE = 'QM003';
  END IF;
  IF OLD.status <> 'draft' AND (NEW.revision, NEW.drawing_ref, NEW.change_summary)
       IS DISTINCT FROM (OLD.revision, OLD.drawing_ref, OLD.change_summary) THEN
    RAISE EXCEPTION 'Revision % is % and can no longer be edited', OLD.revision, OLD.status USING ERRCODE = 'QM003';
  END IF;

  IF NEW.status <> OLD.status THEN
    allowed := (OLD.status, NEW.status) IN (('draft', 'released'), ('draft', 'obsolete'),
                                             ('released', 'superseded'), ('released', 'obsolete'),
                                             ('superseded', 'obsolete'));
    IF NOT allowed THEN
      RAISE EXCEPTION 'A % revision cannot become %', OLD.status, NEW.status USING ERRCODE = 'QM003';
    END IF;
    IF NEW.status = 'released' THEN
      NEW.released_at := now();
      NEW.released_by := auth.uid();
      -- Supersede the current released revision first (one released revision per part).
      UPDATE public.part_revisions SET status = 'superseded'
      WHERE part_id = NEW.part_id AND status = 'released' AND id <> NEW.id;
    END IF;
  ELSIF NEW.released_at IS DISTINCT FROM OLD.released_at OR NEW.released_by IS DISTINCT FROM OLD.released_by THEN
    RAISE EXCEPTION 'Release details are set by the system' USING ERRCODE = 'QM003';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION app.part_revision_events() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.status = 'released' AND OLD.status = 'draft' THEN
    PERFORM app.emit_event(NEW.organisation_id, 'part.revision.released', 'part_revision', NEW.id,
      jsonb_build_object('part_id', NEW.part_id, 'revision', NEW.revision,
        'part_number', (SELECT part_number FROM public.parts WHERE id = NEW.part_id)));
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER part_revisions_lifecycle BEFORE INSERT OR UPDATE ON public.part_revisions
  FOR EACH ROW EXECUTE FUNCTION app.part_revision_lifecycle();
CREATE TRIGGER part_revisions_events AFTER UPDATE OF status ON public.part_revisions
  FOR EACH ROW EXECUTE FUNCTION app.part_revision_events();

-- Bookkeeping: rows created by signed-in users get server-set created/updated stamps (a data
-- migration without a JWT keeps the history it loads).
CREATE FUNCTION app.stamp_created() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF auth.role() = 'authenticated' THEN
    NEW.created_at := now();
    NEW.created_by := auth.uid();
    NEW.updated_at := now();
    NEW.updated_by := NULL;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.stamp_created() FROM PUBLIC;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['customers', 'suppliers', 'parts', 'part_revisions'] LOOP
    EXECUTE format('CREATE TRIGGER %1$s_stamp BEFORE INSERT ON public.%1$I FOR EACH ROW EXECUTE FUNCTION app.stamp_created()', t);
  END LOOP;
END $$;

CREATE TRIGGER customers_touch BEFORE UPDATE ON public.customers FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER suppliers_touch BEFORE UPDATE ON public.suppliers FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER parts_touch BEFORE UPDATE ON public.parts FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER part_revisions_touch BEFORE UPDATE ON public.part_revisions FOR EACH ROW EXECUTE FUNCTION app.touch_updated();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['customers', 'suppliers', 'parts', 'part_revisions'] LOOP
    EXECUTE format('CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.%I '
                   'FOR EACH ROW EXECUTE FUNCTION audit.record_change(''organisation_id'')', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Row level security and privileges
-- ---------------------------------------------------------------------------
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.part_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outbox_events ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['customers', 'suppliers', 'parts', 'part_revisions'] LOOP
    EXECUTE format('CREATE POLICY %1$s_select ON public.%1$I FOR SELECT TO authenticated USING (app.is_member(organisation_id))', t);
    EXECUTE format('CREATE POLICY %1$s_insert ON public.%1$I FOR INSERT TO authenticated '
                   'WITH CHECK (app.has_permission(organisation_id, ''master_data.manage''))', t);
    EXECUTE format('CREATE POLICY %1$s_update ON public.%1$I FOR UPDATE TO authenticated '
                   'USING (app.has_permission(organisation_id, ''master_data.manage'')) '
                   'WITH CHECK (app.has_permission(organisation_id, ''master_data.manage''))', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
  END LOOP;
END $$;

-- INSERT is granted on the whole table (an INSERT naming a column with DEFAULT still needs the
-- privilege); app.stamp_created() fixes the bookkeeping columns so they cannot be forged.
-- UPDATE is column-level: organisation_id, ids and bookkeeping columns cannot be changed.
GRANT INSERT ON public.customers, public.suppliers, public.parts, public.part_revisions TO authenticated;
GRANT UPDATE (code, name, display_name, company_number, vat_number, notes, active)
  ON public.customers, public.suppliers TO authenticated;
GRANT UPDATE (part_number, name, description, customer_id, active) ON public.parts TO authenticated;
GRANT UPDATE (revision, drawing_ref, change_summary, status) ON public.part_revisions TO authenticated;

-- Outbox: readable by people who may read the audit trail; never written directly.
CREATE POLICY outbox_events_select ON public.outbox_events FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'audit.read'));
REVOKE ALL ON public.outbox_events FROM anon, authenticated;
GRANT SELECT ON public.outbox_events TO authenticated;

REVOKE ALL ON FUNCTION app.emit_event(uuid, text, text, uuid, jsonb), app.part_revision_lifecycle(),
  app.part_revision_events() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Legacy data (decision Q1): copy "Customers", "Suppliers" and "Part" keeping their ids, so the
-- legacy NCRs can be linked in slice 2.4. Each migrated part gets released revision "A".
-- The legacy tables stay until the screens have moved (then dropped in a later migration).
-- ---------------------------------------------------------------------------
INSERT INTO public.customers (id, organisation_id, code, name, display_name, company_number, vat_number, notes, active, created_at, created_by)
SELECT c.id, c.organisation_id,
       'C' || lpad(row_number() OVER (PARTITION BY c.organisation_id ORDER BY c.created_at NULLS LAST, c.id)::text, 4, '0'),
       coalesce(nullif(trim(c.name), ''), nullif(trim(c.display_name), ''), 'Unnamed customer'),
       nullif(trim(c.display_name), ''), c.company_number, c.vat_number, c.notes,
       coalesce(c.active, true), coalesce(c.created_at, now()), NULL
FROM public."Customers" c;

INSERT INTO public.suppliers (id, organisation_id, code, name, display_name, company_number, vat_number, notes, active, created_at, created_by)
SELECT s.id, s.organisation_id,
       CASE WHEN upper(s.supplier_id) ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'
                 AND count(*) OVER (PARTITION BY s.organisation_id, upper(s.supplier_id)) = 1
            THEN upper(s.supplier_id)
            ELSE 'S' || lpad(row_number() OVER (PARTITION BY s.organisation_id ORDER BY s.created_at, s.id)::text, 4, '0') END,
       coalesce(nullif(trim(s.name), ''), nullif(trim(s.display_name), ''), 'Unnamed supplier'),
       nullif(trim(s.display_name), ''), s.company_number, s.vat_number, s.notes,
       coalesce(s.active, true), s.created_at, NULL
FROM public."Suppliers" s;

WITH numbered AS (
  SELECT p.*, coalesce(nullif(trim(p.part_number), ''), 'UNNUMBERED-' || left(p.id::text, 8)) AS pn,
         row_number() OVER (PARTITION BY p.organisation_id, upper(coalesce(nullif(trim(p.part_number), ''), p.id::text))
                            ORDER BY p.created_at, p.id) AS dup
  FROM public."Part" p
)
INSERT INTO public.parts (id, organisation_id, part_number, name, description, created_at, created_by)
SELECT n.id, n.organisation_id,
       CASE WHEN n.dup = 1 THEN n.pn ELSE n.pn || '-' || n.dup END,
       coalesce(nullif(trim(n.name), ''), n.pn), n.description, n.created_at, NULL
FROM numbered n;

INSERT INTO public.part_revisions (organisation_id, part_id, revision, change_summary, status, released_at, created_at, created_by)
SELECT p.organisation_id, p.id, 'A', 'Migrated from the previous parts list', 'released', p.created_at, p.created_at, NULL
FROM public.parts p
WHERE p.id IN (SELECT id FROM public."Part");
