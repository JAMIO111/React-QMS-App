-- Import field locks: while a schedule is on, a person cannot change the fields an import owns ("source wins" fields of records the connection
-- imported); the import itself, fields owned by Fortress or under review, unlinked records and every state where no schedule runs stay free.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('5f700000-0000-0000-0000-000000000a01', 'ann@fieldlocks.test'), ('5f700000-0000-0000-0000-000000000a02', 'bob@fieldlocks.test'),
  ('5f700000-0000-0000-0000-000000000a03', 'eve@fieldlocks.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

CREATE FUNCTION pg_temp.locked(p_user uuid, p_org uuid, p_entity text, p_record uuid) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  PERFORM pg_temp.login(p_user);
  SELECT coalesce(string_agg(field, ',' ORDER BY field), '') INTO v FROM app.integration_locked_fields(p_org, p_entity, p_record);
  PERFORM pg_temp.logout();
  RETURN v;
END $$;

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
  PERFORM set_config('app.source', '', true);   -- the engine's marker lasts for its transaction; here the test continues as people
  PERFORM app.system_finish_integration_run(p_org, run, owner);
  SELECT * INTO i FROM public.integration_inbox WHERE run_id = run;
  RETURN jsonb_build_object('status', i.status, 'internal', i.internal_id, 'errors', i.errors, 'action', i.action, 'run', run);
END $$;

DO $$
DECLARE
  ann uuid := '5f700000-0000-0000-0000-000000000a01'; bob uuid := '5f700000-0000-0000-0000-000000000a02'; eve uuid := '5f700000-0000-0000-0000-000000000a03';
  org uuid; org2 uuid; api uuid; site uuid; tpl uuid; tpl_sup uuid; tpl_add uuid; tpl_emp uuid; res jsonb; m uuid; m_hand uuid; s uuid; emp uuid; v_run uuid;
  r record; v_missing text; v_err text;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('Locks Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('Locks Beta'); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, bob, 'active');   -- a member with no role at all
  PERFORM pg_temp.give_controller_seat(org, ann);
  INSERT INTO public.sites (organisation_id, code, name) VALUES (org, 'PLANT2', 'Plant 2') RETURNING id INTO site;

  PERFORM pg_temp.login(ann);
  api := app.create_integration_connection(org, 'rest_api', 'ERP', 'erp', '{"baseUrl": "https://erp.example.com", "authType": "none"}'::jsonb);
  PERFORM app.record_integration_connection_test(api, true, 'ok');
  PERFORM app.mark_integration_ready(api);
  PERFORM app.activate_integration_connection(api);
  PERFORM app.set_integration_import_settings(api, 'machine', '{"writeMode": "add_update"}'::jsonb);
  PERFORM app.set_integration_import_settings(api, 'supplier', '{"writeMode": "add_update"}'::jsonb);
  PERFORM app.set_integration_import_settings(api, 'employee', '{"writeMode": "add_update"}'::jsonb);
  tpl := app.create_integration_template(org, 'machine', 'ERP machines', NULL, jsonb_build_object('keyField', 'Id', 'settings', '{"writeMode": "add_update"}'::jsonb,
    'fields', '[{"target": "code", "source": "Code"}, {"target": "name", "source": "Name"}, {"target": "site", "source": "Site"},
                {"target": "description", "source": "Desc", "ownership": "qms_wins"}, {"target": "workCentre", "source": "WC", "ownership": "manual_review"}]'::jsonb));
  tpl_sup := app.create_integration_template(org, 'supplier', 'ERP suppliers', NULL, jsonb_build_object('keyField', 'Id', 'settings', '{"writeMode": "add_update"}'::jsonb,
    'fields', '[{"target": "code", "source": "Code"}, {"target": "name", "source": "Name"}, {"target": "email", "source": "Mail"}]'::jsonb));
  tpl_add := app.create_integration_template(org, 'machine', 'ERP machines (add only)', NULL, jsonb_build_object('keyField', 'Id', 'settings', '{"writeMode": "add_only"}'::jsonb,
    'fields', '[{"target": "code", "source": "Code"}, {"target": "name", "source": "Name"}]'::jsonb));
  tpl_emp := app.create_integration_template(org, 'employee', 'ERP people', NULL, jsonb_build_object('keyField', 'Id', 'settings', '{"writeMode": "add_update"}'::jsonb,
    'fields', '[{"target": "employeeNumber", "source": "No"}, {"target": "firstName", "source": "First"}]'::jsonb));
  PERFORM pg_temp.logout();

  -- ---- the map and the guard cover the same kinds ----
  FOR r IN SELECT e AS entity FROM unnest(ARRAY['supplier', 'customer', 'part', 'machine', 'employee', 'gauge_type', 'gauge', 'production_order']) e LOOP
    SELECT string_agg(k || '→' || v, ', ') INTO v_missing
      FROM jsonb_each_text(app.integration_field_columns(r.entity)) x (k, v)
     WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = app.integration_lock_table(r.entity) AND c.column_name = x.v);
    PERFORM pg_temp.assert_eq(coalesce(v_missing, ''), '', 'every mapped column of ' || r.entity || ' exists in its table');
    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM pg_trigger t WHERE t.tgname = 'zz_integration_lock_guard' AND NOT t.tgisinternal
      AND t.tgrelid = ('public.' || quote_ident(app.integration_lock_table(r.entity)))::regclass), 1, 'the guard is on ' || r.entity);
  END LOOP;

  -- ---- a record the connection imported, with the schedule still off ----
  res := pg_temp.import_one(org, api, ann, 'machine', 'MC1', jsonb_build_object('code', 'CNC-1', 'name', 'Lathe', 'site', 'PLANT2', 'siteId', site, 'workCentre', 'WC1', 'description', 'First'), tpl);
  PERFORM pg_temp.assert_eq(res ->> 'status', 'applied', 'the machine is imported');
  m := (res ->> 'internal')::uuid;
  PERFORM pg_temp.assert_eq(pg_temp.locked(ann, org, 'machine', m), '', 'nothing is locked while no schedule is on');
  PERFORM pg_temp.login(ann); UPDATE public.machines SET name = 'Lathe (edited)' WHERE id = m; PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT name FROM public.machines WHERE id = m), 'Lathe (edited)', 'so a person can edit it');

  -- ---- the schedule goes on ----
  UPDATE public.integration_import_settings SET schedule = 'daily', template_id = tpl WHERE connection_id = api AND entity_type = 'machine';
  PERFORM pg_temp.assert_eq(pg_temp.locked(ann, org, 'machine', m), 'code,name,site', 'source-wins fields are locked; Fortress-wins and review fields are not');
  PERFORM pg_temp.login(ann);
  v_err := pg_temp.fails(format($q$UPDATE public.machines SET name = 'Lathe (again)' WHERE id = %L$q$, m));
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(left(v_err, 5), 'QM033', 'a locked field cannot be changed');
  PERFORM pg_temp.assert_eq(v_err LIKE '%Managed by ERP%name%', true, 'and the message names the connection and the field');
  PERFORM pg_temp.assert_eq((SELECT name FROM public.machines WHERE id = m), 'Lathe (edited)', 'nothing changed');
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($q$UPDATE public.machines SET code = 'CNC-9', description = 'Changed' WHERE id = %L$q$, m)), 5), 'QM033', 'one locked field in a statement refuses all of it');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($q$UPDATE public.machines SET site_id = NULL WHERE id = %L$q$, m)), 5), 'QM033', 'a link counts by the column it fills');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$UPDATE public.machines SET name = name, description = 'Mine' WHERE id = %L$q$, m)), 'ok', 'an unchanged locked value passes (forms send every field)');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$UPDATE public.machines SET work_centre = 'WC9' WHERE id = %L$q$, m)), 'ok', 'a field under review stays editable');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT description || '/' || work_centre FROM public.machines WHERE id = m), 'Mine/WC9', 'the edits that were allowed are saved');

  -- ---- the import is never refused ----
  res := pg_temp.import_one(org, api, ann, 'machine', 'MC1', jsonb_build_object('code', 'CNC-1', 'name', 'Lathe ERP', 'site', 'PLANT2', 'siteId', site, 'workCentre', 'WC1', 'description', 'Second'), tpl);
  PERFORM pg_temp.assert_eq(res ->> 'status', 'applied', 'a scheduled run updates the locked fields');
  PERFORM pg_temp.assert_eq((SELECT name FROM public.machines WHERE id = m), 'Lathe ERP', 'the source''s value is written');

  -- ---- records the import does not own ----
  PERFORM pg_temp.login(ann);
  INSERT INTO public.machines (organisation_id, code, name) VALUES (org, 'HAND-1', 'Made by hand') RETURNING id INTO m_hand;
  UPDATE public.machines SET name = 'Hand edit' WHERE id = m_hand;
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(pg_temp.locked(ann, org, 'machine', m_hand), '', 'a record the import has not linked is free');

  -- ---- who may ask ----
  PERFORM pg_temp.assert_eq(pg_temp.locked(bob, org, 'machine', m), '', 'a member who may not read machines is told nothing');
  PERFORM pg_temp.assert_eq(pg_temp.locked(eve, org, 'machine', m), '', 'a member of another organisation is told nothing');
  PERFORM pg_temp.assert_eq(pg_temp.locked(eve, org2, 'machine', m), '', 'and asking in her own organisation finds no such record');
  PERFORM pg_temp.assert_eq(pg_temp.locked(ann, org, 'nonconformance', m), '', 'a kind that is never locked answers nothing');
  PERFORM pg_temp.assert_eq(has_function_privilege('anon', 'app.integration_locked_fields(uuid, text, uuid)', 'EXECUTE'), false, 'nobody signed out can ask');
  PERFORM pg_temp.assert_eq(has_function_privilege('authenticated', 'app.integration_locked_internal(uuid, text, uuid)', 'EXECUTE'), false, 'the unchecked rule is not callable by people');

  -- ---- every way the lock ends ----
  PERFORM pg_temp.login(ann); PERFORM app.pause_integration_connection(api, 'Checking'); PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(pg_temp.locked(ann, org, 'machine', m), '', 'a paused connection unlocks');
  UPDATE public.integration_connections SET status = 'active' WHERE id = api;
  PERFORM pg_temp.assert_eq(pg_temp.locked(ann, org, 'machine', m), 'code,name,site', 'and an active one locks again');
  UPDATE public.integration_import_settings SET schedule = 'manual' WHERE connection_id = api AND entity_type = 'machine';
  PERFORM pg_temp.assert_eq(pg_temp.locked(ann, org, 'machine', m), '', 'a schedule switched off unlocks');
  UPDATE public.integration_import_settings SET schedule = 'every_15m' WHERE connection_id = api AND entity_type = 'machine';
  PERFORM pg_temp.assert_eq(pg_temp.locked(ann, org, 'machine', m), 'code,name,site', 'any schedule locks, not only daily');

  UPDATE public.integration_import_settings SET template_id = tpl_add WHERE connection_id = api AND entity_type = 'machine';
  PERFORM pg_temp.assert_eq(pg_temp.locked(ann, org, 'machine', m), '', 'a template that only adds never updates, so nothing is locked');
  UPDATE public.integration_import_settings SET write_mode = 'update_only' WHERE connection_id = api AND entity_type = 'machine';
  PERFORM pg_temp.assert_eq(pg_temp.locked(ann, org, 'machine', m), '', 'the connection''s own write mode does not matter: the template''s decides');
  UPDATE public.integration_import_settings SET template_id = tpl WHERE connection_id = api AND entity_type = 'machine';
  PERFORM pg_temp.assert_eq(pg_temp.locked(ann, org, 'machine', m), 'code,name,site', 'back to the first template, which updates, whatever the connection says');
  UPDATE public.integration_import_settings SET write_mode = 'add_only' WHERE connection_id = api AND entity_type = 'machine';
  PERFORM pg_temp.assert_eq(pg_temp.locked(ann, org, 'machine', m), 'code,name,site', 'even when the connection''s own setting only adds');
  PERFORM pg_temp.login(ann);
  PERFORM app.save_integration_template_version(tpl, jsonb_build_object('keyField', 'Id', 'settings', '{"writeMode": "add_update"}'::jsonb,
    'fields', '[{"target": "code", "source": "Code"}, {"target": "name", "source": "Name", "ownership": "qms_wins"}, {"target": "site", "source": "Site"},
                {"target": "description", "source": "Desc", "ownership": "qms_wins"}]'::jsonb), 'Fortress owns the name now');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(pg_temp.locked(ann, org, 'machine', m), 'code,site', 'moving a field to Fortress wins unlocks it at once, before any run');
  PERFORM pg_temp.login(ann); UPDATE public.machines SET name = 'Lathe by hand' WHERE id = m; PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT name FROM public.machines WHERE id = m), 'Lathe by hand', 'and the person can edit it');
  PERFORM pg_temp.login(ann); PERFORM app.archive_integration_template(tpl, 'Not used any more'); PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(pg_temp.locked(ann, org, 'machine', m), '', 'an archived template runs nothing, so nothing is locked');
  UPDATE public.integration_import_settings SET template_id = NULL WHERE connection_id = api AND entity_type = 'machine';
  PERFORM pg_temp.assert_eq(pg_temp.locked(ann, org, 'machine', m), '', 'a schedule with no template locks nothing');

  -- ---- another kind with its own table (suppliers) and the capitalised employees table ----
  res := pg_temp.import_one(org, api, ann, 'supplier', 'S1', jsonb_build_object('code', 'ACME', 'name', 'Acme', 'email', 'a@acme.test'), tpl_sup);
  s := (res ->> 'internal')::uuid;
  UPDATE public.integration_import_settings SET schedule = 'hourly', template_id = tpl_sup WHERE connection_id = api AND entity_type = 'supplier';
  PERFORM pg_temp.assert_eq(pg_temp.locked(ann, org, 'supplier', s), 'code,email,name', 'suppliers lock their mapped fields');
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($q$UPDATE public.suppliers SET email = 'b@acme.test' WHERE id = %L$q$, s)), 5), 'QM033', 'and refuse a change');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$UPDATE public.suppliers SET notes = 'Ours' WHERE id = %L$q$, s)), 'ok', 'but not one the template does not map');
  PERFORM pg_temp.logout();

  INSERT INTO public."Employees" (organisation_id, employee_number, first_name, surname) VALUES (org, 'E-1', 'Ada', 'Lovelace') RETURNING id INTO emp;
  SELECT (res ->> 'run')::uuid INTO v_run;
  INSERT INTO public.integration_external_records (organisation_id, connection_id, entity_type, external_id, internal_id, content_hash, first_run_id, last_run_id)
  VALUES (org, api, 'employee', 'EMP-1', emp, 'x', v_run, v_run);
  UPDATE public.integration_import_settings SET schedule = 'daily', template_id = tpl_emp WHERE connection_id = api AND entity_type = 'employee';
  PERFORM pg_temp.assert_eq(pg_temp.locked(ann, org, 'employee', emp), 'employeeNumber,firstName', 'employees (a capitalised table) lock their mapped fields');
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($q$UPDATE public."Employees" SET first_name = 'Augusta' WHERE id = %L$q$, emp)), 5), 'QM033', 'and refuse a change');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$UPDATE public."Employees" SET job_title = 'Mathematician' WHERE id = %L$q$, emp)), 'ok', 'but not an unmapped one');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
