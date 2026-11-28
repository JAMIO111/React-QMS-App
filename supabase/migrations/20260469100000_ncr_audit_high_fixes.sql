-- NC module audit (docs/audit-nc-2026-11.md), the two database findings rated high.
--
-- DB-1  A cancelled non-conformance could be reopened without the opening rules, so an NC that never had a severity, a category, a quantity or its
--       customer became open. Reopening a CANCELLED non-conformance now needs what opening needs (a closed one that was open before is as it was:
--       old closed records are never blocked, and reopen is refused to change content in the same step). And an open customer / supplier NC can no
--       longer lose its customer / supplier (only change_ncr_source re-checked the party).
-- DB-2  "One live non-conformance per failed reading / audit finding" was checked only at the moment of linking. Two people raising on the same
--       readings at once both passed; reopening a cancelled NC, or restoring a deleted one, put a reading or finding on two live NCs. Raising and
--       adding now take a lock per inspection, and reopen / restore re-check that none of the NC's readings or findings is on another live NC.
--       (A receipt line is not affected: its NC-based PPM is capped at what was received.)

CREATE OR REPLACE FUNCTION pg_temp.patch_once(p_fn regprocedure, p_marker text, p_old text, p_new text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_def text := replace(pg_get_functiondef(p_fn), E'\r', ''); v_n integer;
BEGIN
  p_old := replace(p_old, E'\r', '');
  p_new := replace(p_new, E'\r', '');
  IF position(p_marker IN v_def) > 0 THEN RETURN; END IF;
  v_n := (length(v_def) - length(replace(v_def, p_old, ''))) / length(p_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'Expected to find % exactly once in %, found % times', p_old, p_fn, v_n; END IF;
  EXECUTE replace(v_def, p_old, p_new);
END $$;

-- ---------------------------------------------------------------------------
-- DB-2: the readings and findings of a non-conformance are on no other live one
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.assert_ncr_links_free(p_ncr uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_inspection uuid;
  v_taken text;
BEGIN
  -- The lock the raise and add functions take, so a reopen and a raise cannot both pass at once.
  FOR v_inspection IN
    SELECT DISTINCT l.inspection_record_id FROM public.inspection_ncr_links l WHERE l.nonconformance_id = p_ncr AND l.measurement_id IS NOT NULL ORDER BY 1
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('ncr-readings:' || v_inspection::text, 0));
  END LOOP;
  -- The finding rows are locked as app.create_ncr_from_audit_finding locks them.
  PERFORM 1 FROM public.audit_findings f
   WHERE f.id IN (SELECT a.finding_id FROM public.audit_ncr_links a WHERE a.nonconformance_id = p_ncr AND a.finding_id IS NOT NULL)
   ORDER BY f.id FOR UPDATE;

  SELECT string_agg(DISTINCT x.ref, ', ') INTO v_taken FROM (
    SELECT CASE WHEN app.has_permission(o.organisation_id, 'ncr.read', o.site_id) THEN o.reference ELSE 'another non-conformance' END AS ref
      FROM public.inspection_ncr_links l
      JOIN public.inspection_ncr_links l2 ON l2.measurement_id = l.measurement_id AND l2.nonconformance_id <> l.nonconformance_id
      JOIN public.nonconformances o ON o.id = l2.nonconformance_id AND o.stage <> 'cancelled' AND o.deleted_at IS NULL
     WHERE l.nonconformance_id = p_ncr AND l.measurement_id IS NOT NULL
    UNION ALL
    SELECT CASE WHEN app.has_permission(o.organisation_id, 'ncr.read', o.site_id) THEN o.reference ELSE 'another non-conformance' END
      FROM public.audit_ncr_links a
      JOIN public.audit_ncr_links a2 ON a2.finding_id = a.finding_id AND a2.nonconformance_id <> a.nonconformance_id
      JOIN public.nonconformances o ON o.id = a2.nonconformance_id AND o.stage <> 'cancelled' AND o.deleted_at IS NULL
     WHERE a.nonconformance_id = p_ncr AND a.finding_id IS NOT NULL
  ) x;
  IF v_taken IS NOT NULL THEN
    RAISE EXCEPTION 'Some of its readings or its audit finding are already on %; cancel or delete that non-conformance first', v_taken USING ERRCODE = 'QM005';
  END IF;
END $$;
REVOKE ALL ON FUNCTION app.assert_ncr_links_free(uuid) FROM PUBLIC;

-- Reopening a cancelled non-conformance: the opening rules, and no reading or finding on another live one.
SELECT pg_temp.patch_once('app.nonconformance_rules()'::regprocedure, 'assert_ncr_links_free(NEW.id)',
  E'IF content_changed THEN\n      RAISE EXCEPTION ''Reopen first, then make changes'' USING ERRCODE = ''QM005'';\n    END IF;\n',
  E'IF content_changed THEN\n      RAISE EXCEPTION ''Reopen first, then make changes'' USING ERRCODE = ''QM005'';\n    END IF;\n    IF OLD.stage = ''cancelled'' THEN\n      PERFORM app.assert_ncr_openable(NEW);\n      PERFORM app.assert_ncr_links_free(NEW.id);\n    END IF;\n');

-- Restoring a deleted one (a restored cancelled NC stays cancelled, which is not live).
SELECT pg_temp.patch_once('app.nonconformance_rules()'::regprocedure, 'restore: links free',
  E'    ELSE\n      NEW.deleted_by := NULL;\n      NEW.delete_reason := NULL;\n',
  E'    ELSE\n      NEW.deleted_by := NULL;\n      NEW.delete_reason := NULL;\n      -- restore: links free\n      IF NEW.stage <> ''cancelled'' THEN\n        PERFORM app.assert_ncr_links_free(NEW.id);\n      END IF;\n');

-- Raising on readings, and adding readings: one at a time per inspection.
SELECT pg_temp.patch_once(
  'app.raise_ncr_from_inspection(uuid, uuid[], text, text, text, numeric, text, text, boolean, uuid)'::regprocedure, 'ncr-readings:',
  E'PERFORM app.assert_readings_free(v_distinct);',
  E'PERFORM pg_advisory_xact_lock(hashtextextended(''ncr-readings:'' || p_inspection_id::text, 0));\n    PERFORM app.assert_readings_free(v_distinct);');
SELECT pg_temp.patch_once(
  'app.add_readings_to_ncr(uuid, uuid[], numeric)'::regprocedure, 'ncr-readings:',
  E'PERFORM app.assert_readings_free(v_ids);',
  E'PERFORM pg_advisory_xact_lock(hashtextextended(''ncr-readings:'' || i.id::text, 0));\n  PERFORM app.assert_readings_free(v_ids);');

-- ---------------------------------------------------------------------------
-- DB-1: an open customer / supplier non-conformance keeps its customer / supplier
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.ncr_keep_opening_fields() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF coalesce(auth.role(), '') <> 'authenticated' OR OLD.stage = 'draft' OR NEW.stage = 'draft' THEN
    RETURN NEW;
  END IF;
  IF OLD.severity IS NOT NULL AND NEW.severity IS NULL THEN
    RAISE EXCEPTION 'The severity cannot be cleared once the non-conformance is open' USING ERRCODE = 'QM005';
  END IF;
  IF OLD.quantity_affected IS NOT NULL AND NEW.quantity_affected IS NULL THEN
    RAISE EXCEPTION 'The quantity affected cannot be cleared once the non-conformance is open' USING ERRCODE = 'QM005';
  END IF;
  IF NEW.part_id IS NULL AND length(trim(coalesce(NEW.description, ''))) = 0
     AND (OLD.part_id IS NOT NULL OR length(trim(coalesce(OLD.description, ''))) > 0) THEN
    RAISE EXCEPTION 'An open non-conformance needs a part or a description' USING ERRCODE = 'QM005';
  END IF;
  IF NEW.source = 'customer' AND OLD.customer_id IS NOT NULL AND NEW.customer_id IS NULL THEN
    RAISE EXCEPTION 'The customer cannot be cleared on an open customer non-conformance' USING ERRCODE = 'QM005';
  END IF;
  IF NEW.source = 'supplier' AND OLD.supplier_id IS NOT NULL AND NEW.supplier_id IS NULL THEN
    RAISE EXCEPTION 'The supplier cannot be cleared on an open supplier non-conformance' USING ERRCODE = 'QM005';
  END IF;
  RETURN NEW;
END $$;
