-- Two faults the single sign-on browser journey found (docs/sso-plan.md SSX, docs/sso-exit-report.md).
--
-- 1. Someone whose password account is already a member is not offered "join".
--
-- With "Anyone at your domains" on, a member who signed in with their company account was offered both "Bring your account across" and "Join":
-- joining would have given their company account a second, viewer-or-inspector membership beside the real one. Such a person moves across instead
-- (by typing their old password, or a member manager moves them). Unless a manager has marked the two accounts as different people, an
-- organisation where a password account with the same address holds a membership (active, suspended or invited) is no longer joinable, so
-- app.join_by_company_sign_in (which asks this function) refuses it too.
--
-- 2. What the screens show matches what the server allows for someone without a seat.
--
-- app.my_visible_permissions (what /me lists, so what menus and cards show) did not apply the subscription seat check that app.has_permission
-- does (app.has_entitlement). A member without a seat in an organisation whose entitlements are enforced (every self-serve organisation; people
-- joining with their company account always start without one) saw cards and menus whose requests were then refused (the home page asked for
-- GET /jobs/mine and got 403). It now applies the same check. app.my_permissions (which roles a person may hand out) is unchanged.
--
-- Both functions keep their signatures, so their grants stay. app.my_visible_permissions is the 20260128100000 version plus the entitlement line.

CREATE OR REPLACE FUNCTION app.sso_joinable_organisations()
RETURNS TABLE (organisation_id uuid, name text, role_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT o.id, o.name, r.name
    FROM public.organisation_settings s
    JOIN public.organisations o ON o.id = s.organisation_id AND o.status = 'active'
    JOIN public.roles r ON r.id = s.sso_default_role_id
    JOIN auth.users u ON u.id = auth.uid()
   WHERE s.sso_join = 'domain' AND s.sso_mode <> 'off'
     AND coalesce(u.is_sso_user, false)
     AND app.sso_session_for(s.organisation_id)
     AND app.sso_email_covered(s.organisation_id, u.email::text)
     AND NOT EXISTS (SELECT 1 FROM public.organisation_users m
                      WHERE m.organisation_id = s.organisation_id AND m.status <> 'removed'
                        AND (m.user_id = auth.uid() OR (m.status = 'invited' AND lower(m.invited_email) = lower(u.email::text))))
     -- Their password account is a member here: they bring it across instead of joining a second time.
     AND NOT EXISTS (SELECT 1 FROM public.organisation_users m
                       JOIN auth.users pu ON pu.id = m.user_id AND NOT coalesce(pu.is_sso_user, false)
                      WHERE m.organisation_id = s.organisation_id AND m.status <> 'removed'
                        AND lower(pu.email::text) = lower(u.email::text)
                        AND NOT EXISTS (SELECT 1 FROM public.sso_match_dismissals x
                                         WHERE x.organisation_id = s.organisation_id AND x.password_user_id = pu.id AND x.sso_user_id = u.id))
$$;

CREATE OR REPLACE FUNCTION app.my_visible_permissions(p_organisation_id uuid) RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p FROM (
    SELECT DISTINCT rp.permission_code AS p
    FROM public.organisation_users m
    JOIN public.organisations o ON o.id = m.organisation_id AND o.status = 'active'
    JOIN public.user_role_assignments a ON a.membership_id = m.id
    JOIN public.role_permissions rp ON rp.role_id = a.role_id
    WHERE m.organisation_id = p_organisation_id AND m.user_id = auth.uid() AND m.status = 'active'
      AND app.mfa_satisfied(p_organisation_id)
      AND (rp.permission_code = ANY (app.gated_permissions()) OR app.organisation_access_open(p_organisation_id))
      AND app.has_entitlement(p_organisation_id, rp.permission_code)
      AND (rp.permission_code NOT LIKE 'integrations.%' OR app.holds_controller_seat(p_organisation_id))
    UNION
    SELECT 'competence.read'
     WHERE app.competence_seat_read(p_organisation_id) AND app.mfa_satisfied(p_organisation_id) AND app.organisation_access_open(p_organisation_id)
    UNION
    SELECT 'competence.own'
     WHERE app.competence_has_own_record(p_organisation_id) AND app.mfa_satisfied(p_organisation_id) AND app.organisation_access_open(p_organisation_id)
  ) x
$$;
