-- Production links, TR3a: the organisation settings, orders made from the job's order picker, "a production order is required" at completion, and the backfill of free text typed on existing records.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('38000000-0000-0000-0000-000000000201', 'owner@links.test'), ('38000000-0000-0000-0000-000000000202', 'inspector@links.test'),
  ('38000000-0000-0000-0000-000000000203', 'viewer@links.test'), ('38000000-0000-0000-0000-000000000204', 'other@links.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  u_owner uuid := '38000000-0000-0000-0000-000000000201'; u_insp uuid := '38000000-0000-0000-0000-000000000202';
  u_view uuid := '38000000-0000-0000-0000-000000000203'; u_other uuid := '38000000-0000-0000-0000-000000000204';
  org uuid; org2 uuid; site uuid; machine uuid; p1 uuid; p2 uuid; part_other uuid; supplier uuid; plan uuid; prev uuid; op uuid;
  i1 uuid; i2 uuid; i3 uuid; i4 uuid; i5 uuid; i6 uuid; ncr6 uuid; ncr1 uuid; ncr2 uuid; ncr3 uuid; ncr4 uuid; ncr5 uuid; wo300 uuid; order_id uuid; rep jsonb; r text; before_orders int;
BEGIN
  PERFORM pg_temp.login(u_owner);
  org := app.create_organisation('Links Works', 'Plant A', 'PA', NULL);
  SELECT id INTO site FROM public.sites WHERE organisation_id = org;
  INSERT INTO public.machines (organisation_id, code, name, site_id) VALUES (org, 'LATHE-1', 'Lathe', site) RETURNING id INTO machine;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'LK-100', 'Links part') RETURNING id INTO p1;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'LK-200', 'Second part') RETURNING id INTO p2;
  INSERT INTO public.part_revisions (organisation_id, part_id, revision) VALUES (org, p1, 'A'), (org, p2, 'A');
  UPDATE public.part_revisions SET status = 'released' WHERE organisation_id = org;
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'SUP', 'Steel Co') RETURNING id INTO supplier;
  INSERT INTO public.control_plans (organisation_id, plan_code, title) VALUES (org, 'CP-L', 'Links plan') RETURNING id INTO plan;
  INSERT INTO public.control_plan_applicability (organisation_id, control_plan_id, part_id) VALUES (org, plan, p1), (org, plan, p2);
  INSERT INTO public.control_plan_revisions (organisation_id, control_plan_id, revision_code, change_reason) VALUES (org, plan, 'A', 'First') RETURNING id INTO prev;
  INSERT INTO public.control_plan_operations (organisation_id, control_plan_revision_id, operation_code, sequence, name) VALUES (org, prev, 'OP-10', 10, 'Turning') RETURNING id INTO op;
  INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, sequence, name, nominal, lower_limit, upper_limit, unit_code)
    VALUES (org, prev, op, 'OD', 10, 'Outer diameter', 25, 24.95, 25.05, 'mm');
  UPDATE public.control_plan_revisions SET status = 'pending_approval' WHERE id = prev;
  UPDATE public.control_plan_revisions SET status = 'approved' WHERE id = prev;
  UPDATE public.control_plan_revisions SET status = 'effective' WHERE id = prev;
  PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status, joined_at) VALUES (org, u_insp, 'active', now()), (org, u_view, 'active', now());
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, r.id FROM public.organisation_users ou JOIN public.roles r ON r.organisation_id = org AND r.key = CASE ou.user_id WHEN u_insp THEN 'inspector' ELSE 'viewer' END
     WHERE ou.organisation_id = org AND ou.user_id IN (u_insp, u_view);
  PERFORM pg_temp.login(u_owner);

  -- ------------------------------------------------------------------ Settings
  PERFORM pg_temp.assert_eq((SELECT use_lots_and_serials AND NOT allow_inline_orders AND NOT require_production_order FROM public.organisation_settings WHERE organisation_id = org), true, 'defaults change nothing');
  UPDATE public.organisation_settings SET use_lots_and_serials = false WHERE organisation_id = org;
  PERFORM pg_temp.assert_eq((SELECT use_lots_and_serials FROM public.organisation_settings WHERE organisation_id = org), false, 'the owner can switch lots and serials off');
  UPDATE public.organisation_settings SET use_lots_and_serials = true WHERE organisation_id = org;
  PERFORM pg_temp.assert_eq((SELECT count(*) > 0 FROM public.audit_events WHERE organisation_id = org AND entity_type = 'organisation_settings' AND changed_fields @> ARRAY['use_lots_and_serials']), true, 'setting changes are audited');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_view);
  PERFORM pg_temp.assert_eq(pg_temp.affected(format('UPDATE public.organisation_settings SET allow_inline_orders = true WHERE organisation_id = %L', org)), 0::bigint, 'a viewer cannot change the settings');
  PERFORM pg_temp.logout();

  -- ------------------------------------------------------------------ Orders made from the job's picker
  PERFORM pg_temp.login(u_owner);
  order_id := app.create_order_inline(' WO-INLINE-1 ', p1, 24, site);
  PERFORM pg_temp.assert_eq((SELECT order_number || '/' || status || '/' || quantity_planned::int FROM public.production_orders WHERE id = order_id), 'WO-INLINE-1/planned/24', 'the owner makes an order (trimmed, planned)');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_insp);
  r := pg_temp.fails(format('SELECT app.create_order_inline(''WO-OP-1'', %L, 5, %L)', p1, site));
  PERFORM pg_temp.assert_eq(r LIKE '42501:%production.manage%', true, 'an inspector cannot make an order while the setting is off');
  PERFORM pg_temp.logout();
  UPDATE public.organisation_settings SET allow_inline_orders = true WHERE organisation_id = org;
  PERFORM pg_temp.login(u_insp);
  order_id := app.create_order_inline('WO-OP-1', p1, 5, site);
  PERFORM pg_temp.assert_eq((SELECT created_by FROM public.production_orders WHERE id = order_id), u_insp, 'with the setting on the inspector can, and is recorded as the creator');
  r := pg_temp.fails(format('SELECT app.create_order_inline(''WO-OP-1'', %L, 5, %L)', p1, site));
  PERFORM pg_temp.assert_eq(r LIKE '23505:%', true, 'a duplicate number is refused');
  r := pg_temp.fails(format('INSERT INTO public.lots (organisation_id, lot_number, part_id, origin) VALUES (%L, ''X'', %L, ''produced'')', org, p1));
  PERFORM pg_temp.assert_eq(r LIKE '42501:%', true, 'the setting does not let an inspector make lots');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_view);
  r := pg_temp.fails(format('SELECT app.create_order_inline(''WO-V'', %L, 5, %L)', p1, site));
  PERFORM pg_temp.assert_eq(r LIKE '42501:%', true, 'a viewer cannot, whatever the setting');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_other);
  org2 := app.create_organisation('Other Links', 'Plant X', 'PX', NULL);
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org2, 'X-1', 'X') RETURNING id INTO part_other;
  r := pg_temp.fails(format('SELECT app.create_order_inline(''WO-X'', %L, 5)', p1));
  PERFORM pg_temp.assert_eq(r LIKE 'P0002:%', true, 'another organisation''s part is not found');
  PERFORM pg_temp.logout();
  UPDATE public.organisation_settings SET allow_inline_orders = false WHERE organisation_id = org;

  -- ------------------------------------------------------------------ A production order required to complete a job
  PERFORM pg_temp.login(u_owner);
  i1 := app.start_inspection(site, p1, NULL, machine);
  UPDATE public.organisation_settings SET require_production_order = true WHERE organisation_id = org;
  r := pg_temp.fails(format('UPDATE public.inspection_records SET status = ''completed'' WHERE id = %L', i1));
  PERFORM pg_temp.assert_eq(r LIKE 'QM008:%production order%', true, 'a job cannot complete without an order when one is required');
  PERFORM app.set_job_links(i1, jsonb_build_object('productionOrderId', order_id));
  r := pg_temp.fails(format('UPDATE public.inspection_records SET status = ''completed'' WHERE id = %L', i1));
  PERFORM pg_temp.assert_eq(r LIKE 'QM008:%Measure every check%', true, 'with an order the job gets on to the next rule');
  UPDATE public.inspection_records SET status = 'abandoned', abandon_reason = 'Test' WHERE id = i1;
  PERFORM pg_temp.assert_eq((SELECT status FROM public.inspection_records WHERE id = i1), 'abandoned', 'abandoning needs no order');
  UPDATE public.organisation_settings SET require_production_order = false WHERE organisation_id = org;

  -- ------------------------------------------------------------------ Backfill: free text typed on existing records
  -- (all of these are abandoned or NCs: the history the backfill must reach)
  i2 := app.start_inspection(site, p1, NULL, machine); PERFORM app.set_job_details(i2, 'wo-100', 'L1', 50, 'S1');
  i3 := app.start_inspection(site, p1, NULL, machine); PERFORM app.set_job_details(i3, ' WO-100 ', 'l1', 50, NULL);
  i4 := app.start_inspection(site, p1, NULL, machine); PERFORM app.set_job_details(i4, 'WO-200', NULL, NULL, NULL);
  i5 := app.start_inspection(site, p2, NULL, machine); PERFORM app.set_job_details(i5, 'WO-200', 'P2-LOT', 8, NULL);
  i6 := app.start_inspection(site, p1, NULL, machine); PERFORM app.set_job_details(i6, 'WO-100', 'L9', 5, NULL);
  UPDATE public.inspection_records SET status = 'abandoned', abandon_reason = 'History' WHERE id IN (i2, i3, i4, i5, i6);
  INSERT INTO public.production_orders (organisation_id, order_number, part_id, site_id, quantity_planned) VALUES (org, 'WO-300', p1, site, 12) RETURNING id INTO wo300;
  INSERT INTO public.nonconformances (organisation_id, source, stage, title, site_id, part_id, supplier_id, lot_number) VALUES (org, 'supplier', 'draft', 'Bad steel', site, p1, supplier, 'HEAT-9') RETURNING id INTO ncr2;
  INSERT INTO public.nonconformances (organisation_id, source, stage, title, site_id, work_order) VALUES (org, 'internal', 'draft', 'No part', site, 'WO-777') RETURNING id INTO ncr3;
  INSERT INTO public.nonconformances (organisation_id, source, stage, title, site_id, part_id, work_order) VALUES (org, 'internal', 'draft', 'Long text', site, p1, repeat('W', 61)) RETURNING id INTO ncr4;
  INSERT INTO public.nonconformances (organisation_id, source, stage, title, site_id, part_id, lot_number) VALUES (org, 'internal', 'draft', 'Lot L9 without an order', site, p1, 'L9') RETURNING id INTO ncr6;
  INSERT INTO public.nonconformances (organisation_id, source, stage, title, site_id, part_id, work_order) VALUES (org, 'internal', 'draft', 'On WO-300', site, p1, 'wo-300') RETURNING id INTO ncr5;
  -- A closed NC is frozen to people; loaded as history it must still be reachable.
  PERFORM pg_temp.logout();
  INSERT INTO public.nonconformances (organisation_id, reference, source, stage, title, site_id, part_id, work_order, lot_number, closed_at) VALUES (org, 'NCR-HIST-1', 'internal', 'closed', 'NC on WO-100', site, p1, 'WO-100', 'L1', now()) RETURNING id INTO ncr1;

  SELECT count(*) INTO before_orders FROM public.production_orders WHERE organisation_id = org;

  rep := app.system_backfill_production_links(org, true);
  PERFORM pg_temp.assert_eq((rep->>'dryRun')::boolean, true, 'the default is a dry run');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.production_orders WHERE organisation_id = org), before_orders::bigint, 'a dry run creates nothing');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.inspection_records WHERE organisation_id = org AND (production_order_id IS NOT NULL AND id <> i1)), 0::bigint, 'and links nothing');
  PERFORM pg_temp.assert_eq((rep->'orders'->>'new')::int, 1, 'dry run: one new order (WO-100; WO-300 exists, WO-200 is ambiguous, WO-777 has no part)');
  PERFORM pg_temp.assert_eq((rep->'orders'->>'matched')::int, 1, 'dry run: WO-300 would be reused');
  PERFORM pg_temp.assert_eq(rep->'orders'->'skipped', '[{"number": "WO-200", "reason": "typed against more than one part"}]'::jsonb, 'dry run: WO-200 is listed as skipped, with the reason');
  PERFORM pg_temp.assert_eq((rep->>'noPart')::int, 1, 'dry run: the NC without a part is counted');
  PERFORM pg_temp.assert_eq((rep->>'unusableText')::int, 1, 'dry run: the 61-character work order is counted');

  rep := app.system_backfill_production_links(org, false);
  PERFORM pg_temp.assert_eq((rep->>'dryRun')::boolean, false, 'now for real');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.production_orders WHERE organisation_id = org AND upper(order_number) = 'WO-100'), 1::bigint, 'WO-100, wo-100 and " WO-100 " are one order');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.production_orders WHERE organisation_id = org AND upper(order_number) = 'WO-300'), 1::bigint, 'WO-300 was reused, not duplicated');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.production_orders WHERE organisation_id = org AND upper(order_number) IN ('WO-200', 'WO-777')), 0::bigint, 'nothing was guessed for WO-200 or WO-777');
  PERFORM pg_temp.assert_eq((SELECT status || '/' || quantity_planned::int FROM public.production_orders WHERE organisation_id = org AND upper(order_number) = 'WO-100'), 'released/50', 'a created order is released with the largest quantity seen');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.inspection_records WHERE id IN (i2, i3) AND production_order_id = (SELECT id FROM public.production_orders WHERE organisation_id = org AND upper(order_number) = 'WO-100')), 2::bigint, 'both typed spellings are linked to it (abandoned jobs included)');
  PERFORM pg_temp.assert_eq((SELECT work_order || '|' || lot FROM public.inspection_records WHERE id = i2), 'wo-100|L1', 'the typed text is exactly as it was');
  PERFORM pg_temp.assert_eq((SELECT work_order FROM public.inspection_records WHERE id = i3), 'WO-100', 'also with its original spacing trimmed only as stored');
  PERFORM pg_temp.assert_eq((SELECT production_order_id IS NOT NULL FROM public.nonconformances WHERE id = ncr1), true, 'a closed (frozen) NC is linked too');
  PERFORM pg_temp.assert_eq((SELECT work_order FROM public.nonconformances WHERE id = ncr1), 'WO-100', 'and its text is untouched');
  PERFORM pg_temp.assert_eq((SELECT production_order_id = wo300 FROM public.nonconformances WHERE id = ncr5), true, 'the NC on wo-300 is linked to the existing WO-300');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.lots WHERE organisation_id = org AND part_id = p1 AND upper(lot_number) = 'L1'), 1::bigint, 'lot L1 and l1 are one lot');
  PERFORM pg_temp.assert_eq((SELECT production_order_id IS NOT NULL FROM public.lots WHERE organisation_id = org AND upper(lot_number) = 'L1'), true, 'lot L1 takes the order every record naming it names');
  PERFORM pg_temp.assert_eq((SELECT origin || '/' || (supplier_id = supplier)::text || '/' || (production_order_id IS NULL)::text FROM public.lots WHERE organisation_id = org AND lot_number = 'HEAT-9'), 'received/true/true', 'a lot named only by a supplier NC is a received lot with that supplier');
  PERFORM pg_temp.assert_eq((SELECT production_order_id IS NULL AND lot_id IS NOT NULL FROM public.inspection_records WHERE id = i5), true, 'a record under the ambiguous order still gets its lot');
  PERFORM pg_temp.assert_eq((SELECT lot_id IS NOT NULL AND serial_id IS NOT NULL FROM public.inspection_records WHERE id = i2), true, 'lot and serial are linked');
  PERFORM pg_temp.assert_eq((SELECT lot_id IS NOT NULL FROM public.serial_numbers WHERE organisation_id = org AND upper(serial_number) = 'S1'), true, 'the serial number takes its lot');
  PERFORM pg_temp.assert_eq((SELECT production_order_id IS NULL FROM public.lots WHERE organisation_id = org AND lot_number = 'L9'), true, 'a lot named once without an order is not given the order the other record names');
  PERFORM pg_temp.assert_eq((SELECT production_order_id IS NOT NULL AND lot_id IS NOT NULL FROM public.inspection_records WHERE id = i6), true, 'that record has its order and lot');
  PERFORM pg_temp.assert_eq((SELECT production_order_id IS NULL FROM public.nonconformances WHERE id IN (ncr3, ncr4) GROUP BY 1 LIMIT 1), true, 'the NC with no part and the one with unusable text are left alone');
  PERFORM pg_temp.assert_eq((rep->>'inspectionsLinked')::int, 4, 'the report counts the inspections linked (the two on WO-100, the one on WO-100 and L9, and the lot of the one on WO-200)');
  PERFORM pg_temp.assert_eq((rep->>'ncrsLinked')::int, 4, 'and the NCs linked (WO-100, the supplier lot, WO-300, lot L9)');
  PERFORM pg_temp.assert_eq((SELECT count(*) > 0 FROM public.audit_events WHERE organisation_id = org AND entity_type = 'inspection_records' AND changed_fields @> ARRAY['production_order_id'] AND entity_id = i2::text), true, 'the links are on the audit trail');

  -- While the backfill setting is on, the links are all an inspection will let change.
  PERFORM set_config('app.production_backfill', 'on', true);
  r := pg_temp.fails(format('UPDATE public.inspection_records SET notes = ''tampered'' WHERE id = %L', i2));
  PERFORM pg_temp.assert_eq(r LIKE 'QM008:%only link%', true, 'the backfill setting does not open an inspection to any other change');
  PERFORM set_config('app.production_backfill', '', true);

  -- Again: nothing new.
  rep := app.system_backfill_production_links(org, false);
  PERFORM pg_temp.assert_eq(((rep->'orders'->>'new')::int + (rep->'lots'->>'new')::int + (rep->'serialNumbers'->>'new')::int), 0, 'a second run creates nothing');
  PERFORM pg_temp.assert_eq((rep->>'recordsToLink')::int, 0, 'and has nothing left to link');

  -- Only the API login may run it.
  PERFORM pg_temp.login(u_owner);
  r := pg_temp.fails(format('SELECT app.system_backfill_production_links(%L, true)', org));
  PERFORM pg_temp.assert_eq(r LIKE '42501:%', true, 'an organisation owner cannot call the backfill directly');
  PERFORM pg_temp.logout();
  r := pg_temp.fails('SELECT app.system_backfill_production_links(gen_random_uuid(), true)');
  PERFORM pg_temp.assert_eq(r LIKE 'P0002:%', true, 'an unknown organisation is refused');
END $$;
ROLLBACK;
