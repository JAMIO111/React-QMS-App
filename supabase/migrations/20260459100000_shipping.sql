-- Orders and fulfilment, SH1 (docs/order-fulfilment-plan.md): customer orders and shipments, the customer-side mirror of purchasing and goods receiving.
--  * customer_orders + customer_order_lines: what a customer asked for. A line is a part of ours, a quantity, the date the customer REQUESTED (never changes) and the
--    latest AGREED (confirmed) date (changes with an audit trail), so an on-time policy can use either. No prices, approvals or ERP sync.
--  * shipments + shipment_lines: what left, when, to whom, against which order line, optionally from which lot. A shipment never creates a lot (a lot already exists);
--    naming one lets a customer defect be traced to what was shipped. A shipment with no order line is allowed (counted, left out of on-time and in full later).
-- Everything is written by SECURITY DEFINER functions (shipping.manage); nothing is deleted; a shipment is cancelled as a whole with a reason; creating one is
-- idempotent per client key. Shipped, outstanding and late are worked out on read. Over-shipment is allowed. Errors QM038 -> 409 shipping_rule.

-- ---------------------------------------------------------------------------
-- 1. Module, permissions, packages (every permission must be priced: every_feature_priced.test.sql)
-- ---------------------------------------------------------------------------
INSERT INTO public.modules (slug, name, status, navigation_group, display_order) VALUES
  ('shipping', 'Shipping', 'active', 'Quality', 20)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.permissions (code, description) VALUES
  ('shipping.read',   'View customer orders and shipments'),
  ('shipping.manage', 'Record customer orders and shipments')
ON CONFLICT (code) DO NOTHING;

WITH grants(key, perms) AS (VALUES
  ('owner',            ARRAY['shipping.read', 'shipping.manage']),
  ('admin',            ARRAY['shipping.read', 'shipping.manage']),
  ('quality_manager',  ARRAY['shipping.read', 'shipping.manage']),
  ('quality_engineer', ARRAY['shipping.read', 'shipping.manage']),
  ('inspector',        ARRAY['shipping.read', 'shipping.manage']),
  ('viewer',           ARRAY['shipping.read'])
)
INSERT INTO public.role_permissions (role_id, permission_code)
SELECT r.id, unnest(g.perms) FROM public.roles r JOIN grants g ON g.key = r.key WHERE r.is_system
ON CONFLICT DO NOTHING;

INSERT INTO public.features (module_id, slug, name, min_access_level, permission_code)
SELECT m.id, f.slug, f.name, f.level, f.perm
  FROM (VALUES
    ('view_shipping',   'View customer orders and shipments',   'view',        'shipping.read'),
    ('record_shipping', 'Record customer orders and shipments', 'operational', 'shipping.manage')
  ) AS f(slug, name, level, perm)
  JOIN public.modules m ON m.slug = 'shipping'
ON CONFLICT DO NOTHING;

INSERT INTO public.subscription_entitlements (subscription_plan_id, module_id, access_level)
SELECT p.id, m.id, CASE WHEN p.slug = 'controller' THEN 'full' WHEN p.slug = 'observer' THEN 'view' ELSE 'operational' END
  FROM public.subscription_plans p CROSS JOIN public.modules m
 WHERE m.slug = 'shipping'
   AND NOT EXISTS (SELECT 1 FROM public.subscription_entitlements e WHERE e.subscription_plan_id = p.id AND e.module_id = m.id AND e.feature_id IS NULL);

CREATE TABLE app.shipment_counters (
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  year integer NOT NULL,
  last_value integer NOT NULL DEFAULT 0,
  PRIMARY KEY (organisation_id, year)
);
REVOKE ALL ON TABLE app.shipment_counters FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------
CREATE TABLE public.customer_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  order_number text NOT NULL CHECK (order_number ~ '^\S(.{0,38}\S)?$'),
  customer_id uuid NOT NULL,
  customer_reference text CHECK (customer_reference IS NULL OR customer_reference ~ '^\S(.{0,58}\S)?$'),
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
  CONSTRAINT customer_orders_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT customer_orders_customer_fkey FOREIGN KEY (customer_id, organisation_id) REFERENCES public.customers (id, organisation_id),
  CONSTRAINT customer_orders_state CHECK ((status = 'closed') = (closed_at IS NOT NULL) AND ((status = 'cancelled') = (cancel_reason IS NOT NULL)))
);
CREATE UNIQUE INDEX customer_orders_number_key ON public.customer_orders (organisation_id, upper(order_number));
CREATE INDEX customer_orders_customer_idx ON public.customer_orders (customer_id, ordered_on DESC);

CREATE TABLE public.customer_order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  customer_order_id uuid NOT NULL,
  line_number integer NOT NULL CHECK (line_number >= 1),
  part_id uuid NOT NULL,
  quantity_ordered numeric(14, 3) NOT NULL CHECK (quantity_ordered > 0),
  unit text CHECK (unit IS NULL OR length(btrim(unit)) BETWEEN 1 AND 20),
  requested_on date NOT NULL,
  agreed_on date,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT customer_order_lines_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT customer_order_lines_order_fkey FOREIGN KEY (customer_order_id, organisation_id) REFERENCES public.customer_orders (id, organisation_id),
  CONSTRAINT customer_order_lines_part_fkey FOREIGN KEY (part_id, organisation_id) REFERENCES public.parts (id, organisation_id),
  CONSTRAINT customer_order_lines_number_key UNIQUE (customer_order_id, line_number)
);

CREATE TABLE public.shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  reference text NOT NULL,
  customer_id uuid NOT NULL,
  customer_order_id uuid,
  site_id uuid,
  shipped_on date NOT NULL,
  delivery_note text CHECK (delivery_note IS NULL OR length(btrim(delivery_note)) BETWEEN 1 AND 100),
  notes text CHECK (notes IS NULL OR length(btrim(notes)) BETWEEN 1 AND 2000),
  status text NOT NULL DEFAULT 'shipped' CHECK (status IN ('shipped', 'cancelled')),
  cancelled_at timestamptz,
  cancelled_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  cancel_reason text CHECK (cancel_reason IS NULL OR length(btrim(cancel_reason)) BETWEEN 3 AND 1000),
  client_key text CHECK (client_key IS NULL OR length(client_key) BETWEEN 8 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT shipments_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT shipments_reference_key UNIQUE (organisation_id, reference),
  CONSTRAINT shipments_customer_fkey FOREIGN KEY (customer_id, organisation_id) REFERENCES public.customers (id, organisation_id),
  CONSTRAINT shipments_order_fkey FOREIGN KEY (customer_order_id, organisation_id) REFERENCES public.customer_orders (id, organisation_id),
  CONSTRAINT shipments_site_fkey FOREIGN KEY (site_id, organisation_id) REFERENCES public.sites (id, organisation_id),
  CONSTRAINT shipments_state CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL))
);
CREATE UNIQUE INDEX shipments_client_key ON public.shipments (organisation_id, client_key) WHERE client_key IS NOT NULL;
CREATE INDEX shipments_customer_idx ON public.shipments (customer_id, shipped_on DESC);
CREATE INDEX shipments_order_idx ON public.shipments (customer_order_id) WHERE customer_order_id IS NOT NULL;

CREATE TABLE public.shipment_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  shipment_id uuid NOT NULL,
  line_number integer NOT NULL CHECK (line_number >= 1),
  order_line_id uuid,
  part_id uuid NOT NULL,
  quantity_shipped numeric(14, 3) NOT NULL CHECK (quantity_shipped > 0),
  lot_id uuid,
  notes text CHECK (notes IS NULL OR length(btrim(notes)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT shipment_lines_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT shipment_lines_shipment_fkey FOREIGN KEY (shipment_id, organisation_id) REFERENCES public.shipments (id, organisation_id),
  CONSTRAINT shipment_lines_order_line_fkey FOREIGN KEY (order_line_id, organisation_id) REFERENCES public.customer_order_lines (id, organisation_id),
  CONSTRAINT shipment_lines_part_fkey FOREIGN KEY (part_id, organisation_id) REFERENCES public.parts (id, organisation_id),
  CONSTRAINT shipment_lines_lot_fkey FOREIGN KEY (lot_id, organisation_id) REFERENCES public.lots (id, organisation_id),
  CONSTRAINT shipment_lines_number_key UNIQUE (shipment_id, line_number)
);
CREATE INDEX shipment_lines_shipment_idx ON public.shipment_lines (shipment_id);
CREATE INDEX shipment_lines_order_line_idx ON public.shipment_lines (order_line_id) WHERE order_line_id IS NOT NULL;
CREATE INDEX shipment_lines_lot_idx ON public.shipment_lines (lot_id) WHERE lot_id IS NOT NULL;
CREATE INDEX shipment_lines_part_idx ON public.shipment_lines (part_id);

-- Read policies say the organisation-wide grant once per statement (app.orgs_permitted) and keep the per-row check as the fall-back for a site-limited grant,
-- the pattern the efficiency round set for hot tables; nothing is widened.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['customer_orders', 'customer_order_lines', 'shipments', 'shipment_lines'] LOOP
    EXECUTE format('CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION audit.record_change(%L)', t, 'organisation_id');
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format($p$CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (organisation_id IN (SELECT app.orgs_permitted('shipping.read')) OR app.has_permission(organisation_id, 'shipping.read'))$p$, t || '_select', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION app.stamp_created()', t || '_stamp', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.touch_updated()', t || '_touch', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change()', t || '_org_immutable', t);
  END LOOP;
END $$;

-- The lines of a shipment never change once written (a shipment is cancelled as a whole).
CREATE FUNCTION app.shipment_lines_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'Shipment lines are never changed or deleted: cancel the shipment instead' USING ERRCODE = 'QM038';
END $$;
CREATE TRIGGER shipment_lines_frozen BEFORE UPDATE OR DELETE ON public.shipment_lines FOR EACH ROW EXECUTE FUNCTION app.shipment_lines_frozen();

-- ---------------------------------------------------------------------------
-- 3. Functions
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.shipping_customer_for_write(p_customer uuid) RETURNS public.customers
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.customers%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.customers WHERE id = p_customer;
  IF NOT FOUND OR NOT app.is_member(c.organisation_id) THEN RAISE EXCEPTION 'Customer not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(c.organisation_id, 'shipping.manage') THEN RAISE EXCEPTION 'You are not allowed to record orders or shipments' USING ERRCODE = '42501'; END IF;
  RETURN c;
END $$;

-- p_lines: [{partId, quantity, unit?, requestedOn, agreedOn?}] (1 to 100)
CREATE FUNCTION app.create_customer_order(p_customer uuid, p_order_number text, p_customer_reference text, p_ordered_on date, p_notes text, p_lines jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.customers%ROWTYPE; v_id uuid; l jsonb; n integer := 0; v_part uuid; v_qty numeric; v_req date; v_agreed date;
BEGIN
  c := app.shipping_customer_for_write(p_customer);
  IF NOT c.active THEN RAISE EXCEPTION 'That customer is switched off' USING ERRCODE = 'QM038'; END IF;
  IF p_order_number IS NULL OR btrim(p_order_number) !~ '^\S(.{0,38}\S)?$' THEN RAISE EXCEPTION 'Give the order a number (up to 40 characters)' USING ERRCODE = 'QM038'; END IF;
  IF nullif(btrim(coalesce(p_customer_reference, '')), '') IS NOT NULL AND btrim(p_customer_reference) !~ '^\S(.{0,58}\S)?$' THEN RAISE EXCEPTION 'The customer''s own order number is up to 60 characters' USING ERRCODE = 'QM038'; END IF;
  IF EXISTS (SELECT 1 FROM public.customer_orders WHERE organisation_id = c.organisation_id AND upper(order_number) = upper(btrim(p_order_number))) THEN
    RAISE EXCEPTION 'There is already a customer order numbered %', btrim(p_order_number) USING ERRCODE = 'QM038';
  END IF;
  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR jsonb_array_length(p_lines) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'An order needs between 1 and 100 lines' USING ERRCODE = 'QM038'; END IF;
  INSERT INTO public.customer_orders (organisation_id, order_number, customer_id, customer_reference, ordered_on, notes)
  VALUES (c.organisation_id, btrim(p_order_number), c.id, nullif(btrim(coalesce(p_customer_reference, '')), ''), coalesce(p_ordered_on, current_date), nullif(btrim(coalesce(p_notes, '')), ''))
  RETURNING id INTO v_id;
  FOR l IN SELECT x FROM jsonb_array_elements(p_lines) x LOOP
    n := n + 1;
    IF jsonb_typeof(l) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(l) k WHERE k NOT IN ('partId', 'quantity', 'unit', 'requestedOn', 'agreedOn')) THEN RAISE EXCEPTION 'Line %: unknown field', n USING ERRCODE = 'QM038'; END IF;
    v_part := nullif(l ->> 'partId', '')::uuid;
    IF v_part IS NULL THEN RAISE EXCEPTION 'Line %: name the part', n USING ERRCODE = 'QM038'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.parts WHERE id = v_part AND organisation_id = c.organisation_id) THEN RAISE EXCEPTION 'Line %: part not found', n USING ERRCODE = 'P0002'; END IF;
    IF coalesce(l ->> 'quantity', '') !~ '^[0-9]+(\.[0-9]{1,3})?$' OR (l ->> 'quantity')::numeric <= 0 THEN RAISE EXCEPTION 'Line %: the quantity is a number above zero', n USING ERRCODE = 'QM038'; END IF;
    v_qty := (l ->> 'quantity')::numeric;
    IF coalesce(l ->> 'requestedOn', '') !~ '^\d{4}-\d{2}-\d{2}$' THEN RAISE EXCEPTION 'Line %: say the date the customer asked for', n USING ERRCODE = 'QM038'; END IF;
    v_req := (l ->> 'requestedOn')::date;
    v_agreed := nullif(l ->> 'agreedOn', '')::date;
    INSERT INTO public.customer_order_lines (organisation_id, customer_order_id, line_number, part_id, quantity_ordered, unit, requested_on, agreed_on)
    VALUES (c.organisation_id, v_id, n, v_part, v_qty, nullif(btrim(coalesce(l ->> 'unit', '')), ''), v_req, v_agreed);
  END LOOP;
  RETURN v_id;
END $$;

CREATE FUNCTION app.customer_order_for_write(p_order uuid) RETURNS public.customer_orders
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o public.customer_orders%ROWTYPE;
BEGIN
  SELECT * INTO o FROM public.customer_orders WHERE id = p_order FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(o.organisation_id) THEN RAISE EXCEPTION 'Customer order not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(o.organisation_id, 'shipping.manage') THEN RAISE EXCEPTION 'You are not allowed to change customer orders' USING ERRCODE = '42501'; END IF;
  RETURN o;
END $$;

-- The latest agreed (confirmed) date for a line; the requested date never changes. NULL clears it.
CREATE FUNCTION app.set_order_line_agreed_date(p_line uuid, p_agreed_on date) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE l public.customer_order_lines%ROWTYPE; o public.customer_orders%ROWTYPE;
BEGIN
  SELECT * INTO l FROM public.customer_order_lines WHERE id = p_line;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order line not found' USING ERRCODE = 'P0002'; END IF;
  o := app.customer_order_for_write(l.customer_order_id);
  IF o.status <> 'open' OR l.status <> 'open' THEN RAISE EXCEPTION 'Only an open line on an open order can be changed' USING ERRCODE = 'QM038'; END IF;
  UPDATE public.customer_order_lines SET agreed_on = p_agreed_on, updated_by = auth.uid() WHERE id = l.id;
END $$;

-- Close: nothing more is expected. Cancel: it was never going to ship (reason). Open lines follow the order.
CREATE FUNCTION app.close_customer_order(p_order uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o public.customer_orders%ROWTYPE;
BEGIN
  o := app.customer_order_for_write(p_order);
  IF o.status <> 'open' THEN RAISE EXCEPTION 'Only an open order can be closed' USING ERRCODE = 'QM038'; END IF;
  UPDATE public.customer_order_lines SET status = 'closed', updated_by = auth.uid() WHERE customer_order_id = o.id AND status = 'open';
  UPDATE public.customer_orders SET status = 'closed', closed_at = now(), closed_by = auth.uid(), updated_by = auth.uid() WHERE id = o.id;
END $$;

CREATE FUNCTION app.cancel_customer_order(p_order uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o public.customer_orders%ROWTYPE;
BEGIN
  o := app.customer_order_for_write(p_order);
  IF o.status <> 'open' THEN RAISE EXCEPTION 'Only an open order can be cancelled' USING ERRCODE = 'QM038'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'Say why the order is being cancelled (3 to 1000 characters)' USING ERRCODE = 'QM038'; END IF;
  UPDATE public.customer_order_lines SET status = 'cancelled', updated_by = auth.uid() WHERE customer_order_id = o.id AND status = 'open';
  UPDATE public.customer_orders SET status = 'cancelled', cancel_reason = btrim(p_reason), updated_by = auth.uid() WHERE id = o.id;
END $$;

-- p_lines: [{orderLineId?, partId?, quantity, lotId?, lotNumber?, notes?}]. A lot, when named, is an existing lot of the line's part (a shipment never makes one).
-- A line that names an order line brings its part. Over-shipment is allowed. Returns {id, created}; a retry with the same client key returns the same shipment.
CREATE FUNCTION app.record_shipment(p_customer uuid, p_order uuid, p_site uuid, p_shipped_on date, p_delivery_note text, p_notes text, p_lines jsonb, p_client_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.customers%ROWTYPE; o public.customer_orders%ROWTYPE; ol public.customer_order_lines%ROWTYPE; v_year integer := extract(year FROM now())::int; v_n integer; v_id uuid; v_site uuid := p_site;
        l jsonb; i integer := 0; v_part uuid; v_oline uuid; v_qty numeric; v_lot uuid; v_lot_no text; v_lot_part uuid;
BEGIN
  c := app.shipping_customer_for_write(p_customer);
  IF p_client_key IS NOT NULL THEN
    SELECT id INTO v_id FROM public.shipments WHERE organisation_id = c.organisation_id AND client_key = p_client_key;
    IF FOUND THEN
      IF (SELECT customer_id FROM public.shipments WHERE id = v_id) <> c.id THEN RAISE EXCEPTION 'That request key was used for another customer' USING ERRCODE = 'QM038'; END IF;
      RETURN jsonb_build_object('id', v_id, 'created', false);
    END IF;
  END IF;
  IF p_shipped_on IS NULL OR p_shipped_on > current_date THEN RAISE EXCEPTION 'Say when it shipped (not in the future)' USING ERRCODE = 'QM038'; END IF;
  IF p_order IS NOT NULL THEN
    SELECT * INTO o FROM public.customer_orders WHERE id = p_order AND organisation_id = c.organisation_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Customer order not found' USING ERRCODE = 'P0002'; END IF;
    IF o.customer_id <> c.id THEN RAISE EXCEPTION 'That customer order is for another customer' USING ERRCODE = 'QM038'; END IF;
    IF o.status <> 'open' THEN RAISE EXCEPTION 'That customer order is %', o.status USING ERRCODE = 'QM038'; END IF;
  END IF;
  IF v_site IS NULL THEN
    IF (SELECT count(*) FROM public.sites WHERE organisation_id = c.organisation_id AND active) = 1 THEN SELECT id INTO v_site FROM public.sites WHERE organisation_id = c.organisation_id AND active; END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM public.sites WHERE id = v_site AND organisation_id = c.organisation_id) THEN RAISE EXCEPTION 'Site not found' USING ERRCODE = 'P0002';
  END IF;
  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR jsonb_array_length(p_lines) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'A shipment needs between 1 and 100 lines' USING ERRCODE = 'QM038'; END IF;
  INSERT INTO app.shipment_counters AS k (organisation_id, year, last_value) VALUES (c.organisation_id, v_year, 1)
  ON CONFLICT (organisation_id, year) DO UPDATE SET last_value = k.last_value + 1 RETURNING last_value INTO v_n;
  INSERT INTO public.shipments (organisation_id, reference, customer_id, customer_order_id, site_id, shipped_on, delivery_note, notes, client_key)
  VALUES (c.organisation_id, 'SH-' || to_char(make_date(v_year, 1, 1), 'YY') || '-' || app.pad_number(v_n, 4), c.id, p_order, v_site, p_shipped_on,
          nullif(btrim(coalesce(p_delivery_note, '')), ''), nullif(btrim(coalesce(p_notes, '')), ''), p_client_key) RETURNING id INTO v_id;
  FOR l IN SELECT x FROM jsonb_array_elements(p_lines) x LOOP
    i := i + 1;
    IF jsonb_typeof(l) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(l) k WHERE k NOT IN ('orderLineId', 'partId', 'quantity', 'lotId', 'lotNumber', 'notes')) THEN RAISE EXCEPTION 'Line %: unknown field', i USING ERRCODE = 'QM038'; END IF;
    v_oline := nullif(l ->> 'orderLineId', '')::uuid; v_part := nullif(l ->> 'partId', '')::uuid; v_lot := nullif(l ->> 'lotId', '')::uuid; v_lot_no := nullif(btrim(coalesce(l ->> 'lotNumber', '')), '');
    IF coalesce(l ->> 'quantity', '') !~ '^[0-9]+(\.[0-9]{1,3})?$' OR (l ->> 'quantity')::numeric <= 0 THEN RAISE EXCEPTION 'Line %: the quantity is a number above zero', i USING ERRCODE = 'QM038'; END IF;
    v_qty := (l ->> 'quantity')::numeric;
    IF v_oline IS NOT NULL THEN
      SELECT * INTO ol FROM public.customer_order_lines WHERE id = v_oline AND organisation_id = c.organisation_id;
      IF NOT FOUND OR p_order IS NULL OR ol.customer_order_id <> p_order THEN RAISE EXCEPTION 'Line %: that order line is not on this customer order', i USING ERRCODE = 'QM038'; END IF;
      IF ol.status <> 'open' THEN RAISE EXCEPTION 'Line %: that order line is %', i, ol.status USING ERRCODE = 'QM038'; END IF;
      IF v_part IS NOT NULL AND ol.part_id <> v_part THEN RAISE EXCEPTION 'Line %: that is not the part on the order line', i USING ERRCODE = 'QM038'; END IF;
      v_part := ol.part_id;
    END IF;
    IF v_part IS NULL THEN RAISE EXCEPTION 'Line %: name a part or an order line', i USING ERRCODE = 'QM038'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.parts WHERE id = v_part AND organisation_id = c.organisation_id) THEN RAISE EXCEPTION 'Line %: part not found', i USING ERRCODE = 'P0002'; END IF;
    IF v_lot IS NULL AND v_lot_no IS NOT NULL THEN
      SELECT id INTO v_lot FROM public.lots WHERE organisation_id = c.organisation_id AND part_id = v_part AND upper(lot_number) = upper(v_lot_no);
      IF v_lot IS NULL THEN RAISE EXCEPTION 'Line %: there is no lot % for that part', i, v_lot_no USING ERRCODE = 'QM038'; END IF;
    END IF;
    IF v_lot IS NOT NULL THEN
      SELECT part_id INTO v_lot_part FROM public.lots WHERE id = v_lot AND organisation_id = c.organisation_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'Line %: lot not found', i USING ERRCODE = 'P0002'; END IF;
      IF v_lot_part <> v_part THEN RAISE EXCEPTION 'Line %: that lot is of another part', i USING ERRCODE = 'QM038'; END IF;
    END IF;
    INSERT INTO public.shipment_lines (organisation_id, shipment_id, line_number, order_line_id, part_id, quantity_shipped, lot_id, notes)
    VALUES (c.organisation_id, v_id, i, v_oline, v_part, v_qty, v_lot, nullif(btrim(coalesce(l ->> 'notes', '')), ''));
  END LOOP;
  RETURN jsonb_build_object('id', v_id, 'created', true);
END $$;

-- A shipment is cancelled as a whole, with a reason (it never left, or was keyed in error).
CREATE FUNCTION app.cancel_shipment(p_shipment uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.shipments%ROWTYPE;
BEGIN
  SELECT * INTO s FROM public.shipments WHERE id = p_shipment FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(s.organisation_id) THEN RAISE EXCEPTION 'Shipment not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(s.organisation_id, 'shipping.manage') THEN RAISE EXCEPTION 'You are not allowed to change shipments' USING ERRCODE = '42501'; END IF;
  IF s.status <> 'shipped' THEN RAISE EXCEPTION 'That shipment is already cancelled' USING ERRCODE = 'QM038'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'Say why the shipment is being cancelled (3 to 1000 characters)' USING ERRCODE = 'QM038'; END IF;
  UPDATE public.shipments SET status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), cancel_reason = btrim(p_reason), updated_by = auth.uid() WHERE id = s.id;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Privileges
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app.shipment_lines_frozen(), app.shipping_customer_for_write(uuid), app.customer_order_for_write(uuid) FROM PUBLIC, anon, authenticated;
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['create_customer_order(uuid,text,text,date,text,jsonb)', 'set_order_line_agreed_date(uuid,date)', 'close_customer_order(uuid)', 'cancel_customer_order(uuid,text)',
    'record_shipment(uuid,uuid,uuid,date,text,text,jsonb,text)', 'cancel_shipment(uuid,text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION app.%s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION app.%s TO authenticated', f);
  END LOOP;
END $$;
