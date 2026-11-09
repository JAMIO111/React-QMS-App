-- Supplier Quality SQ5: supplier performance scorecards (docs/supplier-quality-plan.md).
--
--  * supplier_scorecard_models: the organisation's way of scoring performance, as VERSIONS (config: the OTD date policy, metric weights, PPM targets, NC penalties, bands,
--    the minimum amount of data). A new version is saved with a reason; old versions stay. Every organisation starts with a default (seeded). Function: app.save_supplier_scorecard_model.
--  * The metrics are WORKED OUT BY THE DATABASE from live records (app.supplier_performance_metrics), once, so the live view, the stored snapshot and the watchlist cannot disagree:
--      PPM            = rejected units / received units x 1,000,000 (a receipt line whose latest decision is "rejected" counts whole; cancelled receipts are left out)
--      Lot rejection  = rejected lines / received lines (kept distinct from PPM)
--      On-time delivery = receipt lines against an order line received on or before its due date; due date = the ORIGINAL requested date or the latest AGREED date (model policy);
--                         lines with no order line are counted as unmatched and left out
--      Non-conformances = live NCs naming the supplier, detected in the period, by severity; repeats = NCs on a part that has two or more in the period
--      SCAR responsiveness = SCARs issued in the period whose first response came by the original due date (unanswered and not yet due are left out)
--      Certification validity = current certifications not past their expiry date (as at the snapshot)
--  * app.score_supplier_performance turns metrics into a 0-100 score, a band (good / watch / poor) or "insufficient data", and warnings that each name the records behind them.
--    A metric without enough data is left out and the score is worked out from the rest; when less than half of the weight has data there is NO score.
--  * supplier_scorecards: append-only snapshots (period, model version, every metric with the records behind it, score, band, warnings, a note). Written only by
--    app.save_supplier_scorecard (supplier_quality.manage); never edited or deleted, so later changes never rewrite an old scorecard.
--  * app.supplier_watchlist: live scoring of every active supplier for the last N days, worst first, only those with something to say. Nothing changes a supplier's approval status.

CREATE TABLE public.supplier_scorecard_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  config jsonb NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT supplier_scorecard_models_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT supplier_scorecard_models_version_key UNIQUE (organisation_id, version)
);

CREATE TABLE public.supplier_scorecards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  supplier_id uuid NOT NULL,
  period_from date NOT NULL,
  period_to date NOT NULL,
  model_id uuid NOT NULL,
  model_version integer NOT NULL,
  config jsonb NOT NULL,
  metrics jsonb NOT NULL,
  components jsonb NOT NULL,
  score numeric(5, 2) CHECK (score IS NULL OR score BETWEEN 0 AND 100),
  band text NOT NULL CHECK (band IN ('good', 'watch', 'poor', 'insufficient')),
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  note text CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT supplier_scorecards_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT supplier_scorecards_supplier_fkey FOREIGN KEY (supplier_id, organisation_id) REFERENCES public.suppliers (id, organisation_id),
  CONSTRAINT supplier_scorecards_model_fkey FOREIGN KEY (model_id, organisation_id) REFERENCES public.supplier_scorecard_models (id, organisation_id),
  CONSTRAINT supplier_scorecards_period CHECK (period_from <= period_to AND period_to - period_from <= 366),
  CONSTRAINT supplier_scorecards_score_band CHECK ((band = 'insufficient') = (score IS NULL))
);
CREATE INDEX supplier_scorecards_supplier_idx ON public.supplier_scorecards (supplier_id, created_at DESC);

-- Scorecards are frozen: no update (apart from the touch columns never changing) and no delete, whoever asks.
CREATE FUNCTION app.scorecard_frozen() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'A scorecard is a frozen record and cannot be changed or deleted' USING ERRCODE = 'QM020';
END $$;
CREATE TRIGGER supplier_scorecards_frozen BEFORE UPDATE OR DELETE ON public.supplier_scorecards FOR EACH ROW EXECUTE FUNCTION app.scorecard_frozen();
CREATE TRIGGER supplier_scorecards_stamp BEFORE INSERT ON public.supplier_scorecards FOR EACH ROW EXECUTE FUNCTION app.stamp_created();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['supplier_scorecard_models', 'supplier_scorecards'] LOOP
    EXECUTE format('CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION audit.record_change(%L)', t, 'organisation_id');
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format($p$CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (app.has_permission(organisation_id, 'supplier_quality.read'))$p$, t || '_select', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- What a valid configuration is
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.scorecard_config_problem(c jsonb) RETURNS text
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
  RETURN NULL;
END $$;
ALTER TABLE public.supplier_scorecard_models ADD CONSTRAINT supplier_scorecard_models_valid CHECK (app.scorecard_config_problem(config) IS NULL);

CREATE FUNCTION app.seed_supplier_scorecard_model(p_organisation_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO public.supplier_scorecard_models (organisation_id, version, config, reason)
  SELECT p_organisation_id, 1,
    jsonb_build_object('otd_policy', 'agreed', 'weights', jsonb_build_object('otd', 30, 'ppm', 30, 'ncs', 20, 'scar', 10, 'certs', 10),
      'ppm_good', 1000, 'ppm_zero', 50000, 'nc_penalty', jsonb_build_object('critical', 40, 'major', 20, 'minor', 5),
      'good_from', 85, 'watch_from', 70, 'min_lines', 5), 'Default model'
  WHERE NOT EXISTS (SELECT 1 FROM public.supplier_scorecard_models WHERE organisation_id = p_organisation_id)
$$;
CREATE FUNCTION app.seed_supplier_scorecard_model_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.seed_supplier_scorecard_model(NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER organisations_seed_supplier_scorecard_model AFTER INSERT ON public.organisations FOR EACH ROW EXECUTE FUNCTION app.seed_supplier_scorecard_model_trg();
SELECT app.seed_supplier_scorecard_model(o.id) FROM public.organisations o;

CREATE FUNCTION app.save_supplier_scorecard_model(p_organisation uuid, p_config jsonb, p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_problem text; v_version integer; v_id uuid;
BEGIN
  IF NOT app.is_member(p_organisation) THEN RAISE EXCEPTION 'Organisation not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(p_organisation, 'supplier_quality.configure') THEN
    RAISE EXCEPTION 'You are not allowed to configure supplier scorecards' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('supplier_scorecard_model:' || p_organisation::text, 0));
  v_problem := app.scorecard_config_problem(p_config);
  IF v_problem IS NOT NULL THEN RAISE EXCEPTION '%', v_problem USING ERRCODE = 'QM020'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 3 OR length(btrim(p_reason)) > 1000 THEN RAISE EXCEPTION 'Say why the model is changing (3 to 1000 characters)' USING ERRCODE = 'QM020'; END IF;
  IF EXISTS (SELECT 1 FROM public.supplier_scorecard_models m WHERE m.organisation_id = p_organisation AND m.config = p_config
              AND m.version = (SELECT max(version) FROM public.supplier_scorecard_models WHERE organisation_id = p_organisation)) THEN
    RAISE EXCEPTION 'Nothing has changed from the current model' USING ERRCODE = 'QM020';
  END IF;
  SELECT coalesce(max(version), 0) + 1 INTO v_version FROM public.supplier_scorecard_models WHERE organisation_id = p_organisation;
  INSERT INTO public.supplier_scorecard_models (organisation_id, version, config, reason) VALUES (p_organisation, v_version, p_config, btrim(p_reason)) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------
-- Metrics: every number comes from live records, in one place. SECURITY DEFINER so the figures do not depend on which tables the caller may read;
-- the caller needs supplier_quality.read and receiving.read.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.supplier_performance_metrics(p_supplier uuid, p_from date, p_to date, p_policy text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  s public.suppliers%ROWTYPE; v_lines integer; v_units numeric; v_rej_lines integer; v_rej_units numeric; v_rej_src jsonb;
  v_matched integer; v_on_time integer; v_late_src jsonb; v_open_late integer; v_open_late_src jsonb;
  v_nc jsonb; v_scar jsonb; v_cert jsonb; v_rows jsonb;
BEGIN
  SELECT * INTO s FROM public.suppliers WHERE id = p_supplier;
  IF NOT FOUND OR NOT app.is_member(s.organisation_id) THEN RAISE EXCEPTION 'Supplier not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT (app.has_permission(s.organisation_id, 'supplier_quality.read') AND app.has_permission(s.organisation_id, 'receiving.read')) THEN
    RAISE EXCEPTION 'You are not allowed to see supplier performance' USING ERRCODE = '42501';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN RAISE EXCEPTION 'The period must start on or before it ends' USING ERRCODE = 'QM020'; END IF;
  IF p_policy NOT IN ('agreed', 'original') THEN RAISE EXCEPTION 'Unknown on-time date policy' USING ERRCODE = 'QM020'; END IF;

  -- Deliveries: received lines of the period (cancelled receipts left out), each with its latest decision.
  SELECT coalesce(jsonb_agg(jsonb_build_object('receipt_id', g.id, 'reference', g.reference, 'line_number', x.line_number, 'qty', x.quantity_received, 'decision', d.decision,
                                               'received_on', g.received_on, 'po_line', x.po_line_id)), '[]'::jsonb) INTO v_rows
    FROM public.goods_receipt_lines x JOIN public.goods_receipts g ON g.id = x.goods_receipt_id
    LEFT JOIN LATERAL (SELECT r.decision FROM public.receipt_line_dispositions r WHERE r.receipt_line_id = x.id ORDER BY r.decided_at DESC, r.id DESC LIMIT 1) d ON true
    WHERE g.supplier_id = p_supplier AND g.organisation_id = s.organisation_id AND g.status = 'received' AND g.received_on BETWEEN p_from AND p_to;
  SELECT count(*), coalesce(sum(qty), 0), count(*) FILTER (WHERE decision = 'rejected'), coalesce(sum(qty) FILTER (WHERE decision = 'rejected'), 0) INTO v_lines, v_units, v_rej_lines, v_rej_units FROM jsonb_to_recordset(v_rows) AS _l(receipt_id uuid, reference text, line_number integer, qty numeric, decision text, received_on date, po_line uuid);
  SELECT coalesce(jsonb_agg(jsonb_build_object('receiptId', receipt_id, 'reference', reference, 'lineNumber', line_number, 'units', qty)), '[]'::jsonb) INTO v_rej_src
    FROM (SELECT * FROM jsonb_to_recordset(v_rows) AS _l(receipt_id uuid, reference text, line_number integer, qty numeric, decision text, received_on date, po_line uuid) WHERE decision = 'rejected' ORDER BY received_on DESC, reference LIMIT 10) q;

  -- On-time delivery: lines against an order line, by the policy's due date.
  SELECT count(*), count(*) FILTER (WHERE l.received_on <= due.d) INTO v_matched, v_on_time
    FROM jsonb_to_recordset(v_rows) AS l(receipt_id uuid, reference text, line_number integer, qty numeric, decision text, received_on date, po_line uuid) JOIN public.purchase_order_lines pl ON pl.id = l.po_line
    CROSS JOIN LATERAL (SELECT CASE WHEN p_policy = 'original' THEN pl.requested_on ELSE coalesce(pl.agreed_on, pl.requested_on) END AS d) due;
  SELECT coalesce(jsonb_agg(jsonb_build_object('receiptId', receipt_id, 'reference', reference, 'lineNumber', line_number, 'daysLate', late)), '[]'::jsonb) INTO v_late_src
    FROM (SELECT l.receipt_id, l.reference, l.line_number, (l.received_on - due.d) AS late
          FROM jsonb_to_recordset(v_rows) AS l(receipt_id uuid, reference text, line_number integer, qty numeric, decision text, received_on date, po_line uuid) JOIN public.purchase_order_lines pl ON pl.id = l.po_line
          CROSS JOIN LATERAL (SELECT CASE WHEN p_policy = 'original' THEN pl.requested_on ELSE coalesce(pl.agreed_on, pl.requested_on) END AS d) due
          WHERE l.received_on > due.d ORDER BY late DESC LIMIT 10) q;
  -- Open order lines already past their due date (as of today).
  SELECT count(*), coalesce(jsonb_agg(jsonb_build_object('purchaseOrderId', poid, 'poNumber', ponum, 'lineNumber', ln, 'daysLate', late) ORDER BY late DESC) FILTER (WHERE rn <= 10), '[]'::jsonb)
    INTO v_open_late, v_open_late_src
    FROM (SELECT o.id AS poid, o.po_number AS ponum, pl.line_number AS ln, (current_date - CASE WHEN p_policy = 'original' THEN pl.requested_on ELSE coalesce(pl.agreed_on, pl.requested_on) END) AS late,
                 row_number() OVER (ORDER BY (current_date - CASE WHEN p_policy = 'original' THEN pl.requested_on ELSE coalesce(pl.agreed_on, pl.requested_on) END) DESC) AS rn
          FROM public.purchase_order_lines pl JOIN public.purchase_orders o ON o.id = pl.purchase_order_id
          WHERE o.supplier_id = p_supplier AND o.organisation_id = s.organisation_id AND o.status = 'open' AND pl.status = 'open'
            AND CASE WHEN p_policy = 'original' THEN pl.requested_on ELSE coalesce(pl.agreed_on, pl.requested_on) END < current_date
            AND pl.quantity_ordered > coalesce((SELECT sum(rl.quantity_received) FROM public.goods_receipt_lines rl JOIN public.goods_receipts g2 ON g2.id = rl.goods_receipt_id
                                                WHERE rl.po_line_id = pl.id AND g2.status = 'received'), 0)) q;

  -- Non-conformances naming the supplier, detected in the period.
  SELECT jsonb_build_object(
      'total', count(*), 'critical', count(*) FILTER (WHERE severity = 'critical'), 'major', count(*) FILTER (WHERE severity = 'major'), 'minor', count(*) FILTER (WHERE severity = 'minor'),
      'unclassified', count(*) FILTER (WHERE severity IS NULL),
      'repeat', count(*) FILTER (WHERE part_id IS NOT NULL AND part_count >= 2),
      'sources', coalesce(jsonb_agg(jsonb_build_object('id', id, 'reference', reference, 'severity', severity, 'stage', stage) ORDER BY rn) FILTER (WHERE rn <= 10), '[]'::jsonb))
    INTO v_nc
    FROM (SELECT id, reference, severity, stage, detected_at, part_id,
                 CASE severity WHEN 'critical' THEN 1 WHEN 'major' THEN 2 WHEN 'minor' THEN 3 ELSE 4 END AS sev_rank,
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
    'ppm', jsonb_build_object('value', CASE WHEN v_units > 0 THEN round(v_rej_units / v_units * 1000000, 0) END, 'rejectedUnits', v_rej_units, 'receivedUnits', v_units, 'sources', v_rej_src),
    'lotRejection', jsonb_build_object('rate', CASE WHEN v_lines > 0 THEN round(v_rej_lines::numeric / v_lines, 4) END, 'rejectedLines', v_rej_lines, 'lines', v_lines),
    'otd', jsonb_build_object('policy', p_policy, 'value', CASE WHEN v_matched > 0 THEN round(v_on_time::numeric / v_matched, 4) END, 'matchedLines', v_matched, 'onTime', v_on_time, 'late', v_matched - v_on_time,
      'unmatchedLines', v_lines - v_matched, 'openLateLines', v_open_late, 'sources', v_late_src, 'openLateSources', v_open_late_src),
    'ncs', v_nc, 'scars', v_scar, 'certs', v_cert);
END $$;

-- ---------------------------------------------------------------------------
-- Scoring: from the model's config and the metrics. Pure (no table reads).
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.score_supplier_performance(c jsonb, m jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE
  comps jsonb := '[]'::jsonb; warns jsonb := '[]'::jsonb; v_min integer := (c ->> 'min_lines')::int; good numeric := (c ->> 'good_from')::numeric; watch numeric := (c ->> 'watch_from')::numeric;
  w jsonb := c -> 'weights'; total_w numeric := 0; used_w numeric := 0; sum_ws numeric := 0; v_score numeric; v_band text; k text; sc numeric; suf boolean; detail text; src jsonb;
  pg numeric := (c ->> 'ppm_good')::numeric; pz numeric := (c ->> 'ppm_zero')::numeric; penalty numeric; ppm numeric;
BEGIN
  FOREACH k IN ARRAY ARRAY['otd', 'ppm', 'ncs', 'scar', 'certs'] LOOP
    sc := NULL; suf := false; detail := NULL; src := '[]'::jsonb;
    IF k = 'otd' THEN
      IF (m -> 'otd' ->> 'matchedLines')::int >= v_min THEN suf := true; sc := (m -> 'otd' ->> 'value')::numeric * 100; detail := format('%s of %s delivered lines on time', m -> 'otd' ->> 'onTime', m -> 'otd' ->> 'matchedLines'); src := m -> 'otd' -> 'sources';
      ELSE detail := format('Only %s delivered lines against an order; %s needed', m -> 'otd' ->> 'matchedLines', v_min); END IF;
    ELSIF k = 'ppm' THEN
      IF (m -> 'deliveries' ->> 'lines')::int >= v_min AND (m -> 'ppm' ->> 'receivedUnits')::numeric > 0 THEN
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
    total_w := total_w + (w ->> k)::numeric;
    IF suf THEN used_w := used_w + (w ->> k)::numeric; sum_ws := sum_ws + (w ->> k)::numeric * sc; END IF;
    comps := comps || jsonb_build_array(jsonb_build_object('key', k, 'weight', (w ->> k)::int, 'sufficient', suf, 'score', CASE WHEN suf THEN round(sc, 1) END, 'detail', detail));
    IF suf AND (w ->> k)::int > 0 AND sc < watch THEN
      warns := warns || jsonb_build_array(jsonb_build_object('code', k || '_low', 'level', CASE WHEN sc < watch / 2 THEN 'critical' ELSE 'warning' END, 'message', detail, 'sourceType', k, 'sources', src));
    ELSIF NOT suf AND (w ->> k)::int > 0 THEN
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

-- The live view: metrics and scoring under the organisation's current model.
CREATE FUNCTION app.supplier_performance(p_supplier uuid, p_from date, p_to date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.suppliers%ROWTYPE; mdl public.supplier_scorecard_models%ROWTYPE; v_metrics jsonb; v_scoring jsonb;
BEGIN
  SELECT * INTO s FROM public.suppliers WHERE id = p_supplier;
  IF NOT FOUND OR NOT app.is_member(s.organisation_id) THEN RAISE EXCEPTION 'Supplier not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO mdl FROM public.supplier_scorecard_models WHERE organisation_id = s.organisation_id ORDER BY version DESC LIMIT 1;
  v_metrics := app.supplier_performance_metrics(p_supplier, p_from, p_to, mdl.config ->> 'otd_policy');
  v_scoring := app.score_supplier_performance(mdl.config, v_metrics);
  RETURN jsonb_build_object('model', jsonb_build_object('id', mdl.id, 'version', mdl.version, 'config', mdl.config), 'metrics', v_metrics) || v_scoring;
END $$;

-- Freeze a scorecard for a period (supplier_quality.manage). The period ends today or earlier and is at most a year long.
CREATE FUNCTION app.save_supplier_scorecard(p_supplier uuid, p_from date, p_to date, p_note text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.suppliers%ROWTYPE; r jsonb; v_id uuid;
BEGIN
  SELECT * INTO s FROM public.suppliers WHERE id = p_supplier FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(s.organisation_id) THEN RAISE EXCEPTION 'Supplier not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(s.organisation_id, 'supplier_quality.manage') THEN RAISE EXCEPTION 'You are not allowed to save supplier scorecards' USING ERRCODE = '42501'; END IF;
  IF p_to > current_date THEN RAISE EXCEPTION 'A scorecard period cannot end in the future' USING ERRCODE = 'QM020'; END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to OR p_to - p_from > 366 THEN RAISE EXCEPTION 'A scorecard period is at most a year, starting on or before it ends' USING ERRCODE = 'QM020'; END IF;
  IF p_note IS NOT NULL AND length(btrim(p_note)) > 1000 THEN RAISE EXCEPTION 'The note is too long' USING ERRCODE = 'QM020'; END IF;
  r := app.supplier_performance(p_supplier, p_from, p_to);
  INSERT INTO public.supplier_scorecards (organisation_id, supplier_id, period_from, period_to, model_id, model_version, config, metrics, components, score, band, warnings, note)
  VALUES (s.organisation_id, s.id, p_from, p_to, (r -> 'model' ->> 'id')::uuid, (r -> 'model' ->> 'version')::int, r -> 'model' -> 'config', r -> 'metrics', r -> 'components',
          (r ->> 'score')::numeric, r ->> 'band', r -> 'warnings', nullif(btrim(p_note), ''))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- The watchlist: every active supplier scored live over the last p_days; those that are poor, on watch or carry a warning or critical flag, worst first.
CREATE FUNCTION app.supplier_watchlist(p_organisation uuid, p_days integer DEFAULT 90) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s record; r jsonb; v_rows jsonb := '[]'::jsonb; v_flag boolean;
BEGIN
  IF NOT app.is_member(p_organisation) THEN RAISE EXCEPTION 'Organisation not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT (app.has_permission(p_organisation, 'supplier_quality.read') AND app.has_permission(p_organisation, 'receiving.read')) THEN
    RAISE EXCEPTION 'You are not allowed to see supplier performance' USING ERRCODE = '42501';
  END IF;
  IF p_days IS NULL OR p_days NOT BETWEEN 7 AND 366 THEN RAISE EXCEPTION 'Look back 7 to 366 days' USING ERRCODE = 'QM020'; END IF;
  FOR s IN SELECT id, code, name FROM public.suppliers WHERE organisation_id = p_organisation AND active AND approval_status NOT IN ('archived', 'disqualified') ORDER BY code LIMIT 300 LOOP
    r := app.supplier_performance(s.id, current_date - (p_days - 1), current_date);
    v_flag := (r ->> 'band') IN ('poor', 'watch') OR EXISTS (SELECT 1 FROM jsonb_array_elements(r -> 'warnings') w WHERE w ->> 'level' IN ('warning', 'critical'));
    IF v_flag THEN
      v_rows := v_rows || jsonb_build_array(jsonb_build_object('supplierId', s.id, 'code', s.code, 'name', s.name, 'score', r -> 'score', 'band', r ->> 'band',
        'warnings', (SELECT coalesce(jsonb_agg(w), '[]'::jsonb) FROM jsonb_array_elements(r -> 'warnings') w WHERE w ->> 'level' IN ('warning', 'critical'))));
    END IF;
  END LOOP;
  RETURN (SELECT coalesce(jsonb_agg(x ORDER BY CASE x ->> 'band' WHEN 'poor' THEN 1 WHEN 'watch' THEN 2 WHEN 'insufficient' THEN 3 ELSE 4 END, (x ->> 'score')::numeric NULLS LAST, x ->> 'code'), '[]'::jsonb)
          FROM jsonb_array_elements(v_rows) x);
END $$;

REVOKE ALL ON FUNCTION app.scorecard_frozen(), app.scorecard_config_problem(jsonb), app.seed_supplier_scorecard_model(uuid), app.seed_supplier_scorecard_model_trg(),
  app.save_supplier_scorecard_model(uuid, jsonb, text), app.supplier_performance_metrics(uuid, date, date, text), app.score_supplier_performance(jsonb, jsonb),
  app.supplier_performance(uuid, date, date), app.save_supplier_scorecard(uuid, date, date, text), app.supplier_watchlist(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.save_supplier_scorecard_model(uuid, jsonb, text), app.supplier_performance_metrics(uuid, date, date, text), app.score_supplier_performance(jsonb, jsonb),
  app.supplier_performance(uuid, date, date), app.save_supplier_scorecard(uuid, date, date, text), app.supplier_watchlist(uuid, integer) TO authenticated;
