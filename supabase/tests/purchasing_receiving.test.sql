-- Supplier Quality SQ4a: purchase orders, goods receipts and the lots a receipt makes — numbering, validation, idempotent receipts, frozen receipt lines, permissions, tenant isolation.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('4a000000-0000-0000-0000-000000000a01', 'ann@pr.test'), ('4a000000-0000-0000-0000-000000000a02', 'bob@pr.test'), ('4a000000-0000-0000-0000-000000000a03', 'cat@pr.test'), ('4a000000-0000-0000-0000-000000000a05', 'eve@pr.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '4a000000-0000-0000-0000-000000000a01'; bob uuid := '4a000000-0000-0000-0000-000000000a02'; cat uuid := '4a000000-0000-0000-0000-000000000a03'; eve uuid := '4a000000-0000-0000-0000-000000000a05';
  org uuid; org2 uuid; s uuid; s2 uuid; sb uuid; p1 uuid; p2 uuid; m uuid; role_id uuid; po uuid; po2 uuid; l1 uuid; l2 uuid; r jsonb; gr uuid; lot uuid;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('PR Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('PR Beta'); PERFORM pg_temp.logout();
  FOREACH m IN ARRAY ARRAY[bob, cat] LOOP
    INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, m, 'active');
    SELECT id INTO role_id FROM public.roles WHERE organisation_id = org AND key = CASE m WHEN bob THEN 'viewer' ELSE 'inspector' END;
    INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, ou.id, role_id FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id = m;
  END LOOP;
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'ACME', 'Acme Metals') RETURNING id INTO s;
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'BOLT', 'Bolt Co') RETURNING id INTO s2;
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org2, 'BETA', 'Beta Ltd') RETURNING id INTO sb;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'BRK-1', 'Bracket') RETURNING id INTO p1;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'BRK-2', 'Other') RETURNING id INTO p2;

  -- ---- who may do what ----
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_purchase_order(%L, 'PO-V', current_date, NULL, '[{"material":"x","quantity":1,"requestedOn":"2030-01-01"}]'::jsonb)$f$, s)), 5), '42501', 'a viewer cannot record an order');
  PERFORM pg_temp.assert_fails(format($f$INSERT INTO public.purchase_orders (organisation_id, po_number, supplier_id) VALUES (%L, 'DIRECT', %L)$f$, org, s), 'orders are written only through functions');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login(cat);
  -- ---- purchase orders ----
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_purchase_order(%L, '', current_date, NULL, '[{"material":"x","quantity":1,"requestedOn":"2030-01-01"}]'::jsonb)$f$, s)), 5), 'QM021', 'an order needs a number');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_purchase_order(%L, 'PO-1', current_date, NULL, '[]'::jsonb)$f$, s)), 5), 'QM021', 'and at least one line');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_purchase_order(%L, 'PO-1', current_date, NULL, '[{"quantity":1,"requestedOn":"2030-01-01"}]'::jsonb)$f$, s)), 5), 'QM021', 'a line names a part or a material');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_purchase_order(%L, 'PO-1', current_date, NULL, '[{"material":"x","quantity":0,"requestedOn":"2030-01-01"}]'::jsonb)$f$, s)), 5), 'QM021', 'the quantity is above zero');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_purchase_order(%L, 'PO-1', current_date, NULL, '[{"material":"x","quantity":1}]'::jsonb)$f$, s)), 5), 'QM021', 'and the requested date is needed');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_purchase_order(%L, 'PO-1', current_date, NULL, '[{"material":"x","quantity":1,"requestedOn":"2030-01-01","price":5}]'::jsonb)$f$, s)), 5), 'QM021', 'an unknown field is refused');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.purchase_orders), 0::bigint, 'and a refused order leaves nothing behind');
  po := app.create_purchase_order(s, 'PO-1', current_date, 'First order', jsonb_build_array(
    jsonb_build_object('partId', p1, 'quantity', 100, 'unit', 'pcs', 'requestedOn', (current_date + 10)::text), jsonb_build_object('material', 'Steel bar 20mm', 'quantity', 50.5, 'requestedOn', (current_date + 12)::text, 'agreedOn', (current_date + 14)::text)));
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.purchase_order_lines WHERE purchase_order_id = po), 2::bigint, 'an order keeps its lines, numbered');
  SELECT id INTO l1 FROM public.purchase_order_lines WHERE purchase_order_id = po AND line_number = 1;
  SELECT id INTO l2 FROM public.purchase_order_lines WHERE purchase_order_id = po AND line_number = 2;
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_purchase_order(%L, 'po-1', current_date, NULL, '[{"material":"x","quantity":1,"requestedOn":"2030-01-01"}]'::jsonb)$f$, s2)), 5), 'QM021', 'a number is unique per organisation ignoring case');
  PERFORM app.set_po_line_agreed_date(l1, (current_date + 20));
  PERFORM pg_temp.assert_eq((SELECT (requested_on = current_date + 10, agreed_on = current_date + 20)::text FROM public.purchase_order_lines WHERE id = l1), '(t,t)', 'the agreed date moves and the requested date stays');

  -- ---- receipts ----
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_goods_receipt(%L, %L, NULL, current_date + 1, NULL, NULL, '[{"material":"x","quantity":1}]'::jsonb, NULL)$f$, s, po)), 5), 'QM021', 'it cannot have arrived in the future');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_goods_receipt(%L, %L, NULL, current_date, NULL, NULL, '[{"material":"x","quantity":1}]'::jsonb, NULL)$f$, s2, po)), 5), 'QM021', 'an order of another supplier cannot be received against');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_goods_receipt(%L, NULL, NULL, current_date, NULL, NULL, jsonb_build_array(jsonb_build_object('poLineId', %L, 'quantity', 1)), NULL)$f$, s, l1)), 5), 'QM021', 'an order line needs its order');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_goods_receipt(%L, %L, NULL, current_date, NULL, NULL, jsonb_build_array(jsonb_build_object('poLineId', %L, 'partId', %L, 'quantity', 1)), NULL)$f$, s, po, l1, p2)), 5), 'QM021', 'the part must be the order line''s part');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_goods_receipt(%L, %L, NULL, current_date, NULL, NULL, jsonb_build_array(jsonb_build_object('material', 'Loose', 'quantity', 5, 'lotNumber', 'L-1')), NULL)$f$, s, po)), 5), 'QM021', 'a lot is of a part, so a material alone cannot make one');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.goods_receipts) + (SELECT count(*) FROM public.lots), 0::bigint, 'a refused receipt leaves no receipt and no lot');
  r := app.record_goods_receipt(s, po, NULL, current_date, 'DN-4412', 'On time', jsonb_build_array(
    jsonb_build_object('poLineId', l1, 'quantity', 60, 'lotNumber', 'LOT-A'), jsonb_build_object('poLineId', l2, 'quantity', 20)), 'client-key-0001');
  gr := (r ->> 'id')::uuid;
  PERFORM pg_temp.assert_eq((r ->> 'created')::boolean, true, 'a receipt is recorded');
  PERFORM pg_temp.assert_eq((SELECT (status, reference ~ '^GR-[0-9]{2}-0001$', delivery_note)::text FROM public.goods_receipts WHERE id = gr), '(received,t,DN-4412)', 'with a number');
  SELECT lot_id INTO lot FROM public.goods_receipt_lines WHERE goods_receipt_id = gr AND po_line_id = l1;
  PERFORM pg_temp.assert_eq((SELECT (lot_number, origin, supplier_id = s, quantity = 60, part_id = p1, received_on = current_date)::text FROM public.lots WHERE id = lot), '(LOT-A,received,t,t,t,t)', 'a line with a lot number makes the received lot, from the supplier');
  PERFORM pg_temp.assert_eq((SELECT part_id = p1 FROM public.goods_receipt_lines WHERE goods_receipt_id = gr AND po_line_id = l1), true, 'the part comes from the order line');
  PERFORM pg_temp.assert_eq((SELECT material FROM public.goods_receipt_lines WHERE goods_receipt_id = gr AND po_line_id = l2), 'Steel bar 20mm', 'and so does the material');
  r := app.record_goods_receipt(s, po, NULL, current_date, 'DN-4412', 'On time', '[{"material":"x","quantity":1}]'::jsonb, 'client-key-0001');
  PERFORM pg_temp.assert_eq(((r ->> 'id')::uuid = gr, (r ->> 'created')::boolean), (true, false), 'a retry with the same key returns the same receipt');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.goods_receipts), 1::bigint, 'and makes no second one');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_goods_receipt(%L, NULL, NULL, current_date, NULL, NULL, jsonb_build_array(jsonb_build_object('partId', %L, 'quantity', 5, 'lotNumber', 'lot-a')), NULL)$f$, s, p1)), 5), 'QM021', 'a lot number already used for that part is refused');
  PERFORM pg_temp.assert_fails(format($f$UPDATE public.goods_receipt_lines SET quantity_received = 1 WHERE goods_receipt_id = %L$f$, gr), 'receipt lines are never changed');
  PERFORM pg_temp.assert_fails(format($f$DELETE FROM public.goods_receipt_lines WHERE goods_receipt_id = %L$f$, gr), 'or deleted');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.cancel_goods_receipt(%L, 'x')$f$, gr)), 5), 'QM021', 'cancelling needs a reason');
  PERFORM app.cancel_goods_receipt(gr, 'Delivered to the wrong site');
  PERFORM pg_temp.assert_eq((SELECT (status, cancel_reason)::text FROM public.goods_receipts WHERE id = gr), '(cancelled,"Delivered to the wrong site")', 'a receipt is cancelled with a reason and kept');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.lots WHERE id = lot), 1::bigint, 'the lot it made is kept');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.cancel_goods_receipt(%L, 'Again please')$f$, gr)), 5), 'QM021', 'and cannot be cancelled twice');

  -- ---- closing and cancelling orders ----
  po2 := app.create_purchase_order(s, 'PO-2', current_date, NULL, jsonb_build_array(jsonb_build_object('material', 'Bolts', 'quantity', 10, 'requestedOn', (current_date + 3)::text)));
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.cancel_purchase_order(%L, 'x')$f$, po2)), 5), 'QM021', 'cancelling an order needs a reason');
  PERFORM app.cancel_purchase_order(po2, 'Supplier cannot deliver');
  PERFORM pg_temp.assert_eq((SELECT (o.status, bool_and(l.status = 'cancelled'))::text FROM public.purchase_orders o JOIN public.purchase_order_lines l ON l.purchase_order_id = o.id WHERE o.id = po2 GROUP BY o.status), '(cancelled,t)', 'its lines follow');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_goods_receipt(%L, %L, NULL, current_date, NULL, NULL, '[{"material":"x","quantity":1}]'::jsonb, NULL)$f$, s, po2)), 5), 'QM021', 'a cancelled order cannot be received against');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.set_po_line_agreed_date(%L, current_date)$f$, (SELECT id FROM public.purchase_order_lines WHERE purchase_order_id = po2))), 5), 'QM021', 'nor its dates changed');
  PERFORM app.close_purchase_order(po);
  PERFORM pg_temp.assert_eq((SELECT (status, closed_at IS NOT NULL)::text FROM public.purchase_orders WHERE id = po), '(closed,t)', 'an order is closed when nothing more is expected');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.close_purchase_order(%L)$f$, po)), 5), 'QM021', 'only once');
  PERFORM pg_temp.logout();

  -- ---- another organisation ----
  PERFORM pg_temp.login(eve);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.purchase_orders) + (SELECT count(*) FROM public.goods_receipts) + (SELECT count(*) FROM public.goods_receipt_lines) + (SELECT count(*) FROM public.purchase_order_lines), 0::bigint, 'another organisation sees none of it');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_purchase_order(%L, 'FOREIGN', current_date, NULL, '[{"material":"x","quantity":1,"requestedOn":"2030-01-01"}]'::jsonb)$f$, s)), 5), 'P0002', 'it cannot order from a foreign supplier');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_goods_receipt(%L, %L, NULL, current_date, NULL, NULL, '[{"material":"x","quantity":1}]'::jsonb, NULL)$f$, sb, po)), 5), 'P0002', 'or receive against a foreign order');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.cancel_goods_receipt(%L, 'Foreign cancel')$f$, gr)), 5), 'P0002', 'or cancel a foreign receipt');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.cancel_purchase_order(%L, 'Foreign cancel')$f$, po)), 5), 'P0002', 'or a foreign order');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) >= 5 FROM public.audit_events WHERE entity_type IN ('purchase_orders', 'goods_receipts', 'goods_receipt_lines')), true, 'it is all audited');
END $$;
ROLLBACK;
