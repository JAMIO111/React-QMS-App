-- The API's login (qms_api) has no privileges of its own and can only act as `authenticated`.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

SET SESSION AUTHORIZATION qms_api;
DO $$
BEGIN
  PERFORM pg_temp.assert_fails($q$SELECT 1 FROM public."NCM"$q$, 'qms_api reads a table without switching role');
  PERFORM pg_temp.assert_fails($q$SELECT 1 FROM audit.events$q$, 'qms_api reads audit without switching role');
  PERFORM pg_temp.assert_fails($q$SET LOCAL ROLE service_role$q$, 'qms_api becomes service_role');
  PERFORM pg_temp.assert_fails($q$SET LOCAL ROLE postgres$q$, 'qms_api becomes postgres');
  PERFORM pg_temp.assert_fails($q$SET LOCAL ROLE anon$q$, 'qms_api becomes anon');
  PERFORM pg_temp.assert_ok($q$SET LOCAL ROLE authenticated$q$, 'qms_api becomes authenticated');
END $$;
RESET SESSION AUTHORIZATION;

DO $$
BEGIN
  PERFORM pg_temp.assert_eq((SELECT rolinherit FROM pg_roles WHERE rolname = 'qms_api'), false, 'NOINHERIT');
  PERFORM pg_temp.assert_eq((SELECT rolbypassrls OR rolsuper OR rolcreaterole FROM pg_roles WHERE rolname = 'qms_api'), false, 'no elevated attributes');
END $$;

ROLLBACK;
