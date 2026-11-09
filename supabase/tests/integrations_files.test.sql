-- Integrations IN3: uploaded files (folder rule, chunks, limits, parsed/failed), versioned mappings (reason, unchanged refused, frozen), runs that freeze the file and
-- the mapping, the runner reading a file a chunk at a time, retention clearing old files' rows, and tenant isolation.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('5f100000-0000-0000-0000-000000000a01', 'ann@files.test'), ('5f100000-0000-0000-0000-000000000a02', 'bob@files.test'),
  ('5f100000-0000-0000-0000-000000000a04', 'eve@files.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '5f100000-0000-0000-0000-000000000a01'; bob uuid := '5f100000-0000-0000-0000-000000000a02'; eve uuid := '5f100000-0000-0000-0000-000000000a04';
  org uuid; org2 uuid; r_viewer uuid; conn uuid; rest uuid; f uuid; f2 uuid; m1 uuid; m2 uuid; run uuid; owner uuid := gen_random_uuid(); lease jsonb; folder text;
  fields jsonb := '[{"target": "code", "source": "Code"}, {"target": "name", "source": "Name"}]';
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('Files Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('Files Beta'); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, bob, 'active');
  SELECT id INTO r_viewer FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, ou.id, r_viewer FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id = bob;
  PERFORM pg_temp.give_controller_seat(org, ann);
  PERFORM pg_temp.give_controller_seat(org2, eve);

  PERFORM pg_temp.login(ann);
  conn := app.create_integration_connection(org, 'csv', 'ERP export', 'erp', '{}'::jsonb);
  rest := app.create_integration_connection(org, 'rest_api', 'ERP API', 'erp-api', '{"baseUrl": "https://api.example.com"}'::jsonb);
  folder := org::text || '/integration/' || conn::text || '/';

  -- ---- storage: only into the connection's own folder ----
  PERFORM pg_temp.assert_eq(app.integration_file_allowed(folder || 'x-suppliers.csv', true), true, 'the owner may upload into the connection folder');
  PERFORM pg_temp.assert_eq(app.integration_file_allowed(org2::text || '/integration/' || conn::text || '/x.csv', true), false, 'not under another organisation');
  PERFORM pg_temp.assert_eq(app.integration_file_allowed(org::text || '/supplier/' || conn::text || '/x.csv', true), false, 'not in another kind of folder');

  -- ---- registering and reading a file ----
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.register_integration_file(%L, %L, 'a.csv', 10)$f$, conn, org2::text || '/integration/' || conn::text || '/a.csv')), 5), 'QM022', 'a path outside the folder is refused');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.register_integration_file(%L, %L, 'a.csv', 30000000)$f$, conn, folder || 'a.csv')), 5), 'QM022', 'over 25 MB is refused');
  f := app.register_integration_file(conn, folder || 'u1-suppliers.csv', 'suppliers.csv', 1200);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.add_integration_file_chunk(%L, 1, '[{"r": 2, "v": {}}]'::jsonb)$f$, f)), 5), 'QM022', 'chunks come in order');
  PERFORM app.add_integration_file_chunk(f, 0, '[{"r": 2, "v": {"Code": "S-1", "Name": "Alpha"}}, {"r": 3, "v": {"Code": "S-2", "Name": "Bravo"}}]'::jsonb);
  PERFORM app.add_integration_file_chunk(f, 1, '[{"r": 4, "v": {"Code": "S-3", "Name": "Charlie"}}]'::jsonb);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.finish_integration_file(%L, '{}'::text[], NULL, NULL)$f$, f)), 5), 'QM022', 'a parsed file needs column headings');
  PERFORM app.finish_integration_file(f, ARRAY['Code', 'Name'], NULL, NULL);
  PERFORM pg_temp.assert_eq((SELECT status || '/' || row_count || '/' || chunk_count FROM public.integration_files WHERE id = f), 'parsed/3/2', 'parsed with its rows counted');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.add_integration_file_chunk(%L, 2, '[{"r": 5, "v": {}}]'::jsonb)$f$, f)), 5), 'QM022', 'a parsed file takes no more rows');

  f2 := app.register_integration_file(conn, folder || 'u2-broken.xlsx', 'broken.xlsx', 80);
  PERFORM app.add_integration_file_chunk(f2, 0, '[{"r": 2, "v": {"A": "1"}}]'::jsonb);
  PERFORM app.finish_integration_file(f2, NULL, NULL, 'The file is not a valid Excel workbook');
  PERFORM pg_temp.assert_eq((SELECT status || '/' || row_count FROM public.integration_files WHERE id = f2), 'failed/0', 'a file that could not be read keeps no rows');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.integration_file_chunks WHERE file_id = f2), 0, 'its chunks are cleared');

  -- ---- mappings ----
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.save_integration_mapping(%L, 'supplier', '', %L::jsonb, NULL)$f$, conn, fields)), 5), 'QM022', 'a key column is needed');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.save_integration_mapping(%L, 'supplier', 'Code', '[{"source": "Code"}]'::jsonb, NULL)$f$, conn)), 5), 'QM022', 'every field names a target');
  m1 := app.save_integration_mapping(conn, 'supplier', 'Code', fields, NULL);
  PERFORM pg_temp.assert_eq((SELECT version FROM public.integration_mappings WHERE id = m1), 1, 'the first mapping is version 1 and needs no reason');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.save_integration_mapping(%L, 'supplier', 'Code', %L::jsonb, 'Again')$f$, conn, fields)), 5), 'QM022', 'an unchanged mapping is refused');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.save_integration_mapping(%L, 'supplier', 'Code', '[{"target": "code", "source": "Code"}]'::jsonb, NULL)$f$, conn)), 5), 'QM022', 'a change needs a reason');
  -- machines, employees, gauge types, gauges and non-conformances can be mapped too (migration 20260111100000)
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM unnest(ARRAY['machine', 'employee', 'gauge_type', 'gauge', 'nonconformance']) e
    WHERE app.save_integration_mapping(conn, e, 'Ref', '[{"target": "name", "source": "Name"}]'::jsonb, NULL) IS NOT NULL), 5, 'each new kind of record can be mapped');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.integration_mappings WHERE connection_id = conn AND entity_type IN ('machine', 'employee', 'gauge_type', 'gauge', 'nonconformance') AND version = 1), 5, 'as version 1');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.save_integration_mapping(%L, 'calibration', 'Ref', '[{"target": "name", "source": "Name"}]'::jsonb, NULL)$f$, conn)), 5), 'QM022', 'a kind of record not on the list is refused');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$UPDATE public.integration_mappings SET key_field = 'X' WHERE id = %L$f$, m1)), 5), 'QM022', 'a saved version is never changed, even by SQL');
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.save_integration_mapping(%L, 'supplier', 'Code', %L::jsonb, 'x')$f$, conn, fields)), 5), '42501', 'a viewer cannot map');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.integration_files), 0, 'a viewer sees no files');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ann);

  -- ---- runs freeze the file and the mapping ----
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.request_integration_run(%L, 'supplier', 'preview')$f$, conn)), 5), 'QM022', 'a file connection needs a file');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.request_integration_run(%L, 'supplier', 'preview', %L)$f$, conn, f2)), 5), 'QM022', 'a file that could not be read is refused');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.request_integration_run(%L, 'customer', 'preview', %L)$f$, conn, f)), 5), 'QM022', 'a kind of record with no mapping is refused');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.request_integration_run(%L, 'supplier', 'preview', %L)$f$, rest, f)), 5), 'QM022', 'only a file connection takes a file');
  run := app.request_integration_run(conn, 'supplier', 'preview', f);
  PERFORM pg_temp.assert_eq((SELECT file_id = f AND mapping_id = m1 FROM public.integration_sync_runs WHERE id = run), true, 'the run keeps the file and the current mapping');
  m2 := app.save_integration_mapping(conn, 'supplier', 'Code', '[{"target": "code", "source": "Code"}, {"target": "name", "source": "Name", "transform": {"kind": "upper"}}]'::jsonb, 'Names in capitals');
  PERFORM pg_temp.assert_eq((SELECT superseded_at IS NOT NULL FROM public.integration_mappings WHERE id = m1), true, 'the new version supersedes the old');
  PERFORM pg_temp.assert_eq((SELECT mapping_id FROM public.integration_sync_runs WHERE id = run), m1, 'and the queued run keeps the mapping it was asked with');
  PERFORM pg_temp.logout();

  -- ---- the runner reads the file a chunk at a time ----
  PERFORM pg_temp.assert_eq((SELECT has_function_privilege('authenticated', 'app.system_integration_file_chunk(uuid,uuid,uuid,integer)', 'execute')), false, 'signed-in people cannot read chunks through the runner');
  lease := app.system_lease_integration_run(org, run, owner, 30);
  PERFORM pg_temp.assert_eq((lease -> 'file' ->> 'chunkCount')::int, 2, 'the lease says how many chunks there are');
  PERFORM pg_temp.assert_eq((lease -> 'mapping' ->> 'version')::int, 1, 'and which mapping version to apply');
  PERFORM pg_temp.assert_eq(jsonb_array_length(app.system_integration_file_chunk(org, run, owner, 0)), 2, 'chunk 0 has two rows');
  PERFORM pg_temp.assert_eq(app.system_integration_file_chunk(org, run, owner, 2), NULL::jsonb, 'past the end there is nothing');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.system_integration_file_chunk(%L, %L, %L, 0)$f$, org2, run, owner)), 5), 'P0002', 'another organisation finds nothing');
  PERFORM app.system_stage_integration_records(org, run, owner, '[]'::jsonb, NULL, true);
  PERFORM app.system_finish_integration_run(org, run, owner);

  -- ---- a file connection has no incremental imports ----
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.request_integration_run(%L, 'supplier', 'incremental', %L)$f$, conn, f)), 5), 'QM022', 'a file is imported whole');
  PERFORM pg_temp.logout();

  -- ---- retention clears old files' rows ----
  UPDATE public.integration_files SET uploaded_at = now() - interval '100 days' WHERE id = f;
  PERFORM app.system_purge_integration_payloads(90);
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_files WHERE id = f), 'purged', 'an old file is purged');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.integration_file_chunks WHERE file_id = f), 0, 'its rows are gone');
  PERFORM pg_temp.assert_eq((SELECT row_count FROM public.integration_files WHERE id = f), 3, 'the record of it stays');
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.request_integration_run(%L, 'supplier', 'preview', %L)$f$, conn, f)), 5), 'QM022', 'a purged file cannot be imported again');
  PERFORM pg_temp.logout();

  -- ---- tenancy ----
  PERFORM pg_temp.login(eve);
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.integration_files), 0, 'another organisation sees no files');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.integration_mappings), 0, 'nor mappings');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.register_integration_file(%L, %L, 'x.csv', 1)$f$, conn, folder || 'x.csv')), 5), 'P0002', 'nor register a file on the connection');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.add_integration_file_chunk(%L, 0, '[{"r": 2, "v": {}}]'::jsonb)$f$, f2)), 5), 'P0002', 'nor add rows to a file');
  PERFORM pg_temp.assert_eq(app.integration_file_allowed(folder || 'x.csv', false), false, 'nor read the folder');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
