-- Connector agent AG5a (docs/connector-agent-plan.md §18): a database connection may name MySQL. It signs in with a user name and password
-- (sealed for the agent, as for PostgreSQL), takes a port but no instance, and a password is what activation waits for.
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

INSERT INTO auth.users (id, email) VALUES ('ad500000-0000-0000-0000-000000000001', 'own@ag5.test');

DO $$
DECLARE
  own uuid := 'ad500000-0000-0000-0000-000000000001'; org uuid; agent uuid; conn uuid; t text;
  cfg jsonb := '{"engine": "mysql", "server": "erp-mysql.factory.local", "port": 3306, "database": "erp", "authType": "password", "encrypt": true}';
BEGIN
  PERFORM pg_temp.login(own); org := app.create_organisation('AG5 Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.give_controller_seat(org, own);
  PERFORM pg_temp.login(own); PERFORM app.create_agent_registration(org, pg_temp.h('tok-5'), 'Newcastle'); PERFORM pg_temp.logout();
  agent := (pg_temp.api(format($f$SELECT app.system_register_agent(%L, %L, %L, '0.5.0', 'Windows', 'ERP01', '{}', NULL)$f$, pg_temp.h('tok-5'), repeat('A', 88), repeat('B', 88))) ->> 'agentId')::uuid;

  PERFORM pg_temp.assert_true(app.integration_agent_config_problem(cfg) IS NULL, 'MySQL settings are accepted');
  PERFORM pg_temp.assert_eq(app.integration_agent_config_problem(cfg || '{"authType": "windows"}'), 'MySQL signs in with a user name and password', 'MySQL has no Windows sign-in');
  PERFORM pg_temp.assert_eq(app.integration_agent_config_problem(cfg - 'port' || '{"instance": "ERP"}'), 'Only SQL Server has named instances', 'MySQL has no named instances');
  PERFORM pg_temp.assert_eq(app.integration_agent_config_problem(cfg || '{"engine": "oracle"}'), 'Choose the database: SQL Server, PostgreSQL or MySQL, or a folder of files', 'an engine the agent cannot read is refused');
  PERFORM pg_temp.assert_eq(app.integration_agent_config_problem(cfg || '{"database": "erp;x=1"}'), 'Give the database name (up to 128 characters, no ; = quotes or brackets)', 'a database name cannot change the connection string');
  -- The other engines are as before.
  PERFORM pg_temp.assert_true(app.integration_agent_config_problem(cfg || '{"engine": "postgres", "port": 5432}') IS NULL, 'PostgreSQL still accepted');
  PERFORM pg_temp.assert_true(app.integration_agent_config_problem('{"engine": "sqlserver", "server": "SQL01", "instance": "SQLEXPRESS", "database": "ERP", "authType": "windows"}') IS NULL, 'SQL Server still accepted');

  PERFORM pg_temp.assert_true(app.integration_agent_needs_password(cfg), 'a MySQL connection needs a password held by the agent');
  PERFORM pg_temp.login(own);
  conn := app.create_agent_connection(org, agent, 'ERP MySQL', 'erp-mysql', cfg);
  PERFORM pg_temp.assert_true(conn IS NOT NULL, 'a MySQL connection is made through the agent');
  PERFORM pg_temp.assert_true(EXISTS (SELECT 1 FROM unnest(app.integration_activation_problems(conn)) p WHERE p ILIKE '%password%'), 'activation waits for the password');
  t := pg_temp.fails(format('SELECT app.update_integration_connection(%L, NULL, %L)', conn, cfg || '{"authType": "windows"}'));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%MySQL signs in%', 'changing a MySQL connection keeps the rule: ' || t);
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
