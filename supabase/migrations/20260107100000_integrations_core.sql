-- Integrations, slice IN1 (docs/connectors-plan.md): providers, connections, credentials, lifecycle.
--  * integration_providers: global catalogue (csv, rest_api; the SQL agent is listed as planned). Read-only for tenants.
--  * integration_connections: one per customer source (provider, name, a short external-system code that is fixed once created, non-secret config, status
--    draft -> ready -> active <-> paused -> retired). **Activation needs a different person from the one who marked it ready, with integrations.approve.**
--  * integration_credentials: **secrets live in Supabase Vault; the table holds only the Vault id.** Set / rotate / revoke are functions; the value is never returned
--    to a tenant. app.integration_credential_secret (the only reader) is executable by the API login only.
--  * integration_connection_events: append-only history (who, what, when, why).
--  * Permissions integrations.read / .manage / .run / .approve; module `integrations` (no subscription feature mapped yet: packaging is a commercial decision, plan D7).
--  No table writes at all: SECURITY DEFINER functions only. Errors QM022 -> 409 integration_rule; cross-tenant ids P0002 -> 404.

INSERT INTO public.permissions (code, description) VALUES
  ('integrations.read',    'See integration connections, their health and history (never their secrets)'),
  ('integrations.manage',  'Create and change integration connections, store and revoke their credentials, run connection tests'),
  ('integrations.run',     'Run, retry and preview integration imports'),
  ('integrations.approve', 'Approve the activation of an integration connection (a different person from the one who prepared it)');

WITH grants(key, perms) AS (VALUES
  ('owner',            ARRAY['integrations.read', 'integrations.manage', 'integrations.run', 'integrations.approve']),
  ('admin',            ARRAY['integrations.read', 'integrations.manage', 'integrations.run', 'integrations.approve']),
  ('quality_manager',  ARRAY['integrations.read', 'integrations.manage', 'integrations.run', 'integrations.approve']),
  ('quality_engineer', ARRAY['integrations.read'])
)
INSERT INTO public.role_permissions (role_id, permission_code)
SELECT r.id, unnest(g.perms) FROM public.roles r JOIN grants g ON g.key = r.key WHERE r.is_system
ON CONFLICT DO NOTHING;

INSERT INTO public.modules (slug, name, status, navigation_group, display_order) VALUES ('integrations', 'Integrations', 'active', 'Insight', 11)
ON CONFLICT (slug) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Providers (global)
-- ---------------------------------------------------------------------------
CREATE TABLE public.integration_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  name text NOT NULL,
  description text,
  kind text NOT NULL CHECK (kind IN ('file', 'api', 'agent')),
  auth_types text[] NOT NULL DEFAULT '{}',
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'planned', 'retired')),
  display_order integer NOT NULL DEFAULT 0
);
ALTER TABLE public.integration_providers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.integration_providers FROM anon, authenticated;
GRANT SELECT ON public.integration_providers TO authenticated;
CREATE POLICY integration_providers_select ON public.integration_providers FOR SELECT TO authenticated USING (true);

INSERT INTO public.integration_providers (key, name, description, kind, auth_types, capabilities, status, display_order) VALUES
  ('csv', 'CSV / Excel file', 'Import a file you upload: CSV now, Excel with the file importer. Nothing is fetched from your systems.', 'file', '{}',
   '{"testable": false, "incremental": false, "webhooks": false, "writeBack": false}'::jsonb, 'available', 1),
  ('rest_api', 'REST API', 'Read records from a REST API over https, with an API key, bearer token or basic sign-in. Read-only.', 'api', ARRAY['api_key', 'bearer', 'basic'],
   '{"testable": true, "incremental": true, "webhooks": false, "writeBack": false}'::jsonb, 'available', 2),
  ('sql_agent', 'Local SQL agent', 'A service you install in your network that reads approved sources and connects outwards to Fortress. Planned.', 'agent', '{}',
   '{"testable": true, "incremental": true, "webhooks": false, "writeBack": false}'::jsonb, 'planned', 3);

-- ---------------------------------------------------------------------------
-- Connections
-- ---------------------------------------------------------------------------
CREATE TABLE public.integration_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  provider_id uuid NOT NULL REFERENCES public.integration_providers (id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 80),
  external_system text NOT NULL CHECK (external_system ~ '^[a-z][a-z0-9_-]{1,39}$'),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready', 'active', 'paused', 'retired')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object' AND pg_column_size(config) <= 8192),
  config_changed_at timestamptz NOT NULL DEFAULT now(),
  last_tested_at timestamptz,
  last_test_ok boolean,
  last_test_message text CHECK (last_test_message IS NULL OR length(last_test_message) <= 500),
  ready_at timestamptz,
  ready_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  activated_at timestamptz,
  activated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT integration_connections_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT integration_connections_tested CHECK ((last_tested_at IS NULL) = (last_test_ok IS NULL))
);
CREATE UNIQUE INDEX integration_connections_name_key ON public.integration_connections (organisation_id, lower(btrim(name)));
CREATE UNIQUE INDEX integration_connections_system_key ON public.integration_connections (organisation_id, external_system);

-- Even SQL cannot make an impossible status move.
CREATE FUNCTION app.integration_status_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF NOT ((OLD.status = 'draft' AND NEW.status IN ('ready', 'retired'))
       OR (OLD.status = 'ready' AND NEW.status IN ('draft', 'active', 'retired'))
       OR (OLD.status = 'active' AND NEW.status IN ('paused', 'retired'))
       OR (OLD.status = 'paused' AND NEW.status IN ('active', 'draft', 'retired'))) THEN
    RAISE EXCEPTION 'A connection cannot move from % to %', OLD.status, NEW.status USING ERRCODE = 'QM022';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER integration_connections_status_guard BEFORE UPDATE OF status ON public.integration_connections FOR EACH ROW EXECUTE FUNCTION app.integration_status_guard();
CREATE TRIGGER integration_connections_stamp BEFORE INSERT ON public.integration_connections FOR EACH ROW EXECUTE FUNCTION app.stamp_created();

-- The history of a connection: written by the functions, never changed or deleted.
CREATE TABLE public.integration_connection_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('created', 'config_changed', 'tested', 'credential_set', 'credential_rotated', 'credential_revoked', 'ready', 'activated', 'paused', 'resumed', 'retired', 'reset_to_draft')),
  from_status text,
  to_status text,
  note text CHECK (note IS NULL OR length(note) <= 1000),
  at timestamptz NOT NULL DEFAULT now(),
  by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT integration_connection_events_connection_fkey FOREIGN KEY (connection_id, organisation_id) REFERENCES public.integration_connections (id, organisation_id)
);
CREATE INDEX integration_connection_events_idx ON public.integration_connection_events (connection_id, at);

-- ---------------------------------------------------------------------------
-- Credentials: a pointer to a Vault secret, never the secret
-- ---------------------------------------------------------------------------
CREATE TABLE public.integration_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('api_key', 'bearer', 'basic', 'oauth_client')),
  secret_id uuid,
  rotated_from uuid,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  revoke_reason text CHECK (revoke_reason IS NULL OR length(btrim(revoke_reason)) BETWEEN 3 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT integration_credentials_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT integration_credentials_connection_fkey FOREIGN KEY (connection_id, organisation_id) REFERENCES public.integration_connections (id, organisation_id),
  CONSTRAINT integration_credentials_live CHECK ((revoked_at IS NULL) = (secret_id IS NOT NULL) AND (revoked_at IS NULL) = (revoke_reason IS NULL))
);
CREATE UNIQUE INDEX integration_credentials_live_key ON public.integration_credentials (connection_id) WHERE revoked_at IS NULL;
CREATE TRIGGER integration_credentials_stamp BEFORE INSERT ON public.integration_credentials FOR EACH ROW EXECUTE FUNCTION app.stamp_created();

-- A credential row changes once, to say it was revoked (the secret id is cleared); nothing else, never deleted.
CREATE FUNCTION app.integration_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_TABLE_NAME = 'integration_credentials' AND TG_OP = 'UPDATE' AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
     AND (to_jsonb(NEW) - ARRAY['secret_id', 'revoked_at', 'revoked_by', 'revoke_reason', 'updated_at', 'updated_by']) = (to_jsonb(OLD) - ARRAY['secret_id', 'revoked_at', 'revoked_by', 'revoke_reason', 'updated_at', 'updated_by']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'This integration record is never changed or deleted once written' USING ERRCODE = 'QM022';
END $$;
CREATE TRIGGER integration_credentials_frozen BEFORE UPDATE OR DELETE ON public.integration_credentials FOR EACH ROW EXECUTE FUNCTION app.integration_frozen();
CREATE TRIGGER integration_connection_events_frozen BEFORE UPDATE OR DELETE ON public.integration_connection_events FOR EACH ROW EXECUTE FUNCTION app.integration_frozen();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['integration_connections', 'integration_credentials', 'integration_connection_events'] LOOP
    EXECUTE format('CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION audit.record_change(%L)', t, 'organisation_id');
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
  END LOOP;
END $$;
CREATE POLICY integration_connections_select ON public.integration_connections FOR SELECT TO authenticated USING (app.has_permission(organisation_id, 'integrations.read'));
CREATE POLICY integration_connection_events_select ON public.integration_connection_events FOR SELECT TO authenticated USING (app.has_permission(organisation_id, 'integrations.read'));
CREATE POLICY integration_credentials_select ON public.integration_credentials FOR SELECT TO authenticated USING (app.has_permission(organisation_id, 'integrations.manage'));

-- ---------------------------------------------------------------------------
-- What a valid configuration is (non-secret only)
-- ---------------------------------------------------------------------------
-- An https address on a public-looking host name: no IP addresses, no localhost, no user:password@, no unusual ports. (The REST connector checks again when it connects.)
CREATE FUNCTION app.integration_url_problem(p_url text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE
    WHEN p_url IS NULL OR length(p_url) > 300 THEN 'Give the address of the API (up to 300 characters)'
    WHEN p_url !~* '^https://' THEN 'The address must start with https://'
    WHEN p_url ~* '^https://[^/?#]*@' THEN 'The address must not contain a user name or password'
    WHEN p_url !~* '^https://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(:443)?([/?#][^[:space:]]*)?$' THEN 'The address must use a host name (not an IP address) and no port other than 443'
    WHEN lower(substring(p_url from '^https://([^/:?#]+)')) IN ('localhost') OR lower(substring(p_url from '^https://([^/:?#]+)')) ~ '\.(local|localhost|internal|lan|home|corp|intranet)$' THEN 'The address must be a public host name'
    ELSE NULL END
$$;

CREATE FUNCTION app.integration_config_problem(p_provider text, p_config jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE k text; v_problem text;
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
      IF k NOT IN ('baseUrl', 'authType', 'apiKeyHeader', 'timeoutSeconds') THEN RETURN format('Unknown setting "%s" for a REST connection', k); END IF;
    END LOOP;
    v_problem := app.integration_url_problem(p_config ->> 'baseUrl');
    IF v_problem IS NOT NULL THEN RETURN v_problem; END IF;
    IF coalesce(p_config ->> 'authType', 'none') NOT IN ('none', 'api_key', 'bearer', 'basic') THEN RETURN 'The sign-in type is none, api_key, bearer or basic'; END IF;
    IF p_config ->> 'authType' = 'api_key' AND coalesce(p_config ->> 'apiKeyHeader', '') !~ '^[A-Za-z0-9-]{1,60}$' THEN RETURN 'Name the header the API key is sent in (letters, digits and hyphens)'; END IF;
    IF p_config ? 'timeoutSeconds' AND (jsonb_typeof(p_config -> 'timeoutSeconds') <> 'number' OR (p_config ->> 'timeoutSeconds') !~ '^[0-9]+$' OR (p_config ->> 'timeoutSeconds')::int NOT BETWEEN 1 AND 60) THEN RETURN 'The timeout is a whole number of seconds from 1 to 60'; END IF;
  ELSE
    RETURN 'That provider cannot be configured yet';
  END IF;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Helpers (internal)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.integration_connection_for_write(p_connection uuid, p_permission text) RETURNS public.integration_connections
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.integration_connections%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.integration_connections WHERE id = p_connection FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(c.organisation_id) THEN RAISE EXCEPTION 'Connection not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(c.organisation_id, p_permission) THEN RAISE EXCEPTION 'You are not allowed to do that with integrations' USING ERRCODE = '42501'; END IF;
  RETURN c;
END $$;

CREATE FUNCTION app.integration_log(p_connection public.integration_connections, p_action text, p_from text, p_to text, p_note text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO public.integration_connection_events (organisation_id, connection_id, action, from_status, to_status, note)
  VALUES (p_connection.organisation_id, p_connection.id, p_action, p_from, p_to, nullif(left(btrim(coalesce(p_note, '')), 1000), ''))
$$;

-- What still stops a connection being made ready or activated: a list of plain sentences (empty = nothing).
CREATE FUNCTION app.integration_activation_problems(p_connection uuid) RETURNS text[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.integration_connections%ROWTYPE; p public.integration_providers%ROWTYPE; v_problems text[] := '{}'; v_cfg text; v_kind text; v_live text;
BEGIN
  SELECT * INTO c FROM public.integration_connections WHERE id = p_connection;
  IF NOT FOUND OR NOT app.is_member(c.organisation_id) THEN RAISE EXCEPTION 'Connection not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO p FROM public.integration_providers WHERE id = c.provider_id;
  IF p.status <> 'available' THEN v_problems := array_append(v_problems, 'That provider is not available yet'::text); END IF;
  v_cfg := app.integration_config_problem(p.key, c.config);
  IF v_cfg IS NOT NULL THEN v_problems := v_problems || v_cfg; END IF;
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

-- ---------------------------------------------------------------------------
-- Commands (integrations.manage unless said)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.create_integration_connection(p_organisation uuid, p_provider text, p_name text, p_external_system text, p_config jsonb DEFAULT '{}'::jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE p public.integration_providers%ROWTYPE; v_problem text; c public.integration_connections%ROWTYPE;
BEGIN
  IF NOT app.is_member(p_organisation) THEN RAISE EXCEPTION 'Organisation not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(p_organisation, 'integrations.manage') THEN RAISE EXCEPTION 'You are not allowed to create integration connections' USING ERRCODE = '42501'; END IF;
  SELECT * INTO p FROM public.integration_providers WHERE key = p_provider;
  IF NOT FOUND THEN RAISE EXCEPTION 'Provider not found' USING ERRCODE = 'P0002'; END IF;
  IF p.status <> 'available' THEN RAISE EXCEPTION '% is not available yet', p.name USING ERRCODE = 'QM022'; END IF;
  IF p_name IS NULL OR length(btrim(p_name)) NOT BETWEEN 2 AND 80 THEN RAISE EXCEPTION 'Give the connection a name (2 to 80 characters)' USING ERRCODE = 'QM022'; END IF;
  IF p_external_system IS NULL OR p_external_system !~ '^[a-z][a-z0-9_-]{1,39}$' THEN RAISE EXCEPTION 'The system code is 2 to 40 lower-case letters, digits, hyphens or underscores, starting with a letter (for example erp)' USING ERRCODE = 'QM022'; END IF;
  v_problem := app.integration_config_problem(p.key, coalesce(p_config, '{}'::jsonb));
  IF v_problem IS NOT NULL AND p.key <> 'rest_api' THEN RAISE EXCEPTION '%', v_problem USING ERRCODE = 'QM022'; END IF;
  -- a REST connection may be started before its address is known only if what it has is valid; the address itself is checked as soon as one is given
  IF p.key = 'rest_api' AND p_config IS NOT NULL AND p_config <> '{}'::jsonb AND v_problem IS NOT NULL THEN RAISE EXCEPTION '%', v_problem USING ERRCODE = 'QM022'; END IF;
  IF EXISTS (SELECT 1 FROM public.integration_connections WHERE organisation_id = p_organisation AND lower(btrim(name)) = lower(btrim(p_name))) THEN RAISE EXCEPTION 'There is already a connection called %', btrim(p_name) USING ERRCODE = 'QM022'; END IF;
  IF EXISTS (SELECT 1 FROM public.integration_connections WHERE organisation_id = p_organisation AND external_system = p_external_system) THEN RAISE EXCEPTION 'The system code % is already used by another connection', p_external_system USING ERRCODE = 'QM022'; END IF;
  INSERT INTO public.integration_connections (organisation_id, provider_id, name, external_system, config) VALUES (p_organisation, p.id, btrim(p_name), p_external_system, coalesce(p_config, '{}'::jsonb)) RETURNING * INTO c;
  PERFORM app.integration_log(c, 'created', NULL, 'draft', p.name);
  RETURN c.id;
END $$;

-- Rename or change the (non-secret) configuration. Not while active (pause first); a ready connection goes back to draft because what was checked has changed.
CREATE FUNCTION app.update_integration_connection(p_connection uuid, p_name text DEFAULT NULL, p_config jsonb DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.integration_connections%ROWTYPE; p public.integration_providers%ROWTYPE; v_problem text; v_changed boolean := false;
BEGIN
  c := app.integration_connection_for_write(p_connection, 'integrations.manage');
  IF c.status IN ('active', 'retired') THEN RAISE EXCEPTION 'A % connection cannot be changed%', c.status, CASE WHEN c.status = 'active' THEN ': pause it first' ELSE '' END USING ERRCODE = 'QM022'; END IF;
  SELECT * INTO p FROM public.integration_providers WHERE id = c.provider_id;
  IF p_name IS NOT NULL THEN
    IF length(btrim(p_name)) NOT BETWEEN 2 AND 80 THEN RAISE EXCEPTION 'Give the connection a name (2 to 80 characters)' USING ERRCODE = 'QM022'; END IF;
    IF EXISTS (SELECT 1 FROM public.integration_connections WHERE organisation_id = c.organisation_id AND id <> c.id AND lower(btrim(name)) = lower(btrim(p_name))) THEN RAISE EXCEPTION 'There is already a connection called %', btrim(p_name) USING ERRCODE = 'QM022'; END IF;
    UPDATE public.integration_connections SET name = btrim(p_name), updated_at = now(), updated_by = auth.uid() WHERE id = c.id;
  END IF;
  IF p_config IS NOT NULL AND p_config IS DISTINCT FROM c.config THEN
    v_problem := app.integration_config_problem(p.key, p_config);
    IF v_problem IS NOT NULL THEN RAISE EXCEPTION '%', v_problem USING ERRCODE = 'QM022'; END IF;
    UPDATE public.integration_connections SET config = p_config, config_changed_at = clock_timestamp(), updated_at = now(), updated_by = auth.uid() WHERE id = c.id;
    v_changed := true;
    PERFORM app.integration_log(c, 'config_changed', c.status, c.status, NULL);
    IF c.status = 'ready' THEN
      UPDATE public.integration_connections SET status = 'draft', ready_at = NULL, ready_by = NULL WHERE id = c.id;
      PERFORM app.integration_log(c, 'reset_to_draft', 'ready', 'draft', 'The configuration changed after it was marked ready');
    END IF;
  END IF;
END $$;

-- Keep a ready connection honest: if what it needs is no longer true, it goes back to draft (an active one is paused).
CREATE FUNCTION app.integration_recheck(p_connection uuid, p_why text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.integration_connections%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.integration_connections WHERE id = p_connection FOR UPDATE;
  IF c.status = 'ready' AND cardinality(app.integration_activation_problems(c.id)) > 0 THEN
    UPDATE public.integration_connections SET status = 'draft', ready_at = NULL, ready_by = NULL, updated_at = now(), updated_by = auth.uid() WHERE id = c.id;
    PERFORM app.integration_log(c, 'reset_to_draft', 'ready', 'draft', p_why);
  ELSIF c.status = 'active' AND cardinality(app.integration_activation_problems(c.id)) > 0 THEN
    UPDATE public.integration_connections SET status = 'paused', updated_at = now(), updated_by = auth.uid() WHERE id = c.id;
    PERFORM app.integration_log(c, 'paused', 'active', 'paused', p_why);
  END IF;
END $$;

CREATE FUNCTION app.set_integration_credential(p_connection uuid, p_kind text, p_secret text) RETURNS uuid
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

CREATE FUNCTION app.revoke_integration_credential(p_credential uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE k public.integration_credentials%ROWTYPE; c public.integration_connections%ROWTYPE;
BEGIN
  SELECT * INTO k FROM public.integration_credentials WHERE id = p_credential;
  IF NOT FOUND THEN RAISE EXCEPTION 'Credential not found' USING ERRCODE = 'P0002'; END IF;
  c := app.integration_connection_for_write(k.connection_id, 'integrations.manage');
  SELECT * INTO k FROM public.integration_credentials WHERE id = p_credential FOR UPDATE;
  IF k.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'That credential has already been revoked' USING ERRCODE = 'QM022'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'Say why the credential is being revoked (3 to 1000 characters)' USING ERRCODE = 'QM022'; END IF;
  DELETE FROM vault.secrets WHERE id = k.secret_id;
  UPDATE public.integration_credentials SET revoked_at = now(), revoked_by = auth.uid(), revoke_reason = btrim(p_reason), secret_id = NULL, updated_at = now(), updated_by = auth.uid() WHERE id = k.id;
  PERFORM app.integration_log(c, 'credential_revoked', c.status, c.status, p_reason);
  PERFORM app.integration_recheck(c.id, 'The credential was revoked');
END $$;

CREATE FUNCTION app.record_integration_connection_test(p_connection uuid, p_ok boolean, p_message text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.integration_connections%ROWTYPE;
BEGIN
  c := app.integration_connection_for_write(p_connection, 'integrations.manage');
  IF c.status = 'retired' THEN RAISE EXCEPTION 'A retired connection cannot be tested' USING ERRCODE = 'QM022'; END IF;
  IF p_ok IS NULL THEN RAISE EXCEPTION 'Say whether the test passed' USING ERRCODE = 'QM022'; END IF;
  UPDATE public.integration_connections SET last_tested_at = clock_timestamp(), last_test_ok = p_ok, last_test_message = left(btrim(coalesce(p_message, '')), 500), updated_at = now(), updated_by = auth.uid() WHERE id = c.id;
  PERFORM app.integration_log(c, 'tested', c.status, c.status, CASE WHEN p_ok THEN 'Passed' ELSE 'Failed: ' END || left(btrim(coalesce(p_message, '')), 300));
  IF NOT p_ok THEN PERFORM app.integration_recheck(c.id, 'The connection test failed'); END IF;
END $$;

CREATE FUNCTION app.mark_integration_ready(p_connection uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.integration_connections%ROWTYPE; v_problems text[];
BEGIN
  c := app.integration_connection_for_write(p_connection, 'integrations.manage');
  IF c.status <> 'draft' THEN RAISE EXCEPTION 'Only a draft connection can be marked ready' USING ERRCODE = 'QM022'; END IF;
  v_problems := app.integration_activation_problems(c.id);
  IF cardinality(v_problems) > 0 THEN RAISE EXCEPTION 'Not ready yet: %', array_to_string(v_problems, '; ') USING ERRCODE = 'QM022'; END IF;
  UPDATE public.integration_connections SET status = 'ready', ready_at = now(), ready_by = auth.uid(), updated_at = now(), updated_by = auth.uid() WHERE id = c.id;
  PERFORM app.integration_log(c, 'ready', 'draft', 'ready', NULL);
END $$;

-- Activation is approved by someone other than the person who marked the connection ready.
CREATE FUNCTION app.activate_integration_connection(p_connection uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.integration_connections%ROWTYPE; v_problems text[];
BEGIN
  c := app.integration_connection_for_write(p_connection, 'integrations.approve');
  IF c.status <> 'ready' THEN RAISE EXCEPTION 'Only a connection that is ready can be activated' USING ERRCODE = 'QM022'; END IF;
  IF c.ready_by IS NOT DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'A different person must approve activation: you marked this connection ready' USING ERRCODE = 'QM022'; END IF;
  v_problems := app.integration_activation_problems(c.id);
  IF cardinality(v_problems) > 0 THEN RAISE EXCEPTION 'Not ready: %', array_to_string(v_problems, '; ') USING ERRCODE = 'QM022'; END IF;
  UPDATE public.integration_connections SET status = 'active', activated_at = now(), activated_by = auth.uid(), updated_at = now(), updated_by = auth.uid() WHERE id = c.id;
  PERFORM app.integration_log(c, 'activated', 'ready', 'active', NULL);
END $$;

CREATE FUNCTION app.pause_integration_connection(p_connection uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.integration_connections%ROWTYPE;
BEGIN
  c := app.integration_connection_for_write(p_connection, 'integrations.manage');
  IF c.status <> 'active' THEN RAISE EXCEPTION 'Only an active connection can be paused' USING ERRCODE = 'QM022'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'Say why it is being paused (3 to 1000 characters)' USING ERRCODE = 'QM022'; END IF;
  UPDATE public.integration_connections SET status = 'paused', updated_at = now(), updated_by = auth.uid() WHERE id = c.id;
  PERFORM app.integration_log(c, 'paused', 'active', 'paused', p_reason);
END $$;

-- Resuming needs the same conditions as activating (and the person who resumes need not be a second person: it was already approved once).
CREATE FUNCTION app.resume_integration_connection(p_connection uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.integration_connections%ROWTYPE; v_problems text[];
BEGIN
  c := app.integration_connection_for_write(p_connection, 'integrations.manage');
  IF c.status <> 'paused' THEN RAISE EXCEPTION 'Only a paused connection can be resumed' USING ERRCODE = 'QM022'; END IF;
  IF c.activated_at IS NULL THEN RAISE EXCEPTION 'This connection was never activated' USING ERRCODE = 'QM022'; END IF;
  v_problems := app.integration_activation_problems(c.id);
  IF cardinality(v_problems) > 0 THEN RAISE EXCEPTION 'Not ready: %', array_to_string(v_problems, '; ') USING ERRCODE = 'QM022'; END IF;
  UPDATE public.integration_connections SET status = 'active', updated_at = now(), updated_by = auth.uid() WHERE id = c.id;
  PERFORM app.integration_log(c, 'resumed', 'paused', 'active', NULL);
END $$;

-- Retiring is final: the credential is revoked and its secret deleted.
CREATE FUNCTION app.retire_integration_connection(p_connection uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.integration_connections%ROWTYPE; k public.integration_credentials%ROWTYPE;
BEGIN
  c := app.integration_connection_for_write(p_connection, 'integrations.manage');
  IF c.status = 'retired' THEN RAISE EXCEPTION 'That connection is already retired' USING ERRCODE = 'QM022'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'Say why it is being retired (3 to 1000 characters)' USING ERRCODE = 'QM022'; END IF;
  SELECT * INTO k FROM public.integration_credentials WHERE connection_id = c.id AND revoked_at IS NULL FOR UPDATE;
  IF FOUND THEN
    DELETE FROM vault.secrets WHERE id = k.secret_id;
    UPDATE public.integration_credentials SET revoked_at = now(), revoked_by = auth.uid(), revoke_reason = 'The connection was retired', secret_id = NULL, updated_at = now(), updated_by = auth.uid() WHERE id = k.id;
    PERFORM app.integration_log(c, 'credential_revoked', c.status, c.status, 'The connection was retired');
  END IF;
  UPDATE public.integration_connections SET status = 'retired', retired_at = now(), updated_at = now(), updated_by = auth.uid() WHERE id = c.id;
  PERFORM app.integration_log(c, 'retired', c.status, 'retired', p_reason);
END $$;

-- The one reader of a stored secret: the API login only, for an adapter that is about to connect. It checks the connection belongs to the organisation it is told it is acting for.
CREATE FUNCTION app.integration_credential_secret(p_organisation uuid, p_connection uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_secret uuid; v_value text;
BEGIN
  SELECT k.secret_id INTO v_secret FROM public.integration_credentials k JOIN public.integration_connections c ON c.id = k.connection_id AND c.organisation_id = k.organisation_id
   WHERE k.connection_id = p_connection AND k.organisation_id = p_organisation AND k.revoked_at IS NULL AND c.status <> 'retired';
  IF v_secret IS NULL THEN RETURN NULL; END IF;
  SELECT decrypted_secret INTO v_value FROM vault.decrypted_secrets WHERE id = v_secret;
  RETURN v_value;
END $$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app.integration_status_guard(), app.integration_frozen(), app.integration_url_problem(text), app.integration_config_problem(text, jsonb),
  app.integration_connection_for_write(uuid, text), app.integration_log(public.integration_connections, text, text, text, text), app.integration_activation_problems(uuid),
  app.integration_recheck(uuid, text), app.integration_credential_secret(uuid, uuid) FROM PUBLIC, anon, authenticated;
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['create_integration_connection(uuid,text,text,text,jsonb)', 'update_integration_connection(uuid,text,jsonb)', 'set_integration_credential(uuid,text,text)',
    'revoke_integration_credential(uuid,text)', 'record_integration_connection_test(uuid,boolean,text)', 'mark_integration_ready(uuid)', 'activate_integration_connection(uuid)',
    'pause_integration_connection(uuid,text)', 'resume_integration_connection(uuid)', 'retire_integration_connection(uuid,text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION app.%s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION app.%s TO authenticated', f);
  END LOOP;
END $$;
-- (the problems list is read by the API through a function it may call as the caller)
GRANT EXECUTE ON FUNCTION app.integration_activation_problems(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION app.integration_credential_secret(uuid, uuid) TO qms_api;
