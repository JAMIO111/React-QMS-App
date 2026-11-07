-- ON5a: the operator's views (admin + MFA only; counts and billing, never quality data) and the scheduled clean-up (dry run first; never touches organisations that do not need a
-- subscription or have a valid one; idempotent; for the API login only).
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

CREATE FUNCTION pg_temp.login_aal(p_user uuid, p_aal text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
  PERFORM set_config('role', 'authenticated', true);
END $$;

-- Run something as the API's own login and hand back its jsonb answer.
CREATE FUNCTION pg_temp.as_api_json(stmt text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  PERFORM set_config('role', 'qms_api', true);
  BEGIN
    EXECUTE stmt INTO r;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('role', 'postgres', true);
    RAISE;
  END;
  PERFORM set_config('role', 'postgres', true);
  RETURN r;
END $$;

-- A subscription written directly (as the superuser): status, interval, seats per package.
CREATE FUNCTION pg_temp.seed_sub(p_org uuid, p_provider text, p_status text, p_interval text, p_controller integer, p_contributor integer DEFAULT 0) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_sub uuid; v_plan uuid; v_price public.subscription_prices%ROWTYPE; v_slug text; v_qty integer;
BEGIN
  INSERT INTO public.organisation_subscriptions (organisation_id, billing_provider, provider_subscription_id, status, billing_interval, current_period_end, trial_end)
  VALUES (p_org, p_provider, CASE WHEN p_provider = 'stripe' THEN 'sub_' || replace(p_org::text, '-', '') END, p_status, p_interval, now() + interval '20 days', now() + interval '3 days')
  RETURNING id INTO v_sub;
  FOR v_slug, v_qty IN VALUES ('controller', p_controller), ('contributor', p_contributor) LOOP
    CONTINUE WHEN v_qty = 0;
    SELECT id INTO v_plan FROM public.subscription_plans WHERE slug = v_slug;
    SELECT * INTO v_price FROM public.subscription_prices WHERE subscription_plan_id = v_plan AND billing_interval = p_interval AND currency = 'GBP' AND active AND effective_to IS NULL;
    INSERT INTO public.organisation_subscription_items (organisation_id, organisation_subscription_id, subscription_plan_id, subscription_price_id, quantity, unit_amount_snapshot, currency)
    VALUES (p_org, v_sub, v_plan, v_price.id, v_qty, v_price.unit_amount, 'GBP');
  END LOOP;
  RETURN v_sub;
END $$;

INSERT INTO auth.users (id, email) VALUES
  ('3f000000-0000-0000-0000-000000000d01', 'operator@on5.test'),
  ('3f000000-0000-0000-0000-000000000d02', 'alice@acme-on5.test'),
  ('3f000000-0000-0000-0000-000000000d03', 'bob@beta-on5.test'),
  ('3f000000-0000-0000-0000-000000000d04', 'plain@on5.test');

DO $$
DECLARE
  u_op uuid := '3f000000-0000-0000-0000-000000000d01'; u_alice uuid := '3f000000-0000-0000-0000-000000000d02'; u_bob uuid := '3f000000-0000-0000-0000-000000000d03'; u_plain uuid := '3f000000-0000-0000-0000-000000000d04';
  oa uuid; ob uuid; oc uuid; od uuid; oe uuid; r jsonb; rec record; n bigint; base_mrr bigint; base_trial bigint;
  fn text;
BEGIN
  INSERT INTO public.platform_admins (user_id, note) VALUES (u_op, 'operator');
  UPDATE public.platform_settings SET value = 'true'::jsonb WHERE key = 'billing_gate_enabled'; -- new organisations must have a subscription
  -- Five organisations: A active (2 Controller + 3 Contributor, monthly), B trialing (1 Controller, annual), C past due, D cancelled a week ago, E on manual billing.
  PERFORM pg_temp.login(u_alice); oa := app.start_organisation('Acme On5', 'Plant A', 'PA', 'Europe/London', 'GB', NULL); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_bob); ob := app.start_organisation('Beta On5', 'Plant B', 'PB', 'Europe/London', 'GB', NULL); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_plain); oc := app.start_organisation('Gamma On5', 'Plant C', 'PC', 'Europe/London', 'GB', NULL); od := app.start_organisation('Delta On5', 'Plant D', 'PD', 'Europe/London', 'GB', 'k-d'); oe := app.start_organisation('Epsilon On5', 'Plant E', 'PE', 'Europe/London', 'GB', 'k-e'); PERFORM pg_temp.logout();

  PERFORM pg_temp.login_aal(u_op, 'aal2');
  SELECT (app.platform_revenue() ->> 'mrrPence')::bigint, (app.platform_revenue() ->> 'trialMrrPence')::bigint INTO base_mrr, base_trial;
  PERFORM pg_temp.logout();

  PERFORM pg_temp.seed_sub(oa, 'stripe', 'active', 'month', 2, 3);       -- 2 x 2500 + 3 x 1000 = 8000 a month
  PERFORM pg_temp.seed_sub(ob, 'stripe', 'trialing', 'year', 1);         -- 25000 a year = 2083 a month (trial)
  PERFORM pg_temp.seed_sub(oc, 'stripe', 'past_due', 'month', 1);        -- 2500 a month, still owed
  PERFORM pg_temp.seed_sub(od, 'stripe', 'cancelled', 'month', 1);
  UPDATE public.organisation_subscriptions SET cancelled_at = now() - interval '7 days', current_period_end = now() - interval '7 days' WHERE organisation_id = od;
  PERFORM pg_temp.seed_sub(oe, 'manual', 'active', 'month', 4);          -- not Stripe: not in revenue
  UPDATE public.organisation_subscriptions SET cancel_at_period_end = true WHERE organisation_id = oa;
  INSERT INTO public.subscription_audit_logs (organisation_id, event_type, details) VALUES (oa, 'subscription_created', '{"provider":"stripe","interval":"month"}'), (oc, 'payment_failed', '{"status":"past_due"}');

  -- Access: operators with MFA only. Everyone else is refused by every function.
  FOREACH fn IN ARRAY ARRAY['app.platform_organisations()', 'app.platform_revenue()', 'app.platform_payments()', 'app.platform_webhooks()', 'app.platform_activity()'] LOOP
    PERFORM pg_temp.login(u_plain);
    PERFORM pg_temp.assert_fails(format('SELECT * FROM %s', fn), fn || ': an ordinary member is refused');
    PERFORM pg_temp.logout();
    PERFORM pg_temp.login_aal(u_op, 'aal1');
    PERFORM pg_temp.assert_fails(format('SELECT * FROM %s', fn), fn || ': an operator without MFA is refused');
    PERFORM pg_temp.logout();
    PERFORM pg_temp.login_anon();
    PERFORM pg_temp.assert_fails(format('SELECT * FROM %s', fn), fn || ': anonymous is refused');
    PERFORM pg_temp.logout();
  END LOOP;

  PERFORM pg_temp.login_aal(u_op, 'aal2');

  -- Revenue: Stripe-billed only; paying = active + past due.
  r := app.platform_revenue();
  PERFORM pg_temp.assert_eq((r ->> 'mrrPence')::bigint - base_mrr, (8000 + 2500)::bigint, 'MRR counts active and past-due Stripe subscriptions');
  PERFORM pg_temp.assert_eq((r ->> 'arrPence')::bigint, (r ->> 'mrrPence')::bigint * 12, 'ARR is twelve times MRR');
  PERFORM pg_temp.assert_eq((r ->> 'trialMrrPence')::bigint - base_trial, 2083::bigint, 'trial MRR is the monthly equivalent of an annual plan');
  PERFORM pg_temp.assert_eq((r ->> 'trialsEndingSoon')::int >= 1, true, 'a trial ending within a week is counted');
  PERFORM pg_temp.assert_eq((r ->> 'pastDue')::int >= 1, true, 'past due is counted');
  PERFORM pg_temp.assert_eq((r ->> 'cancelling')::int >= 1, true, 'a subscription set to cancel is counted');
  PERFORM pg_temp.assert_eq((r ->> 'cancelledLast30Days')::int >= 1, true, 'a recent cancellation is counted');
  PERFORM pg_temp.assert_eq((r ->> 'newLast30Days')::int >= 1, true, 'a new Stripe subscription is counted');
  PERFORM pg_temp.assert_eq((r -> 'byStatus' ->> 'trialing')::int >= 1, true, 'by status');
  PERFORM pg_temp.assert_eq((SELECT (e ->> 'purchased')::int >= 3 FROM jsonb_array_elements(r -> 'seats') e WHERE e ->> 'slug' = 'contributor'), true, 'seats by package');
  PERFORM pg_temp.assert_eq(r ->> 'currency', 'GBP', 'currency');

  -- Organisations: one row each, with owners, members, set-up, subscription and MRR; search by name or owner.
  SELECT * INTO rec FROM app.platform_organisations('Acme On5');
  PERFORM pg_temp.assert_eq((rec.name, rec.status, rec.subscription_status, rec.billing_provider, rec.mrr_pence, rec.seats_purchased, rec.cancel_at_period_end)::text, '("Acme On5",active,active,stripe,8000,5,t)', 'organisation row');
  PERFORM pg_temp.assert_eq(rec.owner_emails, ARRAY['alice@acme-on5.test'], 'owner emails');
  PERFORM pg_temp.assert_eq(rec.members, 1::bigint, 'members');
  PERFORM pg_temp.assert_eq(rec.total_rows, 1::bigint, 'total rows for the search');
  PERFORM pg_temp.assert_eq((SELECT organisation_id FROM app.platform_organisations('BOB@beta-on5')), ob, 'searching by an owner email finds the organisation');
  PERFORM pg_temp.assert_eq((SELECT mrr_pence FROM app.platform_organisations('Beta On5')), 2083::bigint, 'annual MRR is divided by twelve');
  PERFORM pg_temp.assert_eq((SELECT mrr_pence FROM app.platform_organisations('Epsilon On5')), 4 * 2500::bigint, 'a manual subscription shows its own amount here (revenue leaves it out)');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.platform_organisations('On5')), 5::bigint, 'search matches several');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.platform_organisations('On5', 2, 0)), 2::bigint, 'paging: limit');
  PERFORM pg_temp.assert_eq((SELECT total_rows FROM app.platform_organisations('On5', 2, 2) LIMIT 1), 5::bigint, 'paging: total stays');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.platform_organisations('nothing-matches-this')), 0::bigint, 'no match');
  PERFORM pg_temp.assert_fails($q$SELECT * FROM app.platform_organisations(NULL, 0, 0)$q$, 'a limit of 0 is refused');
  PERFORM pg_temp.assert_fails($q$SELECT * FROM app.platform_organisations(NULL, 500, 0)$q$, 'so is a huge one');

  -- Payments.
  PERFORM pg_temp.logout();
  INSERT INTO public.billing_invoices (organisation_id, provider_invoice_id, invoice_number, subtotal, tax_amount, total_amount, status, invoice_date, paid_at)
    VALUES (oa, 'in_on5_1', 'FQ-ON5-1', 8000, 1600, 9600, 'paid', current_date, now()), (oc, 'in_on5_2', 'FQ-ON5-2', 2500, 500, 3000, 'open', current_date, NULL);
  INSERT INTO public.billing_payments (organisation_id, provider_payment_id, invoice_id, amount, status)
    SELECT oc, 'pi_on5_f', id, 3000, 'failed' FROM public.billing_invoices WHERE provider_invoice_id = 'in_on5_2';
  PERFORM pg_temp.login_aal(u_op, 'aal2');
  r := app.platform_payments(10);
  PERFORM pg_temp.assert_eq(jsonb_array_length(r -> 'invoices') >= 2, true, 'invoices listed');
  PERFORM pg_temp.assert_eq((SELECT e ->> 'organisation' FROM jsonb_array_elements(r -> 'invoices') e WHERE e ->> 'number' = 'FQ-ON5-1'), 'Acme On5', 'with the organisation');
  PERFORM pg_temp.assert_eq((r ->> 'paidLast30DaysPence')::bigint >= 9600, true, 'paid in the last 30 days');
  PERFORM pg_temp.assert_eq((r ->> 'taxLast30DaysPence')::bigint >= 1600, true, 'and the VAT in it');
  PERFORM pg_temp.assert_eq((r ->> 'failedLast30Days')::int >= 1, true, 'a failed payment is counted');
  PERFORM pg_temp.assert_eq((SELECT e ->> 'invoice' FROM jsonb_array_elements(r -> 'failedPayments') e WHERE e ->> 'organisation' = 'Gamma On5'), 'FQ-ON5-2', 'and named');
  PERFORM pg_temp.assert_fails($q$SELECT app.platform_payments(0)$q$, 'a limit of 0 is refused');

  -- Webhooks.
  PERFORM pg_temp.logout();
  INSERT INTO public.stripe_events (event_id, event_type, status, processed_at) VALUES ('evt_on5_ok', 'invoice.paid', 'processed', now()), ('evt_on5_ign', 'charge.refunded', 'ignored', now());
  INSERT INTO public.stripe_events (event_id, event_type, status, error, attempts, organisation_id) VALUES ('evt_on5_bad', 'customer.subscription.updated', 'failed', 'Unknown Stripe price price_x', 3, oa);
  INSERT INTO public.stripe_events (event_id, event_type, status, received_at) VALUES ('evt_on5_stuck', 'invoice.created', 'received', now() - interval '20 minutes');
  PERFORM pg_temp.login_aal(u_op, 'aal2');
  r := app.platform_webhooks(24);
  PERFORM pg_temp.assert_eq((r -> 'counts' ->> 'failed')::int >= 1 AND (r -> 'counts' ->> 'processed')::int >= 1 AND (r -> 'counts' ->> 'ignored')::int >= 1, true, 'event counts by status');
  PERFORM pg_temp.assert_eq((r ->> 'stuck')::int >= 1, true, 'an event received but not finished for over five minutes is stuck');
  PERFORM pg_temp.assert_eq((SELECT e ->> 'error' FROM jsonb_array_elements(r -> 'failed') e WHERE e ->> 'eventId' = 'evt_on5_bad'), 'Unknown Stripe price price_x', 'a failed event shows its error');
  PERFORM pg_temp.assert_eq((SELECT (e ->> 'attempts')::int FROM jsonb_array_elements(r -> 'failed') e WHERE e ->> 'eventId' = 'evt_on5_bad'), 3, 'and its attempts');
  PERFORM pg_temp.assert_eq((SELECT e ->> 'organisation' FROM jsonb_array_elements(r -> 'failed') e WHERE e ->> 'eventId' = 'evt_on5_bad'), 'Acme On5', 'and the organisation');
  PERFORM pg_temp.assert_eq(r ->> 'lastReceivedAt' IS NOT NULL, true, 'when Stripe last reached us');
  PERFORM pg_temp.assert_eq(jsonb_array_length(r -> 'types') >= 1, true, 'event types');
  PERFORM pg_temp.assert_fails($q$SELECT app.platform_webhooks(0)$q$, 'zero hours is refused');

  -- Activity: billing events and organisation milestones.
  SELECT count(*) INTO n FROM app.platform_activity(100) WHERE kind = 'billing' AND event = 'payment_failed' AND organisation_name = 'Gamma On5';
  PERFORM pg_temp.assert_eq(n, 1::bigint, 'a payment failure is in the feed');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.platform_activity(100) WHERE event = 'organisation_started') >= 5, true, 'organisations started');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.platform_activity(3)), 3::bigint, 'the limit applies');
  PERFORM pg_temp.logout();

  -- ---- The scheduled clean-up ------------------------------------------------------------------------------------------------------------------------------
  -- F: unpaid, old set-up.  G: unpaid but new.  H: old but does not need a subscription.  I: old, valid subscription.  J: lapsed 100 days ago.  K: lapsed 10 days ago.  L: unpaid, old, set-up finished.
  DECLARE of_ uuid; og uuid; oh uuid; oi uuid; oj uuid; ok_ uuid; ol uuid; m_i uuid; item_i uuid;
  BEGIN
    PERFORM pg_temp.login(u_plain);
    of_ := app.start_organisation('Old Unpaid On5', 'P', 'P1', 'Europe/London', 'GB', 'k-f');
    og := app.start_organisation('New Unpaid On5', 'P', 'P2', 'Europe/London', 'GB', 'k-g');
    oh := app.start_organisation('Grandfathered On5', 'P', 'P3', 'Europe/London', 'GB', 'k-h');
    oi := app.start_organisation('Paying On5', 'P', 'P4', 'Europe/London', 'GB', 'k-i');
    oj := app.start_organisation('Long Lapsed On5', 'P', 'P5', 'Europe/London', 'GB', 'k-j');
    ok_ := app.start_organisation('Recently Lapsed On5', 'P', 'P6', 'Europe/London', 'GB', 'k-k');
    ol := app.start_organisation('Finished Setup On5', 'P', 'P7', 'Europe/London', 'GB', 'k-l');
    PERFORM pg_temp.logout();
    UPDATE public.organisations SET created_at = now() - interval '20 days' WHERE id IN (of_, oh, oi, ol);
    UPDATE public.organisations SET billing_required = false WHERE id = oh;
    UPDATE public.organisations SET onboarding_completed_at = now() WHERE id = ol;
    PERFORM pg_temp.seed_sub(oi, 'stripe', 'active', 'month', 1);
    SELECT m.id INTO m_i FROM public.organisation_users m WHERE m.organisation_id = oi LIMIT 1;
    SELECT i.id INTO item_i FROM public.organisation_subscription_items i WHERE i.organisation_id = oi LIMIT 1;
    INSERT INTO public.user_subscription_assignments (organisation_id, organisation_membership_id, subscription_plan_id, subscription_item_id)
      SELECT oi, m_i, i.subscription_plan_id, i.id FROM public.organisation_subscription_items i WHERE i.id = item_i;
    PERFORM pg_temp.assert_eq(app.organisation_subscription_valid(oi), true, 'setup: the paying organisation is valid');
    PERFORM pg_temp.seed_sub(oj, 'stripe', 'cancelled', 'month', 1);
    UPDATE public.organisation_subscriptions SET current_period_end = now() - interval '100 days', cancelled_at = now() - interval '110 days' WHERE organisation_id = oj;
    PERFORM pg_temp.seed_sub(ok_, 'stripe', 'cancelled', 'month', 1);
    UPDATE public.organisation_subscriptions SET current_period_end = now() - interval '10 days' WHERE organisation_id = ok_;

    -- Not callable by people, or anonymous; callable by the API login.
    PERFORM pg_temp.login(u_plain);
    PERFORM pg_temp.assert_fails($q$SELECT app.system_archive_stale_organisations(14, 90, true)$q$, 'a signed-in person cannot run the archive job');
    PERFORM pg_temp.assert_fails($q$SELECT * FROM app.system_reconcile_candidates(10, 60)$q$, 'nor the reconcile list');
    PERFORM pg_temp.logout();
    PERFORM pg_temp.login_aal(u_op, 'aal2');
    PERFORM pg_temp.assert_fails($q$SELECT app.system_archive_stale_organisations(14, 90, true)$q$, 'not even an operator: only the API login');
    PERFORM pg_temp.logout();
    PERFORM pg_temp.assert_fails($q$SELECT app.system_archive_stale_organisations(3, 90, true)$q$, 'a period under a week is refused');
    PERFORM pg_temp.assert_fails($q$SELECT app.system_archive_stale_organisations(14, 10, true)$q$, 'so is a lapsed period under 30 days');

    -- A dry run lists and changes nothing.
    r := pg_temp.as_api_json('SELECT app.system_archive_stale_organisations(14, 90, true)');
    PERFORM pg_temp.assert_eq((r ->> 'dryRun')::boolean, true, 'dry run');
    PERFORM pg_temp.assert_eq((r ->> 'archived')::int, 0, 'nothing archived in a dry run');
    PERFORM pg_temp.assert_eq((SELECT array_agg(e ->> 'name' ORDER BY e ->> 'name') FROM jsonb_array_elements(r -> 'unpaid') e WHERE e ->> 'name' LIKE '%On5'), ARRAY['Old Unpaid On5'], 'only the old, unpaid, unfinished set-up is listed as unpaid');
    PERFORM pg_temp.assert_eq((SELECT array_agg(e ->> 'name' ORDER BY e ->> 'name') FROM jsonb_array_elements(r -> 'lapsed') e WHERE e ->> 'name' LIKE '%On5'), ARRAY['Long Lapsed On5'], 'only the long-lapsed one is listed as lapsed');
    PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.organisations WHERE status = 'archived'), 0::bigint, 'and nothing changed');

    -- The real run archives exactly those, with their reason, and leaves the rest alone.
    r := pg_temp.as_api_json('SELECT app.system_archive_stale_organisations(14, 90, false)');
    PERFORM pg_temp.assert_eq((r ->> 'archived')::int >= 2, true, 'archived');
    PERFORM pg_temp.assert_eq((SELECT array_agg(name || ':' || archived_reason ORDER BY name) FROM public.organisations WHERE status = 'archived' AND name LIKE '%On5'), ARRAY['Long Lapsed On5:lapsed', 'Old Unpaid On5:unpaid_setup'], 'archived with the right reasons');
    PERFORM pg_temp.assert_eq((SELECT bool_and(archived_at IS NOT NULL) FROM public.organisations WHERE status = 'archived'), true, 'archived_at is set');
    PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.organisations WHERE name LIKE '%On5' AND status = 'active'), 10::bigint, 'every other organisation is untouched (new, grandfathered, paying, recently lapsed, finished set-up and the first five)');
    PERFORM pg_temp.assert_eq((SELECT status FROM public.organisations WHERE id = oh), 'active', 'one that does not need a subscription is never archived, however old');
    PERFORM pg_temp.assert_eq((SELECT status FROM public.organisations WHERE id = oi), 'active', 'nor one with a valid subscription');
    PERFORM pg_temp.assert_eq((SELECT status FROM public.organisations WHERE id = ol), 'active', 'nor one whose set-up was finished');

    -- Idempotent: running it again changes nothing more.
    r := pg_temp.as_api_json('SELECT app.system_archive_stale_organisations(14, 90, false)');
    PERFORM pg_temp.assert_eq(((SELECT count(*) FROM jsonb_array_elements(r -> 'unpaid') e WHERE e ->> 'name' LIKE '%On5') + (SELECT count(*) FROM jsonb_array_elements(r -> 'lapsed') e WHERE e ->> 'name' LIKE '%On5')), 0::bigint, 'a second run finds nothing more');

    -- An archived organisation is gone for its members, and the data is still there.
    PERFORM pg_temp.login(u_plain);
    PERFORM pg_temp.assert_eq(app.is_member(of_), false, 'members can no longer use an archived organisation');
    PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.organisations WHERE id = of_), 0::bigint, 'nor see it');
    PERFORM pg_temp.logout();
    PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.organisation_users WHERE organisation_id = of_), 1::bigint, 'but its data is kept');
    PERFORM pg_temp.login_aal(u_op, 'aal2');
    PERFORM pg_temp.assert_eq((SELECT status FROM app.platform_organisations('Old Unpaid On5')), 'archived', 'the operator sees it as archived');
    PERFORM pg_temp.assert_eq((SELECT details ->> 'reason' FROM app.platform_activity(200) WHERE event = 'organisation_archived' AND organisation_name = 'Old Unpaid On5'), 'unpaid_setup', 'and why, in the feed');
    PERFORM pg_temp.logout();
    PERFORM pg_temp.assert_ok(format($q$UPDATE public.organisations SET status = 'active', archived_at = NULL, archived_reason = NULL WHERE id = %L$q$, of_), 'an operator can undo it with one update');

    -- Reconcile candidates: Stripe only, stale first, finished ones left alone, limited.
    UPDATE public.organisation_subscriptions SET provider_synced_at = now() WHERE organisation_id = oa;
    UPDATE public.organisation_subscriptions SET provider_synced_at = now() - interval '3 hours' WHERE organisation_id = ob;
    UPDATE public.organisation_subscriptions SET provider_synced_at = now() - interval '2 hours' WHERE organisation_id = oc;
    UPDATE public.organisation_subscriptions SET provider_synced_at = now() - interval '5 hours', current_period_end = now() - interval '60 days' WHERE organisation_id = od;
    r := pg_temp.as_api_json($q$SELECT coalesce(jsonb_agg(c.organisation_id::text ORDER BY c.ord), '[]'::jsonb) FROM (SELECT x.*, row_number() OVER () AS ord FROM app.system_reconcile_candidates(500, 60) x) c$q$);
    PERFORM pg_temp.assert_eq(r ? ob::text AND r ? oc::text, true, 'subscriptions not synced for an hour are candidates');
    PERFORM pg_temp.assert_eq(r ? oa::text, false, 'a fresh one is not');
    PERFORM pg_temp.assert_eq(r ? od::text, false, 'a subscription that ended over 30 days ago is left alone');
    PERFORM pg_temp.assert_eq(r ? oe::text, false, 'and manual billing is not Stripe');
    PERFORM pg_temp.assert_eq((r ->> 0) IS NOT NULL AND (SELECT ord FROM (SELECT value, ordinality AS ord FROM jsonb_array_elements_text(r) WITH ORDINALITY) q WHERE value = ob::text) < (SELECT ord FROM (SELECT value, ordinality AS ord FROM jsonb_array_elements_text(r) WITH ORDINALITY) q WHERE value = oc::text), true, 'the longest unsynced comes first');
    r := pg_temp.as_api_json('SELECT jsonb_agg(organisation_id) FROM app.system_reconcile_candidates(1, 60)');
    PERFORM pg_temp.assert_eq(jsonb_array_length(r), 1, 'the limit applies');
  END;
END $$;

ROLLBACK;
