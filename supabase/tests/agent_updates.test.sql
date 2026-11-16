-- Connector agent AG6b (docs/connector-agent-plan.md §19): an operator publishes a signed release; an admin approves an update of one agent to it;
-- the job carries the manifest; its completion stages the update, the agent's next heartbeat at the new version applies it, a roll-back is
-- reported by the agent; releases are frozen and never deleted; withdrawing cancels waiting updates; only the right people can do each step.
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
CREATE FUNCTION pg_temp.login_aal(p_user uuid, p_aal text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
  PERFORM set_config('role', 'authenticated', true);
END $$;
CREATE FUNCTION pg_temp.manifest(v text, platform text DEFAULT 'win-x64') RETURNS text LANGUAGE sql AS $$
  SELECT format('{"format":"fortress-agent-release-v1","version":"%s","platform":"%s","url":"https://releases.example.com/agent-%s.zip","sha256":"%s","size":1048576,"notes":"Fixes","createdAt":"2026-11-16T09:00:00Z"}',
                v, platform, v, repeat('c', 64));
$$;
CREATE FUNCTION pg_temp.sig() RETURNS text LANGUAGE sql AS $$ SELECT repeat('S', 86) || '==' $$;

INSERT INTO auth.users (id, email) VALUES
  ('a6b00000-0000-0000-0000-000000000001', 'own@ag6b.test'), ('a6b00000-0000-0000-0000-000000000002', 'insp@ag6b.test'),
  ('a6b00000-0000-0000-0000-000000000003', 'op@ag6b.test'), ('a6b00000-0000-0000-0000-000000000004', 'other@ag6b.test');

DO $$
DECLARE
  own uuid := 'a6b00000-0000-0000-0000-000000000001'; insp uuid := 'a6b00000-0000-0000-0000-000000000002';
  op uuid := 'a6b00000-0000-0000-0000-000000000003'; other uuid := 'a6b00000-0000-0000-0000-000000000004';
  org uuid; org_b uuid; agent uuid; old_agent uuid; rel7 uuid; rel8 uuid; rel_linux uuid; rel_old uuid; upd uuid; upd2 uuid; job uuid; r jsonb; t text;
BEGIN
  PERFORM pg_temp.login(own); org := app.create_organisation('AG6b Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(other); org_b := app.create_organisation('AG6b Beta'); PERFORM pg_temp.logout();
  PERFORM pg_temp.give_controller_seat(org, own);
  PERFORM pg_temp.give_controller_seat(org_b, other);
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, insp, 'active');
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = 'inspector')
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id = insp;
  INSERT INTO public.platform_admins (user_id, note) VALUES (op, 'operator');
  PERFORM pg_temp.login(own);
  PERFORM app.create_agent_registration(org, pg_temp.h('tok-6b'), 'Newcastle');
  PERFORM app.create_agent_registration(org, pg_temp.h('tok-6b-old'), 'Old agent');
  PERFORM pg_temp.logout();
  agent := (pg_temp.api(format($f$SELECT app.system_register_agent(%L, %L, %L, '0.6.0', 'Windows', 'ERP01', '{"platform": "win-x64"}', NULL)$f$, pg_temp.h('tok-6b'), repeat('A', 88), repeat('B', 88))) ->> 'agentId')::uuid;
  old_agent := (pg_temp.api(format($f$SELECT app.system_register_agent(%L, %L, %L, '0.5.0', 'Windows', 'ERP02', '{}', NULL)$f$, pg_temp.h('tok-6b-old'), repeat('C', 88), repeat('D', 88))) ->> 'agentId')::uuid;

  -- ---- publishing is the operator's, with an MFA session ----
  PERFORM pg_temp.login(own);
  t := pg_temp.fails(format('SELECT app.platform_publish_agent_release(%L, %L, %L)', pg_temp.manifest('0.7.0'), pg_temp.sig(), repeat('a', 16)));
  PERFORM pg_temp.assert_true(t LIKE '42501%', 'an owner cannot publish a release: ' || t);
  PERFORM pg_temp.login_aal(op, 'aal1');
  t := pg_temp.fails(format('SELECT app.platform_publish_agent_release(%L, %L, %L)', pg_temp.manifest('0.7.0'), pg_temp.sig(), repeat('a', 16)));
  PERFORM pg_temp.assert_true(t LIKE '42501%', 'nor the operator without MFA: ' || t);
  PERFORM pg_temp.login_aal(op, 'aal2');
  rel7 := app.platform_publish_agent_release(pg_temp.manifest('0.7.0'), pg_temp.sig(), repeat('a', 16));
  rel8 := app.platform_publish_agent_release(pg_temp.manifest('0.8.0'), pg_temp.sig(), repeat('a', 16));
  rel_linux := app.platform_publish_agent_release(pg_temp.manifest('0.9.0', 'linux-x64'), pg_temp.sig(), repeat('a', 16));
  rel_old := app.platform_publish_agent_release(pg_temp.manifest('0.5.5'), pg_temp.sig(), repeat('a', 16));
  PERFORM pg_temp.assert_eq((SELECT manifest FROM public.integration_agent_releases WHERE id = rel7), pg_temp.manifest('0.7.0'), 'the manifest is kept exactly as signed');
  PERFORM pg_temp.assert_eq((SELECT url || ' ' || size_bytes FROM public.integration_agent_releases WHERE id = rel7),
                            'https://releases.example.com/agent-0.7.0.zip 1048576', 'its facts are read out of it');
  t := pg_temp.fails(format('SELECT app.platform_publish_agent_release(%L, %L, %L)', pg_temp.manifest('0.7.0'), pg_temp.sig(), repeat('a', 16)));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%published already%', 'a version is published once per platform: ' || t);
  t := pg_temp.fails(format('SELECT app.platform_publish_agent_release(%L, %L, %L)', replace(pg_temp.manifest('1.0.0'), 'https://', 'http://'), pg_temp.sig(), repeat('a', 16)));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%https%', 'the address must be https: ' || t);
  t := pg_temp.fails(format('SELECT app.platform_publish_agent_release(%L, %L, %L)', replace(pg_temp.manifest('1.0.0'), '1.0.0', '1.0'), pg_temp.sig(), repeat('a', 16)));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%three whole numbers%', 'the version is three numbers: ' || t);
  t := pg_temp.fails(format('SELECT app.platform_publish_agent_release(%L, %L, %L)', 'not json', pg_temp.sig(), repeat('a', 16)));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%not JSON%', 'a manifest is JSON: ' || t);
  t := pg_temp.fails(format('SELECT app.platform_publish_agent_release(%L, %L, %L)', pg_temp.manifest('1.0.1'), 'bad', repeat('a', 16)));
  PERFORM pg_temp.assert_true(t LIKE '23514%', 'a signature is 64 bytes in base64: ' || t);
  PERFORM pg_temp.logout();
  t := pg_temp.fails(format($f$UPDATE public.integration_agent_releases SET url = 'https://evil.example.com/x.zip' WHERE id = %L$f$, rel7));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%cannot be changed%', 'a published release is frozen, even for SQL: ' || t);
  t := pg_temp.fails(format('DELETE FROM public.integration_agent_releases WHERE id = %L', rel7));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%never deleted%', 'and never deleted: ' || t);
  PERFORM pg_temp.login(insp);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.integration_agent_releases)::int, 4, 'every signed-in person sees published releases');
  t := pg_temp.fails(format($f$INSERT INTO public.integration_agent_releases (version, platform, url, sha256, size_bytes, manifest, signature, key_id) VALUES ('1.2.3', 'win-x64', 'https://x.example.com/a.zip', %L, 1, '{}', %L, %L)$f$, repeat('d', 64), pg_temp.sig(), repeat('a', 16)));
  PERFORM pg_temp.assert_true(t LIKE '42501%', 'nobody writes the table: ' || t);

  -- ---- approving is integrations.manage's, for a newer release of the agent's platform ----
  t := pg_temp.fails(format('SELECT app.approve_agent_update(%L, %L)', agent, rel7));
  PERFORM pg_temp.assert_true(t LIKE '42501%' OR t LIKE 'P0002%', 'an inspector cannot approve: ' || t);
  PERFORM pg_temp.login(other);
  t := pg_temp.fails(format('SELECT app.approve_agent_update(%L, %L)', agent, rel7));
  PERFORM pg_temp.assert_true(t LIKE 'P0002%', 'another organisation cannot see the agent: ' || t);
  PERFORM pg_temp.login(own);
  t := pg_temp.fails(format('SELECT app.approve_agent_update(%L, %L)', agent, rel_linux));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%for linux-x64, but the agent runs on win-x64%', 'the platform must match: ' || t);
  t := pg_temp.fails(format('SELECT app.approve_agent_update(%L, %L)', agent, rel_old));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%already at version 0.6.0%', 'only a newer release: ' || t);
  t := pg_temp.fails(format('SELECT app.approve_agent_update(%L, %L)', old_agent, rel7));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%does not say which platform%', 'an agent from before updates is updated by hand: ' || t);
  upd := app.approve_agent_update(agent, rel7);
  t := pg_temp.fails(format('SELECT app.approve_agent_update(%L, %L)', agent, rel8));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%already under way%', 'one update at a time: ' || t);
  SELECT job_id INTO job FROM public.integration_agent_updates WHERE id = upd;
  PERFORM pg_temp.assert_eq((SELECT kind || ' ' || (spec ->> 'version') FROM public.integration_agent_jobs WHERE id = job), 'update_agent 0.7.0', 'an update job is given');
  PERFORM pg_temp.assert_eq((SELECT spec ->> 'manifest' FROM public.integration_agent_jobs WHERE id = job), pg_temp.manifest('0.7.0'), 'carrying the manifest exactly');
  PERFORM pg_temp.assert_eq((SELECT spec ->> 'updateId' FROM public.integration_agent_jobs WHERE id = job), upd::text, 'and the update it serves');
  PERFORM pg_temp.assert_eq((SELECT from_version || '>' || to_version || ' ' || status FROM public.integration_agent_updates WHERE id = upd), '0.6.0>0.7.0 waiting', 'the update waits');
  PERFORM pg_temp.logout();

  -- ---- the job's outcome moves it: completed = staged; the next heartbeat at the version = applied ----
  r := pg_temp.api(format('SELECT app.system_agent_next_job(%L, 60)', agent));
  PERFORM pg_temp.assert_eq(r ->> 'kind', 'update_agent', 'the agent takes the update job');
  PERFORM pg_temp.login(own);
  t := pg_temp.fails(format('SELECT app.cancel_agent_update(%L)', upd));
  PERFORM pg_temp.assert_true(t = 'ok', 'a waiting update can be cancelled: ' || t);
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_agent_jobs WHERE id = job), 'cancelled', 'cancelling stops its job');
  t := pg_temp.fails(format('SELECT app.cancel_agent_update(%L)', upd));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%not downloaded yet%', 'only once: ' || t);
  upd := app.approve_agent_update(agent, rel7);
  SELECT job_id INTO job FROM public.integration_agent_updates WHERE id = upd;
  PERFORM pg_temp.logout();
  r := pg_temp.api(format('SELECT app.system_agent_next_job(%L, 60)', agent));
  PERFORM pg_temp.api(format($f$SELECT app.system_agent_job_report(%L, %L, 'ack', '{}')$f$, agent, job));
  PERFORM pg_temp.api(format($f$SELECT app.system_agent_job_report(%L, %L, 'complete', '{"result": {"staged": true, "version": "0.7.0"}}')$f$, agent, job));
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_agent_updates WHERE id = upd), 'staged', 'a completed job stages the update');
  PERFORM pg_temp.login(own);
  t := pg_temp.fails(format('SELECT app.cancel_agent_update(%L)', upd));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%not downloaded yet%', 'a staged update cannot be cancelled: ' || t);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.api(format($f$SELECT app.system_agent_heartbeat(%L, '0.6.0', 'Windows', 'ERP01', '{"platform": "win-x64"}', '203.0.113.5')$f$, agent));
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_agent_updates WHERE id = upd), 'staged', 'still the old version: still staged');
  PERFORM pg_temp.api(format($f$SELECT app.system_agent_heartbeat(%L, '0.7.0', 'Windows', 'ERP01', '{"platform": "win-x64"}', '203.0.113.5')$f$, agent));
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_agent_updates WHERE id = upd), 'applied', 'back at the new version: applied');
  PERFORM pg_temp.assert_true((SELECT array_agg(kind ORDER BY created_at) FROM public.integration_agent_events WHERE agent_id = agent AND kind LIKE 'update%')
                              @> ARRAY['update_approved', 'update_cancelled', 'update_staged', 'update_applied'], 'every step is in the history');
  PERFORM pg_temp.assert_eq(pg_temp.api(format($f$SELECT to_jsonb(app.system_agent_update_report(%L, %L, 'rolled_back', 'late'))$f$, agent, upd)) #>> '{}', 'applied',
                            'a late report changes nothing');
  t := pg_temp.fails(format($f$UPDATE public.integration_agent_updates SET message = 'edited' WHERE id = %L$f$, upd));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%finished update%', 'a finished update is frozen, even for SQL: ' || t);

  -- ---- a roll-back is reported by the agent; a failed job fails the update ----
  PERFORM pg_temp.login(own);
  upd2 := app.approve_agent_update(agent, rel8);
  SELECT job_id INTO job FROM public.integration_agent_updates WHERE id = upd2;
  PERFORM pg_temp.logout();
  PERFORM pg_temp.api(format('SELECT app.system_agent_next_job(%L, 60)', agent));
  PERFORM pg_temp.api(format($f$SELECT app.system_agent_job_report(%L, %L, 'complete', '{"result": {"staged": true}}')$f$, agent, job));
  PERFORM pg_temp.assert_eq(pg_temp.api(format($f$SELECT to_jsonb(app.system_agent_update_report(%L, %L, 'rolled_back', 'The new version did not check in within 5 minutes'))$f$, agent, upd2)) #>> '{}',
                            'rolled_back', 'the agent reports a roll-back');
  PERFORM pg_temp.assert_eq((SELECT status || ': ' || message FROM public.integration_agent_updates WHERE id = upd2),
                            'rolled_back: The new version did not check in within 5 minutes', 'with its reason');
  PERFORM pg_temp.login(own);
  upd2 := app.approve_agent_update(agent, rel8);
  SELECT job_id INTO job FROM public.integration_agent_updates WHERE id = upd2;
  PERFORM pg_temp.logout();
  PERFORM pg_temp.api(format('SELECT app.system_agent_next_job(%L, 60)', agent));
  PERFORM pg_temp.api(format($f$SELECT app.system_agent_job_report(%L, %L, 'fail', '{"kind": "refused", "message": "The release is not signed by a key this agent trusts", "transient": false}')$f$, agent, job));
  PERFORM pg_temp.assert_eq((SELECT status || ': ' || message FROM public.integration_agent_updates WHERE id = upd2),
                            'failed: The release is not signed by a key this agent trusts', 'a refused update fails with the agent''s words');
  PERFORM pg_temp.login(own);
  t := pg_temp.fails(format($f$SELECT app.system_agent_update_report(%L, %L, 'applied', NULL)$f$, agent, upd2));
  PERFORM pg_temp.assert_true(t LIKE '42501%', 'people cannot report for the agent: ' || t);
  PERFORM pg_temp.logout();

  -- ---- withdrawing a release cancels the updates waiting for it ----
  PERFORM pg_temp.login(own);
  upd2 := app.approve_agent_update(agent, rel8);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login_aal(op, 'aal2');
  t := pg_temp.fails(format('SELECT app.platform_withdraw_agent_release(%L, %L)', rel8, 'x'));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%why%', 'withdrawing needs a reason: ' || t);
  PERFORM app.platform_withdraw_agent_release(rel8, 'Breaks SQL Server 2014');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.integration_agent_releases WHERE id = rel8)::int, 1, 'the operator still sees it');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_agent_updates WHERE id = upd2), 'cancelled', 'the waiting update is cancelled');
  PERFORM pg_temp.assert_eq((SELECT j.status FROM public.integration_agent_jobs j JOIN public.integration_agent_updates u ON u.job_id = j.id WHERE u.id = upd2),
                            'cancelled', 'and its job');
  PERFORM pg_temp.login(own);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.integration_agent_releases WHERE id = rel8)::int, 0, 'members no longer see it');
  t := pg_temp.fails(format('SELECT app.approve_agent_update(%L, %L)', agent, rel8));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%withdrawn%', 'a withdrawn release cannot be approved: ' || t);
  PERFORM pg_temp.login(other);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.integration_agent_updates)::int, 0, 'another organisation sees none of these updates');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
