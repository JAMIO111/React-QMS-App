-- Importing NC cost lines through the connectors (docs/cost-import-plan.md §3 and §7, decisions CI-D1 to CI-D13).
--
-- One source row = one cost line on a non-conformance. The line is written through the same table, triggers and rate lookup a typed line goes through, as the person who
-- started the import, so nothing is worked out twice and a person and an import cannot disagree:
--  * amount, VAT, the rate into the site currency and into the organisation currency are all worked out by the table's triggers on the line's own incurred date. Nothing is
--    converted in the file and no rate is read from it. A currency with no published rate yet still imports, as "needed", and is filled when the rate arrives.
--  * Always add only, never matched (like goods receipts): a source line is imported once, keyed by the source's line id. A posted cost is not edited; a correction is a new
--    line, a credit is a supplier recovery or customer charge. A negative amount is refused with that advice.
--  * The line links to its non-conformance by the NC's id in the source (a reference kind `nonconformance`: the map of an earlier import through the same connection) or by the
--    Fortress reference (SNC-26-0011).
--  * A closed or cancelled NC refuses new cost lines. For an NC an import brought in (it has a row in the import map) a template setting, off by default, lets a cost import add
--    them: `costsOnClosed`. The check lives here: the importer switches on a transaction-local setting that app.assert_ncr_editable honours only together with the map check and
--    the integration source, so no other route can use it. A deleted NC is never accepted.
--  * The source's own booked value in the site currency is optional: when given, it is applied through app.override_cost_rate (kind amount), so the line is Actual, the published
--    rate is kept beside it, and the note says it came from the import.
--  * The person needs the right to change the NC at its site (ncr.update); the importer checks it because the table's insert rule is not applied inside a definer function.
--  * A cost line raises no event and no notice (there is none for costs); the audit trail is written with the import as the actor.

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
-- A closed or cancelled NC an import brought in may be given cost lines, by a cost import that was told so
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.ncr_cost_import_may_edit(p_ncr uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(current_setting('app.ncr_cost_on_closed', true), '') = 'on'
     AND coalesce(current_setting('app.source', true), '') = 'integration'
     AND EXISTS (SELECT 1
                   FROM public.nonconformances n
                   JOIN public.integration_external_records x
                     ON x.organisation_id = n.organisation_id AND x.entity_type = 'nonconformance' AND x.internal_id = n.id
                  WHERE n.id = p_ncr AND n.deleted_at IS NULL)
$$;
REVOKE ALL ON FUNCTION app.ncr_cost_import_may_edit(uuid) FROM PUBLIC, anon, authenticated;

SELECT pg_temp.patch('app.assert_ncr_editable(uuid)'::regprocedure,
  'IF n.stage IN (''closed'', ''cancelled'') THEN',
  'IF n.stage IN (''closed'', ''cancelled'') AND NOT app.ncr_cost_import_may_edit(p_ncr_id) THEN');

-- ---------------------------------------------------------------------------
-- One cost line. Add only. p_on_closed = the template's "costsOnClosed" setting.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.import_ncr_cost(p_org uuid, p_id uuid, d jsonb, p_connection uuid DEFAULT NULL, p_on_closed boolean DEFAULT false) RETURNS uuid
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
  v_stage text; v_deleted timestamptz; v_site uuid; v_system text; v_id uuid; v_amount numeric; v_base text;
BEGIN
  IF p_id IS NOT NULL THEN RAISE EXCEPTION 'Cost lines are only ever added: a correction is a new line' USING ERRCODE = 'QM022'; END IF;
  IF v_ncr IS NULL THEN RAISE EXCEPTION 'Name the non-conformance this cost belongs to' USING ERRCODE = 'QM022'; END IF;
  IF v_type IS NULL THEN RAISE EXCEPTION 'Give the cost type' USING ERRCODE = 'QM022'; END IF;
  IF v_on IS NULL THEN RAISE EXCEPTION 'Give the date the cost was incurred: it decides the exchange rate' USING ERRCODE = 'QM022'; END IF;
  IF v_ccy IS NULL OR v_ccy !~ '^[A-Z]{3}$' THEN RAISE EXCEPTION 'The currency must be a three-letter code such as GBP or EUR' USING ERRCODE = 'QM022'; END IF;
  IF v_unit IS NULL THEN RAISE EXCEPTION 'Give the unit cost (or the total, with a quantity of 1)' USING ERRCODE = 'QM022'; END IF;
  IF v_unit < 0 THEN
    RAISE EXCEPTION 'A cost cannot be negative: import a credit as a supplier recovery or a customer charge' USING ERRCODE = 'QM022';
  END IF;
  IF v_qty <= 0 THEN RAISE EXCEPTION 'The quantity must be above 0' USING ERRCODE = 'QM022'; END IF;
  IF v_vat NOT IN ('none', 'inclusive', 'exclusive') THEN RAISE EXCEPTION 'VAT must be none, inclusive or exclusive' USING ERRCODE = 'QM022'; END IF;
  IF v_pct IS NOT NULL AND (v_pct < 0 OR v_pct >= 100) THEN RAISE EXCEPTION 'The VAT rate is a percentage from 0 to under 100' USING ERRCODE = 'QM022'; END IF;
  IF v_booked IS NOT NULL AND v_booked <= 0 THEN RAISE EXCEPTION 'The value booked in the site currency must be above 0' USING ERRCODE = 'QM022'; END IF;

  SELECT stage, deleted_at, site_id INTO v_stage, v_deleted, v_site FROM public.nonconformances WHERE id = v_ncr AND organisation_id = p_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'That non-conformance was not found' USING ERRCODE = 'QM022'; END IF;
  -- the table's insert rule is not applied inside a definer function, so the right is checked here
  IF NOT app.has_permission(p_org, 'ncr.update', v_site) THEN
    RAISE EXCEPTION 'You are not allowed to add costs to this non-conformance' USING ERRCODE = 'QM022';
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
REVOKE ALL ON FUNCTION app.import_ncr_cost(uuid, uuid, jsonb, uuid, boolean) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The link to a non-conformance: by the Fortress reference (the source id goes through the import map, as for every other kind of record) and the list of values
-- ---------------------------------------------------------------------------
SELECT pg_temp.patch('app.integration_find_by_code(uuid, text, text)'::regprocedure,
  'WHEN ''site'' THEN SELECT id INTO v_id FROM public.sites WHERE organisation_id = p_org AND upper(code) = upper(v_code);',
  'WHEN ''nonconformance'' THEN SELECT id INTO v_id FROM public.nonconformances WHERE organisation_id = p_org AND upper(reference) = upper(v_code) AND deleted_at IS NULL;
    WHEN ''site'' THEN SELECT id INTO v_id FROM public.sites WHERE organisation_id = p_org AND upper(code) = upper(v_code);');

SELECT pg_temp.patch('app.integration_reference_values(uuid, text, text, integer, integer)'::regprocedure,
  '''machine'', ''employee'', ''gauge_type'', ''gauge'') THEN', '''machine'', ''employee'', ''gauge_type'', ''gauge'', ''nonconformance'') THEN');
-- Only for people who may read non-conformances at all: the list shows their titles.
SELECT pg_temp.patch('app.integration_reference_values(uuid, text, text, integer, integer)'::regprocedure,
  'FROM public.gauges ga WHERE p_kind = ''gauge'' AND ga.organisation_id = p_org AND ga.deleted_at IS NULL',
  'FROM public.gauges ga WHERE p_kind = ''gauge'' AND ga.organisation_id = p_org AND ga.deleted_at IS NULL
      UNION ALL SELECT n.reference, n.title, n.stage, n.stage NOT IN (''closed'', ''cancelled''), false FROM public.nonconformances n
        WHERE p_kind = ''nonconformance'' AND n.organisation_id = p_org AND n.deleted_at IS NULL AND n.reference IS NOT NULL AND app.has_permission(p_org, ''ncr.read'')');

-- ---------------------------------------------------------------------------
-- Teach the shared import functions the new kind (as for the legacy calibrations: add only, never matched, nothing disappears)
-- ---------------------------------------------------------------------------
SELECT pg_temp.patch('app.integration_entity_types()'::regprocedure, '''calibration'', ''nonconformance'',', '''calibration'', ''nonconformance'', ''ncr_cost'',');
SELECT pg_temp.patch('app.integration_may_write(uuid, text)'::regprocedure,
  'WHEN ''nonconformance'' THEN app.has_permission(p_org, ''ncr.create'')',
  'WHEN ''ncr_cost'' THEN app.has_permission(p_org, ''ncr.update'') WHEN ''nonconformance'' THEN app.has_permission(p_org, ''ncr.create'')');
SELECT pg_temp.patch('app.system_import_record(uuid, uuid, uuid, uuid, uuid, jsonb)'::regprocedure,
  'r.entity_type IN (''nonconformance'', ''calibration'') THEN ''add_only''', 'r.entity_type IN (''nonconformance'', ''calibration'', ''ncr_cost'') THEN ''add_only''');
SELECT pg_temp.patch('app.system_import_record(uuid, uuid, uuid, uuid, uuid, jsonb)'::regprocedure,
  'WHEN ''nonconformance'' THEN app.import_nonconformance(p_org, p_internal, v_data, r.connection_id)',
  'WHEN ''ncr_cost'' THEN app.import_ncr_cost(p_org, p_internal, v_data, r.connection_id, coalesce((s ->> ''costsOnClosed'')::boolean, false)) WHEN ''nonconformance'' THEN app.import_nonconformance(p_org, p_internal, v_data, r.connection_id)');
SELECT pg_temp.patch('app.integration_settings_for(uuid, text)'::regprocedure,
  'p_entity IN (''nonconformance'', ''goods_receipt'', ''calibration'') THEN ''add_only''', 'p_entity IN (''nonconformance'', ''goods_receipt'', ''calibration'', ''ncr_cost'') THEN ''add_only''');
SELECT pg_temp.patch('app.integration_settings_for(uuid, text)'::regprocedure,
  'p_entity IN (''nonconformance'', ''goods_receipt'', ''po_receipt_total'', ''calibration'') THEN false', 'p_entity IN (''nonconformance'', ''goods_receipt'', ''po_receipt_total'', ''calibration'', ''ncr_cost'') THEN false');
SELECT pg_temp.patch('app.integration_template_settings(text, jsonb)'::regprocedure,
  'p_entity IN (''nonconformance'', ''goods_receipt'', ''calibration'') THEN ''add_only''', 'p_entity IN (''nonconformance'', ''goods_receipt'', ''calibration'', ''ncr_cost'') THEN ''add_only''');
SELECT pg_temp.patch('app.integration_template_settings(text, jsonb)'::regprocedure,
  'p_entity IN (''nonconformance'', ''goods_receipt'', ''po_receipt_total'', ''calibration'') THEN false', 'p_entity IN (''nonconformance'', ''goods_receipt'', ''po_receipt_total'', ''calibration'', ''ncr_cost'') THEN false');
-- A cost template also keeps whether the import may add costs to closed or cancelled NCs it brought in (off unless chosen); other kinds keep exactly what they kept.
SELECT pg_temp.patch('app.integration_template_settings(text, jsonb)'::regprocedure,
  'coalesce((p_settings ->> ''matchExisting'')::boolean, false) END)',
  'coalesce((p_settings ->> ''matchExisting'')::boolean, false) END)
    || CASE WHEN p_entity = ''ncr_cost'' THEN jsonb_build_object(''costsOnClosed'', coalesce((p_settings ->> ''costsOnClosed'')::boolean, false)) ELSE ''{}''::jsonb END');
SELECT pg_temp.patch('app.integration_entity_tracks_missing(text)'::regprocedure,
  '''nonconformance'', ''goods_receipt'', ''po_receipt_total'', ''calibration''', '''nonconformance'', ''goods_receipt'', ''po_receipt_total'', ''calibration'', ''ncr_cost''');
SELECT pg_temp.patch('app.set_integration_import_settings(uuid, text, jsonb)'::regprocedure,
  'p_entity IN (''nonconformance'', ''calibration'') AND (v_mode', 'p_entity IN (''nonconformance'', ''calibration'', ''ncr_cost'') AND (v_mode');
SELECT pg_temp.patch('app.system_stage_integration_records(uuid, uuid, uuid, jsonb, text, boolean)'::regprocedure,
  'r.entity_type NOT IN (''nonconformance'', ''calibration'')', 'r.entity_type NOT IN (''nonconformance'', ''calibration'', ''ncr_cost'')');

-- ---------------------------------------------------------------------------
-- What a cost import will do about currencies, before and after it runs (the preview and the run page)
-- ---------------------------------------------------------------------------
-- Over the run's rows that are not rejected: the lines, per currency how many have a published rate for their date into the site currency (and so will not wait),
-- how many go onto closed and onto cancelled NCs, how many carry the source's booked value, and, for lines already written, how many are still waiting for a rate.
CREATE FUNCTION app.integration_cost_run_summary(p_run uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.integration_sync_runs%ROWTYPE; v_out jsonb; v_org_ccy text;
BEGIN
  SELECT * INTO r FROM public.integration_sync_runs WHERE id = p_run;
  IF NOT FOUND OR NOT app.has_permission(r.organisation_id, 'integrations.read') THEN RAISE EXCEPTION 'Import not found' USING ERRCODE = 'P0002'; END IF;
  IF r.entity_type <> 'ncr_cost' THEN RAISE EXCEPTION 'This summary is for cost imports' USING ERRCODE = 'QM022'; END IF;
  SELECT coalesce(s.base_currency, 'GBP') INTO v_org_ccy FROM public.organisation_settings s WHERE s.organisation_id = r.organisation_id;
  v_org_ccy := coalesce(v_org_ccy, 'GBP');

  WITH rows AS (
    SELECT i.id, i.status, i.internal_id,
           upper(nullif(btrim(i.canonical ->> 'currency'), '')) AS ccy,
           CASE WHEN (i.canonical ->> 'incurredOn') ~ '^\d{4}-\d{2}-\d{2}' THEN least((i.canonical ->> 'incurredOn')::date, current_date) END AS on_day,
           CASE WHEN (i.canonical ->> 'nonconformanceId') ~ '^[0-9a-f-]{36}$' THEN (i.canonical ->> 'nonconformanceId')::uuid END AS ncr,
           nullif(btrim(i.canonical ->> 'bookedValue'), '') IS NOT NULL AS booked
      FROM public.integration_inbox i
     WHERE (i.run_id = r.id OR i.last_run_id = r.id) AND i.entity_type = 'ncr_cost' AND i.status NOT IN ('rejected', 'ignored', 'superseded')
  ), joined AS (
    SELECT x.*, n.stage,
           coalesce(si.currency, v_org_ccy) AS site_ccy,
           c.rate_status AS written_status
      FROM rows x
      LEFT JOIN public.nonconformances n ON n.id = x.ncr AND n.organisation_id = r.organisation_id
      LEFT JOIN public.sites si ON si.id = n.site_id AND si.organisation_id = n.organisation_id
      LEFT JOIN public.ncr_costs c ON c.id = x.internal_id AND c.organisation_id = r.organisation_id
  ), pairs AS (
    -- the cache is asked once per currency, day and site currency, however many lines share them
    SELECT DISTINCT ccy, on_day, site_ccy FROM joined WHERE ccy IS NOT NULL
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
    'waitingNow', (SELECT count(*) FROM rated WHERE written_status = 'needed'))
    INTO v_out;
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION app.integration_cost_run_summary(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.integration_cost_run_summary(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- The exchange rates a run's lines will need and the cache does not hold yet (API login only)
-- ---------------------------------------------------------------------------
-- Before the first line of a run is written (and for a preview, so its summary is true), the API fetches these and stores them, so most lines land with their rate
-- instead of waiting for the worker. The shape is the one app.system_cost_rates_needed answers for lines already written: one entry per (day, currency) with the
-- currencies it must be converted into (the NC's site currency and the organisation's), leaving out what the cache already answers.
CREATE FUNCTION app.system_integration_cost_rates_needed(p_org uuid, p_run uuid, p_owner uuid, p_limit integer DEFAULT 200) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.integration_sync_runs%ROWTYPE; v_org_ccy text; v_out jsonb;
BEGIN
  r := app.integration_run_for_system(p_org, p_run, p_owner);
  IF r.entity_type <> 'ncr_cost' THEN RETURN '[]'::jsonb; END IF;
  SELECT coalesce(s.base_currency, 'GBP') INTO v_org_ccy FROM public.organisation_settings s WHERE s.organisation_id = r.organisation_id;
  v_org_ccy := coalesce(v_org_ccy, 'GBP');
  SELECT coalesce(jsonb_agg(jsonb_build_object('requestedOn', p.d, 'base', p.ccy, 'quotes', p.quotes)), '[]'::jsonb) INTO v_out
  FROM (
    SELECT x.d, x.ccy, array_agg(DISTINCT q) FILTER (WHERE NOT EXISTS (SELECT 1 FROM app.exchange_rate_lookup(x.d, x.ccy, q))) AS quotes
      FROM (
        SELECT least((i.canonical ->> 'incurredOn')::date, current_date) AS d,
               upper(nullif(btrim(i.canonical ->> 'currency'), '')) AS ccy,
               coalesce(si.currency, v_org_ccy) AS site_ccy
          FROM public.integration_inbox i
          LEFT JOIN public.nonconformances n
            ON n.organisation_id = r.organisation_id AND (i.canonical ->> 'nonconformanceId') ~ '^[0-9a-f-]{36}$' AND n.id = (i.canonical ->> 'nonconformanceId')::uuid
          LEFT JOIN public.sites si ON si.id = n.site_id AND si.organisation_id = n.organisation_id
         WHERE (i.run_id = r.id OR i.last_run_id = r.id) AND i.entity_type = 'ncr_cost' AND i.status IN ('staged', 'previewed')
           AND (i.canonical ->> 'incurredOn') ~ '^\d{4}-\d{2}-\d{2}'
      ) x, LATERAL unnest(ARRAY[x.site_ccy, v_org_ccy]) AS q
     WHERE x.ccy ~ '^[A-Z]{3}$' AND q <> x.ccy
     GROUP BY x.d, x.ccy
     LIMIT greatest(least(coalesce(p_limit, 200), 500), 1)
  ) p WHERE p.quotes IS NOT NULL;
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION app.system_integration_cost_rates_needed(uuid, uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.system_integration_cost_rates_needed(uuid, uuid, uuid, integer) TO qms_api;
