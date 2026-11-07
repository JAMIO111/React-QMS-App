-- ON2 (docs/onboarding-plan.md §12): the organisation in a gated state, and the wizard's saved progress.
--
--  * platform_settings.billing_gate_enabled (default false, changed by SQL only): while false nothing changes for anyone. While true, app.start_organisation marks a new organisation
--    `billing_required` (and turns on entitlements). Existing organisations are grandfathered.
--  * The lock lives in has_permission / has_permission_somewhere / my_permissions: a billing_required organisation without a valid subscription is granted only the billing permissions and
--    organisation.manage (set-up). app.organisation_subscription_valid() is the rule "a valid subscription and a Controller seat held by an active Owner";
--    app.organisation_access_state() tells a member open | needs_subscription | lapsed. organisations.status (active / suspended) is untouched.
--  * organisation_onboarding: the wizard's progress, written only by functions (organisation.manage). organisation, plan and sites are computed; the rest are done / skipped by the owner.

ALTER TABLE public.organisations
  ADD COLUMN billing_required boolean NOT NULL DEFAULT false,
  ADD COLUMN legal_name text CHECK (legal_name IS NULL OR length(btrim(legal_name)) BETWEEN 1 AND 200),
  ADD COLUMN country text CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  ADD COLUMN onboarding_completed_at timestamptz;
-- Settings -> Organisation edits these two (the existing column grant is `name` only); billing_required and onboarding_completed_at stay function-written.
GRANT UPDATE (legal_name, country) ON public.organisations TO authenticated;

-- ---------------------------------------------------------------------------
-- The switch
-- ---------------------------------------------------------------------------
CREATE TABLE public.platform_settings (
  key text PRIMARY KEY CHECK (key ~ '^[a-z_]{1,60}$'),
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.platform_settings (key, value) VALUES ('billing_gate_enabled', 'false'::jsonb);
ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.platform_settings FROM anon, authenticated;
GRANT SELECT ON public.platform_settings TO authenticated;
CREATE POLICY platform_settings_select ON public.platform_settings FOR SELECT TO authenticated USING (app.is_platform_admin());

CREATE FUNCTION app.billing_gate_enabled() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce((SELECT (s.value)::text = 'true' FROM public.platform_settings s WHERE s.key = 'billing_gate_enabled'), false)
$$;

-- ---------------------------------------------------------------------------
-- The rule and the lock
-- ---------------------------------------------------------------------------
-- A valid subscription (trialing, active, past due inside the grace period, or cancelled but paid to the end of the period) AND a Controller seat assigned to an active Owner.
CREATE FUNCTION app.organisation_subscription_valid(p_organisation_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
           SELECT 1 FROM public.organisation_subscriptions s
            WHERE s.organisation_id = p_organisation_id
              AND (s.status IN ('active', 'trialing')
                   OR (s.status = 'past_due' AND coalesce(s.past_due_since, now())
                         + make_interval(days => coalesce((SELECT o.grace_period_days FROM public.organisation_settings o WHERE o.organisation_id = p_organisation_id), 7)) > now())
                   OR (s.status = 'cancelled' AND s.current_period_end > now())))
     AND EXISTS (
           SELECT 1 FROM public.user_subscription_assignments a
             JOIN public.subscription_plans p ON p.id = a.subscription_plan_id AND p.slug = 'controller'
             JOIN public.organisation_users m ON m.id = a.organisation_membership_id AND m.status = 'active'
             JOIN public.user_role_assignments ura ON ura.membership_id = m.id
             JOIN public.roles r ON r.id = ura.role_id AND r.key = 'owner'
            WHERE a.organisation_id = p_organisation_id AND a.status = 'active'
              AND a.effective_from <= now() AND (a.effective_to IS NULL OR a.effective_to > now()))
$$;

CREATE FUNCTION app.organisation_access_open(p_organisation_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT NOT coalesce((SELECT o.billing_required FROM public.organisations o WHERE o.id = p_organisation_id), false)
      OR app.organisation_subscription_valid(p_organisation_id)
$$;

-- What a gated organisation still allows: billing, and the set-up of the organisation itself.
CREATE FUNCTION app.gated_permissions() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT ARRAY['subscription.read', 'subscription.manage', 'subscription.seats', 'invoices.read', 'payment_methods.manage', 'billing_details.manage', 'organisation.manage']
$$;

-- For members: open | needs_subscription (nothing bought yet) | lapsed (had one, no longer valid). NULL for anyone else.
CREATE FUNCTION app.organisation_access_state(p_organisation_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN NOT app.is_member(p_organisation_id) THEN NULL
              WHEN app.organisation_access_open(p_organisation_id) THEN 'open'
              WHEN NOT EXISTS (SELECT 1 FROM public.organisation_subscriptions s WHERE s.organisation_id = p_organisation_id) THEN 'needs_subscription'
              ELSE 'lapsed' END
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
    AND (p_permission = ANY (app.gated_permissions()) OR app.organisation_access_open(p_organisation_id))
    AND app.has_entitlement(p_organisation_id, p_permission)
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
$$;

-- ---------------------------------------------------------------------------
-- Wizard progress
-- ---------------------------------------------------------------------------
CREATE TABLE public.organisation_onboarding (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL UNIQUE REFERENCES public.organisations (id) ON DELETE CASCADE,
  steps jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(steps) = 'object'),
  started_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL
);
CREATE TRIGGER organisation_onboarding_touch BEFORE UPDATE ON public.organisation_onboarding FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER organisation_onboarding_org_immutable BEFORE UPDATE ON public.organisation_onboarding FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.organisation_onboarding FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.organisation_onboarding ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.organisation_onboarding FROM anon, authenticated;
GRANT SELECT ON public.organisation_onboarding TO authenticated;
CREATE POLICY organisation_onboarding_select ON public.organisation_onboarding FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'organisation.manage'));

CREATE FUNCTION app.onboarding_step_keys() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$ SELECT ARRAY['organisation', 'plan', 'details', 'sites', 'security', 'team', 'review'] $$;

CREATE FUNCTION app.ensure_onboarding(p_organisation_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO public.organisation_onboarding (organisation_id) VALUES (p_organisation_id) ON CONFLICT (organisation_id) DO NOTHING
$$;

-- The wizard as the owner sees it: each step's state, what is required, and whether the organisation can be finished.
CREATE FUNCTION app.onboarding_state(p_organisation_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  o public.organisations%ROWTYPE; w public.organisation_onboarding%ROWTYPE;
  v_valid boolean; v_sites integer; v_steps jsonb := '[]'::jsonb; k text; v_status text; v_required boolean; v_auto boolean; v_current text := NULL; v_can boolean := true;
BEGIN
  IF NOT app.has_permission(p_organisation_id, 'organisation.manage') THEN
    RAISE EXCEPTION 'You are not allowed to set this organisation up' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO o FROM public.organisations WHERE id = p_organisation_id;
  SELECT * INTO w FROM public.organisation_onboarding WHERE organisation_id = p_organisation_id;
  v_valid := app.organisation_subscription_valid(p_organisation_id);
  SELECT count(*) INTO v_sites FROM public.sites s WHERE s.organisation_id = p_organisation_id AND s.active;
  FOREACH k IN ARRAY app.onboarding_step_keys() LOOP
    v_auto := k IN ('organisation', 'plan', 'sites', 'review');
    v_required := k IN ('organisation', 'sites') OR (k = 'plan' AND o.billing_required);
    v_status := CASE k
      WHEN 'organisation' THEN 'done'
      WHEN 'plan' THEN CASE WHEN v_valid THEN 'done' ELSE 'pending' END
      WHEN 'sites' THEN CASE WHEN v_sites > 0 THEN 'done' ELSE 'pending' END
      WHEN 'review' THEN CASE WHEN o.onboarding_completed_at IS NOT NULL THEN 'done' ELSE 'pending' END
      ELSE coalesce(w.steps ->> k, 'pending') END;
    IF v_required AND v_status <> 'done' THEN v_can := false; END IF;
    IF v_current IS NULL AND v_status = 'pending' AND k <> 'review' THEN v_current := k; END IF;
    v_steps := v_steps || jsonb_build_array(jsonb_build_object('key', k, 'status', v_status, 'required', v_required, 'auto', v_auto));
  END LOOP;
  RETURN jsonb_build_object(
    'billingRequired', o.billing_required, 'accessState', app.organisation_access_state(p_organisation_id),
    'currentStep', coalesce(v_current, 'review'), 'steps', v_steps, 'canFinish', v_can,
    'completedAt', o.onboarding_completed_at, 'sites', v_sites);
END $$;

-- Marks a step done, skipped or pending again. organisation, plan, sites and review are worked out, not set.
CREATE FUNCTION app.set_onboarding_step(p_organisation_id uuid, p_step text, p_status text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT app.has_permission(p_organisation_id, 'organisation.manage') THEN
    RAISE EXCEPTION 'You are not allowed to set this organisation up' USING ERRCODE = '42501';
  END IF;
  IF p_step IS NULL OR NOT p_step = ANY (app.onboarding_step_keys()) THEN
    RAISE EXCEPTION 'Unknown step' USING ERRCODE = 'QM014';
  END IF;
  IF p_step IN ('organisation', 'plan', 'sites', 'review') THEN
    RAISE EXCEPTION 'This step is completed by doing it, not by marking it' USING ERRCODE = 'QM014';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('done', 'skipped', 'pending') THEN
    RAISE EXCEPTION 'A step is done, skipped or pending' USING ERRCODE = 'QM014';
  END IF;
  PERFORM app.ensure_onboarding(p_organisation_id);
  UPDATE public.organisation_onboarding SET steps = jsonb_set(steps, ARRAY[p_step], to_jsonb(p_status)) WHERE organisation_id = p_organisation_id;
END $$;

-- Finishes the wizard: what is required (organisation, a site, and a valid subscription when billing is required) must be in place.
CREATE FUNCTION app.complete_onboarding(p_organisation_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v jsonb; s jsonb; v_missing text[] := ARRAY[]::text[];
BEGIN
  v := app.onboarding_state(p_organisation_id);
  IF (v ->> 'completedAt') IS NOT NULL THEN
    RAISE EXCEPTION 'The set-up is already finished' USING ERRCODE = 'QM014';
  END IF;
  FOR s IN SELECT * FROM jsonb_array_elements(v -> 'steps') LOOP
    IF (s ->> 'required')::boolean AND (s ->> 'status') <> 'done' THEN v_missing := array_append(v_missing, s ->> 'key'); END IF;
  END LOOP;
  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION 'Finish these first: %', array_to_string(v_missing, ', ') USING ERRCODE = 'QM014';
  END IF;
  PERFORM app.ensure_onboarding(p_organisation_id);
  UPDATE public.organisation_onboarding SET completed_at = now() WHERE organisation_id = p_organisation_id;
  UPDATE public.organisations SET onboarding_completed_at = now() WHERE id = p_organisation_id;
  PERFORM app.emit_event(p_organisation_id, 'onboarding.completed', 'organisation', p_organisation_id, '{}'::jsonb);
END $$;

-- ---------------------------------------------------------------------------
-- Starting an organisation
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.start_organisation(
  p_name text, p_site_name text DEFAULT 'Main site', p_site_code text DEFAULT 'MAIN',
  p_time_zone text DEFAULT NULL, p_country text DEFAULT NULL, p_idempotency_key text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid; v_tz text := nullif(btrim(coalesce(p_time_zone, '')), ''); v_country text := nullif(upper(btrim(coalesce(p_country, ''))), '');
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'sign in to create an organisation' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_tz IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_timezone_names z WHERE z.name = v_tz) THEN
    RAISE EXCEPTION 'Unknown time zone' USING ERRCODE = 'QM014';
  END IF;
  IF v_country IS NOT NULL AND v_country !~ '^[A-Z]{2}$' THEN
    RAISE EXCEPTION 'Use a two-letter country code' USING ERRCODE = 'QM014';
  END IF;
  v_org := app.create_organisation(p_name, p_site_name, p_site_code, p_idempotency_key);
  -- A repeated request (same idempotency key) finds the wizard already started: nothing is applied twice.
  IF EXISTS (SELECT 1 FROM public.organisation_onboarding w WHERE w.organisation_id = v_org) THEN
    RETURN v_org;
  END IF;
  IF v_tz IS NOT NULL THEN
    UPDATE public.sites SET timezone = v_tz WHERE organisation_id = v_org;
  END IF;
  UPDATE public.organisations SET country = v_country, billing_required = app.billing_gate_enabled() WHERE id = v_org;
  IF app.billing_gate_enabled() THEN
    UPDATE public.organisation_settings SET entitlements_enforced = true WHERE organisation_id = v_org;
  END IF;
  PERFORM app.ensure_onboarding(v_org);
  RETURN v_org;
END $$;

REVOKE ALL ON FUNCTION app.billing_gate_enabled(), app.organisation_subscription_valid(uuid), app.organisation_access_open(uuid), app.gated_permissions(),
  app.organisation_access_state(uuid), app.onboarding_step_keys(), app.ensure_onboarding(uuid), app.onboarding_state(uuid), app.set_onboarding_step(uuid, text, text),
  app.complete_onboarding(uuid), app.start_organisation(text, text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.organisation_access_state(uuid), app.onboarding_state(uuid), app.set_onboarding_step(uuid, text, text), app.complete_onboarding(uuid),
  app.start_organisation(text, text, text, text, text, text) TO authenticated;
