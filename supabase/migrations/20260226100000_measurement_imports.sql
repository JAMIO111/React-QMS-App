-- CMM and measurement file ingestion, slice CM1 (docs/cmm-ingestion-plan.md, decisions C1–C15 agreed 2026-11-14).
--
-- * measurement_import_profiles (+ frozen _versions): how a table-style report file is read (columns, separators, header fields), with an
--   optional default gauge (the CMM). Written only by app.save_measurement_profile / retire / reactivate (process_control.manage).
-- * measurement_feature_maps: a part's CMM feature name -> characteristic_key, remembered for later files. Ended, never deleted.
-- * inspection_imports (IMP-YY-NNNN), inspection_import_units (one per part measured in the file), inspection_import_rows (one per feature):
--   a file parsed and matched by the API is stored as a *preview*; nothing is a reading until it is applied.
-- * Applying: app.begin_inspection_import_apply marks the import `applying` for this transaction only; the API then records the samples and
--   readings through the normal inspection path (so every reading rule, gauge check, sampling plan and SPC alert runs unchanged), each reading
--   carrying `import_id`; app.finish_inspection_import_apply checks that exactly the matched values were recorded and marks it applied.
--   A deferred trigger refuses to commit an import still `applying`.
-- * Fortress's frozen limits decide pass/fail; the file's nominal and limits are kept only to flag a mismatch, which must be confirmed.
-- * The original file is kept in the private bucket `inspection-files` at <org>/inspection/<inspection id>/<uuid>-<name>.
-- No table writes for people: SECURITY DEFINER functions only. Errors QM008 (-> 409 inspection_rule), another organisation P0002 (-> 404).

-- ---------------------------------------------------------------------------
-- Numbering: IMP-YY-NNNN per organisation and year
-- ---------------------------------------------------------------------------
CREATE TABLE app.inspection_import_counters (
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  year integer NOT NULL,
  last_value integer NOT NULL DEFAULT 0,
  PRIMARY KEY (organisation_id, year)
);
REVOKE ALL ON app.inspection_import_counters FROM PUBLIC, anon, authenticated;

CREATE FUNCTION app.next_inspection_import_reference(p_organisation_id uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_year integer := extract(year FROM current_date)::integer; v_n integer;
BEGIN
  INSERT INTO app.inspection_import_counters AS c (organisation_id, year, last_value) VALUES (p_organisation_id, v_year, 1)
  ON CONFLICT (organisation_id, year) DO UPDATE SET last_value = c.last_value + 1 RETURNING last_value INTO v_n;
  RETURN 'IMP-' || lpad((v_year % 100)::text, 2, '0') || '-' || app.pad_number(v_n, 4);
END $$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE public.measurement_import_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80 AND name = trim(name)),
  description text CHECK (description IS NULL OR length(description) <= 500),
  format text NOT NULL CHECK (format IN ('table', 'qif')),
  current_version integer NOT NULL DEFAULT 1 CHECK (current_version >= 1),
  default_gauge_id uuid,
  active boolean NOT NULL DEFAULT true,
  retired_at timestamptz,
  retired_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  retired_reason text CHECK (retired_reason IS NULL OR length(trim(retired_reason)) BETWEEN 3 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT measurement_import_profiles_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT measurement_import_profiles_gauge_fkey FOREIGN KEY (default_gauge_id, organisation_id) REFERENCES public.gauges (id, organisation_id),
  CONSTRAINT measurement_import_profiles_retired CHECK (active = (retired_at IS NULL) AND active = (retired_reason IS NULL))
);
CREATE UNIQUE INDEX measurement_import_profiles_name_key ON public.measurement_import_profiles (organisation_id, lower(name)) WHERE active;

CREATE TABLE public.measurement_import_profile_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  profile_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  format text NOT NULL CHECK (format IN ('table', 'qif')),
  settings jsonb NOT NULL CHECK (jsonb_typeof(settings) = 'object' AND pg_column_size(settings) <= 51200),
  reason text CHECK (reason IS NULL OR length(trim(reason)) BETWEEN 3 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT measurement_import_profile_versions_key UNIQUE (profile_id, version),
  CONSTRAINT measurement_import_profile_versions_profile_fkey FOREIGN KEY (profile_id, organisation_id)
    REFERENCES public.measurement_import_profiles (id, organisation_id),
  CONSTRAINT measurement_import_profile_versions_reason CHECK (version = 1 OR reason IS NOT NULL)
);

CREATE TABLE public.measurement_feature_maps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  part_id uuid NOT NULL,
  profile_id uuid,
  feature_name text NOT NULL CHECK (length(trim(feature_name)) BETWEEN 1 AND 200 AND feature_name = trim(feature_name)),
  characteristic_key text NOT NULL CHECK (characteristic_key ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  ended_at timestamptz,
  ended_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT measurement_feature_maps_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT measurement_feature_maps_part_fkey FOREIGN KEY (part_id, organisation_id) REFERENCES public.parts (id, organisation_id),
  CONSTRAINT measurement_feature_maps_profile_fkey FOREIGN KEY (profile_id, organisation_id) REFERENCES public.measurement_import_profiles (id, organisation_id)
);
CREATE UNIQUE INDEX measurement_feature_maps_live_key ON public.measurement_feature_maps
  (part_id, coalesce(profile_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(feature_name)) WHERE ended_at IS NULL;

CREATE TABLE public.inspection_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  inspection_record_id uuid NOT NULL,
  reference text NOT NULL,
  status text NOT NULL DEFAULT 'previewed' CHECK (status IN ('previewed', 'applying', 'applied', 'discarded')),
  format text NOT NULL CHECK (format IN ('table', 'qif')),
  profile_id uuid,
  profile_version integer,
  file_path text NOT NULL CHECK (length(file_path) BETWEEN 1 AND 500),
  file_name text NOT NULL CHECK (length(trim(file_name)) BETWEEN 1 AND 255),
  file_sha256 text NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 0 AND 26214400),
  gauge_id uuid,
  header jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(header) = 'object' AND pg_column_size(header) <= 16384),
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(warnings) = 'array' AND pg_column_size(warnings) <= 65536),
  mismatches_confirmed_at timestamptz,
  mismatches_confirmed_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  apply_mode text CHECK (apply_mode IN ('new', 'retest', 'correct')),
  apply_reason text CHECK (apply_reason IS NULL OR length(trim(apply_reason)) BETWEEN 3 AND 1000),
  gauge_override_reason text CHECK (gauge_override_reason IS NULL OR length(trim(gauge_override_reason)) BETWEEN 1 AND 1000),
  applied_at timestamptz,
  applied_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  discarded_at timestamptz,
  discarded_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  discard_reason text CHECK (discard_reason IS NULL OR length(discard_reason) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT inspection_imports_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT inspection_imports_id_record_key UNIQUE (id, inspection_record_id),
  CONSTRAINT inspection_imports_reference_key UNIQUE (organisation_id, reference),
  CONSTRAINT inspection_imports_record_fkey FOREIGN KEY (inspection_record_id, organisation_id) REFERENCES public.inspection_records (id, organisation_id),
  CONSTRAINT inspection_imports_profile_fkey FOREIGN KEY (profile_id, organisation_id) REFERENCES public.measurement_import_profiles (id, organisation_id),
  CONSTRAINT inspection_imports_gauge_fkey FOREIGN KEY (gauge_id, organisation_id) REFERENCES public.gauges (id, organisation_id),
  CONSTRAINT inspection_imports_profile_version CHECK ((profile_id IS NULL) = (profile_version IS NULL)),
  CONSTRAINT inspection_imports_applied CHECK ((status = 'applied') = (applied_at IS NOT NULL)),
  CONSTRAINT inspection_imports_discarded CHECK ((status = 'discarded') = (discarded_at IS NOT NULL))
);
-- The same file is applied to an inspection at most once.
CREATE UNIQUE INDEX inspection_imports_file_once ON public.inspection_imports (inspection_record_id, file_sha256) WHERE status IN ('applying', 'applied');
CREATE INDEX inspection_imports_record_idx ON public.inspection_imports (inspection_record_id, created_at DESC);

CREATE TABLE public.inspection_import_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  inspection_record_id uuid NOT NULL,
  import_id uuid NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 1 AND 200),
  unit_reference text CHECK (unit_reference IS NULL OR length(unit_reference) <= 60),
  sample_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inspection_import_units_id_import_key UNIQUE (id, import_id),
  CONSTRAINT inspection_import_units_position_key UNIQUE (import_id, position),
  CONSTRAINT inspection_import_units_import_fkey FOREIGN KEY (import_id, inspection_record_id) REFERENCES public.inspection_imports (id, inspection_record_id),
  CONSTRAINT inspection_import_units_org_fkey FOREIGN KEY (import_id, organisation_id) REFERENCES public.inspection_imports (id, organisation_id),
  CONSTRAINT inspection_import_units_sample_fkey FOREIGN KEY (sample_id, inspection_record_id) REFERENCES public.inspection_samples (id, inspection_record_id)
);

CREATE TABLE public.inspection_import_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  inspection_record_id uuid NOT NULL,
  import_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 1 AND 100000),
  feature_name text NOT NULL CHECK (length(feature_name) BETWEEN 1 AND 200),
  char_number text CHECK (char_number IS NULL OR length(char_number) <= 20),
  raw jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(raw) = 'object' AND pg_column_size(raw) <= 4096),
  value_text text CHECK (value_text IS NULL OR length(value_text) <= 100),
  unit_read text CHECK (unit_read IS NULL OR length(unit_read) <= 20),
  -- The value in the characteristic's unit (converted by the API) and the file's own nominal and limits in the same unit.
  value_numeric numeric,
  value_pass boolean,
  value_count integer CHECK (value_count IS NULL OR value_count >= 0),
  file_nominal numeric,
  file_lower numeric,
  file_upper numeric,
  requirement_id uuid,
  match_kind text NOT NULL DEFAULT 'none' CHECK (match_kind IN ('balloon', 'map', 'manual', 'none')),
  -- Worked out by app.inspection_import_row_rules from the frozen requirement.
  problem text CHECK (problem IS NULL OR length(problem) <= 300),
  expected_result text CHECK (expected_result IN ('pass', 'fail')),
  mismatch boolean NOT NULL DEFAULT false,
  measurement_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inspection_import_rows_position_key UNIQUE (import_id, position),
  CONSTRAINT inspection_import_rows_import_fkey FOREIGN KEY (import_id, inspection_record_id) REFERENCES public.inspection_imports (id, inspection_record_id),
  CONSTRAINT inspection_import_rows_org_fkey FOREIGN KEY (import_id, organisation_id) REFERENCES public.inspection_imports (id, organisation_id),
  CONSTRAINT inspection_import_rows_unit_fkey FOREIGN KEY (unit_id, import_id) REFERENCES public.inspection_import_units (id, import_id),
  CONSTRAINT inspection_import_rows_requirement_fkey FOREIGN KEY (requirement_id, inspection_record_id)
    REFERENCES public.resolved_inspection_requirements (id, inspection_record_id),
  CONSTRAINT inspection_import_rows_measurement_fkey FOREIGN KEY (measurement_id, inspection_record_id)
    REFERENCES public.inspection_measurements (id, inspection_record_id),
  CONSTRAINT inspection_import_rows_match CHECK ((requirement_id IS NULL) = (match_kind = 'none')),
  CONSTRAINT inspection_import_rows_one_value CHECK (num_nonnulls(value_numeric, value_pass, value_count) <= 1)
);
-- A characteristic is matched to at most one feature of a unit.
CREATE UNIQUE INDEX inspection_import_rows_requirement_once ON public.inspection_import_rows (unit_id, requirement_id) WHERE requirement_id IS NOT NULL;
CREATE INDEX inspection_import_rows_unit_idx ON public.inspection_import_rows (unit_id);

-- Where a reading came from (null for typed readings).
ALTER TABLE public.inspection_measurements ADD COLUMN import_id uuid;
ALTER TABLE public.inspection_measurements ADD CONSTRAINT inspection_measurements_import_fkey
  FOREIGN KEY (import_id, inspection_record_id) REFERENCES public.inspection_imports (id, inspection_record_id);
CREATE INDEX inspection_measurements_import_idx ON public.inspection_measurements (import_id) WHERE import_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Rules
-- ---------------------------------------------------------------------------
-- Profile versions are frozen.
CREATE FUNCTION app.measurement_profile_version_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'A saved profile version cannot be changed; save a new version' USING ERRCODE = 'QM008';
END $$;

-- Two numbers differ beyond rounding: more than a thousandth of the tolerance band, or (without a band) a millionth of the value.
CREATE FUNCTION app.import_values_differ(p_file numeric, p_ours numeric, p_lower numeric, p_upper numeric) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p_file IS NOT NULL AND p_ours IS NOT NULL AND abs(p_file - p_ours) >
    CASE WHEN p_lower IS NOT NULL AND p_upper IS NOT NULL AND p_upper > p_lower THEN (p_upper - p_lower) / 1000
         ELSE greatest(abs(p_ours), 1) / 1000000 END
$$;

-- A row's expected result, problem and mismatch, worked out from the frozen requirement it is matched to.
CREATE FUNCTION app.inspection_import_row_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE q record; v_status text;
BEGIN
  SELECT status INTO v_status FROM public.inspection_imports WHERE id = NEW.import_id;
  IF TG_OP = 'UPDATE' THEN
    IF v_status IN ('applied', 'discarded') THEN
      RAISE EXCEPTION 'This import is %; it cannot be changed', v_status USING ERRCODE = 'QM008';
    END IF;
    IF (NEW.import_id, NEW.unit_id, NEW.position, NEW.feature_name, NEW.char_number, NEW.raw, NEW.value_text, NEW.unit_read, NEW.value_numeric,
        NEW.value_pass, NEW.value_count, NEW.file_nominal, NEW.file_lower, NEW.file_upper)
       IS DISTINCT FROM (OLD.import_id, OLD.unit_id, OLD.position, OLD.feature_name, OLD.char_number, OLD.raw, OLD.value_text, OLD.unit_read, OLD.value_numeric,
        OLD.value_pass, OLD.value_count, OLD.file_nominal, OLD.file_lower, OLD.file_upper) THEN
      RAISE EXCEPTION 'What the file says cannot be changed; only how a feature is matched' USING ERRCODE = 'QM008';
    END IF;
    IF NEW.measurement_id IS DISTINCT FROM OLD.measurement_id AND v_status <> 'applying' THEN
      RAISE EXCEPTION 'A reading is linked only while the import is applied' USING ERRCODE = 'QM008';
    END IF;
    IF NEW.requirement_id IS DISTINCT FROM OLD.requirement_id AND v_status <> 'previewed' THEN
      RAISE EXCEPTION 'Matches can be changed only before the import is applied' USING ERRCODE = 'QM008';
    END IF;
  END IF;

  NEW.problem := NULL; NEW.expected_result := NULL; NEW.mismatch := false;
  IF NEW.requirement_id IS NULL THEN
    NEW.match_kind := 'none';
    RETURN NEW;
  END IF;
  SELECT * INTO q FROM public.resolved_inspection_requirements WHERE id = NEW.requirement_id;
  IF NOT q.applicable THEN
    NEW.problem := q.name || ' does not apply to this part';
  ELSIF q.data_type = 'variable' THEN
    IF NEW.value_numeric IS NULL THEN
      NEW.problem := q.name || ' needs a measured value';
    ELSE
      NEW.expected_result := CASE WHEN (q.lower_limit IS NULL OR NEW.value_numeric >= q.lower_limit)
                                   AND (q.upper_limit IS NULL OR NEW.value_numeric <= q.upper_limit) THEN 'pass' ELSE 'fail' END;
      NEW.mismatch := app.import_values_differ(NEW.file_nominal, q.nominal, q.lower_limit, q.upper_limit)
                   OR app.import_values_differ(NEW.file_lower, q.lower_limit, q.lower_limit, q.upper_limit)
                   OR app.import_values_differ(NEW.file_upper, q.upper_limit, q.lower_limit, q.upper_limit)
                   -- A limit in the file where we have none (or none where we have one) is a difference too.
                   OR (NEW.file_lower IS NOT NULL AND q.lower_limit IS NULL) OR (NEW.file_upper IS NOT NULL AND q.upper_limit IS NULL);
    END IF;
  ELSIF q.data_type = 'count' THEN
    IF NEW.value_count IS NULL THEN
      NEW.problem := q.name || ' needs a count of defects';
    ELSE
      NEW.expected_result := CASE WHEN q.upper_limit IS NULL OR NEW.value_count <= q.upper_limit THEN 'pass' ELSE 'fail' END;
    END IF;
  ELSE
    IF NEW.value_pass IS NULL THEN
      NEW.problem := q.name || ' needs pass or fail';
    ELSE
      NEW.expected_result := CASE WHEN NEW.value_pass THEN 'pass' ELSE 'fail' END;
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Units change only to record the sample they became, and only while applying.
CREATE FUNCTION app.inspection_import_unit_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF (NEW.import_id, NEW.position, NEW.unit_reference) IS DISTINCT FROM (OLD.import_id, OLD.position, OLD.unit_reference)
     OR (SELECT status FROM public.inspection_imports WHERE id = NEW.import_id) <> 'applying' THEN
    RAISE EXCEPTION 'An import''s parts cannot be changed' USING ERRCODE = 'QM008';
  END IF;
  RETURN NEW;
END $$;

-- An applied or discarded import is frozen; what the file said never changes.
CREATE FUNCTION app.inspection_import_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF OLD.status IN ('applied', 'discarded') THEN
    RAISE EXCEPTION 'Import % is %; it cannot be changed', OLD.reference, OLD.status USING ERRCODE = 'QM008';
  END IF;
  IF (NEW.inspection_record_id, NEW.reference, NEW.format, NEW.profile_id, NEW.profile_version, NEW.file_path, NEW.file_name, NEW.file_sha256,
      NEW.size_bytes, NEW.header, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM (OLD.inspection_record_id, OLD.reference, OLD.format, OLD.profile_id, OLD.profile_version, OLD.file_path, OLD.file_name,
      OLD.file_sha256, OLD.size_bytes, OLD.header, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'What was read from the file cannot be changed' USING ERRCODE = 'QM008';
  END IF;
  IF NOT ((OLD.status = NEW.status) OR (OLD.status = 'previewed' AND NEW.status IN ('applying', 'discarded'))
          OR (OLD.status = 'applying' AND NEW.status = 'applied')) THEN
    RAISE EXCEPTION 'An import cannot go from % to %', OLD.status, NEW.status USING ERRCODE = 'QM008';
  END IF;
  RETURN NEW;
END $$;

-- At commit, nothing may be left half applied.
CREATE FUNCTION app.inspection_import_settled() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF (SELECT status FROM public.inspection_imports WHERE id = NEW.id) = 'applying' THEN
    RAISE EXCEPTION 'Import % was not finished; nothing was saved', NEW.reference USING ERRCODE = 'QM008';
  END IF;
  RETURN NULL;
END $$;

-- A reading may say it came from an import only while that import is being applied in this transaction.
CREATE FUNCTION app.inspection_measurement_import_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_import record;
BEGIN
  IF NEW.import_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO v_import FROM public.inspection_imports WHERE id = NEW.import_id;
  IF v_import.status IS DISTINCT FROM 'applying' OR NEW.import_id::text IS DISTINCT FROM nullif(current_setting('app.inspection_import', true), '') THEN
    RAISE EXCEPTION 'A reading can only come from an import while it is applied' USING ERRCODE = 'QM008';
  END IF;
  IF NEW.gauge_id IS DISTINCT FROM v_import.gauge_id THEN
    RAISE EXCEPTION 'Readings from an import are recorded with the import''s gauge' USING ERRCODE = 'QM008';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- Profiles
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.assert_measurement_gauge(p_org uuid, p_gauge uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_gauge IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.gauges WHERE id = p_gauge AND organisation_id = p_org AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'That gauge is not in this organisation''s register' USING ERRCODE = 'QM008';
  END IF;
END $$;

-- Create (p_id null) or change a profile. Body: name, description, format (fixed once created), defaultGaugeId, settings, reason.
-- A change to the format settings saves a new version and needs a reason; name, description and default gauge change freely.
CREATE FUNCTION app.save_measurement_profile(p_organisation_id uuid, p_body jsonb, p_id uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_row public.measurement_import_profiles%ROWTYPE;
  v_name text := trim(coalesce(p_body ->> 'name', ''));
  v_settings jsonb := p_body -> 'settings';
  v_reason text := nullif(trim(coalesce(p_body ->> 'reason', '')), '');
  v_gauge uuid := nullif(p_body ->> 'defaultGaugeId', '')::uuid;
  v_current jsonb;
BEGIN
  IF p_id IS NOT NULL THEN
    SELECT * INTO v_row FROM public.measurement_import_profiles WHERE id = p_id FOR UPDATE;
    IF NOT FOUND OR NOT app.is_member(v_row.organisation_id) THEN
      RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'P0002';
    END IF;
    p_organisation_id := v_row.organisation_id;
  END IF;
  IF NOT app.has_permission(p_organisation_id, 'process_control.manage') THEN
    RAISE EXCEPTION 'You may not manage measurement file profiles' USING ERRCODE = '42501';
  END IF;
  IF v_name = '' OR length(v_name) > 80 THEN
    RAISE EXCEPTION 'A profile needs a name of up to 80 characters' USING ERRCODE = 'QM008';
  END IF;
  PERFORM app.assert_measurement_gauge(p_organisation_id, v_gauge);

  IF p_id IS NULL THEN
    IF v_settings IS NULL OR jsonb_typeof(v_settings) <> 'object' THEN
      RAISE EXCEPTION 'A profile needs its settings' USING ERRCODE = 'QM008';
    END IF;
    IF coalesce(p_body ->> 'format', '') NOT IN ('table', 'qif') THEN
      RAISE EXCEPTION 'Choose how the file is laid out (table or QIF)' USING ERRCODE = 'QM008';
    END IF;
    IF EXISTS (SELECT 1 FROM public.measurement_import_profiles WHERE organisation_id = p_organisation_id AND active AND lower(name) = lower(v_name)) THEN
      RAISE EXCEPTION 'A profile called % already exists', v_name USING ERRCODE = 'QM008';
    END IF;
    INSERT INTO public.measurement_import_profiles (organisation_id, name, description, format, default_gauge_id)
      VALUES (p_organisation_id, v_name, nullif(trim(coalesce(p_body ->> 'description', '')), ''), p_body ->> 'format', v_gauge)
      RETURNING * INTO v_row;
    INSERT INTO public.measurement_import_profile_versions (organisation_id, profile_id, version, format, settings, reason)
      VALUES (p_organisation_id, v_row.id, 1, v_row.format, v_settings, v_reason);
    RETURN v_row.id;
  END IF;

  IF NOT v_row.active THEN
    RAISE EXCEPTION 'Profile % is retired; bring it back first', v_row.name USING ERRCODE = 'QM008';
  END IF;
  IF p_body ? 'format' AND p_body ->> 'format' IS DISTINCT FROM v_row.format THEN
    RAISE EXCEPTION 'A profile''s file layout cannot change; make a new profile' USING ERRCODE = 'QM008';
  END IF;
  IF EXISTS (SELECT 1 FROM public.measurement_import_profiles WHERE organisation_id = p_organisation_id AND active AND lower(name) = lower(v_name) AND id <> p_id) THEN
    RAISE EXCEPTION 'A profile called % already exists', v_name USING ERRCODE = 'QM008';
  END IF;
  SELECT settings INTO v_current FROM public.measurement_import_profile_versions WHERE profile_id = p_id AND version = v_row.current_version;
  IF v_settings IS NOT NULL AND v_settings IS DISTINCT FROM v_current THEN
    IF jsonb_typeof(v_settings) <> 'object' THEN
      RAISE EXCEPTION 'A profile needs its settings' USING ERRCODE = 'QM008';
    END IF;
    IF v_reason IS NULL OR length(v_reason) < 3 THEN
      RAISE EXCEPTION 'Say why the way the file is read is changing' USING ERRCODE = 'QM008';
    END IF;
    INSERT INTO public.measurement_import_profile_versions (organisation_id, profile_id, version, format, settings, reason)
      VALUES (p_organisation_id, p_id, v_row.current_version + 1, v_row.format, v_settings, v_reason);
    v_row.current_version := v_row.current_version + 1;
  END IF;
  UPDATE public.measurement_import_profiles
     SET name = v_name,
         description = CASE WHEN p_body ? 'description' THEN nullif(trim(coalesce(p_body ->> 'description', '')), '') ELSE description END,
         default_gauge_id = CASE WHEN p_body ? 'defaultGaugeId' THEN v_gauge ELSE default_gauge_id END,
         current_version = v_row.current_version
   WHERE id = p_id;
  RETURN p_id;
END $$;

CREATE FUNCTION app.retire_measurement_profile(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_row public.measurement_import_profiles%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.measurement_import_profiles WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(v_row.organisation_id) THEN
    RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT app.has_permission(v_row.organisation_id, 'process_control.manage') THEN
    RAISE EXCEPTION 'You may not manage measurement file profiles' USING ERRCODE = '42501';
  END IF;
  IF NOT v_row.active THEN
    RAISE EXCEPTION 'Profile % is already retired', v_row.name USING ERRCODE = 'QM008';
  END IF;
  IF length(trim(coalesce(p_reason, ''))) < 3 THEN
    RAISE EXCEPTION 'Say why the profile is retired' USING ERRCODE = 'QM008';
  END IF;
  UPDATE public.measurement_import_profiles SET active = false, retired_at = now(), retired_by = auth.uid(), retired_reason = trim(p_reason) WHERE id = p_id;
END $$;

CREATE FUNCTION app.reactivate_measurement_profile(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_row public.measurement_import_profiles%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.measurement_import_profiles WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(v_row.organisation_id) THEN
    RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT app.has_permission(v_row.organisation_id, 'process_control.manage') THEN
    RAISE EXCEPTION 'You may not manage measurement file profiles' USING ERRCODE = '42501';
  END IF;
  IF v_row.active THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM public.measurement_import_profiles WHERE organisation_id = v_row.organisation_id AND active AND lower(name) = lower(v_row.name)) THEN
    RAISE EXCEPTION 'Another profile is now called %; rename one of them first', v_row.name USING ERRCODE = 'QM008';
  END IF;
  UPDATE public.measurement_import_profiles SET active = true, retired_at = NULL, retired_by = NULL, retired_reason = NULL WHERE id = p_id;
END $$;

-- ---------------------------------------------------------------------------
-- Feature maps
-- ---------------------------------------------------------------------------
-- Remember that a part's feature (as the CMM names it) is a characteristic. Anyone who records inspections or manages control plans may save one;
-- a different characteristic for the same feature ends the old map. Returns the live map's id.
CREATE FUNCTION app.save_feature_map(p_part uuid, p_profile uuid, p_feature text, p_characteristic_key text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid; v_feature text := trim(coalesce(p_feature, '')); v_key text := upper(trim(coalesce(p_characteristic_key, ''))); v_old record; v_id uuid;
BEGIN
  SELECT organisation_id INTO v_org FROM public.parts WHERE id = p_part;
  IF v_org IS NULL OR NOT app.is_member(v_org) THEN
    RAISE EXCEPTION 'Part not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT (app.has_permission(v_org, 'process_control.manage') OR app.has_permission_somewhere(v_org, 'inspection.record')) THEN
    RAISE EXCEPTION 'You may not save feature matches' USING ERRCODE = '42501';
  END IF;
  IF p_profile IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.measurement_import_profiles WHERE id = p_profile AND organisation_id = v_org) THEN
    RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_feature = '' OR length(v_feature) > 200 THEN
    RAISE EXCEPTION 'A feature name of up to 200 characters is needed' USING ERRCODE = 'QM008';
  END IF;
  IF v_key !~ '^[A-Z][A-Z0-9_]{0,39}$' THEN
    RAISE EXCEPTION 'That is not a characteristic key' USING ERRCODE = 'QM008';
  END IF;
  SELECT id, characteristic_key INTO v_old FROM public.measurement_feature_maps
   WHERE part_id = p_part AND profile_id IS NOT DISTINCT FROM p_profile AND lower(feature_name) = lower(v_feature) AND ended_at IS NULL FOR UPDATE;
  IF FOUND AND v_old.characteristic_key = v_key THEN RETURN v_old.id; END IF;
  IF FOUND THEN
    UPDATE public.measurement_feature_maps SET ended_at = now(), ended_by = auth.uid() WHERE id = v_old.id;
  END IF;
  INSERT INTO public.measurement_feature_maps (organisation_id, part_id, profile_id, feature_name, characteristic_key)
    VALUES (v_org, p_part, p_profile, v_feature, v_key) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION app.end_feature_map(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_row public.measurement_feature_maps%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.measurement_feature_maps WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(v_row.organisation_id) THEN
    RAISE EXCEPTION 'Feature match not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT (app.has_permission(v_row.organisation_id, 'process_control.manage') OR v_row.created_by = auth.uid()) THEN
    RAISE EXCEPTION 'You may not remove this feature match' USING ERRCODE = '42501';
  END IF;
  IF v_row.ended_at IS NOT NULL THEN RETURN; END IF;
  UPDATE public.measurement_feature_maps SET ended_at = now(), ended_by = auth.uid() WHERE id = p_id;
END $$;

-- Feature maps change only by being ended.
CREATE FUNCTION app.measurement_feature_map_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF OLD.ended_at IS NOT NULL
     OR (NEW.part_id, NEW.profile_id, NEW.feature_name, NEW.characteristic_key) IS DISTINCT FROM (OLD.part_id, OLD.profile_id, OLD.feature_name, OLD.characteristic_key) THEN
    RAISE EXCEPTION 'A feature match cannot be changed; end it and save a new one' USING ERRCODE = 'QM008';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- Imports
-- ---------------------------------------------------------------------------
-- The inspection, for someone who may record readings at its site (P0002 otherwise, so another organisation's id tells nothing).
CREATE FUNCTION app.inspection_for_import(p_record uuid) RETURNS public.inspection_records
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.inspection_records%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.inspection_records WHERE id = p_record;
  IF NOT FOUND OR NOT app.has_permission(v.organisation_id, 'inspection.read', v.site_id) THEN
    RAISE EXCEPTION 'Inspection not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT app.has_permission(v.organisation_id, 'inspection.record', v.site_id) THEN
    RAISE EXCEPTION 'You may not record readings on this inspection' USING ERRCODE = '42501';
  END IF;
  RETURN v;
END $$;

CREATE FUNCTION app.import_for_update(p_import uuid) RETURNS public.inspection_imports
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.inspection_imports%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.inspection_imports WHERE id = p_import FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Import not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM app.inspection_for_import(v.inspection_record_id);
  RETURN v;
END $$;

-- A file parsed and matched by the API, stored as a preview. Body:
--   filePath, fileName, fileSha256, sizeBytes, format, profileId?, gaugeId?, header {partNumber, serial, workOrder, lot, program, operator, measuredAt, …},
--   warnings [{kind, message}], units [{position, unitReference, rows [{position, featureName, charNumber, raw, valueText, unitRead,
--   valueNumeric | valuePass | valueCount, fileNominal, fileLower, fileUpper, requirementId, matchKind}]}].
-- The part number in the header must be the inspection's part; a different work order or lot is a warning.
CREATE FUNCTION app.create_inspection_import(p_record uuid, p_body jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_rec public.inspection_records%ROWTYPE;
  v_part text;
  v_profile public.measurement_import_profiles%ROWTYPE;
  v_import uuid;
  v_unit uuid;
  u jsonb; r jsonb;
  v_header jsonb := coalesce(p_body -> 'header', '{}'::jsonb);
  v_warnings jsonb := coalesce(p_body -> 'warnings', '[]'::jsonb);
  v_path text := coalesce(p_body ->> 'filePath', '');
  v_rows integer := 0;
  v_req uuid;
BEGIN
  v_rec := app.inspection_for_import(p_record);
  PERFORM app.assert_inspection_open(p_record);
  IF jsonb_typeof(v_header) <> 'object' OR jsonb_typeof(v_warnings) <> 'array' THEN
    RAISE EXCEPTION 'The file''s header and warnings are not in the expected shape' USING ERRCODE = 'QM008';
  END IF;
  IF split_part(v_path, '/', 1) <> v_rec.organisation_id::text OR split_part(v_path, '/', 2) <> 'inspection'
     OR split_part(v_path, '/', 3) <> p_record::text OR split_part(v_path, '/', 4) = '' THEN
    RAISE EXCEPTION 'The file must be stored in this inspection''s folder' USING ERRCODE = 'QM008';
  END IF;
  IF trim(coalesce(p_body ->> 'fileName', '')) = '' OR lower(coalesce(p_body ->> 'fileSha256', '')) !~ '^[0-9a-f]{64}$'
     OR coalesce((p_body ->> 'sizeBytes')::bigint, -1) NOT BETWEEN 0 AND 26214400 THEN
    RAISE EXCEPTION 'The file''s name, fingerprint and size (at most 25 MB) are needed' USING ERRCODE = 'QM008';
  END IF;
  IF nullif(p_body ->> 'profileId', '') IS NULL AND coalesce(p_body ->> 'format', '') NOT IN ('table', 'qif') THEN
    RAISE EXCEPTION 'Say how the file was read (a profile, or QIF)' USING ERRCODE = 'QM008';
  END IF;

  SELECT part_number INTO v_part FROM public.parts WHERE id = v_rec.part_id;
  IF nullif(trim(coalesce(v_header ->> 'partNumber', '')), '') IS NOT NULL AND lower(trim(v_header ->> 'partNumber')) <> lower(v_part) THEN
    RAISE EXCEPTION 'This file is for part %; this inspection is for %', trim(v_header ->> 'partNumber'), v_part USING ERRCODE = 'QM008';
  END IF;
  IF nullif(trim(coalesce(v_header ->> 'workOrder', '')), '') IS NOT NULL AND v_rec.work_order IS NOT NULL
     AND lower(trim(v_header ->> 'workOrder')) <> lower(v_rec.work_order) THEN
    v_warnings := v_warnings || jsonb_build_array(jsonb_build_object('kind', 'header',
      'message', format('The file names work order %s; this inspection is on %s', trim(v_header ->> 'workOrder'), v_rec.work_order)));
  END IF;
  IF nullif(trim(coalesce(v_header ->> 'lot', '')), '') IS NOT NULL AND v_rec.lot IS NOT NULL AND lower(trim(v_header ->> 'lot')) <> lower(v_rec.lot) THEN
    v_warnings := v_warnings || jsonb_build_array(jsonb_build_object('kind', 'header',
      'message', format('The file names lot %s; this inspection is on lot %s', trim(v_header ->> 'lot'), v_rec.lot)));
  END IF;

  IF nullif(p_body ->> 'profileId', '') IS NOT NULL THEN
    SELECT * INTO v_profile FROM public.measurement_import_profiles WHERE id = (p_body ->> 'profileId')::uuid AND organisation_id = v_rec.organisation_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Profile not found' USING ERRCODE = 'P0002';
    END IF;
    IF NOT v_profile.active THEN
      RAISE EXCEPTION 'Profile % is retired', v_profile.name USING ERRCODE = 'QM008';
    END IF;
  END IF;
  PERFORM app.assert_measurement_gauge(v_rec.organisation_id, nullif(p_body ->> 'gaugeId', '')::uuid);

  IF jsonb_typeof(p_body -> 'units') <> 'array' OR jsonb_array_length(p_body -> 'units') = 0 THEN
    RAISE EXCEPTION 'Nothing was read from the file' USING ERRCODE = 'QM008';
  END IF;
  IF jsonb_array_length(p_body -> 'units') > 200 THEN
    RAISE EXCEPTION 'A file can hold at most 200 parts' USING ERRCODE = 'QM008';
  END IF;

  INSERT INTO public.inspection_imports (organisation_id, inspection_record_id, reference, format, profile_id, profile_version, file_path, file_name,
                                         file_sha256, size_bytes, gauge_id, header, warnings)
    VALUES (v_rec.organisation_id, p_record, app.next_inspection_import_reference(v_rec.organisation_id),
            coalesce(v_profile.format, p_body ->> 'format'), v_profile.id, v_profile.current_version, v_path, trim(coalesce(p_body ->> 'fileName', '')),
            lower(coalesce(p_body ->> 'fileSha256', '')), coalesce((p_body ->> 'sizeBytes')::bigint, -1),
            coalesce(nullif(p_body ->> 'gaugeId', '')::uuid, v_profile.default_gauge_id), v_header, v_warnings)
    RETURNING id INTO v_import;

  FOR u IN SELECT value FROM jsonb_array_elements(p_body -> 'units') LOOP
    INSERT INTO public.inspection_import_units (organisation_id, inspection_record_id, import_id, position, unit_reference)
      VALUES (v_rec.organisation_id, p_record, v_import, (u ->> 'position')::integer, nullif(trim(coalesce(u ->> 'unitReference', '')), ''))
      RETURNING id INTO v_unit;
    IF jsonb_typeof(u -> 'rows') <> 'array' THEN
      RAISE EXCEPTION 'Part % of the file has no features', u ->> 'position' USING ERRCODE = 'QM008';
    END IF;
    FOR r IN SELECT value FROM jsonb_array_elements(u -> 'rows') LOOP
      v_rows := v_rows + 1;
      IF v_rows > 5000 THEN
        RAISE EXCEPTION 'A file can hold at most 5,000 features' USING ERRCODE = 'QM008';
      END IF;
      v_req := nullif(r ->> 'requirementId', '')::uuid;
      IF v_req IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.resolved_inspection_requirements WHERE id = v_req AND inspection_record_id = p_record) THEN
        RAISE EXCEPTION 'Feature % is matched to a check that is not on this inspection', r ->> 'featureName' USING ERRCODE = 'QM008';
      END IF;
      INSERT INTO public.inspection_import_rows (organisation_id, inspection_record_id, import_id, unit_id, position, feature_name, char_number, raw,
                                                 value_text, unit_read, value_numeric, value_pass, value_count, file_nominal, file_lower, file_upper,
                                                 requirement_id, match_kind)
        VALUES (v_rec.organisation_id, p_record, v_import, v_unit, (r ->> 'position')::integer, coalesce(nullif(r ->> 'featureName', ''), '(no name)'),
                nullif(r ->> 'charNumber', ''), coalesce(r -> 'raw', '{}'::jsonb), r ->> 'valueText', nullif(r ->> 'unitRead', ''),
                (r ->> 'valueNumeric')::numeric, (r ->> 'valuePass')::boolean, (r ->> 'valueCount')::integer,
                (r ->> 'fileNominal')::numeric, (r ->> 'fileLower')::numeric, (r ->> 'fileUpper')::numeric,
                v_req, CASE WHEN v_req IS NULL THEN 'none' ELSE coalesce(nullif(r ->> 'matchKind', 'none'), 'manual') END);
    END LOOP;
  END LOOP;
  RETURN v_import;
END $$;

-- Match a feature to a check of the inspection (or to nothing). A changed match asks for the mismatches to be confirmed again.
CREATE FUNCTION app.set_inspection_import_match(p_row uuid, p_requirement uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_row public.inspection_import_rows%ROWTYPE; v_import public.inspection_imports%ROWTYPE; v_other text;
BEGIN
  SELECT * INTO v_row FROM public.inspection_import_rows WHERE id = p_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Feature not found' USING ERRCODE = 'P0002';
  END IF;
  v_import := app.import_for_update(v_row.import_id);
  IF v_import.status <> 'previewed' THEN
    RAISE EXCEPTION 'Import % is %; matches can no longer change', v_import.reference, v_import.status USING ERRCODE = 'QM008';
  END IF;
  IF p_requirement IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.resolved_inspection_requirements WHERE id = p_requirement AND inspection_record_id = v_import.inspection_record_id) THEN
    RAISE EXCEPTION 'That check is not on this inspection' USING ERRCODE = 'QM008';
  END IF;
  SELECT feature_name INTO v_other FROM public.inspection_import_rows WHERE unit_id = v_row.unit_id AND requirement_id = p_requirement AND id <> p_row;
  IF FOUND THEN
    RAISE EXCEPTION 'That check is already matched to feature % of this part', v_other USING ERRCODE = 'QM008';
  END IF;
  IF p_requirement IS NOT DISTINCT FROM v_row.requirement_id THEN RETURN; END IF;
  UPDATE public.inspection_import_rows SET requirement_id = p_requirement, match_kind = CASE WHEN p_requirement IS NULL THEN 'none' ELSE 'manual' END
   WHERE id = p_row;
  UPDATE public.inspection_imports SET mismatches_confirmed_at = NULL, mismatches_confirmed_by = NULL WHERE id = v_import.id;
END $$;

-- The person has checked the features whose nominal or limits differ from ours.
CREATE FUNCTION app.confirm_inspection_import_mismatches(p_import uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_import public.inspection_imports%ROWTYPE;
BEGIN
  v_import := app.import_for_update(p_import);
  IF v_import.status <> 'previewed' THEN
    RAISE EXCEPTION 'Import % is %', v_import.reference, v_import.status USING ERRCODE = 'QM008';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.inspection_import_rows WHERE import_id = p_import AND mismatch) THEN
    RAISE EXCEPTION 'No feature differs from the control plan; there is nothing to confirm' USING ERRCODE = 'QM008';
  END IF;
  UPDATE public.inspection_imports SET mismatches_confirmed_at = now(), mismatches_confirmed_by = auth.uid() WHERE id = p_import;
END $$;

CREATE FUNCTION app.discard_inspection_import(p_import uuid, p_reason text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_import public.inspection_imports%ROWTYPE;
BEGIN
  v_import := app.import_for_update(p_import);
  IF v_import.status <> 'previewed' THEN
    RAISE EXCEPTION 'Import % is %; only a preview can be discarded', v_import.reference, v_import.status USING ERRCODE = 'QM008';
  END IF;
  UPDATE public.inspection_imports SET status = 'discarded', discarded_at = now(), discarded_by = auth.uid(),
         discard_reason = nullif(trim(coalesce(p_reason, '')), '') WHERE id = p_import;
END $$;

-- Start applying a preview in this transaction. Checks it is still good to apply and returns the units and the rows to record:
-- {units: [{id, position, unitReference, rows: [{id, requirementId, valueNumeric, valuePass, valueCount}]}]}.
-- p_mode: new (new samples), retest (re-measure failed readings in new samples), correct (replace readings of existing samples; needs a reason).
CREATE FUNCTION app.begin_inspection_import_apply(p_import uuid, p_gauge uuid, p_mode text DEFAULT 'new', p_reason text DEFAULT NULL,
                                                  p_gauge_override_reason text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_import public.inspection_imports%ROWTYPE; v_rec public.inspection_records%ROWTYPE; v_other text; v_out jsonb;
BEGIN
  v_import := app.import_for_update(p_import);
  v_rec := app.inspection_for_import(v_import.inspection_record_id);
  IF v_import.status <> 'previewed' THEN
    RAISE EXCEPTION 'Import % is %', v_import.reference, v_import.status USING ERRCODE = 'QM008';
  END IF;
  IF v_import.created_at < now() - interval '1 day' THEN
    RAISE EXCEPTION 'This preview is over a day old; upload the file again' USING ERRCODE = 'QM008';
  END IF;
  PERFORM app.assert_inspection_open(v_import.inspection_record_id);
  IF coalesce(p_mode, '') NOT IN ('new', 'retest', 'correct') THEN
    RAISE EXCEPTION 'Choose whether these are new readings, a retest or a correction' USING ERRCODE = 'QM008';
  END IF;
  IF p_mode = 'correct' THEN
    IF length(trim(coalesce(p_reason, ''))) < 3 THEN
      RAISE EXCEPTION 'Say why the readings are being corrected' USING ERRCODE = 'QM008';
    END IF;
    IF NOT app.has_permission(v_rec.organisation_id, 'inspection.correct', v_rec.site_id) THEN
      RAISE EXCEPTION 'You may not correct recorded readings' USING ERRCODE = '42501';
    END IF;
  END IF;
  PERFORM app.assert_measurement_gauge(v_rec.organisation_id, p_gauge);
  SELECT reference INTO v_other FROM public.inspection_imports
   WHERE inspection_record_id = v_import.inspection_record_id AND file_sha256 = v_import.file_sha256 AND status = 'applied';
  IF FOUND THEN
    RAISE EXCEPTION 'This file was already imported on this inspection (%)', v_other USING ERRCODE = 'QM008';
  END IF;
  IF EXISTS (SELECT 1 FROM public.inspection_import_rows WHERE import_id = p_import AND mismatch) AND v_import.mismatches_confirmed_at IS NULL THEN
    RAISE EXCEPTION 'Some features differ from the control plan; confirm you have checked them first' USING ERRCODE = 'QM008';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.inspection_import_rows WHERE import_id = p_import AND requirement_id IS NOT NULL AND problem IS NULL) THEN
    RAISE EXCEPTION 'No feature is matched to a check of this inspection; nothing would be recorded' USING ERRCODE = 'QM008';
  END IF;

  UPDATE public.inspection_imports SET status = 'applying', gauge_id = p_gauge, apply_mode = p_mode,
         apply_reason = nullif(trim(coalesce(p_reason, '')), ''), gauge_override_reason = nullif(trim(coalesce(p_gauge_override_reason, '')), '')
   WHERE id = p_import;
  PERFORM set_config('app.inspection_import', p_import::text, true);

  SELECT jsonb_build_object('reference', v_import.reference, 'mode', p_mode, 'units', coalesce(jsonb_agg(u ORDER BY (u ->> 'position')::integer), '[]'::jsonb)) INTO v_out
    FROM (SELECT jsonb_build_object('id', n.id, 'position', n.position, 'unitReference', n.unit_reference,
                   'rows', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', w.id, 'requirementId', w.requirement_id, 'valueNumeric', w.value_numeric,
                                                                        'valuePass', w.value_pass, 'valueCount', w.value_count) ORDER BY w.position), '[]'::jsonb)
                              FROM public.inspection_import_rows w WHERE w.unit_id = n.id AND w.requirement_id IS NOT NULL AND w.problem IS NULL)) AS u
            FROM public.inspection_import_units n WHERE n.import_id = p_import) x
   WHERE jsonb_array_length(u -> 'rows') > 0;
  RETURN v_out;
END $$;

-- Finish applying: p_units = [{unitId, sampleId}] for every unit that had rows to record. Checks that each matched row became exactly one reading
-- of that check in that sample, with the same value and the import's gauge, that no other reading names the import, and (by mode) that new
-- readings are new, retests re-measure and corrections replace. Then the import is applied and frozen.
CREATE FUNCTION app.finish_inspection_import_apply(p_import uuid, p_units jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_import public.inspection_imports%ROWTYPE; u jsonb; w record; m record; v_sample uuid; v_unit public.inspection_import_units%ROWTYPE;
BEGIN
  v_import := app.import_for_update(p_import);
  IF v_import.status <> 'applying' OR p_import::text IS DISTINCT FROM nullif(current_setting('app.inspection_import', true), '') THEN
    RAISE EXCEPTION 'Import % is not being applied' , v_import.reference USING ERRCODE = 'QM008';
  END IF;
  IF jsonb_typeof(p_units) <> 'array' THEN
    RAISE EXCEPTION 'Say which sample each part became' USING ERRCODE = 'QM008';
  END IF;
  FOR u IN SELECT value FROM jsonb_array_elements(p_units) LOOP
    SELECT * INTO v_unit FROM public.inspection_import_units WHERE id = (u ->> 'unitId')::uuid AND import_id = p_import;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'That part is not in this import' USING ERRCODE = 'QM008';
    END IF;
    v_sample := (u ->> 'sampleId')::uuid;
    IF NOT EXISTS (SELECT 1 FROM public.inspection_samples WHERE id = v_sample AND inspection_record_id = v_import.inspection_record_id) THEN
      RAISE EXCEPTION 'That sample is not on this inspection' USING ERRCODE = 'QM008';
    END IF;
    IF EXISTS (SELECT 1 FROM public.inspection_import_units WHERE import_id = p_import AND sample_id = v_sample AND id <> v_unit.id) THEN
      RAISE EXCEPTION 'Two parts of the file cannot become the same sample' USING ERRCODE = 'QM008';
    END IF;
    IF v_import.apply_mode <> 'correct' AND EXISTS (
         SELECT 1 FROM public.inspection_measurements WHERE sample_id = v_sample AND import_id IS DISTINCT FROM p_import) THEN
      RAISE EXCEPTION 'New readings from a file go into new samples' USING ERRCODE = 'QM008';
    END IF;
    IF v_import.apply_mode = 'retest' AND NOT (SELECT is_retest FROM public.inspection_samples WHERE id = v_sample) THEN
      RAISE EXCEPTION 'A retest goes into a retest sample' USING ERRCODE = 'QM008';
    END IF;
    UPDATE public.inspection_import_units SET sample_id = v_sample WHERE id = v_unit.id;
  END LOOP;

  FOR w IN SELECT r.*, n.sample_id, n.position AS unit_position FROM public.inspection_import_rows r JOIN public.inspection_import_units n ON n.id = r.unit_id
            WHERE r.import_id = p_import AND r.requirement_id IS NOT NULL AND r.problem IS NULL LOOP
    IF w.sample_id IS NULL THEN
      RAISE EXCEPTION 'Part % of the file was not recorded', w.unit_position USING ERRCODE = 'QM008';
    END IF;
    SELECT * INTO m FROM public.inspection_measurements
     WHERE import_id = p_import AND sample_id = w.sample_id AND requirement_id = w.requirement_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Feature % was not recorded', w.feature_name USING ERRCODE = 'QM008';
    END IF;
    IF (m.value_numeric, m.value_pass, m.value_count) IS DISTINCT FROM (w.value_numeric, w.value_pass, w.value_count) THEN
      RAISE EXCEPTION 'Feature % was recorded with a different value than the file', w.feature_name USING ERRCODE = 'QM008';
    END IF;
    IF (v_import.apply_mode = 'correct') <> (m.supersedes_id IS NOT NULL) OR (v_import.apply_mode = 'retest') <> (m.retest_of_id IS NOT NULL) THEN
      RAISE EXCEPTION 'Feature % was not recorded as a %', w.feature_name,
        CASE v_import.apply_mode WHEN 'correct' THEN 'correction' WHEN 'retest' THEN 'retest' ELSE 'new reading' END USING ERRCODE = 'QM008';
    END IF;
    UPDATE public.inspection_import_rows SET measurement_id = m.id WHERE id = w.id;
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.inspection_measurements x WHERE x.import_id = p_import
              AND NOT EXISTS (SELECT 1 FROM public.inspection_import_rows y WHERE y.measurement_id = x.id)) THEN
    RAISE EXCEPTION 'A reading names this import but is not in the file' USING ERRCODE = 'QM008';
  END IF;

  UPDATE public.inspection_imports SET status = 'applied', applied_at = now(), applied_by = auth.uid() WHERE id = p_import;
  PERFORM set_config('app.inspection_import', '', true);
END $$;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['measurement_import_profiles', 'measurement_feature_maps', 'inspection_imports'] LOOP
    EXECUTE format('CREATE TRIGGER %1$s_stamp BEFORE INSERT ON public.%1$I FOR EACH ROW EXECUTE FUNCTION app.stamp_created()', t);
    EXECUTE format('CREATE TRIGGER %1$s_touch BEFORE UPDATE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION app.touch_updated()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['measurement_import_profiles', 'measurement_import_profile_versions', 'measurement_feature_maps', 'inspection_imports',
                           'inspection_import_units', 'inspection_import_rows'] LOOP
    EXECUTE format('CREATE TRIGGER %1$s_org_immutable BEFORE UPDATE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change()', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
  END LOOP;
  -- The file's many rows and parts are not audited (like the integration inbox); the import, its profile and the maps are.
  FOREACH t IN ARRAY ARRAY['measurement_import_profiles', 'measurement_import_profile_versions', 'measurement_feature_maps', 'inspection_imports'] LOOP
    EXECUTE format('CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.%I '
                   'FOR EACH ROW EXECUTE FUNCTION audit.record_change(''organisation_id'')', t);
  END LOOP;
END $$;
CREATE TRIGGER measurement_import_profile_versions_frozen BEFORE UPDATE OR DELETE ON public.measurement_import_profile_versions
  FOR EACH ROW EXECUTE FUNCTION app.measurement_profile_version_frozen();
CREATE TRIGGER measurement_feature_maps_rules BEFORE UPDATE ON public.measurement_feature_maps FOR EACH ROW EXECUTE FUNCTION app.measurement_feature_map_rules();
CREATE TRIGGER inspection_imports_rules BEFORE UPDATE ON public.inspection_imports FOR EACH ROW EXECUTE FUNCTION app.inspection_import_rules();
CREATE CONSTRAINT TRIGGER inspection_imports_settled AFTER UPDATE ON public.inspection_imports DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.status = 'applying') EXECUTE FUNCTION app.inspection_import_settled();
CREATE TRIGGER inspection_import_units_rules BEFORE UPDATE ON public.inspection_import_units FOR EACH ROW EXECUTE FUNCTION app.inspection_import_unit_rules();
CREATE TRIGGER inspection_import_rows_rules BEFORE INSERT OR UPDATE ON public.inspection_import_rows FOR EACH ROW EXECUTE FUNCTION app.inspection_import_row_rules();
CREATE TRIGGER inspection_measurements_import BEFORE INSERT OR UPDATE OF import_id ON public.inspection_measurements
  FOR EACH ROW EXECUTE FUNCTION app.inspection_measurement_import_rules();

-- ---------------------------------------------------------------------------
-- Reading
-- ---------------------------------------------------------------------------
CREATE POLICY measurement_import_profiles_select ON public.measurement_import_profiles FOR SELECT TO authenticated USING (app.is_member(organisation_id));
CREATE POLICY measurement_import_profile_versions_select ON public.measurement_import_profile_versions FOR SELECT TO authenticated USING (app.is_member(organisation_id));
CREATE POLICY measurement_feature_maps_select ON public.measurement_feature_maps FOR SELECT TO authenticated USING (app.is_member(organisation_id));
CREATE POLICY inspection_imports_select ON public.inspection_imports FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'inspection.read', app.inspection_site(inspection_record_id)));
CREATE POLICY inspection_import_units_select ON public.inspection_import_units FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'inspection.read', app.inspection_site(inspection_record_id)));
CREATE POLICY inspection_import_rows_select ON public.inspection_import_rows FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'inspection.read', app.inspection_site(inspection_record_id)));

-- ---------------------------------------------------------------------------
-- Storage: <org>/inspection/<inspection id>/<uuid>-<name>; read with inspection.read at the site, uploaded only into an inspection in progress
-- by someone who may record there; never updated or deleted.
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public) VALUES ('inspection-files', 'inspection-files', false)
ON CONFLICT (id) DO NOTHING;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'storage' AND table_name = 'buckets' AND column_name = 'file_size_limit') THEN
    EXECUTE $q$UPDATE storage.buckets SET file_size_limit = 26214400 WHERE id = 'inspection-files'$q$;
  END IF;
END $$;

CREATE FUNCTION app.inspection_file_allowed(p_object_name text, p_upload boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT split_part(p_object_name, '/', 2) = 'inspection' AND split_part(p_object_name, '/', 4) <> '' AND EXISTS (
    SELECT 1 FROM public.inspection_records r
     WHERE r.id = app.try_uuid(split_part(p_object_name, '/', 3)) AND r.organisation_id = app.try_uuid(split_part(p_object_name, '/', 1))
       AND CASE WHEN p_upload THEN r.status = 'in_progress' AND app.has_permission(r.organisation_id, 'inspection.record', r.site_id)
                ELSE app.has_permission(r.organisation_id, 'inspection.read', r.site_id) END)
$$;
CREATE POLICY inspection_files_select ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'inspection-files' AND app.inspection_file_allowed(name, false));
CREATE POLICY inspection_files_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'inspection-files' AND app.inspection_file_allowed(name, true));

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app.next_inspection_import_reference(uuid), app.measurement_profile_version_frozen(), app.import_values_differ(numeric, numeric, numeric, numeric),
  app.inspection_import_row_rules(), app.inspection_import_unit_rules(), app.inspection_import_rules(), app.inspection_import_settled(),
  app.inspection_measurement_import_rules(), app.assert_measurement_gauge(uuid, uuid), app.save_measurement_profile(uuid, jsonb, uuid),
  app.retire_measurement_profile(uuid, text), app.reactivate_measurement_profile(uuid), app.save_feature_map(uuid, uuid, text, text), app.end_feature_map(uuid),
  app.measurement_feature_map_rules(), app.inspection_for_import(uuid), app.import_for_update(uuid), app.create_inspection_import(uuid, jsonb),
  app.set_inspection_import_match(uuid, uuid), app.confirm_inspection_import_mismatches(uuid), app.discard_inspection_import(uuid, text),
  app.begin_inspection_import_apply(uuid, uuid, text, text, text), app.finish_inspection_import_apply(uuid, jsonb), app.inspection_file_allowed(text, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.save_measurement_profile(uuid, jsonb, uuid), app.retire_measurement_profile(uuid, text), app.reactivate_measurement_profile(uuid),
  app.save_feature_map(uuid, uuid, text, text), app.end_feature_map(uuid), app.create_inspection_import(uuid, jsonb), app.set_inspection_import_match(uuid, uuid),
  app.confirm_inspection_import_mismatches(uuid), app.discard_inspection_import(uuid, text), app.begin_inspection_import_apply(uuid, uuid, text, text, text),
  app.finish_inspection_import_apply(uuid, jsonb), app.inspection_file_allowed(text, boolean) TO authenticated;
