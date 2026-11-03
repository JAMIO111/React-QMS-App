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
