-- Values a link can take (import mapping screen): the list of codes with names (search, paging, only the caller's organisation, only people with
-- integrations rights, which needs a Controller seat) and the check of values against them (by code ignoring case, ambiguous department codes, by source id
-- for one connection only, tenancy).
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('5fa00000-0000-0000-0000-000000000a01', 'ann@refvalues.test'), ('5fa00000-0000-0000-0000-000000000a02', 'bob@refvalues.test'),
  ('5fa00000-0000-0000-0000-000000000a03', 'eve@refvalues.test');

DO $$
DECLARE
  ann uuid := '5fa00000-0000-0000-0000-000000000a01'; bob uuid := '5fa00000-0000-0000-0000-000000000a02'; eve uuid := '5fa00000-0000-0000-0000-000000000a03';
  org uuid; org2 uuid; r_viewer uuid; s1 uuid; s2 uuid; r jsonb; conn uuid; prov uuid;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('Ref Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('Ref Beta'); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, bob, 'active');
  SELECT id INTO r_viewer FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, ou.id, r_viewer FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id = bob;
  PERFORM pg_temp.give_controller_seat(org, ann);
  PERFORM pg_temp.give_controller_seat(org2, eve);

  INSERT INTO public.sites (organisation_id, code, name) VALUES (org, 'LEEDS', 'Leeds plant'), (org, 'HULL', 'Hull plant');
  SELECT id INTO s1 FROM public.sites WHERE organisation_id = org AND code = 'LEEDS';
  SELECT id INTO s2 FROM public.sites WHERE organisation_id = org AND code = 'HULL';
  INSERT INTO public.departments (organisation_id, site_id, code, name) VALUES (org, s1, 'QA', 'Quality Leeds'), (org, s2, 'QA', 'Quality Hull'), (org, s1, 'MACH', 'Machining');
  INSERT INTO public.machines (organisation_id, site_id, code, name) SELECT org, s1, 'CNC-' || g, 'Lathe ' || g FROM generate_series(1, 7) g;
  INSERT INTO public.sites (organisation_id, code, name) VALUES (org2, 'OTHER', 'Not yours');

  PERFORM pg_temp.login(ann);
  r := app.integration_reference_values(org, 'site', NULL);
  PERFORM pg_temp.assert_eq((r ->> 'total')::int, (SELECT count(*)::int FROM public.sites WHERE organisation_id = org), 'every site of the organisation is listed');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM jsonb_array_elements(app.integration_reference_values(org, 'site', NULL) -> 'data') x WHERE x ->> 'code' = 'OTHER'), 0, 'another organisation''s records are never listed');
  PERFORM pg_temp.assert_eq((app.integration_reference_values(org, 'site', 'leeds') -> 'data' -> 0 ->> 'name'), 'Leeds plant', 'search matches the code or the name, ignoring case');
  PERFORM pg_temp.assert_eq((app.integration_reference_values(org, 'site', 'plant') ->> 'total')::int, 2, 'search matches part of a name');
  PERFORM pg_temp.assert_eq((app.integration_reference_values(org, 'machine', '100%') ->> 'total')::int, 0, 'a percent sign in the search is a plain character');
  r := app.integration_reference_values(org, 'machine', NULL, 3, 0);
  PERFORM pg_temp.assert_eq(jsonb_array_length(r -> 'data'), 3, 'a page holds the limit');
  PERFORM pg_temp.assert_eq((r ->> 'total')::int, 7, 'with the total of all that match');
  PERFORM pg_temp.assert_eq((app.integration_reference_values(org, 'machine', NULL, 3, 6) -> 'data' -> 0 ->> 'code'), 'CNC-7', 'paging moves on');
  PERFORM pg_temp.assert_eq((app.integration_reference_values(org, 'department', NULL) -> 'data' -> 0 ->> 'duplicate'), 'false', 'a unique department code is not flagged');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM jsonb_array_elements(app.integration_reference_values(org, 'department', 'quality') -> 'data') x WHERE x ->> 'duplicate' = 'true'), 2, 'a department code used at two sites is flagged on both');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.integration_reference_values(%L, 'nonsense', NULL)$q$, org), 'only kinds that can be linked have a list');

  -- check
  r := app.integration_reference_check(org, 'site', 'code', NULL, ARRAY['leeds', 'HULL', 'NOWHERE']);
  PERFORM pg_temp.assert_eq((r ? 'leeds'), true, 'a code is found ignoring case');
  PERFORM pg_temp.assert_eq((r ? 'NOWHERE'), false, 'an unknown code is not found');
  r := app.integration_reference_check(org, 'department', 'code', NULL, ARRAY['qa', 'mach']);
  PERFORM pg_temp.assert_eq(r ->> 'qa', 'ambiguous', 'a department code used twice is ambiguous');
  PERFORM pg_temp.assert_eq((r ? 'mach'), true, 'a unique one is found');
  r := app.integration_reference_check(org, 'unit', 'code', NULL, ARRAY['mm', 'zzz']);
  PERFORM pg_temp.assert_eq((r ? 'mm') AND NOT (r ? 'zzz'), true, 'units are matched by code');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.integration_reference_check(%L, 'site', 'source', NULL, ARRAY['x'])$q$, org), 'matching by source id needs a connection');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.integration_reference_check(%L, 'site', 'bogus', NULL, ARRAY['x'])$q$, org), 'only the two ways of matching exist');

  -- tenancy and rights
  PERFORM pg_temp.assert_fails(format($q$SELECT app.integration_reference_values(%L, 'site', NULL)$q$, org2), 'another organisation cannot be read');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.integration_reference_check(%L, 'site', 'code', NULL, ARRAY['OTHER'])$q$, org2), 'nor checked against');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_fails(format($q$SELECT app.integration_reference_values(%L, 'site', NULL)$q$, org), 'a member without integrations rights cannot list the values');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.integration_reference_check(%L, 'site', 'code', NULL, ARRAY['LEEDS'])$q$, org), 'nor check values');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login_anon();
  PERFORM pg_temp.assert_fails(format($q$SELECT app.integration_reference_values(%L, 'site', NULL)$q$, org), 'a signed-out caller cannot call it');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
