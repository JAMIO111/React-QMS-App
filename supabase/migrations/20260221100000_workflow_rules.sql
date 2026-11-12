-- Workflow rules WF1 (docs/workflow-engine-plan.md §5; decisions W5–W9): "when this happens, if these conditions hold, then tell these people / give this person a task".
--
--  * Permissions workflows.read (owner, admin, quality manager, quality engineer) and workflows.manage (owner, admin, quality manager). Errors QM028 → 409 workflow_rule.
--  * app.workflow_triggers(): the events a rule may start from (those the modules already write to the outbox), each with the kind of record, the permission a
--    person needs to be told about it, and a label. app.system_workflow_facts(): what a rule can test about that record, read when the rule runs (the record as it
--    is now, plus what the event said), with the record's label, link target, site and owner.
--  * workflow_rules (WF-001 …; active | paused | retired with a reason) and workflow_rule_versions (frozen: trigger, conditions, actions, reason). A change to what a
--    rule does is a new version with a reason (from version 2); a run records the version it ran.
--  * workflow_runs: one per rule version and event that matched, with the outcome of each action. Written by the worker only.
--  * workflow_notices (a notice from a rule, addressed to one person) and workflow_tasks (TSK-YY-NNNN, a to-do for one person, closed by them); both written only
--    by the worker's functions, at most once per run, action and person (W9), only to active members who may read the record at its site (checked as that
--    person), audited and announced as notices with no actor (own_record, emailed by default).
--  * The worker (API login) reads the outbox as the consumer 'workflows', evaluates the conditions in code and calls app.system_record_workflow_run, then one job
--    per action calls app.system_workflow_notify / app.system_workflow_task. Nothing here ever raises, closes, approves or cancels a record (W6).

INSERT INTO public.permissions (code, description) VALUES
  ('workflows.read',   'View workflow rules, what they did, and every workflow task'),
  ('workflows.manage', 'Write and change workflow rules: what starts them, what they test and what they do');

WITH grants(key, perms) AS (VALUES
  ('owner',            ARRAY['workflows.read', 'workflows.manage']),
  ('admin',            ARRAY['workflows.read', 'workflows.manage']),
  ('quality_manager',  ARRAY['workflows.read', 'workflows.manage']),
  ('quality_engineer', ARRAY['workflows.read'])
)
INSERT INTO public.role_permissions (role_id, permission_code)
SELECT r.id, unnest(g.perms) FROM public.roles r JOIN grants g ON g.key = r.key WHERE r.is_system
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- What a rule can start from, and what it can test
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.workflow_triggers() RETURNS TABLE (event_type text, entity_type text, label text, permission text)
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  VALUES
    ('ncr.created',                       'nonconformance',         'A non-conformance is raised',               'ncr.read'),
    ('ncr.stage_changed',                 'nonconformance',         'A non-conformance moves to another stage',  'ncr.read'),
    ('inspection.measurement.failed',     'inspection_measurement', 'An inspection reading fails',               'inspection.read'),
    ('calibration.recorded',              'calibration',            'A calibration is recorded',                 'calibration.read'),
    ('gauge.status_changed',              'gauge',                  'A gauge changes status',                    'calibration.read'),
    ('capa.created',                      'capa',                   'An 8D is started',                          'capa.read'),
    ('audit.finding.created',             'audit_finding',          'An audit finding is raised',                'audits.read'),
    ('supplier.approval_status_changed',  'supplier',               'A supplier''s approval status changes',     'supplier_quality.read')
$$;

-- The facts about the record behind an event, for conditions and for the notice: label, record_kind / record_id (the page a link opens), site_id, owner_user_id
-- (who "the record's owner" is) and the fields the trigger catalogue offers. Read as the system; null when the record is gone.
CREATE FUNCTION app.system_workflow_facts(p_organisation_id uuid, p_entity_type text, p_entity_id uuid, p_payload jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v jsonb;
BEGIN
  IF p_entity_type = 'nonconformance' THEN
    SELECT jsonb_build_object('label', n.reference || ' · ' || n.title, 'record_kind', 'nonconformance', 'record_id', n.id, 'site_id', n.site_id, 'owner_user_id', n.owner_id,
             'source', n.source, 'severity', n.severity, 'stage', n.stage, 'to_stage', coalesce(p_payload ->> 'to', n.stage),
             'category', c.code, 'part_id', n.part_id, 'part_family_id', p.part_family_id, 'supplier_id', n.supplier_id, 'customer_id', n.customer_id)
      INTO v FROM public.nonconformances n
      LEFT JOIN public.ncr_classifications c ON c.id = n.category_id
      LEFT JOIN public.parts p ON p.id = n.part_id
     WHERE n.id = p_entity_id AND n.organisation_id = p_organisation_id AND n.deleted_at IS NULL;
  ELSIF p_entity_type = 'inspection_measurement' THEN
    SELECT jsonb_build_object('label', i.reference || ' · ' || coalesce(q.char_number || ' ', '') || q.name || ' failed', 'record_kind', 'inspection', 'record_id', i.id,
             'site_id', i.site_id, 'owner_user_id', m.created_by,
             'part_id', i.part_id, 'part_family_id', p.part_family_id, 'machine_id', i.machine_id, 'operation_code', i.operation_code,
             'characteristic_key', q.characteristic_key, 'criticality', q.criticality, 'trigger_type', i.trigger_type)
      INTO v FROM public.inspection_measurements m
      JOIN public.inspection_records i ON i.id = m.inspection_record_id
      JOIN public.resolved_inspection_requirements q ON q.id = m.requirement_id
      LEFT JOIN public.parts p ON p.id = i.part_id
     WHERE m.id = p_entity_id AND m.organisation_id = p_organisation_id;
  ELSIF p_entity_type = 'calibration' THEN
    SELECT jsonb_build_object('label', c.reference || ' · ' || g.asset_number || ' ' || g.description, 'record_kind', 'gauge', 'record_id', g.id,
             'site_id', g.site_id, 'owner_user_id', g.custodian_id, 'outcome', c.outcome, 'gauge_type_id', g.gauge_type_id, 'gauge_id', g.id)
      INTO v FROM public.calibrations c JOIN public.gauges g ON g.id = c.gauge_id
     WHERE c.id = p_entity_id AND c.organisation_id = p_organisation_id AND c.deleted_at IS NULL;
  ELSIF p_entity_type = 'gauge' THEN
    SELECT jsonb_build_object('label', g.asset_number || ' · ' || g.description, 'record_kind', 'gauge', 'record_id', g.id,
             'site_id', g.site_id, 'owner_user_id', g.custodian_id, 'status', g.status, 'gauge_type_id', g.gauge_type_id, 'gauge_id', g.id)
      INTO v FROM public.gauges g WHERE g.id = p_entity_id AND g.organisation_id = p_organisation_id AND g.deleted_at IS NULL;
  ELSIF p_entity_type = 'capa' THEN
    SELECT jsonb_build_object('label', c.reference || ' · ' || c.title, 'record_kind', 'capa', 'record_id', c.id, 'site_id', NULL, 'owner_user_id', m.user_id,
             'source', c.source, 'severity', c.severity)
      INTO v FROM public.capas c LEFT JOIN public.organisation_users m ON m.id = c.owner_membership_id
     WHERE c.id = p_entity_id AND c.organisation_id = p_organisation_id;
  ELSIF p_entity_type = 'audit_finding' THEN
    SELECT jsonb_build_object('label', f.reference || ' · ' || f.title, 'record_kind', 'audit_finding', 'record_id', f.id, 'site_id', NULL, 'owner_user_id', e.auth_id,
             'classification', k.key, 'finding_kind', k.kind)
      INTO v FROM public.audit_findings f
      JOIN public.audit_finding_classifications k ON k.id = f.classification_id
      LEFT JOIN public."Employees" e ON e.id = f.owner_employee_id AND e.organisation_id = f.organisation_id
     WHERE f.id = p_entity_id AND f.organisation_id = p_organisation_id;
  ELSIF p_entity_type = 'supplier' THEN
    SELECT jsonb_build_object('label', s.code || ' · ' || coalesce(s.display_name, s.name), 'record_kind', 'supplier', 'record_id', s.id, 'site_id', NULL, 'owner_user_id', NULL,
             'approval_status', s.approval_status, 'risk_rating', s.risk_rating, 'supplier_type', s.supplier_type)
      INTO v FROM public.suppliers s WHERE s.id = p_entity_id AND s.organisation_id = p_organisation_id;
  END IF;
  RETURN v;
END $$;

-- ---------------------------------------------------------------------------
-- Rules and their versions
-- ---------------------------------------------------------------------------
CREATE TABLE app.workflow_counters (
  organisation_id uuid PRIMARY KEY REFERENCES public.organisations (id) ON DELETE CASCADE,
  last_rule integer NOT NULL DEFAULT 0
);
CREATE TABLE app.workflow_task_counters (
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  year integer NOT NULL,
  last_value integer NOT NULL DEFAULT 0,
  PRIMARY KEY (organisation_id, year)
);
REVOKE ALL ON app.workflow_counters, app.workflow_task_counters FROM PUBLIC, anon, authenticated;

CREATE TABLE public.workflow_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  reference text NOT NULL CHECK (reference ~ '^WF-[0-9]{3,}$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  description text CHECK (description IS NULL OR length(btrim(description)) BETWEEN 1 AND 2000),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'retired')),
  status_reason text CHECK (status_reason IS NULL OR length(btrim(status_reason)) BETWEEN 1 AND 1000),
  current_version integer NOT NULL DEFAULT 1 CHECK (current_version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT workflow_rules_reference_key UNIQUE (organisation_id, reference),
  CONSTRAINT workflow_rules_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT workflow_rules_retired_reason CHECK (status <> 'retired' OR status_reason IS NOT NULL)
);
CREATE UNIQUE INDEX workflow_rules_name_key ON public.workflow_rules (organisation_id, lower(btrim(name))) WHERE status <> 'retired';

CREATE TABLE public.workflow_rule_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  rule_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  trigger text NOT NULL,
  conditions jsonb NOT NULL CHECK (jsonb_typeof(conditions) = 'object' AND pg_column_size(conditions) <= 32768),
  actions jsonb NOT NULL CHECK (jsonb_typeof(actions) = 'array' AND jsonb_array_length(actions) BETWEEN 1 AND 10 AND pg_column_size(actions) <= 32768),
  reason text CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 3 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT workflow_rule_versions_rule_fkey FOREIGN KEY (rule_id, organisation_id) REFERENCES public.workflow_rules (id, organisation_id),
  CONSTRAINT workflow_rule_versions_key UNIQUE (rule_id, version),
  CONSTRAINT workflow_rule_versions_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT workflow_rule_versions_reason CHECK (version = 1 OR reason IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- What rules did
-- ---------------------------------------------------------------------------
CREATE TABLE public.workflow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  rule_id uuid NOT NULL,
  rule_version_id uuid NOT NULL,
  event_id bigint NOT NULL,
  event_type text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  facts jsonb NOT NULL CHECK (jsonb_typeof(facts) = 'object'),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'partial', 'failed')),
  results jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(results) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_runs_rule_fkey FOREIGN KEY (rule_id, organisation_id) REFERENCES public.workflow_rules (id, organisation_id),
  CONSTRAINT workflow_runs_version_fkey FOREIGN KEY (rule_version_id, organisation_id) REFERENCES public.workflow_rule_versions (id, organisation_id),
  CONSTRAINT workflow_runs_once UNIQUE (rule_version_id, event_id),
  CONSTRAINT workflow_runs_id_org_key UNIQUE (id, organisation_id)
);
CREATE INDEX workflow_runs_rule_idx ON public.workflow_runs (rule_id, created_at DESC);

CREATE TABLE public.workflow_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  run_id uuid NOT NULL,
  action_index integer NOT NULL CHECK (action_index BETWEEN 0 AND 9),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  rule_name text NOT NULL,
  message text NOT NULL CHECK (length(message) BETWEEN 1 AND 1000),
  record_kind text NOT NULL,
  record_id uuid NOT NULL,
  record_label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_notices_run_fkey FOREIGN KEY (run_id, organisation_id) REFERENCES public.workflow_runs (id, organisation_id),
  CONSTRAINT workflow_notices_once UNIQUE (run_id, action_index, user_id)
);

CREATE TABLE public.workflow_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  reference text NOT NULL CHECK (reference ~ '^TSK-[0-9]{2}-[0-9]{4,}$'),
  run_id uuid NOT NULL,
  action_index integer NOT NULL CHECK (action_index BETWEEN 0 AND 9),
  rule_id uuid NOT NULL,
  rule_name text NOT NULL,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  detail text CHECK (detail IS NULL OR length(detail) <= 2000),
  record_kind text NOT NULL,
  record_id uuid NOT NULL,
  record_label text NOT NULL,
  site_id uuid,
  permission text NOT NULL,
  assignee_user_id uuid NOT NULL REFERENCES auth.users (id),
  due_on date,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  done_note text CHECK (done_note IS NULL OR length(btrim(done_note)) BETWEEN 1 AND 2000),
  done_at timestamptz,
  done_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  cancel_reason text CHECK (cancel_reason IS NULL OR length(btrim(cancel_reason)) BETWEEN 3 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT workflow_tasks_run_fkey FOREIGN KEY (run_id, organisation_id) REFERENCES public.workflow_runs (id, organisation_id),
  CONSTRAINT workflow_tasks_rule_fkey FOREIGN KEY (rule_id, organisation_id) REFERENCES public.workflow_rules (id, organisation_id),
  CONSTRAINT workflow_tasks_reference_key UNIQUE (organisation_id, reference),
  CONSTRAINT workflow_tasks_once UNIQUE (run_id, action_index),
  CONSTRAINT workflow_tasks_done CHECK ((status = 'done') = (done_at IS NOT NULL)),
  CONSTRAINT workflow_tasks_cancelled CHECK ((status = 'cancelled') = (cancel_reason IS NOT NULL))
);
CREATE INDEX workflow_tasks_assignee_idx ON public.workflow_tasks (organisation_id, assignee_user_id) WHERE status = 'open';

-- Row-level security: rules, versions and runs for workflows.read; a notice for its person; a task for its person or workflows.read. No table writes at all.
ALTER TABLE public.workflow_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_rule_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY workflow_rules_select ON public.workflow_rules FOR SELECT TO authenticated USING (app.has_permission(organisation_id, 'workflows.read'));
CREATE POLICY workflow_rule_versions_select ON public.workflow_rule_versions FOR SELECT TO authenticated USING (app.has_permission(organisation_id, 'workflows.read'));
CREATE POLICY workflow_runs_select ON public.workflow_runs FOR SELECT TO authenticated USING (app.has_permission(organisation_id, 'workflows.read'));
CREATE POLICY workflow_notices_select ON public.workflow_notices FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) AND app.is_member(organisation_id));
CREATE POLICY workflow_tasks_select ON public.workflow_tasks FOR SELECT TO authenticated
  USING ((assignee_user_id = (SELECT auth.uid()) AND app.is_member(organisation_id)) OR app.has_permission(organisation_id, 'workflows.read'));
REVOKE ALL ON public.workflow_rules, public.workflow_rule_versions, public.workflow_runs, public.workflow_notices, public.workflow_tasks FROM anon, authenticated;
GRANT SELECT ON public.workflow_rules, public.workflow_rule_versions, public.workflow_runs, public.workflow_notices, public.workflow_tasks TO authenticated;

CREATE TRIGGER workflow_rules_no_org_change BEFORE UPDATE OF organisation_id ON public.workflow_rules FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();

-- A version and a notice never change; a task changes only through its own functions (status, its note, who changed it).
CREATE FUNCTION app.workflow_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'This never changes once written' USING ERRCODE = 'QM028';
END $$;
CREATE TRIGGER workflow_rule_versions_frozen BEFORE UPDATE OR DELETE ON public.workflow_rule_versions FOR EACH ROW EXECUTE FUNCTION app.workflow_frozen();
CREATE TRIGGER workflow_notices_frozen BEFORE UPDATE OR DELETE ON public.workflow_notices FOR EACH ROW EXECUTE FUNCTION app.workflow_frozen();
CREATE TRIGGER workflow_tasks_no_delete BEFORE DELETE ON public.workflow_tasks FOR EACH ROW EXECUTE FUNCTION app.workflow_frozen();
CREATE TRIGGER workflow_rules_no_delete BEFORE DELETE ON public.workflow_rules FOR EACH ROW EXECUTE FUNCTION app.workflow_frozen();

CREATE FUNCTION app.workflow_task_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status', 'done_note', 'done_at', 'done_by', 'cancel_reason', 'updated_at', 'updated_by'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'done_note', 'done_at', 'done_by', 'cancel_reason', 'updated_at', 'updated_by']) THEN
    RAISE EXCEPTION 'Only a task''s status and note change' USING ERRCODE = 'QM028';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workflow_tasks_rules BEFORE UPDATE ON public.workflow_tasks FOR EACH ROW EXECUTE FUNCTION app.workflow_task_rules();

CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.workflow_rules FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.workflow_rule_versions FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.workflow_notices FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.workflow_tasks FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');

INSERT INTO public.notification_event_types
  (key, entity_type, action, group_name, entity_label, description, permission_code, default_on, default_permission_code, label_fields, display_order, own_record, email_default)
VALUES
  ('workflow_notices.created', 'workflow_notices', 'created', 'Workflows', 'Workflow notice', 'A workflow rule is telling you about something',
   'workflows.read', true, NULL, ARRAY['rule_name', 'record_label', 'message'], 1, true, true),
  ('workflow_tasks.created', 'workflow_tasks', 'created', 'Workflows', 'Workflow task', 'A task was given to you',
   'workflows.read', true, NULL, ARRAY['reference', 'title', 'record_label', 'due_label'], 2, true, true);

-- ---------------------------------------------------------------------------
-- Writing rules (workflows.manage). What a rule's conditions and actions may contain is checked by the API against the trigger catalogue; the database checks
-- the shape, the trigger and the versioning.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.save_workflow_rule(p_organisation_id uuid, p_data jsonb, p_rule uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  r public.workflow_rules%ROWTYPE; cur public.workflow_rule_versions%ROWTYPE;
  v_trigger text := p_data ->> 'trigger'; v_conditions jsonb := coalesce(p_data -> 'conditions', '{"all":[]}'::jsonb); v_actions jsonb := p_data -> 'actions';
  v_name text := nullif(btrim(coalesce(p_data ->> 'name', '')), ''); v_reason text := nullif(btrim(coalesce(p_data ->> 'reason', '')), '');
  v_n integer; v_id uuid;
BEGIN
  IF NOT app.has_permission(p_organisation_id, 'workflows.manage') THEN RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501'; END IF;
  IF p_rule IS NOT NULL THEN
    SELECT * INTO r FROM public.workflow_rules WHERE id = p_rule AND organisation_id = p_organisation_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Rule not found' USING ERRCODE = 'P0002'; END IF;
    IF r.status = 'retired' THEN RAISE EXCEPTION 'A retired rule cannot be changed; bring it back first' USING ERRCODE = 'QM028'; END IF;
    SELECT * INTO cur FROM public.workflow_rule_versions WHERE rule_id = r.id AND version = r.current_version;
    v_trigger := coalesce(v_trigger, cur.trigger);
    v_conditions := coalesce(p_data -> 'conditions', cur.conditions);
    v_actions := coalesce(v_actions, cur.actions);
  END IF;
  IF v_trigger IS NULL OR NOT EXISTS (SELECT 1 FROM app.workflow_triggers() t WHERE t.event_type = v_trigger) THEN
    RAISE EXCEPTION 'Choose what starts the rule' USING ERRCODE = 'QM028';
  END IF;
  IF jsonb_typeof(v_conditions) <> 'object' THEN RAISE EXCEPTION 'The conditions are not valid' USING ERRCODE = 'QM028'; END IF;
  IF v_actions IS NULL OR jsonb_typeof(v_actions) <> 'array' OR jsonb_array_length(v_actions) NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'A rule does between one and ten things' USING ERRCODE = 'QM028';
  END IF;

  IF p_rule IS NULL THEN
    IF v_name IS NULL THEN RAISE EXCEPTION 'Give the rule a name' USING ERRCODE = 'QM028'; END IF;
    INSERT INTO app.workflow_counters AS c (organisation_id, last_rule) VALUES (p_organisation_id, 1)
    ON CONFLICT (organisation_id) DO UPDATE SET last_rule = c.last_rule + 1 RETURNING last_rule INTO v_n;
    INSERT INTO public.workflow_rules (organisation_id, reference, name, description)
    VALUES (p_organisation_id, 'WF-' || app.pad_number(v_n, 3), v_name, nullif(btrim(coalesce(p_data ->> 'description', '')), ''))
    RETURNING id INTO v_id;
    INSERT INTO public.workflow_rule_versions (organisation_id, rule_id, version, trigger, conditions, actions)
    VALUES (p_organisation_id, v_id, 1, v_trigger, v_conditions, v_actions);
    RETURN v_id;
  END IF;

  UPDATE public.workflow_rules SET
    name = coalesce(v_name, name),
    description = CASE WHEN p_data ? 'description' THEN nullif(btrim(coalesce(p_data ->> 'description', '')), '') ELSE description END,
    updated_at = now(), updated_by = auth.uid()
   WHERE id = r.id;
  IF (v_trigger, v_conditions, v_actions) IS DISTINCT FROM (cur.trigger, cur.conditions, cur.actions) THEN
    IF v_reason IS NULL OR length(v_reason) < 3 THEN RAISE EXCEPTION 'Say why the rule is changing' USING ERRCODE = 'QM028'; END IF;
    INSERT INTO public.workflow_rule_versions (organisation_id, rule_id, version, trigger, conditions, actions, reason)
    VALUES (p_organisation_id, r.id, r.current_version + 1, v_trigger, v_conditions, v_actions, v_reason);
    UPDATE public.workflow_rules SET current_version = r.current_version + 1 WHERE id = r.id;
  END IF;
  RETURN r.id;
END $$;

-- Pause (runs nothing until resumed), resume, retire (with a reason; never deleted) or bring back a retired rule as paused.
CREATE FUNCTION app.set_workflow_rule_status(p_rule uuid, p_status text, p_reason text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.workflow_rules%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.workflow_rules WHERE id = p_rule FOR UPDATE;
  IF NOT FOUND OR NOT app.has_permission(r.organisation_id, 'workflows.read') THEN RAISE EXCEPTION 'Rule not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(r.organisation_id, 'workflows.manage') THEN RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501'; END IF;
  IF p_status NOT IN ('active', 'paused', 'retired') THEN RAISE EXCEPTION 'A rule is active, paused or retired' USING ERRCODE = 'QM028'; END IF;
  IF p_status = 'retired' AND length(btrim(coalesce(p_reason, ''))) < 3 THEN RAISE EXCEPTION 'Say why the rule is retired' USING ERRCODE = 'QM028'; END IF;
  IF r.status = 'retired' AND p_status = 'active' THEN RAISE EXCEPTION 'Bring a retired rule back as paused first' USING ERRCODE = 'QM028'; END IF;
  UPDATE public.workflow_rules SET status = p_status, status_reason = CASE WHEN p_status = 'retired' THEN btrim(p_reason) ELSE NULL END,
         updated_at = now(), updated_by = auth.uid() WHERE id = r.id;
END $$;

-- ---------------------------------------------------------------------------
-- The worker (API login only)
-- ---------------------------------------------------------------------------
-- The active rules started by this event type in this organisation, at their current version.
CREATE FUNCTION app.system_workflow_rules_for(p_organisation_id uuid, p_event_type text)
RETURNS TABLE (rule_id uuid, rule_version_id uuid, version integer, name text, conditions jsonb, actions jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT r.id, v.id, v.version, r.name, v.conditions, v.actions
    FROM public.workflow_rules r
    JOIN public.workflow_rule_versions v ON v.rule_id = r.id AND v.version = r.current_version
   WHERE r.organisation_id = p_organisation_id AND r.status = 'active' AND v.trigger = p_event_type
   ORDER BY r.reference
$$;

-- Records that a rule version matched an event (once: a second call returns the same run and created = false).
CREATE FUNCTION app.system_record_workflow_run(p_organisation_id uuid, p_rule_version_id uuid, p_event_id bigint, p_event_type text, p_entity_type text,
                                               p_entity_id uuid, p_facts jsonb)
RETURNS TABLE (run_id uuid, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_rule uuid; v_id uuid;
BEGIN
  SELECT v.rule_id INTO v_rule FROM public.workflow_rule_versions v WHERE v.id = p_rule_version_id AND v.organisation_id = p_organisation_id;
  IF v_rule IS NULL THEN RAISE EXCEPTION 'Rule version not found' USING ERRCODE = 'P0002'; END IF;
  INSERT INTO public.workflow_runs (organisation_id, rule_id, rule_version_id, event_id, event_type, entity_type, entity_id, facts)
  VALUES (p_organisation_id, v_rule, p_rule_version_id, p_event_id, p_event_type, p_entity_type, p_entity_id, coalesce(p_facts, '{}'::jsonb))
  ON CONFLICT ON CONSTRAINT workflow_runs_once DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN RETURN QUERY SELECT v_id, true; RETURN; END IF;
  RETURN QUERY SELECT w.id, false FROM public.workflow_runs w WHERE w.rule_version_id = p_rule_version_id AND w.event_id = p_event_id;
END $$;

-- Whether a person may be told about a run's record: an active member holding the trigger's permission at the record's site (checked as that person).
CREATE FUNCTION app.workflow_may_tell(p_organisation_id uuid, p_user uuid, p_permission text, p_site uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_claims text := coalesce(current_setting('request.jwt.claims', true), ''); v_ok boolean;
BEGIN
  IF p_user IS NULL THEN RETURN false; END IF;
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  v_ok := app.is_member(p_organisation_id) AND app.has_permission(p_organisation_id, p_permission, p_site);
  PERFORM set_config('request.jwt.claims', v_claims, true);
  RETURN coalesce(v_ok, false);
END $$;

-- The people one recipient entry names: {kind: person, userId} | {kind: role, roleId} | {kind: department, departmentId} | {kind: record_owner}.
CREATE FUNCTION app.workflow_recipient_users(p_organisation_id uuid, p_entry jsonb, p_facts jsonb) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT (p_entry ->> 'userId')::uuid WHERE p_entry ->> 'kind' = 'person'
  UNION
  SELECT m.user_id FROM public.user_role_assignments a JOIN public.organisation_users m ON m.id = a.membership_id
   WHERE p_entry ->> 'kind' = 'role' AND a.organisation_id = p_organisation_id AND a.role_id = (p_entry ->> 'roleId')::uuid
  UNION
  SELECT m.user_id FROM public.department_members d JOIN public.organisation_users m ON m.id = d.membership_id
   WHERE p_entry ->> 'kind' = 'department' AND d.organisation_id = p_organisation_id AND d.department_id = (p_entry ->> 'departmentId')::uuid AND d.ended_at IS NULL
  UNION
  SELECT (p_facts ->> 'owner_user_id')::uuid WHERE p_entry ->> 'kind' = 'record_owner' AND p_facts ->> 'owner_user_id' IS NOT NULL
$$;

-- Action "notify": a notice to everyone the recipients name who may read the record. Once per run, action and person. Returns {told, skipped}.
CREATE FUNCTION app.system_workflow_notify(p_run uuid, p_action_index integer, p_recipients jsonb, p_message text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  w public.workflow_runs%ROWTYPE; v_perm text; v_name text; u uuid; v_told integer := 0; v_skipped integer := 0; e jsonb;
BEGIN
  SELECT * INTO w FROM public.workflow_runs WHERE id = p_run;
  IF NOT FOUND THEN RAISE EXCEPTION 'Run not found' USING ERRCODE = 'P0002'; END IF;
  SELECT t.permission INTO v_perm FROM app.workflow_triggers() t WHERE t.event_type = w.event_type;
  SELECT r.name INTO v_name FROM public.workflow_rules r WHERE r.id = w.rule_id;
  IF jsonb_typeof(p_recipients) <> 'array' THEN RAISE EXCEPTION 'Recipients are a list' USING ERRCODE = '22023'; END IF;
  FOR u IN SELECT DISTINCT x FROM jsonb_array_elements(p_recipients) e(entry), app.workflow_recipient_users(w.organisation_id, e.entry, w.facts) x LOOP
    IF app.workflow_may_tell(w.organisation_id, u, v_perm, (w.facts ->> 'site_id')::uuid) THEN
      INSERT INTO public.workflow_notices (organisation_id, run_id, action_index, user_id, rule_name, message, record_kind, record_id, record_label)
      VALUES (w.organisation_id, w.id, p_action_index, u, v_name, left(coalesce(nullif(btrim(p_message), ''), v_name), 1000),
              coalesce(w.facts ->> 'record_kind', w.entity_type), coalesce((w.facts ->> 'record_id')::uuid, w.entity_id), left(coalesce(w.facts ->> 'label', w.entity_type), 300))
      ON CONFLICT ON CONSTRAINT workflow_notices_once DO NOTHING;
      IF FOUND THEN v_told := v_told + 1; END IF;
    ELSE
      v_skipped := v_skipped + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('told', v_told, 'skipped', v_skipped);
END $$;

-- Action "task": one task for one person (a named person, or the record's owner), who must be able to read the record. Once per run and action.
CREATE FUNCTION app.system_workflow_task(p_run uuid, p_action_index integer, p_assignee jsonb, p_title text, p_detail text, p_due_days integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  w public.workflow_runs%ROWTYPE; v_perm text; v_user uuid; v_year integer; v_n integer; v_id uuid; v_ref text; v_zone text;
BEGIN
  SELECT * INTO w FROM public.workflow_runs WHERE id = p_run;
  IF NOT FOUND THEN RAISE EXCEPTION 'Run not found' USING ERRCODE = 'P0002'; END IF;
  SELECT id, reference INTO v_id, v_ref FROM public.workflow_tasks WHERE run_id = w.id AND action_index = p_action_index;
  IF v_id IS NOT NULL THEN RETURN jsonb_build_object('taskId', v_id, 'reference', v_ref, 'created', false); END IF;
  SELECT t.permission INTO v_perm FROM app.workflow_triggers() t WHERE t.event_type = w.event_type;
  SELECT x INTO v_user FROM app.workflow_recipient_users(w.organisation_id, p_assignee, w.facts) x LIMIT 1;
  IF p_assignee ->> 'kind' NOT IN ('person', 'record_owner') THEN RAISE EXCEPTION 'A task goes to one person or the record''s owner' USING ERRCODE = '22023'; END IF;
  IF v_user IS NULL OR NOT app.workflow_may_tell(w.organisation_id, v_user, v_perm, (w.facts ->> 'site_id')::uuid) THEN
    RETURN jsonb_build_object('created', false, 'skipped', 'Nobody who may read the record to give it to');
  END IF;
  v_zone := app.organisation_time_zone(w.organisation_id);
  v_year := extract(year FROM (now() AT TIME ZONE v_zone))::int % 100;
  INSERT INTO app.workflow_task_counters AS c (organisation_id, year, last_value) VALUES (w.organisation_id, v_year, 1)
  ON CONFLICT (organisation_id, year) DO UPDATE SET last_value = c.last_value + 1 RETURNING last_value INTO v_n;
  v_ref := 'TSK-' || lpad(v_year::text, 2, '0') || '-' || app.pad_number(v_n, 4);
  INSERT INTO public.workflow_tasks (organisation_id, reference, run_id, action_index, rule_id, rule_name, title, detail, record_kind, record_id, record_label, site_id, permission,
                                     assignee_user_id, due_on)
  VALUES (w.organisation_id, v_ref, w.id, p_action_index, w.rule_id, (SELECT r.name FROM public.workflow_rules r WHERE r.id = w.rule_id), left(coalesce(nullif(btrim(p_title), ''), 'Follow up'), 200), nullif(left(btrim(coalesce(p_detail, '')), 2000), ''),
          coalesce(w.facts ->> 'record_kind', w.entity_type), coalesce((w.facts ->> 'record_id')::uuid, w.entity_id), left(coalesce(w.facts ->> 'label', w.entity_type), 300),
          (w.facts ->> 'site_id')::uuid, v_perm, v_user,
          CASE WHEN p_due_days IS NULL THEN NULL ELSE (now() AT TIME ZONE v_zone)::date + least(greatest(p_due_days, 0), 365) END)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('taskId', v_id, 'reference', v_ref, 'created', true);
END $$;

-- The outcome of one action of a run; the run is done when every action has an outcome (partial when one failed or was skipped entirely).
CREATE FUNCTION app.system_workflow_action_done(p_run uuid, p_action_index integer, p_ok boolean, p_result jsonb) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE w public.workflow_runs%ROWTYPE; v_total integer; v_results jsonb; v_status text;
BEGIN
  SELECT * INTO w FROM public.workflow_runs WHERE id = p_run FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Run not found' USING ERRCODE = 'P0002'; END IF;
  SELECT jsonb_array_length(v.actions) INTO v_total FROM public.workflow_rule_versions v WHERE v.id = w.rule_version_id;
  v_results := w.results || jsonb_build_object(p_action_index::text, coalesce(p_result, '{}'::jsonb) || jsonb_build_object('ok', p_ok));
  v_status := CASE WHEN (SELECT count(*) FROM jsonb_object_keys(v_results)) < v_total THEN 'running'
                   WHEN NOT EXISTS (SELECT 1 FROM jsonb_each(v_results) x WHERE NOT (x.value ->> 'ok')::boolean) THEN 'done'
                   WHEN NOT EXISTS (SELECT 1 FROM jsonb_each(v_results) x WHERE (x.value ->> 'ok')::boolean) THEN 'failed'
                   ELSE 'partial' END;
  UPDATE public.workflow_runs SET results = v_results, status = v_status, updated_at = now() WHERE id = w.id;
  RETURN v_status;
END $$;

-- ---------------------------------------------------------------------------
-- Tasks, for the people who have them
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.complete_workflow_task(p_task uuid, p_note text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE t public.workflow_tasks%ROWTYPE;
BEGIN
  SELECT * INTO t FROM public.workflow_tasks WHERE id = p_task FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(t.organisation_id) OR (t.assignee_user_id <> auth.uid() AND NOT app.has_permission(t.organisation_id, 'workflows.read')) THEN
    RAISE EXCEPTION 'Task not found' USING ERRCODE = 'P0002';
  END IF;
  IF t.assignee_user_id <> auth.uid() AND NOT app.has_permission(t.organisation_id, 'workflows.manage') THEN RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501'; END IF;
  IF t.status <> 'open' THEN RAISE EXCEPTION 'Only an open task can be marked done' USING ERRCODE = 'QM028'; END IF;
  UPDATE public.workflow_tasks SET status = 'done', done_note = nullif(btrim(coalesce(p_note, '')), ''), done_at = now(), done_by = auth.uid(), updated_at = now(), updated_by = auth.uid()
   WHERE id = t.id;
END $$;

CREATE FUNCTION app.reopen_workflow_task(p_task uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE t public.workflow_tasks%ROWTYPE;
BEGIN
  SELECT * INTO t FROM public.workflow_tasks WHERE id = p_task FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(t.organisation_id) OR (t.assignee_user_id <> auth.uid() AND NOT app.has_permission(t.organisation_id, 'workflows.read')) THEN
    RAISE EXCEPTION 'Task not found' USING ERRCODE = 'P0002';
  END IF;
  IF t.assignee_user_id <> auth.uid() AND NOT app.has_permission(t.organisation_id, 'workflows.manage') THEN RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501'; END IF;
  IF t.status <> 'done' THEN RAISE EXCEPTION 'Only a done task can be reopened' USING ERRCODE = 'QM028'; END IF;
  UPDATE public.workflow_tasks SET status = 'open', done_note = NULL, done_at = NULL, done_by = NULL, updated_at = now(), updated_by = auth.uid() WHERE id = t.id;
END $$;

-- Only someone who manages workflows cancels a task, with a reason (the person it was given to marks it done instead).
CREATE FUNCTION app.cancel_workflow_task(p_task uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE t public.workflow_tasks%ROWTYPE;
BEGIN
  SELECT * INTO t FROM public.workflow_tasks WHERE id = p_task FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(t.organisation_id) OR (t.assignee_user_id <> auth.uid() AND NOT app.has_permission(t.organisation_id, 'workflows.read')) THEN
    RAISE EXCEPTION 'Task not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT app.has_permission(t.organisation_id, 'workflows.manage') THEN RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501'; END IF;
  IF t.status <> 'open' THEN RAISE EXCEPTION 'Only an open task can be cancelled' USING ERRCODE = 'QM028'; END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 3 THEN RAISE EXCEPTION 'Say why the task is cancelled' USING ERRCODE = 'QM028'; END IF;
  UPDATE public.workflow_tasks SET status = 'cancelled', cancel_reason = btrim(p_reason), updated_at = now(), updated_by = auth.uid() WHERE id = t.id;
END $$;

-- ---------------------------------------------------------------------------
-- The notices: emit_notification as in 20260220100000, plus the workflow branches (addressed to the person, no actor).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.emit_notification() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_action text;
  v_type public.notification_event_types%ROWTYPE;
  v_row jsonb := coalesce(NEW.new_values, NEW.previous_values);
  v_what text;
  v_body text;
  v_details jsonb;
  v_recipient uuid;
  v_capa_row jsonb;
  v_comp_row jsonb;
  v_doc_row jsonb;
  v_risk_row jsonb;
  v_mr_row jsonb;
BEGIN
  -- A recipient row also changes when they view or acknowledge: only the withdrawal notice is worth a notification.
  IF NEW.entity_type = 'quality_alert_recipients' AND NEW.action = 'update' AND NOT (coalesce(NEW.changed_fields, '{}') @> ARRAY['withdrawn_notified_at']) THEN
    RETURN NULL;
  END IF;

  -- An 8D action notifies the person it is assigned to, when it is added with someone on it or handed to someone else; nothing else about it does.
  IF NEW.entity_type = 'capa_actions' AND (NEW.action = 'delete' OR (NEW.action = 'update' AND NOT (coalesce(NEW.changed_fields, '{}') @> ARRAY['owner_team_member_id']))) THEN
    RETURN NULL;
  END IF;

  -- An assessment is announced once, when it is made; superseding the earlier one is not news.
  IF NEW.entity_type = 'competence_assessments' AND NEW.action <> 'insert' THEN
    RETURN NULL;
  END IF;

  -- A sign-off, or a document to read, is announced to its person when it is created; their own view, decision or acknowledgement is not news to them.
  IF NEW.entity_type IN ('document_signoffs', 'document_recipients') AND NEW.action <> 'insert' THEN
    RETURN NULL;
  END IF;

  -- A change request is news to the person who asked only when it is accepted or declined.
  IF NEW.entity_type = 'document_change_requests' AND NOT (NEW.action = 'update' AND NEW.new_values ->> 'status' IN ('accepted', 'declined')) THEN
    RETURN NULL;
  END IF;

  -- A risk action is news to the person it is given to, when it is added or handed to them; a risk to its owner, likewise. Nothing else about either is.
  IF NEW.entity_type IN ('risk_actions', 'risks', 'management_review_actions') AND (NEW.action = 'delete' OR (NEW.action = 'update' AND NOT (coalesce(NEW.changed_fields, '{}') @> ARRAY['owner_user_id']))) THEN
    RETURN NULL;
  END IF;

  -- Reminders, workflow notices and workflow tasks are announced once, when written (a task's own progress is not news to its person).
  IF NEW.entity_type IN ('reminder_digests', 'reminder_overdue_notices', 'workflow_notices', 'workflow_tasks') AND NEW.action <> 'insert' THEN
    RETURN NULL;
  END IF;

  v_action := CASE
    WHEN NEW.action = 'insert' THEN 'created'
    WHEN NEW.action = 'delete' THEN 'deleted'
    WHEN NEW.changed_fields @> ARRAY['deleted_at'] AND NEW.new_values ->> 'deleted_at' IS NOT NULL THEN 'deleted'
    ELSE 'updated' END;

  SELECT * INTO v_type FROM public.notification_event_types t WHERE t.entity_type = NEW.entity_type AND t.action = v_action;
  IF NOT FOUND THEN RETURN NULL; END IF;

  v_row := coalesce(NEW.previous_values, '{}'::jsonb) || coalesce(NEW.new_values, '{}'::jsonb);
  IF NEW.action = 'insert' THEN v_row := NEW.new_values; END IF;
  IF NEW.action = 'delete' THEN v_row := NEW.previous_values; END IF;
  -- An update records only what changed; a recipient notice needs the person and the alert too.
  IF NEW.entity_type = 'quality_alert_recipients' AND NEW.action = 'update' THEN
    v_row := coalesce((SELECT to_jsonb(r) FROM public.quality_alert_recipients r WHERE r.id = NEW.entity_id::uuid), '{}'::jsonb) || v_row;
  END IF;

  IF NEW.entity_type = 'capa_actions' THEN
    SELECT to_jsonb(a) || jsonb_build_object('capa_reference', c.reference, 'capa_title', c.title, 'user_id', m.user_id)
      INTO v_capa_row
      FROM public.capa_actions a
      JOIN public.capas c ON c.id = a.capa_id
      LEFT JOIN public.capa_team_members t ON t.id = a.owner_team_member_id
      LEFT JOIN public.organisation_users m ON m.id = t.membership_id
     WHERE a.id = NEW.entity_id::uuid;
    IF v_capa_row IS NULL OR v_capa_row ->> 'user_id' IS NULL THEN RETURN NULL; END IF;
    v_row := v_capa_row;
  END IF;

  -- An assessment tells the person assessed (their linked sign-in) the skill and the level; nobody else, and no one without a sign-in.
  IF NEW.entity_type = 'competence_assessments' THEN
    SELECT to_jsonb(a) || jsonb_build_object(
             'user_id', e.auth_id, 'skill_name', k.name,
             'level_label', CASE a.level WHEN 0 THEN 'None' WHEN 1 THEN 'Learning' WHEN 2 THEN 'Supervised' WHEN 3 THEN 'Competent' ELSE 'Can train others' END || ' (' || a.level || ')')
      INTO v_comp_row
      FROM public.competence_assessments a
      JOIN public."Employees" e ON e.id = a.employee_id AND e.organisation_id = a.organisation_id
      JOIN public.competence_skills k ON k.id = a.skill_id
     WHERE a.id = NEW.entity_id::uuid;
    IF v_comp_row IS NULL OR v_comp_row ->> 'user_id' IS NULL THEN RETURN NULL; END IF;
    v_row := v_comp_row;
  END IF;

  -- A sign-off tells its reviewer or approver which document (number, letter and title) and what is asked of them.
  IF NEW.entity_type = 'document_signoffs' THEN
    SELECT to_jsonb(s) || jsonb_build_object(
             'document_id', d.id, 'revision_id', r.id,
             'document_label', d.number || ' rev ' || coalesce(r.letter, '?') || ' · ' || d.title,
             'role_label', CASE s.role WHEN 'reviewer' THEN 'Review it' ELSE 'Approve it' END)
      INTO v_doc_row
      FROM public.document_signoffs s
      JOIN public.document_revisions r ON r.id = s.revision_id
      JOIN public.documents d ON d.id = r.document_id
     WHERE s.id = NEW.entity_id::uuid;
    IF v_doc_row IS NULL THEN RETURN NULL; END IF;
    v_row := v_doc_row;
  END IF;

  -- A document to read tells its reader which revision and by when.
  IF NEW.entity_type = 'document_recipients' THEN
    SELECT to_jsonb(x) || jsonb_build_object(
             'document_id', d.id, 'revision_id', r.id,
             'document_label', d.number || ' rev ' || coalesce(r.letter, '?') || ' · ' || d.title,
             'due_label', CASE WHEN x.due_on IS NULL THEN NULL ELSE 'Acknowledge by ' || to_char(x.due_on, 'FMDD Mon YYYY') END)
      INTO v_doc_row
      FROM public.document_recipients x
      JOIN public.document_revisions r ON r.id = x.revision_id
      JOIN public.documents d ON d.id = r.document_id
     WHERE x.id = NEW.entity_id::uuid;
    IF v_doc_row IS NULL THEN RETURN NULL; END IF;
    v_row := v_doc_row;
  END IF;

  -- A decided change request tells the person who asked: which request, for which document, and the decision (with the reason when declined).
  IF NEW.entity_type = 'document_change_requests' THEN
    SELECT to_jsonb(c) || jsonb_build_object(
             'user_id', c.requested_by, 'document_id', d.id, 'revision_id', c.revision_id,
             'request_label', c.reference || ' · ' || d.number || ' ' || d.title,
             'decision_label', CASE c.status WHEN 'accepted' THEN 'Accepted: a revision is being written' ELSE 'Declined: ' || coalesce(c.decision_reason, '') END)
      INTO v_doc_row
      FROM public.document_change_requests c
      JOIN public.documents d ON d.id = c.document_id
     WHERE c.id = NEW.entity_id::uuid;
    IF v_doc_row IS NULL THEN RETURN NULL; END IF;
    v_row := v_doc_row;
  END IF;

  -- A risk action tells its person which risk, what to do and by when; a risk tells its new owner which one.
  IF NEW.entity_type = 'risk_actions' THEN
    SELECT to_jsonb(a) || jsonb_build_object(
             'user_id', a.owner_user_id, 'risk_id', r.id, 'risk_label', r.reference || ' · ' || r.title,
             'due_label', CASE WHEN a.due_date IS NULL THEN NULL ELSE 'Due ' || to_char(a.due_date, 'FMDD Mon YYYY') END)
      INTO v_risk_row
      FROM public.risk_actions a JOIN public.risks r ON r.id = a.risk_id
     WHERE a.id = NEW.entity_id::uuid AND a.status = 'open';
    -- Given to yourself: the notice would be for the person who did it, who is never told of their own action.
    IF v_risk_row IS NULL OR (v_risk_row ->> 'user_id')::uuid IS NOT DISTINCT FROM NEW.actor_user_id THEN RETURN NULL; END IF;
    v_row := v_risk_row;
  END IF;
  IF NEW.entity_type = 'risks' THEN
    SELECT to_jsonb(r) || jsonb_build_object('user_id', r.owner_user_id, 'risk_id', r.id, 'risk_label', r.reference || ' · ' || r.title,
             'kind_label', CASE r.kind WHEN 'opportunity' THEN 'Opportunity' ELSE 'Risk' END)
      INTO v_risk_row
      FROM public.risks r
     WHERE r.id = NEW.entity_id::uuid AND r.status NOT IN ('closed', 'retired');
    IF v_risk_row IS NULL OR (v_risk_row ->> 'user_id')::uuid IS NOT DISTINCT FROM NEW.actor_user_id THEN RETURN NULL; END IF;
    v_row := v_risk_row;
  END IF;

  -- A management review action tells its person which review, what to do and by when (they may hold no management review permission: own_record).
  IF NEW.entity_type = 'management_review_actions' THEN
    SELECT to_jsonb(a) || jsonb_build_object(
             'user_id', a.owner_user_id, 'review_id', m.id, 'review_label', m.reference || ' · ' || m.title,
             'due_label', CASE WHEN a.due_date IS NULL THEN NULL ELSE 'Due ' || to_char(a.due_date, 'FMDD Mon YYYY') END)
      INTO v_mr_row
      FROM public.management_review_actions a JOIN public.management_reviews m ON m.id = a.review_id
     WHERE a.id = NEW.entity_id::uuid AND a.status = 'open';
    IF v_mr_row IS NULL OR (v_mr_row ->> 'user_id')::uuid IS NOT DISTINCT FROM NEW.actor_user_id THEN RETURN NULL; END IF;
    v_row := v_mr_row;
  END IF;

  -- An overdue notice says what and since when; the area and the record behind it lead the link.
  IF NEW.entity_type = 'reminder_overdue_notices' THEN
    v_row := v_row || jsonb_build_object('due_label', 'Was due ' || to_char((v_row ->> 'due_on')::date, 'FMDD Mon YYYY'));
  END IF;

  -- A workflow task goes to its person (user_id) with when it is due; a workflow notice already names its person.
  IF NEW.entity_type = 'workflow_tasks' THEN
    v_row := v_row || jsonb_build_object('user_id', v_row ->> 'assignee_user_id', 'task_id', v_row ->> 'id',
                                         'due_label', CASE WHEN v_row ->> 'due_on' IS NULL THEN NULL ELSE 'Due ' || to_char((v_row ->> 'due_on')::date, 'FMDD Mon YYYY') END);
  END IF;

  v_body := nullif(concat_ws(' — ', VARIADIC (
    SELECT coalesce(array_agg(nullif(v_row ->> f, '') ORDER BY ord), '{}') FROM unnest(v_type.label_fields) WITH ORDINALITY AS u(f, ord))), '');
  IF v_action = 'updated' AND NEW.changed_fields IS NOT NULL
     AND NEW.entity_type NOT IN ('quality_alert_recipients', 'capa_actions', 'competence_assessments', 'document_signoffs', 'document_recipients', 'document_change_requests', 'risk_actions', 'risks', 'management_review_actions') THEN
    v_what := 'Changed: ' || replace(array_to_string(NEW.changed_fields, ', '), '_', ' ');
    v_body := concat_ws('. ', v_body, left(v_what, 200));
  END IF;

  SELECT coalesce(jsonb_object_agg(k, v_row -> k), '{}'::jsonb) INTO v_details
    FROM unnest(ARRAY['site_id', 'gauge_id', 'control_plan_id', 'part_id', 'source', 'stage', 'status', 'alert_id', 'capa_id', 'connection_id', 'run_id', 'kind',
                      'document_id', 'revision_id', 'role', 'risk_id', 'review_id', 'area', 'target_id', 'record_kind', 'record_id', 'task_id']) k
   WHERE v_row ->> k IS NOT NULL;

  -- Notices about one person's own alerts are for that person only.
  IF NEW.entity_type IN ('quality_alert_recipients', 'capa_actions', 'competence_assessments', 'document_signoffs', 'document_recipients', 'document_change_requests', 'risk_actions', 'risks', 'management_review_actions',
                         'reminder_digests', 'reminder_overdue_notices', 'workflow_notices', 'workflow_tasks') THEN
    v_recipient := (v_row ->> 'user_id')::uuid;
  END IF;

  INSERT INTO public.notifications (organisation_id, event_type_id, audit_event_id, entity_type, entity_id, title, body, details, actor_user_id, recipient_user_id)
  VALUES (NEW.organisation_id, v_type.id, NEW.id, NEW.entity_type, NEW.entity_id, v_type.description, v_body, v_details,
          CASE WHEN NEW.entity_type IN ('integration_alerts', 'document_recipients', 'reminder_digests', 'reminder_overdue_notices', 'workflow_notices', 'workflow_tasks') THEN NULL ELSE NEW.actor_user_id END,
          v_recipient)
  ON CONFLICT (audit_event_id) DO NOTHING;
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION app.workflow_triggers(), app.system_workflow_facts(uuid, text, uuid, jsonb), app.workflow_frozen(), app.workflow_task_rules(),
  app.save_workflow_rule(uuid, jsonb, uuid), app.set_workflow_rule_status(uuid, text, text), app.system_workflow_rules_for(uuid, text),
  app.system_record_workflow_run(uuid, uuid, bigint, text, text, uuid, jsonb), app.workflow_may_tell(uuid, uuid, text, uuid),
  app.workflow_recipient_users(uuid, jsonb, jsonb), app.system_workflow_notify(uuid, integer, jsonb, text), app.system_workflow_task(uuid, integer, jsonb, text, text, integer),
  app.system_workflow_action_done(uuid, integer, boolean, jsonb), app.complete_workflow_task(uuid, text), app.reopen_workflow_task(uuid), app.cancel_workflow_task(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.workflow_triggers(), app.save_workflow_rule(uuid, jsonb, uuid), app.set_workflow_rule_status(uuid, text, text),
  app.complete_workflow_task(uuid, text), app.reopen_workflow_task(uuid), app.cancel_workflow_task(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION app.system_workflow_facts(uuid, text, uuid, jsonb), app.system_workflow_rules_for(uuid, text),
  app.system_record_workflow_run(uuid, uuid, bigint, text, text, uuid, jsonb), app.system_workflow_notify(uuid, integer, jsonb, text),
  app.system_workflow_task(uuid, integer, jsonb, text, text, integer), app.system_workflow_action_done(uuid, integer, boolean, jsonb) TO qms_api;
