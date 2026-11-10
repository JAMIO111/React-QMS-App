-- Integrations IN6 (docs/connectors-plan.md §6.13, decisions E1–E4): purchase orders and goods receipts from a source.
--
-- IN6a — purchase orders. One source row is one order line, identified by order number + line number (E4: the API builds the external id
-- "<order number>/<line number>"). `app.import_purchase_order` finds the order by its number (any case) or makes it from the line (supplier, ordered
-- date, notes), then makes or updates the line. The requested date is set when the line is made and never changed by a later import; the agreed date,
-- quantity, unit, part or material and status follow the source. An order's supplier, and a line's order and number, never change. The order follows its
-- lines: open while any line is open, else closed (cancelled when every line is cancelled). Write permission: receiving.manage.

-- ---------------------------------------------------------------------------
-- Purchase orders
-- ---------------------------------------------------------------------------
-- The order's status from its lines (open while any is open; cancelled when all are; else closed).
CREATE FUNCTION app.po_follow_lines(p_po uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o public.purchase_orders%ROWTYPE; v_open boolean; v_all_cancelled boolean; v_status text;
BEGIN
  SELECT * INTO o FROM public.purchase_orders WHERE id = p_po FOR UPDATE;
  SELECT bool_or(status = 'open'), bool_and(status = 'cancelled') INTO v_open, v_all_cancelled FROM public.purchase_order_lines WHERE purchase_order_id = p_po;
  v_status := CASE WHEN v_open THEN 'open' WHEN v_all_cancelled THEN 'cancelled' ELSE 'closed' END;
  IF v_status = o.status THEN RETURN; END IF;
  UPDATE public.purchase_orders
     SET status = v_status,
         closed_at = CASE WHEN v_status = 'closed' THEN now() END,
         closed_by = CASE WHEN v_status = 'closed' THEN auth.uid() END,
         cancel_reason = CASE WHEN v_status = 'cancelled' THEN 'Every line was cancelled in the source system' END,
         updated_by = auth.uid()
   WHERE id = p_po;
END $$;

CREATE FUNCTION app.import_purchase_order(p_org uuid, p_id uuid, d jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  o public.purchase_orders%ROWTYPE; l public.purchase_order_lines%ROWTYPE; v_po uuid; v_line uuid; v_number text := app.imp_text(d, 'poNumber');
  v_line_no integer := app.imp_int(d, 'lineNumber'); v_status text := lower(app.imp_text(d, 'lineStatus')); v_supplier uuid := app.imp_ref(d, 'supplier');
  v_part uuid; v_material text;
BEGIN
  IF v_status IS NOT NULL AND v_status NOT IN ('open', 'closed', 'cancelled') THEN
    RAISE EXCEPTION 'Line status: "%" is not one of open, closed or cancelled', v_status USING ERRCODE = 'QM022';
  END IF;

  IF p_id IS NULL THEN
    IF v_number IS NULL OR v_line_no IS NULL THEN RAISE EXCEPTION 'An order line needs its order number and line number' USING ERRCODE = 'QM022'; END IF;
    SELECT * INTO o FROM public.purchase_orders WHERE organisation_id = p_org AND upper(po_number) = upper(v_number) FOR UPDATE;
    IF NOT FOUND THEN
      IF v_supplier IS NULL THEN RAISE EXCEPTION 'A new order needs its supplier' USING ERRCODE = 'QM022'; END IF;
      INSERT INTO public.purchase_orders (organisation_id, po_number, supplier_id, ordered_on, notes)
      VALUES (p_org, v_number, v_supplier, coalesce(app.imp_date(d, 'orderedOn'), app.imp_date(d, 'requestedOn'), current_date), app.imp_text(d, 'orderNotes'))
      RETURNING id INTO v_po;
    ELSE
      IF v_supplier IS NOT NULL AND v_supplier <> o.supplier_id THEN
        RAISE EXCEPTION 'Order % is for another supplier', o.po_number USING ERRCODE = 'QM021';
      END IF;
      v_po := o.id;
    END IF;
    IF EXISTS (SELECT 1 FROM public.purchase_order_lines WHERE purchase_order_id = v_po AND line_number = v_line_no) THEN
      RAISE EXCEPTION 'Order % already has a line %; to link it, import with matching existing records', v_number, v_line_no USING ERRCODE = 'QM021';
    END IF;
    INSERT INTO public.purchase_order_lines (organisation_id, purchase_order_id, line_number, part_id, material, quantity_ordered, unit, requested_on, agreed_on, status)
    VALUES (p_org, v_po, v_line_no, app.imp_ref(d, 'part'), app.imp_text(d, 'material'), app.imp_num(d, 'quantityOrdered'), app.imp_text(d, 'unit'),
            app.imp_date(d, 'requestedOn'), app.imp_date(d, 'agreedOn'), coalesce(v_status, 'open'))
    RETURNING id INTO v_line;
    PERFORM app.po_follow_lines(v_po);
    RETURN v_line;
  END IF;

  SELECT * INTO l FROM public.purchase_order_lines WHERE id = p_id AND organisation_id = p_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'The order line this record was linked to no longer exists' USING ERRCODE = 'QM022'; END IF;
  SELECT * INTO o FROM public.purchase_orders WHERE id = l.purchase_order_id FOR UPDATE;
  IF d ? 'poNumber' AND v_number IS NOT NULL AND upper(v_number) <> upper(o.po_number) THEN
    RAISE EXCEPTION 'An order line cannot move to another order (% to %)', o.po_number, v_number USING ERRCODE = 'QM021';
  END IF;
  IF d ? 'lineNumber' AND v_line_no IS NOT NULL AND v_line_no <> l.line_number THEN
    RAISE EXCEPTION 'An order line keeps its number (% to %)', l.line_number, v_line_no USING ERRCODE = 'QM021';
  END IF;
  IF d ? 'supplier' AND v_supplier IS NOT NULL AND v_supplier <> o.supplier_id THEN
    RAISE EXCEPTION 'The supplier of order % cannot change', o.po_number USING ERRCODE = 'QM021';
  END IF;
  v_part := CASE WHEN d ? 'part' THEN app.imp_ref(d, 'part') ELSE l.part_id END;
  v_material := CASE WHEN d ? 'material' THEN app.imp_text(d, 'material') ELSE l.material END;
  IF v_part IS DISTINCT FROM l.part_id AND EXISTS (SELECT 1 FROM public.goods_receipt_lines WHERE po_line_id = l.id) THEN
    RAISE EXCEPTION 'Order % line %: goods have been received against it, so its part cannot change', o.po_number, l.line_number USING ERRCODE = 'QM021';
  END IF;
  UPDATE public.purchase_orders SET
    ordered_on = CASE WHEN d ? 'orderedOn' THEN coalesce(app.imp_date(d, 'orderedOn'), ordered_on) ELSE ordered_on END,
    notes = CASE WHEN d ? 'orderNotes' THEN app.imp_text(d, 'orderNotes') ELSE notes END,
    updated_by = auth.uid()
  WHERE id = o.id AND (
    (d ? 'orderedOn' AND app.imp_date(d, 'orderedOn') IS NOT NULL AND app.imp_date(d, 'orderedOn') <> ordered_on)
    OR (d ? 'orderNotes' AND app.imp_text(d, 'orderNotes') IS DISTINCT FROM notes));
  -- The requested date is the original one: never changed by an import.
  UPDATE public.purchase_order_lines SET
    part_id = v_part,
    material = v_material,
    quantity_ordered = CASE WHEN d ? 'quantityOrdered' THEN coalesce(app.imp_num(d, 'quantityOrdered'), quantity_ordered) ELSE quantity_ordered END,
    unit = CASE WHEN d ? 'unit' THEN app.imp_text(d, 'unit') ELSE unit END,
    agreed_on = CASE WHEN d ? 'agreedOn' THEN app.imp_date(d, 'agreedOn') ELSE agreed_on END,
    status = CASE WHEN d ? 'lineStatus' AND v_status IS NOT NULL THEN v_status ELSE status END,
    updated_by = auth.uid()
  WHERE id = l.id;
  PERFORM app.po_follow_lines(o.id);
  RETURN l.id;
END $$;

-- ---------------------------------------------------------------------------
-- The importable kinds learn purchase orders
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.integration_may_write(p_org uuid, p_entity text) RETURNS boolean
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
    WHEN 'production_order' THEN app.has_permission(p_org, 'production.manage')
    WHEN 'purchase_order' THEN app.has_permission(p_org, 'receiving.manage')
    ELSE false END
$$;

CREATE OR REPLACE FUNCTION app.integration_find_by_code(p_org uuid, p_kind text, p_code text) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid; v_code text := nullif(btrim(p_code), ''); v_po text; v_line text;
BEGIN
  IF v_code IS NULL THEN RETURN NULL; END IF;
  CASE p_kind
    WHEN 'supplier' THEN SELECT id INTO v_id FROM public.suppliers WHERE organisation_id = p_org AND upper(code) = upper(v_code);
    WHEN 'customer' THEN SELECT id INTO v_id FROM public.customers WHERE organisation_id = p_org AND upper(code) = upper(v_code);
    WHEN 'part' THEN SELECT id INTO v_id FROM public.parts WHERE organisation_id = p_org AND upper(part_number) = upper(v_code);
    WHEN 'machine' THEN SELECT id INTO v_id FROM public.machines WHERE organisation_id = p_org AND upper(code) = upper(v_code);
    WHEN 'employee' THEN SELECT id INTO v_id FROM public."Employees" WHERE organisation_id = p_org AND upper(employee_number) = upper(v_code);
    WHEN 'gauge_type' THEN
      SELECT id INTO v_id FROM public.gauge_types WHERE organisation_id = p_org AND upper(code) = upper(v_code);
      -- Files written before gauge types had codes named them by name.
      IF v_id IS NULL THEN SELECT id INTO v_id FROM public.gauge_types WHERE organisation_id = p_org AND upper(name) = upper(v_code); END IF;
    WHEN 'gauge' THEN SELECT id INTO v_id FROM public.gauges WHERE organisation_id = p_org AND upper(asset_number) = upper(v_code) AND deleted_at IS NULL;
    WHEN 'production_order' THEN SELECT id INTO v_id FROM public.production_orders WHERE organisation_id = p_org AND upper(order_number) = upper(v_code);
    WHEN 'purchase_order' THEN
      -- "<order number>/<line number>": the line (E4).
      v_po := substring(v_code FROM '^(.*)/[0-9]+$'); v_line := substring(v_code FROM '/([0-9]+)$');
      IF v_po IS NOT NULL THEN
        SELECT l.id INTO v_id FROM public.purchase_order_lines l JOIN public.purchase_orders o ON o.id = l.purchase_order_id
         WHERE o.organisation_id = p_org AND upper(o.po_number) = upper(btrim(v_po)) AND l.line_number = v_line::integer;
      END IF;
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

CREATE OR REPLACE FUNCTION app.integration_record_code(p_entity text, p_data jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT nullif(btrim(CASE p_entity
    WHEN 'supplier' THEN p_data ->> 'code' WHEN 'customer' THEN p_data ->> 'code' WHEN 'machine' THEN p_data ->> 'code'
    WHEN 'part' THEN p_data ->> 'partNumber' WHEN 'employee' THEN p_data ->> 'employeeNumber'
    WHEN 'gauge_type' THEN coalesce(p_data ->> 'code', p_data ->> 'name') WHEN 'gauge' THEN p_data ->> 'assetNumber'
    WHEN 'production_order' THEN p_data ->> 'orderNumber'
    WHEN 'purchase_order' THEN (p_data ->> 'poNumber') || '/' || (p_data ->> 'lineNumber') END), '')
$$;

CREATE OR REPLACE FUNCTION app.integration_record_row(p_entity text, p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v jsonb;
BEGIN
  CASE p_entity
    WHEN 'supplier' THEN SELECT to_jsonb(x) INTO v FROM public.suppliers x WHERE id = p_id;
    WHEN 'customer' THEN SELECT to_jsonb(x) INTO v FROM public.customers x WHERE id = p_id;
    WHEN 'part' THEN SELECT to_jsonb(x) INTO v FROM public.parts x WHERE id = p_id;
    WHEN 'machine' THEN SELECT to_jsonb(x) INTO v FROM public.machines x WHERE id = p_id;
    WHEN 'employee' THEN SELECT to_jsonb(x) INTO v FROM public."Employees" x WHERE id = p_id;
    WHEN 'gauge_type' THEN SELECT to_jsonb(x) INTO v FROM public.gauge_types x WHERE id = p_id;
    WHEN 'gauge' THEN SELECT to_jsonb(x) INTO v FROM public.gauges x WHERE id = p_id;
    WHEN 'nonconformance' THEN SELECT to_jsonb(x) INTO v FROM public.nonconformances x WHERE id = p_id;
    WHEN 'production_order' THEN SELECT to_jsonb(x) INTO v FROM public.production_orders x WHERE id = p_id;
    -- An order line with its order's own columns beside it (prefixed), so a change to either shows.
    WHEN 'purchase_order' THEN
      SELECT to_jsonb(x) || jsonb_build_object('order_ordered_on', o.ordered_on, 'order_notes', o.notes, 'order_status', o.status) INTO v
        FROM public.purchase_order_lines x JOIN public.purchase_orders o ON o.id = x.purchase_order_id WHERE x.id = p_id;
    ELSE v := NULL;
  END CASE;
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION app.integration_apply_fields(p_org uuid, p_entity text, p_id uuid, d jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RETURN CASE p_entity
    WHEN 'supplier' THEN app.import_supplier(p_org, p_id, d)
    WHEN 'customer' THEN app.import_customer(p_org, p_id, d)
    WHEN 'part' THEN app.import_part(p_org, p_id, d)
    WHEN 'machine' THEN app.import_machine(p_org, p_id, d)
    WHEN 'employee' THEN app.import_employee(p_org, p_id, d)
    WHEN 'gauge_type' THEN app.import_gauge_type(p_org, p_id, d)
    WHEN 'gauge' THEN app.import_gauge(p_org, p_id, d)
    WHEN 'production_order' THEN app.import_production_order(p_org, p_id, d)
    WHEN 'purchase_order' THEN app.import_purchase_order(p_org, p_id, d)
    ELSE app.integration_no_importer(p_entity) END;
END $$;

CREATE OR REPLACE FUNCTION app.system_import_record(p_org uuid, p_run uuid, p_owner uuid, p_row uuid, p_internal uuid, p_data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  r public.integration_sync_runs%ROWTYPE; i public.integration_inbox%ROWTYPE; s jsonb; v_mode text; v_id uuid; v_data jsonb := p_data;
  v_own jsonb; v_field text; v_rule text; v_system text;
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

  -- Field ownership on an update: Fortress-owned fields are left alone; fields under review are compared and, where they differ, parked.
  IF p_internal IS NOT NULL THEN
    v_own := app.integration_ownership(app.integration_run_fields(r, i));
    FOR v_field, v_rule IN SELECT key, value #>> '{}' FROM jsonb_each(v_own) LOOP
      IF v_rule = 'manual_review' AND v_field NOT LIKE 'cf\_%' THEN
        PERFORM app.integration_park_value(r, i, p_internal, v_field, p_data);
      END IF;
      v_data := v_data - app.integration_field_keys(v_field);
    END LOOP;
  END IF;

  IF r.entity_type = 'production_order' THEN
    SELECT external_system INTO v_system FROM public.integration_connections WHERE id = r.connection_id AND organisation_id = p_org;
  END IF;
  v_id := CASE r.entity_type
    WHEN 'supplier' THEN app.import_supplier(p_org, p_internal, v_data)
    WHEN 'customer' THEN app.import_customer(p_org, p_internal, v_data)
    WHEN 'part' THEN app.import_part(p_org, p_internal, v_data)
    WHEN 'machine' THEN app.import_machine(p_org, p_internal, v_data)
    WHEN 'employee' THEN app.import_employee(p_org, p_internal, v_data)
    WHEN 'gauge_type' THEN app.import_gauge_type(p_org, p_internal, v_data)
    WHEN 'gauge' THEN app.import_gauge(p_org, p_internal, v_data)
    WHEN 'nonconformance' THEN app.import_nonconformance(p_org, p_internal, v_data)
    WHEN 'production_order' THEN app.import_production_order(p_org, p_internal, v_data, v_system, i.external_id)
    WHEN 'purchase_order' THEN app.import_purchase_order(p_org, p_internal, v_data)
    ELSE app.integration_no_importer(r.entity_type) END;
  PERFORM app.import_custom_values(p_org, r.entity_type, v_id, v_data);
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION app.po_follow_lines(uuid), app.import_purchase_order(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
