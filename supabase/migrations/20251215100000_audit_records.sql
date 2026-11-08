-- Audits, slice AU3 (docs/audits-plan.md): AUDIT RECORDS. One record is one audit actually carried out: who, when, which of the audit's machines / operations / departments it was
-- carried out on (one or several), the answer to every question, and the result.
--
--  * Records are created only by app.start_audit(), which freezes a copy of the audit (title, procedure, pass mark) and of its questions into the record, so changing the audit
--    later never changes what was asked. A record can be started from a scheduled slot (the slot is then done) or on its own (unscheduled).
--  * Every write is a SECURITY DEFINER function needing audits.perform (anyone with it may continue an audit that is in progress, so cover for absence works). The tables have no
--    INSERT, UPDATE or DELETE grant for anyone.
--  * Answers: pass / fail / not applicable, yes / no (one of which passes) / not applicable, a number (within the limits or not), a note (never scored). The database works out each
--    answer's result. Completing needs every scored question answered, a note on every failure, and the machines / operations chosen; it then works out the score (passes ÷ answered,
--    not applicable left out) and the result: **fail if any critical question failed or the score is below the audit's pass mark**, else pass. A completed record is frozen.
--  * A failed answer can be turned into a draft non-conformance on request (app.raise_ncr_from_audit): prefilled, never silent, one live NC per failed answer.
--  * Numbering AR-YY-NNNN per organisation and year. Errors QM018 → 409 audit_rule.

CREATE TABLE app.audit_record_counters (
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  year integer NOT NULL,
  last_value integer NOT NULL DEFAULT 0,
  PRIMARY KEY (organisation_id, year)
);

-- ---------------------------------------------------------------------------
-- The record
-- ---------------------------------------------------------------------------
CREATE TABLE public.audit_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  reference text NOT NULL,
  audit_definition_id uuid NOT NULL,
  occurrence_id uuid,
  -- The audit as it was when this record was started.
  audit_reference text NOT NULL,
  audit_title text NOT NULL,
  audit_type text NOT NULL,
  procedure text,
  pass_mark integer NOT NULL CHECK (pass_mark BETWEEN 0 AND 100),
  status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed', 'abandoned')),
  started_at timestamptz NOT NULL DEFAULT now(),
  started_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  performed_on date NOT NULL DEFAULT current_date,
  completed_at timestamptz,
  completed_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  abandon_reason text CHECK (abandon_reason IS NULL OR length(btrim(abandon_reason)) BETWEEN 1 AND 1000),
  notes text CHECK (notes IS NULL OR length(btrim(notes)) BETWEEN 1 AND 5000),
  result text CHECK (result IS NULL OR result IN ('pass', 'fail')),
  score numeric(5, 2) CHECK (score IS NULL OR score BETWEEN 0 AND 100),
  passed_count integer CHECK (passed_count IS NULL OR passed_count >= 0),
  failed_count integer CHECK (failed_count IS NULL OR failed_count >= 0),
  na_count integer CHECK (na_count IS NULL OR na_count >= 0),
  critical_failed_count integer CHECK (critical_failed_count IS NULL OR critical_failed_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT audit_records_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT audit_records_reference_key UNIQUE (organisation_id, reference),
  CONSTRAINT audit_records_definition_fkey FOREIGN KEY (audit_definition_id, organisation_id) REFERENCES public.audit_definitions (id, organisation_id),
  CONSTRAINT audit_records_occurrence_fkey FOREIGN KEY (occurrence_id, organisation_id) REFERENCES public.audit_occurrences (id, organisation_id),
  CONSTRAINT audit_records_completed CHECK ((status = 'completed') = (completed_at IS NOT NULL AND result IS NOT NULL)),
  CONSTRAINT audit_records_abandoned CHECK ((status = 'abandoned') = (abandon_reason IS NOT NULL))
);
-- A slot is done once: one record per slot that has not been abandoned.
CREATE UNIQUE INDEX audit_records_one_per_slot ON public.audit_records (occurrence_id) WHERE occurrence_id IS NOT NULL AND status <> 'abandoned';
CREATE INDEX audit_records_definition_idx ON public.audit_records (audit_definition_id, performed_on DESC);
CREATE INDEX audit_records_list_idx ON public.audit_records (organisation_id, performed_on DESC);

CREATE TABLE public.audit_record_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  audit_record_id uuid NOT NULL,
  sequence integer NOT NULL,
  question text NOT NULL,
  guidance text,
  answer_type text NOT NULL CHECK (answer_type IN ('pass_fail', 'yes_no', 'number', 'text')),
  pass_answer text CHECK (pass_answer IS NULL OR pass_answer IN ('yes', 'no')),
  unit text,
  lower_limit numeric,
  upper_limit numeric,
  critical boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT audit_record_questions_id_record_key UNIQUE (id, audit_record_id),
  CONSTRAINT audit_record_questions_record_fkey FOREIGN KEY (audit_record_id, organisation_id) REFERENCES public.audit_records (id, organisation_id),
  CONSTRAINT audit_record_questions_sequence_key UNIQUE (audit_record_id, sequence)
);

CREATE TABLE public.audit_record_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  audit_record_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('machine', 'operation', 'department')),
  machine_id uuid,
  operation_code text,
  department_id uuid,
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT audit_record_targets_record_fkey FOREIGN KEY (audit_record_id, organisation_id) REFERENCES public.audit_records (id, organisation_id),
  CONSTRAINT audit_record_targets_machine_fkey FOREIGN KEY (machine_id, organisation_id) REFERENCES public.machines (id, organisation_id),
  CONSTRAINT audit_record_targets_department_fkey FOREIGN KEY (department_id, organisation_id) REFERENCES public.departments (id, organisation_id),
  CONSTRAINT audit_record_targets_shape CHECK (
    (kind = 'machine' AND machine_id IS NOT NULL AND operation_code IS NULL AND department_id IS NULL)
    OR (kind = 'operation' AND operation_code IS NOT NULL AND machine_id IS NULL AND department_id IS NULL)
    OR (kind = 'department' AND department_id IS NOT NULL AND machine_id IS NULL AND operation_code IS NULL))
);
CREATE UNIQUE INDEX audit_record_targets_machine_key ON public.audit_record_targets (audit_record_id, machine_id) WHERE machine_id IS NOT NULL;
CREATE UNIQUE INDEX audit_record_targets_operation_key ON public.audit_record_targets (audit_record_id, upper(operation_code)) WHERE operation_code IS NOT NULL;
CREATE UNIQUE INDEX audit_record_targets_department_key ON public.audit_record_targets (audit_record_id, department_id) WHERE department_id IS NOT NULL;
CREATE INDEX audit_record_targets_machine_idx ON public.audit_record_targets (machine_id) WHERE machine_id IS NOT NULL;

CREATE TABLE public.audit_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  audit_record_id uuid NOT NULL,
  record_question_id uuid NOT NULL,
  answer text CHECK (answer IS NULL OR answer IN ('pass', 'fail', 'yes', 'no', 'na')),
  value_number numeric,
  note text CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 2000),
  -- Worked out from the answer and the question: pass, fail or na. A note has no result.
  result text CHECK (result IS NULL OR result IN ('pass', 'fail', 'na')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT audit_responses_id_record_key UNIQUE (id, audit_record_id),
  CONSTRAINT audit_responses_record_fkey FOREIGN KEY (audit_record_id, organisation_id) REFERENCES public.audit_records (id, organisation_id),
  CONSTRAINT audit_responses_question_fkey FOREIGN KEY (record_question_id, audit_record_id) REFERENCES public.audit_record_questions (id, audit_record_id),
  CONSTRAINT audit_responses_question_key UNIQUE (record_question_id)
);

CREATE TABLE public.audit_ncr_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  audit_record_id uuid NOT NULL,
  response_id uuid NOT NULL,
  nonconformance_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT audit_ncr_links_response_fkey FOREIGN KEY (response_id, audit_record_id) REFERENCES public.audit_responses (id, audit_record_id),
  CONSTRAINT audit_ncr_links_ncr_fkey FOREIGN KEY (nonconformance_id, organisation_id) REFERENCES public.nonconformances (id, organisation_id),
  CONSTRAINT audit_ncr_links_key UNIQUE (response_id, nonconformance_id)
);
CREATE INDEX audit_ncr_links_ncr_idx ON public.audit_ncr_links (nonconformance_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['audit_records', 'audit_record_questions', 'audit_record_targets', 'audit_responses', 'audit_ncr_links'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION app.stamp_created()', t || '_stamp', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.touch_updated()', t || '_touch', t);
    EXECUTE format('CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION audit.record_change(''organisation_id'')', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (app.has_permission(organisation_id, ''audits.read''))', t || '_select', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
-- The record, for a person who may perform audits, and in progress (the only state in which it can change).
CREATE FUNCTION app.audit_record_for_perform(p_id uuid, p_must_be_in_progress boolean DEFAULT true) RETURNS public.audit_records
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.audit_records%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.audit_records WHERE id = p_id;
  IF NOT FOUND OR NOT app.has_permission(r.organisation_id, 'audits.read') THEN
    RAISE EXCEPTION 'Audit record not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT app.has_permission(r.organisation_id, 'audits.perform') THEN
    RAISE EXCEPTION 'Carrying out audits needs the audits.perform permission' USING ERRCODE = '42501';
  END IF;
  IF p_must_be_in_progress AND r.status <> 'in_progress' THEN
    RAISE EXCEPTION '% is %; it can no longer be changed', r.reference, r.status USING ERRCODE = 'QM018';
  END IF;
  RETURN r;
END $$;

-- What is still needed before the record can be completed (shown to the auditor and checked by app.complete_audit).
CREATE FUNCTION app.audit_record_problems(p_id uuid) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  r public.audit_records%ROWTYPE;
  v_problems text[] := ARRAY[]::text[];
  v_unanswered integer[];
  v_nonote integer[];
BEGIN
  SELECT * INTO r FROM public.audit_records WHERE id = p_id;
  IF NOT FOUND OR NOT app.has_permission(r.organisation_id, 'audits.read') THEN
    RETURN v_problems;
  END IF;
  SELECT coalesce(array_agg(q.sequence ORDER BY q.sequence), ARRAY[]::integer[]) INTO v_unanswered
    FROM public.audit_record_questions q
   WHERE q.audit_record_id = p_id AND q.answer_type <> 'text' AND NOT EXISTS (SELECT 1 FROM public.audit_responses s WHERE s.record_question_id = q.id);
  IF cardinality(v_unanswered) > 0 THEN
    v_problems := array_append(v_problems, CASE WHEN cardinality(v_unanswered) = 1 THEN format('question %s is not answered', v_unanswered[1])
                                                ELSE format('%s questions are not answered (first: question %s)', cardinality(v_unanswered), v_unanswered[1]) END);
  END IF;
  SELECT coalesce(array_agg(q.sequence ORDER BY q.sequence), ARRAY[]::integer[]) INTO v_nonote
    FROM public.audit_record_questions q JOIN public.audit_responses s ON s.record_question_id = q.id
   WHERE q.audit_record_id = p_id AND s.result = 'fail' AND s.note IS NULL;
  IF cardinality(v_nonote) > 0 THEN
    v_problems := array_append(v_problems, format('say what was found for the failed question%s: %s', CASE WHEN cardinality(v_nonote) = 1 THEN '' ELSE 's' END, array_to_string(v_nonote, ', ')));
  END IF;
  IF EXISTS (SELECT 1 FROM public.audit_targets t WHERE t.audit_definition_id = r.audit_definition_id)
     AND NOT EXISTS (SELECT 1 FROM public.audit_record_targets x WHERE x.audit_record_id = p_id) THEN
    v_problems := array_append(v_problems, 'choose which machines, operations or departments it was carried out on');
  END IF;
  RETURN v_problems;
END $$;

-- ---------------------------------------------------------------------------
-- Which of the audit's machines / operations / departments it was carried out on
-- p_targets: [{ kind: 'machine', machineId } | { kind: 'operation', operationCode } | { kind: 'department', departmentId }], each one of the audit's own.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.set_audit_record_targets(p_record uuid, p_targets jsonb) RETURNS void
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
    ELSE
      RAISE EXCEPTION 'Choose a machine, an operation or a department' USING ERRCODE = 'QM018';
    END IF;
    v_label := NULL;
  END LOOP;
  UPDATE public.audit_records SET updated_at = now() WHERE id = p_record;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'The same machine, operation or department is listed twice' USING ERRCODE = 'QM018';
END $$;

-- ---------------------------------------------------------------------------
-- Start an audit: from a scheduled slot (the slot is then done), or on its own.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.start_audit(p_definition uuid, p_occurrence uuid DEFAULT NULL, p_targets jsonb DEFAULT '[]'::jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  d public.audit_definitions%ROWTYPE;
  o public.audit_occurrences%ROWTYPE;
  v_id uuid;
  v_year integer := extract(year FROM current_date)::integer;
  v_n integer;
BEGIN
  SELECT * INTO d FROM public.audit_definitions WHERE id = p_definition;
  IF NOT FOUND OR NOT app.has_permission(d.organisation_id, 'audits.read') THEN
    RAISE EXCEPTION 'Audit not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT app.has_permission(d.organisation_id, 'audits.perform') THEN
    RAISE EXCEPTION 'Carrying out audits needs the audits.perform permission' USING ERRCODE = '42501';
  END IF;
  IF d.status <> 'active' THEN
    RAISE EXCEPTION '% is retired; reactivate it to carry it out', d.reference USING ERRCODE = 'QM018';
  END IF;
  IF p_occurrence IS NOT NULL THEN
    SELECT * INTO o FROM public.audit_occurrences WHERE id = p_occurrence AND organisation_id = d.organisation_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Scheduled audit not found' USING ERRCODE = 'P0002';
    END IF;
    IF o.audit_definition_id <> p_definition THEN
      RAISE EXCEPTION 'That scheduled audit belongs to another audit' USING ERRCODE = 'QM018';
    END IF;
    IF o.status = 'skipped' THEN
      RAISE EXCEPTION 'That scheduled audit was skipped; put it back before carrying it out' USING ERRCODE = 'QM018';
    END IF;
    IF EXISTS (SELECT 1 FROM public.audit_records x WHERE x.occurrence_id = p_occurrence AND x.status <> 'abandoned') THEN
      RAISE EXCEPTION 'That scheduled audit is already being done or has been done' USING ERRCODE = 'QM018';
    END IF;
  END IF;

  INSERT INTO app.audit_record_counters AS c (organisation_id, year, last_value) VALUES (d.organisation_id, v_year, 1)
  ON CONFLICT (organisation_id, year) DO UPDATE SET last_value = c.last_value + 1 RETURNING last_value INTO v_n;
  INSERT INTO public.audit_records (organisation_id, reference, audit_definition_id, occurrence_id, audit_reference, audit_title, audit_type, procedure, pass_mark)
  VALUES (d.organisation_id, 'AR-' || to_char(make_date(v_year, 1, 1), 'YY') || '-' || lpad(v_n::text, 4, '0'), p_definition, p_occurrence, d.reference, d.title, d.audit_type, d.procedure, d.pass_mark)
  RETURNING id INTO v_id;
  INSERT INTO public.audit_record_questions (organisation_id, audit_record_id, sequence, question, guidance, answer_type, pass_answer, unit, lower_limit, upper_limit, critical)
  SELECT q.organisation_id, v_id, q.sequence, q.question, q.guidance, q.answer_type, q.pass_answer, q.unit, q.lower_limit, q.upper_limit, q.critical
    FROM public.audit_questions q WHERE q.audit_definition_id = p_definition ORDER BY q.sequence;
  IF p_targets IS NOT NULL AND jsonb_typeof(p_targets) = 'array' AND jsonb_array_length(p_targets) > 0 THEN
    PERFORM app.set_audit_record_targets(v_id, p_targets);
  END IF;
  PERFORM app.emit_event(d.organisation_id, 'audit.started', 'audit_record', v_id, jsonb_build_object('audit', d.reference, 'occurrence', p_occurrence));
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------
-- Answer a question. Passing no answer, no number and no note clears the answer.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.record_audit_response(p_record uuid, p_question uuid, p_answer text DEFAULT NULL, p_value numeric DEFAULT NULL, p_note text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  r public.audit_records%ROWTYPE;
  q public.audit_record_questions%ROWTYPE;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_answer text := nullif(btrim(coalesce(p_answer, '')), '');
  v_result text;
BEGIN
  r := app.audit_record_for_perform(p_record);
  SELECT * INTO q FROM public.audit_record_questions WHERE id = p_question AND audit_record_id = p_record;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Question not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_answer IS NULL AND p_value IS NULL AND v_note IS NULL THEN
    DELETE FROM public.audit_responses WHERE record_question_id = p_question;
    RETURN;
  END IF;
  IF q.answer_type = 'pass_fail' THEN
    IF v_answer IS NULL OR v_answer NOT IN ('pass', 'fail', 'na') THEN RAISE EXCEPTION 'Answer pass, fail or not applicable' USING ERRCODE = 'QM018'; END IF;
    v_result := v_answer; p_value := NULL;
  ELSIF q.answer_type = 'yes_no' THEN
    IF v_answer IS NULL OR v_answer NOT IN ('yes', 'no', 'na') THEN RAISE EXCEPTION 'Answer yes, no or not applicable' USING ERRCODE = 'QM018'; END IF;
    v_result := CASE WHEN v_answer = 'na' THEN 'na' WHEN v_answer = q.pass_answer THEN 'pass' ELSE 'fail' END; p_value := NULL;
  ELSIF q.answer_type = 'number' THEN
    IF v_answer = 'na' THEN
      v_result := 'na'; p_value := NULL;
    ELSIF p_value IS NULL THEN
      RAISE EXCEPTION 'Enter a number, or mark the question not applicable' USING ERRCODE = 'QM018';
    ELSE
      v_answer := NULL;
      v_result := CASE WHEN (q.lower_limit IS NULL OR p_value >= q.lower_limit) AND (q.upper_limit IS NULL OR p_value <= q.upper_limit) THEN 'pass' ELSE 'fail' END;
    END IF;
  ELSE
    IF v_note IS NULL THEN RAISE EXCEPTION 'Write the note' USING ERRCODE = 'QM018'; END IF;
    v_answer := NULL; p_value := NULL; v_result := NULL;
  END IF;
  INSERT INTO public.audit_responses (organisation_id, audit_record_id, record_question_id, answer, value_number, note, result)
  VALUES (r.organisation_id, p_record, p_question, v_answer, p_value, v_note, v_result)
  ON CONFLICT (record_question_id) DO UPDATE SET answer = EXCLUDED.answer, value_number = EXCLUDED.value_number, note = EXCLUDED.note, result = EXCLUDED.result;
END $$;

-- The audit's own notes and the date it was carried out (not in the future).
CREATE FUNCTION app.update_audit_record(p_record uuid, p_notes text DEFAULT NULL, p_performed_on date DEFAULT NULL, p_set_notes boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.audit_records%ROWTYPE;
BEGIN
  r := app.audit_record_for_perform(p_record);
  IF p_performed_on IS NOT NULL AND p_performed_on > current_date THEN
    RAISE EXCEPTION 'An audit cannot have been carried out in the future' USING ERRCODE = 'QM018';
  END IF;
  UPDATE public.audit_records
     SET notes = CASE WHEN p_set_notes THEN nullif(btrim(coalesce(p_notes, '')), '') ELSE notes END, performed_on = coalesce(p_performed_on, performed_on)
   WHERE id = p_record;
END $$;

-- ---------------------------------------------------------------------------
-- Complete: works out the score and the result, and freezes the record.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.complete_audit(p_record uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  r public.audit_records%ROWTYPE;
  v_problems text[];
  v_pass integer; v_fail integer; v_na integer; v_crit integer; v_score numeric;
BEGIN
  r := app.audit_record_for_perform(p_record);
  v_problems := app.audit_record_problems(p_record);
  IF cardinality(v_problems) > 0 THEN
    RAISE EXCEPTION 'Before % can be completed: %', r.reference, array_to_string(v_problems, '; ') USING ERRCODE = 'QM018';
  END IF;
  SELECT count(*) FILTER (WHERE s.result = 'pass'), count(*) FILTER (WHERE s.result = 'fail'), count(*) FILTER (WHERE s.result = 'na'),
         count(*) FILTER (WHERE s.result = 'fail' AND q.critical)
    INTO v_pass, v_fail, v_na, v_crit
    FROM public.audit_record_questions q JOIN public.audit_responses s ON s.record_question_id = q.id WHERE q.audit_record_id = p_record;
  v_score := CASE WHEN v_pass + v_fail = 0 THEN NULL ELSE round(100.0 * v_pass / (v_pass + v_fail), 2) END;
  UPDATE public.audit_records
     SET status = 'completed', completed_at = now(), completed_by = auth.uid(), passed_count = v_pass, failed_count = v_fail, na_count = v_na, critical_failed_count = v_crit,
         score = v_score, result = CASE WHEN v_crit > 0 OR (v_score IS NOT NULL AND v_score < pass_mark) THEN 'fail' ELSE 'pass' END
   WHERE id = p_record;
  PERFORM app.emit_event(r.organisation_id, 'audit.completed', 'audit_record', p_record, jsonb_build_object('audit', r.audit_reference, 'reference', r.reference));
END $$;

CREATE FUNCTION app.abandon_audit(p_record uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.audit_records%ROWTYPE;
BEGIN
  r := app.audit_record_for_perform(p_record);
  IF length(btrim(coalesce(p_reason, ''))) = 0 THEN
    RAISE EXCEPTION 'Give a reason for abandoning the audit' USING ERRCODE = 'QM018';
  END IF;
  UPDATE public.audit_records SET status = 'abandoned', abandon_reason = btrim(p_reason) WHERE id = p_record;
END $$;

-- ---------------------------------------------------------------------------
-- A failed answer becomes a draft non-conformance, on request.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.raise_ncr_from_audit(p_record uuid, p_response_ids uuid[], p_title text, p_description text DEFAULT NULL, p_severity text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  r public.audit_records%ROWTYPE;
  v_ids uuid[];
  v_ncr uuid;
  v_title text := nullif(btrim(coalesce(p_title, '')), '');
  v_site uuid;
BEGIN
  SELECT * INTO r FROM public.audit_records WHERE id = p_record;
  IF NOT FOUND OR NOT app.has_permission(r.organisation_id, 'audits.read') THEN
    RAISE EXCEPTION 'Audit record not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT app.has_permission(r.organisation_id, 'ncr.create') THEN
    RAISE EXCEPTION 'You may not raise non-conformances' USING ERRCODE = '42501';
  END IF;
  IF r.status = 'abandoned' THEN
    RAISE EXCEPTION '% was abandoned', r.reference USING ERRCODE = 'QM018';
  END IF;
  IF v_title IS NULL THEN
    RAISE EXCEPTION 'Give the non-conformance a title' USING ERRCODE = 'QM018';
  END IF;
  SELECT array_agg(DISTINCT x) INTO v_ids FROM unnest(coalesce(p_response_ids, ARRAY[]::uuid[])) x;
  IF coalesce(cardinality(v_ids), 0) = 0 THEN
    RAISE EXCEPTION 'Choose at least one failed answer' USING ERRCODE = 'QM018';
  END IF;
  IF (SELECT count(*) FROM public.audit_responses s WHERE s.id = ANY (v_ids) AND s.audit_record_id = p_record AND s.result = 'fail') <> cardinality(v_ids) THEN
    RAISE EXCEPTION 'Only failed answers of this audit can be raised as a non-conformance' USING ERRCODE = 'QM018';
  END IF;
  IF EXISTS (SELECT 1 FROM public.audit_ncr_links l JOIN public.nonconformances n ON n.id = l.nonconformance_id
              WHERE l.response_id = ANY (v_ids) AND n.deleted_at IS NULL AND n.stage <> 'cancelled') THEN
    RAISE EXCEPTION 'A failed answer is already on a non-conformance' USING ERRCODE = 'QM018';
  END IF;
  SELECT m.site_id INTO v_site FROM public.audit_record_targets x JOIN public.machines m ON m.id = x.machine_id WHERE x.audit_record_id = p_record AND m.site_id IS NOT NULL ORDER BY x.created_at LIMIT 1;
  INSERT INTO public.nonconformances (organisation_id, reference, source, stage, severity, title, description, site_id, detected_at, detected_by)
  VALUES (r.organisation_id, 'pending', 'internal', 'draft', nullif(p_severity, ''), left(v_title, 200), nullif(btrim(coalesce(p_description, '')), ''), v_site, r.performed_on, auth.uid())
  RETURNING id INTO v_ncr;
  INSERT INTO public.audit_ncr_links (organisation_id, audit_record_id, response_id, nonconformance_id) SELECT r.organisation_id, p_record, x, v_ncr FROM unnest(v_ids) x;
  PERFORM app.emit_event(r.organisation_id, 'audit.ncr_raised', 'audit_record', p_record, jsonb_build_object('reference', r.reference, 'nonconformance_id', v_ncr, 'answers', cardinality(v_ids)));
  RETURN v_ncr;
END $$;

-- ---------------------------------------------------------------------------
-- The schedule slot's state, now that records exist: a record in progress or done decides it. (Replaces nothing stored; read by the API.)
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app.audit_record_for_perform(uuid, boolean), app.audit_record_problems(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.audit_record_problems(uuid) TO authenticated;
REVOKE ALL ON FUNCTION app.audit_record_for_perform(uuid, boolean) FROM authenticated;
REVOKE ALL ON FUNCTION app.set_audit_record_targets(uuid, jsonb), app.start_audit(uuid, uuid, jsonb), app.record_audit_response(uuid, uuid, text, numeric, text),
  app.update_audit_record(uuid, text, date, boolean), app.complete_audit(uuid), app.abandon_audit(uuid, text), app.raise_ncr_from_audit(uuid, uuid[], text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.set_audit_record_targets(uuid, jsonb), app.start_audit(uuid, uuid, jsonb), app.record_audit_response(uuid, uuid, text, numeric, text),
  app.update_audit_record(uuid, text, date, boolean), app.complete_audit(uuid), app.abandon_audit(uuid, text), app.raise_ncr_from_audit(uuid, uuid[], text, text, text) TO authenticated;
REVOKE ALL ON TABLE app.audit_record_counters FROM PUBLIC, anon, authenticated;

-- The generator must not remove a future slot that already has a record (an audit started early).
CREATE OR REPLACE FUNCTION app.generate_audit_occurrences(p_organisation_id uuid, p_until date) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  d public.audit_definitions%ROWTYPE;
  v_until date := least(p_until, current_date + 366);
  v_start date;
  v_step integer;
  v_k integer;
  v_raw date;
  v_due date;
  v_keep date[];
  v_added integer := 0;
  v_n integer;
BEGIN
  IF NOT app.has_permission(p_organisation_id, 'audits.read') THEN
    RAISE EXCEPTION 'Audits not found' USING ERRCODE = 'P0002';
  END IF;
  DELETE FROM public.audit_occurrences o USING public.audit_definitions x
   WHERE o.audit_definition_id = x.id AND x.organisation_id = p_organisation_id AND (x.status = 'retired' OR x.frequency_kind = 'on_demand') AND o.due_on > current_date AND o.status = 'scheduled'
     AND NOT EXISTS (SELECT 1 FROM public.audit_records r WHERE r.occurrence_id = o.id);
  FOR d IN SELECT * FROM public.audit_definitions WHERE organisation_id = p_organisation_id AND status = 'active' AND frequency_kind <> 'on_demand' LOOP
    v_start := greatest(d.first_due_on, d.created_at::date, current_date - 120);
    v_step := CASE d.frequency_kind WHEN 'daily' THEN 1 WHEN 'weekly' THEN 7 WHEN 'every_n_days' THEN d.frequency_interval
                                    WHEN 'monthly' THEN 31 WHEN 'quarterly' THEN 92 WHEN 'six_monthly' THEN 184 ELSE 366 END;
    v_k := greatest(0, (v_start - d.first_due_on) / v_step - 1);
    v_keep := ARRAY[]::date[];
    LOOP
      v_raw := app.audit_due_date(d.frequency_kind, d.frequency_interval, d.first_due_on, v_k);
      EXIT WHEN v_raw > v_until OR v_k > 5000;
      v_due := v_raw;
      IF d.weekdays_only THEN
        v_due := v_raw + CASE extract(dow FROM v_raw)::integer WHEN 6 THEN 2 WHEN 0 THEN 1 ELSE 0 END;
      END IF;
      IF v_due >= v_start AND v_due <= v_until THEN
        v_keep := array_append(v_keep, v_due);
        INSERT INTO public.audit_occurrences (organisation_id, audit_definition_id, due_on) VALUES (d.organisation_id, d.id, v_due) ON CONFLICT (audit_definition_id, due_on) DO NOTHING;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_added := v_added + v_n;
      END IF;
      v_k := v_k + 1;
    END LOOP;
    DELETE FROM public.audit_occurrences o WHERE o.audit_definition_id = d.id AND o.due_on > current_date AND o.status = 'scheduled' AND NOT (o.due_on = ANY (v_keep))
       AND NOT EXISTS (SELECT 1 FROM public.audit_records r WHERE r.occurrence_id = o.id);
  END LOOP;
  RETURN v_added;
END $$;

-- A slot that has been carried out (or is being) cannot be skipped: its record says what happened.
CREATE OR REPLACE FUNCTION app.skip_audit_occurrence(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o public.audit_occurrences%ROWTYPE;
BEGIN
  SELECT * INTO o FROM public.audit_occurrences WHERE id = p_id;
  IF NOT FOUND OR NOT app.has_permission(o.organisation_id, 'audits.read') THEN
    RAISE EXCEPTION 'Scheduled audit not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT app.has_permission(o.organisation_id, 'audits.manage') THEN
    RAISE EXCEPTION 'Skipping an audit needs the audits.manage permission' USING ERRCODE = '42501';
  END IF;
  IF o.status = 'skipped' THEN
    RAISE EXCEPTION 'This audit is already skipped' USING ERRCODE = 'QM018';
  END IF;
  IF EXISTS (SELECT 1 FROM public.audit_records r WHERE r.occurrence_id = p_id AND r.status <> 'abandoned') THEN
    RAISE EXCEPTION 'This audit is being done or has been done, so it cannot be skipped' USING ERRCODE = 'QM018';
  END IF;
  IF length(btrim(coalesce(p_reason, ''))) = 0 THEN
    RAISE EXCEPTION 'Give a reason for skipping the audit' USING ERRCODE = 'QM018';
  END IF;
  UPDATE public.audit_occurrences SET status = 'skipped', skipped_at = now(), skipped_by = auth.uid(), skipped_reason = btrim(p_reason) WHERE id = p_id;
END $$;
