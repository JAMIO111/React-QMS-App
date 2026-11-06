-- CAPA / 8D core (slice CAPA1, docs/capa-8d-plan.md): the corrective action record, its nine steps, the team and the links to
-- non-conformances. Steps D2 to D8 add their own tables in later migrations.
--
-- Design
--  * One `capas` row per corrective action; method 8D now (decision C1). Numbering CAPA-000001 per organisation from a counter users cannot reach.
--  * The record is started by app.start_capa (numbering, the nine steps, the creator as leader, an optional first NC link). There is no table INSERT.
--    Header content (title, problem statement, source, severity, external reference, owner, due date) is edited under RLS with capa.manage until the
--    8D is closed or cancelled; stage and the closing columns change only through functions (no UPDATE grant on them).
--  * Steps (capa_steps) are written only by app.capa_complete_step / app.capa_reopen_step. A step can be completed in any order (an 8D is a fluid document: nothing locks) and only when
--    app.capa_step_problems says nothing is missing; the same function feeds the "still needed" checklist in the UI.
--  * Team members are organisation members or external contacts (decision C2). NC links are many-to-many (C4) and are ended with a reason, never deleted.
--  * Closing a non-conformance is refused while a linked 8D is still running (C7), by its own trigger on nonconformances.
--  * Errors QM013 -> 409 capa_rule (messages written for users).

INSERT INTO public.permissions (code, description) VALUES
  ('capa.read',   'View corrective actions (8D)'),
  ('capa.manage', 'Start, edit and progress corrective actions (8D) and link non-conformances to them'),
  ('capa.verify', 'Record effectiveness verification and close corrective actions (8D)');

WITH grants(key, perms) AS (VALUES
  ('owner',            ARRAY['capa.read', 'capa.manage', 'capa.verify']),
  ('admin',            ARRAY['capa.read', 'capa.manage', 'capa.verify']),
  ('quality_manager',  ARRAY['capa.read', 'capa.manage', 'capa.verify']),
  ('quality_engineer', ARRAY['capa.read', 'capa.manage']),
  ('inspector',        ARRAY['capa.read']),
  ('viewer',           ARRAY['capa.read'])
)
INSERT INTO public.role_permissions (role_id, permission_code)
SELECT r.id, unnest(g.perms) FROM public.roles r JOIN grants g ON g.key = r.key WHERE r.is_system
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Numbering
-- ---------------------------------------------------------------------------
CREATE TABLE app.capa_counters (
  organisation_id uuid PRIMARY KEY REFERENCES public.organisations (id) ON DELETE CASCADE,
  last_value integer NOT NULL DEFAULT 0
);
CREATE FUNCTION app.next_capa_reference(p_organisation_id uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_n integer;
BEGIN
  INSERT INTO app.capa_counters AS c (organisation_id, last_value) VALUES (p_organisation_id, 1)
  ON CONFLICT (organisation_id) DO UPDATE SET last_value = c.last_value + 1
  RETURNING last_value INTO v_n;
  RETURN 'CAPA-' || lpad(v_n::text, 6, '0');
END $$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE public.capas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  reference text NOT NULL,
  method text NOT NULL DEFAULT '8d' CHECK (method IN ('8d')),
  type text NOT NULL DEFAULT 'corrective' CHECK (type IN ('corrective', 'preventive')),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  problem_statement text CHECK (problem_statement IS NULL OR length(btrim(problem_statement)) BETWEEN 1 AND 5000),
  source text NOT NULL DEFAULT 'internal' CHECK (source IN ('internal', 'customer', 'supplier')),
  severity text CHECK (severity IN ('critical', 'major', 'minor')),
  external_reference text CHECK (external_reference IS NULL OR length(btrim(external_reference)) BETWEEN 1 AND 100),
  owner_membership_id uuid,
  due_date date,
  stage text NOT NULL DEFAULT 'open' CHECK (stage IN ('open', 'actions_in_progress', 'awaiting_verification', 'verified_effective', 'closed', 'cancelled')),
  stage_reason text CHECK (stage_reason IS NULL OR length(btrim(stage_reason)) BETWEEN 1 AND 2000),
  closed_at timestamptz,
  closed_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT capas_org_reference_key UNIQUE (organisation_id, reference),
  CONSTRAINT capas_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT capas_owner_fkey FOREIGN KEY (owner_membership_id, organisation_id) REFERENCES public.organisation_users (id, organisation_id),
  CONSTRAINT capas_cancelled_has_reason CHECK (stage <> 'cancelled' OR stage_reason IS NOT NULL),
  CONSTRAINT capas_closed_has_stamp CHECK ((stage = 'closed') = (closed_at IS NOT NULL))
);
CREATE INDEX capas_list_idx ON public.capas (organisation_id, stage, created_at DESC);

CREATE TABLE public.capa_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  capa_id uuid NOT NULL,
  step text NOT NULL CHECK (step IN ('d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8')),
  completed_at timestamptz,
  completed_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  note text CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 2000),
  reopened_at timestamptz,
  reopened_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  reopen_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT capa_steps_capa_fkey FOREIGN KEY (capa_id, organisation_id) REFERENCES public.capas (id, organisation_id) ON DELETE CASCADE,
  CONSTRAINT capa_steps_key UNIQUE (capa_id, step)
);

CREATE TABLE public.capa_team_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  capa_id uuid NOT NULL,
  membership_id uuid,
  external_name text CHECK (external_name IS NULL OR length(btrim(external_name)) BETWEEN 1 AND 120),
  external_company text CHECK (external_company IS NULL OR length(btrim(external_company)) BETWEEN 1 AND 120),
  external_email text CHECK (external_email IS NULL OR length(btrim(external_email)) BETWEEN 3 AND 200),
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('leader', 'champion', 'member', 'supplier_contact', 'customer_contact')),
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT capa_team_members_capa_fkey FOREIGN KEY (capa_id, organisation_id) REFERENCES public.capas (id, organisation_id) ON DELETE CASCADE,
  CONSTRAINT capa_team_members_membership_fkey FOREIGN KEY (membership_id, organisation_id) REFERENCES public.organisation_users (id, organisation_id),
  CONSTRAINT capa_team_members_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT capa_team_members_who CHECK ((membership_id IS NOT NULL) <> (external_name IS NOT NULL)),
  CONSTRAINT capa_team_members_member_roles CHECK (membership_id IS NULL OR role IN ('leader', 'champion', 'member'))
);
CREATE UNIQUE INDEX capa_team_members_person_key ON public.capa_team_members (capa_id, membership_id) WHERE membership_id IS NOT NULL AND ended_at IS NULL;
CREATE UNIQUE INDEX capa_team_members_one_leader ON public.capa_team_members (capa_id) WHERE role = 'leader' AND ended_at IS NULL;
CREATE UNIQUE INDEX capa_team_members_one_champion ON public.capa_team_members (capa_id) WHERE role = 'champion' AND ended_at IS NULL;

CREATE TABLE public.capa_ncr_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  capa_id uuid NOT NULL,
  nonconformance_id uuid NOT NULL,
  ended_at timestamptz,
  ended_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  end_reason text CHECK (end_reason IS NULL OR length(btrim(end_reason)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT capa_ncr_links_capa_fkey FOREIGN KEY (capa_id, organisation_id) REFERENCES public.capas (id, organisation_id) ON DELETE CASCADE,
  CONSTRAINT capa_ncr_links_ncr_fkey FOREIGN KEY (nonconformance_id, organisation_id) REFERENCES public.nonconformances (id, organisation_id),
  CONSTRAINT capa_ncr_links_ended_has_reason CHECK ((ended_at IS NULL) = (end_reason IS NULL))
);
CREATE UNIQUE INDEX capa_ncr_links_live_key ON public.capa_ncr_links (capa_id, nonconformance_id) WHERE ended_at IS NULL;
CREATE INDEX capa_ncr_links_ncr_idx ON public.capa_ncr_links (nonconformance_id);

-- ---------------------------------------------------------------------------
-- Rules (triggers)
-- ---------------------------------------------------------------------------
-- A closed or cancelled 8D keeps its content; the stage columns change only in the functions below.
CREATE FUNCTION app.capa_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_stage_cols text[] := ARRAY['stage', 'stage_reason', 'closed_at', 'closed_by', 'updated_at', 'updated_by'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;
  IF NEW.reference <> OLD.reference OR NEW.method <> OLD.method THEN
    RAISE EXCEPTION 'The reference and method of an 8D cannot change' USING ERRCODE = 'QM013';
  END IF;
  IF OLD.stage IN ('closed', 'cancelled')
     AND (to_jsonb(NEW) - v_stage_cols) IS DISTINCT FROM (to_jsonb(OLD) - v_stage_cols) THEN
    RAISE EXCEPTION 'This 8D is %; reopen it to make changes', OLD.stage USING ERRCODE = 'QM013';
  END IF;
  IF NEW.owner_membership_id IS NOT NULL AND NEW.owner_membership_id IS DISTINCT FROM OLD.owner_membership_id
     AND NOT EXISTS (SELECT 1 FROM public.organisation_users m WHERE m.id = NEW.owner_membership_id AND m.organisation_id = NEW.organisation_id AND m.status = 'active') THEN
    RAISE EXCEPTION 'The owner must be an active member of the organisation' USING ERRCODE = 'QM013';
  END IF;
  RETURN NEW;
END $$;

-- Team members: only while the 8D is open; a person once; roles that fit who they are; an ended member stays ended.
CREATE FUNCTION app.capa_team_member_rules() RETURNS trigger
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

CREATE FUNCTION app.capa_children_no_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'Records of an 8D are never deleted' USING ERRCODE = 'QM013';
END $$;

-- ---------------------------------------------------------------------------
-- Bookkeeping, audit, access
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['capas', 'capa_steps', 'capa_team_members', 'capa_ncr_links'] LOOP
    EXECUTE format('CREATE TRIGGER %1$s_stamp BEFORE INSERT ON public.%1$I FOR EACH ROW EXECUTE FUNCTION app.stamp_created()', t);
    EXECUTE format('CREATE TRIGGER %1$s_touch BEFORE UPDATE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION app.touch_updated()', t);
    EXECUTE format('CREATE TRIGGER %1$s_org_immutable BEFORE UPDATE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change()', t);
    EXECUTE format('CREATE TRIGGER %1$s_no_delete BEFORE DELETE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION app.capa_children_no_delete()', t);
    EXECUTE format('CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION audit.record_change(%L)', t, 'organisation_id');
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
  END LOOP;
END $$;
CREATE TRIGGER capas_rules BEFORE INSERT OR UPDATE ON public.capas FOR EACH ROW EXECUTE FUNCTION app.capa_rules();
CREATE TRIGGER capa_team_members_rules BEFORE INSERT OR UPDATE ON public.capa_team_members FOR EACH ROW EXECUTE FUNCTION app.capa_team_member_rules();

GRANT SELECT ON public.capas, public.capa_steps, public.capa_ncr_links TO authenticated;
GRANT SELECT, INSERT ON public.capa_team_members TO authenticated;
-- Header content only: stage and the closing columns change through the functions below.
GRANT UPDATE (title, problem_statement, source, severity, external_reference, owner_membership_id, due_date) ON public.capas TO authenticated;
GRANT UPDATE (role, external_name, external_company, external_email, ended_at) ON public.capa_team_members TO authenticated;

CREATE POLICY capas_select ON public.capas FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'capa.read'));
CREATE POLICY capas_update ON public.capas FOR UPDATE TO authenticated
  USING (app.has_permission(organisation_id, 'capa.manage'))
  WITH CHECK (app.has_permission(organisation_id, 'capa.manage'));
-- A child is visible exactly when its 8D is (the 8D's own policy applies to this subquery).
CREATE POLICY capa_steps_select ON public.capa_steps FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.capas c WHERE c.id = capa_id));
CREATE POLICY capa_ncr_links_select ON public.capa_ncr_links FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.capas c WHERE c.id = capa_id));
CREATE POLICY capa_team_members_select ON public.capa_team_members FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.capas c WHERE c.id = capa_id));
CREATE POLICY capa_team_members_insert ON public.capa_team_members FOR INSERT TO authenticated
  WITH CHECK (app.has_permission(organisation_id, 'capa.manage')
              AND EXISTS (SELECT 1 FROM public.capas c WHERE c.id = capa_id AND c.organisation_id = capa_team_members.organisation_id));
CREATE POLICY capa_team_members_update ON public.capa_team_members FOR UPDATE TO authenticated
  USING (app.has_permission(organisation_id, 'capa.manage'))
  WITH CHECK (app.has_permission(organisation_id, 'capa.manage'));

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------
-- Locks and returns an 8D the caller may change: they must be able to read it and hold p_permission, and (unless p_allow_ended) it must be running.
CREATE FUNCTION app.capa_for_update(p_id uuid, p_permission text, p_allow_ended boolean DEFAULT false)
RETURNS public.capas LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.capas%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.capas WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT app.has_permission(c.organisation_id, 'capa.read') THEN
    RAISE EXCEPTION '8D not found' USING ERRCODE = 'QM013';
  END IF;
  IF NOT app.has_permission(c.organisation_id, p_permission) THEN
    RAISE EXCEPTION 'You are not allowed to do that to an 8D (%)', p_permission USING ERRCODE = '42501';
  END IF;
  IF NOT p_allow_ended AND c.stage IN ('closed', 'cancelled') THEN
    RAISE EXCEPTION 'This 8D is %; reopen it to make changes', c.stage USING ERRCODE = 'QM013';
  END IF;
  RETURN c;
END $$;

-- What is still missing before a step can be completed (empty = ready). Steps D2 to D8 arrive in later slices.
CREATE FUNCTION app.capa_step_problems(p_capa uuid, p_step text) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.capas%ROWTYPE; v_problems text[] := ARRAY[]::text[]; v_leaders integer; v_people integer;
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
    ELSE
      v_problems := array_append(v_problems, 'This step is not available yet');
  END CASE;
  RETURN v_problems;
END $$;

-- Derives the stage from the steps. Only slice CAPA1 exists so far: a running 8D is open.
CREATE FUNCTION app.capa_recompute_stage(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.capas SET stage = 'open', stage_reason = NULL WHERE id = p_id AND stage NOT IN ('closed', 'cancelled');
END $$;

-- Starts an 8D. Optionally from a non-conformance (needs ncr.read there): the NC is linked and supplies what the caller left blank.
CREATE FUNCTION app.start_capa(p_organisation_id uuid, p_title text DEFAULT NULL, p_problem text DEFAULT NULL, p_source text DEFAULT NULL,
                               p_severity text DEFAULT NULL, p_from_ncr uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n public.nonconformances%ROWTYPE; v_id uuid; v_ref text; v_me uuid; v_title text; v_problem text; v_source text; v_severity text; s text;
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
  END IF;
  IF v_title IS NULL THEN
    RAISE EXCEPTION 'Give the 8D a title' USING ERRCODE = 'QM013';
  END IF;
  v_ref := app.next_capa_reference(p_organisation_id);
  INSERT INTO public.capas (organisation_id, reference, title, problem_statement, source, severity, owner_membership_id)
  VALUES (p_organisation_id, v_ref, v_title, v_problem, v_source, v_severity, v_me)
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

-- Links a non-conformance (the caller must be able to read it) to a running 8D.
CREATE FUNCTION app.link_capa_ncr(p_capa uuid, p_ncr uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.capas%ROWTYPE; n public.nonconformances%ROWTYPE; v_id uuid;
BEGIN
  c := app.capa_for_update(p_capa, 'capa.manage');
  SELECT * INTO n FROM public.nonconformances WHERE id = p_ncr AND organisation_id = c.organisation_id AND deleted_at IS NULL;
  IF NOT FOUND OR NOT app.has_permission(n.organisation_id, 'ncr.read', n.site_id) THEN
    RAISE EXCEPTION 'Non-conformance not found' USING ERRCODE = 'QM013';
  END IF;
  IF n.stage = 'cancelled' THEN
    RAISE EXCEPTION '% is cancelled and cannot be linked', n.reference USING ERRCODE = 'QM013';
  END IF;
  IF EXISTS (SELECT 1 FROM public.capa_ncr_links WHERE capa_id = p_capa AND nonconformance_id = p_ncr AND ended_at IS NULL) THEN
    RAISE EXCEPTION '% is already linked to this 8D', n.reference USING ERRCODE = 'QM013';
  END IF;
  INSERT INTO public.capa_ncr_links (organisation_id, capa_id, nonconformance_id) VALUES (c.organisation_id, p_capa, p_ncr) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Ends a link with a reason (the record of it stays).
CREATE FUNCTION app.unlink_capa_ncr(p_link uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE l public.capa_ncr_links%ROWTYPE;
BEGIN
  SELECT * INTO l FROM public.capa_ncr_links WHERE id = p_link;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Link not found' USING ERRCODE = 'QM013';
  END IF;
  PERFORM app.capa_for_update(l.capa_id, 'capa.manage');
  IF l.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'That link has already ended' USING ERRCODE = 'QM013';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'Say why the non-conformance is no longer linked' USING ERRCODE = 'QM013';
  END IF;
  UPDATE public.capa_ncr_links SET ended_at = now(), ended_by = auth.uid(), end_reason = btrim(p_reason) WHERE id = p_link;
END $$;

-- Completes a step, in any order, when nothing is still needed for it. Completing marks the step done; it does not lock anything.
CREATE FUNCTION app.capa_complete_step(p_capa uuid, p_step text, p_note text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.capas%ROWTYPE; s public.capa_steps%ROWTYPE; v_problems text[];
BEGIN
  c := app.capa_for_update(p_capa, 'capa.manage');
  SELECT * INTO s FROM public.capa_steps WHERE capa_id = p_capa AND step = p_step;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown step' USING ERRCODE = 'QM013';
  END IF;
  IF s.completed_at IS NOT NULL THEN
    RAISE EXCEPTION '% is already complete', upper(p_step) USING ERRCODE = 'QM013';
  END IF;
  v_problems := app.capa_step_problems(p_capa, p_step);
  IF cardinality(v_problems) > 0 THEN
    RAISE EXCEPTION '% cannot be completed yet: %', upper(p_step), array_to_string(v_problems, '; ') USING ERRCODE = 'QM013';
  END IF;
  UPDATE public.capa_steps SET completed_at = now(), completed_by = auth.uid(), note = nullif(btrim(coalesce(p_note, '')), '') WHERE id = s.id;
  PERFORM app.capa_recompute_stage(p_capa);
END $$;

-- Reopens one step (marks it not done again). Needs a reason; no other step is touched.
CREATE FUNCTION app.capa_reopen_step(p_capa uuid, p_step text, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.capas%ROWTYPE; s public.capa_steps%ROWTYPE;
BEGIN
  c := app.capa_for_update(p_capa, 'capa.manage');
  SELECT * INTO s FROM public.capa_steps WHERE capa_id = p_capa AND step = p_step;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown step' USING ERRCODE = 'QM013';
  END IF;
  IF s.completed_at IS NULL THEN
    RAISE EXCEPTION '% is not complete', upper(p_step) USING ERRCODE = 'QM013';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'Say why % is being reopened', upper(p_step) USING ERRCODE = 'QM013';
  END IF;
  UPDATE public.capa_steps SET completed_at = NULL, completed_by = NULL, note = NULL,
         reopened_at = now(), reopened_by = auth.uid(),
         reopen_reason = btrim(p_reason)
   WHERE id = s.id;
  PERFORM app.capa_recompute_stage(p_capa);
END $$;

CREATE FUNCTION app.cancel_capa(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.capas%ROWTYPE;
BEGIN
  c := app.capa_for_update(p_id, 'capa.manage');
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'Say why the 8D is being cancelled' USING ERRCODE = 'QM013';
  END IF;
  UPDATE public.capas SET stage = 'cancelled', stage_reason = btrim(p_reason) WHERE id = p_id;
END $$;

CREATE FUNCTION app.reopen_capa(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.capas%ROWTYPE;
BEGIN
  c := app.capa_for_update(p_id, 'capa.manage', true);
  IF c.stage NOT IN ('closed', 'cancelled') THEN
    RAISE EXCEPTION 'Only a closed or cancelled 8D can be reopened' USING ERRCODE = 'QM013';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'Say why the 8D is being reopened' USING ERRCODE = 'QM013';
  END IF;
  UPDATE public.capas SET stage = 'open', stage_reason = btrim(p_reason), closed_at = NULL, closed_by = NULL WHERE id = p_id;
  PERFORM app.capa_recompute_stage(p_id);
END $$;

-- ---------------------------------------------------------------------------
-- A non-conformance cannot be closed while a linked 8D is still running (decision C7).
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.ncr_closure_needs_finished_capa() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_refs text;
BEGIN
  IF NEW.stage = 'closed' AND OLD.stage IS DISTINCT FROM 'closed' THEN
    SELECT string_agg(c.reference, ', ' ORDER BY c.reference) INTO v_refs
      FROM public.capa_ncr_links l JOIN public.capas c ON c.id = l.capa_id
     WHERE l.nonconformance_id = NEW.id AND l.ended_at IS NULL AND c.stage NOT IN ('verified_effective', 'closed', 'cancelled');
    IF v_refs IS NOT NULL THEN
      RAISE EXCEPTION '% has an 8D that is still running (%). Finish or cancel the 8D, or unlink it with a reason, before closing.', NEW.reference, v_refs
        USING ERRCODE = 'QM005';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER nonconformances_closure_needs_capa BEFORE UPDATE OF stage ON public.nonconformances
  FOR EACH ROW EXECUTE FUNCTION app.ncr_closure_needs_finished_capa();

REVOKE ALL ON FUNCTION app.next_capa_reference(uuid), app.capa_rules(), app.capa_team_member_rules(), app.capa_children_no_delete(),
  app.capa_for_update(uuid, text, boolean), app.capa_step_problems(uuid, text), app.capa_recompute_stage(uuid),
  app.start_capa(uuid, text, text, text, text, uuid), app.link_capa_ncr(uuid, uuid), app.unlink_capa_ncr(uuid, text),
  app.capa_complete_step(uuid, text, text), app.capa_reopen_step(uuid, text, text), app.cancel_capa(uuid, text), app.reopen_capa(uuid, text),
  app.ncr_closure_needs_finished_capa() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.capa_step_problems(uuid, text), app.start_capa(uuid, text, text, text, text, uuid), app.link_capa_ncr(uuid, uuid),
  app.unlink_capa_ncr(uuid, text), app.capa_complete_step(uuid, text, text), app.capa_reopen_step(uuid, text, text),
  app.cancel_capa(uuid, text), app.reopen_capa(uuid, text) TO authenticated;
REVOKE ALL ON app.capa_counters FROM PUBLIC, anon, authenticated;
