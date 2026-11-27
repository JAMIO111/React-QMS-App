-- Seat permissions: the split of ncr.contribute, receiving.record, shipping.record and inspection.acknowledge_failure from their bundles, and the three
-- permissions moved to the full level (migration 20260465100000). Checks the package levels, who holds what, and what each person can now do.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('4c000000-0000-0000-0000-000000000a01', 'owner@sp.test'), ('4c000000-0000-0000-0000-000000000a02', 'oscar@sp.test'),
  ('4c000000-0000-0000-0000-000000000a03', 'ivy@sp.test'),   ('4c000000-0000-0000-0000-000000000a04', 'viv@sp.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

-- Does the built-in role of this key (the template every organisation copies) hold the permission?
CREATE FUNCTION pg_temp.role_holds(p_key text, p_perm text) RETURNS boolean LANGUAGE sql AS $$
  SELECT EXISTS (SELECT 1 FROM public.roles r JOIN public.role_permissions rp ON rp.role_id = r.id
                  WHERE r.organisation_id IS NULL AND r.is_system AND r.key = p_key AND rp.permission_code = p_perm)
$$;

DO $$
DECLARE
  own uuid := '4c000000-0000-0000-0000-000000000a01'; oscar uuid := '4c000000-0000-0000-0000-000000000a02';
  ivy uuid := '4c000000-0000-0000-0000-000000000a03'; viv uuid := '4c000000-0000-0000-0000-000000000a04';
  org uuid; m uuid; k text; rid uuid; sup uuid; cust uuid; part uuid; po uuid; l1 uuid; r jsonb; nc_ivy uuid; nc_own uuid; cx uuid; rl uuid;
BEGIN
  -- ---- 1. the packages ----
  PERFORM pg_temp.assert_eq((SELECT min_access_level FROM public.features WHERE permission_code = 'ncr.contribute'), 'operational', 'ncr.contribute is operational');
  PERFORM pg_temp.assert_eq((SELECT min_access_level FROM public.features WHERE permission_code = 'receiving.record'), 'operational', 'receiving.record is operational');
  PERFORM pg_temp.assert_eq((SELECT min_access_level FROM public.features WHERE permission_code = 'shipping.record'), 'operational', 'shipping.record is operational');
  PERFORM pg_temp.assert_eq((SELECT min_access_level FROM public.features WHERE permission_code = 'inspection.acknowledge_failure'), 'full', 'acknowledging a failure is full');
  PERFORM pg_temp.assert_eq((SELECT min_access_level FROM public.features WHERE permission_code = 'receiving.manage'), 'full', 'receiving.manage moved to full');
  PERFORM pg_temp.assert_eq((SELECT min_access_level FROM public.features WHERE permission_code = 'shipping.manage'), 'full', 'shipping.manage moved to full');
  PERFORM pg_temp.assert_eq((SELECT min_access_level FROM public.features WHERE permission_code = 'change.approve'), 'full', 'change.approve moved to full');
  PERFORM pg_temp.assert_eq((SELECT min_access_level FROM public.features WHERE permission_code = 'integrations.run'), 'full', 'integrations.run moved to full');
  PERFORM pg_temp.assert_eq((SELECT min_access_level FROM public.features WHERE permission_code = 'audit.read'), 'full', 'the audit trail moved to full');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.features WHERE permission_code IN ('ncr.contribute', 'receiving.record', 'shipping.record', 'inspection.acknowledge_failure')), 4::bigint, 'the new permissions are each priced once');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.features f JOIN public.modules mo ON mo.id = f.module_id WHERE mo.slug = 'supplier_quality' AND f.slug IN ('record_receiving', 'manage_receiving')), 2::bigint, 'receiving has a record feature and a manage feature');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.features f JOIN public.modules mo ON mo.id = f.module_id WHERE mo.slug = 'shipping' AND f.slug IN ('record_shipping', 'manage_shipping')), 2::bigint, 'shipping has a record feature and a manage feature');

  -- ---- 2. who holds what in the built-in roles ----
  PERFORM pg_temp.assert_eq(pg_temp.role_holds('inspector', 'ncr.contribute'), true, 'an inspector can contribute to their NCs');
  PERFORM pg_temp.assert_eq(pg_temp.role_holds('inspector', 'receiving.record'), true, 'an inspector records deliveries');
  PERFORM pg_temp.assert_eq(pg_temp.role_holds('inspector', 'shipping.record'), true, 'an inspector records shipments');
  PERFORM pg_temp.assert_eq(pg_temp.role_holds('inspector', 'receiving.manage'), false, 'but no longer manages purchase orders');
  PERFORM pg_temp.assert_eq(pg_temp.role_holds('inspector', 'shipping.manage'), false, 'or customer orders');
  PERFORM pg_temp.assert_eq(pg_temp.role_holds('inspector', 'inspection.acknowledge_failure'), false, 'and cannot acknowledge a failure');
  PERFORM pg_temp.assert_eq(pg_temp.role_holds('viewer', 'ncr.contribute') OR pg_temp.role_holds('viewer', 'receiving.record') OR pg_temp.role_holds('viewer', 'shipping.record'), false, 'a viewer gets none of the new ones');
  FOREACH k IN ARRAY ARRAY['owner', 'admin', 'quality_manager', 'quality_engineer'] LOOP
    PERFORM pg_temp.assert_eq(pg_temp.role_holds(k, 'receiving.manage') AND pg_temp.role_holds(k, 'receiving.record') AND pg_temp.role_holds(k, 'shipping.manage') AND pg_temp.role_holds(k, 'shipping.record'), true, k || ' keeps manage and gains record');
    PERFORM pg_temp.assert_eq(pg_temp.role_holds(k, 'ncr.contribute') AND pg_temp.role_holds(k, 'inspection.acknowledge_failure'), true, k || ' can contribute and acknowledge failures');
  END LOOP;
  -- a new organisation copies the templates, so its inspector is the new inspector
  PERFORM pg_temp.login(own); org := app.create_organisation('SP Works'); PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.roles r JOIN public.role_permissions rp ON rp.role_id = r.id WHERE r.organisation_id = org AND r.key = 'inspector' AND rp.permission_code IN ('receiving.manage', 'shipping.manage', 'inspection.acknowledge_failure')), 0::bigint, 'a new organisation''s inspector is the new one');

  -- ---- 3. a custom role keeps what it chose and is given the new part ----
  INSERT INTO public.roles (organisation_id, key, name, is_system) VALUES (org, 'custom_goods_in', 'Goods in', false) RETURNING id INTO rid;
  INSERT INTO public.role_permissions (role_id, permission_code) VALUES (rid, 'receiving.manage'), (rid, 'receiving.read');
  -- (the migration ran before this role existed; the role below stands for one that held the permission then)
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.role_permissions WHERE role_id = rid AND permission_code = 'receiving.record'), 0::bigint, 'a role made after the migration is not changed behind its owner''s back');

  -- ---- 4. people ----
  FOREACH m IN ARRAY ARRAY[oscar, ivy, viv] LOOP
    INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, m, 'active');
    SELECT id INTO rid FROM public.roles WHERE organisation_id = org AND key = CASE m WHEN oscar THEN 'quality_engineer' WHEN ivy THEN 'inspector' ELSE 'viewer' END;
    INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, ou.id, rid FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id = m;
  END LOOP;
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'SUP', 'Supply Co') RETURNING id INTO sup;
  INSERT INTO public.customers (organisation_id, code, name) VALUES (org, 'ACME', 'Acme') RETURNING id INTO cust;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'BRK-1', 'Bracket') RETURNING id INTO part;

  -- ---- 5. receiving: the inspector records, the engineer manages ----
  PERFORM pg_temp.login(oscar);
  po := app.create_purchase_order(sup, 'PO-1', current_date - 5, NULL, format($f$[{"partId":"%s","quantity":100,"requestedOn":"%s"}]$f$, part, current_date - 1)::jsonb);
  SELECT id INTO l1 FROM public.purchase_order_lines WHERE purchase_order_id = po;
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login(ivy);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_purchase_order(%L, 'PO-2', current_date, NULL, '[{"partId":"%s","quantity":1,"requestedOn":"2030-01-01"}]'::jsonb)$f$, sup, part)), 5), '42501', 'an inspector cannot create a purchase order');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.set_po_line_agreed_date(%L, current_date + 30)$f$, l1)), 5), '42501', 'or move the agreed date that scores the supplier');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.close_purchase_order(%L)$f$, po)), 5), '42501', 'or close an order');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.cancel_purchase_order(%L, 'because')$f$, po)), 5), '42501', 'or cancel one');
  r := app.record_goods_receipt(sup, po, NULL, current_date, 'DN-1', NULL, format($f$[{"poLineId":"%s","quantity":40}]$f$, l1)::jsonb, 'gr-sp-0001');
  PERFORM pg_temp.assert_eq((r ->> 'created')::boolean, true, 'but an inspector records a delivery');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.cancel_goods_receipt(%L, 'oops')$f$, (r ->> 'id')::uuid)), 5), '42501', 'and cannot cancel it');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(viv);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_goods_receipt(%L, NULL, NULL, current_date, 'DN-2', NULL, '[{"partId":"%s","quantity":1}]'::jsonb, 'gr-sp-0002')$f$, sup, part)), 5), '42501', 'a viewer cannot record a delivery');
  PERFORM pg_temp.logout();

  -- ---- 6. shipping: the inspector records, the engineer manages ----
  PERFORM pg_temp.login(oscar);
  PERFORM app.create_customer_order(cust, 'CO-1', NULL, current_date - 5, NULL, format($f$[{"partId":"%s","quantity":50,"requestedOn":"%s"}]$f$, part, current_date + 5)::jsonb);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ivy);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_customer_order(%L, 'CO-2', NULL, current_date, NULL, '[{"partId":"%s","quantity":1,"requestedOn":"2030-01-01"}]'::jsonb)$f$, cust, part)), 5), '42501', 'an inspector cannot create a customer order');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.set_order_line_agreed_date((SELECT id FROM public.customer_order_lines LIMIT 1), current_date + 30)$f$)), 5), '42501', 'or move the date that scores on-time delivery');
  r := app.record_shipment(cust, (SELECT id FROM public.customer_orders WHERE order_number = 'CO-1'), NULL, current_date, 'DN-S1', NULL,
        format($f$[{"orderLineId":"%s","quantity":20}]$f$, (SELECT id FROM public.customer_order_lines LIMIT 1))::jsonb, 'sh-sp-0001');
  PERFORM pg_temp.assert_eq((r ->> 'created')::boolean, true, 'but an inspector records a shipment');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.cancel_shipment(%L, 'oops')$f$, (r ->> 'id')::uuid)), 5), '42501', 'and cannot cancel it');
  PERFORM pg_temp.logout();

  -- ---- 7. non-conformances: contribute only to your own ----
  PERFORM pg_temp.login(ivy);
  INSERT INTO public.nonconformances (organisation_id, source, title, severity, quantity_affected, description, stage, category_id)
    VALUES (org, 'internal', 'Ivy raised this', 'minor', 5, 'x', 'open', pg_temp.cat(org)) RETURNING id INTO nc_ivy;
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(oscar);
  INSERT INTO public.nonconformances (organisation_id, source, title, severity, quantity_affected, description, stage, category_id)
    VALUES (org, 'internal', 'Oscar raised this', 'minor', 5, 'x', 'open', pg_temp.cat(org)) RETURNING id INTO nc_own;
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login(ivy);
  PERFORM pg_temp.assert_ok(format($q$INSERT INTO public.ncr_attachments (organisation_id, nonconformance_id, storage_path, file_name, size_bytes) VALUES (%L, %L, %L, 'photo.jpg', 100)$q$, org, nc_ivy, org || '/ncr/' || nc_ivy || '/a-photo.jpg'), 'an operator attaches a photo to their own NC');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.ncr_attachments (organisation_id, nonconformance_id, storage_path, file_name, size_bytes) VALUES (%L, %L, %L, 'photo.jpg', 100)$q$, org, nc_own, org || '/ncr/' || nc_own || '/a-photo.jpg'), 'but not to one a colleague raised');
  PERFORM pg_temp.assert_eq(app.storage_file_allowed('nc-files', org || '/ncr/' || nc_ivy || '/b-photo.jpg', true), true, 'the file itself may be stored for their own NC');
  PERFORM pg_temp.assert_eq(app.storage_file_allowed('nc-files', org || '/ncr/' || nc_own || '/b-photo.jpg', true), false, 'not for a colleague''s');
  PERFORM pg_temp.assert_ok(format($q$INSERT INTO public.ncr_containment_actions (organisation_id, nonconformance_id, kind, description) VALUES (%L, %L, 'quarantine', 'Moved to the red cage')$q$, org, nc_ivy), 'and records containment on their own NC');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.ncr_containment_actions (organisation_id, nonconformance_id, kind, description) VALUES (%L, %L, 'quarantine', 'x')$q$, org, nc_own), 'but not on a colleague''s');
  SELECT id INTO cx FROM public.ncr_containment_actions WHERE nonconformance_id = nc_ivy;
  PERFORM pg_temp.assert_eq(pg_temp.affected(format($q$UPDATE public.ncr_containment_actions SET status = 'done', done_note = 'Counted 5' WHERE id = %L$q$, cx)), 1::bigint, 'they can finish what they recorded');
  -- ncr.contribute is not ncr.update: the NC itself, its costs and its stage stay with whoever may update
  PERFORM pg_temp.assert_eq(pg_temp.affected(format($q$UPDATE public.nonconformances SET title = 'Changed' WHERE id = %L$q$, nc_ivy)), 0::bigint, 'the NC itself is not editable by contribute');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.ncr_costs (organisation_id, nonconformance_id, category, quantity, unit_cost, incurred_on) VALUES (%L, %L, 'scrap', 1, 1, current_date)$q$, org, nc_ivy), 'nor its costs');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login(viv);
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.ncr_attachments (organisation_id, nonconformance_id, storage_path, file_name, size_bytes) VALUES (%L, %L, %L, 'p.jpg', 1)$q$, org, nc_own, org || '/ncr/' || nc_own || '/v.jpg'), 'a viewer attaches nothing');
  PERFORM pg_temp.logout();

  -- ---- 8. the policies themselves ----
  PERFORM pg_temp.assert_eq((SELECT with_check FROM pg_policies WHERE tablename = 'inspection_failure_acknowledgements' AND policyname = 'inspection_failure_acknowledgements_insert') LIKE '%inspection.acknowledge_failure%', true, 'acknowledging asks for its own permission');
  PERFORM pg_temp.assert_eq((SELECT with_check FROM pg_policies WHERE tablename = 'inspection_failure_acknowledgements' AND policyname = 'inspection_failure_acknowledgements_insert') LIKE '%inspection.record%', false, 'and no longer for inspection.record');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM pg_policies WHERE tablename IN ('ncr_attachments', 'ncr_containment_actions') AND cmd IN ('INSERT', 'UPDATE') AND coalesce(qual, with_check) LIKE '%ncr.contribute%' AND coalesce(qual, with_check) LIKE '%ncr_created_by_me%'), 4::bigint, 'the four NC child-record policies check ncr.contribute and ownership');
END $$;

ROLLBACK;
