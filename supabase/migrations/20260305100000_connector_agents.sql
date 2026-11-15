-- Fortress Connector Agent, slice AG1 (docs/connector-agent-plan.md, decisions AG-D1–AG-D12): agents, their registration and identity, and the
-- work queue between Fortress and an agent. No database connections yet (AG2), so the only job an agent can be given is a "ping".
--
--  * integration_agent_registrations: a one-time token (only its SHA-256 is stored) that an administrator makes in Settings → Integrations and
--    types into the installer. Single use, expires (1 hour to 7 days, default 24 hours), cancellable. A registration may name an existing agent
--    to replace its key (reinstalling on a new machine keeps the agent's history and, later, its connections).
--  * integration_agents: one row per installed agent. Status active | revoked; online / offline is worked out from last_heartbeat_at, never stored.
--    Renamed, never deleted. Revoking is final (a new agent is registered instead): its keys stop working at once and its waiting jobs are cancelled.
--  * integration_agent_keys: the agent's public keys (ECDSA P-256 for signing requests, ECDH P-256 for credentials sealed to it in AG2), as
--    SPKI base64. One active key per agent; rotation retires the old one. The private halves never leave the agent.
--  * integration_agent_nonces: request nonces seen in the last minutes, so a signed request cannot be replayed (purged by the worker).
--  * integration_agent_events: append-only lifecycle log (registered, replaced, key rotated, came online, version changed, renamed, revoked,
--    deregistered, job failed). Bounded details, never secrets or row contents.
--  * integration_agent_jobs: the queue. Kind ping in AG1 (test_connection / discover / preview / extract are allowed by the table for AG2–AG3).
--    pending -> received (leased) -> running -> completed | failed, or cancelled. A lease that runs out puts the job back for another attempt.
--
-- No table writes for people: everything is a SECURITY DEFINER function. People's functions need integrations.manage (and so a Controller seat)
-- or integrations.read. The agent's own requests reach the database only through app.system_agent_* functions, executable by the API login alone,
-- after the API has checked the request's signature; each takes the agent id and checks the agent's status itself.
-- Errors use QM022 (409 integration_rule); another organisation's id is P0002 (404).

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE public.integration_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  location text CHECK (location IS NULL OR length(location) <= 200),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  agent_version text CHECK (agent_version IS NULL OR length(agent_version) <= 40),
  operating_system text CHECK (operating_system IS NULL OR length(operating_system) <= 120),
  machine_name text CHECK (machine_name IS NULL OR length(machine_name) <= 120),
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(capabilities) = 'object' AND pg_column_size(capabilities) <= 4096),
  last_heartbeat_at timestamptz,
  last_address text CHECK (last_address IS NULL OR length(last_address) <= 45),
  fast_poll_until timestamptz,
  registered_at timestamptz NOT NULL DEFAULT now(),
  registered_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  revoked_reason text CHECK (revoked_reason IS NULL OR length(btrim(revoked_reason)) BETWEEN 3 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  UNIQUE (id, organisation_id),
  CONSTRAINT integration_agents_revoked_check CHECK ((status = 'revoked') = (revoked_at IS NOT NULL) AND (revoked_at IS NULL) = (revoked_reason IS NULL))
);
CREATE UNIQUE INDEX integration_agents_name_key ON public.integration_agents (organisation_id, lower(btrim(name))) WHERE status = 'active';
CREATE INDEX integration_agents_org_idx ON public.integration_agents (organisation_id, status);

CREATE TABLE public.integration_agent_registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  location text CHECK (location IS NULL OR length(location) <= 200),
  replaces_agent_id uuid,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  agent_id uuid,
  cancelled_at timestamptz,
  cancelled_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  FOREIGN KEY (replaces_agent_id, organisation_id) REFERENCES public.integration_agents (id, organisation_id),
  FOREIGN KEY (agent_id, organisation_id) REFERENCES public.integration_agents (id, organisation_id),
  CONSTRAINT integration_agent_registrations_used_check CHECK ((used_at IS NULL) = (agent_id IS NULL) AND NOT (used_at IS NOT NULL AND cancelled_at IS NOT NULL))
);
CREATE INDEX integration_agent_registrations_org_idx ON public.integration_agent_registrations (organisation_id, created_at DESC);

CREATE TABLE public.integration_agent_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  signing_key text NOT NULL CHECK (signing_key ~ '^[A-Za-z0-9+/=]+$' AND length(signing_key) BETWEEN 40 AND 400),
  sealing_key text NOT NULL CHECK (sealing_key ~ '^[A-Za-z0-9+/=]+$' AND length(sealing_key) BETWEEN 40 AND 400),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  FOREIGN KEY (agent_id, organisation_id) REFERENCES public.integration_agents (id, organisation_id)
);
CREATE UNIQUE INDEX integration_agent_keys_active_key ON public.integration_agent_keys (agent_id) WHERE status = 'active';
CREATE INDEX integration_agent_keys_agent_idx ON public.integration_agent_keys (agent_id, created_at DESC);

CREATE TABLE public.integration_agent_nonces (
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  nonce text NOT NULL CHECK (nonce ~ '^[0-9a-f]{32,64}$'),
  seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, nonce),
  FOREIGN KEY (agent_id, organisation_id) REFERENCES public.integration_agents (id, organisation_id)
);
CREATE INDEX integration_agent_nonces_seen_idx ON public.integration_agent_nonces (seen_at);

CREATE TABLE public.integration_agent_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('registered', 'replaced', 'key_rotated', 'came_online', 'version_changed', 'renamed', 'revoked',
                                     'deregistered', 'job_failed')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object' AND pg_column_size(detail) <= 4096),
  actor_user_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (agent_id, organisation_id) REFERENCES public.integration_agents (id, organisation_id)
);
CREATE INDEX integration_agent_events_agent_idx ON public.integration_agent_events (agent_id, created_at DESC);

CREATE TABLE public.integration_agent_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('ping', 'test_connection', 'discover', 'preview', 'extract')),
  spec jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(spec) = 'object' AND pg_column_size(spec) <= 51200),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'received', 'running', 'completed', 'failed', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  leased_until timestamptz,
  received_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  progress jsonb CHECK (progress IS NULL OR (jsonb_typeof(progress) = 'object' AND pg_column_size(progress) <= 4096)),
  result jsonb CHECK (result IS NULL OR pg_column_size(result) <= 204800),
  error_kind text CHECK (error_kind IS NULL OR error_kind IN ('auth', 'network', 'timeout', 'not_found', 'refused', 'invalid', 'internal', 'lease_expired', 'cancelled')),
  error_message text CHECK (error_message IS NULL OR length(error_message) <= 1000),
  idempotency_key text CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 8 AND 120),
  requested_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (agent_id, organisation_id) REFERENCES public.integration_agents (id, organisation_id)
);
CREATE UNIQUE INDEX integration_agent_jobs_idem_key ON public.integration_agent_jobs (organisation_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX integration_agent_jobs_queue_idx ON public.integration_agent_jobs (agent_id, created_at) WHERE status IN ('pending', 'received', 'running');
CREATE INDEX integration_agent_jobs_agent_idx ON public.integration_agent_jobs (agent_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Table rules: never deleted; events frozen; the organisation never moves
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.integration_agent_never_deleted() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'Connector agent records are never deleted' USING ERRCODE = 'QM022';
END $$;
CREATE FUNCTION app.integration_agent_event_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'Agent events are never changed' USING ERRCODE = 'QM022';
END $$;

CREATE TRIGGER integration_agents_no_delete BEFORE DELETE ON public.integration_agents FOR EACH ROW EXECUTE FUNCTION app.integration_agent_never_deleted();
CREATE TRIGGER integration_agent_registrations_no_delete BEFORE DELETE ON public.integration_agent_registrations FOR EACH ROW EXECUTE FUNCTION app.integration_agent_never_deleted();
CREATE TRIGGER integration_agent_keys_no_delete BEFORE DELETE ON public.integration_agent_keys FOR EACH ROW EXECUTE FUNCTION app.integration_agent_never_deleted();
CREATE TRIGGER integration_agent_jobs_no_delete BEFORE DELETE ON public.integration_agent_jobs FOR EACH ROW EXECUTE FUNCTION app.integration_agent_never_deleted();
CREATE TRIGGER integration_agent_events_frozen BEFORE UPDATE OR DELETE ON public.integration_agent_events FOR EACH ROW EXECUTE FUNCTION app.integration_agent_event_frozen();
CREATE TRIGGER integration_agents_touch BEFORE UPDATE ON public.integration_agents FOR EACH ROW EXECUTE FUNCTION app.touch_updated();

CREATE TRIGGER integration_agents_org_immutable BEFORE UPDATE ON public.integration_agents FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER integration_agent_registrations_org_immutable BEFORE UPDATE ON public.integration_agent_registrations FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER integration_agent_keys_org_immutable BEFORE UPDATE ON public.integration_agent_keys FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER integration_agent_nonces_org_immutable BEFORE UPDATE ON public.integration_agent_nonces FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER integration_agent_jobs_org_immutable BEFORE UPDATE ON public.integration_agent_jobs FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();

-- Audited: the agents themselves (registration, rename, revocation, key changes are visible through them and the events), registrations and keys.
-- Not audited: heartbeats would flood it, so last_heartbeat_at / last_address / fast_poll_until changes are skipped by the trigger's own rule below;
-- nonces and jobs are operational logs, and events are themselves a log.
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OF name, location, status, revoked_at, revoked_reason OR DELETE ON public.integration_agents
  FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.integration_agent_registrations
  FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.integration_agent_keys
  FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');

ALTER TABLE public.integration_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_agent_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_agent_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_agent_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_agent_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_agent_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.integration_agents, public.integration_agent_registrations, public.integration_agent_keys, public.integration_agent_nonces,
  public.integration_agent_events, public.integration_agent_jobs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.integration_agents, public.integration_agent_registrations, public.integration_agent_keys,
  public.integration_agent_nonces, public.integration_agent_events, public.integration_agent_jobs TO authenticated;
CREATE POLICY integration_agents_select ON public.integration_agents FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'integrations.read'));
CREATE POLICY integration_agent_registrations_select ON public.integration_agent_registrations FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'integrations.read'));
CREATE POLICY integration_agent_keys_select ON public.integration_agent_keys FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'integrations.read'));
-- Nonces: nobody reads them but the API login. SELECT is granted like every tenant table (a person gets no rows); the policy never matches.
CREATE POLICY integration_agent_nonces_select ON public.integration_agent_nonces FOR SELECT TO authenticated USING (false);
CREATE POLICY integration_agent_events_select ON public.integration_agent_events FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'integrations.read'));
CREATE POLICY integration_agent_jobs_select ON public.integration_agent_jobs FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'integrations.read'));

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.agent_event(p_agent uuid, p_kind text, p_detail jsonb DEFAULT '{}'::jsonb) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO public.integration_agent_events (organisation_id, agent_id, kind, detail, actor_user_id)
  SELECT a.organisation_id, a.id, p_kind, coalesce(p_detail, '{}'::jsonb), auth.uid() FROM public.integration_agents a WHERE a.id = p_agent;
$$;

-- The network rule for a caller who is not a person (the agent): the same answer as app.network_allowed, without the membership check.
CREATE FUNCTION app.network_state(p_organisation_id uuid, p_address inet) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_policy text;
BEGIN
  SELECT s.network_policy INTO v_policy FROM public.organisation_settings s WHERE s.organisation_id = p_organisation_id;
  v_policy := coalesce(v_policy, 'off');
  IF v_policy = 'off' THEN RETURN 'open'; END IF;
  p_address := app.plain_address(p_address);
  IF p_address IS NOT NULL AND EXISTS (SELECT 1 FROM public.organisation_networks n
      WHERE n.organisation_id = p_organisation_id AND n.active AND n.removed_at IS NULL AND p_address <<= n.network) THEN
    RETURN 'allowed';
  END IF;
  RETURN CASE v_policy WHEN 'monitor' THEN 'monitored' ELSE 'denied' END;
END $$;

CREATE FUNCTION app.assert_agent_manager(p_organisation_id uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT app.has_permission(p_organisation_id, 'integrations.manage') THEN
    RAISE EXCEPTION 'Managing connector agents needs the integrations manage permission (a Controller seat)' USING ERRCODE = '42501';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- People's functions
-- ---------------------------------------------------------------------------
-- A one-time registration. The API makes the token and passes only its SHA-256; the token is shown once and never stored.
CREATE FUNCTION app.create_agent_registration(p_organisation_id uuid, p_token_hash text, p_name text, p_location text DEFAULT NULL,
  p_expires_hours integer DEFAULT 24, p_replaces uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid; v_name text := btrim(coalesce(p_name, '')); r public.integration_agents%ROWTYPE;
BEGIN
  PERFORM app.assert_agent_manager(p_organisation_id);
  IF p_expires_hours IS NULL OR p_expires_hours NOT BETWEEN 1 AND 168 THEN
    RAISE EXCEPTION 'A registration lasts between 1 hour and 7 days' USING ERRCODE = 'QM022';
  END IF;
  IF p_replaces IS NOT NULL THEN
    SELECT * INTO r FROM public.integration_agents WHERE id = p_replaces AND organisation_id = p_organisation_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Agent not found' USING ERRCODE = 'P0002'; END IF;
    IF r.status = 'revoked' THEN RAISE EXCEPTION 'A revoked agent cannot be replaced; register a new one' USING ERRCODE = 'QM022'; END IF;
    IF v_name = '' THEN v_name := r.name; END IF;
  ELSE
    IF v_name = '' THEN RAISE EXCEPTION 'Give the agent a name, for example the site or server it runs on' USING ERRCODE = 'QM022'; END IF;
    IF EXISTS (SELECT 1 FROM public.integration_agents a WHERE a.organisation_id = p_organisation_id AND a.status = 'active'
               AND lower(btrim(a.name)) = lower(v_name)) THEN
      RAISE EXCEPTION 'An agent called "%" already exists', v_name USING ERRCODE = 'QM022';
    END IF;
  END IF;
  INSERT INTO public.integration_agent_registrations (organisation_id, token_hash, name, location, replaces_agent_id, expires_at)
  VALUES (p_organisation_id, p_token_hash, v_name, nullif(btrim(coalesce(p_location, '')), ''), p_replaces, now() + make_interval(hours => p_expires_hours))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION app.cancel_agent_registration(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.integration_agent_registrations%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.integration_agent_registrations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT app.has_permission(r.organisation_id, 'integrations.read') THEN RAISE EXCEPTION 'Registration not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_agent_manager(r.organisation_id);
  IF r.used_at IS NOT NULL THEN RAISE EXCEPTION 'This registration has already been used' USING ERRCODE = 'QM022'; END IF;
  IF r.cancelled_at IS NOT NULL THEN RETURN; END IF;
  UPDATE public.integration_agent_registrations SET cancelled_at = now(), cancelled_by = auth.uid() WHERE id = p_id;
END $$;

CREATE FUNCTION app.rename_agent(p_id uuid, p_name text, p_location text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.integration_agents%ROWTYPE; v_name text := btrim(coalesce(p_name, ''));
BEGIN
  SELECT * INTO r FROM public.integration_agents WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT app.has_permission(r.organisation_id, 'integrations.read') THEN RAISE EXCEPTION 'Agent not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_agent_manager(r.organisation_id);
  IF v_name = '' THEN RAISE EXCEPTION 'Give the agent a name' USING ERRCODE = 'QM022'; END IF;
  IF r.status = 'active' AND EXISTS (SELECT 1 FROM public.integration_agents a WHERE a.organisation_id = r.organisation_id AND a.id <> r.id
     AND a.status = 'active' AND lower(btrim(a.name)) = lower(v_name)) THEN
    RAISE EXCEPTION 'An agent called "%" already exists', v_name USING ERRCODE = 'QM022';
  END IF;
  IF r.name IS DISTINCT FROM v_name OR r.location IS DISTINCT FROM nullif(btrim(coalesce(p_location, '')), '') THEN
    UPDATE public.integration_agents SET name = v_name, location = nullif(btrim(coalesce(p_location, '')), ''), updated_by = auth.uid() WHERE id = p_id;
    IF r.name IS DISTINCT FROM v_name THEN PERFORM app.agent_event(p_id, 'renamed', jsonb_build_object('from', r.name, 'to', v_name)); END IF;
  END IF;
END $$;

-- Revoking is final: keys stop working on the next request, waiting and running jobs are cancelled.
CREATE FUNCTION app.revoke_agent(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.integration_agents%ROWTYPE; v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  SELECT * INTO r FROM public.integration_agents WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT app.has_permission(r.organisation_id, 'integrations.read') THEN RAISE EXCEPTION 'Agent not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_agent_manager(r.organisation_id);
  IF r.status = 'revoked' THEN RETURN; END IF;
  IF length(v_reason) < 3 OR length(v_reason) > 500 THEN RAISE EXCEPTION 'Say why the agent is being revoked (3 to 500 characters)' USING ERRCODE = 'QM022'; END IF;
  UPDATE public.integration_agents SET status = 'revoked', revoked_at = now(), revoked_by = auth.uid(), revoked_reason = v_reason, updated_by = auth.uid()
   WHERE id = p_id;
  UPDATE public.integration_agent_keys SET status = 'revoked', retired_at = coalesce(retired_at, now()) WHERE agent_id = p_id AND status = 'active';
  UPDATE public.integration_agent_jobs SET status = 'cancelled', finished_at = clock_timestamp(), updated_at = clock_timestamp(), leased_until = NULL,
         error_kind = 'cancelled', error_message = 'The agent was revoked'
   WHERE agent_id = p_id AND status IN ('pending', 'received', 'running');
  UPDATE public.integration_agent_registrations SET cancelled_at = now(), cancelled_by = auth.uid()
   WHERE replaces_agent_id = p_id AND used_at IS NULL AND cancelled_at IS NULL;
  PERFORM app.agent_event(p_id, 'revoked', jsonb_build_object('reason', v_reason));
END $$;

-- Give an agent a job. AG1 offers only "ping" (the agent answers with its version and clock); later slices add the other kinds.
CREATE FUNCTION app.request_agent_job(p_agent uuid, p_kind text, p_spec jsonb DEFAULT '{}'::jsonb, p_idempotency_key text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.integration_agents%ROWTYPE; v_id uuid;
BEGIN
  SELECT * INTO r FROM public.integration_agents WHERE id = p_agent;
  IF NOT FOUND OR NOT app.has_permission(r.organisation_id, 'integrations.read') THEN RAISE EXCEPTION 'Agent not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_agent_manager(r.organisation_id);
  IF r.status <> 'active' THEN RAISE EXCEPTION 'This agent has been revoked' USING ERRCODE = 'QM022'; END IF;
  IF p_kind IS DISTINCT FROM 'ping' THEN RAISE EXCEPTION 'Only a ping can be sent to an agent for now' USING ERRCODE = 'QM022'; END IF;
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_id FROM public.integration_agent_jobs WHERE organisation_id = r.organisation_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN RETURN v_id; END IF;
  END IF;
  INSERT INTO public.integration_agent_jobs (organisation_id, agent_id, kind, spec, max_attempts, idempotency_key, requested_by)
  VALUES (r.organisation_id, r.id, p_kind, coalesce(p_spec, '{}'::jsonb), 1, p_idempotency_key, auth.uid())
  RETURNING id INTO v_id;
  -- Someone is waiting for an answer: ask the agent to poll quickly for the next ten minutes.
  UPDATE public.integration_agents SET fast_poll_until = now() + interval '10 minutes' WHERE id = r.id;
  RETURN v_id;
END $$;

-- A person has the agent's page open: ask it to poll quickly for ten minutes so actions answer within seconds.
CREATE FUNCTION app.wake_agent(p_agent uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.integration_agents%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.integration_agents WHERE id = p_agent;
  IF NOT FOUND OR NOT app.has_permission(r.organisation_id, 'integrations.read') THEN RAISE EXCEPTION 'Agent not found' USING ERRCODE = 'P0002'; END IF;
  IF r.status = 'active' THEN UPDATE public.integration_agents SET fast_poll_until = now() + interval '10 minutes' WHERE id = r.id; END IF;
END $$;

-- ---------------------------------------------------------------------------
-- System functions (the API login only, after it has verified the request's signature)
-- ---------------------------------------------------------------------------
-- What the API needs to verify a signed request: the agent's organisation, status and active signing key. NULL when the agent is unknown.
CREATE FUNCTION app.system_agent_identity(p_agent uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object('organisationId', a.organisation_id, 'status', a.status, 'signingKey', k.signing_key, 'keyId', k.id)
    FROM public.integration_agents a
    LEFT JOIN public.integration_agent_keys k ON k.agent_id = a.id AND k.status = 'active'
   WHERE a.id = p_agent;
$$;

-- After the signature checks out: refuse a replayed nonce and apply the organisation's network rule.
-- Returns { ok, reason?, network } where reason is replay | revoked | network.
CREATE FUNCTION app.system_agent_seen(p_agent uuid, p_nonce text, p_address text, p_path text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.integration_agents%ROWTYPE; v_inet inet; v_state text; v_rows integer;
BEGIN
  SELECT * INTO r FROM public.integration_agents WHERE id = p_agent;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'unknown'); END IF;
  IF r.status <> 'active' THEN RETURN jsonb_build_object('ok', false, 'reason', 'revoked'); END IF;
  INSERT INTO public.integration_agent_nonces (organisation_id, agent_id, nonce) VALUES (r.organisation_id, r.id, lower(p_nonce))
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN RETURN jsonb_build_object('ok', false, 'reason', 'replay'); END IF;
  BEGIN v_inet := nullif(btrim(coalesce(p_address, '')), '')::inet; EXCEPTION WHEN others THEN v_inet := NULL; END;
  v_state := app.network_state(r.organisation_id, v_inet);
  IF v_state IN ('monitored', 'denied') THEN
    PERFORM app.system_record_access_denial(r.organisation_id, NULL, p_address, CASE v_state WHEN 'denied' THEN 'enforce' ELSE 'monitor' END, p_path);
  END IF;
  IF v_state = 'denied' THEN RETURN jsonb_build_object('ok', false, 'reason', 'network', 'network', v_state); END IF;
  RETURN jsonb_build_object('ok', true, 'network', v_state);
END $$;

-- Registration: the token's hash must match an unused, unexpired, uncancelled registration. A new agent is made, or the replaced agent gets
-- the new key (its old keys retired). The API has already checked that the request is signed with the private half of p_signing_key.
CREATE FUNCTION app.system_register_agent(p_token_hash text, p_signing_key text, p_sealing_key text, p_version text, p_os text,
  p_machine text, p_capabilities jsonb, p_address text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE g public.integration_agent_registrations%ROWTYPE; v_agent uuid; v_org_name text; v_inet inet;
BEGIN
  SELECT * INTO g FROM public.integration_agent_registrations WHERE token_hash = lower(p_token_hash) FOR UPDATE;
  IF NOT FOUND OR g.cancelled_at IS NOT NULL OR g.used_at IS NOT NULL OR g.expires_at <= now() THEN
    RAISE EXCEPTION 'This registration token is not valid. It may have been used, cancelled or expired; make a new one in Fortress.' USING ERRCODE = 'QM022';
  END IF;
  BEGIN v_inet := nullif(btrim(coalesce(p_address, '')), '')::inet; EXCEPTION WHEN others THEN v_inet := NULL; END;
  IF app.network_state(g.organisation_id, v_inet) = 'denied' THEN
    PERFORM app.system_record_access_denial(g.organisation_id, NULL, p_address, 'enforce', '/integrations/agent/register');
    RAISE EXCEPTION 'This organisation does not allow access from this network' USING ERRCODE = 'QM022';
  END IF;
  IF g.replaces_agent_id IS NOT NULL THEN
    v_agent := g.replaces_agent_id;
    IF (SELECT status FROM public.integration_agents WHERE id = v_agent) <> 'active' THEN
      RAISE EXCEPTION 'The agent this registration replaces has been revoked' USING ERRCODE = 'QM022';
    END IF;
    UPDATE public.integration_agent_keys SET status = 'retired', retired_at = now() WHERE agent_id = v_agent AND status = 'active';
    UPDATE public.integration_agents SET agent_version = left(p_version, 40), operating_system = left(p_os, 120), machine_name = left(p_machine, 120),
           capabilities = coalesce(p_capabilities, '{}'::jsonb), last_heartbeat_at = now(), last_address = left(p_address, 45)
     WHERE id = v_agent;
  ELSE
    INSERT INTO public.integration_agents (organisation_id, name, location, agent_version, operating_system, machine_name, capabilities,
                                           last_heartbeat_at, last_address, registered_by)
    VALUES (g.organisation_id, g.name, g.location, left(p_version, 40), left(p_os, 120), left(p_machine, 120), coalesce(p_capabilities, '{}'::jsonb),
            now(), left(p_address, 45), g.created_by)
    RETURNING id INTO v_agent;
  END IF;
  INSERT INTO public.integration_agent_keys (organisation_id, agent_id, signing_key, sealing_key) VALUES (g.organisation_id, v_agent, p_signing_key, p_sealing_key);
  UPDATE public.integration_agent_registrations SET used_at = now(), agent_id = v_agent WHERE id = g.id;
  INSERT INTO public.integration_agent_events (organisation_id, agent_id, kind, detail, actor_user_id)
  VALUES (g.organisation_id, v_agent, CASE WHEN g.replaces_agent_id IS NULL THEN 'registered' ELSE 'replaced' END,
          jsonb_build_object('version', left(p_version, 40), 'machine', left(p_machine, 120)), g.created_by);
  SELECT name INTO v_org_name FROM public.organisations WHERE id = g.organisation_id;
  RETURN jsonb_build_object('agentId', v_agent, 'organisationId', g.organisation_id, 'organisationName', v_org_name,
                            'name', (SELECT name FROM public.integration_agents WHERE id = v_agent));
END $$;

-- A heartbeat: who the agent says it is now, and whether there is work for it.
CREATE FUNCTION app.system_agent_heartbeat(p_agent uuid, p_version text, p_os text, p_machine text, p_capabilities jsonb, p_address text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.integration_agents%ROWTYPE; v_waiting boolean;
BEGIN
  SELECT * INTO r FROM public.integration_agents WHERE id = p_agent FOR UPDATE;
  IF NOT FOUND OR r.status <> 'active' THEN RETURN jsonb_build_object('revoked', true); END IF;
  IF r.last_heartbeat_at IS NULL OR r.last_heartbeat_at < now() - interval '3 minutes' THEN
    PERFORM app.agent_event(r.id, 'came_online', jsonb_build_object('away', CASE WHEN r.last_heartbeat_at IS NULL THEN NULL
                                                                         ELSE extract(epoch FROM now() - r.last_heartbeat_at)::int END));
  END IF;
  IF p_version IS NOT NULL AND r.agent_version IS DISTINCT FROM left(p_version, 40) THEN
    PERFORM app.agent_event(r.id, 'version_changed', jsonb_build_object('from', r.agent_version, 'to', left(p_version, 40)));
  END IF;
  UPDATE public.integration_agents
     SET last_heartbeat_at = now(), last_address = left(p_address, 45),
         agent_version = coalesce(left(p_version, 40), agent_version), operating_system = coalesce(left(p_os, 120), operating_system),
         machine_name = coalesce(left(p_machine, 120), machine_name), capabilities = coalesce(p_capabilities, capabilities)
   WHERE id = r.id;
  v_waiting := EXISTS (SELECT 1 FROM public.integration_agent_jobs j WHERE j.agent_id = r.id
                         AND (j.status = 'pending' OR (j.status IN ('received', 'running') AND j.leased_until < now())));
  RETURN jsonb_build_object('revoked', false, 'jobsWaiting', v_waiting,
                            'fastPollUntil', CASE WHEN r.fast_poll_until > now() THEN r.fast_poll_until END);
END $$;

-- The next job for this agent, leased to it. A job whose lease ran out is taken again while attempts remain, else failed.
CREATE FUNCTION app.system_agent_next_job(p_agent uuid, p_lease_seconds integer DEFAULT 300) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.integration_agents%ROWTYPE; j public.integration_agent_jobs%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.integration_agents WHERE id = p_agent;
  IF NOT FOUND OR r.status <> 'active' THEN RETURN NULL; END IF;
  -- Leases that ran out with no attempts left: failed.
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
  RETURN jsonb_build_object('id', j.id, 'kind', j.kind, 'spec', j.spec, 'attempt', j.attempts, 'leasedUntil', j.leased_until);
END $$;

-- What the agent reports about a job it holds: ack (started), progress (also extends the lease), complete, fail.
-- Repeating a report that already took effect is accepted and changes nothing (a retried request).
CREATE FUNCTION app.system_agent_job_report(p_agent uuid, p_job uuid, p_action text, p_payload jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE j public.integration_agent_jobs%ROWTYPE; v_transient boolean; v_kind text; v_message text;
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
    UPDATE public.integration_agent_jobs
       SET status = 'completed', started_at = coalesce(started_at, clock_timestamp()), finished_at = clock_timestamp(), updated_at = clock_timestamp(),
           leased_until = NULL, result = p_payload -> 'result', error_kind = NULL, error_message = NULL
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

-- Key rotation: the request was signed with the current key; the new pair replaces it.
CREATE FUNCTION app.system_agent_rotate_key(p_agent uuid, p_signing_key text, p_sealing_key text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.integration_agents%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.integration_agents WHERE id = p_agent FOR UPDATE;
  IF NOT FOUND OR r.status <> 'active' THEN RAISE EXCEPTION 'This agent has been revoked' USING ERRCODE = 'QM022'; END IF;
  UPDATE public.integration_agent_keys SET status = 'retired', retired_at = now() WHERE agent_id = p_agent AND status = 'active';
  INSERT INTO public.integration_agent_keys (organisation_id, agent_id, signing_key, sealing_key) VALUES (r.organisation_id, r.id, p_signing_key, p_sealing_key);
  PERFORM app.agent_event(p_agent, 'key_rotated', '{}'::jsonb);
END $$;

-- The agent is being uninstalled: it revokes itself.
CREATE FUNCTION app.system_agent_deregister(p_agent uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.integration_agents%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.integration_agents WHERE id = p_agent FOR UPDATE;
  IF NOT FOUND OR r.status <> 'active' THEN RETURN; END IF;
  UPDATE public.integration_agents SET status = 'revoked', revoked_at = now(), revoked_reason = 'Uninstalled on the agent''s machine' WHERE id = p_agent;
  UPDATE public.integration_agent_keys SET status = 'revoked', retired_at = coalesce(retired_at, now()) WHERE agent_id = p_agent AND status = 'active';
  UPDATE public.integration_agent_jobs SET status = 'cancelled', finished_at = clock_timestamp(), updated_at = clock_timestamp(), leased_until = NULL,
         error_kind = 'cancelled', error_message = 'The agent was uninstalled'
   WHERE agent_id = p_agent AND status IN ('pending', 'received', 'running');
  PERFORM app.agent_event(p_agent, 'deregistered', '{}'::jsonb);
END $$;

-- Housekeeping: nonces older than ten minutes (requests over five minutes old are refused anyway). Returns how many were cleared.
CREATE FUNCTION app.system_purge_agent_nonces() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_count integer;
BEGIN
  DELETE FROM public.integration_agent_nonces WHERE seen_at < now() - interval '10 minutes';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION app.integration_agent_never_deleted(), app.integration_agent_event_frozen(), app.agent_event(uuid, text, jsonb),
  app.network_state(uuid, inet), app.assert_agent_manager(uuid),
  app.create_agent_registration(uuid, text, text, text, integer, uuid), app.cancel_agent_registration(uuid), app.rename_agent(uuid, text, text),
  app.revoke_agent(uuid, text), app.request_agent_job(uuid, text, jsonb, text), app.wake_agent(uuid),
  app.system_agent_identity(uuid), app.system_agent_seen(uuid, text, text, text),
  app.system_register_agent(text, text, text, text, text, text, jsonb, text), app.system_agent_heartbeat(uuid, text, text, text, jsonb, text),
  app.system_agent_next_job(uuid, integer), app.system_agent_job_report(uuid, uuid, text, jsonb), app.system_agent_rotate_key(uuid, text, text),
  app.system_agent_deregister(uuid), app.system_purge_agent_nonces()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.create_agent_registration(uuid, text, text, text, integer, uuid), app.cancel_agent_registration(uuid),
  app.rename_agent(uuid, text, text), app.revoke_agent(uuid, text), app.request_agent_job(uuid, text, jsonb, text), app.wake_agent(uuid)
  TO authenticated;
GRANT EXECUTE ON FUNCTION app.system_agent_identity(uuid), app.system_agent_seen(uuid, text, text, text),
  app.system_register_agent(text, text, text, text, text, text, jsonb, text), app.system_agent_heartbeat(uuid, text, text, text, jsonb, text),
  app.system_agent_next_job(uuid, integer), app.system_agent_job_report(uuid, uuid, text, jsonb), app.system_agent_rotate_key(uuid, text, text),
  app.system_agent_deregister(uuid), app.system_purge_agent_nonces()
  TO qms_api;

-- The SQL agent provider is now on its way: still not offered for connections until AG2.
UPDATE public.integration_providers
   SET description = 'A service you install in your network that connects outwards to Fortress and reads only what you approve. Agents are managed in Settings → Integrations → Connector agents; database connections arrive next.'
 WHERE key = 'sql_agent';
