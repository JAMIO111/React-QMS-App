-- Gauges: a link to the machine a gauge is fixed to, a required gauge type, and fixes found by the calibration module audit (2026-11-27).
--
--   1. gauges.machine_id: optional, "fixed to this machine" (an in-line probe, a station torque tool). It sits beside the typed location (where it is kept),
--      it does not replace it. The machine must be active when it is chosen; when both have a site they must agree, and a gauge with no site takes the
--      machine's. Imports can set it (field "machine"), and import field locks cover it.
--   2. A gauge needs a gauge type (it brings the characteristics and the default interval). Enforced for people and imports (signed-in sessions):
--      a new gauge needs one, and a type once chosen cannot be cleared; a gauge that already has none (made before this rule) can still be edited.
--      A type chosen now must be active.
--   3. The calibration outcome now looks at the final state: an as-left value out of tolerance is a fail even when as-found was in tolerance (it used to be
--      judged on as-found alone, so a gauge adjusted out of tolerance read "pass").
--   4. The gauge follows its latest calibration only when the change is to the latest one (a new record, its outcome, date or deletion), and:
--        - editing notes or an older record no longer re-judges the gauge (it used to release a manual quarantine, or re-quarantine a manual release);
--        - when no calibration is left (the only one was deleted) the gauge is "never calibrated" again: no last or next date, and a quarantine that came from
--          a failed calibration is lifted (it used to keep the deleted record's due date and say "Failed calibration CAL-…" for a record that was gone);
--        - the gauge row is locked while it is judged, so two calibrations recorded at once cannot overwrite each other's result.
--   5. Leaving quarantine by hand needs a new status reason (the automatic release by a passing calibration does not).
--   6. Deleting something already deleted is refused (it used to overwrite who deleted it and when, and re-announce the deletion).
--   7. A department that moved sites no longer makes its gauges un-updatable: the department/site check runs when either is changed, not on every update.
--   8. gauge_characteristics: one check per gauge per template (two "apply to existing gauges" runs at once could give a gauge the same check twice).
--   9. The technician of a calibration must be an active member of the organisation (it was any user id).
--
-- Shared functions are changed by text patches or full replacements of their latest definitions (gauge_rules and calibration_after_change are replaced whole:
-- nothing later than 20260416100000 has changed them).

CREATE OR REPLACE FUNCTION pg_temp.patch_once(p_fn regprocedure, p_marker text, p_old text, p_new text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_def text := replace(pg_get_functiondef(p_fn), E'\r', ''); v_n integer;
BEGIN
  p_old := replace(p_old, E'\r', '');
  p_new := replace(p_new, E'\r', '');
  IF position(p_marker IN v_def) > 0 THEN RETURN; END IF;
  v_n := (length(v_def) - length(replace(v_def, p_old, ''))) / length(p_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'Expected to find % exactly once in %, found % times', p_old, p_fn, v_n; END IF;
  EXECUTE replace(v_def, p_old, p_new);
END $$;

-- ---------------------------------------------------------------------------
-- 1. The machine a gauge is fixed to
-- ---------------------------------------------------------------------------
ALTER TABLE public.gauges ADD COLUMN IF NOT EXISTS machine_id uuid;
ALTER TABLE public.gauges DROP CONSTRAINT IF EXISTS gauges_machine_fkey;
ALTER TABLE public.gauges ADD CONSTRAINT gauges_machine_fkey FOREIGN KEY (machine_id, organisation_id) REFERENCES public.machines (id, organisation_id);
CREATE INDEX IF NOT EXISTS gauges_machine_idx ON public.gauges (machine_id) WHERE machine_id IS NOT NULL;
COMMENT ON COLUMN public.gauges.machine_id IS 'The machine this gauge is fixed to (optional); where it is kept is the typed location';
GRANT UPDATE (machine_id) ON public.gauges TO authenticated;

-- ---------------------------------------------------------------------------
-- 8. One check per gauge per template
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS gauge_characteristics_template_key ON public.gauge_characteristics (gauge_id, template_id) WHERE template_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 6. Deleting twice
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.soft_delete_stamp(p_new_deleted_at timestamptz, p_old_deleted_at timestamptz, p_reason text, p_what text)
RETURNS timestamptz
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
BEGIN
  IF p_new_deleted_at IS NOT NULL AND p_old_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'This % is already deleted', p_what USING ERRCODE = 'QM006';
  END IF;
  IF p_new_deleted_at IS NOT NULL AND p_old_deleted_at IS NULL THEN
    IF coalesce(trim(p_reason), '') = '' THEN
      RAISE EXCEPTION 'Give a reason for deleting this %', p_what USING ERRCODE = 'QM006';
    END IF;
    RETURN now();
  END IF;
  RETURN p_new_deleted_at;
END $$;

-- ---------------------------------------------------------------------------
-- 1, 2, 5, 7. The gauge rules
-- ---------------------------------------------------------------------------
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
  IF NEW.gauge_type_id IS DISTINCT FROM OLD.gauge_type_id
     AND NOT EXISTS (SELECT 1 FROM public.gauge_types y WHERE y.id = NEW.gauge_type_id AND y.active) THEN
    RAISE EXCEPTION 'That gauge type is switched off' USING ERRCODE = 'QM006';
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
-- 3. The outcome is judged on the final state of every reading
-- ---------------------------------------------------------------------------
-- fail: some reading is out of tolerance as it was left (the as-left value when there is one, else as found); pass: every reading was in tolerance as found;
-- adjusted: out as found somewhere, but in tolerance as left everywhere it mattered.
CREATE OR REPLACE FUNCTION app.calibration_outcome_from_readings(p_calibration_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE
           WHEN count(*) = 0 THEN NULL
           WHEN NOT bool_and(coalesce(as_left_ok, as_found_ok)) THEN 'fail'
           WHEN bool_and(as_found_ok) THEN 'pass'
           ELSE 'adjusted'
         END
  FROM public.calibration_readings WHERE calibration_id = p_calibration_id
$$;

-- ---------------------------------------------------------------------------
-- 4. The gauge follows its latest calibration
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.calibration_after_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  cur record;
  latest record;
  g record;
  new_status text;
  new_reason text;
  new_last date;
  new_due date;
  later_edit boolean;
  follows boolean;
BEGIN
  SELECT * INTO cur FROM public.calibrations WHERE id = NEW.id;
  -- One calibration at a time per gauge: whoever gets here second waits, then judges what the first one committed.
  SELECT * INTO g FROM public.gauges WHERE id = NEW.gauge_id FOR UPDATE;
  SELECT c.id, c.reference, c.calibrated_on, c.created_at, c.next_due_on, c.outcome INTO latest
  FROM public.calibrations c
  WHERE c.gauge_id = NEW.gauge_id AND c.deleted_at IS NULL
  ORDER BY c.calibrated_on DESC, c.created_at DESC, c.reference DESC
  LIMIT 1;

  -- The gauge follows only a change that touches the latest record: a new latest record, or the latest one's outcome, dates or deletion.
  IF TG_OP = 'INSERT' THEN
    follows := latest.id IS NOT DISTINCT FROM NEW.id;
  ELSE
    follows := (NEW.outcome, NEW.calibrated_on, NEW.next_due_on, NEW.deleted_at) IS DISTINCT FROM (OLD.outcome, OLD.calibrated_on, OLD.next_due_on, OLD.deleted_at)
               AND (latest.id IS NULL OR latest.id = NEW.id
                    OR (OLD.calibrated_on, OLD.created_at, OLD.reference) >= (latest.calibrated_on, latest.created_at, latest.reference));
  END IF;

  new_status := g.status;
  new_reason := g.status_reason;
  new_last := g.last_calibrated_on;
  new_due := g.next_due_on;
  IF follows THEN
    IF latest.id IS NULL THEN
      -- No calibration left: never calibrated again, and a quarantine that came from a failed calibration goes with it.
      new_last := NULL;
      new_due := NULL;
      IF g.status = 'quarantined' AND g.status_reason ~ '^Failed calibration CAL-' THEN
        new_status := 'active';
        new_reason := NULL;
      END IF;
    ELSE
      new_last := latest.calibrated_on;
      new_due := coalesce(latest.next_due_on, g.next_due_on);
      IF latest.outcome = 'fail' AND g.status IN ('active', 'in_calibration') THEN
        new_status := 'quarantined';
        new_reason := 'Failed calibration ' || latest.reference;
      ELSIF latest.outcome IN ('pass', 'adjusted') AND g.status IN ('quarantined', 'in_calibration') THEN
        new_status := 'active';
        new_reason := NULL;
      END IF;
    END IF;
    IF (g.last_calibrated_on, g.next_due_on, g.status, g.status_reason) IS DISTINCT FROM (new_last, new_due, new_status, new_reason) THEN
      PERFORM set_config('app.gauge_follows_calibration', 'on', true);
      UPDATE public.gauges
      SET last_calibrated_on = new_last, next_due_on = new_due, status = new_status, status_reason = new_reason
      WHERE id = NEW.gauge_id;
      PERFORM set_config('app.gauge_follows_calibration', '', true);
    END IF;
  END IF;

  IF auth.role() = 'authenticated' THEN
    -- Changes in the transaction that created the record are part of recording it.
    later_edit := cur.created_at <> now();
    IF TG_OP = 'INSERT' AND NOT cur.is_legacy THEN
      PERFORM app.emit_event(NEW.organisation_id, 'calibration.recorded', 'calibration', NEW.id,
        jsonb_build_object('reference', cur.reference, 'gauge_id', NEW.gauge_id, 'asset_number', g.asset_number,
                           'calibrated_on', cur.calibrated_on, 'outcome', cur.outcome));
    ELSIF later_edit AND TG_OP = 'UPDATE' AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
      PERFORM app.emit_event(NEW.organisation_id, CASE WHEN NEW.deleted_at IS NULL THEN 'calibration.restored' ELSE 'calibration.deleted' END,
        'calibration', NEW.id, jsonb_build_object('reference', NEW.reference, 'gauge_id', NEW.gauge_id, 'reason', NEW.delete_reason));
    ELSIF later_edit AND TG_OP = 'UPDATE' AND NEW.outcome <> OLD.outcome THEN
      PERFORM app.emit_event(NEW.organisation_id, 'calibration.outcome_changed', 'calibration', NEW.id,
        jsonb_build_object('reference', NEW.reference, 'gauge_id', NEW.gauge_id, 'from', OLD.outcome, 'to', NEW.outcome));
    END IF;
    IF new_status IS DISTINCT FROM g.status THEN
      PERFORM app.emit_event(NEW.organisation_id, 'gauge.status_changed', 'gauge', NEW.gauge_id,
        jsonb_build_object('asset_number', g.asset_number, 'from', g.status, 'to', new_status, 'reason', new_reason));
    END IF;
  END IF;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 9. The technician is one of the organisation's people
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.calibration_technician_is_member() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.technician_id IS DISTINCT FROM OLD.technician_id THEN
    PERFORM app.assert_active_member(NEW.organisation_id, NEW.technician_id, 'technician', 'QM006');
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.calibration_technician_is_member() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS calibrations_technician_member ON public.calibrations;
CREATE TRIGGER calibrations_technician_member BEFORE INSERT OR UPDATE OF technician_id ON public.calibrations
  FOR EACH ROW EXECUTE FUNCTION app.calibration_technician_is_member();

-- ---------------------------------------------------------------------------
-- Imports and import field locks learn the machine
-- ---------------------------------------------------------------------------
SELECT pg_temp.patch_once('app.import_gauge(uuid, uuid, jsonb)'::regprocedure, 'notes, machine_id)',
  'interval_unit, commissioned_on, notes)', 'interval_unit, commissioned_on, notes, machine_id)');
SELECT pg_temp.patch_once('app.import_gauge(uuid, uuid, jsonb)'::regprocedure, $m$'notes'), app.imp_ref(d, 'machine'))$m$,
  $o$app.imp_date(d, 'commissionedOn'), app.imp_text(d, 'notes'))$o$, $n$app.imp_date(d, 'commissionedOn'), app.imp_text(d, 'notes'), app.imp_ref(d, 'machine'))$n$);
SELECT pg_temp.patch_once('app.import_gauge(uuid, uuid, jsonb)'::regprocedure, $m$machine_id = CASE WHEN d ? 'machine'$m$,
  $o$    notes = CASE WHEN d ? 'notes' THEN app.imp_text(d, 'notes') ELSE notes END,$o$,
  $n$    notes = CASE WHEN d ? 'notes' THEN app.imp_text(d, 'notes') ELSE notes END,
    machine_id = CASE WHEN d ? 'machine' THEN app.imp_ref(d, 'machine') ELSE machine_id END,$n$);
SELECT pg_temp.patch_once('app.integration_field_columns(text)'::regprocedure, '"machine":"machine_id"',
  '"gaugeType":"gauge_type_id",', '"gaugeType":"gauge_type_id","machine":"machine_id",');

-- ---------------------------------------------------------------------------
-- The impact report names inspections, so it asks for inspection.read at each inspection's site (it only asked for
-- calibration.read at the gauge's site, so a calibration reader saw inspection references and part numbers they could not open).
-- ---------------------------------------------------------------------------
SELECT pg_temp.patch_once('app.gauge_usage(uuid, timestamptz, timestamptz)'::regprocedure, $m$'inspection.read', i.site_id$m$,
  $o$    AND app.has_permission(g.organisation_id, 'calibration.read', g.site_id)$o$,
  $n$    AND app.has_permission(g.organisation_id, 'calibration.read', g.site_id)
    AND app.has_permission(i.organisation_id, 'inspection.read', i.site_id)$n$);
