-- ON4a (docs/onboarding-plan.md §14): invitations that expire, can be resent and revoked, carry a message and reserve a seat.
--
--  * The invitation row is still inserted under RLS (members.manage) as before. Its new details are set by functions only: app.set_invitation_details (message, 14-day expiry, send counters and the
--    optional package seat), app.resend_invitation (rate limited), app.revoke_invitation (frees the reserved seat). app.accept_invitation refuses an expired invitation.
--  * A seat is reserved when the invitation is sent (existing capacity rule QM009); it is freed on revoke and kept on accept. Errors of the invitation rules use QM015 -> 409 invitation_rule.
--  * app.my_invitations() and app.list_members() return the extra detail (roles, departments, package, message, expiry) the invitee page and the team screens show.

ALTER TABLE public.organisation_users
  ADD COLUMN invite_message text CHECK (invite_message IS NULL OR length(invite_message) <= 500),
  ADD COLUMN invite_expires_at timestamptz,
  ADD COLUMN invite_last_sent_at timestamptz,
  ADD COLUMN invite_send_count integer NOT NULL DEFAULT 0 CHECK (invite_send_count >= 0);

-- ---------------------------------------------------------------------------
-- Writing the details (members.manage; a package also needs subscription.seats and a free seat)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.set_invitation_details(p_membership_id uuid, p_message text, p_package_slug text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid; v_status text; v_message text := nullif(btrim(coalesce(p_message, '')), '');
BEGIN
  SELECT m.organisation_id, m.status INTO v_org, v_status FROM public.organisation_users m WHERE m.id = p_membership_id;
  IF v_org IS NULL OR NOT app.has_permission(v_org, 'members.manage') THEN
    RAISE EXCEPTION 'Not allowed to manage invitations' USING ERRCODE = '42501';
  END IF;
  IF v_status <> 'invited' THEN
    RAISE EXCEPTION 'Only a pending invitation can be changed' USING ERRCODE = 'QM015';
  END IF;
  IF v_message IS NOT NULL AND length(v_message) > 500 THEN
    RAISE EXCEPTION 'The message can be at most 500 characters' USING ERRCODE = 'QM015';
  END IF;
  UPDATE public.organisation_users
     SET invite_message = v_message, invite_expires_at = now() + interval '14 days', invite_last_sent_at = now(), invite_send_count = 1
   WHERE id = p_membership_id;
  IF p_package_slug IS NOT NULL THEN
    IF NOT app.has_permission(v_org, 'subscription.seats') THEN
      RAISE EXCEPTION 'You cannot give a package: only people who manage seats can. Invite without a package and assign one later.' USING ERRCODE = 'QM015';
    END IF;
    PERFORM app.assign_subscription_package(p_membership_id, p_package_slug); -- QM009 when there is no free seat
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Resend (at least 60 seconds apart, at most 10 times) and revoke
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.resend_invitation(p_membership_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE m public.organisation_users%ROWTYPE;
BEGIN
  SELECT * INTO m FROM public.organisation_users WHERE id = p_membership_id FOR UPDATE;
  IF NOT FOUND OR NOT app.has_permission(m.organisation_id, 'members.manage') OR NOT app.can_manage_membership(p_membership_id) THEN
    RAISE EXCEPTION 'Not allowed to manage this invitation' USING ERRCODE = '42501';
  END IF;
  IF m.status <> 'invited' THEN
    RAISE EXCEPTION 'Only a pending invitation can be sent again' USING ERRCODE = 'QM015';
  END IF;
  IF m.invite_last_sent_at IS NOT NULL AND m.invite_last_sent_at > now() - interval '60 seconds' THEN
    RAISE EXCEPTION 'This invitation was sent a moment ago. Wait a minute before sending it again.' USING ERRCODE = 'QM015';
  END IF;
  IF m.invite_send_count >= 10 THEN
    RAISE EXCEPTION 'This invitation has been sent 10 times. Revoke it and invite the person again if needed.' USING ERRCODE = 'QM015';
  END IF;
  UPDATE public.organisation_users
     SET invite_last_sent_at = now(), invite_send_count = invite_send_count + 1, invite_expires_at = now() + interval '14 days'
   WHERE id = p_membership_id;
  RETURN jsonb_build_object('sendCount', m.invite_send_count + 1, 'expiresAt', now() + interval '14 days');
END $$;

CREATE FUNCTION app.revoke_invitation(p_membership_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE m public.organisation_users%ROWTYPE;
BEGIN
  SELECT * INTO m FROM public.organisation_users WHERE id = p_membership_id FOR UPDATE;
  IF NOT FOUND OR NOT app.has_permission(m.organisation_id, 'members.manage') OR NOT app.can_manage_membership(p_membership_id) THEN
    RAISE EXCEPTION 'Not allowed to manage this invitation' USING ERRCODE = '42501';
  END IF;
  IF m.status <> 'invited' THEN
    RAISE EXCEPTION 'Only a pending invitation can be revoked' USING ERRCODE = 'QM015';
  END IF;
  UPDATE public.user_subscription_assignments SET status = 'ended', effective_to = now(), ended_by = auth.uid()
   WHERE organisation_membership_id = p_membership_id AND status = 'active';
  UPDATE public.organisation_users SET status = 'removed' WHERE id = p_membership_id;
END $$;

-- ---------------------------------------------------------------------------
-- Accepting: an expired invitation is refused with its own message
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.accept_invitation(p_membership_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := auth.uid();
  v_email text;
  v_org uuid;
  v_expires timestamptz;
BEGIN
  SELECT lower(u.email) INTO v_email FROM auth.users u WHERE u.id = v_user;
  IF v_user IS NULL OR v_email IS NULL THEN
    RAISE EXCEPTION 'sign in to accept an invitation' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT m.organisation_id, m.invite_expires_at INTO v_org, v_expires
  FROM public.organisation_users m
  JOIN public.organisations o ON o.id = m.organisation_id AND o.status = 'active'
  WHERE m.id = p_membership_id AND m.status = 'invited' AND m.invited_email = v_email
  FOR UPDATE OF m;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invitation not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_expires IS NOT NULL AND v_expires <= now() THEN
    RAISE EXCEPTION 'This invitation has expired. Ask for a new one.' USING ERRCODE = 'QM015';
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

-- ---------------------------------------------------------------------------
-- What the invitee sees (replaces the earlier shape)
-- ---------------------------------------------------------------------------
DROP FUNCTION app.my_invitations();
CREATE FUNCTION app.my_invitations()
RETURNS TABLE (membership_id uuid, organisation_id uuid, organisation_name text, invited_at timestamptz, invited_by_name text,
               message text, expires_at timestamptz, expired boolean, roles jsonb, departments jsonb, package_slug text, package_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT m.id, o.id, o.name, m.invited_at,
         nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.surname, '')), ''),
         m.invite_message, m.invite_expires_at, (m.invite_expires_at IS NOT NULL AND m.invite_expires_at <= now()),
         coalesce((SELECT jsonb_agg(jsonb_build_object('key', r.key, 'name', r.name) ORDER BY r.name)
                     FROM public.user_role_assignments a JOIN public.roles r ON r.id = a.role_id WHERE a.membership_id = m.id), '[]'::jsonb),
         coalesce((SELECT jsonb_agg(d.name ORDER BY dm.is_primary DESC, d.name)
                     FROM public.department_members dm JOIN public.departments d ON d.id = dm.department_id
                    WHERE dm.membership_id = m.id AND dm.ended_at IS NULL), '[]'::jsonb),
         pl.slug, pl.name
  FROM public.organisation_users m
  JOIN public.organisations o ON o.id = m.organisation_id AND o.status = 'active'
  JOIN auth.users me ON me.id = auth.uid()
  LEFT JOIN public.profiles p ON p.id = m.invited_by
  LEFT JOIN public.user_subscription_assignments sa ON sa.organisation_membership_id = m.id AND sa.status = 'active'
  LEFT JOIN public.subscription_plans pl ON pl.id = sa.subscription_plan_id
  WHERE m.status = 'invited' AND m.invited_email = lower(me.email)
  ORDER BY m.invited_at DESC NULLS LAST
$$;

-- ---------------------------------------------------------------------------
-- What the team screens see: invitation detail on invited rows
-- ---------------------------------------------------------------------------
DROP FUNCTION app.list_members(uuid);
CREATE FUNCTION app.list_members(p_organisation_id uuid)
RETURNS TABLE (
  membership_id uuid, user_id uuid, email text, first_name text, surname text, job_title text,
  status text, invited_email text, invited_at timestamptz, joined_at timestamptz, roles jsonb, departments jsonb, invite jsonb
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
           WHERE a.membership_id = m.id), '[]'::jsonb),
         coalesce((
           SELECT jsonb_agg(jsonb_build_object(
                    'id', dm.id, 'departmentId', d.id, 'code', d.code, 'name', d.name, 'siteId', d.site_id,
                    'siteName', s.name, 'isPrimary', dm.is_primary, 'joinedAt', dm.joined_at) ORDER BY dm.is_primary DESC, s.name, d.name)
           FROM public.department_members dm
           JOIN public.departments d ON d.id = dm.department_id
           JOIN public.sites s ON s.id = d.site_id
           WHERE dm.membership_id = m.id AND dm.ended_at IS NULL), '[]'::jsonb),
         CASE WHEN m.status = 'invited' THEN jsonb_build_object(
           'message', m.invite_message, 'expiresAt', m.invite_expires_at, 'lastSentAt', m.invite_last_sent_at, 'sendCount', m.invite_send_count,
           'expired', (m.invite_expires_at IS NOT NULL AND m.invite_expires_at <= now()),
           'packageSlug', pl.slug, 'packageName', pl.name) END
  FROM public.organisation_users m
  LEFT JOIN auth.users u ON u.id = m.user_id
  LEFT JOIN public.profiles p ON p.id = m.user_id
  LEFT JOIN public.user_subscription_assignments sa ON sa.organisation_membership_id = m.id AND sa.status = 'active' AND m.status = 'invited'
  LEFT JOIN public.subscription_plans pl ON pl.id = sa.subscription_plan_id
  WHERE m.organisation_id = p_organisation_id
  ORDER BY (m.status = 'removed'), lower(coalesce(p.surname, '')), lower(coalesce(p.first_name, '')), lower(coalesce(u.email::text, m.invited_email));
END $$;

REVOKE ALL ON FUNCTION app.set_invitation_details(uuid, text, text), app.resend_invitation(uuid), app.revoke_invitation(uuid), app.accept_invitation(uuid),
  app.my_invitations(), app.list_members(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.set_invitation_details(uuid, text, text), app.resend_invitation(uuid), app.revoke_invitation(uuid), app.accept_invitation(uuid),
  app.my_invitations(), app.list_members(uuid) TO authenticated;
