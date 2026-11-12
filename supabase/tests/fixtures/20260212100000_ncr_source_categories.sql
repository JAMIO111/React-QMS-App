-- Loaded right before the migration that adds who detected an NC and cost quantities: an NC recorded by a member who has an employee record
-- (gets that employee as who detected it), one recorded by a member with none (stays empty) and a cost line given as an amount (becomes 1 × amount).
DO $$
DECLARE o uuid; s uuid; linked uuid := '29900000-0000-0000-0000-000000000001'; unlinked uuid := '29900000-0000-0000-0000-000000000002'; n uuid;
BEGIN
  INSERT INTO auth.users (id, email) VALUES (linked, 'linked@fixture.test'), (unlinked, 'unlinked@fixture.test');
  INSERT INTO public.organisations (name, slug) VALUES ('Fixture detected by', 'fixture-detected-by') RETURNING id INTO o;
  INSERT INTO public.sites (organisation_id, code, name) VALUES (o, 'FX', 'Fixture site') RETURNING id INTO s;
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (o, linked, 'active'), (o, unlinked, 'active');
  INSERT INTO public."Employees" (organisation_id, first_name, surname, auth_id, employee_number) VALUES (o, 'Linked', 'Person', linked, 'FX-1');
  INSERT INTO public.nonconformances (organisation_id, reference, source, title, site_id, detected_by) VALUES (o, 'FX-LINKED', 'internal', 'Recorded by linked', s, linked) RETURNING id INTO n;
  INSERT INTO public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, amount) VALUES (o, n, 'scrap', 'GBP', 42.5);
  INSERT INTO public.nonconformances (organisation_id, reference, source, title, site_id, detected_by) VALUES (o, 'FX-UNLINKED', 'internal', 'Recorded by unlinked', s, unlinked);
END $$;
