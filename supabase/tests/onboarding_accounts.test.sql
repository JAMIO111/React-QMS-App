-- ON1: the sign-up funnel (written by triggers, invited people kept apart), terms at sign-up, and the operator's access (allow-list AND an MFA session).
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

-- A session with the MFA assurance level, as Supabase issues after the second factor.
CREATE FUNCTION pg_temp.login_aal(p_user uuid, p_aal text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
  PERFORM set_config('role', 'authenticated', true);
END $$;

DO $$
DECLARE
  u_self uuid := '3f000000-0000-0000-0000-000000000901';
  u_invited uuid := '3f000000-0000-0000-0000-000000000902';
  u_admin uuid := '3f000000-0000-0000-0000-000000000903';
  u_other uuid := '3f000000-0000-0000-0000-000000000904';
  org uuid; f jsonb; b_signed int; b_verified int; b_started int;
BEGIN
  -- Whatever already exists is the baseline; the checks are about what this test adds.
  SELECT count(*) INTO b_signed FROM public.signup_events WHERE event = 'signed_up' AND kind = 'self' AND occurred_at >= now() - interval '30 days';
  SELECT count(*) INTO b_verified FROM public.signup_events s WHERE event = 'signed_up' AND kind = 'self' AND occurred_at >= now() - interval '30 days' AND EXISTS (SELECT 1 FROM public.signup_events v WHERE v.user_id = s.user_id AND v.event = 'verified');
  SELECT count(*) INTO b_started FROM public.signup_events s WHERE event = 'signed_up' AND kind = 'self' AND occurred_at >= now() - interval '30 days' AND EXISTS (SELECT 1 FROM public.signup_events o WHERE o.user_id = s.user_id AND o.event = 'org_started');
  -- A person signs themselves up: terms and names are kept on the profile; the funnel records it.
  INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES (u_self, 'owner@onb.test', '{"first_name": "  Ada ", "surname": "Owner", "terms_version": "2026-11"}');
  PERFORM pg_temp.assert_eq((SELECT (first_name, surname, terms_version, terms_accepted_at IS NOT NULL)::text FROM public.profiles WHERE id = u_self), '(Ada,Owner,2026-11,t)', 'profile: trimmed names and the accepted terms');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.signup_events WHERE user_id = u_self AND event = 'signed_up' AND kind = 'self'), 1::bigint, 'signed_up recorded');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.signup_events WHERE user_id = u_self AND event = 'verified'), 0::bigint, 'not verified yet');

  -- Verifying records it once, whatever happens to the row afterwards.
  UPDATE auth.users SET email_confirmed_at = now() WHERE id = u_self;
  UPDATE auth.users SET email_confirmed_at = now() + interval '1 minute' WHERE id = u_self;
  UPDATE auth.users SET email = 'changed@onb.test' WHERE id = u_self;
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.signup_events WHERE user_id = u_self AND event = 'verified'), 1::bigint, 'verified recorded once');

  -- An invited person is kept out of the owner funnel.
  INSERT INTO auth.users (id, email, raw_user_meta_data, invited_at) VALUES (u_invited, 'invitee@onb.test', '{"invited_to": "Somewhere Ltd"}', now());
  PERFORM pg_temp.assert_eq((SELECT kind FROM public.signup_events WHERE user_id = u_invited AND event = 'signed_up'), 'invited', 'invited accounts are marked as such');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.profiles WHERE id = u_invited AND terms_version IS NULL AND terms_accepted_at IS NULL), 1::bigint, 'no terms recorded when none were sent');

  -- Starting an organisation is recorded for the person who did it.
  PERFORM pg_temp.login(u_self);
  org := app.create_organisation('Onboarding Works', 'Plant A', 'PA', NULL);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT user_id FROM public.signup_events WHERE event = 'org_started' AND organisation_id = org), u_self, 'org_started recorded for the creator');

  -- Nobody can read or write the platform tables or call the operator functions, signed in or not.
  INSERT INTO auth.users (id, email) VALUES (u_other, 'other@onb.test'), (u_admin, 'admin@onb.test');
  PERFORM pg_temp.login_aal(u_other, 'aal2');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.signup_events), 0::bigint, 'a normal user sees no funnel rows');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.platform_admins), 0::bigint, 'nor the allow-list');
  PERFORM pg_temp.assert_eq(app.is_platform_admin(), false, 'not an operator');
  PERFORM pg_temp.assert_eq(app.platform_account_status(), 'none', 'status none');
  PERFORM pg_temp.assert_fails($q$SELECT app.platform_funnel(30)$q$, 'the funnel is for operators');
  PERFORM pg_temp.assert_fails($q$SELECT * FROM app.platform_recent_signups(10)$q$, 'so are recent sign-ups');
  PERFORM pg_temp.assert_fails($q$INSERT INTO public.platform_admins (user_id) VALUES ('3f000000-0000-0000-0000-000000000904')$q$, 'no one can make themselves an operator');
  PERFORM pg_temp.assert_fails($q$INSERT INTO public.signup_events (user_id, event) VALUES ('3f000000-0000-0000-0000-000000000904', 'verified')$q$, 'nor write funnel events');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login_anon();
  PERFORM pg_temp.assert_fails($q$SELECT app.platform_funnel(30)$q$, 'anon cannot call it');
  PERFORM pg_temp.logout();

  -- An operator needs the allow-list AND an MFA session.
  INSERT INTO public.platform_admins (user_id, note) VALUES (u_admin, 'test operator');
  PERFORM pg_temp.login_aal(u_admin, 'aal1');
  PERFORM pg_temp.assert_eq(app.platform_account_status(), 'needs_mfa', 'on the list, session without MFA');
  PERFORM pg_temp.assert_eq(app.is_platform_admin(), false, 'no access without MFA');
  PERFORM pg_temp.assert_fails($q$SELECT app.platform_funnel(30)$q$, 'the funnel needs MFA');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.signup_events), 0::bigint, 'and so do the tables');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login_aal(u_admin, 'aal2');
  PERFORM pg_temp.assert_eq(app.platform_account_status(), 'ok', 'operator with MFA');
  f := app.platform_funnel(30);
  PERFORM pg_temp.assert_eq((f ->> 'signedUp')::int, b_signed + 3, 'funnel: the three self sign-ups (the invited person is not counted)');
  PERFORM pg_temp.assert_eq((f ->> 'verified')::int, b_verified + 1, 'funnel: one verified');
  PERFORM pg_temp.assert_eq((f ->> 'orgStarted')::int, b_started + 1, 'funnel: one started an organisation');
  PERFORM pg_temp.assert_eq((f ->> 'days')::int, 30, 'funnel: the period');
  PERFORM pg_temp.assert_fails($q$SELECT app.platform_funnel(0)$q$, 'a period of 0 days is refused');
  PERFORM pg_temp.assert_fails($q$SELECT app.platform_funnel(1000)$q$, 'so is a very long one');
  PERFORM pg_temp.assert_eq((SELECT (email, first_name, organisation_name, verified_at IS NOT NULL)::text FROM app.platform_recent_signups(10) WHERE user_id = u_self), '(changed@onb.test,Ada,"Onboarding Works",t)', 'recent sign-ups: the person, their organisation and whether they verified');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.platform_recent_signups(10) WHERE user_id = u_invited), 0::bigint, 'invited people are not listed as sign-ups');
  PERFORM pg_temp.assert_fails($q$SELECT * FROM app.platform_recent_signups(1000)$q$, 'the list size is limited');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.signup_events) > 0, true, 'the operator can read the funnel rows');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.platform_admins), 1::bigint, 'and the allow-list');
  PERFORM pg_temp.assert_fails($q$DELETE FROM public.signup_events$q$, 'but cannot change them');
  PERFORM pg_temp.logout();

  -- The operator window: events older than the period are not counted.
  UPDATE public.signup_events SET occurred_at = now() - interval '40 days' WHERE user_id = u_self AND event = 'signed_up';
  PERFORM pg_temp.login_aal(u_admin, 'aal2');
  PERFORM pg_temp.assert_eq((app.platform_funnel(30) ->> 'signedUp')::int, b_signed + 2, 'a sign-up outside the period is not in the funnel');
  PERFORM pg_temp.assert_eq((app.platform_funnel(60) ->> 'signedUp')::int, b_signed + 3, 'but is in a longer one');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
