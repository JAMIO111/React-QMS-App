-- OAuth 2.0 client credentials for REST connections (docs/email-oauth-plan.md, slice OA1, decision O1).
--
-- * The REST provider now offers the `oauth_client` credential (the credential table already allowed the kind).
-- * `app.integration_config_problem`: sign-in type `oauth_client` needs `oauthTokenUrl` (same rules as the API's address: https, port 443, a public host
--   name), optional `oauthScope`, `oauthAudience` and `oauthClientAuth` (`body` | `basic`).
-- * `app.integration_activation_problems`: the token address's host must also be allowed by the organisation's allow-list.
-- * `app.set_integration_credential`: an `oauth_client` secret is JSON `{clientId, clientSecret}` (stored in Vault like every credential).
-- The access token itself is never stored: the API keeps it in memory until shortly before it expires.

UPDATE public.integration_providers
   SET auth_types = ARRAY['api_key', 'bearer', 'basic', 'oauth_client'],
       description = 'Read records from a REST API over https, with an API key, bearer token, basic sign-in or OAuth client credentials. Read-only.'
 WHERE key = 'rest_api';

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
      IF k NOT IN ('baseUrl', 'authType', 'apiKeyHeader', 'timeoutSeconds', 'testPath', 'entities', 'oauthTokenUrl', 'oauthScope', 'oauthAudience', 'oauthClientAuth') THEN RETURN format('Unknown setting "%s" for a REST connection', k); END IF;
    END LOOP;
    v_problem := app.integration_url_problem(p_config ->> 'baseUrl');
    IF v_problem IS NOT NULL THEN RETURN v_problem; END IF;
    IF coalesce(p_config ->> 'authType', 'none') NOT IN ('none', 'api_key', 'bearer', 'basic', 'oauth_client') THEN RETURN 'The sign-in type is none, api_key, bearer, basic or oauth_client'; END IF;
    -- OAuth 2.0 client credentials: the token address follows the same rules as the API's address (https, 443, a public host name).
    IF p_config ->> 'authType' = 'oauth_client' AND coalesce(p_config ->> 'oauthTokenUrl', '') = '' THEN RETURN 'Give the address the access token is asked for'; END IF;
    IF p_config ? 'oauthTokenUrl' THEN
      IF jsonb_typeof(p_config -> 'oauthTokenUrl') <> 'string' THEN RETURN 'The token address is text'; END IF;
      v_problem := app.integration_url_problem(p_config ->> 'oauthTokenUrl');
      IF v_problem IS NOT NULL THEN RETURN 'Token address: ' || v_problem; END IF;
    END IF;
    IF p_config ? 'oauthScope' AND (jsonb_typeof(p_config -> 'oauthScope') <> 'string' OR length(p_config ->> 'oauthScope') > 500 OR (p_config ->> 'oauthScope') !~ '^[!-~]+( [!-~]+)*$') THEN
      RETURN 'The scope is words separated by single spaces (up to 500 characters)';
    END IF;
    IF p_config ? 'oauthAudience' AND (jsonb_typeof(p_config -> 'oauthAudience') <> 'string' OR length(p_config ->> 'oauthAudience') > 300 OR (p_config ->> 'oauthAudience') !~ '^[!-~]+$') THEN
      RETURN 'The audience is one word with no spaces (up to 300 characters)';
    END IF;
    IF p_config ? 'oauthClientAuth' AND coalesce(p_config ->> 'oauthClientAuth', '') NOT IN ('body', 'basic') THEN RETURN 'The client is sent in the request body or with basic sign-in'; END IF;
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
  IF p.key = 'rest_api' AND v_cfg IS NULL AND c.config ->> 'authType' = 'oauth_client' AND NOT app.integration_host_allowed(c.organisation_id, c.config ->> 'oauthTokenUrl') THEN
    v_problems := v_problems || format('Your organisation does not allow connections to the token address %s (Settings → Integrations → Allowed hosts)', app.integration_url_host(c.config ->> 'oauthTokenUrl'));
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

CREATE OR REPLACE FUNCTION app.set_integration_credential(p_connection uuid, p_kind text, p_secret text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.integration_connections%ROWTYPE; p public.integration_providers%ROWTYPE; old public.integration_credentials%ROWTYPE; v_secret uuid; v_id uuid; j jsonb;
BEGIN
  c := app.integration_connection_for_write(p_connection, 'integrations.manage');
  IF c.status = 'retired' THEN RAISE EXCEPTION 'A retired connection cannot have a credential' USING ERRCODE = 'QM022'; END IF;
  SELECT * INTO p FROM public.integration_providers WHERE id = c.provider_id;
  IF p_kind IS NULL OR NOT (p_kind = ANY (p.auth_types)) THEN RAISE EXCEPTION '% does not use a % credential', p.name, coalesce(p_kind, 'blank') USING ERRCODE = 'QM022'; END IF;
  IF p_secret IS NULL OR length(p_secret) = 0 OR length(p_secret) > 4000 THEN RAISE EXCEPTION 'Enter the credential (up to 4,000 characters)' USING ERRCODE = 'QM022'; END IF;
  IF p_kind = 'basic' THEN
    BEGIN j := p_secret::jsonb; EXCEPTION WHEN OTHERS THEN j := NULL; END;
    IF jsonb_typeof(j) IS DISTINCT FROM 'object' OR coalesce(j ->> 'username', '') = '' OR coalesce(j ->> 'password', '') = '' THEN RAISE EXCEPTION 'A basic sign-in needs a user name and a password' USING ERRCODE = 'QM022'; END IF;
  END IF;
  IF p_kind = 'oauth_client' THEN
    BEGIN j := p_secret::jsonb; EXCEPTION WHEN OTHERS THEN j := NULL; END;
    IF jsonb_typeof(j) IS DISTINCT FROM 'object' OR jsonb_typeof(j -> 'clientId') IS DISTINCT FROM 'string' OR jsonb_typeof(j -> 'clientSecret') IS DISTINCT FROM 'string'
       OR coalesce(j ->> 'clientId', '') = '' OR coalesce(j ->> 'clientSecret', '') = '' THEN
      RAISE EXCEPTION 'OAuth client credentials need a client id and a client secret' USING ERRCODE = 'QM022';
    END IF;
  END IF;
  v_secret := vault.create_secret(p_secret, 'integration/' || c.id::text || '/' || gen_random_uuid()::text, 'Fortress integration credential');
  SELECT * INTO old FROM public.integration_credentials WHERE connection_id = c.id AND revoked_at IS NULL FOR UPDATE;
  IF FOUND THEN
    UPDATE public.integration_credentials SET revoked_at = now(), revoked_by = auth.uid(), revoke_reason = 'Replaced by a new credential', secret_id = NULL, updated_at = now(), updated_by = auth.uid() WHERE id = old.id;
    DELETE FROM vault.secrets WHERE id = old.secret_id;
  END IF;
  INSERT INTO public.integration_credentials (organisation_id, connection_id, kind, secret_id, rotated_from) VALUES (c.organisation_id, c.id, p_kind, v_secret, old.id) RETURNING id INTO v_id;
  PERFORM app.integration_log(c, CASE WHEN old.id IS NULL THEN 'credential_set' ELSE 'credential_rotated' END, c.status, c.status, p_kind);
  PERFORM app.integration_recheck(c.id, 'The credential changed');
  RETURN v_id;
END $$;
