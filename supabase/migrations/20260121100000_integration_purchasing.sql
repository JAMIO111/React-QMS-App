-- Integrations IN6 (docs/connectors-plan.md §6.13, decisions E1–E4): purchase orders and goods receipts from a source.
--
-- IN6a — purchase orders. One source row is one order line, identified by order number + line number (E4: the API builds the external id
-- "<order number>/<line number>"). `app.import_purchase_order` finds the order by its number (any case) or makes it from the line (supplier, ordered
-- date, notes), then makes or updates the line. The requested date is set when the line is made and never changed by a later import; the agreed date,
-- quantity, unit, part or material and status follow the source. An order's supplier, and a line's order and number, never change. The order follows its
-- lines: open while any line is open, else closed (cancelled when every line is cancelled). Write permission: receiving.manage.
--
-- IN6b — goods receipts from delivery rows (one source row = one delivery transaction; the key column is the transaction id). Historical mode: the real
-- dates, closed orders accepted, a lot number makes the lot already released, and no incoming inspection is ever required (decision D6, E3). Rows with
-- the same document number from the same supplier make one Fortress receipt (goods_receipts.source_connection_id / source_document). A return (a negative
-- quantity, or movement "return") becomes a rejected decision with that quantity on the latest earlier delivery it matches (E1), never a negative line.
-- A delivery or return already imported is never changed by a later import. A row the mapping marks "leave out" is staged as skipped.

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
    WHEN 'goods_receipt' THEN app.has_permission(p_org, 'receiving.manage')
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
    WHEN 'goods_receipt' THEN SELECT to_jsonb(x) INTO v FROM public.goods_receipt_lines x WHERE id = p_id;
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
    WHEN 'goods_receipt' THEN app.import_goods_receipt(p_org, p_internal, v_data, r.connection_id, i.external_id)
    ELSE app.integration_no_importer(r.entity_type) END;
  PERFORM app.import_custom_values(p_org, r.entity_type, v_id, v_data);
  RETURN v_id;
END $$;


-- ---------------------------------------------------------------------------
-- IN6b — goods receipts from delivery rows
-- ---------------------------------------------------------------------------
-- Where a receipt came from: the connection and the source's own document number (rows with the same number from the same supplier are one receipt).
ALTER TABLE public.goods_receipts
  ADD COLUMN source_connection_id uuid,
  ADD COLUMN source_document text CHECK (source_document IS NULL OR length(btrim(source_document)) BETWEEN 1 AND 100),
  ADD CONSTRAINT goods_receipts_source_connection_fkey FOREIGN KEY (source_connection_id, organisation_id) REFERENCES public.integration_connections (id, organisation_id),
  ADD CONSTRAINT goods_receipts_source_pair CHECK (source_document IS NULL OR source_connection_id IS NOT NULL);
CREATE UNIQUE INDEX goods_receipts_source_document_key ON public.goods_receipts (organisation_id, source_connection_id, supplier_id, upper(source_document))
  WHERE source_document IS NOT NULL;

-- The order line a delivery row names by order number and line number (null when it names none).
CREATE FUNCTION app.import_po_line(p_org uuid, d jsonb) RETURNS public.purchase_order_lines
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_l public.purchase_order_lines%ROWTYPE; v_po text := app.imp_text(d, 'poNumber'); v_line integer := app.imp_int(d, 'poLine');
BEGIN
  IF v_po IS NULL THEN
    IF v_line IS NOT NULL THEN RAISE EXCEPTION 'An order line number needs its order number' USING ERRCODE = 'QM022'; END IF;
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.purchase_orders WHERE organisation_id = p_org AND upper(po_number) = upper(v_po)) THEN
    RAISE EXCEPTION 'Order % is not in Fortress: import the purchase orders first', v_po USING ERRCODE = 'QM022';
  END IF;
  IF v_line IS NULL THEN
    -- An order with a single line needs no line number.
    IF (SELECT count(*) FROM public.purchase_order_lines l JOIN public.purchase_orders o ON o.id = l.purchase_order_id
         WHERE o.organisation_id = p_org AND upper(o.po_number) = upper(v_po)) <> 1 THEN
      RAISE EXCEPTION 'Order % has several lines: say which line was delivered', v_po USING ERRCODE = 'QM022';
    END IF;
    SELECT l.* INTO v_l FROM public.purchase_order_lines l JOIN public.purchase_orders o ON o.id = l.purchase_order_id
     WHERE o.organisation_id = p_org AND upper(o.po_number) = upper(v_po);
    RETURN v_l;
  END IF;
  SELECT l.* INTO v_l FROM public.purchase_order_lines l JOIN public.purchase_orders o ON o.id = l.purchase_order_id
   WHERE o.organisation_id = p_org AND upper(o.po_number) = upper(v_po) AND l.line_number = v_line;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order % has no line %', v_po, v_line USING ERRCODE = 'QM022'; END IF;
  RETURN v_l;
END $$;

CREATE FUNCTION app.import_goods_receipt(p_org uuid, p_id uuid, d jsonb, p_connection uuid DEFAULT NULL, p_external text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  pl public.purchase_order_lines%ROWTYPE; g public.goods_receipts%ROWTYPE; x public.goods_receipt_lines%ROWTYPE; lt public.lots%ROWTYPE;
  v_supplier uuid := app.imp_ref(d, 'supplier'); v_po_supplier uuid; v_qty numeric := app.imp_num(d, 'quantity'); v_on date := app.imp_date(d, 'receivedOn');
  v_move text := lower(app.imp_text(d, 'movement')); v_return boolean; v_part uuid := app.imp_ref(d, 'part'); v_material text := app.imp_text(d, 'material');
  v_lot_no text := app.imp_text(d, 'lotNumber'); v_doc text := app.imp_text(d, 'documentNumber'); v_site uuid := app.imp_ref(d, 'site');
  v_year integer; v_n integer; v_receipt uuid; v_line uuid; v_lot uuid; v_line_no integer; v_so_far numeric; v_latest public.receipt_line_dispositions%ROWTYPE; v_id uuid;
BEGIN
  IF p_id IS NOT NULL THEN
    RAISE EXCEPTION 'A delivery already imported is not changed by a later import: cancel the receipt in Fortress and import it again' USING ERRCODE = 'QM022';
  END IF;
  IF v_move IS NOT NULL AND v_move NOT IN ('receipt', 'return') THEN
    RAISE EXCEPTION 'Movement: "%" is not a receipt or a return', v_move USING ERRCODE = 'QM022';
  END IF;
  IF v_qty IS NULL OR v_qty = 0 THEN RAISE EXCEPTION 'Quantity: give the quantity delivered (or returned, below zero)' USING ERRCODE = 'QM022'; END IF;
  v_return := v_move = 'return' OR v_qty < 0;
  v_qty := abs(v_qty);
  IF v_on IS NULL OR v_on > current_date THEN RAISE EXCEPTION 'Received on: give the date (not in the future)' USING ERRCODE = 'QM022'; END IF;

  pl := app.import_po_line(p_org, d);
  IF pl.id IS NOT NULL THEN
    SELECT supplier_id INTO v_po_supplier FROM public.purchase_orders WHERE id = pl.purchase_order_id;
    IF v_supplier IS NOT NULL AND v_supplier <> v_po_supplier THEN
      RAISE EXCEPTION 'Order % is for another supplier', app.imp_text(d, 'poNumber') USING ERRCODE = 'QM021';
    END IF;
    v_supplier := v_po_supplier;
    IF v_part IS NOT NULL AND pl.part_id IS DISTINCT FROM v_part THEN
      RAISE EXCEPTION 'That is not the part on order % line %', app.imp_text(d, 'poNumber'), pl.line_number USING ERRCODE = 'QM021';
    END IF;
    v_part := coalesce(v_part, pl.part_id);
    v_material := coalesce(v_material, pl.material);
  END IF;
  IF v_supplier IS NULL THEN RAISE EXCEPTION 'Supplier: name the supplier or the purchase order' USING ERRCODE = 'QM022'; END IF;
  IF v_part IS NULL AND v_material IS NULL THEN RAISE EXCEPTION 'Name the part or the material (or the order line)' USING ERRCODE = 'QM022'; END IF;
  IF v_lot_no IS NOT NULL AND v_part IS NULL THEN RAISE EXCEPTION 'Lot number: a lot is of a part, so name the part' USING ERRCODE = 'QM022'; END IF;

  -- ---- a return: a rejection of that quantity on the latest earlier delivery it matches (E1) ----
  IF v_return THEN
    SELECT gl.* INTO x
      FROM public.goods_receipt_lines gl JOIN public.goods_receipts gr ON gr.id = gl.goods_receipt_id
      LEFT JOIN public.lots lo ON lo.id = gl.lot_id
      LEFT JOIN LATERAL (SELECT r.decision, r.quantity_rejected FROM public.receipt_line_dispositions r WHERE r.receipt_line_id = gl.id ORDER BY r.decided_at DESC, r.id DESC LIMIT 1) last ON true
     WHERE gr.organisation_id = p_org AND gr.status = 'received' AND gr.supplier_id = v_supplier AND gr.received_on <= v_on
       AND (pl.id IS NULL OR gl.po_line_id = pl.id)
       AND (v_part IS NULL OR gl.part_id = v_part) AND (v_part IS NOT NULL OR upper(gl.material) = upper(v_material))
       AND (v_lot_no IS NULL OR upper(lo.lot_number) = upper(v_lot_no))
       AND gl.quantity_received - CASE WHEN last.decision = 'rejected' THEN coalesce(last.quantity_rejected, gl.quantity_received) ELSE 0 END >= v_qty
     ORDER BY gr.received_on DESC, gl.created_at DESC
     LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Return of %: no earlier delivery from this supplier has that much left to return; import the deliveries first', v_qty USING ERRCODE = 'QM022';
    END IF;
    SELECT * INTO v_latest FROM public.receipt_line_dispositions WHERE receipt_line_id = x.id ORDER BY decided_at DESC, id DESC LIMIT 1;
    v_so_far := CASE WHEN v_latest.decision = 'rejected' THEN coalesce(v_latest.quantity_rejected, x.quantity_received) ELSE 0 END;
    -- Decided now, so it is the line's latest decision (the return date is in the reason).
    INSERT INTO public.receipt_line_dispositions (organisation_id, receipt_line_id, decision, reason, quantity_rejected)
    VALUES (p_org, x.id, 'rejected',
            left('Returned to the supplier on ' || to_char(v_on, 'YYYY-MM-DD') || coalesce(' (' || coalesce(v_doc, app.imp_text(d, 'deliveryNote')) || ')', '') || ', imported', 1000),
            v_so_far + v_qty)
    RETURNING id INTO v_id;
    RETURN v_id;
  END IF;

  -- ---- a delivery ----
  IF v_site IS NULL AND (SELECT count(*) FROM public.sites WHERE organisation_id = p_org AND active) = 1 THEN
    SELECT id INTO v_site FROM public.sites WHERE organisation_id = p_org AND active;
  END IF;
  IF v_doc IS NOT NULL THEN
    SELECT * INTO g FROM public.goods_receipts
     WHERE organisation_id = p_org AND source_connection_id = p_connection AND supplier_id = v_supplier AND upper(source_document) = upper(v_doc) FOR UPDATE;
  END IF;
  IF g.id IS NULL THEN
    v_year := extract(year FROM v_on)::int;
    INSERT INTO app.goods_receipt_counters AS k (organisation_id, year, last_value) VALUES (p_org, v_year, 1)
    ON CONFLICT (organisation_id, year) DO UPDATE SET last_value = k.last_value + 1 RETURNING last_value INTO v_n;
    INSERT INTO public.goods_receipts (organisation_id, reference, supplier_id, purchase_order_id, site_id, received_on, delivery_note, source_connection_id, source_document)
    VALUES (p_org, 'GR-' || to_char(make_date(v_year, 1, 1), 'YY') || '-' || lpad(v_n::text, 4, '0'), v_supplier, pl.purchase_order_id, v_site, v_on,
            app.imp_text(d, 'deliveryNote'), p_connection, v_doc)
    RETURNING * INTO g;
  ELSE
    IF g.status <> 'received' THEN RAISE EXCEPTION 'Receipt % (document %) was cancelled in Fortress', g.reference, v_doc USING ERRCODE = 'QM021'; END IF;
    IF g.received_on <> v_on THEN
      RAISE EXCEPTION 'Document % was received on %; this row says %', v_doc, to_char(g.received_on, 'YYYY-MM-DD'), to_char(v_on, 'YYYY-MM-DD') USING ERRCODE = 'QM022';
    END IF;
    -- A receipt names an order only while all its lines are from that order.
    IF g.purchase_order_id IS DISTINCT FROM pl.purchase_order_id AND g.purchase_order_id IS NOT NULL THEN
      UPDATE public.goods_receipts SET purchase_order_id = NULL WHERE id = g.id;
    END IF;
  END IF;

  IF v_lot_no IS NOT NULL THEN
    IF v_lot_no !~ '^\S(.{0,58}\S)?$' THEN RAISE EXCEPTION 'Lot number: up to 60 characters' USING ERRCODE = 'QM022'; END IF;
    SELECT * INTO lt FROM public.lots WHERE organisation_id = p_org AND part_id = v_part AND upper(lot_number) = upper(v_lot_no);
    IF FOUND THEN
      -- A lot delivered in several transactions is the same lot, if it came from this supplier.
      IF lt.origin <> 'received' OR lt.supplier_id IS DISTINCT FROM v_supplier THEN
        RAISE EXCEPTION 'Lot % of that part already exists and did not come from this supplier', v_lot_no USING ERRCODE = 'QM021';
      END IF;
      v_lot := lt.id;
    ELSE
      INSERT INTO public.lots (organisation_id, lot_number, part_id, origin, supplier_id, site_id, quantity, received_on)
      VALUES (p_org, v_lot_no, v_part, 'received', v_supplier, v_site, v_qty, v_on) RETURNING id INTO v_lot;
      -- E3: an old delivery's lot is released, never held.
      UPDATE public.lots SET status = 'released' WHERE id = v_lot;
    END IF;
  END IF;

  SELECT coalesce(max(line_number), 0) + 1 INTO v_line_no FROM public.goods_receipt_lines WHERE goods_receipt_id = g.id;
  INSERT INTO public.goods_receipt_lines (organisation_id, goods_receipt_id, line_number, po_line_id, part_id, material, quantity_received, lot_id, notes)
  VALUES (p_org, g.id, v_line_no, pl.id, v_part, v_material, v_qty, v_lot, app.imp_text(d, 'notes'))
  RETURNING id INTO v_line;
  -- Historical mode: inspection on arrival is not recorded in Fortress, so none is required (D6).
  INSERT INTO public.incoming_inspection_determinations (organisation_id, receipt_line_id, strategy, level, required, basis)
  VALUES (p_org, v_line, 'none', 'normal', false, 'Imported delivery: inspection on arrival is not recorded in Fortress');
  RETURN v_line;
END $$;

-- ---------------------------------------------------------------------------
-- Staging: a row the mapping marks "leave out" (`skip`: the reason) is kept as skipped, before any problem with it
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
    SELECT t.ord, t.e, nullif(btrim(t.e ->> 'externalId'), '') AS ext, left(nullif(btrim(t.e ->> 'skip'), ''), 500) AS skip,
           encode(sha256(convert_to(coalesce(t.e -> 'canonical', t.e -> 'payload')::text, 'UTF8')), 'hex') AS hash
      FROM jsonb_array_elements(p_records) WITH ORDINALITY AS t(e, ord)
  ), ranked AS (
    SELECT s1.*, row_number() OVER (PARTITION BY s1.ext ORDER BY s1.ord) AS dup,
           EXISTS (SELECT 1 FROM public.integration_inbox i WHERE i.run_id = r.id AND i.external_id = s1.ext AND i.status <> 'rejected') AS seen,
           x.internal_id AS mapped, x.content_hash AS mapped_hash,
           CASE WHEN v_match AND s1.skip IS NULL AND x.internal_id IS NULL AND jsonb_typeof(s1.e -> 'canonical') = 'object'
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
    SELECT r.organisation_id, r.connection_id, r.id, r.entity_type, coalesce(left(d.ext, 200), CASE WHEN d.skip IS NOT NULL THEN 'row-' || coalesce(d.e ->> 'sourceRow', d.ord::text) END),
           CASE WHEN (d.e ->> 'sourceRow') ~ '^[0-9]{1,9}$' THEN (d.e ->> 'sourceRow')::integer END,
           CASE WHEN jsonb_typeof(d.e -> 'payload') = 'object' THEN d.e -> 'payload' END,
           CASE WHEN jsonb_typeof(d.e -> 'canonical') = 'object' THEN d.e -> 'canonical' END,
           d.hash,
           CASE WHEN d.skip IS NOT NULL THEN 'skipped'
                WHEN d.problem IS NOT NULL OR d.dup > 1 OR d.seen OR d.taken THEN 'rejected'
                WHEN d.mapped_hash = d.hash THEN 'unchanged'
                WHEN v_mode = 'add_only' AND d.target IS NOT NULL THEN 'skipped'
                WHEN v_mode = 'update_only' AND d.target IS NULL THEN 'skipped'
                WHEN r.kind = 'preview' THEN 'previewed'
                ELSE 'staged' END,
           CASE WHEN d.skip IS NOT NULL OR d.problem IS NOT NULL OR d.dup > 1 OR d.seen OR d.taken OR d.mapped_hash = d.hash
                  OR (v_mode = 'add_only' AND d.target IS NOT NULL) OR (v_mode = 'update_only' AND d.target IS NULL) THEN NULL
                WHEN d.target IS NULL THEN 'create' ELSE 'update' END,
           CASE WHEN d.skip IS NOT NULL THEN NULL ELSE d.target END,
           CASE WHEN d.skip IS NOT NULL THEN jsonb_build_array(jsonb_build_object('field', NULL, 'message', d.skip))
                WHEN d.problem IS NOT NULL THEN d.problem
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

-- Goods receipts, like non-conformances, are only ever added (a delivery is never changed by a later import) and never matched.
CREATE OR REPLACE FUNCTION app.integration_settings_for(p_connection uuid, p_entity text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'writeMode', CASE WHEN p_entity IN ('nonconformance', 'goods_receipt') THEN 'add_only' ELSE coalesce(s.write_mode, 'add_only') END,
    'matchExisting', CASE WHEN p_entity IN ('nonconformance', 'goods_receipt') THEN false ELSE coalesce(s.match_existing, false) END,
    'onMissing', coalesce(s.on_missing, 'nothing'),
    'schedule', coalesce(s.schedule, 'manual'))
    FROM (SELECT 1) one
    LEFT JOIN public.integration_import_settings s ON s.connection_id = p_connection AND s.entity_type = p_entity
$$;

CREATE OR REPLACE FUNCTION app.integration_template_settings(p_entity text, p_settings jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'writeMode', CASE WHEN p_entity IN ('nonconformance', 'goods_receipt') THEN 'add_only' ELSE coalesce(p_settings ->> 'writeMode', 'add_only') END,
    'matchExisting', CASE WHEN p_entity IN ('nonconformance', 'goods_receipt') THEN false ELSE coalesce((p_settings ->> 'matchExisting')::boolean, false) END)
$$;

REVOKE ALL ON FUNCTION app.po_follow_lines(uuid), app.import_purchase_order(uuid, uuid, jsonb), app.import_po_line(uuid, jsonb),
  app.import_goods_receipt(uuid, uuid, jsonb, uuid, text) FROM PUBLIC, anon, authenticated;
