-- Supplier Quality SQ6a: a supplier can be what an audit is relevant to (docs/supplier-quality-plan.md).
--
-- "Relevant to" gains a fourth kind, `supplier`, next to machine, operation and department, on all three places it lives:
--   audit_targets (the definition), audit_version_targets (the frozen version) and audit_record_targets (what a record was carried out on).
-- The functions that write them (set_audit_targets, set_audit_record_targets, snapshot_audit_version) and the content fingerprint (audit_content_hash) learn the new kind.
-- THE FINGERPRINT OF EVERY EXISTING AUDIT IS UNCHANGED: the supplier is only added to the end of the coalesce, so audits with no supplier hash exactly as before and no
-- version is made "changed outside the app" by this migration. Nothing else about audits changes: schedule, records, findings and the dashboard work as before.

-- ---------------------------------------------------------------------------
-- Columns, constraints and indexes
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text; c record;
BEGIN
  FOREACH t IN ARRAY ARRAY['audit_targets', 'audit_version_targets', 'audit_record_targets'] LOOP
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN supplier_id uuid', t);
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (supplier_id, organisation_id) REFERENCES public.suppliers (id, organisation_id)', t, t || '_supplier_fkey');
    -- The kind check and the shape check both name the kinds: replace them together.
    FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = ('public.' || t)::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%''machine''%' LOOP
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', t, c.conname);
    END LOOP;
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (kind IN (''machine'', ''operation'', ''department'', ''supplier''))', t, t || '_kind_check');
    EXECUTE format($f$ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (
      (kind = 'machine' AND machine_id IS NOT NULL AND operation_code IS NULL AND department_id IS NULL AND supplier_id IS NULL)
      OR (kind = 'operation' AND operation_code IS NOT NULL AND machine_id IS NULL AND department_id IS NULL AND supplier_id IS NULL)
      OR (kind = 'department' AND department_id IS NOT NULL AND machine_id IS NULL AND operation_code IS NULL AND supplier_id IS NULL)
      OR (kind = 'supplier' AND supplier_id IS NOT NULL AND machine_id IS NULL AND operation_code IS NULL AND department_id IS NULL))$f$, t, t || '_shape');
  END LOOP;
END $$;
CREATE UNIQUE INDEX audit_targets_supplier_key ON public.audit_targets (audit_definition_id, supplier_id) WHERE supplier_id IS NOT NULL;
CREATE UNIQUE INDEX audit_record_targets_supplier_key ON public.audit_record_targets (audit_record_id, supplier_id) WHERE supplier_id IS NOT NULL;
CREATE INDEX audit_targets_supplier_idx ON public.audit_targets (supplier_id) WHERE supplier_id IS NOT NULL;
CREATE INDEX audit_record_targets_supplier_idx ON public.audit_record_targets (supplier_id) WHERE supplier_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- The fingerprint: identical for audits without a supplier target.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.audit_content_hash(p_definition uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT md5(jsonb_build_object(
    'h', jsonb_build_array(d.title, d.audit_type, d.purpose, d.procedure, d.pass_mark),
    'q', coalesce((SELECT jsonb_agg(app.audit_question_json(q.sequence, q.question, q.guidance, q.answer_type, q.pass_answer, q.unit, q.lower_limit, q.upper_limit,
                                                           q.nominal, q.options, q.rating_max, q.pass_rating, q.critical) ORDER BY q.sequence)
                     FROM public.audit_questions q WHERE q.audit_definition_id = d.id), '[]'::jsonb),
    't', coalesce((SELECT jsonb_agg(jsonb_build_array(t.kind, coalesce(t.machine_id::text, upper(t.operation_code), t.department_id::text, t.supplier_id::text))
                                    ORDER BY t.kind, coalesce(t.machine_id::text, upper(t.operation_code), t.department_id::text, t.supplier_id::text))
                     FROM public.audit_targets t WHERE t.audit_definition_id = d.id), '[]'::jsonb))::text)
    FROM public.audit_definitions d WHERE d.id = p_definition
$$;

-- ---------------------------------------------------------------------------
-- A version snapshots the supplier targets too.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.snapshot_audit_version(p_definition uuid, p_version integer, p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  d public.audit_definitions%ROWTYPE;
  v_id uuid;
BEGIN
  SELECT * INTO d FROM public.audit_definitions WHERE id = p_definition;
  INSERT INTO public.audit_versions (organisation_id, audit_definition_id, version, reason, content_hash, title, audit_type, purpose, procedure, pass_mark)
  VALUES (d.organisation_id, d.id, p_version, btrim(p_reason), app.audit_content_hash(d.id), d.title, d.audit_type, d.purpose, d.procedure, d.pass_mark)
  RETURNING id INTO v_id;
  INSERT INTO public.audit_version_questions (organisation_id, audit_version_id, sequence, question, guidance, answer_type, pass_answer, unit, lower_limit, upper_limit, nominal, options, rating_max, pass_rating, critical)
  SELECT q.organisation_id, v_id, q.sequence, q.question, q.guidance, q.answer_type, q.pass_answer, q.unit, q.lower_limit, q.upper_limit, q.nominal, q.options, q.rating_max, q.pass_rating, q.critical
    FROM public.audit_questions q WHERE q.audit_definition_id = d.id ORDER BY q.sequence;
  INSERT INTO public.audit_version_targets (organisation_id, audit_version_id, kind, machine_id, operation_code, department_id, supplier_id, label)
  SELECT t.organisation_id, v_id, t.kind, t.machine_id, t.operation_code, t.department_id, t.supplier_id,
         CASE t.kind WHEN 'machine' THEN m.code || ' · ' || m.name WHEN 'operation' THEN t.operation_code WHEN 'supplier' THEN sp.code || ' · ' || sp.name ELSE dp.code || ' · ' || dp.name END
    FROM public.audit_targets t LEFT JOIN public.machines m ON m.id = t.machine_id LEFT JOIN public.departments dp ON dp.id = t.department_id LEFT JOIN public.suppliers sp ON sp.id = t.supplier_id
   WHERE t.audit_definition_id = d.id;
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------
-- What the audit is relevant to: now also suppliers.
-- p_targets: [{ kind: 'machine', machineId } | { kind: 'operation', operationCode } | { kind: 'department', departmentId } | { kind: 'supplier', supplierId }]
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.set_audit_targets(p_definition uuid, p_targets jsonb) RETURNS void
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
    RAISE EXCEPTION 'An audit can be relevant to at most 200 machines, operations, departments or suppliers' USING ERRCODE = 'QM018';
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
    ELSIF (t->>'kind') = 'supplier' THEN
      IF NOT EXISTS (SELECT 1 FROM public.suppliers WHERE id = (t->>'supplierId')::uuid AND organisation_id = d.organisation_id) THEN
        RAISE EXCEPTION 'Supplier not found' USING ERRCODE = 'P0002';
      END IF;
      INSERT INTO public.audit_targets (organisation_id, audit_definition_id, kind, supplier_id) VALUES (d.organisation_id, p_definition, 'supplier', (t->>'supplierId')::uuid);
    ELSE
      RAISE EXCEPTION 'Choose a machine, an operation, a department or a supplier' USING ERRCODE = 'QM018';
    END IF;
  END LOOP;
  UPDATE public.audit_definitions SET updated_at = now() WHERE id = p_definition;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'The same machine, operation, department or supplier is listed twice' USING ERRCODE = 'QM018';
END $$;

-- ---------------------------------------------------------------------------
-- Which of the audit's targets a record was carried out on: now also suppliers (each one of the audit's own).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.set_audit_record_targets(p_record uuid, p_targets jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  r public.audit_records%ROWTYPE;
  t jsonb;
  v_label text;
BEGIN
  r := app.audit_record_for_perform(p_record);
  IF p_targets IS NULL OR jsonb_typeof(p_targets) <> 'array' THEN
    RAISE EXCEPTION 'What the audit was carried out on must be a list' USING ERRCODE = 'QM018';
  END IF;
  DELETE FROM public.audit_record_targets WHERE audit_record_id = p_record;
  FOR t IN SELECT * FROM jsonb_array_elements(p_targets) LOOP
    IF (t->>'kind') = 'machine' THEN
      SELECT m.code || ' · ' || m.name INTO v_label FROM public.audit_targets x JOIN public.machines m ON m.id = x.machine_id
       WHERE x.audit_definition_id = r.audit_definition_id AND x.machine_id = (t->>'machineId')::uuid;
      IF v_label IS NULL THEN RAISE EXCEPTION 'That machine is not one of the machines this audit is relevant to' USING ERRCODE = 'QM018'; END IF;
      INSERT INTO public.audit_record_targets (organisation_id, audit_record_id, kind, machine_id, label) VALUES (r.organisation_id, p_record, 'machine', (t->>'machineId')::uuid, v_label);
    ELSIF (t->>'kind') = 'operation' THEN
      SELECT x.operation_code INTO v_label FROM public.audit_targets x WHERE x.audit_definition_id = r.audit_definition_id AND upper(x.operation_code) = upper(t->>'operationCode');
      IF v_label IS NULL THEN RAISE EXCEPTION 'That operation is not one of the operations this audit is relevant to' USING ERRCODE = 'QM018'; END IF;
      INSERT INTO public.audit_record_targets (organisation_id, audit_record_id, kind, operation_code, label) VALUES (r.organisation_id, p_record, 'operation', v_label, v_label);
    ELSIF (t->>'kind') = 'department' THEN
      SELECT d.code || ' · ' || d.name INTO v_label FROM public.audit_targets x JOIN public.departments d ON d.id = x.department_id
       WHERE x.audit_definition_id = r.audit_definition_id AND x.department_id = (t->>'departmentId')::uuid;
      IF v_label IS NULL THEN RAISE EXCEPTION 'That department is not one of the departments this audit is relevant to' USING ERRCODE = 'QM018'; END IF;
      INSERT INTO public.audit_record_targets (organisation_id, audit_record_id, kind, department_id, label) VALUES (r.organisation_id, p_record, 'department', (t->>'departmentId')::uuid, v_label);
    ELSIF (t->>'kind') = 'supplier' THEN
      SELECT s.code || ' · ' || s.name INTO v_label FROM public.audit_targets x JOIN public.suppliers s ON s.id = x.supplier_id
       WHERE x.audit_definition_id = r.audit_definition_id AND x.supplier_id = (t->>'supplierId')::uuid;
      IF v_label IS NULL THEN RAISE EXCEPTION 'That supplier is not one of the suppliers this audit is relevant to' USING ERRCODE = 'QM018'; END IF;
      INSERT INTO public.audit_record_targets (organisation_id, audit_record_id, kind, supplier_id, label) VALUES (r.organisation_id, p_record, 'supplier', (t->>'supplierId')::uuid, v_label);
    ELSE
      RAISE EXCEPTION 'Choose a machine, an operation, a department or a supplier' USING ERRCODE = 'QM018';
    END IF;
    v_label := NULL;
  END LOOP;
  UPDATE public.audit_records SET updated_at = now() WHERE id = p_record;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'The same machine, operation, department or supplier is listed twice' USING ERRCODE = 'QM018';
END $$;
