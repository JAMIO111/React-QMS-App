-- Connector agent AG6d hardening (docs/connector-agent-plan.md §19, security review): a stored password can only ever go where it was typed for.
--  * The store_credential job now carries the connection's settings. The agent keeps each password with a fingerprint of its target (engine,
--    server, port, instance, database, sign-in kind, API address and key header; ConnectionTarget in the agent) and refuses to send it to any other.
--  * Changing an agent connection's target clears its stored password here (it must be typed again, against the settings the person sees), and
--    a connection's engine never changes (a database password must never become an API's Basic sign-in).
--  * The agent side: Windows authentication only for servers on the agent's own allow-list ("servers"), and PostgreSQL never answers a request for
--    the password in clear.
-- Pushing the API before this migration breaks nothing: the agent then refuses passwords stored without a target and asks for them again.

-- The latest definition (20260311100000) plus the connection's settings in the job.
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
  VALUES (c.organisation_id, a.id, c.id, 'store_credential', jsonb_build_object('connectionId', c.id, 'keyId', v_key, 'connection', c.config, 'sealed', p_sealed), 3, auth.uid())
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

-- The settings that say where a password goes. Kept in step with ConnectionTarget in connector-agent/src/Fortress.Agent.Core/Credentials.cs.
CREATE FUNCTION app.integration_agent_target(p_config jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'engine', p_config -> 'engine', 'server', lower(p_config ->> 'server'), 'port', p_config -> 'port', 'instance', lower(p_config ->> 'instance'),
    'database', p_config -> 'database', 'authType', p_config -> 'authType', 'baseUrl', lower(p_config ->> 'baseUrl'), 'apiKeyHeader', p_config -> 'apiKeyHeader')
$$;

CREATE FUNCTION app.integration_agent_target_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.agent_id IS NULL OR OLD.config IS NOT DISTINCT FROM NEW.config THEN RETURN NEW; END IF;
  IF TG_WHEN = 'BEFORE' THEN
    IF (OLD.config ->> 'engine') IS DISTINCT FROM (NEW.config ->> 'engine') THEN
      RAISE EXCEPTION 'What an agent connection reads (database, folder or API) cannot change: make a new connection' USING ERRCODE = 'QM022';
    END IF;
    RETURN NEW;
  END IF;
  IF app.integration_agent_target(OLD.config) IS DISTINCT FROM app.integration_agent_target(NEW.config) THEN
    -- A password typed for the old target is never used for the new one: the agent refuses it too, this says so and asks for it again.
    UPDATE public.integration_agent_credentials
       SET status = 'cleared', message = 'The connection now points somewhere else: type the password again', updated_at = now()
     WHERE connection_id = NEW.id AND status <> 'cleared';
    UPDATE public.integration_agent_jobs SET status = 'cancelled', finished_at = clock_timestamp(), updated_at = clock_timestamp(), leased_until = NULL,
           error_kind = 'cancelled', error_message = 'The connection now points somewhere else'
     WHERE connection_id = NEW.id AND kind = 'store_credential' AND status IN ('pending', 'received', 'running');
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER integration_connections_agent_engine BEFORE UPDATE OF config ON public.integration_connections
  FOR EACH ROW EXECUTE FUNCTION app.integration_agent_target_rules();
CREATE TRIGGER integration_connections_agent_target AFTER UPDATE OF config ON public.integration_connections
  FOR EACH ROW EXECUTE FUNCTION app.integration_agent_target_rules();

REVOKE ALL ON FUNCTION app.integration_agent_target(jsonb), app.integration_agent_target_rules() FROM PUBLIC, anon, authenticated;
