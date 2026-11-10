-- Integrations IN5: production orders imported through the table rules (status kept on create, moved step by step on update, the reserved external ids
-- filled), and field ownership on an update: "Fortress wins" fields are never overwritten, "review" fields that differ are parked for a person to accept
-- or reject, and the review queue's rules (one open value per record and field, a rejected value not asked again, agreeing values clear it).
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('5f500000-0000-0000-0000-000000000a01', 'ann@ownership.test'), ('5f500000-0000-0000-0000-000000000a02', 'bob@ownership.test'),
  ('5f500000-0000-0000-0000-000000000a04', 'eve@ownership.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

-- One full import of one record through the runner (as the API does it), optionally with a template. Answers {status, internal, errors, action, run}.
CREATE FUNCTION pg_temp.import_one(p_org uuid, p_conn uuid, p_user uuid, p_entity text, p_ext text, p_canonical jsonb, p_template uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE run uuid; owner uuid := gen_random_uuid(); todo jsonb; v_id uuid; row_id uuid; i public.integration_inbox%ROWTYPE;
BEGIN
  PERFORM pg_temp.login(p_user); run := app.request_integration_run(p_conn, p_entity, 'full', NULL, p_template); PERFORM pg_temp.logout();
  PERFORM app.system_lease_integration_run(p_org, run, owner, 30);
  PERFORM app.system_stage_integration_records(p_org, run, owner,
    jsonb_build_array(jsonb_build_object('externalId', p_ext, 'payload', jsonb_build_object('id', p_ext), 'canonical', p_canonical)), NULL, true);
  todo := app.system_integration_rows_to_apply(p_org, run, owner, 10);
  IF jsonb_array_length(todo) = 1 THEN
    row_id := (todo -> 0 ->> 'id')::uuid;
    BEGIN
      v_id := app.system_import_record(p_org, run, owner, row_id, (todo -> 0 ->> 'internalId')::uuid, todo -> 0 -> 'canonical');
      PERFORM app.system_apply_integration_row(p_org, run, owner, row_id, v_id, todo -> 0 ->> 'action');
    EXCEPTION WHEN OTHERS THEN
      PERFORM app.system_fail_integration_row(p_org, run, owner, row_id, SQLERRM, NULL);
    END;
  END IF;
  PERFORM pg_temp.logout();
  PERFORM app.system_finish_integration_run(p_org, run, owner);
  SELECT * INTO i FROM public.integration_inbox WHERE run_id = run;
  RETURN jsonb_build_object('status', i.status, 'internal', i.internal_id, 'errors', i.errors, 'action', i.action, 'run', run);
END $$;

DO $$
DECLARE
  ann uuid := '5f500000-0000-0000-0000-000000000a01'; bob uuid := '5f500000-0000-0000-0000-000000000a02'; eve uuid := '5f500000-0000-0000-0000-000000000a04';
  org uuid; org2 uuid; r_viewer uuid; api uuid; site uuid; part uuid; part2 uuid; rev_a uuid; cust uuid; po uuid; hand uuid; m uuid; tpl uuid; tpl_m uuid;
  res jsonb; c1 uuid; c2 uuid; c3 uuid; v_status text;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('Ownership Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('Ownership Beta'); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, bob, 'active');
  SELECT id INTO r_viewer FROM public.roles WHERE organisation_id = org AND key = 'quality_engineer';
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, ou.id, r_viewer FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id = bob;
  PERFORM pg_temp.give_controller_seat(org, ann);
  PERFORM pg_temp.give_controller_seat(org, bob);
  PERFORM pg_temp.give_controller_seat(org2, eve);
  INSERT INTO public.sites (organisation_id, code, name) VALUES (org, 'PLANT2', 'Plant 2') RETURNING id INTO site;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'P-100', 'Bracket') RETURNING id INTO part;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'P-200', 'Housing') RETURNING id INTO part2;
  INSERT INTO public.part_revisions (organisation_id, part_id, revision) VALUES (org, part, 'A') RETURNING id INTO rev_a;
  INSERT INTO public.customers (organisation_id, code, name) VALUES (org, 'BIGCO', 'Big Co') RETURNING id INTO cust;

  PERFORM pg_temp.login(ann);
  api := app.create_integration_connection(org, 'rest_api', 'ERP', 'erp', '{"baseUrl": "https://erp.example.com", "authType": "none"}'::jsonb);
  PERFORM app.record_integration_connection_test(api, true, 'ok');
  PERFORM app.mark_integration_ready(api);
  PERFORM app.activate_integration_connection(api);
  PERFORM app.set_integration_import_settings(api, 'production_order', '{"writeMode": "add_update"}'::jsonb);
  PERFORM app.set_integration_import_settings(api, 'machine', '{"writeMode": "add_update"}'::jsonb);
  PERFORM pg_temp.logout();

  -- ---- the status moves ----
  PERFORM pg_temp.assert_eq(app.production_order_status_path('planned', 'closed'), ARRAY['released', 'in_progress', 'completed', 'closed'], 'planned to closed walks every step');
  PERFORM pg_temp.assert_eq(app.production_order_status_path('released', 'released'), ARRAY[]::text[], 'the same status needs no step');
  PERFORM pg_temp.assert_eq(app.production_order_status_path('closed', 'planned'), NULL::text[], 'a closed order goes nowhere');
  PERFORM pg_temp.assert_eq(app.production_order_status_path('in_progress', 'planned'), NULL::text[], 'an order in progress cannot go back to planned');

  -- ---- people still cannot set the status or the external id of a new order ----
  PERFORM pg_temp.login(ann);
  INSERT INTO public.production_orders (organisation_id, order_number, part_id, quantity_planned, status, external_system, external_id)
  VALUES (org, 'WO-HAND', part, 5, 'completed', 'erp', 'X1') RETURNING id INTO hand;
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT status || '/' || coalesce(external_id, '-') FROM public.production_orders WHERE id = hand), 'planned/-', 'a person''s new order is planned with no external id');

  -- ---- a new order keeps the source's status and identity ----
  res := pg_temp.import_one(org, api, ann, 'production_order', 'ERP-17', jsonb_build_object('orderNumber', 'WO-1001', 'part', 'P-100', 'partId', part,
    'partRevision', 'a', 'customer', 'BIGCO', 'customerId', cust, 'site', 'PLANT2', 'siteId', site, 'quantityPlanned', 250, 'dueDate', '2026-12-01',
    'status', 'in_progress', 'notes', 'From ERP'));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'applied', 'an order is imported');
  po := (res ->> 'internal')::uuid;
  PERFORM pg_temp.assert_eq((SELECT status || '/' || external_system || '/' || external_id || '/' || part_revision_id::text || '/' || quantity_planned::int FROM public.production_orders WHERE id = po),
    'in_progress/erp/ERP-17/' || rev_a::text || '/250', 'with its status, the connection''s system code, the source id and the revision (any case)');
  PERFORM pg_temp.assert_eq((SELECT created_by FROM public.production_orders WHERE id = po), ann, 'made as the person who started the import');
  res := pg_temp.import_one(org, api, ann, 'production_order', 'ERP-18', jsonb_build_object('orderNumber', 'WO-1002', 'part', 'P-100', 'partId', part, 'partRevision', 'Z', 'quantityPlanned', 1));
  PERFORM pg_temp.assert_eq(res ->> 'status' || '/' || (res -> 'errors' -> 0 ->> 'message'), 'failed/The part has no revision Z in Fortress', 'an unknown revision fails the row with the reason');
  res := pg_temp.import_one(org, api, ann, 'production_order', 'ERP-19', jsonb_build_object('orderNumber', 'WO-1003', 'part', 'P-100', 'partId', part, 'quantityPlanned', 1, 'status', 'Cancelled'));
  PERFORM pg_temp.assert_eq((SELECT status || '/' || status_reason FROM public.production_orders WHERE id = (res ->> 'internal')::uuid), 'cancelled/Cancelled in the source system', 'a cancelled order gets a reason when the source gives none');
  res := pg_temp.import_one(org, api, ann, 'production_order', 'ERP-20', jsonb_build_object('orderNumber', 'WO-1004', 'part', 'P-100', 'partId', part, 'quantityPlanned', 1, 'status', 'paused'));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'a status that is not ours fails');

  -- ---- an update moves the status step by step, under the same rules ----
  INSERT INTO public.production_operations (organisation_id, production_order_id, sequence, operation_code) VALUES (org, po, 10, 'OP10');
  res := pg_temp.import_one(org, api, ann, 'production_order', 'ERP-17', jsonb_build_object('orderNumber', 'WO-1001', 'status', 'completed'));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'an order with an open operation cannot complete, even from an import');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.production_orders WHERE id = po), 'in_progress', 'and stays as it was');
  UPDATE public.production_operations SET status = 'completed' WHERE production_order_id = po;
  res := pg_temp.import_one(org, api, ann, 'production_order', 'ERP-17', jsonb_build_object('orderNumber', 'WO-1001', 'status', 'closed', 'quantityPlanned', 240));
  PERFORM pg_temp.assert_eq((SELECT status || '/' || quantity_planned::int FROM public.production_orders WHERE id = po), 'closed/240', 'in progress to closed walks through completed');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM audit.events WHERE entity_type = 'production_orders' AND entity_id = po::text AND action = 'update'), 3, 'each step is in the audit trail');
  res := pg_temp.import_one(org, api, ann, 'production_order', 'ERP-17', jsonb_build_object('orderNumber', 'WO-1001', 'notes', 'Late edit'));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'a closed order cannot be changed by an import');

  -- ---- matching an order made by hand takes the source's identity ----
  PERFORM pg_temp.login(ann); PERFORM app.set_integration_import_settings(api, 'production_order', '{"writeMode": "add_update", "matchExisting": true}'::jsonb); PERFORM pg_temp.logout();
  res := pg_temp.import_one(org, api, ann, 'production_order', 'ERP-50', jsonb_build_object('orderNumber', 'wo-hand', 'status', 'released'));
  PERFORM pg_temp.assert_eq((res ->> 'internal')::uuid, hand, 'the order number matches the one made by hand');
  PERFORM pg_temp.assert_eq((SELECT status || '/' || external_id FROM public.production_orders WHERE id = hand), 'released/ERP-50', 'which now carries the source id');

  -- ---- ownership: Fortress wins ----
  PERFORM pg_temp.login(ann);
  tpl_m := app.create_integration_template(org, 'machine', 'Machines from ERP', NULL, jsonb_build_object('keyField', 'Id', 'settings', '{"writeMode": "add_update"}'::jsonb,
    'fields', '[{"target": "code", "source": "Code"}, {"target": "name", "source": "Name", "ownership": "qms_wins"}, {"target": "site", "source": "Site", "ownership": "qms_wins"}, {"target": "description", "source": "Desc"}]'::jsonb));
  PERFORM pg_temp.logout();
  res := pg_temp.import_one(org, api, ann, 'machine', 'MC1', jsonb_build_object('code', 'CNC-1', 'name', 'Lathe', 'site', 'PLANT2', 'siteId', site, 'description', 'First'), tpl_m);
  m := (res ->> 'internal')::uuid;
  PERFORM pg_temp.assert_eq((SELECT name || '/' || site_id::text FROM public.machines WHERE id = m), 'Lathe/' || site::text, 'Fortress-owned fields are set when the record is created');
  UPDATE public.machines SET name = 'Lathe (renamed in Fortress)' WHERE id = m;
  res := pg_temp.import_one(org, api, ann, 'machine', 'MC1', jsonb_build_object('code', 'CNC-1', 'name', 'Lathe ERP', 'site', NULL, 'siteId', NULL, 'description', 'Second'), tpl_m);
  PERFORM pg_temp.assert_eq(res ->> 'action', 'update', 'a later import updates');
  PERFORM pg_temp.assert_eq((SELECT name || '/' || coalesce(site_id::text, '-') || '/' || description FROM public.machines WHERE id = m),
    'Lathe (renamed in Fortress)/' || site::text || '/Second', 'but leaves Fortress-owned fields (and their links) alone; the others follow the source');

  -- ---- ownership: review ----
  PERFORM pg_temp.login(ann);
  tpl := app.create_integration_template(org, 'production_order', 'Orders from ERP', NULL, jsonb_build_object('keyField', 'Id', 'settings', '{"writeMode": "add_update"}'::jsonb,
    'fields', '[{"target": "orderNumber", "source": "No"}, {"target": "part", "source": "Part"}, {"target": "quantityPlanned", "source": "Qty", "ownership": "manual_review"},
                {"target": "dueDate", "source": "Due", "ownership": "manual_review"}, {"target": "customer", "source": "Cust", "ownership": "manual_review"},
                {"target": "status", "source": "Status", "ownership": "manual_review"}, {"target": "notes", "source": "Notes"}]'::jsonb));
  PERFORM pg_temp.logout();
  res := pg_temp.import_one(org, api, ann, 'production_order', 'ERP-60', jsonb_build_object('orderNumber', 'WO-2000', 'part', 'P-100', 'partId', part, 'quantityPlanned', 100,
    'dueDate', '2026-12-01', 'customer', NULL, 'customerId', NULL, 'status', 'planned', 'notes', 'One'), tpl);
  po := (res ->> 'internal')::uuid;
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.integration_conflicts WHERE internal_id = po), 0, 'nothing is reviewed when a record is created');
  res := pg_temp.import_one(org, api, ann, 'production_order', 'ERP-60', jsonb_build_object('orderNumber', 'WO-2000', 'part', 'P-100', 'partId', part, 'quantityPlanned', 120,
    'dueDate', '2026-12-01', 'customer', 'BIGCO', 'customerId', cust, 'status', 'released', 'notes', 'Two'), tpl);
  PERFORM pg_temp.assert_eq(res ->> 'status', 'applied', 'the row is applied');
  PERFORM pg_temp.assert_eq((SELECT quantity_planned::int || '/' || coalesce(customer_id::text, '-') || '/' || status || '/' || notes FROM public.production_orders WHERE id = po),
    '100/-/planned/Two', 'fields under review are not written; the others are');
  PERFORM pg_temp.assert_eq((SELECT string_agg(field, ',' ORDER BY field) FROM public.integration_conflicts WHERE internal_id = po AND status = 'open'), 'customer,quantityPlanned,status',
    'the values that differ are parked (the due date agrees, so it is not)');
  PERFORM pg_temp.assert_eq((SELECT parked FROM public.integration_sync_runs WHERE id = (res ->> 'run')::uuid), 3, 'the run counts them');
  SELECT id INTO c1 FROM public.integration_conflicts WHERE internal_id = po AND field = 'quantityPlanned' AND status = 'open';
  SELECT id INTO c2 FROM public.integration_conflicts WHERE internal_id = po AND field = 'status' AND status = 'open';
  SELECT id INTO c3 FROM public.integration_conflicts WHERE internal_id = po AND field = 'customer' AND status = 'open';
  PERFORM pg_temp.assert_eq((SELECT fortress_change -> 'quantity_planned' FROM public.integration_conflicts WHERE id = c1), '{"from": 100, "to": 120}'::jsonb, 'what it would change is kept');
  PERFORM pg_temp.assert_eq((SELECT source_data FROM public.integration_conflicts WHERE id = c3), jsonb_build_object('customer', 'BIGCO', 'customerId', cust), 'a link keeps its code and the record it resolved to');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM audit.events WHERE entity_type = 'production_orders' AND entity_id = po::text AND action = 'update'), 1,
    'checking a value leaves no trace on the record (only the real update is recorded)');

  -- the same file again changes nothing and asks nothing new
  res := pg_temp.import_one(org, api, ann, 'production_order', 'ERP-60', jsonb_build_object('orderNumber', 'WO-2000', 'part', 'P-100', 'partId', part, 'quantityPlanned', 120,
    'dueDate', '2026-12-01', 'customer', 'BIGCO', 'customerId', cust, 'status', 'released', 'notes', 'Two'), tpl);
  PERFORM pg_temp.assert_eq(res ->> 'status', 'unchanged', 'an unchanged record writes nothing');
  -- a newer value replaces the one waiting
  res := pg_temp.import_one(org, api, ann, 'production_order', 'ERP-60', jsonb_build_object('orderNumber', 'WO-2000', 'part', 'P-100', 'partId', part, 'quantityPlanned', 130,
    'dueDate', '2026-12-01', 'customer', 'BIGCO', 'customerId', cust, 'status', 'released', 'notes', 'Three'), tpl);
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_conflicts WHERE id = c1), 'superseded', 'the older value is superseded');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.integration_conflicts WHERE internal_id = po AND status = 'open'), 3, 'one value waits per field');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.integration_conflicts WHERE internal_id = po AND field = 'status'), 1, 'a value already waiting is not parked twice');
  SELECT id INTO c1 FROM public.integration_conflicts WHERE internal_id = po AND field = 'quantityPlanned' AND status = 'open';

  -- deciding
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.integration_conflicts WHERE internal_id = po), 4, 'a Controller seat holder who can read integrations sees the queue');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.decide_integration_conflict(%L, true)$f$, c1)), 5), '42501', 'but someone who may only read integrations cannot decide');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve);
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.integration_conflicts), 0, 'another organisation sees none');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.decide_integration_conflict(%L, true)$f$, c1)), 5), 'P0002', 'nor decides one');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq(app.decide_integration_conflict(c1, true, NULL), 'accepted', 'accepting');
  PERFORM pg_temp.assert_eq((SELECT quantity_planned::int FROM public.production_orders WHERE id = po), 130, 'writes the value');
  PERFORM pg_temp.assert_eq((SELECT actor_user_id FROM audit.events WHERE entity_type = 'production_orders' AND entity_id = po::text AND action = 'update' ORDER BY seq DESC LIMIT 1), ann,
    'as the person who accepted it');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.decide_integration_conflict(%L, true)$f$, c1)), 5), 'QM022', 'a value is decided once');
  PERFORM pg_temp.assert_eq(app.decide_integration_conflict(c2, true, 'ERP released it'), 'accepted', 'accepting a status');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.production_orders WHERE id = po), 'released', 'moves it under the same rules');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.decide_integration_conflict(%L, false, '')$f$, c3)), 5), 'QM022', 'rejecting needs a reason');
  PERFORM pg_temp.assert_eq(app.decide_integration_conflict(c3, false, 'We supply this order ourselves'), 'rejected', 'rejecting');
  PERFORM pg_temp.assert_eq((SELECT customer_id FROM public.production_orders WHERE id = po), NULL::uuid, 'keeps Fortress''s value');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$UPDATE public.integration_conflicts SET decision_note = 'x' WHERE id = %L$f$, c3)), 5), '42501', 'nobody writes the queue directly');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$UPDATE public.integration_conflicts SET decision_note = 'x' WHERE id = %L$f$, c3)), 5), 'QM022', 'a decided value is frozen even for SQL');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$DELETE FROM public.integration_conflicts WHERE id = %L$f$, c3)), 5), 'QM022', 'and never deleted');

  -- a rejected value is not asked again; a different one is; an agreeing one clears what waits
  res := pg_temp.import_one(org, api, ann, 'production_order', 'ERP-60', jsonb_build_object('orderNumber', 'WO-2000', 'part', 'P-100', 'partId', part, 'quantityPlanned', 130,
    'dueDate', '2027-01-15', 'customer', 'BIGCO', 'customerId', cust, 'status', 'released', 'notes', 'Four'), tpl);
  PERFORM pg_temp.assert_eq((SELECT string_agg(field, ',' ORDER BY field) FROM public.integration_conflicts WHERE internal_id = po AND status = 'open'), 'dueDate',
    'the rejected customer is not parked again; the new due date is');
  res := pg_temp.import_one(org, api, ann, 'production_order', 'ERP-60', jsonb_build_object('orderNumber', 'WO-2000', 'part', 'P-100', 'partId', part, 'quantityPlanned', 130,
    'dueDate', '2026-12-01', 'customer', NULL, 'customerId', NULL, 'status', 'released', 'notes', 'Five'), tpl);
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.integration_conflicts WHERE internal_id = po AND status = 'open'), 0, 'a source that agrees again clears what waited');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_conflicts WHERE internal_id = po AND field = 'dueDate'), 'superseded', 'which is kept as superseded');

  -- a value Fortress cannot take is still parked, with the reason
  UPDATE public.production_orders SET status = 'in_progress' WHERE id = po;
  res := pg_temp.import_one(org, api, ann, 'production_order', 'ERP-60', jsonb_build_object('orderNumber', 'WO-2000', 'part', 'P-100', 'partId', part, 'quantityPlanned', 130,
    'dueDate', '2026-12-01', 'customer', NULL, 'customerId', NULL, 'status', 'planned', 'notes', 'Six'), tpl);
  PERFORM pg_temp.assert_eq((SELECT status FROM public.production_orders WHERE id = po), 'in_progress', 'nothing moved');
  SELECT apply_error INTO v_status FROM public.integration_conflicts WHERE internal_id = po AND field = 'status' AND status = 'open';
  PERFORM pg_temp.assert_eq(v_status, 'An order that is in progress cannot become planned', 'one it cannot take waits with the reason');
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.decide_integration_conflict(%L, true)$f$,
    (SELECT id FROM public.integration_conflicts WHERE internal_id = po AND field = 'status' AND status = 'open'))), 5), 'QM017', 'and accepting it is refused by the same rule');
  PERFORM pg_temp.logout();

  -- the runner functions stay the API login's
  PERFORM pg_temp.assert_eq(has_function_privilege('authenticated', 'app.integration_apply_fields(uuid, text, uuid, jsonb)', 'EXECUTE'), false, 'nobody signed in can write fields directly');
  PERFORM pg_temp.assert_eq(has_function_privilege('authenticated', 'app.import_production_order(uuid, uuid, jsonb, text, text)', 'EXECUTE'), false, 'nor import an order');
END $$;

ROLLBACK;
