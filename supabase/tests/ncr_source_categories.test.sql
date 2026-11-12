-- Suggested category per source: seeded for existing organisations (a switched-off category is not suggested) and new ones, readable by every
-- member, changed only by people who manage the NC lists, only to an active category of the organisation or to none; rows never added or removed.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('3e300000-0000-0000-0000-000000000e01', 'ann@suggest.test'), ('3e300000-0000-0000-0000-000000000e02', 'ivy@suggest.test'),
  ('3e300000-0000-0000-0000-000000000e03', 'eve@suggest.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

-- source → category code (or '-') for one organisation, in a fixed order
CREATE FUNCTION pg_temp.map(p_org uuid) RETURNS text LANGUAGE sql AS $$
  SELECT string_agg(s.source || '=' || coalesce(c.code, '-'), ',' ORDER BY s.source)
    FROM public.ncr_source_categories s LEFT JOIN public.ncr_classifications c ON c.id = s.category_id
   WHERE s.organisation_id = p_org
$$;

DO $$
DECLARE
  ann uuid := '3e300000-0000-0000-0000-000000000e01'; ivy uuid := '3e300000-0000-0000-0000-000000000e02'; eve uuid := '3e300000-0000-0000-0000-000000000e03';
  org uuid; other uuid; fx uuid := (SELECT id FROM public.organisations WHERE slug = 'fixture-equipment-off');
  material uuid; fm uuid; theirs uuid; off uuid; r text;
  expected constant text := 'calibration=EQUIPMENT,customer=PRODUCT,engineering=-,external_audit=SYSTEM,final_inspection=PRODUCT,goods_receiving=PRODUCT,'
    || 'internal=PRODUCT,internal_audit=SYSTEM,management_review=SYSTEM,production_inspection=PRODUCT,supplier=PRODUCT';
BEGIN
  -- ---- the migration: every organisation has the eleven sources ----
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.organisations o
    WHERE (SELECT count(*) FROM public.ncr_source_categories s WHERE s.organisation_id = o.id) <> 11)::text, '0', 'every organisation has all eleven sources');
  PERFORM pg_temp.assert_eq(pg_temp.map(fx), replace(expected, 'calibration=EQUIPMENT', 'calibration=-'),
    'an organisation that had switched Equipment off gets no suggestion for calibration, the rest as usual');

  -- ---- a new organisation gets them after its categories ----
  PERFORM pg_temp.login(ann); org := app.create_organisation('Suggest Ltd', 'Plant A', 'PA', NULL); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); other := app.create_organisation('Elsewhere Ltd'); PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(pg_temp.map(org), expected, 'a new organisation: Product, Equipment for calibration, System for audits and reviews, none for engineering');
  PERFORM app.seed_ncr_source_categories(org);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.ncr_source_categories WHERE organisation_id = org)::text, '11', 'seeding again adds nothing');

  SELECT id INTO material FROM public.ncr_classifications WHERE organisation_id = org AND kind = 'category' AND code = 'MATERIAL';
  INSERT INTO public.ncr_classifications (organisation_id, kind, code, name) VALUES (org, 'failure_mode', 'DIM', 'Dimensional') RETURNING id INTO fm;
  SELECT id INTO theirs FROM public.ncr_classifications WHERE organisation_id = other AND kind = 'category' AND code = 'MATERIAL';
  SELECT id INTO off FROM public.ncr_classifications WHERE organisation_id = org AND kind = 'category' AND code = 'PACKAGING';
  UPDATE public.ncr_classifications SET active = false WHERE id = off;

  -- ---- a manager changes a suggestion, to another category or to none ----
  PERFORM pg_temp.login(ann);
  UPDATE public.ncr_source_categories SET category_id = material WHERE organisation_id = org AND source = 'supplier';
  UPDATE public.ncr_source_categories SET category_id = NULL WHERE organisation_id = org AND source = 'internal';
  PERFORM pg_temp.assert_eq(pg_temp.map(org), replace(replace(expected, 'supplier=PRODUCT', 'supplier=MATERIAL'), 'internal=PRODUCT', 'internal=-'),
    'the supplier source now suggests Material and internal nothing');
  r := pg_temp.fails(format($f$UPDATE public.ncr_source_categories SET category_id = %L WHERE organisation_id = %L AND source = 'customer'$f$, fm, org));
  PERFORM pg_temp.assert_eq(r, 'QM005: The suggested category must be one of the organisation''s categories that is in use', 'a failure mode is not a category');
  r := pg_temp.fails(format($f$UPDATE public.ncr_source_categories SET category_id = %L WHERE organisation_id = %L AND source = 'customer'$f$, off, org));
  PERFORM pg_temp.assert_eq(r, 'QM005: The suggested category must be one of the organisation''s categories that is in use', 'nor a switched-off one');
  r := pg_temp.fails(format($f$UPDATE public.ncr_source_categories SET category_id = %L WHERE organisation_id = %L AND source = 'customer'$f$, theirs, org));
  PERFORM pg_temp.assert_eq(left(r, 5) IN ('QM005', '23503')::text, 'true', 'nor another organisation''s category');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.ncr_source_categories SET source = 'engineering' WHERE organisation_id = %L AND source = 'customer'$q$, org),
    'the source of a row is not something a person can change');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.ncr_source_categories (organisation_id, source) VALUES (%L, 'customer')$q$, org), 'no rows added by hand');
  PERFORM pg_temp.assert_fails(format($q$DELETE FROM public.ncr_source_categories WHERE organisation_id = %L$q$, org), 'nor removed');
  PERFORM pg_temp.logout();

  -- A suggestion whose category is switched off later stays stored (the API leaves it out); the trigger only checks a new choice.
  UPDATE public.ncr_classifications SET active = false WHERE id = material;
  PERFORM pg_temp.login(ann);
  UPDATE public.ncr_source_categories SET category_id = category_id WHERE organisation_id = org AND source = 'supplier';
  PERFORM pg_temp.assert_eq((SELECT category_id FROM public.ncr_source_categories WHERE organisation_id = org AND source = 'supplier')::text, material::text,
    'saving a row again does not trip over a category switched off since');
  PERFORM pg_temp.logout();

  -- ---- an inspector reads them but cannot change them; another organisation sees nothing ----
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, ivy, 'active');
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = 'inspector') FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id = ivy;
  PERFORM pg_temp.login(ivy);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.ncr_source_categories WHERE organisation_id = org)::text, '11', 'every member reads the suggestions');
  PERFORM pg_temp.assert_eq(pg_temp.affected(format($q$UPDATE public.ncr_source_categories SET category_id = NULL WHERE organisation_id = %L$q$, org))::text, '0',
    'someone who does not manage the NC lists changes nothing');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.ncr_source_categories WHERE organisation_id = org)::text, '0', 'another organisation sees none of them');
  PERFORM pg_temp.logout();

  -- ---- changes are audited ----
  PERFORM pg_temp.assert_eq((SELECT count(*) > 0 FROM audit.events e WHERE e.entity_type = 'ncr_source_categories' AND e.organisation_id = org AND e.actor_user_id = ann)::text,
    'true', 'a change is in the audit trail');
END $$;

-- ---- the sites a person may raise an NC at, and the one a new NC starts with ----
INSERT INTO auth.users (id, email) VALUES
  ('3e300000-0000-0000-0000-000000000e11', 'own@sites.test'), ('3e300000-0000-0000-0000-000000000e12', 'sam@sites.test'),
  ('3e300000-0000-0000-0000-000000000e13', 'dee@sites.test'), ('3e300000-0000-0000-0000-000000000e14', 'out@sites.test');

CREATE FUNCTION pg_temp.choices(p_org uuid) RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(string_agg(code || CASE WHEN suggested THEN '*' ELSE '' END, ',' ORDER BY code), '') FROM app.my_ncr_site_choices(p_org)
$$;

DO $$
DECLARE
  own uuid := '3e300000-0000-0000-0000-000000000e11'; sam uuid := '3e300000-0000-0000-0000-000000000e12';
  dee uuid := '3e300000-0000-0000-0000-000000000e13'; outsider uuid := '3e300000-0000-0000-0000-000000000e14';
  org uuid; site_b uuid; site_c uuid; dept uuid; m uuid;
BEGIN
  PERFORM pg_temp.login(own); org := app.create_organisation('Sites Ltd', 'Plant A', 'PA', NULL); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(own);
  PERFORM pg_temp.assert_eq(pg_temp.choices(org), 'PA*', 'one site: it is the only choice and it is suggested');
  PERFORM pg_temp.logout();

  INSERT INTO public.sites (organisation_id, code, name) VALUES (org, 'PB', 'Plant B') RETURNING id INTO site_b;
  INSERT INTO public.sites (organisation_id, code, name, active) VALUES (org, 'PC', 'Plant C', false) RETURNING id INTO site_c;
  PERFORM pg_temp.login(own);
  PERFORM pg_temp.assert_eq(pg_temp.choices(org), 'PA,PB', 'two active sites (a closed one is left out), and nothing to say which is theirs');
  PERFORM pg_temp.logout();

  -- An owner whose employee record is at Plant B starts there.
  INSERT INTO public."Employees" (organisation_id, first_name, surname, site_id, auth_id) VALUES (org, 'Owen', 'Owner', site_b, own);
  PERFORM pg_temp.login(own);
  PERFORM pg_temp.assert_eq(pg_temp.choices(org), 'PA,PB*', 'their own employee record says Plant B');
  PERFORM pg_temp.logout();

  -- Someone whose role is limited to Plant B may only raise NCs there, and it is suggested.
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, sam, 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id, site_id)
    SELECT org, m, id, site_b FROM public.roles WHERE organisation_id = org AND key = 'quality_engineer';
  PERFORM pg_temp.login(sam);
  PERFORM pg_temp.assert_eq(pg_temp.choices(org), 'PB*', 'a site-limited person has their one site, suggested');
  PERFORM pg_temp.logout();

  -- An organisation-wide person with no employee record but a primary department at Plant B starts there.
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, dee, 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'quality_manager';
  INSERT INTO public.departments (organisation_id, site_id, code, name) VALUES (org, site_b, 'QA', 'Quality') RETURNING id INTO dept;
  INSERT INTO public.department_members (organisation_id, department_id, membership_id, is_primary) VALUES (org, dept, m, true);
  PERFORM pg_temp.login(dee);
  PERFORM pg_temp.assert_eq(pg_temp.choices(org), 'PA,PB*', 'their primary department is at Plant B');
  PERFORM pg_temp.logout();

  -- Someone outside the organisation gets nothing.
  PERFORM pg_temp.login(outsider);
  PERFORM pg_temp.assert_eq(pg_temp.choices(org), '', 'not a member: no sites');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(has_function_privilege('anon', 'app.my_ncr_site_choices(uuid)', 'execute')::text, 'false', 'anonymous callers cannot run it');
END $$;

ROLLBACK;
