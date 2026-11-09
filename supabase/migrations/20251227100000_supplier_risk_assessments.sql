-- Supplier Quality SQ2b: risk assessments (docs/supplier-quality-plan.md).
--
--  * supplier_risk_models: the organisation's way of scoring risk, as VERSIONS (factors with weights, which factors escalate, the band thresholds, the review interval).
--    A new version is saved with a reason; old versions stay. Every organisation starts with a default model (seeded). Functions only: app.save_supplier_risk_model
--    (supplier_quality.configure).
--  * supplier_risk_assessments: append-only. Each one freezes the model version it used and every factor's score and note. The index, band and rating are WORKED OUT BY THE
--    DATABASE (app.score_supplier_risk) from the scores; a client never sends them. A rationale is required. Recording supersedes the previous current assessment and is the
--    ONLY thing that writes suppliers.risk_rating. Function: app.record_supplier_risk_assessment (supplier_quality.manage). Nothing is deleted.
--  * Scoring: each factor is scored 1 (low) to 4 (critical). index = sum(weight x score) / sum(weight). Band: critical when index >= critical_from, high when >= high_from,
--    medium when >= medium_from, else low. A factor marked "escalates" scored 4 raises the rating to at least high (the rating is the higher of the band and that floor).

CREATE TABLE public.supplier_risk_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  factors jsonb NOT NULL,
  thresholds jsonb NOT NULL,
  review_interval_months integer NOT NULL CHECK (review_interval_months BETWEEN 1 AND 60),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT supplier_risk_models_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT supplier_risk_models_version_key UNIQUE (organisation_id, version)
);

CREATE TABLE public.supplier_risk_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  supplier_id uuid NOT NULL,
  model_id uuid NOT NULL,
  model_version integer NOT NULL,
  factors jsonb NOT NULL,
  risk_index numeric(4, 2) NOT NULL CHECK (risk_index BETWEEN 1 AND 4),
  band text NOT NULL CHECK (band IN ('low', 'medium', 'high', 'critical')),
  rating text NOT NULL CHECK (rating IN ('low', 'medium', 'high', 'critical')),
  escalated_by jsonb NOT NULL DEFAULT '[]'::jsonb,
  rationale text NOT NULL CHECK (length(btrim(rationale)) BETWEEN 3 AND 2000),
  previous_rating text CHECK (previous_rating IS NULL OR previous_rating IN ('low', 'medium', 'high', 'critical')),
  review_on date NOT NULL,
  status text NOT NULL DEFAULT 'current' CHECK (status IN ('current', 'superseded')),
  assessed_at timestamptz NOT NULL DEFAULT now(),
  assessed_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT supplier_risk_assessments_supplier_fkey FOREIGN KEY (supplier_id, organisation_id) REFERENCES public.suppliers (id, organisation_id),
  CONSTRAINT supplier_risk_assessments_model_fkey FOREIGN KEY (model_id, organisation_id) REFERENCES public.supplier_risk_models (id, organisation_id)
);
CREATE UNIQUE INDEX supplier_risk_assessments_one_current ON public.supplier_risk_assessments (supplier_id) WHERE status = 'current';
CREATE INDEX supplier_risk_assessments_supplier_idx ON public.supplier_risk_assessments (supplier_id, assessed_at DESC);
CREATE INDEX supplier_risk_assessments_review_idx ON public.supplier_risk_assessments (organisation_id, review_on) WHERE status = 'current';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['supplier_risk_models', 'supplier_risk_assessments'] LOOP
    EXECUTE format('CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION audit.record_change(%L)', t, 'organisation_id');
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format($p$CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (app.has_permission(organisation_id, 'supplier_quality.read'))$p$, t || '_select', t);
  END LOOP;
END $$;
CREATE TRIGGER supplier_risk_assessments_stamp BEFORE INSERT ON public.supplier_risk_assessments FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER supplier_risk_assessments_touch BEFORE UPDATE ON public.supplier_risk_assessments FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER supplier_risk_assessments_org_immutable BEFORE UPDATE ON public.supplier_risk_assessments FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();

-- ---------------------------------------------------------------------------
-- What a valid model is
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.supplier_risk_model_problem(p_factors jsonb, p_thresholds jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE f jsonb; v_keys text[] := ARRAY[]::text[]; m numeric; h numeric; c numeric;
BEGIN
  IF jsonb_typeof(p_factors) <> 'array' OR jsonb_array_length(p_factors) NOT BETWEEN 1 AND 20 THEN RETURN 'A risk model needs between 1 and 20 factors'; END IF;
  FOR f IN SELECT x FROM jsonb_array_elements(p_factors) x LOOP
    IF jsonb_typeof(f) <> 'object' THEN RETURN 'Every factor must be an object'; END IF;
    IF coalesce(f ->> 'key', '') !~ '^[a-z0-9_]{2,40}$' THEN RETURN 'A factor key is 2 to 40 lower-case letters, digits or underscores'; END IF;
    IF (f ->> 'key') = ANY (v_keys) THEN RETURN 'Factor keys must be unique'; END IF;
    v_keys := v_keys || (f ->> 'key');
    IF length(btrim(coalesce(f ->> 'label', ''))) NOT BETWEEN 1 AND 80 THEN RETURN 'Every factor needs a label (up to 80 characters)'; END IF;
    IF length(coalesce(f ->> 'description', '')) > 500 THEN RETURN 'A factor description is up to 500 characters'; END IF;
    IF coalesce(f ->> 'weight', '') !~ '^[0-9]+$' OR (f ->> 'weight')::int NOT BETWEEN 1 AND 10 THEN RETURN 'A factor weight is a whole number from 1 to 10'; END IF;
    IF jsonb_typeof(f -> 'escalates') IS DISTINCT FROM 'boolean' THEN RETURN 'Every factor says whether it escalates (true or false)'; END IF;
  END LOOP;
  IF jsonb_typeof(p_thresholds) <> 'object' OR coalesce(p_thresholds ->> 'medium_from', '') !~ '^[0-9.]+$' OR coalesce(p_thresholds ->> 'high_from', '') !~ '^[0-9.]+$'
     OR coalesce(p_thresholds ->> 'critical_from', '') !~ '^[0-9.]+$' THEN RETURN 'The band thresholds are medium_from, high_from and critical_from (numbers)'; END IF;
  m := (p_thresholds ->> 'medium_from')::numeric; h := (p_thresholds ->> 'high_from')::numeric; c := (p_thresholds ->> 'critical_from')::numeric;
  IF NOT (m > 1 AND m < h AND h < c AND c <= 4) THEN RETURN 'The thresholds must rise: above 1, medium below high below critical, and no more than 4'; END IF;
  RETURN NULL;
END $$;

ALTER TABLE public.supplier_risk_models ADD CONSTRAINT supplier_risk_models_valid CHECK (app.supplier_risk_model_problem(factors, thresholds) IS NULL);

-- The default model every organisation starts with.
CREATE FUNCTION app.seed_supplier_risk_model(p_organisation_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO public.supplier_risk_models (organisation_id, version, factors, thresholds, review_interval_months, reason)
  SELECT p_organisation_id, 1,
    jsonb_build_array(
      jsonb_build_object('key', 'product_criticality', 'label', 'Criticality of what they supply', 'description', 'Safety, fit, form or function impact if it is wrong', 'weight', 5, 'escalates', true),
      jsonb_build_object('key', 'quality_system', 'label', 'Quality system maturity', 'description', 'Certification, controls and track record', 'weight', 4, 'escalates', false),
      jsonb_build_object('key', 'special_processes', 'label', 'Special processes and complexity', 'description', 'Processes that cannot be fully verified by inspection', 'weight', 3, 'escalates', false),
      jsonb_build_object('key', 'supply_dependence', 'label', 'Dependence and single source', 'description', 'How hard it would be to replace them or cover a failure', 'weight', 3, 'escalates', false),
      jsonb_build_object('key', 'regulatory_customer', 'label', 'Regulatory and customer requirements', 'description', 'Requirements flowed down that they must meet', 'weight', 3, 'escalates', true),
      jsonb_build_object('key', 'financial_stability', 'label', 'Financial and operational stability', 'description', 'Risk of failure, capacity or continuity problems', 'weight', 2, 'escalates', false)),
    jsonb_build_object('medium_from', 1.75, 'high_from', 2.5, 'critical_from', 3.25), 12, 'Default model'
  WHERE NOT EXISTS (SELECT 1 FROM public.supplier_risk_models WHERE organisation_id = p_organisation_id)
$$;
CREATE FUNCTION app.seed_supplier_risk_model_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.seed_supplier_risk_model(NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER organisations_seed_supplier_risk_model AFTER INSERT ON public.organisations FOR EACH ROW EXECUTE FUNCTION app.seed_supplier_risk_model_trg();
SELECT app.seed_supplier_risk_model(o.id) FROM public.organisations o;

-- A new version of the model (configure). Old versions and the assessments that used them are untouched.
CREATE FUNCTION app.save_supplier_risk_model(p_organisation uuid, p_factors jsonb, p_thresholds jsonb, p_interval integer, p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_problem text; v_version integer; v_id uuid;
BEGIN
  IF NOT app.is_member(p_organisation) THEN RAISE EXCEPTION 'Organisation not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(p_organisation, 'supplier_quality.configure') THEN
    RAISE EXCEPTION 'You are not allowed to configure supplier risk scoring' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('supplier_risk_model:' || p_organisation::text, 0));
  v_problem := app.supplier_risk_model_problem(p_factors, p_thresholds);
  IF v_problem IS NOT NULL THEN RAISE EXCEPTION '%', v_problem USING ERRCODE = 'QM020'; END IF;
  IF p_interval IS NULL OR p_interval NOT BETWEEN 1 AND 60 THEN RAISE EXCEPTION 'The review interval is 1 to 60 months' USING ERRCODE = 'QM020'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 3 OR length(btrim(p_reason)) > 1000 THEN RAISE EXCEPTION 'Say why the model is changing (3 to 1000 characters)' USING ERRCODE = 'QM020'; END IF;
  IF EXISTS (SELECT 1 FROM public.supplier_risk_models m WHERE m.organisation_id = p_organisation AND m.factors = p_factors AND m.thresholds = p_thresholds AND m.review_interval_months = p_interval
              AND m.version = (SELECT max(version) FROM public.supplier_risk_models WHERE organisation_id = p_organisation)) THEN
    RAISE EXCEPTION 'Nothing has changed from the current model' USING ERRCODE = 'QM020';
  END IF;
  SELECT coalesce(max(version), 0) + 1 INTO v_version FROM public.supplier_risk_models WHERE organisation_id = p_organisation;
  INSERT INTO public.supplier_risk_models (organisation_id, version, factors, thresholds, review_interval_months, reason)
  VALUES (p_organisation, v_version, p_factors, p_thresholds, p_interval, btrim(p_reason)) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------
-- Scoring: the one definition. p_scores = [{"key": text, "score": 1..4, "note": text?}], one entry for every factor of the model.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.score_supplier_risk(p_model uuid, p_scores jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  m public.supplier_risk_models%ROWTYPE; f jsonb; s jsonb; v_rows jsonb := '[]'::jsonb; v_sum numeric := 0; v_weights numeric := 0; v_index numeric; v_band text; v_rating text;
  v_escalated jsonb := '[]'::jsonb; v_score integer; v_seen text[] := ARRAY[]::text[]; v_rank text[] := ARRAY['low', 'medium', 'high', 'critical'];
BEGIN
  SELECT * INTO m FROM public.supplier_risk_models WHERE id = p_model;
  IF NOT FOUND OR NOT app.is_member(m.organisation_id) OR NOT app.has_permission(m.organisation_id, 'supplier_quality.read') THEN
    RAISE EXCEPTION 'Risk model not found' USING ERRCODE = 'P0002';
  END IF;
  IF jsonb_typeof(p_scores) <> 'array' THEN RAISE EXCEPTION 'Scores must be a list' USING ERRCODE = 'QM020'; END IF;
  FOR s IN SELECT x FROM jsonb_array_elements(p_scores) x LOOP
    IF jsonb_typeof(s) <> 'object' OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(m.factors) mf WHERE mf ->> 'key' = s ->> 'key') THEN
      RAISE EXCEPTION 'A score names a factor that is not in this model' USING ERRCODE = 'QM020';
    END IF;
    IF (s ->> 'key') = ANY (v_seen) THEN RAISE EXCEPTION 'A factor is scored twice' USING ERRCODE = 'QM020'; END IF;
    v_seen := v_seen || (s ->> 'key');
  END LOOP;
  FOR f IN SELECT x FROM jsonb_array_elements(m.factors) x LOOP
    SELECT x INTO s FROM jsonb_array_elements(p_scores) x WHERE x ->> 'key' = f ->> 'key';
    IF s IS NULL THEN RAISE EXCEPTION 'Score every factor: "%" has no score', f ->> 'label' USING ERRCODE = 'QM020'; END IF;
    IF coalesce(s ->> 'score', '') !~ '^[1-4]$' THEN RAISE EXCEPTION 'A score is a whole number from 1 (low) to 4 (critical)' USING ERRCODE = 'QM020'; END IF;
    IF length(coalesce(s ->> 'note', '')) > 1000 THEN RAISE EXCEPTION 'A factor note is up to 1000 characters' USING ERRCODE = 'QM020'; END IF;
    v_score := (s ->> 'score')::int;
    v_sum := v_sum + (f ->> 'weight')::numeric * v_score;
    v_weights := v_weights + (f ->> 'weight')::numeric;
    IF (f ->> 'escalates')::boolean AND v_score = 4 THEN v_escalated := v_escalated || to_jsonb(f ->> 'label'); END IF;
    v_rows := v_rows || jsonb_build_object('key', f ->> 'key', 'label', f ->> 'label', 'weight', (f ->> 'weight')::int, 'escalates', (f ->> 'escalates')::boolean,
                                           'score', v_score, 'note', nullif(btrim(coalesce(s ->> 'note', '')), ''));
  END LOOP;
  v_index := round(v_sum / v_weights, 2);
  v_band := CASE WHEN v_index >= (m.thresholds ->> 'critical_from')::numeric THEN 'critical' WHEN v_index >= (m.thresholds ->> 'high_from')::numeric THEN 'high'
                 WHEN v_index >= (m.thresholds ->> 'medium_from')::numeric THEN 'medium' ELSE 'low' END;
  v_rating := v_band;
  IF jsonb_array_length(v_escalated) > 0 AND array_position(v_rank, v_band) < array_position(v_rank, 'high') THEN v_rating := 'high'; END IF;
  RETURN jsonb_build_object('modelId', m.id, 'modelVersion', m.version, 'index', v_index, 'band', v_band, 'rating', v_rating, 'escalatedBy', v_escalated, 'factors', v_rows);
END $$;

-- ---------------------------------------------------------------------------
-- Recording an assessment: the only writer of suppliers.risk_rating
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.record_supplier_risk_assessment(p_supplier uuid, p_scores jsonb, p_rationale text, p_review_on date DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.suppliers%ROWTYPE; m public.supplier_risk_models%ROWTYPE; r jsonb; v_review date; v_id uuid;
BEGIN
  s := app.supplier_for_write(p_supplier, 'supplier_quality.manage');
  SELECT * INTO m FROM public.supplier_risk_models WHERE organisation_id = s.organisation_id ORDER BY version DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'This organisation has no risk model' USING ERRCODE = 'QM020'; END IF;
  IF p_rationale IS NULL OR length(btrim(p_rationale)) < 3 OR length(btrim(p_rationale)) > 2000 THEN
    RAISE EXCEPTION 'Give the rationale for this rating (3 to 2000 characters)' USING ERRCODE = 'QM020';
  END IF;
  r := app.score_supplier_risk(m.id, p_scores);
  v_review := coalesce(p_review_on, (current_date + make_interval(months => m.review_interval_months))::date);
  IF v_review <= current_date THEN RAISE EXCEPTION 'The next review must be after today' USING ERRCODE = 'QM020'; END IF;
  UPDATE public.supplier_risk_assessments SET status = 'superseded' WHERE supplier_id = s.id AND status = 'current';
  INSERT INTO public.supplier_risk_assessments (organisation_id, supplier_id, model_id, model_version, factors, risk_index, band, rating, escalated_by, rationale, previous_rating, review_on)
  VALUES (s.organisation_id, s.id, m.id, m.version, r -> 'factors', (r ->> 'index')::numeric, r ->> 'band', r ->> 'rating', r -> 'escalatedBy', btrim(p_rationale), s.risk_rating, v_review)
  RETURNING id INTO v_id;
  UPDATE public.suppliers SET risk_rating = r ->> 'rating' WHERE id = s.id;
  PERFORM app.emit_event(s.organisation_id, 'supplier.risk_assessed', 'supplier', s.id,
    jsonb_build_object('code', s.code, 'from', s.risk_rating, 'to', r ->> 'rating', 'index', (r ->> 'index')::numeric, 'modelVersion', m.version));
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION app.supplier_risk_model_problem(jsonb, jsonb), app.seed_supplier_risk_model(uuid), app.seed_supplier_risk_model_trg(),
  app.save_supplier_risk_model(uuid, jsonb, jsonb, integer, text), app.score_supplier_risk(uuid, jsonb), app.record_supplier_risk_assessment(uuid, jsonb, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.save_supplier_risk_model(uuid, jsonb, jsonb, integer, text), app.score_supplier_risk(uuid, jsonb), app.record_supplier_risk_assessment(uuid, jsonb, text, date) TO authenticated;
