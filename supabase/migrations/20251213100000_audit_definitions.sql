-- Audits, slice AU1 (docs/audits-plan.md): the audit DEFINITIONS the quality team writes: procedure, checklist, what it is relevant to (machines, operations,
-- departments), how often, who is expected to do it and when it passes. Schedule (AU2) and records (AU3) come in later migrations.
--
--  * The header is written under RLS by people with audits.manage (INSERT and column-level UPDATE). Status (active / retired) moves only through functions.
--  * The checklist and the "relevant to" list are replaced as a whole by app.set_audit_checklist / app.set_audit_targets (the tables themselves are read-only
--    to everyone), so an edit is always one consistent version. Editing a definition is allowed at any time and is audited; records keep their own frozen copy (AU3).
--  * Numbering AUD-001, AUD-002 … per organisation (counter not reachable by users). Nothing is deleted: a definition is retired.
--  * Errors QM018 → 409 audit_rule (messages written for users).

INSERT INTO public.permissions (code, description) VALUES
  ('audits.read',    'View audits, the audit schedule and audit records'),
  ('audits.manage',  'Define, edit and retire audits and skip scheduled audits'),
  ('audits.perform', 'Carry out audits and record the results');

WITH grants(key, perms) AS (VALUES
  ('owner',            ARRAY['audits.read', 'audits.manage', 'audits.perform']),
  ('admin',            ARRAY['audits.read', 'audits.manage', 'audits.perform']),
  ('quality_manager',  ARRAY['audits.read', 'audits.manage', 'audits.perform']),
  ('quality_engineer', ARRAY['audits.read', 'audits.manage', 'audits.perform']),
  ('inspector',        ARRAY['audits.read', 'audits.perform']),
  ('viewer',           ARRAY['audits.read'])
)
INSERT INTO public.role_permissions (role_id, permission_code)
SELECT r.id, unnest(g.perms) FROM public.roles r JOIN grants g ON g.key = r.key WHERE r.is_system
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Numbering
-- ---------------------------------------------------------------------------
CREATE TABLE app.audit_counters (
  organisation_id uuid PRIMARY KEY REFERENCES public.organisations (id) ON DELETE CASCADE,
  last_value integer NOT NULL DEFAULT 0
);

CREATE FUNCTION app.next_audit_number(p_organisation_id uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_n integer;
BEGIN
  INSERT INTO app.audit_counters AS c (organisation_id, last_value) VALUES (p_organisation_id, 1)
  ON CONFLICT (organisation_id) DO UPDATE SET last_value = c.last_value + 1
  RETURNING last_value INTO v_n;
  RETURN v_n;
END $$;

-- ---------------------------------------------------------------------------
-- The definition
-- ---------------------------------------------------------------------------
CREATE TABLE public.audit_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  audit_number integer NOT NULL,
  reference text NOT NULL,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  audit_type text NOT NULL CHECK (audit_type IN ('process', 'product', 'system', 'supplier', 'housekeeping', 'layered_process', 'other')),
  purpose text CHECK (purpose IS NULL OR length(btrim(purpose)) BETWEEN 1 AND 2000),
  -- The written steps the auditor follows.
  procedure text CHECK (procedure IS NULL OR length(btrim(procedure)) BETWEEN 1 AND 20000),
  frequency_kind text NOT NULL DEFAULT 'monthly' CHECK (frequency_kind IN ('daily', 'weekly', 'monthly', 'quarterly', 'six_monthly', 'yearly', 'every_n_days', 'on_demand')),
  frequency_interval integer CHECK (frequency_interval IS NULL OR frequency_interval BETWEEN 1 AND 366),
  first_due_on date,
  grace_days integer NOT NULL DEFAULT 0 CHECK (grace_days BETWEEN 0 AND 60),
  weekdays_only boolean NOT NULL DEFAULT false,
  auditor_kind text NOT NULL DEFAULT 'none' CHECK (auditor_kind IN ('none', 'person', 'role', 'department')),
  auditor_user_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  auditor_role_id uuid REFERENCES public.roles (id) ON DELETE SET NULL,
  auditor_department_id uuid,
  -- Every critical question must pass AND the score (passes / answered, not applicable left out) must reach this percentage.
  pass_mark integer NOT NULL DEFAULT 100 CHECK (pass_mark BETWEEN 0 AND 100),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  retired_at timestamptz,
  retired_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  retired_reason text CHECK (retired_reason IS NULL OR length(btrim(retired_reason)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT audit_definitions_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT audit_definitions_number_key UNIQUE (organisation_id, audit_number),
  CONSTRAINT audit_definitions_department_fkey FOREIGN KEY (auditor_department_id, organisation_id) REFERENCES public.departments (id, organisation_id),
  CONSTRAINT audit_definitions_frequency CHECK (
    (frequency_kind = 'on_demand' AND first_due_on IS NULL AND frequency_interval IS NULL)
    OR (frequency_kind = 'every_n_days' AND first_due_on IS NOT NULL AND frequency_interval IS NOT NULL)
    OR (frequency_kind NOT IN ('on_demand', 'every_n_days') AND first_due_on IS NOT NULL AND frequency_interval IS NULL)),
  CONSTRAINT audit_definitions_auditor CHECK (
    (auditor_kind = 'none' AND auditor_user_id IS NULL AND auditor_role_id IS NULL AND auditor_department_id IS NULL)
    OR (auditor_kind = 'person' AND auditor_user_id IS NOT NULL AND auditor_role_id IS NULL AND auditor_department_id IS NULL)
    OR (auditor_kind = 'role' AND auditor_role_id IS NOT NULL AND auditor_user_id IS NULL AND auditor_department_id IS NULL)
    OR (auditor_kind = 'department' AND auditor_department_id IS NOT NULL AND auditor_user_id IS NULL AND auditor_role_id IS NULL)),
  CONSTRAINT audit_definitions_retired CHECK ((status = 'retired') = (retired_at IS NOT NULL) AND (retired_at IS NULL OR retired_reason IS NOT NULL))
);
CREATE INDEX audit_definitions_status_idx ON public.audit_definitions (organisation_id, status, audit_number);

CREATE FUNCTION app.audit_definition_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.audit_number := app.next_audit_number(NEW.organisation_id);
    NEW.reference := 'AUD-' || lpad(NEW.audit_number::text, 3, '0');
    IF coalesce(auth.role(), '') = 'authenticated' THEN
      NEW.status := 'active'; NEW.retired_at := NULL; NEW.retired_by := NULL; NEW.retired_reason := NULL;
    END IF;
  ELSIF NEW.audit_number <> OLD.audit_number OR NEW.reference <> OLD.reference THEN
    RAISE EXCEPTION 'The number of an audit cannot change' USING ERRCODE = 'QM018';
  END IF;
  -- The expected auditor must belong to this organisation: a person who is an active member, or a role it can use.
  IF NEW.auditor_user_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.organisation_users ou WHERE ou.organisation_id = NEW.organisation_id AND ou.user_id = NEW.auditor_user_id AND ou.status = 'active') THEN
    RAISE EXCEPTION 'The auditor must be an active member of this organisation' USING ERRCODE = 'QM018';
  END IF;
  IF NEW.auditor_role_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.roles r WHERE r.id = NEW.auditor_role_id AND (r.organisation_id = NEW.organisation_id OR r.organisation_id IS NULL)) THEN
    RAISE EXCEPTION 'That role cannot be used in this organisation' USING ERRCODE = 'QM018';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER audit_definitions_stamp BEFORE INSERT ON public.audit_definitions FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER audit_definitions_rules BEFORE INSERT OR UPDATE ON public.audit_definitions FOR EACH ROW EXECUTE FUNCTION app.audit_definition_rules();
CREATE TRIGGER audit_definitions_touch BEFORE UPDATE ON public.audit_definitions FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER audit_definitions_org_immutable BEFORE UPDATE ON public.audit_definitions FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.audit_definitions FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');

-- ---------------------------------------------------------------------------
-- The checklist
-- ---------------------------------------------------------------------------
CREATE TABLE public.audit_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  audit_definition_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 500),
  question text NOT NULL CHECK (length(btrim(question)) BETWEEN 1 AND 500),
  guidance text CHECK (guidance IS NULL OR length(btrim(guidance)) BETWEEN 1 AND 2000),
  -- pass_fail: pass / fail / not applicable. yes_no: yes / no / not applicable, with the answer that passes. number: a reading within limits. text: a note, never scored.
  answer_type text NOT NULL CHECK (answer_type IN ('pass_fail', 'yes_no', 'number', 'text')),
  pass_answer text CHECK (pass_answer IS NULL OR pass_answer IN ('yes', 'no')),
  unit text CHECK (unit IS NULL OR length(btrim(unit)) BETWEEN 1 AND 20),
  lower_limit numeric,
  upper_limit numeric,
  critical boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT audit_questions_definition_fkey FOREIGN KEY (audit_definition_id, organisation_id) REFERENCES public.audit_definitions (id, organisation_id),
  CONSTRAINT audit_questions_sequence_key UNIQUE (audit_definition_id, sequence),
  CONSTRAINT audit_questions_shape CHECK (
    (answer_type = 'yes_no') = (pass_answer IS NOT NULL)
    AND (answer_type = 'number' OR (unit IS NULL AND lower_limit IS NULL AND upper_limit IS NULL))
    AND (answer_type <> 'number' OR (lower_limit IS NOT NULL OR upper_limit IS NOT NULL))
    AND (lower_limit IS NULL OR upper_limit IS NULL OR lower_limit <= upper_limit)
    AND (answer_type <> 'text' OR NOT critical))
);
CREATE INDEX audit_questions_definition_idx ON public.audit_questions (audit_definition_id, sequence);

-- ---------------------------------------------------------------------------
-- What the audit is relevant to
-- ---------------------------------------------------------------------------
CREATE TABLE public.audit_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  audit_definition_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('machine', 'operation', 'department')),
  machine_id uuid,
  operation_code text CHECK (operation_code IS NULL OR operation_code ~ '^\S(.{0,38}\S)?$'),
  department_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT audit_targets_definition_fkey FOREIGN KEY (audit_definition_id, organisation_id) REFERENCES public.audit_definitions (id, organisation_id),
  CONSTRAINT audit_targets_machine_fkey FOREIGN KEY (machine_id, organisation_id) REFERENCES public.machines (id, organisation_id),
  CONSTRAINT audit_targets_department_fkey FOREIGN KEY (department_id, organisation_id) REFERENCES public.departments (id, organisation_id),
  CONSTRAINT audit_targets_shape CHECK (
    (kind = 'machine' AND machine_id IS NOT NULL AND operation_code IS NULL AND department_id IS NULL)
    OR (kind = 'operation' AND operation_code IS NOT NULL AND machine_id IS NULL AND department_id IS NULL)
    OR (kind = 'department' AND department_id IS NOT NULL AND machine_id IS NULL AND operation_code IS NULL))
);
CREATE UNIQUE INDEX audit_targets_machine_key ON public.audit_targets (audit_definition_id, machine_id) WHERE machine_id IS NOT NULL;
CREATE UNIQUE INDEX audit_targets_operation_key ON public.audit_targets (audit_definition_id, upper(operation_code)) WHERE operation_code IS NOT NULL;
CREATE UNIQUE INDEX audit_targets_department_key ON public.audit_targets (audit_definition_id, department_id) WHERE department_id IS NOT NULL;
CREATE INDEX audit_targets_machine_idx ON public.audit_targets (machine_id) WHERE machine_id IS NOT NULL;

CREATE TRIGGER audit_questions_stamp BEFORE INSERT ON public.audit_questions FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER audit_questions_touch BEFORE UPDATE ON public.audit_questions FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER audit_targets_stamp BEFORE INSERT ON public.audit_targets FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER audit_targets_touch BEFORE UPDATE ON public.audit_targets FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.audit_questions FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.audit_targets FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');

-- ---------------------------------------------------------------------------
-- Functions: replace the checklist or the "relevant to" list as a whole; retire and reactivate.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.audit_definition_for_manage(p_id uuid) RETURNS public.audit_definitions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE d public.audit_definitions%ROWTYPE;
BEGIN
  SELECT * INTO d FROM public.audit_definitions WHERE id = p_id;
  IF NOT FOUND OR NOT app.has_permission(d.organisation_id, 'audits.read') THEN
    RAISE EXCEPTION 'Audit not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT app.has_permission(d.organisation_id, 'audits.manage') THEN
    RAISE EXCEPTION 'Changing audits needs the audits.manage permission' USING ERRCODE = '42501';
  END IF;
  RETURN d;
END $$;

-- p_questions: [{ question, guidance?, answerType, passAnswer?, unit?, lowerLimit?, upperLimit?, critical? }] in the order they are asked.
CREATE FUNCTION app.set_audit_checklist(p_definition uuid, p_questions jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  d public.audit_definitions%ROWTYPE;
  q jsonb;
  i integer := 0;
  v_type text;
BEGIN
  d := app.audit_definition_for_manage(p_definition);
  IF p_questions IS NULL OR jsonb_typeof(p_questions) <> 'array' THEN
    RAISE EXCEPTION 'The checklist must be a list of questions' USING ERRCODE = 'QM018';
  END IF;
  IF jsonb_array_length(p_questions) > 100 THEN
    RAISE EXCEPTION 'A checklist can have at most 100 questions' USING ERRCODE = 'QM018';
  END IF;
  DELETE FROM public.audit_questions WHERE audit_definition_id = p_definition;
  FOR q IN SELECT * FROM jsonb_array_elements(p_questions) LOOP
    i := i + 1;
    v_type := q->>'answerType';
    IF v_type IS NULL OR v_type NOT IN ('pass_fail', 'yes_no', 'number', 'text') THEN
      RAISE EXCEPTION 'Question %: choose how it is answered', i USING ERRCODE = 'QM018';
    END IF;
    IF length(btrim(coalesce(q->>'question', ''))) = 0 THEN
      RAISE EXCEPTION 'Question %: write the question', i USING ERRCODE = 'QM018';
    END IF;
    IF v_type = 'number' AND (q->>'lowerLimit') IS NULL AND (q->>'upperLimit') IS NULL THEN
      RAISE EXCEPTION 'Question %: give a lower or an upper limit for a number', i USING ERRCODE = 'QM018';
    END IF;
    IF v_type = 'text' AND coalesce((q->>'critical')::boolean, false) THEN
      RAISE EXCEPTION 'Question %: a note cannot be critical, it is not scored', i USING ERRCODE = 'QM018';
    END IF;
    INSERT INTO public.audit_questions (organisation_id, audit_definition_id, sequence, question, guidance, answer_type, pass_answer, unit, lower_limit, upper_limit, critical)
    VALUES (d.organisation_id, p_definition, i, btrim(q->>'question'), nullif(btrim(coalesce(q->>'guidance', '')), ''), v_type,
            CASE WHEN v_type = 'yes_no' THEN coalesce(nullif(q->>'passAnswer', ''), 'yes') END,
            CASE WHEN v_type = 'number' THEN nullif(btrim(coalesce(q->>'unit', '')), '') END,
            CASE WHEN v_type = 'number' THEN (q->>'lowerLimit')::numeric END,
            CASE WHEN v_type = 'number' THEN (q->>'upperLimit')::numeric END,
            coalesce((q->>'critical')::boolean, false));
  END LOOP;
  UPDATE public.audit_definitions SET updated_at = now() WHERE id = p_definition;
END $$;

-- p_targets: [{ kind: 'machine', machineId } | { kind: 'operation', operationCode } | { kind: 'department', departmentId }]
CREATE FUNCTION app.set_audit_targets(p_definition uuid, p_targets jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  d public.audit_definitions%ROWTYPE;
  t jsonb;
BEGIN
  d := app.audit_definition_for_manage(p_definition);
  IF p_targets IS NULL OR jsonb_typeof(p_targets) <> 'array' THEN
    RAISE EXCEPTION 'What the audit is relevant to must be a list' USING ERRCODE = 'QM018';
  END IF;
  IF jsonb_array_length(p_targets) > 200 THEN
    RAISE EXCEPTION 'An audit can be relevant to at most 200 machines, operations or departments' USING ERRCODE = 'QM018';
  END IF;
  DELETE FROM public.audit_targets WHERE audit_definition_id = p_definition;
  FOR t IN SELECT * FROM jsonb_array_elements(p_targets) LOOP
    IF (t->>'kind') = 'machine' THEN
      IF NOT EXISTS (SELECT 1 FROM public.machines WHERE id = (t->>'machineId')::uuid AND organisation_id = d.organisation_id) THEN
        RAISE EXCEPTION 'Machine not found' USING ERRCODE = 'P0002';
      END IF;
      INSERT INTO public.audit_targets (organisation_id, audit_definition_id, kind, machine_id) VALUES (d.organisation_id, p_definition, 'machine', (t->>'machineId')::uuid);
    ELSIF (t->>'kind') = 'operation' THEN
      INSERT INTO public.audit_targets (organisation_id, audit_definition_id, kind, operation_code) VALUES (d.organisation_id, p_definition, 'operation', btrim(t->>'operationCode'));
    ELSIF (t->>'kind') = 'department' THEN
      IF NOT EXISTS (SELECT 1 FROM public.departments WHERE id = (t->>'departmentId')::uuid AND organisation_id = d.organisation_id) THEN
        RAISE EXCEPTION 'Department not found' USING ERRCODE = 'P0002';
      END IF;
      INSERT INTO public.audit_targets (organisation_id, audit_definition_id, kind, department_id) VALUES (d.organisation_id, p_definition, 'department', (t->>'departmentId')::uuid);
    ELSE
      RAISE EXCEPTION 'Choose a machine, an operation or a department' USING ERRCODE = 'QM018';
    END IF;
  END LOOP;
  UPDATE public.audit_definitions SET updated_at = now() WHERE id = p_definition;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'The same machine, operation or department is listed twice' USING ERRCODE = 'QM018';
END $$;

CREATE FUNCTION app.retire_audit_definition(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE d public.audit_definitions%ROWTYPE;
BEGIN
  d := app.audit_definition_for_manage(p_id);
  IF d.status = 'retired' THEN
    RAISE EXCEPTION '% is already retired', d.reference USING ERRCODE = 'QM018';
  END IF;
  IF length(btrim(coalesce(p_reason, ''))) = 0 THEN
    RAISE EXCEPTION 'Give a reason for retiring the audit' USING ERRCODE = 'QM018';
  END IF;
  UPDATE public.audit_definitions SET status = 'retired', retired_at = now(), retired_by = auth.uid(), retired_reason = btrim(p_reason) WHERE id = p_id;
END $$;

CREATE FUNCTION app.reactivate_audit_definition(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE d public.audit_definitions%ROWTYPE;
BEGIN
  d := app.audit_definition_for_manage(p_id);
  IF d.status = 'active' THEN
    RAISE EXCEPTION '% is already active', d.reference USING ERRCODE = 'QM018';
  END IF;
  UPDATE public.audit_definitions SET status = 'active', retired_at = NULL, retired_by = NULL, retired_reason = NULL WHERE id = p_id;
END $$;

-- ---------------------------------------------------------------------------
-- Row level security and privileges
-- ---------------------------------------------------------------------------
ALTER TABLE public.audit_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_targets ENABLE ROW LEVEL SECURITY;

CREATE POLICY audit_definitions_select ON public.audit_definitions FOR SELECT TO authenticated USING (app.has_permission(organisation_id, 'audits.read'));
CREATE POLICY audit_definitions_insert ON public.audit_definitions FOR INSERT TO authenticated WITH CHECK (app.has_permission(organisation_id, 'audits.manage'));
CREATE POLICY audit_definitions_update ON public.audit_definitions FOR UPDATE TO authenticated
  USING (app.has_permission(organisation_id, 'audits.manage')) WITH CHECK (app.has_permission(organisation_id, 'audits.manage'));
CREATE POLICY audit_questions_select ON public.audit_questions FOR SELECT TO authenticated USING (app.has_permission(organisation_id, 'audits.read'));
CREATE POLICY audit_targets_select ON public.audit_targets FOR SELECT TO authenticated USING (app.has_permission(organisation_id, 'audits.read'));

REVOKE ALL ON public.audit_definitions, public.audit_questions, public.audit_targets FROM anon, authenticated;
GRANT SELECT, INSERT ON public.audit_definitions TO authenticated;
GRANT UPDATE (title, audit_type, purpose, procedure, frequency_kind, frequency_interval, first_due_on, grace_days, weekdays_only,
              auditor_kind, auditor_user_id, auditor_role_id, auditor_department_id, pass_mark) ON public.audit_definitions TO authenticated;
GRANT SELECT ON public.audit_questions, public.audit_targets TO authenticated;

REVOKE ALL ON FUNCTION app.next_audit_number(uuid), app.audit_definition_rules(), app.audit_definition_for_manage(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.set_audit_checklist(uuid, jsonb), app.set_audit_targets(uuid, jsonb), app.retire_audit_definition(uuid, text), app.reactivate_audit_definition(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.set_audit_checklist(uuid, jsonb), app.set_audit_targets(uuid, jsonb), app.retire_audit_definition(uuid, text), app.reactivate_audit_definition(uuid) TO authenticated;
