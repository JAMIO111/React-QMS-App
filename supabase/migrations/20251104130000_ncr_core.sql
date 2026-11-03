-- Phase 2 / slice 2.4 — NCR core (docs/phase-2-plan.md §2.3, §3): one non-conformance record for
-- internal, customer and supplier NCs, organisation-managed classifications, generated references,
-- the stage machine, soft delete, outbox events, and the copy of the legacy "NCM" records.
--
-- Stage requirements are minimal in this slice (title, severity, quantity, and the customer or
-- supplier for those sources); slices 2.5/2.6 add the containment, investigation, disposition
-- and CAPA gates once those records exist.

-- ---------------------------------------------------------------------------
-- Classifications: failure modes, sub-failure modes (under a failure mode) and processes.
-- Replace the legacy "Failure Mode", "Sub-Failure Mode" and "Process" lists.
-- ---------------------------------------------------------------------------
CREATE TABLE public.ncr_classifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('failure_mode', 'sub_failure_mode', 'process')),
  parent_id uuid,
  code text CHECK (code IS NULL OR code ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  description text,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  legacy_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT ncr_classifications_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT ncr_classifications_parent_fkey FOREIGN KEY (parent_id, organisation_id)
    REFERENCES public.ncr_classifications (id, organisation_id),
  CONSTRAINT ncr_classifications_parent_only_for_sub CHECK ((kind = 'sub_failure_mode') = (parent_id IS NOT NULL))
);
CREATE UNIQUE INDEX ncr_classifications_name_key
  ON public.ncr_classifications (organisation_id, kind, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), upper(name));
CREATE INDEX ncr_classifications_parent_idx ON public.ncr_classifications (parent_id) WHERE parent_id IS NOT NULL;

-- A sub-failure mode sits under a failure mode of the same organisation.
CREATE FUNCTION app.check_classification_parent() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.parent_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.ncr_classifications p WHERE p.id = NEW.parent_id AND p.kind = 'failure_mode') THEN
    RAISE EXCEPTION 'A sub-failure mode must belong to a failure mode' USING ERRCODE = 'QM004';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.kind <> OLD.kind THEN
    RAISE EXCEPTION 'The kind of a classification cannot change' USING ERRCODE = 'QM004';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ncr_classifications_parent BEFORE INSERT OR UPDATE ON public.ncr_classifications
  FOR EACH ROW EXECUTE FUNCTION app.check_classification_parent();

-- ---------------------------------------------------------------------------
-- Non-conformances
-- ---------------------------------------------------------------------------
CREATE TABLE public.nonconformances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  reference text NOT NULL CHECK (length(reference) BETWEEN 1 AND 40),
  source text NOT NULL CHECK (source IN ('internal', 'customer', 'supplier', 'inspection')),
  stage text NOT NULL DEFAULT 'draft' CHECK (stage IN (
    'draft', 'open', 'contained', 'investigating', 'dispositioned', 'awaiting_closure', 'closed', 'cancelled')),
  stage_reason text,
  severity text CHECK (severity IN ('critical', 'major', 'minor')),
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  description text,
  requirement text,
  actual_result text,
  site_id uuid,
  part_id uuid,
  part_revision_id uuid,
  customer_id uuid,
  supplier_id uuid,
  work_order text,
  purchase_order text,
  customer_reference text,
  lot_number text,
  serial_number text,
  quantity_affected numeric CHECK (quantity_affected >= 0),
  quantity_inspected numeric CHECK (quantity_inspected >= 0),
  detected_at date NOT NULL DEFAULT current_date,
  detected_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  detection_process_id uuid,
  causal_process_id uuid,
  failure_mode_id uuid,
  sub_failure_mode_id uuid,
  responsible_employee_id uuid,
  owner_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  closed_at timestamptz,
  closed_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  deleted_at timestamptz,
  deleted_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  delete_reason text,
  legacy_ncm_id uuid UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT nonconformances_org_reference_key UNIQUE (organisation_id, reference),
  CONSTRAINT nonconformances_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT nonconformances_site_fkey FOREIGN KEY (site_id, organisation_id) REFERENCES public.sites (id, organisation_id),
  CONSTRAINT nonconformances_part_fkey FOREIGN KEY (part_id, organisation_id) REFERENCES public.parts (id, organisation_id),
  CONSTRAINT nonconformances_part_revision_fkey FOREIGN KEY (part_revision_id, organisation_id) REFERENCES public.part_revisions (id, organisation_id),
  CONSTRAINT nonconformances_customer_fkey FOREIGN KEY (customer_id, organisation_id) REFERENCES public.customers (id, organisation_id),
  CONSTRAINT nonconformances_supplier_fkey FOREIGN KEY (supplier_id, organisation_id) REFERENCES public.suppliers (id, organisation_id),
  CONSTRAINT nonconformances_detection_process_fkey FOREIGN KEY (detection_process_id, organisation_id) REFERENCES public.ncr_classifications (id, organisation_id),
  CONSTRAINT nonconformances_causal_process_fkey FOREIGN KEY (causal_process_id, organisation_id) REFERENCES public.ncr_classifications (id, organisation_id),
  CONSTRAINT nonconformances_failure_mode_fkey FOREIGN KEY (failure_mode_id, organisation_id) REFERENCES public.ncr_classifications (id, organisation_id),
  CONSTRAINT nonconformances_sub_failure_mode_fkey FOREIGN KEY (sub_failure_mode_id, organisation_id) REFERENCES public.ncr_classifications (id, organisation_id),
  CONSTRAINT nonconformances_employee_fkey FOREIGN KEY (responsible_employee_id, organisation_id) REFERENCES public."Employees" (id, organisation_id),
  CONSTRAINT nonconformances_deleted_has_reason CHECK (deleted_at IS NULL OR length(trim(delete_reason)) > 0)
);
CREATE INDEX nonconformances_list_idx ON public.nonconformances (organisation_id, source, detected_at DESC);
CREATE INDEX nonconformances_part_idx ON public.nonconformances (part_id) WHERE part_id IS NOT NULL;
CREATE INDEX nonconformances_customer_idx ON public.nonconformances (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX nonconformances_supplier_idx ON public.nonconformances (supplier_id) WHERE supplier_id IS NOT NULL;

-- Per-organisation, per-year counters for references (PREFIX-YY-NNN). Not reachable by users.
CREATE TABLE app.ncr_counters (
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  year integer NOT NULL,
  last_value integer NOT NULL DEFAULT 0,
  PRIMARY KEY (organisation_id, year)
);

CREATE FUNCTION app.next_ncr_reference(p_organisation_id uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_prefix text;
  v_year integer := extract(year FROM current_date)::integer;
  v_n integer;
  v_ref text;
BEGIN
  SELECT ncr_reference_prefix INTO v_prefix FROM public.organisation_settings WHERE organisation_id = p_organisation_id;
  LOOP
    INSERT INTO app.ncr_counters AS c (organisation_id, year, last_value) VALUES (p_organisation_id, v_year, 1)
    ON CONFLICT (organisation_id, year) DO UPDATE SET last_value = c.last_value + 1
    RETURNING last_value INTO v_n;
    v_ref := coalesce(v_prefix, 'NCR') || '-' || to_char(make_date(v_year, 1, 1), 'YY') || '-' || lpad(v_n::text, 3, '0');
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.nonconformances WHERE organisation_id = p_organisation_id AND reference = v_ref);
  END LOOP;
  RETURN v_ref;
END $$;

-- Fields that only the stage machine, soft delete or bookkeeping may change.
CREATE FUNCTION app.ncr_content(r public.nonconformances) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT to_jsonb(r) - ARRAY['stage', 'stage_reason', 'closed_at', 'closed_by', 'deleted_at', 'deleted_by',
                             'delete_reason', 'updated_at', 'updated_by']
$$;

/*
 * Rules for signed-in users (a data migration without a JWT may load history as it was):
 * - insert: reference generated, stage draft or open, bookkeeping stamped;
 * - stage changes: draft → open; forward through open … closed; any stage before closed →
 *   cancelled (reason); closed / cancelled → open = reopen (reason); leaving draft needs the
 *   minimum fields; closing stamps who/when;
 * - closed or cancelled records are locked until reopened; deleted records are locked until restored;
 * - soft delete / restore needs ncr.delete (and a reason to delete); other edits need ncr.update;
 * - the revision must belong to the part; classifications must be of the right kind.
 */
CREATE FUNCTION app.nonconformance_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  user_change boolean := coalesce(auth.role(), '') = 'authenticated';
  order_of text[] := ARRAY['open', 'contained', 'investigating', 'dispositioned', 'awaiting_closure', 'closed'];
  from_pos integer;
  to_pos integer;
  content_changed boolean;
BEGIN
  -- Consistency (always).
  IF NEW.part_revision_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.part_revisions r WHERE r.id = NEW.part_revision_id AND r.part_id IS NOT DISTINCT FROM NEW.part_id) THEN
    RAISE EXCEPTION 'The revision does not belong to the selected part' USING ERRCODE = 'QM005';
  END IF;
  IF NEW.failure_mode_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.ncr_classifications c WHERE c.id = NEW.failure_mode_id AND c.kind = 'failure_mode')
     OR NEW.sub_failure_mode_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.ncr_classifications c WHERE c.id = NEW.sub_failure_mode_id AND c.kind = 'sub_failure_mode'
                                                            AND c.parent_id IS NOT DISTINCT FROM NEW.failure_mode_id)
     OR NEW.causal_process_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.ncr_classifications c WHERE c.id = NEW.causal_process_id AND c.kind = 'process')
     OR NEW.detection_process_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.ncr_classifications c WHERE c.id = NEW.detection_process_id AND c.kind = 'process') THEN
    RAISE EXCEPTION 'A classification does not match its field (or the sub-failure mode is not under the failure mode)' USING ERRCODE = 'QM005';
  END IF;

  IF NOT user_change THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.reference := app.next_ncr_reference(NEW.organisation_id);
    IF NEW.stage NOT IN ('draft', 'open') THEN
      RAISE EXCEPTION 'A new non-conformance starts as draft or open' USING ERRCODE = 'QM005';
    END IF;
    NEW.closed_at := NULL; NEW.closed_by := NULL;
    NEW.deleted_at := NULL; NEW.deleted_by := NULL; NEW.delete_reason := NULL;
    NEW.legacy_ncm_id := NULL;
    IF NEW.stage = 'open' THEN
      PERFORM app.assert_ncr_openable(NEW);
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF NEW.reference <> OLD.reference OR NEW.source <> OLD.source THEN
    RAISE EXCEPTION 'The reference and source of a non-conformance cannot change' USING ERRCODE = 'QM005';
  END IF;

  -- Soft delete / restore.
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    IF NOT app.has_permission(NEW.organisation_id, 'ncr.delete', NEW.site_id) THEN
      RAISE EXCEPTION 'Deleting non-conformances needs the ncr.delete permission' USING ERRCODE = '42501';
    END IF;
    IF NEW.deleted_at IS NOT NULL THEN
      IF coalesce(trim(NEW.delete_reason), '') = '' THEN
        RAISE EXCEPTION 'Give a reason for deleting' USING ERRCODE = 'QM005';
      END IF;
      NEW.deleted_at := now();
      NEW.deleted_by := auth.uid();
    ELSE
      NEW.deleted_by := NULL;
      NEW.delete_reason := NULL;
    END IF;
    IF app.ncr_content(NEW) IS DISTINCT FROM app.ncr_content(OLD) OR NEW.stage <> OLD.stage THEN
      RAISE EXCEPTION 'Delete or restore on its own, without other changes' USING ERRCODE = 'QM005';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'This non-conformance is deleted; restore it first' USING ERRCODE = 'QM005';
  END IF;
  IF NEW.delete_reason IS DISTINCT FROM OLD.delete_reason OR NEW.deleted_by IS DISTINCT FROM OLD.deleted_by THEN
    RAISE EXCEPTION 'Deletion details are set by the system' USING ERRCODE = 'QM005';
  END IF;

  IF NOT app.has_permission(NEW.organisation_id, 'ncr.update', NEW.site_id) THEN
    RAISE EXCEPTION 'Changing non-conformances needs the ncr.update permission' USING ERRCODE = '42501';
  END IF;

  content_changed := app.ncr_content(NEW) IS DISTINCT FROM app.ncr_content(OLD);

  IF NEW.stage = OLD.stage THEN
    IF content_changed AND OLD.stage IN ('closed', 'cancelled') THEN
      RAISE EXCEPTION 'This non-conformance is %; reopen it to make changes', OLD.stage USING ERRCODE = 'QM005';
    END IF;
    IF NEW.stage_reason IS DISTINCT FROM OLD.stage_reason OR NEW.closed_at IS DISTINCT FROM OLD.closed_at
       OR NEW.closed_by IS DISTINCT FROM OLD.closed_by THEN
      RAISE EXCEPTION 'Stage details change only with the stage' USING ERRCODE = 'QM005';
    END IF;
    RETURN NEW;
  END IF;

  -- Stage change.
  from_pos := array_position(order_of, OLD.stage);
  to_pos := array_position(order_of, NEW.stage);
  IF NEW.stage = 'cancelled' THEN
    IF OLD.stage IN ('closed', 'cancelled') THEN
      RAISE EXCEPTION 'A % non-conformance cannot be cancelled', OLD.stage USING ERRCODE = 'QM005';
    END IF;
    IF coalesce(trim(NEW.stage_reason), '') = '' THEN
      RAISE EXCEPTION 'Give a reason for cancelling' USING ERRCODE = 'QM005';
    END IF;
  ELSIF OLD.stage IN ('closed', 'cancelled') THEN
    IF NEW.stage <> 'open' THEN
      RAISE EXCEPTION 'A % non-conformance can only be reopened', OLD.stage USING ERRCODE = 'QM005';
    END IF;
    IF coalesce(trim(NEW.stage_reason), '') = '' THEN
      RAISE EXCEPTION 'Give a reason for reopening' USING ERRCODE = 'QM005';
    END IF;
    IF content_changed THEN
      RAISE EXCEPTION 'Reopen first, then make changes' USING ERRCODE = 'QM005';
    END IF;
    NEW.closed_at := NULL;
    NEW.closed_by := NULL;
    RETURN NEW;
  ELSIF OLD.stage = 'draft' THEN
    IF NEW.stage <> 'open' THEN
      RAISE EXCEPTION 'A draft is opened first' USING ERRCODE = 'QM005';
    END IF;
  ELSIF to_pos IS NULL OR from_pos IS NULL OR to_pos <= from_pos THEN
    RAISE EXCEPTION 'A % non-conformance cannot move to %', OLD.stage, NEW.stage USING ERRCODE = 'QM005';
  END IF;

  IF OLD.stage = 'draft' THEN
    PERFORM app.assert_ncr_openable(NEW);
  END IF;
  IF NEW.stage = 'closed' THEN
    NEW.closed_at := now();
    NEW.closed_by := auth.uid();
  END IF;
  RETURN NEW;
END $$;

-- Minimum content before a non-conformance leaves draft.
CREATE FUNCTION app.assert_ncr_openable(r public.nonconformances) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE
  missing text[] := ARRAY[]::text[];
BEGIN
  IF r.severity IS NULL THEN missing := array_append(missing, 'severity'); END IF;
  IF r.quantity_affected IS NULL THEN missing := array_append(missing, 'quantity affected'); END IF;
  IF r.part_id IS NULL AND coalesce(trim(r.description), '') = '' THEN missing := array_append(missing, 'part or description'); END IF;
  IF r.source = 'customer' AND r.customer_id IS NULL THEN missing := array_append(missing, 'customer'); END IF;
  IF r.source = 'supplier' AND r.supplier_id IS NULL THEN missing := array_append(missing, 'supplier'); END IF;
  IF cardinality(missing) > 0 THEN
    RAISE EXCEPTION 'To open this non-conformance, fill in: %', array_to_string(missing, ', ') USING ERRCODE = 'QM005';
  END IF;
END $$;

CREATE FUNCTION app.nonconformance_events() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  base jsonb := jsonb_build_object('reference', NEW.reference, 'source', NEW.source);
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' THEN
    RETURN NULL;  -- data migrations do not emit events
  END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM app.emit_event(NEW.organisation_id, 'ncr.created', 'nonconformance', NEW.id, base || jsonb_build_object('stage', NEW.stage));
    RETURN NULL;
  END IF;
  IF NEW.stage <> OLD.stage THEN
    PERFORM app.emit_event(NEW.organisation_id, 'ncr.stage_changed', 'nonconformance', NEW.id,
      base || jsonb_build_object('from', OLD.stage, 'to', NEW.stage, 'reason', NEW.stage_reason));
    IF NEW.stage = 'closed' THEN
      PERFORM app.emit_event(NEW.organisation_id, 'ncr.closed', 'nonconformance', NEW.id, base);
    END IF;
  END IF;
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    PERFORM app.emit_event(NEW.organisation_id, CASE WHEN NEW.deleted_at IS NULL THEN 'ncr.restored' ELSE 'ncr.deleted' END,
      'nonconformance', NEW.id, base || jsonb_build_object('reason', NEW.delete_reason));
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER nonconformances_rules BEFORE INSERT OR UPDATE ON public.nonconformances
  FOR EACH ROW EXECUTE FUNCTION app.nonconformance_rules();
CREATE TRIGGER nonconformances_events AFTER INSERT OR UPDATE ON public.nonconformances
  FOR EACH ROW EXECUTE FUNCTION app.nonconformance_events();

-- Bookkeeping and audit.
CREATE TRIGGER ncr_classifications_stamp BEFORE INSERT ON public.ncr_classifications FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER nonconformances_stamp BEFORE INSERT ON public.nonconformances FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER ncr_classifications_touch BEFORE UPDATE ON public.ncr_classifications FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER nonconformances_touch BEFORE UPDATE ON public.nonconformances FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.ncr_classifications
  FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.nonconformances
  FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');

-- ---------------------------------------------------------------------------
-- Row level security and privileges
-- ---------------------------------------------------------------------------
ALTER TABLE public.ncr_classifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nonconformances ENABLE ROW LEVEL SECURITY;

CREATE POLICY ncr_classifications_select ON public.ncr_classifications FOR SELECT TO authenticated
  USING (app.is_member(organisation_id));
CREATE POLICY ncr_classifications_insert ON public.ncr_classifications FOR INSERT TO authenticated
  WITH CHECK (app.has_permission(organisation_id, 'lookups.manage'));
CREATE POLICY ncr_classifications_update ON public.ncr_classifications FOR UPDATE TO authenticated
  USING (app.has_permission(organisation_id, 'lookups.manage'))
  WITH CHECK (app.has_permission(organisation_id, 'lookups.manage'));

-- Site-scoped role assignments apply: a user scoped to one site sees and changes that site's NCRs.
CREATE POLICY nonconformances_select ON public.nonconformances FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'ncr.read', site_id));
CREATE POLICY nonconformances_insert ON public.nonconformances FOR INSERT TO authenticated
  WITH CHECK (app.has_permission(organisation_id, 'ncr.create', site_id));
CREATE POLICY nonconformances_update ON public.nonconformances FOR UPDATE TO authenticated
  USING (app.has_permission(organisation_id, 'ncr.update', site_id) OR app.has_permission(organisation_id, 'ncr.delete', site_id))
  WITH CHECK (app.has_permission(organisation_id, 'ncr.update', site_id) OR app.has_permission(organisation_id, 'ncr.delete', site_id));

REVOKE ALL ON public.ncr_classifications, public.nonconformances FROM anon, authenticated;
GRANT SELECT, INSERT ON public.ncr_classifications, public.nonconformances TO authenticated;
GRANT UPDATE (parent_id, code, name, description, active, sort_order) ON public.ncr_classifications TO authenticated;
GRANT UPDATE (stage, stage_reason, severity, title, description, requirement, actual_result, site_id, part_id,
              part_revision_id, customer_id, supplier_id, work_order, purchase_order, customer_reference,
              lot_number, serial_number, quantity_affected, quantity_inspected, detected_at, detected_by,
              detection_process_id, causal_process_id, failure_mode_id, sub_failure_mode_id,
              responsible_employee_id, owner_id, deleted_at, delete_reason)
  ON public.nonconformances TO authenticated;

REVOKE ALL ON app.ncr_counters FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.check_classification_parent(), app.next_ncr_reference(uuid), app.ncr_content(public.nonconformances),
  app.nonconformance_rules(), app.assert_ncr_openable(public.nonconformances), app.nonconformance_events() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Helpers for the API
-- ---------------------------------------------------------------------------
-- The caller holds the permission in this organisation at any scope (organisation-wide or for some
-- site/department). Used to admit site-scoped users to routes whose rows RLS then filters by site.
CREATE FUNCTION app.has_permission_somewhere(p_organisation_id uuid, p_permission text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organisation_users m
    JOIN public.organisations o ON o.id = m.organisation_id AND o.status = 'active'
    JOIN public.user_role_assignments a ON a.membership_id = m.id
    JOIN public.role_permissions rp ON rp.role_id = a.role_id
    WHERE m.organisation_id = p_organisation_id AND m.user_id = auth.uid() AND m.status = 'active'
      AND rp.permission_code = p_permission
  ) AND app.mfa_satisfied(p_organisation_id)
$$;

-- History of one NCR for anyone who may read it (the full audit trail needs audit.read).
CREATE FUNCTION app.ncr_history(p_ncr_id uuid)
RETURNS TABLE (id uuid, created_at timestamptz, actor_user_id uuid, action text, changed_fields text[],
               previous_values jsonb, new_values jsonb, reason text, source text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT e.id, e.created_at, e.actor_user_id, e.action, e.changed_fields, e.previous_values, e.new_values, e.reason, e.source
  FROM audit.events e
  JOIN public.nonconformances n ON n.id = p_ncr_id
  WHERE e.entity_type = 'nonconformances' AND e.entity_id = p_ncr_id::text
    AND e.organisation_id = n.organisation_id
    AND app.has_permission(n.organisation_id, 'ncr.read', n.site_id)
  ORDER BY e.seq
$$;

REVOKE ALL ON FUNCTION app.has_permission_somewhere(uuid, text), app.ncr_history(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.has_permission_somewhere(uuid, text), app.ncr_history(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Legacy copy (decision Q1). Ids and references are kept; statuses map to stages.
-- ---------------------------------------------------------------------------
INSERT INTO public.ncr_classifications (organisation_id, kind, code, name, description, active, legacy_id, created_at, created_by)
SELECT f.organisation_id, 'failure_mode',
       CASE WHEN upper(f.code) ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$' THEN upper(f.code) END,
       coalesce(nullif(trim(f.name), ''), 'Unnamed failure mode'), f.description, coalesce(f.active, true), f.id, f.created_at, NULL
FROM public."Failure Mode" f;

INSERT INTO public.ncr_classifications (organisation_id, kind, parent_id, name, description, active, legacy_id, created_at, created_by)
SELECT s.organisation_id, 'sub_failure_mode', p.id, coalesce(nullif(trim(s.name), ''), 'Unnamed sub-failure mode'),
       s.description, coalesce(s.active, true), s.id, coalesce(s.created_at, now()), NULL
FROM public."Sub-Failure Mode" s
JOIN public.ncr_classifications p ON p.kind = 'failure_mode' AND p.legacy_id = s.failure_mode AND p.organisation_id = s.organisation_id;

INSERT INTO public.ncr_classifications (organisation_id, kind, code, name, active, legacy_id, created_at, created_by)
SELECT p.organisation_id, 'process',
       CASE WHEN upper(p.code) ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$' THEN upper(p.code) END,
       coalesce(nullif(trim(p.name), ''), 'Unnamed process'), coalesce(p.active, true), p.id, p.created_at, NULL
FROM public."Process" p;

INSERT INTO public.nonconformances (
  id, organisation_id, reference, source, stage, stage_reason, title, description,
  part_id, part_revision_id, customer_id, supplier_id, work_order, purchase_order, customer_reference,
  quantity_affected, quantity_inspected, detected_at, detection_process_id, causal_process_id,
  failure_mode_id, sub_failure_mode_id, responsible_employee_id, legacy_ncm_id, created_at, created_by)
SELECT n.id, n.organisation_id,
       coalesce(nullif(trim(n.ncm_id), ''), 'LEGACY-' || left(n.id::text, 8)),
       CASE lower(coalesce(n.type, 'internal')) WHEN 'customer' THEN 'customer' WHEN 'supplier' THEN 'supplier' ELSE 'internal' END,
       CASE
         WHEN st.type = 'terminal' THEN 'closed'
         WHEN st.type = 'omit' THEN 'cancelled'
         WHEN st.type = 'in_progress' AND st.name !~* '^\s*open\s*$' THEN 'investigating'
         ELSE 'open'
       END,
       CASE WHEN st.type = 'omit' THEN 'Migrated with status "' || st.name || '"' END,
       left(coalesce(nullif(trim(n.description), ''), n.ncm_id, 'Migrated non-conformance'), 200),
       n.description,
       pt.id,
       (SELECT r.id FROM public.part_revisions r WHERE r.part_id = pt.id AND r.status = 'released'),
       c.id, s.id, n.work_order, n.purchase_order, n.claim_ref,
       n.quantity_defective, n.quantity_checked,
       coalesce(n.date::date, n.created_at::date),
       loc.id, cp.id, fm.id, sfm.id, e.id,
       n.id, n.created_at,
       (SELECT u.id FROM auth.users u WHERE u.id = n.logged_by)
FROM public."NCM" n
LEFT JOIN public."Status" st ON st.id = n.status
LEFT JOIN public.parts pt ON pt.id = n.part_number AND pt.organisation_id = n.organisation_id
LEFT JOIN public.customers c ON c.id = n.customer AND c.organisation_id = n.organisation_id
LEFT JOIN public.suppliers s ON s.id = n.supplier AND s.organisation_id = n.organisation_id
LEFT JOIN public.ncr_classifications fm ON fm.kind = 'failure_mode' AND fm.legacy_id = n.failure_mode AND fm.organisation_id = n.organisation_id
LEFT JOIN public.ncr_classifications sfm ON sfm.kind = 'sub_failure_mode' AND sfm.legacy_id = n.sub_failure_mode
       AND sfm.organisation_id = n.organisation_id AND sfm.parent_id IS NOT DISTINCT FROM fm.id
LEFT JOIN public.ncr_classifications cp ON cp.kind = 'process' AND cp.legacy_id = n.causal_process AND cp.organisation_id = n.organisation_id
LEFT JOIN public.ncr_classifications loc ON loc.kind = 'process' AND loc.legacy_id = n.location_detected AND loc.organisation_id = n.organisation_id
LEFT JOIN public."Employees" e ON e.id = n.responsible_operator AND e.organisation_id = n.organisation_id;

-- Continue numbering after the highest migrated PREFIX-YY-NNN reference of each year.
INSERT INTO app.ncr_counters (organisation_id, year, last_value)
SELECT organisation_id, 2000 + (m[1])::integer, max((m[2])::integer)
FROM (SELECT organisation_id, regexp_match(reference, '^[A-Z0-9]+-(\d{2})-(\d+)$') AS m FROM public.nonconformances) x
WHERE m IS NOT NULL
GROUP BY organisation_id, 2000 + (m[1])::integer;
