-- Subscription entitlements: independent from RBAC, seats, enforcement switch, grace period, history.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('35000000-0000-0000-0000-000000000101', 'owner@sub.test'),
  ('35000000-0000-0000-0000-000000000102', 'qm@sub.test'),
  ('35000000-0000-0000-0000-000000000103', 'inspector@sub.test'),
  ('35000000-0000-0000-0000-000000000104', 'extra@sub.test');

CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);
GRANT SELECT ON ids TO authenticated;

DO $$
DECLARE org uuid; m_owner uuid; m_qm uuid; m_insp uuid; m_extra uuid;
BEGIN
  PERFORM pg_temp.login('35000000-0000-0000-0000-000000000101');
  org := app.create_organisation('Subscription Works', 'Plant A', 'PA', NULL);
  PERFORM pg_temp.logout();
  m_owner := (SELECT id FROM public.organisation_users WHERE organisation_id = org AND user_id = '35000000-0000-0000-0000-000000000101');
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '35000000-0000-0000-0000-000000000102', 'active') RETURNING id INTO m_qm;
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '35000000-0000-0000-0000-000000000103', 'active') RETURNING id INTO m_insp;
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '35000000-0000-0000-0000-000000000104', 'active') RETURNING id INTO m_extra;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, m_qm, id FROM public.roles WHERE organisation_id = org AND key = 'quality_manager';
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, m_insp, id FROM public.roles WHERE organisation_id = org AND key = 'inspector';
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, m_extra, id FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  INSERT INTO ids VALUES ('org', org), ('owner', m_owner), ('qm', m_qm), ('insp', m_insp), ('extra', m_extra);
END $$;

-- Seed catalogue: packages, prices in pence (annual = ten months), data-driven modules.
DO $$
BEGIN
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.subscription_plans), 3::bigint, 'three packages');
  PERFORM pg_temp.assert_eq((SELECT unit_amount FROM public.subscription_prices p JOIN public.subscription_plans s ON s.id = p.subscription_plan_id
                              WHERE s.slug = 'controller' AND billing_interval = 'month'), 2500, 'controller monthly pence');
  PERFORM pg_temp.assert_eq((SELECT unit_amount FROM public.subscription_prices p JOIN public.subscription_plans s ON s.id = p.subscription_plan_id
                              WHERE s.slug = 'controller' AND billing_interval = 'year'), 25000, 'controller annual = ten months');
END $$;

-- Not enforced yet: existing behaviour is unchanged for everyone.
DO $$
DECLARE org uuid := (SELECT v FROM ids WHERE k = 'org');
BEGIN
  PERFORM pg_temp.login('35000000-0000-0000-0000-000000000102');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'inspection.record'), true, 'not enforced: allowed without a subscription');
  PERFORM pg_temp.assert_eq((SELECT (app.my_subscription_access(org))->>'enforced'), 'false', 'access shows not enforced');
  PERFORM pg_temp.logout();
END $$;

-- Billing admin buys seats; others cannot.
DO $$
DECLARE org uuid := (SELECT v FROM ids WHERE k = 'org');
BEGIN
  PERFORM pg_temp.login('35000000-0000-0000-0000-000000000103');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.set_subscription_seats(%L, 'controller', 5)$q$, org), 'inspector cannot buy seats');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login('35000000-0000-0000-0000-000000000101');
  PERFORM app.set_subscription_seats(org, 'observer', 1);
  PERFORM app.set_subscription_seats(org, 'contributor', 1);
  PERFORM app.set_subscription_seats(org, 'controller', 2);
  PERFORM pg_temp.assert_eq((SELECT sum(quantity * unit_amount_snapshot)::bigint FROM public.organisation_subscription_items), 6500::bigint, 'monthly total in pence');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.set_subscription_seats(%L, 'controller', -1)$q$, org), 'negative seats refused');
  PERFORM pg_temp.logout();
  UPDATE public.organisation_settings SET entitlements_enforced = true WHERE organisation_id = org;
END $$;

-- Enforced: no package = no restricted access, but billing stays reachable (separate permissions).
DO $$
DECLARE org uuid := (SELECT v FROM ids WHERE k = 'org'); m_owner uuid := (SELECT v FROM ids WHERE k = 'owner');
BEGIN
  PERFORM pg_temp.login('35000000-0000-0000-0000-000000000101');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'ncr.read'), false, 'owner without a seat: restricted module blocked');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'subscription.seats'), true, 'billing permission is not subscription-restricted');
  PERFORM pg_temp.assert_eq((SELECT reason FROM app.check_entitlement(org, 'nonconformance', 'view_ncrs')), 'no_seat_assigned', 'reason: no seat');
  PERFORM app.assign_subscription_package(m_owner, 'controller');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'ncr.read'), true, 'controller package allows module');
  PERFORM pg_temp.logout();
END $$;

-- Subscription AND role: neither alone is enough.
DO $$
DECLARE org uuid := (SELECT v FROM ids WHERE k = 'org');
BEGIN
  PERFORM pg_temp.login('35000000-0000-0000-0000-000000000101');
  PERFORM app.assign_subscription_package((SELECT v FROM ids WHERE k = 'qm'), 'observer');
  PERFORM app.assign_subscription_package((SELECT v FROM ids WHERE k = 'insp'), 'controller');
  PERFORM pg_temp.logout();

  -- Quality manager role may record inspections, but the Observer package is read-only.
  PERFORM pg_temp.login('35000000-0000-0000-0000-000000000102');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'inspection.read'), true, 'observer can view');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'inspection.record'), false, 'observer cannot record despite the role');
  PERFORM pg_temp.assert_eq((SELECT required_plan FROM app.check_entitlement(org, 'inspections', 'record_inspections')), 'Contributor', 'required package reported');
  PERFORM pg_temp.assert_eq((SELECT (app.my_subscription_access(org))->'modules'->>'inspections'), 'view', 'observer level for client');
  PERFORM pg_temp.logout();

  -- Inspector role has no inspection.correct; the Controller package does not supply it.
  PERFORM pg_temp.login('35000000-0000-0000-0000-000000000103');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'inspection.record'), true, 'controller + role: allowed');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'inspection.correct'), false, 'controller does not grant approval-type rights');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'subscription.seats'), false, 'controller is not a billing admin');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.assign_subscription_package(%L, 'controller')$q$, (SELECT v FROM ids WHERE k = 'extra')), 'non-billing user cannot assign');
  PERFORM pg_temp.logout();
END $$;

-- Seats: cannot exceed purchased quantity; changing package frees the old seat; history is kept.
DO $$
DECLARE org uuid := (SELECT v FROM ids WHERE k = 'org'); extra uuid := (SELECT v FROM ids WHERE k = 'extra'); qm uuid := (SELECT v FROM ids WHERE k = 'qm');
BEGIN
  PERFORM pg_temp.login('35000000-0000-0000-0000-000000000101');
  PERFORM app.assign_subscription_package(extra, 'contributor');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.assign_subscription_package(%L, 'contributor')$q$, qm), 'no free contributor seat');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.set_subscription_seats(%L, 'contributor', 0)$q$, org), 'cannot reduce below assigned');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.assign_subscription_package(%L, 'observer')$q$, extra), 'observer seat is held by another member');
  PERFORM pg_temp.assert_eq((SELECT p.slug FROM public.user_subscription_assignments a JOIN public.subscription_plans p ON p.id = a.subscription_plan_id
                              WHERE a.organisation_membership_id = extra AND a.status = 'active'), 'contributor', 'failed change keeps the old package');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.assign_subscription_package(%L, 'controller')$q$, extra), 'both controller seats taken');
  PERFORM app.set_subscription_seats(org, 'controller', 3);
  PERFORM app.assign_subscription_package(extra, 'controller');  -- upgrade into the new seat
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.user_subscription_assignments WHERE organisation_membership_id = extra), 2::bigint, 'assignment history kept');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.user_subscription_assignments WHERE organisation_membership_id = extra AND status = 'active'), 1::bigint, 'one active package per member');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.user_subscription_assignments (organisation_id, organisation_membership_id, subscription_plan_id, subscription_item_id)
    SELECT %L, %L, subscription_plan_id, id FROM public.organisation_subscription_items LIMIT 1$q$, org, extra), 'tenants cannot write assignments directly');

  -- Removing the package keeps the membership and roles.
  PERFORM app.remove_subscription_assignment(extra);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.user_role_assignments WHERE membership_id = extra), 1::bigint, 'role kept after removal');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.organisation_users WHERE id = extra), 'active', 'membership kept after removal');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login('35000000-0000-0000-0000-000000000104');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'ncr.read'), false, 'removed package: module blocked');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.subscription_audit_logs WHERE event_type IN ('package_upgraded', 'assignment_removed', 'seats_added')) >= 5, true, 'subscription events logged');
END $$;

-- Payment failure: access continues during the grace period, then stops; data is untouched.
DO $$
DECLARE org uuid := (SELECT v FROM ids WHERE k = 'org');
BEGIN
  UPDATE public.organisation_subscriptions SET status = 'past_due', past_due_since = now() - interval '3 days' WHERE organisation_id = org;
  PERFORM pg_temp.login('35000000-0000-0000-0000-000000000103');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'inspection.record'), true, 'past_due inside grace period');
  PERFORM pg_temp.logout();
  UPDATE public.organisation_subscriptions SET past_due_since = now() - interval '10 days' WHERE organisation_id = org;
  PERFORM pg_temp.login('35000000-0000-0000-0000-000000000103');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'inspection.record'), false, 'past_due after grace period');
  PERFORM pg_temp.assert_eq((SELECT reason FROM app.check_entitlement(org, 'inspections', 'view_inspections')), 'payment_overdue', 'reason: payment overdue');
  PERFORM pg_temp.logout();
  UPDATE public.organisation_subscriptions SET status = 'active', past_due_since = NULL WHERE organisation_id = org;
  PERFORM pg_temp.login('35000000-0000-0000-0000-000000000103');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'inspection.record'), true, 'access restored after payment');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
