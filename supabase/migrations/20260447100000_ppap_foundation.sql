-- PPAP, slice PP1 (docs/ppap-plan.md): the module, its permissions and package rows, the organisation's requirement set (which of the 18 elements each level needs, in versions),
-- customer rules, the submission with its 18 elements, file evidence, and the preparation lifecycle (draft -> in preparation -> ready, withdraw). Links to live records (PP2),
-- the Part Submission Warrant, submitting and the customer's decision (PP3), the portal (PP4, PP5) and the prompts (PP6) come later; the status moves for them are already held here.
--
--  * Module ppap. Permissions ppap.read / ppap.manage / ppap.approve. Owner, admin and quality manager hold all three, quality engineer read + manage, inspector and viewer read.
--    Packages: Observer = view, Contributor = view, Controller = full (every permission is tied to a feature: supabase/tests/every_feature_priced.test.sql).
--  * ppap_requirement_sets: the organisation's matrix (element x level -> submit | retain | none) and the study minimums, as VERSIONS, frozen; a neutral default is seeded
--    (the manual's own table is the publisher's and is not in the product). ppap_customer_rules: a customer's own default level, extra elements and minimums.
--  * ppap_submissions: PPAP-YY-NNNN, one per part revision, party and reason while it is live; status draft -> in_preparation -> ready -> submitted -> approved | interim_approved |
--    rejected, or withdrawn; the moves are held by a trigger even for SQL. The 18 elements are made with the submission (ppap_elements), each required | retain | not_required | n_a
--    from the level and the customer's rules, each with evidence (ppap_evidence: files now, links in PP2; removed with a reason, never deleted; private ppap-files bucket).
--  * Written only by SECURITY DEFINER functions. Errors QM037 (409 ppap_rule); another organisation's id is P0002 (404).

-- ---------------------------------------------------------------------------
-- 1. Module, permissions, packages
-- ---------------------------------------------------------------------------
INSERT INTO public.modules (slug, name, status, navigation_group, display_order) VALUES
  ('ppap', 'PPAP', 'active', 'Quality', 19)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.permissions (code, description) VALUES
  ('ppap.read',    'View PPAP submissions'),
  ('ppap.manage',  'Prepare PPAP submissions: create them, add evidence, mark them ready, and withdraw them'),
  ('ppap.approve', 'Waive an element, sign the Part Submission Warrant, record the customer''s decision, and change the PPAP requirements')
ON CONFLICT (code) DO NOTHING;

WITH grants(key, perms) AS (VALUES
  ('owner',            ARRAY['ppap.read', 'ppap.manage', 'ppap.approve']),
  ('admin',            ARRAY['ppap.read', 'ppap.manage', 'ppap.approve']),
  ('quality_manager',  ARRAY['ppap.read', 'ppap.manage', 'ppap.approve']),
  ('quality_engineer', ARRAY['ppap.read', 'ppap.manage']),
  ('inspector',        ARRAY['ppap.read']),
  ('viewer',           ARRAY['ppap.read'])
)
INSERT INTO public.role_permissions (role_id, permission_code)
SELECT r.id, unnest(g.perms) FROM public.roles r JOIN grants g ON g.key = r.key WHERE r.is_system
ON CONFLICT DO NOTHING;

INSERT INTO public.features (module_id, slug, name, min_access_level, permission_code)
SELECT m.id, f.slug, f.name, f.level, f.perm
  FROM (VALUES
    ('view_ppaps',    'View PPAP submissions',                            'view', 'ppap.read'),
    ('manage_ppaps',  'Prepare and manage PPAP submissions',              'full', 'ppap.manage'),
    ('approve_ppaps', 'Approve PPAP submissions and set the requirements', 'full', 'ppap.approve')
  ) AS f(slug, name, level, perm)
  JOIN public.modules m ON m.slug = 'ppap'
ON CONFLICT DO NOTHING;

INSERT INTO public.subscription_entitlements (subscription_plan_id, module_id, access_level)
SELECT p.id, m.id, CASE WHEN p.slug = 'controller' THEN 'full' ELSE 'view' END
  FROM public.subscription_plans p CROSS JOIN public.modules m
 WHERE m.slug = 'ppap'
   AND NOT EXISTS (SELECT 1 FROM public.subscription_entitlements e WHERE e.subscription_plan_id = p.id AND e.module_id = m.id AND e.feature_id IS NULL);

-- ---------------------------------------------------------------------------
-- 2. The 18 elements (fixed; plain wording, not the manual's text) and the requirement set
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.ppap_element_types() RETURNS TABLE (key text, ordinal integer, label text)
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT * FROM (VALUES
    ('design_records',                1,  'Design records'),
    ('engineering_change_documents',  2,  'Engineering change documents'),
    ('customer_engineering_approval', 3,  'Customer engineering approval'),
    ('dfmea',                         4,  'Design FMEA'),
    ('process_flow_diagram',          5,  'Process flow diagram'),
    ('pfmea',                         6,  'Process FMEA'),
    ('control_plan',                  7,  'Control plan'),
    ('msa_studies',                   8,  'Measurement system studies'),
    ('dimensional_results',           9,  'Dimensional results'),
    ('material_performance_tests',    10, 'Material and performance test results'),
    ('initial_process_studies',       11, 'Initial process studies'),
    ('laboratory_documentation',      12, 'Qualified laboratory documentation'),
    ('appearance_approval_report',    13, 'Appearance approval report'),
    ('sample_production_parts',       14, 'Sample production parts'),
    ('master_sample',                 15, 'Master sample'),
    ('checking_aids',                 16, 'Checking aids'),
    ('customer_specific_requirements', 17, 'Customer-specific requirements'),
    ('part_submission_warrant',       18, 'Part Submission Warrant')
  ) AS t(key, ordinal, label)
$$;

CREATE FUNCTION app.ppap_is_element(p_key text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$ SELECT EXISTS (SELECT 1 FROM app.ppap_element_types() t WHERE t.key = p_key) $$;

CREATE FUNCTION app.ppap_all_elements(p_keys text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT NOT EXISTS (SELECT 1 FROM unnest(p_keys) k WHERE NOT app.ppap_is_element(k))
$$;

-- One definition of a valid requirement set: a row for each of the 18 elements with a value for each of the five levels, and the study minimums.
CREATE FUNCTION app.ppap_requirement_problem(c jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE k text; e record; lv text; v text;
BEGIN
  IF jsonb_typeof(c) IS DISTINCT FROM 'object' THEN RETURN 'The requirements must be an object'; END IF;
  FOR k IN SELECT jsonb_object_keys(c) LOOP
    IF k NOT IN ('rows', 'minCpkInitial', 'minCpkOngoing', 'minReadings', 'maxGrrPercent', 'defaultLevel') THEN RETURN 'Unknown setting ' || k; END IF;
  END LOOP;
  IF jsonb_typeof(c -> 'rows') IS DISTINCT FROM 'object' THEN RETURN 'Give a row for each of the 18 elements'; END IF;
  FOR k IN SELECT jsonb_object_keys(c -> 'rows') LOOP
    IF NOT app.ppap_is_element(k) THEN RETURN 'Unknown element ' || k; END IF;
  END LOOP;
  FOR e IN SELECT t.key, t.label FROM app.ppap_element_types() t ORDER BY t.ordinal LOOP
    IF jsonb_typeof(c -> 'rows' -> e.key) IS DISTINCT FROM 'object' THEN RETURN 'There is no row for ' || e.label; END IF;
    FOR k IN SELECT jsonb_object_keys(c -> 'rows' -> e.key) LOOP
      IF k NOT IN ('1', '2', '3', '4', '5') THEN RETURN e.label || ' has a level ' || k || ', and the levels are 1 to 5'; END IF;
    END LOOP;
    FOREACH lv IN ARRAY ARRAY['1', '2', '3', '4', '5'] LOOP
      v := c -> 'rows' -> e.key ->> lv;
      IF v IS NULL OR v NOT IN ('submit', 'retain', 'none') THEN RETURN e.label || ' needs submit, retain or none at level ' || lv; END IF;
    END LOOP;
  END LOOP;
  IF jsonb_typeof(c -> 'minCpkInitial') IS DISTINCT FROM 'number' OR (c ->> 'minCpkInitial')::numeric NOT BETWEEN 0.1 AND 10 THEN RETURN 'The minimum Cpk for initial studies is a number from 0.1 to 10'; END IF;
  IF jsonb_typeof(c -> 'minCpkOngoing') IS DISTINCT FROM 'number' OR (c ->> 'minCpkOngoing')::numeric NOT BETWEEN 0.1 AND 10 THEN RETURN 'The minimum Cpk for ongoing studies is a number from 0.1 to 10'; END IF;
  IF jsonb_typeof(c -> 'minReadings') IS DISTINCT FROM 'number' OR (c ->> 'minReadings') !~ '^[0-9]+$' OR (c ->> 'minReadings')::integer NOT BETWEEN 1 AND 10000 THEN RETURN 'The minimum number of readings is a whole number from 1 to 10,000'; END IF;
  IF jsonb_typeof(c -> 'maxGrrPercent') IS DISTINCT FROM 'number' OR (c ->> 'maxGrrPercent')::numeric NOT BETWEEN 1 AND 100 THEN RETURN 'The largest acceptable gauge R&R is a percentage from 1 to 100'; END IF;
  IF jsonb_typeof(c -> 'defaultLevel') IS DISTINCT FROM 'number' OR (c ->> 'defaultLevel') !~ '^[1-5]$' THEN RETURN 'The default level is 1 to 5'; END IF;
  RETURN NULL;
END $$;

CREATE TABLE public.ppap_requirement_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  config jsonb NOT NULL CHECK (app.ppap_requirement_problem(config) IS NULL),
  reason text CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 3 AND 1000),
  current boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT ppap_requirement_sets_version_key UNIQUE (organisation_id, version),
  CONSTRAINT ppap_requirement_sets_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT ppap_requirement_sets_state_check CHECK (version = 1 OR reason IS NOT NULL)
);
CREATE UNIQUE INDEX ppap_requirement_sets_current_key ON public.ppap_requirement_sets (organisation_id) WHERE current;

CREATE FUNCTION app.ppap_requirement_set_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A version of the PPAP requirements is never deleted' USING ERRCODE = 'QM037'; END IF;
  IF (to_jsonb(NEW) - 'current' - 'updated_at' - 'updated_by') IS DISTINCT FROM (to_jsonb(OLD) - 'current' - 'updated_at' - 'updated_by')
     OR NOT (OLD.current AND NOT NEW.current) THEN
    RAISE EXCEPTION 'A version of the PPAP requirements cannot be changed. Save a new version.' USING ERRCODE = 'QM037';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ppap_requirement_sets_frozen BEFORE UPDATE OR DELETE ON public.ppap_requirement_sets FOR EACH ROW EXECUTE FUNCTION app.ppap_requirement_set_frozen();

-- A neutral starting point, editable: level 1 = the warrant only, level 3 and 5 = every element, level 2 = the warrant and the product evidence (the rest kept, not sent),
-- level 4 = the warrant and the customer's own requirements. The minimums are the usual published defaults and are settings, not rules.
CREATE FUNCTION app.default_ppap_requirements() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'rows', (SELECT jsonb_object_agg(t.key, jsonb_build_object(
        '1', CASE WHEN t.key = 'part_submission_warrant' THEN 'submit' ELSE 'none' END,
        '2', CASE WHEN t.key IN ('part_submission_warrant', 'dimensional_results', 'material_performance_tests', 'sample_production_parts', 'appearance_approval_report') THEN 'submit' ELSE 'retain' END,
        '3', 'submit',
        '4', CASE WHEN t.key IN ('part_submission_warrant', 'customer_specific_requirements') THEN 'submit' ELSE 'none' END,
        '5', 'submit')) FROM app.ppap_element_types() t),
    'minCpkInitial', 1.67, 'minCpkOngoing', 1.33, 'minReadings', 100, 'maxGrrPercent', 30, 'defaultLevel', 3)
$$;

CREATE FUNCTION app.seed_ppap_requirements(p_organisation_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO public.ppap_requirement_sets (organisation_id, version, config)
  SELECT p_organisation_id, 1, app.default_ppap_requirements()
   WHERE NOT EXISTS (SELECT 1 FROM public.ppap_requirement_sets WHERE organisation_id = p_organisation_id)
$$;

CREATE FUNCTION app.seed_ppap_requirements_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.seed_ppap_requirements(NEW.id);
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Tables
-- ---------------------------------------------------------------------------
CREATE TABLE app.ppap_counters (
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  year integer NOT NULL,
  last_value integer NOT NULL DEFAULT 0,
  PRIMARY KEY (organisation_id, year)
);
REVOKE ALL ON app.ppap_counters FROM PUBLIC, anon, authenticated;

-- A customer's own rules: the level they usually want, elements they always want on top of the level, and their own study minimums (empty = the organisation's).
CREATE TABLE public.ppap_customer_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  default_level integer CHECK (default_level IS NULL OR default_level BETWEEN 1 AND 5),
  extra_elements text[] NOT NULL DEFAULT '{}' CHECK (app.ppap_all_elements(extra_elements)),
  min_cpk_initial numeric CHECK (min_cpk_initial IS NULL OR min_cpk_initial BETWEEN 0.1 AND 10),
  min_cpk_ongoing numeric CHECK (min_cpk_ongoing IS NULL OR min_cpk_ongoing BETWEEN 0.1 AND 10),
  min_readings integer CHECK (min_readings IS NULL OR min_readings BETWEEN 1 AND 10000),
  max_grr_percent numeric CHECK (max_grr_percent IS NULL OR max_grr_percent BETWEEN 1 AND 100),
  note text CHECK (note IS NULL OR length(note) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT ppap_customer_rules_customer_key UNIQUE (organisation_id, customer_id),
  CONSTRAINT ppap_customer_rules_customer_fkey FOREIGN KEY (customer_id, organisation_id) REFERENCES public.customers (id, organisation_id)
);

CREATE TABLE public.ppap_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  reference text NOT NULL CHECK (reference ~ '^PPAP-[0-9]{2}-[0-9]{4,}$'),
  direction text NOT NULL DEFAULT 'submitted' CHECK (direction IN ('submitted', 'received')),
  part_id uuid NOT NULL,
  part_revision_id uuid NOT NULL,
  customer_id uuid,
  supplier_id uuid,
  site_id uuid,
  level integer NOT NULL CHECK (level BETWEEN 1 AND 5),
  reason text NOT NULL CHECK (reason IN ('new_part', 'engineering_change', 'tooling', 'discrepancy_correction', 'alternate_material_or_supplier', 'process_change', 'not_produced_12_months', 'customer_request', 'other')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'in_preparation', 'ready', 'submitted', 'approved', 'interim_approved', 'rejected', 'withdrawn')),
  requirement_set_id uuid NOT NULL,
  replaces_id uuid,
  owner_user_id uuid NOT NULL REFERENCES auth.users (id),
  notes text CHECK (notes IS NULL OR length(btrim(notes)) BETWEEN 1 AND 2000),
  client_key text CHECK (client_key IS NULL OR length(client_key) BETWEEN 8 AND 80),
  ready_at timestamptz,
  ready_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  submitted_at timestamptz,
  submitted_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  withdrawn_at timestamptz,
  withdrawn_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  withdraw_reason text CHECK (withdraw_reason IS NULL OR length(btrim(withdraw_reason)) BETWEEN 3 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT ppap_submissions_reference_key UNIQUE (organisation_id, reference),
  CONSTRAINT ppap_submissions_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT ppap_submissions_part_fkey FOREIGN KEY (part_id, organisation_id) REFERENCES public.parts (id, organisation_id),
  CONSTRAINT ppap_submissions_revision_fkey FOREIGN KEY (part_revision_id, organisation_id) REFERENCES public.part_revisions (id, organisation_id),
  CONSTRAINT ppap_submissions_customer_fkey FOREIGN KEY (customer_id, organisation_id) REFERENCES public.customers (id, organisation_id),
  CONSTRAINT ppap_submissions_supplier_fkey FOREIGN KEY (supplier_id, organisation_id) REFERENCES public.suppliers (id, organisation_id),
  CONSTRAINT ppap_submissions_site_fkey FOREIGN KEY (site_id, organisation_id) REFERENCES public.sites (id, organisation_id),
  CONSTRAINT ppap_submissions_set_fkey FOREIGN KEY (requirement_set_id, organisation_id) REFERENCES public.ppap_requirement_sets (id, organisation_id),
  CONSTRAINT ppap_submissions_replaces_fkey FOREIGN KEY (replaces_id, organisation_id) REFERENCES public.ppap_submissions (id, organisation_id),
  CONSTRAINT ppap_submissions_party_check CHECK ((direction = 'submitted' AND customer_id IS NOT NULL AND supplier_id IS NULL) OR (direction = 'received' AND supplier_id IS NOT NULL AND customer_id IS NULL)),
  CONSTRAINT ppap_submissions_withdrawn_state CHECK ((status = 'withdrawn') = (withdraw_reason IS NOT NULL AND withdrawn_at IS NOT NULL)),
  CONSTRAINT ppap_submissions_submitted_state CHECK (status NOT IN ('submitted', 'approved', 'interim_approved', 'rejected') OR submitted_at IS NOT NULL)
);
-- One live submission for a part revision, a party and a reason; a rejected or withdrawn one no longer counts, so a resubmission is a new submission.
CREATE UNIQUE INDEX ppap_submissions_live_key ON public.ppap_submissions (part_revision_id, coalesce(customer_id, supplier_id), reason) WHERE status NOT IN ('withdrawn', 'rejected');
CREATE UNIQUE INDEX ppap_submissions_client_key ON public.ppap_submissions (organisation_id, client_key) WHERE client_key IS NOT NULL;
CREATE INDEX ppap_submissions_org_status_idx ON public.ppap_submissions (organisation_id, status);
CREATE INDEX ppap_submissions_part_idx ON public.ppap_submissions (part_id);
CREATE INDEX ppap_submissions_customer_idx ON public.ppap_submissions (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX ppap_submissions_supplier_idx ON public.ppap_submissions (supplier_id) WHERE supplier_id IS NOT NULL;
CREATE INDEX ppap_submissions_owner_idx ON public.ppap_submissions (organisation_id, owner_user_id);

CREATE TABLE public.ppap_elements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  submission_id uuid NOT NULL,
  element_key text NOT NULL CHECK (app.ppap_is_element(element_key)),
  requirement text NOT NULL CHECK (requirement IN ('required', 'retain', 'not_required', 'n_a')),
  requirement_edited boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'in_progress', 'ready', 'waived')),
  note text CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 2000),
  waiver_reason text CHECK (waiver_reason IS NULL OR length(btrim(waiver_reason)) BETWEEN 10 AND 1000),
  waived_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  waived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT ppap_elements_key UNIQUE (submission_id, element_key),
  CONSTRAINT ppap_elements_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT ppap_elements_id_submission_key UNIQUE (id, submission_id),
  CONSTRAINT ppap_elements_submission_fkey FOREIGN KEY (submission_id, organisation_id) REFERENCES public.ppap_submissions (id, organisation_id),
  CONSTRAINT ppap_elements_waived_state CHECK ((status = 'waived') = (waiver_reason IS NOT NULL AND waived_at IS NOT NULL))
);
CREATE INDEX ppap_elements_submission_idx ON public.ppap_elements (organisation_id, submission_id);

-- Evidence. Files in this slice (kind file); links to the records Fortress already holds arrive with PP2. Removed with a reason, never deleted.
CREATE TABLE public.ppap_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  submission_id uuid NOT NULL,
  element_id uuid NOT NULL,
  kind text NOT NULL DEFAULT 'file' CHECK (kind IN ('file')),
  storage_path text NOT NULL,
  file_name text NOT NULL CHECK (length(btrim(file_name)) BETWEEN 1 AND 255),
  content_type text,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 26214400),
  description text CHECK (description IS NULL OR length(description) <= 500),
  removed_at timestamptz,
  removed_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  remove_reason text CHECK (remove_reason IS NULL OR length(btrim(remove_reason)) BETWEEN 3 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT ppap_evidence_submission_fkey FOREIGN KEY (submission_id, organisation_id) REFERENCES public.ppap_submissions (id, organisation_id),
  CONSTRAINT ppap_evidence_element_fkey FOREIGN KEY (element_id, submission_id) REFERENCES public.ppap_elements (id, submission_id),
  CONSTRAINT ppap_evidence_path_key UNIQUE (submission_id, storage_path),
  CONSTRAINT ppap_evidence_path CHECK (storage_path LIKE organisation_id::text || '/ppap/' || submission_id::text || '/%' AND storage_path NOT LIKE '%..%'),
  CONSTRAINT ppap_evidence_removed_state CHECK ((removed_at IS NULL) = (remove_reason IS NULL))
);
CREATE INDEX ppap_evidence_element_idx ON public.ppap_evidence (element_id);
CREATE INDEX ppap_evidence_submission_idx ON public.ppap_evidence (organisation_id, submission_id);

-- ---------------------------------------------------------------------------
-- 4. Rules the tables hold even for SQL
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.ppap_status_move_allowed(p_from text, p_to text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT (p_from, p_to) IN (
    ('draft', 'in_preparation'), ('draft', 'withdrawn'),
    ('in_preparation', 'ready'), ('in_preparation', 'withdrawn'),
    ('ready', 'in_preparation'), ('ready', 'submitted'), ('ready', 'withdrawn'),
    ('submitted', 'approved'), ('submitted', 'interim_approved'), ('submitted', 'rejected'), ('submitted', 'withdrawn'),
    ('interim_approved', 'approved'), ('interim_approved', 'rejected'), ('interim_approved', 'withdrawn'))
$$;

-- A submission is never deleted. Who it is for, which part revision, which requirements it was built on and where it came from never change. The level, reason,
-- site, owner and notes change only while it is being prepared. The status moves along the lifecycle only.
CREATE FUNCTION app.ppap_submission_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A PPAP submission is never deleted. Withdraw it with a reason.' USING ERRCODE = 'QM037'; END IF;
  IF (NEW.reference, NEW.direction, NEW.part_id, NEW.part_revision_id, NEW.customer_id, NEW.supplier_id, NEW.requirement_set_id, NEW.replaces_id, NEW.client_key)
     IS DISTINCT FROM (OLD.reference, OLD.direction, OLD.part_id, OLD.part_revision_id, OLD.customer_id, OLD.supplier_id, OLD.requirement_set_id, OLD.replaces_id, OLD.client_key) THEN
    RAISE EXCEPTION 'A submission''s reference, part revision, customer or supplier, requirements and origin never change' USING ERRCODE = 'QM037';
  END IF;
  IF NEW.status <> OLD.status AND NOT app.ppap_status_move_allowed(OLD.status, NEW.status) THEN
    RAISE EXCEPTION 'A submission cannot move from % to %', replace(OLD.status, '_', ' '), replace(NEW.status, '_', ' ') USING ERRCODE = 'QM037';
  END IF;
  IF OLD.status NOT IN ('draft', 'in_preparation')
     AND (NEW.level, NEW.reason, NEW.site_id, NEW.owner_user_id, NEW.notes) IS DISTINCT FROM (OLD.level, OLD.reason, OLD.site_id, OLD.owner_user_id, OLD.notes) THEN
    RAISE EXCEPTION 'A submission that is %, not being prepared, cannot be changed', replace(OLD.status, '_', ' ') USING ERRCODE = 'QM037';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ppap_submissions_rules BEFORE UPDATE OR DELETE ON public.ppap_submissions FOR EACH ROW EXECUTE FUNCTION app.ppap_submission_rules();

-- Elements are made with their submission and never deleted; their key never changes; what they say changes only while the submission is being prepared.
CREATE FUNCTION app.ppap_element_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'An element is never deleted' USING ERRCODE = 'QM037'; END IF;
  SELECT status INTO v_status FROM public.ppap_submissions WHERE id = NEW.submission_id;
  IF TG_OP = 'INSERT' THEN
    IF v_status IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'Elements are made with their submission' USING ERRCODE = 'QM037'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.submission_id, NEW.element_key) IS DISTINCT FROM (OLD.submission_id, OLD.element_key) THEN RAISE EXCEPTION 'An element''s key and submission never change' USING ERRCODE = 'QM037'; END IF;
  IF (NEW.requirement, NEW.requirement_edited, NEW.status, NEW.note, NEW.waiver_reason, NEW.waived_by, NEW.waived_at)
     IS DISTINCT FROM (OLD.requirement, OLD.requirement_edited, OLD.status, OLD.note, OLD.waiver_reason, OLD.waived_by, OLD.waived_at)
     AND v_status NOT IN ('draft', 'in_preparation') THEN
    RAISE EXCEPTION 'The elements change only while the submission is being prepared' USING ERRCODE = 'QM037';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ppap_elements_rules BEFORE INSERT OR UPDATE OR DELETE ON public.ppap_elements FOR EACH ROW EXECUTE FUNCTION app.ppap_element_rules();

-- Evidence is added only while the submission is being prepared, is never deleted, and can only be removed (once, with a reason).
CREATE FUNCTION app.ppap_evidence_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Evidence is never deleted. Remove it with a reason.' USING ERRCODE = 'QM037'; END IF;
  SELECT status INTO v_status FROM public.ppap_submissions WHERE id = NEW.submission_id;
  IF v_status NOT IN ('draft', 'in_preparation') THEN RAISE EXCEPTION 'Evidence changes only while the submission is being prepared' USING ERRCODE = 'QM037'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.removed_at IS NOT NULL
       OR (to_jsonb(NEW) - 'removed_at' - 'removed_by' - 'remove_reason' - 'updated_at' - 'updated_by')
          IS DISTINCT FROM (to_jsonb(OLD) - 'removed_at' - 'removed_by' - 'remove_reason' - 'updated_at' - 'updated_by') THEN
      RAISE EXCEPTION 'Evidence cannot be changed; it can only be removed, once, with a reason' USING ERRCODE = 'QM037';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ppap_evidence_rules BEFORE INSERT OR UPDATE OR DELETE ON public.ppap_evidence FOR EACH ROW EXECUTE FUNCTION app.ppap_evidence_rules();

CREATE FUNCTION app.ppap_customer_rules_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A customer''s PPAP rules are never deleted; clear what they say' USING ERRCODE = 'QM037'; END IF;
  IF NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN RAISE EXCEPTION 'The customer of a set of rules never changes' USING ERRCODE = 'QM037'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ppap_customer_rules_rules BEFORE UPDATE OR DELETE ON public.ppap_customer_rules FOR EACH ROW EXECUTE FUNCTION app.ppap_customer_rules_rules();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ppap_requirement_sets', 'ppap_customer_rules', 'ppap_submissions', 'ppap_elements', 'ppap_evidence'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION app.stamp_created()', t || '_stamp', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.touch_updated()', t || '_touch', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change()', t || '_org_immutable', t);
    EXECUTE format('CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION audit.record_change(''organisation_id'')', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
  END LOOP;
END $$;

CREATE TRIGGER organisations_seed_ppap_requirements AFTER INSERT ON public.organisations FOR EACH ROW EXECUTE FUNCTION app.seed_ppap_requirements_trg();
SELECT app.seed_ppap_requirements(o.id) FROM public.organisations o;

-- ---------------------------------------------------------------------------
-- 5. Reading: managers, approvers and the owner read everything; everyone with ppap.read reads what has been submitted
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.ppap_readable(p_submission uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.ppap_submissions s
     WHERE s.id = p_submission AND app.is_member(s.organisation_id)
       AND (app.has_permission(s.organisation_id, 'ppap.manage') OR app.has_permission(s.organisation_id, 'ppap.approve') OR s.owner_user_id = auth.uid()
            OR (s.submitted_at IS NOT NULL AND app.has_permission(s.organisation_id, 'ppap.read'))))
$$;

CREATE POLICY ppap_requirement_sets_select ON public.ppap_requirement_sets FOR SELECT TO authenticated USING (app.has_permission(organisation_id, 'ppap.read'));
CREATE POLICY ppap_customer_rules_select ON public.ppap_customer_rules FOR SELECT TO authenticated USING (app.has_permission(organisation_id, 'ppap.read'));
CREATE POLICY ppap_submissions_select ON public.ppap_submissions FOR SELECT TO authenticated USING (app.ppap_readable(id));
CREATE POLICY ppap_elements_select ON public.ppap_elements FOR SELECT TO authenticated USING (app.ppap_readable(submission_id));
CREATE POLICY ppap_evidence_select ON public.ppap_evidence FOR SELECT TO authenticated USING (app.ppap_readable(submission_id));

-- ---------------------------------------------------------------------------
-- 6. Files: the bucket and who may read and write in it
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public) VALUES ('ppap-files', 'ppap-files', false) ON CONFLICT (id) DO NOTHING;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'storage' AND table_name = 'buckets' AND column_name = 'file_size_limit') THEN
    EXECUTE $q$UPDATE storage.buckets SET file_size_limit = 26214400 WHERE id = 'ppap-files'$q$;
  END IF;
END $$;

-- <org>/ppap/<submission id>/...: anyone who may read the submission reads; ppap.manage uploads while it is being prepared.
CREATE FUNCTION app.ppap_file_allowed(p_object_name text, p_upload boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT split_part(p_object_name, '/', 2) = 'ppap'
     AND EXISTS (
       SELECT 1 FROM public.ppap_submissions s
        WHERE s.id = app.try_uuid(split_part(p_object_name, '/', 3))
          AND s.organisation_id = app.try_uuid(split_part(p_object_name, '/', 1))
          AND CASE WHEN p_upload
                   THEN s.status IN ('draft', 'in_preparation') AND app.has_permission(s.organisation_id, 'ppap.manage')
                   ELSE app.ppap_readable(s.id) END)
$$;

CREATE FUNCTION pg_temp.patch_once(p_fn regprocedure, p_marker text, p_old text, p_new text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_def text := replace(pg_get_functiondef(p_fn), E'\r', ''); v_n integer;
BEGIN
  IF position(p_marker IN v_def) > 0 THEN RETURN; END IF;
  v_n := (length(v_def) - length(replace(v_def, p_old, ''))) / length(p_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'Expected to find % exactly once in %, found % times', p_old, p_fn, v_n; END IF;
  EXECUTE replace(v_def, p_old, p_new);
END $$;

SELECT pg_temp.patch_once('app.storage_file_allowed(text, text, boolean)'::regprocedure, 'ppap-files',
  $old$    WHEN 'quality-alert-files' THEN$old$,
  $new$    WHEN 'ppap-files'          THEN app.ppap_file_allowed(p_name, p_write)
    WHEN 'quality-alert-files' THEN$new$);

DROP POLICY IF EXISTS ppap_files_insert ON storage.objects;
DROP POLICY IF EXISTS ppap_files_select ON storage.objects;
CREATE POLICY ppap_files_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'ppap-files' AND app.storage_file_allowed(bucket_id, name, true) AND app.storage_direct_allowed(name));
CREATE POLICY ppap_files_select ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'ppap-files' AND app.storage_file_allowed(bucket_id, name, false) AND app.storage_direct_allowed(name));

-- ---------------------------------------------------------------------------
-- 7. Functions (SECURITY DEFINER): the only way to write a submission
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.assert_ppap_manager(p_organisation_id uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT app.is_member(p_organisation_id) THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(p_organisation_id, 'ppap.manage') THEN RAISE EXCEPTION 'You are not allowed to prepare PPAP submissions' USING ERRCODE = '42501'; END IF;
END $$;

CREATE FUNCTION app.assert_ppap_approver(p_organisation_id uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT app.is_member(p_organisation_id) THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(p_organisation_id, 'ppap.approve') THEN RAISE EXCEPTION 'You are not allowed to approve PPAP submissions' USING ERRCODE = '42501'; END IF;
END $$;

-- Locks a submission for writing and checks the caller may prepare PPAP submissions in its organisation. approver = true asks for ppap.approve instead.
CREATE FUNCTION app.ppap_for_write(p_submission uuid, p_approver boolean DEFAULT false) RETURNS public.ppap_submissions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.ppap_submissions%ROWTYPE;
BEGIN
  SELECT * INTO s FROM public.ppap_submissions WHERE id = p_submission FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(s.organisation_id) THEN RAISE EXCEPTION 'Submission not found' USING ERRCODE = 'P0002'; END IF;
  IF p_approver THEN PERFORM app.assert_ppap_approver(s.organisation_id); ELSE PERFORM app.assert_ppap_manager(s.organisation_id); END IF;
  RETURN s;
END $$;

-- The same, and the submission must still be being prepared.
CREATE FUNCTION app.ppap_for_edit(p_submission uuid, p_approver boolean DEFAULT false) RETURNS public.ppap_submissions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.ppap_submissions%ROWTYPE;
BEGIN
  s := app.ppap_for_write(p_submission, p_approver);
  IF s.status NOT IN ('draft', 'in_preparation') THEN
    RAISE EXCEPTION '% is %. It can be changed only while it is being prepared (reopen it first if it is ready).', s.reference, replace(s.status, '_', ' ') USING ERRCODE = 'QM037';
  END IF;
  RETURN s;
END $$;

-- Marks a draft as being worked on and moves its version on, after something under it changed.
CREATE FUNCTION app.ppap_touch(p_submission uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  UPDATE public.ppap_submissions SET status = CASE WHEN status = 'draft' THEN 'in_preparation' ELSE status END, updated_at = now() WHERE id = p_submission
$$;

-- The rules a new submission starts from for a customer: its level, and the requirement of each element at that level (the customer's extra elements are required).
CREATE FUNCTION app.ppap_starting_rules(p_organisation_id uuid, p_customer uuid, p_level integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE c jsonb; r public.ppap_customer_rules%ROWTYPE; v_level integer; v_rows jsonb;
BEGIN
  SELECT config INTO c FROM public.ppap_requirement_sets WHERE organisation_id = p_organisation_id AND current;
  IF c IS NULL THEN RAISE EXCEPTION 'The organisation has no PPAP requirements' USING ERRCODE = 'QM037'; END IF;
  SELECT * INTO r FROM public.ppap_customer_rules WHERE organisation_id = p_organisation_id AND customer_id = p_customer;
  v_level := coalesce(p_level, r.default_level, (c ->> 'defaultLevel')::integer);
  SELECT jsonb_object_agg(t.key,
           CASE WHEN r.id IS NOT NULL AND t.key = ANY (r.extra_elements) THEN 'required'
                ELSE CASE c -> 'rows' -> t.key ->> v_level::text WHEN 'submit' THEN 'required' WHEN 'retain' THEN 'retain' ELSE 'not_required' END END)
    INTO v_rows FROM app.ppap_element_types() t;
  RETURN jsonb_build_object('level', v_level, 'requirements', v_rows);
END $$;

-- Keys: direction (submitted), partId, partRevisionId (default the part's released revision), customerId, siteId, level (default the customer's, else the organisation's),
-- reason, notes, ownerId (default the caller), clientKey (a retried request returns the same submission). Makes the submission and its 18 elements.
CREATE FUNCTION app.create_ppap(p_organisation_id uuid, p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  k text; v_part uuid; v_rev uuid; v_customer uuid; v_site uuid; v_level integer; v_reason text; v_owner uuid; v_key text; v_notes text; v_dir text;
  v_set uuid; v_existing uuid; v_rules jsonb; v_year integer; v_n integer; v_id uuid;
BEGIN
  PERFORM app.assert_ppap_manager(p_organisation_id);
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Send the submission as an object' USING ERRCODE = 'QM037'; END IF;
  FOR k IN SELECT jsonb_object_keys(p_data) LOOP
    IF k NOT IN ('direction', 'partId', 'partRevisionId', 'customerId', 'siteId', 'level', 'reason', 'notes', 'ownerId', 'clientKey') THEN RAISE EXCEPTION 'Unknown field %', k USING ERRCODE = 'QM037'; END IF;
  END LOOP;
  v_dir := coalesce(p_data ->> 'direction', 'submitted');
  IF v_dir <> 'submitted' THEN RAISE EXCEPTION 'Packages received from a supplier are not available yet' USING ERRCODE = 'QM037'; END IF;
  v_key := nullif(btrim(coalesce(p_data ->> 'clientKey', '')), '');
  IF v_key IS NOT NULL THEN
    IF length(v_key) NOT BETWEEN 8 AND 80 THEN RAISE EXCEPTION 'A client key is 8 to 80 characters' USING ERRCODE = 'QM037'; END IF;
    SELECT id INTO v_existing FROM public.ppap_submissions WHERE organisation_id = p_organisation_id AND client_key = v_key;
    IF FOUND THEN RETURN jsonb_build_object('id', v_existing, 'created', false); END IF;
  END IF;
  BEGIN v_part := nullif(p_data ->> 'partId', '')::uuid; v_rev := nullif(p_data ->> 'partRevisionId', '')::uuid; v_customer := nullif(p_data ->> 'customerId', '')::uuid;
        v_site := nullif(p_data ->> 'siteId', '')::uuid; v_owner := coalesce(nullif(p_data ->> 'ownerId', '')::uuid, auth.uid());
  EXCEPTION WHEN others THEN RAISE EXCEPTION 'Name the part, revision, customer, site and owner by id' USING ERRCODE = 'QM037'; END;
  IF v_part IS NULL OR NOT EXISTS (SELECT 1 FROM public.parts p WHERE p.id = v_part AND p.organisation_id = p_organisation_id) THEN RAISE EXCEPTION 'Choose a part of this organisation' USING ERRCODE = 'QM037'; END IF;
  IF v_rev IS NULL THEN SELECT id INTO v_rev FROM public.part_revisions WHERE part_id = v_part AND status = 'released'; END IF;
  IF v_rev IS NULL THEN RAISE EXCEPTION 'Choose the part revision this is for: the part has no released revision' USING ERRCODE = 'QM037'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.part_revisions r WHERE r.id = v_rev AND r.part_id = v_part AND r.organisation_id = p_organisation_id) THEN RAISE EXCEPTION 'That revision is not a revision of this part' USING ERRCODE = 'QM037'; END IF;
  IF v_customer IS NULL OR NOT EXISTS (SELECT 1 FROM public.customers c WHERE c.id = v_customer AND c.organisation_id = p_organisation_id) THEN RAISE EXCEPTION 'Choose the customer this is submitted to' USING ERRCODE = 'QM037'; END IF;
  IF v_site IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.sites s WHERE s.id = v_site AND s.organisation_id = p_organisation_id) THEN RAISE EXCEPTION 'That site is not in this organisation' USING ERRCODE = 'QM037'; END IF;
  IF NOT app.is_active_member_user(p_organisation_id, v_owner) THEN RAISE EXCEPTION 'The owner must be an active member of this organisation' USING ERRCODE = 'QM037'; END IF;
  v_reason := p_data ->> 'reason';
  IF v_reason IS NULL OR v_reason NOT IN ('new_part', 'engineering_change', 'tooling', 'discrepancy_correction', 'alternate_material_or_supplier', 'process_change', 'not_produced_12_months', 'customer_request', 'other') THEN
    RAISE EXCEPTION 'Say why this is being submitted' USING ERRCODE = 'QM037';
  END IF;
  v_notes := nullif(btrim(coalesce(p_data ->> 'notes', '')), '');
  IF v_notes IS NOT NULL AND length(v_notes) > 2000 THEN RAISE EXCEPTION 'The notes are up to 2000 characters' USING ERRCODE = 'QM037'; END IF;
  IF p_data ? 'level' AND nullif(p_data ->> 'level', '') IS NOT NULL THEN
    IF (p_data ->> 'level') !~ '^[1-5]$' THEN RAISE EXCEPTION 'The level is 1 to 5' USING ERRCODE = 'QM037'; END IF;
    v_level := (p_data ->> 'level')::integer;
  END IF;
  v_rules := app.ppap_starting_rules(p_organisation_id, v_customer, v_level);
  v_level := (v_rules ->> 'level')::integer;
  SELECT id INTO v_set FROM public.ppap_requirement_sets WHERE organisation_id = p_organisation_id AND current;
  v_year := extract(year FROM current_date)::integer;
  INSERT INTO app.ppap_counters AS c (organisation_id, year, last_value) VALUES (p_organisation_id, v_year, 1)
  ON CONFLICT (organisation_id, year) DO UPDATE SET last_value = c.last_value + 1 RETURNING last_value INTO v_n;
  BEGIN
    INSERT INTO public.ppap_submissions (organisation_id, reference, direction, part_id, part_revision_id, customer_id, site_id, level, reason, requirement_set_id, owner_user_id, notes, client_key)
    VALUES (p_organisation_id, 'PPAP-' || to_char(make_date(v_year, 1, 1), 'YY') || '-' || app.pad_number(v_n, 4), v_dir, v_part, v_rev, v_customer, v_site, v_level, v_reason, v_set, v_owner, v_notes, v_key)
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    IF v_key IS NOT NULL THEN
      SELECT id INTO v_existing FROM public.ppap_submissions WHERE organisation_id = p_organisation_id AND client_key = v_key;
      IF FOUND THEN RETURN jsonb_build_object('id', v_existing, 'created', false); END IF;
    END IF;
    RAISE EXCEPTION 'There is already a live submission of this part revision to this customer for that reason. Resubmit only after it is rejected or withdrawn.' USING ERRCODE = 'QM037';
  END;
  INSERT INTO public.ppap_elements (organisation_id, submission_id, element_key, requirement)
  SELECT p_organisation_id, v_id, t.key, v_rules -> 'requirements' ->> t.key FROM app.ppap_element_types() t ORDER BY t.ordinal;
  RETURN jsonb_build_object('id', v_id, 'created', true);
END $$;

-- Keys present are set: siteId (null clears), reason, notes (null clears), ownerId. The part revision, the customer and the level (set_ppap_level) are not here.
CREATE FUNCTION app.update_ppap(p_submission uuid, p_data jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.ppap_submissions%ROWTYPE; k text; v_site uuid; v_reason text; v_owner uuid; v_notes text;
BEGIN
  s := app.ppap_for_edit(p_submission);
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Send the changes as an object' USING ERRCODE = 'QM037'; END IF;
  FOR k IN SELECT jsonb_object_keys(p_data) LOOP
    IF k NOT IN ('siteId', 'reason', 'notes', 'ownerId') THEN RAISE EXCEPTION 'Unknown field %', k USING ERRCODE = 'QM037'; END IF;
  END LOOP;
  BEGIN
    v_site := CASE WHEN p_data ? 'siteId' THEN nullif(p_data ->> 'siteId', '')::uuid ELSE s.site_id END;
    v_owner := CASE WHEN p_data ? 'ownerId' THEN nullif(p_data ->> 'ownerId', '')::uuid ELSE s.owner_user_id END;
  EXCEPTION WHEN others THEN RAISE EXCEPTION 'Name the site and the owner by id' USING ERRCODE = 'QM037'; END;
  IF v_site IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.sites x WHERE x.id = v_site AND x.organisation_id = s.organisation_id) THEN RAISE EXCEPTION 'That site is not in this organisation' USING ERRCODE = 'QM037'; END IF;
  IF v_owner IS NULL OR (v_owner IS DISTINCT FROM s.owner_user_id AND NOT app.is_active_member_user(s.organisation_id, v_owner)) THEN RAISE EXCEPTION 'The owner must be an active member of this organisation' USING ERRCODE = 'QM037'; END IF;
  v_reason := CASE WHEN p_data ? 'reason' THEN p_data ->> 'reason' ELSE s.reason END;
  IF v_reason IS NULL OR v_reason NOT IN ('new_part', 'engineering_change', 'tooling', 'discrepancy_correction', 'alternate_material_or_supplier', 'process_change', 'not_produced_12_months', 'customer_request', 'other') THEN
    RAISE EXCEPTION 'Say why this is being submitted' USING ERRCODE = 'QM037';
  END IF;
  v_notes := CASE WHEN p_data ? 'notes' THEN nullif(btrim(coalesce(p_data ->> 'notes', '')), '') ELSE s.notes END;
  IF v_notes IS NOT NULL AND length(v_notes) > 2000 THEN RAISE EXCEPTION 'The notes are up to 2000 characters' USING ERRCODE = 'QM037'; END IF;
  BEGIN
    UPDATE public.ppap_submissions SET site_id = v_site, owner_user_id = v_owner, reason = v_reason, notes = v_notes WHERE id = s.id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'There is already a live submission of this part revision to this customer for that reason' USING ERRCODE = 'QM037';
  END;
  PERFORM app.ppap_touch(s.id);
END $$;

-- Changes the level and applies the requirement rules again to the elements nobody has touched (no status, note, evidence or hand-made requirement).
CREATE FUNCTION app.set_ppap_level(p_submission uuid, p_level integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.ppap_submissions%ROWTYPE; v_rules jsonb;
BEGIN
  s := app.ppap_for_edit(p_submission);
  IF p_level IS NULL OR p_level NOT BETWEEN 1 AND 5 THEN RAISE EXCEPTION 'The level is 1 to 5' USING ERRCODE = 'QM037'; END IF;
  IF p_level = s.level THEN RETURN; END IF;
  v_rules := app.ppap_starting_rules(s.organisation_id, s.customer_id, p_level);
  UPDATE public.ppap_submissions SET level = p_level WHERE id = s.id;
  UPDATE public.ppap_elements e SET requirement = v_rules -> 'requirements' ->> e.element_key
   WHERE e.submission_id = s.id AND e.status = 'not_started' AND NOT e.requirement_edited AND e.note IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.ppap_evidence v WHERE v.element_id = e.id);
  PERFORM app.ppap_touch(s.id);
END $$;

-- Keys present are set: requirement (required | retain | not_required | n_a), status (not_started | in_progress | ready), note (null clears).
-- A waived element is changed only after its waiver is taken off. A required element is ready only with evidence.
CREATE FUNCTION app.set_ppap_element(p_element uuid, p_data jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE e public.ppap_elements%ROWTYPE; s public.ppap_submissions%ROWTYPE; k text; v_req text; v_status text; v_note text; v_edited boolean; v_has boolean;
BEGIN
  SELECT * INTO e FROM public.ppap_elements WHERE id = p_element;
  IF NOT FOUND THEN RAISE EXCEPTION 'Element not found' USING ERRCODE = 'P0002'; END IF;
  s := app.ppap_for_edit(e.submission_id);
  SELECT * INTO e FROM public.ppap_elements WHERE id = p_element FOR UPDATE;
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Send the changes as an object' USING ERRCODE = 'QM037'; END IF;
  FOR k IN SELECT jsonb_object_keys(p_data) LOOP
    IF k NOT IN ('requirement', 'status', 'note') THEN RAISE EXCEPTION 'Unknown field %', k USING ERRCODE = 'QM037'; END IF;
  END LOOP;
  IF e.status = 'waived' THEN RAISE EXCEPTION 'This element is waived. Take the waiver off before changing it.' USING ERRCODE = 'QM037'; END IF;
  v_req := CASE WHEN p_data ? 'requirement' THEN p_data ->> 'requirement' ELSE e.requirement END;
  IF v_req IS NULL OR v_req NOT IN ('required', 'retain', 'not_required', 'n_a') THEN RAISE EXCEPTION 'The requirement is required, retain, not required or not applicable' USING ERRCODE = 'QM037'; END IF;
  v_status := CASE WHEN p_data ? 'status' THEN p_data ->> 'status' ELSE e.status END;
  IF v_status IS NULL OR v_status NOT IN ('not_started', 'in_progress', 'ready') THEN RAISE EXCEPTION 'The status is not started, in progress or ready (a waiver is made by an approver)' USING ERRCODE = 'QM037'; END IF;
  v_note := CASE WHEN p_data ? 'note' THEN nullif(btrim(coalesce(p_data ->> 'note', '')), '') ELSE e.note END;
  IF v_note IS NOT NULL AND length(v_note) > 2000 THEN RAISE EXCEPTION 'The note is up to 2000 characters' USING ERRCODE = 'QM037'; END IF;
  v_has := EXISTS (SELECT 1 FROM public.ppap_evidence v WHERE v.element_id = e.id AND v.removed_at IS NULL);
  IF v_status = 'ready' AND v_req = 'required' AND e.element_key <> 'part_submission_warrant' AND NOT v_has THEN
    RAISE EXCEPTION 'Add evidence before marking this element ready' USING ERRCODE = 'QM037';
  END IF;
  v_edited := e.requirement_edited OR v_req IS DISTINCT FROM e.requirement;
  UPDATE public.ppap_elements SET requirement = v_req, status = v_status, note = v_note, requirement_edited = v_edited WHERE id = e.id;
  PERFORM app.ppap_touch(s.id);
END $$;

-- Files: recorded after the browser has uploaded them to the submission's own folder.
CREATE FUNCTION app.add_ppap_file(p_element uuid, p_storage_path text, p_file_name text, p_content_type text, p_size_bytes bigint, p_description text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE e public.ppap_elements%ROWTYPE; s public.ppap_submissions%ROWTYPE; v_id uuid;
BEGIN
  SELECT * INTO e FROM public.ppap_elements WHERE id = p_element;
  IF NOT FOUND THEN RAISE EXCEPTION 'Element not found' USING ERRCODE = 'P0002'; END IF;
  s := app.ppap_for_edit(e.submission_id);
  SELECT * INTO e FROM public.ppap_elements WHERE id = p_element FOR UPDATE;
  IF e.status = 'waived' THEN RAISE EXCEPTION 'This element is waived. Take the waiver off before adding evidence.' USING ERRCODE = 'QM037'; END IF;
  IF p_storage_path IS NULL OR p_storage_path NOT LIKE s.organisation_id::text || '/ppap/' || s.id::text || '/%' THEN
    RAISE EXCEPTION 'The file must be stored in this submission''s folder' USING ERRCODE = 'QM037';
  END IF;
  BEGIN
    INSERT INTO public.ppap_evidence (organisation_id, submission_id, element_id, kind, storage_path, file_name, content_type, size_bytes, description)
    VALUES (s.organisation_id, s.id, e.id, 'file', p_storage_path, btrim(p_file_name), p_content_type, p_size_bytes, nullif(btrim(coalesce(p_description, '')), ''))
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'That file is already recorded' USING ERRCODE = 'QM037';
  END;
  IF e.status = 'not_started' THEN UPDATE public.ppap_elements SET status = 'in_progress' WHERE id = e.id; END IF;
  PERFORM app.ppap_touch(s.id);
  RETURN v_id;
END $$;

-- Removes evidence with a reason. An element that was ready with only that evidence goes back to in progress.
CREATE FUNCTION app.remove_ppap_evidence(p_evidence uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.ppap_evidence%ROWTYPE; s public.ppap_submissions%ROWTYPE; v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  SELECT * INTO v FROM public.ppap_evidence WHERE id = p_evidence;
  IF NOT FOUND THEN RAISE EXCEPTION 'Evidence not found' USING ERRCODE = 'P0002'; END IF;
  s := app.ppap_for_edit(v.submission_id);
  IF v.removed_at IS NOT NULL THEN RAISE EXCEPTION 'That evidence is already removed' USING ERRCODE = 'QM037'; END IF;
  IF length(v_reason) < 3 THEN RAISE EXCEPTION 'Say why it is removed (at least 3 characters)' USING ERRCODE = 'QM037'; END IF;
  UPDATE public.ppap_evidence SET removed_at = now(), removed_by = auth.uid(), remove_reason = left(v_reason, 500) WHERE id = v.id;
  UPDATE public.ppap_elements e SET status = 'in_progress'
   WHERE e.id = v.element_id AND e.status = 'ready' AND e.requirement = 'required' AND e.element_key <> 'part_submission_warrant'
     AND NOT EXISTS (SELECT 1 FROM public.ppap_evidence x WHERE x.element_id = e.id AND x.removed_at IS NULL);
  PERFORM app.ppap_touch(s.id);
END $$;

-- An approver waives a required element, with a reason of substance. It then needs no evidence.
CREATE FUNCTION app.waive_ppap_element(p_element uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE e public.ppap_elements%ROWTYPE; s public.ppap_submissions%ROWTYPE; v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  SELECT * INTO e FROM public.ppap_elements WHERE id = p_element;
  IF NOT FOUND THEN RAISE EXCEPTION 'Element not found' USING ERRCODE = 'P0002'; END IF;
  s := app.ppap_for_edit(e.submission_id, true);
  SELECT * INTO e FROM public.ppap_elements WHERE id = p_element FOR UPDATE;
  IF e.requirement <> 'required' THEN RAISE EXCEPTION 'Only a required element needs a waiver' USING ERRCODE = 'QM037'; END IF;
  IF e.status = 'waived' THEN RAISE EXCEPTION 'This element is already waived' USING ERRCODE = 'QM037'; END IF;
  IF length(v_reason) < 10 THEN RAISE EXCEPTION 'Say why the element is waived (at least 10 characters)' USING ERRCODE = 'QM037'; END IF;
  UPDATE public.ppap_elements SET status = 'waived', waiver_reason = left(v_reason, 1000), waived_by = auth.uid(), waived_at = now() WHERE id = e.id;
  PERFORM app.ppap_touch(s.id);
END $$;

CREATE FUNCTION app.unwaive_ppap_element(p_element uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE e public.ppap_elements%ROWTYPE; s public.ppap_submissions%ROWTYPE;
BEGIN
  SELECT * INTO e FROM public.ppap_elements WHERE id = p_element;
  IF NOT FOUND THEN RAISE EXCEPTION 'Element not found' USING ERRCODE = 'P0002'; END IF;
  s := app.ppap_for_edit(e.submission_id, true);
  SELECT * INTO e FROM public.ppap_elements WHERE id = p_element FOR UPDATE;
  IF e.status <> 'waived' THEN RAISE EXCEPTION 'This element is not waived' USING ERRCODE = 'QM037'; END IF;
  UPDATE public.ppap_elements x SET status = CASE WHEN EXISTS (SELECT 1 FROM public.ppap_evidence v WHERE v.element_id = x.id AND v.removed_at IS NULL) THEN 'in_progress' ELSE 'not_started' END,
         waiver_reason = NULL, waived_by = NULL, waived_at = NULL WHERE x.id = e.id;
  PERFORM app.ppap_touch(s.id);
END $$;

-- What a submission still needs before it can be marked ready: a required element (other than the warrant, which arrives with PP3) with no waiver and without both
-- evidence and the ready mark. Information for the screen; the same list stops mark_ppap_ready.
CREATE FUNCTION app.ppap_problems(p_submission uuid) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT app.ppap_readable(p_submission) THEN RAISE EXCEPTION 'Submission not found' USING ERRCODE = 'P0002'; END IF;
  RETURN coalesce((
    SELECT array_agg(t.label || ': ' || CASE WHEN NOT EXISTS (SELECT 1 FROM public.ppap_evidence v WHERE v.element_id = e.id AND v.removed_at IS NULL)
                                              THEN 'add evidence, or ask an approver to waive it' ELSE 'mark it ready' END ORDER BY t.ordinal)
      FROM public.ppap_elements e JOIN app.ppap_element_types() t ON t.key = e.element_key
     WHERE e.submission_id = p_submission AND e.requirement = 'required' AND e.status <> 'waived' AND e.element_key <> 'part_submission_warrant'
       AND NOT (e.status = 'ready' AND EXISTS (SELECT 1 FROM public.ppap_evidence v WHERE v.element_id = e.id AND v.removed_at IS NULL))), '{}'::text[]);
END $$;

CREATE FUNCTION app.mark_ppap_ready(p_submission uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.ppap_submissions%ROWTYPE; v_problems text[];
BEGIN
  s := app.ppap_for_edit(p_submission);
  v_problems := app.ppap_problems(s.id);
  IF coalesce(array_length(v_problems, 1), 0) > 0 THEN RAISE EXCEPTION 'Not ready yet: %', v_problems[1] USING ERRCODE = 'QM037'; END IF;
  PERFORM app.ppap_touch(s.id);
  UPDATE public.ppap_submissions SET status = 'ready', ready_at = now(), ready_by = auth.uid() WHERE id = s.id;
END $$;

CREATE FUNCTION app.reopen_ppap(p_submission uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.ppap_submissions%ROWTYPE;
BEGIN
  s := app.ppap_for_write(p_submission);
  IF s.status <> 'ready' THEN RAISE EXCEPTION '% is %, not ready', s.reference, replace(s.status, '_', ' ') USING ERRCODE = 'QM037'; END IF;
  UPDATE public.ppap_submissions SET status = 'in_preparation', ready_at = NULL, ready_by = NULL WHERE id = s.id;
END $$;

-- Withdraws a submission that has not been sent. (Withdrawing one that has been sent is recorded with the customer's side, in PP3.)
CREATE FUNCTION app.withdraw_ppap(p_submission uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.ppap_submissions%ROWTYPE; v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  s := app.ppap_for_write(p_submission);
  IF s.status NOT IN ('draft', 'in_preparation', 'ready') THEN RAISE EXCEPTION '% is %, so it cannot be withdrawn here', s.reference, replace(s.status, '_', ' ') USING ERRCODE = 'QM037'; END IF;
  IF length(v_reason) < 3 THEN RAISE EXCEPTION 'Say why it is withdrawn (at least 3 characters)' USING ERRCODE = 'QM037'; END IF;
  UPDATE public.ppap_submissions SET status = 'withdrawn', withdraw_reason = left(v_reason, 500), withdrawn_at = now(), withdrawn_by = auth.uid() WHERE id = s.id;
END $$;

-- The requirement set: a new version only through this function (the organisation's matrix and minimums).
CREATE FUNCTION app.save_ppap_requirement_set(p_organisation_id uuid, p_config jsonb, p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE m public.ppap_requirement_sets%ROWTYPE; v_problem text; v_reason text := btrim(coalesce(p_reason, '')); v_clean jsonb; v_id uuid;
BEGIN
  PERFORM app.assert_ppap_approver(p_organisation_id);
  v_problem := app.ppap_requirement_problem(p_config);
  IF v_problem IS NOT NULL THEN RAISE EXCEPTION '%', v_problem USING ERRCODE = 'QM037'; END IF;
  IF length(v_reason) < 3 THEN RAISE EXCEPTION 'Say why the requirements are changing (at least 3 characters)' USING ERRCODE = 'QM037'; END IF;
  v_clean := jsonb_build_object(
    'rows', (SELECT jsonb_object_agg(t.key, p_config -> 'rows' -> t.key) FROM app.ppap_element_types() t),
    'minCpkInitial', (p_config ->> 'minCpkInitial')::numeric, 'minCpkOngoing', (p_config ->> 'minCpkOngoing')::numeric,
    'minReadings', (p_config ->> 'minReadings')::integer, 'maxGrrPercent', (p_config ->> 'maxGrrPercent')::numeric, 'defaultLevel', (p_config ->> 'defaultLevel')::integer);
  PERFORM pg_advisory_xact_lock(hashtextextended('ppap_requirements:' || p_organisation_id::text, 0));
  SELECT * INTO m FROM public.ppap_requirement_sets WHERE organisation_id = p_organisation_id AND current FOR UPDATE;
  IF FOUND AND m.config = v_clean THEN RAISE EXCEPTION 'Nothing has changed in the requirements' USING ERRCODE = 'QM037'; END IF;
  IF FOUND THEN UPDATE public.ppap_requirement_sets SET current = false WHERE id = m.id; END IF;
  INSERT INTO public.ppap_requirement_sets (organisation_id, version, config, reason)
  VALUES (p_organisation_id, coalesce(m.version, 0) + 1, v_clean, CASE WHEN m.id IS NULL THEN NULL ELSE left(v_reason, 1000) END) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- A customer's own rules, replaced as a whole. Keys: defaultLevel, extraElements [keys], minCpkInitial, minCpkOngoing, minReadings, maxGrrPercent, note (all optional).
CREATE FUNCTION app.set_ppap_customer_rules(p_customer uuid, p_data jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid; k text; v_level integer; v_extra text[]; v_ci numeric; v_co numeric; v_rd integer; v_grr numeric; v_note text;
BEGIN
  SELECT organisation_id INTO v_org FROM public.customers WHERE id = p_customer;
  IF v_org IS NULL OR NOT app.is_member(v_org) THEN RAISE EXCEPTION 'Customer not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_ppap_approver(v_org);
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Send the rules as an object' USING ERRCODE = 'QM037'; END IF;
  FOR k IN SELECT jsonb_object_keys(p_data) LOOP
    IF k NOT IN ('defaultLevel', 'extraElements', 'minCpkInitial', 'minCpkOngoing', 'minReadings', 'maxGrrPercent', 'note') THEN RAISE EXCEPTION 'Unknown field %', k USING ERRCODE = 'QM037'; END IF;
  END LOOP;
  BEGIN
    v_level := nullif(p_data ->> 'defaultLevel', '')::integer; v_ci := nullif(p_data ->> 'minCpkInitial', '')::numeric; v_co := nullif(p_data ->> 'minCpkOngoing', '')::numeric;
    v_rd := nullif(p_data ->> 'minReadings', '')::integer; v_grr := nullif(p_data ->> 'maxGrrPercent', '')::numeric;
  EXCEPTION WHEN others THEN RAISE EXCEPTION 'The level, minimums and readings are numbers' USING ERRCODE = 'QM037'; END;
  IF v_level IS NOT NULL AND v_level NOT BETWEEN 1 AND 5 THEN RAISE EXCEPTION 'The level is 1 to 5' USING ERRCODE = 'QM037'; END IF;
  IF jsonb_typeof(coalesce(p_data -> 'extraElements', '[]'::jsonb)) <> 'array' THEN RAISE EXCEPTION 'Send the extra elements as a list' USING ERRCODE = 'QM037'; END IF;
  v_extra := coalesce((SELECT array_agg(DISTINCT x) FROM jsonb_array_elements_text(coalesce(p_data -> 'extraElements', '[]'::jsonb)) x), '{}'::text[]);
  IF NOT app.ppap_all_elements(v_extra) THEN RAISE EXCEPTION 'Unknown element in the extra elements' USING ERRCODE = 'QM037'; END IF;
  v_note := nullif(btrim(coalesce(p_data ->> 'note', '')), '');
  IF v_ci IS NOT NULL AND v_ci NOT BETWEEN 0.1 AND 10 OR v_co IS NOT NULL AND v_co NOT BETWEEN 0.1 AND 10 THEN RAISE EXCEPTION 'A minimum Cpk is a number from 0.1 to 10' USING ERRCODE = 'QM037'; END IF;
  IF v_rd IS NOT NULL AND v_rd NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'The minimum number of readings is 1 to 10,000' USING ERRCODE = 'QM037'; END IF;
  IF v_grr IS NOT NULL AND v_grr NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'The largest acceptable gauge R&R is a percentage from 1 to 100' USING ERRCODE = 'QM037'; END IF;
  IF v_note IS NOT NULL AND length(v_note) > 1000 THEN RAISE EXCEPTION 'The note is up to 1000 characters' USING ERRCODE = 'QM037'; END IF;
  INSERT INTO public.ppap_customer_rules AS r (organisation_id, customer_id, default_level, extra_elements, min_cpk_initial, min_cpk_ongoing, min_readings, max_grr_percent, note)
  VALUES (v_org, p_customer, v_level, v_extra, v_ci, v_co, v_rd, v_grr, v_note)
  ON CONFLICT (organisation_id, customer_id) DO UPDATE
    SET default_level = EXCLUDED.default_level, extra_elements = EXCLUDED.extra_elements, min_cpk_initial = EXCLUDED.min_cpk_initial, min_cpk_ongoing = EXCLUDED.min_cpk_ongoing,
        min_readings = EXCLUDED.min_readings, max_grr_percent = EXCLUDED.max_grr_percent, note = EXCLUDED.note;
END $$;

-- ---------------------------------------------------------------------------
-- 8. Privileges
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app.ppap_requirement_set_frozen(), app.ppap_submission_rules(), app.ppap_element_rules(), app.ppap_evidence_rules(), app.ppap_customer_rules_rules(),
  app.default_ppap_requirements(), app.seed_ppap_requirements(uuid), app.seed_ppap_requirements_trg(), app.ppap_status_move_allowed(text, text),
  app.assert_ppap_manager(uuid), app.assert_ppap_approver(uuid), app.ppap_for_write(uuid, boolean), app.ppap_for_edit(uuid, boolean), app.ppap_touch(uuid),
  app.ppap_starting_rules(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.ppap_element_types(), app.ppap_is_element(text), app.ppap_all_elements(text[]), app.ppap_requirement_problem(jsonb), app.ppap_readable(uuid), app.ppap_file_allowed(text, boolean),
  app.ppap_problems(uuid), app.create_ppap(uuid, jsonb), app.update_ppap(uuid, jsonb), app.set_ppap_level(uuid, integer), app.set_ppap_element(uuid, jsonb),
  app.add_ppap_file(uuid, text, text, text, bigint, text), app.remove_ppap_evidence(uuid, text), app.waive_ppap_element(uuid, text), app.unwaive_ppap_element(uuid),
  app.mark_ppap_ready(uuid), app.reopen_ppap(uuid), app.withdraw_ppap(uuid, text), app.save_ppap_requirement_set(uuid, jsonb, text), app.set_ppap_customer_rules(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.ppap_element_types(), app.ppap_is_element(text), app.ppap_all_elements(text[]), app.ppap_requirement_problem(jsonb), app.ppap_readable(uuid), app.ppap_file_allowed(text, boolean),
  app.ppap_problems(uuid), app.create_ppap(uuid, jsonb), app.update_ppap(uuid, jsonb), app.set_ppap_level(uuid, integer), app.set_ppap_element(uuid, jsonb),
  app.add_ppap_file(uuid, text, text, text, bigint, text), app.remove_ppap_evidence(uuid, text), app.waive_ppap_element(uuid, text), app.unwaive_ppap_element(uuid),
  app.mark_ppap_ready(uuid), app.reopen_ppap(uuid), app.withdraw_ppap(uuid, text), app.save_ppap_requirement_set(uuid, jsonb, text), app.set_ppap_customer_rules(uuid, jsonb) TO authenticated;

-- ---------------------------------------------------------------------------
-- 9. Columns that name a user are classified (supabase/tests/sso_joining_moves.test.sql fails otherwise). The owner is who was named; after a move to a company account a
--    PPAP manager names the new account as owner. The other user columns end in _by and are history by rule.
-- ---------------------------------------------------------------------------
SELECT pg_temp.patch_once(
  'app.user_reference_columns()'::regprocedure,
  $m$'ppap_submissions'$m$,
  $old$    ('fmea_team_members', 'user_id', 'history', 'A member named on the FMEA team; the team is replaced on the next revision'),$old$,
  $new$    ('fmea_team_members', 'user_id', 'history', 'A member named on the FMEA team; the team is replaced on the next revision'),
    ('ppap_submissions', 'owner_user_id', 'history', 'Who owns the PPAP submission; after a move to a company account a PPAP manager names the new account as owner'),$new$);
