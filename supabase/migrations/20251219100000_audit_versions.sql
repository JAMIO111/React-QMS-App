-- Audits: VERSIONED audit templates (docs/audits-versions-dashboard-plan.md, slice AV1).
--
--  * A version is an immutable, numbered snapshot of what a record freezes: title, type, purpose, procedure, pass mark, the checklist and the "relevant to" list.
--    Version 1 is made when the audit is created; every later change to any of that is a new version and NEEDS A REASON. Versions are never edited or deleted.
--  * The schedule (frequency, first due date, grace, weekdays only), the expected auditor and retiring are not part of a version (they stay in the audit trail).
--  * The database enforces it: a change made by a signed-in user that is not recorded as a new version (with its reason) is refused when the transaction ends.
--    Changes made outside the app (SQL, fixtures) are not blocked; starting the audit then records the difference as a version, so a record's version always matches
--    what it froze.
--  * A record stores the version it was started against (audit_version_id, audit_version).
--  * Existing audits get version 1 from their current content; an existing record is linked to it only when its frozen copy equals that content (nothing is guessed).
--  Errors QM018 → 409 audit_rule.

-- ---------------------------------------------------------------------------
-- The content of an audit as one comparable value
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.audit_question_json(
  p_sequence integer, p_question text, p_guidance text, p_answer_type text, p_pass_answer text, p_unit text, p_lower numeric, p_upper numeric,
  p_nominal numeric, p_options jsonb, p_rating_max integer, p_pass_rating integer, p_critical boolean
) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT jsonb_build_array(p_sequence, p_question, p_guidance, p_answer_type, p_pass_answer, p_unit, p_lower, p_upper, p_nominal, p_options, p_rating_max, p_pass_rating, p_critical)
$$;

-- A fingerprint of the live content of an audit (what a version snapshots). Equal fingerprints mean nothing that matters has changed.
CREATE FUNCTION app.audit_content_hash(p_definition uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT md5(jsonb_build_object(
    'h', jsonb_build_array(d.title, d.audit_type, d.purpose, d.procedure, d.pass_mark),
    'q', coalesce((SELECT jsonb_agg(app.audit_question_json(q.sequence, q.question, q.guidance, q.answer_type, q.pass_answer, q.unit, q.lower_limit, q.upper_limit,
                                                           q.nominal, q.options, q.rating_max, q.pass_rating, q.critical) ORDER BY q.sequence)
                     FROM public.audit_questions q WHERE q.audit_definition_id = d.id), '[]'::jsonb),
    't', coalesce((SELECT jsonb_agg(jsonb_build_array(t.kind, coalesce(t.machine_id::text, upper(t.operation_code), t.department_id::text))
                                    ORDER BY t.kind, coalesce(t.machine_id::text, upper(t.operation_code), t.department_id::text))
                     FROM public.audit_targets t WHERE t.audit_definition_id = d.id), '[]'::jsonb))::text)
    FROM public.audit_definitions d WHERE d.id = p_definition
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE public.audit_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  audit_definition_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  -- Why the audit changed. Version 1 says "First version".
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  content_hash text NOT NULL,
  title text NOT NULL,
  audit_type text NOT NULL,
  purpose text,
  procedure text,
  pass_mark integer NOT NULL CHECK (pass_mark BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT audit_versions_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT audit_versions_number_key UNIQUE (audit_definition_id, version),
  CONSTRAINT audit_versions_definition_fkey FOREIGN KEY (audit_definition_id, organisation_id) REFERENCES public.audit_definitions (id, organisation_id)
);
CREATE INDEX audit_versions_definition_idx ON public.audit_versions (audit_definition_id, version DESC);
CREATE INDEX audit_versions_org_idx ON public.audit_versions (organisation_id, created_at DESC);

CREATE TABLE public.audit_version_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  audit_version_id uuid NOT NULL,
  sequence integer NOT NULL,
  question text NOT NULL,
  guidance text,
  answer_type text NOT NULL,
  pass_answer text,
  unit text,
  lower_limit numeric,
  upper_limit numeric,
  nominal numeric,
  options jsonb,
  rating_max integer,
  pass_rating integer,
  critical boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT audit_version_questions_version_fkey FOREIGN KEY (audit_version_id, organisation_id) REFERENCES public.audit_versions (id, organisation_id),
  CONSTRAINT audit_version_questions_sequence_key UNIQUE (audit_version_id, sequence)
);

CREATE TABLE public.audit_version_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  audit_version_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('machine', 'operation', 'department')),
  machine_id uuid,
  operation_code text,
  department_id uuid,
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT audit_version_targets_version_fkey FOREIGN KEY (audit_version_id, organisation_id) REFERENCES public.audit_versions (id, organisation_id),
  CONSTRAINT audit_version_targets_machine_fkey FOREIGN KEY (machine_id, organisation_id) REFERENCES public.machines (id, organisation_id),
  CONSTRAINT audit_version_targets_department_fkey FOREIGN KEY (department_id, organisation_id) REFERENCES public.departments (id, organisation_id),
  CONSTRAINT audit_version_targets_shape CHECK (
    (kind = 'machine' AND machine_id IS NOT NULL AND operation_code IS NULL AND department_id IS NULL)
    OR (kind = 'operation' AND operation_code IS NOT NULL AND machine_id IS NULL AND department_id IS NULL)
    OR (kind = 'department' AND department_id IS NOT NULL AND machine_id IS NULL AND operation_code IS NULL))
);
CREATE INDEX audit_version_targets_version_idx ON public.audit_version_targets (audit_version_id);

CREATE TRIGGER audit_versions_stamp BEFORE INSERT ON public.audit_versions FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER audit_version_questions_stamp BEFORE INSERT ON public.audit_version_questions FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER audit_version_targets_stamp BEFORE INSERT ON public.audit_version_targets FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER audit_versions_touch BEFORE UPDATE ON public.audit_versions FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER audit_version_questions_touch BEFORE UPDATE ON public.audit_version_questions FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER audit_version_targets_touch BEFORE UPDATE ON public.audit_version_targets FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.audit_versions FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.audit_version_questions FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.audit_version_targets FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');

-- The version a record was started against.
ALTER TABLE public.audit_records
  ADD COLUMN audit_version_id uuid,
  ADD COLUMN audit_version integer,
  ADD CONSTRAINT audit_records_version_fkey FOREIGN KEY (audit_version_id, organisation_id) REFERENCES public.audit_versions (id, organisation_id),
  ADD CONSTRAINT audit_records_version_pair CHECK ((audit_version_id IS NULL) = (audit_version IS NULL));
CREATE INDEX audit_records_version_idx ON public.audit_records (audit_version_id) WHERE audit_version_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Making a version
-- ---------------------------------------------------------------------------
-- The snapshot itself: no permission checks (callers are the functions below). Copies the live content.
CREATE FUNCTION app.snapshot_audit_version(p_definition uuid, p_version integer, p_reason text) RETURNS uuid
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
  INSERT INTO public.audit_version_targets (organisation_id, audit_version_id, kind, machine_id, operation_code, department_id, label)
  SELECT t.organisation_id, v_id, t.kind, t.machine_id, t.operation_code, t.department_id,
         CASE t.kind WHEN 'machine' THEN m.code || ' · ' || m.name WHEN 'operation' THEN t.operation_code ELSE dp.code || ' · ' || dp.name END
    FROM public.audit_targets t LEFT JOIN public.machines m ON m.id = t.machine_id LEFT JOIN public.departments dp ON dp.id = t.department_id
   WHERE t.audit_definition_id = d.id;
  RETURN v_id;
END $$;

-- True when the live content differs from the latest version (or there is none yet): the change still has to be saved as a version.
CREATE FUNCTION app.audit_content_changed(p_definition uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE d public.audit_definitions%ROWTYPE; v_latest text;
BEGIN
  SELECT * INTO d FROM public.audit_definitions WHERE id = p_definition;
  IF NOT FOUND OR NOT app.has_permission(d.organisation_id, 'audits.read') THEN
    RAISE EXCEPTION 'Audit not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT v.content_hash INTO v_latest FROM public.audit_versions v WHERE v.audit_definition_id = p_definition ORDER BY v.version DESC LIMIT 1;
  RETURN v_latest IS NULL OR v_latest <> app.audit_content_hash(p_definition);
END $$;

-- Save the live content as the next version. The first version needs no reason; every later one does, and a change that alters nothing is refused.
CREATE FUNCTION app.save_audit_version(p_definition uuid, p_reason text DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  d public.audit_definitions%ROWTYPE;
  v_latest public.audit_versions%ROWTYPE;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_n integer;
BEGIN
  d := app.audit_definition_for_manage(p_definition);
  PERFORM 1 FROM public.audit_definitions WHERE id = p_definition FOR UPDATE; -- one version at a time
  SELECT * INTO v_latest FROM public.audit_versions WHERE audit_definition_id = p_definition ORDER BY version DESC LIMIT 1;
  IF NOT FOUND THEN
    v_n := 1;
    v_reason := coalesce(v_reason, 'First version');
  ELSE
    IF v_latest.content_hash = app.audit_content_hash(p_definition) THEN
      RAISE EXCEPTION 'Nothing has changed since version %', v_latest.version USING ERRCODE = 'QM018';
    END IF;
    IF v_reason IS NULL THEN
      RAISE EXCEPTION 'Give a reason for the change to the audit' USING ERRCODE = 'QM018';
    END IF;
    v_n := v_latest.version + 1;
  END IF;
  IF length(v_reason) > 1000 THEN
    RAISE EXCEPTION 'The reason can be at most 1000 characters' USING ERRCODE = 'QM018';
  END IF;
  PERFORM app.snapshot_audit_version(p_definition, v_n, v_reason);
  PERFORM app.emit_event(d.organisation_id, 'audit.version_saved', 'audit_definition', d.id,
    jsonb_build_object('audit', d.reference, 'version', v_n, 'reason', v_reason));
  RETURN v_n;
END $$;

-- Used when an audit is started: the version to record. Makes version 1, or a version for a change made outside the app, so the record can say exactly what it froze.
CREATE FUNCTION app.ensure_audit_version(p_definition uuid) RETURNS public.audit_versions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_latest public.audit_versions%ROWTYPE;
  v public.audit_versions%ROWTYPE;
BEGIN
  PERFORM 1 FROM public.audit_definitions WHERE id = p_definition FOR UPDATE;
  SELECT * INTO v_latest FROM public.audit_versions WHERE audit_definition_id = p_definition ORDER BY version DESC LIMIT 1;
  IF NOT FOUND THEN
    PERFORM app.snapshot_audit_version(p_definition, 1, 'First version');
  ELSIF v_latest.content_hash <> app.audit_content_hash(p_definition) THEN
    PERFORM app.snapshot_audit_version(p_definition, v_latest.version + 1, 'Changed outside the app; recorded when the audit was started');
  END IF;
  SELECT * INTO v FROM public.audit_versions WHERE audit_definition_id = p_definition ORDER BY version DESC LIMIT 1;
  RETURN v;
END $$;

-- ---------------------------------------------------------------------------
-- Enforcement: a signed-in user's change to the content must end the transaction with a matching version.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.audit_version_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_def uuid;
  v_latest text;
BEGIN
  IF coalesce(auth.role(), '') <> 'authenticated' THEN
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'audit_definitions' THEN
    v_def := coalesce(NEW.id, OLD.id);
  ELSIF TG_OP = 'DELETE' THEN
    v_def := OLD.audit_definition_id;
  ELSE
    v_def := NEW.audit_definition_id;
  END IF;
  SELECT v.content_hash INTO v_latest FROM public.audit_versions v WHERE v.audit_definition_id = v_def ORDER BY v.version DESC LIMIT 1;
  IF v_latest IS NULL OR v_latest <> app.audit_content_hash(v_def) THEN
    RAISE EXCEPTION 'A change to an audit is saved as a new version, with a reason' USING ERRCODE = 'QM018';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER audit_definitions_versioned_ins AFTER INSERT ON public.audit_definitions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION app.audit_version_guard();
CREATE CONSTRAINT TRIGGER audit_definitions_versioned_upd AFTER UPDATE ON public.audit_definitions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN ((OLD.title, OLD.audit_type, OLD.purpose, OLD.procedure, OLD.pass_mark) IS DISTINCT FROM (NEW.title, NEW.audit_type, NEW.purpose, NEW.procedure, NEW.pass_mark))
  EXECUTE FUNCTION app.audit_version_guard();
CREATE CONSTRAINT TRIGGER audit_questions_versioned AFTER INSERT OR UPDATE OR DELETE ON public.audit_questions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION app.audit_version_guard();
CREATE CONSTRAINT TRIGGER audit_targets_versioned AFTER INSERT OR UPDATE OR DELETE ON public.audit_targets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION app.audit_version_guard();

-- ---------------------------------------------------------------------------
-- A record remembers its version
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.start_audit(p_definition uuid, p_occurrence uuid DEFAULT NULL, p_targets jsonb DEFAULT '[]'::jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  d public.audit_definitions%ROWTYPE;
  o public.audit_occurrences%ROWTYPE;
  ver public.audit_versions%ROWTYPE;
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

  ver := app.ensure_audit_version(p_definition);
  INSERT INTO app.audit_record_counters AS c (organisation_id, year, last_value) VALUES (d.organisation_id, v_year, 1)
  ON CONFLICT (organisation_id, year) DO UPDATE SET last_value = c.last_value + 1 RETURNING last_value INTO v_n;
  INSERT INTO public.audit_records (organisation_id, reference, audit_definition_id, occurrence_id, audit_reference, audit_title, audit_type, procedure, pass_mark, audit_version_id, audit_version)
  VALUES (d.organisation_id, 'AR-' || to_char(make_date(v_year, 1, 1), 'YY') || '-' || lpad(v_n::text, 4, '0'), p_definition, p_occurrence, d.reference, d.title, d.audit_type, d.procedure, d.pass_mark, ver.id, ver.version)
  RETURNING id INTO v_id;
  INSERT INTO public.audit_record_questions (organisation_id, audit_record_id, sequence, question, guidance, answer_type, pass_answer, unit, lower_limit, upper_limit, nominal, options, rating_max, pass_rating, critical)
  SELECT q.organisation_id, v_id, q.sequence, q.question, q.guidance, q.answer_type, q.pass_answer, q.unit, q.lower_limit, q.upper_limit, q.nominal, q.options, q.rating_max, q.pass_rating, q.critical
    FROM public.audit_questions q WHERE q.audit_definition_id = p_definition ORDER BY q.sequence;
  IF p_targets IS NOT NULL AND jsonb_typeof(p_targets) = 'array' AND jsonb_array_length(p_targets) > 0 THEN
    PERFORM app.set_audit_record_targets(v_id, p_targets);
  END IF;
  PERFORM app.emit_event(d.organisation_id, 'audit.started', 'audit_record', v_id, jsonb_build_object('audit', d.reference, 'occurrence', p_occurrence, 'version', ver.version));
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------
-- Existing audits: version 1 from the current content; a record is linked to it only when what it froze is the same
-- ---------------------------------------------------------------------------
DO $$
DECLARE d record; v_id uuid;
BEGIN
  FOR d IN SELECT id FROM public.audit_definitions ORDER BY created_at LOOP
    v_id := app.snapshot_audit_version(d.id, 1, 'Existing audit, before versions were kept');
    UPDATE public.audit_records r SET audit_version_id = v_id, audit_version = 1
     WHERE r.audit_definition_id = d.id
       AND EXISTS (SELECT 1 FROM public.audit_versions v WHERE v.id = v_id AND v.title = r.audit_title AND v.audit_type = r.audit_type
                      AND v.procedure IS NOT DISTINCT FROM r.procedure AND v.pass_mark = r.pass_mark)
       AND coalesce((SELECT jsonb_agg(app.audit_question_json(x.sequence, x.question, x.guidance, x.answer_type, x.pass_answer, x.unit, x.lower_limit, x.upper_limit,
                                                              x.nominal, x.options, x.rating_max, x.pass_rating, x.critical) ORDER BY x.sequence)
                       FROM public.audit_record_questions x WHERE x.audit_record_id = r.id), '[]'::jsonb)
         = coalesce((SELECT jsonb_agg(app.audit_question_json(x.sequence, x.question, x.guidance, x.answer_type, x.pass_answer, x.unit, x.lower_limit, x.upper_limit,
                                                              x.nominal, x.options, x.rating_max, x.pass_rating, x.critical) ORDER BY x.sequence)
                       FROM public.audit_version_questions x WHERE x.audit_version_id = v_id), '[]'::jsonb);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Row level security and privileges: readable with audits.read, written only by the functions above
-- ---------------------------------------------------------------------------
ALTER TABLE public.audit_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_version_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_version_targets ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_versions_select ON public.audit_versions FOR SELECT TO authenticated USING (app.has_permission(organisation_id, 'audits.read'));
CREATE POLICY audit_version_questions_select ON public.audit_version_questions FOR SELECT TO authenticated USING (app.has_permission(organisation_id, 'audits.read'));
CREATE POLICY audit_version_targets_select ON public.audit_version_targets FOR SELECT TO authenticated USING (app.has_permission(organisation_id, 'audits.read'));
REVOKE ALL ON public.audit_versions, public.audit_version_questions, public.audit_version_targets FROM anon, authenticated;
GRANT SELECT ON public.audit_versions, public.audit_version_questions, public.audit_version_targets TO authenticated;

REVOKE ALL ON FUNCTION app.audit_question_json(integer, text, text, text, text, text, numeric, numeric, numeric, jsonb, integer, integer, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.audit_content_hash(uuid), app.snapshot_audit_version(uuid, integer, text), app.ensure_audit_version(uuid), app.audit_version_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.audit_content_changed(uuid), app.save_audit_version(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.audit_content_changed(uuid), app.save_audit_version(uuid, text) TO authenticated;
