-- Integrations IN8: daily schedules (who they act for, once a day, never beside a running import), records that disappeared from a full read
-- (listed, guarded "make inactive", held for a person, decided, returned), ignoring rejected rows, and the health summary.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('5f000000-0000-0000-0000-000000000a01', 'ann@sched.test'), ('5f000000-0000-0000-0000-000000000a02', 'bob@sched.test'), ('5f000000-0000-0000-0000-000000000a03', 'eve@sched.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;
CREATE FUNCTION pg_temp.assert_true(p boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p IS NOT TRUE THEN RAISE EXCEPTION 'FAILED: %', label; END IF; END $$;

-- A finished full read of suppliers that saw the given source ids (each applied), plus optionally a row rejected without an identifier.
CREATE FUNCTION pg_temp.full_read(p_org uuid, p_conn uuid, p_seen text[], p_on_missing text, p_no_id boolean DEFAULT false) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v_run uuid; x text;
BEGIN
  INSERT INTO public.integration_sync_runs (organisation_id, connection_id, entity_type, kind, status, fetch_done, requested_by, settings, finished_at)
  VALUES (p_org, p_conn, 'supplier', 'full', 'running', true, '5f000000-0000-0000-0000-000000000a01', jsonb_build_object('onMissing', p_on_missing), NULL)
  RETURNING id INTO v_run;
  FOREACH x IN ARRAY p_seen LOOP
    INSERT INTO public.integration_inbox (organisation_id, connection_id, run_id, entity_type, external_id, status, last_run_id)
    VALUES (p_org, p_conn, v_run, 'supplier', x, 'unchanged', v_run);
  END LOOP;
  IF p_no_id THEN
    INSERT INTO public.integration_inbox (organisation_id, connection_id, run_id, entity_type, external_id, status, last_run_id, errors)
    VALUES (p_org, p_conn, v_run, 'supplier', NULL, 'rejected', v_run, '[{"field": null, "message": "No identifier"}]');
  END IF;
  UPDATE public.integration_sync_runs SET status = CASE WHEN p_no_id THEN 'partial' ELSE 'succeeded' END, finished_at = now(), unchanged = cardinality(p_seen) WHERE id = v_run;
  PERFORM app.integration_detect_missing(v_run);
  RETURN v_run;
END $$;

DO $$
DECLARE
  ann uuid := '5f000000-0000-0000-0000-000000000a01'; bob uuid := '5f000000-0000-0000-0000-000000000a02'; eve uuid := '5f000000-0000-0000-0000-000000000a03';
  org uuid; org2 uuid; r_viewer uuid; rest uuid; csv uuid; tpl uuid; tpl_c uuid; seed_run uuid; run uuid; res jsonb; sup uuid[] := '{}'; s uuid; i integer;
  held uuid[]; bad uuid; v jsonb;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('Sched Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('Sched Beta'); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, bob, 'active');
  SELECT id INTO r_viewer FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, ou.id, r_viewer FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id = bob;
  PERFORM pg_temp.give_controller_seat(org, ann);
  PERFORM pg_temp.give_controller_seat(org2, eve);

  PERFORM pg_temp.login(ann);
  rest := app.create_integration_connection(org, 'rest_api', 'ERP', 'erp', '{"baseUrl": "https://erp.example.com/api", "authType": "none",
            "entities": {"supplier": {"path": "/v1/suppliers", "incremental": {"param": "since", "field": "updatedAt"}}, "customer": {"path": "/v1/customers"}}}'::jsonb);
  PERFORM app.record_integration_connection_test(rest, true, 'ok');
  PERFORM app.mark_integration_ready(rest);
  PERFORM app.activate_integration_connection(rest);
  csv := app.create_integration_connection(org, 'csv', 'Files', 'files', '{}'::jsonb);
  tpl := app.create_integration_template(org, 'supplier', 'ERP suppliers', NULL, '{"keyField": "id", "fields": [{"target": "code", "source": "code"}, {"target": "name", "source": "name"}], "settings": {"writeMode": "add_update", "matchExisting": false}}'::jsonb);
  tpl_c := app.create_integration_template(org, 'customer', 'ERP customers', NULL, '{"keyField": "id", "fields": [{"target": "code", "source": "code"}, {"target": "name", "source": "name"}]}'::jsonb);

  -- ---- schedule settings ----
  PERFORM pg_temp.assert_true(pg_temp.fails(format($f$SELECT app.set_integration_import_settings(%L, 'supplier', '{"schedule": "daily"}')$f$, csv)) LIKE 'QM022%cannot run on a schedule%', 'a file connection cannot be scheduled');
  PERFORM pg_temp.assert_true(pg_temp.fails(format($f$SELECT app.set_integration_import_settings(%L, 'supplier', '{"schedule": "daily"}')$f$, rest)) LIKE 'QM022%template%', 'a schedule needs a template');
  PERFORM pg_temp.assert_true(pg_temp.fails(format($f$SELECT app.set_integration_import_settings(%L, 'part', %L)$f$, rest, jsonb_build_object('schedule', 'daily', 'templateId', tpl))) LIKE 'QM022%', 'only kinds the connection says where to read, with a template for that kind');
  PERFORM pg_temp.assert_true(pg_temp.fails(format($f$SELECT app.set_integration_import_settings(%L, 'customer', %L)$f$, rest, jsonb_build_object('templateId', tpl))) LIKE 'QM022%another kind%', 'a template for another kind of record is refused');
  PERFORM pg_temp.assert_true(pg_temp.fails(format($f$SELECT app.set_integration_import_settings(%L, 'goods_receipt', '{"onMissing": "list"}')$f$, rest)) LIKE 'QM022%events%', 'records of events do not track disappearing');
  PERFORM app.set_integration_import_settings(rest, 'supplier', jsonb_build_object('schedule', 'daily', 'templateId', tpl, 'onMissing', 'deactivate'));
  PERFORM pg_temp.assert_eq((SELECT schedule_set_by FROM public.integration_import_settings WHERE connection_id = rest AND entity_type = 'supplier'), ann, 'the person who switched the schedule on is recorded');
  PERFORM app.set_integration_import_settings(rest, 'customer', jsonb_build_object('schedule', 'daily', 'templateId', tpl_c));
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.set_integration_import_settings(%L, 'supplier', '{"schedule": "manual"}')$f$, rest)), 5), '42501', 'a viewer cannot change the schedule');
  PERFORM pg_temp.logout();

  -- ---- the daily scheduler ----
  PERFORM pg_temp.assert_eq(has_function_privilege('authenticated', 'app.system_schedule_integration_runs(date)', 'EXECUTE'), false, 'people cannot call the scheduler');
  res := app.system_schedule_integration_runs(current_date);
  PERFORM pg_temp.assert_eq(jsonb_array_length(res), 2, 'both scheduled imports are asked for');
  SELECT id INTO run FROM public.integration_sync_runs WHERE connection_id = rest AND entity_type = 'supplier' AND trigger = 'schedule';
  PERFORM pg_temp.assert_true((SELECT kind = 'full' AND requested_by = ann AND template_version_id IS NOT NULL AND settings ->> 'writeMode' = 'add_update'
                               FROM public.integration_sync_runs WHERE id = run), 'a full read (no cursor yet), as the person who scheduled it, with the template''s settings');
  PERFORM pg_temp.assert_eq(jsonb_array_length(app.system_schedule_integration_runs(current_date)), 0, 'not asked for twice in a day');
  res := app.system_schedule_integration_runs(current_date + 1);
  PERFORM pg_temp.assert_true(res @> '[{"entityType": "supplier", "runId": null, "skipped": "An earlier import is still running; it carries on"}]', 'a run still waiting is carried on, not duplicated');
  UPDATE public.integration_sync_runs SET status = 'succeeded', finished_at = now(), fetch_done = true WHERE connection_id = rest AND status IN ('queued', 'running');
  INSERT INTO public.integration_sync_cursors (organisation_id, connection_id, entity_type, cursor, run_id) VALUES (org, rest, 'supplier', '{"w":"2026-11-01"}', run);
  res := app.system_schedule_integration_runs(current_date + 2);
  PERFORM pg_temp.assert_true((SELECT kind = 'incremental' AND cursor_start = '{"w":"2026-11-01"}' FROM public.integration_sync_runs
                                WHERE connection_id = rest AND entity_type = 'supplier' AND status = 'queued'), 'incremental once a cursor exists and the connection says how');
  PERFORM pg_temp.assert_true((SELECT kind = 'full' FROM public.integration_sync_runs WHERE connection_id = rest AND entity_type = 'customer' AND status = 'queued'), 'full when the connection gives no incremental parameter');
  UPDATE public.integration_sync_runs SET status = 'cancelled', cancel_reason = 'test' WHERE connection_id = rest AND status IN ('queued', 'running');
  -- The person who scheduled it loses the right to run imports: nothing is asked for, and the reason is kept.
  UPDATE public.organisation_users SET status = 'suspended' WHERE organisation_id = org AND user_id = ann;
  res := app.system_schedule_integration_runs(current_date + 3);
  PERFORM pg_temp.assert_true(res @> '[{"entityType": "supplier", "runId": null}]', 'no run when the scheduler may no longer import');
  PERFORM pg_temp.assert_true((SELECT last_schedule_problem LIKE '%may no longer run this import%' FROM public.integration_import_settings WHERE connection_id = rest AND entity_type = 'supplier'), 'and the reason is kept on the settings');
  UPDATE public.organisation_users SET status = 'active' WHERE organisation_id = org AND user_id = ann;

  -- ---- records that disappeared ----
  INSERT INTO public.integration_sync_runs (organisation_id, connection_id, entity_type, kind, status, fetch_done, requested_by)
  VALUES (org, rest, 'supplier', 'full', 'succeeded', true, ann) RETURNING id INTO seed_run;
  FOR i IN 1 .. 10 LOOP
    INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'S' || i, 'Supplier ' || i) RETURNING id INTO s;
    sup := sup || s;
    INSERT INTO public.integration_external_records (organisation_id, connection_id, entity_type, external_id, internal_id, content_hash, first_run_id, last_run_id)
    VALUES (org, rest, 'supplier', 'S' || i, s, 'h', seed_run, seed_run);
  END LOOP;

  -- one of ten missing (10%): made inactive at once
  run := pg_temp.full_read(org, rest, ARRAY['S2','S3','S4','S5','S6','S7','S8','S9','S10'], 'deactivate');
  PERFORM pg_temp.assert_eq((SELECT active FROM public.suppliers WHERE id = sup[1]), false, 'a record that disappeared is made inactive');
  PERFORM pg_temp.assert_eq((SELECT missing ->> 'deactivated' FROM public.integration_sync_runs WHERE id = run), '1', 'and the run says so');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_missing_records WHERE internal_id = sup[1]), 'deactivated', 'it is on record');

  -- three more missing (3 of 10 > 20%): held for a person, nothing changed
  run := pg_temp.full_read(org, rest, ARRAY['S5','S6','S7','S8','S9','S10'], 'deactivate');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.integration_missing_records WHERE detected_run_id = run AND status = 'held'), 3, 'too many at once are held');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.suppliers WHERE id = ANY (sup[2:4]) AND active), 3, 'and stay active');
  PERFORM pg_temp.assert_true((SELECT missing ->> 'heldReason' LIKE '3 of 10%' FROM public.integration_sync_runs WHERE id = run), 'with the reason');
  -- the same read again does not list them twice
  run := pg_temp.full_read(org, rest, ARRAY['S5','S6','S7','S8','S9','S10'], 'deactivate');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.integration_missing_records WHERE status = 'held'), 3, 'an open entry is not repeated');
  -- a read with a row that has no identifier calls nothing missing
  run := pg_temp.full_read(org, rest, ARRAY['S10'], 'deactivate', true);
  PERFORM pg_temp.assert_true((SELECT missing ? 'skipped' FROM public.integration_sync_runs WHERE id = run), 'a row without an identifier stops the check');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.integration_missing_records WHERE detected_run_id = run), 0, 'and nothing is listed from it');
  -- a record that comes back is marked returned
  run := pg_temp.full_read(org, rest, ARRAY['S4','S5','S6','S7','S8','S9','S10'], 'deactivate');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_missing_records WHERE internal_id = sup[4]), 'returned', 'a record sent again is returned');

  SELECT array_agg(id) INTO held FROM public.integration_missing_records WHERE status = 'held';
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.decide_missing_records(%L, true, NULL)$f$, held)), 5), '42501', 'a viewer cannot decide');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.decide_missing_records(%L, true, NULL)$f$, held)), 5), 'P0002', 'nor another organisation');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_true(pg_temp.fails(format($f$SELECT app.decide_missing_records(%L, false, NULL)$f$, held)) LIKE 'QM022%why%', 'keeping them active needs a reason');
  PERFORM pg_temp.assert_eq(app.decide_missing_records(held[1:1], false, 'Still buying from them'), 1, 'kept with a reason');
  PERFORM pg_temp.assert_eq(app.decide_missing_records(held[2:2], true, NULL), 1, 'or made inactive');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.integration_missing_records WHERE id = ANY (held[1:2]) AND decided_by = ann), 2, 'the decision names who made it');
  PERFORM pg_temp.assert_true(pg_temp.fails(format($f$SELECT app.decide_missing_records(%L, true, NULL)$f$, held[1:1])) LIKE 'QM022%already%', 'a decision is final');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$UPDATE public.integration_missing_records SET status = 'kept' WHERE id = %L$f$, held[3])), 5), '42501', 'no table writes');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT active FROM public.suppliers s JOIN public.integration_missing_records m ON m.internal_id = s.id WHERE m.id = held[2]), false, 'the record made inactive by a person');
  PERFORM pg_temp.assert_true(pg_temp.fails(format($f$DELETE FROM public.integration_missing_records WHERE id = %L$f$, held[1])) LIKE 'QM022%kept%', 'disappeared records are never deleted');
  -- a record a person kept is not asked about again by the next read that still leaves it out
  run := pg_temp.full_read(org, rest, ARRAY['S4','S5','S6','S7','S8','S9','S10'], 'deactivate');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.integration_missing_records m WHERE m.detected_run_id = run
                              AND m.internal_id = (SELECT internal_id FROM public.integration_missing_records WHERE id = held[1])), 0, 'a kept record is not flagged again');

  -- listing only: nothing is made inactive
  UPDATE public.integration_missing_records SET status = 'kept', decided_at = now(), decision_note = 'test' WHERE status IN ('listed', 'held');
  run := pg_temp.full_read(org, rest, ARRAY['S10'], 'list');
  PERFORM pg_temp.assert_true((SELECT (missing ->> 'listed')::int > 0 AND (missing ->> 'deactivated')::int = 0 FROM public.integration_sync_runs WHERE id = run), 'listing changes nothing');
  PERFORM pg_temp.assert_eq((SELECT active FROM public.suppliers WHERE id = sup[9]), true, 'a listed record stays active');

  -- ---- ignoring rejected rows ----
  INSERT INTO public.integration_inbox (organisation_id, connection_id, run_id, entity_type, external_id, status, last_run_id, errors)
  VALUES (org, rest, run, 'supplier', 'S99', 'rejected', run, '[{"field": "code", "message": "Code is required"}]') RETURNING id INTO bad;
  PERFORM pg_temp.assert_true(bad IN (SELECT app.integration_rows_needing_action(rest, 'supplier')), 'a rejected row needs a person');
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.ignore_integration_rows(%L, ARRAY[%L]::uuid[], 'Test row')$f$, rest, bad)), 5), '42501', 'a viewer cannot ignore rows');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_true(pg_temp.fails(format($f$SELECT app.ignore_integration_rows(%L, ARRAY[%L]::uuid[], 'x')$f$, rest, bad)) LIKE 'QM022%why%', 'ignoring needs a reason');
  PERFORM pg_temp.assert_true(pg_temp.fails(format($f$SELECT app.ignore_integration_rows(%L, ARRAY[%L]::uuid[], 'Wrong')$f$, csv, bad)) LIKE 'QM022%', 'only rows of that connection');
  PERFORM pg_temp.assert_eq(app.ignore_integration_rows(rest, ARRAY[bad], 'A test supplier the ERP should not send'), 1, 'ignored');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_true(NOT (bad IN (SELECT app.integration_rows_needing_action(rest, 'supplier'))), 'an ignored row needs nobody');
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq(app.restore_integration_rows(rest, ARRAY[bad]), 1, 'and can be brought back');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_inbox WHERE id = bad), 'rejected', 'as it was');

  -- ---- health ----
  v := app.integration_health(org);
  PERFORM pg_temp.assert_true(v @> jsonb_build_array(jsonb_build_object('connectionId', rest, 'entityType', 'supplier', 'schedule', 'daily', 'rowsNeedingAction', 1)), 'health shows the schedule and what needs a person');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.integration_health(%L)$f$, org)), 5), '42501', 'health needs integrations.read');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.integration_health(%L)$f$, org)), 5), 'P0002', 'and the organisation');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.integration_missing_records), 0, 'another organisation sees no disappeared records');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
