-- Organisation security SE6 (docs/security-plan.md, decision S11): the "who" rules beside the network rule.
--
-- 1. Allowed email domains: invitations only to the organisation's own domains (an entry also allows its sub-domains). Empty = anyone. Enforced by a
--    trigger on organisation_users, so every way of inviting (one, many, a removed member invited again) obeys it. Members already outside the
--    domains are listed for the owners, never removed.
-- 2. Maximum session age: people sign in again after N hours (1 to 720). The API checks it in OrganisationGuard from the sign-in time in the token
--    (its amr claim) and answers 401 reauthentication_required; app.max_session_hours(org) gives the guard the setting.
-- Both are changed only by functions with security.manage, and audited through organisation_settings.

ALTER TABLE public.organisation_settings
  ADD COLUMN allowed_email_domains text[] NOT NULL DEFAULT '{}' CHECK (cardinality(allowed_email_domains) <= 20),
  ADD COLUMN max_session_hours integer CHECK (max_session_hours IS NULL OR max_session_hours BETWEEN 1 AND 720);
-- Deliberately no column UPDATE grant: only the functions below change these.

-- An email domain as people type it ("@Acme.com ", "acme.co.uk") → "acme.com", or an error saying what is wrong.
CREATE FUNCTION app.normalise_email_domain(p_domain text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v text := lower(btrim(coalesce(p_domain, '')));
BEGIN
  v := regexp_replace(v, '^@', '');
  IF v = '' THEN RAISE EXCEPTION 'Type a domain such as acme.com' USING ERRCODE = 'QM029'; END IF;
  IF length(v) > 253 OR v !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' THEN
    RAISE EXCEPTION '"%" is not an email domain (for example acme.com)', left(p_domain, 80) USING ERRCODE = 'QM029';
  END IF;
  RETURN v;
END $$;

-- Whether an address may be invited: the list is empty, or the address's domain is an entry or a sub-domain of one.
CREATE FUNCTION app.email_domain_allowed(p_organisation_id uuid, p_email text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH s AS (SELECT allowed_email_domains AS d FROM public.organisation_settings WHERE organisation_id = p_organisation_id),
       e AS (SELECT lower(split_part(btrim(coalesce(p_email, '')), '@', 2)) AS dom)
  SELECT coalesce((SELECT cardinality(d) = 0 FROM s), true)
      OR EXISTS (SELECT 1 FROM s, e, unnest(s.d) a WHERE e.dom = a OR e.dom LIKE '%.' || a)
$$;

CREATE FUNCTION app.invitation_email_domain_rule() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_domains text[];
BEGIN
  IF NEW.status <> 'invited' OR NEW.invited_email IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'invited' AND OLD.invited_email IS NOT DISTINCT FROM NEW.invited_email THEN RETURN NEW; END IF;
  IF NOT app.email_domain_allowed(NEW.organisation_id, NEW.invited_email) THEN
    SELECT allowed_email_domains INTO v_domains FROM public.organisation_settings WHERE organisation_id = NEW.organisation_id;
    RAISE EXCEPTION 'This organisation only invites addresses at %', array_to_string(v_domains, ', ') USING ERRCODE = 'QM015';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER organisation_users_email_domain BEFORE INSERT OR UPDATE OF status, invited_email ON public.organisation_users
  FOR EACH ROW EXECUTE FUNCTION app.invitation_email_domain_rule();

-- ---------------------------------------------------------------------------
-- Changing the rules (security.manage)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.set_allowed_email_domains(p_organisation_id uuid, p_domains text[]) RETURNS text[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v text[] := '{}'; d text; n text;
BEGIN
  PERFORM app.assert_security_manager(p_organisation_id);
  FOREACH d IN ARRAY coalesce(p_domains, '{}') LOOP
    n := app.normalise_email_domain(d);
    IF NOT n = ANY (v) THEN v := v || n; END IF;
  END LOOP;
  IF cardinality(v) > 20 THEN RAISE EXCEPTION 'At most 20 email domains' USING ERRCODE = 'QM029'; END IF;
  UPDATE public.organisation_settings SET allowed_email_domains = v WHERE organisation_id = p_organisation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
  RETURN v;
END $$;

CREATE FUNCTION app.set_max_session_hours(p_organisation_id uuid, p_hours integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.assert_security_manager(p_organisation_id);
  IF p_hours IS NOT NULL AND (p_hours < 1 OR p_hours > 720) THEN
    RAISE EXCEPTION 'Choose between 1 hour and 30 days (720 hours), or no limit' USING ERRCODE = 'QM029';
  END IF;
  UPDATE public.organisation_settings SET max_session_hours = p_hours WHERE organisation_id = p_organisation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
  RETURN p_hours;
END $$;

-- ---------------------------------------------------------------------------
-- Reading
-- ---------------------------------------------------------------------------
-- The session limit for the guard: only for a member of the organisation (NULL for anyone else, and when there is no limit).
CREATE FUNCTION app.max_session_hours(p_organisation_id uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT s.max_session_hours FROM public.organisation_settings s
   WHERE s.organisation_id = p_organisation_id
     AND EXISTS (SELECT 1 FROM public.organisation_users m
                  WHERE m.organisation_id = p_organisation_id AND m.user_id = auth.uid() AND m.status = 'active')
$$;

-- Active and invited members whose address is outside the allowed domains (listed for the owners; nobody is removed).
CREATE FUNCTION app.members_outside_email_domains(p_organisation_id uuid)
RETURNS TABLE (membership_id uuid, user_id uuid, name text, email text, status text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT app.has_permission(p_organisation_id, 'security.read') THEN RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501'; END IF;
  RETURN QUERY
  SELECT m.id, m.user_id, nullif(btrim(concat_ws(' ', p.first_name, p.surname)), ''), coalesce(u.email::text, m.invited_email), m.status
    FROM public.organisation_users m
    LEFT JOIN auth.users u ON u.id = m.user_id
    LEFT JOIN public.profiles p ON p.id = m.user_id
   WHERE m.organisation_id = p_organisation_id AND m.status IN ('active', 'invited')
     AND NOT app.email_domain_allowed(p_organisation_id, coalesce(u.email::text, m.invited_email))
   ORDER BY m.status, lower(coalesce(u.email::text, m.invited_email));
END $$;

REVOKE ALL ON FUNCTION app.normalise_email_domain(text), app.email_domain_allowed(uuid, text), app.invitation_email_domain_rule(),
  app.set_allowed_email_domains(uuid, text[]), app.set_max_session_hours(uuid, integer), app.max_session_hours(uuid),
  app.members_outside_email_domains(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.set_allowed_email_domains(uuid, text[]), app.set_max_session_hours(uuid, integer), app.max_session_hours(uuid),
  app.members_outside_email_domains(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Fix to SE5 (20260303100000): two policy changes in one transaction got the same created_at (now() is the transaction's time), so the history's
-- order and the recovery function's "latest change" fell back to a random id. Changes now take the clock time, and the recovery function looks for
-- its own recovery row. Nothing else changes.
-- ---------------------------------------------------------------------------
ALTER TABLE public.network_policy_changes ALTER COLUMN created_at SET DEFAULT clock_timestamp();

CREATE OR REPLACE FUNCTION app.platform_recover_network_policy(p_organisation_id uuid, p_reason text, p_verification text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_policy text; v_reason text := btrim(coalesce(p_reason, '')); v_verification text := btrim(coalesce(p_verification, '')); v_id uuid;
BEGIN
  IF NOT app.is_platform_admin() THEN RAISE EXCEPTION 'Platform administrators only' USING ERRCODE = '42501'; END IF;
  SELECT s.network_policy INTO v_policy FROM public.organisation_settings s WHERE s.organisation_id = p_organisation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Organisation not found' USING ERRCODE = 'P0002'; END IF;
  IF v_policy <> 'enforce' THEN RAISE EXCEPTION 'This organisation is not enforcing network restrictions, so there is nothing to recover' USING ERRCODE = 'QM029'; END IF;
  IF length(v_reason) < 10 OR length(v_reason) > 1000 THEN RAISE EXCEPTION 'Say why access is being recovered (10 to 1000 characters)' USING ERRCODE = 'QM029'; END IF;
  IF length(v_verification) < 10 OR length(v_verification) > 1000 THEN RAISE EXCEPTION 'Say how you checked the request came from an owner (10 to 1000 characters)' USING ERRCODE = 'QM029'; END IF;
  PERFORM set_config('app.network_recovery', 'on', true);
  PERFORM set_config('app.network_recovery_reason', v_reason, true);
  PERFORM set_config('app.network_recovery_verification', v_verification, true);
  UPDATE public.organisation_settings
     SET network_policy = 'monitor', network_policy_changed_at = now(), network_policy_changed_by = auth.uid()
   WHERE organisation_id = p_organisation_id;
  PERFORM set_config('app.network_recovery', 'off', true);
  SELECT c.id INTO v_id FROM public.network_policy_changes c
   WHERE c.organisation_id = p_organisation_id AND c.kind = 'recovery' ORDER BY c.created_at DESC LIMIT 1;
  RETURN v_id;
END $$;
