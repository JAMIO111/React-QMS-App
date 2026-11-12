-- Management review, slice MR1 (docs/risk-management-plan.md RM12, RM13): permissions, quality objectives and their measured values.
--
--  * Permissions management_review.read / .manage: owner, admin and quality manager hold both, quality engineer read; others none.
--  * quality_objectives: QO-001 ... per organisation. Title, description, owner (an active member), a MEASURE (manual, or one of a fixed list of system measures),
--    unit, direction (at_least | at_most), target, frequency (monthly | quarterly | yearly) and the first period. The measure and the frequency are fixed once
--    created; the rest can change (audited). Retired with a reason, brought back, never deleted. Written only by functions (management_review.manage).
--  * System measures (worked out on read by the API, as the person, never stored): ncr_count (non-conformances raised), supplier_ppm (units rejected at goods
--    receipt per million received), capa_on_time (8Ds closed by their due date, %), audit_pass_rate (completed audits that passed, %). Their unit and direction are fixed.
--  * quality_objective_values: values of a MANUAL objective, one current per period (the period's first day, aligned to the frequency, not in the future, not before the
--    objective's first period). Append-only: a correction supersedes the current value and needs a note. Recorded by a manager or the objective's owner.
--  * Reading: management_review.read, or being the objective's owner.
-- Errors use QM027 (409 management_review_rule); another organisation's id is P0002 (404).

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------
INSERT INTO public.permissions (code, description) VALUES
  ('management_review.read',   'View management reviews and the quality objectives with their values'),
  ('management_review.manage', 'Manage management reviews and quality objectives: define objectives, record their values, plan and hold reviews');

WITH grants(key, perms) AS (VALUES
  ('owner',            ARRAY['management_review.read', 'management_review.manage']),
  ('admin',            ARRAY['management_review.read', 'management_review.manage']),
  ('quality_manager',  ARRAY['management_review.read', 'management_review.manage']),
  ('quality_engineer', ARRAY['management_review.read'])
)
INSERT INTO public.role_permissions (role_id, permission_code)
SELECT r.id, unnest(g.perms) FROM public.roles r JOIN grants g ON g.key = r.key WHERE r.is_system
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Measures and periods
-- ---------------------------------------------------------------------------
-- The fixed list: key, unit, direction. 'manual' takes the unit and direction the person gives.
CREATE FUNCTION app.quality_objective_measure(p_key text) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE p_key
    WHEN 'manual'          THEN jsonb_build_object('unit', NULL, 'direction', NULL)
    WHEN 'ncr_count'       THEN jsonb_build_object('unit', 'NCs', 'direction', 'at_most')
    WHEN 'supplier_ppm'    THEN jsonb_build_object('unit', 'PPM', 'direction', 'at_most')
    WHEN 'capa_on_time'    THEN jsonb_build_object('unit', '%', 'direction', 'at_least')
    WHEN 'audit_pass_rate' THEN jsonb_build_object('unit', '%', 'direction', 'at_least')
  END
$$;

-- The first day of the period a day falls in.
CREATE FUNCTION app.quality_objective_period(p_frequency text, p_day date) RETURNS date
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT date_trunc(CASE p_frequency WHEN 'monthly' THEN 'month' WHEN 'quarterly' THEN 'quarter' ELSE 'year' END, p_day::timestamp)::date
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE app.quality_objective_counters (
  organisation_id uuid PRIMARY KEY REFERENCES public.organisations (id) ON DELETE CASCADE,
  last_value integer NOT NULL
);
REVOKE ALL ON app.quality_objective_counters FROM PUBLIC, anon, authenticated;

CREATE TABLE public.quality_objectives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  reference text NOT NULL CHECK (reference ~ '^QO-[0-9]{3,}$'),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  description text CHECK (description IS NULL OR length(btrim(description)) BETWEEN 1 AND 2000),
  owner_user_id uuid NOT NULL REFERENCES auth.users (id),
  measure text NOT NULL CONSTRAINT quality_objectives_measure_known CHECK (app.quality_objective_measure(measure) IS NOT NULL),
  unit text CHECK (unit IS NULL OR length(btrim(unit)) BETWEEN 1 AND 20),
  direction text NOT NULL CHECK (direction IN ('at_least', 'at_most')),
  target numeric(16, 4) NOT NULL,
  frequency text NOT NULL CHECK (frequency IN ('monthly', 'quarterly', 'yearly')),
  starts_on date NOT NULL,
  active boolean NOT NULL DEFAULT true,
  retired_reason text CHECK (retired_reason IS NULL OR length(btrim(retired_reason)) BETWEEN 3 AND 500),
  retired_at timestamptz,
  retired_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT quality_objectives_reference_key UNIQUE (organisation_id, reference),
  CONSTRAINT quality_objectives_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT quality_objectives_period_check CHECK (starts_on = app.quality_objective_period(frequency, starts_on)),
  CONSTRAINT quality_objectives_retired_check CHECK (active = (retired_reason IS NULL AND retired_at IS NULL)),
  CONSTRAINT quality_objectives_system_measure_check CHECK (measure = 'manual' OR (unit = app.quality_objective_measure(measure) ->> 'unit' AND direction = app.quality_objective_measure(measure) ->> 'direction'))
);
CREATE INDEX quality_objectives_org_idx ON public.quality_objectives (organisation_id, active);
CREATE INDEX quality_objectives_owner_idx ON public.quality_objectives (organisation_id, owner_user_id);

CREATE TABLE public.quality_objective_values (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  objective_id uuid NOT NULL,
  period_start date NOT NULL,
  value numeric(16, 4) NOT NULL,
  note text CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 1000),
  status text NOT NULL DEFAULT 'current' CHECK (status IN ('current', 'superseded')),
  supersedes_id uuid REFERENCES public.quality_objective_values (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT quality_objective_values_objective_fkey FOREIGN KEY (objective_id, organisation_id) REFERENCES public.quality_objectives (id, organisation_id),
  CONSTRAINT quality_objective_values_correction_check CHECK (supersedes_id IS NULL OR note IS NOT NULL)
);
CREATE UNIQUE INDEX quality_objective_values_current_key ON public.quality_objective_values (objective_id, period_start) WHERE status = 'current';
CREATE INDEX quality_objective_values_objective_idx ON public.quality_objective_values (organisation_id, objective_id, period_start);

-- A value is a record: only current -> superseded, never deleted.
CREATE FUNCTION app.quality_objective_value_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A value is never deleted. Record a correction.' USING ERRCODE = 'QM027'; END IF;
  IF (to_jsonb(NEW) - 'status' - 'updated_at' - 'updated_by') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'updated_at' - 'updated_by')
     OR NOT (OLD.status = 'current' AND NEW.status = 'superseded') THEN
    RAISE EXCEPTION 'A value cannot be changed. Record a correction.' USING ERRCODE = 'QM027';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quality_objective_values_frozen BEFORE UPDATE OR DELETE ON public.quality_objective_values FOR EACH ROW EXECUTE FUNCTION app.quality_objective_value_frozen();

-- Objectives are never deleted; the reference, measure, frequency and first period never change.
CREATE FUNCTION app.quality_objective_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A quality objective is never deleted. Retire it with a reason.' USING ERRCODE = 'QM027'; END IF;
  IF (NEW.reference, NEW.measure, NEW.frequency, NEW.starts_on) IS DISTINCT FROM (OLD.reference, OLD.measure, OLD.frequency, OLD.starts_on) THEN
    RAISE EXCEPTION 'An objective''s reference, measure, frequency and first period never change. Retire it and define a new one.' USING ERRCODE = 'QM027';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quality_objectives_rules BEFORE UPDATE OR DELETE ON public.quality_objectives FOR EACH ROW EXECUTE FUNCTION app.quality_objective_rules();

-- Readable by management_review.read, or by the objective's owner.
CREATE FUNCTION app.quality_objective_readable(p_objective uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.quality_objectives o WHERE o.id = p_objective AND app.is_member(o.organisation_id)
                   AND (app.has_permission(o.organisation_id, 'management_review.read') OR o.owner_user_id = (SELECT auth.uid())))
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['quality_objectives', 'quality_objective_values'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION app.stamp_created()', t || '_stamp', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.touch_updated()', t || '_touch', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change()', t || '_org_immutable', t);
    EXECUTE format('CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION audit.record_change(''organisation_id'')', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
  END LOOP;
END $$;
CREATE POLICY quality_objectives_select ON public.quality_objectives FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'management_review.read') OR (owner_user_id = (SELECT auth.uid()) AND app.is_member(organisation_id)));
CREATE POLICY quality_objective_values_select ON public.quality_objective_values FOR SELECT TO authenticated
  USING (app.quality_objective_readable(objective_id));

-- ---------------------------------------------------------------------------
-- Functions (SECURITY DEFINER)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.assert_objective_manager(p_organisation_id uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT app.is_member(p_organisation_id) THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(p_organisation_id, 'management_review.manage') THEN
    RAISE EXCEPTION 'You are not allowed to manage quality objectives' USING ERRCODE = '42501';
  END IF;
END $$;

-- Create (p_id NULL) or change an objective.
-- Keys: title, description, ownerId (default: the caller), target, direction and unit (manual measures only), and on create only measure (default manual),
-- frequency (default monthly) and startsOn (any day: the period it falls in; default the current period). Keys present are set; null clears description (and unit).
CREATE FUNCTION app.save_quality_objective(p_organisation_id uuid, p_data jsonb, p_id uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  o public.quality_objectives%ROWTYPE; k text; v_n integer; v_measure text; v_def jsonb; v_freq text; v_start date;
  v_title text; v_desc text; v_owner uuid; v_unit text; v_dir text; v_target numeric;
BEGIN
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Send the objective as an object' USING ERRCODE = 'QM027'; END IF;
  IF p_id IS NOT NULL THEN
    SELECT * INTO o FROM public.quality_objectives WHERE id = p_id FOR UPDATE;
    IF NOT FOUND OR o.organisation_id IS DISTINCT FROM p_organisation_id OR NOT app.is_member(o.organisation_id) THEN RAISE EXCEPTION 'Objective not found' USING ERRCODE = 'P0002'; END IF;
  END IF;
  PERFORM app.assert_objective_manager(p_organisation_id);
  IF p_id IS NOT NULL AND NOT o.active THEN RAISE EXCEPTION '% is retired. Bring it back first.', o.reference USING ERRCODE = 'QM027'; END IF;
  FOR k IN SELECT jsonb_object_keys(p_data) LOOP
    IF k NOT IN ('title', 'description', 'ownerId', 'measure', 'unit', 'direction', 'target', 'frequency', 'startsOn') THEN
      RAISE EXCEPTION 'Unknown field %', k USING ERRCODE = 'QM027';
    END IF;
    IF p_id IS NOT NULL AND k IN ('measure', 'frequency', 'startsOn') THEN
      RAISE EXCEPTION 'The measure, frequency and first period are fixed once the objective exists' USING ERRCODE = 'QM027';
    END IF;
  END LOOP;

  v_measure := CASE WHEN p_id IS NULL THEN coalesce(nullif(p_data ->> 'measure', ''), 'manual') ELSE o.measure END;
  v_def := app.quality_objective_measure(v_measure);
  IF v_def IS NULL THEN RAISE EXCEPTION 'Unknown measure %', v_measure USING ERRCODE = 'QM027'; END IF;
  v_freq := CASE WHEN p_id IS NULL THEN coalesce(nullif(p_data ->> 'frequency', ''), 'monthly') ELSE o.frequency END;
  IF v_freq NOT IN ('monthly', 'quarterly', 'yearly') THEN RAISE EXCEPTION 'The frequency is monthly, quarterly or yearly' USING ERRCODE = 'QM027'; END IF;
  v_start := CASE WHEN p_id IS NULL THEN app.quality_objective_period(v_freq, coalesce(nullif(p_data ->> 'startsOn', '')::date, current_date)) ELSE o.starts_on END;

  v_title := CASE WHEN p_data ? 'title' THEN btrim(coalesce(p_data ->> 'title', '')) ELSE o.title END;
  IF v_title IS NULL OR length(v_title) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'The title is 1 to 200 characters' USING ERRCODE = 'QM027'; END IF;
  v_desc := CASE WHEN p_data ? 'description' THEN nullif(btrim(coalesce(p_data ->> 'description', '')), '') ELSE o.description END;
  IF length(v_desc) > 2000 THEN RAISE EXCEPTION 'The description is up to 2000 characters' USING ERRCODE = 'QM027'; END IF;
  v_owner := CASE WHEN p_data ? 'ownerId' THEN nullif(p_data ->> 'ownerId', '')::uuid WHEN p_id IS NULL THEN auth.uid() ELSE o.owner_user_id END;
  IF v_owner IS NULL OR NOT app.is_active_member_user(p_organisation_id, v_owner) THEN
    RAISE EXCEPTION 'The owner must be an active member of this organisation' USING ERRCODE = 'QM027';
  END IF;
  IF p_data ? 'target' AND jsonb_typeof(p_data -> 'target') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'The target is a number' USING ERRCODE = 'QM027'; END IF;
  v_target := CASE WHEN p_data ? 'target' THEN (p_data ->> 'target')::numeric ELSE o.target END;
  IF v_target IS NULL THEN RAISE EXCEPTION 'Give a target' USING ERRCODE = 'QM027'; END IF;
  IF abs(v_target) >= 1e12 THEN RAISE EXCEPTION 'The target is too large' USING ERRCODE = 'QM027'; END IF;

  IF v_measure = 'manual' THEN
    v_dir := CASE WHEN p_data ? 'direction' THEN p_data ->> 'direction' WHEN p_id IS NULL THEN 'at_least' ELSE o.direction END;
    v_unit := CASE WHEN p_data ? 'unit' THEN nullif(btrim(coalesce(p_data ->> 'unit', '')), '') ELSE o.unit END;
    IF v_dir IS NULL OR v_dir NOT IN ('at_least', 'at_most') THEN RAISE EXCEPTION 'The target is met "at least" or "at most"' USING ERRCODE = 'QM027'; END IF;
    IF length(v_unit) > 20 THEN RAISE EXCEPTION 'The unit is up to 20 characters' USING ERRCODE = 'QM027'; END IF;
  ELSE
    IF (p_data ? 'direction' AND p_data ->> 'direction' IS DISTINCT FROM v_def ->> 'direction') OR (p_data ? 'unit' AND p_data ->> 'unit' IS DISTINCT FROM v_def ->> 'unit') THEN
      RAISE EXCEPTION 'A system measure has its own unit and direction' USING ERRCODE = 'QM027';
    END IF;
    v_dir := v_def ->> 'direction';
    v_unit := v_def ->> 'unit';
    IF v_unit = '%' AND (v_target < 0 OR v_target > 100) THEN RAISE EXCEPTION 'A percentage target is 0 to 100' USING ERRCODE = 'QM027'; END IF;
    IF v_target < 0 THEN RAISE EXCEPTION 'The target is not below zero' USING ERRCODE = 'QM027'; END IF;
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO app.quality_objective_counters AS c (organisation_id, last_value) VALUES (p_organisation_id, 1)
    ON CONFLICT (organisation_id) DO UPDATE SET last_value = c.last_value + 1 RETURNING last_value INTO v_n;
    INSERT INTO public.quality_objectives (organisation_id, reference, title, description, owner_user_id, measure, unit, direction, target, frequency, starts_on)
    VALUES (p_organisation_id, 'QO-' || app.pad_number(v_n, 3), v_title, v_desc, v_owner, v_measure, v_unit, v_dir, v_target, v_freq, v_start)
    RETURNING id INTO p_id;
  ELSE
    UPDATE public.quality_objectives SET title = v_title, description = v_desc, owner_user_id = v_owner, unit = v_unit, direction = v_dir, target = v_target WHERE id = p_id;
  END IF;
  RETURN p_id;
END $$;

CREATE FUNCTION app.retire_quality_objective(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o public.quality_objectives%ROWTYPE;
BEGIN
  SELECT * INTO o FROM public.quality_objectives WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(o.organisation_id) THEN RAISE EXCEPTION 'Objective not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_objective_manager(o.organisation_id);
  IF NOT o.active THEN RAISE EXCEPTION '% is already retired', o.reference USING ERRCODE = 'QM027'; END IF;
  IF length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 3 AND 500 THEN RAISE EXCEPTION 'Say why it is retired (3 to 500 characters)' USING ERRCODE = 'QM027'; END IF;
  UPDATE public.quality_objectives SET active = false, retired_reason = btrim(p_reason), retired_at = now(), retired_by = auth.uid() WHERE id = p_id;
END $$;

CREATE FUNCTION app.reactivate_quality_objective(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o public.quality_objectives%ROWTYPE;
BEGIN
  SELECT * INTO o FROM public.quality_objectives WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(o.organisation_id) THEN RAISE EXCEPTION 'Objective not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_objective_manager(o.organisation_id);
  IF o.active THEN RAISE EXCEPTION '% is not retired', o.reference USING ERRCODE = 'QM027'; END IF;
  UPDATE public.quality_objectives SET active = true, retired_reason = NULL, retired_at = NULL, retired_by = NULL WHERE id = p_id;
END $$;

-- Record the value of a manual objective for one period (any day in it). A manager or the objective's owner. Replacing a value is a correction and needs a note.
CREATE FUNCTION app.record_quality_objective_value(p_objective uuid, p_day date, p_value numeric, p_note text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o public.quality_objectives%ROWTYPE; v_period date; v_old uuid; v_id uuid; v_note text := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  SELECT * INTO o FROM public.quality_objectives WHERE id = p_objective FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(o.organisation_id) OR NOT app.quality_objective_readable(o.id) THEN RAISE EXCEPTION 'Objective not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT (app.has_permission(o.organisation_id, 'management_review.manage') OR o.owner_user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Only the objective''s owner or a manager records its values' USING ERRCODE = '42501';
  END IF;
  IF o.measure <> 'manual' THEN RAISE EXCEPTION '% is measured by the system; its values are not typed in', o.reference USING ERRCODE = 'QM027'; END IF;
  IF NOT o.active THEN RAISE EXCEPTION '% is retired', o.reference USING ERRCODE = 'QM027'; END IF;
  IF p_day IS NULL OR p_value IS NULL THEN RAISE EXCEPTION 'Give the period and the value' USING ERRCODE = 'QM027'; END IF;
  IF abs(p_value) >= 1e12 THEN RAISE EXCEPTION 'The value is too large' USING ERRCODE = 'QM027'; END IF;
  IF length(v_note) > 1000 THEN RAISE EXCEPTION 'The note is up to 1000 characters' USING ERRCODE = 'QM027'; END IF;
  v_period := app.quality_objective_period(o.frequency, p_day);
  IF v_period < o.starts_on THEN RAISE EXCEPTION 'That period is before the objective''s first period' USING ERRCODE = 'QM027'; END IF;
  IF v_period > current_date THEN RAISE EXCEPTION 'That period has not started yet' USING ERRCODE = 'QM027'; END IF;
  SELECT id INTO v_old FROM public.quality_objective_values WHERE objective_id = o.id AND period_start = v_period AND status = 'current' FOR UPDATE;
  IF v_old IS NOT NULL THEN
    IF v_note IS NULL THEN RAISE EXCEPTION 'That period already has a value: say why it is corrected' USING ERRCODE = 'QM027'; END IF;
    UPDATE public.quality_objective_values SET status = 'superseded' WHERE id = v_old;
  END IF;
  INSERT INTO public.quality_objective_values (organisation_id, objective_id, period_start, value, note, supersedes_id)
  VALUES (o.organisation_id, o.id, v_period, p_value, v_note, v_old) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION app.quality_objective_measure(text), app.quality_objective_period(text, date), app.quality_objective_value_frozen(), app.quality_objective_rules(),
  app.quality_objective_readable(uuid), app.assert_objective_manager(uuid), app.save_quality_objective(uuid, jsonb, uuid), app.retire_quality_objective(uuid, text),
  app.reactivate_quality_objective(uuid), app.record_quality_objective_value(uuid, date, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.quality_objective_measure(text), app.quality_objective_period(text, date), app.quality_objective_readable(uuid),
  app.save_quality_objective(uuid, jsonb, uuid), app.retire_quality_objective(uuid, text), app.reactivate_quality_objective(uuid),
  app.record_quality_objective_value(uuid, date, numeric, text) TO authenticated;
