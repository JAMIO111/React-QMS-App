-- Manufacturing traceability (TR1): production orders, operations, lots and serial numbers, and the links from jobs (inspections) and non-conformances.
-- Covers permissions, lifecycles, part/lot/order consistency, the typed text being filled from the picked record, freezing, audit and tenant isolation.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('37000000-0000-0000-0000-000000000201', 'owner@prod.test'), ('37000000-0000-0000-0000-000000000202', 'viewer@prod.test'),
  ('37000000-0000-0000-0000-000000000203', 'other@prod.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  u_owner uuid := '37000000-0000-0000-0000-000000000201'; u_view uuid := '37000000-0000-0000-0000-000000000202'; u_other uuid := '37000000-0000-0000-0000-000000000203';
  org uuid; org2 uuid; site uuid; site2 uuid; machine uuid; machine2 uuid; part uuid; part2 uuid; rev uuid; rev2 uuid; supplier uuid; customer uuid;
  plan uuid; prev uuid; op uuid; viewer_role uuid; m uuid;
  wo uuid; wo2 uuid; op10 uuid; op20 uuid; lot1 uuid; lot2 uuid; lot_recv uuid; lot_other_part uuid; sn1 uuid; sn2 uuid; foreign_lot uuid;
  job uuid; ncr uuid; r text;
BEGIN
  PERFORM pg_temp.login(u_owner);
  org := app.create_organisation('Trace Works', 'Plant A', 'PA', NULL);
  SELECT id INTO site FROM public.sites WHERE organisation_id = org;
  INSERT INTO public.sites (organisation_id, code, name) VALUES (org, 'PB', 'Plant B') RETURNING id INTO site2;
  INSERT INTO public.machines (organisation_id, code, name, site_id) VALUES (org, 'LATHE-1', 'Lathe', site) RETURNING id INTO machine;
  INSERT INTO public.machines (organisation_id, code, name, site_id) VALUES (org, 'MILL-B', 'Mill at B', site2) RETURNING id INTO machine2;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'TR-100', 'Trace part') RETURNING id INTO part;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'TR-200', 'Other part') RETURNING id INTO part2;
  INSERT INTO public.part_revisions (organisation_id, part_id, revision) VALUES (org, part, 'A') RETURNING id INTO rev;
  INSERT INTO public.part_revisions (organisation_id, part_id, revision) VALUES (org, part2, 'A') RETURNING id INTO rev2;
  UPDATE public.part_revisions SET status = 'released' WHERE part_id = part;
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'SUP1', 'Steel Co') RETURNING id INTO supplier;
  INSERT INTO public.customers (organisation_id, code, name) VALUES (org, 'CUS1', 'Customer') RETURNING id INTO customer;

  -- Permissions: owner has both; the seeded roles carry them.
  PERFORM pg_temp.assert_eq((SELECT count(DISTINCT r.key) FROM public.role_permissions rp JOIN public.roles r ON r.id = rp.role_id WHERE rp.permission_code = 'production.manage' AND r.organisation_id = org), 4::bigint, 'four roles manage production');
  PERFORM pg_temp.assert_eq((SELECT count(DISTINCT r.key) FROM public.role_permissions rp JOIN public.roles r ON r.id = rp.role_id WHERE rp.permission_code = 'production.read' AND r.organisation_id = org), 6::bigint, 'six roles read production');

  -- ------------------------------------------------------------------ Orders
  INSERT INTO public.production_orders (organisation_id, order_number, part_id, part_revision_id, customer_id, site_id, quantity_planned, status, external_system, external_id)
    VALUES (org, 'WO-1001', part, rev, customer, site, 500, 'in_progress', 'erp', 'X1') RETURNING id INTO wo;
  PERFORM pg_temp.assert_eq((SELECT status FROM public.production_orders WHERE id = wo), 'planned', 'a new order is always planned');
  PERFORM pg_temp.assert_eq((SELECT external_id IS NULL FROM public.production_orders WHERE id = wo), true, 'people cannot set the import columns');
  r := pg_temp.fails(format('INSERT INTO public.production_orders (organisation_id, order_number, part_id, quantity_planned) VALUES (%L, ''wo-1001'', %L, 5)', org, part));
  PERFORM pg_temp.assert_eq(r LIKE '23505:%', true, 'an order number is unique per organisation, any case');
  r := pg_temp.fails(format('INSERT INTO public.production_orders (organisation_id, order_number, part_id, part_revision_id, quantity_planned) VALUES (%L, ''WO-BAD'', %L, %L, 5)', org, part, rev2));
  PERFORM pg_temp.assert_eq(r LIKE 'QM017:%revision%', true, 'the revision must belong to the part');
  r := pg_temp.fails(format('INSERT INTO public.production_orders (organisation_id, order_number, part_id, quantity_planned) VALUES (%L, ''WO-0'', %L, 0)', org, part));
  PERFORM pg_temp.assert_eq(r LIKE '23514:%', true, 'the planned quantity must be above zero');
  r := pg_temp.fails(format('UPDATE public.production_orders SET part_id = %L WHERE id = %L', part2, wo));
  PERFORM pg_temp.assert_eq(r LIKE '42501:%', true, 'the part of an order cannot change');
  r := pg_temp.fails(format('UPDATE public.production_orders SET order_number = ''WO-9'' WHERE id = %L', wo));
  PERFORM pg_temp.assert_eq(r LIKE '42501:%', true, 'the order number cannot change');

  -- Operations.
  INSERT INTO public.production_operations (organisation_id, production_order_id, sequence, operation_code, description, machine_id) VALUES (org, wo, 10, 'OP-10', 'Turning', machine) RETURNING id INTO op10;
  INSERT INTO public.production_operations (organisation_id, production_order_id, sequence, operation_code) VALUES (org, wo, 20, 'OP-20') RETURNING id INTO op20;
  PERFORM pg_temp.assert_eq((SELECT site_id FROM public.production_operations WHERE id = op10), site, 'an operation takes its order''s site');
  r := pg_temp.fails(format('INSERT INTO public.production_operations (organisation_id, production_order_id, sequence, operation_code) VALUES (%L, %L, 10, ''OP-X'')', org, wo));
  PERFORM pg_temp.assert_eq(r LIKE '23505:%', true, 'a sequence is used once per order');
  r := pg_temp.fails(format('INSERT INTO public.production_operations (organisation_id, production_order_id, sequence, operation_code, machine_id) VALUES (%L, %L, 30, ''OP-30'', %L)', org, wo, machine2));
  PERFORM pg_temp.assert_eq(r LIKE 'QM017:%another site%', true, 'the machine must be at the order''s site');

  -- Order lifecycle.
  r := pg_temp.fails(format('UPDATE public.production_orders SET status = ''completed'' WHERE id = %L', wo));
  PERFORM pg_temp.assert_eq(r LIKE 'QM017:%cannot become%', true, 'a planned order cannot jump to completed');
  UPDATE public.production_orders SET status = 'released' WHERE id = wo;
  UPDATE public.production_orders SET status = 'in_progress' WHERE id = wo;
  r := pg_temp.fails(format('UPDATE public.production_orders SET status = ''completed'' WHERE id = %L', wo));
  PERFORM pg_temp.assert_eq(r LIKE 'QM017:%OP-10, OP-20%', true, 'an order cannot complete while operations are open');
  UPDATE public.production_operations SET status = 'completed' WHERE id = op10;
  UPDATE public.production_operations SET status = 'skipped' WHERE id = op20;
  UPDATE public.production_orders SET status = 'completed' WHERE id = wo;
  r := pg_temp.fails(format('UPDATE public.production_operations SET status = ''pending'' WHERE id = %L', op10));
  PERFORM pg_temp.assert_eq(r LIKE 'QM017:%operations can no longer be changed%', true, 'operations of a completed order are frozen');
  UPDATE public.production_orders SET status = 'closed' WHERE id = wo;
  r := pg_temp.fails(format('UPDATE public.production_orders SET notes = ''late'' WHERE id = %L', wo));
  PERFORM pg_temp.assert_eq(r LIKE 'QM017:%closed%', true, 'a closed order is frozen');
  r := pg_temp.fails(format('UPDATE public.production_orders SET status = ''in_progress'' WHERE id = %L', wo));
  PERFORM pg_temp.assert_eq(r LIKE 'QM017:%closed%', true, 'a closed order cannot be reopened');

  INSERT INTO public.production_orders (organisation_id, order_number, part_id, site_id, quantity_planned) VALUES (org, 'WO-1002', part, site, 50) RETURNING id INTO wo2;
  r := pg_temp.fails(format('UPDATE public.production_orders SET status = ''cancelled'' WHERE id = %L', wo2));
  PERFORM pg_temp.assert_eq(r LIKE '%reason%', true, 'cancelling needs a reason');
  UPDATE public.production_orders SET status = 'cancelled', status_reason = 'Customer withdrew' WHERE id = wo2;
  r := pg_temp.fails(format('INSERT INTO public.lots (organisation_id, lot_number, part_id, origin, production_order_id) VALUES (%L, ''L-X'', %L, ''produced'', %L)', org, part, wo2));
  PERFORM pg_temp.assert_eq(r LIKE 'QM017:%cancelled%', true, 'no lot can be made for a cancelled order');

  -- Reopen a working order for the rest of the test.
  INSERT INTO public.production_orders (organisation_id, order_number, part_id, site_id, quantity_planned) VALUES (org, 'WO-1003', part, site, 100) RETURNING id INTO wo2;
  UPDATE public.production_orders SET status = 'released' WHERE id = wo2;

  -- ------------------------------------------------------------------ Lots
  INSERT INTO public.lots (organisation_id, lot_number, part_id, origin, production_order_id, quantity, status)
    VALUES (org, 'LOT-1', part, 'produced', wo2, 100, 'released') RETURNING id INTO lot1;
  PERFORM pg_temp.assert_eq((SELECT status || '/' || site_id::text FROM public.lots WHERE id = lot1), 'open/' || site::text, 'a new lot is open and takes the order''s site');
  INSERT INTO public.lots (organisation_id, lot_number, part_id, origin, production_order_id) VALUES (org, 'LOT-2', part, 'produced', wo2) RETURNING id INTO lot2;
  INSERT INTO public.lots (organisation_id, lot_number, part_id, origin, supplier_id, received_on, quantity) VALUES (org, 'HEAT-77', part, 'received', supplier, current_date, 1000) RETURNING id INTO lot_recv;
  INSERT INTO public.lots (organisation_id, lot_number, part_id, origin) VALUES (org, 'LOT-1', part2, 'produced') RETURNING id INTO lot_other_part;
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.lots WHERE upper(lot_number) = 'LOT-1'), 2::bigint, 'the same lot number may exist for another part');
  r := pg_temp.fails(format('INSERT INTO public.lots (organisation_id, lot_number, part_id, origin) VALUES (%L, ''lot-1'', %L, ''produced'')', org, part));
  PERFORM pg_temp.assert_eq(r LIKE '23505:%', true, 'a lot number is unique per part, any case');
  r := pg_temp.fails(format('INSERT INTO public.lots (organisation_id, lot_number, part_id, origin, production_order_id) VALUES (%L, ''LOT-9'', %L, ''produced'', %L)', org, part2, wo2));
  PERFORM pg_temp.assert_eq(r LIKE 'QM017:%another part%', true, 'a produced lot''s order must be for the same part');
  r := pg_temp.fails(format('INSERT INTO public.lots (organisation_id, lot_number, part_id, origin, production_order_id, supplier_id) VALUES (%L, ''LOT-8'', %L, ''produced'', %L, %L)', org, part, wo2, supplier));
  PERFORM pg_temp.assert_eq(r LIKE '23514:%', true, 'a produced lot has no supplier');
  r := pg_temp.fails(format('INSERT INTO public.lots (organisation_id, lot_number, part_id, origin, production_order_id) VALUES (%L, ''LOT-7'', %L, ''received'', %L)', org, part, wo2));
  PERFORM pg_temp.assert_eq(r LIKE '23514:%', true, 'a received lot has no production order');
  r := pg_temp.fails(format('UPDATE public.lots SET lot_number = ''NEW'' WHERE id = %L', lot1));
  PERFORM pg_temp.assert_eq(r LIKE '42501:%', true, 'the lot number cannot change');
  r := pg_temp.fails(format('UPDATE public.lots SET supplier_id = %L WHERE id = %L', supplier, lot1));
  PERFORM pg_temp.assert_eq(r LIKE 'QM017:%received lot%', true, 'only a received lot has a supplier');

  r := pg_temp.fails(format('UPDATE public.lots SET status = ''on_hold'' WHERE id = %L', lot1));
  PERFORM pg_temp.assert_eq(r LIKE '%why%' OR r LIKE '23514:%', true, 'a hold needs a reason');
  UPDATE public.lots SET status = 'on_hold', status_reason = 'Suspect material' WHERE id = lot1;
  PERFORM pg_temp.assert_eq((SELECT status_reason FROM public.lots WHERE id = lot1), 'Suspect material', 'the hold reason is kept');
  UPDATE public.lots SET status = 'released' WHERE id = lot1;
  PERFORM pg_temp.assert_eq((SELECT status_reason IS NULL FROM public.lots WHERE id = lot1), true, 'releasing clears the hold reason');
  UPDATE public.lots SET status = 'closed' WHERE id = lot2;
  r := pg_temp.fails(format('UPDATE public.lots SET status = ''open'' WHERE id = %L', lot2));
  PERFORM pg_temp.assert_eq(r LIKE 'QM017:%closed%', true, 'a closed lot is frozen');
  r := pg_temp.fails(format('UPDATE public.lots SET quantity = 5 WHERE id = %L', lot2));
  PERFORM pg_temp.assert_eq(r LIKE 'QM017:%closed%', true, 'a closed lot cannot be edited');
  UPDATE public.lots SET status = 'open' WHERE id = lot1 AND false;  -- no-op: released lots can still be held again
  UPDATE public.lots SET status = 'on_hold', status_reason = 'Re-check' WHERE id = lot1;
  UPDATE public.lots SET status = 'open' WHERE id = lot1;
  PERFORM pg_temp.assert_eq((SELECT status FROM public.lots WHERE id = lot1), 'open', 'a held lot can be reopened');

  -- ------------------------------------------------------------------ Serial numbers
  INSERT INTO public.serial_numbers (organisation_id, serial_number, part_id, lot_id) VALUES (org, 'SN-0001', part, lot1) RETURNING id INTO sn1;
  PERFORM pg_temp.assert_eq((SELECT production_order_id::text || '/' || site_id::text FROM public.serial_numbers WHERE id = sn1), wo2::text || '/' || site::text, 'a serial takes its lot''s order and site');
  r := pg_temp.fails(format('INSERT INTO public.serial_numbers (organisation_id, serial_number, part_id, lot_id) VALUES (%L, ''SN-X'', %L, %L)', org, part, lot_other_part));
  PERFORM pg_temp.assert_eq(r LIKE 'QM017:%another part%', true, 'a serial''s lot must be for the same part');
  r := pg_temp.fails(format('INSERT INTO public.serial_numbers (organisation_id, serial_number, part_id) VALUES (%L, ''sn-0001'', %L)', org, part));
  PERFORM pg_temp.assert_eq(r LIKE '23505:%', true, 'a serial is unique per part, any case');
  INSERT INTO public.serial_numbers (organisation_id, serial_number, part_id) VALUES (org, 'SN-0001', part2);
  r := pg_temp.fails(format('INSERT INTO public.serial_numbers (organisation_id, serial_number, part_id, lot_id, production_order_id) VALUES (%L, ''SN-0002'', %L, %L, %L)', org, part, lot1, wo));
  PERFORM pg_temp.assert_eq(r LIKE 'QM017:%another production order%', true, 'a serial''s order must be its lot''s order');
  INSERT INTO public.serial_numbers (organisation_id, serial_number, part_id, lot_id) VALUES (org, 'SN-0002', part, lot1) RETURNING id INTO sn2;
  r := pg_temp.fails(format('UPDATE public.serial_numbers SET status = ''scrapped'' WHERE id = %L', sn2));
  PERFORM pg_temp.assert_eq(r LIKE '%why%' OR r LIKE '23514:%', true, 'scrapping needs a reason');
  UPDATE public.serial_numbers SET status = 'scrapped', status_reason = 'Cracked' WHERE id = sn2;
  r := pg_temp.fails(format('UPDATE public.serial_numbers SET notes = ''x'' WHERE id = %L', sn2));
  PERFORM pg_temp.assert_eq(r LIKE 'QM017:%scrapped%', true, 'a scrapped serial is frozen');

  -- ------------------------------------------------------------------ Links from a job (inspection)
  INSERT INTO public.control_plans (organisation_id, plan_code, title) VALUES (org, 'CP-T', 'Trace plan') RETURNING id INTO plan;
  INSERT INTO public.control_plan_applicability (organisation_id, control_plan_id, part_id) VALUES (org, plan, part);
  INSERT INTO public.control_plan_revisions (organisation_id, control_plan_id, revision_code, change_reason) VALUES (org, plan, 'A', 'First') RETURNING id INTO prev;
  INSERT INTO public.control_plan_operations (organisation_id, control_plan_revision_id, operation_code, sequence, name) VALUES (org, prev, 'OP-10', 10, 'Turning') RETURNING id INTO op;
  INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, sequence, name, nominal, lower_limit, upper_limit, unit_code)
    VALUES (org, prev, op, 'OD', 10, 'Outer diameter', 25, 24.95, 25.05, 'mm');
  UPDATE public.control_plan_revisions SET status = 'pending_approval' WHERE id = prev;
  UPDATE public.control_plan_revisions SET status = 'approved' WHERE id = prev;
  UPDATE public.control_plan_revisions SET status = 'effective' WHERE id = prev;

  job := app.start_inspection(site, part, NULL, machine);
  PERFORM app.set_job_links(job, jsonb_build_object('serialId', sn1));
  PERFORM pg_temp.assert_eq((SELECT work_order || '/' || lot || '/' || serial FROM public.inspection_records WHERE id = job), 'WO-1003/LOT-1/SN-0001', 'picking a serial fills the order, lot and serial text');
  PERFORM pg_temp.assert_eq((SELECT production_order_id = wo2 AND lot_id = lot1 AND serial_id = sn1 FROM public.inspection_records WHERE id = job), true, 'and the real links');
  PERFORM app.set_job_links(job, jsonb_build_object('serialId', NULL));
  PERFORM pg_temp.assert_eq((SELECT serial_id IS NULL AND lot_id = lot1 AND serial = 'SN-0001' FROM public.inspection_records WHERE id = job), true, 'clearing a link keeps the others and the typed text');
  r := pg_temp.fails(format('SELECT app.set_job_links(%L, %L::jsonb)', job, jsonb_build_object('lotId', lot_other_part)));
  PERFORM pg_temp.assert_eq(r LIKE 'QM017:%another part%', true, 'a lot of another part cannot be linked to the job');
  r := pg_temp.fails(format('SELECT app.set_job_links(%L, %L::jsonb)', job, jsonb_build_object('productionOrderId', wo)));
  PERFORM pg_temp.assert_eq(r LIKE 'QM017:%another production order%', true, 'an order that disagrees with the lot is refused');
  PERFORM app.set_job_links(job, jsonb_build_object('lotId', NULL, 'productionOrderId', NULL));
  PERFORM pg_temp.assert_eq((SELECT production_order_id IS NULL AND lot_id IS NULL FROM public.inspection_records WHERE id = job), true, 'all links can be cleared');
  PERFORM pg_temp.assert_eq((SELECT count(*) > 0 FROM public.audit_events WHERE organisation_id = org AND entity_type = 'inspection_records' AND changed_fields @> ARRAY['lot_id']), true, 'link changes are audited');
  PERFORM app.set_job_links(job, jsonb_build_object('lotId', lot1));
  r := pg_temp.fails(format('UPDATE public.inspection_records SET production_order_id = %L WHERE id = %L', wo, job));
  PERFORM pg_temp.assert_eq(r LIKE '42501:%' OR r LIKE 'QM008:%', true, 'the links cannot be written around the function');
  PERFORM pg_temp.logout();

  -- A reader sees production records but cannot change them or a job.
  SELECT id INTO viewer_role FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  INSERT INTO public.organisation_users (organisation_id, user_id, status, joined_at) VALUES (org, u_view, 'active', now()) RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) VALUES (org, m, viewer_role);
  PERFORM pg_temp.login(u_view);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.lots), 4::bigint, 'a reader sees the lots');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.production_orders), 3::bigint, 'and the orders');
  r := pg_temp.fails(format('INSERT INTO public.lots (organisation_id, lot_number, part_id, origin) VALUES (%L, ''NOPE'', %L, ''produced'')', org, part));
  PERFORM pg_temp.assert_eq(r LIKE '42501:%', true, 'a reader cannot create a lot');
  PERFORM pg_temp.assert_eq(pg_temp.affected(format('UPDATE public.production_orders SET notes = ''x'' WHERE id = %L', wo2)), 0::bigint, 'a reader cannot change an order');
  r := pg_temp.fails(format('SELECT app.set_job_links(%L, ''{"lotId": null}''::jsonb)', job));
  PERFORM pg_temp.assert_eq(r LIKE 'P0002:%', true, 'a reader cannot link a job');
  PERFORM pg_temp.logout();

  -- An inspector who may record but has lost production.read cannot link production records.
  PERFORM pg_temp.logout();
  DELETE FROM public.role_permissions WHERE permission_code = 'production.read' AND role_id = (SELECT id FROM public.roles WHERE organisation_id = org AND key = 'inspector');
  INSERT INTO auth.users (id, email) VALUES ('37000000-0000-0000-0000-000000000204', 'insp@prod.test');
  INSERT INTO public.organisation_users (organisation_id, user_id, status, joined_at) VALUES (org, '37000000-0000-0000-0000-000000000204', 'active', now()) RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'inspector';
  PERFORM pg_temp.login('37000000-0000-0000-0000-000000000204');
  r := pg_temp.fails(format('SELECT app.set_job_links(%L, ''{"lotId": null}''::jsonb)', job));
  PERFORM pg_temp.assert_eq(r LIKE '42501:%production.read%', true, 'linking needs production.read');
  PERFORM pg_temp.logout();

  -- ------------------------------------------------------------------ Links from a non-conformance
  PERFORM pg_temp.login(u_owner);
  INSERT INTO public.nonconformances (organisation_id, source, stage, title, site_id) VALUES (org, 'internal', 'draft', 'Trace NC', site) RETURNING id INTO ncr;
  UPDATE public.nonconformances SET lot_id = lot1 WHERE id = ncr;
  PERFORM pg_temp.assert_eq((SELECT part_id = part AND production_order_id = wo2 AND lot_number = 'LOT-1' AND work_order = 'WO-1003' FROM public.nonconformances WHERE id = ncr), true,
    'picking a lot fills the part, the order and the typed text on an NC');
  r := pg_temp.fails(format('UPDATE public.nonconformances SET lot_id = %L WHERE id = %L', lot_other_part, ncr));
  PERFORM pg_temp.assert_eq(r LIKE 'QM017:%another part%', true, 'a lot of another part cannot be linked to an NC');
  UPDATE public.nonconformances SET serial_id = sn1 WHERE id = ncr;
  PERFORM pg_temp.assert_eq((SELECT serial_number FROM public.nonconformances WHERE id = ncr), 'SN-0001', 'and the serial text');
  r := pg_temp.fails(format('UPDATE public.nonconformances SET lot_id = %L WHERE id = %L', lot2, ncr));
  PERFORM pg_temp.assert_eq(r LIKE 'QM017:%another lot%', true, 'a lot that disagrees with the serial is refused');
  UPDATE public.nonconformances SET deleted_at = now(), delete_reason = 'Test' WHERE id = ncr;
  r := pg_temp.fails(format('UPDATE public.nonconformances SET lot_id = NULL WHERE id = %L', ncr));
  PERFORM pg_temp.assert_eq(r LIKE 'QM005:%deleted%', true, 'the links of a deleted NC are frozen with the rest');
  UPDATE public.nonconformances SET deleted_at = NULL WHERE id = ncr;
  PERFORM pg_temp.logout();

  -- ------------------------------------------------------------------ Tenant isolation
  PERFORM pg_temp.login(u_other);
  org2 := app.create_organisation('Other Works', 'Plant X', 'PX', NULL);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.lots), 0::bigint, 'another organisation sees none of the lots');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.production_orders) + (SELECT count(*) FROM public.serial_numbers) + (SELECT count(*) FROM public.production_operations), 0::bigint, 'nor orders, serials or operations');
  r := pg_temp.fails(format('INSERT INTO public.lots (organisation_id, lot_number, part_id, origin) VALUES (%L, ''X'', %L, ''produced'')', org2, part));
  PERFORM pg_temp.assert_eq(r IS DISTINCT FROM 'ok', true, 'a lot cannot be made for another organisation''s part');
  PERFORM pg_temp.logout();
  -- Even a privileged write cannot link a record to another organisation's lot (composite key).
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org2, 'X-1', 'X') RETURNING id INTO part2;
  INSERT INTO public.lots (organisation_id, lot_number, part_id, origin) VALUES (org2, 'FOREIGN', part2, 'produced') RETURNING id INTO foreign_lot;
  r := pg_temp.fails(format('UPDATE public.nonconformances SET lot_id = %L, stage = ''draft'' WHERE title = ''Trace NC''', foreign_lot));
  PERFORM pg_temp.assert_eq(r LIKE 'QM017:%not found%', true, 'a lot of another organisation is not found');
  -- Audit and anonymous access.
  PERFORM pg_temp.assert_eq((SELECT count(*) > 0 FROM public.audit_events WHERE organisation_id = org AND entity_type = 'lots' AND action = 'update'), true, 'lot changes are audited');
  PERFORM pg_temp.login_anon();
  r := pg_temp.fails(format('SELECT app.set_job_links(%L, ''{}''::jsonb)', job));
  PERFORM pg_temp.assert_eq(r LIKE '42501:%', true, 'anonymous callers cannot link jobs');
  PERFORM pg_temp.logout();
END $$;
ROLLBACK;
