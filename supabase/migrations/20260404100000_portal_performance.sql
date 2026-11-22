-- External portal PT4 (docs/external-portal-plan.md §6, decisions X6, X10, X11): a supplier's people see their own performance — the same figures as the
-- staff Performance tab, from the same database function — as named fields only, in the tiles staff chose, with an optional anonymised ranking band.
--
--  * app.supplier_performance_metrics (replaced, unchanged except its gate): the permission gate is skipped only inside app.portal_get_performance /
--    app.portal_rank_scores, which have checked the caller's own live portal access to that very supplier and set the transaction-local
--    `app.portal_performance` to its id. Everything else about the figures is untouched, so the portal and the Performance tab cannot disagree.
--  * app.portal_get_performance(org, party, days): curated output only — no record references, no warnings text with internal links, no other supplier,
--    no scoring weights. A tile staff switched off (portal_parties.tiles) is left out by the database, not hidden by the screen.
--  * app.portal_rank_band: the band is a quarter of the suppliers scored, never a name or a number, and only with at least five scored suppliers and
--    only while the organisation has switched ranking on.
--  * The trend is the monthly scorecards the organisation already saves (period_kind = 'monthly'); the portal never scores a period of its own.

CREATE OR REPLACE FUNCTION app.supplier_performance_metrics(p_supplier uuid, p_from date, p_to date, p_config jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  s public.suppliers%ROWTYPE; v_policy text := coalesce(p_config ->> 'otd_policy', 'agreed');
  v_before integer := (p_config ->> 'grace_days_before')::int; v_after integer := coalesce((p_config ->> 'grace_days_after')::int, 0);
  v_under numeric := coalesce((p_config ->> 'in_full_under_pct')::numeric, 0); v_over numeric := coalesce((p_config ->> 'in_full_over_pct')::numeric, 10);
  v_lines integer; v_units numeric; v_rej_lines integer; v_rej_units numeric; v_rej_src jsonb; v_nc_lines integer; v_nc_units numeric; v_nc_src jsonb;
  v_matched integer; v_on_time integer; v_early integer; v_late_src jsonb; v_open_late integer; v_open_late_src jsonb;
  v_if_lines integer; v_if_ok integer; v_if_short integer; v_if_over integer; v_if_pending integer; v_otif integer; v_if_src jsonb;
  v_portal boolean; v_nc jsonb; v_scar jsonb; v_cert jsonb; v_rows jsonb;
  v_incl boolean := coalesce((p_config ->> 'ppm_nc_include_unlinked')::boolean, false); v_un_ncs integer; v_un_units numeric; v_un_noqty integer; v_un_src jsonb;
BEGIN
  SELECT * INTO s FROM public.suppliers WHERE id = p_supplier;
  v_portal := coalesce(current_setting('app.portal_performance', true), '') = p_supplier::text;
  IF NOT FOUND THEN RAISE EXCEPTION 'Supplier not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT v_portal THEN
    IF NOT app.is_member(s.organisation_id) THEN RAISE EXCEPTION 'Supplier not found' USING ERRCODE = 'P0002'; END IF;
    IF NOT (app.has_permission(s.organisation_id, 'supplier_quality.read') AND app.has_permission(s.organisation_id, 'receiving.read')) THEN
      RAISE EXCEPTION 'You are not allowed to see supplier performance' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN RAISE EXCEPTION 'The period must start on or before it ends' USING ERRCODE = 'QM020'; END IF;
  IF v_policy NOT IN ('agreed', 'original') THEN RAISE EXCEPTION 'Unknown on-time date policy' USING ERRCODE = 'QM020'; END IF;

  -- Deliveries: received lines of the period (cancelled receipts left out), each with its latest decision and the units on live non-conformances linked to it.
  SELECT coalesce(jsonb_agg(jsonb_build_object('receipt_id', g.id, 'reference', g.reference, 'line_number', x.line_number, 'qty', x.quantity_received, 'decision', d.decision,
                                               'rej_qty', CASE WHEN d.decision = 'rejected' THEN coalesce(d.quantity_rejected, x.quantity_received) END, 'nc_qty', nc.q,
                                               'received_on', g.received_on, 'po_line', x.po_line_id)), '[]'::jsonb) INTO v_rows
    FROM public.goods_receipt_lines x JOIN public.goods_receipts g ON g.id = x.goods_receipt_id
    LEFT JOIN LATERAL (SELECT r.decision, r.quantity_rejected FROM public.receipt_line_dispositions r WHERE r.receipt_line_id = x.id ORDER BY r.decided_at DESC, r.id DESC LIMIT 1) d ON true
    LEFT JOIN LATERAL (SELECT CASE WHEN count(n.id) > 0 THEN least(x.quantity_received, sum(coalesce(n.quantity_affected, x.quantity_received))) END AS q
                       FROM public.receipt_line_ncrs rn JOIN public.nonconformances n ON n.id = rn.ncr_id
                       WHERE rn.receipt_line_id = x.id AND rn.ended_at IS NULL AND n.deleted_at IS NULL AND n.stage <> 'cancelled') nc ON true
    WHERE g.supplier_id = p_supplier AND g.organisation_id = s.organisation_id AND g.status = 'received' AND g.received_on BETWEEN p_from AND p_to;
  SELECT count(*), coalesce(sum(qty), 0), count(*) FILTER (WHERE decision = 'rejected'), coalesce(sum(rej_qty), 0), count(*) FILTER (WHERE nc_qty > 0), coalesce(sum(nc_qty), 0)
    INTO v_lines, v_units, v_rej_lines, v_rej_units, v_nc_lines, v_nc_units FROM jsonb_to_recordset(v_rows) AS _l(receipt_id uuid, reference text, line_number integer, qty numeric, decision text, rej_qty numeric, nc_qty numeric, received_on date, po_line uuid);
  SELECT coalesce(jsonb_agg(jsonb_build_object('receiptId', receipt_id, 'reference', reference, 'lineNumber', line_number, 'units', rej_qty)), '[]'::jsonb) INTO v_rej_src
    FROM (SELECT * FROM jsonb_to_recordset(v_rows) AS _l(receipt_id uuid, reference text, line_number integer, qty numeric, decision text, rej_qty numeric, nc_qty numeric, received_on date, po_line uuid) WHERE decision = 'rejected' ORDER BY received_on DESC, reference LIMIT 10) q;
  SELECT coalesce(jsonb_agg(jsonb_build_object('receiptId', receipt_id, 'reference', reference, 'lineNumber', line_number, 'units', nc_qty)), '[]'::jsonb) INTO v_nc_src
    FROM (SELECT * FROM jsonb_to_recordset(v_rows) AS _l(receipt_id uuid, reference text, line_number integer, qty numeric, decision text, rej_qty numeric, nc_qty numeric, received_on date, po_line uuid) WHERE nc_qty > 0 ORDER BY received_on DESC, reference LIMIT 10) q;

  -- Non-conformances that name the supplier but are linked to no received line: their pieces cannot be matched to a delivery, so they are counted only when the model says so.
  SELECT count(*), coalesce(sum(q.quantity_affected), 0), count(*) FILTER (WHERE q.quantity_affected IS NULL),
         coalesce(jsonb_agg(jsonb_build_object('ncrId', q.id, 'reference', q.reference, 'units', q.quantity_affected) ORDER BY q.detected_at DESC) FILTER (WHERE q.rn <= 10), '[]'::jsonb)
    INTO v_un_ncs, v_un_units, v_un_noqty, v_un_src
    FROM (SELECT n.id, n.reference, n.quantity_affected, n.detected_at, row_number() OVER (ORDER BY n.detected_at DESC) AS rn
          FROM public.nonconformances n
          WHERE n.supplier_id = p_supplier AND n.organisation_id = s.organisation_id AND n.deleted_at IS NULL AND n.stage <> 'cancelled' AND n.detected_at BETWEEN p_from AND p_to
            AND NOT EXISTS (SELECT 1 FROM public.receipt_line_ncrs rn2 WHERE rn2.ncr_id = n.id AND rn2.ended_at IS NULL)) q;

  -- On-time delivery: lines against an order line. On time = received no more than the days-early allowance before the due date (no limit when it is not set) and no more than the days-late allowance after it; the due date follows the policy.
  SELECT count(*), count(*) FILTER (WHERE (v_before IS NULL OR l.received_on >= due.d - v_before) AND l.received_on <= due.d + v_after), count(*) FILTER (WHERE v_before IS NOT NULL AND l.received_on < due.d - v_before) INTO v_matched, v_on_time, v_early
    FROM jsonb_to_recordset(v_rows) AS l(receipt_id uuid, reference text, line_number integer, qty numeric, decision text, rej_qty numeric, nc_qty numeric, received_on date, po_line uuid) JOIN public.purchase_order_lines pl ON pl.id = l.po_line
    CROSS JOIN LATERAL (SELECT CASE WHEN v_policy = 'original' THEN pl.requested_on ELSE coalesce(pl.agreed_on, pl.requested_on) END AS d) due;
  SELECT coalesce(jsonb_agg(jsonb_build_object('receiptId', receipt_id, 'reference', reference, 'lineNumber', line_number, 'daysLate', late)), '[]'::jsonb) INTO v_late_src
    FROM (SELECT l.receipt_id, l.reference, l.line_number, (l.received_on - due.d) AS late
          FROM jsonb_to_recordset(v_rows) AS l(receipt_id uuid, reference text, line_number integer, qty numeric, decision text, rej_qty numeric, nc_qty numeric, received_on date, po_line uuid) JOIN public.purchase_order_lines pl ON pl.id = l.po_line
          CROSS JOIN LATERAL (SELECT CASE WHEN v_policy = 'original' THEN pl.requested_on ELSE coalesce(pl.agreed_on, pl.requested_on) END AS d) due
          WHERE l.received_on > due.d + v_after ORDER BY late DESC LIMIT 10) q;
  -- Open order lines already past their due date and grace (as of today).
  SELECT count(*), coalesce(jsonb_agg(jsonb_build_object('purchaseOrderId', poid, 'poNumber', ponum, 'lineNumber', ln, 'daysLate', late) ORDER BY late DESC) FILTER (WHERE rn <= 10), '[]'::jsonb)
    INTO v_open_late, v_open_late_src
    FROM (SELECT o.id AS poid, o.po_number AS ponum, pl.line_number AS ln, (current_date - due.d) AS late, row_number() OVER (ORDER BY (current_date - due.d) DESC) AS rn
          FROM public.purchase_order_lines pl JOIN public.purchase_orders o ON o.id = pl.purchase_order_id
          CROSS JOIN LATERAL (SELECT CASE WHEN v_policy = 'original' THEN pl.requested_on ELSE coalesce(pl.agreed_on, pl.requested_on) END AS d) due
          WHERE o.supplier_id = p_supplier AND o.organisation_id = s.organisation_id AND o.status = 'open' AND pl.status = 'open'
            AND due.d + v_after < current_date
            AND pl.quantity_ordered > coalesce((SELECT sum(rl.quantity_received) FROM public.goods_receipt_lines rl JOIN public.goods_receipts g2 ON g2.id = rl.goods_receipt_id
                                                WHERE rl.po_line_id = pl.id AND g2.status = 'received'), 0)) q;

  -- In full and OTIF: order lines whose due date falls in the period. What arrived by the due date plus the days late allowed is compared with the ordered quantity, within the tolerances.
  -- A line that is short but can still arrive (its allowance has not run out and it is open) is "pending" and left out.
  SELECT count(*), count(*) FILTER (WHERE NOT is_short AND NOT is_over), count(*) FILTER (WHERE is_short AND NOT pending), count(*) FILTER (WHERE is_over), count(*) FILTER (WHERE pending),
         count(*) FILTER (WHERE NOT is_short AND NOT is_over AND in_window),
         coalesce(jsonb_agg(jsonb_build_object('purchaseOrderId', poid, 'poNumber', ponum, 'lineNumber', ln, 'ordered', ordered, 'received', got, 'kind', CASE WHEN is_over THEN 'over' ELSE 'short' END) ORDER BY ordered - got DESC)
                  FILTER (WHERE (is_short AND NOT pending) OR is_over), '[]'::jsonb)
    INTO v_if_lines, v_if_ok, v_if_short, v_if_over, v_if_pending, v_otif, v_if_src
    FROM (SELECT o.id AS poid, o.po_number AS ponum, pl.line_number AS ln, pl.quantity_ordered AS ordered, rc.q AS got, rc.in_window,
                 rc.q < pl.quantity_ordered * (1 - v_under / 100) AS is_short, rc.q > pl.quantity_ordered * (1 + v_over / 100) AS is_over,
                 (rc.q < pl.quantity_ordered * (1 - v_under / 100) AND pl.status = 'open' AND o.status = 'open' AND due.d + v_after >= current_date) AS pending
          FROM public.purchase_order_lines pl JOIN public.purchase_orders o ON o.id = pl.purchase_order_id
          CROSS JOIN LATERAL (SELECT CASE WHEN v_policy = 'original' THEN pl.requested_on ELSE coalesce(pl.agreed_on, pl.requested_on) END AS d) due
          CROSS JOIN LATERAL (SELECT coalesce(sum(rl.quantity_received), 0) AS q, coalesce(bool_and(v_before IS NULL OR g.received_on >= due.d - v_before), true) AS in_window
                              FROM public.goods_receipt_lines rl JOIN public.goods_receipts g ON g.id = rl.goods_receipt_id
                              WHERE rl.po_line_id = pl.id AND g.status = 'received' AND g.received_on <= due.d + v_after) rc
          WHERE o.supplier_id = p_supplier AND o.organisation_id = s.organisation_id AND o.status <> 'cancelled' AND pl.status <> 'cancelled' AND due.d BETWEEN p_from AND p_to) q;

  -- Non-conformances naming the supplier, detected in the period.
  SELECT jsonb_build_object(
      'total', count(*), 'critical', count(*) FILTER (WHERE severity = 'critical'), 'major', count(*) FILTER (WHERE severity = 'major'), 'minor', count(*) FILTER (WHERE severity = 'minor'),
      'unclassified', count(*) FILTER (WHERE severity IS NULL),
      'repeat', count(*) FILTER (WHERE part_id IS NOT NULL AND part_count >= 2),
      'sources', coalesce(jsonb_agg(jsonb_build_object('id', id, 'reference', reference, 'severity', severity, 'stage', stage) ORDER BY rn) FILTER (WHERE rn <= 10), '[]'::jsonb))
    INTO v_nc
    FROM (SELECT id, reference, severity, stage, detected_at, part_id,
                 count(*) OVER (PARTITION BY part_id) AS part_count,
                 row_number() OVER (ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'major' THEN 2 WHEN 'minor' THEN 3 ELSE 4 END, detected_at DESC) AS rn
          FROM public.nonconformances
          WHERE supplier_id = p_supplier AND organisation_id = s.organisation_id AND deleted_at IS NULL AND stage <> 'cancelled' AND detected_at BETWEEN p_from AND p_to) n;
  IF v_nc IS NULL OR v_nc -> 'sources' IS NULL THEN
    v_nc := jsonb_build_object('total', 0, 'critical', 0, 'major', 0, 'minor', 0, 'unclassified', 0, 'repeat', 0, 'sources', '[]'::jsonb);
  END IF;

  -- SCARs issued in the period: first response by the original due date.
  SELECT jsonb_build_object('issued', count(*), 'answered_on_time', count(*) FILTER (WHERE first_resp IS NOT NULL AND first_resp <= due),
      'answered_late', count(*) FILTER (WHERE first_resp IS NOT NULL AND first_resp > due),
      'overdue_now', count(*) FILTER (WHERE first_resp IS NULL AND due < current_date AND status NOT IN ('closed', 'cancelled')),
      'sources', coalesce(jsonb_agg(jsonb_build_object('id', id, 'reference', reference, 'status', status, 'dueOn', due)) FILTER (WHERE (first_resp IS NULL AND due < current_date AND status NOT IN ('closed', 'cancelled')) OR first_resp > due), '[]'::jsonb))
    INTO v_scar
    FROM (SELECT sc.id, sc.reference, sc.status, coalesce(sc.original_response_due_on, sc.response_due_on) AS due,
                 (SELECT min(r.received_at)::date FROM public.supplier_scar_responses r WHERE r.scar_id = sc.id) AS first_resp
          FROM public.supplier_scars sc
          WHERE sc.supplier_id = p_supplier AND sc.organisation_id = s.organisation_id AND sc.status NOT IN ('draft', 'cancelled') AND sc.issued_at::date BETWEEN p_from AND p_to) q;

  -- Certifications (current ones, as at today).
  SELECT jsonb_build_object('current', count(*), 'expired', count(*) FILTER (WHERE expires_on < current_date),
      'expiring_soon', count(*) FILTER (WHERE expires_on >= current_date AND expires_on <= current_date + 60),
      'sources', coalesce(jsonb_agg(jsonb_build_object('id', id, 'number', certificate_number, 'type', cert_type, 'expiresOn', expires_on)) FILTER (WHERE expires_on < current_date), '[]'::jsonb))
    INTO v_cert
    FROM public.supplier_certifications WHERE supplier_id = p_supplier AND organisation_id = s.organisation_id AND status = 'current';

  RETURN jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to),
    'deliveries', jsonb_build_object('lines', v_lines, 'unitsReceived', v_units),
    'ppm', jsonb_build_object('basis', 'rejected', 'value', CASE WHEN v_units > 0 THEN round(v_rej_units / v_units * 1000000, 0) END, 'rejectedUnits', v_rej_units, 'receivedUnits', v_units, 'sources', v_rej_src),
    'ppmNc', jsonb_build_object('basis', 'ncs', 'includeUnlinked', v_incl,
      'value', CASE WHEN v_units > 0 THEN round((v_nc_units + CASE WHEN v_incl THEN v_un_units ELSE 0 END) / v_units * 1000000, 0) END,
      'affectedUnits', v_nc_units + CASE WHEN v_incl THEN v_un_units ELSE 0 END, 'linkedUnits', v_nc_units, 'unlinkedUnits', v_un_units, 'unlinkedNcs', v_un_ncs, 'unlinkedWithoutQuantity', v_un_noqty,
      'receivedUnits', v_units, 'lines', v_nc_lines, 'sources', v_nc_src || CASE WHEN v_incl THEN v_un_src ELSE '[]'::jsonb END, 'unlinkedSources', v_un_src),
    'lotRejection', jsonb_build_object('rate', CASE WHEN v_lines > 0 THEN round(v_rej_lines::numeric / v_lines, 4) END, 'rejectedLines', v_rej_lines, 'lines', v_lines),
    'otd', jsonb_build_object('policy', v_policy, 'graceBefore', v_before, 'graceAfter', v_after, 'value', CASE WHEN v_matched > 0 THEN round(v_on_time::numeric / v_matched, 4) END,
      'matchedLines', v_matched, 'onTime', v_on_time, 'late', v_matched - v_on_time - v_early, 'early', v_early,
      'unmatchedLines', v_lines - v_matched, 'openLateLines', v_open_late, 'sources', v_late_src, 'openLateSources', v_open_late_src),
    'inFull', jsonb_build_object('underPct', v_under, 'overPct', v_over, 'lines', v_if_lines, 'inFull', v_if_ok, 'short', v_if_short, 'over', v_if_over, 'pending', v_if_pending,
      'value', CASE WHEN v_if_lines - v_if_pending > 0 THEN round(v_if_ok::numeric / (v_if_lines - v_if_pending), 4) END, 'sources', v_if_src),
    'otif', jsonb_build_object('lines', v_if_lines - v_if_pending, 'otif', v_otif, 'value', CASE WHEN v_if_lines - v_if_pending > 0 THEN round(v_otif::numeric / (v_if_lines - v_if_pending), 4) END),
    'ncs', v_nc, 'scars', v_scar, 'certs', v_cert);
END $$;
CREATE OR REPLACE FUNCTION app.supplier_effective_config(p_supplier uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.suppliers%ROWTYPE; mdl public.supplier_scorecard_models%ROWTYPE; o public.supplier_performance_settings%ROWTYPE; v_over jsonb;
BEGIN
  SELECT * INTO s FROM public.suppliers WHERE id = p_supplier;
  IF NOT FOUND OR NOT (app.is_member(s.organisation_id) OR coalesce(current_setting('app.portal_performance', true), '') = p_supplier::text) THEN RAISE EXCEPTION 'Supplier not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO mdl FROM public.supplier_scorecard_models WHERE organisation_id = s.organisation_id ORDER BY version DESC LIMIT 1;
  SELECT * INTO o FROM public.supplier_performance_settings WHERE supplier_id = s.id;
  v_over := jsonb_strip_nulls(jsonb_build_object('otd_policy', o.otd_policy, 'grace_days_before', o.grace_days_before, 'grace_days_after', o.grace_days_after,
                                                 'in_full_under_pct', o.in_full_under_pct, 'in_full_over_pct', o.in_full_over_pct));
  RETURN jsonb_build_object('modelId', mdl.id, 'version', mdl.version, 'modelConfig', mdl.config, 'overrides', v_over, 'config', mdl.config || v_over);
END $$;

-- ---------------------------------------------------------------------------
-- The band: where a supplier stands among the ones scored, in quarters.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.portal_rank_band(p_mine numeric, p_scores numeric[]) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE n integer := coalesce(array_length(p_scores, 1), 0); better integer; f numeric;
BEGIN
  IF p_mine IS NULL OR n < 5 THEN RETURN NULL; END IF;
  SELECT count(*) INTO better FROM unnest(p_scores) s WHERE s > p_mine;
  f := better::numeric / n;
  RETURN CASE WHEN f < 0.25 THEN 'top_quarter' WHEN f < 0.5 THEN 'upper_half' WHEN f < 0.75 THEN 'lower_half' ELSE 'bottom_quarter' END;
END $$;
REVOKE ALL ON FUNCTION app.portal_rank_band(numeric, numeric[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_rank_band(numeric, numeric[]) TO authenticated;

-- ---------------------------------------------------------------------------
-- A supplier party's own performance. p_party names which of their parties (a person may act for several in one organisation).
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.portal_get_performance(p_organisation_id uuid, p_party uuid, p_days integer DEFAULT 90) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  a record; v_tiles jsonb; v_ranking boolean; v_from date; v_to date := current_date; r jsonb; m jsonb; v_out jsonb := '{}'::jsonb; t jsonb;
  v_mine numeric; v_scores numeric[] := '{}'; s record; x jsonb; v_awaiting integer; v_scored integer;
BEGIN
  SELECT * INTO a FROM app.portal_my_access(p_organisation_id) WHERE party_id = p_party AND party_kind = 'supplier' AND supplier_id IS NOT NULL LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'Supplier not found' USING ERRCODE = 'no_data_found'; END IF;
  IF p_days IS NULL OR p_days NOT IN (30, 90, 365) THEN RAISE EXCEPTION 'Choose 30, 90 or 365 days' USING ERRCODE = 'QM032'; END IF;
  v_from := v_to - (p_days - 1);
  SELECT coalesce(pp.tiles, '{}'::jsonb) INTO v_tiles FROM public.portal_parties pp WHERE pp.id = p_party;
  SELECT s2.portal_ranking_enabled INTO v_ranking FROM public.organisation_settings s2 WHERE s2.organisation_id = p_organisation_id;
  -- A tile is on unless staff switched it off.
  t := jsonb_build_object(
    'score', coalesce((v_tiles ->> 'score')::boolean, true), 'delivery', coalesce((v_tiles ->> 'delivery')::boolean, true),
    'quality', coalesce((v_tiles ->> 'quality')::boolean, true), 'ncs', coalesce((v_tiles ->> 'ncs')::boolean, true),
    'scars', coalesce((v_tiles ->> 'scars')::boolean, true), 'certs', coalesce((v_tiles ->> 'certs')::boolean, true),
    'trend', coalesce((v_tiles ->> 'trend')::boolean, true), 'ranking', coalesce(v_ranking, false) AND coalesce((v_tiles ->> 'ranking')::boolean, true));

  PERFORM set_config('app.portal_performance', a.supplier_id::text, true);
  r := app.supplier_performance(a.supplier_id, v_from, v_to);
  PERFORM set_config('app.portal_performance', '', true);
  m := r -> 'metrics';
  v_mine := (r ->> 'score')::numeric;

  v_out := jsonb_build_object('period', jsonb_build_object('from', v_from, 'to', v_to, 'days', p_days), 'tiles', t);
  IF (t ->> 'score')::boolean THEN
    v_out := v_out || jsonb_build_object('score', jsonb_build_object('value', v_mine, 'band', r ->> 'band'));
  END IF;
  IF (t ->> 'delivery')::boolean THEN
    v_out := v_out || jsonb_build_object('delivery', jsonb_build_object(
      'onTime', jsonb_build_object('value', m -> 'otd' -> 'value', 'lines', m -> 'otd' -> 'matchedLines', 'onTime', m -> 'otd' -> 'onTime', 'late', m -> 'otd' -> 'late', 'early', m -> 'otd' -> 'early'),
      'inFull', jsonb_build_object('value', m -> 'inFull' -> 'value', 'lines', (m -> 'inFull' ->> 'lines')::int - (m -> 'inFull' ->> 'pending')::int, 'inFull', m -> 'inFull' -> 'inFull', 'short', m -> 'inFull' -> 'short', 'over', m -> 'inFull' -> 'over'),
      'otif', jsonb_build_object('value', m -> 'otif' -> 'value')));
  END IF;
  IF (t ->> 'quality')::boolean THEN
    v_out := v_out || jsonb_build_object('quality', jsonb_build_object(
      'ppm', jsonb_build_object('value', m -> 'ppm' -> 'value', 'rejectedUnits', m -> 'ppm' -> 'rejectedUnits', 'receivedUnits', m -> 'ppm' -> 'receivedUnits'),
      'ppmNc', jsonb_build_object('value', m -> 'ppmNc' -> 'value', 'affectedUnits', m -> 'ppmNc' -> 'affectedUnits', 'receivedUnits', m -> 'ppmNc' -> 'receivedUnits'),
      'lotRejection', jsonb_build_object('rate', m -> 'lotRejection' -> 'rate', 'rejectedLines', m -> 'lotRejection' -> 'rejectedLines', 'lines', m -> 'lotRejection' -> 'lines')));
  END IF;
  IF (t ->> 'ncs')::boolean THEN
    v_out := v_out || jsonb_build_object('ncs', jsonb_build_object('total', m -> 'ncs' -> 'total', 'critical', m -> 'ncs' -> 'critical', 'major', m -> 'ncs' -> 'major',
      'minor', m -> 'ncs' -> 'minor', 'repeat', m -> 'ncs' -> 'repeat'));
  END IF;
  IF (t ->> 'scars')::boolean THEN
    SELECT count(*)::int INTO v_awaiting FROM public.supplier_scars c
     WHERE c.organisation_id = p_organisation_id AND c.supplier_id = a.supplier_id AND c.issued_at IS NOT NULL AND c.status IN ('issued', 'acknowledged', 'revision_requested');
    v_out := v_out || jsonb_build_object('scars', jsonb_build_object('issued', m -> 'scars' -> 'issued', 'answeredOnTime', m -> 'scars' -> 'answered_on_time',
      'answeredLate', m -> 'scars' -> 'answered_late', 'overdueNow', m -> 'scars' -> 'overdue_now', 'awaitingYou', v_awaiting));
  END IF;
  IF (t ->> 'certs')::boolean THEN
    v_out := v_out || jsonb_build_object('certs', jsonb_build_object('current', m -> 'certs' -> 'current', 'expired', m -> 'certs' -> 'expired', 'expiringSoon', m -> 'certs' -> 'expiring_soon'));
  END IF;
  IF (t ->> 'trend')::boolean THEN
    v_out := v_out || jsonb_build_object('trend', (SELECT coalesce(jsonb_agg(jsonb_build_object('from', q.period_from, 'to', q.period_to, 'score', q.score, 'band', q.band) ORDER BY q.period_to), '[]'::jsonb)
      FROM (SELECT c.period_from, c.period_to, c.score, c.band FROM public.supplier_scorecards c
             WHERE c.organisation_id = p_organisation_id AND c.supplier_id = a.supplier_id AND c.period_kind = 'monthly' ORDER BY c.period_to DESC LIMIT 12) q));
  END IF;
  IF (t ->> 'ranking')::boolean THEN
    -- Everyone in use is scored over the same period, as the watchlist does; only the quarter this supplier falls in leaves the function.
    FOR s IN SELECT id FROM public.suppliers WHERE organisation_id = p_organisation_id AND active AND approval_status NOT IN ('archived', 'disqualified') ORDER BY code LIMIT 300 LOOP
      PERFORM set_config('app.portal_performance', s.id::text, true);
      x := app.supplier_performance(s.id, v_from, v_to);
      IF (x ->> 'score') IS NOT NULL THEN v_scores := v_scores || (x ->> 'score')::numeric; END IF;
    END LOOP;
    PERFORM set_config('app.portal_performance', '', true);
    v_scored := coalesce(array_length(v_scores, 1), 0);
    v_out := v_out || jsonb_build_object('ranking', jsonb_build_object('band', CASE WHEN v_mine IS NULL THEN NULL ELSE app.portal_rank_band(v_mine, v_scores) END,
      'enough', v_scored >= 5));
  END IF;
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION app.portal_get_performance(uuid, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_get_performance(uuid, uuid, integer) TO authenticated;
