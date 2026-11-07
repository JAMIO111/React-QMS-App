-- Operator job hub (docs/operator-hub-plan.md, OH1): a job is an in-progress inspection record. The operator starts it knowing only the machine and the part;
-- the work order, lot, quantity (lot size) and serial are typed in afterwards while the job is running (app.set_job_details), then frozen with the record like
-- every other context column. Changes are audited by the existing audit trigger.

CREATE OR REPLACE FUNCTION app.inspection_record_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_missing text;
  v_unhandled text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Only app.start_inspection inserts (users have no INSERT privilege); keep it consistent.
    NEW.status := 'in_progress'; NEW.result := NULL; NEW.completed_at := NULL; NEW.completed_by := NULL; NEW.abandon_reason := NULL;
    NEW.started_at := now();
    RETURN NEW;
  END IF;
  -- While the job is running its work order, lot, lot size and serial can be filled in or corrected (app.set_job_details); every other context column is frozen.
  IF (to_jsonb(NEW) - ARRAY['status', 'result', 'completed_at', 'completed_by', 'abandon_reason', 'notes', 'updated_at', 'updated_by']
        - CASE WHEN OLD.status = 'in_progress' AND NEW.status = 'in_progress' THEN ARRAY['work_order', 'lot', 'lot_size', 'serial'] ELSE ARRAY[]::text[] END)
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'result', 'completed_at', 'completed_by', 'abandon_reason', 'notes', 'updated_at', 'updated_by']
        - CASE WHEN OLD.status = 'in_progress' AND NEW.status = 'in_progress' THEN ARRAY['work_order', 'lot', 'lot_size', 'serial'] ELSE ARRAY[]::text[] END) THEN
    RAISE EXCEPTION 'The context and requirements of an inspection cannot change' USING ERRCODE = 'QM008';
  END IF;
  IF OLD.status <> 'in_progress' THEN
    IF NEW IS DISTINCT FROM OLD AND (NEW.status, NEW.result, NEW.notes, NEW.abandon_reason) IS DISTINCT FROM (OLD.status, OLD.result, OLD.notes, OLD.abandon_reason) THEN
      RAISE EXCEPTION 'Inspection % is %', OLD.reference, OLD.status USING ERRCODE = 'QM008';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'in_progress' THEN
    IF (NEW.result, NEW.completed_at, NEW.completed_by, NEW.abandon_reason) IS DISTINCT FROM (OLD.result, OLD.completed_at, OLD.completed_by, OLD.abandon_reason) THEN
      RAISE EXCEPTION 'The result is worked out when the inspection is completed' USING ERRCODE = 'QM008';
    END IF;
    RETURN NEW;
  END IF;
  NEW.completed_at := now();
  NEW.completed_by := auth.uid();
  IF NEW.status = 'abandoned' THEN
    IF coalesce(trim(NEW.abandon_reason), '') = '' THEN
      RAISE EXCEPTION 'Give a reason for abandoning the inspection' USING ERRCODE = 'QM008';
    END IF;
    NEW.result := NULL;
    RETURN NEW;
  END IF;
  -- Completed.
  NEW.abandon_reason := NULL;
  SELECT string_agg(q.name, ', ' ORDER BY q.sequence) INTO v_missing
  FROM public.resolved_inspection_requirements q
  WHERE q.inspection_record_id = NEW.id AND q.applicable
    AND NOT EXISTS (SELECT 1 FROM public.inspection_measurements m WHERE m.requirement_id = q.id);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Measure every check before completing; missing: %', v_missing USING ERRCODE = 'QM008';
  END IF;
  -- Every current failed reading needs an acknowledgement or a live NC (one that is not cancelled or deleted).
  SELECT string_agg(q.name || ' (sample ' || s.sample_number || ')', ', ' ORDER BY s.sample_number, q.sequence) INTO v_unhandled
  FROM public.inspection_measurements m
  JOIN public.resolved_inspection_requirements q ON q.id = m.requirement_id
  JOIN public.inspection_samples s ON s.id = m.sample_id
  WHERE m.inspection_record_id = NEW.id AND m.result = 'fail'
    AND NOT EXISTS (SELECT 1 FROM public.inspection_measurements c WHERE c.supersedes_id = m.id)
    AND NOT EXISTS (SELECT 1 FROM public.inspection_failure_acknowledgements a WHERE a.measurement_id = m.id)
    AND app.reading_live_ncr(m.id) IS NULL;
  IF v_unhandled IS NOT NULL THEN
    RAISE EXCEPTION 'Acknowledge or raise an NC for each failed reading before completing: %', v_unhandled USING ERRCODE = 'QM008';
  END IF;
  NEW.result := CASE WHEN EXISTS (
      SELECT 1 FROM public.inspection_measurements m
      WHERE m.inspection_record_id = NEW.id AND m.result = 'fail'
        AND NOT EXISTS (SELECT 1 FROM public.inspection_measurements c WHERE c.supersedes_id = m.id))
    THEN 'fail' ELSE 'pass' END;
  RETURN NEW;
END $$;


-- Fill in or correct the work order, lot, lot size and serial of a running job. Needs inspection.record at the job's site.
-- Arguments left NULL are kept; an empty text clears the value.
CREATE FUNCTION app.set_job_details(p_inspection_id uuid, p_work_order text DEFAULT NULL, p_lot text DEFAULT NULL, p_lot_size integer DEFAULT NULL, p_serial text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.inspection_records%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.inspection_records WHERE id = p_inspection_id;
  IF NOT FOUND OR NOT app.has_permission(r.organisation_id, 'inspection.record', r.site_id) THEN
    RAISE EXCEPTION 'Inspection not found' USING ERRCODE = 'P0002';
  END IF;
  IF r.status <> 'in_progress' THEN
    RAISE EXCEPTION 'Inspection % is %', r.reference, r.status USING ERRCODE = 'QM008';
  END IF;
  IF p_lot_size IS NOT NULL AND (p_lot_size < 1 OR p_lot_size > 100000000) THEN
    RAISE EXCEPTION 'The quantity must be at least 1' USING ERRCODE = 'QM008';
  END IF;
  IF length(coalesce(p_work_order, '')) > 60 OR length(coalesce(p_lot, '')) > 60 OR length(coalesce(p_serial, '')) > 60 THEN
    RAISE EXCEPTION 'Work order, lot and serial are at most 60 characters' USING ERRCODE = 'QM008';
  END IF;
  UPDATE public.inspection_records
     SET work_order = CASE WHEN p_work_order IS NULL THEN work_order ELSE nullif(trim(p_work_order), '') END,
         lot = CASE WHEN p_lot IS NULL THEN lot ELSE nullif(trim(p_lot), '') END,
         lot_size = coalesce(p_lot_size, lot_size),
         serial = CASE WHEN p_serial IS NULL THEN serial ELSE nullif(trim(p_serial), '') END
   WHERE id = p_inspection_id;
END $$;
REVOKE ALL ON FUNCTION app.set_job_details(uuid, text, text, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.set_job_details(uuid, text, text, integer, text) TO authenticated;
