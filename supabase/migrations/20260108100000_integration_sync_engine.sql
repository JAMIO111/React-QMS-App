-- Integrations, slice IN2 (docs/connectors-plan.md): the sync engine's database layer.
--  * integration_sync_runs: the queue and the record of each import. A run is requested by a person (preview, full, incremental, or a retry of failed rows),
--    then leased and worked through in short batches by the API (no worker: "Run now" and a cron route drain it). One queued or running run per connection and
--    entity. The plan's separate jobs and runs tables are one table here: a run is queued, leased, resumed and finished, and its attempts are counted on it.
--  * integration_inbox: staging, one row per source record per run (payload, the mapped record, its content hash, status, errors). Rows are applied one at a time
--    by the API, each in its own savepoint, so one bad row never rolls back the others. A failed row stays for a retry; a later applied or unchanged copy of the
--    same record supersedes it. Not audited (high volume; it is itself the record of what arrived), payloads purged after 90 days except failed rows.
--  * integration_external_records: the map (organisation, connection, entity type, external id) -> QMS record and the content hash last applied. Written only on
--    create or when the hash changes, so an unchanged record writes nothing at all (the idempotency core).
--  * integration_sync_cursors: per connection and entity, the cursor of the last finished full or incremental run (advanced only when the run finishes).
--  * integration_run_errors: run-level failures (fetch, limits); transient ones back off and retry, up to five attempts.
--  Audited: the map and the cursors (they say which QMS record each source record became). The runs, inbox and errors are themselves the record of the work
--  (who asked, what arrived, what happened) and change on every batch, so they carry no audit trigger.
--  * audit.record_change: work done by the API login for an integration (app.source = 'integration') records the person who started or approved the run
--    (app.initiating_user) as the actor, so every import says who it was for. A signed-in person is always their own actor.
--  People request, retry and cancel runs (integrations.run); the runner functions (app.system_*) are executable by the API login only, take the organisation id and
--  re-check that the run belongs to it and that the caller holds the lease. No table writes at all. Errors QM022 -> 409 integration_rule; P0002 -> 404.

-- ---------------------------------------------------------------------------
-- Audit actor for integration work
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit.record_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  old_row jsonb := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) END;
  new_row jsonb := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) END;
  row_data jsonb := coalesce(new_row, old_row);
  org_source text := TG_ARGV[0];
  id_source text := coalesce(TG_ARGV[1], 'id');
  v_org uuid;
  v_entity_id text;
  v_changed text[];
  v_prev jsonb;
  v_new jsonb;
  v_actor uuid := auth.uid();
BEGIN
  IF org_source = 'via_role' THEN
    SELECT r.organisation_id INTO v_org FROM public.roles r WHERE r.id = (row_data ->> 'role_id')::uuid;
  ELSE
    v_org := (row_data ->> org_source)::uuid;
  END IF;

  -- System role templates (and permissions of roles already removed) belong to no organisation.
  IF v_org IS NULL THEN
    RETURN NULL;
  END IF;

  -- Integration work runs on the API login with no signed-in person: the person who started or approved the run is the actor.
  IF v_actor IS NULL AND current_setting('app.source', true) = 'integration' THEN
    v_actor := nullif(current_setting('app.initiating_user', true), '')::uuid;
  END IF;

  v_entity_id := CASE id_source
    WHEN 'role_permission' THEN (row_data ->> 'role_id') || ':' || (row_data ->> 'permission_code')
    ELSE row_data ->> id_source END;

  IF TG_OP = 'UPDATE' THEN
    SELECT array_agg(k ORDER BY k) INTO v_changed
    FROM jsonb_object_keys(new_row) k
    WHERE new_row -> k IS DISTINCT FROM old_row -> k
      AND k NOT IN ('updated_at', 'updated_by');
    IF v_changed IS NULL THEN
      RETURN NULL;  -- nothing but bookkeeping changed
    END IF;
    SELECT jsonb_object_agg(k, old_row -> k), jsonb_object_agg(k, new_row -> k)
      INTO v_prev, v_new
    FROM unnest(v_changed) k;
  ELSE
    v_prev := old_row;
    v_new := new_row;
  END IF;

  INSERT INTO audit.events (organisation_id, actor_user_id, entity_type, entity_id, action,
                            previous_values, new_values, changed_fields, reason, source, correlation_id)
  VALUES (
    v_org,
    v_actor,
    TG_TABLE_NAME,
    v_entity_id,
    lower(TG_OP),
    v_prev,
    v_new,
    v_changed,
    nullif(current_setting('app.reason', true), ''),
    coalesce(nullif(current_setting('app.source', true), ''), CASE WHEN auth.uid() IS NULL THEN 'system' ELSE 'client' END),
    nullif(current_setting('app.correlation_id', true), '')
  );
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION audit.record_change() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
-- The kinds of record a connection can bring (plan §7). Each arrives with its importer (IN4–IN6); a run for one with no importer is refused by the API.
CREATE FUNCTION app.integration_entity_types() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT ARRAY['supplier', 'customer', 'part', 'production_order', 'purchase_order', 'goods_receipt']
$$;

CREATE TABLE public.integration_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id),
  connection_id uuid NOT NULL,
  entity_type text NOT NULL CHECK (entity_type = ANY (app.integration_entity_types())),
  kind text NOT NULL CHECK (kind IN ('preview', 'full', 'incremental', 'retry')),
  trigger text NOT NULL DEFAULT 'user' CHECK (trigger IN ('user', 'schedule')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled')),
  requested_by uuid,
  requested_at timestamptz NOT NULL DEFAULT now(),
  cursor_start text,
  cursor_next text,
  fetch_done boolean NOT NULL DEFAULT false,
  records_total integer NOT NULL DEFAULT 0,
  rejected integer NOT NULL DEFAULT 0,
  unchanged integer NOT NULL DEFAULT 0,
  created integer NOT NULL DEFAULT 0,
  updated integer NOT NULL DEFAULT 0,
  failed integer NOT NULL DEFAULT 0,
  superseded integer NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_owner uuid,
  lease_until timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  error_summary text,
  cancel_reason text,
  cancelled_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT integration_sync_runs_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT integration_sync_runs_connection_fkey FOREIGN KEY (connection_id, organisation_id) REFERENCES public.integration_connections (id, organisation_id)
);
-- One import of a kind of record per connection at a time (plan §8: per-organisation concurrency).
CREATE UNIQUE INDEX integration_sync_runs_one_active ON public.integration_sync_runs (connection_id, entity_type) WHERE status IN ('queued', 'running');
CREATE INDEX integration_sync_runs_connection_idx ON public.integration_sync_runs (connection_id, requested_at DESC);
CREATE INDEX integration_sync_runs_due_idx ON public.integration_sync_runs (next_attempt_at) WHERE status IN ('queued', 'running');

CREATE TABLE public.integration_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id),
  connection_id uuid NOT NULL,
  run_id uuid NOT NULL,
  entity_type text NOT NULL CHECK (entity_type = ANY (app.integration_entity_types())),
  external_id text CHECK (external_id IS NULL OR length(external_id) BETWEEN 1 AND 200),
  source_row integer,
  payload jsonb,
  canonical jsonb,
  content_hash text,
  status text NOT NULL CHECK (status IN ('staged', 'previewed', 'unchanged', 'applied', 'rejected', 'failed', 'superseded')),
  action text CHECK (action IN ('create', 'update')),
  internal_id uuid,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  attempts integer NOT NULL DEFAULT 0,
  retry_run_id uuid,
  last_run_id uuid NOT NULL,
  applied_at timestamptz,
  payload_purged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT integration_inbox_run_fkey FOREIGN KEY (run_id, organisation_id) REFERENCES public.integration_sync_runs (id, organisation_id),
  CONSTRAINT integration_inbox_connection_fkey FOREIGN KEY (connection_id, organisation_id) REFERENCES public.integration_connections (id, organisation_id)
);
-- A record appears once per run (a second copy in the same import is rejected).
CREATE UNIQUE INDEX integration_inbox_run_external ON public.integration_inbox (run_id, external_id) WHERE status <> 'rejected' AND external_id IS NOT NULL;
CREATE INDEX integration_inbox_run_status_idx ON public.integration_inbox (run_id, status);
CREATE INDEX integration_inbox_record_idx ON public.integration_inbox (connection_id, entity_type, external_id, created_at);
CREATE INDEX integration_inbox_retry_idx ON public.integration_inbox (retry_run_id) WHERE retry_run_id IS NOT NULL;
CREATE INDEX integration_inbox_failed_idx ON public.integration_inbox (connection_id, entity_type) WHERE status = 'failed';

CREATE TABLE public.integration_external_records (
  organisation_id uuid NOT NULL REFERENCES public.organisations (id),
  connection_id uuid NOT NULL,
  entity_type text NOT NULL CHECK (entity_type = ANY (app.integration_entity_types())),
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
  internal_id uuid NOT NULL,
  content_hash text NOT NULL,
  first_run_id uuid NOT NULL,
  last_run_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, connection_id, entity_type, external_id),
  CONSTRAINT integration_external_records_internal_key UNIQUE (organisation_id, connection_id, entity_type, internal_id),
  CONSTRAINT integration_external_records_connection_fkey FOREIGN KEY (connection_id, organisation_id) REFERENCES public.integration_connections (id, organisation_id)
);
CREATE INDEX integration_external_records_internal_idx ON public.integration_external_records (internal_id);

CREATE TABLE public.integration_sync_cursors (
  organisation_id uuid NOT NULL REFERENCES public.organisations (id),
  connection_id uuid NOT NULL,
  entity_type text NOT NULL CHECK (entity_type = ANY (app.integration_entity_types())),
  cursor text,
  run_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, entity_type),
  CONSTRAINT integration_sync_cursors_connection_fkey FOREIGN KEY (connection_id, organisation_id) REFERENCES public.integration_connections (id, organisation_id)
);

CREATE TABLE public.integration_run_errors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id),
  run_id uuid NOT NULL,
  attempt integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('auth', 'rate_limit', 'malformed', 'mapping', 'transient', 'timeout', 'limit', 'internal')),
  message text NOT NULL,
  transient boolean NOT NULL,
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT integration_run_errors_run_fkey FOREIGN KEY (run_id, organisation_id) REFERENCES public.integration_sync_runs (id, organisation_id)
);
CREATE INDEX integration_run_errors_run_idx ON public.integration_run_errors (run_id, at);
CREATE FUNCTION app.integration_run_error_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'An import error on record is never changed or removed' USING ERRCODE = 'QM022';
END $$;
REVOKE ALL ON FUNCTION app.integration_run_error_frozen() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER integration_run_errors_frozen BEFORE UPDATE OR DELETE ON public.integration_run_errors FOR EACH ROW EXECUTE FUNCTION app.integration_run_error_frozen();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['integration_sync_runs', 'integration_inbox', 'integration_external_records', 'integration_sync_cursors', 'integration_run_errors'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (app.has_permission(organisation_id, %L))', t || '_select', t, 'integrations.read');
  END LOOP;
END $$;
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.integration_external_records FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id', 'internal_id');
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.integration_sync_cursors FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id', 'connection_id');

-- ---------------------------------------------------------------------------
-- What people do: request, retry, cancel
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.integration_assert_entity(p_entity text) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
BEGIN
  IF p_entity IS NULL OR NOT (p_entity = ANY (app.integration_entity_types())) THEN
    RAISE EXCEPTION 'Choose what to import: suppliers, customers, parts, production orders, purchase orders or goods receipts' USING ERRCODE = 'QM022';
  END IF;
END $$;

CREATE FUNCTION app.integration_assert_idle(p_connection uuid, p_entity text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.integration_sync_runs WHERE connection_id = p_connection AND entity_type = p_entity AND status IN ('queued', 'running')) THEN
    RAISE EXCEPTION 'An import of these records is already queued or running on this connection' USING ERRCODE = 'QM022';
  END IF;
END $$;

-- Ask for an import. A preview can run before the connection is active (nothing is written); a real import needs an active connection.
CREATE FUNCTION app.request_integration_run(p_connection uuid, p_entity text, p_kind text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.integration_connections%ROWTYPE; v_cursor text; v_id uuid;
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
  PERFORM app.integration_assert_idle(c.id, p_entity);
  IF p_kind = 'incremental' THEN
    SELECT cursor INTO v_cursor FROM public.integration_sync_cursors WHERE connection_id = c.id AND entity_type = p_entity;
  END IF;
  INSERT INTO public.integration_sync_runs (organisation_id, connection_id, entity_type, kind, requested_by, cursor_start, cursor_next)
  VALUES (c.organisation_id, c.id, p_entity, p_kind, auth.uid(), v_cursor, v_cursor)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Try failed rows again (all of a kind of record on the connection, or the ones named). Each is applied afresh against the current map.
CREATE FUNCTION app.retry_integration_rows(p_connection uuid, p_entity text, p_rows uuid[] DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.integration_connections%ROWTYPE; v_id uuid; n integer;
BEGIN
  c := app.integration_connection_for_write(p_connection, 'integrations.run');
  PERFORM app.integration_assert_entity(p_entity);
  IF c.status <> 'active' THEN RAISE EXCEPTION 'Only an active connection can import records' USING ERRCODE = 'QM022'; END IF;
  PERFORM app.integration_assert_idle(c.id, p_entity);
  INSERT INTO public.integration_sync_runs (organisation_id, connection_id, entity_type, kind, requested_by, fetch_done)
  VALUES (c.organisation_id, c.id, p_entity, 'retry', auth.uid(), true)
  RETURNING id INTO v_id;
  UPDATE public.integration_inbox SET retry_run_id = v_id, updated_at = now()
   WHERE connection_id = c.id AND entity_type = p_entity AND status = 'failed' AND (p_rows IS NULL OR id = ANY (p_rows));
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN RAISE EXCEPTION 'There are no failed rows to retry' USING ERRCODE = 'QM022'; END IF;
  UPDATE public.integration_sync_runs SET records_total = n WHERE id = v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION app.cancel_integration_run(p_run uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.integration_sync_runs%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.integration_sync_runs WHERE id = p_run FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(r.organisation_id) THEN RAISE EXCEPTION 'Import not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(r.organisation_id, 'integrations.run') THEN RAISE EXCEPTION 'You are not allowed to do that with integrations' USING ERRCODE = '42501'; END IF;
  IF r.status NOT IN ('queued', 'running') THEN RAISE EXCEPTION 'Only a queued or running import can be cancelled' USING ERRCODE = 'QM022'; END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 3 THEN RAISE EXCEPTION 'Say why the import is cancelled' USING ERRCODE = 'QM022'; END IF;
  UPDATE public.integration_sync_runs
     SET status = 'cancelled', cancel_reason = left(btrim(p_reason), 1000), cancelled_by = auth.uid(), finished_at = now(), lease_owner = NULL, lease_until = NULL, updated_at = now()
   WHERE id = r.id;
  UPDATE public.integration_inbox SET retry_run_id = NULL, updated_at = now() WHERE retry_run_id = r.id AND status = 'failed';
END $$;

-- ---------------------------------------------------------------------------
-- The runner (API login only). Every function takes the organisation, re-checks the run belongs to it and, except leasing, that the caller holds the lease.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.integration_run_for_system(p_org uuid, p_run uuid, p_owner uuid) RETURNS public.integration_sync_runs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.integration_sync_runs%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.integration_sync_runs WHERE id = p_run AND organisation_id = p_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Import not found' USING ERRCODE = 'P0002'; END IF;
  IF r.status <> 'running' OR r.lease_owner IS DISTINCT FROM p_owner OR r.lease_until IS NULL OR r.lease_until < clock_timestamp() THEN
    RAISE EXCEPTION 'The lease on this import was lost' USING ERRCODE = 'QM022';
  END IF;
  RETURN r;
END $$;

-- Runs waiting for work, oldest first, across organisations (for the cron route).
CREATE FUNCTION app.system_integration_runs_due(p_limit integer DEFAULT 10) RETURNS TABLE (organisation_id uuid, run_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT r.organisation_id, r.id FROM public.integration_sync_runs r
   WHERE r.status IN ('queued', 'running') AND r.next_attempt_at <= now() AND (r.lease_until IS NULL OR r.lease_until < now())
   ORDER BY r.requested_at
   LIMIT least(greatest(coalesce(p_limit, 10), 1), 100)
$$;

-- Take the run for a while. Answers {leased: false, reason} when it cannot be worked on now (finished, held by someone else, waiting to retry, connection paused).
CREATE FUNCTION app.system_lease_integration_run(p_org uuid, p_run uuid, p_owner uuid, p_seconds integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.integration_sync_runs%ROWTYPE; c public.integration_connections%ROWTYPE; v_provider text;
BEGIN
  IF p_owner IS NULL OR p_seconds IS NULL OR p_seconds NOT BETWEEN 5 AND 600 THEN RAISE EXCEPTION 'A lease needs an owner and 5 to 600 seconds' USING ERRCODE = 'QM022'; END IF;
  SELECT * INTO r FROM public.integration_sync_runs WHERE id = p_run AND organisation_id = p_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Import not found' USING ERRCODE = 'P0002'; END IF;
  IF r.status NOT IN ('queued', 'running') THEN RETURN jsonb_build_object('leased', false, 'reason', 'This import has finished'); END IF;
  IF r.lease_until > clock_timestamp() AND r.lease_owner IS DISTINCT FROM p_owner THEN RETURN jsonb_build_object('leased', false, 'reason', 'This import is being worked on already'); END IF;
  IF r.next_attempt_at > now() THEN RETURN jsonb_build_object('leased', false, 'reason', 'Waiting to try again', 'nextAttemptAt', r.next_attempt_at); END IF;
  SELECT * INTO c FROM public.integration_connections WHERE id = r.connection_id AND organisation_id = p_org;
  IF c.status = 'retired' THEN
    UPDATE public.integration_sync_runs SET status = 'cancelled', cancel_reason = 'The connection was retired', finished_at = now(), lease_owner = NULL, lease_until = NULL, updated_at = now() WHERE id = r.id;
    UPDATE public.integration_inbox SET retry_run_id = NULL, updated_at = now() WHERE retry_run_id = r.id AND status = 'failed';
    RETURN jsonb_build_object('leased', false, 'reason', 'The connection was retired');
  END IF;
  IF r.kind <> 'preview' AND c.status <> 'active' THEN RETURN jsonb_build_object('leased', false, 'reason', 'The connection is not active'); END IF;
  SELECT key INTO v_provider FROM public.integration_providers WHERE id = c.provider_id;
  UPDATE public.integration_sync_runs
     SET status = 'running', lease_owner = p_owner, lease_until = clock_timestamp() + make_interval(secs => p_seconds), started_at = coalesce(started_at, now()), updated_at = now()
   WHERE id = r.id;
  RETURN jsonb_build_object('leased', true, 'id', r.id, 'organisationId', r.organisation_id, 'connectionId', r.connection_id, 'providerKey', v_provider,
    'config', c.config, 'externalSystem', c.external_system, 'entityType', r.entity_type, 'kind', r.kind, 'cursor', r.cursor_next, 'fetchDone', r.fetch_done,
    'requestedBy', r.requested_by, 'recordsTotal', r.records_total, 'attempts', r.attempts);
END $$;

-- Stage one fetched page. Each record: {externalId, sourceRow?, payload (object), canonical? (the mapped record), errors? (validation problems: the row is rejected)}.
-- The content hash is worked out here, over the mapped record (or the payload when there is no mapping yet), and compared with the map: the same hash is
-- `unchanged` and nothing is written for it. A preview only says what would be created or updated.
CREATE FUNCTION app.system_stage_integration_records(p_org uuid, p_run uuid, p_owner uuid, p_records jsonb, p_next_cursor text, p_done boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.integration_sync_runs%ROWTYPE; n_total integer; n_rejected integer; n_unchanged integer; n_create integer; n_update integer; n_superseded integer := 0;
BEGIN
  r := app.integration_run_for_system(p_org, p_run, p_owner);
  IF r.kind = 'retry' OR r.fetch_done THEN RAISE EXCEPTION 'Nothing more is fetched for this import' USING ERRCODE = 'QM022'; END IF;
  IF jsonb_typeof(coalesce(p_records, 'null'::jsonb)) <> 'array' THEN RAISE EXCEPTION 'Records arrive as a list' USING ERRCODE = 'QM022'; END IF;
  IF r.records_total + jsonb_array_length(p_records) > 100000 THEN RAISE EXCEPTION 'An import is limited to 100,000 rows' USING ERRCODE = 'QM022'; END IF;

  WITH src AS (
    SELECT t.ord, t.e, nullif(btrim(t.e ->> 'externalId'), '') AS ext,
           encode(sha256(convert_to(coalesce(t.e -> 'canonical', t.e -> 'payload')::text, 'UTF8')), 'hex') AS hash
      FROM jsonb_array_elements(p_records) WITH ORDINALITY AS t(e, ord)
  ), ranked AS (
    SELECT s.*, row_number() OVER (PARTITION BY s.ext ORDER BY s.ord) AS dup,
           EXISTS (SELECT 1 FROM public.integration_inbox i WHERE i.run_id = r.id AND i.external_id = s.ext AND i.status <> 'rejected') AS seen,
           x.internal_id AS mapped, x.content_hash AS mapped_hash,
           CASE
             WHEN jsonb_typeof(s.e -> 'payload') IS DISTINCT FROM 'object' THEN jsonb_build_array(jsonb_build_object('field', NULL, 'message', 'The record is not a set of fields'))
             WHEN s.ext IS NULL THEN jsonb_build_array(jsonb_build_object('field', 'externalId', 'message', 'The record has no identifier'))
             WHEN length(s.ext) > 200 THEN jsonb_build_array(jsonb_build_object('field', 'externalId', 'message', 'The identifier is longer than 200 characters'))
             WHEN jsonb_typeof(s.e -> 'errors') = 'array' AND jsonb_array_length(s.e -> 'errors') > 0 THEN s.e -> 'errors'
             ELSE NULL END AS problem
      FROM src s
      LEFT JOIN public.integration_external_records x
        ON x.organisation_id = r.organisation_id AND x.connection_id = r.connection_id AND x.entity_type = r.entity_type AND x.external_id = s.ext
  ), ins AS (
    INSERT INTO public.integration_inbox (organisation_id, connection_id, run_id, entity_type, external_id, source_row, payload, canonical, content_hash, status, action, internal_id, errors, last_run_id)
    SELECT r.organisation_id, r.connection_id, r.id, r.entity_type, left(k.ext, 200),
           CASE WHEN (k.e ->> 'sourceRow') ~ '^[0-9]{1,9}$' THEN (k.e ->> 'sourceRow')::integer END,
           CASE WHEN jsonb_typeof(k.e -> 'payload') = 'object' THEN k.e -> 'payload' END,
           CASE WHEN jsonb_typeof(k.e -> 'canonical') = 'object' THEN k.e -> 'canonical' END,
           k.hash,
           CASE WHEN k.problem IS NOT NULL OR k.dup > 1 OR k.seen THEN 'rejected'
                WHEN k.mapped_hash = k.hash THEN 'unchanged'
                WHEN r.kind = 'preview' THEN 'previewed'
                ELSE 'staged' END,
           CASE WHEN k.problem IS NOT NULL OR k.dup > 1 OR k.seen OR k.mapped_hash = k.hash THEN NULL
                WHEN k.mapped IS NULL THEN 'create' ELSE 'update' END,
           k.mapped,
           CASE WHEN k.problem IS NOT NULL THEN k.problem
                WHEN k.dup > 1 OR k.seen THEN jsonb_build_array(jsonb_build_object('field', 'externalId', 'message', 'This identifier appears more than once in the import'))
                ELSE '[]'::jsonb END,
           r.id
      FROM ranked k
     ORDER BY k.ord
    RETURNING status, action
  )
  SELECT count(*), count(*) FILTER (WHERE status = 'rejected'), count(*) FILTER (WHERE status = 'unchanged'),
         count(*) FILTER (WHERE action = 'create'), count(*) FILTER (WHERE action = 'update')
    INTO n_total, n_rejected, n_unchanged, n_create, n_update
    FROM ins;

  -- A record that arrives unchanged is already in the QMS as the source says: older failed copies of it are no longer needed.
  IF r.kind <> 'preview' AND n_unchanged > 0 THEN
    UPDATE public.integration_inbox o SET status = 'superseded', retry_run_id = NULL, updated_at = now()
     WHERE o.connection_id = r.connection_id AND o.entity_type = r.entity_type AND o.status = 'failed'
       AND EXISTS (SELECT 1 FROM public.integration_inbox n WHERE n.run_id = r.id AND n.status = 'unchanged' AND n.external_id = o.external_id);
    GET DIAGNOSTICS n_superseded = ROW_COUNT;
  END IF;

  UPDATE public.integration_sync_runs
     SET records_total = records_total + n_total, rejected = rejected + n_rejected, unchanged = unchanged + n_unchanged, superseded = superseded + n_superseded,
         created = created + CASE WHEN kind = 'preview' THEN n_create ELSE 0 END, updated = updated + CASE WHEN kind = 'preview' THEN n_update ELSE 0 END,
         cursor_next = p_next_cursor, fetch_done = coalesce(p_done, false), updated_at = now()
   WHERE id = r.id;
  RETURN jsonb_build_object('received', n_total, 'rejected', n_rejected, 'unchanged', n_unchanged, 'toCreate', n_create, 'toUpdate', n_update);
END $$;

-- The next rows to apply (none for a preview). Each carries the record's current QMS id from the map, so an importer updates rather than creates.
CREATE FUNCTION app.system_integration_rows_to_apply(p_org uuid, p_run uuid, p_owner uuid, p_limit integer DEFAULT 200) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.integration_sync_runs%ROWTYPE; v_limit integer := least(greatest(coalesce(p_limit, 200), 1), 1000); v_rows jsonb; n integer;
BEGIN
  r := app.integration_run_for_system(p_org, p_run, p_owner);
  IF r.kind = 'preview' THEN RETURN '[]'::jsonb; END IF;
  IF r.kind = 'retry' THEN
    -- A failed row with a newer copy of the same record (already in, or itself retried now) is not applied: only the newest copy counts.
    UPDATE public.integration_inbox o SET status = 'superseded', updated_at = now()
     WHERE o.retry_run_id = r.id AND o.status = 'failed'
       AND EXISTS (SELECT 1 FROM public.integration_inbox n WHERE n.connection_id = o.connection_id AND n.entity_type = o.entity_type AND n.external_id = o.external_id
                     AND n.created_at > o.created_at AND (n.status IN ('applied', 'unchanged') OR (n.status = 'failed' AND n.retry_run_id = r.id)));
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN UPDATE public.integration_sync_runs SET superseded = superseded + n, updated_at = now() WHERE id = r.id; END IF;
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'externalId', q.external_id, 'sourceRow', q.source_row, 'payload', q.payload, 'canonical', q.canonical,
           'internalId', x.internal_id, 'action', CASE WHEN x.internal_id IS NULL THEN 'create' ELSE 'update' END) ORDER BY q.created_at, q.source_row, q.id), '[]'::jsonb)
    INTO v_rows
    FROM (SELECT i.* FROM public.integration_inbox i
           WHERE i.organisation_id = r.organisation_id
             AND ((r.kind = 'retry' AND i.retry_run_id = r.id AND i.status = 'failed') OR (r.kind <> 'retry' AND i.run_id = r.id AND i.status = 'staged'))
           ORDER BY i.created_at, i.source_row, i.id
           LIMIT v_limit) q
    LEFT JOIN public.integration_external_records x
      ON x.organisation_id = q.organisation_id AND x.connection_id = q.connection_id AND x.entity_type = q.entity_type AND x.external_id = q.external_id;
  RETURN v_rows;
END $$;

CREATE FUNCTION app.integration_row_for_system(r public.integration_sync_runs, p_row uuid) RETURNS public.integration_inbox
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE i public.integration_inbox%ROWTYPE;
BEGIN
  SELECT * INTO i FROM public.integration_inbox
   WHERE id = p_row AND organisation_id = r.organisation_id
     AND ((r.kind = 'retry' AND retry_run_id = r.id AND status = 'failed') OR (r.kind IN ('full', 'incremental') AND run_id = r.id AND status = 'staged'))
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'That row is not waiting to be applied in this import' USING ERRCODE = 'QM022'; END IF;
  RETURN i;
END $$;

-- Record that a row's importer wrote the QMS record (called in the same transaction and savepoint as the importer, so the record and the map agree).
CREATE FUNCTION app.system_apply_integration_row(p_org uuid, p_run uuid, p_owner uuid, p_row uuid, p_internal uuid, p_action text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.integration_sync_runs%ROWTYPE; i public.integration_inbox%ROWTYPE; x public.integration_external_records%ROWTYPE; n integer;
BEGIN
  r := app.integration_run_for_system(p_org, p_run, p_owner);
  i := app.integration_row_for_system(r, p_row);
  IF p_internal IS NULL OR p_action IS NULL OR p_action NOT IN ('create', 'update') THEN RAISE EXCEPTION 'Say which QMS record was created or updated' USING ERRCODE = 'QM022'; END IF;
  IF i.external_id IS NULL OR i.content_hash IS NULL THEN RAISE EXCEPTION 'That row has no identifier' USING ERRCODE = 'QM022'; END IF;
  SELECT * INTO x FROM public.integration_external_records
   WHERE organisation_id = r.organisation_id AND connection_id = r.connection_id AND entity_type = r.entity_type AND external_id = i.external_id FOR UPDATE;
  IF FOUND THEN
    IF x.internal_id <> p_internal THEN RAISE EXCEPTION 'This record is already linked to a different QMS record' USING ERRCODE = 'QM022'; END IF;
    IF x.content_hash IS DISTINCT FROM i.content_hash THEN
      UPDATE public.integration_external_records SET content_hash = i.content_hash, last_run_id = r.id, updated_at = now()
       WHERE organisation_id = x.organisation_id AND connection_id = x.connection_id AND entity_type = x.entity_type AND external_id = x.external_id;
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM public.integration_external_records WHERE organisation_id = r.organisation_id AND connection_id = r.connection_id AND entity_type = r.entity_type AND internal_id = p_internal) THEN
      RAISE EXCEPTION 'That QMS record is already linked to another record from this source' USING ERRCODE = 'QM022';
    END IF;
    INSERT INTO public.integration_external_records (organisation_id, connection_id, entity_type, external_id, internal_id, content_hash, first_run_id, last_run_id)
    VALUES (r.organisation_id, r.connection_id, r.entity_type, i.external_id, p_internal, i.content_hash, r.id, r.id);
  END IF;
  UPDATE public.integration_inbox
     SET status = 'applied', action = p_action, internal_id = p_internal, applied_at = now(), last_run_id = r.id, retry_run_id = NULL, errors = '[]'::jsonb, attempts = attempts + 1, updated_at = now()
   WHERE id = i.id;
  -- Older failed copies of the same record are superseded by this one.
  UPDATE public.integration_inbox o SET status = 'superseded', retry_run_id = NULL, updated_at = now()
   WHERE o.connection_id = i.connection_id AND o.entity_type = i.entity_type AND o.external_id = i.external_id AND o.status = 'failed' AND o.id <> i.id AND o.created_at <= i.created_at;
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE public.integration_sync_runs
     SET created = created + CASE WHEN p_action = 'create' THEN 1 ELSE 0 END, updated = updated + CASE WHEN p_action = 'update' THEN 1 ELSE 0 END,
         superseded = superseded + n, updated_at = now()
   WHERE id = r.id;
END $$;

-- Record that a row could not be applied (after the importer's savepoint was rolled back). It stays for a retry.
CREATE FUNCTION app.system_fail_integration_row(p_org uuid, p_run uuid, p_owner uuid, p_row uuid, p_message text, p_field text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.integration_sync_runs%ROWTYPE; i public.integration_inbox%ROWTYPE;
BEGIN
  r := app.integration_run_for_system(p_org, p_run, p_owner);
  i := app.integration_row_for_system(r, p_row);
  UPDATE public.integration_inbox
     SET status = 'failed', errors = jsonb_build_array(jsonb_build_object('field', left(p_field, 100), 'message', left(coalesce(nullif(btrim(p_message), ''), 'The row could not be applied'), 1000))),
         attempts = attempts + 1, last_run_id = r.id, retry_run_id = NULL, updated_at = now()
   WHERE id = i.id;
  UPDATE public.integration_sync_runs SET failed = failed + 1, updated_at = now() WHERE id = r.id;
END $$;

-- Finish: everything fetched and applied. The connection's cursor moves on only now (and only for full and incremental imports).
CREATE FUNCTION app.system_finish_integration_run(p_org uuid, p_run uuid, p_owner uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.integration_sync_runs%ROWTYPE; v_status text;
BEGIN
  r := app.integration_run_for_system(p_org, p_run, p_owner);
  IF NOT r.fetch_done THEN RAISE EXCEPTION 'The import has not fetched everything yet' USING ERRCODE = 'QM022'; END IF;
  IF r.kind <> 'preview' AND EXISTS (SELECT 1 FROM public.integration_inbox i
      WHERE (r.kind = 'retry' AND i.retry_run_id = r.id AND i.status = 'failed') OR (r.kind <> 'retry' AND i.run_id = r.id AND i.status = 'staged')) THEN
    RAISE EXCEPTION 'Rows are still waiting to be applied' USING ERRCODE = 'QM022';
  END IF;
  v_status := CASE
    WHEN r.failed + r.rejected > 0 AND r.created + r.updated + r.unchanged = 0 THEN 'failed'
    WHEN r.failed > 0 OR r.rejected > 0 THEN 'partial'
    ELSE 'succeeded' END;
  UPDATE public.integration_sync_runs SET status = v_status, finished_at = now(), lease_owner = NULL, lease_until = NULL, updated_at = now() WHERE id = r.id;
  IF r.kind IN ('full', 'incremental') THEN
    INSERT INTO public.integration_sync_cursors AS k (organisation_id, connection_id, entity_type, cursor, run_id)
    VALUES (r.organisation_id, r.connection_id, r.entity_type, r.cursor_next, r.id)
    ON CONFLICT (connection_id, entity_type) DO UPDATE SET cursor = EXCLUDED.cursor, run_id = EXCLUDED.run_id, updated_at = now()
      WHERE k.cursor IS DISTINCT FROM EXCLUDED.cursor;
  END IF;
  RETURN v_status;
END $$;

-- A run-level failure (the source could not be read, a limit was hit). Transient ones wait and try again (exponential, or the source's Retry-After), at most five attempts.
CREATE FUNCTION app.system_integration_run_error(p_org uuid, p_run uuid, p_owner uuid, p_kind text, p_message text, p_transient boolean, p_retry_after_seconds integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.integration_sync_runs%ROWTYPE; v_message text := left(coalesce(nullif(btrim(p_message), ''), 'The import failed'), 1000); v_wait integer;
BEGIN
  r := app.integration_run_for_system(p_org, p_run, p_owner);
  INSERT INTO public.integration_run_errors (organisation_id, run_id, attempt, kind, message, transient)
  VALUES (r.organisation_id, r.id, r.attempts + 1, coalesce(p_kind, 'internal'), v_message, coalesce(p_transient, false));
  IF coalesce(p_transient, false) AND r.attempts + 1 < 5 THEN
    v_wait := coalesce(least(greatest(p_retry_after_seconds, 1), 3600), least(60 * power(2, r.attempts)::integer, 3600));
    UPDATE public.integration_sync_runs
       SET attempts = attempts + 1, next_attempt_at = now() + make_interval(secs => v_wait), lease_owner = NULL, lease_until = NULL, error_summary = v_message, updated_at = now()
     WHERE id = r.id;
    RETURN jsonb_build_object('status', 'waiting', 'nextAttemptAt', now() + make_interval(secs => v_wait));
  END IF;
  UPDATE public.integration_sync_runs
     SET attempts = attempts + 1, status = 'failed', finished_at = now(), lease_owner = NULL, lease_until = NULL, error_summary = v_message, updated_at = now()
   WHERE id = r.id;
  UPDATE public.integration_inbox SET retry_run_id = NULL, updated_at = now() WHERE retry_run_id = r.id AND status = 'failed';
  RETURN jsonb_build_object('status', 'failed');
END $$;

-- Hand the run back (the time allowed for this call is used up); the next call carries on from where it stopped.
CREATE FUNCTION app.system_release_integration_run(p_org uuid, p_run uuid, p_owner uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  UPDATE public.integration_sync_runs SET lease_owner = NULL, lease_until = NULL, updated_at = now()
   WHERE id = p_run AND organisation_id = p_org AND lease_owner = p_owner
$$;

-- Payload retention (plan §8): staged payloads can hold personal data. After p_days (at least 7) the payload and mapped record are cleared; counts, errors, ids
-- and hashes stay. Failed rows keep theirs (they may still be retried).
CREATE FUNCTION app.system_purge_integration_payloads(p_days integer DEFAULT 90) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n integer;
BEGIN
  IF p_days IS NULL OR p_days < 7 THEN RAISE EXCEPTION 'Keep payloads for at least 7 days' USING ERRCODE = 'QM022'; END IF;
  UPDATE public.integration_inbox SET payload = NULL, canonical = NULL, payload_purged_at = now(), updated_at = now()
   WHERE created_at < now() - make_interval(days => p_days) AND status <> 'failed' AND payload_purged_at IS NULL AND (payload IS NOT NULL OR canonical IS NOT NULL);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app.integration_entity_types(), app.integration_assert_entity(text), app.integration_assert_idle(uuid, text),
  app.integration_run_for_system(uuid, uuid, uuid), app.integration_row_for_system(public.integration_sync_runs, uuid) FROM PUBLIC, anon, authenticated;
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['request_integration_run(uuid,text,text)', 'retry_integration_rows(uuid,text,uuid[])', 'cancel_integration_run(uuid,text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION app.%s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION app.%s TO authenticated', f);
  END LOOP;
  FOREACH f IN ARRAY ARRAY['system_integration_runs_due(integer)', 'system_lease_integration_run(uuid,uuid,uuid,integer)', 'system_stage_integration_records(uuid,uuid,uuid,jsonb,text,boolean)',
    'system_integration_rows_to_apply(uuid,uuid,uuid,integer)', 'system_apply_integration_row(uuid,uuid,uuid,uuid,uuid,text)', 'system_fail_integration_row(uuid,uuid,uuid,uuid,text,text)',
    'system_finish_integration_run(uuid,uuid,uuid)', 'system_integration_run_error(uuid,uuid,uuid,text,text,boolean,integer)', 'system_release_integration_run(uuid,uuid,uuid)',
    'system_purge_integration_payloads(integer)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION app.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION app.%s TO qms_api', f);
  END LOOP;
END $$;
