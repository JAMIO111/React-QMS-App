-- Member directory, invitations and acceptance, last-owner error code (Phase 1 slice 1.5).
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('40000000-0000-0000-0000-0000000000a1', 'owner@alpha.test'),
  ('40000000-0000-0000-0000-0000000000a2', 'Invitee@Example.test'),
  ('40000000-0000-0000-0000-0000000000a3', 'someone.else@example.test');

DO $$
DECLARE
  org uuid;
  invite uuid;
  viewer_role uuid;
BEGIN
  PERFORM pg_temp.login('40000000-0000-0000-0000-0000000000a1');
  org := app.create_organisation('Alpha Members Ltd');
  SELECT id INTO viewer_role FROM public.roles WHERE organisation_id = org AND key = 'viewer';

  -- Owner invites by (lower-cased) email with a role; invited_by defaults to the inviter.
  INSERT INTO public.organisation_users (organisation_id, invited_email, status, invited_at)
  VALUES (org, 'invitee@example.test', 'invited', now()) RETURNING id INTO invite;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) VALUES (org, invite, viewer_role);
  PERFORM pg_temp.assert_eq((SELECT invited_by FROM public.organisation_users WHERE id = invite), '40000000-0000-0000-0000-0000000000a1'::uuid, 'invited_by default');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.organisation_users (organisation_id, invited_email, status) VALUES (%L, 'Mixed@Case.test', 'invited')$q$, org), 'emails stored lower-case');

  -- An invitation can be revoked (removed without ever having a user); active still needs a user.
  INSERT INTO public.organisation_users (organisation_id, invited_email, status) VALUES (org, 'revoke@example.test', 'invited');
  PERFORM pg_temp.assert_ok($q$UPDATE public.organisation_users SET status = 'removed' WHERE invited_email = 'revoke@example.test'$q$, 'revoke invitation');
  PERFORM pg_temp.assert_fails($q$UPDATE public.organisation_users SET status = 'active' WHERE invited_email = 'revoke@example.test'$q$, 'active without a user');

  -- Directory shows the owner (with login email) and the pending invitation.
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.list_members(org) WHERE status <> 'removed'), 2::bigint, 'directory size');
  PERFORM pg_temp.assert_eq((SELECT email FROM app.list_members(org) WHERE status = 'active'), 'owner@alpha.test', 'owner email');
  PERFORM pg_temp.assert_eq((SELECT roles -> 0 ->> 'roleKey' FROM app.list_members(org) WHERE status = 'invited'), 'viewer', 'invite role');
  PERFORM pg_temp.logout();

  -- Someone else cannot see or accept the invitation, nor read the directory.
  PERFORM pg_temp.login('40000000-0000-0000-0000-0000000000a3');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.my_invitations()), 0::bigint, 'not addressed to them');
  PERFORM pg_temp.assert_fails(format('SELECT app.accept_invitation(%L)', invite), 'accept someone else''s invitation');
  PERFORM pg_temp.assert_fails(format('SELECT * FROM app.list_members(%L)', org), 'directory without members.read');
  PERFORM pg_temp.logout();

  -- The invitee (account email in different case) sees and accepts it, and becomes an active viewer.
  PERFORM pg_temp.login('40000000-0000-0000-0000-0000000000a2');
  PERFORM pg_temp.assert_eq((SELECT organisation_name FROM app.my_invitations()), 'Alpha Members Ltd', 'invitation visible');
  PERFORM pg_temp.assert_eq((SELECT invited_by_name FROM app.my_invitations()), NULL::text, 'inviter has no name yet');
  PERFORM pg_temp.assert_eq(app.accept_invitation(invite), org, 'accepted');
  PERFORM pg_temp.assert_eq(app.is_member(org), true, 'now a member');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'ncr.read'), true, 'viewer permissions apply');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'ncr.create'), false, 'and no more');
  PERFORM pg_temp.assert_fails(format('SELECT app.accept_invitation(%L)', invite), 'cannot accept twice');
  PERFORM pg_temp.logout();
END $$;

-- Removing the last owner raises QM001.
DO $$
DECLARE state text;
BEGIN
  SET CONSTRAINTS ALL IMMEDIATE;
  BEGIN
    UPDATE public.organisation_users SET status = 'suspended'
    WHERE user_id = '40000000-0000-0000-0000-0000000000a1';
  EXCEPTION WHEN OTHERS THEN
    state := SQLSTATE;
  END;
  PERFORM pg_temp.assert_eq(state, 'QM001', 'last-owner SQLSTATE');
END $$;

ROLLBACK;
