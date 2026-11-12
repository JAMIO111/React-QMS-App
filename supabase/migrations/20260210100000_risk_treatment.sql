-- Risk register RK2 (docs/risk-management-plan.md §12): treatment, actions, what is left afterwards, acceptance, reviews and closing.
--
--  * Treatment: a strategy (mitigate / avoid / transfer / accept; exploit for an opportunity) and a plan in words, plus `risk_actions`
--    (owner = active member, due date; done with a note, cancelled with a reason, reopened; never deleted).
--  * Residual assessments: app.assess_risk takes the phase. The residual one says what is left after treatment; never before an inherent one.
--  * Acceptance (RM5): a risk whose assessment in force (residual when there is one, else inherent) sits above the matrix's acceptable band
--    needs `risk_acceptances`: proposed by a manager, decided by someone ELSE with risk.approve. It holds for the assessment it names: assessing
--    again asks afresh.
--  * The status is worked out, never set by hand: draft -> open (assessed) -> treating (a strategy is chosen) -> monitoring (nothing left to do:
--    app.risk_treatment_problems is empty) -> closed (treated / accepted / no longer applies) and reopened with a reason.
--  * Reviews (RM6): `next_review_on` = the day of the assessment or review + the months the matrix gives its band. Overdue is worked out on read.
--    `risk_reviews` is append-only: "no change" with a note, or "reassessed" written by each later assessment.
-- No table writes: SECURITY DEFINER functions only. Errors QM026 (409 risk_rule); another organisation P0002.

ALTER TABLE public.risks
  ADD COLUMN strategy text CHECK (strategy IS NULL OR strategy IN ('mitigate', 'avoid', 'transfer', 'accept', 'exploit')),
  ADD COLUMN treatment_plan text CHECK (treatment_plan IS NULL OR length(btrim(treatment_plan)) BETWEEN 1 AND 4000),
  ADD COLUMN next_review_on date,
  ADD COLUMN outcome text CHECK (outcome IS NULL OR outcome IN ('treated', 'accepted', 'no_longer_applies')),
  ADD COLUMN close_note text CHECK (close_note IS NULL OR length(btrim(close_note)) BETWEEN 3 AND 2000),
  ADD COLUMN closed_at timestamptz,
  ADD COLUMN closed_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  ADD COLUMN reopen_reason text CHECK (reopen_reason IS NULL OR length(btrim(reopen_reason)) BETWEEN 3 AND 500),
  ADD CONSTRAINT risks_strategy_kind_check CHECK (strategy IS NULL OR (kind = 'opportunity') = (strategy = 'exploit') OR strategy = 'accept'),
  ADD CONSTRAINT risks_closed_state_check CHECK ((status <> 'closed' OR outcome IS NOT NULL) AND (outcome IS NULL OR status IN ('closed', 'retired'))
                                                 AND ((outcome IS NULL) = (closed_at IS NULL)) AND ((outcome IS NULL) = (close_note IS NULL)));
CREATE INDEX risks_review_idx ON public.risks (organisation_id, next_review_on) WHERE next_review_on IS NOT NULL;

-- Existing assessed risks get their first review date from the day they were assessed.
ALTER TABLE public.risks DISABLE TRIGGER USER;
UPDATE public.risks r SET next_review_on = (a.assessed_on + make_interval(months => (m.config -> 'reviewMonths' ->> a.band)::integer))::date
  FROM public.risk_assessments a, public.risk_models m
 WHERE a.risk_id = r.id AND a.phase = 'inherent' AND a.status = 'current' AND m.organisation_id = r.organisation_id AND m.current AND r.status <> 'retired';
ALTER TABLE public.risks ENABLE TRIGGER USER;

CREATE TABLE public.risk_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  risk_id uuid NOT NULL,
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 2000),
  owner_user_id uuid NOT NULL REFERENCES auth.users (id),
  due_date date,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  done_note text CHECK (done_note IS NULL OR length(btrim(done_note)) BETWEEN 1 AND 2000),
  done_at timestamptz,
  done_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  cancel_reason text CHECK (cancel_reason IS NULL OR length(btrim(cancel_reason)) BETWEEN 3 AND 500),
  cancelled_at timestamptz,
  cancelled_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT risk_actions_risk_fkey FOREIGN KEY (risk_id, organisation_id) REFERENCES public.risks (id, organisation_id),
  CONSTRAINT risk_actions_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT risk_actions_state_check CHECK (((status = 'done') = (done_at IS NOT NULL AND done_note IS NOT NULL)) AND ((status = 'cancelled') = (cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL)))
);
CREATE INDEX risk_actions_risk_idx ON public.risk_actions (organisation_id, risk_id);
CREATE INDEX risk_actions_owner_idx ON public.risk_actions (organisation_id, owner_user_id) WHERE status = 'open';

CREATE TABLE public.risk_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  risk_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('no_change', 'reassessed')),
  note text NOT NULL CHECK (length(btrim(note)) BETWEEN 3 AND 2000),
  assessment_id uuid REFERENCES public.risk_assessments (id),
  was_due_on date,
  next_review_on date,
  reviewed_on date NOT NULL DEFAULT current_date,
  reviewed_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT risk_reviews_risk_fkey FOREIGN KEY (risk_id, organisation_id) REFERENCES public.risks (id, organisation_id),
  CONSTRAINT risk_reviews_state_check CHECK ((outcome = 'reassessed') = (assessment_id IS NOT NULL))
);
CREATE INDEX risk_reviews_risk_idx ON public.risk_reviews (organisation_id, risk_id);

CREATE TABLE public.risk_acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  risk_id uuid NOT NULL,
  assessment_id uuid NOT NULL REFERENCES public.risk_assessments (id),
  band text NOT NULL CHECK (band IN ('low', 'medium', 'high', 'critical')),
  rationale text NOT NULL CHECK (length(btrim(rationale)) BETWEEN 10 AND 2000),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'rejected', 'withdrawn')),
  proposed_by uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users (id),
  decided_at timestamptz,
  decided_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  decision_note text CHECK (decision_note IS NULL OR length(btrim(decision_note)) BETWEEN 3 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT risk_acceptances_risk_fkey FOREIGN KEY (risk_id, organisation_id) REFERENCES public.risks (id, organisation_id),
  CONSTRAINT risk_acceptances_state_check CHECK ((status = 'proposed') = (decided_at IS NULL) AND (status = 'proposed' OR decision_note IS NOT NULL))
);
CREATE UNIQUE INDEX risk_acceptances_open_key ON public.risk_acceptances (risk_id) WHERE status = 'proposed';
CREATE INDEX risk_acceptances_risk_idx ON public.risk_acceptances (organisation_id, risk_id);

-- A review is a record; an acceptance is decided once; an action is never deleted.
CREATE FUNCTION app.risk_review_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'A risk review is a record and cannot be changed or deleted' USING ERRCODE = 'QM026';
END $$;
CREATE TRIGGER risk_reviews_frozen BEFORE UPDATE OR DELETE ON public.risk_reviews FOR EACH ROW EXECUTE FUNCTION app.risk_review_frozen();

CREATE FUNCTION app.risk_acceptance_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'An acceptance is never deleted' USING ERRCODE = 'QM026'; END IF;
  IF OLD.status <> 'proposed' OR NEW.status = 'proposed'
     OR (to_jsonb(NEW) - ARRAY['status', 'decided_at', 'decided_by', 'decision_note', 'updated_at', 'updated_by'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'decided_at', 'decided_by', 'decision_note', 'updated_at', 'updated_by']) THEN
    RAISE EXCEPTION 'An acceptance is decided once and then kept as it is' USING ERRCODE = 'QM026';
  END IF;
  IF NEW.status = 'approved' AND NEW.decided_by IS NOT DISTINCT FROM OLD.proposed_by THEN
    RAISE EXCEPTION 'An acceptance is approved by someone other than the person who proposed it' USING ERRCODE = 'QM026';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER risk_acceptances_frozen BEFORE UPDATE OR DELETE ON public.risk_acceptances FOR EACH ROW EXECUTE FUNCTION app.risk_acceptance_frozen();

CREATE FUNCTION app.risk_action_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'An action is never deleted. Cancel it with a reason.' USING ERRCODE = 'QM026'; END IF;
  IF NEW.risk_id IS DISTINCT FROM OLD.risk_id THEN RAISE EXCEPTION 'An action stays on its risk' USING ERRCODE = 'QM026'; END IF;
  IF OLD.status <> 'open' AND NEW.status = OLD.status THEN
    RAISE EXCEPTION 'This action is % and cannot be changed until it is reopened', OLD.status USING ERRCODE = 'QM026';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER risk_actions_rules BEFORE UPDATE OR DELETE ON public.risk_actions FOR EACH ROW EXECUTE FUNCTION app.risk_action_rules();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['risk_actions', 'risk_reviews', 'risk_acceptances'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION app.stamp_created()', t || '_stamp', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.touch_updated()', t || '_touch', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change()', t || '_org_immutable', t);
    EXECUTE format('CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION audit.record_change(''organisation_id'')', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (app.has_permission(organisation_id, ''risk.read''))', t || '_select', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Working things out
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.risk_band_rank(p_band text) RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$ SELECT array_position(ARRAY['low', 'medium', 'high', 'critical'], p_band) $$;

-- The assessment in force: what is left after treatment when that has been assessed, else the one before treatment.
CREATE FUNCTION app.risk_effective_assessment(p_risk uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT a.id FROM public.risk_assessments a WHERE a.risk_id = p_risk AND a.status = 'current' ORDER BY (a.phase = 'residual') DESC LIMIT 1
$$;

-- {assessmentId, band, acceptanceBand, above (band above the acceptable one), accepted (an approved acceptance of this very assessment), waiting (one proposed)}.
CREATE FUNCTION app.risk_acceptance_state(p_risk uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.risks%ROWTYPE; a public.risk_assessments%ROWTYPE; v_accept text;
BEGIN
  SELECT * INTO r FROM public.risks WHERE id = p_risk;
  IF NOT FOUND OR NOT app.has_permission(r.organisation_id, 'risk.read') THEN RAISE EXCEPTION 'Risk not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO a FROM public.risk_assessments WHERE id = app.risk_effective_assessment(p_risk);
  SELECT m.config ->> 'acceptanceBand' INTO v_accept FROM public.risk_models m WHERE m.organisation_id = r.organisation_id AND m.current;
  RETURN jsonb_build_object(
    'assessmentId', a.id, 'band', a.band, 'acceptanceBand', v_accept,
    'above', a.id IS NOT NULL AND r.kind = 'risk' AND app.risk_band_rank(a.band) > app.risk_band_rank(v_accept),
    'accepted', a.id IS NOT NULL AND EXISTS (SELECT 1 FROM public.risk_acceptances x WHERE x.risk_id = p_risk AND x.assessment_id = a.id AND x.status = 'approved'),
    'waiting', EXISTS (SELECT 1 FROM public.risk_acceptances x WHERE x.risk_id = p_risk AND x.status = 'proposed'));
END $$;

-- What still stands between an assessed risk and "monitoring" (nothing left to do but review it). Empty = monitoring.
CREATE FUNCTION app.risk_treatment_problems(p_risk uuid) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.risks%ROWTYPE; v text[] := '{}'; v_open integer; v_residual boolean; s jsonb; v_word text;
BEGIN
  SELECT * INTO r FROM public.risks WHERE id = p_risk;
  IF NOT FOUND OR NOT app.has_permission(r.organisation_id, 'risk.read') THEN RAISE EXCEPTION 'Risk not found' USING ERRCODE = 'P0002'; END IF;
  v_word := CASE WHEN r.kind = 'opportunity' THEN 'opportunity' ELSE 'risk' END;
  IF NOT EXISTS (SELECT 1 FROM public.risk_assessments a WHERE a.risk_id = r.id AND a.phase = 'inherent' AND a.status = 'current') THEN
    RETURN ARRAY['Assess the ' || v_word];
  END IF;
  IF r.strategy IS NULL THEN v := v || ('Choose what will be done about the ' || v_word); END IF;
  SELECT count(*) INTO v_open FROM public.risk_actions x WHERE x.risk_id = r.id AND x.status = 'open';
  IF v_open > 0 THEN v := v || (v_open || CASE WHEN v_open = 1 THEN ' action is still open' ELSE ' actions are still open' END); END IF;
  IF r.kind = 'opportunity' OR r.strategy IS NULL THEN RETURN v; END IF;
  v_residual := EXISTS (SELECT 1 FROM public.risk_assessments a WHERE a.risk_id = r.id AND a.phase = 'residual' AND a.status = 'current');
  IF r.strategy <> 'accept' AND NOT v_residual THEN RETURN v || 'Assess what is left after treatment'::text; END IF;
  s := app.risk_acceptance_state(r.id);
  IF (s ->> 'above')::boolean AND NOT (s ->> 'accepted')::boolean THEN
    v := v || CASE WHEN (s ->> 'waiting')::boolean THEN 'The acceptance is waiting for an approver'
                   ELSE 'It is ' || (s ->> 'band') || ', above the level the organisation accepts (' || (s ->> 'acceptanceBand') || '): reduce it, or have it accepted by an approver' END;
  END IF;
  RETURN v;
END $$;

-- The status follows the facts (internal).
CREATE FUNCTION app.risk_recompute_status(p_risk uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.risks%ROWTYPE; v_status text;
BEGIN
  SELECT * INTO r FROM public.risks WHERE id = p_risk FOR UPDATE;
  IF r.status = 'retired' THEN RETURN; END IF;
  v_status := CASE
    WHEN NOT EXISTS (SELECT 1 FROM public.risk_assessments a WHERE a.risk_id = r.id AND a.phase = 'inherent' AND a.status = 'current') THEN 'draft'
    WHEN r.outcome IS NOT NULL THEN 'closed'
    WHEN r.strategy IS NULL THEN 'open'
    WHEN cardinality(app.risk_treatment_problems(r.id)) = 0 THEN 'monitoring'
    ELSE 'treating' END;
  IF v_status IS DISTINCT FROM r.status THEN UPDATE public.risks SET status = v_status WHERE id = r.id; END IF;
END $$;

-- The risk row, locked, for someone who may manage it and while it can still change.
CREATE FUNCTION app.risk_for_change(p_risk uuid, p_what text) RETURNS public.risks
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.risks%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.risks WHERE id = p_risk FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(r.organisation_id) THEN RAISE EXCEPTION 'Risk not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_risk_manager(r.organisation_id);
  IF r.status IN ('closed', 'retired') THEN RAISE EXCEPTION '% is % and cannot be %', r.reference, r.status, p_what USING ERRCODE = 'QM026'; END IF;
  RETURN r;
END $$;

CREATE FUNCTION app.risk_review_date(p_organisation_id uuid, p_band text, p_from date) RETURNS date
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT (p_from + make_interval(months => (m.config -> 'reviewMonths' ->> p_band)::integer))::date
    FROM public.risk_models m WHERE m.organisation_id = p_organisation_id AND m.current
$$;

-- ---------------------------------------------------------------------------
-- Assessing (replaces RK1's): the phase is inherent (before treatment) or residual (what is left after it).
-- ---------------------------------------------------------------------------
DROP FUNCTION app.assess_risk(uuid, integer, integer, text);
CREATE FUNCTION app.assess_risk(p_risk uuid, p_likelihood integer, p_consequence integer, p_rationale text, p_phase text DEFAULT 'inherent') RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  r public.risks%ROWTYPE; v_score jsonb; v_prev uuid; v_id uuid; v_rationale text := btrim(coalesce(p_rationale, '')); v_phase text := coalesce(p_phase, 'inherent');
  v_first boolean; v_band text; v_next date;
BEGIN
  r := app.risk_for_change(p_risk, 'assessed');
  IF v_phase NOT IN ('inherent', 'residual') THEN RAISE EXCEPTION 'An assessment is before treatment (inherent) or after it (residual)' USING ERRCODE = 'QM026'; END IF;
  IF length(v_rationale) < 3 THEN RAISE EXCEPTION 'Say why you scored it this way (at least 3 characters)' USING ERRCODE = 'QM026'; END IF;
  IF length(v_rationale) > 2000 THEN RAISE EXCEPTION 'The reasoning is up to 2000 characters' USING ERRCODE = 'QM026'; END IF;
  v_first := NOT EXISTS (SELECT 1 FROM public.risk_assessments WHERE risk_id = r.id);
  IF v_phase = 'residual' AND NOT EXISTS (SELECT 1 FROM public.risk_assessments WHERE risk_id = r.id AND phase = 'inherent' AND status = 'current') THEN
    RAISE EXCEPTION 'Assess % before treatment first', r.reference USING ERRCODE = 'QM026';
  END IF;
  v_score := app.score_risk(r.organisation_id, p_likelihood, p_consequence);
  SELECT id INTO v_prev FROM public.risk_assessments WHERE risk_id = r.id AND phase = v_phase AND status = 'current' FOR UPDATE;
  IF v_prev IS NOT NULL THEN UPDATE public.risk_assessments SET status = 'superseded' WHERE id = v_prev; END IF;
  INSERT INTO public.risk_assessments (organisation_id, risk_id, phase, likelihood, consequence, score, band, model_id, model_version, rationale, supersedes_id)
  VALUES (r.organisation_id, r.id, v_phase, p_likelihood, p_consequence, (v_score ->> 'score')::integer, v_score ->> 'band',
          (v_score ->> 'modelId')::uuid, (v_score ->> 'modelVersion')::integer, v_rationale, v_prev)
  RETURNING id INTO v_id;
  -- An acceptance still waiting was for the assessment as it stood.
  UPDATE public.risk_acceptances SET status = 'withdrawn', decided_at = now(), decided_by = auth.uid(), decision_note = 'The risk was assessed again'
   WHERE risk_id = r.id AND status = 'proposed';
  SELECT a.band INTO v_band FROM public.risk_assessments a WHERE a.id = app.risk_effective_assessment(r.id);
  v_next := app.risk_review_date(r.organisation_id, v_band, current_date);
  IF NOT v_first THEN
    INSERT INTO public.risk_reviews (organisation_id, risk_id, outcome, note, assessment_id, was_due_on, next_review_on)
    VALUES (r.organisation_id, r.id, 'reassessed', left(v_rationale, 2000), v_id, r.next_review_on, v_next);
  END IF;
  UPDATE public.risks SET next_review_on = v_next, updated_at = now() WHERE id = r.id;
  PERFORM app.risk_recompute_status(r.id);
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------
-- Treatment and actions
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.set_risk_treatment(p_risk uuid, p_strategy text, p_plan text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.risks%ROWTYPE; v_plan text := nullif(btrim(coalesce(p_plan, '')), '');
BEGIN
  r := app.risk_for_change(p_risk, 'changed');
  IF r.status = 'draft' THEN RAISE EXCEPTION 'Assess % before deciding what to do about it', r.reference USING ERRCODE = 'QM026'; END IF;
  IF p_strategy IS NULL OR p_strategy NOT IN ('mitigate', 'avoid', 'transfer', 'accept', 'exploit') THEN
    RAISE EXCEPTION 'Choose what will be done: mitigate, avoid, transfer or accept (exploit or leave, for an opportunity)' USING ERRCODE = 'QM026';
  END IF;
  IF r.kind = 'opportunity' AND p_strategy NOT IN ('exploit', 'accept') THEN RAISE EXCEPTION 'An opportunity is exploited or left' USING ERRCODE = 'QM026'; END IF;
  IF r.kind = 'risk' AND p_strategy = 'exploit' THEN RAISE EXCEPTION 'Only an opportunity is exploited' USING ERRCODE = 'QM026'; END IF;
  IF v_plan IS NOT NULL AND length(v_plan) > 4000 THEN RAISE EXCEPTION 'The plan is up to 4000 characters' USING ERRCODE = 'QM026'; END IF;
  UPDATE public.risks SET strategy = p_strategy, treatment_plan = v_plan WHERE id = r.id;
  PERFORM app.risk_recompute_status(r.id);
END $$;

CREATE FUNCTION app.assert_risk_action_fields(p_organisation_id uuid, p_description text, p_owner uuid, p_check_owner boolean) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_description IS NULL OR length(p_description) = 0 THEN RAISE EXCEPTION 'Say what is to be done' USING ERRCODE = 'QM026'; END IF;
  IF length(p_description) > 2000 THEN RAISE EXCEPTION 'The action is up to 2000 characters' USING ERRCODE = 'QM026'; END IF;
  IF p_owner IS NULL OR (p_check_owner AND NOT app.is_active_member_user(p_organisation_id, p_owner)) THEN
    RAISE EXCEPTION 'The action is given to an active member of this organisation' USING ERRCODE = 'QM026';
  END IF;
END $$;

-- Keys: description, ownerId (default: the risk's owner), dueDate.
CREATE FUNCTION app.add_risk_action(p_risk uuid, p_data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.risks%ROWTYPE; v_id uuid; v_desc text; v_owner uuid;
BEGIN
  r := app.risk_for_change(p_risk, 'given actions');
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Send the action as an object' USING ERRCODE = 'QM026'; END IF;
  v_desc := btrim(coalesce(p_data ->> 'description', ''));
  v_owner := coalesce(nullif(p_data ->> 'ownerId', '')::uuid, r.owner_user_id);
  PERFORM app.assert_risk_action_fields(r.organisation_id, v_desc, v_owner, true);
  INSERT INTO public.risk_actions (organisation_id, risk_id, description, owner_user_id, due_date)
  VALUES (r.organisation_id, r.id, v_desc, v_owner, nullif(p_data ->> 'dueDate', '')::date) RETURNING id INTO v_id;
  PERFORM app.risk_recompute_status(r.id);
  RETURN v_id;
END $$;

-- An open action: keys present are set (dueDate null clears it).
CREATE FUNCTION app.update_risk_action(p_action uuid, p_data jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE x public.risk_actions%ROWTYPE; r public.risks%ROWTYPE; v_desc text; v_owner uuid;
BEGIN
  SELECT * INTO x FROM public.risk_actions WHERE id = p_action FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(x.organisation_id) THEN RAISE EXCEPTION 'Action not found' USING ERRCODE = 'P0002'; END IF;
  r := app.risk_for_change(x.risk_id, 'changed');
  IF x.status <> 'open' THEN RAISE EXCEPTION 'This action is % and cannot be changed until it is reopened', x.status USING ERRCODE = 'QM026'; END IF;
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Send the changes as an object' USING ERRCODE = 'QM026'; END IF;
  v_desc := CASE WHEN p_data ? 'description' THEN btrim(coalesce(p_data ->> 'description', '')) ELSE x.description END;
  v_owner := CASE WHEN p_data ? 'ownerId' THEN nullif(p_data ->> 'ownerId', '')::uuid ELSE x.owner_user_id END;
  PERFORM app.assert_risk_action_fields(r.organisation_id, v_desc, v_owner, v_owner IS DISTINCT FROM x.owner_user_id);
  UPDATE public.risk_actions SET description = v_desc, owner_user_id = v_owner,
         due_date = CASE WHEN p_data ? 'dueDate' THEN nullif(p_data ->> 'dueDate', '')::date ELSE due_date END
   WHERE id = x.id;
END $$;

-- Done, with what was done. A manager, or the person the action was given to (who needs only to read risks).
CREATE FUNCTION app.complete_risk_action(p_action uuid, p_note text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE x public.risk_actions%ROWTYPE; r public.risks%ROWTYPE; v_note text := btrim(coalesce(p_note, ''));
BEGIN
  SELECT * INTO x FROM public.risk_actions WHERE id = p_action FOR UPDATE;
  IF NOT FOUND OR NOT app.has_permission(x.organisation_id, 'risk.read') THEN RAISE EXCEPTION 'Action not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO r FROM public.risks WHERE id = x.risk_id FOR UPDATE;
  IF NOT (app.has_permission(x.organisation_id, 'risk.manage') OR x.owner_user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Only the person it was given to, or someone who manages risks, can close this action' USING ERRCODE = '42501';
  END IF;
  IF r.status IN ('closed', 'retired') THEN RAISE EXCEPTION '% is % and cannot be changed', r.reference, r.status USING ERRCODE = 'QM026'; END IF;
  IF x.status <> 'open' THEN RAISE EXCEPTION 'This action is already %', x.status USING ERRCODE = 'QM026'; END IF;
  IF length(v_note) < 1 THEN RAISE EXCEPTION 'Say what was done' USING ERRCODE = 'QM026'; END IF;
  UPDATE public.risk_actions SET status = 'done', done_note = left(v_note, 2000), done_at = now(), done_by = auth.uid() WHERE id = x.id;
  PERFORM app.risk_recompute_status(r.id);
END $$;

CREATE FUNCTION app.cancel_risk_action(p_action uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE x public.risk_actions%ROWTYPE; r public.risks%ROWTYPE; v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  SELECT * INTO x FROM public.risk_actions WHERE id = p_action FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(x.organisation_id) THEN RAISE EXCEPTION 'Action not found' USING ERRCODE = 'P0002'; END IF;
  r := app.risk_for_change(x.risk_id, 'changed');
  IF x.status <> 'open' THEN RAISE EXCEPTION 'This action is already %', x.status USING ERRCODE = 'QM026'; END IF;
  IF length(v_reason) < 3 THEN RAISE EXCEPTION 'Say why the action is cancelled (at least 3 characters)' USING ERRCODE = 'QM026'; END IF;
  UPDATE public.risk_actions SET status = 'cancelled', cancel_reason = left(v_reason, 500), cancelled_at = now(), cancelled_by = auth.uid() WHERE id = x.id;
  PERFORM app.risk_recompute_status(r.id);
END $$;

CREATE FUNCTION app.reopen_risk_action(p_action uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE x public.risk_actions%ROWTYPE; r public.risks%ROWTYPE;
BEGIN
  SELECT * INTO x FROM public.risk_actions WHERE id = p_action FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(x.organisation_id) THEN RAISE EXCEPTION 'Action not found' USING ERRCODE = 'P0002'; END IF;
  r := app.risk_for_change(x.risk_id, 'changed');
  IF x.status = 'open' THEN RAISE EXCEPTION 'This action is already open' USING ERRCODE = 'QM026'; END IF;
  UPDATE public.risk_actions SET status = 'open', done_note = NULL, done_at = NULL, done_by = NULL, cancel_reason = NULL, cancelled_at = NULL, cancelled_by = NULL WHERE id = x.id;
  PERFORM app.risk_recompute_status(r.id);
END $$;

-- ---------------------------------------------------------------------------
-- Acceptance of a risk above the acceptable level
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.propose_risk_acceptance(p_risk uuid, p_rationale text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.risks%ROWTYPE; s jsonb; v_id uuid; v_rationale text := btrim(coalesce(p_rationale, ''));
BEGIN
  r := app.risk_for_change(p_risk, 'accepted');
  IF r.kind <> 'risk' THEN RAISE EXCEPTION 'An opportunity needs no acceptance' USING ERRCODE = 'QM026'; END IF;
  IF r.strategy IS NULL THEN RAISE EXCEPTION 'Choose what will be done about % first', r.reference USING ERRCODE = 'QM026'; END IF;
  IF r.strategy <> 'accept' AND NOT EXISTS (SELECT 1 FROM public.risk_assessments a WHERE a.risk_id = r.id AND a.phase = 'residual' AND a.status = 'current') THEN
    RAISE EXCEPTION 'Assess what is left after treatment first: that is what would be accepted' USING ERRCODE = 'QM026';
  END IF;
  s := app.risk_acceptance_state(r.id);
  IF NOT (s ->> 'above')::boolean THEN RAISE EXCEPTION '% is % , within the level the organisation accepts: it needs no acceptance', r.reference, s ->> 'band' USING ERRCODE = 'QM026'; END IF;
  IF (s ->> 'accepted')::boolean THEN RAISE EXCEPTION '% has already been accepted as it stands', r.reference USING ERRCODE = 'QM026'; END IF;
  IF (s ->> 'waiting')::boolean THEN RAISE EXCEPTION 'An acceptance of % is already waiting for an approver', r.reference USING ERRCODE = 'QM026'; END IF;
  IF length(v_rationale) < 10 THEN RAISE EXCEPTION 'Say why it should be accepted as it is (at least 10 characters)' USING ERRCODE = 'QM026'; END IF;
  INSERT INTO public.risk_acceptances (organisation_id, risk_id, assessment_id, band, rationale, proposed_by)
  VALUES (r.organisation_id, r.id, (s ->> 'assessmentId')::uuid, s ->> 'band', left(v_rationale, 2000), auth.uid()) RETURNING id INTO v_id;
  PERFORM app.risk_recompute_status(r.id);
  RETURN v_id;
END $$;

-- risk.approve, never the person who proposed it.
CREATE FUNCTION app.decide_risk_acceptance(p_acceptance uuid, p_approve boolean, p_note text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE x public.risk_acceptances%ROWTYPE; r public.risks%ROWTYPE; v_note text := btrim(coalesce(p_note, ''));
BEGIN
  SELECT * INTO x FROM public.risk_acceptances WHERE id = p_acceptance FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(x.organisation_id) THEN RAISE EXCEPTION 'Acceptance not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(x.organisation_id, 'risk.approve') THEN RAISE EXCEPTION 'You are not allowed to accept risks' USING ERRCODE = '42501'; END IF;
  SELECT * INTO r FROM public.risks WHERE id = x.risk_id FOR UPDATE;
  IF x.status <> 'proposed' THEN RAISE EXCEPTION 'This acceptance has already been %', x.status USING ERRCODE = 'QM026'; END IF;
  IF x.proposed_by = auth.uid() THEN RAISE EXCEPTION 'An acceptance is decided by someone other than the person who proposed it' USING ERRCODE = 'QM026'; END IF;
  IF p_approve IS NULL THEN RAISE EXCEPTION 'Approve or reject it' USING ERRCODE = 'QM026'; END IF;
  IF length(v_note) < 3 THEN RAISE EXCEPTION 'Add a note to the decision (at least 3 characters)' USING ERRCODE = 'QM026'; END IF;
  IF p_approve AND x.assessment_id IS DISTINCT FROM app.risk_effective_assessment(r.id) THEN
    RAISE EXCEPTION 'The risk has been assessed again since this was proposed' USING ERRCODE = 'QM026';
  END IF;
  UPDATE public.risk_acceptances SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END, decided_at = now(), decided_by = auth.uid(), decision_note = left(v_note, 1000)
   WHERE id = x.id;
  PERFORM app.risk_recompute_status(r.id);
END $$;

-- By the person who proposed it, or an approver.
CREATE FUNCTION app.withdraw_risk_acceptance(p_acceptance uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE x public.risk_acceptances%ROWTYPE; v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  SELECT * INTO x FROM public.risk_acceptances WHERE id = p_acceptance FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(x.organisation_id) THEN RAISE EXCEPTION 'Acceptance not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT (app.has_permission(x.organisation_id, 'risk.approve') OR (x.proposed_by = auth.uid() AND app.has_permission(x.organisation_id, 'risk.manage'))) THEN
    RAISE EXCEPTION 'Only the person who proposed it, or an approver, can withdraw it' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.risks WHERE id = x.risk_id FOR UPDATE;
  IF x.status <> 'proposed' THEN RAISE EXCEPTION 'This acceptance has already been %', x.status USING ERRCODE = 'QM026'; END IF;
  IF length(v_reason) < 3 THEN RAISE EXCEPTION 'Say why it is withdrawn (at least 3 characters)' USING ERRCODE = 'QM026'; END IF;
  UPDATE public.risk_acceptances SET status = 'withdrawn', decided_at = now(), decided_by = auth.uid(), decision_note = left(v_reason, 1000) WHERE id = x.id;
  PERFORM app.risk_recompute_status(x.risk_id);
END $$;

-- ---------------------------------------------------------------------------
-- Reviewing, closing, reopening
-- ---------------------------------------------------------------------------
-- "Looked at it; nothing has changed": a note, and the next date (default: today + the months of its band).
CREATE FUNCTION app.record_risk_review(p_risk uuid, p_note text, p_next_review_on date DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.risks%ROWTYPE; v_note text := btrim(coalesce(p_note, '')); v_band text; v_next date; v_id uuid;
BEGIN
  r := app.risk_for_change(p_risk, 'reviewed');
  IF r.status = 'draft' THEN RAISE EXCEPTION 'Assess % first', r.reference USING ERRCODE = 'QM026'; END IF;
  IF length(v_note) < 3 THEN RAISE EXCEPTION 'Say what you looked at and found (at least 3 characters)' USING ERRCODE = 'QM026'; END IF;
  IF p_next_review_on IS NOT NULL AND (p_next_review_on <= current_date OR p_next_review_on > current_date + 1830) THEN
    RAISE EXCEPTION 'The next review is after today and within five years' USING ERRCODE = 'QM026';
  END IF;
  SELECT a.band INTO v_band FROM public.risk_assessments a WHERE a.id = app.risk_effective_assessment(r.id);
  v_next := coalesce(p_next_review_on, app.risk_review_date(r.organisation_id, v_band, current_date));
  INSERT INTO public.risk_reviews (organisation_id, risk_id, outcome, note, was_due_on, next_review_on)
  VALUES (r.organisation_id, r.id, 'no_change', left(v_note, 2000), r.next_review_on, v_next) RETURNING id INTO v_id;
  UPDATE public.risks SET next_review_on = v_next WHERE id = r.id;
  RETURN v_id;
END $$;

-- treated: nothing is left to do (the status is monitoring). accepted: within the acceptable level, or accepted by an approver.
-- no_longer_applies: whatever state it is in. Actions still open are cancelled with the reason.
CREATE FUNCTION app.close_risk(p_risk uuid, p_outcome text, p_note text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.risks%ROWTYPE; v_note text := btrim(coalesce(p_note, '')); s jsonb; v_problems text[];
BEGIN
  r := app.risk_for_change(p_risk, 'closed');
  IF r.status = 'draft' THEN RAISE EXCEPTION '% has not been assessed: retire it instead', r.reference USING ERRCODE = 'QM026'; END IF;
  IF p_outcome IS NULL OR p_outcome NOT IN ('treated', 'accepted', 'no_longer_applies') THEN
    RAISE EXCEPTION 'A risk is closed as treated, accepted or no longer applies' USING ERRCODE = 'QM026';
  END IF;
  IF length(v_note) < 3 THEN RAISE EXCEPTION 'Add a closing note (at least 3 characters)' USING ERRCODE = 'QM026'; END IF;
  IF p_outcome = 'treated' THEN
    v_problems := app.risk_treatment_problems(r.id);
    IF cardinality(v_problems) > 0 THEN RAISE EXCEPTION 'Before % can be closed as treated: %', r.reference, array_to_string(v_problems, '; ') USING ERRCODE = 'QM026'; END IF;
    IF r.strategy = 'accept' THEN RAISE EXCEPTION '% was accepted, not treated: close it as accepted', r.reference USING ERRCODE = 'QM026'; END IF;
  ELSIF p_outcome = 'accepted' THEN
    s := app.risk_acceptance_state(r.id);
    IF (s ->> 'above')::boolean AND NOT (s ->> 'accepted')::boolean THEN
      RAISE EXCEPTION '% is %, above the level the organisation accepts: an approver must accept it first', r.reference, s ->> 'band' USING ERRCODE = 'QM026';
    END IF;
  END IF;
  UPDATE public.risk_actions SET status = 'cancelled', cancel_reason = 'The risk was closed', cancelled_at = now(), cancelled_by = auth.uid()
   WHERE risk_id = r.id AND status = 'open';
  UPDATE public.risk_acceptances SET status = 'withdrawn', decided_at = now(), decided_by = auth.uid(), decision_note = 'The risk was closed' WHERE risk_id = r.id AND status = 'proposed';
  UPDATE public.risks SET status = 'closed', outcome = p_outcome, close_note = left(v_note, 2000), closed_at = now(), closed_by = auth.uid(), next_review_on = NULL, reopen_reason = NULL
   WHERE id = r.id;
END $$;

CREATE FUNCTION app.reopen_risk(p_risk uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.risks%ROWTYPE; v_reason text := btrim(coalesce(p_reason, '')); v_band text;
BEGIN
  SELECT * INTO r FROM public.risks WHERE id = p_risk FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(r.organisation_id) THEN RAISE EXCEPTION 'Risk not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_risk_manager(r.organisation_id);
  IF r.status <> 'closed' THEN RAISE EXCEPTION '% is not closed', r.reference USING ERRCODE = 'QM026'; END IF;
  IF length(v_reason) < 3 THEN RAISE EXCEPTION 'Say why it is reopened (at least 3 characters)' USING ERRCODE = 'QM026'; END IF;
  SELECT a.band INTO v_band FROM public.risk_assessments a WHERE a.id = app.risk_effective_assessment(r.id);
  -- Due for a look straight away: it came back for a reason.
  UPDATE public.risks SET status = 'open', outcome = NULL, close_note = NULL, closed_at = NULL, closed_by = NULL, reopen_reason = left(v_reason, 500), next_review_on = current_date
   WHERE id = r.id;
  PERFORM app.risk_recompute_status(r.id);
END $$;

-- Retiring ends the review dates; bringing back works the status out again (replaces RK1's).
CREATE OR REPLACE FUNCTION app.retire_risk(p_risk uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.risks%ROWTYPE; v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  SELECT * INTO r FROM public.risks WHERE id = p_risk FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(r.organisation_id) THEN RAISE EXCEPTION 'Risk not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_risk_manager(r.organisation_id);
  IF r.status = 'retired' THEN RAISE EXCEPTION '% is already retired', r.reference USING ERRCODE = 'QM026'; END IF;
  IF length(v_reason) < 3 THEN RAISE EXCEPTION 'Say why it is retired (at least 3 characters)' USING ERRCODE = 'QM026'; END IF;
  IF EXISTS (SELECT 1 FROM public.risk_actions x WHERE x.risk_id = r.id AND x.status = 'open') THEN
    RAISE EXCEPTION '% still has open actions: finish or cancel them first', r.reference USING ERRCODE = 'QM026';
  END IF;
  UPDATE public.risk_acceptances SET status = 'withdrawn', decided_at = now(), decided_by = auth.uid(), decision_note = 'The risk was retired' WHERE risk_id = r.id AND status = 'proposed';
  UPDATE public.risks SET status = 'retired', retired_reason = left(v_reason, 500), retired_at = now(), retired_by = auth.uid(), next_review_on = NULL WHERE id = r.id;
END $$;

CREATE OR REPLACE FUNCTION app.reactivate_risk(p_risk uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.risks%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.risks WHERE id = p_risk FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(r.organisation_id) THEN RAISE EXCEPTION 'Risk not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_risk_manager(r.organisation_id);
  IF r.status <> 'retired' THEN RAISE EXCEPTION '% is not retired', r.reference USING ERRCODE = 'QM026'; END IF;
  UPDATE public.risks SET
    status = CASE WHEN r.outcome IS NOT NULL THEN 'closed' ELSE 'draft' END,
    retired_reason = NULL, retired_at = NULL, retired_by = NULL,
    next_review_on = CASE WHEN r.outcome IS NULL AND app.risk_effective_assessment(r.id) IS NOT NULL THEN current_date END
  WHERE id = r.id;
  PERFORM app.risk_recompute_status(r.id);
END $$;

REVOKE ALL ON FUNCTION app.risk_review_frozen(), app.risk_acceptance_frozen(), app.risk_action_rules(), app.risk_band_rank(text), app.risk_effective_assessment(uuid),
  app.risk_recompute_status(uuid), app.risk_for_change(uuid, text), app.risk_review_date(uuid, text, date),
  app.assert_risk_action_fields(uuid, text, uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.risk_treatment_problems(uuid), app.risk_acceptance_state(uuid), app.assess_risk(uuid, integer, integer, text, text), app.set_risk_treatment(uuid, text, text),
  app.add_risk_action(uuid, jsonb), app.update_risk_action(uuid, jsonb), app.complete_risk_action(uuid, text), app.cancel_risk_action(uuid, text), app.reopen_risk_action(uuid),
  app.propose_risk_acceptance(uuid, text), app.decide_risk_acceptance(uuid, boolean, text), app.withdraw_risk_acceptance(uuid, text),
  app.record_risk_review(uuid, text, date), app.close_risk(uuid, text, text), app.reopen_risk(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.risk_treatment_problems(uuid), app.risk_acceptance_state(uuid), app.assess_risk(uuid, integer, integer, text, text), app.set_risk_treatment(uuid, text, text),
  app.add_risk_action(uuid, jsonb), app.update_risk_action(uuid, jsonb), app.complete_risk_action(uuid, text), app.cancel_risk_action(uuid, text), app.reopen_risk_action(uuid),
  app.propose_risk_acceptance(uuid, text), app.decide_risk_acceptance(uuid, boolean, text), app.withdraw_risk_acceptance(uuid, text),
  app.record_risk_review(uuid, text, date), app.close_risk(uuid, text, text), app.reopen_risk(uuid, text) TO authenticated;
