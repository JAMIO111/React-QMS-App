-- Record filters on import templates (docs/import-filters-plan.md, F1): which source records an import reads at all.
--
-- A filter is kept on the template version (inside its `settings`, so it is frozen with the version, copied by "bring a version back" and duplicate, and
-- travels into a run's frozen settings, scheduled runs included). It is plain data -- rules of "column, test, value", or one formula -- applied by the sync
-- engine to the raw source record before any mapping. This migration holds only what the database must know:
--
--   * the shape of a filter is validated when a template version is saved (the API checks the rules against the columns and formulas in depth);
--   * a record the filter leaves out is staged as `skipped` and marked `filtered`, with the source's own identifier kept (`source_external_id`), so that
--     a record imported earlier and now filtered out is NOT reported as "no longer in the source" (a filter must never deactivate records by accident);
--   * runs count how many records were filtered (a subset of skipped).
--
-- The shared functions are rewritten from their live definitions by a checked text patch: the migration refuses to finish unless the old text is found exactly
-- once. Line endings are normalised first (a function applied through the SQL editor from Windows is stored with \r\n).
CREATE FUNCTION pg_temp.patch(p_fn regprocedure, p_old text, p_new text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_def text := replace(pg_get_functiondef(p_fn), E'\r', ''); v_n integer;
BEGIN
  v_n := (length(v_def) - length(replace(v_def, p_old, ''))) / length(p_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'Expected to find % exactly once in %, found % times', p_old, p_fn, v_n; END IF;
  EXECUTE replace(v_def, p_old, p_new);
END $$;

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------
-- The source's own identifier of a record a filter left out (nothing else uses it), so a filtered record still counts as present in the source.
ALTER TABLE public.integration_inbox ADD COLUMN filtered boolean NOT NULL DEFAULT false;
ALTER TABLE public.integration_inbox ADD COLUMN source_external_id text CHECK (source_external_id IS NULL OR length(source_external_id) <= 200);
-- How many records of the run a filter left out (they are also counted as skipped).
ALTER TABLE public.integration_sync_runs ADD COLUMN filtered integer NOT NULL DEFAULT 0 CHECK (filtered >= 0);

-- ---------------------------------------------------------------------------
-- The shape of a filter (the API checks the rest: columns, formulas, values read as numbers or dates)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.integration_filter_problem(p_filter jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE
  r jsonb; k text; v jsonb; n integer := 0;
  tests text[] := ARRAY['equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'ends_with', 'in', 'not_in', 'is_empty', 'not_empty', 'gt', 'gte', 'lt', 'lte', 'between'];
BEGIN
  IF jsonb_typeof(p_filter) <> 'object' THEN RETURN 'A filter is a set of rules'; END IF;
  IF length(p_filter::text) > 60000 THEN RETURN 'The filter is too large'; END IF;
  FOR k IN SELECT jsonb_object_keys(p_filter) LOOP
    IF k <> ALL (ARRAY['mode', 'match', 'rules', 'formula']) THEN RETURN format('A filter has no setting called %s', k); END IF;
  END LOOP;
  IF p_filter ->> 'mode' IS NULL OR p_filter ->> 'mode' <> ALL (ARRAY['keep', 'leave_out']) THEN RETURN 'Choose whether to keep or leave out the records that match'; END IF;
  IF p_filter ->> 'match' IS NULL OR p_filter ->> 'match' <> ALL (ARRAY['all', 'any']) THEN RETURN 'Choose whether all of the rules or any of them must hold'; END IF;
  IF jsonb_typeof(p_filter -> 'rules') <> 'array' THEN RETURN 'A filter has a list of rules'; END IF;
  IF jsonb_array_length(p_filter -> 'rules') > 20 THEN RETURN 'A filter is limited to 20 rules'; END IF;
  IF p_filter ? 'formula' THEN
    IF jsonb_typeof(p_filter -> 'formula') <> 'string' OR length(p_filter ->> 'formula') > 2000 THEN RETURN 'A filter formula is text of at most 2,000 characters'; END IF;
    IF jsonb_array_length(p_filter -> 'rules') > 0 THEN RETURN 'A filter is either rules or a formula, not both'; END IF;
  END IF;
  FOR r IN SELECT x FROM jsonb_array_elements(p_filter -> 'rules') AS x LOOP
    n := n + 1;
    IF jsonb_typeof(r) <> 'object' THEN RETURN format('Rule %s is not a rule', n); END IF;
    FOR k IN SELECT jsonb_object_keys(r) LOOP
      IF k <> ALL (ARRAY['column', 'test', 'value', 'values', 'valueTo', 'as', 'decimal', 'dateFormat']) THEN RETURN format('Rule %s has no setting called %s', n, k); END IF;
    END LOOP;
    IF jsonb_typeof(r -> 'column') <> 'string' OR length(btrim(r ->> 'column')) = 0 OR length(r ->> 'column') > 200 THEN RETURN format('Rule %s: choose a column', n); END IF;
    IF r ->> 'test' IS NULL OR r ->> 'test' <> ALL (tests) THEN RETURN format('Rule %s: choose a test', n); END IF;
    FOREACH k IN ARRAY ARRAY['value', 'valueTo'] LOOP
      IF r ? k AND (jsonb_typeof(r -> k) <> 'string' OR length(r ->> k) > 500) THEN RETURN format('Rule %s: a value is text of at most 500 characters', n); END IF;
    END LOOP;
    IF r ? 'values' THEN
      IF jsonb_typeof(r -> 'values') <> 'array' OR jsonb_array_length(r -> 'values') > 100 THEN RETURN format('Rule %s: a list holds at most 100 values', n); END IF;
      FOR v IN SELECT x FROM jsonb_array_elements(r -> 'values') AS x LOOP
        IF jsonb_typeof(v) <> 'string' OR length(v #>> '{}') > 500 THEN RETURN format('Rule %s: a value is text of at most 500 characters', n); END IF;
      END LOOP;
    END IF;
    IF r ? 'as' AND (r ->> 'as') <> ALL (ARRAY['text', 'number', 'date']) THEN RETURN format('Rule %s: read the column as text, a number or a date', n); END IF;
    IF r ? 'decimal' AND (r ->> 'decimal') <> ALL (ARRAY['.', ',']) THEN RETURN format('Rule %s: the decimal mark is . or ,', n); END IF;
    IF r ? 'dateFormat' AND (r ->> 'dateFormat') <> ALL (ARRAY['iso', 'dmy', 'mdy', 'excel']) THEN RETURN format('Rule %s: choose how the dates are written', n); END IF;
  END LOOP;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.integration_filter_problem(jsonb) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- A template's settings keep a filter. The existing function (which the template functions call by name) becomes the core and a wrapper adds the filter,
-- refusing one that is malformed and dropping one that has nothing to do.
-- ---------------------------------------------------------------------------
ALTER FUNCTION app.integration_template_settings(text, jsonb) RENAME TO integration_template_settings_core;

CREATE FUNCTION app.integration_template_settings(p_entity text, p_settings jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v_filter jsonb := p_settings -> 'filters'; v_problem text;
BEGIN
  IF v_filter IS NULL OR v_filter = 'null'::jsonb THEN RETURN app.integration_template_settings_core(p_entity, p_settings); END IF;
  v_problem := app.integration_filter_problem(v_filter);
  IF v_problem IS NOT NULL THEN RAISE EXCEPTION '%', v_problem USING ERRCODE = 'QM022'; END IF;
  -- no rules and no formula = no filter
  IF jsonb_array_length(v_filter -> 'rules') = 0 AND coalesce(btrim(v_filter ->> 'formula'), '') = '' THEN RETURN app.integration_template_settings_core(p_entity, p_settings); END IF;
  RETURN app.integration_template_settings_core(p_entity, p_settings) || jsonb_build_object('filters', v_filter);
END $$;
REVOKE ALL ON FUNCTION app.integration_template_settings(text, jsonb), app.integration_template_settings_core(text, jsonb) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Staging: a record the filter left out arrives as `skipped` with `filtered: true` (and its own identifier as `sourceExternalId`, kept apart from the
-- row's identifier so it cannot clash with a kept record that shares it); the run counts them.
-- ---------------------------------------------------------------------------
SELECT pg_temp.patch('app.system_stage_integration_records(uuid, uuid, uuid, jsonb, text, boolean)'::regprocedure,
  'n_create integer; n_update integer; n_superseded integer := 0;',
  'n_create integer; n_update integer; n_superseded integer := 0; n_filtered integer := 0;');
SELECT pg_temp.patch('app.system_stage_integration_records(uuid, uuid, uuid, jsonb, text, boolean)'::regprocedure,
  '(organisation_id, connection_id, run_id, entity_type, external_id, source_row, payload, canonical, content_hash, status, action, internal_id, errors, last_run_id)',
  '(organisation_id, connection_id, run_id, entity_type, external_id, source_row, payload, canonical, content_hash, status, action, internal_id, errors, last_run_id, filtered, source_external_id)');
SELECT pg_temp.patch('app.system_stage_integration_records(uuid, uuid, uuid, jsonb, text, boolean)'::regprocedure,
  E'           r.id\n      FROM decided d',
  E'           r.id, coalesce((d.e ->> ''filtered'') = ''true'', false), CASE WHEN (d.e ->> ''filtered'') = ''true'' THEN left(nullif(btrim(d.e ->> ''sourceExternalId''), ''''), 200) END\n      FROM decided d');
SELECT pg_temp.patch('app.system_stage_integration_records(uuid, uuid, uuid, jsonb, text, boolean)'::regprocedure,
  'RETURNING status, action',
  'RETURNING status, action, filtered');
SELECT pg_temp.patch('app.system_stage_integration_records(uuid, uuid, uuid, jsonb, text, boolean)'::regprocedure,
  E'count(*) FILTER (WHERE action = ''update'')\n    INTO n_total, n_rejected, n_unchanged, n_skipped, n_create, n_update',
  E'count(*) FILTER (WHERE action = ''update''), count(*) FILTER (WHERE filtered)\n    INTO n_total, n_rejected, n_unchanged, n_skipped, n_create, n_update, n_filtered');
SELECT pg_temp.patch('app.system_stage_integration_records(uuid, uuid, uuid, jsonb, text, boolean)'::regprocedure,
  'skipped = skipped + n_skipped,',
  'skipped = skipped + n_skipped, filtered = filtered + n_filtered,');
SELECT pg_temp.patch('app.system_stage_integration_records(uuid, uuid, uuid, jsonb, text, boolean)'::regprocedure,
  '''skipped'', n_skipped, ''toCreate''',
  '''skipped'', n_skipped, ''filtered'', n_filtered, ''toCreate''');

-- ---------------------------------------------------------------------------
-- Records that disappeared (IN8): a record the filter left out is still in the source, so it is never called missing; a filtered row whose identifier
-- could not be read could be any record, so (as for a row with no identifier) nothing is called missing from that read.
-- ---------------------------------------------------------------------------
SELECT pg_temp.patch('app.integration_detect_missing(uuid)'::regprocedure,
  'AND EXISTS (SELECT 1 FROM public.integration_inbox i WHERE i.run_id = r.id AND i.external_id = mr.external_id);',
  'AND EXISTS (SELECT 1 FROM public.integration_inbox i WHERE i.run_id = r.id AND (i.external_id = mr.external_id OR i.source_external_id = mr.external_id));');
SELECT pg_temp.patch('app.integration_detect_missing(uuid)'::regprocedure,
  'IF EXISTS (SELECT 1 FROM public.integration_inbox i WHERE i.run_id = r.id AND i.external_id IS NULL) THEN',
  'IF EXISTS (SELECT 1 FROM public.integration_inbox i WHERE i.run_id = r.id AND (i.external_id IS NULL OR (i.filtered AND i.source_external_id IS NULL))) THEN');
SELECT pg_temp.patch('app.integration_detect_missing(uuid)'::regprocedure,
  'AND NOT EXISTS (SELECT 1 FROM public.integration_inbox i WHERE i.run_id = r.id AND i.external_id = er.external_id)',
  'AND NOT EXISTS (SELECT 1 FROM public.integration_inbox i WHERE i.run_id = r.id AND (i.external_id = er.external_id OR i.source_external_id = er.external_id))');
