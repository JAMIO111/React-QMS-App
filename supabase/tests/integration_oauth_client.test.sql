-- OAuth client credentials for REST connections (docs/email-oauth-plan.md, OA1): settings, the credential's shape, and the token host on the allow-list.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES ('5e000000-0000-0000-0000-000000000b01', 'ann@oauth.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

CREATE FUNCTION pg_temp.assert_true(p boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p IS NOT TRUE THEN RAISE EXCEPTION 'FAILED: %', label; END IF; END $$;

DO $$
DECLARE
  ann uuid := '5e000000-0000-0000-0000-000000000b01';
  org uuid; conn uuid; good jsonb; bad text; secret text; problems text;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('OAuth Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.give_controller_seat(org, ann);

  good := '{"baseUrl": "https://erp.example.com/api", "authType": "oauth_client", "testPath": "/health",
            "oauthTokenUrl": "https://login.example.net/tenant/oauth2/v2.0/token", "oauthScope": "api://erp/.default openid",
            "oauthAudience": "https://erp.example.com", "oauthClientAuth": "basic"}';

  -- ---- settings ----
  PERFORM pg_temp.assert_eq(app.integration_config_problem('rest_api', good), NULL::text, 'OAuth settings are accepted');
  PERFORM pg_temp.assert_eq(app.integration_config_problem('rest_api', good - 'oauthScope' - 'oauthAudience' - 'oauthClientAuth'), NULL::text, 'only the token address is needed');
  PERFORM pg_temp.assert_eq(app.integration_config_problem('rest_api', good - 'oauthTokenUrl'), 'Give the address the access token is asked for', 'the token address is required');
  FOREACH bad IN ARRAY ARRAY[
    '{"oauthTokenUrl": "http://login.example.net/token"}',
    '{"oauthTokenUrl": "https://login.example.net:8443/token"}',
    '{"oauthTokenUrl": "https://10.0.0.1/token"}',
    '{"oauthTokenUrl": "https://localhost/token"}',
    '{"oauthTokenUrl": "https://idp.corp/token"}',
    '{"oauthTokenUrl": "https://user:pw@login.example.net/token"}',
    '{"oauthTokenUrl": 7}',
    '{"oauthScope": "a  b"}',
    '{"oauthScope": " a"}',
    '{"oauthScope": "a\nb"}',
    '{"oauthAudience": "two words"}',
    '{"oauthClientAuth": "jwt"}',
    '{"oauthClientSecret": "never in the settings"}'
  ] LOOP
    PERFORM pg_temp.assert_true(app.integration_config_problem('rest_api', good || bad::jsonb) IS NOT NULL, 'refused: ' || bad);
  END LOOP;
  PERFORM pg_temp.assert_true(app.integration_config_problem('rest_api', good || '{"oauthTokenUrl": "http://login.example.net/token"}') LIKE 'Token address:%', 'the problem names the token address');

  -- ---- the credential ----
  PERFORM pg_temp.login(ann);
  conn := app.create_integration_connection(org, 'rest_api', 'Entra ERP', 'entra-erp', good);
  FOREACH secret IN ARRAY ARRAY['not json', '{"clientId": "x"}', '{"clientId": "", "clientSecret": "s"}', '{"clientId": 1, "clientSecret": "s"}', '["x", "y"]'] LOOP
    PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.set_integration_credential(%L, 'oauth_client', %L)$f$, conn, secret)), 5), 'QM022', 'refused client secret: ' || secret);
  END LOOP;
  PERFORM app.set_integration_credential(conn, 'oauth_client', '{"clientId": "app", "clientSecret": "s3cr3t"}');
  PERFORM pg_temp.assert_eq((SELECT kind FROM public.integration_credentials WHERE connection_id = conn AND revoked_at IS NULL), 'oauth_client', 'the client credential is stored');
  problems := array_to_string(app.integration_activation_problems(conn), ';');
  PERFORM pg_temp.assert_true(problems NOT LIKE '%credential%', 'a stored client credential satisfies the sign-in: ' || problems);

  -- ---- the token host must be allowed too ----
  PERFORM app.set_integration_allowed_hosts(org, ARRAY['example.com']);
  problems := array_to_string(app.integration_activation_problems(conn), ';');
  PERFORM pg_temp.assert_true(problems LIKE '%token address login.example.net%', 'a token host outside the allow-list is listed: ' || problems);
  PERFORM pg_temp.assert_true(problems NOT LIKE '%connections to erp.example.com%', 'the API host itself is allowed');
  PERFORM app.set_integration_allowed_hosts(org, ARRAY['example.com', 'login.example.net']);
  PERFORM pg_temp.assert_true(array_to_string(app.integration_activation_problems(conn), ';') NOT LIKE '%token address%', 'allowing the token host clears it');
  PERFORM pg_temp.logout();

  -- ---- the provider offers it ----
  PERFORM pg_temp.assert_true((SELECT 'oauth_client' = ANY (auth_types) FROM public.integration_providers WHERE key = 'rest_api'), 'the REST provider offers OAuth client credentials');
END $$;

ROLLBACK;
