-- Legacy calibration records (import).
--
-- Gauges brought in by an import start with no calibration history, so they all show as uncalibrated. A source's old calibrations can now be imported as
-- LEGACY records: the outcome stated by the source (pass / adjusted / fail), the date, the next due date, the certificate number and who did it, with NO
-- readings (the readings would need every one of the gauge type's checks; a legacy record says what was concluded, not how). They are marked as legacy
-- on the record itself (`is_legacy`, `imported_from`), never look like a calibration recorded in Fortress, and cannot be made to by anyone: only the
-- import writes the mark, it never changes, and readings cannot be added to such a record. The gauge's last / next dates and its status follow the latest
-- calibration exactly as before (the existing deferred trigger), so a gauge imported with its old calibrations shows when it is next due. A legacy record
-- raises no "calibration recorded" event (history must not start workflows or notices).
--
-- Always add only (an imported record is never matched or rewritten by a later import); certificate files can be attached afterwards as for any record.

ALTER TABLE public.calibrations
  ADD COLUMN is_legacy boolean NOT NULL DEFAULT false,
  ADD COLUMN imported_from text CHECK (imported_from IS NULL OR length(btrim(imported_from)) BETWEEN 1 AND 40),
  ADD COLUMN imported_technician text CHECK (imported_technician IS NULL OR length(imported_technician) <= 200),
  ADD CONSTRAINT calibrations_legacy_marks CHECK (is_legacy OR (imported_from IS NULL AND imported_technician IS NULL));

-- The mark is written by the import only (a transaction-local setting that only app.import_calibration switches on) and never changes.
CREATE FUNCTION app.calibration_legacy_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.is_legacy THEN
      IF coalesce(auth.role(), '') = 'authenticated' AND coalesce(current_setting('app.calibration_legacy', true), '') <> 'on' THEN
        RAISE EXCEPTION 'Only an import can record a legacy calibration' USING ERRCODE = 'QM006';
      END IF;
    ELSE
      NEW.imported_from := NULL;
      NEW.imported_technician := NULL;
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.is_legacy, NEW.imported_from, NEW.imported_technician) IS DISTINCT FROM (OLD.is_legacy, OLD.imported_from, OLD.imported_technician)
     AND coalesce(auth.role(), '') = 'authenticated' THEN
    RAISE EXCEPTION 'Whether a calibration is a legacy record cannot change' USING ERRCODE = 'QM006';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER calibrations_legacy_rules BEFORE INSERT OR UPDATE ON public.calibrations
  FOR EACH ROW EXECUTE FUNCTION app.calibration_legacy_rules();

CREATE FUNCTION app.calibration_legacy_readings() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.calibrations c WHERE c.id = NEW.calibration_id AND c.is_legacy) THEN
    RAISE EXCEPTION 'A legacy calibration has no readings: it records only what the old system concluded' USING ERRCODE = 'QM006';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER calibration_readings_legacy BEFORE INSERT ON public.calibration_readings
  FOR EACH ROW EXECUTE FUNCTION app.calibration_legacy_readings();
REVOKE ALL ON FUNCTION app.calibration_legacy_rules(), app.calibration_legacy_readings() FROM PUBLIC, anon, authenticated;

-- One legacy record: a new calibration with the outcome the source gave. Add only. Runs inside the import (as the person who started it, so the
-- table's own rules apply: not in the future, the gauge must be editable, the reference is generated, the next due date defaults from the gauge's interval).
CREATE FUNCTION app.import_calibration(p_org uuid, p_id uuid, d jsonb, p_connection uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid; v_gauge uuid := app.imp_ref(d, 'gauge'); v_outcome text := lower(app.imp_text(d, 'outcome')); v_system text; v_by text := lower(coalesce(app.imp_text(d, 'performedBy'), 'internal'));
BEGIN
  IF p_id IS NOT NULL THEN RAISE EXCEPTION 'Legacy calibrations are only ever added' USING ERRCODE = 'QM022'; END IF;
  IF v_gauge IS NULL THEN RAISE EXCEPTION 'Name the gauge this calibration was done on' USING ERRCODE = 'QM022'; END IF;
  IF app.imp_date(d, 'calibratedOn') IS NULL THEN RAISE EXCEPTION 'Give the date it was calibrated' USING ERRCODE = 'QM022'; END IF;
  IF v_outcome IS NULL OR v_outcome NOT IN ('pass', 'adjusted', 'fail') THEN RAISE EXCEPTION 'The outcome must be pass, adjusted or fail' USING ERRCODE = 'QM022'; END IF;
  IF v_by NOT IN ('internal', 'external') THEN RAISE EXCEPTION 'Done by must be internal or external' USING ERRCODE = 'QM022'; END IF;
  IF p_connection IS NOT NULL THEN
    SELECT external_system INTO v_system FROM public.integration_connections WHERE id = p_connection AND organisation_id = p_org;
  END IF;
  PERFORM set_config('app.calibration_legacy', 'on', true);
  INSERT INTO public.calibrations (organisation_id, gauge_id, reference, calibrated_on, performed_by, supplier_id, certificate_number, outcome, next_due_on, notes,
                                   is_legacy, imported_from, imported_technician)
  VALUES (p_org, v_gauge, 'pending', app.imp_date(d, 'calibratedOn'), v_by, app.imp_ref(d, 'supplier'), app.imp_text(d, 'certificateNumber'), v_outcome,
          app.imp_date(d, 'nextDueOn'), app.imp_text(d, 'notes'), true, coalesce(v_system, 'import'), app.imp_text(d, 'technicianName'))
  RETURNING id INTO v_id;
  PERFORM set_config('app.calibration_legacy', 'off', true);
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION app.import_calibration(uuid, uuid, jsonb, uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Teach the shared import functions the new kind. Each is rewritten from its own live definition (only the named text changes, and the migration
-- refuses to finish if that text is not found exactly once), so nothing a later migration changed is lost.
-- ---------------------------------------------------------------------------
CREATE FUNCTION pg_temp.patch(p_fn regprocedure, p_old text, p_new text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_def text := pg_get_functiondef(p_fn); v_n integer;
BEGIN
  v_n := (length(v_def) - length(replace(v_def, p_old, ''))) / length(p_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'Expected to find % exactly once in %, found % times', p_old, p_fn, v_n; END IF;
  EXECUTE replace(v_def, p_old, p_new);
END $$;

SELECT pg_temp.patch('app.integration_entity_types()'::regprocedure, '''gauge'', ''nonconformance''', '''gauge'', ''calibration'', ''nonconformance''');
SELECT pg_temp.patch('app.integration_may_write(uuid, text)'::regprocedure,
  'WHEN ''nonconformance'' THEN app.has_permission(p_org, ''ncr.create'')',
  'WHEN ''calibration'' THEN app.has_permission(p_org, ''calibration.manage'') WHEN ''nonconformance'' THEN app.has_permission(p_org, ''ncr.create'')');
SELECT pg_temp.patch('app.system_import_record(uuid, uuid, uuid, uuid, uuid, jsonb)'::regprocedure,
  'r.entity_type = ''nonconformance'' THEN ''add_only''', 'r.entity_type IN (''nonconformance'', ''calibration'') THEN ''add_only''');
SELECT pg_temp.patch('app.system_import_record(uuid, uuid, uuid, uuid, uuid, jsonb)'::regprocedure,
  'WHEN ''nonconformance'' THEN app.import_nonconformance(p_org, p_internal, v_data)',
  'WHEN ''calibration'' THEN app.import_calibration(p_org, p_internal, v_data, r.connection_id) WHEN ''nonconformance'' THEN app.import_nonconformance(p_org, p_internal, v_data)');
SELECT pg_temp.patch('app.integration_settings_for(uuid, text)'::regprocedure,
  'p_entity IN (''nonconformance'', ''goods_receipt'') THEN ''add_only''', 'p_entity IN (''nonconformance'', ''goods_receipt'', ''calibration'') THEN ''add_only''');
SELECT pg_temp.patch('app.integration_settings_for(uuid, text)'::regprocedure,
  'p_entity IN (''nonconformance'', ''goods_receipt'', ''po_receipt_total'') THEN false', 'p_entity IN (''nonconformance'', ''goods_receipt'', ''po_receipt_total'', ''calibration'') THEN false');
SELECT pg_temp.patch('app.integration_template_settings(text, jsonb)'::regprocedure,
  'p_entity IN (''nonconformance'', ''goods_receipt'') THEN ''add_only''', 'p_entity IN (''nonconformance'', ''goods_receipt'', ''calibration'') THEN ''add_only''');
SELECT pg_temp.patch('app.integration_template_settings(text, jsonb)'::regprocedure,
  'p_entity IN (''nonconformance'', ''goods_receipt'', ''po_receipt_total'') THEN false', 'p_entity IN (''nonconformance'', ''goods_receipt'', ''po_receipt_total'', ''calibration'') THEN false');
SELECT pg_temp.patch('app.integration_entity_tracks_missing(text)'::regprocedure,
  '''nonconformance'', ''goods_receipt'', ''po_receipt_total''', '''nonconformance'', ''goods_receipt'', ''po_receipt_total'', ''calibration''');
SELECT pg_temp.patch('app.set_integration_import_settings(uuid, text, jsonb)'::regprocedure,
  'p_entity = ''nonconformance'' AND (v_mode', 'p_entity IN (''nonconformance'', ''calibration'') AND (v_mode');
SELECT pg_temp.patch('app.set_integration_import_settings(uuid, text, jsonb)'::regprocedure,
  'Non-conformances are only ever added: once in Fortress they are managed there', 'These records are only ever added: once in Fortress they are managed there');
SELECT pg_temp.patch('app.system_stage_integration_records(uuid, uuid, uuid, jsonb, text, boolean)'::regprocedure,
  'r.entity_type <> ''nonconformance''', 'r.entity_type NOT IN (''nonconformance'', ''calibration'')');
-- A gauge can be named in an import by its asset number: it joins the list of values a link can take.
SELECT pg_temp.patch('app.integration_reference_values(uuid, text, text, integer, integer)'::regprocedure,
  '''machine'', ''employee'', ''gauge_type'') THEN', '''machine'', ''employee'', ''gauge_type'', ''gauge'') THEN');
SELECT pg_temp.patch('app.integration_reference_values(uuid, text, text, integer, integer)'::regprocedure,
  'FROM public.gauge_types g WHERE p_kind = ''gauge_type'' AND g.organisation_id = p_org',
  'FROM public.gauge_types g WHERE p_kind = ''gauge_type'' AND g.organisation_id = p_org
      UNION ALL SELECT ga.asset_number, ga.description, NULL, ga.status NOT IN (''retired'', ''lost''), false FROM public.gauges ga WHERE p_kind = ''gauge'' AND ga.organisation_id = p_org AND ga.deleted_at IS NULL');

-- A legacy history must not start workflows or notices as if it had just been recorded.
SELECT pg_temp.patch('app.calibration_after_change()'::regprocedure, 'IF TG_OP = ''INSERT'' THEN', 'IF TG_OP = ''INSERT'' AND NOT cur.is_legacy THEN');
