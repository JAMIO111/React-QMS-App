-- Linking an employee to a sign-in: only a Controller seat holder with master_data.manage can; the target must be an active member, linked to one employee at most;
-- the link cannot be written any other way; changes are audited; candidates are listed for managers only.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('20000000-0000-0000-0000-0000000000a1', 'owner@link.test'), ('20000000-0000-0000-0000-0000000000a2', 'admin@link.test'),
  ('20000000-0000-0000-0000-0000000000a3', 'member@link.test'), ('20000000-0000-0000-0000-0000000000a4', 'outsider@link.test');

CREATE FUNCTION pg_temp.seed_seats(p_org uuid, p_plan text, p_qty integer) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_sub uuid; v_price public.subscription_prices%ROWTYPE; v_plan uuid;
BEGIN
  SELECT id INTO v_sub FROM public.organisation_subscriptions WHERE organisation_id = p_org;
  IF v_sub IS NULL THEN INSERT INTO public.organisation_subscriptions (organisation_id, current_period_end) VALUES (p_org, now() + interval '1 month') RETURNING id INTO v_sub; END IF;
  SELECT id INTO v_plan FROM public.subscription_plans WHERE slug = p_plan;
  SELECT * INTO v_price FROM public.subscription_prices WHERE subscription_plan_id = v_plan AND billing_interval = 'month' AND currency = 'GBP' AND active AND effective_to IS NULL;
  INSERT INTO public.organisation_subscription_items (organisation_id, organisation_subscription_id, subscription_plan_id, subscription_price_id, quantity, unit_amount_snapshot, currency)
  VALUES (p_org, v_sub, v_plan, v_price.id, p_qty, v_price.unit_amount, 'GBP')
  ON CONFLICT (organisation_subscription_id, subscription_plan_id) DO UPDATE SET quantity = EXCLUDED.quantity;
END $$;

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  u_owner uuid := '20000000-0000-0000-0000-0000000000a1'; u_admin uuid := '20000000-0000-0000-0000-0000000000a2';
  u_member uuid := '20000000-0000-0000-0000-0000000000a3'; u_out uuid := '20000000-0000-0000-0000-0000000000a4';
  org uuid; org2 uuid; admin_role uuid; viewer_role uuid; m_admin uuid; m_member uuid; e1 uuid; e2 uuid; r text;
BEGIN
  PERFORM pg_temp.login(u_owner); org := app.create_organisation('Link Works', 'Plant', 'PL', NULL); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_out); org2 := app.create_organisation('Other Works', 'Plant', 'PO', NULL); PERFORM pg_temp.logout();
  SELECT id INTO admin_role FROM public.roles WHERE organisation_id = org AND key = 'admin';
  SELECT id INTO viewer_role FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  INSERT INTO public.organisation_users (organisation_id, user_id, status, joined_at) VALUES (org, u_admin, 'active', now()) RETURNING id INTO m_admin;
  INSERT INTO public.organisation_users (organisation_id, user_id, status, joined_at) VALUES (org, u_member, 'active', now()) RETURNING id INTO m_member;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) VALUES (org, m_admin, admin_role), (org, m_member, viewer_role);
  INSERT INTO public."Employees" (organisation_id, first_name, surname) VALUES (org, 'Ada', 'Lovelace') RETURNING id INTO e1;
  INSERT INTO public."Employees" (organisation_id, first_name, surname) VALUES (org, 'Grace', 'Hopper') RETURNING id INTO e2;

  -- Seats: the owner holds a Controller seat, the admin a Contributor seat (an admin may manage master data without being a Controller).
  PERFORM pg_temp.seed_seats(org, 'controller', 1);
  PERFORM pg_temp.seed_seats(org, 'contributor', 2);
  PERFORM pg_temp.login(u_owner); PERFORM app.assign_subscription_package((SELECT id FROM public.organisation_users WHERE organisation_id = org AND user_id = u_owner), 'controller');
  PERFORM app.assign_subscription_package(m_admin, 'contributor'); PERFORM pg_temp.logout();

  -- A Controller seat holder can link, and the sign-in shows on the employee.
  PERFORM pg_temp.login(u_owner);
  PERFORM pg_temp.assert_eq(app.holds_controller_seat(org), true, 'the owner holds the Controller seat');
  PERFORM app.link_employee_login(e1, u_member);
  PERFORM pg_temp.assert_eq((SELECT auth_id FROM public."Employees" WHERE id = e1), u_member, 'linked');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.employee_login_candidates(org) c WHERE c.user_id = u_member AND c.employee_id = e1), 1::bigint, 'the candidate list says who is linked to whom');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.employee_login_candidates(org)), 3::bigint, 'every active member is a candidate');

  r := pg_temp.fails(format('SELECT app.link_employee_login(%L, %L)', e2, u_member));
  PERFORM pg_temp.assert_eq(r LIKE 'QM016:%already linked%', true, 'one sign-in, one employee');
  r := pg_temp.fails(format('SELECT app.link_employee_login(%L, %L)', e2, u_out));
  PERFORM pg_temp.assert_eq(r LIKE 'QM016:%not an active member%', true, 'only members of the organisation');

  PERFORM app.link_employee_login(e1, NULL);
  PERFORM pg_temp.assert_eq((SELECT auth_id IS NULL FROM public."Employees" WHERE id = e1), true, 'unlinked');
  PERFORM app.link_employee_login(e1, u_member);
  PERFORM pg_temp.logout();

  -- An admin who may manage master data but holds no Controller seat cannot link or unlink.
  PERFORM pg_temp.login(u_admin);
  PERFORM pg_temp.assert_eq(app.holds_controller_seat(org), false, 'a Contributor seat is not a Controller seat');
  r := pg_temp.fails(format('SELECT app.link_employee_login(%L, %L)', e2, u_admin));
  PERFORM pg_temp.assert_eq(r LIKE 'QM016:%Controller seat%', true, 'not without a Controller seat');
  r := pg_temp.fails(format('SELECT app.link_employee_login(%L, NULL)', e1));
  PERFORM pg_temp.assert_eq(r LIKE 'QM016:%Controller seat%', true, 'nor unlink');
  PERFORM pg_temp.assert_eq((SELECT auth_id FROM public."Employees" WHERE id = e1), u_member, 'the link is unchanged');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.employee_login_candidates(org)), 3::bigint, 'but may see the candidates to read who is linked');
  r := pg_temp.fails(format($q$UPDATE public."Employees" SET auth_id = %L WHERE id = %L$q$, u_admin, e2));
  PERFORM pg_temp.assert_eq(r LIKE '42501:%', true, 'the column cannot be written directly');
  PERFORM pg_temp.logout();

  -- Someone without master_data.manage cannot, even with a Controller seat; another organisation's people cannot.
  PERFORM pg_temp.login(u_member);
  r := pg_temp.fails(format('SELECT app.link_employee_login(%L, NULL)', e1));
  PERFORM pg_temp.assert_eq(r LIKE 'P0002:%', true, 'a reader cannot (and is told nothing)');
  r := pg_temp.fails(format('SELECT * FROM app.employee_login_candidates(%L)', org));
  PERFORM pg_temp.assert_eq(r LIKE '42501:%', true, 'a reader cannot list candidates');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_out);
  r := pg_temp.fails(format('SELECT app.link_employee_login(%L, NULL)', e1));
  PERFORM pg_temp.assert_eq(r LIKE 'P0002:%', true, 'another organisation cannot');
  PERFORM pg_temp.assert_eq(app.holds_controller_seat(org), false, 'and holds no seat here');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.assert_eq((SELECT count(*) > 0 FROM public.audit_events WHERE organisation_id = org AND entity_type = 'Employees' AND action = 'update' AND changed_fields @> ARRAY['auth_id']), true, 'linking is audited');
END $$;
ROLLBACK;
