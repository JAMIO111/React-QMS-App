-- Single sign-on, slice SS2 (docs/sso-plan.md): the organisation's SAML identity provider, names taken from a company sign-in, and accepting
-- Fortress's terms on a first sign-in that did not go through our sign-up form.
--
--  * organisation_sso_providers: the provider registered with Supabase Auth for an organisation (SAML 2.0). Registering it means calling the
--    Supabase Management API with a server-only token, so only the API login writes this table (app.system_sso_*), after the API has checked
--    that the person holds security.manage. At most one active provider per organisation; a disabled one is kept (with who, when and why), and
--    it was removed from Supabase so its domains are free again. `domains` = the organisation's verified domains as last sent to Supabase;
--    `last_error` = why the last sync failed (the provider stays as it was in Supabase). Read with security.read; audited.
--  * app.handle_new_user: a user created by a SAML sign-in brings given_name / family_name / name (mapped by Fortress when the provider is
--    registered), so the profile starts with the person's name. Our own sign-up form's first_name / surname still win.
--  * app.accept_terms(version): the signed-in person records that they accepted Fortress's terms (a person who first arrives through their
--    company's sign-in never saw our sign-up form). Only their own profile; only moves to a different version.
-- Errors use QM030 (409 sso_rule).

-- ---------------------------------------------------------------------------
-- Providers
-- ---------------------------------------------------------------------------
CREATE TABLE public.organisation_sso_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  -- The provider's id in Supabase Auth (amr[].provider in a session token).
  supabase_provider_id uuid NOT NULL,
  entity_id text CHECK (entity_id IS NULL OR length(entity_id) BETWEEN 1 AND 1000),
  -- Exactly one of the two ways the company's metadata was given.
  metadata_url text CHECK (metadata_url IS NULL OR (metadata_url ~ '^https://' AND length(metadata_url) <= 2000)),
  metadata_sha256 text CHECK (metadata_sha256 IS NULL OR metadata_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  domains text[] NOT NULL DEFAULT '{}' CHECK (cardinality(domains) <= 20),
  last_synced_at timestamptz,
  last_error text CHECK (last_error IS NULL OR length(last_error) <= 500),
  disabled_at timestamptz,
  disabled_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  disabled_reason text CHECK (disabled_reason IS NULL OR length(btrim(disabled_reason)) BETWEEN 3 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT organisation_sso_providers_metadata_check CHECK ((metadata_url IS NULL) <> (metadata_sha256 IS NULL)),
  CONSTRAINT organisation_sso_providers_disabled_check CHECK ((status = 'disabled') = (disabled_at IS NOT NULL))
);
CREATE UNIQUE INDEX organisation_sso_providers_active_key ON public.organisation_sso_providers (organisation_id) WHERE status = 'active';
CREATE UNIQUE INDEX organisation_sso_providers_supabase_key ON public.organisation_sso_providers (supabase_provider_id);
CREATE INDEX organisation_sso_providers_org_idx ON public.organisation_sso_providers (organisation_id, created_at DESC);

CREATE FUNCTION app.organisation_sso_provider_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A single sign-on provider is never deleted. Disable it with a reason.' USING ERRCODE = 'QM030'; END IF;
  IF NEW.supabase_provider_id <> OLD.supabase_provider_id THEN
    RAISE EXCEPTION 'A provider''s Supabase id never changes. Disable it and add the new one.' USING ERRCODE = 'QM030';
  END IF;
  IF OLD.status = 'disabled' THEN RAISE EXCEPTION 'A disabled provider is kept as it was. Add a new one.' USING ERRCODE = 'QM030'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER organisation_sso_providers_rules BEFORE UPDATE OR DELETE ON public.organisation_sso_providers
  FOR EACH ROW EXECUTE FUNCTION app.organisation_sso_provider_rules();
CREATE TRIGGER organisation_sso_providers_org_immutable BEFORE UPDATE ON public.organisation_sso_providers
  FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.organisation_sso_providers
  FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.organisation_sso_providers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.organisation_sso_providers FROM anon, authenticated;
GRANT SELECT ON public.organisation_sso_providers TO authenticated;
CREATE POLICY organisation_sso_providers_select ON public.organisation_sso_providers FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'security.read'));

-- The organisation's verified domains (what the provider is sent to Supabase with).
CREATE FUNCTION app.sso_verified_domains(p_organisation_id uuid) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(array_agg(d.domain ORDER BY d.domain), '{}')
    FROM public.organisation_sso_domains d
   WHERE d.organisation_id = p_organisation_id AND d.verified_at IS NOT NULL AND d.removed_at IS NULL
$$;

-- ---------------------------------------------------------------------------
-- The API login (after it has checked security.manage and talked to Supabase)
-- ---------------------------------------------------------------------------
-- Records the provider Supabase now holds for the organisation: a new one, or the active one with new metadata.
CREATE FUNCTION app.system_sso_save_provider(p_organisation_id uuid, p_actor uuid, p_supabase_id uuid, p_entity_id text, p_metadata_url text,
                                             p_metadata_sha256 text, p_domains text[]) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_active public.organisation_sso_providers; v_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organisations WHERE id = p_organisation_id) THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO v_active FROM public.organisation_sso_providers WHERE organisation_id = p_organisation_id AND status = 'active' FOR UPDATE;
  IF FOUND AND v_active.supabase_provider_id <> p_supabase_id THEN
    RAISE EXCEPTION 'This organisation already has a single sign-on provider. Disable it before adding another.' USING ERRCODE = 'QM030';
  END IF;
  IF FOUND THEN
    UPDATE public.organisation_sso_providers
       SET entity_id = p_entity_id, metadata_url = p_metadata_url, metadata_sha256 = p_metadata_sha256, domains = coalesce(p_domains, '{}'),
           last_synced_at = now(), last_error = NULL, updated_at = now(), updated_by = p_actor
     WHERE id = v_active.id
     RETURNING id INTO v_id;
  ELSE
    INSERT INTO public.organisation_sso_providers (organisation_id, supabase_provider_id, entity_id, metadata_url, metadata_sha256, domains,
                                                   last_synced_at, created_by, updated_by)
    VALUES (p_organisation_id, p_supabase_id, p_entity_id, p_metadata_url, p_metadata_sha256, coalesce(p_domains, '{}'), now(), p_actor, p_actor)
    RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END $$;

-- The outcome of sending the verified domains to Supabase (after a domain is verified or removed). A failure is kept for the owners to see.
CREATE FUNCTION app.system_sso_provider_synced(p_provider_id uuid, p_domains text[], p_error text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.organisation_sso_providers
     SET domains = CASE WHEN p_error IS NULL THEN coalesce(p_domains, '{}') ELSE domains END,
         last_synced_at = CASE WHEN p_error IS NULL THEN now() ELSE last_synced_at END,
         last_error = left(nullif(btrim(p_error), ''), 500), updated_at = now()
   WHERE id = p_provider_id AND status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
END $$;

-- Disabled (the API has removed it from Supabase). Kept with who, when and why.
CREATE FUNCTION app.system_sso_disable_provider(p_provider_id uuid, p_actor uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  IF length(v_reason) < 3 OR length(v_reason) > 500 THEN
    RAISE EXCEPTION 'Say why single sign-on is being switched off (3 to 500 characters)' USING ERRCODE = 'QM030';
  END IF;
  UPDATE public.organisation_sso_providers
     SET status = 'disabled', disabled_at = now(), disabled_by = p_actor, disabled_reason = v_reason, updated_at = now(), updated_by = p_actor
   WHERE id = p_provider_id AND status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
END $$;

-- What the API needs to keep Supabase in step: the active provider (if any), the domains last sent, the domains verified now, and the last
-- sync's error (a failed sync is sent again at the next chance even when the lists look the same).
CREATE FUNCTION app.system_sso_provider_state(p_organisation_id uuid)
RETURNS TABLE (provider_id uuid, supabase_provider_id uuid, domains text[], verified text[], last_error text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p.id, p.supabase_provider_id, p.domains, app.sso_verified_domains(p_organisation_id), p.last_error
    FROM (SELECT 1) one
    LEFT JOIN public.organisation_sso_providers p ON p.organisation_id = p_organisation_id AND p.status = 'active'
$$;

REVOKE ALL ON FUNCTION app.organisation_sso_provider_rules(), app.sso_verified_domains(uuid), app.system_sso_provider_state(uuid),
  app.system_sso_save_provider(uuid, uuid, uuid, text, text, text, text[]), app.system_sso_provider_synced(uuid, text[], text),
  app.system_sso_disable_provider(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.sso_verified_domains(uuid), app.system_sso_provider_state(uuid), app.system_sso_save_provider(uuid, uuid, uuid, text, text, text, text[]),
  app.system_sso_provider_synced(uuid, text[], text), app.system_sso_disable_provider(uuid, uuid, text) TO qms_api;

-- ---------------------------------------------------------------------------
-- Names from a company sign-in
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.handle_new_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  m jsonb := coalesce(NEW.raw_user_meta_data, '{}'::jsonb);
  v_terms text := nullif(btrim(left(m ->> 'terms_version', 20)), '');
  v_full text := nullif(btrim(left(coalesce(m ->> 'name', m ->> 'full_name'), 200)), '');
  v_first text := nullif(btrim(left(coalesce(nullif(btrim(m ->> 'first_name'), ''), m ->> 'given_name'), 100)), '');
  v_surname text := nullif(btrim(left(coalesce(nullif(btrim(m ->> 'surname'), ''), m ->> 'family_name'), 100)), '');
BEGIN
  -- Only a full name ("Ada Lovelace"): first word, then the rest.
  IF v_first IS NULL AND v_surname IS NULL AND v_full IS NOT NULL THEN
    v_first := left(split_part(v_full, ' ', 1), 100);
    v_surname := nullif(left(btrim(substring(v_full FROM length(split_part(v_full, ' ', 1)) + 1)), 100), '');
  END IF;
  INSERT INTO public.profiles (id, first_name, surname, terms_accepted_at, terms_version)
  VALUES (NEW.id, v_first, v_surname, CASE WHEN v_terms IS NOT NULL THEN now() END, v_terms)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- Accepting the terms after a company sign-in
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.accept_terms(p_version text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_version text := btrim(coalesce(p_version, '')); v_at timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in first' USING ERRCODE = '42501'; END IF;
  IF v_version !~ '^[A-Za-z0-9._-]{1,20}$' THEN RAISE EXCEPTION 'Unknown terms version' USING ERRCODE = 'QM030'; END IF;
  UPDATE public.profiles SET terms_accepted_at = now(), terms_version = v_version
   WHERE id = auth.uid() AND terms_version IS DISTINCT FROM v_version
  RETURNING terms_accepted_at INTO v_at;
  IF v_at IS NULL THEN SELECT terms_accepted_at INTO v_at FROM public.profiles WHERE id = auth.uid(); END IF;
  RETURN v_at;
END $$;
REVOKE ALL ON FUNCTION app.accept_terms(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.accept_terms(text) TO authenticated;
