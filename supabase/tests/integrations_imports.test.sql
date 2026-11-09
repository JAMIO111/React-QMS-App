-- Integrations IN4: file connections without a lifecycle, import settings (add only / add and update / update only, matching, fixed rules for NCs),
-- staging that honours them (skipped, matched, taken), reference lookups (source id or Fortress code), the write permission for a real import, and the
-- import functions writing each kind of record through the table rules as the person who started the run.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('5f400000-0000-0000-0000-000000000a01', 'ann@imports.test'), ('5f400000-0000-0000-0000-000000000a02', 'bob@imports.test'),
  ('5f400000-0000-0000-0000-000000000a04', 'eve@imports.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

-- One full import of one record through the runner, as the system does it: request (as ann), lease, stage, apply through the import function, finish.
-- Answers {status, internal, errors} of the staged row.
CREATE FUNCTION pg_temp.import_one(p_org uuid, p_conn uuid, p_user uuid, p_entity text, p_ext text, p_canonical jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE run uuid; owner uuid := gen_random_uuid(); todo jsonb; v_id uuid; row_id uuid; i public.integration_inbox%ROWTYPE;
BEGIN
  PERFORM pg_temp.login(p_user); run := app.request_integration_run(p_conn, p_entity, 'full'); PERFORM pg_temp.logout();
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
  RETURN jsonb_build_object('status', i.status, 'internal', i.internal_id, 'errors', i.errors, 'action', i.action);
END $$;

DO $$
DECLARE
  ann uuid := '5f400000-0000-0000-0000-000000000a01'; bob uuid := '5f400000-0000-0000-0000-000000000a02'; eve uuid := '5f400000-0000-0000-0000-000000000a04';
  org uuid; org2 uuid; r_viewer uuid; csv uuid; api uuid; site uuid; dept uuid; hand uuid; res jsonb; m1 uuid; gt uuid; g uuid; p uuid; nc uuid; run uuid;
  owner uuid := gen_random_uuid(); look jsonb; s1 uuid;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('Imports Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('Imports Beta'); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, bob, 'active');
  SELECT id INTO r_viewer FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, ou.id, r_viewer FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id = bob;
  PERFORM pg_temp.give_controller_seat(org, ann);
  PERFORM pg_temp.give_controller_seat(org, bob);
  PERFORM pg_temp.give_controller_seat(org2, eve);
  INSERT INTO public.sites (organisation_id, code, name) VALUES (org, 'PLANT2', 'Plant 2') RETURNING id INTO site;
  INSERT INTO public.departments (organisation_id, site_id, code, name) VALUES (org, site, 'QA', 'Quality') RETURNING id INTO dept;

  -- ---- file connections need no lifecycle ----
  PERFORM pg_temp.login(ann);
  csv := app.create_integration_connection(org, 'csv', 'Legacy files', 'legacy', '{}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_connections WHERE id = csv), 'active', 'a file connection is in use once created');
  PERFORM pg_temp.assert_eq((SELECT activated_by FROM public.integration_connections WHERE id = csv), ann, 'its creator is recorded as having put it in use');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.mark_integration_ready(%L)$f$, csv)), 5), 'QM022', 'it is never marked ready');
  api := app.create_integration_connection(org, 'rest_api', 'Legacy API', 'legacy-api', '{"baseUrl": "https://legacy.example.com", "authType": "none"}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_connections WHERE id = api), 'draft', 'an API connection still starts as a draft');
  PERFORM app.record_integration_connection_test(api, true, 'ok');
  PERFORM app.mark_integration_ready(api);
  PERFORM app.activate_integration_connection(api);

  -- ---- import settings ----
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(app.integration_settings_for(api, 'machine'), '{"writeMode": "add_only", "matchExisting": false, "onMissing": "nothing", "schedule": "manual"}'::jsonb, 'the defaults are the safest choice');
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.set_integration_import_settings(%L, 'nonconformance', '{"writeMode": "add_update"}'::jsonb)$f$, api)), 5), 'QM022', 'non-conformances are only ever added');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.set_integration_import_settings(%L, 'nonconformance', '{"matchExisting": true}'::jsonb)$f$, api)), 5), 'QM022', 'nor matched');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.set_integration_import_settings(%L, 'gauge', '{"onMissing": "deactivate"}'::jsonb)$f$, api)), 5), 'QM022', 'a gauge cannot be made inactive');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.set_integration_import_settings(%L, 'machine', '{"schedule": "daily"}'::jsonb)$f$, csv)), 5), 'QM022', 'an uploaded file cannot run on a schedule');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.set_integration_import_settings(%L, 'machine', '{"writeMode": "replace"}'::jsonb)$f$, api)), 5), 'QM022', 'an unknown mode is refused');
  res := app.set_integration_import_settings(api, 'machine', '{"schedule": "daily", "onMissing": "deactivate"}'::jsonb);
  PERFORM pg_temp.assert_eq(res ->> 'schedule', 'daily', 'an API connection may run daily');
  PERFORM pg_temp.assert_eq(res ->> 'writeMode', 'add_only', 'and what is not given stays as it was');
  PERFORM pg_temp.logout(); PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.set_integration_import_settings(%L, 'machine', '{}'::jsonb)$f$, api)), 5), '42501', 'a viewer cannot change the settings');
  PERFORM pg_temp.assert_eq(app.integration_may_write(org, 'machine'), false, 'nor write machines');
  PERFORM pg_temp.logout(); PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq(app.integration_may_write(org, 'gauge') AND app.integration_may_write(org, 'nonconformance'), true, 'an owner may write every kind');
  PERFORM pg_temp.logout();

  -- ---- add only (the default): created once, skipped after ----
  res := pg_temp.import_one(org, api, ann, 'machine', 'M1', jsonb_build_object('code', 'CNC-01', 'name', 'Lathe', 'site', 'PLANT2', 'siteId', site, 'workCentre', 'Turning'));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'applied', 'a new machine is created');
  m1 := (res ->> 'internal')::uuid;
  PERFORM pg_temp.assert_eq((SELECT site_id FROM public.machines WHERE id = m1), site, 'with the site the reference resolved to');
  PERFORM pg_temp.assert_eq((SELECT created_by FROM public.machines WHERE id = m1), ann, 'stamped as created by the person who started the import');
  PERFORM pg_temp.assert_eq((SELECT actor_user_id FROM audit.events WHERE entity_type = 'machines' AND entity_id = m1::text AND action = 'insert'), ann, 'and the audit trail names them');
  res := pg_temp.import_one(org, api, ann, 'machine', 'M1', jsonb_build_object('code', 'CNC-01', 'name', 'Lathe renamed', 'site', 'PLANT2', 'siteId', site, 'workCentre', 'Turning'));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'skipped', 'add only never touches an imported record');
  PERFORM pg_temp.assert_eq(res -> 'errors' -> 0 ->> 'message', 'Already imported: this import only adds new records', 'and says why');
  PERFORM pg_temp.assert_eq((SELECT name FROM public.machines WHERE id = m1), 'Lathe', 'the machine is unchanged');

  -- ---- add and update: only the mapped fields change ----
  PERFORM pg_temp.login(ann); PERFORM app.set_integration_import_settings(api, 'machine', '{"writeMode": "add_update"}'::jsonb); PERFORM pg_temp.logout();
  res := pg_temp.import_one(org, api, ann, 'machine', 'M1', jsonb_build_object('code', 'CNC-01', 'name', 'Lathe renamed'));
  PERFORM pg_temp.assert_eq(res ->> 'action', 'update', 'a changed record is an update');
  PERFORM pg_temp.assert_eq((SELECT name || '/' || work_centre FROM public.machines WHERE id = m1), 'Lathe renamed/Turning', 'the name moves, the unmapped work centre stays');
  PERFORM pg_temp.assert_eq((SELECT site_id FROM public.machines WHERE id = m1), site, 'and an unmapped site is not cleared');

  -- ---- update only: a new record is skipped ----
  PERFORM pg_temp.login(ann); PERFORM app.set_integration_import_settings(api, 'machine', '{"writeMode": "update_only"}'::jsonb); PERFORM pg_temp.logout();
  res := pg_temp.import_one(org, api, ann, 'machine', 'M2', jsonb_build_object('code', 'MILL-02', 'name', 'Mill'));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'skipped', 'update only creates nothing');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.machines WHERE organisation_id = org AND code = 'MILL-02'), 0, 'no machine was made');

  -- ---- matching a record made by hand ----
  INSERT INTO public.machines (organisation_id, code, name) VALUES (org, 'HAND-1', 'Keyed in by hand') RETURNING id INTO hand;
  PERFORM pg_temp.login(ann); PERFORM app.set_integration_import_settings(api, 'machine', '{"writeMode": "add_update", "matchExisting": true}'::jsonb); PERFORM pg_temp.logout();
  res := pg_temp.import_one(org, api, ann, 'machine', 'M7', jsonb_build_object('code', 'hand-1', 'name', 'Matched'));
  PERFORM pg_temp.assert_eq(res ->> 'action' || '/' || (res ->> 'internal'), 'update/' || hand::text, 'a code made by hand (any case) is matched and updated');
  PERFORM pg_temp.assert_eq((SELECT internal_id FROM public.integration_external_records WHERE connection_id = api AND entity_type = 'machine' AND external_id = 'M7'), hand, 'and linked in the map');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.machines WHERE organisation_id = org AND upper(code) = 'HAND-1'), 1, 'no duplicate was made');
  res := pg_temp.import_one(org, api, ann, 'machine', 'M8', jsonb_build_object('code', 'HAND-1', 'name', 'Second source record'));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'rejected', 'a record already linked to another source record cannot be matched again');

  -- ---- references: by source id or by Fortress code ----
  PERFORM pg_temp.login(ann); run := app.request_integration_run(api, 'nonconformance', 'preview'); PERFORM pg_temp.logout();
  PERFORM app.system_lease_integration_run(org, run, owner, 60);
  look := app.system_integration_lookup(org, run, owner, 'machine', 'source', ARRAY['M1', 'M7', 'M404']);
  PERFORM pg_temp.assert_eq(look, jsonb_build_object('M1', m1, 'M7', hand), 'a source id from an earlier import resolves through the map; an unknown one does not');
  look := app.system_integration_lookup(org, run, owner, 'site', 'code', ARRAY['plant2', 'NOPE']);
  PERFORM pg_temp.assert_eq(look, jsonb_build_object('plant2', site), 'a Fortress code resolves ignoring case');
  look := app.system_integration_lookup(org, run, owner, 'unit', 'code', ARRAY['MM']);
  PERFORM pg_temp.assert_eq(look ->> 'MM', 'mm', 'a unit resolves to its code');
  INSERT INTO public.sites (organisation_id, code, name) VALUES (org, 'PLANT3', 'Plant 3');
  INSERT INTO public.departments (organisation_id, site_id, code, name) SELECT org, id, 'QA', 'Quality 3' FROM public.sites WHERE organisation_id = org AND code = 'PLANT3';
  look := app.system_integration_lookup(org, run, owner, 'department', 'code', ARRAY['QA']);
  PERFORM pg_temp.assert_eq(look ->> 'QA', 'ambiguous', 'a department code used at two sites is ambiguous');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.system_integration_lookup(%L, %L, %L, 'machine', 'source', ARRAY['M1'])$f$, org2, run, owner)), 5), 'P0002', 'another organisation finds nothing');
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.system_integration_lookup(%L, %L, %L, 'machine', 'source', ARRAY['M1'])$f$, org, run, owner)), 5), '42501', 'a signed-in user cannot call the runner lookup');
  PERFORM pg_temp.logout();
  PERFORM app.system_stage_integration_records(org, run, owner, '[]'::jsonb, NULL, true);
  PERFORM app.system_finish_integration_run(org, run, owner);

  -- ---- each kind of record ----
  res := pg_temp.import_one(org, api, ann, 'supplier', 'S1', jsonb_build_object('code', 'ACME', 'name', 'Acme Ltd', 'country', 'GB', 'supplierType', 'manufacturer'));
  s1 := (res ->> 'internal')::uuid;
  PERFORM pg_temp.assert_eq((SELECT approval_status || '/' || country FROM public.suppliers WHERE id = s1), 'pending_approval/GB', 'a supplier arrives pending approval');
  res := pg_temp.import_one(org, api, ann, 'customer', 'C1', jsonb_build_object('code', 'BIGCO', 'name', 'Big Co'));
  PERFORM pg_temp.assert_eq((SELECT name FROM public.customers WHERE id = (res ->> 'internal')::uuid), 'Big Co', 'a customer is created');
  res := pg_temp.import_one(org, api, ann, 'part', 'P1', jsonb_build_object('partNumber', 'P-100', 'name', 'Bracket', 'revision', 'B'));
  p := (res ->> 'internal')::uuid;
  PERFORM pg_temp.assert_eq((SELECT revision || '/' || status FROM public.part_revisions WHERE part_id = p), 'B/draft', 'a part arrives with a draft revision, never released');
  res := pg_temp.import_one(org, api, ann, 'employee', 'E1', jsonb_build_object('employeeNumber', 'E-42', 'firstName', 'Grace', 'surname', 'Hopper', 'department', 'QA', 'departmentId', dept));
  PERFORM pg_temp.assert_eq((SELECT site_id FROM public."Employees" WHERE id = (res ->> 'internal')::uuid), site, 'an employee''s department fills the site (the register rule)');
  res := pg_temp.import_one(org, api, ann, 'gauge_type', 'GT1', jsonb_build_object('name', 'Micrometer', 'intervalValue', 6));
  gt := (res ->> 'internal')::uuid;
  PERFORM pg_temp.assert_eq((SELECT interval_value || ' ' || interval_unit FROM public.gauge_types WHERE id = gt), '6 months', 'a gauge type takes months when no unit is given');
  res := pg_temp.import_one(org, api, ann, 'gauge', 'G1', jsonb_build_object('assetNumber', 'G-001', 'description', '0-25 mm micrometer', 'gaugeType', 'GT1', 'gaugeTypeId', gt, 'unit', 'MM', 'unitCode', 'mm', 'rangeMax', 25));
  g := (res ->> 'internal')::uuid;
  PERFORM pg_temp.assert_eq((SELECT gauge_type_id::text || '/' || unit_code || '/' || status FROM public.gauges WHERE id = g), gt::text || '/mm/active', 'a gauge is created with its type and unit, its status not imported');
  PERFORM pg_temp.assert_eq((SELECT last_calibrated_on FROM public.gauges WHERE id = g), NULL::date, 'and no calibration date');
  res := pg_temp.import_one(org, api, ann, 'nonconformance', 'NC-0042', jsonb_build_object('title', 'Burr on edge', 'source', 'supplier', 'supplier', 'S1', 'supplierId', s1,
    'causalMachine', 'M1', 'causalMachineId', m1, 'category', 'PRODUCT', 'categoryId', pg_temp.cat(org), 'detectedAt', '2024-03-01', 'quantityAffected', 12));
  nc := (res ->> 'internal')::uuid;
  PERFORM pg_temp.assert_eq((SELECT stage || '/' || source || '/' || causal_process_id::text FROM public.nonconformances WHERE id = nc), 'draft/supplier/' || m1::text, 'a historical NC arrives as a draft linked to the imported machine');
  PERFORM pg_temp.assert_eq((SELECT reference IS NOT NULL FROM public.nonconformances WHERE id = nc), true, 'with a Fortress reference');
  res := pg_temp.import_one(org, api, ann, 'nonconformance', 'NC-0042', jsonb_build_object('title', 'Burr on edge (edited)', 'source', 'supplier'));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'skipped', 'an NC is never updated by a later import');
  PERFORM pg_temp.assert_eq((SELECT title FROM public.nonconformances WHERE id = nc), 'Burr on edge', 'it keeps what it had');

  -- a row that breaks a table rule fails with the reason and stays for a retry
  res := pg_temp.import_one(org, api, ann, 'supplier', 'S2', jsonb_build_object('code', 'BAD', 'name', 'Bad country', 'country', 'gbr'));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'a supplier with an invalid country fails');

  -- ---- a real import needs the write permission ----
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.request_integration_run(%L, 'machine', 'full')$f$, api)), 5), '42501', 'someone without the write permission cannot import');
  PERFORM pg_temp.logout();

  -- ---- the import function refuses what the settings do not allow, and only the API login can call it ----
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq(has_function_privilege('authenticated', 'app.system_import_record(uuid, uuid, uuid, uuid, uuid, jsonb)', 'EXECUTE'), false, 'a signed-in user cannot call the import function');
  PERFORM pg_temp.assert_eq(has_function_privilege('qms_api', 'app.system_import_record(uuid, uuid, uuid, uuid, uuid, jsonb)', 'EXECUTE'), true, 'the API login can');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.import_nonconformance(%L, %L, '{"title": "x", "source": "internal"}'::jsonb)$f$, org, nc)), 5), 'QM022', 'an NC import never updates');

  -- ---- tenancy ----
  PERFORM pg_temp.login(eve);
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.integration_import_settings), 0, 'another organisation sees no settings');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.set_integration_import_settings(%L, 'machine', '{}'::jsonb)$f$, api)), 5), 'P0002', 'nor changes them');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
