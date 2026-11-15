-- Connector agents AG1 (docs/connector-agent-plan.md): one-time registrations, agents and their keys, the job queue, revocation, network rules for
-- agent requests, and that people never write these tables directly and only the API login runs the agent's functions.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

CREATE FUNCTION pg_temp.assert_true(p boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p IS NOT TRUE THEN RAISE EXCEPTION 'FAILED: %', label; END IF; END $$;
CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;
-- Run something as the API's own login and hand back its jsonb answer.
CREATE FUNCTION pg_temp.api(stmt text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  PERFORM set_config('role', 'qms_api', true);
  BEGIN EXECUTE stmt INTO r;
  EXCEPTION WHEN OTHERS THEN PERFORM set_config('role', 'postgres', true); RAISE; END;
  PERFORM set_config('role', 'postgres', true);
  RETURN r;
END $$;
CREATE FUNCTION pg_temp.api_fails(stmt text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('role', 'qms_api', true);
  BEGIN EXECUTE stmt; EXCEPTION WHEN OTHERS THEN PERFORM set_config('role', 'postgres', true); RETURN SQLSTATE || ': ' || SQLERRM; END;
  PERFORM set_config('role', 'postgres', true);
  RETURN 'ok';
END $$;
CREATE FUNCTION pg_temp.h(t text) RETURNS text LANGUAGE sql AS $$ SELECT encode(sha256(convert_to(t, 'UTF8')), 'hex') $$;

INSERT INTO auth.users (id, email) VALUES
  ('ac000000-0000-0000-0000-000000000001', 'own@ag1.test'), ('ac000000-0000-0000-0000-000000000002', 'insp@ag1.test'),
  ('ac000000-0000-0000-0000-000000000003', 'other@ag1.test'), ('ac000000-0000-0000-0000-000000000004', 'noseat@ag1.test');

DO $$
DECLARE
  own uuid := 'ac000000-0000-0000-0000-000000000001'; insp uuid := 'ac000000-0000-0000-0000-000000000002';
  other uuid := 'ac000000-0000-0000-0000-000000000003'; noseat uuid := 'ac000000-0000-0000-0000-000000000004';
  org uuid; org2 uuid; reg uuid; r jsonb; agent uuid; agent2 uuid; job uuid; job2 uuid; t text;
  k1 text := repeat('A', 88); k2 text := repeat('B', 88); k3 text := repeat('C', 88);
BEGIN
  PERFORM pg_temp.login(own); org := app.create_organisation('AG1 Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(other); org2 := app.create_organisation('AG1 Beta'); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, insp, 'active'), (org, noseat, 'active');
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = CASE ou.user_id WHEN insp THEN 'inspector' ELSE 'admin' END)
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id IN (insp, noseat);
  PERFORM pg_temp.give_controller_seat(org, own);
  PERFORM pg_temp.give_controller_seat(org2, other);

  -- ---- making a registration: Controller seat holders with integrations.manage only ----
  PERFORM pg_temp.login(noseat);
  t := pg_temp.fails(format($f$SELECT app.create_agent_registration(%L, %L, 'Newcastle')$f$, org, pg_temp.h('tok-1')));
  PERFORM pg_temp.assert_eq(left(t, 5), '42501', 'an admin without a Controller seat cannot make a registration');
  PERFORM pg_temp.login(insp);
  t := pg_temp.fails(format($f$SELECT app.create_agent_registration(%L, %L, 'Newcastle')$f$, org, pg_temp.h('tok-1')));
  PERFORM pg_temp.assert_eq(left(t, 5), '42501', 'nor can an inspector');
  PERFORM pg_temp.login(own);
  t := pg_temp.fails(format($f$SELECT app.create_agent_registration(%L, %L, 'Newcastle', NULL, 200)$f$, org, pg_temp.h('tok-1')));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%7 days%', 'a registration lasts at most 7 days');
  t := pg_temp.fails(format($f$SELECT app.create_agent_registration(%L, %L, '  ')$f$, org, pg_temp.h('tok-1')));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%name%', 'a new agent needs a name');
  reg := app.create_agent_registration(org, pg_temp.h('tok-1'), 'Newcastle factory', 'Server room B');
  PERFORM pg_temp.assert_eq((SELECT token_hash FROM public.integration_agent_registrations WHERE id = reg), pg_temp.h('tok-1'), 'only the hash is kept');
  t := pg_temp.fails('INSERT INTO public.integration_agent_registrations (organisation_id, token_hash, name, expires_at) VALUES ('''
                     || org || ''', ''' || pg_temp.h('x') || ''', ''Sneaky'', now() + interval ''1 day'')');
  PERFORM pg_temp.assert_eq(left(t, 5), '42501', 'nobody inserts a registration directly');
  PERFORM pg_temp.logout();

  -- ---- registering: people cannot call the agent's functions; the API login can ----
  PERFORM pg_temp.login(own);
  t := pg_temp.fails(format($f$SELECT app.system_register_agent(%L, %L, %L, '0.1.0', 'Windows', 'ERP01', '{}', '203.0.113.5')$f$, pg_temp.h('tok-1'), k1, k2));
  PERFORM pg_temp.assert_eq(left(t, 5), '42501', 'a person cannot register an agent with the system function');
  PERFORM pg_temp.logout();
  t := pg_temp.api_fails(format($f$SELECT app.system_register_agent(%L, %L, %L, '0.1.0', 'Windows', 'ERP01', '{}', '203.0.113.5')$f$, pg_temp.h('wrong'), k1, k2));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%not valid%', 'an unknown token is refused');
  r := pg_temp.api(format($f$SELECT app.system_register_agent(%L, %L, %L, '0.1.0', 'Windows Server 2022', 'ERP01', '{"adapters": []}', '203.0.113.5')$f$, pg_temp.h('tok-1'), k1, k2));
  agent := (r ->> 'agentId')::uuid;
  PERFORM pg_temp.assert_eq(r ->> 'organisationName', 'AG1 Alpha', 'the agent learns which organisation it belongs to');
  PERFORM pg_temp.assert_eq((SELECT name || '|' || location || '|' || machine_name FROM public.integration_agents WHERE id = agent),
                            'Newcastle factory|Server room B|ERP01', 'the agent takes the registration''s name and location');
  t := pg_temp.api_fails(format($f$SELECT app.system_register_agent(%L, %L, %L, '0.1.0', 'Windows', 'ERP02', '{}', '203.0.113.5')$f$, pg_temp.h('tok-1'), k3, k2));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%not valid%', 'a token is used once');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.integration_agent_events WHERE agent_id = agent AND kind = 'registered'), 1::bigint, 'registration is written down');

  -- expired and cancelled tokens
  PERFORM pg_temp.login(own);
  reg := app.create_agent_registration(org, pg_temp.h('tok-old'), 'Old one');
  PERFORM pg_temp.logout();
  UPDATE public.integration_agent_registrations SET expires_at = now() - interval '1 minute' WHERE id = reg;
  t := pg_temp.api_fails(format($f$SELECT app.system_register_agent(%L, %L, %L, '0.1.0', 'Windows', 'X', '{}', NULL)$f$, pg_temp.h('tok-old'), k3, k2));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%not valid%', 'an expired token is refused');
  PERFORM pg_temp.login(own);
  reg := app.create_agent_registration(org, pg_temp.h('tok-cancel'), 'Cancelled one');
  PERFORM app.cancel_agent_registration(reg);
  PERFORM pg_temp.logout();
  t := pg_temp.api_fails(format($f$SELECT app.system_register_agent(%L, %L, %L, '0.1.0', 'Windows', 'X', '{}', NULL)$f$, pg_temp.h('tok-cancel'), k3, k2));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%not valid%', 'a cancelled token is refused');

  -- ---- identity, replay and the network rule ----
  r := pg_temp.api(format('SELECT app.system_agent_identity(%L)', agent));
  PERFORM pg_temp.assert_eq(r ->> 'signingKey', k1, 'the API gets the active signing key');
  PERFORM pg_temp.assert_eq((r ->> 'organisationId')::uuid, org, 'and the agent''s organisation');
  r := pg_temp.api(format($f$SELECT app.system_agent_seen(%L, %L, '203.0.113.5', '/x')$f$, agent, repeat('a', 32)));
  PERFORM pg_temp.assert_eq(r ->> 'ok', 'true', 'a fresh nonce is accepted');
  r := pg_temp.api(format($f$SELECT app.system_agent_seen(%L, %L, '203.0.113.5', '/x')$f$, agent, repeat('a', 32)));
  PERFORM pg_temp.assert_eq(r ->> 'reason', 'replay', 'the same nonce again is a replay');
  PERFORM pg_temp.login(own);
  PERFORM app.save_organisation_network(org, '{"name": "HQ", "network": "203.0.113.0/24"}', '203.0.113.10');
  PERFORM app.set_network_policy(org, 'enforce', '203.0.113.10');
  PERFORM pg_temp.logout();
  r := pg_temp.api(format($f$SELECT app.system_agent_seen(%L, %L, '203.0.113.5', '/x')$f$, agent, repeat('b', 32)));
  PERFORM pg_temp.assert_eq(r ->> 'network', 'allowed', 'an agent on an approved network is let in');
  r := pg_temp.api(format($f$SELECT app.system_agent_seen(%L, %L, '198.51.100.9', '/x')$f$, agent, repeat('c', 32)));
  PERFORM pg_temp.assert_eq(r ->> 'reason', 'network', 'an agent outside the approved networks is refused while enforced');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.access_denials WHERE organisation_id = org AND address = '198.51.100.9' AND user_id IS NULL), 1::bigint,
                            'and the attempt is recorded with no person');
  PERFORM pg_temp.login(own);
  PERFORM app.set_network_policy(org, 'off', '203.0.113.10');
  PERFORM pg_temp.logout();

  -- ---- heartbeat ----
  UPDATE public.integration_agents SET last_heartbeat_at = now() - interval '10 minutes' WHERE id = agent;
  r := pg_temp.api(format($f$SELECT app.system_agent_heartbeat(%L, '0.1.1', 'Windows Server 2022', 'ERP01', '{}', '203.0.113.5')$f$, agent));
  PERFORM pg_temp.assert_eq(r ->> 'jobsWaiting', 'false', 'nothing waiting yet');
  PERFORM pg_temp.assert_eq((SELECT agent_version FROM public.integration_agents WHERE id = agent), '0.1.1', 'the version is kept up to date');
  PERFORM pg_temp.assert_eq((SELECT string_agg(kind, ',' ORDER BY kind) FROM public.integration_agent_events WHERE agent_id = agent AND kind IN ('came_online', 'version_changed')),
                            'came_online,version_changed', 'coming back and a new version are written down');

  -- ---- jobs ----
  PERFORM pg_temp.login(insp);
  t := pg_temp.fails(format($f$SELECT app.request_agent_job(%L, 'ping')$f$, agent));
  PERFORM pg_temp.assert_true(t LIKE '42501%' OR t LIKE 'P0002%', 'an inspector cannot give an agent a job');
  PERFORM pg_temp.login(own);
  t := pg_temp.fails(format($f$SELECT app.request_agent_job(%L, 'extract')$f$, agent));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%ping%', 'only a ping in AG1');
  job := app.request_agent_job(agent, 'ping', '{}', 'ping-key-0001');
  PERFORM pg_temp.assert_eq(app.request_agent_job(agent, 'ping', '{}', 'ping-key-0001'), job, 'the same idempotency key gives the same job');
  PERFORM pg_temp.logout();
  r := pg_temp.api(format($f$SELECT app.system_agent_heartbeat(%L, '0.1.1', NULL, NULL, NULL, NULL)$f$, agent));
  PERFORM pg_temp.assert_eq(r ->> 'jobsWaiting', 'true', 'the heartbeat says a job is waiting');
  PERFORM pg_temp.assert_true(r ->> 'fastPollUntil' IS NOT NULL, 'and asks the agent to poll quickly');
  r := pg_temp.api(format('SELECT app.system_agent_next_job(%L, 60)', agent));
  PERFORM pg_temp.assert_eq((r ->> 'id')::uuid, job, 'the agent takes the job');
  PERFORM pg_temp.assert_eq(r ->> 'attempt', '1', 'first attempt');
  r := pg_temp.api(format('SELECT app.system_agent_next_job(%L, 60)', agent));
  PERFORM pg_temp.assert_true(r IS NULL, 'a leased job is not handed out twice');
  r := pg_temp.api(format($f$SELECT app.system_agent_job_report(%L, %L, 'ack', '{}')$f$, agent, job));
  PERFORM pg_temp.assert_eq(r ->> 'status', 'running', 'ack starts it');
  r := pg_temp.api(format($f$SELECT app.system_agent_job_report(%L, %L, 'complete', '{"result": {"pong": true}}')$f$, agent, job));
  PERFORM pg_temp.assert_eq(r ->> 'status', 'completed', 'complete finishes it');
  r := pg_temp.api(format($f$SELECT app.system_agent_job_report(%L, %L, 'complete', '{"result": {"pong": "again"}}')$f$, agent, job));
  PERFORM pg_temp.assert_eq(r ->> 'status', 'completed', 'a repeated report is accepted');
  PERFORM pg_temp.assert_eq((SELECT result ->> 'pong' FROM public.integration_agent_jobs WHERE id = job), 'true', 'and changes nothing');

  -- a lease that runs out with no attempts left fails the job; a failed report is written down
  PERFORM pg_temp.login(own); job2 := app.request_agent_job(agent, 'ping'); PERFORM pg_temp.logout();
  PERFORM pg_temp.api(format('SELECT app.system_agent_next_job(%L, 60)', agent));
  UPDATE public.integration_agent_jobs SET leased_until = now() - interval '1 second' WHERE id = job2;
  r := pg_temp.api(format('SELECT app.system_agent_next_job(%L, 60)', agent));
  PERFORM pg_temp.assert_true(r IS NULL, 'a ping (one attempt) is not handed out again');
  PERFORM pg_temp.assert_eq((SELECT status || ':' || error_kind FROM public.integration_agent_jobs WHERE id = job2), 'failed:lease_expired', 'it fails when its lease runs out');
  PERFORM pg_temp.login(own); job2 := app.request_agent_job(agent, 'ping'); PERFORM pg_temp.logout();
  PERFORM pg_temp.api(format('SELECT app.system_agent_next_job(%L, 60)', agent));
  r := pg_temp.api(format($f$SELECT app.system_agent_job_report(%L, %L, 'fail', '{"kind": "network", "message": "Could not reach the server", "transient": true}')$f$, agent, job2));
  PERFORM pg_temp.assert_eq(r ->> 'status', 'failed', 'a transient failure with no attempts left fails');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.integration_agent_events WHERE agent_id = agent AND kind = 'job_failed'), 1::bigint, 'and is written down');

  -- ---- another organisation and another agent ----
  PERFORM pg_temp.login(other);
  PERFORM app.create_agent_registration(org2, pg_temp.h('tok-b'), 'Beta agent');
  PERFORM pg_temp.assert_eq(pg_temp.count_rows(format('SELECT 1 FROM public.integration_agents WHERE organisation_id = %L', org)), 0::bigint, 'B cannot see A''s agents');
  t := pg_temp.fails(format($f$SELECT app.request_agent_job(%L, 'ping')$f$, agent));
  PERFORM pg_temp.assert_eq(left(t, 5), 'P0002', 'B cannot give A''s agent a job');
  t := pg_temp.fails(format($f$SELECT app.revoke_agent(%L, 'Not yours')$f$, agent));
  PERFORM pg_temp.assert_eq(left(t, 5), 'P0002', 'nor revoke it');
  PERFORM pg_temp.logout();
  r := pg_temp.api(format($f$SELECT app.system_register_agent(%L, %L, %L, '0.1.0', 'Windows', 'B01', '{}', NULL)$f$, pg_temp.h('tok-b'), k3, k2));
  agent2 := (r ->> 'agentId')::uuid;
  t := pg_temp.api_fails(format($f$SELECT app.system_agent_job_report(%L, %L, 'complete', '{}')$f$, agent2, job));
  PERFORM pg_temp.assert_eq(left(t, 5), 'P0002', 'an agent cannot report on another agent''s job');

  -- ---- rename, rotate, replace, revoke ----
  PERFORM pg_temp.login(own);
  PERFORM app.rename_agent(agent, 'Newcastle ERP', 'Rack 3');
  PERFORM pg_temp.assert_eq((SELECT kind FROM public.integration_agent_events WHERE agent_id = agent ORDER BY created_at DESC LIMIT 1), 'renamed', 'renaming is written down');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(pg_temp.api_fails(format('SELECT app.system_agent_rotate_key(%L, %L, %L)', agent, k3, k2)), 'ok', 'the agent rotates its key');
  PERFORM pg_temp.assert_eq((SELECT signing_key FROM public.integration_agent_keys WHERE agent_id = agent AND status = 'active'), k3, 'the new key is the active one');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.integration_agent_keys WHERE agent_id = agent AND status = 'retired'), 1::bigint, 'the old one is retired');
  PERFORM pg_temp.login(own);
  reg := app.create_agent_registration(org, pg_temp.h('tok-replace'), '', NULL, 24, agent);
  PERFORM pg_temp.logout();
  r := pg_temp.api(format($f$SELECT app.system_register_agent(%L, %L, %L, '0.2.0', 'Windows', 'ERP09', '{}', NULL)$f$, pg_temp.h('tok-replace'), k1, k2));
  PERFORM pg_temp.assert_eq((r ->> 'agentId')::uuid, agent, 'a replacement keeps the same agent');
  PERFORM pg_temp.assert_eq((SELECT signing_key || ':' || machine_name FROM public.integration_agent_keys k JOIN public.integration_agents a ON a.id = k.agent_id
                              WHERE k.agent_id = agent AND k.status = 'active'), k1 || ':ERP09', 'with the new machine''s key');

  PERFORM pg_temp.login(own);
  job2 := app.request_agent_job(agent, 'ping');
  t := pg_temp.fails(format($f$SELECT app.revoke_agent(%L, 'x')$f$, agent));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%why%', 'revoking needs a reason');
  PERFORM app.revoke_agent(agent, 'Server decommissioned');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_agent_jobs WHERE id = job2), 'cancelled', 'waiting jobs are cancelled');
  t := pg_temp.fails(format($f$SELECT app.request_agent_job(%L, 'ping')$f$, agent));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%revoked%', 'a revoked agent gets no more jobs');
  t := pg_temp.fails(format($f$SELECT app.create_agent_registration(%L, %L, '', NULL, 24, %L)$f$, org, pg_temp.h('tok-z'), agent));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%revoked%', 'nor can it be replaced');
  PERFORM pg_temp.logout();
  r := pg_temp.api(format($f$SELECT app.system_agent_seen(%L, %L, NULL, '/x')$f$, agent, repeat('d', 32)));
  PERFORM pg_temp.assert_eq(r ->> 'reason', 'revoked', 'its requests are refused at once');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.integration_agent_keys WHERE agent_id = agent AND status = 'active'), 0::bigint, 'and it has no active key');

  -- ---- never deleted, events frozen ----
  t := pg_temp.fails(format('DELETE FROM public.integration_agents WHERE id = %L', agent));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%never deleted%', 'an agent is never deleted');
  t := pg_temp.fails(format($f$UPDATE public.integration_agent_events SET kind = 'renamed' WHERE agent_id = %L$f$, agent));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%never changed%', 'events are never changed');

  -- deregistration by the agent itself
  PERFORM pg_temp.assert_eq(pg_temp.api_fails(format('SELECT app.system_agent_deregister(%L)', agent2)), 'ok', 'the agent deregisters');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_agents WHERE id = agent2), 'revoked', 'an uninstalled agent revokes itself');

  -- housekeeping
  UPDATE public.integration_agent_nonces SET seen_at = now() - interval '11 minutes';
  PERFORM pg_temp.assert_true((SELECT app.system_purge_agent_nonces() FROM (SELECT set_config('role', 'qms_api', true)) s) >= 1, 'old nonces are purged');
  PERFORM set_config('role', 'postgres', true);
END $$;

ROLLBACK;
