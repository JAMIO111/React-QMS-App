-- ON2: the billing gate switch, the lock on a gated organisation (billing and set-up only), the subscription rule (valid status AND a Controller seat held by an
-- active Owner), the wizard's saved progress, starting an organisation (idempotent, time zone, country) and isolation.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('3f000000-0000-0000-0000-000000000a01', 'owner@on2.test'),
  ('3f000000-0000-0000-0000-000000000a02', 'viewer@on2.test'),
  ('3f000000-0000-0000-0000-000000000a03', 'other@on2.test'),
  ('3f000000-0000-0000-0000-000000000a04', 'legacy@on2.test');

DO $$
DECLARE
  u_owner uuid := '3f000000-0000-0000-0000-000000000a01'; u_view uuid := '3f000000-0000-0000-0000-000000000a02';
  u_other uuid := '3f000000-0000-0000-0000-000000000a03'; u_legacy uuid := '3f000000-0000-0000-0000-000000000a04';
  org uuid; org2 uuid; legacy uuid; m_owner uuid; m_view uuid; viewer_role uuid; st jsonb; sub public.organisation_subscriptions%ROWTYPE;
BEGIN
  -- Gate off (the default): a new organisation behaves exactly as before.
  PERFORM pg_temp.assert_eq(app.billing_gate_enabled(), false, 'the gate is off by default');
  PERFORM pg_temp.login(u_legacy);
  legacy := app.start_organisation('Legacy Works', 'Plant L', 'PL', 'Europe/Paris', 'fr', 'k-legacy');
  PERFORM pg_temp.assert_eq((SELECT (billing_required, country)::text FROM public.organisations WHERE id = legacy), '(f,FR)', 'gate off: not billing-required, country upper-cased');
  PERFORM pg_temp.assert_eq((SELECT timezone FROM public.sites WHERE organisation_id = legacy), 'Europe/Paris', 'the first site has the time zone');
  PERFORM pg_temp.assert_eq(app.has_permission(legacy, 'ncr.read'), true, 'gate off: the owner works as always');
  PERFORM pg_temp.assert_eq(app.organisation_access_state(legacy), 'open', 'gate off: access is open');
  PERFORM pg_temp.assert_eq(app.start_organisation('Legacy Works', 'Plant L', 'PL', 'Europe/Paris', 'fr', 'k-legacy'), legacy, 'the same idempotency key returns the same organisation');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.organisations WHERE created_by = u_legacy), 1::bigint, 'and creates nothing twice');
  PERFORM pg_temp.assert_fails($q$SELECT app.start_organisation('Bad Zone Ltd', 'Main', 'M', 'Mars/Olympus', NULL, NULL)$q$, 'an unknown time zone is refused');
  PERFORM pg_temp.assert_fails($q$SELECT app.start_organisation('Bad Country Ltd', 'Main', 'M', NULL, 'FRA', NULL)$q$, 'so is a country that is not two letters');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_fails($q$SELECT app.start_organisation('Nobody Ltd')$q$, 'signing in is needed to start an organisation');

  -- The operator switches the gate on: new organisations need a subscription.
  UPDATE public.platform_settings SET value = 'true'::jsonb WHERE key = 'billing_gate_enabled';
  PERFORM pg_temp.assert_eq(app.billing_gate_enabled(), true, 'the gate is on');
  PERFORM pg_temp.login(u_owner);
  org := app.start_organisation('Gated Works', 'Plant A', 'PA', 'Europe/London', 'GB', NULL);
  PERFORM pg_temp.logout();
  SELECT id INTO viewer_role FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u_view, 'active') RETURNING id INTO m_view;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) VALUES (org, m_view, viewer_role);
  PERFORM pg_temp.assert_eq((SELECT (billing_required, (SELECT entitlements_enforced FROM public.organisation_settings WHERE organisation_id = org))::text FROM public.organisations WHERE id = org), '(t,t)', 'gate on: billing required and entitlements enforced');
  SELECT id INTO m_owner FROM public.organisation_users WHERE organisation_id = org AND user_id = u_owner;

  -- Locked: billing and set-up only, for the owner and everyone else.
  PERFORM pg_temp.login(u_owner);
  PERFORM pg_temp.assert_eq(app.organisation_access_state(org), 'needs_subscription', 'no subscription yet');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'ncr.read'), false, 'locked: no quality work');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'members.read'), false, 'locked: no member list');
  PERFORM pg_temp.assert_eq(app.has_permission_somewhere(org, 'ncr.read'), false, 'locked: not even somewhere');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'organisation.manage'), true, 'locked: the owner can set the organisation up');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'subscription.manage'), true, 'locked: and buy seats');
  PERFORM pg_temp.assert_eq((SELECT array_agg(p ORDER BY p) FROM app.my_permissions(org) p), ARRAY['billing_details.manage', 'invoices.read', 'organisation.manage', 'payment_methods.manage', 'subscription.manage', 'subscription.read', 'subscription.seats'], 'locked: the permission list the app sees');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.nonconformances), 0::bigint, 'locked: no quality records are readable');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_view);
  PERFORM pg_temp.assert_eq(app.organisation_access_state(org), 'needs_subscription', 'a member sees the same state');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.my_permissions(org)), 0::bigint, 'locked: a viewer has no permissions at all');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_other);
  PERFORM pg_temp.assert_eq(app.organisation_access_state(org), NULL, 'a stranger is told nothing');
  PERFORM pg_temp.logout();
  -- An organisation started before the gate is grandfathered.
  PERFORM pg_temp.login(u_legacy);
  PERFORM pg_temp.assert_eq(app.has_permission(legacy, 'ncr.read'), true, 'grandfathered: still open with the gate on');
  PERFORM pg_temp.logout();

  -- The wizard.
  PERFORM pg_temp.login(u_owner);
  st := app.onboarding_state(org);
  PERFORM pg_temp.assert_eq(st ->> 'currentStep', 'plan', 'the first thing left is the plan');
  PERFORM pg_temp.assert_eq((st ->> 'canFinish')::boolean, false, 'cannot finish without a subscription');
  PERFORM pg_temp.assert_eq((SELECT jsonb_agg(s ->> 'status' ORDER BY ord) FROM jsonb_array_elements(st -> 'steps') WITH ORDINALITY AS t(s, ord)), '["done", "pending", "pending", "done", "pending", "pending", "pending"]'::jsonb, 'organisation and sites are done at once');
  PERFORM pg_temp.assert_eq((SELECT jsonb_agg((s ->> 'required')::boolean ORDER BY ord) FROM jsonb_array_elements(st -> 'steps') WITH ORDINALITY AS t(s, ord)), '[true, true, false, true, false, false, false]'::jsonb, 'required: organisation, plan (billing is required), sites');
  PERFORM pg_temp.assert_fails($q$SELECT app.set_onboarding_step(NULL, 'details', 'done')$q$, 'an organisation is needed');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.set_onboarding_step(%L, 'nonsense', 'done')$q$, org), 'an unknown step is refused');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.set_onboarding_step(%L, 'plan', 'done')$q$, org), 'the plan is done by buying it, not by marking it');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.set_onboarding_step(%L, 'sites', 'skipped')$q$, org), 'nor are the sites');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.set_onboarding_step(%L, 'details', 'finished')$q$, org), 'a step is done, skipped or pending');
  PERFORM app.set_onboarding_step(org, 'details', 'done');
  PERFORM app.set_onboarding_step(org, 'security', 'skipped');
  PERFORM pg_temp.assert_eq((SELECT steps FROM public.organisation_onboarding WHERE organisation_id = org), '{"details": "done", "security": "skipped"}'::jsonb, 'progress is saved');
  PERFORM app.set_onboarding_step(org, 'security', 'pending');
  PERFORM pg_temp.assert_eq((SELECT steps ->> 'security' FROM public.organisation_onboarding WHERE organisation_id = org), 'pending', 'and can be undone');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.complete_onboarding(%L)$q$, org), 'finishing needs the plan');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_view);
  PERFORM pg_temp.assert_fails(format($q$SELECT app.onboarding_state(%L)$q$, org), 'a viewer cannot read the wizard');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.set_onboarding_step(%L, 'details', 'done')$q$, org), 'or change it');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.organisation_onboarding), 0::bigint, 'nor read its table');
  PERFORM pg_temp.logout();

  -- The subscription rule. Buying seats and taking a Controller seat are allowed while locked.
  PERFORM pg_temp.login(u_owner);
  PERFORM app.set_subscription_seats(org, 'controller', 2);
  PERFORM pg_temp.assert_eq(app.organisation_access_state(org), 'lapsed', 'seats bought but nobody holds a Controller seat: not valid (and a subscription exists)');
  PERFORM app.set_subscription_seats(org, 'contributor', 1);
  PERFORM app.assign_subscription_package(m_owner, 'contributor');
  PERFORM pg_temp.assert_eq(app.organisation_access_state(org), 'lapsed', 'the owner on another package is not enough');
  PERFORM app.assign_subscription_package(m_owner, 'controller');
  PERFORM pg_temp.assert_eq(app.organisation_access_state(org), 'open', 'valid subscription and the owner holds a Controller seat: open');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'ncr.read'), true, 'open: the quality work is there');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.my_permissions(org)) > 7, true, 'open: the full permission list');
  PERFORM pg_temp.logout();

  -- Status rules: past due inside / outside the grace period, unpaid, cancelled but paid, cancelled and over.
  UPDATE public.organisation_subscriptions SET status = 'past_due', past_due_since = now() - interval '2 days' WHERE organisation_id = org;
  PERFORM pg_temp.assert_eq(app.organisation_access_open(org), true, 'past due inside the grace period: still valid');
  UPDATE public.organisation_subscriptions SET past_due_since = now() - interval '10 days' WHERE organisation_id = org;
  PERFORM pg_temp.assert_eq(app.organisation_access_open(org), false, 'past due beyond the grace period: locked');
  UPDATE public.organisation_subscriptions SET status = 'unpaid' WHERE organisation_id = org;
  PERFORM pg_temp.assert_eq(app.organisation_access_open(org), false, 'unpaid: locked');
  UPDATE public.organisation_subscriptions SET status = 'cancelled', current_period_end = now() + interval '5 days' WHERE organisation_id = org;
  PERFORM pg_temp.assert_eq(app.organisation_access_open(org), true, 'cancelled but paid to the end of the period: valid');
  UPDATE public.organisation_subscriptions SET current_period_end = now() - interval '1 day' WHERE organisation_id = org;
  PERFORM pg_temp.assert_eq(app.organisation_access_open(org), false, 'cancelled and over: locked');
  UPDATE public.organisation_subscriptions SET status = 'trialing', current_period_end = now() + interval '14 days', past_due_since = NULL WHERE organisation_id = org;
  PERFORM pg_temp.assert_eq(app.organisation_access_open(org), true, 'trialing: valid');
  PERFORM pg_temp.login(u_owner);
  PERFORM pg_temp.assert_eq(app.organisation_access_state(org), 'open', 'and the owner sees it open');
  PERFORM pg_temp.logout();
  -- A Controller seat held by someone who is not an Owner does not count.
  UPDATE public.user_subscription_assignments SET status = 'ended', effective_to = now() WHERE organisation_membership_id = m_owner AND status = 'active';
  PERFORM pg_temp.assert_eq(app.organisation_access_open(org), false, 'no seat for the owner: locked');
  -- The seat now goes to a member who is not an Owner: still locked.
  PERFORM pg_temp.login(u_owner);
  PERFORM app.assign_subscription_package(m_view, 'controller');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(app.organisation_access_open(org), false, 'a Controller seat held by a non-owner does not unlock the organisation');
  UPDATE public.user_subscription_assignments SET status = 'ended', effective_to = now() WHERE organisation_membership_id = m_view AND status = 'active';
  PERFORM pg_temp.login(u_owner);
  PERFORM app.assign_subscription_package(m_owner, 'controller');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(app.organisation_access_open(org), true, 'the owner takes a Controller seat again: open');

  -- Finishing the wizard.
  PERFORM pg_temp.login(u_owner);
  st := app.onboarding_state(org);
  PERFORM pg_temp.assert_eq(((st ->> 'canFinish'))::boolean, true, 'with the subscription in place it can be finished');
  PERFORM pg_temp.assert_eq(st ->> 'currentStep', 'security', 'the first step left (plan, details and the site are done)');
  PERFORM app.complete_onboarding(org);
  PERFORM pg_temp.assert_eq((SELECT onboarding_completed_at IS NOT NULL FROM public.organisations WHERE id = org), true, 'finished');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.complete_onboarding(%L)$q$, org), 'it cannot be finished twice');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.outbox_events WHERE organisation_id = org AND event_type = 'onboarding.completed'), 1::bigint, 'the event is recorded once');

  -- Isolation and access to the tables.
  PERFORM pg_temp.login(u_other);
  org2 := app.start_organisation('Other Works', 'Plant B', 'PB', NULL, NULL, NULL);
  PERFORM pg_temp.assert_fails(format($q$SELECT app.onboarding_state(%L)$q$, org), 'isolation: cannot read another organisation''s wizard');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.set_onboarding_step(%L, 'details', 'done')$q$, org), 'isolation: or change it');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.complete_onboarding(%L)$q$, org), 'isolation: or finish it');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.organisation_onboarding WHERE organisation_id = org), 0::bigint, 'isolation: nor read its row');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.organisation_onboarding (organisation_id) VALUES (%L)$q$, org2), 'the table has no direct writes');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.organisations SET billing_required = false WHERE id = %L$q$, org2), 'a user cannot switch off the requirement for their own organisation');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.organisations SET onboarding_completed_at = now() WHERE id = %L$q$, org2), 'nor mark the set-up finished');
  PERFORM pg_temp.assert_ok(format($q$UPDATE public.organisations SET legal_name = 'Other Works Limited', country = 'GB' WHERE id = %L$q$, org2), 'but the owner can set the legal name and country');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.organisations SET country = 'Britain' WHERE id = %L$q$, org2), 'a country must be two letters');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.platform_settings), 0::bigint, 'the operator switches are not readable');
  PERFORM pg_temp.assert_fails($q$UPDATE public.platform_settings SET value = 'false'::jsonb$q$, 'and not changeable');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
