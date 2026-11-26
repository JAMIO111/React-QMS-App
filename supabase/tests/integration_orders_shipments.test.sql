-- Integrations SH4: customer orders (one source row per order line) and shipments (one source row per movement out) imported through the shipping rules: the
-- order found or made, what the customer asked for fixed on create, the order following its lines' statuses; a shipment named by order and line, rows with
-- one document number making one shipment, a return refused, a lot that must already exist, nothing changed after the import.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('5f800000-0000-0000-0000-000000000a01', 'ann@ordersship.test'), ('5f800000-0000-0000-0000-000000000a04', 'eve@ordersship.test');

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
CREATE FUNCTION pg_temp.co_line(p_order text, p_line int, p_customer uuid, p_part uuid, p_extra jsonb DEFAULT '{}'::jsonb) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('orderNumber', p_order, 'lineNumber', p_line, 'customer', 'ACME', 'customerId', p_customer, 'part', 'P', 'partId', p_part,
                            'quantityOrdered', 100, 'requestedOn', '2026-10-01') || p_extra
$$;

-- A shipment row as a source sends it (the customer and part come from the order unless the extra says otherwise).
CREATE FUNCTION pg_temp.ship_row(p_order text, p_line int, p_customer uuid, p_part uuid, p_extra jsonb DEFAULT '{}'::jsonb) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('orderNumber', p_order, 'orderLine', p_line, 'partId', p_part, 'part', 'P', 'quantity', 10, 'shippedOn', '2026-10-05') || p_extra
$$;

DO $$
DECLARE
  ann uuid := '5f800000-0000-0000-0000-000000000a01'; eve uuid := '5f800000-0000-0000-0000-000000000a04';
  org uuid; org2 uuid; api uuid; acme uuid; bolt uuid; part uuid; part2 uuid; supplier uuid; lot uuid; res jsonb; l1 uuid; l2 uuid; co uuid; sh uuid; shl uuid;
  v_before integer; v_ref text;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('Orders Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('Orders Beta'); PERFORM pg_temp.logout();
  PERFORM pg_temp.give_controller_seat(org, ann);
  PERFORM pg_temp.give_controller_seat(org2, eve);
  INSERT INTO public.customers (organisation_id, code, name) VALUES (org, 'ACME', 'Acme Motors') RETURNING id INTO acme;
  INSERT INTO public.customers (organisation_id, code, name) VALUES (org, 'BOLT', 'Bolt Autos') RETURNING id INTO bolt;
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'STEEL', 'Steel Co') RETURNING id INTO supplier;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'P-1', 'Bracket') RETURNING id INTO part;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'P-2', 'Housing') RETURNING id INTO part2;
  INSERT INTO public.lots (organisation_id, lot_number, part_id, origin, supplier_id, quantity, received_on) VALUES (org, 'LOT-A', part, 'received', supplier, 500, '2026-09-01') RETURNING id INTO lot;

  PERFORM pg_temp.login(ann);
  api := app.create_integration_connection(org, 'rest_api', 'ERP', 'erp', '{"baseUrl": "https://erp.example.com", "authType": "none"}'::jsonb);
  PERFORM app.record_integration_connection_test(api, true, 'ok');
  PERFORM app.mark_integration_ready(api);
  PERFORM app.activate_integration_connection(api);
  PERFORM app.set_integration_import_settings(api, 'customer_order', '{"writeMode": "add_update"}'::jsonb);
  PERFORM app.set_integration_import_settings(api, 'shipment', '{"writeMode": "add_update"}'::jsonb);
  PERFORM pg_temp.assert_eq(app.integration_may_write(org, 'customer_order'), true, 'an owner may import customer orders');
  PERFORM pg_temp.assert_eq(app.integration_may_write(org, 'shipment'), true, 'and shipments');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(app.integration_settings_for(api, 'shipment') ->> 'writeMode', 'add_only', 'a shipment is always add only, whatever was chosen');
  PERFORM pg_temp.assert_eq(app.integration_entity_tracks_missing('shipment'), false, 'a movement is never missing from the source');
  PERFORM pg_temp.assert_eq(app.integration_entity_tracks_missing('customer_order'), true, 'an order line can be');

  -- ---- a new order is made from its first line; a later line joins it ----
  res := pg_temp.import_one(org, api, ann, 'customer_order', 'CO-100/1', pg_temp.co_line('CO-100', 1, acme, part, jsonb_build_object('customerReference', 'PO-7788', 'orderNotes', 'Blanket')));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'applied', 'the first line imports: ' || coalesce(res ->> 'errors', ''));
  l1 := (res ->> 'internal')::uuid;
  SELECT customer_order_id INTO co FROM public.customer_order_lines WHERE id = l1;
  PERFORM pg_temp.assert_eq((SELECT order_number || '/' || customer_id::text || '/' || customer_reference || '/' || status || '/' || notes FROM public.customer_orders WHERE id = co),
                            'CO-100/' || acme::text || '/PO-7788/open/Blanket', 'the order is made with the customer and their own number');
  PERFORM pg_temp.assert_eq((SELECT created_by FROM public.customer_order_lines WHERE id = l1), ann, 'as the person who started the import');
  res := pg_temp.import_one(org, api, ann, 'customer_order', 'CO-100/2', pg_temp.co_line('co-100', 2, NULL, part2, '{"customer": null, "customerId": null}'::jsonb));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'applied', 'a later line imports without naming the customer: ' || coalesce(res ->> 'errors', ''));
  l2 := (res ->> 'internal')::uuid;
  PERFORM pg_temp.assert_eq((SELECT customer_order_id FROM public.customer_order_lines WHERE id = l2), co, 'it joins the order by its number (any case)');
  res := pg_temp.import_one(org, api, ann, 'customer_order', 'CO-100/3', pg_temp.co_line('CO-100', 3, bolt, part, '{}'::jsonb));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'a line naming another customer is refused');
  PERFORM pg_temp.assert_eq(res ->> 'errors' LIKE '%another customer%', true, 'with the reason');
  res := pg_temp.import_one(org, api, ann, 'customer_order', 'CO-101/1', pg_temp.co_line('CO-101', 1, acme, part, '{"requestedOn": null}'::jsonb));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'a line with no requested date is refused: what the customer asked for must be known');

  -- ---- an update moves the confirmed date and quantity, never the requested date ----
  res := pg_temp.import_one(org, api, ann, 'customer_order', 'CO-100/1', pg_temp.co_line('CO-100', 1, acme, part, '{"agreedOn": "2026-10-20", "quantityOrdered": 120, "requestedOn": "2026-12-25"}'::jsonb));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'applied', 'an update imports: ' || coalesce(res ->> 'errors', ''));
  PERFORM pg_temp.assert_eq((SELECT agreed_on::text || '/' || quantity_ordered::text || '/' || requested_on::text FROM public.customer_order_lines WHERE id = l1), '2026-10-20/120.000/2026-10-01',
                            'the confirmed date and quantity follow; the requested date stays');

  -- ---- shipments ----
  res := pg_temp.import_one(org, api, ann, 'shipment', 'TX-1', pg_temp.ship_row('CO-100', 1, NULL, part, '{"documentNumber": "DN-9", "quantity": 40, "lotNumber": "LOT-A"}'::jsonb));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'applied', 'a shipment row imports: ' || coalesce(res ->> 'errors', ''));
  shl := (res ->> 'internal')::uuid;
  SELECT shipment_id INTO sh FROM public.shipment_lines WHERE id = shl;
  SELECT reference INTO v_ref FROM public.shipments WHERE id = sh;
  PERFORM pg_temp.assert_eq(v_ref, 'SH-26-0001', 'the shipment is numbered from the year it shipped');
  PERFORM pg_temp.assert_eq((SELECT customer_id::text || '/' || customer_order_id::text || '/' || shipped_on::text || '/' || source_document FROM public.shipments WHERE id = sh),
                            acme::text || '/' || co::text || '/2026-10-05/DN-9', 'the customer comes from the order; the date is the real one');
  PERFORM pg_temp.assert_eq((SELECT order_line_id::text || '/' || part_id::text || '/' || quantity_shipped::text || '/' || lot_id::text FROM public.shipment_lines WHERE id = shl),
                            l1::text || '/' || part::text || '/40.000/' || lot::text, 'the line names the order line, the part and the lot');
  res := pg_temp.import_one(org, api, ann, 'shipment', 'TX-2', pg_temp.ship_row('CO-100', 2, NULL, part2, '{"documentNumber": "dn-9", "quantity": 15}'::jsonb));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'applied', 'a second row of the same document imports: ' || coalesce(res ->> 'errors', ''));
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.shipments WHERE organisation_id = org), 1, 'it joins the same shipment (any case)');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.shipment_lines WHERE shipment_id = sh), 2, 'as its second line');
  res := pg_temp.import_one(org, api, ann, 'shipment', 'TX-3', pg_temp.ship_row('CO-100', 2, NULL, part2, '{"documentNumber": "DN-9", "quantity": 5, "shippedOn": "2026-10-06"}'::jsonb));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'the same document on another day is refused');

  -- over-shipping is allowed (it shows on the order page), a shipment needs no order, a customer and part will do
  res := pg_temp.import_one(org, api, ann, 'shipment', 'TX-4', pg_temp.ship_row('CO-100', 1, NULL, part, '{"documentNumber": "DN-10", "quantity": 500}'::jsonb));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'applied', 'shipping more than ordered is allowed: ' || coalesce(res ->> 'errors', ''));
  res := pg_temp.import_one(org, api, ann, 'shipment', 'TX-5', jsonb_build_object('customer', 'BOLT', 'customerId', bolt, 'part', 'P-2', 'partId', part2, 'quantity', 7, 'shippedOn', '2026-10-07'));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'applied', 'a shipment with no order imports: ' || coalesce(res ->> 'errors', ''));
  PERFORM pg_temp.assert_eq((SELECT customer_order_id IS NULL FROM public.shipments s JOIN public.shipment_lines x ON x.shipment_id = s.id WHERE x.id = (res ->> 'internal')::uuid), true, 'and names no order');

  -- ---- refusals ----
  res := pg_temp.import_one(org, api, ann, 'shipment', 'TX-6', pg_temp.ship_row('CO-100', 1, NULL, part, '{"quantity": -5}'::jsonb));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'a negative quantity is refused');
  PERFORM pg_temp.assert_eq(res ->> 'errors' LIKE '%return%', true, 'and says a return is not a shipment');
  res := pg_temp.import_one(org, api, ann, 'shipment', 'TX-7', pg_temp.ship_row('CO-100', 1, NULL, part, '{"movement": "return", "quantity": 5}'::jsonb));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'a row that says return is refused');
  v_before := (SELECT count(*)::int FROM public.lots WHERE organisation_id = org);
  res := pg_temp.import_one(org, api, ann, 'shipment', 'TX-8', pg_temp.ship_row('CO-100', 1, NULL, part, '{"quantity": 3, "lotNumber": "NO-SUCH"}'::jsonb));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'a lot Fortress does not have is refused');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.lots WHERE organisation_id = org), v_before, 'a shipment never makes a lot');
  res := pg_temp.import_one(org, api, ann, 'shipment', 'TX-9', pg_temp.ship_row('CO-999', 1, NULL, part, '{"quantity": 3}'::jsonb));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'an order Fortress does not have is refused');
  res := pg_temp.import_one(org, api, ann, 'shipment', 'TX-10', pg_temp.ship_row('CO-100', 1, NULL, part, '{"quantity": 3, "shippedOn": "2099-01-01"}'::jsonb));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'a date in the future is refused');
  res := pg_temp.import_one(org, api, ann, 'shipment', 'TX-11', pg_temp.ship_row('CO-100', 2, NULL, part, '{"quantity": 3}'::jsonb));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'the wrong part for the order line is refused');

  -- ---- after a shipment, an order line keeps its part; closing every line closes the order ----
  res := pg_temp.import_one(org, api, ann, 'customer_order', 'CO-100/1', pg_temp.co_line('CO-100', 1, acme, part2, '{"agreedOn": "2026-10-20", "quantityOrdered": 120}'::jsonb));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'a part cannot change once goods have shipped against the line');
  PERFORM pg_temp.import_one(org, api, ann, 'customer_order', 'CO-100/1', pg_temp.co_line('CO-100', 1, acme, part, '{"agreedOn": "2026-10-20", "quantityOrdered": 120, "lineStatus": "closed"}'::jsonb));
  PERFORM pg_temp.assert_eq((SELECT status FROM public.customer_orders WHERE id = co), 'open', 'the order stays open while a line is open');
  PERFORM pg_temp.import_one(org, api, ann, 'customer_order', 'CO-100/2', pg_temp.co_line('CO-100', 2, NULL, part2, '{"customer": null, "customerId": null, "lineStatus": "closed"}'::jsonb));
  PERFORM pg_temp.assert_eq((SELECT status FROM public.customer_orders WHERE id = co), 'closed', 'and closes when every line is closed');
  res := pg_temp.import_one(org, api, ann, 'shipment', 'TX-12', pg_temp.ship_row('CO-100', 1, NULL, part, '{"documentNumber": "DN-11", "quantity": 2}'::jsonb));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'applied', 'an old shipment against a closed order imports: history is accepted');

  -- ---- who may write ----
  PERFORM pg_temp.login(eve);
  PERFORM pg_temp.assert_eq(app.integration_may_write(org2, 'shipment'), true, 'another organisation''s owner may import shipments there');
  PERFORM pg_temp.assert_eq(app.integration_may_write(org, 'shipment'), false, 'but not in an organisation they are not in');
  PERFORM pg_temp.assert_eq(app.integration_may_write(org2, 'no_such_kind'), false, 'an unknown kind is never writable');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
