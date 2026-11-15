-- Connector agent AG3 (docs/connector-agent-plan.md §9): records read from a database through the agent, into the existing import pipeline.
--
--  * Record sources (integration_record_sources): for each kind of Fortress record, which table or view of the connection's database holds it,
--    which column identifies each row, which columns to read (all, or a list) and optional filters (column, test, value). A structured request:
--    the agent builds its own read-only SELECT from it, checked against what the database lists (AG-D5). Choosing a source does not reset the
--    connection's approval: it says what to read, like a mapping, not how to connect.
--  * A preview or full import from a database connection is two halves. app.request_integration_run makes the run and an `extract` job for the
--    agent (integration_agent_jobs.run_id). The agent reads the table page by page (keyset order on the key column) and sends batches of at most
--    1,000 rows (integration_agent_batches, one per job and sequence number: a batch sent twice is stored once, a different batch under a used
--    number is refused). When the agent reports the job complete, with as many batches as Fortress holds, the run is released to the sync engine,
--    which pages through the batches exactly as it pages through a file's chunks. Until then the run waits (the lease says so and the worker
--    leaves it alone). A job the agent cannot finish fails the run with its reason; cancelling the run cancels the job.
--  * An extraction job that is retried (the agent restarted, a transient failure) carries on from the first batch not stored: the job hands the
--    agent the next sequence number and the key of the last row stored.
--  * Incremental reads and schedules arrive with AG4. Batches are cleared seven days after their job ended (staging keeps what an import needs).
-- No table writes for people or agents: SECURITY DEFINER functions only. Errors QM022 → 409 integration_rule; another organisation P0002 → 404.

-- Imports from a database connection are now possible.
DROP TRIGGER integration_sync_runs_agent_guard ON public.integration_sync_runs;
DROP FUNCTION app.integration_runs_agent_guard();

UPDATE public.integration_providers
   SET description = 'Reads tables and views of a SQL Server or PostgreSQL database inside your network through a connector agent: test, browse, preview and import.'
 WHERE key = 'sql_agent';

-- ---------------------------------------------------------------------------
-- Record sources
-- ---------------------------------------------------------------------------
-- A table / view and column name as the database spells it: 1 to 128 characters, no control characters. The agent quotes it and checks it
-- against the database's own catalogue, so nothing here can become SQL.
CREATE FUNCTION app.integration_db_name_ok(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT jsonb_typeof(p) = 'string' AND (p #>> '{}') ~ '^[^\x01-\x1f]{1,128}$' AND btrim(p #>> '{}') <> ''
$$;

CREATE FUNCTION app.integration_record_source_problem(p jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE k text; f jsonb; v_cols text[]; n integer;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN RETURN 'The record source is not in the expected form'; END IF;
  FOR k IN SELECT jsonb_object_keys(p) LOOP
    IF k NOT IN ('schema', 'object', 'keyColumn', 'columns', 'filters') THEN RETURN format('Unknown record source setting "%s"', k); END IF;
  END LOOP;
  IF NOT app.integration_db_name_ok(p -> 'schema') THEN RETURN 'Choose the schema'; END IF;
  IF NOT app.integration_db_name_ok(p -> 'object') THEN RETURN 'Choose the table or view'; END IF;
  IF NOT app.integration_db_name_ok(p -> 'keyColumn') THEN RETURN 'Choose the column that identifies each row'; END IF;
  IF p ? 'columns' THEN
    IF jsonb_typeof(p -> 'columns') <> 'array' THEN RETURN 'The columns are a list'; END IF;
    n := jsonb_array_length(p -> 'columns');
    IF n NOT BETWEEN 1 AND 300 THEN RETURN 'Read 1 to 300 columns, or leave the list out to read them all'; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p -> 'columns') e WHERE NOT app.integration_db_name_ok(e)) THEN RETURN 'A column name is not valid'; END IF;
    SELECT array_agg(e #>> '{}') INTO v_cols FROM jsonb_array_elements(p -> 'columns') e;
    IF (SELECT count(DISTINCT x) FROM unnest(v_cols) x) <> n THEN RETURN 'A column is listed twice'; END IF;
    IF NOT ((p ->> 'keyColumn') = ANY (v_cols)) THEN RETURN 'Read the column that identifies each row too'; END IF;
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

CREATE TABLE public.integration_record_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  entity_type text NOT NULL CHECK (entity_type = ANY (app.integration_entity_types())),
  source jsonb NOT NULL CHECK (app.integration_record_source_problem(source) IS NULL),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, entity_type),
  FOREIGN KEY (connection_id, organisation_id) REFERENCES public.integration_connections (id, organisation_id)
);
CREATE TRIGGER integration_record_sources_org_immutable BEFORE UPDATE ON public.integration_record_sources FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.integration_record_sources FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id', 'connection_id');
ALTER TABLE public.integration_record_sources ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.integration_record_sources FROM anon, authenticated;
GRANT SELECT ON public.integration_record_sources TO authenticated;
CREATE POLICY integration_record_sources_select ON public.integration_record_sources FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'integrations.read'));

-- Say (or stop saying) which table holds a kind of record. NULL removes the source.
CREATE FUNCTION app.set_integration_record_source(p_connection uuid, p_entity text, p_source jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.integration_connections%ROWTYPE; v_problem text; v_label text := replace(coalesce(p_entity, ''), '_', ' ');
BEGIN
  c := app.integration_connection_for_write(p_connection, 'integrations.manage');
  IF c.agent_id IS NULL THEN RAISE EXCEPTION 'Only a database connection reads records from tables' USING ERRCODE = 'QM022'; END IF;
  IF c.status = 'retired' THEN RAISE EXCEPTION 'A retired connection cannot be changed' USING ERRCODE = 'QM022'; END IF;
  PERFORM app.integration_assert_entity(p_entity);
  IF p_source IS NULL THEN
    DELETE FROM public.integration_record_sources WHERE connection_id = c.id AND entity_type = p_entity;
    IF FOUND THEN PERFORM app.integration_log(c, 'config_changed', c.status, c.status, format('%s records are no longer read from this database', initcap(v_label))); END IF;
    RETURN;
  END IF;
  v_problem := app.integration_record_source_problem(p_source);
  IF v_problem IS NOT NULL THEN RAISE EXCEPTION '%', v_problem USING ERRCODE = 'QM022'; END IF;
  INSERT INTO public.integration_record_sources (organisation_id, connection_id, entity_type, source, updated_by)
  VALUES (c.organisation_id, c.id, p_entity, p_source, auth.uid())
  ON CONFLICT (connection_id, entity_type) DO UPDATE SET source = EXCLUDED.source, updated_by = EXCLUDED.updated_by, updated_at = now()
   WHERE integration_record_sources.source IS DISTINCT FROM EXCLUDED.source;
  IF FOUND THEN
    PERFORM app.integration_log(c, 'config_changed', c.status, c.status,
      format('%s records are read from %s.%s', initcap(v_label), p_source ->> 'schema', p_source ->> 'object'));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Extraction jobs and the batches the agent sends
-- ---------------------------------------------------------------------------
ALTER TABLE public.integration_agent_jobs ADD CONSTRAINT integration_agent_jobs_id_org_key UNIQUE (id, organisation_id);
ALTER TABLE public.integration_agent_jobs ADD COLUMN run_id uuid;
ALTER TABLE public.integration_agent_jobs ADD CONSTRAINT integration_agent_jobs_run_fkey
  FOREIGN KEY (run_id, organisation_id) REFERENCES public.integration_sync_runs (id, organisation_id);
ALTER TABLE public.integration_agent_jobs ADD CONSTRAINT integration_agent_jobs_run_needed CHECK ((kind = 'extract') = (run_id IS NOT NULL));
CREATE UNIQUE INDEX integration_agent_jobs_run_key ON public.integration_agent_jobs (run_id) WHERE run_id IS NOT NULL;

CREATE TABLE public.integration_agent_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  job_id uuid NOT NULL,
  seq integer NOT NULL CHECK (seq BETWEEN 0 AND 100000),
  row_count integer NOT NULL CHECK (row_count BETWEEN 0 AND 1000),
  checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  last_key text CHECK (last_key IS NULL OR length(last_key) <= 2000),
  rows jsonb NOT NULL CHECK (jsonb_typeof(rows) = 'array'),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (job_id, seq),
  FOREIGN KEY (job_id, organisation_id) REFERENCES public.integration_agent_jobs (id, organisation_id) ON DELETE CASCADE
);
ALTER TABLE public.integration_agent_batches ENABLE ROW LEVEL SECURITY;
-- Rows from a customer's database: read by the sync engine through the run's lease only, never directly by anyone (as the agent's nonces).
REVOKE ALL ON public.integration_agent_batches FROM anon, authenticated;
GRANT SELECT ON public.integration_agent_batches TO authenticated;
CREATE POLICY integration_agent_batches_select ON public.integration_agent_batches FOR SELECT TO authenticated USING (false);

-- A run that stops (cancelled, failed, finished) stops its extraction too.
CREATE FUNCTION app.integration_run_stops_extract() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.status NOT IN ('queued', 'running') AND OLD.status IN ('queued', 'running') THEN
    UPDATE public.integration_agent_jobs
       SET status = 'cancelled', finished_at = clock_timestamp(), updated_at = clock_timestamp(), leased_until = NULL, error_kind = 'cancelled',
           error_message = CASE NEW.status WHEN 'cancelled' THEN 'The import was cancelled' ELSE 'The import has ended' END
     WHERE run_id = NEW.id AND status IN ('pending', 'received', 'running');
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER integration_sync_runs_stop_extract AFTER UPDATE OF status ON public.integration_sync_runs
  FOR EACH ROW EXECUTE FUNCTION app.integration_run_stops_extract();

-- What a finished job means: a stored password, a test result (AG2), and now an extraction that releases or fails its run.
CREATE OR REPLACE FUNCTION app.integration_agent_job_outcome() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.integration_connections%ROWTYPE; v_ok boolean; v_message text; r public.integration_sync_runs%ROWTYPE;
BEGIN
  IF NEW.status = OLD.status OR NEW.status NOT IN ('completed', 'failed', 'cancelled') OR NEW.connection_id IS NULL THEN RETURN NULL; END IF;
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
    IF c.last_tested_at IS NULL OR c.last_tested_at <= NEW.created_at THEN
      UPDATE public.integration_connections SET last_tested_at = NEW.created_at, last_test_ok = v_ok, last_test_message = nullif(v_message, '') WHERE id = c.id;
    END IF;
    PERFORM app.integration_log(c, 'tested', c.status, c.status, CASE WHEN v_ok THEN 'Passed' ELSE 'Failed: ' END || left(v_message, 300));
    IF NOT v_ok THEN PERFORM app.integration_recheck(c.id, 'The connection test failed'); END IF;
  ELSIF NEW.kind = 'extract' AND NEW.run_id IS NOT NULL THEN
    IF NEW.status = 'completed' THEN
      -- The rows are all here: the run can be worked at once.
      UPDATE public.integration_sync_runs SET next_attempt_at = now(), updated_at = now() WHERE id = NEW.run_id AND status IN ('queued', 'running');
    ELSE
      v_message := left(CASE WHEN NEW.status = 'cancelled' THEN coalesce(NEW.error_message, 'The extraction was cancelled')
                             ELSE 'The connector agent could not read the records: ' || coalesce(NEW.error_message, 'no reason given') END, 1000);
      UPDATE public.integration_sync_runs
         SET status = 'failed', attempts = attempts + 1, finished_at = now(), lease_owner = NULL, lease_until = NULL, error_summary = v_message, updated_at = now()
       WHERE id = NEW.run_id AND status IN ('queued', 'running')
       RETURNING * INTO r;
      IF FOUND THEN
        INSERT INTO public.integration_run_errors (organisation_id, run_id, attempt, kind, message, transient)
        VALUES (r.organisation_id, r.id, r.attempts,
                CASE NEW.error_kind WHEN 'auth' THEN 'auth' WHEN 'timeout' THEN 'timeout' WHEN 'lease_expired' THEN 'timeout' WHEN 'invalid' THEN 'malformed' ELSE 'internal' END,
                v_message, false);
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END $$;

-- The next job for the agent; an extraction that is taken again carries on from the first batch Fortress does not have.
CREATE OR REPLACE FUNCTION app.system_agent_next_job(p_agent uuid, p_lease_seconds integer DEFAULT 300) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.integration_agents%ROWTYPE; j public.integration_agent_jobs%ROWTYPE; v_resume jsonb;
BEGIN
  SELECT * INTO r FROM public.integration_agents WHERE id = p_agent;
  IF NOT FOUND OR r.status <> 'active' THEN RETURN NULL; END IF;
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
  IF j.kind = 'extract' THEN
    SELECT jsonb_build_object('nextSeq', count(*), 'rows', coalesce(sum(b.row_count), 0),
                              'afterKey', (SELECT b2.last_key FROM public.integration_agent_batches b2 WHERE b2.job_id = j.id ORDER BY b2.seq DESC LIMIT 1))
      INTO v_resume FROM public.integration_agent_batches b WHERE b.job_id = j.id;
  END IF;
  RETURN jsonb_strip_nulls(jsonb_build_object('id', j.id, 'kind', j.kind, 'spec', j.spec, 'attempt', j.attempts, 'leasedUntil', j.leased_until, 'resume', v_resume));
END $$;

-- The agent's reports on a job. Completing an extraction is refused unless Fortress holds every batch the agent says it sent.
CREATE OR REPLACE FUNCTION app.system_agent_job_report(p_agent uuid, p_job uuid, p_action text, p_payload jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE j public.integration_agent_jobs%ROWTYPE; v_transient boolean; v_kind text; v_message text; v_result jsonb; v_batches integer; v_rows bigint;
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
    v_result := p_payload -> 'result';
    IF j.kind = 'extract' THEN
      SELECT count(*), coalesce(sum(row_count), 0) INTO v_batches, v_rows FROM public.integration_agent_batches WHERE job_id = j.id;
      IF jsonb_typeof(v_result -> 'batches') IS DISTINCT FROM 'number' OR (v_result ->> 'batches')::numeric <> v_batches
         OR jsonb_typeof(v_result -> 'rows') IS DISTINCT FROM 'number' OR (v_result ->> 'rows')::numeric <> v_rows THEN
        RAISE EXCEPTION 'The agent says it sent % batches (% rows), but Fortress holds % (% rows): send the missing ones again',
          coalesce(v_result ->> 'batches', '?'), coalesce(v_result ->> 'rows', '?'), v_batches, v_rows USING ERRCODE = 'QM022';
      END IF;
      v_result := jsonb_strip_nulls(jsonb_build_object('batches', v_batches, 'rows', v_rows,
                    'columns', CASE WHEN jsonb_typeof(v_result -> 'columns') = 'array' THEN v_result -> 'columns' END,
                    'truncated', CASE WHEN jsonb_typeof(v_result -> 'truncated') = 'boolean' THEN v_result -> 'truncated' END));
    END IF;
    UPDATE public.integration_agent_jobs
       SET status = 'completed', started_at = coalesce(started_at, clock_timestamp()), finished_at = clock_timestamp(), updated_at = clock_timestamp(),
           leased_until = NULL, result = v_result, error_kind = NULL, error_message = NULL,
           progress = CASE WHEN j.kind = 'extract' THEN jsonb_build_object('batches', v_batches, 'rows', v_rows) ELSE progress END
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

-- One batch of rows from the agent. The API has inflated it, checked its size and its checksum; this keeps it once, in order.
CREATE FUNCTION app.system_agent_store_batch(p_agent uuid, p_job uuid, p_seq integer, p_checksum text, p_last_key text, p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE j public.integration_agent_jobs%ROWTYPE; b public.integration_agent_batches%ROWTYPE; v_count integer; v_rows bigint; v_max integer; v_n integer;
BEGIN
  SELECT * INTO j FROM public.integration_agent_jobs WHERE id = p_job AND agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Job not found' USING ERRCODE = 'P0002'; END IF;
  IF j.kind <> 'extract' THEN RAISE EXCEPTION 'Only an extraction job takes rows' USING ERRCODE = 'QM022'; END IF;
  IF j.status IN ('completed', 'failed', 'cancelled') THEN
    RETURN jsonb_build_object('status', j.status, 'cancelled', j.status = 'cancelled', 'stored', false);
  END IF;
  IF j.status = 'pending' THEN RAISE EXCEPTION 'Take the job again before sending its rows' USING ERRCODE = 'QM022'; END IF;
  IF p_seq IS NULL OR p_seq < 0 THEN RAISE EXCEPTION 'A batch needs its sequence number' USING ERRCODE = 'QM022'; END IF;
  IF p_checksum IS NULL OR p_checksum !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'A batch needs its checksum' USING ERRCODE = 'QM022'; END IF;
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'A batch''s rows are a list' USING ERRCODE = 'QM022'; END IF;
  v_n := jsonb_array_length(p_rows);
  IF v_n > 1000 THEN RAISE EXCEPTION 'A batch holds at most 1,000 rows' USING ERRCODE = 'QM022'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) e WHERE jsonb_typeof(e) <> 'object') THEN RAISE EXCEPTION 'Each row is an object of column values' USING ERRCODE = 'QM022'; END IF;
  SELECT * INTO b FROM public.integration_agent_batches WHERE job_id = j.id AND seq = p_seq;
  IF FOUND THEN
    IF b.checksum <> p_checksum THEN RAISE EXCEPTION 'Batch % was already received with different rows', p_seq USING ERRCODE = 'QM022'; END IF;
    SELECT count(*), coalesce(sum(row_count), 0) INTO v_count, v_rows FROM public.integration_agent_batches WHERE job_id = j.id;
    RETURN jsonb_build_object('status', j.status, 'cancelled', false, 'stored', false, 'duplicate', true, 'batches', v_count, 'rows', v_rows);
  END IF;
  SELECT count(*), coalesce(sum(row_count), 0) INTO v_count, v_rows FROM public.integration_agent_batches WHERE job_id = j.id;
  IF p_seq <> v_count THEN RAISE EXCEPTION 'Batch % was expected next, not batch %', v_count, p_seq USING ERRCODE = 'QM022'; END IF;
  v_max := CASE WHEN jsonb_typeof(j.spec -> 'request' -> 'maxRows') = 'number' THEN (j.spec -> 'request' ->> 'maxRows')::integer END;
  IF v_max IS NOT NULL AND v_rows + v_n > v_max THEN RAISE EXCEPTION 'This extraction reads at most % rows', v_max USING ERRCODE = 'QM022'; END IF;
  INSERT INTO public.integration_agent_batches (organisation_id, job_id, seq, row_count, checksum, last_key, rows)
  VALUES (j.organisation_id, j.id, p_seq, v_n, p_checksum, left(p_last_key, 2000), p_rows);
  UPDATE public.integration_agent_jobs
     SET status = 'running', started_at = coalesce(started_at, clock_timestamp()), updated_at = clock_timestamp(),
         progress = jsonb_build_object('batches', v_count + 1, 'rows', v_rows + v_n),
         leased_until = greatest(leased_until, now() + interval '5 minutes')
   WHERE id = j.id;
  RETURN jsonb_build_object('status', 'running', 'cancelled', false, 'stored', true, 'batches', v_count + 1, 'rows', v_rows + v_n);
END $$;

-- The sync engine reads one batch of the run it holds the lease on (as it reads a file's chunks).
CREATE FUNCTION app.system_integration_agent_batch(p_org uuid, p_run uuid, p_owner uuid, p_seq integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.integration_sync_runs%ROWTYPE; v_rows jsonb;
BEGIN
  r := app.integration_run_for_system(p_org, p_run, p_owner);
  SELECT b.rows INTO v_rows
    FROM public.integration_agent_jobs j JOIN public.integration_agent_batches b ON b.job_id = j.id
   WHERE j.run_id = r.id AND j.organisation_id = p_org AND j.kind = 'extract' AND b.seq = p_seq;
  RETURN v_rows;
END $$;

-- ---------------------------------------------------------------------------
-- Runs from a database connection
-- ---------------------------------------------------------------------------
-- The latest definition (20260122100000) plus the database connection branch: a run needs the table its kind of record is read from and an
-- agent able to read it, and it comes with its extraction job.
CREATE OR REPLACE FUNCTION app.request_integration_run(p_connection uuid, p_entity text, p_kind text, p_file uuid DEFAULT NULL, p_template uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.integration_connections%ROWTYPE; v_provider text; v_cursor text; v_id uuid; v_mapping uuid; f public.integration_files%ROWTYPE;
        t public.integration_templates%ROWTYPE; tv public.integration_template_versions%ROWTYPE; v_settings jsonb; v_source jsonb; v_problems text[];
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
  IF v_provider = 'sql_agent' THEN
    IF p_kind = 'incremental' THEN RAISE EXCEPTION 'A database is read whole for now: choose a full import' USING ERRCODE = 'QM022'; END IF;
    SELECT source INTO v_source FROM public.integration_record_sources WHERE connection_id = c.id AND entity_type = p_entity;
    IF v_source IS NULL THEN
      RAISE EXCEPTION 'This connection does not say which table holds % records: choose it on the connection''s page', replace(p_entity, '_', ' ') USING ERRCODE = 'QM022';
    END IF;
    v_problems := app.integration_agent_problems(c.id);
    IF coalesce(array_length(v_problems, 1), 0) > 0 THEN RAISE EXCEPTION '%', v_problems[1] USING ERRCODE = 'QM022'; END IF;
  END IF;
  PERFORM app.integration_assert_idle(c.id, p_entity);
  IF p_kind = 'incremental' THEN
    SELECT cursor INTO v_cursor FROM public.integration_sync_cursors WHERE connection_id = c.id AND entity_type = p_entity;
  END IF;
  INSERT INTO public.integration_sync_runs (organisation_id, connection_id, entity_type, kind, requested_by, cursor_start, cursor_next, file_id, mapping_id, template_version_id, settings)
  VALUES (c.organisation_id, c.id, p_entity, p_kind, auth.uid(), v_cursor, v_cursor, p_file, v_mapping, tv.id, v_settings)
  RETURNING id INTO v_id;
  IF v_provider = 'sql_agent' THEN
    -- A preview reads the first 1,000 rows; an import reads the whole table, a batch of up to 1,000 rows at a time.
    INSERT INTO public.integration_agent_jobs (organisation_id, agent_id, connection_id, run_id, kind, spec, max_attempts, requested_by)
    VALUES (c.organisation_id, c.agent_id, c.id, v_id, 'extract',
            jsonb_build_object('connectionId', c.id, 'runId', v_id, 'entityType', p_entity, 'connection', c.config,
                               'request', v_source || jsonb_strip_nulls(jsonb_build_object('batchRows', 1000, 'maxRows', CASE WHEN p_kind = 'preview' THEN 1000 END))),
            3, auth.uid());
    UPDATE public.integration_agents SET fast_poll_until = greatest(coalesce(fast_poll_until, now()), now() + interval '10 minutes') WHERE id = c.agent_id;
  END IF;
  RETURN v_id;
END $$;

-- The latest definition (20260119100000) plus: a run whose extraction is still under way is not leased (it is waiting for the agent), and a run
-- whose extraction is complete hands the engine the number of batches to read.
CREATE OR REPLACE FUNCTION app.system_lease_integration_run(p_org uuid, p_run uuid, p_owner uuid, p_seconds integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.integration_sync_runs%ROWTYPE; c public.integration_connections%ROWTYPE; v_provider text; m public.integration_mappings%ROWTYPE; f public.integration_files%ROWTYPE;
        tv public.integration_template_versions%ROWTYPE; v_mapping jsonb; j public.integration_agent_jobs%ROWTYPE;
BEGIN
  IF p_owner IS NULL OR p_seconds IS NULL OR p_seconds NOT BETWEEN 5 AND 600 THEN RAISE EXCEPTION 'A lease needs an owner and 5 to 600 seconds' USING ERRCODE = 'QM022'; END IF;
  SELECT * INTO r FROM public.integration_sync_runs WHERE id = p_run AND organisation_id = p_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Import not found' USING ERRCODE = 'P0002'; END IF;
  IF r.status NOT IN ('queued', 'running') THEN RETURN jsonb_build_object('leased', false, 'reason', 'This import has finished'); END IF;
  IF r.lease_until > clock_timestamp() AND r.lease_owner IS DISTINCT FROM p_owner THEN RETURN jsonb_build_object('leased', false, 'reason', 'This import is being worked on already'); END IF;
  SELECT * INTO j FROM public.integration_agent_jobs WHERE run_id = r.id AND organisation_id = p_org AND kind = 'extract';
  IF FOUND AND NOT r.fetch_done AND j.status <> 'completed' THEN
    IF j.status IN ('pending', 'received', 'running') THEN
      RETURN jsonb_build_object('leased', false, 'waitingForAgent', true,
        'reason', CASE WHEN j.status = 'pending' THEN 'Waiting for the connector agent to take the job'
                       ELSE format('Waiting for the connector agent: %s rows read so far', coalesce((j.progress ->> 'rows')::bigint, 0)) END);
    END IF;
    RETURN jsonb_build_object('leased', false, 'reason', coalesce(j.error_message, 'The connector agent could not read the records'));
  END IF;
  IF r.next_attempt_at > now() THEN RETURN jsonb_build_object('leased', false, 'reason', 'Waiting to try again', 'nextAttemptAt', r.next_attempt_at); END IF;
  SELECT * INTO c FROM public.integration_connections WHERE id = r.connection_id AND organisation_id = p_org;
  IF c.status = 'retired' THEN
    UPDATE public.integration_sync_runs SET status = 'cancelled', cancel_reason = 'The connection was retired', finished_at = now(), lease_owner = NULL, lease_until = NULL, updated_at = now() WHERE id = r.id;
    UPDATE public.integration_inbox SET retry_run_id = NULL, updated_at = now() WHERE retry_run_id = r.id AND status = 'failed';
    RETURN jsonb_build_object('leased', false, 'reason', 'The connection was retired');
  END IF;
  IF r.kind <> 'preview' AND c.status <> 'active' THEN RETURN jsonb_build_object('leased', false, 'reason', 'The connection is not active'); END IF;
  SELECT key INTO v_provider FROM public.integration_providers WHERE id = c.provider_id;
  IF r.template_version_id IS NOT NULL THEN
    SELECT * INTO tv FROM public.integration_template_versions WHERE id = r.template_version_id AND organisation_id = p_org;
    v_mapping := jsonb_build_object('id', tv.id, 'version', tv.version, 'keyField', tv.key_field, 'fields', tv.fields, 'templateId', tv.template_id);
  ELSIF r.mapping_id IS NOT NULL THEN
    SELECT * INTO m FROM public.integration_mappings WHERE id = r.mapping_id AND organisation_id = p_org;
    v_mapping := jsonb_build_object('id', m.id, 'version', m.version, 'keyField', m.key_field, 'fields', m.fields);
  END IF;
  IF r.file_id IS NOT NULL THEN SELECT * INTO f FROM public.integration_files WHERE id = r.file_id AND organisation_id = p_org; END IF;
  UPDATE public.integration_sync_runs
     SET status = 'running', lease_owner = p_owner, lease_until = clock_timestamp() + make_interval(secs => p_seconds), started_at = coalesce(started_at, now()), updated_at = now()
   WHERE id = r.id;
  RETURN jsonb_build_object('leased', true, 'id', r.id, 'organisationId', r.organisation_id, 'connectionId', r.connection_id, 'providerKey', v_provider,
    'config', c.config, 'externalSystem', c.external_system, 'entityType', r.entity_type, 'kind', r.kind, 'cursor', r.cursor_next, 'fetchDone', r.fetch_done,
    'requestedBy', r.requested_by, 'recordsTotal', r.records_total, 'attempts', r.attempts,
    'settings', coalesce(r.settings, app.integration_settings_for(r.connection_id, r.entity_type)),
    'file', CASE WHEN f.id IS NULL THEN NULL ELSE jsonb_build_object('id', f.id, 'status', f.status, 'chunkCount', f.chunk_count, 'headers', to_jsonb(f.headers)) END,
    'agent', CASE WHEN j.id IS NULL THEN NULL ELSE jsonb_build_object('jobId', j.id, 'batchCount', coalesce((j.result ->> 'batches')::integer, 0)) END,
    'mapping', v_mapping);
END $$;

-- Runs due to be worked: not those still waiting for their agent (the job's completion makes them due).
CREATE OR REPLACE FUNCTION app.system_integration_runs_due(p_limit integer DEFAULT 10) RETURNS TABLE (organisation_id uuid, run_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT r.organisation_id, r.id FROM public.integration_sync_runs r
   WHERE r.status IN ('queued', 'running') AND r.next_attempt_at <= now() AND (r.lease_until IS NULL OR r.lease_until < now())
     AND NOT EXISTS (SELECT 1 FROM public.integration_agent_jobs j WHERE j.run_id = r.id AND j.status IN ('pending', 'received', 'running'))
   ORDER BY r.requested_at
   LIMIT least(greatest(coalesce(p_limit, 10), 1), 100)
$$;

-- The latest definition (20260110100000) plus: batches are cleared seven days after their job ended (the import's staging keeps what it needs).
CREATE OR REPLACE FUNCTION app.system_purge_integration_payloads(p_days integer DEFAULT 90) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n integer; m integer; b integer;
BEGIN
  IF p_days IS NULL OR p_days < 7 THEN RAISE EXCEPTION 'Keep payloads for at least 7 days' USING ERRCODE = 'QM022'; END IF;
  UPDATE public.integration_inbox SET payload = NULL, canonical = NULL, payload_purged_at = now(), updated_at = now()
   WHERE created_at < now() - make_interval(days => p_days) AND status <> 'failed' AND payload_purged_at IS NULL AND (payload IS NOT NULL OR canonical IS NOT NULL);
  GET DIAGNOSTICS n = ROW_COUNT;
  WITH old AS (
    SELECT f.id FROM public.integration_files f
     WHERE f.uploaded_at < now() - make_interval(days => p_days) AND f.status IN ('parsed', 'uploaded')
       AND NOT EXISTS (SELECT 1 FROM public.integration_sync_runs r WHERE r.file_id = f.id AND r.status IN ('queued', 'running'))
  ), gone AS (
    DELETE FROM public.integration_file_chunks k USING old WHERE k.file_id = old.id RETURNING k.file_id
  )
  UPDATE public.integration_files f SET status = 'purged', purged_at = now(), updated_at = now() FROM old WHERE f.id = old.id;
  GET DIAGNOSTICS m = ROW_COUNT;
  DELETE FROM public.integration_agent_batches x USING public.integration_agent_jobs j
   WHERE x.job_id = j.id AND j.status IN ('completed', 'failed', 'cancelled') AND j.finished_at < now() - interval '7 days'
     AND NOT EXISTS (SELECT 1 FROM public.integration_sync_runs r WHERE r.id = j.run_id AND r.status IN ('queued', 'running'));
  GET DIAGNOSTICS b = ROW_COUNT;
  RETURN n + m + b;
END $$;

REVOKE ALL ON FUNCTION app.integration_db_name_ok(jsonb), app.integration_record_source_problem(jsonb), app.set_integration_record_source(uuid, text, jsonb),
  app.integration_run_stops_extract(), app.system_agent_store_batch(uuid, uuid, integer, text, text, jsonb), app.system_integration_agent_batch(uuid, uuid, uuid, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.integration_db_name_ok(jsonb), app.integration_record_source_problem(jsonb), app.set_integration_record_source(uuid, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION app.system_agent_store_batch(uuid, uuid, integer, text, text, jsonb), app.system_integration_agent_batch(uuid, uuid, uuid, integer) TO qms_api;
