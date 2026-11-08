-- Phase 3 / TR4: affected lots on non-conformances (docs/phase-3-plan.md, TR4).
--
--  1. ncr_affected_lots: the lots (and optionally serial numbers of them) an NC touches, each with a quantity. Written under RLS by anyone who can edit the NC;
--     nothing is deleted (a removal carries a reason, stamped by the database, and can be restored).
--  2. lot_id (optional) on ncr_dispositions and ncr_containment_actions: the live affected lot the decision or action applies to.
--  3. Per-lot rules: quantities per lot never exceed the lot's affected quantity; the affected quantities never exceed the NC's quantity affected;
--     a lot cannot be removed while a live disposition or a non-cancelled containment action names it; and an NC that names lots needs each lot covered by
--     approved dispositions before it reaches Dispositioned. An NC that names no lot behaves exactly as before (shops that work to work orders only).
--  4. app.raise_ncr_from_inspection copies the inspection's order, lot and serial links onto the NC (it only copied the typed text).
-- Errors use QM005 (409 ncr_rule). The lot is never required.

-- ---------------------------------------------------------------------------
-- Affected lots
-- ---------------------------------------------------------------------------
CREATE TABLE public.ncr_affected_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  nonconformance_id uuid NOT NULL,
  lot_id uuid NOT NULL,
  quantity numeric NOT NULL CHECK (quantity > 0),
  serial_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[] CHECK (cardinality(serial_ids) <= 500),
  note text CHECK (note IS NULL OR length(note) <= 1000),
  removed_at timestamptz,
  removed_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  removed_reason text CHECK (removed_reason IS NULL OR length(trim(removed_reason)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT ncr_affected_lots_id_ncr_key UNIQUE (id, nonconformance_id),
  CONSTRAINT ncr_affected_lots_ncr_fkey FOREIGN KEY (nonconformance_id, organisation_id) REFERENCES public.nonconformances (id, organisation_id),
  CONSTRAINT ncr_affected_lots_lot_fkey FOREIGN KEY (lot_id, organisation_id) REFERENCES public.lots (id, organisation_id),
  CONSTRAINT ncr_affected_lots_removed_shape CHECK ((removed_at IS NULL) = (removed_reason IS NULL))
);
CREATE UNIQUE INDEX ncr_affected_lots_live_key ON public.ncr_affected_lots (nonconformance_id, lot_id) WHERE removed_at IS NULL;
CREATE INDEX ncr_affected_lots_lot_idx ON public.ncr_affected_lots (lot_id);

-- A disposition or containment action may name the affected lot it applies to.
ALTER TABLE public.ncr_dispositions ADD COLUMN lot_id uuid,
  ADD CONSTRAINT ncr_dispositions_lot_fkey FOREIGN KEY (lot_id, organisation_id) REFERENCES public.lots (id, organisation_id);
ALTER TABLE public.ncr_containment_actions ADD COLUMN lot_id uuid,
  ADD CONSTRAINT ncr_containment_lot_fkey FOREIGN KEY (lot_id, organisation_id) REFERENCES public.lots (id, organisation_id);
CREATE INDEX ncr_dispositions_lot_idx ON public.ncr_dispositions (lot_id) WHERE lot_id IS NOT NULL;
CREATE INDEX ncr_containment_lot_idx ON public.ncr_containment_actions (lot_id) WHERE lot_id IS NOT NULL;

/** Quantity of a live affected lot on an NC (null when the lot is not a live affected lot of it). */
CREATE FUNCTION app.ncr_affected_lot_quantity(p_ncr_id uuid, p_lot_id uuid) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT quantity FROM public.ncr_affected_lots WHERE nonconformance_id = p_ncr_id AND lot_id = p_lot_id AND removed_at IS NULL
$$;

/** Quantity of live (proposed or approved) dispositions naming a lot on an NC, optionally leaving one out. */
CREATE FUNCTION app.ncr_lot_disposed_quantity(p_ncr_id uuid, p_lot_id uuid, p_except uuid DEFAULT NULL) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(sum(quantity), 0) FROM public.ncr_dispositions
   WHERE nonconformance_id = p_ncr_id AND lot_id = p_lot_id AND status IN ('proposed', 'approved') AND id IS DISTINCT FROM p_except
$$;

CREATE FUNCTION app.ncr_affected_lot_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  n record;
  l record;
  v_removing boolean := false;
  v_restoring boolean := false;
  v_others numeric;
  v_named integer;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.nonconformance_id <> OLD.nonconformance_id OR NEW.lot_id <> OLD.lot_id) THEN
    RAISE EXCEPTION 'An affected lot cannot move to another non-conformance or lot' USING ERRCODE = 'QM005';
  END IF;
  SELECT part_id, quantity_affected INTO n FROM public.nonconformances WHERE id = NEW.nonconformance_id;
  SELECT lot_number, part_id INTO l FROM public.lots WHERE id = NEW.lot_id;
  IF coalesce(auth.role(), '') = 'authenticated' THEN
    PERFORM app.assert_ncr_editable(NEW.nonconformance_id);
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.removed_at := NULL; NEW.removed_by := NULL; NEW.removed_reason := NULL;
    IF n.part_id IS DISTINCT FROM l.part_id THEN
      RAISE EXCEPTION 'Lot % is a lot of another part than this non-conformance', l.lot_number USING ERRCODE = 'QM005';
    END IF;
  ELSE
    v_removing := OLD.removed_at IS NULL AND NEW.removed_reason IS NOT NULL;
    v_restoring := OLD.removed_at IS NOT NULL AND NEW.removed_reason IS NULL;
    IF OLD.removed_at IS NOT NULL AND NOT v_restoring AND (NEW.quantity, NEW.serial_ids, NEW.note, NEW.removed_reason) IS DISTINCT FROM (OLD.quantity, OLD.serial_ids, OLD.note, OLD.removed_reason) THEN
      RAISE EXCEPTION 'Lot % is removed from this non-conformance; restore it to change it', l.lot_number USING ERRCODE = 'QM005';
    END IF;
    IF v_removing THEN
      NEW.removed_reason := trim(NEW.removed_reason);
      NEW.removed_at := now(); NEW.removed_by := auth.uid();
    ELSIF v_restoring THEN
      NEW.removed_at := NULL; NEW.removed_by := NULL;
    ELSE
      NEW.removed_at := OLD.removed_at; NEW.removed_by := OLD.removed_by;
    END IF;
  END IF;

  IF v_removing THEN
    SELECT (SELECT count(*) FROM public.ncr_dispositions WHERE nonconformance_id = NEW.nonconformance_id AND lot_id = NEW.lot_id AND status IN ('proposed', 'approved'))
         + (SELECT count(*) FROM public.ncr_containment_actions WHERE nonconformance_id = NEW.nonconformance_id AND lot_id = NEW.lot_id AND status <> 'cancelled')
      INTO v_named;
    IF v_named > 0 THEN
      RAISE EXCEPTION 'Lot % cannot be removed while % disposition(s) or containment action(s) name it; cancel or reassign them first', l.lot_number, v_named USING ERRCODE = 'QM005';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.removed_at IS NULL THEN
    -- Serial numbers named must be serial numbers of this lot, once each.
    IF cardinality(NEW.serial_ids) > 0 THEN
      IF cardinality(NEW.serial_ids) <> (SELECT count(DISTINCT x) FROM unnest(NEW.serial_ids) x)
         OR (SELECT count(*) FROM public.serial_numbers s WHERE s.id = ANY (NEW.serial_ids) AND s.lot_id = NEW.lot_id AND s.organisation_id = NEW.organisation_id) <> cardinality(NEW.serial_ids) THEN
        RAISE EXCEPTION 'Serial numbers must be serial numbers of lot %, each named once', l.lot_number USING ERRCODE = 'QM005';
      END IF;
    END IF;
    -- The lots together never exceed the quantity affected.
    SELECT coalesce(sum(quantity), 0) INTO v_others FROM public.ncr_affected_lots
     WHERE nonconformance_id = NEW.nonconformance_id AND removed_at IS NULL AND id IS DISTINCT FROM NEW.id;
    IF v_others + NEW.quantity > coalesce(n.quantity_affected, 0) THEN
      RAISE EXCEPTION 'The lots would total % but only % are affected on this non-conformance (% already in other lots)',
        v_others + NEW.quantity, coalesce(n.quantity_affected, 0), v_others USING ERRCODE = 'QM005';
    END IF;
    -- Decisions already naming the lot must still fit.
    IF TG_OP = 'UPDATE' AND app.ncr_lot_disposed_quantity(NEW.nonconformance_id, NEW.lot_id) > NEW.quantity THEN
      RAISE EXCEPTION 'Dispositions already cover % of lot %; cancel or reduce them before lowering its quantity to %',
        app.ncr_lot_disposed_quantity(NEW.nonconformance_id, NEW.lot_id), l.lot_number, NEW.quantity USING ERRCODE = 'QM005';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER ncr_affected_lot_rules BEFORE INSERT OR UPDATE ON public.ncr_affected_lots FOR EACH ROW EXECUTE FUNCTION app.ncr_affected_lot_rules();
CREATE TRIGGER ncr_affected_lots_stamp BEFORE INSERT ON public.ncr_affected_lots FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER ncr_affected_lots_touch BEFORE UPDATE ON public.ncr_affected_lots FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.ncr_affected_lots FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');

ALTER TABLE public.ncr_affected_lots ENABLE ROW LEVEL SECURITY;
CREATE POLICY ncr_affected_lots_select ON public.ncr_affected_lots FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'ncr.read', app.ncr_site(nonconformance_id)));
CREATE POLICY ncr_affected_lots_insert ON public.ncr_affected_lots FOR INSERT TO authenticated
  WITH CHECK (app.has_permission(organisation_id, 'ncr.update', app.ncr_site(nonconformance_id)));
CREATE POLICY ncr_affected_lots_update ON public.ncr_affected_lots FOR UPDATE TO authenticated
  USING (app.has_permission(organisation_id, 'ncr.update', app.ncr_site(nonconformance_id)))
  WITH CHECK (app.has_permission(organisation_id, 'ncr.update', app.ncr_site(nonconformance_id)));
REVOKE ALL ON public.ncr_affected_lots FROM anon, authenticated;
GRANT SELECT, INSERT ON public.ncr_affected_lots TO authenticated;
GRANT UPDATE (quantity, serial_ids, note, removed_reason) ON public.ncr_affected_lots TO authenticated;

-- The lot of a disposition or containment action is editable like the rest of it.
GRANT UPDATE (lot_id) ON public.ncr_dispositions, public.ncr_containment_actions TO authenticated;

-- ---------------------------------------------------------------------------
-- Containment actions: the lot must be a live affected lot; frozen with the rest once done or cancelled.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.ncr_containment_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.nonconformance_id <> OLD.nonconformance_id THEN
    RAISE EXCEPTION 'A containment action cannot move to another non-conformance' USING ERRCODE = 'QM005';
  END IF;
  IF coalesce(auth.role(), '') <> 'authenticated' THEN
    RETURN NEW;
  END IF;
  PERFORM app.assert_ncr_editable(NEW.nonconformance_id);
  IF NEW.lot_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.lot_id IS DISTINCT FROM OLD.lot_id)
     AND app.ncr_affected_lot_quantity(NEW.nonconformance_id, NEW.lot_id) IS NULL THEN
    RAISE EXCEPTION 'Add the lot to the affected lots of this non-conformance before naming it on a containment action' USING ERRCODE = 'QM005';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.status := 'open'; NEW.done_at := NULL; NEW.done_by := NULL; NEW.done_note := NULL; NEW.cancel_reason := NULL;
    RETURN NEW;
  END IF;

  IF NEW.status = OLD.status THEN
    IF OLD.status <> 'open' AND (NEW.kind, NEW.description, NEW.owner_employee_id, NEW.due_date, NEW.quantity_contained, NEW.done_note, NEW.cancel_reason, NEW.lot_id)
         IS DISTINCT FROM (OLD.kind, OLD.description, OLD.owner_employee_id, OLD.due_date, OLD.quantity_contained, OLD.done_note, OLD.cancel_reason, OLD.lot_id) THEN
      RAISE EXCEPTION 'This containment action is %; reopen it to change it', OLD.status USING ERRCODE = 'QM005';
    END IF;
    IF NEW.done_at IS DISTINCT FROM OLD.done_at OR NEW.done_by IS DISTINCT FROM OLD.done_by THEN
      RAISE EXCEPTION 'Who and when are set by the system' USING ERRCODE = 'QM005';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'open' AND NEW.status = 'done' THEN
    IF length(trim(coalesce(NEW.done_note, ''))) = 0 THEN
      RAISE EXCEPTION 'Say what was done and what was found before marking the action done' USING ERRCODE = 'QM005';
    END IF;
    NEW.done_at := now(); NEW.done_by := auth.uid(); NEW.cancel_reason := NULL;
  ELSIF OLD.status = 'open' AND NEW.status = 'cancelled' THEN
    IF length(trim(coalesce(NEW.cancel_reason, ''))) = 0 THEN
      RAISE EXCEPTION 'Give a reason for cancelling the action' USING ERRCODE = 'QM005';
    END IF;
    NEW.done_at := NULL; NEW.done_by := NULL;
  ELSIF OLD.status IN ('done', 'cancelled') AND NEW.status = 'open' THEN
    NEW.done_at := NULL; NEW.done_by := NULL; NEW.cancel_reason := NULL;
  ELSE
    RAISE EXCEPTION 'A % containment action cannot become %; reopen it first', OLD.status, NEW.status USING ERRCODE = 'QM005';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- Dispositions: the lot must be a live affected lot, and the decisions naming it fit its quantity.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.ncr_disposition_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_affected numeric;
  v_lot_qty numeric;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.nonconformance_id <> OLD.nonconformance_id THEN
    RAISE EXCEPTION 'A disposition cannot move to another non-conformance' USING ERRCODE = 'QM005';
  END IF;
  IF coalesce(auth.role(), '') <> 'authenticated' AND coalesce(current_setting('app.ncr_disposition_step', true), '') <> 'on' THEN
    RETURN NEW;
  END IF;
  IF coalesce(auth.role(), '') = 'authenticated' AND coalesce(current_setting('app.ncr_disposition_step', true), '') <> 'on' THEN
    PERFORM app.assert_ncr_editable(NEW.nonconformance_id);
    IF TG_OP = 'INSERT' THEN
      NEW.status := 'proposed'; NEW.approved_at := NULL; NEW.approved_by := NULL; NEW.approval_note := NULL;
      NEW.cancelled_at := NULL; NEW.cancelled_by := NULL; NEW.cancel_reason := NULL;
    ELSIF OLD.status <> 'proposed' THEN
      RAISE EXCEPTION 'This disposition is %; only a proposed one can be changed', OLD.status USING ERRCODE = 'QM005';
    ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'A disposition is approved or cancelled with its own action' USING ERRCODE = 'QM005';
    END IF;
  END IF;
  IF NEW.status IN ('proposed', 'approved') THEN
    SELECT quantity_affected INTO v_affected FROM public.nonconformances WHERE id = NEW.nonconformance_id;
    IF app.ncr_disposed_quantity(NEW.nonconformance_id, NEW.id) + NEW.quantity > coalesce(v_affected, 0) THEN
      RAISE EXCEPTION 'Dispositions would total % but only % are affected (% already covered)',
        app.ncr_disposed_quantity(NEW.nonconformance_id, NEW.id) + NEW.quantity, coalesce(v_affected, 0), app.ncr_disposed_quantity(NEW.nonconformance_id, NEW.id)
        USING ERRCODE = 'QM005';
    END IF;
    IF NEW.lot_id IS NOT NULL THEN
      v_lot_qty := app.ncr_affected_lot_quantity(NEW.nonconformance_id, NEW.lot_id);
      IF v_lot_qty IS NULL THEN
        RAISE EXCEPTION 'Add the lot to the affected lots of this non-conformance before naming it on a disposition' USING ERRCODE = 'QM005';
      END IF;
      IF app.ncr_lot_disposed_quantity(NEW.nonconformance_id, NEW.lot_id, NEW.id) + NEW.quantity > v_lot_qty THEN
        RAISE EXCEPTION 'Dispositions for this lot would total % but only % of it are affected (% already covered)',
          app.ncr_lot_disposed_quantity(NEW.nonconformance_id, NEW.lot_id, NEW.id) + NEW.quantity, v_lot_qty,
          app.ncr_lot_disposed_quantity(NEW.nonconformance_id, NEW.lot_id, NEW.id) USING ERRCODE = 'QM005';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- Gates: an NC that names lots needs every lot covered by approved dispositions naming it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.ncr_gate_problems(p_ncr_id uuid, p_target text) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  n public.nonconformances%ROWTYPE;
  v_open integer; v_done integer; v_proposed integer; v_covered numeric;
  v_problems text[] := ARRAY[]::text[];
  a record;
BEGIN
  SELECT * INTO n FROM public.nonconformances WHERE id = p_ncr_id;
  IF NOT FOUND THEN
    RETURN v_problems;
  END IF;
  IF p_target IN ('contained', 'investigating', 'dispositioned', 'awaiting_closure', 'closed') THEN
    SELECT count(*) FILTER (WHERE status = 'open'), count(*) FILTER (WHERE status = 'done') INTO v_open, v_done
      FROM public.ncr_containment_actions WHERE nonconformance_id = p_ncr_id;
    IF v_open > 0 THEN
      v_problems := array_append(v_problems, format('%s containment %s still open', v_open, CASE WHEN v_open = 1 THEN 'action is' ELSE 'actions are' END));
    ELSIF v_done = 0 AND length(trim(coalesce(n.containment_not_needed_reason, ''))) = 0 THEN
      v_problems := array_append(v_problems, 'record a containment action, or say why none is needed');
    END IF;
  END IF;
  IF p_target IN ('dispositioned', 'awaiting_closure', 'closed') THEN
    SELECT count(*) FILTER (WHERE status = 'proposed'), coalesce(sum(quantity) FILTER (WHERE status = 'approved'), 0) INTO v_proposed, v_covered
      FROM public.ncr_dispositions WHERE nonconformance_id = p_ncr_id;
    IF v_proposed > 0 THEN
      v_problems := array_append(v_problems, format('%s proposed %s still to approve or cancel', v_proposed, CASE WHEN v_proposed = 1 THEN 'disposition is' ELSE 'dispositions are' END));
    END IF;
    IF v_covered < coalesce(n.quantity_affected, 0) THEN
      v_problems := array_append(v_problems, format('approved dispositions cover %s of the %s affected', v_covered, n.quantity_affected));
    END IF;
    FOR a IN
      SELECT l.lot_number, al.quantity,
             coalesce((SELECT sum(d.quantity) FROM public.ncr_dispositions d WHERE d.nonconformance_id = al.nonconformance_id AND d.lot_id = al.lot_id AND d.status = 'approved'), 0) AS covered
        FROM public.ncr_affected_lots al JOIN public.lots l ON l.id = al.lot_id
       WHERE al.nonconformance_id = p_ncr_id AND al.removed_at IS NULL ORDER BY l.lot_number
    LOOP
      IF a.covered < a.quantity THEN
        v_problems := array_append(v_problems, format('lot %s: approved dispositions cover %s of the %s affected', a.lot_number, a.covered, a.quantity));
      END IF;
    END LOOP;
  END IF;
  RETURN v_problems;
END $$;

-- The quantity affected cannot drop below what the lots (or the dispositions) already account for.
CREATE OR REPLACE FUNCTION app.ncr_stage_gates() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_problems text[];
  v_disposed numeric;
  v_lots numeric;
BEGIN
  IF coalesce(auth.role(), '') <> 'authenticated' THEN
    RETURN NEW;
  END IF;
  IF NEW.stage <> OLD.stage AND OLD.stage NOT IN ('draft', 'closed', 'cancelled') AND NEW.stage NOT IN ('draft', 'open', 'cancelled') THEN
    v_problems := app.ncr_gate_problems(NEW.id, NEW.stage);
    IF cardinality(v_problems) > 0 THEN
      RAISE EXCEPTION 'Before this can move to %: %', replace(NEW.stage, '_', ' '), array_to_string(v_problems, '; ') USING ERRCODE = 'QM005';
    END IF;
  END IF;
  IF NEW.quantity_affected IS DISTINCT FROM OLD.quantity_affected THEN
    v_disposed := app.ncr_disposed_quantity(NEW.id);
    IF v_disposed > coalesce(NEW.quantity_affected, 0) THEN
      RAISE EXCEPTION 'Dispositions already cover % items; cancel or reduce them before lowering the quantity affected to %', v_disposed, coalesce(NEW.quantity_affected, 0)
        USING ERRCODE = 'QM005';
    END IF;
    SELECT coalesce(sum(quantity), 0) INTO v_lots FROM public.ncr_affected_lots WHERE nonconformance_id = NEW.id AND removed_at IS NULL;
    IF v_lots > coalesce(NEW.quantity_affected, 0) THEN
      RAISE EXCEPTION 'The affected lots already total % items; reduce or remove them before lowering the quantity affected to %', v_lots, coalesce(NEW.quantity_affected, 0)
        USING ERRCODE = 'QM005';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- Raising an NC from an inspection carries the order, lot and serial links as well as the typed text.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.raise_ncr_from_inspection(
  p_inspection_id uuid,
  p_measurement_ids uuid[] DEFAULT ARRAY[]::uuid[],
  p_title text DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_severity text DEFAULT NULL,
  p_quantity_affected numeric DEFAULT NULL,
  p_requirement text DEFAULT NULL,
  p_actual_result text DEFAULT NULL,
  p_open boolean DEFAULT false
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  r record;
  v_ids uuid[] := coalesce(p_measurement_ids, ARRAY[]::uuid[]);
  v_distinct uuid[];
  v_found integer;
  v_ncr uuid;
  v_detected date;
  v_title text := nullif(trim(p_title), '');
BEGIN
  SELECT i.id, i.organisation_id, i.site_id, i.part_id, i.part_revision_id, i.work_order, i.lot, i.serial, i.reference, i.status,
         i.production_order_id, i.lot_id, i.serial_id
  INTO r FROM public.inspection_records i WHERE i.id = p_inspection_id;
  IF r.id IS NULL OR NOT app.has_permission(r.organisation_id, 'inspection.read', r.site_id) THEN
    RAISE EXCEPTION 'Inspection not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT app.has_permission(r.organisation_id, 'ncr.create', r.site_id) THEN
    RAISE EXCEPTION 'You may not raise non-conformances' USING ERRCODE = '42501';
  END IF;
  IF v_title IS NULL THEN
    RAISE EXCEPTION 'Give the non-conformance a title' USING ERRCODE = 'QM008';
  END IF;

  SELECT array_agg(DISTINCT x) INTO v_distinct FROM unnest(v_ids) x;
  v_found := coalesce(cardinality(v_distinct), 0);
  IF v_found > 0 THEN
    IF (SELECT count(*) FROM public.inspection_measurements m
        WHERE m.id = ANY (v_distinct) AND m.inspection_record_id = p_inspection_id AND m.result = 'fail') <> v_found THEN
      RAISE EXCEPTION 'Only failed readings of this inspection can be linked to the non-conformance' USING ERRCODE = 'QM008';
    END IF;
    SELECT min(m.measured_at)::date INTO v_detected FROM public.inspection_measurements m WHERE m.id = ANY (v_distinct);
    PERFORM app.assert_readings_free(v_distinct);
  END IF;

  INSERT INTO public.nonconformances (organisation_id, reference, source, stage, severity, title, description, requirement, actual_result,
                                      site_id, part_id, part_revision_id, work_order, lot_number, serial_number,
                                      production_order_id, lot_id, serial_id, quantity_affected, detected_at, detected_by)
  VALUES (r.organisation_id, 'pending', 'internal', CASE WHEN coalesce(p_open, false) THEN 'open' ELSE 'draft' END,
          nullif(p_severity, ''), left(v_title, 200), nullif(trim(p_description), ''), nullif(trim(p_requirement), ''), nullif(trim(p_actual_result), ''),
          r.site_id, r.part_id, r.part_revision_id, r.work_order, r.lot, r.serial,
          r.production_order_id, r.lot_id, r.serial_id, p_quantity_affected, coalesce(v_detected, current_date), auth.uid())
  RETURNING id INTO v_ncr;

  IF v_found = 0 THEN
    INSERT INTO public.inspection_ncr_links (organisation_id, nonconformance_id, inspection_record_id) VALUES (r.organisation_id, v_ncr, p_inspection_id);
  ELSE
    INSERT INTO public.inspection_ncr_links (organisation_id, nonconformance_id, inspection_record_id, measurement_id)
    SELECT r.organisation_id, v_ncr, p_inspection_id, x FROM unnest(v_distinct) x;
  END IF;

  PERFORM app.emit_event(r.organisation_id, 'inspection.ncr_raised', 'inspection_record', p_inspection_id,
    jsonb_build_object('reference', r.reference, 'nonconformance_id', v_ncr, 'readings', v_found));
  RETURN v_ncr;
END $$;

REVOKE ALL ON FUNCTION app.ncr_affected_lot_rules(), app.ncr_affected_lot_quantity(uuid, uuid), app.ncr_lot_disposed_quantity(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
