-- Employees register: managers add and edit people, readers only read, nobody deletes; the employee number is unique per organisation;
-- a department fills in (and must match) its site; everything is audited and isolated per organisation.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('20000000-0000-0000-0000-0000000000f1', 'owner@emp.test'), ('20000000-0000-0000-0000-0000000000f2', 'viewer@emp.test'), ('20000000-0000-0000-0000-0000000000f3', 'other@emp.test');

DO $$
DECLARE
  u_owner uuid := '20000000-0000-0000-0000-0000000000f1'; u_view uuid := '20000000-0000-0000-0000-0000000000f2'; u_other uuid := '20000000-0000-0000-0000-0000000000f3';
  org uuid; org2 uuid; s1 uuid; s2 uuid; d1 uuid; e1 uuid; e2 uuid; m uuid; viewer_role uuid; ok boolean; n integer;
BEGIN
  PERFORM pg_temp.login(u_owner); org := app.create_organisation('Employee Works', 'Plant', 'PL', NULL); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_other); org2 := app.create_organisation('Other Works', 'Plant', 'PO', NULL); PERFORM pg_temp.logout();
  SELECT id INTO s1 FROM public.sites WHERE organisation_id = org LIMIT 1;
  INSERT INTO public.sites (organisation_id, code, name) VALUES (org, 'S2', 'Second') RETURNING id INTO s2;
  INSERT INTO public.departments (organisation_id, site_id, code, name) VALUES (org, s1, 'QA', 'Quality') RETURNING id INTO d1;
  SELECT id INTO viewer_role FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  INSERT INTO public.organisation_users (organisation_id, user_id, status, joined_at) VALUES (org, u_view, 'active', now()) RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) VALUES (org, m, viewer_role);

  PERFORM pg_temp.login(u_owner);
  INSERT INTO public."Employees" (organisation_id, first_name, surname, job_title, employee_number, email, department_id)
    VALUES (org, 'Ada', 'Lovelace', 'Inspector', 'E-001', 'ada@example.test', d1) RETURNING id INTO e1;
  PERFORM pg_temp.assert_eq((SELECT site_id FROM public."Employees" WHERE id = e1), s1, 'the department fills in its site');
  PERFORM pg_temp.assert_eq((SELECT created_by FROM public."Employees" WHERE id = e1), u_owner, 'created by is stamped');
  PERFORM pg_temp.assert_eq((SELECT active FROM public."Employees" WHERE id = e1), true, 'active by default');

  ok := false;
  BEGIN INSERT INTO public."Employees" (organisation_id, first_name, surname, employee_number) VALUES (org, 'Dup', 'Number', 'e-001'); EXCEPTION WHEN unique_violation THEN ok := true; END;
  PERFORM pg_temp.assert_eq(ok, true, 'the employee number is unique, whatever the case');
  ok := false;
  BEGIN INSERT INTO public."Employees" (organisation_id, first_name, surname, email) VALUES (org, 'Bad', 'Mail', 'not-an-email'); EXCEPTION WHEN check_violation THEN ok := true; END;
  PERFORM pg_temp.assert_eq(ok, true, 'a malformed email is refused');
  ok := false;
  BEGIN UPDATE public."Employees" SET site_id = s2 WHERE id = e1; EXCEPTION WHEN check_violation THEN ok := true; END;
  PERFORM pg_temp.assert_eq(ok, true, 'a site that is not the department''s is refused');

  INSERT INTO public."Employees" (organisation_id, first_name, surname) VALUES (org, 'Grace', 'Hopper') RETURNING id INTO e2;
  UPDATE public."Employees" SET active = false, job_title = 'Retired' WHERE id = e2;
  PERFORM pg_temp.assert_eq((SELECT active FROM public."Employees" WHERE id = e2), false, 'an employee can be deactivated');
  PERFORM pg_temp.assert_eq((SELECT updated_by FROM public."Employees" WHERE id = e2), u_owner, 'updated by is stamped');

  ok := false;
  BEGIN DELETE FROM public."Employees" WHERE id = e2; EXCEPTION WHEN insufficient_privilege THEN ok := true; END;
  PERFORM pg_temp.assert_eq(ok, true, 'nobody deletes an employee');
  ok := false;
  BEGIN UPDATE public."Employees" SET organisation_id = org2 WHERE id = e2; EXCEPTION WHEN insufficient_privilege THEN ok := true; END;
  PERFORM pg_temp.assert_eq(ok, true, 'the organisation cannot be changed');
  PERFORM pg_temp.logout();

  -- A reader sees them but cannot add or change.
  PERFORM pg_temp.login(u_view);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public."Employees" WHERE organisation_id = org), 2::bigint, 'a member can read the register');
  ok := false;
  BEGIN INSERT INTO public."Employees" (organisation_id, first_name, surname) VALUES (org, 'No', 'Rights'); EXCEPTION WHEN insufficient_privilege THEN ok := true; END;
  PERFORM pg_temp.assert_eq(ok, true, 'a reader cannot add');
  UPDATE public."Employees" SET job_title = 'Hacked' WHERE id = e1;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM pg_temp.assert_eq(n, 0, 'a reader cannot change');
  PERFORM pg_temp.logout();

  -- Another organisation sees none of it.
  PERFORM pg_temp.login(u_other);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public."Employees" WHERE organisation_id = org), 0::bigint, 'another organisation cannot read it');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.assert_eq((SELECT count(*) > 0 FROM public.audit_events WHERE organisation_id = org AND entity_type = 'Employees' AND action = 'insert'), true, 'adding is audited');
  PERFORM pg_temp.assert_eq((SELECT count(*) > 0 FROM public.audit_events WHERE organisation_id = org AND entity_type = 'Employees' AND action = 'update' AND changed_fields @> ARRAY['active']), true, 'changing is audited');
END $$;
ROLLBACK;
