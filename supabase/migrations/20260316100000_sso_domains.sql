-- Single sign-on, slice SS1 (docs/sso-plan.md, decisions SS1–SS12): the organisation's SSO settings and its email domains, proved by a DNS record.
--
--  * organisation_settings gains the SSO settings of SS4, SS6 and SS7: sso_mode off | optional | required (default off), sso_join invited | domain,
--    sso_default_role_id, sso_default_department_id, sso_trust_idp_mfa (default true), sso_mode_changed_at / _by. Nothing changes them yet:
--    SS3 adds the functions (and the checks that use them). Not in the column UPDATE grant.
--  * organisation_sso_domains: a domain the organisation says is its own, with a verification token made by the database (random; never chosen by
--    the caller, so another organisation's public TXT record can never prove a claim). A domain is **verified** when the API finds the TXT record
--    "fortress-verification=<token>" at the domain. A domain may be claimed by several organisations, but **verified by one at a time**
--    across Fortress (unique index). While allowed email domains (SE6) are set, the domain must be one of them or a sub-domain of one.
--    Verified domains are checked again weekly; a missing record is flagged (check_failed_at), never removed by the system. Removed with a reason,
--    never deleted. Functions only; read with security.read; audited.
--  * Who writes what: people (security.manage) add and remove domains; only the API login records the outcome of a DNS check
--    (app.system_sso_domain_check), because the database cannot look DNS up itself and a person must not be able to mark a domain verified.
-- Errors use QM030 (409 sso_rule); another organisation's id is P0002 (404).

-- ---------------------------------------------------------------------------
-- Settings (written by SS3's functions only)
-- ---------------------------------------------------------------------------
ALTER TABLE public.organisation_settings
  ADD COLUMN sso_mode text NOT NULL DEFAULT 'off' CHECK (sso_mode IN ('off', 'optional', 'required')),
  ADD COLUMN sso_join text NOT NULL DEFAULT 'invited' CHECK (sso_join IN ('invited', 'domain')),
  ADD COLUMN sso_default_role_id uuid REFERENCES public.roles (id) ON DELETE SET NULL,
  ADD COLUMN sso_default_department_id uuid,
  ADD COLUMN sso_trust_idp_mfa boolean NOT NULL DEFAULT true,
  ADD COLUMN sso_mode_changed_at timestamptz,
  ADD COLUMN sso_mode_changed_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  ADD CONSTRAINT organisation_settings_sso_department_fkey FOREIGN KEY (sso_default_department_id, organisation_id)
    REFERENCES public.departments (id, organisation_id);

-- ---------------------------------------------------------------------------
-- Domains
-- ---------------------------------------------------------------------------
CREATE TABLE public.organisation_sso_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  domain text NOT NULL CHECK (domain = lower(btrim(domain)) AND length(domain) BETWEEN 4 AND 253),
  verification_token text NOT NULL DEFAULT replace(gen_random_uuid()::text, '-', '') CHECK (verification_token ~ '^[0-9a-f]{32}$'),
  verified_at timestamptz,
  verified_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  last_checked_at timestamptz,
  -- Set when a check finds the record missing (or the domain claimed elsewhere); cleared by the next good check.
  check_failed_at timestamptz,
  check_error text CHECK (check_error IS NULL OR length(check_error) <= 300),
  removed_at timestamptz,
  removed_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  removed_reason text CHECK (removed_reason IS NULL OR length(btrim(removed_reason)) BETWEEN 3 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT organisation_sso_domains_removed_check CHECK ((removed_at IS NULL) = (removed_reason IS NULL)),
  CONSTRAINT organisation_sso_domains_verified_check CHECK (verified_at IS NULL OR removed_at IS NULL)
);
-- One live claim of a domain per organisation; one verified claim of a domain across Fortress.
CREATE UNIQUE INDEX organisation_sso_domains_org_key ON public.organisation_sso_domains (organisation_id, domain) WHERE removed_at IS NULL;
CREATE UNIQUE INDEX organisation_sso_domains_verified_key ON public.organisation_sso_domains (domain) WHERE verified_at IS NOT NULL;
CREATE INDEX organisation_sso_domains_org_idx ON public.organisation_sso_domains (organisation_id) WHERE removed_at IS NULL;
CREATE INDEX organisation_sso_domains_check_idx ON public.organisation_sso_domains (last_checked_at) WHERE verified_at IS NOT NULL;

CREATE FUNCTION app.organisation_sso_domain_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A single sign-on domain is never deleted. Remove it with a reason.' USING ERRCODE = 'QM030'; END IF;
  IF NEW.domain <> OLD.domain OR NEW.verification_token <> OLD.verification_token THEN
    RAISE EXCEPTION 'A domain and its verification record never change. Remove it and add the new one.' USING ERRCODE = 'QM030';
  END IF;
  IF OLD.removed_at IS NOT NULL THEN RAISE EXCEPTION 'That domain was removed. Add it again.' USING ERRCODE = 'QM030'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER organisation_sso_domains_rules BEFORE UPDATE OR DELETE ON public.organisation_sso_domains
  FOR EACH ROW EXECUTE FUNCTION app.organisation_sso_domain_rules();
CREATE TRIGGER organisation_sso_domains_stamp BEFORE INSERT ON public.organisation_sso_domains FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER organisation_sso_domains_touch BEFORE UPDATE ON public.organisation_sso_domains FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER organisation_sso_domains_org_immutable BEFORE UPDATE ON public.organisation_sso_domains
  FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.organisation_sso_domains
  FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.organisation_sso_domains ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.organisation_sso_domains FROM anon, authenticated;
GRANT SELECT ON public.organisation_sso_domains TO authenticated;
CREATE POLICY organisation_sso_domains_select ON public.organisation_sso_domains FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'security.read'));

-- ---------------------------------------------------------------------------
-- Rules
-- ---------------------------------------------------------------------------
-- Why this organisation cannot use the domain for single sign-on, or NULL. Used when it is added and at every check.
CREATE FUNCTION app.sso_domain_problem(p_organisation_id uuid, p_domain text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE
    WHEN NOT app.email_domain_allowed(p_organisation_id, 'x@' || p_domain)
      THEN 'Your organisation only invites people at ' || array_to_string((SELECT allowed_email_domains FROM public.organisation_settings
                                                                          WHERE organisation_id = p_organisation_id), ', ')
           || '. Add ' || p_domain || ' there first, or use one of those domains.'
    WHEN EXISTS (SELECT 1 FROM public.organisation_sso_domains d
                  WHERE d.domain = p_domain AND d.verified_at IS NOT NULL AND d.organisation_id <> p_organisation_id)
      THEN p_domain || ' is already used for single sign-on by another organisation in Fortress. If it is yours, contact Fortress support.'
  END
$$;

-- ---------------------------------------------------------------------------
-- People (security.manage)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.add_sso_domain(p_organisation_id uuid, p_domain text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_domain text; v_problem text; v_id uuid;
BEGIN
  PERFORM app.assert_security_manager(p_organisation_id);
  BEGIN
    v_domain := app.normalise_email_domain(p_domain);
  EXCEPTION WHEN SQLSTATE 'QM029' THEN
    RAISE EXCEPTION '%', SQLERRM USING ERRCODE = 'QM030';
  END;
  IF EXISTS (SELECT 1 FROM public.organisation_sso_domains WHERE organisation_id = p_organisation_id AND domain = v_domain AND removed_at IS NULL) THEN
    RAISE EXCEPTION '% is already on the list' , v_domain USING ERRCODE = 'QM030';
  END IF;
  IF (SELECT count(*) FROM public.organisation_sso_domains WHERE organisation_id = p_organisation_id AND removed_at IS NULL) >= 20 THEN
    RAISE EXCEPTION 'At most 20 single sign-on domains' USING ERRCODE = 'QM030';
  END IF;
  v_problem := app.sso_domain_problem(p_organisation_id, v_domain);
  IF v_problem IS NOT NULL THEN RAISE EXCEPTION '%', v_problem USING ERRCODE = 'QM030'; END IF;
  INSERT INTO public.organisation_sso_domains (organisation_id, domain) VALUES (p_organisation_id, v_domain) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION app.remove_sso_domain(p_domain_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE d public.organisation_sso_domains; v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  SELECT * INTO d FROM public.organisation_sso_domains WHERE id = p_domain_id FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(d.organisation_id) THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_security_manager(d.organisation_id);
  IF d.removed_at IS NOT NULL THEN RAISE EXCEPTION 'That domain was already removed' USING ERRCODE = 'QM030'; END IF;
  IF length(v_reason) < 3 OR length(v_reason) > 500 THEN RAISE EXCEPTION 'Say why the domain is being removed (3 to 500 characters)' USING ERRCODE = 'QM030'; END IF;
  -- SS2/SS3 add: refused while the organisation's provider or required single sign-on still depends on it.
  UPDATE public.organisation_sso_domains
     SET removed_at = now(), removed_by = auth.uid(), removed_reason = v_reason, verified_at = NULL, verified_by = NULL
   WHERE id = p_domain_id;
END $$;

-- ---------------------------------------------------------------------------
-- The API login: outcome of a DNS check
-- ---------------------------------------------------------------------------
-- found = the TXT record "fortress-verification=<token>" was at the domain. p_checked_by = the person who asked (NULL for the weekly check).
-- Returns the domain's state afterwards: verified | unverified | failed (verified before, record missing now) | refused (problem; reason in check_error).
CREATE FUNCTION app.system_sso_domain_check(p_domain_id uuid, p_found boolean, p_error text, p_checked_by uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE d public.organisation_sso_domains; v_problem text; v_error text := left(nullif(btrim(coalesce(p_error, '')), ''), 300);
BEGIN
  SELECT * INTO d FROM public.organisation_sso_domains WHERE id = p_domain_id FOR UPDATE;
  IF NOT FOUND OR d.removed_at IS NOT NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
  -- Lock every claim of this domain, so two organisations checking at once cannot both be verified.
  PERFORM 1 FROM public.organisation_sso_domains WHERE domain = d.domain FOR UPDATE;
  v_problem := app.sso_domain_problem(d.organisation_id, d.domain);

  IF p_found AND v_problem IS NULL THEN
    UPDATE public.organisation_sso_domains
       SET verified_at = coalesce(d.verified_at, now()), verified_by = CASE WHEN d.verified_at IS NULL THEN p_checked_by ELSE d.verified_by END,
           last_checked_at = now(), check_failed_at = NULL, check_error = NULL
     WHERE id = d.id;
    RETURN 'verified';
  END IF;

  IF d.verified_at IS NOT NULL THEN
    -- Verified before: flag it and keep it (an owner decides). Never taken away by a failed lookup.
    UPDATE public.organisation_sso_domains
       SET last_checked_at = now(), check_failed_at = coalesce(d.check_failed_at, now()),
           check_error = coalesce(v_problem, v_error, 'The verification record was not found')
     WHERE id = d.id;
    RETURN 'failed';
  END IF;

  UPDATE public.organisation_sso_domains
     SET last_checked_at = now(), check_error = coalesce(v_problem, v_error, 'The verification record was not found yet')
   WHERE id = d.id;
  RETURN CASE WHEN v_problem IS NOT NULL THEN 'refused' ELSE 'unverified' END;
END $$;

-- Verified domains to look up again: not checked for a week, oldest first.
CREATE FUNCTION app.system_sso_domains_due(p_limit integer DEFAULT 20)
RETURNS TABLE (id uuid, domain text, verification_token text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT d.id, d.domain, d.verification_token FROM public.organisation_sso_domains d
   WHERE d.verified_at IS NOT NULL AND d.removed_at IS NULL AND coalesce(d.last_checked_at, d.verified_at) < now() - interval '7 days'
   ORDER BY coalesce(d.last_checked_at, d.verified_at)
   LIMIT least(greatest(coalesce(p_limit, 20), 1), 200)
$$;

REVOKE ALL ON FUNCTION app.sso_domain_problem(uuid, text), app.organisation_sso_domain_rules(), app.add_sso_domain(uuid, text),
  app.remove_sso_domain(uuid, text), app.system_sso_domain_check(uuid, boolean, text, uuid), app.system_sso_domains_due(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.add_sso_domain(uuid, text), app.remove_sso_domain(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION app.system_sso_domain_check(uuid, boolean, text, uuid), app.system_sso_domains_due(integer) TO qms_api;
