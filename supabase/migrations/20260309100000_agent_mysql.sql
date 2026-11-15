-- Connector agent AG5a (docs/connector-agent-plan.md §18): MySQL and MariaDB through the agent.
-- A database connection may now name the engine 'mysql' (signs in with a user name and password the agent holds, sealed in the browser as
-- for PostgreSQL). Only the settings check changes; the agent reads the connection's own database, and MySQL has no level between a database
-- and its tables, so that database is the one schema it offers.

CREATE OR REPLACE FUNCTION app.integration_agent_config_problem(p_config jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE k text; v_engine text := p_config ->> 'engine'; v_auth text := p_config ->> 'authType';
BEGIN
  FOR k IN SELECT jsonb_object_keys(p_config) LOOP
    IF k NOT IN ('engine', 'server', 'port', 'instance', 'database', 'authType', 'encrypt', 'trustServerCertificate', 'timeoutSeconds') THEN
      RETURN format('Unknown setting "%s" for a database connection', k);
    END IF;
  END LOOP;
  IF v_engine IS NULL OR v_engine NOT IN ('sqlserver', 'postgres', 'mysql') THEN RETURN 'Choose the database: SQL Server, PostgreSQL or MySQL'; END IF;
  IF jsonb_typeof(p_config -> 'server') IS DISTINCT FROM 'string' OR (p_config ->> 'server') !~ '^(\(local\)|\.|[A-Za-z0-9]([A-Za-z0-9._-]{0,251}[A-Za-z0-9])?|[0-9A-Fa-f:.]{2,45})$' THEN
    RETURN 'Give the database server''s name or address (letters, digits, dots and hyphens)';
  END IF;
  IF p_config ? 'port' AND (jsonb_typeof(p_config -> 'port') <> 'number' OR (p_config ->> 'port') !~ '^[0-9]+$' OR (p_config ->> 'port')::int NOT BETWEEN 1 AND 65535) THEN
    RETURN 'The port is a whole number from 1 to 65535';
  END IF;
  IF p_config ? 'instance' THEN
    IF v_engine <> 'sqlserver' THEN RETURN 'Only SQL Server has named instances'; END IF;
    IF jsonb_typeof(p_config -> 'instance') <> 'string' OR (p_config ->> 'instance') !~ '^[A-Za-z0-9_$#-]{1,32}$' THEN RETURN 'The instance name is up to 32 letters, digits, _ $ # or -'; END IF;
    IF p_config ? 'port' THEN RETURN 'Give a port or an instance name, not both'; END IF;
  END IF;
  IF jsonb_typeof(p_config -> 'database') IS DISTINCT FROM 'string' OR (p_config ->> 'database') !~ '^[^;=''"\[\]\x01-\x1f]{1,128}$' OR btrim(p_config ->> 'database') <> (p_config ->> 'database') THEN
    RETURN 'Give the database name (up to 128 characters, no ; = quotes or brackets)';
  END IF;
  IF v_engine = 'sqlserver' AND coalesce(v_auth, '') NOT IN ('windows', 'sql') THEN RETURN 'SQL Server signs in with Windows authentication (the agent''s service account) or a SQL login'; END IF;
  IF v_engine = 'postgres' AND coalesce(v_auth, '') <> 'password' THEN RETURN 'PostgreSQL signs in with a user name and password'; END IF;
  IF v_engine = 'mysql' AND coalesce(v_auth, '') <> 'password' THEN RETURN 'MySQL signs in with a user name and password'; END IF;
  IF p_config ? 'encrypt' AND jsonb_typeof(p_config -> 'encrypt') <> 'boolean' THEN RETURN 'Say whether the connection is encrypted'; END IF;
  IF p_config ? 'trustServerCertificate' AND jsonb_typeof(p_config -> 'trustServerCertificate') <> 'boolean' THEN RETURN 'Say whether the server''s certificate is trusted without checking'; END IF;
  IF p_config ? 'timeoutSeconds' AND (jsonb_typeof(p_config -> 'timeoutSeconds') <> 'number' OR (p_config ->> 'timeoutSeconds') !~ '^[0-9]+$' OR (p_config ->> 'timeoutSeconds')::int NOT BETWEEN 5 AND 120) THEN
    RETURN 'The timeout is a whole number of seconds from 5 to 120';
  END IF;
  RETURN NULL;
END $$;
