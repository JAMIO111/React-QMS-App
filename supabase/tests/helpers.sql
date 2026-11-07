-- Shared helpers for SQL tests. Include with:  \ir helpers.sql
-- Every test file runs in its own transaction and is rolled back.

-- Act as a signed-in user (role authenticated + JWT claims), as Supabase does per request.
CREATE FUNCTION pg_temp.login(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);
END $$;

CREATE FUNCTION pg_temp.login_anon() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  PERFORM set_config('role', 'anon', true);
END $$;

-- Back to the test superuser.
CREATE FUNCTION pg_temp.logout() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('role', 'postgres', true);
  PERFORM set_config('request.jwt.claims', '', true);
END $$;

CREATE FUNCTION pg_temp.assert_eq(actual anyelement, expected anyelement, label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'FAILED: % (expected %, got %)', label, expected, actual;
  END IF;
END $$;

-- Number of rows returned by a query, run as the current role.
CREATE FUNCTION pg_temp.count_rows(q text) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
  EXECUTE format('SELECT count(*) FROM (%s) q', q) INTO n;
  RETURN n;
END $$;

-- Asserts that a statement fails (permission denied, RLS violation, constraint, ...).
CREATE FUNCTION pg_temp.assert_fails(stmt text, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN
    RETURN;
  END;
  RAISE EXCEPTION 'FAILED: % (statement succeeded: %)', label, stmt;
END $$;

-- Asserts that a statement succeeds.
CREATE FUNCTION pg_temp.assert_ok(stmt text, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE stmt;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'FAILED: % (% — %)', label, SQLSTATE, SQLERRM;
END $$;

-- Rows affected by an UPDATE/DELETE (RLS silently filters rows rather than erroring).
CREATE FUNCTION pg_temp.affected(stmt text) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
  EXECUTE stmt;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- What an NC needs before it can reach Dispositioned and beyond: containment resolved (not needed) and approved dispositions over the whole quantity affected.
-- Run as a person who may edit and approve (the test owner).
CREATE FUNCTION pg_temp.settle_ncr(p_ncr uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_affected numeric; v_disposed numeric; v_id uuid;
BEGIN
  SELECT quantity_affected INTO v_affected FROM public.nonconformances WHERE id = p_ncr;
  UPDATE public.nonconformances SET containment_not_needed_reason = 'Not needed (test)' WHERE id = p_ncr AND containment_not_needed_reason IS NULL;
  SELECT coalesce(sum(quantity), 0) INTO v_disposed FROM public.ncr_dispositions WHERE nonconformance_id = p_ncr AND status IN ('proposed', 'approved');
  IF v_disposed < v_affected THEN
    INSERT INTO public.ncr_dispositions (organisation_id, nonconformance_id, decision, quantity, instructions)
    SELECT organisation_id, id, 'scrap', v_affected - v_disposed, 'Scrap the affected items (test)' FROM public.nonconformances WHERE id = p_ncr RETURNING id INTO v_id;
    PERFORM app.approve_ncr_disposition(v_id);
  END IF;
  FOR v_id IN SELECT id FROM public.ncr_dispositions WHERE nonconformance_id = p_ncr AND status = 'proposed' LOOP
    PERFORM app.approve_ncr_disposition(v_id);
  END LOOP;
END $$;
