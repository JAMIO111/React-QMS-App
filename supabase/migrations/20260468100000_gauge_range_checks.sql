-- Gauge type checks placed across the gauge's own range, with tolerances worked out four ways (docs/gauge-range-checks-plan.md, slice RC1).
--
--   * A type's check may place its point at X % of the gauge's range (nominal_basis = 'span_percent'): each gauge gets its own real nominal from its
--     range_min / range_max, in the gauge's own unit: nominal = range_min + (percent / 100) * (range_max - range_min).
--   * A type's check may work its tolerance out as a fixed value (as before), a percentage of the span, a percentage of the reading (the nominal), or a fixed
--     value plus a percentage of the reading. Every basis but the fixed value is symmetric.
--   * The gauge's own copy stores ORDINARY values (nominal, tolerances, unit) so every reading, report and import works unchanged, plus a plain-words
--     derivation, the source note, and whether it still follows the range. A recorded reading keeps the derivation and source with its limits.
--   * All the arithmetic is app.resolve_type_check, used by the copy on insert, "apply the checks to existing gauges", the recalculation and the preview.
--
-- Nothing changes for existing types and gauges: every existing check is a fixed point with a fixed tolerance (the new columns default to that).
-- The API must not be pushed before this migration: it will read the new columns (RC2).

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.gauge_type_characteristics
  ADD COLUMN nominal_basis text NOT NULL DEFAULT 'value' CHECK (nominal_basis IN ('value', 'span_percent')),
  ADD COLUMN tolerance_basis text NOT NULL DEFAULT 'value'
    CHECK (tolerance_basis IN ('value', 'span_percent', 'reading_percent', 'value_plus_reading_percent')),
  ADD COLUMN tolerance_reading_percent numeric,
  ADD COLUMN tolerance_source text CHECK (tolerance_source IS NULL OR length(tolerance_source) <= 200);

ALTER TABLE public.gauge_type_characteristics DROP CONSTRAINT gauge_type_characteristics_kind_fields;
ALTER TABLE public.gauge_type_characteristics ADD CONSTRAINT gauge_type_characteristics_kind_fields CHECK (
  (kind = 'variable'
    AND nominal IS NOT NULL AND tolerance_minus IS NOT NULL AND tolerance_plus IS NOT NULL
    -- the point: a value with its own unit, or a percentage (0 to 100, up to three decimals) of the gauge's range in the gauge's unit
    AND ((nominal_basis = 'value' AND unit_code IS NOT NULL)
      OR (nominal_basis = 'span_percent' AND unit_code IS NULL AND nominal BETWEEN 0 AND 100 AND round(nominal, 3) = nominal))
    -- the tolerance: absolute (the two sides may differ), or one symmetric percentage, or a fixed part with a percentage of the reading
    AND ((tolerance_basis = 'value' AND tolerance_reading_percent IS NULL)
      OR (tolerance_basis IN ('span_percent', 'reading_percent') AND tolerance_reading_percent IS NULL
          AND tolerance_minus = tolerance_plus AND tolerance_minus > 0 AND tolerance_minus <= 100)
      OR (tolerance_basis = 'value_plus_reading_percent' AND tolerance_minus = tolerance_plus
          AND tolerance_reading_percent IS NOT NULL AND tolerance_reading_percent > 0 AND tolerance_reading_percent <= 100)))
  OR (kind = 'attribute' AND nominal IS NULL AND tolerance_minus IS NULL AND tolerance_plus IS NULL AND unit_code IS NULL
      AND nominal_basis = 'value' AND tolerance_basis = 'value' AND tolerance_reading_percent IS NULL));

ALTER TABLE public.gauge_characteristics
  ADD COLUMN follows_range boolean NOT NULL DEFAULT false,
  ADD COLUMN derivation text CHECK (derivation IS NULL OR length(derivation) <= 300),
  ADD COLUMN tolerance_source text CHECK (tolerance_source IS NULL OR length(tolerance_source) <= 200),
  ADD CONSTRAINT gauge_characteristics_follows_derived CHECK (NOT follows_range OR derivation IS NOT NULL);

ALTER TABLE public.calibration_readings
  ADD COLUMN derivation text,
  ADD COLUMN tolerance_source text;

COMMENT ON COLUMN public.gauge_type_characteristics.nominal IS 'The point: a value, or a percentage of the gauge''s range when nominal_basis is span_percent';
COMMENT ON COLUMN public.gauge_characteristics.follows_range IS 'Worked out from the type''s range-based check and not edited by hand since; Recalculate refreshes it from the gauge''s range';

-- What people may change: the template's basis and source, and the source of a gauge's own check. Following, derivation and the
-- readings' copies are written only by the functions below.
GRANT UPDATE (nominal_basis, tolerance_basis, tolerance_reading_percent, tolerance_source) ON public.gauge_type_characteristics TO authenticated;
GRANT UPDATE (tolerance_source) ON public.gauge_characteristics TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. The arithmetic, in one place
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.gauge_has_range(p_min numeric, p_max numeric, p_unit text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p_min IS NOT NULL AND p_max IS NOT NULL AND p_max > p_min AND p_unit IS NOT NULL
$$;

-- Does any active check of this type depend on the gauge's range (its point or its tolerance is a percentage of the span)?
CREATE FUNCTION app.gauge_type_needs_range(p_type uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.gauge_type_characteristics k
                 WHERE k.gauge_type_id = p_type AND k.active AND k.kind = 'variable'
                   AND (k.nominal_basis = 'span_percent' OR k.tolerance_basis = 'span_percent'))
$$;

-- One template check worked out for one gauge's range: { kind, nominal, toleranceMinus, tolerancePlus, unit, derivation, followsRange,
-- toleranceSource, problem }. A problem leaves the numbers out. Internal: the callers below check who may ask.
CREATE FUNCTION app.resolve_type_check(p_template uuid, p_range_min numeric, p_range_max numeric, p_unit text, p_resolution numeric)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  t record;
  v_has_range boolean := app.gauge_has_range(p_range_min, p_range_max, p_unit);
  v_span numeric;
  v_nominal numeric;
  v_unit text;
  v_minus numeric;
  v_plus numeric;
  v_follows boolean;
  v_parts text[] := '{}';
  v_derivation text;
BEGIN
  SELECT * INTO t FROM public.gauge_type_characteristics WHERE id = p_template;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Check not found' USING ERRCODE = 'P0002';
  END IF;
  IF t.kind = 'attribute' THEN
    RETURN jsonb_build_object('kind', 'attribute', 'followsRange', false, 'problem', NULL);
  END IF;
  v_follows := t.nominal_basis = 'span_percent' OR t.tolerance_basis = 'span_percent';
  IF v_follows AND NOT v_has_range THEN
    RETURN jsonb_build_object('kind', 'variable', 'followsRange', true,
      'problem', format('"%s" is placed across the gauge''s range: enter the range (smallest below largest) and the unit', t.name));
  END IF;
  IF t.nominal_basis = 'value' AND t.tolerance_basis = 'span_percent' AND t.unit_code IS DISTINCT FROM p_unit THEN
    RETURN jsonb_build_object('kind', 'variable', 'followsRange', true,
      'problem', format('"%s" is in %s but the gauge''s unit is %s: the span has to be in the same unit as the check', t.name, t.unit_code, p_unit));
  END IF;
  IF v_has_range THEN
    v_span := p_range_max - p_range_min;
  END IF;

  IF t.nominal_basis = 'span_percent' THEN
    v_nominal := p_range_min + t.nominal / 100 * v_span;
    -- a point the gauge can actually show: to its resolution when it has one, else four decimals
    IF p_resolution IS NOT NULL AND p_resolution > 0 THEN
      v_nominal := trim_scale(round(v_nominal / p_resolution) * p_resolution);
    ELSE
      v_nominal := round(v_nominal, 4);
    END IF;
    v_unit := p_unit;
    v_parts := v_parts || (trim_scale(t.nominal)::text || ' % of range');
  ELSE
    v_nominal := t.nominal;
    v_unit := t.unit_code;
  END IF;

  CASE t.tolerance_basis
    WHEN 'value' THEN
      v_minus := t.tolerance_minus; v_plus := t.tolerance_plus;
    WHEN 'span_percent' THEN
      v_minus := t.tolerance_minus / 100 * v_span; v_plus := v_minus;
      v_parts := v_parts || ('±' || trim_scale(t.tolerance_minus)::text || ' % of span');
    WHEN 'reading_percent' THEN
      v_minus := abs(v_nominal) * t.tolerance_minus / 100; v_plus := v_minus;
      v_parts := v_parts || ('±' || trim_scale(t.tolerance_minus)::text || ' % of reading');
    ELSE
      v_minus := t.tolerance_minus + abs(v_nominal) * t.tolerance_reading_percent / 100; v_plus := v_minus;
      v_parts := v_parts || ('±(' || trim_scale(t.tolerance_minus)::text || ' ' || coalesce(v_unit, '') || ' + '
                             || trim_scale(t.tolerance_reading_percent)::text || ' % of reading)');
  END CASE;
  -- A fixed tolerance is copied exactly as typed; a worked-out one is stored to six decimal places.
  IF t.tolerance_basis <> 'value' THEN
    v_minus := round(v_minus, 6);
    v_plus := round(v_plus, 6);
  END IF;

  IF t.tolerance_basis <> 'value' AND v_minus <= 0 THEN
    RETURN jsonb_build_object('kind', 'variable', 'followsRange', v_follows,
      'problem', format('The tolerance of "%s" works out to nothing at %s %s: use a fixed value plus a percentage of the reading, or a different point',
                        t.name, trim_scale(v_nominal), coalesce(v_unit, '')));
  END IF;

  IF cardinality(v_parts) > 0 THEN
    v_derivation := array_to_string(v_parts, '; ');
  END IF;
  RETURN jsonb_build_object('kind', 'variable', 'nominal', v_nominal, 'toleranceMinus', v_minus, 'tolerancePlus', v_plus, 'unit', v_unit,
                            'derivation', v_derivation, 'followsRange', v_follows, 'toleranceSource', t.tolerance_source, 'problem', NULL);
END $$;

-- ---------------------------------------------------------------------------
-- 3. Copying a type's checks onto a gauge (new gauge, or "apply the checks to the gauges that lack them")
-- ---------------------------------------------------------------------------
-- p_only_missing: only checks the gauge has no copy of yet. p_strict: a check that cannot be worked out refuses the whole copy (a new gauge);
-- otherwise it is skipped and reported. Internal: the callers decide who may ask.
CREATE FUNCTION app.copy_type_checks_to_gauge(p_gauge uuid, p_only_missing boolean, p_strict boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  g record;
  t record;
  r jsonb;
  v_added integer := 0;
  n integer;
  v_problems jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO g FROM public.gauges WHERE id = p_gauge;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Gauge not found' USING ERRCODE = 'P0002';
  END IF;
  IF g.gauge_type_id IS NULL THEN
    RETURN jsonb_build_object('added', 0, 'problems', v_problems);
  END IF;
  PERFORM set_config('app.gauge_check_copy', 'on', true);
  FOR t IN
    SELECT k.* FROM public.gauge_type_characteristics k
    WHERE k.gauge_type_id = g.gauge_type_id AND k.active
      AND (NOT p_only_missing OR NOT EXISTS (SELECT 1 FROM public.gauge_characteristics c WHERE c.gauge_id = g.id AND c.template_id = k.id))
    ORDER BY k.sort_order, k.created_at, k.id
  LOOP
    r := app.resolve_type_check(t.id, g.range_min, g.range_max, g.unit_code, g.resolution);
    IF r ->> 'problem' IS NOT NULL THEN
      IF p_strict THEN
        RAISE EXCEPTION '%', r ->> 'problem' USING ERRCODE = 'QM006';
      END IF;
      v_problems := v_problems || jsonb_build_object('checkId', t.id, 'name', t.name, 'problem', r ->> 'problem');
      CONTINUE;
    END IF;
    INSERT INTO public.gauge_characteristics (organisation_id, gauge_id, template_id, sort_order, kind, name, nominal, tolerance_minus, tolerance_plus,
                                              unit_code, method, follows_range, derivation, tolerance_source)
    VALUES (g.organisation_id, g.id, t.id, t.sort_order, t.kind, t.name, (r ->> 'nominal')::numeric, (r ->> 'toleranceMinus')::numeric,
            (r ->> 'tolerancePlus')::numeric, r ->> 'unit', t.method, (r ->> 'followsRange')::boolean, r ->> 'derivation', r ->> 'toleranceSource')
    ON CONFLICT (gauge_id, template_id) WHERE template_id IS NOT NULL DO NOTHING;
    GET DIAGNOSTICS n = ROW_COUNT;
    v_added := v_added + n;
  END LOOP;
  PERFORM set_config('app.gauge_check_copy', '', true);
  RETURN jsonb_build_object('added', v_added, 'problems', v_problems);
END $$;

-- A new gauge of a type gets copies of the type's active checks, worked out for its own range.
CREATE OR REPLACE FUNCTION app.gauge_copy_characteristics() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.gauge_type_id IS NOT NULL THEN
    PERFORM app.copy_type_checks_to_gauge(NEW.id, false, true);
  END IF;
  RETURN NULL;
END $$;

-- "Apply the checks to the gauges that lack them": every gauge of the type that takes checks and has no copy of an active check gets it, worked out for
-- its own range. Runs as the person: only gauges at sites where they manage calibration are touched, the others are counted as skipped; a gauge that
-- cannot be given a check (no range, a tolerance that works out to nothing) is reported and left as it is.
CREATE FUNCTION app.apply_type_checks(p_type uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_org uuid;
  g record;
  r jsonb;
  v_updated integer := 0;
  v_added integer := 0;
  v_skipped integer := 0;
  v_with_problems integer := 0;
  v_problems jsonb := '[]'::jsonb;
  p jsonb;
BEGIN
  SELECT organisation_id INTO v_org FROM public.gauge_types WHERE id = p_type;
  IF v_org IS NULL OR NOT app.is_member(v_org) THEN
    RAISE EXCEPTION 'Gauge type not found' USING ERRCODE = 'P0002';
  END IF;
  FOR g IN
    SELECT x.id, x.asset_number, x.site_id, x.organisation_id FROM public.gauges x
    WHERE x.gauge_type_id = p_type AND x.deleted_at IS NULL AND x.status NOT IN ('retired', 'lost')
      AND EXISTS (SELECT 1 FROM public.gauge_type_characteristics k WHERE k.gauge_type_id = p_type AND k.active
                  AND NOT EXISTS (SELECT 1 FROM public.gauge_characteristics c WHERE c.gauge_id = x.id AND c.template_id = k.id))
    ORDER BY x.asset_number, x.id
  LOOP
    IF NOT app.has_permission(g.organisation_id, 'calibration.manage', g.site_id) THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;
    r := app.copy_type_checks_to_gauge(g.id, true, false);
    IF (r ->> 'added')::integer > 0 THEN
      v_updated := v_updated + 1;
      v_added := v_added + (r ->> 'added')::integer;
    END IF;
    IF jsonb_array_length(r -> 'problems') > 0 THEN
      v_with_problems := v_with_problems + 1;
      FOR p IN SELECT * FROM jsonb_array_elements(r -> 'problems') LOOP
        IF jsonb_array_length(v_problems) < 20 THEN
          v_problems := v_problems || (p || jsonb_build_object('gaugeId', g.id, 'assetNumber', g.asset_number));
        END IF;
      END LOOP;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('gaugesUpdated', v_updated, 'checksAdded', v_added, 'gaugesSkipped', v_skipped,
                            'gaugesWithProblems', v_with_problems, 'problems', v_problems);
END $$;

-- ---------------------------------------------------------------------------
-- 4. Range changed later: recalculate on request, and say which checks are out of date
-- ---------------------------------------------------------------------------
-- Uses the type's CURRENT check definition and the gauge's CURRENT range; only copies that still follow the range; past readings keep their limits.
CREATE FUNCTION app.recalculate_gauge_range_checks(p_gauge uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  g record;
  c record;
  r jsonb;
  v_updated integer := 0;
  v_unchanged integer := 0;
  v_problems jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO g FROM public.gauges WHERE id = p_gauge;
  IF NOT FOUND OR NOT app.is_member(g.organisation_id) THEN
    RAISE EXCEPTION 'Gauge not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT app.has_permission(g.organisation_id, 'calibration.manage', g.site_id) THEN
    RAISE EXCEPTION 'You may not change this gauge''s checks' USING ERRCODE = '42501';
  END IF;
  PERFORM app.assert_gauge_editable(p_gauge);
  PERFORM set_config('app.gauge_check_copy', 'on', true);
  FOR c IN
    SELECT k.* FROM public.gauge_characteristics k
    WHERE k.gauge_id = p_gauge AND k.follows_range AND k.template_id IS NOT NULL
    ORDER BY k.sort_order, k.id
  LOOP
    r := app.resolve_type_check(c.template_id, g.range_min, g.range_max, g.unit_code, g.resolution);
    IF r ->> 'problem' IS NOT NULL THEN
      v_problems := v_problems || jsonb_build_object('checkId', c.id, 'name', c.name, 'problem', r ->> 'problem');
    ELSIF (c.nominal, c.tolerance_minus, c.tolerance_plus, c.unit_code, c.derivation, c.tolerance_source)
          IS DISTINCT FROM ((r ->> 'nominal')::numeric, (r ->> 'toleranceMinus')::numeric, (r ->> 'tolerancePlus')::numeric, r ->> 'unit',
                            r ->> 'derivation', r ->> 'toleranceSource') THEN
      UPDATE public.gauge_characteristics
      SET nominal = (r ->> 'nominal')::numeric, tolerance_minus = (r ->> 'toleranceMinus')::numeric, tolerance_plus = (r ->> 'tolerancePlus')::numeric,
          unit_code = r ->> 'unit', derivation = r ->> 'derivation', tolerance_source = r ->> 'toleranceSource'
      WHERE id = c.id;
      v_updated := v_updated + 1;
    ELSE
      v_unchanged := v_unchanged + 1;
    END IF;
  END LOOP;
  PERFORM set_config('app.gauge_check_copy', '', true);
  RETURN jsonb_build_object('updated', v_updated, 'unchanged', v_unchanged, 'problems', v_problems);
END $$;

-- For each range-based copy on a gauge: would the gauge's range now give different values (stale), or can it not be worked out (problem)?
CREATE FUNCTION app.gauge_range_check_state(p_gauge uuid)
RETURNS TABLE (characteristic_id uuid, stale boolean, problem text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE g record;
BEGIN
  SELECT * INTO g FROM public.gauges WHERE id = p_gauge;
  IF NOT FOUND OR NOT app.has_permission(g.organisation_id, 'calibration.read', g.site_id) THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT k.id,
         CASE WHEN x.j ->> 'problem' IS NOT NULL THEN false
              ELSE (k.nominal, k.tolerance_minus, k.tolerance_plus, k.unit_code)
                   IS DISTINCT FROM ((x.j ->> 'nominal')::numeric, (x.j ->> 'toleranceMinus')::numeric, (x.j ->> 'tolerancePlus')::numeric, x.j ->> 'unit')
         END,
         x.j ->> 'problem'
  FROM public.gauge_characteristics k
  CROSS JOIN LATERAL (SELECT app.resolve_type_check(k.template_id, g.range_min, g.range_max, g.unit_code, g.resolution) AS j) x
  WHERE k.gauge_id = p_gauge AND k.follows_range AND k.template_id IS NOT NULL
  ORDER BY k.sort_order, k.id;
END $$;

-- What a type's active checks would become for a gauge with this range (nothing is saved). Anyone who may read gauge types.
CREATE FUNCTION app.preview_type_checks(p_type uuid, p_range_min numeric, p_range_max numeric, p_unit text, p_resolution numeric) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid;
BEGIN
  SELECT organisation_id INTO v_org FROM public.gauge_types WHERE id = p_type;
  IF v_org IS NULL OR NOT app.is_member(v_org) THEN
    RAISE EXCEPTION 'Gauge type not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT app.has_permission(v_org, 'calibration.read') THEN
    RAISE EXCEPTION 'You may not read gauge types' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'needsRange', app.gauge_type_needs_range(p_type),
    'hasRange', app.gauge_has_range(p_range_min, p_range_max, p_unit),
    'checks', coalesce((
      SELECT jsonb_agg(app.resolve_type_check(k.id, p_range_min, p_range_max, p_unit, p_resolution)
                       || jsonb_build_object('checkId', k.id, 'name', k.name, 'method', k.method, 'sortOrder', k.sort_order)
                       ORDER BY k.sort_order, k.created_at, k.id)
      FROM public.gauge_type_characteristics k WHERE k.gauge_type_id = p_type AND k.active), '[]'::jsonb));
END $$;

-- ---------------------------------------------------------------------------
-- 5. Rules for the gauge's own checks, and the readings' copies
-- ---------------------------------------------------------------------------
-- Following and the derivation are written only by the copy and recalculation above (they set app.gauge_check_copy for their statements).
-- Editing what a following check says by hand makes it an ordinary fixed check on that gauge.
CREATE OR REPLACE FUNCTION app.gauge_characteristic_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.gauge_id <> OLD.gauge_id THEN
    RAISE EXCEPTION 'A characteristic cannot move to another gauge' USING ERRCODE = 'QM006';
  END IF;
  IF coalesce(auth.role(), '') = 'authenticated' THEN
    PERFORM app.assert_gauge_editable(NEW.gauge_id);
  END IF;
  IF coalesce(current_setting('app.gauge_check_copy', true), '') <> 'on' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.follows_range := false;
      NEW.derivation := NULL;
    ELSIF (NEW.nominal, NEW.tolerance_minus, NEW.tolerance_plus, NEW.unit_code) IS DISTINCT FROM (OLD.nominal, OLD.tolerance_minus, OLD.tolerance_plus, OLD.unit_code) THEN
      NEW.follows_range := false;
      NEW.derivation := NULL;
    ELSE
      NEW.follows_range := OLD.follows_range;
      NEW.derivation := OLD.derivation;
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- A reading keeps where its limits came from, with the limits (copied from its characteristic when it is recorded, never changed).
CREATE FUNCTION app.calibration_reading_basis() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.derivation := NULL;
    NEW.tolerance_source := NULL;
    IF NEW.characteristic_id IS NOT NULL THEN
      SELECT k.derivation, k.tolerance_source INTO NEW.derivation, NEW.tolerance_source
      FROM public.gauge_characteristics k WHERE k.id = NEW.characteristic_id;
    END IF;
  ELSIF NEW.derivation IS DISTINCT FROM OLD.derivation OR NEW.tolerance_source IS DISTINCT FROM OLD.tolerance_source THEN
    RAISE EXCEPTION 'The limits of a reading come from its characteristic' USING ERRCODE = 'QM006';
  END IF;
  RETURN NEW;
END $$;
-- Named to fire after calibration_readings_rules (triggers run in name order).
CREATE TRIGGER calibration_readings_zbasis BEFORE INSERT OR UPDATE ON public.calibration_readings
  FOR EACH ROW EXECUTE FUNCTION app.calibration_reading_basis();

-- A gauge of a type whose checks depend on the range needs its range and unit (when it is made, and when it is retyped). Replaces the version of
-- 20260467100000, with this one rule added; everything else is as it was.
CREATE OR REPLACE FUNCTION app.gauge_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  t record;
  m record;
  v_follows boolean := coalesce(current_setting('app.gauge_follows_calibration', true), '') = 'on';
BEGIN
  -- The machine a gauge is fixed to: at the gauge's site when both have one; a gauge with no site takes the machine's.
  IF NEW.machine_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.machine_id IS DISTINCT FROM OLD.machine_id OR NEW.site_id IS DISTINCT FROM OLD.site_id) THEN
    SELECT site_id INTO m FROM public.machines WHERE id = NEW.machine_id;
    IF m.site_id IS NOT NULL THEN
      IF NEW.site_id IS NULL THEN
        NEW.site_id := m.site_id;
      ELSIF NEW.site_id <> m.site_id THEN
        RAISE EXCEPTION 'The machine is not at the selected site' USING ERRCODE = 'QM006';
      END IF;
    END IF;
  END IF;
  IF NEW.department_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.department_id IS DISTINCT FROM OLD.department_id OR NEW.site_id IS DISTINCT FROM OLD.site_id)
     AND NOT EXISTS (SELECT 1 FROM public.departments d WHERE d.id = NEW.department_id AND d.site_id IS NOT DISTINCT FROM NEW.site_id) THEN
    RAISE EXCEPTION 'The department is not at the selected site' USING ERRCODE = 'QM006';
  END IF;
  IF NEW.interval_value IS NULL THEN
    SELECT interval_value, interval_unit INTO t FROM public.gauge_types WHERE id = NEW.gauge_type_id;
    NEW.interval_value := coalesce(t.interval_value, 12);
    NEW.interval_unit := coalesce(t.interval_unit, 'months');
  END IF;

  IF coalesce(auth.role(), '') <> 'authenticated' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.gauge_type_id IS NULL THEN
      RAISE EXCEPTION 'Choose a gauge type' USING ERRCODE = 'QM006';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.gauge_types y WHERE y.id = NEW.gauge_type_id AND y.active) THEN
      RAISE EXCEPTION 'That gauge type is switched off' USING ERRCODE = 'QM006';
    END IF;
    IF app.gauge_type_needs_range(NEW.gauge_type_id) AND NOT app.gauge_has_range(NEW.range_min, NEW.range_max, NEW.unit_code) THEN
      RAISE EXCEPTION 'This type places its checks across the gauge''s range: enter the range (smallest below largest) and the unit' USING ERRCODE = 'QM006';
    END IF;
    IF NEW.machine_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.machines x WHERE x.id = NEW.machine_id AND x.active) THEN
      RAISE EXCEPTION 'That machine is switched off' USING ERRCODE = 'QM006';
    END IF;
    NEW.deleted_at := NULL; NEW.deleted_by := NULL; NEW.delete_reason := NULL;
    NEW.status_changed_at := now();
    RETURN NEW;
  END IF;

  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    NEW.deleted_at := app.soft_delete_stamp(NEW.deleted_at, OLD.deleted_at, NEW.delete_reason, 'gauge');
    IF NEW.deleted_at IS NULL THEN
      NEW.deleted_by := NULL;
      NEW.delete_reason := NULL;
    ELSE
      NEW.deleted_by := auth.uid();
    END IF;
    IF (to_jsonb(NEW) - ARRAY['deleted_at', 'deleted_by', 'delete_reason', 'updated_at', 'updated_by'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['deleted_at', 'deleted_by', 'delete_reason', 'updated_at', 'updated_by']) THEN
      RAISE EXCEPTION 'Delete or restore on its own, without other changes' USING ERRCODE = 'QM006';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'This gauge is deleted; restore it first' USING ERRCODE = 'QM006';
  END IF;
  IF NEW.delete_reason IS DISTINCT FROM OLD.delete_reason OR NEW.deleted_by IS DISTINCT FROM OLD.deleted_by THEN
    RAISE EXCEPTION 'Deletion details are set by the system' USING ERRCODE = 'QM006';
  END IF;

  IF OLD.gauge_type_id IS NOT NULL AND NEW.gauge_type_id IS NULL THEN
    RAISE EXCEPTION 'A gauge needs a gauge type' USING ERRCODE = 'QM006';
  END IF;
  IF NEW.gauge_type_id IS DISTINCT FROM OLD.gauge_type_id THEN
    IF NOT EXISTS (SELECT 1 FROM public.gauge_types y WHERE y.id = NEW.gauge_type_id AND y.active) THEN
      RAISE EXCEPTION 'That gauge type is switched off' USING ERRCODE = 'QM006';
    END IF;
    IF app.gauge_type_needs_range(NEW.gauge_type_id) AND NOT app.gauge_has_range(NEW.range_min, NEW.range_max, NEW.unit_code) THEN
      RAISE EXCEPTION 'This type places its checks across the gauge''s range: enter the range (smallest below largest) and the unit' USING ERRCODE = 'QM006';
    END IF;
  END IF;
  IF NEW.machine_id IS NOT NULL AND NEW.machine_id IS DISTINCT FROM OLD.machine_id
     AND NOT EXISTS (SELECT 1 FROM public.machines x WHERE x.id = NEW.machine_id AND x.active) THEN
    RAISE EXCEPTION 'That machine is switched off' USING ERRCODE = 'QM006';
  END IF;

  IF NEW.status <> OLD.status THEN
    NEW.status_changed_at := now();
    -- Putting a quarantined gauge back into use by hand is a decision: say why. (A passing calibration lifts it by itself, through the trigger
    -- below; retiring or losing the gauge needs no reason of its own.)
    IF OLD.status = 'quarantined' AND NEW.status IN ('active', 'in_calibration') AND NOT v_follows
       AND (NEW.status_reason IS NOT DISTINCT FROM OLD.status_reason OR coalesce(trim(NEW.status_reason), '') = '') THEN
      RAISE EXCEPTION 'Say why the gauge leaves quarantine: give a new status reason' USING ERRCODE = 'QM006';
    END IF;
  ELSIF NEW.status_changed_at IS DISTINCT FROM OLD.status_changed_at THEN
    NEW.status_changed_at := OLD.status_changed_at;
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- 6. Privileges
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app.gauge_has_range(numeric, numeric, text), app.gauge_type_needs_range(uuid),
  app.resolve_type_check(uuid, numeric, numeric, text, numeric), app.copy_type_checks_to_gauge(uuid, boolean, boolean),
  app.apply_type_checks(uuid), app.recalculate_gauge_range_checks(uuid), app.gauge_range_check_state(uuid),
  app.preview_type_checks(uuid, numeric, numeric, text, numeric), app.calibration_reading_basis()
  FROM PUBLIC, anon, authenticated;
-- What the API asks as the signed-in person (each checks who they are inside).
GRANT EXECUTE ON FUNCTION app.apply_type_checks(uuid), app.recalculate_gauge_range_checks(uuid), app.gauge_range_check_state(uuid),
  app.preview_type_checks(uuid, numeric, numeric, text, numeric) TO authenticated;
