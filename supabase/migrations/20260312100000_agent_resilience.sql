-- Connector agent AG6a (docs/connector-agent-plan.md §19): keys rotated on request and a bounded diagnostics bundle.
--  * An admin (integrations.manage, so a Controller seat) may ask an agent to rotate its keys now ('rotate_keys') or to send a diagnostics bundle
--    ('diagnostics', at most 64 kB, never passwords, keys, tokens or row contents). The agent also rotates its keys on its own every 90 days through
--    the existing keys/rotate route (AG1); nothing here changes that route.
--  * A diagnostics bundle is kept with its job for 30 days, then cleared by the worker's housekeeping (app.system_purge_agent_diagnostics).

ALTER TABLE public.integration_agent_jobs DROP CONSTRAINT integration_agent_jobs_kind_check;
ALTER TABLE public.integration_agent_jobs ADD CONSTRAINT integration_agent_jobs_kind_check
  CHECK (kind IN ('ping', 'store_credential', 'test_connection', 'discover', 'preview', 'extract', 'rotate_keys', 'diagnostics'));
-- Agent-level jobs (ping, rotate_keys, diagnostics) name no connection; every other job names one.
ALTER TABLE public.integration_agent_jobs DROP CONSTRAINT integration_agent_jobs_connection_needed;
ALTER TABLE public.integration_agent_jobs ADD CONSTRAINT integration_agent_jobs_connection_needed
  CHECK ((kind IN ('ping', 'rotate_keys', 'diagnostics')) = (connection_id IS NULL));

CREATE OR REPLACE FUNCTION app.request_agent_job(p_agent uuid, p_kind text, p_spec jsonb DEFAULT '{}'::jsonb, p_idempotency_key text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.integration_agents%ROWTYPE; v_id uuid;
BEGIN
  SELECT * INTO r FROM public.integration_agents WHERE id = p_agent;
  IF NOT FOUND OR NOT app.has_permission(r.organisation_id, 'integrations.read') THEN RAISE EXCEPTION 'Agent not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_agent_manager(r.organisation_id);
  IF r.status <> 'active' THEN RAISE EXCEPTION 'This agent has been revoked' USING ERRCODE = 'QM022'; END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('ping', 'rotate_keys', 'diagnostics') THEN
    RAISE EXCEPTION 'An agent can be pinged, asked to rotate its keys or asked for diagnostics' USING ERRCODE = 'QM022';
  END IF;
  -- One rotation at a time: a second request while one waits returns the one waiting.
  IF p_kind = 'rotate_keys' THEN
    SELECT id INTO v_id FROM public.integration_agent_jobs WHERE agent_id = r.id AND kind = 'rotate_keys' AND status IN ('pending', 'received', 'running');
    IF FOUND THEN RETURN v_id; END IF;
  END IF;
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_id FROM public.integration_agent_jobs WHERE organisation_id = r.organisation_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN RETURN v_id; END IF;
  END IF;
  INSERT INTO public.integration_agent_jobs (organisation_id, agent_id, kind, spec, max_attempts, idempotency_key, requested_by)
  VALUES (r.organisation_id, r.id, p_kind, '{}'::jsonb, 1, p_idempotency_key, auth.uid())
  RETURNING id INTO v_id;
  -- Someone is waiting for an answer: ask the agent to poll quickly for the next ten minutes.
  UPDATE public.integration_agents SET fast_poll_until = now() + interval '10 minutes' WHERE id = r.id;
  RETURN v_id;
END $$;

-- Housekeeping (API login only): diagnostics bundles older than 30 days are cleared; the job and its outcome stay. Returns how many were cleared.
CREATE FUNCTION app.system_purge_agent_diagnostics() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_count integer;
BEGIN
  UPDATE public.integration_agent_jobs SET result = jsonb_build_object('cleared', true, 'clearedAt', now())
   WHERE kind = 'diagnostics' AND finished_at < now() - interval '30 days' AND result IS NOT NULL AND NOT (result ? 'cleared');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION app.system_purge_agent_diagnostics() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.system_purge_agent_diagnostics() TO qms_api;
