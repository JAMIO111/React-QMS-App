-- Connector agent AG2 (docs/connector-agent-plan.md): database connections read through an agent — settings, the agent fixed to the connection,
-- the password sealed for the agent and forgotten by Fortress, test / browse / preview jobs, test results as of when they were asked,
-- activation needs, revoke / reinstall, an import needs its table, and isolation between organisations.
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
-- The agent takes its next job and reports on it, as the API login.
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

INSERT INTO auth.users (id, email) VALUES
  ('ad000000-0000-0000-0000-000000000001', 'own@ag2.test'), ('ad000000-0000-0000-0000-000000000002', 'insp@ag2.test'),
  ('ad000000-0000-0000-0000-000000000003', 'other@ag2.test');

DO $$
DECLARE
  own uuid := 'ad000000-0000-0000-0000-000000000001'; insp uuid := 'ad000000-0000-0000-0000-000000000002'; other uuid := 'ad000000-0000-0000-0000-000000000003';
  org uuid; org2 uuid; r jsonb; agent uuid; agent2 uuid; kid uuid; conn uuid; win uuid; job uuid; job2 uuid; t text; cfg jsonb;
  sealed jsonb := jsonb_build_object('epk', repeat('A', 88) || '==', 'iv', repeat('B', 16), 'ct', repeat('C', 64));
BEGIN
  PERFORM pg_temp.login(own); org := app.create_organisation('AG2 Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(other); org2 := app.create_organisation('AG2 Beta'); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, insp, 'active');
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = 'inspector') FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id = insp;
  PERFORM pg_temp.give_controller_seat(org, own);
  PERFORM pg_temp.give_controller_seat(org2, other);

  PERFORM pg_temp.login(own); PERFORM app.create_agent_registration(org, pg_temp.h('tok-a'), 'Newcastle'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(other); PERFORM app.create_agent_registration(org2, pg_temp.h('tok-b'), 'Beta box'); PERFORM pg_temp.logout();
  agent := (pg_temp.api(format($f$SELECT app.system_register_agent(%L, %L, %L, '0.2.0', 'Windows', 'ERP01', '{}', NULL)$f$, pg_temp.h('tok-a'), repeat('A', 88), repeat('B', 88))) ->> 'agentId')::uuid;
  agent2 := (pg_temp.api(format($f$SELECT app.system_register_agent(%L, %L, %L, '0.2.0', 'Windows', 'B01', '{}', NULL)$f$, pg_temp.h('tok-b'), repeat('C', 88), repeat('D', 88))) ->> 'agentId')::uuid;
  SELECT id INTO kid FROM public.integration_agent_keys WHERE agent_id = agent AND status = 'active';

  -- ---- the provider is available; a database connection names its agent ----
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_providers WHERE key = 'sql_agent'), 'available', 'database connections are available');
  cfg := '{"engine": "postgres", "server": "erp-db.factory.local", "port": 5432, "database": "erp", "authType": "password", "encrypt": true}';
  PERFORM pg_temp.login(insp);
  t := pg_temp.fails(format('SELECT app.create_agent_connection(%L, %L, %L, %L, %L)', org, agent, 'ERP database', 'erp', cfg));
  PERFORM pg_temp.assert_eq(left(t, 5), '42501', 'an inspector cannot make a database connection');
  PERFORM pg_temp.login(own);
  t := pg_temp.fails(format('SELECT app.create_integration_connection(%L, %L, %L, %L, %L)', org, 'sql_agent', 'ERP database', 'erp', cfg));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%connector agent%', 'the general create needs an agent for a database connection: ' || t);
  t := pg_temp.fails(format('SELECT app.create_agent_connection(%L, %L, %L, %L, %L)', org, agent2, 'ERP database', 'erp', cfg));
  PERFORM pg_temp.assert_eq(left(t, 5), 'P0002', 'another organisation''s agent is not found');
  -- settings that could change the meaning of a connection string are refused
  t := pg_temp.fails(format('SELECT app.create_agent_connection(%L, %L, %L, %L, %L)', org, agent, 'ERP database', 'erp', cfg || '{"server": "db;Password=x"}'));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%server%', 'a ; in the server is refused');
  t := pg_temp.fails(format('SELECT app.create_agent_connection(%L, %L, %L, %L, %L)', org, agent, 'ERP database', 'erp', cfg || '{"database": "erp;x=1"}'));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%database name%', 'a ; in the database name is refused');
  t := pg_temp.fails(format('SELECT app.create_agent_connection(%L, %L, %L, %L, %L)', org, agent, 'ERP database', 'erp', cfg || '{"instance": "SQLEXPRESS"}'));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%named instances%', 'only SQL Server has instances');
  t := pg_temp.fails(format('SELECT app.create_agent_connection(%L, %L, %L, %L, %L)', org, agent, 'ERP database', 'erp', cfg || '{"authType": "windows"}'));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%PostgreSQL signs in%', 'PostgreSQL signs in with a password');
  t := pg_temp.fails(format('SELECT app.create_agent_connection(%L, %L, %L, %L, %L)', org, agent, 'ERP database', 'erp', cfg || '{"password": "hunter2"}'));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%Unknown setting "password"%', 'a password is never a setting');
  t := pg_temp.fails(format('SELECT app.create_agent_connection(%L, %L, %L, %L, %L)', org, agent, 'Win', 'erp-win',
    '{"engine": "sqlserver", "server": "SQL01", "instance": "SQLEXPRESS", "port": 1433, "database": "erp", "authType": "windows"}'));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%port or an instance%', 'a port and an instance together are refused');
  conn := app.create_agent_connection(org, agent, 'ERP database', 'erp', cfg);
  win := app.create_agent_connection(org, agent, 'ERP on SQL Server', 'erp-sql',
    '{"engine": "sqlserver", "server": "SQL01", "instance": "SQLEXPRESS", "database": "ERP", "authType": "windows", "encrypt": true, "trustServerCertificate": false}');
  PERFORM pg_temp.assert_eq((SELECT agent_id FROM public.integration_connections WHERE id = conn), agent, 'the connection names its agent');
  t := pg_temp.fails(format('INSERT INTO public.integration_agent_credentials (connection_id, organisation_id, agent_id, key_id, status) VALUES (%L, %L, %L, %L, ''stored'')', conn, org, agent, kid));
  PERFORM pg_temp.assert_eq(left(t, 5), '42501', 'nobody writes the credential table directly');
  PERFORM pg_temp.logout();
  t := pg_temp.fails(format('UPDATE public.integration_connections SET agent_id = %L WHERE id = %L', agent2, conn));
  PERFORM pg_temp.assert_true(t LIKE '%cannot be changed%' OR t LIKE '23503%', 'the agent of a connection never changes, even for SQL: ' || t);

  -- ---- what activation still needs ----
  PERFORM pg_temp.login(own);
  PERFORM pg_temp.assert_true('Test the connection' = ANY (app.integration_activation_problems(conn)), 'a test is needed');
  PERFORM pg_temp.assert_true(EXISTS (SELECT 1 FROM unnest(app.integration_activation_problems(conn)) p WHERE p LIKE 'Type the database password%'), 'the password is needed');
  PERFORM pg_temp.assert_false(EXISTS (SELECT 1 FROM unnest(app.integration_activation_problems(win)) p WHERE p LIKE '%password%'), 'Windows authentication needs no password');

  -- ---- the password, sealed for the agent ----
  t := pg_temp.fails(format('SELECT app.set_agent_credential(%L, %L, %L)', win, sealed, kid));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%Windows authentication%', 'no password for Windows authentication');
  t := pg_temp.fails(format('SELECT app.set_agent_credential(%L, %L, %L)', conn, sealed, gen_random_uuid()));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%key has changed%', 'it must be sealed to the agent''s current key');
  t := pg_temp.fails(format('SELECT app.set_agent_credential(%L, %L, %L)', conn, '{"password": "hunter2"}', kid));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%expected form%', 'a plain password is refused');
  t := pg_temp.fails(format('SELECT app.set_agent_credential(%L, %L, %L)', conn, sealed || '{"iv": "short"}', kid));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%expected form%', 'a malformed seal is refused');
  job := app.set_agent_credential(conn, sealed, kid);
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_agent_credentials WHERE connection_id = conn), 'waiting', 'the password is waiting for the agent');
  PERFORM pg_temp.assert_true((SELECT spec ? 'sealed' FROM public.integration_agent_jobs WHERE id = job), 'the job carries the sealed bytes');
  PERFORM pg_temp.assert_true(EXISTS (SELECT 1 FROM unnest(app.integration_activation_problems(conn)) p WHERE p LIKE '%on its way to the agent%'), 'activation waits for the agent');
  job2 := app.set_agent_credential(conn, sealed, kid);
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_agent_jobs WHERE id = job), 'cancelled', 'a newer password replaces one still waiting');
  PERFORM pg_temp.assert_false((SELECT spec ? 'sealed' FROM public.integration_agent_jobs WHERE id = job), 'and the replaced job forgets its sealed bytes');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.assert_eq(pg_temp.agent_does(agent, 'complete', '{"result": {"stored": true}}'), job2, 'the agent takes the newer password');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_agent_credentials WHERE connection_id = conn), 'stored', 'the agent has stored it');
  PERFORM pg_temp.assert_false((SELECT spec ? 'sealed' FROM public.integration_agent_jobs WHERE id = job2), 'Fortress no longer holds the sealed bytes');
  PERFORM pg_temp.assert_true(EXISTS (SELECT 1 FROM public.integration_connection_events WHERE connection_id = conn AND action = 'credential_stored'), 'the history says so');

  -- ---- test, browse, preview ----
  PERFORM pg_temp.login(insp);
  t := pg_temp.fails(format('SELECT app.request_connection_job(%L, ''test_connection'')', conn));
  PERFORM pg_temp.assert_eq(left(t, 5), '42501', 'an inspector cannot test a connection');
  PERFORM pg_temp.login(own);
  t := pg_temp.fails(format('SELECT app.request_connection_job(%L, ''extract'')', conn));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%tested, browsed or previewed%', 'no extraction yet');
  t := pg_temp.fails(format($f$SELECT app.request_connection_job(%L, 'discover', '{"level": "objects"}')$f$, conn));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%schema%', 'tables need a schema');
  t := pg_temp.fails(format($f$SELECT app.request_connection_job(%L, 'preview', '{"schema": "erp", "object": "orders", "limit": 51}')$f$, conn));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%1 to 50 rows%', 'a preview is at most 50 rows');
  t := pg_temp.fails(format($f$SELECT app.request_connection_job(%L, 'preview', '{"schema": "erp", "object": "orders", "sql": "select 1"}')$f$, conn));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%Unknown request setting%', 'no SQL can be sent');
  job := app.request_connection_job(conn, 'discover', '{"level": "columns", "schema": "erp", "object": "orders"}');
  PERFORM pg_temp.assert_eq((SELECT spec -> 'request' FROM public.integration_agent_jobs WHERE id = job), '{"level": "columns", "schema": "erp", "object": "orders"}'::jsonb, 'the request is structured');
  PERFORM pg_temp.assert_eq((SELECT spec -> 'connection' ->> 'server' FROM public.integration_agent_jobs WHERE id = job), 'erp-db.factory.local', 'the job carries the settings');
  PERFORM pg_temp.assert_true((SELECT fast_poll_until > now() FROM public.integration_agents WHERE id = agent), 'the agent is asked to poll quickly');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.agent_does(agent, 'complete', '{"result": {"columns": [{"name": "id"}]}}');

  -- a failed test is recorded, as of when it was asked
  PERFORM pg_temp.login(own); job := app.request_connection_job(conn, 'test_connection'); PERFORM pg_temp.logout();
  PERFORM pg_temp.agent_does(agent, 'fail', '{"kind": "auth", "message": "password authentication failed for user \"reader\""}');
  PERFORM pg_temp.assert_eq((SELECT last_test_ok FROM public.integration_connections WHERE id = conn), false, 'the failed test is recorded');
  PERFORM pg_temp.assert_true((SELECT last_test_message LIKE 'password authentication failed%' FROM public.integration_connections WHERE id = conn), 'with the reason');
  PERFORM pg_temp.assert_eq((SELECT last_tested_at FROM public.integration_connections WHERE id = conn), (SELECT created_at FROM public.integration_agent_jobs WHERE id = job), 'as of when it was asked');
  -- a passing test of settings changed since does not count
  PERFORM pg_temp.login(own); job := app.request_connection_job(conn, 'test_connection');
  PERFORM app.update_integration_connection(conn, NULL, cfg || '{"database": "erp_live"}');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.agent_does(agent, 'complete', '{"result": {"ok": true, "message": "Signed in to PostgreSQL 16.4 as reader"}}');
  PERFORM pg_temp.login(own);
  PERFORM pg_temp.assert_true(EXISTS (SELECT 1 FROM unnest(app.integration_activation_problems(conn)) p WHERE p LIKE '%changed after the last test%'), 'a test of older settings does not count');
  -- Another database is another target: the password is asked for again (AG6d) before it can be tested.
  PERFORM pg_temp.assert_true(EXISTS (SELECT 1 FROM unnest(app.integration_activation_problems(conn)) p WHERE p LIKE 'Type the database password%'), 'a new database asks for the password again');
  PERFORM app.set_agent_credential(conn, sealed, kid); PERFORM pg_temp.logout();
  PERFORM pg_temp.agent_does(agent, 'complete', '{"result": {"stored": true, "username": "reader"}}');
  PERFORM pg_temp.login(own);
  job := app.request_connection_job(conn, 'test_connection'); PERFORM pg_temp.logout();
  PERFORM pg_temp.agent_does(agent, 'complete', '{"result": {"ok": true, "message": "Signed in to PostgreSQL 16.4 as reader"}}');
  PERFORM pg_temp.login(own);
  PERFORM pg_temp.assert_eq(cardinality(app.integration_activation_problems(conn)), 0, 'tested and with the password stored, nothing more is needed');
  PERFORM app.mark_integration_ready(conn);
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_connections WHERE id = conn), 'ready', 'it can be marked ready');

  -- ---- an import needs to know which table holds the records (AG3) ----
  t := pg_temp.fails(format('SELECT app.request_integration_run(%L, ''machine'', ''preview'')', conn));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%which table or file holds machine records%', 'an import needs its table: ' || t);

  -- ---- isolation ----
  PERFORM pg_temp.login(other);
  t := pg_temp.fails(format('SELECT app.set_agent_credential(%L, %L, %L)', conn, sealed, kid));
  PERFORM pg_temp.assert_eq(left(t, 5), 'P0002', 'another organisation cannot give this connection a password');
  t := pg_temp.fails(format('SELECT app.request_connection_job(%L, ''test_connection'')', conn));
  PERFORM pg_temp.assert_eq(left(t, 5), 'P0002', 'nor test it');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.integration_agent_credentials)::int, 0, 'nor see whether it has a password');
  PERFORM pg_temp.logout();

  -- ---- reinstalled on another machine: the password must be typed again; revoked: the connection cannot be used ----
  PERFORM pg_temp.login(own); PERFORM app.create_agent_registration(org, pg_temp.h('tok-re'), NULL, NULL, 24, agent); PERFORM pg_temp.logout();
  PERFORM pg_temp.api(format($f$SELECT app.system_register_agent(%L, %L, %L, '0.2.0', 'Windows', 'ERP02', '{}', NULL)$f$, pg_temp.h('tok-re'), repeat('E', 88), repeat('F', 88)));
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_agent_credentials WHERE connection_id = conn), 'cleared', 'a reinstall clears the password');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_connections WHERE id = conn), 'draft', 'and the connection is no longer ready');
  PERFORM pg_temp.login(own);
  PERFORM pg_temp.assert_true(EXISTS (SELECT 1 FROM unnest(app.integration_activation_problems(conn)) p WHERE p LIKE 'Type the database password%'), 'it asks for the password again');
  PERFORM app.revoke_agent(agent, 'Server decommissioned');
  PERFORM pg_temp.assert_true(EXISTS (SELECT 1 FROM unnest(app.integration_activation_problems(conn)) p WHERE p LIKE '%has been revoked%'), 'a revoked agent stops the connection');
  t := pg_temp.fails(format('SELECT app.request_connection_job(%L, ''test_connection'')', conn));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%revoked%', 'nothing can be asked of a revoked agent');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
