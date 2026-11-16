-- A run's rows counted and paged by app.integration_run_row_counts / app.integration_run_rows (20260315100000): the same answer as reading
-- integration_inbox under RLS, for the caller's own runs only, rows a later run worked on included once, and nothing for anyone who may not read it.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('5f000000-0000-0000-0000-000000000a01', 'ann@runrows.test'), ('5f000000-0000-0000-0000-000000000a02', 'bob@runrows.test'),
  ('5f000000-0000-0000-0000-000000000a04', 'eve@runrows.test');

DO $$
DECLARE
  ann uuid := '5f000000-0000-0000-0000-000000000a01'; bob uuid := '5f000000-0000-0000-0000-000000000a02'; eve uuid := '5f000000-0000-0000-0000-000000000a04';
  org uuid; org2 uuid; r_viewer uuid; conn uuid; run1 uuid; run2 uuid; via_rls text; via_fn text; first_ids text; page_ids text;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('Run Rows Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('Run Rows Beta'); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, bob, 'active');
  SELECT id INTO r_viewer FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, ou.id, r_viewer FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id = bob;
  PERFORM pg_temp.give_controller_seat(org, ann);

  PERFORM pg_temp.login(ann);
  conn := app.create_integration_connection(org, 'rest_api', 'ERP suppliers', 'erp', '{"baseUrl": "https://erp.example.com"}'::jsonb);
  run1 := app.request_integration_run(conn, 'supplier', 'preview');
  PERFORM app.cancel_integration_run(run1, 'make room for a second run');
  run2 := app.request_integration_run(conn, 'supplier', 'preview');
  PERFORM pg_temp.logout();

  -- Rows as the runner would leave them (written here as the table owner): 600 staged by run 1, of which 40 were last worked on by run 2,
  -- and 25 staged by run 2 itself.
  INSERT INTO public.integration_inbox (organisation_id, connection_id, run_id, entity_type, external_id, source_row, status, last_run_id)
  SELECT org, conn, run1, 'supplier', 'S-' || g, g, CASE WHEN g % 3 = 0 THEN 'rejected' ELSE 'previewed' END, CASE WHEN g <= 40 THEN run2 ELSE run1 END
  FROM generate_series(1, 600) g;
  INSERT INTO public.integration_inbox (organisation_id, connection_id, run_id, entity_type, external_id, source_row, status, last_run_id)
  SELECT org, conn, run2, 'supplier', 'T-' || g, g, 'staged', run2 FROM generate_series(1, 25) g;

  PERFORM pg_temp.login(ann);
  FOREACH via_rls IN ARRAY ARRAY[run1::text, run2::text] LOOP
    SELECT string_agg(status || '=' || n, ',' ORDER BY status) INTO via_fn FROM app.integration_run_row_counts(via_rls::uuid);
    SELECT string_agg(status || '=' || n, ',' ORDER BY status) INTO first_ids
      FROM (SELECT status, count(*) n FROM public.integration_inbox WHERE run_id = via_rls::uuid OR last_run_id = via_rls::uuid GROUP BY status) x;
    PERFORM pg_temp.assert_eq(via_fn, first_ids, 'the counts are what RLS shows for run ' || via_rls);
  END LOOP;
  PERFORM pg_temp.assert_eq((SELECT sum(n)::int FROM app.integration_run_row_counts(run2)), 65, 'run 2: its own 25 and the 40 it last worked on, each once');

  -- Paging: the same rows in the same order as the run page read them before.
  SELECT string_agg(id::text, ',' ORDER BY rn) INTO first_ids FROM (
    SELECT id, row_number() OVER (ORDER BY created_at, source_row NULLS LAST, id) rn FROM public.integration_inbox
    WHERE (run_id = run1 OR last_run_id = run1) AND status = 'previewed' ORDER BY created_at, source_row NULLS LAST, id LIMIT 30 OFFSET 30) x;
  SELECT string_agg(id::text, ',' ORDER BY ord) INTO page_ids FROM (SELECT id, row_number() OVER () ord FROM app.integration_run_rows(run1, 'previewed', 30, 30)) x;
  PERFORM pg_temp.assert_eq(page_ids, first_ids, 'a page of rows matches the RLS read, filter and order');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM app.integration_run_rows(run1, NULL, 10000, 0)), 500, 'a page is at most 500 rows');
  PERFORM pg_temp.logout();

  -- Nobody else gets anything: a viewer without integrations.read, another organisation.
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM app.integration_run_row_counts(run1)), 0, 'a viewer gets no counts');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM app.integration_run_rows(run1, NULL, 50, 0)), 0, 'and no rows');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve);
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM app.integration_run_row_counts(run1)), 0, 'another organisation gets no counts');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM app.integration_run_rows(run1, NULL, 50, 0)), 0, 'and no rows');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.assert_eq(has_function_privilege('anon', 'app.integration_run_row_counts(uuid)', 'execute'), false, 'anonymous callers cannot count');
  PERFORM pg_temp.assert_eq(has_function_privilege('anon', 'app.integration_run_rows(uuid,text,integer,integer)', 'execute'), false, 'or read rows');
END $$;

ROLLBACK;
