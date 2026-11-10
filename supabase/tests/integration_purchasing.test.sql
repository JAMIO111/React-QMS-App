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

ROLLBACK;
