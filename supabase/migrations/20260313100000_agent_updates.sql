-- Connector agent AG6b (docs/connector-agent-plan.md §19, AG6-D3): signed releases and administrator-approved updates.
--
--  * integration_agent_releases: the agent releases a platform operator (with MFA) has published. Global (no organisation): every agent of every
--    customer may be offered the same release. Each keeps the manifest text exactly as it was signed and its signature; the API checks the signature
--    before publishing, and the agent checks it again before installing (that check is the one that matters: the agent trusts only the release keys
--    built into it). Withdrawn with a reason, never deleted; readable by every signed-in person while published.
--  * integration_agent_updates: an update of one agent to one release, approved by an integrations.manage holder (so a Controller seat). One open
--    (waiting or staged) per agent. waiting -> staged (the agent downloaded, checked and unpacked it) -> applied (the agent came back at the new
--    version), or failed / rolled_back (the new version did not come up and the old one was put back) / cancelled (only while waiting). Audited.
--  * Approving makes an 'update_agent' job carrying the manifest and signature (agent-level, like ping).
-- Errors use QM022 (409 integration_rule); another organisation's id is P0002 (404).

-- ---------------------------------------------------------------------------
-- Jobs and events
-- ---------------------------------------------------------------------------
ALTER TABLE public.integration_agent_jobs DROP CONSTRAINT integration_agent_jobs_kind_check;
ALTER TABLE public.integration_agent_jobs ADD CONSTRAINT integration_agent_jobs_kind_check
  CHECK (kind IN ('ping', 'store_credential', 'test_connection', 'discover', 'preview', 'extract', 'rotate_keys', 'diagnostics', 'update_agent'));
ALTER TABLE public.integration_agent_jobs DROP CONSTRAINT integration_agent_jobs_connection_needed;
ALTER TABLE public.integration_agent_jobs ADD CONSTRAINT integration_agent_jobs_connection_needed
  CHECK ((kind IN ('ping', 'rotate_keys', 'diagnostics', 'update_agent')) = (connection_id IS NULL));

ALTER TABLE public.integration_agent_events DROP CONSTRAINT integration_agent_events_kind_check;
ALTER TABLE public.integration_agent_events ADD CONSTRAINT integration_agent_events_kind_check
  CHECK (kind IN ('registered', 'replaced', 'key_rotated', 'came_online', 'version_changed', 'renamed', 'revoked', 'deregistered', 'job_failed',
                  'update_approved', 'update_staged', 'update_applied', 'update_failed', 'update_rolled_back', 'update_cancelled'));

-- ---------------------------------------------------------------------------
-- Versions
-- ---------------------------------------------------------------------------
-- "1.10.2" -> {1,10,2}; NULL when it is not three whole numbers.
CREATE FUNCTION app.agent_version_parts(p_version text) RETURNS integer[]
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN p_version ~ '^\d{1,6}\.\d{1,6}\.\d{1,6}$'
              THEN string_to_array(p_version, '.')::integer[] END;
$$;

-- ---------------------------------------------------------------------------
-- Releases (global)
-- ---------------------------------------------------------------------------
CREATE TABLE public.integration_agent_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version text NOT NULL CHECK (app.agent_version_parts(version) IS NOT NULL),
  platform text NOT NULL CHECK (platform IN ('win-x64', 'linux-x64')),
  url text NOT NULL CHECK (url ~ '^https://[^\s/@]+(/[^\s]*)?$' AND length(url) <= 1000),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 314572800),
  notes text CHECK (notes IS NULL OR length(notes) <= 4000),
  manifest text NOT NULL CHECK (length(manifest) BETWEEN 2 AND 8192),
  signature text NOT NULL CHECK (signature ~ '^[A-Za-z0-9+/]{86}==$'),
  key_id text NOT NULL CHECK (key_id ~ '^[0-9a-f]{16}$'),
  status text NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'withdrawn')),
  published_at timestamptz NOT NULL DEFAULT now(),
  published_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  withdrawn_at timestamptz,
  withdrawn_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  withdrawn_reason text CHECK (withdrawn_reason IS NULL OR length(btrim(withdrawn_reason)) BETWEEN 3 AND 500),
  UNIQUE (platform, version),
  CONSTRAINT integration_agent_releases_withdrawn_check
    CHECK ((status = 'withdrawn') = (withdrawn_at IS NOT NULL) AND (withdrawn_at IS NULL) = (withdrawn_reason IS NULL))
);

-- Only the status may change, once, published -> withdrawn; nothing is deleted (even by SQL).
CREATE FUNCTION app.integration_agent_release_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'An agent release is never deleted; withdraw it' USING ERRCODE = 'QM022'; END IF;
  IF (NEW.id, NEW.version, NEW.platform, NEW.url, NEW.sha256, NEW.size_bytes, NEW.notes, NEW.manifest, NEW.signature, NEW.key_id, NEW.published_at, NEW.published_by)
     IS DISTINCT FROM (OLD.id, OLD.version, OLD.platform, OLD.url, OLD.sha256, OLD.size_bytes, OLD.notes, OLD.manifest, OLD.signature, OLD.key_id, OLD.published_at, OLD.published_by) THEN
    RAISE EXCEPTION 'A published release cannot be changed; publish a new version' USING ERRCODE = 'QM022';
  END IF;
  IF OLD.status = 'withdrawn' THEN RAISE EXCEPTION 'This release was withdrawn already' USING ERRCODE = 'QM022'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER integration_agent_releases_frozen BEFORE UPDATE OR DELETE ON public.integration_agent_releases
  FOR EACH ROW EXECUTE FUNCTION app.integration_agent_release_frozen();

ALTER TABLE public.integration_agent_releases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.integration_agent_releases FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.integration_agent_releases TO authenticated;
CREATE POLICY integration_agent_releases_select ON public.integration_agent_releases FOR SELECT TO authenticated
  USING (status = 'published' OR app.is_platform_admin());

-- ---------------------------------------------------------------------------
-- Updates (per organisation)
-- ---------------------------------------------------------------------------
CREATE TABLE public.integration_agent_updates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  release_id uuid NOT NULL REFERENCES public.integration_agent_releases (id),
  from_version text CHECK (from_version IS NULL OR length(from_version) <= 40),
  to_version text NOT NULL CHECK (length(to_version) <= 40),
  job_id uuid REFERENCES public.integration_agent_jobs (id),
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'staged', 'applied', 'failed', 'rolled_back', 'cancelled')),
  message text CHECK (message IS NULL OR length(message) <= 1000),
  approved_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  staged_at timestamptz,
  finished_at timestamptz,
  cancelled_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (agent_id, organisation_id) REFERENCES public.integration_agents (id, organisation_id),
  CONSTRAINT integration_agent_updates_finished_check CHECK ((status IN ('waiting', 'staged')) = (finished_at IS NULL))
);
CREATE UNIQUE INDEX integration_agent_updates_open_key ON public.integration_agent_updates (agent_id) WHERE status IN ('waiting', 'staged');
CREATE INDEX integration_agent_updates_agent_idx ON public.integration_agent_updates (agent_id, approved_at DESC);

-- The allowed moves, even for SQL: waiting -> staged | failed | cancelled; staged -> applied | failed | rolled_back; a finished update is frozen.
CREATE FUNCTION app.integration_agent_update_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'An agent update is never deleted' USING ERRCODE = 'QM022'; END IF;
  IF (NEW.organisation_id, NEW.agent_id, NEW.release_id, NEW.from_version, NEW.to_version, NEW.approved_by, NEW.approved_at)
     IS DISTINCT FROM (OLD.organisation_id, OLD.agent_id, OLD.release_id, OLD.from_version, OLD.to_version, OLD.approved_by, OLD.approved_at) THEN
    RAISE EXCEPTION 'What an update installs cannot change' USING ERRCODE = 'QM022';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'waiting' AND NEW.status IN ('staged', 'failed', 'cancelled'))
    OR (OLD.status = 'staged' AND NEW.status IN ('applied', 'failed', 'rolled_back'))) THEN
    RAISE EXCEPTION 'An update cannot go from % to %', OLD.status, NEW.status USING ERRCODE = 'QM022';
  END IF;
  IF OLD.status NOT IN ('waiting', 'staged') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'A finished update cannot change' USING ERRCODE = 'QM022';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER integration_agent_updates_rules BEFORE UPDATE OR DELETE ON public.integration_agent_updates
  FOR EACH ROW EXECUTE FUNCTION app.integration_agent_update_rules();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.integration_agent_updates
  FOR EACH ROW EXECUTE FUNCTION audit.record_change();

ALTER TABLE public.integration_agent_updates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.integration_agent_updates FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.integration_agent_updates TO authenticated;
CREATE POLICY integration_agent_updates_select ON public.integration_agent_updates FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'integrations.read'));

-- ---------------------------------------------------------------------------
-- Operator: publish and withdraw
-- ---------------------------------------------------------------------------
-- The manifest is stored as given (its bytes are what was signed); the columns are read out of it, and the API has checked the signature first.
CREATE FUNCTION app.platform_publish_agent_release(p_manifest text, p_signature text, p_key_id text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE m jsonb; v_id uuid;
BEGIN
  IF NOT app.is_platform_admin() THEN RAISE EXCEPTION 'Platform administrators only' USING ERRCODE = '42501'; END IF;
  BEGIN
    m := p_manifest::jsonb;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'The manifest is not JSON' USING ERRCODE = 'QM022';
  END;
  IF jsonb_typeof(m) <> 'object' OR m ->> 'format' IS DISTINCT FROM 'fortress-agent-release-v1' THEN
    RAISE EXCEPTION 'The manifest is not a Fortress agent release (format fortress-agent-release-v1)' USING ERRCODE = 'QM022';
  END IF;
  IF app.agent_version_parts(m ->> 'version') IS NULL THEN RAISE EXCEPTION 'The manifest''s version must be three whole numbers, e.g. 0.7.0' USING ERRCODE = 'QM022'; END IF;
  IF coalesce(m ->> 'platform', '') NOT IN ('win-x64', 'linux-x64') THEN RAISE EXCEPTION 'The manifest''s platform must be win-x64 or linux-x64' USING ERRCODE = 'QM022'; END IF;
  IF coalesce(m ->> 'url', '') !~ '^https://[^\s/@]+(/[^\s]*)?$' THEN RAISE EXCEPTION 'The manifest''s address must be https' USING ERRCODE = 'QM022'; END IF;
  IF coalesce(m ->> 'sha256', '') !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'The manifest needs the file''s SHA-256 in lower-case hex' USING ERRCODE = 'QM022'; END IF;
  IF jsonb_typeof(m -> 'size') IS DISTINCT FROM 'number' OR (m ->> 'size')::numeric NOT BETWEEN 1 AND 314572800 OR (m ->> 'size')::numeric % 1 <> 0 THEN
    RAISE EXCEPTION 'The manifest needs the file''s size in bytes (at most 300 MB)' USING ERRCODE = 'QM022';
  END IF;
  IF EXISTS (SELECT 1 FROM public.integration_agent_releases r WHERE r.platform = m ->> 'platform' AND r.version = m ->> 'version') THEN
    RAISE EXCEPTION 'Version % for % was published already', m ->> 'version', m ->> 'platform' USING ERRCODE = 'QM022';
  END IF;
  INSERT INTO public.integration_agent_releases (version, platform, url, sha256, size_bytes, notes, manifest, signature, key_id, published_by)
  VALUES (m ->> 'version', m ->> 'platform', m ->> 'url', m ->> 'sha256', (m ->> 'size')::bigint, left(nullif(btrim(m ->> 'notes'), ''), 4000),
          p_manifest, p_signature, p_key_id, auth.uid())
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Withdrawing stops new approvals; updates already waiting for it are cancelled (an agent that staged it already may still apply it).
CREATE FUNCTION app.platform_withdraw_agent_release(p_release uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  IF NOT app.is_platform_admin() THEN RAISE EXCEPTION 'Platform administrators only' USING ERRCODE = '42501'; END IF;
  IF length(v_reason) < 3 OR length(v_reason) > 500 THEN RAISE EXCEPTION 'Say why the release is withdrawn (3 to 500 characters)' USING ERRCODE = 'QM022'; END IF;
  UPDATE public.integration_agent_releases SET status = 'withdrawn', withdrawn_at = now(), withdrawn_by = auth.uid(), withdrawn_reason = v_reason
   WHERE id = p_release AND status = 'published';
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.integration_agent_releases WHERE id = p_release) THEN
      RAISE EXCEPTION 'This release was withdrawn already' USING ERRCODE = 'QM022';
    END IF;
    RAISE EXCEPTION 'Release not found' USING ERRCODE = 'P0002';
  END IF;
  -- The updates first, so the jobs' trigger finds them no longer waiting.
  WITH cancelled AS (
    UPDATE public.integration_agent_updates SET status = 'cancelled', finished_at = now(), message = 'The release was withdrawn: ' || v_reason
     WHERE release_id = p_release AND status = 'waiting'
    RETURNING job_id
  )
  UPDATE public.integration_agent_jobs j SET status = 'cancelled', finished_at = clock_timestamp(), updated_at = clock_timestamp(), leased_until = NULL,
         error_kind = 'cancelled', error_message = 'The release was withdrawn'
    FROM cancelled c
   WHERE j.id = c.job_id AND j.status IN ('pending', 'received', 'running');
END $$;

-- How many active agents run each version on each platform, for the operator's release list (counts only: no organisation, no agent).
CREATE FUNCTION app.platform_agent_versions() RETURNS TABLE (version text, platform text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT app.is_platform_admin() THEN RAISE EXCEPTION 'Platform administrators only' USING ERRCODE = '42501'; END IF;
  RETURN QUERY SELECT a.agent_version, a.capabilities ->> 'platform' FROM public.integration_agents a WHERE a.status = 'active';
END $$;

-- ---------------------------------------------------------------------------
-- People: approve and cancel an update
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.approve_agent_update(p_agent uuid, p_release uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.integration_agents%ROWTYPE; rel public.integration_agent_releases%ROWTYPE; v_platform text; v_job uuid; v_id uuid;
BEGIN
  SELECT * INTO a FROM public.integration_agents WHERE id = p_agent FOR UPDATE;
  IF NOT FOUND OR NOT app.has_permission(a.organisation_id, 'integrations.read') THEN RAISE EXCEPTION 'Agent not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_agent_manager(a.organisation_id);
  IF a.status <> 'active' THEN RAISE EXCEPTION 'This agent has been revoked' USING ERRCODE = 'QM022'; END IF;
  SELECT * INTO rel FROM public.integration_agent_releases WHERE id = p_release;
  IF NOT FOUND THEN RAISE EXCEPTION 'Release not found' USING ERRCODE = 'P0002'; END IF;
  IF rel.status <> 'published' THEN RAISE EXCEPTION 'This release was withdrawn: %', rel.withdrawn_reason USING ERRCODE = 'QM022'; END IF;
  v_platform := a.capabilities ->> 'platform';
  IF v_platform IS NULL THEN
    RAISE EXCEPTION 'This agent does not say which platform it runs on (it is older than updates); update it by installing the new version by hand' USING ERRCODE = 'QM022';
  END IF;
  IF v_platform <> rel.platform THEN
    RAISE EXCEPTION 'This release is for %, but the agent runs on %', rel.platform, v_platform USING ERRCODE = 'QM022';
  END IF;
  IF app.agent_version_parts(a.agent_version) IS NOT NULL AND app.agent_version_parts(rel.version) <= app.agent_version_parts(a.agent_version) THEN
    RAISE EXCEPTION 'The agent is already at version %; choose a newer release', a.agent_version USING ERRCODE = 'QM022';
  END IF;
  IF EXISTS (SELECT 1 FROM public.integration_agent_updates u WHERE u.agent_id = a.id AND u.status IN ('waiting', 'staged')) THEN
    RAISE EXCEPTION 'An update of this agent is already under way' USING ERRCODE = 'QM022';
  END IF;
  v_id := gen_random_uuid();
  INSERT INTO public.integration_agent_jobs (organisation_id, agent_id, kind, spec, max_attempts, requested_by)
  VALUES (a.organisation_id, a.id, 'update_agent',
          jsonb_build_object('updateId', v_id, 'releaseId', rel.id, 'version', rel.version, 'manifest', rel.manifest, 'signature', rel.signature, 'keyId', rel.key_id),
          3, auth.uid())
  RETURNING id INTO v_job;
  INSERT INTO public.integration_agent_updates (id, organisation_id, agent_id, release_id, from_version, to_version, job_id, approved_by)
  VALUES (v_id, a.organisation_id, a.id, rel.id, a.agent_version, rel.version, v_job, auth.uid());
  PERFORM app.agent_event(a.id, 'update_approved', jsonb_build_object('from', a.agent_version, 'to', rel.version));
  UPDATE public.integration_agents SET fast_poll_until = now() + interval '10 minutes' WHERE id = a.id;
  RETURN v_id;
END $$;

-- Only while the agent has not staged it yet.
CREATE FUNCTION app.cancel_agent_update(p_update uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE u public.integration_agent_updates%ROWTYPE;
BEGIN
  SELECT * INTO u FROM public.integration_agent_updates WHERE id = p_update FOR UPDATE;
  IF NOT FOUND OR NOT app.has_permission(u.organisation_id, 'integrations.read') THEN RAISE EXCEPTION 'Update not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_agent_manager(u.organisation_id);
  IF u.status <> 'waiting' THEN
    RAISE EXCEPTION 'Only an update the agent has not downloaded yet can be cancelled' USING ERRCODE = 'QM022';
  END IF;
  -- The update first, so the job's trigger finds it no longer waiting.
  UPDATE public.integration_agent_updates SET status = 'cancelled', finished_at = now(), cancelled_by = auth.uid(), message = 'Cancelled in Fortress'
   WHERE id = u.id;
  UPDATE public.integration_agent_jobs SET status = 'cancelled', finished_at = clock_timestamp(), updated_at = clock_timestamp(), leased_until = NULL,
         error_kind = 'cancelled', error_message = 'Cancelled in Fortress'
   WHERE id = u.job_id AND status IN ('pending', 'received', 'running');
  PERFORM app.agent_event(u.agent_id, 'update_cancelled', jsonb_build_object('to', u.to_version));
END $$;

-- ---------------------------------------------------------------------------
-- Following the job and the agent
-- ---------------------------------------------------------------------------
-- The update job's outcome moves the update: completed = staged; failed or cancelled = failed (unless the update was cancelled already).
CREATE FUNCTION app.integration_agent_update_follow_job() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE u public.integration_agent_updates%ROWTYPE;
BEGIN
  SELECT * INTO u FROM public.integration_agent_updates WHERE job_id = NEW.id FOR UPDATE;
  IF NOT FOUND OR u.status <> 'waiting' THEN RETURN NEW; END IF;
  IF NEW.status = 'completed' THEN
    UPDATE public.integration_agent_updates SET status = 'staged', staged_at = now(), message = NULL WHERE id = u.id;
    PERFORM app.agent_event(u.agent_id, 'update_staged', jsonb_build_object('to', u.to_version));
  ELSIF NEW.status IN ('failed', 'cancelled') THEN
    UPDATE public.integration_agent_updates SET status = 'failed', finished_at = now(), message = left(coalesce(NEW.error_message, 'The update did not complete'), 1000)
     WHERE id = u.id;
    PERFORM app.agent_event(u.agent_id, 'update_failed', jsonb_build_object('to', u.to_version, 'message', left(NEW.error_message, 300)));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER integration_agent_jobs_update_follow AFTER UPDATE OF status ON public.integration_agent_jobs
  FOR EACH ROW WHEN (NEW.kind = 'update_agent' AND NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('completed', 'failed', 'cancelled'))
  EXECUTE FUNCTION app.integration_agent_update_follow_job();

-- The heartbeat (the AG1 version), now also marking a staged update applied when the agent comes back at its version.
CREATE OR REPLACE FUNCTION app.system_agent_heartbeat(p_agent uuid, p_version text, p_os text, p_machine text, p_capabilities jsonb, p_address text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.integration_agents%ROWTYPE; v_waiting boolean; u public.integration_agent_updates%ROWTYPE;
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
  SELECT * INTO u FROM public.integration_agent_updates WHERE agent_id = r.id AND status = 'staged' FOR UPDATE;
  IF FOUND AND p_version IS NOT NULL AND left(p_version, 40) = u.to_version THEN
    UPDATE public.integration_agent_updates SET status = 'applied', finished_at = now() WHERE id = u.id;
    PERFORM app.agent_event(r.id, 'update_applied', jsonb_build_object('to', u.to_version));
  END IF;
  v_waiting := EXISTS (SELECT 1 FROM public.integration_agent_jobs j WHERE j.agent_id = r.id
                         AND (j.status = 'pending' OR (j.status IN ('received', 'running') AND j.leased_until < now())));
  RETURN jsonb_build_object('revoked', false, 'jobsWaiting', v_waiting,
                            'fastPollUntil', CASE WHEN r.fast_poll_until > now() THEN r.fast_poll_until END);
END $$;

-- The agent reports what happened to a staged update: applied (it is running the new version) or rolled_back (the new version did not come up
-- in time and the updater put the old one back). Only the agent's own staged update; anything else is ignored (a late or repeated report).
CREATE FUNCTION app.system_agent_update_report(p_agent uuid, p_update uuid, p_outcome text, p_message text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE u public.integration_agent_updates%ROWTYPE;
BEGIN
  IF p_outcome NOT IN ('applied', 'rolled_back') THEN RAISE EXCEPTION 'An update report is applied or rolled_back' USING ERRCODE = 'QM022'; END IF;
  SELECT * INTO u FROM public.integration_agent_updates WHERE id = p_update AND agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN RETURN 'unknown'; END IF;
  IF u.status <> 'staged' THEN RETURN u.status; END IF;
  UPDATE public.integration_agent_updates SET status = p_outcome, finished_at = now(), message = left(nullif(btrim(p_message), ''), 1000) WHERE id = u.id;
  PERFORM app.agent_event(p_agent, CASE p_outcome WHEN 'applied' THEN 'update_applied' ELSE 'update_rolled_back' END,
                          jsonb_build_object('to', u.to_version, 'message', left(p_message, 300)));
  RETURN p_outcome;
END $$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app.agent_version_parts(text), app.integration_agent_release_frozen(), app.integration_agent_update_rules(),
  app.platform_publish_agent_release(text, text, text), app.platform_withdraw_agent_release(uuid, text), app.platform_agent_versions(),
  app.approve_agent_update(uuid, uuid), app.cancel_agent_update(uuid), app.integration_agent_update_follow_job(),
  app.system_agent_update_report(uuid, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.agent_version_parts(text), app.platform_publish_agent_release(text, text, text), app.platform_agent_versions(),
  app.platform_withdraw_agent_release(uuid, text), app.approve_agent_update(uuid, uuid), app.cancel_agent_update(uuid) TO authenticated;
REVOKE ALL ON FUNCTION app.system_agent_update_report(uuid, uuid, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION app.system_agent_update_report(uuid, uuid, text, text) TO qms_api;
