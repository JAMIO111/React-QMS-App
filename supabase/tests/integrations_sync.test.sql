-- Integrations IN2: the sync engine's database layer. A source imported twice stages twice but applies once; a failed row is kept and retryable; a preview
-- writes nothing; leases, limits, backoff, cursors, superseding, tenant isolation, the audit actor for integration work and the API-login-only runner.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('5e000000-0000-0000-0000-000000000a01', 'ann@sync.test'), ('5e000000-0000-0000-0000-000000000a02', 'bob@sync.test'),
  ('5e000000-0000-0000-0000-000000000a03', 'cat@sync.test'), ('5e000000-0000-0000-0000-000000000a04', 'eve@sync.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

-- Two suppliers' worth of source rows, as the API would send them.
CREATE FUNCTION pg_temp.rows(p_name_b text DEFAULT 'Bravo Ltd') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_array(
    jsonb_build_object('externalId', 'S-1', 'sourceRow', 2, 'payload', jsonb_build_object('code', 'S-1', 'name', 'Alpha Ltd')),
    jsonb_build_object('externalId', 'S-2', 'sourceRow', 3, 'payload', jsonb_build_object('code', 'S-2', 'name', p_name_b)))
$$;

DO $$
DECLARE
  ann uuid := '5e000000-0000-0000-0000-000000000a01'; bob uuid := '5e000000-0000-0000-0000-000000000a02'; cat uuid := '5e000000-0000-0000-0000-000000000a03'; eve uuid := '5e000000-0000-0000-0000-000000000a04';
  org uuid; org2 uuid; r_viewer uuid; r_qm uuid; conn uuid; conn2 uuid; run uuid; run2 uuid; run3 uuid; owner uuid := gen_random_uuid(); other uuid := gen_random_uuid();
  lease jsonb; todo jsonb; res jsonb; s1 uuid := gen_random_uuid(); s2 uuid := gen_random_uuid(); failed_row uuid; n integer; v text;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('Sync Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('Sync Beta'); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, bob, 'active'), (org, cat, 'active');
  SELECT id INTO r_viewer FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  SELECT id INTO r_qm FROM public.roles WHERE organisation_id = org AND key = 'quality_manager';
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, ou.id, r_viewer FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id = bob;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, ou.id, r_qm FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id = cat;
  PERFORM pg_temp.give_controller_seat(org, ann);
  PERFORM pg_temp.give_controller_seat(org, cat);

  PERFORM pg_temp.login(ann);
  -- An API connection (a file connection needs a file and a mapping, covered in integrations_files.test.sql).
  conn := app.create_integration_connection(org, 'rest_api', 'ERP suppliers', 'erp', '{"baseUrl": "https://erp.example.com"}'::jsonb);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.request_integration_run(%L, 'supplier', 'full')$f$, conn)), 5), 'QM022', 'a draft connection cannot import');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.request_integration_run(%L, 'widget', 'preview')$f$, conn)), 5), 'QM022', 'an unknown kind of record is refused');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.request_integration_run(%L, 'supplier', 'retry')$f$, conn)), 5), 'QM022', 'a retry is asked for with its own function');

  -- ---- preview: before activation, writes nothing ----
  run := app.request_integration_run(conn, 'supplier', 'preview');
  PERFORM pg_temp.assert_eq((SELECT requested_by FROM public.integration_sync_runs WHERE id = run), ann, 'the run records who asked');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.request_integration_run(%L, 'supplier', 'preview')$f$, conn)), 5), 'QM022', 'one run of a kind of record at a time');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.system_lease_integration_run(%L, %L, %L, 30)$f$, org, run, owner)), 5), '42501', 'a person cannot run the runner');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.integration_sync_runs), 0, 'a viewer does not see runs');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.cancel_integration_run(%L, 'not mine')$f$, run)), 5), '42501', 'and cannot cancel one');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.assert_eq((SELECT has_function_privilege('qms_api', 'app.system_stage_integration_records(uuid,uuid,uuid,jsonb,text,boolean)', 'execute')), true, 'the API login runs the runner');
  PERFORM pg_temp.assert_eq((SELECT has_function_privilege('authenticated', 'app.system_apply_integration_row(uuid,uuid,uuid,uuid,uuid,text)', 'execute')), false, 'signed-in people do not');

  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.system_lease_integration_run(%L, %L, %L, 30)$f$, org2, run, owner)), 5), 'P0002', 'another organisation''s id finds nothing');
  lease := app.system_lease_integration_run(org, run, owner, 30);
  PERFORM pg_temp.assert_eq((lease ->> 'leased')::boolean, true, 'the runner takes the lease');
  PERFORM pg_temp.assert_eq(lease ->> 'providerKey', 'rest_api', 'and learns the provider');
  PERFORM pg_temp.assert_eq((app.system_lease_integration_run(org, run, other, 30) ->> 'leased')::boolean, false, 'a second runner is turned away while the lease holds');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.system_stage_integration_records(%L, %L, %L, '[]'::jsonb, NULL, true)$f$, org, run, other)), 5), 'QM022', 'only the lease holder stages');
  res := app.system_stage_integration_records(org, run, owner, pg_temp.rows(), 'page-2', true);
  PERFORM pg_temp.assert_eq((res ->> 'toCreate')::int, 2, 'a preview says both would be created');
  PERFORM pg_temp.assert_eq(app.system_integration_rows_to_apply(org, run, owner, 100), '[]'::jsonb, 'a preview applies nothing');
  PERFORM pg_temp.assert_eq(app.system_finish_integration_run(org, run, owner), 'succeeded', 'the preview finishes');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.integration_external_records), 0, 'and wrote no map');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.integration_sync_cursors), 0, 'and moved no cursor');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.integration_inbox WHERE run_id = run AND status = 'previewed'), 2, 'its rows are kept as previewed');

  -- ---- activate, then a real import ----
  PERFORM pg_temp.login(ann); PERFORM app.record_integration_connection_test(conn, true, 'Connected'); PERFORM app.mark_integration_ready(conn); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat); PERFORM app.activate_integration_connection(conn); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ann);
  run := app.request_integration_run(conn, 'supplier', 'full');
  PERFORM pg_temp.logout();

  -- the runner works as the API login would: source integration, the run as correlation, the person who asked as the initiating user
  PERFORM set_config('app.source', 'integration', true), set_config('app.correlation_id', run::text, true), set_config('app.initiating_user', ann::text, true);
  lease := app.system_lease_integration_run(org, run, owner, 30);
  res := app.system_stage_integration_records(org, run, owner,
    pg_temp.rows() || jsonb_build_array(
      jsonb_build_object('externalId', 'S-1', 'payload', jsonb_build_object('code', 'S-1', 'name', 'Twice')),
      jsonb_build_object('payload', jsonb_build_object('name', 'No key')),
      jsonb_build_object('externalId', 'S-3', 'payload', jsonb_build_object('code', 'S-3'), 'errors', jsonb_build_array(jsonb_build_object('field', 'name', 'message', 'Name is required')))),
    'page-2', false);
  PERFORM pg_temp.assert_eq((res ->> 'received')::int, 5, 'all rows are staged');
  PERFORM pg_temp.assert_eq((res ->> 'rejected')::int, 3, 'a duplicate, a row with no key and a row with validation errors are rejected');
  PERFORM pg_temp.assert_eq((SELECT errors -> 0 ->> 'message' FROM public.integration_inbox WHERE run_id = run AND external_id = 'S-3'), 'Name is required', 'with the problem a person can act on');
  res := app.system_stage_integration_records(org, run, owner, jsonb_build_array(jsonb_build_object('externalId', 'S-2', 'payload', jsonb_build_object('code', 'S-2'))), NULL, true);
  PERFORM pg_temp.assert_eq((res ->> 'rejected')::int, 1, 'a record already staged in this run is a duplicate even on a later page');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.system_stage_integration_records(%L, %L, %L, '[]'::jsonb, NULL, true)$f$, org, run, owner)), 5), 'QM022', 'nothing is fetched once fetching is done');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.system_finish_integration_run(%L, %L, %L)$f$, org, run, owner)), 5), 'QM022', 'it cannot finish with rows waiting');

  todo := app.system_integration_rows_to_apply(org, run, owner, 100);
  PERFORM pg_temp.assert_eq(jsonb_array_length(todo), 2, 'two rows wait to be applied');
  PERFORM pg_temp.assert_eq(todo -> 0 ->> 'action', 'create', 'as new records');
  -- S-1 applies; S-2's importer fails
  PERFORM app.system_apply_integration_row(org, run, owner, (todo -> 0 ->> 'id')::uuid, s1, 'create');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.system_apply_integration_row(%L, %L, %L, %L, %L, 'create')$f$, org, run, owner, todo -> 0 ->> 'id', s1)), 5), 'QM022', 'a row is applied once');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.system_apply_integration_row(%L, %L, %L, %L, %L, 'create')$f$, org, run, owner, todo -> 1 ->> 'id', s1)), 5), 'QM022', 'one QMS record is never mapped from two source records');
  failed_row := (todo -> 1 ->> 'id')::uuid;
  PERFORM app.system_fail_integration_row(org, run, owner, failed_row, 'Supplier code is already used by another supplier', 'code');
  PERFORM pg_temp.assert_eq(app.system_finish_integration_run(org, run, owner), 'partial', 'some rows applied, some did not');
  PERFORM pg_temp.assert_eq((SELECT created FROM public.integration_sync_runs WHERE id = run), 1, 'one created');
  PERFORM pg_temp.assert_eq((SELECT failed FROM public.integration_sync_runs WHERE id = run), 1, 'one failed');
  PERFORM pg_temp.assert_eq((SELECT cursor FROM public.integration_sync_cursors WHERE connection_id = conn), NULL::text, 'the cursor is the run''s last one');
  PERFORM pg_temp.assert_eq((SELECT internal_id FROM public.integration_external_records WHERE connection_id = conn AND external_id = 'S-1'), s1, 'the map says which QMS record S-1 became');
  PERFORM pg_temp.assert_eq((SELECT actor_user_id FROM audit.events WHERE entity_type = 'integration_external_records' AND entity_id = s1::text), ann, 'the audit trail names the person who started the import');
  PERFORM pg_temp.assert_eq((SELECT source || '/' || correlation_id FROM audit.events WHERE entity_type = 'integration_external_records' AND entity_id = s1::text), 'integration/' || run::text, 'and says it came from this run');

  -- ---- the same source again: stages, applies nothing new for S-1 ----
  PERFORM pg_temp.login(ann); run2 := app.request_integration_run(conn, 'supplier', 'incremental'); PERFORM pg_temp.logout();
  PERFORM set_config('app.correlation_id', run2::text, true);
  PERFORM app.system_lease_integration_run(org, run2, owner, 30);
  n := (SELECT count(*)::int FROM audit.events WHERE entity_type = 'integration_external_records');
  res := app.system_stage_integration_records(org, run2, owner, pg_temp.rows(), 'page-9', true);
  PERFORM pg_temp.assert_eq((res ->> 'unchanged')::int, 1, 'S-1 is unchanged');
  todo := app.system_integration_rows_to_apply(org, run2, owner, 100);
  PERFORM pg_temp.assert_eq(jsonb_array_length(todo), 1, 'only S-2 is to apply');
  PERFORM app.system_apply_integration_row(org, run2, owner, (todo -> 0 ->> 'id')::uuid, s2, 'create');
  PERFORM pg_temp.assert_eq(app.system_finish_integration_run(org, run2, owner), 'succeeded', 'the second import succeeds');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.integration_external_records WHERE connection_id = conn), 2, 'two records mapped, no duplicates');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM audit.events WHERE entity_type = 'integration_external_records') - n, 1, 'the unchanged record wrote nothing at all');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_inbox WHERE id = failed_row), 'superseded', 'the older failed copy of S-2 is superseded');
  PERFORM pg_temp.assert_eq((SELECT cursor FROM public.integration_sync_cursors WHERE connection_id = conn), 'page-9', 'the cursor moved when the run finished');

  -- a changed record is an update; the map's hash moves, the QMS id stays
  PERFORM pg_temp.login(ann); run3 := app.request_integration_run(conn, 'supplier', 'incremental'); PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT cursor_start FROM public.integration_sync_runs WHERE id = run3), 'page-9', 'an incremental run starts from the stored cursor');
  PERFORM app.system_lease_integration_run(org, run3, owner, 30);
  PERFORM app.system_stage_integration_records(org, run3, owner, pg_temp.rows('Bravo Holdings'), 'page-10', true);
  todo := app.system_integration_rows_to_apply(org, run3, owner, 100);
  PERFORM pg_temp.assert_eq(todo -> 0 ->> 'action', 'update', 'a changed record is an update');
  PERFORM pg_temp.assert_eq((todo -> 0 ->> 'internalId')::uuid, s2, 'of the QMS record it maps to');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.system_apply_integration_row(%L, %L, %L, %L, %L, 'update')$f$, org, run3, owner, todo -> 0 ->> 'id', gen_random_uuid())), 5), 'QM022', 'it cannot be moved to a different QMS record');
  -- this time the importer fails, so the row waits for a retry
  PERFORM app.system_fail_integration_row(org, run3, owner, (todo -> 0 ->> 'id')::uuid, 'Database was busy', NULL);
  failed_row := (todo -> 0 ->> 'id')::uuid;
  PERFORM pg_temp.assert_eq(app.system_finish_integration_run(org, run3, owner), 'partial', 'one unchanged, one failed: partial');

  -- ---- retry ----
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.retry_integration_rows(%L, 'supplier', NULL)$f$, conn)), 5), '42501', 'a viewer cannot retry');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.retry_integration_rows(%L, 'customer', NULL)$f$, conn)), 5), 'QM022', 'nothing to retry for customers');
  run := app.retry_integration_rows(conn, 'supplier', NULL);
  PERFORM pg_temp.logout();
  PERFORM app.system_lease_integration_run(org, run, owner, 30);
  todo := app.system_integration_rows_to_apply(org, run, owner, 100);
  PERFORM pg_temp.assert_eq(jsonb_array_length(todo), 1, 'the failed row is offered again');
  PERFORM pg_temp.assert_eq(todo -> 0 ->> 'action', 'update', 'against the current map');
  PERFORM app.system_apply_integration_row(org, run, owner, failed_row, s2, 'update');
  PERFORM pg_temp.assert_eq(app.system_finish_integration_run(org, run, owner), 'succeeded', 'the retry succeeds');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_inbox WHERE id = failed_row), 'applied', 'the row is applied');
  PERFORM pg_temp.assert_eq((SELECT content_hash FROM public.integration_external_records WHERE external_id = 'S-2') = (SELECT content_hash FROM public.integration_inbox WHERE id = failed_row), true, 'and the map holds its hash');

  -- ---- a stale failed row is not applied over a newer one ----
  PERFORM pg_temp.login(ann); run := app.request_integration_run(conn, 'supplier', 'incremental'); PERFORM pg_temp.logout();
  PERFORM app.system_lease_integration_run(org, run, owner, 30);
  PERFORM app.system_stage_integration_records(org, run, owner, jsonb_build_array(jsonb_build_object('externalId', 'S-1', 'payload', jsonb_build_object('code', 'S-1', 'name', 'Old name'))), NULL, true);
  todo := app.system_integration_rows_to_apply(org, run, owner, 100);
  PERFORM app.system_fail_integration_row(org, run, owner, (todo -> 0 ->> 'id')::uuid, 'Busy', NULL);
  PERFORM app.system_finish_integration_run(org, run, owner);
  PERFORM pg_temp.login(ann); run2 := app.request_integration_run(conn, 'supplier', 'incremental'); PERFORM pg_temp.logout();
  PERFORM app.system_lease_integration_run(org, run2, owner, 30);
  PERFORM app.system_stage_integration_records(org, run2, owner, jsonb_build_array(jsonb_build_object('externalId', 'S-1', 'payload', jsonb_build_object('code', 'S-1', 'name', 'New name'))), NULL, true);
  todo := app.system_integration_rows_to_apply(org, run2, owner, 100);
  PERFORM app.system_apply_integration_row(org, run2, owner, (todo -> 0 ->> 'id')::uuid, s1, 'update');
  PERFORM app.system_finish_integration_run(org, run2, owner);
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.integration_inbox WHERE connection_id = conn AND status = 'failed'), 0, 'the newer copy superseded the older failed one');

  -- ---- run-level errors back off, then fail ----
  PERFORM pg_temp.login(ann); run := app.request_integration_run(conn, 'supplier', 'full'); PERFORM pg_temp.logout();
  PERFORM app.system_lease_integration_run(org, run, owner, 30);
  res := app.system_integration_run_error(org, run, owner, 'rate_limit', 'Too many requests', true, 120);
  PERFORM pg_temp.assert_eq(res ->> 'status', 'waiting', 'a transient error waits');
  PERFORM pg_temp.assert_eq((app.system_lease_integration_run(org, run, owner, 30) ->> 'leased')::boolean, false, 'and cannot be leased before the time');
  PERFORM pg_temp.assert_eq((SELECT run_id FROM app.system_integration_runs_due(10) WHERE run_id = run), NULL::uuid, 'nor is it due');
  FOR i IN 1..4 LOOP
    UPDATE public.integration_sync_runs SET next_attempt_at = now() WHERE id = run;
    PERFORM app.system_lease_integration_run(org, run, owner, 30);
    res := app.system_integration_run_error(org, run, owner, 'transient', 'Timed out', true, NULL);
  END LOOP;
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'after five attempts it fails');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.integration_run_errors WHERE run_id = run), 5, 'every attempt is on record');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$DELETE FROM public.integration_run_errors WHERE run_id = %L$f$, run)), 5), 'QM022', 'and the record cannot be removed');

  -- ---- the row limit ----
  PERFORM pg_temp.login(ann); run := app.request_integration_run(conn, 'supplier', 'full'); PERFORM pg_temp.logout();
  PERFORM app.system_lease_integration_run(org, run, owner, 30);
  UPDATE public.integration_sync_runs SET records_total = 99999 WHERE id = run;
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.system_stage_integration_records(%L, %L, %L, %L::jsonb, NULL, true)$f$, org, run, owner, pg_temp.rows())), 5), 'QM022', 'a run is limited to 100,000 rows');

  -- ---- cancel, pause and retire ----
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.cancel_integration_run(%L, '')$f$, run)), 5), 'QM022', 'cancelling needs a reason');
  PERFORM app.cancel_integration_run(run, 'Wrong file');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_sync_runs WHERE id = run), 'cancelled', 'the run is cancelled');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.system_finish_integration_run(%L, %L, %L)$f$, org, run, owner)), 5), 'QM022', 'the runner lost its lease');
  PERFORM pg_temp.login(ann);
  run := app.request_integration_run(conn, 'supplier', 'full');
  PERFORM app.pause_integration_connection(conn, 'Maintenance');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(app.system_lease_integration_run(org, run, owner, 30) ->> 'reason', 'The connection is not active', 'a paused connection does not import');
  PERFORM pg_temp.login(ann); PERFORM app.retire_integration_connection(conn, 'Replaced'); PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((app.system_lease_integration_run(org, run, owner, 30) ->> 'leased')::boolean, false, 'a retired connection does not import');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_sync_runs WHERE id = run), 'cancelled', 'and its waiting run is cancelled');

  -- ---- tenancy ----
  PERFORM pg_temp.login(eve);
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.integration_inbox), 0, 'another organisation sees no staged rows');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.integration_external_records), 0, 'nor the map');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.cancel_integration_run(%L, 'not mine')$f$, run)), 5), 'P0002', 'nor can it cancel a run');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.request_integration_run(%L, 'supplier', 'preview')$f$, conn)), 5), 'P0002', 'or start one');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$INSERT INTO public.integration_inbox (organisation_id, connection_id, run_id, entity_type, status, last_run_id) VALUES (%L, %L, %L, 'supplier', 'staged', %L)$f$, org, conn, run, run)), 5), '42501', 'nobody writes the inbox directly');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails($f$UPDATE public.integration_external_records SET content_hash = 'x'$f$), 5), '42501', 'or the map');
  PERFORM pg_temp.logout();

  -- ---- payload retention ----
  PERFORM pg_temp.assert_eq(left(pg_temp.fails($f$SELECT app.system_purge_integration_payloads(1)$f$), 5), 'QM022', 'payloads are kept a week at least');
  UPDATE public.integration_inbox SET created_at = now() - interval '100 days' WHERE connection_id = conn;
  n := app.system_purge_integration_payloads(90);
  PERFORM pg_temp.assert_eq(n > 0, true, 'old payloads are cleared');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.integration_inbox WHERE connection_id = conn AND payload IS NOT NULL AND status <> 'failed'), 0, 'all of them');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.integration_inbox WHERE connection_id = conn AND content_hash IS NULL), 0, 'their hashes stay');
END $$;

ROLLBACK;
