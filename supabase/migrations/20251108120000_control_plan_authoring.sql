-- Process control, slice PC2 (docs/process-control-plan.md §2, §6): plan authoring.
-- A control plan revision holds its own operations and characteristics; nothing is shared between
-- revisions, so an approved revision never changes. A stable characteristic_key identifies "the
-- same" characteristic across revisions (for comparison and SPC).
--
--  * control_plan_operations: operation code, sequence, name, optional machine or work centre;
--  * control_plan_characteristics: what to check at an operation —
--      data_type   variable (measured, with a unit) | attribute (pass/fail);
--      value_source plan (nominal/limits on the plan: "fixed / common")
--                 | part_spec (bound to a part revision value by spec_key: "variable / part-specific");
--      applies_to  all parts in scope | selected parts (listed in characteristic_applicability:
--                  "conditional") — explicit rows, never free-text rules;
--      method, required gauge type, criticality, SPC eligibility (I-MR with subgroup 1, X-bar/R 2–10);
--  * sampling_rules: structured frequency (first-off, every N minutes / parts, after tool change…);
--  * reaction_plans: what to do on an out-of-spec result, SPC signal, invalid gauge or missed check,
--    for one characteristic or the whole revision.
-- Every child row carries control_plan_revision_id, may only be added, changed or removed while the
-- revision is a draft, and is audited. A new revision copies the one it supersedes. A revision can
-- only be submitted with at least one characteristic, and every conditional characteristic must
-- name at least one part.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE public.control_plan_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  control_plan_revision_id uuid NOT NULL,
  operation_code text NOT NULL CHECK (operation_code ~ '^\S(.{0,28}\S)?$'),
  sequence integer NOT NULL DEFAULT 10 CHECK (sequence BETWEEN 0 AND 100000),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  machine_id uuid,
  work_centre text CHECK (work_centre IS NULL OR length(work_centre) <= 100),
  notes text CHECK (notes IS NULL OR length(notes) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT control_plan_operations_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT control_plan_operations_id_rev_key UNIQUE (id, control_plan_revision_id),
  CONSTRAINT control_plan_operations_revision_fkey FOREIGN KEY (control_plan_revision_id, organisation_id)
    REFERENCES public.control_plan_revisions (id, organisation_id),
  CONSTRAINT control_plan_operations_machine_fkey FOREIGN KEY (machine_id, organisation_id)
    REFERENCES public.machines (id, organisation_id)
);
CREATE UNIQUE INDEX control_plan_operations_code_key ON public.control_plan_operations (control_plan_revision_id, upper(operation_code));

CREATE TABLE public.control_plan_characteristics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  control_plan_revision_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  characteristic_key text NOT NULL CHECK (characteristic_key ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  sequence integer NOT NULL DEFAULT 10 CHECK (sequence BETWEEN 0 AND 100000),
  -- Balloon / characteristic number on the drawing, e.g. "12" or "B3".
  char_number text CHECK (char_number IS NULL OR length(char_number) <= 20),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  data_type text NOT NULL DEFAULT 'variable' CHECK (data_type IN ('variable', 'attribute')),
  value_source text NOT NULL DEFAULT 'plan' CHECK (value_source IN ('plan', 'part_spec')),
  applies_to text NOT NULL DEFAULT 'all' CHECK (applies_to IN ('all', 'selected')),
  nominal numeric,
  lower_limit numeric,
  upper_limit numeric,
  unit_code text REFERENCES public.units (code),
  spec_key text CHECK (spec_key IS NULL OR spec_key ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  method text CHECK (method IS NULL OR length(method) <= 500),
  gauge_type_id uuid,
  criticality text NOT NULL DEFAULT 'minor' CHECK (criticality IN ('critical', 'major', 'minor')),
  spc_eligible boolean NOT NULL DEFAULT false,
  chart_type text CHECK (chart_type IN ('imr', 'xbar_r')),
  subgroup_size integer,
  -- Display precision only; values are stored and compared unrounded.
  decimals integer CHECK (decimals IS NULL OR decimals BETWEEN 0 AND 6),
  notes text CHECK (notes IS NULL OR length(notes) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT control_plan_characteristics_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT control_plan_characteristics_id_rev_key UNIQUE (id, control_plan_revision_id),
  CONSTRAINT control_plan_characteristics_revision_fkey FOREIGN KEY (control_plan_revision_id, organisation_id)
    REFERENCES public.control_plan_revisions (id, organisation_id),
  -- The operation must belong to the same revision.
  CONSTRAINT control_plan_characteristics_operation_fkey FOREIGN KEY (operation_id, control_plan_revision_id)
    REFERENCES public.control_plan_operations (id, control_plan_revision_id),
  CONSTRAINT control_plan_characteristics_gauge_type_fkey FOREIGN KEY (gauge_type_id, organisation_id)
    REFERENCES public.gauge_types (id, organisation_id),
  CONSTRAINT control_plan_characteristics_values CHECK (
    CASE
      WHEN data_type = 'attribute' THEN
        value_source = 'plan' AND unit_code IS NULL AND nominal IS NULL AND lower_limit IS NULL
        AND upper_limit IS NULL AND spec_key IS NULL AND NOT spc_eligible
      WHEN value_source = 'plan' THEN
        unit_code IS NOT NULL AND spec_key IS NULL AND (lower_limit IS NOT NULL OR upper_limit IS NOT NULL)
        AND (lower_limit IS NULL OR upper_limit IS NULL OR lower_limit <= upper_limit)
        AND (nominal IS NULL OR ((lower_limit IS NULL OR nominal >= lower_limit) AND (upper_limit IS NULL OR nominal <= upper_limit)))
      ELSE
        unit_code IS NOT NULL AND spec_key IS NOT NULL AND nominal IS NULL AND lower_limit IS NULL AND upper_limit IS NULL
    END),
  CONSTRAINT control_plan_characteristics_spc CHECK (
    CASE WHEN spc_eligible THEN
      (chart_type = 'imr' AND subgroup_size = 1) OR (chart_type = 'xbar_r' AND subgroup_size BETWEEN 2 AND 10)
    ELSE chart_type IS NULL AND subgroup_size IS NULL END)
);
CREATE UNIQUE INDEX control_plan_characteristics_key ON public.control_plan_characteristics (control_plan_revision_id, characteristic_key);
CREATE INDEX control_plan_characteristics_operation_idx ON public.control_plan_characteristics (operation_id);

-- Parts a "selected parts" (conditional) characteristic applies to.
CREATE TABLE public.characteristic_applicability (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  control_plan_revision_id uuid NOT NULL,
  plan_characteristic_id uuid NOT NULL,
  part_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT characteristic_applicability_characteristic_fkey FOREIGN KEY (plan_characteristic_id, control_plan_revision_id)
    REFERENCES public.control_plan_characteristics (id, control_plan_revision_id) ON DELETE CASCADE,
  CONSTRAINT characteristic_applicability_revision_fkey FOREIGN KEY (control_plan_revision_id, organisation_id)
    REFERENCES public.control_plan_revisions (id, organisation_id),
  CONSTRAINT characteristic_applicability_part_fkey FOREIGN KEY (part_id, organisation_id)
    REFERENCES public.parts (id, organisation_id),
  CONSTRAINT characteristic_applicability_key UNIQUE (plan_characteristic_id, part_id)
);

CREATE TABLE public.sampling_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  control_plan_revision_id uuid NOT NULL,
  plan_characteristic_id uuid NOT NULL,
  trigger_type text NOT NULL CHECK (trigger_type IN ('first_off', 'last_off', 'every_n_minutes', 'every_n_parts',
                                                     'start_of_shift', 'after_tool_change', 'after_setup', 'manual')),
  -- Minutes for every_n_minutes, parts for every_n_parts; empty otherwise.
  interval_value integer CHECK (interval_value IS NULL OR interval_value BETWEEN 1 AND 100000),
  sample_size integer NOT NULL DEFAULT 1 CHECK (sample_size BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT sampling_rules_characteristic_fkey FOREIGN KEY (plan_characteristic_id, control_plan_revision_id)
    REFERENCES public.control_plan_characteristics (id, control_plan_revision_id) ON DELETE CASCADE,
  CONSTRAINT sampling_rules_revision_fkey FOREIGN KEY (control_plan_revision_id, organisation_id)
    REFERENCES public.control_plan_revisions (id, organisation_id),
  CONSTRAINT sampling_rules_interval CHECK ((interval_value IS NOT NULL) = (trigger_type IN ('every_n_minutes', 'every_n_parts'))),
  CONSTRAINT sampling_rules_one_per_trigger UNIQUE (plan_characteristic_id, trigger_type)
);

CREATE TABLE public.reaction_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  control_plan_revision_id uuid NOT NULL,
  -- Empty: applies to every characteristic of the revision.
  plan_characteristic_id uuid,
  trigger_type text NOT NULL CHECK (trigger_type IN ('out_of_spec', 'spc_signal', 'gauge_invalid', 'missed_check')),
  action text NOT NULL CHECK (action IN ('warn', 'hold', 'stop', 'notify', 'raise_ncr')),
  instruction text NOT NULL CHECK (length(trim(instruction)) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT reaction_plans_characteristic_fkey FOREIGN KEY (plan_characteristic_id, control_plan_revision_id)
    REFERENCES public.control_plan_characteristics (id, control_plan_revision_id) ON DELETE CASCADE,
  CONSTRAINT reaction_plans_revision_fkey FOREIGN KEY (control_plan_revision_id, organisation_id)
    REFERENCES public.control_plan_revisions (id, organisation_id)
);
CREATE INDEX reaction_plans_revision_idx ON public.reaction_plans (control_plan_revision_id);

-- ---------------------------------------------------------------------------
-- Rules
-- ---------------------------------------------------------------------------
-- Children of a revision change only while it is a draft (signed-in users; data migrations and the
-- copy into a new draft run as the system).
CREATE FUNCTION app.control_plan_child_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_row record := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  v_rev record;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.control_plan_revision_id <> OLD.control_plan_revision_id THEN
    RAISE EXCEPTION 'A plan entry cannot move to another revision' USING ERRCODE = 'QM007';
  END IF;
  IF coalesce(auth.role(), '') = 'authenticated' THEN
    SELECT revision_code, status INTO v_rev FROM public.control_plan_revisions WHERE id = v_row.control_plan_revision_id;
    IF v_rev.status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'Revision % is % and can no longer be edited; create a new revision', v_rev.revision_code, replace(v_rev.status, '_', ' ')
        USING ERRCODE = 'QM007';
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'control_plan_operations' AND TG_OP = 'DELETE'
     AND EXISTS (SELECT 1 FROM public.control_plan_characteristics c WHERE c.operation_id = OLD.id) THEN
    RAISE EXCEPTION 'Operation % still has characteristics; move or remove them first', OLD.operation_code USING ERRCODE = 'QM007';
  END IF;
  IF TG_TABLE_NAME = 'control_plan_operations' AND TG_OP <> 'DELETE' THEN
    NEW.operation_code := upper(trim(NEW.operation_code));
  END IF;
  -- (Nested: PL/pgSQL would resolve the field on every table if it were in one condition.)
  IF TG_TABLE_NAME = 'control_plan_characteristics' AND TG_OP = 'UPDATE' THEN
    IF NEW.characteristic_key <> OLD.characteristic_key THEN
      RAISE EXCEPTION 'A characteristic key identifies it across revisions and cannot be changed' USING ERRCODE = 'QM007';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

-- A conditional characteristic lists parts that are in the plan's scope.
CREATE FUNCTION app.characteristic_applicability_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_applies text;
BEGIN
  SELECT applies_to INTO v_applies FROM public.control_plan_characteristics WHERE id = NEW.plan_characteristic_id;
  IF v_applies IS DISTINCT FROM 'selected' THEN
    RAISE EXCEPTION 'Parts are only listed for characteristics that apply to selected parts' USING ERRCODE = 'QM007';
  END IF;
  -- Checked for direct edits; a copy into a new revision keeps the previous list as it was.
  IF coalesce(auth.role(), '') = 'authenticated' AND pg_trigger_depth() <= 1 AND NOT EXISTS (
       SELECT 1 FROM public.control_plan_revisions r
       JOIN public.control_plan_applicability a ON a.control_plan_id = r.control_plan_id
       JOIN public.parts p ON p.id = NEW.part_id AND p.part_family_id = a.part_family_id AND (a.part_id IS NULL OR a.part_id = p.id)
       WHERE r.id = NEW.control_plan_revision_id) THEN
    RAISE EXCEPTION 'The part is not in this plan''s scope' USING ERRCODE = 'QM007';
  END IF;
  RETURN NEW;
END $$;

-- Switching a characteristic back to "all parts" clears its part list.
CREATE FUNCTION app.control_plan_characteristic_after() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.applies_to = 'all' AND OLD.applies_to = 'selected' THEN
    DELETE FROM public.characteristic_applicability WHERE plan_characteristic_id = NEW.id;
  END IF;
  RETURN NULL;
END $$;

-- A new revision starts as a copy of the revision it supersedes (operations, characteristics, part
-- lists, sampling rules and reactions). Runs as the system, so the source may be approved.
CREATE FUNCTION app.control_plan_revision_copy() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  op record;
  ch record;
  v_new_op uuid;
  v_new_ch uuid;
BEGIN
  IF NEW.supersedes_revision_id IS NULL THEN
    RETURN NULL;
  END IF;
  -- Revision-wide reactions.
  INSERT INTO public.reaction_plans (organisation_id, control_plan_revision_id, trigger_type, action, instruction)
  SELECT NEW.organisation_id, NEW.id, r.trigger_type, r.action, r.instruction
  FROM public.reaction_plans r WHERE r.control_plan_revision_id = NEW.supersedes_revision_id AND r.plan_characteristic_id IS NULL;
  FOR op IN SELECT * FROM public.control_plan_operations WHERE control_plan_revision_id = NEW.supersedes_revision_id LOOP
    INSERT INTO public.control_plan_operations (organisation_id, control_plan_revision_id, operation_code, sequence, name, machine_id, work_centre, notes)
    VALUES (NEW.organisation_id, NEW.id, op.operation_code, op.sequence, op.name, op.machine_id, op.work_centre, op.notes)
    RETURNING id INTO v_new_op;
    FOR ch IN SELECT * FROM public.control_plan_characteristics WHERE operation_id = op.id LOOP
      INSERT INTO public.control_plan_characteristics (
        organisation_id, control_plan_revision_id, operation_id, characteristic_key, sequence, char_number, name, data_type,
        value_source, applies_to, nominal, lower_limit, upper_limit, unit_code, spec_key, method, gauge_type_id, criticality,
        spc_eligible, chart_type, subgroup_size, decimals, notes)
      VALUES (
        NEW.organisation_id, NEW.id, v_new_op, ch.characteristic_key, ch.sequence, ch.char_number, ch.name, ch.data_type,
        ch.value_source, ch.applies_to, ch.nominal, ch.lower_limit, ch.upper_limit, ch.unit_code, ch.spec_key, ch.method,
        ch.gauge_type_id, ch.criticality, ch.spc_eligible, ch.chart_type, ch.subgroup_size, ch.decimals, ch.notes)
      RETURNING id INTO v_new_ch;
      INSERT INTO public.characteristic_applicability (organisation_id, control_plan_revision_id, plan_characteristic_id, part_id)
      SELECT NEW.organisation_id, NEW.id, v_new_ch, a.part_id FROM public.characteristic_applicability a WHERE a.plan_characteristic_id = ch.id;
      INSERT INTO public.sampling_rules (organisation_id, control_plan_revision_id, plan_characteristic_id, trigger_type, interval_value, sample_size)
      SELECT NEW.organisation_id, NEW.id, v_new_ch, s.trigger_type, s.interval_value, s.sample_size FROM public.sampling_rules s WHERE s.plan_characteristic_id = ch.id;
      INSERT INTO public.reaction_plans (organisation_id, control_plan_revision_id, plan_characteristic_id, trigger_type, action, instruction)
      SELECT NEW.organisation_id, NEW.id, v_new_ch, r.trigger_type, r.action, r.instruction FROM public.reaction_plans r WHERE r.plan_characteristic_id = ch.id;
    END LOOP;
  END LOOP;
  RETURN NULL;
END $$;

-- Submitting needs content: at least one characteristic, and every conditional one names parts.
CREATE FUNCTION app.control_plan_revision_content_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_missing text;
BEGIN
  IF NEW.status = 'pending_approval' AND OLD.status = 'draft' THEN
    IF NOT EXISTS (SELECT 1 FROM public.control_plan_characteristics WHERE control_plan_revision_id = NEW.id) THEN
      RAISE EXCEPTION 'Add at least one characteristic before submitting revision %', NEW.revision_code USING ERRCODE = 'QM007';
    END IF;
    SELECT string_agg(c.characteristic_key, ', ' ORDER BY c.characteristic_key) INTO v_missing
    FROM public.control_plan_characteristics c
    WHERE c.control_plan_revision_id = NEW.id AND c.applies_to = 'selected'
      AND NOT EXISTS (SELECT 1 FROM public.characteristic_applicability a WHERE a.plan_characteristic_id = c.id);
    IF v_missing IS NOT NULL THEN
      RAISE EXCEPTION 'Choose the parts for the conditional characteristics: %', v_missing USING ERRCODE = 'QM007';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER control_plan_revisions_copy AFTER INSERT ON public.control_plan_revisions
  FOR EACH ROW EXECUTE FUNCTION app.control_plan_revision_copy();
CREATE TRIGGER control_plan_revisions_content BEFORE UPDATE OF status ON public.control_plan_revisions
  FOR EACH ROW EXECUTE FUNCTION app.control_plan_revision_content_check();
CREATE TRIGGER characteristic_applicability_rules BEFORE INSERT OR UPDATE ON public.characteristic_applicability
  FOR EACH ROW EXECUTE FUNCTION app.characteristic_applicability_rules();
CREATE TRIGGER control_plan_characteristics_after AFTER UPDATE OF applies_to ON public.control_plan_characteristics
  FOR EACH ROW EXECUTE FUNCTION app.control_plan_characteristic_after();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['control_plan_operations', 'control_plan_characteristics', 'characteristic_applicability',
                           'sampling_rules', 'reaction_plans'] LOOP
    EXECUTE format('CREATE TRIGGER %1$s_draft_only BEFORE INSERT OR UPDATE OR DELETE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION app.control_plan_child_rules()', t);
    EXECUTE format('CREATE TRIGGER %1$s_stamp BEFORE INSERT ON public.%1$I FOR EACH ROW EXECUTE FUNCTION app.stamp_created()', t);
    EXECUTE format('CREATE TRIGGER %1$s_touch BEFORE UPDATE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION app.touch_updated()', t);
    EXECUTE format('CREATE TRIGGER %1$s_org_immutable BEFORE UPDATE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change()', t);
    EXECUTE format('CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.%I '
                   'FOR EACH ROW EXECUTE FUNCTION audit.record_change(''organisation_id'')', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT, INSERT, DELETE ON public.%I TO authenticated', t);
    EXECUTE format('CREATE POLICY %1$s_select ON public.%1$I FOR SELECT TO authenticated '
                   'USING (app.has_permission(organisation_id, ''process_control.read''))', t);
    EXECUTE format('CREATE POLICY %1$s_insert ON public.%1$I FOR INSERT TO authenticated '
                   'WITH CHECK (app.has_permission(organisation_id, ''process_control.manage''))', t);
    EXECUTE format('CREATE POLICY %1$s_update ON public.%1$I FOR UPDATE TO authenticated '
                   'USING (app.has_permission(organisation_id, ''process_control.manage'')) '
                   'WITH CHECK (app.has_permission(organisation_id, ''process_control.manage''))', t);
    EXECUTE format('CREATE POLICY %1$s_delete ON public.%1$I FOR DELETE TO authenticated '
                   'USING (app.has_permission(organisation_id, ''process_control.manage''))', t);
  END LOOP;
END $$;

GRANT UPDATE (operation_code, sequence, name, machine_id, work_centre, notes) ON public.control_plan_operations TO authenticated;
GRANT UPDATE (operation_id, sequence, char_number, name, data_type, value_source, applies_to, nominal, lower_limit, upper_limit,
              unit_code, spec_key, method, gauge_type_id, criticality, spc_eligible, chart_type, subgroup_size, decimals, notes)
  ON public.control_plan_characteristics TO authenticated;
GRANT UPDATE (interval_value, sample_size) ON public.sampling_rules TO authenticated;
GRANT UPDATE (trigger_type, action, instruction) ON public.reaction_plans TO authenticated;

REVOKE ALL ON FUNCTION app.control_plan_child_rules(), app.characteristic_applicability_rules(), app.control_plan_characteristic_after(),
  app.control_plan_revision_copy(), app.control_plan_revision_content_check() FROM PUBLIC;

-- History now also covers the content of the plan's revisions. Updates carry only changed fields,
-- so rows are matched by id; removed rows by the revision id in their delete event.
CREATE OR REPLACE FUNCTION app.control_plan_history(p_control_plan_id uuid)
RETURNS TABLE (id uuid, created_at timestamptz, actor_user_id uuid, entity_type text, entity_id text, action text,
               changed_fields text[], previous_values jsonb, new_values jsonb, reason text, source text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH revs AS (SELECT r.id FROM public.control_plan_revisions r WHERE r.control_plan_id = p_control_plan_id),
  children AS (
    SELECT o.id FROM public.control_plan_operations o WHERE o.control_plan_revision_id IN (SELECT id FROM revs)
    UNION ALL SELECT c.id FROM public.control_plan_characteristics c WHERE c.control_plan_revision_id IN (SELECT id FROM revs)
    UNION ALL SELECT a.id FROM public.characteristic_applicability a WHERE a.control_plan_revision_id IN (SELECT id FROM revs)
    UNION ALL SELECT s.id FROM public.sampling_rules s WHERE s.control_plan_revision_id IN (SELECT id FROM revs)
    UNION ALL SELECT x.id FROM public.reaction_plans x WHERE x.control_plan_revision_id IN (SELECT id FROM revs)
  )
  SELECT e.id, e.created_at, e.actor_user_id, e.entity_type, e.entity_id, e.action, e.changed_fields,
         e.previous_values, e.new_values, e.reason, e.source
  FROM audit.events e
  JOIN public.control_plans p ON p.id = p_control_plan_id
  WHERE e.organisation_id = p.organisation_id
    AND app.has_permission(p.organisation_id, 'process_control.read')
    AND ((e.entity_type = 'control_plans' AND e.entity_id = p_control_plan_id::text)
      OR (e.entity_type = 'control_plan_revisions' AND e.entity_id IN (SELECT id::text FROM revs))
      OR (e.entity_type = 'control_plan_applicability'
          AND (e.entity_id IN (SELECT a.id::text FROM public.control_plan_applicability a WHERE a.control_plan_id = p_control_plan_id)
               OR e.new_values ->> 'control_plan_id' = p_control_plan_id::text
               OR e.previous_values ->> 'control_plan_id' = p_control_plan_id::text))
      OR (e.entity_type IN ('control_plan_operations', 'control_plan_characteristics', 'characteristic_applicability',
                            'sampling_rules', 'reaction_plans')
          AND (e.entity_id IN (SELECT id::text FROM children)
               OR e.new_values ->> 'control_plan_revision_id' IN (SELECT id::text FROM revs)
               OR e.previous_values ->> 'control_plan_revision_id' IN (SELECT id::text FROM revs))))
  ORDER BY e.seq
$$;
