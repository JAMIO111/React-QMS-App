-- Phase 1 / slice 1.3 — database login for the NestJS API (docs/phase-1-plan.md §3.3)
--
-- qms_api can log in but has NO privileges of its own (NOINHERIT). For every request the API runs
-- a transaction that does `SET LOCAL ROLE authenticated` plus the caller's verified JWT claims, so
-- Row Level Security and the audit trail apply exactly as they do for direct client requests.
-- It can never become service_role or postgres.
--
-- The password is NOT set here (never commit secrets). Set it once in the SQL editor:
--   ALTER ROLE qms_api WITH PASSWORD '<generated secret>';
-- and store the resulting connection string only in the API's environment (DATABASE_URL).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qms_api') THEN
    CREATE ROLE qms_api LOGIN NOINHERIT;
  END IF;
END $$;

ALTER ROLE qms_api NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE qms_api SET statement_timeout = '15s';
ALTER ROLE qms_api SET idle_in_transaction_session_timeout = '30s';

GRANT authenticated TO qms_api;
