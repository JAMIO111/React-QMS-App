-- External portal, slice PT2 (docs/external-portal-plan.md §6, decisions X2, X9, X11, X12, X15; PT0 §8.2): sharing non-conformances and 8Ds with a
-- supplier or customer, a comment thread on each shared record, who has seen it, and the curated external view of each.
--
--  * Permission external_access.share (owner, admin, quality manager, quality engineer; unpriced): share, withdraw and comment as staff.
--  * portal_shares: one row per record shared with one party (an NC, or an 8D). Written by functions only; a share is withdrawn (with a reason),
--    never deleted, and withdrawing hides the record from the party at once. An NC can be shared only with the supplier or customer it names; an 8D
--    only with a party named by one of its live linked non-conformances.
--  * portal_comments: both sides write to one thread; a comment can be withdrawn by its author within ten minutes (PT0 §8.4), otherwise it is permanent.
--    Staff comments show the organisation's name to the party, never a staff member's name (PT0 T13).
--  * portal_views: first and last view per share and external person ("viewed" for staff).
--  * The external view of a record is one function returning NAMED fields only (PT0 T3): no costs, internal notes, staff names, other parties,
--    root-cause workings, proposed dispositions. Adding a column to a table adds nothing to it. Files are not part of this slice.
-- Errors use QM032 (409 portal_rule); another organisation's id is P0002 (404).

-- ---------------------------------------------------------------------------
-- Permission
-- ---------------------------------------------------------------------------
INSERT INTO public.permissions (code, description) VALUES
  ('external_access.share', 'Share non-conformances and 8Ds with a supplier or customer, and write in the conversation on them');

WITH grants(key, perms) AS (VALUES
  ('owner',            ARRAY['external_access.share']),
  ('admin',            ARRAY['external_access.share']),
  ('quality_manager',  ARRAY['external_access.share']),
  ('quality_engineer', ARRAY['external_access.share'])
)
INSERT INTO public.role_permissions (role_id, permission_code)
SELECT r.id, unnest(g.perms) FROM public.roles r JOIN grants g ON g.key = r.key WHERE r.is_system
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION app.unpriced_permissions() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT app.gated_permissions() || ARRAY['members.read', 'members.manage', 'roles.manage', 'security.read', 'security.manage',
                                         'external_access.read', 'external_access.manage', 'external_access.share']
$$;

-- ---------------------------------------------------------------------------
-- Shares
-- ---------------------------------------------------------------------------
CREATE TABLE public.portal_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  party_id uuid NOT NULL,
  record_kind text NOT NULL CHECK (record_kind IN ('ncr', 'capa')),
  nonconformance_id uuid,
  capa_id uuid,
  shared_at timestamptz NOT NULL DEFAULT now(),
  shared_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  withdrawn_at timestamptz,
  withdrawn_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  withdrawn_reason text CHECK (withdrawn_reason IS NULL OR length(btrim(withdrawn_reason)) BETWEEN 3 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT portal_shares_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT portal_shares_party_fkey FOREIGN KEY (party_id, organisation_id) REFERENCES public.portal_parties (id, organisation_id),
  CONSTRAINT portal_shares_ncr_fkey FOREIGN KEY (nonconformance_id, organisation_id) REFERENCES public.nonconformances (id, organisation_id),
  CONSTRAINT portal_shares_capa_fkey FOREIGN KEY (capa_id, organisation_id) REFERENCES public.capas (id, organisation_id),
  CONSTRAINT portal_shares_one_record CHECK ((record_kind = 'ncr' AND nonconformance_id IS NOT NULL AND capa_id IS NULL)
                                          OR (record_kind = 'capa' AND capa_id IS NOT NULL AND nonconformance_id IS NULL)),
  CONSTRAINT portal_shares_withdrawn_check CHECK ((withdrawn_at IS NULL) = (withdrawn_reason IS NULL))
);
CREATE UNIQUE INDEX portal_shares_ncr_live_key ON public.portal_shares (party_id, nonconformance_id) WHERE withdrawn_at IS NULL AND nonconformance_id IS NOT NULL;
CREATE UNIQUE INDEX portal_shares_capa_live_key ON public.portal_shares (party_id, capa_id) WHERE withdrawn_at IS NULL AND capa_id IS NOT NULL;
CREATE INDEX portal_shares_ncr_idx ON public.portal_shares (nonconformance_id) WHERE nonconformance_id IS NOT NULL;
CREATE INDEX portal_shares_capa_idx ON public.portal_shares (capa_id) WHERE capa_id IS NOT NULL;
CREATE INDEX portal_shares_party_idx ON public.portal_shares (party_id) WHERE withdrawn_at IS NULL;

CREATE FUNCTION app.portal_share_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A share is never deleted. Withdraw it with a reason.' USING ERRCODE = 'QM032'; END IF;
  IF NEW.party_id <> OLD.party_id OR NEW.record_kind <> OLD.record_kind OR NEW.nonconformance_id IS DISTINCT FROM OLD.nonconformance_id
     OR NEW.capa_id IS DISTINCT FROM OLD.capa_id OR NEW.shared_at <> OLD.shared_at THEN
    RAISE EXCEPTION 'What a share is for cannot change' USING ERRCODE = 'QM032';
  END IF;
  IF OLD.withdrawn_at IS NOT NULL THEN RAISE EXCEPTION 'A withdrawn share cannot be changed. Share the record again.' USING ERRCODE = 'QM032'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER portal_shares_rules BEFORE UPDATE OR DELETE ON public.portal_shares FOR EACH ROW EXECUTE FUNCTION app.portal_share_rules();
CREATE TRIGGER portal_shares_stamp BEFORE INSERT ON public.portal_shares FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER portal_shares_touch BEFORE UPDATE ON public.portal_shares FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER portal_shares_org_immutable BEFORE UPDATE ON public.portal_shares FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.portal_shares FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.portal_shares ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.portal_shares FROM anon, authenticated;
GRANT SELECT ON public.portal_shares TO authenticated;
CREATE POLICY portal_shares_select ON public.portal_shares FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'external_access.share'));

-- ---------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------
CREATE TABLE public.portal_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  share_id uuid NOT NULL,
  author_side text NOT NULL CHECK (author_side IN ('staff', 'external')),
  author_user_id uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 4000),
  withdrawn_at timestamptz,
  withdrawn_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT portal_comments_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT portal_comments_share_fkey FOREIGN KEY (share_id, organisation_id) REFERENCES public.portal_shares (id, organisation_id)
);
CREATE INDEX portal_comments_share_idx ON public.portal_comments (share_id, created_at);

CREATE FUNCTION app.portal_comment_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A comment is never deleted' USING ERRCODE = 'QM032'; END IF;
  IF NEW.body <> OLD.body OR NEW.share_id <> OLD.share_id OR NEW.author_side <> OLD.author_side OR NEW.author_user_id IS DISTINCT FROM OLD.author_user_id THEN
    RAISE EXCEPTION 'A comment cannot be edited. Withdraw it within ten minutes and write it again.' USING ERRCODE = 'QM032';
  END IF;
  IF OLD.withdrawn_at IS NOT NULL THEN RAISE EXCEPTION 'That comment is already withdrawn' USING ERRCODE = 'QM032'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER portal_comments_rules BEFORE UPDATE OR DELETE ON public.portal_comments FOR EACH ROW EXECUTE FUNCTION app.portal_comment_rules();
CREATE TRIGGER portal_comments_stamp BEFORE INSERT ON public.portal_comments FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER portal_comments_touch BEFORE UPDATE ON public.portal_comments FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER portal_comments_org_immutable BEFORE UPDATE ON public.portal_comments FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.portal_comments FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.portal_comments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.portal_comments FROM anon, authenticated;
GRANT SELECT ON public.portal_comments TO authenticated;
CREATE POLICY portal_comments_select ON public.portal_comments FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'external_access.share'));

-- ---------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------
CREATE TABLE public.portal_views (
  share_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  first_viewed_at timestamptz NOT NULL DEFAULT now(),
  last_viewed_at timestamptz NOT NULL DEFAULT now(),
  view_count integer NOT NULL DEFAULT 1 CHECK (view_count >= 1),
  PRIMARY KEY (share_id, user_id),
  CONSTRAINT portal_views_share_fkey FOREIGN KEY (share_id, organisation_id) REFERENCES public.portal_shares (id, organisation_id)
);
CREATE TRIGGER portal_views_org_immutable BEFORE UPDATE ON public.portal_views FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
ALTER TABLE public.portal_views ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.portal_views FROM anon, authenticated;
GRANT SELECT ON public.portal_views TO authenticated;
CREATE POLICY portal_views_select ON public.portal_views FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'external_access.share'));

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
-- The caller's own live access to the party a share is for, and the share itself; P0002 (404) otherwise, so a share of another party is never confirmed.
CREATE FUNCTION app.portal_share_for_external(p_share uuid) RETURNS public.portal_shares
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.portal_shares;
BEGIN
  SELECT * INTO s FROM public.portal_shares WHERE id = p_share AND withdrawn_at IS NULL;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM app.portal_my_access(s.organisation_id) a WHERE a.party_id = s.party_id) THEN
    RAISE EXCEPTION 'share not found' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN s;
END $$;
REVOKE ALL ON FUNCTION app.portal_share_for_external(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_share_for_external(uuid) TO authenticated;

CREATE FUNCTION app.portal_person_name(p_user uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.surname, '')), ''), (SELECT split_part(u.email, '@', 1) FROM auth.users u WHERE u.id = p_user), 'Someone')
    FROM (SELECT 1) one LEFT JOIN public.profiles p ON p.id = p_user
$$;
REVOKE ALL ON FUNCTION app.portal_person_name(uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Staff: share and withdraw
-- ---------------------------------------------------------------------------
-- Parties a record could be shared with (portal and party on; the NC names them; an 8D through a live linked NC) and has not been shared with already.
CREATE FUNCTION app.portal_eligible_parties(p_kind text, p_record uuid)
RETURNS TABLE (party_id uuid, party_kind text, party_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid;
BEGIN
  IF p_kind = 'ncr' THEN SELECT organisation_id INTO v_org FROM public.nonconformances WHERE id = p_record;
  ELSIF p_kind = 'capa' THEN SELECT organisation_id INTO v_org FROM public.capas WHERE id = p_record;
  ELSE RAISE EXCEPTION 'That kind of record cannot be shared' USING ERRCODE = 'QM032'; END IF;
  IF v_org IS NULL OR NOT app.has_permission(v_org, 'external_access.share') THEN RAISE EXCEPTION 'record not found' USING ERRCODE = 'no_data_found'; END IF;
  RETURN QUERY
  SELECT p.id, p.party_kind, coalesce(sup.name, cus.name)
    FROM public.portal_parties p
    JOIN public.organisation_settings s ON s.organisation_id = p.organisation_id AND s.portal_enabled
    LEFT JOIN public.suppliers sup ON sup.id = p.supplier_id
    LEFT JOIN public.customers cus ON cus.id = p.customer_id
   WHERE p.organisation_id = v_org AND p.enabled
     AND CASE p_kind
           WHEN 'ncr' THEN EXISTS (SELECT 1 FROM public.nonconformances n WHERE n.id = p_record AND (n.supplier_id = p.supplier_id OR n.customer_id = p.customer_id))
           ELSE EXISTS (SELECT 1 FROM public.capa_ncr_links l JOIN public.nonconformances n ON n.id = l.nonconformance_id
                         WHERE l.capa_id = p_record AND l.ended_at IS NULL AND n.deleted_at IS NULL AND (n.supplier_id = p.supplier_id OR n.customer_id = p.customer_id))
         END
     AND NOT EXISTS (SELECT 1 FROM public.portal_shares x WHERE x.party_id = p.id AND x.withdrawn_at IS NULL
                      AND ((p_kind = 'ncr' AND x.nonconformance_id = p_record) OR (p_kind = 'capa' AND x.capa_id = p_record)))
   ORDER BY 3;
END $$;
REVOKE ALL ON FUNCTION app.portal_eligible_parties(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_eligible_parties(text, uuid) TO authenticated;

CREATE FUNCTION app.share_with_portal(p_kind text, p_record uuid, p_party uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid; v_id uuid; n public.nonconformances; c public.capas;
BEGIN
  IF p_kind = 'ncr' THEN
    SELECT * INTO n FROM public.nonconformances WHERE id = p_record;
    IF NOT FOUND THEN RAISE EXCEPTION 'record not found' USING ERRCODE = 'no_data_found'; END IF;
    v_org := n.organisation_id;
    IF NOT app.has_permission(v_org, 'external_access.share') OR NOT app.has_permission(v_org, 'ncr.read', n.site_id) THEN
      RAISE EXCEPTION 'You are not allowed to share this non-conformance' USING ERRCODE = '42501';
    END IF;
    IF n.deleted_at IS NOT NULL OR n.stage IN ('draft', 'cancelled') THEN RAISE EXCEPTION 'Only an open, running or closed non-conformance can be shared. Open it first.' USING ERRCODE = 'QM032'; END IF;
  ELSIF p_kind = 'capa' THEN
    SELECT * INTO c FROM public.capas WHERE id = p_record;
    IF NOT FOUND THEN RAISE EXCEPTION 'record not found' USING ERRCODE = 'no_data_found'; END IF;
    v_org := c.organisation_id;
    IF NOT app.has_permission(v_org, 'external_access.share') OR NOT app.has_permission(v_org, 'capa.read') THEN
      RAISE EXCEPTION 'You are not allowed to share this 8D' USING ERRCODE = '42501';
    END IF;
    IF c.stage = 'cancelled' THEN RAISE EXCEPTION 'A cancelled 8D cannot be shared' USING ERRCODE = 'QM032'; END IF;
  ELSE
    RAISE EXCEPTION 'That kind of record cannot be shared' USING ERRCODE = 'QM032';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.portal_parties WHERE id = p_party AND organisation_id = v_org) THEN RAISE EXCEPTION 'party not found' USING ERRCODE = 'no_data_found'; END IF;
  IF EXISTS (SELECT 1 FROM public.portal_shares WHERE party_id = p_party AND withdrawn_at IS NULL
              AND ((p_kind = 'ncr' AND nonconformance_id = p_record) OR (p_kind = 'capa' AND capa_id = p_record))) THEN
    RAISE EXCEPTION 'That record is already shared with them' USING ERRCODE = 'QM032';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.portal_eligible_parties(p_kind, p_record) e WHERE e.party_id = p_party) THEN
    RAISE EXCEPTION 'This record can be shared only with a supplier or customer it names, who has the portal switched on' USING ERRCODE = 'QM032';
  END IF;
  INSERT INTO public.portal_shares (organisation_id, party_id, record_kind, nonconformance_id, capa_id)
  VALUES (v_org, p_party, p_kind, CASE WHEN p_kind = 'ncr' THEN p_record END, CASE WHEN p_kind = 'capa' THEN p_record END)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION app.share_with_portal(text, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.share_with_portal(text, uuid, uuid) TO authenticated;

CREATE FUNCTION app.withdraw_portal_share(p_share uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.portal_shares;
BEGIN
  SELECT * INTO s FROM public.portal_shares WHERE id = p_share FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'share not found' USING ERRCODE = 'no_data_found'; END IF;
  IF NOT app.has_permission(s.organisation_id, 'external_access.share') THEN RAISE EXCEPTION 'external_access.share required' USING ERRCODE = '42501'; END IF;
  IF s.withdrawn_at IS NOT NULL THEN RAISE EXCEPTION 'That share is already withdrawn' USING ERRCODE = 'QM032'; END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 3 THEN RAISE EXCEPTION 'Give a reason (at least 3 characters)' USING ERRCODE = 'QM032'; END IF;
  UPDATE public.portal_shares SET withdrawn_at = now(), withdrawn_by = auth.uid(), withdrawn_reason = btrim(p_reason) WHERE id = p_share;
END $$;
REVOKE ALL ON FUNCTION app.withdraw_portal_share(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.withdraw_portal_share(uuid, text) TO authenticated;

-- The shares of one record, for the staff card: with whom, by whom, whether and when they have looked, and how much has been said.
CREATE FUNCTION app.list_portal_shares(p_kind text, p_record uuid)
RETURNS TABLE (share_id uuid, party_id uuid, party_kind text, party_name text, shared_at timestamptz, shared_by_name text, withdrawn_at timestamptz,
               withdrawn_reason text, viewers integer, first_viewed_at timestamptz, last_viewed_at timestamptz, comments integer, external_comments integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid;
BEGIN
  IF p_kind = 'ncr' THEN SELECT organisation_id INTO v_org FROM public.nonconformances WHERE id = p_record;
  ELSIF p_kind = 'capa' THEN SELECT organisation_id INTO v_org FROM public.capas WHERE id = p_record;
  ELSE RAISE EXCEPTION 'That kind of record cannot be shared' USING ERRCODE = 'QM032'; END IF;
  IF v_org IS NULL OR NOT app.has_permission(v_org, 'external_access.share') THEN RAISE EXCEPTION 'record not found' USING ERRCODE = 'no_data_found'; END IF;
  RETURN QUERY
  SELECT x.id, p.id, p.party_kind, coalesce(sup.name, cus.name), x.shared_at, app.portal_person_name(x.shared_by), x.withdrawn_at, x.withdrawn_reason,
         (SELECT count(*)::int FROM public.portal_views v WHERE v.share_id = x.id),
         (SELECT min(v.first_viewed_at) FROM public.portal_views v WHERE v.share_id = x.id),
         (SELECT max(v.last_viewed_at) FROM public.portal_views v WHERE v.share_id = x.id),
         (SELECT count(*)::int FROM public.portal_comments c WHERE c.share_id = x.id AND c.withdrawn_at IS NULL),
         (SELECT count(*)::int FROM public.portal_comments c WHERE c.share_id = x.id AND c.withdrawn_at IS NULL AND c.author_side = 'external')
    FROM public.portal_shares x
    JOIN public.portal_parties p ON p.id = x.party_id AND p.organisation_id = x.organisation_id
    LEFT JOIN public.suppliers sup ON sup.id = p.supplier_id
    LEFT JOIN public.customers cus ON cus.id = p.customer_id
   WHERE x.organisation_id = v_org AND ((p_kind = 'ncr' AND x.nonconformance_id = p_record) OR (p_kind = 'capa' AND x.capa_id = p_record))
   ORDER BY x.withdrawn_at IS NOT NULL, x.shared_at DESC;
END $$;
REVOKE ALL ON FUNCTION app.list_portal_shares(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.list_portal_shares(text, uuid) TO authenticated;

-- Who to email when staff share or comment: the party's active people with a confirmed address (staff only).
CREATE FUNCTION app.portal_share_recipients(p_share uuid) RETURNS TABLE (email text, name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.portal_shares;
BEGIN
  SELECT * INTO s FROM public.portal_shares WHERE id = p_share;
  IF NOT FOUND OR NOT app.has_permission(s.organisation_id, 'external_access.share') THEN RAISE EXCEPTION 'share not found' USING ERRCODE = 'no_data_found'; END IF;
  RETURN QUERY
  SELECT u.email::text, app.portal_person_name(u.id)
    FROM public.external_access a JOIN auth.users u ON u.id = a.user_id
   WHERE a.party_id = s.party_id AND a.status = 'active' AND u.email_confirmed_at IS NOT NULL AND s.withdrawn_at IS NULL;
END $$;
REVOKE ALL ON FUNCTION app.portal_share_recipients(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_share_recipients(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Comments (both sides)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.add_portal_comment(p_share uuid, p_body text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.portal_shares; v_id uuid; v_side text;
BEGIN
  SELECT * INTO s FROM public.portal_shares WHERE id = p_share;
  IF NOT FOUND THEN RAISE EXCEPTION 'share not found' USING ERRCODE = 'no_data_found'; END IF;
  IF app.has_permission(s.organisation_id, 'external_access.share') THEN v_side := 'staff';
  ELSIF EXISTS (SELECT 1 FROM app.portal_my_access(s.organisation_id) a WHERE a.party_id = s.party_id) THEN v_side := 'external';
  ELSE RAISE EXCEPTION 'share not found' USING ERRCODE = 'no_data_found'; END IF;
  IF s.withdrawn_at IS NOT NULL THEN
    -- The party is told nothing about a share that has been withdrawn; staff are.
    IF v_side = 'external' THEN RAISE EXCEPTION 'share not found' USING ERRCODE = 'no_data_found'; END IF;
    RAISE EXCEPTION 'This record is no longer shared, so it cannot be commented on' USING ERRCODE = 'QM032';
  END IF;
  IF length(btrim(coalesce(p_body, ''))) < 1 OR length(btrim(p_body)) > 4000 THEN RAISE EXCEPTION 'A comment is 1 to 4,000 characters' USING ERRCODE = 'QM032'; END IF;
  INSERT INTO public.portal_comments (organisation_id, share_id, author_side, body) VALUES (s.organisation_id, p_share, v_side, btrim(p_body)) RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION app.add_portal_comment(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.add_portal_comment(uuid, text) TO authenticated;

-- Withdraw your own comment within ten minutes.
CREATE FUNCTION app.withdraw_portal_comment(p_comment uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.portal_comments; s public.portal_shares;
BEGIN
  SELECT * INTO c FROM public.portal_comments WHERE id = p_comment FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'comment not found' USING ERRCODE = 'no_data_found'; END IF;
  SELECT * INTO s FROM public.portal_shares WHERE id = c.share_id;
  IF NOT (app.has_permission(c.organisation_id, 'external_access.share') OR EXISTS (SELECT 1 FROM app.portal_my_access(c.organisation_id) a WHERE a.party_id = s.party_id)) THEN
    RAISE EXCEPTION 'comment not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF c.author_user_id IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'You can withdraw only your own comments' USING ERRCODE = 'QM032'; END IF;
  IF c.withdrawn_at IS NOT NULL THEN RAISE EXCEPTION 'That comment is already withdrawn' USING ERRCODE = 'QM032'; END IF;
  IF c.created_at < now() - interval '10 minutes' THEN RAISE EXCEPTION 'A comment can be withdrawn only within ten minutes of writing it' USING ERRCODE = 'QM032'; END IF;
  UPDATE public.portal_comments SET withdrawn_at = now(), withdrawn_by = auth.uid() WHERE id = p_comment;
END $$;
REVOKE ALL ON FUNCTION app.withdraw_portal_comment(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.withdraw_portal_comment(uuid) TO authenticated;

-- The thread of a share as the caller may see it. To staff: everyone's names. To the party: its own people by name and the organisation's staff only
-- as the organisation (PT0 T13). A withdrawn comment keeps its place but not its words.
CREATE FUNCTION app.portal_share_comments(p_share uuid)
RETURNS TABLE (comment_id uuid, side text, author_name text, body text, created_at timestamptz, withdrawn boolean, mine boolean, can_withdraw boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.portal_shares; v_staff boolean; v_org_name text; v_party_name text;
BEGIN
  SELECT * INTO s FROM public.portal_shares WHERE id = p_share;
  IF NOT FOUND THEN RAISE EXCEPTION 'share not found' USING ERRCODE = 'no_data_found'; END IF;
  v_staff := app.has_permission(s.organisation_id, 'external_access.share');
  IF NOT v_staff THEN
    IF s.withdrawn_at IS NOT NULL OR NOT EXISTS (SELECT 1 FROM app.portal_my_access(s.organisation_id) a WHERE a.party_id = s.party_id) THEN
      RAISE EXCEPTION 'share not found' USING ERRCODE = 'no_data_found';
    END IF;
  END IF;
  SELECT o.name INTO v_org_name FROM public.organisations o WHERE o.id = s.organisation_id;
  SELECT coalesce(sup.name, cus.name) INTO v_party_name FROM public.portal_parties p
    LEFT JOIN public.suppliers sup ON sup.id = p.supplier_id LEFT JOIN public.customers cus ON cus.id = p.customer_id WHERE p.id = s.party_id;
  RETURN QUERY
  SELECT c.id, c.author_side,
         CASE WHEN c.author_side = 'staff' AND NOT v_staff THEN v_org_name
              WHEN c.author_side = 'staff' THEN app.portal_person_name(c.author_user_id)
              WHEN v_staff THEN app.portal_person_name(c.author_user_id) || ' (' || v_party_name || ')'
              ELSE app.portal_person_name(c.author_user_id) END,
         CASE WHEN c.withdrawn_at IS NULL THEN c.body END, c.created_at, c.withdrawn_at IS NOT NULL,
         c.author_user_id IS NOT DISTINCT FROM auth.uid(),
         c.withdrawn_at IS NULL AND c.author_user_id IS NOT DISTINCT FROM auth.uid() AND c.created_at >= now() - interval '10 minutes'
    FROM public.portal_comments c WHERE c.share_id = p_share ORDER BY c.created_at, c.id;
END $$;
REVOKE ALL ON FUNCTION app.portal_share_comments(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_share_comments(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- The party's side: the list, "seen", and the two curated views
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.portal_list_shares(p_organisation_id uuid)
RETURNS TABLE (share_id uuid, kind text, reference text, title text, status text, shared_at timestamptz, comments integer, new_comments integer, viewed boolean, last_comment_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT x.id, x.record_kind, coalesce(n.reference, c.reference), coalesce(n.title, c.title), coalesce(n.stage, c.stage), x.shared_at,
         (SELECT count(*)::int FROM public.portal_comments m WHERE m.share_id = x.id AND m.withdrawn_at IS NULL),
         (SELECT count(*)::int FROM public.portal_comments m WHERE m.share_id = x.id AND m.withdrawn_at IS NULL AND m.author_side = 'staff'
             AND m.created_at > coalesce(v.last_viewed_at, '-infinity'::timestamptz)),
         v.share_id IS NOT NULL,
         (SELECT max(m.created_at) FROM public.portal_comments m WHERE m.share_id = x.id AND m.withdrawn_at IS NULL)
    FROM public.portal_shares x
    JOIN app.portal_my_access(p_organisation_id) a ON a.party_id = x.party_id
    LEFT JOIN public.nonconformances n ON n.id = x.nonconformance_id AND n.deleted_at IS NULL
    LEFT JOIN public.capas c ON c.id = x.capa_id
    LEFT JOIN public.portal_views v ON v.share_id = x.id AND v.user_id = auth.uid()
   WHERE x.organisation_id = p_organisation_id AND x.withdrawn_at IS NULL AND (n.id IS NOT NULL OR c.id IS NOT NULL)
   ORDER BY coalesce((SELECT max(m.created_at) FROM public.portal_comments m WHERE m.share_id = x.id AND m.withdrawn_at IS NULL), x.shared_at) DESC
$$;
REVOKE ALL ON FUNCTION app.portal_list_shares(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_list_shares(uuid) TO authenticated;

CREATE FUNCTION app.portal_mark_viewed(p_share uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.portal_shares;
BEGIN
  s := app.portal_share_for_external(p_share);
  INSERT INTO public.portal_views (share_id, user_id, organisation_id) VALUES (p_share, auth.uid(), s.organisation_id)
  ON CONFLICT (share_id, user_id) DO UPDATE SET last_viewed_at = now(), view_count = public.portal_views.view_count + 1;
END $$;
REVOKE ALL ON FUNCTION app.portal_mark_viewed(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_mark_viewed(uuid) TO authenticated;

-- The shared non-conformance as the party sees it (PT0 §8.2, X15): named fields only.
CREATE FUNCTION app.portal_get_ncr(p_share uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.portal_shares; n public.nonconformances; v_contact text;
BEGIN
  s := app.portal_share_for_external(p_share);
  IF s.record_kind <> 'ncr' THEN RAISE EXCEPTION 'share not found' USING ERRCODE = 'no_data_found'; END IF;
  SELECT * INTO n FROM public.nonconformances WHERE id = s.nonconformance_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'share not found' USING ERRCODE = 'no_data_found'; END IF;
  SELECT coalesce(p.contact_name, o.name) INTO v_contact FROM public.portal_parties p JOIN public.organisations o ON o.id = p.organisation_id WHERE p.id = s.party_id;
  RETURN jsonb_build_object(
    'reference', n.reference,
    'title', n.title,
    'description', n.description,
    'requirement', n.requirement,
    'actualResult', n.actual_result,
    'severity', n.severity,
    'stage', n.stage,
    'detectedAt', n.detected_at,
    'quantityAffected', n.quantity_affected,
    'quantityInspected', n.quantity_inspected,
    'partNumber', (SELECT pt.part_number FROM public.parts pt WHERE pt.id = n.part_id),
    'partName', (SELECT pt.name FROM public.parts pt WHERE pt.id = n.part_id),
    'partRevision', (SELECT r.revision || CASE WHEN r.version > 1 THEN ' v' || r.version ELSE '' END FROM public.part_revisions r WHERE r.id = n.part_revision_id),
    'lotNumber', n.lot_number,
    'serialNumber', n.serial_number,
    'purchaseOrder', n.purchase_order,
    'customerReference', n.customer_reference,
    'containment', coalesce((SELECT jsonb_agg(jsonb_build_object('kind', a.kind, 'description', a.description, 'dueDate', a.due_date, 'status', a.status,
                                                                'quantityContained', a.quantity_contained, 'resultNote', CASE WHEN a.status = 'done' THEN a.done_note END)
                                              ORDER BY a.created_at)
                               FROM public.ncr_containment_actions a WHERE a.nonconformance_id = n.id AND a.status <> 'cancelled'), '[]'::jsonb),
    'disposition', coalesce((SELECT jsonb_agg(jsonb_build_object('decision', d.decision, 'quantity', d.quantity, 'instructions', d.instructions, 'reference', d.reference)
                                              ORDER BY d.created_at)
                               FROM public.ncr_dispositions d WHERE d.nonconformance_id = n.id AND d.status = 'approved'), '[]'::jsonb),
    'sharedAt', s.shared_at,
    'contact', v_contact
  );
END $$;
REVOKE ALL ON FUNCTION app.portal_get_ncr(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_get_ncr(uuid) TO authenticated;

-- The shared 8D as the party sees it: what was asked and done, never the team, the workings or internal notes.
CREATE FUNCTION app.portal_get_capa(p_share uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.portal_shares; c public.capas; v_contact text;
BEGIN
  s := app.portal_share_for_external(p_share);
  IF s.record_kind <> 'capa' THEN RAISE EXCEPTION 'share not found' USING ERRCODE = 'no_data_found'; END IF;
  SELECT * INTO c FROM public.capas WHERE id = s.capa_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'share not found' USING ERRCODE = 'no_data_found'; END IF;
  SELECT coalesce(p.contact_name, o.name) INTO v_contact FROM public.portal_parties p JOIN public.organisations o ON o.id = p.organisation_id WHERE p.id = s.party_id;
  RETURN jsonb_build_object(
    'reference', c.reference,
    'title', c.title,
    'severity', c.severity,
    'stage', c.stage,
    'problemStatement', c.problem_statement,
    'problem', jsonb_build_object('who', c.d2_who, 'what', c.d2_what, 'where', c.d2_where, 'when', c.d2_when, 'why', c.d2_why, 'how', c.d2_how, 'howMany', c.d2_how_many),
    'containment', coalesce((SELECT jsonb_agg(jsonb_build_object('description', a.description, 'dueDate', a.due_date, 'status', a.status,
                                                                'resultNote', CASE WHEN a.status = 'done' THEN a.evidence_note END) ORDER BY a.created_at)
                               FROM public.capa_actions a WHERE a.capa_id = c.id AND a.phase = 'interim' AND a.status <> 'cancelled'), '[]'::jsonb),
    'noContainmentReason', c.d3_no_containment_reason,
    'rootCauses', coalesce((SELECT jsonb_agg(jsonb_build_object('kind', r.kind, 'description', r.description) ORDER BY r.created_at)
                              FROM public.capa_root_causes r WHERE r.capa_id = c.id AND r.deleted_at IS NULL AND r.verified), '[]'::jsonb),
    'correctiveActions', coalesce((SELECT jsonb_agg(jsonb_build_object('description', a.description, 'dueDate', a.due_date, 'status', a.status,
                                                                      'resultNote', CASE WHEN a.status = 'done' THEN a.evidence_note END) ORDER BY a.created_at)
                                     FROM public.capa_actions a WHERE a.capa_id = c.id AND a.phase = 'corrective' AND a.status <> 'cancelled'), '[]'::jsonb),
    'verification', (SELECT jsonb_build_object('effective', v.effective, 'method', v.method, 'date', v.created_at)
                       FROM public.capa_verifications v WHERE v.capa_id = c.id ORDER BY v.seq DESC LIMIT 1),
    'preventiveActions', coalesce((SELECT jsonb_agg(jsonb_build_object('description', a.description, 'dueDate', a.due_date, 'status', a.status,
                                                                      'resultNote', CASE WHEN a.status = 'done' THEN a.evidence_note END) ORDER BY a.created_at)
                                     FROM public.capa_actions a WHERE a.capa_id = c.id AND a.phase = 'preventive' AND a.status <> 'cancelled'), '[]'::jsonb),
    'noPreventiveReason', c.d7_no_preventive_reason,
    'lessonsLearned', c.d7_lessons_learned,
    'closedAt', c.closed_at,
    'teamSize', (SELECT count(*)::int FROM public.capa_team_members t WHERE t.capa_id = c.id AND t.ended_at IS NULL),
    'sharedAt', s.shared_at,
    'contact', v_contact
  );
END $$;
REVOKE ALL ON FUNCTION app.portal_get_capa(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_get_capa(uuid) TO authenticated;

-- Trigger functions are not callable by anyone.
REVOKE ALL ON FUNCTION app.portal_share_rules(), app.portal_comment_rules() FROM PUBLIC, anon, authenticated;

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
    ('portal_comments', 'author_user_id', 'history', 'Who wrote a comment on a shared record'),
    ('portal_views', 'user_id', 'history', 'Who has seen a shared record'),
    ('profiles', 'id', 'personal', 'The account''s own profile'),
    ('platform_admins', 'user_id', 'personal', 'Platform operators'),
    ('signup_events', 'user_id', 'personal', 'Sign-up funnel')
$$;
