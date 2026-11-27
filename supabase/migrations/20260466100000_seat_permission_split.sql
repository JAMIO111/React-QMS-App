-- Seat permissions: split four permissions that bundled shop-floor work with management, and move three to the full level
-- (docs/seat-permissions-review.md). Seats are meant to be: Controller (full) = management and quality, Contributor (operational) = shop-floor
-- operators, Observer (view) = other stakeholders who want to see data. A review of the live levels found operational permissions that let an
-- operator do things a manager should decide, and operators who could start a record but not finish it.
--
-- Split (the old permission keeps its name and moves to full; a new one carries the shop-floor part, and everyone who held the old one is given it):
--   ncr.contribute                  NEW, operational. Add files and containment actions to a non-conformance YOU raised. ncr.update (full) still edits any.
--                                   An operator could raise an NC (ncr.create) but not attach a photo or record containment: both needed ncr.update.
--   receiving.record                NEW, operational. Record a delivery, decide a received line, record material certificates.
--     receiving.manage              now FULL. Create, change, close and cancel purchase orders, change agreed dates, cancel a delivery. The agreed date
--                                   feeds the supplier's on-time score, so it is not for the person being measured.
--   shipping.record                 NEW, operational. Record a shipment.
--     shipping.manage               now FULL. Create, change, close and cancel customer orders, change agreed dates, cancel a shipment (same reason).
--   inspection.acknowledge_failure  NEW, FULL. Acknowledge a failed reading with a note instead of raising a non-conformance. It used to need only
--                                   inspection.record, so the person who measured could clear their own failure and finish the job with no NC and no second
--                                   person. An operator can still resolve a failure by raising an NC (ncr.create); quality decides when it is not one.
-- Moved to full (no new permission):
--   change.approve       every other approval is full (process_control, risk, fmea, ppap, supplier_quality, capa.verify, ncr.approve_disposition)
--   integrations.run     integrations are Controller-only anyway (no access below it, and a Controller seat is required): the table now says so
--   audit.read           the audit trail shows every change to every table with before and after values, past the module permissions
-- The built-in Inspector role no longer holds receiving.manage or shipping.manage (it keeps receiving.record and shipping.record) and does not get
-- inspection.acknowledge_failure. Custom roles keep what they chose: whoever held a split permission is given its new part, and whoever held
-- inspection.correct or inspection.override_gauge (the people who already correct readings) is given inspection.acknowledge_failure.
-- A person's seat still caps what a role gives: a role holding receiving.manage on a Contributor seat now keeps receiving.record only.
--
-- Not changed here, deliberately: cost visibility (ncr_costs is read with ncr.read; splitting it ripples through registers, dashboards and reports) and
-- production (no operational permission yet; lot and order status changes need production.manage).
--
-- Organisations that do not enforce packages are unaffected by the level changes (app.has_entitlement answers true there); the role changes apply to all.
-- Shared functions are changed by a checked text patch from their live definitions: the migration refuses to finish unless each anchor is found
-- exactly once, and does nothing when its marker is already there, so running it again is safe.

CREATE OR REPLACE FUNCTION pg_temp.patch(p_fn regprocedure, p_old text, p_new text, p_marker text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_def text := replace(pg_get_functiondef(p_fn), E'\r', ''); v_n integer;
BEGIN
  IF position(p_marker IN v_def) > 0 THEN RETURN; END IF;
  v_n := (length(v_def) - length(replace(v_def, p_old, ''))) / length(p_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'Expected to find % exactly once in %, found % times', p_old, p_fn, v_n; END IF;
  EXECUTE replace(v_def, p_old, p_new);
END $$;

-- ---------------------------------------------------------------------------
-- 1. The new permissions, and who holds them
-- ---------------------------------------------------------------------------
INSERT INTO public.permissions (code, description) VALUES
  ('ncr.contribute',                 'Add files and containment actions to non-conformances you raised'),
  ('receiving.record',               'Record deliveries, decide received lines and record material certificates'),
  ('shipping.record',                'Record shipments'),
  ('inspection.acknowledge_failure', 'Acknowledge a failed inspection reading instead of raising a non-conformance')
ON CONFLICT (code) DO NOTHING;

UPDATE public.permissions SET description = 'Create, change, close and cancel purchase orders, change agreed dates and cancel deliveries'
 WHERE code = 'receiving.manage';
UPDATE public.permissions SET description = 'Create, change, close and cancel customer orders, change agreed dates and cancel shipments'
 WHERE code = 'shipping.manage';

-- Every role (built in or custom) that held the old permission gets the new part.
INSERT INTO public.role_permissions (role_id, permission_code)
SELECT DISTINCT rp.role_id, 'ncr.contribute' FROM public.role_permissions rp WHERE rp.permission_code = 'ncr.create'
ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code)
SELECT DISTINCT rp.role_id, 'receiving.record' FROM public.role_permissions rp WHERE rp.permission_code = 'receiving.manage'
ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code)
SELECT DISTINCT rp.role_id, 'shipping.record' FROM public.role_permissions rp WHERE rp.permission_code = 'shipping.manage'
ON CONFLICT DO NOTHING;
-- Acknowledging a failure is a quality decision: it goes to the roles that already correct readings or override a gauge.
INSERT INTO public.role_permissions (role_id, permission_code)
SELECT DISTINCT rp.role_id, 'inspection.acknowledge_failure' FROM public.role_permissions rp
 WHERE rp.permission_code IN ('inspection.correct', 'inspection.override_gauge')
ON CONFLICT DO NOTHING;

-- The built-in Inspector keeps only the shop-floor part.
DELETE FROM public.role_permissions rp
 USING public.roles r
 WHERE r.id = rp.role_id AND r.is_system AND r.key = 'inspector'
   AND rp.permission_code IN ('receiving.manage', 'shipping.manage');

-- ---------------------------------------------------------------------------
-- 2. Packages: the new permissions are priced, the old ones and three more move to full
-- ---------------------------------------------------------------------------
-- The old features keep their rows (so anything pointing at them stays) and take the new meaning; the slug follows it.
UPDATE public.features SET slug = 'manage_receiving', name = 'Manage purchase orders and cancel deliveries', min_access_level = 'full'
 WHERE permission_code = 'receiving.manage' AND slug = 'record_receiving';
UPDATE public.features SET slug = 'manage_shipping', name = 'Manage customer orders and cancel shipments', min_access_level = 'full'
 WHERE permission_code = 'shipping.manage' AND slug = 'record_shipping';

INSERT INTO public.features (module_id, slug, name, min_access_level, permission_code)
SELECT m.id, f.slug, f.name, f.level, f.perm
  FROM (VALUES
    ('nonconformance',   'contribute_ncrs',      'Add files and containment to your own non-conformances', 'operational', 'ncr.contribute'),
    ('supplier_quality', 'record_receiving',     'Record deliveries and certificates',                      'operational', 'receiving.record'),
    ('shipping',         'record_shipping',      'Record shipments',                                        'operational', 'shipping.record'),
    ('inspections',      'acknowledge_failures', 'Acknowledge failed readings',                             'full',        'inspection.acknowledge_failure')
  ) AS f(module_slug, slug, name, level, perm)
  JOIN public.modules m ON m.slug = f.module_slug
ON CONFLICT DO NOTHING;

UPDATE public.features SET min_access_level = 'full'
 WHERE permission_code IN ('change.approve', 'integrations.run', 'audit.read');

-- The Operator (seats and prices 2026) raises non-conformances, so it also adds files and containment to its own: an explicit feature row, because the
-- Operator's module rows stop at view (app.subscription_entitlement_rules).
INSERT INTO public.subscription_entitlements (subscription_plan_id, module_id, feature_id, access_level)
SELECT p.id, f.module_id, f.id, 'operational'
  FROM public.subscription_plans p CROSS JOIN public.features f
 WHERE p.slug = 'operator' AND f.permission_code = 'ncr.contribute'
   AND NOT EXISTS (SELECT 1 FROM public.subscription_entitlements e WHERE e.subscription_plan_id = p.id AND e.feature_id = f.id);

-- Nothing may be left unpriced (the same check as every_feature_priced).
DO $$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(p.code, ', ' ORDER BY p.code) INTO v_missing
    FROM public.permissions p
   WHERE NOT EXISTS (SELECT 1 FROM public.features f WHERE f.permission_code = p.code)
     AND p.code <> ALL (app.unpriced_permissions());
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Permissions not tied to a package (add a feature, or list them in app.unpriced_permissions()): %', v_missing;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Receiving: recording is operational, managing orders is full
-- ---------------------------------------------------------------------------
-- A delivery is recorded for a supplier: same lookup as app.receiving_supplier_for_write, asking for the recording permission.
CREATE OR REPLACE FUNCTION app.receiving_supplier_for_record(p_supplier uuid) RETURNS public.suppliers
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.suppliers%ROWTYPE;
BEGIN
  SELECT * INTO s FROM public.suppliers WHERE id = p_supplier;
  IF NOT FOUND OR NOT app.is_member(s.organisation_id) THEN RAISE EXCEPTION 'Supplier not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(s.organisation_id, 'receiving.record') THEN RAISE EXCEPTION 'You are not allowed to record deliveries' USING ERRCODE = '42501'; END IF;
  RETURN s;
END $$;
REVOKE ALL ON FUNCTION app.receiving_supplier_for_record(uuid) FROM PUBLIC, anon, authenticated;

SELECT pg_temp.patch('app.record_goods_receipt(uuid, uuid, uuid, date, text, text, jsonb, text)'::regprocedure,
  'app.receiving_supplier_for_write(', 'app.receiving_supplier_for_record(', 'receiving_supplier_for_record');
SELECT pg_temp.patch('app.disposition_receipt_line(uuid, text, text, text, numeric)'::regprocedure,
  '''receiving.manage''', '''receiving.record''', '''receiving.record''');
SELECT pg_temp.patch('app.record_material_certificate(uuid, jsonb)'::regprocedure,
  '''receiving.manage''', '''receiving.record''', '''receiving.record''');
SELECT pg_temp.patch('app.update_material_certificate(uuid, jsonb)'::regprocedure,
  '''receiving.manage''', '''receiving.record''', '''receiving.record''');
SELECT pg_temp.patch('app.withdraw_material_certificate(uuid, text)'::regprocedure,
  '''receiving.manage''', '''receiving.record''', '''receiving.record''');

-- ---------------------------------------------------------------------------
-- 4. Shipping: recording is operational, managing orders is full
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.shipping_customer_for_record(p_customer uuid) RETURNS public.customers
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.customers%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.customers WHERE id = p_customer;
  IF NOT FOUND OR NOT app.is_member(c.organisation_id) THEN RAISE EXCEPTION 'Customer not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(c.organisation_id, 'shipping.record') THEN RAISE EXCEPTION 'You are not allowed to record shipments' USING ERRCODE = '42501'; END IF;
  RETURN c;
END $$;
REVOKE ALL ON FUNCTION app.shipping_customer_for_record(uuid) FROM PUBLIC, anon, authenticated;

SELECT pg_temp.patch('app.record_shipment(uuid, uuid, uuid, date, text, text, jsonb, text)'::regprocedure,
  'app.shipping_customer_for_write(', 'app.shipping_customer_for_record(', 'shipping_customer_for_record');

-- ---------------------------------------------------------------------------
-- 5. Non-conformances: an operator finishes what they started
-- ---------------------------------------------------------------------------
-- ncr.contribute works only on a non-conformance the person raised (created_by); the site is still checked. The records themselves keep every
-- rule they had (a closed, cancelled or deleted non-conformance accepts nothing: app.assert_ncr_editable).
CREATE OR REPLACE FUNCTION app.ncr_created_by_me(p_ncr_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.nonconformances n WHERE n.id = p_ncr_id AND n.created_by = (SELECT auth.uid()))
$$;
REVOKE ALL ON FUNCTION app.ncr_created_by_me(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.ncr_created_by_me(uuid) TO authenticated;

DROP POLICY ncr_attachments_insert ON public.ncr_attachments;
CREATE POLICY ncr_attachments_insert ON public.ncr_attachments FOR INSERT TO authenticated
  WITH CHECK (app.has_permission(organisation_id, 'ncr.update', app.ncr_site(nonconformance_id))
           OR (app.has_permission(organisation_id, 'ncr.contribute', app.ncr_site(nonconformance_id)) AND app.ncr_created_by_me(nonconformance_id)));
DROP POLICY ncr_attachments_update ON public.ncr_attachments;
CREATE POLICY ncr_attachments_update ON public.ncr_attachments FOR UPDATE TO authenticated
  USING (app.has_permission(organisation_id, 'ncr.update', app.ncr_site(nonconformance_id))
      OR (app.has_permission(organisation_id, 'ncr.contribute', app.ncr_site(nonconformance_id)) AND app.ncr_created_by_me(nonconformance_id)))
  WITH CHECK (app.has_permission(organisation_id, 'ncr.update', app.ncr_site(nonconformance_id))
      OR (app.has_permission(organisation_id, 'ncr.contribute', app.ncr_site(nonconformance_id)) AND app.ncr_created_by_me(nonconformance_id)));

DROP POLICY ncr_containment_insert ON public.ncr_containment_actions;
CREATE POLICY ncr_containment_insert ON public.ncr_containment_actions FOR INSERT TO authenticated
  WITH CHECK (app.has_permission(organisation_id, 'ncr.update', app.ncr_site(nonconformance_id))
           OR (app.has_permission(organisation_id, 'ncr.contribute', app.ncr_site(nonconformance_id)) AND app.ncr_created_by_me(nonconformance_id)));
DROP POLICY ncr_containment_update ON public.ncr_containment_actions;
CREATE POLICY ncr_containment_update ON public.ncr_containment_actions FOR UPDATE TO authenticated
  USING (app.has_permission(organisation_id, 'ncr.update', app.ncr_site(nonconformance_id))
      OR (app.has_permission(organisation_id, 'ncr.contribute', app.ncr_site(nonconformance_id)) AND app.ncr_created_by_me(nonconformance_id)))
  WITH CHECK (app.has_permission(organisation_id, 'ncr.update', app.ncr_site(nonconformance_id))
      OR (app.has_permission(organisation_id, 'ncr.contribute', app.ncr_site(nonconformance_id)) AND app.ncr_created_by_me(nonconformance_id)));

-- The files themselves (storage policies call app.ncr_file_allowed with 'ncr.update' for a write).
SELECT pg_temp.patch('app.ncr_file_allowed(text, text)'::regprocedure,
  'app.has_permission(n.organisation_id, p_permission, n.site_id))',
  '(app.has_permission(n.organisation_id, p_permission, n.site_id) OR (p_permission = ''ncr.update'' AND n.created_by = (SELECT auth.uid()) AND app.has_permission(n.organisation_id, ''ncr.contribute'', n.site_id))))',
  'ncr.contribute');

-- ---------------------------------------------------------------------------
-- 6. Inspections: acknowledging a failed reading is a quality decision
-- ---------------------------------------------------------------------------
DROP POLICY inspection_failure_acknowledgements_insert ON public.inspection_failure_acknowledgements;
CREATE POLICY inspection_failure_acknowledgements_insert ON public.inspection_failure_acknowledgements FOR INSERT TO authenticated
  WITH CHECK (app.has_permission(organisation_id, 'inspection.acknowledge_failure', app.inspection_site(inspection_record_id)));

