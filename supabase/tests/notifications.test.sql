-- Notifications: written from audited changes, visible by permission (and package), chosen per user.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('36000000-0000-0000-0000-000000000101', 'owner@notif.test'),
  ('36000000-0000-0000-0000-000000000102', 'viewer@notif.test'),
  ('36000000-0000-0000-0000-000000000103', 'insp@notif.test'),
  ('36000000-0000-0000-0000-000000000104', 'outsider@notif.test');

CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);
GRANT SELECT ON ids TO authenticated;

DO $$
DECLARE org uuid; m_viewer uuid; m_insp uuid;
BEGIN
  PERFORM pg_temp.login('36000000-0000-0000-0000-000000000101');
  org := app.create_organisation('Notify Works', 'Plant A', 'PA', NULL);
  PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '36000000-0000-0000-0000-000000000102', 'active') RETURNING id INTO m_viewer;
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '36000000-0000-0000-0000-000000000103', 'active') RETURNING id INTO m_insp;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, m_viewer, id FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, m_insp, id FROM public.roles WHERE organisation_id = org AND key = 'inspector';
  INSERT INTO ids VALUES ('org', org);
END $$;

-- The owner creates a part and a customer: notifications are written from the audit trail.
DO $$
DECLARE org uuid := (SELECT v FROM ids WHERE k = 'org');
BEGIN
  PERFORM pg_temp.login('36000000-0000-0000-0000-000000000101');
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'NP-1', 'Notify part');
  INSERT INTO public.customers (organisation_id, code, name) VALUES (org, 'NC1', 'Notify customer');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.notifications WHERE organisation_id = org AND entity_type = 'parts'), 1::bigint, 'part creation notified');
  PERFORM pg_temp.assert_eq((SELECT body FROM public.notifications WHERE entity_type = 'parts'), 'NP-1 — Notify part', 'message uses the label fields');
END $$;

-- Others see it (viewer has master_data.read); the actor does not get their own action.
DO $$
DECLARE org uuid := (SELECT v FROM ids WHERE k = 'org');
BEGIN
  PERFORM pg_temp.login('36000000-0000-0000-0000-000000000102');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.visible_notifications(org) WHERE entity_type = 'parts'), 1::bigint, 'viewer sees part created');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.notifications WHERE entity_type IN ('parts', 'customers')), 2::bigint, 'RLS lets the viewer read what their permission allows');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login('36000000-0000-0000-0000-000000000101');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.visible_notifications(org) WHERE entity_type IN ('parts', 'customers')), 0::bigint, 'actor is not notified of their own actions');
  PERFORM pg_temp.logout();
END $$;

-- A user without the read permission sees nothing; outsiders see nothing.
DO $$
DECLARE org uuid := (SELECT v FROM ids WHERE k = 'org');
BEGIN
  PERFORM pg_temp.login('36000000-0000-0000-0000-000000000104');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.notifications), 0::bigint, 'outsider reads no notifications');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.visible_notifications(org)), 0::bigint, 'outsider has no visible notifications');
  PERFORM pg_temp.logout();
END $$;

-- Preferences: toggling off hides the event; resetting brings the default back. Only offered events can be set.
DO $$
DECLARE org uuid := (SELECT v FROM ids WHERE k = 'org');
BEGIN
  PERFORM pg_temp.login('36000000-0000-0000-0000-000000000102');
  PERFORM app.set_notification_preference(org, 'parts.created', false);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.visible_notifications(org) WHERE entity_type = 'parts'), 0::bigint, 'opted out');
  PERFORM pg_temp.assert_eq((SELECT enabled FROM app.list_notification_preferences(org) WHERE key = 'parts.created'), false, 'setting shows off');
  PERFORM pg_temp.assert_eq((SELECT overridden FROM app.list_notification_preferences(org) WHERE key = 'parts.created'), true, 'setting marked overridden');
  PERFORM app.set_notification_preference(org, 'parts.created', NULL);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.visible_notifications(org) WHERE entity_type = 'parts'), 1::bigint, 'default restored');

  -- Defaults follow access: the viewer cannot see invoice events, so is not offered them.
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.list_notification_preferences(org) WHERE key LIKE 'billing_invoices.%'), 0::bigint, 'no invoice events offered to a viewer');
  BEGIN
    PERFORM app.set_notification_preference(org, 'billing_invoices.created', true);
    RAISE EXCEPTION 'should have been refused';
  EXCEPTION WHEN SQLSTATE 'QM010' THEN NULL;
  END;

  -- Marking as read.
  PERFORM app.mark_notifications_read(org, NULL);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.visible_notifications(org) WHERE read_at IS NULL), 0::bigint, 'all marked read');
  PERFORM pg_temp.logout();
END $$;

-- Role-based default: updating a part is off for everyone by default; NC updates are on only for ncr.update holders.
DO $$
DECLARE org uuid := (SELECT v FROM ids WHERE k = 'org');
BEGIN
  PERFORM pg_temp.login('36000000-0000-0000-0000-000000000102');
  PERFORM pg_temp.assert_eq((SELECT default_enabled FROM app.list_notification_preferences(org) WHERE key = 'nonconformances.updated'), false, 'viewer: NC updates off by default');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login('36000000-0000-0000-0000-000000000101');
  PERFORM pg_temp.assert_eq((SELECT default_enabled FROM app.list_notification_preferences(org) WHERE key = 'nonconformances.updated'), true, 'owner: NC updates on by default');
  PERFORM pg_temp.logout();
END $$;

-- Package: with enforcement on and no seat, the user's permissions (and so notifications) disappear.
DO $$
DECLARE org uuid := (SELECT v FROM ids WHERE k = 'org');
BEGIN
  UPDATE public.organisation_settings SET entitlements_enforced = true WHERE organisation_id = org;
  PERFORM pg_temp.login('36000000-0000-0000-0000-000000000102');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.visible_notifications(org) WHERE entity_type = 'parts'), 1::bigint, 'master data is not package-gated');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
