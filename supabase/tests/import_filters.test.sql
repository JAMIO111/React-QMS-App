-- Record filters on import templates (docs/import-filters-plan.md, F1): a filter is kept on the template version (validated, frozen, copied into the run's
-- settings), a record it leaves out is staged as skipped and counted as filtered, and a filtered record is never called "no longer in the source".
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES ('5f100000-0000-0000-0000-000000000a01', 'ann@filters.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;
CREATE FUNCTION pg_temp.assert_true(p boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p IS NOT TRUE THEN RAISE EXCEPTION 'FAILED: %', label; END IF; END $$;

-- A finished full read: kept rows (applied under their identifier) and filtered rows (skipped, with the source's own identifier or none).
CREATE FUNCTION pg_temp.full_read(p_org uuid, p_conn uuid, p_seen text[], p_filtered text[], p_filtered_no_id boolean DEFAULT false) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v_run uuid; x text; n integer := 0;
BEGIN
  INSERT INTO public.integration_sync_runs (organisation_id, connection_id, entity_type, kind, status, fetch_done, requested_by, settings, finished_at)
  VALUES (p_org, p_conn, 'supplier', 'full', 'running', true, '5f100000-0000-0000-0000-000000000a01', '{"onMissing": "list"}', NULL) RETURNING id INTO v_run;
  FOREACH x IN ARRAY p_seen LOOP
    INSERT INTO public.integration_inbox (organisation_id, connection_id, run_id, entity_type, external_id, status, last_run_id) VALUES (p_org, p_conn, v_run, 'supplier', x, 'unchanged', v_run);
  END LOOP;
  FOREACH x IN ARRAY p_filtered LOOP
    n := n + 1;
    INSERT INTO public.integration_inbox (organisation_id, connection_id, run_id, entity_type, external_id, status, last_run_id, filtered, source_external_id, errors)
    VALUES (p_org, p_conn, v_run, 'supplier', 'row-' || n, 'skipped', v_run, true, x, '[{"field": null, "message": "Filtered out"}]');
  END LOOP;
  IF p_filtered_no_id THEN
    INSERT INTO public.integration_inbox (organisation_id, connection_id, run_id, entity_type, external_id, status, last_run_id, filtered, source_external_id, errors)
    VALUES (p_org, p_conn, v_run, 'supplier', 'row-x', 'skipped', v_run, true, NULL, '[{"field": null, "message": "Filtered out"}]');
  END IF;
  UPDATE public.integration_sync_runs SET status = 'succeeded', finished_at = now() WHERE id = v_run;
  PERFORM app.integration_detect_missing(v_run);
  RETURN v_run;
END $$;

DO $$
DECLARE
  ann uuid := '5f100000-0000-0000-0000-000000000a01'; org uuid; rest uuid; t uuid; t2 uuid; v integer; run uuid; owner uuid := gen_random_uuid(); res jsonb; seed_run uuid; s uuid; i integer;
  f jsonb := '{"mode": "keep", "match": "all", "rules": [{"column": "Status", "test": "equals", "value": "Active"}]}';
  body jsonb;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('Filters Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.give_controller_seat(org, ann);
  PERFORM pg_temp.login(ann);
  rest := app.create_integration_connection(org, 'rest_api', 'ERP', 'erp', '{"baseUrl": "https://erp.example.com/api", "authType": "none", "entities": {"supplier": {"path": "/v1/suppliers"}}}'::jsonb);
  PERFORM app.record_integration_connection_test(rest, true, 'ok');
  PERFORM app.mark_integration_ready(rest);
  PERFORM app.activate_integration_connection(rest);

  -- ---- a filter is kept on the template version ----
  body := jsonb_build_object('keyField', 'id', 'fields', jsonb_build_array(jsonb_build_object('target', 'code', 'source', 'code'), jsonb_build_object('target', 'name', 'source', 'name')),
                             'settings', jsonb_build_object('writeMode', 'add_update', 'filters', f));
  t := app.create_integration_template(org, 'supplier', 'Active suppliers', NULL, body);
  PERFORM pg_temp.assert_eq((SELECT settings -> 'filters' FROM public.integration_template_versions WHERE template_id = t AND version = 1), f, 'the filter is stored on version 1');
  PERFORM pg_temp.assert_eq((SELECT settings ->> 'writeMode' FROM public.integration_template_versions WHERE template_id = t AND version = 1), 'add_update', 'beside the other import settings');
  t2 := app.create_integration_template(org, 'supplier', 'No filter', NULL, jsonb_set(body, '{settings,filters}', '{"mode": "keep", "match": "all", "rules": []}'));
  PERFORM pg_temp.assert_eq((SELECT settings ? 'filters' FROM public.integration_template_versions WHERE template_id = t2), false, 'a filter with nothing to do is not kept');
  t2 := app.create_integration_template(org, 'supplier', 'Null filter', NULL, jsonb_set(body, '{settings,filters}', 'null'));
  PERFORM pg_temp.assert_eq((SELECT settings ? 'filters' FROM public.integration_template_versions WHERE template_id = t2), false, 'nor a null one');

  -- ---- a malformed filter is refused, with the reason ----
  PERFORM pg_temp.assert_true(pg_temp.fails(format($q$SELECT app.create_integration_template(%L, 'supplier', 'Bad 1', NULL, %L)$q$, org, jsonb_set(body, '{settings,filters,rules,0,test}', '"resembles"'))) LIKE 'QM022%choose a test%', 'an unknown test is refused');
  PERFORM pg_temp.assert_true(pg_temp.fails(format($q$SELECT app.create_integration_template(%L, 'supplier', 'Bad 2', NULL, %L)$q$, org, jsonb_set(body, '{settings,filters,mode}', '"drop"'))) LIKE 'QM022%keep or leave out%', 'an unknown mode is refused');
  PERFORM pg_temp.assert_true(pg_temp.fails(format($q$SELECT app.create_integration_template(%L, 'supplier', 'Bad 3', NULL, %L)$q$, org, jsonb_set(body, '{settings,filters,rules,0,column}', '""'))) LIKE 'QM022%choose a column%', 'a rule needs a column');
  PERFORM pg_temp.assert_true(pg_temp.fails(format($q$SELECT app.create_integration_template(%L, 'supplier', 'Bad 4', NULL, %L)$q$, org, jsonb_set(body, '{settings,filters,rules,0,sql}', '"1=1"'))) LIKE 'QM022%no setting called sql%', 'a rule takes no setting of its own making');
  PERFORM pg_temp.assert_true(pg_temp.fails(format($q$SELECT app.create_integration_template(%L, 'supplier', 'Bad 5', NULL, %L)$q$, org, jsonb_set(body, '{settings,filters,formula}', '"TRUE"'))) LIKE 'QM022%either rules or a formula%', 'rules and a formula together are refused');
  PERFORM pg_temp.assert_true(pg_temp.fails(format($q$SELECT app.create_integration_template(%L, 'supplier', 'Bad 6', NULL, %L)$q$, org,
    jsonb_set(body, '{settings,filters,rules}', (SELECT jsonb_agg(f -> 'rules' -> 0) FROM generate_series(1, 21))))) LIKE 'QM022%limited to 20 rules%', 'more than 20 rules are refused');
  PERFORM pg_temp.assert_true(pg_temp.fails(format($q$SELECT app.create_integration_template(%L, 'supplier', 'Bad 7', NULL, %L)$q$, org, jsonb_set(body, '{settings,filters,rules,0,as}', '"banana"'))) LIKE 'QM022%number or a date%', 'an unknown reading is refused');
  PERFORM pg_temp.assert_true(pg_temp.fails(format($q$SELECT app.create_integration_template(%L, 'supplier', 'Bad 8', NULL, %L)$q$, org, jsonb_set(body, '{settings,filters}', '"x"'))) LIKE 'QM022%set of rules%', 'a filter that is not an object is refused');

  -- ---- a changed filter is a new version with a reason; the same filter is no change ----
  PERFORM pg_temp.assert_true(pg_temp.fails(format($q$SELECT app.save_integration_template_version(%L, %L, 'Again')$q$, t, body)) LIKE 'QM022%', 'the same filter changes nothing');
  v := app.save_integration_template_version(t, jsonb_set(body, '{settings,filters,rules,0,value}', '"Approved"'), 'Only approved suppliers');
  PERFORM pg_temp.assert_eq(v, 2, 'a different filter is a new version');
  PERFORM pg_temp.assert_eq((SELECT settings #>> '{filters,rules,0,value}' FROM public.integration_template_versions WHERE template_id = t AND version = 2), 'Approved', 'with the new rule');
  PERFORM pg_temp.assert_eq((SELECT settings #>> '{filters,rules,0,value}' FROM public.integration_template_versions WHERE template_id = t AND version = 1), 'Active', 'and the old one untouched');
  v := app.save_integration_template_version(t, jsonb_set(body, '{settings}', '{"writeMode": "add_update"}'), 'No filter any more');
  PERFORM pg_temp.assert_eq((SELECT settings ? 'filters' FROM public.integration_template_versions WHERE template_id = t AND version = 3), false, 'taking the filter away is a version too');
  v := app.restore_integration_template_version(t, 1, 'Back to the first');
  PERFORM pg_temp.assert_eq((SELECT settings -> 'filters' FROM public.integration_template_versions WHERE template_id = t AND version = 4), f, 'bringing a version back brings its filter');
  t2 := app.duplicate_integration_template(t, 'Copy');
  PERFORM pg_temp.assert_eq((SELECT settings -> 'filters' FROM public.integration_template_versions WHERE template_id = t2), f, 'a duplicate keeps it');

  -- ---- the run takes the filter with it, frozen ----
  run := app.request_integration_run(rest, 'supplier', 'preview', NULL, t);
  PERFORM pg_temp.assert_eq((SELECT settings -> 'filters' FROM public.integration_sync_runs WHERE id = run), f, 'the run''s settings carry the template''s filter');
  PERFORM pg_temp.logout();
  PERFORM app.system_lease_integration_run(org, run, owner, 30);
  PERFORM pg_temp.assert_eq(app.system_integration_run_settings(org, run, owner) -> 'filters', f, 'and the engine can read it');

  -- ---- staging: a filtered record is skipped, marked and counted ----
  res := app.system_stage_integration_records(org, run, owner, jsonb_build_array(
    jsonb_build_object('externalId', 'A', 'payload', jsonb_build_object('id', 'A'), 'canonical', jsonb_build_object('code', 'A')),
    jsonb_build_object('externalId', NULL, 'sourceExternalId', 'B', 'filtered', true, 'skip', 'Filtered out: does not meet Status is "Active"', 'payload', jsonb_build_object('id', 'B')),
    jsonb_build_object('externalId', NULL, 'sourceExternalId', 'A', 'filtered', true, 'skip', 'Filtered out: does not meet Status is "Active"', 'payload', jsonb_build_object('id', 'A')),
    jsonb_build_object('externalId', NULL, 'filtered', true, 'skip', 'Filtered out: does not meet Status is "Active"', 'sourceRow', 4, 'payload', jsonb_build_object('name', 'no id'))), NULL, true);
  PERFORM pg_temp.assert_eq((res ->> 'filtered')::int, 3, 'the answer counts the filtered records');
  PERFORM pg_temp.assert_eq((res ->> 'skipped')::int, 3, 'which are also skipped');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_inbox WHERE run_id = run AND external_id = 'A'), 'previewed', 'the kept record is not rejected for sharing an identifier with a filtered one');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.integration_inbox WHERE run_id = run AND filtered AND status = 'skipped'), 3, 'filtered records are skipped and marked');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.integration_inbox WHERE run_id = run AND NOT filtered), 1, 'and the others are not');
  PERFORM pg_temp.assert_eq((SELECT errors -> 0 ->> 'message' FROM public.integration_inbox WHERE run_id = run AND source_external_id = 'B'), 'Filtered out: does not meet Status is "Active"', 'each says why');
  PERFORM pg_temp.assert_eq((SELECT filtered FROM public.integration_sync_runs WHERE id = run), 3, 'the run counts them');
  PERFORM pg_temp.assert_eq((SELECT source_external_id FROM public.integration_inbox WHERE run_id = run AND NOT filtered AND external_id = 'A'), NULL, 'only a filtered record keeps the source''s own identifier apart');
  -- the run page lists the records a filter left out, with a count, without reading the whole run (as a person who may read integrations)
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq(app.integration_run_filtered_count(run), 3, 'the filtered records of the run are counted');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM app.integration_run_filtered_rows(run, 50, 0)), 3, 'and listed');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM app.integration_run_filtered_rows(run, 2, 2)), 1, 'a page at a time');
  PERFORM pg_temp.assert_eq((SELECT bool_and(filtered AND status = 'skipped') FROM app.integration_run_filtered_rows(run, 50, 0)), true, 'only filtered, skipped rows');
  PERFORM pg_temp.assert_eq((SELECT errors -> 0 ->> 'message' FROM app.integration_run_filtered_rows(run, 50, 0) WHERE source_external_id = 'B'), 'Filtered out: does not meet Status is "Active"', 'each says why');
  PERFORM pg_temp.logout();
  PERFORM app.system_finish_integration_run(org, run, owner);

  -- ---- a filtered record is never "no longer in the source" ----
  INSERT INTO public.integration_sync_runs (organisation_id, connection_id, entity_type, kind, status, fetch_done, requested_by) VALUES (org, rest, 'supplier', 'full', 'succeeded', true, ann) RETURNING id INTO seed_run;
  FOR i IN 1 .. 10 LOOP
    INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'S' || i, 'Supplier ' || i) RETURNING id INTO s;
    INSERT INTO public.integration_external_records (organisation_id, connection_id, entity_type, external_id, internal_id, content_hash, first_run_id, last_run_id) VALUES (org, rest, 'supplier', 'S' || i, s, 'h', seed_run, seed_run);
  END LOOP;
  -- S1 and S2 are not read at all, S3 is filtered out, S4 is read: only S1 and S2 are missing
  run := pg_temp.full_read(org, rest, ARRAY['S4','S5','S6','S7','S8','S9','S10'], ARRAY['S3']);
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.integration_missing_records WHERE detected_run_id = run), 2, 'two records are missing from the read');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.integration_missing_records WHERE detected_run_id = run AND external_id = 'S3'), 0, 'a record the filter left out is not one of them');
  -- a record listed as missing that comes back only as a filtered row is returned (it is in the source)
  run := pg_temp.full_read(org, rest, ARRAY['S4','S5','S6','S7','S8','S9','S10'], ARRAY['S1']);
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_missing_records WHERE external_id = 'S1'), 'returned', 'a missing record that is now only filtered is in the source again');
  -- a filtered row whose own identifier could not be read could be any record: nothing is called missing from that read
  run := pg_temp.full_read(org, rest, ARRAY['S5','S6','S7','S8','S9','S10'], ARRAY[]::text[], true);
  PERFORM pg_temp.assert_true((SELECT missing ? 'skipped' FROM public.integration_sync_runs WHERE id = run), 'the check stops, as for a row with no identifier');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.integration_missing_records WHERE detected_run_id = run), 0, 'and nothing is listed from it');

  -- health: the last import's records read and filtered out
  UPDATE public.integration_sync_runs SET records_total = 10, filtered = 10, requested_at = now() + interval '1 hour' WHERE id = run;
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq((SELECT (h -> 'lastRun' ->> 'recordsTotal')::int FROM jsonb_array_elements(app.integration_health(org)) h WHERE h ->> 'connectionId' = rest::text AND h ->> 'entityType' = 'supplier'), 10, 'the health row says how many records the last import read');
  PERFORM pg_temp.assert_eq((SELECT (h -> 'lastRun' ->> 'filtered')::int FROM jsonb_array_elements(app.integration_health(org)) h WHERE h ->> 'connectionId' = rest::text AND h ->> 'entityType' = 'supplier'), 10, 'and how many the filter left out');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(has_function_privilege('anon', 'app.integration_run_filtered_rows(uuid, integer, integer)', 'EXECUTE'), false, 'the list of filtered rows is not for anyone signed out');
  PERFORM pg_temp.assert_eq(has_function_privilege('anon', 'app.integration_run_filtered_count(uuid)', 'EXECUTE'), false, 'nor is its count');

  -- the new function is not for people
  PERFORM pg_temp.assert_eq(has_function_privilege('authenticated', 'app.integration_filter_problem(jsonb)', 'EXECUTE'), false, 'people cannot call the filter check');
  PERFORM pg_temp.assert_eq(has_function_privilege('authenticated', 'app.integration_template_settings(text, jsonb)', 'EXECUTE'), false, 'nor the settings function');
END $$;

ROLLBACK;
