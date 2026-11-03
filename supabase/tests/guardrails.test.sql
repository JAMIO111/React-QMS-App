-- Fails if any schema-wide security guardrail (supabase/checks/guardrails.sql) is violated.
-- Because it inspects the catalogue, new tables, views and functions are covered automatically.
\set ON_ERROR_STOP 1
BEGIN;
\o /dev/null
\ir ../checks/guardrails.sql
\o

DO $$
DECLARE v text;
BEGIN
  SELECT string_agg(rule || ': ' || object, E'\n') INTO v FROM guardrail_violations;
  IF v IS NOT NULL THEN
    RAISE EXCEPTION E'Guardrail violations:\n%', v;
  END IF;
END $$;
ROLLBACK;
