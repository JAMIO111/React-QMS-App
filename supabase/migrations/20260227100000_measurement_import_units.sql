-- CMM ingestion CM2: units (docs/cmm-ingestion-plan.md C7). A feature's value, nominal and limits are kept as the file wrote them (`read_*`, in
-- `unit_read`); the database converts them to the unit of the check the feature is matched to (length mm/µm/m/in/thou, angle deg/arcmin) into
-- `value_numeric` / `file_nominal` / `file_lower` / `file_upper`, on insert and again whenever the match changes. Units that cannot convert
-- (degrees against millimetres) make the row a problem, never a reading. No unit in the file = the check's unit.

ALTER TABLE public.inspection_import_rows
  ADD COLUMN read_value numeric,
  ADD COLUMN read_nominal numeric,
  ADD COLUMN read_lower numeric,
  ADD COLUMN read_upper numeric;

-- Existing previews (made before this change) were sent already in the check's unit: keep what they hold as what was read.
ALTER TABLE public.inspection_import_rows DISABLE TRIGGER inspection_import_rows_rules;
UPDATE public.inspection_import_rows SET read_value = value_numeric, read_nominal = file_nominal, read_lower = file_lower, read_upper = file_upper;
ALTER TABLE public.inspection_import_rows ENABLE TRIGGER inspection_import_rows_rules;

-- How many of the kind's base unit one of `p_code` is (length in mm, angle in degrees); null for a unit that does not convert.
CREATE FUNCTION app.measurement_unit_factor(p_code text, OUT kind text, OUT factor numeric)
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT v.kind, v.factor FROM (VALUES
    ('mm', 'length', 1::numeric), ('µm', 'length', 0.001), ('m', 'length', 1000), ('in', 'length', 25.4), ('thou', 'length', 0.0254),
    ('deg', 'angle', 1), ('arcmin', 'angle', 1::numeric / 60)) AS v (code, kind, factor)
  WHERE v.code = p_code
$$;

-- `p_value` read in `p_from`, in `p_to` (rounded to 10 decimal places). The same unit, or either unit unknown, leaves it as it is.
CREATE FUNCTION app.convert_measurement(p_value numeric, p_from text, p_to text) RETURNS numeric
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE
    WHEN p_value IS NULL THEN NULL
    WHEN p_from IS NULL OR p_to IS NULL OR p_from = p_to THEN p_value
    ELSE (SELECT round(p_value * f.factor / t.factor, 10) FROM app.measurement_unit_factor(p_from) f, app.measurement_unit_factor(p_to) t
           WHERE f.kind = t.kind)
  END
$$;

-- Two units are compatible when they are the same, either is not given, or both are known units of one kind.
CREATE FUNCTION app.measurement_units_compatible(p_from text, p_to text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p_from IS NULL OR p_to IS NULL OR p_from = p_to
      OR EXISTS (SELECT 1 FROM app.measurement_unit_factor(p_from) f, app.measurement_unit_factor(p_to) t WHERE f.kind = t.kind)
$$;

-- Does the file's value differ from ours? Not when the two differ by no more than 1/1000 of the tolerance band, nor — for a file in another unit —
-- when ours, written in the file's unit to the file's number of decimals, is what the file shows (an inch report printing 0.9961 for our 25.3 mm).
CREATE FUNCTION app.import_value_mismatch(p_read numeric, p_unit_read text, p_ours numeric, p_unit text, p_lower numeric, p_upper numeric) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p_read IS NOT NULL AND p_ours IS NOT NULL
     AND (p_unit_read IS NULL OR p_unit IS NULL OR p_unit_read = p_unit
          OR round(app.convert_measurement(p_ours, p_unit, p_unit_read), scale(p_read)) <> p_read)
     AND app.import_values_differ(app.convert_measurement(p_read, p_unit_read, p_unit), p_ours, p_lower, p_upper)
$$;

-- The row rules of CM1, now converting from what was read. What the file said (incl. read_* and unit_read) never changes; the converted values
-- follow the match.
CREATE OR REPLACE FUNCTION app.inspection_import_row_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE q record; v_status text;
BEGIN
  SELECT status INTO v_status FROM public.inspection_imports WHERE id = NEW.import_id;
  IF TG_OP = 'UPDATE' THEN
    IF v_status IN ('applied', 'discarded') THEN
      RAISE EXCEPTION 'This import is %; it cannot be changed', v_status USING ERRCODE = 'QM008';
    END IF;
    IF (NEW.import_id, NEW.unit_id, NEW.position, NEW.feature_name, NEW.char_number, NEW.raw, NEW.value_text, NEW.unit_read,
        NEW.read_value, NEW.read_nominal, NEW.read_lower, NEW.read_upper, NEW.value_pass, NEW.value_count)
       IS DISTINCT FROM (OLD.import_id, OLD.unit_id, OLD.position, OLD.feature_name, OLD.char_number, OLD.raw, OLD.value_text, OLD.unit_read,
        OLD.read_value, OLD.read_nominal, OLD.read_lower, OLD.read_upper, OLD.value_pass, OLD.value_count) THEN
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
  -- Unmatched, or matched to a check without a unit: the values as read.
  NEW.value_numeric := NEW.read_value; NEW.file_nominal := NEW.read_nominal; NEW.file_lower := NEW.read_lower; NEW.file_upper := NEW.read_upper;
  IF NEW.requirement_id IS NULL THEN
    NEW.match_kind := 'none';
    RETURN NEW;
  END IF;
  SELECT * INTO q FROM public.resolved_inspection_requirements WHERE id = NEW.requirement_id;
  IF NOT q.applicable THEN
    NEW.problem := q.name || ' does not apply to this part';
  ELSIF q.data_type = 'variable' THEN
    IF NOT app.measurement_units_compatible(NEW.unit_read, q.unit_code) THEN
      NEW.problem := format('The file gives this in %s; %s is measured in %s', NEW.unit_read, q.name, q.unit_code);
      RETURN NEW;
    END IF;
    NEW.value_numeric := app.convert_measurement(NEW.read_value, NEW.unit_read, q.unit_code);
    NEW.file_nominal := app.convert_measurement(NEW.read_nominal, NEW.unit_read, q.unit_code);
    NEW.file_lower := app.convert_measurement(NEW.read_lower, NEW.unit_read, q.unit_code);
    NEW.file_upper := app.convert_measurement(NEW.read_upper, NEW.unit_read, q.unit_code);
    IF NEW.value_numeric IS NULL THEN
      NEW.problem := q.name || ' needs a measured value';
    ELSE
      NEW.expected_result := CASE WHEN (q.lower_limit IS NULL OR NEW.value_numeric >= q.lower_limit)
                                   AND (q.upper_limit IS NULL OR NEW.value_numeric <= q.upper_limit) THEN 'pass' ELSE 'fail' END;
      NEW.mismatch := app.import_value_mismatch(NEW.read_nominal, NEW.unit_read, q.nominal, q.unit_code, q.lower_limit, q.upper_limit)
                   OR app.import_value_mismatch(NEW.read_lower, NEW.unit_read, q.lower_limit, q.unit_code, q.lower_limit, q.upper_limit)
                   OR app.import_value_mismatch(NEW.read_upper, NEW.unit_read, q.upper_limit, q.unit_code, q.lower_limit, q.upper_limit)
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

-- The body's valueNumeric / fileNominal / fileLower / fileUpper are what the file wrote (in unitRead); everything else as in CM1.
CREATE OR REPLACE FUNCTION app.create_inspection_import(p_record uuid, p_body jsonb) RETURNS uuid
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
                                                 value_text, unit_read, read_value, value_pass, value_count, read_nominal, read_lower, read_upper,
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

REVOKE ALL ON FUNCTION app.measurement_unit_factor(text), app.convert_measurement(numeric, text, text), app.measurement_units_compatible(text, text),
  app.import_value_mismatch(numeric, text, numeric, text, numeric, numeric)
  FROM PUBLIC, anon, authenticated;
