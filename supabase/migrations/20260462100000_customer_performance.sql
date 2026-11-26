-- Customer performance (docs/order-fulfilment-plan.md §5, CD1): what we shipped to each customer, whether it was on time and in full, what they reported
-- as defective and how that compares with what we shipped (PPM), and what came back under an RMA. Worked out by the database, once, for the whole
-- organisation or for one customer, so a customer's own figures and the dashboard that adds them up cannot disagree (as app.supplier_performance does).
--
-- Information only: nothing here changes an order, a shipment or a non-conformance. Customers with no shipments in the period show no PPM (null),
-- never a PPM of zero.
--   * Shipped units / shipments: non-cancelled shipments of the customer with shipped_on in the period.
--   * On-time: shipment lines against an order line, by the policy's due date (requested = what the customer asked for, never changes; agreed = the
--     latest confirmed date, else requested), plus grace days after. Lines with no order line are "unmatched" and left out.
--   * In full: per order line (not cancelled) whose due date falls in the period: units shipped by (due + grace) against the ordered quantity
--     (never below it; over 110% is not "in full" either). A short open line that can still ship is "pending" and left out.
--   * Customer NCs: live non-conformances naming the customer, source `customer` (not our own scrap), past draft, not cancelled, detected in the period:
--     count, severity, units affected, open now, oldest open age, cost (organisation currency, credits negative).
--   * PPM (period) = units affected on those NCs / units shipped in the period x 1,000,000 (it lags: a lot shipped in March may be reported in May).
--   * PPM (by lot) = traced units only: units affected on lots that were shipped to the customer in the period (capped at what was shipped from the lot)
--     / units shipped with a lot x 1,000,000, with its coverage. Shown beside the period figure, never mixed with it.
--   * Returns = approved customer_return (RMA) dispositions approved in the period; separate from PPM (a complaint and its RMA describe the same parts).
-- The caller needs shipping.read AND ncr.read (as supplier performance needs receiving.read and supplier_quality.read). Needs 20260459100000_shipping.sql.
SET check_function_bodies = off;

DROP FUNCTION IF EXISTS app.customer_performance(uuid, date, date, text, integer, uuid);
CREATE FUNCTION app.customer_performance(p_org uuid, p_from date, p_to date, p_policy text DEFAULT 'requested', p_grace_after integer DEFAULT 0, p_customer uuid DEFAULT NULL)
RETURNS TABLE (customer_id uuid, metrics jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE v_currency text;
BEGIN
  IF NOT app.is_member(p_org) THEN RAISE EXCEPTION 'Organisation not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT (app.has_permission(p_org, 'shipping.read') AND app.has_permission(p_org, 'ncr.read')) THEN
    RAISE EXCEPTION 'You are not allowed to see customer performance' USING ERRCODE = '42501';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN RAISE EXCEPTION 'The period must start on or before it ends' USING ERRCODE = 'QM038'; END IF;
  IF p_policy NOT IN ('requested', 'agreed') THEN RAISE EXCEPTION 'Unknown on-time date policy' USING ERRCODE = 'QM038'; END IF;
  IF p_grace_after IS NULL OR p_grace_after < 0 OR p_grace_after > 60 THEN RAISE EXCEPTION 'Grace days must be between 0 and 60' USING ERRCODE = 'QM038'; END IF;
  IF p_customer IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.customers c WHERE c.id = p_customer AND c.organisation_id = p_org) THEN
    RAISE EXCEPTION 'Customer not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT base_currency INTO v_currency FROM public.organisation_settings WHERE organisation_id = p_org;

  RETURN QUERY
  WITH cust AS (
    SELECT c.id, c.code, c.name FROM public.customers c WHERE c.organisation_id = p_org AND (p_customer IS NULL OR c.id = p_customer) AND (c.active OR p_customer IS NOT NULL)
  ),
  -- Lines shipped in the period (cancelled shipments left out), with the order line's due date when there is one.
  sl AS (
    SELECT s.customer_id, s.id AS shipment_id, s.reference, l.line_number, l.quantity_shipped AS qty, l.lot_id, l.order_line_id, s.shipped_on,
           CASE WHEN ol.id IS NULL THEN NULL WHEN p_policy = 'requested' THEN ol.requested_on ELSE coalesce(ol.agreed_on, ol.requested_on) END AS due
      FROM public.shipments s
      JOIN public.shipment_lines l ON l.shipment_id = s.id AND l.organisation_id = s.organisation_id
      LEFT JOIN public.customer_order_lines ol ON ol.id = l.order_line_id
     WHERE s.organisation_id = p_org AND s.status = 'shipped' AND s.shipped_on BETWEEN p_from AND p_to AND (p_customer IS NULL OR s.customer_id = p_customer)
  ),
  ship AS (
    SELECT customer_id, count(DISTINCT shipment_id)::int AS shipments, count(*)::int AS lines, coalesce(sum(qty), 0) AS units,
           count(*) FILTER (WHERE order_line_id IS NULL)::int AS no_order, count(*) FILTER (WHERE lot_id IS NULL)::int AS no_lot,
           coalesce(sum(qty) FILTER (WHERE lot_id IS NOT NULL), 0) AS traced_units, max(shipped_on) AS last_on
      FROM sl GROUP BY customer_id
  ),
  otd AS (
    SELECT customer_id, count(*) FILTER (WHERE due IS NOT NULL)::int AS matched,
           count(*) FILTER (WHERE due IS NOT NULL AND shipped_on <= due + p_grace_after)::int AS on_time,
           coalesce(jsonb_agg(jsonb_build_object('shipmentId', shipment_id, 'reference', reference, 'lineNumber', line_number, 'daysLate', shipped_on - due - p_grace_after)
                              ORDER BY shipped_on - due DESC) FILTER (WHERE due IS NOT NULL AND shipped_on > due + p_grace_after AND rn <= 10), '[]'::jsonb) AS late_src
      FROM (SELECT sl.*, row_number() OVER (PARTITION BY customer_id ORDER BY shipped_on - due DESC NULLS LAST) AS rn FROM sl) x GROUP BY customer_id
  ),
  -- Order lines whose due date falls in the period, with what had shipped by the date they were due.
  due_lines AS (
    SELECT o.customer_id, ol.id, ol.quantity_ordered, ol.status,
           CASE WHEN p_policy = 'requested' THEN ol.requested_on ELSE coalesce(ol.agreed_on, ol.requested_on) END AS due,
           coalesce((SELECT sum(x.quantity_shipped) FROM public.shipment_lines x JOIN public.shipments sh ON sh.id = x.shipment_id
                      WHERE x.order_line_id = ol.id AND sh.status = 'shipped'
                        AND sh.shipped_on <= (CASE WHEN p_policy = 'requested' THEN ol.requested_on ELSE coalesce(ol.agreed_on, ol.requested_on) END) + p_grace_after), 0) AS shipped_by
      FROM public.customer_order_lines ol JOIN public.customer_orders o ON o.id = ol.customer_order_id
     WHERE ol.organisation_id = p_org AND ol.status <> 'cancelled' AND o.status <> 'cancelled' AND (p_customer IS NULL OR o.customer_id = p_customer)
       AND (CASE WHEN p_policy = 'requested' THEN ol.requested_on ELSE coalesce(ol.agreed_on, ol.requested_on) END) BETWEEN p_from AND p_to
  ),
  infull AS (
    SELECT customer_id,
           count(*) FILTER (WHERE shipped_by >= quantity_ordered AND shipped_by <= quantity_ordered * 1.10)::int AS full,
           count(*) FILTER (WHERE shipped_by > quantity_ordered * 1.10)::int AS over,
           count(*) FILTER (WHERE shipped_by < quantity_ordered AND NOT (status = 'open' AND due + p_grace_after >= current_date))::int AS short,
           count(*) FILTER (WHERE shipped_by < quantity_ordered AND status = 'open' AND due + p_grace_after >= current_date)::int AS pending
      FROM due_lines GROUP BY customer_id
  ),
  -- Open order lines already past their due date as of today (a warning, whatever the period).
  open_late AS (
    SELECT o.customer_id, count(*)::int AS n, max(current_date - (CASE WHEN p_policy = 'requested' THEN ol.requested_on ELSE coalesce(ol.agreed_on, ol.requested_on) END))::int AS oldest
      FROM public.customer_order_lines ol JOIN public.customer_orders o ON o.id = ol.customer_order_id
     WHERE ol.organisation_id = p_org AND ol.status = 'open' AND o.status = 'open' AND (p_customer IS NULL OR o.customer_id = p_customer)
       AND (CASE WHEN p_policy = 'requested' THEN ol.requested_on ELSE coalesce(ol.agreed_on, ol.requested_on) END) + p_grace_after < current_date
       AND ol.quantity_ordered > coalesce((SELECT sum(x.quantity_shipped) FROM public.shipment_lines x JOIN public.shipments sh ON sh.id = x.shipment_id WHERE x.order_line_id = ol.id AND sh.status = 'shipped'), 0)
     GROUP BY o.customer_id
  ),
  ncs AS (
    SELECT n.id, n.customer_id, n.reference, n.severity, n.stage, n.detected_at, coalesce(n.quantity_affected, 0) AS units
      FROM public.nonconformances n
     WHERE n.organisation_id = p_org AND n.source = 'customer' AND n.deleted_at IS NULL AND n.stage NOT IN ('draft', 'cancelled') AND n.customer_id IS NOT NULL
       AND (p_customer IS NULL OR n.customer_id = p_customer)
  ),
  ncp AS (
    SELECT customer_id, count(*)::int AS raised, coalesce(sum(units), 0) AS units,
           count(*) FILTER (WHERE severity = 'critical')::int AS critical, count(*) FILTER (WHERE severity = 'major')::int AS major,
           count(*) FILTER (WHERE severity = 'minor')::int AS minor, count(*) FILTER (WHERE severity IS NULL)::int AS unrated,
           coalesce(jsonb_agg(jsonb_build_object('ncrId', id, 'reference', reference, 'units', units) ORDER BY detected_at DESC, reference) FILTER (WHERE rn <= 10), '[]'::jsonb) AS src
      FROM (SELECT ncs.*, row_number() OVER (PARTITION BY customer_id ORDER BY detected_at DESC, reference) AS rn FROM ncs WHERE detected_at BETWEEN p_from AND p_to) x GROUP BY customer_id
  ),
  nco AS (
    SELECT customer_id, count(*) FILTER (WHERE stage <> 'closed')::int AS open_now, max(current_date - detected_at) FILTER (WHERE stage <> 'closed')::int AS oldest
      FROM ncs GROUP BY customer_id
  ),
  ncc AS (
    SELECT n.customer_id, coalesce(sum(c.net_org * c.cost_sign), 0) AS cost, count(*) FILTER (WHERE c.net_org IS NULL)::int AS waiting
      FROM ncs n JOIN public.ncr_costs c ON c.nonconformance_id = n.id AND c.organisation_id = p_org AND c.deleted_at IS NULL
     WHERE n.detected_at BETWEEN p_from AND p_to GROUP BY n.customer_id
  ),
  lot_ship AS (SELECT customer_id, lot_id, sum(qty) AS shipped FROM sl WHERE lot_id IS NOT NULL GROUP BY customer_id, lot_id),
  lot_aff AS (
    SELECT n.customer_id, a.lot_id, sum(a.quantity) AS affected
      FROM ncs n JOIN public.ncr_affected_lots a ON a.nonconformance_id = n.id AND a.organisation_id = p_org AND a.removed_at IS NULL GROUP BY n.customer_id, a.lot_id
  ),
  lotp AS (
    SELECT s.customer_id, coalesce(sum(least(coalesce(a.affected, 0), s.shipped)), 0) AS affected, count(*) FILTER (WHERE a.affected IS NOT NULL)::int AS lots_hit
      FROM lot_ship s LEFT JOIN lot_aff a ON a.customer_id = s.customer_id AND a.lot_id = s.lot_id GROUP BY s.customer_id
  ),
  ret AS (
    SELECT n.customer_id, coalesce(sum(d.quantity), 0) AS units, count(*)::int AS n
      FROM ncs n JOIN public.ncr_dispositions d ON d.nonconformance_id = n.id AND d.organisation_id = p_org
     WHERE d.decision = 'customer_return' AND d.status = 'approved' AND d.approved_at::date BETWEEN p_from AND p_to GROUP BY n.customer_id
  )
  SELECT c.id, jsonb_build_object(
    'customer', jsonb_build_object('id', c.id, 'code', c.code, 'name', c.name),
    'period', jsonb_build_object('from', p_from, 'to', p_to, 'policy', p_policy, 'graceDaysAfter', p_grace_after),
    'shipped', jsonb_build_object('shipments', coalesce(s.shipments, 0), 'lines', coalesce(s.lines, 0), 'units', coalesce(s.units, 0), 'lastShippedOn', s.last_on),
    'delivery', jsonb_build_object('matched', coalesce(o.matched, 0), 'onTime', coalesce(o.on_time, 0), 'late', coalesce(o.matched - o.on_time, 0),
                                   'unmatched', coalesce(s.no_order, 0),
                                   'onTimePct', CASE WHEN coalesce(o.matched, 0) > 0 THEN round(100.0 * o.on_time / o.matched, 1) END,
                                   'openLate', coalesce(ol.n, 0), 'oldestOpenLateDays', ol.oldest, 'lateSources', coalesce(o.late_src, '[]'::jsonb)),
    'inFull', jsonb_build_object('due', coalesce(f.full + f.over + f.short, 0), 'full', coalesce(f.full, 0), 'short', coalesce(f.short, 0), 'over', coalesce(f.over, 0), 'pending', coalesce(f.pending, 0),
                                 'pct', CASE WHEN coalesce(f.full + f.over + f.short, 0) > 0 THEN round(100.0 * f.full / (f.full + f.over + f.short), 1) END),
    'ncs', jsonb_build_object('raised', coalesce(p.raised, 0), 'units', coalesce(p.units, 0),
                              'bySeverity', jsonb_build_object('critical', coalesce(p.critical, 0), 'major', coalesce(p.major, 0), 'minor', coalesce(p.minor, 0), 'unrated', coalesce(p.unrated, 0)),
                              'openNow', coalesce(no_.open_now, 0), 'oldestOpenDays', no_.oldest, 'cost', coalesce(cc.cost, 0), 'costCurrency', v_currency,
                              'costLinesWaitingForRate', coalesce(cc.waiting, 0), 'sources', coalesce(p.src, '[]'::jsonb)),
    'ppm', jsonb_build_object('value', CASE WHEN coalesce(s.units, 0) > 0 THEN round(coalesce(p.units, 0) / s.units * 1000000) END,
                              'affectedUnits', coalesce(p.units, 0), 'shippedUnits', coalesce(s.units, 0)),
    'ppmLot', jsonb_build_object('value', CASE WHEN coalesce(s.traced_units, 0) > 0 THEN round(coalesce(lp.affected, 0) / s.traced_units * 1000000) END,
                                 'affectedUnits', coalesce(lp.affected, 0), 'shippedUnits', coalesce(s.traced_units, 0), 'lotsHit', coalesce(lp.lots_hit, 0),
                                 'coverage', CASE WHEN coalesce(s.units, 0) > 0 THEN round(100.0 * s.traced_units / s.units, 1) END),
    'returns', jsonb_build_object('units', coalesce(r.units, 0), 'dispositions', coalesce(r.n, 0),
                                  'pctOfShipped', CASE WHEN coalesce(s.units, 0) > 0 THEN round(100.0 * coalesce(r.units, 0) / s.units, 2) END),
    'coverage', jsonb_build_object('lines', coalesce(s.lines, 0), 'withoutOrder', coalesce(s.no_order, 0), 'withoutLot', coalesce(s.no_lot, 0))
  )
  FROM cust c
  LEFT JOIN ship s ON s.customer_id = c.id LEFT JOIN otd o ON o.customer_id = c.id LEFT JOIN infull f ON f.customer_id = c.id LEFT JOIN open_late ol ON ol.customer_id = c.id
  LEFT JOIN ncp p ON p.customer_id = c.id LEFT JOIN nco no_ ON no_.customer_id = c.id LEFT JOIN ncc cc ON cc.customer_id = c.id
  LEFT JOIN lotp lp ON lp.customer_id = c.id LEFT JOIN ret r ON r.customer_id = c.id
  ORDER BY c.name, c.code;
END $$;
REVOKE ALL ON FUNCTION app.customer_performance(uuid, date, date, text, integer, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.customer_performance(uuid, date, date, text, integer, uuid) TO authenticated;
