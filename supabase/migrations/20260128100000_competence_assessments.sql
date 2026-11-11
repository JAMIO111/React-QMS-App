-- Competence slice CO2 (docs/competence-plan.md): the positions people hold (with dates), assessments (append-only), and seeing your own record.
--
--  * competence_employee_positions: which position an employee holds and since when; ended, never deleted or overwritten (CP13). Written only by
--    app.assign_employee_position / app.end_employee_position (competence.manage). One open row per employee and position; a new row may not overlap an earlier one.
--  * competence_assessments: APPEND-ONLY. An assessment says an employee is at level 0-4 for a skill, on a date, by an assessor, optionally until a date. The latest
--    current one is the person's level; the one it replaces becomes `superseded` (the only change allowed, enforced by trigger even for SQL). Written only by
--    app.record_competence_assessment: needs competence.assess, **never the person's own** (their linked sign-in), level 4 also needs competence.manage, a level of 1-4
--    needs an active skill, a lower level than before needs a note, the date is not in the future nor before the one it replaces, and the expiry defaults from the
--    skill's refresh interval. Expiry, gaps and levels are worked out on read, never stored or applied automatically.
--  * Seeing your own record: a member with a linked employee record reads their own positions and assessments, and the skills / positions lists, whatever their role.
--    (Everyone else needs competence.read, which Controller-seat holders also have.)
--  * A position held by people cannot be retired until it is ended for them.
-- Errors QM024 (409 competence_rule); another organisation's id P0002 (404).

-- ---------------------------------------------------------------------------
-- Who may see their own record
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.competence_is_me(p_employee uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public."Employees" e WHERE e.id = p_employee AND e.auth_id = auth.uid() AND app.is_member(e.organisation_id))
$$;
CREATE FUNCTION app.competence_has_own_record(p_organisation_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public."Employees" e WHERE e.organisation_id = p_organisation_id AND e.auth_id = auth.uid() AND app.is_member(p_organisation_id))
$$;
REVOKE ALL ON FUNCTION app.competence_is_me(uuid), app.competence_has_own_record(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.competence_is_me(uuid), app.competence_has_own_record(uuid) TO authenticated;

-- The set-up lists are readable by anyone who may read competence, and by a member who has their own record (they need the names to read it).
DROP POLICY competence_categories_select ON public.competence_categories;
CREATE POLICY competence_categories_select ON public.competence_categories FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'competence.read') OR app.competence_has_own_record(organisation_id));
DROP POLICY competence_skills_select ON public.competence_skills;
CREATE POLICY competence_skills_select ON public.competence_skills FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'competence.read') OR app.competence_has_own_record(organisation_id));
DROP POLICY competence_positions_select ON public.competence_positions;
CREATE POLICY competence_positions_select ON public.competence_positions FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'competence.read') OR app.competence_has_own_record(organisation_id));
DROP POLICY competence_position_skills_select ON public.competence_position_skills;
CREATE POLICY competence_position_skills_select ON public.competence_position_skills FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'competence.read') OR app.competence_has_own_record(organisation_id));

-- The menu: "competence.own" is not a permission, only a flag for the menu that this member has a record of their own.
CREATE OR REPLACE FUNCTION app.my_visible_permissions(p_organisation_id uuid) RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p FROM (
    SELECT DISTINCT rp.permission_code AS p
    FROM public.organisation_users m
    JOIN public.organisations o ON o.id = m.organisation_id AND o.status = 'active'
    JOIN public.user_role_assignments a ON a.membership_id = m.id
    JOIN public.role_permissions rp ON rp.role_id = a.role_id
    WHERE m.organisation_id = p_organisation_id AND m.user_id = auth.uid() AND m.status = 'active'
      AND app.mfa_satisfied(p_organisation_id)
      AND (rp.permission_code = ANY (app.gated_permissions()) OR app.organisation_access_open(p_organisation_id))
      AND (rp.permission_code NOT LIKE 'integrations.%' OR app.holds_controller_seat(p_organisation_id))
    UNION
    SELECT 'competence.read'
     WHERE app.competence_seat_read(p_organisation_id) AND app.mfa_satisfied(p_organisation_id) AND app.organisation_access_open(p_organisation_id)
    UNION
    SELECT 'competence.own'
     WHERE app.competence_has_own_record(p_organisation_id) AND app.mfa_satisfied(p_organisation_id) AND app.organisation_access_open(p_organisation_id)
  ) x
$$;

-- ---------------------------------------------------------------------------
-- Positions held, with dates
-- ---------------------------------------------------------------------------
CREATE TABLE public.competence_employee_positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  employee_id uuid NOT NULL,
  position_id uuid NOT NULL,
  started_on date NOT NULL,
  ended_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT competence_employee_positions_employee_fkey FOREIGN KEY (employee_id, organisation_id) REFERENCES public."Employees" (id, organisation_id),
  CONSTRAINT competence_employee_positions_position_fkey FOREIGN KEY (position_id, organisation_id) REFERENCES public.competence_positions (id, organisation_id),
  CONSTRAINT competence_employee_positions_dates_check CHECK (ended_on IS NULL OR ended_on >= started_on)
);
CREATE UNIQUE INDEX competence_employee_positions_open_key ON public.competence_employee_positions (employee_id, position_id) WHERE ended_on IS NULL;
CREATE INDEX competence_employee_positions_employee_idx ON public.competence_employee_positions (organisation_id, employee_id);
CREATE INDEX competence_employee_positions_position_idx ON public.competence_employee_positions (organisation_id, position_id);
CREATE TRIGGER competence_employee_positions_stamp BEFORE INSERT ON public.competence_employee_positions FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER competence_employee_positions_touch BEFORE UPDATE ON public.competence_employee_positions FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER competence_employee_positions_org_immutable BEFORE UPDATE ON public.competence_employee_positions FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.competence_employee_positions FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.competence_employee_positions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.competence_employee_positions FROM anon, authenticated;
GRANT SELECT ON public.competence_employee_positions TO authenticated;
CREATE POLICY competence_employee_positions_select ON public.competence_employee_positions FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'competence.read') OR app.competence_is_me(employee_id));

-- ---------------------------------------------------------------------------
-- Assessments (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE public.competence_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  employee_id uuid NOT NULL,
  skill_id uuid NOT NULL,
  level integer NOT NULL CHECK (level BETWEEN 0 AND 4),
  assessed_on date NOT NULL,
  assessor_user_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  expires_on date,
  note text CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 1000),
  status text NOT NULL DEFAULT 'current' CHECK (status IN ('current', 'superseded')),
  supersedes_id uuid REFERENCES public.competence_assessments (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT competence_assessments_employee_fkey FOREIGN KEY (employee_id, organisation_id) REFERENCES public."Employees" (id, organisation_id),
  CONSTRAINT competence_assessments_skill_fkey FOREIGN KEY (skill_id, organisation_id) REFERENCES public.competence_skills (id, organisation_id),
  CONSTRAINT competence_assessments_expiry_check CHECK (expires_on IS NULL OR expires_on > assessed_on)
);
CREATE UNIQUE INDEX competence_assessments_current_key ON public.competence_assessments (employee_id, skill_id) WHERE status = 'current';
CREATE INDEX competence_assessments_employee_idx ON public.competence_assessments (organisation_id, employee_id, skill_id, assessed_on DESC);
CREATE INDEX competence_assessments_skill_idx ON public.competence_assessments (organisation_id, skill_id);

-- Append-only: the only change is current -> superseded; nothing is deleted. (A trigger, so SQL run by the operator is held to it too.)
CREATE FUNCTION app.competence_assessment_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'An assessment is never deleted. Record a new one.' USING ERRCODE = 'QM024'; END IF;
  IF OLD.status = 'current' AND NEW.status = 'superseded'
     AND (NEW.employee_id, NEW.skill_id, NEW.level, NEW.assessed_on, NEW.assessor_user_id, NEW.expires_on, NEW.note, NEW.supersedes_id, NEW.organisation_id)
         IS NOT DISTINCT FROM (OLD.employee_id, OLD.skill_id, OLD.level, OLD.assessed_on, OLD.assessor_user_id, OLD.expires_on, OLD.note, OLD.supersedes_id, OLD.organisation_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'An assessment cannot be changed. Record a new one.' USING ERRCODE = 'QM024';
END $$;
CREATE TRIGGER competence_assessments_frozen BEFORE UPDATE OR DELETE ON public.competence_assessments FOR EACH ROW EXECUTE FUNCTION app.competence_assessment_frozen();
CREATE TRIGGER competence_assessments_stamp BEFORE INSERT ON public.competence_assessments FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.competence_assessments FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.competence_assessments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.competence_assessments FROM anon, authenticated;
GRANT SELECT ON public.competence_assessments TO authenticated;
CREATE POLICY competence_assessments_select ON public.competence_assessments FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'competence.read') OR app.competence_is_me(employee_id));

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------
-- A person holds a position from a date. The same position again must start after an earlier stint ended.
CREATE FUNCTION app.assign_employee_position(p_employee uuid, p_position uuid, p_started_on date) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE e public."Employees"%ROWTYPE; p public.competence_positions%ROWTYPE; v_id uuid;
BEGIN
  SELECT * INTO e FROM public."Employees" WHERE id = p_employee;
  IF NOT FOUND OR NOT app.is_member(e.organisation_id) THEN RAISE EXCEPTION 'Employee not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_competence_manager(e.organisation_id);
  SELECT * INTO p FROM public.competence_positions WHERE id = p_position AND organisation_id = e.organisation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Position not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT e.active THEN RAISE EXCEPTION 'That employee is not active' USING ERRCODE = 'QM024'; END IF;
  IF NOT p.active THEN RAISE EXCEPTION '% is retired and cannot be given to anyone' , p.name USING ERRCODE = 'QM024'; END IF;
  IF p_started_on IS NULL THEN RAISE EXCEPTION 'Say when they started in the position' USING ERRCODE = 'QM024'; END IF;
  IF p_started_on > current_date THEN RAISE EXCEPTION 'The start date cannot be in the future' USING ERRCODE = 'QM024'; END IF;
  IF EXISTS (SELECT 1 FROM public.competence_employee_positions x WHERE x.employee_id = e.id AND x.position_id = p.id AND (x.ended_on IS NULL OR x.ended_on >= p_started_on)) THEN
    RAISE EXCEPTION '% already holds % over those dates', coalesce(e.first_name || ' ' || e.surname, 'This person'), p.name USING ERRCODE = 'QM024';
  END IF;
  INSERT INTO public.competence_employee_positions (organisation_id, employee_id, position_id, started_on) VALUES (e.organisation_id, e.id, p.id, p_started_on) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION app.end_employee_position(p_id uuid, p_ended_on date DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE x public.competence_employee_positions%ROWTYPE; v_end date := coalesce(p_ended_on, current_date);
BEGIN
  SELECT * INTO x FROM public.competence_employee_positions WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(x.organisation_id) THEN RAISE EXCEPTION 'Position held not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_competence_manager(x.organisation_id);
  IF x.ended_on IS NOT NULL THEN RAISE EXCEPTION 'That position has already ended' USING ERRCODE = 'QM024'; END IF;
  IF v_end < x.started_on THEN RAISE EXCEPTION 'It cannot end before it started (%)', x.started_on USING ERRCODE = 'QM024'; END IF;
  IF v_end > current_date THEN RAISE EXCEPTION 'The end date cannot be in the future' USING ERRCODE = 'QM024'; END IF;
  UPDATE public.competence_employee_positions SET ended_on = v_end WHERE id = x.id;
END $$;

-- A position that people still hold cannot be retired.
CREATE OR REPLACE FUNCTION app.retire_competence_position(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.competence_positions%ROWTYPE; v_reason text := btrim(coalesce(p_reason, '')); v_n integer;
BEGIN
  SELECT * INTO s FROM public.competence_positions WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(s.organisation_id) THEN RAISE EXCEPTION 'Position not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_competence_manager(s.organisation_id);
  IF NOT s.active THEN RAISE EXCEPTION 'That position is already retired' USING ERRCODE = 'QM024'; END IF;
  IF length(v_reason) < 3 THEN RAISE EXCEPTION 'Say why the position is retired (at least 3 characters)' USING ERRCODE = 'QM024'; END IF;
  SELECT count(*) INTO v_n FROM public.competence_employee_positions x WHERE x.position_id = s.id AND x.ended_on IS NULL;
  IF v_n > 0 THEN
    RAISE EXCEPTION '% % still hold%. End the position for % first.', v_n, CASE WHEN v_n = 1 THEN 'person' ELSE 'people' END, CASE WHEN v_n = 1 THEN 's it' ELSE ' it' END, CASE WHEN v_n = 1 THEN 'them' ELSE 'them' END
      USING ERRCODE = 'QM024';
  END IF;
  UPDATE public.competence_positions SET active = false, retired_reason = left(v_reason, 500), retired_at = now(), retired_by = auth.uid() WHERE id = s.id;
END $$;

-- Assess: p_level 0 (none) to 4 (can train others). Returns the new assessment's id.
CREATE FUNCTION app.record_competence_assessment(p_employee uuid, p_skill uuid, p_level integer, p_assessed_on date, p_expires_on date DEFAULT NULL, p_note text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  e public."Employees"%ROWTYPE; k public.competence_skills%ROWTYPE; prev public.competence_assessments%ROWTYPE;
  v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_expires date; v_id uuid;
BEGIN
  SELECT * INTO e FROM public."Employees" WHERE id = p_employee;
  IF NOT FOUND OR NOT app.is_member(e.organisation_id) THEN RAISE EXCEPTION 'Employee not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(e.organisation_id, 'competence.assess') THEN RAISE EXCEPTION 'You are not allowed to assess competence' USING ERRCODE = '42501'; END IF;
  IF e.auth_id IS NOT NULL AND e.auth_id = auth.uid() THEN RAISE EXCEPTION 'You cannot assess your own competence. Ask someone else.' USING ERRCODE = 'QM024'; END IF;
  SELECT * INTO k FROM public.competence_skills WHERE id = p_skill AND organisation_id = e.organisation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Skill not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT e.active THEN RAISE EXCEPTION 'That employee is not active' USING ERRCODE = 'QM024'; END IF;
  IF p_level IS NULL OR p_level NOT BETWEEN 0 AND 4 THEN RAISE EXCEPTION 'The level is 0 (none) to 4 (can train others)' USING ERRCODE = 'QM024'; END IF;
  IF p_level >= 1 AND NOT k.active THEN RAISE EXCEPTION '% is retired, so no one can be assessed as competent in it', k.name USING ERRCODE = 'QM024'; END IF;
  IF p_level = 4 AND NOT app.has_permission(e.organisation_id, 'competence.manage') THEN
    RAISE EXCEPTION 'Only someone who manages competence can assess "can train others"' USING ERRCODE = '42501';
  END IF;
  IF p_assessed_on IS NULL THEN RAISE EXCEPTION 'Say when the assessment was made' USING ERRCODE = 'QM024'; END IF;
  IF p_assessed_on > current_date THEN RAISE EXCEPTION 'The assessment date cannot be in the future' USING ERRCODE = 'QM024'; END IF;
  SELECT * INTO prev FROM public.competence_assessments WHERE employee_id = e.id AND skill_id = k.id AND status = 'current' FOR UPDATE;
  IF FOUND THEN
    IF p_assessed_on < prev.assessed_on THEN RAISE EXCEPTION 'It cannot be dated before the assessment it replaces (%)', prev.assessed_on USING ERRCODE = 'QM024'; END IF;
    IF p_level < prev.level AND (v_note IS NULL OR length(v_note) < 3) THEN RAISE EXCEPTION 'Say why the level is lower than before (a note of at least 3 characters)' USING ERRCODE = 'QM024'; END IF;
  END IF;
  v_expires := CASE
    WHEN p_level = 0 THEN NULL
    WHEN p_expires_on IS NOT NULL THEN p_expires_on
    WHEN k.refresh_months IS NOT NULL THEN (p_assessed_on + make_interval(months => k.refresh_months))::date
    ELSE NULL END;
  IF v_expires IS NOT NULL AND v_expires <= p_assessed_on THEN RAISE EXCEPTION 'The expiry must be after the assessment date' USING ERRCODE = 'QM024'; END IF;
  IF prev.id IS NOT NULL THEN UPDATE public.competence_assessments SET status = 'superseded' WHERE id = prev.id; END IF;
  INSERT INTO public.competence_assessments (organisation_id, employee_id, skill_id, level, assessed_on, assessor_user_id, expires_on, note, supersedes_id)
  VALUES (e.organisation_id, e.id, k.id, p_level, p_assessed_on, auth.uid(), v_expires, v_note, prev.id) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION app.assign_employee_position(uuid, uuid, date), app.end_employee_position(uuid, date),
  app.record_competence_assessment(uuid, uuid, integer, date, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.assign_employee_position(uuid, uuid, date), app.end_employee_position(uuid, date),
  app.record_competence_assessment(uuid, uuid, integer, date, date, text) TO authenticated;
REVOKE ALL ON FUNCTION app.competence_assessment_frozen() FROM PUBLIC, anon, authenticated;
