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

-- ---------------------------------------------------------------------------
-- Performance advisor (auth_rls_initplan): evaluate auth.uid() once per query, not once per row.
-- Same rules as before; only `auth.uid()` becomes `(select auth.uid())`.
-- ---------------------------------------------------------------------------
DROP POLICY notifications_select ON public."Notifications";
CREATE POLICY notifications_select ON public."Notifications" FOR SELECT TO authenticated
  USING (app.is_member(organisation_id) AND (
    created_by = (select auth.uid())
    OR EXISTS (SELECT 1 FROM public."Notification Recipients" r
               WHERE r.notification_id = "Notifications".id AND r.recipient_id = (select auth.uid()))));
DROP POLICY notifications_insert ON public."Notifications";
CREATE POLICY notifications_insert ON public."Notifications" FOR INSERT TO authenticated
  WITH CHECK (app.is_member(organisation_id) AND created_by = (select auth.uid()));

DROP POLICY recipients_select ON public."Notification Recipients";
CREATE POLICY recipients_select ON public."Notification Recipients" FOR SELECT TO authenticated
  USING (recipient_id = (select auth.uid()) AND app.is_member(organisation_id));
DROP POLICY recipients_insert ON public."Notification Recipients";
CREATE POLICY recipients_insert ON public."Notification Recipients" FOR INSERT TO authenticated
  WITH CHECK (
    app.is_member(organisation_id)
    AND app.is_active_member_user(organisation_id, recipient_id)
    AND EXISTS (SELECT 1 FROM public."Notifications" n
                WHERE n.id = notification_id AND n.created_by = (select auth.uid())));
DROP POLICY recipients_update ON public."Notification Recipients";
CREATE POLICY recipients_update ON public."Notification Recipients" FOR UPDATE TO authenticated
  USING (recipient_id = (select auth.uid()) AND app.is_member(organisation_id))
  WITH CHECK (recipient_id = (select auth.uid()));

DROP POLICY profiles_select ON public.profiles;
CREATE POLICY profiles_select ON public.profiles FOR SELECT TO authenticated
  USING (id = (select auth.uid()) OR app.shares_organisation(id));
DROP POLICY profiles_update ON public.profiles;
CREATE POLICY profiles_update ON public.profiles FOR UPDATE TO authenticated
  USING (id = (select auth.uid())) WITH CHECK (id = (select auth.uid()));

DROP POLICY members_select ON public.organisation_users;
CREATE POLICY members_select ON public.organisation_users FOR SELECT TO authenticated
  USING (user_id = (select auth.uid()) OR app.has_permission(organisation_id, 'members.read'));
DROP POLICY members_update ON public.organisation_users;
CREATE POLICY members_update ON public.organisation_users FOR UPDATE TO authenticated
  USING (app.has_permission(organisation_id, 'members.manage') AND app.can_manage_membership(id)
         AND user_id IS DISTINCT FROM (select auth.uid()))
  WITH CHECK (app.has_permission(organisation_id, 'members.manage'));

DROP POLICY assignments_select ON public.user_role_assignments;
CREATE POLICY assignments_select ON public.user_role_assignments FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'members.read')
         OR EXISTS (SELECT 1 FROM public.organisation_users m WHERE m.id = membership_id AND m.user_id = (select auth.uid())));
