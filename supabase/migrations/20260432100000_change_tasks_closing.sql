-- Change management, slice CH3 (docs/change-management-plan.md): tasks with the real record they change, the stage that follows from them, and closing
-- with an effectiveness check.
--
--  * Once the board approves a change (CH2) it is carried out as TASKS: what to do, who does it, by when, in which impact area, and optionally the record
--    it changes — a part revision, a control plan revision, a document revision, a gauge type, a training session, a supplier, an inspection requirement,
--    a quality alert or a risk. The link is to the real record, so its live status is read from it, never copied. One open task per change per record.
--  * The stage after approval is WORKED OUT, never set by hand: approved (no live task yet) -> implementing (a task is open) -> verifying (every live task
--    done). Adding or reopening a task takes a verifying change back to implementing; cancelling every task takes it back to approved.
--  * A task is completed by a manager or by the person it was given to (who needs only change.read). A task linked to a revision can be completed only once
--    that revision is in force (or has since been replaced by a later one): a part revision released, a control plan revision effective, a document
--    revision effective. A done task can be reopened, a cancelled one cannot (add a new one); nothing is deleted.
--  * Verifying ends with the EFFECTIVENESS CHECK (change_reviews, append-only): effective closes the change, not effective sends it back to implementing so
--    a task can put it right. Closing needs the customer's approval decided when the change needs it, and every linked revision still in force.
--  * Cancelling a change cancels its open tasks. A revision already started for a task is left alone (information only).
--  * Notices: a task given to a person (added with them on it, or handed over) is announced to that person, never to whoever did it.
-- Errors QM035 (409 change_rule).

-- ---------------------------------------------------------------------------
-- 1. Closing, tasks and reviews
-- ---------------------------------------------------------------------------
ALTER TABLE public.change_requests
  ADD COLUMN closed_at timestamptz,
  ADD COLUMN closed_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  ADD CONSTRAINT change_requests_closed_state CHECK ((stage = 'closed') = (closed_at IS NOT NULL));

CREATE TABLE public.change_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  change_id uuid NOT NULL,
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 3 AND 1000),
  area_id uuid,
  owner_user_id uuid NOT NULL REFERENCES auth.users (id),
  due_on date,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  result_note text CHECK (result_note IS NULL OR length(btrim(result_note)) BETWEEN 1 AND 1000),
  done_at timestamptz,
  done_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  cancel_reason text CHECK (cancel_reason IS NULL OR length(btrim(cancel_reason)) BETWEEN 3 AND 500),
  reopen_reason text CHECK (reopen_reason IS NULL OR length(btrim(reopen_reason)) BETWEEN 3 AND 500),
  link_kind text CHECK (link_kind IS NULL OR link_kind IN ('part_revision', 'control_plan_revision', 'document_revision', 'gauge_type', 'training_session',
                                                           'supplier', 'inspection_requirement', 'quality_alert', 'risk')),
  part_revision_id uuid,
  control_plan_revision_id uuid,
  document_revision_id uuid,
  gauge_type_id uuid,
  training_session_id uuid,
  supplier_id uuid,
  inspection_requirement_id uuid,
  quality_alert_id uuid,
  risk_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT change_tasks_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT change_tasks_change_fkey FOREIGN KEY (change_id, organisation_id) REFERENCES public.change_requests (id, organisation_id),
  CONSTRAINT change_tasks_area_fkey FOREIGN KEY (area_id, organisation_id) REFERENCES public.change_areas (id, organisation_id),
  CONSTRAINT change_tasks_part_revision_fkey FOREIGN KEY (part_revision_id, organisation_id) REFERENCES public.part_revisions (id, organisation_id),
  CONSTRAINT change_tasks_plan_revision_fkey FOREIGN KEY (control_plan_revision_id, organisation_id) REFERENCES public.control_plan_revisions (id, organisation_id),
  CONSTRAINT change_tasks_document_revision_fkey FOREIGN KEY (document_revision_id, organisation_id) REFERENCES public.document_revisions (id, organisation_id),
  CONSTRAINT change_tasks_gauge_type_fkey FOREIGN KEY (gauge_type_id, organisation_id) REFERENCES public.gauge_types (id, organisation_id),
  CONSTRAINT change_tasks_training_fkey FOREIGN KEY (training_session_id, organisation_id) REFERENCES public.competence_training_sessions (id, organisation_id),
  CONSTRAINT change_tasks_supplier_fkey FOREIGN KEY (supplier_id, organisation_id) REFERENCES public.suppliers (id, organisation_id),
  CONSTRAINT change_tasks_requirement_fkey FOREIGN KEY (inspection_requirement_id, organisation_id) REFERENCES public.supplier_inspection_requirements (id, organisation_id),
  CONSTRAINT change_tasks_alert_fkey FOREIGN KEY (quality_alert_id, organisation_id) REFERENCES public.quality_alerts (id, organisation_id),
  CONSTRAINT change_tasks_risk_fkey FOREIGN KEY (risk_id, organisation_id) REFERENCES public.risks (id, organisation_id),
  CONSTRAINT change_tasks_link_state CHECK (
    num_nonnulls(part_revision_id, control_plan_revision_id, document_revision_id, gauge_type_id, training_session_id, supplier_id,
                 inspection_requirement_id, quality_alert_id, risk_id) = CASE WHEN link_kind IS NULL THEN 0 ELSE 1 END
    AND CASE link_kind
          WHEN 'part_revision' THEN part_revision_id IS NOT NULL
          WHEN 'control_plan_revision' THEN control_plan_revision_id IS NOT NULL
          WHEN 'document_revision' THEN document_revision_id IS NOT NULL
          WHEN 'gauge_type' THEN gauge_type_id IS NOT NULL
          WHEN 'training_session' THEN training_session_id IS NOT NULL
          WHEN 'supplier' THEN supplier_id IS NOT NULL
          WHEN 'inspection_requirement' THEN inspection_requirement_id IS NOT NULL
          WHEN 'quality_alert' THEN quality_alert_id IS NOT NULL
          WHEN 'risk' THEN risk_id IS NOT NULL
          ELSE true END),
  CONSTRAINT change_tasks_done_state CHECK ((status = 'done') = (done_at IS NOT NULL) AND (status = 'done' OR result_note IS NULL)),
  CONSTRAINT change_tasks_cancel_state CHECK ((status = 'cancelled') = (cancel_reason IS NOT NULL))
);
CREATE INDEX change_tasks_change_idx ON public.change_tasks (change_id);
CREATE INDEX change_tasks_owner_idx ON public.change_tasks (organisation_id, owner_user_id) WHERE status = 'open';
CREATE UNIQUE INDEX change_tasks_one_open_per_record ON public.change_tasks (
  change_id, coalesce(part_revision_id, control_plan_revision_id, document_revision_id, gauge_type_id, training_session_id, supplier_id,
                      inspection_requirement_id, quality_alert_id, risk_id))
  WHERE status = 'open' AND link_kind IS NOT NULL;

CREATE TABLE public.change_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  change_id uuid NOT NULL,
  result text NOT NULL CHECK (result IN ('effective', 'not_effective')),
  note text NOT NULL CHECK (length(btrim(note)) BETWEEN 3 AND 1000),
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT change_reviews_change_fkey FOREIGN KEY (change_id, organisation_id) REFERENCES public.change_requests (id, organisation_id)
);
CREATE INDEX change_reviews_change_idx ON public.change_reviews (change_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['change_tasks', 'change_reviews'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION app.stamp_created()', t || '_stamp', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.touch_updated()', t || '_touch', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change()', t || '_org_immutable', t);
    EXECUTE format('CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION audit.record_change(''organisation_id'')', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (app.has_permission(organisation_id, ''change.read''))', t || '_select', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Rules the tables hold even for SQL
-- ---------------------------------------------------------------------------
-- The change: the stages after approval move along the worked-out steps only (and close from verifying).
CREATE OR REPLACE FUNCTION app.change_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A change is never deleted. Cancel it with a reason.' USING ERRCODE = 'QM035'; END IF;
  IF NEW.reference IS DISTINCT FROM OLD.reference THEN RAISE EXCEPTION 'A change''s reference never changes' USING ERRCODE = 'QM035'; END IF;
  IF NEW.raised_by IS DISTINCT FROM OLD.raised_by THEN RAISE EXCEPTION 'Who raised a change never changes' USING ERRCODE = 'QM035'; END IF;
  IF (NEW.origin_kind, NEW.origin_id) IS DISTINCT FROM (OLD.origin_kind, OLD.origin_id) THEN
    RAISE EXCEPTION 'The record a change was raised from never changes' USING ERRCODE = 'QM035';
  END IF;
  IF OLD.stage IN ('cancelled', 'rejected', 'closed') AND (to_jsonb(NEW) - 'updated_at' - 'updated_by') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at' - 'updated_by') THEN
    RAISE EXCEPTION '% is % and cannot be changed', OLD.reference, OLD.stage USING ERRCODE = 'QM035';
  END IF;
  IF NEW.stage IS DISTINCT FROM OLD.stage AND NOT (
       (OLD.stage = 'draft'        AND NEW.stage IN ('assessment', 'cancelled'))
    OR (OLD.stage = 'assessment'   AND NEW.stage IN ('approval', 'cancelled'))
    OR (OLD.stage = 'approval'     AND NEW.stage IN ('assessment', 'approved', 'cancelled'))
    OR (OLD.stage = 'approved'     AND NEW.stage IN ('implementing', 'cancelled'))
    OR (OLD.stage = 'implementing' AND NEW.stage IN ('approved', 'verifying', 'cancelled'))
    OR (OLD.stage = 'verifying'    AND NEW.stage IN ('implementing', 'approved', 'closed', 'cancelled'))) THEN
    RAISE EXCEPTION '% cannot move from % to %', OLD.reference, OLD.stage, NEW.stage USING ERRCODE = 'QM035';
  END IF;
  IF OLD.stage NOT IN ('draft', 'assessment') AND (NEW.title, NEW.description, NEW.reason, NEW.urgency) IS DISTINCT FROM (OLD.title, OLD.description, OLD.reason, OLD.urgency) THEN
    RAISE EXCEPTION 'Once a change has been to the board its title, what, why and urgency no longer change' USING ERRCODE = 'QM035';
  END IF;
  IF OLD.stage <> 'draft' AND NEW.type_id IS DISTINCT FROM OLD.type_id THEN
    RAISE EXCEPTION 'The type of a change is fixed once it leaves draft' USING ERRCODE = 'QM035';
  END IF;
  RETURN NEW;
END $$;

-- A task: added once the change is approved and until it is closed; open -> done | cancelled, done -> open; a cancelled task never changes; nothing deleted.
CREATE FUNCTION app.change_task_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_stage text;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A task is never deleted. Cancel it with a reason.' USING ERRCODE = 'QM035'; END IF;
  SELECT stage INTO v_stage FROM public.change_requests WHERE id = NEW.change_id;
  IF v_stage IS NULL OR v_stage NOT IN ('approved', 'implementing', 'verifying') THEN
    RAISE EXCEPTION 'Tasks are added and changed once the board has approved the change and until it is closed' USING ERRCODE = 'QM035';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' THEN RAISE EXCEPTION 'A task starts open' USING ERRCODE = 'QM035'; END IF;
  ELSE
    IF NEW.change_id IS DISTINCT FROM OLD.change_id THEN RAISE EXCEPTION 'A task stays on its change' USING ERRCODE = 'QM035'; END IF;
    IF OLD.status = 'cancelled' THEN RAISE EXCEPTION 'A cancelled task cannot change: add a new one' USING ERRCODE = 'QM035'; END IF;
    IF OLD.status = 'done' AND NEW.status = 'done' THEN RAISE EXCEPTION 'A done task cannot change: reopen it first' USING ERRCODE = 'QM035'; END IF;
    IF OLD.status = 'done' AND NEW.status = 'cancelled' THEN RAISE EXCEPTION 'Reopen a done task before cancelling it' USING ERRCODE = 'QM035'; END IF;
    IF OLD.status = 'open' AND NEW.status <> 'open'
       AND (NEW.description, NEW.area_id, NEW.owner_user_id, NEW.due_on, NEW.link_kind) IS DISTINCT FROM (OLD.description, OLD.area_id, OLD.owner_user_id, OLD.due_on, OLD.link_kind) THEN
      RAISE EXCEPTION 'A task is finished or cancelled as it stands: change it first, then finish it' USING ERRCODE = 'QM035';
    END IF;
  END IF;
  IF (TG_OP = 'INSERT' OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id) AND NOT EXISTS (
       SELECT 1 FROM public.organisation_users ou WHERE ou.organisation_id = NEW.organisation_id AND ou.user_id = NEW.owner_user_id AND ou.status = 'active') THEN
    RAISE EXCEPTION 'A task can be given only to an active member of the organisation' USING ERRCODE = 'QM035';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER change_tasks_rules BEFORE INSERT OR UPDATE OR DELETE ON public.change_tasks FOR EACH ROW EXECUTE FUNCTION app.change_task_rules();

-- A review is a record: written once, never changed or deleted, even for SQL.
CREATE FUNCTION app.change_review_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'An effectiveness review is a record and never changes' USING ERRCODE = 'QM035';
END $$;
CREATE TRIGGER change_reviews_frozen BEFORE UPDATE OR DELETE ON public.change_reviews FOR EACH ROW EXECUTE FUNCTION app.change_review_rules();

-- After approval the stage follows the tasks: no live task -> approved; one open -> implementing; all done -> verifying.
CREATE FUNCTION app.change_recompute_stage(p_change uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_stage text; v_live integer; v_open integer; v_new text;
BEGIN
  SELECT stage INTO v_stage FROM public.change_requests WHERE id = p_change FOR UPDATE;
  IF v_stage IS NULL OR v_stage NOT IN ('approved', 'implementing', 'verifying') THEN RETURN; END IF;
  SELECT count(*) FILTER (WHERE status <> 'cancelled'), count(*) FILTER (WHERE status = 'open') INTO v_live, v_open FROM public.change_tasks WHERE change_id = p_change;
  v_new := CASE WHEN v_live = 0 THEN 'approved' WHEN v_open > 0 THEN 'implementing' ELSE 'verifying' END;
  IF v_new <> v_stage THEN UPDATE public.change_requests SET stage = v_new WHERE id = p_change; END IF;
END $$;

CREATE FUNCTION app.change_tasks_recompute() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.change_recompute_stage(NEW.change_id);
  RETURN NULL;
END $$;
CREATE TRIGGER change_tasks_stage AFTER INSERT OR UPDATE OF status ON public.change_tasks FOR EACH ROW EXECUTE FUNCTION app.change_tasks_recompute();

-- ---------------------------------------------------------------------------
-- 3. Where a task's record stands, and what is still needed to close
-- ---------------------------------------------------------------------------
-- none (no record, or a kind with no lifecycle) | in_force | replaced (a later one is in force now) | pending (not yet) | gone (withdrawn, obsolete, discarded…).
-- NULL when the caller cannot read changes.
CREATE FUNCTION app.change_task_link_state(p_task uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE t public.change_tasks%ROWTYPE; v text;
BEGIN
  SELECT * INTO t FROM public.change_tasks WHERE id = p_task;
  IF NOT FOUND OR NOT app.has_permission(t.organisation_id, 'change.read') THEN RETURN NULL; END IF;
  CASE t.link_kind
    WHEN 'part_revision' THEN
      SELECT CASE r.status WHEN 'released' THEN 'in_force' WHEN 'superseded' THEN 'replaced' WHEN 'draft' THEN 'pending' ELSE 'gone' END INTO v
        FROM public.part_revisions r WHERE r.id = t.part_revision_id;
    WHEN 'control_plan_revision' THEN
      SELECT CASE r.status WHEN 'effective' THEN 'in_force' WHEN 'superseded' THEN 'replaced' WHEN 'draft' THEN 'pending'
                           WHEN 'pending_approval' THEN 'pending' WHEN 'approved' THEN 'pending' ELSE 'gone' END INTO v
        FROM public.control_plan_revisions r WHERE r.id = t.control_plan_revision_id;
    WHEN 'document_revision' THEN
      SELECT CASE r.status WHEN 'effective' THEN 'in_force' WHEN 'superseded' THEN 'replaced' WHEN 'draft' THEN 'pending' WHEN 'in_review' THEN 'pending'
                           WHEN 'awaiting_approval' THEN 'pending' WHEN 'approved' THEN 'pending' ELSE 'gone' END INTO v
        FROM public.document_revisions r WHERE r.id = t.document_revision_id;
    ELSE v := 'none';
  END CASE;
  RETURN coalesce(v, 'none');
END $$;

-- 'close' joins 'submit' and 'board': the customer's approval is decided when the change needs it, and every done task's revision is still in force.
-- (The function is rewritten from its live definition by a checked text patch; see pg_temp.patch below.)
CREATE FUNCTION pg_temp.patch(p_fn regprocedure, p_old text, p_new text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_def text := replace(pg_get_functiondef(p_fn), E'\r', ''); v_n integer;
BEGIN
  v_n := (length(v_def) - length(replace(v_def, p_old, ''))) / length(p_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'Expected to find % exactly once in %, found % times', p_old, p_fn, v_n; END IF;
  EXECUTE replace(v_def, p_old, p_new);
END $$;

SELECT pg_temp.patch('app.change_problems(uuid, text)'::regprocedure,
  E'  RETURN v;\n',
  E'  IF p_target = ''close'' THEN\n'
  || E'    v_needs := coalesce((SELECT t.needs_customer_approval FROM public.change_types t WHERE t.id = c.type_id), false);\n'
  || E'    IF c.customer_approval IN (''required'', ''requested'', ''rejected'') OR (v_needs AND c.customer_approval IS NULL) THEN\n'
  || E'      v := v || ''The customer has not approved it: record their approval, or waive it with a reason''::text;\n'
  || E'    END IF;\n'
  || E'    FOR r IN SELECT k.id, k.description FROM public.change_tasks k WHERE k.change_id = c.id AND k.status = ''done'' LOOP\n'
  || E'      IF app.change_task_link_state(r.id) IN (''pending'', ''gone'') THEN\n'
  || E'        v := v || format(''Task "%s": the record it changes is not in force'', left(r.description, 60));\n'
  || E'      END IF;\n'
  || E'    END LOOP;\n'
  || E'    IF EXISTS (SELECT 1 FROM public.change_tasks k WHERE k.change_id = c.id AND k.status = ''open'') THEN v := v || ''A task is still open''::text; END IF;\n'
  || E'  END IF;\n'
  || E'  RETURN v;\n');

-- ---------------------------------------------------------------------------
-- 4. Functions (SECURITY DEFINER): the only way to write tasks and reviews
-- ---------------------------------------------------------------------------
-- The record a task changes: kind and id, in this organisation (NULL kind clears it). Internal: the caller's rights are checked by its callers.
CREATE FUNCTION app.change_task_set_link(p_task uuid, p_kind text, p_record uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE t public.change_tasks%ROWTYPE; v_table text; v_found boolean;
BEGIN
  SELECT * INTO t FROM public.change_tasks WHERE id = p_task;
  IF p_kind IS NOT NULL THEN
    v_table := CASE p_kind WHEN 'part_revision' THEN 'part_revisions' WHEN 'control_plan_revision' THEN 'control_plan_revisions'
                           WHEN 'document_revision' THEN 'document_revisions' WHEN 'gauge_type' THEN 'gauge_types'
                           WHEN 'training_session' THEN 'competence_training_sessions' WHEN 'supplier' THEN 'suppliers'
                           WHEN 'inspection_requirement' THEN 'supplier_inspection_requirements' WHEN 'quality_alert' THEN 'quality_alerts'
                           WHEN 'risk' THEN 'risks' END;
    IF v_table IS NULL OR p_record IS NULL THEN RAISE EXCEPTION 'Choose what kind of record the task changes, and which' USING ERRCODE = 'QM035'; END IF;
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE id = $1 AND organisation_id = $2)', v_table) INTO v_found USING p_record, t.organisation_id;
    IF NOT v_found THEN RAISE EXCEPTION 'That record is not in this organisation' USING ERRCODE = 'QM035'; END IF;
  END IF;
  BEGIN
    UPDATE public.change_tasks SET
      link_kind = p_kind,
      part_revision_id = CASE WHEN p_kind = 'part_revision' THEN p_record END,
      control_plan_revision_id = CASE WHEN p_kind = 'control_plan_revision' THEN p_record END,
      document_revision_id = CASE WHEN p_kind = 'document_revision' THEN p_record END,
      gauge_type_id = CASE WHEN p_kind = 'gauge_type' THEN p_record END,
      training_session_id = CASE WHEN p_kind = 'training_session' THEN p_record END,
      supplier_id = CASE WHEN p_kind = 'supplier' THEN p_record END,
      inspection_requirement_id = CASE WHEN p_kind = 'inspection_requirement' THEN p_record END,
      quality_alert_id = CASE WHEN p_kind = 'quality_alert' THEN p_record END,
      risk_id = CASE WHEN p_kind = 'risk' THEN p_record END
    WHERE id = p_task;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'This change already has an open task for that record' USING ERRCODE = 'QM035';
  END;
END $$;

-- p_data keys: description, ownerId, dueOn, areaId, link {kind, id}. Needs change.manage; the change must be approved and not closed.
CREATE FUNCTION app.add_change_task(p_change uuid, p_data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  c public.change_requests%ROWTYPE; v_id uuid; v_desc text := btrim(coalesce(p_data ->> 'description', '')); v_owner uuid; v_due date; v_area uuid;
BEGIN
  c := app.change_for_write(p_change);
  IF c.stage NOT IN ('approved', 'implementing', 'verifying') THEN RAISE EXCEPTION 'Tasks are added once the board has approved % and until it is closed', c.reference USING ERRCODE = 'QM035'; END IF;
  IF length(v_desc) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'Say what has to be done (3 to 1000 characters)' USING ERRCODE = 'QM035'; END IF;
  v_owner := nullif(p_data ->> 'ownerId', '')::uuid;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'Say who does it' USING ERRCODE = 'QM035'; END IF;
  v_due := nullif(p_data ->> 'dueOn', '')::date;
  v_area := nullif(p_data ->> 'areaId', '')::uuid;
  IF v_area IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.change_areas a WHERE a.id = v_area AND a.organisation_id = c.organisation_id) THEN
    RAISE EXCEPTION 'That impact area is not in this organisation' USING ERRCODE = 'QM035';
  END IF;
  INSERT INTO public.change_tasks (organisation_id, change_id, description, owner_user_id, due_on, area_id)
  VALUES (c.organisation_id, c.id, v_desc, v_owner, v_due, v_area) RETURNING id INTO v_id;
  IF p_data -> 'link' IS NOT NULL AND jsonb_typeof(p_data -> 'link') = 'object' THEN
    PERFORM app.change_task_set_link(v_id, p_data -> 'link' ->> 'kind', nullif(p_data -> 'link' ->> 'id', '')::uuid);
  END IF;
  RETURN v_id;
END $$;

-- Keys present are set: description, ownerId, dueOn (null clears), areaId (null clears). An open task only.
CREATE FUNCTION app.update_change_task(p_task uuid, p_data jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE t public.change_tasks%ROWTYPE; c public.change_requests%ROWTYPE; v_desc text; v_area uuid;
BEGIN
  SELECT * INTO t FROM public.change_tasks WHERE id = p_task;
  IF NOT FOUND THEN RAISE EXCEPTION 'Task not found' USING ERRCODE = 'P0002'; END IF;
  c := app.change_for_write(t.change_id);
  SELECT * INTO t FROM public.change_tasks WHERE id = p_task FOR UPDATE;
  IF t.status <> 'open' THEN RAISE EXCEPTION 'Only an open task can be changed' USING ERRCODE = 'QM035'; END IF;
  v_desc := t.description; v_area := t.area_id;
  IF p_data ? 'description' THEN
    v_desc := btrim(coalesce(p_data ->> 'description', ''));
    IF length(v_desc) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'Say what has to be done (3 to 1000 characters)' USING ERRCODE = 'QM035'; END IF;
  END IF;
  IF p_data ? 'areaId' THEN
    v_area := nullif(p_data ->> 'areaId', '')::uuid;
    IF v_area IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.change_areas a WHERE a.id = v_area AND a.organisation_id = c.organisation_id) THEN
      RAISE EXCEPTION 'That impact area is not in this organisation' USING ERRCODE = 'QM035';
    END IF;
  END IF;
  UPDATE public.change_tasks SET
    description = v_desc, area_id = v_area,
    owner_user_id = CASE WHEN p_data ? 'ownerId' THEN coalesce(nullif(p_data ->> 'ownerId', '')::uuid, t.owner_user_id) ELSE t.owner_user_id END,
    due_on = CASE WHEN p_data ? 'dueOn' THEN nullif(p_data ->> 'dueOn', '')::date ELSE t.due_on END
  WHERE id = t.id;
END $$;

-- Which record an open task changes (NULL kind takes the link away).
CREATE FUNCTION app.link_change_task(p_task uuid, p_kind text, p_record uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE t public.change_tasks%ROWTYPE;
BEGIN
  SELECT * INTO t FROM public.change_tasks WHERE id = p_task;
  IF NOT FOUND THEN RAISE EXCEPTION 'Task not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.change_for_write(t.change_id);
  SELECT * INTO t FROM public.change_tasks WHERE id = p_task FOR UPDATE;
  IF t.status <> 'open' THEN RAISE EXCEPTION 'Only an open task can be linked to a record' USING ERRCODE = 'QM035'; END IF;
  PERFORM app.change_task_set_link(t.id, p_kind, p_record);
END $$;

-- Done: a manager, or the person it was given to. A task that changes a revision needs that revision in force.
CREATE FUNCTION app.complete_change_task(p_task uuid, p_note text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE t public.change_tasks%ROWTYPE; v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_state text;
BEGIN
  SELECT * INTO t FROM public.change_tasks WHERE id = p_task;
  IF NOT FOUND OR NOT app.is_member(t.organisation_id) THEN RAISE EXCEPTION 'Task not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM 1 FROM public.change_requests WHERE id = t.change_id FOR UPDATE;
  SELECT * INTO t FROM public.change_tasks WHERE id = p_task FOR UPDATE;
  IF NOT (app.has_permission(t.organisation_id, 'change.manage') OR (t.owner_user_id = auth.uid() AND app.has_permission(t.organisation_id, 'change.read'))) THEN
    RAISE EXCEPTION 'Only a change manager or the person the task was given to can finish it' USING ERRCODE = '42501';
  END IF;
  IF t.status <> 'open' THEN RAISE EXCEPTION 'This task is not open' USING ERRCODE = 'QM035'; END IF;
  IF v_note IS NOT NULL AND length(v_note) > 1000 THEN RAISE EXCEPTION 'The result note is at most 1000 characters' USING ERRCODE = 'QM035'; END IF;
  v_state := app.change_task_link_state(t.id);
  IF v_state IN ('pending', 'gone') THEN
    RAISE EXCEPTION 'The record this task changes is not in force yet: release or approve it first' USING ERRCODE = 'QM035';
  END IF;
  UPDATE public.change_tasks SET status = 'done', done_at = now(), done_by = auth.uid(), result_note = v_note, reopen_reason = NULL WHERE id = t.id;
END $$;

CREATE FUNCTION app.cancel_change_task(p_task uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE t public.change_tasks%ROWTYPE; v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  SELECT * INTO t FROM public.change_tasks WHERE id = p_task;
  IF NOT FOUND THEN RAISE EXCEPTION 'Task not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.change_for_write(t.change_id);
  SELECT * INTO t FROM public.change_tasks WHERE id = p_task FOR UPDATE;
  IF t.status <> 'open' THEN RAISE EXCEPTION 'Only an open task can be cancelled' USING ERRCODE = 'QM035'; END IF;
  IF length(v_reason) < 3 THEN RAISE EXCEPTION 'Say why it is cancelled (at least 3 characters)' USING ERRCODE = 'QM035'; END IF;
  UPDATE public.change_tasks SET status = 'cancelled', cancel_reason = left(v_reason, 500) WHERE id = t.id;
END $$;

CREATE FUNCTION app.reopen_change_task(p_task uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE t public.change_tasks%ROWTYPE; v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  SELECT * INTO t FROM public.change_tasks WHERE id = p_task;
  IF NOT FOUND THEN RAISE EXCEPTION 'Task not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.change_for_write(t.change_id);
  SELECT * INTO t FROM public.change_tasks WHERE id = p_task FOR UPDATE;
  IF t.status <> 'done' THEN RAISE EXCEPTION 'Only a done task can be reopened' USING ERRCODE = 'QM035'; END IF;
  IF length(v_reason) < 3 THEN RAISE EXCEPTION 'Say why it is reopened (at least 3 characters)' USING ERRCODE = 'QM035'; END IF;
  UPDATE public.change_tasks SET status = 'open', done_at = NULL, done_by = NULL, result_note = NULL, reopen_reason = left(v_reason, 500) WHERE id = t.id;
END $$;

-- The effectiveness check, once every task is done (the change is verifying). Effective closes the change; not effective sends it back to implementing so
-- a task can put it right. A note is always needed. Needs change.manage.
CREATE FUNCTION app.record_change_review(p_change uuid, p_effective boolean, p_note text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.change_requests%ROWTYPE; v_note text := btrim(coalesce(p_note, '')); v_problems text[];
BEGIN
  c := app.change_for_write(p_change);
  IF c.stage <> 'verifying' THEN RAISE EXCEPTION '% is not waiting for its effectiveness check', c.reference USING ERRCODE = 'QM035'; END IF;
  IF length(v_note) < 3 THEN RAISE EXCEPTION 'Say what you checked and what you found (at least 3 characters)' USING ERRCODE = 'QM035'; END IF;
  IF p_effective THEN
    v_problems := app.change_problems(c.id, 'close');
    IF cardinality(v_problems) > 0 THEN RAISE EXCEPTION 'Not ready to close: %', array_to_string(v_problems, '; ') USING ERRCODE = 'QM035'; END IF;
  END IF;
  INSERT INTO public.change_reviews (organisation_id, change_id, result, note) VALUES (c.organisation_id, c.id, CASE WHEN p_effective THEN 'effective' ELSE 'not_effective' END, left(v_note, 1000));
  IF p_effective THEN
    UPDATE public.change_requests SET stage = 'closed', closed_at = now(), closed_by = auth.uid() WHERE id = c.id;
  ELSE
    UPDATE public.change_requests SET stage = 'implementing' WHERE id = c.id;
  END IF;
END $$;

-- Cancelling a change cancels its open tasks (a revision already started is left as it is).
SELECT pg_temp.patch('app.cancel_change(uuid, text)'::regprocedure,
  E'  UPDATE public.change_signoffs SET status = ''superseded'' WHERE change_id = c.id AND status = ''pending'';\n',
  E'  UPDATE public.change_signoffs SET status = ''superseded'' WHERE change_id = c.id AND status = ''pending'';\n'
  || E'  UPDATE public.change_tasks SET status = ''cancelled'', cancel_reason = ''The change was cancelled'' WHERE change_id = c.id AND status = ''open'';\n');

REVOKE ALL ON FUNCTION app.change_task_rules(), app.change_review_rules(), app.change_tasks_recompute(), app.change_recompute_stage(uuid),
  app.change_task_set_link(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.change_task_link_state(uuid), app.add_change_task(uuid, jsonb), app.update_change_task(uuid, jsonb), app.link_change_task(uuid, text, uuid),
  app.complete_change_task(uuid, text), app.cancel_change_task(uuid, text), app.reopen_change_task(uuid, text), app.record_change_review(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.change_task_link_state(uuid), app.add_change_task(uuid, jsonb), app.update_change_task(uuid, jsonb), app.link_change_task(uuid, text, uuid),
  app.complete_change_task(uuid, text), app.cancel_change_task(uuid, text), app.reopen_change_task(uuid, text), app.record_change_review(uuid, boolean, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. Who a column names, and notices
-- ---------------------------------------------------------------------------
-- A task's person is a standing responsibility but is handled as history: after a move to a company account an open task still names the old account,
-- and a change manager hands it to the new one.
SELECT pg_temp.patch(
  'app.user_reference_columns()'::regprocedure,
  $old$    ('change_signoffs', 'signer_user_id', 'history', 'Who was asked to sign; a sign-off still waiting for the old account is recalled and asked again'),$old$,
  $new$    ('change_signoffs', 'signer_user_id', 'history', 'Who was asked to sign; a sign-off still waiting for the old account is recalled and asked again'),
    ('change_tasks', 'owner_user_id', 'history', 'Who a change task was given to; after a move to a company account a change manager hands an open task to the new account'),$new$);

INSERT INTO public.notification_event_types
  (key, entity_type, action, group_name, entity_label, description, permission_code, default_on, default_permission_code, label_fields, display_order, own_record, email_default)
VALUES
  ('change_tasks.created', 'change_tasks', 'created', 'Change', 'Change task', 'A change task was given to you', 'change.read', true, NULL,
   ARRAY['change_label', 'description', 'due_label'], 12, true, true),
  ('change_tasks.updated', 'change_tasks', 'updated', 'Change', 'Change task', 'A change task was given to you', 'change.read', true, NULL,
   ARRAY['change_label', 'description', 'due_label'], 13, true, true);

-- The notification trigger with the change task branch: a task added with someone on it, or handed to someone else, is news to that person only, and never
-- to whoever did it. The stage moving after approval (worked out from the tasks) is not "approved by the board" again.
SELECT pg_temp.patch('app.emit_notification()'::regprocedure,
  E'  IF NEW.entity_type = ''change_signoffs'' AND NEW.action <> ''insert'' THEN RETURN NULL; END IF;\n',
  E'  IF NEW.entity_type = ''change_signoffs'' AND NEW.action <> ''insert'' THEN RETURN NULL; END IF;\n'
  || E'  IF NEW.entity_type = ''change_tasks'' AND (NEW.action = ''delete'' OR (NEW.action = ''update'' AND NOT (coalesce(NEW.changed_fields, ''{}'') @> ARRAY[''owner_user_id'']))) THEN RETURN NULL; END IF;\n');
SELECT pg_temp.patch('app.emit_notification()'::regprocedure,
  E'(v_change_row ->> ''stage'' = ''assessment'' AND coalesce(NEW.previous_values ->> ''stage'', '''') <> ''approval'')',
  E'coalesce(NEW.previous_values ->> ''stage'', '''') <> ''approval''');
SELECT pg_temp.patch('app.emit_notification()'::regprocedure,
  E'  -- An overdue notice says what and since when; the area and the record behind it lead the link.',
  E'  -- A change task tells its person which change, what to do and by when.\n'
  || E'  IF NEW.entity_type = ''change_tasks'' THEN\n'
  || E'    SELECT to_jsonb(t) || jsonb_build_object(''user_id'', t.owner_user_id, ''change_id'', c.id, ''change_label'', c.reference || '' · '' || c.title,\n'
  || E'             ''due_label'', CASE WHEN t.due_on IS NULL THEN NULL ELSE ''Due '' || to_char(t.due_on, ''FMDD Mon YYYY'') END)\n'
  || E'      INTO v_change_row FROM public.change_tasks t JOIN public.change_requests c ON c.id = t.change_id\n'
  || E'     WHERE t.id = NEW.entity_id::uuid AND t.status = ''open'';\n'
  || E'    IF v_change_row IS NULL OR (v_change_row ->> ''user_id'')::uuid IS NOT DISTINCT FROM NEW.actor_user_id THEN RETURN NULL; END IF;\n'
  || E'    v_row := v_change_row;\n  END IF;\n\n'
  || E'  -- An overdue notice says what and since when; the area and the record behind it lead the link.');
SELECT pg_temp.patch('app.emit_notification()'::regprocedure,
  E'''management_review_actions'', ''change_requests'') THEN\n    v_what := ''Changed: ''',
  E'''management_review_actions'', ''change_requests'', ''change_tasks'') THEN\n    v_what := ''Changed: ''');
SELECT pg_temp.patch('app.emit_notification()'::regprocedure,
  E'  IF NEW.entity_type IN (''change_signoffs'', ''change_requests'') THEN v_recipient := (v_row ->> ''user_id'')::uuid; END IF;',
  E'  IF NEW.entity_type IN (''change_signoffs'', ''change_requests'', ''change_tasks'') THEN v_recipient := (v_row ->> ''user_id'')::uuid; END IF;');
