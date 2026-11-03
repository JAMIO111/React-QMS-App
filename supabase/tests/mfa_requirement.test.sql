-- organisation_settings.require_mfa: members whose session has not passed MFA (aal1) lose access to
-- that organisation everywhere RLS applies; other organisations are unaffected; the setting
-- cannot be switched on from an aal1 session.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

CREATE FUNCTION pg_temp.login_aal(p_user uuid, p_aal text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
  PERFORM set_config('role', 'authenticated', true);
END $$;

INSERT INTO auth.users (id, email) VALUES
  ('20000000-0000-0000-0000-0000000000e1', 'owner@mfa.test'),
  ('20000000-0000-0000-0000-0000000000e2', 'outsider@mfa.test');

DO $$
DECLARE
  strict_org uuid;
  relaxed_org uuid;
  failed boolean;
BEGIN
  PERFORM pg_temp.login_aal('20000000-0000-0000-0000-0000000000e1', 'aal1');
  strict_org := app.create_organisation('Strict Ltd', 'Main site', 'MAIN', NULL);
  relaxed_org := app.create_organisation('Relaxed Ltd', 'Main site', 'MAIN', NULL);
  PERFORM pg_temp.assert_eq(app.is_member(strict_org), true, 'member before the requirement');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.mfa_blocked_organisations()), 0::bigint, 'nothing blocked yet');

  -- Cannot require MFA from a password-only session (would lock the owner out).
  failed := false;
  BEGIN
    UPDATE public.organisation_settings SET require_mfa = true WHERE organisation_id = strict_org;
  EXCEPTION WHEN SQLSTATE 'QM002' THEN failed := true;
  END;
  PERFORM pg_temp.assert_eq(failed, true, 'aal1 cannot switch the requirement on');

  -- After passing MFA, the owner can.
  PERFORM pg_temp.login_aal('20000000-0000-0000-0000-0000000000e1', 'aal2');
  UPDATE public.organisation_settings SET require_mfa = true WHERE organisation_id = strict_org;
  PERFORM pg_temp.assert_eq((SELECT require_mfa FROM public.organisation_settings WHERE organisation_id = strict_org), true, 'aal2 switches it on');
  PERFORM pg_temp.assert_eq(app.is_member(strict_org), true, 'aal2 session keeps access');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.sites WHERE organisation_id = strict_org), 1::bigint, 'aal2 sees the sites');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.mfa_blocked_organisations()), 0::bigint, 'aal2 is not blocked');

  -- A password-only session loses the strict organisation everywhere…
  PERFORM pg_temp.login_aal('20000000-0000-0000-0000-0000000000e1', 'aal1');
  PERFORM pg_temp.assert_eq(app.is_member(strict_org), false, 'aal1 is not treated as a member');
  PERFORM pg_temp.assert_eq(app.has_permission(strict_org, 'organisation.manage'), false, 'aal1 holds no permissions');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.my_permissions(strict_org)), 0::bigint, 'aal1 permission list empty');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.organisations WHERE id = strict_org), 0::bigint, 'organisation hidden');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.organisation_settings WHERE organisation_id = strict_org), 0::bigint, 'settings hidden');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.sites WHERE organisation_id = strict_org), 0::bigint, 'sites hidden');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.roles WHERE organisation_id = strict_org), 0::bigint, 'roles hidden');
  PERFORM pg_temp.assert_eq(strict_org IN (SELECT app.member_organisation_ids()), false, 'not in member organisation ids');
  UPDATE public.organisation_settings SET require_mfa = false WHERE organisation_id = strict_org;
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT require_mfa FROM public.organisation_settings WHERE organisation_id = strict_org), true, 'aal1 cannot switch it off either');
  PERFORM pg_temp.login_aal('20000000-0000-0000-0000-0000000000e1', 'aal1');

  -- …but keeps its own membership row, learns why, and other organisations are unaffected.
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.organisation_users WHERE organisation_id = strict_org AND user_id = auth.uid()), 1::bigint, 'own membership visible');
  PERFORM pg_temp.assert_eq((SELECT name FROM app.mfa_blocked_organisations()), 'Strict Ltd', 'blocked organisation reported');
  PERFORM pg_temp.assert_eq(app.is_member(relaxed_org), true, 'other organisation unaffected');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.sites WHERE organisation_id = relaxed_org), 1::bigint, 'other organisation data visible');

  -- No claims at all counts as aal1; outsiders are never reported as blocked.
  PERFORM pg_temp.login('20000000-0000-0000-0000-0000000000e1');
  PERFORM pg_temp.assert_eq(app.is_member(strict_org), false, 'missing aal claim treated as aal1');
  PERFORM pg_temp.login_aal('20000000-0000-0000-0000-0000000000e2', 'aal1');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.mfa_blocked_organisations()), 0::bigint, 'outsider not reported');

  -- The change is audited.
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(
    (SELECT count(*) > 0 FROM audit.events WHERE organisation_id = strict_org AND entity_type = 'organisation_settings'
       AND changed_fields @> ARRAY['require_mfa']),
    true, 'requirement change audited');
END $$;

ROLLBACK;
