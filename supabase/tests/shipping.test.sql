-- Orders and fulfilment SH1: customer orders and shipments — numbering, validation, idempotent shipments, frozen lines, lots only as named, permissions, tenant isolation.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('4b000000-0000-0000-0000-000000000a01', 'ann@sh.test'), ('4b000000-0000-0000-0000-000000000a02', 'bob@sh.test'), ('4b000000-0000-0000-0000-000000000a03', 'cat@sh.test'), ('4b000000-0000-0000-0000-000000000a05', 'eve@sh.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '4b000000-0000-0000-0000-000000000a01'; bob uuid := '4b000000-0000-0000-0000-000000000a02'; cat uuid := '4b000000-0000-0000-0000-000000000a03'; eve uuid := '4b000000-0000-0000-0000-000000000a05';
  org uuid; org2 uuid; c uuid; c2 uuid; cb uuid; p1 uuid; p2 uuid; m uuid; role_id uuid; o uuid; o2 uuid; l1 uuid; l2 uuid; r jsonb; sh uuid; lot uuid; lot2 uuid; n integer;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('SH Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('SH Beta'); PERFORM pg_temp.logout();
  FOREACH m IN ARRAY ARRAY[bob, cat] LOOP
    INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, m, 'active');
    SELECT id INTO role_id FROM public.roles WHERE organisation_id = org AND key = CASE m WHEN bob THEN 'viewer' ELSE 'inspector' END;
    INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, ou.id, role_id FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id = m;
  END LOOP;
  INSERT INTO public.customers (organisation_id, code, name) VALUES (org, 'ACME', 'Acme Motors') RETURNING id INTO c;
  INSERT INTO public.customers (organisation_id, code, name) VALUES (org, 'BOLT', 'Bolt Autos') RETURNING id INTO c2;
  INSERT INTO public.customers (organisation_id, code, name) VALUES (org2, 'BETA', 'Beta Ltd') RETURNING id INTO cb;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'BRK-1', 'Bracket') RETURNING id INTO p1;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'BRK-2', 'Other') RETURNING id INTO p2;
  INSERT INTO public.lots (organisation_id, lot_number, part_id, origin, quantity) VALUES (org, 'L-100', p1, 'produced', 500) RETURNING id INTO lot;
  INSERT INTO public.lots (organisation_id, lot_number, part_id, origin, quantity) VALUES (org, 'L-200', p2, 'produced', 100) RETURNING id INTO lot2;

  -- ---- who may do what ----
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_customer_order(%L, 'CO-V', NULL, current_date, NULL, '[{"partId":"%s","quantity":1,"requestedOn":"2030-01-01"}]'::jsonb)$f$, c, p1)), 5), '42501', 'a viewer cannot record an order');
  PERFORM pg_temp.assert_fails(format($f$INSERT INTO public.customer_orders (organisation_id, order_number, customer_id) VALUES (%L, 'DIRECT', %L)$f$, org, c), 'orders are written only through functions');
  PERFORM pg_temp.assert_fails(format($f$INSERT INTO public.shipments (organisation_id, reference, customer_id, shipped_on) VALUES (%L, 'DIRECT', %L, current_date)$f$, org, c), 'shipments are written only through functions');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login(cat);
  -- ---- customer orders ----
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_customer_order(%L, '', NULL, current_date, NULL, '[{"partId":"%s","quantity":1,"requestedOn":"2030-01-01"}]'::jsonb)$f$, c, p1)), 5), 'QM038', 'an order needs a number');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_customer_order(%L, 'CO-1', NULL, current_date, NULL, '[]'::jsonb)$f$, c)), 5), 'QM038', 'and at least one line');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_customer_order(%L, 'CO-1', NULL, current_date, NULL, '[{"quantity":1,"requestedOn":"2030-01-01"}]'::jsonb)$f$, c)), 5), 'QM038', 'a line names the part');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_customer_order(%L, 'CO-1', NULL, current_date, NULL, '[{"partId":"%s","quantity":0,"requestedOn":"2030-01-01"}]'::jsonb)$f$, c, p1)), 5), 'QM038', 'the quantity is above zero');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_customer_order(%L, 'CO-1', NULL, current_date, NULL, '[{"partId":"%s","quantity":1}]'::jsonb)$f$, c, p1)), 5), 'QM038', 'a line says the date the customer asked for');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_customer_order(%L, 'CO-1', NULL, current_date, NULL, '[{"partId":"%s","quantity":1,"requestedOn":"2030-01-01","price":5}]'::jsonb)$f$, c, p1)), 5), 'QM038', 'an unknown field is refused');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_customer_order(%L, 'CO-1', NULL, current_date, NULL, '[{"partId":"%s","quantity":1,"requestedOn":"2030-01-01"}]'::jsonb)$f$, c, (SELECT id FROM public.parts LIMIT 0))), 5), 'QM038', 'a null part is refused');

  o := app.create_customer_order(c, 'CO-1', 'PO-7788', current_date - 30, 'First order',
    format($f$[{"partId":"%s","quantity":100,"unit":"pcs","requestedOn":"%s"},{"partId":"%s","quantity":50,"requestedOn":"%s","agreedOn":"%s"}]$f$, p1, current_date - 10, p2, current_date - 5, current_date - 2)::jsonb);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.customer_order_lines WHERE customer_order_id = o), 2::bigint, 'two lines are made');
  PERFORM pg_temp.assert_eq((SELECT customer_reference FROM public.customer_orders WHERE id = o), 'PO-7788', 'the customer''s own order number is kept');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_customer_order(%L, 'co-1', NULL, current_date, NULL, '[{"partId":"%s","quantity":1,"requestedOn":"2030-01-01"}]'::jsonb)$f$, c, p1)), 5), 'QM038', 'an order number is unique ignoring case');
  SELECT id INTO l1 FROM public.customer_order_lines WHERE customer_order_id = o AND line_number = 1;
  SELECT id INTO l2 FROM public.customer_order_lines WHERE customer_order_id = o AND line_number = 2;

  -- the requested date never changes; the agreed date does, and is audited
  PERFORM app.set_order_line_agreed_date(l1, current_date + 3);
  PERFORM pg_temp.assert_eq((SELECT agreed_on FROM public.customer_order_lines WHERE id = l1), current_date + 3, 'the agreed date is set');
  PERFORM pg_temp.assert_eq((SELECT requested_on FROM public.customer_order_lines WHERE id = l1), current_date - 10, 'the requested date is as the customer asked');
  PERFORM pg_temp.assert_fails(format($f$UPDATE public.customer_order_lines SET agreed_on = NULL WHERE id = %L$f$, l1), 'a line is not updated directly');

  -- ---- shipments ----
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_shipment(%L, %L, NULL, current_date + 1, 'DN-1', NULL, '[{"orderLineId":"%s","quantity":10}]'::jsonb, NULL)$f$, c, o, l1)), 5), 'QM038', 'a shipment is not in the future');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_shipment(%L, %L, NULL, current_date, 'DN-1', NULL, '[]'::jsonb, NULL)$f$, c, o)), 5), 'QM038', 'a shipment needs a line');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_shipment(%L, %L, NULL, current_date, 'DN-1', NULL, '[{"orderLineId":"%s","quantity":10}]'::jsonb, NULL)$f$, c2, o, l1)), 5), 'QM038', 'an order of another customer is refused');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_shipment(%L, NULL, NULL, current_date, 'DN-1', NULL, '[{"orderLineId":"%s","quantity":10}]'::jsonb, NULL)$f$, c, l1)), 5), 'QM038', 'an order line needs its order named');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_shipment(%L, %L, NULL, current_date, 'DN-1', NULL, '[{"orderLineId":"%s","partId":"%s","quantity":10}]'::jsonb, NULL)$f$, c, o, l1, p2)), 5), 'QM038', 'the part must agree with the order line');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_shipment(%L, %L, NULL, current_date, 'DN-1', NULL, '[{"partId":"%s","quantity":10,"lotNumber":"NOPE"}]'::jsonb, NULL)$f$, c, NULL, p1)), 5), 'QM038', 'a lot that does not exist is refused (a shipment never makes one)');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_shipment(%L, NULL, NULL, current_date, 'DN-1', NULL, '[{"partId":"%s","quantity":10,"lotId":"%s"}]'::jsonb, NULL)$f$, c, p1, lot2)), 5), 'QM038', 'a lot of another part is refused');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_shipment(%L, NULL, NULL, current_date, 'DN-1', NULL, '[{"quantity":10}]'::jsonb, NULL)$f$, c)), 5), 'QM038', 'a line with neither a part nor an order line is refused');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_shipment(%L, NULL, NULL, current_date, 'DN-1', NULL, '[{"partId":"%s","quantity":10,"price":1}]'::jsonb, NULL)$f$, c, p1)), 5), 'QM038', 'an unknown field is refused');

  r := app.record_shipment(c, o, NULL, current_date - 1, 'DN-1', NULL,
    format($f$[{"orderLineId":"%s","quantity":60,"lotNumber":"l-100"},{"orderLineId":"%s","quantity":50}]$f$, l1, l2)::jsonb, 'ship-key-0001');
  sh := (r ->> 'id')::uuid;
  PERFORM pg_temp.assert_eq((r ->> 'created')::boolean, true, 'the shipment is made');
  PERFORM pg_temp.assert_eq((SELECT reference FROM public.shipments WHERE id = sh), 'SH-' || to_char(now(), 'YY') || '-0001', 'it is numbered SH-YY-NNNN');
  PERFORM pg_temp.assert_eq((SELECT lot_id FROM public.shipment_lines WHERE shipment_id = sh AND line_number = 1), lot, 'a lot number is matched ignoring case to the existing lot');
  PERFORM pg_temp.assert_eq((SELECT part_id FROM public.shipment_lines WHERE shipment_id = sh AND line_number = 2), p2, 'an order line brings its part');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.lots WHERE organisation_id = org), 2::bigint, 'a shipment makes no lot');
  PERFORM pg_temp.assert_eq((app.record_shipment(c, o, NULL, current_date - 1, 'DN-1', NULL, format($f$[{"orderLineId":"%s","quantity":60}]$f$, l1)::jsonb, 'ship-key-0001') ->> 'id')::uuid, sh, 'a retry with the same key returns the same shipment');
  PERFORM pg_temp.assert_eq(((app.record_shipment(c, o, NULL, current_date - 1, 'DN-1', NULL, format($f$[{"orderLineId":"%s","quantity":60}]$f$, l1)::jsonb, 'ship-key-0001')) ->> 'created')::boolean, false, 'and says it was not made again');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_shipment(%L, NULL, NULL, current_date, 'DN-1', NULL, '[{"partId":"%s","quantity":1}]'::jsonb, 'ship-key-0001')$f$, c2, p1)), 5), 'QM038', 'a key used for another customer is refused');

  -- over-shipment is allowed (the order line asked for 100; 60 + 50 on the second order line is over its 50 only if shipped twice)
  r := app.record_shipment(c, o, NULL, current_date, 'DN-2', NULL, format($f$[{"orderLineId":"%s","quantity":80}]$f$, l1)::jsonb, NULL);
  PERFORM pg_temp.assert_eq((SELECT sum(quantity_shipped) FROM public.shipment_lines WHERE order_line_id = l1), 140::numeric, 'shipping more than ordered is recorded, not refused');
  PERFORM pg_temp.assert_eq((SELECT reference FROM public.shipments WHERE id = (r ->> 'id')::uuid), 'SH-' || to_char(now(), 'YY') || '-0002', 'numbers run on');

  -- a shipment without an order is fine (counted, left out of on-time later)
  r := app.record_shipment(c, NULL, NULL, current_date, NULL, 'Spares', format($f$[{"partId":"%s","quantity":5}]$f$, p1)::jsonb, NULL);
  PERFORM pg_temp.assert_eq((SELECT customer_order_id FROM public.shipments WHERE id = (r ->> 'id')::uuid), NULL::uuid, 'a shipment needs no order');

  -- lines are frozen
  PERFORM pg_temp.assert_fails(format($f$UPDATE public.shipment_lines SET quantity_shipped = 1 WHERE shipment_id = %L$f$, sh), 'shipment lines are not updated');
  PERFORM pg_temp.assert_fails(format($f$DELETE FROM public.shipment_lines WHERE shipment_id = %L$f$, sh), 'nor deleted');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.cancel_shipment(%L, 'x')$f$, sh)), 5), 'QM038', 'a cancellation needs a reason');
  PERFORM app.cancel_shipment((r ->> 'id')::uuid, 'Keyed in error');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.shipments WHERE id = (r ->> 'id')::uuid), 'cancelled', 'a shipment is cancelled as a whole');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.cancel_shipment(%L, 'Again please')$f$, (r ->> 'id')::uuid)), 5), 'QM038', 'only once');

  -- closing and cancelling orders
  PERFORM app.close_customer_order(o);
  PERFORM pg_temp.assert_eq((SELECT status FROM public.customer_orders WHERE id = o), 'closed', 'an order is closed');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.customer_order_lines WHERE customer_order_id = o AND status = 'closed'), 2::bigint, 'its open lines follow');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_shipment(%L, %L, NULL, current_date, 'DN-3', NULL, '[{"orderLineId":"%s","quantity":1}]'::jsonb, NULL)$f$, c, o, l1)), 5), 'QM038', 'nothing ships against a closed order');
  o2 := app.create_customer_order(c, 'CO-2', NULL, current_date, NULL, format($f$[{"partId":"%s","quantity":10,"requestedOn":"%s"}]$f$, p1, current_date + 5)::jsonb);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.cancel_customer_order(%L, 'no')$f$, o2)), 5), 'QM038', 'cancelling an order needs a reason');
  PERFORM app.cancel_customer_order(o2, 'Customer withdrew it');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.customer_orders WHERE id = o2), 'cancelled', 'an order is cancelled');
  PERFORM pg_temp.logout();

  -- ---- reading ----
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.shipments), 3::bigint, 'a viewer reads shipments (the cancelled one too; the retry made no extra one)');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
