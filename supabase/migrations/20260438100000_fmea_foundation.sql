-- FMEA, slice FM1 (docs/fmea-plan.md): the module, its permissions and package rows, the FMEA record with its revisions, the team, the scope links, and the
-- lifecycle (submit, approve, send back, new revision, withdraw, settle). The analysis itself (structure, failure nets, ratings) comes with FM2 and FM3.
--
--  * Module fmea. Permissions fmea.read / fmea.manage / fmea.approve. Owner, admin and quality manager hold all three, quality engineer read + manage, inspector and viewer read.
--    Packages: Observer = view, Contributor = view, Controller = full (every permission is tied to a feature: supabase/tests/every_feature_priced.test.sql).
--  * fmeas: FMEA-NNN per organisation (app.pad_number), kind design | process, status draft (never in force) | active | withdrawn | discarded; the identity of an analysis.
--    fmea_revisions: sequence, a letter that is NULL until the revision is first submitted and never reused (A, B ... AA), status
--    draft -> pending_approval -> approved -> effective -> superseded | withdrawn, or discarded with a reason; one in progress per FMEA; the content is frozen once it leaves draft;
--    the preparer (author) can never approve; settling to effective needs no worker (run on read and by the API's housekeeping).
--  * fmea_team_members (an employee from the Employees register or a member, with a role, one lead) and fmea_links (what the analysis covers: parts, part families, control plans,
--    machines, operation codes, suppliers, customers), both replaced as a whole and only while the revision is a draft.
--  * Written only by SECURITY DEFINER functions. Errors QM036 (409 fmea_rule); another organisation's id is P0002 (404).

-- ---------------------------------------------------------------------------
-- 1. Module, permissions, packages
-- ---------------------------------------------------------------------------
INSERT INTO public.modules (slug, name, status, navigation_group, display_order) VALUES
  ('fmea', 'FMEA', 'active', 'Quality', 18)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.permissions (code, description) VALUES
  ('fmea.read',    'View design and process FMEAs'),
  ('fmea.manage',  'Prepare FMEAs: set the team and scope, analyse, rate, plan actions, and start revisions'),
  ('fmea.approve', 'Approve an FMEA revision, withdraw an FMEA, and change the FMEA rating model');

WITH grants(key, perms) AS (VALUES
  ('owner',            ARRAY['fmea.read', 'fmea.manage', 'fmea.approve']),
  ('admin',            ARRAY['fmea.read', 'fmea.manage', 'fmea.approve']),
  ('quality_manager',  ARRAY['fmea.read', 'fmea.manage', 'fmea.approve']),
  ('quality_engineer', ARRAY['fmea.read', 'fmea.manage']),
  ('inspector',        ARRAY['fmea.read']),
  ('viewer',           ARRAY['fmea.read'])
)
INSERT INTO public.role_permissions (role_id, permission_code)
SELECT r.id, unnest(g.perms) FROM public.roles r JOIN grants g ON g.key = r.key WHERE r.is_system
ON CONFLICT DO NOTHING;

INSERT INTO public.features (module_id, slug, name, min_access_level, permission_code)
SELECT m.id, f.slug, f.name, f.level, f.perm
  FROM (VALUES
    ('view_fmeas',    'View FMEAs',                         'view', 'fmea.read'),
    ('manage_fmeas',  'Prepare and manage FMEAs',           'full', 'fmea.manage'),
    ('approve_fmeas', 'Approve FMEAs and set the rating model', 'full', 'fmea.approve')
  ) AS f(slug, name, level, perm)
  JOIN public.modules m ON m.slug = 'fmea';

INSERT INTO public.subscription_entitlements (subscription_plan_id, module_id, access_level)
SELECT p.id, m.id, CASE WHEN p.slug = 'controller' THEN 'full' ELSE 'view' END
  FROM public.subscription_plans p CROSS JOIN public.modules m
 WHERE m.slug = 'fmea'
   AND NOT EXISTS (SELECT 1 FROM public.subscription_entitlements e WHERE e.subscription_plan_id = p.id AND e.module_id = m.id AND e.feature_id IS NULL);

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------
CREATE TABLE app.fmea_counters (
  organisation_id uuid PRIMARY KEY REFERENCES public.organisations (id) ON DELETE CASCADE,
  last_value integer NOT NULL DEFAULT 0
);
REVOKE ALL ON app.fmea_counters FROM PUBLIC, anon, authenticated;

CREATE TABLE public.fmeas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  number text NOT NULL CHECK (number ~ '^FMEA-[0-9]{3,}$'),
  kind text NOT NULL CHECK (kind IN ('design', 'process')),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  scope_text text CHECK (scope_text IS NULL OR length(btrim(scope_text)) BETWEEN 1 AND 2000),
  customer_id uuid,
  owner_user_id uuid NOT NULL REFERENCES auth.users (id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'withdrawn', 'discarded')),
  current_revision_id uuid,
  last_letter text CHECK (last_letter IS NULL OR last_letter ~ '^[A-Z]{1,4}$'),
  review_months integer CHECK (review_months IS NULL OR review_months BETWEEN 1 AND 120),
  next_review_on date,
  withdrawn_at timestamptz,
  withdrawn_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  withdraw_reason text CHECK (withdraw_reason IS NULL OR length(btrim(withdraw_reason)) BETWEEN 3 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT fmeas_number_key UNIQUE (organisation_id, number),
  CONSTRAINT fmeas_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT fmeas_customer_fkey FOREIGN KEY (customer_id, organisation_id) REFERENCES public.customers (id, organisation_id),
  CONSTRAINT fmeas_withdrawn_state CHECK ((status = 'withdrawn') = (withdraw_reason IS NOT NULL AND withdrawn_at IS NOT NULL))
);
CREATE INDEX fmeas_org_status_idx ON public.fmeas (organisation_id, status);
CREATE INDEX fmeas_owner_idx ON public.fmeas (organisation_id, owner_user_id);
CREATE INDEX fmeas_customer_idx ON public.fmeas (customer_id) WHERE customer_id IS NOT NULL;

CREATE TABLE public.fmea_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  fmea_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 1),
  letter text CHECK (letter IS NULL OR letter ~ '^[A-Z]{1,4}$'),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_approval', 'approved', 'effective', 'superseded', 'withdrawn', 'discarded')),
  author_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users (id),
  approver_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  change_summary text CHECK (change_summary IS NULL OR length(btrim(change_summary)) BETWEEN 1 AND 4000),
  previous_revision_id uuid REFERENCES public.fmea_revisions (id),
  submitted_at timestamptz,
  submitted_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  returned_comment text CHECK (returned_comment IS NULL OR length(btrim(returned_comment)) BETWEEN 3 AND 2000),
  returned_at timestamptz,
  returned_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  approval_comment text CHECK (approval_comment IS NULL OR length(approval_comment) <= 2000),
  approved_at timestamptz,
  approved_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  effective_from date,
  effective_at timestamptz,
  superseded_at timestamptz,
  superseded_by_id uuid REFERENCES public.fmea_revisions (id),
  withdrawn_at timestamptz,
  withdrawn_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  withdraw_reason text CHECK (withdraw_reason IS NULL OR length(btrim(withdraw_reason)) BETWEEN 3 AND 500),
  discarded_at timestamptz,
  discarded_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  discard_reason text CHECK (discard_reason IS NULL OR length(btrim(discard_reason)) BETWEEN 3 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT fmea_revisions_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT fmea_revisions_sequence_key UNIQUE (fmea_id, sequence),
  CONSTRAINT fmea_revisions_fmea_fkey FOREIGN KEY (fmea_id, organisation_id) REFERENCES public.fmeas (id, organisation_id),
  CONSTRAINT fmea_revisions_letter_given CHECK (status IN ('draft', 'discarded') OR letter IS NOT NULL),
  CONSTRAINT fmea_revisions_discard_state CHECK ((status = 'discarded') = (discard_reason IS NOT NULL AND discarded_at IS NOT NULL))
);
CREATE UNIQUE INDEX fmea_revisions_letter_key ON public.fmea_revisions (fmea_id, letter) WHERE letter IS NOT NULL;
CREATE UNIQUE INDEX fmea_revisions_one_open_key ON public.fmea_revisions (fmea_id) WHERE status IN ('draft', 'pending_approval', 'approved');
CREATE UNIQUE INDEX fmea_revisions_one_effective_key ON public.fmea_revisions (fmea_id) WHERE status = 'effective';
CREATE INDEX fmea_revisions_approver_idx ON public.fmea_revisions (organisation_id, approver_id) WHERE status = 'pending_approval';

ALTER TABLE public.fmeas
  ADD CONSTRAINT fmeas_current_revision_fkey FOREIGN KEY (current_revision_id, organisation_id) REFERENCES public.fmea_revisions (id, organisation_id);

CREATE TABLE public.fmea_team_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  revision_id uuid NOT NULL,
  employee_id uuid,
  user_id uuid REFERENCES auth.users (id),
  role text NOT NULL CHECK (role IN ('lead', 'design', 'process', 'quality', 'manufacturing', 'purchasing', 'supplier', 'customer', 'other')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT fmea_team_members_revision_fkey FOREIGN KEY (revision_id, organisation_id) REFERENCES public.fmea_revisions (id, organisation_id),
  CONSTRAINT fmea_team_members_employee_fkey FOREIGN KEY (employee_id, organisation_id) REFERENCES public."Employees" (id, organisation_id),
  CONSTRAINT fmea_team_members_one_person CHECK (num_nonnulls(employee_id, user_id) = 1)
);
CREATE UNIQUE INDEX fmea_team_members_employee_key ON public.fmea_team_members (revision_id, employee_id) WHERE employee_id IS NOT NULL;
CREATE UNIQUE INDEX fmea_team_members_user_key ON public.fmea_team_members (revision_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX fmea_team_members_lead_key ON public.fmea_team_members (revision_id) WHERE role = 'lead';
CREATE INDEX fmea_team_members_revision_idx ON public.fmea_team_members (organisation_id, revision_id);

CREATE TABLE public.fmea_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  revision_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('part', 'part_family', 'control_plan', 'machine', 'supplier', 'customer', 'operation_code')),
  part_id uuid,
  part_family_id uuid,
  control_plan_id uuid,
  machine_id uuid,
  supplier_id uuid,
  customer_id uuid,
  operation_code text CHECK (operation_code IS NULL OR (length(btrim(operation_code)) BETWEEN 1 AND 40 AND operation_code = btrim(operation_code))),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT fmea_links_revision_fkey FOREIGN KEY (revision_id, organisation_id) REFERENCES public.fmea_revisions (id, organisation_id),
  CONSTRAINT fmea_links_part_fkey FOREIGN KEY (part_id, organisation_id) REFERENCES public.parts (id, organisation_id),
  CONSTRAINT fmea_links_family_fkey FOREIGN KEY (part_family_id, organisation_id) REFERENCES public.part_families (id, organisation_id),
  CONSTRAINT fmea_links_plan_fkey FOREIGN KEY (control_plan_id, organisation_id) REFERENCES public.control_plans (id, organisation_id),
  CONSTRAINT fmea_links_machine_fkey FOREIGN KEY (machine_id, organisation_id) REFERENCES public.machines (id, organisation_id),
  CONSTRAINT fmea_links_supplier_fkey FOREIGN KEY (supplier_id, organisation_id) REFERENCES public.suppliers (id, organisation_id),
  CONSTRAINT fmea_links_customer_fkey FOREIGN KEY (customer_id, organisation_id) REFERENCES public.customers (id, organisation_id),
  CONSTRAINT fmea_links_target_check CHECK (
    num_nonnulls(part_id, part_family_id, control_plan_id, machine_id, supplier_id, customer_id, operation_code) = 1
    AND CASE kind
      WHEN 'part' THEN part_id IS NOT NULL WHEN 'part_family' THEN part_family_id IS NOT NULL WHEN 'control_plan' THEN control_plan_id IS NOT NULL
      WHEN 'machine' THEN machine_id IS NOT NULL WHEN 'supplier' THEN supplier_id IS NOT NULL WHEN 'customer' THEN customer_id IS NOT NULL
      ELSE operation_code IS NOT NULL END)
);
CREATE UNIQUE INDEX fmea_links_target_key ON public.fmea_links (revision_id, kind,
  coalesce(part_id, part_family_id, control_plan_id, machine_id, supplier_id, customer_id, '00000000-0000-0000-0000-000000000000'::uuid),
  upper(coalesce(operation_code, '')));
CREATE INDEX fmea_links_revision_idx ON public.fmea_links (organisation_id, revision_id);
CREATE INDEX fmea_links_part_idx ON public.fmea_links (part_id) WHERE part_id IS NOT NULL;
CREATE INDEX fmea_links_family_idx ON public.fmea_links (part_family_id) WHERE part_family_id IS NOT NULL;
CREATE INDEX fmea_links_plan_idx ON public.fmea_links (control_plan_id) WHERE control_plan_id IS NOT NULL;
CREATE INDEX fmea_links_machine_idx ON public.fmea_links (machine_id) WHERE machine_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Rules the tables hold even for SQL
-- ---------------------------------------------------------------------------
-- An FMEA is never deleted; its number, kind and organisation never change; a discarded one is final.
CREATE FUNCTION app.fmea_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'An FMEA is never deleted. Discard a draft or withdraw it with a reason.' USING ERRCODE = 'QM036'; END IF;
  IF (NEW.number, NEW.kind) IS DISTINCT FROM (OLD.number, OLD.kind) THEN RAISE EXCEPTION 'An FMEA''s number and kind never change' USING ERRCODE = 'QM036'; END IF;
  IF OLD.status = 'discarded' THEN RAISE EXCEPTION '% is discarded and cannot be changed', OLD.number USING ERRCODE = 'QM036'; END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status IN ('active', 'discarded'))
    OR (OLD.status = 'active' AND NEW.status = 'withdrawn')
    OR (OLD.status = 'withdrawn' AND NEW.status = 'active')) THEN
    RAISE EXCEPTION 'An FMEA cannot move from % to %', OLD.status, NEW.status USING ERRCODE = 'QM036';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fmeas_rules BEFORE UPDATE OR DELETE ON public.fmeas FOR EACH ROW EXECUTE FUNCTION app.fmea_rules();

-- A revision is never deleted; its FMEA, sequence and author never change; the letter never changes once given; only a draft's content changes; an approved or
-- effective revision is frozen; and the status moves only along the lifecycle.
CREATE FUNCTION app.fmea_revision_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A revision is never deleted. Discard a draft with a reason.' USING ERRCODE = 'QM036'; END IF;
  IF (NEW.fmea_id, NEW.sequence, NEW.author_id) IS DISTINCT FROM (OLD.fmea_id, OLD.sequence, OLD.author_id) THEN
    RAISE EXCEPTION 'A revision''s FMEA, sequence and author never change' USING ERRCODE = 'QM036';
  END IF;
  IF OLD.letter IS NOT NULL AND NEW.letter IS DISTINCT FROM OLD.letter THEN RAISE EXCEPTION 'A revision letter never changes' USING ERRCODE = 'QM036'; END IF;
  IF OLD.status <> 'draft' AND (NEW.change_summary, NEW.approver_id, NEW.previous_revision_id) IS DISTINCT FROM (OLD.change_summary, OLD.approver_id, OLD.previous_revision_id) THEN
    RAISE EXCEPTION 'Only a draft''s content can change' USING ERRCODE = 'QM036';
  END IF;
  IF OLD.status IN ('discarded', 'superseded', 'withdrawn') THEN RAISE EXCEPTION 'A % revision cannot be changed', OLD.status USING ERRCODE = 'QM036'; END IF;
  IF OLD.status IN ('approved', 'effective') AND (NEW.effective_from, NEW.approved_at, NEW.approved_by) IS DISTINCT FROM (OLD.effective_from, OLD.approved_at, OLD.approved_by) THEN
    RAISE EXCEPTION 'An approved revision is frozen' USING ERRCODE = 'QM036';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status IN ('pending_approval', 'discarded'))
    OR (OLD.status = 'pending_approval' AND NEW.status IN ('draft', 'approved'))
    OR (OLD.status = 'approved' AND NEW.status IN ('effective', 'withdrawn'))
    OR (OLD.status = 'effective' AND NEW.status IN ('superseded', 'withdrawn'))) THEN
    RAISE EXCEPTION 'A revision cannot move from % to %', replace(OLD.status, '_', ' '), replace(NEW.status, '_', ' ') USING ERRCODE = 'QM036';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fmea_revisions_rules BEFORE UPDATE OR DELETE ON public.fmea_revisions FOR EACH ROW EXECUTE FUNCTION app.fmea_revision_rules();

-- The team and the scope follow their revision: only while it is a draft, and a row is replaced, never edited.
CREATE FUNCTION app.fmea_child_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_status text;
BEGIN
  SELECT status INTO v_status FROM public.fmea_revisions WHERE id = coalesce(NEW.revision_id, OLD.revision_id);
  IF v_status IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'The team and the scope change only while the revision is a draft' USING ERRCODE = 'QM036'; END IF;
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'Replace the list instead of changing one row' USING ERRCODE = 'QM036'; END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER fmea_team_members_rules BEFORE INSERT OR UPDATE OR DELETE ON public.fmea_team_members FOR EACH ROW EXECUTE FUNCTION app.fmea_child_rules();
CREATE TRIGGER fmea_links_rules BEFORE INSERT OR UPDATE OR DELETE ON public.fmea_links FOR EACH ROW EXECUTE FUNCTION app.fmea_child_rules();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fmeas', 'fmea_revisions', 'fmea_team_members', 'fmea_links'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION app.stamp_created()', t || '_stamp', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.touch_updated()', t || '_touch', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change()', t || '_org_immutable', t);
    EXECUTE format('CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION audit.record_change(''organisation_id'')', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Reading: managers read everything; the preparer, the owner and the named approver read what they are on; everyone with fmea.read reads what has been approved
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.fmea_revision_readable(p_revision uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.fmea_revisions r JOIN public.fmeas f ON f.id = r.fmea_id
     WHERE r.id = p_revision AND app.is_member(r.organisation_id)
       AND (app.has_permission(r.organisation_id, 'fmea.manage')
            OR r.author_id = auth.uid() OR f.owner_user_id = auth.uid() OR r.approver_id = auth.uid()
            OR (r.status IN ('approved', 'effective', 'superseded', 'withdrawn') AND app.has_permission(r.organisation_id, 'fmea.read'))))
$$;

CREATE FUNCTION app.fmea_readable(p_fmea uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.fmeas f
     WHERE f.id = p_fmea AND app.is_member(f.organisation_id)
       AND (app.has_permission(f.organisation_id, 'fmea.manage') OR f.owner_user_id = auth.uid()
            OR (f.status IN ('active', 'withdrawn') AND app.has_permission(f.organisation_id, 'fmea.read'))
            OR EXISTS (SELECT 1 FROM public.fmea_revisions r WHERE r.fmea_id = f.id AND (r.author_id = auth.uid() OR r.approver_id = auth.uid()))))
$$;

CREATE POLICY fmeas_select ON public.fmeas FOR SELECT TO authenticated USING (app.fmea_readable(id));
CREATE POLICY fmea_revisions_select ON public.fmea_revisions FOR SELECT TO authenticated USING (app.fmea_revision_readable(id));
CREATE POLICY fmea_team_members_select ON public.fmea_team_members FOR SELECT TO authenticated USING (app.fmea_revision_readable(revision_id));
CREATE POLICY fmea_links_select ON public.fmea_links FOR SELECT TO authenticated USING (app.fmea_revision_readable(revision_id));

-- ---------------------------------------------------------------------------
-- 5. Functions (SECURITY DEFINER): the only way to write an FMEA
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.assert_fmea_manager(p_organisation_id uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT app.is_member(p_organisation_id) THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(p_organisation_id, 'fmea.manage') THEN RAISE EXCEPTION 'You are not allowed to prepare FMEAs' USING ERRCODE = '42501'; END IF;
END $$;

-- Locks an FMEA for writing and checks the caller may manage FMEAs in its organisation.
CREATE FUNCTION app.fmea_for_write(p_fmea uuid) RETURNS public.fmeas
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE f public.fmeas%ROWTYPE;
BEGIN
  SELECT * INTO f FROM public.fmeas WHERE id = p_fmea FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(f.organisation_id) THEN RAISE EXCEPTION 'FMEA not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_fmea_manager(f.organisation_id);
  RETURN f;
END $$;

-- Locks a revision for writing its content: the caller manages FMEAs and the revision is a draft.
CREATE FUNCTION app.fmea_draft_for_update(p_revision uuid) RETURNS public.fmea_revisions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.fmea_revisions%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.fmea_revisions WHERE id = p_revision FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(r.organisation_id) THEN RAISE EXCEPTION 'Revision not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_fmea_manager(r.organisation_id);
  IF r.status <> 'draft' THEN RAISE EXCEPTION 'This revision is % and can no longer be edited', replace(r.status, '_', ' ') USING ERRCODE = 'QM036'; END IF;
  RETURN r;
END $$;

-- Replaces the team of a draft. Items: {employeeId | userId, role}. One lead at most; people are unique.
CREATE FUNCTION app.set_fmea_team(p_revision uuid, p_team jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.fmea_revisions%ROWTYPE; e jsonb; v_emp uuid; v_user uuid; v_role text;
BEGIN
  r := app.fmea_draft_for_update(p_revision);
  IF jsonb_typeof(coalesce(p_team, '[]'::jsonb)) <> 'array' THEN RAISE EXCEPTION 'Send the team as a list' USING ERRCODE = 'QM036'; END IF;
  IF jsonb_array_length(coalesce(p_team, '[]'::jsonb)) > 50 THEN RAISE EXCEPTION 'A team has at most 50 people' USING ERRCODE = 'QM036'; END IF;
  DELETE FROM public.fmea_team_members WHERE revision_id = r.id;
  FOR e IN SELECT * FROM jsonb_array_elements(coalesce(p_team, '[]'::jsonb)) LOOP
    v_role := coalesce(e ->> 'role', 'other');
    IF v_role NOT IN ('lead', 'design', 'process', 'quality', 'manufacturing', 'purchasing', 'supplier', 'customer', 'other') THEN
      RAISE EXCEPTION 'Unknown team role %', v_role USING ERRCODE = 'QM036';
    END IF;
    BEGIN v_emp := nullif(e ->> 'employeeId', '')::uuid; v_user := nullif(e ->> 'userId', '')::uuid;
    EXCEPTION WHEN others THEN RAISE EXCEPTION 'A team member names a person by id' USING ERRCODE = 'QM036'; END;
    IF num_nonnulls(v_emp, v_user) <> 1 THEN RAISE EXCEPTION 'Each team member is an employee or a member' USING ERRCODE = 'QM036'; END IF;
    IF v_emp IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public."Employees" x WHERE x.id = v_emp AND x.organisation_id = r.organisation_id AND x.active) THEN
      RAISE EXCEPTION 'The team can name only active employees of this organisation' USING ERRCODE = 'QM036';
    END IF;
    IF v_user IS NOT NULL AND NOT app.is_active_member_user(r.organisation_id, v_user) THEN
      RAISE EXCEPTION 'The team can name only active members of this organisation' USING ERRCODE = 'QM036';
    END IF;
    BEGIN
      INSERT INTO public.fmea_team_members (organisation_id, revision_id, employee_id, user_id, role) VALUES (r.organisation_id, r.id, v_emp, v_user, v_role);
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'A person is on the team once, and there is one lead' USING ERRCODE = 'QM036';
    END;
  END LOOP;
  UPDATE public.fmea_revisions SET updated_at = now() WHERE id = r.id;
END $$;

-- Replaces what a draft covers. Items: {kind, id} or {kind: 'operation_code', code}. Duplicates are dropped.
CREATE FUNCTION app.set_fmea_links(p_revision uuid, p_links jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.fmea_revisions%ROWTYPE; e jsonb; v_kind text; v_id uuid; v_code text;
BEGIN
  r := app.fmea_draft_for_update(p_revision);
  IF jsonb_typeof(coalesce(p_links, '[]'::jsonb)) <> 'array' THEN RAISE EXCEPTION 'Send the links as a list' USING ERRCODE = 'QM036'; END IF;
  IF jsonb_array_length(coalesce(p_links, '[]'::jsonb)) > 100 THEN RAISE EXCEPTION 'An FMEA covers at most 100 things' USING ERRCODE = 'QM036'; END IF;
  DELETE FROM public.fmea_links WHERE revision_id = r.id;
  FOR e IN SELECT * FROM jsonb_array_elements(coalesce(p_links, '[]'::jsonb)) LOOP
    v_kind := e ->> 'kind';
    IF v_kind IS NULL OR v_kind NOT IN ('part', 'part_family', 'control_plan', 'machine', 'supplier', 'customer', 'operation_code') THEN
      RAISE EXCEPTION 'An FMEA covers parts, part families, control plans, machines, suppliers, customers or operations' USING ERRCODE = 'QM036';
    END IF;
    IF v_kind = 'operation_code' THEN
      v_code := btrim(coalesce(e ->> 'code', ''));
      IF length(v_code) NOT BETWEEN 1 AND 40 THEN RAISE EXCEPTION 'An operation code is 1 to 40 characters' USING ERRCODE = 'QM036'; END IF;
      INSERT INTO public.fmea_links (organisation_id, revision_id, kind, operation_code) VALUES (r.organisation_id, r.id, v_kind, v_code) ON CONFLICT DO NOTHING;
    ELSE
      BEGIN v_id := (e ->> 'id')::uuid; EXCEPTION WHEN others THEN v_id := NULL; END;
      IF v_id IS NULL THEN RAISE EXCEPTION 'Each link names the record it is to' USING ERRCODE = 'QM036'; END IF;
      BEGIN
        EXECUTE format('INSERT INTO public.fmea_links (organisation_id, revision_id, kind, %I) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', v_kind || '_id')
          USING r.organisation_id, r.id, v_kind, v_id;
      EXCEPTION WHEN foreign_key_violation THEN
        RAISE EXCEPTION 'That % is not in this organisation', replace(v_kind, '_', ' ') USING ERRCODE = 'QM036';
      END;
    END IF;
  END LOOP;
  UPDATE public.fmea_revisions SET updated_at = now() WHERE id = r.id;
END $$;

-- Keys: kind, title, scopeText, customerId, ownerId (default the caller), reviewMonths, team [..], links [..]. Makes the FMEA and its first draft revision.
CREATE FUNCTION app.create_fmea(p_organisation_id uuid, p_data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE k text; v_n integer; v_id uuid; v_rev uuid; v_kind text; v_title text; v_owner uuid; v_customer uuid; v_months integer;
BEGIN
  PERFORM app.assert_fmea_manager(p_organisation_id);
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Send the FMEA as an object' USING ERRCODE = 'QM036'; END IF;
  FOR k IN SELECT jsonb_object_keys(p_data) LOOP
    IF k NOT IN ('kind', 'title', 'scopeText', 'customerId', 'ownerId', 'reviewMonths', 'team', 'links') THEN RAISE EXCEPTION 'Unknown field %', k USING ERRCODE = 'QM036'; END IF;
  END LOOP;
  v_kind := p_data ->> 'kind';
  IF v_kind IS NULL OR v_kind NOT IN ('design', 'process') THEN RAISE EXCEPTION 'An FMEA is a design FMEA or a process FMEA' USING ERRCODE = 'QM036'; END IF;
  v_title := btrim(coalesce(p_data ->> 'title', ''));
  IF length(v_title) = 0 THEN RAISE EXCEPTION 'Give the FMEA a title' USING ERRCODE = 'QM036'; END IF;
  IF length(v_title) > 200 THEN RAISE EXCEPTION 'The title is up to 200 characters' USING ERRCODE = 'QM036'; END IF;
  v_owner := coalesce(nullif(p_data ->> 'ownerId', '')::uuid, auth.uid());
  IF NOT app.is_active_member_user(p_organisation_id, v_owner) THEN RAISE EXCEPTION 'The owner must be an active member of this organisation' USING ERRCODE = 'QM036'; END IF;
  v_customer := nullif(p_data ->> 'customerId', '')::uuid;
  IF v_customer IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.customers c WHERE c.id = v_customer AND c.organisation_id = p_organisation_id) THEN
    RAISE EXCEPTION 'That customer is not in this organisation' USING ERRCODE = 'QM036';
  END IF;
  v_months := nullif(p_data ->> 'reviewMonths', '')::integer;
  IF v_months IS NOT NULL AND v_months NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION 'Review every 1 to 120 months' USING ERRCODE = 'QM036'; END IF;
  INSERT INTO app.fmea_counters AS c (organisation_id, last_value) VALUES (p_organisation_id, 1)
  ON CONFLICT (organisation_id) DO UPDATE SET last_value = c.last_value + 1 RETURNING last_value INTO v_n;
  INSERT INTO public.fmeas (organisation_id, number, kind, title, scope_text, customer_id, owner_user_id, review_months)
  VALUES (p_organisation_id, 'FMEA-' || app.pad_number(v_n, 3), v_kind, v_title, nullif(btrim(coalesce(p_data ->> 'scopeText', '')), ''), v_customer, v_owner, v_months)
  RETURNING id INTO v_id;
  INSERT INTO public.fmea_revisions (organisation_id, fmea_id, sequence) VALUES (p_organisation_id, v_id, 1) RETURNING id INTO v_rev;
  IF p_data ? 'team' THEN PERFORM app.set_fmea_team(v_rev, p_data -> 'team'); END IF;
  IF p_data ? 'links' THEN PERFORM app.set_fmea_links(v_rev, p_data -> 'links'); END IF;
  RETURN v_id;
END $$;

-- Keys present are set: title, scopeText (null clears), customerId (null clears), ownerId, reviewMonths (null = the default). Never the kind or number.
CREATE FUNCTION app.update_fmea(p_fmea uuid, p_data jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE f public.fmeas%ROWTYPE; k text; v_title text; v_owner uuid; v_customer uuid; v_months integer;
BEGIN
  f := app.fmea_for_write(p_fmea);
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Send the changes as an object' USING ERRCODE = 'QM036'; END IF;
  FOR k IN SELECT jsonb_object_keys(p_data) LOOP
    IF k NOT IN ('title', 'scopeText', 'customerId', 'ownerId', 'reviewMonths') THEN RAISE EXCEPTION 'Unknown field %', k USING ERRCODE = 'QM036'; END IF;
  END LOOP;
  v_title := CASE WHEN p_data ? 'title' THEN btrim(coalesce(p_data ->> 'title', '')) ELSE f.title END;
  IF length(v_title) = 0 THEN RAISE EXCEPTION 'Give the FMEA a title' USING ERRCODE = 'QM036'; END IF;
  IF length(v_title) > 200 THEN RAISE EXCEPTION 'The title is up to 200 characters' USING ERRCODE = 'QM036'; END IF;
  v_owner := CASE WHEN p_data ? 'ownerId' THEN nullif(p_data ->> 'ownerId', '')::uuid ELSE f.owner_user_id END;
  IF v_owner IS NULL OR (v_owner IS DISTINCT FROM f.owner_user_id AND NOT app.is_active_member_user(f.organisation_id, v_owner)) THEN
    RAISE EXCEPTION 'The owner must be an active member of this organisation' USING ERRCODE = 'QM036';
  END IF;
  v_customer := CASE WHEN p_data ? 'customerId' THEN nullif(p_data ->> 'customerId', '')::uuid ELSE f.customer_id END;
  IF v_customer IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.customers c WHERE c.id = v_customer AND c.organisation_id = f.organisation_id) THEN
    RAISE EXCEPTION 'That customer is not in this organisation' USING ERRCODE = 'QM036';
  END IF;
  v_months := CASE WHEN p_data ? 'reviewMonths' THEN nullif(p_data ->> 'reviewMonths', '')::integer ELSE f.review_months END;
  IF v_months IS NOT NULL AND v_months NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION 'Review every 1 to 120 months' USING ERRCODE = 'QM036'; END IF;
  UPDATE public.fmeas SET title = v_title, owner_user_id = v_owner, customer_id = v_customer, review_months = v_months,
    scope_text = CASE WHEN p_data ? 'scopeText' THEN nullif(btrim(coalesce(p_data ->> 'scopeText', '')), '') ELSE scope_text END,
    next_review_on = CASE WHEN v_months IS DISTINCT FROM f.review_months AND f.status = 'active' AND f.current_revision_id IS NOT NULL
                          THEN (SELECT effective_from FROM public.fmea_revisions WHERE id = f.current_revision_id) + (coalesce(v_months, 12) || ' months')::interval
                          ELSE next_review_on END
  WHERE id = f.id;
END $$;

-- The wording of a draft revision: what changed and why (needed once the FMEA has been in force).
CREATE FUNCTION app.update_fmea_revision(p_revision uuid, p_data jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.fmea_revisions%ROWTYPE; k text;
BEGIN
  r := app.fmea_draft_for_update(p_revision);
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Send the changes as an object' USING ERRCODE = 'QM036'; END IF;
  FOR k IN SELECT jsonb_object_keys(p_data) LOOP
    IF k NOT IN ('changeSummary') THEN RAISE EXCEPTION 'Unknown field %', k USING ERRCODE = 'QM036'; END IF;
  END LOOP;
  IF p_data ? 'changeSummary' THEN
    UPDATE public.fmea_revisions SET change_summary = left(nullif(btrim(coalesce(p_data ->> 'changeSummary', '')), ''), 4000) WHERE id = r.id;
  END IF;
END $$;

-- Names who will approve it: an active member who holds fmea.approve and is not the preparer.
CREATE FUNCTION app.set_fmea_approver(p_revision uuid, p_approver uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.fmea_revisions%ROWTYPE;
BEGIN
  r := app.fmea_draft_for_update(p_revision);
  IF p_approver IS NOT NULL THEN
    IF p_approver = r.author_id THEN RAISE EXCEPTION 'The preparer cannot approve their own revision' USING ERRCODE = 'QM036'; END IF;
    IF NOT app.is_active_member_user(r.organisation_id, p_approver) THEN RAISE EXCEPTION 'The approver must be an active member of this organisation' USING ERRCODE = 'QM036'; END IF;
    IF NOT app.member_may(r.organisation_id, p_approver, 'fmea.approve') THEN RAISE EXCEPTION 'That person cannot approve FMEAs' USING ERRCODE = 'QM036'; END IF;
  END IF;
  UPDATE public.fmea_revisions SET approver_id = p_approver WHERE id = r.id;
END $$;

-- Who may be named on the team or as approver: active members. `can_approve` = holds fmea.approve now (the check that counts is made again, as the approver, when they approve).
CREATE FUNCTION app.fmea_people(p_organisation_id uuid) RETURNS TABLE (user_id uuid, name text, can_approve boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT ou.user_id, coalesce(nullif(btrim(concat_ws(' ', p.first_name, p.surname)), ''), 'Unnamed'), app.member_may(p_organisation_id, ou.user_id, 'fmea.approve')
    FROM public.organisation_users ou LEFT JOIN public.profiles p ON p.id = ou.user_id
   WHERE ou.organisation_id = p_organisation_id AND ou.status = 'active' AND app.has_permission(p_organisation_id, 'fmea.read')
   ORDER BY 2
$$;

-- What a draft still needs before it can be submitted (also shown by the API). FM3 adds the rules of the analysis itself.
CREATE FUNCTION app.fmea_revision_problems(p_revision uuid) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.fmea_revisions%ROWTYPE; f public.fmeas%ROWTYPE; v text[] := ARRAY[]::text[];
BEGIN
  SELECT * INTO r FROM public.fmea_revisions WHERE id = p_revision;
  IF NOT FOUND OR r.status <> 'draft' THEN RETURN v; END IF;
  IF NOT app.fmea_revision_readable(r.id) THEN RETURN v; END IF;
  SELECT * INTO f FROM public.fmeas WHERE id = r.fmea_id;
  IF NOT EXISTS (SELECT 1 FROM public.fmea_team_members WHERE revision_id = r.id AND role = 'lead') THEN v := v || 'Name the team lead'::text; END IF;
  IF (SELECT count(*) FROM public.fmea_team_members WHERE revision_id = r.id) < 2 THEN v := v || 'A team is more than one person: add the rest of the team'::text; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.fmea_links WHERE revision_id = r.id) THEN v := v || 'Say what the FMEA covers (a part, family, control plan, machine or operation)'::text; END IF;
  IF f.status IN ('active', 'withdrawn') AND r.change_summary IS NULL THEN v := v || 'Say what changed and why'::text; END IF;
  IF r.approver_id IS NULL THEN v := v || 'Name the approver'::text; END IF;
  IF r.approver_id IS NOT NULL AND NOT app.is_active_member_user(r.organisation_id, r.approver_id) THEN v := v || 'The approver is no longer an active member'::text; END IF;
  IF EXISTS (SELECT 1 FROM public.fmea_team_members m WHERE m.revision_id = r.id AND m.user_id IS NOT NULL AND NOT app.is_active_member_user(r.organisation_id, m.user_id)) THEN
    v := v || 'A team member is no longer an active member'::text;
  END IF;
  RETURN v;
END $$;

CREATE FUNCTION app.submit_fmea_revision(p_revision uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.fmea_revisions%ROWTYPE; f public.fmeas%ROWTYPE; v_problems text[]; v_letter text;
BEGIN
  r := app.fmea_draft_for_update(p_revision);
  v_problems := app.fmea_revision_problems(r.id);
  IF cardinality(v_problems) > 0 THEN RAISE EXCEPTION 'Still needed: %', array_to_string(v_problems, '; ') USING ERRCODE = 'QM036'; END IF;
  SELECT * INTO f FROM public.fmeas WHERE id = r.fmea_id FOR UPDATE;
  v_letter := r.letter;
  IF v_letter IS NULL THEN
    v_letter := app.document_letter_after(f.last_letter);
    UPDATE public.fmeas SET last_letter = v_letter WHERE id = f.id;
  END IF;
  UPDATE public.fmea_revisions SET status = 'pending_approval', letter = v_letter, submitted_at = now(), submitted_by = auth.uid(), returned_comment = NULL, returned_at = NULL, returned_by = NULL
   WHERE id = r.id;
END $$;

-- Loads and locks a revision waiting for its approver: the caller must be the named approver.
CREATE FUNCTION app.fmea_pending_for_approver(p_revision uuid) RETURNS public.fmea_revisions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.fmea_revisions%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.fmea_revisions WHERE id = p_revision FOR UPDATE;
  IF NOT FOUND OR NOT app.fmea_revision_readable(r.id) THEN RAISE EXCEPTION 'Revision not found' USING ERRCODE = 'P0002'; END IF;
  IF r.status <> 'pending_approval' THEN RAISE EXCEPTION 'This revision is % and is not waiting for approval', replace(r.status, '_', ' ') USING ERRCODE = 'QM036'; END IF;
  IF r.approver_id IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'You are not the approver of this revision' USING ERRCODE = '42501'; END IF;
  RETURN r;
END $$;

CREATE FUNCTION app.approve_fmea_revision(p_revision uuid, p_effective_from date, p_comment text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.fmea_revisions%ROWTYPE;
BEGIN
  r := app.fmea_pending_for_approver(p_revision);
  IF r.author_id = auth.uid() THEN RAISE EXCEPTION 'The preparer cannot approve their own revision' USING ERRCODE = 'QM036'; END IF;
  IF NOT app.has_permission(r.organisation_id, 'fmea.approve') THEN RAISE EXCEPTION 'Approving FMEAs needs the FMEA approve permission' USING ERRCODE = '42501'; END IF;
  IF p_effective_from IS NULL THEN RAISE EXCEPTION 'Say when it takes effect' USING ERRCODE = 'QM036'; END IF;
  IF p_effective_from < current_date THEN RAISE EXCEPTION 'It cannot take effect before today' USING ERRCODE = 'QM036'; END IF;
  UPDATE public.fmea_revisions SET status = 'approved', approved_at = now(), approved_by = auth.uid(), effective_from = p_effective_from,
    approval_comment = left(nullif(btrim(coalesce(p_comment, '')), ''), 2000) WHERE id = r.id;
  PERFORM app.settle_fmea(r.fmea_id);
END $$;

CREATE FUNCTION app.send_back_fmea_revision(p_revision uuid, p_comment text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.fmea_revisions%ROWTYPE; v_comment text := nullif(btrim(coalesce(p_comment, '')), '');
BEGIN
  r := app.fmea_pending_for_approver(p_revision);
  IF v_comment IS NULL OR length(v_comment) < 3 THEN RAISE EXCEPTION 'Say what needs changing (a comment of at least 3 characters)' USING ERRCODE = 'QM036'; END IF;
  UPDATE public.fmea_revisions SET status = 'draft', returned_comment = left(v_comment, 2000), returned_at = now(), returned_by = auth.uid() WHERE id = r.id;
END $$;

-- The person who submitted (or any manager) takes a submitted revision back to draft, with a reason (the approver may be away).
CREATE FUNCTION app.recall_fmea_revision(p_revision uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.fmea_revisions%ROWTYPE; v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  SELECT * INTO r FROM public.fmea_revisions WHERE id = p_revision FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(r.organisation_id) THEN RAISE EXCEPTION 'Revision not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_fmea_manager(r.organisation_id);
  IF r.status <> 'pending_approval' THEN RAISE EXCEPTION 'Only a revision waiting for approval can be recalled' USING ERRCODE = 'QM036'; END IF;
  IF length(v_reason) < 3 THEN RAISE EXCEPTION 'Say why it is recalled (at least 3 characters)' USING ERRCODE = 'QM036'; END IF;
  UPDATE public.fmea_revisions SET status = 'draft', returned_comment = left(v_reason, 2000), returned_at = now(), returned_by = auth.uid() WHERE id = r.id;
END $$;

-- ---------------------------------------------------------------------------
-- Becoming effective (no worker): idempotent, run on read and by the API's housekeeping
-- ---------------------------------------------------------------------------
-- One FMEA: every approved revision whose date has come takes effect in date order; the one in force before it is superseded.
CREATE FUNCTION app.settle_fmea(p_fmea uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r record; v_prev uuid; v_n integer := 0; v_months integer;
BEGIN
  FOR r IN SELECT id, organisation_id, effective_from FROM public.fmea_revisions
            WHERE fmea_id = p_fmea AND status = 'approved' AND effective_from <= current_date
            ORDER BY effective_from, approved_at FOR UPDATE
  LOOP
    SELECT id INTO v_prev FROM public.fmea_revisions WHERE fmea_id = p_fmea AND status = 'effective' FOR UPDATE;
    IF v_prev IS NOT NULL THEN
      UPDATE public.fmea_revisions SET status = 'superseded', superseded_at = now(), superseded_by_id = r.id WHERE id = v_prev;
    END IF;
    UPDATE public.fmea_revisions SET status = 'effective', effective_at = now() WHERE id = r.id;
    SELECT review_months INTO v_months FROM public.fmeas WHERE id = p_fmea;
    UPDATE public.fmeas SET status = 'active', current_revision_id = r.id, withdrawn_at = NULL, withdrawn_by = NULL, withdraw_reason = NULL,
      next_review_on = r.effective_from + (coalesce(v_months, 12) || ' months')::interval WHERE id = p_fmea;
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $$;

CREATE FUNCTION app.settle_fmeas(p_organisation_id uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_f uuid; v_n integer := 0;
BEGIN
  IF NOT app.is_member(p_organisation_id) THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
  FOR v_f IN SELECT DISTINCT fmea_id FROM public.fmea_revisions WHERE organisation_id = p_organisation_id AND status = 'approved' AND effective_from <= current_date LOOP
    v_n := v_n + app.settle_fmea(v_f);
  END LOOP;
  RETURN v_n;
END $$;

-- The housekeeping job (API login only), for organisations nobody opened today.
CREATE FUNCTION app.system_settle_fmeas() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_f uuid; v_n integer := 0;
BEGIN
  FOR v_f IN SELECT DISTINCT fmea_id FROM public.fmea_revisions WHERE status = 'approved' AND effective_from <= current_date LOOP
    v_n := v_n + app.settle_fmea(v_f);
  END LOOP;
  RETURN v_n;
END $$;

-- ---------------------------------------------------------------------------
-- Withdrawing, a new revision, discarding a draft
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.withdraw_fmea(p_fmea uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE f public.fmeas%ROWTYPE; v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  SELECT * INTO f FROM public.fmeas WHERE id = p_fmea FOR UPDATE;
  IF NOT FOUND OR NOT app.fmea_readable(f.id) THEN RAISE EXCEPTION 'FMEA not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(f.organisation_id, 'fmea.approve') THEN RAISE EXCEPTION 'Withdrawing FMEAs needs the FMEA approve permission' USING ERRCODE = '42501'; END IF;
  PERFORM app.settle_fmea(f.id);
  SELECT * INTO f FROM public.fmeas WHERE id = p_fmea;
  IF f.status <> 'active' THEN RAISE EXCEPTION 'Only an FMEA in force can be withdrawn (% is %)', f.number, f.status USING ERRCODE = 'QM036'; END IF;
  IF length(v_reason) < 3 THEN RAISE EXCEPTION 'Say why it is withdrawn (at least 3 characters)' USING ERRCODE = 'QM036'; END IF;
  UPDATE public.fmea_revisions SET status = 'withdrawn', withdrawn_at = now(), withdrawn_by = auth.uid(), withdraw_reason = left(v_reason, 500)
   WHERE fmea_id = f.id AND status IN ('effective', 'approved');
  UPDATE public.fmeas SET status = 'withdrawn', withdrawn_at = now(), withdrawn_by = auth.uid(), withdraw_reason = left(v_reason, 500), next_review_on = NULL WHERE id = f.id;
END $$;

-- A new draft from the revision in force (or the last one issued): the team and the scope are copied; the change summary starts empty.
CREATE FUNCTION app.start_fmea_revision(p_fmea uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE f public.fmeas%ROWTYPE; v_from public.fmea_revisions%ROWTYPE; v_id uuid; v_seq integer;
BEGIN
  f := app.fmea_for_write(p_fmea);
  PERFORM app.settle_fmea(f.id);
  SELECT * INTO f FROM public.fmeas WHERE id = p_fmea;
  IF f.status NOT IN ('active', 'withdrawn') THEN RAISE EXCEPTION '% has never been in force: carry on with its draft', f.number USING ERRCODE = 'QM036'; END IF;
  IF EXISTS (SELECT 1 FROM public.fmea_revisions WHERE fmea_id = f.id AND status IN ('draft', 'pending_approval', 'approved')) THEN
    RAISE EXCEPTION '% already has a revision in progress', f.number USING ERRCODE = 'QM036';
  END IF;
  SELECT * INTO v_from FROM public.fmea_revisions
   WHERE fmea_id = f.id AND status IN ('effective', 'superseded', 'withdrawn') ORDER BY (status = 'effective') DESC, sequence DESC LIMIT 1;
  SELECT coalesce(max(sequence), 0) + 1 INTO v_seq FROM public.fmea_revisions WHERE fmea_id = f.id;
  INSERT INTO public.fmea_revisions (organisation_id, fmea_id, sequence, previous_revision_id) VALUES (f.organisation_id, f.id, v_seq, v_from.id) RETURNING id INTO v_id;
  INSERT INTO public.fmea_team_members (organisation_id, revision_id, employee_id, user_id, role)
  SELECT organisation_id, v_id, employee_id, user_id, role FROM public.fmea_team_members WHERE revision_id = v_from.id;
  INSERT INTO public.fmea_links (organisation_id, revision_id, kind, part_id, part_family_id, control_plan_id, machine_id, supplier_id, customer_id, operation_code)
  SELECT organisation_id, v_id, kind, part_id, part_family_id, control_plan_id, machine_id, supplier_id, customer_id, operation_code FROM public.fmea_links WHERE revision_id = v_from.id;
  RETURN v_id;
END $$;

-- A draft is discarded with a reason; the only draft of an FMEA that has never been in force discards the FMEA with it.
CREATE FUNCTION app.discard_fmea_revision(p_revision uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.fmea_revisions%ROWTYPE; f public.fmeas%ROWTYPE; v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  r := app.fmea_draft_for_update(p_revision);
  IF length(v_reason) < 3 THEN RAISE EXCEPTION 'Say why it is discarded (at least 3 characters)' USING ERRCODE = 'QM036'; END IF;
  SELECT * INTO f FROM public.fmeas WHERE id = r.fmea_id FOR UPDATE;
  UPDATE public.fmea_revisions SET status = 'discarded', discarded_at = now(), discarded_by = auth.uid(), discard_reason = left(v_reason, 500) WHERE id = r.id;
  IF f.status = 'draft' AND NOT EXISTS (SELECT 1 FROM public.fmea_revisions WHERE fmea_id = f.id AND status <> 'discarded') THEN
    UPDATE public.fmeas SET status = 'discarded' WHERE id = f.id;
  END IF;
END $$;

REVOKE ALL ON FUNCTION app.fmea_rules(), app.fmea_revision_rules(), app.fmea_child_rules(), app.assert_fmea_manager(uuid), app.fmea_for_write(uuid),
  app.fmea_draft_for_update(uuid), app.fmea_pending_for_approver(uuid), app.settle_fmea(uuid), app.system_settle_fmeas() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.fmea_people(uuid), app.fmea_revision_readable(uuid), app.fmea_readable(uuid), app.fmea_revision_problems(uuid), app.settle_fmeas(uuid),
  app.set_fmea_team(uuid, jsonb), app.set_fmea_links(uuid, jsonb), app.create_fmea(uuid, jsonb), app.update_fmea(uuid, jsonb), app.update_fmea_revision(uuid, jsonb),
  app.set_fmea_approver(uuid, uuid), app.submit_fmea_revision(uuid), app.approve_fmea_revision(uuid, date, text), app.send_back_fmea_revision(uuid, text),
  app.recall_fmea_revision(uuid, text), app.withdraw_fmea(uuid, text), app.start_fmea_revision(uuid), app.discard_fmea_revision(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.fmea_people(uuid), app.fmea_revision_readable(uuid), app.fmea_readable(uuid), app.fmea_revision_problems(uuid), app.settle_fmeas(uuid),
  app.set_fmea_team(uuid, jsonb), app.set_fmea_links(uuid, jsonb), app.create_fmea(uuid, jsonb), app.update_fmea(uuid, jsonb), app.update_fmea_revision(uuid, jsonb),
  app.set_fmea_approver(uuid, uuid), app.submit_fmea_revision(uuid), app.approve_fmea_revision(uuid, date, text), app.send_back_fmea_revision(uuid, text),
  app.recall_fmea_revision(uuid, text), app.withdraw_fmea(uuid, text), app.start_fmea_revision(uuid), app.discard_fmea_revision(uuid, text) TO authenticated;
-- The housekeeping job runs as the API login only.
GRANT EXECUTE ON FUNCTION app.system_settle_fmeas() TO qms_api;

-- ---------------------------------------------------------------------------
-- 6. Columns that name a user are classified (supabase/tests/sso_joining_moves.test.sql fails otherwise): all of them are history. The owner, the preparer, the
--    approver and the team are who was named; after a move to a company account a manager hands an open FMEA to the new account.
-- ---------------------------------------------------------------------------
CREATE FUNCTION pg_temp.patch(p_fn regprocedure, p_old text, p_new text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_def text := replace(pg_get_functiondef(p_fn), E'\r', ''); v_n integer;
BEGIN
  v_n := (length(v_def) - length(replace(v_def, p_old, ''))) / length(p_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'Expected to find % exactly once in %, found % times', p_old, p_fn, v_n; END IF;
  EXECUTE replace(v_def, p_old, p_new);
END $$;

SELECT pg_temp.patch(
  'app.user_reference_columns()'::regprocedure,
  $old$    ('change_tasks', 'owner_user_id', 'history', 'Who a change task was given to; after a move to a company account a change manager hands an open task to the new account'),$old$,
  $new$    ('change_tasks', 'owner_user_id', 'history', 'Who a change task was given to; after a move to a company account a change manager hands an open task to the new account'),
    ('fmeas', 'owner_user_id', 'history', 'Who owns the FMEA; after a move to a company account an FMEA manager names the new account as owner'),
    ('fmea_revisions', 'author_id', 'history', 'Who prepared the revision (the preparer can never approve it)'),
    ('fmea_revisions', 'approver_id', 'history', 'Who was named to approve the revision; a manager recalls and names the new account'),
    ('fmea_team_members', 'user_id', 'history', 'A member named on the FMEA team; the team is replaced on the next revision'),$new$);
