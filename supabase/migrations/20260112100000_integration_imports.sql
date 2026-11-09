-- Integrations IN4 (docs/connectors-plan.md §6.7–§6.9, decisions D9 and D10, D7 amended after IN3):
--
--  * File connections (csv) have no lifecycle: they are created active, can be edited while active, and cannot be marked ready, paused or resumed.
--    Whoever imports a file approves it (every integrations.* permission already needs a Controller seat).
--  * Import settings per connection and kind of record (integration_import_settings): what an import may do (add new only | add new and update existing |
--    update existing only), match existing Fortress records by code, what happens when a record disappears (stored now, acted on in IN8) and a schedule
--    (manual only until IN8; never for an uploaded file). Non-conformances are always "add new only". Every run freezes the settings it used.
--  * Staging honours them: an already-imported record under "add new only", or a new one under "update existing only", is `skipped` (nothing written, said why);
--    with matching on, a record made by hand with the same code becomes an update instead of a duplicate.
--  * References (D10): app.system_integration_lookup resolves a source id from an earlier import through this connection, or a Fortress code.
--  * A real import needs the requester to hold the write permission for that kind of record (master data, calibration, NC create), checked when it is asked for.
--  * Import functions: app.system_import_record writes one record through the same table rules as the screens, acting as the person who started the run
--    (their claims are set for the transaction, so created_by, the triggers' user checks and the audit trail name them). API login only.

-- ---------------------------------------------------------------------------
-- File connections: no lifecycle
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.integration_status_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_provider text;
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  SELECT key INTO v_provider FROM public.integration_providers WHERE id = NEW.provider_id;
  IF v_provider = 'csv' THEN
    -- a file connection is either in use or retired (older draft/ready/paused ones are brought into use)
    IF NOT ((OLD.status IN ('draft', 'ready', 'paused') AND NEW.status IN ('active', 'retired')) OR (OLD.status = 'active' AND NEW.status = 'retired')) THEN
      RAISE EXCEPTION 'A file connection needs no testing, activation, pausing or resuming: it is in use until it is retired' USING ERRCODE = 'QM022';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT ((OLD.status = 'draft' AND NEW.status IN ('ready', 'retired'))
       OR (OLD.status = 'ready' AND NEW.status IN ('draft', 'active', 'retired'))
       OR (OLD.status = 'active' AND NEW.status IN ('paused', 'retired'))
       OR (OLD.status = 'paused' AND NEW.status IN ('active', 'draft', 'retired'))) THEN
    RAISE EXCEPTION 'A connection cannot move from % to %', OLD.status, NEW.status USING ERRCODE = 'QM022';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.create_integration_connection(p_organisation uuid, p_provider text, p_name text, p_external_system text, p_config jsonb DEFAULT '{}'::jsonb) RETURNS uuid
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
  IF p.key = 'rest_api' AND p_config IS NOT NULL AND p_config <> '{}'::jsonb AND v_problem IS NOT NULL THEN RAISE EXCEPTION '%', v_problem USING ERRCODE = 'QM022'; END IF;
  IF EXISTS (SELECT 1 FROM public.integration_connections WHERE organisation_id = p_organisation AND lower(btrim(name)) = lower(btrim(p_name))) THEN RAISE EXCEPTION 'There is already a connection called %', btrim(p_name) USING ERRCODE = 'QM022'; END IF;
  IF EXISTS (SELECT 1 FROM public.integration_connections WHERE organisation_id = p_organisation AND external_system = p_external_system) THEN RAISE EXCEPTION 'The system code % is already used by another connection', p_external_system USING ERRCODE = 'QM022'; END IF;
  IF p.key = 'csv' THEN
    INSERT INTO public.integration_connections (organisation_id, provider_id, name, external_system, config, status, activated_at, activated_by)
    VALUES (p_organisation, p.id, btrim(p_name), p_external_system, coalesce(p_config, '{}'::jsonb), 'active', now(), auth.uid()) RETURNING * INTO c;
    PERFORM app.integration_log(c, 'created', NULL, 'active', p.name || ' (a file connection is in use as soon as it is created)');
  ELSE
    INSERT INTO public.integration_connections (organisation_id, provider_id, name, external_system, config) VALUES (p_organisation, p.id, btrim(p_name), p_external_system, coalesce(p_config, '{}'::jsonb)) RETURNING * INTO c;
    PERFORM app.integration_log(c, 'created', NULL, 'draft', p.name);
  END IF;
  RETURN c.id;
END $$;

-- A file connection can be renamed or reconfigured while in use; an API connection is paused first (as before).
CREATE OR REPLACE FUNCTION app.update_integration_connection(p_connection uuid, p_name text DEFAULT NULL, p_config jsonb DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.integration_connections%ROWTYPE; p public.integration_providers%ROWTYPE; v_problem text;
BEGIN
  c := app.integration_connection_for_write(p_connection, 'integrations.manage');
  SELECT * INTO p FROM public.integration_providers WHERE id = c.provider_id;
  IF c.status = 'retired' OR (c.status = 'active' AND p.key <> 'csv') THEN
    RAISE EXCEPTION 'A % connection cannot be changed%', c.status, CASE WHEN c.status = 'active' THEN ': pause it first' ELSE '' END USING ERRCODE = 'QM022';
  END IF;
  IF p_name IS NOT NULL THEN
    IF length(btrim(p_name)) NOT BETWEEN 2 AND 80 THEN RAISE EXCEPTION 'Give the connection a name (2 to 80 characters)' USING ERRCODE = 'QM022'; END IF;
    IF EXISTS (SELECT 1 FROM public.integration_connections WHERE organisation_id = c.organisation_id AND id <> c.id AND lower(btrim(name)) = lower(btrim(p_name))) THEN RAISE EXCEPTION 'There is already a connection called %', btrim(p_name) USING ERRCODE = 'QM022'; END IF;
    UPDATE public.integration_connections SET name = btrim(p_name), updated_at = now(), updated_by = auth.uid() WHERE id = c.id;
  END IF;
  IF p_config IS NOT NULL AND p_config IS DISTINCT FROM c.config THEN
    v_problem := app.integration_config_problem(p.key, p_config);
    IF v_problem IS NOT NULL THEN RAISE EXCEPTION '%', v_problem USING ERRCODE = 'QM022'; END IF;
    UPDATE public.integration_connections SET config = p_config, config_changed_at = clock_timestamp(), updated_at = now(), updated_by = auth.uid() WHERE id = c.id;
    PERFORM app.integration_log(c, 'config_changed', c.status, c.status, NULL);
    IF c.status = 'ready' THEN
      UPDATE public.integration_connections SET status = 'draft', ready_at = NULL, ready_by = NULL WHERE id = c.id;
      PERFORM app.integration_log(c, 'reset_to_draft', 'ready', 'draft', 'The configuration changed after it was marked ready');
    END IF;
  END IF;
END $$;

-- Existing file connections that are not retired are brought into use.
DO $$
DECLARE c public.integration_connections%ROWTYPE;
BEGIN
  FOR c IN SELECT k.* FROM public.integration_connections k JOIN public.integration_providers p ON p.id = k.provider_id
            WHERE p.key = 'csv' AND k.status IN ('draft', 'ready', 'paused') LOOP
    UPDATE public.integration_connections SET status = 'active', activated_at = coalesce(activated_at, now()), updated_at = now() WHERE id = c.id;
    INSERT INTO public.integration_connection_events (organisation_id, connection_id, action, from_status, to_status, note, by)
    VALUES (c.organisation_id, c.id, 'activated', c.status, 'active', 'File connections no longer need activation', NULL);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Import settings (D9)
-- ---------------------------------------------------------------------------
CREATE TABLE public.integration_import_settings (
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  entity_type text NOT NULL CHECK (entity_type = ANY (app.integration_entity_types())),
  write_mode text NOT NULL DEFAULT 'add_only' CHECK (write_mode IN ('add_only', 'add_update', 'update_only')),
  match_existing boolean NOT NULL DEFAULT false,
  on_missing text NOT NULL DEFAULT 'nothing' CHECK (on_missing IN ('nothing', 'list', 'deactivate')),
  schedule text NOT NULL DEFAULT 'manual' CHECK (schedule IN ('manual', 'daily')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  PRIMARY KEY (connection_id, entity_type),
  CONSTRAINT integration_import_settings_connection_fkey FOREIGN KEY (connection_id, organisation_id) REFERENCES public.integration_connections (id, organisation_id)
);
CREATE INDEX integration_import_settings_org_idx ON public.integration_import_settings (organisation_id);
ALTER TABLE public.integration_import_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.integration_import_settings FROM anon, authenticated;
GRANT SELECT ON public.integration_import_settings TO authenticated;
CREATE POLICY integration_import_settings_select ON public.integration_import_settings FOR SELECT TO authenticated USING (app.has_permission(organisation_id, 'integrations.read'));
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.integration_import_settings FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id', 'connection_id');

ALTER TABLE public.integration_sync_runs ADD COLUMN settings jsonb, ADD COLUMN skipped integer NOT NULL DEFAULT 0;
ALTER TABLE public.integration_inbox DROP CONSTRAINT integration_inbox_status_check;
ALTER TABLE public.integration_inbox ADD CONSTRAINT integration_inbox_status_check CHECK (status IN ('staged', 'previewed', 'unchanged', 'skipped', 'applied', 'rejected', 'failed', 'superseded'));

-- Kinds of record with an Active flag (the only ones a disappeared record can be made inactive for).
CREATE FUNCTION app.integration_entity_has_active(p_entity text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$ SELECT p_entity IN ('supplier', 'customer', 'part', 'machine', 'employee', 'gauge_type') $$;

-- The settings in force for a connection and kind of record (the defaults when none are saved), as frozen onto a run.
CREATE FUNCTION app.integration_settings_for(p_connection uuid, p_entity text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'writeMode', CASE WHEN p_entity = 'nonconformance' THEN 'add_only' ELSE coalesce(s.write_mode, 'add_only') END,
    'matchExisting', CASE WHEN p_entity = 'nonconformance' THEN false ELSE coalesce(s.match_existing, false) END,
    'onMissing', coalesce(s.on_missing, 'nothing'),
    'schedule', coalesce(s.schedule, 'manual'))
    FROM (SELECT 1) one
    LEFT JOIN public.integration_import_settings s ON s.connection_id = p_connection AND s.entity_type = p_entity
$$;

CREATE FUNCTION app.set_integration_import_settings(p_connection uuid, p_entity text, p_settings jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.integration_connections%ROWTYPE; v_provider text; v_mode text; v_match boolean; v_missing text; v_schedule text; cur jsonb;
BEGIN
  c := app.integration_connection_for_write(p_connection, 'integrations.manage');
  PERFORM app.integration_assert_entity(p_entity);
  IF c.status = 'retired' THEN RAISE EXCEPTION 'A retired connection cannot be changed' USING ERRCODE = 'QM022'; END IF;
  IF jsonb_typeof(coalesce(p_settings, 'null'::jsonb)) <> 'object' THEN RAISE EXCEPTION 'Give the settings' USING ERRCODE = 'QM022'; END IF;
  SELECT key INTO v_provider FROM public.integration_providers WHERE id = c.provider_id;
  cur := app.integration_settings_for(c.id, p_entity);
  v_mode := coalesce(p_settings ->> 'writeMode', cur ->> 'writeMode');
  v_match := coalesce((p_settings ->> 'matchExisting')::boolean, (cur ->> 'matchExisting')::boolean);
  v_missing := coalesce(p_settings ->> 'onMissing', cur ->> 'onMissing');
  v_schedule := coalesce(p_settings ->> 'schedule', cur ->> 'schedule');
  IF v_mode NOT IN ('add_only', 'add_update', 'update_only') THEN RAISE EXCEPTION 'An import adds new records only, adds and updates, or updates only' USING ERRCODE = 'QM022'; END IF;
  IF v_missing NOT IN ('nothing', 'list', 'deactivate') THEN RAISE EXCEPTION 'When a record disappears: do nothing, list it, or make it inactive' USING ERRCODE = 'QM022'; END IF;
  IF v_schedule NOT IN ('manual', 'daily') THEN RAISE EXCEPTION 'An import runs by hand or daily' USING ERRCODE = 'QM022'; END IF;
  IF p_entity = 'nonconformance' AND (v_mode <> 'add_only' OR v_match) THEN
    RAISE EXCEPTION 'Non-conformances are only ever added: once in Fortress they are managed there' USING ERRCODE = 'QM022';
  END IF;
  IF v_missing = 'deactivate' AND NOT app.integration_entity_has_active(p_entity) THEN
    RAISE EXCEPTION 'These records cannot be made inactive; choose to do nothing or to list them' USING ERRCODE = 'QM022';
  END IF;
  IF v_schedule = 'daily' AND v_provider = 'csv' THEN
    RAISE EXCEPTION 'An uploaded file is imported when someone uploads it: a file connection cannot run on a schedule' USING ERRCODE = 'QM022';
  END IF;
  INSERT INTO public.integration_import_settings AS s (organisation_id, connection_id, entity_type, write_mode, match_existing, on_missing, schedule)
  VALUES (c.organisation_id, c.id, p_entity, v_mode, v_match, v_missing, v_schedule)
  ON CONFLICT (connection_id, entity_type) DO UPDATE
     SET write_mode = EXCLUDED.write_mode, match_existing = EXCLUDED.match_existing, on_missing = EXCLUDED.on_missing, schedule = EXCLUDED.schedule,
         updated_at = now(), updated_by = auth.uid()
   WHERE (s.write_mode, s.match_existing, s.on_missing, s.schedule) IS DISTINCT FROM (EXCLUDED.write_mode, EXCLUDED.match_existing, EXCLUDED.on_missing, EXCLUDED.schedule);
  RETURN app.integration_settings_for(c.id, p_entity);
END $$;

-- ---------------------------------------------------------------------------
-- Who may really import a kind of record: the same write permission the screens need
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.integration_may_write(p_org uuid, p_entity text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE p_entity
    WHEN 'supplier' THEN app.has_permission(p_org, 'master_data.manage') OR app.has_permission(p_org, 'supplier_quality.manage')
    WHEN 'customer' THEN app.has_permission(p_org, 'master_data.manage')
    WHEN 'part' THEN app.has_permission(p_org, 'master_data.manage')
    WHEN 'machine' THEN app.has_permission(p_org, 'master_data.manage')
    WHEN 'employee' THEN app.has_permission(p_org, 'master_data.manage')
    WHEN 'gauge_type' THEN app.has_permission(p_org, 'calibration.manage')
    WHEN 'gauge' THEN app.has_permission(p_org, 'calibration.manage')
    WHEN 'nonconformance' THEN app.has_permission(p_org, 'ncr.create')
    ELSE false END
$$;

DROP FUNCTION app.request_integration_run(uuid, text, text, uuid);
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
  IF p_kind <> 'preview' AND NOT app.integration_may_write(c.organisation_id, p_entity) THEN
    RAISE EXCEPTION 'You can preview these records, but writing them to Fortress needs the permission to create and edit them' USING ERRCODE = '42501';
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
  INSERT INTO public.integration_sync_runs (organisation_id, connection_id, entity_type, kind, requested_by, cursor_start, cursor_next, file_id, mapping_id, settings)
  VALUES (c.organisation_id, c.id, p_entity, p_kind, auth.uid(), v_cursor, v_cursor, p_file, v_mapping, app.integration_settings_for(c.id, p_entity))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION app.request_integration_run(uuid, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.request_integration_run(uuid, text, text, uuid) TO authenticated;

-- A retry writes too: the same permission, and the settings in force now.
CREATE OR REPLACE FUNCTION app.retry_integration_rows(p_connection uuid, p_entity text, p_rows uuid[] DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.integration_connections%ROWTYPE; v_id uuid; n integer;
BEGIN
  c := app.integration_connection_for_write(p_connection, 'integrations.run');
  PERFORM app.integration_assert_entity(p_entity);
  IF c.status <> 'active' THEN RAISE EXCEPTION 'Only an active connection can import records' USING ERRCODE = 'QM022'; END IF;
  IF NOT app.integration_may_write(c.organisation_id, p_entity) THEN
    RAISE EXCEPTION 'Retrying writes the records to Fortress, which needs the permission to create and edit them' USING ERRCODE = '42501';
  END IF;
  PERFORM app.integration_assert_idle(c.id, p_entity);
  INSERT INTO public.integration_sync_runs (organisation_id, connection_id, entity_type, kind, requested_by, fetch_done, settings)
  VALUES (c.organisation_id, c.id, p_entity, 'retry', auth.uid(), true, app.integration_settings_for(c.id, p_entity))
  RETURNING id INTO v_id;
  UPDATE public.integration_inbox SET retry_run_id = v_id, updated_at = now()
   WHERE connection_id = c.id AND entity_type = p_entity AND status = 'failed' AND (p_rows IS NULL OR id = ANY (p_rows));
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN RAISE EXCEPTION 'There are no failed rows to retry' USING ERRCODE = 'QM022'; END IF;
  UPDATE public.integration_sync_runs SET records_total = n WHERE id = v_id;
  RETURN v_id;
END $$;

-- The lease also hands the engine the frozen settings.
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
    'settings', coalesce(r.settings, app.integration_settings_for(r.connection_id, r.entity_type)),
    'file', CASE WHEN f.id IS NULL THEN NULL ELSE jsonb_build_object('id', f.id, 'status', f.status, 'chunkCount', f.chunk_count, 'headers', to_jsonb(f.headers)) END,
    'mapping', CASE WHEN m.id IS NULL THEN NULL ELSE jsonb_build_object('id', m.id, 'version', m.version, 'keyField', m.key_field, 'fields', m.fields) END);
END $$;

-- ---------------------------------------------------------------------------
-- Matching and references (D9 matching, D10 references)
-- ---------------------------------------------------------------------------
-- The Fortress record of a kind with this code (ignoring case), or null. Departments and units are matched the same way; a code shared by several
-- departments (one per site) is ambiguous and returns null (the lookup below says so).
CREATE FUNCTION app.integration_find_by_code(p_org uuid, p_kind text, p_code text) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid; v_code text := nullif(btrim(p_code), '');
BEGIN
  IF v_code IS NULL THEN RETURN NULL; END IF;
  CASE p_kind
    WHEN 'supplier' THEN SELECT id INTO v_id FROM public.suppliers WHERE organisation_id = p_org AND upper(code) = upper(v_code);
    WHEN 'customer' THEN SELECT id INTO v_id FROM public.customers WHERE organisation_id = p_org AND upper(code) = upper(v_code);
    WHEN 'part' THEN SELECT id INTO v_id FROM public.parts WHERE organisation_id = p_org AND upper(part_number) = upper(v_code);
    WHEN 'machine' THEN SELECT id INTO v_id FROM public.machines WHERE organisation_id = p_org AND upper(code) = upper(v_code);
    WHEN 'employee' THEN SELECT id INTO v_id FROM public."Employees" WHERE organisation_id = p_org AND upper(employee_number) = upper(v_code);
    WHEN 'gauge_type' THEN SELECT id INTO v_id FROM public.gauge_types WHERE organisation_id = p_org AND upper(name) = upper(v_code);
    WHEN 'gauge' THEN SELECT id INTO v_id FROM public.gauges WHERE organisation_id = p_org AND upper(asset_number) = upper(v_code) AND deleted_at IS NULL;
    WHEN 'site' THEN SELECT id INTO v_id FROM public.sites WHERE organisation_id = p_org AND upper(code) = upper(v_code);
    WHEN 'department' THEN
      IF (SELECT count(*) FROM public.departments WHERE organisation_id = p_org AND upper(code) = upper(v_code)) = 1 THEN
        SELECT id INTO v_id FROM public.departments WHERE organisation_id = p_org AND upper(code) = upper(v_code);
      END IF;
    WHEN 'category' THEN SELECT id INTO v_id FROM public.ncr_classifications WHERE organisation_id = p_org AND kind = 'category' AND upper(code) = upper(v_code);
    ELSE RETURN NULL;
  END CASE;
  RETURN v_id;
EXCEPTION WHEN too_many_rows THEN RETURN NULL;
END $$;

-- The code a mapped record carries, for matching it against records made by hand.
CREATE FUNCTION app.integration_record_code(p_entity text, p_data jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT nullif(btrim(CASE p_entity
    WHEN 'supplier' THEN p_data ->> 'code' WHEN 'customer' THEN p_data ->> 'code' WHEN 'machine' THEN p_data ->> 'code'
    WHEN 'part' THEN p_data ->> 'partNumber' WHEN 'employee' THEN p_data ->> 'employeeNumber'
    WHEN 'gauge_type' THEN p_data ->> 'name' WHEN 'gauge' THEN p_data ->> 'assetNumber' END), '')
$$;

-- Resolve values for references in one call: mode `source` = the id this connection's source gave a record of that kind in an earlier import (the map);
-- mode `code` = the Fortress code. Answers {value: id} for the values found ("unit" answers the unit code itself); a department code shared by several
-- departments answers "ambiguous".
CREATE FUNCTION app.system_integration_lookup(p_org uuid, p_run uuid, p_owner uuid, p_kind text, p_mode text, p_values text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.integration_sync_runs%ROWTYPE; v_out jsonb := '{}'::jsonb; v text; v_id uuid; v_unit text;
BEGIN
  r := app.integration_run_for_system(p_org, p_run, p_owner);
  IF p_mode NOT IN ('source', 'code') THEN RAISE EXCEPTION 'A reference is matched by the source id or by the Fortress code' USING ERRCODE = 'QM022'; END IF;
  IF cardinality(coalesce(p_values, '{}')) > 5000 THEN RAISE EXCEPTION 'Too many values to look up at once' USING ERRCODE = 'QM022'; END IF;
  IF p_mode = 'source' THEN
    PERFORM app.integration_assert_entity(p_kind);
    SELECT coalesce(jsonb_object_agg(x.external_id, x.internal_id), '{}'::jsonb) INTO v_out
      FROM public.integration_external_records x
     WHERE x.organisation_id = r.organisation_id AND x.connection_id = r.connection_id AND x.entity_type = p_kind AND x.external_id = ANY (p_values);
    RETURN v_out;
  END IF;
  FOREACH v IN ARRAY coalesce(p_values, '{}') LOOP
    IF p_kind = 'unit' THEN
      SELECT code INTO v_unit FROM public.units WHERE lower(code) = lower(btrim(v));
      IF v_unit IS NOT NULL THEN v_out := v_out || jsonb_build_object(v, v_unit); END IF;
      v_unit := NULL;
    ELSE
      v_id := app.integration_find_by_code(r.organisation_id, p_kind, v);
      IF v_id IS NOT NULL THEN v_out := v_out || jsonb_build_object(v, v_id);
      ELSIF p_kind = 'department' AND (SELECT count(*) FROM public.departments WHERE organisation_id = r.organisation_id AND upper(code) = upper(btrim(v))) > 1 THEN
        v_out := v_out || jsonb_build_object(v, 'ambiguous');
      END IF;
    END IF;
  END LOOP;
  RETURN v_out;
END $$;

-- ---------------------------------------------------------------------------
-- Staging honours the settings
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.system_stage_integration_records(p_org uuid, p_run uuid, p_owner uuid, p_records jsonb, p_next_cursor text, p_done boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.integration_sync_runs%ROWTYPE; s jsonb; v_mode text; v_match boolean;
        n_total integer; n_rejected integer; n_unchanged integer; n_skipped integer; n_create integer; n_update integer; n_superseded integer := 0;
BEGIN
  r := app.integration_run_for_system(p_org, p_run, p_owner);
  IF r.kind = 'retry' OR r.fetch_done THEN RAISE EXCEPTION 'Nothing more is fetched for this import' USING ERRCODE = 'QM022'; END IF;
  IF jsonb_typeof(coalesce(p_records, 'null'::jsonb)) <> 'array' THEN RAISE EXCEPTION 'Records arrive as a list' USING ERRCODE = 'QM022'; END IF;
  IF r.records_total + jsonb_array_length(p_records) > 100000 THEN RAISE EXCEPTION 'An import is limited to 100,000 rows' USING ERRCODE = 'QM022'; END IF;
  s := coalesce(r.settings, app.integration_settings_for(r.connection_id, r.entity_type));
  v_mode := coalesce(s ->> 'writeMode', 'add_only');
  v_match := coalesce((s ->> 'matchExisting')::boolean, false) AND r.entity_type <> 'nonconformance';

  WITH src AS (
    SELECT t.ord, t.e, nullif(btrim(t.e ->> 'externalId'), '') AS ext,
           encode(sha256(convert_to(coalesce(t.e -> 'canonical', t.e -> 'payload')::text, 'UTF8')), 'hex') AS hash
      FROM jsonb_array_elements(p_records) WITH ORDINALITY AS t(e, ord)
  ), ranked AS (
    SELECT s1.*, row_number() OVER (PARTITION BY s1.ext ORDER BY s1.ord) AS dup,
           EXISTS (SELECT 1 FROM public.integration_inbox i WHERE i.run_id = r.id AND i.external_id = s1.ext AND i.status <> 'rejected') AS seen,
           x.internal_id AS mapped, x.content_hash AS mapped_hash,
           CASE WHEN v_match AND x.internal_id IS NULL AND jsonb_typeof(s1.e -> 'canonical') = 'object'
                THEN app.integration_find_by_code(r.organisation_id, r.entity_type, app.integration_record_code(r.entity_type, s1.e -> 'canonical')) END AS matched,
           CASE
             WHEN jsonb_typeof(s1.e -> 'payload') IS DISTINCT FROM 'object' THEN jsonb_build_array(jsonb_build_object('field', NULL, 'message', 'The record is not a set of fields'))
             WHEN s1.ext IS NULL THEN jsonb_build_array(jsonb_build_object('field', 'externalId', 'message', 'The record has no identifier'))
             WHEN length(s1.ext) > 200 THEN jsonb_build_array(jsonb_build_object('field', 'externalId', 'message', 'The identifier is longer than 200 characters'))
             WHEN jsonb_typeof(s1.e -> 'errors') = 'array' AND jsonb_array_length(s1.e -> 'errors') > 0 THEN s1.e -> 'errors'
             ELSE NULL END AS problem
      FROM src s1
      LEFT JOIN public.integration_external_records x
        ON x.organisation_id = r.organisation_id AND x.connection_id = r.connection_id AND x.entity_type = r.entity_type AND x.external_id = s1.ext
  ), decided AS (
    SELECT k.*,
           coalesce(k.mapped, k.matched) AS target,
           -- a record made by hand that is already linked to another record from this source cannot be matched again
           (k.matched IS NOT NULL AND EXISTS (SELECT 1 FROM public.integration_external_records y
              WHERE y.organisation_id = r.organisation_id AND y.connection_id = r.connection_id AND y.entity_type = r.entity_type AND y.internal_id = k.matched)) AS taken
      FROM ranked k
  ), ins AS (
    INSERT INTO public.integration_inbox (organisation_id, connection_id, run_id, entity_type, external_id, source_row, payload, canonical, content_hash, status, action, internal_id, errors, last_run_id)
    SELECT r.organisation_id, r.connection_id, r.id, r.entity_type, left(d.ext, 200),
           CASE WHEN (d.e ->> 'sourceRow') ~ '^[0-9]{1,9}$' THEN (d.e ->> 'sourceRow')::integer END,
           CASE WHEN jsonb_typeof(d.e -> 'payload') = 'object' THEN d.e -> 'payload' END,
           CASE WHEN jsonb_typeof(d.e -> 'canonical') = 'object' THEN d.e -> 'canonical' END,
           d.hash,
           CASE WHEN d.problem IS NOT NULL OR d.dup > 1 OR d.seen OR d.taken THEN 'rejected'
                WHEN d.mapped_hash = d.hash THEN 'unchanged'
                WHEN v_mode = 'add_only' AND d.target IS NOT NULL THEN 'skipped'
                WHEN v_mode = 'update_only' AND d.target IS NULL THEN 'skipped'
                WHEN r.kind = 'preview' THEN 'previewed'
                ELSE 'staged' END,
           CASE WHEN d.problem IS NOT NULL OR d.dup > 1 OR d.seen OR d.taken OR d.mapped_hash = d.hash
                  OR (v_mode = 'add_only' AND d.target IS NOT NULL) OR (v_mode = 'update_only' AND d.target IS NULL) THEN NULL
                WHEN d.target IS NULL THEN 'create' ELSE 'update' END,
           d.target,
           CASE WHEN d.problem IS NOT NULL THEN d.problem
                WHEN d.dup > 1 OR d.seen THEN jsonb_build_array(jsonb_build_object('field', 'externalId', 'message', 'This identifier appears more than once in the import'))
                WHEN d.taken THEN jsonb_build_array(jsonb_build_object('field', NULL, 'message', 'The Fortress record with this code is already linked to another record from this source'))
                WHEN d.mapped_hash = d.hash THEN '[]'::jsonb
                WHEN v_mode = 'add_only' AND d.target IS NOT NULL THEN jsonb_build_array(jsonb_build_object('field', NULL, 'message',
                  CASE WHEN d.mapped IS NOT NULL THEN 'Already imported: this import only adds new records' ELSE 'Already in Fortress: this import only adds new records' END))
                WHEN v_mode = 'update_only' AND d.target IS NULL THEN jsonb_build_array(jsonb_build_object('field', NULL, 'message', 'Not in Fortress yet: this import only updates existing records'))
                ELSE '[]'::jsonb END,
           r.id
      FROM decided d
     ORDER BY d.ord
    RETURNING status, action
  )
  SELECT count(*), count(*) FILTER (WHERE status = 'rejected'), count(*) FILTER (WHERE status = 'unchanged'), count(*) FILTER (WHERE status = 'skipped'),
         count(*) FILTER (WHERE action = 'create'), count(*) FILTER (WHERE action = 'update')
    INTO n_total, n_rejected, n_unchanged, n_skipped, n_create, n_update
    FROM ins;

  IF r.kind <> 'preview' AND n_unchanged > 0 THEN
    UPDATE public.integration_inbox o SET status = 'superseded', retry_run_id = NULL, updated_at = now()
     WHERE o.connection_id = r.connection_id AND o.entity_type = r.entity_type AND o.status = 'failed'
       AND EXISTS (SELECT 1 FROM public.integration_inbox n WHERE n.run_id = r.id AND n.status = 'unchanged' AND n.external_id = o.external_id);
    GET DIAGNOSTICS n_superseded = ROW_COUNT;
  END IF;

  UPDATE public.integration_sync_runs
     SET records_total = records_total + n_total, rejected = rejected + n_rejected, unchanged = unchanged + n_unchanged, skipped = skipped + n_skipped,
         superseded = superseded + n_superseded,
         created = created + CASE WHEN kind = 'preview' THEN n_create ELSE 0 END, updated = updated + CASE WHEN kind = 'preview' THEN n_update ELSE 0 END,
         cursor_next = p_next_cursor, fetch_done = coalesce(p_done, false), updated_at = now()
   WHERE id = r.id;
  RETURN jsonb_build_object('received', n_total, 'rejected', n_rejected, 'unchanged', n_unchanged, 'skipped', n_skipped, 'toCreate', n_create, 'toUpdate', n_update);
END $$;

-- A matched record (made by hand) is applied as an update of that record; the map links it when the row is applied.
CREATE OR REPLACE FUNCTION app.system_integration_rows_to_apply(p_org uuid, p_run uuid, p_owner uuid, p_limit integer DEFAULT 200) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.integration_sync_runs%ROWTYPE; v_limit integer := least(greatest(coalesce(p_limit, 200), 1), 1000); v_rows jsonb; n integer;
BEGIN
  r := app.integration_run_for_system(p_org, p_run, p_owner);
  IF r.kind = 'preview' THEN RETURN '[]'::jsonb; END IF;
  IF r.kind = 'retry' THEN
    UPDATE public.integration_inbox o SET status = 'superseded', updated_at = now()
     WHERE o.retry_run_id = r.id AND o.status = 'failed'
       AND EXISTS (SELECT 1 FROM public.integration_inbox n WHERE n.connection_id = o.connection_id AND n.entity_type = o.entity_type AND n.external_id = o.external_id
                     AND n.created_at > o.created_at AND (n.status IN ('applied', 'unchanged') OR (n.status = 'failed' AND n.retry_run_id = r.id)));
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN UPDATE public.integration_sync_runs SET superseded = superseded + n, updated_at = now() WHERE id = r.id; END IF;
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'externalId', q.external_id, 'sourceRow', q.source_row, 'payload', q.payload, 'canonical', q.canonical,
           'internalId', coalesce(x.internal_id, q.internal_id),
           'action', CASE WHEN coalesce(x.internal_id, q.internal_id) IS NULL THEN 'create' ELSE 'update' END) ORDER BY q.created_at, q.source_row, q.id), '[]'::jsonb)
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

CREATE OR REPLACE FUNCTION app.system_finish_integration_run(p_org uuid, p_run uuid, p_owner uuid) RETURNS text
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
    WHEN r.failed + r.rejected > 0 AND r.created + r.updated + r.unchanged + r.skipped = 0 THEN 'failed'
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

-- ---------------------------------------------------------------------------
-- Import functions (IN4b): one record through the same rules as the screens
-- ---------------------------------------------------------------------------
-- Helpers: a key present in the record (mapped), its text (empty = null), a number, a date, a boolean, a resolved reference id.
CREATE FUNCTION app.imp_has(d jsonb, k text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$ SELECT d ? k $$;
CREATE FUNCTION app.imp_text(d jsonb, k text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path = '' AS $$ SELECT nullif(btrim(d ->> k), '') $$;
CREATE FUNCTION app.imp_num(d jsonb, k text) RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path = '' AS $$ SELECT (nullif(btrim(d ->> k), ''))::numeric $$;
CREATE FUNCTION app.imp_int(d jsonb, k text) RETURNS integer LANGUAGE sql IMMUTABLE SET search_path = '' AS $$ SELECT (nullif(btrim(d ->> k), ''))::integer $$;
CREATE FUNCTION app.imp_date(d jsonb, k text) RETURNS date LANGUAGE sql IMMUTABLE SET search_path = '' AS $$ SELECT (nullif(btrim(d ->> k), ''))::date $$;
CREATE FUNCTION app.imp_bool(d jsonb, k text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$ SELECT (d ->> k)::boolean $$;
-- A reference field `k` was resolved by the API into `kId` (or a unit into `kCode`).
CREATE FUNCTION app.imp_ref(d jsonb, k text) RETURNS uuid LANGUAGE sql IMMUTABLE SET search_path = '' AS $$ SELECT (nullif(d ->> (k || 'Id'), ''))::uuid $$;

CREATE FUNCTION app.import_supplier(p_org uuid, p_id uuid, d jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid;
BEGIN
  IF p_id IS NULL THEN
    INSERT INTO public.suppliers (organisation_id, code, name, display_name, company_number, vat_number, notes, active, supplier_type, email, phone, website,
                                  address_line1, address_line2, city, region, postcode, country, purchasing_reference)
    VALUES (p_org, app.imp_text(d, 'code'), app.imp_text(d, 'name'), app.imp_text(d, 'displayName'), app.imp_text(d, 'companyNumber'), app.imp_text(d, 'vatNumber'),
            app.imp_text(d, 'notes'), coalesce(app.imp_bool(d, 'active'), true), app.imp_text(d, 'supplierType'), app.imp_text(d, 'email'), app.imp_text(d, 'phone'),
            app.imp_text(d, 'website'), app.imp_text(d, 'addressLine1'), app.imp_text(d, 'addressLine2'), app.imp_text(d, 'city'), app.imp_text(d, 'region'),
            app.imp_text(d, 'postcode'), app.imp_text(d, 'country'), app.imp_text(d, 'purchasingReference'))
    RETURNING id INTO v_id;
    RETURN v_id;
  END IF;
  UPDATE public.suppliers SET
    code = CASE WHEN d ? 'code' THEN app.imp_text(d, 'code') ELSE code END,
    name = CASE WHEN d ? 'name' THEN app.imp_text(d, 'name') ELSE name END,
    display_name = CASE WHEN d ? 'displayName' THEN app.imp_text(d, 'displayName') ELSE display_name END,
    company_number = CASE WHEN d ? 'companyNumber' THEN app.imp_text(d, 'companyNumber') ELSE company_number END,
    vat_number = CASE WHEN d ? 'vatNumber' THEN app.imp_text(d, 'vatNumber') ELSE vat_number END,
    notes = CASE WHEN d ? 'notes' THEN app.imp_text(d, 'notes') ELSE notes END,
    active = CASE WHEN d ? 'active' THEN coalesce(app.imp_bool(d, 'active'), active) ELSE active END,
    supplier_type = CASE WHEN d ? 'supplierType' THEN app.imp_text(d, 'supplierType') ELSE supplier_type END,
    email = CASE WHEN d ? 'email' THEN app.imp_text(d, 'email') ELSE email END,
    phone = CASE WHEN d ? 'phone' THEN app.imp_text(d, 'phone') ELSE phone END,
    website = CASE WHEN d ? 'website' THEN app.imp_text(d, 'website') ELSE website END,
    address_line1 = CASE WHEN d ? 'addressLine1' THEN app.imp_text(d, 'addressLine1') ELSE address_line1 END,
    address_line2 = CASE WHEN d ? 'addressLine2' THEN app.imp_text(d, 'addressLine2') ELSE address_line2 END,
    city = CASE WHEN d ? 'city' THEN app.imp_text(d, 'city') ELSE city END,
    region = CASE WHEN d ? 'region' THEN app.imp_text(d, 'region') ELSE region END,
    postcode = CASE WHEN d ? 'postcode' THEN app.imp_text(d, 'postcode') ELSE postcode END,
    country = CASE WHEN d ? 'country' THEN app.imp_text(d, 'country') ELSE country END,
    purchasing_reference = CASE WHEN d ? 'purchasingReference' THEN app.imp_text(d, 'purchasingReference') ELSE purchasing_reference END,
    updated_at = now(), updated_by = auth.uid()
  WHERE id = p_id AND organisation_id = p_org RETURNING id INTO v_id;
  IF v_id IS NULL THEN RAISE EXCEPTION 'The supplier this record was linked to no longer exists' USING ERRCODE = 'QM022'; END IF;
  RETURN v_id;
END $$;

CREATE FUNCTION app.import_customer(p_org uuid, p_id uuid, d jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid;
BEGIN
  IF p_id IS NULL THEN
    INSERT INTO public.customers (organisation_id, code, name, display_name, company_number, vat_number, notes, active)
    VALUES (p_org, app.imp_text(d, 'code'), app.imp_text(d, 'name'), app.imp_text(d, 'displayName'), app.imp_text(d, 'companyNumber'), app.imp_text(d, 'vatNumber'),
            app.imp_text(d, 'notes'), coalesce(app.imp_bool(d, 'active'), true))
    RETURNING id INTO v_id;
    RETURN v_id;
  END IF;
  UPDATE public.customers SET
    code = CASE WHEN d ? 'code' THEN app.imp_text(d, 'code') ELSE code END,
    name = CASE WHEN d ? 'name' THEN app.imp_text(d, 'name') ELSE name END,
    display_name = CASE WHEN d ? 'displayName' THEN app.imp_text(d, 'displayName') ELSE display_name END,
    company_number = CASE WHEN d ? 'companyNumber' THEN app.imp_text(d, 'companyNumber') ELSE company_number END,
    vat_number = CASE WHEN d ? 'vatNumber' THEN app.imp_text(d, 'vatNumber') ELSE vat_number END,
    notes = CASE WHEN d ? 'notes' THEN app.imp_text(d, 'notes') ELSE notes END,
    active = CASE WHEN d ? 'active' THEN coalesce(app.imp_bool(d, 'active'), active) ELSE active END,
    updated_at = now(), updated_by = auth.uid()
  WHERE id = p_id AND organisation_id = p_org RETURNING id INTO v_id;
  IF v_id IS NULL THEN RAISE EXCEPTION 'The customer this record was linked to no longer exists' USING ERRCODE = 'QM022'; END IF;
  RETURN v_id;
END $$;

-- A part, and (when given and new) a draft revision of it. Releasing a revision stays a person's step (D6).
CREATE FUNCTION app.import_part(p_org uuid, p_id uuid, d jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid; v_rev text := app.imp_text(d, 'revision');
BEGIN
  IF p_id IS NULL THEN
    INSERT INTO public.parts (organisation_id, part_number, name, description, active)
    VALUES (p_org, app.imp_text(d, 'partNumber'), app.imp_text(d, 'name'), app.imp_text(d, 'description'), coalesce(app.imp_bool(d, 'active'), true))
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.parts SET
      part_number = CASE WHEN d ? 'partNumber' THEN app.imp_text(d, 'partNumber') ELSE part_number END,
      name = CASE WHEN d ? 'name' THEN app.imp_text(d, 'name') ELSE name END,
      description = CASE WHEN d ? 'description' THEN app.imp_text(d, 'description') ELSE description END,
      active = CASE WHEN d ? 'active' THEN coalesce(app.imp_bool(d, 'active'), active) ELSE active END,
      updated_at = now(), updated_by = auth.uid()
    WHERE id = p_id AND organisation_id = p_org RETURNING id INTO v_id;
    IF v_id IS NULL THEN RAISE EXCEPTION 'The part this record was linked to no longer exists' USING ERRCODE = 'QM022'; END IF;
  END IF;
  IF v_rev IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.part_revisions WHERE part_id = v_id AND upper(revision) = upper(v_rev)) THEN
    INSERT INTO public.part_revisions (organisation_id, part_id, revision) VALUES (p_org, v_id, v_rev);
  END IF;
  RETURN v_id;
END $$;

CREATE FUNCTION app.import_machine(p_org uuid, p_id uuid, d jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid;
BEGIN
  IF p_id IS NULL THEN
    INSERT INTO public.machines (organisation_id, code, name, site_id, work_centre, description, active)
    VALUES (p_org, app.imp_text(d, 'code'), app.imp_text(d, 'name'), app.imp_ref(d, 'site'), app.imp_text(d, 'workCentre'), app.imp_text(d, 'description'),
            coalesce(app.imp_bool(d, 'active'), true))
    RETURNING id INTO v_id;
    RETURN v_id;
  END IF;
  UPDATE public.machines SET
    code = CASE WHEN d ? 'code' THEN app.imp_text(d, 'code') ELSE code END,
    name = CASE WHEN d ? 'name' THEN app.imp_text(d, 'name') ELSE name END,
    site_id = CASE WHEN d ? 'site' THEN app.imp_ref(d, 'site') ELSE site_id END,
    work_centre = CASE WHEN d ? 'workCentre' THEN app.imp_text(d, 'workCentre') ELSE work_centre END,
    description = CASE WHEN d ? 'description' THEN app.imp_text(d, 'description') ELSE description END,
    active = CASE WHEN d ? 'active' THEN coalesce(app.imp_bool(d, 'active'), active) ELSE active END,
    updated_at = now(), updated_by = auth.uid()
  WHERE id = p_id AND organisation_id = p_org RETURNING id INTO v_id;
  IF v_id IS NULL THEN RAISE EXCEPTION 'The machine this record was linked to no longer exists' USING ERRCODE = 'QM022'; END IF;
  RETURN v_id;
END $$;

CREATE FUNCTION app.import_employee(p_org uuid, p_id uuid, d jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid;
BEGIN
  IF p_id IS NULL THEN
    INSERT INTO public."Employees" (organisation_id, employee_number, first_name, surname, job_title, email, site_id, department_id, active)
    VALUES (p_org, app.imp_text(d, 'employeeNumber'), app.imp_text(d, 'firstName'), app.imp_text(d, 'surname'), app.imp_text(d, 'jobTitle'), app.imp_text(d, 'email'),
            app.imp_ref(d, 'site'), app.imp_ref(d, 'department'), coalesce(app.imp_bool(d, 'active'), true))
    RETURNING id INTO v_id;
    RETURN v_id;
  END IF;
  UPDATE public."Employees" SET
    employee_number = CASE WHEN d ? 'employeeNumber' THEN app.imp_text(d, 'employeeNumber') ELSE employee_number END,
    first_name = CASE WHEN d ? 'firstName' THEN app.imp_text(d, 'firstName') ELSE first_name END,
    surname = CASE WHEN d ? 'surname' THEN app.imp_text(d, 'surname') ELSE surname END,
    job_title = CASE WHEN d ? 'jobTitle' THEN app.imp_text(d, 'jobTitle') ELSE job_title END,
    email = CASE WHEN d ? 'email' THEN app.imp_text(d, 'email') ELSE email END,
    site_id = CASE WHEN d ? 'site' THEN app.imp_ref(d, 'site') ELSE site_id END,
    department_id = CASE WHEN d ? 'department' THEN app.imp_ref(d, 'department') ELSE department_id END,
    active = CASE WHEN d ? 'active' THEN coalesce(app.imp_bool(d, 'active'), active) ELSE active END,
    updated_at = now(), updated_by = auth.uid()
  WHERE id = p_id AND organisation_id = p_org RETURNING id INTO v_id;
  IF v_id IS NULL THEN RAISE EXCEPTION 'The employee this record was linked to no longer exists' USING ERRCODE = 'QM022'; END IF;
  RETURN v_id;
END $$;

CREATE FUNCTION app.import_gauge_type(p_org uuid, p_id uuid, d jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid;
BEGIN
  IF p_id IS NULL THEN
    INSERT INTO public.gauge_types (organisation_id, name, description, interval_value, interval_unit, active)
    VALUES (p_org, app.imp_text(d, 'name'), app.imp_text(d, 'description'), coalesce(app.imp_int(d, 'intervalValue'), 12), coalesce(app.imp_text(d, 'intervalUnit'), 'months'),
            coalesce(app.imp_bool(d, 'active'), true))
    RETURNING id INTO v_id;
    RETURN v_id;
  END IF;
  UPDATE public.gauge_types SET
    name = CASE WHEN d ? 'name' THEN app.imp_text(d, 'name') ELSE name END,
    description = CASE WHEN d ? 'description' THEN app.imp_text(d, 'description') ELSE description END,
    interval_value = CASE WHEN d ? 'intervalValue' THEN coalesce(app.imp_int(d, 'intervalValue'), interval_value) ELSE interval_value END,
    interval_unit = CASE WHEN d ? 'intervalUnit' THEN coalesce(app.imp_text(d, 'intervalUnit'), interval_unit) ELSE interval_unit END,
    active = CASE WHEN d ? 'active' THEN coalesce(app.imp_bool(d, 'active'), active) ELSE active END,
    updated_at = now(), updated_by = auth.uid()
  WHERE id = p_id AND organisation_id = p_org RETURNING id INTO v_id;
  IF v_id IS NULL THEN RAISE EXCEPTION 'The gauge type this record was linked to no longer exists' USING ERRCODE = 'QM022'; END IF;
  RETURN v_id;
END $$;

-- A gauge: never its calibration dates or status (they follow the calibrations recorded in Fortress).
CREATE FUNCTION app.import_gauge(p_org uuid, p_id uuid, d jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid;
BEGIN
  IF p_id IS NULL THEN
    INSERT INTO public.gauges (organisation_id, asset_number, description, gauge_type_id, manufacturer, model, serial_number, site_id, department_id, location,
                               range_min, range_max, unit_code, resolution, calibration_source, supplier_id, interval_value, interval_unit, commissioned_on, notes)
    VALUES (p_org, app.imp_text(d, 'assetNumber'), app.imp_text(d, 'description'), app.imp_ref(d, 'gaugeType'), app.imp_text(d, 'manufacturer'), app.imp_text(d, 'model'),
            app.imp_text(d, 'serialNumber'), app.imp_ref(d, 'site'), app.imp_ref(d, 'department'), app.imp_text(d, 'location'), app.imp_num(d, 'rangeMin'),
            app.imp_num(d, 'rangeMax'), app.imp_text(d, 'unitCode'), app.imp_num(d, 'resolution'), coalesce(app.imp_text(d, 'calibrationSource'), 'internal'),
            app.imp_ref(d, 'supplier'), app.imp_int(d, 'intervalValue'), app.imp_text(d, 'intervalUnit'), app.imp_date(d, 'commissionedOn'), app.imp_text(d, 'notes'))
    RETURNING id INTO v_id;
    RETURN v_id;
  END IF;
  UPDATE public.gauges SET
    asset_number = CASE WHEN d ? 'assetNumber' THEN app.imp_text(d, 'assetNumber') ELSE asset_number END,
    description = CASE WHEN d ? 'description' THEN app.imp_text(d, 'description') ELSE description END,
    gauge_type_id = CASE WHEN d ? 'gaugeType' THEN app.imp_ref(d, 'gaugeType') ELSE gauge_type_id END,
    manufacturer = CASE WHEN d ? 'manufacturer' THEN app.imp_text(d, 'manufacturer') ELSE manufacturer END,
    model = CASE WHEN d ? 'model' THEN app.imp_text(d, 'model') ELSE model END,
    serial_number = CASE WHEN d ? 'serialNumber' THEN app.imp_text(d, 'serialNumber') ELSE serial_number END,
    site_id = CASE WHEN d ? 'site' THEN app.imp_ref(d, 'site') ELSE site_id END,
    department_id = CASE WHEN d ? 'department' THEN app.imp_ref(d, 'department') ELSE department_id END,
    location = CASE WHEN d ? 'location' THEN app.imp_text(d, 'location') ELSE location END,
    range_min = CASE WHEN d ? 'rangeMin' THEN app.imp_num(d, 'rangeMin') ELSE range_min END,
    range_max = CASE WHEN d ? 'rangeMax' THEN app.imp_num(d, 'rangeMax') ELSE range_max END,
    unit_code = CASE WHEN d ? 'unit' THEN app.imp_text(d, 'unitCode') ELSE unit_code END,
    resolution = CASE WHEN d ? 'resolution' THEN app.imp_num(d, 'resolution') ELSE resolution END,
    calibration_source = CASE WHEN d ? 'calibrationSource' THEN coalesce(app.imp_text(d, 'calibrationSource'), calibration_source) ELSE calibration_source END,
    supplier_id = CASE WHEN d ? 'supplier' THEN app.imp_ref(d, 'supplier') ELSE supplier_id END,
    interval_value = CASE WHEN d ? 'intervalValue' THEN app.imp_int(d, 'intervalValue') ELSE interval_value END,
    interval_unit = CASE WHEN d ? 'intervalUnit' THEN app.imp_text(d, 'intervalUnit') ELSE interval_unit END,
    commissioned_on = CASE WHEN d ? 'commissionedOn' THEN app.imp_date(d, 'commissionedOn') ELSE commissioned_on END,
    notes = CASE WHEN d ? 'notes' THEN app.imp_text(d, 'notes') ELSE notes END,
    updated_at = now(), updated_by = auth.uid()
  WHERE id = p_id AND organisation_id = p_org AND deleted_at IS NULL RETURNING id INTO v_id;
  IF v_id IS NULL THEN RAISE EXCEPTION 'The gauge this record was linked to no longer exists' USING ERRCODE = 'QM022'; END IF;
  RETURN v_id;
END $$;

-- A historical non-conformance: always a new draft with a Fortress reference; opening, moving and closing it stay people's steps.
CREATE FUNCTION app.import_nonconformance(p_org uuid, p_id uuid, d jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid;
BEGIN
  IF p_id IS NOT NULL THEN RAISE EXCEPTION 'Non-conformances are only ever added: once in Fortress they are managed there' USING ERRCODE = 'QM022'; END IF;
  INSERT INTO public.nonconformances (organisation_id, source, stage, title, severity, description, requirement, actual_result, site_id, part_id, customer_id, supplier_id,
                                      work_order, purchase_order, customer_reference, lot_number, serial_number, quantity_affected, quantity_inspected, detected_at,
                                      detection_process_id, causal_process_id, responsible_employee_id, category_id)
  VALUES (p_org, app.imp_text(d, 'source'), 'draft', app.imp_text(d, 'title'), app.imp_text(d, 'severity'), app.imp_text(d, 'description'), app.imp_text(d, 'requirement'),
          app.imp_text(d, 'actualResult'), app.imp_ref(d, 'site'), app.imp_ref(d, 'part'), app.imp_ref(d, 'customer'), app.imp_ref(d, 'supplier'),
          app.imp_text(d, 'workOrder'), app.imp_text(d, 'purchaseOrder'), app.imp_text(d, 'customerReference'), app.imp_text(d, 'lotNumber'), app.imp_text(d, 'serialNumber'),
          app.imp_num(d, 'quantityAffected'), app.imp_num(d, 'quantityInspected'), coalesce(app.imp_date(d, 'detectedAt'), current_date),
          app.imp_ref(d, 'detectionMachine'), app.imp_ref(d, 'causalMachine'), app.imp_ref(d, 'responsibleEmployee'), app.imp_ref(d, 'category'))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- The one entry point the API calls for a staged row, inside the row's savepoint and before app.system_apply_integration_row. It re-checks the run, the
-- lease and the row, refuses what the frozen settings do not allow, then acts as the person who started the run (their claims for the rest of this
-- transaction, so every table trigger applies its user rules and stamps them) and writes the record through its kind's import function.
CREATE FUNCTION app.system_import_record(p_org uuid, p_run uuid, p_owner uuid, p_row uuid, p_internal uuid, p_data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.integration_sync_runs%ROWTYPE; i public.integration_inbox%ROWTYPE; s jsonb; v_mode text;
BEGIN
  r := app.integration_run_for_system(p_org, p_run, p_owner);
  i := app.integration_row_for_system(r, p_row);
  IF jsonb_typeof(coalesce(p_data, 'null'::jsonb)) <> 'object' THEN RAISE EXCEPTION 'The record has no mapped fields' USING ERRCODE = 'QM022'; END IF;
  s := coalesce(r.settings, app.integration_settings_for(r.connection_id, r.entity_type));
  v_mode := CASE WHEN r.entity_type = 'nonconformance' THEN 'add_only' ELSE coalesce(s ->> 'writeMode', 'add_only') END;
  IF p_internal IS NOT NULL AND v_mode = 'add_only' THEN RAISE EXCEPTION 'This import only adds new records' USING ERRCODE = 'QM022'; END IF;
  IF p_internal IS NULL AND v_mode = 'update_only' THEN RAISE EXCEPTION 'This import only updates existing records' USING ERRCODE = 'QM022'; END IF;
  IF r.requested_by IS NULL THEN RAISE EXCEPTION 'This import has nobody to act for' USING ERRCODE = 'QM022'; END IF;
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', r.requested_by, 'role', 'authenticated')::text, true);
  PERFORM set_config('app.source', 'integration', true);
  PERFORM set_config('app.initiating_user', r.requested_by::text, true);
  RETURN CASE r.entity_type
    WHEN 'supplier' THEN app.import_supplier(p_org, p_internal, p_data)
    WHEN 'customer' THEN app.import_customer(p_org, p_internal, p_data)
    WHEN 'part' THEN app.import_part(p_org, p_internal, p_data)
    WHEN 'machine' THEN app.import_machine(p_org, p_internal, p_data)
    WHEN 'employee' THEN app.import_employee(p_org, p_internal, p_data)
    WHEN 'gauge_type' THEN app.import_gauge_type(p_org, p_internal, p_data)
    WHEN 'gauge' THEN app.import_gauge(p_org, p_internal, p_data)
    WHEN 'nonconformance' THEN app.import_nonconformance(p_org, p_internal, p_data)
    ELSE app.integration_no_importer(r.entity_type) END;
END $$;

CREATE FUNCTION app.integration_no_importer(p_entity text) RETURNS uuid
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'Importing % records is not available yet', replace(p_entity, '_', ' ') USING ERRCODE = 'QM022';
END $$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app.integration_entity_has_active(text), app.integration_settings_for(uuid, text),
  app.integration_find_by_code(uuid, text, text), app.integration_record_code(text, jsonb), app.integration_no_importer(text),
  app.imp_has(jsonb, text), app.imp_text(jsonb, text), app.imp_num(jsonb, text), app.imp_int(jsonb, text), app.imp_date(jsonb, text), app.imp_bool(jsonb, text), app.imp_ref(jsonb, text),
  app.import_supplier(uuid, uuid, jsonb), app.import_customer(uuid, uuid, jsonb), app.import_part(uuid, uuid, jsonb), app.import_machine(uuid, uuid, jsonb),
  app.import_employee(uuid, uuid, jsonb), app.import_gauge_type(uuid, uuid, jsonb), app.import_gauge(uuid, uuid, jsonb), app.import_nonconformance(uuid, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.set_integration_import_settings(uuid, text, jsonb), app.integration_may_write(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.set_integration_import_settings(uuid, text, jsonb), app.integration_may_write(uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION app.system_integration_lookup(uuid, uuid, uuid, text, text, text[]), app.system_import_record(uuid, uuid, uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.system_integration_lookup(uuid, uuid, uuid, text, text, text[]), app.system_import_record(uuid, uuid, uuid, uuid, uuid, jsonb) TO qms_api;
