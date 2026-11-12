-- Reference numbers are never cut short, and NC numbers have four digits.
--
-- Every running number in the app (NCR-26-001, CAL-26-001, IPI-26-0001, QA-001, SOP-001 …) was padded with lpad(n::text, width, '0'). Postgres's lpad
-- CUTS a string that is longer than the width, so the 1,000th NC of a year came out as "-100", the same as the 100th: the NC numbering loop then
-- looked for a free number for ever. The same happened at 1,000 for the other three-digit numbers (some of them never reset by year: quality
-- alerts, audit templates, documents, risks) and at 10,000 for the four-digit ones (inspections, audit records, goods receipts …).
--
--  * app.pad_number(n, width): pads to AT LEAST width digits and never cuts (SNC-26-0001 … SNC-26-9999, SNC-26-10000).
--  * Every function that numbered with lpad is rewritten in place from its own current definition, with only the padding changed, so nothing
--    else in those functions moves (their live copies were checked against the repository before this was written; one differed only by a
--    comment, and line endings differ, which is why the rewrite reads each live definition rather than pasting a copy over it).
--  * NC references now have four digits: the next NC is <prefix>-26-0011, not -011. References already given never change. The NC register
--    sorts references by their number (api), so -010 and -0011 come out in order.
--  * The year in a number (the "26") is two digits by design and is left alone.
-- The migration refuses to finish if any numbering function it expects is missing or still pads by cutting.

CREATE FUNCTION app.pad_number(p_n bigint, p_width integer) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT lpad(p_n::text, greatest(p_width, length(p_n::text)), '0')
$$;
COMMENT ON FUNCTION app.pad_number(bigint, integer) IS 'Pads a running number with leading zeros to at least p_width digits; never cuts a longer number (unlike lpad)';
REVOKE ALL ON FUNCTION app.pad_number(bigint, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.pad_number(bigint, integer) TO authenticated;

DO $$
DECLARE
  -- The functions that number records, as found after every earlier migration.
  v_expected text[] := ARRAY[
    'audit_definition_rules', 'create_audit_finding', 'create_risk', 'create_supplier_scar', 'generate_ncr_rma', 'import_goods_receipt',
    'import_po_receipt_total', 'next_calibration_reference', 'next_capa_reference', 'next_document_number', 'next_ncr_reference',
    'next_training_session_reference', 'quality_alert_rules', 'raise_document_change_request', 'record_goods_receipt', 'start_audit',
    'start_inspection', 'start_supplier_assessment'];
  -- lpad of a running number (not of the two-digit year).
  v_pattern constant text := 'lpad\(\s*(v_n|NEW\.alert_number|NEW\.audit_number)::text\s*,\s*([0-9]+)\s*,\s*''0''\s*\)';
  r record; v_def text; v_new text; v_done text[] := ARRAY[]::text[]; v_left text;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'app' AND p.proname = ANY (v_expected)
  LOOP
    v_def := pg_get_functiondef(r.oid);
    v_new := regexp_replace(v_def, v_pattern, 'app.pad_number(\1, \2)', 'g');
    IF r.proname = 'next_ncr_reference' THEN
      IF position('app.pad_number(v_n, 3)' IN v_new) = 0 THEN RAISE EXCEPTION 'next_ncr_reference no longer pads to 3 digits; check it by hand'; END IF;
      v_new := replace(v_new, 'app.pad_number(v_n, 3)', 'app.pad_number(v_n, 4)');
    END IF;
    IF v_new = v_def THEN RAISE EXCEPTION 'app.% has no number padding to change; check it by hand', r.proname; END IF;
    EXECUTE v_new;
    v_done := v_done || r.proname::text;
  END LOOP;
  IF cardinality(v_done) <> cardinality(v_expected) THEN
    RAISE EXCEPTION 'Expected % numbering functions, changed %: %', cardinality(v_expected), cardinality(v_done), v_done;
  END IF;
  -- Nothing anywhere still pads a running number by cutting it.
  SELECT string_agg(n.nspname || '.' || p.proname, ', ') INTO v_left
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('public', 'app', 'audit') AND p.prokind = 'f' AND pg_get_functiondef(p.oid) ~ v_pattern;
  IF v_left IS NOT NULL THEN RAISE EXCEPTION 'These functions still pad numbers with lpad: %', v_left; END IF;
END $$;
