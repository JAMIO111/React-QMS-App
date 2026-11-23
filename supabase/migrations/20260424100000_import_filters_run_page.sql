-- Record filters, the run page and the health card (docs/import-filters-plan.md, F3).
--
--   * A run's page can list the records a filter left out (and say why) without reading the whole run: `app.integration_run_filtered_rows` and
--     `app.integration_run_filtered_count`, built like `app.integration_run_rows` / `_row_counts` (one permission check, indexed reads).
--   * The import health card (`app.integration_health`) carries how many records the last import read and how many its filter left out, so a scheduled
--     import whose filter suddenly leaves out everything (or almost everything) can be flagged. Nothing here changes how an import behaves.
--
-- `app.integration_health` is rewritten from its live definition by a checked text patch: the migration refuses to finish unless the old text is found
-- exactly once. Line endings are normalised first (a function applied through the SQL editor from Windows is stored with \r\n).
CREATE FUNCTION pg_temp.patch(p_fn regprocedure, p_old text, p_new text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_def text := replace(pg_get_functiondef(p_fn), E'\r', ''); v_n integer;
BEGIN
  v_n := (length(v_def) - length(replace(v_def, p_old, ''))) / length(p_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'Expected to find % exactly once in %, found % times', p_old, p_fn, v_n; END IF;
  EXECUTE replace(v_def, p_old, p_new);
END $$;

-- ---------------------------------------------------------------------------
-- The records a filter left out, for one run
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.integration_run_filtered_rows(p_run uuid, p_limit integer, p_offset integer) RETURNS SETOF public.integration_inbox
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH r AS MATERIALIZED (
    SELECT s.id FROM public.integration_sync_runs s WHERE s.id = p_run AND app.has_permission(s.organisation_id, 'integrations.read')
  )
  SELECT i.* FROM public.integration_inbox i JOIN r ON i.run_id = r.id WHERE i.filtered
  ORDER BY i.created_at, i.source_row NULLS LAST, i.id
  LIMIT least(greatest(coalesce(p_limit, 50), 1), 500) OFFSET greatest(coalesce(p_offset, 0), 0)
$$;

CREATE FUNCTION app.integration_run_filtered_count(p_run uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH r AS MATERIALIZED (
    SELECT s.id FROM public.integration_sync_runs s WHERE s.id = p_run AND app.has_permission(s.organisation_id, 'integrations.read')
  )
  SELECT count(*)::integer FROM public.integration_inbox i JOIN r ON i.run_id = r.id WHERE i.filtered
$$;

REVOKE ALL ON FUNCTION app.integration_run_filtered_rows(uuid, integer, integer), app.integration_run_filtered_count(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.integration_run_filtered_rows(uuid, integer, integer), app.integration_run_filtered_count(uuid) TO authenticated;

-- Filtered rows are looked up by run: the existing (run_id, ...) indexes serve the join, and a partial index keeps this read small however large the run.
CREATE INDEX IF NOT EXISTS integration_inbox_filtered_idx ON public.integration_inbox (run_id) WHERE filtered;

-- ---------------------------------------------------------------------------
-- Health: what the last import read and how much of it the filter left out
-- ---------------------------------------------------------------------------
SELECT pg_temp.patch('app.integration_health(uuid)'::regprocedure,
  E'''errorSummary'', r.error_summary, ''nextAttemptAt'',',
  E'''errorSummary'', r.error_summary, ''recordsTotal'', r.records_total, ''filtered'', r.filtered, ''nextAttemptAt'',');
