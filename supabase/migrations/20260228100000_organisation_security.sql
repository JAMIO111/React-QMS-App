-- Organisation security, slice SE1 (docs/security-plan.md, decisions S1–S12): network allowlisting in the database.
--
--  * Permissions security.read / security.manage: owner and admin only.
--  * organisation_settings.network_policy: off (default) | monitor (would-be denials are recorded, nobody is blocked) | enforce. Changed only by
--    app.set_network_policy, never by a table write (not in the column UPDATE grant); audited with the settings row.
--  * organisation_networks: approved public networks (Postgres cidr: IPv4 and IPv6, normalised by the database; a single address is /32 or /128).
--    Name unique among live entries; active switch; removed with a reason (kept, hidden, can be brought back inactive); never deleted. Functions only.
--    Refused: host bits set (with the network it probably meant), /0 and very wide ranges (shorter than /8 for IPv4, /16 for IPv6), and private,
--    loopback, link-local, carrier-grade NAT, multicast and unspecified ranges, which the server never sees as a caller's address.
--  * Lockout prevention (S5): enforce needs an active network containing the caller's own address as the API sees it (passed in by the API from
--    req.ip, never by the browser); while enforced, a change that would leave the caller's address outside every active network is refused.
--  * app.network_allowed(org, ip) -> open | allowed | monitored | denied, for the API's organisation guard. No address while enforced is denied.
--  * access_denials: one row per organisation, person, address, hour and mode with a count and the last path. Written only by the API login
--    (app.system_record_access_denial), read with security.read, purged after 90 days (app.system_purge_access_denials). Not audited: it is a log.
-- Errors use QM029 (409 security_rule); another organisation's id is P0002 (404).

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------
INSERT INTO public.permissions (code, description) VALUES
  ('security.read',   'View the organisation''s security settings: network restrictions, approved networks and blocked attempts'),
  ('security.manage', 'Change the organisation''s security settings: network restrictions and approved networks');

WITH grants(key, perms) AS (VALUES
  ('owner', ARRAY['security.read', 'security.manage']),
  ('admin', ARRAY['security.read', 'security.manage'])
)
INSERT INTO public.role_permissions (role_id, permission_code)
SELECT r.id, unnest(g.perms) FROM public.roles r JOIN grants g ON g.key = r.key WHERE r.is_system
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Policy on organisation_settings
-- ---------------------------------------------------------------------------
ALTER TABLE public.organisation_settings
  ADD COLUMN network_policy text NOT NULL DEFAULT 'off' CHECK (network_policy IN ('off', 'monitor', 'enforce')),
  ADD COLUMN network_policy_changed_at timestamptz,
  ADD COLUMN network_policy_changed_by uuid REFERENCES auth.users (id) ON DELETE SET NULL;
-- Deliberately no column UPDATE grant: only app.set_network_policy changes these.

-- ---------------------------------------------------------------------------
-- Networks
-- ---------------------------------------------------------------------------
CREATE TABLE public.organisation_networks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  network cidr NOT NULL,
  active boolean NOT NULL DEFAULT true,
  removed_at timestamptz,
  removed_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  removed_reason text CHECK (removed_reason IS NULL OR length(btrim(removed_reason)) BETWEEN 3 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT organisation_networks_removed_check CHECK ((removed_at IS NULL) = (removed_reason IS NULL) AND (removed_at IS NULL OR NOT active))
);
CREATE UNIQUE INDEX organisation_networks_name_key ON public.organisation_networks (organisation_id, lower(btrim(name))) WHERE removed_at IS NULL;
CREATE UNIQUE INDEX organisation_networks_network_key ON public.organisation_networks (organisation_id, network) WHERE removed_at IS NULL;
CREATE INDEX organisation_networks_org_idx ON public.organisation_networks (organisation_id) WHERE active;

CREATE FUNCTION app.organisation_network_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'An approved network is never deleted. Remove it with a reason.' USING ERRCODE = 'QM029'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER organisation_networks_rules BEFORE UPDATE OR DELETE ON public.organisation_networks FOR EACH ROW EXECUTE FUNCTION app.organisation_network_rules();
CREATE TRIGGER organisation_networks_stamp BEFORE INSERT ON public.organisation_networks FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER organisation_networks_touch BEFORE UPDATE ON public.organisation_networks FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER organisation_networks_org_immutable BEFORE UPDATE ON public.organisation_networks FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.organisation_networks FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.organisation_networks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.organisation_networks FROM anon, authenticated;
GRANT SELECT ON public.organisation_networks TO authenticated;
CREATE POLICY organisation_networks_select ON public.organisation_networks FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'security.read'));

-- ---------------------------------------------------------------------------
-- Blocked attempts
-- ---------------------------------------------------------------------------
CREATE TABLE public.access_denials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  -- The caller's address as text, or 'unknown' when the API could not read one.
  address text NOT NULL CHECK (address = 'unknown' OR length(address) BETWEEN 2 AND 45),
  mode text NOT NULL CHECK (mode IN ('monitor', 'enforce')),
  hour timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  last_path text CHECK (last_path IS NULL OR length(last_path) <= 200),
  first_at timestamptz NOT NULL DEFAULT now(),
  last_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX access_denials_bucket_key ON public.access_denials (organisation_id, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid), address, mode, hour);
CREATE INDEX access_denials_org_idx ON public.access_denials (organisation_id, last_at DESC);
CREATE TRIGGER access_denials_org_immutable BEFORE UPDATE ON public.access_denials FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
ALTER TABLE public.access_denials ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.access_denials FROM anon, authenticated;
GRANT SELECT ON public.access_denials TO authenticated;
CREATE POLICY access_denials_select ON public.access_denials FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'security.read'));

-- ---------------------------------------------------------------------------
-- Rules
-- ---------------------------------------------------------------------------
-- Why a network cannot be approved, or NULL. The server only ever sees public addresses, so private and special ranges could never match.
CREATE FUNCTION app.network_problem(p_network cidr) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE
    WHEN family(p_network) = 4 AND masklen(p_network) < 8 THEN 'That range is too wide: it would allow a large part of the internet. Use /8 or narrower.'
    WHEN family(p_network) = 6 AND masklen(p_network) < 16 THEN 'That range is too wide: it would allow a large part of the internet. Use /16 or narrower.'
    WHEN p_network && ANY (ARRAY['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12',
                                  '192.168.0.0/16', '224.0.0.0/4', '240.0.0.0/4', '::/127', '::ffff:0:0/96', 'fc00::/7', 'fe80::/10', 'ff00::/8']::cidr[])
      THEN 'That is a private or special address range. Fortress only sees the public address your network uses on the internet; ask your IT team for it.'
  END
$$;

-- Read an address or range as typed: trimmed, a single address becomes /32 or /128, IPv4-mapped IPv6 is IPv4. Raises QM029 with a useful message.
CREATE FUNCTION app.parse_network(p_text text) RETURNS cidr
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v_text text := btrim(coalesce(p_text, '')); v_inet inet; v_problem text;
BEGIN
  IF v_text = '' THEN RAISE EXCEPTION 'Enter an address or a range' USING ERRCODE = 'QM029'; END IF;
  BEGIN
    v_inet := v_text::inet;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION '"%" is not an IP address or range (for example 203.0.113.10 or 198.51.100.0/28)', left(v_text, 60) USING ERRCODE = 'QM029';
  END;
  IF position('/' IN v_text) = 0 THEN v_inet := set_masklen(v_inet, CASE family(v_inet) WHEN 4 THEN 32 ELSE 128 END); END IF;
  -- An IPv4 address written as IPv6 (::ffff:203.0.113.10) is the IPv4 address.
  IF family(v_inet) = 6 AND host(v_inet) ~ '^::ffff:[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' AND masklen(v_inet) >= 96 THEN
    v_inet := set_masklen(substring(host(v_inet) FROM 8)::inet, masklen(v_inet) - 96);
  END IF;
  IF host(network(v_inet)) <> host(v_inet) THEN
    RAISE EXCEPTION '% has bits set after the /%: did you mean %?', v_text, masklen(v_inet), network(v_inet)::cidr USING ERRCODE = 'QM029';
  END IF;
  v_problem := app.network_problem(v_inet::cidr);
  IF v_problem IS NOT NULL THEN RAISE EXCEPTION '%', v_problem USING ERRCODE = 'QM029'; END IF;
  RETURN v_inet::cidr;
END $$;

-- An address as one host, with an IPv4 address written as IPv6 (::ffff:203.0.113.10) turned into IPv4, so it matches IPv4 networks.
CREATE FUNCTION app.plain_address(p_address inet) RETURNS inet
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN p_address IS NULL THEN NULL
              WHEN family(p_address) = 6 AND host(p_address) ~ '^::ffff:[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' THEN substring(host(p_address) FROM 8)::inet
              ELSE host(p_address)::inet END
$$;

-- The organisation's policy for one address: open (no restriction), allowed, monitored (would be denied; monitor mode) or denied. NULL when the
-- caller is not a member (so it never reveals another tenant's policy). No address: open when off, monitored when monitoring, denied when enforced.
CREATE FUNCTION app.network_allowed(p_organisation_id uuid, p_address inet) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_policy text; v_match boolean;
BEGIN
  IF NOT app.is_member(p_organisation_id) THEN RETURN NULL; END IF;
  SELECT s.network_policy INTO v_policy FROM public.organisation_settings s WHERE s.organisation_id = p_organisation_id;
  v_policy := coalesce(v_policy, 'off');
  IF v_policy = 'off' THEN RETURN 'open'; END IF;
  p_address := app.plain_address(p_address);
  v_match := p_address IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.organisation_networks n
    WHERE n.organisation_id = p_organisation_id AND n.active AND n.removed_at IS NULL AND p_address <<= n.network);
  IF v_match THEN RETURN 'allowed'; END IF;
  RETURN CASE v_policy WHEN 'monitor' THEN 'monitored' ELSE 'denied' END;
END $$;

-- Whether an address is inside one of the organisation's active networks, optionally ignoring one network or using a changed value for it.
CREATE FUNCTION app.address_covered(p_organisation_id uuid, p_address inet, p_skip uuid DEFAULT NULL, p_replacement cidr DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT a IS NOT NULL AND (
    EXISTS (SELECT 1 FROM public.organisation_networks n
            WHERE n.organisation_id = p_organisation_id AND n.active AND n.removed_at IS NULL
              AND n.id IS DISTINCT FROM p_skip AND a <<= n.network)
    OR (p_replacement IS NOT NULL AND a <<= p_replacement))
  FROM (SELECT app.plain_address(p_address) AS a) x
$$;

CREATE FUNCTION app.assert_security_manager(p_organisation_id uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT app.is_member(p_organisation_id) THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(p_organisation_id, 'security.manage') THEN
    RAISE EXCEPTION 'You are not allowed to change the organisation''s security settings' USING ERRCODE = '42501';
  END IF;
END $$;

CREATE FUNCTION app.current_network_policy(p_organisation_id uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT coalesce((SELECT network_policy FROM public.organisation_settings WHERE organisation_id = p_organisation_id), 'off')
$$;

-- The lockout rule while enforced: after a change the caller's own address must still be covered.
CREATE FUNCTION app.assert_not_locking_out(p_organisation_id uuid, p_address inet, p_skip uuid DEFAULT NULL, p_replacement cidr DEFAULT NULL) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
BEGIN
  IF app.current_network_policy(p_organisation_id) = 'enforce' AND NOT app.address_covered(p_organisation_id, p_address, p_skip, p_replacement) THEN
    RAISE EXCEPTION 'This would block your own address (%) while restrictions are enforced. Add a network that includes it first, or switch to monitor.',
      coalesce(host(p_address), 'unknown') USING ERRCODE = 'QM029';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Functions (SECURITY DEFINER; security.manage)
-- ---------------------------------------------------------------------------
-- Change the mode. Enforcing needs an active network that includes the caller's own address (S5).
CREATE FUNCTION app.set_network_policy(p_organisation_id uuid, p_mode text, p_client_address inet) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_current text;
BEGIN
  PERFORM app.assert_security_manager(p_organisation_id);
  IF p_mode IS NULL OR p_mode NOT IN ('off', 'monitor', 'enforce') THEN RAISE EXCEPTION 'Choose off, monitor or enforce' USING ERRCODE = 'QM029'; END IF;
  SELECT network_policy INTO v_current FROM public.organisation_settings WHERE organisation_id = p_organisation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
  IF v_current = p_mode THEN RETURN p_mode; END IF;
  IF p_mode = 'enforce' THEN
    IF NOT EXISTS (SELECT 1 FROM public.organisation_networks n WHERE n.organisation_id = p_organisation_id AND n.active AND n.removed_at IS NULL) THEN
      RAISE EXCEPTION 'Add at least one approved network before enforcing restrictions' USING ERRCODE = 'QM029';
    END IF;
    IF NOT app.address_covered(p_organisation_id, p_client_address) THEN
      RAISE EXCEPTION 'Your own address (%) is not in an approved network, so enforcing would block you. Add it first.', coalesce(host(p_client_address), 'unknown')
        USING ERRCODE = 'QM029';
    END IF;
  END IF;
  UPDATE public.organisation_settings
     SET network_policy = p_mode, network_policy_changed_at = now(), network_policy_changed_by = auth.uid()
   WHERE organisation_id = p_organisation_id;
  RETURN p_mode;
END $$;

-- Add (p_id NULL) or change a network. Keys: name, network (address or range as typed), active.
CREATE FUNCTION app.save_organisation_network(p_organisation_id uuid, p_data jsonb, p_client_address inet, p_id uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n public.organisation_networks%ROWTYPE; k text; v_name text; v_network cidr; v_active boolean; v_id uuid;
BEGIN
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Send the network as an object' USING ERRCODE = 'QM029'; END IF;
  IF p_id IS NOT NULL THEN
    SELECT * INTO n FROM public.organisation_networks WHERE id = p_id FOR UPDATE;
    IF NOT FOUND OR n.organisation_id IS DISTINCT FROM p_organisation_id OR NOT app.is_member(n.organisation_id) THEN
      RAISE EXCEPTION 'Network not found' USING ERRCODE = 'P0002';
    END IF;
  END IF;
  PERFORM app.assert_security_manager(p_organisation_id);
  IF p_id IS NOT NULL AND n.removed_at IS NOT NULL THEN RAISE EXCEPTION 'This network was removed. Bring it back first.' USING ERRCODE = 'QM029'; END IF;
  FOR k IN SELECT jsonb_object_keys(p_data) LOOP
    IF k NOT IN ('name', 'network', 'active') THEN RAISE EXCEPTION 'Unknown field %', k USING ERRCODE = 'QM029'; END IF;
  END LOOP;
  v_name := CASE WHEN p_data ? 'name' THEN btrim(coalesce(p_data ->> 'name', '')) ELSE n.name END;
  IF coalesce(v_name, '') = '' THEN RAISE EXCEPTION 'Give the network a name, such as Headquarters or Company VPN' USING ERRCODE = 'QM029'; END IF;
  IF length(v_name) > 80 THEN RAISE EXCEPTION 'The name can be at most 80 characters' USING ERRCODE = 'QM029'; END IF;
  v_network := CASE WHEN p_data ? 'network' THEN app.parse_network(p_data ->> 'network') ELSE n.network END;
  IF v_network IS NULL THEN RAISE EXCEPTION 'Enter an address or a range' USING ERRCODE = 'QM029'; END IF;
  v_active := CASE WHEN p_data ? 'active' THEN coalesce((p_data ->> 'active')::boolean, true) WHEN p_id IS NULL THEN true ELSE n.active END;
  IF EXISTS (SELECT 1 FROM public.organisation_networks x WHERE x.organisation_id = p_organisation_id AND x.removed_at IS NULL
               AND x.id IS DISTINCT FROM p_id AND lower(btrim(x.name)) = lower(v_name)) THEN
    RAISE EXCEPTION 'There is already a network called %', v_name USING ERRCODE = 'QM029';
  END IF;
  IF EXISTS (SELECT 1 FROM public.organisation_networks x WHERE x.organisation_id = p_organisation_id AND x.removed_at IS NULL
               AND x.id IS DISTINCT FROM p_id AND x.network = v_network) THEN
    RAISE EXCEPTION '% is already approved', v_network USING ERRCODE = 'QM029';
  END IF;
  IF p_id IS NULL THEN
    IF (SELECT count(*) FROM public.organisation_networks x WHERE x.organisation_id = p_organisation_id AND x.removed_at IS NULL) >= 100 THEN
      RAISE EXCEPTION 'An organisation can have at most 100 approved networks' USING ERRCODE = 'QM029';
    END IF;
    INSERT INTO public.organisation_networks (organisation_id, name, network, active)
    VALUES (p_organisation_id, v_name, v_network, v_active) RETURNING id INTO v_id;
    RETURN v_id;
  END IF;
  -- Changing an entry while enforced must leave the caller covered (the entry itself as changed, or another one).
  PERFORM app.assert_not_locking_out(p_organisation_id, p_client_address, p_id, CASE WHEN v_active THEN v_network END);
  UPDATE public.organisation_networks SET name = v_name, network = v_network, active = v_active WHERE id = p_id;
  RETURN p_id;
END $$;

-- Remove a network with a reason (kept, hidden). While enforced it must not leave the caller outside.
CREATE FUNCTION app.remove_organisation_network(p_id uuid, p_reason text, p_client_address inet) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n public.organisation_networks%ROWTYPE;
BEGIN
  SELECT * INTO n FROM public.organisation_networks WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(n.organisation_id) THEN RAISE EXCEPTION 'Network not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_security_manager(n.organisation_id);
  IF n.removed_at IS NOT NULL THEN RAISE EXCEPTION 'This network was already removed' USING ERRCODE = 'QM029'; END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 3 THEN RAISE EXCEPTION 'Say why the network is being removed' USING ERRCODE = 'QM029'; END IF;
  PERFORM app.assert_not_locking_out(n.organisation_id, p_client_address, p_id);
  UPDATE public.organisation_networks
     SET active = false, removed_at = now(), removed_by = auth.uid(), removed_reason = left(btrim(p_reason), 500)
   WHERE id = p_id;
END $$;

-- Bring a removed network back. It comes back switched off, so restoring never widens access by itself.
CREATE FUNCTION app.restore_organisation_network(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n public.organisation_networks%ROWTYPE;
BEGIN
  SELECT * INTO n FROM public.organisation_networks WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(n.organisation_id) THEN RAISE EXCEPTION 'Network not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_security_manager(n.organisation_id);
  IF n.removed_at IS NULL THEN RAISE EXCEPTION 'This network was not removed' USING ERRCODE = 'QM029'; END IF;
  IF EXISTS (SELECT 1 FROM public.organisation_networks x WHERE x.organisation_id = n.organisation_id AND x.removed_at IS NULL
               AND (x.network = n.network OR lower(btrim(x.name)) = lower(btrim(n.name)))) THEN
    RAISE EXCEPTION 'Another network already has this name or range' USING ERRCODE = 'QM029';
  END IF;
  UPDATE public.organisation_networks SET removed_at = NULL, removed_by = NULL, removed_reason = NULL, active = false WHERE id = p_id;
END $$;

-- ---------------------------------------------------------------------------
-- System functions (the API login only)
-- ---------------------------------------------------------------------------
-- Record a blocked (enforce) or would-be blocked (monitor) request: one row per organisation, person, address, mode and hour, counting attempts.
CREATE FUNCTION app.system_record_access_denial(p_organisation_id uuid, p_user_id uuid, p_address text, p_mode text, p_path text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_address text := coalesce(nullif(btrim(p_address), ''), 'unknown'); v_hour timestamptz := date_trunc('hour', now());
BEGIN
  IF p_mode NOT IN ('monitor', 'enforce') THEN RAISE EXCEPTION 'Unknown mode' USING ERRCODE = 'QM029'; END IF;
  IF v_address <> 'unknown' THEN
    BEGIN v_address := host(v_address::inet); EXCEPTION WHEN others THEN v_address := 'unknown'; END;
  END IF;
  INSERT INTO public.access_denials (organisation_id, user_id, address, mode, hour, last_path)
  VALUES (p_organisation_id, p_user_id, v_address, p_mode, v_hour, left(split_part(coalesce(p_path, ''), '?', 1), 200))
  ON CONFLICT (organisation_id, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid), address, mode, hour)
  DO UPDATE SET attempts = public.access_denials.attempts + 1, last_at = now(), last_path = EXCLUDED.last_path;
END $$;

-- Clear blocked attempts older than 90 days. Returns how many were cleared.
CREATE FUNCTION app.system_purge_access_denials() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_count integer;
BEGIN
  DELETE FROM public.access_denials WHERE last_at < now() - interval '90 days';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION app.network_problem(cidr), app.parse_network(text), app.plain_address(inet), app.address_covered(uuid, inet, uuid, cidr),
  app.current_network_policy(uuid), app.assert_not_locking_out(uuid, inet, uuid, cidr), app.organisation_network_rules(),
  app.system_record_access_denial(uuid, uuid, text, text, text), app.system_purge_access_denials() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.network_allowed(uuid, inet), app.assert_security_manager(uuid), app.set_network_policy(uuid, text, inet),
  app.save_organisation_network(uuid, jsonb, inet, uuid), app.remove_organisation_network(uuid, text, inet), app.restore_organisation_network(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.network_allowed(uuid, inet), app.set_network_policy(uuid, text, inet), app.save_organisation_network(uuid, jsonb, inet, uuid),
  app.remove_organisation_network(uuid, text, inet), app.restore_organisation_network(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION app.system_record_access_denial(uuid, uuid, text, text, text), app.system_purge_access_denials() TO qms_api;
