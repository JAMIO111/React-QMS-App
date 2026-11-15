-- Connector agent AG4 (docs/connector-agent-plan.md): incremental reads by a changed column (the mark read from, the mark reached, kept across a
-- restart, moved only when the run finishes), schedules every few minutes for a database connection (not beside a running import, not while the
-- agent is offline), jobs failed when the agent stops answering, and the agent in the health list.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

CREATE FUNCTION pg_temp.assert_true(p boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p IS NOT TRUE THEN RAISE EXCEPTION 'FAILED: %', label; END IF; END $$;
CREATE FUNCTION pg_temp.assert_false(p boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p IS NOT FALSE THEN RAISE EXCEPTION 'FAILED: %', label; END IF; END $$;
CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;
CREATE FUNCTION pg_temp.api(stmt text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  PERFORM set_config('role', 'qms_api', true);
  BEGIN EXECUTE stmt INTO r;
  EXCEPTION WHEN OTHERS THEN PERFORM set_config('role', 'postgres', true); RAISE; END;
  PERFORM set_config('role', 'postgres', true);
  RETURN r;
END $$;
CREATE FUNCTION pg_temp.h(t text) RETURNS text LANGUAGE sql AS $$ SELECT encode(sha256(convert_to(t, 'UTF8')), 'hex') $$;
CREATE FUNCTION pg_temp.agent_does(p_agent uuid, p_action text, p_payload jsonb DEFAULT '{}') RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE r jsonb; v_job uuid;
BEGIN
  r := pg_temp.api(format('SELECT app.system_agent_next_job(%L, 60)', p_agent));
  IF r IS NULL THEN RAISE EXCEPTION 'FAILED: no job for the agent'; END IF;
  v_job := (r ->> 'id')::uuid;
  PERFORM pg_temp.api(format($f$SELECT app.system_agent_job_report(%L, %L, 'ack', '{}')$f$, p_agent, v_job));
  PERFORM pg_temp.api(format($f$SELECT app.system_agent_job_report(%L, %L, %L, %L)$f$, p_agent, v_job, p_action, p_payload));
  RETURN v_job;
END $$;

INSERT INTO auth.users (id, email) VALUES ('af000000-0000-0000-0000-000000000001', 'own@ag4.test');

DO $$
DECLARE
  own uuid := 'af000000-0000-0000-0000-000000000001';
  org uuid; agent uuid; kid uuid; conn uuid; rest uuid; tpl uuid; run uuid; job uuid; r jsonb; t text; res jsonb; owner uuid := gen_random_uuid();
  cfg jsonb := '{"engine": "postgres", "server": "erp-db", "port": 5432, "database": "erp", "authType": "password"}';
  src jsonb := '{"schema": "erp", "object": "machines", "keyColumn": "id", "columns": ["id", "code", "changed"], "changedColumn": "changed"}';
  sealed jsonb := jsonb_build_object('epk', repeat('A', 88) || '==', 'iv', repeat('B', 16), 'ct', repeat('C', 64));
BEGIN
  PERFORM pg_temp.login(own); org := app.create_organisation('AG4 Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.give_controller_seat(org, own);
  PERFORM pg_temp.login(own); PERFORM app.create_agent_registration(org, pg_temp.h('tok-4'), 'Newcastle'); PERFORM pg_temp.logout();
  agent := (pg_temp.api(format($f$SELECT app.system_register_agent(%L, %L, %L, '0.4.0', 'Windows', 'ERP01', '{}', NULL)$f$, pg_temp.h('tok-4'), repeat('A', 88), repeat('B', 88))) ->> 'agentId')::uuid;
  SELECT id INTO kid FROM public.integration_agent_keys WHERE agent_id = agent AND status = 'active';
  PERFORM pg_temp.login(own);
  conn := app.create_agent_connection(org, agent, 'ERP database', 'erp', cfg);
  rest := app.create_integration_connection(org, 'rest_api', 'ERP API', 'erp-api', '{"baseUrl": "https://erp.example.com/api", "authType": "bearer", "entities": {"machine": {"path": "/machines"}}}');
  PERFORM app.set_agent_credential(conn, sealed, kid);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.agent_does(agent, 'complete', '{"result": {"stored": true}}');
  PERFORM pg_temp.login(own); PERFORM app.request_connection_job(conn, 'test_connection'); PERFORM pg_temp.logout();
  PERFORM pg_temp.agent_does(agent, 'complete', '{"result": {"ok": true, "message": "Signed in"}}');
  PERFORM pg_temp.login(own);
  PERFORM app.mark_integration_ready(conn);
  PERFORM app.activate_integration_connection(conn);

  -- ---- the changed column on a source ----
  t := pg_temp.fails(format('SELECT app.set_integration_record_source(%L, ''machine'', %L)', conn, src || '{"columns": ["id", "code"]}'));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%shows when a row changed too%', 'the changed column is read too: ' || t);
  PERFORM app.set_integration_record_source(conn, 'machine', src - 'changedColumn');
  t := pg_temp.fails(format('SELECT app.request_integration_run(%L, ''machine'', ''incremental'')', conn));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%which column shows when a row changed%', 'incremental needs the changed column: ' || t);
  PERFORM app.set_integration_record_source(conn, 'machine', src);

  -- ---- a full read sets the mark; an incremental read starts from it ----
  tpl := app.create_integration_template(org, 'machine', 'ERP machines', NULL,
    '{"keyField": "id", "fields": [{"target": "code", "source": "code"}, {"target": "name", "source": "code"}], "settings": {"writeMode": "add_update"}}'::jsonb);
  run := app.request_integration_run(conn, 'machine', 'full', NULL, tpl);
  r := (SELECT spec -> 'request' FROM public.integration_agent_jobs WHERE run_id = run);
  PERFORM pg_temp.assert_eq(r ->> 'changedColumn', 'changed', 'the job names the changed column');
  PERFORM pg_temp.assert_false(r ? 'changedSince', 'a full read reads everything');
  PERFORM pg_temp.logout();
  r := pg_temp.api(format('SELECT app.system_agent_next_job(%L, 60)', agent));
  job := (r ->> 'id')::uuid;
  PERFORM pg_temp.api(format($f$SELECT app.system_agent_store_batch(%L, %L, 0, %L, '2', '[{"id": 1, "code": "M1", "changed": "2026-11-01T08:00:00"}, {"id": 2, "code": "M2", "changed": "2026-11-03T08:00:00"}]', '2026-11-03T08:00:00')$f$, agent, job, repeat('a', 64)));
  PERFORM pg_temp.assert_eq((SELECT progress ->> 'changedUpTo' FROM public.integration_agent_jobs WHERE id = job), '2026-11-03T08:00:00', 'the mark reached is kept as the agent goes');
  -- the agent restarts: the job taken again carries the mark on
  PERFORM pg_temp.api(format($f$SELECT app.system_agent_job_report(%L, %L, 'fail', '{"kind": "network", "message": "reset", "transient": true}')$f$, agent, job));
  r := pg_temp.api(format('SELECT app.system_agent_next_job(%L, 60)', agent));
  PERFORM pg_temp.assert_eq(r -> 'resume' ->> 'changedUpTo', '2026-11-03T08:00:00', 'a job taken again carries the mark on');
  PERFORM pg_temp.api(format($f$SELECT app.system_agent_store_batch(%L, %L, 1, %L, '3', '[{"id": 3, "code": "M3", "changed": "2026-11-05T08:00:00"}]', '2026-11-05T08:00:00')$f$, agent, job, repeat('b', 64)));
  PERFORM pg_temp.api(format($f$SELECT app.system_agent_job_report(%L, %L, 'complete', '{"result": {"batches": 2, "rows": 3, "changedUpTo": "2026-11-05T08:00:00"}}')$f$, agent, job));
  PERFORM pg_temp.assert_eq((SELECT result ->> 'changedUpTo' FROM public.integration_agent_jobs WHERE id = job), '2026-11-05T08:00:00', 'the completed job keeps the mark');
  r := pg_temp.api(format('SELECT app.system_lease_integration_run(%L, %L, %L, 60)', org, run, owner));
  PERFORM pg_temp.assert_eq(r -> 'agent' ->> 'changedColumn', 'changed', 'the engine is told the changed column');
  PERFORM pg_temp.assert_eq(r -> 'agent' ->> 'changedUpTo', '2026-11-05T08:00:00', 'and the mark reached');
  -- as the engine would: the last page's cursor is the mark, and finishing the run moves it into the cursors
  UPDATE public.integration_sync_runs SET cursor_next = '{"w": "2026-11-05T08:00:00"}', fetch_done = true WHERE id = run;
  PERFORM pg_temp.api(format('SELECT to_jsonb(app.system_finish_integration_run(%L, %L, %L))', org, run, owner));
  PERFORM pg_temp.assert_eq((SELECT cursor FROM public.integration_sync_cursors WHERE connection_id = conn AND entity_type = 'machine'), '{"w": "2026-11-05T08:00:00"}', 'the mark is kept once the run finishes');
  PERFORM pg_temp.login(own);
  run := app.request_integration_run(conn, 'machine', 'incremental', NULL, tpl);
  PERFORM pg_temp.assert_eq((SELECT spec -> 'request' ->> 'changedSince' FROM public.integration_agent_jobs WHERE run_id = run), '2026-11-05T08:00:00', 'an incremental read starts at the mark');
  PERFORM app.cancel_integration_run(run, 'Test over');

  -- ---- schedules ----
  t := pg_temp.fails(format('SELECT app.set_integration_import_settings(%L, ''machine'', %L)', rest, jsonb_build_object('schedule', 'every_5m', 'templateId', tpl)));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%only a database connection runs every few minutes%', 'an API connection runs daily at most: ' || t);
  t := pg_temp.fails(format('SELECT app.set_integration_import_settings(%L, ''part'', %L)', conn, '{"schedule": "every_5m"}'));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%table these records are read from%', 'a schedule needs the table: ' || t);
  t := pg_temp.fails(format('SELECT app.set_integration_import_settings(%L, ''machine'', %L)', conn, '{"schedule": "every_minute"}'));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%every 5, 15 or 60 minutes%', 'only the listed intervals');
  PERFORM app.set_integration_import_settings(conn, 'machine', jsonb_build_object('schedule', 'every_5m', 'templateId', tpl));
  PERFORM pg_temp.assert_eq((SELECT schedule_set_by FROM public.integration_import_settings WHERE connection_id = conn AND entity_type = 'machine'), own, 'it runs as whoever scheduled it');
  PERFORM pg_temp.logout();

  -- the agent is offline: no run, the schedule says why
  UPDATE public.integration_agents SET last_heartbeat_at = now() - interval '10 minutes' WHERE id = agent;
  res := pg_temp.api('SELECT app.system_schedule_integration_runs(current_date, false)');
  PERFORM pg_temp.assert_true(res -> 0 ->> 'skipped' LIKE '%agent is offline%', 'not while the agent is offline: ' || res::text);
  PERFORM pg_temp.assert_true((SELECT last_schedule_problem LIKE '%offline%' FROM public.integration_import_settings WHERE connection_id = conn AND entity_type = 'machine'), 'and the schedule says so');
  -- online again, after the interval: an incremental run with its extraction
  UPDATE public.integration_agents SET last_heartbeat_at = now() WHERE id = agent;
  UPDATE public.integration_import_settings SET last_scheduled_at = now() - interval '6 minutes' WHERE connection_id = conn AND entity_type = 'machine';
  res := pg_temp.api('SELECT app.system_schedule_integration_runs(current_date, false)');
  run := (res -> 0 ->> 'runId')::uuid;
  PERFORM pg_temp.assert_true(run IS NOT NULL, 'a run is asked for: ' || res::text);
  PERFORM pg_temp.assert_eq((SELECT kind || '/' || trigger FROM public.integration_sync_runs WHERE id = run), 'incremental/schedule', 'incremental, by the schedule');
  PERFORM pg_temp.assert_eq((SELECT spec -> 'request' ->> 'changedSince' FROM public.integration_agent_jobs WHERE run_id = run), '2026-11-05T08:00:00', 'from the mark, with its extraction');
  -- not again within the interval, nor beside a running import
  PERFORM pg_temp.assert_eq(jsonb_array_length(pg_temp.api('SELECT app.system_schedule_integration_runs(current_date, false)')), 0, 'not again within five minutes');
  UPDATE public.integration_import_settings SET last_scheduled_at = now() - interval '6 minutes' WHERE connection_id = conn AND entity_type = 'machine';
  res := pg_temp.api('SELECT app.system_schedule_integration_runs(current_date, false)');
  PERFORM pg_temp.assert_true(res -> 0 ->> 'skipped' LIKE '%still running%', 'never beside a running import: ' || res::text);

  -- ---- an agent that stops answering ----
  UPDATE public.integration_agent_jobs SET created_at = now() - interval '20 minutes' WHERE run_id = run;
  UPDATE public.integration_agents SET last_heartbeat_at = now() - interval '30 minutes' WHERE id = agent;
  PERFORM pg_temp.assert_eq((pg_temp.api('SELECT to_jsonb(app.system_fail_stalled_agent_jobs())'))::text::int, 1, 'the stalled job fails');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_sync_runs WHERE id = run), 'failed', 'and its import');
  PERFORM pg_temp.assert_true((SELECT error_summary LIKE '%did not answer: it was last seen%' FROM public.integration_sync_runs WHERE id = run), 'saying when the agent was last seen');
  PERFORM pg_temp.assert_eq(has_function_privilege('authenticated', 'app.system_fail_stalled_agent_jobs()', 'EXECUTE'), false, 'people cannot call it');

  -- ---- health names the agent ----
  PERFORM pg_temp.login(own);
  res := app.integration_health(org);
  PERFORM pg_temp.assert_true(EXISTS (SELECT 1 FROM jsonb_array_elements(res) e WHERE e ->> 'connectionId' = conn::text AND e -> 'agent' ->> 'name' = 'Newcastle' AND (e -> 'agent' ->> 'online')::boolean = false),
    'health shows the agent and that it is offline');
  PERFORM pg_temp.assert_true(EXISTS (SELECT 1 FROM jsonb_array_elements(res) e WHERE e ->> 'connectionId' = conn::text AND e ->> 'schedule' = 'every_5m'), 'and the schedule');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
