-- Seats and prices, November 2026 (migration 20260465100000): the Contributor edits NCs and runs 8Ds, the Operator raises NCs and records
-- inspections only, the organisation fee is never a seat, free Observers are limited to twice the paid seats, and the new prices are current.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

CREATE FUNCTION pg_temp.fails_with(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

INSERT INTO auth.users (id, email) VALUES
  ('5f650000-0000-0000-0000-000000000101', 'owner@seats26.test'),
  ('5f650000-0000-0000-0000-000000000102', 'contrib@seats26.test'),
  ('5f650000-0000-0000-0000-000000000103', 'operator@seats26.test'),
  ('5f650000-0000-0000-0000-000000000104', 'observer@seats26.test');

CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);
GRANT SELECT ON ids TO authenticated;

-- ---- prices and packages ----
DO $$
BEGIN
  PERFORM pg_temp.assert_eq((SELECT string_agg(slug || ':' || kind, ',' ORDER BY display_order) FROM public.subscription_plans WHERE status = 'active'),
    'organisation:fee,observer:seat,operator:seat,contributor:seat,controller:seat', 'four seats in order, and the organisation fee');
  PERFORM pg_temp.assert_eq((SELECT string_agg(pl.slug || '=' || pr.unit_amount, ',' ORDER BY pl.display_order)
                               FROM public.subscription_prices pr JOIN public.subscription_plans pl ON pl.id = pr.subscription_plan_id
                              WHERE pr.active AND pr.effective_to IS NULL AND pr.billing_interval = 'month' AND pr.currency = 'GBP'),
    'organisation=9900,observer=0,operator=600,contributor=1900,controller=4900', 'the monthly prices');
  PERFORM pg_temp.assert_eq((SELECT string_agg(pl.slug || '=' || pr.unit_amount, ',' ORDER BY pl.display_order)
                               FROM public.subscription_prices pr JOIN public.subscription_plans pl ON pl.id = pr.subscription_plan_id
                              WHERE pr.active AND pr.effective_to IS NULL AND pr.billing_interval = 'year' AND pr.currency = 'GBP'),
    'organisation=99000,observer=0,operator=6000,contributor=19000,controller=49000', 'annual = ten months');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.subscription_prices pr JOIN public.subscription_plans pl ON pl.id = pr.subscription_plan_id
                              WHERE pl.slug = 'controller' AND pr.unit_amount = 2500 AND pr.effective_to IS NOT NULL), 1::bigint,
    'the old price is ended, not removed (existing subscriptions keep it)');

  -- guards for later migrations
  INSERT INTO public.subscription_entitlements (subscription_plan_id, module_id, access_level)
  SELECT p.id, (SELECT id FROM public.modules WHERE slug = 'analytics'), 'full' FROM public.subscription_plans p WHERE p.slug = 'organisation';
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.subscription_entitlements e JOIN public.subscription_plans p ON p.id = e.subscription_plan_id
                              WHERE p.kind = 'fee'), 0::bigint, 'a fee holds no entitlements, even when a migration crosses every plan');
  UPDATE public.subscription_entitlements e SET access_level = 'full'
    FROM public.subscription_plans p, public.modules m
   WHERE p.id = e.subscription_plan_id AND p.slug = 'operator' AND m.id = e.module_id AND m.slug = 'calibration' AND e.feature_id IS NULL;
  PERFORM pg_temp.assert_eq((SELECT e.access_level FROM public.subscription_entitlements e JOIN public.subscription_plans p ON p.id = e.subscription_plan_id
                               JOIN public.modules m ON m.id = e.module_id WHERE p.slug = 'operator' AND m.slug = 'calibration' AND e.feature_id IS NULL),
    'view', 'the Operator views a module, whatever a migration asks');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.modules m WHERE NOT EXISTS (
                              SELECT 1 FROM public.subscription_entitlements e JOIN public.subscription_plans p ON p.id = e.subscription_plan_id
                               WHERE p.slug = 'operator' AND e.module_id = m.id AND e.feature_id IS NULL)), 0::bigint, 'the Operator has a row for every module');
  PERFORM pg_temp.assert_eq((SELECT min_access_level FROM public.features WHERE permission_code = 'ncr.update'), 'operational', 'editing an NC is operational');
  PERFORM pg_temp.assert_eq((SELECT min_access_level FROM public.features WHERE permission_code = 'capa.manage'), 'operational', 'running an 8D is operational');
  PERFORM pg_temp.assert_eq((SELECT string_agg(min_access_level, ',' ORDER BY permission_code) FROM public.features
                              WHERE permission_code IN ('ncr.approve_disposition', 'ncr.delete', 'capa.verify')), 'full,full,full', 'signing off stays full');
END $$;

-- ---- an organisation that enforces packages, one person per seat, all with the Quality manager role ----
DO $$
DECLARE org uuid; m uuid; u uuid; seat text;
BEGIN
  PERFORM pg_temp.login('5f650000-0000-0000-0000-000000000101');
  org := app.create_organisation('Seat Works 26', 'Plant A', 'PA', NULL);
  PERFORM app.set_subscription_seats(org, 'controller', 1);
  PERFORM app.set_subscription_seats(org, 'contributor', 1);
  PERFORM app.set_subscription_seats(org, 'operator', 1);
  PERFORM app.set_subscription_seats(org, 'observer', 1);
  PERFORM app.assign_subscription_package((SELECT id FROM public.organisation_users WHERE organisation_id = org AND user_id = '5f650000-0000-0000-0000-000000000101'), 'controller');
  PERFORM pg_temp.logout();
  INSERT INTO ids VALUES ('org', org);
  FOR u, seat IN VALUES ('5f650000-0000-0000-0000-000000000102'::uuid, 'contributor'), ('5f650000-0000-0000-0000-000000000103'::uuid, 'operator'),
                        ('5f650000-0000-0000-0000-000000000104'::uuid, 'observer') LOOP
    INSERT INTO public.organisation_users (organisation_id, user_id, status, joined_at) VALUES (org, u, 'active', now()) RETURNING id INTO m;
    INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'quality_manager';
    PERFORM pg_temp.login('5f650000-0000-0000-0000-000000000101');
    PERFORM app.assign_subscription_package(m, seat);
    PERFORM pg_temp.logout();
    INSERT INTO ids VALUES (seat, m);
  END LOOP;
  UPDATE public.organisation_settings SET entitlements_enforced = true WHERE organisation_id = org;
END $$;

DO $$
DECLARE org uuid := (SELECT v FROM ids WHERE k = 'org');
BEGIN
  -- Contributor: does the work, does not sign it off
  PERFORM pg_temp.login('5f650000-0000-0000-0000-000000000102');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'ncr.update'), true, 'a Contributor edits non-conformances');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'capa.manage'), true, 'and runs 8Ds');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'ncr.approve_disposition'), false, 'but does not approve dispositions');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'capa.verify'), false, 'nor verify and close 8Ds');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'ncr.delete'), false, 'nor delete NCs');

  -- Operator: raises NCs and records inspections, views the rest
  PERFORM pg_temp.login('5f650000-0000-0000-0000-000000000103');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'ncr.read'), true, 'an Operator reads NCs');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'ncr.create'), true, 'raises them');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'inspection.record'), true, 'and records inspections');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'ncr.update'), false, 'but does not edit an NC');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'calibration.record'), false, 'nor record calibrations');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'capa.manage'), false, 'nor run an 8D');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'documentation.read'), true, 'reads documents');
  PERFORM pg_temp.assert_eq((SELECT required_plan FROM app.check_entitlement(org, 'nonconformance', 'edit_ncrs')), 'Contributor', 'editing needs a Contributor');
  PERFORM pg_temp.assert_eq((SELECT (app.my_subscription_access(org)) -> 'modules' ->> 'nonconformance'), 'view', 'the module shows, as a viewer');

  -- Observer
  PERFORM pg_temp.login('5f650000-0000-0000-0000-000000000104');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'ncr.read'), true, 'an Observer reads');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'ncr.create'), false, 'but does not raise');
  PERFORM pg_temp.assert_eq((SELECT required_plan FROM app.check_entitlement(org, 'nonconformance', 'create_ncrs')), 'Operator',
    'raising an NC needs an Operator (the feature row counts)');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.assert_eq(app.member_may(org, '5f650000-0000-0000-0000-000000000103', 'ncr.create'), true, 'member_may: the Operator may raise');
  PERFORM pg_temp.assert_eq(app.member_may(org, '5f650000-0000-0000-0000-000000000103', 'ncr.update'), false, 'member_may: the Operator may not edit');
  PERFORM pg_temp.assert_eq(app.member_may(org, '5f650000-0000-0000-0000-000000000102', 'ncr.update'), true, 'member_may: the Contributor may edit');
END $$;

-- ---- the fee is never a seat; free Observers are limited ----
DO $$
DECLARE org uuid := (SELECT v FROM ids WHERE k = 'org'); r text; p text[];
BEGIN
  PERFORM pg_temp.login('5f650000-0000-0000-0000-000000000101');
  r := pg_temp.fails_with(format($f$SELECT app.assign_subscription_package(%L, 'organisation')$f$, (SELECT v FROM ids WHERE k = 'observer')));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM009', 'the organisation fee cannot be given to a person');

  p := app.check_seat_change(org, '{"organisation": 2}'::jsonb);
  PERFORM pg_temp.assert_eq(p @> ARRAY['The organisation fee is not a seat and cannot be changed here.'], true, 'nor bought as seats');

  -- paid seats now: 1 controller + 1 contributor + 1 operator = 3, so up to 6 free Observers
  p := app.check_seat_change(org, '{"observer": 6}'::jsonb);
  PERFORM pg_temp.assert_eq(cardinality(p), 0, 'six Observers for three paid seats is fine (packages not named keep what they have)');
  p := app.check_seat_change(org, '{"observer": 7}'::jsonb);
  PERFORM pg_temp.assert_eq(p, ARRAY['Observer seats are free up to twice the paid seats (6 here). Add paid seats or choose fewer Observers.'], 'seven is too many');
  p := app.check_seat_change(org, '{"observer": 8, "operator": 2}'::jsonb);
  PERFORM pg_temp.assert_eq(cardinality(p), 0, 'unless paid seats go up in the same change');
  PERFORM pg_temp.logout();

  -- an organisation still paying for Observers at the old price is not limited
  UPDATE public.organisation_subscription_items i SET unit_amount_snapshot = 500
    FROM public.subscription_plans pl WHERE pl.id = i.subscription_plan_id AND pl.slug = 'observer' AND i.organisation_id = org;
  PERFORM pg_temp.login('5f650000-0000-0000-0000-000000000101');
  p := app.check_seat_change(org, '{"observer": 20}'::jsonb);
  PERFORM pg_temp.assert_eq(cardinality(p), 0, 'paid Observers at the old price are not limited');
  PERFORM pg_temp.logout();
END $$;

-- ---- Stripe price lookup keeps every price a package has had ----
DO $$
BEGIN
  UPDATE public.subscription_prices pr SET provider_price_id = CASE WHEN pr.effective_to IS NULL THEN 'price_new_ctrl' ELSE 'price_old_ctrl' END
    FROM public.subscription_plans pl WHERE pl.id = pr.subscription_plan_id AND pl.slug = 'controller' AND pr.billing_interval = 'month';
  PERFORM pg_temp.assert_eq(app.stripe_prices_for_plan('controller', 'month'), ARRAY['price_new_ctrl', 'price_old_ctrl'], 'current first, then the old one');
  PERFORM pg_temp.assert_eq(app.stripe_price_for('controller', 'month'), 'price_new_ctrl', 'new subscriptions use the new price');
END $$;

-- ---- the operator panel counts seats, not the organisation fee ----
DO $$
BEGIN
  PERFORM pg_temp.assert_eq(position('seats_only' IN pg_get_functiondef('app.platform_organisations(text, integer, integer)'::regprocedure)) > 0, true,
    'platform_organisations sums seat packages only');
END $$;

ROLLBACK;
