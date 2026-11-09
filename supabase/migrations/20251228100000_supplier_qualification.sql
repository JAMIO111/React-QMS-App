-- Supplier Quality SQ2c: qualification assessments and approval decisions (docs/supplier-quality-plan.md).
--
--  * supplier_assessment_templates + supplier_assessment_template_versions: the organisation's questionnaires, as VERSIONS (questions with section, answer type yes/no, rating 1-5 or
--    note, weight, critical flag, evidence-required flag; a pass mark). A default template is seeded for every organisation. Functions only (supplier_quality.configure).
--  * supplier_assessments + supplier_assessment_responses: an assessment is a run of one template version against a supplier. It FREEZES the questions and pass mark it started with.
--    Responses are worked out by the database (pass / fail / n/a / unscored). Completing needs every scored question answered, a note on every failure and a current document on every
--    evidence-required answer; the score and result (fail if any critical question failed or the score is under the pass mark) are the database's. Completed assessments are frozen.
--    Functions only (supplier_quality.manage). Nothing is deleted.
--  * supplier_approval_decisions: how a supplier becomes Approved or Conditionally approved. One person PROPOSES (rationale, the assessment, conditions, review date; without a passing
--    assessment an explicit exception reason is needed and the decision is flagged), a DIFFERENT person with supplier_quality.approve DECIDES (approve or reject). Approving moves the status
--    through app.change_supplier_status, so the status history stays the single record and links back to the decision. Preparer is never the approver.
--  * app.change_supplier_status now REFUSES a move to approved / conditional unless it is made by a decision (a transaction-local setting only app.decide_supplier_approval switches on).
--    Suspending, disqualifying, archiving and re-opening stay direct: they are protective and must not wait for a second person.

CREATE TABLE app.supplier_assessment_counters (
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  year integer NOT NULL,
  last_value integer NOT NULL DEFAULT 0,
  PRIMARY KEY (organisation_id, year)
);
REVOKE ALL ON TABLE app.supplier_assessment_counters FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Templates
-- ---------------------------------------------------------------------------
CREATE TABLE public.supplier_assessment_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  description text CHECK (description IS NULL OR length(btrim(description)) BETWEEN 1 AND 500),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT supplier_assessment_templates_id_org_key UNIQUE (id, organisation_id)
);
CREATE UNIQUE INDEX supplier_assessment_templates_name_key ON public.supplier_assessment_templates (organisation_id, lower(btrim(name)));

CREATE TABLE public.supplier_assessment_template_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  template_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  questions jsonb NOT NULL,
  pass_mark integer NOT NULL CHECK (pass_mark BETWEEN 1 AND 100),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT supplier_assessment_template_versions_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT supplier_assessment_template_versions_template_fkey FOREIGN KEY (template_id, organisation_id) REFERENCES public.supplier_assessment_templates (id, organisation_id),
  CONSTRAINT supplier_assessment_template_versions_key UNIQUE (template_id, version)
);

CREATE FUNCTION app.supplier_assessment_questions_problem(p_questions jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE q jsonb; v_keys text[] := ARRAY[]::text[]; v_scored integer := 0;
BEGIN
  IF jsonb_typeof(p_questions) <> 'array' OR jsonb_array_length(p_questions) NOT BETWEEN 1 AND 60 THEN RETURN 'A template needs between 1 and 60 questions'; END IF;
  FOR q IN SELECT x FROM jsonb_array_elements(p_questions) x LOOP
    IF jsonb_typeof(q) <> 'object' THEN RETURN 'Every question must be an object'; END IF;
    IF coalesce(q ->> 'key', '') !~ '^[a-z0-9_]{2,40}$' THEN RETURN 'A question key is 2 to 40 lower-case letters, digits or underscores'; END IF;
    IF (q ->> 'key') = ANY (v_keys) THEN RETURN 'Question keys must be unique'; END IF;
    v_keys := v_keys || (q ->> 'key');
    IF length(btrim(coalesce(q ->> 'text', ''))) NOT BETWEEN 1 AND 500 THEN RETURN 'Every question needs its wording (up to 500 characters)'; END IF;
    IF length(coalesce(q ->> 'section', '')) > 80 THEN RETURN 'A section name is up to 80 characters'; END IF;
    IF coalesce(q ->> 'answerType', '') NOT IN ('yes_no', 'rating', 'text') THEN RETURN 'A question is answered yes / no, with a rating 1 to 5, or with a note'; END IF;
    IF jsonb_typeof(q -> 'critical') IS DISTINCT FROM 'boolean' OR jsonb_typeof(q -> 'evidenceRequired') IS DISTINCT FROM 'boolean' THEN RETURN 'Every question says whether it is critical and whether it needs evidence'; END IF;
    IF (q ->> 'answerType') = 'text' THEN
      IF (q ->> 'critical')::boolean OR (q ->> 'evidenceRequired')::boolean THEN RETURN 'A question answered with a note cannot be critical or need evidence'; END IF;
    ELSE
      v_scored := v_scored + 1;
      IF coalesce(q ->> 'weight', '') !~ '^[0-9]+$' OR (q ->> 'weight')::int NOT BETWEEN 1 AND 10 THEN RETURN 'A scored question has a weight from 1 to 10'; END IF;
      IF (q ->> 'answerType') = 'rating' AND (coalesce(q ->> 'passRating', '') !~ '^[0-9]+$' OR (q ->> 'passRating')::int NOT BETWEEN 2 AND 5) THEN RETURN 'A rating question says the lowest passing rating (2 to 5)'; END IF;
    END IF;
  END LOOP;
  IF v_scored = 0 THEN RETURN 'At least one question must be scored (yes / no or rating)'; END IF;
  RETURN NULL;
END $$;
ALTER TABLE public.supplier_assessment_template_versions ADD CONSTRAINT supplier_assessment_template_versions_valid CHECK (app.supplier_assessment_questions_problem(questions) IS NULL);

CREATE FUNCTION app.default_supplier_assessment_questions() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT jsonb_build_array(
    jsonb_build_object('key', 'qms_certified', 'section', 'Quality system', 'text', 'Does the supplier hold a current quality management certification (for example ISO 9001)?', 'answerType', 'yes_no', 'weight', 5, 'critical', false, 'evidenceRequired', true),
    jsonb_build_object('key', 'qms_scope', 'section', 'Quality system', 'text', 'Does the certification scope cover the products or services we buy?', 'answerType', 'yes_no', 'weight', 4, 'critical', false, 'evidenceRequired', false),
    jsonb_build_object('key', 'document_control', 'section', 'Quality system', 'text', 'Are quality documents and records controlled and retained?', 'answerType', 'yes_no', 'weight', 3, 'critical', false, 'evidenceRequired', false),
    jsonb_build_object('key', 'training', 'section', 'Quality system', 'text', 'Is there a training and competence process for the people doing the work?', 'answerType', 'yes_no', 'weight', 3, 'critical', false, 'evidenceRequired', false),
    jsonb_build_object('key', 'inspection', 'section', 'Product and process', 'text', 'How well are incoming, in-process and final inspections defined and recorded?', 'answerType', 'rating', 'weight', 4, 'critical', false, 'evidenceRequired', false, 'passRating', 3),
    jsonb_build_object('key', 'calibration', 'section', 'Product and process', 'text', 'Are measuring instruments calibrated to traceable standards?', 'answerType', 'yes_no', 'weight', 4, 'critical', true, 'evidenceRequired', false),
    jsonb_build_object('key', 'nonconformance_process', 'section', 'Product and process', 'text', 'Is there a documented process for non-conforming product and corrective action?', 'answerType', 'yes_no', 'weight', 4, 'critical', true, 'evidenceRequired', false),
    jsonb_build_object('key', 'traceability', 'section', 'Product and process', 'text', 'Can the supplier trace product back to material batches?', 'answerType', 'yes_no', 'weight', 3, 'critical', false, 'evidenceRequired', false),
    jsonb_build_object('key', 'subcontractors', 'section', 'Supply', 'text', 'Does the supplier control any subcontractors it uses?', 'answerType', 'yes_no', 'weight', 2, 'critical', false, 'evidenceRequired', false),
    jsonb_build_object('key', 'capacity', 'section', 'Supply', 'text', 'How confident are you in the supplier''s capacity and ability to deliver on time?', 'answerType', 'rating', 'weight', 3, 'critical', false, 'evidenceRequired', false, 'passRating', 3),
    jsonb_build_object('key', 'assessor_notes', 'section', 'Supply', 'text', 'Anything else the assessor should record?', 'answerType', 'text', 'weight', 1, 'critical', false, 'evidenceRequired', false))
$$;

CREATE FUNCTION app.seed_supplier_assessment_template(p_organisation_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM public.supplier_assessment_templates WHERE organisation_id = p_organisation_id) THEN RETURN; END IF;
  INSERT INTO public.supplier_assessment_templates (organisation_id, name, description)
  VALUES (p_organisation_id, 'Supplier qualification questionnaire', 'The questions a new supplier is assessed against before approval') RETURNING id INTO v_id;
  INSERT INTO public.supplier_assessment_template_versions (organisation_id, template_id, version, questions, pass_mark, reason)
  VALUES (p_organisation_id, v_id, 1, app.default_supplier_assessment_questions(), 75, 'Default template');
END $$;
CREATE FUNCTION app.seed_supplier_assessment_template_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.seed_supplier_assessment_template(NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER organisations_seed_supplier_assessment_template AFTER INSERT ON public.organisations FOR EACH ROW EXECUTE FUNCTION app.seed_supplier_assessment_template_trg();
SELECT app.seed_supplier_assessment_template(o.id) FROM public.organisations o;

-- Create a template (version 1), add a version, rename, switch on or off. All need supplier_quality.configure.
CREATE FUNCTION app.supplier_configure_check(p_organisation uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT app.is_member(p_organisation) THEN RAISE EXCEPTION 'Organisation not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(p_organisation, 'supplier_quality.configure') THEN RAISE EXCEPTION 'You are not allowed to configure supplier qualification' USING ERRCODE = '42501'; END IF;
END $$;

CREATE FUNCTION app.create_supplier_assessment_template(p_organisation uuid, p_name text, p_description text, p_questions jsonb, p_pass_mark integer) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_problem text; v_id uuid;
BEGIN
  PERFORM app.supplier_configure_check(p_organisation);
  IF p_name IS NULL OR length(btrim(p_name)) NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION 'Give the template a name (up to 120 characters)' USING ERRCODE = 'QM020'; END IF;
  IF EXISTS (SELECT 1 FROM public.supplier_assessment_templates WHERE organisation_id = p_organisation AND lower(btrim(name)) = lower(btrim(p_name))) THEN
    RAISE EXCEPTION 'There is already a template called "%"', btrim(p_name) USING ERRCODE = 'QM020';
  END IF;
  v_problem := app.supplier_assessment_questions_problem(p_questions);
  IF v_problem IS NOT NULL THEN RAISE EXCEPTION '%', v_problem USING ERRCODE = 'QM020'; END IF;
  IF p_pass_mark IS NULL OR p_pass_mark NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'The pass mark is 1 to 100' USING ERRCODE = 'QM020'; END IF;
  INSERT INTO public.supplier_assessment_templates (organisation_id, name, description) VALUES (p_organisation, btrim(p_name), nullif(btrim(coalesce(p_description, '')), '')) RETURNING id INTO v_id;
  INSERT INTO public.supplier_assessment_template_versions (organisation_id, template_id, version, questions, pass_mark, reason) VALUES (p_organisation, v_id, 1, p_questions, p_pass_mark, 'First version');
  RETURN v_id;
END $$;

CREATE FUNCTION app.save_supplier_assessment_template_version(p_template uuid, p_questions jsonb, p_pass_mark integer, p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE t public.supplier_assessment_templates%ROWTYPE; v_problem text; v_version integer; v_id uuid;
BEGIN
  SELECT * INTO t FROM public.supplier_assessment_templates WHERE id = p_template FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Template not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.supplier_configure_check(t.organisation_id);
  v_problem := app.supplier_assessment_questions_problem(p_questions);
  IF v_problem IS NOT NULL THEN RAISE EXCEPTION '%', v_problem USING ERRCODE = 'QM020'; END IF;
  IF p_pass_mark IS NULL OR p_pass_mark NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'The pass mark is 1 to 100' USING ERRCODE = 'QM020'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 3 OR length(btrim(p_reason)) > 1000 THEN RAISE EXCEPTION 'Say why the template is changing (3 to 1000 characters)' USING ERRCODE = 'QM020'; END IF;
  SELECT coalesce(max(version), 0) INTO v_version FROM public.supplier_assessment_template_versions WHERE template_id = p_template;
  IF EXISTS (SELECT 1 FROM public.supplier_assessment_template_versions v WHERE v.template_id = p_template AND v.version = v_version AND v.questions = p_questions AND v.pass_mark = p_pass_mark) THEN
    RAISE EXCEPTION 'Nothing has changed from the current version' USING ERRCODE = 'QM020';
  END IF;
  INSERT INTO public.supplier_assessment_template_versions (organisation_id, template_id, version, questions, pass_mark, reason)
  VALUES (t.organisation_id, p_template, v_version + 1, p_questions, p_pass_mark, btrim(p_reason)) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION app.update_supplier_assessment_template(p_template uuid, p_data jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE t public.supplier_assessment_templates%ROWTYPE; v_name text;
BEGIN
  SELECT * INTO t FROM public.supplier_assessment_templates WHERE id = p_template FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Template not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.supplier_configure_check(t.organisation_id);
  IF jsonb_typeof(p_data) <> 'object' THEN RAISE EXCEPTION 'Details must be an object' USING ERRCODE = 'QM020'; END IF;
  v_name := CASE WHEN p_data ? 'name' THEN btrim(p_data ->> 'name') ELSE t.name END;
  IF length(v_name) NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION 'Give the template a name (up to 120 characters)' USING ERRCODE = 'QM020'; END IF;
  IF EXISTS (SELECT 1 FROM public.supplier_assessment_templates o WHERE o.organisation_id = t.organisation_id AND o.id <> t.id AND lower(btrim(o.name)) = lower(v_name)) THEN
    RAISE EXCEPTION 'There is already a template called "%"', v_name USING ERRCODE = 'QM020';
  END IF;
  UPDATE public.supplier_assessment_templates SET name = v_name,
    description = CASE WHEN p_data ? 'description' THEN nullif(btrim(coalesce(p_data ->> 'description', '')), '') ELSE description END,
    active = CASE WHEN p_data ? 'active' THEN (p_data ->> 'active')::boolean ELSE active END
  WHERE id = p_template;
END $$;

-- ---------------------------------------------------------------------------
-- Assessments
-- ---------------------------------------------------------------------------
CREATE TABLE public.supplier_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  reference text NOT NULL,
  supplier_id uuid NOT NULL,
  template_version_id uuid NOT NULL,
  template_name text NOT NULL,
  template_version integer NOT NULL,
  questions jsonb NOT NULL,
  pass_mark integer NOT NULL,
  status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed', 'abandoned')),
  started_at timestamptz NOT NULL DEFAULT now(),
  started_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  completed_at timestamptz,
  completed_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  score numeric(5, 2) CHECK (score IS NULL OR score BETWEEN 0 AND 100),
  critical_failures integer CHECK (critical_failures IS NULL OR critical_failures >= 0),
  result text CHECK (result IS NULL OR result IN ('pass', 'fail')),
  summary text CHECK (summary IS NULL OR length(btrim(summary)) BETWEEN 1 AND 2000),
  abandoned_at timestamptz,
  abandoned_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  abandon_reason text CHECK (abandon_reason IS NULL OR length(btrim(abandon_reason)) BETWEEN 3 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT supplier_assessments_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT supplier_assessments_reference_key UNIQUE (organisation_id, reference),
  CONSTRAINT supplier_assessments_supplier_fkey FOREIGN KEY (supplier_id, organisation_id) REFERENCES public.suppliers (id, organisation_id),
  CONSTRAINT supplier_assessments_template_fkey FOREIGN KEY (template_version_id, organisation_id) REFERENCES public.supplier_assessment_template_versions (id, organisation_id),
  CONSTRAINT supplier_assessments_state CHECK (
    (status = 'in_progress' AND completed_at IS NULL AND result IS NULL AND abandoned_at IS NULL) OR
    (status = 'completed' AND completed_at IS NOT NULL AND result IS NOT NULL AND score IS NOT NULL AND critical_failures IS NOT NULL AND abandoned_at IS NULL) OR
    (status = 'abandoned' AND abandoned_at IS NOT NULL AND abandon_reason IS NOT NULL AND completed_at IS NULL))
);
CREATE UNIQUE INDEX supplier_assessments_one_open ON public.supplier_assessments (supplier_id) WHERE status = 'in_progress';
CREATE INDEX supplier_assessments_supplier_idx ON public.supplier_assessments (supplier_id, started_at DESC);

CREATE TABLE public.supplier_assessment_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  assessment_id uuid NOT NULL,
  question_key text NOT NULL,
  answer text CHECK (answer IS NULL OR answer IN ('yes', 'no', 'na')),
  rating integer CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  note text CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 2000),
  document_id uuid,
  result text NOT NULL CHECK (result IN ('pass', 'fail', 'na', 'unscored')),
  answered_at timestamptz NOT NULL DEFAULT now(),
  answered_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT supplier_assessment_responses_assessment_fkey FOREIGN KEY (assessment_id, organisation_id) REFERENCES public.supplier_assessments (id, organisation_id),
  CONSTRAINT supplier_assessment_responses_document_fkey FOREIGN KEY (document_id, organisation_id) REFERENCES public.supplier_documents (id, organisation_id),
  CONSTRAINT supplier_assessment_responses_key UNIQUE (assessment_id, question_key)
);

-- ---------------------------------------------------------------------------
-- Approval decisions
-- ---------------------------------------------------------------------------
CREATE TABLE public.supplier_approval_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  supplier_id uuid NOT NULL,
  assessment_id uuid,
  from_status text NOT NULL,
  target_status text NOT NULL CHECK (target_status IN ('approved', 'conditional')),
  rationale text NOT NULL CHECK (length(btrim(rationale)) BETWEEN 3 AND 1000),
  conditions text CHECK (conditions IS NULL OR length(btrim(conditions)) BETWEEN 1 AND 2000),
  review_on date,
  exception_reason text CHECK (exception_reason IS NULL OR length(btrim(exception_reason)) BETWEEN 10 AND 1000),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'rejected', 'withdrawn')),
  proposed_by uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  proposed_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  decided_at timestamptz,
  decision_note text CHECK (decision_note IS NULL OR length(btrim(decision_note)) BETWEEN 3 AND 1000),
  status_history_id uuid REFERENCES public.supplier_status_history (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT supplier_approval_decisions_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT supplier_approval_decisions_supplier_fkey FOREIGN KEY (supplier_id, organisation_id) REFERENCES public.suppliers (id, organisation_id),
  CONSTRAINT supplier_approval_decisions_assessment_fkey FOREIGN KEY (assessment_id, organisation_id) REFERENCES public.supplier_assessments (id, organisation_id),
  CONSTRAINT supplier_approval_decisions_conditions CHECK (target_status <> 'conditional' OR conditions IS NOT NULL),
  CONSTRAINT supplier_approval_decisions_state CHECK (
    (status = 'proposed' AND decided_at IS NULL) OR
    (status IN ('approved', 'rejected', 'withdrawn') AND decided_at IS NOT NULL AND decided_by IS NOT NULL AND decision_note IS NOT NULL))
);
CREATE UNIQUE INDEX supplier_approval_decisions_one_open ON public.supplier_approval_decisions (supplier_id) WHERE status = 'proposed';
CREATE INDEX supplier_approval_decisions_supplier_idx ON public.supplier_approval_decisions (supplier_id, proposed_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['supplier_assessment_templates', 'supplier_assessment_template_versions', 'supplier_assessments', 'supplier_assessment_responses', 'supplier_approval_decisions'] LOOP
    EXECUTE format('CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION audit.record_change(%L)', t, 'organisation_id');
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format($p$CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (app.has_permission(organisation_id, 'supplier_quality.read'))$p$, t || '_select', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['supplier_assessment_templates', 'supplier_assessments', 'supplier_assessment_responses', 'supplier_approval_decisions'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION app.stamp_created()', t || '_stamp', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.touch_updated()', t || '_touch', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change()', t || '_org_immutable', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Running an assessment
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.supplier_assessment_for_write(p_assessment uuid) RETURNS public.supplier_assessments
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.supplier_assessments%ROWTYPE;
BEGIN
  SELECT * INTO a FROM public.supplier_assessments WHERE id = p_assessment FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(a.organisation_id) THEN RAISE EXCEPTION 'Assessment not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(a.organisation_id, 'supplier_quality.manage') THEN RAISE EXCEPTION 'You are not allowed to carry out supplier assessments' USING ERRCODE = '42501'; END IF;
  RETURN a;
END $$;

CREATE FUNCTION app.start_supplier_assessment(p_supplier uuid, p_template_version uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.suppliers%ROWTYPE; v public.supplier_assessment_template_versions%ROWTYPE; t public.supplier_assessment_templates%ROWTYPE; v_year integer := extract(year FROM now())::int; v_n integer; v_id uuid;
BEGIN
  s := app.supplier_for_write(p_supplier, 'supplier_quality.manage');
  SELECT * INTO v FROM public.supplier_assessment_template_versions WHERE id = p_template_version AND organisation_id = s.organisation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Template version not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO t FROM public.supplier_assessment_templates WHERE id = v.template_id;
  IF NOT t.active THEN RAISE EXCEPTION 'That template is switched off' USING ERRCODE = 'QM020'; END IF;
  IF v.version <> (SELECT max(version) FROM public.supplier_assessment_template_versions WHERE template_id = t.id) THEN
    RAISE EXCEPTION 'That is not the current version of the template' USING ERRCODE = 'QM020';
  END IF;
  IF EXISTS (SELECT 1 FROM public.supplier_assessments WHERE supplier_id = s.id AND status = 'in_progress') THEN
    RAISE EXCEPTION 'This supplier already has an assessment in progress' USING ERRCODE = 'QM020';
  END IF;
  INSERT INTO app.supplier_assessment_counters AS k (organisation_id, year, last_value) VALUES (s.organisation_id, v_year, 1)
  ON CONFLICT (organisation_id, year) DO UPDATE SET last_value = k.last_value + 1 RETURNING last_value INTO v_n;
  INSERT INTO public.supplier_assessments (organisation_id, reference, supplier_id, template_version_id, template_name, template_version, questions, pass_mark)
  VALUES (s.organisation_id, 'SA-' || to_char(make_date(v_year, 1, 1), 'YY') || '-' || lpad(v_n::text, 4, '0'), s.id, v.id, t.name, v.version, v.questions, v.pass_mark)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- One answer. yes_no: p_answer yes / no / na. rating: p_rating 1..5. text: a note. The database works out pass / fail / n/a.
CREATE FUNCTION app.record_supplier_assessment_response(p_assessment uuid, p_key text, p_answer text, p_rating integer, p_note text, p_document uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.supplier_assessments%ROWTYPE; q jsonb; v_result text; v_note text := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  a := app.supplier_assessment_for_write(p_assessment);
  IF a.status <> 'in_progress' THEN RAISE EXCEPTION 'This assessment is no longer in progress' USING ERRCODE = 'QM020'; END IF;
  SELECT x INTO q FROM jsonb_array_elements(a.questions) x WHERE x ->> 'key' = p_key;
  IF q IS NULL THEN RAISE EXCEPTION 'That question is not part of this assessment' USING ERRCODE = 'QM020'; END IF;
  IF v_note IS NOT NULL AND length(v_note) > 2000 THEN RAISE EXCEPTION 'A note is up to 2000 characters' USING ERRCODE = 'QM020'; END IF;
  IF p_document IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.supplier_documents d WHERE d.id = p_document AND d.supplier_id = a.supplier_id AND d.organisation_id = a.organisation_id AND d.status = 'current') THEN
    RAISE EXCEPTION 'The evidence must be a current document of this supplier' USING ERRCODE = 'QM020';
  END IF;
  CASE q ->> 'answerType'
    WHEN 'yes_no' THEN
      IF p_answer IS NULL OR p_answer NOT IN ('yes', 'no', 'na') THEN RAISE EXCEPTION 'Answer yes, no or not applicable' USING ERRCODE = 'QM020'; END IF;
      IF p_rating IS NOT NULL THEN RAISE EXCEPTION 'This question is answered yes or no' USING ERRCODE = 'QM020'; END IF;
      v_result := CASE p_answer WHEN 'yes' THEN 'pass' WHEN 'no' THEN 'fail' ELSE 'na' END;
    WHEN 'rating' THEN
      IF p_rating IS NULL OR p_rating NOT BETWEEN 1 AND 5 THEN RAISE EXCEPTION 'Give a rating from 1 to 5' USING ERRCODE = 'QM020'; END IF;
      IF p_answer IS NOT NULL THEN RAISE EXCEPTION 'This question is answered with a rating' USING ERRCODE = 'QM020'; END IF;
      v_result := CASE WHEN p_rating >= (q ->> 'passRating')::int THEN 'pass' ELSE 'fail' END;
    ELSE
      IF p_answer IS NOT NULL OR p_rating IS NOT NULL OR p_document IS NOT NULL THEN RAISE EXCEPTION 'This question is answered with a note' USING ERRCODE = 'QM020'; END IF;
      v_result := 'unscored';
  END CASE;
  INSERT INTO public.supplier_assessment_responses AS r (organisation_id, assessment_id, question_key, answer, rating, note, document_id, result)
  VALUES (a.organisation_id, a.id, p_key, p_answer, p_rating, v_note, p_document, v_result)
  ON CONFLICT (assessment_id, question_key) DO UPDATE
    SET answer = excluded.answer, rating = excluded.rating, note = excluded.note, document_id = excluded.document_id, result = excluded.result, answered_at = now(), answered_by = auth.uid();
END $$;

-- What is still needed to complete (the "still needed" list) and the provisional score.
CREATE FUNCTION app.supplier_assessment_progress(p_assessment uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  a public.supplier_assessments%ROWTYPE; q jsonb; r public.supplier_assessment_responses%ROWTYPE; v_problems text[] := ARRAY[]::text[]; v_points numeric := 0; v_possible numeric := 0;
  v_critical integer := 0; v_scored integer := 0; v_answered integer := 0; v_score numeric; v_w numeric;
BEGIN
  SELECT * INTO a FROM public.supplier_assessments WHERE id = p_assessment;
  IF NOT FOUND OR NOT app.is_member(a.organisation_id) OR NOT app.has_permission(a.organisation_id, 'supplier_quality.read') THEN RAISE EXCEPTION 'Assessment not found' USING ERRCODE = 'P0002'; END IF;
  FOR q IN SELECT x FROM jsonb_array_elements(a.questions) x LOOP
    IF (q ->> 'answerType') = 'text' THEN CONTINUE; END IF;
    v_scored := v_scored + 1;
    SELECT * INTO r FROM public.supplier_assessment_responses WHERE assessment_id = a.id AND question_key = q ->> 'key';
    IF NOT FOUND THEN v_problems := v_problems || ('Answer: ' || (q ->> 'text')); CONTINUE; END IF;
    v_answered := v_answered + 1;
    v_w := (q ->> 'weight')::numeric;
    IF r.result = 'fail' AND r.note IS NULL THEN v_problems := v_problems || ('Say why it fails: ' || (q ->> 'text')); END IF;
    IF (q ->> 'evidenceRequired')::boolean AND r.result <> 'na' AND r.document_id IS NULL THEN v_problems := v_problems || ('Attach the evidence: ' || (q ->> 'text')); END IF;
    IF r.result = 'na' THEN CONTINUE; END IF;
    v_possible := v_possible + v_w;
    IF (q ->> 'answerType') = 'yes_no' THEN
      IF r.result = 'pass' THEN v_points := v_points + v_w; END IF;
    ELSE
      v_points := v_points + v_w * (r.rating - 1) / 4.0;
    END IF;
    IF r.result = 'fail' AND (q ->> 'critical')::boolean THEN v_critical := v_critical + 1; END IF;
  END LOOP;
  IF v_possible = 0 AND v_answered = v_scored AND v_scored > 0 THEN v_problems := v_problems || 'Every scored question is not applicable, so there is nothing to score'; END IF;
  v_score := CASE WHEN v_possible > 0 THEN round(100 * v_points / v_possible, 2) ELSE NULL END;
  RETURN jsonb_build_object('scored', v_scored, 'answered', v_answered, 'problems', to_jsonb(v_problems), 'score', v_score, 'criticalFailures', v_critical, 'passMark', a.pass_mark,
    'result', CASE WHEN v_score IS NULL THEN NULL WHEN v_critical = 0 AND v_score >= a.pass_mark THEN 'pass' ELSE 'fail' END);
END $$;

CREATE FUNCTION app.complete_supplier_assessment(p_assessment uuid, p_summary text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.supplier_assessments%ROWTYPE; p jsonb; v_summary text := nullif(btrim(coalesce(p_summary, '')), '');
BEGIN
  a := app.supplier_assessment_for_write(p_assessment);
  IF a.status <> 'in_progress' THEN RAISE EXCEPTION 'This assessment is no longer in progress' USING ERRCODE = 'QM020'; END IF;
  IF v_summary IS NOT NULL AND length(v_summary) > 2000 THEN RAISE EXCEPTION 'The summary is up to 2000 characters' USING ERRCODE = 'QM020'; END IF;
  p := app.supplier_assessment_progress(p_assessment);
  IF jsonb_array_length(p -> 'problems') > 0 THEN RAISE EXCEPTION 'The assessment is not complete yet: %', p -> 'problems' ->> 0 USING ERRCODE = 'QM020'; END IF;
  UPDATE public.supplier_assessments SET status = 'completed', completed_at = now(), completed_by = auth.uid(), score = (p ->> 'score')::numeric, critical_failures = (p ->> 'criticalFailures')::int,
    result = p ->> 'result', summary = v_summary WHERE id = p_assessment;
  PERFORM app.emit_event(a.organisation_id, 'supplier.assessment.completed', 'supplier_assessment', a.id, jsonb_build_object('reference', a.reference, 'result', p ->> 'result', 'score', (p ->> 'score')::numeric));
END $$;

CREATE FUNCTION app.abandon_supplier_assessment(p_assessment uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.supplier_assessments%ROWTYPE;
BEGIN
  a := app.supplier_assessment_for_write(p_assessment);
  IF a.status <> 'in_progress' THEN RAISE EXCEPTION 'Only an assessment in progress can be abandoned' USING ERRCODE = 'QM020'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 3 OR length(btrim(p_reason)) > 1000 THEN RAISE EXCEPTION 'Give a reason (3 to 1000 characters)' USING ERRCODE = 'QM020'; END IF;
  UPDATE public.supplier_assessments SET status = 'abandoned', abandoned_at = now(), abandoned_by = auth.uid(), abandon_reason = btrim(p_reason) WHERE id = p_assessment;
END $$;

-- ---------------------------------------------------------------------------
-- Status changes to approved / conditional only through a decision
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.change_supplier_status(
  p_supplier uuid, p_status text, p_reason text, p_conditions text DEFAULT NULL, p_review_on date DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  s public.suppliers%ROWTYPE;
  v_id uuid;
BEGIN
  SELECT * INTO s FROM public.suppliers WHERE id = p_supplier FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(s.organisation_id) THEN
    RAISE EXCEPTION 'Supplier not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT app.has_permission(s.organisation_id, 'supplier_quality.approve') THEN
    RAISE EXCEPTION 'You are not allowed to change a supplier''s approval status' USING ERRCODE = '42501';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('pending_approval', 'approved', 'conditional', 'suspended', 'disqualified', 'archived') THEN
    RAISE EXCEPTION 'Unknown approval status' USING ERRCODE = 'QM020';
  END IF;
  IF p_status IN ('approved', 'conditional') AND coalesce(current_setting('app.supplier_approval_decision', true), '') <> 'on' THEN
    RAISE EXCEPTION 'A supplier is approved through an approval decision: one person proposes it and someone else approves it' USING ERRCODE = 'QM020';
  END IF;
  IF p_status = s.approval_status THEN
    RAISE EXCEPTION 'The supplier is already %', replace(p_status, '_', ' ') USING ERRCODE = 'QM020';
  END IF;
  IF NOT app.supplier_status_allowed(s.approval_status, p_status) THEN
    RAISE EXCEPTION 'A supplier that is % cannot be moved to %', replace(s.approval_status, '_', ' '), replace(p_status, '_', ' ') USING ERRCODE = 'QM020';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 3 OR length(btrim(p_reason)) > 1000 THEN
    RAISE EXCEPTION 'Give a reason (3 to 1000 characters)' USING ERRCODE = 'QM020';
  END IF;
  IF p_status = 'conditional' AND (p_conditions IS NULL OR length(btrim(p_conditions)) < 1) THEN
    RAISE EXCEPTION 'State the conditions or restrictions of a conditional approval' USING ERRCODE = 'QM020';
  END IF;
  IF p_review_on IS NOT NULL AND p_review_on < current_date THEN
    RAISE EXCEPTION 'The review date cannot be in the past' USING ERRCODE = 'QM020';
  END IF;

  UPDATE public.suppliers SET approval_status = p_status, approval_status_changed_at = now(), approval_status_changed_by = auth.uid() WHERE id = s.id;
  INSERT INTO public.supplier_status_history (organisation_id, supplier_id, from_status, to_status, reason, conditions, review_on, changed_at, changed_by)
  VALUES (s.organisation_id, s.id, s.approval_status, p_status, btrim(p_reason),
          CASE WHEN p_status = 'conditional' THEN btrim(p_conditions) ELSE NULL END, p_review_on, now(), auth.uid())
  RETURNING id INTO v_id;
  PERFORM app.emit_event(s.organisation_id, 'supplier.approval_status_changed', 'supplier', s.id,
    jsonb_build_object('from', s.approval_status, 'to', p_status, 'code', s.code));
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------
-- Approval decisions: proposed by one person, decided by another
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.propose_supplier_approval(
  p_supplier uuid, p_target text, p_rationale text, p_assessment uuid DEFAULT NULL, p_conditions text DEFAULT NULL, p_review_on date DEFAULT NULL, p_exception_reason text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.suppliers%ROWTYPE; a public.supplier_assessments%ROWTYPE; v_exception text := nullif(btrim(coalesce(p_exception_reason, '')), ''); v_needs boolean; v_id uuid;
BEGIN
  s := app.supplier_for_write(p_supplier, 'supplier_quality.manage');
  IF p_target IS NULL OR p_target NOT IN ('approved', 'conditional') THEN RAISE EXCEPTION 'A decision approves a supplier or approves it conditionally' USING ERRCODE = 'QM020'; END IF;
  IF NOT app.supplier_status_allowed(s.approval_status, p_target) THEN
    RAISE EXCEPTION 'A supplier that is % cannot be moved to %', replace(s.approval_status, '_', ' '), replace(p_target, '_', ' ') USING ERRCODE = 'QM020';
  END IF;
  IF EXISTS (SELECT 1 FROM public.supplier_approval_decisions WHERE supplier_id = s.id AND status = 'proposed') THEN
    RAISE EXCEPTION 'There is already a proposal waiting for a decision' USING ERRCODE = 'QM020';
  END IF;
  IF p_rationale IS NULL OR length(btrim(p_rationale)) < 3 OR length(btrim(p_rationale)) > 1000 THEN RAISE EXCEPTION 'Give the rationale (3 to 1000 characters)' USING ERRCODE = 'QM020'; END IF;
  IF p_target = 'conditional' AND (p_conditions IS NULL OR length(btrim(p_conditions)) < 1) THEN RAISE EXCEPTION 'State the conditions or restrictions of a conditional approval' USING ERRCODE = 'QM020'; END IF;
  IF p_review_on IS NOT NULL AND p_review_on <= current_date THEN RAISE EXCEPTION 'The review date must be after today' USING ERRCODE = 'QM020'; END IF;
  IF p_assessment IS NOT NULL THEN
    SELECT * INTO a FROM public.supplier_assessments WHERE id = p_assessment AND supplier_id = s.id AND organisation_id = s.organisation_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'That assessment is not one of this supplier''s' USING ERRCODE = 'QM020'; END IF;
    IF a.status <> 'completed' THEN RAISE EXCEPTION 'The assessment is not completed' USING ERRCODE = 'QM020'; END IF;
  END IF;
  -- Approving needs a passing assessment; otherwise it is an exception, said in words and flagged. A conditional approval needs some completed assessment.
  v_needs := p_assessment IS NULL OR (p_target = 'approved' AND a.result <> 'pass');
  IF v_needs AND v_exception IS NULL THEN
    IF p_assessment IS NULL THEN
      RAISE EXCEPTION 'Link a completed assessment, or give the reason this approval is an exception (at least 10 characters)' USING ERRCODE = 'QM020';
    END IF;
    RAISE EXCEPTION 'The assessment did not pass: give the reason this approval is an exception (at least 10 characters)' USING ERRCODE = 'QM020';
  END IF;
  IF v_needs AND length(v_exception) NOT BETWEEN 10 AND 1000 THEN
    RAISE EXCEPTION 'The exception reason is 10 to 1000 characters' USING ERRCODE = 'QM020';
  END IF;
  IF NOT v_needs THEN v_exception := NULL; END IF;
  INSERT INTO public.supplier_approval_decisions (organisation_id, supplier_id, assessment_id, from_status, target_status, rationale, conditions, review_on, exception_reason)
  VALUES (s.organisation_id, s.id, p_assessment, s.approval_status, p_target, btrim(p_rationale), CASE WHEN p_target = 'conditional' THEN btrim(p_conditions) ELSE NULL END, p_review_on, v_exception)
  RETURNING id INTO v_id;
  PERFORM app.emit_event(s.organisation_id, 'supplier.approval.proposed', 'supplier', s.id, jsonb_build_object('code', s.code, 'target', p_target, 'exception', v_exception IS NOT NULL));
  RETURN v_id;
END $$;

CREATE FUNCTION app.decide_supplier_approval(p_decision uuid, p_approve boolean, p_note text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE d public.supplier_approval_decisions%ROWTYPE; s public.suppliers%ROWTYPE; v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_history uuid;
BEGIN
  SELECT * INTO d FROM public.supplier_approval_decisions WHERE id = p_decision FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(d.organisation_id) THEN RAISE EXCEPTION 'Decision not found' USING ERRCODE = 'P0002'; END IF;
  s := app.supplier_for_write(d.supplier_id, 'supplier_quality.approve');
  IF d.status <> 'proposed' THEN RAISE EXCEPTION 'This proposal has already been decided or withdrawn' USING ERRCODE = 'QM020'; END IF;
  IF d.proposed_by = auth.uid() THEN RAISE EXCEPTION 'You prepared this proposal, so someone else must decide it' USING ERRCODE = 'QM020'; END IF;
  IF p_approve IS NULL THEN RAISE EXCEPTION 'Approve or reject' USING ERRCODE = 'QM020'; END IF;
  IF v_note IS NULL OR length(v_note) < 3 OR length(v_note) > 1000 THEN RAISE EXCEPTION 'Give a note for the decision (3 to 1000 characters)' USING ERRCODE = 'QM020'; END IF;
  IF p_approve THEN
    IF s.approval_status <> d.from_status THEN
      RAISE EXCEPTION 'The supplier is now % (it was % when this was proposed): withdraw the proposal and propose again', replace(s.approval_status, '_', ' '), replace(d.from_status, '_', ' ') USING ERRCODE = 'QM020';
    END IF;
    PERFORM set_config('app.supplier_approval_decision', 'on', true);
    v_history := app.change_supplier_status(s.id, d.target_status, d.rationale, d.conditions, d.review_on);
    PERFORM set_config('app.supplier_approval_decision', 'off', true);
  END IF;
  UPDATE public.supplier_approval_decisions SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END, decided_by = auth.uid(), decided_at = now(), decision_note = v_note,
    status_history_id = v_history WHERE id = p_decision;
END $$;

CREATE FUNCTION app.withdraw_supplier_approval(p_decision uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE d public.supplier_approval_decisions%ROWTYPE;
BEGIN
  SELECT * INTO d FROM public.supplier_approval_decisions WHERE id = p_decision FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(d.organisation_id) THEN RAISE EXCEPTION 'Decision not found' USING ERRCODE = 'P0002'; END IF;
  IF d.status <> 'proposed' THEN RAISE EXCEPTION 'Only a proposal waiting for a decision can be withdrawn' USING ERRCODE = 'QM020'; END IF;
  IF NOT (d.proposed_by = auth.uid() OR app.has_permission(d.organisation_id, 'supplier_quality.approve')) THEN
    RAISE EXCEPTION 'Only the person who proposed it, or an approver, can withdraw it' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 3 OR length(btrim(p_reason)) > 1000 THEN RAISE EXCEPTION 'Give a reason (3 to 1000 characters)' USING ERRCODE = 'QM020'; END IF;
  UPDATE public.supplier_approval_decisions SET status = 'withdrawn', decided_by = auth.uid(), decided_at = now(), decision_note = btrim(p_reason) WHERE id = p_decision;
END $$;

REVOKE ALL ON FUNCTION app.supplier_assessment_questions_problem(jsonb), app.default_supplier_assessment_questions(), app.seed_supplier_assessment_template(uuid), app.seed_supplier_assessment_template_trg(),
  app.supplier_configure_check(uuid), app.create_supplier_assessment_template(uuid, text, text, jsonb, integer), app.save_supplier_assessment_template_version(uuid, jsonb, integer, text),
  app.update_supplier_assessment_template(uuid, jsonb), app.supplier_assessment_for_write(uuid), app.start_supplier_assessment(uuid, uuid),
  app.record_supplier_assessment_response(uuid, text, text, integer, text, uuid), app.supplier_assessment_progress(uuid), app.complete_supplier_assessment(uuid, text),
  app.abandon_supplier_assessment(uuid, text), app.propose_supplier_approval(uuid, text, text, uuid, text, date, text), app.decide_supplier_approval(uuid, boolean, text),
  app.withdraw_supplier_approval(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.create_supplier_assessment_template(uuid, text, text, jsonb, integer), app.save_supplier_assessment_template_version(uuid, jsonb, integer, text),
  app.update_supplier_assessment_template(uuid, jsonb), app.start_supplier_assessment(uuid, uuid), app.record_supplier_assessment_response(uuid, text, text, integer, text, uuid),
  app.supplier_assessment_progress(uuid), app.complete_supplier_assessment(uuid, text), app.abandon_supplier_assessment(uuid, text),
  app.propose_supplier_approval(uuid, text, text, uuid, text, date, text), app.decide_supplier_approval(uuid, boolean, text), app.withdraw_supplier_approval(uuid, text) TO authenticated;
