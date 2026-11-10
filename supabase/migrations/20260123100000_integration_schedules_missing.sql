-- IN8: schedules, records that disappeared from the source, rejected rows a person decides to ignore, and a health summary
-- (docs/connectors-plan.md §6.16, decisions F1–F3 agreed 2026-11-10).
--
--  * Schedule (F3: one daily run). An API connection's kind of record can be set to run daily with a chosen import template; the person who sets
--    it is recorded (`schedule_set_by`) and scheduled runs import as them, only while they may still run imports and write that kind of record.
--    `app.system_schedule_integration_runs` (API login only) asks for each scheduled import once a day: incremental when the connection's
--    settings say how and a cursor exists, otherwise full; never a second one while an earlier run is still waiting or running (that run carries
--    on instead, so a failure recovers without duplicates). Why a scheduled import was not asked for is kept on the settings.
--  * Records that disappeared (F1: guarded). After a FULL read that finished (succeeded or partial), the records this connection imported before
--    that the source no longer sent are listed (`integration_missing_records`). With "make inactive", they are made inactive only when no row of
--    the run was rejected without an identifier and at most 20% of the kind's imported records would go; otherwise they are held for a person to
--    confirm. A record a person decided to keep is not asked about again until the source sends it once more. A record that comes back in a
--    later full read is marked returned. Nothing is ever deleted. Not offered for records of events
--    (non-conformances, goods receipts, received quantities).
--  * Rejected and failed rows (F2): a person may ignore them with a reason (and bring them back); Fortress never edits what the source sent.
--  * `app.integration_health(org)`: per connection and kind of record, the schedule, last run, last success, failures in a row, rows needing
--    action, records waiting for a decision, values waiting for review and the scheduler's last problem.

-- ---------------------------------------------------------------------------
-- Schedule settings
-- ---------------------------------------------------------------------------
ALTER TABLE public.integration_import_settings
  ADD COLUMN template_id uuid,
  ADD COLUMN schedule_set_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  ADD COLUMN last_scheduled_at timestamptz,
  ADD COLUMN last_schedule_problem text CHECK (last_schedule_problem IS NULL OR length(last_schedule_problem) <= 500),
  ADD CONSTRAINT integration_import_settings_template_fkey FOREIGN KEY (template_id, organisation_id) REFERENCES public.integration_templates (id, organisation_id);

-- Kinds of record that are events: a source dropping old ones is normal, so "when a record disappears" does not apply to them.
CREATE FUNCTION app.integration_entity_tracks_missing(p_entity text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$ SELECT p_entity NOT IN ('nonconformance', 'goods_receipt', 'po_receipt_total') $$;

DROP FUNCTION app.set_integration_import_settings(uuid, text, jsonb);
CREATE FUNCTION app.set_integration_import_settings(p_connection uuid, p_entity text, p_settings jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.integration_connections%ROWTYPE; v_provider text; v_kind text; v_mode text; v_match boolean; v_missing text; v_schedule text; cur jsonb;
        old public.integration_import_settings%ROWTYPE; v_template uuid; t public.integration_templates%ROWTYPE; v_set_by uuid;
BEGIN
  c := app.integration_connection_for_write(p_connection, 'integrations.manage');
  PERFORM app.integration_assert_entity(p_entity);
  IF c.status = 'retired' THEN RAISE EXCEPTION 'A retired connection cannot be changed' USING ERRCODE = 'QM022'; END IF;
  IF jsonb_typeof(coalesce(p_settings, 'null'::jsonb)) <> 'object' THEN RAISE EXCEPTION 'Give the settings' USING ERRCODE = 'QM022'; END IF;
  SELECT key, kind INTO v_provider, v_kind FROM public.integration_providers WHERE id = c.provider_id;
  SELECT * INTO old FROM public.integration_import_settings WHERE connection_id = c.id AND entity_type = p_entity;
  cur := app.integration_settings_for(c.id, p_entity);
  v_mode := coalesce(p_settings ->> 'writeMode', cur ->> 'writeMode');
  v_match := coalesce((p_settings ->> 'matchExisting')::boolean, (cur ->> 'matchExisting')::boolean);
  v_missing := coalesce(p_settings ->> 'onMissing', cur ->> 'onMissing');
  v_schedule := coalesce(p_settings ->> 'schedule', cur ->> 'schedule');
  v_template := CASE WHEN p_settings ? 'templateId' THEN nullif(p_settings ->> 'templateId', '')::uuid ELSE old.template_id END;
  IF v_mode NOT IN ('add_only', 'add_update', 'update_only') THEN RAISE EXCEPTION 'An import adds new records only, adds and updates, or updates only' USING ERRCODE = 'QM022'; END IF;
  IF v_missing NOT IN ('nothing', 'list', 'deactivate') THEN RAISE EXCEPTION 'When a record disappears: do nothing, list it, or make it inactive' USING ERRCODE = 'QM022'; END IF;
  IF v_schedule NOT IN ('manual', 'daily') THEN RAISE EXCEPTION 'An import runs by hand or daily' USING ERRCODE = 'QM022'; END IF;
  IF p_entity = 'nonconformance' AND (v_mode <> 'add_only' OR v_match) THEN
    RAISE EXCEPTION 'Non-conformances are only ever added: once in Fortress they are managed there' USING ERRCODE = 'QM022';
  END IF;
  IF v_missing <> 'nothing' AND NOT app.integration_entity_tracks_missing(p_entity) THEN
    RAISE EXCEPTION 'These records are events: a source leaving out old ones is normal, so nothing happens when one disappears' USING ERRCODE = 'QM022';
  END IF;
  IF v_missing = 'deactivate' AND NOT app.integration_entity_has_active(p_entity) THEN
    RAISE EXCEPTION 'These records cannot be made inactive; choose to do nothing or to list them' USING ERRCODE = 'QM022';
  END IF;
  IF v_template IS NOT NULL THEN
    SELECT * INTO t FROM public.integration_templates WHERE id = v_template AND organisation_id = c.organisation_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Template not found' USING ERRCODE = 'P0002'; END IF;
    IF t.entity_type <> p_entity THEN RAISE EXCEPTION 'That template is for another kind of record' USING ERRCODE = 'QM022'; END IF;
    IF t.archived_at IS NOT NULL THEN RAISE EXCEPTION 'That template is archived' USING ERRCODE = 'QM022'; END IF;
  END IF;
  IF v_schedule = 'daily' THEN
    IF v_kind <> 'api' THEN
      RAISE EXCEPTION 'An uploaded file is imported when someone uploads it: a file connection cannot run on a schedule' USING ERRCODE = 'QM022';
    END IF;
    IF v_provider = 'rest_api' AND NOT ((c.config -> 'entities') ? p_entity) THEN
      RAISE EXCEPTION 'Say in the connection''s settings where the API gives these records before scheduling them' USING ERRCODE = 'QM022';
    END IF;
    IF v_template IS NULL THEN RAISE EXCEPTION 'Choose the import template a daily import uses' USING ERRCODE = 'QM022'; END IF;
    IF NOT app.has_permission(c.organisation_id, 'integrations.run') OR NOT app.integration_may_write(c.organisation_id, p_entity) THEN
      RAISE EXCEPTION 'A daily import writes these records as you, so it needs you to be allowed to run imports and to create and edit them' USING ERRCODE = '42501';
    END IF;
    -- Scheduled runs act for whoever last switched the schedule on or changed what it imports with.
    v_set_by := CASE WHEN old.schedule IS DISTINCT FROM 'daily' OR old.template_id IS DISTINCT FROM v_template OR old.schedule_set_by IS NULL THEN auth.uid() ELSE old.schedule_set_by END;
  ELSE
    v_set_by := NULL;
  END IF;
  INSERT INTO public.integration_import_settings AS s (organisation_id, connection_id, entity_type, write_mode, match_existing, on_missing, schedule, template_id, schedule_set_by)
  VALUES (c.organisation_id, c.id, p_entity, v_mode, v_match, v_missing, v_schedule, v_template, v_set_by)
  ON CONFLICT (connection_id, entity_type) DO UPDATE
     SET write_mode = EXCLUDED.write_mode, match_existing = EXCLUDED.match_existing, on_missing = EXCLUDED.on_missing, schedule = EXCLUDED.schedule,
         template_id = EXCLUDED.template_id, schedule_set_by = EXCLUDED.schedule_set_by,
         last_schedule_problem = CASE WHEN EXCLUDED.schedule = 'daily' THEN s.last_schedule_problem END,
         updated_at = now(), updated_by = auth.uid()
   WHERE (s.write_mode, s.match_existing, s.on_missing, s.schedule, s.template_id, s.schedule_set_by)
         IS DISTINCT FROM (EXCLUDED.write_mode, EXCLUDED.match_existing, EXCLUDED.on_missing, EXCLUDED.schedule, EXCLUDED.template_id, EXCLUDED.schedule_set_by);
  RETURN app.integration_settings_for(c.id, p_entity);
END $$;

-- The daily scheduler (API login only): one run per scheduled import per day, as the person who scheduled it.
CREATE FUNCTION app.system_schedule_integration_runs(p_today date DEFAULT current_date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s record; v_problem text; v_ok boolean; v_claims text := coalesce(current_setting('request.jwt.claims', true), ''); v_kind text; v_cursor text; tv public.integration_template_versions%ROWTYPE; v_run uuid; out jsonb := '[]'::jsonb;
BEGIN
  FOR s IN
    SELECT st.*, c.status AS conn_status, c.config, p.key AS provider_key, p.kind AS provider_kind, t.current_version, t.archived_at AS template_archived
      FROM public.integration_import_settings st
      JOIN public.integration_connections c ON c.id = st.connection_id
      JOIN public.integration_providers p ON p.id = c.provider_id
      JOIN public.organisations o ON o.id = st.organisation_id AND o.status = 'active'
      LEFT JOIN public.integration_templates t ON t.id = st.template_id
     WHERE st.schedule = 'daily'
     ORDER BY st.organisation_id, st.connection_id, st.entity_type
     FOR UPDATE OF st
  LOOP
    v_problem := NULL; v_run := NULL;
    -- already asked for today, or an earlier run still waiting or running (it carries on instead)
    IF EXISTS (SELECT 1 FROM public.integration_sync_runs r WHERE r.connection_id = s.connection_id AND r.entity_type = s.entity_type
                 AND r.trigger = 'schedule' AND r.requested_at >= p_today::timestamptz AND r.requested_at < (p_today + 1)::timestamptz) THEN
      CONTINUE;
    END IF;
    IF EXISTS (SELECT 1 FROM public.integration_sync_runs r WHERE r.connection_id = s.connection_id AND r.entity_type = s.entity_type AND r.status IN ('queued', 'running')) THEN
      out := out || jsonb_build_object('connectionId', s.connection_id, 'entityType', s.entity_type, 'runId', NULL, 'skipped', 'An earlier import is still running; it carries on');
      CONTINUE;
    END IF;
    IF s.conn_status <> 'active' THEN v_problem := 'The connection is not active';
    ELSIF s.provider_kind <> 'api' THEN v_problem := 'Only an API connection runs on a schedule';
    ELSIF s.template_id IS NULL OR s.template_archived IS NOT NULL THEN v_problem := 'The import template is missing or archived';
    ELSIF s.schedule_set_by IS NULL THEN v_problem := 'Nobody is recorded as having scheduled it: switch the schedule on again';
    ELSIF s.provider_key = 'rest_api' AND NOT ((s.config -> 'entities') ? s.entity_type) THEN v_problem := 'The connection no longer says where the API gives these records';
    ELSIF s.provider_key = 'rest_api' AND NOT app.integration_host_allowed(s.organisation_id, s.config ->> 'baseUrl') THEN v_problem := 'Your organisation no longer allows connections to this host';
    END IF;
    IF v_problem IS NULL THEN
      -- The person who scheduled it must still be allowed to run imports and write these records (checked as them, with their stored authority).
      PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', s.schedule_set_by, 'role', 'authenticated', 'aal', 'aal2')::text, true);
      v_ok := app.is_member(s.organisation_id) AND app.has_permission(s.organisation_id, 'integrations.run') AND app.integration_may_write(s.organisation_id, s.entity_type);
      PERFORM set_config('request.jwt.claims', v_claims, true);
      IF NOT coalesce(v_ok, false) THEN v_problem := 'The person who scheduled it may no longer run this import: someone allowed to should switch the schedule on again'; END IF;
    END IF;
    IF v_problem IS NULL THEN
      SELECT cursor INTO v_cursor FROM public.integration_sync_cursors WHERE connection_id = s.connection_id AND entity_type = s.entity_type;
      v_kind := CASE WHEN v_cursor IS NOT NULL AND (s.provider_key <> 'rest_api' OR (s.config -> 'entities' -> s.entity_type) ? 'incremental') THEN 'incremental' ELSE 'full' END;
      SELECT * INTO tv FROM public.integration_template_versions WHERE template_id = s.template_id AND version = s.current_version;
      INSERT INTO public.integration_sync_runs (organisation_id, connection_id, entity_type, kind, trigger, requested_by, cursor_start, cursor_next, template_version_id, settings)
      VALUES (s.organisation_id, s.connection_id, s.entity_type, v_kind, 'schedule', s.schedule_set_by,
              CASE WHEN v_kind = 'incremental' THEN v_cursor END, CASE WHEN v_kind = 'incremental' THEN v_cursor END,
              tv.id, app.integration_settings_for(s.connection_id, s.entity_type) || coalesce(tv.settings, '{}'::jsonb))
      RETURNING id INTO v_run;
    END IF;
    UPDATE public.integration_import_settings SET last_scheduled_at = now(), last_schedule_problem = v_problem
     WHERE connection_id = s.connection_id AND entity_type = s.entity_type;
    out := out || jsonb_build_object('connectionId', s.connection_id, 'entityType', s.entity_type, 'runId', v_run, 'skipped', v_problem);
  END LOOP;
  RETURN out;
END $$;

-- ---------------------------------------------------------------------------
-- Records that disappeared from the source
-- ---------------------------------------------------------------------------
CREATE TABLE public.integration_missing_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id),
  connection_id uuid NOT NULL,
  entity_type text NOT NULL CHECK (entity_type = ANY (app.integration_entity_types())),
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
  internal_id uuid NOT NULL,
  detected_run_id uuid NOT NULL,
  -- listed: shown for information; held: "make inactive" was asked for but the guard stopped it, a person decides; deactivated; kept (a person
  -- decided to keep it active, with a reason); returned (a later full read sent it again).
  status text NOT NULL CHECK (status IN ('listed', 'held', 'deactivated', 'kept', 'returned')),
  reason text CHECK (reason IS NULL OR length(reason) <= 500),
  decided_at timestamptz,
  decided_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  decision_note text CHECK (decision_note IS NULL OR length(decision_note) <= 1000),
  returned_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT integration_missing_records_connection_fkey FOREIGN KEY (connection_id, organisation_id) REFERENCES public.integration_connections (id, organisation_id),
  CONSTRAINT integration_missing_records_run_fkey FOREIGN KEY (detected_run_id, organisation_id) REFERENCES public.integration_sync_runs (id, organisation_id)
);
-- One open entry per source record.
CREATE UNIQUE INDEX integration_missing_records_open_key ON public.integration_missing_records (connection_id, entity_type, external_id) WHERE status IN ('listed', 'held');
CREATE INDEX integration_missing_records_org_idx ON public.integration_missing_records (organisation_id, status);
CREATE INDEX integration_missing_records_run_idx ON public.integration_missing_records (detected_run_id);
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.integration_missing_records FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.integration_missing_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.integration_missing_records FROM anon, authenticated;
GRANT SELECT ON public.integration_missing_records TO authenticated;
CREATE POLICY integration_missing_records_select ON public.integration_missing_records FOR SELECT TO authenticated USING (app.has_permission(organisation_id, 'integrations.read'));

-- Decided entries never change again; nothing is deleted.
CREATE FUNCTION app.integration_missing_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Disappeared records are kept' USING ERRCODE = 'QM022'; END IF;
  IF OLD.status NOT IN ('listed', 'held') THEN RAISE EXCEPTION 'This record has already been decided' USING ERRCODE = 'QM022'; END IF;
  IF (NEW.organisation_id, NEW.connection_id, NEW.entity_type, NEW.external_id, NEW.internal_id, NEW.detected_run_id)
     IS DISTINCT FROM (OLD.organisation_id, OLD.connection_id, OLD.entity_type, OLD.external_id, OLD.internal_id, OLD.detected_run_id) THEN
    RAISE EXCEPTION 'Only the decision on a disappeared record can change' USING ERRCODE = 'QM022';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER integration_missing_records_guard BEFORE UPDATE OR DELETE ON public.integration_missing_records FOR EACH ROW EXECUTE FUNCTION app.integration_missing_guard();

ALTER TABLE public.integration_sync_runs ADD COLUMN missing jsonb;

-- The table behind each kind of record that has Active.
CREATE FUNCTION app.integration_active_table(p_entity text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE p_entity WHEN 'supplier' THEN 'public.suppliers' WHEN 'customer' THEN 'public.customers' WHEN 'part' THEN 'public.parts'
                       WHEN 'machine' THEN 'public.machines' WHEN 'employee' THEN 'public."Employees"' WHEN 'gauge_type' THEN 'public.gauge_types' END
$$;

CREATE FUNCTION app.integration_record_active(p_entity text, p_org uuid, p_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v boolean;
BEGIN
  IF app.integration_active_table(p_entity) IS NULL THEN RETURN NULL; END IF;
  EXECUTE format('SELECT active FROM %s WHERE id = $1 AND organisation_id = $2', app.integration_active_table(p_entity)) INTO v USING p_id, p_org;
  RETURN v;
END $$;

CREATE FUNCTION app.integration_make_inactive(p_entity text, p_org uuid, p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF app.integration_active_table(p_entity) IS NULL THEN RAISE EXCEPTION 'These records cannot be made inactive' USING ERRCODE = 'QM022'; END IF;
  EXECUTE format('UPDATE %s SET active = false WHERE id = $1 AND organisation_id = $2 AND active', app.integration_active_table(p_entity)) USING p_id, p_org;
END $$;

-- After a full read that finished: list what the source no longer sent, make it inactive when asked and safe, and mark what came back.
CREATE FUNCTION app.integration_detect_missing(p_run uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.integration_sync_runs%ROWTYPE; v_mode text; v_total integer; v_missing integer; v_returned integer; v_hold boolean; v_reason text;
        v_ext text[]; v_int uuid[]; k integer; n_listed integer := 0; n_held integer := 0; n_deactivated integer := 0; v_summary jsonb;
BEGIN
  SELECT * INTO r FROM public.integration_sync_runs WHERE id = p_run;
  v_mode := coalesce(r.settings ->> 'onMissing', 'nothing');
  IF r.kind <> 'full' OR NOT r.fetch_done OR r.status NOT IN ('succeeded', 'partial') OR NOT app.integration_entity_tracks_missing(r.entity_type) THEN RETURN NULL; END IF;

  -- Records that came back in this read.
  UPDATE public.integration_missing_records mr SET status = 'returned', returned_run_id = r.id, updated_at = now()
   WHERE mr.connection_id = r.connection_id AND mr.entity_type = r.entity_type AND mr.status IN ('listed', 'held')
     AND EXISTS (SELECT 1 FROM public.integration_inbox i WHERE i.run_id = r.id AND i.external_id = mr.external_id);
  GET DIAGNOSTICS v_returned = ROW_COUNT;
  IF v_mode = 'nothing' THEN
    v_summary := CASE WHEN v_returned > 0 THEN jsonb_build_object('returned', v_returned) END;
    UPDATE public.integration_sync_runs SET missing = v_summary WHERE id = r.id;
    RETURN v_summary;
  END IF;

  -- A row rejected without an identifier could be any record, so nothing is called missing from this read.
  IF EXISTS (SELECT 1 FROM public.integration_inbox i WHERE i.run_id = r.id AND i.external_id IS NULL) THEN
    v_summary := jsonb_build_object('returned', v_returned, 'skipped', 'Some rows had no identifier, so Fortress cannot tell which records are missing from this read');
    UPDATE public.integration_sync_runs SET missing = v_summary WHERE id = r.id;
    RETURN v_summary;
  END IF;

  SELECT count(*) INTO v_total FROM public.integration_external_records er WHERE er.connection_id = r.connection_id AND er.entity_type = r.entity_type;
  SELECT coalesce(array_agg(er.external_id ORDER BY er.external_id), '{}'), coalesce(array_agg(er.internal_id ORDER BY er.external_id), '{}')
    INTO v_ext, v_int
    FROM public.integration_external_records er
   WHERE er.connection_id = r.connection_id AND er.entity_type = r.entity_type
     AND NOT EXISTS (SELECT 1 FROM public.integration_inbox i WHERE i.run_id = r.id AND i.external_id = er.external_id)
     AND NOT EXISTS (SELECT 1 FROM public.integration_missing_records mr WHERE mr.connection_id = r.connection_id AND mr.entity_type = r.entity_type
                       AND mr.external_id = er.external_id AND mr.status IN ('listed', 'held'))
     -- A person decided to keep it active: not asked about again until the source has sent it since.
     AND NOT EXISTS (SELECT 1 FROM public.integration_missing_records mr WHERE mr.connection_id = r.connection_id AND mr.entity_type = r.entity_type
                       AND mr.external_id = er.external_id AND mr.status = 'kept'
                       AND mr.decided_at > coalesce((SELECT max(i.created_at) FROM public.integration_inbox i JOIN public.integration_sync_runs ir ON ir.id = i.run_id
                                                     WHERE i.connection_id = r.connection_id AND i.entity_type = r.entity_type AND i.external_id = er.external_id
                                                       AND ir.kind <> 'preview'), '-infinity'))
     AND coalesce(app.integration_record_active(r.entity_type, r.organisation_id, er.internal_id), true);
  v_missing := cardinality(v_ext);

  -- The guard (F1): more than 20% of this kind's imported records at once is held for a person.
  v_hold := v_mode = 'deactivate' AND v_missing * 5 > v_total;
  v_reason := CASE WHEN v_hold THEN format('%s of %s imported records would be made inactive at once (more than 20%%): confirm them', v_missing, v_total) END;
  FOR k IN 1 .. v_missing LOOP
    IF v_mode = 'deactivate' AND NOT v_hold THEN
      PERFORM app.integration_make_inactive(r.entity_type, r.organisation_id, v_int[k]);
      INSERT INTO public.integration_missing_records (organisation_id, connection_id, entity_type, external_id, internal_id, detected_run_id, status, decided_at)
      VALUES (r.organisation_id, r.connection_id, r.entity_type, v_ext[k], v_int[k], r.id, 'deactivated', now());
      n_deactivated := n_deactivated + 1;
    ELSE
      INSERT INTO public.integration_missing_records (organisation_id, connection_id, entity_type, external_id, internal_id, detected_run_id, status, reason)
      VALUES (r.organisation_id, r.connection_id, r.entity_type, v_ext[k], v_int[k], r.id, CASE WHEN v_mode = 'deactivate' THEN 'held' ELSE 'listed' END, v_reason);
      IF v_mode = 'deactivate' THEN n_held := n_held + 1; ELSE n_listed := n_listed + 1; END IF;
    END IF;
  END LOOP;
  v_summary := jsonb_build_object('listed', n_listed, 'held', n_held, 'deactivated', n_deactivated, 'returned', v_returned, 'imported', v_total);
  IF v_hold THEN v_summary := v_summary || jsonb_build_object('heldReason', v_reason); END IF;
  UPDATE public.integration_sync_runs SET missing = v_summary WHERE id = r.id;
  RETURN v_summary;
END $$;

-- A person decides on listed or held records: make them inactive, or keep them active with a reason.
CREATE FUNCTION app.decide_missing_records(p_ids uuid[], p_deactivate boolean, p_note text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE m public.integration_missing_records%ROWTYPE; n integer := 0; v_note text := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN RAISE EXCEPTION 'Choose the records' USING ERRCODE = 'QM022'; END IF;
  IF cardinality(p_ids) > 500 THEN RAISE EXCEPTION 'Decide at most 500 records at a time' USING ERRCODE = 'QM022'; END IF;
  IF p_deactivate IS NULL THEN RAISE EXCEPTION 'Say whether to make them inactive or keep them' USING ERRCODE = 'QM022'; END IF;
  IF NOT p_deactivate AND (v_note IS NULL OR length(v_note) < 3) THEN RAISE EXCEPTION 'Say why they stay active' USING ERRCODE = 'QM022'; END IF;
  IF length(v_note) > 1000 THEN RAISE EXCEPTION 'Keep the note to 1,000 characters' USING ERRCODE = 'QM022'; END IF;
  FOR m IN SELECT * FROM public.integration_missing_records WHERE id = ANY (p_ids) ORDER BY id FOR UPDATE LOOP
    IF NOT app.is_member(m.organisation_id) THEN RAISE EXCEPTION 'Record not found' USING ERRCODE = 'P0002'; END IF;
    IF NOT app.has_permission(m.organisation_id, 'integrations.run') OR NOT app.integration_may_write(m.organisation_id, m.entity_type) THEN
      RAISE EXCEPTION 'Deciding needs the permission to run imports and to edit these records' USING ERRCODE = '42501';
    END IF;
    IF m.status NOT IN ('listed', 'held') THEN RAISE EXCEPTION 'This record has already been decided' USING ERRCODE = 'QM022'; END IF;
    IF p_deactivate THEN
      IF NOT app.integration_entity_has_active(m.entity_type) THEN RAISE EXCEPTION 'These records cannot be made inactive' USING ERRCODE = 'QM022'; END IF;
      PERFORM app.integration_make_inactive(m.entity_type, m.organisation_id, m.internal_id);
    END IF;
    UPDATE public.integration_missing_records SET status = CASE WHEN p_deactivate THEN 'deactivated' ELSE 'kept' END,
           decided_at = clock_timestamp(), decided_by = auth.uid(), decision_note = v_note, updated_at = now()
     WHERE id = m.id;
    n := n + 1;
  END LOOP;
  IF n < cardinality(p_ids) THEN RAISE EXCEPTION 'Record not found' USING ERRCODE = 'P0002'; END IF;
  RETURN n;
END $$;

-- Finishing a run now also looks for records that disappeared (full reads only).
CREATE OR REPLACE FUNCTION app.system_finish_integration_run(p_org uuid, p_run uuid, p_owner uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.integration_sync_runs%ROWTYPE; v_status text;
BEGIN
  r := app.integration_run_for_system(p_org, p_run, p_owner);
  IF NOT r.fetch_done THEN RAISE EXCEPTION 'The import has not fetched everything yet' USING ERRCODE = 'QM022'; END IF;
  IF r.kind <> 'preview' AND EXISTS (SELECT 1 FROM public.integration_inbox i
      WHERE (r.kind = 'retry' AND i.retry_run_id = r.id AND i.status = 'failed') OR (r.kind <> 'retry' AND i.run_id = r.id AND i.status = 'staged')) THEN
    RAISE EXCEPTION 'Rows are still waiting to be applied' USING ERRCODE = 'QM022';
  END IF;
  v_status := CASE
    WHEN r.failed + r.rejected > 0 AND r.created + r.updated + r.unchanged + r.skipped = 0 THEN 'failed'
    WHEN r.failed > 0 OR r.rejected > 0 THEN 'partial'
    ELSE 'succeeded' END;
  UPDATE public.integration_sync_runs SET status = v_status, finished_at = now(), lease_owner = NULL, lease_until = NULL, updated_at = now() WHERE id = r.id;
  IF r.kind IN ('full', 'incremental') THEN
    INSERT INTO public.integration_sync_cursors AS k (organisation_id, connection_id, entity_type, cursor, run_id)
    VALUES (r.organisation_id, r.connection_id, r.entity_type, r.cursor_next, r.id)
    ON CONFLICT (connection_id, entity_type) DO UPDATE SET cursor = EXCLUDED.cursor, run_id = EXCLUDED.run_id, updated_at = now()
      WHERE k.cursor IS DISTINCT FROM EXCLUDED.cursor;
  END IF;
  IF r.kind = 'full' THEN PERFORM app.integration_detect_missing(r.id); END IF;
  RETURN v_status;
END $$;

-- ---------------------------------------------------------------------------
-- Ignoring rejected and failed rows (F2)
-- ---------------------------------------------------------------------------
ALTER TABLE public.integration_inbox DROP CONSTRAINT integration_inbox_status_check;
ALTER TABLE public.integration_inbox ADD CONSTRAINT integration_inbox_status_check
  CHECK (status IN ('staged', 'previewed', 'unchanged', 'skipped', 'applied', 'rejected', 'failed', 'superseded', 'ignored'));
ALTER TABLE public.integration_inbox
  ADD COLUMN ignored_from text CHECK (ignored_from IS NULL OR ignored_from IN ('rejected', 'failed')),
  ADD COLUMN ignored_at timestamptz,
  ADD COLUMN ignored_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  ADD COLUMN ignore_reason text CHECK (ignore_reason IS NULL OR length(ignore_reason) BETWEEN 3 AND 1000),
  ADD CONSTRAINT integration_inbox_ignored CHECK ((status = 'ignored') = (ignored_from IS NOT NULL AND ignore_reason IS NOT NULL));

CREATE FUNCTION app.ignore_integration_rows(p_connection uuid, p_rows uuid[], p_reason text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.integration_connections%ROWTYPE; n integer; v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  c := app.integration_connection_for_write(p_connection, 'integrations.run');
  IF p_rows IS NULL OR cardinality(p_rows) = 0 THEN RAISE EXCEPTION 'Choose the rows' USING ERRCODE = 'QM022'; END IF;
  IF cardinality(p_rows) > 500 THEN RAISE EXCEPTION 'Ignore at most 500 rows at a time' USING ERRCODE = 'QM022'; END IF;
  IF length(v_reason) < 3 OR length(v_reason) > 1000 THEN RAISE EXCEPTION 'Say why these rows are ignored' USING ERRCODE = 'QM022'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_rows) x(id) WHERE NOT EXISTS (
      SELECT 1 FROM public.integration_inbox i WHERE i.id = x.id AND i.connection_id = c.id AND i.status IN ('rejected', 'failed'))) THEN
    RAISE EXCEPTION 'Only rejected or failed rows of this connection can be ignored' USING ERRCODE = 'QM022';
  END IF;
  UPDATE public.integration_inbox SET ignored_from = status, status = 'ignored', ignored_at = now(), ignored_by = auth.uid(), ignore_reason = v_reason,
         retry_run_id = NULL, updated_at = now()
   WHERE id = ANY (p_rows) AND connection_id = c.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

CREATE FUNCTION app.restore_integration_rows(p_connection uuid, p_rows uuid[]) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.integration_connections%ROWTYPE; n integer;
BEGIN
  c := app.integration_connection_for_write(p_connection, 'integrations.run');
  IF p_rows IS NULL OR cardinality(p_rows) = 0 THEN RAISE EXCEPTION 'Choose the rows' USING ERRCODE = 'QM022'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_rows) x(id) WHERE NOT EXISTS (
      SELECT 1 FROM public.integration_inbox i WHERE i.id = x.id AND i.connection_id = c.id AND i.status = 'ignored')) THEN
    RAISE EXCEPTION 'Only ignored rows of this connection can be brought back' USING ERRCODE = 'QM022';
  END IF;
  UPDATE public.integration_inbox SET status = ignored_from, ignored_from = NULL, ignored_at = NULL, ignored_by = NULL, ignore_reason = NULL, updated_at = now()
   WHERE id = ANY (p_rows) AND connection_id = c.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- The newest copy of each source record (and every row with no identifier from the latest finished run) that still needs a person.
CREATE FUNCTION app.integration_rows_needing_action(p_connection uuid, p_entity text) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT x.id FROM (
    SELECT DISTINCT ON (i.external_id) i.id, i.status
      FROM public.integration_inbox i
      JOIN public.integration_sync_runs r ON r.id = i.run_id AND r.kind <> 'preview'
     WHERE i.connection_id = p_connection AND i.entity_type = p_entity AND i.external_id IS NOT NULL
       AND i.status IN ('applied', 'unchanged', 'skipped', 'rejected', 'failed', 'ignored')
     ORDER BY i.external_id, i.created_at DESC) x
   WHERE x.status IN ('rejected', 'failed')
  UNION ALL
  SELECT i.id FROM public.integration_inbox i
   WHERE i.connection_id = p_connection AND i.entity_type = p_entity AND i.external_id IS NULL AND i.status = 'rejected'
     AND i.run_id = (SELECT r.id FROM public.integration_sync_runs r WHERE r.connection_id = p_connection AND r.entity_type = p_entity
                       AND r.kind IN ('full', 'incremental') AND r.status IN ('succeeded', 'partial', 'failed') ORDER BY r.requested_at DESC LIMIT 1)
$$;

-- ---------------------------------------------------------------------------
-- Health (monitoring)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.integration_health(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE out jsonb;
BEGIN
  IF NOT app.is_member(p_org) THEN RAISE EXCEPTION 'Organisation not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(p_org, 'integrations.read') THEN RAISE EXCEPTION 'You are not allowed to see integrations' USING ERRCODE = '42501'; END IF;
  SELECT coalesce(jsonb_agg(row ORDER BY row ->> 'connectionName', row ->> 'entityType'), '[]'::jsonb) INTO out FROM (
    SELECT jsonb_build_object(
      'connectionId', k.connection_id, 'connectionName', c.name, 'connectionStatus', c.status, 'providerKind', p.kind, 'entityType', k.entity_type,
      'schedule', coalesce(s.schedule, 'manual'), 'onMissing', coalesce(s.on_missing, 'nothing'),
      'template', CASE WHEN t.id IS NOT NULL THEN jsonb_build_object('id', t.id, 'name', t.name, 'version', t.current_version, 'archived', t.archived_at IS NOT NULL) END,
      'scheduledBy', s.schedule_set_by, 'lastScheduledAt', s.last_scheduled_at, 'scheduleProblem', s.last_schedule_problem,
      'lastRun', (SELECT jsonb_build_object('id', r.id, 'kind', r.kind, 'trigger', r.trigger, 'status', r.status, 'requestedAt', r.requested_at, 'finishedAt', r.finished_at,
                                           'errorSummary', r.error_summary, 'nextAttemptAt', CASE WHEN r.status IN ('queued', 'running') THEN r.next_attempt_at END)
                    FROM public.integration_sync_runs r WHERE r.connection_id = k.connection_id AND r.entity_type = k.entity_type AND r.kind <> 'preview'
                    ORDER BY r.requested_at DESC LIMIT 1),
      'lastSuccessAt', (SELECT max(r.finished_at) FROM public.integration_sync_runs r WHERE r.connection_id = k.connection_id AND r.entity_type = k.entity_type
                          AND r.kind IN ('full', 'incremental') AND r.status IN ('succeeded', 'partial')),
      'failedInARow', (SELECT count(*) FROM (
          SELECT sum(CASE WHEN r.status = 'failed' THEN 0 ELSE 1 END) OVER (ORDER BY r.requested_at DESC) AS ok_seen
            FROM public.integration_sync_runs r WHERE r.connection_id = k.connection_id AND r.entity_type = k.entity_type
             AND r.kind IN ('full', 'incremental') AND r.status IN ('succeeded', 'partial', 'failed')) z WHERE z.ok_seen = 0)::int,
      'rowsNeedingAction', (SELECT count(*) FROM app.integration_rows_needing_action(k.connection_id, k.entity_type))::int,
      'missingWaiting', (SELECT count(*) FROM public.integration_missing_records m WHERE m.connection_id = k.connection_id AND m.entity_type = k.entity_type AND m.status IN ('listed', 'held'))::int,
      'missingHeld', (SELECT count(*) FROM public.integration_missing_records m WHERE m.connection_id = k.connection_id AND m.entity_type = k.entity_type AND m.status = 'held')::int,
      'conflictsOpen', (SELECT count(*) FROM public.integration_conflicts f WHERE f.connection_id = k.connection_id AND f.entity_type = k.entity_type AND f.status = 'open')::int
    ) AS row
    FROM (SELECT connection_id, entity_type FROM public.integration_import_settings WHERE organisation_id = p_org
          UNION SELECT connection_id, entity_type FROM public.integration_sync_runs WHERE organisation_id = p_org AND kind <> 'preview') k
    JOIN public.integration_connections c ON c.id = k.connection_id AND c.status <> 'retired'
    JOIN public.integration_providers p ON p.id = c.provider_id
    LEFT JOIN public.integration_import_settings s ON s.connection_id = k.connection_id AND s.entity_type = k.entity_type
    LEFT JOIN public.integration_templates t ON t.id = s.template_id
  ) q;
  RETURN out;
END $$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app.integration_entity_tracks_missing(text), app.integration_active_table(text), app.integration_record_active(text, uuid, uuid),
  app.integration_make_inactive(text, uuid, uuid), app.integration_detect_missing(uuid), app.integration_missing_guard(),
  app.integration_rows_needing_action(uuid, text), app.system_schedule_integration_runs(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.system_schedule_integration_runs(date) TO qms_api;
REVOKE ALL ON FUNCTION app.set_integration_import_settings(uuid, text, jsonb), app.decide_missing_records(uuid[], boolean, text),
  app.ignore_integration_rows(uuid, uuid[], text), app.restore_integration_rows(uuid, uuid[]), app.integration_health(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.set_integration_import_settings(uuid, text, jsonb), app.decide_missing_records(uuid[], boolean, text),
  app.ignore_integration_rows(uuid, uuid[], text), app.restore_integration_rows(uuid, uuid[]), app.integration_health(uuid) TO authenticated;
