-- CAPA4 (docs/capa-8d-plan.md): D5 permanent corrective actions, D6 implement and validate, D7 prevent recurrence, and the automatic stage.
--
--  * Actions (`capa_actions`) now also carry phases corrective (D5/D6) and preventive (D7), optionally linked to the root cause they address
--    (`root_cause_id`, a live cause of the same 8D; the link can be changed, interim actions have none).
--  * `capa_verifications`: did the corrective actions work? Append-only, written only by `app.record_capa_verification` (needs capa.verify). A failed
--    verification reopens D5 and D6 (marks them not done again); it needs a note saying what was found.
--  * The stage is worked out, never set by hand (app.capa_recompute_stage, run when an action is added or its status changes, when a step is
--    completed or reopened, and when a verification is recorded):
--      D4 not complete                         -> open
--      the latest verification failed          -> actions_in_progress (until the corrective actions change)
--      no open corrective action, one done     -> awaiting_verification
--      ... and an effective verification, with the corrective actions unchanged since -> verified_effective
--      otherwise                               -> actions_in_progress
--  * D5 needs an action for every occurrence cause, each with an owner and a due date. D6 needs the corrective actions done or cancelled, one done, and an
--    effective verification. D7 needs the lessons learned, and preventive actions done or a reason there are none.
--  * An 8D is a fluid document: completing D5, D6 or D7 locks nothing.

ALTER TABLE public.capas
  ADD COLUMN d7_lessons_learned text CHECK (d7_lessons_learned IS NULL OR length(btrim(d7_lessons_learned)) BETWEEN 1 AND 4000),
  ADD COLUMN d7_no_preventive_reason text CHECK (d7_no_preventive_reason IS NULL OR length(btrim(d7_no_preventive_reason)) BETWEEN 1 AND 2000);
GRANT UPDATE (d7_lessons_learned, d7_no_preventive_reason) ON public.capas TO authenticated;

-- Actions can name the cause they address.
ALTER TABLE public.capa_actions
  ADD CONSTRAINT capa_actions_root_cause_fkey FOREIGN KEY (root_cause_id, organisation_id) REFERENCES public.capa_root_causes (id, organisation_id),
  ADD CONSTRAINT capa_actions_interim_no_cause CHECK (phase <> 'interim' OR root_cause_id IS NULL);
GRANT UPDATE (root_cause_id) ON public.capa_actions TO authenticated;

CREATE OR REPLACE FUNCTION app.capa_action_rules() RETURNS trigger
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
    IF NEW.capa_id <> OLD.capa_id OR NEW.phase <> OLD.phase THEN
      RAISE EXCEPTION 'An action cannot be moved to another 8D or phase' USING ERRCODE = 'QM013';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF NEW.status = 'done' THEN
        NEW.done_at := clock_timestamp(); NEW.done_by := auth.uid(); NEW.cancel_reason := NULL;
      ELSIF NEW.status = 'cancelled' THEN
        NEW.done_at := NULL; NEW.done_by := NULL;
        IF NEW.cancel_reason IS NULL THEN
          RAISE EXCEPTION 'Say why the action is cancelled' USING ERRCODE = 'QM013';
        END IF;
      ELSE
        NEW.done_at := NULL; NEW.done_by := NULL; NEW.cancel_reason := NULL;
      END IF;
    ELSE
      NEW.done_at := OLD.done_at; NEW.done_by := OLD.done_by;
      IF NEW.status <> 'cancelled' THEN NEW.cancel_reason := OLD.cancel_reason; END IF;
    END IF;
  END IF;
  IF NEW.owner_team_member_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.owner_team_member_id IS DISTINCT FROM OLD.owner_team_member_id)
     AND NOT EXISTS (SELECT 1 FROM public.capa_team_members t WHERE t.id = NEW.owner_team_member_id AND t.capa_id = NEW.capa_id AND t.ended_at IS NULL) THEN
    RAISE EXCEPTION 'The owner must be on the team of this 8D' USING ERRCODE = 'QM013';
  END IF;
  IF NEW.root_cause_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.root_cause_id IS DISTINCT FROM OLD.root_cause_id)
     AND NOT EXISTS (SELECT 1 FROM public.capa_root_causes r WHERE r.id = NEW.root_cause_id AND r.capa_id = NEW.capa_id AND r.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'That root cause is not part of this 8D' USING ERRCODE = 'QM013';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- Verifications: did the corrective actions work?
-- ---------------------------------------------------------------------------
CREATE TABLE public.capa_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Orders verifications even when several are recorded in one transaction (created_at is the transaction time).
  seq bigint GENERATED ALWAYS AS IDENTITY,
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  capa_id uuid NOT NULL,
  effective boolean NOT NULL,
  method text NOT NULL CHECK (length(btrim(method)) BETWEEN 1 AND 200),
  notes text CHECK (notes IS NULL OR length(btrim(notes)) BETWEEN 1 AND 2000),
  -- What the corrective actions looked like when this was recorded (see app.capa_actions_fingerprint): a later change makes it stale.
  actions_fingerprint text NOT NULL,
  verified_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT capa_verifications_capa_fkey FOREIGN KEY (capa_id, organisation_id) REFERENCES public.capas (id, organisation_id) ON DELETE CASCADE,
  CONSTRAINT capa_verifications_failed_has_notes CHECK (effective OR notes IS NOT NULL)
);
CREATE INDEX capa_verifications_capa_idx ON public.capa_verifications (capa_id, seq DESC);

CREATE FUNCTION app.capa_verification_no_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'A verification is a record: it is never changed or deleted' USING ERRCODE = 'QM013';
END $$;

CREATE TRIGGER capa_verifications_stamp BEFORE INSERT ON public.capa_verifications FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER capa_verifications_no_update BEFORE UPDATE ON public.capa_verifications FOR EACH ROW EXECUTE FUNCTION app.capa_verification_no_change();
CREATE TRIGGER capa_verifications_no_delete BEFORE DELETE ON public.capa_verifications FOR EACH ROW EXECUTE FUNCTION app.capa_verification_no_change();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.capa_verifications FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.capa_verifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.capa_verifications FROM anon, authenticated;
GRANT SELECT ON public.capa_verifications TO authenticated;
CREATE POLICY capa_verifications_select ON public.capa_verifications FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.capas c WHERE c.id = capa_id));

-- A fingerprint of the corrective actions that count (not cancelled): which, their status and when they were done.
CREATE FUNCTION app.capa_actions_fingerprint(p_capa uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT md5(coalesce(string_agg(a.id::text || ':' || a.status || ':' || coalesce(a.done_at::text, ''), ',' ORDER BY a.id), ''))
    FROM public.capa_actions a WHERE a.capa_id = p_capa AND a.phase = 'corrective' AND a.status <> 'cancelled'
$$;

-- The state of the latest verification: none, effective, failed, or stale (the corrective actions changed after it: one added, done again, reopened).
CREATE FUNCTION app.capa_verification_state(p_capa uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.capa_verifications%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.capa_verifications WHERE capa_id = p_capa ORDER BY seq DESC LIMIT 1;
  IF NOT FOUND THEN RETURN 'none'; END IF;
  IF v.actions_fingerprint <> app.capa_actions_fingerprint(p_capa) THEN
    RETURN 'stale';
  END IF;
  RETURN CASE WHEN v.effective THEN 'effective' ELSE 'failed' END;
END $$;

-- The same state for a caller who can read the 8D (the API shows it on the verification card).
CREATE FUNCTION app.capa_verification_status(p_capa uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid;
BEGIN
  SELECT organisation_id INTO v_org FROM public.capas WHERE id = p_capa;
  IF NOT FOUND OR NOT app.has_permission(v_org, 'capa.read') THEN
    RAISE EXCEPTION '8D not found' USING ERRCODE = 'QM013';
  END IF;
  RETURN app.capa_verification_state(p_capa);
END $$;

-- Derives the stage from the work done (see the header). Closed and cancelled 8Ds keep theirs.
CREATE OR REPLACE FUNCTION app.capa_recompute_stage(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_stage text; v_open integer; v_done integer; v_state text; v_new text;
BEGIN
  SELECT stage INTO v_stage FROM public.capas WHERE id = p_id;
  IF NOT FOUND OR v_stage IN ('closed', 'cancelled') THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.capa_steps WHERE capa_id = p_id AND step = 'd4' AND completed_at IS NOT NULL) THEN
    v_new := 'open';
  ELSE
    SELECT count(*) FILTER (WHERE status = 'open'), count(*) FILTER (WHERE status = 'done') INTO v_open, v_done
      FROM public.capa_actions WHERE capa_id = p_id AND phase = 'corrective';
    v_state := app.capa_verification_state(p_id);
    v_new := CASE
      WHEN v_state = 'effective' AND v_open = 0 THEN 'verified_effective'
      WHEN v_state = 'failed' THEN 'actions_in_progress'
      WHEN v_open = 0 AND v_done >= 1 THEN 'awaiting_verification'
      ELSE 'actions_in_progress' END;
  END IF;
  IF v_new <> v_stage THEN
    UPDATE public.capas SET stage = v_new WHERE id = p_id;
  END IF;
END $$;

CREATE FUNCTION app.capa_action_stage_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.phase = 'corrective' THEN
    PERFORM app.capa_recompute_stage(NEW.capa_id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER capa_actions_stage AFTER INSERT OR UPDATE OF status ON public.capa_actions FOR EACH ROW EXECUTE FUNCTION app.capa_action_stage_trigger();

-- Records whether the corrective actions worked (capa.verify). A failed verification needs a note and reopens D5 and D6.
CREATE FUNCTION app.record_capa_verification(p_capa uuid, p_effective boolean, p_method text, p_notes text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.capas%ROWTYPE; v_open integer; v_done integer; v_id uuid; v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
BEGIN
  c := app.capa_for_update(p_capa, 'capa.verify');
  SELECT count(*) FILTER (WHERE status = 'open'), count(*) FILTER (WHERE status = 'done') INTO v_open, v_done
    FROM public.capa_actions WHERE capa_id = p_capa AND phase = 'corrective';
  IF v_open > 0 THEN
    RAISE EXCEPTION 'Finish or cancel the % open corrective % before verifying', v_open, CASE WHEN v_open = 1 THEN 'action' ELSE 'actions' END USING ERRCODE = 'QM013';
  END IF;
  IF v_done = 0 THEN
    RAISE EXCEPTION 'Carry out at least one corrective action before verifying' USING ERRCODE = 'QM013';
  END IF;
  IF p_method IS NULL OR length(btrim(p_method)) = 0 THEN
    RAISE EXCEPTION 'Say how effectiveness was checked' USING ERRCODE = 'QM013';
  END IF;
  IF NOT p_effective AND v_notes IS NULL THEN
    RAISE EXCEPTION 'Say what was found when the actions did not work' USING ERRCODE = 'QM013';
  END IF;
  INSERT INTO public.capa_verifications (organisation_id, capa_id, effective, method, notes, actions_fingerprint)
  VALUES (c.organisation_id, p_capa, p_effective, btrim(p_method), v_notes, app.capa_actions_fingerprint(p_capa)) RETURNING id INTO v_id;
  IF NOT p_effective THEN
    UPDATE public.capa_steps SET completed_at = NULL, completed_by = NULL, note = NULL, reopened_at = now(), reopened_by = auth.uid(),
           reopen_reason = 'Verification failed: ' || v_notes
     WHERE capa_id = p_capa AND step IN ('d5', 'd6') AND completed_at IS NOT NULL;
  END IF;
  PERFORM app.capa_recompute_stage(p_capa);
  PERFORM app.emit_event(c.organisation_id, 'capa.verified', 'capa', p_capa, jsonb_build_object('reference', c.reference, 'effective', p_effective));
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------
-- What each step still needs (D0 to D7; D8 arrives in the next slice).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.capa_step_problems(p_capa uuid, p_step text) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.capas%ROWTYPE; v_problems text[] := ARRAY[]::text[]; v_leaders integer; v_people integer; v_open integer; v_done integer; v_occurrence integer; v_unverified integer;
        v_missing record; v_incomplete integer; v_state text;
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
    WHEN 'd4' THEN
      SELECT count(*) FILTER (WHERE kind = 'occurrence'), count(*) FILTER (WHERE NOT verified) INTO v_occurrence, v_unverified
        FROM public.capa_root_causes WHERE capa_id = p_capa AND deleted_at IS NULL;
      IF v_occurrence = 0 THEN
        v_problems := array_append(v_problems, 'Record at least one occurrence root cause (why the problem happened)');
      END IF;
      IF v_unverified > 0 THEN
        v_problems := array_append(v_problems, format('Verify the %s root %s not yet verified', v_unverified, CASE WHEN v_unverified = 1 THEN 'cause' ELSE 'causes' END));
      END IF;
    WHEN 'd5' THEN
      SELECT count(*) INTO v_occurrence FROM public.capa_root_causes WHERE capa_id = p_capa AND deleted_at IS NULL AND kind = 'occurrence';
      IF v_occurrence = 0 THEN
        v_problems := array_append(v_problems, 'Record an occurrence root cause in D4 first');
      END IF;
      FOR v_missing IN
        SELECT r.description FROM public.capa_root_causes r
         WHERE r.capa_id = p_capa AND r.deleted_at IS NULL AND r.kind = 'occurrence'
           AND NOT EXISTS (SELECT 1 FROM public.capa_actions a WHERE a.root_cause_id = r.id AND a.phase = 'corrective' AND a.status <> 'cancelled')
         ORDER BY r.created_at
      LOOP
        v_problems := array_append(v_problems, 'Add a corrective action for: ' || left(v_missing.description, 60) || CASE WHEN length(v_missing.description) > 60 THEN '…' ELSE '' END);
      END LOOP;
      SELECT count(*) INTO v_incomplete FROM public.capa_actions
       WHERE capa_id = p_capa AND phase = 'corrective' AND status <> 'cancelled' AND (owner_team_member_id IS NULL OR due_date IS NULL);
      IF v_incomplete > 0 THEN
        v_problems := array_append(v_problems, format('%s corrective %s an owner and a due date', v_incomplete, CASE WHEN v_incomplete = 1 THEN 'action needs' ELSE 'actions need' END));
      END IF;
    WHEN 'd6' THEN
      SELECT count(*) FILTER (WHERE status = 'open'), count(*) FILTER (WHERE status = 'done') INTO v_open, v_done
        FROM public.capa_actions WHERE capa_id = p_capa AND phase = 'corrective';
      IF v_open > 0 THEN
        v_problems := array_append(v_problems, format('Finish or cancel the %s open corrective %s', v_open, CASE WHEN v_open = 1 THEN 'action' ELSE 'actions' END));
      END IF;
      IF v_done = 0 THEN
        v_problems := array_append(v_problems, 'Carry out at least one corrective action');
      END IF;
      v_state := app.capa_verification_state(p_capa);
      IF v_state = 'none' THEN
        v_problems := array_append(v_problems, 'Verify that the corrective actions worked (needs someone who can verify)');
      ELSIF v_state = 'failed' THEN
        v_problems := array_append(v_problems, 'The last verification failed: put it right and verify again');
      ELSIF v_state = 'stale' THEN
        v_problems := array_append(v_problems, 'The corrective actions changed after the last verification: verify again');
      END IF;
    WHEN 'd7' THEN
      IF c.d7_lessons_learned IS NULL THEN v_problems := array_append(v_problems, 'Write the lessons learned'); END IF;
      SELECT count(*) FILTER (WHERE status = 'open'), count(*) FILTER (WHERE status = 'done') INTO v_open, v_done
        FROM public.capa_actions WHERE capa_id = p_capa AND phase = 'preventive';
      IF v_open > 0 THEN
        v_problems := array_append(v_problems, format('Finish or cancel the %s open preventive %s', v_open, CASE WHEN v_open = 1 THEN 'action' ELSE 'actions' END));
      END IF;
      IF v_done = 0 AND c.d7_no_preventive_reason IS NULL THEN
        v_problems := array_append(v_problems, 'Add a preventive action, or say why none is needed');
      END IF;
    ELSE
      v_problems := array_append(v_problems, 'This step is not available yet');
  END CASE;
  RETURN v_problems;
END $$;

REVOKE ALL ON FUNCTION app.capa_verification_no_change(), app.capa_actions_fingerprint(uuid), app.capa_verification_state(uuid), app.capa_verification_status(uuid), app.capa_recompute_stage(uuid), app.capa_action_stage_trigger(),
  app.capa_action_rules(), app.record_capa_verification(uuid, boolean, text, text), app.capa_step_problems(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.record_capa_verification(uuid, boolean, text, text), app.capa_verification_status(uuid), app.capa_step_problems(uuid, text) TO authenticated;
