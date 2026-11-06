-- Process control PC7: P charts (proportion of failed checks) for pass/fail characteristics.
--
--  * A pass/fail (attribute) control plan characteristic — and a characteristic template — may be marked for SPC
--    with chart type 'p'. The subgroup size is not fixed by the plan (it is whatever was checked), so it stays
--    NULL. Measured characteristics keep I-MR and X-bar/R only; 'p' is only for attribute checks.
--  * spc_baselines accepts chart type 'p': centre = p̄ (all failures / all checks), UCL/LCL stored at the mean
--    subgroup size for reference (the chart recalculates each subgroup's limits from p̄ and its own size),
--    no dispersion limits, and the way subgroups were formed (inspection / day / lot) is recorded.
--    The measurement-id list may be longer (every check of the window): up to 50 000.

-- ---------------------------------------------------------------------------
-- Plan characteristics and templates
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['control_plan_characteristics', 'characteristic_templates'] LOOP
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', t, t || '_chart_type_check');
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (chart_type IN (''imr'', ''xbar_r'', ''p''))', t, t || '_chart_type_check');
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', t, t || '_values');
    EXECUTE format($f$ALTER TABLE public.%1$I ADD CONSTRAINT %2$I CHECK (
      CASE
        WHEN data_type = 'attribute' THEN
          value_source = 'plan' AND unit_code IS NULL AND nominal IS NULL AND lower_limit IS NULL
          AND upper_limit IS NULL AND spec_key IS NULL AND (NOT spc_eligible OR chart_type = 'p')
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
      ELSE chart_type IS NULL AND subgroup_size IS NULL END)$f$, t, t || '_spc');
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Baselines
-- ---------------------------------------------------------------------------
ALTER TABLE public.spc_baselines DROP CONSTRAINT spc_baselines_chart_type_check;
ALTER TABLE public.spc_baselines ADD CONSTRAINT spc_baselines_chart_type_check CHECK (chart_type IN ('imr', 'xbar_r', 'p'));
ALTER TABLE public.spc_baselines DROP CONSTRAINT spc_baselines_subgroup_size_check;
ALTER TABLE public.spc_baselines DROP CONSTRAINT spc_baselines_chart_size;
ALTER TABLE public.spc_baselines DROP CONSTRAINT spc_baselines_measurement_ids_check;
ALTER TABLE public.spc_baselines ALTER COLUMN subgroup_size DROP NOT NULL;
ALTER TABLE public.spc_baselines ALTER COLUMN dispersion_centre DROP NOT NULL;
ALTER TABLE public.spc_baselines ALTER COLUMN dispersion_ucl DROP NOT NULL;
ALTER TABLE public.spc_baselines ALTER COLUMN dispersion_lcl DROP NOT NULL;
ALTER TABLE public.spc_baselines
  ADD COLUMN subgroup_basis text CHECK (subgroup_basis IN ('inspection', 'day', 'lot')),
  ADD COLUMN mean_subgroup_size numeric CHECK (mean_subgroup_size > 0);
ALTER TABLE public.spc_baselines ADD CONSTRAINT spc_baselines_measurement_ids_check CHECK (cardinality(measurement_ids) BETWEEN 5 AND 50000);
ALTER TABLE public.spc_baselines ADD CONSTRAINT spc_baselines_chart_size CHECK (
  (chart_type = 'imr' AND subgroup_size = 1 AND dispersion_centre IS NOT NULL AND subgroup_basis IS NULL)
  OR (chart_type = 'xbar_r' AND subgroup_size BETWEEN 2 AND 10 AND dispersion_centre IS NOT NULL AND subgroup_basis IS NULL)
  OR (chart_type = 'p' AND subgroup_size IS NULL AND subgroup_basis IS NOT NULL AND mean_subgroup_size IS NOT NULL
      AND dispersion_centre IS NULL AND dispersion_ucl IS NULL AND dispersion_lcl IS NULL AND centre BETWEEN 0 AND 1));
