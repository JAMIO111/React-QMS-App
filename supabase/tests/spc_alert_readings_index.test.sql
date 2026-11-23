-- The index the SPC alert evaluation relies on (migration 20260426100000): it exists, is valid, serves "the newest reading of a requirement"
-- without a sort, and still serves a lookup by requirement alone (the plain index it replaced is gone).
\set ON_ERROR_STOP 1
BEGIN;

DO $$
DECLARE v_plan text; v_line text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'inspection_measurements_requirement_time_idx' AND i.indisvalid) THEN
    RAISE EXCEPTION 'FAILED: the (requirement_id, measured_at) index is missing or not valid';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'inspection_measurements_requirement_idx') THEN
    RAISE EXCEPTION 'FAILED: the plain requirement index should have been replaced';
  END IF;
  -- With the table small the planner would scan it; ask it to prefer an index so the plan shows which one it can use.
  PERFORM set_config('enable_seqscan', 'off', true);
  PERFORM set_config('enable_bitmapscan', 'off', true);
  v_plan := '';
  FOR v_line IN EXECUTE 'EXPLAIN SELECT m.measured_at FROM public.inspection_measurements m WHERE m.requirement_id = ''00000000-0000-0000-0000-000000000001'' ORDER BY m.measured_at DESC LIMIT 1' LOOP v_plan := v_plan || v_line || E'\n'; END LOOP;
  IF v_plan !~ 'inspection_measurements_requirement_time_idx' THEN RAISE EXCEPTION 'FAILED: the newest-reading lookup does not use the index: %', v_plan; END IF;
  IF v_plan ~ 'Sort' THEN RAISE EXCEPTION 'FAILED: the newest-reading lookup sorts: %', v_plan; END IF;
  v_plan := '';
  FOR v_line IN EXECUTE 'EXPLAIN SELECT m.id FROM public.inspection_measurements m WHERE m.requirement_id = ''00000000-0000-0000-0000-000000000001''' LOOP v_plan := v_plan || v_line || E'\n'; END LOOP;
  IF v_plan !~ 'inspection_measurements_requirement_time_idx' THEN RAISE EXCEPTION 'FAILED: a lookup by requirement alone does not use the index: %', v_plan; END IF;
END $$;

ROLLBACK;
