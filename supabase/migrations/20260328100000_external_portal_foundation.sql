-- External portal, slice PT1 (docs/external-portal-plan.md, decisions X1–X18): the foundation for suppliers and customers signing in.
--
--  * Permissions external_access.read / .manage (owner, admin, quality manager). Admin rights, so unpriced (never tied to a package).
--  * organisation_settings.portal_enabled (default off), portal_ranking_enabled (used by a later slice), portal_require_mfa (default on).
--    Changed only by app.set_portal_settings; not in the column UPDATE grant.
--  * portal_parties: the opt-in per supplier or customer (X6): enabled, the tiles they see, the contact name shown to them (PT0 default),
--    and a reserved nullable linked_organisation_id (X13: nothing reads it yet).
--  * external_access: one row per person per party (X1: one sign-in, many organisations). invited -> active -> suspended | removed. The person is
--    NEVER a member: no organisation_users row, no role, no seat, so app.is_member is false for them and every existing RLS rule refuses them.
--    Written only by functions. Read by external_access.read, or by the person themselves.
--  * Portal reads (later slices) go through functions that take the party from the access row, never from the request.
-- Errors use QM032 (409 portal_rule); another organisation's id is P0002 (404).

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------
INSERT INTO public.permissions (code, description) VALUES
  ('external_access.read',   'See which suppliers and customers have portal access, who their people are and when they last signed in'),
  ('external_access.manage', 'Switch the supplier and customer portal on or off, choose who may use it and invite or remove their people');

WITH grants(key, perms) AS (VALUES
  ('owner',           ARRAY['external_access.read', 'external_access.manage']),
  ('admin',           ARRAY['external_access.read', 'external_access.manage']),
  ('quality_manager', ARRAY['external_access.read', 'external_access.manage'])
)
INSERT INTO public.role_permissions (role_id, permission_code)
SELECT r.id, unnest(g.perms) FROM public.roles r JOIN grants g ON g.key = r.key WHERE r.is_system
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION app.unpriced_permissions() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT app.gated_permissions() || ARRAY['members.read', 'members.manage', 'roles.manage', 'security.read', 'security.manage',
                                         'external_access.read', 'external_access.manage']
$$;

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------
ALTER TABLE public.organisation_settings
  ADD COLUMN portal_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN portal_ranking_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN portal_require_mfa boolean NOT NULL DEFAULT true;
-- Deliberately no column UPDATE grant: only app.set_portal_settings changes these.

-- ---------------------------------------------------------------------------
-- Parties
-- ---------------------------------------------------------------------------
CREATE TABLE public.portal_parties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  party_kind text NOT NULL CHECK (party_kind IN ('supplier', 'customer')),
  supplier_id uuid,
  customer_id uuid,
  enabled boolean NOT NULL DEFAULT false,
  -- Which tiles the party sees on its home page (keys decided by later slices); an empty object means the defaults.
  tiles jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(tiles) = 'object' AND length(tiles::text) <= 2000),
  contact_name text CHECK (contact_name IS NULL OR length(btrim(contact_name)) BETWEEN 1 AND 120),
  -- Reserved (X13): the party's own Fortress organisation, if it has one. Nothing reads it yet.
  linked_organisation_id uuid REFERENCES public.organisations (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT portal_parties_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT portal_parties_one_party CHECK ((party_kind = 'supplier' AND supplier_id IS NOT NULL AND customer_id IS NULL)
                                          OR (party_kind = 'customer' AND customer_id IS NOT NULL AND supplier_id IS NULL)),
  CONSTRAINT portal_parties_supplier_fkey FOREIGN KEY (supplier_id, organisation_id) REFERENCES public.suppliers (id, organisation_id),
  CONSTRAINT portal_parties_customer_fkey FOREIGN KEY (customer_id, organisation_id) REFERENCES public.customers (id, organisation_id)
);
CREATE UNIQUE INDEX portal_parties_supplier_key ON public.portal_parties (organisation_id, supplier_id) WHERE supplier_id IS NOT NULL;
CREATE UNIQUE INDEX portal_parties_customer_key ON public.portal_parties (organisation_id, customer_id) WHERE customer_id IS NOT NULL;

CREATE FUNCTION app.portal_party_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A portal party is never deleted. Switch it off instead.' USING ERRCODE = 'QM032'; END IF;
  IF NEW.party_kind <> OLD.party_kind OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id OR NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN
    RAISE EXCEPTION 'Which supplier or customer a portal party is cannot change' USING ERRCODE = 'QM032';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER portal_parties_rules BEFORE UPDATE OR DELETE ON public.portal_parties FOR EACH ROW EXECUTE FUNCTION app.portal_party_rules();
CREATE TRIGGER portal_parties_stamp BEFORE INSERT ON public.portal_parties FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER portal_parties_touch BEFORE UPDATE ON public.portal_parties FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER portal_parties_org_immutable BEFORE UPDATE ON public.portal_parties FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.portal_parties FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.portal_parties ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.portal_parties FROM anon, authenticated;
GRANT SELECT ON public.portal_parties TO authenticated;
CREATE POLICY portal_parties_select ON public.portal_parties FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'external_access.read'));

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------
CREATE TABLE public.external_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  party_id uuid NOT NULL,
  invited_email text NOT NULL CHECK (invited_email = lower(invited_email) AND invited_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND length(invited_email) <= 254),
  user_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  status text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'suspended', 'removed')),
  invite_message text CHECK (invite_message IS NULL OR length(btrim(invite_message)) BETWEEN 1 AND 500),
  invited_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  invited_at timestamptz NOT NULL DEFAULT now(),
  invite_expires_at timestamptz,
  last_sent_at timestamptz,
  send_count integer NOT NULL DEFAULT 0,
  accepted_at timestamptz,
  last_sign_in_at timestamptz,
  suspended_at timestamptz,
  suspended_reason text CHECK (suspended_reason IS NULL OR length(btrim(suspended_reason)) BETWEEN 3 AND 500),
  removed_at timestamptz,
  removed_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  removed_reason text CHECK (removed_reason IS NULL OR length(btrim(removed_reason)) BETWEEN 3 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT external_access_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT external_access_party_fkey FOREIGN KEY (party_id, organisation_id) REFERENCES public.portal_parties (id, organisation_id),
  CONSTRAINT external_access_active_has_user CHECK (status NOT IN ('active', 'suspended') OR user_id IS NOT NULL),
  CONSTRAINT external_access_removed_check CHECK ((status = 'removed') = (removed_at IS NOT NULL) AND (status <> 'removed' OR removed_reason IS NOT NULL))
);
-- One live row per person (by address) and per signed-in account in a party.
CREATE UNIQUE INDEX external_access_email_key ON public.external_access (party_id, invited_email) WHERE status <> 'removed';
CREATE UNIQUE INDEX external_access_user_key ON public.external_access (party_id, user_id) WHERE user_id IS NOT NULL AND status <> 'removed';
CREATE INDEX external_access_user_idx ON public.external_access (user_id) WHERE user_id IS NOT NULL AND status IN ('active', 'suspended');
CREATE INDEX external_access_email_idx ON public.external_access (invited_email) WHERE status = 'invited';

CREATE FUNCTION app.external_access_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Portal access is never deleted. Remove it with a reason.' USING ERRCODE = 'QM032'; END IF;
  IF NEW.party_id <> OLD.party_id OR NEW.invited_email <> OLD.invited_email THEN
    RAISE EXCEPTION 'The party and the address of an invitation cannot change' USING ERRCODE = 'QM032';
  END IF;
  IF OLD.status = 'removed' THEN RAISE EXCEPTION 'Removed access cannot be changed. Invite the person again.' USING ERRCODE = 'QM032'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER external_access_rules BEFORE UPDATE OR DELETE ON public.external_access FOR EACH ROW EXECUTE FUNCTION app.external_access_rules();
CREATE TRIGGER external_access_stamp BEFORE INSERT ON public.external_access FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER external_access_touch BEFORE UPDATE ON public.external_access FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER external_access_org_immutable BEFORE UPDATE ON public.external_access FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.external_access FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.external_access ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.external_access FROM anon, authenticated;
GRANT SELECT ON public.external_access TO authenticated;
CREATE POLICY external_access_select ON public.external_access FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'external_access.read') OR user_id = (SELECT auth.uid()));

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
-- The caller's own live access in an organisation, only while the organisation, its portal and the party are all switched on.
CREATE FUNCTION app.portal_my_access(p_organisation_id uuid)
RETURNS TABLE (access_id uuid, party_id uuid, party_kind text, supplier_id uuid, customer_id uuid, role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT a.id, p.id, p.party_kind, p.supplier_id, p.customer_id, a.role
    FROM public.external_access a
    JOIN public.portal_parties p ON p.id = a.party_id AND p.organisation_id = a.organisation_id AND p.enabled
    JOIN public.organisation_settings s ON s.organisation_id = a.organisation_id AND s.portal_enabled
    JOIN public.organisations o ON o.id = a.organisation_id AND o.status = 'active'
   WHERE a.organisation_id = p_organisation_id AND a.user_id = auth.uid() AND a.status = 'active'
$$;
REVOKE ALL ON FUNCTION app.portal_my_access(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_my_access(uuid) TO authenticated;

-- True when the organisation asks external people for two-factor and this session has not passed it.
CREATE FUNCTION app.portal_mfa_blocked(p_organisation_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce((SELECT s.portal_require_mfa AND app.session_aal() <> 'aal2'
                     FROM public.organisation_settings s WHERE s.organisation_id = p_organisation_id), false)
$$;
REVOKE ALL ON FUNCTION app.portal_mfa_blocked(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_mfa_blocked(uuid) TO authenticated;

-- Is the caller an active admin of that party (and so allowed to invite and remove their own colleagues)?
CREATE FUNCTION app.portal_is_party_admin(p_party_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.external_access a
                   JOIN public.portal_parties p ON p.id = a.party_id AND p.enabled
                   JOIN public.organisation_settings s ON s.organisation_id = a.organisation_id AND s.portal_enabled
                  WHERE a.party_id = p_party_id AND a.user_id = auth.uid() AND a.status = 'active' AND a.role = 'admin')
$$;
REVOKE ALL ON FUNCTION app.portal_is_party_admin(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_is_party_admin(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Staff: settings and parties
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.set_portal_settings(p_organisation_id uuid, p_enabled boolean, p_ranking boolean, p_require_mfa boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT app.has_permission(p_organisation_id, 'external_access.manage') THEN
    RAISE EXCEPTION 'external_access.manage required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.organisation_settings
     SET portal_enabled = coalesce(p_enabled, portal_enabled),
         portal_ranking_enabled = coalesce(p_ranking, portal_ranking_enabled),
         portal_require_mfa = coalesce(p_require_mfa, portal_require_mfa)
   WHERE organisation_id = p_organisation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'organisation not found' USING ERRCODE = 'no_data_found'; END IF;
END $$;
REVOKE ALL ON FUNCTION app.set_portal_settings(uuid, boolean, boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.set_portal_settings(uuid, boolean, boolean, boolean) TO authenticated;

-- Opt a supplier or customer in or out (creates the row the first time). Switching a party off ends its people's access at once
-- (app.portal_my_access needs the party enabled) but keeps their rows.
CREATE FUNCTION app.set_portal_party(p_organisation_id uuid, p_kind text, p_party uuid, p_enabled boolean, p_contact_name text DEFAULT NULL,
                                     p_tiles jsonb DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT app.has_permission(p_organisation_id, 'external_access.manage') THEN
    RAISE EXCEPTION 'external_access.manage required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_kind NOT IN ('supplier', 'customer') THEN RAISE EXCEPTION 'The party must be a supplier or a customer' USING ERRCODE = 'QM032'; END IF;
  IF p_kind = 'supplier' AND NOT EXISTS (SELECT 1 FROM public.suppliers WHERE id = p_party AND organisation_id = p_organisation_id) THEN
    RAISE EXCEPTION 'supplier not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_kind = 'customer' AND NOT EXISTS (SELECT 1 FROM public.customers WHERE id = p_party AND organisation_id = p_organisation_id) THEN
    RAISE EXCEPTION 'customer not found' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT id INTO v_id FROM public.portal_parties
   WHERE organisation_id = p_organisation_id AND ((p_kind = 'supplier' AND supplier_id = p_party) OR (p_kind = 'customer' AND customer_id = p_party))
   FOR UPDATE;
  IF v_id IS NULL THEN
    INSERT INTO public.portal_parties (organisation_id, party_kind, supplier_id, customer_id, enabled, contact_name, tiles)
    VALUES (p_organisation_id, p_kind, CASE WHEN p_kind = 'supplier' THEN p_party END, CASE WHEN p_kind = 'customer' THEN p_party END,
            coalesce(p_enabled, false), nullif(btrim(p_contact_name), ''), coalesce(p_tiles, '{}'::jsonb))
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.portal_parties
       SET enabled = coalesce(p_enabled, enabled),
           contact_name = CASE WHEN p_contact_name IS NULL THEN contact_name ELSE nullif(btrim(p_contact_name), '') END,
           tiles = coalesce(p_tiles, tiles)
     WHERE id = v_id;
  END IF;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION app.set_portal_party(uuid, text, uuid, boolean, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.set_portal_party(uuid, text, uuid, boolean, text, jsonb) TO authenticated;

-- ---------------------------------------------------------------------------
-- Invitations (staff with external_access.manage, or an active admin of the same party)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.invite_external_user(p_party_id uuid, p_email text, p_role text DEFAULT 'member', p_message text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_org uuid; v_enabled boolean; v_email text := lower(btrim(coalesce(p_email, ''))); v_staff boolean; v_id uuid;
BEGIN
  SELECT p.organisation_id, p.enabled INTO v_org, v_enabled FROM public.portal_parties p WHERE p.id = p_party_id;
  IF v_org IS NULL THEN RAISE EXCEPTION 'party not found' USING ERRCODE = 'no_data_found'; END IF;
  v_staff := app.has_permission(v_org, 'external_access.manage');
  IF NOT v_staff AND NOT app.portal_is_party_admin(p_party_id) THEN
    RAISE EXCEPTION 'external_access.manage required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_role NOT IN ('admin', 'member') THEN RAISE EXCEPTION 'The role must be admin or member' USING ERRCODE = 'QM032'; END IF;
  -- Only staff create an admin (X7: the first contact); a party's own admin invites ordinary colleagues.
  IF p_role = 'admin' AND NOT v_staff THEN RAISE EXCEPTION 'Only the organisation can make someone an admin' USING ERRCODE = 'QM032'; END IF;
  IF NOT v_enabled OR NOT EXISTS (SELECT 1 FROM public.organisation_settings WHERE organisation_id = v_org AND portal_enabled) THEN
    RAISE EXCEPTION 'The portal is not switched on for this supplier or customer' USING ERRCODE = 'QM032';
  END IF;
  IF v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' OR length(v_email) > 254 THEN RAISE EXCEPTION 'Enter a valid email address' USING ERRCODE = 'QM032'; END IF;
  -- External people are never members (X1): an address that belongs to one of the organisation's own people cannot be invited.
  IF EXISTS (SELECT 1 FROM public.organisation_users m WHERE m.organisation_id = v_org AND m.status IN ('active', 'invited', 'suspended')
                AND (m.invited_email = v_email OR m.user_id IN (SELECT u.id FROM auth.users u WHERE lower(u.email) = v_email))) THEN
    RAISE EXCEPTION 'That address belongs to one of your own people. External access is for people outside the organisation.' USING ERRCODE = 'QM032';
  END IF;
  IF p_message IS NOT NULL AND length(btrim(p_message)) > 500 THEN RAISE EXCEPTION 'The message is too long (500 characters at most)' USING ERRCODE = 'QM032'; END IF;
  IF EXISTS (SELECT 1 FROM public.external_access WHERE party_id = p_party_id AND invited_email = v_email AND status <> 'removed') THEN
    RAISE EXCEPTION 'That address already has access or a pending invitation' USING ERRCODE = 'QM032';
  END IF;
  INSERT INTO public.external_access (organisation_id, party_id, invited_email, role, status, invite_message, invite_expires_at, last_sent_at, send_count)
  VALUES (v_org, p_party_id, v_email, p_role, 'invited', nullif(btrim(p_message), ''), now() + interval '7 days', now(), 1)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION app.invite_external_user(uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.invite_external_user(uuid, text, text, text) TO authenticated;

-- Resend: not within a minute, at most ten times, another seven days.
CREATE FUNCTION app.resend_external_invitation(p_access_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.external_access;
BEGIN
  SELECT * INTO a FROM public.external_access WHERE id = p_access_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invitation not found' USING ERRCODE = 'no_data_found'; END IF;
  IF NOT app.has_permission(a.organisation_id, 'external_access.manage') AND NOT app.portal_is_party_admin(a.party_id) THEN
    RAISE EXCEPTION 'external_access.manage required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF a.status <> 'invited' THEN RAISE EXCEPTION 'Only a pending invitation can be sent again' USING ERRCODE = 'QM032'; END IF;
  IF a.last_sent_at > now() - interval '60 seconds' THEN RAISE EXCEPTION 'This invitation was just sent. Wait a minute before sending it again.' USING ERRCODE = 'QM032'; END IF;
  IF a.send_count >= 10 THEN RAISE EXCEPTION 'This invitation has been sent ten times. Remove it and invite the person again.' USING ERRCODE = 'QM032'; END IF;
  UPDATE public.external_access SET last_sent_at = now(), send_count = send_count + 1, invite_expires_at = now() + interval '7 days' WHERE id = p_access_id;
END $$;
REVOKE ALL ON FUNCTION app.resend_external_invitation(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.resend_external_invitation(uuid) TO authenticated;

-- Remove (an invitation or a person's access) with a reason: staff, or a party admin for their own colleagues (not themselves).
CREATE FUNCTION app.remove_external_access(p_access_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.external_access; v_staff boolean;
BEGIN
  SELECT * INTO a FROM public.external_access WHERE id = p_access_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'access not found' USING ERRCODE = 'no_data_found'; END IF;
  v_staff := app.has_permission(a.organisation_id, 'external_access.manage');
  IF NOT v_staff AND NOT app.portal_is_party_admin(a.party_id) THEN
    RAISE EXCEPTION 'external_access.manage required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT v_staff AND a.user_id = auth.uid() THEN RAISE EXCEPTION 'You cannot remove your own access. Ask the organisation.' USING ERRCODE = 'QM032'; END IF;
  IF NOT v_staff AND a.role = 'admin' THEN RAISE EXCEPTION 'Only the organisation can remove a party admin' USING ERRCODE = 'QM032'; END IF;
  IF a.status = 'removed' THEN RAISE EXCEPTION 'That access is already removed' USING ERRCODE = 'QM032'; END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 3 THEN RAISE EXCEPTION 'Give a reason (at least 3 characters)' USING ERRCODE = 'QM032'; END IF;
  UPDATE public.external_access SET status = 'removed', removed_at = now(), removed_by = auth.uid(), removed_reason = btrim(p_reason) WHERE id = p_access_id;
END $$;
REVOKE ALL ON FUNCTION app.remove_external_access(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.remove_external_access(uuid, text) TO authenticated;

-- Suspend and bring back (staff only).
CREATE FUNCTION app.set_external_access_suspended(p_access_id uuid, p_suspended boolean, p_reason text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.external_access;
BEGIN
  SELECT * INTO a FROM public.external_access WHERE id = p_access_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'access not found' USING ERRCODE = 'no_data_found'; END IF;
  IF NOT app.has_permission(a.organisation_id, 'external_access.manage') THEN
    RAISE EXCEPTION 'external_access.manage required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_suspended THEN
    IF a.status <> 'active' THEN RAISE EXCEPTION 'Only active access can be suspended' USING ERRCODE = 'QM032'; END IF;
    IF length(btrim(coalesce(p_reason, ''))) < 3 THEN RAISE EXCEPTION 'Give a reason (at least 3 characters)' USING ERRCODE = 'QM032'; END IF;
    UPDATE public.external_access SET status = 'suspended', suspended_at = now(), suspended_reason = btrim(p_reason) WHERE id = p_access_id;
  ELSE
    IF a.status <> 'suspended' THEN RAISE EXCEPTION 'Only suspended access can be brought back' USING ERRCODE = 'QM032'; END IF;
    UPDATE public.external_access SET status = 'active', suspended_at = NULL, suspended_reason = NULL WHERE id = p_access_id;
  END IF;
END $$;
REVOKE ALL ON FUNCTION app.set_external_access_suspended(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.set_external_access_suspended(uuid, boolean, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- The person: invitations waiting for them, accepting, and where they have access
-- ---------------------------------------------------------------------------
-- Matched by the confirmed address on the caller's account (as for member invitations).
CREATE FUNCTION app.my_portal_invitations()
RETURNS TABLE (access_id uuid, organisation_id uuid, organisation_name text, party_kind text, party_name text, role text,
               invited_by_name text, message text, expires_at timestamptz, expired boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT a.id, o.id, o.name, p.party_kind, coalesce(sup.name, cus.name),
         a.role, nullif(trim(coalesce(pr.first_name, '') || ' ' || coalesce(pr.surname, '')), ''),
         a.invite_message, a.invite_expires_at, (a.invite_expires_at IS NOT NULL AND a.invite_expires_at <= now())
    FROM public.external_access a
    JOIN public.portal_parties p ON p.id = a.party_id AND p.organisation_id = a.organisation_id
    JOIN public.organisations o ON o.id = a.organisation_id AND o.status = 'active'
    JOIN auth.users me ON me.id = auth.uid() AND me.email_confirmed_at IS NOT NULL
    LEFT JOIN public.suppliers sup ON sup.id = p.supplier_id
    LEFT JOIN public.customers cus ON cus.id = p.customer_id
    LEFT JOIN public.profiles pr ON pr.id = a.invited_by
   WHERE a.status = 'invited' AND a.invited_email = lower(me.email)
   ORDER BY a.invited_at DESC
$$;
REVOKE ALL ON FUNCTION app.my_portal_invitations() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.my_portal_invitations() TO authenticated;

CREATE FUNCTION app.accept_portal_invitation(p_access_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := auth.uid(); v_email text; a public.external_access;
BEGIN
  SELECT lower(u.email) INTO v_email FROM auth.users u WHERE u.id = v_user AND u.email_confirmed_at IS NOT NULL;
  IF v_user IS NULL OR v_email IS NULL THEN RAISE EXCEPTION 'sign in to accept an invitation' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT x.* INTO a FROM public.external_access x
    JOIN public.organisations o ON o.id = x.organisation_id AND o.status = 'active'
   WHERE x.id = p_access_id AND x.status = 'invited' AND x.invited_email = v_email FOR UPDATE OF x;
  IF NOT FOUND THEN RAISE EXCEPTION 'invitation not found' USING ERRCODE = 'no_data_found'; END IF;
  IF a.invite_expires_at IS NOT NULL AND a.invite_expires_at <= now() THEN RAISE EXCEPTION 'This invitation has expired. Ask for a new one.' USING ERRCODE = 'QM032'; END IF;
  IF EXISTS (SELECT 1 FROM public.external_access WHERE party_id = a.party_id AND user_id = v_user AND status <> 'removed') THEN
    RAISE EXCEPTION 'You already have access for this supplier or customer' USING ERRCODE = 'QM032';
  END IF;
  UPDATE public.external_access SET user_id = v_user, status = 'active', accepted_at = now(), last_sign_in_at = now() WHERE id = p_access_id;
  RETURN a.organisation_id;
END $$;
REVOKE ALL ON FUNCTION app.accept_portal_invitation(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.accept_portal_invitation(uuid) TO authenticated;

-- Where the caller may use the portal (the organisation switcher and /me). Suspended access and switched-off portals are not listed.
CREATE FUNCTION app.my_portal_access()
RETURNS TABLE (access_id uuid, organisation_id uuid, organisation_name text, party_id uuid, party_kind text, party_name text, role text,
               contact_name text, mfa_required boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT a.id, o.id, o.name, p.id, p.party_kind, coalesce(sup.name, cus.name), a.role, p.contact_name, app.portal_mfa_blocked(o.id)
    FROM public.external_access a
    JOIN public.portal_parties p ON p.id = a.party_id AND p.organisation_id = a.organisation_id AND p.enabled
    JOIN public.organisation_settings s ON s.organisation_id = a.organisation_id AND s.portal_enabled
    JOIN public.organisations o ON o.id = a.organisation_id AND o.status = 'active'
    LEFT JOIN public.suppliers sup ON sup.id = p.supplier_id
    LEFT JOIN public.customers cus ON cus.id = p.customer_id
   WHERE a.user_id = auth.uid() AND a.status = 'active'
   ORDER BY o.name, 6
$$;
REVOKE ALL ON FUNCTION app.my_portal_access() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.my_portal_access() TO authenticated;

-- Records a request from the person at most once an hour (last sign-in for the access report).
CREATE FUNCTION app.portal_record_sign_in(p_organisation_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  UPDATE public.external_access SET last_sign_in_at = now()
   WHERE organisation_id = p_organisation_id AND user_id = auth.uid() AND status = 'active'
     AND (last_sign_in_at IS NULL OR last_sign_in_at < now() - interval '1 hour')
$$;
REVOKE ALL ON FUNCTION app.portal_record_sign_in(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_record_sign_in(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Staff and party-admin reading: the people list and the access report
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.list_external_access(p_organisation_id uuid, p_party_id uuid DEFAULT NULL)
RETURNS TABLE (access_id uuid, party_id uuid, party_kind text, party_name text, email text, first_name text, surname text, role text, status text,
               invited_at timestamptz, invite_expires_at timestamptz, send_count integer, accepted_at timestamptz, last_sign_in_at timestamptz,
               suspended_reason text, removed_at timestamptz, removed_reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT app.has_permission(p_organisation_id, 'external_access.read')
     AND NOT (p_party_id IS NOT NULL AND app.portal_is_party_admin(p_party_id)) THEN
    RAISE EXCEPTION 'external_access.read required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT a.id, p.id, p.party_kind, coalesce(sup.name, cus.name), coalesce(u.email::text, a.invited_email), pr.first_name, pr.surname,
         a.role, a.status, a.invited_at, a.invite_expires_at, a.send_count, a.accepted_at, a.last_sign_in_at, a.suspended_reason,
         a.removed_at, a.removed_reason
    FROM public.external_access a
    JOIN public.portal_parties p ON p.id = a.party_id AND p.organisation_id = a.organisation_id
    LEFT JOIN public.suppliers sup ON sup.id = p.supplier_id
    LEFT JOIN public.customers cus ON cus.id = p.customer_id
    LEFT JOIN auth.users u ON u.id = a.user_id
    LEFT JOIN public.profiles pr ON pr.id = a.user_id
   WHERE a.organisation_id = p_organisation_id AND (p_party_id IS NULL OR a.party_id = p_party_id)
   ORDER BY coalesce(sup.name, cus.name), a.status = 'removed', a.invited_at DESC;
END $$;
REVOKE ALL ON FUNCTION app.list_external_access(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.list_external_access(uuid, uuid) TO authenticated;

-- Trigger functions are not callable by anyone.
REVOKE ALL ON FUNCTION app.portal_party_rules(), app.external_access_rules() FROM PUBLIC, anon, authenticated;

-- The organisation's maximum session age (security plan S11) applies to its external people too (PT0 T8); only someone with live access can ask.
CREATE FUNCTION app.portal_max_session_hours(p_organisation_id uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT s.max_session_hours FROM public.organisation_settings s
   WHERE s.organisation_id = p_organisation_id AND EXISTS (SELECT 1 FROM app.portal_my_access(p_organisation_id))
$$;
REVOKE ALL ON FUNCTION app.portal_max_session_hours(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_max_session_hours(uuid) TO authenticated;

-- The sign-in drift check (SS4): every column that names a user is classified.
CREATE OR REPLACE FUNCTION app.user_reference_columns()
RETURNS TABLE (table_name text, column_name text, treatment text, note text)
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  VALUES
    ('organisation_users', 'user_id', 'membership', 'Roles, departments, seat and 8D team places hang off the membership and move with it'),
    ('Employees', 'auth_id', 'moved', 'The employee record linked to the sign-in'),
    ('audit_definitions', 'auditor_user_id', 'moved', 'Expected auditor of audits in use'),
    ('control_plans', 'owner_id', 'moved', 'Owner of control plans in use'),
    ('document_recipients', 'user_id', 'moved', 'Documents in force still to read'),
    ('document_revision_reviewers', 'user_id', 'moved', 'Reviewer named on a revision not yet approved'),
    ('document_revisions', 'approver_id', 'moved', 'Approver named on a revision not yet approved'),
    ('document_signoffs', 'user_id', 'moved', 'Sign-offs still waiting'),
    ('documents', 'owner_user_id', 'moved', 'Owner of documents not withdrawn or discarded'),
    ('gauges', 'custodian_id', 'moved', 'Custodian of gauges in use'),
    ('management_review_actions', 'owner_user_id', 'moved', 'Open review actions'),
    ('management_review_attendees', 'user_id', 'moved', 'Attendee of reviews not yet held'),
    ('management_reviews', 'chair_user_id', 'moved', 'Chair of reviews not yet held'),
    ('nonconformances', 'owner_id', 'moved', 'Owner of open non-conformances'),
    ('notification_preferences', 'user_id', 'moved', 'Notification choices in this organisation'),
    ('quality_alert_recipients', 'user_id', 'moved', 'Quality alerts in force still to acknowledge'),
    ('quality_objectives', 'owner_user_id', 'moved', 'Owner of objectives in use'),
    ('reminder_preferences', 'user_id', 'moved', 'Reminder choices in this organisation'),
    ('risk_actions', 'owner_user_id', 'moved', 'Open risk actions'),
    ('risks', 'owner_user_id', 'moved', 'Owner of risks not closed or retired'),
    ('saved_filters', 'user_id', 'moved', 'Saved filters in this organisation'),
    ('supplier_scars', 'owner_user_id', 'moved', 'Owner of running SCARs'),
    ('workflow_tasks', 'assignee_user_id', 'moved', 'Open tasks'),
    ('integration_import_settings', 'schedule_set_by', 'moved', 'Whose authority a daily import runs with'),
    ('supplier_scorecard_schedules', 'set_by', 'moved', 'Whose authority scheduled scorecards are worked out with'),
    ('access_denials', 'user_id', 'history', 'Blocked attempts'),
    ('calibrations', 'technician_id', 'history', 'Who calibrated'),
    ('competence_assessments', 'assessor_user_id', 'history', 'Who assessed'),
    ('document_revisions', 'author_id', 'history', 'Who wrote a revision'),
    ('email_outbox', 'user_id', 'history', 'Emails sent'),
    ('integration_agent_events', 'actor_user_id', 'history', 'Who acted on an agent'),
    ('integration_connection_events', 'by', 'history', 'Who acted on a connection'),
    ('notification_reads', 'user_id', 'history', 'Notices read'),
    ('notifications', 'recipient_user_id', 'history', 'Notices addressed to them'),
    ('notifications', 'actor_user_id', 'history', 'Who caused a notice'),
    ('outbox_events', 'actor_user_id', 'history', 'Who caused an event'),
    ('idempotency_keys', 'user_id', 'history', 'Requests already handled'),
    ('quality_alert_events', 'actor_id', 'history', 'Who reopened an alert'),
    ('reminder_digests', 'user_id', 'history', 'Reminders sent'),
    ('reminder_overdue_notices', 'user_id', 'history', 'Overdue notices sent'),
    ('sso_break_glass_members', 'user_id', 'history', 'Break-glass is a password account; the company account cannot be one'),
    ('sso_changes', 'user_id', 'history', 'Single sign-on history'),
    ('sso_sign_ins', 'user_id', 'history', 'Sign-ins'),
    ('subscription_audit_logs', 'actor_user_id', 'history', 'Who changed the subscription'),
    ('workflow_notices', 'user_id', 'history', 'Notices sent'),
    ('sso_account_moves', 'from_user_id', 'history', 'Moves'),
    ('sso_account_moves', 'to_user_id', 'history', 'Moves'),
    ('sso_match_dismissals', 'password_user_id', 'history', 'Pairs that are not the same person'),
    ('sso_match_dismissals', 'sso_user_id', 'history', 'Pairs that are not the same person'),
    ('external_access', 'user_id', 'history', 'External portal access stays with the account it was given to; a moved person is invited again'),
    ('profiles', 'id', 'personal', 'The account''s own profile'),
    ('platform_admins', 'user_id', 'personal', 'Platform operators'),
    ('signup_events', 'user_id', 'personal', 'Sign-up funnel')
$$;
