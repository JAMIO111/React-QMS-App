-- Import templates (docs/import-templates-plan.md, slice UI2a; decisions T1–T5).
--  * integration_templates: organisation-wide (T1), one kind of record each, named (unique per organisation and kind, ignoring case), archived with a
--    reason and restored, never deleted.
--  * integration_template_versions: frozen once saved. How to read the file (source settings), the columns it was made against, the key column, the
--    field rows (a column or a formula, then steps; checked by the API) and the import settings (write mode, match existing). A new version needs a
--    reason; one that changes nothing is refused.
--  * Runs can be pinned to a template version (template_version_id): the lease hands its key column and field rows to the engine as the mapping, and
--    its import settings are frozen on the run.
--  * Every connection's mappings are carried over: one template per connection and kind of record, its versions in order, the current import settings
--    on the latest. integration_mappings stays for the runs that used it.
--  * organisation_settings.advanced_imports: the formula editor and the template manager are shown when it is on (E6).
--  Writes only through functions, integrations.manage (which needs a Controller seat, T4). Errors QM022 -> 409 integration_rule; P0002 -> 404.

ALTER TABLE public.organisation_settings ADD COLUMN advanced_imports boolean NOT NULL DEFAULT false;
GRANT UPDATE (advanced_imports) ON public.organisation_settings TO authenticated;

CREATE TABLE public.integration_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type = ANY (app.integration_entity_types())),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120 AND name = btrim(name)),
  description text CHECK (description IS NULL OR length(description) BETWEEN 1 AND 1000),
  current_version integer NOT NULL DEFAULT 0,
  archived_at timestamptz,
  archived_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  archive_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT integration_templates_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT integration_templates_archived CHECK ((archived_at IS NULL) = (archive_reason IS NULL))
);
CREATE UNIQUE INDEX integration_templates_name_key ON public.integration_templates (organisation_id, entity_type, lower(name));
CREATE TRIGGER integration_templates_touch BEFORE UPDATE ON public.integration_templates FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER integration_templates_org_immutable BEFORE UPDATE ON public.integration_templates FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.integration_templates FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.integration_templates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.integration_templates FROM anon, authenticated;
GRANT SELECT ON public.integration_templates TO authenticated;
CREATE POLICY integration_templates_select ON public.integration_templates FOR SELECT TO authenticated USING (app.has_permission(organisation_id, 'integrations.read'));

CREATE TABLE public.integration_template_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  template_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  source_settings jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(source_settings) = 'object'),
  expected_columns text[] NOT NULL DEFAULT ARRAY[]::text[],
  key_field text NOT NULL CHECK (length(btrim(key_field)) BETWEEN 1 AND 200),
  fields jsonb NOT NULL CHECK (jsonb_typeof(fields) = 'array' AND jsonb_array_length(fields) BETWEEN 1 AND 100),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object'),
  reason text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 1000),
  carried_from_mapping_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT integration_template_versions_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT integration_template_versions_number_key UNIQUE (template_id, version),
  CONSTRAINT integration_template_versions_template_fkey FOREIGN KEY (template_id, organisation_id) REFERENCES public.integration_templates (id, organisation_id)
);
CREATE INDEX integration_template_versions_org_idx ON public.integration_template_versions (organisation_id);
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.integration_template_versions FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.integration_template_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.integration_template_versions FROM anon, authenticated;
GRANT SELECT ON public.integration_template_versions TO authenticated;
CREATE POLICY integration_template_versions_select ON public.integration_template_versions FOR SELECT TO authenticated USING (app.has_permission(organisation_id, 'integrations.read'));

CREATE FUNCTION app.integration_template_version_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'A saved template version never changes: save a new version' USING ERRCODE = 'QM022';
END $$;
CREATE TRIGGER integration_template_versions_frozen BEFORE UPDATE OR DELETE ON public.integration_template_versions FOR EACH ROW EXECUTE FUNCTION app.integration_template_version_frozen();

ALTER TABLE public.integration_sync_runs
  ADD COLUMN template_version_id uuid,
  ADD CONSTRAINT integration_sync_runs_template_version_fkey FOREIGN KEY (template_version_id, organisation_id) REFERENCES public.integration_template_versions (id, organisation_id);

-- ---------------------------------------------------------------------------
-- Checking a template's content (the API checks the field rows against the catalogue; this keeps the shape safe)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.integration_template_body_problem(p_body jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE
    WHEN p_body IS NULL OR jsonb_typeof(p_body) <> 'object' THEN 'The template has no content'
    WHEN length(btrim(coalesce(p_body ->> 'keyField', ''))) = 0 THEN 'Choose the column that identifies each record'
    WHEN length(p_body ->> 'keyField') > 200 THEN 'The key column name is too long'
    WHEN jsonb_typeof(p_body -> 'fields') IS DISTINCT FROM 'array' OR jsonb_array_length(p_body -> 'fields') NOT BETWEEN 1 AND 100 THEN 'Map 1 to 100 fields'
    WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(p_body -> 'fields') e WHERE jsonb_typeof(e) <> 'object' OR coalesce(e ->> 'target', '') = '') THEN 'Every mapped field names its target'
    WHEN p_body ? 'sourceSettings' AND jsonb_typeof(p_body -> 'sourceSettings') <> 'object' THEN 'The source settings are not valid'
    WHEN p_body ? 'settings' AND jsonb_typeof(p_body -> 'settings') <> 'object' THEN 'The import settings are not valid'
    WHEN p_body -> 'settings' ->> 'writeMode' IS NOT NULL AND p_body -> 'settings' ->> 'writeMode' NOT IN ('add_only', 'add_update', 'update_only') THEN 'Choose add new only, add and update, or update only'
    WHEN p_body ? 'expectedColumns' AND (jsonb_typeof(p_body -> 'expectedColumns') <> 'array' OR jsonb_array_length(p_body -> 'expectedColumns') > 1000) THEN 'The expected columns are not valid'
    WHEN pg_column_size(p_body) > 262144 THEN 'The template is too large'
    ELSE NULL END
$$;

-- Import settings a version keeps: write mode and matching (NCs are always add only and never matched).
CREATE FUNCTION app.integration_template_settings(p_entity text, p_settings jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'writeMode', CASE WHEN p_entity = 'nonconformance' THEN 'add_only' ELSE coalesce(p_settings ->> 'writeMode', 'add_only') END,
    'matchExisting', CASE WHEN p_entity = 'nonconformance' THEN false ELSE coalesce((p_settings ->> 'matchExisting')::boolean, false) END)
$$;

CREATE FUNCTION app.integration_template_for_write(p_template uuid) RETURNS public.integration_templates
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE t public.integration_templates%ROWTYPE;
BEGIN
  SELECT * INTO t FROM public.integration_templates WHERE id = p_template FOR UPDATE;
  IF NOT FOUND OR NOT app.has_permission(t.organisation_id, 'integrations.read') THEN RAISE EXCEPTION 'Template not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(t.organisation_id, 'integrations.manage') THEN
    RAISE EXCEPTION 'Only people who manage integrations can change templates' USING ERRCODE = '42501';
  END IF;
  RETURN t;
END $$;

-- ---------------------------------------------------------------------------
-- Templates
-- ---------------------------------------------------------------------------
-- A new template with its first version. p_body: keyField, fields, sourceSettings, expectedColumns, settings.
CREATE FUNCTION app.create_integration_template(p_org uuid, p_entity text, p_name text, p_description text, p_body jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid; v_problem text;
BEGIN
  IF NOT app.has_permission(p_org, 'integrations.manage') THEN
    RAISE EXCEPTION 'Only people who manage integrations can save templates' USING ERRCODE = '42501';
  END IF;
  PERFORM app.integration_assert_entity(p_entity);
  IF length(btrim(coalesce(p_name, ''))) NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION 'Give the template a name of up to 120 characters' USING ERRCODE = 'QM022'; END IF;
  IF EXISTS (SELECT 1 FROM public.integration_templates WHERE organisation_id = p_org AND entity_type = p_entity AND lower(name) = lower(btrim(p_name))) THEN
    RAISE EXCEPTION 'A template with this name already exists for this kind of record' USING ERRCODE = 'QM022';
  END IF;
  v_problem := app.integration_template_body_problem(p_body);
  IF v_problem IS NOT NULL THEN RAISE EXCEPTION '%', v_problem USING ERRCODE = 'QM022'; END IF;
  INSERT INTO public.integration_templates (organisation_id, entity_type, name, description, current_version)
  VALUES (p_org, p_entity, btrim(p_name), nullif(left(btrim(coalesce(p_description, '')), 1000), ''), 1)
  RETURNING id INTO v_id;
  INSERT INTO public.integration_template_versions (organisation_id, template_id, version, source_settings, expected_columns, key_field, fields, settings)
  VALUES (p_org, v_id, 1, coalesce(p_body -> 'sourceSettings', '{}'::jsonb),
          coalesce((SELECT array_agg(c ORDER BY n) FROM jsonb_array_elements_text(p_body -> 'expectedColumns') WITH ORDINALITY AS x(c, n)), ARRAY[]::text[]),
          btrim(p_body ->> 'keyField'), p_body -> 'fields', app.integration_template_settings(p_entity, p_body -> 'settings'));
  RETURN v_id;
END $$;

-- A new version: a reason is required; one that changes nothing (key column, fields, source settings, import settings) is refused.
CREATE FUNCTION app.save_integration_template_version(p_template uuid, p_body jsonb, p_reason text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE t public.integration_templates%ROWTYPE; cur public.integration_template_versions%ROWTYPE; v_problem text; v_settings jsonb;
BEGIN
  t := app.integration_template_for_write(p_template);
  IF t.archived_at IS NOT NULL THEN RAISE EXCEPTION 'This template is archived: restore it first' USING ERRCODE = 'QM022'; END IF;
  v_problem := app.integration_template_body_problem(p_body);
  IF v_problem IS NOT NULL THEN RAISE EXCEPTION '%', v_problem USING ERRCODE = 'QM022'; END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 3 THEN RAISE EXCEPTION 'Say why the template is changing' USING ERRCODE = 'QM022'; END IF;
  SELECT * INTO cur FROM public.integration_template_versions WHERE template_id = t.id AND version = t.current_version;
  v_settings := app.integration_template_settings(t.entity_type, p_body -> 'settings');
  IF cur.key_field = btrim(p_body ->> 'keyField') AND cur.fields = p_body -> 'fields'
     AND cur.source_settings = coalesce(p_body -> 'sourceSettings', '{}'::jsonb) AND cur.settings = v_settings THEN
    RAISE EXCEPTION 'Nothing has changed in the template' USING ERRCODE = 'QM022';
  END IF;
  INSERT INTO public.integration_template_versions (organisation_id, template_id, version, source_settings, expected_columns, key_field, fields, settings, reason)
  VALUES (t.organisation_id, t.id, t.current_version + 1, coalesce(p_body -> 'sourceSettings', '{}'::jsonb),
          coalesce((SELECT array_agg(c ORDER BY n) FROM jsonb_array_elements_text(p_body -> 'expectedColumns') WITH ORDINALITY AS x(c, n)), cur.expected_columns),
          btrim(p_body ->> 'keyField'), p_body -> 'fields', v_settings, left(btrim(p_reason), 1000));
  UPDATE public.integration_templates SET current_version = t.current_version + 1, updated_by = auth.uid() WHERE id = t.id;
  RETURN t.current_version + 1;
END $$;

CREATE FUNCTION app.update_integration_template(p_template uuid, p_name text, p_description text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE t public.integration_templates%ROWTYPE;
BEGIN
  t := app.integration_template_for_write(p_template);
  IF length(btrim(coalesce(p_name, ''))) NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION 'Give the template a name of up to 120 characters' USING ERRCODE = 'QM022'; END IF;
  IF EXISTS (SELECT 1 FROM public.integration_templates WHERE organisation_id = t.organisation_id AND entity_type = t.entity_type AND lower(name) = lower(btrim(p_name)) AND id <> t.id) THEN
    RAISE EXCEPTION 'A template with this name already exists for this kind of record' USING ERRCODE = 'QM022';
  END IF;
  UPDATE public.integration_templates SET name = btrim(p_name), description = nullif(left(btrim(coalesce(p_description, '')), 1000), ''), updated_by = auth.uid() WHERE id = t.id;
END $$;

CREATE FUNCTION app.archive_integration_template(p_template uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE t public.integration_templates%ROWTYPE;
BEGIN
  t := app.integration_template_for_write(p_template);
  IF t.archived_at IS NOT NULL THEN RAISE EXCEPTION 'This template is archived already' USING ERRCODE = 'QM022'; END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 3 THEN RAISE EXCEPTION 'Say why the template is archived' USING ERRCODE = 'QM022'; END IF;
  UPDATE public.integration_templates SET archived_at = now(), archived_by = auth.uid(), archive_reason = left(btrim(p_reason), 1000), updated_by = auth.uid() WHERE id = t.id;
END $$;

CREATE FUNCTION app.restore_integration_template(p_template uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE t public.integration_templates%ROWTYPE;
BEGIN
  t := app.integration_template_for_write(p_template);
  IF t.archived_at IS NULL THEN RAISE EXCEPTION 'This template is in use already' USING ERRCODE = 'QM022'; END IF;
  UPDATE public.integration_templates SET archived_at = NULL, archived_by = NULL, archive_reason = NULL, updated_by = auth.uid() WHERE id = t.id;
END $$;

-- A copy of the current version as a new template.
CREATE FUNCTION app.duplicate_integration_template(p_template uuid, p_name text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE t public.integration_templates%ROWTYPE; cur public.integration_template_versions%ROWTYPE;
BEGIN
  t := app.integration_template_for_write(p_template);
  SELECT * INTO cur FROM public.integration_template_versions WHERE template_id = t.id AND version = t.current_version;
  RETURN app.create_integration_template(t.organisation_id, t.entity_type, coalesce(nullif(btrim(p_name), ''), left('Copy of ' || t.name, 120)), t.description,
    jsonb_build_object('keyField', cur.key_field, 'fields', cur.fields, 'sourceSettings', cur.source_settings, 'expectedColumns', to_jsonb(cur.expected_columns), 'settings', cur.settings));
END $$;

-- Bring back an earlier version's content as a new version (with a reason).
CREATE FUNCTION app.restore_integration_template_version(p_template uuid, p_version integer, p_reason text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE t public.integration_templates%ROWTYPE; old public.integration_template_versions%ROWTYPE;
BEGIN
  t := app.integration_template_for_write(p_template);
  SELECT * INTO old FROM public.integration_template_versions WHERE template_id = t.id AND version = p_version;
  IF NOT FOUND THEN RAISE EXCEPTION 'Version % not found', p_version USING ERRCODE = 'P0002'; END IF;
  RETURN app.save_integration_template_version(t.id,
    jsonb_build_object('keyField', old.key_field, 'fields', old.fields, 'sourceSettings', old.source_settings, 'expectedColumns', to_jsonb(old.expected_columns), 'settings', old.settings),
    p_reason);
END $$;

-- ---------------------------------------------------------------------------
-- Runs with a template
-- ---------------------------------------------------------------------------
DROP FUNCTION app.request_integration_run(uuid, text, text, uuid);
CREATE FUNCTION app.request_integration_run(p_connection uuid, p_entity text, p_kind text, p_file uuid DEFAULT NULL, p_template uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.integration_connections%ROWTYPE; v_provider text; v_cursor text; v_id uuid; v_mapping uuid; f public.integration_files%ROWTYPE;
        t public.integration_templates%ROWTYPE; tv public.integration_template_versions%ROWTYPE; v_settings jsonb;
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
  PERFORM app.integration_assert_idle(c.id, p_entity);
  IF p_kind = 'incremental' THEN
    SELECT cursor INTO v_cursor FROM public.integration_sync_cursors WHERE connection_id = c.id AND entity_type = p_entity;
  END IF;
  INSERT INTO public.integration_sync_runs (organisation_id, connection_id, entity_type, kind, requested_by, cursor_start, cursor_next, file_id, mapping_id, template_version_id, settings)
  VALUES (c.organisation_id, c.id, p_entity, p_kind, auth.uid(), v_cursor, v_cursor, p_file, v_mapping, tv.id, v_settings)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION app.system_lease_integration_run(p_org uuid, p_run uuid, p_owner uuid, p_seconds integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.integration_sync_runs%ROWTYPE; c public.integration_connections%ROWTYPE; v_provider text; m public.integration_mappings%ROWTYPE; f public.integration_files%ROWTYPE;
        tv public.integration_template_versions%ROWTYPE; v_mapping jsonb;
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
    'mapping', v_mapping);
END $$;

-- ---------------------------------------------------------------------------
-- Carry over the mappings people already have (idempotent: a connection and kind of record that has a carried template is skipped)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.carry_integration_mappings_to_templates() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE g record; m record; v_template uuid; v_name text; v_n integer; v_count integer := 0; v_settings jsonb; v_last integer;
BEGIN
  FOR g IN SELECT DISTINCT mp.organisation_id, mp.connection_id, mp.entity_type, c.name AS connection_name
           FROM public.integration_mappings mp JOIN public.integration_connections c ON c.id = mp.connection_id
           WHERE NOT EXISTS (SELECT 1 FROM public.integration_template_versions v JOIN public.integration_mappings x ON x.id = v.carried_from_mapping_id
                             WHERE x.connection_id = mp.connection_id AND x.entity_type = mp.entity_type)
           ORDER BY 1, 2, 3 LOOP
    v_name := left(g.connection_name || ' — ' || replace(g.entity_type, '_', ' '), 116);
    v_n := 1;
    WHILE EXISTS (SELECT 1 FROM public.integration_templates WHERE organisation_id = g.organisation_id AND entity_type = g.entity_type
                  AND lower(name) = lower(CASE WHEN v_n = 1 THEN v_name ELSE v_name || ' ' || v_n END)) LOOP
      v_n := v_n + 1;
    END LOOP;
    v_settings := app.integration_template_settings(g.entity_type, app.integration_settings_for(g.connection_id, g.entity_type));
    INSERT INTO public.integration_templates (organisation_id, entity_type, name, description, current_version, created_by)
    VALUES (g.organisation_id, g.entity_type, CASE WHEN v_n = 1 THEN v_name ELSE v_name || ' ' || v_n END, 'Carried over from the connection''s mapping', 0,
            (SELECT created_by FROM public.integration_mappings WHERE connection_id = g.connection_id AND entity_type = g.entity_type ORDER BY version LIMIT 1))
    RETURNING id INTO v_template;
    v_last := 0;
    FOR m IN SELECT * FROM public.integration_mappings WHERE connection_id = g.connection_id AND entity_type = g.entity_type ORDER BY version LOOP
      v_last := v_last + 1;
      INSERT INTO public.integration_template_versions (organisation_id, template_id, version, key_field, fields, settings, reason, carried_from_mapping_id, created_at, created_by)
      VALUES (g.organisation_id, v_template, v_last, m.key_field, m.fields,
              CASE WHEN m.superseded_at IS NULL THEN v_settings ELSE app.integration_template_settings(g.entity_type, '{}'::jsonb) END,
              m.reason, m.id, m.created_at, m.created_by);
    END LOOP;
    UPDATE public.integration_templates SET current_version = v_last WHERE id = v_template;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $$;

ALTER TABLE public.integration_templates DISABLE TRIGGER USER;
ALTER TABLE public.integration_template_versions DISABLE TRIGGER USER;
SELECT app.carry_integration_mappings_to_templates();
ALTER TABLE public.integration_templates ENABLE TRIGGER USER;
ALTER TABLE public.integration_template_versions ENABLE TRIGGER USER;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app.integration_template_body_problem(jsonb), app.integration_template_settings(text, jsonb), app.integration_template_version_frozen(),
  app.integration_template_for_write(uuid), app.carry_integration_mappings_to_templates() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.create_integration_template(uuid, text, text, text, jsonb), app.save_integration_template_version(uuid, jsonb, text),
  app.update_integration_template(uuid, text, text), app.archive_integration_template(uuid, text), app.restore_integration_template(uuid),
  app.duplicate_integration_template(uuid, text), app.restore_integration_template_version(uuid, integer, text),
  app.request_integration_run(uuid, text, text, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.create_integration_template(uuid, text, text, text, jsonb), app.save_integration_template_version(uuid, jsonb, text),
  app.update_integration_template(uuid, text, text), app.archive_integration_template(uuid, text), app.restore_integration_template(uuid),
  app.duplicate_integration_template(uuid, text), app.restore_integration_template_version(uuid, integer, text),
  app.request_integration_run(uuid, text, text, uuid, uuid) TO authenticated;
