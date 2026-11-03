-- Phase 1 / slice 1.5 — members, invitations and the last-owner rule (docs/phase-1-plan.md §4)
--
-- * app.list_members(org): member directory incl. login email (auth.users is not readable by API
--   roles), for callers holding members.read.
-- * app.my_invitations() / app.accept_invitation(id): an invited person sees and accepts invitations
--   addressed to their verified account email. Accepting links the membership to their user id.
-- * The last-owner rule raises its own SQLSTATE (QM001) so the API can answer 409 last_owner.
-- Inviting, suspending, removing and role changes themselves go through the existing RLS policies
-- (members.manage + no privilege escalation).

-- A revoked invitation (status 'removed') never had a user; 1.1's check required one.
ALTER TABLE public.organisation_users DROP CONSTRAINT organisation_users_active_has_user;
ALTER TABLE public.organisation_users ADD CONSTRAINT organisation_users_active_has_user
  CHECK (status IN ('invited', 'removed') OR user_id IS NOT NULL);

ALTER TABLE public.organisation_users
  ALTER COLUMN invited_by SET DEFAULT auth.uid(),
  ADD CONSTRAINT organisation_users_invited_email_lower CHECK (invited_email IS NULL OR invited_email = lower(invited_email));

-- ---------------------------------------------------------------------------
-- Member directory
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.list_members(p_organisation_id uuid)
RETURNS TABLE (
  membership_id uuid, user_id uuid, email text, first_name text, surname text, job_title text,
  status text, invited_email text, invited_at timestamptz, joined_at timestamptz, roles jsonb
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT app.has_permission(p_organisation_id, 'members.read') THEN
    RAISE EXCEPTION 'members.read required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT m.id, m.user_id, coalesce(u.email::text, m.invited_email), p.first_name, p.surname, p.job_title,
         m.status, m.invited_email, m.invited_at, m.joined_at,
         coalesce((
           SELECT jsonb_agg(jsonb_build_object(
                    'assignmentId', a.id, 'roleId', r.id, 'roleKey', r.key, 'roleName', r.name,
                    'siteId', a.site_id, 'departmentId', a.department_id) ORDER BY r.name)
           FROM public.user_role_assignments a JOIN public.roles r ON r.id = a.role_id
           WHERE a.membership_id = m.id), '[]'::jsonb)
  FROM public.organisation_users m
  LEFT JOIN auth.users u ON u.id = m.user_id
  LEFT JOIN public.profiles p ON p.id = m.user_id
  WHERE m.organisation_id = p_organisation_id
  ORDER BY (m.status = 'removed'), lower(coalesce(p.surname, '')), lower(coalesce(p.first_name, '')), lower(coalesce(u.email::text, m.invited_email));
END $$;

-- ---------------------------------------------------------------------------
-- Invitations for the signed-in person
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.my_invitations()
RETURNS TABLE (membership_id uuid, organisation_id uuid, organisation_name text, invited_at timestamptz, invited_by_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT m.id, o.id, o.name, m.invited_at,
         nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.surname, '')), '')
  FROM public.organisation_users m
  JOIN public.organisations o ON o.id = m.organisation_id AND o.status = 'active'
  JOIN auth.users me ON me.id = auth.uid()
  LEFT JOIN public.profiles p ON p.id = m.invited_by
  WHERE m.status = 'invited' AND m.invited_email = lower(me.email)
  ORDER BY m.invited_at DESC NULLS LAST
$$;

CREATE FUNCTION app.accept_invitation(p_membership_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := auth.uid();
  v_email text;
  v_org uuid;
BEGIN
  SELECT lower(u.email) INTO v_email FROM auth.users u WHERE u.id = v_user;
  IF v_user IS NULL OR v_email IS NULL THEN
    RAISE EXCEPTION 'sign in to accept an invitation' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT m.organisation_id INTO v_org
  FROM public.organisation_users m
  JOIN public.organisations o ON o.id = m.organisation_id AND o.status = 'active'
  WHERE m.id = p_membership_id AND m.status = 'invited' AND m.invited_email = v_email
  FOR UPDATE OF m;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invitation not found' USING ERRCODE = 'no_data_found';
  END IF;

  IF EXISTS (SELECT 1 FROM public.organisation_users WHERE organisation_id = v_org AND user_id = v_user) THEN
    RAISE EXCEPTION 'already a member of this organisation' USING ERRCODE = 'unique_violation',
      CONSTRAINT = 'organisation_users_org_user_key';
  END IF;

  UPDATE public.organisation_users
     SET user_id = v_user, status = 'active', joined_at = now()
   WHERE id = p_membership_id;
  RETURN v_org;
END $$;

REVOKE ALL ON FUNCTION app.list_members(uuid), app.my_invitations(), app.accept_invitation(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_members(uuid), app.my_invitations(), app.accept_invitation(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Last-owner rule: same logic, dedicated SQLSTATE QM001
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.assert_organisation_has_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_org uuid := coalesce(NEW.organisation_id, OLD.organisation_id);
BEGIN
  IF EXISTS (SELECT 1 FROM public.organisations WHERE id = v_org)
     AND NOT EXISTS (
       SELECT 1
       FROM public.organisation_users m
       JOIN public.user_role_assignments a ON a.membership_id = m.id AND a.site_id IS NULL AND a.department_id IS NULL
       JOIN public.roles r ON r.id = a.role_id AND r.key = 'owner' AND r.is_system
       WHERE m.organisation_id = v_org AND m.status = 'active'
     ) THEN
    RAISE EXCEPTION 'organisation % must keep at least one active owner', v_org
      USING ERRCODE = 'QM001';
  END IF;
  RETURN NULL;
END $$;
