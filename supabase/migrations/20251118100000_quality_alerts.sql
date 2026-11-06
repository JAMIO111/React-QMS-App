-- Quality alerts (DOC1, docs/documentation-plan.md): controlled communications that something needs immediate attention.
--
-- Design
--  * One row per REVISION of an alert (QA-001 rev 1, rev 2 …). A revision is edited only while it is a draft; once issued it is
--    frozen and only its lifecycle can move (active → expired | withdrawn | superseded). A correction is a new revision (draft copy
--    of the old one) which supersedes it when issued.
--  * Drafts are created and edited by people with documentation.manage (table INSERT / column UPDATE under RLS). Everything else —
--    the scope tables, issuing, withdrawing, revising, discarding, expiring — goes through SECURITY DEFINER functions, so the
--    lifecycle columns have no UPDATE grant and the child tables have no write grant at all.
--  * Issuing needs documentation.issue. Recipients (who must acknowledge) are only stored as targets here; resolving and tracking
--    them is DOC2.
--  * Numbering: QA-001, QA-002 … per organisation, assigned when the first revision is created (counter not reachable by users).
--  * Expiry has no worker: app.expire_quality_alerts() is run by the API when alerts are read or written.
--  * Errors QM012 → 409 documentation_rule (messages written for users).

INSERT INTO public.permissions (code, description) VALUES
  ('documentation.read',   'View issued quality alerts and other controlled documents'),
  ('documentation.manage', 'Draft and edit quality alerts and other controlled documents'),
  ('documentation.issue',  'Issue, revise and withdraw quality alerts');

WITH grants(key, perms) AS (VALUES
  ('owner',            ARRAY['documentation.read', 'documentation.manage', 'documentation.issue']),
  ('admin',            ARRAY['documentation.read', 'documentation.manage', 'documentation.issue']),
  ('quality_manager',  ARRAY['documentation.read', 'documentation.manage', 'documentation.issue']),
  ('quality_engineer', ARRAY['documentation.read', 'documentation.manage']),
  ('inspector',        ARRAY['documentation.read']),
  ('viewer',           ARRAY['documentation.read'])
)
INSERT INTO public.role_permissions (role_id, permission_code)
SELECT r.id, unnest(g.perms) FROM public.roles r JOIN grants g ON g.key = r.key WHERE r.is_system
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Numbering
-- ---------------------------------------------------------------------------
CREATE TABLE app.quality_alert_counters (
  organisation_id uuid PRIMARY KEY REFERENCES public.organisations (id) ON DELETE CASCADE,
  last_value integer NOT NULL DEFAULT 0
);

CREATE FUNCTION app.next_quality_alert_number(p_organisation_id uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_n integer;
BEGIN
  INSERT INTO app.quality_alert_counters AS c (organisation_id, last_value) VALUES (p_organisation_id, 1)
  ON CONFLICT (organisation_id) DO UPDATE SET last_value = c.last_value + 1
  RETURNING last_value INTO v_n;
  RETURN v_n;
END $$;

-- ---------------------------------------------------------------------------
-- The alert (one row per revision)
-- ---------------------------------------------------------------------------
CREATE TABLE public.quality_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  alert_number integer NOT NULL,
  reference text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  category text NOT NULL CHECK (category IN ('product', 'process', 'supplier', 'equipment', 'safety')),
  severity text NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  description text CHECK (description IS NULL OR length(btrim(description)) BETWEEN 1 AND 10000),
  required_action text CHECK (required_action IS NULL OR length(btrim(required_action)) BETWEEN 1 AND 5000),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'expired', 'withdrawn', 'superseded')),
  effective_date date,
  expiry_date date,
  acknowledge_by date,
  revision_reason text CHECK (revision_reason IS NULL OR length(btrim(revision_reason)) BETWEEN 1 AND 2000),
  supersedes_id uuid,
  issued_at timestamptz,
  issued_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  withdrawn_at timestamptz,
  withdrawn_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  withdrawn_reason text CHECK (withdrawn_reason IS NULL OR length(btrim(withdrawn_reason)) BETWEEN 1 AND 2000),
  deleted_at timestamptz,
  deleted_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT quality_alerts_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT quality_alerts_number_revision_key UNIQUE (organisation_id, alert_number, revision),
  CONSTRAINT quality_alerts_supersedes_fkey FOREIGN KEY (supersedes_id, organisation_id) REFERENCES public.quality_alerts (id, organisation_id),
  CONSTRAINT quality_alerts_dates CHECK (expiry_date IS NULL OR effective_date IS NULL OR expiry_date >= effective_date),
  CONSTRAINT quality_alerts_issued_complete CHECK (status = 'draft' OR (description IS NOT NULL AND required_action IS NOT NULL AND effective_date IS NOT NULL AND issued_at IS NOT NULL)),
  CONSTRAINT quality_alerts_withdrawn_complete CHECK ((status = 'withdrawn') = (withdrawn_at IS NOT NULL) AND (withdrawn_at IS NULL OR withdrawn_reason IS NOT NULL)),
  CONSTRAINT quality_alerts_revision_supersedes CHECK ((revision = 1) = (supersedes_id IS NULL))
);
-- One open draft per alert number; a revision is only ever made from the current one.
CREATE UNIQUE INDEX quality_alerts_one_draft_key ON public.quality_alerts (organisation_id, alert_number) WHERE status = 'draft' AND deleted_at IS NULL;
CREATE INDEX quality_alerts_status_idx ON public.quality_alerts (organisation_id, status, effective_date DESC) WHERE deleted_at IS NULL;

CREATE FUNCTION app.quality_alert_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.revision = 1 THEN
      -- Users create first drafts; the number is always ours to give.
      NEW.alert_number := app.next_quality_alert_number(NEW.organisation_id);
      NEW.reference := 'QA-' || lpad(NEW.alert_number::text, 3, '0');
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: nothing about identity moves; an issued revision's content is frozen.
  IF NEW.alert_number <> OLD.alert_number OR NEW.reference <> OLD.reference OR NEW.revision <> OLD.revision
     OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id THEN
    RAISE EXCEPTION 'The number and revision of a quality alert cannot change' USING ERRCODE = 'QM012';
  END IF;
  IF OLD.status <> 'draft' AND
     (to_jsonb(NEW) - ARRAY['status', 'withdrawn_at', 'withdrawn_by', 'withdrawn_reason', 'updated_at', 'updated_by'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'withdrawn_at', 'withdrawn_by', 'withdrawn_reason', 'updated_at', 'updated_by']) THEN
    RAISE EXCEPTION 'An issued quality alert cannot be edited; issue a revision instead' USING ERRCODE = 'QM012';
  END IF;
  IF OLD.status = 'draft' AND NEW.status <> 'draft' AND (NEW.issued_at IS NULL OR NEW.issued_by IS NULL) THEN
    RAISE EXCEPTION 'A quality alert is issued with the issue action' USING ERRCODE = 'QM012';
  END IF;
  IF OLD.status <> 'draft' AND NEW.status = 'draft' THEN
    RAISE EXCEPTION 'An issued quality alert cannot go back to draft' USING ERRCODE = 'QM012';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER quality_alerts_stamp BEFORE INSERT ON public.quality_alerts FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER quality_alerts_rules BEFORE INSERT OR UPDATE ON public.quality_alerts FOR EACH ROW EXECUTE FUNCTION app.quality_alert_rules();
CREATE TRIGGER quality_alerts_touch BEFORE UPDATE ON public.quality_alerts FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER quality_alerts_org_immutable BEFORE UPDATE ON public.quality_alerts FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.quality_alerts
  FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');

-- ---------------------------------------------------------------------------
-- Scope (what the alert affects) and targets (who must acknowledge it)
-- ---------------------------------------------------------------------------
CREATE TABLE public.quality_alert_parts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  alert_id uuid NOT NULL,
  part_id uuid,
  part_family_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT quality_alert_parts_alert_fkey FOREIGN KEY (alert_id, organisation_id) REFERENCES public.quality_alerts (id, organisation_id) ON DELETE CASCADE,
  CONSTRAINT quality_alert_parts_part_fkey FOREIGN KEY (part_id, organisation_id) REFERENCES public.parts (id, organisation_id),
  CONSTRAINT quality_alert_parts_family_fkey FOREIGN KEY (part_family_id, organisation_id) REFERENCES public.part_families (id, organisation_id),
  CONSTRAINT quality_alert_parts_one CHECK ((part_id IS NULL) <> (part_family_id IS NULL))
);
CREATE UNIQUE INDEX quality_alert_parts_key ON public.quality_alert_parts (alert_id, coalesce(part_id, part_family_id), (part_id IS NULL));
CREATE INDEX quality_alert_parts_part_idx ON public.quality_alert_parts (organisation_id, part_id) WHERE part_id IS NOT NULL;
CREATE INDEX quality_alert_parts_family_idx ON public.quality_alert_parts (organisation_id, part_family_id) WHERE part_family_id IS NOT NULL;

CREATE TABLE public.quality_alert_machines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  alert_id uuid NOT NULL,
  machine_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT quality_alert_machines_alert_fkey FOREIGN KEY (alert_id, organisation_id) REFERENCES public.quality_alerts (id, organisation_id) ON DELETE CASCADE,
  CONSTRAINT quality_alert_machines_machine_fkey FOREIGN KEY (machine_id, organisation_id) REFERENCES public.machines (id, organisation_id),
  CONSTRAINT quality_alert_machines_key UNIQUE (alert_id, machine_id)
);
CREATE INDEX quality_alert_machines_machine_idx ON public.quality_alert_machines (organisation_id, machine_id);

CREATE TABLE public.quality_alert_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  alert_id uuid NOT NULL,
  operation_code text NOT NULL CHECK (length(btrim(operation_code)) BETWEEN 1 AND 40),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT quality_alert_operations_alert_fkey FOREIGN KEY (alert_id, organisation_id) REFERENCES public.quality_alerts (id, organisation_id) ON DELETE CASCADE,
  CONSTRAINT quality_alert_operations_key UNIQUE (alert_id, operation_code)
);

CREATE TABLE public.quality_alert_departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  alert_id uuid NOT NULL,
  department_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT quality_alert_departments_alert_fkey FOREIGN KEY (alert_id, organisation_id) REFERENCES public.quality_alerts (id, organisation_id) ON DELETE CASCADE,
  CONSTRAINT quality_alert_departments_department_fkey FOREIGN KEY (department_id, organisation_id) REFERENCES public.departments (id, organisation_id),
  CONSTRAINT quality_alert_departments_key UNIQUE (alert_id, department_id)
);

-- Who must acknowledge: a department (its members), a role (everyone holding it) or a named person. Resolved at issue in DOC2.
CREATE TABLE public.quality_alert_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  alert_id uuid NOT NULL,
  department_id uuid,
  role_id uuid,
  membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT quality_alert_targets_alert_fkey FOREIGN KEY (alert_id, organisation_id) REFERENCES public.quality_alerts (id, organisation_id) ON DELETE CASCADE,
  CONSTRAINT quality_alert_targets_department_fkey FOREIGN KEY (department_id, organisation_id) REFERENCES public.departments (id, organisation_id),
  CONSTRAINT quality_alert_targets_role_fkey FOREIGN KEY (role_id, organisation_id) REFERENCES public.roles (id, organisation_id),
  CONSTRAINT quality_alert_targets_membership_fkey FOREIGN KEY (membership_id, organisation_id) REFERENCES public.organisation_users (id, organisation_id),
  CONSTRAINT quality_alert_targets_one CHECK (num_nonnulls(department_id, role_id, membership_id) = 1)
);
CREATE UNIQUE INDEX quality_alert_targets_key ON public.quality_alert_targets (alert_id, coalesce(department_id, role_id, membership_id), (department_id IS NULL), (role_id IS NULL));

CREATE TRIGGER quality_alert_parts_stamp BEFORE INSERT ON public.quality_alert_parts FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER quality_alert_machines_stamp BEFORE INSERT ON public.quality_alert_machines FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER quality_alert_operations_stamp BEFORE INSERT ON public.quality_alert_operations FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER quality_alert_departments_stamp BEFORE INSERT ON public.quality_alert_departments FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER quality_alert_targets_stamp BEFORE INSERT ON public.quality_alert_targets FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['quality_alert_parts', 'quality_alert_machines', 'quality_alert_operations', 'quality_alert_departments', 'quality_alert_targets'] LOOP
    EXECUTE format('CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION audit.record_change(%L)', t, 'organisation_id');
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------
ALTER TABLE public.quality_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quality_alert_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quality_alert_machines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quality_alert_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quality_alert_departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quality_alert_targets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.quality_alerts, public.quality_alert_parts, public.quality_alert_machines, public.quality_alert_operations,
  public.quality_alert_departments, public.quality_alert_targets FROM anon, authenticated;
GRANT SELECT ON public.quality_alert_parts, public.quality_alert_machines, public.quality_alert_operations,
  public.quality_alert_departments, public.quality_alert_targets TO authenticated;
GRANT SELECT, INSERT ON public.quality_alerts TO authenticated;
-- Content only: the lifecycle columns change through the functions below.
GRANT UPDATE (title, category, severity, description, required_action, effective_date, expiry_date, acknowledge_by, revision_reason)
  ON public.quality_alerts TO authenticated;

-- Issued alerts are readable with documentation.read; drafts only by people who manage documentation.
CREATE POLICY quality_alerts_select ON public.quality_alerts FOR SELECT TO authenticated
  USING (deleted_at IS NULL AND ((status <> 'draft' AND app.has_permission(organisation_id, 'documentation.read'))
                                 OR app.has_permission(organisation_id, 'documentation.manage')));
CREATE POLICY quality_alerts_insert ON public.quality_alerts FOR INSERT TO authenticated
  WITH CHECK (status = 'draft' AND revision = 1 AND supersedes_id IS NULL AND deleted_at IS NULL AND issued_at IS NULL
              AND app.has_permission(organisation_id, 'documentation.manage'));
CREATE POLICY quality_alerts_update ON public.quality_alerts FOR UPDATE TO authenticated
  USING (status = 'draft' AND deleted_at IS NULL AND app.has_permission(organisation_id, 'documentation.manage'))
  WITH CHECK (status = 'draft' AND deleted_at IS NULL AND app.has_permission(organisation_id, 'documentation.manage'));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['quality_alert_parts', 'quality_alert_machines', 'quality_alert_operations', 'quality_alert_departments', 'quality_alert_targets'] LOOP
    -- A child is visible exactly when its alert is (the alert's own policy applies to this subquery).
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.quality_alerts a WHERE a.id = alert_id))', t || '_select', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.quality_alert_for_update(p_id uuid, p_permission text, p_require_draft boolean)
RETURNS public.quality_alerts LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.quality_alerts%ROWTYPE;
BEGIN
  SELECT * INTO a FROM public.quality_alerts WHERE id = p_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND OR NOT (app.has_permission(a.organisation_id, 'documentation.read') OR app.has_permission(a.organisation_id, 'documentation.manage')) THEN
    RAISE EXCEPTION 'Quality alert not found' USING ERRCODE = 'QM012';
  END IF;
  IF NOT app.has_permission(a.organisation_id, p_permission) THEN
    RAISE EXCEPTION 'You are not allowed to do that to a quality alert (%)', p_permission USING ERRCODE = '42501';
  END IF;
  IF p_require_draft AND a.status <> 'draft' THEN
    RAISE EXCEPTION 'Only a draft can be changed this way; issue a revision to change an issued alert' USING ERRCODE = 'QM012';
  END IF;
  RETURN a;
END $$;

-- Replaces a draft's scope and targets in one go.
-- p_scope: {"parts":[{"partId"|"partFamilyId":uuid}], "machines":[uuid], "operations":[text], "departments":[uuid],
--           "targets":[{"departmentId"|"roleId"|"membershipId":uuid}]}
CREATE FUNCTION app.set_quality_alert_scope(p_id uuid, p_scope jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.quality_alerts%ROWTYPE;
BEGIN
  a := app.quality_alert_for_update(p_id, 'documentation.manage', true);
  IF jsonb_typeof(p_scope) <> 'object' THEN RAISE EXCEPTION 'Scope must be an object' USING ERRCODE = 'QM012'; END IF;
  DELETE FROM public.quality_alert_parts WHERE alert_id = p_id;
  DELETE FROM public.quality_alert_machines WHERE alert_id = p_id;
  DELETE FROM public.quality_alert_operations WHERE alert_id = p_id;
  DELETE FROM public.quality_alert_departments WHERE alert_id = p_id;
  DELETE FROM public.quality_alert_targets WHERE alert_id = p_id;
  INSERT INTO public.quality_alert_parts (organisation_id, alert_id, part_id, part_family_id)
    SELECT DISTINCT a.organisation_id, p_id, x."partId", x."partFamilyId"
    FROM jsonb_to_recordset(coalesce(p_scope -> 'parts', '[]'::jsonb)) AS x("partId" uuid, "partFamilyId" uuid);
  INSERT INTO public.quality_alert_machines (organisation_id, alert_id, machine_id)
    SELECT DISTINCT a.organisation_id, p_id, x::uuid FROM jsonb_array_elements_text(coalesce(p_scope -> 'machines', '[]'::jsonb)) x;
  INSERT INTO public.quality_alert_operations (organisation_id, alert_id, operation_code)
    SELECT DISTINCT a.organisation_id, p_id, btrim(x) FROM jsonb_array_elements_text(coalesce(p_scope -> 'operations', '[]'::jsonb)) x;
  INSERT INTO public.quality_alert_departments (organisation_id, alert_id, department_id)
    SELECT DISTINCT a.organisation_id, p_id, x::uuid FROM jsonb_array_elements_text(coalesce(p_scope -> 'departments', '[]'::jsonb)) x;
  INSERT INTO public.quality_alert_targets (organisation_id, alert_id, department_id, role_id, membership_id)
    SELECT DISTINCT a.organisation_id, p_id, x."departmentId", x."roleId", x."membershipId"
    FROM jsonb_to_recordset(coalesce(p_scope -> 'targets', '[]'::jsonb)) AS x("departmentId" uuid, "roleId" uuid, "membershipId" uuid);
  UPDATE public.quality_alerts SET updated_at = now() WHERE id = p_id;
END $$;

CREATE FUNCTION app.issue_quality_alert(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.quality_alerts%ROWTYPE;
BEGIN
  a := app.quality_alert_for_update(p_id, 'documentation.issue', true);
  IF a.description IS NULL OR a.required_action IS NULL THEN
    RAISE EXCEPTION 'Describe the issue and the action people must take before issuing' USING ERRCODE = 'QM012';
  END IF;
  IF a.effective_date IS NULL THEN
    RAISE EXCEPTION 'Give an effective date before issuing' USING ERRCODE = 'QM012';
  END IF;
  IF a.severity IN ('high', 'critical') AND a.acknowledge_by IS NULL THEN
    RAISE EXCEPTION 'High and critical alerts need an acknowledge-by date' USING ERRCODE = 'QM012';
  END IF;
  IF a.acknowledge_by IS NOT NULL AND a.acknowledge_by < a.effective_date THEN
    RAISE EXCEPTION 'The acknowledge-by date cannot be before the effective date' USING ERRCODE = 'QM012';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.quality_alert_targets WHERE alert_id = p_id) THEN
    RAISE EXCEPTION 'Choose who must acknowledge this alert (a department, a role or named people)' USING ERRCODE = 'QM012';
  END IF;
  IF a.expiry_date IS NOT NULL AND a.expiry_date < current_date THEN
    RAISE EXCEPTION 'The expiry date has already passed' USING ERRCODE = 'QM012';
  END IF;
  -- The revision this one replaces stops being in force at the same moment.
  IF a.supersedes_id IS NOT NULL THEN
    UPDATE public.quality_alerts SET status = 'superseded' WHERE id = a.supersedes_id AND status IN ('active', 'expired');
  END IF;
  UPDATE public.quality_alerts SET status = 'active', issued_at = now(), issued_by = auth.uid() WHERE id = p_id;
END $$;

CREATE FUNCTION app.withdraw_quality_alert(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.quality_alerts%ROWTYPE;
BEGIN
  a := app.quality_alert_for_update(p_id, 'documentation.issue', false);
  IF a.status NOT IN ('active', 'expired') THEN
    RAISE EXCEPTION 'Only an issued alert can be withdrawn' USING ERRCODE = 'QM012';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'Say why the alert is withdrawn' USING ERRCODE = 'QM012';
  END IF;
  UPDATE public.quality_alerts SET status = 'withdrawn', withdrawn_at = now(), withdrawn_by = auth.uid(), withdrawn_reason = btrim(p_reason) WHERE id = p_id;
END $$;

-- A new draft revision made from an issued one (copying content, scope and targets); returns its id.
CREATE FUNCTION app.revise_quality_alert(p_id uuid, p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.quality_alerts%ROWTYPE; v_new uuid;
BEGIN
  a := app.quality_alert_for_update(p_id, 'documentation.issue', false);
  IF a.status NOT IN ('active', 'expired') THEN
    RAISE EXCEPTION 'Only a current issued alert can be revised' USING ERRCODE = 'QM012';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'Say what is being corrected in this revision' USING ERRCODE = 'QM012';
  END IF;
  IF EXISTS (SELECT 1 FROM public.quality_alerts WHERE organisation_id = a.organisation_id AND alert_number = a.alert_number AND status = 'draft' AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'There is already a draft revision of this alert' USING ERRCODE = 'QM012';
  END IF;
  INSERT INTO public.quality_alerts (organisation_id, alert_number, reference, revision, title, category, severity, description, required_action,
                                     effective_date, expiry_date, acknowledge_by, revision_reason, supersedes_id)
  VALUES (a.organisation_id, a.alert_number, a.reference, a.revision + 1, a.title, a.category, a.severity, a.description, a.required_action,
          NULL, a.expiry_date, NULL, btrim(p_reason), a.id)
  RETURNING id INTO v_new;
  INSERT INTO public.quality_alert_parts (organisation_id, alert_id, part_id, part_family_id)
    SELECT organisation_id, v_new, part_id, part_family_id FROM public.quality_alert_parts WHERE alert_id = p_id;
  INSERT INTO public.quality_alert_machines (organisation_id, alert_id, machine_id)
    SELECT organisation_id, v_new, machine_id FROM public.quality_alert_machines WHERE alert_id = p_id;
  INSERT INTO public.quality_alert_operations (organisation_id, alert_id, operation_code)
    SELECT organisation_id, v_new, operation_code FROM public.quality_alert_operations WHERE alert_id = p_id;
  INSERT INTO public.quality_alert_departments (organisation_id, alert_id, department_id)
    SELECT organisation_id, v_new, department_id FROM public.quality_alert_departments WHERE alert_id = p_id;
  INSERT INTO public.quality_alert_targets (organisation_id, alert_id, department_id, role_id, membership_id)
    SELECT organisation_id, v_new, department_id, role_id, membership_id FROM public.quality_alert_targets WHERE alert_id = p_id;
  RETURN v_new;
END $$;

-- A draft nobody wants any more (an issued alert is withdrawn, never discarded).
CREATE FUNCTION app.discard_quality_alert_draft(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.quality_alerts%ROWTYPE;
BEGIN
  a := app.quality_alert_for_update(p_id, 'documentation.manage', true);
  UPDATE public.quality_alerts SET deleted_at = now(), deleted_by = auth.uid() WHERE id = p_id;
END $$;

-- Active alerts past their expiry date become expired. No worker: the API runs this when alerts are read or written.
CREATE FUNCTION app.expire_quality_alerts(p_organisation_id uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_count integer;
BEGIN
  IF NOT app.is_member(p_organisation_id) THEN RETURN 0; END IF;
  UPDATE public.quality_alerts SET status = 'expired'
   WHERE organisation_id = p_organisation_id AND status = 'active' AND expiry_date IS NOT NULL AND expiry_date < current_date AND deleted_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION app.quality_alert_rules(), app.next_quality_alert_number(uuid), app.quality_alert_for_update(uuid, text, boolean),
  app.set_quality_alert_scope(uuid, jsonb), app.issue_quality_alert(uuid), app.withdraw_quality_alert(uuid, text),
  app.revise_quality_alert(uuid, text), app.discard_quality_alert_draft(uuid), app.expire_quality_alerts(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.set_quality_alert_scope(uuid, jsonb), app.issue_quality_alert(uuid), app.withdraw_quality_alert(uuid, text),
  app.revise_quality_alert(uuid, text), app.discard_quality_alert_draft(uuid), app.expire_quality_alerts(uuid) TO authenticated;
