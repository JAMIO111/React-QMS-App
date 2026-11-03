-- Phase 2 / slice 2.0 — organisations can require two-factor authentication (MFA).
--
-- When organisation_settings.require_mfa is on, a member whose session has not passed MFA
-- (JWT claim aal <> 'aal2') is treated as not a member of that organisation by every helper the
-- RLS policies use. That covers the API, the legacy screens that still read tables directly, and
-- storage. Their own membership rows stay visible (policy: user_id = auth.uid()), and
-- app.mfa_blocked_organisations() tells the app which organisations need MFA, so it can send the
-- user to set it up.

ALTER TABLE public.organisation_settings
  ADD COLUMN require_mfa boolean NOT NULL DEFAULT false;
GRANT UPDATE (require_mfa) ON public.organisation_settings TO authenticated;

-- Assurance level of the current session ('aal1' password only, 'aal2' passed MFA).
CREATE FUNCTION app.session_aal() RETURNS text
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT coalesce(auth.jwt() ->> 'aal', 'aal1')
$$;

-- True when the organisation does not require MFA or this session has passed it.
CREATE FUNCTION app.mfa_satisfied(p_organisation_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app.session_aal() = 'aal2'
      OR NOT EXISTS (SELECT 1 FROM public.organisation_settings s
                     WHERE s.organisation_id = p_organisation_id AND s.require_mfa)
$$;

-- Organisations the caller is an active member of but cannot use until they pass MFA.
CREATE FUNCTION app.mfa_blocked_organisations()
RETURNS TABLE (organisation_id uuid, name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT o.id, o.name
  FROM public.organisation_users m
  JOIN public.organisations o ON o.id = m.organisation_id AND o.status = 'active'
  JOIN public.organisation_settings s ON s.organisation_id = o.id AND s.require_mfa
  WHERE m.user_id = auth.uid() AND m.status = 'active' AND app.session_aal() <> 'aal2'
  ORDER BY o.name
$$;

-- Membership helpers: unchanged except for the MFA condition.
CREATE OR REPLACE FUNCTION app.is_member(p_organisation_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organisation_users m
    JOIN public.organisations o ON o.id = m.organisation_id AND o.status = 'active'
    WHERE m.organisation_id = p_organisation_id
      AND m.user_id = auth.uid()
      AND m.status = 'active'
  ) AND app.mfa_satisfied(p_organisation_id)
$$;

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
$$;

CREATE OR REPLACE FUNCTION app.member_organisation_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT m.organisation_id
  FROM public.organisation_users m
  JOIN public.organisations o ON o.id = m.organisation_id AND o.status = 'active'
  WHERE m.user_id = auth.uid() AND m.status = 'active' AND app.mfa_satisfied(m.organisation_id)
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
$$;

CREATE OR REPLACE FUNCTION app.shares_organisation(p_user_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organisation_users mine
    JOIN public.organisation_users theirs
      ON theirs.organisation_id = mine.organisation_id AND theirs.status = 'active'
    JOIN public.organisations o ON o.id = mine.organisation_id AND o.status = 'active'
    WHERE mine.user_id = auth.uid() AND mine.status = 'active' AND theirs.user_id = p_user_id
      AND app.mfa_satisfied(mine.organisation_id)
  )
$$;

-- Turning the requirement on from a session that has not passed MFA would lock the caller out
-- straight away (and may mean they have no factor at all). Refuse it: SQLSTATE QM002.
CREATE FUNCTION app.guard_require_mfa() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.require_mfa AND NOT OLD.require_mfa AND app.session_aal() <> 'aal2'
     AND coalesce(auth.role(), '') = 'authenticated' THEN
    RAISE EXCEPTION 'Set up two-factor authentication for your own account before requiring it'
      USING ERRCODE = 'QM002';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER organisation_settings_guard_require_mfa
  BEFORE UPDATE OF require_mfa ON public.organisation_settings
  FOR EACH ROW EXECUTE FUNCTION app.guard_require_mfa();

REVOKE ALL ON FUNCTION app.session_aal(), app.mfa_satisfied(uuid), app.mfa_blocked_organisations(),
  app.guard_require_mfa() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.session_aal(), app.mfa_satisfied(uuid), app.mfa_blocked_organisations()
  TO authenticated;
