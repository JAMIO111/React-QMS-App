/*
 * Efficiency round (docs/efficiency-impact-assessment.md): three small changes, none of which changes what anyone can do or see.
 *
 * 1. app.organisation_time_zone checked a site's zone against pg_timezone_names, a view that reads the whole zone database on every call (about 24 ms
 *    each; reminders, scorecards and timers call it per organisation). app.valid_time_zone asks the question the cheap way: is the name shaped like an
 *    Area/Place name (or UTC), and does the server accept it. Every real IANA name behaves as before; abbreviations (EST) and POSIX strings (EST5EDT),
 *    which the old check let through, are now refused for a site's zone, so such a site falls back to the next site or Europe/London.
 * 2. cron.job_run_details (written by pg_cron on every tick) grew for ever. app.system_purge_cron_history() keeps seven days of it; worker housekeeping
 *    calls it. It does nothing where pg_cron is not installed.
 * 3. The read policies of the busiest tables called a SECURITY DEFINER function once per row. Each now says
 *      organisation_id IN (SELECT app.orgs_permitted('perm'))  OR  <the old per-row check, unchanged>
 *    (app.orgs_member() for the policies that only asked for membership). The list does not depend on the row, so Postgres works it out once per
 *    statement; a row is visible now only if it was visible before, and everything the fast path does not cover falls through to the old check.
 *    The migration rewrites the policies from their own live text and refuses to finish if any listed policy is not in the expected shape.
 */

-- ---------------------------------------------------------------------------
-- 1. Time zones
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.valid_time_zone(p_name text) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
BEGIN
  IF p_name IS NULL OR length(p_name) > 64 THEN RETURN false; END IF;
  IF p_name <> 'UTC' AND p_name !~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)+$' THEN RETURN false; END IF;
  PERFORM now() AT TIME ZONE p_name;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END $$;
REVOKE ALL ON FUNCTION app.valid_time_zone(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.valid_time_zone(text) TO authenticated, qms_api;

CREATE OR REPLACE FUNCTION app.organisation_time_zone(p_organisation_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(
    (SELECT s.time_zone FROM public.organisation_settings s WHERE s.organisation_id = p_organisation_id),
    (SELECT si.timezone FROM public.sites si
      WHERE si.organisation_id = p_organisation_id AND si.active AND app.valid_time_zone(si.timezone)
      ORDER BY si.created_at, si.id LIMIT 1),
    'Europe/London')
$$;

-- ---------------------------------------------------------------------------
-- 2. pg_cron history
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.system_purge_cron_history(p_keep interval DEFAULT interval '7 days') RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n integer := 0;
BEGIN
  IF to_regclass('cron.job_run_details') IS NULL THEN RETURN 0; END IF;
  EXECUTE 'DELETE FROM cron.job_run_details WHERE end_time < now() - $1' USING p_keep;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION app.system_purge_cron_history(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.system_purge_cron_history(interval) TO qms_api;

-- ---------------------------------------------------------------------------
-- 3. Read policies: the permission is worked out once per statement
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.orgs_member() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT m.organisation_id
  FROM public.organisation_users m
  WHERE m.user_id = auth.uid() AND m.status = 'active'
    AND app.is_member(m.organisation_id)
$$;
REVOKE ALL ON FUNCTION app.orgs_member() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.orgs_member() TO authenticated;

DO $$
DECLARE
  t record;
  v_qual text;
  v_perm text;
  v_new text;
  v_done integer := 0;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      ('goods_receipt_lines', 'goods_receipt_lines_select'),
      ('goods_receipts', 'goods_receipts_select'),
      ('incoming_inspection_determinations', 'incoming_inspection_determinations_select'),
      ('lots', 'lots_select'),
      ('ncr_affected_lots', 'ncr_affected_lots_select'),
      ('ncr_attachments', 'ncr_attachments_select'),
      ('ncr_containment_actions', 'ncr_containment_select'),
      ('ncr_costs', 'ncr_costs_select'),
      ('ncr_dispositions', 'ncr_dispositions_select'),
      ('nonconformances', 'nonconformances_select'),
      ('part_revision_characteristics', 'part_revision_characteristics_select'),
      ('part_revisions', 'part_revisions_select'),
      ('parts', 'parts_select'),
      ('production_operations', 'production_operations_select'),
      ('production_orders', 'production_orders_select'),
      ('purchase_order_lines', 'purchase_order_lines_select'),
      ('purchase_orders', 'purchase_orders_select'),
      ('receipt_line_dispositions', 'receipt_line_dispositions_select'),
      ('serial_numbers', 'serial_numbers_select'),
      ('spc_alerts', 'spc_alerts_select'),
      ('supplier_scorecards', 'supplier_scorecards_select')
    ) AS x(tbl, pol)
  LOOP
    SELECT p.qual INTO v_qual FROM pg_policies p
     WHERE p.schemaname = 'public' AND p.tablename = t.tbl AND p.policyname = t.pol AND p.cmd = 'SELECT';
    IF v_qual IS NULL THEN
      RAISE EXCEPTION 'Policy % on % not found; nothing was changed for it', t.pol, t.tbl;
    END IF;
    IF v_qual LIKE '%orgs_permitted%' OR v_qual LIKE '%orgs_member%' THEN
      v_done := v_done + 1;
      CONTINUE;  -- already rewritten
    END IF;

    IF v_qual ~ '^app\.is_member\(organisation_id\)$' THEN
      v_new := format('organisation_id IN (SELECT app.orgs_member()) OR (%s)', v_qual);
    ELSIF v_qual ~ '^app\.has_permission\(organisation_id, ''[a-z_.]+''::text(, [^;]+)?\)$' THEN
      v_perm := substring(v_qual FROM '^app\.has_permission\(organisation_id, ''([a-z_.]+)''::text');
      v_new := format('organisation_id IN (SELECT app.orgs_permitted(%L)) OR (%s)', v_perm, v_qual);
    ELSE
      RAISE EXCEPTION 'Policy % on % is not in the expected shape (%); not changed', t.pol, t.tbl, v_qual;
    END IF;

    EXECUTE format('ALTER POLICY %I ON public.%I USING (%s)', t.pol, t.tbl, v_new);
    v_done := v_done + 1;
  END LOOP;

  IF v_done <> 21 THEN
    RAISE EXCEPTION 'Expected 21 policies rewritten, got %', v_done;
  END IF;
END $$;
