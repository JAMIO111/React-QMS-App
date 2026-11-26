-- Integrations SH4 (docs/order-fulfilment-plan.md §6): customer orders and shipments from a source, the customer-side mirror of purchase orders and goods receipts.
--
-- customer_order — one source row is one order line (the key column is the order number, the external id is "<order>/<line>"). Added and updated: the
--   customer's requested date is the original and never changes, the confirmed date, quantity, unit, part and status follow the source.
-- shipment — one source row is one movement out (the key column is the source's transaction id). Always added, never matched, never changed afterwards. Rows with
--   the same document number for the same customer are one shipment. A row says what it names by order number and line number (or just the part and customer).
--   Returns are not shipments (a customer's return is an RMA disposition on the non-conformance, OF-D5): a row that says return, or has a negative quantity,
--   is refused and belongs in "Leave this row out" or the record filter (a source's one inventory table is split by its type and category columns).
--   A shipment never makes a lot: a lot number must name a lot of that part already in Fortress.
-- Shared functions are patched from their live definitions (marker-guarded, so running this again is safe).
SET check_function_bodies = off;

CREATE OR REPLACE FUNCTION pg_temp.patch_once(p_fn regprocedure, p_marker text, p_old text, p_new text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_def text := replace(pg_get_functiondef(p_fn), E'\r', ''); v_n integer;
BEGIN
  p_old := replace(p_old, E'\r', '');
  p_new := replace(p_new, E'\r', '');
  IF position(p_marker IN v_def) > 0 THEN RETURN; END IF;
  v_n := (length(v_def) - length(replace(v_def, p_old, ''))) / length(p_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'Expected to find % exactly once in %, found % times', p_old, p_fn, v_n; END IF;
  EXECUTE replace(v_def, p_old, p_new);
END $$;

-- ---------------------------------------------------------------------------
-- 1. The new kinds of record
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.integration_entity_types() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT ARRAY['supplier', 'customer', 'part', 'machine', 'employee', 'gauge_type', 'gauge', 'calibration', 'nonconformance', 'ncr_cost',
               'production_order', 'purchase_order', 'goods_receipt', 'po_receipt_total', 'customer_order', 'shipment']
$$;

CREATE OR REPLACE FUNCTION app.integration_assert_entity(p_entity text) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
BEGIN
  IF p_entity IS NULL OR NOT (p_entity = ANY (app.integration_entity_types())) THEN
    RAISE EXCEPTION 'Choose what to import: suppliers, customers, parts, machines, employees, gauge types, gauges, non-conformances, production orders, purchase orders, goods receipts, received quantities, customer orders or shipments'
      USING ERRCODE = 'QM022';
  END IF;
END $$;

-- Writing them needs the shipping right (the importer checks it again).
SELECT pg_temp.patch_once('app.integration_may_write(uuid, text)'::regprocedure, 'customer_order',
  $o$    WHEN 'po_receipt_total' THEN app.has_permission(p_org, 'receiving.manage')$o$,
  $n$    WHEN 'po_receipt_total' THEN app.has_permission(p_org, 'receiving.manage')
    WHEN 'customer_order' THEN app.has_permission(p_org, 'shipping.manage')
    WHEN 'shipment' THEN app.has_permission(p_org, 'shipping.manage')$n$);

-- An order line is found by "<order number>/<line number>", like a purchase order line.
SELECT pg_temp.patch_once('app.integration_record_code(text, jsonb)'::regprocedure, 'customer_order',
  $o$    WHEN 'purchase_order' THEN (p_data ->> 'poNumber') || '/' || (p_data ->> 'lineNumber') END), '')$o$,
  $n$    WHEN 'purchase_order' THEN (p_data ->> 'poNumber') || '/' || (p_data ->> 'lineNumber')
    WHEN 'customer_order' THEN (p_data ->> 'orderNumber') || '/' || (p_data ->> 'lineNumber') END), '')$n$);

SELECT pg_temp.patch_once('app.integration_find_by_code(uuid, text, text)'::regprocedure, 'customer_order_lines',
  $o$    WHEN 'nonconformance' THEN SELECT id INTO v_id FROM public.nonconformances WHERE organisation_id = p_org AND upper(reference) = upper(v_code) AND deleted_at IS NULL;$o$,
  $n$    WHEN 'customer_order' THEN
      v_po := substring(v_code FROM '^(.*)/[0-9]+$'); v_line := substring(v_code FROM '/([0-9]+)$');
      IF v_po IS NOT NULL THEN
        SELECT l.id INTO v_id FROM public.customer_order_lines l JOIN public.customer_orders o ON o.id = l.customer_order_id
         WHERE o.organisation_id = p_org AND upper(o.order_number) = upper(btrim(v_po)) AND l.line_number = v_line::integer;
      END IF;
    WHEN 'nonconformance' THEN SELECT id INTO v_id FROM public.nonconformances WHERE organisation_id = p_org AND upper(reference) = upper(v_code) AND deleted_at IS NULL;$n$);

-- The record as it stands, so a field under review can be compared (an order line with its order's own columns beside it).
SELECT pg_temp.patch_once('app.integration_record_row(text, uuid)'::regprocedure, 'customer_order_lines',
  $o$    WHEN 'goods_receipt' THEN SELECT to_jsonb(x) INTO v FROM public.goods_receipt_lines x WHERE id = p_id;$o$,
  $n$    WHEN 'goods_receipt' THEN SELECT to_jsonb(x) INTO v FROM public.goods_receipt_lines x WHERE id = p_id;
    WHEN 'customer_order' THEN
      SELECT to_jsonb(x) || jsonb_build_object('order_ordered_on', o.ordered_on, 'order_notes', o.notes, 'order_status', o.status, 'order_customer_reference', o.customer_reference) INTO v
        FROM public.customer_order_lines x JOIN public.customer_orders o ON o.id = x.customer_order_id WHERE x.id = p_id;
    WHEN 'shipment' THEN SELECT to_jsonb(x) INTO v FROM public.shipment_lines x WHERE id = p_id;$n$);

SELECT pg_temp.patch_once('app.integration_apply_fields(uuid, text, uuid, jsonb)'::regprocedure, 'import_customer_order',
  $o$    WHEN 'purchase_order' THEN app.import_purchase_order(p_org, p_id, d)$o$,
  $n$    WHEN 'purchase_order' THEN app.import_purchase_order(p_org, p_id, d)
    WHEN 'customer_order' THEN app.import_customer_order(p_org, p_id, d)$n$);

-- A shipment is added and never changed or matched; an order line follows the source (the connection's own write mode, like purchase orders).
CREATE OR REPLACE FUNCTION app.integration_settings_for(p_connection uuid, p_entity text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'writeMode', CASE WHEN p_entity IN ('nonconformance', 'goods_receipt', 'calibration', 'ncr_cost', 'shipment') THEN 'add_only' WHEN p_entity = 'po_receipt_total' THEN 'add_update' ELSE coalesce(s.write_mode, 'add_only') END,
    'matchExisting', CASE WHEN p_entity IN ('nonconformance', 'goods_receipt', 'po_receipt_total', 'calibration', 'ncr_cost', 'shipment') THEN false ELSE coalesce(s.match_existing, false) END,
    'onMissing', coalesce(s.on_missing, 'nothing'),
    'schedule', coalesce(s.schedule, 'manual'))
    FROM (SELECT 1) one
    LEFT JOIN public.integration_import_settings s ON s.connection_id = p_connection AND s.entity_type = p_entity
$$;

-- Movements are never "missing from the source": a shipment already out stays out.
CREATE OR REPLACE FUNCTION app.integration_entity_tracks_missing(p_entity text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$ SELECT p_entity NOT IN ('nonconformance', 'goods_receipt', 'po_receipt_total', 'calibration', 'ncr_cost', 'shipment') $$;

-- ---------------------------------------------------------------------------
-- 2. Customer orders
-- ---------------------------------------------------------------------------
-- The order's status from its lines (open while any is open; cancelled when all are; else closed).
CREATE OR REPLACE FUNCTION app.co_follow_lines(p_order uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o public.customer_orders%ROWTYPE; v_open boolean; v_all_cancelled boolean; v_status text;
BEGIN
  SELECT * INTO o FROM public.customer_orders WHERE id = p_order FOR UPDATE;
  SELECT bool_or(status = 'open'), bool_and(status = 'cancelled') INTO v_open, v_all_cancelled FROM public.customer_order_lines WHERE customer_order_id = p_order;
  v_status := CASE WHEN v_open THEN 'open' WHEN v_all_cancelled THEN 'cancelled' ELSE 'closed' END;
  IF v_status = o.status THEN RETURN; END IF;
  UPDATE public.customer_orders
     SET status = v_status,
         closed_at = CASE WHEN v_status = 'closed' THEN now() END,
         closed_by = CASE WHEN v_status = 'closed' THEN auth.uid() END,
         cancel_reason = CASE WHEN v_status = 'cancelled' THEN 'Every line was cancelled in the source system' END,
         updated_by = auth.uid()
   WHERE id = p_order;
END $$;

CREATE OR REPLACE FUNCTION app.import_customer_order(p_org uuid, p_id uuid, d jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  o public.customer_orders%ROWTYPE; l public.customer_order_lines%ROWTYPE; v_order uuid; v_line uuid; v_number text := app.imp_text(d, 'orderNumber');
  v_line_no integer := app.imp_int(d, 'lineNumber'); v_status text := lower(app.imp_text(d, 'lineStatus')); v_customer uuid := app.imp_ref(d, 'customer');
  v_part uuid; v_qty numeric; v_requested date;
BEGIN
  IF v_status IS NOT NULL AND v_status NOT IN ('open', 'closed', 'cancelled') THEN
    RAISE EXCEPTION 'Line status: "%" is not one of open, closed or cancelled', v_status USING ERRCODE = 'QM022';
  END IF;

  IF p_id IS NULL THEN
    IF v_number IS NULL OR v_line_no IS NULL THEN RAISE EXCEPTION 'An order line needs its order number and line number' USING ERRCODE = 'QM022'; END IF;
    v_part := app.imp_ref(d, 'part'); v_qty := app.imp_num(d, 'quantityOrdered'); v_requested := app.imp_date(d, 'requestedOn');
    IF v_part IS NULL THEN RAISE EXCEPTION 'Part number: a customer order line needs the part' USING ERRCODE = 'QM022'; END IF;
    IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity ordered: give a number above zero' USING ERRCODE = 'QM022'; END IF;
    IF v_requested IS NULL THEN RAISE EXCEPTION 'Requested on: give the date the customer asked for' USING ERRCODE = 'QM022'; END IF;
    SELECT * INTO o FROM public.customer_orders WHERE organisation_id = p_org AND upper(order_number) = upper(v_number) FOR UPDATE;
    IF NOT FOUND THEN
      IF v_customer IS NULL THEN RAISE EXCEPTION 'A new order needs its customer' USING ERRCODE = 'QM022'; END IF;
      INSERT INTO public.customer_orders (organisation_id, order_number, customer_id, customer_reference, ordered_on, notes)
      VALUES (p_org, v_number, v_customer, app.imp_text(d, 'customerReference'), coalesce(app.imp_date(d, 'orderedOn'), v_requested), app.imp_text(d, 'orderNotes'))
      RETURNING id INTO v_order;
    ELSE
      IF v_customer IS NOT NULL AND v_customer <> o.customer_id THEN
        RAISE EXCEPTION 'Order % is for another customer', o.order_number USING ERRCODE = 'QM038';
      END IF;
      v_order := o.id;
    END IF;
    IF EXISTS (SELECT 1 FROM public.customer_order_lines WHERE customer_order_id = v_order AND line_number = v_line_no) THEN
      RAISE EXCEPTION 'Order % already has a line %; to link it, import with matching existing records', v_number, v_line_no USING ERRCODE = 'QM038';
    END IF;
    INSERT INTO public.customer_order_lines (organisation_id, customer_order_id, line_number, part_id, quantity_ordered, unit, requested_on, agreed_on, status)
    VALUES (p_org, v_order, v_line_no, v_part, v_qty, app.imp_text(d, 'unit'), v_requested, app.imp_date(d, 'agreedOn'), coalesce(v_status, 'open'))
    RETURNING id INTO v_line;
    PERFORM app.co_follow_lines(v_order);
    RETURN v_line;
  END IF;

  SELECT * INTO l FROM public.customer_order_lines WHERE id = p_id AND organisation_id = p_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'The order line this record was linked to no longer exists' USING ERRCODE = 'QM022'; END IF;
  SELECT * INTO o FROM public.customer_orders WHERE id = l.customer_order_id FOR UPDATE;
  IF d ? 'orderNumber' AND v_number IS NOT NULL AND upper(v_number) <> upper(o.order_number) THEN
    RAISE EXCEPTION 'An order line cannot move to another order (% to %)', o.order_number, v_number USING ERRCODE = 'QM038';
  END IF;
  IF d ? 'lineNumber' AND v_line_no IS NOT NULL AND v_line_no <> l.line_number THEN
    RAISE EXCEPTION 'An order line keeps its number (% to %)', l.line_number, v_line_no USING ERRCODE = 'QM038';
  END IF;
  IF d ? 'customer' AND v_customer IS NOT NULL AND v_customer <> o.customer_id THEN
    RAISE EXCEPTION 'The customer of order % cannot change', o.order_number USING ERRCODE = 'QM038';
  END IF;
  v_part := CASE WHEN d ? 'part' THEN coalesce(app.imp_ref(d, 'part'), l.part_id) ELSE l.part_id END;
  IF v_part IS DISTINCT FROM l.part_id AND EXISTS (SELECT 1 FROM public.shipment_lines WHERE order_line_id = l.id) THEN
    RAISE EXCEPTION 'Order % line %: goods have been shipped against it, so its part cannot change', o.order_number, l.line_number USING ERRCODE = 'QM038';
  END IF;
  UPDATE public.customer_orders SET
    ordered_on = CASE WHEN d ? 'orderedOn' THEN coalesce(app.imp_date(d, 'orderedOn'), ordered_on) ELSE ordered_on END,
    customer_reference = CASE WHEN d ? 'customerReference' THEN app.imp_text(d, 'customerReference') ELSE customer_reference END,
    notes = CASE WHEN d ? 'orderNotes' THEN app.imp_text(d, 'orderNotes') ELSE notes END,
    updated_by = auth.uid()
  WHERE id = o.id AND (
    (d ? 'orderedOn' AND app.imp_date(d, 'orderedOn') IS NOT NULL AND app.imp_date(d, 'orderedOn') <> ordered_on)
    OR (d ? 'customerReference' AND app.imp_text(d, 'customerReference') IS DISTINCT FROM customer_reference)
    OR (d ? 'orderNotes' AND app.imp_text(d, 'orderNotes') IS DISTINCT FROM notes));
  -- What the customer asked for is the original date: never changed by an import.
  UPDATE public.customer_order_lines SET
    part_id = v_part,
    quantity_ordered = CASE WHEN d ? 'quantityOrdered' THEN coalesce(app.imp_num(d, 'quantityOrdered'), quantity_ordered) ELSE quantity_ordered END,
    unit = CASE WHEN d ? 'unit' THEN app.imp_text(d, 'unit') ELSE unit END,
    agreed_on = CASE WHEN d ? 'agreedOn' THEN app.imp_date(d, 'agreedOn') ELSE agreed_on END,
    status = CASE WHEN d ? 'lineStatus' AND v_status IS NOT NULL THEN v_status ELSE status END,
    updated_by = auth.uid()
  WHERE id = l.id;
  PERFORM app.co_follow_lines(o.id);
  RETURN l.id;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Shipments
-- ---------------------------------------------------------------------------
-- Where a shipment came from: the connection and the source's own document number (rows with the same number for the same customer are one shipment).
ALTER TABLE public.shipments
  ADD COLUMN IF NOT EXISTS source_connection_id uuid,
  ADD COLUMN IF NOT EXISTS source_document text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shipments_source_document_check') THEN
    ALTER TABLE public.shipments ADD CONSTRAINT shipments_source_document_check CHECK (source_document IS NULL OR length(btrim(source_document)) BETWEEN 1 AND 100);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shipments_source_connection_fkey') THEN
    ALTER TABLE public.shipments ADD CONSTRAINT shipments_source_connection_fkey FOREIGN KEY (source_connection_id, organisation_id) REFERENCES public.integration_connections (id, organisation_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shipments_source_pair') THEN
    ALTER TABLE public.shipments ADD CONSTRAINT shipments_source_pair CHECK (source_document IS NULL OR source_connection_id IS NOT NULL);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS shipments_source_document_key ON public.shipments (organisation_id, source_connection_id, customer_id, upper(source_document)) WHERE source_document IS NOT NULL;

-- The order line a shipment row names by order number and line number (null when it names none).
CREATE OR REPLACE FUNCTION app.import_co_line(p_org uuid, d jsonb) RETURNS public.customer_order_lines
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_l public.customer_order_lines%ROWTYPE; v_no text := app.imp_text(d, 'orderNumber'); v_line integer := app.imp_int(d, 'orderLine');
BEGIN
  IF v_no IS NULL THEN
    IF v_line IS NOT NULL THEN RAISE EXCEPTION 'An order line number needs its order number' USING ERRCODE = 'QM022'; END IF;
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.customer_orders WHERE organisation_id = p_org AND upper(order_number) = upper(v_no)) THEN
    RAISE EXCEPTION 'Order % is not in Fortress: import the customer orders first', v_no USING ERRCODE = 'QM022';
  END IF;
  IF v_line IS NULL THEN
    IF (SELECT count(*) FROM public.customer_order_lines l JOIN public.customer_orders o ON o.id = l.customer_order_id
         WHERE o.organisation_id = p_org AND upper(o.order_number) = upper(v_no)) <> 1 THEN
      RAISE EXCEPTION 'Order % has several lines: say which line was shipped', v_no USING ERRCODE = 'QM022';
    END IF;
    SELECT l.* INTO v_l FROM public.customer_order_lines l JOIN public.customer_orders o ON o.id = l.customer_order_id
     WHERE o.organisation_id = p_org AND upper(o.order_number) = upper(v_no);
    RETURN v_l;
  END IF;
  SELECT l.* INTO v_l FROM public.customer_order_lines l JOIN public.customer_orders o ON o.id = l.customer_order_id
   WHERE o.organisation_id = p_org AND upper(o.order_number) = upper(v_no) AND l.line_number = v_line;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order % has no line %', v_no, v_line USING ERRCODE = 'QM022'; END IF;
  RETURN v_l;
END $$;

CREATE OR REPLACE FUNCTION app.import_shipment(p_org uuid, p_id uuid, d jsonb, p_connection uuid DEFAULT NULL, p_external text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  ol public.customer_order_lines%ROWTYPE; s public.shipments%ROWTYPE; v_order public.customer_orders%ROWTYPE; v_lot public.lots%ROWTYPE;
  v_customer uuid := app.imp_ref(d, 'customer'); v_qty numeric := app.imp_num(d, 'quantity'); v_on date := app.imp_date(d, 'shippedOn');
  v_move text := lower(app.imp_text(d, 'movement')); v_part uuid := app.imp_ref(d, 'part'); v_lot_no text := app.imp_text(d, 'lotNumber');
  v_doc text := app.imp_text(d, 'documentNumber'); v_site uuid := app.imp_ref(d, 'site'); v_year integer; v_n integer; v_line uuid; v_line_no integer;
BEGIN
  IF p_id IS NOT NULL THEN
    RAISE EXCEPTION 'A shipment already imported is not changed by a later import: cancel the shipment in Fortress and import it again' USING ERRCODE = 'QM022';
  END IF;
  IF v_move IS NOT NULL AND v_move NOT IN ('shipment', 'return') THEN
    RAISE EXCEPTION 'Movement: "%" is not a shipment or a return', v_move USING ERRCODE = 'QM022';
  END IF;
  IF v_move = 'return' OR v_qty < 0 THEN
    RAISE EXCEPTION 'A return is not a shipment: leave this row out (a customer''s return is recorded as an RMA on the non-conformance)' USING ERRCODE = 'QM022';
  END IF;
  IF v_qty IS NULL OR v_qty = 0 THEN RAISE EXCEPTION 'Quantity: give the quantity shipped' USING ERRCODE = 'QM022'; END IF;
  IF v_on IS NULL OR v_on > current_date THEN RAISE EXCEPTION 'Shipped on: give the date (not in the future)' USING ERRCODE = 'QM022'; END IF;

  ol := app.import_co_line(p_org, d);
  IF ol.id IS NOT NULL THEN
    SELECT * INTO v_order FROM public.customer_orders WHERE id = ol.customer_order_id;
    IF v_customer IS NOT NULL AND v_customer <> v_order.customer_id THEN
      RAISE EXCEPTION 'Order % is for another customer', v_order.order_number USING ERRCODE = 'QM038';
    END IF;
    IF v_order.status = 'cancelled' OR ol.status = 'cancelled' THEN
      RAISE EXCEPTION 'Order % line % was cancelled', v_order.order_number, ol.line_number USING ERRCODE = 'QM038';
    END IF;
    v_customer := v_order.customer_id;
    IF v_part IS NOT NULL AND ol.part_id <> v_part THEN
      RAISE EXCEPTION 'That is not the part on order % line %', v_order.order_number, ol.line_number USING ERRCODE = 'QM038';
    END IF;
    v_part := ol.part_id;
  END IF;
  IF v_customer IS NULL THEN RAISE EXCEPTION 'Customer: name the customer or the customer order' USING ERRCODE = 'QM022'; END IF;
  IF v_part IS NULL THEN RAISE EXCEPTION 'Part number: name the part (or the order line)' USING ERRCODE = 'QM022'; END IF;

  IF v_site IS NULL AND (SELECT count(*) FROM public.sites WHERE organisation_id = p_org AND active) = 1 THEN
    SELECT id INTO v_site FROM public.sites WHERE organisation_id = p_org AND active;
  END IF;
  IF v_lot_no IS NOT NULL THEN
    SELECT * INTO v_lot FROM public.lots WHERE organisation_id = p_org AND part_id = v_part AND upper(lot_number) = upper(v_lot_no);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Lot % of that part is not in Fortress (a shipment never makes a lot): import the production orders or lots first, or leave the lot out', v_lot_no USING ERRCODE = 'QM022';
    END IF;
  END IF;

  IF v_doc IS NOT NULL THEN
    SELECT * INTO s FROM public.shipments
     WHERE organisation_id = p_org AND source_connection_id = p_connection AND customer_id = v_customer AND upper(source_document) = upper(v_doc) FOR UPDATE;
  END IF;
  IF s.id IS NULL THEN
    v_year := extract(year FROM v_on)::int;
    INSERT INTO app.shipment_counters AS k (organisation_id, year, last_value) VALUES (p_org, v_year, 1)
    ON CONFLICT (organisation_id, year) DO UPDATE SET last_value = k.last_value + 1 RETURNING last_value INTO v_n;
    INSERT INTO public.shipments (organisation_id, reference, customer_id, customer_order_id, site_id, shipped_on, delivery_note, source_connection_id, source_document)
    VALUES (p_org, 'SH-' || to_char(make_date(v_year, 1, 1), 'YY') || '-' || app.pad_number(v_n, 4), v_customer, v_order.id, v_site, v_on,
            app.imp_text(d, 'deliveryNote'), p_connection, v_doc)
    RETURNING * INTO s;
  ELSE
    IF s.status <> 'shipped' THEN RAISE EXCEPTION 'Shipment % (document %) was cancelled in Fortress', s.reference, v_doc USING ERRCODE = 'QM038'; END IF;
    IF s.shipped_on <> v_on THEN
      RAISE EXCEPTION 'Document % was shipped on %; this row says %', v_doc, to_char(s.shipped_on, 'YYYY-MM-DD'), to_char(v_on, 'YYYY-MM-DD') USING ERRCODE = 'QM022';
    END IF;
    -- A shipment names an order only while all its lines are from that order.
    IF s.customer_order_id IS NOT NULL AND s.customer_order_id IS DISTINCT FROM v_order.id THEN
      UPDATE public.shipments SET customer_order_id = NULL WHERE id = s.id;
    END IF;
  END IF;

  SELECT coalesce(max(line_number), 0) + 1 INTO v_line_no FROM public.shipment_lines WHERE shipment_id = s.id;
  INSERT INTO public.shipment_lines (organisation_id, shipment_id, line_number, order_line_id, part_id, quantity_shipped, lot_id, notes)
  VALUES (p_org, s.id, v_line_no, ol.id, v_part, v_qty, v_lot.id, app.imp_text(d, 'notes'))
  RETURNING id INTO v_line;
  RETURN v_line;
END $$;

-- ---------------------------------------------------------------------------
-- 4. The run function knows the new kinds
-- ---------------------------------------------------------------------------
SELECT pg_temp.patch_once('app.system_import_record(uuid, uuid, uuid, uuid, uuid, jsonb)'::regprocedure, 'import_customer_order',
  $o$    WHEN 'goods_receipt' THEN app.import_goods_receipt(p_org, p_internal, v_data, r.connection_id, i.external_id)$o$,
  $n$    WHEN 'goods_receipt' THEN app.import_goods_receipt(p_org, p_internal, v_data, r.connection_id, i.external_id)
    WHEN 'customer_order' THEN app.import_customer_order(p_org, p_internal, v_data)
    WHEN 'shipment' THEN app.import_shipment(p_org, p_internal, v_data, r.connection_id, i.external_id)$n$);

-- The add-only kinds: the run function's own write-mode guard lists them (NCs, calibrations, cost lines); a shipment joins them.
SELECT pg_temp.patch_once('app.system_import_record(uuid, uuid, uuid, uuid, uuid, jsonb)'::regprocedure, 'shipment''',
  $o$CASE WHEN r.entity_type IN ('nonconformance', 'calibration', 'ncr_cost') THEN 'add_only'$o$,
  $n$CASE WHEN r.entity_type IN ('nonconformance', 'calibration', 'ncr_cost', 'shipment') THEN 'add_only'$n$);

REVOKE ALL ON FUNCTION app.co_follow_lines(uuid), app.import_customer_order(uuid, uuid, jsonb), app.import_co_line(uuid, jsonb), app.import_shipment(uuid, uuid, jsonb, uuid, text) FROM PUBLIC, anon, authenticated;
