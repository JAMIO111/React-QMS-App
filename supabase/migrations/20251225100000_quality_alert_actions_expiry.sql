-- Quality alerts: actions as line items, expiry and reopening with a history.
--
--  1. quality_alert_actions: what people must do, one row per action, each optionally for a department and/or a machine. Replaced as a whole on a draft by
--     app.set_quality_alert_actions, copied by a revision, frozen once issued. Issuing needs at least one. The old single "required_action" text is kept as it was
--     (no longer written or required); every alert that had one got it as its first action.
--  2. quality_alert_events: append-only history of expiries and reopenings (when, who, old and new expiry, reason). Written only by functions.
--  3. app.expire_quality_alerts logs each expiry; app.system_expire_quality_alerts() does the same for every organisation (API login only, run by a daily job);
--     app.reopen_quality_alert(alert, new expiry, reason) puts an expired alert back in force with a new expiry date (documentation.issue).

CREATE TABLE public.quality_alert_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  alert_id uuid NOT NULL,
  position integer NOT NULL CHECK (position >= 1),
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 2000),
  department_id uuid,
  machine_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT quality_alert_actions_alert_fkey FOREIGN KEY (alert_id, organisation_id) REFERENCES public.quality_alerts (id, organisation_id) ON DELETE CASCADE,
  CONSTRAINT quality_alert_actions_department_fkey FOREIGN KEY (department_id, organisation_id) REFERENCES public.departments (id, organisation_id),
  CONSTRAINT quality_alert_actions_machine_fkey FOREIGN KEY (machine_id, organisation_id) REFERENCES public.machines (id, organisation_id),
  CONSTRAINT quality_alert_actions_position_key UNIQUE (alert_id, position)
);
CREATE INDEX quality_alert_actions_alert_idx ON public.quality_alert_actions (alert_id);

CREATE TABLE public.quality_alert_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  alert_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('expired', 'reopened')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,   -- empty when the system expired it
  previous_expiry date,
  new_expiry date,
  reason text CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 2000),
  CONSTRAINT quality_alert_events_alert_fkey FOREIGN KEY (alert_id, organisation_id) REFERENCES public.quality_alerts (id, organisation_id) ON DELETE CASCADE,
  CONSTRAINT quality_alert_events_reopen_complete CHECK (kind <> 'reopened' OR (new_expiry IS NOT NULL AND reason IS NOT NULL AND actor_id IS NOT NULL))
);
CREATE INDEX quality_alert_events_alert_idx ON public.quality_alert_events (alert_id, occurred_at);

CREATE TRIGGER quality_alert_actions_stamp BEFORE INSERT ON public.quality_alert_actions FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.quality_alert_actions FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.quality_alert_events FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');

ALTER TABLE public.quality_alert_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quality_alert_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.quality_alert_actions, public.quality_alert_events FROM anon, authenticated;
GRANT SELECT ON public.quality_alert_actions, public.quality_alert_events TO authenticated;
CREATE POLICY quality_alert_actions_select ON public.quality_alert_actions FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.quality_alerts a WHERE a.id = alert_id));
CREATE POLICY quality_alert_events_select ON public.quality_alert_events FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.quality_alerts a WHERE a.id = alert_id));

-- Every existing alert's required-action text becomes its first action.
INSERT INTO public.quality_alert_actions (organisation_id, alert_id, position, description)
SELECT organisation_id, id, 1, btrim(required_action) FROM public.quality_alerts WHERE required_action IS NOT NULL AND length(btrim(required_action)) > 0;

-- Issued alerts no longer need the old text (they need actions, checked when issuing).
ALTER TABLE public.quality_alerts DROP CONSTRAINT quality_alerts_issued_complete;
ALTER TABLE public.quality_alerts ADD CONSTRAINT quality_alerts_issued_complete
  CHECK (status = 'draft' OR (description IS NOT NULL AND effective_date IS NOT NULL AND issued_at IS NOT NULL));

-- ---------------------------------------------------------------------------
-- The frozen-content rule lets the expiry date move only inside app.reopen_quality_alert.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.quality_alert_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_free text[] := ARRAY['status', 'withdrawn_at', 'withdrawn_by', 'withdrawn_reason', 'updated_at', 'updated_by'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.revision = 1 THEN
      NEW.alert_number := app.next_quality_alert_number(NEW.organisation_id);
      NEW.reference := 'QA-' || lpad(NEW.alert_number::text, 3, '0');
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.alert_number <> OLD.alert_number OR NEW.reference <> OLD.reference OR NEW.revision <> OLD.revision
     OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id THEN
    RAISE EXCEPTION 'The number and revision of a quality alert cannot change' USING ERRCODE = 'QM012';
  END IF;
  IF current_setting('app.quality_alert_reopen', true) = 'on' THEN v_free := v_free || ARRAY['expiry_date']; END IF;
  IF OLD.status <> 'draft' AND (to_jsonb(NEW) - v_free) IS DISTINCT FROM (to_jsonb(OLD) - v_free) THEN
    RAISE EXCEPTION 'An issued quality alert cannot be edited; issue a revision instead' USING ERRCODE = 'QM012';
  END IF;
  IF OLD.status = 'draft' AND NEW.status <> 'draft' AND (NEW.issued_at IS NULL OR NEW.issued_by IS NULL) THEN
    RAISE EXCEPTION 'A quality alert is issued with the issue action' USING ERRCODE = 'QM012';
  END IF;
  IF OLD.status <> 'draft' AND NEW.status = 'draft' THEN
    RAISE EXCEPTION 'An issued quality alert cannot go back to draft' USING ERRCODE = 'QM012';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- Actions: replaced as a whole on a draft.
-- p_actions: [{"description": text, "departmentId": uuid?, "machineId": uuid?}] in the order wanted.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.set_quality_alert_actions(p_id uuid, p_actions jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.quality_alerts%ROWTYPE; e record;
BEGIN
  a := app.quality_alert_for_update(p_id, 'documentation.manage', true);
  IF jsonb_typeof(p_actions) <> 'array' THEN RAISE EXCEPTION 'Actions must be a list' USING ERRCODE = 'QM012'; END IF;
  IF jsonb_array_length(p_actions) > 50 THEN RAISE EXCEPTION 'An alert can have at most 50 actions' USING ERRCODE = 'QM012'; END IF;
  FOR e IN SELECT v FROM jsonb_array_elements(p_actions) v LOOP
    IF jsonb_typeof(e.v) <> 'object' OR coalesce(btrim(e.v ->> 'description'), '') = '' THEN
      RAISE EXCEPTION 'Every action needs a description' USING ERRCODE = 'QM012';
    END IF;
  END LOOP;
  DELETE FROM public.quality_alert_actions WHERE alert_id = p_id;
  INSERT INTO public.quality_alert_actions (organisation_id, alert_id, position, description, department_id, machine_id)
    SELECT a.organisation_id, p_id, x.ord::int, btrim(x.v ->> 'description'), (x.v ->> 'departmentId')::uuid, (x.v ->> 'machineId')::uuid
      FROM jsonb_array_elements(p_actions) WITH ORDINALITY AS x(v, ord);
  UPDATE public.quality_alerts SET updated_at = now() WHERE id = p_id;
END $$;

-- ---------------------------------------------------------------------------
-- Issuing needs at least one action; a revision copies the actions.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.issue_quality_alert(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.quality_alerts%ROWTYPE;
BEGIN
  a := app.quality_alert_for_update(p_id, 'documentation.issue', true);
  IF a.description IS NULL THEN
    RAISE EXCEPTION 'Describe the issue before issuing' USING ERRCODE = 'QM012';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.quality_alert_actions WHERE alert_id = p_id) THEN
    RAISE EXCEPTION 'Add at least one action people must take before issuing' USING ERRCODE = 'QM012';
  END IF;
  IF a.effective_date IS NULL THEN
    RAISE EXCEPTION 'Give an effective date before issuing' USING ERRCODE = 'QM012';
  END IF;
  IF a.severity IN ('high', 'critical') AND a.acknowledge_by IS NULL THEN
    RAISE EXCEPTION 'High and critical alerts need an acknowledge-by date' USING ERRCODE = 'QM012';
  END IF;
  IF a.acknowledge_by IS NOT NULL AND a.acknowledge_by < a.effective_date THEN
    RAISE EXCEPTION 'The acknowledge-by date cannot be before the effective date' USING ERRCODE = 'QM012';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.quality_alert_targets WHERE alert_id = p_id) THEN
    RAISE EXCEPTION 'Choose who must acknowledge this alert (a department, a role or named people)' USING ERRCODE = 'QM012';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.resolve_quality_alert_targets(p_id)) THEN
    RAISE EXCEPTION 'The people chosen reach nobody: nobody active is in those departments or holds those roles' USING ERRCODE = 'QM012';
  END IF;
  IF a.expiry_date IS NOT NULL AND a.expiry_date < current_date THEN
    RAISE EXCEPTION 'The expiry date has already passed' USING ERRCODE = 'QM012';
  END IF;
  IF a.supersedes_id IS NOT NULL THEN
    UPDATE public.quality_alerts SET status = 'superseded' WHERE id = a.supersedes_id AND status IN ('active', 'expired');
  END IF;
  UPDATE public.quality_alerts SET status = 'active', issued_at = now(), issued_by = auth.uid() WHERE id = p_id;
  INSERT INTO public.quality_alert_recipients (organisation_id, alert_id, membership_id, user_id, reached_via, alert_reference, alert_title, alert_severity)
  SELECT a.organisation_id, p_id, r.membership_id, r.user_id, r.via,
         a.reference || ' rev ' || app.revision_letter(a.revision), a.title, a.severity
    FROM app.resolve_quality_alert_targets(p_id) r;
END $$;

CREATE OR REPLACE FUNCTION app.revise_quality_alert(p_id uuid, p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.quality_alerts%ROWTYPE; v_new uuid;
BEGIN
  a := app.quality_alert_for_update(p_id, 'documentation.issue', false);
  IF a.status NOT IN ('active', 'expired') THEN
    RAISE EXCEPTION 'Only a current issued alert can be revised' USING ERRCODE = 'QM012';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'Say what is being corrected in this revision' USING ERRCODE = 'QM012';
  END IF;
  IF EXISTS (SELECT 1 FROM public.quality_alerts WHERE organisation_id = a.organisation_id AND alert_number = a.alert_number AND status = 'draft' AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'There is already a draft revision of this alert' USING ERRCODE = 'QM012';
  END IF;
  INSERT INTO public.quality_alerts (organisation_id, alert_number, reference, revision, title, category, severity, description,
                                     effective_date, expiry_date, acknowledge_by, revision_reason, supersedes_id)
  VALUES (a.organisation_id, a.alert_number, a.reference, a.revision + 1, a.title, a.category, a.severity, a.description,
          NULL, a.expiry_date, NULL, btrim(p_reason), a.id)
  RETURNING id INTO v_new;
  INSERT INTO public.quality_alert_parts (organisation_id, alert_id, part_id, part_family_id)
    SELECT organisation_id, v_new, part_id, part_family_id FROM public.quality_alert_parts WHERE alert_id = p_id;
  INSERT INTO public.quality_alert_machines (organisation_id, alert_id, machine_id)
    SELECT organisation_id, v_new, machine_id FROM public.quality_alert_machines WHERE alert_id = p_id;
  INSERT INTO public.quality_alert_operations (organisation_id, alert_id, operation_code)
    SELECT organisation_id, v_new, operation_code FROM public.quality_alert_operations WHERE alert_id = p_id;
  INSERT INTO public.quality_alert_departments (organisation_id, alert_id, department_id)
    SELECT organisation_id, v_new, department_id FROM public.quality_alert_departments WHERE alert_id = p_id;
  INSERT INTO public.quality_alert_targets (organisation_id, alert_id, department_id, role_id, membership_id)
    SELECT organisation_id, v_new, department_id, role_id, membership_id FROM public.quality_alert_targets WHERE alert_id = p_id;
  INSERT INTO public.quality_alert_actions (organisation_id, alert_id, position, description, department_id, machine_id)
    SELECT organisation_id, v_new, position, description, department_id, machine_id FROM public.quality_alert_actions WHERE alert_id = p_id;
  INSERT INTO public.quality_alert_links (organisation_id, alert_id, nonconformance_id, supplier_id, gauge_id, calibration_id)
    SELECT organisation_id, v_new, nonconformance_id, supplier_id, gauge_id, calibration_id FROM public.quality_alert_links WHERE alert_id = p_id;
  INSERT INTO public.quality_alert_attachments (organisation_id, alert_id, storage_path, file_name, content_type, size_bytes, description)
    SELECT organisation_id, v_new, storage_path, file_name, content_type, size_bytes, description
      FROM public.quality_alert_attachments WHERE alert_id = p_id AND deleted_at IS NULL;
  RETURN v_new;
END $$;

-- ---------------------------------------------------------------------------
-- Expiry (logged) and reopening
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.expire_quality_alerts(p_organisation_id uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_count integer;
BEGIN
  IF NOT app.is_member(p_organisation_id) THEN RETURN 0; END IF;
  WITH e AS (
    UPDATE public.quality_alerts SET status = 'expired'
     WHERE organisation_id = p_organisation_id AND status = 'active' AND expiry_date IS NOT NULL AND expiry_date < current_date AND deleted_at IS NULL
    RETURNING id, organisation_id, expiry_date)
  INSERT INTO public.quality_alert_events (organisation_id, alert_id, kind, previous_expiry)
  SELECT organisation_id, id, 'expired', expiry_date FROM e;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

-- The same for every organisation, for the daily job (the API login only; nobody is signed in).
CREATE FUNCTION app.system_expire_quality_alerts() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_count integer;
BEGIN
  WITH e AS (
    UPDATE public.quality_alerts SET status = 'expired'
     WHERE status = 'active' AND expiry_date IS NOT NULL AND expiry_date < current_date AND deleted_at IS NULL
    RETURNING id, organisation_id, expiry_date)
  INSERT INTO public.quality_alert_events (organisation_id, alert_id, kind, previous_expiry)
  SELECT organisation_id, id, 'expired', expiry_date FROM e;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

-- An expired alert back in force with a new expiry date; the old and new dates and the reason are kept in the history.
CREATE FUNCTION app.reopen_quality_alert(p_id uuid, p_expiry date, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.quality_alerts%ROWTYPE;
BEGIN
  a := app.quality_alert_for_update(p_id, 'documentation.issue', false);
  IF a.status <> 'expired' THEN
    RAISE EXCEPTION 'Only an expired alert can be reopened' USING ERRCODE = 'QM012';
  END IF;
  IF p_expiry IS NULL THEN
    RAISE EXCEPTION 'Give the new expiry date' USING ERRCODE = 'QM012';
  END IF;
  IF p_expiry < current_date OR p_expiry < a.effective_date THEN
    RAISE EXCEPTION 'The new expiry date must be today or later' USING ERRCODE = 'QM012';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 OR length(btrim(p_reason)) > 2000 THEN
    RAISE EXCEPTION 'Say why the alert is being reopened' USING ERRCODE = 'QM012';
  END IF;
  PERFORM set_config('app.quality_alert_reopen', 'on', true);
  UPDATE public.quality_alerts SET status = 'active', expiry_date = p_expiry WHERE id = p_id;
  PERFORM set_config('app.quality_alert_reopen', 'off', true);
  INSERT INTO public.quality_alert_events (organisation_id, alert_id, kind, actor_id, previous_expiry, new_expiry, reason)
  VALUES (a.organisation_id, p_id, 'reopened', auth.uid(), a.expiry_date, p_expiry, btrim(p_reason));
END $$;

REVOKE ALL ON FUNCTION app.set_quality_alert_actions(uuid, jsonb), app.system_expire_quality_alerts(), app.reopen_quality_alert(uuid, date, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.set_quality_alert_actions(uuid, jsonb), app.reopen_quality_alert(uuid, date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION app.system_expire_quality_alerts() TO qms_api;
