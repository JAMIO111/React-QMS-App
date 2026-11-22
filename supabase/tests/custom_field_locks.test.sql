-- Custom field locks: while a schedule is on, a person cannot change a custom field the import's template maps as "source wins" on a record the connection
-- imported (app.set_custom_values refuses it, QM033); the import itself, fields owned by Fortress or under review, unmapped and retired fields, unchanged
-- values, records the import does not own and every state where no schedule runs stay free. The table guard still judges only real columns.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('5f710000-0000-0000-0000-000000000a01', 'ann@cflocks.test'), ('5f710000-0000-0000-0000-000000000a02', 'bob@cflocks.test');

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

-- A person saves custom values (as app.set_custom_values answers them): 'ok' or the error.
CREATE FUNCTION pg_temp.set_values(p_user uuid, p_entity text, p_record uuid, p_values jsonb) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  PERFORM pg_temp.login(p_user);
  v := pg_temp.fails(format('SELECT app.set_custom_values(%L, %L, %L::jsonb)', p_entity, p_record, p_values::text));
  PERFORM pg_temp.logout();
  RETURN v;
END $$;

CREATE FUNCTION pg_temp.stored(p_record uuid) RETURNS jsonb LANGUAGE sql AS $$
  SELECT coalesce((SELECT "values" FROM public.custom_field_values WHERE record_id = p_record), '{}'::jsonb)
$$;

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
  ann uuid := '5f710000-0000-0000-0000-000000000a01'; bob uuid := '5f710000-0000-0000-0000-000000000a02';
  org uuid; api uuid; site uuid; tpl uuid; res jsonb; m uuid; m_hand uuid; v_err text; f_serial uuid; f_notes uuid; f_other uuid; f_bool uuid;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('Custom Locks'); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, bob, 'active');   -- a member with no role at all
  PERFORM pg_temp.give_controller_seat(org, ann);
  INSERT INTO public.sites (organisation_id, code, name) VALUES (org, 'PLANT2', 'Plant 2') RETURNING id INTO site;

  PERFORM pg_temp.login(ann);
  f_serial := app.save_custom_field(org, 'machine', '{"label": "Serial number", "fieldType": "text"}');
  f_notes := app.save_custom_field(org, 'machine', '{"label": "Shop notes", "fieldType": "text"}');
  f_other := app.save_custom_field(org, 'machine', '{"label": "Cell", "fieldType": "text"}');
  f_bool := app.save_custom_field(org, 'machine', '{"label": "Critical", "fieldType": "boolean"}');
  api := app.create_integration_connection(org, 'rest_api', 'ERP', 'erp', '{"baseUrl": "https://erp.example.com", "authType": "none"}'::jsonb);
  PERFORM app.record_integration_connection_test(api, true, 'ok');
  PERFORM app.mark_integration_ready(api);
  PERFORM app.activate_integration_connection(api);
  PERFORM app.set_integration_import_settings(api, 'machine', '{"writeMode": "add_update"}'::jsonb);
  tpl := app.create_integration_template(org, 'machine', 'ERP machines', NULL, jsonb_build_object('keyField', 'Id', 'settings', '{"writeMode": "add_update"}'::jsonb,
    'fields', '[{"target": "code", "source": "Code"}, {"target": "name", "source": "Name"}, {"target": "site", "source": "Site"},
                {"target": "cf_serial_number", "source": "Serial"},
                {"target": "cf_shop_notes", "source": "Notes", "ownership": "qms_wins"},
                {"target": "cf_critical", "source": "Crit"},
                {"target": "cf_not_a_field", "source": "Nothing"}]'::jsonb));
  PERFORM pg_temp.logout();

  -- ---- a record the connection imported, with the schedule still off ----
  res := pg_temp.import_one(org, api, ann, 'machine', 'MC1', jsonb_build_object('code', 'CNC-1', 'name', 'Lathe', 'site', 'PLANT2', 'siteId', site, 'cf_serial_number', 'SN-1', 'cf_shop_notes', 'From ERP'), tpl);
  PERFORM pg_temp.assert_eq(res ->> 'status', 'applied', 'the machine is imported with its custom value');
  m := (res ->> 'internal')::uuid;
  PERFORM pg_temp.assert_eq(pg_temp.stored(m) ->> 'serial_number', 'SN-1', 'the import wrote the custom value');
  PERFORM pg_temp.assert_eq(pg_temp.locked(ann, org, 'machine', m), '', 'nothing is locked while no schedule is on');
  PERFORM pg_temp.assert_eq(pg_temp.set_values(ann, 'machine', m, '{"serial_number": "SN-1 by hand"}'), 'ok', 'so a person can change the custom field');

  -- ---- the schedule goes on ----
  UPDATE public.integration_import_settings SET schedule = 'daily', template_id = tpl WHERE connection_id = api AND entity_type = 'machine';
  PERFORM pg_temp.assert_eq(pg_temp.locked(ann, org, 'machine', m), 'cf_critical,cf_serial_number,code,name,site',
    'source-wins custom fields are locked with the columns; Fortress-wins ones, unmapped ones and keys that are no field are not');
  v_err := pg_temp.set_values(ann, 'machine', m, '{"serial_number": "SN-2"}');
  PERFORM pg_temp.assert_eq(left(v_err, 5), 'QM033', 'a locked custom field cannot be changed');
  PERFORM pg_temp.assert_eq(v_err LIKE '%Managed by ERP%Serial number%', true, 'the message names the connection and the field by its label');
  PERFORM pg_temp.assert_eq(pg_temp.stored(m) ->> 'serial_number', 'SN-1 by hand', 'nothing changed');
  PERFORM pg_temp.login(ann);
  BEGIN
    PERFORM app.set_custom_values('machine', m, '{"serial_number": "SN-2"}'::jsonb);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = PG_EXCEPTION_DETAIL;
  END;
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((v_err::jsonb -> 'fields')::text, '["cf_serial_number"]', 'the detail carries the field as GET /import-locks names it');
  PERFORM pg_temp.assert_eq(v_err::jsonb ->> 'connection', 'ERP', 'and the connection');
  PERFORM pg_temp.assert_eq(left(pg_temp.set_values(ann, 'machine', m, '{"serial_number": null}'), 5), 'QM033', 'clearing a locked custom field is a change too');
  PERFORM pg_temp.assert_eq(left(pg_temp.set_values(ann, 'machine', m, '{"critical": true}'), 5), 'QM033', 'a locked yes / no field is refused');
  PERFORM pg_temp.assert_eq(left(pg_temp.set_values(ann, 'machine', m, '{"shop_notes": "Mine", "serial_number": "SN-3"}'), 5), 'QM033', 'one locked field in a save refuses all of it');
  PERFORM pg_temp.assert_eq(pg_temp.stored(m) ->> 'shop_notes', 'From ERP', 'and the allowed one in the same save is not written either');
  PERFORM pg_temp.assert_eq(pg_temp.set_values(ann, 'machine', m, '{"serial_number": "SN-1 by hand", "shop_notes": "Mine"}'), 'ok', 'an unchanged locked value passes, with a field Fortress owns');
  PERFORM pg_temp.assert_eq(pg_temp.set_values(ann, 'machine', m, '{"serial_number": "  SN-1 by hand  "}'), 'ok', 'a value that is the same once tidied is not a change');
  PERFORM pg_temp.assert_eq(pg_temp.set_values(ann, 'machine', m, '{"cell": "C3"}'), 'ok', 'a custom field the template does not map stays editable');
  PERFORM pg_temp.assert_eq(pg_temp.stored(m) ->> 'shop_notes', 'Mine', 'the edits that were allowed are saved');
  PERFORM pg_temp.assert_eq(left(pg_temp.set_values(ann, 'machine', m, '{"nothing_here": "x"}'), 5), 'QM023', 'an unknown field still says so');

  -- the columns' guard is unchanged by custom fields
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($q$UPDATE public.machines SET name = 'Lathe (again)' WHERE id = %L$q$, m)), 5), 'QM033', 'a locked column is still refused');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$UPDATE public.machines SET description = 'Mine' WHERE id = %L$q$, m)), 'ok', 'an unmapped column is still free (a custom field in the template is not a column)');
  PERFORM pg_temp.logout();

  -- ---- the import is never refused ----
  res := pg_temp.import_one(org, api, ann, 'machine', 'MC1', jsonb_build_object('code', 'CNC-1', 'name', 'Lathe', 'site', 'PLANT2', 'siteId', site, 'cf_serial_number', 'SN-9', 'cf_shop_notes', 'Newer'), tpl);
  PERFORM pg_temp.assert_eq(res ->> 'status', 'applied', 'a scheduled run updates the locked custom field');
  PERFORM pg_temp.assert_eq(pg_temp.stored(m) ->> 'serial_number', 'SN-9', 'the source''s value is written');
  PERFORM pg_temp.assert_eq(pg_temp.stored(m) ->> 'shop_notes', 'Mine', 'and a Fortress-wins field keeps the person''s value');

  -- ---- records the import does not own, and who may ask ----
  PERFORM pg_temp.login(ann);
  INSERT INTO public.machines (organisation_id, code, name) VALUES (org, 'HAND-1', 'Made by hand') RETURNING id INTO m_hand;
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(pg_temp.locked(ann, org, 'machine', m_hand), '', 'a record the import has not linked is free');
  PERFORM pg_temp.assert_eq(pg_temp.set_values(ann, 'machine', m_hand, '{"serial_number": "By hand"}'), 'ok', 'including its custom fields');
  PERFORM pg_temp.assert_eq(pg_temp.locked(bob, org, 'machine', m), '', 'a member who may not read machines is told nothing');
  PERFORM pg_temp.assert_eq(has_function_privilege('authenticated', 'app.integration_locked_internal(uuid, text, uuid)', 'EXECUTE'), false, 'the unchecked rule is still not callable by people');

  -- ---- a system caller (not a signed-in person) is not refused ----
  PERFORM app.write_custom_values('machine', m, org, '{"serial_number": "SN-SQL"}'::jsonb);
  PERFORM pg_temp.assert_eq(pg_temp.stored(m) ->> 'serial_number', 'SN-SQL', 'SQL run as the system writes it (no JWT, no person)');
  PERFORM app.write_custom_values('machine', m, org, '{"serial_number": "SN-9"}'::jsonb);

  -- ---- every way the lock ends ----
  PERFORM pg_temp.login(ann); PERFORM app.pause_integration_connection(api, 'Checking'); PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(pg_temp.locked(ann, org, 'machine', m), '', 'a paused connection unlocks');
  PERFORM pg_temp.assert_eq(pg_temp.set_values(ann, 'machine', m, '{"serial_number": "Paused edit"}'), 'ok', 'and the custom field can be edited');
  UPDATE public.integration_connections SET status = 'active' WHERE id = api;
  PERFORM pg_temp.assert_eq(left(pg_temp.set_values(ann, 'machine', m, '{"serial_number": "Active edit"}'), 5), 'QM033', 'an active connection locks it again');
  UPDATE public.integration_import_settings SET schedule = 'manual' WHERE connection_id = api AND entity_type = 'machine';
  PERFORM pg_temp.assert_eq(pg_temp.set_values(ann, 'machine', m, '{"serial_number": "Manual edit"}'), 'ok', 'a schedule switched off unlocks it');
  UPDATE public.integration_import_settings SET schedule = 'hourly' WHERE connection_id = api AND entity_type = 'machine';
  PERFORM pg_temp.assert_eq(left(pg_temp.set_values(ann, 'machine', m, '{"serial_number": "Hourly edit"}'), 5), 'QM033', 'any schedule locks, not only daily');

  PERFORM pg_temp.login(ann);
  PERFORM app.save_integration_template_version(tpl, jsonb_build_object('keyField', 'Id', 'settings', '{"writeMode": "add_update"}'::jsonb,
    'fields', '[{"target": "code", "source": "Code"}, {"target": "name", "source": "Name"}, {"target": "site", "source": "Site"},
                {"target": "cf_serial_number", "source": "Serial", "ownership": "manual_review"},
                {"target": "cf_critical", "source": "Crit"}]'::jsonb), 'Review the serial number');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(pg_temp.locked(ann, org, 'machine', m), 'cf_critical,code,name,site', 'moving a custom field to review unlocks it at once, before any run');
  PERFORM pg_temp.assert_eq(pg_temp.set_values(ann, 'machine', m, '{"serial_number": "Review edit"}'), 'ok', 'and the person can edit it');

  PERFORM pg_temp.login(ann);
  PERFORM app.retire_custom_field(f_bool, 'No longer used');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(pg_temp.locked(ann, org, 'machine', m), 'code,name,site', 'a retired custom field is not locked');

  PERFORM pg_temp.login(ann);
  PERFORM app.save_integration_template_version(tpl, jsonb_build_object('keyField', 'Id', 'settings', '{"writeMode": "add_only"}'::jsonb,
    'fields', '[{"target": "code", "source": "Code"}, {"target": "cf_serial_number", "source": "Serial"}]'::jsonb), 'Only add');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(pg_temp.locked(ann, org, 'machine', m), '', 'a template that only adds locks nothing, custom fields included');
  PERFORM pg_temp.assert_eq(pg_temp.set_values(ann, 'machine', m, '{"serial_number": "Add-only edit"}'), 'ok', 'and the custom field edits');
END $$;

ROLLBACK;
