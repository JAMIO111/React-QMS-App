-- Integrations IN1: providers, connections and their lifecycle (activation needs a second person), credentials kept in Vault (never in tables, audit or reads),
-- history, permissions, direct-write lockout and tenant isolation.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('5d000000-0000-0000-0000-000000000a01', 'ann@in.test'), ('5d000000-0000-0000-0000-000000000a02', 'bob@in.test'),
  ('5d000000-0000-0000-0000-000000000a03', 'cat@in.test'), ('5d000000-0000-0000-0000-000000000a04', 'eve@in.test'),
  ('5d000000-0000-0000-0000-000000000a05', 'dan@in.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

CREATE FUNCTION pg_temp.vault_has(p_id uuid) RETURNS integer LANGUAGE sql SECURITY DEFINER AS $$ SELECT count(*)::int FROM vault.secrets WHERE id = p_id $$;

DO $$
DECLARE
  ann uuid := '5d000000-0000-0000-0000-000000000a01'; bob uuid := '5d000000-0000-0000-0000-000000000a02'; cat uuid := '5d000000-0000-0000-0000-000000000a03'; eve uuid := '5d000000-0000-0000-0000-000000000a04';
  dan uuid := '5d000000-0000-0000-0000-000000000a05'; selfc uuid; qmc uuid;
  org uuid; org2 uuid; r_viewer uuid; r_qm uuid; csv uuid; rest uuid; cred uuid; cred2 uuid; v_secret uuid; v_old uuid; n integer;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('IN Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('IN Beta'); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, bob, 'active'), (org, cat, 'active');
  SELECT id INTO r_viewer FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  SELECT id INTO r_qm FROM public.roles WHERE organisation_id = org AND key = 'quality_manager';
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, ou.id, r_viewer FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id = bob;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, ou.id, r_qm FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id = cat;
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, dan, 'active');
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, r.id FROM public.organisation_users ou JOIN public.roles r ON r.organisation_id = org AND r.key = 'admin' WHERE ou.organisation_id = org AND ou.user_id = dan;

  -- ---- integrations are for Controller seat holders only ----
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'integrations.manage'), false, 'an owner without a Controller seat has no integrations permission');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM app.my_permissions(org) p WHERE p LIKE 'integrations.%'), 0, 'nor are any listed for the menu');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'ncr.read'), true, 'other permissions are unchanged');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_integration_connection(%L, 'csv', 'No seat', 'noseat', '{}'::jsonb)$f$, org)), 5), '42501', 'and cannot create a connection');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.give_controller_seat(org, ann);
  PERFORM pg_temp.give_controller_seat(org, cat);
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'integrations.manage'), true, 'with a Controller seat the owner may manage integrations');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM app.my_permissions(org) p WHERE p LIKE 'integrations.%'), 4, 'and all four are listed');
  PERFORM pg_temp.logout();

  -- ---- providers: read by anyone signed in, written by no one ----
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.integration_providers), 3, 'a viewer can see the provider catalogue');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails($f$INSERT INTO public.integration_providers (key, name, kind) VALUES ('evil', 'Evil', 'api')$f$), 5), '42501', 'nobody writes the catalogue');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.integration_connections), 0, 'a viewer sees no connections');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_integration_connection(%L, 'csv', 'Nope', 'nope', '{}'::jsonb)$f$, org)), 5), '42501', 'and cannot create one');
  PERFORM pg_temp.logout();

  -- ---- creating ----
  PERFORM pg_temp.login(ann);
  csv := app.create_integration_connection(org, 'csv', 'ERP parts file', 'erp', '{"delimiter": ";", "hasHeader": true}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_connections WHERE id = csv), 'active', 'a file connection is in use as soon as it is created (IN4)');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_integration_connection(%L, 'csv', 'erp parts FILE', 'erp2', '{}'::jsonb)$f$, org)), 5), 'QM022', 'names are unique ignoring case');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_integration_connection(%L, 'csv', 'Another', 'erp', '{}'::jsonb)$f$, org)), 5), 'QM022', 'and so is the system code');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_integration_connection(%L, 'csv', 'Another', 'ERP 2', '{}'::jsonb)$f$, org)), 5), 'QM022', 'the code is lower-case letters, digits, hyphens and underscores');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_integration_connection(%L, 'sql_agent', 'Agent', 'agent', '{}'::jsonb)$f$, org)), 5), 'QM022', 'a planned provider cannot be used yet');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_integration_connection(%L, 'nonsense', 'X', 'xx', '{}'::jsonb)$f$, org)), 5), 'P0002', 'an unknown provider is not found');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_integration_connection(%L, 'csv', 'Bad', 'bad', '{"delimiter": "x"}'::jsonb)$f$, org)), 5), 'QM022', 'a bad delimiter is refused');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_integration_connection(%L, 'csv', 'Bad', 'bad', '{"password": "hunter2"}'::jsonb)$f$, org)), 5), 'QM022', 'config has no place for a password');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_integration_connection(%L, 'rest_api', 'Bad', 'bad', '{"baseUrl": "http://api.example.com"}'::jsonb)$f$, org)), 5), 'QM022', 'REST needs https');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_integration_connection(%L, 'rest_api', 'Bad', 'bad', '{"baseUrl": "https://localhost/api"}'::jsonb)$f$, org)), 5), 'QM022', 'localhost is refused');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_integration_connection(%L, 'rest_api', 'Bad', 'bad', '{"baseUrl": "https://10.0.0.5/api"}'::jsonb)$f$, org)), 5), 'QM022', 'an IP address is refused');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_integration_connection(%L, 'rest_api', 'Bad', 'bad', '{"baseUrl": "https://169.254.169.254/latest"}'::jsonb)$f$, org)), 5), 'QM022', 'the cloud metadata address is refused');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_integration_connection(%L, 'rest_api', 'Bad', 'bad', '{"baseUrl": "https://user:pw@api.example.com"}'::jsonb)$f$, org)), 5), 'QM022', 'credentials in the address are refused');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_integration_connection(%L, 'rest_api', 'Bad', 'bad', '{"baseUrl": "https://api.example.com:8443"}'::jsonb)$f$, org)), 5), 'QM022', 'an unusual port is refused');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_integration_connection(%L, 'rest_api', 'Bad', 'bad', '{"baseUrl": "https://api.internal/x"}'::jsonb)$f$, org)), 5), 'QM022', 'an internal host name is refused');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_integration_connection(%L, 'rest_api', 'Bad', 'bad', '{"baseUrl": "https://api.example.com", "authType": "api_key"}'::jsonb)$f$, org)), 5), 'QM022', 'an API key needs a header name');
  rest := app.create_integration_connection(org, 'rest_api', 'ERP REST', 'erp-api', '{"baseUrl": "https://api.example.com/v1", "authType": "bearer", "timeoutSeconds": 20}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.integration_connection_events WHERE connection_id = rest AND action = 'created'), 1, 'creation is on record');

  -- ---- readiness ----
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.mark_integration_ready(%L)$f$, rest)), 5), 'QM022', 'a REST connection with no credential and no test is not ready');
  PERFORM pg_temp.assert_eq(app.integration_activation_problems(rest), ARRAY['Store the credential for this connection', 'Test the connection'], 'and the reasons are given');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.set_integration_credential(%L, 'oauth_client', 'x')$f$, rest)), 5), 'QM022', 'a credential kind the provider does not use is refused');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.set_integration_credential(%L, 'bearer', '')$f$, rest)), 5), 'QM022', 'an empty credential is refused');
  cred := app.set_integration_credential(rest, 'bearer', 'top-secret-token-1');
  PERFORM pg_temp.assert_eq(app.integration_activation_problems(rest), ARRAY['Test the connection'], 'with the credential only the test is missing');
  PERFORM app.record_integration_connection_test(rest, false, 'Connection refused');
  PERFORM pg_temp.assert_eq(app.integration_activation_problems(rest), ARRAY['The last connection test failed'], 'a failed test blocks readiness');
  PERFORM app.record_integration_connection_test(rest, true, 'Connected');
  PERFORM app.mark_integration_ready(rest);
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_connections WHERE id = rest), 'ready', 'a tested, credentialed connection is ready');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.mark_integration_ready(%L)$f$, csv)), 5), 'QM022', 'a file connection is never marked ready');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.pause_integration_connection(%L, 'Not needed')$f$, csv)), 5), 'QM022', 'nor paused');
  PERFORM app.update_integration_connection(csv, 'ERP parts (file)', NULL);
  PERFORM pg_temp.assert_eq((SELECT name FROM public.integration_connections WHERE id = csv), 'ERP parts (file)', 'and can be changed while in use');

  -- changing the config sends a ready connection back to draft
  PERFORM app.update_integration_connection(rest, NULL, '{"baseUrl": "https://api.example.com/v2", "authType": "bearer"}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_connections WHERE id = rest), 'draft', 'a change after ready sends it back to draft');
  PERFORM pg_temp.assert_eq(app.integration_activation_problems(rest), ARRAY['The connection was changed after the last test: test it again'], 'and the test has to be repeated');
  PERFORM app.record_integration_connection_test(rest, true, 'Connected again');
  PERFORM app.mark_integration_ready(rest);

  -- ---- activation needs a second person, unless an owner or admin activates their own ----
  PERFORM pg_temp.logout(); PERFORM pg_temp.login(cat);
  qmc := app.create_integration_connection(org, 'rest_api', 'QM api', 'qm-api', '{"baseUrl": "https://qm.example.com", "authType": "none"}'::jsonb);
  PERFORM app.record_integration_connection_test(qmc, true, 'ok');
  PERFORM app.mark_integration_ready(qmc);
  PERFORM pg_temp.assert_eq(app.integration_can_activate(qmc), false, 'a quality manager who marked it ready may not activate it');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.activate_integration_connection(%L)$f$, qmc)), 5), 'QM022', 'the database refuses it too');
  PERFORM pg_temp.logout(); PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq(app.integration_can_activate(qmc), true, 'another approver may');
  selfc := app.create_integration_connection(org, 'rest_api', 'Owner api', 'owner-api', '{"baseUrl": "https://owner.example.com", "authType": "none"}'::jsonb);
  PERFORM app.record_integration_connection_test(selfc, true, 'ok');
  PERFORM app.mark_integration_ready(selfc);
  PERFORM pg_temp.assert_eq(app.integration_can_activate(selfc), true, 'an owner may activate a connection they prepared');
  PERFORM app.activate_integration_connection(selfc);
  PERFORM pg_temp.assert_eq((SELECT ready_by = activated_by FROM public.integration_connections WHERE id = selfc), true, 'and the record shows the same person did both');
  PERFORM pg_temp.logout(); PERFORM pg_temp.login(dan);
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.integration_connections), 0, 'an admin without a Controller seat sees no connections');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.activate_integration_connection(%L)$f$, qmc)), 5), '42501', 'and cannot activate one');
  PERFORM pg_temp.logout(); PERFORM pg_temp.give_controller_seat(org, dan); PERFORM pg_temp.login(dan);
  selfc := app.create_integration_connection(org, 'rest_api', 'Admin api', 'admin-api', '{"baseUrl": "https://admin.example.com", "authType": "none"}'::jsonb);
  PERFORM app.record_integration_connection_test(selfc, true, 'ok');
  PERFORM app.mark_integration_ready(selfc);
  PERFORM app.activate_integration_connection(selfc);
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_connections WHERE id = selfc), 'active', 'an admin with a seat sets a connection up and activates it on their own');
  PERFORM pg_temp.logout(); PERFORM pg_temp.login(ann);
  qmc := app.create_integration_connection(org, 'rest_api', 'Owner api 2', 'owner-api-2', '{"baseUrl": "https://owner2.example.com", "authType": "none"}'::jsonb);
  PERFORM app.record_integration_connection_test(qmc, true, 'ok');
  PERFORM app.mark_integration_ready(qmc);
  PERFORM pg_temp.logout(); PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.activate_integration_connection(%L)$f$, qmc)), 5), '42501', 'a viewer cannot activate');
  PERFORM pg_temp.logout(); PERFORM pg_temp.login(cat);
  PERFORM app.activate_integration_connection(qmc);
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_connections WHERE id = qmc), 'active', 'a quality manager who did not prepare it can activate it');
  PERFORM pg_temp.assert_eq((SELECT activated_by FROM public.integration_connections WHERE id = qmc), cat, 'and is recorded as the approver');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.update_integration_connection(%L, 'Renamed', NULL)$f$, qmc)), 5), 'QM022', 'an active API connection cannot be changed');
  PERFORM pg_temp.logout(); PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.pause_integration_connection(%L, 'x')$f$, qmc)), 5), 'QM022', 'pausing needs a reason');
  PERFORM app.pause_integration_connection(qmc, 'Source is being rebuilt');
  PERFORM app.update_integration_connection(qmc, 'Owner api (renamed)', NULL);
  PERFORM app.resume_integration_connection(qmc);
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_connections WHERE id = qmc), 'active', 'a paused connection can be changed and resumed');

  -- SQL cannot make an impossible move either
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$UPDATE public.integration_connections SET status = 'ready' WHERE id = %L$f$, qmc)), 5), 'QM022', 'active cannot go back to ready');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$UPDATE public.integration_connections SET status = 'paused' WHERE id = %L$f$, csv)), 5), 'QM022', 'a file connection cannot be paused even by SQL');
  PERFORM pg_temp.login(ann);

  -- ---- credentials: Vault only ----
  SELECT secret_id INTO v_secret FROM public.integration_credentials WHERE id = cred;
  PERFORM pg_temp.assert_eq(pg_temp.vault_has(v_secret), 1, 'the secret is in Vault');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM pg_attribute WHERE attrelid = 'public.integration_credentials'::regclass AND attnum > 0 AND NOT attisdropped AND attname ~* 'secret|token|password|key_value') , 1, 'the credentials table has one secret-related column: the Vault id');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM audit.events WHERE organisation_id = org AND (new_values::text LIKE '%top-secret-token-1%' OR previous_values::text LIKE '%top-secret-token-1%')), 0, 'the secret is nowhere in the audit trail');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.integration_connection_events WHERE connection_id = rest AND note LIKE '%top-secret%'), 0, 'nor in the history');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails($f$SELECT count(*) FROM vault.decrypted_secrets$f$), 5), '42501', 'a signed-in user cannot read Vault');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.integration_credential_secret(%L, %L)$f$, org, rest)), 5), '42501', 'or call the function that decrypts');
  PERFORM pg_temp.assert_eq(has_function_privilege('qms_api', 'app.integration_credential_secret(uuid, uuid)', 'EXECUTE'), true, 'only the API login can');
  PERFORM pg_temp.assert_eq(has_function_privilege('authenticated', 'app.integration_credential_secret(uuid, uuid)', 'EXECUTE'), false, 'and not an ordinary user');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(app.integration_credential_secret(org, rest), 'top-secret-token-1', 'the API login gets the value');
  PERFORM pg_temp.assert_eq(app.integration_credential_secret(org2, rest), NULL, 'but not for another organisation''s connection');
  PERFORM pg_temp.login(ann);
  -- rotate
  cred2 := app.set_integration_credential(rest, 'bearer', 'top-secret-token-2');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.integration_credentials WHERE connection_id = rest AND revoked_at IS NULL), 1, 'one live credential per connection');
  PERFORM pg_temp.assert_eq(pg_temp.vault_has(v_secret), 0, 'a rotated secret is deleted from Vault');
  PERFORM pg_temp.assert_eq((SELECT rotated_from FROM public.integration_credentials WHERE id = cred2), cred, 'the new credential points at the one it replaced');
  PERFORM pg_temp.assert_eq((SELECT revoke_reason FROM public.integration_credentials WHERE id = cred), 'Replaced by a new credential', 'and the old one says why it ended');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_connections WHERE id = rest), 'ready', 'a rotation keeps a ready connection ready');
  -- a second person for the REST connection, then revoke pauses it
  PERFORM pg_temp.logout(); PERFORM pg_temp.login(cat);
  PERFORM app.activate_integration_connection(rest);
  PERFORM pg_temp.logout(); PERFORM pg_temp.login(ann);
  SELECT secret_id INTO v_old FROM public.integration_credentials WHERE id = cred2;
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.revoke_integration_credential(%L, 'no')$f$, cred2)), 5), 'QM022', 'revoking needs a reason');
  PERFORM app.revoke_integration_credential(cred2, 'Key exposed in a ticket');
  PERFORM pg_temp.assert_eq(pg_temp.vault_has(v_old), 0, 'a revoked secret is deleted from Vault');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_connections WHERE id = rest), 'paused', 'revoking the credential of an active connection pauses it');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.resume_integration_connection(%L)$f$, rest)), 5), 'QM022', 'and it cannot resume without a new credential');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.revoke_integration_credential(%L, 'Again please')$f$, cred2)), 5), 'QM022', 'a credential is revoked once');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(app.integration_credential_secret(org, rest), NULL, 'nothing is returned for a revoked credential');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$DELETE FROM public.integration_credentials WHERE id = %L$f$, cred2)), 5), 'QM022', 'a credential row is never deleted, even by SQL');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$UPDATE public.integration_credentials SET kind = 'basic' WHERE id = %L$f$, cred2)), 5), 'QM022', 'or changed');
  PERFORM pg_temp.login(ann);

  -- ---- retiring ----
  PERFORM app.set_integration_credential(rest, 'bearer', 'top-secret-token-3');
  SELECT secret_id INTO v_old FROM public.integration_credentials WHERE connection_id = rest AND revoked_at IS NULL;
  PERFORM app.retire_integration_connection(rest, 'Replaced by the file importer');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.integration_connections WHERE id = rest), 'retired', 'retired is final');
  PERFORM pg_temp.assert_eq(pg_temp.vault_has(v_old), 0, 'and takes the secret with it');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.set_integration_credential(%L, 'bearer', 'again')$f$, rest)), 5), 'QM022', 'a retired connection takes no credential');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.resume_integration_connection(%L)$f$, rest)), 5), 'QM022', 'and cannot be resumed');
  PERFORM pg_temp.assert_eq((SELECT array_agg(action ORDER BY at, created_at) FILTER (WHERE action IN ('created', 'ready', 'activated', 'retired')) FROM public.integration_connection_events WHERE connection_id = rest), ARRAY['created', 'ready', 'ready', 'activated', 'retired'], 'the history tells the story in order');

  -- ---- the viewer and the engineer read, the manager manages ----
  PERFORM pg_temp.logout(); PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.integration_credentials), 0, 'a viewer sees no credential rows');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.integration_connection_events), 0, 'and no history');
  PERFORM pg_temp.logout();

  -- ---- no direct writes ----
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$INSERT INTO public.integration_connections (organisation_id, provider_id, name, external_system) SELECT %L, id, 'Direct', 'direct' FROM public.integration_providers WHERE key = 'csv'$f$, org)), 5), '42501', 'no one inserts a connection directly');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$UPDATE public.integration_connections SET status = 'active' WHERE id = %L$f$, csv)), 5), '42501', 'or updates one');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$DELETE FROM public.integration_connections WHERE id = %L$f$, csv)), 5), '42501', 'or deletes one');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails($f$INSERT INTO public.integration_credentials (organisation_id, connection_id, kind) VALUES (gen_random_uuid(), gen_random_uuid(), 'bearer')$f$), 5), '42501', 'nor a credential');
  PERFORM pg_temp.logout();

  -- ---- tenant isolation ----
  PERFORM pg_temp.login(eve);
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.integration_connections), 0, 'another organisation sees none of these connections');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.pause_integration_connection(%L, 'Hijack')$f$, csv)), 5), 'P0002', 'and cannot find them to change');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.set_integration_credential(%L, 'bearer', 'x')$f$, rest)), 5), 'P0002', 'or to give them a credential');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_integration_connection(%L, 'csv', 'Hijack', 'hijack', '{}'::jsonb)$f$, org)), 5), 'P0002', 'or create one in this organisation');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
