-- DOC0: department membership — several departments with one primary, the role-in-department rule, ending a membership,
-- the backfill-style directory, permissions and isolation.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('3d000000-0000-0000-0000-000000000101', 'owner@dept.test'),
  ('3d000000-0000-0000-0000-000000000102', 'member@dept.test'),
  ('3d000000-0000-0000-0000-000000000103', 'other@dept.test');

DO $$
DECLARE
  org uuid; site uuid; d1 uuid; d2 uuid; d3 uuid; viewer uuid; insp uuid; m uuid; dm1 uuid; dm2 uuid; dm3 uuid;
BEGIN
  PERFORM pg_temp.login('3d000000-0000-0000-0000-000000000101');
  org := app.create_organisation('Dept Works', 'Plant A', 'PA', NULL);
  SELECT id INTO site FROM public.sites WHERE organisation_id = org;
  INSERT INTO public.departments (organisation_id, site_id, code, name) VALUES (org, site, 'GI', 'Goods-in') RETURNING id INTO d1;
  INSERT INTO public.departments (organisation_id, site_id, code, name) VALUES (org, site, 'FI', 'Final inspection') RETURNING id INTO d2;
  INSERT INTO public.departments (organisation_id, site_id, code, name) VALUES (org, site, 'MC', 'Machining') RETURNING id INTO d3;
  SELECT id INTO viewer FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  SELECT id INTO insp FROM public.roles WHERE organisation_id = org AND key = 'inspector';
  PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '3d000000-0000-0000-0000-000000000102', 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) VALUES (org, m, insp);

  PERFORM pg_temp.login('3d000000-0000-0000-0000-000000000101');
  -- The first department becomes primary; adding more keeps it; a new primary replaces it.
  INSERT INTO public.department_members (organisation_id, department_id, membership_id) VALUES (org, d1, m) RETURNING id INTO dm1;
  INSERT INTO public.department_members (organisation_id, department_id, membership_id) VALUES (org, d2, m) RETURNING id INTO dm2;
  PERFORM pg_temp.assert_eq((SELECT array_agg(is_primary ORDER BY d.code) FROM public.department_members dm JOIN public.departments d ON d.id = dm.department_id WHERE dm.membership_id = m), ARRAY[false, true]::boolean[] , 'first department is primary');
  PERFORM pg_temp.assert_eq((SELECT is_primary FROM public.department_members WHERE id = dm1), true, 'Goods-in is the primary one');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.department_members (organisation_id, department_id, membership_id) VALUES (%L, %L, %L)$q$, org, d1, m), 'one active membership per department');
  UPDATE public.department_members SET is_primary = true WHERE id = dm2;
  PERFORM pg_temp.assert_eq((SELECT array_agg(is_primary ORDER BY id = dm1) FROM public.department_members WHERE membership_id = m), ARRAY[true, false], 'a new primary replaces the old');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.department_members SET is_primary = false WHERE id = %L$q$, dm2), 'the primary is changed by choosing another');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.department_members SET department_id = %L WHERE id = %L$q$, d3, dm1), 'a membership is not moved');

  -- A role in a department needs membership of it.
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id, department_id) VALUES (%L, %L, %L, %L)$q$, org, m, viewer, d3), 'no role in a department the person is not in');
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id, department_id) VALUES (org, m, viewer, d1);
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.department_members SET ended_at = now() WHERE id = %L$q$, dm1), 'cannot leave a department while holding a role in it');
  DELETE FROM public.user_role_assignments WHERE membership_id = m AND department_id = d1;

  -- Leaving: the other department becomes primary; history is kept; an ended membership stays ended.
  UPDATE public.department_members SET ended_at = now() WHERE id = dm1;
  PERFORM pg_temp.assert_eq((SELECT (is_primary, ended_at IS NOT NULL)::text FROM public.department_members WHERE id = dm1), '(f,t)', 'ended and no longer primary');
  PERFORM pg_temp.assert_eq((SELECT is_primary FROM public.department_members WHERE id = dm2), true, 'the remaining department becomes primary');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.department_members SET ended_at = NULL WHERE id = %L$q$, dm1), 'an ended membership is not revived');
  INSERT INTO public.department_members (organisation_id, department_id, membership_id) VALUES (org, d1, m) RETURNING id INTO dm3;
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.department_members WHERE membership_id = m), 3::bigint, 'rejoining adds a new row, history kept');
  PERFORM pg_temp.assert_fails(format($q$DELETE FROM public.department_members WHERE id = %L$q$, dm3), 'memberships are never deleted');

  -- The directory lists the departments (active ones, primary first).
  PERFORM pg_temp.assert_eq((SELECT jsonb_array_length(departments) FROM app.list_members(org) WHERE membership_id = m), 2, 'two active departments listed');
  PERFORM pg_temp.assert_eq((SELECT departments -> 0 ->> 'code' FROM app.list_members(org) WHERE membership_id = m), 'FI', 'primary first');
  PERFORM pg_temp.assert_eq((SELECT count(*) >= 3 FROM public.audit_events WHERE entity_type = 'department_members'), true, 'changes are audited');
  PERFORM pg_temp.logout();

  -- The member sees their own memberships but cannot change them; an unrelated user sees none.
  PERFORM pg_temp.login('3d000000-0000-0000-0000-000000000102');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.department_members), 3::bigint, 'a member sees their own memberships');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.department_members (organisation_id, department_id, membership_id) VALUES (%L, %L, %L)$q$, org, d3, m), 'a member cannot add themselves to a department');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login('3d000000-0000-0000-0000-000000000103');
  PERFORM app.create_organisation('Other Works', 'Plant', 'PX', NULL);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.department_members), 0::bigint, 'another organisation sees none');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.department_members (organisation_id, department_id, membership_id) VALUES (%L, %L, %L)$q$, org, d3, m), 'no memberships in a foreign organisation');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
