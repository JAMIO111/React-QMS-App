-- PC5 follow-up: add later failed readings of an inspection to an NC already raised from it.
--
-- A later failure of the same characteristic (or another failure of the same event) belongs on the NC
-- that is already being worked, not on a second one. The person chooses to add it (never automatic);
-- app.add_readings_to_ncr() then links the readings permanently, like app.raise_ncr_from_inspection(),
-- and can update the quantity affected. Rules:
--   * the NC must already be linked to the same inspection (it is not a way to attach arbitrary NCs);
--   * the NC must not be closed, cancelled or deleted (raise a new NC instead);
--   * only current (uncorrected) failed readings of one inspection, and not ones already on this NC;
--   * needs ncr.update at the NC's site and inspection.read at the inspection's site.
-- Errors QM008 -> 409 inspection_rule.
CREATE FUNCTION app.add_readings_to_ncr(
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

REVOKE ALL ON FUNCTION app.add_readings_to_ncr(uuid, uuid[], numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.add_readings_to_ncr(uuid, uuid[], numeric) TO authenticated;
