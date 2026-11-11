-- Competence module, slice CO1 (docs/competence-plan.md): permissions, categories, skills, positions and what each position requires.
--
--  * Permissions competence.read / .manage / .assess. Owner, admin and quality manager hold all three, quality engineer read and assess.
--  * **Controller-seat holders see everything in the module (CP11):** app.has_permission, has_permission_somewhere, my_permissions and my_visible_permissions
--    grant competence.read to an active member who holds a Controller seat, so row-level security, the API guard and the menu all follow with no other change.
--    Reading only: managing and assessing still need their permissions.
--  * competence_categories: per organisation, seeded (key fixed, nothing deleted); competence.manage adds, renames and switches off (as supplier classifications).
--  * competence_skills and competence_positions: written only by functions (competence.manage). A skill has a code (fixed once created), a name, a category, an
--    optional refresh interval in months; it is retired with a reason, never deleted, and cannot be retired while an active position requires it.
--  * competence_position_skills: what a position requires (skill + required level 1-4), replaced as a whole by app.set_position_skills.
-- Errors use QM024 (409 competence_rule); another organisation's id is P0002 (404).

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------
INSERT INTO public.permissions (code, description) VALUES
  ('competence.read',   'View competence: skills, positions, the skills matrix, assessments and training'),
  ('competence.manage', 'Manage competence: categories, skills, positions, who holds them, and correct or void records'),
  ('competence.assess', 'Assess people against skills and record training sessions (never your own competence)');

WITH grants(key, perms) AS (VALUES
  ('owner',            ARRAY['competence.read', 'competence.manage', 'competence.assess']),
  ('admin',            ARRAY['competence.read', 'competence.manage', 'competence.assess']),
  ('quality_manager',  ARRAY['competence.read', 'competence.manage', 'competence.assess']),
  ('quality_engineer', ARRAY['competence.read', 'competence.assess'])
)
INSERT INTO public.role_permissions (role_id, permission_code)
SELECT r.id, unnest(g.perms) FROM public.roles r JOIN grants g ON g.key = r.key WHERE r.is_system
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Controller-seat holders read all of Competence
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.competence_seat_read(p_organisation_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app.holds_controller_seat(p_organisation_id)
$$;
REVOKE ALL ON FUNCTION app.competence_seat_read(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.competence_seat_read(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION app.has_permission(
  p_organisation_id uuid, p_permission text, p_site_id uuid DEFAULT NULL, p_department_id uuid DEFAULT NULL
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT (EXISTS (
    SELECT 1
    FROM public.organisation_users m
    JOIN public.organisations o ON o.id = m.organisation_id AND o.status = 'active'
    JOIN public.user_role_assignments a ON a.membership_id = m.id
    JOIN public.role_permissions rp ON rp.role_id = a.role_id
    WHERE m.organisation_id = p_organisation_id
      AND m.user_id = auth.uid()
      AND m.status = 'active'
      AND rp.permission_code = p_permission
      AND (a.site_id IS NULL OR a.site_id = p_site_id)
      AND (a.department_id IS NULL OR a.department_id = p_department_id)
  ) OR (p_permission = 'competence.read' AND app.competence_seat_read(p_organisation_id)))
    AND app.mfa_satisfied(p_organisation_id)
    AND (p_permission = ANY (app.gated_permissions()) OR app.organisation_access_open(p_organisation_id))
    AND app.has_entitlement(p_organisation_id, p_permission)
    AND (p_permission NOT LIKE 'integrations.%' OR app.holds_controller_seat(p_organisation_id))
$$;

CREATE OR REPLACE FUNCTION app.has_permission_somewhere(p_organisation_id uuid, p_permission text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT (EXISTS (
    SELECT 1
    FROM public.organisation_users m
    JOIN public.organisations o ON o.id = m.organisation_id AND o.status = 'active'
    JOIN public.user_role_assignments a ON a.membership_id = m.id
    JOIN public.role_permissions rp ON rp.role_id = a.role_id
    WHERE m.organisation_id = p_organisation_id AND m.user_id = auth.uid() AND m.status = 'active'
      AND rp.permission_code = p_permission
  ) OR (p_permission = 'competence.read' AND app.competence_seat_read(p_organisation_id)))
    AND app.mfa_satisfied(p_organisation_id)
    AND (p_permission = ANY (app.gated_permissions()) OR app.organisation_access_open(p_organisation_id))
    AND app.has_entitlement(p_organisation_id, p_permission)
    AND (p_permission NOT LIKE 'integrations.%' OR app.holds_controller_seat(p_organisation_id))
$$;

CREATE OR REPLACE FUNCTION app.my_permissions(p_organisation_id uuid) RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p FROM (
    SELECT DISTINCT rp.permission_code AS p
    FROM public.organisation_users m
    JOIN public.organisations o ON o.id = m.organisation_id AND o.status = 'active'
    JOIN public.user_role_assignments a ON a.membership_id = m.id AND a.site_id IS NULL AND a.department_id IS NULL
    JOIN public.role_permissions rp ON rp.role_id = a.role_id
    WHERE m.organisation_id = p_organisation_id AND m.user_id = auth.uid() AND m.status = 'active'
      AND app.mfa_satisfied(p_organisation_id)
      AND (rp.permission_code = ANY (app.gated_permissions()) OR app.organisation_access_open(p_organisation_id))
      AND (rp.permission_code NOT LIKE 'integrations.%' OR app.holds_controller_seat(p_organisation_id))
    UNION
    SELECT 'competence.read'
     WHERE app.competence_seat_read(p_organisation_id) AND app.mfa_satisfied(p_organisation_id) AND app.organisation_access_open(p_organisation_id)
  ) x
$$;

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
  ) x
$$;

-- ---------------------------------------------------------------------------
-- Categories (organisation-configurable, seeded)
-- ---------------------------------------------------------------------------
CREATE TABLE public.competence_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 60),
  description text CHECK (description IS NULL OR length(btrim(description)) BETWEEN 1 AND 300),
  sequence integer NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT competence_categories_key UNIQUE (organisation_id, key),
  CONSTRAINT competence_categories_id_org_key UNIQUE (id, organisation_id)
);
CREATE UNIQUE INDEX competence_categories_label_key ON public.competence_categories (organisation_id, lower(btrim(label)));
CREATE TRIGGER competence_categories_stamp BEFORE INSERT ON public.competence_categories FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER competence_categories_touch BEFORE UPDATE ON public.competence_categories FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER competence_categories_org_immutable BEFORE UPDATE ON public.competence_categories FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.competence_categories FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.competence_categories ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.competence_categories FROM anon, authenticated;
GRANT SELECT, INSERT ON public.competence_categories TO authenticated;
GRANT UPDATE (label, description, sequence, active) ON public.competence_categories TO authenticated;
CREATE POLICY competence_categories_select ON public.competence_categories FOR SELECT TO authenticated USING (app.has_permission(organisation_id, 'competence.read'));
CREATE POLICY competence_categories_insert ON public.competence_categories FOR INSERT TO authenticated WITH CHECK (app.has_permission(organisation_id, 'competence.manage'));
CREATE POLICY competence_categories_update ON public.competence_categories FOR UPDATE TO authenticated
  USING (app.has_permission(organisation_id, 'competence.manage')) WITH CHECK (app.has_permission(organisation_id, 'competence.manage'));

CREATE FUNCTION app.seed_competence_categories(p_organisation_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO public.competence_categories (organisation_id, key, label, sequence) VALUES
    (p_organisation_id, 'inspection',        'Inspection',          1),
    (p_organisation_id, 'measurement',       'Measurement',         2),
    (p_organisation_id, 'machine_operation', 'Machine operation',   3),
    (p_organisation_id, 'quality_system',    'Quality system',      4),
    (p_organisation_id, 'health_safety',     'Health and safety',   5),
    (p_organisation_id, 'other',             'Other',               6)
  ON CONFLICT (organisation_id, key) DO NOTHING
$$;
CREATE FUNCTION app.seed_competence_categories_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.seed_competence_categories(NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER organisations_seed_competence_categories AFTER INSERT ON public.organisations FOR EACH ROW EXECUTE FUNCTION app.seed_competence_categories_trg();
SELECT app.seed_competence_categories(o.id) FROM public.organisations o;

-- ---------------------------------------------------------------------------
-- Skills
-- ---------------------------------------------------------------------------
CREATE TABLE public.competence_skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  code text NOT NULL CHECK (length(btrim(code)) BETWEEN 1 AND 40 AND code = btrim(code)),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  category_id uuid NOT NULL,
  description text CHECK (description IS NULL OR length(btrim(description)) BETWEEN 1 AND 1000),
  refresh_months integer CHECK (refresh_months IS NULL OR refresh_months BETWEEN 1 AND 120),
  active boolean NOT NULL DEFAULT true,
  retired_reason text CHECK (retired_reason IS NULL OR length(btrim(retired_reason)) BETWEEN 3 AND 500),
  retired_at timestamptz,
  retired_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT competence_skills_category_fkey FOREIGN KEY (category_id, organisation_id) REFERENCES public.competence_categories (id, organisation_id),
  CONSTRAINT competence_skills_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT competence_skills_retired_check CHECK ((active AND retired_reason IS NULL AND retired_at IS NULL) OR (NOT active AND retired_reason IS NOT NULL AND retired_at IS NOT NULL))
);
CREATE UNIQUE INDEX competence_skills_code_key ON public.competence_skills (organisation_id, upper(code));
CREATE UNIQUE INDEX competence_skills_name_key ON public.competence_skills (organisation_id, lower(btrim(name))) WHERE active;
CREATE INDEX competence_skills_category_idx ON public.competence_skills (organisation_id, category_id);
CREATE TRIGGER competence_skills_stamp BEFORE INSERT ON public.competence_skills FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER competence_skills_touch BEFORE UPDATE ON public.competence_skills FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER competence_skills_org_immutable BEFORE UPDATE ON public.competence_skills FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.competence_skills FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.competence_skills ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.competence_skills FROM anon, authenticated;
GRANT SELECT ON public.competence_skills TO authenticated;
CREATE POLICY competence_skills_select ON public.competence_skills FOR SELECT TO authenticated USING (app.has_permission(organisation_id, 'competence.read'));

-- ---------------------------------------------------------------------------
-- Positions and what they require
-- ---------------------------------------------------------------------------
CREATE TABLE public.competence_positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  code text NOT NULL CHECK (length(btrim(code)) BETWEEN 1 AND 40 AND code = btrim(code)),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  description text CHECK (description IS NULL OR length(btrim(description)) BETWEEN 1 AND 1000),
  active boolean NOT NULL DEFAULT true,
  retired_reason text CHECK (retired_reason IS NULL OR length(btrim(retired_reason)) BETWEEN 3 AND 500),
  retired_at timestamptz,
  retired_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT competence_positions_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT competence_positions_retired_check CHECK ((active AND retired_reason IS NULL AND retired_at IS NULL) OR (NOT active AND retired_reason IS NOT NULL AND retired_at IS NOT NULL))
);
CREATE UNIQUE INDEX competence_positions_code_key ON public.competence_positions (organisation_id, upper(code));
CREATE UNIQUE INDEX competence_positions_name_key ON public.competence_positions (organisation_id, lower(btrim(name))) WHERE active;
CREATE TRIGGER competence_positions_stamp BEFORE INSERT ON public.competence_positions FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER competence_positions_touch BEFORE UPDATE ON public.competence_positions FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER competence_positions_org_immutable BEFORE UPDATE ON public.competence_positions FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.competence_positions FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.competence_positions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.competence_positions FROM anon, authenticated;
GRANT SELECT ON public.competence_positions TO authenticated;
CREATE POLICY competence_positions_select ON public.competence_positions FOR SELECT TO authenticated USING (app.has_permission(organisation_id, 'competence.read'));

CREATE TABLE public.competence_position_skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  position_id uuid NOT NULL,
  skill_id uuid NOT NULL,
  required_level integer NOT NULL CHECK (required_level BETWEEN 1 AND 4),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT competence_position_skills_position_fkey FOREIGN KEY (position_id, organisation_id) REFERENCES public.competence_positions (id, organisation_id),
  CONSTRAINT competence_position_skills_skill_fkey FOREIGN KEY (skill_id, organisation_id) REFERENCES public.competence_skills (id, organisation_id),
  CONSTRAINT competence_position_skills_pair_key UNIQUE (position_id, skill_id)
);
CREATE INDEX competence_position_skills_skill_idx ON public.competence_position_skills (organisation_id, skill_id);
CREATE TRIGGER competence_position_skills_stamp BEFORE INSERT ON public.competence_position_skills FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.competence_position_skills FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.competence_position_skills ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.competence_position_skills FROM anon, authenticated;
GRANT SELECT ON public.competence_position_skills TO authenticated;
CREATE POLICY competence_position_skills_select ON public.competence_position_skills FOR SELECT TO authenticated USING (app.has_permission(organisation_id, 'competence.read'));

-- ---------------------------------------------------------------------------
-- Functions (SECURITY DEFINER, competence.manage)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.assert_competence_manager(p_organisation_id uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT app.is_member(p_organisation_id) THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(p_organisation_id, 'competence.manage') THEN
    RAISE EXCEPTION 'You are not allowed to manage competence' USING ERRCODE = '42501';
  END IF;
END $$;

-- Data keys present are set: code (create only), name, categoryId, description (null clears), refreshMonths (null clears).
CREATE FUNCTION app.save_competence_skill(p_organisation_id uuid, p_data jsonb, p_id uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  s public.competence_skills%ROWTYPE;
  k text; v_id uuid;
  v_code text; v_name text; v_cat uuid; v_desc text; v_refresh integer;
BEGIN
  PERFORM app.assert_competence_manager(p_organisation_id);
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Send the skill as an object' USING ERRCODE = 'QM024'; END IF;
  FOR k IN SELECT jsonb_object_keys(p_data) LOOP
    IF k NOT IN ('code', 'name', 'categoryId', 'description', 'refreshMonths') THEN RAISE EXCEPTION 'Unknown field %', k USING ERRCODE = 'QM024'; END IF;
  END LOOP;
  IF p_id IS NOT NULL THEN
    SELECT * INTO s FROM public.competence_skills WHERE id = p_id AND organisation_id = p_organisation_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Skill not found' USING ERRCODE = 'P0002'; END IF;
    IF NOT s.active THEN RAISE EXCEPTION 'A retired skill cannot be edited. Bring it back first.' USING ERRCODE = 'QM024'; END IF;
    IF p_data ? 'code' AND upper(btrim(p_data ->> 'code')) IS DISTINCT FROM upper(s.code) THEN
      RAISE EXCEPTION 'The code of a skill cannot change once it is created' USING ERRCODE = 'QM024';
    END IF;
  END IF;
  v_code  := CASE WHEN p_id IS NULL THEN btrim(p_data ->> 'code') ELSE s.code END;
  v_name  := CASE WHEN p_data ? 'name' THEN btrim(p_data ->> 'name') ELSE s.name END;
  v_cat   := CASE WHEN p_data ? 'categoryId' THEN (p_data ->> 'categoryId')::uuid ELSE s.category_id END;
  v_desc  := CASE WHEN p_data ? 'description' THEN nullif(btrim(p_data ->> 'description'), '') ELSE s.description END;
  v_refresh := CASE WHEN p_data ? 'refreshMonths' THEN (p_data ->> 'refreshMonths')::integer ELSE s.refresh_months END;
  IF v_code IS NULL OR length(v_code) = 0 THEN RAISE EXCEPTION 'Give the skill a code' USING ERRCODE = 'QM024'; END IF;
  IF v_name IS NULL OR length(v_name) = 0 THEN RAISE EXCEPTION 'Give the skill a name' USING ERRCODE = 'QM024'; END IF;
  IF v_cat IS NULL THEN RAISE EXCEPTION 'Choose a category' USING ERRCODE = 'QM024'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.competence_categories c WHERE c.id = v_cat AND c.organisation_id = p_organisation_id AND (c.active OR (p_id IS NOT NULL AND v_cat = s.category_id))) THEN
    RAISE EXCEPTION 'Choose an active category of this organisation' USING ERRCODE = 'QM024';
  END IF;
  IF v_refresh IS NOT NULL AND v_refresh NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION 'The refresh interval is 1 to 120 months' USING ERRCODE = 'QM024'; END IF;
  IF p_id IS NULL THEN
    INSERT INTO public.competence_skills (organisation_id, code, name, category_id, description, refresh_months)
    VALUES (p_organisation_id, v_code, v_name, v_cat, v_desc, v_refresh) RETURNING id INTO v_id;
  ELSE
    UPDATE public.competence_skills SET name = v_name, category_id = v_cat, description = v_desc, refresh_months = v_refresh WHERE id = p_id;
    v_id := p_id;
  END IF;
  RETURN v_id;
EXCEPTION
  WHEN unique_violation THEN
    IF SQLERRM LIKE '%competence_skills_code_key%' THEN RAISE EXCEPTION 'A skill with the code % already exists', v_code USING ERRCODE = 'QM024'; END IF;
    IF SQLERRM LIKE '%competence_skills_name_key%' THEN RAISE EXCEPTION 'A skill called % already exists', v_name USING ERRCODE = 'QM024'; END IF;
    RAISE;
END $$;

CREATE FUNCTION app.retire_competence_skill(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.competence_skills%ROWTYPE; v_reason text := btrim(coalesce(p_reason, '')); v_positions text;
BEGIN
  SELECT * INTO s FROM public.competence_skills WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(s.organisation_id) THEN RAISE EXCEPTION 'Skill not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_competence_manager(s.organisation_id);
  IF NOT s.active THEN RAISE EXCEPTION 'That skill is already retired' USING ERRCODE = 'QM024'; END IF;
  IF length(v_reason) < 3 THEN RAISE EXCEPTION 'Say why the skill is retired (at least 3 characters)' USING ERRCODE = 'QM024'; END IF;
  SELECT string_agg(p.name, ', ' ORDER BY p.name) INTO v_positions
    FROM public.competence_position_skills ps JOIN public.competence_positions p ON p.id = ps.position_id
   WHERE ps.skill_id = s.id AND p.active;
  IF v_positions IS NOT NULL THEN
    RAISE EXCEPTION '% is required by %. Take it off those positions first.', s.name, v_positions USING ERRCODE = 'QM024';
  END IF;
  UPDATE public.competence_skills SET active = false, retired_reason = left(v_reason, 500), retired_at = now(), retired_by = auth.uid() WHERE id = s.id;
END $$;

CREATE FUNCTION app.reactivate_competence_skill(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.competence_skills%ROWTYPE;
BEGIN
  SELECT * INTO s FROM public.competence_skills WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(s.organisation_id) THEN RAISE EXCEPTION 'Skill not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_competence_manager(s.organisation_id);
  IF s.active THEN RAISE EXCEPTION 'That skill is not retired' USING ERRCODE = 'QM024'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.competence_categories c WHERE c.id = s.category_id AND c.active) THEN
    RAISE EXCEPTION 'Its category is switched off. Switch the category on or give the skill another category first.' USING ERRCODE = 'QM024';
  END IF;
  UPDATE public.competence_skills SET active = true, retired_reason = NULL, retired_at = NULL, retired_by = NULL WHERE id = s.id;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'An active skill called % already exists', s.name USING ERRCODE = 'QM024';
END $$;

-- Data keys present are set: code (create only), name, description (null clears).
CREATE FUNCTION app.save_competence_position(p_organisation_id uuid, p_data jsonb, p_id uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.competence_positions%ROWTYPE; k text; v_id uuid; v_code text; v_name text; v_desc text;
BEGIN
  PERFORM app.assert_competence_manager(p_organisation_id);
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Send the position as an object' USING ERRCODE = 'QM024'; END IF;
  FOR k IN SELECT jsonb_object_keys(p_data) LOOP
    IF k NOT IN ('code', 'name', 'description') THEN RAISE EXCEPTION 'Unknown field %', k USING ERRCODE = 'QM024'; END IF;
  END LOOP;
  IF p_id IS NOT NULL THEN
    SELECT * INTO s FROM public.competence_positions WHERE id = p_id AND organisation_id = p_organisation_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Position not found' USING ERRCODE = 'P0002'; END IF;
    IF NOT s.active THEN RAISE EXCEPTION 'A retired position cannot be edited. Bring it back first.' USING ERRCODE = 'QM024'; END IF;
    IF p_data ? 'code' AND upper(btrim(p_data ->> 'code')) IS DISTINCT FROM upper(s.code) THEN
      RAISE EXCEPTION 'The code of a position cannot change once it is created' USING ERRCODE = 'QM024';
    END IF;
  END IF;
  v_code := CASE WHEN p_id IS NULL THEN btrim(p_data ->> 'code') ELSE s.code END;
  v_name := CASE WHEN p_data ? 'name' THEN btrim(p_data ->> 'name') ELSE s.name END;
  v_desc := CASE WHEN p_data ? 'description' THEN nullif(btrim(p_data ->> 'description'), '') ELSE s.description END;
  IF v_code IS NULL OR length(v_code) = 0 THEN RAISE EXCEPTION 'Give the position a code' USING ERRCODE = 'QM024'; END IF;
  IF v_name IS NULL OR length(v_name) = 0 THEN RAISE EXCEPTION 'Give the position a name' USING ERRCODE = 'QM024'; END IF;
  IF p_id IS NULL THEN
    INSERT INTO public.competence_positions (organisation_id, code, name, description) VALUES (p_organisation_id, v_code, v_name, v_desc) RETURNING id INTO v_id;
  ELSE
    UPDATE public.competence_positions SET name = v_name, description = v_desc WHERE id = p_id;
    v_id := p_id;
  END IF;
  RETURN v_id;
EXCEPTION
  WHEN unique_violation THEN
    IF SQLERRM LIKE '%competence_positions_code_key%' THEN RAISE EXCEPTION 'A position with the code % already exists', v_code USING ERRCODE = 'QM024'; END IF;
    IF SQLERRM LIKE '%competence_positions_name_key%' THEN RAISE EXCEPTION 'A position called % already exists', v_name USING ERRCODE = 'QM024'; END IF;
    RAISE;
END $$;

CREATE FUNCTION app.retire_competence_position(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.competence_positions%ROWTYPE; v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  SELECT * INTO s FROM public.competence_positions WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(s.organisation_id) THEN RAISE EXCEPTION 'Position not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_competence_manager(s.organisation_id);
  IF NOT s.active THEN RAISE EXCEPTION 'That position is already retired' USING ERRCODE = 'QM024'; END IF;
  IF length(v_reason) < 3 THEN RAISE EXCEPTION 'Say why the position is retired (at least 3 characters)' USING ERRCODE = 'QM024'; END IF;
  UPDATE public.competence_positions SET active = false, retired_reason = left(v_reason, 500), retired_at = now(), retired_by = auth.uid() WHERE id = s.id;
END $$;

CREATE FUNCTION app.reactivate_competence_position(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.competence_positions%ROWTYPE;
BEGIN
  SELECT * INTO s FROM public.competence_positions WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(s.organisation_id) THEN RAISE EXCEPTION 'Position not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_competence_manager(s.organisation_id);
  IF s.active THEN RAISE EXCEPTION 'That position is not retired' USING ERRCODE = 'QM024'; END IF;
  IF EXISTS (SELECT 1 FROM public.competence_position_skills ps JOIN public.competence_skills k ON k.id = ps.skill_id WHERE ps.position_id = s.id AND NOT k.active) THEN
    RAISE EXCEPTION 'It requires a skill that has been retired. Edit its skills first.' USING ERRCODE = 'QM024';
  END IF;
  UPDATE public.competence_positions SET active = true, retired_reason = NULL, retired_at = NULL, retired_by = NULL WHERE id = s.id;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'An active position called % already exists', s.name USING ERRCODE = 'QM024';
END $$;

-- What the position requires, replaced as a whole: p_skills = [{skillId, requiredLevel 1-4}]. Every skill must be an active skill of the organisation, once.
CREATE FUNCTION app.set_position_skills(p_position uuid, p_skills jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.competence_positions%ROWTYPE; x record; v_seen uuid[] := ARRAY[]::uuid[];
BEGIN
  SELECT * INTO s FROM public.competence_positions WHERE id = p_position FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(s.organisation_id) THEN RAISE EXCEPTION 'Position not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_competence_manager(s.organisation_id);
  IF NOT s.active THEN RAISE EXCEPTION 'A retired position cannot be edited. Bring it back first.' USING ERRCODE = 'QM024'; END IF;
  IF jsonb_typeof(p_skills) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Send the skills as a list' USING ERRCODE = 'QM024'; END IF;
  IF jsonb_array_length(p_skills) > 200 THEN RAISE EXCEPTION 'A position can require at most 200 skills' USING ERRCODE = 'QM024'; END IF;
  FOR x IN SELECT (e ->> 'skillId')::uuid AS skill_id, (e ->> 'requiredLevel')::integer AS level FROM jsonb_array_elements(p_skills) e LOOP
    IF x.skill_id IS NULL OR x.level IS NULL OR x.level NOT BETWEEN 1 AND 4 THEN RAISE EXCEPTION 'Each skill needs a required level from 1 to 4' USING ERRCODE = 'QM024'; END IF;
    IF x.skill_id = ANY (v_seen) THEN RAISE EXCEPTION 'A skill can be listed once' USING ERRCODE = 'QM024'; END IF;
    v_seen := v_seen || x.skill_id;
    IF NOT EXISTS (SELECT 1 FROM public.competence_skills k WHERE k.id = x.skill_id AND k.organisation_id = s.organisation_id AND k.active) THEN
      RAISE EXCEPTION 'Choose active skills of this organisation' USING ERRCODE = 'QM024';
    END IF;
  END LOOP;
  DELETE FROM public.competence_position_skills WHERE position_id = s.id;
  INSERT INTO public.competence_position_skills (organisation_id, position_id, skill_id, required_level)
  SELECT s.organisation_id, s.id, (e ->> 'skillId')::uuid, (e ->> 'requiredLevel')::integer FROM jsonb_array_elements(p_skills) e;
  UPDATE public.competence_positions SET updated_at = now() WHERE id = s.id;
END $$;

REVOKE ALL ON FUNCTION app.assert_competence_manager(uuid), app.seed_competence_categories(uuid), app.seed_competence_categories_trg() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.save_competence_skill(uuid, jsonb, uuid), app.retire_competence_skill(uuid, text), app.reactivate_competence_skill(uuid),
  app.save_competence_position(uuid, jsonb, uuid), app.retire_competence_position(uuid, text), app.reactivate_competence_position(uuid),
  app.set_position_skills(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.save_competence_skill(uuid, jsonb, uuid), app.retire_competence_skill(uuid, text), app.reactivate_competence_skill(uuid),
  app.save_competence_position(uuid, jsonb, uuid), app.retire_competence_position(uuid, text), app.reactivate_competence_position(uuid),
  app.set_position_skills(uuid, jsonb) TO authenticated;
