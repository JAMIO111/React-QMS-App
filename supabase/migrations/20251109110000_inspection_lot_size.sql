-- In-process inspection: lot size.
-- The control plan's "every N parts" sampling rule is checked against the size of the lot being
-- inspected: a lot of L parts needs ceil(L / N) such samples, and no more are accepted. The lot size is
-- set when the inspection starts and, like the rest of the context, does not change afterwards.
-- app.start_inspection gets a trailing p_lot_size parameter (callers using the old arguments still work).

ALTER TABLE public.inspection_records
  ADD COLUMN lot_size integer CHECK (lot_size IS NULL OR lot_size BETWEEN 1 AND 100000000);

DROP FUNCTION app.start_inspection(uuid, uuid, text, uuid, text, text, text, text, uuid, text);

CREATE FUNCTION app.start_inspection(
  p_site_id uuid,
  p_part_id uuid,
  p_operation_code text DEFAULT NULL,
  p_machine_id uuid DEFAULT NULL,
  p_work_order text DEFAULT NULL,
  p_lot text DEFAULT NULL,
  p_serial text DEFAULT NULL,
  p_trigger_type text DEFAULT 'manual',
  p_part_revision_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_lot_size integer DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_org uuid;
  v_r jsonb;
  v_id uuid;
  v_year integer := extract(year FROM current_date)::integer;
  v_n integer;
  v_ref text;
  v_req jsonb;
  v_seq integer := 0;
BEGIN
  SELECT organisation_id INTO v_org FROM public.parts WHERE id = p_part_id;
  IF v_org IS NULL OR NOT app.has_permission(v_org, 'inspection.record', p_site_id) THEN
    RAISE EXCEPTION 'You may not start inspections for this part at this site' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.sites WHERE id = p_site_id AND organisation_id = v_org) THEN
    RAISE EXCEPTION 'Site not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_machine_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.machines WHERE id = p_machine_id AND organisation_id = v_org AND active) THEN
    RAISE EXCEPTION 'Machine not found or inactive' USING ERRCODE = 'QM008';
  END IF;
  IF p_lot_size IS NOT NULL AND p_lot_size < 1 THEN
    RAISE EXCEPTION 'The lot size must be at least 1' USING ERRCODE = 'QM008';
  END IF;

  v_r := app.resolve_inspection_requirements(p_part_id, p_operation_code, p_site_id, p_part_revision_id);
  IF v_r ->> 'status' <> 'ok' THEN
    RAISE EXCEPTION 'The inspection cannot start: %', (SELECT string_agg(e ->> 'message', '; ') FROM jsonb_array_elements(v_r -> 'problems') e)
      USING ERRCODE = 'QM008';
  END IF;

  LOOP
    INSERT INTO app.inspection_counters AS c (organisation_id, year, last_value) VALUES (v_org, v_year, 1)
    ON CONFLICT (organisation_id, year) DO UPDATE SET last_value = c.last_value + 1
    RETURNING last_value INTO v_n;
    v_ref := 'IPI-' || to_char(make_date(v_year, 1, 1), 'YY') || '-' || lpad(v_n::text, 4, '0');
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.inspection_records WHERE organisation_id = v_org AND reference = v_ref);
  END LOOP;

  INSERT INTO public.inspection_records (organisation_id, reference, site_id, part_id, part_revision_id, control_plan_id,
                                         control_plan_revision_id, operation_code, machine_id, work_order, lot, lot_size, serial,
                                         trigger_type, notes, snapshot)
  VALUES (v_org, v_ref, p_site_id, p_part_id, (v_r -> 'partRevision' ->> 'id')::uuid, (v_r -> 'plan' ->> 'id')::uuid,
          (v_r -> 'planRevision' ->> 'id')::uuid, v_r ->> 'operationCode', p_machine_id,
          nullif(trim(p_work_order), ''), nullif(trim(p_lot), ''), p_lot_size, nullif(trim(p_serial), ''),
          coalesce(p_trigger_type, 'manual'), nullif(trim(p_notes), ''), v_r)
  RETURNING id INTO v_id;

  FOR v_req IN SELECT * FROM jsonb_array_elements(v_r -> 'requirements') LOOP
    v_seq := v_seq + 1;
    INSERT INTO public.resolved_inspection_requirements (
      organisation_id, inspection_record_id, sequence, plan_characteristic_id, part_revision_characteristic_id, characteristic_key,
      char_number, name, operation_code, data_type, value_source, spec_key, applicable, applicability, nominal, lower_limit,
      upper_limit, unit_code, method, gauge_type_id, gauge_type_name, criticality, spc_eligible, chart_type, subgroup_size,
      decimals, sampling, reactions)
    VALUES (
      v_org, v_id, v_seq, (v_req ->> 'planCharacteristicId')::uuid, (v_req ->> 'partRevisionCharacteristicId')::uuid,
      v_req ->> 'characteristicKey', v_req ->> 'charNumber', v_req ->> 'name', v_req ->> 'operationCode', v_req ->> 'dataType',
      v_req ->> 'valueSource', v_req ->> 'specKey', (v_req ->> 'applicable')::boolean, v_req ->> 'applicability',
      (v_req ->> 'nominal')::numeric, (v_req ->> 'lowerLimit')::numeric, (v_req ->> 'upperLimit')::numeric, v_req ->> 'unitCode',
      v_req ->> 'method', (v_req -> 'gaugeType' ->> 'id')::uuid, v_req -> 'gaugeType' ->> 'name', v_req ->> 'criticality',
      (v_req ->> 'spcEligible')::boolean, v_req ->> 'chartType', (v_req ->> 'subgroupSize')::integer, (v_req ->> 'decimals')::integer,
      coalesce(v_req -> 'sampling', '[]'::jsonb), coalesce(v_req -> 'reactions', '[]'::jsonb));
  END LOOP;

  PERFORM app.emit_event(v_org, 'inspection.started', 'inspection_record', v_id,
    jsonb_build_object('reference', v_ref, 'part_id', p_part_id, 'part_number', v_r -> 'part' ->> 'partNumber',
      'control_plan_revision_id', v_r -> 'planRevision' ->> 'id', 'operation_code', v_r ->> 'operationCode'));
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION app.start_inspection(uuid, uuid, text, uuid, text, text, text, text, uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.start_inspection(uuid, uuid, text, uuid, text, text, text, text, uuid, text, integer) TO authenticated;
