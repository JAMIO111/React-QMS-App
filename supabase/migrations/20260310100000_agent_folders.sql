-- Connector agent AG5b (docs/connector-agent-plan.md §18): files in a folder, read through the agent.
--  * A connection through an agent may name engine 'folder': the folder as the agent's machine knows it (a drive path, a share or, for tests, an
--    absolute Unix path), how to read its files (encoding, separator, headings, as for uploaded files) and no sign-in (the agent reads as its
--    service account). The agent reads only folders its own allow-list names (allowlist.json "folders"; none = no folder at all).
--  * A record source of a folder is a file name or pattern ("machines-*.csv"): the newest matching file directly in the folder is read.
--  * The agent never parses files: it uploads the bytes in signed parts (integration_agent_file_parts, ≤ 25 MB, never readable by people, cleared
--    when the job ends) and the API reads them with the same reader as uploaded files, then stores the rows as the extraction's batches, so a
--    folder import is a database import from there on (runs that wait for the agent, schedules, incremental reads, health).
--  * The mark of a folder source is the file's SHA-256: an incremental run sends it, and the agent uploads nothing when the newest file is the
--    same file. A full run always reads the file.

-- ---------------------------------------------------------------------------
-- A folder's settings and a file name
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.integration_folder_config_problem(p_config jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE k text; v_folder text := p_config ->> 'folder';
BEGIN
  FOR k IN SELECT jsonb_object_keys(p_config) LOOP
    IF k NOT IN ('engine', 'folder', 'authType', 'encoding', 'delimiter', 'hasHeader') THEN
      RETURN format('Unknown setting "%s" for a folder connection', k);
    END IF;
  END LOOP;
  IF jsonb_typeof(p_config -> 'folder') IS DISTINCT FROM 'string' OR length(v_folder) NOT BETWEEN 3 AND 260 THEN
    RETURN 'Give the folder as the agent''s machine knows it (up to 260 characters)';
  END IF;
  -- A drive path (C:\Exports), a share (\\server\share\Exports) or an absolute path (/srv/exports); nothing relative, no "..", no control characters.
  IF v_folder !~ '^([A-Za-z]:\\|\\\\[A-Za-z0-9._$-]+\\[^\\]+|/)' THEN
    RETURN 'Give the whole folder path: a drive (C:\Exports), a share (\\server\share\Exports) or a path starting with /';
  END IF;
  IF v_folder ~ '(^|[\\/])\.\.([\\/]|$)' OR v_folder ~ '[\x00-\x1f"<>|*?]' THEN
    RETURN 'The folder path cannot contain "..", quotes, < > | * ? or control characters';
  END IF;
  IF coalesce(p_config ->> 'authType', 'none') <> 'none' THEN
    RETURN 'A folder is read by the agent''s own service account: it takes no sign-in';
  END IF;
  IF p_config ? 'encoding' AND coalesce(p_config ->> 'encoding', '') NOT IN ('auto', 'utf-8', 'windows-1252', 'utf-16le', 'utf-16be') THEN
    RETURN 'The encoding is worked out from the file, or UTF-8, Windows-1252, UTF-16 LE or UTF-16 BE';
  END IF;
  IF p_config ? 'delimiter' AND coalesce(p_config ->> 'delimiter', '') NOT IN ('auto', ',', ';', 'tab', '|') THEN
    RETURN 'The separator is worked out from the file, or a comma, semicolon, tab or bar';
  END IF;
  IF p_config ? 'hasHeader' AND jsonb_typeof(p_config -> 'hasHeader') <> 'boolean' THEN RETURN 'Say whether the first line holds the column headings'; END IF;
  RETURN NULL;
END $$;

-- A file name or a pattern of one (* any run of characters, ? one), directly in the folder: no folders, no "..".
CREATE FUNCTION app.integration_file_name_problem(p jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE
    WHEN jsonb_typeof(p) IS DISTINCT FROM 'string' OR length(p #>> '{}') NOT BETWEEN 1 AND 200 THEN 'Give the file''s name, or a pattern such as machines-*.csv (up to 200 characters)'
    WHEN (p #>> '{}') ~ '[\\/:\x00-\x1f"<>|]' OR (p #>> '{}') IN ('.', '..') THEN 'A file name cannot contain \ / : " < > | or control characters: name a file directly in the folder'
    WHEN btrim(p #>> '{}') <> (p #>> '{}') THEN 'A file name does not start or end with a space'
    ELSE NULL END
$$;

CREATE FUNCTION app.integration_file_source_problem(p jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE k text;
BEGIN
  FOR k IN SELECT jsonb_object_keys(p) LOOP
    IF k <> 'file' THEN RETURN format('Unknown setting "%s" for a file source', k); END IF;
  END LOOP;
  RETURN app.integration_file_name_problem(p -> 'file');
END $$;

CREATE OR REPLACE FUNCTION app.integration_agent_config_problem(p_config jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE k text; v_engine text := p_config ->> 'engine'; v_auth text := p_config ->> 'authType';
BEGIN
  -- A folder of files (AG5b) has its own settings.
  IF p_config ->> 'engine' = 'folder' THEN RETURN app.integration_folder_config_problem(p_config); END IF;
  FOR k IN SELECT jsonb_object_keys(p_config) LOOP
    IF k NOT IN ('engine', 'server', 'port', 'instance', 'database', 'authType', 'encrypt', 'trustServerCertificate', 'timeoutSeconds') THEN
      RETURN format('Unknown setting "%s" for a database connection', k);
    END IF;
  END LOOP;
  IF v_engine IS NULL OR v_engine NOT IN ('sqlserver', 'postgres', 'mysql') THEN RETURN 'Choose the database: SQL Server, PostgreSQL or MySQL, or a folder of files'; END IF;
  IF jsonb_typeof(p_config -> 'server') IS DISTINCT FROM 'string' OR (p_config ->> 'server') !~ '^(\(local\)|\.|[A-Za-z0-9]([A-Za-z0-9._-]{0,251}[A-Za-z0-9])?|[0-9A-Fa-f:.]{2,45})$' THEN
    RETURN 'Give the database server''s name or address (letters, digits, dots and hyphens)';
  END IF;
  IF p_config ? 'port' AND (jsonb_typeof(p_config -> 'port') <> 'number' OR (p_config ->> 'port') !~ '^[0-9]+$' OR (p_config ->> 'port')::int NOT BETWEEN 1 AND 65535) THEN
    RETURN 'The port is a whole number from 1 to 65535';
  END IF;
  IF p_config ? 'instance' THEN
    IF v_engine <> 'sqlserver' THEN RETURN 'Only SQL Server has named instances'; END IF;
    IF jsonb_typeof(p_config -> 'instance') <> 'string' OR (p_config ->> 'instance') !~ '^[A-Za-z0-9_$#-]{1,32}$' THEN RETURN 'The instance name is up to 32 letters, digits, _ $ # or -'; END IF;
    IF p_config ? 'port' THEN RETURN 'Give a port or an instance name, not both'; END IF;
  END IF;
  IF jsonb_typeof(p_config -> 'database') IS DISTINCT FROM 'string' OR (p_config ->> 'database') !~ '^[^;=''"\[\]\x01-\x1f]{1,128}$' OR btrim(p_config ->> 'database') <> (p_config ->> 'database') THEN
    RETURN 'Give the database name (up to 128 characters, no ; = quotes or brackets)';
  END IF;
  IF v_engine = 'sqlserver' AND coalesce(v_auth, '') NOT IN ('windows', 'sql') THEN RETURN 'SQL Server signs in with Windows authentication (the agent''s service account) or a SQL login'; END IF;
  IF v_engine = 'postgres' AND coalesce(v_auth, '') <> 'password' THEN RETURN 'PostgreSQL signs in with a user name and password'; END IF;
  IF v_engine = 'mysql' AND coalesce(v_auth, '') <> 'password' THEN RETURN 'MySQL signs in with a user name and password'; END IF;
  IF p_config ? 'encrypt' AND jsonb_typeof(p_config -> 'encrypt') <> 'boolean' THEN RETURN 'Say whether the connection is encrypted'; END IF;
  IF p_config ? 'trustServerCertificate' AND jsonb_typeof(p_config -> 'trustServerCertificate') <> 'boolean' THEN RETURN 'Say whether the server''s certificate is trusted without checking'; END IF;
  IF p_config ? 'timeoutSeconds' AND (jsonb_typeof(p_config -> 'timeoutSeconds') <> 'number' OR (p_config ->> 'timeoutSeconds') !~ '^[0-9]+$' OR (p_config ->> 'timeoutSeconds')::int NOT BETWEEN 5 AND 120) THEN
    RETURN 'The timeout is a whole number of seconds from 5 to 120';
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION app.integration_record_source_problem(p jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE k text; f jsonb; v_cols text[]; n integer;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN RETURN 'The record source is not in the expected form'; END IF;
  -- Files in a folder (AG5b): which file, by name or pattern.
  IF p ? 'file' THEN RETURN app.integration_file_source_problem(p); END IF;
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

CREATE OR REPLACE FUNCTION app.set_integration_record_source(p_connection uuid, p_entity text, p_source jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.integration_connections%ROWTYPE; v_problem text; v_label text := replace(coalesce(p_entity, ''), '_', ' '); v_folder boolean;
BEGIN
  c := app.integration_connection_for_write(p_connection, 'integrations.manage');
  IF c.agent_id IS NULL THEN RAISE EXCEPTION 'Only a connection through a connector agent reads records from tables or files' USING ERRCODE = 'QM022'; END IF;
  v_folder := c.config ->> 'engine' = 'folder';
  IF c.status = 'retired' THEN RAISE EXCEPTION 'A retired connection cannot be changed' USING ERRCODE = 'QM022'; END IF;
  PERFORM app.integration_assert_entity(p_entity);
  IF p_source IS NULL THEN
    DELETE FROM public.integration_record_sources WHERE connection_id = c.id AND entity_type = p_entity;
    IF FOUND THEN PERFORM app.integration_log(c, 'config_changed', c.status, c.status,
      format('%s records are no longer read from this %s', initcap(v_label), CASE WHEN v_folder THEN 'folder' ELSE 'database' END)); END IF;
    RETURN;
  END IF;
  v_problem := app.integration_record_source_problem(p_source);
  IF v_problem IS NOT NULL THEN RAISE EXCEPTION '%', v_problem USING ERRCODE = 'QM022'; END IF;
  IF v_folder AND NOT p_source ? 'file' THEN RAISE EXCEPTION 'A folder connection reads files: say which file holds these records' USING ERRCODE = 'QM022'; END IF;
  IF NOT v_folder AND p_source ? 'file' THEN RAISE EXCEPTION 'A database connection reads tables, not files' USING ERRCODE = 'QM022'; END IF;
  INSERT INTO public.integration_record_sources (organisation_id, connection_id, entity_type, source, updated_by)
  VALUES (c.organisation_id, c.id, p_entity, p_source, auth.uid())
  ON CONFLICT (connection_id, entity_type) DO UPDATE SET source = EXCLUDED.source, updated_by = EXCLUDED.updated_by, updated_at = now()
   WHERE integration_record_sources.source IS DISTINCT FROM EXCLUDED.source;
  IF FOUND THEN
    PERFORM app.integration_log(c, 'config_changed', c.status, c.status,
      CASE WHEN v_folder THEN format('%s records are read from the newest file matching %s', initcap(v_label), p_source ->> 'file')
           ELSE format('%s records are read from %s.%s', initcap(v_label), p_source ->> 'schema', p_source ->> 'object') END);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION app.request_connection_job(p_connection uuid, p_kind text, p_request jsonb DEFAULT '{}'::jsonb, p_idempotency_key text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.integration_connections%ROWTYPE; a public.integration_agents%ROWTYPE; r jsonb := coalesce(p_request, '{}'::jsonb); v_req jsonb; v_id uuid; v_level text; k text; v_folder boolean;
BEGIN
  c := app.integration_connection_for_write(p_connection, 'integrations.manage');
  IF c.agent_id IS NULL THEN RAISE EXCEPTION 'Only a connection through a connector agent is read by one' USING ERRCODE = 'QM022'; END IF;
  v_folder := c.config ->> 'engine' = 'folder';
  IF c.status = 'retired' THEN RAISE EXCEPTION 'A retired connection cannot be used' USING ERRCODE = 'QM022'; END IF;
  SELECT * INTO a FROM public.integration_agents WHERE id = c.agent_id;
  IF a.status <> 'active' THEN RAISE EXCEPTION 'The connector agent has been revoked' USING ERRCODE = 'QM022'; END IF;
  IF jsonb_typeof(r) <> 'object' THEN RAISE EXCEPTION 'The request is not in the expected form' USING ERRCODE = 'QM022'; END IF;
  FOR k IN SELECT jsonb_object_keys(r) LOOP
    IF k NOT IN ('level', 'schema', 'object', 'limit', 'file') THEN RAISE EXCEPTION 'Unknown request setting "%"', k USING ERRCODE = 'QM022'; END IF;
  END LOOP;
  IF r ? 'schema' AND (jsonb_typeof(r -> 'schema') <> 'string' OR length(r ->> 'schema') NOT BETWEEN 1 AND 128) THEN RAISE EXCEPTION 'The schema name is 1 to 128 characters' USING ERRCODE = 'QM022'; END IF;
  IF r ? 'object' AND (jsonb_typeof(r -> 'object') <> 'string' OR length(r ->> 'object') NOT BETWEEN 1 AND 128) THEN RAISE EXCEPTION 'The table or view name is 1 to 128 characters' USING ERRCODE = 'QM022'; END IF;
  IF r ? 'file' AND app.integration_file_name_problem(r -> 'file') IS NOT NULL THEN
    RAISE EXCEPTION '%', app.integration_file_name_problem(r -> 'file') USING ERRCODE = 'QM022';
  END IF;
  IF v_folder AND (r ? 'schema' OR r ? 'object') THEN RAISE EXCEPTION 'A folder holds files, not schemas or tables' USING ERRCODE = 'QM022'; END IF;
  IF NOT v_folder AND r ? 'file' THEN RAISE EXCEPTION 'A database holds tables, not files' USING ERRCODE = 'QM022'; END IF;
  IF p_kind = 'test_connection' THEN
    v_req := '{}'::jsonb;
  ELSIF v_folder AND p_kind = 'discover' THEN
    IF coalesce(r ->> 'level', 'files') <> 'files' THEN RAISE EXCEPTION 'A folder is browsed for its files' USING ERRCODE = 'QM022'; END IF;
    v_req := jsonb_build_object('level', 'files');
  ELSIF v_folder AND p_kind = 'preview' THEN
    IF NOT r ? 'file' THEN RAISE EXCEPTION 'Choose the file to preview' USING ERRCODE = 'QM022'; END IF;
    IF r ? 'limit' AND (jsonb_typeof(r -> 'limit') <> 'number' OR (r ->> 'limit') !~ '^[0-9]+$' OR (r ->> 'limit')::int NOT BETWEEN 1 AND 50) THEN
      RAISE EXCEPTION 'A preview shows 1 to 50 rows' USING ERRCODE = 'QM022';
    END IF;
    v_req := jsonb_build_object('file', r ->> 'file', 'limit', coalesce((r ->> 'limit')::int, 20));
  ELSIF p_kind = 'discover' THEN
    v_level := coalesce(r ->> 'level', 'schemas');
    IF v_level NOT IN ('schemas', 'objects', 'columns') THEN RAISE EXCEPTION 'Browse schemas, tables and views, or columns' USING ERRCODE = 'QM022'; END IF;
    IF v_level IN ('objects', 'columns') AND NOT r ? 'schema' THEN RAISE EXCEPTION 'Choose the schema' USING ERRCODE = 'QM022'; END IF;
    IF v_level = 'columns' AND NOT r ? 'object' THEN RAISE EXCEPTION 'Choose the table or view' USING ERRCODE = 'QM022'; END IF;
    v_req := jsonb_strip_nulls(jsonb_build_object('level', v_level, 'schema', CASE WHEN v_level <> 'schemas' THEN r ->> 'schema' END,
                                                  'object', CASE WHEN v_level = 'columns' THEN r ->> 'object' END));
  ELSIF p_kind = 'preview' THEN
    IF NOT (r ? 'schema' AND r ? 'object') THEN RAISE EXCEPTION 'Choose the table or view to preview' USING ERRCODE = 'QM022'; END IF;
    IF r ? 'limit' AND (jsonb_typeof(r -> 'limit') <> 'number' OR (r ->> 'limit') !~ '^[0-9]+$' OR (r ->> 'limit')::int NOT BETWEEN 1 AND 50) THEN
      RAISE EXCEPTION 'A preview shows 1 to 50 rows' USING ERRCODE = 'QM022';
    END IF;
    v_req := jsonb_build_object('schema', r ->> 'schema', 'object', r ->> 'object', 'limit', coalesce((r ->> 'limit')::int, 20));
  ELSE
    RAISE EXCEPTION 'A database connection can be tested, browsed or previewed' USING ERRCODE = 'QM022';
  END IF;
  IF p_idempotency_key IS NOT NULL THEN
    IF length(p_idempotency_key) NOT BETWEEN 8 AND 120 THEN RAISE EXCEPTION 'The idempotency key is 8 to 120 characters' USING ERRCODE = 'QM022'; END IF;
    SELECT id INTO v_id FROM public.integration_agent_jobs WHERE organisation_id = c.organisation_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN RETURN v_id; END IF;
  END IF;
  INSERT INTO public.integration_agent_jobs (organisation_id, agent_id, connection_id, kind, spec, max_attempts, idempotency_key, requested_by)
  VALUES (c.organisation_id, a.id, c.id, p_kind,
          jsonb_build_object('connectionId', c.id, 'connection', c.config, 'request', v_req), 1, p_idempotency_key, auth.uid())
  RETURNING id INTO v_id;
  UPDATE public.integration_agents SET fast_poll_until = now() + interval '10 minutes' WHERE id = a.id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION app.integration_queue_extract(p_run uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.integration_sync_runs%ROWTYPE; c public.integration_connections%ROWTYPE; v_source jsonb; v_since text; v_req jsonb; v_id uuid;
BEGIN
  SELECT * INTO r FROM public.integration_sync_runs WHERE id = p_run;
  SELECT * INTO c FROM public.integration_connections WHERE id = r.connection_id;
  SELECT source INTO v_source FROM public.integration_record_sources WHERE connection_id = c.id AND entity_type = r.entity_type;
  IF v_source IS NULL THEN
    RAISE EXCEPTION 'This connection does not say which table or file holds % records: choose it on the connection''s page', replace(r.entity_type, '_', ' ') USING ERRCODE = 'QM022';
  END IF;
  IF r.kind = 'incremental' THEN
    IF NOT (v_source ? 'changedColumn' OR v_source ? 'file') THEN
      RAISE EXCEPTION 'Say which column shows when a row changed to read only what changed, or run a full import' USING ERRCODE = 'QM022';
    END IF;
    BEGIN
      v_since := (r.cursor_start::jsonb) ->> 'w';
    EXCEPTION WHEN others THEN v_since := NULL;
    END;
  END IF;
  IF v_source ? 'file' THEN
    -- A folder (AG5b): the newest file matching the name. Its mark is the file's SHA-256: an incremental run sends the last one, and the agent
    -- uploads nothing when the newest file is that same file. '@file' tells the engine the mark is a file, not a column.
    v_req := jsonb_strip_nulls(jsonb_build_object('file', v_source ->> 'file', 'changedColumn', '@file', 'changedSince', v_since,
                                                  'maxRows', CASE WHEN r.kind = 'preview' THEN 1000 END));
  ELSE
    v_req := v_source || jsonb_strip_nulls(jsonb_build_object('batchRows', 1000, 'maxRows', CASE WHEN r.kind = 'preview' THEN 1000 END, 'changedSince', v_since));
  END IF;
  INSERT INTO public.integration_agent_jobs (organisation_id, agent_id, connection_id, run_id, kind, spec, max_attempts, requested_by)
  VALUES (c.organisation_id, c.agent_id, c.id, r.id, 'extract',
          jsonb_build_object('connectionId', c.id, 'runId', r.id, 'entityType', r.entity_type, 'connection', c.config, 'request', v_req), 3, r.requested_by)
  RETURNING id INTO v_id;
  UPDATE public.integration_agents SET fast_poll_until = greatest(coalesce(fast_poll_until, now()), now() + interval '10 minutes') WHERE id = c.agent_id;
  RETURN v_id;
END $$;

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
      RAISE EXCEPTION 'This connection does not say which table or file holds % records: choose it on the connection''s page', replace(p_entity, '_', ' ') USING ERRCODE = 'QM022';
    END IF;
    IF p_kind = 'incremental' AND NOT (v_source ? 'changedColumn' OR v_source ? 'file') THEN
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

CREATE OR REPLACE FUNCTION app.system_schedule_integration_runs(p_today date DEFAULT current_date, p_daily boolean DEFAULT true) RETURNS jsonb
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
    ELSIF s.provider_key = 'sql_agent' AND v_source IS NULL THEN v_problem := 'The connection no longer says which table or file holds these records';
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
        WHEN s.provider_key = 'sql_agent' AND NOT (v_source ? 'changedColumn' OR v_source ? 'file') THEN 'full'
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
-- A file the agent uploads: in parts, read by the API, gone when the job ends
-- ---------------------------------------------------------------------------
CREATE TABLE public.integration_agent_file_parts (
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  job_id uuid NOT NULL,
  seq integer NOT NULL CHECK (seq BETWEEN 0 AND 63),
  checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 1048576),
  data bytea NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (job_id, seq),
  FOREIGN KEY (job_id, organisation_id) REFERENCES public.integration_agent_jobs (id, organisation_id) ON DELETE CASCADE
);
ALTER TABLE public.integration_agent_file_parts ENABLE ROW LEVEL SECURITY;
-- A customer's file: read by the API through its own functions only, never directly by anyone.
REVOKE ALL ON public.integration_agent_file_parts FROM anon, authenticated;
GRANT SELECT ON public.integration_agent_file_parts TO authenticated;
CREATE POLICY integration_agent_file_parts_select ON public.integration_agent_file_parts FOR SELECT TO authenticated USING (false);

-- The bytes go as soon as their job ends, whatever the outcome.
CREATE FUNCTION app.integration_agent_job_clears_file() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.status IN ('completed', 'failed', 'cancelled') AND OLD.status NOT IN ('completed', 'failed', 'cancelled') THEN
    DELETE FROM public.integration_agent_file_parts WHERE job_id = NEW.id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER integration_agent_jobs_clear_file AFTER UPDATE OF status ON public.integration_agent_jobs
  FOR EACH ROW EXECUTE FUNCTION app.integration_agent_job_clears_file();

-- One part of a file, from the agent (API login only): its own running preview or extraction of a folder, in order, at most 25 MB in all.
CREATE FUNCTION app.system_agent_store_file_part(p_agent uuid, p_job uuid, p_seq integer, p_checksum text, p_data bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE j public.integration_agent_jobs%ROWTYPE; prev public.integration_agent_file_parts%ROWTYPE; v_count integer; v_bytes bigint;
BEGIN
  SELECT * INTO j FROM public.integration_agent_jobs WHERE id = p_job AND agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002'; END IF;
  IF j.kind NOT IN ('preview', 'extract') OR coalesce(j.spec -> 'connection' ->> 'engine', '') <> 'folder' THEN
    RAISE EXCEPTION 'Only a preview or an import from a folder takes a file' USING ERRCODE = 'QM022';
  END IF;
  IF j.status IN ('completed', 'failed', 'cancelled') THEN
    RETURN jsonb_build_object('status', j.status, 'cancelled', j.status = 'cancelled', 'stored', false);
  END IF;
  IF j.status = 'pending' THEN RAISE EXCEPTION 'Take the job again before sending its file' USING ERRCODE = 'QM022'; END IF;
  IF p_checksum IS NULL OR p_checksum !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'A part needs its checksum' USING ERRCODE = 'QM022'; END IF;
  IF p_data IS NULL OR length(p_data) NOT BETWEEN 1 AND 1048576 THEN RAISE EXCEPTION 'A part holds 1 byte to 1 MB' USING ERRCODE = 'QM022'; END IF;
  IF encode(sha256(p_data), 'hex') <> p_checksum THEN RAISE EXCEPTION 'The part does not match its checksum: send it again' USING ERRCODE = 'QM022'; END IF;
  SELECT * INTO prev FROM public.integration_agent_file_parts WHERE job_id = j.id AND seq = p_seq;
  IF FOUND THEN
    IF prev.checksum <> p_checksum THEN RAISE EXCEPTION 'Part % was already received with different bytes', p_seq USING ERRCODE = 'QM022'; END IF;
    RETURN jsonb_build_object('status', j.status, 'cancelled', false, 'stored', false, 'duplicate', true);
  END IF;
  SELECT count(*), coalesce(sum(size_bytes), 0) INTO v_count, v_bytes FROM public.integration_agent_file_parts WHERE job_id = j.id;
  IF p_seq IS DISTINCT FROM v_count THEN RAISE EXCEPTION 'Part % was expected next, not part %', v_count, p_seq USING ERRCODE = 'QM022'; END IF;
  IF v_bytes + length(p_data) > 26214400 THEN RAISE EXCEPTION 'A file can be up to 25 MB' USING ERRCODE = 'QM022'; END IF;
  INSERT INTO public.integration_agent_file_parts (organisation_id, job_id, seq, checksum, size_bytes, data)
  VALUES (j.organisation_id, j.id, p_seq, p_checksum, length(p_data), p_data);
  UPDATE public.integration_agent_jobs
     SET status = 'running', started_at = coalesce(started_at, clock_timestamp()), updated_at = clock_timestamp(),
         progress = jsonb_build_object('parts', v_count + 1, 'bytes', v_bytes + length(p_data)),
         leased_until = greatest(leased_until, now() + interval '5 minutes')
   WHERE id = j.id;
  RETURN jsonb_build_object('status', 'running', 'cancelled', false, 'stored', true, 'parts', v_count + 1, 'bytes', v_bytes + length(p_data));
END $$;

-- The job (its kind and what it asked) and the parts received, for the API to read the file when the agent says it is complete.
CREATE FUNCTION app.system_agent_file_job(p_agent uuid, p_job uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object('id', j.id, 'kind', j.kind, 'status', j.status, 'spec', j.spec,
           'folder', coalesce(j.spec -> 'connection' ->> 'engine', '') = 'folder',
           'parts', (SELECT count(*) FROM public.integration_agent_file_parts p WHERE p.job_id = j.id),
           'bytes', (SELECT coalesce(sum(size_bytes), 0) FROM public.integration_agent_file_parts p WHERE p.job_id = j.id))
    FROM public.integration_agent_jobs j WHERE j.id = p_job AND j.agent_id = p_agent
$$;

CREATE FUNCTION app.system_agent_file_parts(p_agent uuid, p_job uuid) RETURNS TABLE (seq integer, data bytea)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p.seq, p.data FROM public.integration_agent_file_parts p
    JOIN public.integration_agent_jobs j ON j.id = p.job_id AND j.agent_id = p_agent
   WHERE p.job_id = p_job ORDER BY p.seq
$$;

UPDATE public.integration_providers
   SET name = 'Database or folder through a connector agent',
       description = 'SQL Server, PostgreSQL, MySQL or a folder of CSV / Excel files inside your network, read through a connector agent you install there. Nothing connects in; passwords stay on the agent.',
       auth_types = ARRAY['windows', 'sql', 'password', 'none']
 WHERE key = 'sql_agent';

REVOKE ALL ON FUNCTION app.integration_folder_config_problem(jsonb), app.integration_file_name_problem(jsonb), app.integration_file_source_problem(jsonb),
  app.integration_agent_job_clears_file(), app.system_agent_store_file_part(uuid, uuid, integer, text, bytea), app.system_agent_file_job(uuid, uuid),
  app.system_agent_file_parts(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.system_agent_store_file_part(uuid, uuid, integer, text, bytea), app.system_agent_file_job(uuid, uuid),
  app.system_agent_file_parts(uuid, uuid) TO qms_api;
