-- Calibration: attribute (pass/fail) characteristics alongside variable (measured) ones
-- (docs/calibration-plan.md, C4). An attribute check — "free from damage", "certificate valid" —
-- has no nominal, tolerance or unit; its reading is a pass or a fail as found (and as left).

-- ---------------------------------------------------------------------------
-- Characteristics (templates and per gauge)
-- ---------------------------------------------------------------------------
ALTER TABLE public.gauge_type_characteristics
  ADD COLUMN kind text NOT NULL DEFAULT 'variable' CHECK (kind IN ('variable', 'attribute')),
  ALTER COLUMN nominal DROP NOT NULL,
  ALTER COLUMN tolerance_minus DROP NOT NULL,
  ALTER COLUMN tolerance_plus DROP NOT NULL,
  ALTER COLUMN unit_code DROP NOT NULL,
  ADD CONSTRAINT gauge_type_characteristics_kind_fields CHECK (
    (kind = 'variable' AND nominal IS NOT NULL AND tolerance_minus IS NOT NULL AND tolerance_plus IS NOT NULL AND unit_code IS NOT NULL)
    OR (kind = 'attribute' AND nominal IS NULL AND tolerance_minus IS NULL AND tolerance_plus IS NULL AND unit_code IS NULL));

ALTER TABLE public.gauge_characteristics
  ADD COLUMN kind text NOT NULL DEFAULT 'variable' CHECK (kind IN ('variable', 'attribute')),
  ALTER COLUMN nominal DROP NOT NULL,
  ALTER COLUMN tolerance_minus DROP NOT NULL,
  ALTER COLUMN tolerance_plus DROP NOT NULL,
  ALTER COLUMN unit_code DROP NOT NULL,
  ADD CONSTRAINT gauge_characteristics_kind_fields CHECK (
    (kind = 'variable' AND nominal IS NOT NULL AND tolerance_minus IS NOT NULL AND tolerance_plus IS NOT NULL AND unit_code IS NOT NULL)
    OR (kind = 'attribute' AND nominal IS NULL AND tolerance_minus IS NULL AND tolerance_plus IS NULL AND unit_code IS NULL));

GRANT UPDATE (kind) ON public.gauge_type_characteristics, public.gauge_characteristics TO authenticated;

-- ---------------------------------------------------------------------------
-- Readings: a measured value (variable) or a pass/fail (attribute), as found and as left
-- ---------------------------------------------------------------------------
ALTER TABLE public.calibration_readings
  ADD COLUMN kind text NOT NULL DEFAULT 'variable' CHECK (kind IN ('variable', 'attribute')),
  ADD COLUMN as_found_pass boolean,
  ADD COLUMN as_left_pass boolean,
  ALTER COLUMN nominal DROP NOT NULL,
  ALTER COLUMN tolerance_minus DROP NOT NULL,
  ALTER COLUMN tolerance_plus DROP NOT NULL,
  ALTER COLUMN unit_code DROP NOT NULL,
  ALTER COLUMN as_found DROP NOT NULL,
  ADD CONSTRAINT calibration_readings_kind_fields CHECK (
    (kind = 'variable' AND nominal IS NOT NULL AND tolerance_minus IS NOT NULL AND tolerance_plus IS NOT NULL
      AND unit_code IS NOT NULL AND as_found IS NOT NULL AND as_found_pass IS NULL AND as_left_pass IS NULL)
    OR (kind = 'attribute' AND nominal IS NULL AND tolerance_minus IS NULL AND tolerance_plus IS NULL
      AND unit_code IS NULL AND as_found IS NULL AND as_left IS NULL AND as_found_pass IS NOT NULL));

GRANT UPDATE (as_found_pass, as_left_pass) ON public.calibration_readings TO authenticated;

-- A new gauge copies the kind with the rest of each template characteristic.
CREATE OR REPLACE FUNCTION app.gauge_copy_characteristics() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.gauge_type_id IS NOT NULL THEN
    INSERT INTO public.gauge_characteristics (organisation_id, gauge_id, template_id, sort_order, kind, name, nominal,
                                              tolerance_minus, tolerance_plus, unit_code, method)
    SELECT NEW.organisation_id, NEW.id, t.id, t.sort_order, t.kind, t.name, t.nominal, t.tolerance_minus, t.tolerance_plus, t.unit_code, t.method
    FROM public.gauge_type_characteristics t
    WHERE t.gauge_type_id = NEW.gauge_type_id AND t.active;
  END IF;
  RETURN NULL;
END $$;

-- Readings: copy the characteristic (kind and limits), judge the value or take the pass/fail,
-- keep the calibration's outcome current (app.calibration_reading_after, unchanged).
CREATE OR REPLACE FUNCTION app.calibration_reading_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  ch record;
  lo numeric;
  hi numeric;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.calibration_id <> OLD.calibration_id OR NEW.characteristic_id IS DISTINCT FROM OLD.characteristic_id) THEN
    RAISE EXCEPTION 'A reading cannot move' USING ERRCODE = 'QM006';
  END IF;
  IF NEW.characteristic_id IS NOT NULL THEN
    SELECT k.* INTO ch FROM public.gauge_characteristics k
    JOIN public.calibrations c ON c.gauge_id = k.gauge_id AND c.id = NEW.calibration_id
    WHERE k.id = NEW.characteristic_id;
    IF ch.id IS NULL THEN
      RAISE EXCEPTION 'The characteristic does not belong to this gauge' USING ERRCODE = 'QM006';
    END IF;
    IF TG_OP = 'INSERT' THEN
      NEW.kind := ch.kind; NEW.name := ch.name; NEW.nominal := ch.nominal; NEW.tolerance_minus := ch.tolerance_minus;
      NEW.tolerance_plus := ch.tolerance_plus; NEW.unit_code := ch.unit_code;
      NEW.sort_order := ch.sort_order;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.characteristic_id IS NOT NULL
     AND (NEW.kind, NEW.name, NEW.nominal, NEW.tolerance_minus, NEW.tolerance_plus, NEW.unit_code)
         IS DISTINCT FROM (OLD.kind, OLD.name, OLD.nominal, OLD.tolerance_minus, OLD.tolerance_plus, OLD.unit_code) THEN
    RAISE EXCEPTION 'The limits of a reading come from its characteristic' USING ERRCODE = 'QM006';
  END IF;
  IF coalesce(auth.role(), '') = 'authenticated' THEN
    PERFORM app.assert_calibration_editable(NEW.calibration_id);
  END IF;
  IF NEW.kind = 'attribute' THEN
    IF NEW.as_found IS NOT NULL OR NEW.as_left IS NOT NULL THEN
      RAISE EXCEPTION 'A pass/fail check is recorded as pass or fail, not as a value' USING ERRCODE = 'QM006';
    END IF;
    IF NEW.as_found_pass IS NULL THEN
      RAISE EXCEPTION 'Record whether "%" passed', NEW.name USING ERRCODE = 'QM006';
    END IF;
    NEW.as_found_ok := NEW.as_found_pass;
    NEW.as_left_ok := NEW.as_left_pass;
  ELSE
    IF NEW.as_found_pass IS NOT NULL OR NEW.as_left_pass IS NOT NULL THEN
      RAISE EXCEPTION 'A measured characteristic is recorded as a value, not pass or fail' USING ERRCODE = 'QM006';
    END IF;
    IF NEW.as_found IS NULL THEN
      RAISE EXCEPTION 'Enter the as-found value for "%"', NEW.name USING ERRCODE = 'QM006';
    END IF;
    lo := NEW.nominal - NEW.tolerance_minus;
    hi := NEW.nominal + NEW.tolerance_plus;
    NEW.as_found_ok := NEW.as_found BETWEEN lo AND hi;
    NEW.as_left_ok := CASE WHEN NEW.as_left IS NULL THEN NULL ELSE NEW.as_left BETWEEN lo AND hi END;
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION app.gauge_copy_characteristics(), app.calibration_reading_rules() FROM PUBLIC;
