-- IN7: the generic REST connector (docs/connectors-plan.md §6.15, §8).
--
--  * A REST connection's settings say, per kind of record, where the records are (a path below the connection's address, where the list sits in the
--    answer, fixed query parameters), how the API pages (none / page number / offset / a cursor token from the answer / a next link in the answer or the
--    Link header) and, for incremental imports, which parameter carries the highest value of which field seen last time. Plus an optional test path.
--    `app.integration_config_problem` checks all of it (the API's connector checks the same rules before every request): every path stays below the
--    connection's address (no "//", ".." or "." segments, no query or fragment, no encoded dots), the API key header cannot be Host or any header that
--    changes where or how a request is sent.
--  * `organisation_settings.integration_allowed_hosts`: an optional allow-list of host names an organisation's connections may call (an entry allows the
--    host and its sub-domains; empty = any public host). Written only by `app.set_integration_allowed_hosts` (integrations.manage, so a Controller seat).
--    A connection outside it cannot be activated, cannot run, and an active one is paused when the list changes.
--  * A REST run names a kind of record the connection configures, a host the organisation allows and, when incremental, the parameter and field to use.
--    A preview may run without a template (to see what the API sends); without one a real import cannot identify the records (the screens ask for one).
--  * `app.system_integration_allowed_hosts(org)`: the list for the connector (API login only).

-- ---------------------------------------------------------------------------
-- The allow-list
-- ---------------------------------------------------------------------------
ALTER TABLE public.organisation_settings ADD COLUMN integration_allowed_hosts text[] NOT NULL DEFAULT '{}'::text[];
ALTER TABLE public.organisation_settings ADD CONSTRAINT organisation_settings_integration_allowed_hosts_check CHECK (
  cardinality(integration_allowed_hosts) <= 50
  AND array_to_string(integration_allowed_hosts, ' ') ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,24}( |$))*$'
);

CREATE FUNCTION app.integration_url_host(p_url text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT lower(substring(p_url from '^https://([^/:?#]+)'))
$$;

-- Whether the organisation lets its connections call this address's host (an entry allows the host and its sub-domains).
CREATE FUNCTION app.integration_host_allowed(p_org uuid, p_url text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce((
    SELECT cardinality(s.integration_allowed_hosts) = 0
        OR EXISTS (SELECT 1 FROM unnest(s.integration_allowed_hosts) a
                   WHERE app.integration_url_host(p_url) = a OR right(app.integration_url_host(p_url), length(a) + 1) = '.' || a)
    FROM public.organisation_settings s WHERE s.organisation_id = p_org), true)
$$;

CREATE FUNCTION app.set_integration_allowed_hosts(p_org uuid, p_hosts text[]) RETURNS text[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_hosts text[]; h text; c record;
BEGIN
  IF NOT app.is_member(p_org) THEN RAISE EXCEPTION 'Organisation not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(p_org, 'integrations.manage') THEN RAISE EXCEPTION 'You are not allowed to change where integrations may connect' USING ERRCODE = '42501'; END IF;
  SELECT coalesce(array_agg(DISTINCT x ORDER BY x), '{}') INTO v_hosts
  FROM (SELECT lower(btrim(regexp_replace(e, '^\.+', ''))) AS x FROM unnest(coalesce(p_hosts, '{}')) e) t WHERE x <> '';
  IF cardinality(v_hosts) > 50 THEN RAISE EXCEPTION 'List at most 50 host names' USING ERRCODE = 'QM022'; END IF;
  FOREACH h IN ARRAY v_hosts LOOP
    IF h !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$' OR h ~ '\.(local|localhost|internal|lan|home|corp|intranet)$' THEN
      RAISE EXCEPTION '"%" is not a public host name', h USING ERRCODE = 'QM022';
    END IF;
  END LOOP;
  UPDATE public.organisation_settings SET integration_allowed_hosts = v_hosts WHERE organisation_id = p_org;
  -- Connections that call a host no longer allowed go back to draft (ready) or are paused (active).
  FOR c IN SELECT k.id FROM public.integration_connections k JOIN public.integration_providers p ON p.id = k.provider_id
           WHERE k.organisation_id = p_org AND p.kind = 'api' AND k.status IN ('ready', 'active') LOOP
    PERFORM app.integration_recheck(c.id, 'The organisation''s allowed hosts changed');
  END LOOP;
  RETURN v_hosts;
END $$;

-- The list for the connector, read by the API login when it calls out.
CREATE FUNCTION app.system_integration_allowed_hosts(p_org uuid) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce((SELECT integration_allowed_hosts FROM public.organisation_settings WHERE organisation_id = p_org), '{}'::text[])
$$;
REVOKE ALL ON FUNCTION app.system_integration_allowed_hosts(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.system_integration_allowed_hosts(uuid) TO qms_api;

-- ---------------------------------------------------------------------------
-- REST settings
-- ---------------------------------------------------------------------------
-- A path below the connection's address: starts with "/", no "//", no "." or ".." segment, no encoded dot, no query, fragment or backslash.
CREATE FUNCTION app.integration_rest_path_ok(p text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p IS NOT NULL AND length(p) <= 300 AND p ~ '^/[A-Za-z0-9._~!$&''()*+,;=:@%/-]*$' AND p !~ '//' AND p !~* '%2e' AND p !~ '/\.{1,2}(/|$)'
$$;

CREATE FUNCTION app.integration_json_path_ok(p text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p IS NOT NULL AND p ~ '^[A-Za-z0-9_$@-]{1,60}(\.[A-Za-z0-9_$@-]{1,60}){0,9}$'
$$;

CREATE FUNCTION app.integration_param_ok(p text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p IS NOT NULL AND p ~ '^[][A-Za-z0-9_.-]{1,60}$'
$$;

-- Headers a connection may never set (they change where or how a request is sent).
CREATE FUNCTION app.integration_header_forbidden(p text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT lower(p) IN ('host', 'connection', 'content-length', 'transfer-encoding', 'te', 'upgrade', 'keep-alive', 'expect', 'cookie', 'proxy-authorization',
                      'proxy-connection', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip') OR lower(p) LIKE 'proxy-%'
$$;

CREATE FUNCTION app.integration_rest_entity_problem(p_entity text, e jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE k text; v jsonb; pg jsonb; inc jsonb; s text; what text := replace(p_entity, '_', ' ') || ' records';
BEGIN
  IF NOT (p_entity = ANY (app.integration_entity_types())) THEN RETURN format('"%s" is not a kind of record Fortress imports', p_entity); END IF;
  IF jsonb_typeof(e) IS DISTINCT FROM 'object' THEN RETURN format('Say where to read %s', what); END IF;
  FOR k IN SELECT jsonb_object_keys(e) LOOP
    IF k NOT IN ('path', 'recordsPath', 'query', 'paging', 'incremental') THEN RETURN format('Unknown setting "%s" for %s', k, what); END IF;
  END LOOP;
  IF jsonb_typeof(e -> 'path') IS DISTINCT FROM 'string' OR NOT app.integration_rest_path_ok(e ->> 'path') THEN
    RETURN format('The path for %s starts with / and stays below the address (no ?, #, // or ..)', what);
  END IF;
  IF e ? 'recordsPath' AND (jsonb_typeof(e -> 'recordsPath') <> 'string' OR NOT app.integration_json_path_ok(e ->> 'recordsPath')) THEN
    RETURN format('Where the list of %s is in the answer is keys joined by dots, such as data', what);
  END IF;
  IF e ? 'query' THEN
    IF jsonb_typeof(e -> 'query') <> 'object' THEN RETURN format('The query parameters for %s are a list of names and values', what); END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(e -> 'query')) > 20 THEN RETURN format('At most 20 query parameters for %s', what); END IF;
    FOR k, v IN SELECT * FROM jsonb_each(e -> 'query') LOOP
      IF NOT app.integration_param_ok(k) OR jsonb_typeof(v) <> 'string' OR length(v #>> '{}') > 200 THEN RETURN format('Query parameter "%s" for %s: a name of letters and digits and a value of up to 200 characters', left(k, 60), what); END IF;
    END LOOP;
  END IF;
  IF e ? 'paging' THEN
    pg := e -> 'paging';
    IF jsonb_typeof(pg) <> 'object' THEN RETURN format('Say how the API pages %s', what); END IF;
    FOR k, v IN SELECT * FROM jsonb_each(pg) LOOP
      IF k NOT IN ('style', 'pageSize', 'pageParam', 'sizeParam', 'firstPage', 'offsetParam', 'limitParam', 'cursorParam', 'nextCursorPath', 'nextLinkPath') THEN
        RETURN format('Unknown paging setting "%s" for %s', k, what);
      END IF;
      IF k IN ('pageParam', 'sizeParam', 'offsetParam', 'limitParam', 'cursorParam') AND (jsonb_typeof(v) <> 'string' OR NOT app.integration_param_ok(v #>> '{}')) THEN
        RETURN format('Paging of %s: a parameter name is letters, digits, _ . - [ ]', what);
      END IF;
    END LOOP;
    s := pg ->> 'style';
    IF s IS NULL OR s NOT IN ('none', 'page', 'offset', 'cursor', 'next_link') THEN RETURN format('Paging of %s is none, page, offset, cursor or next_link', what); END IF;
    IF pg ? 'pageSize' AND (jsonb_typeof(pg -> 'pageSize') <> 'number' OR (pg ->> 'pageSize') !~ '^[0-9]+$' OR (pg ->> 'pageSize')::int NOT BETWEEN 1 AND 1000) THEN
      RETURN format('The page size for %s is a whole number from 1 to 1,000', what);
    END IF;
    IF pg ? 'firstPage' AND (pg -> 'firstPage') NOT IN ('0'::jsonb, '1'::jsonb) THEN RETURN format('The first page of %s is 0 or 1', what); END IF;
    IF pg ? 'nextCursorPath' AND (jsonb_typeof(pg -> 'nextCursorPath') <> 'string' OR NOT app.integration_json_path_ok(pg ->> 'nextCursorPath')) THEN
      RETURN format('Where the answer gives the next cursor for %s is keys joined by dots', what);
    END IF;
    IF pg ? 'nextLinkPath' AND (jsonb_typeof(pg -> 'nextLinkPath') <> 'string' OR (pg ->> 'nextLinkPath' <> 'header' AND NOT app.integration_json_path_ok(pg ->> 'nextLinkPath'))) THEN
      RETURN format('Where the answer gives the next page''s link for %s is keys joined by dots, or header', what);
    END IF;
    IF s = 'cursor' AND NOT pg ? 'nextCursorPath' THEN RETURN format('Say where the answer gives the next cursor for %s', what); END IF;
    IF s = 'next_link' AND NOT pg ? 'nextLinkPath' THEN RETURN format('Say where the answer gives the next page''s link for %s', what); END IF;
  END IF;
  IF e ? 'incremental' THEN
    inc := e -> 'incremental';
    IF jsonb_typeof(inc) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(inc) x WHERE x NOT IN ('param', 'field'))
       OR jsonb_typeof(inc -> 'param') IS DISTINCT FROM 'string' OR NOT app.integration_param_ok(inc ->> 'param')
       OR jsonb_typeof(inc -> 'field') IS DISTINCT FROM 'string' OR length(inc ->> 'field') NOT BETWEEN 1 AND 200 THEN
      RETURN format('An incremental import of %s needs the parameter to send and the field whose highest value is sent', what);
    END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION app.integration_config_problem(p_provider text, p_config jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE k text; v jsonb; v_problem text;
BEGIN
  IF jsonb_typeof(p_config) IS DISTINCT FROM 'object' THEN RETURN 'The configuration must be an object'; END IF;
  IF pg_column_size(p_config) > 8192 THEN RETURN 'The configuration is too large'; END IF;
  IF p_provider = 'csv' THEN
    FOR k IN SELECT jsonb_object_keys(p_config) LOOP
      IF k NOT IN ('delimiter', 'encoding', 'hasHeader') THEN RETURN format('Unknown setting "%s" for a file importer', k); END IF;
    END LOOP;
    IF p_config ? 'delimiter' AND coalesce(p_config ->> 'delimiter', '') NOT IN (',', ';', 'tab', '|') THEN RETURN 'The delimiter is a comma, semicolon, tab or bar'; END IF;
    IF p_config ? 'encoding' AND coalesce(p_config ->> 'encoding', '') NOT IN ('utf-8', 'windows-1252') THEN RETURN 'The encoding is utf-8 or windows-1252'; END IF;
    IF p_config ? 'hasHeader' AND jsonb_typeof(p_config -> 'hasHeader') <> 'boolean' THEN RETURN 'Say whether the file has a header row'; END IF;
  ELSIF p_provider = 'rest_api' THEN
    FOR k IN SELECT jsonb_object_keys(p_config) LOOP
      IF k NOT IN ('baseUrl', 'authType', 'apiKeyHeader', 'timeoutSeconds', 'testPath', 'entities') THEN RETURN format('Unknown setting "%s" for a REST connection', k); END IF;
    END LOOP;
    v_problem := app.integration_url_problem(p_config ->> 'baseUrl');
    IF v_problem IS NOT NULL THEN RETURN v_problem; END IF;
    IF coalesce(p_config ->> 'authType', 'none') NOT IN ('none', 'api_key', 'bearer', 'basic') THEN RETURN 'The sign-in type is none, api_key, bearer or basic'; END IF;
    IF p_config ->> 'authType' = 'api_key' AND coalesce(p_config ->> 'apiKeyHeader', '') !~ '^[A-Za-z0-9-]{1,60}$' THEN RETURN 'Name the header the API key is sent in (letters, digits and hyphens)'; END IF;
    IF p_config ? 'apiKeyHeader' AND app.integration_header_forbidden(p_config ->> 'apiKeyHeader') THEN RETURN format('The %s header cannot be set by a connection', p_config ->> 'apiKeyHeader'); END IF;
    IF p_config ? 'timeoutSeconds' AND (jsonb_typeof(p_config -> 'timeoutSeconds') <> 'number' OR (p_config ->> 'timeoutSeconds') !~ '^[0-9]+$' OR (p_config ->> 'timeoutSeconds')::int NOT BETWEEN 1 AND 60) THEN RETURN 'The timeout is a whole number of seconds from 1 to 60'; END IF;
    IF p_config ? 'testPath' AND (jsonb_typeof(p_config -> 'testPath') <> 'string' OR NOT app.integration_rest_path_ok(p_config ->> 'testPath')) THEN
      RETURN 'The test path starts with / and stays below the address (no ?, #, // or ..)';
    END IF;
    IF p_config ? 'entities' THEN
      IF jsonb_typeof(p_config -> 'entities') <> 'object' THEN RETURN 'Say, for each kind of record, where the API gives it'; END IF;
      FOR k, v IN SELECT * FROM jsonb_each(p_config -> 'entities') LOOP
        v_problem := app.integration_rest_entity_problem(k, v);
        IF v_problem IS NOT NULL THEN RETURN v_problem; END IF;
      END LOOP;
    END IF;
  ELSE
    RETURN 'That provider cannot be configured yet';
  END IF;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Activation and runs respect the allow-list
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.integration_activation_problems(p_connection uuid) RETURNS text[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.integration_connections%ROWTYPE; p public.integration_providers%ROWTYPE; v_problems text[] := '{}'; v_cfg text; v_kind text; v_live text;
BEGIN
  SELECT * INTO c FROM public.integration_connections WHERE id = p_connection;
  IF NOT FOUND OR NOT app.is_member(c.organisation_id) THEN RAISE EXCEPTION 'Connection not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO p FROM public.integration_providers WHERE id = c.provider_id;
  IF p.status <> 'available' THEN v_problems := array_append(v_problems, 'That provider is not available yet'::text); END IF;
  v_cfg := app.integration_config_problem(p.key, c.config);
  IF v_cfg IS NOT NULL THEN v_problems := v_problems || v_cfg; END IF;
  IF p.key = 'rest_api' AND v_cfg IS NULL AND NOT app.integration_host_allowed(c.organisation_id, c.config ->> 'baseUrl') THEN
    v_problems := v_problems || format('Your organisation does not allow connections to %s (Settings → Integrations → Allowed hosts)', app.integration_url_host(c.config ->> 'baseUrl'));
  END IF;
  -- credentials, when the provider or the chosen sign-in type needs them
  v_kind := CASE p.key WHEN 'rest_api' THEN nullif(coalesce(c.config ->> 'authType', 'none'), 'none') ELSE NULL END;
  IF v_kind IS NOT NULL THEN
    SELECT kind INTO v_live FROM public.integration_credentials WHERE connection_id = c.id AND revoked_at IS NULL;
    IF v_live IS NULL THEN v_problems := array_append(v_problems, 'Store the credential for this connection'::text); ELSIF v_live <> v_kind THEN v_problems := v_problems || format('The stored credential is %s but the connection signs in with %s', v_live, v_kind); END IF;
  END IF;
  -- a passed connection test, for providers that can be tested, made after the last change
  IF coalesce((p.capabilities ->> 'testable')::boolean, false) THEN
    IF c.last_tested_at IS NULL THEN v_problems := array_append(v_problems, 'Test the connection'::text);
    ELSIF NOT c.last_test_ok THEN v_problems := array_append(v_problems, 'The last connection test failed'::text);
    ELSIF c.last_tested_at < c.config_changed_at THEN v_problems := array_append(v_problems, 'The connection was changed after the last test: test it again'::text);
    END IF;
  END IF;
  RETURN v_problems;
END $$;

CREATE OR REPLACE FUNCTION app.request_integration_run(p_connection uuid, p_entity text, p_kind text, p_file uuid DEFAULT NULL, p_template uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.integration_connections%ROWTYPE; v_provider text; v_cursor text; v_id uuid; v_mapping uuid; f public.integration_files%ROWTYPE;
        t public.integration_templates%ROWTYPE; tv public.integration_template_versions%ROWTYPE; v_settings jsonb;
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
  PERFORM app.integration_assert_idle(c.id, p_entity);
  IF p_kind = 'incremental' THEN
    SELECT cursor INTO v_cursor FROM public.integration_sync_cursors WHERE connection_id = c.id AND entity_type = p_entity;
  END IF;
  INSERT INTO public.integration_sync_runs (organisation_id, connection_id, entity_type, kind, requested_by, cursor_start, cursor_next, file_id, mapping_id, template_version_id, settings)
  VALUES (c.organisation_id, c.id, p_entity, p_kind, auth.uid(), v_cursor, v_cursor, p_file, v_mapping, tv.id, v_settings)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app.integration_url_host(text), app.integration_host_allowed(uuid, text), app.integration_rest_path_ok(text), app.integration_json_path_ok(text),
  app.integration_param_ok(text), app.integration_header_forbidden(text), app.integration_rest_entity_problem(text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.set_integration_allowed_hosts(uuid, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.set_integration_allowed_hosts(uuid, text[]) TO authenticated;
