-- Audits, slice AU5 (docs/audits-plan.md §10): RESPONSE TYPES set in the template. The quality team chooses per question how it is answered and the audit record shows exactly that control.
--
--  Types: yes_no, compliant, pass_fail, yes_no_na, numeric, text, multiple_choice, measurement, evidence, rating.
--  * N/A exists only in yes_no_na (existing yes_no questions become yes_no_na, number becomes numeric; no live audits exist, so nothing else changes).
--  * numeric: optional unit and limits (scored only when a limit is set). measurement: nominal, lower and upper limit and unit all required (the form works the limits out from nominal ± tolerance).
--  * multiple_choice: 2–20 options, each marked acceptable or not; the answer is one option. rating: a whole number 1..rating_max (3–10), scored only when a lowest acceptable rating is set.
--  * evidence: no answer, at least one live file on the question is needed to complete (audit_attachments, private audit-files bucket, removed with a reason, never deleted).
--  * critical only on a scored question. The record keeps a frozen copy of all of it.

-- ---------------------------------------------------------------------------
-- Questions (template) and their frozen copies
-- ---------------------------------------------------------------------------
ALTER TABLE public.audit_questions DROP CONSTRAINT audit_questions_shape;
ALTER TABLE public.audit_questions DROP CONSTRAINT audit_questions_answer_type_check;
ALTER TABLE public.audit_record_questions DROP CONSTRAINT audit_record_questions_answer_type_check;

UPDATE public.audit_questions SET answer_type = 'yes_no_na' WHERE answer_type = 'yes_no';
UPDATE public.audit_questions SET answer_type = 'numeric' WHERE answer_type = 'number';
UPDATE public.audit_record_questions SET answer_type = 'yes_no_na' WHERE answer_type = 'yes_no';
UPDATE public.audit_record_questions SET answer_type = 'numeric' WHERE answer_type = 'number';

ALTER TABLE public.audit_questions
  ADD COLUMN options jsonb,
  ADD COLUMN nominal numeric,
  ADD COLUMN rating_max integer,
  ADD COLUMN pass_rating integer;
ALTER TABLE public.audit_record_questions
  ADD COLUMN options jsonb,
  ADD COLUMN nominal numeric,
  ADD COLUMN rating_max integer,
  ADD COLUMN pass_rating integer;

-- One definition of what a valid question looks like, used by both tables.
CREATE FUNCTION app.audit_question_valid(p_type text, p_pass_answer text, p_unit text, p_lower numeric, p_upper numeric, p_nominal numeric, p_options jsonb,
                                         p_rating_max integer, p_pass_rating integer, p_critical boolean) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p_type IN ('yes_no', 'compliant', 'pass_fail', 'yes_no_na', 'numeric', 'text', 'multiple_choice', 'measurement', 'evidence', 'rating')
     AND (p_type IN ('yes_no', 'yes_no_na')) = (p_pass_answer IS NOT NULL)
     AND (p_type = 'multiple_choice') = (p_options IS NOT NULL)
     AND (p_options IS NULL OR (jsonb_typeof(p_options) = 'array' AND jsonb_array_length(p_options) BETWEEN 2 AND 20))
     AND (p_type IN ('numeric', 'measurement') OR (p_unit IS NULL AND p_lower IS NULL AND p_upper IS NULL))
     AND (p_type = 'measurement' OR p_nominal IS NULL)
     AND (p_type <> 'measurement' OR (p_nominal IS NOT NULL AND p_unit IS NOT NULL AND p_lower IS NOT NULL AND p_upper IS NOT NULL AND p_lower <= p_nominal AND p_nominal <= p_upper))
     AND (p_lower IS NULL OR p_upper IS NULL OR p_lower <= p_upper)
     AND (p_type = 'rating') = (p_rating_max IS NOT NULL)
     AND (p_type = 'rating' OR p_pass_rating IS NULL)
     AND (p_type <> 'rating' OR (p_rating_max BETWEEN 3 AND 10 AND (p_pass_rating IS NULL OR p_pass_rating BETWEEN 1 AND p_rating_max)))
     -- Critical needs a question that can fail.
     AND (NOT p_critical OR p_type IN ('yes_no', 'compliant', 'pass_fail', 'yes_no_na', 'multiple_choice', 'measurement')
          OR (p_type = 'numeric' AND (p_lower IS NOT NULL OR p_upper IS NOT NULL))
          OR (p_type = 'rating' AND p_pass_rating IS NOT NULL))
$$;
REVOKE ALL ON FUNCTION app.audit_question_valid(text, text, text, numeric, numeric, numeric, jsonb, integer, integer, boolean) FROM PUBLIC, anon, authenticated;

ALTER TABLE public.audit_questions ADD CONSTRAINT audit_questions_shape CHECK (
  app.audit_question_valid(answer_type, pass_answer, unit, lower_limit, upper_limit, nominal, options, rating_max, pass_rating, critical));
ALTER TABLE public.audit_record_questions ADD CONSTRAINT audit_record_questions_shape CHECK (
  app.audit_question_valid(answer_type, pass_answer, unit, lower_limit, upper_limit, nominal, options, rating_max, pass_rating, critical));

-- ---------------------------------------------------------------------------
-- Answers
-- ---------------------------------------------------------------------------
ALTER TABLE public.audit_responses DROP CONSTRAINT audit_responses_answer_check;
ALTER TABLE public.audit_responses ADD CONSTRAINT audit_responses_answer_check CHECK (answer IS NULL OR answer IN ('pass', 'fail', 'yes', 'no', 'na', 'compliant', 'non_compliant'));
ALTER TABLE public.audit_responses ADD COLUMN choice text CHECK (choice IS NULL OR length(btrim(choice)) BETWEEN 1 AND 100);

-- ---------------------------------------------------------------------------
-- Evidence files
-- ---------------------------------------------------------------------------
CREATE TABLE public.audit_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  audit_record_id uuid NOT NULL,
  record_question_id uuid NOT NULL,
  storage_path text NOT NULL,
  file_name text NOT NULL CHECK (length(btrim(file_name)) BETWEEN 1 AND 255),
  content_type text,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 26214400),
  deleted_at timestamptz,
  deleted_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  delete_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT audit_attachments_record_fkey FOREIGN KEY (audit_record_id, organisation_id) REFERENCES public.audit_records (id, organisation_id),
  CONSTRAINT audit_attachments_question_fkey FOREIGN KEY (record_question_id, audit_record_id) REFERENCES public.audit_record_questions (id, audit_record_id),
  CONSTRAINT audit_attachments_key UNIQUE (audit_record_id, storage_path),
  CONSTRAINT audit_attachments_path CHECK (storage_path LIKE organisation_id::text || '/audit/%/%' AND storage_path NOT LIKE '%..%')
);
CREATE INDEX audit_attachments_question_idx ON public.audit_attachments (record_question_id);

CREATE FUNCTION app.audit_attachment_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['deleted_at', 'deleted_by', 'delete_reason', 'updated_at', 'updated_by'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['deleted_at', 'deleted_by', 'delete_reason', 'updated_at', 'updated_by']) THEN
    RAISE EXCEPTION 'An evidence file cannot be changed, only removed or restored' USING ERRCODE = 'QM018';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION app.audit_attachment_no_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'Evidence files of an audit are never deleted' USING ERRCODE = 'QM018';
END $$;

CREATE TRIGGER audit_attachments_stamp BEFORE INSERT ON public.audit_attachments FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER audit_attachments_rules BEFORE UPDATE ON public.audit_attachments FOR EACH ROW EXECUTE FUNCTION app.audit_attachment_rules();
CREATE TRIGGER audit_attachments_touch BEFORE UPDATE ON public.audit_attachments FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER audit_attachments_org_immutable BEFORE UPDATE ON public.audit_attachments FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER audit_attachments_no_delete BEFORE DELETE ON public.audit_attachments FOR EACH ROW EXECUTE FUNCTION app.audit_attachment_no_delete();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.audit_attachments FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.audit_attachments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_attachments FROM anon, authenticated;
GRANT SELECT ON public.audit_attachments TO authenticated;
CREATE POLICY audit_attachments_select ON public.audit_attachments FOR SELECT TO authenticated USING (app.has_permission(organisation_id, 'audits.read'));

-- Records a file already uploaded into the record's folder against an evidence question. In-progress records only (audits.perform).
CREATE FUNCTION app.add_audit_attachment(p_record uuid, p_question uuid, p_storage_path text, p_file_name text, p_content_type text, p_size_bytes bigint) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.audit_records%ROWTYPE; q public.audit_record_questions%ROWTYPE; v_id uuid;
BEGIN
  r := app.audit_record_for_perform(p_record);
  SELECT * INTO q FROM public.audit_record_questions WHERE id = p_question AND audit_record_id = p_record;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Question not found' USING ERRCODE = 'P0002';
  END IF;
  IF q.answer_type <> 'evidence' THEN
    RAISE EXCEPTION 'Files can only be added to a question that asks for evidence' USING ERRCODE = 'QM018';
  END IF;
  IF p_storage_path NOT LIKE r.organisation_id::text || '/audit/' || r.id::text || '/%' THEN
    RAISE EXCEPTION 'The file must be stored in this record''s folder' USING ERRCODE = 'QM018';
  END IF;
  INSERT INTO public.audit_attachments (organisation_id, audit_record_id, record_question_id, storage_path, file_name, content_type, size_bytes)
  VALUES (r.organisation_id, r.id, p_question, p_storage_path, btrim(p_file_name), p_content_type, p_size_bytes) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION app.remove_audit_attachment(p_attachment uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_record uuid; v_removed timestamptz;
BEGIN
  SELECT audit_record_id, deleted_at INTO v_record, v_removed FROM public.audit_attachments WHERE id = p_attachment;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'File not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM app.audit_record_for_perform(v_record);
  IF v_removed IS NOT NULL THEN
    RAISE EXCEPTION 'That file is already removed' USING ERRCODE = 'QM018';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'Say why the file is removed' USING ERRCODE = 'QM018';
  END IF;
  UPDATE public.audit_attachments SET deleted_at = now(), deleted_by = auth.uid(), delete_reason = btrim(p_reason) WHERE id = p_attachment;
END $$;

CREATE FUNCTION app.restore_audit_attachment(p_attachment uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_record uuid; v_removed timestamptz;
BEGIN
  SELECT audit_record_id, deleted_at INTO v_record, v_removed FROM public.audit_attachments WHERE id = p_attachment;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'File not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM app.audit_record_for_perform(v_record);
  IF v_removed IS NULL THEN
    RAISE EXCEPTION 'That file is not removed' USING ERRCODE = 'QM018';
  END IF;
  UPDATE public.audit_attachments SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL WHERE id = p_attachment;
END $$;

-- Storage: <org>/audit/<record id>/... Readable by anyone who can read audits; uploads only into an in-progress record by someone who may perform audits; never updated or deleted.
INSERT INTO storage.buckets (id, name, public) VALUES ('audit-files', 'audit-files', false) ON CONFLICT (id) DO NOTHING;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'storage' AND table_name = 'buckets' AND column_name = 'file_size_limit') THEN
    EXECUTE $q$UPDATE storage.buckets SET file_size_limit = 26214400 WHERE id = 'audit-files'$q$;
  END IF;
END $$;

CREATE FUNCTION app.audit_file_allowed(p_object_name text, p_upload boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT split_part(p_object_name, '/', 2) = 'audit'
     AND EXISTS (
       SELECT 1 FROM public.audit_records r
       WHERE r.id = app.try_uuid(split_part(p_object_name, '/', 3))
         AND r.organisation_id = app.try_uuid(split_part(p_object_name, '/', 1))
         AND CASE WHEN p_upload
                  THEN r.status = 'in_progress' AND app.has_permission(r.organisation_id, 'audits.perform')
                  ELSE app.has_permission(r.organisation_id, 'audits.read') END)
$$;
CREATE POLICY audit_files_select ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'audit-files' AND app.audit_file_allowed(name, false));
CREATE POLICY audit_files_insert ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'audit-files' AND app.audit_file_allowed(name, true));

-- ---------------------------------------------------------------------------
-- The checklist, as written in the template
-- p_questions: [{ question, guidance?, answerType, passAnswer?, unit?, lowerLimit?, upperLimit?, nominal?, options?: [{ label, passes }], ratingMax?, passRating?, critical? }]
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.set_audit_checklist(p_definition uuid, p_questions jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  d public.audit_definitions%ROWTYPE;
  q jsonb;
  o jsonb;
  i integer := 0;
  v_type text;
  v_options jsonb;
  v_labels text[];
  v_label text;
  v_pass_answer text;
  v_unit text;
  v_lower numeric; v_upper numeric; v_nominal numeric;
  v_rating_max integer; v_pass_rating integer;
  v_critical boolean;
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
    IF v_type IS NULL OR v_type NOT IN ('yes_no', 'compliant', 'pass_fail', 'yes_no_na', 'numeric', 'text', 'multiple_choice', 'measurement', 'evidence', 'rating') THEN
      RAISE EXCEPTION 'Question %: choose how it is answered', i USING ERRCODE = 'QM018';
    END IF;
    IF length(btrim(coalesce(q->>'question', ''))) = 0 THEN
      RAISE EXCEPTION 'Question %: write the question', i USING ERRCODE = 'QM018';
    END IF;
    v_pass_answer := NULL; v_unit := NULL; v_lower := NULL; v_upper := NULL; v_nominal := NULL; v_options := NULL; v_rating_max := NULL; v_pass_rating := NULL;
    v_critical := coalesce((q->>'critical')::boolean, false);

    IF v_type IN ('yes_no', 'yes_no_na') THEN
      v_pass_answer := coalesce(nullif(q->>'passAnswer', ''), 'yes');
      IF v_pass_answer NOT IN ('yes', 'no') THEN
        RAISE EXCEPTION 'Question %: choose whether yes or no passes', i USING ERRCODE = 'QM018';
      END IF;
    ELSIF v_type = 'numeric' THEN
      v_unit := nullif(btrim(coalesce(q->>'unit', '')), '');
      v_lower := (q->>'lowerLimit')::numeric; v_upper := (q->>'upperLimit')::numeric;
      IF v_lower IS NOT NULL AND v_upper IS NOT NULL AND v_lower > v_upper THEN
        RAISE EXCEPTION 'Question %: the lower limit is above the upper limit', i USING ERRCODE = 'QM018';
      END IF;
    ELSIF v_type = 'measurement' THEN
      v_unit := nullif(btrim(coalesce(q->>'unit', '')), '');
      v_nominal := (q->>'nominal')::numeric; v_lower := (q->>'lowerLimit')::numeric; v_upper := (q->>'upperLimit')::numeric;
      IF v_nominal IS NULL OR v_lower IS NULL OR v_upper IS NULL OR v_unit IS NULL THEN
        RAISE EXCEPTION 'Question %: a measurement needs a nominal value, its tolerance and a unit', i USING ERRCODE = 'QM018';
      END IF;
      IF NOT (v_lower <= v_nominal AND v_nominal <= v_upper) THEN
        RAISE EXCEPTION 'Question %: the nominal value must lie between the lower and the upper limit', i USING ERRCODE = 'QM018';
      END IF;
    ELSIF v_type = 'multiple_choice' THEN
      IF jsonb_typeof(q->'options') IS DISTINCT FROM 'array' OR jsonb_array_length(q->'options') < 2 OR jsonb_array_length(q->'options') > 20 THEN
        RAISE EXCEPTION 'Question %: give between 2 and 20 options', i USING ERRCODE = 'QM018';
      END IF;
      v_options := '[]'::jsonb; v_labels := ARRAY[]::text[];
      FOR o IN SELECT * FROM jsonb_array_elements(q->'options') LOOP
        v_label := btrim(coalesce(o->>'label', ''));
        IF v_label = '' OR length(v_label) > 100 THEN
          RAISE EXCEPTION 'Question %: every option needs its words (at most 100 characters)', i USING ERRCODE = 'QM018';
        END IF;
        IF lower(v_label) = ANY (v_labels) THEN
          RAISE EXCEPTION 'Question %: the option "%" is listed twice', i, v_label USING ERRCODE = 'QM018';
        END IF;
        v_labels := array_append(v_labels, lower(v_label));
        v_options := v_options || jsonb_build_array(jsonb_build_object('label', v_label, 'passes', coalesce((o->>'passes')::boolean, true)));
      END LOOP;
      IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_options) x WHERE (x->>'passes')::boolean) THEN
        RAISE EXCEPTION 'Question %: at least one option must be acceptable', i USING ERRCODE = 'QM018';
      END IF;
    ELSIF v_type = 'rating' THEN
      v_rating_max := coalesce((q->>'ratingMax')::integer, 5);
      v_pass_rating := (q->>'passRating')::integer;
      IF v_rating_max < 3 OR v_rating_max > 10 THEN
        RAISE EXCEPTION 'Question %: a rating scale runs from 1 to between 3 and 10', i USING ERRCODE = 'QM018';
      END IF;
      IF v_pass_rating IS NOT NULL AND (v_pass_rating < 1 OR v_pass_rating > v_rating_max) THEN
        RAISE EXCEPTION 'Question %: the lowest acceptable rating must be on the scale', i USING ERRCODE = 'QM018';
      END IF;
    END IF;

    IF NOT app.audit_question_valid(v_type, v_pass_answer, v_unit, v_lower, v_upper, v_nominal, v_options, v_rating_max, v_pass_rating, v_critical) THEN
      RAISE EXCEPTION 'Question %: it cannot be critical unless it can fail (give a numeric limit or a lowest acceptable rating, or choose another type)', i USING ERRCODE = 'QM018';
    END IF;
    INSERT INTO public.audit_questions (organisation_id, audit_definition_id, sequence, question, guidance, answer_type, pass_answer, unit, lower_limit, upper_limit, nominal, options, rating_max, pass_rating, critical)
    VALUES (d.organisation_id, p_definition, i, btrim(q->>'question'), nullif(btrim(coalesce(q->>'guidance', '')), ''), v_type, v_pass_answer, v_unit, v_lower, v_upper, v_nominal, v_options, v_rating_max, v_pass_rating, v_critical);
  END LOOP;
  UPDATE public.audit_definitions SET updated_at = now() WHERE id = p_definition;
END $$;

-- ---------------------------------------------------------------------------
-- Start: the frozen copy carries everything a type needs
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.start_audit(p_definition uuid, p_occurrence uuid DEFAULT NULL, p_targets jsonb DEFAULT '[]'::jsonb) RETURNS uuid
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
  INSERT INTO public.audit_record_questions (organisation_id, audit_record_id, sequence, question, guidance, answer_type, pass_answer, unit, lower_limit, upper_limit, nominal, options, rating_max, pass_rating, critical)
  SELECT q.organisation_id, v_id, q.sequence, q.question, q.guidance, q.answer_type, q.pass_answer, q.unit, q.lower_limit, q.upper_limit, q.nominal, q.options, q.rating_max, q.pass_rating, q.critical
    FROM public.audit_questions q WHERE q.audit_definition_id = p_definition ORDER BY q.sequence;
  IF p_targets IS NOT NULL AND jsonb_typeof(p_targets) = 'array' AND jsonb_array_length(p_targets) > 0 THEN
    PERFORM app.set_audit_record_targets(v_id, p_targets);
  END IF;
  PERFORM app.emit_event(d.organisation_id, 'audit.started', 'audit_record', v_id, jsonb_build_object('audit', d.reference, 'occurrence', p_occurrence));
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------
-- Answer a question, by its type. Giving nothing at all clears the answer.
-- ---------------------------------------------------------------------------
DROP FUNCTION app.record_audit_response(uuid, uuid, text, numeric, text);
CREATE FUNCTION app.record_audit_response(p_record uuid, p_question uuid, p_answer text DEFAULT NULL, p_value numeric DEFAULT NULL, p_note text DEFAULT NULL, p_choice text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  r public.audit_records%ROWTYPE;
  q public.audit_record_questions%ROWTYPE;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_answer text := nullif(btrim(coalesce(p_answer, '')), '');
  v_choice text := nullif(btrim(coalesce(p_choice, '')), '');
  v_value numeric := p_value;
  v_result text;
  v_opt jsonb;
BEGIN
  r := app.audit_record_for_perform(p_record);
  SELECT * INTO q FROM public.audit_record_questions WHERE id = p_question AND audit_record_id = p_record;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Question not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_answer IS NULL AND v_value IS NULL AND v_note IS NULL AND v_choice IS NULL THEN
    DELETE FROM public.audit_responses WHERE record_question_id = p_question;
    RETURN;
  END IF;

  IF q.answer_type = 'yes_no' THEN
    IF v_answer IS NULL OR v_answer NOT IN ('yes', 'no') THEN RAISE EXCEPTION 'Answer yes or no' USING ERRCODE = 'QM018'; END IF;
    v_result := CASE WHEN v_answer = q.pass_answer THEN 'pass' ELSE 'fail' END; v_value := NULL; v_choice := NULL;
  ELSIF q.answer_type = 'yes_no_na' THEN
    IF v_answer IS NULL OR v_answer NOT IN ('yes', 'no', 'na') THEN RAISE EXCEPTION 'Answer yes, no or not applicable' USING ERRCODE = 'QM018'; END IF;
    v_result := CASE WHEN v_answer = 'na' THEN 'na' WHEN v_answer = q.pass_answer THEN 'pass' ELSE 'fail' END; v_value := NULL; v_choice := NULL;
  ELSIF q.answer_type = 'compliant' THEN
    IF v_answer IS NULL OR v_answer NOT IN ('compliant', 'non_compliant') THEN RAISE EXCEPTION 'Answer compliant or non-compliant' USING ERRCODE = 'QM018'; END IF;
    v_result := CASE WHEN v_answer = 'compliant' THEN 'pass' ELSE 'fail' END; v_value := NULL; v_choice := NULL;
  ELSIF q.answer_type = 'pass_fail' THEN
    IF v_answer IS NULL OR v_answer NOT IN ('pass', 'fail') THEN RAISE EXCEPTION 'Answer pass or fail' USING ERRCODE = 'QM018'; END IF;
    v_result := v_answer; v_value := NULL; v_choice := NULL;
  ELSIF q.answer_type IN ('numeric', 'measurement') THEN
    IF v_value IS NULL THEN RAISE EXCEPTION 'Enter a number' USING ERRCODE = 'QM018'; END IF;
    v_answer := NULL; v_choice := NULL;
    v_result := CASE WHEN q.lower_limit IS NULL AND q.upper_limit IS NULL THEN NULL
                     WHEN (q.lower_limit IS NULL OR v_value >= q.lower_limit) AND (q.upper_limit IS NULL OR v_value <= q.upper_limit) THEN 'pass' ELSE 'fail' END;
  ELSIF q.answer_type = 'multiple_choice' THEN
    IF v_choice IS NULL THEN RAISE EXCEPTION 'Choose one of the options' USING ERRCODE = 'QM018'; END IF;
    SELECT x INTO v_opt FROM jsonb_array_elements(q.options) x WHERE lower(x->>'label') = lower(v_choice);
    IF v_opt IS NULL THEN RAISE EXCEPTION 'That is not one of the options' USING ERRCODE = 'QM018'; END IF;
    v_choice := v_opt->>'label'; v_answer := NULL; v_value := NULL;
    v_result := CASE WHEN (v_opt->>'passes')::boolean THEN 'pass' ELSE 'fail' END;
  ELSIF q.answer_type = 'rating' THEN
    IF v_value IS NULL OR v_value <> trunc(v_value) OR v_value < 1 OR v_value > q.rating_max THEN
      RAISE EXCEPTION 'Choose a rating from 1 to %', q.rating_max USING ERRCODE = 'QM018';
    END IF;
    v_answer := NULL; v_choice := NULL;
    v_result := CASE WHEN q.pass_rating IS NULL THEN NULL WHEN v_value >= q.pass_rating THEN 'pass' ELSE 'fail' END;
  ELSE
    -- text, and evidence (where a note only describes the files, which are added separately)
    IF v_note IS NULL THEN RAISE EXCEPTION 'Write the note' USING ERRCODE = 'QM018'; END IF;
    v_answer := NULL; v_value := NULL; v_choice := NULL; v_result := NULL;
  END IF;
  INSERT INTO public.audit_responses (organisation_id, audit_record_id, record_question_id, answer, value_number, choice, note, result)
  VALUES (r.organisation_id, p_record, p_question, v_answer, v_value, v_choice, v_note, v_result)
  ON CONFLICT (record_question_id) DO UPDATE SET answer = EXCLUDED.answer, value_number = EXCLUDED.value_number, choice = EXCLUDED.choice, note = EXCLUDED.note, result = EXCLUDED.result;
END $$;

-- ---------------------------------------------------------------------------
-- What is still needed: every question that wants an answer answered, a file on every evidence question, a note on every failure, the "carried out on" chosen.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.audit_record_problems(p_id uuid) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  r public.audit_records%ROWTYPE;
  v_problems text[] := ARRAY[]::text[];
  v_unanswered integer[];
  v_nofile integer[];
  v_nonote integer[];
BEGIN
  SELECT * INTO r FROM public.audit_records WHERE id = p_id;
  IF NOT FOUND OR NOT app.has_permission(r.organisation_id, 'audits.read') THEN
    RETURN v_problems;
  END IF;
  SELECT coalesce(array_agg(q.sequence ORDER BY q.sequence), ARRAY[]::integer[]) INTO v_unanswered
    FROM public.audit_record_questions q
   WHERE q.audit_record_id = p_id AND q.answer_type NOT IN ('text', 'evidence') AND NOT EXISTS (SELECT 1 FROM public.audit_responses s WHERE s.record_question_id = q.id);
  IF cardinality(v_unanswered) > 0 THEN
    v_problems := array_append(v_problems, CASE WHEN cardinality(v_unanswered) = 1 THEN format('question %s is not answered', v_unanswered[1])
                                                ELSE format('%s questions are not answered (first: question %s)', cardinality(v_unanswered), v_unanswered[1]) END);
  END IF;
  SELECT coalesce(array_agg(q.sequence ORDER BY q.sequence), ARRAY[]::integer[]) INTO v_nofile
    FROM public.audit_record_questions q
   WHERE q.audit_record_id = p_id AND q.answer_type = 'evidence' AND NOT EXISTS (SELECT 1 FROM public.audit_attachments a WHERE a.record_question_id = q.id AND a.deleted_at IS NULL);
  IF cardinality(v_nofile) > 0 THEN
    v_problems := array_append(v_problems, format('add a photograph or document to question%s %s', CASE WHEN cardinality(v_nofile) = 1 THEN '' ELSE 's' END, array_to_string(v_nofile, ', ')));
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
-- Privileges
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app.audit_attachment_rules(), app.audit_attachment_no_delete() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.add_audit_attachment(uuid, uuid, text, text, text, bigint), app.remove_audit_attachment(uuid, text), app.restore_audit_attachment(uuid),
  app.audit_file_allowed(text, boolean), app.record_audit_response(uuid, uuid, text, numeric, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.add_audit_attachment(uuid, uuid, text, text, text, bigint), app.remove_audit_attachment(uuid, text), app.restore_audit_attachment(uuid),
  app.audit_file_allowed(text, boolean), app.record_audit_response(uuid, uuid, text, numeric, text, text) TO authenticated;
