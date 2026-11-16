-- Connector agent AG5c (docs/connector-agent-plan.md §18): internal REST APIs, read through the agent.
--  * A connection through an agent may name engine 'rest': an API inside the customer's network that Fortress cannot reach (http or https, any
--    port, a host name or an address on the private network — that is the point), how it signs in (none, an API key in a named header, a bearer
--    token or a user name and password) and an optional path to test. The key, token or password is sealed in the browser to the agent's key and
--    kept only on the agent, like a database password.
--  * The agent calls only hosts its own allow-list names (allowlist.json "hosts"; none = no API at all), never follows a redirect, refuses
--    link-local and metadata addresses, and keeps every next-page link on the connection's own address.
--  * A record source of an API is an endpoint: a path below the address, where the list is in the answer, fixed query parameters, how it pages,
--    the field that identifies each record and, for incremental reads, the field that shows when a record changed with the parameter that asks
--    for records changed since a value. The agent reads the pages, flattens each record to dotted text columns exactly as the cloud REST connector
--    does, and sends them as the extraction's batches, so an API import is a database import from there on.
--  * Nothing else changes: runs that wait for the agent, templates, previews, schedules, incremental marks and health.

-- ---------------------------------------------------------------------------
-- An internal API's settings and an endpoint
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.integration_agent_rest_config_problem(p_config jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE k text; v_url text := p_config ->> 'baseUrl'; v_host text; v_auth text := coalesce(p_config ->> 'authType', 'none');
BEGIN
  FOR k IN SELECT jsonb_object_keys(p_config) LOOP
    IF k NOT IN ('engine', 'baseUrl', 'authType', 'apiKeyHeader', 'timeoutSeconds', 'testPath') THEN
      RETURN format('Unknown setting "%s" for an API connection', k);
    END IF;
  END LOOP;
  IF jsonb_typeof(p_config -> 'baseUrl') IS DISTINCT FROM 'string' OR length(v_url) NOT BETWEEN 8 AND 300 THEN
    RETURN 'Give the API''s address as the agent''s machine reaches it, such as http://erp.factory.local:8080/api';
  END IF;
  -- http or https, a host name, an IPv4 address or a bracketed IPv6 address, an optional port and an optional path; no user:password, query or fragment.
  IF v_url !~ '^https?://([A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[[0-9A-Fa-f:.]{2,45}\])(:[0-9]{1,5})?(/[A-Za-z0-9._~!$&''()*+,;=:@%/-]*)?$' THEN
    RETURN 'The address is http:// or https://, a host name or address, an optional :port and an optional path (no user name, ? or #)';
  END IF;
  IF v_url ~ '^https?://[^/]*@' OR v_url ~ '://[^/]+/.*//' OR v_url ~ '/\.{1,2}(/|$)' OR v_url ~* '%2e' THEN
    RETURN 'The address cannot hold a user name, //, . or .. in its path';
  END IF;
  IF (substring(v_url FROM '^https?://[^/]*:([0-9]{1,5})(/|$)')) IS NOT NULL AND (substring(v_url FROM '^https?://[^/]*:([0-9]{1,5})(/|$)'))::int NOT BETWEEN 1 AND 65535 THEN
    RETURN 'The port is a whole number from 1 to 65535';
  END IF;
  v_host := lower(substring(v_url FROM '^https?://(\[[^]]+\]|[^:/]+)'));
  -- Link-local (cloud metadata lives there) and "any address" are never an API.
  IF v_host ~ '^169\.254\.' OR v_host ~ '^\[fe[89ab][0-9a-f]:' OR v_host IN ('0.0.0.0', '[::]', '[::0]') OR v_host LIKE '%.' THEN
    RETURN 'That address cannot be an API (link-local and "any" addresses are refused)';
  END IF;
  IF v_auth NOT IN ('none', 'api_key', 'bearer', 'basic') THEN RETURN 'The API signs in with nothing, an API key, a bearer token or a user name and password'; END IF;
  IF v_auth = 'api_key' THEN
    IF jsonb_typeof(p_config -> 'apiKeyHeader') IS DISTINCT FROM 'string' OR (p_config ->> 'apiKeyHeader') !~ '^[A-Za-z0-9-]{1,60}$' THEN
      RETURN 'Name the header the API key is sent in (letters, digits and hyphens)';
    END IF;
    IF app.integration_header_forbidden(p_config ->> 'apiKeyHeader') OR lower(p_config ->> 'apiKeyHeader') = 'authorization' THEN
      RETURN format('The API key cannot be sent in the %s header', p_config ->> 'apiKeyHeader');
    END IF;
  ELSIF p_config ? 'apiKeyHeader' THEN
    RETURN 'Only an API key sign-in names a header';
  END IF;
  IF p_config ? 'timeoutSeconds' AND (jsonb_typeof(p_config -> 'timeoutSeconds') <> 'number' OR (p_config ->> 'timeoutSeconds') !~ '^[0-9]+$' OR (p_config ->> 'timeoutSeconds')::int NOT BETWEEN 1 AND 120) THEN
    RETURN 'The timeout is a whole number of seconds from 1 to 120';
  END IF;
  IF p_config ? 'testPath' AND (jsonb_typeof(p_config -> 'testPath') <> 'string' OR NOT app.integration_rest_path_ok(p_config ->> 'testPath')) THEN
    RETURN 'The test path starts with / and stays below the address (no ?, #, // or ..)';
  END IF;
  RETURN NULL;
END $$;

-- An endpoint of an internal API: where the records are, how it pages, which field identifies each record and, optionally, how to read only what changed.
CREATE FUNCTION app.integration_rest_source_problem(p jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE k text; v jsonb; pg jsonb; s text;
BEGIN
  FOR k IN SELECT jsonb_object_keys(p) LOOP
    IF k NOT IN ('path', 'recordsPath', 'query', 'paging', 'keyColumn', 'changedColumn', 'changedParam') THEN RETURN format('Unknown setting "%s" for an API endpoint', k); END IF;
  END LOOP;
  IF jsonb_typeof(p -> 'path') IS DISTINCT FROM 'string' OR NOT app.integration_rest_path_ok(p ->> 'path') THEN
    RETURN 'The path starts with / and stays below the address (no ?, #, // or ..)';
  END IF;
  IF p ? 'recordsPath' AND (jsonb_typeof(p -> 'recordsPath') <> 'string' OR NOT app.integration_json_path_ok(p ->> 'recordsPath')) THEN
    RETURN 'Where the list of records is in the answer is keys joined by dots, such as data or value';
  END IF;
  IF p ? 'query' THEN
    IF jsonb_typeof(p -> 'query') <> 'object' THEN RETURN 'The query parameters are a list of names and values'; END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(p -> 'query')) > 20 THEN RETURN 'At most 20 query parameters'; END IF;
    FOR k, v IN SELECT * FROM jsonb_each(p -> 'query') LOOP
      IF NOT app.integration_param_ok(k) OR jsonb_typeof(v) <> 'string' OR length(v #>> '{}') > 200 THEN
        RETURN format('Query parameter "%s": a name of letters and digits and a value of up to 200 characters', left(k, 60));
      END IF;
    END LOOP;
  END IF;
  IF p ? 'paging' THEN
    pg := p -> 'paging';
    IF jsonb_typeof(pg) <> 'object' THEN RETURN 'Say how the API pages its records'; END IF;
    FOR k, v IN SELECT * FROM jsonb_each(pg) LOOP
      IF k NOT IN ('style', 'pageSize', 'pageParam', 'sizeParam', 'firstPage', 'offsetParam', 'limitParam', 'cursorParam', 'nextCursorPath', 'nextLinkPath') THEN
        RETURN format('Unknown paging setting "%s"', k);
      END IF;
      IF k IN ('pageParam', 'sizeParam', 'offsetParam', 'limitParam', 'cursorParam') AND (jsonb_typeof(v) <> 'string' OR NOT app.integration_param_ok(v #>> '{}')) THEN
        RETURN 'A paging parameter name is letters, digits, _ . - [ ]';
      END IF;
    END LOOP;
    s := pg ->> 'style';
    IF s IS NULL OR s NOT IN ('none', 'page', 'offset', 'cursor', 'next_link') THEN RETURN 'Paging is none, page numbers, offset, a cursor or a next link'; END IF;
    IF pg ? 'pageSize' AND (jsonb_typeof(pg -> 'pageSize') <> 'number' OR (pg ->> 'pageSize') !~ '^[0-9]+$' OR (pg ->> 'pageSize')::int NOT BETWEEN 1 AND 1000) THEN
      RETURN 'The page size is a whole number from 1 to 1,000';
    END IF;
    IF pg ? 'firstPage' AND (pg -> 'firstPage') NOT IN ('0'::jsonb, '1'::jsonb) THEN RETURN 'The first page is 0 or 1'; END IF;
    IF pg ? 'nextCursorPath' AND (jsonb_typeof(pg -> 'nextCursorPath') <> 'string' OR NOT app.integration_json_path_ok(pg ->> 'nextCursorPath')) THEN
      RETURN 'Where the answer gives the next cursor is keys joined by dots';
    END IF;
    IF pg ? 'nextLinkPath' AND (jsonb_typeof(pg -> 'nextLinkPath') <> 'string' OR (pg ->> 'nextLinkPath' <> 'header' AND NOT app.integration_json_path_ok(pg ->> 'nextLinkPath'))) THEN
      RETURN 'Where the answer gives the next page''s link is keys joined by dots, or header';
    END IF;
    IF s = 'cursor' AND NOT pg ? 'nextCursorPath' THEN RETURN 'Say where the answer gives the next cursor'; END IF;
    IF s = 'next_link' AND NOT pg ? 'nextLinkPath' THEN RETURN 'Say where the answer gives the next page''s link'; END IF;
  END IF;
  IF jsonb_typeof(p -> 'keyColumn') IS DISTINCT FROM 'string' OR length(p ->> 'keyColumn') NOT BETWEEN 1 AND 200 OR (p ->> 'keyColumn') ~ '[\x00-\x1f]' THEN
    RETURN 'Choose the field that identifies each record';
  END IF;
  IF p ? 'changedColumn' <> p ? 'changedParam' THEN
    RETURN 'To read only what changed, give both the field that shows when a record changed and the parameter that asks for records changed since a value';
  END IF;
  IF p ? 'changedColumn' AND (jsonb_typeof(p -> 'changedColumn') <> 'string' OR length(p ->> 'changedColumn') NOT BETWEEN 1 AND 200 OR (p ->> 'changedColumn') ~ '[\x00-\x1f]') THEN
    RETURN 'Choose the field that shows when a record changed, or leave it out';
  END IF;
  IF p ? 'changedParam' AND (jsonb_typeof(p -> 'changedParam') <> 'string' OR NOT app.integration_param_ok(p ->> 'changedParam')) THEN
    RETURN 'The parameter that asks for changed records is letters, digits, _ . - [ ]';
  END IF;
  -- The paging parameters in use, with the names the agent sends when none is given (as the cloud REST connector).
  IF p ? 'changedParam' AND (p ->> 'changedParam' = ANY (CASE pg ->> 'style'
          WHEN 'page' THEN ARRAY[coalesce(pg ->> 'pageParam', 'page'), coalesce(pg ->> 'sizeParam', 'per_page')]
          WHEN 'offset' THEN ARRAY[coalesce(pg ->> 'offsetParam', 'offset'), coalesce(pg ->> 'limitParam', 'limit')]
          WHEN 'cursor' THEN ARRAY[coalesce(pg ->> 'cursorParam', 'cursor')]
          ELSE ARRAY[]::text[] END)
                             OR (p -> 'query') ? (p ->> 'changedParam')) THEN
    RETURN 'The parameter that asks for changed records is already used for paging or as a fixed parameter';
  END IF;
  RETURN NULL;
END $$;


CREATE OR REPLACE FUNCTION app.integration_agent_needs_password(p_config jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$ SELECT coalesce(p_config ->> 'authType', '') IN ('sql', 'password', 'api_key', 'bearer', 'basic') $$;

CREATE OR REPLACE FUNCTION app.integration_agent_problems(p_connection uuid) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_api boolean; v_secret text; c public.integration_connections%ROWTYPE; a public.integration_agents%ROWTYPE; k public.integration_agent_credentials%ROWTYPE; v text[] := '{}';
BEGIN
  SELECT * INTO c FROM public.integration_connections WHERE id = p_connection;
  SELECT * INTO a FROM public.integration_agents WHERE id = c.agent_id;
  v_api := c.config ->> 'engine' = 'rest';
  v_secret := CASE c.config ->> 'authType' WHEN 'api_key' THEN 'API key' WHEN 'bearer' THEN 'token' ELSE 'password' END;
  IF NOT FOUND THEN RETURN ARRAY['Choose the connector agent that reads this connection']; END IF;
  IF a.status <> 'active' THEN v := v || format('The connector agent %s has been revoked: make a new connection on an agent that is running', a.name); RETURN v; END IF;
  IF app.integration_agent_needs_password(c.config) THEN
    SELECT * INTO k FROM public.integration_agent_credentials WHERE connection_id = c.id;
    IF NOT FOUND OR k.status = 'cleared' THEN v := v || CASE WHEN v_api THEN format('Type the API''s %s (it is sealed in your browser and only the agent can open it)', v_secret)
                                                     ELSE 'Type the database password (it is sealed in your browser and only the agent can open it)' END;
    ELSIF k.status = 'waiting' THEN v := v || format('The %s is on its way to the agent: it is stored the next time the agent checks in', v_secret);
    ELSIF k.status = 'failed' THEN v := v || (format('The agent could not store the %s: ', v_secret) || coalesce(k.message, 'type it again'));
    END IF;
  END IF;
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION app.set_agent_credential(p_connection uuid, p_sealed jsonb, p_key_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.integration_connections%ROWTYPE; a public.integration_agents%ROWTYPE; v_key uuid; v_job uuid; k text;
BEGIN
  c := app.integration_connection_for_write(p_connection, 'integrations.manage');
  IF c.agent_id IS NULL THEN RAISE EXCEPTION 'Only a connection through a connector agent gives it a password or key' USING ERRCODE = 'QM022'; END IF;
  IF c.status = 'retired' THEN RAISE EXCEPTION 'A retired connection cannot have a password' USING ERRCODE = 'QM022'; END IF;
  IF NOT app.integration_agent_needs_password(c.config) THEN RAISE EXCEPTION '%', CASE WHEN c.config ->> 'engine' IN ('rest', 'folder') THEN 'This connection signs in without a password or key' ELSE 'This connection signs in with Windows authentication: no password is needed' END USING ERRCODE = 'QM022'; END IF;
  SELECT * INTO a FROM public.integration_agents WHERE id = c.agent_id;
  IF a.status <> 'active' THEN RAISE EXCEPTION 'The connector agent has been revoked' USING ERRCODE = 'QM022'; END IF;
  SELECT id INTO v_key FROM public.integration_agent_keys WHERE agent_id = a.id AND status = 'active';
  IF v_key IS NULL OR v_key IS DISTINCT FROM p_key_id THEN
    RAISE EXCEPTION 'The agent''s key has changed since this page was opened: reload it and type the password again' USING ERRCODE = 'QM022';
  END IF;
  IF jsonb_typeof(p_sealed) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'The sealed password is not in the expected form' USING ERRCODE = 'QM022'; END IF;
  FOR k IN SELECT jsonb_object_keys(p_sealed) LOOP
    IF k NOT IN ('epk', 'iv', 'ct') THEN RAISE EXCEPTION 'The sealed password is not in the expected form' USING ERRCODE = 'QM022'; END IF;
  END LOOP;
  IF coalesce(p_sealed ->> 'epk', '') !~ '^[A-Za-z0-9+/]+={0,2}$' OR length(p_sealed ->> 'epk') NOT BETWEEN 80 AND 200
     OR coalesce(p_sealed ->> 'iv', '') !~ '^[A-Za-z0-9+/]{16}$'
     OR coalesce(p_sealed ->> 'ct', '') !~ '^[A-Za-z0-9+/]+={0,2}$' OR length(p_sealed ->> 'ct') NOT BETWEEN 24 AND 8000 THEN
    RAISE EXCEPTION 'The sealed password is not in the expected form' USING ERRCODE = 'QM022';
  END IF;
  -- A password still waiting for the agent is replaced: its job is cancelled (and forgets the sealed bytes).
  UPDATE public.integration_agent_jobs SET status = 'cancelled', finished_at = clock_timestamp(), updated_at = clock_timestamp(), leased_until = NULL,
         error_kind = 'cancelled', error_message = 'Replaced by a newer password'
   WHERE connection_id = c.id AND kind = 'store_credential' AND status IN ('pending', 'received', 'running');
  INSERT INTO public.integration_agent_jobs (organisation_id, agent_id, connection_id, kind, spec, max_attempts, requested_by)
  VALUES (c.organisation_id, a.id, c.id, 'store_credential', jsonb_build_object('connectionId', c.id, 'keyId', v_key, 'sealed', p_sealed), 3, auth.uid())
  RETURNING id INTO v_job;
  INSERT INTO public.integration_agent_credentials (connection_id, organisation_id, agent_id, key_id, status, job_id, set_by)
  VALUES (c.id, c.organisation_id, a.id, v_key, 'waiting', v_job, auth.uid())
  ON CONFLICT (connection_id) DO UPDATE SET key_id = EXCLUDED.key_id, status = 'waiting', job_id = EXCLUDED.job_id, message = NULL,
         set_at = now(), set_by = auth.uid(), stored_at = NULL, updated_at = now();
  UPDATE public.integration_agents SET fast_poll_until = now() + interval '10 minutes' WHERE id = a.id;
  PERFORM app.integration_log(c, 'credential_set', c.status, c.status, CASE c.config ->> 'authType' WHEN 'api_key' THEN 'A new API key was sealed for the agent' WHEN 'bearer' THEN 'A new token was sealed for the agent' ELSE 'A new password was sealed for the agent' END);
  PERFORM app.integration_recheck(c.id, 'The password was changed');
  RETURN v_job;
END $$;

CREATE OR REPLACE FUNCTION app.integration_agent_config_problem(p_config jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE k text; v_engine text := p_config ->> 'engine'; v_auth text := p_config ->> 'authType';
BEGIN
  -- A folder of files (AG5b) has its own settings.
  IF p_config ->> 'engine' = 'folder' THEN RETURN app.integration_folder_config_problem(p_config); END IF;
  -- An internal API (AG5c) too.
  IF p_config ->> 'engine' = 'rest' THEN RETURN app.integration_agent_rest_config_problem(p_config); END IF;
  FOR k IN SELECT jsonb_object_keys(p_config) LOOP
    IF k NOT IN ('engine', 'server', 'port', 'instance', 'database', 'authType', 'encrypt', 'trustServerCertificate', 'timeoutSeconds') THEN
      RETURN format('Unknown setting "%s" for a database connection', k);
    END IF;
  END LOOP;
  IF v_engine IS NULL OR v_engine NOT IN ('sqlserver', 'postgres', 'mysql') THEN RETURN 'Choose the database: SQL Server, PostgreSQL or MySQL, a folder of files or an internal API'; END IF;
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
  -- An endpoint of an internal API (AG5c).
  IF p ? 'path' THEN RETURN app.integration_rest_source_problem(p); END IF;
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
DECLARE c public.integration_connections%ROWTYPE; v_problem text; v_label text := replace(coalesce(p_entity, ''), '_', ' '); v_folder boolean; v_api boolean;
BEGIN
  c := app.integration_connection_for_write(p_connection, 'integrations.manage');
  IF c.agent_id IS NULL THEN RAISE EXCEPTION 'Only a connection through a connector agent reads records from tables, files or an internal API' USING ERRCODE = 'QM022'; END IF;
  v_folder := c.config ->> 'engine' = 'folder';
  v_api := c.config ->> 'engine' = 'rest';
  IF c.status = 'retired' THEN RAISE EXCEPTION 'A retired connection cannot be changed' USING ERRCODE = 'QM022'; END IF;
  PERFORM app.integration_assert_entity(p_entity);
  IF p_source IS NULL THEN
    DELETE FROM public.integration_record_sources WHERE connection_id = c.id AND entity_type = p_entity;
    IF FOUND THEN PERFORM app.integration_log(c, 'config_changed', c.status, c.status,
      format('%s records are no longer read from this %s', initcap(v_label), CASE WHEN v_folder THEN 'folder' WHEN v_api THEN 'API' ELSE 'database' END)); END IF;
    RETURN;
  END IF;
  v_problem := app.integration_record_source_problem(p_source);
  IF v_problem IS NOT NULL THEN RAISE EXCEPTION '%', v_problem USING ERRCODE = 'QM022'; END IF;
  IF v_folder AND NOT p_source ? 'file' THEN RAISE EXCEPTION 'A folder connection reads files: say which file holds these records' USING ERRCODE = 'QM022'; END IF;
  IF NOT v_folder AND p_source ? 'file' THEN RAISE EXCEPTION 'Only a folder connection reads files' USING ERRCODE = 'QM022'; END IF;
  IF v_api AND NOT p_source ? 'path' THEN RAISE EXCEPTION 'An API connection reads an address on the API: say which path gives these records' USING ERRCODE = 'QM022'; END IF;
  IF NOT v_api AND p_source ? 'path' THEN RAISE EXCEPTION 'Only an API connection reads an address' USING ERRCODE = 'QM022'; END IF;
  INSERT INTO public.integration_record_sources (organisation_id, connection_id, entity_type, source, updated_by)
  VALUES (c.organisation_id, c.id, p_entity, p_source, auth.uid())
  ON CONFLICT (connection_id, entity_type) DO UPDATE SET source = EXCLUDED.source, updated_by = EXCLUDED.updated_by, updated_at = now()
   WHERE integration_record_sources.source IS DISTINCT FROM EXCLUDED.source;
  IF FOUND THEN
    PERFORM app.integration_log(c, 'config_changed', c.status, c.status,
      CASE WHEN v_folder THEN format('%s records are read from the newest file matching %s', initcap(v_label), p_source ->> 'file')
           WHEN v_api THEN format('%s records are read from %s', initcap(v_label), p_source ->> 'path')
           ELSE format('%s records are read from %s.%s', initcap(v_label), p_source ->> 'schema', p_source ->> 'object') END);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION app.request_connection_job(p_connection uuid, p_kind text, p_request jsonb DEFAULT '{}'::jsonb, p_idempotency_key text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.integration_connections%ROWTYPE; a public.integration_agents%ROWTYPE; r jsonb := coalesce(p_request, '{}'::jsonb); v_req jsonb; v_id uuid; v_level text; k text; v_folder boolean; v_api boolean; v_problem text;
BEGIN
  c := app.integration_connection_for_write(p_connection, 'integrations.manage');
  IF c.agent_id IS NULL THEN RAISE EXCEPTION 'Only a connection through a connector agent is read by one' USING ERRCODE = 'QM022'; END IF;
  v_folder := c.config ->> 'engine' = 'folder';
  v_api := c.config ->> 'engine' = 'rest';
  IF c.status = 'retired' THEN RAISE EXCEPTION 'A retired connection cannot be used' USING ERRCODE = 'QM022'; END IF;
  SELECT * INTO a FROM public.integration_agents WHERE id = c.agent_id;
  IF a.status <> 'active' THEN RAISE EXCEPTION 'The connector agent has been revoked' USING ERRCODE = 'QM022'; END IF;
  IF jsonb_typeof(r) <> 'object' THEN RAISE EXCEPTION 'The request is not in the expected form' USING ERRCODE = 'QM022'; END IF;
  FOR k IN SELECT jsonb_object_keys(r) LOOP
    IF k NOT IN ('level', 'schema', 'object', 'limit', 'file', 'path', 'recordsPath', 'query', 'paging') THEN RAISE EXCEPTION 'Unknown request setting "%"', k USING ERRCODE = 'QM022'; END IF;
  END LOOP;
  IF r ? 'schema' AND (jsonb_typeof(r -> 'schema') <> 'string' OR length(r ->> 'schema') NOT BETWEEN 1 AND 128) THEN RAISE EXCEPTION 'The schema name is 1 to 128 characters' USING ERRCODE = 'QM022'; END IF;
  IF r ? 'object' AND (jsonb_typeof(r -> 'object') <> 'string' OR length(r ->> 'object') NOT BETWEEN 1 AND 128) THEN RAISE EXCEPTION 'The table or view name is 1 to 128 characters' USING ERRCODE = 'QM022'; END IF;
  IF r ? 'file' AND app.integration_file_name_problem(r -> 'file') IS NOT NULL THEN
    RAISE EXCEPTION '%', app.integration_file_name_problem(r -> 'file') USING ERRCODE = 'QM022';
  END IF;
  IF v_folder AND (r ? 'schema' OR r ? 'object') THEN RAISE EXCEPTION 'A folder holds files, not schemas or tables' USING ERRCODE = 'QM022'; END IF;
  IF NOT v_folder AND r ? 'file' THEN RAISE EXCEPTION 'Only a folder holds files' USING ERRCODE = 'QM022'; END IF;
  IF v_api AND (r ? 'schema' OR r ? 'object' OR r ? 'level') THEN RAISE EXCEPTION 'An API is not browsed: try one of its addresses' USING ERRCODE = 'QM022'; END IF;
  IF NOT v_api AND (r ? 'path' OR r ? 'recordsPath' OR r ? 'query' OR r ? 'paging') THEN RAISE EXCEPTION 'Only an API connection reads an address' USING ERRCODE = 'QM022'; END IF;
  IF p_kind = 'test_connection' THEN
    v_req := '{}'::jsonb;
  ELSIF v_api AND p_kind = 'discover' THEN
    RAISE EXCEPTION 'An API is not browsed: try one of its addresses' USING ERRCODE = 'QM022';
  ELSIF v_api AND p_kind = 'preview' THEN
    IF NOT r ? 'path' THEN RAISE EXCEPTION 'Give the path to try' USING ERRCODE = 'QM022'; END IF;
    -- The same rules as an endpoint, without the identifying field (that is chosen from what the answer shows).
    v_problem := app.integration_rest_source_problem((r - 'limit') || jsonb_build_object('keyColumn', 'x'));
    IF v_problem IS NOT NULL THEN RAISE EXCEPTION '%', v_problem USING ERRCODE = 'QM022'; END IF;
    IF r ? 'limit' AND (jsonb_typeof(r -> 'limit') <> 'number' OR (r ->> 'limit') !~ '^[0-9]+$' OR (r ->> 'limit')::int NOT BETWEEN 1 AND 50) THEN
      RAISE EXCEPTION 'A preview shows 1 to 50 records' USING ERRCODE = 'QM022';
    END IF;
    v_req := (r - 'limit') || jsonb_build_object('limit', coalesce((r ->> 'limit')::int, 20));
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
    RAISE EXCEPTION 'A connection through an agent can be tested, browsed or previewed' USING ERRCODE = 'QM022';
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

UPDATE public.integration_providers
   SET name = 'Database, folder or API through a connector agent',
       description = 'SQL Server, PostgreSQL, MySQL, a folder of CSV / Excel files or an internal REST API inside your network, read through a connector agent you install there. Nothing connects in; passwords and keys stay on the agent.',
       auth_types = ARRAY['windows', 'sql', 'password', 'none', 'api_key', 'bearer', 'basic']
 WHERE key = 'sql_agent';

REVOKE ALL ON FUNCTION app.integration_agent_rest_config_problem(jsonb), app.integration_rest_source_problem(jsonb) FROM PUBLIC, anon, authenticated;
