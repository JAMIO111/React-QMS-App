-- Phase 1 / slice 1.6 — hardening found by the guardrail check (supabase/checks/guardrails.sql)
--
-- app.assert_organisation_has_owner() was created after tenancy_core's blanket
-- "REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC", so it kept PostgreSQL's default
-- EXECUTE for PUBLIC. Not exploitable (it is a trigger function and anon has no USAGE on app),
-- but revoked for hygiene. Default privileges stop future functions in app/audit from
-- receiving PUBLIC EXECUTE.

REVOKE ALL ON FUNCTION app.assert_organisation_has_owner() FROM PUBLIC;

ALTER DEFAULT PRIVILEGES IN SCHEMA app REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA audit REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Helpers answer only about organisations the caller belongs to (found by the cross-tenant sweep).
-- Previously a signed-in user could ask whether some user is an active member of any organisation,
-- or probe another organisation's role/membership permissions.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.is_active_member_user(p_organisation_id uuid, p_user_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app.is_member(p_organisation_id) AND EXISTS (
    SELECT 1 FROM public.organisation_users m
    WHERE m.organisation_id = p_organisation_id AND m.user_id = p_user_id AND m.status = 'active'
  )
$$;

CREATE OR REPLACE FUNCTION app.can_assign_role(p_organisation_id uuid, p_role_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app.is_member(p_organisation_id) AND NOT EXISTS (
    SELECT rp.permission_code FROM public.role_permissions rp WHERE rp.role_id = p_role_id
    EXCEPT
    SELECT app.my_permissions(p_organisation_id)
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
       SELECT app.my_permissions((SELECT organisation_id FROM public.organisation_users WHERE id = p_membership_id))
     )
$$;
