-- Process control, slice PC3 (docs/process-control-plan.md §2 "Requirement resolver", PCB §5, §12):
-- given a part (and optionally an operation, a site and a specific released part revision), find the
-- one effective control plan revision that applies and resolve its characteristics for that part:
--   * fixed characteristics take the plan's nominal and limits;
--   * part-specific ones take the part revision's value with the same spec key (unit must match);
--   * conditional ones apply only to their listed parts; the others are returned as not applicable,
--     with the reason, never silently dropped.
-- The resolver refuses (status "blocked", with every problem listed) rather than guessing when:
-- the part is inactive or in no family, it has no released revision (or the given revision is not
-- released), no effective plan revision applies, more than one plan applies, the operation is not in
-- the plan, a part-specific value is missing or its unit differs from the plan's.
--
-- It runs with the caller's rights (RLS applies) and only reads. PC4 calls it inside the transaction
-- that creates an inspection and freezes the result as the inspection's requirement snapshot.

CREATE FUNCTION app.resolve_inspection_requirements(
  p_part_id uuid,
  p_operation_code text DEFAULT NULL,
  p_site_id uuid DEFAULT NULL,
  p_part_revision_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_part record;
  v_family record;
  v_rev record;
  v_op text := nullif(upper(trim(p_operation_code)), '');
  v_plans jsonb;
  v_plan_count integer;
  v_plan_id uuid;
  v_plan_code text;
  v_plan_title text;
  v_plan_rev_id uuid;
  v_plan_rev_code text;
  v_problems jsonb := '[]'::jsonb;
  v_requirements jsonb := '[]'::jsonb;
  v_general jsonb;
  ch record;
  v_s_id uuid;
  v_s_nominal numeric;
  v_s_lower numeric;
  v_s_upper numeric;
  v_s_unit text;
  v_applicable boolean;
  v_reason text;
  v_nominal numeric;
  v_lower numeric;
  v_upper numeric;
  v_unit text;
  v_spec_id uuid;
  v_ok boolean;
BEGIN
  -- Part and family.
  SELECT p.id, p.organisation_id, p.part_number, p.name, p.active, p.part_family_id INTO v_part
  FROM public.parts p WHERE p.id = p_part_id;
  IF v_part.id IS NULL THEN
    RAISE EXCEPTION 'Part not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT v_part.active THEN
    v_problems := v_problems || jsonb_build_object('code', 'part_inactive', 'message', format('Part %s is inactive', v_part.part_number));
  END IF;
  SELECT f.id, f.code, f.name INTO v_family FROM public.part_families f WHERE f.id = v_part.part_family_id;
  IF v_family.id IS NULL THEN
    v_problems := v_problems || jsonb_build_object('code', 'no_family',
      'message', format('Part %s is not in a part family, so no control plan applies to it', v_part.part_number));
  END IF;

  -- Part specification revision: the released one, or the one asked for (which must be released).
  IF p_part_revision_id IS NULL THEN
    SELECT r.id, r.revision, r.drawing_ref, r.status INTO v_rev FROM public.part_revisions r
    WHERE r.part_id = p_part_id AND r.status = 'released';
    IF v_rev.id IS NULL THEN
      v_problems := v_problems || jsonb_build_object('code', 'no_released_revision',
        'message', format('Part %s has no released revision', v_part.part_number));
    END IF;
  ELSE
    SELECT r.id, r.revision, r.drawing_ref, r.status INTO v_rev FROM public.part_revisions r
    WHERE r.id = p_part_revision_id AND r.part_id = p_part_id;
    IF v_rev.id IS NULL THEN
      RAISE EXCEPTION 'Part revision not found' USING ERRCODE = 'P0002';
    ELSIF v_rev.status <> 'released' THEN
      v_problems := v_problems || jsonb_build_object('code', 'revision_not_released',
        'message', format('Revision %s of %s is %s; only a released revision can be inspected', v_rev.revision, v_part.part_number, v_rev.status));
    END IF;
  END IF;

  -- Plans whose scope covers this part (and operation / site when given), with their effective revision.
  IF v_family.id IS NOT NULL THEN
    SELECT coalesce(jsonb_agg(x ORDER BY x ->> 'planCode'), '[]'::jsonb), count(*) FILTER (WHERE x ->> 'revisionId' IS NOT NULL)
    INTO v_plans, v_plan_count
    FROM (
      SELECT DISTINCT ON (cp.id) jsonb_build_object('id', cp.id, 'planCode', cp.plan_code, 'title', cp.title,
               'revisionId', er.id, 'revisionCode', er.revision_code) AS x
      FROM public.control_plan_applicability a
      JOIN public.control_plans cp ON cp.id = a.control_plan_id AND cp.active
      LEFT JOIN public.control_plan_revisions er ON er.control_plan_id = cp.id AND er.status = 'effective'
      WHERE a.part_family_id = v_family.id
        AND (a.part_id IS NULL OR a.part_id = p_part_id)
        AND (a.site_id IS NULL OR p_site_id IS NULL OR a.site_id = p_site_id)
        AND (a.operation_code IS NULL OR v_op IS NULL OR a.operation_code = v_op)
      ORDER BY cp.id
    ) plans;
    IF v_plan_count = 0 THEN
      v_problems := v_problems || jsonb_build_object('code', 'no_effective_plan',
        'message', CASE WHEN jsonb_array_length(v_plans) = 0
          THEN format('No control plan covers %s%s', v_part.part_number, CASE WHEN v_op IS NULL THEN '' ELSE ' at ' || v_op END)
          ELSE format('No effective revision of %s', (SELECT string_agg(e ->> 'planCode', ', ') FROM jsonb_array_elements(v_plans) e)) END);
    ELSIF v_plan_count > 1 THEN
      v_problems := v_problems || jsonb_build_object('code', 'ambiguous_plan',
        'message', format('More than one control plan applies (%s); narrow their scope (part, site or operation) so only one does',
          (SELECT string_agg(e ->> 'planCode', ', ') FROM jsonb_array_elements(v_plans) e WHERE e ->> 'revisionId' IS NOT NULL)));
    ELSE
      SELECT (e ->> 'id')::uuid, e ->> 'planCode', e ->> 'title', (e ->> 'revisionId')::uuid, e ->> 'revisionCode'
      INTO v_plan_id, v_plan_code, v_plan_title, v_plan_rev_id, v_plan_rev_code
      FROM jsonb_array_elements(v_plans) e WHERE e ->> 'revisionId' IS NOT NULL;
    END IF;
  END IF;

  IF v_plan_rev_id IS NOT NULL AND v_op IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.control_plan_operations o WHERE o.control_plan_revision_id = v_plan_rev_id AND o.operation_code = v_op) THEN
    v_problems := v_problems || jsonb_build_object('code', 'operation_not_in_plan',
      'message', format('Revision %s of %s has no operation %s', v_plan_rev_code, v_plan_code, v_op));
  END IF;

  -- Characteristics.
  IF v_plan_rev_id IS NOT NULL THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('triggerType', x.trigger_type, 'action', x.action, 'instruction', x.instruction)
                              ORDER BY x.trigger_type, x.created_at), '[]'::jsonb)
    INTO v_general FROM public.reaction_plans x WHERE x.control_plan_revision_id = v_plan_rev_id AND x.plan_characteristic_id IS NULL;

    FOR ch IN
      SELECT c.*, o.operation_code, o.sequence AS op_sequence, o.name AS operation_name, o.machine_id, g.name AS gauge_type_name
      FROM public.control_plan_characteristics c
      JOIN public.control_plan_operations o ON o.id = c.operation_id
      LEFT JOIN public.gauge_types g ON g.id = c.gauge_type_id
      WHERE c.control_plan_revision_id = v_plan_rev_id AND (v_op IS NULL OR o.operation_code = v_op)
      ORDER BY o.sequence, o.operation_code, c.sequence, c.characteristic_key
    LOOP
      v_applicable := ch.applies_to = 'all'
        OR EXISTS (SELECT 1 FROM public.characteristic_applicability a WHERE a.plan_characteristic_id = ch.id AND a.part_id = p_part_id);
      v_reason := CASE WHEN ch.applies_to = 'all' THEN 'All parts in scope'
        WHEN v_applicable THEN format('Selected for %s', v_part.part_number)
        ELSE format('Only for %s', (SELECT string_agg(p.part_number, ', ' ORDER BY p.part_number)
                                    FROM public.characteristic_applicability a JOIN public.parts p ON p.id = a.part_id
                                    WHERE a.plan_characteristic_id = ch.id)) END;
      v_nominal := ch.nominal; v_lower := ch.lower_limit; v_upper := ch.upper_limit; v_unit := ch.unit_code; v_spec_id := NULL;
      v_ok := true;
      IF ch.value_source = 'part_spec' AND v_applicable THEN
        v_s_id := NULL; v_s_nominal := NULL; v_s_lower := NULL; v_s_upper := NULL; v_s_unit := NULL;
        IF v_rev.id IS NOT NULL THEN
          SELECT s.id, s.nominal, s.lower_limit, s.upper_limit, s.unit_code INTO v_s_id, v_s_nominal, v_s_lower, v_s_upper, v_s_unit
          FROM public.part_revision_characteristics s WHERE s.part_revision_id = v_rev.id AND s.characteristic_key = ch.spec_key;
        END IF;
        IF v_s_id IS NULL THEN
          v_ok := false;
          IF v_rev.id IS NOT NULL THEN
            v_problems := v_problems || jsonb_build_object('code', 'missing_spec_value', 'characteristicKey', ch.characteristic_key,
              'message', format('%s revision %s has no %s value (needed by %s)', v_part.part_number, v_rev.revision, ch.spec_key, ch.name));
          END IF;
        ELSIF v_s_unit IS DISTINCT FROM ch.unit_code THEN
          v_ok := false;
          v_problems := v_problems || jsonb_build_object('code', 'unit_mismatch', 'characteristicKey', ch.characteristic_key,
            'message', format('%s: the plan measures in %s but %s revision %s gives %s in %s', ch.name, ch.unit_code,
              v_part.part_number, v_rev.revision, ch.spec_key, v_s_unit));
        ELSE
          v_nominal := v_s_nominal; v_lower := v_s_lower; v_upper := v_s_upper; v_unit := v_s_unit; v_spec_id := v_s_id;
        END IF;
        IF NOT v_ok THEN v_nominal := NULL; v_lower := NULL; v_upper := NULL; END IF;
      END IF;

      v_requirements := v_requirements || jsonb_build_object(
        'planCharacteristicId', ch.id,
        'characteristicKey', ch.characteristic_key,
        'charNumber', ch.char_number,
        'name', ch.name,
        'operationCode', ch.operation_code,
        'operationName', ch.operation_name,
        'machineId', ch.machine_id,
        'dataType', ch.data_type,
        'valueSource', ch.value_source,
        'specKey', ch.spec_key,
        'partRevisionCharacteristicId', v_spec_id,
        'applicable', v_applicable,
        'applicability', v_reason,
        'resolved', v_ok,
        'nominal', v_nominal,
        'lowerLimit', v_lower,
        'upperLimit', v_upper,
        'unitCode', v_unit,
        'method', ch.method,
        'gaugeType', CASE WHEN ch.gauge_type_id IS NULL THEN NULL ELSE jsonb_build_object('id', ch.gauge_type_id, 'name', ch.gauge_type_name) END,
        'criticality', ch.criticality,
        'spcEligible', ch.spc_eligible,
        'chartType', ch.chart_type,
        'subgroupSize', ch.subgroup_size,
        'decimals', ch.decimals,
        'sampling', (SELECT coalesce(jsonb_agg(jsonb_build_object('triggerType', s.trigger_type, 'intervalValue', s.interval_value, 'sampleSize', s.sample_size)
                       ORDER BY array_position(ARRAY['first_off','start_of_shift','after_setup','after_tool_change','every_n_minutes','every_n_parts','last_off','manual'], s.trigger_type)), '[]'::jsonb)
                     FROM public.sampling_rules s WHERE s.plan_characteristic_id = ch.id),
        'reactions', (SELECT coalesce(jsonb_agg(jsonb_build_object('triggerType', x.trigger_type, 'action', x.action, 'instruction', x.instruction)
                        ORDER BY x.trigger_type, x.created_at), '[]'::jsonb)
                      FROM public.reaction_plans x WHERE x.plan_characteristic_id = ch.id) || v_general);
    END LOOP;
    IF jsonb_array_length(v_requirements) = 0 AND NOT (v_problems @> '[{"code": "operation_not_in_plan"}]') THEN
      v_problems := v_problems || jsonb_build_object('code', 'no_characteristics',
        'message', format('Revision %s of %s has no characteristics%s', v_plan_rev_code, v_plan_code,
          CASE WHEN v_op IS NULL THEN '' ELSE ' at ' || v_op END));
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'status', CASE WHEN jsonb_array_length(v_problems) = 0 THEN 'ok' ELSE 'blocked' END,
    'problems', v_problems,
    'resolvedAt', now(),
    'part', jsonb_build_object('id', v_part.id, 'partNumber', v_part.part_number, 'name', v_part.name),
    'partFamily', CASE WHEN v_family.id IS NULL THEN NULL ELSE jsonb_build_object('id', v_family.id, 'code', v_family.code, 'name', v_family.name) END,
    'partRevision', CASE WHEN v_rev.id IS NULL THEN NULL
      ELSE jsonb_build_object('id', v_rev.id, 'revision', v_rev.revision, 'drawingRef', v_rev.drawing_ref, 'status', v_rev.status) END,
    'operationCode', v_op,
    'siteId', p_site_id,
    'plan', CASE WHEN v_plan_id IS NULL THEN NULL ELSE jsonb_build_object('id', v_plan_id, 'planCode', v_plan_code, 'title', v_plan_title) END,
    'planRevision', CASE WHEN v_plan_rev_id IS NULL THEN NULL ELSE jsonb_build_object('id', v_plan_rev_id, 'revisionCode', v_plan_rev_code) END,
    'candidatePlans', coalesce(v_plans, '[]'::jsonb),
    'requirements', v_requirements);
END $$;

REVOKE ALL ON FUNCTION app.resolve_inspection_requirements(uuid, text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_inspection_requirements(uuid, text, uuid, uuid) TO authenticated;
