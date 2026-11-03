-- Phase 1 / slice 1.1 — tenancy core (docs/phase-1-plan.md §2)
--
-- Organisations, settings, sites, departments, user profiles, memberships, permissions, roles and
-- scoped role assignments, plus the private `app` helper functions used by RLS policies.
-- Backfill: the existing organisation keeps its id; every existing auth user becomes an active
-- member of their employee record's organisation (or the only organisation) with the Owner role.
-- RLS policies for these tables are added in 20251103100200_rls_lockdown.sql.

-- ---------------------------------------------------------------------------
-- Private helper schema (not exposed through the Supabase Data API)
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS app;
REVOKE ALL ON SCHEMA app FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO authenticated, service_role;

-- Maintains updated_at / updated_by on tables that have both columns.
CREATE FUNCTION app.touch_updated() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  NEW.updated_at := now();
  NEW.updated_by := auth.uid();
  RETURN NEW;
END $$;

-- Tenant-owned rows can never move between organisations.
CREATE FUNCTION app.prevent_organisation_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.organisation_id IS DISTINCT FROM OLD.organisation_id THEN
    RAISE EXCEPTION 'organisation_id cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION app.try_uuid(value text) RETURNS uuid
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
BEGIN
  RETURN value::uuid;
EXCEPTION WHEN invalid_text_representation THEN
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Organisations (renamed from "Organisations"; same ids)
-- ---------------------------------------------------------------------------
ALTER TABLE public."Organisations" RENAME TO organisations;
ALTER TABLE public.organisations RENAME CONSTRAINT "Organisations_pkey" TO organisations_pkey;

ALTER TABLE public.organisations
  ADD COLUMN slug text,
  ADD COLUMN status text NOT NULL DEFAULT 'active',
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN created_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  ADD COLUMN updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL;

UPDATE public.organisations SET
  name = coalesce(nullif(trim(name), ''), 'Organisation'),
  status = CASE WHEN active IS FALSE THEN 'suspended' ELSE 'active' END;

UPDATE public.organisations o SET slug = s.slug
FROM (
  SELECT id,
         coalesce(nullif(trim(BOTH '-' FROM lower(regexp_replace(name, '[^a-zA-Z0-9]+', '-', 'g'))), ''), 'org')
         || CASE WHEN row_number() OVER (PARTITION BY lower(regexp_replace(name, '[^a-zA-Z0-9]+', '-', 'g')) ORDER BY created_at) > 1
                 THEN '-' || row_number() OVER (PARTITION BY lower(regexp_replace(name, '[^a-zA-Z0-9]+', '-', 'g')) ORDER BY created_at)
                 ELSE '' END AS slug
  FROM public.organisations
) s
WHERE s.id = o.id;

ALTER TABLE public.organisations
  ALTER COLUMN name SET NOT NULL,
  ALTER COLUMN slug SET NOT NULL,
  ADD CONSTRAINT organisations_slug_key UNIQUE (slug),
  ADD CONSTRAINT organisations_slug_format CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  ADD CONSTRAINT organisations_status_check CHECK (status IN ('active', 'suspended')),
  ADD CONSTRAINT organisations_name_check CHECK (length(trim(name)) > 0);

CREATE TRIGGER organisations_touch BEFORE UPDATE ON public.organisations
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated();

-- ---------------------------------------------------------------------------
-- Organisation settings (moves base_currency / vat_rate off organisations)
-- ---------------------------------------------------------------------------
CREATE TABLE public.organisation_settings (
  organisation_id uuid PRIMARY KEY REFERENCES public.organisations (id) ON DELETE CASCADE,
  base_currency text NOT NULL DEFAULT 'GBP' CHECK (base_currency ~ '^[A-Z]{3}$'),
  vat_rate numeric(5, 4) NOT NULL DEFAULT 0.20 CHECK (vat_rate >= 0 AND vat_rate < 1),
  ncr_reference_prefix text NOT NULL DEFAULT 'NCM' CHECK (ncr_reference_prefix ~ '^[A-Z0-9]{1,10}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL
);

INSERT INTO public.organisation_settings (organisation_id, base_currency, vat_rate)
SELECT id, coalesce(upper(base_currency), 'GBP'), coalesce(vat_rate, 0.20) FROM public.organisations;

ALTER TABLE public.organisations
  DROP COLUMN active,
  DROP COLUMN base_currency,
  DROP COLUMN vat_rate;

CREATE TRIGGER organisation_settings_touch BEFORE UPDATE ON public.organisation_settings
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated();

-- ---------------------------------------------------------------------------
-- Sites and departments
-- ---------------------------------------------------------------------------
CREATE TABLE public.sites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  code text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  timezone text NOT NULL DEFAULT 'Europe/London',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT sites_org_code_key UNIQUE (organisation_id, code),
  CONSTRAINT sites_id_org_key UNIQUE (id, organisation_id)
);

CREATE TABLE public.departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  site_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT departments_site_fkey FOREIGN KEY (site_id, organisation_id)
    REFERENCES public.sites (id, organisation_id) ON DELETE CASCADE,
  CONSTRAINT departments_site_code_key UNIQUE (site_id, code),
  CONSTRAINT departments_id_org_key UNIQUE (id, organisation_id)
);
CREATE INDEX departments_organisation_id_idx ON public.departments (organisation_id);

CREATE TRIGGER sites_touch BEFORE UPDATE ON public.sites FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER sites_org_immutable BEFORE UPDATE ON public.sites FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER departments_touch BEFORE UPDATE ON public.departments FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER departments_org_immutable BEFORE UPDATE ON public.departments FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();

INSERT INTO public.sites (organisation_id, code, name, created_by)
SELECT id, 'MAIN', 'Main site', NULL FROM public.organisations;

-- ---------------------------------------------------------------------------
-- Profiles: one per login identity (not tenant-owned)
-- ---------------------------------------------------------------------------
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  first_name text,
  surname text,
  job_title text,
  avatar_path text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

CREATE TRIGGER profiles_touch BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION app.touch_updated();

INSERT INTO public.profiles (id, first_name, surname, job_title)
SELECT u.id, e.first_name, e.surname, e.job_title
FROM auth.users u
LEFT JOIN public."Employees" e ON e.auth_id = u.id;

-- New sign-ups get a profile automatically (names from sign-up metadata when supplied).
CREATE FUNCTION app.handle_new_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.profiles (id, first_name, surname)
  VALUES (NEW.id, NEW.raw_user_meta_data ->> 'first_name', NEW.raw_user_meta_data ->> 'surname')
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END $$;

CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION app.handle_new_user();

-- ---------------------------------------------------------------------------
-- Memberships
-- ---------------------------------------------------------------------------
CREATE TABLE public.organisation_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users (id) ON DELETE CASCADE,
  invited_email text,
  status text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'suspended', 'removed')),
  invited_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  invited_at timestamptz,
  joined_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT organisation_users_identity_check CHECK (user_id IS NOT NULL OR invited_email IS NOT NULL),
  CONSTRAINT organisation_users_active_has_user CHECK (status = 'invited' OR user_id IS NOT NULL),
  CONSTRAINT organisation_users_org_user_key UNIQUE (organisation_id, user_id),
  CONSTRAINT organisation_users_id_org_key UNIQUE (id, organisation_id)
);
CREATE UNIQUE INDEX organisation_users_pending_invite_key
  ON public.organisation_users (organisation_id, lower(invited_email)) WHERE status = 'invited';
CREATE INDEX organisation_users_user_status_idx ON public.organisation_users (user_id, status);

CREATE TRIGGER organisation_users_touch BEFORE UPDATE ON public.organisation_users FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER organisation_users_org_immutable BEFORE UPDATE ON public.organisation_users FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();

-- ---------------------------------------------------------------------------
-- Permissions, roles, role assignments
-- ---------------------------------------------------------------------------
CREATE TABLE public.permissions (
  code text PRIMARY KEY CHECK (code ~ '^[a-z_]+\.[a-z_]+$'),
  description text NOT NULL
);

INSERT INTO public.permissions (code, description) VALUES
  ('organisation.manage', 'Edit organisation settings, sites and departments'),
  ('members.read',        'View organisation members and their roles'),
  ('members.manage',      'Invite, suspend and reactivate members; assign roles'),
  ('roles.manage',        'Create and edit custom roles'),
  ('audit.read',          'View the quality audit trail'),
  ('lookups.manage',      'Manage statuses, failure modes and processes'),
  ('master_data.read',    'View parts, customers, suppliers and personnel'),
  ('master_data.manage',  'Create and edit parts, customers, suppliers and personnel'),
  ('ncr.read',            'View non-conformances'),
  ('ncr.create',          'Raise non-conformances'),
  ('ncr.update',          'Edit non-conformances'),
  ('ncr.delete',          'Delete non-conformances');

CREATE TABLE public.roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid REFERENCES public.organisations (id) ON DELETE CASCADE,  -- NULL = system template
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  name text NOT NULL,
  description text,
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT roles_org_key_key UNIQUE NULLS NOT DISTINCT (organisation_id, key),
  CONSTRAINT roles_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT roles_template_is_system CHECK (organisation_id IS NOT NULL OR is_system)
);
CREATE TRIGGER roles_touch BEFORE UPDATE ON public.roles FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER roles_org_immutable BEFORE UPDATE ON public.roles FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();

CREATE TABLE public.role_permissions (
  role_id uuid NOT NULL REFERENCES public.roles (id) ON DELETE CASCADE,
  permission_code text NOT NULL REFERENCES public.permissions (code) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_code)
);

CREATE TABLE public.user_role_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  membership_id uuid NOT NULL,
  role_id uuid NOT NULL,
  site_id uuid,
  department_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT ura_membership_fkey FOREIGN KEY (membership_id, organisation_id)
    REFERENCES public.organisation_users (id, organisation_id) ON DELETE CASCADE,
  CONSTRAINT ura_role_fkey FOREIGN KEY (role_id, organisation_id)
    REFERENCES public.roles (id, organisation_id) ON DELETE CASCADE,
  CONSTRAINT ura_site_fkey FOREIGN KEY (site_id, organisation_id)
    REFERENCES public.sites (id, organisation_id) ON DELETE CASCADE,
  CONSTRAINT ura_department_fkey FOREIGN KEY (department_id, organisation_id)
    REFERENCES public.departments (id, organisation_id) ON DELETE CASCADE,
  CONSTRAINT ura_unique UNIQUE NULLS NOT DISTINCT (membership_id, role_id, site_id, department_id)
);
CREATE INDEX ura_organisation_id_idx ON public.user_role_assignments (organisation_id);
CREATE INDEX ura_membership_id_idx ON public.user_role_assignments (membership_id);

-- System role templates (organisation_id NULL), copied into every organisation.
WITH t(key, name, description, perms) AS (VALUES
  ('owner', 'Owner', 'Full control of the organisation',
    ARRAY['organisation.manage','members.read','members.manage','roles.manage','audit.read','lookups.manage','master_data.read','master_data.manage','ncr.read','ncr.create','ncr.update','ncr.delete']),
  ('admin', 'Admin', 'Administers the organisation, sites and members',
    ARRAY['organisation.manage','members.read','members.manage','audit.read','lookups.manage','master_data.read','master_data.manage','ncr.read','ncr.create','ncr.update']),
  ('quality_manager', 'Quality manager', 'Owns quality processes and records',
    ARRAY['members.read','audit.read','lookups.manage','master_data.read','master_data.manage','ncr.read','ncr.create','ncr.update','ncr.delete']),
  ('quality_engineer', 'Quality engineer', 'Investigates and maintains quality records',
    ARRAY['members.read','master_data.read','master_data.manage','ncr.read','ncr.create','ncr.update']),
  ('inspector', 'Inspector', 'Records inspections and raises non-conformances',
    ARRAY['master_data.read','ncr.read','ncr.create']),
  ('viewer', 'Viewer', 'Read-only access',
    ARRAY['master_data.read','ncr.read'])
), ins AS (
  INSERT INTO public.roles (organisation_id, key, name, description, is_system)
  SELECT NULL, key, name, description, true FROM t
  RETURNING id, key
)
INSERT INTO public.role_permissions (role_id, permission_code)
SELECT ins.id, unnest(t.perms) FROM ins JOIN t USING (key);

-- Copies the system role templates (and their permissions) into an organisation.
CREATE FUNCTION app.create_default_roles(p_organisation_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  WITH ins AS (
    INSERT INTO public.roles (organisation_id, key, name, description, is_system)
    SELECT p_organisation_id, r.key, r.name, r.description, true
    FROM public.roles r WHERE r.organisation_id IS NULL
    ON CONFLICT (organisation_id, key) DO NOTHING
    RETURNING id, key
  )
  INSERT INTO public.role_permissions (role_id, permission_code)
  SELECT ins.id, rp.permission_code
  FROM ins
  JOIN public.roles tmpl ON tmpl.organisation_id IS NULL AND tmpl.key = ins.key
  JOIN public.role_permissions rp ON rp.role_id = tmpl.id;
END $$;
REVOKE ALL ON FUNCTION app.create_default_roles(uuid) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Access helpers used by RLS policies (SECURITY DEFINER: they read membership tables directly)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.is_member(p_organisation_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organisation_users m
    JOIN public.organisations o ON o.id = m.organisation_id AND o.status = 'active'
    WHERE m.organisation_id = p_organisation_id
      AND m.user_id = auth.uid()
      AND m.status = 'active'
  )
$$;

-- Organisation-wide check when p_site_id / p_department_id are NULL; scoped assignments only
-- count when checking that site or department.
CREATE FUNCTION app.has_permission(
  p_organisation_id uuid, p_permission text, p_site_id uuid DEFAULT NULL, p_department_id uuid DEFAULT NULL
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
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
  )
$$;

CREATE FUNCTION app.member_organisation_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT m.organisation_id
  FROM public.organisation_users m
  JOIN public.organisations o ON o.id = m.organisation_id AND o.status = 'active'
  WHERE m.user_id = auth.uid() AND m.status = 'active'
$$;

-- True when the caller and p_user_id are active members of at least one common organisation.
CREATE FUNCTION app.shares_organisation(p_user_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organisation_users mine
    JOIN public.organisation_users theirs
      ON theirs.organisation_id = mine.organisation_id AND theirs.status = 'active'
    JOIN public.organisations o ON o.id = mine.organisation_id AND o.status = 'active'
    WHERE mine.user_id = auth.uid() AND mine.status = 'active' AND theirs.user_id = p_user_id
  )
$$;

-- Caller's organisation-wide permissions.
CREATE FUNCTION app.my_permissions(p_organisation_id uuid) RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT DISTINCT rp.permission_code
  FROM public.organisation_users m
  JOIN public.organisations o ON o.id = m.organisation_id AND o.status = 'active'
  JOIN public.user_role_assignments a ON a.membership_id = m.id AND a.site_id IS NULL AND a.department_id IS NULL
  JOIN public.role_permissions rp ON rp.role_id = a.role_id
  WHERE m.organisation_id = p_organisation_id AND m.user_id = auth.uid() AND m.status = 'active'
$$;

-- No privilege escalation: a role can only be granted by someone who holds all of its permissions.
CREATE FUNCTION app.can_assign_role(p_organisation_id uuid, p_role_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT NOT EXISTS (
    SELECT rp.permission_code FROM public.role_permissions rp WHERE rp.role_id = p_role_id
    EXCEPT
    SELECT app.my_permissions(p_organisation_id)
  )
$$;

-- A member can only be managed by someone who holds every permission that member holds.
CREATE FUNCTION app.can_manage_membership(p_membership_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT NOT EXISTS (
    SELECT rp.permission_code
    FROM public.organisation_users m
    JOIN public.user_role_assignments a ON a.membership_id = m.id
    JOIN public.role_permissions rp ON rp.role_id = a.role_id
    WHERE m.id = p_membership_id
    EXCEPT
    SELECT app.my_permissions((SELECT organisation_id FROM public.organisation_users WHERE id = p_membership_id))
  )
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app.is_member(uuid), app.has_permission(uuid, text, uuid, uuid), app.member_organisation_ids(),
  app.shares_organisation(uuid), app.my_permissions(uuid), app.can_assign_role(uuid, uuid),
  app.can_manage_membership(uuid), app.try_uuid(text)
TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Every active organisation keeps at least one active Owner
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.assert_organisation_has_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_org uuid := coalesce(NEW.organisation_id, OLD.organisation_id);
BEGIN
  IF EXISTS (SELECT 1 FROM public.organisations WHERE id = v_org)
     AND NOT EXISTS (
       SELECT 1
       FROM public.organisation_users m
       JOIN public.user_role_assignments a ON a.membership_id = m.id AND a.site_id IS NULL AND a.department_id IS NULL
       JOIN public.roles r ON r.id = a.role_id AND r.key = 'owner' AND r.is_system
       WHERE m.organisation_id = v_org AND m.status = 'active'
     ) THEN
    RAISE EXCEPTION 'organisation % must keep at least one active owner', v_org
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER organisation_users_keep_owner
  AFTER UPDATE OF status OR DELETE ON public.organisation_users
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.assert_organisation_has_owner();
CREATE CONSTRAINT TRIGGER user_role_assignments_keep_owner
  AFTER DELETE ON public.user_role_assignments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.assert_organisation_has_owner();

-- ---------------------------------------------------------------------------
-- Backfill roles and memberships
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_org record;
  v_only_org uuid;
BEGIN
  FOR v_org IN SELECT id FROM public.organisations LOOP
    PERFORM app.create_default_roles(v_org.id);
  END LOOP;

  IF (SELECT count(*) FROM public.organisations) = 1 THEN
    SELECT id INTO v_only_org FROM public.organisations;
  END IF;

  -- Existing users join their employee record's organisation, or the only organisation.
  INSERT INTO public.organisation_users (organisation_id, user_id, status, joined_at)
  SELECT DISTINCT coalesce(e.organisation_id, v_only_org), u.id, 'active', now()
  FROM auth.users u
  LEFT JOIN public."Employees" e ON e.auth_id = u.id
  WHERE coalesce(e.organisation_id, v_only_org) IS NOT NULL;

  -- Existing users are the people who set the system up: they become Owners.
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id, created_by)
  SELECT m.organisation_id, m.id, r.id, NULL
  FROM public.organisation_users m
  JOIN public.roles r ON r.organisation_id = m.organisation_id AND r.key = 'owner';
END $$;

-- ---------------------------------------------------------------------------
-- Table privileges (row access is decided by RLS in 20251103100200_rls_lockdown.sql)
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.organisations, public.organisation_settings, public.sites, public.departments,
  public.profiles, public.organisation_users, public.permissions, public.roles, public.role_permissions,
  public.user_role_assignments FROM anon;
GRANT SELECT, UPDATE ON public.organisations, public.organisation_settings, public.profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.sites, public.departments, public.organisation_users TO authenticated;
GRANT SELECT ON public.permissions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.roles, public.role_permissions TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.user_role_assignments TO authenticated;
GRANT ALL ON public.organisations, public.organisation_settings, public.sites, public.departments,
  public.profiles, public.organisation_users, public.permissions, public.roles, public.role_permissions,
  public.user_role_assignments TO service_role;
