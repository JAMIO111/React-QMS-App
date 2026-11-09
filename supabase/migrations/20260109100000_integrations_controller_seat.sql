-- Integrations: Controller seat holders only, and admins may activate a connection on their own.
--  * Every integrations.* permission now also needs the caller to hold an active Controller seat in the organisation (app.holds_controller_seat).
--    It is enforced inside app.has_permission, app.has_permission_somewhere and app.my_permissions, so the menu (my_permissions), the API's
--    permission guard, row-level security and every integration function follow it with no other change. Other permissions are untouched.
--    An organisation where nobody holds a Controller seat (e.g. one with no subscription set up) has no one who can see integrations.
--  * Activation still needs integrations.approve and a different person from the one who marked the connection ready, except that someone
--    holding the Owner or Admin role organisation-wide may activate a connection they prepared themselves (app.integration_self_approver).
--    The history still records who marked it ready and who activated it.
--  * The seat limits who may USE integrations, not who may hand out a role that includes them: role assignment, managing a member and adding
--    permissions to a custom role compare against app.my_grantable_permissions (my_permissions plus the integrations.* permissions the caller's
--    own organisation-wide roles carry), so an admin without a Controller seat can still assign the standard roles.

CREATE OR REPLACE FUNCTION app.has_permission(
  p_organisation_id uuid, p_permission text, p_site_id uuid DEFAULT NULL, p_department_id uuid DEFAULT NULL
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organisation_users m
    JOIN public.organisations o ON o.id = m.organisation_id AND o.status = 'active'
    JOIN public.user_role_assignments a ON a.membership_id = m.id
    JOIN public.role_permissions rp ON rp.role_id = a.role_id
    WHERE m.organisation_id = p_organisation_id
      AND m.user_id = auth.uid()
      AND m.status = 'active'
      AND rp.permission_code = p_permission
      AND (a.site_id IS NULL OR a.site_id = p_site_id)
      AND (a.department_id IS NULL OR a.department_id = p_department_id)
  ) AND app.mfa_satisfied(p_organisation_id)
    AND (p_permission = ANY (app.gated_permissions()) OR app.organisation_access_open(p_organisation_id))
    AND app.has_entitlement(p_organisation_id, p_permission)
    AND (p_permission NOT LIKE 'integrations.%' OR app.holds_controller_seat(p_organisation_id))
$$;

CREATE OR REPLACE FUNCTION app.has_permission_somewhere(p_organisation_id uuid, p_permission text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organisation_users m
    JOIN public.organisations o ON o.id = m.organisation_id AND o.status = 'active'
    JOIN public.user_role_assignments a ON a.membership_id = m.id
    JOIN public.role_permissions rp ON rp.role_id = a.role_id
    WHERE m.organisation_id = p_organisation_id AND m.user_id = auth.uid() AND m.status = 'active'
      AND rp.permission_code = p_permission
  ) AND app.mfa_satisfied(p_organisation_id)
    AND (p_permission = ANY (app.gated_permissions()) OR app.organisation_access_open(p_organisation_id))
    AND app.has_entitlement(p_organisation_id, p_permission)
    AND (p_permission NOT LIKE 'integrations.%' OR app.holds_controller_seat(p_organisation_id))
$$;

CREATE OR REPLACE FUNCTION app.my_permissions(p_organisation_id uuid) RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT DISTINCT rp.permission_code
  FROM public.organisation_users m
  JOIN public.organisations o ON o.id = m.organisation_id AND o.status = 'active'
  JOIN public.user_role_assignments a ON a.membership_id = m.id AND a.site_id IS NULL AND a.department_id IS NULL
  JOIN public.role_permissions rp ON rp.role_id = a.role_id
  WHERE m.organisation_id = p_organisation_id AND m.user_id = auth.uid() AND m.status = 'active'
    AND app.mfa_satisfied(p_organisation_id)
    AND (rp.permission_code = ANY (app.gated_permissions()) OR app.organisation_access_open(p_organisation_id))
    AND (rp.permission_code NOT LIKE 'integrations.%' OR app.holds_controller_seat(p_organisation_id))
$$;

-- The caller holds the Owner or Admin role across the organisation (not one scoped to a site or department).
CREATE FUNCTION app.integration_self_approver(p_organisation_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organisation_users m
    JOIN public.user_role_assignments a ON a.membership_id = m.id AND a.organisation_id = m.organisation_id AND a.site_id IS NULL AND a.department_id IS NULL
    JOIN public.roles r ON r.id = a.role_id AND r.organisation_id = m.organisation_id
    WHERE m.organisation_id = p_organisation_id AND m.user_id = auth.uid() AND m.status = 'active' AND r.key IN ('owner', 'admin'))
$$;

-- Whether the caller may activate this connection now (approval right; a different person, or an owner / admin activating their own).
CREATE FUNCTION app.integration_can_activate(p_connection uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT c.status = 'ready' AND app.has_permission(c.organisation_id, 'integrations.approve')
     AND (c.ready_by IS DISTINCT FROM auth.uid() OR app.integration_self_approver(c.organisation_id))
    FROM public.integration_connections c WHERE c.id = p_connection AND app.is_member(c.organisation_id)
$$;

CREATE OR REPLACE FUNCTION app.activate_integration_connection(p_connection uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.integration_connections%ROWTYPE; v_problems text[];
BEGIN
  c := app.integration_connection_for_write(p_connection, 'integrations.approve');
  IF c.status <> 'ready' THEN RAISE EXCEPTION 'Only a connection that is ready can be activated' USING ERRCODE = 'QM022'; END IF;
  IF c.ready_by IS NOT DISTINCT FROM auth.uid() AND NOT app.integration_self_approver(c.organisation_id) THEN
    RAISE EXCEPTION 'A different person must approve activation: you marked this connection ready (an owner or admin may activate their own)' USING ERRCODE = 'QM022';
  END IF;
  v_problems := app.integration_activation_problems(c.id);
  IF cardinality(v_problems) > 0 THEN RAISE EXCEPTION 'Not ready: %', array_to_string(v_problems, '; ') USING ERRCODE = 'QM022'; END IF;
  UPDATE public.integration_connections SET status = 'active', activated_at = now(), activated_by = auth.uid(), updated_at = now(), updated_by = auth.uid() WHERE id = c.id;
  PERFORM app.integration_log(c, 'activated', 'ready', 'active', NULL);
END $$;

REVOKE ALL ON FUNCTION app.integration_self_approver(uuid), app.integration_can_activate(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.integration_self_approver(uuid), app.integration_can_activate(uuid) TO authenticated;

-- What the caller may hand out: their permissions, plus integrations.* permissions their own organisation-wide roles carry (held by role,
-- usable only with a Controller seat).
CREATE FUNCTION app.my_grantable_permissions(p_organisation_id uuid) RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app.my_permissions(p_organisation_id)
  UNION
  SELECT rp.permission_code
  FROM public.organisation_users m
  JOIN public.organisations o ON o.id = m.organisation_id AND o.status = 'active'
  JOIN public.user_role_assignments a ON a.membership_id = m.id AND a.site_id IS NULL AND a.department_id IS NULL
  JOIN public.role_permissions rp ON rp.role_id = a.role_id
  WHERE m.organisation_id = p_organisation_id AND m.user_id = auth.uid() AND m.status = 'active'
    AND rp.permission_code LIKE 'integrations.%'
    AND app.mfa_satisfied(p_organisation_id) AND app.organisation_access_open(p_organisation_id)
$$;
REVOKE ALL ON FUNCTION app.my_grantable_permissions(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.my_grantable_permissions(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION app.can_assign_role(p_organisation_id uuid, p_role_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app.is_member(p_organisation_id) AND NOT EXISTS (
    SELECT rp.permission_code FROM public.role_permissions rp WHERE rp.role_id = p_role_id
    EXCEPT
    SELECT app.my_grantable_permissions(p_organisation_id)
  )
$$;

CREATE OR REPLACE FUNCTION app.can_manage_membership(p_membership_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app.is_member((SELECT organisation_id FROM public.organisation_users WHERE id = p_membership_id))
     AND NOT EXISTS (
       SELECT rp.permission_code
       FROM public.organisation_users m
       JOIN public.user_role_assignments a ON a.membership_id = m.id
       JOIN public.role_permissions rp ON rp.role_id = a.role_id
       WHERE m.id = p_membership_id
       EXCEPT
       SELECT app.my_grantable_permissions((SELECT organisation_id FROM public.organisation_users WHERE id = p_membership_id))
     )
$$;

DROP POLICY role_permissions_insert ON public.role_permissions;
CREATE POLICY role_permissions_insert ON public.role_permissions FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.roles r
    WHERE r.id = role_id AND r.organisation_id IS NOT NULL AND NOT r.is_system
      AND app.has_permission(r.organisation_id, 'roles.manage')
      AND permission_code IN (SELECT app.my_grantable_permissions(r.organisation_id))));
