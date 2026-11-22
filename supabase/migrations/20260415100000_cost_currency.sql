-- Costs in more than one currency (docs/cost-currency-plan.md, slice CU-A).
--
--   * "Base" on a cost line is now the currency of the site its non-conformance belongs to (sites.currency), with the organisation currency kept
--     beside it for totals across sites. Existing lines keep the organisation currency as their base, which is what they were stated in.
--   * Rates are not typed in. The line looks its rate up in a cache of published rates (public.exchange_rates, written only by the API login from
--     Frankfurter / ECB reference rates). A pair that is not cached or not published makes the line "needed": it saves, but is left out of totals.
--   * A person may state the rate they actually got, or the converted amount (app.override_cost_rate): the line becomes "actual", keeps the
--     automatic rate beside it, and the change is audited. app.reset_cost_rate drops an override or fetches the cached rate again.
--   * supplier_recovery and customer_charge are credits: cost_sign is -1 for them, and every total multiplies by it.
--   * Net figures are what totals add up (workflow fact total_cost included).

-- ---------------------------------------------------------------------------
-- The rate cache (global reference data, not tenant data)
-- ---------------------------------------------------------------------------
CREATE TABLE public.exchange_rates (
  requested_on date NOT NULL,
  base text NOT NULL CHECK (base ~ '^[A-Z]{3}$'),
  quote text NOT NULL CHECK (quote ~ '^[A-Z]{3}$'),
  rate numeric CHECK (rate > 0 AND rate < 1e9),
  rate_date date,
  supported boolean NOT NULL,
  source text NOT NULL DEFAULT 'frankfurter' CHECK (source IN ('frankfurter')),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (requested_on, base, quote),
  CONSTRAINT exchange_rates_pair CHECK (base <> quote),
  CONSTRAINT exchange_rates_supported CHECK (supported = (rate IS NOT NULL AND rate_date IS NOT NULL)),
  CONSTRAINT exchange_rates_rate_date CHECK (rate_date IS NULL OR rate_date <= requested_on)
);
COMMENT ON TABLE public.exchange_rates IS 'Published exchange rates as asked for: the rate for requested_on (rate_date is the business day it was published for). supported = false records a pair the source does not publish.';
ALTER TABLE public.exchange_rates ENABLE ROW LEVEL SECURITY;
CREATE POLICY exchange_rates_select ON public.exchange_rates FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.exchange_rates FROM anon, authenticated;
GRANT SELECT ON public.exchange_rates TO authenticated;

-- What is known for a pair on a day. A past day's entry is final once it was fetched on a later (UTC) day; one fetched the same day is trusted for six
-- hours (the rate for today is published in the afternoon); a pair the source does not publish is remembered for a week. No row = ask the source.
CREATE FUNCTION app.exchange_rate_lookup(p_requested_on date, p_base text, p_quote text)
RETURNS TABLE (supported boolean, rate numeric, rate_date date, fetched_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT r.supported, r.rate, r.rate_date, r.fetched_at
    FROM public.exchange_rates r
   WHERE r.requested_on = least(p_requested_on, current_date) AND r.base = p_base AND r.quote = p_quote
     AND ((r.fetched_at AT TIME ZONE 'UTC')::date > r.requested_on OR r.fetched_at > now() - interval '6 hours')
     AND (r.supported OR r.fetched_at > now() - interval '7 days')
$$;

CREATE FUNCTION app.system_store_exchange_rates(p_rows jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE e jsonb; v_n integer := 0; v_rate numeric; v_rate_date date;
BEGIN
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows) > 200 THEN
    RAISE EXCEPTION 'Rates come as a list of at most 200' USING ERRCODE = '22023';
  END IF;
  FOR e IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    v_rate := nullif(e ->> 'rate', '')::numeric;
    v_rate_date := nullif(e ->> 'rateDate', '')::date;
    INSERT INTO public.exchange_rates (requested_on, base, quote, rate, rate_date, supported)
    VALUES ((e ->> 'requestedOn')::date, e ->> 'base', e ->> 'quote', v_rate, v_rate_date, v_rate IS NOT NULL)
    ON CONFLICT (requested_on, base, quote) DO UPDATE
      SET rate = EXCLUDED.rate, rate_date = EXCLUDED.rate_date, supported = EXCLUDED.supported, fetched_at = now();
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $$;

-- ---------------------------------------------------------------------------
-- A site's currency stops changing once lines are stated in it
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.site_currency_locked() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.currency IS DISTINCT FROM OLD.currency AND EXISTS (
       SELECT 1 FROM public.ncr_costs c JOIN public.nonconformances n ON n.id = c.nonconformance_id AND n.organisation_id = c.organisation_id
        WHERE n.site_id = NEW.id AND c.base_currency = OLD.currency) THEN
    RAISE EXCEPTION 'Costs at this site are already stated in %, so its currency cannot change. Totals add the converted amounts of every cost.', OLD.currency
      USING ERRCODE = 'QM014';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sites_currency_locked BEFORE UPDATE OF currency ON public.sites FOR EACH ROW EXECUTE FUNCTION app.site_currency_locked();

-- ---------------------------------------------------------------------------
-- Cost lines
-- ---------------------------------------------------------------------------
ALTER TABLE public.ncr_costs
  ALTER COLUMN exchange_rate DROP NOT NULL, ALTER COLUMN exchange_rate DROP DEFAULT,
  ALTER COLUMN net_base DROP NOT NULL, ALTER COLUMN net_base DROP DEFAULT,
  ALTER COLUMN gross_base DROP NOT NULL, ALTER COLUMN gross_base DROP DEFAULT,
  ADD COLUMN cost_sign smallint GENERATED ALWAYS AS (CASE WHEN cost_type IN ('supplier_recovery', 'customer_charge') THEN -1 ELSE 1 END) STORED,
  ADD COLUMN org_currency text,
  ADD COLUMN org_rate numeric CHECK (org_rate > 0),
  ADD COLUMN net_org numeric,
  ADD COLUMN gross_org numeric,
  ADD COLUMN rate_status text NOT NULL DEFAULT 'base' CHECK (rate_status IN ('base', 'estimated', 'actual', 'needed')),
  ADD COLUMN rate_source text NOT NULL DEFAULT 'none' CHECK (rate_source IN ('none', 'frankfurter', 'manual')),
  ADD COLUMN rate_date date,
  ADD COLUMN rate_fetched_at timestamptz,
  ADD COLUMN estimated_rate numeric CHECK (estimated_rate > 0),
  ADD COLUMN override_kind text CHECK (override_kind IN ('rate', 'amount')),
  ADD COLUMN override_note text CHECK (override_note IS NULL OR length(override_note) <= 500),
  ADD COLUMN overridden_at timestamptz,
  ADD COLUMN overridden_by uuid REFERENCES auth.users (id) ON DELETE SET NULL;

COMMENT ON COLUMN public.ncr_costs.base_currency IS 'The currency of the site the non-conformance is at (the organisation currency when it has no site), fixed when the line is made';
COMMENT ON COLUMN public.ncr_costs.exchange_rate IS 'Line currency to base currency; null while the rate is needed';
COMMENT ON COLUMN public.ncr_costs.cost_sign IS '-1 for recoveries and charges (credits), +1 otherwise: totals add net × cost_sign';
COMMENT ON COLUMN public.ncr_costs.rate_status IS 'base = same currency, estimated = published rate, actual = stated by a person, needed = no rate yet (left out of totals)';

-- Lines made before this: their base was the organisation currency, so the organisation figures are the same numbers. A rate that was typed is actual.
ALTER TABLE public.ncr_costs DISABLE TRIGGER USER;
UPDATE public.ncr_costs SET
  org_currency = base_currency, org_rate = exchange_rate, net_org = net_base, gross_org = gross_base,
  rate_status = CASE WHEN currency = base_currency THEN 'base' ELSE 'actual' END,
  rate_source = CASE WHEN currency = base_currency THEN 'none' ELSE 'manual' END;
ALTER TABLE public.ncr_costs ENABLE TRIGGER USER;
ALTER TABLE public.ncr_costs ALTER COLUMN org_currency SET NOT NULL;

ALTER TABLE public.ncr_costs
  ADD CONSTRAINT ncr_costs_rate_state CHECK (
    (rate_status = 'needed') = (exchange_rate IS NULL)
    AND (rate_status = 'base') = (currency = base_currency)
    AND (rate_status = 'actual') = (rate_source = 'manual')
    AND (rate_status = 'estimated') = (rate_source = 'frankfurter')
    AND (rate_status <> 'needed' OR (net_base IS NULL AND gross_base IS NULL))
    AND (override_kind IS NULL OR rate_status = 'actual')),
  ADD CONSTRAINT ncr_costs_estimated_dated CHECK (rate_status <> 'estimated' OR (rate_date IS NOT NULL AND rate_fetched_at IS NOT NULL));

-- Nobody types a rate any more: it is looked up, or stated through app.override_cost_rate.
REVOKE UPDATE (exchange_rate) ON public.ncr_costs FROM authenticated;

-- ---------------------------------------------------------------------------
-- The line's arithmetic (replaces the 20251104140000 version; runs after ncr_costs_a_quantity)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.ncr_cost_amounts() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  vat numeric := CASE WHEN NEW.vat_treatment = 'none' THEN 0 ELSE NEW.vat_rate END;
  v_write boolean := coalesce(current_setting('app.cost_rate_write', true), '') = 'on';
  v_reset boolean := coalesce(current_setting('app.cost_rate_reset', true), '') = 'on';
  v_restate boolean := coalesce(current_setting('app.cost_restate', true), '') = 'on';
  v_site_ccy text; v_org_ccy text; v_on date;
  v_keep boolean; r record; ro record;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.nonconformance_id <> OLD.nonconformance_id THEN
    RAISE EXCEPTION 'A cost cannot move to another non-conformance' USING ERRCODE = 'QM005';
  END IF;
  -- User changes need an editable NCR, the right permission and (to delete) a reason.
  IF coalesce(auth.role(), '') = 'authenticated' THEN
    PERFORM app.assert_ncr_editable(NEW.nonconformance_id);
    IF TG_OP = 'UPDATE' AND OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'This cost is deleted' USING ERRCODE = 'QM005';
    END IF;
    IF NEW.deleted_at IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.deleted_at IS NULL) THEN
      IF coalesce(trim(NEW.delete_reason), '') = '' THEN
        RAISE EXCEPTION 'Give a reason for deleting' USING ERRCODE = 'QM005';
      END IF;
      NEW.deleted_at := now();
      NEW.deleted_by := auth.uid();
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.deleted_at IS NULL AND OLD.deleted_at IS NOT NULL THEN
      NEW.deleted_by := NULL;
      NEW.delete_reason := NULL;
    END IF;
  END IF;

  -- VAT: net, VAT and gross in the line's own currency.
  IF NEW.vat_treatment = 'inclusive' THEN
    NEW.gross_amount := round(NEW.amount, 2);
    NEW.net_amount := round(NEW.amount / (1 + vat), 2);
  ELSIF NEW.vat_treatment = 'exclusive' THEN
    NEW.net_amount := round(NEW.amount, 2);
    NEW.gross_amount := round(NEW.amount * (1 + vat), 2);
  ELSE
    NEW.net_amount := round(NEW.amount, 2);
    NEW.gross_amount := round(NEW.amount, 2);
  END IF;
  NEW.vat_amount := NEW.gross_amount - NEW.net_amount;
  IF NEW.vat_treatment = 'none' THEN
    NEW.vat_rate := 0;
  END IF;

  -- The currencies: the site's (the organisation's when the NC has no site) and the organisation's. Fixed when the line is made; a restate moves
  -- only the site's.
  SELECT coalesce(si.currency, st.base_currency, 'GBP'), coalesce(st.base_currency, 'GBP') INTO v_site_ccy, v_org_ccy
    FROM public.nonconformances n
    LEFT JOIN public.sites si ON si.id = n.site_id AND si.organisation_id = n.organisation_id
    LEFT JOIN public.organisation_settings st ON st.organisation_id = n.organisation_id
   WHERE n.id = NEW.nonconformance_id;
  v_site_ccy := coalesce(v_site_ccy, 'GBP');
  v_org_ccy := coalesce(v_org_ccy, 'GBP');
  IF TG_OP = 'INSERT' THEN
    NEW.base_currency := v_site_ccy;
    NEW.org_currency := v_org_ccy;
  ELSE
    NEW.org_currency := OLD.org_currency;
    NEW.base_currency := CASE WHEN v_restate THEN v_site_ccy ELSE OLD.base_currency END;
  END IF;

  v_on := least(NEW.incurred_on, current_date);

  -- Step A: the rate into the base currency. Kept as it is while only the amount changes; looked up when the line is new, its currency or date
  -- changed, it is waiting for a rate, or it is being reset; a person's own figure (app.override_cost_rate) is taken as it comes.
  v_keep := TG_OP = 'UPDATE' AND NOT v_write AND NOT v_reset AND NOT v_restate
            AND NEW.currency = OLD.currency AND NEW.incurred_on = OLD.incurred_on AND OLD.rate_status <> 'needed';
  IF NOT v_keep AND NOT v_write THEN
    NEW.override_kind := NULL; NEW.override_note := NULL; NEW.overridden_at := NULL; NEW.overridden_by := NULL;
    NEW.exchange_rate := NULL; NEW.estimated_rate := NULL; NEW.rate_date := NULL; NEW.rate_fetched_at := NULL;
    IF NEW.currency = NEW.base_currency THEN
      NEW.rate_status := 'base'; NEW.rate_source := 'none'; NEW.exchange_rate := 1;
    ELSE
      SELECT * INTO r FROM app.exchange_rate_lookup(v_on, NEW.currency, NEW.base_currency);
      IF FOUND AND r.supported THEN
        NEW.rate_status := 'estimated'; NEW.rate_source := 'frankfurter'; NEW.exchange_rate := r.rate;
        NEW.estimated_rate := r.rate; NEW.rate_date := r.rate_date; NEW.rate_fetched_at := r.fetched_at;
      ELSE
        NEW.rate_status := 'needed'; NEW.rate_source := 'none';
      END IF;
    END IF;
  END IF;
  IF NEW.currency = NEW.base_currency AND v_write THEN
    RAISE EXCEPTION 'This cost is already in %, so there is no rate to set', NEW.base_currency USING ERRCODE = 'QM005';
  END IF;

  IF NEW.exchange_rate IS NULL THEN
    NEW.net_base := NULL; NEW.gross_base := NULL;
  ELSE
    NEW.net_base := round(NEW.net_amount * NEW.exchange_rate, 2);
    NEW.gross_base := round(NEW.gross_amount * NEW.exchange_rate, 2);
  END IF;

  -- Step B: the rate into the organisation currency (for totals across sites). A restate leaves the organisation figures exactly as they were.
  IF TG_OP = 'UPDATE' AND v_restate THEN
    NEW.org_rate := OLD.org_rate;
  ELSIF NEW.org_currency = NEW.currency THEN
    NEW.org_rate := 1;
  ELSIF NEW.org_currency = NEW.base_currency THEN
    NEW.org_rate := NEW.exchange_rate;
  ELSIF v_keep AND NEW.org_rate IS NOT NULL THEN
    NULL; -- only the amount changed: the same rate
  ELSIF NEW.rate_status = 'actual' THEN
    -- A person's figure in the site currency, taken into the organisation currency at the published rate between the two.
    SELECT * INTO ro FROM app.exchange_rate_lookup(v_on, NEW.base_currency, NEW.org_currency);
    NEW.org_rate := CASE WHEN FOUND AND ro.supported AND NEW.exchange_rate IS NOT NULL THEN NEW.exchange_rate * ro.rate END;
  ELSE
    SELECT * INTO ro FROM app.exchange_rate_lookup(v_on, NEW.currency, NEW.org_currency);
    NEW.org_rate := CASE WHEN FOUND AND ro.supported THEN ro.rate END;
  END IF;
  IF NEW.org_rate IS NULL THEN
    NEW.net_org := NULL; NEW.gross_org := NULL;
  ELSE
    NEW.net_org := round(NEW.net_amount * NEW.org_rate, 2);
    NEW.gross_org := round(NEW.gross_amount * NEW.org_rate, 2);
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- Stating the actual rate, dropping it, filling waiting lines, restating
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.cost_for_rate_change(p_cost uuid) RETURNS public.ncr_costs
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.ncr_costs;
BEGIN
  SELECT k.* INTO c FROM public.ncr_costs k WHERE k.id = p_cost;
  IF NOT FOUND OR NOT app.is_member(c.organisation_id) THEN
    RAISE EXCEPTION 'Cost not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT app.has_permission(c.organisation_id, 'ncr.update', app.ncr_site(c.nonconformance_id)) THEN
    RAISE EXCEPTION 'You are not allowed to change this cost' USING ERRCODE = '42501';
  END IF;
  PERFORM app.assert_ncr_editable(c.nonconformance_id);
  IF c.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'This cost is deleted' USING ERRCODE = 'QM005';
  END IF;
  RETURN c;
END $$;

-- kind 'rate': the rate actually got (1 line currency = value base currency). kind 'amount': the converted value of the amount that was entered
-- (the rate is worked out). The line becomes actual; the automatic rate is kept beside it.
CREATE FUNCTION app.override_cost_rate(p_cost uuid, p_kind text, p_value numeric, p_note text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.ncr_costs; v_rate numeric; v_note text := nullif(btrim(p_note), '');
BEGIN
  c := app.cost_for_rate_change(p_cost);
  IF c.currency = c.base_currency THEN
    RAISE EXCEPTION 'This cost is already in %, so there is no rate to set', c.base_currency USING ERRCODE = 'QM005';
  END IF;
  IF p_kind NOT IN ('rate', 'amount') THEN
    RAISE EXCEPTION 'State the rate or the converted amount' USING ERRCODE = 'QM005';
  END IF;
  IF p_value IS NULL OR p_value <= 0 OR p_value >= 1e12 THEN
    RAISE EXCEPTION 'Enter a value above 0' USING ERRCODE = 'QM005';
  END IF;
  IF v_note IS NOT NULL AND length(v_note) > 500 THEN
    RAISE EXCEPTION 'The note can be at most 500 characters' USING ERRCODE = 'QM005';
  END IF;
  IF p_kind = 'rate' THEN
    v_rate := p_value;
  ELSE
    IF c.amount <= 0 THEN
      RAISE EXCEPTION 'The cost has no amount to convert' USING ERRCODE = 'QM005';
    END IF;
    v_rate := p_value / c.amount;
  END IF;
  IF v_rate < 0.000000001 OR v_rate >= 1e9 THEN
    RAISE EXCEPTION 'That is not a sensible rate' USING ERRCODE = 'QM005';
  END IF;
  PERFORM set_config('app.cost_rate_write', 'on', true);
  UPDATE public.ncr_costs SET
    exchange_rate = v_rate, rate_status = 'actual', rate_source = 'manual', rate_date = NULL, rate_fetched_at = NULL,
    estimated_rate = CASE WHEN c.rate_status = 'estimated' THEN c.exchange_rate ELSE c.estimated_rate END,
    override_kind = p_kind, override_note = v_note, overridden_at = now(), overridden_by = auth.uid()
   WHERE id = p_cost;
  PERFORM set_config('app.cost_rate_write', 'off', true);
  RETURN p_cost;
END $$;

-- Drops a stated rate and takes the published one again (also what "refresh" means for a line dated today).
CREATE FUNCTION app.reset_cost_rate(p_cost uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.ncr_costs;
BEGIN
  c := app.cost_for_rate_change(p_cost);
  IF c.currency = c.base_currency THEN
    RETURN p_cost;
  END IF;
  PERFORM set_config('app.cost_rate_reset', 'on', true);
  UPDATE public.ncr_costs SET description = description WHERE id = p_cost;
  PERFORM set_config('app.cost_rate_reset', 'off', true);
  RETURN p_cost;
END $$;

-- After the API has cached the rates that were missing: gives the lines waiting for one their rate (the API login only). One organisation, or all of them
-- (the worker). Only lines a cached published rate can now help are touched, so a pair the source never publishes causes no churn.
CREATE FUNCTION app.system_fill_cost_rates(p_organisation_id uuid DEFAULT NULL, p_ids uuid[] DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_n integer;
BEGIN
  UPDATE public.ncr_costs SET description = description
   WHERE id IN (
     SELECT k.id FROM public.ncr_costs k
      WHERE (p_organisation_id IS NULL OR k.organisation_id = p_organisation_id) AND (p_ids IS NULL OR k.id = ANY (p_ids)) AND k.currency <> k.base_currency
        AND ((k.rate_status = 'needed' AND EXISTS (SELECT 1 FROM app.exchange_rate_lookup(least(k.incurred_on, current_date), k.currency, k.base_currency) l WHERE l.supported))
          OR (k.org_rate IS NULL AND k.org_currency <> k.currency
              AND (EXISTS (SELECT 1 FROM app.exchange_rate_lookup(least(k.incurred_on, current_date), k.currency, k.org_currency) l WHERE l.supported)
                OR EXISTS (SELECT 1 FROM app.exchange_rate_lookup(least(k.incurred_on, current_date), k.base_currency, k.org_currency) l WHERE l.supported))))
      ORDER BY k.created_at LIMIT 500);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

-- Lines still waiting for a rate, as pairs the API can ask the source for (the API login only).
CREATE FUNCTION app.system_cost_rates_needed(p_organisation_id uuid DEFAULT NULL, p_limit integer DEFAULT 100) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('organisationId', p.organisation_id, 'requestedOn', p.d, 'base', p.currency, 'quotes', p.quotes)), '[]'::jsonb)
  FROM (
    SELECT k.organisation_id, least(k.incurred_on, current_date) AS d, k.currency,
           array_agg(DISTINCT q) FILTER (WHERE NOT EXISTS (SELECT 1 FROM app.exchange_rate_lookup(least(k.incurred_on, current_date), k.currency, q))) AS quotes
      FROM public.ncr_costs k, LATERAL unnest(ARRAY[k.base_currency, k.org_currency]) AS q
     WHERE (p_organisation_id IS NULL OR k.organisation_id = p_organisation_id) AND k.currency <> k.base_currency
       AND (k.rate_status = 'needed' OR k.org_rate IS NULL) AND q <> k.currency
     GROUP BY k.organisation_id, least(k.incurred_on, current_date), k.currency
     LIMIT greatest(least(coalesce(p_limit, 100), 500), 1)
  ) p WHERE p.quotes IS NOT NULL
$$;

-- Sites whose currency is not the one their lines were stated in, and which rates a restate would need that are not cached yet. Nothing changes.
CREATE FUNCTION app.restate_cost_report(p_organisation_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v jsonb;
BEGIN
  IF NOT app.is_member(p_organisation_id) THEN
    RAISE EXCEPTION 'Organisation not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT app.has_permission(p_organisation_id, 'organisation.manage') THEN
    RAISE EXCEPTION 'You are not allowed to restate costs' USING ERRCODE = '42501';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'siteId', s.id, 'code', s.code, 'name', s.name, 'siteCurrency', s.currency, 'lines', s.lines, 'statedIn', s.stated_in,
           'missing', (SELECT coalesce(jsonb_agg(jsonb_build_object('requestedOn', m.d, 'base', m.currency, 'quote', s.currency)), '[]'::jsonb)
                         FROM (SELECT DISTINCT least(k.incurred_on, current_date) AS d, k.currency
                                 FROM public.ncr_costs k JOIN public.nonconformances n ON n.id = k.nonconformance_id AND n.organisation_id = k.organisation_id
                                WHERE n.site_id = s.id AND k.organisation_id = p_organisation_id AND k.base_currency <> s.currency AND k.currency <> s.currency
                                  AND NOT EXISTS (SELECT 1 FROM app.exchange_rate_lookup(least(k.incurred_on, current_date), k.currency, s.currency)) LIMIT 500) m)
         ) ORDER BY s.code), '[]'::jsonb) INTO v
    FROM (
      SELECT si.id, si.code, si.name, si.currency, count(*) AS lines, array_agg(DISTINCT k.base_currency ORDER BY k.base_currency) AS stated_in
        FROM public.ncr_costs k
        JOIN public.nonconformances n ON n.id = k.nonconformance_id AND n.organisation_id = k.organisation_id
        JOIN public.sites si ON si.id = n.site_id AND si.organisation_id = n.organisation_id
       WHERE k.organisation_id = p_organisation_id AND k.base_currency <> si.currency
       GROUP BY si.id, si.code, si.name, si.currency) s;
  RETURN jsonb_build_object('sites', v);
END $$;

-- Restates one site's lines into its currency with the cached published rates (the API login only, after it checked organisation.manage and cached
-- the rates). Organisation figures stay exactly as they were; a line with no published rate becomes "needed".
CREATE FUNCTION app.system_restate_costs(p_organisation_id uuid, p_site_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_site_ccy text; v_n integer; v_needed integer;
BEGIN
  SELECT s.currency INTO v_site_ccy FROM public.sites s WHERE s.id = p_site_id AND s.organisation_id = p_organisation_id;
  IF v_site_ccy IS NULL THEN
    RAISE EXCEPTION 'Site not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM set_config('app.cost_restate', 'on', true);
  UPDATE public.ncr_costs SET description = description
   WHERE organisation_id = p_organisation_id AND base_currency <> v_site_ccy
     AND nonconformance_id IN (SELECT n.id FROM public.nonconformances n WHERE n.site_id = p_site_id AND n.organisation_id = p_organisation_id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('app.cost_restate', 'off', true);
  SELECT count(*) INTO v_needed FROM public.ncr_costs k
   WHERE k.organisation_id = p_organisation_id AND k.rate_status = 'needed'
     AND k.nonconformance_id IN (SELECT n.id FROM public.nonconformances n WHERE n.site_id = p_site_id AND n.organisation_id = p_organisation_id);
  RETURN jsonb_build_object('restated', v_n, 'needed', v_needed);
END $$;

-- An NC with costs does not move to a site whose currency is not the one its costs are stated in.
CREATE FUNCTION app.nonconformance_site_currency_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_new text; v_old text;
BEGIN
  IF NEW.site_id IS DISTINCT FROM OLD.site_id AND EXISTS (SELECT 1 FROM public.ncr_costs c WHERE c.nonconformance_id = NEW.id) THEN
    v_new := coalesce((SELECT s.currency FROM public.sites s WHERE s.id = NEW.site_id AND s.organisation_id = NEW.organisation_id),
                      (SELECT st.base_currency FROM public.organisation_settings st WHERE st.organisation_id = NEW.organisation_id), 'GBP');
    SELECT c.base_currency INTO v_old FROM public.ncr_costs c WHERE c.nonconformance_id = NEW.id AND c.base_currency <> v_new LIMIT 1;
    IF v_old IS NOT NULL THEN
      RAISE EXCEPTION 'This non-conformance has costs stated in %, but the site you are moving it to works in %. Costs are stated in the currency of the site.', v_old, v_new
        USING ERRCODE = 'QM005';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER nonconformances_site_currency BEFORE UPDATE OF site_id ON public.nonconformances
  FOR EACH ROW EXECUTE FUNCTION app.nonconformance_site_currency_guard();

-- ---------------------------------------------------------------------------
-- The workflow fact total_cost: net, in the organisation currency, credits taken off (one number a rule can compare across sites)
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_def text; v_old text := 'SELECT coalesce(sum(k.net_base), 0) FROM public.ncr_costs k';
BEGIN
  SELECT pg_get_functiondef('app.system_workflow_facts(uuid, text, uuid, jsonb)'::regprocedure) INTO v_def;
  IF position(v_old IN v_def) = 0 THEN
    RAISE EXCEPTION 'system_workflow_facts no longer sums net_base the way this migration expects';
  END IF;
  EXECUTE replace(v_def, v_old, 'SELECT coalesce(sum(k.net_org * k.cost_sign), 0) FROM public.ncr_costs k');
END $$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app.exchange_rate_lookup(date, text, text), app.system_store_exchange_rates(jsonb), app.site_currency_locked(),
  app.cost_for_rate_change(uuid), app.override_cost_rate(uuid, text, numeric, text), app.reset_cost_rate(uuid),
  app.system_fill_cost_rates(uuid, uuid[]), app.system_cost_rates_needed(uuid, integer), app.restate_cost_report(uuid),
  app.system_restate_costs(uuid, uuid), app.nonconformance_site_currency_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.exchange_rate_lookup(date, text, text), app.override_cost_rate(uuid, text, numeric, text),
  app.reset_cost_rate(uuid), app.restate_cost_report(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION app.exchange_rate_lookup(date, text, text), app.system_store_exchange_rates(jsonb), app.system_fill_cost_rates(uuid, uuid[]),
  app.system_cost_rates_needed(uuid, integer), app.system_restate_costs(uuid, uuid) TO qms_api;
