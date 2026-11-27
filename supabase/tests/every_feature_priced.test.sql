-- Every feature is tied to a package (docs/seats-and-member-onboarding-plan.md SM1, SM2): a drift check that no permission is left unpriced,
-- and what each package gives in an organisation that enforces entitlements (Observer views, Contributor works, Controller manages; admin
-- rights need no seat). Grandfathered organisations are unchanged.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

-- ---- drift: every permission is priced or listed as an admin right ----
DO $$
DECLARE v_missing text; v_both text;
BEGIN
  SELECT string_agg(p.code, ', ' ORDER BY p.code) INTO v_missing FROM public.permissions p
   WHERE NOT EXISTS (SELECT 1 FROM public.features f WHERE f.permission_code = p.code) AND p.code <> ALL (app.unpriced_permissions());
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'FAILED: permissions not tied to a package (add a feature, or list them in app.unpriced_permissions()): %', v_missing;
  END IF;
  SELECT string_agg(f.permission_code, ', ') INTO v_both FROM public.features f WHERE f.permission_code = ANY (app.unpriced_permissions());
  IF v_both IS NOT NULL THEN RAISE EXCEPTION 'FAILED: admin rights must not be priced: %', v_both; END IF;
  -- every module a feature uses has a level in every seat package (the organisation fee is not a seat and holds none)
  SELECT string_agg(DISTINCT m.slug || '/' || p.slug, ', ') INTO v_missing
    FROM public.features f JOIN public.modules m ON m.id = f.module_id CROSS JOIN public.subscription_plans p
   WHERE p.kind = 'seat' AND NOT EXISTS (SELECT 1 FROM public.subscription_entitlements e WHERE e.subscription_plan_id = p.id AND e.module_id = m.id AND e.feature_id IS NULL);
  IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'FAILED: modules without a level in a package: %', v_missing; END IF;
END $$;

INSERT INTO auth.users (id, email) VALUES
  ('5e000000-0000-0000-0000-000000000101', 'owner@priced.test'),
  ('5e000000-0000-0000-0000-000000000102', 'observer@priced.test'),
  ('5e000000-0000-0000-0000-000000000103', 'contributor@priced.test'),
  ('5e000000-0000-0000-0000-000000000104', 'controller@priced.test'),
  ('5e000000-0000-0000-0000-000000000105', 'admin@priced.test');

CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);
GRANT SELECT ON ids TO authenticated;

DO $$
DECLARE org uuid; m uuid; u record;
BEGIN
  PERFORM pg_temp.login('5e000000-0000-0000-0000-000000000101');
  org := app.create_organisation('Priced Works', 'Plant A', 'PA', NULL);
  PERFORM pg_temp.logout();
  INSERT INTO ids VALUES ('org', org), ('owner', (SELECT id FROM public.organisation_users WHERE organisation_id = org AND user_id = '5e000000-0000-0000-0000-000000000101'));
  -- three quality managers on different packages (and an inspector role, for carrying out audits), and an admin with no seat
  FOR u IN SELECT * FROM (VALUES ('5e000000-0000-0000-0000-000000000102'::uuid, 'observer', 'quality_manager'),
                                 ('5e000000-0000-0000-0000-000000000103'::uuid, 'contributor', 'quality_manager'),
                                 ('5e000000-0000-0000-0000-000000000104'::uuid, 'controller', 'quality_manager'),
                                 ('5e000000-0000-0000-0000-000000000105'::uuid, 'admin', 'admin')) v(id, k, role) LOOP
    INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u.id, 'active') RETURNING id INTO m;
    INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = u.role;
    IF u.k <> 'admin' THEN
      INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'inspector';
    END IF;
    INSERT INTO ids VALUES (u.k, m);
  END LOOP;

  PERFORM pg_temp.login('5e000000-0000-0000-0000-000000000101');
  PERFORM app.set_subscription_seats(org, 'observer', 1);
  PERFORM app.set_subscription_seats(org, 'contributor', 1);
  PERFORM app.set_subscription_seats(org, 'controller', 2);
  PERFORM app.assign_subscription_package((SELECT v FROM ids WHERE k = 'owner'), 'controller');
  PERFORM app.assign_subscription_package((SELECT v FROM ids WHERE k = 'observer'), 'observer');
  PERFORM app.assign_subscription_package((SELECT v FROM ids WHERE k = 'contributor'), 'contributor');
  PERFORM app.assign_subscription_package((SELECT v FROM ids WHERE k = 'controller'), 'controller');
  PERFORM pg_temp.logout();
END $$;

CREATE FUNCTION pg_temp.can(p_user uuid, p_perm text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE r boolean;
BEGIN
  PERFORM pg_temp.login(p_user);
  r := app.has_permission((SELECT v FROM ids WHERE k = 'org'), p_perm);
  PERFORM pg_temp.logout();
  RETURN r;
END $$;
CREATE FUNCTION pg_temp.shows(p_user uuid, p_perm text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE r boolean;
BEGIN
  PERFORM pg_temp.login(p_user);
  r := p_perm IN (SELECT app.my_visible_permissions((SELECT v FROM ids WHERE k = 'org')));
  PERFORM pg_temp.logout();
  RETURN r;
END $$;

-- ---- not enforced: the role decides, as before ----
DO $$
BEGIN
  PERFORM pg_temp.assert_eq(pg_temp.can('5e000000-0000-0000-0000-000000000102', 'capa.manage'), true, 'not enforced: the role is enough');
  PERFORM pg_temp.assert_eq(pg_temp.can('5e000000-0000-0000-0000-000000000105', 'capa.read'), true, 'not enforced: no seat needed');
END $$;

UPDATE public.organisation_settings SET entitlements_enforced = true WHERE organisation_id = (SELECT v FROM ids WHERE k = 'org');

-- ---- enforced ----
DO $$
DECLARE obs uuid := '5e000000-0000-0000-0000-000000000102'; con uuid := '5e000000-0000-0000-0000-000000000103';
        ctl uuid := '5e000000-0000-0000-0000-000000000104'; adm uuid := '5e000000-0000-0000-0000-000000000105';
        p text;
BEGIN
  -- Observer: reads everything, does nothing
  FOREACH p IN ARRAY ARRAY['capa.read', 'audits.read', 'documentation.read', 'supplier_quality.read', 'receiving.read', 'spc.read', 'risk.read',
                           'production.read', 'competence.read', 'management_review.read', 'workflows.read', 'master_data.read', 'audit.read'] LOOP
    PERFORM pg_temp.assert_eq(pg_temp.can(obs, p), true, 'observer reads ' || p);
  END LOOP;
  FOREACH p IN ARRAY ARRAY['capa.manage', 'audits.perform', 'competence.assess', 'receiving.manage', 'documentation.manage', 'master_data.manage'] LOOP
    PERFORM pg_temp.assert_eq(pg_temp.can(obs, p), false, 'observer cannot ' || p);
  END LOOP;

  -- Contributor: works (records, carries out, assesses, edits NCs and runs 8Ds), does not sign off or set up
  FOREACH p IN ARRAY ARRAY['audits.perform', 'competence.assess', 'receiving.manage', 'inspection.record', 'capa.read', 'capa.manage', 'ncr.update'] LOOP
    PERFORM pg_temp.assert_eq(pg_temp.can(con, p), true, 'contributor may ' || p);
  END LOOP;
  FOREACH p IN ARRAY ARRAY['capa.verify', 'audits.manage', 'documentation.manage', 'documentation.issue', 'supplier_quality.manage',
                           'supplier_quality.approve', 'risk.manage', 'production.manage', 'competence.manage', 'management_review.manage',
                           'workflows.manage', 'master_data.manage', 'custom_fields.manage', 'lookups.manage', 'ncr.approve_disposition', 'spc.manage'] LOOP
    PERFORM pg_temp.assert_eq(pg_temp.can(con, p), false, 'contributor cannot ' || p);
  END LOOP;
  PERFORM pg_temp.assert_eq(pg_temp.shows(con, 'capa.verify'), false, 'and the screens do not offer it');
  PERFORM pg_temp.assert_eq(pg_temp.shows(con, 'audits.perform'), true, 'but do offer what they may do');

  -- Controller: everything the role holds
  FOREACH p IN ARRAY ARRAY['capa.manage', 'capa.verify', 'audits.manage', 'documentation.issue', 'supplier_quality.approve', 'risk.approve',
                           'competence.manage', 'master_data.manage', 'ncr.approve_disposition'] LOOP
    PERFORM pg_temp.assert_eq(pg_temp.can(ctl, p), true, 'controller may ' || p);
  END LOOP;

  -- No seat: admin rights still work, nothing else
  FOREACH p IN ARRAY ARRAY['members.manage', 'security.manage', 'subscription.seats', 'organisation.manage'] LOOP
    PERFORM pg_temp.assert_eq(pg_temp.can(adm, p), true, 'admin without a seat keeps ' || p);
  END LOOP;
  FOREACH p IN ARRAY ARRAY['capa.read', 'master_data.read', 'documentation.read', 'audit.read'] LOOP
    PERFORM pg_temp.assert_eq(pg_temp.can(adm, p), false, 'admin without a seat cannot ' || p);
    PERFORM pg_temp.assert_eq(pg_temp.shows(adm, p), false, 'nor is it shown: ' || p);
  END LOOP;
END $$;

-- ---- choosing someone for a job asks about their seat too (app.member_may) ----
DO $$
DECLARE org uuid := (SELECT v FROM ids WHERE k = 'org');
BEGIN
  PERFORM pg_temp.assert_eq(app.member_may(org, '5e000000-0000-0000-0000-000000000104', 'documentation.issue'), true, 'a Controller may approve documents');
  PERFORM pg_temp.assert_eq(app.member_may(org, '5e000000-0000-0000-0000-000000000103', 'documentation.issue'), false, 'a Contributor may not, whatever the role');
  PERFORM pg_temp.assert_eq(app.member_may(org, '5e000000-0000-0000-0000-000000000103', 'audits.perform'), true, 'but may carry out audits');
  PERFORM pg_temp.assert_eq(app.member_may(org, '5e000000-0000-0000-0000-000000000105', 'documentation.issue'), false, 'nor may someone without a seat');
  PERFORM pg_temp.assert_eq(app.member_may(org, '5e000000-0000-0000-0000-000000000105', 'members.manage'), true, 'admin rights need no seat');
  PERFORM pg_temp.assert_eq(app.member_may(org, '5e000000-0000-0000-0000-000000000102', 'members.manage'), false, 'and the role still decides');
  UPDATE public.organisation_settings SET entitlements_enforced = false WHERE organisation_id = org;
  PERFORM pg_temp.assert_eq(app.member_may(org, '5e000000-0000-0000-0000-000000000105', 'capa.read'), true, 'not enforced: the role alone');
  UPDATE public.organisation_settings SET entitlements_enforced = true WHERE organisation_id = org;
END $$;

ROLLBACK;
