-- Linking an employee record to a sign-in account (Employees.auth_id). Only people holding a Controller seat may set or remove the link,
-- on top of master_data.manage; auth_id is not in the register's column-level UPDATE grant, so this function is the only way.

-- Does the signed-in person hold an active Controller seat in the organisation?
CREATE FUNCTION app.holds_controller_seat(p_organisation_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.organisation_users m
      JOIN public.user_subscription_assignments a ON a.organisation_membership_id = m.id AND a.organisation_id = m.organisation_id
      JOIN public.subscription_plans p ON p.id = a.subscription_plan_id
     WHERE m.organisation_id = p_organisation_id AND m.user_id = auth.uid() AND m.status = 'active'
       AND a.status = 'active' AND a.effective_from <= now() AND (a.effective_to IS NULL OR a.effective_to > now())
       AND p.slug = 'controller');
$$;
REVOKE ALL ON FUNCTION app.holds_controller_seat(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.holds_controller_seat(uuid) TO authenticated;

-- The people an employee could be linked to: active members of the organisation, with the employee each is already linked to (if any).
-- Needs master_data.manage; names and emails only.
CREATE FUNCTION app.employee_login_candidates(p_organisation_id uuid)
RETURNS TABLE (user_id uuid, first_name text, surname text, email text, employee_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT app.has_permission(p_organisation_id, 'master_data.manage') THEN
    RAISE EXCEPTION 'You are not allowed to see the organisation''s members here' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT m.user_id, pr.first_name, pr.surname, u.email::text, e.id
      FROM public.organisation_users m
      JOIN auth.users u ON u.id = m.user_id
      LEFT JOIN public.profiles pr ON pr.id = m.user_id
      LEFT JOIN public."Employees" e ON e.auth_id = m.user_id AND e.organisation_id = m.organisation_id
     WHERE m.organisation_id = p_organisation_id AND m.status = 'active' AND m.user_id IS NOT NULL
     ORDER BY lower(coalesce(pr.surname, '')), lower(coalesce(pr.first_name, '')), lower(u.email);
END $$;
REVOKE ALL ON FUNCTION app.employee_login_candidates(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.employee_login_candidates(uuid) TO authenticated;

-- Link an employee to a member's sign-in, or remove the link (p_user_id NULL). Controller seat required.
CREATE FUNCTION app.link_employee_login(p_employee_id uuid, p_user_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_org uuid;
  v_other uuid;
BEGIN
  SELECT e.organisation_id INTO v_org FROM public."Employees" e WHERE e.id = p_employee_id;
  IF v_org IS NULL OR NOT app.has_permission(v_org, 'master_data.manage') THEN
    RAISE EXCEPTION 'Employee not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT app.holds_controller_seat(v_org) THEN
    RAISE EXCEPTION 'Only people with a Controller seat can link or unlink a sign-in' USING ERRCODE = 'QM016';
  END IF;
  IF p_user_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.organisation_users m WHERE m.organisation_id = v_org AND m.user_id = p_user_id AND m.status = 'active') THEN
      RAISE EXCEPTION 'That person is not an active member of the organisation' USING ERRCODE = 'QM016';
    END IF;
    SELECT e.id INTO v_other FROM public."Employees" e WHERE e.organisation_id = v_org AND e.auth_id = p_user_id AND e.id <> p_employee_id;
    IF v_other IS NOT NULL THEN
      RAISE EXCEPTION 'That sign-in is already linked to another employee' USING ERRCODE = 'QM016';
    END IF;
  END IF;
  UPDATE public."Employees" SET auth_id = p_user_id WHERE id = p_employee_id;
END $$;
REVOKE ALL ON FUNCTION app.link_employee_login(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.link_employee_login(uuid, uuid) TO authenticated;
