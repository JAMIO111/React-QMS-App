-- Custom field locks (docs/import-field-locks-plan.md, the "custom fields" slice after LK4).
--
-- A scheduled import that updates a record already owns the columns its template maps as "source wins" (20260418100000). The same template can map a
-- custom field (`cf_<key>`), and the import writes it on every run, so a person's edit of it would be overwritten just the same. The rule is the one
-- for columns, worked out live and never stored: the record is one the connection imported, the connection is active, the schedule is on, the
-- template (current version, not archived) updates records and maps the field as source wins. Custom fields that are retired are never locked.
--
-- Custom values are not a column of the record's table, so the table guard cannot see them: people write them through app.set_custom_values, which now
-- checks the same rule. The import writes them through app.write_custom_values (app.import_custom_values), which is not changed, so it is never refused.
-- A change is a value that differs from what is stored once checked and tidied (the same comparison the locked-record check makes), so a form that sends
-- a locked field back unchanged still saves.
--
-- One difference to know about: an import never clears a custom value (an empty value in the file is skipped), so a locked custom field the source
-- leaves empty stays as it is; to clear it, switch the field to "Fortress wins" in the template or switch the schedule off.

-- ---------------------------------------------------------------------------
-- The rule: custom fields come back too, with no column (col is null). The columns' guard looks only at rows that have one.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.integration_locked_internal(p_org uuid, p_entity text, p_record uuid)
RETURNS TABLE (field text, col text, connection_id uuid, connection_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT DISTINCT e.f ->> 'target', m.value, c.id, c.name
    FROM public.integration_external_records er
    JOIN public.integration_connections c ON c.id = er.connection_id AND c.organisation_id = er.organisation_id AND c.status = 'active'
    JOIN public.integration_import_settings st ON st.connection_id = er.connection_id AND st.organisation_id = er.organisation_id AND st.entity_type = er.entity_type
    JOIN public.integration_templates t ON t.id = st.template_id AND t.organisation_id = st.organisation_id AND t.archived_at IS NULL
    JOIN public.integration_template_versions tv ON tv.template_id = t.id AND tv.organisation_id = t.organisation_id AND tv.version = t.current_version
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(tv.fields) = 'array' THEN tv.fields ELSE '[]'::jsonb END) e (f)
    LEFT JOIN LATERAL (SELECT x.value FROM jsonb_each_text(app.integration_field_columns(p_entity)) x WHERE x.key = e.f ->> 'target') m ON true
   WHERE er.organisation_id = p_org AND er.entity_type = p_entity AND er.internal_id = p_record
     AND st.schedule <> 'manual'
     AND coalesce(tv.settings ->> 'writeMode', 'add_only') IN ('add_update', 'update_only')
     AND coalesce(e.f ->> 'ownership', '') NOT IN ('qms_wins', 'manual_review')
     AND (m.value IS NOT NULL
          OR (e.f ->> 'target' LIKE 'cf\_%'
              AND EXISTS (SELECT 1 FROM public.custom_field_definitions d
                           WHERE d.organisation_id = p_org AND d.entity_type = p_entity AND d.active AND d.key = substr(e.f ->> 'target', 4))))
$$;
REVOKE ALL ON FUNCTION app.integration_locked_internal(uuid, text, uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The columns' guard: unchanged except that it judges only fields that fill a column.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.integration_lock_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_entity text := TG_ARGV[0]; v_old jsonb; v_new jsonb; v_fields text[]; v_conn text;
BEGIN
  IF coalesce(auth.role(), '') <> 'authenticated' OR coalesce(current_setting('app.source', true), '') = 'integration' THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.integration_external_records er WHERE er.organisation_id = OLD.organisation_id AND er.entity_type = v_entity AND er.internal_id = OLD.id) THEN
    RETURN NEW;
  END IF;
  v_old := to_jsonb(OLD); v_new := to_jsonb(NEW);
  SELECT array_agg(DISTINCT l.field ORDER BY l.field), min(l.connection_name) INTO v_fields, v_conn
    FROM app.integration_locked_internal(OLD.organisation_id, v_entity, OLD.id) l
   WHERE l.col IS NOT NULL AND v_old -> l.col IS DISTINCT FROM v_new -> l.col;
  IF v_fields IS NOT NULL THEN
    RAISE EXCEPTION 'Managed by % while its schedule is on: % cannot be changed here', v_conn, array_to_string(v_fields, ', ')
      USING ERRCODE = 'QM033', DETAIL = jsonb_build_object('fields', to_jsonb(v_fields), 'connection', v_conn)::text;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.integration_lock_guard() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- People write custom values here (the record's own edit permission, the record not closed); now also: not a field a scheduled import owns.
-- The error names the fields by their label for the person and by their `cf_<key>` in the detail, as GET /import-locks does.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.set_custom_values(p_entity text, p_record uuid, p_values jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  r record;
  v_old jsonb;
  v_fields text[];
  v_labels text[];
  v_conn text;
BEGIN
  IF NOT (p_entity = ANY (app.custom_field_entities())) THEN
    RAISE EXCEPTION 'Custom fields are not available on %', p_entity USING ERRCODE = 'QM023';
  END IF;
  SELECT * INTO r FROM app.custom_field_record(p_entity, p_record);
  IF r.org IS NULL OR NOT app.custom_values_readable(r.org, p_entity) THEN
    RAISE EXCEPTION 'Record not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT app.custom_values_writable(r.org, p_entity) THEN
    RAISE EXCEPTION 'You are not allowed to change this record' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_values) = 'object' AND coalesce(auth.role(), '') = 'authenticated' AND coalesce(current_setting('app.source', true), '') <> 'integration' THEN
    v_old := coalesce((SELECT "values" FROM public.custom_field_values WHERE record_id = p_record), '{}'::jsonb);
    SELECT array_agg(l.field ORDER BY d.position, d.label), array_agg(d.label ORDER BY d.position, d.label), min(l.connection_name)
      INTO v_fields, v_labels, v_conn
      FROM app.integration_locked_internal(r.org, p_entity, p_record) l
      JOIN public.custom_field_definitions d ON d.organisation_id = r.org AND d.entity_type = p_entity AND l.field = 'cf_' || d.key
     WHERE l.col IS NULL AND p_values ? d.key
       AND app.custom_field_value(d, p_values -> d.key, v_old -> d.key) IS DISTINCT FROM (v_old -> d.key);
    IF v_fields IS NOT NULL THEN
      RAISE EXCEPTION 'Managed by % while its schedule is on: % cannot be changed here', v_conn, array_to_string(v_labels, ', ')
        USING ERRCODE = 'QM033', DETAIL = jsonb_build_object('fields', to_jsonb(v_fields), 'connection', v_conn)::text;
    END IF;
  END IF;
  IF r.locked AND app.write_custom_values_dry(p_entity, p_record, r.org, p_values) THEN
    RAISE EXCEPTION 'This record is closed, so its custom fields cannot change' USING ERRCODE = 'QM023';
  END IF;
  RETURN app.write_custom_values(p_entity, p_record, r.org, p_values);
END $$;
