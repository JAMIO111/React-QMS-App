-- Phase 1 / slice 1.4 — creating organisations (docs/phase-1-plan.md §4, POST /organisations)
--
-- Signed-in users cannot insert organisations directly (no RLS policy allows it). The API calls
-- app.create_organisation(), which in one transaction creates the organisation, its settings, a
-- default site, the standard roles, a starter set of NCR statuses, and makes the caller its Owner.
-- app is not exposed through the Supabase Data API, so this is only reachable via the API.
-- Optional idempotency key: repeating a request with the same key returns the same organisation.

CREATE TABLE app.idempotency_keys (
  user_id uuid NOT NULL,
  scope text NOT NULL,
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 200),
  result_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, scope, key)
);
REVOKE ALL ON app.idempotency_keys FROM PUBLIC, anon, authenticated;

CREATE FUNCTION app.create_organisation(
  p_name text,
  p_site_name text DEFAULT 'Main site',
  p_site_code text DEFAULT 'MAIN',
  p_idempotency_key text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := auth.uid();
  v_name text := trim(p_name);
  v_org uuid;
  v_membership uuid;
  v_base text;
  v_slug text;
  v_n int := 1;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'sign in to create an organisation' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_name IS NULL OR length(v_name) NOT BETWEEN 2 AND 100 THEN
    RAISE EXCEPTION 'organisation name must be 2 to 100 characters' USING ERRCODE = 'check_violation';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT k.result_id INTO v_org FROM app.idempotency_keys k
    WHERE k.user_id = v_user AND k.scope = 'create_organisation' AND k.key = p_idempotency_key;
    IF FOUND THEN
      RETURN v_org;
    END IF;
  END IF;

  -- Abuse limit: at most 10 new organisations per user per day.
  IF (SELECT count(*) FROM public.organisations o
      WHERE o.created_by = v_user AND o.created_at > now() - interval '1 day') >= 10 THEN
    RAISE EXCEPTION 'too many organisations created today' USING ERRCODE = 'program_limit_exceeded';
  END IF;

  v_base := left(coalesce(nullif(trim(BOTH '-' FROM lower(regexp_replace(v_name, '[^a-zA-Z0-9]+', '-', 'g'))), ''), 'org'), 50);
  v_base := trim(BOTH '-' FROM v_base);
  v_slug := v_base;
  WHILE EXISTS (SELECT 1 FROM public.organisations o WHERE o.slug = v_slug) LOOP
    v_n := v_n + 1;
    v_slug := v_base || '-' || v_n;
  END LOOP;

  INSERT INTO public.organisations (name, slug, created_by) VALUES (v_name, v_slug, v_user)
  RETURNING id INTO v_org;
  INSERT INTO public.organisation_settings (organisation_id) VALUES (v_org);
  INSERT INTO public.sites (organisation_id, code, name, created_by)
  VALUES (v_org, upper(trim(p_site_code)), trim(p_site_name), v_user);

  PERFORM app.create_default_roles(v_org);

  INSERT INTO public.organisation_users (organisation_id, user_id, status, joined_at)
  VALUES (v_org, v_user, 'active', now())
  RETURNING id INTO v_membership;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id, created_by)
  SELECT v_org, v_membership, r.id, v_user FROM public.roles r WHERE r.organisation_id = v_org AND r.key = 'owner';

  -- Starter NCR statuses so the registers are usable straight away (editable later).
  INSERT INTO public."Status" (organisation_id, name, color, type, description) VALUES
    (v_org, 'Open', '#2563eb', 'initial', 'Newly raised'),
    (v_org, 'In progress', '#d97706', 'in_progress', 'Being investigated or actioned'),
    (v_org, 'Closed', '#16a34a', 'terminal', 'Completed and verified'),
    (v_org, 'Void', '#6b7280', 'omit', 'Raised in error; excluded from reporting');

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO app.idempotency_keys (user_id, scope, key, result_id)
    VALUES (v_user, 'create_organisation', p_idempotency_key, v_org);
  END IF;

  RETURN v_org;
END $$;

REVOKE ALL ON FUNCTION app.create_organisation(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_organisation(text, text, text, text) TO authenticated;
