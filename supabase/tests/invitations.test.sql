-- ON4a: invitation details (message, 14-day expiry, send counters), the reserved seat, resend limits, revoke (frees the seat), accept (refuses expired and revoked),
-- what the invitee and the team screens see, permissions and isolation.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('3f000000-0000-0000-0000-000000000c01', 'owner@on4.test'),
  ('3f000000-0000-0000-0000-000000000c02', 'hr@on4.test'),
  ('3f000000-0000-0000-0000-000000000c03', 'newbie@on4.test'),
  ('3f000000-0000-0000-0000-000000000c04', 'stranger@on4.test');

DO $$
DECLARE
  u_owner uuid := '3f000000-0000-0000-0000-000000000c01'; u_hr uuid := '3f000000-0000-0000-0000-000000000c02';
  u_new uuid := '3f000000-0000-0000-0000-000000000c03'; u_other uuid := '3f000000-0000-0000-0000-000000000c04';
  org uuid; org2 uuid; hr_role uuid; viewer_role uuid; dept uuid; site uuid; m_hr uuid; i1 uuid; i2 uuid; i3 uuid; inv record; r jsonb;
BEGIN
  PERFORM pg_temp.login(u_owner);
  org := app.start_organisation('Invite Works', 'Plant I', 'PI', 'Europe/London', 'GB', NULL);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_other);
  org2 := app.start_organisation('Other Invites', 'Plant O', 'PO', 'Europe/London', 'GB', NULL);
  PERFORM pg_temp.logout();
  SELECT id INTO viewer_role FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  SELECT id INTO site FROM public.sites WHERE organisation_id = org LIMIT 1;
  INSERT INTO public.departments (organisation_id, site_id, code, name) VALUES (org, site, 'QA', 'Quality') RETURNING id INTO dept;

  -- A person who may manage invitations but not seats (members.read + members.manage only).
  INSERT INTO public.roles (organisation_id, key, name, is_system) VALUES (org, 'hr_only', 'HR only', false) RETURNING id INTO hr_role;
  INSERT INTO public.role_permissions (role_id, permission_code) VALUES (hr_role, 'members.read'), (hr_role, 'members.manage');
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u_hr, 'active') RETURNING id INTO m_hr;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) VALUES (org, m_hr, hr_role);

  -- Seats: two Contributor seats (the organisation is not gated, so the owner buys them directly).
  PERFORM pg_temp.login(u_owner);
  PERFORM app.set_subscription_seats(org, 'contributor', 2);

  -- Inviting: the row is inserted under RLS, then the details are set.
  INSERT INTO public.organisation_users (organisation_id, invited_email, status, invited_at) VALUES (org, 'newbie@on4.test', 'invited', now()) RETURNING id INTO i1;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) VALUES (org, i1, viewer_role);
  INSERT INTO public.department_members (organisation_id, department_id, membership_id, is_primary) VALUES (org, dept, i1, true);
  PERFORM app.set_invitation_details(i1, '  Welcome to the team  ', 'contributor');
  PERFORM pg_temp.assert_eq((SELECT invite_message FROM public.organisation_users WHERE id = i1), 'Welcome to the team', 'the message is trimmed and saved');
  PERFORM pg_temp.assert_eq((SELECT invite_send_count FROM public.organisation_users WHERE id = i1), 1, 'sent once');
  PERFORM pg_temp.assert_eq((SELECT invite_expires_at > now() + interval '13 days 23 hours' AND invite_expires_at <= now() + interval '14 days' FROM public.organisation_users WHERE id = i1), true, 'it lasts 14 days');
  PERFORM pg_temp.assert_eq((SELECT p.slug FROM public.user_subscription_assignments a JOIN public.subscription_plans p ON p.id = a.subscription_plan_id WHERE a.organisation_membership_id = i1 AND a.status = 'active'), 'contributor', 'a seat is reserved for them');
  PERFORM pg_temp.assert_eq((SELECT available FROM (SELECT i.quantity - (SELECT count(*) FROM public.user_subscription_assignments a WHERE a.subscription_item_id = i.id AND a.status = 'active') AS available FROM public.organisation_subscription_items i JOIN public.subscription_plans p ON p.id = i.subscription_plan_id AND p.slug = 'contributor' WHERE i.organisation_id = org) x), 1::bigint, 'one seat left');

  -- A second invitation takes the last seat; a third finds none and leaves nothing half-done.
  INSERT INTO public.organisation_users (organisation_id, invited_email, status, invited_at) VALUES (org, 'two@on4.test', 'invited', now()) RETURNING id INTO i2;
  PERFORM app.set_invitation_details(i2, NULL, 'contributor');
  PERFORM pg_temp.assert_eq((SELECT invite_message IS NULL FROM public.organisation_users WHERE id = i2), true, 'no message is fine');
  INSERT INTO public.organisation_users (organisation_id, invited_email, status, invited_at) VALUES (org, 'three@on4.test', 'invited', now()) RETURNING id INTO i3;
  PERFORM pg_temp.assert_fails(format($q$SELECT app.set_invitation_details(%L, 'hello', 'contributor')$q$, i3), 'no free seat: refused');
  PERFORM pg_temp.assert_eq((SELECT invite_send_count FROM public.organisation_users WHERE id = i3), 0, 'and the invitation was not marked as sent');
  PERFORM app.set_invitation_details(i3, 'No package for now', NULL);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.user_subscription_assignments WHERE organisation_membership_id = i3), 0::bigint, 'an invitation without a package takes no seat');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.set_invitation_details(%L, %L, NULL)$q$, i3, repeat('x', 501)), 'a message over 500 characters is refused');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.set_invitation_details(%L, 'x', 'gold')$q$, i3), 'an unknown package is refused');
  PERFORM pg_temp.logout();

  -- The team screen sees the detail.
  PERFORM pg_temp.login(u_owner);
  SELECT * INTO inv FROM app.list_members(org) WHERE membership_id = i1;
  PERFORM pg_temp.assert_eq(inv.invite ->> 'packageSlug', 'contributor', 'the member list shows the reserved package');
  PERFORM pg_temp.assert_eq(inv.invite ->> 'message', 'Welcome to the team', 'and the message');
  PERFORM pg_temp.assert_eq((inv.invite ->> 'expired')::boolean, false, 'and that it has not expired');
  PERFORM pg_temp.assert_eq((SELECT invite IS NULL FROM app.list_members(org) WHERE user_id = u_owner), true, 'active members have no invitation detail');
  PERFORM pg_temp.logout();

  -- Permissions: someone who manages invitations but not seats cannot give a package; a viewer cannot do any of it; a stranger cannot touch it.
  PERFORM pg_temp.login(u_hr);
  BEGIN
    PERFORM app.set_invitation_details(i3, 'hi', 'contributor');
    RAISE EXCEPTION 'FAILED: inviting with a package needs subscription.seats (it succeeded)';
  EXCEPTION WHEN SQLSTATE 'QM015' THEN
    PERFORM pg_temp.assert_eq(SQLERRM LIKE '%only people who manage seats can%', true, 'and says why, in words');
  END;
  PERFORM pg_temp.assert_ok(format($q$SELECT app.set_invitation_details(%L, 'Hi from HR', NULL)$q$, i3), 'but they can invite without one');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_other);
  PERFORM pg_temp.assert_fails(format($q$SELECT app.set_invitation_details(%L, 'hi', NULL)$q$, i3), 'isolation: another organisation cannot set details');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.resend_invitation(%L)$q$, i3), 'nor resend');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.revoke_invitation(%L)$q$, i3), 'nor revoke');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_new);
  PERFORM pg_temp.assert_fails(format($q$SELECT app.revoke_invitation(%L)$q$, i1), 'the invitee cannot revoke their own invitation');
  PERFORM pg_temp.logout();

  -- Resend: not within a minute, then it extends the expiry; at most ten sends.
  PERFORM pg_temp.login(u_owner);
  PERFORM pg_temp.assert_fails(format($q$SELECT app.resend_invitation(%L)$q$, i1), 'resending straight away is refused');
  PERFORM pg_temp.logout();
  UPDATE public.organisation_users SET invite_last_sent_at = now() - interval '2 minutes', invite_expires_at = now() + interval '1 day' WHERE id = i1;
  PERFORM pg_temp.login(u_owner);
  r := app.resend_invitation(i1);
  PERFORM pg_temp.assert_eq((r ->> 'sendCount')::int, 2, 'the second send is counted');
  PERFORM pg_temp.assert_eq((SELECT invite_expires_at > now() + interval '13 days' FROM public.organisation_users WHERE id = i1), true, 'and the expiry is extended to 14 days from now');
  PERFORM pg_temp.logout();
  UPDATE public.organisation_users SET invite_last_sent_at = now() - interval '2 minutes', invite_send_count = 10 WHERE id = i1;
  PERFORM pg_temp.login(u_owner);
  PERFORM pg_temp.assert_fails(format($q$SELECT app.resend_invitation(%L)$q$, i1), 'ten sends is the limit');
  PERFORM pg_temp.logout();
  UPDATE public.organisation_users SET invite_send_count = 2 WHERE id = i1;

  -- The invitee sees what they were invited to.
  PERFORM pg_temp.login(u_new);
  SELECT * INTO inv FROM app.my_invitations() WHERE membership_id = i1;
  PERFORM pg_temp.assert_eq((inv.organisation_name, inv.message, inv.package_slug, inv.package_name, inv.expired)::text, '("Invite Works","Welcome to the team",contributor,Contributor,f)', 'organisation, message, package, not expired');
  PERFORM pg_temp.assert_eq(inv.roles, '[{"key": "viewer", "name": "Viewer"}]'::jsonb, 'the role');
  PERFORM pg_temp.assert_eq(inv.departments, '["Quality"]'::jsonb, 'the department');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.my_invitations() WHERE organisation_id = org), 1::bigint, 'only their own invitation');
  PERFORM pg_temp.logout();

  -- Expired: still listed (flagged) but cannot be accepted.
  UPDATE public.organisation_users SET invite_expires_at = now() - interval '1 minute' WHERE id = i1;
  PERFORM pg_temp.login(u_new);
  PERFORM pg_temp.assert_eq((SELECT expired FROM app.my_invitations() WHERE membership_id = i1), true, 'an expired invitation is flagged');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.accept_invitation(%L)$q$, i1), 'an expired invitation cannot be accepted');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_owner);
  PERFORM pg_temp.assert_eq((SELECT (invite ->> 'expired')::boolean FROM app.list_members(org) WHERE membership_id = i1), true, 'and the team screen says so');
  PERFORM pg_temp.logout();
  UPDATE public.organisation_users SET invite_last_sent_at = now() - interval '2 minutes' WHERE id = i1;
  PERFORM pg_temp.login(u_owner);
  PERFORM app.resend_invitation(i1);
  PERFORM pg_temp.logout();

  -- Accepting keeps the seat.
  PERFORM pg_temp.login(u_new);
  PERFORM pg_temp.assert_eq(app.accept_invitation(i1), org, 'a fresh invitation is accepted');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT status FROM public.organisation_users WHERE id = i1), 'active', 'they are a member');
  PERFORM pg_temp.assert_eq((SELECT p.slug FROM public.user_subscription_assignments a JOIN public.subscription_plans p ON p.id = a.subscription_plan_id WHERE a.organisation_membership_id = i1 AND a.status = 'active'), 'contributor', 'with the seat that was reserved');
  PERFORM pg_temp.login(u_owner);
  PERFORM pg_temp.assert_fails(format($q$SELECT app.revoke_invitation(%L)$q$, i1), 'an accepted invitation cannot be revoked (they are a member now)');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.resend_invitation(%L)$q$, i1), 'nor sent again');

  -- Revoking frees the seat, and a revoked invitation cannot be accepted.
  PERFORM app.revoke_invitation(i2);
  PERFORM pg_temp.assert_eq((SELECT status FROM public.organisation_users WHERE id = i2), 'removed', 'a revoked invitation is removed');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.user_subscription_assignments WHERE organisation_membership_id = i2 AND status = 'active'), 0::bigint, 'its seat is freed');
  PERFORM pg_temp.assert_ok(format($q$SELECT app.set_invitation_details(%L, 'Another go', 'contributor')$q$, i3), 'so the seat can be used by another invitation');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.resend_invitation(%L)$q$, i2), 'a revoked invitation cannot be sent again');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
