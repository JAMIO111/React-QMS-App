-- Process control, slice PC1 (docs/process-control-plan.md): domain foundations.
--  * machines (decision P4) and part families as master data; parts may belong to one family;
--  * part-specific characteristic values on part revisions (the part's specification revision,
--    decision P3), editable only while the revision is a draft and copied into a new draft;
--  * control plans: identity, applicability (family + optional part / site / operation) and
--    revision-controlled versions with a lifecycle
--      draft → pending_approval → approved → effective → superseded | obsolete.
--    An approved revision is never edited; changing a plan means a new revision.
--
-- Conventions as Phase 2 / calibration: organisation_id NOT NULL with composite keys, RLS, table-
-- level INSERT stamped by app.stamp_created(), column-level UPDATE, audit_changes everywhere,
-- outbox events only from SECURITY DEFINER triggers. Rule violations raise QM007 (API: 409
-- control_plan_rule) with messages written for users.
--
-- DELETE is allowed in two places only, both audited: characteristic values of a *draft* part
-- revision (a working copy) and control plan applicability rows. Everything else is deactivated.

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------
INSERT INTO public.permissions (code, description) VALUES
  ('process_control.read',    'View control plans and their revisions'),
  ('process_control.manage',  'Create control plans and edit draft revisions'),
  ('process_control.approve', 'Approve, make effective and retire control plan revisions');

WITH grants(key, perms) AS (VALUES
  ('owner',            ARRAY['process_control.read', 'process_control.manage', 'process_control.approve']),
  ('admin',            ARRAY['process_control.read', 'process_control.manage', 'process_control.approve']),
  ('quality_manager',  ARRAY['process_control.read', 'process_control.manage', 'process_control.approve']),
  ('quality_engineer', ARRAY['process_control.read', 'process_control.manage']),
  ('inspector',        ARRAY['process_control.read']),
  ('viewer',           ARRAY['process_control.read'])
)
INSERT INTO public.role_permissions (role_id, permission_code)
SELECT r.id, unnest(g.perms) FROM public.roles r JOIN grants g ON g.key = r.key WHERE r.is_system
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Master data: machines and part families
-- ---------------------------------------------------------------------------
CREATE TABLE public.machines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  code text NOT NULL CHECK (code ~ '^\S(.{0,38}\S)?$'),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  site_id uuid,
  work_centre text CHECK (work_centre IS NULL OR length(work_centre) <= 100),
  description text CHECK (description IS NULL OR length(description) <= 1000),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT machines_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT machines_site_fkey FOREIGN KEY (site_id, organisation_id) REFERENCES public.sites (id, organisation_id)
);
CREATE UNIQUE INDEX machines_org_code_key ON public.machines (organisation_id, upper(code));

CREATE TABLE public.part_families (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  code text NOT NULL CHECK (code ~ '^\S(.{0,38}\S)?$'),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  description text CHECK (description IS NULL OR length(description) <= 2000),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT part_families_id_org_key UNIQUE (id, organisation_id)
);
CREATE UNIQUE INDEX part_families_org_code_key ON public.part_families (organisation_id, upper(code));

ALTER TABLE public.parts ADD COLUMN part_family_id uuid,
  ADD CONSTRAINT parts_family_fkey FOREIGN KEY (part_family_id, organisation_id) REFERENCES public.part_families (id, organisation_id);
CREATE INDEX parts_family_idx ON public.parts (part_family_id) WHERE part_family_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Part-specific characteristic values (per part revision = specification revision)
-- ---------------------------------------------------------------------------
-- A control plan characteristic in "variable" mode names a characteristic_key (e.g. LENGTH); its
-- nominal and limits come from the selected part revision's value with that key. Limits are
-- absolute values; either limit may be open (e.g. a maximum only).
CREATE TABLE public.part_revision_characteristics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  part_revision_id uuid NOT NULL,
  characteristic_key text NOT NULL CHECK (characteristic_key ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  description text CHECK (description IS NULL OR length(description) <= 200),
  nominal numeric,
  lower_limit numeric,
  upper_limit numeric,
  unit_code text NOT NULL REFERENCES public.units (code),
  notes text CHECK (notes IS NULL OR length(notes) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT part_revision_characteristics_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT part_revision_characteristics_revision_fkey FOREIGN KEY (part_revision_id, organisation_id)
    REFERENCES public.part_revisions (id, organisation_id) ON DELETE CASCADE,
  CONSTRAINT part_revision_characteristics_has_value CHECK (nominal IS NOT NULL OR lower_limit IS NOT NULL OR upper_limit IS NOT NULL),
  CONSTRAINT part_revision_characteristics_limits_order CHECK (lower_limit IS NULL OR upper_limit IS NULL OR lower_limit <= upper_limit),
  CONSTRAINT part_revision_characteristics_nominal_within CHECK (
    nominal IS NULL OR ((lower_limit IS NULL OR nominal >= lower_limit) AND (upper_limit IS NULL OR nominal <= upper_limit)))
);
CREATE UNIQUE INDEX part_revision_characteristics_key ON public.part_revision_characteristics (part_revision_id, characteristic_key);

-- ---------------------------------------------------------------------------
-- Control plans
-- ---------------------------------------------------------------------------
CREATE TABLE public.control_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  plan_code text NOT NULL CHECK (plan_code ~ '^\S(.{0,38}\S)?$'),
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  description text CHECK (description IS NULL OR length(description) <= 2000),
  owner_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT control_plans_id_org_key UNIQUE (id, organisation_id)
);
CREATE UNIQUE INDEX control_plans_org_code_key ON public.control_plans (organisation_id, upper(plan_code));

-- Where a plan applies: always a part family, optionally narrowed to one part of that family, one
-- site and/or one operation code. A family can have several plans (different routes/operations).
CREATE TABLE public.control_plan_applicability (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  control_plan_id uuid NOT NULL,
  part_family_id uuid NOT NULL,
  part_id uuid,
  site_id uuid,
  operation_code text CHECK (operation_code IS NULL OR operation_code ~ '^\S(.{0,28}\S)?$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT control_plan_applicability_plan_fkey FOREIGN KEY (control_plan_id, organisation_id)
    REFERENCES public.control_plans (id, organisation_id),
  CONSTRAINT control_plan_applicability_family_fkey FOREIGN KEY (part_family_id, organisation_id)
    REFERENCES public.part_families (id, organisation_id),
  CONSTRAINT control_plan_applicability_part_fkey FOREIGN KEY (part_id, organisation_id)
    REFERENCES public.parts (id, organisation_id),
  CONSTRAINT control_plan_applicability_site_fkey FOREIGN KEY (site_id, organisation_id)
    REFERENCES public.sites (id, organisation_id)
);
CREATE UNIQUE INDEX control_plan_applicability_scope_key ON public.control_plan_applicability (
  control_plan_id, part_family_id, coalesce(part_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(site_id, '00000000-0000-0000-0000-000000000000'::uuid), upper(coalesce(operation_code, '')));
CREATE INDEX control_plan_applicability_family_idx ON public.control_plan_applicability (part_family_id);

CREATE TABLE public.control_plan_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  control_plan_id uuid NOT NULL,
  -- The organisation's own convention (A/B/C, 01/02, 1.0…); unique per plan regardless of case.
  revision_code text NOT NULL CHECK (revision_code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,9}$'),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending_approval', 'approved', 'effective', 'superseded', 'obsolete')),
  change_reason text CHECK (change_reason IS NULL OR length(change_reason) <= 2000),
  effective_from timestamptz,
  effective_until timestamptz,
  supersedes_revision_id uuid,
  submitted_at timestamptz,
  submitted_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  approved_at timestamptz,
  approved_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  -- Comment of the latest review (approval, or why it was sent back to draft).
  review_comment text CHECK (review_comment IS NULL OR length(review_comment) <= 2000),
  obsolete_reason text CHECK (obsolete_reason IS NULL OR length(obsolete_reason) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT control_plan_revisions_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT control_plan_revisions_plan_fkey FOREIGN KEY (control_plan_id, organisation_id)
    REFERENCES public.control_plans (id, organisation_id),
  CONSTRAINT control_plan_revisions_supersedes_fkey FOREIGN KEY (supersedes_revision_id, organisation_id)
    REFERENCES public.control_plan_revisions (id, organisation_id),
  CONSTRAINT control_plan_revisions_window CHECK (effective_until IS NULL OR effective_from IS NULL OR effective_until >= effective_from),
  CONSTRAINT control_plan_revisions_approved_stamped CHECK (
    status IN ('draft', 'pending_approval') OR (status = 'obsolete' AND approved_at IS NULL) OR approved_at IS NOT NULL),
  CONSTRAINT control_plan_revisions_effective_dated CHECK (status NOT IN ('effective', 'superseded') OR effective_from IS NOT NULL)
);
CREATE UNIQUE INDEX control_plan_revisions_code_key ON public.control_plan_revisions (control_plan_id, upper(revision_code));
-- At most one working copy (draft or under review) and one effective revision per plan.
CREATE UNIQUE INDEX control_plan_revisions_one_open ON public.control_plan_revisions (control_plan_id)
  WHERE status IN ('draft', 'pending_approval');
CREATE UNIQUE INDEX control_plan_revisions_one_effective ON public.control_plan_revisions (control_plan_id)
  WHERE status = 'effective';
CREATE INDEX control_plan_revisions_org_idx ON public.control_plan_revisions (organisation_id, status);

-- ---------------------------------------------------------------------------
-- Rules
-- ---------------------------------------------------------------------------
-- Characteristic values belong to a draft part revision; released/superseded/obsolete
-- specifications are locked (a data migration without a JWT may load history).
CREATE FUNCTION app.part_revision_characteristic_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_rev record;
  v_row record := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.part_revision_id <> OLD.part_revision_id OR NEW.characteristic_key <> OLD.characteristic_key) THEN
    RAISE EXCEPTION 'A characteristic value cannot move or change its key; add a new one instead' USING ERRCODE = 'QM007';
  END IF;
  IF coalesce(auth.role(), '') = 'authenticated' THEN
    SELECT revision, status INTO v_rev FROM public.part_revisions WHERE id = v_row.part_revision_id;
    IF v_rev.status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'Revision % is % and its specification values can no longer be changed; create a new revision', v_rev.revision, v_rev.status
        USING ERRCODE = 'QM007';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

-- A new draft part revision starts with the values of the part's current released revision.
CREATE FUNCTION app.part_revision_copy_characteristics() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.status = 'draft' THEN
    INSERT INTO public.part_revision_characteristics (organisation_id, part_revision_id, characteristic_key, description,
                                                       nominal, lower_limit, upper_limit, unit_code, notes)
    SELECT NEW.organisation_id, NEW.id, c.characteristic_key, c.description, c.nominal, c.lower_limit, c.upper_limit, c.unit_code, c.notes
    FROM public.part_revision_characteristics c
    JOIN public.part_revisions r ON r.id = c.part_revision_id
    WHERE r.part_id = NEW.part_id AND r.status = 'released' AND r.id <> NEW.id;
  END IF;
  RETURN NULL;
END $$;

-- Applicability: a named part must belong to the named family; the plan must be active.
CREATE FUNCTION app.control_plan_applicability_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.control_plan_id <> OLD.control_plan_id THEN
    RAISE EXCEPTION 'Applicability cannot move to another plan' USING ERRCODE = 'QM007';
  END IF;
  NEW.operation_code := nullif(upper(trim(NEW.operation_code)), '');
  IF NEW.part_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.parts p WHERE p.id = NEW.part_id AND p.part_family_id = NEW.part_family_id) THEN
    RAISE EXCEPTION 'The part is not in the selected part family' USING ERRCODE = 'QM007';
  END IF;
  RETURN NEW;
END $$;

-- A part cannot leave its family while a control plan names it explicitly.
CREATE FUNCTION app.part_family_change_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.part_family_id IS DISTINCT FROM OLD.part_family_id AND EXISTS (
       SELECT 1 FROM public.control_plan_applicability a WHERE a.part_id = NEW.id) THEN
    RAISE EXCEPTION 'This part is named in a control plan''s scope; remove it there before changing its family'
      USING ERRCODE = 'QM007';
  END IF;
  RETURN NEW;
END $$;

/*
 * Control plan revision lifecycle (signed-in users; checked again by the API):
 *   draft → pending_approval        submit (process_control.manage; needs a change reason)
 *   pending_approval → draft        withdraw (manage) or send back (approve, with a comment)
 *   pending_approval → approved     approve (process_control.approve)
 *   approved → effective            make effective (approve) — from effective_from, now if not set
 *                                   or past; the plan's current effective revision is superseded
 *   effective → superseded          only as a consequence of the above
 *   draft | pending | approved | effective → obsolete   (approve; drafts also with manage), with a reason
 * Only drafts are editable. Who/when of submission and approval are set by the database.
 */
CREATE FUNCTION app.control_plan_revision_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_plan record;
  v_can_manage boolean;
  v_can_approve boolean;
  v_cascade boolean := pg_trigger_depth() > 1;
BEGIN
  SELECT id, active, organisation_id INTO v_plan FROM public.control_plans WHERE id = NEW.control_plan_id;
  IF TG_OP = 'INSERT' THEN
    IF coalesce(auth.role(), '') = 'authenticated' THEN
      IF NOT v_plan.active THEN
        RAISE EXCEPTION 'This control plan is inactive; reactivate it before adding a revision' USING ERRCODE = 'QM007';
      END IF;
      IF NEW.status <> 'draft' THEN
        RAISE EXCEPTION 'New revisions start as draft' USING ERRCODE = 'QM007';
      END IF;
      NEW.submitted_at := NULL; NEW.submitted_by := NULL; NEW.approved_at := NULL; NEW.approved_by := NULL;
      NEW.review_comment := NULL; NEW.obsolete_reason := NULL; NEW.effective_until := NULL;
      -- The new revision replaces the current effective one (else the latest approved one).
      SELECT r.id INTO NEW.supersedes_revision_id FROM public.control_plan_revisions r
      WHERE r.control_plan_id = NEW.control_plan_id AND r.status IN ('effective', 'approved')
      ORDER BY (r.status = 'effective') DESC, r.approved_at DESC NULLS LAST LIMIT 1;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.control_plan_id <> OLD.control_plan_id THEN
    RAISE EXCEPTION 'A revision cannot move to another plan' USING ERRCODE = 'QM007';
  END IF;
  IF coalesce(auth.role(), '') <> 'authenticated' THEN
    RETURN NEW;
  END IF;

  v_can_manage := app.has_permission(NEW.organisation_id, 'process_control.manage');
  v_can_approve := app.has_permission(NEW.organisation_id, 'process_control.approve');

  -- Content of a revision can only change while it is a draft.
  IF OLD.status <> 'draft' AND (NEW.revision_code, NEW.change_reason, NEW.effective_from, NEW.supersedes_revision_id)
       IS DISTINCT FROM (OLD.revision_code, OLD.change_reason, OLD.effective_from, OLD.supersedes_revision_id)
     AND NOT (NEW.status = 'effective' AND OLD.status = 'approved') THEN
    RAISE EXCEPTION 'Revision % is % and can no longer be edited; create a new revision', OLD.revision_code, replace(OLD.status, '_', ' ')
      USING ERRCODE = 'QM007';
  END IF;
  IF NEW.supersedes_revision_id IS DISTINCT FROM OLD.supersedes_revision_id THEN
    RAISE EXCEPTION 'The superseded revision is set by the system' USING ERRCODE = 'QM007';
  END IF;
  IF OLD.status = 'draft' AND NEW.status = 'draft' AND NOT v_can_manage THEN
    RAISE EXCEPTION 'You may not edit control plan revisions' USING ERRCODE = '42501';
  END IF;

  IF NEW.status = OLD.status THEN
    IF (NEW.submitted_at, NEW.submitted_by, NEW.approved_at, NEW.approved_by, NEW.effective_until, NEW.obsolete_reason)
       IS DISTINCT FROM (OLD.submitted_at, OLD.submitted_by, OLD.approved_at, OLD.approved_by, OLD.effective_until, OLD.obsolete_reason)
       OR (NEW.review_comment IS DISTINCT FROM OLD.review_comment) THEN
      RAISE EXCEPTION 'Review details are set when the status changes' USING ERRCODE = 'QM007';
    END IF;
    RETURN NEW;
  END IF;

  CASE
    WHEN OLD.status = 'draft' AND NEW.status = 'pending_approval' THEN
      IF NOT v_can_manage THEN RAISE EXCEPTION 'You may not submit control plan revisions' USING ERRCODE = '42501'; END IF;
      IF coalesce(trim(NEW.change_reason), '') = '' THEN
        RAISE EXCEPTION 'Describe the change (reason for this revision) before submitting it' USING ERRCODE = 'QM007';
      END IF;
      NEW.submitted_at := now(); NEW.submitted_by := auth.uid(); NEW.review_comment := NULL;
    WHEN OLD.status = 'pending_approval' AND NEW.status = 'draft' THEN
      IF NOT (v_can_manage OR v_can_approve) THEN RAISE EXCEPTION 'You may not change this revision' USING ERRCODE = '42501'; END IF;
      NEW.submitted_at := NULL; NEW.submitted_by := NULL;
      NEW.review_comment := nullif(trim(NEW.review_comment), '');
    WHEN OLD.status = 'pending_approval' AND NEW.status = 'approved' THEN
      IF NOT v_can_approve THEN RAISE EXCEPTION 'You may not approve control plan revisions' USING ERRCODE = '42501'; END IF;
      NEW.approved_at := now(); NEW.approved_by := auth.uid();
      NEW.review_comment := nullif(trim(NEW.review_comment), '');
    WHEN OLD.status = 'approved' AND NEW.status = 'effective' THEN
      IF NOT v_can_approve THEN RAISE EXCEPTION 'You may not make control plan revisions effective' USING ERRCODE = '42501'; END IF;
      IF NOT v_plan.active THEN
        RAISE EXCEPTION 'This control plan is inactive; reactivate it first' USING ERRCODE = 'QM007';
      END IF;
      IF OLD.effective_from IS NOT NULL AND OLD.effective_from > now() THEN
        RAISE EXCEPTION 'Revision % becomes effective on %; it cannot be made effective earlier', OLD.revision_code,
          to_char(OLD.effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI "UTC"') USING ERRCODE = 'QM007';
      END IF;
      NEW.effective_from := now();
      NEW.effective_until := NULL;
      UPDATE public.control_plan_revisions SET status = 'superseded'
      WHERE control_plan_id = NEW.control_plan_id AND status = 'effective' AND id <> NEW.id;
    WHEN OLD.status = 'effective' AND NEW.status = 'superseded' THEN
      IF NOT v_cascade THEN
        RAISE EXCEPTION 'A revision is superseded by making a newer revision effective' USING ERRCODE = 'QM007';
      END IF;
      NEW.effective_until := now();
    WHEN NEW.status = 'obsolete' AND OLD.status IN ('draft', 'pending_approval', 'approved', 'effective') THEN
      IF NOT (v_can_approve OR (OLD.status = 'draft' AND v_can_manage)) THEN
        RAISE EXCEPTION 'You may not retire control plan revisions' USING ERRCODE = '42501';
      END IF;
      IF coalesce(trim(NEW.obsolete_reason), '') = '' THEN
        RAISE EXCEPTION 'Give a reason for making this revision obsolete' USING ERRCODE = 'QM007';
      END IF;
      IF OLD.status = 'effective' THEN NEW.effective_until := now(); END IF;
    ELSE
      RAISE EXCEPTION 'A % revision cannot become %', replace(OLD.status, '_', ' '), replace(NEW.status, '_', ' ') USING ERRCODE = 'QM007';
  END CASE;
  RETURN NEW;
END $$;

CREATE FUNCTION app.control_plan_revision_events() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.status <> OLD.status THEN
    PERFORM app.emit_event(NEW.organisation_id, 'control_plan.revision.status_changed', 'control_plan_revision', NEW.id,
      jsonb_build_object('control_plan_id', NEW.control_plan_id, 'revision', NEW.revision_code,
        'plan_code', (SELECT plan_code FROM public.control_plans WHERE id = NEW.control_plan_id),
        'from', OLD.status, 'to', NEW.status));
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER part_revision_characteristics_rules BEFORE INSERT OR UPDATE OR DELETE ON public.part_revision_characteristics
  FOR EACH ROW EXECUTE FUNCTION app.part_revision_characteristic_rules();
CREATE TRIGGER part_revisions_copy_characteristics AFTER INSERT ON public.part_revisions
  FOR EACH ROW EXECUTE FUNCTION app.part_revision_copy_characteristics();
CREATE TRIGGER parts_family_change BEFORE UPDATE OF part_family_id ON public.parts
  FOR EACH ROW EXECUTE FUNCTION app.part_family_change_rules();
CREATE TRIGGER control_plan_applicability_rules BEFORE INSERT OR UPDATE ON public.control_plan_applicability
  FOR EACH ROW EXECUTE FUNCTION app.control_plan_applicability_rules();
CREATE TRIGGER control_plan_revisions_rules BEFORE INSERT OR UPDATE ON public.control_plan_revisions
  FOR EACH ROW EXECUTE FUNCTION app.control_plan_revision_rules();
CREATE TRIGGER control_plan_revisions_events AFTER UPDATE OF status ON public.control_plan_revisions
  FOR EACH ROW EXECUTE FUNCTION app.control_plan_revision_events();

-- Bookkeeping, audit, RLS and base privileges.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['machines', 'part_families', 'part_revision_characteristics', 'control_plans',
                           'control_plan_applicability', 'control_plan_revisions'] LOOP
    EXECUTE format('CREATE TRIGGER %1$s_stamp BEFORE INSERT ON public.%1$I FOR EACH ROW EXECUTE FUNCTION app.stamp_created()', t);
    EXECUTE format('CREATE TRIGGER %1$s_touch BEFORE UPDATE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION app.touch_updated()', t);
    EXECUTE format('CREATE TRIGGER %1$s_org_immutable BEFORE UPDATE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change()', t);
    EXECUTE format('CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.%I '
                   'FOR EACH ROW EXECUTE FUNCTION audit.record_change(''organisation_id'')', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT, INSERT ON public.%I TO authenticated', t);
  END LOOP;
  -- Master data: every member reads, master_data.manage writes.
  FOREACH t IN ARRAY ARRAY['machines', 'part_families', 'part_revision_characteristics'] LOOP
    EXECUTE format('CREATE POLICY %1$s_select ON public.%1$I FOR SELECT TO authenticated USING (app.is_member(organisation_id))', t);
    EXECUTE format('CREATE POLICY %1$s_insert ON public.%1$I FOR INSERT TO authenticated '
                   'WITH CHECK (app.has_permission(organisation_id, ''master_data.manage''))', t);
    EXECUTE format('CREATE POLICY %1$s_update ON public.%1$I FOR UPDATE TO authenticated '
                   'USING (app.has_permission(organisation_id, ''master_data.manage'')) '
                   'WITH CHECK (app.has_permission(organisation_id, ''master_data.manage''))', t);
  END LOOP;
  -- Control plans: process_control.read reads, process_control.manage writes.
  FOREACH t IN ARRAY ARRAY['control_plans', 'control_plan_applicability'] LOOP
    EXECUTE format('CREATE POLICY %1$s_select ON public.%1$I FOR SELECT TO authenticated '
                   'USING (app.has_permission(organisation_id, ''process_control.read''))', t);
    EXECUTE format('CREATE POLICY %1$s_insert ON public.%1$I FOR INSERT TO authenticated '
                   'WITH CHECK (app.has_permission(organisation_id, ''process_control.manage''))', t);
    EXECUTE format('CREATE POLICY %1$s_update ON public.%1$I FOR UPDATE TO authenticated '
                   'USING (app.has_permission(organisation_id, ''process_control.manage'')) '
                   'WITH CHECK (app.has_permission(organisation_id, ''process_control.manage''))', t);
  END LOOP;
END $$;

CREATE POLICY part_revision_characteristics_delete ON public.part_revision_characteristics FOR DELETE TO authenticated
  USING (app.has_permission(organisation_id, 'master_data.manage'));
CREATE POLICY control_plan_applicability_delete ON public.control_plan_applicability FOR DELETE TO authenticated
  USING (app.has_permission(organisation_id, 'process_control.manage'));

-- Revisions: authors (manage) create and edit drafts; approvers also change status. The lifecycle
-- trigger decides which transition each may make.
CREATE POLICY control_plan_revisions_select ON public.control_plan_revisions FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'process_control.read'));
CREATE POLICY control_plan_revisions_insert ON public.control_plan_revisions FOR INSERT TO authenticated
  WITH CHECK (app.has_permission(organisation_id, 'process_control.manage'));
CREATE POLICY control_plan_revisions_update ON public.control_plan_revisions FOR UPDATE TO authenticated
  USING (app.has_permission(organisation_id, 'process_control.manage') OR app.has_permission(organisation_id, 'process_control.approve'))
  WITH CHECK (app.has_permission(organisation_id, 'process_control.manage') OR app.has_permission(organisation_id, 'process_control.approve'));

GRANT DELETE ON public.part_revision_characteristics, public.control_plan_applicability TO authenticated;
GRANT UPDATE (code, name, site_id, work_centre, description, active) ON public.machines TO authenticated;
GRANT UPDATE (code, name, description, active) ON public.part_families TO authenticated;
GRANT UPDATE (part_family_id) ON public.parts TO authenticated;
GRANT UPDATE (description, nominal, lower_limit, upper_limit, unit_code, notes) ON public.part_revision_characteristics TO authenticated;
GRANT UPDATE (plan_code, title, description, owner_id, active) ON public.control_plans TO authenticated;
GRANT UPDATE (part_id, site_id, operation_code) ON public.control_plan_applicability TO authenticated;
GRANT UPDATE (revision_code, status, change_reason, effective_from, review_comment, obsolete_reason)
  ON public.control_plan_revisions TO authenticated;

REVOKE ALL ON FUNCTION app.part_revision_characteristic_rules(), app.part_revision_copy_characteristics(),
  app.control_plan_applicability_rules(), app.part_family_change_rules(), app.control_plan_revision_rules(),
  app.control_plan_revision_events() FROM PUBLIC;

-- History of one control plan (plan, applicability and revisions) for anyone who may read it.
CREATE FUNCTION app.control_plan_history(p_control_plan_id uuid)
RETURNS TABLE (id uuid, created_at timestamptz, actor_user_id uuid, entity_type text, entity_id text, action text,
               changed_fields text[], previous_values jsonb, new_values jsonb, reason text, source text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT e.id, e.created_at, e.actor_user_id, e.entity_type, e.entity_id, e.action, e.changed_fields,
         e.previous_values, e.new_values, e.reason, e.source
  FROM audit.events e
  JOIN public.control_plans p ON p.id = p_control_plan_id
  WHERE e.organisation_id = p.organisation_id
    AND app.has_permission(p.organisation_id, 'process_control.read')
    AND ((e.entity_type = 'control_plans' AND e.entity_id = p_control_plan_id::text)
      OR (e.entity_type = 'control_plan_revisions'
          AND e.entity_id IN (SELECT r.id::text FROM public.control_plan_revisions r WHERE r.control_plan_id = p_control_plan_id))
      -- Applicability rows may have been deleted: their insert/delete events carry the plan id.
      OR (e.entity_type = 'control_plan_applicability'
          AND (e.entity_id IN (SELECT a.id::text FROM public.control_plan_applicability a WHERE a.control_plan_id = p_control_plan_id)
               OR e.new_values ->> 'control_plan_id' = p_control_plan_id::text
               OR e.previous_values ->> 'control_plan_id' = p_control_plan_id::text)))
  ORDER BY e.seq
$$;
REVOKE ALL ON FUNCTION app.control_plan_history(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.control_plan_history(uuid) TO authenticated;
