-- Integrations, slice IN3 (docs/connectors-plan.md): file imports and versioned field mappings.
--  * Files: the browser uploads a CSV or Excel file to the private bucket `integration-files` at <org>/integration/<connection>/<uuid>-<name> (upload needs
--    integrations.run on an organisation's own connection that is not retired; reading needs integrations.read). The API fetches it, parses it and stores the rows
--    in `integration_file_chunks` (up to 1,000 rows a chunk), so an import can be worked across several short requests. `integration_files` records each upload:
--    name, size, sheet, the column headings found, row count, status uploaded -> parsed | failed (with the reason) -> purged (rows cleared by the retention policy).
--    Limits (plan D8): 25 MB a file, 100,000 rows.
--  * Mappings: `integration_mappings` = how a connection's source columns become a kind of record, as versions (a saved version is never changed; a new one needs
--    a reason, an unchanged one is refused). Each version names the key column (the record's identifier at the source) and the fields
--    [{target, source | sources, transform, default, ownership}]; the API checks targets and transforms against its catalogue before saving.
--  * Runs gain `file_id` and `mapping_id`: a file connection imports one parsed file with the current mapping, frozen on the run when it is asked for, so editing
--    the mapping never changes a past or running import. A file connection has no incremental imports (each file is read whole).
--  * The runner reads the file a chunk at a time (app.system_integration_file_chunk, API login only); payload retention also clears the rows of old files.
--  No table writes: SECURITY DEFINER functions only. Errors QM022 -> 409 integration_rule; P0002 -> 404.

-- ---------------------------------------------------------------------------
-- Storage
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public) VALUES ('integration-files', 'integration-files', false) ON CONFLICT (id) DO NOTHING;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'storage' AND table_name = 'buckets' AND column_name = 'file_size_limit') THEN
    EXECUTE $q$UPDATE storage.buckets SET file_size_limit = 26214400 WHERE id = 'integration-files'$q$;
  END IF;
END $$;

CREATE FUNCTION app.integration_file_allowed(p_object_name text, p_upload boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT split_part(p_object_name, '/', 2) = 'integration'
     AND EXISTS (
       SELECT 1 FROM public.integration_connections c
       WHERE c.id = app.try_uuid(split_part(p_object_name, '/', 3))
         AND c.organisation_id = app.try_uuid(split_part(p_object_name, '/', 1))
         AND (NOT p_upload OR c.status <> 'retired')
         AND app.has_permission(c.organisation_id, CASE WHEN p_upload THEN 'integrations.run' ELSE 'integrations.read' END))
$$;

CREATE POLICY integration_files_select ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'integration-files' AND app.integration_file_allowed(name, false));
CREATE POLICY integration_files_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'integration-files' AND app.integration_file_allowed(name, true));

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE public.integration_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id),
  connection_id uuid NOT NULL,
  storage_path text NOT NULL UNIQUE,
  file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 0 AND 26214400),
  status text NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'parsed', 'failed', 'purged')),
  sheet_name text,
  headers text[] NOT NULL DEFAULT '{}',
  row_count integer NOT NULL DEFAULT 0,
  chunk_count integer NOT NULL DEFAULT 0,
  parse_error text,
  uploaded_by uuid DEFAULT auth.uid(),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  parsed_at timestamptz,
  purged_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT integration_files_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT integration_files_connection_fkey FOREIGN KEY (connection_id, organisation_id) REFERENCES public.integration_connections (id, organisation_id)
);
CREATE INDEX integration_files_connection_idx ON public.integration_files (connection_id, uploaded_at DESC);

CREATE TABLE public.integration_file_chunks (
  organisation_id uuid NOT NULL REFERENCES public.organisations (id),
  file_id uuid NOT NULL,
  seq integer NOT NULL CHECK (seq >= 0),
  rows jsonb NOT NULL CHECK (jsonb_typeof(rows) = 'array'),
  PRIMARY KEY (file_id, seq),
  CONSTRAINT integration_file_chunks_file_fkey FOREIGN KEY (file_id, organisation_id) REFERENCES public.integration_files (id, organisation_id)
);

CREATE TABLE public.integration_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id),
  connection_id uuid NOT NULL,
  entity_type text NOT NULL CHECK (entity_type = ANY (app.integration_entity_types())),
  version integer NOT NULL CHECK (version >= 1),
  key_field text NOT NULL CHECK (length(key_field) BETWEEN 1 AND 200),
  fields jsonb NOT NULL CHECK (jsonb_typeof(fields) = 'array'),
  reason text,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  CONSTRAINT integration_mappings_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT integration_mappings_version_key UNIQUE (connection_id, entity_type, version),
  CONSTRAINT integration_mappings_connection_fkey FOREIGN KEY (connection_id, organisation_id) REFERENCES public.integration_connections (id, organisation_id)
);
CREATE UNIQUE INDEX integration_mappings_one_current ON public.integration_mappings (connection_id, entity_type) WHERE superseded_at IS NULL;

ALTER TABLE public.integration_sync_runs
  ADD COLUMN file_id uuid,
  ADD COLUMN mapping_id uuid,
  ADD CONSTRAINT integration_sync_runs_file_fkey FOREIGN KEY (file_id, organisation_id) REFERENCES public.integration_files (id, organisation_id),
  ADD CONSTRAINT integration_sync_runs_mapping_fkey FOREIGN KEY (mapping_id, organisation_id) REFERENCES public.integration_mappings (id, organisation_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['integration_files', 'integration_file_chunks', 'integration_mappings'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (app.has_permission(organisation_id, %L))', t || '_select', t, 'integrations.read');
  END LOOP;
END $$;
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.integration_files FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.integration_mappings FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');

-- A saved mapping version is never changed (only superseded once, by the next version).
CREATE FUNCTION app.integration_mapping_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.superseded_at IS NULL AND NEW.superseded_at IS NOT NULL
     AND (to_jsonb(NEW) - 'superseded_at') = (to_jsonb(OLD) - 'superseded_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'A saved mapping version is never changed: save a new version' USING ERRCODE = 'QM022';
END $$;
CREATE TRIGGER integration_mappings_frozen BEFORE UPDATE OR DELETE ON public.integration_mappings FOR EACH ROW EXECUTE FUNCTION app.integration_mapping_frozen();

-- ---------------------------------------------------------------------------
-- Files (people with integrations.run, through the API)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.integration_file_for_write(p_file uuid) RETURNS public.integration_files
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE f public.integration_files%ROWTYPE;
BEGIN
  SELECT * INTO f FROM public.integration_files WHERE id = p_file FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(f.organisation_id) THEN RAISE EXCEPTION 'File not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(f.organisation_id, 'integrations.run') THEN RAISE EXCEPTION 'You are not allowed to do that with integrations' USING ERRCODE = '42501'; END IF;
  IF f.status <> 'uploaded' THEN RAISE EXCEPTION 'This file has already been read' USING ERRCODE = 'QM022'; END IF;
  RETURN f;
END $$;

-- Record an uploaded file. The path must be in the connection's own folder.
CREATE FUNCTION app.register_integration_file(p_connection uuid, p_path text, p_name text, p_size bigint) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.integration_connections%ROWTYPE; v_id uuid;
BEGIN
  c := app.integration_connection_for_write(p_connection, 'integrations.run');
  IF c.status = 'retired' THEN RAISE EXCEPTION 'A retired connection cannot import' USING ERRCODE = 'QM022'; END IF;
  IF p_path IS NULL OR p_path NOT LIKE c.organisation_id::text || '/integration/' || c.id::text || '/%' OR p_path LIKE '%..%' THEN
    RAISE EXCEPTION 'The file is not in this connection''s folder' USING ERRCODE = 'QM022';
  END IF;
  IF length(btrim(coalesce(p_name, ''))) = 0 THEN RAISE EXCEPTION 'Name the file' USING ERRCODE = 'QM022'; END IF;
  IF p_size IS NULL OR p_size < 0 OR p_size > 26214400 THEN RAISE EXCEPTION 'A file can be up to 25 MB' USING ERRCODE = 'QM022'; END IF;
  INSERT INTO public.integration_files (organisation_id, connection_id, storage_path, file_name, size_bytes)
  VALUES (c.organisation_id, c.id, p_path, left(btrim(p_name), 255), p_size)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Add the next chunk of parsed rows ([{r: source row, v: {column: value}}], up to 1,000).
CREATE FUNCTION app.add_integration_file_chunk(p_file uuid, p_seq integer, p_rows jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE f public.integration_files%ROWTYPE; n integer;
BEGIN
  f := app.integration_file_for_write(p_file);
  IF p_seq IS DISTINCT FROM f.chunk_count THEN RAISE EXCEPTION 'Chunks are added in order' USING ERRCODE = 'QM022'; END IF;
  IF jsonb_typeof(coalesce(p_rows, 'null'::jsonb)) <> 'array' OR jsonb_array_length(p_rows) = 0 OR jsonb_array_length(p_rows) > 1000 THEN
    RAISE EXCEPTION 'A chunk holds 1 to 1,000 rows' USING ERRCODE = 'QM022';
  END IF;
  n := jsonb_array_length(p_rows);
  IF f.row_count + n > 100000 THEN RAISE EXCEPTION 'A file can have up to 100,000 rows' USING ERRCODE = 'QM022'; END IF;
  INSERT INTO public.integration_file_chunks (organisation_id, file_id, seq, rows) VALUES (f.organisation_id, f.id, p_seq, p_rows);
  UPDATE public.integration_files SET chunk_count = chunk_count + 1, row_count = row_count + n, updated_at = now() WHERE id = f.id;
END $$;

-- Finish reading: parsed with its headings, or failed with the reason (rows already added are cleared).
CREATE FUNCTION app.finish_integration_file(p_file uuid, p_headers text[], p_sheet text, p_error text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE f public.integration_files%ROWTYPE;
BEGIN
  f := app.integration_file_for_write(p_file);
  IF p_error IS NOT NULL THEN
    DELETE FROM public.integration_file_chunks WHERE file_id = f.id;
    UPDATE public.integration_files SET status = 'failed', parse_error = left(btrim(p_error), 1000), chunk_count = 0, row_count = 0, parsed_at = now(), updated_at = now() WHERE id = f.id;
    RETURN;
  END IF;
  IF coalesce(cardinality(p_headers), 0) = 0 OR cardinality(p_headers) > 200 THEN RAISE EXCEPTION 'A file has 1 to 200 columns' USING ERRCODE = 'QM022'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_headers) h WHERE h IS NULL OR length(h) = 0 OR length(h) > 200) THEN RAISE EXCEPTION 'Column headings are 1 to 200 characters' USING ERRCODE = 'QM022'; END IF;
  IF f.row_count = 0 THEN RAISE EXCEPTION 'The file has no rows' USING ERRCODE = 'QM022'; END IF;
  UPDATE public.integration_files SET status = 'parsed', headers = p_headers, sheet_name = left(p_sheet, 200), parsed_at = now(), updated_at = now() WHERE id = f.id;
END $$;

-- ---------------------------------------------------------------------------
-- Mappings (integrations.manage)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.save_integration_mapping(p_connection uuid, p_entity text, p_key_field text, p_fields jsonb, p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.integration_connections%ROWTYPE; prev public.integration_mappings%ROWTYPE; v_id uuid;
BEGIN
  c := app.integration_connection_for_write(p_connection, 'integrations.manage');
  PERFORM app.integration_assert_entity(p_entity);
  IF c.status = 'retired' THEN RAISE EXCEPTION 'A retired connection cannot be changed' USING ERRCODE = 'QM022'; END IF;
  IF length(btrim(coalesce(p_key_field, ''))) = 0 THEN RAISE EXCEPTION 'Choose the column that identifies each record' USING ERRCODE = 'QM022'; END IF;
  IF jsonb_typeof(coalesce(p_fields, 'null'::jsonb)) <> 'array' OR jsonb_array_length(p_fields) = 0 OR jsonb_array_length(p_fields) > 100 THEN
    RAISE EXCEPTION 'Map 1 to 100 fields' USING ERRCODE = 'QM022';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_fields) e WHERE jsonb_typeof(e) <> 'object' OR coalesce(e ->> 'target', '') = '') THEN
    RAISE EXCEPTION 'Every mapped field names its target' USING ERRCODE = 'QM022';
  END IF;
  IF pg_column_size(p_fields) > 65536 THEN RAISE EXCEPTION 'The mapping is too large' USING ERRCODE = 'QM022'; END IF;
  SELECT * INTO prev FROM public.integration_mappings WHERE connection_id = c.id AND entity_type = p_entity AND superseded_at IS NULL FOR UPDATE;
  IF FOUND THEN
    IF prev.key_field = btrim(p_key_field) AND prev.fields = p_fields THEN RAISE EXCEPTION 'Nothing has changed in the mapping' USING ERRCODE = 'QM022'; END IF;
    IF length(btrim(coalesce(p_reason, ''))) < 3 THEN RAISE EXCEPTION 'Say why the mapping is changing' USING ERRCODE = 'QM022'; END IF;
    UPDATE public.integration_mappings SET superseded_at = now() WHERE id = prev.id;
  END IF;
  INSERT INTO public.integration_mappings (organisation_id, connection_id, entity_type, version, key_field, fields, reason)
  VALUES (c.organisation_id, c.id, p_entity, coalesce(prev.version, 0) + 1, btrim(p_key_field), p_fields, nullif(left(btrim(coalesce(p_reason, '')), 1000), ''))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------
-- Runs: a file connection imports one parsed file with the current mapping
-- ---------------------------------------------------------------------------
DROP FUNCTION app.request_integration_run(uuid, text, text);
CREATE FUNCTION app.request_integration_run(p_connection uuid, p_entity text, p_kind text, p_file uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.integration_connections%ROWTYPE; v_provider text; v_cursor text; v_id uuid; v_mapping uuid; f public.integration_files%ROWTYPE;
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
  SELECT key INTO v_provider FROM public.integration_providers WHERE id = c.provider_id;
  SELECT id INTO v_mapping FROM public.integration_mappings WHERE connection_id = c.id AND entity_type = p_entity AND superseded_at IS NULL;
  IF v_provider = 'csv' THEN
    IF p_kind = 'incremental' THEN RAISE EXCEPTION 'A file is always imported whole: choose a full import' USING ERRCODE = 'QM022'; END IF;
    IF p_file IS NULL THEN RAISE EXCEPTION 'Choose the file to import' USING ERRCODE = 'QM022'; END IF;
    SELECT * INTO f FROM public.integration_files WHERE id = p_file AND connection_id = c.id AND organisation_id = c.organisation_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'File not found' USING ERRCODE = 'P0002'; END IF;
    IF f.status <> 'parsed' THEN RAISE EXCEPTION 'That file could not be read, or its rows have been cleared' USING ERRCODE = 'QM022'; END IF;
    IF v_mapping IS NULL THEN RAISE EXCEPTION 'Map the file''s columns before importing' USING ERRCODE = 'QM022'; END IF;
  ELSIF p_file IS NOT NULL THEN
    RAISE EXCEPTION 'Only a file connection imports a file' USING ERRCODE = 'QM022';
  END IF;
  PERFORM app.integration_assert_idle(c.id, p_entity);
  IF p_kind = 'incremental' THEN
    SELECT cursor INTO v_cursor FROM public.integration_sync_cursors WHERE connection_id = c.id AND entity_type = p_entity;
  END IF;
  INSERT INTO public.integration_sync_runs (organisation_id, connection_id, entity_type, kind, requested_by, cursor_start, cursor_next, file_id, mapping_id)
  VALUES (c.organisation_id, c.id, p_entity, p_kind, auth.uid(), v_cursor, v_cursor, p_file, v_mapping)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION app.system_lease_integration_run(p_org uuid, p_run uuid, p_owner uuid, p_seconds integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.integration_sync_runs%ROWTYPE; c public.integration_connections%ROWTYPE; v_provider text; m public.integration_mappings%ROWTYPE; f public.integration_files%ROWTYPE;
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
  IF r.mapping_id IS NOT NULL THEN SELECT * INTO m FROM public.integration_mappings WHERE id = r.mapping_id AND organisation_id = p_org; END IF;
  IF r.file_id IS NOT NULL THEN SELECT * INTO f FROM public.integration_files WHERE id = r.file_id AND organisation_id = p_org; END IF;
  UPDATE public.integration_sync_runs
     SET status = 'running', lease_owner = p_owner, lease_until = clock_timestamp() + make_interval(secs => p_seconds), started_at = coalesce(started_at, now()), updated_at = now()
   WHERE id = r.id;
  RETURN jsonb_build_object('leased', true, 'id', r.id, 'organisationId', r.organisation_id, 'connectionId', r.connection_id, 'providerKey', v_provider,
    'config', c.config, 'externalSystem', c.external_system, 'entityType', r.entity_type, 'kind', r.kind, 'cursor', r.cursor_next, 'fetchDone', r.fetch_done,
    'requestedBy', r.requested_by, 'recordsTotal', r.records_total, 'attempts', r.attempts,
    'file', CASE WHEN f.id IS NULL THEN NULL ELSE jsonb_build_object('id', f.id, 'status', f.status, 'chunkCount', f.chunk_count, 'headers', to_jsonb(f.headers)) END,
    'mapping', CASE WHEN m.id IS NULL THEN NULL ELSE jsonb_build_object('id', m.id, 'version', m.version, 'keyField', m.key_field, 'fields', m.fields) END);
END $$;

-- One chunk of the run's file (null past the end, or when the rows have been cleared).
CREATE FUNCTION app.system_integration_file_chunk(p_org uuid, p_run uuid, p_owner uuid, p_seq integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.integration_sync_runs%ROWTYPE; v_rows jsonb;
BEGIN
  r := app.integration_run_for_system(p_org, p_run, p_owner);
  IF r.file_id IS NULL THEN RAISE EXCEPTION 'This import has no file' USING ERRCODE = 'QM022'; END IF;
  SELECT k.rows INTO v_rows FROM public.integration_file_chunks k WHERE k.file_id = r.file_id AND k.organisation_id = p_org AND k.seq = p_seq;
  RETURN v_rows;
END $$;

-- Payload retention now also clears the rows of files uploaded before the cut-off (unless a run still needs them).
CREATE OR REPLACE FUNCTION app.system_purge_integration_payloads(p_days integer DEFAULT 90) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n integer; m integer;
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
  RETURN n + m;
END $$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app.integration_file_for_write(uuid), app.integration_mapping_frozen() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.integration_file_allowed(text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.integration_file_allowed(text, boolean) TO authenticated;
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['register_integration_file(uuid,text,text,bigint)', 'add_integration_file_chunk(uuid,integer,jsonb)', 'finish_integration_file(uuid,text[],text,text)',
    'save_integration_mapping(uuid,text,text,jsonb,text)', 'request_integration_run(uuid,text,text,uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION app.%s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION app.%s TO authenticated', f);
  END LOOP;
  FOREACH f IN ARRAY ARRAY['system_integration_file_chunk(uuid,uuid,uuid,integer)', 'system_lease_integration_run(uuid,uuid,uuid,integer)', 'system_purge_integration_payloads(integer)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION app.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION app.%s TO qms_api', f);
  END LOOP;
END $$;
