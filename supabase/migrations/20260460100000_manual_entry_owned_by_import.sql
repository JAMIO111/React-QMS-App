-- Orders and movements entered by hand, or imported: never both at once.
--
-- A small organisation starting fresh types its purchase orders, deliveries, customer orders and shipments into Fortress (the screens and functions for that
-- exist). An organisation whose ERP sends that data on a schedule must not also type it, or each record would be there twice. So **while a scheduled import
-- of a kind is on, a person cannot add that kind by hand**; everything else (reading, cancelling, closing, a one-off file import, the import itself) is
-- unchanged. Like the import field locks it is worked out live and never stored: switch the schedule off, pause or retire the connection, or archive
-- its template and hand entry is open again at once.
--
-- The kind is owned when an ACTIVE connection has a schedule other than manual for it, with a template that is not archived. What counts:
--   purchase orders          <- purchase_order
--   deliveries (receipts)    <- goods_receipt, po_receipt_total (a running total of what arrived is a delivery too)
--   customer orders          <- customer_order            (the importer arrives in SH4; the rule already knows the name)
--   shipments                <- shipment                  (same)
-- The guard is a BEFORE INSERT trigger, so it holds whichever function or screen writes the row. The import itself is exempt through the transaction
-- setting `app.source = 'integration'` it already sets; SQL run as the system or the operator is exempt because it is not an `authenticated` session.
-- Error QM039 -> 409 record_managed_by_import.
-- Needs 20260459100000_shipping.sql first (it guards customer_orders and shipments). Safe to run again.
SET check_function_bodies = off;

-- The rule, once. Returns the name of the connection that owns any of the kinds, or null. No permission check: callers are the guard trigger and the
-- member-facing function below.
CREATE OR REPLACE FUNCTION app.import_owner(p_org uuid, p_kinds text[]) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT min(c.name)
    FROM public.integration_import_settings st
    JOIN public.integration_connections c ON c.id = st.connection_id AND c.organisation_id = st.organisation_id AND c.status = 'active'
    JOIN public.integration_templates t ON t.id = st.template_id AND t.organisation_id = st.organisation_id AND t.archived_at IS NULL
   WHERE st.organisation_id = p_org AND st.entity_type = ANY (p_kinds) AND st.schedule <> 'manual'
$$;
REVOKE ALL ON FUNCTION app.import_owner(uuid, text[]) FROM PUBLIC, anon, authenticated;

-- What a screen asks: which areas an import owns right now, and by which connection. Only members who may read that area, and nothing for an area no
-- import manages, so it reveals nothing about connections to people with no business seeing them.
CREATE OR REPLACE FUNCTION app.import_managed_areas(p_org uuid) RETURNS TABLE (area text, connection_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE r record; v_name text;
BEGIN
  IF NOT app.is_member(p_org) THEN RETURN; END IF;
  FOR r IN SELECT * FROM (VALUES
      ('purchase_orders', ARRAY['purchase_order'], 'receiving.read'),
      ('receipts', ARRAY['goods_receipt', 'po_receipt_total'], 'receiving.read'),
      ('customer_orders', ARRAY['customer_order'], 'shipping.read'),
      ('shipments', ARRAY['shipment'], 'shipping.read')) v (area, kinds, permission) LOOP
    IF NOT app.has_permission_somewhere(p_org, r.permission) THEN CONTINUE; END IF;
    v_name := app.import_owner(p_org, r.kinds);
    IF v_name IS NOT NULL THEN area := r.area; connection_name := v_name; RETURN NEXT; END IF;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION app.import_managed_areas(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.import_managed_areas(uuid) TO authenticated;

-- The guard. TG_ARGV[0] = the kinds (comma separated), TG_ARGV[1] = what to call them in the message, TG_ARGV[2] = the area's key.
CREATE OR REPLACE FUNCTION app.import_owned_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_name text;
BEGIN
  IF coalesce(auth.role(), '') <> 'authenticated' OR coalesce(current_setting('app.source', true), '') = 'integration' THEN RETURN NEW; END IF;
  v_name := app.import_owner(NEW.organisation_id, string_to_array(TG_ARGV[0], ','));
  IF v_name IS NOT NULL THEN
    RAISE EXCEPTION '% come from % while its schedule is on, so they cannot be entered here', TG_ARGV[1], v_name
      USING ERRCODE = 'QM039', DETAIL = jsonb_build_object('area', TG_ARGV[2], 'connection', v_name)::text;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.import_owned_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS import_owned_guard ON public.purchase_orders;
CREATE TRIGGER import_owned_guard BEFORE INSERT ON public.purchase_orders FOR EACH ROW EXECUTE FUNCTION app.import_owned_guard('purchase_order', 'Purchase orders', 'purchase_orders');
DROP TRIGGER IF EXISTS import_owned_guard ON public.goods_receipts;
CREATE TRIGGER import_owned_guard BEFORE INSERT ON public.goods_receipts FOR EACH ROW EXECUTE FUNCTION app.import_owned_guard('goods_receipt,po_receipt_total', 'Deliveries', 'receipts');
DROP TRIGGER IF EXISTS import_owned_guard ON public.customer_orders;
CREATE TRIGGER import_owned_guard BEFORE INSERT ON public.customer_orders FOR EACH ROW EXECUTE FUNCTION app.import_owned_guard('customer_order', 'Customer orders', 'customer_orders');
DROP TRIGGER IF EXISTS import_owned_guard ON public.shipments;
CREATE TRIGGER import_owned_guard BEFORE INSERT ON public.shipments FOR EACH ROW EXECUTE FUNCTION app.import_owned_guard('shipment', 'Shipments', 'shipments');
