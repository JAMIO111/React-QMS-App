-- Classify the column the reporting keys added that names a user (the sign-in drift check, supabase/tests/sso_joining_moves.test.sql, fails until every
-- such column is in app.user_reference_columns()). It was missed when reporting keys were added (20260425100000).
--
-- reporting_keys.user_id is the account a key acts as. It is treated as history: when a person is moved onto their company account the key keeps
-- naming the old account, which is no longer an active member, so the key stops working (the lookup refuses it) and a new one is made. That fails
-- safe, and nothing quietly changes which identity a credential acts as. The same choice as external portal access.
--
-- The function is rewritten from its live definition by a checked text patch: the migration refuses to finish unless the anchor is found exactly once.
CREATE FUNCTION pg_temp.patch(p_fn regprocedure, p_old text, p_new text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_def text := replace(pg_get_functiondef(p_fn), E'\r', ''); v_n integer;
BEGIN
  v_n := (length(v_def) - length(replace(v_def, p_old, ''))) / length(p_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'Expected to find % exactly once in %, found % times', p_old, p_fn, v_n; END IF;
  EXECUTE replace(v_def, p_old, p_new);
END $$;

SELECT pg_temp.patch(
  'app.user_reference_columns()'::regprocedure,
  $old$    ('portal_views', 'user_id', 'history', 'Who has seen a shared record'),$old$,
  $new$    ('portal_views', 'user_id', 'history', 'Who has seen a shared record'),
    ('reporting_keys', 'user_id', 'history', 'The account a reporting key acts as; after a move to a company account the key stops working and a new one is made'),$new$);
