-- Connector agent AG3 (docs/connector-agent-plan.md): record sources, extraction jobs that come with a run, batches stored once and in order,
-- a run that waits for its agent and is then handed the batches, resume after a retry, failure and cancellation passed both ways, batches
-- unreadable by people, and isolation between organisations and agents.
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
CREATE FUNCTION pg_temp.api_fails(stmt text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN PERFORM pg_temp.api(stmt); RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;
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
CREATE FUNCTION pg_temp.batch(p_agent uuid, p_job uuid, p_seq int, p_sum text, p_key text, p_rows jsonb) RETURNS jsonb LANGUAGE sql AS $$
  SELECT pg_temp.api(format('SELECT app.system_agent_store_batch(%L, %L, %s, %L, %L, %L)', p_agent, p_job, p_seq, p_sum, p_key, p_rows))
$$;

INSERT INTO auth.users (id, email) VALUES
  ('ae000000-0000-0000-0000-000000000001', 'own@ag3.test'), ('ae000000-0000-0000-0000-000000000002', 'insp@ag3.test'),
  ('ae000000-0000-0000-0000-000000000003', 'other@ag3.test');

DO $$
DECLARE
  own uuid := 'ae000000-0000-0000-0000-000000000001'; insp uuid := 'ae000000-0000-0000-0000-000000000002'; other uuid := 'ae000000-0000-0000-0000-000000000003';
  org uuid; org2 uuid; r jsonb; agent uuid; agent2 uuid; kid uuid; conn uuid; filecon uuid; job uuid; run uuid; run2 uuid; t text; owner uuid := gen_random_uuid();
  cfg jsonb := '{"engine": "postgres", "server": "erp-db.factory.local", "port": 5432, "database": "erp", "authType": "password", "encrypt": true}';
  src jsonb := '{"schema": "erp", "object": "machines", "keyColumn": "code", "columns": ["code", "name", "site"], "filters": [{"column": "active", "op": "eq", "value": true}, {"column": "retired_on", "op": "is_null"}]}';
  sealed jsonb := jsonb_build_object('epk', repeat('A', 88) || '==', 'iv', repeat('B', 16), 'ct', repeat('C', 64));
  a_sum text := repeat('a', 64); b_sum text := repeat('b', 64);
BEGIN
  PERFORM pg_temp.login(own); org := app.create_organisation('AG3 Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(other); org2 := app.create_organisation('AG3 Beta'); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, insp, 'active');
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = 'inspector') FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id = insp;
  PERFORM pg_temp.give_controller_seat(org, own);
  PERFORM pg_temp.give_controller_seat(org2, other);
  PERFORM pg_temp.login(own); PERFORM app.create_agent_registration(org, pg_temp.h('tok-a'), 'Newcastle'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(other); PERFORM app.create_agent_registration(org2, pg_temp.h('tok-b'), 'Beta box'); PERFORM pg_temp.logout();
  agent := (pg_temp.api(format($f$SELECT app.system_register_agent(%L, %L, %L, '0.3.0', 'Windows', 'ERP01', '{}', NULL)$f$, pg_temp.h('tok-a'), repeat('A', 88), repeat('B', 88))) ->> 'agentId')::uuid;
  agent2 := (pg_temp.api(format($f$SELECT app.system_register_agent(%L, %L, %L, '0.3.0', 'Windows', 'B01', '{}', NULL)$f$, pg_temp.h('tok-b'), repeat('C', 88), repeat('D', 88))) ->> 'agentId')::uuid;
  SELECT id INTO kid FROM public.integration_agent_keys WHERE agent_id = agent AND status = 'active';

  PERFORM pg_temp.login(own);
  conn := app.create_agent_connection(org, agent, 'ERP database', 'erp', cfg);
  filecon := app.create_integration_connection(org, 'csv', 'Files', 'files', '{}');
  PERFORM app.set_agent_credential(conn, sealed, kid);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.agent_does(agent, 'complete', '{"result": {"stored": true}}');

  -- ---- record sources ----
  PERFORM pg_temp.login(insp);
  t := pg_temp.fails(format('SELECT app.set_integration_record_source(%L, ''machine'', %L)', conn, src));
  PERFORM pg_temp.assert_eq(left(t, 5), '42501', 'an inspector cannot choose where records are read from');
  PERFORM pg_temp.login(own);
  t := pg_temp.fails(format('SELECT app.set_integration_record_source(%L, ''machine'', %L)', filecon, src));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%Only a database connection%', 'only a database connection has record sources');
  t := pg_temp.fails(format('SELECT app.set_integration_record_source(%L, ''machine'', %L)', conn, src || '{"sql": "select 1"}'));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%Unknown record source setting "sql"%', 'no SQL can be given: ' || t);
  t := pg_temp.fails(format('SELECT app.set_integration_record_source(%L, ''machine'', %L)', conn, src || '{"columns": ["name", "site"]}'));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%identifies each row too%', 'the key column is always read');
  t := pg_temp.fails(format('SELECT app.set_integration_record_source(%L, ''machine'', %L)', conn, src || '{"columns": ["code", "code"]}'));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%listed twice%', 'a column is read once');
  t := pg_temp.fails(format('SELECT app.set_integration_record_source(%L, ''machine'', %L)', conn, src || '{"filters": [{"column": "x", "op": "like", "value": "a%%"}]}'));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%filter compares%', 'only the listed tests: ' || t);
  t := pg_temp.fails(format('SELECT app.set_integration_record_source(%L, ''machine'', %L)', conn, src || '{"filters": [{"column": "x", "op": "eq"}]}'));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%one value%', 'a comparison needs its value');
  t := pg_temp.fails(format('SELECT app.set_integration_record_source(%L, ''machine'', %L)', conn, src || '{"filters": [{"column": "x", "op": "is_null", "value": 1}]}'));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%takes no value%', 'is empty takes no value');
  t := pg_temp.fails(format('SELECT app.set_integration_record_source(%L, ''machine'', %L)', conn, src || jsonb_build_object('object', E'mach\nines')));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%table or view%', 'no control characters in a name');
  t := pg_temp.fails(format('SELECT app.set_integration_record_source(%L, ''widget'', %L)', conn, src));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%', 'only kinds of record Fortress imports: ' || t);
  PERFORM app.set_integration_record_source(conn, 'machine', src);
  PERFORM app.set_integration_record_source(conn, 'machine', src);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.integration_connection_events WHERE connection_id = conn AND note LIKE 'Machine records are read from erp.machines')::int, 1,
    'the history says where machines come from, once');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_connections WHERE id = conn), 'draft', 'choosing a source changes nothing about the approval');
  t := pg_temp.fails('INSERT INTO public.integration_record_sources (organisation_id, connection_id, entity_type, source) VALUES (' || quote_literal(org) || ', ' || quote_literal(conn) || ', ''part'', ''{}'')');
  PERFORM pg_temp.assert_eq(left(t, 5), '42501', 'nobody writes record sources directly');

  -- ---- a preview run comes with its extraction ----
  t := pg_temp.fails(format('SELECT app.request_integration_run(%L, ''machine'', ''incremental'')', conn));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%', 'no incremental reads yet: ' || t);
  run := app.request_integration_run(conn, 'machine', 'preview');
  r := (SELECT to_jsonb(j) FROM public.integration_agent_jobs j WHERE j.run_id = run);
  job := (r ->> 'id')::uuid;
  PERFORM pg_temp.assert_eq(r ->> 'kind', 'extract', 'the run has an extraction job');
  PERFORM pg_temp.assert_eq((r -> 'spec' -> 'request') - 'maxRows' - 'batchRows', src, 'the job carries the source as chosen');
  PERFORM pg_temp.assert_eq((r -> 'spec' -> 'request' ->> 'maxRows')::int, 1000, 'a preview reads at most 1,000 rows');
  PERFORM pg_temp.assert_eq(r -> 'spec' -> 'connection' ->> 'server', 'erp-db.factory.local', 'and the connection''s settings');
  t := pg_temp.fails(format('SELECT app.request_integration_run(%L, ''machine'', ''preview'')', conn));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%', 'one run at a time for a kind of record');
  PERFORM pg_temp.logout();

  -- it waits for the agent
  r := pg_temp.api(format('SELECT app.system_lease_integration_run(%L, %L, %L, 60)', org, run, owner));
  PERFORM pg_temp.assert_false((r ->> 'leased')::boolean, 'the run is not leased while the agent reads');
  PERFORM pg_temp.assert_true((r ->> 'waitingForAgent')::boolean, 'it says it is waiting for the agent');
  PERFORM pg_temp.assert_false(EXISTS (SELECT 1 FROM app.system_integration_runs_due(100) d WHERE d.run_id = run), 'the worker leaves it alone');

  r := pg_temp.api(format('SELECT app.system_agent_next_job(%L, 60)', agent));
  PERFORM pg_temp.assert_eq((r ->> 'id')::uuid, job, 'the agent takes the extraction');
  PERFORM pg_temp.assert_eq((r -> 'resume' ->> 'nextSeq')::int, 0, 'from the first batch');

  -- batches: once, in order
  r := pg_temp.batch(agent, job, 0, a_sum, 'M2', '[{"code": "M1", "name": "Lathe"}, {"code": "M2", "name": "Mill"}]');
  PERFORM pg_temp.assert_true((r ->> 'stored')::boolean, 'the first batch is stored');
  r := pg_temp.batch(agent, job, 0, a_sum, 'M2', '[{"code": "M1", "name": "Lathe"}, {"code": "M2", "name": "Mill"}]');
  PERFORM pg_temp.assert_true((r ->> 'duplicate')::boolean AND NOT (r ->> 'stored')::boolean, 'a batch sent twice is stored once');
  t := pg_temp.api_fails(format('SELECT app.system_agent_store_batch(%L, %L, 0, %L, ''M2'', ''[]'')', agent, job, b_sum));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%already received with different rows%', 'a different batch under a used number is refused');
  t := pg_temp.api_fails(format('SELECT app.system_agent_store_batch(%L, %L, 2, %L, ''M9'', ''[]'')', agent, job, b_sum));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%Batch 1 was expected next%', 'batches arrive in order');
  t := pg_temp.api_fails(format($f$SELECT app.system_agent_store_batch(%L, %L, 1, %L, NULL, '[1, 2]')$f$, agent, job, b_sum));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%object of column values%', 'rows are objects');
  t := pg_temp.api_fails(format('SELECT app.system_agent_store_batch(%L, %L, 1, %L, NULL, %L)', agent, job, b_sum, (SELECT jsonb_agg(jsonb_build_object('code', g)) FROM generate_series(1, 1001) g)));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%1,000 rows%', 'at most 1,000 rows a batch');
  t := pg_temp.api_fails(format('SELECT app.system_agent_store_batch(%L, %L, 1, %L, NULL, ''[]'')', agent2, job, b_sum));
  PERFORM pg_temp.assert_eq(left(t, 5), 'P0002', 'another agent cannot send rows for this job');
  r := pg_temp.batch(agent, job, 1, b_sum, 'M3', '[{"code": "M3", "name": "Press"}]');
  PERFORM pg_temp.assert_eq((r ->> 'rows')::int, 3, 'three rows so far');
  r := pg_temp.api(format('SELECT app.system_lease_integration_run(%L, %L, %L, 60)', org, run, owner));
  PERFORM pg_temp.assert_true(r ->> 'reason' LIKE '%3 rows read so far%', 'the run says how far the agent has got: ' || (r ->> 'reason'));

  -- a transient failure: the job is taken again and carries on where it stopped
  PERFORM pg_temp.api(format($f$SELECT app.system_agent_job_report(%L, %L, 'fail', '{"kind": "network", "message": "connection reset", "transient": true}')$f$, agent, job));
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_agent_jobs WHERE id = job), 'pending', 'it waits to be taken again');
  t := pg_temp.api_fails(format('SELECT app.system_agent_store_batch(%L, %L, 2, %L, NULL, ''[]'')', agent, job, b_sum));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%Take the job again%', 'no rows for a job not taken');
  r := pg_temp.api(format('SELECT app.system_agent_next_job(%L, 60)', agent));
  PERFORM pg_temp.assert_eq((r -> 'resume' ->> 'nextSeq')::int, 2, 'it resumes at batch 2');
  PERFORM pg_temp.assert_eq(r -> 'resume' ->> 'afterKey', 'M3', 'after the last key stored');
  PERFORM pg_temp.assert_eq((r -> 'resume' ->> 'rows')::int, 3, 'with three rows already stored');

  -- complete: only with every batch Fortress holds
  t := pg_temp.api_fails(format($f$SELECT app.system_agent_job_report(%L, %L, 'complete', '{"result": {"batches": 3, "rows": 4}}')$f$, agent, job));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%Fortress holds 2 (3 rows)%', 'a missing batch is noticed: ' || t);
  PERFORM pg_temp.api(format($f$SELECT app.system_agent_job_report(%L, %L, 'complete', '{"result": {"batches": 2, "rows": 3, "columns": [{"name": "code"}]}}')$f$, agent, job));
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_agent_jobs WHERE id = job), 'completed', 'the extraction is complete');
  PERFORM pg_temp.assert_true(EXISTS (SELECT 1 FROM app.system_integration_runs_due(100) d WHERE d.run_id = run), 'the run is due at once');
  r := pg_temp.api(format('SELECT app.system_lease_integration_run(%L, %L, %L, 60)', org, run, owner));
  PERFORM pg_temp.assert_true((r ->> 'leased')::boolean, 'the run is leased');
  PERFORM pg_temp.assert_eq((r -> 'agent' ->> 'batchCount')::int, 2, 'with two batches to read');
  r := pg_temp.api(format('SELECT app.system_integration_agent_batch(%L, %L, %L, 1)', org, run, owner));
  PERFORM pg_temp.assert_eq(r, '[{"code": "M3", "name": "Press"}]'::jsonb, 'the engine reads a batch through its lease');
  t := pg_temp.api_fails(format('SELECT app.system_integration_agent_batch(%L, %L, %L, 1)', org, run, gen_random_uuid()));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%lease%', 'not without the lease: ' || t);
  t := pg_temp.api_fails(format('SELECT app.system_integration_agent_batch(%L, %L, %L, 1)', org2, run, owner));
  PERFORM pg_temp.assert_eq(left(t, 5), 'P0002', 'nor for another organisation');
  r := pg_temp.batch(agent, job, 2, b_sum, NULL, '[]');
  PERFORM pg_temp.assert_false((r ->> 'stored')::boolean, 'a finished job takes no more rows');

  -- people never read the batches
  PERFORM pg_temp.login(own);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.integration_agent_batches)::int, 0, 'batches are not readable by people, even with integrations.read');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.integration_record_sources)::int, 1, 'record sources are');
  -- cancelling the run (it is leased, so cancel it as a person) is fine; the job is already complete
  PERFORM app.cancel_integration_run(run, 'Seen enough');

  -- ---- a run cancelled while the agent reads cancels the job ----
  run2 := app.request_integration_run(conn, 'machine', 'preview');
  job := (SELECT id FROM public.integration_agent_jobs WHERE run_id = run2);
  PERFORM app.cancel_integration_run(run2, 'Wrong table');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_agent_jobs WHERE id = job), 'cancelled', 'the job is cancelled with the run');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_true(pg_temp.api(format('SELECT app.system_agent_next_job(%L, 60)', agent)) IS NULL, 'the agent has nothing to do');

  -- ---- an extraction the agent cannot do fails its run ----
  PERFORM pg_temp.login(own); job := app.request_connection_job(conn, 'test_connection'); PERFORM pg_temp.logout();
  PERFORM pg_temp.agent_does(agent, 'complete', '{"result": {"ok": true, "message": "Signed in"}}');
  PERFORM pg_temp.login(own);
  PERFORM app.mark_integration_ready(conn);
  PERFORM app.activate_integration_connection(conn);
  run2 := app.request_integration_run(conn, 'machine', 'full');
  PERFORM pg_temp.assert_false((SELECT spec -> 'request' ? 'maxRows' FROM public.integration_agent_jobs WHERE run_id = run2), 'a full import reads the whole table');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.agent_does(agent, 'fail', '{"kind": "not_found", "message": "There is no table or view erp.machines that this sign-in can read"}');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_sync_runs WHERE id = run2), 'failed', 'the run fails');
  PERFORM pg_temp.assert_true((SELECT error_summary LIKE 'The connector agent could not read the records: There is no table%' FROM public.integration_sync_runs WHERE id = run2), 'with the agent''s reason');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.integration_run_errors WHERE run_id = run2)::int, 1, 'and an error row');

  -- ---- isolation ----
  PERFORM pg_temp.login(other);
  t := pg_temp.fails(format('SELECT app.set_integration_record_source(%L, ''part'', %L)', conn, src));
  PERFORM pg_temp.assert_eq(left(t, 5), 'P0002', 'another organisation cannot choose this connection''s sources');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.integration_record_sources)::int, 0, 'nor see them');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_true(pg_temp.api(format('SELECT app.system_agent_next_job(%L, 60)', agent2)) IS NULL, 'the other agent gets none of these jobs');

  -- ---- batches are cleared a week after their job ended ----
  UPDATE public.integration_agent_jobs SET finished_at = now() - interval '8 days' WHERE run_id = run;
  PERFORM pg_temp.api('SELECT to_jsonb(app.system_purge_integration_payloads(90))');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.integration_agent_batches b JOIN public.integration_agent_jobs j ON j.id = b.job_id WHERE j.run_id = run)::int, 0, 'old batches are cleared');

  -- removing a source
  PERFORM pg_temp.login(own);
  PERFORM app.set_integration_record_source(conn, 'machine', NULL);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.integration_record_sources)::int, 0, 'the source is removed');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
