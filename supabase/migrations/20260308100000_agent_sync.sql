-- Connector agent AG4 (docs/connector-agent-plan.md §9): keeping a database connection in step.
--
--  * Incremental reads (AG-D8): a record source may name the column that shows when a row changed (`changedColumn`: a modified date or an
--    increasing number). An incremental run asks the agent only for rows whose value is at or after the high-water mark of the last finished
--    run (`changedSince`); the agent reports the highest value it read (`changedUpTo`, kept as it goes so a restarted job carries it on), and that
--    becomes the run's cursor — moved into integration_sync_cursors only when the run finishes, so nothing is lost when an import fails. Rows at
--    the mark itself are read again (">="); unchanged rows write nothing (the content hash). A full read with a changed column also sets the mark.
--  * Schedules (AG-D9): a database connection may run every 5, 15 or 60 minutes, or daily. The worker asks for due runs every minute
--    (app.system_schedule_integration_runs with p_daily = false; the daily cron still does the daily ones), never beside a run still waiting or
--    running, and not while the agent is offline (the schedule says so instead of piling up runs that would fail).
--  * An agent that stops answering: a job for it (extraction, test, browse, preview) that has waited 15 minutes while the agent has not checked in
--    for 15 minutes fails with "the agent did not answer" (app.system_fail_stalled_agent_jobs, run by the worker), which fails its import too.
--  * Health lists each database connection's agent and whether it is online.
-- Records that disappeared after a full read already work for any connection (app.integration_detect_missing).

-- ---------------------------------------------------------------------------
-- The changed column on a record source
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.integration_record_source_problem(p jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE k text; f jsonb; v_cols text[]; n integer;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN RETURN 'The record source is not in the expected form'; END IF;
  FOR k IN SELECT jsonb_object_keys(p) LOOP
    IF k NOT IN ('schema', 'object', 'keyColumn', 'columns', 'filters', 'changedColumn') THEN RETURN format('Unknown record source setting "%s"', k); END IF;
  END LOOP;
  IF NOT app.integration_db_name_ok(p -> 'schema') THEN RETURN 'Choose the schema'; END IF;
  IF NOT app.integration_db_name_ok(p -> 'object') THEN RETURN 'Choose the table or view'; END IF;
  IF NOT app.integration_db_name_ok(p -> 'keyColumn') THEN RETURN 'Choose the column that identifies each row'; END IF;
  IF p ? 'changedColumn' AND NOT app.integration_db_name_ok(p -> 'changedColumn') THEN RETURN 'Choose the column that shows when a row changed, or leave it out'; END IF;
  IF p ? 'columns' THEN
    IF jsonb_typeof(p -> 'columns') <> 'array' THEN RETURN 'The columns are a list'; END IF;
    n := jsonb_array_length(p -> 'columns');
    IF n NOT BETWEEN 1 AND 300 THEN RETURN 'Read 1 to 300 columns, or leave the list out to read them all'; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p -> 'columns') e WHERE NOT app.integration_db_name_ok(e)) THEN RETURN 'A column name is not valid'; END IF;
    SELECT array_agg(e #>> '{}') INTO v_cols FROM jsonb_array_elements(p -> 'columns') e;
    IF (SELECT count(DISTINCT x) FROM unnest(v_cols) x) <> n THEN RETURN 'A column is listed twice'; END IF;
    IF NOT ((p ->> 'keyColumn') = ANY (v_cols)) THEN RETURN 'Read the column that identifies each row too'; END IF;
    IF p ? 'changedColumn' AND NOT ((p ->> 'changedColumn') = ANY (v_cols)) THEN RETURN 'Read the column that shows when a row changed too'; END IF;
  END IF;
  IF p ? 'filters' THEN
    IF jsonb_typeof(p -> 'filters') <> 'array' OR jsonb_array_length(p -> 'filters') > 10 THEN RETURN 'Up to 10 filters'; END IF;
    FOR f IN SELECT e FROM jsonb_array_elements(p -> 'filters') e LOOP
      IF jsonb_typeof(f) <> 'object' THEN RETURN 'A filter is not in the expected form'; END IF;
      FOR k IN SELECT jsonb_object_keys(f) LOOP
        IF k NOT IN ('column', 'op', 'value') THEN RETURN format('Unknown filter setting "%s"', k); END IF;
      END LOOP;
      IF NOT app.integration_db_name_ok(f -> 'column') THEN RETURN 'A filter needs its column'; END IF;
      IF coalesce(f ->> 'op', '') NOT IN ('eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'is_null', 'not_null') THEN
        RETURN 'A filter compares with equals, not equals, greater, less, is empty or is not empty';
      END IF;
      IF f ->> 'op' IN ('is_null', 'not_null') THEN
        IF f ? 'value' THEN RETURN 'An "is empty" filter takes no value'; END IF;
      ELSIF coalesce(jsonb_typeof(f -> 'value'), 'none') NOT IN ('string', 'number', 'boolean') OR length(f ->> 'value') > 200 THEN
        RETURN 'A filter compares with one value (up to 200 characters)';
      END IF;
    END LOOP;
  END IF;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Schedules for database connections
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_name text; n integer := 0;
BEGIN
  FOR v_name IN SELECT conname FROM pg_constraint
   WHERE conrelid = 'public.integration_import_settings'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%(schedule = ANY%'
  LOOP
    EXECUTE format('ALTER TABLE public.integration_import_settings DROP CONSTRAINT %I', v_name);
    n := n + 1;
  END LOOP;
  IF n <> 1 THEN RAISE EXCEPTION 'Expected one schedule check on integration_import_settings, found %', n; END IF;
END $$;
ALTER TABLE public.integration_import_settings ADD CONSTRAINT integration_import_settings_schedule_check
  CHECK (schedule IN ('manual', 'every_5m', 'every_15m', 'hourly', 'daily'));

-- How often a schedule asks for a run (NULL: by hand, or daily, which the daily cron asks for).
CREATE FUNCTION app.integration_schedule_interval(p_schedule text) RETURNS interval
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE p_schedule WHEN 'every_5m' THEN interval '5 minutes' WHEN 'every_15m' THEN interval '15 minutes' WHEN 'hourly' THEN interval '1 hour' END
$$;

-- An agent is online when it checked in within three minutes (as the agent pages say).
CREATE FUNCTION app.integration_agent_online(p_agent uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce((SELECT a.status = 'active' AND a.last_heartbeat_at > now() - interval '3 minutes' FROM public.integration_agents a WHERE a.id = p_agent), false)
$$;

-- The latest definition (20260123100000) with schedules for database connections: daily for an API or a database connection, every 5 / 15 / 60
-- minutes only for a database connection, which needs the table its records are read from.
CREATE OR REPLACE FUNCTION app.set_integration_import_settings(p_connection uuid, p_entity text, p_settings jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.integration_connections%ROWTYPE; v_provider text; v_kind text; v_mode text; v_match boolean; v_missing text; v_schedule text; cur jsonb;
        old public.integration_import_settings%ROWTYPE; v_template uuid; t public.integration_templates%ROWTYPE; v_set_by uuid;
BEGIN
  c := app.integration_connection_for_write(p_connection, 'integrations.manage');
  PERFORM app.integration_assert_entity(p_entity);
  IF c.status = 'retired' THEN RAISE EXCEPTION 'A retired connection cannot be changed' USING ERRCODE = 'QM022'; END IF;
  IF jsonb_typeof(coalesce(p_settings, 'null'::jsonb)) <> 'object' THEN RAISE EXCEPTION 'Give the settings' USING ERRCODE = 'QM022'; END IF;
  SELECT key, kind INTO v_provider, v_kind FROM public.integration_providers WHERE id = c.provider_id;
  SELECT * INTO old FROM public.integration_import_settings WHERE connection_id = c.id AND entity_type = p_entity;
  cur := app.integration_settings_for(c.id, p_entity);
  v_mode := coalesce(p_settings ->> 'writeMode', cur ->> 'writeMode');
  v_match := coalesce((p_settings ->> 'matchExisting')::boolean, (cur ->> 'matchExisting')::boolean);
  v_missing := coalesce(p_settings ->> 'onMissing', cur ->> 'onMissing');
  v_schedule := coalesce(p_settings ->> 'schedule', cur ->> 'schedule');
  v_template := CASE WHEN p_settings ? 'templateId' THEN nullif(p_settings ->> 'templateId', '')::uuid ELSE old.template_id END;
  IF v_mode NOT IN ('add_only', 'add_update', 'update_only') THEN RAISE EXCEPTION 'An import adds new records only, adds and updates, or updates only' USING ERRCODE = 'QM022'; END IF;
  IF v_missing NOT IN ('nothing', 'list', 'deactivate') THEN RAISE EXCEPTION 'When a record disappears: do nothing, list it, or make it inactive' USING ERRCODE = 'QM022'; END IF;
  IF v_schedule NOT IN ('manual', 'every_5m', 'every_15m', 'hourly', 'daily') THEN RAISE EXCEPTION 'An import runs by hand, every 5, 15 or 60 minutes, or daily' USING ERRCODE = 'QM022'; END IF;
  IF p_entity = 'nonconformance' AND (v_mode <> 'add_only' OR v_match) THEN
    RAISE EXCEPTION 'Non-conformances are only ever added: once in Fortress they are managed there' USING ERRCODE = 'QM022';
  END IF;
  IF v_missing <> 'nothing' AND NOT app.integration_entity_tracks_missing(p_entity) THEN
    RAISE EXCEPTION 'These records are events: a source leaving out old ones is normal, so nothing happens when one disappears' USING ERRCODE = 'QM022';
  END IF;
  IF v_missing = 'deactivate' AND NOT app.integration_entity_has_active(p_entity) THEN
    RAISE EXCEPTION 'These records cannot be made inactive; choose to do nothing or to list them' USING ERRCODE = 'QM022';
  END IF;
  IF v_template IS NOT NULL THEN
    SELECT * INTO t FROM public.integration_templates WHERE id = v_template AND organisation_id = c.organisation_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Template not found' USING ERRCODE = 'P0002'; END IF;
    IF t.entity_type <> p_entity THEN RAISE EXCEPTION 'That template is for another kind of record' USING ERRCODE = 'QM022'; END IF;
    IF t.archived_at IS NOT NULL THEN RAISE EXCEPTION 'That template is archived' USING ERRCODE = 'QM022'; END IF;
  END IF;
  IF v_schedule <> 'manual' THEN
    IF v_kind = 'file' THEN
      RAISE EXCEPTION 'An uploaded file is imported when someone uploads it: a file connection cannot run on a schedule' USING ERRCODE = 'QM022';
    END IF;
    IF v_schedule <> 'daily' AND v_provider <> 'sql_agent' THEN
      RAISE EXCEPTION 'An API connection runs by hand or daily; only a database connection runs every few minutes' USING ERRCODE = 'QM022';
    END IF;
    IF v_provider = 'rest_api' AND NOT ((c.config -> 'entities') ? p_entity) THEN
      RAISE EXCEPTION 'Say in the connection''s settings where the API gives these records before scheduling them' USING ERRCODE = 'QM022';
    END IF;
    IF v_provider = 'sql_agent' AND NOT EXISTS (SELECT 1 FROM public.integration_record_sources rs WHERE rs.connection_id = c.id AND rs.entity_type = p_entity) THEN
      RAISE EXCEPTION 'Choose the table these records are read from before scheduling them' USING ERRCODE = 'QM022';
    END IF;
    IF v_template IS NULL THEN RAISE EXCEPTION 'Choose the import template a scheduled import uses' USING ERRCODE = 'QM022'; END IF;
    IF NOT app.has_permission(c.organisation_id, 'integrations.run') OR NOT app.integration_may_write(c.organisation_id, p_entity) THEN
      RAISE EXCEPTION 'A scheduled import writes these records as you, so it needs you to be allowed to run imports and to create and edit them' USING ERRCODE = '42501';
    END IF;
    -- Scheduled runs act for whoever last switched the schedule on, changed how often it runs, or changed what it imports with.
    v_set_by := CASE WHEN old.schedule IS DISTINCT FROM v_schedule OR old.template_id IS DISTINCT FROM v_template OR old.schedule_set_by IS NULL THEN auth.uid() ELSE old.schedule_set_by END;
  ELSE
    v_set_by := NULL;
  END IF;
  INSERT INTO public.integration_import_settings AS s (organisation_id, connection_id, entity_type, write_mode, match_existing, on_missing, schedule, template_id, schedule_set_by)
  VALUES (c.organisation_id, c.id, p_entity, v_mode, v_match, v_missing, v_schedule, v_template, v_set_by)
  ON CONFLICT (connection_id, entity_type) DO UPDATE
     SET write_mode = EXCLUDED.write_mode, match_existing = EXCLUDED.match_existing, on_missing = EXCLUDED.on_missing, schedule = EXCLUDED.schedule,
         template_id = EXCLUDED.template_id, schedule_set_by = EXCLUDED.schedule_set_by,
         last_schedule_problem = CASE WHEN EXCLUDED.schedule <> 'manual' THEN s.last_schedule_problem END,
         updated_at = now(), updated_by = auth.uid()
   WHERE (s.write_mode, s.match_existing, s.on_missing, s.schedule, s.template_id, s.schedule_set_by)
         IS DISTINCT FROM (EXCLUDED.write_mode, EXCLUDED.match_existing, EXCLUDED.on_missing, EXCLUDED.schedule, EXCLUDED.template_id, EXCLUDED.schedule_set_by);
  RETURN app.integration_settings_for(c.id, p_entity);
END $$;

-- ---------------------------------------------------------------------------
-- Extraction jobs: one place that makes them (people's runs and scheduled runs)
-- ---------------------------------------------------------------------------
-- The job for a run of a database connection: the connection's settings, the source, and for an incremental run the high-water mark of the last
-- finished run (the cursor `{"w": …}`). Refuses an incremental run when the source names no changed column.
CREATE FUNCTION app.integration_queue_extract(p_run uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.integration_sync_runs%ROWTYPE; c public.integration_connections%ROWTYPE; v_source jsonb; v_since text; v_req jsonb; v_id uuid;
BEGIN
  SELECT * INTO r FROM public.integration_sync_runs WHERE id = p_run;
  SELECT * INTO c FROM public.integration_connections WHERE id = r.connection_id;
  SELECT source INTO v_source FROM public.integration_record_sources WHERE connection_id = c.id AND entity_type = r.entity_type;
  IF v_source IS NULL THEN
    RAISE EXCEPTION 'This connection does not say which table holds % records: choose it on the connection''s page', replace(r.entity_type, '_', ' ') USING ERRCODE = 'QM022';
  END IF;
  IF r.kind = 'incremental' THEN
    IF NOT v_source ? 'changedColumn' THEN
      RAISE EXCEPTION 'Say which column shows when a row changed to read only what changed, or run a full import' USING ERRCODE = 'QM022';
    END IF;
    BEGIN
      v_since := (r.cursor_start::jsonb) ->> 'w';
    EXCEPTION WHEN others THEN v_since := NULL;
    END;
  END IF;
  v_req := v_source || jsonb_strip_nulls(jsonb_build_object('batchRows', 1000, 'maxRows', CASE WHEN r.kind = 'preview' THEN 1000 END, 'changedSince', v_since));
  INSERT INTO public.integration_agent_jobs (organisation_id, agent_id, connection_id, run_id, kind, spec, max_attempts, requested_by)
  VALUES (c.organisation_id, c.agent_id, c.id, r.id, 'extract',
          jsonb_build_object('connectionId', c.id, 'runId', r.id, 'entityType', r.entity_type, 'connection', c.config, 'request', v_req), 3, r.requested_by)
  RETURNING id INTO v_id;
  UPDATE public.integration_agents SET fast_poll_until = greatest(coalesce(fast_poll_until, now()), now() + interval '10 minutes') WHERE id = c.agent_id;
  RETURN v_id;
END $$;

-- The latest definition (20260307100000) with incremental reads for a database connection, through app.integration_queue_extract.
CREATE OR REPLACE FUNCTION app.request_integration_run(p_connection uuid, p_entity text, p_kind text, p_file uuid DEFAULT NULL, p_template uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.integration_connections%ROWTYPE; v_provider text; v_cursor text; v_id uuid; v_mapping uuid; f public.integration_files%ROWTYPE;
        t public.integration_templates%ROWTYPE; tv public.integration_template_versions%ROWTYPE; v_settings jsonb; v_source jsonb; v_problems text[];
BEGIN
  c := app.integration_connection_for_write(p_connection, 'integrations.run');
  PERFORM app.integration_assert_entity(p_entity);
  IF p_kind IS NULL OR p_kind NOT IN ('preview', 'full', 'incremental') THEN
    RAISE EXCEPTION 'An import is a preview, a full import or an incremental import' USING ERRCODE = 'QM022';
  END IF;
  IF c.status = 'retired' THEN RAISE EXCEPTION 'A retired connection cannot import' USING ERRCODE = 'QM022'; END IF;
  IF p_kind <> 'preview' AND c.status <> 'active' THEN
    RAISE EXCEPTION 'Only an active connection can import records; run a preview until it is activated' USING ERRCODE = 'QM022';
  END IF;
  IF p_kind <> 'preview' AND NOT app.integration_may_write(c.organisation_id, p_entity) THEN
    RAISE EXCEPTION 'You can preview these records, but writing them to Fortress needs the permission to create and edit them' USING ERRCODE = '42501';
  END IF;
  v_settings := app.integration_settings_for(c.id, p_entity);
  IF p_template IS NOT NULL THEN
    SELECT * INTO t FROM public.integration_templates WHERE id = p_template AND organisation_id = c.organisation_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Template not found' USING ERRCODE = 'P0002'; END IF;
    IF t.entity_type <> p_entity THEN RAISE EXCEPTION 'That template is for another kind of record' USING ERRCODE = 'QM022'; END IF;
    IF t.archived_at IS NOT NULL THEN RAISE EXCEPTION 'That template is archived' USING ERRCODE = 'QM022'; END IF;
    SELECT * INTO tv FROM public.integration_template_versions WHERE template_id = t.id AND version = t.current_version;
    v_settings := v_settings || tv.settings;
  ELSE
    SELECT id INTO v_mapping FROM public.integration_mappings WHERE connection_id = c.id AND entity_type = p_entity AND superseded_at IS NULL;
  END IF;
  SELECT key INTO v_provider FROM public.integration_providers WHERE id = c.provider_id;
  IF v_provider = 'csv' THEN
    IF p_kind = 'incremental' THEN RAISE EXCEPTION 'A file is always imported whole: choose a full import' USING ERRCODE = 'QM022'; END IF;
    IF p_file IS NULL THEN RAISE EXCEPTION 'Choose the file to import' USING ERRCODE = 'QM022'; END IF;
    SELECT * INTO f FROM public.integration_files WHERE id = p_file AND connection_id = c.id AND organisation_id = c.organisation_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'File not found' USING ERRCODE = 'P0002'; END IF;
    IF f.status <> 'parsed' THEN RAISE EXCEPTION 'That file could not be read, or its rows have been cleared' USING ERRCODE = 'QM022'; END IF;
    IF v_mapping IS NULL AND tv.id IS NULL THEN RAISE EXCEPTION 'Map the file''s columns before importing' USING ERRCODE = 'QM022'; END IF;
  ELSIF p_file IS NOT NULL THEN
    RAISE EXCEPTION 'Only a file connection imports a file' USING ERRCODE = 'QM022';
  END IF;
  IF v_provider = 'rest_api' THEN
    IF NOT ((c.config -> 'entities') ? p_entity) THEN
      RAISE EXCEPTION 'This connection does not say where to read % records: add them in its settings', replace(p_entity, '_', ' ') USING ERRCODE = 'QM022';
    END IF;
    IF NOT app.integration_host_allowed(c.organisation_id, c.config ->> 'baseUrl') THEN
      RAISE EXCEPTION 'Your organisation does not allow connections to %', app.integration_url_host(c.config ->> 'baseUrl') USING ERRCODE = 'QM022';
    END IF;
    IF p_kind = 'incremental' AND NOT ((c.config -> 'entities' -> p_entity) ? 'incremental') THEN
      RAISE EXCEPTION 'Say which parameter and field an incremental import of % records uses, or run a full import', replace(p_entity, '_', ' ') USING ERRCODE = 'QM022';
    END IF;
  END IF;
  IF v_provider = 'sql_agent' THEN
    SELECT source INTO v_source FROM public.integration_record_sources WHERE connection_id = c.id AND entity_type = p_entity;
    IF v_source IS NULL THEN
      RAISE EXCEPTION 'This connection does not say which table holds % records: choose it on the connection''s page', replace(p_entity, '_', ' ') USING ERRCODE = 'QM022';
    END IF;
    IF p_kind = 'incremental' AND NOT v_source ? 'changedColumn' THEN
      RAISE EXCEPTION 'Say which column shows when a row changed to read only what changed, or run a full import' USING ERRCODE = 'QM022';
    END IF;
    v_problems := app.integration_agent_problems(c.id);
    IF coalesce(array_length(v_problems, 1), 0) > 0 THEN RAISE EXCEPTION '%', v_problems[1] USING ERRCODE = 'QM022'; END IF;
  END IF;
  PERFORM app.integration_assert_idle(c.id, p_entity);
  IF p_kind = 'incremental' THEN
    SELECT cursor INTO v_cursor FROM public.integration_sync_cursors WHERE connection_id = c.id AND entity_type = p_entity;
  END IF;
  INSERT INTO public.integration_sync_runs (organisation_id, connection_id, entity_type, kind, requested_by, cursor_start, cursor_next, file_id, mapping_id, template_version_id, settings)
  VALUES (c.organisation_id, c.id, p_entity, p_kind, auth.uid(), v_cursor, v_cursor, p_file, v_mapping, tv.id, v_settings)
  RETURNING id INTO v_id;
  IF v_provider = 'sql_agent' THEN PERFORM app.integration_queue_extract(v_id); END IF;
  RETURN v_id;
END $$;

-- The latest definition (20260123100000), now for every schedule: daily ones only when p_daily (the daily cron), the 5 / 15 / 60-minute ones on
-- every call (the worker, each minute) once their interval has passed. A database connection's run comes with its extraction, and is not asked
-- for while its agent is offline.
DROP FUNCTION app.system_schedule_integration_runs(date);
CREATE FUNCTION app.system_schedule_integration_runs(p_today date DEFAULT current_date, p_daily boolean DEFAULT true) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s record; v_problem text; v_ok boolean; v_claims text := coalesce(current_setting('request.jwt.claims', true), ''); v_kind text; v_cursor text;
        tv public.integration_template_versions%ROWTYPE; v_run uuid; out jsonb := '[]'::jsonb; v_source jsonb; v_every interval; v_agent_problems text[];
BEGIN
  FOR s IN
    SELECT st.*, c.status AS conn_status, c.config, c.agent_id, p.key AS provider_key, p.kind AS provider_kind, t.current_version, t.archived_at AS template_archived
      FROM public.integration_import_settings st
      JOIN public.integration_connections c ON c.id = st.connection_id
      JOIN public.integration_providers p ON p.id = c.provider_id
      JOIN public.organisations o ON o.id = st.organisation_id AND o.status = 'active'
      LEFT JOIN public.integration_templates t ON t.id = st.template_id
     WHERE (st.schedule = 'daily' AND p_daily) OR app.integration_schedule_interval(st.schedule) IS NOT NULL
     ORDER BY st.organisation_id, st.connection_id, st.entity_type
     FOR UPDATE OF st
  LOOP
    v_problem := NULL; v_run := NULL;
    v_every := app.integration_schedule_interval(s.schedule);
    IF v_every IS NULL THEN
      -- Daily: already asked for today.
      IF EXISTS (SELECT 1 FROM public.integration_sync_runs r WHERE r.connection_id = s.connection_id AND r.entity_type = s.entity_type
                   AND r.trigger = 'schedule' AND r.requested_at >= p_today::timestamptz AND r.requested_at < (p_today + 1)::timestamptz) THEN
        CONTINUE;
      END IF;
    ELSIF s.last_scheduled_at IS NOT NULL AND s.last_scheduled_at > now() - v_every + interval '20 seconds' THEN
      CONTINUE;
    END IF;
    IF EXISTS (SELECT 1 FROM public.integration_sync_runs r WHERE r.connection_id = s.connection_id AND r.entity_type = s.entity_type AND r.status IN ('queued', 'running')) THEN
      out := out || jsonb_build_object('connectionId', s.connection_id, 'entityType', s.entity_type, 'runId', NULL, 'skipped', 'An earlier import is still running; it carries on');
      CONTINUE;
    END IF;
    v_source := NULL;
    IF s.provider_key = 'sql_agent' THEN SELECT source INTO v_source FROM public.integration_record_sources WHERE connection_id = s.connection_id AND entity_type = s.entity_type; END IF;
    IF s.conn_status <> 'active' THEN v_problem := 'The connection is not active';
    ELSIF s.provider_kind = 'file' THEN v_problem := 'A file connection does not run on a schedule';
    ELSIF v_every IS NOT NULL AND s.provider_key <> 'sql_agent' THEN v_problem := 'Only a database connection runs every few minutes';
    ELSIF s.template_id IS NULL OR s.template_archived IS NOT NULL THEN v_problem := 'The import template is missing or archived';
    ELSIF s.schedule_set_by IS NULL THEN v_problem := 'Nobody is recorded as having scheduled it: switch the schedule on again';
    ELSIF s.provider_key = 'rest_api' AND NOT ((s.config -> 'entities') ? s.entity_type) THEN v_problem := 'The connection no longer says where the API gives these records';
    ELSIF s.provider_key = 'rest_api' AND NOT app.integration_host_allowed(s.organisation_id, s.config ->> 'baseUrl') THEN v_problem := 'Your organisation no longer allows connections to this host';
    ELSIF s.provider_key = 'sql_agent' AND v_source IS NULL THEN v_problem := 'The connection no longer says which table holds these records';
    ELSIF s.provider_key = 'sql_agent' THEN
      v_agent_problems := app.integration_agent_problems(s.connection_id);
      IF coalesce(array_length(v_agent_problems, 1), 0) > 0 THEN v_problem := v_agent_problems[1];
      ELSIF NOT app.integration_agent_online(s.agent_id) THEN v_problem := 'The connector agent is offline: the import is asked for again once it checks in';
      END IF;
    END IF;
    IF v_problem IS NULL THEN
      PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', s.schedule_set_by, 'role', 'authenticated', 'aal', 'aal2')::text, true);
      v_ok := app.is_member(s.organisation_id) AND app.has_permission(s.organisation_id, 'integrations.run') AND app.integration_may_write(s.organisation_id, s.entity_type);
      PERFORM set_config('request.jwt.claims', v_claims, true);
      IF NOT coalesce(v_ok, false) THEN v_problem := 'The person who scheduled it may no longer run this import: someone allowed to should switch the schedule on again'; END IF;
    END IF;
    IF v_problem IS NULL THEN
      SELECT cursor INTO v_cursor FROM public.integration_sync_cursors WHERE connection_id = s.connection_id AND entity_type = s.entity_type;
      v_kind := CASE
        WHEN v_cursor IS NULL THEN 'full'
        WHEN s.provider_key = 'rest_api' AND NOT ((s.config -> 'entities' -> s.entity_type) ? 'incremental') THEN 'full'
        WHEN s.provider_key = 'sql_agent' AND NOT (v_source ? 'changedColumn') THEN 'full'
        ELSE 'incremental' END;
      SELECT * INTO tv FROM public.integration_template_versions WHERE template_id = s.template_id AND version = s.current_version;
      INSERT INTO public.integration_sync_runs (organisation_id, connection_id, entity_type, kind, trigger, requested_by, cursor_start, cursor_next, template_version_id, settings)
      VALUES (s.organisation_id, s.connection_id, s.entity_type, v_kind, 'schedule', s.schedule_set_by,
              CASE WHEN v_kind = 'incremental' THEN v_cursor END, CASE WHEN v_kind = 'incremental' THEN v_cursor END,
              tv.id, app.integration_settings_for(s.connection_id, s.entity_type) || coalesce(tv.settings, '{}'::jsonb))
      RETURNING id INTO v_run;
      IF s.provider_key = 'sql_agent' THEN PERFORM app.integration_queue_extract(v_run); END IF;
    END IF;
    UPDATE public.integration_import_settings SET last_scheduled_at = now(), last_schedule_problem = v_problem
     WHERE connection_id = s.connection_id AND entity_type = s.entity_type;
    out := out || jsonb_build_object('connectionId', s.connection_id, 'entityType', s.entity_type, 'runId', v_run, 'skipped', v_problem);
  END LOOP;
  RETURN out;
END $$;

-- ---------------------------------------------------------------------------
-- The high-water mark the agent reports
-- ---------------------------------------------------------------------------
-- The latest definition (20260307100000) plus the agent's running high-water mark (the highest changed value it has sent so far), kept on the job.
DROP FUNCTION app.system_agent_store_batch(uuid, uuid, integer, text, text, jsonb);
CREATE FUNCTION app.system_agent_store_batch(p_agent uuid, p_job uuid, p_seq integer, p_checksum text, p_last_key text, p_rows jsonb, p_changed_up_to text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE j public.integration_agent_jobs%ROWTYPE; b public.integration_agent_batches%ROWTYPE; v_count integer; v_rows bigint; v_max integer; v_n integer; v_mark text;
BEGIN
  SELECT * INTO j FROM public.integration_agent_jobs WHERE id = p_job AND agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002'; END IF;
  IF j.kind <> 'extract' THEN RAISE EXCEPTION 'Only an extraction job takes rows' USING ERRCODE = 'QM022'; END IF;
  IF j.status IN ('completed', 'failed', 'cancelled') THEN
    RETURN jsonb_build_object('status', j.status, 'cancelled', j.status = 'cancelled', 'stored', false);
  END IF;
  IF j.status = 'pending' THEN RAISE EXCEPTION 'Take the job again before sending its rows' USING ERRCODE = 'QM022'; END IF;
  IF p_seq IS NULL OR p_seq < 0 THEN RAISE EXCEPTION 'A batch needs its sequence number' USING ERRCODE = 'QM022'; END IF;
  IF p_checksum IS NULL OR p_checksum !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'A batch needs its checksum' USING ERRCODE = 'QM022'; END IF;
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'A batch''s rows are a list' USING ERRCODE = 'QM022'; END IF;
  IF p_changed_up_to IS NOT NULL AND length(p_changed_up_to) > 2000 THEN RAISE EXCEPTION 'The changed value is at most 2,000 characters' USING ERRCODE = 'QM022'; END IF;
  v_n := jsonb_array_length(p_rows);
  IF v_n > 1000 THEN RAISE EXCEPTION 'A batch holds at most 1,000 rows' USING ERRCODE = 'QM022'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) e WHERE jsonb_typeof(e) <> 'object') THEN RAISE EXCEPTION 'Each row is an object of column values' USING ERRCODE = 'QM022'; END IF;
  SELECT * INTO b FROM public.integration_agent_batches WHERE job_id = j.id AND seq = p_seq;
  IF FOUND THEN
    IF b.checksum <> p_checksum THEN RAISE EXCEPTION 'Batch % was already received with different rows', p_seq USING ERRCODE = 'QM022'; END IF;
    SELECT count(*), coalesce(sum(row_count), 0) INTO v_count, v_rows FROM public.integration_agent_batches WHERE job_id = j.id;
    RETURN jsonb_build_object('status', j.status, 'cancelled', false, 'stored', false, 'duplicate', true, 'batches', v_count, 'rows', v_rows);
  END IF;
  SELECT count(*), coalesce(sum(row_count), 0) INTO v_count, v_rows FROM public.integration_agent_batches WHERE job_id = j.id;
  IF p_seq <> v_count THEN RAISE EXCEPTION 'Batch % was expected next, not batch %', v_count, p_seq USING ERRCODE = 'QM022'; END IF;
  v_max := CASE WHEN jsonb_typeof(j.spec -> 'request' -> 'maxRows') = 'number' THEN (j.spec -> 'request' ->> 'maxRows')::integer END;
  IF v_max IS NOT NULL AND v_rows + v_n > v_max THEN RAISE EXCEPTION 'This extraction reads at most % rows', v_max USING ERRCODE = 'QM022'; END IF;
  INSERT INTO public.integration_agent_batches (organisation_id, job_id, seq, row_count, checksum, last_key, rows)
  VALUES (j.organisation_id, j.id, p_seq, v_n, p_checksum, left(p_last_key, 2000), p_rows);
  v_mark := coalesce(p_changed_up_to, j.progress ->> 'changedUpTo');
  UPDATE public.integration_agent_jobs
     SET status = 'running', started_at = coalesce(started_at, clock_timestamp()), updated_at = clock_timestamp(),
         progress = jsonb_strip_nulls(jsonb_build_object('batches', v_count + 1, 'rows', v_rows + v_n, 'changedUpTo', v_mark)),
         leased_until = greatest(leased_until, now() + interval '5 minutes')
   WHERE id = j.id;
  RETURN jsonb_build_object('status', 'running', 'cancelled', false, 'stored', true, 'batches', v_count + 1, 'rows', v_rows + v_n);
END $$;

-- The latest definition (20260307100000): a job taken again also carries the high-water mark reached so far.
CREATE OR REPLACE FUNCTION app.system_agent_next_job(p_agent uuid, p_lease_seconds integer DEFAULT 300) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.integration_agents%ROWTYPE; j public.integration_agent_jobs%ROWTYPE; v_resume jsonb;
BEGIN
  SELECT * INTO r FROM public.integration_agents WHERE id = p_agent;
  IF NOT FOUND OR r.status <> 'active' THEN RETURN NULL; END IF;
  UPDATE public.integration_agent_jobs SET status = 'failed', finished_at = clock_timestamp(), updated_at = clock_timestamp(), leased_until = NULL,
         error_kind = 'lease_expired', error_message = 'The agent did not finish the job in time'
   WHERE agent_id = p_agent AND status IN ('received', 'running') AND leased_until < now() AND attempts >= max_attempts;
  SELECT * INTO j FROM public.integration_agent_jobs
   WHERE agent_id = p_agent
     AND (status = 'pending' OR (status IN ('received', 'running') AND leased_until < now() AND attempts < max_attempts))
   ORDER BY created_at
   LIMIT 1
   FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE public.integration_agent_jobs
     SET status = 'received', attempts = attempts + 1, received_at = clock_timestamp(), updated_at = clock_timestamp(),
         leased_until = now() + make_interval(secs => greatest(30, least(coalesce(p_lease_seconds, 300), 3600)))
   WHERE id = j.id RETURNING * INTO j;
  IF j.kind = 'extract' THEN
    SELECT jsonb_strip_nulls(jsonb_build_object('nextSeq', count(*), 'rows', coalesce(sum(b.row_count), 0),
                              'afterKey', (SELECT b2.last_key FROM public.integration_agent_batches b2 WHERE b2.job_id = j.id ORDER BY b2.seq DESC LIMIT 1),
                              'changedUpTo', j.progress ->> 'changedUpTo'))
      INTO v_resume FROM public.integration_agent_batches b WHERE b.job_id = j.id;
  END IF;
  RETURN jsonb_strip_nulls(jsonb_build_object('id', j.id, 'kind', j.kind, 'spec', j.spec, 'attempt', j.attempts, 'leasedUntil', j.leased_until, 'resume', v_resume));
END $$;

-- The latest definition (20260307100000): a completed extraction keeps the high-water mark it reached.
CREATE OR REPLACE FUNCTION app.system_agent_job_report(p_agent uuid, p_job uuid, p_action text, p_payload jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE j public.integration_agent_jobs%ROWTYPE; v_transient boolean; v_kind text; v_message text; v_result jsonb; v_batches integer; v_rows bigint; v_mark text;
BEGIN
  SELECT * INTO j FROM public.integration_agent_jobs WHERE id = p_job AND agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002'; END IF;
  p_payload := coalesce(p_payload, '{}'::jsonb);
  IF j.status IN ('completed', 'failed', 'cancelled') THEN
    RETURN jsonb_build_object('status', j.status, 'cancelled', j.status = 'cancelled');
  END IF;
  IF p_action = 'ack' THEN
    UPDATE public.integration_agent_jobs SET status = 'running', started_at = coalesce(started_at, clock_timestamp()), updated_at = clock_timestamp()
     WHERE id = j.id RETURNING * INTO j;
  ELSIF p_action = 'progress' THEN
    UPDATE public.integration_agent_jobs
       SET status = 'running', started_at = coalesce(started_at, clock_timestamp()), progress = p_payload -> 'progress', updated_at = clock_timestamp(),
           leased_until = greatest(leased_until, now() + interval '5 minutes')
     WHERE id = j.id RETURNING * INTO j;
  ELSIF p_action = 'complete' THEN
    v_result := p_payload -> 'result';
    IF j.kind = 'extract' THEN
      SELECT count(*), coalesce(sum(row_count), 0) INTO v_batches, v_rows FROM public.integration_agent_batches WHERE job_id = j.id;
      IF jsonb_typeof(v_result -> 'batches') IS DISTINCT FROM 'number' OR (v_result ->> 'batches')::numeric <> v_batches
         OR jsonb_typeof(v_result -> 'rows') IS DISTINCT FROM 'number' OR (v_result ->> 'rows')::numeric <> v_rows THEN
        RAISE EXCEPTION 'The agent says it sent % batches (% rows), but Fortress holds % (% rows): send the missing ones again',
          coalesce(v_result ->> 'batches', '?'), coalesce(v_result ->> 'rows', '?'), v_batches, v_rows USING ERRCODE = 'QM022';
      END IF;
      v_mark := left(coalesce(CASE WHEN jsonb_typeof(v_result -> 'changedUpTo') = 'string' THEN v_result ->> 'changedUpTo' END, j.progress ->> 'changedUpTo'), 2000);
      v_result := jsonb_strip_nulls(jsonb_build_object('batches', v_batches, 'rows', v_rows,
                    'columns', CASE WHEN jsonb_typeof(v_result -> 'columns') = 'array' THEN v_result -> 'columns' END,
                    'truncated', CASE WHEN jsonb_typeof(v_result -> 'truncated') = 'boolean' THEN v_result -> 'truncated' END,
                    'changedUpTo', v_mark));
    END IF;
    UPDATE public.integration_agent_jobs
       SET status = 'completed', started_at = coalesce(started_at, clock_timestamp()), finished_at = clock_timestamp(), updated_at = clock_timestamp(),
           leased_until = NULL, result = v_result, error_kind = NULL, error_message = NULL,
           progress = CASE WHEN j.kind = 'extract' THEN jsonb_strip_nulls(jsonb_build_object('batches', v_batches, 'rows', v_rows, 'changedUpTo', v_mark)) ELSE progress END
     WHERE id = j.id RETURNING * INTO j;
  ELSIF p_action = 'fail' THEN
    v_transient := coalesce((p_payload ->> 'transient')::boolean, false);
    v_kind := CASE WHEN p_payload ->> 'kind' IN ('auth', 'network', 'timeout', 'not_found', 'refused', 'invalid', 'internal') THEN p_payload ->> 'kind' ELSE 'internal' END;
    v_message := left(coalesce(nullif(btrim(p_payload ->> 'message'), ''), 'The agent could not do the job'), 1000);
    IF v_transient AND j.attempts < j.max_attempts THEN
      UPDATE public.integration_agent_jobs SET status = 'pending', leased_until = NULL, updated_at = clock_timestamp(), error_kind = v_kind, error_message = v_message
       WHERE id = j.id RETURNING * INTO j;
    ELSE
      UPDATE public.integration_agent_jobs SET status = 'failed', finished_at = clock_timestamp(), updated_at = clock_timestamp(), leased_until = NULL,
             error_kind = v_kind, error_message = v_message
       WHERE id = j.id RETURNING * INTO j;
      PERFORM app.agent_event(p_agent, 'job_failed', jsonb_build_object('job', j.id, 'kind', j.kind, 'error', v_kind));
    END IF;
  ELSE
    RAISE EXCEPTION 'Unknown report' USING ERRCODE = 'QM022';
  END IF;
  RETURN jsonb_build_object('status', j.status, 'cancelled', false);
END $$;

-- The latest definition (20260307100000): the engine is also told the run's changed column, the mark it read from and the mark it reached.
CREATE OR REPLACE FUNCTION app.system_lease_integration_run(p_org uuid, p_run uuid, p_owner uuid, p_seconds integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.integration_sync_runs%ROWTYPE; c public.integration_connections%ROWTYPE; v_provider text; m public.integration_mappings%ROWTYPE; f public.integration_files%ROWTYPE;
        tv public.integration_template_versions%ROWTYPE; v_mapping jsonb; j public.integration_agent_jobs%ROWTYPE;
BEGIN
  IF p_owner IS NULL OR p_seconds IS NULL OR p_seconds NOT BETWEEN 5 AND 600 THEN RAISE EXCEPTION 'A lease needs an owner and 5 to 600 seconds' USING ERRCODE = 'QM022'; END IF;
  SELECT * INTO r FROM public.integration_sync_runs WHERE id = p_run AND organisation_id = p_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Import not found' USING ERRCODE = 'P0002'; END IF;
  IF r.status NOT IN ('queued', 'running') THEN RETURN jsonb_build_object('leased', false, 'reason', 'This import has finished'); END IF;
  IF r.lease_until > clock_timestamp() AND r.lease_owner IS DISTINCT FROM p_owner THEN RETURN jsonb_build_object('leased', false, 'reason', 'This import is being worked on already'); END IF;
  SELECT * INTO j FROM public.integration_agent_jobs WHERE run_id = r.id AND organisation_id = p_org AND kind = 'extract';
  IF FOUND AND NOT r.fetch_done AND j.status <> 'completed' THEN
    IF j.status IN ('pending', 'received', 'running') THEN
      RETURN jsonb_build_object('leased', false, 'waitingForAgent', true,
        'reason', CASE WHEN j.status = 'pending' THEN 'Waiting for the connector agent to take the job'
                       ELSE format('Waiting for the connector agent: %s rows read so far', coalesce((j.progress ->> 'rows')::bigint, 0)) END);
    END IF;
    RETURN jsonb_build_object('leased', false, 'reason', coalesce(j.error_message, 'The connector agent could not read the records'));
  END IF;
  IF r.next_attempt_at > now() THEN RETURN jsonb_build_object('leased', false, 'reason', 'Waiting to try again', 'nextAttemptAt', r.next_attempt_at); END IF;
  SELECT * INTO c FROM public.integration_connections WHERE id = r.connection_id AND organisation_id = p_org;
  IF c.status = 'retired' THEN
    UPDATE public.integration_sync_runs SET status = 'cancelled', cancel_reason = 'The connection was retired', finished_at = now(), lease_owner = NULL, lease_until = NULL, updated_at = now() WHERE id = r.id;
    UPDATE public.integration_inbox SET retry_run_id = NULL, updated_at = now() WHERE retry_run_id = r.id AND status = 'failed';
    RETURN jsonb_build_object('leased', false, 'reason', 'The connection was retired');
  END IF;
  IF r.kind <> 'preview' AND c.status <> 'active' THEN RETURN jsonb_build_object('leased', false, 'reason', 'The connection is not active'); END IF;
  SELECT key INTO v_provider FROM public.integration_providers WHERE id = c.provider_id;
  IF r.template_version_id IS NOT NULL THEN
    SELECT * INTO tv FROM public.integration_template_versions WHERE id = r.template_version_id AND organisation_id = p_org;
    v_mapping := jsonb_build_object('id', tv.id, 'version', tv.version, 'keyField', tv.key_field, 'fields', tv.fields, 'templateId', tv.template_id);
  ELSIF r.mapping_id IS NOT NULL THEN
    SELECT * INTO m FROM public.integration_mappings WHERE id = r.mapping_id AND organisation_id = p_org;
    v_mapping := jsonb_build_object('id', m.id, 'version', m.version, 'keyField', m.key_field, 'fields', m.fields);
  END IF;
  IF r.file_id IS NOT NULL THEN SELECT * INTO f FROM public.integration_files WHERE id = r.file_id AND organisation_id = p_org; END IF;
  UPDATE public.integration_sync_runs
     SET status = 'running', lease_owner = p_owner, lease_until = clock_timestamp() + make_interval(secs => p_seconds), started_at = coalesce(started_at, now()), updated_at = now()
   WHERE id = r.id;
  RETURN jsonb_build_object('leased', true, 'id', r.id, 'organisationId', r.organisation_id, 'connectionId', r.connection_id, 'providerKey', v_provider,
    'config', c.config, 'externalSystem', c.external_system, 'entityType', r.entity_type, 'kind', r.kind, 'cursor', r.cursor_next, 'fetchDone', r.fetch_done,
    'requestedBy', r.requested_by, 'recordsTotal', r.records_total, 'attempts', r.attempts,
    'settings', coalesce(r.settings, app.integration_settings_for(r.connection_id, r.entity_type)),
    'file', CASE WHEN f.id IS NULL THEN NULL ELSE jsonb_build_object('id', f.id, 'status', f.status, 'chunkCount', f.chunk_count, 'headers', to_jsonb(f.headers)) END,
    'agent', CASE WHEN j.id IS NULL THEN NULL ELSE jsonb_strip_nulls(jsonb_build_object(
               'jobId', j.id, 'batchCount', coalesce((j.result ->> 'batches')::integer, 0),
               'changedColumn', j.spec -> 'request' ->> 'changedColumn', 'changedSince', j.spec -> 'request' ->> 'changedSince',
               'changedUpTo', j.result ->> 'changedUpTo')) END,
    'mapping', v_mapping);
END $$;

-- ---------------------------------------------------------------------------
-- An agent that stops answering
-- ---------------------------------------------------------------------------
-- Jobs that have waited 15 minutes for an agent that has not checked in for 15 minutes fail, with when it was last seen; a failed extraction fails
-- its import (app.integration_agent_job_outcome). A password waits for the agent's return instead: it is delivered when the agent checks in.
CREATE FUNCTION app.system_fail_stalled_agent_jobs() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n integer;
BEGIN
  WITH stalled AS (
    SELECT j.id, a.name, a.last_heartbeat_at
      FROM public.integration_agent_jobs j JOIN public.integration_agents a ON a.id = j.agent_id
     WHERE j.status IN ('pending', 'received', 'running') AND j.kind IN ('extract', 'test_connection', 'discover', 'preview', 'ping')
       AND j.created_at < now() - interval '15 minutes'
       AND (a.last_heartbeat_at IS NULL OR a.last_heartbeat_at < now() - interval '15 minutes')
     FOR UPDATE OF j SKIP LOCKED
  )
  UPDATE public.integration_agent_jobs j
     SET status = 'failed', finished_at = clock_timestamp(), updated_at = clock_timestamp(), leased_until = NULL, error_kind = 'timeout',
         error_message = CASE WHEN s.last_heartbeat_at IS NULL THEN format('The connector agent %s did not answer: it has not checked in', s.name)
                              ELSE format('The connector agent %s did not answer: it was last seen %s', s.name, to_char(s.last_heartbeat_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI "UTC"')) END
    FROM stalled s WHERE j.id = s.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- ---------------------------------------------------------------------------
-- Health: each database connection's agent
-- ---------------------------------------------------------------------------
-- The latest definition (20260123100000) plus `agent` (name, online, last seen) for a database connection.
CREATE OR REPLACE FUNCTION app.integration_health(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE out jsonb;
BEGIN
  IF NOT app.is_member(p_org) THEN RAISE EXCEPTION 'Organisation not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(p_org, 'integrations.read') THEN RAISE EXCEPTION 'You are not allowed to see integrations' USING ERRCODE = '42501'; END IF;
  SELECT coalesce(jsonb_agg(row ORDER BY row ->> 'connectionName', row ->> 'entityType'), '[]'::jsonb) INTO out FROM (
    SELECT jsonb_build_object(
      'connectionId', k.connection_id, 'connectionName', c.name, 'connectionStatus', c.status, 'providerKind', p.kind, 'entityType', k.entity_type,
      'schedule', coalesce(s.schedule, 'manual'), 'onMissing', coalesce(s.on_missing, 'nothing'),
      'template', CASE WHEN t.id IS NOT NULL THEN jsonb_build_object('id', t.id, 'name', t.name, 'version', t.current_version, 'archived', t.archived_at IS NOT NULL) END,
      'scheduledBy', s.schedule_set_by, 'lastScheduledAt', s.last_scheduled_at, 'scheduleProblem', s.last_schedule_problem,
      'agent', CASE WHEN ag.id IS NOT NULL THEN jsonb_build_object('id', ag.id, 'name', ag.name, 'online', app.integration_agent_online(ag.id), 'lastHeartbeatAt', ag.last_heartbeat_at) END,
      'lastRun', (SELECT jsonb_build_object('id', r.id, 'kind', r.kind, 'trigger', r.trigger, 'status', r.status, 'requestedAt', r.requested_at, 'finishedAt', r.finished_at,
                                           'errorSummary', r.error_summary, 'nextAttemptAt', CASE WHEN r.status IN ('queued', 'running') THEN r.next_attempt_at END)
                    FROM public.integration_sync_runs r WHERE r.connection_id = k.connection_id AND r.entity_type = k.entity_type AND r.kind <> 'preview'
                    ORDER BY r.requested_at DESC LIMIT 1),
      'lastSuccessAt', (SELECT max(r.finished_at) FROM public.integration_sync_runs r WHERE r.connection_id = k.connection_id AND r.entity_type = k.entity_type
                          AND r.kind IN ('full', 'incremental') AND r.status IN ('succeeded', 'partial')),
      'failedInARow', (SELECT count(*) FROM (
          SELECT sum(CASE WHEN r.status = 'failed' THEN 0 ELSE 1 END) OVER (ORDER BY r.requested_at DESC) AS ok_seen
            FROM public.integration_sync_runs r WHERE r.connection_id = k.connection_id AND r.entity_type = k.entity_type
             AND r.kind IN ('full', 'incremental') AND r.status IN ('succeeded', 'partial', 'failed')) z WHERE z.ok_seen = 0)::int,
      'rowsNeedingAction', (SELECT count(*) FROM app.integration_rows_needing_action(k.connection_id, k.entity_type))::int,
      'missingWaiting', (SELECT count(*) FROM public.integration_missing_records m WHERE m.connection_id = k.connection_id AND m.entity_type = k.entity_type AND m.status IN ('listed', 'held'))::int,
      'missingHeld', (SELECT count(*) FROM public.integration_missing_records m WHERE m.connection_id = k.connection_id AND m.entity_type = k.entity_type AND m.status = 'held')::int,
      'conflictsOpen', (SELECT count(*) FROM public.integration_conflicts f WHERE f.connection_id = k.connection_id AND f.entity_type = k.entity_type AND f.status = 'open')::int
    ) AS row
    FROM (SELECT connection_id, entity_type FROM public.integration_import_settings WHERE organisation_id = p_org
          UNION SELECT connection_id, entity_type FROM public.integration_sync_runs WHERE organisation_id = p_org AND kind <> 'preview') k
    JOIN public.integration_connections c ON c.id = k.connection_id AND c.status <> 'retired'
    JOIN public.integration_providers p ON p.id = c.provider_id
    LEFT JOIN public.integration_agents ag ON ag.id = c.agent_id
    LEFT JOIN public.integration_import_settings s ON s.connection_id = k.connection_id AND s.entity_type = k.entity_type
    LEFT JOIN public.integration_templates t ON t.id = s.template_id
  ) q;
  RETURN out;
END $$;

REVOKE ALL ON FUNCTION app.integration_schedule_interval(text), app.integration_agent_online(uuid), app.integration_queue_extract(uuid),
  app.system_schedule_integration_runs(date, boolean), app.system_agent_store_batch(uuid, uuid, integer, text, text, jsonb, text), app.system_fail_stalled_agent_jobs()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.integration_schedule_interval(text) TO authenticated;
GRANT EXECUTE ON FUNCTION app.system_schedule_integration_runs(date, boolean), app.system_agent_store_batch(uuid, uuid, integer, text, text, jsonb, text),
  app.system_fail_stalled_agent_jobs() TO qms_api;
