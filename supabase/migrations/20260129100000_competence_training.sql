-- Competence slice CO3 (docs/competence-plan.md CP12, CP14, CP16): training sessions with an attendee list, each attendee completed on their own day, and evidence files.
--
--  * competence_training_sessions (`TS-YY-NNNN` per organisation and year): one session = what, who ran it, which skills it supports. `provider_type` internal names a trainer
--    from the Employees register, external names the outside provider as text (exactly one of the two). Status open -> closed | cancelled (reason); a closed session can be
--    reopened with a reason. Content is editable only while open.
--  * competence_session_skills: the skills a session supports (information; training is evidence, it does not make anyone competent and creates no assessment).
--  * competence_session_attendees: one row per person per session; enrolled -> completed | failed | absent (each with the person's OWN date for completed / failed), or removed
--    (reason). A completed / failed / absent attendee is frozen and is corrected by voiding it (reason) and, while the session is open, adding the person again. Unique per
--    session and employee while live. `completed_on` is not in the future (the caller's day) and not before the session started.
--  * competence_attachments: evidence files on a session (shared) or on one attendee (their certificate). Functions only; removed with a reason, never deleted; private
--    `competence-files` bucket at `<org>/competence/session/<session id>/...` and `<org>/competence/attendee/<attendee id>/...`.
-- No table writes at all: SECURITY DEFINER functions only, all needing competence.assess. Errors QM024 (409 competence_rule); another organisation's id P0002 (404).
-- Reading: competence.read (Controller-seat holders too), or being a live attendee yourself (your own row, and the session you are on).

-- ---------------------------------------------------------------------------
-- Numbering: TS-YY-NNNN per organisation and year
-- ---------------------------------------------------------------------------
CREATE TABLE app.competence_session_counters (
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  year integer NOT NULL,
  last_value integer NOT NULL DEFAULT 0,
  PRIMARY KEY (organisation_id, year)
);
REVOKE ALL ON app.competence_session_counters FROM PUBLIC, anon, authenticated;
CREATE FUNCTION app.next_training_session_reference(p_organisation_id uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_year integer := extract(year FROM current_date)::integer; v_n integer;
BEGIN
  INSERT INTO app.competence_session_counters AS c (organisation_id, year, last_value) VALUES (p_organisation_id, v_year, 1)
  ON CONFLICT (organisation_id, year) DO UPDATE SET last_value = c.last_value + 1 RETURNING last_value INTO v_n;
  RETURN 'TS-' || lpad((v_year % 100)::text, 2, '0') || '-' || lpad(v_n::text, 4, '0');
END $$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE public.competence_training_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  reference text NOT NULL,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK (kind IN ('course', 'on_the_job', 'external', 'induction', 'other')),
  provider_type text NOT NULL CHECK (provider_type IN ('internal', 'external')),
  trainer_employee_id uuid,
  provider_name text CHECK (provider_name IS NULL OR length(btrim(provider_name)) BETWEEN 1 AND 200),
  provider_contact text CHECK (provider_contact IS NULL OR length(btrim(provider_contact)) BETWEEN 1 AND 300),
  starts_on date NOT NULL,
  ends_on date,
  hours numeric(6, 2) CHECK (hours IS NULL OR (hours > 0 AND hours <= 1000)),
  location text CHECK (location IS NULL OR length(btrim(location)) BETWEEN 1 AND 200),
  notes text CHECK (notes IS NULL OR length(btrim(notes)) BETWEEN 1 AND 2000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'cancelled')),
  cancel_reason text,
  closed_at timestamptz,
  closed_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  reopen_reason text,
  reopened_at timestamptz,
  reopened_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT competence_training_sessions_reference_key UNIQUE (organisation_id, reference),
  CONSTRAINT competence_training_sessions_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT competence_training_sessions_trainer_fkey FOREIGN KEY (trainer_employee_id, organisation_id) REFERENCES public."Employees" (id, organisation_id),
  CONSTRAINT competence_training_sessions_dates_check CHECK (ends_on IS NULL OR ends_on >= starts_on),
  CONSTRAINT competence_training_sessions_provider_check CHECK (
    (provider_type = 'internal' AND trainer_employee_id IS NOT NULL AND provider_name IS NULL AND provider_contact IS NULL)
    OR (provider_type = 'external' AND trainer_employee_id IS NULL AND provider_name IS NOT NULL)),
  CONSTRAINT competence_training_sessions_cancel_check CHECK ((status = 'cancelled') = (cancel_reason IS NOT NULL))
);
CREATE INDEX competence_training_sessions_org_idx ON public.competence_training_sessions (organisation_id, starts_on DESC);

CREATE TABLE public.competence_session_skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  session_id uuid NOT NULL,
  skill_id uuid NOT NULL,
  CONSTRAINT competence_session_skills_pair_key UNIQUE (session_id, skill_id),
  CONSTRAINT competence_session_skills_session_fkey FOREIGN KEY (session_id, organisation_id) REFERENCES public.competence_training_sessions (id, organisation_id) ON DELETE CASCADE,
  CONSTRAINT competence_session_skills_skill_fkey FOREIGN KEY (skill_id, organisation_id) REFERENCES public.competence_skills (id, organisation_id)
);
CREATE INDEX competence_session_skills_skill_idx ON public.competence_session_skills (skill_id);

CREATE TABLE public.competence_session_attendees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  session_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'enrolled' CHECK (status IN ('enrolled', 'completed', 'failed', 'absent', 'removed', 'voided')),
  completed_on date,
  note text CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 1000),
  reason text CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 3 AND 500),
  recorded_at timestamptz,
  recorded_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT competence_session_attendees_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT competence_session_attendees_session_fkey FOREIGN KEY (session_id, organisation_id) REFERENCES public.competence_training_sessions (id, organisation_id),
  CONSTRAINT competence_session_attendees_employee_fkey FOREIGN KEY (employee_id, organisation_id) REFERENCES public."Employees" (id, organisation_id),
  -- completed / failed carry the person's own date; a voided row keeps whatever it had (history); the rest have none.
  CONSTRAINT competence_session_attendees_date_check CHECK (
    (status IN ('completed', 'failed') AND completed_on IS NOT NULL) OR status = 'voided' OR (status IN ('enrolled', 'absent', 'removed') AND completed_on IS NULL)),
  CONSTRAINT competence_session_attendees_reason_state_check CHECK ((status IN ('removed', 'voided')) = (reason IS NOT NULL))
);
CREATE UNIQUE INDEX competence_session_attendees_live_key ON public.competence_session_attendees (session_id, employee_id) WHERE status NOT IN ('removed', 'voided');
CREATE INDEX competence_session_attendees_employee_idx ON public.competence_session_attendees (organisation_id, employee_id);

CREATE TABLE public.competence_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  session_id uuid,
  attendee_id uuid,
  storage_path text NOT NULL,
  file_name text NOT NULL CHECK (length(btrim(file_name)) BETWEEN 1 AND 255),
  content_type text,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 26214400),
  description text CHECK (description IS NULL OR length(description) <= 500),
  deleted_at timestamptz,
  deleted_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  delete_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT competence_attachments_owner_check CHECK ((session_id IS NOT NULL) <> (attendee_id IS NOT NULL)),
  CONSTRAINT competence_attachments_session_fkey FOREIGN KEY (session_id, organisation_id) REFERENCES public.competence_training_sessions (id, organisation_id),
  CONSTRAINT competence_attachments_attendee_fkey FOREIGN KEY (attendee_id, organisation_id) REFERENCES public.competence_session_attendees (id, organisation_id),
  CONSTRAINT competence_attachments_path_key UNIQUE (storage_path),
  CONSTRAINT competence_attachments_path CHECK (storage_path LIKE organisation_id::text || '/competence/%/%' AND storage_path NOT LIKE '%..%')
);
CREATE INDEX competence_attachments_session_idx ON public.competence_attachments (session_id) WHERE session_id IS NOT NULL;
CREATE INDEX competence_attachments_attendee_idx ON public.competence_attachments (attendee_id) WHERE attendee_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Rules held by triggers (so SQL run by the operator is held to them too)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.competence_session_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A training session is never deleted. Cancel it with a reason.' USING ERRCODE = 'QM024'; END IF;
  IF NEW.reference <> OLD.reference OR NEW.organisation_id <> OLD.organisation_id THEN
    RAISE EXCEPTION 'A session''s reference never changes' USING ERRCODE = 'QM024';
  END IF;
  IF OLD.status = 'cancelled' THEN RAISE EXCEPTION 'A cancelled session cannot be changed' USING ERRCODE = 'QM024'; END IF;
  IF OLD.status = 'closed' AND NEW.status = 'closed' THEN RAISE EXCEPTION 'A closed session cannot be changed. Reopen it first.' USING ERRCODE = 'QM024'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER competence_training_sessions_rules BEFORE UPDATE OR DELETE ON public.competence_training_sessions FOR EACH ROW EXECUTE FUNCTION app.competence_session_rules();
CREATE TRIGGER competence_training_sessions_stamp BEFORE INSERT ON public.competence_training_sessions FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER competence_training_sessions_touch BEFORE UPDATE ON public.competence_training_sessions FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER competence_training_sessions_org_immutable BEFORE UPDATE ON public.competence_training_sessions FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();

CREATE FUNCTION app.competence_attendee_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'An attendee is never deleted. Remove or void them with a reason.' USING ERRCODE = 'QM024'; END IF;
  IF (NEW.session_id, NEW.employee_id, NEW.organisation_id) IS DISTINCT FROM (OLD.session_id, OLD.employee_id, OLD.organisation_id) THEN
    RAISE EXCEPTION 'An attendee''s session and person never change' USING ERRCODE = 'QM024';
  END IF;
  IF NOT ((OLD.status = 'enrolled' AND NEW.status IN ('completed', 'failed', 'absent', 'removed'))
       OR (OLD.status IN ('completed', 'failed', 'absent') AND NEW.status = 'voided')) THEN
    RAISE EXCEPTION 'An attendee cannot move from % to %', OLD.status, NEW.status USING ERRCODE = 'QM024';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER competence_session_attendees_rules BEFORE UPDATE OR DELETE ON public.competence_session_attendees FOR EACH ROW EXECUTE FUNCTION app.competence_attendee_rules();
CREATE TRIGGER competence_session_attendees_stamp BEFORE INSERT ON public.competence_session_attendees FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER competence_session_attendees_touch BEFORE UPDATE ON public.competence_session_attendees FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER competence_session_attendees_org_immutable BEFORE UPDATE ON public.competence_session_attendees FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();

CREATE FUNCTION app.competence_attachment_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Files are never deleted' USING ERRCODE = 'QM024'; END IF;
  IF (to_jsonb(NEW) - ARRAY['deleted_at', 'deleted_by', 'delete_reason', 'updated_at', 'updated_by'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['deleted_at', 'deleted_by', 'delete_reason', 'updated_at', 'updated_by']) THEN
    RAISE EXCEPTION 'A file cannot be changed, only removed or restored' USING ERRCODE = 'QM024';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER competence_attachments_rules BEFORE UPDATE OR DELETE ON public.competence_attachments FOR EACH ROW EXECUTE FUNCTION app.competence_attachment_rules();
CREATE TRIGGER competence_attachments_stamp BEFORE INSERT ON public.competence_attachments FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER competence_attachments_touch BEFORE UPDATE ON public.competence_attachments FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER competence_attachments_org_immutable BEFORE UPDATE ON public.competence_attachments FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();

CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.competence_training_sessions FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.competence_session_skills FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.competence_session_attendees FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.competence_attachments FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');

-- ---------------------------------------------------------------------------
-- Reading: competence.read, or being a live attendee yourself
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.competence_on_session(p_session uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.competence_session_attendees a JOIN public."Employees" e ON e.id = a.employee_id AND e.organisation_id = a.organisation_id
                  WHERE a.session_id = p_session AND a.status NOT IN ('removed', 'voided') AND e.auth_id = auth.uid() AND app.is_member(a.organisation_id))
$$;
REVOKE ALL ON FUNCTION app.competence_on_session(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.competence_on_session(uuid) TO authenticated;

ALTER TABLE public.competence_training_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.competence_session_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.competence_session_attendees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.competence_attachments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.competence_training_sessions, public.competence_session_skills, public.competence_session_attendees, public.competence_attachments FROM anon, authenticated;
GRANT SELECT ON public.competence_training_sessions, public.competence_session_skills, public.competence_session_attendees, public.competence_attachments TO authenticated;
CREATE POLICY competence_training_sessions_select ON public.competence_training_sessions FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'competence.read') OR app.competence_on_session(id));
CREATE POLICY competence_session_skills_select ON public.competence_session_skills FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'competence.read') OR app.competence_on_session(session_id));
CREATE POLICY competence_session_attendees_select ON public.competence_session_attendees FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'competence.read') OR app.competence_is_me(employee_id));
CREATE POLICY competence_attachments_select ON public.competence_attachments FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'competence.read')
         OR (session_id IS NOT NULL AND app.competence_on_session(session_id))
         OR (attendee_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.competence_session_attendees a WHERE a.id = attendee_id AND app.competence_is_me(a.employee_id))));

-- ---------------------------------------------------------------------------
-- Functions (all need competence.assess)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.assert_competence_assessor(p_organisation_id uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT app.is_member(p_organisation_id) THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(p_organisation_id, 'competence.assess') THEN RAISE EXCEPTION 'You are not allowed to record training' USING ERRCODE = '42501'; END IF;
END $$;

-- Loads and locks a session for a change by an assessor; `p_status` says which status it must be in (null = any but cancelled).
CREATE FUNCTION app.training_session_for_update(p_id uuid, p_status text DEFAULT 'open') RETURNS public.competence_training_sessions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.competence_training_sessions%ROWTYPE;
BEGIN
  SELECT * INTO s FROM public.competence_training_sessions WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(s.organisation_id) THEN RAISE EXCEPTION 'Training session not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_competence_assessor(s.organisation_id);
  IF p_status IS NULL THEN
    IF s.status = 'cancelled' THEN RAISE EXCEPTION '% is cancelled', s.reference USING ERRCODE = 'QM024'; END IF;
  ELSIF s.status <> p_status THEN
    RAISE EXCEPTION '% is % and cannot be changed that way', s.reference, s.status USING ERRCODE = 'QM024';
  END IF;
  RETURN s;
END $$;

-- Checks and sets the session's content from jsonb (keys present are set; null clears the optional ones). Used by create and update.
CREATE FUNCTION app.training_session_values(p_data jsonb, p_organisation_id uuid, p_current public.competence_training_sessions) RETURNS public.competence_training_sessions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.competence_training_sessions := p_current; k text; v_trainer uuid;
BEGIN
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Send the session as an object' USING ERRCODE = 'QM024'; END IF;
  FOR k IN SELECT jsonb_object_keys(p_data) LOOP
    IF k NOT IN ('title', 'kind', 'providerType', 'trainerEmployeeId', 'providerName', 'providerContact', 'startsOn', 'endsOn', 'hours', 'location', 'notes', 'skillIds') THEN
      RAISE EXCEPTION 'Unknown field %', k USING ERRCODE = 'QM024';
    END IF;
  END LOOP;
  IF p_data ? 'title' THEN s.title := btrim(coalesce(p_data ->> 'title', '')); END IF;
  IF p_data ? 'kind' THEN s.kind := p_data ->> 'kind'; END IF;
  IF p_data ? 'providerType' THEN s.provider_type := p_data ->> 'providerType'; END IF;
  IF p_data ? 'trainerEmployeeId' THEN s.trainer_employee_id := nullif(p_data ->> 'trainerEmployeeId', '')::uuid; END IF;
  IF p_data ? 'providerName' THEN s.provider_name := nullif(btrim(coalesce(p_data ->> 'providerName', '')), ''); END IF;
  IF p_data ? 'providerContact' THEN s.provider_contact := nullif(btrim(coalesce(p_data ->> 'providerContact', '')), ''); END IF;
  IF p_data ? 'startsOn' THEN s.starts_on := (p_data ->> 'startsOn')::date; END IF;
  IF p_data ? 'endsOn' THEN s.ends_on := (p_data ->> 'endsOn')::date; END IF;
  IF p_data ? 'hours' THEN s.hours := (p_data ->> 'hours')::numeric; END IF;
  IF p_data ? 'location' THEN s.location := nullif(btrim(coalesce(p_data ->> 'location', '')), ''); END IF;
  IF p_data ? 'notes' THEN s.notes := nullif(btrim(coalesce(p_data ->> 'notes', '')), ''); END IF;
  -- Who runs it follows the provider type: the other side is cleared.
  IF s.provider_type = 'internal' THEN s.provider_name := NULL; s.provider_contact := NULL;
  ELSIF s.provider_type = 'external' THEN s.trainer_employee_id := NULL; END IF;
  IF s.title IS NULL OR length(s.title) = 0 THEN RAISE EXCEPTION 'Give the session a title' USING ERRCODE = 'QM024'; END IF;
  IF s.kind IS NULL OR s.kind NOT IN ('course', 'on_the_job', 'external', 'induction', 'other') THEN RAISE EXCEPTION 'Choose what kind of session it is' USING ERRCODE = 'QM024'; END IF;
  IF s.provider_type IS NULL OR s.provider_type NOT IN ('internal', 'external') THEN RAISE EXCEPTION 'Say whether the session is run internally or externally' USING ERRCODE = 'QM024'; END IF;
  IF s.provider_type = 'internal' THEN
    IF s.trainer_employee_id IS NULL THEN RAISE EXCEPTION 'Choose who runs it (the trainer)' USING ERRCODE = 'QM024'; END IF;
    SELECT id INTO v_trainer FROM public."Employees" WHERE id = s.trainer_employee_id AND organisation_id = p_organisation_id AND active;
    IF v_trainer IS NULL THEN RAISE EXCEPTION 'The trainer must be an active employee of this organisation' USING ERRCODE = 'QM024'; END IF;
  ELSIF s.provider_name IS NULL THEN
    RAISE EXCEPTION 'Name the outside provider or trainer' USING ERRCODE = 'QM024';
  END IF;
  IF s.starts_on IS NULL THEN RAISE EXCEPTION 'Say when the session starts' USING ERRCODE = 'QM024'; END IF;
  IF s.ends_on IS NOT NULL AND s.ends_on < s.starts_on THEN RAISE EXCEPTION 'It cannot end before it starts' USING ERRCODE = 'QM024'; END IF;
  IF s.hours IS NOT NULL AND (s.hours <= 0 OR s.hours > 1000) THEN RAISE EXCEPTION 'Hours must be more than 0 and at most 1000' USING ERRCODE = 'QM024'; END IF;
  RETURN s;
END $$;

-- Replaces the skills a session supports as a whole (only active skills of the organisation).
CREATE FUNCTION app.training_session_set_skills(p_session uuid, p_organisation_id uuid, p_skills uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_ids uuid[] := ARRAY(SELECT DISTINCT unnest(coalesce(p_skills, ARRAY[]::uuid[])));
BEGIN
  IF cardinality(v_ids) > 0 AND (SELECT count(*) FROM public.competence_skills WHERE id = ANY (v_ids) AND organisation_id = p_organisation_id AND active) <> cardinality(v_ids) THEN
    RAISE EXCEPTION 'Every skill must be an active skill of this organisation' USING ERRCODE = 'QM024';
  END IF;
  DELETE FROM public.competence_session_skills WHERE session_id = p_session;
  INSERT INTO public.competence_session_skills (organisation_id, session_id, skill_id) SELECT p_organisation_id, p_session, unnest(v_ids);
END $$;

CREATE FUNCTION app.create_training_session(p_organisation_id uuid, p_data jsonb, p_employees uuid[] DEFAULT ARRAY[]::uuid[]) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.competence_training_sessions; v_id uuid; v_emps uuid[] := ARRAY(SELECT DISTINCT unnest(coalesce(p_employees, ARRAY[]::uuid[])));
  v_skills uuid[] := ARRAY[]::uuid[];
BEGIN
  PERFORM app.assert_competence_assessor(p_organisation_id);
  s.organisation_id := p_organisation_id;
  s := app.training_session_values(p_data, p_organisation_id, s);
  IF p_data ? 'skillIds' THEN v_skills := ARRAY(SELECT jsonb_array_elements_text(p_data -> 'skillIds')::uuid); END IF;
  IF cardinality(v_emps) > 0 AND (SELECT count(*) FROM public."Employees" WHERE id = ANY (v_emps) AND organisation_id = p_organisation_id AND active) <> cardinality(v_emps) THEN
    RAISE EXCEPTION 'Every attendee must be an active employee of this organisation' USING ERRCODE = 'QM024';
  END IF;
  INSERT INTO public.competence_training_sessions (organisation_id, reference, title, kind, provider_type, trainer_employee_id, provider_name, provider_contact, starts_on, ends_on, hours, location, notes)
  VALUES (p_organisation_id, app.next_training_session_reference(p_organisation_id), s.title, s.kind, s.provider_type, s.trainer_employee_id, s.provider_name, s.provider_contact, s.starts_on, s.ends_on, s.hours, s.location, s.notes)
  RETURNING id INTO v_id;
  PERFORM app.training_session_set_skills(v_id, p_organisation_id, v_skills);
  INSERT INTO public.competence_session_attendees (organisation_id, session_id, employee_id) SELECT p_organisation_id, v_id, unnest(v_emps);
  RETURN v_id;
END $$;

CREATE FUNCTION app.update_training_session(p_id uuid, p_data jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE cur public.competence_training_sessions; s public.competence_training_sessions; v_early date;
BEGIN
  cur := app.training_session_for_update(p_id, 'open');
  s := app.training_session_values(p_data, cur.organisation_id, cur);
  SELECT min(completed_on) INTO v_early FROM public.competence_session_attendees WHERE session_id = cur.id AND status IN ('completed', 'failed');
  IF v_early IS NOT NULL AND s.starts_on > v_early THEN
    RAISE EXCEPTION 'It cannot start after %, when someone completed it', v_early USING ERRCODE = 'QM024';
  END IF;
  UPDATE public.competence_training_sessions SET title = s.title, kind = s.kind, provider_type = s.provider_type, trainer_employee_id = s.trainer_employee_id,
    provider_name = s.provider_name, provider_contact = s.provider_contact, starts_on = s.starts_on, ends_on = s.ends_on, hours = s.hours, location = s.location, notes = s.notes
   WHERE id = cur.id;
  IF p_data ? 'skillIds' THEN PERFORM app.training_session_set_skills(cur.id, cur.organisation_id, ARRAY(SELECT jsonb_array_elements_text(p_data -> 'skillIds')::uuid)); END IF;
END $$;

CREATE FUNCTION app.add_session_attendee(p_session uuid, p_employee uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.competence_training_sessions; e public."Employees"%ROWTYPE; v_id uuid;
BEGIN
  s := app.training_session_for_update(p_session, 'open');
  SELECT * INTO e FROM public."Employees" WHERE id = p_employee AND organisation_id = s.organisation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Employee not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT e.active THEN RAISE EXCEPTION 'That employee is not active' USING ERRCODE = 'QM024'; END IF;
  IF EXISTS (SELECT 1 FROM public.competence_session_attendees WHERE session_id = s.id AND employee_id = e.id AND status NOT IN ('removed', 'voided')) THEN
    RAISE EXCEPTION '% is already on this session', coalesce(e.first_name || ' ' || e.surname, 'That person') USING ERRCODE = 'QM024';
  END IF;
  INSERT INTO public.competence_session_attendees (organisation_id, session_id, employee_id) VALUES (s.organisation_id, s.id, e.id) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION app.remove_session_attendee(p_attendee uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.competence_session_attendees%ROWTYPE; v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  SELECT * INTO a FROM public.competence_session_attendees WHERE id = p_attendee;
  IF NOT FOUND OR NOT app.is_member(a.organisation_id) THEN RAISE EXCEPTION 'Attendee not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.training_session_for_update(a.session_id, 'open');
  IF a.status <> 'enrolled' THEN RAISE EXCEPTION 'Only someone still enrolled can be removed. Void a recorded result instead.' USING ERRCODE = 'QM024'; END IF;
  IF length(v_reason) < 3 THEN RAISE EXCEPTION 'Say why they are removed (at least 3 characters)' USING ERRCODE = 'QM024'; END IF;
  UPDATE public.competence_session_attendees SET status = 'removed', reason = left(v_reason, 500), recorded_at = now(), recorded_by = auth.uid() WHERE id = a.id;
END $$;

-- Records the same result for several attendees on one day: completed | failed | absent. Call again on another day for others.
CREATE FUNCTION app.record_session_attendees(p_session uuid, p_attendees uuid[], p_outcome text, p_on date DEFAULT NULL, p_note text DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.competence_training_sessions; v_ids uuid[] := ARRAY(SELECT DISTINCT unnest(coalesce(p_attendees, ARRAY[]::uuid[])));
  v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_n integer;
BEGIN
  s := app.training_session_for_update(p_session, 'open');
  IF p_outcome IS NULL OR p_outcome NOT IN ('completed', 'failed', 'absent') THEN RAISE EXCEPTION 'The outcome is completed, failed or absent' USING ERRCODE = 'QM024'; END IF;
  IF cardinality(v_ids) = 0 THEN RAISE EXCEPTION 'Choose at least one person' USING ERRCODE = 'QM024'; END IF;
  IF p_outcome IN ('completed', 'failed') THEN
    IF p_on IS NULL THEN RAISE EXCEPTION 'Say which day they completed it' USING ERRCODE = 'QM024'; END IF;
    IF p_on > current_date THEN RAISE EXCEPTION 'The date cannot be in the future' USING ERRCODE = 'QM024'; END IF;
    IF p_on < s.starts_on THEN RAISE EXCEPTION 'It cannot be before the session started (%)', s.starts_on USING ERRCODE = 'QM024'; END IF;
  END IF;
  IF p_outcome = 'failed' AND (v_note IS NULL OR length(v_note) < 3) THEN RAISE EXCEPTION 'Say why it was failed (a note of at least 3 characters)' USING ERRCODE = 'QM024'; END IF;
  IF (SELECT count(*) FROM public.competence_session_attendees WHERE id = ANY (v_ids) AND session_id = s.id AND status = 'enrolled') <> cardinality(v_ids) THEN
    RAISE EXCEPTION 'Everyone chosen must still be enrolled on this session' USING ERRCODE = 'QM024';
  END IF;
  UPDATE public.competence_session_attendees
     SET status = p_outcome, completed_on = CASE WHEN p_outcome = 'absent' THEN NULL ELSE p_on END, note = v_note, recorded_at = now(), recorded_by = auth.uid()
   WHERE id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

-- A recorded result (completed, failed, absent) is corrected by voiding it; add the person again while the session is open.
CREATE FUNCTION app.void_session_attendee(p_attendee uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.competence_session_attendees%ROWTYPE; v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  SELECT * INTO a FROM public.competence_session_attendees WHERE id = p_attendee;
  IF NOT FOUND OR NOT app.is_member(a.organisation_id) THEN RAISE EXCEPTION 'Attendee not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.training_session_for_update(a.session_id, 'open');
  IF a.status NOT IN ('completed', 'failed', 'absent') THEN RAISE EXCEPTION 'Only a recorded result can be voided' USING ERRCODE = 'QM024'; END IF;
  IF length(v_reason) < 3 THEN RAISE EXCEPTION 'Say why it is voided (at least 3 characters)' USING ERRCODE = 'QM024'; END IF;
  UPDATE public.competence_session_attendees SET status = 'voided', reason = left(v_reason, 500), recorded_at = now(), recorded_by = auth.uid() WHERE id = a.id;
END $$;

CREATE FUNCTION app.close_training_session(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.competence_training_sessions; v_n integer;
BEGIN
  s := app.training_session_for_update(p_id, 'open');
  SELECT count(*) INTO v_n FROM public.competence_session_attendees WHERE session_id = s.id AND status = 'enrolled';
  IF v_n > 0 THEN RAISE EXCEPTION '% still enrolled. Record a result or remove them before closing.', CASE WHEN v_n = 1 THEN '1 person is' ELSE v_n || ' people are' END USING ERRCODE = 'QM024'; END IF;
  UPDATE public.competence_training_sessions SET status = 'closed', closed_at = now(), closed_by = auth.uid() WHERE id = s.id;
END $$;

CREATE FUNCTION app.reopen_training_session(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.competence_training_sessions; v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  s := app.training_session_for_update(p_id, 'closed');
  IF length(v_reason) < 3 THEN RAISE EXCEPTION 'Say why it is reopened (at least 3 characters)' USING ERRCODE = 'QM024'; END IF;
  UPDATE public.competence_training_sessions SET status = 'open', closed_at = NULL, closed_by = NULL, reopen_reason = left(v_reason, 500), reopened_at = now(), reopened_by = auth.uid() WHERE id = s.id;
END $$;

CREATE FUNCTION app.cancel_training_session(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.competence_training_sessions; v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  s := app.training_session_for_update(p_id, 'open');
  IF length(v_reason) < 3 THEN RAISE EXCEPTION 'Say why it is cancelled (at least 3 characters)' USING ERRCODE = 'QM024'; END IF;
  IF EXISTS (SELECT 1 FROM public.competence_session_attendees WHERE session_id = s.id AND status IN ('completed', 'failed')) THEN
    RAISE EXCEPTION 'Someone has a recorded result. Void it first, then cancel.' USING ERRCODE = 'QM024';
  END IF;
  UPDATE public.competence_training_sessions SET status = 'cancelled', cancel_reason = left(v_reason, 500) WHERE id = s.id;
END $$;

-- Files: on a session, or on one attendee (their certificate). The file is already uploaded into the owner's folder.
CREATE FUNCTION app.add_competence_attachment(p_session uuid, p_attendee uuid, p_storage_path text, p_file_name text, p_content_type text, p_size_bytes bigint,
                                              p_description text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.competence_training_sessions; a public.competence_session_attendees%ROWTYPE; v_id uuid;
BEGIN
  IF (p_session IS NULL) = (p_attendee IS NULL) THEN RAISE EXCEPTION 'Attach the file to a session or to one attendee' USING ERRCODE = 'QM024'; END IF;
  IF p_attendee IS NOT NULL THEN
    SELECT * INTO a FROM public.competence_session_attendees WHERE id = p_attendee;
    IF NOT FOUND OR NOT app.is_member(a.organisation_id) THEN RAISE EXCEPTION 'Attendee not found' USING ERRCODE = 'P0002'; END IF;
    IF a.status IN ('removed', 'voided') THEN RAISE EXCEPTION 'That attendee is % and cannot take files', a.status USING ERRCODE = 'QM024'; END IF;
    s := app.training_session_for_update(a.session_id, NULL);
    IF p_storage_path NOT LIKE s.organisation_id::text || '/competence/attendee/' || a.id::text || '/%' THEN RAISE EXCEPTION 'The file must be stored in this attendee''s folder' USING ERRCODE = 'QM024'; END IF;
  ELSE
    s := app.training_session_for_update(p_session, NULL);
    IF p_storage_path NOT LIKE s.organisation_id::text || '/competence/session/' || s.id::text || '/%' THEN RAISE EXCEPTION 'The file must be stored in this session''s folder' USING ERRCODE = 'QM024'; END IF;
  END IF;
  INSERT INTO public.competence_attachments (organisation_id, session_id, attendee_id, storage_path, file_name, content_type, size_bytes, description)
  VALUES (s.organisation_id, p_session, p_attendee, p_storage_path, btrim(p_file_name), p_content_type, p_size_bytes, nullif(btrim(coalesce(p_description, '')), ''))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION app.remove_competence_attachment(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE f public.competence_attachments%ROWTYPE;
BEGIN
  SELECT * INTO f FROM public.competence_attachments WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(f.organisation_id) THEN RAISE EXCEPTION 'File not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_competence_assessor(f.organisation_id);
  IF f.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'That file is already removed' USING ERRCODE = 'QM024'; END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 3 THEN RAISE EXCEPTION 'Say why the file is removed (at least 3 characters)' USING ERRCODE = 'QM024'; END IF;
  UPDATE public.competence_attachments SET deleted_at = now(), deleted_by = auth.uid(), delete_reason = left(btrim(p_reason), 500) WHERE id = f.id;
END $$;

CREATE FUNCTION app.restore_competence_attachment(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE f public.competence_attachments%ROWTYPE;
BEGIN
  SELECT * INTO f FROM public.competence_attachments WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(f.organisation_id) THEN RAISE EXCEPTION 'File not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_competence_assessor(f.organisation_id);
  IF f.deleted_at IS NULL THEN RAISE EXCEPTION 'That file is not removed' USING ERRCODE = 'QM024'; END IF;
  UPDATE public.competence_attachments SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL WHERE id = f.id;
END $$;

-- ---------------------------------------------------------------------------
-- Storage: <org>/competence/session/<session id>/... and <org>/competence/attendee/<attendee id>/...
-- Readable by whoever can read the record; uploads by an assessor into a live (not cancelled) session or attendee folder; never updated or deleted.
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public) VALUES ('competence-files', 'competence-files', false)
ON CONFLICT (id) DO NOTHING;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'storage' AND table_name = 'buckets' AND column_name = 'file_size_limit') THEN
    EXECUTE $q$UPDATE storage.buckets SET file_size_limit = 26214400 WHERE id = 'competence-files'$q$;
  END IF;
END $$;

CREATE FUNCTION app.competence_file_allowed(p_object_name text, p_upload boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT split_part(p_object_name, '/', 2) = 'competence' AND (
    (split_part(p_object_name, '/', 3) = 'session' AND EXISTS (
       SELECT 1 FROM public.competence_training_sessions s
        WHERE s.id = app.try_uuid(split_part(p_object_name, '/', 4)) AND s.organisation_id = app.try_uuid(split_part(p_object_name, '/', 1))
          AND CASE WHEN p_upload THEN s.status <> 'cancelled' AND app.has_permission(s.organisation_id, 'competence.assess')
                   ELSE app.has_permission(s.organisation_id, 'competence.read') OR app.competence_on_session(s.id) END))
    OR
    (split_part(p_object_name, '/', 3) = 'attendee' AND EXISTS (
       SELECT 1 FROM public.competence_session_attendees a JOIN public.competence_training_sessions s ON s.id = a.session_id
        WHERE a.id = app.try_uuid(split_part(p_object_name, '/', 4)) AND a.organisation_id = app.try_uuid(split_part(p_object_name, '/', 1))
          AND CASE WHEN p_upload THEN s.status <> 'cancelled' AND a.status NOT IN ('removed', 'voided') AND app.has_permission(a.organisation_id, 'competence.assess')
                   ELSE app.has_permission(a.organisation_id, 'competence.read') OR app.competence_is_me(a.employee_id) END)))
$$;
CREATE POLICY competence_files_select ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'competence-files' AND app.competence_file_allowed(name, false));
CREATE POLICY competence_files_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'competence-files' AND app.competence_file_allowed(name, true));

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app.next_training_session_reference(uuid), app.competence_session_rules(), app.competence_attendee_rules(), app.competence_attachment_rules(),
  app.assert_competence_assessor(uuid), app.training_session_for_update(uuid, text), app.training_session_values(jsonb, uuid, public.competence_training_sessions),
  app.training_session_set_skills(uuid, uuid, uuid[]), app.create_training_session(uuid, jsonb, uuid[]), app.update_training_session(uuid, jsonb),
  app.add_session_attendee(uuid, uuid), app.remove_session_attendee(uuid, text), app.record_session_attendees(uuid, uuid[], text, date, text),
  app.void_session_attendee(uuid, text), app.close_training_session(uuid), app.reopen_training_session(uuid, text), app.cancel_training_session(uuid, text),
  app.add_competence_attachment(uuid, uuid, text, text, text, bigint, text), app.remove_competence_attachment(uuid, text), app.restore_competence_attachment(uuid),
  app.competence_file_allowed(text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.create_training_session(uuid, jsonb, uuid[]), app.update_training_session(uuid, jsonb), app.add_session_attendee(uuid, uuid),
  app.remove_session_attendee(uuid, text), app.record_session_attendees(uuid, uuid[], text, date, text), app.void_session_attendee(uuid, text),
  app.close_training_session(uuid), app.reopen_training_session(uuid, text), app.cancel_training_session(uuid, text),
  app.add_competence_attachment(uuid, uuid, text, text, text, bigint, text), app.remove_competence_attachment(uuid, text), app.restore_competence_attachment(uuid),
  app.competence_file_allowed(text, boolean) TO authenticated;
