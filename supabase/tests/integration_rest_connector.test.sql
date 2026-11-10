-- Integrations IN7: REST connection settings (where each kind of record is, paging, incremental), the organisation's allow-list of hosts, and the run rules
-- for a REST connection (records configured, host allowed, incremental configured, a template for a real import, a preview without one).
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('5e000000-0000-0000-0000-000000000a01', 'ann@rest.test'), ('5e000000-0000-0000-0000-000000000a02', 'bob@rest.test'), ('5e000000-0000-0000-0000-000000000a03', 'eve@rest.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

CREATE FUNCTION pg_temp.assert_true(p boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p IS NOT TRUE THEN RAISE EXCEPTION 'FAILED: %', label; END IF; END $$;

DO $$
DECLARE
  ann uuid := '5e000000-0000-0000-0000-000000000a01'; bob uuid := '5e000000-0000-0000-0000-000000000a02'; eve uuid := '5e000000-0000-0000-0000-000000000a03';
  org uuid; org2 uuid; r_viewer uuid; rest uuid; t uuid; run uuid; good jsonb; bad text; hosts text[];
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('REST Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('REST Beta'); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, bob, 'active');
  SELECT id INTO r_viewer FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, ou.id, r_viewer FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id = bob;
  PERFORM pg_temp.give_controller_seat(org, ann);
  PERFORM pg_temp.give_controller_seat(org2, eve);

  good := '{"baseUrl": "https://erp.example.com/api", "authType": "none", "testPath": "/health",
            "entities": {"machine": {"path": "/v1/machines", "recordsPath": "data", "query": {"site": "LEEDS"},
                                     "paging": {"style": "page", "pageSize": 100, "pageParam": "page", "sizeParam": "per_page", "firstPage": 1},
                                     "incremental": {"param": "updated_since", "field": "updatedAt"}},
                         "part": {"path": "/v1/parts", "paging": {"style": "cursor", "cursorParam": "after", "nextCursorPath": "meta.next"}},
                         "supplier": {"path": "/odata/Vendors", "recordsPath": "value", "paging": {"style": "next_link", "nextLinkPath": "@odata.nextLink"}}}}';

  -- ---- settings ----
  PERFORM pg_temp.assert_eq(app.integration_config_problem('rest_api', good), NULL::text, 'records, paging and incremental settings are accepted');
  PERFORM pg_temp.assert_eq(app.integration_config_problem('rest_api', good || '{"entities": {"part": {"path": "/v1/parts", "paging": {"style": "next_link", "nextLinkPath": "header"}}}}'), NULL::text, 'a next link in the Link header');
  FOREACH bad IN ARRAY ARRAY[
    '{"entities": {"part": {"path": "v1/parts"}}}',
    '{"entities": {"part": {"path": "//evil.example.com/x"}}}',
    '{"entities": {"part": {"path": "/a/../../admin"}}}',
    '{"entities": {"part": {"path": "/a/%2e%2e/admin"}}}',
    '{"entities": {"part": {"path": "/a?x=1"}}}',
    '{"entities": {"part": {"path": "/a#x"}}}',
    '{"entities": {"part": {"path": "/.."}}}',
    '{"entities": {"part": {"path": 7}}}',
    '{"entities": {"part": {"path": "/p", "recordsPath": "a..b"}}}',
    '{"entities": {"part": {"path": "/p", "url": "https://evil.example.com"}}}',
    '{"entities": {"part": {"path": "/p", "headers": {"Host": "evil"}}}}',
    '{"entities": {"part": {"path": "/p", "query": {"a b": "x"}}}}',
    '{"entities": {"part": {"path": "/p", "query": {"a": 1}}}}',
    '{"entities": {"part": {"path": "/p", "paging": {"style": "sometimes"}}}}',
    '{"entities": {"part": {"path": "/p", "paging": {"style": "page", "pageSize": 5000}}}}',
    '{"entities": {"part": {"path": "/p", "paging": {"style": "page", "pageSize": 1.5}}}}',
    '{"entities": {"part": {"path": "/p", "paging": {"style": "page", "firstPage": 2}}}}',
    '{"entities": {"part": {"path": "/p", "paging": {"style": "cursor"}}}}',
    '{"entities": {"part": {"path": "/p", "paging": {"style": "next_link"}}}}',
    '{"entities": {"part": {"path": "/p", "paging": {"style": "page", "pageParam": "p&x=1"}}}}',
    '{"entities": {"part": {"path": "/p", "paging": {"style": "page", "baseUrl": "https://evil.example.com"}}}}',
    '{"entities": {"part": {"path": "/p", "incremental": {"param": "since"}}}}',
    '{"entities": {"part": {"path": "/p", "incremental": {"param": "since", "field": "u", "op": ">"}}}}',
    '{"entities": {"invoice": {"path": "/p"}}}',
    '{"entities": ["part"]}',
    '{"testPath": "/../admin"}',
    '{"headers": {"X-A": "b"}}',
    '{"authType": "api_key", "apiKeyHeader": "Host"}',
    '{"authType": "api_key", "apiKeyHeader": "Proxy-Authorization"}',
    '{"authType": "api_key", "apiKeyHeader": "Cookie"}'
  ] LOOP
    PERFORM pg_temp.assert_true(app.integration_config_problem('rest_api', good || bad::jsonb) IS NOT NULL, 'refused: ' || bad);
  END LOOP;
  PERFORM pg_temp.assert_eq(app.integration_config_problem('rest_api', good || '{"entities": {"part": {"path": "/p", "paging": {"style": "cursor"}}}}'::jsonb),
    'Say where the answer gives the next cursor for part records', 'the problem is said in words');
  PERFORM pg_temp.assert_eq(app.integration_config_problem('rest_api', good || '{"authType": "api_key", "apiKeyHeader": "X-Api-Key"}'::jsonb), NULL::text, 'an ordinary API key header is fine');

  -- ---- a REST connection with its records ----
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_integration_connection(%L, 'rest_api', 'Bad', 'bad', %L::jsonb)$f$, org, good || '{"entities": {"part": {"path": "//evil"}}}')), 5), 'QM022', 'creating with a path that leaves the address is refused');
  rest := app.create_integration_connection(org, 'rest_api', 'ERP REST', 'erp-api', good);
  PERFORM app.record_integration_connection_test(rest, true, 'The API answered 200 at /api/health');
  PERFORM app.mark_integration_ready(rest);
  PERFORM app.activate_integration_connection(rest);
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_connections WHERE id = rest), 'active', 'an owner activates the connection they prepared');

  -- previews and runs
  run := app.request_integration_run(rest, 'machine', 'preview');
  PERFORM pg_temp.assert_true(run IS NOT NULL, 'a preview runs without a template, to see what the API sends');
  PERFORM app.cancel_integration_run(run, 'Test over');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.request_integration_run(%L, 'customer', 'preview')$f$, rest)), 5), 'QM022', 'a kind of record the connection does not configure cannot run');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.request_integration_run(%L, 'part', 'incremental')$f$, rest)), 5), 'QM022', 'incremental needs its parameter and field');
  t := app.create_integration_template(org, 'machine', 'ERP machines', NULL,
    '{"keyField": "id", "fields": [{"target": "code", "source": "code"}, {"target": "name", "source": "name"}], "settings": {"writeMode": "add_update", "matchExisting": true}}'::jsonb);
  run := app.request_integration_run(rest, 'machine', 'full', NULL, t);
  PERFORM pg_temp.assert_true((SELECT template_version_id IS NOT NULL FROM public.integration_sync_runs WHERE id = run), 'with a template it runs');
  PERFORM app.cancel_integration_run(run, 'Test over');
  run := app.request_integration_run(rest, 'machine', 'incremental', NULL, t);
  PERFORM pg_temp.assert_true(run IS NOT NULL, 'and incrementally where configured');
  PERFORM app.cancel_integration_run(run, 'Test over');
  PERFORM pg_temp.logout();

  -- ---- the allow-list ----
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.set_integration_allowed_hosts(%L, ARRAY['example.com'])$f$, org)), 5), '42501', 'a viewer cannot set the allowed hosts');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.set_integration_allowed_hosts(%L, ARRAY['example.com'])$f$, org)), 5), 'P0002', 'nor can another organisation');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.set_integration_allowed_hosts(%L, ARRAY['10.0.0.1'])$f$, org)), 5), 'QM022', 'an IP address is not a host name');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.set_integration_allowed_hosts(%L, ARRAY['erp.corp'])$f$, org)), 5), 'QM022', 'nor an internal name');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$UPDATE public.organisation_settings SET integration_allowed_hosts = '{evil.com}' WHERE organisation_id = %L$f$, org)), 5), '42501', 'the column is not written directly');
  hosts := app.set_integration_allowed_hosts(org, ARRAY[' Example.COM ', '.example.com', 'other.example.org']);
  PERFORM pg_temp.assert_eq(hosts, ARRAY['example.com', 'other.example.org'], 'names are trimmed, lower-cased and de-duplicated');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_connections WHERE id = rest), 'active', 'a connection to a sub-domain of an allowed host carries on');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(app.integration_host_allowed(org, 'https://erp.example.com/api'), true, 'a sub-domain is allowed');
  PERFORM pg_temp.assert_eq(app.integration_host_allowed(org, 'https://notexample.com/api'), false, 'a look-alike is not');
  PERFORM pg_temp.assert_eq(app.integration_host_allowed(org, 'https://example.com.evil.net/api'), false, 'nor a name that only starts with it');
  PERFORM pg_temp.login(ann);

  PERFORM app.set_integration_allowed_hosts(org, ARRAY['other.example.org']);
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_connections WHERE id = rest), 'paused', 'an active connection to a host no longer allowed is paused');
  PERFORM pg_temp.assert_true((SELECT count(*) FROM public.integration_connection_events WHERE connection_id = rest AND action = 'paused' AND note LIKE '%allowed hosts%') = 1, 'with the reason on record');
  PERFORM pg_temp.assert_true(array_to_string(app.integration_activation_problems(rest), ';') LIKE '%does not allow connections to erp.example.com%', 'and the problem is listed');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.request_integration_run(%L, 'machine', 'preview')$f$, rest)), 5), 'QM022', 'not even a preview reaches a host that is not allowed');

  PERFORM app.set_integration_allowed_hosts(org, '{}');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(app.integration_host_allowed(org, 'https://erp.example.com/api'), true, 'an empty list allows any public host');
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_true(app.request_integration_run(rest, 'machine', 'preview') IS NOT NULL, 'and the preview runs again');
  PERFORM pg_temp.logout();

  -- ---- the connector reads the list on the API login only ----
  PERFORM pg_temp.assert_eq(has_function_privilege('authenticated', 'app.system_integration_allowed_hosts(uuid)', 'EXECUTE'), false, 'people cannot call the connector''s read');
  PERFORM pg_temp.assert_eq(has_function_privilege('qms_api', 'app.system_integration_allowed_hosts(uuid)', 'EXECUTE'), true, 'the API login can');
  PERFORM pg_temp.assert_eq(app.system_integration_allowed_hosts(org2), '{}'::text[], 'another organisation''s list is its own');
END $$;

ROLLBACK;
