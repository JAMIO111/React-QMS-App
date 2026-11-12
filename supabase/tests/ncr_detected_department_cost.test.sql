-- Who detected an NC (an employee), the responsible department, and costs as quantity × unit cost; the backfill of both (fixture
-- fixtures/20260212100000_ncr_source_categories.sql).
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('21300000-0000-0000-0000-000000000101', 'owner@detected.test'),
  ('21300000-0000-0000-0000-000000000102', 'viewer@detected.test');

DO $$
DECLARE
  org uuid; other uuid; site uuid; dept uuid; dept_off uuid; dept_other uuid; emp uuid; emp_off uuid; emp_other uuid; ncr uuid; c uuid; fx uuid;
BEGIN
  -- Backfill: the member who recorded the NC had an employee record; the other had none. The cost line became 1 × its amount.
  SELECT id INTO fx FROM public.organisations WHERE slug = 'fixture-detected-by';
  PERFORM pg_temp.assert_eq((SELECT e.employee_number FROM public.nonconformances n JOIN public."Employees" e ON e.id = n.detected_by_employee_id
                              WHERE n.organisation_id = fx AND n.reference = 'FX-LINKED'), 'FX-1', 'backfill: the recorder''s employee');
  PERFORM pg_temp.assert_eq((SELECT detected_by_employee_id IS NULL FROM public.nonconformances WHERE organisation_id = fx AND reference = 'FX-UNLINKED'), true,
    'backfill: nothing guessed without an employee');
  PERFORM pg_temp.assert_eq((SELECT quantity || '|' || unit_cost || '|' || amount || '|' || gross_base FROM public.ncr_costs WHERE organisation_id = fx), '1|42.5|42.5|42.50',
    'backfill: existing cost is 1 × its amount');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM audit.events WHERE organisation_id = fx AND entity_type = 'nonconformances' AND action = 'update'), 0::bigint,
    'backfill wrote no audit events');

  PERFORM pg_temp.login('21300000-0000-0000-0000-000000000101');
  org := app.create_organisation('Detected Works', 'Plant A', 'PA', NULL);
  other := app.create_organisation('Elsewhere', 'Plant Z', 'PZ', NULL);
  SELECT id INTO site FROM public.sites WHERE organisation_id = org;
  INSERT INTO public.departments (organisation_id, site_id, code, name) VALUES (org, site, 'MACH', 'Machining') RETURNING id INTO dept;
  INSERT INTO public.departments (organisation_id, site_id, code, name, active) VALUES (org, site, 'OLD', 'Old', false) RETURNING id INTO dept_off;
  INSERT INTO public.departments (organisation_id, site_id, code, name) VALUES (other, (SELECT id FROM public.sites WHERE organisation_id = other), 'ZZ', 'Other') RETURNING id INTO dept_other;
  INSERT INTO public."Employees" (organisation_id, first_name, surname) VALUES (org, 'Ada', 'Lovelace') RETURNING id INTO emp;
  INSERT INTO public."Employees" (organisation_id, first_name, surname, active) VALUES (org, 'Gone', 'Person', false) RETURNING id INTO emp_off;
  INSERT INTO public."Employees" (organisation_id, first_name, surname) VALUES (other, 'Grace', 'Hopper') RETURNING id INTO emp_other;

  INSERT INTO public.nonconformances (organisation_id, reference, source, title, site_id, detected_by_employee_id, responsible_department_id)
    VALUES (org, 'x', 'internal', 'Found at op 20', site, emp, dept) RETURNING id INTO ncr;
  PERFORM pg_temp.assert_eq((SELECT detected_by_employee_id = emp AND responsible_department_id = dept FROM public.nonconformances WHERE id = ncr), true, 'both kept');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.nonconformances SET detected_by_employee_id = %L WHERE id = %L$q$, emp_off, ncr), 'an inactive employee is refused');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.nonconformances SET detected_by_employee_id = %L WHERE id = %L$q$, emp_other, ncr), 'another organisation''s employee is refused');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.nonconformances SET responsible_department_id = %L WHERE id = %L$q$, dept_off, ncr), 'a switched-off department is refused');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.nonconformances SET responsible_department_id = %L WHERE id = %L$q$, dept_other, ncr), 'another organisation''s department is refused');
  UPDATE public.nonconformances SET detected_by_employee_id = NULL, responsible_department_id = NULL WHERE id = ncr;
  PERFORM pg_temp.assert_eq((SELECT detected_by_employee_id IS NULL AND responsible_department_id IS NULL FROM public.nonconformances WHERE id = ncr), true, 'both can be cleared');
  UPDATE public.nonconformances SET detected_by_employee_id = emp, responsible_department_id = dept WHERE id = ncr;
  -- Switching the employee or department off later leaves the NC alone (only setting or changing is checked).
  UPDATE public."Employees" SET active = false WHERE id = emp;
  UPDATE public.departments SET active = false WHERE id = dept;
  UPDATE public.nonconformances SET title = 'Found at op 20, again' WHERE id = ncr;
  PERFORM pg_temp.assert_eq((SELECT detected_by_employee_id = emp FROM public.nonconformances WHERE id = ncr), true, 'kept after the employee left');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_events WHERE organisation_id = org AND entity_id = ncr::text AND changed_fields @> array['detected_by_employee_id']), 2::bigint, 'changes are audited');

  -- Costs: quantity × unit cost, then VAT and base currency as before.
  INSERT INTO public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, vat_treatment, vat_rate, quantity, unit_cost)
    VALUES (org, ncr, 'labour', 'GBP', 'exclusive', 0.2, 2.5, 33.333) RETURNING id INTO c;
  PERFORM pg_temp.assert_eq((SELECT amount || '|' || net_amount || '|' || gross_amount || '|' || gross_base FROM public.ncr_costs WHERE id = c), '83.33|83.33|100.00|100.00',
    'amount = quantity × unit cost, rounded; VAT on top');
  UPDATE public.ncr_costs SET quantity = 3 WHERE id = c;
  PERFORM pg_temp.assert_eq((SELECT amount FROM public.ncr_costs WHERE id = c), 100.00, 'quantity change works the amount out again');
  UPDATE public.ncr_costs SET unit_cost = 10, amount = 999 WHERE id = c;
  PERFORM pg_temp.assert_eq((SELECT amount FROM public.ncr_costs WHERE id = c), 30.00, 'a supplied amount is ignored when the unit cost changes');
  UPDATE public.ncr_costs SET amount = 12 WHERE id = c;
  PERFORM pg_temp.assert_eq((SELECT quantity || '|' || unit_cost || '|' || amount FROM public.ncr_costs WHERE id = c), '1|12|12.00', 'only an amount: one at that amount');
  INSERT INTO public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, amount) VALUES (org, ncr, 'admin', 'GBP', 7) RETURNING id INTO c;
  PERFORM pg_temp.assert_eq((SELECT quantity || '|' || unit_cost || '|' || amount FROM public.ncr_costs WHERE id = c), '1|7|7.00', 'insert with only an amount');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, quantity, unit_cost) VALUES (%L, %L, 'scrap', 'GBP', 0, 5)$q$, org, ncr),
    'quantity must be more than zero');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, quantity, unit_cost) VALUES (%L, %L, 'scrap', 'GBP', 1, -1)$q$, org, ncr),
    'unit cost cannot be negative');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, quantity, unit_cost) VALUES (%L, %L, 'scrap', 'GBP', 1e8, 1e8)$q$, org, ncr),
    'an amount too large is refused');
  PERFORM pg_temp.assert_eq((SELECT sum(gross_base) FROM public.ncr_costs WHERE nonconformance_id = ncr AND deleted_at IS NULL), 21.40, 'totals follow (12 + 20% VAT, and 7)');
END $$;

-- app.my_employee: the caller's own active employee only, even without the Employees register permission.
DO $$
DECLARE org uuid := (SELECT id FROM public.organisations WHERE name = 'Detected Works'); viewer uuid := '21300000-0000-0000-0000-000000000102'; e uuid;
BEGIN
  PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, viewer, 'active');
  INSERT INTO public."Employees" (organisation_id, first_name, surname, auth_id) VALUES (org, 'Vera', 'Viewer', viewer) RETURNING id INTO e;
  PERFORM pg_temp.login(viewer);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public."Employees"), 0::bigint, 'no role: the register is hidden');
  PERFORM pg_temp.assert_eq((SELECT id || '|' || name FROM app.my_employee(org)), e || '|Vera Viewer', 'but their own record is given');
  PERFORM pg_temp.login('21300000-0000-0000-0000-000000000101');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.my_employee(org)), 0::bigint, 'none for someone with no linked employee');
  PERFORM pg_temp.logout();
  UPDATE public."Employees" SET active = false WHERE id = e;
  PERFORM pg_temp.login(viewer);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.my_employee(org)), 0::bigint, 'none once they have left');
END $$;

ROLLBACK;
