-- FMEA, slice FM2 (docs/fmea-plan.md): the organisation's rating model, as versions.
--
--  * fmea_models: the scales for severity, occurrence and detection (ten levels each, separately for design and for process FMEAs, a short label and the organisation's own
--    criteria text per level), the method that gives a priority (rpn: thresholds on S x O x D; ap: an action priority grid the organisation enters), the RPN thresholds, the
--    severity from which a cause always needs attention, and the default review interval in months. A default is seeded per organisation with NEUTRAL scales and RPN: the
--    AIAG-VDA action priority grid and the scale wording belong to their publisher and are not in the product (docs/fmea-plan.md section 10 Q1); an organisation that holds a
--    licence enters its own. Versions are frozen (only current -> not current), never deleted; a new version is made only by app.save_fmea_model (fmea.approve; a reason from
--    version 2; unchanged refused).
--  * app.fmea_model_problem(config): the one definition of a valid model. An action priority grid must cover every one of the 1,000 combinations of S, O and D exactly once.
--  * app.fmea_score(config, kind, s, o, d) (internal) and app.score_fmea(model, kind, s, o, d) (fmea.read): the database works the priority out, so a screen and a record cannot
--    disagree. A cause needs attention when its priority is high, or its severity reaches the floor whatever the method says.
--  * The default review interval of an FMEA (FM1 used 12 months) now follows the model.
-- Errors QM036 (409 fmea_rule); another organisation's id is P0002 (404).

-- ---------------------------------------------------------------------------
-- 1. What a valid model is
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.fmea_is_int(p_value jsonb, p_min integer, p_max integer) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT jsonb_typeof(p_value) = 'number' AND (p_value #>> '{}')::numeric = trunc((p_value #>> '{}')::numeric)
     AND (p_value #>> '{}')::numeric BETWEEN p_min AND p_max
$$;

-- Why a model is not valid, or NULL. Keys: method rpn | ap; rpnHighFrom, rpnMediumFrom (2-1000 and 1 below it); severityFloor 1-10; reviewMonths 1-120;
-- scales {design, process}, each {severity, occurrence, detection}: ten {label 1-40 characters, different within the scale; criteria up to 300};
-- apRules [{sFrom, sTo, oFrom, oTo, dFrom, dTo, priority high | medium | low}] (up to 300): empty, or covering every combination exactly once; the ap method needs them.
CREATE FUNCTION app.fmea_model_problem(p_data jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE kind text; dim text; e jsonb; v_labels text[]; v_rules jsonb; v_bad integer; k text;
BEGIN
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RETURN 'Send the model as an object'; END IF;
  IF coalesce(p_data ->> 'method', '') NOT IN ('rpn', 'ap') THEN RETURN 'The method is rpn or ap'; END IF;
  IF NOT app.fmea_is_int(p_data -> 'rpnHighFrom', 2, 1000) THEN RETURN 'High priority starts at an RPN of 2 to 1,000'; END IF;
  IF NOT app.fmea_is_int(p_data -> 'rpnMediumFrom', 1, 999) OR (p_data ->> 'rpnMediumFrom')::integer >= (p_data ->> 'rpnHighFrom')::integer THEN
    RETURN 'Medium priority starts at a lower RPN than high';
  END IF;
  IF NOT app.fmea_is_int(p_data -> 'severityFloor', 1, 10) THEN RETURN 'The severity that always needs attention is 1 to 10'; END IF;
  IF NOT app.fmea_is_int(p_data -> 'reviewMonths', 1, 120) THEN RETURN 'The review interval is 1 to 120 whole months'; END IF;

  IF jsonb_typeof(p_data -> 'scales') IS DISTINCT FROM 'object' THEN RETURN 'Give the rating scales'; END IF;
  FOREACH kind IN ARRAY ARRAY['design', 'process'] LOOP
    IF jsonb_typeof(p_data -> 'scales' -> kind) IS DISTINCT FROM 'object' THEN RETURN 'Give the scales for ' || kind || ' FMEAs'; END IF;
    FOREACH dim IN ARRAY ARRAY['severity', 'occurrence', 'detection'] LOOP
      IF jsonb_typeof(p_data -> 'scales' -> kind -> dim) IS DISTINCT FROM 'array' OR jsonb_array_length(p_data -> 'scales' -> kind -> dim) <> 10 THEN
        RETURN 'Give ten levels of ' || dim || ' for ' || kind || ' FMEAs';
      END IF;
      v_labels := ARRAY[]::text[];
      FOR e IN SELECT x FROM jsonb_array_elements(p_data -> 'scales' -> kind -> dim) x LOOP
        IF jsonb_typeof(e) IS DISTINCT FROM 'object' OR length(btrim(coalesce(e ->> 'label', ''))) NOT BETWEEN 1 AND 40 THEN
          RETURN 'Each level of ' || dim || ' (' || kind || ') needs a label of 1 to 40 characters';
        END IF;
        IF length(coalesce(e ->> 'criteria', '')) > 300 THEN RETURN 'A level''s criteria are up to 300 characters'; END IF;
        IF lower(btrim(e ->> 'label')) = ANY (v_labels) THEN RETURN 'The levels of ' || dim || ' (' || kind || ') need different labels'; END IF;
        v_labels := v_labels || lower(btrim(e ->> 'label'));
      END LOOP;
    END LOOP;
  END LOOP;

  v_rules := coalesce(p_data -> 'apRules', '[]'::jsonb);
  IF jsonb_typeof(v_rules) IS DISTINCT FROM 'array' OR jsonb_array_length(v_rules) > 300 THEN RETURN 'The action priority grid is a list of up to 300 ranges'; END IF;
  IF p_data ->> 'method' = 'ap' AND jsonb_array_length(v_rules) = 0 THEN RETURN 'The action priority method needs an action priority grid'; END IF;
  IF jsonb_array_length(v_rules) > 0 THEN
    FOR e IN SELECT x FROM jsonb_array_elements(v_rules) x LOOP
      IF jsonb_typeof(e) IS DISTINCT FROM 'object' THEN RETURN 'Each range of the action priority grid is an object'; END IF;
      FOREACH k IN ARRAY ARRAY['sFrom', 'sTo', 'oFrom', 'oTo', 'dFrom', 'dTo'] LOOP
        IF NOT app.fmea_is_int(e -> k, 1, 10) THEN RETURN 'Each range of the action priority grid is from 1 to 10 (' || k || ')'; END IF;
      END LOOP;
      IF (e ->> 'sFrom')::integer > (e ->> 'sTo')::integer OR (e ->> 'oFrom')::integer > (e ->> 'oTo')::integer OR (e ->> 'dFrom')::integer > (e ->> 'dTo')::integer THEN
        RETURN 'A range of the action priority grid runs from a lower to a higher level';
      END IF;
      IF coalesce(e ->> 'priority', '') NOT IN ('high', 'medium', 'low') THEN RETURN 'A priority is high, medium or low'; END IF;
    END LOOP;
    WITH rules AS (
      SELECT (r ->> 'sFrom')::integer AS sf, (r ->> 'sTo')::integer AS st, (r ->> 'oFrom')::integer AS ofr, (r ->> 'oTo')::integer AS ot,
             (r ->> 'dFrom')::integer AS df, (r ->> 'dTo')::integer AS dt
        FROM jsonb_array_elements(v_rules) r)
    SELECT count(*) INTO v_bad FROM (
      SELECT s.s, o.o, d.d, count(r.sf) AS n
        FROM generate_series(1, 10) s(s) CROSS JOIN generate_series(1, 10) o(o) CROSS JOIN generate_series(1, 10) d(d)
        LEFT JOIN rules r ON s.s BETWEEN r.sf AND r.st AND o.o BETWEEN r.ofr AND r.ot AND d.d BETWEEN r.df AND r.dt
       GROUP BY s.s, o.o, d.d) x
     WHERE x.n <> 1;
    IF v_bad > 0 THEN
      RETURN 'The action priority grid must cover every combination of severity, occurrence and detection exactly once (' || v_bad || ' of 1,000 are missing or covered twice)';
    END IF;
  END IF;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 2. The table
-- ---------------------------------------------------------------------------
CREATE TABLE public.fmea_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  config jsonb NOT NULL CHECK (app.fmea_model_problem(config) IS NULL),
  reason text CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 3 AND 1000),
  current boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT fmea_models_version_key UNIQUE (organisation_id, version),
  CONSTRAINT fmea_models_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT fmea_models_state_check CHECK (version = 1 OR reason IS NOT NULL)
);
CREATE UNIQUE INDEX fmea_models_current_key ON public.fmea_models (organisation_id) WHERE current;

CREATE FUNCTION app.fmea_model_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A version of the FMEA rating model is never deleted' USING ERRCODE = 'QM036'; END IF;
  IF (to_jsonb(NEW) - 'current' - 'updated_at' - 'updated_by') IS DISTINCT FROM (to_jsonb(OLD) - 'current' - 'updated_at' - 'updated_by')
     OR NOT (OLD.current AND NOT NEW.current) THEN
    RAISE EXCEPTION 'A version of the FMEA rating model cannot be changed. Save a new version.' USING ERRCODE = 'QM036';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fmea_models_frozen BEFORE UPDATE OR DELETE ON public.fmea_models FOR EACH ROW EXECUTE FUNCTION app.fmea_model_frozen();
CREATE TRIGGER fmea_models_stamp BEFORE INSERT ON public.fmea_models FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER fmea_models_touch BEFORE UPDATE ON public.fmea_models FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER fmea_models_org_immutable BEFORE UPDATE ON public.fmea_models FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.fmea_models FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.fmea_models ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fmea_models FROM anon, authenticated;
GRANT SELECT ON public.fmea_models TO authenticated;
CREATE POLICY fmea_models_select ON public.fmea_models FOR SELECT TO authenticated USING (app.has_permission(organisation_id, 'fmea.read'));

-- ---------------------------------------------------------------------------
-- 3. The default: neutral scales and RPN (no publisher's wording, no action priority grid)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.default_fmea_model() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  WITH s(dim, labels) AS (VALUES
    ('severity',   ARRAY['Negligible', 'Very slight', 'Slight', 'Minor', 'Moderate', 'Significant', 'Serious', 'Major', 'Severe', 'Critical']),
    ('occurrence', ARRAY['Very unlikely', 'Unlikely', 'Remote', 'Occasional', 'Moderate', 'Fairly frequent', 'Frequent', 'Very frequent', 'Almost constant', 'Constant']),
    ('detection',  ARRAY['Almost certain', 'Very high', 'High', 'Fairly high', 'Moderate', 'Fairly low', 'Low', 'Very low', 'Remote', 'Cannot detect'])),
  one AS (
    SELECT jsonb_object_agg(dim, (SELECT jsonb_agg(jsonb_build_object('label', l) ORDER BY o) FROM unnest(labels) WITH ORDINALITY u(l, o))) AS scale FROM s)
  SELECT jsonb_build_object(
    'method', 'rpn', 'rpnHighFrom', 200, 'rpnMediumFrom', 100, 'severityFloor', 9, 'reviewMonths', 12,
    'scales', jsonb_build_object('design', scale, 'process', scale), 'apRules', '[]'::jsonb)
  FROM one
$$;

CREATE FUNCTION app.seed_fmea_model(p_organisation_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO public.fmea_models (organisation_id, version, config)
  SELECT p_organisation_id, 1, app.default_fmea_model()
   WHERE NOT EXISTS (SELECT 1 FROM public.fmea_models WHERE organisation_id = p_organisation_id)
$$;

CREATE FUNCTION app.seed_fmea_model_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.seed_fmea_model(NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER organisations_seed_fmea_model AFTER INSERT ON public.organisations FOR EACH ROW EXECUTE FUNCTION app.seed_fmea_model_trg();
SELECT app.seed_fmea_model(o.id) FROM public.organisations o;

-- ---------------------------------------------------------------------------
-- 4. Scoring: the database works the priority out
-- ---------------------------------------------------------------------------
-- Internal: {severity, occurrence, detection (the levels), rpn, priority high | medium | low, method, needsAttention, severityLabel, occurrenceLabel, detectionLabel}.
-- Later slices call it from their own SECURITY DEFINER functions with the config of the model a revision was rated with.
CREATE FUNCTION app.fmea_score(p_config jsonb, p_kind text, p_severity integer, p_occurrence integer, p_detection integer) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v_rpn integer; v_priority text;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('design', 'process') THEN RAISE EXCEPTION 'An FMEA is a design or a process FMEA' USING ERRCODE = 'QM036'; END IF;
  IF p_severity IS NULL OR p_occurrence IS NULL OR p_detection IS NULL
     OR p_severity NOT BETWEEN 1 AND 10 OR p_occurrence NOT BETWEEN 1 AND 10 OR p_detection NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'Severity, occurrence and detection are each 1 to 10' USING ERRCODE = 'QM036';
  END IF;
  v_rpn := p_severity * p_occurrence * p_detection;
  IF p_config ->> 'method' = 'ap' THEN
    SELECT r ->> 'priority' INTO v_priority FROM jsonb_array_elements(p_config -> 'apRules') r
     WHERE p_severity BETWEEN (r ->> 'sFrom')::integer AND (r ->> 'sTo')::integer
       AND p_occurrence BETWEEN (r ->> 'oFrom')::integer AND (r ->> 'oTo')::integer
       AND p_detection BETWEEN (r ->> 'dFrom')::integer AND (r ->> 'dTo')::integer;
  ELSE
    v_priority := CASE WHEN v_rpn >= (p_config ->> 'rpnHighFrom')::integer THEN 'high' WHEN v_rpn >= (p_config ->> 'rpnMediumFrom')::integer THEN 'medium' ELSE 'low' END;
  END IF;
  RETURN jsonb_build_object(
    'severity', p_severity, 'occurrence', p_occurrence, 'detection', p_detection, 'rpn', v_rpn, 'priority', v_priority, 'method', p_config ->> 'method',
    'needsAttention', v_priority = 'high' OR p_severity >= (p_config ->> 'severityFloor')::integer,
    'severityLabel', p_config -> 'scales' -> p_kind -> 'severity' -> (p_severity - 1) ->> 'label',
    'occurrenceLabel', p_config -> 'scales' -> p_kind -> 'occurrence' -> (p_occurrence - 1) ->> 'label',
    'detectionLabel', p_config -> 'scales' -> p_kind -> 'detection' -> (p_detection - 1) ->> 'label');
END $$;

-- What S, O and D come to on a version of the model (fmea.read). Nothing is saved.
CREATE FUNCTION app.score_fmea(p_model_id uuid, p_kind text, p_severity integer, p_occurrence integer, p_detection integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE m public.fmea_models%ROWTYPE;
BEGIN
  SELECT * INTO m FROM public.fmea_models WHERE id = p_model_id;
  IF NOT FOUND OR NOT app.has_permission(m.organisation_id, 'fmea.read') THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
  RETURN app.fmea_score(m.config, p_kind, p_severity, p_occurrence, p_detection) || jsonb_build_object('modelId', m.id, 'modelVersion', m.version);
END $$;

-- The review interval an FMEA follows when it names none of its own: the current model's.
CREATE FUNCTION app.fmea_default_review_months(p_organisation_id uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce((SELECT (config ->> 'reviewMonths')::integer FROM public.fmea_models WHERE organisation_id = p_organisation_id AND current), 12)
$$;

-- ---------------------------------------------------------------------------
-- 5. A new version (fmea.approve): the whole model with a reason; unchanged refused
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.fmea_clean_scale(p_scale jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('label', btrim(e ->> 'label'), 'criteria', nullif(btrim(coalesce(e ->> 'criteria', '')), ''))) ORDER BY o)
    FROM jsonb_array_elements(p_scale) WITH ORDINALITY x(e, o)
$$;

CREATE FUNCTION app.save_fmea_model(p_organisation_id uuid, p_config jsonb, p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE m public.fmea_models%ROWTYPE; v_problem text; v_reason text := btrim(coalesce(p_reason, '')); v_clean jsonb; v_id uuid; kind text;
BEGIN
  IF NOT app.is_member(p_organisation_id) THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(p_organisation_id, 'fmea.approve') THEN RAISE EXCEPTION 'You are not allowed to change the FMEA rating model' USING ERRCODE = '42501'; END IF;
  v_problem := app.fmea_model_problem(p_config);
  IF v_problem IS NOT NULL THEN RAISE EXCEPTION '%', v_problem USING ERRCODE = 'QM036'; END IF;
  IF length(v_reason) < 3 THEN RAISE EXCEPTION 'Say why the model is changing (at least 3 characters)' USING ERRCODE = 'QM036'; END IF;
  -- Only the known keys are kept, labels trimmed, the grid in a fixed order (so the same grid in another order is not a change).
  v_clean := jsonb_build_object(
    'method', p_config ->> 'method',
    'rpnHighFrom', (p_config ->> 'rpnHighFrom')::integer, 'rpnMediumFrom', (p_config ->> 'rpnMediumFrom')::integer,
    'severityFloor', (p_config ->> 'severityFloor')::integer, 'reviewMonths', (p_config ->> 'reviewMonths')::integer,
    'scales', jsonb_build_object(
      'design', jsonb_build_object('severity', app.fmea_clean_scale(p_config -> 'scales' -> 'design' -> 'severity'), 'occurrence', app.fmea_clean_scale(p_config -> 'scales' -> 'design' -> 'occurrence'),
                                   'detection', app.fmea_clean_scale(p_config -> 'scales' -> 'design' -> 'detection')),
      'process', jsonb_build_object('severity', app.fmea_clean_scale(p_config -> 'scales' -> 'process' -> 'severity'), 'occurrence', app.fmea_clean_scale(p_config -> 'scales' -> 'process' -> 'occurrence'),
                                    'detection', app.fmea_clean_scale(p_config -> 'scales' -> 'process' -> 'detection'))),
    'apRules', coalesce((SELECT jsonb_agg(jsonb_build_object(
                  'sFrom', (r ->> 'sFrom')::integer, 'sTo', (r ->> 'sTo')::integer, 'oFrom', (r ->> 'oFrom')::integer, 'oTo', (r ->> 'oTo')::integer,
                  'dFrom', (r ->> 'dFrom')::integer, 'dTo', (r ->> 'dTo')::integer, 'priority', r ->> 'priority')
                  ORDER BY (r ->> 'sFrom')::integer, (r ->> 'oFrom')::integer, (r ->> 'dFrom')::integer)
                  FROM jsonb_array_elements(coalesce(p_config -> 'apRules', '[]'::jsonb)) r), '[]'::jsonb));
  PERFORM pg_advisory_xact_lock(hashtextextended('fmea_model:' || p_organisation_id::text, 0));
  SELECT * INTO m FROM public.fmea_models WHERE organisation_id = p_organisation_id AND current FOR UPDATE;
  IF FOUND AND m.config = v_clean THEN RAISE EXCEPTION 'Nothing has changed in the model' USING ERRCODE = 'QM036'; END IF;
  IF FOUND THEN UPDATE public.fmea_models SET current = false WHERE id = m.id; END IF;
  INSERT INTO public.fmea_models (organisation_id, version, config, reason)
  VALUES (p_organisation_id, coalesce(m.version, 0) + 1, v_clean, CASE WHEN m.id IS NULL THEN NULL ELSE left(v_reason, 1000) END) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------
-- 6. FM1's functions used a fixed 12 months when an FMEA names no interval: they now ask the model
-- ---------------------------------------------------------------------------
CREATE FUNCTION pg_temp.patch(p_fn regprocedure, p_old text, p_new text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_def text := replace(pg_get_functiondef(p_fn), E'\r', ''); v_n integer;
BEGIN
  v_n := (length(v_def) - length(replace(v_def, p_old, ''))) / length(p_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'Expected to find % exactly once in %, found % times', p_old, p_fn, v_n; END IF;
  EXECUTE replace(v_def, p_old, p_new);
END $$;

SELECT pg_temp.patch('app.update_fmea(uuid, jsonb)'::regprocedure,
  $old$(coalesce(v_months, 12) || ' months')::interval$old$,
  $new$(coalesce(v_months, app.fmea_default_review_months(f.organisation_id)) || ' months')::interval$new$);
SELECT pg_temp.patch('app.settle_fmea(uuid)'::regprocedure,
  $old$(coalesce(v_months, 12) || ' months')::interval$old$,
  $new$(coalesce(v_months, app.fmea_default_review_months((SELECT organisation_id FROM public.fmeas WHERE id = p_fmea))) || ' months')::interval$new$);

-- ---------------------------------------------------------------------------
-- 7. Privileges
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app.fmea_model_frozen(), app.default_fmea_model(), app.seed_fmea_model(uuid), app.seed_fmea_model_trg(), app.fmea_default_review_months(uuid),
  app.fmea_score(jsonb, text, integer, integer, integer), app.fmea_clean_scale(jsonb), app.fmea_model_problem(jsonb), app.fmea_is_int(jsonb, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.score_fmea(uuid, text, integer, integer, integer), app.save_fmea_model(uuid, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.score_fmea(uuid, text, integer, integer, integer), app.save_fmea_model(uuid, jsonb, text) TO authenticated;
-- The CHECK on fmea_models calls these as whoever inserts.
GRANT EXECUTE ON FUNCTION app.fmea_model_problem(jsonb), app.fmea_is_int(jsonb, integer, integer) TO authenticated;
