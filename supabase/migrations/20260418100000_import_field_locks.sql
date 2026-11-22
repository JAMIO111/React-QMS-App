-- Import field locks (docs/import-field-locks-plan.md, decision LK-D1).
--
-- A scheduled import that updates a record owns the fields its template maps as "source wins": a person's edit would be overwritten by the next run.
-- While that is true Fortress refuses the edit and the forms show the field as managed by the connection. Nothing is stored: the lock is worked out
-- from what already exists, so switching the schedule off, pausing or retiring the connection, or moving the field to "Fortress wins" / "review" in
-- the template unlocks it at once.
--
-- A field of a record is locked when ALL of these hold:
--   1. the record is one the connection imported (a row in integration_external_records);
--   2. the connection is active;
--   3. the schedule for that kind of record is on and the template's write mode updates records (a run takes the template's settings over the connection's,
--      and a template always records one);
--   4. the schedule's template (not archived), at its current version, maps the field and the field is not "Fortress wins" or "review".
-- The import itself (app.source = 'integration', set by app.system_import_record) is never refused, and neither is SQL run by the system.

-- ---------------------------------------------------------------------------
-- Which kinds of record can be locked, in which table, and where each catalogue field lands (mirrors ENTITY_COLUMNS in
-- api/src/integrations/core/columns.ts; test/integration-catalogue-drift.e2e-spec.ts compares the two). Fields that land in another table (a part's
-- revision) are not here.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.integration_lock_table(p_entity text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE p_entity
    WHEN 'supplier' THEN 'suppliers' WHEN 'customer' THEN 'customers' WHEN 'part' THEN 'parts' WHEN 'machine' THEN 'machines'
    WHEN 'employee' THEN 'Employees' WHEN 'gauge_type' THEN 'gauge_types' WHEN 'gauge' THEN 'gauges' WHEN 'production_order' THEN 'production_orders'
  END
$$;

CREATE FUNCTION app.integration_field_columns(p_entity text) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE p_entity
    WHEN 'supplier' THEN '{"code":"code","name":"name","displayName":"display_name","companyNumber":"company_number","vatNumber":"vat_number","notes":"notes","active":"active",
      "supplierType":"supplier_type","email":"email","phone":"phone","website":"website","addressLine1":"address_line1","addressLine2":"address_line2","addressLine3":"address_line3",
      "currency":"currency","city":"city","region":"region","postcode":"postcode","country":"country","purchasingReference":"purchasing_reference"}'::jsonb
    WHEN 'customer' THEN '{"code":"code","name":"name","displayName":"display_name","companyNumber":"company_number","vatNumber":"vat_number","notes":"notes","active":"active",
      "addressLine1":"address_line1","addressLine2":"address_line2","addressLine3":"address_line3","city":"city","region":"region","postcode":"postcode","country":"country",
      "currency":"currency","email":"email","phone":"phone","website":"website"}'::jsonb
    WHEN 'part' THEN '{"partNumber":"part_number","name":"name","description":"description","active":"active"}'::jsonb
    WHEN 'machine' THEN '{"code":"code","name":"name","site":"site_id","workCentre":"work_centre","description":"description","active":"active"}'::jsonb
    WHEN 'employee' THEN '{"employeeNumber":"employee_number","firstName":"first_name","surname":"surname","jobTitle":"job_title","email":"email","site":"site_id",
      "department":"department_id","active":"active"}'::jsonb
    WHEN 'gauge_type' THEN '{"code":"code","name":"name","description":"description","intervalValue":"interval_value","intervalUnit":"interval_unit","active":"active"}'::jsonb
    WHEN 'gauge' THEN '{"assetNumber":"asset_number","description":"description","gaugeType":"gauge_type_id","manufacturer":"manufacturer","model":"model","serialNumber":"serial_number",
      "site":"site_id","department":"department_id","location":"location","rangeMin":"range_min","rangeMax":"range_max","unit":"unit_code","resolution":"resolution",
      "calibrationSource":"calibration_source","supplier":"supplier_id","intervalValue":"interval_value","intervalUnit":"interval_unit","commissionedOn":"commissioned_on","notes":"notes"}'::jsonb
    WHEN 'production_order' THEN '{"orderNumber":"order_number","part":"part_id","partRevision":"part_revision_id","customer":"customer_id","site":"site_id",
      "quantityPlanned":"quantity_planned","dueDate":"due_date","status":"status","statusReason":"status_reason","notes":"notes"}'::jsonb
    ELSE '{}'::jsonb
  END
$$;

REVOKE ALL ON FUNCTION app.integration_lock_table(text), app.integration_field_columns(text) FROM PUBLIC, anon, authenticated;

-- A hand-made lookup by (organisation, kind, record) across connections: the table's own keys start with the connection.
CREATE INDEX integration_external_records_entity_internal_idx ON public.integration_external_records (organisation_id, entity_type, internal_id);

-- ---------------------------------------------------------------------------
-- The rule, once. No permission check: callers are the guard trigger and the function below.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.integration_locked_internal(p_org uuid, p_entity text, p_record uuid)
RETURNS TABLE (field text, col text, connection_id uuid, connection_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT DISTINCT e.f ->> 'target', m.value, c.id, c.name
    FROM public.integration_external_records er
    JOIN public.integration_connections c ON c.id = er.connection_id AND c.organisation_id = er.organisation_id AND c.status = 'active'
    JOIN public.integration_import_settings st ON st.connection_id = er.connection_id AND st.organisation_id = er.organisation_id AND st.entity_type = er.entity_type
    JOIN public.integration_templates t ON t.id = st.template_id AND t.organisation_id = st.organisation_id AND t.archived_at IS NULL
    JOIN public.integration_template_versions tv ON tv.template_id = t.id AND tv.organisation_id = t.organisation_id AND tv.version = t.current_version
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(tv.fields) = 'array' THEN tv.fields ELSE '[]'::jsonb END) e (f)
    JOIN LATERAL jsonb_each_text(app.integration_field_columns(p_entity)) m ON m.key = e.f ->> 'target'
   WHERE er.organisation_id = p_org AND er.entity_type = p_entity AND er.internal_id = p_record
     AND st.schedule <> 'manual'
     AND coalesce(tv.settings ->> 'writeMode', 'add_only') IN ('add_update', 'update_only')
     AND coalesce(e.f ->> 'ownership', '') NOT IN ('qms_wins', 'manual_review')
$$;
REVOKE ALL ON FUNCTION app.integration_locked_internal(uuid, text, uuid) FROM PUBLIC, anon, authenticated;

-- What a form asks: which fields of this record are managed by an import, and by which connection. Only members who may read that kind of record,
-- and only for records an import owns, so it reveals nothing about records it does not manage.
CREATE FUNCTION app.integration_locked_fields(p_org uuid, p_entity text, p_record uuid)
RETURNS TABLE (field text, connection_id uuid, connection_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_entity NOT IN ('supplier', 'customer', 'part', 'machine', 'employee', 'gauge_type', 'gauge', 'production_order') OR NOT app.is_member(p_org) THEN RETURN; END IF;
  IF NOT (CASE p_entity
            WHEN 'supplier' THEN app.has_permission_somewhere(p_org, 'master_data.read') OR app.has_permission_somewhere(p_org, 'supplier_quality.read')
            WHEN 'gauge' THEN app.has_permission_somewhere(p_org, 'calibration.read')
            WHEN 'gauge_type' THEN app.has_permission_somewhere(p_org, 'calibration.read')
            WHEN 'production_order' THEN app.has_permission_somewhere(p_org, 'production.read')
            ELSE app.has_permission_somewhere(p_org, 'master_data.read') END) THEN RETURN; END IF;
  RETURN QUERY SELECT l.field, l.connection_id, l.connection_name FROM app.integration_locked_internal(p_org, p_entity, p_record) l ORDER BY l.field;
END $$;
REVOKE ALL ON FUNCTION app.integration_locked_fields(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.integration_locked_fields(uuid, text, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- The guard: a person's update may not change a locked column. Unchanged values pass, so a form that sends every field still saves. It runs last
-- (the name sorts after the other BEFORE triggers), so a column another trigger fills in as a side effect is judged as it will be stored.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.integration_lock_guard() RETURNS trigger
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
   WHERE v_old -> l.col IS DISTINCT FROM v_new -> l.col;
  IF v_fields IS NOT NULL THEN
    RAISE EXCEPTION 'Managed by % while its schedule is on: % cannot be changed here', v_conn, array_to_string(v_fields, ', ')
      USING ERRCODE = 'QM033', DETAIL = jsonb_build_object('fields', to_jsonb(v_fields), 'connection', v_conn)::text;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.integration_lock_guard() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER zz_integration_lock_guard BEFORE UPDATE ON public.suppliers FOR EACH ROW EXECUTE FUNCTION app.integration_lock_guard('supplier');
CREATE TRIGGER zz_integration_lock_guard BEFORE UPDATE ON public.customers FOR EACH ROW EXECUTE FUNCTION app.integration_lock_guard('customer');
CREATE TRIGGER zz_integration_lock_guard BEFORE UPDATE ON public.parts FOR EACH ROW EXECUTE FUNCTION app.integration_lock_guard('part');
CREATE TRIGGER zz_integration_lock_guard BEFORE UPDATE ON public.machines FOR EACH ROW EXECUTE FUNCTION app.integration_lock_guard('machine');
CREATE TRIGGER zz_integration_lock_guard BEFORE UPDATE ON public."Employees" FOR EACH ROW EXECUTE FUNCTION app.integration_lock_guard('employee');
CREATE TRIGGER zz_integration_lock_guard BEFORE UPDATE ON public.gauge_types FOR EACH ROW EXECUTE FUNCTION app.integration_lock_guard('gauge_type');
CREATE TRIGGER zz_integration_lock_guard BEFORE UPDATE ON public.gauges FOR EACH ROW EXECUTE FUNCTION app.integration_lock_guard('gauge');
CREATE TRIGGER zz_integration_lock_guard BEFORE UPDATE ON public.production_orders FOR EACH ROW EXECUTE FUNCTION app.integration_lock_guard('production_order');
