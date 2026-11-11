-- Calibration integrity (audit report H2 and H3).
--
-- H2: a calibration that has readings must have a reading for every active check of the gauge. Before, one in-tolerance reading out of three checks
--     was worked out as a pass and returned a quarantined gauge to service. Checked once, at the end of the transaction (the API flushes it), so a record
--     and all its readings can be saved together. Checks added to the gauge after the calibration was recorded do not count against it. A calibration
--     with no readings at all keeps the outcome it was given (an external certificate).
-- H3: once a calibration is saved, correcting it (the outcome, the dates, any reading, deleting it) needs calibration.manage. Someone who may only record
--     could before rewrite a failed reading to a pass afterwards and reinstate the gauge. Their own notes, and linking a non-conformance, stay open to them.
CREATE FUNCTION app.calibration_readings_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_cal uuid := coalesce(NEW.calibration_id, OLD.calibration_id);
  c public.calibrations%ROWTYPE;
  v_missing text;
BEGIN
  IF coalesce(auth.role(), '') <> 'authenticated' THEN RETURN NULL; END IF;
  SELECT * INTO c FROM public.calibrations WHERE id = v_cal;
  IF NOT FOUND OR c.deleted_at IS NOT NULL THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.calibration_readings r WHERE r.calibration_id = v_cal) THEN RETURN NULL; END IF;
  SELECT string_agg(k.name, ', ' ORDER BY k.sort_order, k.name) INTO v_missing
    FROM public.gauge_characteristics k
   WHERE k.gauge_id = c.gauge_id AND k.active AND k.created_at <= c.created_at
     AND NOT EXISTS (SELECT 1 FROM public.calibration_readings r WHERE r.calibration_id = v_cal AND r.characteristic_id = k.id);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Enter a reading for every check before saving. Missing: %', v_missing USING ERRCODE = 'QM006';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER calibration_readings_complete AFTER INSERT OR UPDATE OR DELETE ON public.calibration_readings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.calibration_readings_complete();

CREATE FUNCTION app.calibration_correction_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_created timestamptz;
  v_org uuid;
  v_cal uuid;
  v_site uuid;
  v_changed boolean;
BEGIN
  IF coalesce(auth.role(), '') <> 'authenticated' THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'calibrations' THEN
    v_cal := OLD.id; v_created := OLD.created_at; v_org := OLD.organisation_id;
    v_changed := (NEW.calibrated_on, NEW.performed_by, NEW.technician_id, NEW.supplier_id, NEW.certificate_number, NEW.procedure_ref, NEW.reference_standards,
                  NEW.temperature_c, NEW.humidity_pct, NEW.outcome, NEW.next_due_on, NEW.deleted_at, NEW.delete_reason)
                 IS DISTINCT FROM
                 (OLD.calibrated_on, OLD.performed_by, OLD.technician_id, OLD.supplier_id, OLD.certificate_number, OLD.procedure_ref, OLD.reference_standards,
                  OLD.temperature_c, OLD.humidity_pct, OLD.outcome, OLD.next_due_on, OLD.deleted_at, OLD.delete_reason);
    SELECT g.site_id INTO v_site FROM public.gauges g WHERE g.id = OLD.gauge_id;
  ELSE
    v_cal := OLD.calibration_id; v_org := OLD.organisation_id;
    SELECT c.created_at INTO v_created FROM public.calibrations c WHERE c.id = OLD.calibration_id;
    v_changed := (NEW.as_found, NEW.as_left, NEW.as_found_pass, NEW.as_left_pass) IS DISTINCT FROM (OLD.as_found, OLD.as_left, OLD.as_found_pass, OLD.as_left_pass);
    v_site := app.calibration_site(OLD.calibration_id);
  END IF;
  -- Changes in the transaction that recorded it are part of recording it.
  IF NOT v_changed OR v_created = now() THEN RETURN NEW; END IF;
  IF NOT app.has_permission(v_org, 'calibration.manage', v_site) THEN
    RAISE EXCEPTION 'Correcting a saved calibration needs the calibration.manage permission' USING ERRCODE = 'QM006';
  END IF;
  RETURN NEW;
END $$;

-- "aaa_": runs before the existing rules, so a refused correction does no other work first.
CREATE TRIGGER aaa_calibrations_correction_guard BEFORE UPDATE ON public.calibrations FOR EACH ROW EXECUTE FUNCTION app.calibration_correction_guard();
CREATE TRIGGER aaa_calibration_readings_correction_guard BEFORE UPDATE ON public.calibration_readings FOR EACH ROW EXECUTE FUNCTION app.calibration_correction_guard();

REVOKE ALL ON FUNCTION app.calibration_readings_complete(), app.calibration_correction_guard() FROM PUBLIC, anon, authenticated;
