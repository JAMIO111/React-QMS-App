-- Process control, slice PC4 (docs/process-control-plan.md §2 "In-Process Inspection", PCB §6, §9, §12):
-- operators record inspections against a frozen snapshot of the requirements.
--
--  * inspection_records: one inspection event — reference IPI-YY-NNNN, site, part + released revision,
--    control plan + effective revision, operation, machine, work order, lot, serial, trigger, operator,
--    status in_progress → completed | abandoned, result pass | fail, and the resolver output (snapshot).
--    Created only by app.start_inspection(), which resolves the requirements in the same transaction
--    and refuses (QM008, with the reasons) when the resolver blocks.
--  * resolved_inspection_requirements: the frozen requirements, one row per characteristic (applicable
--    or not, with the rule). Written only by app.start_inspection(); never changed.
--  * inspection_samples: a sampling occasion (subgroup) — number, time, unit/serial reference, trigger,
--    retest flag.
--  * inspection_measurements: one reading of one requirement in one sample — the value exactly as
--    entered (NUMERIC, never rounded) or pass/fail, the unit (must equal the requirement's), the result
--    worked out by the database (limits inclusive), the gauge used with its calibration status and due
--    date copied at the time of use, an authorised override reason when the gauge is not valid,
--    corrections (supersedes_id + reason, inspection.correct) and retests (retest_of_id → a failed
--    reading). Readings are never updated or deleted.
-- Completing needs every applicable requirement measured; the result is fail when any current reading
-- (one not corrected by a later one) failed — a failed reading never disappears, retests are shown
-- beside it. Errors QM008 → 409 inspection_rule.

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------
INSERT INTO public.permissions (code, description) VALUES
  ('inspection.read',           'View in-process inspections'),
  ('inspection.record',         'Start in-process inspections and record measurements'),
  ('inspection.correct',        'Correct recorded measurements (with a reason)'),
  ('inspection.override_gauge', 'Record a measurement with a gauge that is not valid (with a reason)');

WITH grants(key, perms) AS (VALUES
  ('owner',            ARRAY['inspection.read', 'inspection.record', 'inspection.correct', 'inspection.override_gauge']),
  ('admin',            ARRAY['inspection.read', 'inspection.record', 'inspection.correct', 'inspection.override_gauge']),
  ('quality_manager',  ARRAY['inspection.read', 'inspection.record', 'inspection.correct', 'inspection.override_gauge']),
  ('quality_engineer', ARRAY['inspection.read', 'inspection.record', 'inspection.correct', 'inspection.override_gauge']),
  ('inspector',        ARRAY['inspection.read', 'inspection.record']),
  ('viewer',           ARRAY['inspection.read'])
)
INSERT INTO public.role_permissions (role_id, permission_code)
SELECT r.id, unnest(g.perms) FROM public.roles r JOIN grants g ON g.key = r.key WHERE r.is_system
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE public.inspection_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  reference text NOT NULL CHECK (length(reference) BETWEEN 1 AND 40),
  site_id uuid NOT NULL,
  part_id uuid NOT NULL,
  part_revision_id uuid NOT NULL,
  control_plan_id uuid NOT NULL,
  control_plan_revision_id uuid NOT NULL,
  operation_code text,
  machine_id uuid,
  work_order text CHECK (work_order IS NULL OR length(work_order) <= 60),
  lot text CHECK (lot IS NULL OR length(lot) <= 60),
  serial text CHECK (serial IS NULL OR length(serial) <= 60),
  trigger_type text NOT NULL DEFAULT 'manual' CHECK (trigger_type IN ('first_off', 'last_off', 'every_n_minutes', 'every_n_parts',
                                                                       'start_of_shift', 'after_tool_change', 'after_setup', 'manual')),
  status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed', 'abandoned')),
  result text CHECK (result IN ('pass', 'fail')),
  notes text CHECK (notes IS NULL OR length(notes) <= 2000),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  completed_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  abandon_reason text CHECK (abandon_reason IS NULL OR length(abandon_reason) <= 2000),
  -- The resolver output used to start the inspection (plan, part revision, requirements, sources).
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT inspection_records_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT inspection_records_org_reference_key UNIQUE (organisation_id, reference),
  CONSTRAINT inspection_records_site_fkey FOREIGN KEY (site_id, organisation_id) REFERENCES public.sites (id, organisation_id),
  CONSTRAINT inspection_records_part_fkey FOREIGN KEY (part_id, organisation_id) REFERENCES public.parts (id, organisation_id),
  CONSTRAINT inspection_records_part_revision_fkey FOREIGN KEY (part_revision_id, organisation_id) REFERENCES public.part_revisions (id, organisation_id),
  CONSTRAINT inspection_records_plan_fkey FOREIGN KEY (control_plan_id, organisation_id) REFERENCES public.control_plans (id, organisation_id),
  CONSTRAINT inspection_records_plan_revision_fkey FOREIGN KEY (control_plan_revision_id, organisation_id)
    REFERENCES public.control_plan_revisions (id, organisation_id),
  CONSTRAINT inspection_records_machine_fkey FOREIGN KEY (machine_id, organisation_id) REFERENCES public.machines (id, organisation_id),
  CONSTRAINT inspection_records_completed CHECK ((status = 'in_progress') = (completed_at IS NULL)),
  CONSTRAINT inspection_records_result CHECK ((status = 'completed') = (result IS NOT NULL)),
  CONSTRAINT inspection_records_abandoned CHECK (status <> 'abandoned' OR length(trim(abandon_reason)) > 0)
);
CREATE INDEX inspection_records_org_started_idx ON public.inspection_records (organisation_id, started_at DESC);
CREATE INDEX inspection_records_part_idx ON public.inspection_records (part_id, started_at DESC);

CREATE TABLE public.resolved_inspection_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  inspection_record_id uuid NOT NULL,
  sequence integer NOT NULL,
  plan_characteristic_id uuid,
  part_revision_characteristic_id uuid,
  characteristic_key text NOT NULL,
  char_number text,
  name text NOT NULL,
  operation_code text NOT NULL,
  data_type text NOT NULL CHECK (data_type IN ('variable', 'attribute')),
  value_source text NOT NULL CHECK (value_source IN ('plan', 'part_spec')),
  spec_key text,
  applicable boolean NOT NULL,
  applicability text NOT NULL,
  nominal numeric,
  lower_limit numeric,
  upper_limit numeric,
  unit_code text REFERENCES public.units (code),
  method text,
  gauge_type_id uuid,
  gauge_type_name text,
  criticality text NOT NULL,
  spc_eligible boolean NOT NULL,
  chart_type text,
  subgroup_size integer,
  decimals integer,
  sampling jsonb NOT NULL DEFAULT '[]'::jsonb,
  reactions jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT resolved_inspection_requirements_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT resolved_inspection_requirements_id_record_key UNIQUE (id, inspection_record_id),
  CONSTRAINT resolved_inspection_requirements_record_fkey FOREIGN KEY (inspection_record_id, organisation_id)
    REFERENCES public.inspection_records (id, organisation_id),
  CONSTRAINT resolved_inspection_requirements_key UNIQUE (inspection_record_id, characteristic_key)
);

CREATE TABLE public.inspection_samples (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  inspection_record_id uuid NOT NULL,
  sample_number integer NOT NULL,
  sampled_at timestamptz NOT NULL DEFAULT now(),
  -- The unit measured (serial or position in the batch), when known.
  unit_reference text CHECK (unit_reference IS NULL OR length(unit_reference) <= 60),
  trigger_type text NOT NULL DEFAULT 'manual' CHECK (trigger_type IN ('first_off', 'last_off', 'every_n_minutes', 'every_n_parts',
                                                                       'start_of_shift', 'after_tool_change', 'after_setup', 'manual')),
  is_retest boolean NOT NULL DEFAULT false,
  notes text CHECK (notes IS NULL OR length(notes) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT inspection_samples_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT inspection_samples_id_record_key UNIQUE (id, inspection_record_id),
  CONSTRAINT inspection_samples_record_fkey FOREIGN KEY (inspection_record_id, organisation_id)
    REFERENCES public.inspection_records (id, organisation_id),
  CONSTRAINT inspection_samples_number_key UNIQUE (inspection_record_id, sample_number)
);

CREATE TABLE public.inspection_measurements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  inspection_record_id uuid NOT NULL,
  sample_id uuid NOT NULL,
  requirement_id uuid NOT NULL,
  value_numeric numeric,
  value_pass boolean,
  unit_code text REFERENCES public.units (code),
  -- Worked out by app.inspection_measurement_rules(); limits are inclusive.
  result text NOT NULL DEFAULT 'pass' CHECK (result IN ('pass', 'fail')),
  gauge_id uuid,
  -- The gauge's state when it was used (copied, so later calibrations do not rewrite history).
  gauge_asset_number text,
  gauge_status text,
  gauge_next_due_on date,
  gauge_valid boolean,
  gauge_override_reason text CHECK (gauge_override_reason IS NULL OR length(trim(gauge_override_reason)) BETWEEN 1 AND 1000),
  measured_at timestamptz NOT NULL DEFAULT now(),
  supersedes_id uuid,
  correction_reason text CHECK (correction_reason IS NULL OR length(trim(correction_reason)) BETWEEN 1 AND 1000),
  retest_of_id uuid,
  notes text CHECK (notes IS NULL OR length(notes) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT inspection_measurements_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT inspection_measurements_id_record_key UNIQUE (id, inspection_record_id),
  CONSTRAINT inspection_measurements_sample_fkey FOREIGN KEY (sample_id, inspection_record_id)
    REFERENCES public.inspection_samples (id, inspection_record_id),
  CONSTRAINT inspection_measurements_requirement_fkey FOREIGN KEY (requirement_id, inspection_record_id)
    REFERENCES public.resolved_inspection_requirements (id, inspection_record_id),
  CONSTRAINT inspection_measurements_record_fkey FOREIGN KEY (inspection_record_id, organisation_id)
    REFERENCES public.inspection_records (id, organisation_id),
  CONSTRAINT inspection_measurements_gauge_fkey FOREIGN KEY (gauge_id, organisation_id) REFERENCES public.gauges (id, organisation_id),
  CONSTRAINT inspection_measurements_supersedes_fkey FOREIGN KEY (supersedes_id, inspection_record_id)
    REFERENCES public.inspection_measurements (id, inspection_record_id),
  CONSTRAINT inspection_measurements_retest_fkey FOREIGN KEY (retest_of_id, inspection_record_id)
    REFERENCES public.inspection_measurements (id, inspection_record_id),
  CONSTRAINT inspection_measurements_one_value CHECK ((value_numeric IS NULL) <> (value_pass IS NULL)),
  CONSTRAINT inspection_measurements_correction_reason CHECK ((supersedes_id IS NULL) = (correction_reason IS NULL))
);
-- A reading is corrected at most once (corrections chain).
CREATE UNIQUE INDEX inspection_measurements_supersedes_key ON public.inspection_measurements (supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE INDEX inspection_measurements_requirement_idx ON public.inspection_measurements (requirement_id);
CREATE INDEX inspection_measurements_gauge_idx ON public.inspection_measurements (gauge_id, measured_at) WHERE gauge_id IS NOT NULL;

-- Per-organisation, per-year counters for references (IPI-YY-NNNN). Not reachable by users.
CREATE TABLE app.inspection_counters (
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  year integer NOT NULL,
  last_value integer NOT NULL DEFAULT 0,
  PRIMARY KEY (organisation_id, year)
);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.inspection_site(p_record_id uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT site_id FROM public.inspection_records WHERE id = p_record_id
$$;

/*
 * Starts an inspection: checks the caller may record inspections at the site, resolves the part's
 * requirements (app.resolve_inspection_requirements) and, unless that is blocked, creates the record
 * with the resolver output as its snapshot and one frozen requirement row per characteristic — all in
 * the caller's transaction, so the plan or part cannot change in between. Returns the record id.
 */
CREATE FUNCTION app.start_inspection(
  p_site_id uuid,
  p_part_id uuid,
  p_operation_code text DEFAULT NULL,
  p_machine_id uuid DEFAULT NULL,
  p_work_order text DEFAULT NULL,
  p_lot text DEFAULT NULL,
  p_serial text DEFAULT NULL,
  p_trigger_type text DEFAULT 'manual',
  p_part_revision_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_org uuid;
  v_r jsonb;
  v_id uuid;
  v_year integer := extract(year FROM current_date)::integer;
  v_n integer;
  v_ref text;
  v_req jsonb;
  v_seq integer := 0;
BEGIN
  SELECT organisation_id INTO v_org FROM public.parts WHERE id = p_part_id;
  IF v_org IS NULL OR NOT app.has_permission(v_org, 'inspection.record', p_site_id) THEN
    RAISE EXCEPTION 'You may not start inspections for this part at this site' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.sites WHERE id = p_site_id AND organisation_id = v_org) THEN
    RAISE EXCEPTION 'Site not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_machine_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.machines WHERE id = p_machine_id AND organisation_id = v_org AND active) THEN
    RAISE EXCEPTION 'Machine not found or inactive' USING ERRCODE = 'QM008';
  END IF;

  v_r := app.resolve_inspection_requirements(p_part_id, p_operation_code, p_site_id, p_part_revision_id);
  IF v_r ->> 'status' <> 'ok' THEN
    RAISE EXCEPTION 'The inspection cannot start: %', (SELECT string_agg(e ->> 'message', '; ') FROM jsonb_array_elements(v_r -> 'problems') e)
      USING ERRCODE = 'QM008';
  END IF;

  LOOP
    INSERT INTO app.inspection_counters AS c (organisation_id, year, last_value) VALUES (v_org, v_year, 1)
    ON CONFLICT (organisation_id, year) DO UPDATE SET last_value = c.last_value + 1
    RETURNING last_value INTO v_n;
    v_ref := 'IPI-' || to_char(make_date(v_year, 1, 1), 'YY') || '-' || lpad(v_n::text, 4, '0');
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.inspection_records WHERE organisation_id = v_org AND reference = v_ref);
  END LOOP;

  INSERT INTO public.inspection_records (organisation_id, reference, site_id, part_id, part_revision_id, control_plan_id,
                                         control_plan_revision_id, operation_code, machine_id, work_order, lot, serial,
                                         trigger_type, notes, snapshot)
  VALUES (v_org, v_ref, p_site_id, p_part_id, (v_r -> 'partRevision' ->> 'id')::uuid, (v_r -> 'plan' ->> 'id')::uuid,
          (v_r -> 'planRevision' ->> 'id')::uuid, v_r ->> 'operationCode', p_machine_id,
          nullif(trim(p_work_order), ''), nullif(trim(p_lot), ''), nullif(trim(p_serial), ''),
          coalesce(p_trigger_type, 'manual'), nullif(trim(p_notes), ''), v_r)
  RETURNING id INTO v_id;

  FOR v_req IN SELECT * FROM jsonb_array_elements(v_r -> 'requirements') LOOP
    v_seq := v_seq + 1;
    INSERT INTO public.resolved_inspection_requirements (
      organisation_id, inspection_record_id, sequence, plan_characteristic_id, part_revision_characteristic_id, characteristic_key,
      char_number, name, operation_code, data_type, value_source, spec_key, applicable, applicability, nominal, lower_limit,
      upper_limit, unit_code, method, gauge_type_id, gauge_type_name, criticality, spc_eligible, chart_type, subgroup_size,
      decimals, sampling, reactions)
    VALUES (
      v_org, v_id, v_seq, (v_req ->> 'planCharacteristicId')::uuid, (v_req ->> 'partRevisionCharacteristicId')::uuid,
      v_req ->> 'characteristicKey', v_req ->> 'charNumber', v_req ->> 'name', v_req ->> 'operationCode', v_req ->> 'dataType',
      v_req ->> 'valueSource', v_req ->> 'specKey', (v_req ->> 'applicable')::boolean, v_req ->> 'applicability',
      (v_req ->> 'nominal')::numeric, (v_req ->> 'lowerLimit')::numeric, (v_req ->> 'upperLimit')::numeric, v_req ->> 'unitCode',
      v_req ->> 'method', (v_req -> 'gaugeType' ->> 'id')::uuid, v_req -> 'gaugeType' ->> 'name', v_req ->> 'criticality',
      (v_req ->> 'spcEligible')::boolean, v_req ->> 'chartType', (v_req ->> 'subgroupSize')::integer, (v_req ->> 'decimals')::integer,
      coalesce(v_req -> 'sampling', '[]'::jsonb), coalesce(v_req -> 'reactions', '[]'::jsonb));
  END LOOP;

  PERFORM app.emit_event(v_org, 'inspection.started', 'inspection_record', v_id,
    jsonb_build_object('reference', v_ref, 'part_id', p_part_id, 'part_number', v_r -> 'part' ->> 'partNumber',
      'control_plan_revision_id', v_r -> 'planRevision' ->> 'id', 'operation_code', v_r ->> 'operationCode'));
  RETURN v_id;
END $$;

-- The record's status and the user's rights for changes to its samples and readings.
CREATE FUNCTION app.assert_inspection_open(p_record_id uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_status text;
  v_ref text;
BEGIN
  SELECT status, reference INTO v_status, v_ref FROM public.inspection_records WHERE id = p_record_id;
  IF v_status <> 'in_progress' THEN
    RAISE EXCEPTION 'Inspection % is %; no more samples or readings can be added', v_ref, v_status USING ERRCODE = 'QM008';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Rules
-- ---------------------------------------------------------------------------
/*
 * Records (signed-in users): context and snapshot never change; status moves
 * in_progress → completed (every applicable requirement measured; result worked out) or
 * in_progress → abandoned (with a reason). Completion and abandonment stamp who and when.
 */
CREATE FUNCTION app.inspection_record_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_missing text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Only app.start_inspection inserts (users have no INSERT privilege); keep it consistent.
    NEW.status := 'in_progress'; NEW.result := NULL; NEW.completed_at := NULL; NEW.completed_by := NULL; NEW.abandon_reason := NULL;
    NEW.started_at := now();
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'result', 'completed_at', 'completed_by', 'abandon_reason', 'notes', 'updated_at', 'updated_by'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'result', 'completed_at', 'completed_by', 'abandon_reason', 'notes', 'updated_at', 'updated_by']) THEN
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
  NEW.result := CASE WHEN EXISTS (
      SELECT 1 FROM public.inspection_measurements m
      WHERE m.inspection_record_id = NEW.id AND m.result = 'fail'
        AND NOT EXISTS (SELECT 1 FROM public.inspection_measurements c WHERE c.supersedes_id = m.id))
    THEN 'fail' ELSE 'pass' END;
  RETURN NEW;
END $$;

CREATE FUNCTION app.inspection_record_events() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.status <> OLD.status THEN
    PERFORM app.emit_event(NEW.organisation_id, 'inspection.' || NEW.status, 'inspection_record', NEW.id,
      jsonb_build_object('reference', NEW.reference, 'result', NEW.result, 'reason', NEW.abandon_reason));
  END IF;
  RETURN NULL;
END $$;

-- Frozen requirements: written once by app.start_inspection, never changed.
CREATE FUNCTION app.resolved_requirement_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'The requirements of an inspection are frozen when it starts' USING ERRCODE = 'QM008';
END $$;

-- Samples: numbered in order, only while the inspection is in progress; never changed afterwards
-- except their notes.
CREATE FUNCTION app.inspection_sample_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - ARRAY['notes', 'updated_at', 'updated_by']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['notes', 'updated_at', 'updated_by']) THEN
      RAISE EXCEPTION 'A sample cannot be changed once taken' USING ERRCODE = 'QM008';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM app.assert_inspection_open(NEW.inspection_record_id);
  NEW.sample_number := coalesce((SELECT max(sample_number) FROM public.inspection_samples WHERE inspection_record_id = NEW.inspection_record_id), 0) + 1;
  NEW.sampled_at := now();
  RETURN NEW;
END $$;

/*
 * Readings (insert only):
 * - the requirement must apply; a measured requirement needs a number, a pass/fail one a pass/fail;
 * - the unit defaults to the requirement's and must equal it (no conversion);
 * - the result is worked out from the unrounded value (limits inclusive) or the pass/fail;
 * - a gauge's status and due date are copied; when it is not active, is overdue or is not the required
 *   type, an override reason and inspection.override_gauge are needed; a required gauge type needs a gauge;
 * - a first reading of a requirement in a sample is added only while the inspection is in progress;
 *   a correction (supersedes_id, reason, inspection.correct) may follow later, of the latest reading only;
 * - a retest points at a failed reading of the same requirement.
 */
CREATE FUNCTION app.inspection_measurement_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  q record;
  g record;
  prev record;
  v_site uuid := app.inspection_site(NEW.inspection_record_id);
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'A recorded reading cannot be changed; record a correction instead' USING ERRCODE = 'QM008';
  END IF;
  SELECT * INTO q FROM public.resolved_inspection_requirements WHERE id = NEW.requirement_id;
  IF NOT q.applicable THEN
    RAISE EXCEPTION '% does not apply to this part (%)', q.name, q.applicability USING ERRCODE = 'QM008';
  END IF;

  IF NEW.supersedes_id IS NULL THEN
    PERFORM app.assert_inspection_open(NEW.inspection_record_id);
    IF EXISTS (SELECT 1 FROM public.inspection_measurements WHERE sample_id = NEW.sample_id AND requirement_id = NEW.requirement_id) THEN
      RAISE EXCEPTION '% already has a reading in this sample; record a correction instead', q.name USING ERRCODE = 'QM008';
    END IF;
  ELSE
    SELECT * INTO prev FROM public.inspection_measurements WHERE id = NEW.supersedes_id;
    IF prev.requirement_id <> NEW.requirement_id OR prev.sample_id <> NEW.sample_id THEN
      RAISE EXCEPTION 'A correction replaces a reading of the same check in the same sample' USING ERRCODE = 'QM008';
    END IF;
    IF coalesce(auth.role(), '') = 'authenticated' AND NOT app.has_permission(NEW.organisation_id, 'inspection.correct', v_site) THEN
      RAISE EXCEPTION 'You may not correct recorded readings' USING ERRCODE = '42501';
    END IF;
    IF (SELECT status FROM public.inspection_records WHERE id = NEW.inspection_record_id) = 'abandoned' THEN
      RAISE EXCEPTION 'An abandoned inspection cannot be corrected' USING ERRCODE = 'QM008';
    END IF;
  END IF;

  IF NEW.retest_of_id IS NOT NULL THEN
    SELECT * INTO prev FROM public.inspection_measurements WHERE id = NEW.retest_of_id;
    IF prev.requirement_id <> NEW.requirement_id OR prev.result <> 'fail' THEN
      RAISE EXCEPTION 'A retest follows a failed reading of the same check' USING ERRCODE = 'QM008';
    END IF;
  END IF;

  IF q.data_type = 'variable' THEN
    IF NEW.value_numeric IS NULL OR NEW.value_pass IS NOT NULL THEN
      RAISE EXCEPTION '% needs a measured value', q.name USING ERRCODE = 'QM008';
    END IF;
    NEW.unit_code := coalesce(NEW.unit_code, q.unit_code);
    IF NEW.unit_code IS DISTINCT FROM q.unit_code THEN
      RAISE EXCEPTION '% is measured in %, not %', q.name, q.unit_code, NEW.unit_code USING ERRCODE = 'QM008';
    END IF;
    NEW.result := CASE WHEN (q.lower_limit IS NULL OR NEW.value_numeric >= q.lower_limit)
                        AND (q.upper_limit IS NULL OR NEW.value_numeric <= q.upper_limit) THEN 'pass' ELSE 'fail' END;
  ELSE
    IF NEW.value_pass IS NULL OR NEW.value_numeric IS NOT NULL THEN
      RAISE EXCEPTION '% needs pass or fail', q.name USING ERRCODE = 'QM008';
    END IF;
    NEW.unit_code := NULL;
    NEW.result := CASE WHEN NEW.value_pass THEN 'pass' ELSE 'fail' END;
  END IF;

  -- Gauge at the time of use.
  NEW.gauge_asset_number := NULL; NEW.gauge_status := NULL; NEW.gauge_next_due_on := NULL; NEW.gauge_valid := NULL;
  IF NEW.gauge_id IS NOT NULL THEN
    SELECT asset_number, status, next_due_on, gauge_type_id, deleted_at INTO g FROM public.gauges WHERE id = NEW.gauge_id;
    NEW.gauge_asset_number := g.asset_number;
    NEW.gauge_status := g.status;
    NEW.gauge_next_due_on := g.next_due_on;
    -- coalesce: a gauge without a type is not "the required type" (NULL must not count as valid).
    NEW.gauge_valid := coalesce(g.deleted_at IS NULL AND g.status = 'active' AND (g.next_due_on IS NULL OR g.next_due_on >= current_date)
                       AND (q.gauge_type_id IS NULL OR g.gauge_type_id = q.gauge_type_id), false);
  ELSIF q.gauge_type_id IS NOT NULL AND q.data_type = 'variable' THEN
    RAISE EXCEPTION '% must be measured with a % gauge; choose the gauge used', q.name, q.gauge_type_name USING ERRCODE = 'QM008';
  END IF;
  IF NEW.gauge_valid = false THEN
    IF coalesce(trim(NEW.gauge_override_reason), '') = '' THEN
      RAISE EXCEPTION 'Gauge % is %; it cannot be used without an authorised override and a reason', g.asset_number,
        CASE WHEN g.deleted_at IS NOT NULL THEN 'deleted'
             WHEN g.status <> 'active' THEN replace(g.status, '_', ' ')
             WHEN g.next_due_on < current_date THEN 'overdue for calibration (due ' || to_char(g.next_due_on, 'DD Mon YYYY') || ')'
             ELSE 'not the required type (' || q.gauge_type_name || ')' END
        USING ERRCODE = 'QM008';
    END IF;
    IF coalesce(auth.role(), '') = 'authenticated' AND NOT app.has_permission(NEW.organisation_id, 'inspection.override_gauge', v_site) THEN
      RAISE EXCEPTION 'You may not override gauge checks; ask a supervisor' USING ERRCODE = '42501';
    END IF;
  ELSE
    NEW.gauge_override_reason := NULL;
  END IF;
  NEW.measured_at := now();
  RETURN NEW;
END $$;

CREATE FUNCTION app.inspection_measurement_events() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.result = 'fail' THEN
    PERFORM app.emit_event(NEW.organisation_id, 'inspection.measurement.failed', 'inspection_measurement', NEW.id,
      jsonb_build_object('inspection_record_id', NEW.inspection_record_id, 'requirement_id', NEW.requirement_id,
        'characteristic_key', (SELECT characteristic_key FROM public.resolved_inspection_requirements WHERE id = NEW.requirement_id),
        'value', NEW.value_numeric, 'pass', NEW.value_pass));
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER inspection_records_rules BEFORE INSERT OR UPDATE ON public.inspection_records
  FOR EACH ROW EXECUTE FUNCTION app.inspection_record_rules();
CREATE TRIGGER inspection_records_events AFTER UPDATE OF status ON public.inspection_records
  FOR EACH ROW EXECUTE FUNCTION app.inspection_record_events();
CREATE TRIGGER resolved_inspection_requirements_frozen BEFORE UPDATE ON public.resolved_inspection_requirements
  FOR EACH ROW EXECUTE FUNCTION app.resolved_requirement_rules();
CREATE TRIGGER inspection_samples_rules BEFORE INSERT OR UPDATE ON public.inspection_samples
  FOR EACH ROW EXECUTE FUNCTION app.inspection_sample_rules();
CREATE TRIGGER inspection_measurements_rules BEFORE INSERT OR UPDATE ON public.inspection_measurements
  FOR EACH ROW EXECUTE FUNCTION app.inspection_measurement_rules();
CREATE TRIGGER inspection_measurements_events AFTER INSERT ON public.inspection_measurements
  FOR EACH ROW EXECUTE FUNCTION app.inspection_measurement_events();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['inspection_records', 'resolved_inspection_requirements', 'inspection_samples', 'inspection_measurements'] LOOP
    EXECUTE format('CREATE TRIGGER %1$s_stamp BEFORE INSERT ON public.%1$I FOR EACH ROW EXECUTE FUNCTION app.stamp_created()', t);
    EXECUTE format('CREATE TRIGGER %1$s_touch BEFORE UPDATE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION app.touch_updated()', t);
    EXECUTE format('CREATE TRIGGER %1$s_org_immutable BEFORE UPDATE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change()', t);
    EXECUTE format('CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.%I '
                   'FOR EACH ROW EXECUTE FUNCTION audit.record_change(''organisation_id'')', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
  END LOOP;
END $$;

-- Reading follows the inspection's site (site-scoped role assignments apply).
CREATE POLICY inspection_records_select ON public.inspection_records FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'inspection.read', site_id));
CREATE POLICY inspection_records_update ON public.inspection_records FOR UPDATE TO authenticated
  USING (app.has_permission(organisation_id, 'inspection.record', site_id))
  WITH CHECK (app.has_permission(organisation_id, 'inspection.record', site_id));
CREATE POLICY resolved_inspection_requirements_select ON public.resolved_inspection_requirements FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'inspection.read', app.inspection_site(inspection_record_id)));
CREATE POLICY inspection_samples_select ON public.inspection_samples FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'inspection.read', app.inspection_site(inspection_record_id)));
CREATE POLICY inspection_samples_insert ON public.inspection_samples FOR INSERT TO authenticated
  WITH CHECK (app.has_permission(organisation_id, 'inspection.record', app.inspection_site(inspection_record_id)));
CREATE POLICY inspection_samples_update ON public.inspection_samples FOR UPDATE TO authenticated
  USING (app.has_permission(organisation_id, 'inspection.record', app.inspection_site(inspection_record_id)))
  WITH CHECK (app.has_permission(organisation_id, 'inspection.record', app.inspection_site(inspection_record_id)));
CREATE POLICY inspection_measurements_select ON public.inspection_measurements FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'inspection.read', app.inspection_site(inspection_record_id)));
CREATE POLICY inspection_measurements_insert ON public.inspection_measurements FOR INSERT TO authenticated
  WITH CHECK (app.has_permission(organisation_id, 'inspection.record', app.inspection_site(inspection_record_id)));

-- Records and requirements are created only by app.start_inspection; readings are insert-only.
GRANT UPDATE (status, abandon_reason, notes) ON public.inspection_records TO authenticated;
GRANT INSERT ON public.inspection_samples, public.inspection_measurements TO authenticated;
GRANT UPDATE (notes) ON public.inspection_samples TO authenticated;

REVOKE ALL ON app.inspection_counters FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.inspection_site(uuid), app.start_inspection(uuid, uuid, text, uuid, text, text, text, text, uuid, text),
  app.assert_inspection_open(uuid), app.inspection_record_rules(), app.inspection_record_events(), app.resolved_requirement_rules(),
  app.inspection_sample_rules(), app.inspection_measurement_rules(), app.inspection_measurement_events() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.inspection_site(uuid), app.start_inspection(uuid, uuid, text, uuid, text, text, text, text, uuid, text) TO authenticated;
