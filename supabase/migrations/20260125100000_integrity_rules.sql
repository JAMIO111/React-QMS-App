-- Audit report fixes B: NC fields after opening, the base currency, membership status and re-joining, who can be named on a record, deleting an NC under a running 8D,
-- and who may ask what is wrong with an NC.
--
-- H4  Once a non-conformance is open its severity, quantity affected and description (when it names no part) cannot be blanked, and a containment waiver
--     needs a real reason; the stages after Open also need a severity and a quantity affected. Before, an NC could be emptied and closed with no disposition.
-- H6  The organisation's base currency cannot change once costs exist (totals add the base-currency amounts; mixed currencies gave a wrong sum).
-- M9  A removed member can be invited again: one membership per person and organisation is only enforced for people who are not removed.
-- M10 Membership status moves follow the same rules in the database as in the API (removed is final, active never goes back to invited).
-- M12 The owner and detected-by of a non-conformance, and the custodian of a gauge, must be active members of the organisation.
-- M13 A non-conformance linked to a running 8D cannot be deleted (closing was already refused).
-- M7  app.ncr_gate_problems tells only people who may read the non-conformance.

-- ---- H4 ----
CREATE FUNCTION app.ncr_keep_opening_fields() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF coalesce(auth.role(), '') <> 'authenticated' OR OLD.stage = 'draft' OR NEW.stage = 'draft' THEN
    RETURN NEW;
  END IF;
  IF OLD.severity IS NOT NULL AND NEW.severity IS NULL THEN
    RAISE EXCEPTION 'The severity cannot be cleared once the non-conformance is open' USING ERRCODE = 'QM005';
  END IF;
  IF OLD.quantity_affected IS NOT NULL AND NEW.quantity_affected IS NULL THEN
    RAISE EXCEPTION 'The quantity affected cannot be cleared once the non-conformance is open' USING ERRCODE = 'QM005';
  END IF;
  IF NEW.part_id IS NULL AND length(trim(coalesce(NEW.description, ''))) = 0
     AND (OLD.part_id IS NOT NULL OR length(trim(coalesce(OLD.description, ''))) > 0) THEN
    RAISE EXCEPTION 'An open non-conformance needs a part or a description' USING ERRCODE = 'QM005';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER nonconformances_keep_opening_fields BEFORE UPDATE ON public.nonconformances
  FOR EACH ROW EXECUTE FUNCTION app.ncr_keep_opening_fields();

CREATE OR REPLACE FUNCTION app.ncr_gate_problems(p_ncr_id uuid, p_target text) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  n public.nonconformances%ROWTYPE;
  v_open integer; v_done integer; v_proposed integer; v_covered numeric;
  v_problems text[] := ARRAY[]::text[];
  a record;
BEGIN
  SELECT * INTO n FROM public.nonconformances WHERE id = p_ncr_id;
  -- Only someone who may read the non-conformance is told what is wrong with it (lot numbers and quantities are in the answer).
  IF NOT FOUND OR NOT app.has_permission(n.organisation_id, 'ncr.read', n.site_id) THEN
    RETURN v_problems;
  END IF;
  IF p_target IN ('contained', 'investigating', 'dispositioned', 'awaiting_closure', 'closed') THEN
    IF n.severity IS NULL THEN
      v_problems := array_append(v_problems, 'choose a severity');
    END IF;
    SELECT count(*) FILTER (WHERE status = 'open'), count(*) FILTER (WHERE status = 'done') INTO v_open, v_done
      FROM public.ncr_containment_actions WHERE nonconformance_id = p_ncr_id;
    IF v_open > 0 THEN
      v_problems := array_append(v_problems, format('%s containment %s still open', v_open, CASE WHEN v_open = 1 THEN 'action is' ELSE 'actions are' END));
    ELSIF v_done = 0 AND length(trim(coalesce(n.containment_not_needed_reason, ''))) = 0 THEN
      v_problems := array_append(v_problems, 'record a containment action, or say why none is needed');
    ELSIF v_done = 0 AND length(trim(n.containment_not_needed_reason)) < 10 THEN
      v_problems := array_append(v_problems, 'say why no containment is needed (at least 10 characters)');
    END IF;
  END IF;
  IF p_target IN ('dispositioned', 'awaiting_closure', 'closed') THEN
    IF n.quantity_affected IS NULL THEN
      v_problems := array_append(v_problems, 'enter the quantity affected');
    END IF;
    SELECT count(*) FILTER (WHERE status = 'proposed'), coalesce(sum(quantity) FILTER (WHERE status = 'approved'), 0) INTO v_proposed, v_covered
      FROM public.ncr_dispositions WHERE nonconformance_id = p_ncr_id;
    IF v_proposed > 0 THEN
      v_problems := array_append(v_problems, format('%s proposed %s still to approve or cancel', v_proposed, CASE WHEN v_proposed = 1 THEN 'disposition is' ELSE 'dispositions are' END));
    END IF;
    IF v_covered < coalesce(n.quantity_affected, 0) THEN
      v_problems := array_append(v_problems, format('approved dispositions cover %s of the %s affected', v_covered, n.quantity_affected));
    END IF;
    FOR a IN
      SELECT l.lot_number, al.quantity,
             coalesce((SELECT sum(d.quantity) FROM public.ncr_dispositions d WHERE d.nonconformance_id = al.nonconformance_id AND d.lot_id = al.lot_id AND d.status = 'approved'), 0) AS covered
        FROM public.ncr_affected_lots al JOIN public.lots l ON l.id = al.lot_id
       WHERE al.nonconformance_id = p_ncr_id AND al.removed_at IS NULL ORDER BY l.lot_number
    LOOP
      IF a.covered < a.quantity THEN
        v_problems := array_append(v_problems, format('lot %s: approved dispositions cover %s of the %s affected', a.lot_number, a.covered, a.quantity));
      END IF;
    END LOOP;
  END IF;
  RETURN v_problems;
END $$;

-- ---- H6 ----
CREATE FUNCTION app.organisation_currency_locked() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.base_currency IS DISTINCT FROM OLD.base_currency AND EXISTS (SELECT 1 FROM public.ncr_costs c WHERE c.organisation_id = NEW.organisation_id) THEN
    RAISE EXCEPTION 'Costs have already been entered in %, so the base currency cannot change. Totals add the base-currency amounts of every cost.', OLD.base_currency
      USING ERRCODE = 'QM014';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER organisation_settings_currency_locked BEFORE UPDATE OF base_currency ON public.organisation_settings
  FOR EACH ROW EXECUTE FUNCTION app.organisation_currency_locked();

-- ---- M9, M10 ----
ALTER TABLE public.organisation_users DROP CONSTRAINT organisation_users_org_user_key;
CREATE UNIQUE INDEX organisation_users_org_user_key ON public.organisation_users (organisation_id, user_id) WHERE status <> 'removed';

CREATE OR REPLACE FUNCTION app.accept_invitation(p_membership_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := auth.uid();
  v_email text;
  v_org uuid;
  v_expires timestamptz;
BEGIN
  SELECT lower(u.email) INTO v_email FROM auth.users u WHERE u.id = v_user;
  IF v_user IS NULL OR v_email IS NULL THEN
    RAISE EXCEPTION 'sign in to accept an invitation' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT m.organisation_id, m.invite_expires_at INTO v_org, v_expires
  FROM public.organisation_users m
  JOIN public.organisations o ON o.id = m.organisation_id AND o.status = 'active'
  WHERE m.id = p_membership_id AND m.status = 'invited' AND m.invited_email = v_email
  FOR UPDATE OF m;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invitation not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_expires IS NOT NULL AND v_expires <= now() THEN
    RAISE EXCEPTION 'This invitation has expired. Ask for a new one.' USING ERRCODE = 'QM015';
  END IF;

  IF EXISTS (SELECT 1 FROM public.organisation_users WHERE organisation_id = v_org AND user_id = v_user AND status <> 'removed') THEN
    RAISE EXCEPTION 'already a member of this organisation' USING ERRCODE = 'unique_violation',
      CONSTRAINT = 'organisation_users_org_user_key';
  END IF;

  UPDATE public.organisation_users
     SET user_id = v_user, status = 'active', joined_at = now()
   WHERE id = p_membership_id;
  RETURN v_org;
END $$;

CREATE FUNCTION app.organisation_user_status_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status OR coalesce(auth.role(), '') <> 'authenticated' THEN
    RETURN NEW;
  END IF;
  IF NOT ((OLD.status = 'invited' AND NEW.status IN ('active', 'removed'))
       OR (OLD.status = 'active' AND NEW.status IN ('suspended', 'removed'))
       OR (OLD.status = 'suspended' AND NEW.status IN ('active', 'removed'))) THEN
    RAISE EXCEPTION 'A % membership cannot become %', OLD.status, NEW.status USING ERRCODE = 'QM015';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER organisation_users_status_rules BEFORE UPDATE OF status ON public.organisation_users
  FOR EACH ROW EXECUTE FUNCTION app.organisation_user_status_rules();

-- ---- M12 ----
CREATE FUNCTION app.assert_active_member(p_organisation uuid, p_user uuid, p_what text, p_code text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_user IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.organisation_users m WHERE m.organisation_id = p_organisation AND m.user_id = p_user AND m.status = 'active') THEN
    RAISE EXCEPTION 'The % must be an active member of this organisation', p_what USING ERRCODE = p_code;
  END IF;
END $$;

CREATE FUNCTION app.ncr_named_people_are_members() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    PERFORM app.assert_active_member(NEW.organisation_id, NEW.owner_id, 'owner', 'QM005');
  END IF;
  IF TG_OP = 'INSERT' OR NEW.detected_by IS DISTINCT FROM OLD.detected_by THEN
    PERFORM app.assert_active_member(NEW.organisation_id, NEW.detected_by, 'person who detected it', 'QM005');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER nonconformances_named_people BEFORE INSERT OR UPDATE OF owner_id, detected_by ON public.nonconformances
  FOR EACH ROW EXECUTE FUNCTION app.ncr_named_people_are_members();

CREATE FUNCTION app.gauge_custodian_is_member() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.custodian_id IS DISTINCT FROM OLD.custodian_id THEN
    PERFORM app.assert_active_member(NEW.organisation_id, NEW.custodian_id, 'custodian', 'QM006');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER gauges_custodian_member BEFORE INSERT OR UPDATE OF custodian_id ON public.gauges
  FOR EACH ROW EXECUTE FUNCTION app.gauge_custodian_is_member();

-- ---- M13 ----
CREATE FUNCTION app.ncr_delete_needs_finished_capa() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_refs text;
BEGIN
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    SELECT string_agg(c.reference, ', ' ORDER BY c.reference) INTO v_refs
      FROM public.capa_ncr_links l JOIN public.capas c ON c.id = l.capa_id
     WHERE l.nonconformance_id = NEW.id AND l.ended_at IS NULL AND c.stage NOT IN ('verified_effective', 'closed', 'cancelled');
    IF v_refs IS NOT NULL THEN
      RAISE EXCEPTION '% has an 8D that is still running (%). Finish or cancel the 8D, or unlink it with a reason, before deleting.', NEW.reference, v_refs USING ERRCODE = 'QM005';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER nonconformances_delete_needs_capa BEFORE UPDATE OF deleted_at ON public.nonconformances
  FOR EACH ROW EXECUTE FUNCTION app.ncr_delete_needs_finished_capa();

REVOKE ALL ON FUNCTION app.ncr_keep_opening_fields(), app.organisation_currency_locked(), app.organisation_user_status_rules(), app.assert_active_member(uuid, uuid, text, text),
  app.ncr_named_people_are_members(), app.gauge_custodian_is_member(), app.ncr_delete_needs_finished_capa() FROM PUBLIC, anon, authenticated;
