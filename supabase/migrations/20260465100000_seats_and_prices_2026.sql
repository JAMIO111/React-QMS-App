-- Seats and prices, November 2026 (docs/subscription-plan.md §12; the pricing proposal agreed 2026-11-27).
--
--   1. Who does the work and who signs it off: a Contributor now edits non-conformances (containment, investigation, proposing dispositions, stages)
--      and runs 8Ds. Approving dispositions, deleting NCs, verifying and closing 8Ds stay with the Controller (ncr.update and capa.manage move from
--      full to operational; ncr.approve_disposition, ncr.delete and capa.verify do not move).
--   2. A fourth seat, Operator, for the shop floor: view everywhere (nothing in integrations), plus raising a non-conformance and recording
--      inspections (feature rows at operational). It sits between Observer and Contributor.
--   3. An organisation fee: a plan of kind 'fee', one per organisation, never a seat (it is never assigned to a person, holds no entitlements and
--      cannot be bought as seats). The API adds it to every new subscription.
--   4. New prices (pence, excluding VAT; annual = ten monthly payments): organisation £99, Controller £49, Contributor £19, Operator £6, Observer
--      free. The old prices are ended but kept, with their Stripe ids, so existing subscriptions keep their prices and still map to their packages.
--   5. Free Observers are limited to twice the paid seats (app.check_seat_change), unless the organisation still pays for Observers at the old price.
--   6. Guards for later migrations: an entitlement row for a fee plan is never stored, and a module-level row for the Operator never gives more
--      than view (a new module's CROSS JOIN over the plans would otherwise make the Operator operational there). Feature rows are explicit.
--
-- The Stripe price ids for the new prices are environment data: set them afterwards (docs/stripe-setup.md; scripts/stripe-setup.mjs prints the SQL).
-- Until they are set, starting a subscription answers 503 billing_unavailable, as for a fresh install.

-- ---------------------------------------------------------------------------
-- Helper for patching live functions (refuses unless the text is found exactly once; does nothing when the marker is already there)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pg_temp.patch_once(p_fn regprocedure, p_marker text, p_old text, p_new text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_def text := replace(pg_get_functiondef(p_fn), E'\r', ''); v_n integer;
BEGIN
  p_old := replace(p_old, E'\r', '');
  p_new := replace(p_new, E'\r', '');
  IF position(p_marker IN v_def) > 0 THEN RETURN; END IF;
  v_n := (length(v_def) - length(replace(v_def, p_old, ''))) / length(p_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'Expected to find % exactly once in %, found % times', p_old, p_fn, v_n; END IF;
  EXECUTE replace(v_def, p_old, p_new);
END $$;

-- ---------------------------------------------------------------------------
-- 1. Seats and fees
-- ---------------------------------------------------------------------------
ALTER TABLE public.subscription_plans ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'seat' CHECK (kind IN ('seat', 'fee'));
COMMENT ON COLUMN public.subscription_plans.kind IS 'seat = a package a person holds; fee = a charge per organisation (never assigned, no entitlements)';

UPDATE public.subscription_plans SET display_order = 1,
  description = 'Reads dashboards, registers, documents and alerts, and acknowledges what is addressed to them. Free up to twice the number of paid seats.'
 WHERE slug = 'observer';
UPDATE public.subscription_plans SET display_order = 3,
  description = 'Does the work: raises and progresses non-conformances, runs 8Ds, records inspections, calibrations, audits and deliveries.'
 WHERE slug = 'contributor';
UPDATE public.subscription_plans SET display_order = 4,
  description = 'Signs off and sets up: approves dispositions, verifies and closes 8Ds, issues documents, approves suppliers, runs integrations.'
 WHERE slug = 'controller';

INSERT INTO public.subscription_plans (slug, name, description, display_order, kind) VALUES
  ('operator', 'Operator', 'The shop floor: records inspections and jobs, raises non-conformances, reads and acknowledges documents and alerts.', 2, 'seat'),
  ('organisation', 'Organisation', 'One per organisation: every module, support and the platform itself.', 0, 'fee')
ON CONFLICT (slug) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. The Contributor does the work
-- ---------------------------------------------------------------------------
UPDATE public.features SET min_access_level = 'operational' WHERE permission_code IN ('ncr.update', 'capa.manage');

-- ---------------------------------------------------------------------------
-- 3. Guards on entitlement rows (fee plans hold none; the Operator's module rows stop at view)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.subscription_entitlement_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_slug text; v_kind text;
BEGIN
  SELECT p.slug, p.kind INTO v_slug, v_kind FROM public.subscription_plans p WHERE p.id = NEW.subscription_plan_id;
  -- A fee is not a seat: rows for it are dropped, so a migration that crosses every plan with a new module cannot give the fee access.
  IF v_kind = 'fee' THEN RETURN NULL; END IF;
  -- The Operator views a module; only explicit feature rows (raise an NC, record inspections) let it do more.
  IF v_slug = 'operator' AND NEW.feature_id IS NULL AND NEW.access_level IN ('operational', 'full') THEN
    NEW.access_level := 'view';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.subscription_entitlement_rules() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS subscription_entitlements_rules ON public.subscription_entitlements;
CREATE TRIGGER subscription_entitlements_rules BEFORE INSERT OR UPDATE ON public.subscription_entitlements
  FOR EACH ROW EXECUTE FUNCTION app.subscription_entitlement_rules();

-- The Operator: view in every module (none in integrations), operational for raising NCs and recording inspections.
INSERT INTO public.subscription_entitlements (subscription_plan_id, module_id, access_level)
SELECT p.id, m.id, CASE WHEN m.slug = 'integrations' THEN 'none' ELSE 'view' END
  FROM public.subscription_plans p CROSS JOIN public.modules m
 WHERE p.slug = 'operator'
   AND NOT EXISTS (SELECT 1 FROM public.subscription_entitlements e WHERE e.subscription_plan_id = p.id AND e.module_id = m.id AND e.feature_id IS NULL);

INSERT INTO public.subscription_entitlements (subscription_plan_id, module_id, feature_id, access_level)
SELECT p.id, f.module_id, f.id, 'operational'
  FROM public.subscription_plans p CROSS JOIN public.features f
 WHERE p.slug = 'operator' AND f.permission_code IN ('ncr.create', 'inspection.record')
   AND NOT EXISTS (SELECT 1 FROM public.subscription_entitlements e WHERE e.subscription_plan_id = p.id AND e.feature_id = f.id);

-- ---------------------------------------------------------------------------
-- 4. Prices: the old ones end (kept, with their Stripe ids, for existing subscriptions); the new ones start without Stripe ids
-- ---------------------------------------------------------------------------
UPDATE public.subscription_prices pr
   SET effective_to = greatest(now(), pr.effective_from + interval '1 microsecond')
  FROM public.subscription_plans pl
 WHERE pl.id = pr.subscription_plan_id AND pl.slug IN ('observer', 'contributor', 'controller')
   AND pr.active AND pr.effective_to IS NULL AND pr.currency = 'GBP'
   AND pr.unit_amount <> CASE pl.slug WHEN 'observer' THEN 0 WHEN 'contributor' THEN 1900 ELSE 4900 END
                         * CASE pr.billing_interval WHEN 'month' THEN 1 ELSE 10 END;

INSERT INTO public.subscription_prices (subscription_plan_id, billing_interval, currency, unit_amount)
SELECT pl.id, i.interval, 'GBP',
       CASE pl.slug WHEN 'organisation' THEN 9900 WHEN 'controller' THEN 4900 WHEN 'contributor' THEN 1900 WHEN 'operator' THEN 600 ELSE 0 END
       * CASE i.interval WHEN 'month' THEN 1 ELSE 10 END
  FROM public.subscription_plans pl CROSS JOIN (VALUES ('month'), ('year')) AS i(interval)
 WHERE pl.slug IN ('organisation', 'controller', 'contributor', 'operator', 'observer')
   AND NOT EXISTS (SELECT 1 FROM public.subscription_prices x
                    WHERE x.subscription_plan_id = pl.id AND x.billing_interval = i.interval AND x.currency = 'GBP' AND x.active AND x.effective_to IS NULL);

-- Every Stripe price a package has ever had at an interval (current first): a seat change keeps the price an existing subscription already pays.
CREATE OR REPLACE FUNCTION app.stripe_prices_for_plan(p_plan_slug text, p_interval text) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(array_agg(pr.provider_price_id ORDER BY (pr.effective_to IS NULL) DESC, pr.effective_from DESC), ARRAY[]::text[])
    FROM public.subscription_prices pr JOIN public.subscription_plans pl ON pl.id = pr.subscription_plan_id
   WHERE pl.slug = p_plan_slug AND pr.billing_interval = p_interval AND pr.currency = 'GBP' AND pr.provider_price_id IS NOT NULL
$$;
REVOKE ALL ON FUNCTION app.stripe_prices_for_plan(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.stripe_prices_for_plan(text, text) TO qms_api;

-- ---------------------------------------------------------------------------
-- 5. A fee is never a person's package
-- ---------------------------------------------------------------------------
SELECT pg_temp.patch_once('app.assign_subscription_package(uuid, text)'::regprocedure, 'fee_not_a_seat',
$old$  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown subscription package.' USING ERRCODE = 'QM009'; END IF;$old$,
$new$  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown subscription package.' USING ERRCODE = 'QM009'; END IF;
  -- fee_not_a_seat
  IF v_plan.kind <> 'seat' THEN RAISE EXCEPTION '% is not a seat and cannot be given to a person.', v_plan.name USING ERRCODE = 'QM009'; END IF;$new$);

-- ---------------------------------------------------------------------------
-- 6. Seat changes: the fee is not a seat, and free Observers are limited to twice the paid seats
-- ---------------------------------------------------------------------------
SELECT pg_temp.patch_once('app.check_seat_change(uuid, jsonb)'::regprocedure, 'observer_limit',
$old$  v_controller := coalesce((p_seats ->> 'controller')::integer, 0);$old$,
$new$  -- observer_limit: the organisation fee is bought with the subscription, not as seats
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_seats) AS sk(slug) JOIN public.subscription_plans pl ON pl.slug = sk.slug WHERE pl.kind <> 'seat') THEN
    v_problems := array_append(v_problems, 'The organisation fee is not a seat and cannot be changed here.');
  END IF;
  -- Free Observers: at most twice the paid seats after the change (a package not named keeps what the subscription has now). An organisation that still
  -- pays for Observers at the old price is not limited.
  DECLARE v_obs integer := 0; v_paid integer := 0; v_q integer; v_paid_observers boolean; pl public.subscription_plans%ROWTYPE;
  BEGIN
    SELECT EXISTS (SELECT 1 FROM public.organisation_subscription_items i JOIN public.subscription_plans p ON p.id = i.subscription_plan_id AND p.slug = 'observer'
                     JOIN public.organisation_subscriptions s ON s.id = i.organisation_subscription_id
                    WHERE i.organisation_id = p_organisation_id AND i.unit_amount_snapshot > 0 AND s.status NOT IN ('cancelled', 'incomplete'))
      INTO v_paid_observers;
    FOR pl IN SELECT * FROM public.subscription_plans p WHERE p.kind = 'seat' AND p.status = 'active' LOOP
      v_q := CASE WHEN (p_seats ->> pl.slug) ~ '^[0-9]{1,5}$' THEN (p_seats ->> pl.slug)::integer
                  ELSE coalesce((SELECT i.quantity FROM public.organisation_subscription_items i
                                   JOIN public.organisation_subscriptions s ON s.id = i.organisation_subscription_id
                                  WHERE i.organisation_id = p_organisation_id AND i.subscription_plan_id = pl.id AND s.status NOT IN ('cancelled', 'incomplete')), 0) END;
      IF pl.slug = 'observer' THEN v_obs := v_q; ELSE v_paid := v_paid + v_q; END IF;
    END LOOP;
    IF NOT v_paid_observers AND v_obs > 2 * v_paid THEN
      v_problems := array_append(v_problems, format('Observer seats are free up to twice the paid seats (%s here). Add paid seats or choose fewer Observers.', 2 * v_paid));
    END IF;
  END;
  v_controller := coalesce((p_seats ->> 'controller')::integer, 0);$new$);

-- ---------------------------------------------------------------------------
-- 7. "Which package would allow this?" also reads feature rows (the Operator may raise an NC without being able to edit one)
-- ---------------------------------------------------------------------------
SELECT pg_temp.patch_once('app.check_entitlement(uuid, text, text)'::regprocedure, 'seat_feature_rows',
$old$  SELECT p.name INTO v_required FROM public.subscription_plans p
   JOIN public.subscription_entitlements e ON e.subscription_plan_id = p.id AND e.module_id = v_module AND e.feature_id IS NULL
   WHERE p.status = 'active' AND e.enabled AND app.access_level_rank(e.access_level) >= v_need
   ORDER BY p.display_order LIMIT 1;$old$,
$new$  -- seat_feature_rows: a feature row of a package wins over its module row
  SELECT p.name INTO v_required FROM public.subscription_plans p
   WHERE p.status = 'active' AND p.kind = 'seat'
     AND coalesce((SELECT CASE WHEN e.enabled THEN app.access_level_rank(e.access_level) ELSE 0 END FROM public.subscription_entitlements e
                    WHERE e.subscription_plan_id = p.id AND e.module_id = v_module AND (e.feature_id = v_feature OR e.feature_id IS NULL)
                    ORDER BY (e.feature_id IS NULL) LIMIT 1), 0) >= v_need
   ORDER BY p.display_order LIMIT 1;$new$);

-- ---------------------------------------------------------------------------
-- 8. The operator panel's "seats purchased" counts seats only (the organisation fee is one item per subscription, not a seat)
-- ---------------------------------------------------------------------------
SELECT pg_temp.patch_once('app.platform_organisations(text, integer, integer)'::regprocedure, 'seats_only',
$old$         coalesce((SELECT sum(i.quantity) FROM public.organisation_subscription_items i WHERE i.organisation_subscription_id = s.id), 0)::bigint,$old$,
$new$         -- seats_only
         coalesce((SELECT sum(i.quantity) FROM public.organisation_subscription_items i JOIN public.subscription_plans sp ON sp.id = i.subscription_plan_id AND sp.kind = 'seat'
                    WHERE i.organisation_subscription_id = s.id), 0)::bigint,$new$);
