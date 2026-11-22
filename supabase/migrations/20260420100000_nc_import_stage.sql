-- Carrying the source's stage over when non-conformances are imported (docs/cost-import-plan.md §7, decisions CI-D9, CI-D12).
--
-- An imported NC used to be a draft, always. A history load has NCs that are open, closed or cancelled in the source, and Fortress now takes that stage: a new optional
-- field "Stage" (any of the eight stages; empty = draft, as before) with "Closed on" (a date; empty = the import day) and "Reason cancelled" (empty = "Cancelled in <connection>").
--
-- What the table's rules say about it:
--  * A person still cannot insert anything but a draft or an open NC. The import switches on a transaction-local setting (`app.ncr_history_import`, set only by
--    app.import_nonconformance, and only for a stage other than draft) that lets the rules trigger accept the other stages and keep the closed date.
--  * The cumulative stage gates (containment resolved, dispositions approved) are a BEFORE UPDATE trigger and do not run for an insert, so a historical NC can be closed with no
--    containment or disposition records, as the grandfathered NCs already are. From then on it is an ordinary NC: reopening it and closing it again needs the gates.
--  * The opening rules still apply to every stage past draft (severity, quantity affected, a part or a description, a category, the customer or supplier the source names),
--    so a row that lacks them is refused with the reason; a mapping's "when empty" default fills what the source does not have. A cancelled NC needs none of them.
--  * Importing an NC as contained, investigating, dispositioned, awaiting closure or closed skips what those stages normally prove, so it needs the right to approve
--    dispositions (ncr.approve_disposition) as well as the right to create NCs. Open and cancelled need only the right to create.
--  * History is not news: such an NC raises no event (so no workflow rule starts) and no notice, and its audit trail is written as for any record, with the person who
--    started the import as the actor. A draft import behaves exactly as before.
-- Later changes in the source are not carried (NCs stay add-only, managed in Fortress once they are in).

-- The shared functions are rewritten from their live definitions by a checked text patch: the migration refuses to finish unless the old text is found exactly once.
CREATE FUNCTION pg_temp.patch(p_fn regprocedure, p_old text, p_new text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_def text := pg_get_functiondef(p_fn); v_n integer;
BEGIN
  v_n := (length(v_def) - length(replace(v_def, p_old, ''))) / length(p_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'Expected to find % exactly once in %, found % times', p_old, p_fn, v_n; END IF;
  EXECUTE replace(v_def, p_old, p_new);
END $$;

-- The rules trigger: stage on insert, the closed date, and the opening rules for every stage past draft (a cancelled one needs none).
SELECT pg_temp.patch('app.nonconformance_rules()'::regprocedure,
  'IF NEW.stage NOT IN (''draft'', ''open'') THEN',
  'IF NEW.stage NOT IN (''draft'', ''open'') AND coalesce(current_setting(''app.ncr_history_import'', true), '''') <> ''on'' THEN');
SELECT pg_temp.patch('app.nonconformance_rules()'::regprocedure,
  'NEW.closed_at := NULL; NEW.closed_by := NULL;',
  'IF coalesce(current_setting(''app.ncr_history_import'', true), '''') <> ''on'' THEN NEW.closed_at := NULL; NEW.closed_by := NULL; END IF;');
SELECT pg_temp.patch('app.nonconformance_rules()'::regprocedure,
  E'IF NEW.stage = ''open'' THEN\n      PERFORM app.assert_ncr_openable(NEW);',
  E'IF NEW.stage NOT IN (''draft'', ''cancelled'') THEN\n      PERFORM app.assert_ncr_openable(NEW);');

-- History raises no event (the workflow engine reads these) ...
SELECT pg_temp.patch('app.nonconformance_events()'::regprocedure,
  'IF auth.role() IS DISTINCT FROM ''authenticated'' THEN',
  'IF auth.role() IS DISTINCT FROM ''authenticated'' OR coalesce(current_setting(''app.ncr_history_import'', true), '''') = ''on'' THEN');
-- ... and no notice (they are made from the audit trail, which is still written).
SELECT pg_temp.patch('app.emit_notification()'::regprocedure,
  E'BEGIN\n  -- A recipient row also changes when they view or acknowledge',
  E'BEGIN\n  -- A non-conformance brought in with a stage is history: nobody is told about it.\n  IF NEW.entity_type = ''nonconformances'' AND coalesce(current_setting(''app.ncr_history_import'', true), '''') = ''on'' THEN\n    RETURN NULL;\n  END IF;\n\n  -- A recipient row also changes when they view or acknowledge');

-- The importer now takes the connection (to say where a cancellation came from) and the stage.
DROP FUNCTION app.import_nonconformance(uuid, uuid, jsonb);
CREATE FUNCTION app.import_nonconformance(p_org uuid, p_id uuid, d jsonb, p_connection uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_id uuid;
  v_stage text := lower(coalesce(app.imp_text(d, 'stage'), 'draft'));
  v_site uuid := app.imp_ref(d, 'site');
  v_detected date := coalesce(app.imp_date(d, 'detectedAt'), current_date);
  v_closed date := app.imp_date(d, 'closedOn');
  v_closed_at timestamptz;
  v_reason text := app.imp_text(d, 'stageReason');
  v_system text;
BEGIN
  IF p_id IS NOT NULL THEN RAISE EXCEPTION 'Non-conformances are only ever added: once in Fortress they are managed there' USING ERRCODE = 'QM022'; END IF;
  IF v_stage NOT IN ('draft', 'open', 'contained', 'investigating', 'dispositioned', 'awaiting_closure', 'closed', 'cancelled') THEN
    RAISE EXCEPTION 'The stage must be one of: draft, open, contained, investigating, dispositioned, awaiting_closure, closed, cancelled' USING ERRCODE = 'QM022';
  END IF;
  IF v_stage NOT IN ('draft', 'open', 'cancelled') AND NOT app.has_permission(p_org, 'ncr.approve_disposition', v_site) THEN
    RAISE EXCEPTION 'Importing a non-conformance as % skips containment and disposition, so it needs the right to approve dispositions', v_stage USING ERRCODE = 'QM022';
  END IF;
  IF v_stage = 'closed' THEN
    v_closed := coalesce(v_closed, current_date);
    IF v_closed > current_date THEN RAISE EXCEPTION 'The closed date is in the future' USING ERRCODE = 'QM022'; END IF;
    -- compared only when the source gave a detected date: without one the table's default (today) is not a date anyone gave
    IF app.imp_date(d, 'detectedAt') IS NOT NULL AND v_closed < v_detected THEN RAISE EXCEPTION 'The closed date is before the date it was detected' USING ERRCODE = 'QM022'; END IF;
    v_closed_at := least((v_closed + time '12:00')::timestamptz, now());
  END IF;
  IF v_stage = 'cancelled' THEN
    IF v_reason IS NULL THEN
      IF p_connection IS NOT NULL THEN
        SELECT external_system INTO v_system FROM public.integration_connections WHERE id = p_connection AND organisation_id = p_org;
      END IF;
      v_reason := 'Cancelled in ' || coalesce(v_system, 'the source system');
    END IF;
  ELSE
    v_reason := NULL;
  END IF;
  IF v_stage <> 'draft' THEN PERFORM set_config('app.ncr_history_import', 'on', true); END IF;
  INSERT INTO public.nonconformances (organisation_id, source, stage, stage_reason, closed_at, title, severity, description, requirement, actual_result, site_id, part_id, customer_id, supplier_id,
                                      work_order, purchase_order, customer_reference, lot_number, serial_number, quantity_affected, quantity_inspected, detected_at,
                                      detection_process_id, causal_process_id, responsible_employee_id, category_id, detected_by_employee_id, responsible_department_id)
  VALUES (p_org, app.imp_text(d, 'source'), v_stage, v_reason, v_closed_at, app.imp_text(d, 'title'), app.imp_text(d, 'severity'), app.imp_text(d, 'description'), app.imp_text(d, 'requirement'),
          app.imp_text(d, 'actualResult'), v_site, app.imp_ref(d, 'part'), app.imp_ref(d, 'customer'), app.imp_ref(d, 'supplier'),
          app.imp_text(d, 'workOrder'), app.imp_text(d, 'purchaseOrder'), app.imp_text(d, 'customerReference'), app.imp_text(d, 'lotNumber'), app.imp_text(d, 'serialNumber'),
          app.imp_num(d, 'quantityAffected'), app.imp_num(d, 'quantityInspected'), v_detected,
          app.imp_ref(d, 'detectionMachine'), app.imp_ref(d, 'causalMachine'), app.imp_ref(d, 'responsibleEmployee'), app.imp_ref(d, 'category'),
          app.imp_ref(d, 'detectedBy'), app.imp_ref(d, 'responsibleDepartment'))
  RETURNING id INTO v_id;
  PERFORM set_config('app.ncr_history_import', 'off', true);
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION app.import_nonconformance(uuid, uuid, jsonb, uuid) FROM PUBLIC, anon, authenticated;

SELECT pg_temp.patch('app.system_import_record(uuid, uuid, uuid, uuid, uuid, jsonb)'::regprocedure,
  'WHEN ''nonconformance'' THEN app.import_nonconformance(p_org, p_internal, v_data)',
  'WHEN ''nonconformance'' THEN app.import_nonconformance(p_org, p_internal, v_data, r.connection_id)');
