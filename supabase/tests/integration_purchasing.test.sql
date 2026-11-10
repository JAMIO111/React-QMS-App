-- Integrations IN6: purchase orders (one source row per order line, identified by order number + line number) imported through the receiving rules:
-- the order found or made, the requested date fixed on create, the order following its lines' statuses, identity never moving.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('5f600000-0000-0000-0000-000000000a01', 'ann@purchasing.test'), ('5f600000-0000-0000-0000-000000000a04', 'eve@purchasing.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

-- One full import of one record through the runner (as the API does it). Answers {status, internal, errors, action}.
CREATE FUNCTION pg_temp.import_one(p_org uuid, p_conn uuid, p_user uuid, p_entity text, p_ext text, p_canonical jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE run uuid; owner uuid := gen_random_uuid(); todo jsonb; v_id uuid; row_id uuid; i public.integration_inbox%ROWTYPE;
BEGIN
  PERFORM pg_temp.login(p_user); run := app.request_integration_run(p_conn, p_entity, 'full'); PERFORM pg_temp.logout();
  PERFORM app.system_lease_integration_run(p_org, run, owner, 30);
  PERFORM app.system_stage_integration_records(p_org, run, owner,
    jsonb_build_array(jsonb_build_object('externalId', p_ext, 'payload', jsonb_build_object('id', p_ext), 'canonical', p_canonical)), NULL, true);
  todo := app.system_integration_rows_to_apply(p_org, run, owner, 10);
  IF jsonb_array_length(todo) = 1 THEN
    row_id := (todo -> 0 ->> 'id')::uuid;
    BEGIN
      v_id := app.system_import_record(p_org, run, owner, row_id, (todo -> 0 ->> 'internalId')::uuid, todo -> 0 -> 'canonical');
      PERFORM app.system_apply_integration_row(p_org, run, owner, row_id, v_id, todo -> 0 ->> 'action');
    EXCEPTION WHEN OTHERS THEN
      PERFORM app.system_fail_integration_row(p_org, run, owner, row_id, SQLERRM, NULL);
    END;
  END IF;
  PERFORM pg_temp.logout();
  PERFORM app.system_finish_integration_run(p_org, run, owner);
  SELECT * INTO i FROM public.integration_inbox WHERE run_id = run;
  RETURN jsonb_build_object('status', i.status, 'internal', i.internal_id, 'errors', i.errors, 'action', i.action);
END $$;

-- An order line row as a source sends it.
CREATE FUNCTION pg_temp.po_line(p_po text, p_line int, p_supplier uuid, p_extra jsonb DEFAULT '{}'::jsonb) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('poNumber', p_po, 'lineNumber', p_line, 'supplier', 'ACME', 'supplierId', p_supplier, 'material', 'Steel bar',
                            'quantityOrdered', 100, 'requestedOn', '2026-10-01') || p_extra
$$;

DO $$
DECLARE
  ann uuid := '5f600000-0000-0000-0000-000000000a01'; eve uuid := '5f600000-0000-0000-0000-000000000a04';
  org uuid; org2 uuid; api uuid; acme uuid; other uuid; part uuid; part2 uuid; res jsonb; l1 uuid; l2 uuid; po uuid; hand uuid; hand_line uuid;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('Purchasing Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('Purchasing Beta'); PERFORM pg_temp.logout();
  PERFORM pg_temp.give_controller_seat(org, ann);
  PERFORM pg_temp.give_controller_seat(org2, eve);
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'ACME', 'Acme Ltd') RETURNING id INTO acme;
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'OTHER', 'Other Ltd') RETURNING id INTO other;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'P-1', 'Bracket') RETURNING id INTO part;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'P-2', 'Housing') RETURNING id INTO part2;

  PERFORM pg_temp.login(ann);
  api := app.create_integration_connection(org, 'rest_api', 'ERP', 'erp', '{"baseUrl": "https://erp.example.com", "authType": "none"}'::jsonb);
  PERFORM app.record_integration_connection_test(api, true, 'ok');
  PERFORM app.mark_integration_ready(api);
  PERFORM app.activate_integration_connection(api);
  PERFORM app.set_integration_import_settings(api, 'purchase_order', '{"writeMode": "add_update"}'::jsonb);
  PERFORM pg_temp.assert_eq(app.integration_may_write(org, 'purchase_order'), true, 'an owner may import purchase orders');
  PERFORM pg_temp.logout();

  -- ---- a new order is made from its first line; later lines join it ----
  res := pg_temp.import_one(org, api, ann, 'purchase_order', 'PO-100/1', pg_temp.po_line('PO-100', 1, acme, jsonb_build_object('part', 'P-1', 'partId', part, 'material', NULL, 'orderNotes', 'Blanket')));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'applied', 'the first line is imported');
  l1 := (res ->> 'internal')::uuid;
  SELECT purchase_order_id INTO po FROM public.purchase_order_lines WHERE id = l1;
  PERFORM pg_temp.assert_eq((SELECT po_number || '/' || supplier_id::text || '/' || ordered_on::text || '/' || status || '/' || notes FROM public.purchase_orders WHERE id = po),
    'PO-100/' || acme::text || '/2026-10-01/open/Blanket', 'the order is made, ordered on the requested date when none is given');
  PERFORM pg_temp.assert_eq((SELECT created_by FROM public.purchase_order_lines WHERE id = l1), ann, 'as the person who started the import');
  res := pg_temp.import_one(org, api, ann, 'purchase_order', 'PO-100/2', pg_temp.po_line('po-100', 2, NULL, '{"supplier": null}'::jsonb));
  l2 := (res ->> 'internal')::uuid;
  PERFORM pg_temp.assert_eq((SELECT purchase_order_id FROM public.purchase_order_lines WHERE id = l2), po, 'a later line joins the order by its number (any case), without naming the supplier');
  res := pg_temp.import_one(org, api, ann, 'purchase_order', 'PO-100/3', pg_temp.po_line('PO-100', 3, other));
  PERFORM pg_temp.assert_eq(res ->> 'status' || '/' || (res -> 'errors' -> 0 ->> 'message'), 'failed/Order PO-100 is for another supplier', 'a line naming another supplier fails');
  res := pg_temp.import_one(org, api, ann, 'purchase_order', 'PO-101/1', pg_temp.po_line('PO-101', 1, NULL, '{"supplier": null}'::jsonb));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'a new order needs its supplier');

  -- ---- an update: the requested date stays, the rest follows; the order follows its lines ----
  res := pg_temp.import_one(org, api, ann, 'purchase_order', 'PO-100/1', pg_temp.po_line('PO-100', 1, acme,
    jsonb_build_object('part', 'P-1', 'partId', part, 'material', NULL, 'requestedOn', '2026-12-31', 'agreedOn', '2026-10-15', 'quantityOrdered', 120, 'lineStatus', 'closed')));
  PERFORM pg_temp.assert_eq(res ->> 'action', 'update', 'a changed line is an update');
  PERFORM pg_temp.assert_eq((SELECT requested_on::text || '/' || agreed_on::text || '/' || quantity_ordered::int || '/' || status FROM public.purchase_order_lines WHERE id = l1),
    '2026-10-01/2026-10-15/120/closed', 'the requested date is never changed by an import; the agreed date, quantity and status follow');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.purchase_orders WHERE id = po), 'open', 'the order stays open while a line is open');
  res := pg_temp.import_one(org, api, ann, 'purchase_order', 'PO-100/2', pg_temp.po_line('PO-100', 2, NULL, '{"supplier": null, "lineStatus": "Closed"}'::jsonb));
  PERFORM pg_temp.assert_eq((SELECT status || '/' || (closed_at IS NOT NULL)::text FROM public.purchase_orders WHERE id = po), 'closed/true', 'and closes when its last open line closes');
  res := pg_temp.import_one(org, api, ann, 'purchase_order', 'PO-100/2', pg_temp.po_line('PO-100', 2, NULL, '{"supplier": null, "lineStatus": "open", "quantityOrdered": 90}'::jsonb));
  PERFORM pg_temp.assert_eq((SELECT status || '/' || (closed_at IS NULL)::text FROM public.purchase_orders WHERE id = po), 'open/true', 'a line opened again opens the order');
  res := pg_temp.import_one(org, api, ann, 'purchase_order', 'PO-200/1', pg_temp.po_line('PO-200', 1, acme, '{"lineStatus": "cancelled"}'::jsonb));
  PERFORM pg_temp.assert_eq((SELECT status || '/' || cancel_reason FROM public.purchase_orders WHERE upper(po_number) = 'PO-200' AND organisation_id = org),
    'cancelled/Every line was cancelled in the source system', 'an order whose lines are all cancelled is cancelled, with the reason');
  res := pg_temp.import_one(org, api, ann, 'purchase_order', 'PO-200/2', pg_temp.po_line('PO-200', 2, acme, '{"lineStatus": "bogus"}'::jsonb));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'a status that is not ours fails');

  -- ---- identity never moves ----
  res := pg_temp.import_one(org, api, ann, 'purchase_order', 'PO-100/1', pg_temp.po_line('PO-999', 1, acme, '{"quantityOrdered": 5}'::jsonb));
  PERFORM pg_temp.assert_eq(res -> 'errors' -> 0 ->> 'message', 'An order line cannot move to another order (PO-100 to PO-999)', 'a line cannot move to another order');
  res := pg_temp.import_one(org, api, ann, 'purchase_order', 'PO-100/1', pg_temp.po_line('PO-100', 1, other, '{"quantityOrdered": 6}'::jsonb));
  PERFORM pg_temp.assert_eq(res -> 'errors' -> 0 ->> 'message', 'The supplier of order PO-100 cannot change', 'nor change supplier');
  -- once goods are received against a line its part is fixed
  PERFORM pg_temp.login(ann);
  PERFORM app.record_goods_receipt(acme, po, NULL, current_date, 'DN-1', NULL, jsonb_build_array(jsonb_build_object('poLineId', l2, 'quantity', 10)), NULL);
  PERFORM pg_temp.logout();
  res := pg_temp.import_one(org, api, ann, 'purchase_order', 'PO-100/2', pg_temp.po_line('PO-100', 2, NULL, jsonb_build_object('supplier', NULL, 'part', 'P-2', 'partId', part2, 'quantityOrdered', 91)));
  PERFORM pg_temp.assert_eq(res -> 'errors' -> 0 ->> 'message', 'Order PO-100 line 2: goods have been received against it, so its part cannot change', 'a received line keeps its part');

  -- ---- matching an order made by hand: "<order>/<line>" finds the line ----
  PERFORM pg_temp.login(ann);
  hand := app.create_purchase_order(acme, 'HAND-7', current_date, NULL, jsonb_build_array(jsonb_build_object('material', 'Bolts', 'quantity', 50, 'requestedOn', '2026-11-30')));
  SELECT id INTO hand_line FROM public.purchase_order_lines WHERE purchase_order_id = hand;
  PERFORM app.set_integration_import_settings(api, 'purchase_order', '{"writeMode": "add_update", "matchExisting": true}'::jsonb);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(app.integration_record_code('purchase_order', '{"poNumber": "hand-7", "lineNumber": 1}'::jsonb), 'hand-7/1', 'the code of an order line is order/line');
  PERFORM pg_temp.assert_eq(app.integration_find_by_code(org, 'purchase_order', 'hand-7/1'), hand_line, 'which finds the line made by hand (any case)');
  PERFORM pg_temp.assert_eq(app.integration_find_by_code(org, 'purchase_order', 'hand-7/2'), NULL::uuid, 'and not a line that is not there');
  res := pg_temp.import_one(org, api, ann, 'purchase_order', 'HAND-7/1', pg_temp.po_line('HAND-7', 1, acme, '{"material": "Bolts", "quantityOrdered": 60, "agreedOn": "2026-12-05"}'::jsonb));
  PERFORM pg_temp.assert_eq((res ->> 'internal')::uuid, hand_line, 'the import updates the line made by hand');
  PERFORM pg_temp.assert_eq((SELECT quantity_ordered::int || '/' || requested_on::text FROM public.purchase_order_lines WHERE id = hand_line), '60/2026-11-30', 'keeping its requested date');

  -- ---- permissions and tenancy ----
  PERFORM pg_temp.assert_eq(has_function_privilege('authenticated', 'app.import_purchase_order(uuid, uuid, jsonb)', 'EXECUTE'), false, 'nobody signed in calls the import directly');
  PERFORM pg_temp.assert_eq(app.integration_find_by_code(org2, 'purchase_order', 'PO-100/1'), NULL::uuid, 'another organisation finds none of it');
END $$;

-- ---- IN6b: goods receipts from delivery rows ----
CREATE FUNCTION pg_temp.delivery(p_doc text, p_po text, p_line int, p_qty numeric, p_on text, p_extra jsonb DEFAULT '{}'::jsonb) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('documentNumber', p_doc, 'poNumber', p_po, 'poLine', p_line, 'quantity', p_qty, 'receivedOn', p_on)) || p_extra
$$;

DO $$
DECLARE
  ann uuid := '5f600000-0000-0000-0000-000000000a01';
  org uuid; api uuid; acme uuid; part uuid; res jsonb; t1 uuid; t2 uuid; g1 uuid; lot uuid; run uuid; owner uuid := gen_random_uuid(); n int;
BEGIN
  SELECT id INTO org FROM public.organisations WHERE name = 'Purchasing Alpha';
  SELECT id INTO api FROM public.integration_connections WHERE organisation_id = org AND external_system = 'erp';
  SELECT id INTO acme FROM public.suppliers WHERE organisation_id = org AND code = 'ACME';
  SELECT id INTO part FROM public.parts WHERE organisation_id = org AND part_number = 'P-1';
  PERFORM pg_temp.login(ann); PERFORM pg_temp.assert_eq(app.integration_may_write(org, 'goods_receipt'), true, 'an owner may import goods receipts'); PERFORM pg_temp.logout();

  -- a delivery against a closed order line (historical mode), with a lot that is made released and never inspected
  res := pg_temp.import_one(org, api, ann, 'goods_receipt', 'T1', pg_temp.delivery('GRN-1', 'PO-100', 1, 40, '2026-10-03', jsonb_build_object('lotNumber', 'L-1', 'deliveryNote', 'DN-77')));
  PERFORM pg_temp.assert_eq(res ->> 'status' || coalesce(' ' || (res -> 'errors' -> 0 ->> 'message'), ''), 'applied', 'a delivery is imported');
  t1 := (res ->> 'internal')::uuid;
  SELECT goods_receipt_id, lot_id INTO g1, lot FROM public.goods_receipt_lines WHERE id = t1;
  PERFORM pg_temp.assert_eq((SELECT l.status FROM public.purchase_order_lines l JOIN public.purchase_orders o ON o.id = l.purchase_order_id WHERE o.organisation_id = org AND upper(o.po_number) = 'PO-100' AND l.line_number = 1),
    'closed', 'against an order line that is already closed');
  PERFORM pg_temp.assert_eq((SELECT received_on::text || '/' || delivery_note || '/' || source_document || '/' || (reference LIKE 'GR-26-%')::text || '/' || (site_id IS NOT NULL)::text FROM public.goods_receipts WHERE id = g1),
    '2026-10-03/DN-77/GRN-1/true/true', 'the receipt keeps the real date, the delivery note and the document, numbered in the year it arrived, at the only site');
  PERFORM pg_temp.assert_eq((SELECT status || '/' || origin || '/' || supplier_id::text || '/' || quantity::int FROM public.lots WHERE id = lot),
    'released/received/' || acme::text || '/40', 'the lot is made released (E3)');
  PERFORM pg_temp.assert_eq((SELECT required::text || '/' || strategy FROM public.incoming_inspection_determinations WHERE receipt_line_id = t1), 'false/none', 'and no inspection is required');
  PERFORM pg_temp.assert_eq((SELECT part_id FROM public.goods_receipt_lines WHERE id = t1), part, 'the part comes from the order line');

  -- a second row with the same document joins the same receipt
  res := pg_temp.import_one(org, api, ann, 'goods_receipt', 'T2', pg_temp.delivery('GRN-1', 'po-100', 2, 10, '2026-10-03'));
  t2 := (res ->> 'internal')::uuid;
  PERFORM pg_temp.assert_eq((SELECT goods_receipt_id::text || '/' || line_number FROM public.goods_receipt_lines WHERE id = t2), g1::text || '/2', 'the same document is the same receipt (next line)');
  res := pg_temp.import_one(org, api, ann, 'goods_receipt', 'T3', pg_temp.delivery('GRN-1', 'PO-100', 2, 5, '2026-10-04'));
  PERFORM pg_temp.assert_eq(res -> 'errors' -> 0 ->> 'message', 'Document GRN-1 was received on 2026-10-03; this row says 2026-10-04', 'one document arrives on one date');
  res := pg_temp.import_one(org, api, ann, 'goods_receipt', 'T4', pg_temp.delivery('GRN-2', NULL, NULL, 5, '2026-10-05', jsonb_build_object('supplier', 'ACME', 'supplierId', acme, 'material', 'Grease')));
  PERFORM pg_temp.assert_eq((SELECT material || '/' || (po_line_id IS NULL)::text FROM public.goods_receipt_lines WHERE id = (res ->> 'internal')::uuid), 'Grease/true', 'a delivery without an order names its supplier and material');
  res := pg_temp.import_one(org, api, ann, 'goods_receipt', 'T5', pg_temp.delivery('GRN-3', 'PO-404', 1, 5, '2026-10-05'));
  PERFORM pg_temp.assert_eq(res -> 'errors' -> 0 ->> 'message', 'Order PO-404 is not in Fortress: import the purchase orders first', 'an unknown order fails with what to do');
  res := pg_temp.import_one(org, api, ann, 'goods_receipt', 'T6', pg_temp.delivery('GRN-3', 'PO-100', NULL, 5, '2026-10-05'));
  PERFORM pg_temp.assert_eq(res -> 'errors' -> 0 ->> 'message', 'Order PO-100 has several lines: say which line was delivered', 'an order with several lines needs the line');
  res := pg_temp.import_one(org, api, ann, 'goods_receipt', 'T7', pg_temp.delivery('GRN-3', 'PO-100', 1, 5, (current_date + 1)::text));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'a delivery in the future fails');
  -- the same lot delivered again is the same lot
  res := pg_temp.import_one(org, api, ann, 'goods_receipt', 'T8', pg_temp.delivery('GRN-4', 'PO-100', 1, 5, '2026-10-06', '{"lotNumber": "l-1"}'::jsonb));
  PERFORM pg_temp.assert_eq((SELECT lot_id FROM public.goods_receipt_lines WHERE id = (res ->> 'internal')::uuid), lot, 'a lot delivered again (any case) is the same lot');

  -- returns become rejections of the matching earlier delivery (E1): T1 has 40 of lot L-1, T8 (later) has 5
  res := pg_temp.import_one(org, api, ann, 'goods_receipt', 'R1', pg_temp.delivery('RTN-1', 'PO-100', 1, -15, '2026-10-10', '{"lotNumber": "L-1"}'::jsonb));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'applied', 'a return is imported');
  PERFORM pg_temp.assert_eq((SELECT receipt_line_id::text || '/' || decision || '/' || quantity_rejected::int FROM public.receipt_line_dispositions WHERE id = (res ->> 'internal')::uuid),
    t1::text || '/rejected/15', 'as a rejection of that quantity on the latest delivery with enough left (the later one has only 5)');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.goods_receipt_lines WHERE quantity_received < 0), 0, 'never a negative line');
  res := pg_temp.import_one(org, api, ann, 'goods_receipt', 'R2', pg_temp.delivery('RTN-2', 'PO-100', 1, 20, '2026-10-11', '{"movement": "Return", "lotNumber": "L-1"}'::jsonb));
  PERFORM pg_temp.assert_eq((SELECT receipt_line_id::text || '/' || quantity_rejected::int FROM public.receipt_line_dispositions WHERE id = (res ->> 'internal')::uuid), t1::text || '/35',
    'a return movement with a plain quantity is a return too, and adds to what the delivery already rejected');
  res := pg_temp.import_one(org, api, ann, 'goods_receipt', 'R3', pg_temp.delivery('RTN-3', 'PO-100', 1, -20, '2026-10-12', '{"lotNumber": "L-1"}'::jsonb));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'nothing has 20 left to return');
  res := pg_temp.import_one(org, api, ann, 'goods_receipt', 'R4', pg_temp.delivery('RTN-4', 'PO-100', 1, -5, '2026-10-12', '{"lotNumber": "L-1"}'::jsonb));
  PERFORM pg_temp.assert_eq((SELECT receipt_line_id <> t1 AND quantity_rejected = 5 FROM public.receipt_line_dispositions WHERE id = (res ->> 'internal')::uuid), true,
    'a return the latest delivery can take goes to it');
  res := pg_temp.import_one(org, api, ann, 'goods_receipt', 'R5', pg_temp.delivery('RTN-5', 'PO-100', 1, -1, '2026-10-01', '{"lotNumber": "L-1"}'::jsonb));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'a return dated before any delivery matches nothing');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.lots WHERE id = lot), 'released', 'an imported return never holds the lot');

  -- a delivery already imported is never changed: goods receipts are always "add new only", and the import function refuses an update anyway
  PERFORM pg_temp.login(ann); PERFORM app.set_integration_import_settings(api, 'goods_receipt', '{"writeMode": "add_update", "matchExisting": true}'::jsonb); PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(app.integration_settings_for(api, 'goods_receipt') ->> 'writeMode' || '/' || (app.integration_settings_for(api, 'goods_receipt') ->> 'matchExisting'), 'add_only/false',
    'goods receipts are only ever added, never matched');
  res := pg_temp.import_one(org, api, ann, 'goods_receipt', 'T1', pg_temp.delivery('GRN-1', 'PO-100', 1, 41, '2026-10-03', '{"lotNumber": "L-1"}'::jsonb));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'skipped', 'a changed delivery is skipped');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.import_goods_receipt(%L, %L, '{"quantity": 41, "receivedOn": "2026-10-03"}'::jsonb)$f$, org, t1)), 5), 'QM022',
    'and the import function refuses to change one');
  PERFORM pg_temp.assert_eq(app.integration_template_settings('goods_receipt', '{"writeMode": "update_only"}'::jsonb) ->> 'writeMode', 'add_only', 'a template cannot say otherwise');

  -- a row the mapping leaves out is skipped with the reason, whatever else is wrong with it
  PERFORM pg_temp.login(ann); run := app.request_integration_run(api, 'goods_receipt', 'full'); PERFORM pg_temp.logout();
  PERFORM app.system_lease_integration_run(org, run, owner, 30);
  PERFORM app.system_stage_integration_records(org, run, owner, jsonb_build_array(
    jsonb_build_object('externalId', 'X1', 'payload', '{"t": "TRF"}'::jsonb, 'canonical', '{"leaveOut": true}'::jsonb, 'skip', 'Left out by the mapping',
                       'errors', '[{"field": "quantity", "message": "Quantity is required"}]'::jsonb),
    jsonb_build_object('payload', '{"t": "ADJ"}'::jsonb, 'skip', 'Left out by the mapping', 'sourceRow', 7)), NULL, true);
  PERFORM pg_temp.assert_eq((SELECT string_agg(status || ':' || external_id || ':' || (errors -> 0 ->> 'message'), ',' ORDER BY external_id COLLATE "C" DESC) FROM public.integration_inbox WHERE run_id = run),
    'skipped:row-7:Left out by the mapping,skipped:X1:Left out by the mapping', 'left-out rows are skipped, even without an identifier');
  PERFORM pg_temp.assert_eq((SELECT skipped || '/' || rejected FROM public.integration_sync_runs WHERE id = run), '2/0', 'and counted as skipped, not rejected');
  PERFORM app.system_finish_integration_run(org, run, owner);
END $$;

ROLLBACK;
