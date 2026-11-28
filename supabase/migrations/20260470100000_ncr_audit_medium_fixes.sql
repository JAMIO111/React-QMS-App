-- NC module audit (docs/audit-nc-2026-11.md), the medium findings that need the database.
--
-- DB-3  The limits on dispositions, affected lots and containment, and the stage gates, were check-then-write with no lock: two people proposing 8 of 10
--       both passed, and closing an NC while someone added an open containment action could commit both. Writing to any of the three tables now takes the
--       non-conformance's row lock first, which is also the lock the stage-gate trigger holds while it checks (so the two cannot overlap).
-- DB-4  Changing an NC's part did not look at its production order, lot, serial number or affected lots. It now refuses a part that disagrees with any of them.
-- DB-5  Raising an NC from an inspection accepted readings that had been corrected (superseded) and an abandoned inspection; adding readings already refused
--       the first. Both are refused now.
-- API-6 The reporting dataset of non-conformances moved its updated_at only with live cost lines, so deleting a cost line left an incremental pull with a
--       stale total. The latest change of any line, deleted ones included, now counts.

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
-- DB-3: one writer at a time per non-conformance
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER so the lock does not depend on the caller's update rights (someone who may only add files or actions has no UPDATE policy on the NC).
-- The trigger name sorts before the rule triggers, so the lock is taken before any limit is read.
CREATE OR REPLACE FUNCTION app.ncr_lock_parent() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM 1 FROM public.nonconformances n WHERE n.id = NEW.nonconformance_id FOR UPDATE;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.ncr_lock_parent() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_ncr_lock_parent ON public.ncr_dispositions;
CREATE TRIGGER a_ncr_lock_parent BEFORE INSERT OR UPDATE ON public.ncr_dispositions FOR EACH ROW EXECUTE FUNCTION app.ncr_lock_parent();
DROP TRIGGER IF EXISTS a_ncr_lock_parent ON public.ncr_containment_actions;
CREATE TRIGGER a_ncr_lock_parent BEFORE INSERT OR UPDATE ON public.ncr_containment_actions FOR EACH ROW EXECUTE FUNCTION app.ncr_lock_parent();
DROP TRIGGER IF EXISTS a_ncr_lock_parent ON public.ncr_affected_lots;
CREATE TRIGGER a_ncr_lock_parent BEFORE INSERT OR UPDATE ON public.ncr_affected_lots FOR EACH ROW EXECUTE FUNCTION app.ncr_lock_parent();

-- ---------------------------------------------------------------------------
-- DB-4: a new part must agree with the order, lot, serial number and affected lots already on the NC
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.ncr_part_change_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_what text;
BEGIN
  IF NEW.part_id IS NULL OR NEW.part_id IS NOT DISTINCT FROM OLD.part_id THEN
    RETURN NEW;
  END IF;
  IF NEW.production_order_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.production_orders o WHERE o.id = NEW.production_order_id AND o.part_id <> NEW.part_id) THEN
    v_what := 'its production order';
  ELSIF NEW.lot_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.lots l WHERE l.id = NEW.lot_id AND l.part_id <> NEW.part_id) THEN
    v_what := 'its lot';
  ELSIF NEW.serial_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.serial_numbers s WHERE s.id = NEW.serial_id AND s.part_id <> NEW.part_id) THEN
    v_what := 'its serial number';
  ELSIF EXISTS (SELECT 1 FROM public.ncr_affected_lots a JOIN public.lots l ON l.id = a.lot_id
                 WHERE a.nonconformance_id = NEW.id AND a.removed_at IS NULL AND l.part_id <> NEW.part_id) THEN
    v_what := 'its affected lots';
  END IF;
  IF v_what IS NOT NULL THEN
    RAISE EXCEPTION 'The new part does not match %; take that link off first, or keep the part', v_what USING ERRCODE = 'QM005';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.ncr_part_change_rules() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS nonconformances_part_change ON public.nonconformances;
CREATE TRIGGER nonconformances_part_change BEFORE UPDATE OF part_id ON public.nonconformances FOR EACH ROW EXECUTE FUNCTION app.ncr_part_change_rules();

-- ---------------------------------------------------------------------------
-- DB-5: only current readings of a job still being worked or finished
-- ---------------------------------------------------------------------------
SELECT pg_temp.patch_once(
  'app.raise_ncr_from_inspection(uuid, uuid[], text, text, text, numeric, text, text, boolean, uuid)'::regprocedure, 'DB-5a',
  E'WHERE m.id = ANY (v_distinct) AND m.inspection_record_id = p_inspection_id AND m.result = ''fail'') <> v_found THEN\n      RAISE EXCEPTION ''Only failed readings of this inspection can be linked to the non-conformance'' USING ERRCODE = ''QM008'';',
  E'WHERE m.id = ANY (v_distinct) AND m.inspection_record_id = p_inspection_id AND m.result = ''fail''\n          -- DB-5a: a corrected reading is replaced by its correction\n          AND NOT EXISTS (SELECT 1 FROM public.inspection_measurements c WHERE c.supersedes_id = m.id)) <> v_found THEN\n      RAISE EXCEPTION ''Only current failed readings of this inspection can be linked to the non-conformance (a corrected reading is replaced by its correction)'' USING ERRCODE = ''QM008'';');
SELECT pg_temp.patch_once(
  'app.raise_ncr_from_inspection(uuid, uuid[], text, text, text, numeric, text, text, boolean, uuid)'::regprocedure, 'DB-5b',
  E'  IF v_title IS NULL THEN\n    RAISE EXCEPTION ''Give the non-conformance a title'' USING ERRCODE = ''QM008'';\n  END IF;\n',
  E'  -- DB-5b: an abandoned inspection stands for nothing that was made\n  IF r.status = ''abandoned'' THEN\n    RAISE EXCEPTION ''% was abandoned; raise the non-conformance from the NC register instead'', r.reference USING ERRCODE = ''QM008'';\n  END IF;\n  IF v_title IS NULL THEN\n    RAISE EXCEPTION ''Give the non-conformance a title'' USING ERRCODE = ''QM008'';\n  END IF;\n');

-- ---------------------------------------------------------------------------
-- API-6: the reporting dataset moves when a cost line is deleted too
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.report_non_conformances WITH (security_invoker = true) AS
SELECT n.id, n.organisation_id, n.reference, n.title, n.source, n.stage, n.severity,
       cat.name AS category, fm.name AS failure_mode, sfm.name AS sub_failure_mode,
       n.description, n.requirement, n.actual_result,
       s.code AS site_code, s.name AS site,
       p.part_number, p.name AS part_name,
       cu.code AS customer_code, cu.name AS customer,
       su.code AS supplier_code, su.name AS supplier,
       n.work_order, n.purchase_order, n.customer_reference, n.lot_number, n.serial_number,
       n.quantity_affected, n.quantity_inspected,
       n.detected_at AS detected_on, n.created_at AS raised_at, n.closed_at,
       dm.name AS detected_at_machine, cm.name AS causal_machine, rd.name AS responsible_department,
       nullif(btrim(coalesce(de.first_name, '') || ' ' || coalesce(de.surname, '')), '') AS detected_by,
       nullif(btrim(coalesce(re.first_name, '') || ' ' || coalesce(re.surname, '')), '') AS responsible_employee,
       tc.currency AS cost_currency, tc.total AS total_cost, tc.lines AS cost_lines, tc.waiting AS cost_lines_waiting_for_rate,
       greatest(n.updated_at, tc.last_change) AS updated_at
  FROM public.nonconformances n
  LEFT JOIN public.ncr_classifications cat ON cat.id = n.category_id
  LEFT JOIN public.ncr_classifications fm ON fm.id = n.failure_mode_id
  LEFT JOIN public.ncr_classifications sfm ON sfm.id = n.sub_failure_mode_id
  LEFT JOIN public.sites s ON s.id = n.site_id
  LEFT JOIN public.parts p ON p.id = n.part_id
  LEFT JOIN public.customers cu ON cu.id = n.customer_id
  LEFT JOIN public.suppliers su ON su.id = n.supplier_id
  LEFT JOIN public.machines dm ON dm.id = n.detection_process_id
  LEFT JOIN public.machines cm ON cm.id = n.causal_process_id
  LEFT JOIN public.departments rd ON rd.id = n.responsible_department_id
  LEFT JOIN public."Employees" de ON de.id = n.detected_by_employee_id
  LEFT JOIN public."Employees" re ON re.id = n.responsible_employee_id
  LEFT JOIN LATERAL (
    SELECT sum(c.net_org * c.cost_sign) FILTER (WHERE c.deleted_at IS NULL) AS total, max(c.org_currency) FILTER (WHERE c.deleted_at IS NULL) AS currency,
           count(*) FILTER (WHERE c.deleted_at IS NULL) AS lines,
           count(*) FILTER (WHERE c.deleted_at IS NULL AND c.net_org IS NULL) AS waiting,
           max(c.updated_at) AS last_change
      FROM public.ncr_costs c WHERE c.nonconformance_id = n.id
  ) tc ON true
 WHERE n.deleted_at IS NULL;
