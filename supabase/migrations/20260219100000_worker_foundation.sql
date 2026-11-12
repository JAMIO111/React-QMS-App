-- Background worker foundation (docs/workflow-engine-plan.md, WK1; decisions W1–W3, W9).
--
-- Something now wakes up on its own: pg_cron in Supabase calls the API's tick every minute through pg_net (installed and scheduled by the runbook
-- supabase/runbooks/worker-schedule.sql, not by this migration, so local test databases need neither extension). The tick drains the queues that
-- already exist (email, import runs), does what the daily crons did, and works the jobs below. Everything here lives in the `app` schema and is reached
-- only through functions the API login may execute: people never read or write it.
--
--  * app.worker_jobs: one queue for background work (kind, payload, when, unique idempotency key). Leased with FOR UPDATE SKIP LOCKED; a lease that runs
--    out (the worker died) makes the job due again; attempts count leases, so a job that keeps killing its worker still stops. Failed back off 1, 4, 16,
--    64 minutes and are final after max_attempts (default 5).
--  * app.worker_ticks + app.worker_state: one row per tick (source, steps, outcome) and a single lease, so two ticks never overlap (a tick that finds the
--    lease taken is recorded as skipped).
--  * app.outbox_consumers + app.outbox_deliveries: each reader of public.outbox_events (the workflow engine first, webhooks later) sees every event once.
--    Events are marked delivered one by one rather than by an id cursor: identity ids are handed out when a row is inserted, not when its transaction
--    commits, so a cursor could skip an event committed after a later one was read. A consumer only sees events written after it was registered.
--  * app.platform_worker_health: operators see the last ticks, the queue and failures (kinds and errors, never payloads).

CREATE TABLE app.worker_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid REFERENCES public.organisations (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)*$' AND length(kind) <= 60),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object' AND pg_column_size(payload) <= 65536),
  idempotency_key text UNIQUE CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
  run_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 10),
  leased_until timestamptz,
  last_error text CHECK (last_error IS NULL OR length(last_error) <= 1000),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX worker_jobs_due_idx ON app.worker_jobs (run_at) WHERE status IN ('queued', 'running');
CREATE INDEX worker_jobs_finished_idx ON app.worker_jobs (finished_at) WHERE finished_at IS NOT NULL;
CREATE INDEX worker_jobs_organisation_idx ON app.worker_jobs (organisation_id);

CREATE TABLE app.worker_ticks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source text NOT NULL CHECK (source IN ('pg_cron', 'vercel', 'manual', 'test')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  outcome text NOT NULL DEFAULT 'running' CHECK (outcome IN ('running', 'done', 'partial', 'error', 'skipped')),
  steps jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(steps) = 'array'),
  error text CHECK (error IS NULL OR length(error) <= 1000)
);
CREATE INDEX worker_ticks_started_idx ON app.worker_ticks (started_at);

CREATE TABLE app.worker_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  lease_tick bigint,
  lease_until timestamptz
);
INSERT INTO app.worker_state (id) VALUES (true);

CREATE TABLE app.outbox_consumers (
  name text PRIMARY KEY CHECK (name ~ '^[a-z][a-z0-9_]{1,39}$'),
  registered_at timestamptz NOT NULL DEFAULT now(),
  last_read_at timestamptz,
  delivered bigint NOT NULL DEFAULT 0
);

CREATE TABLE app.outbox_deliveries (
  consumer text NOT NULL REFERENCES app.outbox_consumers (name) ON DELETE CASCADE,
  event_id bigint NOT NULL REFERENCES public.outbox_events (id) ON DELETE CASCADE,
  delivered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);
CREATE INDEX outbox_deliveries_event_idx ON app.outbox_deliveries (event_id);

REVOKE ALL ON app.worker_jobs, app.worker_ticks, app.worker_state, app.outbox_consumers, app.outbox_deliveries FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Jobs
-- ---------------------------------------------------------------------------

-- Puts a job on the queue. With an idempotency key the same job is never queued twice: the existing one's id comes back. Called by the API and,
-- later, by SECURITY DEFINER triggers in the same transaction as the change that needs the work.
CREATE FUNCTION app.system_enqueue_job(p_kind text, p_payload jsonb DEFAULT '{}'::jsonb, p_organisation_id uuid DEFAULT NULL, p_idempotency_key text DEFAULT NULL,
                                       p_run_at timestamptz DEFAULT NULL, p_max_attempts integer DEFAULT 5)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO app.worker_jobs (organisation_id, kind, payload, idempotency_key, run_at, max_attempts)
  VALUES (p_organisation_id, p_kind, coalesce(p_payload, '{}'::jsonb), p_idempotency_key, coalesce(p_run_at, now()), coalesce(p_max_attempts, 5))
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM app.worker_jobs WHERE idempotency_key = p_idempotency_key;
  END IF;
  RETURN v_id;
END $$;

-- The jobs to run now: due and queued, or running with a lease that ran out (the worker that had it stopped). Each is leased and its attempt counted.
CREATE FUNCTION app.system_lease_jobs(p_limit integer DEFAULT 20, p_lease_seconds integer DEFAULT 120)
RETURNS TABLE (id uuid, organisation_id uuid, kind text, payload jsonb, attempts integer, max_attempts integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT j.id FROM app.worker_jobs j
     WHERE j.run_at <= now() AND (j.status = 'queued' OR (j.status = 'running' AND j.leased_until < now()))
     ORDER BY j.run_at, j.created_at
     LIMIT least(greatest(coalesce(p_limit, 20), 1), 100)
     FOR UPDATE SKIP LOCKED
  )
  UPDATE app.worker_jobs j
     SET status = 'running', attempts = j.attempts + 1, updated_at = now(),
         leased_until = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 120), 10), 900))
    FROM due WHERE j.id = due.id
  RETURNING j.id, j.organisation_id, j.kind, j.payload, j.attempts, j.max_attempts;
END $$;

-- The outcome of one run. ok → done. A failure is tried again after 1, 4, 16, 64 … minutes until max_attempts, unless p_retry is false (the job can
-- never succeed, e.g. no handler for its kind), then it is failed. A job that is no longer running (cancelled meanwhile) keeps its status.
CREATE FUNCTION app.system_finish_job(p_id uuid, p_ok boolean, p_result jsonb DEFAULT NULL, p_error text DEFAULT NULL, p_retry boolean DEFAULT true)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE j app.worker_jobs%ROWTYPE;
BEGIN
  SELECT * INTO j FROM app.worker_jobs WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002'; END IF;
  IF j.status <> 'running' THEN RETURN j.status; END IF;
  IF p_ok THEN
    UPDATE app.worker_jobs SET status = 'done', result = p_result, last_error = NULL, leased_until = NULL, finished_at = now(), updated_at = now() WHERE id = p_id;
    RETURN 'done';
  END IF;
  IF NOT coalesce(p_retry, true) OR j.attempts >= j.max_attempts THEN
    UPDATE app.worker_jobs SET status = 'failed', last_error = left(coalesce(p_error, 'Failed'), 1000), leased_until = NULL, finished_at = now(), updated_at = now() WHERE id = p_id;
    RETURN 'failed';
  END IF;
  UPDATE app.worker_jobs SET status = 'queued', last_error = left(coalesce(p_error, 'Failed'), 1000), leased_until = NULL,
         run_at = now() + make_interval(mins => power(4, greatest(j.attempts - 1, 0))::int), updated_at = now() WHERE id = p_id;
  RETURN 'queued';
END $$;

-- Stops a job that has not finished (queued, or running: a running one finishes as cancelled whatever its worker reports).
CREATE FUNCTION app.system_cancel_job(p_id uuid, p_reason text DEFAULT NULL)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_status text;
BEGIN
  UPDATE app.worker_jobs SET status = 'cancelled', last_error = left(coalesce(p_reason, 'Cancelled'), 1000), leased_until = NULL, finished_at = now(), updated_at = now()
   WHERE id = p_id AND status IN ('queued', 'running')
  RETURNING status INTO v_status;
  IF v_status IS NULL THEN
    SELECT status INTO v_status FROM app.worker_jobs WHERE id = p_id;
    IF v_status IS NULL THEN RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002'; END IF;
  END IF;
  RETURN v_status;
END $$;

-- ---------------------------------------------------------------------------
-- Ticks
-- ---------------------------------------------------------------------------

-- Starts a tick. Only one tick works at a time: the lease is taken when it is free or ran out (a tick that died), for p_lease_seconds. A tick that
-- finds it taken is recorded as skipped and gets acquired = false.
CREATE FUNCTION app.system_worker_begin(p_source text, p_lease_seconds integer DEFAULT 90)
RETURNS TABLE (tick_id bigint, acquired boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tick bigint; v_got boolean;
BEGIN
  INSERT INTO app.worker_ticks (source) VALUES (p_source) RETURNING id INTO v_tick;
  UPDATE app.worker_state SET lease_tick = v_tick, lease_until = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 90), 10), 600))
   WHERE id AND (lease_until IS NULL OR lease_until < now());
  v_got := FOUND;
  IF NOT v_got THEN
    UPDATE app.worker_ticks SET outcome = 'skipped', finished_at = now(), error = 'Another tick is still working' WHERE id = v_tick;
  END IF;
  RETURN QUERY SELECT v_tick, v_got;
END $$;

-- Ends a tick: records what each step did, frees the lease (if this tick still holds it) and clears out old records: ticks after 7 days, finished
-- jobs after 30 days (failed ones after 90), deliveries of events older than 30 days.
CREATE FUNCTION app.system_worker_end(p_tick bigint, p_outcome text, p_steps jsonb DEFAULT '[]'::jsonb, p_error text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_outcome NOT IN ('done', 'partial', 'error') THEN RAISE EXCEPTION 'The outcome is done, partial or error' USING ERRCODE = '22023'; END IF;
  UPDATE app.worker_ticks SET outcome = p_outcome, steps = coalesce(p_steps, '[]'::jsonb), error = left(p_error, 1000), finished_at = now()
   WHERE id = p_tick AND outcome = 'running';
  UPDATE app.worker_state SET lease_tick = NULL, lease_until = NULL WHERE id AND lease_tick = p_tick;
  DELETE FROM app.worker_ticks WHERE started_at < now() - interval '7 days';
  DELETE FROM app.worker_jobs WHERE (status IN ('done', 'cancelled') AND finished_at < now() - interval '30 days')
                                 OR (status = 'failed' AND finished_at < now() - interval '90 days');
  DELETE FROM app.outbox_deliveries d USING public.outbox_events e WHERE e.id = d.event_id AND e.created_at < now() - interval '30 days';
END $$;

-- ---------------------------------------------------------------------------
-- Outbox consumers
-- ---------------------------------------------------------------------------

-- The next events a consumer has not had, oldest first. The first call registers the consumer: it sees only events written from then on.
CREATE FUNCTION app.system_outbox_read(p_consumer text, p_limit integer DEFAULT 100)
RETURNS TABLE (id bigint, organisation_id uuid, event_type text, entity_type text, entity_id uuid, payload jsonb, actor_user_id uuid, correlation_id text, created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_since timestamptz;
BEGIN
  INSERT INTO app.outbox_consumers (name) VALUES (p_consumer) ON CONFLICT (name) DO NOTHING;
  UPDATE app.outbox_consumers SET last_read_at = now() WHERE name = p_consumer RETURNING registered_at INTO v_since;
  RETURN QUERY
  SELECT e.id, e.organisation_id, e.event_type, e.entity_type, e.entity_id, e.payload, e.actor_user_id, e.correlation_id, e.created_at
    FROM public.outbox_events e
   WHERE e.created_at >= v_since
     AND NOT EXISTS (SELECT 1 FROM app.outbox_deliveries d WHERE d.consumer = p_consumer AND d.event_id = e.id)
   ORDER BY e.id
   LIMIT least(greatest(coalesce(p_limit, 100), 1), 500);
END $$;

-- Marks events as handled by a consumer (again is harmless). Returns how many were new.
CREATE FUNCTION app.system_outbox_ack(p_consumer text, p_event_ids bigint[])
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_n integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.outbox_consumers WHERE name = p_consumer) THEN
    RAISE EXCEPTION 'Unknown outbox consumer' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO app.outbox_deliveries (consumer, event_id)
  SELECT p_consumer, x FROM unnest(coalesce(p_event_ids, '{}'::bigint[])) AS x
   WHERE EXISTS (SELECT 1 FROM public.outbox_events e WHERE e.id = x)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  UPDATE app.outbox_consumers SET delivered = delivered + v_n WHERE name = p_consumer;
  RETURN v_n;
END $$;

-- ---------------------------------------------------------------------------
-- Operators
-- ---------------------------------------------------------------------------

-- How the worker is doing: the latest ticks, how often it ran in the last hour, the queue by kind and status, failures with their error, and each
-- outbox consumer's backlog. Kinds, counts and errors only: never a payload.
CREATE FUNCTION app.platform_worker_health() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT app.is_platform_admin() THEN RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501'; END IF;
  RETURN jsonb_build_object(
    'now', now(),
    'lastTick', (SELECT jsonb_build_object('id', id, 'source', source, 'startedAt', started_at, 'finishedAt', finished_at, 'outcome', outcome, 'error', error,
                   'durationMs', CASE WHEN finished_at IS NOT NULL THEN round(extract(epoch FROM finished_at - started_at) * 1000) END)
                   FROM app.worker_ticks WHERE outcome <> 'skipped' ORDER BY started_at DESC LIMIT 1),
    'lastHour', (SELECT jsonb_build_object('ticks', count(*) FILTER (WHERE outcome <> 'skipped'), 'skipped', count(*) FILTER (WHERE outcome = 'skipped'),
                   'problems', count(*) FILTER (WHERE outcome IN ('partial', 'error')),
                   'sources', coalesce(jsonb_agg(DISTINCT source), '[]'::jsonb))
                   FROM app.worker_ticks WHERE started_at >= now() - interval '1 hour'),
    'recentTicks', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'source', source, 'startedAt', started_at, 'outcome', outcome, 'error', error, 'steps', steps,
                       'durationMs', CASE WHEN finished_at IS NOT NULL THEN round(extract(epoch FROM finished_at - started_at) * 1000) END) ORDER BY started_at DESC), '[]'::jsonb)
                      FROM (SELECT * FROM app.worker_ticks ORDER BY started_at DESC LIMIT 15) t),
    'jobs', jsonb_build_object(
      'waiting', (SELECT count(*) FROM app.worker_jobs WHERE status = 'queued'),
      'due', (SELECT count(*) FROM app.worker_jobs WHERE status = 'queued' AND run_at <= now()),
      'running', (SELECT count(*) FROM app.worker_jobs WHERE status = 'running'),
      'oldestDue', (SELECT min(run_at) FROM app.worker_jobs WHERE status = 'queued' AND run_at <= now()),
      'byKind', (SELECT coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'status', status, 'count', n) ORDER BY kind, status), '[]'::jsonb)
                   FROM (SELECT kind, status, count(*) AS n FROM app.worker_jobs WHERE status IN ('queued', 'running') OR finished_at >= now() - interval '24 hours'
                          GROUP BY kind, status) k),
      'failures', (SELECT coalesce(jsonb_agg(jsonb_build_object('kind', j.kind, 'organisation', o.name, 'status', j.status, 'attempts', j.attempts,
                       'error', j.last_error, 'at', j.updated_at) ORDER BY j.updated_at DESC), '[]'::jsonb)
                     FROM (SELECT * FROM app.worker_jobs WHERE status = 'failed' OR (status IN ('queued', 'running') AND last_error IS NOT NULL)
                            ORDER BY updated_at DESC LIMIT 25) j
                     LEFT JOIN public.organisations o ON o.id = j.organisation_id)
    ),
    'consumers', (SELECT coalesce(jsonb_agg(jsonb_build_object('name', c.name, 'registeredAt', c.registered_at, 'lastReadAt', c.last_read_at, 'delivered', c.delivered,
                    'backlog', (SELECT count(*) FROM public.outbox_events e WHERE e.created_at >= c.registered_at
                                   AND NOT EXISTS (SELECT 1 FROM app.outbox_deliveries d WHERE d.consumer = c.name AND d.event_id = e.id))) ORDER BY c.name), '[]'::jsonb)
                    FROM app.outbox_consumers c)
  );
END $$;

REVOKE ALL ON FUNCTION app.system_enqueue_job(text, jsonb, uuid, text, timestamptz, integer), app.system_lease_jobs(integer, integer),
  app.system_finish_job(uuid, boolean, jsonb, text, boolean), app.system_cancel_job(uuid, text), app.system_worker_begin(text, integer),
  app.system_worker_end(bigint, text, jsonb, text), app.system_outbox_read(text, integer), app.system_outbox_ack(text, bigint[]),
  app.platform_worker_health() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.system_enqueue_job(text, jsonb, uuid, text, timestamptz, integer), app.system_lease_jobs(integer, integer),
  app.system_finish_job(uuid, boolean, jsonb, text, boolean), app.system_cancel_job(uuid, text), app.system_worker_begin(text, integer),
  app.system_worker_end(bigint, text, jsonb, text), app.system_outbox_read(text, integer), app.system_outbox_ack(text, bigint[]) TO qms_api;
GRANT EXECUTE ON FUNCTION app.platform_worker_health() TO authenticated;
