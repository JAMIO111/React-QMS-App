-- ON3a: Stripe as the source of truth. The system functions (apply subscription / invoice, events, checkout), their privileges (only the API login), idempotency, stale and
-- out-of-order snapshots, status mapping and past-due handling, the first Controller seat for an owner, seats that go below assignments, the Controller invariant,
-- manual seats refused for Stripe-billed and gated organisations, seat-change checks, and isolation.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('3f000000-0000-0000-0000-000000000b01', 'owner@on3.test'),
  ('3f000000-0000-0000-0000-000000000b02', 'owner2@on3.test'),
  ('3f000000-0000-0000-0000-000000000b03', 'viewer@on3.test'),
  ('3f000000-0000-0000-0000-000000000b04', 'other@on3.test'),
  ('3f000000-0000-0000-0000-000000000b05', 'operator@on3.test');

-- Run a statement as the API's own login (as the superuser connection does in the tests: SET ROLE).
CREATE FUNCTION pg_temp.as_api(stmt text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('role', 'qms_api', true);
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('role', 'postgres', true);
    RAISE;
  END;
  PERFORM set_config('role', 'postgres', true);
END $$;

CREATE FUNCTION pg_temp.api_apply(p_org uuid, p_snapshot jsonb, p_at timestamptz, p_session text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  PERFORM set_config('role', 'qms_api', true);
  BEGIN
    r := app.stripe_apply_subscription(p_org, p_snapshot, p_at, p_session);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('role', 'postgres', true);
    RAISE;
  END;
  PERFORM set_config('role', 'postgres', true);
  RETURN r;
END $$;

-- A subscription as the API would hand it over.
CREATE FUNCTION pg_temp.snap(p_id text, p_status text, p_controller integer, p_contributor integer DEFAULT 0, p_period_end timestamptz DEFAULT now() + interval '14 days', p_cancel boolean DEFAULT false, p_customer text DEFAULT 'cus_on3test') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', p_id, 'customerId', p_customer, 'status', p_status, 'interval', 'month', 'currency', 'gbp',
    'currentPeriodStart', now(), 'currentPeriodEnd', p_period_end, 'trialStart', now(), 'trialEnd', now() + interval '14 days', 'cancelAtPeriodEnd', p_cancel,
    'canceledAt', NULL,
    'items', (SELECT jsonb_agg(i) FROM (
       SELECT jsonb_build_object('priceId', 'price_ctrl_month', 'quantity', p_controller) AS i WHERE p_controller IS NOT NULL
       UNION ALL SELECT jsonb_build_object('priceId', 'price_contrib_month', 'quantity', p_contributor) WHERE p_contributor > 0) x))
$$;

-- Changes that would leave no owner with a Controller seat, checked straight away (the rule is a deferred constraint, normally checked at commit).
CREATE FUNCTION pg_temp.try_unassign_owner(m uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM app.remove_subscription_assignment(m);
  SET CONSTRAINTS ALL IMMEDIATE;
END $$;
CREATE FUNCTION pg_temp.try_downgrade_owner(m uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM app.assign_subscription_package(m, 'contributor');
  SET CONSTRAINTS ALL IMMEDIATE;
END $$;
CREATE FUNCTION pg_temp.try_drop_owner_role(m uuid, r uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM public.user_role_assignments WHERE membership_id = m AND role_id = r;
  SET CONSTRAINTS ALL IMMEDIATE;
END $$;
CREATE FUNCTION pg_temp.try_suspend(m uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.organisation_users SET status = 'suspended' WHERE id = m;
  SET CONSTRAINTS ALL IMMEDIATE;
END $$;

DO $$
DECLARE
  u_owner uuid := '3f000000-0000-0000-0000-000000000b01'; u_owner2 uuid := '3f000000-0000-0000-0000-000000000b02'; u_view uuid := '3f000000-0000-0000-0000-000000000b03';
  u_other uuid := '3f000000-0000-0000-0000-000000000b04'; u_op uuid := '3f000000-0000-0000-0000-000000000b05';
  org uuid; org2 uuid; m_owner uuid; m_owner2 uuid; m_view uuid; owner_role uuid; viewer_role uuid; r jsonb; t0 timestamptz := now();
  v_sub public.organisation_subscriptions%ROWTYPE; problems text[];
BEGIN
  UPDATE public.platform_settings SET value = 'true'::jsonb WHERE key = 'billing_gate_enabled';
  UPDATE public.subscription_prices SET provider_price_id = CASE
    WHEN subscription_plan_id = (SELECT id FROM public.subscription_plans WHERE slug = 'controller') AND billing_interval = 'month' THEN 'price_ctrl_month'
    WHEN subscription_plan_id = (SELECT id FROM public.subscription_plans WHERE slug = 'contributor') AND billing_interval = 'month' THEN 'price_contrib_month'
    WHEN subscription_plan_id = (SELECT id FROM public.subscription_plans WHERE slug = 'controller') AND billing_interval = 'year' THEN 'price_ctrl_year' END
  WHERE active AND effective_to IS NULL AND currency = 'GBP';

  PERFORM pg_temp.login(u_owner);
  org := app.start_organisation('Stripe Works', 'Plant S', 'PS', 'Europe/London', 'GB', NULL);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_other);
  org2 := app.start_organisation('Other Works', 'Plant O', 'PO', 'Europe/London', 'GB', NULL);
  PERFORM pg_temp.logout();
  SELECT id INTO owner_role FROM public.roles WHERE organisation_id = org AND key = 'owner';
  SELECT id INTO viewer_role FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  SELECT id INTO m_owner FROM public.organisation_users WHERE organisation_id = org AND user_id = u_owner;
  INSERT INTO public.organisation_users (organisation_id, user_id, status, created_at) VALUES (org, u_owner2, 'active', now() - interval '1 day') RETURNING id INTO m_owner2;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) VALUES (org, m_owner2, owner_role);
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u_view, 'active') RETURNING id INTO m_view;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) VALUES (org, m_view, viewer_role);

  -- Privileges: only the API login may run the system functions.
  PERFORM pg_temp.assert_eq(has_function_privilege('qms_api', 'app.stripe_apply_subscription(uuid, jsonb, timestamptz, text)', 'EXECUTE'), true, 'the API login can apply a subscription');
  PERFORM pg_temp.assert_eq(has_function_privilege('authenticated', 'app.stripe_apply_subscription(uuid, jsonb, timestamptz, text)', 'EXECUTE'), false, 'a signed-in person cannot');
  PERFORM pg_temp.assert_eq(has_function_privilege('anon', 'app.stripe_apply_subscription(uuid, jsonb, timestamptz, text)', 'EXECUTE'), false, 'nor anonymous');
  PERFORM pg_temp.assert_eq((SELECT bool_or(has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'))
                               FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app' AND p.proname LIKE 'stripe\_%'), false, 'no stripe_* function is open to people');
  PERFORM pg_temp.assert_eq(has_table_privilege('qms_api', 'public.organisation_subscriptions', 'SELECT'), false, 'the API login has no table privileges of its own');
  PERFORM pg_temp.login(u_owner);
  PERFORM pg_temp.assert_fails(format($q$SELECT app.stripe_apply_subscription(%L, %L::jsonb, now(), NULL)$q$, org, pg_temp.snap('sub_x', 'active', 1)), 'an owner cannot write their own subscription');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.stripe_start_checkout(%L, %L, 'cs_test_x', 'month', '{}')$q$, org, u_owner), 'nor start a checkout record by hand');
  PERFORM pg_temp.logout();

  -- Starting a checkout: only an owner, once the organisation has no live subscription.
  PERFORM pg_temp.assert_fails(format($q$SELECT pg_temp.as_api(format('SELECT app.stripe_start_checkout(%%L, %%L, %%L, %%L, %%L)', %L, %L, 'cs_test_viewer', 'month', '{"controller":1}'))$q$, org, u_view), 'a viewer cannot start the subscription');
  PERFORM pg_temp.as_api(format($q$SELECT app.stripe_start_checkout(%L, %L, 'cs_test_one', 'month', '{"controller":2,"contributor":3}')$q$, org, u_owner));
  PERFORM pg_temp.assert_eq((SELECT status FROM public.stripe_checkout_sessions WHERE provider_session_id = 'cs_test_one'), 'open', 'the checkout is recorded as open');
  PERFORM pg_temp.assert_eq((SELECT user_id FROM public.organisation_users WHERE id = (SELECT membership_id FROM public.stripe_checkout_sessions WHERE provider_session_id = 'cs_test_one')), u_owner, 'with who started it');
  PERFORM pg_temp.assert_fails(format($q$SELECT pg_temp.as_api(format('SELECT app.stripe_start_checkout(%%L, %%L, %%L, %%L, %%L)', %L, %L, 'cs_test_one', 'month', '{}'))$q$, org, u_owner), 'a checkout id is recorded once');

  -- First apply: trial, seats, customer, the owner's Controller seat, the lock opens.
  PERFORM pg_temp.assert_eq(app.organisation_access_open(org), false, 'locked before the subscription');
  r := pg_temp.api_apply(org, pg_temp.snap('sub_on3', 'trialing', 2, 3), t0, 'cs_test_one');
  PERFORM pg_temp.assert_eq((r ->> 'applied')::boolean, true, 'the first snapshot is applied');
  SELECT * INTO v_sub FROM public.organisation_subscriptions WHERE organisation_id = org;
  PERFORM pg_temp.assert_eq((v_sub.billing_provider, v_sub.status, v_sub.provider_subscription_id, v_sub.billing_interval, v_sub.currency, v_sub.cancel_at_period_end)::text, '(stripe,trialing,sub_on3,month,GBP,f)', 'subscription fields');
  PERFORM pg_temp.assert_eq(v_sub.trial_end IS NOT NULL, true, 'the trial end is stored');
  PERFORM pg_temp.assert_eq((SELECT jsonb_object_agg(p.slug, i.quantity) FROM public.organisation_subscription_items i JOIN public.subscription_plans p ON p.id = i.subscription_plan_id WHERE i.organisation_id = org), '{"controller": 2, "contributor": 3}'::jsonb, 'seats are what Stripe says');
  PERFORM pg_temp.assert_eq((SELECT provider_customer_id FROM public.billing_customers WHERE organisation_id = org), 'cus_on3test', 'the Stripe customer is stored');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.stripe_checkout_sessions WHERE provider_session_id = 'cs_test_one'), 'completed', 'the checkout is completed');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.user_subscription_assignments WHERE organisation_id = org AND status = 'active'), 1::bigint, 'one seat is assigned');
  PERFORM pg_temp.assert_eq((SELECT organisation_membership_id FROM public.user_subscription_assignments WHERE organisation_id = org AND status = 'active'), m_owner, 'to the owner who started the checkout, not the other owner');
  PERFORM pg_temp.assert_eq((SELECT p.slug FROM public.user_subscription_assignments a JOIN public.subscription_plans p ON p.id = a.subscription_plan_id WHERE a.organisation_id = org AND a.status = 'active'), 'controller', 'a Controller seat');
  PERFORM pg_temp.assert_eq(app.organisation_access_open(org), true, 'the organisation is open');
  PERFORM pg_temp.login(u_owner);
  PERFORM pg_temp.assert_eq(app.organisation_access_state(org), 'open', 'and the owner sees it open');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'ncr.read'), true, 'with the quality work back');
  PERFORM pg_temp.logout();

  -- Idempotent: the same snapshot again changes nothing; a repeated apply does not add a seat or log seat changes again.
  r := pg_temp.api_apply(org, pg_temp.snap('sub_on3', 'trialing', 2, 3), t0, 'cs_test_one');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.user_subscription_assignments WHERE organisation_id = org), 1::bigint, 'replaying does not assign again');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.subscription_audit_logs WHERE organisation_id = org AND event_type = 'seats_added'), 2::bigint, 'nor log seat changes again');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.subscription_audit_logs WHERE organisation_id = org AND event_type = 'subscription_created'), 1::bigint, 'nor create the subscription twice');

  -- Out of order: an older snapshot (fetched before the stored one) is ignored; a newer one wins.
  r := pg_temp.api_apply(org, pg_temp.snap('sub_on3', 'canceled', 0), t0 - interval '1 minute');
  PERFORM pg_temp.assert_eq((r ->> 'applied')::boolean, false, 'a stale snapshot is not applied');
  PERFORM pg_temp.assert_eq(r ->> 'reason', 'stale', 'and says why');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.organisation_subscriptions WHERE organisation_id = org), 'trialing', 'the stored state is untouched');

  -- Payment fails: past_due, the clock starts once, access continues inside the grace period; recovery clears it.
  r := pg_temp.api_apply(org, pg_temp.snap('sub_on3', 'past_due', 2, 3), t0 + interval '1 hour');
  SELECT * INTO v_sub FROM public.organisation_subscriptions WHERE organisation_id = org;
  PERFORM pg_temp.assert_eq((v_sub.status, v_sub.past_due_since = t0 + interval '1 hour')::text, '(past_due,t)', 'past due since the fetch');
  PERFORM pg_temp.assert_eq(app.organisation_access_open(org), true, 'still open in the grace period');
  r := pg_temp.api_apply(org, pg_temp.snap('sub_on3', 'past_due', 2, 3), t0 + interval '2 hours');
  PERFORM pg_temp.assert_eq((SELECT past_due_since = t0 + interval '1 hour' FROM public.organisation_subscriptions WHERE organisation_id = org), true, 'the past-due clock is not restarted by another snapshot');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.subscription_audit_logs WHERE organisation_id = org AND event_type = 'payment_failed'), 1::bigint, 'the failure is logged once');
  UPDATE public.organisation_subscriptions SET past_due_since = now() - interval '10 days' WHERE organisation_id = org;
  PERFORM pg_temp.assert_eq(app.organisation_access_open(org), false, 'beyond the grace period the organisation is locked');
  r := pg_temp.api_apply(org, pg_temp.snap('sub_on3', 'active', 2, 3), t0 + interval '3 hours');
  SELECT * INTO v_sub FROM public.organisation_subscriptions WHERE organisation_id = org;
  PERFORM pg_temp.assert_eq((v_sub.status, v_sub.past_due_since IS NULL)::text, '(active,t)', 'a paid invoice makes it active and clears the clock');
  PERFORM pg_temp.assert_eq(app.organisation_access_open(org), true, 'and unlocks it');

  -- Cancellation at period end keeps access until then.
  r := pg_temp.api_apply(org, pg_temp.snap('sub_on3', 'active', 2, 3, now() + interval '20 days', true), t0 + interval '4 hours');
  PERFORM pg_temp.assert_eq((SELECT cancel_at_period_end FROM public.organisation_subscriptions WHERE organisation_id = org), true, 'cancel at period end is stored');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.subscription_audit_logs WHERE organisation_id = org AND event_type = 'cancellation_requested'), 1::bigint, 'and logged');
  r := pg_temp.api_apply(org, pg_temp.snap('sub_on3', 'canceled', 2, 3, now() + interval '5 days', true), t0 + interval '5 hours');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.organisation_subscriptions WHERE organisation_id = org), 'cancelled', 'Stripe canceled maps to cancelled');
  PERFORM pg_temp.assert_eq(app.organisation_access_open(org), true, 'cancelled but paid to the end of the period: still open');
  r := pg_temp.api_apply(org, pg_temp.snap('sub_on3', 'canceled', 2, 3, now() - interval '1 day', true), t0 + interval '6 hours');
  PERFORM pg_temp.assert_eq(app.organisation_access_open(org), false, 'after the period it is locked');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.user_subscription_assignments WHERE organisation_id = org AND status = 'active'), 1::bigint, 'but nobody loses their seat');

  -- Resubscribing with a new Stripe subscription replaces the cancelled one; the owner keeps the Controller seat.
  PERFORM pg_temp.as_api(format($q$SELECT app.stripe_start_checkout(%L, %L, 'cs_test_two', 'month', '{"controller":1}')$q$, org, u_owner));
  r := pg_temp.api_apply(org, pg_temp.snap('sub_on3b', 'trialing', 1), t0 + interval '7 hours', 'cs_test_two');
  PERFORM pg_temp.assert_eq((SELECT (provider_subscription_id, status)::text FROM public.organisation_subscriptions WHERE organisation_id = org), '(sub_on3b,trialing)', 'a new subscription replaces the cancelled one');
  PERFORM pg_temp.assert_eq(app.organisation_access_open(org), true, 'open again');
  PERFORM pg_temp.assert_eq((SELECT jsonb_object_agg(p.slug, i.quantity) FROM public.organisation_subscription_items i JOIN public.subscription_plans p ON p.id = i.subscription_plan_id WHERE i.organisation_id = org), '{"controller": 1, "contributor": 0}'::jsonb, 'packages missing from the snapshot go to 0');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.user_subscription_assignments WHERE organisation_id = org AND status = 'active'), 1::bigint, 'still one seat');
  PERFORM pg_temp.assert_fails(format($q$SELECT pg_temp.api_apply(%L, pg_temp.snap('sub_other', 'active', 1), now())$q$, org), 'a different live subscription cannot replace a live one');
  PERFORM pg_temp.assert_fails(format($q$SELECT pg_temp.as_api(format('SELECT app.stripe_start_checkout(%%L, %%L, %%L, %%L, %%L)', %L, %L, 'cs_test_three', 'month', '{}'))$q$, org, u_owner), 'a live subscription blocks another checkout');

  -- No seat is handed out for a subscription that is not usable; once it is, the longest-standing owner gets it when nobody started a checkout.
  PERFORM pg_temp.api_apply(org2, pg_temp.snap('sub_org2', 'unpaid', 1, 0, now() + interval '14 days', false, 'cus_on3other'), t0);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.user_subscription_assignments WHERE organisation_id = org2), 0::bigint, 'an unpaid subscription gets no seat');
  PERFORM pg_temp.assert_eq(app.organisation_access_open(org2), false, 'and is not open');
  PERFORM pg_temp.api_apply(org2, pg_temp.snap('sub_org2', 'active', 1, 0, now() + interval '30 days', false, 'cus_on3other'), t0 + interval '1 minute');
  PERFORM pg_temp.assert_eq((SELECT m.user_id FROM public.user_subscription_assignments a JOIN public.organisation_users m ON m.id = a.organisation_membership_id WHERE a.organisation_id = org2 AND a.status = 'active'), u_other, 'the owner gets the seat when no checkout was recorded');
  PERFORM pg_temp.assert_eq(app.organisation_access_open(org2), true, 'and the organisation opens');

  -- Other rules: unknown price, one subscription per organisation, quantity below assignments.
  PERFORM pg_temp.assert_fails(format($q$SELECT pg_temp.api_apply(%L, jsonb_set(pg_temp.snap('sub_on3b', 'active', 1), '{items,0,priceId}', '"price_nope_1234"'), t0 + interval '1 day')$q$, org), 'an unknown Stripe price is refused');
  PERFORM pg_temp.assert_fails(format($q$SELECT pg_temp.api_apply(%L, pg_temp.snap('sub_on3b', 'active', 1), now())$q$, org2), 'a subscription id belongs to one organisation only');
  PERFORM pg_temp.assert_fails(format($q$SELECT pg_temp.api_apply(%L, pg_temp.snap('sub_x', 'weird', 1), now())$q$, org), 'an unknown status is refused');
  PERFORM pg_temp.assert_fails($q$SELECT pg_temp.api_apply('3f000000-0000-0000-0000-0000000000ff', pg_temp.snap('sub_y', 'active', 1), now())$q$, 'an unknown organisation is refused');
  PERFORM pg_temp.api_apply(org, pg_temp.snap('sub_on3b', 'active', 3, 3), t0 + interval '8 hours');
  PERFORM pg_temp.login(u_owner);
  PERFORM app.assign_subscription_package(m_view, 'contributor');
  PERFORM app.assign_subscription_package(m_owner2, 'contributor');
  PERFORM pg_temp.logout();
  -- The Controller invariant: while valid, an owner keeps a Controller seat (a free Contributor seat exists, so a downgrade is otherwise possible).
  PERFORM pg_temp.login(u_owner);
  PERFORM pg_temp.assert_fails(format($q$SELECT pg_temp.try_unassign_owner(%L)$q$, m_owner), 'the only Controller seat of an owner cannot be removed');
  PERFORM pg_temp.assert_fails(format($q$SELECT pg_temp.try_downgrade_owner(%L)$q$, m_owner), 'nor swapped for a lower package');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_fails(format($q$SELECT pg_temp.try_drop_owner_role(%L, %L)$q$, m_owner, owner_role), 'nor can the owner role be removed from them (another owner remains)');
  PERFORM pg_temp.assert_fails(format($q$SELECT pg_temp.try_suspend(%L)$q$, m_owner), 'nor can they be suspended');
  PERFORM pg_temp.assert_eq(app.organisation_has_owner_controller(org), true, 'the owner still holds the seat');
  -- With a second owner holding a Controller seat, the first may go.
  PERFORM pg_temp.login(u_owner);
  PERFORM app.assign_subscription_package(m_owner2, 'controller');
  PERFORM pg_temp.assert_ok(format($q$SELECT pg_temp.try_unassign_owner(%L)$q$, m_owner), 'another owner with a Controller seat makes it fine');
  PERFORM app.assign_subscription_package(m_owner, 'controller');
  PERFORM app.assign_subscription_package(m_owner2, 'contributor');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.api_apply(org, pg_temp.snap('sub_on3b', 'active', 3, 1), t0 + interval '9 hours');
  PERFORM pg_temp.assert_eq((SELECT quantity FROM public.organisation_subscription_items i JOIN public.subscription_plans p ON p.id = i.subscription_plan_id AND p.slug = 'contributor' WHERE i.organisation_id = org), 1, 'Stripe is believed even below the assignments');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.user_subscription_assignments a JOIN public.subscription_plans p ON p.id = a.subscription_plan_id AND p.slug = 'contributor' WHERE a.organisation_id = org AND a.status = 'active'), 2::bigint, 'nobody is unassigned automatically');
  PERFORM pg_temp.assert_eq((SELECT details ->> 'overAssigned' FROM public.subscription_audit_logs WHERE organisation_id = org AND event_type = 'admin_override' ORDER BY created_at DESC LIMIT 1), '1', 'the excess is recorded');

  -- Seat-change checks.
  PERFORM pg_temp.login(u_owner);
  PERFORM pg_temp.assert_eq(app.check_seat_change(org, '{"controller":3,"contributor":2,"observer":0}'::jsonb), ARRAY[]::text[], 'a fine change has no problems');
  PERFORM pg_temp.assert_eq(cardinality(app.check_seat_change(org, '{"controller":0}'::jsonb)) >= 1, true, 'no Controller seat is a problem');
  problems := app.check_seat_change(org, '{"controller":2,"contributor":1}'::jsonb);
  PERFORM pg_temp.assert_eq(problems[1] LIKE '%cannot go below the 2 in use%', true, 'below the seats in use is a problem, and says how many');
  problems := app.check_seat_change(org, '{"gold":1}'::jsonb);
  PERFORM pg_temp.assert_eq(problems[1], 'Unknown package gold.', 'an unknown package is named');
  PERFORM pg_temp.assert_eq(cardinality(app.check_seat_change(org, '{"controller":-1}'::jsonb)) >= 1, true, 'a negative quantity is a problem');
  PERFORM pg_temp.assert_fails($q$SELECT app.set_subscription_seats(NULL, 'controller', 1)$q$, 'manual seats need an organisation');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.set_subscription_seats(%L, 'controller', 5)$q$, org), 'manual seat changes are refused for a Stripe-billed organisation');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_view);
  PERFORM pg_temp.assert_fails(format($q$SELECT app.check_seat_change(%L, '{"controller":3}'::jsonb)$q$, org), 'a member without subscription.manage cannot ask');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_other);
  PERFORM pg_temp.assert_fails(format($q$SELECT app.set_subscription_seats(%L, 'controller', 5)$q$, org2), 'a gated organisation cannot grant itself seats by hand');
  PERFORM pg_temp.logout();

  -- Invoices: upserted by Stripe's id, with the payment.
  PERFORM pg_temp.as_api(format($q$SELECT app.stripe_apply_invoice(%L, %L::jsonb)$q$, org, jsonb_build_object('id', 'in_on3_1', 'number', 'FQ-0001', 'status', 'open', 'currency', 'gbp', 'subtotal', 12500, 'tax', 2500, 'total', 15000,
    'periodStart', now(), 'periodEnd', now() + interval '1 month', 'created', current_date, 'pdfUrl', 'https://stripe.test/inv.pdf', 'paymentIntentId', 'pi_on3_1', 'paymentStatus', 'pending')));
  PERFORM pg_temp.as_api(format($q$SELECT app.stripe_apply_invoice(%L, %L::jsonb)$q$, org, jsonb_build_object('id', 'in_on3_1', 'number', 'FQ-0001', 'status', 'paid', 'currency', 'gbp', 'subtotal', 12500, 'tax', 2500, 'total', 15000,
    'periodStart', now(), 'periodEnd', now() + interval '1 month', 'created', current_date, 'paidAt', now(), 'pdfUrl', 'https://stripe.test/inv.pdf', 'paymentIntentId', 'pi_on3_1', 'paymentStatus', 'succeeded')));
  PERFORM pg_temp.assert_eq((SELECT (count(*), min(status), min(total_amount))::text FROM public.billing_invoices WHERE organisation_id = org), '(1,paid,15000)', 'one invoice, updated to paid');
  PERFORM pg_temp.assert_eq((SELECT (count(*), min(status))::text FROM public.billing_payments WHERE organisation_id = org), '(1,succeeded)', 'one payment, succeeded');
  PERFORM pg_temp.assert_fails(format($q$SELECT pg_temp.as_api(format('SELECT app.stripe_apply_invoice(%%L, %%L::jsonb)', %L, '{"id":"in_bad","status":"nonsense","total":1,"subtotal":1,"tax":0}'))$q$, org), 'an unknown invoice status is refused');

  -- Events: once each, with retries and failures visible to the operator only.
  PERFORM pg_temp.as_api($q$SELECT app.stripe_record_event('evt_on3_a', 'customer.subscription.updated')$q$);
  PERFORM pg_temp.assert_eq((SELECT status FROM public.stripe_events WHERE event_id = 'evt_on3_a'), 'received', 'an event is recorded as received');
  PERFORM pg_temp.assert_eq(app.stripe_record_event('evt_on3_a', 'customer.subscription.updated'), 'retry', 'an unfinished event is retried');
  PERFORM pg_temp.assert_eq((SELECT attempts FROM public.stripe_events WHERE event_id = 'evt_on3_a'), 2, 'counting the attempts');
  PERFORM app.stripe_finish_event('evt_on3_a', 'failed', 'boom', org);
  PERFORM pg_temp.assert_eq(app.stripe_record_event('evt_on3_a', 'customer.subscription.updated'), 'retry', 'a failed event is retried');
  PERFORM app.stripe_finish_event('evt_on3_a', 'processed', NULL, org);
  PERFORM pg_temp.assert_eq(app.stripe_record_event('evt_on3_a', 'customer.subscription.updated'), 'duplicate', 'a processed event is a duplicate');
  PERFORM pg_temp.assert_eq(app.stripe_record_event('evt_on3_b', 'invoice.paid'), 'new', 'a new id is new');
  PERFORM pg_temp.assert_fails($q$SELECT app.stripe_record_event('not-an-event', 'x')$q$, 'event ids have Stripe''s shape');
  INSERT INTO public.platform_admins (user_id, note) VALUES (u_op, 'test operator');
  PERFORM pg_temp.login(u_owner);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.stripe_events), 0::bigint, 'an owner cannot see webhook events');
  PERFORM pg_temp.logout();
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u_op, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.stripe_events) >= 2, true, 'the operator (with MFA) can');
  PERFORM pg_temp.logout();

  -- Lookups the API needs.
  PERFORM pg_temp.assert_eq(app.stripe_organisation_for('cus_on3test'), org, 'a customer maps to its organisation');
  PERFORM pg_temp.assert_eq(app.stripe_organisation_for(NULL, 'sub_on3b'), org, 'so does a subscription');
  PERFORM pg_temp.assert_eq(app.stripe_organisation_for('cus_unknown1'), NULL, 'an unknown customer maps to nothing');
  PERFORM pg_temp.assert_eq(app.stripe_price_for('controller', 'month'), 'price_ctrl_month', 'the Stripe price for a package and interval');
  PERFORM pg_temp.assert_eq(app.stripe_price_for('observer', 'month'), NULL, 'none when not set up in Stripe');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.stripe_set_customer(%L, 'cus_different')$q$, org), 'an organisation has one Stripe customer');

  -- Isolation: another organisation sees none of this.
  PERFORM pg_temp.login(u_other);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.billing_customers WHERE organisation_id = org), 0::bigint, 'isolation: customers');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.stripe_checkout_sessions WHERE organisation_id = org), 0::bigint, 'isolation: checkout sessions');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.billing_invoices WHERE organisation_id = org), 0::bigint, 'isolation: invoices');
  PERFORM pg_temp.assert_fails($q$INSERT INTO public.billing_customers (organisation_id, provider_customer_id) VALUES ('3f000000-0000-0000-0000-0000000000aa', 'cus_hack1234')$q$, 'customers have no direct writes');
  PERFORM pg_temp.assert_fails($q$UPDATE public.organisation_subscriptions SET status = 'active'$q$, 'subscriptions have no direct writes');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_view);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.billing_customers), 0::bigint, 'a viewer cannot read the customer either (needs subscription.read)');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
