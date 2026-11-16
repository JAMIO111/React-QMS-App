-- Connector agent AG5b (docs/connector-agent-plan.md §18): folders of files read through the agent — their settings, file sources, folder jobs,
-- the parts of an uploaded file (in order, checked, never readable, gone when the job ends), and incremental reads by the file's SHA-256.
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

INSERT INTO auth.users (id, email) VALUES ('af500000-0000-0000-0000-000000000001', 'own@ag5b.test'), ('af500000-0000-0000-0000-000000000002', 'other@ag5b.test');

DO $$
DECLARE
  own uuid := 'af500000-0000-0000-0000-000000000001'; other uuid := 'af500000-0000-0000-0000-000000000002';
  org uuid; org2 uuid; agent uuid; agent2 uuid; folder uuid; db uuid; tpl uuid; run uuid; job uuid; r jsonb; t text; owner uuid := gen_random_uuid();
  cfg jsonb := '{"engine": "folder", "folder": "\\\\files01\\exports\\erp", "authType": "none", "delimiter": ";", "hasHeader": true}';
  part bytea := convert_to('code;name' || chr(10) || 'M1;Press' || chr(10), 'UTF8');
BEGIN
  PERFORM pg_temp.login(own); org := app.create_organisation('AG5b Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(other); org2 := app.create_organisation('AG5b Beta'); PERFORM pg_temp.logout();
  PERFORM pg_temp.give_controller_seat(org, own);
  PERFORM pg_temp.give_controller_seat(org2, other);
  PERFORM pg_temp.login(own); PERFORM app.create_agent_registration(org, pg_temp.h('tok-5b'), 'Newcastle'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(other); PERFORM app.create_agent_registration(org2, pg_temp.h('tok-5c'), 'Beta'); PERFORM pg_temp.logout();
  agent := (pg_temp.api(format($f$SELECT app.system_register_agent(%L, %L, %L, '0.5.0', 'Windows', 'ERP01', '{}', NULL)$f$, pg_temp.h('tok-5b'), repeat('A', 88), repeat('B', 88))) ->> 'agentId')::uuid;
  agent2 := (pg_temp.api(format($f$SELECT app.system_register_agent(%L, %L, %L, '0.5.0', 'Windows', 'B01', '{}', NULL)$f$, pg_temp.h('tok-5c'), repeat('C', 88), repeat('D', 88))) ->> 'agentId')::uuid;

  -- ---- a folder's settings ----
  PERFORM pg_temp.assert_true(app.integration_agent_config_problem(cfg) IS NULL, 'a share is a folder');
  PERFORM pg_temp.assert_true(app.integration_agent_config_problem('{"engine": "folder", "folder": "C:\\Exports"}') IS NULL, 'a drive path is a folder');
  PERFORM pg_temp.assert_true(app.integration_agent_config_problem('{"engine": "folder", "folder": "/srv/exports"}') IS NULL, 'an absolute path is a folder');
  PERFORM pg_temp.assert_true(app.integration_agent_config_problem('{"engine": "folder", "folder": "exports"}') LIKE 'Give the whole folder path%', 'a relative path is refused');
  PERFORM pg_temp.assert_true(app.integration_agent_config_problem('{"engine": "folder", "folder": "C:\\Exports\\..\\Windows"}') LIKE '%cannot contain ".."%', '".." is refused');
  PERFORM pg_temp.assert_true(app.integration_agent_config_problem('{"engine": "folder", "folder": "C:\\Exports", "authType": "sql"}') LIKE '%takes no sign-in%', 'a folder takes no sign-in');
  PERFORM pg_temp.assert_true(app.integration_agent_config_problem('{"engine": "folder", "folder": "C:\\Exports", "server": "x"}') LIKE 'Unknown setting%', 'database settings are not folder settings');
  PERFORM pg_temp.assert_true(app.integration_agent_config_problem('{"engine": "folder", "folder": "C:\\Exports", "delimiter": "x"}') LIKE 'The separator%', 'a separator from the list');
  PERFORM pg_temp.assert_true(app.integration_agent_config_problem('{"engine": "oracle", "server": "x", "database": "y", "authType": "password"}') LIKE '%a folder of files or an internal API', 'the engines are named');

  PERFORM pg_temp.login(own);
  folder := app.create_agent_connection(org, agent, 'ERP exports', 'erp-files', cfg);
  db := app.create_agent_connection(org, agent, 'ERP database', 'erp-db', '{"engine": "postgres", "server": "erp-db", "database": "erp", "authType": "password"}');
  PERFORM pg_temp.assert_eq(coalesce(array_length(app.integration_agent_problems(folder), 1), 0), 0, 'a folder needs no password');

  -- ---- which file holds the records ----
  t := pg_temp.fails(format('SELECT app.set_integration_record_source(%L, ''machine'', %L)', folder, '{"schema": "erp", "object": "machines", "keyColumn": "id"}'));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%folder connection reads files%', 'a folder does not read tables: ' || t);
  t := pg_temp.fails(format('SELECT app.set_integration_record_source(%L, ''machine'', %L)', db, '{"file": "machines.csv"}'));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%Only a folder connection reads files%', 'a database does not read files: ' || t);
  t := pg_temp.fails(format('SELECT app.set_integration_record_source(%L, ''machine'', %L)', folder, '{"file": "../machines.csv"}'));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%directly in the folder%', 'a file is directly in the folder: ' || t);
  t := pg_temp.fails(format('SELECT app.set_integration_record_source(%L, ''machine'', %L)', folder, '{"file": "m.csv", "keyColumn": "id"}'));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%Unknown setting%', 'a file source names only the file: ' || t);
  PERFORM app.set_integration_record_source(folder, 'machine', '{"file": "machines-*.csv"}');
  PERFORM pg_temp.assert_true(EXISTS (SELECT 1 FROM public.integration_connection_events WHERE connection_id = folder AND note LIKE '%newest file matching machines-*.csv'), 'the history says which file');

  -- ---- browsing and previewing a folder ----
  t := pg_temp.fails(format('SELECT app.request_connection_job(%L, ''discover'', %L)', folder, '{"level": "schemas"}'));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%browsed for its files%', 'a folder is browsed for files: ' || t);
  t := pg_temp.fails(format('SELECT app.request_connection_job(%L, ''preview'', %L)', folder, '{"schema": "erp", "object": "x"}'));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%not schemas or tables%', 'a folder has no tables: ' || t);
  t := pg_temp.fails(format('SELECT app.request_connection_job(%L, ''preview'', %L)', db, '{"file": "x.csv"}'));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%Only a folder holds files%', 'a database has no files: ' || t);
  job := app.request_connection_job(folder, 'discover', '{}');
  PERFORM pg_temp.assert_eq((SELECT spec -> 'request' FROM public.integration_agent_jobs WHERE id = job), '{"level": "files"}'::jsonb, 'browsing a folder lists its files');
  job := app.request_connection_job(folder, 'preview', '{"file": "machines-*.csv", "limit": 10}');
  PERFORM pg_temp.assert_eq((SELECT spec -> 'request' FROM public.integration_agent_jobs WHERE id = job), '{"file": "machines-*.csv", "limit": 10}'::jsonb, 'a preview names the file');
  PERFORM pg_temp.logout();

  -- ---- the parts of a file ----
  r := pg_temp.api(format('SELECT app.system_agent_next_job(%L, 60)', agent));   -- the discover job
  PERFORM pg_temp.api(format($f$SELECT app.system_agent_job_report(%L, %L, 'complete', '{"result": {"level": "files", "files": []}}')$f$, agent, (r ->> 'id')::uuid));
  t := pg_temp.fails(format($f$SELECT pg_temp.api(format('SELECT app.system_agent_store_file_part(%%L, %%L, 0, %%L, %%L)', %L::uuid, %L::uuid, encode(sha256(%L::bytea), 'hex'), %L::bytea))$f$, agent, job, part, part));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%Take the job again%', 'a part waits for the job to be taken: ' || t);
  r := pg_temp.api(format('SELECT app.system_agent_next_job(%L, 60)', agent));   -- the preview job
  PERFORM pg_temp.assert_eq(r ->> 'id', job::text, 'the agent takes the preview');
  t := pg_temp.fails(format($f$SELECT pg_temp.api(format('SELECT app.system_agent_store_file_part(%%L, %%L, 0, %%L, %%L)', %L::uuid, %L::uuid, repeat('0', 64), %L::bytea))$f$, agent, job, part));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%does not match its checksum%', 'a part matches its checksum: ' || t);
  t := pg_temp.fails(format($f$SELECT pg_temp.api(format('SELECT app.system_agent_store_file_part(%%L, %%L, 1, %%L, %%L)', %L::uuid, %L::uuid, encode(sha256(%L::bytea), 'hex'), %L::bytea))$f$, agent, job, part, part));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%Part 0 was expected next%', 'parts come in order: ' || t);
  r := pg_temp.api(format('SELECT app.system_agent_store_file_part(%L, %L, 0, %L, %L)', agent, job, encode(sha256(part), 'hex'), part));
  PERFORM pg_temp.assert_eq(r ->> 'stored', 'true', 'a part is stored');
  r := pg_temp.api(format('SELECT app.system_agent_store_file_part(%L, %L, 0, %L, %L)', agent, job, encode(sha256(part), 'hex'), part));
  PERFORM pg_temp.assert_eq(r ->> 'duplicate', 'true', 'a part sent twice is stored once');
  t := pg_temp.fails(format($f$SELECT pg_temp.api(format('SELECT app.system_agent_store_file_part(%%L, %%L, 1, %%L, %%L)', %L::uuid, %L::uuid, encode(sha256(%L::bytea), 'hex'), %L::bytea))$f$, agent2, job, part, part));
  PERFORM pg_temp.assert_true(t LIKE 'P0002%', 'another agent cannot add to the file: ' || t);
  r := pg_temp.api(format('SELECT app.system_agent_file_job(%L, %L)', agent, job));
  PERFORM pg_temp.assert_eq(r ->> 'parts', '1', 'the API sees the parts');
  PERFORM pg_temp.assert_eq(r ->> 'folder', 'true', 'and that the job reads a folder');
  PERFORM pg_temp.assert_eq((SELECT convert_from(string_agg(data, ''::bytea ORDER BY seq), 'UTF8') FROM app.system_agent_file_parts(agent, job)), convert_from(part, 'UTF8'), 'the API reads the bytes back');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM app.system_agent_file_parts(agent2, job)), 0, 'another agent reads nothing');
  PERFORM pg_temp.login(own);
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.integration_agent_file_parts), 0, 'nobody reads a file''s bytes directly');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.api(format($f$SELECT app.system_agent_job_report(%L, %L, 'complete', '{"result": {"columns": [{"name": "code"}], "rows": [{"code": "M1"}]}}')$f$, agent, job));
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.integration_agent_file_parts WHERE job_id = job), 0, 'the bytes go when the job ends');
  t := pg_temp.fails(format($f$SELECT pg_temp.api(format('SELECT app.system_agent_store_file_part(%%L, %%L, 1, %%L, %%L)', %L::uuid, %L::uuid, encode(sha256(%L::bytea), 'hex'), %L::bytea))$f$, agent, db, part, part));
  PERFORM pg_temp.assert_true(t LIKE 'P0002%' OR t LIKE 'QM022%', 'a database job takes no file');

  -- ---- an import from a folder, and an incremental one by the file's hash ----
  PERFORM pg_temp.login(own);
  PERFORM app.request_connection_job(folder, 'test_connection');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.agent_does(agent, 'complete', '{"result": {"ok": true, "message": "The folder can be read"}}');
  PERFORM pg_temp.login(own);
  PERFORM app.mark_integration_ready(folder);
  PERFORM app.activate_integration_connection(folder);
  tpl := app.create_integration_template(org, 'machine', 'Exported machines', NULL,
    '{"keyField": "code", "fields": [{"target": "code", "source": "code"}, {"target": "name", "source": "name"}], "settings": {"writeMode": "add_update"}}'::jsonb);
  run := app.request_integration_run(folder, 'machine', 'full', NULL, tpl);
  r := (SELECT spec -> 'request' FROM public.integration_agent_jobs WHERE run_id = run);
  PERFORM pg_temp.assert_eq(r ->> 'file', 'machines-*.csv', 'the extraction names the file');
  PERFORM pg_temp.assert_eq(r ->> 'changedColumn', '@file', 'its mark is the file');
  PERFORM pg_temp.assert_false(r ? 'changedSince', 'a full read always reads the file');
  PERFORM pg_temp.logout();
  job := (SELECT id FROM public.integration_agent_jobs WHERE run_id = run);
  PERFORM pg_temp.api(format('SELECT app.system_agent_next_job(%L, 60)', agent));
  -- as the API does once it has read the file: the rows become the extraction's batches, the mark is the file's hash
  PERFORM pg_temp.api(format($f$SELECT app.system_agent_store_batch(%L, %L, 0, %L, '2', '[{"code": "M1", "name": "Press"}]', %L)$f$, agent, job, repeat('a', 64), repeat('f', 64)));
  PERFORM pg_temp.api(format($f$SELECT app.system_agent_job_report(%L, %L, 'complete', %L)$f$, agent, job, jsonb_build_object('result', jsonb_build_object('batches', 1, 'rows', 1, 'changedUpTo', repeat('f', 64)))));
  r := pg_temp.api(format('SELECT app.system_lease_integration_run(%L, %L, %L, 60)', org, run, owner));
  PERFORM pg_temp.assert_eq(r -> 'agent' ->> 'changedColumn', '@file', 'the engine is told the mark is a file');
  PERFORM pg_temp.assert_eq(r -> 'agent' ->> 'changedUpTo', repeat('f', 64), 'and the file''s hash');
  UPDATE public.integration_sync_runs SET cursor_next = format('{"w": "%s"}', repeat('f', 64)), fetch_done = true WHERE id = run;
  PERFORM pg_temp.api(format('SELECT to_jsonb(app.system_finish_integration_run(%L, %L, %L))', org, run, owner));
  PERFORM pg_temp.login(own);
  run := app.request_integration_run(folder, 'machine', 'incremental', NULL, tpl);
  PERFORM pg_temp.assert_eq((SELECT spec -> 'request' ->> 'changedSince' FROM public.integration_agent_jobs WHERE run_id = run), repeat('f', 64), 'an incremental read sends the last file''s hash');
  PERFORM app.cancel_integration_run(run, 'Test over');
  -- a schedule on a folder reads only a changed file
  PERFORM app.set_integration_import_settings(folder, 'machine', jsonb_build_object('schedule', 'every_15m', 'templateId', tpl));
  PERFORM pg_temp.logout();
  UPDATE public.integration_agents SET last_heartbeat_at = now() WHERE id = agent;
  PERFORM pg_temp.api('SELECT app.system_schedule_integration_runs(current_date, false)');
  PERFORM pg_temp.assert_eq((SELECT kind FROM public.integration_sync_runs WHERE connection_id = folder AND trigger = 'schedule'), 'incremental', 'a scheduled folder read is incremental once a file was read');
END $$;

ROLLBACK;
