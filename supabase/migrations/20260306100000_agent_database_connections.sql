-- Connector agent AG2 (docs/connector-agent-plan.md §9): database connections read through a connector agent.
--
--  * Provider sql_agent becomes available. A connection names its agent (integration_connections.agent_id, fixed once created) and how to
--    reach the database (engine sqlserver | postgres, server, port or instance, database, sign-in, encryption): non-secret settings only.
--  * The database password never reaches Fortress in a readable form (AG-D4): the browser seals it to the agent's sealing key
--    (ECDH P-256 → HKDF-SHA256 → AES-256-GCM, the connection id as associated data). app.set_agent_credential hands the sealed bytes to the agent
--    as a store_credential job; integration_agent_credentials records only whether the agent has stored it. The sealed bytes are removed from the
--    job the moment it ends, whatever the outcome. SQL Server can sign in with Windows authentication (the service account) and needs no password.
--  * Jobs for a connection (app.request_connection_job): test_connection, discover (schemas, objects, columns) and preview (first rows).
--    The cloud sends no SQL: a structured request the agent checks against what the database itself lists (AG-D5).
--    A test's answer is recorded on the connection, as of when it was asked, so a test of older settings never counts.
--  * Activation also needs the agent live and, for a password sign-in, the password stored on it. Revoking or reinstalling the agent
--    puts its connections back to draft / paused (app.integration_recheck) and the password has to be typed again after a reinstall.
--  * Imports from these connections arrive with AG3: until then a run for one is refused.
-- No table writes for people or agents: SECURITY DEFINER functions only. Errors QM022 → 409 integration_rule; another organisation P0002 → 404.

UPDATE public.integration_providers
   SET name = 'Database through a connector agent',
       description = 'SQL Server or PostgreSQL inside your network, read through a connector agent you install there. Nothing connects in; the password stays on the agent.',
       auth_types = ARRAY['windows', 'sql', 'password'],
       capabilities = '{"testable": true, "incremental": true, "webhooks": false, "writeBack": false, "agent": true}'::jsonb,
       status = 'available'
 WHERE key = 'sql_agent';

-- ---------------------------------------------------------------------------
-- The agent a connection reads through
-- ---------------------------------------------------------------------------
ALTER TABLE public.integration_connections ADD COLUMN agent_id uuid;
ALTER TABLE public.integration_connections ADD CONSTRAINT integration_connections_agent_fkey
  FOREIGN KEY (agent_id, organisation_id) REFERENCES public.integration_agents (id, organisation_id);
CREATE INDEX integration_connections_agent_idx ON public.integration_connections (agent_id) WHERE agent_id IS NOT NULL;

-- A database connection names its agent; no other kind does; the agent never changes (a new machine is a reinstall of the same agent).
CREATE FUNCTION app.integration_connection_agent_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_key text;
BEGIN
  SELECT key INTO v_key FROM public.integration_providers WHERE id = NEW.provider_id;
  IF TG_OP = 'UPDATE' AND NEW.agent_id IS DISTINCT FROM OLD.agent_id THEN
    RAISE EXCEPTION 'The connector agent of a connection cannot be changed' USING ERRCODE = 'QM022';
  END IF;
  IF v_key = 'sql_agent' AND NEW.agent_id IS NULL THEN RAISE EXCEPTION 'Choose the connector agent that reads this database' USING ERRCODE = 'QM022'; END IF;
  IF v_key IS DISTINCT FROM 'sql_agent' AND NEW.agent_id IS NOT NULL THEN RAISE EXCEPTION 'Only a database connection reads through a connector agent' USING ERRCODE = 'QM022'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER integration_connections_agent_rules BEFORE INSERT OR UPDATE OF agent_id, provider_id ON public.integration_connections
  FOR EACH ROW EXECUTE FUNCTION app.integration_connection_agent_rules();

-- The settings of a database connection. Host names may be internal (the agent resolves them inside the customer's network), but nothing
-- that could change the meaning of a connection string is accepted: no ; = quotes, spaces or control characters.
CREATE FUNCTION app.integration_agent_config_problem(p_config jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE k text; v_engine text := p_config ->> 'engine'; v_auth text := p_config ->> 'authType';
BEGIN
  FOR k IN SELECT jsonb_object_keys(p_config) LOOP
    IF k NOT IN ('engine', 'server', 'port', 'instance', 'database', 'authType', 'encrypt', 'trustServerCertificate', 'timeoutSeconds') THEN
      RETURN format('Unknown setting "%s" for a database connection', k);
    END IF;
  END LOOP;
  IF v_engine IS NULL OR v_engine NOT IN ('sqlserver', 'postgres') THEN RETURN 'Choose the database: SQL Server or PostgreSQL'; END IF;
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
  IF p_config ? 'encrypt' AND jsonb_typeof(p_config -> 'encrypt') <> 'boolean' THEN RETURN 'Say whether the connection is encrypted'; END IF;
  IF p_config ? 'trustServerCertificate' AND jsonb_typeof(p_config -> 'trustServerCertificate') <> 'boolean' THEN RETURN 'Say whether the server''s certificate is trusted without checking'; END IF;
  IF p_config ? 'timeoutSeconds' AND (jsonb_typeof(p_config -> 'timeoutSeconds') <> 'number' OR (p_config ->> 'timeoutSeconds') !~ '^[0-9]+$' OR (p_config ->> 'timeoutSeconds')::int NOT BETWEEN 5 AND 120) THEN
    RETURN 'The timeout is a whole number of seconds from 5 to 120';
  END IF;
  RETURN NULL;
END $$;

-- Does this connection's sign-in need a password held by the agent?
CREATE FUNCTION app.integration_agent_needs_password(p_config jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$ SELECT coalesce(p_config ->> 'authType', '') IN ('sql', 'password') $$;

-- ---------------------------------------------------------------------------
-- Passwords held by the agent: Fortress records only whether it has them
-- ---------------------------------------------------------------------------
CREATE TABLE public.integration_agent_credentials (
  connection_id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  key_id uuid NOT NULL REFERENCES public.integration_agent_keys (id),
  status text NOT NULL CHECK (status IN ('waiting', 'stored', 'failed', 'cleared')),
  job_id uuid,
  message text CHECK (message IS NULL OR length(message) <= 1000),
  set_at timestamptz NOT NULL DEFAULT now(),
  set_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  stored_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (connection_id, organisation_id) REFERENCES public.integration_connections (id, organisation_id),
  FOREIGN KEY (agent_id, organisation_id) REFERENCES public.integration_agents (id, organisation_id)
);
CREATE INDEX integration_agent_credentials_org_idx ON public.integration_agent_credentials (organisation_id);
CREATE INDEX integration_agent_credentials_agent_idx ON public.integration_agent_credentials (agent_id);
CREATE TRIGGER integration_agent_credentials_never_deleted BEFORE DELETE ON public.integration_agent_credentials FOR EACH ROW EXECUTE FUNCTION app.integration_agent_never_deleted();
CREATE TRIGGER integration_agent_credentials_org_immutable BEFORE UPDATE ON public.integration_agent_credentials FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE ON public.integration_agent_credentials FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id', 'connection_id');
ALTER TABLE public.integration_agent_credentials ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.integration_agent_credentials FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.integration_agent_credentials TO authenticated;
CREATE POLICY integration_agent_credentials_select ON public.integration_agent_credentials FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'integrations.read'));

-- ---------------------------------------------------------------------------
-- Jobs for a connection
-- ---------------------------------------------------------------------------
ALTER TABLE public.integration_agent_jobs DROP CONSTRAINT integration_agent_jobs_kind_check;
ALTER TABLE public.integration_agent_jobs ADD CONSTRAINT integration_agent_jobs_kind_check
  CHECK (kind IN ('ping', 'store_credential', 'test_connection', 'discover', 'preview', 'extract'));
ALTER TABLE public.integration_agent_jobs ADD COLUMN connection_id uuid;
ALTER TABLE public.integration_agent_jobs ADD CONSTRAINT integration_agent_jobs_connection_fkey
  FOREIGN KEY (connection_id, organisation_id) REFERENCES public.integration_connections (id, organisation_id);
ALTER TABLE public.integration_agent_jobs ADD CONSTRAINT integration_agent_jobs_connection_needed
  CHECK ((kind = 'ping') = (connection_id IS NULL));
CREATE INDEX integration_agent_jobs_connection_idx ON public.integration_agent_jobs (connection_id, created_at DESC) WHERE connection_id IS NOT NULL;

-- The sealed password leaves the job the moment the job ends, whatever the outcome (and even for SQL run by an operator).
CREATE FUNCTION app.integration_agent_job_forget_secret() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.kind = 'store_credential' AND NEW.status IN ('completed', 'failed', 'cancelled') THEN NEW.spec := NEW.spec - 'sealed'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER integration_agent_jobs_forget_secret BEFORE UPDATE OF status ON public.integration_agent_jobs
  FOR EACH ROW EXECUTE FUNCTION app.integration_agent_job_forget_secret();

-- The connection's history gains two words: the agent stored the password, or could not.
ALTER TABLE public.integration_connection_events DROP CONSTRAINT integration_connection_events_action_check;
ALTER TABLE public.integration_connection_events ADD CONSTRAINT integration_connection_events_action_check
  CHECK (action IN ('created', 'config_changed', 'tested', 'credential_set', 'credential_rotated', 'credential_revoked', 'credential_stored', 'credential_failed',
                    'ready', 'activated', 'paused', 'resumed', 'retired', 'reset_to_draft'));

-- What a finished job means for its connection: a stored password, a test result.
CREATE FUNCTION app.integration_agent_job_outcome() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.integration_connections%ROWTYPE; v_ok boolean; v_message text;
BEGIN
  IF NEW.status = OLD.status OR NEW.status NOT IN ('completed', 'failed', 'cancelled') OR NEW.connection_id IS NULL THEN RETURN NULL; END IF;
  -- A cancelled password job changes nothing here: it was replaced by a newer password, or the agent was revoked (which clears it anyway).
  IF NEW.kind = 'store_credential' AND NEW.status IN ('completed', 'failed') THEN
    UPDATE public.integration_agent_credentials
       SET status = CASE WHEN NEW.status = 'completed' THEN 'stored' ELSE 'failed' END,
           stored_at = CASE WHEN NEW.status = 'completed' THEN clock_timestamp() ELSE stored_at END,
           message = CASE WHEN NEW.status = 'completed' THEN NULL ELSE coalesce(NEW.error_message, 'The agent could not store the password') END,
           updated_at = now()
     WHERE connection_id = NEW.connection_id AND job_id = NEW.id;
    IF FOUND THEN
      SELECT * INTO c FROM public.integration_connections WHERE id = NEW.connection_id;
      PERFORM app.integration_log(c, CASE WHEN NEW.status = 'completed' THEN 'credential_stored' ELSE 'credential_failed' END, c.status, c.status,
        CASE WHEN NEW.status = 'completed' THEN 'The agent stored the password' ELSE coalesce(NEW.error_message, 'The agent could not store the password') END);
      IF NEW.status <> 'completed' THEN PERFORM app.integration_recheck(c.id, 'The agent could not store the password'); END IF;
    END IF;
  ELSIF NEW.kind = 'test_connection' AND NEW.status IN ('completed', 'failed') THEN
    SELECT * INTO c FROM public.integration_connections WHERE id = NEW.connection_id FOR UPDATE;
    IF NOT FOUND OR c.status = 'retired' THEN RETURN NULL; END IF;
    v_ok := NEW.status = 'completed' AND coalesce((NEW.result ->> 'ok')::boolean, false);
    v_message := left(btrim(coalesce(CASE WHEN NEW.status = 'completed' THEN NEW.result ->> 'message' ELSE NEW.error_message END, '')), 500);
    -- As of when it was asked: if the settings changed since, this test is already out of date.
    IF c.last_tested_at IS NULL OR c.last_tested_at <= NEW.created_at THEN
      UPDATE public.integration_connections SET last_tested_at = NEW.created_at, last_test_ok = v_ok, last_test_message = nullif(v_message, '') WHERE id = c.id;
    END IF;
    PERFORM app.integration_log(c, 'tested', c.status, c.status, CASE WHEN v_ok THEN 'Passed' ELSE 'Failed: ' END || left(v_message, 300));
    IF NOT v_ok THEN PERFORM app.integration_recheck(c.id, 'The connection test failed'); END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER integration_agent_jobs_outcome AFTER UPDATE OF status ON public.integration_agent_jobs
  FOR EACH ROW EXECUTE FUNCTION app.integration_agent_job_outcome();

-- What still stands between a database connection and activation, beyond the general checks.
CREATE FUNCTION app.integration_agent_problems(p_connection uuid) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.integration_connections%ROWTYPE; a public.integration_agents%ROWTYPE; k public.integration_agent_credentials%ROWTYPE; v text[] := '{}';
BEGIN
  SELECT * INTO c FROM public.integration_connections WHERE id = p_connection;
  SELECT * INTO a FROM public.integration_agents WHERE id = c.agent_id;
  IF NOT FOUND THEN RETURN ARRAY['Choose the connector agent that reads this database']; END IF;
  IF a.status <> 'active' THEN v := v || format('The connector agent %s has been revoked: make a new connection on an agent that is running', a.name); RETURN v; END IF;
  IF app.integration_agent_needs_password(c.config) THEN
    SELECT * INTO k FROM public.integration_agent_credentials WHERE connection_id = c.id;
    IF NOT FOUND OR k.status = 'cleared' THEN v := v || 'Type the database password (it is sealed in your browser and only the agent can open it)'::text;
    ELSIF k.status = 'waiting' THEN v := v || 'The password is on its way to the agent: it is stored the next time the agent checks in'::text;
    ELSIF k.status = 'failed' THEN v := v || ('The agent could not store the password: ' || coalesce(k.message, 'type it again'));
    END IF;
  END IF;
  RETURN v;
END $$;

-- ---------------------------------------------------------------------------
-- People's functions
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.create_agent_connection(p_organisation uuid, p_agent uuid, p_name text, p_external_system text, p_config jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE p public.integration_providers%ROWTYPE; a public.integration_agents%ROWTYPE; v_problem text; c public.integration_connections%ROWTYPE;
BEGIN
  IF NOT app.is_member(p_organisation) THEN RAISE EXCEPTION 'Organisation not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(p_organisation, 'integrations.manage') THEN RAISE EXCEPTION 'You are not allowed to create integration connections' USING ERRCODE = '42501'; END IF;
  SELECT * INTO p FROM public.integration_providers WHERE key = 'sql_agent';
  IF p.status <> 'available' THEN RAISE EXCEPTION '% is not available yet', p.name USING ERRCODE = 'QM022'; END IF;
  SELECT * INTO a FROM public.integration_agents WHERE id = p_agent AND organisation_id = p_organisation;
  IF NOT FOUND THEN RAISE EXCEPTION 'Agent not found' USING ERRCODE = 'P0002'; END IF;
  IF a.status <> 'active' THEN RAISE EXCEPTION 'That connector agent has been revoked' USING ERRCODE = 'QM022'; END IF;
  IF p_name IS NULL OR length(btrim(p_name)) NOT BETWEEN 2 AND 80 THEN RAISE EXCEPTION 'Give the connection a name (2 to 80 characters)' USING ERRCODE = 'QM022'; END IF;
  IF p_external_system IS NULL OR p_external_system !~ '^[a-z][a-z0-9_-]{1,39}$' THEN RAISE EXCEPTION 'The system code is 2 to 40 lower-case letters, digits, hyphens or underscores, starting with a letter (for example erp)' USING ERRCODE = 'QM022'; END IF;
  v_problem := app.integration_agent_config_problem(coalesce(p_config, '{}'::jsonb));
  IF v_problem IS NOT NULL THEN RAISE EXCEPTION '%', v_problem USING ERRCODE = 'QM022'; END IF;
  IF EXISTS (SELECT 1 FROM public.integration_connections WHERE organisation_id = p_organisation AND lower(btrim(name)) = lower(btrim(p_name))) THEN RAISE EXCEPTION 'There is already a connection called %', btrim(p_name) USING ERRCODE = 'QM022'; END IF;
  IF EXISTS (SELECT 1 FROM public.integration_connections WHERE organisation_id = p_organisation AND external_system = p_external_system) THEN RAISE EXCEPTION 'The system code % is already used by another connection', p_external_system USING ERRCODE = 'QM022'; END IF;
  INSERT INTO public.integration_connections (organisation_id, provider_id, name, external_system, config, agent_id)
  VALUES (p_organisation, p.id, btrim(p_name), p_external_system, p_config, a.id) RETURNING * INTO c;
  PERFORM app.integration_log(c, 'created', NULL, 'draft', p.name || ' through ' || a.name);
  RETURN c.id;
END $$;

-- Give the agent the password, sealed in the browser to the agent's current sealing key. Fortress cannot open it.
CREATE FUNCTION app.set_agent_credential(p_connection uuid, p_sealed jsonb, p_key_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.integration_connections%ROWTYPE; a public.integration_agents%ROWTYPE; v_key uuid; v_job uuid; k text;
BEGIN
  c := app.integration_connection_for_write(p_connection, 'integrations.manage');
  IF c.agent_id IS NULL THEN RAISE EXCEPTION 'Only a database connection gives a password to an agent' USING ERRCODE = 'QM022'; END IF;
  IF c.status = 'retired' THEN RAISE EXCEPTION 'A retired connection cannot have a password' USING ERRCODE = 'QM022'; END IF;
  IF NOT app.integration_agent_needs_password(c.config) THEN RAISE EXCEPTION 'This connection signs in with Windows authentication: no password is needed' USING ERRCODE = 'QM022'; END IF;
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
  PERFORM app.integration_log(c, 'credential_set', c.status, c.status, 'A new password was sealed for the agent');
  PERFORM app.integration_recheck(c.id, 'The password was changed');
  RETURN v_job;
END $$;

-- Ask the agent something about a connection's database. The request is structured; the agent builds its own read-only query from it.
CREATE FUNCTION app.request_connection_job(p_connection uuid, p_kind text, p_request jsonb DEFAULT '{}'::jsonb, p_idempotency_key text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.integration_connections%ROWTYPE; a public.integration_agents%ROWTYPE; r jsonb := coalesce(p_request, '{}'::jsonb); v_req jsonb; v_id uuid; v_level text; k text;
BEGIN
  c := app.integration_connection_for_write(p_connection, 'integrations.manage');
  IF c.agent_id IS NULL THEN RAISE EXCEPTION 'Only a database connection is read through an agent' USING ERRCODE = 'QM022'; END IF;
  IF c.status = 'retired' THEN RAISE EXCEPTION 'A retired connection cannot be used' USING ERRCODE = 'QM022'; END IF;
  SELECT * INTO a FROM public.integration_agents WHERE id = c.agent_id;
  IF a.status <> 'active' THEN RAISE EXCEPTION 'The connector agent has been revoked' USING ERRCODE = 'QM022'; END IF;
  IF jsonb_typeof(r) <> 'object' THEN RAISE EXCEPTION 'The request is not in the expected form' USING ERRCODE = 'QM022'; END IF;
  FOR k IN SELECT jsonb_object_keys(r) LOOP
    IF k NOT IN ('level', 'schema', 'object', 'limit') THEN RAISE EXCEPTION 'Unknown request setting "%"', k USING ERRCODE = 'QM022'; END IF;
  END LOOP;
  IF r ? 'schema' AND (jsonb_typeof(r -> 'schema') <> 'string' OR length(r ->> 'schema') NOT BETWEEN 1 AND 128) THEN RAISE EXCEPTION 'The schema name is 1 to 128 characters' USING ERRCODE = 'QM022'; END IF;
  IF r ? 'object' AND (jsonb_typeof(r -> 'object') <> 'string' OR length(r ->> 'object') NOT BETWEEN 1 AND 128) THEN RAISE EXCEPTION 'The table or view name is 1 to 128 characters' USING ERRCODE = 'QM022'; END IF;
  IF p_kind = 'test_connection' THEN
    v_req := '{}'::jsonb;
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

-- ---------------------------------------------------------------------------
-- When the agent is revoked or reinstalled
-- ---------------------------------------------------------------------------
-- Revoked: its connections can no longer be used (back to draft / paused). Reinstalled on another machine: the new machine has no
-- passwords, so they must be typed again.
CREATE FUNCTION app.integration_agent_lifecycle() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_conn uuid; v_why text;
BEGIN
  IF NEW.kind NOT IN ('revoked', 'deregistered', 'replaced') THEN RETURN NULL; END IF;
  v_why := CASE NEW.kind WHEN 'replaced' THEN 'The connector agent was reinstalled: type the password again' ELSE 'The connector agent was revoked' END;
  UPDATE public.integration_agent_credentials SET status = 'cleared', message = v_why, updated_at = now()
   WHERE agent_id = NEW.agent_id AND status <> 'cleared';
  FOR v_conn IN SELECT id FROM public.integration_connections WHERE agent_id = NEW.agent_id AND status IN ('ready', 'active') LOOP
    PERFORM app.integration_recheck(v_conn, v_why);
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER integration_agent_events_lifecycle AFTER INSERT ON public.integration_agent_events
  FOR EACH ROW EXECUTE FUNCTION app.integration_agent_lifecycle();

-- Imports from a database connection arrive with AG3 (extraction into the import pipeline).
CREATE FUNCTION app.integration_runs_agent_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.integration_connections WHERE id = NEW.connection_id AND agent_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Importing from a database connection is not available yet: you can test it, browse it and preview its tables' USING ERRCODE = 'QM022';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER integration_sync_runs_agent_guard BEFORE INSERT ON public.integration_sync_runs
  FOR EACH ROW EXECUTE FUNCTION app.integration_runs_agent_guard();

-- ---------------------------------------------------------------------------
-- The two shared checks learn about database connections (each is its latest definition from 20260131100000 plus one branch)
-- ---------------------------------------------------------------------------
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
  ELSIF p_provider = 'sql_agent' THEN
    RETURN app.integration_agent_config_problem(p_config);
  ELSE
    RETURN 'That provider cannot be configured yet';
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION app.integration_activation_problems_internal(p_connection uuid) RETURNS text[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.integration_connections%ROWTYPE; p public.integration_providers%ROWTYPE; v_problems text[] := '{}'; v_cfg text; v_kind text; v_live text;
BEGIN
  SELECT * INTO c FROM public.integration_connections WHERE id = p_connection;
  IF NOT FOUND THEN RAISE EXCEPTION 'Connection not found' USING ERRCODE = 'P0002'; END IF;
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
  -- a database read through a connector agent: the agent must be live and, for a password sign-in, hold the password
  IF p.key = 'sql_agent' THEN
    v_problems := v_problems || app.integration_agent_problems(c.id);
  END IF;
  RETURN v_problems;
END $$;

-- The public check keeps its membership rule; the internal one is also used when an agent's report or a lifecycle event rechecks a connection
-- (no signed-in person then).
CREATE OR REPLACE FUNCTION app.integration_activation_problems(p_connection uuid) RETURNS text[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid;
BEGIN
  SELECT organisation_id INTO v_org FROM public.integration_connections WHERE id = p_connection;
  IF v_org IS NULL OR NOT app.is_member(v_org) THEN RAISE EXCEPTION 'Connection not found' USING ERRCODE = 'P0002'; END IF;
  RETURN app.integration_activation_problems_internal(p_connection);
END $$;

-- As in 20260107100000, with the internal check so it also works without a signed-in person.
CREATE OR REPLACE FUNCTION app.integration_recheck(p_connection uuid, p_why text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.integration_connections%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.integration_connections WHERE id = p_connection FOR UPDATE;
  IF c.status = 'ready' AND cardinality(app.integration_activation_problems_internal(c.id)) > 0 THEN
    UPDATE public.integration_connections SET status = 'draft', ready_at = NULL, ready_by = NULL, updated_at = now(), updated_by = auth.uid() WHERE id = c.id;
    PERFORM app.integration_log(c, 'reset_to_draft', 'ready', 'draft', p_why);
  ELSIF c.status = 'active' AND cardinality(app.integration_activation_problems_internal(c.id)) > 0 THEN
    UPDATE public.integration_connections SET status = 'paused', updated_at = now(), updated_by = auth.uid() WHERE id = c.id;
    PERFORM app.integration_log(c, 'paused', 'active', 'paused', p_why);
  END IF;
END $$;

REVOKE ALL ON FUNCTION app.integration_activation_problems_internal(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.integration_connection_agent_rules(), app.integration_agent_config_problem(jsonb), app.integration_agent_needs_password(jsonb),
  app.integration_agent_job_forget_secret(), app.integration_agent_job_outcome(), app.integration_agent_problems(uuid),
  app.create_agent_connection(uuid, uuid, text, text, jsonb), app.set_agent_credential(uuid, jsonb, uuid),
  app.request_connection_job(uuid, text, jsonb, text), app.integration_agent_lifecycle(), app.integration_runs_agent_guard()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.create_agent_connection(uuid, uuid, text, text, jsonb), app.set_agent_credential(uuid, jsonb, uuid),
  app.request_connection_job(uuid, text, jsonb, text), app.integration_agent_problems(uuid), app.integration_agent_config_problem(jsonb)
  TO authenticated;
