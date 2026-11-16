-- A run's rows, counted and paged quickly however large the import (found by the connector agent's load test, AG6d).
--
-- integration_inbox is read under RLS with app.has_permission(organisation_id, 'integrations.read'), which Postgres evaluates once per row. The run
-- page counted a run's rows with "run_id = $1 or last_run_id = $1" (no index for the OR, so every row of every run was read and checked): for an
-- import of 100,000 rows that took longer than the API login's 15-second statement timeout, so the run's status could no longer be read at all.
--
-- These two functions check the permission once, for the run's organisation, then read only the run's rows through indexes. They return exactly
-- what the caller could already read under RLS (the whole row is visible with integrations.read), nothing more.
--   * app.integration_run_row_counts(run)                     -> (status, n) for the rows the run staged or last worked on
--   * app.integration_run_rows(run, status, limit, offset)    -> those rows, in the run page's order

CREATE INDEX IF NOT EXISTS integration_inbox_last_run_idx ON public.integration_inbox (last_run_id, status);

CREATE FUNCTION app.integration_run_row_counts(p_run uuid) RETURNS TABLE (status text, n integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH r AS MATERIALIZED (
    SELECT s.id FROM public.integration_sync_runs s WHERE s.id = p_run AND app.has_permission(s.organisation_id, 'integrations.read')
  )
  SELECT x.status, count(*)::integer
  FROM (
    SELECT i.status FROM public.integration_inbox i JOIN r ON i.run_id = r.id
    UNION ALL
    SELECT i.status FROM public.integration_inbox i JOIN r ON i.last_run_id = r.id WHERE i.run_id <> r.id
  ) x
  GROUP BY x.status
$$;

CREATE FUNCTION app.integration_run_rows(p_run uuid, p_status text, p_limit integer, p_offset integer) RETURNS SETOF public.integration_inbox
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH r AS MATERIALIZED (
    SELECT s.id FROM public.integration_sync_runs s WHERE s.id = p_run AND app.has_permission(s.organisation_id, 'integrations.read')
  )
  SELECT x.* FROM (
    SELECT i.* FROM public.integration_inbox i JOIN r ON i.run_id = r.id WHERE p_status IS NULL OR i.status = p_status
    UNION ALL
    SELECT i.* FROM public.integration_inbox i JOIN r ON i.last_run_id = r.id WHERE i.run_id <> r.id AND (p_status IS NULL OR i.status = p_status)
  ) x
  ORDER BY x.created_at, x.source_row NULLS LAST, x.id
  LIMIT least(greatest(coalesce(p_limit, 50), 1), 500) OFFSET greatest(coalesce(p_offset, 0), 0)
$$;

REVOKE ALL ON FUNCTION app.integration_run_row_counts(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION app.integration_run_rows(uuid, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.integration_run_row_counts(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION app.integration_run_rows(uuid, text, integer, integer) TO authenticated;
