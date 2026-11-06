-- SPC alerts (PC11): a control-chart signal on a newly recorded point becomes a stored alert and an in-app notification.
--
-- Design
--  * Alerts are raised by the API when a sample is saved (no background worker): it evaluates the charts of the characteristics
--    just measured and passes the signals on the new points to app.raise_spc_alerts(). One alert per characteristic, chart
--    variant, rule and point (for subgroup charts: inspection), so saving again or re-reading a chart never duplicates one.
--  * An alert is a record, not a verdict: it never raises an NC. Rows are written only by the two functions below (no table
--    INSERT/UPDATE grants). Acknowledging needs spc.manage and a note; an acknowledged alert and its note are frozen; alerts are
--    never deleted.
--  * Notifications reuse the audit-driven mechanism: event type spc_alerts.created (on by default for holders of spc.manage).
--    As for every notification, the person whose save raised the alert is not told about their own action.

CREATE TABLE public.spc_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  part_id uuid NOT NULL,
  part_number text NOT NULL,
  characteristic_key text NOT NULL CHECK (length(characteristic_key) BETWEEN 1 AND 60),
  characteristic_name text NOT NULL,
  operation_code text NOT NULL CHECK (length(operation_code) BETWEEN 1 AND 40),
  variant text NOT NULL CHECK (variant IN ('imr', 'xbar_r', 'p', 'c', 'u')),
  rule text NOT NULL CHECK (rule IN ('we1', 'we2', 'we3', 'we4', 'range')),
  side text CHECK (side IN ('above', 'below')),
  point_at timestamptz NOT NULL,
  summary text NOT NULL CHECK (length(summary) BETWEEN 1 AND 300),
  inspection_record_id uuid,
  inspection_reference text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged')),
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  acknowledgement_note text CHECK (acknowledgement_note IS NULL OR length(acknowledgement_note) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT spc_alerts_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT spc_alerts_part_fkey FOREIGN KEY (part_id, organisation_id) REFERENCES public.parts (id, organisation_id),
  CONSTRAINT spc_alerts_inspection_fkey FOREIGN KEY (inspection_record_id, organisation_id) REFERENCES public.inspection_records (id, organisation_id),
  CONSTRAINT spc_alerts_acknowledged CHECK ((status = 'open') = (acknowledged_at IS NULL AND acknowledged_by IS NULL AND acknowledgement_note IS NULL)
                                             OR (status = 'acknowledged' AND acknowledged_at IS NOT NULL AND acknowledgement_note IS NOT NULL))
);
-- One alert per measured point on I-MR and X-bar/R charts; one per inspection and rule on the subgroup charts (P, C, U), whose
-- point (the inspection's checks) grows, and moves in time, as more of them are recorded.
CREATE UNIQUE INDEX spc_alerts_point_key ON public.spc_alerts
  (organisation_id, part_id, characteristic_key, operation_code, variant, rule, point_at) WHERE variant IN ('imr', 'xbar_r');
CREATE UNIQUE INDEX spc_alerts_inspection_key ON public.spc_alerts
  (organisation_id, part_id, characteristic_key, operation_code, variant, rule, inspection_record_id)
  WHERE variant IN ('p', 'c', 'u') AND inspection_record_id IS NOT NULL;
CREATE INDEX spc_alerts_status_idx ON public.spc_alerts (organisation_id, status, created_at DESC);

CREATE FUNCTION app.spc_alert_frozen() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'An SPC alert is never deleted' USING ERRCODE = 'QM008';
  END IF;
  IF OLD.status <> 'open'
     OR (to_jsonb(NEW) - ARRAY['status', 'acknowledged_at', 'acknowledged_by', 'acknowledgement_note', 'updated_at', 'updated_by'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'acknowledged_at', 'acknowledged_by', 'acknowledgement_note', 'updated_at', 'updated_by']) THEN
    RAISE EXCEPTION 'An SPC alert can only be acknowledged, once' USING ERRCODE = 'QM008';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER spc_alerts_stamp BEFORE INSERT ON public.spc_alerts FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER spc_alerts_frozen BEFORE UPDATE OR DELETE ON public.spc_alerts FOR EACH ROW EXECUTE FUNCTION app.spc_alert_frozen();
CREATE TRIGGER spc_alerts_touch BEFORE UPDATE ON public.spc_alerts FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER spc_alerts_org_immutable BEFORE UPDATE ON public.spc_alerts FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.spc_alerts
  FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');

ALTER TABLE public.spc_alerts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.spc_alerts FROM anon, authenticated;
GRANT SELECT ON public.spc_alerts TO authenticated;
CREATE POLICY spc_alerts_select ON public.spc_alerts FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'spc.read'));

-- Raised by the API for signals on points just recorded; the caller must be recording inspections. Duplicates are ignored.
-- p_alerts: [{characteristicKey, characteristicName, operationCode, variant, rule, side, pointAt, summary, inspectionId, inspectionReference}]
CREATE FUNCTION app.raise_spc_alerts(p_organisation_id uuid, p_part_id uuid, p_alerts jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_part_number text; v_count integer;
BEGIN
  IF NOT app.has_permission(p_organisation_id, 'inspection.record') THEN
    RAISE EXCEPTION 'Not allowed to record inspections' USING ERRCODE = '42501';
  END IF;
  SELECT part_number INTO v_part_number FROM public.parts WHERE id = p_part_id AND organisation_id = p_organisation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Part not found' USING ERRCODE = 'QM008'; END IF;
  IF jsonb_typeof(p_alerts) <> 'array' OR jsonb_array_length(p_alerts) > 200 THEN
    RAISE EXCEPTION 'Give up to 200 alerts as an array' USING ERRCODE = 'QM008';
  END IF;
  INSERT INTO public.spc_alerts (organisation_id, part_id, part_number, characteristic_key, characteristic_name, operation_code, variant, rule, side,
                                 point_at, summary, inspection_record_id, inspection_reference)
  SELECT p_organisation_id, p_part_id, v_part_number, a."characteristicKey", a."characteristicName", a."operationCode", a.variant, a.rule, a.side,
         a."pointAt", a.summary, a."inspectionId", a."inspectionReference"
  FROM jsonb_to_recordset(p_alerts) AS a("characteristicKey" text, "characteristicName" text, "operationCode" text, variant text, rule text, side text,
                                         "pointAt" timestamptz, summary text, "inspectionId" uuid, "inspectionReference" text)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

-- Somebody has looked at it and says what was done.
CREATE FUNCTION app.acknowledge_spc_alert(p_id uuid, p_note text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid; v_status text;
BEGIN
  SELECT organisation_id, status INTO v_org, v_status FROM public.spc_alerts WHERE id = p_id;
  IF NOT FOUND OR NOT app.has_permission(v_org, 'spc.read') THEN
    RAISE EXCEPTION 'SPC alert not found' USING ERRCODE = 'QM008';
  END IF;
  IF NOT app.has_permission(v_org, 'spc.manage') THEN
    RAISE EXCEPTION 'Not allowed to acknowledge SPC alerts' USING ERRCODE = '42501';
  END IF;
  IF v_status <> 'open' THEN RAISE EXCEPTION 'This alert is already acknowledged' USING ERRCODE = 'QM008'; END IF;
  IF p_note IS NULL OR length(btrim(p_note)) = 0 THEN RAISE EXCEPTION 'Say what was done about it' USING ERRCODE = 'QM008'; END IF;
  UPDATE public.spc_alerts SET status = 'acknowledged', acknowledged_at = now(), acknowledged_by = auth.uid(), acknowledgement_note = btrim(p_note)
   WHERE id = p_id;
END $$;

REVOKE ALL ON FUNCTION app.spc_alert_frozen(), app.raise_spc_alerts(uuid, uuid, jsonb), app.acknowledge_spc_alert(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.raise_spc_alerts(uuid, uuid, jsonb), app.acknowledge_spc_alert(uuid, text) TO authenticated;

-- Notification event types: raised (on for quality engineers and up by default), acknowledged (off by default).
INSERT INTO public.notification_event_types
  (key, entity_type, action, group_name, entity_label, description, permission_code, default_on, default_permission_code, label_fields, display_order)
VALUES
  ('spc_alerts.created', 'spc_alerts', 'created', 'Process control', 'SPC alert', 'SPC alert raised', 'spc.read', true, 'spc.manage',
   ARRAY['part_number', 'characteristic_name', 'summary'], 43),
  ('spc_alerts.updated', 'spc_alerts', 'updated', 'Process control', 'SPC alert', 'SPC alert acknowledged', 'spc.read', false, NULL,
   ARRAY['part_number', 'characteristic_name'], 43);
