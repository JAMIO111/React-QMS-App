-- Single sign-on SS3 (docs/sso-plan.md, decisions SS6–SS9): requiring the company's sign-in, enforced where the two-factor rule is.
--
-- 1. Reading the session: app.session_amr() (the token's amr array, NULL when the token has none: system work acting for a person sets only sub,
--    role and aal, and every real Supabase token carries amr) and app.sso_session_for(org) (an amr entry with method sso/saml naming the
--    organisation's ACTIVE provider; the whole array is searched, because a second factor can come first).
-- 2. app.mfa_satisfied(org) — called by every membership and permission helper — is now "two-factor satisfied AND single sign-on satisfied":
--      two-factor: aal2, or not required, or (sso_trust_idp_mfa and a session from this organisation's provider) (SS7);
--      single sign-on: mode is not required, or the token has no amr (system work), or a session from this organisation's provider, or a
--      break-glass member at aal2 (SS8; never a password alone).
--    The two halves are also app.two_factor_satisfied / app.sso_satisfied, so the app can tell which one blocks: app.mfa_blocked_organisations
--    lists only the two-factor ones, app.sso_blocked_organisations the single sign-on ones (with the provider id for the button).
-- 3. Modes off | optional | required through app.set_sso_mode (security.manage). Optional and required need a connected provider with a domain;
--    required needs the person switching to be signed in through it now (so it is known to work). The session limit defaults to 12 hours while
--    required (app.max_session_hours; the stored setting wins when set) (SS9). Two-factor trust through app.set_sso_trust_idp_mfa.
-- 4. sso_break_glass_members: at most three organisation-wide owners or admins, replaced as a whole by app.set_sso_break_glass.
-- 5. sso_sign_ins: one row per organisation, person, method (sso | break_glass) and hour with a count, written by the API login
--    (app.system_record_sso_sign_in); the first break-glass use in an hour is a notice to owners and admins. Kept 90 days.
-- 6. sso_changes: every change of mode, two-factor trust, break-glass list, each break-glass use and an operator's recovery; frozen, audited,
--    read with security.read; a notice to owners and admins with no actor (so the person who changed it is told too), emailed by default.
-- 7. While single sign-on is in use (not off): the provider cannot be disconnected, nor a verified domain removed (switch it off first).
--    While required: invitations only to addresses at the organisation's verified single sign-on domains (QM015).
-- 8. app.platform_recover_sso(org, reason, verification): a platform operator with MFA puts REQUIRED back to OPTIONAL (never off), as the network
--    recovery does. app.platform_sso_modes(orgs) for the operator panel.
-- Errors QM030 → 409 sso_rule.

-- ---------------------------------------------------------------------------
-- 1. The session
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.session_amr() RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT CASE WHEN jsonb_typeof(auth.jwt() -> 'amr') = 'array' THEN auth.jwt() -> 'amr' END
$$;

CREATE FUNCTION app.sso_session_for(p_organisation_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(coalesce(app.session_amr(), '[]'::jsonb)) e
      JOIN public.organisation_sso_providers p
        ON p.organisation_id = p_organisation_id AND p.status = 'active' AND p.supabase_provider_id::text = lower(e ->> 'provider')
     WHERE jsonb_typeof(e) = 'object' AND e ->> 'method' = 'sso/saml')
$$;

-- An organisation-wide owner or admin of the organisation (active membership).
CREATE FUNCTION app.sso_owner_or_admin(p_organisation_id uuid, p_user_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.organisation_users m
      JOIN public.user_role_assignments a ON a.membership_id = m.id AND a.site_id IS NULL AND a.department_id IS NULL
      JOIN public.roles r ON r.id = a.role_id AND r.key IN ('owner', 'admin')
     WHERE m.organisation_id = p_organisation_id AND m.user_id = p_user_id AND m.status = 'active')
$$;

-- ---------------------------------------------------------------------------
-- 4. Break-glass members
-- ---------------------------------------------------------------------------
CREATE TABLE public.sso_break_glass_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  added_at timestamptz NOT NULL DEFAULT now(),
  added_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  ended_at timestamptz,
  ended_by uuid REFERENCES auth.users (id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX sso_break_glass_members_live_key ON public.sso_break_glass_members (organisation_id, user_id) WHERE ended_at IS NULL;
CREATE INDEX sso_break_glass_members_org_idx ON public.sso_break_glass_members (organisation_id);
ALTER TABLE public.sso_break_glass_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY sso_break_glass_members_select ON public.sso_break_glass_members FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'security.read'));
REVOKE ALL ON public.sso_break_glass_members FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.sso_break_glass_members TO authenticated;
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.sso_break_glass_members FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');

CREATE FUNCTION app.sso_break_glass_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Break-glass members are taken off the list, never deleted' USING ERRCODE = 'QM030'; END IF;
  IF OLD.ended_at IS NOT NULL OR NEW.organisation_id <> OLD.organisation_id OR NEW.user_id <> OLD.user_id OR NEW.added_at <> OLD.added_at
     OR NEW.added_by IS DISTINCT FROM OLD.added_by OR NEW.ended_at IS NULL THEN
    RAISE EXCEPTION 'A break-glass entry only ends' USING ERRCODE = 'QM030';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sso_break_glass_members_rules BEFORE UPDATE OR DELETE ON public.sso_break_glass_members FOR EACH ROW EXECUTE FUNCTION app.sso_break_glass_rules();

-- The caller is a break-glass member of the organisation now (on the list AND still an organisation-wide owner or admin).
CREATE FUNCTION app.sso_break_glass(p_organisation_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.sso_break_glass_members b
                  WHERE b.organisation_id = p_organisation_id AND b.user_id = auth.uid() AND b.ended_at IS NULL)
     AND app.sso_owner_or_admin(p_organisation_id, auth.uid())
$$;

-- ---------------------------------------------------------------------------
-- 2. The two halves, and the rule every helper uses
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.two_factor_satisfied(p_organisation_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app.session_aal() = 'aal2'
      OR coalesce((SELECT NOT s.require_mfa OR (s.sso_trust_idp_mfa AND app.sso_session_for(p_organisation_id))
                     FROM public.organisation_settings s WHERE s.organisation_id = p_organisation_id), true)
$$;

CREATE FUNCTION app.sso_satisfied(p_organisation_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce((SELECT s.sso_mode <> 'required' FROM public.organisation_settings s WHERE s.organisation_id = p_organisation_id), true)
      OR app.session_amr() IS NULL
      OR app.sso_session_for(p_organisation_id)
      OR (app.session_aal() = 'aal2' AND app.sso_break_glass(p_organisation_id))
$$;

-- One query for the common case (no requirement): the settings row is read once, and the provider is looked at only when needed.
CREATE OR REPLACE FUNCTION app.mfa_satisfied(p_organisation_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce((
    SELECT (NOT s.require_mfa OR app.session_aal() = 'aal2' OR (s.sso_trust_idp_mfa AND app.sso_session_for(p_organisation_id)))
       AND (s.sso_mode <> 'required' OR app.session_amr() IS NULL OR app.sso_session_for(p_organisation_id)
            OR (app.session_aal() = 'aal2' AND app.sso_break_glass(p_organisation_id)))
      FROM public.organisation_settings s WHERE s.organisation_id = p_organisation_id), true)
$$;

-- Organisations the caller belongs to but cannot use until they pass two-factor (only those where single sign-on is not what blocks them).
CREATE OR REPLACE FUNCTION app.mfa_blocked_organisations()
RETURNS TABLE (organisation_id uuid, name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT o.id, o.name
  FROM public.organisation_users m
  JOIN public.organisations o ON o.id = m.organisation_id AND o.status = 'active'
  WHERE m.user_id = auth.uid() AND m.status = 'active'
    AND NOT app.two_factor_satisfied(o.id) AND app.sso_satisfied(o.id)
  ORDER BY o.name
$$;

-- Organisations the caller belongs to that require their company sign-in, which this session did not use. provider_id = the Supabase provider
-- to sign in with; break_glass = the caller is a break-glass member (they get in with their password and two-factor instead).
CREATE FUNCTION app.sso_blocked_organisations()
RETURNS TABLE (organisation_id uuid, name text, provider_id uuid, break_glass boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT o.id, o.name, p.supabase_provider_id, app.sso_break_glass(o.id)
  FROM public.organisation_users m
  JOIN public.organisations o ON o.id = m.organisation_id AND o.status = 'active'
  LEFT JOIN public.organisation_sso_providers p ON p.organisation_id = o.id AND p.status = 'active'
  WHERE m.user_id = auth.uid() AND m.status = 'active' AND NOT app.sso_satisfied(o.id)
  ORDER BY o.name
$$;

-- How this session signs in to the organisation, for the sign-in record: 'sso' (the organisation's provider), 'break_glass' (required, a
-- break-glass member at aal2 without it), else NULL. Only for a member.
CREATE FUNCTION app.sso_session_method(p_organisation_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE
           WHEN NOT EXISTS (SELECT 1 FROM public.organisation_users m WHERE m.organisation_id = p_organisation_id AND m.user_id = auth.uid() AND m.status = 'active') THEN NULL
           WHEN app.sso_session_for(p_organisation_id) THEN 'sso'
           WHEN app.session_amr() IS NOT NULL AND app.session_aal() = 'aal2' AND app.sso_break_glass(p_organisation_id)
                AND EXISTS (SELECT 1 FROM public.organisation_settings s WHERE s.organisation_id = p_organisation_id AND s.sso_mode = 'required') THEN 'break_glass'
         END
$$;

-- Turning the two-factor requirement on is refused from a session that would not meet it (now also met by a trusted company sign-in).
CREATE OR REPLACE FUNCTION app.guard_require_mfa() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.require_mfa AND NOT OLD.require_mfa AND app.session_aal() <> 'aal2'
     AND NOT (NEW.sso_trust_idp_mfa AND app.sso_session_for(NEW.organisation_id))
     AND coalesce(auth.role(), '') = 'authenticated' THEN
    RAISE EXCEPTION 'Set up two-factor authentication for your own account before requiring it'
      USING ERRCODE = 'QM002';
  END IF;
  RETURN NEW;
END $$;

-- The session limit the guard applies: the stored one, else 12 hours while single sign-on is required (SS9: a leaver's open session ends).
CREATE OR REPLACE FUNCTION app.max_session_hours(p_organisation_id uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(s.max_session_hours, CASE WHEN s.sso_mode = 'required' THEN 12 END) FROM public.organisation_settings s
   WHERE s.organisation_id = p_organisation_id
     AND EXISTS (SELECT 1 FROM public.organisation_users m
                  WHERE m.organisation_id = p_organisation_id AND m.user_id = auth.uid() AND m.status = 'active')
$$;

-- ---------------------------------------------------------------------------
-- 6. The history of changes (and the notices)
-- ---------------------------------------------------------------------------
CREATE TABLE public.sso_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('mode', 'two_factor', 'break_glass_list', 'break_glass_used', 'recovery')),
  from_value text CHECK (from_value IS NULL OR length(from_value) <= 200),
  to_value text CHECK (to_value IS NULL OR length(to_value) <= 200),
  user_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,      -- who changed it, or who used break-glass
  user_name text,
  reason text CHECK (reason IS NULL OR length(reason) <= 1000),
  verification text CHECK (verification IS NULL OR length(verification) <= 1000),
  summary text NOT NULL,
  guidance text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (kind <> 'recovery' OR (reason IS NOT NULL AND verification IS NOT NULL))
);
CREATE INDEX sso_changes_org_idx ON public.sso_changes (organisation_id, created_at DESC);
ALTER TABLE public.sso_changes ENABLE ROW LEVEL SECURITY;
CREATE POLICY sso_changes_select ON public.sso_changes FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'security.read'));
REVOKE ALL ON public.sso_changes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.sso_changes TO authenticated;
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.sso_changes FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');

CREATE FUNCTION app.sso_changes_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'The history of single sign-on changes is never changed or deleted' USING ERRCODE = 'QM030';
END $$;
CREATE TRIGGER sso_changes_frozen BEFORE UPDATE OR DELETE ON public.sso_changes FOR EACH ROW EXECUTE FUNCTION app.sso_changes_frozen();

CREATE FUNCTION app.sso_person_name(p_user_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(nullif(btrim(concat_ws(' ', p.first_name, p.surname)), ''), (SELECT u.email::text FROM auth.users u WHERE u.id = p_user_id))
    FROM (SELECT p_user_id AS id) x LEFT JOIN public.profiles p ON p.id = x.id
$$;

CREATE FUNCTION app.sso_mode_words(p_mode text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE p_mode WHEN 'off' THEN 'off' WHEN 'optional' THEN 'optional (passwords still work)' WHEN 'required' THEN 'required (company sign-in only)' ELSE p_mode END
$$;

-- Every change of the mode or of two-factor trust is written down by this trigger, whoever makes it.
CREATE FUNCTION app.record_sso_settings_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_recovery boolean := current_setting('app.sso_recovery', true) = 'on';
  v_user uuid := auth.uid();
  v_name text := app.sso_person_name(auth.uid());
BEGIN
  IF NEW.sso_mode IS DISTINCT FROM OLD.sso_mode THEN
    INSERT INTO public.sso_changes (organisation_id, kind, from_value, to_value, user_id, user_name, reason, verification, summary, guidance)
    VALUES (NEW.organisation_id, CASE WHEN v_recovery THEN 'recovery' ELSE 'mode' END, OLD.sso_mode, NEW.sso_mode, v_user, v_name,
            CASE WHEN v_recovery THEN nullif(current_setting('app.sso_recovery_reason', true), '') END,
            CASE WHEN v_recovery THEN nullif(current_setting('app.sso_recovery_verification', true), '') END,
            CASE WHEN v_recovery
                 THEN 'Fortress support made single sign-on optional again because nobody could get in: ' || coalesce(current_setting('app.sso_recovery_reason', true), '')
                 ELSE 'Single sign-on is now ' || app.sso_mode_words(NEW.sso_mode) || coalesce(' — changed by ' || v_name, '') END,
            CASE WHEN NEW.sso_mode = 'required'
                 THEN 'Members must sign in with their company account; sessions end after 12 hours unless another limit is set. If the company sign-in stops working, the break-glass members can sign in with their password and two-factor; if even they cannot, an owner can ask Fortress support to make single sign-on optional again.'
                 WHEN v_recovery
                 THEN 'Passwords work again. Check the company sign-in in Settings → Security before requiring it again.'
                 ELSE 'Settings → Security shows the company sign-in, the break-glass members and recent sign-ins.' END);
  END IF;
  IF NEW.sso_trust_idp_mfa IS DISTINCT FROM OLD.sso_trust_idp_mfa THEN
    INSERT INTO public.sso_changes (organisation_id, kind, from_value, to_value, user_id, user_name, summary, guidance)
    VALUES (NEW.organisation_id, 'two_factor', OLD.sso_trust_idp_mfa::text, NEW.sso_trust_idp_mfa::text, v_user, v_name,
            CASE WHEN NEW.sso_trust_idp_mfa
                 THEN 'A company sign-in now meets the two-factor rule' ELSE 'A company sign-in no longer meets the two-factor rule on its own' END
              || coalesce(' — changed by ' || v_name, ''),
            CASE WHEN NEW.sso_trust_idp_mfa
                 THEN 'Your company''s own sign-in checks the second factor.'
                 ELSE 'People who sign in with their company account also need Fortress two-factor while the organisation requires it.' END);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER organisation_settings_sso_history AFTER UPDATE OF sso_mode, sso_trust_idp_mfa ON public.organisation_settings
  FOR EACH ROW EXECUTE FUNCTION app.record_sso_settings_change();

-- ---------------------------------------------------------------------------
-- 3. Modes and two-factor trust
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.set_sso_mode(p_organisation_id uuid, p_mode text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.organisation_settings; p public.organisation_sso_providers;
BEGIN
  PERFORM app.assert_security_manager(p_organisation_id);
  IF p_mode IS NULL OR p_mode NOT IN ('off', 'optional', 'required') THEN RAISE EXCEPTION 'Choose off, optional or required' USING ERRCODE = 'QM030'; END IF;
  SELECT * INTO s FROM public.organisation_settings WHERE organisation_id = p_organisation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
  IF s.sso_mode = p_mode THEN RETURN p_mode; END IF;
  IF p_mode <> 'off' THEN
    SELECT * INTO p FROM public.organisation_sso_providers WHERE organisation_id = p_organisation_id AND status = 'active';
    IF NOT FOUND THEN RAISE EXCEPTION 'Connect your company''s sign-in first' USING ERRCODE = 'QM030'; END IF;
    IF cardinality(p.domains) = 0 THEN RAISE EXCEPTION 'Verify a domain and link it to your company''s sign-in first' USING ERRCODE = 'QM030'; END IF;
  END IF;
  IF p_mode = 'required' AND NOT app.sso_session_for(p_organisation_id) THEN
    RAISE EXCEPTION 'Sign in with your company account first, then require it. That shows the company sign-in works before everyone depends on it.'
      USING ERRCODE = 'QM030';
  END IF;
  UPDATE public.organisation_settings SET sso_mode = p_mode, sso_mode_changed_at = now(), sso_mode_changed_by = auth.uid()
   WHERE organisation_id = p_organisation_id;
  RETURN p_mode;
END $$;

CREATE FUNCTION app.set_sso_trust_idp_mfa(p_organisation_id uuid, p_trust boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.organisation_settings;
BEGIN
  PERFORM app.assert_security_manager(p_organisation_id);
  IF p_trust IS NULL THEN RAISE EXCEPTION 'Choose on or off' USING ERRCODE = 'QM030'; END IF;
  SELECT * INTO s FROM public.organisation_settings WHERE organisation_id = p_organisation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
  IF s.sso_trust_idp_mfa = p_trust THEN RETURN p_trust; END IF;
  -- Switching trust off must not lock the caller out: with two-factor required, their own session must pass it without the company sign-in.
  IF NOT p_trust AND s.require_mfa AND app.session_aal() <> 'aal2' THEN
    RAISE EXCEPTION 'Set up two-factor authentication for your own account first: with this off, your company sign-in alone no longer meets the two-factor rule'
      USING ERRCODE = 'QM030';
  END IF;
  UPDATE public.organisation_settings SET sso_trust_idp_mfa = p_trust WHERE organisation_id = p_organisation_id;
  RETURN p_trust;
END $$;

-- Replaces the break-glass list as a whole. At most three; organisation-wide owners or admins who are active members.
CREATE FUNCTION app.set_sso_break_glass(p_organisation_id uuid, p_user_ids uuid[]) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v uuid[] := '{}'; u uuid; v_before text; v_after text; v_name text := app.sso_person_name(auth.uid());
BEGIN
  PERFORM app.assert_security_manager(p_organisation_id);
  FOREACH u IN ARRAY coalesce(p_user_ids, '{}') LOOP
    IF u IS NOT NULL AND NOT u = ANY (v) THEN v := v || u; END IF;
  END LOOP;
  IF cardinality(v) > 3 THEN RAISE EXCEPTION 'At most three break-glass members' USING ERRCODE = 'QM030'; END IF;
  FOREACH u IN ARRAY v LOOP
    IF NOT app.sso_owner_or_admin(p_organisation_id, u) THEN
      RAISE EXCEPTION 'Only owners and admins can be break-glass members (%)', coalesce(app.sso_person_name(u), 'that person') USING ERRCODE = 'QM030';
    END IF;
  END LOOP;
  PERFORM 1 FROM public.organisation_settings WHERE organisation_id = p_organisation_id FOR UPDATE;
  SELECT string_agg(coalesce(app.sso_person_name(b.user_id), '?'), ', ' ORDER BY b.added_at) INTO v_before
    FROM public.sso_break_glass_members b WHERE b.organisation_id = p_organisation_id AND b.ended_at IS NULL;
  UPDATE public.sso_break_glass_members SET ended_at = now(), ended_by = auth.uid()
   WHERE organisation_id = p_organisation_id AND ended_at IS NULL AND NOT user_id = ANY (v);
  INSERT INTO public.sso_break_glass_members (organisation_id, user_id, added_by)
  SELECT p_organisation_id, x, auth.uid() FROM unnest(v) x
   WHERE NOT EXISTS (SELECT 1 FROM public.sso_break_glass_members b WHERE b.organisation_id = p_organisation_id AND b.user_id = x AND b.ended_at IS NULL);
  SELECT string_agg(coalesce(app.sso_person_name(b.user_id), '?'), ', ' ORDER BY b.added_at) INTO v_after
    FROM public.sso_break_glass_members b WHERE b.organisation_id = p_organisation_id AND b.ended_at IS NULL;
  IF v_before IS DISTINCT FROM v_after THEN
    INSERT INTO public.sso_changes (organisation_id, kind, from_value, to_value, user_id, user_name, summary, guidance)
    VALUES (p_organisation_id, 'break_glass_list', left(v_before, 200), left(v_after, 200), auth.uid(), v_name,
            'Break-glass members are now ' || coalesce(v_after, 'nobody') || coalesce(' — changed by ' || v_name, ''),
            'Break-glass members may sign in with their password and two-factor while single sign-on is required. Every such sign-in is told to owners and admins.');
  END IF;
  RETURN cardinality(v);
END $$;

-- ---------------------------------------------------------------------------
-- 5. Sign-ins
-- ---------------------------------------------------------------------------
CREATE TABLE public.sso_sign_ins (
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  method text NOT NULL CHECK (method IN ('sso', 'break_glass')),
  hour timestamptz NOT NULL,
  count integer NOT NULL DEFAULT 1 CHECK (count > 0),
  first_at timestamptz NOT NULL DEFAULT now(),
  last_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, user_id, method, hour)
);
CREATE INDEX sso_sign_ins_org_idx ON public.sso_sign_ins (organisation_id, last_at DESC);
ALTER TABLE public.sso_sign_ins ENABLE ROW LEVEL SECURITY;
CREATE POLICY sso_sign_ins_select ON public.sso_sign_ins FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'security.read'));
REVOKE ALL ON public.sso_sign_ins FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.sso_sign_ins TO authenticated;

-- The API login records a request made through the company sign-in or break-glass; the first break-glass use in an hour is written down as a
-- change (and so told to owners and admins). Returns true when it was the first of that hour.
CREATE FUNCTION app.system_record_sso_sign_in(p_organisation_id uuid, p_user_id uuid, p_method text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_first boolean; v_name text;
BEGIN
  IF p_method NOT IN ('sso', 'break_glass') THEN RAISE EXCEPTION 'Unknown sign-in method' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.sso_sign_ins AS s (organisation_id, user_id, method, hour)
  VALUES (p_organisation_id, p_user_id, p_method, date_trunc('hour', now()))
  ON CONFLICT (organisation_id, user_id, method, hour) DO UPDATE SET count = s.count + 1, last_at = now()
  RETURNING (xmax = 0) INTO v_first;
  IF v_first AND p_method = 'break_glass' THEN
    v_name := app.sso_person_name(p_user_id);
    INSERT INTO public.sso_changes (organisation_id, kind, user_id, user_name, summary, guidance)
    VALUES (p_organisation_id, 'break_glass_used', p_user_id, v_name,
            coalesce(v_name, 'A break-glass member') || ' signed in with a password and two-factor instead of the company sign-in',
            'Break-glass is for when the company sign-in does not work. If you did not expect this, check Settings → Security and the person''s account.');
  END IF;
  RETURN v_first;
END $$;

-- Housekeeping: sign-in rows older than 90 days.
CREATE FUNCTION app.system_purge_sso_sign_ins() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n integer;
BEGIN
  DELETE FROM public.sso_sign_ins WHERE hour < now() - interval '90 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- Members who do not sign in with the company account (password accounts), for the screen before requiring it: they will be blocked
-- unless they are break-glass members.
CREATE FUNCTION app.sso_password_members(p_organisation_id uuid)
RETURNS TABLE (user_id uuid, name text, email text, break_glass boolean, owner_or_admin boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT app.has_permission(p_organisation_id, 'security.read') THEN RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501'; END IF;
  RETURN QUERY
  SELECT m.user_id, app.sso_person_name(m.user_id), u.email::text,
         EXISTS (SELECT 1 FROM public.sso_break_glass_members b WHERE b.organisation_id = p_organisation_id AND b.user_id = m.user_id AND b.ended_at IS NULL),
         app.sso_owner_or_admin(p_organisation_id, m.user_id)
    FROM public.organisation_users m
    JOIN auth.users u ON u.id = m.user_id
   WHERE m.organisation_id = p_organisation_id AND m.status = 'active' AND NOT coalesce(u.is_sso_user, false)
   ORDER BY 2, 3;
END $$;

-- ---------------------------------------------------------------------------
-- 7. What single sign-on depends on
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.remove_sso_domain(p_domain_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE d public.organisation_sso_domains; v_reason text := btrim(coalesce(p_reason, '')); v_mode text;
BEGIN
  SELECT * INTO d FROM public.organisation_sso_domains WHERE id = p_domain_id FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(d.organisation_id) THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_security_manager(d.organisation_id);
  IF d.removed_at IS NOT NULL THEN RAISE EXCEPTION 'That domain was already removed' USING ERRCODE = 'QM030'; END IF;
  IF length(v_reason) < 3 OR length(v_reason) > 500 THEN RAISE EXCEPTION 'Say why the domain is being removed (3 to 500 characters)' USING ERRCODE = 'QM030'; END IF;
  SELECT s.sso_mode INTO v_mode FROM public.organisation_settings s WHERE s.organisation_id = d.organisation_id FOR UPDATE;
  IF d.verified_at IS NOT NULL AND v_mode <> 'off' THEN
    RAISE EXCEPTION 'People sign in through this domain: switch single sign-on off before removing it' USING ERRCODE = 'QM030';
  END IF;
  UPDATE public.organisation_sso_domains
     SET removed_at = now(), removed_by = auth.uid(), removed_reason = v_reason, verified_at = NULL, verified_by = NULL
   WHERE id = p_domain_id;
END $$;

CREATE OR REPLACE FUNCTION app.system_sso_disable_provider(p_provider_id uuid, p_actor uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_reason text := btrim(coalesce(p_reason, '')); v_org uuid;
BEGIN
  IF length(v_reason) < 3 OR length(v_reason) > 500 THEN
    RAISE EXCEPTION 'Say why single sign-on is being switched off (3 to 500 characters)' USING ERRCODE = 'QM030';
  END IF;
  SELECT organisation_id INTO v_org FROM public.organisation_sso_providers WHERE id = p_provider_id AND status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
  IF EXISTS (SELECT 1 FROM public.organisation_settings s WHERE s.organisation_id = v_org AND s.sso_mode <> 'off') THEN
    RAISE EXCEPTION 'Switch single sign-on off before disconnecting your company''s sign-in' USING ERRCODE = 'QM030';
  END IF;
  UPDATE public.organisation_sso_providers
     SET status = 'disabled', disabled_at = now(), disabled_by = p_actor, disabled_reason = v_reason, updated_at = now(), updated_by = p_actor
   WHERE id = p_provider_id AND status = 'active';
END $$;

-- The organisation's single sign-on mode, for the API (also the invitation mailer, which runs as the inviter).
CREATE FUNCTION app.system_sso_mode(p_organisation_id uuid)
RETURNS TABLE (mode text, provider_id uuid, domains text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT s.sso_mode, p.supabase_provider_id, app.sso_verified_domains(p_organisation_id)
    FROM public.organisation_settings s
    LEFT JOIN public.organisation_sso_providers p ON p.organisation_id = s.organisation_id AND p.status = 'active'
   WHERE s.organisation_id = p_organisation_id
$$;

-- An address at one of the organisation's verified single sign-on domains (or a sub-domain of one).
CREATE FUNCTION app.sso_email_covered(p_organisation_id uuid, p_email text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH e AS (SELECT lower(split_part(btrim(coalesce(p_email, '')), '@', 2)) AS dom)
  SELECT EXISTS (SELECT 1 FROM e, unnest(app.sso_verified_domains(p_organisation_id)) a WHERE e.dom = a OR e.dom LIKE '%.' || a)
$$;

CREATE FUNCTION app.invitation_sso_domain_rule() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.status <> 'invited' OR NEW.invited_email IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'invited' AND OLD.invited_email IS NOT DISTINCT FROM NEW.invited_email THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM public.organisation_settings s WHERE s.organisation_id = NEW.organisation_id AND s.sso_mode = 'required')
     AND NOT app.sso_email_covered(NEW.organisation_id, NEW.invited_email) THEN
    RAISE EXCEPTION 'This organisation requires single sign-on, so it only invites addresses at %',
      coalesce(nullif(array_to_string(app.sso_verified_domains(NEW.organisation_id), ', '), ''), 'its verified domains') USING ERRCODE = 'QM015';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER organisation_users_sso_domain BEFORE INSERT OR UPDATE OF status, invited_email ON public.organisation_users
  FOR EACH ROW EXECUTE FUNCTION app.invitation_sso_domain_rule();

-- ---------------------------------------------------------------------------
-- 8. The operator's recovery
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.platform_recover_sso(p_organisation_id uuid, p_reason text, p_verification text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_mode text; v_reason text := btrim(coalesce(p_reason, '')); v_verification text := btrim(coalesce(p_verification, '')); v_id uuid;
BEGIN
  IF NOT app.is_platform_admin() THEN RAISE EXCEPTION 'Platform administrators only' USING ERRCODE = '42501'; END IF;
  SELECT s.sso_mode INTO v_mode FROM public.organisation_settings s WHERE s.organisation_id = p_organisation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Organisation not found' USING ERRCODE = 'P0002'; END IF;
  IF v_mode <> 'required' THEN RAISE EXCEPTION 'This organisation does not require single sign-on, so there is nothing to recover' USING ERRCODE = 'QM030'; END IF;
  IF length(v_reason) < 10 OR length(v_reason) > 1000 THEN RAISE EXCEPTION 'Say why access is being recovered (10 to 1000 characters)' USING ERRCODE = 'QM030'; END IF;
  IF length(v_verification) < 10 OR length(v_verification) > 1000 THEN RAISE EXCEPTION 'Say how you checked the request came from an owner (10 to 1000 characters)' USING ERRCODE = 'QM030'; END IF;
  PERFORM set_config('app.sso_recovery', 'on', true);
  PERFORM set_config('app.sso_recovery_reason', v_reason, true);
  PERFORM set_config('app.sso_recovery_verification', v_verification, true);
  UPDATE public.organisation_settings SET sso_mode = 'optional', sso_mode_changed_at = now(), sso_mode_changed_by = auth.uid()
   WHERE organisation_id = p_organisation_id;
  PERFORM set_config('app.sso_recovery', 'off', true);
  SELECT c.id INTO v_id FROM public.sso_changes c WHERE c.organisation_id = p_organisation_id ORDER BY c.created_at DESC, c.id DESC LIMIT 1;
  RETURN v_id;
END $$;

CREATE FUNCTION app.platform_sso_modes(p_organisation_ids uuid[])
RETURNS TABLE (organisation_id uuid, sso_mode text, connected boolean, changed_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT app.is_platform_admin() THEN RAISE EXCEPTION 'Platform administrators only' USING ERRCODE = '42501'; END IF;
  RETURN QUERY SELECT s.organisation_id, s.sso_mode,
                      EXISTS (SELECT 1 FROM public.organisation_sso_providers p WHERE p.organisation_id = s.organisation_id AND p.status = 'active'),
                      s.sso_mode_changed_at
                 FROM public.organisation_settings s WHERE s.organisation_id = ANY (coalesce(p_organisation_ids, '{}'));
END $$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app.session_amr(), app.sso_session_for(uuid), app.sso_owner_or_admin(uuid, uuid), app.sso_break_glass_rules(),
  app.sso_break_glass(uuid), app.two_factor_satisfied(uuid), app.sso_satisfied(uuid), app.sso_blocked_organisations(), app.sso_session_method(uuid),
  app.sso_changes_frozen(), app.sso_person_name(uuid), app.sso_mode_words(text), app.record_sso_settings_change(), app.set_sso_mode(uuid, text),
  app.set_sso_trust_idp_mfa(uuid, boolean), app.set_sso_break_glass(uuid, uuid[]), app.system_record_sso_sign_in(uuid, uuid, text),
  app.system_purge_sso_sign_ins(), app.sso_password_members(uuid), app.system_sso_mode(uuid), app.sso_email_covered(uuid, text),
  app.invitation_sso_domain_rule(), app.platform_recover_sso(uuid, text, text), app.platform_sso_modes(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.session_amr(), app.sso_session_for(uuid), app.sso_break_glass(uuid), app.two_factor_satisfied(uuid), app.sso_satisfied(uuid),
  app.sso_blocked_organisations(), app.sso_session_method(uuid), app.set_sso_mode(uuid, text), app.set_sso_trust_idp_mfa(uuid, boolean),
  app.set_sso_break_glass(uuid, uuid[]), app.sso_password_members(uuid), app.platform_recover_sso(uuid, text, text), app.platform_sso_modes(uuid[])
  TO authenticated;
-- The API login's own work (it has USAGE on the app schema).
GRANT EXECUTE ON FUNCTION app.system_record_sso_sign_in(uuid, uuid, text), app.system_purge_sso_sign_ins(), app.system_sso_mode(uuid) TO qms_api;

-- ---------------------------------------------------------------------------
-- Notices to owners and admins
-- ---------------------------------------------------------------------------
INSERT INTO public.notification_event_types
  (key, entity_type, action, group_name, entity_label, description, permission_code, default_on, default_permission_code, label_fields, display_order, own_record, email_default)
VALUES
  ('sso_changes.created', 'sso_changes', 'created', 'Security', 'Single sign-on', 'Single sign-on changed',
   'security.read', true, NULL, ARRAY['summary', 'guidance'], 2, false, true);

-- The notification trigger: the 20260303100000_network_policy_recovery.sql version, with sso_changes among the notices that have no actor (so the
-- person who changed single sign-on, or used break-glass, is told too).
CREATE OR REPLACE FUNCTION app.emit_notification() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_action text;
  v_type public.notification_event_types%ROWTYPE;
  v_row jsonb := coalesce(NEW.new_values, NEW.previous_values);
  v_what text;
  v_body text;
  v_details jsonb;
  v_recipient uuid;
  v_capa_row jsonb;
  v_comp_row jsonb;
  v_doc_row jsonb;
  v_risk_row jsonb;
  v_mr_row jsonb;
BEGIN
  -- A recipient row also changes when they view or acknowledge: only the withdrawal notice is worth a notification.
  IF NEW.entity_type = 'quality_alert_recipients' AND NEW.action = 'update' AND NOT (coalesce(NEW.changed_fields, '{}') @> ARRAY['withdrawn_notified_at']) THEN
    RETURN NULL;
  END IF;

  -- An 8D action notifies the person it is assigned to, when it is added with someone on it or handed to someone else; nothing else about it does.
  IF NEW.entity_type = 'capa_actions' AND (NEW.action = 'delete' OR (NEW.action = 'update' AND NOT (coalesce(NEW.changed_fields, '{}') @> ARRAY['owner_team_member_id']))) THEN
    RETURN NULL;
  END IF;

  -- An assessment is announced once, when it is made; superseding the earlier one is not news.
  IF NEW.entity_type = 'competence_assessments' AND NEW.action <> 'insert' THEN
    RETURN NULL;
  END IF;

  -- A sign-off, or a document to read, is announced to its person when it is created; their own view, decision or acknowledgement is not news to them.
  IF NEW.entity_type IN ('document_signoffs', 'document_recipients') AND NEW.action <> 'insert' THEN
    RETURN NULL;
  END IF;

  -- A change request is news to the person who asked only when it is accepted or declined.
  IF NEW.entity_type = 'document_change_requests' AND NOT (NEW.action = 'update' AND NEW.new_values ->> 'status' IN ('accepted', 'declined')) THEN
    RETURN NULL;
  END IF;

  -- A risk action is news to the person it is given to, when it is added or handed to them; a risk to its owner, likewise. Nothing else about either is.
  IF NEW.entity_type IN ('risk_actions', 'risks', 'management_review_actions') AND (NEW.action = 'delete' OR (NEW.action = 'update' AND NOT (coalesce(NEW.changed_fields, '{}') @> ARRAY['owner_user_id']))) THEN
    RETURN NULL;
  END IF;

  -- Reminders, workflow notices and workflow tasks are announced once, when written (a task's own progress is not news to its person).
  IF NEW.entity_type IN ('reminder_digests', 'reminder_overdue_notices', 'workflow_notices', 'workflow_tasks') AND NEW.action <> 'insert' THEN
    RETURN NULL;
  END IF;

  v_action := CASE
    WHEN NEW.action = 'insert' THEN 'created'
    WHEN NEW.action = 'delete' THEN 'deleted'
    WHEN NEW.changed_fields @> ARRAY['deleted_at'] AND NEW.new_values ->> 'deleted_at' IS NOT NULL THEN 'deleted'
    ELSE 'updated' END;

  SELECT * INTO v_type FROM public.notification_event_types t WHERE t.entity_type = NEW.entity_type AND t.action = v_action;
  IF NOT FOUND THEN RETURN NULL; END IF;

  v_row := coalesce(NEW.previous_values, '{}'::jsonb) || coalesce(NEW.new_values, '{}'::jsonb);
  IF NEW.action = 'insert' THEN v_row := NEW.new_values; END IF;
  IF NEW.action = 'delete' THEN v_row := NEW.previous_values; END IF;
  -- An update records only what changed; a recipient notice needs the person and the alert too.
  IF NEW.entity_type = 'quality_alert_recipients' AND NEW.action = 'update' THEN
    v_row := coalesce((SELECT to_jsonb(r) FROM public.quality_alert_recipients r WHERE r.id = NEW.entity_id::uuid), '{}'::jsonb) || v_row;
  END IF;

  IF NEW.entity_type = 'capa_actions' THEN
    SELECT to_jsonb(a) || jsonb_build_object('capa_reference', c.reference, 'capa_title', c.title, 'user_id', m.user_id)
      INTO v_capa_row
      FROM public.capa_actions a
      JOIN public.capas c ON c.id = a.capa_id
      LEFT JOIN public.capa_team_members t ON t.id = a.owner_team_member_id
      LEFT JOIN public.organisation_users m ON m.id = t.membership_id
     WHERE a.id = NEW.entity_id::uuid;
    IF v_capa_row IS NULL OR v_capa_row ->> 'user_id' IS NULL THEN RETURN NULL; END IF;
    v_row := v_capa_row;
  END IF;

  -- An assessment tells the person assessed (their linked sign-in) the skill and the level; nobody else, and no one without a sign-in.
  IF NEW.entity_type = 'competence_assessments' THEN
    SELECT to_jsonb(a) || jsonb_build_object(
             'user_id', e.auth_id, 'skill_name', k.name,
             'level_label', CASE a.level WHEN 0 THEN 'None' WHEN 1 THEN 'Learning' WHEN 2 THEN 'Supervised' WHEN 3 THEN 'Competent' ELSE 'Can train others' END || ' (' || a.level || ')')
      INTO v_comp_row
      FROM public.competence_assessments a
      JOIN public."Employees" e ON e.id = a.employee_id AND e.organisation_id = a.organisation_id
      JOIN public.competence_skills k ON k.id = a.skill_id
     WHERE a.id = NEW.entity_id::uuid;
    IF v_comp_row IS NULL OR v_comp_row ->> 'user_id' IS NULL THEN RETURN NULL; END IF;
    v_row := v_comp_row;
  END IF;

  -- A sign-off tells its reviewer or approver which document (number, letter and title) and what is asked of them.
  IF NEW.entity_type = 'document_signoffs' THEN
    SELECT to_jsonb(s) || jsonb_build_object(
             'document_id', d.id, 'revision_id', r.id,
             'document_label', d.number || ' rev ' || coalesce(r.letter, '?') || ' · ' || d.title,
             'role_label', CASE s.role WHEN 'reviewer' THEN 'Review it' ELSE 'Approve it' END)
      INTO v_doc_row
      FROM public.document_signoffs s
      JOIN public.document_revisions r ON r.id = s.revision_id
      JOIN public.documents d ON d.id = r.document_id
     WHERE s.id = NEW.entity_id::uuid;
    IF v_doc_row IS NULL THEN RETURN NULL; END IF;
    v_row := v_doc_row;
  END IF;

  -- A document to read tells its reader which revision and by when.
  IF NEW.entity_type = 'document_recipients' THEN
    SELECT to_jsonb(x) || jsonb_build_object(
             'document_id', d.id, 'revision_id', r.id,
             'document_label', d.number || ' rev ' || coalesce(r.letter, '?') || ' · ' || d.title,
             'due_label', CASE WHEN x.due_on IS NULL THEN NULL ELSE 'Acknowledge by ' || to_char(x.due_on, 'FMDD Mon YYYY') END)
      INTO v_doc_row
      FROM public.document_recipients x
      JOIN public.document_revisions r ON r.id = x.revision_id
      JOIN public.documents d ON d.id = r.document_id
     WHERE x.id = NEW.entity_id::uuid;
    IF v_doc_row IS NULL THEN RETURN NULL; END IF;
    v_row := v_doc_row;
  END IF;

  -- A decided change request tells the person who asked: which request, for which document, and the decision (with the reason when declined).
  IF NEW.entity_type = 'document_change_requests' THEN
    SELECT to_jsonb(c) || jsonb_build_object(
             'user_id', c.requested_by, 'document_id', d.id, 'revision_id', c.revision_id,
             'request_label', c.reference || ' · ' || d.number || ' ' || d.title,
             'decision_label', CASE c.status WHEN 'accepted' THEN 'Accepted: a revision is being written' ELSE 'Declined: ' || coalesce(c.decision_reason, '') END)
      INTO v_doc_row
      FROM public.document_change_requests c
      JOIN public.documents d ON d.id = c.document_id
     WHERE c.id = NEW.entity_id::uuid;
    IF v_doc_row IS NULL THEN RETURN NULL; END IF;
    v_row := v_doc_row;
  END IF;

  -- A risk action tells its person which risk, what to do and by when; a risk tells its new owner which one.
  IF NEW.entity_type = 'risk_actions' THEN
    SELECT to_jsonb(a) || jsonb_build_object(
             'user_id', a.owner_user_id, 'risk_id', r.id, 'risk_label', r.reference || ' · ' || r.title,
             'due_label', CASE WHEN a.due_date IS NULL THEN NULL ELSE 'Due ' || to_char(a.due_date, 'FMDD Mon YYYY') END)
      INTO v_risk_row
      FROM public.risk_actions a JOIN public.risks r ON r.id = a.risk_id
     WHERE a.id = NEW.entity_id::uuid AND a.status = 'open';
    -- Given to yourself: the notice would be for the person who did it, who is never told of their own action.
    IF v_risk_row IS NULL OR (v_risk_row ->> 'user_id')::uuid IS NOT DISTINCT FROM NEW.actor_user_id THEN RETURN NULL; END IF;
    v_row := v_risk_row;
  END IF;
  IF NEW.entity_type = 'risks' THEN
    SELECT to_jsonb(r) || jsonb_build_object('user_id', r.owner_user_id, 'risk_id', r.id, 'risk_label', r.reference || ' · ' || r.title,
             'kind_label', CASE r.kind WHEN 'opportunity' THEN 'Opportunity' ELSE 'Risk' END)
      INTO v_risk_row
      FROM public.risks r
     WHERE r.id = NEW.entity_id::uuid AND r.status NOT IN ('closed', 'retired');
    IF v_risk_row IS NULL OR (v_risk_row ->> 'user_id')::uuid IS NOT DISTINCT FROM NEW.actor_user_id THEN RETURN NULL; END IF;
    v_row := v_risk_row;
  END IF;

  -- A management review action tells its person which review, what to do and by when (they may hold no management review permission: own_record).
  IF NEW.entity_type = 'management_review_actions' THEN
    SELECT to_jsonb(a) || jsonb_build_object(
             'user_id', a.owner_user_id, 'review_id', m.id, 'review_label', m.reference || ' · ' || m.title,
             'due_label', CASE WHEN a.due_date IS NULL THEN NULL ELSE 'Due ' || to_char(a.due_date, 'FMDD Mon YYYY') END)
      INTO v_mr_row
      FROM public.management_review_actions a JOIN public.management_reviews m ON m.id = a.review_id
     WHERE a.id = NEW.entity_id::uuid AND a.status = 'open';
    IF v_mr_row IS NULL OR (v_mr_row ->> 'user_id')::uuid IS NOT DISTINCT FROM NEW.actor_user_id THEN RETURN NULL; END IF;
    v_row := v_mr_row;
  END IF;

  -- An overdue notice says what and since when; the area and the record behind it lead the link.
  IF NEW.entity_type = 'reminder_overdue_notices' THEN
    v_row := v_row || jsonb_build_object('due_label', 'Was due ' || to_char((v_row ->> 'due_on')::date, 'FMDD Mon YYYY'));
  END IF;

  -- A workflow task goes to its person (user_id) with when it is due; a workflow notice already names its person.
  IF NEW.entity_type = 'workflow_tasks' THEN
    v_row := v_row || jsonb_build_object('user_id', v_row ->> 'assignee_user_id', 'task_id', v_row ->> 'id',
                                         'due_label', CASE WHEN v_row ->> 'due_on' IS NULL THEN NULL ELSE 'Due ' || to_char((v_row ->> 'due_on')::date, 'FMDD Mon YYYY') END);
  END IF;

  v_body := nullif(concat_ws(' — ', VARIADIC (
    SELECT coalesce(array_agg(nullif(v_row ->> f, '') ORDER BY ord), '{}') FROM unnest(v_type.label_fields) WITH ORDINALITY AS u(f, ord))), '');
  IF v_action = 'updated' AND NEW.changed_fields IS NOT NULL
     AND NEW.entity_type NOT IN ('quality_alert_recipients', 'capa_actions', 'competence_assessments', 'document_signoffs', 'document_recipients', 'document_change_requests', 'risk_actions', 'risks', 'management_review_actions') THEN
    v_what := 'Changed: ' || replace(array_to_string(NEW.changed_fields, ', '), '_', ' ');
    v_body := concat_ws('. ', v_body, left(v_what, 200));
  END IF;

  SELECT coalesce(jsonb_object_agg(k, v_row -> k), '{}'::jsonb) INTO v_details
    FROM unnest(ARRAY['site_id', 'gauge_id', 'control_plan_id', 'part_id', 'source', 'stage', 'status', 'alert_id', 'capa_id', 'connection_id', 'run_id', 'kind',
                      'document_id', 'revision_id', 'role', 'risk_id', 'review_id', 'area', 'target_id', 'record_kind', 'record_id', 'task_id']) k
   WHERE v_row ->> k IS NOT NULL;

  -- Notices about one person's own alerts are for that person only.
  IF NEW.entity_type IN ('quality_alert_recipients', 'capa_actions', 'competence_assessments', 'document_signoffs', 'document_recipients', 'document_change_requests', 'risk_actions', 'risks', 'management_review_actions',
                         'reminder_digests', 'reminder_overdue_notices', 'workflow_notices', 'workflow_tasks') THEN
    v_recipient := (v_row ->> 'user_id')::uuid;
  END IF;

  INSERT INTO public.notifications (organisation_id, event_type_id, audit_event_id, entity_type, entity_id, title, body, details, actor_user_id, recipient_user_id)
  VALUES (NEW.organisation_id, v_type.id, NEW.id, NEW.entity_type, NEW.entity_id, v_type.description, v_body, v_details,
          CASE WHEN NEW.entity_type IN ('integration_alerts', 'document_recipients', 'reminder_digests', 'reminder_overdue_notices', 'workflow_notices', 'workflow_tasks', 'network_policy_changes', 'sso_changes') THEN NULL ELSE NEW.actor_user_id END,
          v_recipient)
  ON CONFLICT (audit_event_id) DO NOTHING;
  RETURN NULL;
END $$;
