-- Process control PC8: a "defect count" check type (for C and U charts) and the chart type 'defects'.
--
--  * data_type 'count' on control plan characteristics, characteristic templates and the frozen requirements: how many
--    defects were found on one unit (each inspection sample is one unit). value source plan, no unit, no nominal or
--    lower limit; the optional upper_limit is the most defects allowed on one unit (empty: recorded for charting only,
--    never fails). Marked for SPC it has chart type 'defects' (a C or U chart, picked by the data) and no subgroup size.
--  * inspection_measurements.value_count: a non-negative integer, exactly one of numeric / pass-fail / count per reading.
--    app.inspection_measurement_rules works out the result: pass within the limit (or with no limit), otherwise fail —
--    so an over-limit count goes through the usual acknowledge / NC flow.
--  * spc_baselines accepts chart type 'defects' (centre = defects per unit ū; limits stored at the mean number of units;
--    the subgroup basis recorded, no dispersion limits), like the P chart's baselines.
-- NP charts need no schema: they are another view of the P chart's pass/fail data.

-- ---------------------------------------------------------------------------
-- Plan characteristics, templates, frozen requirements
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['control_plan_characteristics', 'characteristic_templates'] LOOP
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', t, t || '_data_type_check');
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (data_type IN (''variable'', ''attribute'', ''count''))', t, t || '_data_type_check');
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', t, t || '_chart_type_check');
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (chart_type IN (''imr'', ''xbar_r'', ''p'', ''defects''))', t, t || '_chart_type_check');
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', t, t || '_values');
    EXECUTE format($f$ALTER TABLE public.%1$I ADD CONSTRAINT %2$I CHECK (
      CASE
        WHEN data_type = 'attribute' THEN
          value_source = 'plan' AND unit_code IS NULL AND nominal IS NULL AND lower_limit IS NULL
          AND upper_limit IS NULL AND spec_key IS NULL AND (NOT spc_eligible OR chart_type = 'p')
        WHEN data_type = 'count' THEN
          value_source = 'plan' AND unit_code IS NULL AND nominal IS NULL AND lower_limit IS NULL
          AND spec_key IS NULL AND (upper_limit IS NULL OR upper_limit >= 0) AND (NOT spc_eligible OR chart_type = 'defects')
        WHEN value_source = 'plan' THEN
          unit_code IS NOT NULL AND spec_key IS NULL AND (lower_limit IS NOT NULL OR upper_limit IS NOT NULL)
          AND (lower_limit IS NULL OR upper_limit IS NULL OR lower_limit <= upper_limit)
          AND (nominal IS NULL OR ((lower_limit IS NULL OR nominal >= lower_limit) AND (upper_limit IS NULL OR nominal <= upper_limit)))
        ELSE
          unit_code IS NOT NULL AND spec_key IS NOT NULL AND nominal IS NULL AND lower_limit IS NULL AND upper_limit IS NULL
      END)$f$, t, t || '_values');
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', t, t || '_spc');
    EXECUTE format($f$ALTER TABLE public.%1$I ADD CONSTRAINT %2$I CHECK (
      CASE WHEN spc_eligible THEN
        (data_type = 'variable' AND chart_type = 'imr' AND subgroup_size = 1)
        OR (data_type = 'variable' AND chart_type = 'xbar_r' AND subgroup_size BETWEEN 2 AND 10)
        OR (data_type = 'attribute' AND chart_type = 'p' AND subgroup_size IS NULL)
        OR (data_type = 'count' AND chart_type = 'defects' AND subgroup_size IS NULL)
      ELSE chart_type IS NULL AND subgroup_size IS NULL END)$f$, t, t || '_spc');
  END LOOP;
END $$;

ALTER TABLE public.resolved_inspection_requirements DROP CONSTRAINT resolved_inspection_requirements_data_type_check;
ALTER TABLE public.resolved_inspection_requirements ADD CONSTRAINT resolved_inspection_requirements_data_type_check
  CHECK (data_type IN ('variable', 'attribute', 'count'));

-- ---------------------------------------------------------------------------
-- Readings
-- ---------------------------------------------------------------------------
ALTER TABLE public.inspection_measurements ADD COLUMN value_count integer CHECK (value_count >= 0);
ALTER TABLE public.inspection_measurements DROP CONSTRAINT inspection_measurements_one_value;
ALTER TABLE public.inspection_measurements ADD CONSTRAINT inspection_measurements_one_value
  CHECK ((value_numeric IS NOT NULL)::integer + (value_pass IS NOT NULL)::integer + (value_count IS NOT NULL)::integer = 1);

-- Reading rules: a count's result is worked out from the optional limit.
CREATE OR REPLACE FUNCTION app.inspection_measurement_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  q record;
  g record;
  prev record;
  v_site uuid := app.inspection_site(NEW.inspection_record_id);
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'A recorded reading cannot be changed; record a correction instead' USING ERRCODE = 'QM008';
  END IF;
  SELECT * INTO q FROM public.resolved_inspection_requirements WHERE id = NEW.requirement_id;
  IF NOT q.applicable THEN
    RAISE EXCEPTION '% does not apply to this part (%)', q.name, q.applicability USING ERRCODE = 'QM008';
  END IF;

  IF NEW.supersedes_id IS NULL THEN
    PERFORM app.assert_inspection_open(NEW.inspection_record_id);
    IF EXISTS (SELECT 1 FROM public.inspection_measurements WHERE sample_id = NEW.sample_id AND requirement_id = NEW.requirement_id) THEN
      RAISE EXCEPTION '% already has a reading in this sample; record a correction instead', q.name USING ERRCODE = 'QM008';
    END IF;
  ELSE
    SELECT * INTO prev FROM public.inspection_measurements WHERE id = NEW.supersedes_id;
    IF prev.requirement_id <> NEW.requirement_id OR prev.sample_id <> NEW.sample_id THEN
      RAISE EXCEPTION 'A correction replaces a reading of the same check in the same sample' USING ERRCODE = 'QM008';
    END IF;
    IF coalesce(auth.role(), '') = 'authenticated' AND NOT app.has_permission(NEW.organisation_id, 'inspection.correct', v_site) THEN
      RAISE EXCEPTION 'You may not correct recorded readings' USING ERRCODE = '42501';
    END IF;
    IF (SELECT status FROM public.inspection_records WHERE id = NEW.inspection_record_id) = 'abandoned' THEN
      RAISE EXCEPTION 'An abandoned inspection cannot be corrected' USING ERRCODE = 'QM008';
    END IF;
  END IF;

  IF NEW.retest_of_id IS NOT NULL THEN
    SELECT * INTO prev FROM public.inspection_measurements WHERE id = NEW.retest_of_id;
    IF prev.requirement_id <> NEW.requirement_id OR prev.result <> 'fail' THEN
      RAISE EXCEPTION 'A retest follows a failed reading of the same check' USING ERRCODE = 'QM008';
    END IF;
  END IF;

  IF q.data_type = 'variable' THEN
    IF NEW.value_numeric IS NULL OR NEW.value_pass IS NOT NULL OR NEW.value_count IS NOT NULL THEN
      RAISE EXCEPTION '% needs a measured value', q.name USING ERRCODE = 'QM008';
    END IF;
    NEW.unit_code := coalesce(NEW.unit_code, q.unit_code);
    IF NEW.unit_code IS DISTINCT FROM q.unit_code THEN
      RAISE EXCEPTION '% is measured in %, not %', q.name, q.unit_code, NEW.unit_code USING ERRCODE = 'QM008';
    END IF;
    NEW.result := CASE WHEN (q.lower_limit IS NULL OR NEW.value_numeric >= q.lower_limit)
                        AND (q.upper_limit IS NULL OR NEW.value_numeric <= q.upper_limit) THEN 'pass' ELSE 'fail' END;
  ELSIF q.data_type = 'count' THEN
    -- Defects found on the unit (each sample is one unit); the optional upper limit is the most allowed.
    IF NEW.value_count IS NULL OR NEW.value_numeric IS NOT NULL OR NEW.value_pass IS NOT NULL THEN
      RAISE EXCEPTION '% needs a count of defects (0 or more)', q.name USING ERRCODE = 'QM008';
    END IF;
    NEW.unit_code := NULL;
    NEW.result := CASE WHEN q.upper_limit IS NULL OR NEW.value_count <= q.upper_limit THEN 'pass' ELSE 'fail' END;
  ELSE
    IF NEW.value_pass IS NULL OR NEW.value_numeric IS NOT NULL OR NEW.value_count IS NOT NULL THEN
      RAISE EXCEPTION '% needs pass or fail', q.name USING ERRCODE = 'QM008';
    END IF;
    NEW.unit_code := NULL;
    NEW.result := CASE WHEN NEW.value_pass THEN 'pass' ELSE 'fail' END;
  END IF;

  -- Gauge at the time of use.
  NEW.gauge_asset_number := NULL; NEW.gauge_status := NULL; NEW.gauge_next_due_on := NULL; NEW.gauge_valid := NULL;
  IF NEW.gauge_id IS NOT NULL THEN
    SELECT asset_number, status, next_due_on, gauge_type_id, deleted_at INTO g FROM public.gauges WHERE id = NEW.gauge_id;
    NEW.gauge_asset_number := g.asset_number;
    NEW.gauge_status := g.status;
    NEW.gauge_next_due_on := g.next_due_on;
    -- coalesce: a gauge without a type is not "the required type" (NULL must not count as valid).
    NEW.gauge_valid := coalesce(g.deleted_at IS NULL AND g.status = 'active' AND (g.next_due_on IS NULL OR g.next_due_on >= current_date)
                       AND (q.gauge_type_id IS NULL OR g.gauge_type_id = q.gauge_type_id), false);
  ELSIF q.gauge_type_id IS NOT NULL AND q.data_type = 'variable' THEN
    RAISE EXCEPTION '% must be measured with a % gauge; choose the gauge used', q.name, q.gauge_type_name USING ERRCODE = 'QM008';
  END IF;
  IF NEW.gauge_valid = false THEN
    IF coalesce(trim(NEW.gauge_override_reason), '') = '' THEN
      RAISE EXCEPTION 'Gauge % is %; it cannot be used without an authorised override and a reason', g.asset_number,
        CASE WHEN g.deleted_at IS NOT NULL THEN 'deleted'
             WHEN g.status <> 'active' THEN replace(g.status, '_', ' ')
             WHEN g.next_due_on < current_date THEN 'overdue for calibration (due ' || to_char(g.next_due_on, 'DD Mon YYYY') || ')'
             ELSE 'not the required type (' || q.gauge_type_name || ')' END
        USING ERRCODE = 'QM008';
    END IF;
    IF coalesce(auth.role(), '') = 'authenticated' AND NOT app.has_permission(NEW.organisation_id, 'inspection.override_gauge', v_site) THEN
      RAISE EXCEPTION 'You may not override gauge checks; ask a supervisor' USING ERRCODE = '42501';
    END IF;
  ELSE
    NEW.gauge_override_reason := NULL;
  END IF;
  NEW.measured_at := now();
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- Baselines
-- ---------------------------------------------------------------------------
ALTER TABLE public.spc_baselines DROP CONSTRAINT spc_baselines_chart_type_check;
ALTER TABLE public.spc_baselines ADD CONSTRAINT spc_baselines_chart_type_check CHECK (chart_type IN ('imr', 'xbar_r', 'p', 'defects'));
ALTER TABLE public.spc_baselines DROP CONSTRAINT spc_baselines_chart_size;
ALTER TABLE public.spc_baselines ADD CONSTRAINT spc_baselines_chart_size CHECK (
  (chart_type = 'imr' AND subgroup_size = 1 AND dispersion_centre IS NOT NULL AND subgroup_basis IS NULL)
  OR (chart_type = 'xbar_r' AND subgroup_size BETWEEN 2 AND 10 AND dispersion_centre IS NOT NULL AND subgroup_basis IS NULL)
  OR (chart_type = 'p' AND subgroup_size IS NULL AND subgroup_basis IS NOT NULL AND mean_subgroup_size IS NOT NULL
      AND dispersion_centre IS NULL AND dispersion_ucl IS NULL AND dispersion_lcl IS NULL AND centre BETWEEN 0 AND 1)
  OR (chart_type = 'defects' AND subgroup_size IS NULL AND subgroup_basis IS NOT NULL AND mean_subgroup_size IS NOT NULL
      AND dispersion_centre IS NULL AND dispersion_ucl IS NULL AND dispersion_lcl IS NULL AND centre >= 0));
