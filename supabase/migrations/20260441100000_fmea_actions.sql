-- FMEA FM4 (docs/fmea-plan.md §7, decisions FM8, FM9, FM14): actions, revised ratings, adopting finished actions into a new revision, the periodic review, and a notice to
-- whoever an action is given to.
--
--  * fmea_actions: a prevention or detection action against one cause, with an owner (a member or an employee of the register), a due date, and open -> done | cancelled.
--    Done needs what was found (evidence) and may say the revised occurrence and detection; the database works out the revised RPN, priority and "needs attention" from
--    the revision's own model (never sent by a client). Actions are the part of an FMEA that stays alive while it is in force (FM9): they can be added, finished,
--    cancelled and reopened on a draft AND on the revision in force; structure, ratings and controls cannot.
--  * What happens to actions between revisions is deliberate and visible: when a revision takes effect, the open actions of the one it replaces are CARRIED to it (the
--    old row is cancelled with the reason "Carried on in rev B", or "The cause was removed in rev B"); a new revision can ADOPT the finished ones (the text joins the
--    cause's controls, the revised ratings become its ratings, the old row is stamped as adopted); discarding a draft un-adopts.
--  * A cause that needs attention is answered by a live action (open or done) or by the written reason of FM3; a cause with no control is answered by an action too.
--  * fmea_reviews (append-only): the periodic review of an FMEA in force, "no change needed" (with a note) or "revision started".
--  * Notice fmea_actions.created|updated: to the person an action is given to, never when they did it themselves.
-- Everything is written by functions; the tables have no INSERT, UPDATE or DELETE grants.

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
CREATE TABLE public.fmea_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  revision_id uuid NOT NULL,
  cause_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('prevention', 'detection')),
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 3 AND 1000),
  owner_user_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  owner_employee_id uuid,
  due_on date NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  evidence_note text CHECK (evidence_note IS NULL OR length(btrim(evidence_note)) BETWEEN 3 AND 1000),
  done_at timestamptz,
  done_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  cancel_reason text CHECK (cancel_reason IS NULL OR length(btrim(cancel_reason)) BETWEEN 3 AND 500),
  cancelled_at timestamptz,
  cancelled_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  -- What the person says it comes to once the action has been carried out; the worked-out figures are the database's.
  revised_occurrence integer CHECK (revised_occurrence IS NULL OR revised_occurrence BETWEEN 1 AND 10),
  revised_detection integer CHECK (revised_detection IS NULL OR revised_detection BETWEEN 1 AND 10),
  revised_rpn integer,
  revised_priority text CHECK (revised_priority IS NULL OR revised_priority IN ('high', 'medium', 'low')),
  revised_needs_attention boolean,
  adopted_in_revision_id uuid,
  prev_row_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT fmea_actions_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT fmea_actions_revision_fkey FOREIGN KEY (revision_id, organisation_id) REFERENCES public.fmea_revisions (id, organisation_id),
  CONSTRAINT fmea_actions_cause_fkey FOREIGN KEY (cause_id, organisation_id) REFERENCES public.fmea_causes (id, organisation_id) ON DELETE CASCADE,
  CONSTRAINT fmea_actions_employee_fkey FOREIGN KEY (owner_employee_id, organisation_id) REFERENCES public."Employees" (id, organisation_id),
  CONSTRAINT fmea_actions_adopted_fkey FOREIGN KEY (adopted_in_revision_id, organisation_id) REFERENCES public.fmea_revisions (id, organisation_id),
  CONSTRAINT fmea_actions_prev_fkey FOREIGN KEY (prev_row_id, organisation_id) REFERENCES public.fmea_actions (id, organisation_id),
  CONSTRAINT fmea_actions_one_owner CHECK (num_nonnulls(owner_user_id, owner_employee_id) = 1),
  CONSTRAINT fmea_actions_done_check CHECK ((status = 'done') = (done_at IS NOT NULL) AND (status = 'done') = (evidence_note IS NOT NULL)),
  CONSTRAINT fmea_actions_cancel_check CHECK ((status = 'cancelled') = (cancel_reason IS NOT NULL) AND (status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CONSTRAINT fmea_actions_revised_check CHECK (
    (revised_rpn IS NULL) = (revised_priority IS NULL) AND (revised_priority IS NULL) = (revised_needs_attention IS NULL)
    AND (status = 'done' OR num_nonnulls(revised_occurrence, revised_detection, revised_rpn) = 0)),
  CONSTRAINT fmea_actions_adopted_check CHECK (adopted_in_revision_id IS NULL OR status = 'done')
);
CREATE INDEX fmea_actions_cause_idx ON public.fmea_actions (organisation_id, cause_id);
CREATE INDEX fmea_actions_revision_idx ON public.fmea_actions (organisation_id, revision_id, status);
CREATE INDEX fmea_actions_owner_user_idx ON public.fmea_actions (owner_user_id, status) WHERE owner_user_id IS NOT NULL;
CREATE INDEX fmea_actions_owner_employee_idx ON public.fmea_actions (owner_employee_id, status) WHERE owner_employee_id IS NOT NULL;
CREATE UNIQUE INDEX fmea_actions_prev_key ON public.fmea_actions (prev_row_id) WHERE prev_row_id IS NOT NULL;

CREATE TABLE public.fmea_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  fmea_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('no_change', 'revision_started')),
  note text CHECK (note IS NULL OR length(btrim(note)) BETWEEN 3 AND 1000),
  started_revision_id uuid,
  was_due_on date,
  next_review_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT fmea_reviews_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT fmea_reviews_fmea_fkey FOREIGN KEY (fmea_id, organisation_id) REFERENCES public.fmeas (id, organisation_id),
  CONSTRAINT fmea_reviews_revision_fkey FOREIGN KEY (revision_id, organisation_id) REFERENCES public.fmea_revisions (id, organisation_id),
  CONSTRAINT fmea_reviews_started_fkey FOREIGN KEY (started_revision_id, organisation_id) REFERENCES public.fmea_revisions (id, organisation_id),
  CONSTRAINT fmea_reviews_state_check CHECK ((outcome = 'no_change' AND note IS NOT NULL AND started_revision_id IS NULL) OR (outcome = 'revision_started' AND started_revision_id IS NOT NULL))
);
CREATE INDEX fmea_reviews_fmea_idx ON public.fmea_reviews (organisation_id, fmea_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 2. Rules the tables hold even for SQL
-- ---------------------------------------------------------------------------
-- fmea_action_system = 'on' (set only by the functions below, for their own transaction) lets two things through that a person cannot do: cancelling an open action with a
-- reason when its revision has been replaced, withdrawn or discarded, and stamping or clearing `adopted_in_revision_id`.
CREATE FUNCTION app.fmea_action_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_status text; v_system boolean := coalesce(current_setting('app.fmea_action_system', true), '') = 'on';
  c public.fmea_causes%ROWTYPE; v_config jsonb; v_kind text; v_o integer; v_d integer; sc jsonb; v_skip text[] := ARRAY['updated_at', 'updated_by'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT status INTO v_status FROM public.fmea_revisions WHERE id = OLD.revision_id;
    IF v_status IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'An action is removed only with the draft it is on: cancel it instead' USING ERRCODE = 'QM036'; END IF;
    RETURN OLD;
  END IF;

  SELECT status INTO v_status FROM public.fmea_revisions WHERE id = NEW.revision_id;
  SELECT * INTO c FROM public.fmea_causes WHERE id = NEW.cause_id;
  IF c.id IS NULL OR c.revision_id <> NEW.revision_id THEN RAISE EXCEPTION 'An action belongs to a cause of its own revision' USING ERRCODE = 'QM036'; END IF;

  IF TG_OP = 'INSERT' THEN
    IF v_status NOT IN ('draft', 'effective') THEN RAISE EXCEPTION 'Actions are added to a draft or to the revision in force' USING ERRCODE = 'QM036'; END IF;
    IF NEW.status <> 'open' OR num_nonnulls(NEW.evidence_note, NEW.done_at, NEW.cancel_reason, NEW.adopted_in_revision_id, NEW.revised_occurrence, NEW.revised_detection) > 0 THEN
      RAISE EXCEPTION 'An action starts open and empty' USING ERRCODE = 'QM036';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.revision_id, NEW.cause_id, NEW.prev_row_id, NEW.organisation_id) IS DISTINCT FROM (OLD.revision_id, OLD.cause_id, OLD.prev_row_id, OLD.organisation_id) THEN
    RAISE EXCEPTION 'An action stays on its cause' USING ERRCODE = 'QM036';
  END IF;

  IF v_system THEN
    -- Only two things: a cancellation with a reason, or the adopted stamp.
    IF (to_jsonb(OLD) - (v_skip || ARRAY['status', 'cancel_reason', 'cancelled_at', 'cancelled_by', 'adopted_in_revision_id']))
       IS DISTINCT FROM (to_jsonb(NEW) - (v_skip || ARRAY['status', 'cancel_reason', 'cancelled_at', 'cancelled_by', 'adopted_in_revision_id'])) THEN
      RAISE EXCEPTION 'The system may only cancel or adopt an action' USING ERRCODE = 'QM036';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF NOT (OLD.status = 'open' AND NEW.status = 'cancelled' AND NEW.cancel_reason IS NOT NULL) THEN RAISE EXCEPTION 'The system may only cancel an open action' USING ERRCODE = 'QM036'; END IF;
      NEW.cancelled_at := now(); NEW.cancelled_by := auth.uid();
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.adopted_in_revision_id IS DISTINCT FROM OLD.adopted_in_revision_id THEN RAISE EXCEPTION 'Adopting an action is done by starting a revision' USING ERRCODE = 'QM036'; END IF;
  IF v_status NOT IN ('draft', 'effective') THEN RAISE EXCEPTION 'Actions change on a draft or on the revision in force, not on a revision that is %', replace(v_status, '_', ' ') USING ERRCODE = 'QM036'; END IF;

  IF OLD.status = 'cancelled' THEN RAISE EXCEPTION 'A cancelled action stays cancelled' USING ERRCODE = 'QM036'; END IF;
  IF OLD.status = 'open' AND NEW.status = 'open' THEN
    IF num_nonnulls(NEW.evidence_note, NEW.done_at, NEW.revised_occurrence, NEW.revised_detection) > 0 THEN RAISE EXCEPTION 'The result is written when the action is done' USING ERRCODE = 'QM036'; END IF;
  ELSIF OLD.status = 'open' AND NEW.status = 'done' THEN
    IF NEW.evidence_note IS NULL THEN RAISE EXCEPTION 'Say what was found: the action is done with its evidence' USING ERRCODE = 'QM036'; END IF;
    NEW.done_at := now(); NEW.done_by := auth.uid();
  ELSIF OLD.status = 'open' AND NEW.status = 'cancelled' THEN
    IF NEW.cancel_reason IS NULL THEN RAISE EXCEPTION 'Say why the action is cancelled' USING ERRCODE = 'QM036'; END IF;
    NEW.cancelled_at := now(); NEW.cancelled_by := auth.uid();
  ELSIF OLD.status = 'done' AND NEW.status = 'open' THEN
    IF OLD.adopted_in_revision_id IS NOT NULL THEN RAISE EXCEPTION 'This action has been taken into a later revision and cannot be reopened' USING ERRCODE = 'QM036'; END IF;
    NEW.evidence_note := NULL; NEW.done_at := NULL; NEW.done_by := NULL;
    NEW.revised_occurrence := NULL; NEW.revised_detection := NULL; NEW.revised_rpn := NULL; NEW.revised_priority := NULL; NEW.revised_needs_attention := NULL;
  ELSIF OLD.status = 'done' AND NEW.status = 'done' THEN
    -- Only the worked-out figures may move (a re-score of the cause on a draft); what was found and said stays.
    IF (to_jsonb(OLD) - (v_skip || ARRAY['revised_rpn', 'revised_priority', 'revised_needs_attention']))
       IS DISTINCT FROM (to_jsonb(NEW) - (v_skip || ARRAY['revised_rpn', 'revised_priority', 'revised_needs_attention'])) THEN
      RAISE EXCEPTION 'A finished action is changed by reopening it first' USING ERRCODE = 'QM036';
    END IF;
  ELSE
    RAISE EXCEPTION 'An action cannot move from % to %', OLD.status, NEW.status USING ERRCODE = 'QM036';
  END IF;

  -- The worked-out revised figures: severity of the cause, the revised (else current) occurrence and detection, the revision's own model.
  IF NEW.status = 'done' THEN
    NEW.revised_rpn := NULL; NEW.revised_priority := NULL; NEW.revised_needs_attention := NULL;
    IF NEW.revised_occurrence IS NOT NULL OR NEW.revised_detection IS NOT NULL THEN
      v_o := coalesce(NEW.revised_occurrence, c.occurrence); v_d := coalesce(NEW.revised_detection, c.detection);
      IF c.severity_used IS NULL OR v_o IS NULL OR v_d IS NULL THEN
        RAISE EXCEPTION 'Rate the cause (severity from its effects, occurrence and detection) before saying what the action changes' USING ERRCODE = 'QM036';
      END IF;
      SELECT mo.config, f.kind INTO v_config, v_kind
        FROM public.fmea_revisions r JOIN public.fmeas f ON f.id = r.fmea_id JOIN public.fmea_models mo ON mo.id = r.model_id WHERE r.id = NEW.revision_id;
      sc := app.fmea_score(v_config, v_kind, c.severity_used, v_o, v_d);
      NEW.revised_rpn := (sc ->> 'rpn')::integer; NEW.revised_priority := sc ->> 'priority'; NEW.revised_needs_attention := (sc ->> 'needsAttention')::boolean;
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER fmea_actions_rules BEFORE INSERT OR UPDATE OR DELETE ON public.fmea_actions FOR EACH ROW EXECUTE FUNCTION app.fmea_action_rules();
CREATE TRIGGER fmea_actions_stamp BEFORE INSERT ON public.fmea_actions FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER fmea_actions_touch BEFORE UPDATE ON public.fmea_actions FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER fmea_actions_org_immutable BEFORE UPDATE ON public.fmea_actions FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.fmea_actions FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');

CREATE FUNCTION app.fmea_review_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN RAISE EXCEPTION 'A review is a record: it is never changed or removed' USING ERRCODE = 'QM036'; END $$;
CREATE TRIGGER fmea_reviews_frozen BEFORE UPDATE OR DELETE ON public.fmea_reviews FOR EACH ROW EXECUTE FUNCTION app.fmea_review_frozen();
CREATE TRIGGER fmea_reviews_stamp BEFORE INSERT ON public.fmea_reviews FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER fmea_reviews_org_immutable BEFORE UPDATE ON public.fmea_reviews FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.fmea_reviews FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');

ALTER TABLE public.fmea_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fmea_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fmea_actions, public.fmea_reviews FROM anon, authenticated;
GRANT SELECT ON public.fmea_actions, public.fmea_reviews TO authenticated;
CREATE POLICY fmea_actions_select ON public.fmea_actions FOR SELECT TO authenticated USING (app.fmea_revision_readable(revision_id));
CREATE POLICY fmea_reviews_select ON public.fmea_reviews FOR SELECT TO authenticated USING (app.fmea_readable(fmea_id));

-- ---------------------------------------------------------------------------
-- 3. Re-scoring a cause also re-works the revised figures of its finished actions (the same trigger does it: it sees the cause as it now is)
-- ---------------------------------------------------------------------------
CREATE FUNCTION pg_temp.patch(p_fn regprocedure, p_old text, p_new text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_def text := replace(pg_get_functiondef(p_fn), E'\r', ''); v_n integer;
BEGIN
  v_n := (length(v_def) - length(replace(v_def, p_old, ''))) / length(p_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'Expected to find % exactly once in %, found % times', p_old, p_fn, v_n; END IF;
  EXECUTE replace(v_def, p_old, p_new);
END $$;

SELECT pg_temp.patch('app.fmea_rescore_mode(uuid)'::regprocedure,
  $old$OR c.priority IS DISTINCT FROM s.sc ->> 'priority' OR c.needs_attention IS DISTINCT FROM (s.sc ->> 'needsAttention')::boolean);$old$,
  $new$OR c.priority IS DISTINCT FROM s.sc ->> 'priority' OR c.needs_attention IS DISTINCT FROM (s.sc ->> 'needsAttention')::boolean);
  -- A finished action's revised figures depend on its cause: touching the row has the trigger work them out again.
  UPDATE public.fmea_actions a SET revised_rpn = a.revised_rpn
   WHERE a.status = 'done' AND a.cause_id IN (SELECT x.id FROM public.fmea_causes x WHERE x.failure_mode_id = p_mode);$new$);

-- ---------------------------------------------------------------------------
-- 4. Who may do what with an action
-- ---------------------------------------------------------------------------
-- The person an action is given to: a member by account, an employee through the account linked to their record.
CREATE FUNCTION app.fmea_action_is_owner(p_action uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.fmea_actions a LEFT JOIN public."Employees" e ON e.id = a.owner_employee_id AND e.organisation_id = a.organisation_id
     WHERE a.id = p_action AND app.is_member(a.organisation_id) AND (a.owner_user_id = auth.uid() OR e.auth_id = auth.uid()))
$$;

-- Locks an action for writing. `p_owner_may`: the person it is given to may do this with only the read permission (finishing and reopening their own).
CREATE FUNCTION app.fmea_action_for_write(p_action uuid, p_owner_may boolean) RETURNS public.fmea_actions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.fmea_actions%ROWTYPE;
BEGIN
  SELECT * INTO a FROM public.fmea_actions WHERE id = p_action FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(a.organisation_id) THEN RAISE EXCEPTION 'Action not found' USING ERRCODE = 'P0002'; END IF;
  IF app.has_permission(a.organisation_id, 'fmea.manage') THEN RETURN a; END IF;
  IF p_owner_may AND app.fmea_action_is_owner(a.id) AND app.has_permission(a.organisation_id, 'fmea.read') THEN RETURN a; END IF;
  RAISE EXCEPTION 'You are not allowed to change this action' USING ERRCODE = '42501';
END $$;

-- Checks the person an action is given to: exactly one of a member or an employee, active, of this organisation.
CREATE FUNCTION app.fmea_action_owner(p_organisation_id uuid, p_data jsonb, OUT o_user uuid, OUT o_employee uuid) RETURNS record
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  BEGIN o_user := nullif(p_data ->> 'ownerUserId', '')::uuid; o_employee := nullif(p_data ->> 'ownerEmployeeId', '')::uuid;
  EXCEPTION WHEN others THEN RAISE EXCEPTION 'The owner is named by id' USING ERRCODE = 'QM036'; END;
  IF num_nonnulls(o_user, o_employee) <> 1 THEN RAISE EXCEPTION 'Give the action to a member or to an employee' USING ERRCODE = 'QM036'; END IF;
  IF o_user IS NOT NULL AND NOT app.is_active_member_user(p_organisation_id, o_user) THEN RAISE EXCEPTION 'An action is given to an active member of this organisation' USING ERRCODE = 'QM036'; END IF;
  IF o_employee IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public."Employees" x WHERE x.id = o_employee AND x.organisation_id = p_organisation_id AND x.active) THEN
    RAISE EXCEPTION 'An action is given to an active employee of this organisation' USING ERRCODE = 'QM036';
  END IF;
END $$;

-- Keys: kind (prevention | detection), description, ownerUserId | ownerEmployeeId, dueOn (today or later).
CREATE FUNCTION app.add_fmea_action(p_cause uuid, p_data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.fmea_causes%ROWTYPE; v_status text; v_kind text; v_desc text; v_due date; v_user uuid; v_emp uuid; v_id uuid;
BEGIN
  SELECT * INTO c FROM public.fmea_causes WHERE id = p_cause;
  IF NOT FOUND OR NOT app.is_member(c.organisation_id) THEN RAISE EXCEPTION 'Cause not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_fmea_manager(c.organisation_id);
  PERFORM app.fmea_keys(p_data, ARRAY['kind', 'description', 'ownerUserId', 'ownerEmployeeId', 'dueOn']);
  SELECT status INTO v_status FROM public.fmea_revisions WHERE id = c.revision_id;
  IF v_status NOT IN ('draft', 'effective') THEN RAISE EXCEPTION 'Actions are added to a draft or to the revision in force, not to one that is %', replace(v_status, '_', ' ') USING ERRCODE = 'QM036'; END IF;
  v_kind := p_data ->> 'kind';
  IF v_kind IS NULL OR v_kind NOT IN ('prevention', 'detection') THEN RAISE EXCEPTION 'An action prevents the cause or detects it' USING ERRCODE = 'QM036'; END IF;
  v_desc := btrim(coalesce(p_data ->> 'description', ''));
  IF length(v_desc) < 3 THEN RAISE EXCEPTION 'Say what is to be done (at least 3 characters)' USING ERRCODE = 'QM036'; END IF;
  IF length(v_desc) > 1000 THEN RAISE EXCEPTION 'The action is up to 1000 characters' USING ERRCODE = 'QM036'; END IF;
  BEGIN v_due := nullif(p_data ->> 'dueOn', '')::date; EXCEPTION WHEN others THEN RAISE EXCEPTION 'The due date is a date' USING ERRCODE = 'QM036'; END;
  IF v_due IS NULL THEN RAISE EXCEPTION 'Say when it is due' USING ERRCODE = 'QM036'; END IF;
  IF v_due < current_date THEN RAISE EXCEPTION 'The due date is today or later' USING ERRCODE = 'QM036'; END IF;
  SELECT o_user, o_employee INTO v_user, v_emp FROM app.fmea_action_owner(c.organisation_id, p_data);
  INSERT INTO public.fmea_actions (organisation_id, revision_id, cause_id, kind, description, owner_user_id, owner_employee_id, due_on)
  VALUES (c.organisation_id, c.revision_id, c.id, v_kind, v_desc, v_user, v_emp, v_due) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Changes an open action: any of the same keys. The due date may move to any day.
CREATE FUNCTION app.update_fmea_action(p_id uuid, p_data jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.fmea_actions%ROWTYPE; v_kind text; v_desc text; v_due date; v_user uuid; v_emp uuid;
BEGIN
  a := app.fmea_action_for_write(p_id, false);
  PERFORM app.fmea_keys(p_data, ARRAY['kind', 'description', 'ownerUserId', 'ownerEmployeeId', 'dueOn']);
  IF a.status <> 'open' THEN RAISE EXCEPTION 'Only an open action can be changed' USING ERRCODE = 'QM036'; END IF;
  v_kind := coalesce(p_data ->> 'kind', a.kind);
  IF v_kind NOT IN ('prevention', 'detection') THEN RAISE EXCEPTION 'An action prevents the cause or detects it' USING ERRCODE = 'QM036'; END IF;
  v_desc := CASE WHEN p_data ? 'description' THEN btrim(coalesce(p_data ->> 'description', '')) ELSE a.description END;
  IF length(v_desc) < 3 THEN RAISE EXCEPTION 'Say what is to be done (at least 3 characters)' USING ERRCODE = 'QM036'; END IF;
  IF length(v_desc) > 1000 THEN RAISE EXCEPTION 'The action is up to 1000 characters' USING ERRCODE = 'QM036'; END IF;
  BEGIN v_due := CASE WHEN p_data ? 'dueOn' THEN nullif(p_data ->> 'dueOn', '')::date ELSE a.due_on END; EXCEPTION WHEN others THEN RAISE EXCEPTION 'The due date is a date' USING ERRCODE = 'QM036'; END;
  IF v_due IS NULL THEN RAISE EXCEPTION 'Say when it is due' USING ERRCODE = 'QM036'; END IF;
  v_user := a.owner_user_id; v_emp := a.owner_employee_id;
  IF p_data ? 'ownerUserId' OR p_data ? 'ownerEmployeeId' THEN SELECT o_user, o_employee INTO v_user, v_emp FROM app.fmea_action_owner(a.organisation_id, p_data); END IF;
  UPDATE public.fmea_actions SET kind = v_kind, description = v_desc, due_on = v_due, owner_user_id = v_user, owner_employee_id = v_emp WHERE id = a.id;
END $$;

-- The action is done: what was found (required), and optionally what occurrence and detection it comes to now (keys revisedOccurrence, revisedDetection). The manager,
-- or the person it was given to with only the read permission.
CREATE FUNCTION app.complete_fmea_action(p_id uuid, p_note text, p_data jsonb DEFAULT '{}'::jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.fmea_actions%ROWTYPE; v_note text := btrim(coalesce(p_note, '')); v_o integer; v_d integer;
BEGIN
  a := app.fmea_action_for_write(p_id, true);
  PERFORM app.fmea_keys(coalesce(p_data, '{}'::jsonb), ARRAY['revisedOccurrence', 'revisedDetection']);
  IF a.status <> 'open' THEN RAISE EXCEPTION 'Only an open action can be finished' USING ERRCODE = 'QM036'; END IF;
  IF length(v_note) < 3 THEN RAISE EXCEPTION 'Say what was found (at least 3 characters)' USING ERRCODE = 'QM036'; END IF;
  IF length(v_note) > 1000 THEN RAISE EXCEPTION 'What was found is up to 1000 characters' USING ERRCODE = 'QM036'; END IF;
  v_o := app.fmea_level(p_data ->> 'revisedOccurrence', 'The revised occurrence');
  v_d := app.fmea_level(p_data ->> 'revisedDetection', 'The revised detection');
  UPDATE public.fmea_actions SET status = 'done', evidence_note = v_note, revised_occurrence = v_o, revised_detection = v_d WHERE id = a.id;
END $$;

CREATE FUNCTION app.cancel_fmea_action(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.fmea_actions%ROWTYPE; v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  a := app.fmea_action_for_write(p_id, false);
  IF a.status <> 'open' THEN RAISE EXCEPTION 'Only an open action can be cancelled' USING ERRCODE = 'QM036'; END IF;
  IF length(v_reason) < 3 THEN RAISE EXCEPTION 'Say why it is cancelled (at least 3 characters)' USING ERRCODE = 'QM036'; END IF;
  UPDATE public.fmea_actions SET status = 'cancelled', cancel_reason = left(v_reason, 500) WHERE id = a.id;
END $$;

CREATE FUNCTION app.reopen_fmea_action(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.fmea_actions%ROWTYPE;
BEGIN
  a := app.fmea_action_for_write(p_id, true);
  IF a.status <> 'done' THEN RAISE EXCEPTION 'Only a finished action can be reopened' USING ERRCODE = 'QM036'; END IF;
  UPDATE public.fmea_actions SET status = 'open' WHERE id = a.id;
END $$;

-- The actions given to the caller, on any revision that is a draft or in force (an owner who only reads sees their own here even when the revision itself is not theirs to open).
CREATE FUNCTION app.my_fmea_actions(p_organisation_id uuid, p_status text DEFAULT 'open') RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT app.is_member(p_organisation_id) THEN RETURN; END IF;
  IF p_status NOT IN ('open', 'done', 'all') THEN RAISE EXCEPTION 'Unknown status' USING ERRCODE = 'QM036'; END IF;
  RETURN QUERY
  SELECT jsonb_build_object(
           'id', a.id, 'kind', a.kind, 'description', a.description, 'dueOn', a.due_on, 'status', a.status, 'evidenceNote', a.evidence_note, 'doneAt', a.done_at,
           'revisedOccurrence', a.revised_occurrence, 'revisedDetection', a.revised_detection, 'revisedRpn', a.revised_rpn, 'revisedPriority', a.revised_priority,
           'fmeaId', f.id, 'fmeaNumber', f.number, 'fmeaTitle', f.title, 'fmeaKind', f.kind, 'revisionId', r.id, 'revisionLetter', r.letter, 'revisionStatus', r.status,
           'causeText', c.text, 'failureModeText', m.text, 'causeId', c.id, 'currentPriority', c.priority, 'occurrence', c.occurrence, 'detection', c.detection,
           'adopted', a.adopted_in_revision_id IS NOT NULL, 'createdAt', a.created_at)
    FROM public.fmea_actions a
    JOIN public.fmea_revisions r ON r.id = a.revision_id JOIN public.fmeas f ON f.id = r.fmea_id
    JOIN public.fmea_causes c ON c.id = a.cause_id JOIN public.fmea_failure_modes m ON m.id = c.failure_mode_id
    LEFT JOIN public."Employees" e ON e.id = a.owner_employee_id AND e.organisation_id = a.organisation_id
   WHERE a.organisation_id = p_organisation_id AND r.status IN ('draft', 'effective')
     AND (a.owner_user_id = auth.uid() OR e.auth_id = auth.uid())
     AND (p_status = 'all' OR a.status = p_status)
   ORDER BY (a.status = 'open') DESC, a.due_on, a.created_at;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Between revisions: carry, cancel what is over, adopt, un-adopt
-- ---------------------------------------------------------------------------
-- Cancels the open actions of a revision (it was discarded or withdrawn). Internal.
CREATE FUNCTION app.fmea_cancel_open_actions(p_revision uuid, p_reason text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_n integer;
BEGIN
  PERFORM set_config('app.fmea_action_system', 'on', true);
  UPDATE public.fmea_actions SET status = 'cancelled', cancel_reason = left(p_reason, 500) WHERE revision_id = p_revision AND status = 'open';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('app.fmea_action_system', 'off', true);
  RETURN v_n;
END $$;

-- The revision `p_to` has taken over from `p_from`: each open action of the old one goes on, as a new open action on the cause that continues its cause (same owner, due date
-- and words; `prev_row_id` says which it continues), and the old one is cancelled with the reason; an action whose cause is gone is cancelled with that reason. Internal.
CREATE FUNCTION app.fmea_carry_actions(p_from uuid, p_to uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.fmea_actions%ROWTYPE; v_cause uuid; v_label text;
BEGIN
  SELECT coalesce('rev ' || letter, 'the new revision') INTO v_label FROM public.fmea_revisions WHERE id = p_to;
  FOR a IN SELECT * FROM public.fmea_actions WHERE revision_id = p_from AND status = 'open' ORDER BY created_at LOOP
    SELECT n.id INTO v_cause FROM public.fmea_causes n WHERE n.revision_id = p_to AND n.prev_row_id = a.cause_id;
    IF v_cause IS NOT NULL THEN
      INSERT INTO public.fmea_actions (organisation_id, revision_id, cause_id, kind, description, owner_user_id, owner_employee_id, due_on, prev_row_id)
      VALUES (a.organisation_id, p_to, v_cause, a.kind, a.description, a.owner_user_id, a.owner_employee_id, a.due_on, a.id);
    END IF;
    PERFORM set_config('app.fmea_action_system', 'on', true);
    UPDATE public.fmea_actions SET status = 'cancelled',
      cancel_reason = CASE WHEN v_cause IS NOT NULL THEN 'Carried on in ' || v_label ELSE 'The cause was removed in ' || v_label END WHERE id = a.id;
    PERFORM set_config('app.fmea_action_system', 'off', true);
    v_cause := NULL;
  END LOOP;
END $$;

-- Takes the finished actions of the revision this draft continues into the draft: the words join the cause's controls (prevention or detection by the action's kind), the
-- revised occurrence and detection become its ratings, and the old action is stamped as adopted. Only on a draft, by a manager; returns how many.
CREATE FUNCTION app.adopt_fmea_actions(p_revision uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.fmea_revisions%ROWTYPE; a record; v_n integer := 0; v_modes uuid[] := ARRAY[]::uuid[]; v_text text;
BEGIN
  r := app.fmea_draft_for_update(p_revision);
  IF r.previous_revision_id IS NULL THEN RETURN 0; END IF;
  FOR a IN
    SELECT x.id, x.kind, x.description, x.revised_occurrence, x.revised_detection, n.id AS new_cause, n.failure_mode_id, n.text AS cause_text, n.prevention_controls, n.detection_controls
      FROM public.fmea_actions x JOIN public.fmea_causes n ON n.revision_id = r.id AND n.prev_row_id = x.cause_id
     WHERE x.revision_id = r.previous_revision_id AND x.status = 'done' AND x.adopted_in_revision_id IS NULL ORDER BY x.done_at, x.id
  LOOP
    IF a.kind = 'prevention' THEN
      v_text := coalesce(a.prevention_controls || E'\n', '') || a.description;
    ELSE
      v_text := coalesce(a.detection_controls || E'\n', '') || a.description;
    END IF;
    IF length(v_text) > 1000 THEN
      RAISE EXCEPTION 'The controls of "%" would be longer than 1000 characters with this action: shorten them, then take the action in', left(a.cause_text, 60) USING ERRCODE = 'QM036';
    END IF;
    UPDATE public.fmea_causes SET
      prevention_controls = CASE WHEN a.kind = 'prevention' THEN v_text ELSE prevention_controls END,
      detection_controls = CASE WHEN a.kind = 'detection' THEN v_text ELSE detection_controls END,
      occurrence = coalesce(a.revised_occurrence, occurrence), detection = coalesce(a.revised_detection, detection),
      rpn = NULL, priority = NULL, needs_attention = NULL
     WHERE id = a.new_cause;
    PERFORM set_config('app.fmea_action_system', 'on', true);
    UPDATE public.fmea_actions SET adopted_in_revision_id = r.id WHERE id = a.id;
    PERFORM set_config('app.fmea_action_system', 'off', true);
    IF NOT (a.failure_mode_id = ANY (v_modes)) THEN v_modes := v_modes || a.failure_mode_id; END IF;
    v_n := v_n + 1;
  END LOOP;
  FOR i IN 1..coalesce(array_length(v_modes, 1), 0) LOOP PERFORM app.fmea_rescore_mode(v_modes[i]); END LOOP;
  IF v_n > 0 THEN UPDATE public.fmea_revisions SET updated_at = now() WHERE id = r.id; END IF;
  RETURN v_n;
END $$;

-- A discarded draft gives back what it had taken in. Internal.
CREATE FUNCTION app.fmea_unadopt_actions(p_revision uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM set_config('app.fmea_action_system', 'on', true);
  UPDATE public.fmea_actions SET adopted_in_revision_id = NULL WHERE adopted_in_revision_id = p_revision;
  PERFORM set_config('app.fmea_action_system', 'off', true);
END $$;

-- start_fmea_revision learns to adopt: the old one-argument call stays (it does not adopt).
DROP FUNCTION app.start_fmea_revision(uuid);
CREATE FUNCTION app.start_fmea_revision(p_fmea uuid, p_adopt boolean DEFAULT false) RETURNS uuid
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
  INSERT INTO public.fmea_revisions (organisation_id, fmea_id, sequence, previous_revision_id, based_on_revision_id)
  VALUES (f.organisation_id, f.id, v_seq, v_from.id, v_from.based_on_revision_id) RETURNING id INTO v_id;
  INSERT INTO public.fmea_team_members (organisation_id, revision_id, employee_id, user_id, role)
  SELECT organisation_id, v_id, employee_id, user_id, role FROM public.fmea_team_members WHERE revision_id = v_from.id;
  INSERT INTO public.fmea_links (organisation_id, revision_id, kind, part_id, part_family_id, control_plan_id, machine_id, supplier_id, customer_id, operation_code)
  SELECT organisation_id, v_id, kind, part_id, part_family_id, control_plan_id, machine_id, supplier_id, customer_id, operation_code FROM public.fmea_links WHERE revision_id = v_from.id;
  PERFORM app.fmea_copy_net(v_from.id, v_id, 'revision');
  IF p_adopt THEN PERFORM app.adopt_fmea_actions(v_id); END IF;
  RETURN v_id;
END $$;

-- When a revision takes effect the open actions of the one it replaces go on in it.
SELECT pg_temp.patch('app.settle_fmea(uuid)'::regprocedure,
  $old$    UPDATE public.fmea_revisions SET status = 'effective', effective_at = now() WHERE id = r.id;$old$,
  $new$    UPDATE public.fmea_revisions SET status = 'effective', effective_at = now() WHERE id = r.id;
    IF v_prev IS NOT NULL THEN PERFORM app.fmea_carry_actions(v_prev, r.id); END IF;$new$);

-- Withdrawing an FMEA ends the actions still open on it; discarding a draft ends its open actions and gives back what it adopted.
SELECT pg_temp.patch('app.withdraw_fmea(uuid, text)'::regprocedure,
  $old$  UPDATE public.fmea_revisions SET status = 'withdrawn', withdrawn_at = now(), withdrawn_by = auth.uid(), withdraw_reason = left(v_reason, 500)$old$,
  $new$  PERFORM app.fmea_cancel_open_actions(x.id, 'The FMEA was withdrawn') FROM public.fmea_revisions x WHERE x.fmea_id = f.id AND x.status IN ('effective', 'approved');
  UPDATE public.fmea_revisions SET status = 'withdrawn', withdrawn_at = now(), withdrawn_by = auth.uid(), withdraw_reason = left(v_reason, 500)$new$);
SELECT pg_temp.patch('app.discard_fmea_revision(uuid, text)'::regprocedure,
  $old$  UPDATE public.fmea_revisions SET status = 'discarded', discarded_at = now(), discarded_by = auth.uid(), discard_reason = left(v_reason, 500) WHERE id = r.id;$old$,
  $new$  PERFORM app.fmea_cancel_open_actions(r.id, 'The draft was discarded');
  PERFORM app.fmea_unadopt_actions(r.id);
  UPDATE public.fmea_revisions SET status = 'discarded', discarded_at = now(), discarded_by = auth.uid(), discard_reason = left(v_reason, 500) WHERE id = r.id;$new$);

-- ---------------------------------------------------------------------------
-- 6. What a draft still needs: an action answers "needs attention" and "no control"
-- ---------------------------------------------------------------------------
SELECT pg_temp.patch('app.fmea_revision_problems(uuid)'::regprocedure,
  $old$   WHERE c.revision_id = r.id AND c.prevention_controls IS NULL AND c.detection_controls IS NULL;$old$,
  $new$   WHERE c.revision_id = r.id AND c.prevention_controls IS NULL AND c.detection_controls IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.fmea_actions a WHERE a.cause_id = c.id AND a.status <> 'cancelled');$new$);
SELECT pg_temp.patch('app.fmea_revision_problems(uuid)'::regprocedure,
  $old$   WHERE c.revision_id = r.id AND c.needs_attention AND c.no_action_reason IS NULL;$old$,
  $new$   WHERE c.revision_id = r.id AND c.needs_attention AND c.no_action_reason IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.fmea_actions a WHERE a.cause_id = c.id AND a.status <> 'cancelled');$new$);

-- ---------------------------------------------------------------------------
-- 7. The periodic review (FM14)
-- ---------------------------------------------------------------------------
-- "no_change" (a note is needed) sets the next review a full interval from today; "revision_started" starts a draft from the revision in force.
CREATE FUNCTION app.record_fmea_review(p_fmea uuid, p_outcome text, p_note text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE f public.fmeas%ROWTYPE; v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_id uuid; v_started uuid; v_next date; v_months integer;
BEGIN
  f := app.fmea_for_write(p_fmea);
  PERFORM app.settle_fmea(f.id);
  SELECT * INTO f FROM public.fmeas WHERE id = p_fmea;
  IF f.status <> 'active' OR f.current_revision_id IS NULL THEN RAISE EXCEPTION 'Only an FMEA in force is reviewed' USING ERRCODE = 'QM036'; END IF;
  IF p_outcome IS NULL OR p_outcome NOT IN ('no_change', 'revision_started') THEN RAISE EXCEPTION 'A review ends with no change, or with a new revision' USING ERRCODE = 'QM036'; END IF;
  IF v_note IS NOT NULL AND length(v_note) > 1000 THEN RAISE EXCEPTION 'The note is up to 1000 characters' USING ERRCODE = 'QM036'; END IF;
  IF p_outcome = 'no_change' THEN
    IF v_note IS NULL OR length(v_note) < 3 THEN RAISE EXCEPTION 'Say what was checked and why nothing changes (at least 3 characters)' USING ERRCODE = 'QM036'; END IF;
    v_months := coalesce(f.review_months, app.fmea_default_review_months(f.organisation_id));
    v_next := current_date + (v_months || ' months')::interval;
    UPDATE public.fmeas SET next_review_on = v_next WHERE id = f.id;
  ELSE
    v_started := app.start_fmea_revision(f.id, false);
  END IF;
  INSERT INTO public.fmea_reviews (organisation_id, fmea_id, revision_id, outcome, note, started_revision_id, was_due_on, next_review_on)
  VALUES (f.organisation_id, f.id, f.current_revision_id, p_outcome, v_note, v_started, f.next_review_on, v_next) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------
-- 8. Who a column names, and the notice to the person an action is given to
-- ---------------------------------------------------------------------------
SELECT pg_temp.patch(
  'app.user_reference_columns()'::regprocedure,
  $old$    ('fmea_team_members', 'user_id', 'history', 'A member named on the FMEA team; the team is replaced on the next revision'),$old$,
  $new$    ('fmea_team_members', 'user_id', 'history', 'A member named on the FMEA team; the team is replaced on the next revision'),
    ('fmea_actions', 'owner_user_id', 'history', 'Who an FMEA action was given to; after a move to a company account an FMEA manager gives an open action to the new account'),$new$);

INSERT INTO public.notification_event_types
  (key, entity_type, action, group_name, entity_label, description, permission_code, default_on, default_permission_code, label_fields, display_order, own_record, email_default)
VALUES
  ('fmea_actions.created', 'fmea_actions', 'created', 'FMEA', 'FMEA action', 'An FMEA action was given to you', 'fmea.read', true, NULL,
   ARRAY['fmea_label', 'description', 'due_label'], 20, true, true),
  ('fmea_actions.updated', 'fmea_actions', 'updated', 'FMEA', 'FMEA action', 'An FMEA action was given to you', 'fmea.read', true, NULL,
   ARRAY['fmea_label', 'description', 'due_label'], 21, true, true);

SELECT pg_temp.patch('app.emit_notification()'::regprocedure,
  E'  IF NEW.entity_type = ''change_signoffs'' AND NEW.action <> ''insert'' THEN RETURN NULL; END IF;\n',
  E'  IF NEW.entity_type = ''change_signoffs'' AND NEW.action <> ''insert'' THEN RETURN NULL; END IF;\n'
  || E'  IF NEW.entity_type = ''fmea_actions'' AND (NEW.action = ''delete'' OR (NEW.action = ''update'' AND NOT (coalesce(NEW.changed_fields, ''{}'') @> ARRAY[''owner_user_id'', ''owner_employee_id'']))) THEN RETURN NULL; END IF;\n');
SELECT pg_temp.patch('app.emit_notification()'::regprocedure,
  E'  -- An overdue notice says what and since when; the area and the record behind it lead the link.',
  E'  -- An FMEA action tells its person which FMEA, what to do and by when. A carried-on action (it continues one already given) is not news.\n'
  || E'  IF NEW.entity_type = ''fmea_actions'' THEN\n'
  || E'    SELECT to_jsonb(t) || jsonb_build_object(''user_id'', coalesce(t.owner_user_id, e.auth_id), ''fmea_id'', f.id, ''fmea_label'', f.number || '' · '' || f.title,\n'
  || E'             ''due_label'', ''Due '' || to_char(t.due_on, ''FMDD Mon YYYY''))\n'
  || E'      INTO v_change_row FROM public.fmea_actions t JOIN public.fmea_revisions r ON r.id = t.revision_id JOIN public.fmeas f ON f.id = r.fmea_id\n'
  || E'      LEFT JOIN public."Employees" e ON e.id = t.owner_employee_id AND e.organisation_id = t.organisation_id\n'
  || E'     WHERE t.id = NEW.entity_id::uuid AND t.status = ''open'' AND t.prev_row_id IS NULL;\n'
  || E'    IF v_change_row IS NULL OR (v_change_row ->> ''user_id'') IS NULL OR (v_change_row ->> ''user_id'')::uuid IS NOT DISTINCT FROM NEW.actor_user_id THEN RETURN NULL; END IF;\n'
  || E'    v_row := v_change_row;\n  END IF;\n\n'
  || E'  -- An overdue notice says what and since when; the area and the record behind it lead the link.');
SELECT pg_temp.patch('app.emit_notification()'::regprocedure,
  E'''record_kind'', ''record_id'', ''task_id'', ''change_id'']) k',
  E'''record_kind'', ''record_id'', ''task_id'', ''change_id'', ''fmea_id'']) k');
SELECT pg_temp.patch('app.emit_notification()'::regprocedure,
  E'''management_review_actions'', ''change_requests'', ''change_tasks'') THEN\n    v_what := ''Changed: ''',
  E'''management_review_actions'', ''change_requests'', ''change_tasks'', ''fmea_actions'') THEN\n    v_what := ''Changed: ''');
SELECT pg_temp.patch('app.emit_notification()'::regprocedure,
  E'  IF NEW.entity_type IN (''change_signoffs'', ''change_requests'', ''change_tasks'') THEN v_recipient := (v_row ->> ''user_id'')::uuid; END IF;',
  E'  IF NEW.entity_type IN (''change_signoffs'', ''change_requests'', ''change_tasks'', ''fmea_actions'') THEN v_recipient := (v_row ->> ''user_id'')::uuid; END IF;');

-- ---------------------------------------------------------------------------
-- 9. Privileges
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app.fmea_action_rules(), app.fmea_review_frozen(), app.fmea_action_owner(uuid, jsonb), app.fmea_action_for_write(uuid, boolean),
  app.fmea_cancel_open_actions(uuid, text), app.fmea_carry_actions(uuid, uuid), app.fmea_unadopt_actions(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.fmea_action_is_owner(uuid), app.add_fmea_action(uuid, jsonb), app.update_fmea_action(uuid, jsonb), app.complete_fmea_action(uuid, text, jsonb),
  app.cancel_fmea_action(uuid, text), app.reopen_fmea_action(uuid), app.my_fmea_actions(uuid, text), app.adopt_fmea_actions(uuid),
  app.start_fmea_revision(uuid, boolean), app.record_fmea_review(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.fmea_action_is_owner(uuid), app.add_fmea_action(uuid, jsonb), app.update_fmea_action(uuid, jsonb), app.complete_fmea_action(uuid, text, jsonb),
  app.cancel_fmea_action(uuid, text), app.reopen_fmea_action(uuid), app.my_fmea_actions(uuid, text), app.adopt_fmea_actions(uuid),
  app.start_fmea_revision(uuid, boolean), app.record_fmea_review(uuid, text, text) TO authenticated;
