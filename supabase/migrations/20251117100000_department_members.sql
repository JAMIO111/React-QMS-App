-- Department membership (DOC0, docs/documentation-plan.md §4): people belong to departments.
--
-- Until now a department was only a sub-unit of a site, and a person was "in" it only through a role assignment scoped to it.
-- This adds the membership itself, so "everyone in Goods-in" is a real, queryable group (used by quality alerts, DOC2).
--  * A person (membership) can be in several departments of the organisation; one is primary. A leaver from a department is
--    marked ended_at, never deleted, so the history stays.
--  * A role assignment scoped to a department requires an active membership of that department (QM011 -> 409 department_rule).
--    A department membership cannot be ended while a role scoped to that department is still assigned.
--  * Membership grants no access by itself and app.has_permission is unchanged: it only says who belongs where.
--  * Existing department-scoped role assignments are turned into memberships (first one per person is primary).
--  * Writes need members.manage and the same "cannot manage someone who outranks you" rule as role assignments.

CREATE TABLE public.department_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  department_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  joined_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT department_members_department_fkey FOREIGN KEY (department_id, organisation_id)
    REFERENCES public.departments (id, organisation_id) ON DELETE CASCADE,
  CONSTRAINT department_members_membership_fkey FOREIGN KEY (membership_id, organisation_id)
    REFERENCES public.organisation_users (id, organisation_id) ON DELETE CASCADE,
  CONSTRAINT department_members_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT department_members_primary_active CHECK (NOT (is_primary AND ended_at IS NOT NULL))
);
-- One active membership per person and department; at most one primary department per person.
CREATE UNIQUE INDEX department_members_active_key ON public.department_members (membership_id, department_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX department_members_primary_key ON public.department_members (membership_id) WHERE is_primary AND ended_at IS NULL;
CREATE INDEX department_members_department_idx ON public.department_members (organisation_id, department_id) WHERE ended_at IS NULL;

-- Existing department-scoped role assignments become memberships (the earliest per person is primary).
INSERT INTO public.department_members (organisation_id, department_id, membership_id, is_primary, joined_at)
SELECT organisation_id, department_id, membership_id, rn = 1, first_at
FROM (
  SELECT a.organisation_id, a.department_id, a.membership_id, min(a.created_at) AS first_at,
         row_number() OVER (PARTITION BY a.membership_id ORDER BY min(a.created_at), a.department_id) AS rn
  FROM public.user_role_assignments a
  WHERE a.department_id IS NOT NULL
  GROUP BY a.organisation_id, a.department_id, a.membership_id
) x;

CREATE FUNCTION app.department_member_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_status text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO v_status FROM public.organisation_users WHERE id = NEW.membership_id;
    IF v_status = 'removed' THEN
      RAISE EXCEPTION 'A removed member cannot be put in a department' USING ERRCODE = 'QM011';
    END IF;
    NEW.ended_at := NULL;
    IF NEW.is_primary THEN
      UPDATE public.department_members SET is_primary = false
       WHERE membership_id = NEW.membership_id AND is_primary AND ended_at IS NULL;
    ELSIF NOT EXISTS (SELECT 1 FROM public.department_members WHERE membership_id = NEW.membership_id AND is_primary AND ended_at IS NULL) THEN
      NEW.is_primary := true;   -- the first department is the primary one
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE (a change made by this function itself, to another row, needs no checking).
  IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;
  -- Only the primary flag and ending the membership can change; an ended membership stays ended.
  IF (to_jsonb(NEW) - ARRAY['is_primary', 'ended_at', 'updated_at', 'updated_by'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['is_primary', 'ended_at', 'updated_at', 'updated_by']) THEN
    RAISE EXCEPTION 'Only the primary flag and the end date of a department membership can change' USING ERRCODE = 'QM011';
  END IF;
  IF OLD.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'This department membership has ended; add the person again instead' USING ERRCODE = 'QM011';
  END IF;
  IF NEW.ended_at IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.user_role_assignments a WHERE a.membership_id = OLD.membership_id AND a.department_id = OLD.department_id) THEN
      RAISE EXCEPTION 'Remove the roles this person has in the department first' USING ERRCODE = 'QM011';
    END IF;
    NEW.is_primary := false;
    -- Another department becomes primary.
    UPDATE public.department_members SET is_primary = true
     WHERE id = (SELECT id FROM public.department_members
                  WHERE membership_id = OLD.membership_id AND ended_at IS NULL AND id <> OLD.id
                  ORDER BY joined_at, id LIMIT 1)
       AND OLD.is_primary;
  ELSIF NEW.is_primary AND NOT OLD.is_primary THEN
    UPDATE public.department_members SET is_primary = false
     WHERE membership_id = OLD.membership_id AND is_primary AND ended_at IS NULL AND id <> OLD.id;
  ELSIF NOT NEW.is_primary AND OLD.is_primary THEN
    RAISE EXCEPTION 'Choose another department as primary instead' USING ERRCODE = 'QM011';
  END IF;
  RETURN NEW;
END $$;

-- A role scoped to a department needs an active membership of it.
CREATE FUNCTION app.assignment_department_rule() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.department_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.department_members d
        WHERE d.membership_id = NEW.membership_id AND d.department_id = NEW.department_id AND d.ended_at IS NULL) THEN
    RAISE EXCEPTION 'Put the person in the department before giving them a role in it' USING ERRCODE = 'QM011';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER department_members_stamp BEFORE INSERT ON public.department_members FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER department_members_rules BEFORE INSERT OR UPDATE ON public.department_members FOR EACH ROW EXECUTE FUNCTION app.department_member_rules();
CREATE TRIGGER department_members_touch BEFORE UPDATE ON public.department_members FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER department_members_org_immutable BEFORE UPDATE ON public.department_members FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.department_members
  FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
CREATE TRIGGER assignment_department_rule BEFORE INSERT ON public.user_role_assignments
  FOR EACH ROW EXECUTE FUNCTION app.assignment_department_rule();

ALTER TABLE public.department_members ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.department_members FROM anon, authenticated;
GRANT SELECT, INSERT ON public.department_members TO authenticated;
GRANT UPDATE (is_primary, ended_at) ON public.department_members TO authenticated;
CREATE POLICY department_members_select ON public.department_members FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'members.read')
         OR EXISTS (SELECT 1 FROM public.organisation_users m WHERE m.id = membership_id AND m.user_id = auth.uid()));
CREATE POLICY department_members_insert ON public.department_members FOR INSERT TO authenticated
  WITH CHECK (app.has_permission(organisation_id, 'members.manage') AND app.can_manage_membership(membership_id));
CREATE POLICY department_members_update ON public.department_members FOR UPDATE TO authenticated
  USING (app.has_permission(organisation_id, 'members.manage') AND app.can_manage_membership(membership_id))
  WITH CHECK (app.has_permission(organisation_id, 'members.manage') AND app.can_manage_membership(membership_id));

REVOKE ALL ON FUNCTION app.department_member_rules(), app.assignment_department_rule() FROM PUBLIC, anon;

-- The member directory now lists each person's departments too.
DROP FUNCTION app.list_members(uuid);
CREATE FUNCTION app.list_members(p_organisation_id uuid)
RETURNS TABLE (
  membership_id uuid, user_id uuid, email text, first_name text, surname text, job_title text,
  status text, invited_email text, invited_at timestamptz, joined_at timestamptz, roles jsonb, departments jsonb
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT app.has_permission(p_organisation_id, 'members.read') THEN
    RAISE EXCEPTION 'members.read required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT m.id, m.user_id, coalesce(u.email::text, m.invited_email), p.first_name, p.surname, p.job_title,
         m.status, m.invited_email, m.invited_at, m.joined_at,
         coalesce((
           SELECT jsonb_agg(jsonb_build_object(
                    'assignmentId', a.id, 'roleId', r.id, 'roleKey', r.key, 'roleName', r.name,
                    'siteId', a.site_id, 'departmentId', a.department_id) ORDER BY r.name)
           FROM public.user_role_assignments a JOIN public.roles r ON r.id = a.role_id
           WHERE a.membership_id = m.id), '[]'::jsonb),
         coalesce((
           SELECT jsonb_agg(jsonb_build_object(
                    'id', dm.id, 'departmentId', d.id, 'code', d.code, 'name', d.name, 'siteId', d.site_id,
                    'siteName', s.name, 'isPrimary', dm.is_primary, 'joinedAt', dm.joined_at) ORDER BY dm.is_primary DESC, s.name, d.name)
           FROM public.department_members dm
           JOIN public.departments d ON d.id = dm.department_id
           JOIN public.sites s ON s.id = d.site_id
           WHERE dm.membership_id = m.id AND dm.ended_at IS NULL), '[]'::jsonb)
  FROM public.organisation_users m
  LEFT JOIN auth.users u ON u.id = m.user_id
  LEFT JOIN public.profiles p ON p.id = m.user_id
  WHERE m.organisation_id = p_organisation_id
  ORDER BY (m.status = 'removed'), lower(coalesce(p.surname, '')), lower(coalesce(p.first_name, '')), lower(coalesce(u.email::text, m.invited_email));
END $$;
REVOKE ALL ON FUNCTION app.list_members(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.list_members(uuid) TO authenticated;
