-- Connector agent AG6d hardening (docs/connector-agent-plan.md §19): a stored password can only go where it was typed for.
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

INSERT INTO auth.users (id, email) VALUES ('af6d0000-0000-0000-0000-000000000001', 'own@ag6d.test');

DO $$
DECLARE
  own uuid := 'af6d0000-0000-0000-0000-000000000001';
  org uuid; agent uuid; conn uuid; api_conn uuid; job uuid; key uuid; r jsonb; t text;
  cfg jsonb := '{"engine": "postgres", "server": "erp-db.factory.local", "port": 5432, "database": "erp", "authType": "password"}';
  sealed jsonb := jsonb_build_object('epk', repeat('A', 120), 'iv', repeat('B', 16), 'ct', repeat('C', 40));
BEGIN
  PERFORM pg_temp.login(own); org := app.create_organisation('AG6d Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.give_controller_seat(org, own);
  PERFORM pg_temp.login(own); PERFORM app.create_agent_registration(org, pg_temp.h('tok-6d'), 'Newcastle'); PERFORM pg_temp.logout();
  agent := (pg_temp.api(format($f$SELECT app.system_register_agent(%L, %L, %L, '0.6.0', 'Windows', 'ERP01', '{}', NULL)$f$, pg_temp.h('tok-6d'), repeat('A', 88), repeat('B', 88))) ->> 'agentId')::uuid;
  key := (SELECT id FROM public.integration_agent_keys WHERE agent_id = agent AND status = 'active');

  PERFORM pg_temp.login(own);
  conn := app.create_agent_connection(org, agent, 'ERP', 'erp-6d', cfg);
  job := app.set_agent_credential(conn, sealed, key);
  r := (SELECT spec FROM public.integration_agent_jobs WHERE id = job);
  PERFORM pg_temp.assert_eq(r -> 'connection', cfg, 'the password job carries the settings it was typed for');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.api(format('SELECT app.system_agent_next_job(%L, 60)', agent));
  PERFORM pg_temp.api(format($f$SELECT app.system_agent_job_report(%L, %L, 'complete', '{"result": {"stored": true, "username": "reader"}}')$f$, agent, job));
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_agent_credentials WHERE connection_id = conn), 'stored', 'the agent holds it');

  PERFORM pg_temp.login(own);
  -- A change that does not move the target keeps the password: the name, a timeout, the case of the server name.
  PERFORM app.update_integration_connection(conn, 'ERP database', cfg || '{"timeoutSeconds": 30, "server": "ERP-DB.factory.local"}');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_agent_credentials WHERE connection_id = conn), 'stored', 'same target, same password');

  -- Another server: the password is cleared and asked for again.
  PERFORM app.update_integration_connection(conn, NULL, cfg || '{"server": "evil.example.com"}');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_agent_credentials WHERE connection_id = conn), 'cleared', 'a new server clears the password');
  PERFORM pg_temp.assert_eq((SELECT message FROM public.integration_agent_credentials WHERE connection_id = conn), 'The connection now points somewhere else: type the password again', 'and says why');
  PERFORM pg_temp.assert_true((app.integration_agent_problems(conn))[1] LIKE 'Type the database password%', 'the password is asked for again');

  -- The same for a port, a database or the kind of sign-in; and a password waiting for the agent is cancelled with it.
  job := app.set_agent_credential(conn, sealed, key);
  PERFORM app.update_integration_connection(conn, NULL, cfg || '{"server": "evil.example.com", "database": "payroll"}');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_agent_jobs WHERE id = job), 'cancelled', 'a password on its way is stopped');
  PERFORM pg_temp.assert_true(NOT (SELECT spec ? 'sealed' FROM public.integration_agent_jobs WHERE id = job), 'and its sealed bytes are gone');

  -- What a connection reads never changes.
  t := pg_temp.fails(format('SELECT app.update_integration_connection(%L, NULL, %L)', conn, '{"engine": "rest", "baseUrl": "https://evil.example.com", "authType": "basic"}'));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%cannot change: make a new connection%', 'no engine change: ' || t);

  -- An internal API: its address and the header of its key are its target too.
  api_conn := app.create_agent_connection(org, agent, 'ERP API', 'erp-api-6d', '{"engine": "rest", "baseUrl": "http://erp.factory.local/api", "authType": "api_key", "apiKeyHeader": "X-Api-Key"}');
  job := app.set_agent_credential(api_conn, sealed, key);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.api(format('SELECT app.system_agent_next_job(%L, 60)', agent));
  PERFORM pg_temp.api(format($f$SELECT app.system_agent_job_report(%L, %L, 'complete', '{"result": {"stored": true, "username": ""}}')$f$, agent, job));
  PERFORM pg_temp.login(own);
  PERFORM app.update_integration_connection(api_conn, NULL, '{"engine": "rest", "baseUrl": "http://erp.factory.local/api", "authType": "api_key", "apiKeyHeader": "X-Other-Key"}');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_agent_credentials WHERE connection_id = api_conn), 'cleared', 'another header clears the key');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.assert_true(NOT has_function_privilege('authenticated', 'app.integration_agent_target(jsonb)', 'execute'), 'the helper is not for people');
END $$;

ROLLBACK;
