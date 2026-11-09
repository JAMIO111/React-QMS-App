-- Supplier Quality SQ4a: minimal purchasing and goods receiving (docs/supplier-quality-plan.md, decision D1 option (a)).
--
-- The spec says to reuse existing goods-receipt models; Fortress has none (only a typed purchase_order text on NCs and `lots` with origin 'received'), so this adds the
-- smallest model that makes on-time delivery, PPM and incoming inspection possible later:
--  * purchase_orders + purchase_order_lines: what was ordered from a supplier. A line asks for a part of ours or a material in words, a quantity, the ORIGINAL requested date
--    (never changes) and the latest agreed date (changes with an audit trail), so an on-time policy can use either. No prices, no approvals, no ERP sync.
--  * goods_receipts + goods_receipt_lines: what arrived, when, against which order line, with the lot it became. A receipt line that names a lot number MAKES the received lot
--    (lots.origin = 'received', the supplier and quantity filled in), so traceability, affected lots and the traceability page work for received material without a second system.
-- Everything is written by SECURITY DEFINER functions (receiving.manage); nothing is deleted; a receipt is cancelled with a reason. Creation of a receipt is idempotent per client key.
-- Quantities received, outstanding and "late" are worked out on read. Errors QM021 → 409 receiving_rule.

INSERT INTO public.permissions (code, description) VALUES
  ('receiving.read',   'View purchase orders and goods receipts'),
  ('receiving.manage', 'Record purchase orders and goods receipts');

WITH grants(key, perms) AS (VALUES
  ('owner',            ARRAY['receiving.read', 'receiving.manage']),
  ('admin',            ARRAY['receiving.read', 'receiving.manage']),
  ('quality_manager',  ARRAY['receiving.read', 'receiving.manage']),
  ('quality_engineer', ARRAY['receiving.read', 'receiving.manage']),
  ('inspector',        ARRAY['receiving.read', 'receiving.manage']),
  ('viewer',           ARRAY['receiving.read'])
)
INSERT INTO public.role_permissions (role_id, permission_code)
SELECT r.id, unnest(g.perms) FROM public.roles r JOIN grants g ON g.key = r.key WHERE r.is_system
ON CONFLICT DO NOTHING;

CREATE TABLE app.goods_receipt_counters (
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  year integer NOT NULL,
  last_value integer NOT NULL DEFAULT 0,
  PRIMARY KEY (organisation_id, year)
);
REVOKE ALL ON TABLE app.goods_receipt_counters FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE public.purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  po_number text NOT NULL CHECK (po_number ~ '^\S(.{0,38}\S)?$'),
  supplier_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'cancelled')),
  ordered_on date NOT NULL DEFAULT current_date,
  notes text CHECK (notes IS NULL OR length(btrim(notes)) BETWEEN 1 AND 2000),
  closed_at timestamptz,
  closed_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  cancel_reason text CHECK (cancel_reason IS NULL OR length(btrim(cancel_reason)) BETWEEN 3 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT purchase_orders_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT purchase_orders_supplier_fkey FOREIGN KEY (supplier_id, organisation_id) REFERENCES public.suppliers (id, organisation_id),
  CONSTRAINT purchase_orders_state CHECK ((status = 'closed') = (closed_at IS NOT NULL) AND ((status = 'cancelled') = (cancel_reason IS NOT NULL)))
);
CREATE UNIQUE INDEX purchase_orders_number_key ON public.purchase_orders (organisation_id, upper(po_number));
CREATE INDEX purchase_orders_supplier_idx ON public.purchase_orders (supplier_id, ordered_on DESC);

CREATE TABLE public.purchase_order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  purchase_order_id uuid NOT NULL,
  line_number integer NOT NULL CHECK (line_number >= 1),
  part_id uuid,
  material text CHECK (material IS NULL OR length(btrim(material)) BETWEEN 1 AND 200),
  quantity_ordered numeric(14, 3) NOT NULL CHECK (quantity_ordered > 0),
  unit text CHECK (unit IS NULL OR length(btrim(unit)) BETWEEN 1 AND 20),
  requested_on date NOT NULL,
  agreed_on date,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT purchase_order_lines_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT purchase_order_lines_po_fkey FOREIGN KEY (purchase_order_id, organisation_id) REFERENCES public.purchase_orders (id, organisation_id),
  CONSTRAINT purchase_order_lines_part_fkey FOREIGN KEY (part_id, organisation_id) REFERENCES public.parts (id, organisation_id),
  CONSTRAINT purchase_order_lines_number_key UNIQUE (purchase_order_id, line_number),
  CONSTRAINT purchase_order_lines_what CHECK (part_id IS NOT NULL OR material IS NOT NULL)
);

CREATE TABLE public.goods_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  reference text NOT NULL,
  supplier_id uuid NOT NULL,
  purchase_order_id uuid,
  site_id uuid,
  received_on date NOT NULL,
  delivery_note text CHECK (delivery_note IS NULL OR length(btrim(delivery_note)) BETWEEN 1 AND 100),
  notes text CHECK (notes IS NULL OR length(btrim(notes)) BETWEEN 1 AND 2000),
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'cancelled')),
  cancelled_at timestamptz,
  cancelled_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  cancel_reason text CHECK (cancel_reason IS NULL OR length(btrim(cancel_reason)) BETWEEN 3 AND 1000),
  client_key text CHECK (client_key IS NULL OR length(client_key) BETWEEN 8 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT goods_receipts_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT goods_receipts_reference_key UNIQUE (organisation_id, reference),
  CONSTRAINT goods_receipts_supplier_fkey FOREIGN KEY (supplier_id, organisation_id) REFERENCES public.suppliers (id, organisation_id),
  CONSTRAINT goods_receipts_po_fkey FOREIGN KEY (purchase_order_id, organisation_id) REFERENCES public.purchase_orders (id, organisation_id),
  CONSTRAINT goods_receipts_site_fkey FOREIGN KEY (site_id, organisation_id) REFERENCES public.sites (id, organisation_id),
  CONSTRAINT goods_receipts_state CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL))
);
CREATE UNIQUE INDEX goods_receipts_client_key ON public.goods_receipts (organisation_id, client_key) WHERE client_key IS NOT NULL;
CREATE INDEX goods_receipts_supplier_idx ON public.goods_receipts (supplier_id, received_on DESC);
CREATE INDEX goods_receipts_po_idx ON public.goods_receipts (purchase_order_id) WHERE purchase_order_id IS NOT NULL;

CREATE TABLE public.goods_receipt_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  goods_receipt_id uuid NOT NULL,
  po_line_id uuid,
  part_id uuid,
  material text CHECK (material IS NULL OR length(btrim(material)) BETWEEN 1 AND 200),
  quantity_received numeric(14, 3) NOT NULL CHECK (quantity_received > 0),
  lot_id uuid,
  notes text CHECK (notes IS NULL OR length(btrim(notes)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT goods_receipt_lines_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT goods_receipt_lines_receipt_fkey FOREIGN KEY (goods_receipt_id, organisation_id) REFERENCES public.goods_receipts (id, organisation_id),
  CONSTRAINT goods_receipt_lines_po_line_fkey FOREIGN KEY (po_line_id, organisation_id) REFERENCES public.purchase_order_lines (id, organisation_id),
  CONSTRAINT goods_receipt_lines_part_fkey FOREIGN KEY (part_id, organisation_id) REFERENCES public.parts (id, organisation_id),
  CONSTRAINT goods_receipt_lines_lot_fkey FOREIGN KEY (lot_id, organisation_id) REFERENCES public.lots (id, organisation_id),
  CONSTRAINT goods_receipt_lines_what CHECK (part_id IS NOT NULL OR material IS NOT NULL)
);
CREATE INDEX goods_receipt_lines_receipt_idx ON public.goods_receipt_lines (goods_receipt_id);
CREATE INDEX goods_receipt_lines_po_line_idx ON public.goods_receipt_lines (po_line_id) WHERE po_line_id IS NOT NULL;
CREATE INDEX goods_receipt_lines_lot_idx ON public.goods_receipt_lines (lot_id) WHERE lot_id IS NOT NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['purchase_orders', 'purchase_order_lines', 'goods_receipts', 'goods_receipt_lines'] LOOP
    EXECUTE format('CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION audit.record_change(%L)', t, 'organisation_id');
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format($p$CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (app.has_permission(organisation_id, 'receiving.read'))$p$, t || '_select', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION app.stamp_created()', t || '_stamp', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.touch_updated()', t || '_touch', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change()', t || '_org_immutable', t);
  END LOOP;
END $$;

-- The lines of a receipt and the identity of a receipt never change once written (a receipt is cancelled as a whole).
CREATE FUNCTION app.receipt_lines_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'Receipt lines are never changed or deleted: cancel the receipt instead' USING ERRCODE = 'QM021';
END $$;
CREATE TRIGGER goods_receipt_lines_frozen BEFORE UPDATE OR DELETE ON public.goods_receipt_lines FOR EACH ROW EXECUTE FUNCTION app.receipt_lines_frozen();

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.receiving_supplier_for_write(p_supplier uuid) RETURNS public.suppliers
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.suppliers%ROWTYPE;
BEGIN
  SELECT * INTO s FROM public.suppliers WHERE id = p_supplier;
  IF NOT FOUND OR NOT app.is_member(s.organisation_id) THEN RAISE EXCEPTION 'Supplier not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(s.organisation_id, 'receiving.manage') THEN RAISE EXCEPTION 'You are not allowed to record purchasing or receiving' USING ERRCODE = '42501'; END IF;
  RETURN s;
END $$;

-- ---------------------------------------------------------------------------
-- Purchase orders
-- p_lines: [{partId?, material?, quantity, unit?, requestedOn, agreedOn?}] (at least one; a part or a material)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.create_purchase_order(p_supplier uuid, p_po_number text, p_ordered_on date, p_notes text, p_lines jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.suppliers%ROWTYPE; v_id uuid; l jsonb; n integer := 0; v_part uuid; v_qty numeric; v_req date; v_agreed date;
BEGIN
  s := app.receiving_supplier_for_write(p_supplier);
  IF p_po_number IS NULL OR btrim(p_po_number) !~ '^\S(.{0,38}\S)?$' THEN RAISE EXCEPTION 'Give the order a number (up to 40 characters)' USING ERRCODE = 'QM021'; END IF;
  IF EXISTS (SELECT 1 FROM public.purchase_orders WHERE organisation_id = s.organisation_id AND upper(po_number) = upper(btrim(p_po_number))) THEN
    RAISE EXCEPTION 'There is already a purchase order numbered %', btrim(p_po_number) USING ERRCODE = 'QM021';
  END IF;
  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR jsonb_array_length(p_lines) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'An order needs between 1 and 100 lines' USING ERRCODE = 'QM021'; END IF;
  INSERT INTO public.purchase_orders (organisation_id, po_number, supplier_id, ordered_on, notes)
  VALUES (s.organisation_id, btrim(p_po_number), s.id, coalesce(p_ordered_on, current_date), nullif(btrim(coalesce(p_notes, '')), '')) RETURNING id INTO v_id;
  FOR l IN SELECT x FROM jsonb_array_elements(p_lines) x LOOP
    n := n + 1;
    IF jsonb_typeof(l) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(l) k WHERE k NOT IN ('partId', 'material', 'quantity', 'unit', 'requestedOn', 'agreedOn')) THEN RAISE EXCEPTION 'Line %: unknown field', n USING ERRCODE = 'QM021'; END IF;
    v_part := nullif(l ->> 'partId', '')::uuid;
    IF v_part IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.parts WHERE id = v_part AND organisation_id = s.organisation_id) THEN RAISE EXCEPTION 'Line %: part not found', n USING ERRCODE = 'P0002'; END IF;
    IF v_part IS NULL AND nullif(btrim(coalesce(l ->> 'material', '')), '') IS NULL THEN RAISE EXCEPTION 'Line %: name a part or a material', n USING ERRCODE = 'QM021'; END IF;
    IF coalesce(l ->> 'quantity', '') !~ '^[0-9]+(\.[0-9]{1,3})?$' OR (l ->> 'quantity')::numeric <= 0 THEN RAISE EXCEPTION 'Line %: the quantity is a number above zero', n USING ERRCODE = 'QM021'; END IF;
    v_qty := (l ->> 'quantity')::numeric;
    IF coalesce(l ->> 'requestedOn', '') !~ '^\d{4}-\d{2}-\d{2}$' THEN RAISE EXCEPTION 'Line %: say the date it was requested for', n USING ERRCODE = 'QM021'; END IF;
    v_req := (l ->> 'requestedOn')::date;
    v_agreed := nullif(l ->> 'agreedOn', '')::date;
    INSERT INTO public.purchase_order_lines (organisation_id, purchase_order_id, line_number, part_id, material, quantity_ordered, unit, requested_on, agreed_on)
    VALUES (s.organisation_id, v_id, n, v_part, nullif(btrim(coalesce(l ->> 'material', '')), ''), v_qty, nullif(btrim(coalesce(l ->> 'unit', '')), ''), v_req, v_agreed);
  END LOOP;
  RETURN v_id;
END $$;

CREATE FUNCTION app.po_for_write(p_po uuid) RETURNS public.purchase_orders
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o public.purchase_orders%ROWTYPE;
BEGIN
  SELECT * INTO o FROM public.purchase_orders WHERE id = p_po FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(o.organisation_id) THEN RAISE EXCEPTION 'Purchase order not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(o.organisation_id, 'receiving.manage') THEN RAISE EXCEPTION 'You are not allowed to change purchase orders' USING ERRCODE = '42501'; END IF;
  RETURN o;
END $$;

-- The latest agreed date for a line (the requested date never changes). NULL clears it.
CREATE FUNCTION app.set_po_line_agreed_date(p_line uuid, p_agreed_on date) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE l public.purchase_order_lines%ROWTYPE; o public.purchase_orders%ROWTYPE;
BEGIN
  SELECT * INTO l FROM public.purchase_order_lines WHERE id = p_line;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order line not found' USING ERRCODE = 'P0002'; END IF;
  o := app.po_for_write(l.purchase_order_id);
  IF o.status <> 'open' OR l.status <> 'open' THEN RAISE EXCEPTION 'Only an open line on an open order can be changed' USING ERRCODE = 'QM021'; END IF;
  UPDATE public.purchase_order_lines SET agreed_on = p_agreed_on, updated_by = auth.uid() WHERE id = l.id;
END $$;

-- Close: nothing more is expected. Cancel: it was never going to be delivered (reason). Open lines follow the order.
CREATE FUNCTION app.close_purchase_order(p_po uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o public.purchase_orders%ROWTYPE;
BEGIN
  o := app.po_for_write(p_po);
  IF o.status <> 'open' THEN RAISE EXCEPTION 'Only an open order can be closed' USING ERRCODE = 'QM021'; END IF;
  UPDATE public.purchase_order_lines SET status = 'closed', updated_by = auth.uid() WHERE purchase_order_id = o.id AND status = 'open';
  UPDATE public.purchase_orders SET status = 'closed', closed_at = now(), closed_by = auth.uid(), updated_by = auth.uid() WHERE id = o.id;
END $$;

CREATE FUNCTION app.cancel_purchase_order(p_po uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o public.purchase_orders%ROWTYPE;
BEGIN
  o := app.po_for_write(p_po);
  IF o.status <> 'open' THEN RAISE EXCEPTION 'Only an open order can be cancelled' USING ERRCODE = 'QM021'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'Say why the order is being cancelled (3 to 1000 characters)' USING ERRCODE = 'QM021'; END IF;
  UPDATE public.purchase_order_lines SET status = 'cancelled', updated_by = auth.uid() WHERE purchase_order_id = o.id AND status = 'open';
  UPDATE public.purchase_orders SET status = 'cancelled', cancel_reason = btrim(p_reason), updated_by = auth.uid() WHERE id = o.id;
END $$;

-- ---------------------------------------------------------------------------
-- Goods receipts
-- p_lines: [{poLineId?, partId?, material?, quantity, lotNumber?, notes?}]. A line that names a lot number makes the received lot (it needs a part).
-- Returns {id, created}; a retry with the same client key returns the same receipt.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.record_goods_receipt(p_supplier uuid, p_po uuid, p_site uuid, p_received_on date, p_delivery_note text, p_notes text, p_lines jsonb, p_client_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.suppliers%ROWTYPE; o public.purchase_orders%ROWTYPE; pl public.purchase_order_lines%ROWTYPE; v_year integer := extract(year FROM now())::int; v_n integer; v_id uuid; v_site uuid := p_site;
        l jsonb; i integer := 0; v_part uuid; v_poline uuid; v_material text; v_qty numeric; v_lot_no text; v_lot uuid;
BEGIN
  s := app.receiving_supplier_for_write(p_supplier);
  IF p_client_key IS NOT NULL THEN
    SELECT id INTO v_id FROM public.goods_receipts WHERE organisation_id = s.organisation_id AND client_key = p_client_key;
    IF FOUND THEN
      IF (SELECT supplier_id FROM public.goods_receipts WHERE id = v_id) <> s.id THEN RAISE EXCEPTION 'That request key was used for another supplier' USING ERRCODE = 'QM021'; END IF;
      RETURN jsonb_build_object('id', v_id, 'created', false);
    END IF;
  END IF;
  IF p_received_on IS NULL OR p_received_on > current_date THEN RAISE EXCEPTION 'Say when it arrived (not in the future)' USING ERRCODE = 'QM021'; END IF;
  IF p_po IS NOT NULL THEN
    SELECT * INTO o FROM public.purchase_orders WHERE id = p_po AND organisation_id = s.organisation_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Purchase order not found' USING ERRCODE = 'P0002'; END IF;
    IF o.supplier_id <> s.id THEN RAISE EXCEPTION 'That purchase order is for another supplier' USING ERRCODE = 'QM021'; END IF;
    IF o.status <> 'open' THEN RAISE EXCEPTION 'That purchase order is %', o.status USING ERRCODE = 'QM021'; END IF;
  END IF;
  IF v_site IS NULL THEN
    IF (SELECT count(*) FROM public.sites WHERE organisation_id = s.organisation_id AND active) = 1 THEN SELECT id INTO v_site FROM public.sites WHERE organisation_id = s.organisation_id AND active; END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM public.sites WHERE id = v_site AND organisation_id = s.organisation_id) THEN RAISE EXCEPTION 'Site not found' USING ERRCODE = 'P0002';
  END IF;
  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR jsonb_array_length(p_lines) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'A receipt needs between 1 and 100 lines' USING ERRCODE = 'QM021'; END IF;
  INSERT INTO app.goods_receipt_counters AS k (organisation_id, year, last_value) VALUES (s.organisation_id, v_year, 1)
  ON CONFLICT (organisation_id, year) DO UPDATE SET last_value = k.last_value + 1 RETURNING last_value INTO v_n;
  INSERT INTO public.goods_receipts (organisation_id, reference, supplier_id, purchase_order_id, site_id, received_on, delivery_note, notes, client_key)
  VALUES (s.organisation_id, 'GR-' || to_char(make_date(v_year, 1, 1), 'YY') || '-' || lpad(v_n::text, 4, '0'), s.id, p_po, v_site, p_received_on,
          nullif(btrim(coalesce(p_delivery_note, '')), ''), nullif(btrim(coalesce(p_notes, '')), ''), p_client_key) RETURNING id INTO v_id;
  FOR l IN SELECT x FROM jsonb_array_elements(p_lines) x LOOP
    i := i + 1;
    IF jsonb_typeof(l) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(l) k WHERE k NOT IN ('poLineId', 'partId', 'material', 'quantity', 'lotNumber', 'notes')) THEN RAISE EXCEPTION 'Line %: unknown field', i USING ERRCODE = 'QM021'; END IF;
    v_poline := nullif(l ->> 'poLineId', '')::uuid; v_part := nullif(l ->> 'partId', '')::uuid; v_material := nullif(btrim(coalesce(l ->> 'material', '')), ''); v_lot_no := nullif(btrim(coalesce(l ->> 'lotNumber', '')), '');
    IF coalesce(l ->> 'quantity', '') !~ '^[0-9]+(\.[0-9]{1,3})?$' OR (l ->> 'quantity')::numeric <= 0 THEN RAISE EXCEPTION 'Line %: the quantity is a number above zero', i USING ERRCODE = 'QM021'; END IF;
    v_qty := (l ->> 'quantity')::numeric;
    IF v_poline IS NOT NULL THEN
      SELECT * INTO pl FROM public.purchase_order_lines WHERE id = v_poline AND organisation_id = s.organisation_id;
      IF NOT FOUND OR p_po IS NULL OR pl.purchase_order_id <> p_po THEN RAISE EXCEPTION 'Line %: that order line is not on this purchase order', i USING ERRCODE = 'QM021'; END IF;
      IF pl.status <> 'open' THEN RAISE EXCEPTION 'Line %: that order line is %', i, pl.status USING ERRCODE = 'QM021'; END IF;
      IF v_part IS NOT NULL AND pl.part_id IS DISTINCT FROM v_part THEN RAISE EXCEPTION 'Line %: that is not the part on the order line', i USING ERRCODE = 'QM021'; END IF;
      v_part := coalesce(v_part, pl.part_id);
      v_material := coalesce(v_material, pl.material);
    END IF;
    IF v_part IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.parts WHERE id = v_part AND organisation_id = s.organisation_id) THEN RAISE EXCEPTION 'Line %: part not found', i USING ERRCODE = 'P0002'; END IF;
    IF v_part IS NULL AND v_material IS NULL THEN RAISE EXCEPTION 'Line %: name a part, a material or an order line', i USING ERRCODE = 'QM021'; END IF;
    v_lot := NULL;
    IF v_lot_no IS NOT NULL THEN
      IF v_part IS NULL THEN RAISE EXCEPTION 'Line %: a lot is of a part, so name the part', i USING ERRCODE = 'QM021'; END IF;
      IF v_lot_no !~ '^\S(.{0,58}\S)?$' THEN RAISE EXCEPTION 'Line %: the lot number is up to 60 characters', i USING ERRCODE = 'QM021'; END IF;
      IF EXISTS (SELECT 1 FROM public.lots WHERE organisation_id = s.organisation_id AND part_id = v_part AND upper(lot_number) = upper(v_lot_no)) THEN
        RAISE EXCEPTION 'Line %: lot % already exists for that part', i, v_lot_no USING ERRCODE = 'QM021';
      END IF;
      INSERT INTO public.lots (organisation_id, lot_number, part_id, origin, supplier_id, site_id, quantity, received_on) VALUES (s.organisation_id, v_lot_no, v_part, 'received', s.id, v_site, v_qty, p_received_on) RETURNING id INTO v_lot;
    END IF;
    INSERT INTO public.goods_receipt_lines (organisation_id, goods_receipt_id, po_line_id, part_id, material, quantity_received, lot_id, notes)
    VALUES (s.organisation_id, v_id, v_poline, v_part, v_material, v_qty, v_lot, nullif(btrim(coalesce(l ->> 'notes', '')), ''));
  END LOOP;
  RETURN jsonb_build_object('id', v_id, 'created', true);
END $$;

-- A receipt is cancelled as a whole, with a reason. The lots it made are kept (they may already be referenced): close them under Production if they are not real.
CREATE FUNCTION app.cancel_goods_receipt(p_receipt uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.goods_receipts%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.goods_receipts WHERE id = p_receipt FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(r.organisation_id) THEN RAISE EXCEPTION 'Goods receipt not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(r.organisation_id, 'receiving.manage') THEN RAISE EXCEPTION 'You are not allowed to change goods receipts' USING ERRCODE = '42501'; END IF;
  IF r.status <> 'received' THEN RAISE EXCEPTION 'That receipt is already cancelled' USING ERRCODE = 'QM021'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'Say why the receipt is being cancelled (3 to 1000 characters)' USING ERRCODE = 'QM021'; END IF;
  UPDATE public.goods_receipts SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), cancel_reason = btrim(p_reason), updated_by = auth.uid() WHERE id = r.id;
END $$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app.receipt_lines_frozen(), app.receiving_supplier_for_write(uuid), app.po_for_write(uuid) FROM PUBLIC, anon, authenticated;
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['create_purchase_order(uuid,text,date,text,jsonb)', 'set_po_line_agreed_date(uuid,date)', 'close_purchase_order(uuid)', 'cancel_purchase_order(uuid,text)',
    'record_goods_receipt(uuid,uuid,uuid,date,text,text,jsonb,text)', 'cancel_goods_receipt(uuid,text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION app.%s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION app.%s TO authenticated', f);
  END LOOP;
END $$;
