-- Risk register, slice RK1 (docs/risk-management-plan.md): permissions, the scoring matrix (versions), categories, risks and inherent assessments.
--
--  * Permissions risk.read / .manage / .approve. Owner, admin and quality manager hold all three, quality engineer read and manage, inspector and viewer read.
--  * risk_models: the organisation's 5 x 5 matrix as versions (labels for likelihood 1-5 and consequence 1-5, a band for each of the 25 cells, the band up to which a
--    risk is acceptable, a review interval in months per band, a reason). A default is seeded per organisation; a new version is made only by
--    app.save_risk_model (risk.approve; unchanged refused); versions are frozen (only current -> not current), never deleted.
--  * risk_categories: per organisation, seeded (key fixed, nothing deleted); risk.manage adds, renames and switches off.
--  * risks: RSK-001 ... per organisation; a risk or an opportunity; category, title, description, cause, effect, owner (an active member), optional site and
--    department; status draft -> open (first assessment) -> treating / monitoring / closed (RK2) | retired with a reason. Written only by functions (risk.manage).
--  * risk_assessments: append-only (a new one supersedes the current one of its phase): likelihood, consequence, score and band worked out by the database from
--    the current model, whose id and version are kept; rationale; phase inherent (before treatment; residual comes with treatment in RK2).
-- Errors use QM026 (409 risk_rule); another organisation's id is P0002 (404).

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------
INSERT INTO public.permissions (code, description) VALUES
  ('risk.read',    'View the risk register: risks, opportunities, their assessments and the scoring matrix'),
  ('risk.manage',  'Manage risks: raise, edit, assess, treat and retire risks and opportunities, and the categories'),
  ('risk.approve', 'Approve the acceptance of risks above the acceptable level, and change the scoring matrix');

WITH grants(key, perms) AS (VALUES
  ('owner',            ARRAY['risk.read', 'risk.manage', 'risk.approve']),
  ('admin',            ARRAY['risk.read', 'risk.manage', 'risk.approve']),
  ('quality_manager',  ARRAY['risk.read', 'risk.manage', 'risk.approve']),
  ('quality_engineer', ARRAY['risk.read', 'risk.manage']),
  ('inspector',        ARRAY['risk.read']),
  ('viewer',           ARRAY['risk.read'])
)
INSERT INTO public.role_permissions (role_id, permission_code)
SELECT r.id, unnest(g.perms) FROM public.roles r JOIN grants g ON g.key = r.key WHERE r.is_system
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- The scoring matrix (versions)
-- ---------------------------------------------------------------------------
-- Why a matrix is not valid, or NULL. likelihood / consequence: 5 objects {label, description?}; bands: 5 rows (likelihood 1..5) of 5 bands (consequence 1..5);
-- acceptanceBand: low | medium | high (critical is never acceptable without approval); reviewMonths: {low, medium, high, critical} each 1-60.
CREATE FUNCTION app.risk_model_problem(p_data jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE k text; e jsonb; r jsonb; v_labels text[];
BEGIN
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RETURN 'Send the matrix as an object'; END IF;
  FOREACH k IN ARRAY ARRAY['likelihood', 'consequence'] LOOP
    IF jsonb_typeof(p_data -> k) IS DISTINCT FROM 'array' OR jsonb_array_length(p_data -> k) <> 5 THEN RETURN 'Give five levels of ' || k; END IF;
    v_labels := ARRAY[]::text[];
    FOR e IN SELECT x FROM jsonb_array_elements(p_data -> k) x LOOP
      IF jsonb_typeof(e) IS DISTINCT FROM 'object' OR length(btrim(coalesce(e ->> 'label', ''))) NOT BETWEEN 1 AND 40 THEN
        RETURN 'Each level of ' || k || ' needs a label of 1 to 40 characters';
      END IF;
      IF length(coalesce(e ->> 'description', '')) > 300 THEN RETURN 'A level''s description is up to 300 characters'; END IF;
      IF lower(btrim(e ->> 'label')) = ANY (v_labels) THEN RETURN 'The levels of ' || k || ' need different labels'; END IF;
      v_labels := v_labels || lower(btrim(e ->> 'label'));
    END LOOP;
  END LOOP;
  IF jsonb_typeof(p_data -> 'bands') IS DISTINCT FROM 'array' OR jsonb_array_length(p_data -> 'bands') <> 5 THEN RETURN 'Give a band for each of the 25 cells'; END IF;
  FOR r IN SELECT x FROM jsonb_array_elements(p_data -> 'bands') x LOOP
    IF jsonb_typeof(r) IS DISTINCT FROM 'array' OR jsonb_array_length(r) <> 5 THEN RETURN 'Give a band for each of the 25 cells'; END IF;
    FOR e IN SELECT x FROM jsonb_array_elements(r) x LOOP
      IF jsonb_typeof(e) IS DISTINCT FROM 'string' OR (e #>> '{}') NOT IN ('low', 'medium', 'high', 'critical') THEN RETURN 'A band is low, medium, high or critical'; END IF;
    END LOOP;
  END LOOP;
  IF coalesce(p_data ->> 'acceptanceBand', '') NOT IN ('low', 'medium', 'high') THEN RETURN 'The acceptable level is low, medium or high'; END IF;
  IF jsonb_typeof(p_data -> 'reviewMonths') IS DISTINCT FROM 'object' THEN RETURN 'Give a review interval for each band'; END IF;
  FOREACH k IN ARRAY ARRAY['low', 'medium', 'high', 'critical'] LOOP
    IF jsonb_typeof(p_data -> 'reviewMonths' -> k) IS DISTINCT FROM 'number' OR (p_data -> 'reviewMonths' ->> k)::numeric NOT BETWEEN 1 AND 60
       OR (p_data -> 'reviewMonths' ->> k)::numeric <> trunc((p_data -> 'reviewMonths' ->> k)::numeric) THEN
      RETURN 'The review interval for ' || k || ' is 1 to 60 whole months';
    END IF;
  END LOOP;
  RETURN NULL;
END $$;

CREATE TABLE public.risk_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  config jsonb NOT NULL CHECK (app.risk_model_problem(config) IS NULL),
  reason text CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 3 AND 1000),
  current boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT risk_models_version_key UNIQUE (organisation_id, version),
  CONSTRAINT risk_models_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT risk_models_state_check CHECK (version = 1 OR reason IS NOT NULL)
);
CREATE UNIQUE INDEX risk_models_current_key ON public.risk_models (organisation_id) WHERE current;

CREATE FUNCTION app.risk_model_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A version of the risk matrix is never deleted' USING ERRCODE = 'QM026'; END IF;
  IF (to_jsonb(NEW) - 'current' - 'updated_at' - 'updated_by') IS DISTINCT FROM (to_jsonb(OLD) - 'current' - 'updated_at' - 'updated_by')
     OR NOT (OLD.current AND NOT NEW.current) THEN
    RAISE EXCEPTION 'A version of the risk matrix cannot be changed. Save a new version.' USING ERRCODE = 'QM026';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER risk_models_frozen BEFORE UPDATE OR DELETE ON public.risk_models FOR EACH ROW EXECUTE FUNCTION app.risk_model_frozen();

-- The default: score = likelihood x consequence; 1-4 low, 5-9 medium, 10-16 high, 17-25 critical.
CREATE FUNCTION app.default_risk_model() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'likelihood', '[{"label":"Rare","description":"Not expected to happen"},{"label":"Unlikely","description":"Could happen, but not expected"},
                    {"label":"Possible","description":"Might happen at some time"},{"label":"Likely","description":"Will probably happen"},
                    {"label":"Almost certain","description":"Expected to happen"}]'::jsonb,
    'consequence', '[{"label":"Negligible","description":"No effect on the customer or the product"},{"label":"Minor","description":"Small effect, corrected in the normal course of work"},
                     {"label":"Moderate","description":"Rework, a late delivery or a customer concern"},{"label":"Major","description":"A customer complaint, a return or a serious loss"},
                     {"label":"Severe","description":"Safety, a legal breach, a recall or the loss of a customer"}]'::jsonb,
    'bands', (SELECT jsonb_agg(row_bands ORDER BY l) FROM (
                SELECT l, jsonb_agg(CASE WHEN l * c <= 4 THEN 'low' WHEN l * c <= 9 THEN 'medium' WHEN l * c <= 16 THEN 'high' ELSE 'critical' END ORDER BY c) AS row_bands
                  FROM generate_series(1, 5) l, generate_series(1, 5) c GROUP BY l) m),
    'acceptanceBand', 'medium',
    'reviewMonths', '{"low":12,"medium":6,"high":3,"critical":1}'::jsonb)
$$;

CREATE TRIGGER risk_models_stamp BEFORE INSERT ON public.risk_models FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER risk_models_touch BEFORE UPDATE ON public.risk_models FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER risk_models_org_immutable BEFORE UPDATE ON public.risk_models FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.risk_models FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.risk_models ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.risk_models FROM anon, authenticated;
GRANT SELECT ON public.risk_models TO authenticated;
CREATE POLICY risk_models_select ON public.risk_models FOR SELECT TO authenticated USING (app.has_permission(organisation_id, 'risk.read'));

CREATE FUNCTION app.seed_risk_model(p_organisation_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO public.risk_models (organisation_id, version, config)
  SELECT p_organisation_id, 1, app.default_risk_model()
   WHERE NOT EXISTS (SELECT 1 FROM public.risk_models WHERE organisation_id = p_organisation_id)
$$;

-- ---------------------------------------------------------------------------
-- Categories (organisation-configurable, seeded)
-- ---------------------------------------------------------------------------
CREATE TABLE public.risk_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 60),
  description text CHECK (description IS NULL OR length(btrim(description)) BETWEEN 1 AND 300),
  sequence integer NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT risk_categories_key UNIQUE (organisation_id, key),
  CONSTRAINT risk_categories_id_org_key UNIQUE (id, organisation_id)
);
CREATE UNIQUE INDEX risk_categories_label_key ON public.risk_categories (organisation_id, lower(btrim(label)));
CREATE TRIGGER risk_categories_stamp BEFORE INSERT ON public.risk_categories FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER risk_categories_touch BEFORE UPDATE ON public.risk_categories FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER risk_categories_org_immutable BEFORE UPDATE ON public.risk_categories FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.risk_categories FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.risk_categories ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.risk_categories FROM anon, authenticated;
GRANT SELECT, INSERT ON public.risk_categories TO authenticated;
GRANT UPDATE (label, description, sequence, active) ON public.risk_categories TO authenticated;
CREATE POLICY risk_categories_select ON public.risk_categories FOR SELECT TO authenticated USING (app.has_permission(organisation_id, 'risk.read'));
CREATE POLICY risk_categories_insert ON public.risk_categories FOR INSERT TO authenticated WITH CHECK (app.has_permission(organisation_id, 'risk.manage'));
CREATE POLICY risk_categories_update ON public.risk_categories FOR UPDATE TO authenticated
  USING (app.has_permission(organisation_id, 'risk.manage')) WITH CHECK (app.has_permission(organisation_id, 'risk.manage'));

CREATE FUNCTION app.seed_risk_categories(p_organisation_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO public.risk_categories (organisation_id, key, label, sequence) VALUES
    (p_organisation_id, 'process',     'Process',      1),
    (p_organisation_id, 'product',     'Product',      2),
    (p_organisation_id, 'supplier',    'Supplier',     3),
    (p_organisation_id, 'equipment',   'Equipment',    4),
    (p_organisation_id, 'people',      'People',       5),
    (p_organisation_id, 'information', 'Information',  6),
    (p_organisation_id, 'compliance',  'Compliance',   7),
    (p_organisation_id, 'customer',    'Customer',     8),
    (p_organisation_id, 'environment', 'Environment',  9),
    (p_organisation_id, 'other',       'Other',       10)
  ON CONFLICT (organisation_id, key) DO NOTHING
$$;

CREATE FUNCTION app.seed_risk_register_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.seed_risk_model(NEW.id);
  PERFORM app.seed_risk_categories(NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER organisations_seed_risk_register AFTER INSERT ON public.organisations FOR EACH ROW EXECUTE FUNCTION app.seed_risk_register_trg();
SELECT app.seed_risk_model(o.id), app.seed_risk_categories(o.id) FROM public.organisations o;

-- ---------------------------------------------------------------------------
-- Risks and their assessments
-- ---------------------------------------------------------------------------
CREATE TABLE app.risk_counters (
  organisation_id uuid PRIMARY KEY REFERENCES public.organisations (id) ON DELETE CASCADE,
  last_value integer NOT NULL DEFAULT 0
);
REVOKE ALL ON app.risk_counters FROM PUBLIC, anon, authenticated;

CREATE TABLE public.risks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  reference text NOT NULL CHECK (reference ~ '^RSK-[0-9]{3,}$'),
  kind text NOT NULL DEFAULT 'risk' CHECK (kind IN ('risk', 'opportunity')),
  category_id uuid NOT NULL,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  description text CHECK (description IS NULL OR length(btrim(description)) BETWEEN 1 AND 4000),
  cause text CHECK (cause IS NULL OR length(btrim(cause)) BETWEEN 1 AND 2000),
  effect text CHECK (effect IS NULL OR length(btrim(effect)) BETWEEN 1 AND 2000),
  owner_user_id uuid NOT NULL REFERENCES auth.users (id),
  site_id uuid,
  department_id uuid,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'treating', 'monitoring', 'closed', 'retired')),
  retired_reason text CHECK (retired_reason IS NULL OR length(btrim(retired_reason)) BETWEEN 3 AND 500),
  retired_at timestamptz,
  retired_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT risks_reference_key UNIQUE (organisation_id, reference),
  CONSTRAINT risks_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT risks_category_fkey FOREIGN KEY (category_id, organisation_id) REFERENCES public.risk_categories (id, organisation_id),
  CONSTRAINT risks_site_fkey FOREIGN KEY (site_id, organisation_id) REFERENCES public.sites (id, organisation_id),
  CONSTRAINT risks_department_fkey FOREIGN KEY (department_id, organisation_id) REFERENCES public.departments (id, organisation_id),
  CONSTRAINT risks_retired_state_check CHECK ((status = 'retired') = (retired_reason IS NOT NULL AND retired_at IS NOT NULL))
);
CREATE INDEX risks_status_idx ON public.risks (organisation_id, status);
CREATE INDEX risks_owner_idx ON public.risks (organisation_id, owner_user_id);
CREATE INDEX risks_category_idx ON public.risks (organisation_id, category_id);

CREATE TABLE public.risk_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  risk_id uuid NOT NULL,
  phase text NOT NULL DEFAULT 'inherent' CHECK (phase IN ('inherent', 'residual')),
  likelihood integer NOT NULL CHECK (likelihood BETWEEN 1 AND 5),
  consequence integer NOT NULL CHECK (consequence BETWEEN 1 AND 5),
  score integer NOT NULL CHECK (score = likelihood * consequence),
  band text NOT NULL CHECK (band IN ('low', 'medium', 'high', 'critical')),
  model_id uuid NOT NULL,
  model_version integer NOT NULL,
  rationale text NOT NULL CHECK (length(btrim(rationale)) BETWEEN 3 AND 2000),
  assessed_on date NOT NULL DEFAULT current_date,
  assessed_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'current' CHECK (status IN ('current', 'superseded')),
  supersedes_id uuid REFERENCES public.risk_assessments (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT risk_assessments_risk_fkey FOREIGN KEY (risk_id, organisation_id) REFERENCES public.risks (id, organisation_id),
  CONSTRAINT risk_assessments_model_fkey FOREIGN KEY (model_id, organisation_id) REFERENCES public.risk_models (id, organisation_id)
);
CREATE UNIQUE INDEX risk_assessments_current_key ON public.risk_assessments (risk_id, phase) WHERE status = 'current';
CREATE INDEX risk_assessments_risk_idx ON public.risk_assessments (organisation_id, risk_id);

-- An assessment is a record: only current -> superseded, never deleted.
CREATE FUNCTION app.risk_assessment_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A risk assessment is never deleted' USING ERRCODE = 'QM026'; END IF;
  IF (to_jsonb(NEW) - 'status' - 'updated_at' - 'updated_by') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'updated_at' - 'updated_by')
     OR NOT (OLD.status = 'current' AND NEW.status = 'superseded') THEN
    RAISE EXCEPTION 'A risk assessment cannot be changed. Assess the risk again.' USING ERRCODE = 'QM026';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER risk_assessments_frozen BEFORE UPDATE OR DELETE ON public.risk_assessments FOR EACH ROW EXECUTE FUNCTION app.risk_assessment_frozen();

-- Risks are never deleted, and their reference never changes.
CREATE FUNCTION app.risk_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A risk is never deleted. Retire it with a reason.' USING ERRCODE = 'QM026'; END IF;
  IF NEW.reference IS DISTINCT FROM OLD.reference THEN RAISE EXCEPTION 'A risk''s reference never changes' USING ERRCODE = 'QM026'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER risks_rules BEFORE UPDATE OR DELETE ON public.risks FOR EACH ROW EXECUTE FUNCTION app.risk_rules();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['risks', 'risk_assessments'] LOOP
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
-- Functions (SECURITY DEFINER)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.assert_risk_manager(p_organisation_id uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT app.is_member(p_organisation_id) THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(p_organisation_id, 'risk.manage') THEN
    RAISE EXCEPTION 'You are not allowed to manage risks' USING ERRCODE = '42501';
  END IF;
END $$;

-- Score and band of a cell of the organisation's current matrix: {score, band, modelId, modelVersion, likelihood, consequence (labels), acceptable}.
CREATE FUNCTION app.score_risk(p_organisation_id uuid, p_likelihood integer, p_consequence integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE m public.risk_models%ROWTYPE; v_band text;
BEGIN
  IF NOT app.has_permission(p_organisation_id, 'risk.read') THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
  IF p_likelihood IS NULL OR p_consequence IS NULL OR p_likelihood NOT BETWEEN 1 AND 5 OR p_consequence NOT BETWEEN 1 AND 5 THEN
    RAISE EXCEPTION 'Likelihood and consequence are each 1 to 5' USING ERRCODE = 'QM026';
  END IF;
  SELECT * INTO m FROM public.risk_models WHERE organisation_id = p_organisation_id AND current;
  IF NOT FOUND THEN RAISE EXCEPTION 'This organisation has no risk matrix' USING ERRCODE = 'QM026'; END IF;
  v_band := m.config -> 'bands' -> (p_likelihood - 1) ->> (p_consequence - 1);
  RETURN jsonb_build_object(
    'score', p_likelihood * p_consequence, 'band', v_band, 'modelId', m.id, 'modelVersion', m.version,
    'likelihood', m.config -> 'likelihood' -> (p_likelihood - 1) ->> 'label',
    'consequence', m.config -> 'consequence' -> (p_consequence - 1) ->> 'label',
    'acceptable', array_position(ARRAY['low', 'medium', 'high', 'critical'], v_band) <= array_position(ARRAY['low', 'medium', 'high', 'critical'], m.config ->> 'acceptanceBand'));
END $$;

-- A new version of the matrix (risk.approve): the whole config, with a reason. Existing assessments keep the version they were scored with.
CREATE FUNCTION app.save_risk_model(p_organisation_id uuid, p_config jsonb, p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE m public.risk_models%ROWTYPE; v_problem text; v_reason text := btrim(coalesce(p_reason, '')); v_clean jsonb; v_id uuid;
BEGIN
  IF NOT app.is_member(p_organisation_id) THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(p_organisation_id, 'risk.approve') THEN RAISE EXCEPTION 'You are not allowed to change the risk matrix' USING ERRCODE = '42501'; END IF;
  v_problem := app.risk_model_problem(p_config);
  IF v_problem IS NOT NULL THEN RAISE EXCEPTION '%', v_problem USING ERRCODE = 'QM026'; END IF;
  IF length(v_reason) < 3 THEN RAISE EXCEPTION 'Say why the matrix is changing (at least 3 characters)' USING ERRCODE = 'QM026'; END IF;
  -- Only the known keys are kept, labels trimmed.
  v_clean := jsonb_build_object(
    'likelihood', (SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('label', btrim(e ->> 'label'), 'description', nullif(btrim(coalesce(e ->> 'description', '')), ''))) ORDER BY o)
                     FROM jsonb_array_elements(p_config -> 'likelihood') WITH ORDINALITY x(e, o)),
    'consequence', (SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('label', btrim(e ->> 'label'), 'description', nullif(btrim(coalesce(e ->> 'description', '')), ''))) ORDER BY o)
                     FROM jsonb_array_elements(p_config -> 'consequence') WITH ORDINALITY x(e, o)),
    'bands', p_config -> 'bands', 'acceptanceBand', p_config ->> 'acceptanceBand',
    'reviewMonths', jsonb_build_object('low', (p_config -> 'reviewMonths' ->> 'low')::integer, 'medium', (p_config -> 'reviewMonths' ->> 'medium')::integer,
                                       'high', (p_config -> 'reviewMonths' ->> 'high')::integer, 'critical', (p_config -> 'reviewMonths' ->> 'critical')::integer));
  PERFORM pg_advisory_xact_lock(hashtextextended('risk_model:' || p_organisation_id::text, 0));
  SELECT * INTO m FROM public.risk_models WHERE organisation_id = p_organisation_id AND current FOR UPDATE;
  IF FOUND AND m.config = v_clean THEN RAISE EXCEPTION 'Nothing has changed in the matrix' USING ERRCODE = 'QM026'; END IF;
  IF FOUND THEN UPDATE public.risk_models SET current = false WHERE id = m.id; END IF;
  INSERT INTO public.risk_models (organisation_id, version, config, reason)
  VALUES (p_organisation_id, coalesce(m.version, 0) + 1, v_clean, CASE WHEN m.id IS NULL THEN NULL ELSE left(v_reason, 1000) END) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Checks shared by create and update: the fields as they will be stored.
CREATE FUNCTION app.assert_risk_fields(p_organisation_id uuid, p_category uuid, p_title text, p_owner uuid, p_site uuid, p_department uuid, p_keep_category uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_title IS NULL OR length(p_title) = 0 THEN RAISE EXCEPTION 'Give the risk a title' USING ERRCODE = 'QM026'; END IF;
  IF length(p_title) > 200 THEN RAISE EXCEPTION 'The title is up to 200 characters' USING ERRCODE = 'QM026'; END IF;
  IF p_category IS NULL THEN RAISE EXCEPTION 'Choose a category' USING ERRCODE = 'QM026'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.risk_categories c WHERE c.id = p_category AND c.organisation_id = p_organisation_id AND (c.active OR c.id = p_keep_category)) THEN
    RAISE EXCEPTION 'Choose an active category of this organisation' USING ERRCODE = 'QM026';
  END IF;
  IF p_owner IS NULL OR NOT app.is_active_member_user(p_organisation_id, p_owner) THEN
    RAISE EXCEPTION 'The owner must be an active member of this organisation' USING ERRCODE = 'QM026';
  END IF;
  IF p_site IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.sites s WHERE s.id = p_site AND s.organisation_id = p_organisation_id) THEN
    RAISE EXCEPTION 'Choose a site of this organisation' USING ERRCODE = 'QM026';
  END IF;
  IF p_department IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.departments d WHERE d.id = p_department AND d.organisation_id = p_organisation_id AND (p_site IS NULL OR d.site_id = p_site)) THEN
    RAISE EXCEPTION 'Choose a department of this organisation (at the chosen site)' USING ERRCODE = 'QM026';
  END IF;
END $$;

-- Keys: kind (risk | opportunity), categoryId, title, description, cause, effect, ownerId (default: the caller), siteId, departmentId.
CREATE FUNCTION app.create_risk(p_organisation_id uuid, p_data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE k text; v_n integer; v_id uuid; v_kind text; v_owner uuid; v_cat uuid; v_site uuid; v_dep uuid; v_title text;
BEGIN
  PERFORM app.assert_risk_manager(p_organisation_id);
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Send the risk as an object' USING ERRCODE = 'QM026'; END IF;
  FOR k IN SELECT jsonb_object_keys(p_data) LOOP
    IF k NOT IN ('kind', 'categoryId', 'title', 'description', 'cause', 'effect', 'ownerId', 'siteId', 'departmentId') THEN
      RAISE EXCEPTION 'Unknown field %', k USING ERRCODE = 'QM026';
    END IF;
  END LOOP;
  v_kind := coalesce(p_data ->> 'kind', 'risk');
  IF v_kind NOT IN ('risk', 'opportunity') THEN RAISE EXCEPTION 'It is a risk or an opportunity' USING ERRCODE = 'QM026'; END IF;
  v_title := btrim(coalesce(p_data ->> 'title', ''));
  v_cat := nullif(p_data ->> 'categoryId', '')::uuid;
  v_owner := coalesce(nullif(p_data ->> 'ownerId', '')::uuid, auth.uid());
  v_site := nullif(p_data ->> 'siteId', '')::uuid;
  v_dep := nullif(p_data ->> 'departmentId', '')::uuid;
  PERFORM app.assert_risk_fields(p_organisation_id, v_cat, v_title, v_owner, v_site, v_dep, NULL);
  INSERT INTO app.risk_counters AS c (organisation_id, last_value) VALUES (p_organisation_id, 1)
  ON CONFLICT (organisation_id) DO UPDATE SET last_value = c.last_value + 1 RETURNING last_value INTO v_n;
  INSERT INTO public.risks (organisation_id, reference, kind, category_id, title, description, cause, effect, owner_user_id, site_id, department_id)
  VALUES (p_organisation_id, 'RSK-' || lpad(v_n::text, 3, '0'), v_kind, v_cat, v_title,
          nullif(btrim(coalesce(p_data ->> 'description', '')), ''), nullif(btrim(coalesce(p_data ->> 'cause', '')), ''), nullif(btrim(coalesce(p_data ->> 'effect', '')), ''),
          v_owner, v_site, v_dep)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Keys present are set (null clears description, cause, effect, siteId, departmentId). The kind can change only while the risk is a draft.
CREATE FUNCTION app.update_risk(p_risk uuid, p_data jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.risks%ROWTYPE; k text; v_kind text; v_owner uuid; v_cat uuid; v_site uuid; v_dep uuid; v_title text;
BEGIN
  SELECT * INTO r FROM public.risks WHERE id = p_risk FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(r.organisation_id) THEN RAISE EXCEPTION 'Risk not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_risk_manager(r.organisation_id);
  IF r.status IN ('closed', 'retired') THEN RAISE EXCEPTION '% is % and cannot be changed', r.reference, r.status USING ERRCODE = 'QM026'; END IF;
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Send the changes as an object' USING ERRCODE = 'QM026'; END IF;
  FOR k IN SELECT jsonb_object_keys(p_data) LOOP
    IF k NOT IN ('kind', 'categoryId', 'title', 'description', 'cause', 'effect', 'ownerId', 'siteId', 'departmentId') THEN
      RAISE EXCEPTION 'Unknown field %', k USING ERRCODE = 'QM026';
    END IF;
  END LOOP;
  v_kind := CASE WHEN p_data ? 'kind' THEN p_data ->> 'kind' ELSE r.kind END;
  IF v_kind IS NULL OR v_kind NOT IN ('risk', 'opportunity') THEN RAISE EXCEPTION 'It is a risk or an opportunity' USING ERRCODE = 'QM026'; END IF;
  IF v_kind <> r.kind AND r.status <> 'draft' THEN RAISE EXCEPTION 'Once it is assessed, a risk stays a % ', r.kind USING ERRCODE = 'QM026'; END IF;
  v_title := CASE WHEN p_data ? 'title' THEN btrim(coalesce(p_data ->> 'title', '')) ELSE r.title END;
  v_cat   := CASE WHEN p_data ? 'categoryId' THEN nullif(p_data ->> 'categoryId', '')::uuid ELSE r.category_id END;
  v_owner := CASE WHEN p_data ? 'ownerId' THEN nullif(p_data ->> 'ownerId', '')::uuid ELSE r.owner_user_id END;
  v_site  := CASE WHEN p_data ? 'siteId' THEN nullif(p_data ->> 'siteId', '')::uuid ELSE r.site_id END;
  v_dep   := CASE WHEN p_data ? 'departmentId' THEN nullif(p_data ->> 'departmentId', '')::uuid ELSE r.department_id END;
  -- An owner who has since left may stay until someone changes the owner.
  PERFORM app.assert_risk_fields(r.organisation_id, v_cat, v_title, CASE WHEN v_owner = r.owner_user_id AND NOT (p_data ? 'ownerId') THEN auth.uid() ELSE v_owner END, v_site, v_dep, r.category_id);
  UPDATE public.risks SET
    kind = v_kind, title = v_title, category_id = v_cat, owner_user_id = v_owner, site_id = v_site, department_id = v_dep,
    description = CASE WHEN p_data ? 'description' THEN nullif(btrim(coalesce(p_data ->> 'description', '')), '') ELSE description END,
    cause = CASE WHEN p_data ? 'cause' THEN nullif(btrim(coalesce(p_data ->> 'cause', '')), '') ELSE cause END,
    effect = CASE WHEN p_data ? 'effect' THEN nullif(btrim(coalesce(p_data ->> 'effect', '')), '') ELSE effect END
  WHERE id = r.id;
END $$;

-- The assessment before treatment: likelihood and consequence 1-5 on the current matrix, with the reasoning. The database works out the score and the band.
-- The first one opens a draft; a later one supersedes the current one.
CREATE FUNCTION app.assess_risk(p_risk uuid, p_likelihood integer, p_consequence integer, p_rationale text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.risks%ROWTYPE; v_score jsonb; v_prev uuid; v_id uuid; v_rationale text := btrim(coalesce(p_rationale, ''));
BEGIN
  SELECT * INTO r FROM public.risks WHERE id = p_risk FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(r.organisation_id) THEN RAISE EXCEPTION 'Risk not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_risk_manager(r.organisation_id);
  IF r.status IN ('closed', 'retired') THEN RAISE EXCEPTION '% is % and cannot be assessed', r.reference, r.status USING ERRCODE = 'QM026'; END IF;
  IF length(v_rationale) < 3 THEN RAISE EXCEPTION 'Say why you scored it this way (at least 3 characters)' USING ERRCODE = 'QM026'; END IF;
  IF length(v_rationale) > 2000 THEN RAISE EXCEPTION 'The reasoning is up to 2000 characters' USING ERRCODE = 'QM026'; END IF;
  v_score := app.score_risk(r.organisation_id, p_likelihood, p_consequence);
  SELECT id INTO v_prev FROM public.risk_assessments WHERE risk_id = r.id AND phase = 'inherent' AND status = 'current' FOR UPDATE;
  IF v_prev IS NOT NULL THEN UPDATE public.risk_assessments SET status = 'superseded' WHERE id = v_prev; END IF;
  INSERT INTO public.risk_assessments (organisation_id, risk_id, phase, likelihood, consequence, score, band, model_id, model_version, rationale, supersedes_id)
  VALUES (r.organisation_id, r.id, 'inherent', p_likelihood, p_consequence, (v_score ->> 'score')::integer, v_score ->> 'band',
          (v_score ->> 'modelId')::uuid, (v_score ->> 'modelVersion')::integer, v_rationale, v_prev)
  RETURNING id INTO v_id;
  IF r.status = 'draft' THEN UPDATE public.risks SET status = 'open' WHERE id = r.id; ELSE UPDATE public.risks SET updated_at = now() WHERE id = r.id; END IF;
  RETURN v_id;
END $$;

CREATE FUNCTION app.retire_risk(p_risk uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.risks%ROWTYPE; v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  SELECT * INTO r FROM public.risks WHERE id = p_risk FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(r.organisation_id) THEN RAISE EXCEPTION 'Risk not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_risk_manager(r.organisation_id);
  IF r.status = 'retired' THEN RAISE EXCEPTION '% is already retired', r.reference USING ERRCODE = 'QM026'; END IF;
  IF length(v_reason) < 3 THEN RAISE EXCEPTION 'Say why it is retired (at least 3 characters)' USING ERRCODE = 'QM026'; END IF;
  UPDATE public.risks SET status = 'retired', retired_reason = left(v_reason, 500), retired_at = now(), retired_by = auth.uid() WHERE id = r.id;
END $$;

-- Back into the register: open when it has been assessed, else a draft.
CREATE FUNCTION app.reactivate_risk(p_risk uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.risks%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.risks WHERE id = p_risk FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(r.organisation_id) THEN RAISE EXCEPTION 'Risk not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_risk_manager(r.organisation_id);
  IF r.status <> 'retired' THEN RAISE EXCEPTION '% is not retired', r.reference USING ERRCODE = 'QM026'; END IF;
  UPDATE public.risks SET
    status = CASE WHEN EXISTS (SELECT 1 FROM public.risk_assessments a WHERE a.risk_id = r.id AND a.status = 'current') THEN 'open' ELSE 'draft' END,
    retired_reason = NULL, retired_at = NULL, retired_by = NULL
  WHERE id = r.id;
END $$;

REVOKE ALL ON FUNCTION app.risk_model_problem(jsonb), app.default_risk_model(), app.risk_model_frozen(), app.risk_assessment_frozen(), app.risk_rules(),
  app.seed_risk_model(uuid), app.seed_risk_categories(uuid), app.seed_risk_register_trg(), app.assert_risk_manager(uuid),
  app.assert_risk_fields(uuid, uuid, text, uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.score_risk(uuid, integer, integer), app.save_risk_model(uuid, jsonb, text), app.create_risk(uuid, jsonb), app.update_risk(uuid, jsonb),
  app.assess_risk(uuid, integer, integer, text), app.retire_risk(uuid, text), app.reactivate_risk(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.score_risk(uuid, integer, integer), app.save_risk_model(uuid, jsonb, text), app.create_risk(uuid, jsonb), app.update_risk(uuid, jsonb),
  app.assess_risk(uuid, integer, integer, text), app.retire_risk(uuid, text), app.reactivate_risk(uuid) TO authenticated;
-- The CHECK on risk_models calls it as whoever inserts.
GRANT EXECUTE ON FUNCTION app.risk_model_problem(jsonb) TO authenticated;
