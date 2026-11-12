-- Background worker foundation (docs/workflow-engine-plan.md, WK1): the job queue (idempotency, leasing, back-off, final failure, expired leases,
-- cancelling), one tick at a time, outbox consumers that see every event once, the operators' health view, and who may call what.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
  ('3e100000-0000-0000-0000-000000000101', 'owner@worker.test', now()),
  ('3e100000-0000-0000-0000-000000000102', 'operator@worker.test', now());

CREATE FUNCTION pg_temp.assert_true(p boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p IS NOT TRUE THEN RAISE EXCEPTION 'FAILED: %', label; END IF; END $$;

CREATE FUNCTION pg_temp.login_aal(p_user uuid, p_aal text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
  PERFORM set_config('role', 'authenticated', true);
END $$;

DO $$
DECLARE
  owner uuid := '3e100000-0000-0000-0000-000000000101'; operator uuid := '3e100000-0000-0000-0000-000000000102';
  org uuid; j1 uuid; j2 uuid; j3 uuid; leased record; n integer; t1 record; t2 record; t3 record; h jsonb; e1 bigint; e2 bigint; e3 bigint;
BEGIN
  PERFORM pg_temp.login(owner); org := app.create_organisation('Worker Works', 'Plant A', 'PA', NULL); PERFORM pg_temp.logout();

  -- ---- who may call what ----
  PERFORM pg_temp.assert_eq(has_function_privilege('qms_api', 'app.system_enqueue_job(text,jsonb,uuid,text,timestamptz,integer)', 'execute'), true, 'the API login queues jobs');
  PERFORM pg_temp.assert_eq(has_function_privilege('qms_api', 'app.system_worker_begin(text,integer)', 'execute'), true, 'the API login runs ticks');
  PERFORM pg_temp.assert_eq(has_function_privilege('qms_api', 'app.system_outbox_read(text,integer)', 'execute'), true, 'the API login reads the outbox');
  PERFORM pg_temp.assert_eq(has_function_privilege('authenticated', 'app.system_enqueue_job(text,jsonb,uuid,text,timestamptz,integer)', 'execute'), false, 'people cannot queue jobs');
  PERFORM pg_temp.assert_eq(has_function_privilege('authenticated', 'app.system_lease_jobs(integer,integer)', 'execute'), false, 'people cannot lease jobs');
  PERFORM pg_temp.assert_eq(has_function_privilege('authenticated', 'app.system_outbox_read(text,integer)', 'execute'), false, 'people cannot read the outbox');
  PERFORM pg_temp.assert_eq(has_function_privilege('anon', 'app.platform_worker_health()', 'execute'), false, 'anonymous callers get nothing');
  PERFORM pg_temp.assert_eq(has_table_privilege('authenticated', 'app.worker_jobs', 'select'), false, 'people cannot read the queue');
  PERFORM pg_temp.assert_eq(has_table_privilege('qms_api', 'app.worker_jobs', 'select'), false, 'not even the API login reads it directly');

  -- ---- queueing ----
  j1 := app.system_enqueue_job('test.echo', '{"n": 1}', org, 'echo-1');
  PERFORM pg_temp.assert_eq(app.system_enqueue_job('test.echo', '{"n": 2}', org, 'echo-1'), j1, 'the same idempotency key gives back the same job');
  PERFORM pg_temp.assert_eq((SELECT payload ->> 'n' FROM app.worker_jobs WHERE id = j1), '1', 'and does not change it');
  j2 := app.system_enqueue_job('test.echo', '{}', NULL, NULL, now() + interval '1 hour');
  PERFORM pg_temp.assert_fails($q$SELECT app.system_enqueue_job('Not A Kind')$q$, 'a kind is lower-case words with dots');
  PERFORM pg_temp.assert_fails($q$SELECT app.system_enqueue_job('test.echo', '[1]'::jsonb)$q$, 'a payload is an object');

  -- ---- leasing ----
  SELECT count(*) INTO n FROM app.system_lease_jobs(10, 60);
  PERFORM pg_temp.assert_eq(n, 1, 'only the job that is due is leased');
  PERFORM pg_temp.assert_eq((SELECT status || '/' || attempts FROM app.worker_jobs WHERE id = j1), 'running/1', 'leasing counts the attempt');
  SELECT count(*) INTO n FROM app.system_lease_jobs(10, 60);
  PERFORM pg_temp.assert_eq(n, 0, 'a leased job is not leased again while its lease runs');

  -- ---- back-off, final failure ----
  PERFORM pg_temp.assert_eq(app.system_finish_job(j1, false, NULL, 'boom'), 'queued', 'a failure is tried again');
  PERFORM pg_temp.assert_true((SELECT run_at BETWEEN now() + interval '59 seconds' AND now() + interval '61 seconds' FROM app.worker_jobs WHERE id = j1), 'after a minute');
  UPDATE app.worker_jobs SET run_at = now() - interval '1 second' WHERE id = j1;
  PERFORM app.system_lease_jobs(10, 60);
  PERFORM app.system_finish_job(j1, false, NULL, 'boom again');
  PERFORM pg_temp.assert_true((SELECT run_at BETWEEN now() + interval '239 seconds' AND now() + interval '241 seconds' FROM app.worker_jobs WHERE id = j1), 'then after four');
  UPDATE app.worker_jobs SET attempts = 4, run_at = now() - interval '1 second' WHERE id = j1;
  PERFORM app.system_lease_jobs(10, 60);
  PERFORM pg_temp.assert_eq(app.system_finish_job(j1, false, NULL, 'still boom'), 'failed', 'the fifth failure is final');
  PERFORM pg_temp.assert_eq((SELECT last_error FROM app.worker_jobs WHERE id = j1), 'still boom', 'with its error');
  PERFORM pg_temp.assert_eq(app.system_finish_job(j1, true), 'failed', 'a finished job stays as it is');

  j3 := app.system_enqueue_job('test.unknown', '{}', org);
  PERFORM app.system_lease_jobs(10, 60);
  PERFORM pg_temp.assert_eq(app.system_finish_job(j3, false, NULL, 'No handler', false), 'failed', 'a job that can never succeed fails at once');

  -- ---- a lease that ran out ----
  j3 := app.system_enqueue_job('test.echo', '{}', org);
  PERFORM app.system_lease_jobs(10, 60);
  UPDATE app.worker_jobs SET leased_until = now() - interval '1 second' WHERE id = j3;
  SELECT * INTO leased FROM app.system_lease_jobs(10, 60);
  PERFORM pg_temp.assert_eq(leased.id, j3, 'a job whose worker stopped is due again');
  PERFORM pg_temp.assert_eq(leased.attempts, 2, 'and that counts as an attempt');
  PERFORM pg_temp.assert_eq(app.system_finish_job(j3, true, '{"ok": true}'), 'done', 'done');
  PERFORM pg_temp.assert_true((SELECT finished_at IS NOT NULL AND result ->> 'ok' = 'true' AND leased_until IS NULL FROM app.worker_jobs WHERE id = j3), 'with its result');

  -- ---- cancelling ----
  PERFORM pg_temp.assert_eq(app.system_cancel_job(j2, 'not needed'), 'cancelled', 'a waiting job can be cancelled');
  PERFORM pg_temp.assert_eq(app.system_cancel_job(j3), 'done', 'a finished one cannot');
  SELECT count(*) INTO n FROM app.system_lease_jobs(10, 60);
  PERFORM pg_temp.assert_eq(n, 0, 'nothing left to run');

  -- ---- ticks: one at a time ----
  SELECT * INTO t1 FROM app.system_worker_begin('test', 60);
  PERFORM pg_temp.assert_true(t1.acquired, 'the first tick takes the lease');
  SELECT * INTO t2 FROM app.system_worker_begin('pg_cron', 60);
  PERFORM pg_temp.assert_true(NOT t2.acquired, 'a second tick meanwhile does not');
  PERFORM pg_temp.assert_eq((SELECT outcome FROM app.worker_ticks WHERE id = t2.tick_id), 'skipped', 'and is recorded as skipped');
  PERFORM app.system_worker_end(t2.tick_id, 'done', '[]');
  PERFORM pg_temp.assert_eq((SELECT outcome FROM app.worker_ticks WHERE id = t2.tick_id), 'skipped', 'ending a skipped tick changes nothing');
  PERFORM pg_temp.assert_eq((SELECT lease_tick FROM app.worker_state), t1.tick_id, 'nor frees the other tick''s lease');
  PERFORM app.system_worker_end(t1.tick_id, 'partial', '[{"name": "email", "ok": false}]', 'email failed');
  PERFORM pg_temp.assert_true((SELECT outcome = 'partial' AND finished_at IS NOT NULL AND steps -> 0 ->> 'name' = 'email' FROM app.worker_ticks WHERE id = t1.tick_id), 'the tick keeps its steps');
  SELECT * INTO t3 FROM app.system_worker_begin('pg_cron', 60);
  PERFORM pg_temp.assert_true(t3.acquired, 'the lease is free again');
  UPDATE app.worker_state SET lease_until = now() - interval '1 second';
  SELECT * INTO t2 FROM app.system_worker_begin('pg_cron', 60);
  PERFORM pg_temp.assert_true(t2.acquired, 'a tick that died gives the lease up when it runs out');
  PERFORM app.system_worker_end(t3.tick_id, 'done');
  PERFORM pg_temp.assert_eq((SELECT lease_tick FROM app.worker_state), t2.tick_id, 'the late end of the dead tick does not free the new lease');
  PERFORM app.system_worker_end(t2.tick_id, 'done');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.system_worker_end(%s, 'skipped')$q$, t2.tick_id), 'a tick ends done, partial or error');

  -- ---- housekeeping ----
  INSERT INTO app.worker_ticks (source, started_at, outcome) VALUES ('test', now() - interval '8 days', 'done');
  UPDATE app.worker_jobs SET finished_at = now() - interval '31 days' WHERE id = j3;
  SELECT * INTO t1 FROM app.system_worker_begin('test', 60);
  PERFORM app.system_worker_end(t1.tick_id, 'done');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.worker_ticks WHERE started_at < now() - interval '7 days'), 0::bigint, 'old ticks are cleared');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.worker_jobs WHERE id = j3), 0::bigint, 'old finished jobs are cleared');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.worker_jobs WHERE id = j1), 1::bigint, 'recent failures are kept');

  -- ---- outbox consumers ----
  INSERT INTO public.outbox_events (organisation_id, event_type, entity_type, entity_id, created_at)
    VALUES (org, 'test.before', 'thing', gen_random_uuid(), now() - interval '1 hour');
  SELECT count(*) INTO n FROM app.system_outbox_read('workflows', 10);
  PERFORM pg_temp.assert_eq(n, 0, 'a new consumer does not see what was written before it');
  INSERT INTO public.outbox_events (organisation_id, event_type, entity_type, entity_id) VALUES (org, 'test.one', 'thing', gen_random_uuid()) RETURNING id INTO e1;
  INSERT INTO public.outbox_events (organisation_id, event_type, entity_type, entity_id) VALUES (org, 'test.two', 'thing', gen_random_uuid()) RETURNING id INTO e2;
  INSERT INTO public.outbox_events (organisation_id, event_type, entity_type, entity_id) VALUES (org, 'test.three', 'thing', gen_random_uuid()) RETURNING id INTO e3;
  PERFORM pg_temp.assert_eq((SELECT array_agg(id ORDER BY id) FROM app.system_outbox_read('workflows', 10)), ARRAY[e1, e2, e3], 'then every event, oldest first');
  PERFORM pg_temp.assert_eq((SELECT array_agg(id) FROM app.system_outbox_read('workflows', 1)), ARRAY[e1], 'a page at a time');
  PERFORM pg_temp.assert_eq(app.system_outbox_ack('workflows', ARRAY[e2]), 1, 'acknowledging one');
  PERFORM pg_temp.assert_eq(app.system_outbox_ack('workflows', ARRAY[e2, 999999999]), 0, 'again, or an unknown event, adds nothing');
  PERFORM pg_temp.assert_eq((SELECT array_agg(id ORDER BY id) FROM app.system_outbox_read('workflows', 10)), ARRAY[e1, e3], 'an event delivered out of order is not seen again, the one before it still is');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM app.system_outbox_read('webhooks', 10)), 3, 'another consumer has its own place: what one has had, the other still gets');
  PERFORM pg_temp.assert_eq((SELECT delivered FROM app.outbox_consumers WHERE name = 'workflows'), 1::bigint, 'the count of what was delivered');
  PERFORM pg_temp.assert_fails($q$SELECT app.system_outbox_ack('nobody', ARRAY[1::bigint])$q$, 'acknowledging for an unknown consumer is refused');
  PERFORM pg_temp.assert_fails($q$SELECT * FROM app.system_outbox_read('Bad Name', 1)$q$, 'a consumer has a plain name');

  -- ---- operators ----
  PERFORM pg_temp.login_aal(owner, 'aal2');
  PERFORM pg_temp.assert_fails($q$SELECT app.platform_worker_health()$q$, 'a member who is not an operator sees nothing');
  PERFORM pg_temp.logout();
  INSERT INTO public.platform_admins (user_id, note) VALUES (operator, 'test operator');
  PERFORM pg_temp.login_aal(operator, 'aal1');
  PERFORM pg_temp.assert_fails($q$SELECT app.platform_worker_health()$q$, 'an operator needs two-factor');
  PERFORM pg_temp.login_aal(operator, 'aal2');
  h := app.platform_worker_health();
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(h -> 'lastTick' ->> 'outcome', 'done', 'the last tick that worked');
  PERFORM pg_temp.assert_true((h -> 'lastHour' ->> 'skipped')::int >= 1, 'skipped ticks are counted');
  PERFORM pg_temp.assert_eq((SELECT array_agg(f ->> 'kind' ORDER BY f ->> 'kind') FROM jsonb_array_elements(h -> 'jobs' -> 'failures') f), ARRAY['test.echo', 'test.unknown'], 'failures with their kind');
  PERFORM pg_temp.assert_true(h -> 'jobs' -> 'failures' -> 0 ? 'error' AND NOT (h -> 'jobs' -> 'failures' -> 0 ? 'payload'), 'and their error, never the payload');
  PERFORM pg_temp.assert_eq((SELECT (c ->> 'backlog')::int FROM jsonb_array_elements(h -> 'consumers') c WHERE c ->> 'name' = 'workflows'), 2, 'each consumer''s backlog');
END $$;

ROLLBACK;
