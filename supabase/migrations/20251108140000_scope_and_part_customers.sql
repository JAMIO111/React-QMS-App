-- Process control, slice PC3b (docs/process-control-plan.md §12): scope and master-data refinements.
--  1. Parts can have several customers: part_customers (customer, the customer's own part number,
--     one primary). Existing parts.customer_id links are copied in as primary, then the column is
--     dropped so there is one source of truth (the NC form keeps its own customer, unaffected).
--  2. A control plan's scope can name a single part without a family (standalone plans), and a plan
--     in force for the part itself overrides plans in force for its family (agreed 2026-11-04).
--     Two plans at the same level still block. The resolver reports the level and what it overrides.
--  3. Characteristic part lists accept parts named directly in the plan's scope.

-- ---------------------------------------------------------------------------
-- 1. Part customers
-- ---------------------------------------------------------------------------
CREATE TABLE public.part_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  part_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  -- The customer's own number for this part (what appears on their orders and complaints).
  customer_part_number text CHECK (customer_part_number IS NULL OR customer_part_number ~ '^\S(.{0,58}\S)?$'),
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT part_customers_part_fkey FOREIGN KEY (part_id, organisation_id) REFERENCES public.parts (id, organisation_id) ON DELETE CASCADE,
  CONSTRAINT part_customers_customer_fkey FOREIGN KEY (customer_id, organisation_id) REFERENCES public.customers (id, organisation_id),
  CONSTRAINT part_customers_key UNIQUE (part_id, customer_id)
);
CREATE UNIQUE INDEX part_customers_one_primary ON public.part_customers (part_id) WHERE is_primary;
CREATE INDEX part_customers_customer_idx ON public.part_customers (customer_id);

-- The first customer of a part becomes primary; making another primary moves the flag; removing the
-- primary promotes the oldest remaining one. Neither the part nor the customer of a link changes.
CREATE FUNCTION app.part_customer_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.part_id <> OLD.part_id OR NEW.customer_id <> OLD.customer_id) THEN
    RAISE EXCEPTION 'Remove the customer and add the other one instead' USING ERRCODE = 'QM007';
  END IF;
  IF TG_OP = 'INSERT' AND NOT EXISTS (SELECT 1 FROM public.part_customers WHERE part_id = NEW.part_id AND is_primary) THEN
    NEW.is_primary := true;
  END IF;
  IF NEW.is_primary AND (TG_OP = 'INSERT' OR NOT OLD.is_primary) THEN
    UPDATE public.part_customers SET is_primary = false WHERE part_id = NEW.part_id AND is_primary AND id <> NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION app.part_customer_after_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF OLD.is_primary THEN
    UPDATE public.part_customers SET is_primary = true
    WHERE id = (SELECT id FROM public.part_customers WHERE part_id = OLD.part_id ORDER BY created_at, id LIMIT 1);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER part_customers_rules BEFORE INSERT OR UPDATE ON public.part_customers FOR EACH ROW EXECUTE FUNCTION app.part_customer_rules();
CREATE TRIGGER part_customers_after_delete AFTER DELETE ON public.part_customers FOR EACH ROW EXECUTE FUNCTION app.part_customer_after_delete();
CREATE TRIGGER part_customers_stamp BEFORE INSERT ON public.part_customers FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER part_customers_touch BEFORE UPDATE ON public.part_customers FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER part_customers_org_immutable BEFORE UPDATE ON public.part_customers FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.part_customers
  FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.part_customers ENABLE ROW LEVEL SECURITY;
CREATE POLICY part_customers_select ON public.part_customers FOR SELECT TO authenticated USING (app.is_member(organisation_id));
CREATE POLICY part_customers_insert ON public.part_customers FOR INSERT TO authenticated WITH CHECK (app.has_permission(organisation_id, 'master_data.manage'));
CREATE POLICY part_customers_update ON public.part_customers FOR UPDATE TO authenticated
  USING (app.has_permission(organisation_id, 'master_data.manage')) WITH CHECK (app.has_permission(organisation_id, 'master_data.manage'));
CREATE POLICY part_customers_delete ON public.part_customers FOR DELETE TO authenticated USING (app.has_permission(organisation_id, 'master_data.manage'));
REVOKE ALL ON public.part_customers FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.part_customers TO authenticated;
GRANT UPDATE (customer_part_number, is_primary) ON public.part_customers TO authenticated;
REVOKE ALL ON FUNCTION app.part_customer_rules(), app.part_customer_after_delete() FROM PUBLIC;

INSERT INTO public.part_customers (organisation_id, part_id, customer_id, is_primary, created_at, created_by)
SELECT organisation_id, id, customer_id, true, created_at, created_by FROM public.parts WHERE customer_id IS NOT NULL;
ALTER TABLE public.parts DROP COLUMN customer_id;

-- ---------------------------------------------------------------------------
-- 2. Scope entries for a single part (family optional)
-- ---------------------------------------------------------------------------
ALTER TABLE public.control_plan_applicability ALTER COLUMN part_family_id DROP NOT NULL,
  ADD CONSTRAINT control_plan_applicability_target CHECK (part_family_id IS NOT NULL OR part_id IS NOT NULL);
DROP INDEX public.control_plan_applicability_scope_key;
CREATE UNIQUE INDEX control_plan_applicability_scope_key ON public.control_plan_applicability (
  control_plan_id, coalesce(part_family_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(part_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(site_id, '00000000-0000-0000-0000-000000000000'::uuid), upper(coalesce(operation_code, '')));
GRANT UPDATE (part_family_id) ON public.control_plan_applicability TO authenticated;

-- A part named on its own is stored without a family; a part named with its family must be in it.
CREATE OR REPLACE FUNCTION app.control_plan_applicability_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.control_plan_id <> OLD.control_plan_id THEN
    RAISE EXCEPTION 'Applicability cannot move to another plan' USING ERRCODE = 'QM007';
  END IF;
  NEW.operation_code := nullif(upper(trim(NEW.operation_code)), '');
  IF NEW.part_id IS NOT NULL AND NEW.part_family_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.parts p WHERE p.id = NEW.part_id AND p.part_family_id = NEW.part_family_id) THEN
    RAISE EXCEPTION 'The part is not in the selected part family' USING ERRCODE = 'QM007';
  END IF;
  RETURN NEW;
END $$;

-- Only scope entries that name a part *with* its family tie the part to that family.
CREATE OR REPLACE FUNCTION app.part_family_change_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.part_family_id IS DISTINCT FROM OLD.part_family_id AND EXISTS (
       SELECT 1 FROM public.control_plan_applicability a WHERE a.part_id = NEW.id AND a.part_family_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Part % is named in a control plan''s family scope; remove it there before changing its family', NEW.part_number
      USING ERRCODE = 'QM007';
  END IF;
  RETURN NEW;
END $$;

-- Parts of a conditional characteristic may be in the plan's family scope or named in its scope.
CREATE OR REPLACE FUNCTION app.characteristic_applicability_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_applies text;
BEGIN
  SELECT applies_to INTO v_applies FROM public.control_plan_characteristics WHERE id = NEW.plan_characteristic_id;
  IF v_applies IS DISTINCT FROM 'selected' THEN
    RAISE EXCEPTION 'Parts are only listed for characteristics that apply to selected parts' USING ERRCODE = 'QM007';
  END IF;
  -- Checked for direct edits; a copy into a new revision keeps the previous list as it was.
  IF coalesce(auth.role(), '') = 'authenticated' AND pg_trigger_depth() <= 1 AND NOT EXISTS (
       SELECT 1 FROM public.control_plan_revisions r
       JOIN public.control_plan_applicability a ON a.control_plan_id = r.control_plan_id
       JOIN public.parts p ON p.id = NEW.part_id
       WHERE r.id = NEW.control_plan_revision_id
         AND (a.part_id = p.id OR (a.part_id IS NULL AND p.part_family_id = a.part_family_id))) THEN
    RAISE EXCEPTION 'The part is not in this plan''s scope' USING ERRCODE = 'QM007';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Resolver with plan precedence (part before family)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.resolve_inspection_requirements(
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
  v_level text;
  v_overrides jsonb := '[]'::jsonb;
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

  -- Plans whose scope covers this part — by naming it, or through its family — (and operation / site
  -- when given), with their effective revision. A plan in force for the part itself overrides plans
  -- in force for its family; two at the same level are ambiguous and block.
  SELECT coalesce(jsonb_agg(x ORDER BY x ->> 'planCode'), '[]'::jsonb) INTO v_plans
  FROM (
    SELECT DISTINCT ON (cp.id) jsonb_build_object('id', cp.id, 'planCode', cp.plan_code, 'title', cp.title,
             'revisionId', er.id, 'revisionCode', er.revision_code,
             'level', CASE WHEN a.part_id IS NOT NULL THEN 'part' ELSE 'family' END) AS x
    FROM public.control_plan_applicability a
    JOIN public.control_plans cp ON cp.id = a.control_plan_id AND cp.active
    LEFT JOIN public.control_plan_revisions er ON er.control_plan_id = cp.id AND er.status = 'effective'
    WHERE (a.part_id = p_part_id OR (a.part_id IS NULL AND a.part_family_id = v_family.id))
      AND (a.site_id IS NULL OR p_site_id IS NULL OR a.site_id = p_site_id)
      AND (a.operation_code IS NULL OR v_op IS NULL OR a.operation_code = v_op)
    ORDER BY cp.id, (a.part_id IS NOT NULL) DESC
  ) plans;
  v_level := CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(v_plans) e WHERE e ->> 'revisionId' IS NOT NULL AND e ->> 'level' = 'part')
                  THEN 'part' ELSE 'family' END;
  SELECT count(*) INTO v_plan_count FROM jsonb_array_elements(v_plans) e WHERE e ->> 'revisionId' IS NOT NULL AND e ->> 'level' = v_level;
  IF v_level = 'part' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('id', e ->> 'id', 'planCode', e ->> 'planCode', 'revisionCode', e ->> 'revisionCode')), '[]'::jsonb)
    INTO v_overrides FROM jsonb_array_elements(v_plans) e WHERE e ->> 'revisionId' IS NOT NULL AND e ->> 'level' = 'family';
  END IF;
  IF v_plan_count = 0 THEN
    IF jsonb_array_length(v_plans) = 0 AND v_family.id IS NULL THEN
      v_problems := v_problems || jsonb_build_object('code', 'no_family',
        'message', format('Part %s is not in a part family and no control plan names it', v_part.part_number));
    ELSE
      v_problems := v_problems || jsonb_build_object('code', 'no_effective_plan',
        'message', CASE WHEN jsonb_array_length(v_plans) = 0
          THEN format('No control plan covers %s%s', v_part.part_number, CASE WHEN v_op IS NULL THEN '' ELSE ' at ' || v_op END)
          ELSE format('No effective revision of %s', (SELECT string_agg(e ->> 'planCode', ', ') FROM jsonb_array_elements(v_plans) e)) END);
    END IF;
  ELSIF v_plan_count > 1 THEN
    v_problems := v_problems || jsonb_build_object('code', 'ambiguous_plan',
      'message', format('More than one control plan applies to %s (%s); narrow their scope (site or operation) so only one does',
        CASE WHEN v_level = 'part' THEN v_part.part_number || ' itself' ELSE 'its family' END,
        (SELECT string_agg(e ->> 'planCode', ', ') FROM jsonb_array_elements(v_plans) e WHERE e ->> 'revisionId' IS NOT NULL AND e ->> 'level' = v_level)));
  ELSE
    SELECT (e ->> 'id')::uuid, e ->> 'planCode', e ->> 'title', (e ->> 'revisionId')::uuid, e ->> 'revisionCode'
    INTO v_plan_id, v_plan_code, v_plan_title, v_plan_rev_id, v_plan_rev_code
    FROM jsonb_array_elements(v_plans) e WHERE e ->> 'revisionId' IS NOT NULL AND e ->> 'level' = v_level;
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
    -- "part": the plan names this part; "family": it covers the part's family.
    'scopeLevel', CASE WHEN v_plan_id IS NULL THEN NULL ELSE v_level END,
    -- Family plans in force that the part's own plan replaces.
    'overriddenPlans', v_overrides,
    'candidatePlans', coalesce(v_plans, '[]'::jsonb),
    'requirements', v_requirements);
END $$;

