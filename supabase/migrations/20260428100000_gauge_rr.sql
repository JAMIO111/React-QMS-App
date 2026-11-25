-- Gauge R&R / measurement system analysis, slice MS2 (docs/gauge-rr-plan.md §4): the data, the rules and the freezing. The statistics live in the API
-- (api/src/msa/, slice MS1) and are never done in SQL; the database holds the data and refuses to freeze a result for data it does not hold.
--
--  * msa_studies: MSA-YY-NNNN per organisation and year (app.msa_study_counters, app.pad_number). One gauge and one characteristic; the characteristic's name, unit,
--    limits and the gauge's resolution are COPIED onto the study so history cannot change. study_type grr_crossed | type1 | attribute. Lifecycle draft -> collecting ->
--    completed, or cancelled (reason) from draft or collecting. The design (counts, appraisers, parts, limits, options) changes only while draft; once collecting only
--    the lifecycle moves; completed and cancelled studies never change (trigger, even for SQL). A repeat is a NEW study (repeat_of_id).
--  * msa_study_appraisers (an Employees register entry, or a typed name for someone outside the company; the name is copied), msa_study_parts (label and, for an
--    attribute study, the known accept / reject decision) and msa_study_measurements: ONE ROW PER CELL (appraiser x part x trial), created empty when collection starts with
--    a repeatable random run_order (per appraiser and trial, from a hash of the study id), then filled in. A cell is never deleted; it can be overwritten while collecting
--    (audited). Cells are filled only through app.record_msa_measurements. Value is numeric AS ENTERED (variable studies) or decision (attribute studies).
--  * msa_study_results: one frozen row per completed study: the whole result as jsonb, the algorithm version and criteria id, the verdict and a data_hash of the exact data and
--    options it was worked out from.
--  * Permissions: no new one. Read = calibration.read, enter readings = calibration.record, design, complete and cancel = calibration.manage; all site-scoped through the gauge.
--  * Writes are SECURITY DEFINER functions only (no table INSERT/UPDATE/DELETE for anyone). Completing is API-login only (app.system_complete_msa_study): the API works out the
--    result from the stored data and the database re-checks the person's right, that the study is collecting, every cell is filled and that the hash of the data it holds
--    equals the hash the result was computed from (app.msa_data_canonical is the one definition of that text), then freezes everything and writes the outbox event
--    msa.study.completed.
-- Errors use QM034 (409 msa_rule); another organisation's id is P0002 (404).

-- ---------------------------------------------------------------------------
-- Counters, tables
-- ---------------------------------------------------------------------------
CREATE TABLE app.msa_study_counters (
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  year integer NOT NULL,
  last_value integer NOT NULL,
  PRIMARY KEY (organisation_id, year)
);
REVOKE ALL ON app.msa_study_counters FROM PUBLIC, anon, authenticated;

CREATE TABLE public.msa_studies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  reference text NOT NULL CHECK (reference ~ '^MSA-[0-9]{2}-[0-9]{4,}$'),
  study_type text NOT NULL CHECK (study_type IN ('grr_crossed', 'type1', 'attribute')),
  gauge_id uuid NOT NULL,
  part_id uuid,
  characteristic_key text CHECK (characteristic_key IS NULL OR length(btrim(characteristic_key)) BETWEEN 1 AND 100),
  operation_code text CHECK (operation_code IS NULL OR length(btrim(operation_code)) BETWEEN 1 AND 40),
  characteristic_name text NOT NULL CHECK (length(btrim(characteristic_name)) BETWEEN 1 AND 200),
  unit_code text REFERENCES public.units (code),
  nominal numeric CHECK (nominal IS NULL OR abs(nominal) < 1e12),
  lower_limit numeric CHECK (lower_limit IS NULL OR abs(lower_limit) < 1e12),
  upper_limit numeric CHECK (upper_limit IS NULL OR abs(upper_limit) < 1e12),
  gauge_resolution numeric CHECK (gauge_resolution IS NULL OR gauge_resolution > 0),
  part_count integer NOT NULL,
  appraiser_count integer NOT NULL,
  trial_count integer NOT NULL,
  sigma_multiplier numeric(4, 2) NOT NULL DEFAULT 6 CHECK (sigma_multiplier IN (6, 5.15)),
  interaction_alpha numeric(3, 2) NOT NULL DEFAULT 0.05 CHECK (interaction_alpha IN (0.05, 0.25)),
  reference_value numeric CHECK (reference_value IS NULL OR abs(reference_value) < 1e12),
  k_percent numeric(5, 2) NOT NULL DEFAULT 20 CHECK (k_percent > 0 AND k_percent <= 100),
  l_multiplier numeric(4, 2) NOT NULL DEFAULT 6 CHECK (l_multiplier > 0 AND l_multiplier <= 10),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'collecting', 'completed', 'cancelled')),
  started_at timestamptz,
  started_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  completed_at timestamptz,
  completed_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  conclusion text CHECK (conclusion IN ('accepted', 'accepted_with_conditions', 'not_accepted')),
  conclusion_note text CHECK (conclusion_note IS NULL OR length(btrim(conclusion_note)) BETWEEN 3 AND 2000),
  valid_until date,
  repeat_of_id uuid,
  cancel_reason text CHECK (cancel_reason IS NULL OR length(btrim(cancel_reason)) BETWEEN 3 AND 500),
  cancelled_at timestamptz,
  cancelled_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT msa_studies_reference_key UNIQUE (organisation_id, reference),
  CONSTRAINT msa_studies_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT msa_studies_gauge_fkey FOREIGN KEY (gauge_id, organisation_id) REFERENCES public.gauges (id, organisation_id),
  CONSTRAINT msa_studies_part_fkey FOREIGN KEY (part_id, organisation_id) REFERENCES public.parts (id, organisation_id),
  CONSTRAINT msa_studies_repeat_fkey FOREIGN KEY (repeat_of_id, organisation_id) REFERENCES public.msa_studies (id, organisation_id),
  CONSTRAINT msa_studies_limits_check CHECK (lower_limit IS NULL OR upper_limit IS NULL OR upper_limit > lower_limit),
  CONSTRAINT msa_studies_design_check CHECK (
    (study_type = 'grr_crossed' AND part_count BETWEEN 2 AND 50 AND appraiser_count BETWEEN 2 AND 10 AND trial_count BETWEEN 2 AND 10)
    OR (study_type = 'type1' AND part_count = 1 AND appraiser_count = 1 AND trial_count BETWEEN 2 AND 500)
    OR (study_type = 'attribute' AND part_count BETWEEN 2 AND 200 AND appraiser_count BETWEEN 1 AND 10 AND trial_count BETWEEN 1 AND 10 AND appraiser_count * trial_count >= 2)
  ),
  CONSTRAINT msa_studies_cancel_check CHECK ((status = 'cancelled') = (cancel_reason IS NOT NULL AND cancelled_at IS NOT NULL)),
  CONSTRAINT msa_studies_started_check CHECK ((status IN ('collecting', 'completed')) = (started_at IS NOT NULL) OR status = 'cancelled'),
  CONSTRAINT msa_studies_completed_check CHECK ((status = 'completed') = (completed_at IS NOT NULL AND conclusion IS NOT NULL AND conclusion_note IS NOT NULL AND valid_until IS NOT NULL)),
  CONSTRAINT msa_studies_repeat_self_check CHECK (repeat_of_id IS DISTINCT FROM id)
);
CREATE INDEX msa_studies_gauge_idx ON public.msa_studies (organisation_id, gauge_id, status);
CREATE INDEX msa_studies_part_idx ON public.msa_studies (organisation_id, part_id) WHERE part_id IS NOT NULL;

CREATE TABLE public.msa_study_appraisers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  study_id uuid NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 1 AND 10),
  employee_id uuid,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT msa_study_appraisers_study_fkey FOREIGN KEY (study_id, organisation_id) REFERENCES public.msa_studies (id, organisation_id),
  CONSTRAINT msa_study_appraisers_employee_fkey FOREIGN KEY (employee_id, organisation_id) REFERENCES public."Employees" (id, organisation_id),
  CONSTRAINT msa_study_appraisers_id_study_key UNIQUE (id, study_id),
  CONSTRAINT msa_study_appraisers_position_key UNIQUE (study_id, position)
);
CREATE UNIQUE INDEX msa_study_appraisers_employee_key ON public.msa_study_appraisers (study_id, employee_id) WHERE employee_id IS NOT NULL;
CREATE UNIQUE INDEX msa_study_appraisers_name_key ON public.msa_study_appraisers (study_id, lower(btrim(name)));

CREATE TABLE public.msa_study_parts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  study_id uuid NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 1 AND 200),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 60),
  reference_decision boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT msa_study_parts_study_fkey FOREIGN KEY (study_id, organisation_id) REFERENCES public.msa_studies (id, organisation_id),
  CONSTRAINT msa_study_parts_id_study_key UNIQUE (id, study_id),
  CONSTRAINT msa_study_parts_position_key UNIQUE (study_id, position)
);
CREATE UNIQUE INDEX msa_study_parts_label_key ON public.msa_study_parts (study_id, lower(btrim(label)));

CREATE TABLE public.msa_study_measurements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  study_id uuid NOT NULL,
  appraiser_id uuid NOT NULL,
  part_id uuid NOT NULL,
  trial integer NOT NULL CHECK (trial BETWEEN 1 AND 500),
  run_order integer NOT NULL CHECK (run_order >= 1),
  value numeric CHECK (value IS NULL OR abs(value) < 1e12),
  decision boolean,
  source text CHECK (source IN ('grid', 'paste')),
  entered_at timestamptz,
  entered_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT msa_study_measurements_study_fkey FOREIGN KEY (study_id, organisation_id) REFERENCES public.msa_studies (id, organisation_id),
  CONSTRAINT msa_study_measurements_appraiser_fkey FOREIGN KEY (appraiser_id, study_id) REFERENCES public.msa_study_appraisers (id, study_id),
  CONSTRAINT msa_study_measurements_part_fkey FOREIGN KEY (part_id, study_id) REFERENCES public.msa_study_parts (id, study_id),
  CONSTRAINT msa_study_measurements_cell_key UNIQUE (study_id, appraiser_id, part_id, trial),
  CONSTRAINT msa_study_measurements_one_kind_check CHECK (value IS NULL OR decision IS NULL),
  CONSTRAINT msa_study_measurements_entered_check CHECK ((value IS NOT NULL OR decision IS NOT NULL) = (entered_at IS NOT NULL AND source IS NOT NULL))
);
CREATE INDEX msa_study_measurements_study_idx ON public.msa_study_measurements (organisation_id, study_id);

CREATE TABLE public.msa_study_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  study_id uuid NOT NULL,
  algorithm_version text NOT NULL CHECK (length(btrim(algorithm_version)) BETWEEN 1 AND 40),
  criteria_id text NOT NULL CHECK (length(btrim(criteria_id)) BETWEEN 1 AND 40),
  verdict text NOT NULL CHECK (verdict IN ('acceptable', 'marginal', 'unacceptable', 'not_judged')),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  data_hash text NOT NULL CHECK (data_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT msa_study_results_study_fkey FOREIGN KEY (study_id, organisation_id) REFERENCES public.msa_studies (id, organisation_id),
  CONSTRAINT msa_study_results_study_key UNIQUE (study_id)
);

-- ---------------------------------------------------------------------------
-- Rules held by triggers (so SQL is held to them too)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.msa_study_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_lifecycle text[] := ARRAY['status', 'started_at', 'started_by', 'cancel_reason', 'cancelled_at', 'cancelled_by', 'completed_at', 'completed_by', 'conclusion', 'conclusion_note', 'valid_until', 'updated_at', 'updated_by'];
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A study is never deleted. Cancel it with a reason.' USING ERRCODE = 'QM034'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN RAISE EXCEPTION 'A study starts as a draft' USING ERRCODE = 'QM034'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.reference, NEW.study_type, NEW.gauge_id, NEW.repeat_of_id) IS DISTINCT FROM (OLD.reference, OLD.study_type, OLD.gauge_id, OLD.repeat_of_id) THEN
    RAISE EXCEPTION 'A study''s reference, type, gauge and the study it repeats never change' USING ERRCODE = 'QM034';
  END IF;
  IF OLD.status IN ('completed', 'cancelled') THEN
    RAISE EXCEPTION '% is % and cannot be changed. Repeat the study instead.', OLD.reference, OLD.status USING ERRCODE = 'QM034';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status, NEW.status) IN (('draft', 'collecting'), ('draft', 'cancelled'), ('collecting', 'cancelled'), ('collecting', 'completed'))) THEN
    RAISE EXCEPTION 'A % study cannot become %', OLD.status, NEW.status USING ERRCODE = 'QM034';
  END IF;
  IF OLD.status = 'collecting' AND (to_jsonb(NEW) - v_lifecycle) IS DISTINCT FROM (to_jsonb(OLD) - v_lifecycle) THEN
    RAISE EXCEPTION 'The design is locked once collection has started' USING ERRCODE = 'QM034';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER msa_studies_rules BEFORE INSERT OR UPDATE OR DELETE ON public.msa_studies FOR EACH ROW EXECUTE FUNCTION app.msa_study_rules();

-- Appraisers and parts belong to the design: they change only while the study is a draft.
CREATE FUNCTION app.msa_child_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_status text;
BEGIN
  SELECT status INTO v_status FROM public.msa_studies WHERE id = coalesce(NEW.study_id, OLD.study_id);
  IF v_status IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'The design cannot change once collection has started' USING ERRCODE = 'QM034'; END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER msa_study_appraisers_rules BEFORE INSERT OR UPDATE OR DELETE ON public.msa_study_appraisers FOR EACH ROW EXECUTE FUNCTION app.msa_child_rules();
CREATE TRIGGER msa_study_parts_rules BEFORE INSERT OR UPDATE OR DELETE ON public.msa_study_parts FOR EACH ROW EXECUTE FUNCTION app.msa_child_rules();

-- A cell is created empty when collection starts and then filled: never deleted, never moved, filled only while collecting, and with the kind of answer the study asks for.
CREATE FUNCTION app.msa_measurement_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_status text; v_type text;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A reading is never deleted' USING ERRCODE = 'QM034'; END IF;
  SELECT status, study_type INTO v_status, v_type FROM public.msa_studies WHERE id = NEW.study_id;
  IF TG_OP = 'INSERT' THEN
    IF v_status IS DISTINCT FROM 'draft' OR NEW.value IS NOT NULL OR NEW.decision IS NOT NULL THEN
      RAISE EXCEPTION 'Readings are set up empty when collection starts' USING ERRCODE = 'QM034';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.organisation_id, NEW.study_id, NEW.appraiser_id, NEW.part_id, NEW.trial, NEW.run_order) IS DISTINCT FROM (OLD.organisation_id, OLD.study_id, OLD.appraiser_id, OLD.part_id, OLD.trial, OLD.run_order) THEN
    RAISE EXCEPTION 'Where a reading belongs never changes' USING ERRCODE = 'QM034';
  END IF;
  IF v_status IS DISTINCT FROM 'collecting' THEN RAISE EXCEPTION 'Readings can only be recorded while the study is collecting' USING ERRCODE = 'QM034'; END IF;
  IF v_type = 'attribute' THEN
    IF NEW.decision IS NULL OR NEW.value IS NOT NULL THEN RAISE EXCEPTION 'An attribute study takes an accept or reject decision' USING ERRCODE = 'QM034'; END IF;
  ELSE
    IF NEW.value IS NULL OR NEW.decision IS NOT NULL THEN RAISE EXCEPTION 'This study takes a measured value' USING ERRCODE = 'QM034'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER msa_study_measurements_rules BEFORE INSERT OR UPDATE OR DELETE ON public.msa_study_measurements FOR EACH ROW EXECUTE FUNCTION app.msa_measurement_rules();

CREATE FUNCTION app.msa_result_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'A frozen result is never changed or deleted. Repeat the study instead.' USING ERRCODE = 'QM034';
END $$;
CREATE TRIGGER msa_study_results_frozen BEFORE UPDATE OR DELETE ON public.msa_study_results FOR EACH ROW EXECUTE FUNCTION app.msa_result_frozen();

-- ---------------------------------------------------------------------------
-- RLS and grants: read only, site-scoped through the gauge
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.msa_study_site(p_study uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app.gauge_site(s.gauge_id) FROM public.msa_studies s WHERE s.id = p_study
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['msa_studies', 'msa_study_appraisers', 'msa_study_parts', 'msa_study_measurements', 'msa_study_results'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION app.stamp_created()', t || '_stamp', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.touch_updated()', t || '_touch', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change()', t || '_org_immutable', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
  END LOOP;
END $$;
-- Audited: every change of a study, its design and its result. A reading is audited when it is entered or overwritten (the empty cells made at the start are not news).
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.msa_studies FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.msa_study_appraisers FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.msa_study_parts FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
CREATE TRIGGER audit_changes AFTER UPDATE OR DELETE ON public.msa_study_measurements FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.msa_study_results FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');

CREATE POLICY msa_studies_select ON public.msa_studies FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'calibration.read', app.gauge_site(gauge_id)));
CREATE POLICY msa_study_appraisers_select ON public.msa_study_appraisers FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'calibration.read', app.msa_study_site(study_id)));
CREATE POLICY msa_study_parts_select ON public.msa_study_parts FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'calibration.read', app.msa_study_site(study_id)));
CREATE POLICY msa_study_measurements_select ON public.msa_study_measurements FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'calibration.read', app.msa_study_site(study_id)));
CREATE POLICY msa_study_results_select ON public.msa_study_results FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'calibration.read', app.msa_study_site(study_id)));

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
-- The study, checked for the person: not found unless they may read it at its site, refused unless they hold the permission asked for.
CREATE FUNCTION app.msa_study_for(p_id uuid, p_permission text, p_lock boolean DEFAULT false) RETURNS public.msa_studies
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.msa_studies%ROWTYPE;
BEGIN
  IF p_lock THEN SELECT * INTO s FROM public.msa_studies WHERE id = p_id FOR UPDATE;
  ELSE SELECT * INTO s FROM public.msa_studies WHERE id = p_id; END IF;
  IF NOT FOUND OR NOT app.is_member(s.organisation_id) OR NOT app.has_permission(s.organisation_id, 'calibration.read', app.gauge_site(s.gauge_id)) THEN
    RAISE EXCEPTION 'Study not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_permission <> 'calibration.read' AND NOT app.has_permission(s.organisation_id, p_permission, app.gauge_site(s.gauge_id)) THEN
    RAISE EXCEPTION 'You are not allowed to do that on this study' USING ERRCODE = '42501';
  END IF;
  RETURN s;
END $$;

-- A number from a JSON object: a JSON number or a numeric string; absent or null gives null.
CREATE FUNCTION app.msa_number(p_data jsonb, p_key text) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v_text text; v_n numeric;
BEGIN
  IF NOT (p_data ? p_key) OR jsonb_typeof(p_data -> p_key) = 'null' THEN RETURN NULL; END IF;
  IF jsonb_typeof(p_data -> p_key) NOT IN ('number', 'string') THEN RAISE EXCEPTION '% must be a number', p_key USING ERRCODE = 'QM034'; END IF;
  v_text := btrim(p_data ->> p_key);
  IF v_text IS NULL OR v_text !~ '^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$' THEN RAISE EXCEPTION '% must be a number', p_key USING ERRCODE = 'QM034'; END IF;
  v_n := v_text::numeric;
  IF abs(v_n) >= 1e12 THEN RAISE EXCEPTION '% is too large', p_key USING ERRCODE = 'QM034'; END IF;
  RETURN v_n;
END $$;

-- A whole number from a JSON object (absent or null gives null).
CREATE FUNCTION app.msa_int(p_data jsonb, p_key text) RETURNS integer
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v_n numeric := app.msa_number(p_data, p_key);
BEGIN
  IF v_n IS NULL THEN RETURN NULL; END IF;
  IF v_n <> trunc(v_n) OR abs(v_n) > 1000000 THEN RAISE EXCEPTION '% must be a whole number', p_key USING ERRCODE = 'QM034'; END IF;
  RETURN v_n::integer;
END $$;

-- The next reference, MSA-YY-NNNN.
CREATE FUNCTION app.next_msa_reference(p_organisation_id uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_year integer := extract(year FROM current_date)::integer; v_n integer;
BEGIN
  INSERT INTO app.msa_study_counters AS c (organisation_id, year, last_value) VALUES (p_organisation_id, v_year, 1)
  ON CONFLICT (organisation_id, year) DO UPDATE SET last_value = c.last_value + 1 RETURNING last_value INTO v_n;
  RETURN 'MSA-' || to_char(v_year % 100, 'FM00') || '-' || app.pad_number(v_n, 4);
END $$;

-- Replace the design of a draft study with what the object says; keys present are set (null clears an optional one), absent keys keep what is there.
-- Keys: characteristicName, characteristicKey, operationCode, partId, unitCode, nominal, lowerLimit, upperLimit, partCount, appraiserCount, trialCount, sigmaMultiplier,
-- interactionAlpha, referenceValue, kPercent, lMultiplier, appraisers [{employeeId?, name?}], parts [{label?, referenceDecision?}]. An array sets its count; a count with no
-- array makes default names.
CREATE FUNCTION app.msa_write_design(p_study uuid, p_data jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  s public.msa_studies%ROWTYPE; k text; e jsonb; v_i integer; v_n integer;
  v_name text; v_key text; v_op text; v_part uuid; v_unit text; v_nominal numeric; v_lower numeric; v_upper numeric; v_ref numeric;
  v_parts integer; v_appraisers integer; v_trials integer; v_sigma numeric; v_alpha numeric; v_kp numeric; v_l numeric;
  v_new_appraisers boolean; v_new_parts boolean; v_emp_id uuid; v_emp_name text; v_label text; v_ename text;
BEGIN
  SELECT * INTO s FROM public.msa_studies WHERE id = p_study FOR UPDATE;
  IF s.status <> 'draft' THEN RAISE EXCEPTION '% is % and its design cannot change', s.reference, s.status USING ERRCODE = 'QM034'; END IF;
  FOR k IN SELECT jsonb_object_keys(p_data) LOOP
    IF k NOT IN ('characteristicName', 'characteristicKey', 'operationCode', 'partId', 'unitCode', 'nominal', 'lowerLimit', 'upperLimit', 'partCount', 'appraiserCount', 'trialCount',
                 'sigmaMultiplier', 'interactionAlpha', 'referenceValue', 'kPercent', 'lMultiplier', 'appraisers', 'parts') THEN
      RAISE EXCEPTION 'Unknown field %', k USING ERRCODE = 'QM034';
    END IF;
  END LOOP;

  v_name := CASE WHEN p_data ? 'characteristicName' THEN btrim(coalesce(p_data ->> 'characteristicName', '')) ELSE s.characteristic_name END;
  IF length(v_name) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'Name what is being measured (up to 200 characters)' USING ERRCODE = 'QM034'; END IF;
  v_key := CASE WHEN p_data ? 'characteristicKey' THEN nullif(btrim(coalesce(p_data ->> 'characteristicKey', '')), '') ELSE s.characteristic_key END;
  v_op := CASE WHEN p_data ? 'operationCode' THEN nullif(btrim(coalesce(p_data ->> 'operationCode', '')), '') ELSE s.operation_code END;
  IF length(v_key) > 100 OR length(v_op) > 40 THEN RAISE EXCEPTION 'The characteristic key is up to 100 characters and the operation code up to 40' USING ERRCODE = 'QM034'; END IF;
  v_part := CASE WHEN p_data ? 'partId' THEN nullif(p_data ->> 'partId', '')::uuid ELSE s.part_id END;
  IF v_part IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.parts WHERE id = v_part AND organisation_id = s.organisation_id) THEN
    RAISE EXCEPTION 'That part is not in this organisation' USING ERRCODE = 'QM034';
  END IF;
  v_unit := CASE WHEN p_data ? 'unitCode' THEN nullif(btrim(coalesce(p_data ->> 'unitCode', '')), '') ELSE s.unit_code END;
  IF v_unit IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.units WHERE code = v_unit) THEN RAISE EXCEPTION 'Unknown unit %', v_unit USING ERRCODE = 'QM034'; END IF;
  v_nominal := CASE WHEN p_data ? 'nominal' THEN app.msa_number(p_data, 'nominal') ELSE s.nominal END;
  v_lower := CASE WHEN p_data ? 'lowerLimit' THEN app.msa_number(p_data, 'lowerLimit') ELSE s.lower_limit END;
  v_upper := CASE WHEN p_data ? 'upperLimit' THEN app.msa_number(p_data, 'upperLimit') ELSE s.upper_limit END;
  v_ref := CASE WHEN p_data ? 'referenceValue' THEN app.msa_number(p_data, 'referenceValue') ELSE s.reference_value END;
  IF v_lower IS NOT NULL AND v_upper IS NOT NULL AND v_upper <= v_lower THEN RAISE EXCEPTION 'The upper limit must be above the lower limit' USING ERRCODE = 'QM034'; END IF;
  v_sigma := coalesce(CASE WHEN p_data ? 'sigmaMultiplier' THEN app.msa_number(p_data, 'sigmaMultiplier') ELSE s.sigma_multiplier END, 6);
  IF v_sigma NOT IN (6, 5.15) THEN RAISE EXCEPTION 'The study variation multiplier is 6 or 5.15' USING ERRCODE = 'QM034'; END IF;
  v_alpha := coalesce(CASE WHEN p_data ? 'interactionAlpha' THEN app.msa_number(p_data, 'interactionAlpha') ELSE s.interaction_alpha END, 0.05);
  IF v_alpha NOT IN (0.05, 0.25) THEN RAISE EXCEPTION 'The significance level is 0.05 or 0.25' USING ERRCODE = 'QM034'; END IF;
  v_kp := coalesce(CASE WHEN p_data ? 'kPercent' THEN app.msa_number(p_data, 'kPercent') ELSE s.k_percent END, 20);
  v_l := coalesce(CASE WHEN p_data ? 'lMultiplier' THEN app.msa_number(p_data, 'lMultiplier') ELSE s.l_multiplier END, 6);
  IF v_kp <= 0 OR v_kp > 100 THEN RAISE EXCEPTION 'K is a percentage of the tolerance, above 0 and up to 100' USING ERRCODE = 'QM034'; END IF;
  IF v_l <= 0 OR v_l > 10 THEN RAISE EXCEPTION 'L must be above 0 and up to 10' USING ERRCODE = 'QM034'; END IF;

  v_new_appraisers := p_data ? 'appraisers' AND jsonb_typeof(p_data -> 'appraisers') = 'array';
  v_new_parts := p_data ? 'parts' AND jsonb_typeof(p_data -> 'parts') = 'array';
  IF (p_data ? 'appraisers' AND NOT v_new_appraisers) OR (p_data ? 'parts' AND NOT v_new_parts) THEN RAISE EXCEPTION 'Appraisers and parts are lists' USING ERRCODE = 'QM034'; END IF;
  v_parts := CASE WHEN v_new_parts THEN jsonb_array_length(p_data -> 'parts') WHEN p_data ? 'partCount' THEN app.msa_int(p_data, 'partCount') ELSE s.part_count END;
  v_appraisers := CASE WHEN v_new_appraisers THEN jsonb_array_length(p_data -> 'appraisers') WHEN p_data ? 'appraiserCount' THEN app.msa_int(p_data, 'appraiserCount') ELSE s.appraiser_count END;
  v_trials := CASE WHEN p_data ? 'trialCount' THEN app.msa_int(p_data, 'trialCount') ELSE s.trial_count END;
  IF v_new_parts AND p_data ? 'partCount' AND app.msa_int(p_data, 'partCount') <> v_parts THEN RAISE EXCEPTION 'partCount does not match the list of parts' USING ERRCODE = 'QM034'; END IF;
  IF v_new_appraisers AND p_data ? 'appraiserCount' AND app.msa_int(p_data, 'appraiserCount') <> v_appraisers THEN RAISE EXCEPTION 'appraiserCount does not match the list of appraisers' USING ERRCODE = 'QM034'; END IF;
  IF v_parts IS NULL OR v_appraisers IS NULL OR v_trials IS NULL THEN RAISE EXCEPTION 'Give whole numbers for the design' USING ERRCODE = 'QM034'; END IF;

  BEGIN
    UPDATE public.msa_studies SET characteristic_name = v_name, characteristic_key = v_key, operation_code = v_op, part_id = v_part, unit_code = v_unit, nominal = v_nominal,
      lower_limit = v_lower, upper_limit = v_upper, reference_value = v_ref, part_count = v_parts, appraiser_count = v_appraisers, trial_count = v_trials,
      sigma_multiplier = v_sigma, interaction_alpha = v_alpha, k_percent = v_kp, l_multiplier = v_l
    WHERE id = s.id;
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION '%', CASE s.study_type
      WHEN 'grr_crossed' THEN 'A crossed gauge R&R study uses 2 to 50 parts, 2 to 10 appraisers and 2 to 10 trials'
      WHEN 'type1' THEN 'A Type 1 study uses one reference part and one appraiser, measured 2 to 500 times'
      ELSE 'An attribute study uses 2 to 200 samples, 1 to 10 appraisers and 1 to 10 trials, with at least 2 appraisers or 2 trials' END USING ERRCODE = 'QM034';
  END;

  -- Appraisers: replaced when given, or made again with default names when only the count changed.
  IF v_new_appraisers OR v_appraisers <> (SELECT count(*) FROM public.msa_study_appraisers WHERE study_id = s.id) THEN
    DELETE FROM public.msa_study_appraisers WHERE study_id = s.id;
    FOR v_i IN 1 .. v_appraisers LOOP
      e := CASE WHEN v_new_appraisers THEN p_data -> 'appraisers' -> (v_i - 1) ELSE '{}'::jsonb END;
      IF jsonb_typeof(e) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Each appraiser is an object with employeeId and / or name' USING ERRCODE = 'QM034'; END IF;
      v_ename := nullif(btrim(coalesce(e ->> 'name', '')), '');
      v_emp_id := NULL; v_emp_name := NULL;
      IF nullif(e ->> 'employeeId', '') IS NOT NULL THEN
        SELECT id, nullif(btrim(coalesce(first_name, '') || ' ' || coalesce(surname, '')), '') INTO v_emp_id, v_emp_name
        FROM public."Employees" WHERE id = (e ->> 'employeeId')::uuid AND organisation_id = s.organisation_id AND active;
        IF v_emp_id IS NULL THEN RAISE EXCEPTION 'Appraiser % is not an active employee of this organisation', v_i USING ERRCODE = 'QM034'; END IF;
        v_ename := coalesce(v_ename, v_emp_name);
      END IF;
      v_ename := coalesce(v_ename, 'Appraiser ' || v_i);
      BEGIN
        INSERT INTO public.msa_study_appraisers (organisation_id, study_id, position, employee_id, name) VALUES (s.organisation_id, s.id, v_i, v_emp_id, v_ename);
      EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'Each appraiser can be in the study once (names and employees must differ)' USING ERRCODE = 'QM034';
      END;
    END LOOP;
  END IF;

  -- Parts: the same. Reference decisions are for attribute studies only.
  IF v_new_parts OR v_parts <> (SELECT count(*) FROM public.msa_study_parts WHERE study_id = s.id) THEN
    DELETE FROM public.msa_study_parts WHERE study_id = s.id;
    FOR v_i IN 1 .. v_parts LOOP
      e := CASE WHEN v_new_parts THEN p_data -> 'parts' -> (v_i - 1) ELSE '{}'::jsonb END;
      IF jsonb_typeof(e) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Each part is an object with a label' USING ERRCODE = 'QM034'; END IF;
      IF e ? 'referenceDecision' AND jsonb_typeof(e -> 'referenceDecision') NOT IN ('boolean', 'null') THEN RAISE EXCEPTION 'A reference decision is accept (true) or reject (false)' USING ERRCODE = 'QM034'; END IF;
      IF s.study_type <> 'attribute' AND jsonb_typeof(e -> 'referenceDecision') = 'boolean' THEN RAISE EXCEPTION 'Only an attribute study has reference decisions' USING ERRCODE = 'QM034'; END IF;
      v_label := coalesce(nullif(btrim(coalesce(e ->> 'label', '')), ''), CASE s.study_type WHEN 'attribute' THEN 'Sample ' || v_i WHEN 'type1' THEN 'Reference part' ELSE 'Part ' || v_i END);
      BEGIN
        INSERT INTO public.msa_study_parts (organisation_id, study_id, position, label, reference_decision)
        VALUES (s.organisation_id, s.id, v_i, v_label, CASE WHEN jsonb_typeof(e -> 'referenceDecision') = 'boolean' THEN (e ->> 'referenceDecision')::boolean END);
      EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'Each part needs its own label' USING ERRCODE = 'QM034';
      END;
    END LOOP;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Functions people call
-- ---------------------------------------------------------------------------
-- Make a study (a draft). Keys: studyType, gaugeId (both required) and the design keys of app.msa_write_design. The characteristic's name, unit, limits and the gauge's resolution
-- are copied; nothing is looked up afterwards. Needs calibration.manage at the gauge's site.
CREATE FUNCTION app.create_msa_study(p_organisation_id uuid, p_data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE g public.gauges%ROWTYPE; v_type text; v_id uuid; v_parts integer; v_appraisers integer; v_trials integer; v_design jsonb;
BEGIN
  IF NOT app.is_member(p_organisation_id) THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Send the study as an object' USING ERRCODE = 'QM034'; END IF;
  v_type := p_data ->> 'studyType';
  IF v_type IS NULL OR v_type NOT IN ('grr_crossed', 'type1', 'attribute') THEN RAISE EXCEPTION 'The study type is grr_crossed, type1 or attribute' USING ERRCODE = 'QM034'; END IF;
  SELECT * INTO g FROM public.gauges WHERE id = nullif(p_data ->> 'gaugeId', '')::uuid AND organisation_id = p_organisation_id AND deleted_at IS NULL;
  IF NOT FOUND OR NOT app.has_permission(p_organisation_id, 'calibration.read', g.site_id) THEN RAISE EXCEPTION 'Gauge not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(p_organisation_id, 'calibration.manage', g.site_id) THEN RAISE EXCEPTION 'You are not allowed to design studies for this gauge' USING ERRCODE = '42501'; END IF;
  IF g.status IN ('retired', 'lost') THEN RAISE EXCEPTION '% is % and cannot be studied', g.asset_number, g.status USING ERRCODE = 'QM034'; END IF;

  -- A valid starting point for the type; the design object then sets everything.
  v_parts := CASE v_type WHEN 'type1' THEN 1 ELSE 2 END;
  v_appraisers := CASE v_type WHEN 'type1' THEN 1 WHEN 'attribute' THEN 1 ELSE 2 END;
  v_trials := CASE v_type WHEN 'type1' THEN 25 ELSE 2 END;
  INSERT INTO public.msa_studies (organisation_id, reference, study_type, gauge_id, characteristic_name, unit_code, gauge_resolution, part_count, appraiser_count, trial_count)
  VALUES (p_organisation_id, app.next_msa_reference(p_organisation_id), v_type, g.id, 'Characteristic', g.unit_code, g.resolution, v_parts, v_appraisers, v_trials)
  RETURNING id INTO v_id;
  -- Defaults for what the caller leaves out: a typical design for the type (10 parts x 3 appraisers x 3 trials; 30 samples; one part measured 25 times).
  v_design := p_data - 'studyType' - 'gaugeId';
  IF NOT (v_design ? 'parts') AND NOT (v_design ? 'partCount') THEN v_design := v_design || jsonb_build_object('partCount', CASE v_type WHEN 'grr_crossed' THEN 10 WHEN 'attribute' THEN 30 ELSE 1 END); END IF;
  IF NOT (v_design ? 'appraisers') AND NOT (v_design ? 'appraiserCount') THEN v_design := v_design || jsonb_build_object('appraiserCount', CASE v_type WHEN 'grr_crossed' THEN 3 ELSE 1 END); END IF;
  IF NOT (v_design ? 'trialCount') THEN v_design := v_design || jsonb_build_object('trialCount', CASE v_type WHEN 'type1' THEN 25 WHEN 'grr_crossed' THEN 3 ELSE 2 END); END IF;
  PERFORM app.msa_write_design(v_id, v_design);
  RETURN v_id;
END $$;

CREATE FUNCTION app.update_msa_design(p_id uuid, p_data jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.msa_studies%ROWTYPE;
BEGIN
  s := app.msa_study_for(p_id, 'calibration.manage', true);
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Send the design as an object' USING ERRCODE = 'QM034'; END IF;
  IF s.status <> 'draft' THEN RAISE EXCEPTION '% is % and its design cannot change', s.reference, s.status USING ERRCODE = 'QM034'; END IF;
  PERFORM app.msa_write_design(s.id, p_data);
END $$;

-- Start collecting: the design is checked, every cell is made (empty) with a repeatable random run order, and the design is locked.
CREATE FUNCTION app.start_msa_collection(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.msa_studies%ROWTYPE; g public.gauges%ROWTYPE; v_missing integer;
BEGIN
  s := app.msa_study_for(p_id, 'calibration.manage', true);
  IF s.status <> 'draft' THEN RAISE EXCEPTION '% is % and cannot be started', s.reference, s.status USING ERRCODE = 'QM034'; END IF;
  SELECT * INTO g FROM public.gauges WHERE id = s.gauge_id;
  IF g.deleted_at IS NOT NULL OR g.status IN ('retired', 'lost') THEN RAISE EXCEPTION 'The gauge can no longer be studied' USING ERRCODE = 'QM034'; END IF;
  IF s.study_type = 'type1' AND s.reference_value IS NULL THEN RAISE EXCEPTION 'A Type 1 study needs the reference value of the part' USING ERRCODE = 'QM034'; END IF;
  IF s.study_type = 'attribute' THEN
    SELECT count(*) INTO v_missing FROM public.msa_study_parts WHERE study_id = s.id AND reference_decision IS NULL;
    IF v_missing > 0 THEN RAISE EXCEPTION '% of the samples have no reference decision (accept or reject)', v_missing USING ERRCODE = 'QM034'; END IF;
  END IF;
  IF (SELECT count(*) FROM public.msa_study_parts WHERE study_id = s.id) <> s.part_count
     OR (SELECT count(*) FROM public.msa_study_appraisers WHERE study_id = s.id) <> s.appraiser_count THEN
    RAISE EXCEPTION 'The parts and appraisers do not match the design' USING ERRCODE = 'QM034';
  END IF;
  INSERT INTO public.msa_study_measurements (organisation_id, study_id, appraiser_id, part_id, trial, run_order)
  SELECT s.organisation_id, s.id, a.id, p.id, t,
         row_number() OVER (PARTITION BY a.id, t ORDER BY md5(s.id::text || ':' || a.position || ':' || t || ':' || p.position))
  FROM public.msa_study_appraisers a CROSS JOIN public.msa_study_parts p CROSS JOIN generate_series(1, s.trial_count) AS t
  WHERE a.study_id = s.id AND p.study_id = s.id;
  UPDATE public.msa_studies SET status = 'collecting', started_at = now(), started_by = auth.uid() WHERE id = s.id;
END $$;

-- Enter readings. p_cells = [{appraiser, part, trial, value | decision}], positions from 1 (what the grid and a pasted sheet both produce). Overwriting a cell while collecting is
-- allowed (audited). Variable studies take value (a number, or text such as "10.250" kept exactly as written); attribute studies take decision (true = accept).
CREATE FUNCTION app.record_msa_measurements(p_id uuid, p_cells jsonb, p_source text DEFAULT 'grid') RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.msa_studies%ROWTYPE; c jsonb; v_n integer := 0; v_a integer; v_p integer; v_t integer; v_id uuid; v_value numeric; v_decision boolean; v_seen text[] := '{}'; v_key text;
BEGIN
  s := app.msa_study_for(p_id, 'calibration.record', true);
  IF s.status <> 'collecting' THEN RAISE EXCEPTION '% is % and takes no readings', s.reference, s.status USING ERRCODE = 'QM034'; END IF;
  IF p_source NOT IN ('grid', 'paste') THEN RAISE EXCEPTION 'The source is grid or paste' USING ERRCODE = 'QM034'; END IF;
  IF jsonb_typeof(p_cells) IS DISTINCT FROM 'array' OR jsonb_array_length(p_cells) NOT BETWEEN 1 AND 5000 THEN RAISE EXCEPTION 'Send 1 to 5000 readings as a list' USING ERRCODE = 'QM034'; END IF;
  FOR c IN SELECT * FROM jsonb_array_elements(p_cells) LOOP
    IF jsonb_typeof(c) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Each reading is an object' USING ERRCODE = 'QM034'; END IF;
    v_a := app.msa_int(c, 'appraiser'); v_p := app.msa_int(c, 'part'); v_t := app.msa_int(c, 'trial');
    IF v_a IS NULL OR v_p IS NULL OR v_t IS NULL THEN RAISE EXCEPTION 'Each reading names its appraiser, part and trial' USING ERRCODE = 'QM034'; END IF;
    v_key := v_a || '/' || v_p || '/' || v_t;
    IF v_key = ANY (v_seen) THEN RAISE EXCEPTION 'Appraiser %, part %, trial % is given twice', v_a, v_p, v_t USING ERRCODE = 'QM034'; END IF;
    v_seen := v_seen || v_key;
    SELECT m.id INTO v_id FROM public.msa_study_measurements m
      JOIN public.msa_study_appraisers a ON a.id = m.appraiser_id JOIN public.msa_study_parts p ON p.id = m.part_id
    WHERE m.study_id = s.id AND a.position = v_a AND p.position = v_p AND m.trial = v_t;
    IF v_id IS NULL THEN RAISE EXCEPTION 'There is no such reading: appraiser %, part %, trial %', v_a, v_p, v_t USING ERRCODE = 'QM034'; END IF;
    IF s.study_type = 'attribute' THEN
      IF jsonb_typeof(c -> 'decision') IS DISTINCT FROM 'boolean' OR c ? 'value' THEN RAISE EXCEPTION 'An attribute study takes decision: true (accept) or false (reject)' USING ERRCODE = 'QM034'; END IF;
      v_decision := (c ->> 'decision')::boolean; v_value := NULL;
    ELSE
      v_value := app.msa_number(c, 'value');
      IF v_value IS NULL OR c ? 'decision' THEN RAISE EXCEPTION 'This study takes a measured value' USING ERRCODE = 'QM034'; END IF;
      v_decision := NULL;
    END IF;
    UPDATE public.msa_study_measurements SET value = v_value, decision = v_decision, source = p_source, entered_at = now(), entered_by = auth.uid() WHERE id = v_id;
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $$;

CREATE FUNCTION app.cancel_msa_study(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.msa_studies%ROWTYPE; v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  s := app.msa_study_for(p_id, 'calibration.manage', true);
  IF s.status NOT IN ('draft', 'collecting') THEN RAISE EXCEPTION '% is % and cannot be cancelled', s.reference, s.status USING ERRCODE = 'QM034'; END IF;
  IF length(v_reason) NOT BETWEEN 3 AND 500 THEN RAISE EXCEPTION 'Say why it is cancelled (3 to 500 characters)' USING ERRCODE = 'QM034'; END IF;
  UPDATE public.msa_studies SET status = 'cancelled', cancel_reason = v_reason, cancelled_at = now(), cancelled_by = auth.uid() WHERE id = s.id;
END $$;

-- A repeat: a new draft with the same gauge, characteristic and design (appraisers and parts copied, no readings). Only from a completed study.
CREATE FUNCTION app.repeat_msa_study(p_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.msa_studies%ROWTYPE; g public.gauges%ROWTYPE; v_id uuid;
BEGIN
  s := app.msa_study_for(p_id, 'calibration.manage', true);
  IF s.status <> 'completed' THEN RAISE EXCEPTION '% is % and only a completed study is repeated', s.reference, s.status USING ERRCODE = 'QM034'; END IF;
  SELECT * INTO g FROM public.gauges WHERE id = s.gauge_id;
  IF g.deleted_at IS NOT NULL OR g.status IN ('retired', 'lost') THEN RAISE EXCEPTION 'The gauge can no longer be studied' USING ERRCODE = 'QM034'; END IF;
  INSERT INTO public.msa_studies (organisation_id, reference, study_type, gauge_id, part_id, characteristic_key, operation_code, characteristic_name, unit_code, nominal, lower_limit, upper_limit,
    gauge_resolution, part_count, appraiser_count, trial_count, sigma_multiplier, interaction_alpha, reference_value, k_percent, l_multiplier, repeat_of_id)
  VALUES (s.organisation_id, app.next_msa_reference(s.organisation_id), s.study_type, s.gauge_id, s.part_id, s.characteristic_key, s.operation_code, s.characteristic_name, s.unit_code, s.nominal,
    s.lower_limit, s.upper_limit, g.resolution, s.part_count, s.appraiser_count, s.trial_count, s.sigma_multiplier, s.interaction_alpha, s.reference_value, s.k_percent, s.l_multiplier, s.id)
  RETURNING id INTO v_id;
  INSERT INTO public.msa_study_appraisers (organisation_id, study_id, position, employee_id, name)
  SELECT a.organisation_id, v_id, a.position, e.id, a.name
  FROM public.msa_study_appraisers a LEFT JOIN public."Employees" e ON e.id = a.employee_id AND e.organisation_id = a.organisation_id AND e.active
  WHERE a.study_id = s.id;
  INSERT INTO public.msa_study_parts (organisation_id, study_id, position, label, reference_decision)
  SELECT p.organisation_id, v_id, p.position, p.label, p.reference_decision FROM public.msa_study_parts p WHERE p.study_id = s.id;
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------
-- Completing: API login only
-- ---------------------------------------------------------------------------
-- The one definition of the text a result is hashed from: the design and options, every part's reference decision and every cell in a fixed order. The API builds the same text from
-- the rows it read and hashes it (SHA-256, lower-case hex); the database compares that with the hash of what it holds now. Numbers are written exactly as stored.
CREATE FUNCTION app.msa_data_canonical(p_study uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT concat_ws(E'\n',
    'v1|' || s.study_type || '|' || s.part_count || '|' || s.appraiser_count || '|' || s.trial_count || '|' || coalesce(s.nominal::text, '') || '|' || coalesce(s.lower_limit::text, '') || '|'
      || coalesce(s.upper_limit::text, '') || '|' || coalesce(s.gauge_resolution::text, '') || '|' || s.sigma_multiplier::text || '|' || s.interaction_alpha::text || '|'
      || coalesce(s.reference_value::text, '') || '|' || s.k_percent::text || '|' || s.l_multiplier::text,
    (SELECT string_agg('P|' || p.position || '|' || CASE p.reference_decision WHEN true THEN 'a' WHEN false THEN 'r' ELSE '' END, E'\n' ORDER BY p.position) FROM public.msa_study_parts p WHERE p.study_id = s.id),
    (SELECT string_agg('C|' || a.position || '|' || p.position || '|' || m.trial || '|' || CASE WHEN m.decision IS NOT NULL THEN CASE WHEN m.decision THEN 'a' ELSE 'r' END ELSE coalesce(m.value::text, '') END,
                       E'\n' ORDER BY a.position, p.position, m.trial)
       FROM public.msa_study_measurements m JOIN public.msa_study_appraisers a ON a.id = m.appraiser_id JOIN public.msa_study_parts p ON p.id = m.part_id WHERE m.study_id = s.id))
  FROM public.msa_studies s WHERE s.id = p_study
$$;

CREATE FUNCTION app.system_complete_msa_study(
  p_organisation_id uuid, p_study uuid, p_person uuid, p_conclusion text, p_note text, p_valid_until date, p_result jsonb, p_data_hash text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  s public.msa_studies%ROWTYPE; v_claims text := coalesce(current_setting('request.jwt.claims', true), ''); v_empty integer; v_verdict text; v_valid date; v_note text := btrim(coalesce(p_note, ''));
BEGIN
  SELECT * INTO s FROM public.msa_studies WHERE id = p_study FOR UPDATE;
  IF NOT FOUND OR s.organisation_id IS DISTINCT FROM p_organisation_id THEN RAISE EXCEPTION 'Study not found' USING ERRCODE = 'P0002'; END IF;
  -- Act as the person for the permission check and the stamps, then put the claims back.
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', p_person, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  IF NOT app.is_member(s.organisation_id) OR NOT app.has_permission(s.organisation_id, 'calibration.manage', app.gauge_site(s.gauge_id)) THEN
    RAISE EXCEPTION 'You are not allowed to complete studies for this gauge' USING ERRCODE = '42501';
  END IF;
  IF s.status <> 'collecting' THEN RAISE EXCEPTION '% is % and cannot be completed', s.reference, s.status USING ERRCODE = 'QM034'; END IF;
  SELECT count(*) INTO v_empty FROM public.msa_study_measurements WHERE study_id = s.id AND value IS NULL AND decision IS NULL;
  IF v_empty > 0 THEN RAISE EXCEPTION '% readings are still missing', v_empty USING ERRCODE = 'QM034'; END IF;
  IF p_data_hash IS DISTINCT FROM encode(sha256(convert_to(app.msa_data_canonical(s.id), 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'The result was not worked out from the readings now stored. Open the study again and complete it again.' USING ERRCODE = 'QM034';
  END IF;
  IF p_conclusion IS NULL OR p_conclusion NOT IN ('accepted', 'accepted_with_conditions', 'not_accepted') THEN RAISE EXCEPTION 'The conclusion is accepted, accepted with conditions or not accepted' USING ERRCODE = 'QM034'; END IF;
  IF length(v_note) NOT BETWEEN 3 AND 2000 THEN RAISE EXCEPTION 'Write the conclusion (3 to 2000 characters)' USING ERRCODE = 'QM034'; END IF;
  v_valid := coalesce(p_valid_until, (current_date + interval '12 months')::date);
  IF v_valid < current_date OR v_valid > (current_date + interval '5 years')::date THEN RAISE EXCEPTION 'The study can be valid from today up to five years' USING ERRCODE = 'QM034'; END IF;
  IF jsonb_typeof(p_result) IS DISTINCT FROM 'object' OR length(p_result::text) > 1000000 THEN RAISE EXCEPTION 'The result must be an object under 1 MB' USING ERRCODE = 'QM034'; END IF;
  IF coalesce(p_result ->> 'algorithm', '') = '' OR coalesce(p_result ->> 'criteria', '') = '' THEN RAISE EXCEPTION 'The result must name its algorithm version and criteria' USING ERRCODE = 'QM034'; END IF;
  v_verdict := coalesce(nullif(p_result #>> '{verdict,band}', ''), 'not_judged');
  IF v_verdict NOT IN ('acceptable', 'marginal', 'unacceptable', 'not_judged') THEN RAISE EXCEPTION 'The result''s verdict is not recognised' USING ERRCODE = 'QM034'; END IF;

  INSERT INTO public.msa_study_results (organisation_id, study_id, algorithm_version, criteria_id, verdict, result, data_hash)
  VALUES (s.organisation_id, s.id, p_result ->> 'algorithm', p_result ->> 'criteria', v_verdict, p_result, p_data_hash);
  UPDATE public.msa_studies SET status = 'completed', completed_at = now(), completed_by = p_person, conclusion = p_conclusion, conclusion_note = v_note, valid_until = v_valid WHERE id = s.id;
  PERFORM app.emit_event(s.organisation_id, 'msa.study.completed', 'msa_study', s.id, jsonb_build_object('reference', s.reference, 'studyType', s.study_type, 'gaugeId', s.gauge_id,
    'verdict', v_verdict, 'conclusion', p_conclusion));
  PERFORM set_config('request.jwt.claims', v_claims, true);
END $$;

REVOKE ALL ON FUNCTION app.msa_study_rules(), app.msa_child_rules(), app.msa_measurement_rules(), app.msa_result_frozen(), app.msa_study_site(uuid), app.msa_study_for(uuid, text, boolean),
  app.msa_number(jsonb, text), app.msa_int(jsonb, text), app.next_msa_reference(uuid), app.msa_write_design(uuid, jsonb), app.msa_data_canonical(uuid),
  app.create_msa_study(uuid, jsonb), app.update_msa_design(uuid, jsonb), app.start_msa_collection(uuid), app.record_msa_measurements(uuid, jsonb, text),
  app.cancel_msa_study(uuid, text), app.repeat_msa_study(uuid),
  app.system_complete_msa_study(uuid, uuid, uuid, text, text, date, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.msa_study_site(uuid), app.create_msa_study(uuid, jsonb), app.update_msa_design(uuid, jsonb), app.start_msa_collection(uuid),
  app.record_msa_measurements(uuid, jsonb, text), app.cancel_msa_study(uuid, text), app.repeat_msa_study(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION app.system_complete_msa_study(uuid, uuid, uuid, text, text, date, jsonb, text) TO qms_api;
