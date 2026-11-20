-- Costs in more than one currency (docs/cost-currency-plan.md CU-A): the site currency as the base, rates looked up from the cache and never typed,
-- "needed" lines, actual-rate overrides (rate or converted amount), credits, the organisation figures, the currency locks, the restate and isolation.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('22000000-0000-0000-0000-000000000101', 'owner@fx.test'),
  ('22000000-0000-0000-0000-000000000102', 'viewer@fx.test'),
  ('22000000-0000-0000-0000-000000000103', 'other@fx.test');

CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);
GRANT SELECT ON ids TO authenticated;

CREATE FUNCTION pg_temp.line(p_id uuid) RETURNS text LANGUAGE sql AS $$
  SELECT concat_ws('|', rate_status, rate_source, coalesce(exchange_rate::text, '-'), coalesce(net_base::text, '-'), coalesce(gross_base::text, '-'),
                   base_currency, org_currency, coalesce(org_rate::text, '-'), coalesce(net_org::text, '-'))
    FROM public.ncr_costs WHERE id = p_id
$$;

DO $$
DECLARE
  org uuid; other uuid; site_a uuid; site_b uuid; site_c uuid; ncr_a uuid; ncr_b uuid; ncr_c uuid; c uuid; c2 uuid; m uuid; d date := current_date - 10;
BEGIN
  PERFORM pg_temp.login('22000000-0000-0000-0000-000000000101');
  org := app.create_organisation('FX Works', 'Plant A', 'PA', NULL);
  SELECT id INTO site_a FROM public.sites WHERE organisation_id = org;
  INSERT INTO public.sites (organisation_id, code, name) VALUES (org, 'PB', 'Plant B') RETURNING id INTO site_b;
  INSERT INTO public.sites (organisation_id, code, name) VALUES (org, 'PC', 'Plant C') RETURNING id INTO site_c;
  UPDATE public.organisation_settings SET base_currency = 'GBP', vat_rate = 0.2 WHERE organisation_id = org;
  UPDATE public.sites SET currency = 'EUR' WHERE id = site_b;
  PERFORM pg_temp.assert_eq((SELECT currency FROM public.sites WHERE id = site_a), 'GBP', 'a site starts in the organisation currency');
  INSERT INTO public.nonconformances (organisation_id, reference, source, stage, title, site_id, severity, quantity_affected, description, category_id)
    VALUES (org, 'x', 'internal', 'open', 'At plant A', site_a, 'major', 10, 'Scrap', pg_temp.cat(org)) RETURNING id INTO ncr_a;
  INSERT INTO public.nonconformances (organisation_id, reference, source, title, site_id) VALUES (org, 'x', 'internal', 'At plant B', site_b) RETURNING id INTO ncr_b;
  INSERT INTO public.nonconformances (organisation_id, reference, source, title, site_id) VALUES (org, 'x', 'internal', 'At plant C', site_c) RETURNING id INTO ncr_c;

  PERFORM pg_temp.seed_rate(current_date, 'EUR', 'GBP', 0.85);
  PERFORM pg_temp.seed_rate(current_date, 'GBP', 'EUR', 1.17);
  PERFORM pg_temp.seed_rate(current_date, 'USD', 'EUR', 0.92);
  PERFORM pg_temp.seed_rate(current_date, 'USD', 'GBP', 0.79);

  -- Same currency: rate 1, nothing to look up.
  INSERT INTO public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, amount) VALUES (org, ncr_a, 'scrap', 'GBP', 100) RETURNING id INTO c;
  PERFORM pg_temp.assert_eq(pg_temp.line(c), 'base|none|1|100.00|100.00|GBP|GBP|1|100.00', 'a cost in the site currency uses rate 1');

  -- Foreign currency: the published rate, with its day; a rate sent by the client is ignored on create.
  INSERT INTO public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, amount, exchange_rate, rate_status, rate_source, override_kind, net_org)
    VALUES (org, ncr_a, 'transport', 'EUR', 50, 99, 'actual', 'manual', 'rate', 12345) RETURNING id INTO c;
  PERFORM pg_temp.assert_eq(pg_temp.line(c), 'estimated|frankfurter|0.85|42.50|42.50|GBP|GBP|0.85|42.50', 'rate looked up; a typed rate and status are ignored');
  PERFORM pg_temp.assert_eq((SELECT (rate_date = current_date) || '|' || (estimated_rate = 0.85) || '|' || coalesce(override_kind, '-') FROM public.ncr_costs WHERE id = c), 'true|true|-', 'rate day and estimate kept, no override');

  -- No cached rate, a pair the source does not publish, and a stale same-day entry: all "needed", left out of totals.
  INSERT INTO public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, amount) VALUES (org, ncr_a, 'labour', 'CAD', 80) RETURNING id INTO c;
  PERFORM pg_temp.assert_eq(pg_temp.line(c), 'needed|none|-|-|-|GBP|GBP|-|-', 'no cached rate: the line saves as needed');
  PERFORM pg_temp.seed_unsupported(current_date, 'AED', 'GBP');
  INSERT INTO public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, amount) VALUES (org, ncr_a, 'labour', 'AED', 80) RETURNING id INTO c;
  PERFORM pg_temp.assert_eq((SELECT rate_status FROM public.ncr_costs WHERE id = c), 'needed', 'a currency the source does not publish is needed');
  PERFORM pg_temp.logout();
  INSERT INTO public.exchange_rates (requested_on, base, quote, rate, rate_date, supported, fetched_at) VALUES (current_date, 'SEK', 'GBP', 0.08, current_date, true, now() - interval '7 hours');
  PERFORM pg_temp.login('22000000-0000-0000-0000-000000000101');
  INSERT INTO public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, amount) VALUES (org, ncr_a, 'labour', 'SEK', 1000) RETURNING id INTO c;
  PERFORM pg_temp.assert_eq((SELECT rate_status FROM public.ncr_costs WHERE id = c), 'needed', 'a same-day rate older than six hours is asked for again');
  PERFORM pg_temp.assert_eq((SELECT coalesce(sum(net_base), 0) FROM public.ncr_costs WHERE nonconformance_id = ncr_a AND rate_status = 'needed'), 0::numeric, 'needed lines add nothing');

  -- A past weekend day answers with the business day before; a future date uses today's rate.
  PERFORM pg_temp.logout();
  INSERT INTO public.exchange_rates (requested_on, base, quote, rate, rate_date, supported, fetched_at) VALUES (d, 'CHF', 'GBP', 1.1, d - 1, true, (d + 1)::timestamptz + interval '12 hours');
  PERFORM pg_temp.login('22000000-0000-0000-0000-000000000101');
  INSERT INTO public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, amount, incurred_on) VALUES (org, ncr_a, 'rework', 'CHF', 10, d) RETURNING id INTO c;
  PERFORM pg_temp.assert_eq((SELECT rate_date FROM public.ncr_costs WHERE id = c), d - 1, 'the rate day is the business day it was published for');
  INSERT INTO public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, amount, incurred_on) VALUES (org, ncr_a, 'rework', 'EUR', 10, current_date + 5) RETURNING id INTO c;
  PERFORM pg_temp.assert_eq((SELECT rate_date || '|' || exchange_rate FROM public.ncr_costs WHERE id = c), current_date || '|0.85', 'a future date uses today''s rate');

  -- Credits: recoveries and charges carry -1, everything else +1.
  INSERT INTO public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, amount) VALUES (org, ncr_a, 'supplier_recovery', 'GBP', 30) RETURNING id INTO c;
  PERFORM pg_temp.assert_eq((SELECT cost_sign FROM public.ncr_costs WHERE id = c), (-1)::smallint, 'a recovery is a credit');
  INSERT INTO public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, amount) VALUES (org, ncr_a, 'customer_charge', 'GBP', 5) RETURNING id INTO c;
  PERFORM pg_temp.assert_eq((SELECT cost_sign FROM public.ncr_costs WHERE id = c), (-1)::smallint, 'a customer charge is a credit');
  PERFORM pg_temp.assert_eq((SELECT cost_sign FROM public.ncr_costs WHERE nonconformance_id = ncr_a AND cost_type = 'scrap'), 1::smallint, 'a cost is +1');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.ncr_costs SET cost_sign = 1 WHERE id = %L$q$, c), 'the sign cannot be written');

  -- A site in another currency: the line is stated in the site currency, the organisation figure beside it.
  INSERT INTO public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, amount) VALUES (org, ncr_b, 'scrap', 'GBP', 100) RETURNING id INTO c;
  PERFORM pg_temp.assert_eq(pg_temp.line(c), 'estimated|frankfurter|1.17|117.00|117.00|EUR|GBP|1|100.00', 'site in euros: line in sterling converts to euros, organisation figure unchanged');
  INSERT INTO public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, amount) VALUES (org, ncr_b, 'scrap', 'USD', 100) RETURNING id INTO c;
  PERFORM pg_temp.assert_eq(pg_temp.line(c), 'estimated|frankfurter|0.92|92.00|92.00|EUR|GBP|0.79|79.00', 'a third currency converts to both');
  INSERT INTO public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, amount) VALUES (org, ncr_b, 'scrap', 'EUR', 40) RETURNING id INTO c2;
  PERFORM pg_temp.assert_eq(pg_temp.line(c2), 'base|none|1|40.00|40.00|EUR|GBP|0.85|34.00', 'in the site currency: rate 1; organisation figure at the published rate');

  -- Override by rate: actual, the published rate kept beside it, the organisation figure follows through the rate between site and organisation.
  PERFORM app.override_cost_rate(c, 'rate', 0.95, 'Bank rate on the invoice');
  PERFORM pg_temp.assert_eq(pg_temp.line(c), 'actual|manual|0.95|95.00|95.00|EUR|GBP|0.8075|80.75', 'actual rate stated');
  PERFORM pg_temp.assert_eq((SELECT estimated_rate || '|' || override_kind || '|' || override_note || '|' || (overridden_by = '22000000-0000-0000-0000-000000000101')::text || '|' || (overridden_at IS NOT NULL)::text FROM public.ncr_costs WHERE id = c),
    '0.92|rate|Bank rate on the invoice|true|true', 'the published rate, the way, the note and who are kept');
  -- Override by converted amount, VAT inclusive: the converted value of the amount entered.
  INSERT INTO public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, vat_treatment, vat_rate, amount) VALUES (org, ncr_a, 'material', 'EUR', 'inclusive', 0.2, 120) RETURNING id INTO c;
  PERFORM pg_temp.assert_eq(pg_temp.line(c), 'estimated|frankfurter|0.85|85.00|102.00|GBP|GBP|0.85|85.00', 'estimate first');
  PERFORM app.override_cost_rate(c, 'amount', 100);
  PERFORM pg_temp.assert_eq((SELECT rate_status || '|' || net_base || '|' || gross_base || '|' || override_kind || '|' || estimated_rate FROM public.ncr_costs WHERE id = c), 'actual|83.33|100.00|amount|0.85', 'converted amount stated: gross comes to exactly what was typed');
  -- Editing the amount keeps the stated rate; changing the currency or the day drops it.
  UPDATE public.ncr_costs SET unit_cost = 240 WHERE id = c;
  PERFORM pg_temp.assert_eq((SELECT rate_status || '|' || gross_amount || '|' || gross_base FROM public.ncr_costs WHERE id = c), 'actual|240.00|200.00', 'a new amount keeps the stated rate');
  UPDATE public.ncr_costs SET currency = 'USD' WHERE id = c;
  PERFORM pg_temp.assert_eq((SELECT rate_status || '|' || coalesce(override_kind, '-') || '|' || exchange_rate FROM public.ncr_costs WHERE id = c), 'estimated|-|0.79', 'a new currency drops the stated rate');
  PERFORM app.override_cost_rate(c, 'rate', 0.8);
  UPDATE public.ncr_costs SET incurred_on = current_date - 1 WHERE id = c;
  PERFORM pg_temp.assert_eq((SELECT rate_status FROM public.ncr_costs WHERE id = c), 'needed', 'a new day drops the stated rate (and there is no rate for yesterday cached)');
  -- Reset: the published rate again.
  PERFORM pg_temp.seed_rate(current_date - 1, 'USD', 'GBP', 0.78);
  PERFORM app.reset_cost_rate(c);
  PERFORM pg_temp.assert_eq((SELECT rate_status || '|' || exchange_rate FROM public.ncr_costs WHERE id = c), 'estimated|0.78', 'reset takes the published rate');
  PERFORM app.override_cost_rate(c, 'rate', 0.8);
  PERFORM app.reset_cost_rate(c);
  PERFORM pg_temp.assert_eq((SELECT rate_status || '|' || exchange_rate || '|' || coalesce(override_kind, '-') FROM public.ncr_costs WHERE id = c), 'estimated|0.78|-', 'reset drops a stated rate');

  -- Refusals.
  PERFORM pg_temp.assert_fails(format($q$SELECT app.override_cost_rate(%L, 'rate', 0)$q$, c), 'a rate above 0');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.override_cost_rate(%L, 'rate', 1e12)$q$, c), 'a sensible value');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.override_cost_rate(%L, 'percent', 1)$q$, c), 'rate or amount');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.override_cost_rate(%L, 'rate', 1, %L)$q$, c, repeat('x', 501)), 'a short note');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.override_cost_rate(%L, 'rate', 1e-12)$q$, c), 'not a vanishing rate');
  SELECT id INTO c2 FROM public.ncr_costs WHERE nonconformance_id = ncr_a AND currency = 'GBP' AND cost_type = 'scrap';
  PERFORM pg_temp.assert_fails(format($q$SELECT app.override_cost_rate(%L, 'rate', 1)$q$, c2), 'no rate for a line already in the site currency');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.ncr_costs SET exchange_rate = 2 WHERE id = %L$q$, c), 'the rate cannot be typed on a cost');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.ncr_costs SET rate_status = 'actual' WHERE id = %L$q$, c), 'nor the status');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.ncr_costs SET net_org = 1 WHERE id = %L$q$, c), 'nor the organisation figure');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.ncr_costs SET override_kind = 'rate' WHERE id = %L$q$, c), 'nor an override');

  -- A deleted cost cannot be overridden.
  INSERT INTO public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, amount) VALUES (org, ncr_a, 'rework', 'EUR', 5) RETURNING id INTO c2;
  UPDATE public.ncr_costs SET deleted_at = now(), delete_reason = 'Duplicate' WHERE id = c2;
  PERFORM pg_temp.assert_fails(format($q$SELECT app.override_cost_rate(%L, 'rate', 1)$q$, c2), 'a deleted cost is locked');

  -- Site currency locks.
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.sites SET currency = 'USD' WHERE id = %L$q$, site_b), 'a site''s currency is locked once lines are stated in it');
  PERFORM pg_temp.assert_ok(format($q$UPDATE public.sites SET currency = 'USD' WHERE id = %L$q$, site_c), 'a site with no costs can change currency');
  UPDATE public.sites SET currency = 'GBP' WHERE id = site_c;
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.nonconformances SET site_id = %L WHERE id = %L$q$, site_a, ncr_b), 'an NC with costs in euros does not move to a sterling site');
  PERFORM pg_temp.assert_ok(format($q$UPDATE public.nonconformances SET site_id = %L WHERE id = %L$q$, site_b, ncr_b), 'moving within the same site is fine');

  -- Members: a viewer cannot state a rate; an outsider has no access to the cost at all.
  PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '22000000-0000-0000-0000-000000000102', 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  PERFORM pg_temp.login('22000000-0000-0000-0000-000000000103');
  other := app.create_organisation('Other Works', 'Main', 'MN', NULL);
  PERFORM pg_temp.logout();
  INSERT INTO ids VALUES ('org', org), ('other', other), ('ncr_a', ncr_a), ('ncr_b', ncr_b), ('ncr_c', ncr_c), ('site_c', site_c), ('cost', c);
END $$;

DO $$
DECLARE
  org uuid := (SELECT v FROM ids WHERE k = 'org'); c uuid := (SELECT v FROM ids WHERE k = 'cost');
  ncr_a uuid := (SELECT v FROM ids WHERE k = 'ncr_a'); ncr_c uuid := (SELECT v FROM ids WHERE k = 'ncr_c'); site_c uuid := (SELECT v FROM ids WHERE k = 'site_c');
  l uuid; v jsonb;
BEGIN
  PERFORM pg_temp.login('22000000-0000-0000-0000-000000000102');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.override_cost_rate(%L, 'rate', 1)$q$, c), 'a viewer cannot state a rate');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.reset_cost_rate(%L)$q$, c), 'nor reset one');
  PERFORM pg_temp.login('22000000-0000-0000-0000-000000000103');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.override_cost_rate(%L, 'rate', 1)$q$, c), 'another organisation cannot reach the cost');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.exchange_rates) > 0, true, 'published rates are readable by anyone signed in');
  PERFORM pg_temp.assert_fails($q$INSERT INTO public.exchange_rates (requested_on, base, quote, rate, rate_date, supported) VALUES (current_date, 'NOK', 'GBP', 0.07, current_date, true)$q$, 'nobody signed in writes a rate');
  PERFORM pg_temp.assert_fails($q$UPDATE public.exchange_rates SET rate = 5$q$, 'nor changes one');
  PERFORM pg_temp.assert_fails($q$SELECT app.system_store_exchange_rates('[]'::jsonb)$q$, 'the system functions are for the API login only');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.system_fill_cost_rates(%L)$q$, org), 'filling waiting lines is for the API login');
  PERFORM pg_temp.login_anon();
  PERFORM pg_temp.assert_fails($q$SELECT count(*) FROM public.exchange_rates$q$, 'anonymous callers read nothing');

  -- Waiting lines: the API caches what was missing, then fills them.
  PERFORM pg_temp.logout();
  v := app.system_cost_rates_needed(org);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM jsonb_array_elements(v) e WHERE e ->> 'base' = 'CAD' AND e -> 'quotes' ? 'GBP'), 1::bigint, 'the report of what to ask for names the CAD pair');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM jsonb_array_elements(v) e WHERE e ->> 'base' = 'AED'), 0::bigint, 'a pair already known to be unpublished is not asked for again');
  PERFORM pg_temp.assert_eq(app.system_store_exchange_rates(jsonb_build_array(jsonb_build_object('requestedOn', current_date, 'base', 'CAD', 'quote', 'GBP', 'rate', 0.58, 'rateDate', current_date))), 1, 'rates stored');
  PERFORM pg_temp.assert_fails($q$SELECT app.system_store_exchange_rates('{"a":1}'::jsonb)$q$, 'rates come as a list');
  PERFORM pg_temp.assert_fails($q$SELECT app.system_store_exchange_rates('[{"requestedOn":"2026-01-01","base":"gbp","quote":"EUR","rate":1,"rateDate":"2026-01-01"}]'::jsonb)$q$, 'currency codes are capitals');
  PERFORM pg_temp.assert_fails($q$SELECT app.system_store_exchange_rates('[{"requestedOn":"2026-01-01","base":"GBP","quote":"EUR","rate":-1,"rateDate":"2026-01-01"}]'::jsonb)$q$, 'a rate above 0');
  PERFORM pg_temp.assert_fails($q$SELECT app.system_store_exchange_rates('[{"requestedOn":"2026-01-01","base":"GBP","quote":"GBP","rate":1,"rateDate":"2026-01-01"}]'::jsonb)$q$, 'a pair of two currencies');
  PERFORM pg_temp.assert_eq(app.system_fill_cost_rates(org) >= 1, true, 'waiting lines are filled');
  PERFORM pg_temp.assert_eq((SELECT rate_status || '|' || net_base FROM public.ncr_costs WHERE nonconformance_id = ncr_a AND currency = 'CAD'), 'estimated|46.40', 'a waiting line takes the cached rate');
  PERFORM pg_temp.assert_eq((SELECT rate_status FROM public.ncr_costs WHERE nonconformance_id = ncr_a AND currency = 'AED'), 'needed', 'an unpublished pair stays needed');

  -- The workflow fact: net, organisation currency, credits taken off.
  PERFORM pg_temp.assert_eq((app.system_workflow_facts(org, 'nonconformance', ncr_a) ->> 'total_cost')::numeric,
    (SELECT sum(net_org * cost_sign) FROM public.ncr_costs WHERE nonconformance_id = ncr_a AND deleted_at IS NULL), 'total_cost is net, in the organisation currency, net of credits');
  PERFORM pg_temp.assert_eq((SELECT sum(net_org * cost_sign) <> sum(net_org) FROM public.ncr_costs WHERE nonconformance_id = ncr_a AND deleted_at IS NULL), true, 'and the credits make a difference');

  -- Restate: a site whose currency is not the one its lines were stated in (as before this migration). Lines stay as they are until it runs.
  PERFORM set_config('session_replication_role', 'replica', true);
  INSERT INTO public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, amount, unit_cost, net_amount, gross_amount, base_currency, org_currency, exchange_rate, net_base, gross_base, org_rate, net_org, gross_org, rate_status, rate_source)
    VALUES (org, ncr_c, 'scrap', 'USD', 100, 100, 100, 100, 'GBP', 'GBP', 0.8, 80, 80, 0.8, 80, 80, 'actual', 'manual') RETURNING id INTO l;
  UPDATE public.sites SET currency = 'EUR' WHERE id = site_c;
  PERFORM set_config('session_replication_role', 'origin', true);
  PERFORM pg_temp.login('22000000-0000-0000-0000-000000000101');
  v := app.restate_cost_report(org);
  PERFORM pg_temp.assert_eq((v -> 'sites' -> 0 ->> 'siteCurrency') || '|' || (v -> 'sites' -> 0 ->> 'lines') || '|' || (v -> 'sites' -> 0 -> 'statedIn' ->> 0), 'EUR|1|GBP', 'the report names the site, its lines and what they are stated in');
  PERFORM pg_temp.assert_eq(jsonb_array_length(v -> 'sites' -> 0 -> 'missing'), 0, 'every rate it needs is cached (USD to EUR for today)');
  PERFORM pg_temp.assert_eq((SELECT base_currency FROM public.ncr_costs WHERE id = l), 'GBP', 'nothing changed by asking');
  PERFORM pg_temp.login('22000000-0000-0000-0000-000000000102');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.restate_cost_report(%L)$q$, org), 'the report is for organisation managers');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((app.system_restate_costs(org, site_c) ->> 'restated')::int, 1, 'one line restated');
  PERFORM pg_temp.assert_eq(pg_temp.line(l), 'estimated|frankfurter|0.92|92.00|92.00|EUR|GBP|0.8|80.00', 'now in the site currency at the published rate; the organisation figures are exactly as they were');
  PERFORM pg_temp.assert_eq((app.system_restate_costs(org, site_c) ->> 'restated')::int, 0, 'running it again changes nothing');
END $$;

-- Closed NCs lock their costs, rates included.
DO $$
DECLARE
  ncr_a uuid := (SELECT v FROM ids WHERE k = 'ncr_a'); c uuid;
BEGIN
  SELECT id INTO c FROM public.ncr_costs WHERE nonconformance_id = ncr_a AND currency = 'EUR' AND deleted_at IS NULL LIMIT 1;
  PERFORM pg_temp.login('22000000-0000-0000-0000-000000000101');
  PERFORM pg_temp.settle_ncr(ncr_a);
  UPDATE public.nonconformances SET stage = 'closed' WHERE id = ncr_a;
  PERFORM pg_temp.assert_fails(format($q$SELECT app.override_cost_rate(%L, 'rate', 1)$q$, c), 'no stating a rate on a closed NC');
  PERFORM pg_temp.logout();
  -- The system still fills a waiting line on a closed NC (it is not a person's change).
  PERFORM pg_temp.assert_ok(format($q$SELECT app.system_fill_cost_rates(%L)$q$, (SELECT v FROM ids WHERE k = 'org')), 'the system fills rates whatever the NC stage');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM audit.events WHERE entity_type = 'ncr_costs') > 10, true, 'cost changes audited');
END $$;

ROLLBACK;
