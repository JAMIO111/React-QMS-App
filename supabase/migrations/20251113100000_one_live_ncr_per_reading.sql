-- One live NC per failed reading, and a history entry when readings are linked to an NC.
--
--  * A failed reading may be on only one live non-conformance. "Live" means not cancelled and not
--    deleted: a cancelled NC (raised in error) frees its readings, which then count as unhandled again
--    until they are acknowledged or put on another NC. app.reading_live_ncr() answers it; the completion
--    rule, app.raise_ncr_from_inspection() and app.add_readings_to_ncr() all use it, so the same sample
--    cannot be put on two NCs (QM008 -> 409 inspection_rule). A whole-inspection NC (no reading) is
--    unaffected.
--  * app.ncr_link_history(): who linked which readings to an NC and when, from the audit trail, for the
--    NC's history (the quantity change shows in the usual history already).

CREATE FUNCTION app.reading_live_ncr(p_measurement_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN app.has_permission(n.organisation_id, 'ncr.read', n.site_id) THEN n.reference ELSE 'another non-conformance' END
  FROM public.inspection_ncr_links l
  JOIN public.nonconformances n ON n.id = l.nonconformance_id
  WHERE l.measurement_id = p_measurement_id AND n.stage <> 'cancelled' AND n.deleted_at IS NULL
  ORDER BY n.created_at LIMIT 1
$$;

/* Refuses readings that are already on a live NC, naming them. */
CREATE FUNCTION app.assert_readings_free(p_measurement_ids uuid[]) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_taken text;
BEGIN
  SELECT string_agg(q.name || ' (sample ' || s.sample_number || ') is already on ' || app.reading_live_ncr(m.id), '; ' ORDER BY s.sample_number, q.sequence)
  INTO v_taken
  FROM public.inspection_measurements m
  JOIN public.resolved_inspection_requirements q ON q.id = m.requirement_id
  JOIN public.inspection_samples s ON s.id = m.sample_id
  WHERE m.id = ANY (p_measurement_ids) AND app.reading_live_ncr(m.id) IS NOT NULL;
  IF v_taken IS NOT NULL THEN
    RAISE EXCEPTION '%; add it to that non-conformance or cancel it first', v_taken USING ERRCODE = 'QM008';
  END IF;
END $$;

CREATE FUNCTION app.ncr_link_history(p_ncr_id uuid)
RETURNS TABLE (id uuid, created_at timestamptz, actor_user_id uuid, transaction_id bigint, inspection_record_id uuid, measurement_id uuid, raised_with_ncr boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT e.id, e.created_at, e.actor_user_id, e.transaction_id,
         (e.new_values ->> 'inspection_record_id')::uuid, (e.new_values ->> 'measurement_id')::uuid,
         -- true when the NC itself was created in the same transaction (raised from the inspection, not added later)
         EXISTS (SELECT 1 FROM audit.events c WHERE c.entity_type = 'nonconformances' AND c.entity_id = p_ncr_id::text
                   AND c.action = 'insert' AND c.transaction_id = e.transaction_id)
  FROM audit.events e
  JOIN public.nonconformances n ON n.id = p_ncr_id
  WHERE e.entity_type = 'inspection_ncr_links' AND e.action = 'insert'
    AND e.new_values ->> 'nonconformance_id' = p_ncr_id::text
    AND e.organisation_id = n.organisation_id
    AND app.has_permission(n.organisation_id, 'ncr.read', n.site_id)
  ORDER BY e.seq
$$;

-- Completion rule: a failed reading is handled by an acknowledgement or a live NC.
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
  IF (to_jsonb(NEW) - ARRAY['status', 'result', 'completed_at', 'completed_by', 'abandon_reason', 'notes', 'updated_at', 'updated_by'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'result', 'completed_at', 'completed_by', 'abandon_reason', 'notes', 'updated_at', 'updated_by']) THEN
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

-- Raising an NC: its readings must not already be on a live NC.
CREATE OR REPLACE FUNCTION app.raise_ncr_from_inspection(
  p_inspection_id uuid,
  p_measurement_ids uuid[] DEFAULT ARRAY[]::uuid[],
  p_title text DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_severity text DEFAULT NULL,
  p_quantity_affected numeric DEFAULT NULL,
  p_requirement text DEFAULT NULL,
  p_actual_result text DEFAULT NULL,
  p_open boolean DEFAULT false
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  r record;
  v_ids uuid[] := coalesce(p_measurement_ids, ARRAY[]::uuid[]);
  v_distinct uuid[];
  v_found integer;
  v_ncr uuid;
  v_detected date;
  v_title text := nullif(trim(p_title), '');
BEGIN
  SELECT i.id, i.organisation_id, i.site_id, i.part_id, i.part_revision_id, i.work_order, i.lot, i.serial, i.reference, i.status
  INTO r FROM public.inspection_records i WHERE i.id = p_inspection_id;
  IF r.id IS NULL OR NOT app.has_permission(r.organisation_id, 'inspection.read', r.site_id) THEN
    RAISE EXCEPTION 'Inspection not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT app.has_permission(r.organisation_id, 'ncr.create', r.site_id) THEN
    RAISE EXCEPTION 'You may not raise non-conformances' USING ERRCODE = '42501';
  END IF;
  IF v_title IS NULL THEN
    RAISE EXCEPTION 'Give the non-conformance a title' USING ERRCODE = 'QM008';
  END IF;

  SELECT array_agg(DISTINCT x) INTO v_distinct FROM unnest(v_ids) x;
  v_found := coalesce(cardinality(v_distinct), 0);
  IF v_found > 0 THEN
    IF (SELECT count(*) FROM public.inspection_measurements m
        WHERE m.id = ANY (v_distinct) AND m.inspection_record_id = p_inspection_id AND m.result = 'fail') <> v_found THEN
      RAISE EXCEPTION 'Only failed readings of this inspection can be linked to the non-conformance' USING ERRCODE = 'QM008';
    END IF;
    SELECT min(m.measured_at)::date INTO v_detected FROM public.inspection_measurements m WHERE m.id = ANY (v_distinct);
    PERFORM app.assert_readings_free(v_distinct);
  END IF;

  INSERT INTO public.nonconformances (organisation_id, reference, source, stage, severity, title, description, requirement, actual_result,
                                      site_id, part_id, part_revision_id, work_order, lot_number, serial_number, quantity_affected,
                                      detected_at, detected_by)
  VALUES (r.organisation_id, 'pending', 'internal', CASE WHEN coalesce(p_open, false) THEN 'open' ELSE 'draft' END,
          nullif(p_severity, ''), left(v_title, 200), nullif(trim(p_description), ''), nullif(trim(p_requirement), ''), nullif(trim(p_actual_result), ''),
          r.site_id, r.part_id, r.part_revision_id, r.work_order, r.lot, r.serial, p_quantity_affected,
          coalesce(v_detected, current_date), auth.uid())
  RETURNING id INTO v_ncr;

  IF v_found = 0 THEN
    INSERT INTO public.inspection_ncr_links (organisation_id, nonconformance_id, inspection_record_id) VALUES (r.organisation_id, v_ncr, p_inspection_id);
  ELSE
    INSERT INTO public.inspection_ncr_links (organisation_id, nonconformance_id, inspection_record_id, measurement_id)
    SELECT r.organisation_id, v_ncr, p_inspection_id, x FROM unnest(v_distinct) x;
  END IF;

  PERFORM app.emit_event(r.organisation_id, 'inspection.ncr_raised', 'inspection_record', p_inspection_id,
    jsonb_build_object('reference', r.reference, 'nonconformance_id', v_ncr, 'readings', v_found));
  RETURN v_ncr;
END $$;

-- Adding readings to an NC: likewise.
CREATE OR REPLACE FUNCTION app.add_readings_to_ncr(
  p_ncr_id uuid,
  p_measurement_ids uuid[],
  p_quantity_affected numeric DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  n record;
  i record;
  v_ids uuid[];
  v_found integer;
  v_records uuid[];
  v_added integer;
BEGIN
  SELECT id, organisation_id, stage, site_id, deleted_at, reference INTO n FROM public.nonconformances WHERE id = p_ncr_id;
  IF n.id IS NULL OR NOT app.has_permission(n.organisation_id, 'ncr.read', n.site_id) THEN
    RAISE EXCEPTION 'Non-conformance not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT app.has_permission(n.organisation_id, 'ncr.update', n.site_id) THEN
    RAISE EXCEPTION 'You may not change non-conformances' USING ERRCODE = '42501';
  END IF;
  IF n.deleted_at IS NOT NULL OR n.stage IN ('closed', 'cancelled') THEN
    RAISE EXCEPTION '% is % and cannot take more readings; raise a new non-conformance', n.reference,
      CASE WHEN n.deleted_at IS NOT NULL THEN 'deleted' ELSE n.stage END USING ERRCODE = 'QM008';
  END IF;

  SELECT array_agg(DISTINCT x) INTO v_ids FROM unnest(coalesce(p_measurement_ids, ARRAY[]::uuid[])) x;
  v_found := coalesce(cardinality(v_ids), 0);
  IF v_found = 0 THEN
    RAISE EXCEPTION 'Choose at least one failed reading to add' USING ERRCODE = 'QM008';
  END IF;
  SELECT array_agg(DISTINCT m.inspection_record_id) INTO v_records
  FROM public.inspection_measurements m WHERE m.id = ANY (v_ids) AND m.organisation_id = n.organisation_id;
  IF coalesce(cardinality(v_records), 0) <> 1
     OR (SELECT count(*) FROM public.inspection_measurements m WHERE m.id = ANY (v_ids) AND m.result = 'fail') <> v_found
     OR EXISTS (SELECT 1 FROM public.inspection_measurements c WHERE c.supersedes_id = ANY (v_ids)) THEN
    RAISE EXCEPTION 'Only current failed readings of one inspection can be added' USING ERRCODE = 'QM008';
  END IF;
  SELECT r.id, r.site_id, r.reference INTO i FROM public.inspection_records r WHERE r.id = v_records[1];
  IF NOT app.has_permission(n.organisation_id, 'inspection.read', i.site_id) THEN
    RAISE EXCEPTION 'Inspection not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.inspection_ncr_links l WHERE l.nonconformance_id = p_ncr_id AND l.inspection_record_id = i.id) THEN
    RAISE EXCEPTION '% was not raised from inspection %; raise a new non-conformance for these readings', n.reference, i.reference USING ERRCODE = 'QM008';
  END IF;

  PERFORM app.assert_readings_free(v_ids);
  INSERT INTO public.inspection_ncr_links (organisation_id, nonconformance_id, inspection_record_id, measurement_id)
  SELECT n.organisation_id, p_ncr_id, i.id, x FROM unnest(v_ids) x
  ON CONFLICT (nonconformance_id, coalesce(measurement_id, '00000000-0000-0000-0000-000000000000'::uuid)) DO NOTHING;
  GET DIAGNOSTICS v_added = ROW_COUNT;
  IF v_added = 0 THEN
    RAISE EXCEPTION 'These readings are already on %', n.reference USING ERRCODE = 'QM008';
  END IF;
  IF p_quantity_affected IS NOT NULL THEN
    UPDATE public.nonconformances SET quantity_affected = p_quantity_affected WHERE id = p_ncr_id;
  END IF;
  PERFORM app.emit_event(n.organisation_id, 'inspection.ncr_readings_added', 'inspection_record', i.id,
    jsonb_build_object('reference', i.reference, 'nonconformance_id', p_ncr_id, 'readings', v_added));
  RETURN v_added;
END $$;

REVOKE ALL ON FUNCTION app.reading_live_ncr(uuid), app.assert_readings_free(uuid[]), app.ncr_link_history(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reading_live_ncr(uuid), app.ncr_link_history(uuid) TO authenticated;
