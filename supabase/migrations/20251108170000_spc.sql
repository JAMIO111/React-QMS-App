-- Process control PC6: SPC control charts (I-MR, X-bar/R).
--
--  * inspection_samples.subgroup_number: samples taken at one check belong to one subgroup. Assigned
--    here when the sample is added (the caller may give a number to start a new subgroup): same
--    inspection, same trigger, not a retest and the group is not yet full (largest X-bar/R subgroup
--    size of the inspection's requirements) -> join; otherwise a new subgroup. Retests get none.
--    Samples taken before this migration stay NULL ("no subgroup recorded").
--  * spc_baselines: control limits saved by a quality engineer from a chosen window of data, with the
--    measurement ids used. Never edited; a new baseline for the same scope supersedes the previous
--    one (which stays visible). Charts themselves read inspection_measurements live: nothing copied.
--  * Permissions spc.read / spc.manage.
-- Errors QM008 -> 409 inspection_rule (unchanged).

INSERT INTO public.permissions (code, description) VALUES
  ('spc.read',   'View SPC control charts and baselines'),
  ('spc.manage', 'Save and replace SPC baselines (control limits)');

WITH grants(key, perms) AS (VALUES
  ('owner',            ARRAY['spc.read', 'spc.manage']),
  ('admin',            ARRAY['spc.read', 'spc.manage']),
  ('quality_manager',  ARRAY['spc.read', 'spc.manage']),
  ('quality_engineer', ARRAY['spc.read', 'spc.manage']),
  ('inspector',        ARRAY['spc.read']),
  ('viewer',           ARRAY['spc.read'])
)
INSERT INTO public.role_permissions (role_id, permission_code)
SELECT r.id, unnest(g.perms) FROM public.roles r JOIN grants g ON g.key = r.key WHERE r.is_system
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Subgroups
-- ---------------------------------------------------------------------------
ALTER TABLE public.inspection_samples
  ADD COLUMN subgroup_number integer CHECK (subgroup_number IS NULL OR subgroup_number >= 1);

CREATE OR REPLACE FUNCTION app.inspection_sample_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_size integer;
  v_last record;
  v_max integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - ARRAY['notes', 'updated_at', 'updated_by']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['notes', 'updated_at', 'updated_by']) THEN
      RAISE EXCEPTION 'A sample cannot be changed once taken' USING ERRCODE = 'QM008';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM app.assert_inspection_open(NEW.inspection_record_id);
  NEW.sample_number := coalesce((SELECT max(sample_number) FROM public.inspection_samples WHERE inspection_record_id = NEW.inspection_record_id), 0) + 1;
  NEW.sampled_at := now();

  IF NEW.is_retest THEN
    NEW.subgroup_number := NULL;
  ELSIF NEW.subgroup_number IS NULL THEN
    SELECT max(subgroup_size) INTO v_size FROM public.resolved_inspection_requirements
      WHERE inspection_record_id = NEW.inspection_record_id AND applicable AND chart_type = 'xbar_r';
    SELECT max(subgroup_number) INTO v_max FROM public.inspection_samples WHERE inspection_record_id = NEW.inspection_record_id;
    IF v_size IS NULL THEN
      NEW.subgroup_number := coalesce(v_max, 0) + 1;
    ELSE
      SELECT s.subgroup_number, s.trigger_type INTO v_last FROM public.inspection_samples s
        WHERE s.inspection_record_id = NEW.inspection_record_id AND NOT s.is_retest AND s.subgroup_number IS NOT NULL
        ORDER BY s.sample_number DESC LIMIT 1;
      IF v_last.subgroup_number IS NOT NULL AND v_last.trigger_type = NEW.trigger_type
         AND (SELECT count(*) FROM public.inspection_samples s
              WHERE s.inspection_record_id = NEW.inspection_record_id AND s.subgroup_number = v_last.subgroup_number) < v_size THEN
        NEW.subgroup_number := v_last.subgroup_number;
      ELSE
        NEW.subgroup_number := coalesce(v_max, 0) + 1;
      END IF;
    END IF;
  ELSE
    -- An explicit number may only start the next subgroup or join an existing one of this inspection.
    SELECT max(subgroup_number) INTO v_max FROM public.inspection_samples WHERE inspection_record_id = NEW.inspection_record_id;
    IF NEW.subgroup_number > coalesce(v_max, 0) + 1 THEN
      RAISE EXCEPTION 'Subgroup % is not the next subgroup of this inspection', NEW.subgroup_number USING ERRCODE = 'QM008';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- Baselines
-- ---------------------------------------------------------------------------
CREATE TABLE public.spc_baselines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  part_id uuid NOT NULL,
  characteristic_key text NOT NULL CHECK (length(characteristic_key) BETWEEN 1 AND 60),
  operation_code text CHECK (operation_code IS NULL OR length(operation_code) BETWEEN 1 AND 40),
  chart_type text NOT NULL CHECK (chart_type IN ('imr', 'xbar_r')),
  subgroup_size integer NOT NULL CHECK (subgroup_size BETWEEN 1 AND 10),
  unit_code text,
  -- The data the limits were calculated from.
  window_from timestamptz NOT NULL,
  window_to timestamptz NOT NULL,
  n_points integer NOT NULL CHECK (n_points >= 5),
  provisional boolean NOT NULL,
  measurement_ids uuid[] NOT NULL CHECK (cardinality(measurement_ids) BETWEEN 5 AND 5000),
  -- The specification in force for that data (for reference; control limits are not tolerances).
  spec_nominal numeric,
  spec_lower numeric,
  spec_upper numeric,
  -- Location chart (X for I-MR, X-bar for X-bar/R) and dispersion chart (MR or R).
  centre numeric NOT NULL,
  ucl numeric NOT NULL,
  lcl numeric NOT NULL,
  dispersion_centre numeric NOT NULL,
  dispersion_ucl numeric NOT NULL,
  dispersion_lcl numeric NOT NULL,
  sigma numeric NOT NULL CHECK (sigma >= 0),
  rules text[] NOT NULL DEFAULT ARRAY['we1', 'we2', 'we3', 'we4'] CHECK (rules <@ ARRAY['we1', 'we2', 'we3', 'we4']),
  notes text CHECK (notes IS NULL OR length(notes) <= 2000),
  superseded_at timestamptz,
  superseded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT spc_baselines_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT spc_baselines_part_fkey FOREIGN KEY (part_id, organisation_id) REFERENCES public.parts (id, organisation_id),
  CONSTRAINT spc_baselines_superseded_fkey FOREIGN KEY (superseded_by, organisation_id) REFERENCES public.spc_baselines (id, organisation_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT spc_baselines_window CHECK (window_to >= window_from),
  CONSTRAINT spc_baselines_limits CHECK (lcl <= centre AND centre <= ucl AND dispersion_lcl <= dispersion_centre AND dispersion_centre <= dispersion_ucl),
  CONSTRAINT spc_baselines_chart_size CHECK ((chart_type = 'imr' AND subgroup_size = 1) OR (chart_type = 'xbar_r' AND subgroup_size BETWEEN 2 AND 10)),
  CONSTRAINT spc_baselines_superseded CHECK ((superseded_at IS NULL) = (superseded_by IS NULL))
);
-- One active baseline per scope.
CREATE UNIQUE INDEX spc_baselines_active_key ON public.spc_baselines
  (organisation_id, part_id, characteristic_key, coalesce(operation_code, ''), chart_type) WHERE superseded_at IS NULL;
CREATE INDEX spc_baselines_scope_idx ON public.spc_baselines (organisation_id, part_id, characteristic_key, created_at DESC);

CREATE FUNCTION app.spc_baseline_supersede() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.spc_baselines b SET superseded_at = now(), superseded_by = NEW.id
  WHERE b.organisation_id = NEW.organisation_id AND b.part_id = NEW.part_id AND b.characteristic_key = NEW.characteristic_key
    AND coalesce(b.operation_code, '') = coalesce(NEW.operation_code, '') AND b.chart_type = NEW.chart_type
    AND b.superseded_at IS NULL;
  RETURN NEW;
END $$;

CREATE FUNCTION app.spc_baseline_frozen() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A baseline cannot be deleted' USING ERRCODE = 'QM008';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['superseded_at', 'superseded_by', 'updated_at', 'updated_by'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['superseded_at', 'superseded_by', 'updated_at', 'updated_by']) OR OLD.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION 'A baseline cannot be changed; save a new one instead' USING ERRCODE = 'QM008';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER spc_baselines_stamp BEFORE INSERT ON public.spc_baselines FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER spc_baselines_supersede BEFORE INSERT ON public.spc_baselines FOR EACH ROW EXECUTE FUNCTION app.spc_baseline_supersede();
CREATE TRIGGER spc_baselines_frozen BEFORE UPDATE OR DELETE ON public.spc_baselines FOR EACH ROW EXECUTE FUNCTION app.spc_baseline_frozen();
CREATE TRIGGER spc_baselines_touch BEFORE UPDATE ON public.spc_baselines FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER spc_baselines_org_immutable BEFORE UPDATE ON public.spc_baselines FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.spc_baselines
  FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');

ALTER TABLE public.spc_baselines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.spc_baselines FROM anon, authenticated;
GRANT SELECT, INSERT ON public.spc_baselines TO authenticated;
CREATE POLICY spc_baselines_select ON public.spc_baselines FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'spc.read'));
CREATE POLICY spc_baselines_insert ON public.spc_baselines FOR INSERT TO authenticated
  WITH CHECK (app.has_permission(organisation_id, 'spc.manage'));

REVOKE ALL ON FUNCTION app.spc_baseline_supersede(), app.spc_baseline_frozen() FROM PUBLIC;
