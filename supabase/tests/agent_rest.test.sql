-- Connector agent AG5c (docs/connector-agent-plan.md §18): internal REST APIs read through the agent — their settings, how they sign in (a key,
-- token or password sealed to the agent), endpoints as record sources, previews of an address, and imports (incremental by a changed field).
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

CREATE FUNCTION pg_temp.assert_true(p boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p IS NOT TRUE THEN RAISE EXCEPTION 'FAILED: %', label; END IF; END $$;
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
CREATE FUNCTION pg_temp.problem(cfg text) RETURNS text LANGUAGE sql AS $$ SELECT app.integration_agent_config_problem(cfg::jsonb) $$;

INSERT INTO auth.users (id, email) VALUES ('af5c0000-0000-0000-0000-000000000001', 'own@ag5c.test');

DO $$
DECLARE
  own uuid := 'af5c0000-0000-0000-0000-000000000001';
  org uuid; agent uuid; api uuid; open_api uuid; folder uuid; tpl uuid; run uuid; job uuid; r jsonb; t text; owner uuid := gen_random_uuid();
  cfg jsonb := '{"engine": "rest", "baseUrl": "http://erp.factory.local:8080/api", "authType": "bearer", "testPath": "/health"}';
  src jsonb := '{"path": "/v1/machines", "recordsPath": "data", "query": {"site": "NCL"}, "paging": {"style": "page", "pageSize": 100},
                 "keyColumn": "code", "changedColumn": "updatedAt", "changedParam": "since"}';
  sealed jsonb := jsonb_build_object('epk', repeat('A', 120), 'iv', repeat('B', 16), 'ct', repeat('C', 40));
BEGIN
  PERFORM pg_temp.login(own); org := app.create_organisation('AG5c Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.give_controller_seat(org, own);
  PERFORM pg_temp.login(own); PERFORM app.create_agent_registration(org, pg_temp.h('tok-5c-rest'), 'Newcastle'); PERFORM pg_temp.logout();
  agent := (pg_temp.api(format($f$SELECT app.system_register_agent(%L, %L, %L, '0.5.0', 'Windows', 'ERP01', '{}', NULL)$f$, pg_temp.h('tok-5c-rest'), repeat('A', 88), repeat('B', 88))) ->> 'agentId')::uuid;

  -- ---- an internal API's settings ----
  PERFORM pg_temp.assert_true(app.integration_agent_config_problem(cfg) IS NULL, 'an http address on the private network with a port is an API');
  PERFORM pg_temp.assert_true(pg_temp.problem('{"engine": "rest", "baseUrl": "https://10.0.4.12"}') IS NULL, 'a private address is fine: the agent is inside the network');
  PERFORM pg_temp.assert_true(pg_temp.problem('{"engine": "rest", "baseUrl": "http://[fd00::12]:9000/x"}') IS NULL, 'a bracketed IPv6 address');
  PERFORM pg_temp.assert_true(pg_temp.problem('{"engine": "rest", "baseUrl": "ftp://erp/x"}') LIKE 'The address is http://%', 'http or https only');
  PERFORM pg_temp.assert_true(pg_temp.problem('{"engine": "rest", "baseUrl": "http://user:pw@erp/x"}') LIKE 'The address is http://%', 'no user name in the address');
  PERFORM pg_temp.assert_true(pg_temp.problem('{"engine": "rest", "baseUrl": "http://erp/x?a=1"}') LIKE 'The address is http://%', 'no query in the address');
  PERFORM pg_temp.assert_true(pg_temp.problem('{"engine": "rest", "baseUrl": "http://erp/a/../b"}') LIKE '%.. in its path', 'no .. in the address');
  PERFORM pg_temp.assert_true(pg_temp.problem('{"engine": "rest", "baseUrl": "http://erp:70000/"}') LIKE 'The port%', 'a real port');
  PERFORM pg_temp.assert_true(pg_temp.problem('{"engine": "rest", "baseUrl": "http://169.254.169.254/latest"}') LIKE '%link-local%', 'the metadata address is refused');
  PERFORM pg_temp.assert_true(pg_temp.problem('{"engine": "rest", "baseUrl": "http://[fe80::1]/"}') LIKE '%link-local%', 'IPv6 link-local is refused');
  PERFORM pg_temp.assert_true(pg_temp.problem('{"engine": "rest", "baseUrl": "http://0.0.0.0/"}') LIKE '%link-local%', 'the "any" address is refused');
  PERFORM pg_temp.assert_true(pg_temp.problem('{"engine": "rest", "baseUrl": "http://erp/", "authType": "oauth_client"}') LIKE 'The API signs in with%', 'four ways to sign in');
  PERFORM pg_temp.assert_true(pg_temp.problem('{"engine": "rest", "baseUrl": "http://erp/", "authType": "api_key"}') LIKE 'Name the header%', 'an API key needs its header');
  PERFORM pg_temp.assert_true(pg_temp.problem('{"engine": "rest", "baseUrl": "http://erp/", "authType": "api_key", "apiKeyHeader": "Host"}') LIKE '%cannot be sent in the Host header', 'not a header that changes where it goes');
  PERFORM pg_temp.assert_true(pg_temp.problem('{"engine": "rest", "baseUrl": "http://erp/", "authType": "bearer", "apiKeyHeader": "X-Key"}') LIKE 'Only an API key%', 'a header only for an API key');
  PERFORM pg_temp.assert_true(pg_temp.problem('{"engine": "rest", "baseUrl": "http://erp/", "testPath": "/a/../b"}') LIKE 'The test path%', 'the test path stays below the address');
  PERFORM pg_temp.assert_true(pg_temp.problem('{"engine": "rest", "baseUrl": "http://erp/", "server": "x"}') LIKE 'Unknown setting%', 'database settings are not API settings');
  PERFORM pg_temp.assert_true(pg_temp.problem('{"engine": "rest", "baseUrl": "http://erp/", "timeoutSeconds": 500}') LIKE 'The timeout%', 'a timeout from 1 to 120 seconds');
  PERFORM pg_temp.assert_true(app.integration_agent_needs_password(cfg), 'a bearer token is a secret held by the agent');
  PERFORM pg_temp.assert_true(NOT app.integration_agent_needs_password('{"engine": "rest", "baseUrl": "http://erp/", "authType": "none"}'), 'an open API needs none');

  PERFORM pg_temp.login(own);
  api := app.create_agent_connection(org, agent, 'ERP API', 'erp-api', cfg);
  open_api := app.create_agent_connection(org, agent, 'Open API', 'open-api', '{"engine": "rest", "baseUrl": "http://mes.local/api"}');
  folder := app.create_agent_connection(org, agent, 'ERP exports', 'erp-files', '{"engine": "folder", "folder": "C:\\Exports"}');
  PERFORM pg_temp.assert_eq((app.integration_agent_problems(api))[1], 'Type the API''s token (it is sealed in your browser and only the agent can open it)', 'the token is asked for');
  PERFORM pg_temp.assert_eq(coalesce(array_length(app.integration_agent_problems(open_api), 1), 0), 0, 'an open API needs nothing');
  t := pg_temp.fails(format('SELECT app.set_agent_credential(%L, %L, %L)', open_api, sealed, (SELECT id FROM public.integration_agent_keys WHERE agent_id = agent AND status = 'active')));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%without a password or key%', 'an open API takes no key: ' || t);
  PERFORM app.set_agent_credential(api, sealed, (SELECT id FROM public.integration_agent_keys WHERE agent_id = agent AND status = 'active'));
  PERFORM pg_temp.assert_true(EXISTS (SELECT 1 FROM public.integration_connection_events WHERE connection_id = api AND note = 'A new token was sealed for the agent'), 'the history says a token');
  PERFORM pg_temp.assert_eq((app.integration_agent_problems(api))[1], 'The token is on its way to the agent: it is stored the next time the agent checks in', 'then waits for the agent');

  -- ---- endpoints as record sources ----
  t := pg_temp.fails(format('SELECT app.set_integration_record_source(%L, ''machine'', %L)', api, '{"schema": "erp", "object": "machines", "keyColumn": "id"}'));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%say which path gives these records%', 'an API does not read tables: ' || t);
  t := pg_temp.fails(format('SELECT app.set_integration_record_source(%L, ''machine'', %L)', api, '{"file": "m.csv"}'));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%Only a folder connection reads files%', 'an API does not read files: ' || t);
  t := pg_temp.fails(format('SELECT app.set_integration_record_source(%L, ''machine'', %L)', folder, src));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%folder connection reads files%', 'a folder does not read addresses: ' || t);
  t := pg_temp.fails(format('SELECT app.set_integration_record_source(%L, ''machine'', %L)', api, src - 'keyColumn'));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%identifies each record%', 'an endpoint names its identifying field: ' || t);
  t := pg_temp.fails(format('SELECT app.set_integration_record_source(%L, ''machine'', %L)', api, src - 'changedParam'));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%give both%', 'a changed field needs its parameter: ' || t);
  t := pg_temp.fails(format('SELECT app.set_integration_record_source(%L, ''machine'', %L)', api, src || '{"changedParam": "page"}'));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%already used for paging%', 'not a paging parameter: ' || t);
  t := pg_temp.fails(format('SELECT app.set_integration_record_source(%L, ''machine'', %L)', api, src || '{"changedParam": "site"}'));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%already used for paging or as a fixed parameter%', 'not a fixed parameter: ' || t);
  t := pg_temp.fails(format('SELECT app.set_integration_record_source(%L, ''machine'', %L)', api, src || '{"path": "/v1/../admin"}'));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%stays below the address%', 'the path stays below the address: ' || t);
  t := pg_temp.fails(format('SELECT app.set_integration_record_source(%L, ''machine'', %L)', api, src || '{"paging": {"style": "cursor"}}'));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%next cursor%', 'cursor paging says where the cursor is: ' || t);
  t := pg_temp.fails(format('SELECT app.set_integration_record_source(%L, ''machine'', %L)', api, src || '{"sql": "select 1"}'));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%Unknown setting%', 'no other settings: ' || t);
  PERFORM app.set_integration_record_source(api, 'machine', src);
  PERFORM pg_temp.assert_true(EXISTS (SELECT 1 FROM public.integration_connection_events WHERE connection_id = api AND note = 'Machine records are read from /v1/machines'), 'the history says which address');

  -- ---- trying an address ----
  t := pg_temp.fails(format('SELECT app.request_connection_job(%L, ''discover'', %L)', api, '{}'));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%not browsed%', 'an API is not browsed: ' || t);
  t := pg_temp.fails(format('SELECT app.request_connection_job(%L, ''preview'', %L)', api, '{"schema": "a", "object": "b"}'));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%not browsed%', 'an API has no tables: ' || t);
  t := pg_temp.fails(format('SELECT app.request_connection_job(%L, ''preview'', %L)', api, '{}'));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%Give the path to try%', 'a preview names a path: ' || t);
  t := pg_temp.fails(format('SELECT app.request_connection_job(%L, ''preview'', %L)', api, '{"path": "//evil"}'));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%stays below the address%', 'a preview path stays below the address: ' || t);
  t := pg_temp.fails(format('SELECT app.request_connection_job(%L, ''preview'', %L)', folder, '{"path": "/x"}'));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%Only an API connection%', 'a folder has no addresses: ' || t);
  job := app.request_connection_job(api, 'preview', '{"path": "/v1/machines", "recordsPath": "data", "paging": {"style": "page"}}');
  PERFORM pg_temp.assert_eq((SELECT spec -> 'request' FROM public.integration_agent_jobs WHERE id = job),
    '{"path": "/v1/machines", "recordsPath": "data", "paging": {"style": "page"}, "limit": 20}'::jsonb, 'a preview asks for the first records of the address');
  PERFORM pg_temp.logout();

  -- ---- an import, and an incremental one by the changed field ----
  PERFORM pg_temp.agent_does(agent, 'complete', '{"result": {"stored": true, "username": ""}}');   -- the token
  PERFORM pg_temp.agent_does(agent, 'complete', '{"result": {"columns": [{"name": "code"}], "rows": [{"code": "M1"}]}}');   -- the preview
  PERFORM pg_temp.login(own);
  PERFORM pg_temp.assert_eq(coalesce(array_length(app.integration_agent_problems(api), 1), 0), 0, 'the agent holds the token');
  PERFORM app.request_connection_job(api, 'test_connection');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.agent_does(agent, 'complete', '{"result": {"ok": true, "message": "The API answered 200"}}');
  PERFORM pg_temp.login(own);
  PERFORM app.mark_integration_ready(api);
  PERFORM app.activate_integration_connection(api);
  tpl := app.create_integration_template(org, 'machine', 'API machines', NULL,
    '{"keyField": "code", "fields": [{"target": "code", "source": "code"}, {"target": "name", "source": "name"}], "settings": {"writeMode": "add_update"}}'::jsonb);
  run := app.request_integration_run(api, 'machine', 'full', NULL, tpl);
  r := (SELECT spec -> 'request' FROM public.integration_agent_jobs WHERE run_id = run);
  PERFORM pg_temp.assert_eq(r ->> 'path', '/v1/machines', 'the extraction names the address');
  PERFORM pg_temp.assert_eq(r ->> 'changedParam', 'since', 'and the parameter for changed records');
  PERFORM pg_temp.assert_true(NOT r ? 'changedSince', 'a full read reads everything');
  PERFORM pg_temp.logout();
  job := (SELECT id FROM public.integration_agent_jobs WHERE run_id = run);
  PERFORM pg_temp.api(format('SELECT app.system_agent_next_job(%L, 60)', agent));
  PERFORM pg_temp.api(format($f$SELECT app.system_agent_store_batch(%L, %L, 0, %L, NULL, '[{"code": "M1", "name": "Press", "updatedAt": "2026-11-16T08:00:00Z"}]', '2026-11-16T08:00:00Z')$f$, agent, job, repeat('a', 64)));
  PERFORM pg_temp.api(format($f$SELECT app.system_agent_job_report(%L, %L, 'complete', %L)$f$, agent, job, '{"result": {"batches": 1, "rows": 1, "changedUpTo": "2026-11-16T08:00:00Z"}}'));
  r := pg_temp.api(format('SELECT app.system_lease_integration_run(%L, %L, %L, 60)', org, run, owner));
  PERFORM pg_temp.assert_eq(r -> 'agent' ->> 'changedUpTo', '2026-11-16T08:00:00Z', 'the engine is told the highest changed value');
  UPDATE public.integration_sync_runs SET cursor_next = '{"w": "2026-11-16T08:00:00Z"}', fetch_done = true WHERE id = run;
  PERFORM pg_temp.api(format('SELECT to_jsonb(app.system_finish_integration_run(%L, %L, %L))', org, run, owner));
  PERFORM pg_temp.login(own);
  run := app.request_integration_run(api, 'machine', 'incremental', NULL, tpl);
  PERFORM pg_temp.assert_eq((SELECT spec -> 'request' ->> 'changedSince' FROM public.integration_agent_jobs WHERE run_id = run), '2026-11-16T08:00:00Z', 'an incremental read sends the mark');
  PERFORM app.cancel_integration_run(run, 'Test over');
  -- an endpoint without a changed field is always read whole
  PERFORM app.set_integration_record_source(api, 'part', '{"path": "/v1/parts", "keyColumn": "number"}');
  t := pg_temp.fails(format('SELECT app.request_integration_run(%L, ''part'', ''incremental'', NULL, NULL)', api));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%run a full import%', 'no incremental read without a changed field: ' || t);
  PERFORM pg_temp.logout();

  PERFORM pg_temp.assert_eq((SELECT name FROM public.integration_providers WHERE key = 'sql_agent'), 'Database, folder or API through a connector agent', 'the provider says so');
END $$;

ROLLBACK;
