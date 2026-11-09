-- Supplier performance settings (docs/supplier-quality-plan.md, SQ5 follow-up).
--  * Both PPM measures are worked out and kept apart: "rejected at receiving" (units on lines whose latest decision is rejected, now with an optional QUANTITY on a rejection so a part-rejected
--    line no longer counts whole) and "from non-conformances" (units on NCs linked to a received line, counted once per line and capped at what was received). The model says which one scores
--    (`ppm_basis` = rejected | ncs); the other is still shown.
--  * On-time delivery gets grace days: `grace_days_before` (days early that still count) and `grace_days_after` (days late that still count).
--  * In full: an order line is in full when what arrived by its due date (plus the grace days after) is within `in_full_under_pct` below and `in_full_over_pct` above the ordered quantity;
--    OTIF = in full and nothing arrived earlier than the grace allows. In full can be given a weight (`weights.in_full`, default 0 = shown, not scored).
--  * Per-supplier overrides (`supplier_performance_settings`): date policy, both grace values and the two in-full tolerances; empty = follow the organisation's model. A saved scorecard freezes
--    the EFFECTIVE configuration it was scored with. Written only by app.set_supplier_performance_settings (supplier_quality.configure).
--  Older model versions have none of the new keys and behave as before (no grace, rejected basis, in full not scored).

ALTER TABLE public.receipt_line_dispositions
  ADD COLUMN quantity_rejected numeric(14, 3) CHECK (quantity_rejected IS NULL OR quantity_rejected > 0),
  ADD CONSTRAINT receipt_line_dispositions_quantity CHECK (quantity_rejected IS NULL OR decision = 'rejected');

CREATE TABLE public.supplier_performance_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  supplier_id uuid NOT NULL,
  otd_policy text CHECK (otd_policy IS NULL OR otd_policy IN ('agreed', 'original')),
  grace_days_before integer CHECK (grace_days_before IS NULL OR grace_days_before BETWEEN 0 AND 60),
  grace_days_after integer CHECK (grace_days_after IS NULL OR grace_days_after BETWEEN 0 AND 60),
  in_full_under_pct numeric(5, 2) CHECK (in_full_under_pct IS NULL OR in_full_under_pct BETWEEN 0 AND 100),
  in_full_over_pct numeric(5, 2) CHECK (in_full_over_pct IS NULL OR in_full_over_pct BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT supplier_performance_settings_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT supplier_performance_settings_supplier_key UNIQUE (supplier_id),
  CONSTRAINT supplier_performance_settings_supplier_fkey FOREIGN KEY (supplier_id, organisation_id) REFERENCES public.suppliers (id, organisation_id)
);
CREATE TRIGGER supplier_performance_settings_stamp BEFORE INSERT ON public.supplier_performance_settings FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.supplier_performance_settings FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.supplier_performance_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.supplier_performance_settings FROM anon, authenticated;
GRANT SELECT ON public.supplier_performance_settings TO authenticated;
CREATE POLICY supplier_performance_settings_select ON public.supplier_performance_settings FOR SELECT TO authenticated USING (app.has_permission(organisation_id, 'supplier_quality.read'));

-- What a valid configuration is (the new keys are optional so older versions stay valid)
CREATE OR REPLACE FUNCTION app.scorecard_config_problem(c jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE k text; w numeric; total numeric := 0;
BEGIN
  IF jsonb_typeof(c) <> 'object' THEN RETURN 'The configuration must be an object'; END IF;
  IF c ->> 'otd_policy' IS NULL OR c ->> 'otd_policy' NOT IN ('agreed', 'original') THEN RETURN 'The on-time date policy is "agreed" or "original"'; END IF;
  IF jsonb_typeof(c -> 'weights') <> 'object' THEN RETURN 'Give the metric weights'; END IF;
  FOREACH k IN ARRAY ARRAY['otd', 'ppm', 'ncs', 'scar', 'certs'] LOOP
    IF coalesce(c -> 'weights' ->> k, '') !~ '^[0-9]+$' OR (c -> 'weights' ->> k)::int > 100 THEN RETURN 'Each weight (otd, ppm, ncs, scar, certs) is a whole number from 0 to 100'; END IF;
    total := total + (c -> 'weights' ->> k)::int;
  END LOOP;
  IF c -> 'weights' ? 'in_full' THEN
    IF coalesce(c -> 'weights' ->> 'in_full', '') !~ '^[0-9]+$' OR (c -> 'weights' ->> 'in_full')::int > 100 THEN RETURN 'The in-full weight is a whole number from 0 to 100'; END IF;
    total := total + (c -> 'weights' ->> 'in_full')::int;
  END IF;
  IF total <= 0 THEN RETURN 'At least one metric needs a weight above zero'; END IF;
  IF coalesce(c ->> 'ppm_good', '') !~ '^[0-9.]+$' OR coalesce(c ->> 'ppm_zero', '') !~ '^[0-9.]+$' THEN RETURN 'Give the PPM targets (ppm_good and ppm_zero)'; END IF;
  IF (c ->> 'ppm_zero')::numeric <= (c ->> 'ppm_good')::numeric OR (c ->> 'ppm_zero')::numeric > 1000000 THEN RETURN 'The PPM that scores zero must be above the PPM that scores 100, and at most 1,000,000'; END IF;
  IF jsonb_typeof(c -> 'nc_penalty') <> 'object' THEN RETURN 'Give the points taken off per non-conformance by severity'; END IF;
  FOREACH k IN ARRAY ARRAY['critical', 'major', 'minor'] LOOP
    IF coalesce(c -> 'nc_penalty' ->> k, '') !~ '^[0-9]+$' OR (c -> 'nc_penalty' ->> k)::int > 100 THEN RETURN 'Each non-conformance penalty (critical, major, minor) is a whole number from 0 to 100'; END IF;
  END LOOP;
  IF coalesce(c ->> 'good_from', '') !~ '^[0-9.]+$' OR coalesce(c ->> 'watch_from', '') !~ '^[0-9.]+$' THEN RETURN 'Give the band thresholds good_from and watch_from'; END IF;
  w := (c ->> 'watch_from')::numeric;
  IF NOT (w > 0 AND w < (c ->> 'good_from')::numeric AND (c ->> 'good_from')::numeric <= 100) THEN RETURN 'The bands must rise: above 0, watch below good, and no more than 100'; END IF;
  IF coalesce(c ->> 'min_lines', '') !~ '^[0-9]+$' OR (c ->> 'min_lines')::int NOT BETWEEN 1 AND 100 THEN RETURN 'The minimum number of delivered lines is a whole number from 1 to 100'; END IF;
  IF c ? 'ppm_basis' AND coalesce(c ->> 'ppm_basis', '') NOT IN ('rejected', 'ncs') THEN RETURN 'PPM is measured from "rejected" units or from "ncs" (non-conformances)'; END IF;
  FOREACH k IN ARRAY ARRAY['grace_days_before', 'grace_days_after'] LOOP
    IF c ->> k IS NOT NULL AND (c ->> k !~ '^[0-9]+$' OR (c ->> k)::int > 60) THEN RETURN 'The grace days are whole numbers from 0 to 60 (days early may also be left empty for no limit)'; END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['in_full_under_pct', 'in_full_over_pct'] LOOP
    IF c ->> k IS NOT NULL AND (c ->> k !~ '^[0-9]+(\.[0-9]{1,2})?$' OR (c ->> k)::numeric > 100) THEN RETURN 'The in-full tolerances are percentages from 0 to 100'; END IF;
  END LOOP;
  RETURN NULL;
END $$;

-- New organisations start with the new keys spelled out (in full is shown but not scored until it is given a weight)
CREATE OR REPLACE FUNCTION app.seed_supplier_scorecard_model(p_organisation_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO public.supplier_scorecard_models (organisation_id, version, config, reason)
  SELECT p_organisation_id, 1,
    jsonb_build_object('otd_policy', 'agreed', 'ppm_basis', 'rejected', 'grace_days_after', 0, 'in_full_under_pct', 0, 'in_full_over_pct', 10,
      'weights', jsonb_build_object('otd', 30, 'in_full', 0, 'ppm', 30, 'ncs', 20, 'scar', 10, 'certs', 10),
      'ppm_good', 1000, 'ppm_zero', 50000, 'nc_penalty', jsonb_build_object('critical', 40, 'major', 20, 'minor', 5),
      'good_from', 85, 'watch_from', 70, 'min_lines', 5), 'Default model'
  WHERE NOT EXISTS (SELECT 1 FROM public.supplier_scorecard_models WHERE organisation_id = p_organisation_id)
$$;

-- A rejection can say how many pieces were rejected (the rest of the line is not counted as rejected)
DROP FUNCTION app.disposition_receipt_line(uuid, text, text, text);
CREATE FUNCTION app.disposition_receipt_line(p_line uuid, p_decision text, p_reason text, p_conditions text, p_quantity numeric DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE x public.goods_receipt_lines%ROWTYPE; g public.goods_receipts%ROWTYPE; v_current text; v_assess jsonb; v_id uuid; v_reason text := nullif(btrim(coalesce(p_reason, '')), ''); v_cond text := nullif(btrim(coalesce(p_conditions, '')), '');
        lt public.lots%ROWTYPE;
BEGIN
  SELECT * INTO x FROM public.goods_receipt_lines WHERE id = p_line;
  IF NOT FOUND OR NOT app.is_member(x.organisation_id) THEN RAISE EXCEPTION 'Receipt line not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(x.organisation_id, 'receiving.manage') THEN RAISE EXCEPTION 'You are not allowed to decide what happens to received goods' USING ERRCODE = '42501'; END IF;
  SELECT * INTO g FROM public.goods_receipts WHERE id = x.goods_receipt_id FOR UPDATE;
  IF g.status <> 'received' THEN RAISE EXCEPTION 'That receipt is cancelled' USING ERRCODE = 'QM021'; END IF;
  IF p_decision NOT IN ('held', 'accepted', 'rejected', 'conditional') THEN RAISE EXCEPTION 'Decide held, accepted, rejected or conditional' USING ERRCODE = 'QM021'; END IF;
  IF p_decision <> 'accepted' AND (v_reason IS NULL OR length(v_reason) < 3) THEN RAISE EXCEPTION 'Say why (3 to 1000 characters)' USING ERRCODE = 'QM021'; END IF;
  IF p_quantity IS NOT NULL AND p_decision <> 'rejected' THEN RAISE EXCEPTION 'A quantity belongs to a rejection' USING ERRCODE = 'QM021'; END IF;
  IF p_quantity IS NOT NULL AND (p_quantity <= 0 OR p_quantity > x.quantity_received) THEN RAISE EXCEPTION 'The quantity rejected is above zero and no more than was received (%)', x.quantity_received USING ERRCODE = 'QM021'; END IF;
  IF p_decision <> 'conditional' AND v_cond IS NOT NULL THEN RAISE EXCEPTION 'Conditions belong to a conditional acceptance' USING ERRCODE = 'QM021'; END IF;
  SELECT decision INTO v_current FROM public.receipt_line_dispositions WHERE receipt_line_id = x.id ORDER BY decided_at DESC, id DESC LIMIT 1;
  IF v_current IS NOT DISTINCT FROM p_decision THEN RAISE EXCEPTION 'That line is already %', p_decision USING ERRCODE = 'QM021'; END IF;
  IF v_current = 'rejected' AND NOT app.has_permission(x.organisation_id, 'supplier_quality.approve') THEN
    RAISE EXCEPTION 'Only an approver can change a rejection' USING ERRCODE = '42501';
  END IF;
  IF p_decision = 'conditional' THEN
    IF NOT app.has_permission(x.organisation_id, 'supplier_quality.approve') THEN RAISE EXCEPTION 'Only an approver can accept goods conditionally' USING ERRCODE = '42501'; END IF;
    IF v_cond IS NULL THEN RAISE EXCEPTION 'State the conditions of the acceptance' USING ERRCODE = 'QM021'; END IF;
  END IF;
  IF p_decision = 'accepted' THEN
    v_assess := app.incoming_inspection_assessment(x.id);
    IF (v_assess ->> 'required')::boolean AND v_assess ->> 'outcome' <> 'acceptable' THEN
      RAISE EXCEPTION 'Inspection is required and the evidence does not support acceptance yet (%): reject, hold or accept conditionally instead',
        CASE v_assess ->> 'state' WHEN 'not_started' THEN 'it has not been started' WHEN 'in_progress' THEN 'it is not complete' ELSE format('%s of %s samples, %s failed, %s allowed', v_assess ->> 'samples', v_assess ->> 'requiredSamples', v_assess ->> 'failedSamples', v_assess ->> 'acceptNumber') END
        USING ERRCODE = 'QM021';
    END IF;
  END IF;
  INSERT INTO public.receipt_line_dispositions (organisation_id, receipt_line_id, decision, reason, conditions, quantity_rejected) VALUES (x.organisation_id, x.id, p_decision, v_reason, v_cond, p_quantity) RETURNING id INTO v_id;
  IF x.lot_id IS NOT NULL THEN
    SELECT * INTO lt FROM public.lots WHERE id = x.lot_id FOR UPDATE;
    IF lt.status <> 'closed' THEN
      IF p_decision IN ('accepted', 'conditional') AND lt.status = 'on_hold' THEN
        UPDATE public.lots SET status = 'released', status_reason = NULL WHERE id = lt.id;
      ELSIF p_decision IN ('held', 'rejected') AND lt.status <> 'on_hold' THEN
        UPDATE public.lots SET status = 'on_hold', status_reason = left(CASE p_decision WHEN 'rejected' THEN 'Rejected at goods receipt: ' ELSE 'Held at goods receipt: ' END || v_reason, 1000) WHERE id = lt.id;
      END IF;
    END IF;
  END IF;
  RETURN v_id;
END $$;


-- ---------------------------------------------------------------------------
-- Per-supplier overrides: keys present are set, null clears one (it follows the model again). Needs supplier_quality.configure.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.set_supplier_performance_settings(p_supplier uuid, p_settings jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.suppliers%ROWTYPE; k text; cur public.supplier_performance_settings%ROWTYPE; n public.supplier_performance_settings%ROWTYPE;
BEGIN
  SELECT * INTO s FROM public.suppliers WHERE id = p_supplier FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(s.organisation_id) THEN RAISE EXCEPTION 'Supplier not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(s.organisation_id, 'supplier_quality.configure') THEN RAISE EXCEPTION 'You are not allowed to configure supplier scorecards' USING ERRCODE = '42501'; END IF;
  IF jsonb_typeof(p_settings) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Send the settings as an object' USING ERRCODE = 'QM020'; END IF;
  FOR k IN SELECT jsonb_object_keys(p_settings) LOOP
    IF k NOT IN ('otdPolicy', 'graceDaysBefore', 'graceDaysAfter', 'inFullUnderPct', 'inFullOverPct') THEN RAISE EXCEPTION 'Unknown setting %', k USING ERRCODE = 'QM020'; END IF;
  END LOOP;
  SELECT * INTO cur FROM public.supplier_performance_settings WHERE supplier_id = s.id;
  n := cur;
  IF p_settings ? 'otdPolicy' THEN n.otd_policy := nullif(p_settings ->> 'otdPolicy', ''); END IF;
  IF p_settings ? 'graceDaysBefore' THEN n.grace_days_before := (p_settings ->> 'graceDaysBefore')::integer; END IF;
  IF p_settings ? 'graceDaysAfter' THEN n.grace_days_after := (p_settings ->> 'graceDaysAfter')::integer; END IF;
  IF p_settings ? 'inFullUnderPct' THEN n.in_full_under_pct := (p_settings ->> 'inFullUnderPct')::numeric; END IF;
  IF p_settings ? 'inFullOverPct' THEN n.in_full_over_pct := (p_settings ->> 'inFullOverPct')::numeric; END IF;
  IF n.otd_policy IS NOT NULL AND n.otd_policy NOT IN ('agreed', 'original') THEN RAISE EXCEPTION 'The on-time date policy is "agreed" or "original"' USING ERRCODE = 'QM020'; END IF;
  IF n.grace_days_before NOT BETWEEN 0 AND 60 OR n.grace_days_after NOT BETWEEN 0 AND 60 THEN RAISE EXCEPTION 'The grace days are whole numbers from 0 to 60' USING ERRCODE = 'QM020'; END IF;
  IF n.in_full_under_pct NOT BETWEEN 0 AND 100 OR n.in_full_over_pct NOT BETWEEN 0 AND 100 THEN RAISE EXCEPTION 'The in-full tolerances are percentages from 0 to 100' USING ERRCODE = 'QM020'; END IF;
  IF cur.id IS NULL THEN
    INSERT INTO public.supplier_performance_settings (organisation_id, supplier_id, otd_policy, grace_days_before, grace_days_after, in_full_under_pct, in_full_over_pct)
    VALUES (s.organisation_id, s.id, n.otd_policy, n.grace_days_before, n.grace_days_after, n.in_full_under_pct, n.in_full_over_pct);
  ELSE
    UPDATE public.supplier_performance_settings SET otd_policy = n.otd_policy, grace_days_before = n.grace_days_before, grace_days_after = n.grace_days_after,
      in_full_under_pct = n.in_full_under_pct, in_full_over_pct = n.in_full_over_pct, updated_at = now(), updated_by = auth.uid() WHERE id = cur.id;
  END IF;
END $$;

-- The configuration a supplier is scored with: the organisation's current model with that supplier's overrides on top (internal).
CREATE FUNCTION app.supplier_effective_config(p_supplier uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.suppliers%ROWTYPE; mdl public.supplier_scorecard_models%ROWTYPE; o public.supplier_performance_settings%ROWTYPE; v_over jsonb;
BEGIN
  SELECT * INTO s FROM public.suppliers WHERE id = p_supplier;
  IF NOT FOUND OR NOT app.is_member(s.organisation_id) THEN RAISE EXCEPTION 'Supplier not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO mdl FROM public.supplier_scorecard_models WHERE organisation_id = s.organisation_id ORDER BY version DESC LIMIT 1;
  SELECT * INTO o FROM public.supplier_performance_settings WHERE supplier_id = s.id;
  v_over := jsonb_strip_nulls(jsonb_build_object('otd_policy', o.otd_policy, 'grace_days_before', o.grace_days_before, 'grace_days_after', o.grace_days_after,
                                                 'in_full_under_pct', o.in_full_under_pct, 'in_full_over_pct', o.in_full_over_pct));
  RETURN jsonb_build_object('modelId', mdl.id, 'version', mdl.version, 'modelConfig', mdl.config, 'overrides', v_over, 'config', mdl.config || v_over);
END $$;

-- ---------------------------------------------------------------------------
-- Metrics (replaces the version that took only a date policy): the configuration carries the date policy, grace days and tolerances.
-- ---------------------------------------------------------------------------
DROP FUNCTION app.supplier_performance_metrics(uuid, date, date, text);
CREATE FUNCTION app.supplier_performance_metrics(p_supplier uuid, p_from date, p_to date, p_config jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  s public.suppliers%ROWTYPE; v_policy text := coalesce(p_config ->> 'otd_policy', 'agreed');
  v_before integer := (p_config ->> 'grace_days_before')::int; v_after integer := coalesce((p_config ->> 'grace_days_after')::int, 0);
  v_under numeric := coalesce((p_config ->> 'in_full_under_pct')::numeric, 0); v_over numeric := coalesce((p_config ->> 'in_full_over_pct')::numeric, 10);
  v_lines integer; v_units numeric; v_rej_lines integer; v_rej_units numeric; v_rej_src jsonb; v_nc_lines integer; v_nc_units numeric; v_nc_src jsonb;
  v_matched integer; v_on_time integer; v_early integer; v_late_src jsonb; v_open_late integer; v_open_late_src jsonb;
  v_if_lines integer; v_if_ok integer; v_if_short integer; v_if_over integer; v_if_pending integer; v_otif integer; v_if_src jsonb;
  v_nc jsonb; v_scar jsonb; v_cert jsonb; v_rows jsonb;
BEGIN
  SELECT * INTO s FROM public.suppliers WHERE id = p_supplier;
  IF NOT FOUND OR NOT app.is_member(s.organisation_id) THEN RAISE EXCEPTION 'Supplier not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT (app.has_permission(s.organisation_id, 'supplier_quality.read') AND app.has_permission(s.organisation_id, 'receiving.read')) THEN
    RAISE EXCEPTION 'You are not allowed to see supplier performance' USING ERRCODE = '42501';
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
                       WHERE rn.receipt_line_id = x.id AND n.deleted_at IS NULL AND n.stage <> 'cancelled') nc ON true
    WHERE g.supplier_id = p_supplier AND g.organisation_id = s.organisation_id AND g.status = 'received' AND g.received_on BETWEEN p_from AND p_to;
  SELECT count(*), coalesce(sum(qty), 0), count(*) FILTER (WHERE decision = 'rejected'), coalesce(sum(rej_qty), 0), count(*) FILTER (WHERE nc_qty > 0), coalesce(sum(nc_qty), 0)
    INTO v_lines, v_units, v_rej_lines, v_rej_units, v_nc_lines, v_nc_units FROM jsonb_to_recordset(v_rows) AS _l(receipt_id uuid, reference text, line_number integer, qty numeric, decision text, rej_qty numeric, nc_qty numeric, received_on date, po_line uuid);
  SELECT coalesce(jsonb_agg(jsonb_build_object('receiptId', receipt_id, 'reference', reference, 'lineNumber', line_number, 'units', rej_qty)), '[]'::jsonb) INTO v_rej_src
    FROM (SELECT * FROM jsonb_to_recordset(v_rows) AS _l(receipt_id uuid, reference text, line_number integer, qty numeric, decision text, rej_qty numeric, nc_qty numeric, received_on date, po_line uuid) WHERE decision = 'rejected' ORDER BY received_on DESC, reference LIMIT 10) q;
  SELECT coalesce(jsonb_agg(jsonb_build_object('receiptId', receipt_id, 'reference', reference, 'lineNumber', line_number, 'units', nc_qty)), '[]'::jsonb) INTO v_nc_src
    FROM (SELECT * FROM jsonb_to_recordset(v_rows) AS _l(receipt_id uuid, reference text, line_number integer, qty numeric, decision text, rej_qty numeric, nc_qty numeric, received_on date, po_line uuid) WHERE nc_qty > 0 ORDER BY received_on DESC, reference LIMIT 10) q;

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
    'ppmNc', jsonb_build_object('basis', 'ncs', 'value', CASE WHEN v_units > 0 THEN round(v_nc_units / v_units * 1000000, 0) END, 'affectedUnits', v_nc_units, 'receivedUnits', v_units, 'lines', v_nc_lines, 'sources', v_nc_src),
    'lotRejection', jsonb_build_object('rate', CASE WHEN v_lines > 0 THEN round(v_rej_lines::numeric / v_lines, 4) END, 'rejectedLines', v_rej_lines, 'lines', v_lines),
    'otd', jsonb_build_object('policy', v_policy, 'graceBefore', v_before, 'graceAfter', v_after, 'value', CASE WHEN v_matched > 0 THEN round(v_on_time::numeric / v_matched, 4) END,
      'matchedLines', v_matched, 'onTime', v_on_time, 'late', v_matched - v_on_time - v_early, 'early', v_early,
      'unmatchedLines', v_lines - v_matched, 'openLateLines', v_open_late, 'sources', v_late_src, 'openLateSources', v_open_late_src),
    'inFull', jsonb_build_object('underPct', v_under, 'overPct', v_over, 'lines', v_if_lines, 'inFull', v_if_ok, 'short', v_if_short, 'over', v_if_over, 'pending', v_if_pending,
      'value', CASE WHEN v_if_lines - v_if_pending > 0 THEN round(v_if_ok::numeric / (v_if_lines - v_if_pending), 4) END, 'sources', v_if_src),
    'otif', jsonb_build_object('lines', v_if_lines - v_if_pending, 'otif', v_otif, 'value', CASE WHEN v_if_lines - v_if_pending > 0 THEN round(v_otif::numeric / (v_if_lines - v_if_pending), 4) END),
    'ncs', v_nc, 'scars', v_scar, 'certs', v_cert);
END $$;
CREATE OR REPLACE FUNCTION app.score_supplier_performance(c jsonb, m jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE
  comps jsonb := '[]'::jsonb; warns jsonb := '[]'::jsonb; v_min integer := (c ->> 'min_lines')::int; good numeric := (c ->> 'good_from')::numeric; watch numeric := (c ->> 'watch_from')::numeric;
  w jsonb := c -> 'weights'; total_w numeric := 0; used_w numeric := 0; sum_ws numeric := 0; v_score numeric; v_band text; k text; sc numeric; suf boolean; detail text; src jsonb;
  wk numeric; basis text := coalesce(c ->> 'ppm_basis', 'rejected'); pg numeric := (c ->> 'ppm_good')::numeric; pz numeric := (c ->> 'ppm_zero')::numeric; penalty numeric; ppm numeric;
BEGIN
  FOREACH k IN ARRAY ARRAY['otd', 'in_full', 'ppm', 'ncs', 'scar', 'certs'] LOOP
    wk := coalesce(w ->> k, '0')::numeric;
    sc := NULL; suf := false; detail := NULL; src := '[]'::jsonb;
    IF k = 'otd' THEN
      IF (m -> 'otd' ->> 'matchedLines')::int >= v_min THEN suf := true; sc := (m -> 'otd' ->> 'value')::numeric * 100; detail := format('%s of %s delivered lines on time (%s late, %s early)', m -> 'otd' ->> 'onTime', m -> 'otd' ->> 'matchedLines', m -> 'otd' ->> 'late', coalesce(m -> 'otd' ->> 'early', '0')); src := m -> 'otd' -> 'sources';
      ELSE detail := format('Only %s delivered lines against an order; %s needed', m -> 'otd' ->> 'matchedLines', v_min); END IF;
    ELSIF k = 'in_full' THEN
      IF (m -> 'inFull' ->> 'lines')::int - (m -> 'inFull' ->> 'pending')::int >= v_min THEN
        suf := true; sc := (m -> 'inFull' ->> 'value')::numeric * 100;
        detail := format('%s of %s order lines delivered in full (%s short, %s over)', m -> 'inFull' ->> 'inFull', (m -> 'inFull' ->> 'lines')::int - (m -> 'inFull' ->> 'pending')::int, m -> 'inFull' ->> 'short', m -> 'inFull' ->> 'over'); src := m -> 'inFull' -> 'sources';
      ELSE detail := format('Only %s order lines due in the period; %s needed', (m -> 'inFull' ->> 'lines')::int - (m -> 'inFull' ->> 'pending')::int, v_min); END IF;
    ELSIF k = 'ppm' THEN
      IF basis = 'ncs' THEN
        IF (m -> 'deliveries' ->> 'lines')::int >= v_min AND (m -> 'ppmNc' ->> 'receivedUnits')::numeric > 0 THEN
          suf := true; ppm := (m -> 'ppmNc' ->> 'value')::numeric;
          sc := greatest(0, least(100, 100 * (pz - ppm) / (pz - pg))); detail := format('%s PPM from non-conformances (%s of %s units affected)', ppm, m -> 'ppmNc' ->> 'affectedUnits', m -> 'ppmNc' ->> 'receivedUnits'); src := m -> 'ppmNc' -> 'sources';
        ELSE detail := format('Only %s delivered lines; %s needed', m -> 'deliveries' ->> 'lines', v_min); END IF;
      ELSIF (m -> 'deliveries' ->> 'lines')::int >= v_min AND (m -> 'ppm' ->> 'receivedUnits')::numeric > 0 THEN
        suf := true; ppm := (m -> 'ppm' ->> 'value')::numeric;
        sc := greatest(0, least(100, 100 * (pz - ppm) / (pz - pg))); detail := format('%s PPM (%s of %s units rejected)', ppm, m -> 'ppm' ->> 'rejectedUnits', m -> 'ppm' ->> 'receivedUnits'); src := m -> 'ppm' -> 'sources';
      ELSE detail := format('Only %s delivered lines; %s needed', m -> 'deliveries' ->> 'lines', v_min); END IF;
    ELSIF k = 'ncs' THEN
      IF (m -> 'deliveries' ->> 'lines')::int > 0 OR (m -> 'ncs' ->> 'total')::int > 0 THEN
        suf := true;
        penalty := (m -> 'ncs' ->> 'critical')::int * (c -> 'nc_penalty' ->> 'critical')::int + (m -> 'ncs' ->> 'major')::int * (c -> 'nc_penalty' ->> 'major')::int
                 + (m -> 'ncs' ->> 'minor')::int * (c -> 'nc_penalty' ->> 'minor')::int;
        sc := greatest(0, 100 - penalty); detail := format('%s non-conformances (%s critical, %s major, %s minor, %s repeat)', m -> 'ncs' ->> 'total', m -> 'ncs' ->> 'critical', m -> 'ncs' ->> 'major', m -> 'ncs' ->> 'minor', m -> 'ncs' ->> 'repeat'); src := m -> 'ncs' -> 'sources';
      ELSE detail := 'No deliveries or non-conformances in the period'; END IF;
    ELSIF k = 'scar' THEN
      IF (m -> 'scars' ->> 'answered_on_time')::int + (m -> 'scars' ->> 'answered_late')::int + (m -> 'scars' ->> 'overdue_now')::int >= 1 THEN
        suf := true;
        sc := 100 * (m -> 'scars' ->> 'answered_on_time')::numeric / ((m -> 'scars' ->> 'answered_on_time')::int + (m -> 'scars' ->> 'answered_late')::int + (m -> 'scars' ->> 'overdue_now')::int);
        detail := format('%s of %s corrective action requests answered on time', m -> 'scars' ->> 'answered_on_time', (m -> 'scars' ->> 'answered_on_time')::int + (m -> 'scars' ->> 'answered_late')::int + (m -> 'scars' ->> 'overdue_now')::int); src := m -> 'scars' -> 'sources';
      ELSE detail := 'No corrective action requests due in the period'; END IF;
    ELSE
      IF (m -> 'certs' ->> 'current')::int >= 1 THEN
        suf := true; sc := 100 * ((m -> 'certs' ->> 'current')::int - (m -> 'certs' ->> 'expired')::int)::numeric / (m -> 'certs' ->> 'current')::int;
        detail := format('%s of %s current certifications in date', (m -> 'certs' ->> 'current')::int - (m -> 'certs' ->> 'expired')::int, m -> 'certs' ->> 'current'); src := m -> 'certs' -> 'sources';
      ELSE detail := 'No current certifications on file'; END IF;
    END IF;
    total_w := total_w + wk;
    IF suf THEN used_w := used_w + wk; sum_ws := sum_ws + wk * sc; END IF;
    comps := comps || jsonb_build_array(jsonb_build_object('key', k, 'weight', wk::int, 'sufficient', suf, 'score', CASE WHEN suf THEN round(sc, 1) END, 'detail', detail));
    IF suf AND wk::int > 0 AND sc < watch THEN
      warns := warns || jsonb_build_array(jsonb_build_object('code', k || '_low', 'level', CASE WHEN sc < watch / 2 THEN 'critical' ELSE 'warning' END, 'message', detail, 'sourceType', k, 'sources', src));
    ELSIF NOT suf AND wk::int > 0 THEN
      warns := warns || jsonb_build_array(jsonb_build_object('code', k || '_insufficient', 'level', 'info', 'message', detail, 'sourceType', k, 'sources', '[]'::jsonb));
    END IF;
  END LOOP;
  IF (m -> 'ncs' ->> 'critical')::int > 0 THEN
    warns := warns || jsonb_build_array(jsonb_build_object('code', 'critical_nc', 'level', 'critical', 'message', format('%s critical non-conformance(s) in the period', m -> 'ncs' ->> 'critical'), 'sourceType', 'ncs', 'sources', m -> 'ncs' -> 'sources'));
  END IF;
  IF (m -> 'otd' ->> 'openLateLines')::int > 0 THEN
    warns := warns || jsonb_build_array(jsonb_build_object('code', 'open_late', 'level', 'warning', 'message', format('%s open order line(s) already past their due date', m -> 'otd' ->> 'openLateLines'), 'sourceType', 'orders', 'sources', m -> 'otd' -> 'openLateSources'));
  END IF;
  IF (m -> 'scars' ->> 'overdue_now')::int > 0 THEN
    warns := warns || jsonb_build_array(jsonb_build_object('code', 'scar_overdue', 'level', 'warning', 'message', format('%s corrective action request(s) overdue for a response', m -> 'scars' ->> 'overdue_now'), 'sourceType', 'scars', 'sources', m -> 'scars' -> 'sources'));
  END IF;
  IF (m -> 'certs' ->> 'expired')::int > 0 THEN
    warns := warns || jsonb_build_array(jsonb_build_object('code', 'cert_expired', 'level', 'warning', 'message', format('%s certification(s) past their expiry date', m -> 'certs' ->> 'expired'), 'sourceType', 'certs', 'sources', m -> 'certs' -> 'sources'));
  END IF;
  IF (m -> 'otd' ->> 'unmatchedLines')::int > 0 THEN
    warns := warns || jsonb_build_array(jsonb_build_object('code', 'unmatched_lines', 'level', 'info', 'message', format('%s delivered line(s) have no order line and are left out of on-time delivery', m -> 'otd' ->> 'unmatchedLines'), 'sourceType', 'deliveries', 'sources', '[]'::jsonb));
  END IF;
  IF total_w = 0 OR used_w / total_w < 0.5 THEN
    v_score := NULL; v_band := 'insufficient';
  ELSE
    v_score := round(sum_ws / used_w, 2);
    v_band := CASE WHEN v_score >= good THEN 'good' WHEN v_score >= watch THEN 'watch' ELSE 'poor' END;
  END IF;
  RETURN jsonb_build_object('score', v_score, 'band', v_band, 'components', comps, 'warnings', warns, 'weightWithData', CASE WHEN total_w > 0 THEN round(used_w / total_w, 2) END);
END $$;


-- The live view: metrics and scoring under the organisation's current model with the supplier's overrides on top.
CREATE OR REPLACE FUNCTION app.supplier_performance(p_supplier uuid, p_from date, p_to date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE e jsonb; v_metrics jsonb; v_scoring jsonb;
BEGIN
  e := app.supplier_effective_config(p_supplier);
  v_metrics := app.supplier_performance_metrics(p_supplier, p_from, p_to, e -> 'config');
  v_scoring := app.score_supplier_performance(e -> 'config', v_metrics);
  RETURN jsonb_build_object('model', jsonb_build_object('id', e ->> 'modelId', 'version', (e ->> 'version')::int, 'config', e -> 'config'), 'overrides', e -> 'overrides', 'metrics', v_metrics) || v_scoring;
END $$;

REVOKE ALL ON FUNCTION app.set_supplier_performance_settings(uuid, jsonb), app.supplier_effective_config(uuid), app.disposition_receipt_line(uuid, text, text, text, numeric),
  app.supplier_performance_metrics(uuid, date, date, jsonb), app.score_supplier_performance(jsonb, jsonb), app.supplier_performance(uuid, date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.set_supplier_performance_settings(uuid, jsonb), app.disposition_receipt_line(uuid, text, text, text, numeric),
  app.supplier_performance_metrics(uuid, date, date, jsonb), app.score_supplier_performance(jsonb, jsonb), app.supplier_performance(uuid, date, date) TO authenticated;
