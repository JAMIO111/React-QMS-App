-- Operator jobs: a job starts knowing only machine and part; the work order, lot, quantity and serial are filled in while it runs (app.set_job_details),
-- audited, refused for people who may not record, and frozen once the job is completed or abandoned; every other context column stays frozen.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('36000000-0000-0000-0000-000000000201', 'owner@job.test'), ('36000000-0000-0000-0000-000000000202', 'viewer@job.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  u_owner uuid := '36000000-0000-0000-0000-000000000201'; u_view uuid := '36000000-0000-0000-0000-000000000202';
  org uuid; site uuid; machine uuid; part uuid; plan uuid; rev uuid; op uuid; viewer_role uuid; m uuid; rec uuid; r text;
BEGIN
  PERFORM pg_temp.login(u_owner);
  org := app.create_organisation('Job Works', 'Plant A', 'PA', NULL);
  SELECT id INTO site FROM public.sites WHERE organisation_id = org;
  INSERT INTO public.machines (organisation_id, code, name, site_id) VALUES (org, 'LATHE-1', 'Lathe', site) RETURNING id INTO machine;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'JOB-100', 'Job part') RETURNING id INTO part;
  INSERT INTO public.part_revisions (organisation_id, part_id, revision) VALUES (org, part, 'A');
  UPDATE public.part_revisions SET status = 'released' WHERE part_id = part;
  INSERT INTO public.control_plans (organisation_id, plan_code, title) VALUES (org, 'CP-J', 'Job plan') RETURNING id INTO plan;
  INSERT INTO public.control_plan_applicability (organisation_id, control_plan_id, part_id) VALUES (org, plan, part);
  INSERT INTO public.control_plan_revisions (organisation_id, control_plan_id, revision_code, change_reason) VALUES (org, plan, 'A', 'First') RETURNING id INTO rev;
  INSERT INTO public.control_plan_operations (organisation_id, control_plan_revision_id, operation_code, sequence, name) VALUES (org, rev, 'OP-10', 10, 'Turning') RETURNING id INTO op;
  INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, sequence, name, nominal, lower_limit, upper_limit, unit_code)
    VALUES (org, rev, op, 'OD', 10, 'Outer diameter', 25, 24.95, 25.05, 'mm');
  UPDATE public.control_plan_revisions SET status = 'pending_approval' WHERE id = rev;
  UPDATE public.control_plan_revisions SET status = 'approved' WHERE id = rev;
  UPDATE public.control_plan_revisions SET status = 'effective' WHERE id = rev;

  -- A job starts with no work order, lot or quantity.
  rec := app.start_inspection(site, part, NULL, machine);
  PERFORM pg_temp.assert_eq((SELECT work_order IS NULL AND lot IS NULL AND lot_size IS NULL AND serial IS NULL AND machine_id = machine FROM public.inspection_records WHERE id = rec), true, 'started with machine and part only');

  -- They are filled in while it runs; NULL keeps, empty text clears.
  PERFORM app.set_job_details(rec, ' WO-5001 ', 'LOT-9', 250, NULL);
  PERFORM pg_temp.assert_eq((SELECT work_order || '/' || lot || '/' || lot_size FROM public.inspection_records WHERE id = rec), 'WO-5001/LOT-9/250', 'work order, lot and quantity set');
  PERFORM app.set_job_details(rec, NULL, '', NULL, 'SN-1');
  PERFORM pg_temp.assert_eq((SELECT work_order || '/' || coalesce(lot, 'none') || '/' || lot_size || '/' || serial FROM public.inspection_records WHERE id = rec), 'WO-5001/none/250/SN-1', 'NULL keeps, empty clears');

  r := pg_temp.fails(format('SELECT app.set_job_details(%L, NULL, NULL, 0, NULL)', rec));
  PERFORM pg_temp.assert_eq(r LIKE 'QM008:%quantity%', true, 'a quantity of 0 is refused');
  r := pg_temp.fails(format('SELECT app.set_job_details(%L, %L)', rec, repeat('x', 61)));
  PERFORM pg_temp.assert_eq(r LIKE 'QM008:%60 characters%', true, 'too long is refused');

  -- Everything else about the context is still frozen, even for the people who can edit the details.
  r := pg_temp.fails(format('UPDATE public.inspection_records SET machine_id = NULL WHERE id = %L', rec));
  PERFORM pg_temp.assert_eq(r LIKE '42501:%' OR r LIKE 'QM008:%', true, 'the machine cannot be changed');
  r := pg_temp.fails(format('UPDATE public.inspection_records SET operation_code = ''OP-99'' WHERE id = %L', rec));
  PERFORM pg_temp.assert_eq(r LIKE '42501:%' OR r LIKE 'QM008:%', true, 'the operation cannot be changed');
  PERFORM pg_temp.assert_eq((SELECT count(*) > 0 FROM public.audit_events WHERE organisation_id = org AND entity_type = 'inspection_records' AND action = 'update' AND changed_fields @> ARRAY['work_order']), true, 'the change is audited');
  PERFORM pg_temp.logout();

  -- A reader cannot, and is told nothing.
  SELECT id INTO viewer_role FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  INSERT INTO public.organisation_users (organisation_id, user_id, status, joined_at) VALUES (org, u_view, 'active', now()) RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) VALUES (org, m, viewer_role);
  PERFORM pg_temp.login(u_view);
  r := pg_temp.fails(format('SELECT app.set_job_details(%L, ''HACK'')', rec));
  PERFORM pg_temp.assert_eq(r LIKE 'P0002:%', true, 'a reader cannot change a job');
  PERFORM pg_temp.logout();

  -- Frozen once the job is over.
  PERFORM pg_temp.login(u_owner);
  UPDATE public.inspection_records SET status = 'abandoned', abandon_reason = 'Wrong part loaded' WHERE id = rec;
  r := pg_temp.fails(format('SELECT app.set_job_details(%L, ''LATE'')', rec));
  PERFORM pg_temp.assert_eq(r LIKE 'QM008:%abandoned%', true, 'not after the job is over');
  r := pg_temp.fails(format('UPDATE public.inspection_records SET work_order = ''LATE'' WHERE id = %L', rec));
  PERFORM pg_temp.assert_eq(r LIKE '42501:%' OR r LIKE 'QM008:%', true, 'nor by writing the column');
  PERFORM pg_temp.assert_eq((SELECT work_order FROM public.inspection_records WHERE id = rec), 'WO-5001', 'the work order is as it was');
  PERFORM pg_temp.logout();
END $$;
ROLLBACK;
