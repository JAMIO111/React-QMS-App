-- A cost line with no date: reject it (as before) or take the non-conformance's detected date (docs/cost-import-plan.md §12).
--
-- The incurred date decides the exchange rate, so by default a line without one is refused rather than guessed. A cost template can now say, per template, what to do
-- when a line has no date (the cell is empty, or the date column is not mapped at all):
--   reject       -- the row is refused with the reason (the behaviour so far, and still the default)
--   nc_detected  -- the line takes the date the non-conformance was detected, and the exchange rate for that day
-- Nothing else changes: a date in the file is always used exactly as given. The import day is deliberately not offered (it would give today's rate to an old cost).
--
-- What this touches (all rewritten from their live definitions by a checked text patch, or replaced where they are this feature's own):
--  * app.import_ncr_cost takes the setting as a sixth argument (the old five-argument form is dropped);
--  * the run's frozen settings carry `missingDate` (template settings keep it for cost templates only, like `costsOnClosed`);
--  * the run summary and the list of exchange rates a run needs look at the non-conformance's detected date for a line with no date of its own, so the preview is true;
--  * a small API-login-only function lets the sync engine read the run's settings, so it can treat the date as optional when the template says so.

-- The shared functions are rewritten from their live definitions by a checked text patch: the migration refuses to finish unless the old text is found exactly once.
-- Line endings are normalised first: a function applied through the SQL editor from a Windows machine is stored with \r\n.
CREATE FUNCTION pg_temp.patch(p_fn regprocedure, p_old text, p_new text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_def text := replace(pg_get_functiondef(p_fn), E'\r', ''); v_n integer;
BEGIN
  v_n := (length(v_def) - length(replace(v_def, p_old, ''))) / length(p_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'Expected to find % exactly once in %, found % times', p_old, p_fn, v_n; END IF;
  EXECUTE replace(v_def, p_old, p_new);
END $$;

-- ---------------------------------------------------------------------------
-- One cost line. Add only. p_on_closed = the template's "costsOnClosed", p_missing_date = its "missingDate".
-- ---------------------------------------------------------------------------
DROP FUNCTION app.import_ncr_cost(uuid, uuid, jsonb, uuid, boolean);
CREATE FUNCTION app.import_ncr_cost(p_org uuid, p_id uuid, d jsonb, p_connection uuid DEFAULT NULL, p_on_closed boolean DEFAULT false, p_missing_date text DEFAULT 'reject') RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_ncr uuid := app.imp_ref(d, 'nonconformance');
  v_type text := lower(app.imp_text(d, 'costType'));
  v_ccy text := upper(app.imp_text(d, 'currency'));
  v_on date := app.imp_date(d, 'incurredOn');
  v_unit numeric := app.imp_num(d, 'unitCost');
  v_qty numeric := coalesce(app.imp_num(d, 'quantity'), 1);
  v_vat text := lower(coalesce(app.imp_text(d, 'vatTreatment'), 'none'));
  v_pct numeric := app.imp_num(d, 'vatRate');
  v_booked numeric := app.imp_num(d, 'bookedValue');
  v_stage text; v_deleted timestamptz; v_site uuid; v_detected date; v_system text; v_id uuid; v_amount numeric; v_base text;
BEGIN
  IF p_id IS NOT NULL THEN RAISE EXCEPTION 'Cost lines are only ever added: a correction is a new line' USING ERRCODE = 'QM022'; END IF;
  IF v_ncr IS NULL THEN RAISE EXCEPTION 'Name the non-conformance this cost belongs to' USING ERRCODE = 'QM022'; END IF;
  IF v_type IS NULL THEN RAISE EXCEPTION 'Give the cost type' USING ERRCODE = 'QM022'; END IF;
  IF v_ccy IS NULL OR v_ccy !~ '^[A-Z]{3}$' THEN RAISE EXCEPTION 'The currency must be a three-letter code such as GBP or EUR' USING ERRCODE = 'QM022'; END IF;
  IF v_unit IS NULL THEN RAISE EXCEPTION 'Give the unit cost (or the total, with a quantity of 1)' USING ERRCODE = 'QM022'; END IF;
  IF v_unit < 0 THEN
    RAISE EXCEPTION 'A cost cannot be negative: import a credit as a supplier recovery or a customer charge' USING ERRCODE = 'QM022';
  END IF;
  IF v_qty <= 0 THEN RAISE EXCEPTION 'The quantity must be above 0' USING ERRCODE = 'QM022'; END IF;
  IF v_vat NOT IN ('none', 'inclusive', 'exclusive') THEN RAISE EXCEPTION 'VAT must be none, inclusive or exclusive' USING ERRCODE = 'QM022'; END IF;
  IF v_pct IS NOT NULL AND (v_pct < 0 OR v_pct >= 100) THEN RAISE EXCEPTION 'The VAT rate is a percentage from 0 to under 100' USING ERRCODE = 'QM022'; END IF;
  IF v_booked IS NOT NULL AND v_booked <= 0 THEN RAISE EXCEPTION 'The value booked in the site currency must be above 0' USING ERRCODE = 'QM022'; END IF;
  IF coalesce(p_missing_date, 'reject') NOT IN ('reject', 'nc_detected') THEN RAISE EXCEPTION 'When a line has no date: reject it or use the date the non-conformance was detected' USING ERRCODE = 'QM022'; END IF;

  SELECT stage, deleted_at, site_id, detected_at INTO v_stage, v_deleted, v_site, v_detected FROM public.nonconformances WHERE id = v_ncr AND organisation_id = p_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'That non-conformance was not found' USING ERRCODE = 'QM022'; END IF;
  -- the table's insert rule is not applied inside a definer function, so the right is checked here
  IF NOT app.has_permission(p_org, 'ncr.update', v_site) THEN
    RAISE EXCEPTION 'You are not allowed to add costs to this non-conformance' USING ERRCODE = 'QM022';
  END IF;

  -- The date decides the exchange rate, so it is never filled in unless the template says so: a line without one is refused, or takes the day the non-conformance was detected.
  IF v_on IS NULL THEN
    IF coalesce(p_missing_date, 'reject') = 'nc_detected' THEN
      v_on := v_detected;
    ELSE
      RAISE EXCEPTION 'Give the date the cost was incurred: it decides the exchange rate (or set the template to use the date the non-conformance was detected)' USING ERRCODE = 'QM022';
    END IF;
  END IF;

  IF p_connection IS NOT NULL THEN
    SELECT external_system INTO v_system FROM public.integration_connections WHERE id = p_connection AND organisation_id = p_org;
  END IF;
  IF p_on_closed AND v_stage IN ('closed', 'cancelled') THEN PERFORM set_config('app.ncr_cost_on_closed', 'on', true); END IF;

  INSERT INTO public.ncr_costs (organisation_id, nonconformance_id, cost_type, description, incurred_on, currency, vat_treatment, vat_rate, quantity, unit_cost)
  VALUES (p_org, v_ncr, v_type, app.imp_text(d, 'description'), v_on, v_ccy, v_vat,
          CASE WHEN v_vat = 'none' THEN 0 ELSE coalesce(round(v_pct / 100, 6), (SELECT s.vat_rate FROM public.organisation_settings s WHERE s.organisation_id = p_org), 0.20) END,
          v_qty, v_unit)
  RETURNING id INTO v_id;

  -- What the source booked, kept instead of a published rate: the line becomes Actual. A line already in the site currency has no rate, and a line that
  -- costs nothing has nothing to convert.
  IF v_booked IS NOT NULL THEN
    SELECT amount, base_currency INTO v_amount, v_base FROM public.ncr_costs WHERE id = v_id;
    IF v_ccy <> v_base AND v_amount > 0 THEN
      PERFORM app.override_cost_rate(v_id, 'amount', v_booked, 'Booked value from ' || coalesce(v_system, 'the source system') || ' when imported');
    END IF;
  END IF;

  PERFORM set_config('app.ncr_cost_on_closed', 'off', true);
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION app.import_ncr_cost(uuid, uuid, jsonb, uuid, boolean, text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The shared import functions pass the setting on and keep it on the template
-- ---------------------------------------------------------------------------
SELECT pg_temp.patch('app.system_import_record(uuid, uuid, uuid, uuid, uuid, jsonb)'::regprocedure,
  'app.import_ncr_cost(p_org, p_internal, v_data, r.connection_id, coalesce((s ->> ''costsOnClosed'')::boolean, false))',
  'app.import_ncr_cost(p_org, p_internal, v_data, r.connection_id, coalesce((s ->> ''costsOnClosed'')::boolean, false), coalesce(s ->> ''missingDate'', ''reject''))');
SELECT pg_temp.patch('app.integration_template_settings(text, jsonb)'::regprocedure,
  'jsonb_build_object(''costsOnClosed'', coalesce((p_settings ->> ''costsOnClosed'')::boolean, false))',
  'jsonb_build_object(''costsOnClosed'', coalesce((p_settings ->> ''costsOnClosed'')::boolean, false), ''missingDate'', CASE WHEN p_settings ->> ''missingDate'' = ''nc_detected'' THEN ''nc_detected'' ELSE ''reject'' END)');

-- ---------------------------------------------------------------------------
-- The run's settings for the sync engine (API login only): it treats the date as optional when the template says a line without one takes the detected date
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.system_integration_run_settings(p_org uuid, p_run uuid, p_owner uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.integration_sync_runs%ROWTYPE;
BEGIN
  r := app.integration_run_for_system(p_org, p_run, p_owner);
  RETURN coalesce(r.settings, '{}'::jsonb);
END $$;
REVOKE ALL ON FUNCTION app.system_integration_run_settings(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.system_integration_run_settings(uuid, uuid, uuid) TO qms_api;

-- ---------------------------------------------------------------------------
-- What a cost import will do about currencies: now also how many lines take the detected date
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.integration_cost_run_summary(p_run uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.integration_sync_runs%ROWTYPE; v_out jsonb; v_org_ccy text; v_missing text;
BEGIN
  SELECT * INTO r FROM public.integration_sync_runs WHERE id = p_run;
  IF NOT FOUND OR NOT app.has_permission(r.organisation_id, 'integrations.read') THEN RAISE EXCEPTION 'Import not found' USING ERRCODE = 'P0002'; END IF;
  IF r.entity_type <> 'ncr_cost' THEN RAISE EXCEPTION 'This summary is for cost imports' USING ERRCODE = 'QM022'; END IF;
  SELECT coalesce(s.base_currency, 'GBP') INTO v_org_ccy FROM public.organisation_settings s WHERE s.organisation_id = r.organisation_id;
  v_org_ccy := coalesce(v_org_ccy, 'GBP');
  v_missing := coalesce(r.settings ->> 'missingDate', 'reject');

  WITH rows AS (
    SELECT i.id, i.status, i.internal_id,
           upper(nullif(btrim(i.canonical ->> 'currency'), '')) AS ccy,
           CASE WHEN (i.canonical ->> 'incurredOn') ~ '^\d{4}-\d{2}-\d{2}' THEN least((i.canonical ->> 'incurredOn')::date, current_date) END AS own_day,
           CASE WHEN (i.canonical ->> 'nonconformanceId') ~ '^[0-9a-f-]{36}$' THEN (i.canonical ->> 'nonconformanceId')::uuid END AS ncr,
           nullif(btrim(i.canonical ->> 'bookedValue'), '') IS NOT NULL AS booked
      FROM public.integration_inbox i
     WHERE (i.run_id = r.id OR i.last_run_id = r.id) AND i.entity_type = 'ncr_cost' AND i.status NOT IN ('rejected', 'ignored', 'superseded')
  ), joined AS (
    SELECT x.*, n.stage,
           -- a line with no date of its own takes the day its non-conformance was detected, when the template says so
           coalesce(x.own_day, CASE WHEN v_missing = 'nc_detected' THEN least(n.detected_at, current_date) END) AS on_day,
           x.own_day IS NULL AND v_missing = 'nc_detected' AND n.detected_at IS NOT NULL AS from_nc,
           coalesce(si.currency, v_org_ccy) AS site_ccy,
           c.rate_status AS written_status
      FROM rows x
      LEFT JOIN public.nonconformances n ON n.id = x.ncr AND n.organisation_id = r.organisation_id
      LEFT JOIN public.sites si ON si.id = n.site_id AND si.organisation_id = n.organisation_id
      LEFT JOIN public.ncr_costs c ON c.id = x.internal_id AND c.organisation_id = r.organisation_id
  ), pairs AS (
    -- the cache is asked once per currency, day and site currency, however many lines share them
    SELECT DISTINCT ccy, on_day, site_ccy FROM joined WHERE ccy IS NOT NULL AND on_day IS NOT NULL
  ), pair_rate AS (
    SELECT p.*, CASE WHEN p.ccy = p.site_ccy THEN true
                     ELSE EXISTS (SELECT 1 FROM app.exchange_rate_lookup(p.on_day, p.ccy, p.site_ccy) l WHERE l.supported) END AS has_rate
      FROM pairs p
  ), rated AS (
    SELECT j.*, coalesce(pr.has_rate, false) AS has_rate
      FROM joined j
      LEFT JOIN pair_rate pr ON pr.ccy IS NOT DISTINCT FROM j.ccy AND pr.on_day IS NOT DISTINCT FROM j.on_day AND pr.site_ccy = j.site_ccy
  )
  SELECT jsonb_build_object(
    'lines', (SELECT count(*) FROM rated),
    'currencies', coalesce((SELECT jsonb_agg(jsonb_build_object('currency', q.ccy, 'lines', q.n, 'withRate', q.with_rate, 'waiting', q.n - q.with_rate) ORDER BY q.n DESC, q.ccy)
                              FROM (SELECT ccy, count(*)::int AS n, count(*) FILTER (WHERE has_rate)::int AS with_rate FROM rated WHERE ccy IS NOT NULL GROUP BY ccy) q), '[]'::jsonb),
    'onClosed', (SELECT count(*) FROM rated WHERE stage = 'closed'),
    'onCancelled', (SELECT count(*) FROM rated WHERE stage = 'cancelled'),
    'booked', (SELECT count(*) FROM rated WHERE booked),
    'datedFromNc', (SELECT count(*) FROM rated WHERE from_nc),
    'waitingNow', (SELECT count(*) FROM rated WHERE written_status = 'needed'))
    INTO v_out;
  RETURN v_out;
END $$;

-- ---------------------------------------------------------------------------
-- The exchange rates a run's lines will need (API login only): a line with no date of its own is looked up on the detected date too
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.system_integration_cost_rates_needed(p_org uuid, p_run uuid, p_owner uuid, p_limit integer DEFAULT 200) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.integration_sync_runs%ROWTYPE; v_org_ccy text; v_out jsonb; v_missing text;
BEGIN
  r := app.integration_run_for_system(p_org, p_run, p_owner);
  IF r.entity_type <> 'ncr_cost' THEN RETURN '[]'::jsonb; END IF;
  SELECT coalesce(s.base_currency, 'GBP') INTO v_org_ccy FROM public.organisation_settings s WHERE s.organisation_id = r.organisation_id;
  v_org_ccy := coalesce(v_org_ccy, 'GBP');
  v_missing := coalesce(r.settings ->> 'missingDate', 'reject');
  SELECT coalesce(jsonb_agg(jsonb_build_object('requestedOn', p.d, 'base', p.ccy, 'quotes', p.quotes)), '[]'::jsonb) INTO v_out
  FROM (
    SELECT x.d, x.ccy, array_agg(DISTINCT q) FILTER (WHERE NOT EXISTS (SELECT 1 FROM app.exchange_rate_lookup(x.d, x.ccy, q))) AS quotes
      FROM (
        SELECT coalesce(CASE WHEN (i.canonical ->> 'incurredOn') ~ '^\d{4}-\d{2}-\d{2}' THEN least((i.canonical ->> 'incurredOn')::date, current_date) END,
                        CASE WHEN v_missing = 'nc_detected' THEN least(n.detected_at, current_date) END) AS d,
               upper(nullif(btrim(i.canonical ->> 'currency'), '')) AS ccy,
               coalesce(si.currency, v_org_ccy) AS site_ccy
          FROM public.integration_inbox i
          LEFT JOIN public.nonconformances n
            ON n.organisation_id = r.organisation_id AND (i.canonical ->> 'nonconformanceId') ~ '^[0-9a-f-]{36}$' AND n.id = (i.canonical ->> 'nonconformanceId')::uuid
          LEFT JOIN public.sites si ON si.id = n.site_id AND si.organisation_id = n.organisation_id
         WHERE (i.run_id = r.id OR i.last_run_id = r.id) AND i.entity_type = 'ncr_cost' AND i.status IN ('staged', 'previewed')
      ) x, LATERAL unnest(ARRAY[x.site_ccy, v_org_ccy]) AS q
     WHERE x.d IS NOT NULL AND x.ccy ~ '^[A-Z]{3}$' AND q <> x.ccy
     GROUP BY x.d, x.ccy
     LIMIT greatest(least(coalesce(p_limit, 200), 500), 1)
  ) p WHERE p.quotes IS NOT NULL;
  RETURN v_out;
END $$;
