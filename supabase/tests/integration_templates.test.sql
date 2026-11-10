-- Import templates (UI2a): the carry-over of existing mappings (fixture), organisation-wide templates with frozen versions (reason, unchanged refused,
-- bring back a version), names unique per kind of record, archive / restore, duplicate, only integrations.manage (Controller seat) writes, runs pinned
-- to a template version with its settings, the lease handing the version over as the mapping, and tenancy.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('5f900000-0000-0000-0000-000000000a01', 'ann@templates.test'), ('5f900000-0000-0000-0000-000000000a02', 'bob@templates.test'),
  ('5f900000-0000-0000-0000-000000000a03', 'eve@templates.test');

DO $$
DECLARE
  ann uuid := '5f900000-0000-0000-0000-000000000a01'; bob uuid := '5f900000-0000-0000-0000-000000000a02'; eve uuid := '5f900000-0000-0000-0000-000000000a03';
  org uuid; org2 uuid; r_viewer uuid; csv uuid; t1 uuid; t2 uuid; run uuid; f uuid; lease jsonb; body jsonb; n integer; carried uuid;
BEGIN
  -- ---- carry-over of the fixture's mappings ----
  SELECT id INTO carried FROM public.integration_templates WHERE name = 'Fixture files — machine';
  PERFORM pg_temp.assert_eq(carried IS NOT NULL, true, 'a connection''s mapping became a template named after the connection and the kind of record');
  PERFORM pg_temp.assert_eq((SELECT current_version FROM public.integration_templates WHERE id = carried), 2, 'its versions came in order');
  PERFORM pg_temp.assert_eq((SELECT fields::text FROM public.integration_template_versions WHERE template_id = carried AND version = 2),
    '[{"source": "Code", "target": "code"}, {"source": "Name", "target": "name", "transform": "upper"}]', 'the latest version holds the current mapping');
  PERFORM pg_temp.assert_eq((SELECT settings ->> 'writeMode' FROM public.integration_template_versions WHERE template_id = carried AND version = 2), 'add_update',
    'the current import settings went onto the latest version');
  PERFORM pg_temp.assert_eq((SELECT reason FROM public.integration_template_versions WHERE template_id = carried AND version = 2), 'Names too', 'the reason was kept');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.integration_templates WHERE name = 'Fixture uploads — machine'), 1, 'every connection and kind of record got one');
  PERFORM pg_temp.assert_eq(app.carry_integration_mappings_to_templates(), 0, 'carrying over again makes nothing new');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM audit.events WHERE entity_type = 'integration_templates'), 0, 'the carry-over is not recorded as a person''s change');

  -- ---- set-up ----
  PERFORM pg_temp.login(ann); org := app.create_organisation('Templates Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('Templates Beta'); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, bob, 'active');
  SELECT id INTO r_viewer FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, ou.id, r_viewer FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id = bob;
  PERFORM pg_temp.give_controller_seat(org, ann);
  PERFORM pg_temp.give_controller_seat(org2, eve);

  body := '{"keyField": "Id", "fields": [{"target": "code", "source": "Code", "steps": [{"kind": "trim"}, {"kind": "upper"}]}], "sourceSettings": {"hasHeader": true}, "expectedColumns": ["Id", "Code"], "settings": {"writeMode": "add_update", "matchExisting": true}}';

  -- ---- templates ----
  PERFORM pg_temp.login(ann);
  t1 := app.create_integration_template(org, 'machine', '  Plant list ', 'Machines from the plant list', body);
  PERFORM pg_temp.assert_eq((SELECT name || '/' || current_version FROM public.integration_templates WHERE id = t1), 'Plant list/1', 'a template is created with version 1, the name trimmed');
  PERFORM pg_temp.assert_eq((SELECT expected_columns::text FROM public.integration_template_versions WHERE template_id = t1), '{Id,Code}', 'it keeps the columns it was made against');
  PERFORM pg_temp.assert_eq((SELECT settings::text FROM public.integration_template_versions WHERE template_id = t1), '{"writeMode": "add_update", "matchExisting": true}', 'and its import settings');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.create_integration_template(%L, 'machine', 'PLANT LIST', NULL, %L)$q$, org, body), 'names are unique per kind of record, ignoring case');
  PERFORM pg_temp.assert_ok(format($q$SELECT app.create_integration_template(%L, 'part', 'Plant list', NULL, %L)$q$, org, body), 'the same name may be used for another kind of record');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.create_integration_template(%L, 'machine', 'Bad', NULL, '{"keyField": "", "fields": []}')$q$, org), 'a template needs a key column and fields');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.create_integration_template(%L, 'machine', 'Bad', NULL, '{"keyField": "Id", "fields": [{"target": "code"}], "settings": {"writeMode": "replace"}}')$q$, org), 'the write mode is checked');
  t2 := app.create_integration_template(org, 'nonconformance', 'NC log', NULL, body);
  PERFORM pg_temp.assert_eq((SELECT settings::text FROM public.integration_template_versions WHERE template_id = t2), '{"writeMode": "add_only", "matchExisting": false}', 'NCs are always add only, never matched');

  -- ---- versions ----
  PERFORM pg_temp.assert_fails(format($q$SELECT app.save_integration_template_version(%L, %L, 'Same again')$q$, t1, body), 'a version that changes nothing is refused');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.save_integration_template_version(%L, %L, '')$q$, t1, jsonb_set(body, '{keyField}', '"Ref"')), 'a new version needs a reason');
  n := app.save_integration_template_version(t1, jsonb_set(body, '{keyField}', '"Ref"'), 'The plant list now uses Ref');
  PERFORM pg_temp.assert_eq(n, 2, 'a new version is numbered on');
  PERFORM pg_temp.assert_eq((SELECT expected_columns::text FROM public.integration_template_versions WHERE template_id = t1 AND version = 2), '{Id,Code}', 'expected columns carry on when not given');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.integration_template_versions SET key_field = 'X' WHERE template_id = %L$q$, t1), 'nobody writes versions directly');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.integration_template_versions SET key_field = 'X' WHERE template_id = %L$q$, t1), 'a saved version never changes, even for SQL');
  PERFORM pg_temp.login(ann);
  n := app.restore_integration_template_version(t1, 1, 'Back to Id');
  PERFORM pg_temp.assert_eq((SELECT key_field || '/' || version FROM public.integration_template_versions WHERE template_id = t1 AND version = n), 'Id/3', 'bringing back version 1 saves it as version 3');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.restore_integration_template_version(%L, 3, 'Again')$q$, t1), 'bringing back the current version changes nothing and is refused');

  -- ---- rename, archive, restore, duplicate ----
  PERFORM app.update_integration_template(t1, 'Plant machines', 'From the plant list');
  PERFORM pg_temp.assert_eq((SELECT name FROM public.integration_templates WHERE id = t1), 'Plant machines', 'a template can be renamed');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.archive_integration_template(%L, '')$q$, t1), 'archiving needs a reason');
  PERFORM app.archive_integration_template(t1, 'Replaced by the ERP feed');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.save_integration_template_version(%L, %L, 'While archived')$q$, t1, jsonb_set(body, '{keyField}', '"Z"')), 'an archived template cannot change');
  PERFORM app.restore_integration_template(t1);
  PERFORM pg_temp.assert_eq((SELECT archived_at IS NULL FROM public.integration_templates WHERE id = t1), true, 'and can be restored');
  t2 := app.duplicate_integration_template(t1, NULL);
  PERFORM pg_temp.assert_eq((SELECT name || '/' || current_version FROM public.integration_templates WHERE id = t2), 'Copy of Plant machines/1',
    'a duplicate copies the current version into a new template');
  PERFORM pg_temp.assert_eq((SELECT key_field FROM public.integration_template_versions WHERE template_id = t2), 'Id', 'with the current version''s content');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM audit.events WHERE entity_type = 'integration_template_versions') > 0, true, 'template versions are audited');

  -- ---- permissions and tenancy ----
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_fails(format($q$SELECT app.create_integration_template(%L, 'machine', 'Mine', NULL, %L)$q$, org, body), 'only people who manage integrations save templates');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.archive_integration_template(%L, 'Not mine')$q$, t1), 'nor archive them');
  PERFORM pg_temp.login(eve);
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.integration_templates WHERE organisation_id = org), 0, 'another organisation sees no templates');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.update_integration_template(%L, 'Hijacked', NULL)$q$, t1), 'nor changes them');
  PERFORM pg_temp.logout();

  -- ---- a run pinned to a template version ----
  PERFORM pg_temp.login(ann);
  csv := app.create_integration_connection(org, 'csv', 'Template files', 'tfiles', '{}'::jsonb);
  PERFORM pg_temp.logout();
  INSERT INTO public.integration_files (organisation_id, connection_id, storage_path, file_name, size_bytes, status, headers, row_count, chunk_count)
  VALUES (org, csv, org::text || '/integration/' || csv::text || '/x.csv', 'x.csv', 10, 'parsed', ARRAY['Id', 'Code'], 1, 1) RETURNING id INTO f;
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_fails(format($q$SELECT app.request_integration_run(%L, 'machine', 'preview', %L)$q$, csv, f), 'without a template or a mapping a file cannot be imported');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.request_integration_run(%L, 'part', 'preview', %L, %L)$q$, csv, f, t1), 'a template for another kind of record is refused');
  run := app.request_integration_run(csv, 'machine', 'preview', f, t1);
  PERFORM pg_temp.assert_eq((SELECT v.version FROM public.integration_sync_runs r JOIN public.integration_template_versions v ON v.id = r.template_version_id WHERE r.id = run), 3,
    'the run is pinned to the template''s current version');
  PERFORM pg_temp.assert_eq((SELECT settings ->> 'writeMode' || '/' || (settings ->> 'matchExisting') FROM public.integration_sync_runs WHERE id = run), 'add_update/true',
    'and takes the template''s import settings');
  PERFORM app.cancel_integration_run(run, 'Test over');
  PERFORM app.save_integration_template_version(t1, jsonb_set(body, '{keyField}', '"Code"'), 'Key by code');
  PERFORM pg_temp.logout();
  lease := app.system_lease_integration_run(org, run, gen_random_uuid(), 30);
  PERFORM pg_temp.assert_eq(lease ->> 'leased', 'false', 'a cancelled run is not leased');
  PERFORM pg_temp.login(ann);
  run := app.request_integration_run(csv, 'machine', 'preview', f, t1);
  PERFORM pg_temp.logout();
  lease := app.system_lease_integration_run(org, run, gen_random_uuid(), 30);
  PERFORM pg_temp.assert_eq(lease -> 'mapping' ->> 'keyField', 'Code', 'the lease hands the version over as the mapping');
  PERFORM pg_temp.assert_eq(lease -> 'mapping' ->> 'templateId', t1::text, 'with its template');
  PERFORM pg_temp.assert_eq(lease -> 'mapping' -> 'fields' -> 0 -> 'steps' -> 1 ->> 'kind', 'upper', 'steps included');
END $$;
ROLLBACK;
