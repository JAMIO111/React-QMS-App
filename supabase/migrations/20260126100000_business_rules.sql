-- Audit report fixes C: what a site-limited person sees, and business rules that stopped too early.
--
-- H5  app.my_visible_permissions: every permission the person holds anywhere in the organisation (organisation-wide or limited to a site or department), for the
--     menus and buttons of /me. A site-limited inspector was shown an empty app although the server let them work at their site. It is NOT used to decide anything:
--     app.has_permission still checks the site, and app.my_permissions (organisation-wide only) still drives who may hand out which rights.
-- Gaps between modules:
--   * a purchase order cannot be raised on a suspended, disqualified or archived supplier (deliveries that arrive can still be recorded and held);
--     a supplier with open purchase orders cannot be switched off;
--   * a lot named by an open non-conformance (on it or among its affected lots) cannot be released or closed;
--   * a production order cannot be completed or closed while an open non-conformance names it, and a new order cannot be made for an inactive part.
CREATE FUNCTION app.my_visible_permissions(p_organisation_id uuid) RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT DISTINCT rp.permission_code
  FROM public.organisation_users m
  JOIN public.organisations o ON o.id = m.organisation_id AND o.status = 'active'
  JOIN public.user_role_assignments a ON a.membership_id = m.id
  JOIN public.role_permissions rp ON rp.role_id = a.role_id
  WHERE m.organisation_id = p_organisation_id AND m.user_id = auth.uid() AND m.status = 'active'
    AND app.mfa_satisfied(p_organisation_id)
    AND (rp.permission_code = ANY (app.gated_permissions()) OR app.organisation_access_open(p_organisation_id))
    AND (rp.permission_code NOT LIKE 'integrations.%' OR app.holds_controller_seat(p_organisation_id))
$$;
REVOKE ALL ON FUNCTION app.my_visible_permissions(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.my_visible_permissions(uuid) TO authenticated;

-- ---- suppliers and purchasing ----
CREATE FUNCTION app.purchase_order_needs_usable_supplier() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.suppliers%ROWTYPE;
BEGIN
  SELECT * INTO s FROM public.suppliers WHERE id = NEW.supplier_id;
  IF FOUND AND s.approval_status IN ('suspended', 'disqualified', 'archived') THEN
    RAISE EXCEPTION '% is % and cannot be ordered from. Change its approval status first.', s.name, replace(s.approval_status, '_', ' ') USING ERRCODE = 'QM021';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER purchase_orders_usable_supplier BEFORE INSERT ON public.purchase_orders FOR EACH ROW EXECUTE FUNCTION app.purchase_order_needs_usable_supplier();

CREATE FUNCTION app.supplier_switch_off_needs_no_open_orders() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_n integer;
BEGIN
  IF NEW.active = false AND OLD.active IS DISTINCT FROM false THEN
    SELECT count(*) INTO v_n FROM public.purchase_orders p WHERE p.supplier_id = NEW.id AND p.status = 'open';
    IF v_n > 0 THEN
      RAISE EXCEPTION '% has % open purchase %. Close or cancel % before switching the supplier off.', NEW.name, v_n, CASE WHEN v_n = 1 THEN 'order' ELSE 'orders' END, CASE WHEN v_n = 1 THEN 'it' ELSE 'them' END
        USING ERRCODE = 'QM020';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER suppliers_switch_off_open_orders BEFORE UPDATE OF active ON public.suppliers FOR EACH ROW EXECUTE FUNCTION app.supplier_switch_off_needs_no_open_orders();

-- ---- lots and production orders against open non-conformances ----
CREATE FUNCTION app.lot_release_needs_no_open_ncr() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_refs text;
BEGIN
  -- An approver's conditional acceptance of the delivery (decided in this same transaction) is the explicit concession to use the lot as it is.
  IF NEW.status = 'released' AND EXISTS (
       SELECT 1 FROM public.receipt_line_dispositions d JOIN public.goods_receipt_lines l ON l.id = d.receipt_line_id
        WHERE l.lot_id = NEW.id AND d.decision = 'conditional' AND d.created_at = now()) THEN
    RETURN NEW;
  END IF;
  IF NEW.status IN ('released', 'closed') AND NEW.status IS DISTINCT FROM OLD.status THEN
    SELECT string_agg(DISTINCT n.reference, ', ' ORDER BY n.reference) INTO v_refs
      FROM public.nonconformances n
     WHERE n.organisation_id = NEW.organisation_id AND n.deleted_at IS NULL AND n.stage NOT IN ('closed', 'cancelled')
       AND (n.lot_id = NEW.id OR EXISTS (SELECT 1 FROM public.ncr_affected_lots al WHERE al.nonconformance_id = n.id AND al.lot_id = NEW.id AND al.removed_at IS NULL));
    IF v_refs IS NOT NULL THEN
      RAISE EXCEPTION 'Lot % is named by an open non-conformance (%). Close or cancel it before the lot is %.', NEW.lot_number, v_refs, NEW.status USING ERRCODE = 'QM017';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lots_release_no_open_ncr BEFORE UPDATE OF status ON public.lots FOR EACH ROW EXECUTE FUNCTION app.lot_release_needs_no_open_ncr();

CREATE FUNCTION app.order_finish_needs_no_open_ncr() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_refs text;
BEGIN
  IF NEW.status IN ('completed', 'closed') AND NEW.status IS DISTINCT FROM OLD.status THEN
    SELECT string_agg(DISTINCT n.reference, ', ' ORDER BY n.reference) INTO v_refs
      FROM public.nonconformances n
     WHERE n.organisation_id = NEW.organisation_id AND n.production_order_id = NEW.id AND n.deleted_at IS NULL AND n.stage NOT IN ('closed', 'cancelled');
    IF v_refs IS NOT NULL THEN
      RAISE EXCEPTION 'Order % has an open non-conformance (%). Close or cancel it before the order is %.', NEW.order_number, v_refs, NEW.status USING ERRCODE = 'QM017';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER production_orders_finish_no_open_ncr BEFORE UPDATE OF status ON public.production_orders FOR EACH ROW EXECUTE FUNCTION app.order_finish_needs_no_open_ncr();

CREATE FUNCTION app.production_order_needs_active_part() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE p public.parts%ROWTYPE;
BEGIN
  SELECT * INTO p FROM public.parts WHERE id = NEW.part_id;
  IF FOUND AND NOT p.active AND NEW.external_system IS NULL THEN
    RAISE EXCEPTION 'Part % is inactive: an order cannot be made for it. Make the part active first.', p.part_number USING ERRCODE = 'QM017';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER production_orders_active_part BEFORE INSERT ON public.production_orders FOR EACH ROW EXECUTE FUNCTION app.production_order_needs_active_part();

REVOKE ALL ON FUNCTION app.purchase_order_needs_usable_supplier(), app.supplier_switch_off_needs_no_open_orders(), app.lot_release_needs_no_open_ncr(),
  app.order_finish_needs_no_open_ncr(), app.production_order_needs_active_part() FROM PUBLIC, anon, authenticated;
