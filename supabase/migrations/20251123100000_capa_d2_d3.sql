-- CAPA2 (docs/capa-8d-plan.md): D2 describe the problem and D3 interim containment.
--
--  * D2: the 5W2H description lives on `capas` (d2_who … d2_how_many, as the legacy "8D" table had d2_*), edited with the header under RLS.
--    The Is / Is-Not comparison, and later the Ishikawa and 5 Whys, are `capa_analyses` rows: a kind, a title and structured `data` (jsonb, an object,
--    validated per kind by the API, size-limited here). Removing one marks it deleted; nothing is ever deleted.
--  * D3: `capa_actions` (phase interim now; corrective and preventive in later slices). Written under RLS by capa.manage; a trigger keeps the rules:
--    a running 8D, an owner who is a live member of this 8D's team, status stamps (done_at/by) the user cannot forge, cancelling needs a reason.
--    A team member cannot leave while they own open actions.
--  * An 8D is a fluid document: completing D2 or D3 locks nothing. Only a closed or cancelled 8D is read-only.
--  * app.start_capa now also fills D2 from the non-conformance it is started from.

ALTER TABLE public.capas
  ADD COLUMN d2_who text CHECK (d2_who IS NULL OR length(btrim(d2_who)) BETWEEN 1 AND 2000),
  ADD COLUMN d2_what text CHECK (d2_what IS NULL OR length(btrim(d2_what)) BETWEEN 1 AND 2000),
  ADD COLUMN d2_where text CHECK (d2_where IS NULL OR length(btrim(d2_where)) BETWEEN 1 AND 2000),
  ADD COLUMN d2_when text CHECK (d2_when IS NULL OR length(btrim(d2_when)) BETWEEN 1 AND 2000),
  ADD COLUMN d2_why text CHECK (d2_why IS NULL OR length(btrim(d2_why)) BETWEEN 1 AND 2000),
  ADD COLUMN d2_how text CHECK (d2_how IS NULL OR length(btrim(d2_how)) BETWEEN 1 AND 2000),
  ADD COLUMN d2_how_many text CHECK (d2_how_many IS NULL OR length(btrim(d2_how_many)) BETWEEN 1 AND 2000),
  ADD COLUMN d3_no_containment_reason text CHECK (d3_no_containment_reason IS NULL OR length(btrim(d3_no_containment_reason)) BETWEEN 1 AND 2000);
GRANT UPDATE (d2_who, d2_what, d2_where, d2_when, d2_why, d2_how, d2_how_many, d3_no_containment_reason) ON public.capas TO authenticated;

-- ---------------------------------------------------------------------------
-- Analyses (Is / Is-Not now; Ishikawa and 5 Whys in CAPA3)
-- ---------------------------------------------------------------------------
CREATE TABLE public.capa_analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  capa_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('is_is_not', 'ishikawa', 'five_whys')),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  step text NOT NULL CHECK (step IN ('d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8')),
  data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object'),
  deleted_at timestamptz,
  deleted_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT capa_analyses_capa_fkey FOREIGN KEY (capa_id, organisation_id) REFERENCES public.capas (id, organisation_id) ON DELETE CASCADE,
  CONSTRAINT capa_analyses_id_org_key UNIQUE (id, organisation_id)
);
CREATE INDEX capa_analyses_capa_idx ON public.capa_analyses (capa_id) WHERE deleted_at IS NULL;

CREATE FUNCTION app.capa_analysis_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_stage text;
BEGIN
  SELECT stage INTO v_stage FROM public.capas WHERE id = NEW.capa_id;
  IF v_stage IN ('closed', 'cancelled') THEN
    RAISE EXCEPTION 'This 8D is %; reopen it to change its analyses', v_stage USING ERRCODE = 'QM013';
  END IF;
  IF pg_column_size(NEW.data) > 200000 THEN
    RAISE EXCEPTION 'That analysis is too large' USING ERRCODE = 'QM013';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.capa_id <> OLD.capa_id OR NEW.kind <> OLD.kind OR NEW.step <> OLD.step THEN
      RAISE EXCEPTION 'An analysis cannot be moved to another 8D or step, or change kind' USING ERRCODE = 'QM013';
    END IF;
    IF OLD.deleted_at IS NOT NULL AND (NEW.deleted_at IS DISTINCT FROM OLD.deleted_at OR NEW.data IS DISTINCT FROM OLD.data OR NEW.title <> OLD.title) THEN
      RAISE EXCEPTION 'A removed analysis stays removed' USING ERRCODE = 'QM013';
    END IF;
    IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
      NEW.deleted_at := now();
      NEW.deleted_by := auth.uid();
    END IF;
  ELSE
    NEW.deleted_at := NULL;
    NEW.deleted_by := NULL;
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- Actions (interim containment now; corrective and preventive later)
-- ---------------------------------------------------------------------------
CREATE TABLE public.capa_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  capa_id uuid NOT NULL,
  phase text NOT NULL CHECK (phase IN ('interim', 'corrective', 'preventive')),
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 2000),
  root_cause_id uuid,
  owner_team_member_id uuid,
  due_date date,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  done_at timestamptz,
  done_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  evidence_note text CHECK (evidence_note IS NULL OR length(btrim(evidence_note)) BETWEEN 1 AND 2000),
  cancel_reason text CHECK (cancel_reason IS NULL OR length(btrim(cancel_reason)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT capa_actions_capa_fkey FOREIGN KEY (capa_id, organisation_id) REFERENCES public.capas (id, organisation_id) ON DELETE CASCADE,
  CONSTRAINT capa_actions_owner_fkey FOREIGN KEY (owner_team_member_id, organisation_id) REFERENCES public.capa_team_members (id, organisation_id),
  CONSTRAINT capa_actions_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT capa_actions_done_stamped CHECK ((status = 'done') = (done_at IS NOT NULL)),
  CONSTRAINT capa_actions_cancelled_has_reason CHECK ((status = 'cancelled') = (cancel_reason IS NOT NULL))
);
CREATE INDEX capa_actions_capa_idx ON public.capa_actions (capa_id, phase);
CREATE INDEX capa_actions_owner_idx ON public.capa_actions (owner_team_member_id) WHERE status = 'open';

CREATE FUNCTION app.capa_action_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_stage text;
BEGIN
  SELECT stage INTO v_stage FROM public.capas WHERE id = NEW.capa_id;
  IF v_stage IN ('closed', 'cancelled') THEN
    RAISE EXCEPTION 'This 8D is %; reopen it to change its actions', v_stage USING ERRCODE = 'QM013';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' THEN
      RAISE EXCEPTION 'A new action starts open' USING ERRCODE = 'QM013';
    END IF;
    NEW.done_at := NULL; NEW.done_by := NULL; NEW.cancel_reason := NULL;
  ELSE
    IF NEW.capa_id <> OLD.capa_id OR NEW.phase <> OLD.phase OR NEW.root_cause_id IS DISTINCT FROM OLD.root_cause_id THEN
      RAISE EXCEPTION 'An action cannot be moved to another 8D, phase or root cause' USING ERRCODE = 'QM013';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF NEW.status = 'done' THEN
        NEW.done_at := now(); NEW.done_by := auth.uid(); NEW.cancel_reason := NULL;
      ELSIF NEW.status = 'cancelled' THEN
        NEW.done_at := NULL; NEW.done_by := NULL;
        IF NEW.cancel_reason IS NULL THEN
          RAISE EXCEPTION 'Say why the action is cancelled' USING ERRCODE = 'QM013';
        END IF;
      ELSE
        NEW.done_at := NULL; NEW.done_by := NULL; NEW.cancel_reason := NULL;
      END IF;
    ELSE
      -- Not a status change: the stamps stay as they were.
      NEW.done_at := OLD.done_at; NEW.done_by := OLD.done_by;
      IF NEW.status <> 'cancelled' THEN NEW.cancel_reason := OLD.cancel_reason; END IF;
    END IF;
  END IF;
  IF NEW.owner_team_member_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.owner_team_member_id IS DISTINCT FROM OLD.owner_team_member_id)
     AND NOT EXISTS (SELECT 1 FROM public.capa_team_members t WHERE t.id = NEW.owner_team_member_id AND t.capa_id = NEW.capa_id AND t.ended_at IS NULL) THEN
    RAISE EXCEPTION 'The owner must be on the team of this 8D' USING ERRCODE = 'QM013';
  END IF;
  RETURN NEW;
END $$;

-- A person cannot leave the team while they own open actions.
CREATE OR REPLACE FUNCTION app.capa_team_member_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_stage text;
BEGIN
  SELECT stage INTO v_stage FROM public.capas WHERE id = NEW.capa_id;
  IF v_stage IN ('closed', 'cancelled') THEN
    RAISE EXCEPTION 'This 8D is %; reopen it to change the team', v_stage USING ERRCODE = 'QM013';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.capa_id <> OLD.capa_id OR NEW.membership_id IS DISTINCT FROM OLD.membership_id THEN
      RAISE EXCEPTION 'A team member cannot be moved to another 8D or another person' USING ERRCODE = 'QM013';
    END IF;
    IF OLD.ended_at IS NOT NULL AND (NEW.ended_at IS DISTINCT FROM OLD.ended_at OR NEW.role <> OLD.role
         OR NEW.external_name IS DISTINCT FROM OLD.external_name OR NEW.external_company IS DISTINCT FROM OLD.external_company
         OR NEW.external_email IS DISTINCT FROM OLD.external_email) THEN
      RAISE EXCEPTION 'That person has left the team; add them again instead' USING ERRCODE = 'QM013';
    END IF;
    IF NEW.ended_at IS NOT NULL AND OLD.ended_at IS NULL
       AND EXISTS (SELECT 1 FROM public.capa_actions a WHERE a.owner_team_member_id = NEW.id AND a.status = 'open') THEN
      RAISE EXCEPTION 'This person still owns open actions; give them to someone else first' USING ERRCODE = 'QM013';
    END IF;
  END IF;
  IF NEW.membership_id IS NOT NULL AND TG_OP = 'INSERT'
     AND NOT EXISTS (SELECT 1 FROM public.organisation_users m WHERE m.id = NEW.membership_id AND m.organisation_id = NEW.organisation_id AND m.status = 'active') THEN
    RAISE EXCEPTION 'Only active members of the organisation can join the team' USING ERRCODE = 'QM013';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.ended_at IS NOT NULL AND OLD.ended_at IS NULL THEN
    NEW.ended_at := now();
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- Bookkeeping, audit, access
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['capa_analyses', 'capa_actions'] LOOP
    EXECUTE format('CREATE TRIGGER %1$s_stamp BEFORE INSERT ON public.%1$I FOR EACH ROW EXECUTE FUNCTION app.stamp_created()', t);
    EXECUTE format('CREATE TRIGGER %1$s_touch BEFORE UPDATE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION app.touch_updated()', t);
    EXECUTE format('CREATE TRIGGER %1$s_org_immutable BEFORE UPDATE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change()', t);
    EXECUTE format('CREATE TRIGGER %1$s_no_delete BEFORE DELETE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION app.capa_children_no_delete()', t);
    EXECUTE format('CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION audit.record_change(%L)', t, 'organisation_id');
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT, INSERT ON public.%I TO authenticated', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.capas c WHERE c.id = capa_id))', t || '_select', t);
    EXECUTE format('CREATE POLICY %1$I ON public.%2$I FOR INSERT TO authenticated WITH CHECK (app.has_permission(organisation_id, ''capa.manage'') AND EXISTS (SELECT 1 FROM public.capas c WHERE c.id = capa_id AND c.organisation_id = %2$I.organisation_id))', t || '_insert', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (app.has_permission(organisation_id, ''capa.manage'')) WITH CHECK (app.has_permission(organisation_id, ''capa.manage''))', t || '_update', t);
  END LOOP;
END $$;
CREATE TRIGGER capa_analyses_rules BEFORE INSERT OR UPDATE ON public.capa_analyses FOR EACH ROW EXECUTE FUNCTION app.capa_analysis_rules();
CREATE TRIGGER capa_actions_rules BEFORE INSERT OR UPDATE ON public.capa_actions FOR EACH ROW EXECUTE FUNCTION app.capa_action_rules();
GRANT UPDATE (title, data, deleted_at) ON public.capa_analyses TO authenticated;
GRANT UPDATE (description, owner_team_member_id, due_date, status, evidence_note, cancel_reason) ON public.capa_actions TO authenticated;

-- ---------------------------------------------------------------------------
-- What each step still needs. D2: what, where and when. D3: containment done, or a reason there is none. D4 to D8 arrive later.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.capa_step_problems(p_capa uuid, p_step text) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.capas%ROWTYPE; v_problems text[] := ARRAY[]::text[]; v_leaders integer; v_people integer; v_open integer; v_done integer;
BEGIN
  SELECT * INTO c FROM public.capas WHERE id = p_capa;
  IF NOT FOUND OR NOT app.has_permission(c.organisation_id, 'capa.read') THEN
    RAISE EXCEPTION '8D not found' USING ERRCODE = 'QM013';
  END IF;
  CASE p_step
    WHEN 'd0' THEN
      IF c.problem_statement IS NULL THEN v_problems := array_append(v_problems, 'Describe the problem in the problem statement'); END IF;
    WHEN 'd1' THEN
      SELECT count(*) FILTER (WHERE role = 'leader'), count(*) INTO v_leaders, v_people
        FROM public.capa_team_members WHERE capa_id = p_capa AND ended_at IS NULL;
      IF v_leaders = 0 THEN v_problems := array_append(v_problems, 'Name a team leader'); END IF;
      IF v_people < 2 THEN v_problems := array_append(v_problems, 'Add at least two people to the team'); END IF;
    WHEN 'd2' THEN
      IF c.d2_what IS NULL THEN v_problems := array_append(v_problems, 'Say what is wrong (the What of 5W2H)'); END IF;
      IF c.d2_where IS NULL THEN v_problems := array_append(v_problems, 'Say where it was found (the Where of 5W2H)'); END IF;
      IF c.d2_when IS NULL THEN v_problems := array_append(v_problems, 'Say when it was found (the When of 5W2H)'); END IF;
    WHEN 'd3' THEN
      SELECT count(*) FILTER (WHERE status = 'open'), count(*) FILTER (WHERE status = 'done') INTO v_open, v_done
        FROM public.capa_actions WHERE capa_id = p_capa AND phase = 'interim';
      IF v_open > 0 THEN
        v_problems := array_append(v_problems, format('Finish or cancel the %s open containment %s', v_open, CASE WHEN v_open = 1 THEN 'action' ELSE 'actions' END));
      END IF;
      IF v_done = 0 AND c.d3_no_containment_reason IS NULL THEN
        v_problems := array_append(v_problems, 'Add an interim containment action, or say why none is needed');
      END IF;
    ELSE
      v_problems := array_append(v_problems, 'This step is not available yet');
  END CASE;
  RETURN v_problems;
END $$;

-- ---------------------------------------------------------------------------
-- Starting from a non-conformance also fills D2 (5W2H) from it: what, where, when and how many.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.start_capa(p_organisation_id uuid, p_title text DEFAULT NULL, p_problem text DEFAULT NULL, p_source text DEFAULT NULL,
                                          p_severity text DEFAULT NULL, p_from_ncr uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n public.nonconformances%ROWTYPE; v_id uuid; v_ref text; v_me uuid; v_title text; v_problem text; v_source text; v_severity text; s text;
        v_what text; v_where text; v_when text; v_how_many text;
BEGIN
  IF NOT app.has_permission(p_organisation_id, 'capa.manage') THEN
    RAISE EXCEPTION 'You are not allowed to start an 8D (capa.manage)' USING ERRCODE = '42501';
  END IF;
  SELECT id INTO v_me FROM public.organisation_users WHERE organisation_id = p_organisation_id AND user_id = auth.uid() AND status = 'active';
  IF p_from_ncr IS NOT NULL THEN
    SELECT * INTO n FROM public.nonconformances WHERE id = p_from_ncr AND organisation_id = p_organisation_id AND deleted_at IS NULL;
    IF NOT FOUND OR NOT app.has_permission(n.organisation_id, 'ncr.read', n.site_id) THEN
      RAISE EXCEPTION 'Non-conformance not found' USING ERRCODE = 'QM013';
    END IF;
  END IF;
  v_title := nullif(btrim(coalesce(p_title, '')), '');
  v_problem := nullif(btrim(coalesce(p_problem, '')), '');
  v_source := coalesce(nullif(p_source, ''), CASE WHEN n.id IS NULL THEN 'internal' WHEN n.source = 'inspection' THEN 'internal' ELSE n.source END);
  v_severity := coalesce(nullif(p_severity, ''), n.severity);
  IF n.id IS NOT NULL THEN
    v_title := coalesce(v_title, left('8D: ' || n.title, 200));
    s := nullif(btrim(concat_ws(E'\n', n.description, CASE WHEN n.requirement IS NOT NULL THEN 'Requirement: ' || n.requirement END,
                                      CASE WHEN n.actual_result IS NOT NULL THEN 'Actual: ' || n.actual_result END)), '');
    v_problem := coalesce(v_problem, left(coalesce(s, n.title), 5000));
    v_what := left(nullif(btrim(concat_ws(' · ', n.title, CASE WHEN n.lot_number IS NOT NULL THEN 'Lot ' || n.lot_number END,
                                                  CASE WHEN n.work_order IS NOT NULL THEN 'Work order ' || n.work_order END)), ''), 2000);
    v_where := left(nullif(btrim(coalesce((SELECT c.name FROM public.ncr_classifications c WHERE c.id = n.detection_process_id),
                                          (SELECT st.name FROM public.sites st WHERE st.id = n.site_id), '')), ''), 2000);
    v_when := 'Detected ' || to_char(n.detected_at, 'FMDD Mon YYYY');
    v_how_many := CASE WHEN n.quantity_affected IS NOT NULL
                       THEN trim_scale(n.quantity_affected)::text || CASE WHEN n.quantity_inspected IS NOT NULL THEN ' of ' || trim_scale(n.quantity_inspected)::text || ' inspected' ELSE ' affected' END
                  END;
  END IF;
  IF v_title IS NULL THEN
    RAISE EXCEPTION 'Give the 8D a title' USING ERRCODE = 'QM013';
  END IF;
  v_ref := app.next_capa_reference(p_organisation_id);
  INSERT INTO public.capas (organisation_id, reference, title, problem_statement, source, severity, owner_membership_id, d2_what, d2_where, d2_when, d2_how_many)
  VALUES (p_organisation_id, v_ref, v_title, v_problem, v_source, v_severity, v_me, v_what, v_where, v_when, v_how_many)
  RETURNING id INTO v_id;
  INSERT INTO public.capa_steps (organisation_id, capa_id, step)
    SELECT p_organisation_id, v_id, x FROM unnest(ARRAY['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8']) x;
  IF v_me IS NOT NULL THEN
    INSERT INTO public.capa_team_members (organisation_id, capa_id, membership_id, role) VALUES (p_organisation_id, v_id, v_me, 'leader');
  END IF;
  IF n.id IS NOT NULL THEN
    INSERT INTO public.capa_ncr_links (organisation_id, capa_id, nonconformance_id) VALUES (p_organisation_id, v_id, n.id);
  END IF;
  PERFORM app.emit_event(p_organisation_id, 'capa.created', 'capa', v_id, jsonb_build_object('reference', v_ref));
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION app.capa_analysis_rules(), app.capa_action_rules(), app.capa_team_member_rules(), app.capa_step_problems(uuid, text),
  app.start_capa(uuid, text, text, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.capa_step_problems(uuid, text), app.start_capa(uuid, text, text, text, text, uuid) TO authenticated;
