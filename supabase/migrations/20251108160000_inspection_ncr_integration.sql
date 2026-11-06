-- Process control, slice PC5 (docs/process-control-plan.md §14, PCB §9): non-conformance and
-- calibration integration for in-process inspections.
--  1. inspection_ncr_links: which NC was raised from which inspection and which failed readings. Insert
--     only through app.raise_ncr_from_inspection(); never updated or deleted, so a reading stays linked
--     whatever happens to the NC afterwards (PCB: "retain the original measurement even if the NC is
--     edited, reclassified or closed").
--  2. inspection_failure_acknowledgements: a person has seen a current failed reading and says what is
--     being done (note required; who and when set by the database).
--  3. An inspection cannot be completed while a current failed reading is neither acknowledged nor
--     linked to an NC (agreed 2026-11-06).
--  4. app.raise_ncr_from_inspection(): one transaction creates the NC (source internal, draft or open;
--     part, revision, site, work order, lot, serial and detection taken from the inspection) and links
--     every chosen failed reading — or none, for a defect no measurement caught.
--  5. app.gauge_usage(): inspections that used a gauge in a period (the impact assessment when a
--     calibration finds it out of tolerance). Reads only; never rewrites a result.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE public.inspection_ncr_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  nonconformance_id uuid NOT NULL,
  inspection_record_id uuid NOT NULL,
  -- The failed reading; null when the NC covers the inspection as a whole (a defect no measurement caught).
  measurement_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT inspection_ncr_links_ncr_fkey FOREIGN KEY (nonconformance_id, organisation_id)
    REFERENCES public.nonconformances (id, organisation_id),
  CONSTRAINT inspection_ncr_links_record_fkey FOREIGN KEY (inspection_record_id, organisation_id)
    REFERENCES public.inspection_records (id, organisation_id),
  CONSTRAINT inspection_ncr_links_measurement_fkey FOREIGN KEY (measurement_id, inspection_record_id)
    REFERENCES public.inspection_measurements (id, inspection_record_id)
);
CREATE UNIQUE INDEX inspection_ncr_links_key ON public.inspection_ncr_links
  (nonconformance_id, coalesce(measurement_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX inspection_ncr_links_record_idx ON public.inspection_ncr_links (inspection_record_id);
CREATE INDEX inspection_ncr_links_measurement_idx ON public.inspection_ncr_links (measurement_id) WHERE measurement_id IS NOT NULL;

CREATE TABLE public.inspection_failure_acknowledgements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  inspection_record_id uuid NOT NULL,
  measurement_id uuid NOT NULL,
  note text NOT NULL CHECK (length(trim(note)) BETWEEN 1 AND 1000),
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT inspection_failure_acknowledgements_record_fkey FOREIGN KEY (inspection_record_id, organisation_id)
    REFERENCES public.inspection_records (id, organisation_id),
  CONSTRAINT inspection_failure_acknowledgements_measurement_fkey FOREIGN KEY (measurement_id, inspection_record_id)
    REFERENCES public.inspection_measurements (id, inspection_record_id),
  CONSTRAINT inspection_failure_acknowledgements_key UNIQUE (measurement_id)
);

-- A failure is acknowledged by a person who can record inspections at the site: the reading must be a
-- current (uncorrected) failed reading of an inspection that is in progress or completed.
CREATE FUNCTION app.inspection_acknowledgement_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  m record;
  v_status text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'An acknowledgement cannot be changed' USING ERRCODE = 'QM008';
  END IF;
  SELECT result, requirement_id INTO m FROM public.inspection_measurements WHERE id = NEW.measurement_id;
  IF m.result IS DISTINCT FROM 'fail' THEN
    RAISE EXCEPTION 'Only a failed reading is acknowledged' USING ERRCODE = 'QM008';
  END IF;
  IF EXISTS (SELECT 1 FROM public.inspection_measurements c WHERE c.supersedes_id = NEW.measurement_id) THEN
    RAISE EXCEPTION 'This reading has been corrected; acknowledge the current reading instead' USING ERRCODE = 'QM008';
  END IF;
  SELECT status INTO v_status FROM public.inspection_records WHERE id = NEW.inspection_record_id;
  IF v_status = 'abandoned' THEN
    RAISE EXCEPTION 'An abandoned inspection needs no acknowledgements' USING ERRCODE = 'QM008';
  END IF;
  NEW.acknowledged_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER inspection_failure_acknowledgements_rules BEFORE INSERT OR UPDATE ON public.inspection_failure_acknowledgements
  FOR EACH ROW EXECUTE FUNCTION app.inspection_acknowledgement_rules();

-- Links are written by app.raise_ncr_from_inspection only and are never changed.
CREATE FUNCTION app.inspection_ncr_link_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'A link between an NC and an inspection reading is permanent' USING ERRCODE = 'QM008';
END $$;
CREATE TRIGGER inspection_ncr_links_frozen BEFORE UPDATE OR DELETE ON public.inspection_ncr_links
  FOR EACH ROW EXECUTE FUNCTION app.inspection_ncr_link_rules();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['inspection_ncr_links', 'inspection_failure_acknowledgements'] LOOP
    EXECUTE format('CREATE TRIGGER %1$s_stamp BEFORE INSERT ON public.%1$I FOR EACH ROW EXECUTE FUNCTION app.stamp_created()', t);
    EXECUTE format('CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.%I '
                   'FOR EACH ROW EXECUTE FUNCTION audit.record_change(''organisation_id'')', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('CREATE POLICY %1$s_select ON public.%1$I FOR SELECT TO authenticated '
                   'USING (app.has_permission(organisation_id, ''inspection.read'', app.inspection_site(inspection_record_id)))', t);
  END LOOP;
END $$;
GRANT INSERT ON public.inspection_failure_acknowledgements TO authenticated;
CREATE POLICY inspection_failure_acknowledgements_insert ON public.inspection_failure_acknowledgements FOR INSERT TO authenticated
  WITH CHECK (app.has_permission(organisation_id, 'inspection.record', app.inspection_site(inspection_record_id)));

-- ---------------------------------------------------------------------------
-- Completion needs every current failure handled
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.inspection_record_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_missing text;
  v_unhandled text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Only app.start_inspection inserts (users have no INSERT privilege); keep it consistent.
    NEW.status := 'in_progress'; NEW.result := NULL; NEW.completed_at := NULL; NEW.completed_by := NULL; NEW.abandon_reason := NULL;
    NEW.started_at := now();
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'result', 'completed_at', 'completed_by', 'abandon_reason', 'notes', 'updated_at', 'updated_by'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'result', 'completed_at', 'completed_by', 'abandon_reason', 'notes', 'updated_at', 'updated_by']) THEN
    RAISE EXCEPTION 'The context and requirements of an inspection cannot change' USING ERRCODE = 'QM008';
  END IF;
  IF OLD.status <> 'in_progress' THEN
    IF NEW IS DISTINCT FROM OLD AND (NEW.status, NEW.result, NEW.notes, NEW.abandon_reason) IS DISTINCT FROM (OLD.status, OLD.result, OLD.notes, OLD.abandon_reason) THEN
      RAISE EXCEPTION 'Inspection % is %', OLD.reference, OLD.status USING ERRCODE = 'QM008';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'in_progress' THEN
    IF (NEW.result, NEW.completed_at, NEW.completed_by, NEW.abandon_reason) IS DISTINCT FROM (OLD.result, OLD.completed_at, OLD.completed_by, OLD.abandon_reason) THEN
      RAISE EXCEPTION 'The result is worked out when the inspection is completed' USING ERRCODE = 'QM008';
    END IF;
    RETURN NEW;
  END IF;
  NEW.completed_at := now();
  NEW.completed_by := auth.uid();
  IF NEW.status = 'abandoned' THEN
    IF coalesce(trim(NEW.abandon_reason), '') = '' THEN
      RAISE EXCEPTION 'Give a reason for abandoning the inspection' USING ERRCODE = 'QM008';
    END IF;
    NEW.result := NULL;
    RETURN NEW;
  END IF;
  -- Completed.
  NEW.abandon_reason := NULL;
  SELECT string_agg(q.name, ', ' ORDER BY q.sequence) INTO v_missing
  FROM public.resolved_inspection_requirements q
  WHERE q.inspection_record_id = NEW.id AND q.applicable
    AND NOT EXISTS (SELECT 1 FROM public.inspection_measurements m WHERE m.requirement_id = q.id);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Measure every check before completing; missing: %', v_missing USING ERRCODE = 'QM008';
  END IF;
  -- Every current failed reading needs an acknowledgement or an NC.
  SELECT string_agg(q.name || ' (sample ' || s.sample_number || ')', ', ' ORDER BY s.sample_number, q.sequence) INTO v_unhandled
  FROM public.inspection_measurements m
  JOIN public.resolved_inspection_requirements q ON q.id = m.requirement_id
  JOIN public.inspection_samples s ON s.id = m.sample_id
  WHERE m.inspection_record_id = NEW.id AND m.result = 'fail'
    AND NOT EXISTS (SELECT 1 FROM public.inspection_measurements c WHERE c.supersedes_id = m.id)
    AND NOT EXISTS (SELECT 1 FROM public.inspection_failure_acknowledgements a WHERE a.measurement_id = m.id)
    AND NOT EXISTS (SELECT 1 FROM public.inspection_ncr_links l WHERE l.measurement_id = m.id);
  IF v_unhandled IS NOT NULL THEN
    RAISE EXCEPTION 'Acknowledge or raise an NC for each failed reading before completing: %', v_unhandled USING ERRCODE = 'QM008';
  END IF;
  NEW.result := CASE WHEN EXISTS (
      SELECT 1 FROM public.inspection_measurements m
      WHERE m.inspection_record_id = NEW.id AND m.result = 'fail'
        AND NOT EXISTS (SELECT 1 FROM public.inspection_measurements c WHERE c.supersedes_id = m.id))
    THEN 'fail' ELSE 'pass' END;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- Raise an NC from an inspection
-- ---------------------------------------------------------------------------
/*
 * Creates a non-conformance (source internal; draft, or open when p_open and the minimum content is
 * there) for an inspection and links the chosen failed readings to it — all in the caller's
 * transaction. Needs ncr.create and inspection.read at the inspection's site. Part, part revision,
 * site, work order, lot, serial, detection date and the detector come from the inspection and cannot
 * be overridden; the text fields (title, description, requirement, actual result), severity and
 * quantity are the caller's (the API suggests them). With no readings the NC covers the inspection as
 * a whole — a defect no measurement caught. Returns the NC id.
 */
CREATE FUNCTION app.raise_ncr_from_inspection(
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
  SELECT i.id, i.organisation_id, i.site_id, i.part_id, i.part_revision_id, i.work_order, i.lot, i.serial, i.reference, i.status
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
  END IF;

  INSERT INTO public.nonconformances (organisation_id, reference, source, stage, severity, title, description, requirement, actual_result,
                                      site_id, part_id, part_revision_id, work_order, lot_number, serial_number, quantity_affected,
                                      detected_at, detected_by)
  VALUES (r.organisation_id, 'pending', 'internal', CASE WHEN coalesce(p_open, false) THEN 'open' ELSE 'draft' END,
          nullif(p_severity, ''), left(v_title, 200), nullif(trim(p_description), ''), nullif(trim(p_requirement), ''), nullif(trim(p_actual_result), ''),
          r.site_id, r.part_id, r.part_revision_id, r.work_order, r.lot, r.serial, p_quantity_affected,
          coalesce(v_detected, current_date), auth.uid())
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

-- ---------------------------------------------------------------------------
-- Gauge usage (impact assessment)
-- ---------------------------------------------------------------------------
/*
 * Inspections that used a gauge between two instants, with reading counts — for assessing which
 * measurements may be affected when a calibration finds the gauge out of tolerance. Needs
 * calibration.read at the gauge's site; shows what was recorded and never changes it.
 */
CREATE FUNCTION app.gauge_usage(p_gauge_id uuid, p_from timestamptz DEFAULT NULL, p_to timestamptz DEFAULT NULL)
RETURNS TABLE (inspection_record_id uuid, reference text, status text, part_number text, site_id uuid, readings bigint,
               failed_readings bigint, first_used timestamptz, last_used timestamptz, overrides bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT i.id, i.reference, i.status, p.part_number, i.site_id, count(*), count(*) FILTER (WHERE m.result = 'fail'),
         min(m.measured_at), max(m.measured_at), count(*) FILTER (WHERE m.gauge_valid = false)
  FROM public.gauges g
  JOIN public.inspection_measurements m ON m.gauge_id = g.id
  JOIN public.inspection_records i ON i.id = m.inspection_record_id
  JOIN public.parts p ON p.id = i.part_id
  WHERE g.id = p_gauge_id
    AND app.has_permission(g.organisation_id, 'calibration.read', g.site_id)
    AND (p_from IS NULL OR m.measured_at >= p_from)
    AND (p_to IS NULL OR m.measured_at <= p_to)
  GROUP BY i.id, i.reference, i.status, p.part_number, i.site_id
  ORDER BY min(m.measured_at)
$$;

REVOKE ALL ON FUNCTION app.inspection_acknowledgement_rules(), app.inspection_ncr_link_rules(), app.inspection_record_rules(),
  app.raise_ncr_from_inspection(uuid, uuid[], text, text, text, numeric, text, text, boolean), app.gauge_usage(uuid, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.raise_ncr_from_inspection(uuid, uuid[], text, text, text, numeric, text, text, boolean),
  app.gauge_usage(uuid, timestamptz, timestamptz) TO authenticated;
