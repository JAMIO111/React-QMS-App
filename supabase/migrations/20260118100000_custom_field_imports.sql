-- Custom fields CF4: imports fill custom fields.
--  * app.custom_field_catalogue(org, entity): the active custom fields of a kind of record, for the import catalogue (API login only; the import
--    engine reads it without a person's session). The API offers each one as a mapping target `cf_<key>`.
--  * app.import_custom_values(org, entity, record, data): takes the `cf_<key>` values of an imported record, turns what a file holds into what is
--    stored (a choice by its key or label, several choices as a list separated by commas or semicolons, a person by email address or full name),
--    leaves out empty values (an import never clears a custom value) and writes the rest through app.write_custom_values, which checks every value.
--  * app.system_import_record now writes the custom values after the record, then checks "required when saved" for that record at once (the check is
--    otherwise deferred to the end of the whole import transaction, where one record without a value would fail every row).

CREATE FUNCTION app.custom_field_catalogue(p_org uuid, p_entity text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'key', d.key, 'label', d.label, 'fieldType', d.field_type, 'requiredAt', d.required_at, 'helpText', d.help_text,
           'options', (SELECT coalesce(jsonb_agg(o), '[]'::jsonb) FROM jsonb_array_elements(d.options) o WHERE coalesce((o ->> 'active')::boolean, true)),
           'min', d.number_min, 'max', d.number_max, 'decimals', d.number_decimals, 'unit', d.number_unit)
         ORDER BY d.position, d.label), '[]'::jsonb)
  FROM public.custom_field_definitions d
  WHERE d.organisation_id = p_org AND d.entity_type = p_entity AND d.active
$$;

-- One option key from what a file holds: the key itself or the label, ignoring case; the text as it is when nothing matches (the value check then says so).
CREATE FUNCTION app.custom_option_key(d public.custom_field_definitions, p_text text) RETURNS text
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT coalesce(
    (SELECT o ->> 'key' FROM jsonb_array_elements(d.options) o WHERE lower(o ->> 'key') = lower(btrim(p_text)) LIMIT 1),
    (SELECT o ->> 'key' FROM jsonb_array_elements(d.options) o WHERE lower(btrim(o ->> 'label')) = lower(btrim(p_text)) LIMIT 1),
    btrim(p_text))
$$;

CREATE FUNCTION app.import_custom_values(p_org uuid, p_entity text, p_record uuid, p_data jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_key text;
  v_raw jsonb;
  v_text text;
  v_values jsonb := '{}'::jsonb;
  v_user uuid;
  v_n integer;
  d public.custom_field_definitions;
BEGIN
  FOR v_key, v_raw IN SELECT key, value FROM jsonb_each(coalesce(p_data, '{}'::jsonb)) WHERE key LIKE 'cf\_%' LOOP
    IF v_raw IS NULL OR v_raw = 'null'::jsonb OR v_raw = '""'::jsonb OR v_raw = '[]'::jsonb THEN CONTINUE; END IF;
    SELECT * INTO d FROM public.custom_field_definitions WHERE organisation_id = p_org AND entity_type = p_entity AND key = substr(v_key, 4) AND active;
    IF d.id IS NULL THEN
      RAISE EXCEPTION 'There is no custom field "%" on this kind of record any more: change the mapping', substr(v_key, 4) USING ERRCODE = 'QM023';
    END IF;
    v_text := v_raw #>> '{}';
    CASE d.field_type
      WHEN 'choice' THEN
        v_raw := to_jsonb(app.custom_option_key(d, v_text));
      WHEN 'multi_choice' THEN
        IF jsonb_typeof(v_raw) = 'string' THEN
          SELECT coalesce(jsonb_agg(app.custom_option_key(d, part)), '[]'::jsonb) INTO v_raw
          FROM regexp_split_to_table(v_text, '\s*[,;]\s*') part WHERE btrim(part) <> '';
        END IF;
      WHEN 'person' THEN
        IF v_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
          SELECT m.user_id INTO v_user FROM public.organisation_users m JOIN auth.users u ON u.id = m.user_id
          WHERE m.organisation_id = p_org AND m.status = 'active' AND lower(u.email) = lower(btrim(v_text)) LIMIT 1;
          IF v_user IS NULL THEN
            SELECT count(*), min(m.user_id::text)::uuid INTO v_n, v_user FROM public.organisation_users m JOIN public.profiles p ON p.id = m.user_id
            WHERE m.organisation_id = p_org AND m.status = 'active' AND lower(btrim(concat_ws(' ', p.first_name, p.surname))) = lower(btrim(v_text));
            IF v_n <> 1 THEN v_user := NULL; END IF;
          END IF;
          IF v_user IS NULL THEN
            RAISE EXCEPTION '%: nobody in the organisation is called or has the email address "%"', d.label, v_text USING ERRCODE = 'QM023';
          END IF;
          v_raw := to_jsonb(v_user::text);
        END IF;
      ELSE NULL;
    END CASE;
    v_values := jsonb_set(v_values, ARRAY[d.key], v_raw);
  END LOOP;
  IF v_values <> '{}'::jsonb THEN
    PERFORM app.write_custom_values(p_entity, p_record, p_org, v_values);
  END IF;
  -- Fields required when the record is saved: checked now, for this record, not at the end of the whole import.
  SET CONSTRAINTS public.custom_values_required IMMEDIATE;
  SET CONSTRAINTS public.custom_values_required DEFERRED;
END $$;

CREATE OR REPLACE FUNCTION app.system_import_record(p_org uuid, p_run uuid, p_owner uuid, p_row uuid, p_internal uuid, p_data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.integration_sync_runs%ROWTYPE; i public.integration_inbox%ROWTYPE; s jsonb; v_mode text; v_id uuid;
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
  v_id := CASE r.entity_type
    WHEN 'supplier' THEN app.import_supplier(p_org, p_internal, p_data)
    WHEN 'customer' THEN app.import_customer(p_org, p_internal, p_data)
    WHEN 'part' THEN app.import_part(p_org, p_internal, p_data)
    WHEN 'machine' THEN app.import_machine(p_org, p_internal, p_data)
    WHEN 'employee' THEN app.import_employee(p_org, p_internal, p_data)
    WHEN 'gauge_type' THEN app.import_gauge_type(p_org, p_internal, p_data)
    WHEN 'gauge' THEN app.import_gauge(p_org, p_internal, p_data)
    WHEN 'nonconformance' THEN app.import_nonconformance(p_org, p_internal, p_data)
    ELSE app.integration_no_importer(r.entity_type) END;
  PERFORM app.import_custom_values(p_org, r.entity_type, v_id, p_data);
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION app.custom_field_catalogue(uuid, text), app.custom_option_key(public.custom_field_definitions, text),
  app.import_custom_values(uuid, text, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.custom_field_catalogue(uuid, text) TO qms_api;
