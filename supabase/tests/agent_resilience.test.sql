-- Connector agent AG6a (docs/connector-agent-plan.md §19): an admin asks an agent to rotate its keys or for a diagnostics bundle; one rotation waits
-- at a time; bundles are cleared after 30 days; people without integrations.manage cannot ask; only the API login clears.
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

INSERT INTO auth.users (id, email) VALUES ('a6a00000-0000-0000-0000-000000000001', 'own@ag6a.test'), ('a6a00000-0000-0000-0000-000000000002', 'insp@ag6a.test');

DO $$
DECLARE
  own uuid := 'a6a00000-0000-0000-0000-000000000001'; insp uuid := 'a6a00000-0000-0000-0000-000000000002';
  org uuid; agent uuid; rot uuid; diag uuid; r jsonb; t text;
BEGIN
  PERFORM pg_temp.login(own); org := app.create_organisation('AG6a Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.give_controller_seat(org, own);
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, insp, 'active');
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = 'inspector')
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id = insp;
  PERFORM pg_temp.login(own); PERFORM app.create_agent_registration(org, pg_temp.h('tok-6a'), 'Newcastle'); PERFORM pg_temp.logout();
  agent := (pg_temp.api(format($f$SELECT app.system_register_agent(%L, %L, %L, '0.6.0', 'Windows', 'ERP01', '{}', NULL)$f$, pg_temp.h('tok-6a'), repeat('A', 88), repeat('B', 88))) ->> 'agentId')::uuid;

  PERFORM pg_temp.login(insp);
  t := pg_temp.fails(format($f$SELECT app.request_agent_job(%L, 'diagnostics')$f$, agent));
  PERFORM pg_temp.assert_true(t LIKE '42501%' OR t LIKE 'P0002%', 'an inspector cannot ask for diagnostics: ' || t);
  PERFORM pg_temp.login(own);
  t := pg_temp.fails(format($f$SELECT app.request_agent_job(%L, 'extract')$f$, agent));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%rotate its keys%', 'an agent is not given an extraction this way: ' || t);
  rot := app.request_agent_job(agent, 'rotate_keys');
  PERFORM pg_temp.assert_eq(app.request_agent_job(agent, 'rotate_keys'), rot, 'one rotation waits at a time');
  diag := app.request_agent_job(agent, 'diagnostics', '{"anything": "ignored"}');
  PERFORM pg_temp.assert_eq((SELECT spec FROM public.integration_agent_jobs WHERE id = diag), '{}'::jsonb, 'a person cannot put anything in the job');
  PERFORM pg_temp.logout();

  -- The agent sends the bundle; it is kept with the job, then cleared after 30 days.
  r := pg_temp.api(format('SELECT app.system_agent_next_job(%L, 60)', agent));
  PERFORM pg_temp.assert_eq(r ->> 'kind', 'rotate_keys', 'the rotation first');
  PERFORM pg_temp.api(format($f$SELECT app.system_agent_job_report(%L, %L, 'ack', '{}')$f$, agent, rot));
  PERFORM pg_temp.api(format($f$SELECT app.system_agent_job_report(%L, %L, 'complete', '{"result": {"rotated": true}}')$f$, agent, rot));
  PERFORM pg_temp.login(own);
  PERFORM pg_temp.assert_true(app.request_agent_job(agent, 'rotate_keys') <> rot, 'once done, a new rotation can be asked for');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.api(format('SELECT app.system_agent_next_job(%L, 60)', agent));
  PERFORM pg_temp.api(format($f$SELECT app.system_agent_job_report(%L, %L, 'ack', '{}')$f$, agent, diag));
  PERFORM pg_temp.api(format($f$SELECT app.system_agent_job_report(%L, %L, 'complete', '{"result": {"version": "0.6.0", "log": ["a"]}}')$f$, agent, diag));
  PERFORM pg_temp.assert_eq((SELECT result ->> 'version' FROM public.integration_agent_jobs WHERE id = diag), '0.6.0', 'the bundle is kept');
  PERFORM pg_temp.assert_eq((pg_temp.api('SELECT to_jsonb(app.system_purge_agent_diagnostics())') #>> '{}')::int, 0, 'a fresh bundle is kept');
  UPDATE public.integration_agent_jobs SET finished_at = now() - interval '31 days' WHERE id = diag;
  PERFORM pg_temp.assert_eq((pg_temp.api('SELECT to_jsonb(app.system_purge_agent_diagnostics())') #>> '{}')::int, 1, 'an old bundle is cleared');
  PERFORM pg_temp.assert_true((SELECT result ? 'cleared' AND NOT result ? 'log' FROM public.integration_agent_jobs WHERE id = diag), 'only a note that it was cleared is left');
  PERFORM pg_temp.assert_eq((pg_temp.api('SELECT to_jsonb(app.system_purge_agent_diagnostics())') #>> '{}')::int, 0, 'cleared once');

  PERFORM pg_temp.login(own);
  t := pg_temp.fails('SELECT app.system_purge_agent_diagnostics()');
  PERFORM pg_temp.assert_true(t LIKE '42501%', 'people cannot clear bundles: ' || t);
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
