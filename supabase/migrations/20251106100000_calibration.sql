-- Calibration (brought forward from Phase 4; docs/calibration-plan.md): gauge types with template
-- calibration characteristics, gauges (measuring equipment), each gauge's own characteristics,
-- calibration records with as-found / as-left readings, certificates, and the effect of a result on
-- the gauge (last calibrated, next due, quarantine on failure).
--
-- Conventions as Phase 2: organisation_id NOT NULL with composite (id, organisation_id) keys; RLS on
-- every table; site-scoped permissions through the gauge's site; table-level INSERT stamped by
-- app.stamp_created(); column-level UPDATE; no DELETE (deactivate or soft delete with a reason);
-- audit_changes on everything; outbox events from SECURITY DEFINER triggers only.

-- ---------------------------------------------------------------------------
-- Permissions, granted to the system roles (templates and every organisation's copies)
-- ---------------------------------------------------------------------------
INSERT INTO public.permissions (code, description) VALUES
  ('calibration.read',   'View gauges and calibration records'),
  ('calibration.manage', 'Create and edit gauges, gauge types and calibration characteristics'),
  ('calibration.record', 'Record calibrations and attach certificates');

WITH grants(key, perms) AS (VALUES
  ('owner',            ARRAY['calibration.read', 'calibration.manage', 'calibration.record']),
  ('admin',            ARRAY['calibration.read', 'calibration.manage', 'calibration.record']),
  ('quality_manager',  ARRAY['calibration.read', 'calibration.manage', 'calibration.record']),
  ('quality_engineer', ARRAY['calibration.read', 'calibration.manage', 'calibration.record']),
  ('inspector',        ARRAY['calibration.read', 'calibration.record']),
  ('viewer',           ARRAY['calibration.read'])
)
INSERT INTO public.role_permissions (role_id, permission_code)
SELECT r.id, unnest(g.perms) FROM public.roles r JOIN grants g ON g.key = r.key WHERE r.is_system
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Gauge types and their template characteristics (Settings → Calibration)
-- ---------------------------------------------------------------------------
CREATE TABLE public.gauge_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  description text CHECK (description IS NULL OR length(description) <= 1000),
  interval_value integer NOT NULL DEFAULT 12 CHECK (interval_value BETWEEN 1 AND 1000),
  interval_unit text NOT NULL DEFAULT 'months' CHECK (interval_unit IN ('days', 'weeks', 'months', 'years')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT gauge_types_id_org_key UNIQUE (id, organisation_id)
);
CREATE UNIQUE INDEX gauge_types_name_key ON public.gauge_types (organisation_id, upper(name));

-- A characteristic is checked at every calibration: a nominal value with a tolerance either side
-- (limits nominal − tolerance_minus … nominal + tolerance_plus), in one unit.
CREATE TABLE public.gauge_type_characteristics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  gauge_type_id uuid NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  nominal numeric NOT NULL,
  tolerance_minus numeric NOT NULL CHECK (tolerance_minus >= 0),
  tolerance_plus numeric NOT NULL CHECK (tolerance_plus >= 0),
  unit_code text NOT NULL REFERENCES public.units (code),
  method text CHECK (method IS NULL OR length(method) <= 500),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT gauge_type_characteristics_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT gauge_type_characteristics_type_fkey FOREIGN KEY (gauge_type_id, organisation_id)
    REFERENCES public.gauge_types (id, organisation_id)
);
CREATE INDEX gauge_type_characteristics_type_idx ON public.gauge_type_characteristics (gauge_type_id);

-- ---------------------------------------------------------------------------
-- Gauges
-- ---------------------------------------------------------------------------
CREATE TABLE public.gauges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  asset_number text NOT NULL CHECK (asset_number ~ '^\S(.{0,38}\S)?$'),
  description text NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 200),
  gauge_type_id uuid,
  manufacturer text CHECK (manufacturer IS NULL OR length(manufacturer) <= 100),
  model text CHECK (model IS NULL OR length(model) <= 100),
  serial_number text CHECK (serial_number IS NULL OR length(serial_number) <= 100),
  site_id uuid,
  department_id uuid,
  location text CHECK (location IS NULL OR length(location) <= 200),
  custodian_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  range_min numeric,
  range_max numeric,
  unit_code text REFERENCES public.units (code),
  resolution numeric CHECK (resolution IS NULL OR resolution > 0),
  calibration_source text NOT NULL DEFAULT 'internal' CHECK (calibration_source IN ('internal', 'external')),
  supplier_id uuid,
  interval_value integer CHECK (interval_value BETWEEN 1 AND 1000),
  interval_unit text CHECK (interval_unit IN ('days', 'weeks', 'months', 'years')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'in_calibration', 'quarantined', 'out_of_service', 'retired', 'lost')),
  status_reason text CHECK (status_reason IS NULL OR length(status_reason) <= 500),
  status_changed_at timestamptz,
  last_calibrated_on date,
  next_due_on date,
  commissioned_on date,
  notes text CHECK (notes IS NULL OR length(notes) <= 5000),
  deleted_at timestamptz,
  deleted_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  delete_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT gauges_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT gauges_type_fkey FOREIGN KEY (gauge_type_id, organisation_id) REFERENCES public.gauge_types (id, organisation_id),
  CONSTRAINT gauges_site_fkey FOREIGN KEY (site_id, organisation_id) REFERENCES public.sites (id, organisation_id),
  CONSTRAINT gauges_department_fkey FOREIGN KEY (department_id, organisation_id) REFERENCES public.departments (id, organisation_id),
  CONSTRAINT gauges_supplier_fkey FOREIGN KEY (supplier_id, organisation_id) REFERENCES public.suppliers (id, organisation_id),
  CONSTRAINT gauges_range_order CHECK (range_min IS NULL OR range_max IS NULL OR range_max >= range_min),
  CONSTRAINT gauges_interval_complete CHECK ((interval_value IS NULL) = (interval_unit IS NULL)),
  CONSTRAINT gauges_deleted_has_reason CHECK (deleted_at IS NULL OR length(trim(delete_reason)) > 0)
);
-- Asset numbers are unique per organisation regardless of letter case.
CREATE UNIQUE INDEX gauges_org_asset_number_key ON public.gauges (organisation_id, upper(asset_number));
CREATE INDEX gauges_due_idx ON public.gauges (organisation_id, next_due_on) WHERE deleted_at IS NULL;
CREATE INDEX gauges_type_idx ON public.gauges (gauge_type_id) WHERE gauge_type_id IS NOT NULL;

CREATE TABLE public.gauge_characteristics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  gauge_id uuid NOT NULL,
  template_id uuid,
  sort_order integer NOT NULL DEFAULT 0,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  nominal numeric NOT NULL,
  tolerance_minus numeric NOT NULL CHECK (tolerance_minus >= 0),
  tolerance_plus numeric NOT NULL CHECK (tolerance_plus >= 0),
  unit_code text NOT NULL REFERENCES public.units (code),
  method text CHECK (method IS NULL OR length(method) <= 500),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT gauge_characteristics_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT gauge_characteristics_gauge_fkey FOREIGN KEY (gauge_id, organisation_id) REFERENCES public.gauges (id, organisation_id),
  CONSTRAINT gauge_characteristics_template_fkey FOREIGN KEY (template_id, organisation_id)
    REFERENCES public.gauge_type_characteristics (id, organisation_id)
);
CREATE INDEX gauge_characteristics_gauge_idx ON public.gauge_characteristics (gauge_id);

-- ---------------------------------------------------------------------------
-- Calibration records, readings and certificates
-- ---------------------------------------------------------------------------
CREATE TABLE public.calibrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  gauge_id uuid NOT NULL,
  reference text NOT NULL CHECK (length(reference) BETWEEN 1 AND 40),
  calibrated_on date NOT NULL DEFAULT current_date,
  performed_by text NOT NULL DEFAULT 'internal' CHECK (performed_by IN ('internal', 'external')),
  technician_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  supplier_id uuid,
  certificate_number text CHECK (certificate_number IS NULL OR length(certificate_number) <= 100),
  procedure_ref text CHECK (procedure_ref IS NULL OR length(procedure_ref) <= 200),
  reference_standards text CHECK (reference_standards IS NULL OR length(reference_standards) <= 1000),
  temperature_c numeric CHECK (temperature_c IS NULL OR temperature_c BETWEEN -50 AND 100),
  humidity_pct numeric CHECK (humidity_pct IS NULL OR humidity_pct BETWEEN 0 AND 100),
  -- pass: every as-found reading in tolerance; adjusted: out as found, in tolerance as left;
  -- fail: still out of tolerance. Worked out from the readings when there are any.
  outcome text NOT NULL CHECK (outcome IN ('pass', 'adjusted', 'fail')),
  next_due_on date,
  notes text CHECK (notes IS NULL OR length(notes) <= 5000),
  nonconformance_id uuid,
  deleted_at timestamptz,
  deleted_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  delete_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT calibrations_org_reference_key UNIQUE (organisation_id, reference),
  CONSTRAINT calibrations_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT calibrations_gauge_fkey FOREIGN KEY (gauge_id, organisation_id) REFERENCES public.gauges (id, organisation_id),
  CONSTRAINT calibrations_supplier_fkey FOREIGN KEY (supplier_id, organisation_id) REFERENCES public.suppliers (id, organisation_id),
  CONSTRAINT calibrations_ncr_fkey FOREIGN KEY (nonconformance_id, organisation_id) REFERENCES public.nonconformances (id, organisation_id),
  CONSTRAINT calibrations_due_after_calibration CHECK (next_due_on IS NULL OR next_due_on >= calibrated_on),
  CONSTRAINT calibrations_deleted_has_reason CHECK (deleted_at IS NULL OR length(trim(delete_reason)) > 0)
);
CREATE INDEX calibrations_gauge_idx ON public.calibrations (gauge_id, calibrated_on DESC);
CREATE INDEX calibrations_org_date_idx ON public.calibrations (organisation_id, calibrated_on DESC);

-- One reading per characteristic. The characteristic's name, nominal, tolerances and unit are
-- copied onto the reading, so later changes to the characteristic do not rewrite history.
CREATE TABLE public.calibration_readings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  calibration_id uuid NOT NULL,
  characteristic_id uuid,
  sort_order integer NOT NULL DEFAULT 0,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  nominal numeric NOT NULL,
  tolerance_minus numeric NOT NULL CHECK (tolerance_minus >= 0),
  tolerance_plus numeric NOT NULL CHECK (tolerance_plus >= 0),
  unit_code text NOT NULL REFERENCES public.units (code),
  as_found numeric NOT NULL,
  as_left numeric,
  -- Worked out by app.calibration_reading_rules():
  as_found_ok boolean NOT NULL DEFAULT false,
  as_left_ok boolean,
  notes text CHECK (notes IS NULL OR length(notes) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT calibration_readings_calibration_fkey FOREIGN KEY (calibration_id, organisation_id)
    REFERENCES public.calibrations (id, organisation_id),
  CONSTRAINT calibration_readings_characteristic_fkey FOREIGN KEY (characteristic_id, organisation_id)
    REFERENCES public.gauge_characteristics (id, organisation_id)
);
CREATE INDEX calibration_readings_calibration_idx ON public.calibration_readings (calibration_id);
CREATE UNIQUE INDEX calibration_readings_one_per_characteristic ON public.calibration_readings (calibration_id, characteristic_id)
  WHERE characteristic_id IS NOT NULL;

CREATE TABLE public.calibration_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  calibration_id uuid NOT NULL,
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
  CONSTRAINT calibration_attachments_calibration_fkey FOREIGN KEY (calibration_id, organisation_id)
    REFERENCES public.calibrations (id, organisation_id),
  CONSTRAINT calibration_attachments_path_in_folder CHECK (
    storage_path LIKE organisation_id::text || '/calibration/' || calibration_id::text || '/%'
    AND storage_path NOT LIKE '%..%'),
  CONSTRAINT calibration_attachments_deleted_has_reason CHECK (deleted_at IS NULL OR length(trim(delete_reason)) > 0)
);
CREATE INDEX calibration_attachments_calibration_idx ON public.calibration_attachments (calibration_id);

-- Per-organisation, per-year counters for calibration references (CAL-YY-NNN). Not reachable by users.
CREATE TABLE app.calibration_counters (
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  year integer NOT NULL,
  last_value integer NOT NULL DEFAULT 0,
  PRIMARY KEY (organisation_id, year)
);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
-- The site of a gauge / of a calibration's gauge, for policies on child records.
CREATE FUNCTION app.gauge_site(p_gauge_id uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT site_id FROM public.gauges WHERE id = p_gauge_id
$$;

CREATE FUNCTION app.calibration_site(p_calibration_id uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT g.site_id FROM public.calibrations c JOIN public.gauges g ON g.id = c.gauge_id WHERE c.id = p_calibration_id
$$;

CREATE FUNCTION app.add_interval(p_date date, p_value integer, p_unit text) RETURNS date
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT (p_date + make_interval(
    days => CASE p_unit WHEN 'days' THEN p_value WHEN 'weeks' THEN p_value * 7 ELSE 0 END,
    months => CASE p_unit WHEN 'months' THEN p_value WHEN 'years' THEN p_value * 12 ELSE 0 END))::date
$$;

CREATE FUNCTION app.next_calibration_reference(p_organisation_id uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_year integer := extract(year FROM current_date)::integer;
  v_n integer;
  v_ref text;
BEGIN
  LOOP
    INSERT INTO app.calibration_counters AS c (organisation_id, year, last_value) VALUES (p_organisation_id, v_year, 1)
    ON CONFLICT (organisation_id, year) DO UPDATE SET last_value = c.last_value + 1
    RETURNING last_value INTO v_n;
    v_ref := 'CAL-' || to_char(make_date(v_year, 1, 1), 'YY') || '-' || lpad(v_n::text, 3, '0');
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.calibrations WHERE organisation_id = p_organisation_id AND reference = v_ref);
  END LOOP;
  RETURN v_ref;
END $$;

-- Changes to a gauge's children need a gauge that is not deleted.
CREATE FUNCTION app.assert_gauge_editable(p_gauge_id uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF (SELECT deleted_at FROM public.gauges WHERE id = p_gauge_id) IS NOT NULL THEN
    RAISE EXCEPTION 'This gauge is deleted; restore it first' USING ERRCODE = 'QM006';
  END IF;
END $$;

-- Changes to a calibration's children need a calibration (and gauge) that is not deleted.
CREATE FUNCTION app.assert_calibration_editable(p_calibration_id uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  c record;
BEGIN
  SELECT deleted_at, gauge_id INTO c FROM public.calibrations WHERE id = p_calibration_id;
  IF c.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'This calibration record is deleted; restore it first' USING ERRCODE = 'QM006';
  END IF;
  PERFORM app.assert_gauge_editable(c.gauge_id);
END $$;

-- Soft delete / restore bookkeeping shared by the calibration tables (signed-in users only).
CREATE FUNCTION app.soft_delete_stamp(p_new_deleted_at timestamptz, p_old_deleted_at timestamptz, p_reason text, p_what text)
RETURNS timestamptz
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
BEGIN
  IF p_new_deleted_at IS NOT NULL AND p_old_deleted_at IS NULL THEN
    IF coalesce(trim(p_reason), '') = '' THEN
      RAISE EXCEPTION 'Give a reason for deleting this %', p_what USING ERRCODE = 'QM006';
    END IF;
    RETURN now();
  END IF;
  RETURN p_new_deleted_at;
END $$;

-- ---------------------------------------------------------------------------
-- Rules
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.gauge_type_characteristic_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.gauge_type_id <> OLD.gauge_type_id THEN
    RAISE EXCEPTION 'A characteristic cannot move to another gauge type' USING ERRCODE = 'QM006';
  END IF;
  RETURN NEW;
END $$;

/*
 * Gauges (signed-in users; a data migration may load history as it was):
 * - the interval defaults to the gauge type's (or 12 months);
 * - the department must be at the gauge's site;
 * - a status change stamps status_changed_at;
 * - soft delete needs a reason, on its own; deleted gauges are locked until restored.
 */
CREATE FUNCTION app.gauge_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  t record;
BEGIN
  IF NEW.department_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.departments d WHERE d.id = NEW.department_id AND d.site_id IS NOT DISTINCT FROM NEW.site_id) THEN
    RAISE EXCEPTION 'The department is not at the selected site' USING ERRCODE = 'QM006';
  END IF;
  IF NEW.interval_value IS NULL THEN
    SELECT interval_value, interval_unit INTO t FROM public.gauge_types WHERE id = NEW.gauge_type_id;
    NEW.interval_value := coalesce(t.interval_value, 12);
    NEW.interval_unit := coalesce(t.interval_unit, 'months');
  END IF;

  IF coalesce(auth.role(), '') <> 'authenticated' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.deleted_at := NULL; NEW.deleted_by := NULL; NEW.delete_reason := NULL;
    NEW.status_changed_at := now();
    RETURN NEW;
  END IF;

  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    NEW.deleted_at := app.soft_delete_stamp(NEW.deleted_at, OLD.deleted_at, NEW.delete_reason, 'gauge');
    IF NEW.deleted_at IS NULL THEN
      NEW.deleted_by := NULL;
      NEW.delete_reason := NULL;
    ELSE
      NEW.deleted_by := auth.uid();
    END IF;
    IF (to_jsonb(NEW) - ARRAY['deleted_at', 'deleted_by', 'delete_reason', 'updated_at', 'updated_by'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['deleted_at', 'deleted_by', 'delete_reason', 'updated_at', 'updated_by']) THEN
      RAISE EXCEPTION 'Delete or restore on its own, without other changes' USING ERRCODE = 'QM006';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'This gauge is deleted; restore it first' USING ERRCODE = 'QM006';
  END IF;
  IF NEW.delete_reason IS DISTINCT FROM OLD.delete_reason OR NEW.deleted_by IS DISTINCT FROM OLD.deleted_by THEN
    RAISE EXCEPTION 'Deletion details are set by the system' USING ERRCODE = 'QM006';
  END IF;
  IF NEW.status <> OLD.status THEN
    NEW.status_changed_at := now();
  ELSIF NEW.status_changed_at IS DISTINCT FROM OLD.status_changed_at THEN
    NEW.status_changed_at := OLD.status_changed_at;
  END IF;
  RETURN NEW;
END $$;

-- A new gauge of a type gets copies of the type's active template characteristics.
CREATE FUNCTION app.gauge_copy_characteristics() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.gauge_type_id IS NOT NULL THEN
    INSERT INTO public.gauge_characteristics (organisation_id, gauge_id, template_id, sort_order, name, nominal,
                                              tolerance_minus, tolerance_plus, unit_code, method)
    SELECT NEW.organisation_id, NEW.id, t.id, t.sort_order, t.name, t.nominal, t.tolerance_minus, t.tolerance_plus, t.unit_code, t.method
    FROM public.gauge_type_characteristics t
    WHERE t.gauge_type_id = NEW.gauge_type_id AND t.active;
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION app.gauge_characteristic_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.gauge_id <> OLD.gauge_id THEN
    RAISE EXCEPTION 'A characteristic cannot move to another gauge' USING ERRCODE = 'QM006';
  END IF;
  IF coalesce(auth.role(), '') = 'authenticated' THEN
    PERFORM app.assert_gauge_editable(NEW.gauge_id);
  END IF;
  RETURN NEW;
END $$;

-- Outcome of a calibration from its readings (NULL when it has none).
CREATE FUNCTION app.calibration_outcome_from_readings(p_calibration_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE
           WHEN count(*) = 0 THEN NULL
           WHEN bool_and(as_found_ok) THEN 'pass'
           WHEN bool_and(as_found_ok OR coalesce(as_left_ok, false)) THEN 'adjusted'
           ELSE 'fail'
         END
  FROM public.calibration_readings WHERE calibration_id = p_calibration_id
$$;

/*
 * Calibration records (signed-in users):
 * - insert: reference generated; not dated in the future; the gauge must not be deleted;
 *   next due defaults to the calibration date plus the gauge's interval;
 * - with readings, the outcome is worked out from them (set by the readings trigger);
 * - soft delete needs a reason, on its own; deleted records are locked until restored.
 */
CREATE FUNCTION app.calibration_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  g record;
  computed text;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.gauge_id <> OLD.gauge_id OR NEW.reference <> OLD.reference) THEN
    RAISE EXCEPTION 'The gauge and reference of a calibration cannot change' USING ERRCODE = 'QM006';
  END IF;
  SELECT interval_value, interval_unit INTO g FROM public.gauges WHERE id = NEW.gauge_id;
  IF NEW.next_due_on IS NULL THEN
    NEW.next_due_on := app.add_interval(NEW.calibrated_on, coalesce(g.interval_value, 12), coalesce(g.interval_unit, 'months'));
  END IF;
  IF TG_OP = 'UPDATE' THEN
    computed := app.calibration_outcome_from_readings(NEW.id);
    IF computed IS NOT NULL THEN
      NEW.outcome := computed;
    END IF;
  END IF;

  IF coalesce(auth.role(), '') <> 'authenticated' THEN
    RETURN NEW;
  END IF;

  IF NEW.calibrated_on > current_date THEN
    RAISE EXCEPTION 'A calibration cannot be dated in the future' USING ERRCODE = 'QM006';
  END IF;

  IF TG_OP = 'INSERT' THEN
    PERFORM app.assert_gauge_editable(NEW.gauge_id);
    NEW.reference := app.next_calibration_reference(NEW.organisation_id);
    NEW.deleted_at := NULL; NEW.deleted_by := NULL; NEW.delete_reason := NULL;
    RETURN NEW;
  END IF;

  PERFORM app.assert_gauge_editable(NEW.gauge_id);
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    NEW.deleted_at := app.soft_delete_stamp(NEW.deleted_at, OLD.deleted_at, NEW.delete_reason, 'calibration record');
    IF NEW.deleted_at IS NULL THEN
      NEW.deleted_by := NULL;
      NEW.delete_reason := NULL;
    ELSE
      NEW.deleted_by := auth.uid();
    END IF;
    IF (to_jsonb(NEW) - ARRAY['deleted_at', 'deleted_by', 'delete_reason', 'updated_at', 'updated_by'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['deleted_at', 'deleted_by', 'delete_reason', 'updated_at', 'updated_by']) THEN
      RAISE EXCEPTION 'Delete or restore on its own, without other changes' USING ERRCODE = 'QM006';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'This calibration record is deleted; restore it first' USING ERRCODE = 'QM006';
  END IF;
  IF NEW.delete_reason IS DISTINCT FROM OLD.delete_reason OR NEW.deleted_by IS DISTINCT FROM OLD.deleted_by THEN
    RAISE EXCEPTION 'Deletion details are set by the system' USING ERRCODE = 'QM006';
  END IF;
  RETURN NEW;
END $$;

/*
 * After a calibration changes, the gauge follows its latest (not deleted) calibration: last
 * calibrated and next due dates, and its status — a failed calibration quarantines an active or
 * in-calibration gauge; a passed (or adjusted) one returns a quarantined or in-calibration gauge
 * to active. Gauges that are out of service, retired or lost keep their status.
 *
 * Runs as a deferred constraint trigger, so a record and its readings saved in one transaction
 * are judged once, on their final outcome (the API flushes it with SET CONSTRAINTS … IMMEDIATE
 * before reading the result back).
 */
CREATE FUNCTION app.calibration_after_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  cur record;
  latest record;
  g record;
  new_status text;
  new_reason text;
  later_edit boolean;
BEGIN
  SELECT * INTO cur FROM public.calibrations WHERE id = NEW.id;
  SELECT * INTO g FROM public.gauges WHERE id = NEW.gauge_id;
  SELECT c.reference, c.calibrated_on, c.next_due_on, c.outcome INTO latest
  FROM public.calibrations c
  WHERE c.gauge_id = NEW.gauge_id AND c.deleted_at IS NULL
  ORDER BY c.calibrated_on DESC, c.created_at DESC, c.reference DESC
  LIMIT 1;

  new_status := g.status;
  new_reason := g.status_reason;
  IF latest.reference IS NOT NULL THEN
    IF latest.outcome = 'fail' AND g.status IN ('active', 'in_calibration') THEN
      new_status := 'quarantined';
      new_reason := 'Failed calibration ' || latest.reference;
    ELSIF latest.outcome IN ('pass', 'adjusted') AND g.status IN ('quarantined', 'in_calibration') THEN
      new_status := 'active';
      new_reason := NULL;
    END IF;
  END IF;

  IF (g.last_calibrated_on, g.next_due_on, g.status, g.status_reason)
     IS DISTINCT FROM (latest.calibrated_on, coalesce(latest.next_due_on, g.next_due_on), new_status, new_reason) THEN
    UPDATE public.gauges
    SET last_calibrated_on = latest.calibrated_on,
        next_due_on = coalesce(latest.next_due_on, g.next_due_on),
        status = new_status,
        status_reason = new_reason
    WHERE id = NEW.gauge_id;
  END IF;

  IF auth.role() = 'authenticated' THEN
    -- Changes in the transaction that created the record are part of recording it.
    later_edit := cur.created_at <> now();
    IF TG_OP = 'INSERT' THEN
      PERFORM app.emit_event(NEW.organisation_id, 'calibration.recorded', 'calibration', NEW.id,
        jsonb_build_object('reference', cur.reference, 'gauge_id', NEW.gauge_id, 'asset_number', g.asset_number,
                           'calibrated_on', cur.calibrated_on, 'outcome', cur.outcome));
    ELSIF later_edit AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
      PERFORM app.emit_event(NEW.organisation_id, CASE WHEN NEW.deleted_at IS NULL THEN 'calibration.restored' ELSE 'calibration.deleted' END,
        'calibration', NEW.id, jsonb_build_object('reference', NEW.reference, 'gauge_id', NEW.gauge_id, 'reason', NEW.delete_reason));
    ELSIF later_edit AND NEW.outcome <> OLD.outcome THEN
      PERFORM app.emit_event(NEW.organisation_id, 'calibration.outcome_changed', 'calibration', NEW.id,
        jsonb_build_object('reference', NEW.reference, 'gauge_id', NEW.gauge_id, 'from', OLD.outcome, 'to', NEW.outcome));
    END IF;
    IF new_status IS DISTINCT FROM g.status THEN
      PERFORM app.emit_event(NEW.organisation_id, 'gauge.status_changed', 'gauge', NEW.gauge_id,
        jsonb_build_object('asset_number', g.asset_number, 'from', g.status, 'to', new_status, 'reason', new_reason));
    END IF;
  END IF;
  RETURN NULL;
END $$;

-- Readings: copy the characteristic, work out pass/fail, keep the calibration's outcome current.
CREATE FUNCTION app.calibration_reading_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  ch record;
  lo numeric;
  hi numeric;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.calibration_id <> OLD.calibration_id OR NEW.characteristic_id IS DISTINCT FROM OLD.characteristic_id) THEN
    RAISE EXCEPTION 'A reading cannot move' USING ERRCODE = 'QM006';
  END IF;
  IF NEW.characteristic_id IS NOT NULL THEN
    SELECT k.* INTO ch FROM public.gauge_characteristics k
    JOIN public.calibrations c ON c.gauge_id = k.gauge_id AND c.id = NEW.calibration_id
    WHERE k.id = NEW.characteristic_id;
    IF ch.id IS NULL THEN
      RAISE EXCEPTION 'The characteristic does not belong to this gauge' USING ERRCODE = 'QM006';
    END IF;
    IF TG_OP = 'INSERT' THEN
      NEW.name := ch.name; NEW.nominal := ch.nominal; NEW.tolerance_minus := ch.tolerance_minus;
      NEW.tolerance_plus := ch.tolerance_plus; NEW.unit_code := ch.unit_code;
      NEW.sort_order := ch.sort_order;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.name, NEW.nominal, NEW.tolerance_minus, NEW.tolerance_plus, NEW.unit_code)
       IS DISTINCT FROM (OLD.name, OLD.nominal, OLD.tolerance_minus, OLD.tolerance_plus, OLD.unit_code)
     AND NEW.characteristic_id IS NOT NULL THEN
    RAISE EXCEPTION 'The limits of a reading come from its characteristic' USING ERRCODE = 'QM006';
  END IF;
  IF coalesce(auth.role(), '') = 'authenticated' THEN
    PERFORM app.assert_calibration_editable(NEW.calibration_id);
  END IF;
  lo := NEW.nominal - NEW.tolerance_minus;
  hi := NEW.nominal + NEW.tolerance_plus;
  NEW.as_found_ok := NEW.as_found BETWEEN lo AND hi;
  NEW.as_left_ok := CASE WHEN NEW.as_left IS NULL THEN NULL ELSE NEW.as_left BETWEEN lo AND hi END;
  RETURN NEW;
END $$;

CREATE FUNCTION app.calibration_reading_after() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  computed text := app.calibration_outcome_from_readings(NEW.calibration_id);
BEGIN
  UPDATE public.calibrations SET outcome = computed
  WHERE id = NEW.calibration_id AND outcome IS DISTINCT FROM computed;
  RETURN NULL;
END $$;

CREATE FUNCTION app.calibration_attachment_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.calibration_id <> OLD.calibration_id OR NEW.storage_path <> OLD.storage_path) THEN
    RAISE EXCEPTION 'An attachment cannot move' USING ERRCODE = 'QM006';
  END IF;
  IF coalesce(auth.role(), '') <> 'authenticated' THEN
    RETURN NEW;
  END IF;
  PERFORM app.assert_calibration_editable(NEW.calibration_id);
  IF TG_OP = 'INSERT' THEN
    NEW.deleted_at := NULL; NEW.deleted_by := NULL; NEW.delete_reason := NULL;
    RETURN NEW;
  END IF;
  IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'This file is removed' USING ERRCODE = 'QM006';
  END IF;
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    NEW.deleted_at := app.soft_delete_stamp(NEW.deleted_at, OLD.deleted_at, NEW.delete_reason, 'file');
    NEW.deleted_by := auth.uid();
  ELSIF NEW.deleted_at IS NULL AND OLD.deleted_at IS NOT NULL THEN
    NEW.deleted_by := NULL;
    NEW.delete_reason := NULL;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER gauge_type_characteristics_rules BEFORE UPDATE ON public.gauge_type_characteristics
  FOR EACH ROW EXECUTE FUNCTION app.gauge_type_characteristic_rules();
CREATE TRIGGER gauges_rules BEFORE INSERT OR UPDATE ON public.gauges
  FOR EACH ROW EXECUTE FUNCTION app.gauge_rules();
CREATE TRIGGER gauges_copy_characteristics AFTER INSERT ON public.gauges
  FOR EACH ROW EXECUTE FUNCTION app.gauge_copy_characteristics();
CREATE TRIGGER gauge_characteristics_rules BEFORE INSERT OR UPDATE ON public.gauge_characteristics
  FOR EACH ROW EXECUTE FUNCTION app.gauge_characteristic_rules();
CREATE TRIGGER calibrations_rules BEFORE INSERT OR UPDATE ON public.calibrations
  FOR EACH ROW EXECUTE FUNCTION app.calibration_rules();
CREATE CONSTRAINT TRIGGER calibrations_after AFTER INSERT OR UPDATE ON public.calibrations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.calibration_after_change();
CREATE TRIGGER calibration_readings_rules BEFORE INSERT OR UPDATE ON public.calibration_readings
  FOR EACH ROW EXECUTE FUNCTION app.calibration_reading_rules();
CREATE TRIGGER calibration_readings_after AFTER INSERT OR UPDATE ON public.calibration_readings
  FOR EACH ROW EXECUTE FUNCTION app.calibration_reading_after();
CREATE TRIGGER calibration_attachments_rules BEFORE INSERT OR UPDATE ON public.calibration_attachments
  FOR EACH ROW EXECUTE FUNCTION app.calibration_attachment_rules();

-- Bookkeeping and audit.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['gauge_types', 'gauge_type_characteristics', 'gauges', 'gauge_characteristics',
                           'calibrations', 'calibration_readings', 'calibration_attachments'] LOOP
    EXECUTE format('CREATE TRIGGER %1$s_stamp BEFORE INSERT ON public.%1$I FOR EACH ROW EXECUTE FUNCTION app.stamp_created()', t);
    EXECUTE format('CREATE TRIGGER %1$s_touch BEFORE UPDATE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION app.touch_updated()', t);
    EXECUTE format('CREATE TRIGGER %1$s_org_immutable BEFORE UPDATE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change()', t);
    EXECUTE format('CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.%I '
                   'FOR EACH ROW EXECUTE FUNCTION audit.record_change(''organisation_id'')', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT, INSERT ON public.%I TO authenticated', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Row level security and privileges
-- ---------------------------------------------------------------------------
-- Gauge types are organisation-wide configuration: every member reads them (pickers), managers change them.
CREATE POLICY gauge_types_select ON public.gauge_types FOR SELECT TO authenticated USING (app.is_member(organisation_id));
CREATE POLICY gauge_types_insert ON public.gauge_types FOR INSERT TO authenticated
  WITH CHECK (app.has_permission(organisation_id, 'calibration.manage'));
CREATE POLICY gauge_types_update ON public.gauge_types FOR UPDATE TO authenticated
  USING (app.has_permission(organisation_id, 'calibration.manage'))
  WITH CHECK (app.has_permission(organisation_id, 'calibration.manage'));

CREATE POLICY gauge_type_characteristics_select ON public.gauge_type_characteristics FOR SELECT TO authenticated
  USING (app.is_member(organisation_id));
CREATE POLICY gauge_type_characteristics_insert ON public.gauge_type_characteristics FOR INSERT TO authenticated
  WITH CHECK (app.has_permission(organisation_id, 'calibration.manage'));
CREATE POLICY gauge_type_characteristics_update ON public.gauge_type_characteristics FOR UPDATE TO authenticated
  USING (app.has_permission(organisation_id, 'calibration.manage'))
  WITH CHECK (app.has_permission(organisation_id, 'calibration.manage'));

-- Gauges and everything under them follow the gauge's site (site-scoped role assignments apply).
CREATE POLICY gauges_select ON public.gauges FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'calibration.read', site_id));
CREATE POLICY gauges_insert ON public.gauges FOR INSERT TO authenticated
  WITH CHECK (app.has_permission(organisation_id, 'calibration.manage', site_id));
CREATE POLICY gauges_update ON public.gauges FOR UPDATE TO authenticated
  USING (app.has_permission(organisation_id, 'calibration.manage', site_id))
  WITH CHECK (app.has_permission(organisation_id, 'calibration.manage', site_id));

CREATE POLICY gauge_characteristics_select ON public.gauge_characteristics FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'calibration.read', app.gauge_site(gauge_id)));
CREATE POLICY gauge_characteristics_insert ON public.gauge_characteristics FOR INSERT TO authenticated
  WITH CHECK (app.has_permission(organisation_id, 'calibration.manage', app.gauge_site(gauge_id)));
CREATE POLICY gauge_characteristics_update ON public.gauge_characteristics FOR UPDATE TO authenticated
  USING (app.has_permission(organisation_id, 'calibration.manage', app.gauge_site(gauge_id)))
  WITH CHECK (app.has_permission(organisation_id, 'calibration.manage', app.gauge_site(gauge_id)));

CREATE POLICY calibrations_select ON public.calibrations FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'calibration.read', app.gauge_site(gauge_id)));
CREATE POLICY calibrations_insert ON public.calibrations FOR INSERT TO authenticated
  WITH CHECK (app.has_permission(organisation_id, 'calibration.record', app.gauge_site(gauge_id)));
CREATE POLICY calibrations_update ON public.calibrations FOR UPDATE TO authenticated
  USING (app.has_permission(organisation_id, 'calibration.record', app.gauge_site(gauge_id)))
  WITH CHECK (app.has_permission(organisation_id, 'calibration.record', app.gauge_site(gauge_id)));

CREATE POLICY calibration_readings_select ON public.calibration_readings FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'calibration.read', app.calibration_site(calibration_id)));
CREATE POLICY calibration_readings_insert ON public.calibration_readings FOR INSERT TO authenticated
  WITH CHECK (app.has_permission(organisation_id, 'calibration.record', app.calibration_site(calibration_id)));
CREATE POLICY calibration_readings_update ON public.calibration_readings FOR UPDATE TO authenticated
  USING (app.has_permission(organisation_id, 'calibration.record', app.calibration_site(calibration_id)))
  WITH CHECK (app.has_permission(organisation_id, 'calibration.record', app.calibration_site(calibration_id)));

CREATE POLICY calibration_attachments_select ON public.calibration_attachments FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'calibration.read', app.calibration_site(calibration_id)));
CREATE POLICY calibration_attachments_insert ON public.calibration_attachments FOR INSERT TO authenticated
  WITH CHECK (app.has_permission(organisation_id, 'calibration.record', app.calibration_site(calibration_id)));
CREATE POLICY calibration_attachments_update ON public.calibration_attachments FOR UPDATE TO authenticated
  USING (app.has_permission(organisation_id, 'calibration.record', app.calibration_site(calibration_id)))
  WITH CHECK (app.has_permission(organisation_id, 'calibration.record', app.calibration_site(calibration_id)));

GRANT UPDATE (name, description, interval_value, interval_unit, active) ON public.gauge_types TO authenticated;
GRANT UPDATE (sort_order, name, nominal, tolerance_minus, tolerance_plus, unit_code, method, active)
  ON public.gauge_type_characteristics, public.gauge_characteristics TO authenticated;
GRANT UPDATE (asset_number, description, gauge_type_id, manufacturer, model, serial_number, site_id, department_id,
              location, custodian_id, range_min, range_max, unit_code, resolution, calibration_source, supplier_id,
              interval_value, interval_unit, status, status_reason, last_calibrated_on, next_due_on, commissioned_on,
              notes, deleted_at, delete_reason)
  ON public.gauges TO authenticated;
GRANT UPDATE (calibrated_on, performed_by, technician_id, supplier_id, certificate_number, procedure_ref,
              reference_standards, temperature_c, humidity_pct, outcome, next_due_on, notes, nonconformance_id,
              deleted_at, delete_reason)
  ON public.calibrations TO authenticated;
GRANT UPDATE (as_found, as_left, notes) ON public.calibration_readings TO authenticated;
GRANT UPDATE (description, deleted_at, delete_reason) ON public.calibration_attachments TO authenticated;

REVOKE ALL ON app.calibration_counters FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.gauge_site(uuid), app.calibration_site(uuid), app.add_interval(date, integer, text),
  app.next_calibration_reference(uuid), app.assert_gauge_editable(uuid), app.assert_calibration_editable(uuid),
  app.soft_delete_stamp(timestamptz, timestamptz, text, text), app.gauge_type_characteristic_rules(), app.gauge_rules(),
  app.gauge_copy_characteristics(), app.gauge_characteristic_rules(), app.calibration_outcome_from_readings(uuid),
  app.calibration_rules(), app.calibration_after_change(), app.calibration_reading_rules(), app.calibration_reading_after(),
  app.calibration_attachment_rules() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.gauge_site(uuid), app.calibration_site(uuid), app.add_interval(date, integer, text) TO authenticated;

-- History of one gauge (the gauge and its characteristics) for anyone who may read it.
CREATE FUNCTION app.gauge_history(p_gauge_id uuid)
RETURNS TABLE (id uuid, created_at timestamptz, actor_user_id uuid, entity_type text, entity_id text, action text,
               changed_fields text[], previous_values jsonb, new_values jsonb, reason text, source text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT e.id, e.created_at, e.actor_user_id, e.entity_type, e.entity_id, e.action, e.changed_fields,
         e.previous_values, e.new_values, e.reason, e.source
  FROM audit.events e
  JOIN public.gauges g ON g.id = p_gauge_id
  WHERE e.organisation_id = g.organisation_id
    AND app.has_permission(g.organisation_id, 'calibration.read', g.site_id)
    AND ((e.entity_type = 'gauges' AND e.entity_id = p_gauge_id::text)
      OR (e.entity_type = 'gauge_characteristics'
          AND e.entity_id IN (SELECT k.id::text FROM public.gauge_characteristics k WHERE k.gauge_id = p_gauge_id)))
  ORDER BY e.seq
$$;
REVOKE ALL ON FUNCTION app.gauge_history(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.gauge_history(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Storage: certificates at <org>/calibration/<calibration id>/..., readable with calibration.read
-- and added with calibration.record at the gauge's site. Objects are never updated or deleted by
-- users (evidence is kept).
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public) VALUES ('calibration-files', 'calibration-files', false)
ON CONFLICT (id) DO NOTHING;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'storage' AND table_name = 'buckets' AND column_name = 'file_size_limit') THEN
    EXECUTE $q$UPDATE storage.buckets SET file_size_limit = 26214400 WHERE id = 'calibration-files'$q$;
  END IF;
END $$;

CREATE FUNCTION app.calibration_file_allowed(p_object_name text, p_permission text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT split_part(p_object_name, '/', 2) = 'calibration'
     AND EXISTS (
       SELECT 1 FROM public.calibrations c JOIN public.gauges g ON g.id = c.gauge_id
       WHERE c.id = app.try_uuid(split_part(p_object_name, '/', 3))
         AND c.organisation_id = app.try_uuid(split_part(p_object_name, '/', 1))
         AND app.has_permission(c.organisation_id, p_permission, g.site_id))
$$;
REVOKE ALL ON FUNCTION app.calibration_file_allowed(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.calibration_file_allowed(text, text) TO authenticated;

CREATE POLICY calibration_files_select ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'calibration-files' AND app.calibration_file_allowed(name, 'calibration.read'));
CREATE POLICY calibration_files_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'calibration-files' AND app.calibration_file_allowed(name, 'calibration.record'));
