-- Member onboarding (docs/seats-and-member-onboarding-plan.md SM6, SM7): someone joining an organisation gets a welcome to go through (accepting an
-- invitation, or added active to an organisation that has members), the founder never does; the person moves it on themselves, even while
-- waiting for a seat; done means done.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('5f600000-0000-0000-0000-000000000101', 'founder@welcome.test'),
  ('5f600000-0000-0000-0000-000000000102', 'invited@welcome.test'),
  ('5f600000-0000-0000-0000-000000000103', 'joiner@welcome.test');

CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);
GRANT SELECT ON ids TO authenticated;

DO $$
DECLARE org uuid; inv uuid;
BEGIN
  PERFORM pg_temp.login('5f600000-0000-0000-0000-000000000101');
  org := app.create_organisation('Welcome Works', 'Plant A', 'PA', NULL);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.my_pending_welcomes()), 0::bigint, 'the founder sets up the organisation, not a welcome');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.member_onboarding WHERE organisation_id = org), 0::bigint, 'no welcome for the founder');

  INSERT INTO public.organisation_users (organisation_id, invited_email, status, invited_at) VALUES (org, 'invited@welcome.test', 'invited', now()) RETURNING id INTO inv;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, inv, id FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.member_onboarding WHERE organisation_id = org), 0::bigint, 'an invitation is not a welcome yet');
  INSERT INTO ids VALUES ('org', org), ('inv', inv);
END $$;

-- accepting the invitation starts the welcome
DO $$
DECLARE org uuid := (SELECT v FROM ids WHERE k = 'org'); r record;
BEGIN
  PERFORM pg_temp.login('5f600000-0000-0000-0000-000000000102');
  PERFORM app.accept_invitation((SELECT v FROM ids WHERE k = 'inv'));
  SELECT * INTO r FROM app.my_pending_welcomes();
  PERFORM pg_temp.assert_eq(r.organisation_id, org, 'accepting starts a welcome');
  PERFORM pg_temp.assert_eq(r.about_done, false, 'nothing done yet');
  PERFORM pg_temp.assert_eq(r.waiting_for_seat, false, 'not enforced: no seat needed');
  PERFORM app.set_member_onboarding_step(org, 'about');
  PERFORM app.set_member_onboarding_step(org, 'about');
  PERFORM pg_temp.assert_eq((SELECT about_done FROM app.my_pending_welcomes()), true, 'about you done (twice is harmless)');
  PERFORM app.set_member_onboarding_step(org, 'notifications');
  PERFORM app.set_member_onboarding_step(org, 'done');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.my_pending_welcomes()), 0::bigint, 'done means done');
  PERFORM pg_temp.assert_fails(format($f$SELECT app.set_member_onboarding_step(%L, 'party')$f$, org), 'only the known steps');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login('5f600000-0000-0000-0000-000000000103');
  PERFORM pg_temp.assert_fails(format($f$SELECT app.set_member_onboarding_step(%L, 'done')$f$, org), 'not someone else''s organisation');
  PERFORM pg_temp.logout();
END $$;

-- joining with a company account (added active to an organisation with members), waiting for a seat where packages are enforced
DO $$
DECLARE org uuid := (SELECT v FROM ids WHERE k = 'org'); m uuid;
BEGIN
  UPDATE public.organisation_settings SET entitlements_enforced = true WHERE organisation_id = org;
  INSERT INTO public.organisation_users (organisation_id, user_id, status, joined_at) VALUES (org, '5f600000-0000-0000-0000-000000000103', 'active', now()) RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'inspector';
  PERFORM pg_temp.login('5f600000-0000-0000-0000-000000000103');
  PERFORM pg_temp.assert_eq((SELECT waiting_for_seat FROM app.my_pending_welcomes() WHERE organisation_id = org), true, 'a joiner without a seat waits');
  PERFORM pg_temp.assert_eq(app.is_member(org), false, 'and is not a member yet');
  PERFORM app.set_member_onboarding_step(org, 'about');
  PERFORM pg_temp.assert_eq((SELECT about_done FROM app.my_pending_welcomes() WHERE organisation_id = org), true, 'but sets up their profile while waiting');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.member_onboarding), 1::bigint, 'and reads only their own');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
