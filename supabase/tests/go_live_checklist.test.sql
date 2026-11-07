-- ON6a: the go-live checklist is worked out from real data, for people who can set the organisation up, in their own organisation only.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('3f000000-0000-0000-0000-000000000e01', 'owner@on6.test'), ('3f000000-0000-0000-0000-000000000e02', 'viewer@on6.test'), ('3f000000-0000-0000-0000-000000000e03', 'other@on6.test');

DO $$
DECLARE
  u_owner uuid := '3f000000-0000-0000-0000-000000000e01'; u_view uuid := '3f000000-0000-0000-0000-000000000e02'; u_other uuid := '3f000000-0000-0000-0000-000000000e03';
  org uuid; org2 uuid; viewer_role uuid; site uuid; c jsonb; m_view uuid;
  done_of text[];
BEGIN
  PERFORM pg_temp.login(u_owner); org := app.start_organisation('Checklist Works', 'Plant', 'PL', 'Europe/London', 'GB', NULL); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_other); org2 := app.start_organisation('Other Works', 'Plant', 'PO', 'Europe/London', 'GB', NULL); PERFORM pg_temp.logout();
  SELECT id INTO viewer_role FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  SELECT id INTO site FROM public.sites WHERE organisation_id = org LIMIT 1;

  -- A new organisation: a site exists (made with it); nothing else. (The gate is off here, so there is no subscription: not valid.)
  PERFORM pg_temp.login(u_owner);
  c := app.go_live_checklist(org);
  SELECT array_agg(i ->> 'key' ORDER BY ord) INTO done_of FROM jsonb_array_elements(c -> 'items') WITH ORDINALITY t(i, ord) WHERE (i ->> 'done')::boolean;
  PERFORM pg_temp.assert_eq(done_of, ARRAY['site'], 'only the site is done at the start');
  PERFORM pg_temp.assert_eq((c ->> 'requiredDone')::boolean, false, 'so the required items are not all done');
  PERFORM pg_temp.assert_eq((SELECT array_agg(i ->> 'key' ORDER BY ord) FROM jsonb_array_elements(c -> 'items') WITH ORDINALITY t(i, ord) WHERE (i ->> 'required')::boolean), ARRAY['subscription', 'site', 'departments', 'invited'], 'the required items');
  PERFORM pg_temp.assert_eq((SELECT array_agg(i ->> 'key' ORDER BY ord) FROM jsonb_array_elements(c -> 'items') WITH ORDINALITY t(i, ord) WHERE NOT (i ->> 'required')::boolean), ARRAY['details', 'logo', 'security', 'joined', 'first_ncr'], 'the recommended ones');
  PERFORM pg_temp.logout();

  -- Doing things ticks them: a department, details, a logo, the security decision, a first NC.
  INSERT INTO public.departments (organisation_id, site_id, code, name) VALUES (org, site, 'QA', 'Quality');
  UPDATE public.organisations SET legal_name = 'Checklist Works Limited', country = 'GB' WHERE id = org;
  UPDATE public.organisation_settings SET logo_path = org::text || '/logo/x.png' WHERE organisation_id = org;
  PERFORM pg_temp.login(u_owner); PERFORM app.set_onboarding_step(org, 'security', 'skipped'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_owner);
  INSERT INTO public.nonconformances (organisation_id, source, title, description, severity, quantity_affected, site_id) VALUES (org, 'internal', 'First', 'First NC', 'minor', 1, site);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_owner);
  c := app.go_live_checklist(org);
  SELECT array_agg(i ->> 'key' ORDER BY ord) INTO done_of FROM jsonb_array_elements(c -> 'items') WITH ORDINALITY t(i, ord) WHERE (i ->> 'done')::boolean;
  PERFORM pg_temp.assert_eq(done_of @> ARRAY['site', 'departments', 'details', 'logo', 'security'], true, 'department, details, logo and the security decision are ticked');
  PERFORM pg_temp.logout();

  -- Someone invited, then joined; a valid subscription.
  INSERT INTO public.organisation_users (organisation_id, invited_email, status, invited_at) VALUES (org, 'viewer@on6.test', 'invited', now()) RETURNING id INTO m_view;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) VALUES (org, m_view, viewer_role);
  PERFORM pg_temp.login(u_owner);
  PERFORM pg_temp.assert_eq((SELECT (i ->> 'done')::boolean FROM jsonb_array_elements(app.go_live_checklist(org) -> 'items') i WHERE i ->> 'key' = 'invited'), true, 'an invitation counts as inviting someone');
  PERFORM pg_temp.assert_eq((SELECT (i ->> 'done')::boolean FROM jsonb_array_elements(app.go_live_checklist(org) -> 'items') i WHERE i ->> 'key' = 'joined'), false, 'but not as joining');
  PERFORM pg_temp.logout();
  UPDATE public.organisation_users SET user_id = u_view, status = 'active', joined_at = now() WHERE id = m_view;
  PERFORM pg_temp.login(u_owner);
  PERFORM pg_temp.assert_eq((SELECT (i ->> 'done')::boolean FROM jsonb_array_elements(app.go_live_checklist(org) -> 'items') i WHERE i ->> 'key' = 'joined'), true, 'a joined member is ticked');
  PERFORM pg_temp.logout();
  -- Ordinary members cannot see the checklist; another organisation's owner cannot either.
  PERFORM pg_temp.login(u_view);
  BEGIN PERFORM app.go_live_checklist(org); RAISE EXCEPTION 'viewer should be refused';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_other);
  BEGIN PERFORM app.go_live_checklist(org); RAISE EXCEPTION 'outsider should be refused';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  PERFORM pg_temp.logout();
END $$;
ROLLBACK;
