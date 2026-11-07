-- ON1 (docs/onboarding-plan.md §11): sign-up and account states, and the operator's funnel.
--
--  * profiles remember when and which terms were accepted at sign-up (from the sign-up metadata, set by app.handle_new_user; not editable by the user).
--  * signup_events: the sign-up funnel (signed_up, verified, org_started), written only by triggers on auth.users and organisations, backfilled from existing data.
--    Invited people (Supabase invite) are recorded as kind 'invited' so the owner funnel counts only people who signed themselves up.
--  * platform_admins: the operator allow-list (seeded by SQL). app.is_platform_admin() = on the list AND the session passed MFA (aal2).
--    The two platform tables are readable only by platform admins; the funnel and recent sign-ups come from admin-only functions. No tenant business data is reachable.

ALTER TABLE public.profiles
  ADD COLUMN terms_accepted_at timestamptz,
  ADD COLUMN terms_version text CHECK (terms_version IS NULL OR length(terms_version) <= 20);

CREATE OR REPLACE FUNCTION app.handle_new_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_terms text := nullif(btrim(left(NEW.raw_user_meta_data ->> 'terms_version', 20)), '');
BEGIN
  INSERT INTO public.profiles (id, first_name, surname, terms_accepted_at, terms_version)
  VALUES (NEW.id, nullif(btrim(left(NEW.raw_user_meta_data ->> 'first_name', 100)), ''), nullif(btrim(left(NEW.raw_user_meta_data ->> 'surname', 100)), ''),
          CASE WHEN v_terms IS NOT NULL THEN now() END, v_terms)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- The operator allow-list and the funnel
-- ---------------------------------------------------------------------------
CREATE TABLE public.platform_admins (
  user_id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.signup_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  event text NOT NULL CHECK (event IN ('signed_up', 'verified', 'org_started')),
  kind text NOT NULL DEFAULT 'self' CHECK (kind IN ('self', 'invited')),
  organisation_id uuid REFERENCES public.organisations (id) ON DELETE SET NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  meta jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX signup_events_once ON public.signup_events (user_id, event) WHERE event IN ('signed_up', 'verified');
CREATE UNIQUE INDEX signup_events_org_once ON public.signup_events (organisation_id) WHERE event = 'org_started' AND organisation_id IS NOT NULL;
CREATE INDEX signup_events_event_idx ON public.signup_events (event, occurred_at DESC);

-- Backfill from what already exists (invited accounts are marked as such).
INSERT INTO public.signup_events (user_id, event, kind, occurred_at)
SELECT u.id, 'signed_up', CASE WHEN u.raw_user_meta_data ? 'invited_to' OR u.invited_at IS NOT NULL THEN 'invited' ELSE 'self' END, coalesce(u.created_at, now())
  FROM auth.users u
ON CONFLICT DO NOTHING;
INSERT INTO public.signup_events (user_id, event, kind, occurred_at)
SELECT u.id, 'verified', CASE WHEN u.raw_user_meta_data ? 'invited_to' OR u.invited_at IS NOT NULL THEN 'invited' ELSE 'self' END, u.email_confirmed_at
  FROM auth.users u WHERE u.email_confirmed_at IS NOT NULL
ON CONFLICT DO NOTHING;
INSERT INTO public.signup_events (user_id, event, kind, organisation_id, occurred_at)
SELECT o.created_by, 'org_started', 'self', o.id, o.created_at FROM public.organisations o WHERE o.created_by IS NOT NULL
ON CONFLICT DO NOTHING;

CREATE FUNCTION app.record_signup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_kind text := CASE WHEN NEW.raw_user_meta_data ? 'invited_to' OR NEW.invited_at IS NOT NULL THEN 'invited' ELSE 'self' END;
BEGIN
  INSERT INTO public.signup_events (user_id, event, kind) VALUES (NEW.id, 'signed_up', v_kind) ON CONFLICT DO NOTHING;
  IF NEW.email_confirmed_at IS NOT NULL THEN
    INSERT INTO public.signup_events (user_id, event, kind, occurred_at) VALUES (NEW.id, 'verified', v_kind, NEW.email_confirmed_at) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER on_auth_user_signup AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION app.record_signup();

CREATE FUNCTION app.record_verified() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.signup_events (user_id, event, kind, occurred_at)
  VALUES (NEW.id, 'verified', CASE WHEN NEW.raw_user_meta_data ? 'invited_to' OR NEW.invited_at IS NOT NULL THEN 'invited' ELSE 'self' END, NEW.email_confirmed_at)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER on_auth_user_verified AFTER UPDATE OF email_confirmed_at ON auth.users
  FOR EACH ROW WHEN (OLD.email_confirmed_at IS NULL AND NEW.email_confirmed_at IS NOT NULL) EXECUTE FUNCTION app.record_verified();

CREATE FUNCTION app.record_org_started() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := coalesce(NEW.created_by, auth.uid());
BEGIN
  IF v_user IS NOT NULL THEN
    INSERT INTO public.signup_events (user_id, event, kind, organisation_id) VALUES (v_user, 'org_started', 'self', NEW.id) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER organisations_started AFTER INSERT ON public.organisations FOR EACH ROW EXECUTE FUNCTION app.record_org_started();

-- ---------------------------------------------------------------------------
-- Access: platform admins with an MFA session only
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.is_platform_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT auth.uid() IS NOT NULL AND coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
     AND EXISTS (SELECT 1 FROM public.platform_admins a WHERE a.user_id = auth.uid())
$$;

-- 'none' (not an operator), 'needs_mfa' (on the list, this session has not passed MFA), 'ok'.
CREATE FUNCTION app.platform_account_status() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM public.platform_admins a WHERE a.user_id = auth.uid()) THEN 'none'
              WHEN coalesce(auth.jwt() ->> 'aal', '') = 'aal2' THEN 'ok'
              ELSE 'needs_mfa' END
$$;

ALTER TABLE public.platform_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signup_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.platform_admins, public.signup_events FROM anon, authenticated;
GRANT SELECT ON public.platform_admins, public.signup_events TO authenticated;
CREATE POLICY platform_admins_select ON public.platform_admins FOR SELECT TO authenticated USING (app.is_platform_admin());
CREATE POLICY signup_events_select ON public.signup_events FOR SELECT TO authenticated USING (app.is_platform_admin());

-- The funnel of people who signed themselves up in the last p_days days: how many verified their email and how many went on to start an organisation.
CREATE FUNCTION app.platform_funnel(p_days integer DEFAULT 30) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_since timestamptz; v_signed integer; v_verified integer; v_started integer;
BEGIN
  IF NOT app.is_platform_admin() THEN
    RAISE EXCEPTION 'Platform administrators only' USING ERRCODE = '42501';
  END IF;
  IF p_days IS NULL OR p_days < 1 OR p_days > 365 THEN
    RAISE EXCEPTION 'Choose between 1 and 365 days' USING ERRCODE = '22023';
  END IF;
  v_since := now() - make_interval(days => p_days);
  SELECT count(*) INTO v_signed FROM public.signup_events s WHERE s.event = 'signed_up' AND s.kind = 'self' AND s.occurred_at >= v_since;
  SELECT count(*) INTO v_verified FROM public.signup_events s WHERE s.event = 'signed_up' AND s.kind = 'self' AND s.occurred_at >= v_since
    AND EXISTS (SELECT 1 FROM public.signup_events v WHERE v.user_id = s.user_id AND v.event = 'verified');
  SELECT count(*) INTO v_started FROM public.signup_events s WHERE s.event = 'signed_up' AND s.kind = 'self' AND s.occurred_at >= v_since
    AND EXISTS (SELECT 1 FROM public.signup_events o WHERE o.user_id = s.user_id AND o.event = 'org_started');
  RETURN jsonb_build_object(
    'days', p_days, 'since', v_since, 'signedUp', v_signed, 'verified', v_verified, 'orgStarted', v_started,
    'totalAccounts', (SELECT count(*) FROM public.signup_events s WHERE s.event = 'signed_up' AND s.kind = 'self'),
    'totalOrganisations', (SELECT count(*) FROM public.organisations));
END $$;

CREATE FUNCTION app.platform_recent_signups(p_limit integer DEFAULT 25)
RETURNS TABLE (user_id uuid, email text, first_name text, surname text, signed_up_at timestamptz, verified_at timestamptz, org_started_at timestamptz, organisation_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT app.is_platform_admin() THEN
    RAISE EXCEPTION 'Platform administrators only' USING ERRCODE = '42501';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'Choose between 1 and 100 rows' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT s.user_id, u.email::text, p.first_name, p.surname, s.occurred_at,
           (SELECT v.occurred_at FROM public.signup_events v WHERE v.user_id = s.user_id AND v.event = 'verified'),
           (SELECT o.occurred_at FROM public.signup_events o WHERE o.user_id = s.user_id AND o.event = 'org_started' ORDER BY o.occurred_at LIMIT 1),
           (SELECT g.name FROM public.signup_events o JOIN public.organisations g ON g.id = o.organisation_id WHERE o.user_id = s.user_id AND o.event = 'org_started' ORDER BY o.occurred_at LIMIT 1)
      FROM public.signup_events s
      JOIN auth.users u ON u.id = s.user_id
      LEFT JOIN public.profiles p ON p.id = s.user_id
     WHERE s.event = 'signed_up' AND s.kind = 'self'
     ORDER BY s.occurred_at DESC
     LIMIT p_limit;
END $$;

REVOKE ALL ON FUNCTION app.record_signup(), app.record_verified(), app.record_org_started(), app.is_platform_admin(), app.platform_account_status(),
  app.platform_funnel(integer), app.platform_recent_signups(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.is_platform_admin(), app.platform_account_status(), app.platform_funnel(integer), app.platform_recent_signups(integer) TO authenticated;
