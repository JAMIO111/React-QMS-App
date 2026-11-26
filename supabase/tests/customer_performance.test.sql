-- Customer performance (CD1): shipped units, on-time and in-full against the order lines, customer NCs, PPM by period and by lot, returns, coverage —
-- worked out for one customer or all, only for people who may read shipping and non-conformances, another organisation's customer refused.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('5f900000-0000-0000-0000-000000000a01', 'ann@custperf.test'), ('5f900000-0000-0000-0000-000000000a04', 'eve@custperf.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '5f900000-0000-0000-0000-000000000a01'; eve uuid := '5f900000-0000-0000-0000-000000000a04';
  org uuid; org2 uuid; acme uuid; bolt uuid; part uuid; lot_a uuid; lot_b uuid; so uuid; l1 uuid; l2 uuid; l3 uuid; sh uuid;
  n1 uuid; n2 uuid; n5 uuid; m jsonb; r text; today date := current_date;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('Perf Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('Perf Beta'); PERFORM pg_temp.logout();
  INSERT INTO public.customers (organisation_id, code, name) VALUES (org, 'ACME', 'Acme Motors') RETURNING id INTO acme;
  INSERT INTO public.customers (organisation_id, code, name) VALUES (org, 'BOLT', 'Bolt Autos') RETURNING id INTO bolt;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'P-1', 'Bracket') RETURNING id INTO part;
  INSERT INTO public.lots (organisation_id, lot_number, part_id, origin, quantity) VALUES (org, 'LOT-A', part, 'produced', 500) RETURNING id INTO lot_a;
  INSERT INTO public.lots (organisation_id, lot_number, part_id, origin, quantity) VALUES (org, 'LOT-B', part, 'produced', 500) RETURNING id INTO lot_b;

  -- Data is laid down as the system would (triggers off for the rows that normally come through functions), then read as a person.
  SET LOCAL session_replication_role = replica;
  INSERT INTO public.customer_orders (organisation_id, order_number, customer_id) VALUES (org, 'SO-1', acme) RETURNING id INTO so;
  INSERT INTO public.customer_order_lines (organisation_id, customer_order_id, line_number, part_id, quantity_ordered, requested_on, agreed_on) VALUES (org, so, 1, part, 100, '2026-10-05', '2026-10-12') RETURNING id INTO l1;
  INSERT INTO public.customer_order_lines (organisation_id, customer_order_id, line_number, part_id, quantity_ordered, requested_on) VALUES (org, so, 2, part, 200, '2026-10-10') RETURNING id INTO l2;
  INSERT INTO public.customer_order_lines (organisation_id, customer_order_id, line_number, part_id, quantity_ordered, requested_on) VALUES (org, so, 3, part, 50, '2026-10-20') RETURNING id INTO l3;

  INSERT INTO public.shipments (organisation_id, reference, customer_id, customer_order_id, shipped_on) VALUES (org, 'SH-T-1', acme, so, '2026-10-05') RETURNING id INTO sh;
  INSERT INTO public.shipment_lines (organisation_id, shipment_id, line_number, order_line_id, part_id, quantity_shipped, lot_id) VALUES (org, sh, 1, l1, part, 100, lot_a);
  INSERT INTO public.shipments (organisation_id, reference, customer_id, customer_order_id, shipped_on) VALUES (org, 'SH-T-2', acme, so, '2026-10-14') RETURNING id INTO sh;
  INSERT INTO public.shipment_lines (organisation_id, shipment_id, line_number, order_line_id, part_id, quantity_shipped, lot_id) VALUES (org, sh, 1, l2, part, 150, lot_b);
  INSERT INTO public.shipments (organisation_id, reference, customer_id, shipped_on) VALUES (org, 'SH-T-3', acme, '2026-10-20') RETURNING id INTO sh;
  INSERT INTO public.shipment_lines (organisation_id, shipment_id, line_number, part_id, quantity_shipped) VALUES (org, sh, 1, part, 50);
  INSERT INTO public.shipments (organisation_id, reference, customer_id, shipped_on, status, cancelled_at, cancel_reason) VALUES (org, 'SH-T-4', acme, '2026-10-06', 'cancelled', now(), 'wrong customer') RETURNING id INTO sh;
  INSERT INTO public.shipment_lines (organisation_id, shipment_id, line_number, part_id, quantity_shipped) VALUES (org, sh, 1, part, 999);
  INSERT INTO public.shipments (organisation_id, reference, customer_id, shipped_on) VALUES (org, 'SH-T-5', acme, '2026-09-30') RETURNING id INTO sh;
  INSERT INTO public.shipment_lines (organisation_id, shipment_id, line_number, part_id, quantity_shipped) VALUES (org, sh, 1, part, 77);

  INSERT INTO public.nonconformances (organisation_id, reference, source, customer_id, title, severity, quantity_affected, description, stage, category_id, detected_at)
    VALUES (org, 'NC-T1', 'customer', acme, 'Burrs', 'major', 20, 'x', 'open', pg_temp.cat(org), '2026-10-08') RETURNING id INTO n1;
  INSERT INTO public.nonconformances (organisation_id, reference, source, customer_id, title, severity, quantity_affected, description, stage, category_id, detected_at)
    VALUES (org, 'NC-T2', 'customer', acme, 'Wrong finish', 'critical', 5, 'x', 'closed', pg_temp.cat(org), '2026-10-15') RETURNING id INTO n2;
  INSERT INTO public.nonconformances (organisation_id, reference, source, customer_id, title, severity, quantity_affected, description, stage, category_id, detected_at)
    VALUES (org, 'NC-T3', 'customer', acme, 'Not raised yet', 'minor', 100, 'x', 'draft', pg_temp.cat(org), '2026-10-16');
  INSERT INTO public.nonconformances (organisation_id, reference, source, customer_id, title, severity, quantity_affected, description, stage, category_id, detected_at)
    VALUES (org, 'NC-T4', 'internal', acme, 'Our own scrap', 'minor', 40, 'x', 'open', pg_temp.cat(org), '2026-10-09');
  INSERT INTO public.nonconformances (organisation_id, reference, source, customer_id, title, severity, quantity_affected, description, stage, category_id, detected_at)
    VALUES (org, 'NC-T5', 'customer', acme, 'Earlier lot', 'minor', 7, 'x', 'open', pg_temp.cat(org), '2026-09-20') RETURNING id INTO n5;
  INSERT INTO public.ncr_affected_lots (organisation_id, nonconformance_id, lot_id, quantity) VALUES (org, n1, lot_a, 12), (org, n5, lot_a, 7);
  INSERT INTO public.ncr_affected_lots (organisation_id, nonconformance_id, lot_id, quantity, removed_at, removed_reason) VALUES (org, n1, lot_b, 50, now(), 'wrong lot');
  INSERT INTO public.ncr_dispositions (organisation_id, nonconformance_id, decision, quantity, instructions, reference, status, approved_at)
    VALUES (org, n1, 'customer_return', 5, 'Return them', 'RMA-T-1', 'approved', '2026-10-20 10:00+00');
  INSERT INTO public.ncr_dispositions (organisation_id, nonconformance_id, decision, quantity, instructions, reference, status)
    VALUES (org, n1, 'customer_return', 3, 'Maybe', 'RMA-T-2', 'proposed');
  SET LOCAL session_replication_role = origin;
  INSERT INTO public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, amount, incurred_on) VALUES (org, n1, 'rework', 'GBP', 100, '2026-10-09'), (org, n1, 'customer_charge', 'GBP', 30, '2026-10-10');
  UPDATE public.ncr_costs SET net_org = net_amount WHERE nonconformance_id = n1 AND net_org IS NULL;

  PERFORM pg_temp.login(ann);
  SELECT metrics INTO m FROM app.customer_performance(org, '2026-10-01', '2026-10-31', 'requested', 0, acme);
  PERFORM pg_temp.assert_eq((m -> 'shipped' ->> 'units')::numeric, 300::numeric, 'cancelled shipments and other months are left out of what shipped');
  PERFORM pg_temp.assert_eq(m -> 'shipped' ->> 'shipments', '3', 'three shipments in the period');
  PERFORM pg_temp.assert_eq(m -> 'delivery' ->> 'matched', '2', 'two lines are against an order line');
  PERFORM pg_temp.assert_eq(m -> 'delivery' ->> 'onTime', '1', 'one of them was on time against the requested date');
  PERFORM pg_temp.assert_eq(m -> 'delivery' ->> 'onTimePct', '50.0', 'so half');
  PERFORM pg_temp.assert_eq(m -> 'delivery' ->> 'unmatched', '1', 'the line with no order is unmatched');
  PERFORM pg_temp.assert_eq(m -> 'delivery' -> 'lateSources' -> 0 ->> 'daysLate', '4', 'four days late is named');
  PERFORM pg_temp.assert_eq(m -> 'delivery' ->> 'openLate', '2', 'two order lines are open and past due');
  PERFORM pg_temp.assert_eq((m -> 'delivery' ->> 'oldestOpenLateDays')::int, today - DATE '2026-10-10', 'the oldest is counted from its date');
  PERFORM pg_temp.assert_eq(m -> 'inFull' ->> 'full', '1', 'one line in full');
  PERFORM pg_temp.assert_eq(m -> 'inFull' ->> 'short', '2', 'two short (one shipped late, one not at all)');
  PERFORM pg_temp.assert_eq(m -> 'inFull' ->> 'pct', '33.3', 'a third in full');
  PERFORM pg_temp.assert_eq(m -> 'ncs' ->> 'raised', '2', 'two customer NCs raised in the period (not a draft, not our own, not another month)');
  PERFORM pg_temp.assert_eq((m -> 'ncs' ->> 'units')::numeric, 25::numeric, 'with 25 units affected');
  PERFORM pg_temp.assert_eq(m -> 'ncs' -> 'bySeverity' ->> 'major', '1', 'by severity');
  PERFORM pg_temp.assert_eq(m -> 'ncs' ->> 'openNow', '2', 'two are open now, whatever month they came');
  PERFORM pg_temp.assert_eq((m -> 'ncs' ->> 'oldestOpenDays')::int, today - DATE '2026-09-20', 'the oldest open one from September');
  PERFORM pg_temp.assert_eq((m -> 'ncs' ->> 'cost')::numeric, 70::numeric, 'cost is net of the credit (100 - 30)');
  PERFORM pg_temp.assert_eq(m -> 'ppm' ->> 'value', '83333', 'PPM is 25 over 300 shipped');
  PERFORM pg_temp.assert_eq(m -> 'ppmLot' ->> 'value', '76000', 'by lot: 19 affected of the 250 traced units');
  PERFORM pg_temp.assert_eq(m -> 'ppmLot' ->> 'lotsHit', '1', 'one lot was hit');
  PERFORM pg_temp.assert_eq(m -> 'ppmLot' ->> 'coverage', '83.3', 'five sixths of the units are traced to a lot');
  PERFORM pg_temp.assert_eq((m -> 'returns' ->> 'units')::numeric, 5::numeric, 'only the approved return counts');
  PERFORM pg_temp.assert_eq(m -> 'returns' ->> 'pctOfShipped', '1.67', 'as a share of shipped');
  PERFORM pg_temp.assert_eq(m -> 'coverage' ->> 'withoutOrder', '1', 'coverage says one line has no order');
  PERFORM pg_temp.assert_eq(m -> 'coverage' ->> 'withoutLot', '1', 'and one no lot');

  -- The agreed date moves L1 later but not L2: the same answers here, a different date policy changes who is late.
  SELECT metrics INTO m FROM app.customer_performance(org, '2026-10-01', '2026-10-31', 'agreed', 0, acme);
  PERFORM pg_temp.assert_eq(m -> 'delivery' ->> 'onTime', '1', 'agreed policy: L1 still on time');
  SELECT metrics INTO m FROM app.customer_performance(org, '2026-10-01', '2026-10-31', 'requested', 5, acme);
  PERFORM pg_temp.assert_eq(m -> 'delivery' ->> 'onTime', '2', 'five days of grace make the four-day-late line on time');

  -- A customer with nothing shipped has no PPM, never zero.
  SELECT metrics INTO m FROM app.customer_performance(org, '2026-10-01', '2026-10-31', 'requested', 0, bolt);
  PERFORM pg_temp.assert_eq(m -> 'ppm' ->> 'value' IS NULL, true, 'no shipments, no PPM');
  PERFORM pg_temp.assert_eq(m -> 'delivery' ->> 'onTimePct' IS NULL, true, 'and no on-time percentage');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.customer_performance(org, '2026-10-01', '2026-10-31')), 2::bigint, 'with no customer named every active customer comes back');

  -- A short open line that can still ship is pending, not short.
  PERFORM pg_temp.logout();
  INSERT INTO public.customer_order_lines (organisation_id, customer_order_id, line_number, part_id, quantity_ordered, requested_on) VALUES (org, so, 4, part, 10, today + 2);
  PERFORM pg_temp.login(ann);
  SELECT metrics INTO m FROM app.customer_performance(org, today - 5, today + 5, 'requested', 0, acme);
  PERFORM pg_temp.assert_eq(m -> 'inFull' ->> 'pending', '1', 'a short open line that is not yet due is pending');
  PERFORM pg_temp.assert_eq(m -> 'inFull' ->> 'short', '0', 'not short');

  r := pg_temp.fails(format('SELECT * FROM app.customer_performance(%L, %L, %L, ''requested'', 0, NULL)', org, '2026-10-31'::date, '2026-10-01'::date));
  PERFORM pg_temp.assert_eq(r LIKE 'QM038%', true, 'a period that ends before it starts is refused');
  r := pg_temp.fails(format('SELECT * FROM app.customer_performance(%L, %L, %L, ''whenever'', 0, NULL)', org, '2026-10-01'::date, '2026-10-31'::date));
  PERFORM pg_temp.assert_eq(r LIKE 'QM038%', true, 'an unknown date policy is refused');
  PERFORM pg_temp.logout();

  -- Another organisation's person is told nothing; a customer of another organisation is not found.
  PERFORM pg_temp.login(eve);
  r := pg_temp.fails(format('SELECT * FROM app.customer_performance(%L, %L, %L)', org, '2026-10-01'::date, '2026-10-31'::date));
  PERFORM pg_temp.assert_eq(r LIKE 'P0002%', true, 'a stranger gets not found');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ann);
  r := pg_temp.fails(format('SELECT * FROM app.customer_performance(%L, %L, %L, ''requested'', 0, %L)', org, '2026-10-01'::date, '2026-10-31'::date, gen_random_uuid()));
  PERFORM pg_temp.assert_eq(r LIKE 'P0002%', true, 'an unknown customer is not found');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
