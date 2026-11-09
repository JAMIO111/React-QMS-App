-- Supplier Quality SQ4b: incoming inspection requirements, incoming inspection through the SHARED inspection engine, dispositions, and rejection → non-conformance
-- (docs/supplier-quality-plan.md; spec §8).
--
--  * supplier_inspection_requirements: configurable rules for what to inspect when a delivery arrives — scoped by supplier, part, part family, supplier classification and/or risk
--    rating (any combination; none = the organisation default), with a strategy (100%, first article, fixed sample, percentage, an explicit sampling plan by lot-size band, skip-lot,
--    none), an inspection LEVEL (increased / normal / reduced / skip) and an accept number. Rules are written as drafts, APPROVED by a different person with supplier_quality.approve,
--    and then frozen; a change is a new rule that supersedes the old one when approved, so the history of levels and rationale is the chain of rules.
--  * CONTROLLED PARTS: a rule that reduces controls (level reduced / skip, strategy skip-lot / none) is never applied to a part whose incoming control-plan operation has an applicable
--    CRITICAL characteristic, or whose plan cannot be resolved (conservative): full inspection is determined instead and the reason is recorded. Good supplier performance never relaxes it.
--  * incoming_inspection_determinations: what the rules said for each receipt line when it arrived (frozen): inspection required or not, the rule, strategy, sample size, accept number,
--    and why. A line that needs inspection puts its lot ON HOLD ("awaiting incoming inspection"). A line without a part (a material) cannot be inspected through a control plan.
--  * incoming_inspections: the link from a receipt line to an inspection record made by app.start_incoming_inspection, which calls the SAME app.start_inspection as every other
--    inspection (trigger 'incoming'): control plan resolver, samples, gauges, measurements, failure acknowledgement and NC raising all apply unchanged.
--  * receipt_line_dispositions: held / accepted / rejected / conditional, append-only. Accepting a line that needed inspection requires a completed inspection with the required
--    samples and no more failed samples than the accept number. Conditional needs supplier_quality.approve and conditions. Accepting or conditionally accepting releases the lot;
--    rejecting or holding keeps it on hold. Leaving "rejected" needs an approver.
--  * receipt_line_ncrs + app.raise_ncr_from_receipt_line: a rejection (or any problem) raises a CENTRAL non-conformance (source goods receiving, the supplier, part, lot, the order number
--    and the quantity), idempotent per line; the NC page can show where it came from.
-- Functions only for writes; nothing is deleted. Errors QM021 → 409 receiving_rule.

-- The engine's trigger types gain 'incoming'.
ALTER TABLE public.inspection_records DROP CONSTRAINT inspection_records_trigger_type_check;
ALTER TABLE public.inspection_records ADD CONSTRAINT inspection_records_trigger_type_check
  CHECK (trigger_type IN ('first_off', 'last_off', 'every_n_minutes', 'every_n_parts', 'start_of_shift', 'after_tool_change', 'after_setup', 'manual', 'incoming'));
ALTER TABLE public.inspection_samples DROP CONSTRAINT inspection_samples_trigger_type_check;
ALTER TABLE public.inspection_samples ADD CONSTRAINT inspection_samples_trigger_type_check
  CHECK (trigger_type IN ('first_off', 'last_off', 'every_n_minutes', 'every_n_parts', 'start_of_shift', 'after_tool_change', 'after_setup', 'manual', 'incoming'));

-- ---------------------------------------------------------------------------
-- Rules
-- ---------------------------------------------------------------------------
CREATE TABLE public.supplier_inspection_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  supplier_id uuid,
  part_id uuid,
  part_family_id uuid,
  classification_id uuid,
  risk_rating text CHECK (risk_rating IS NULL OR risk_rating IN ('low', 'medium', 'high', 'critical')),
  strategy text NOT NULL CHECK (strategy IN ('full', 'first_article', 'fixed', 'percentage', 'plan', 'skip_lot', 'none')),
  level text NOT NULL DEFAULT 'normal' CHECK (level IN ('increased', 'normal', 'reduced', 'skip')),
  sample_size integer CHECK (sample_size IS NULL OR sample_size BETWEEN 1 AND 100000),
  percentage numeric(5, 2) CHECK (percentage IS NULL OR (percentage > 0 AND percentage <= 100)),
  skip_every integer CHECK (skip_every IS NULL OR skip_every BETWEEN 2 AND 1000),
  accept_number integer NOT NULL DEFAULT 0 CHECK (accept_number BETWEEN 0 AND 100000),
  plan jsonb,
  operation_code text NOT NULL DEFAULT 'INCOMING' CHECK (length(btrim(operation_code)) BETWEEN 1 AND 40),
  rationale text CHECK (rationale IS NULL OR length(btrim(rationale)) BETWEEN 1 AND 1000),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'superseded', 'retired')),
  supersedes_id uuid,
  reduces_controls boolean GENERATED ALWAYS AS (level IN ('reduced', 'skip') OR strategy IN ('none', 'skip_lot')) STORED,
  approved_at timestamptz,
  approved_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  approval_note text CHECK (approval_note IS NULL OR length(btrim(approval_note)) BETWEEN 3 AND 1000),
  retired_at timestamptz,
  retired_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  retire_reason text CHECK (retire_reason IS NULL OR length(btrim(retire_reason)) BETWEEN 3 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT supplier_inspection_requirements_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT supplier_inspection_requirements_supplier_fkey FOREIGN KEY (supplier_id, organisation_id) REFERENCES public.suppliers (id, organisation_id),
  CONSTRAINT supplier_inspection_requirements_part_fkey FOREIGN KEY (part_id, organisation_id) REFERENCES public.parts (id, organisation_id),
  CONSTRAINT supplier_inspection_requirements_family_fkey FOREIGN KEY (part_family_id, organisation_id) REFERENCES public.part_families (id, organisation_id),
  CONSTRAINT supplier_inspection_requirements_class_fkey FOREIGN KEY (classification_id, organisation_id) REFERENCES public.supplier_classifications (id, organisation_id),
  CONSTRAINT supplier_inspection_requirements_supersedes_fkey FOREIGN KEY (supersedes_id, organisation_id) REFERENCES public.supplier_inspection_requirements (id, organisation_id),
  CONSTRAINT supplier_inspection_requirements_params CHECK (
    (strategy IN ('full', 'none') AND sample_size IS NULL AND percentage IS NULL AND skip_every IS NULL AND plan IS NULL) OR
    (strategy IN ('fixed', 'first_article') AND sample_size IS NOT NULL AND percentage IS NULL AND skip_every IS NULL AND plan IS NULL) OR
    (strategy = 'percentage' AND percentage IS NOT NULL AND sample_size IS NULL AND skip_every IS NULL AND plan IS NULL) OR
    (strategy = 'plan' AND plan IS NOT NULL AND sample_size IS NULL AND percentage IS NULL AND skip_every IS NULL) OR
    (strategy = 'skip_lot' AND sample_size IS NOT NULL AND skip_every IS NOT NULL AND percentage IS NULL AND plan IS NULL)),
  CONSTRAINT supplier_inspection_requirements_state CHECK (
    (status = 'approved' AND approved_at IS NOT NULL AND approved_by IS NOT NULL) OR (status IN ('draft', 'superseded', 'retired')))
);
CREATE INDEX supplier_inspection_requirements_status_idx ON public.supplier_inspection_requirements (organisation_id, status);

-- A sampling plan: ascending, non-overlapping bands of lot size, each with its sample size and accept number.
CREATE FUNCTION app.inspection_plan_problem(p_plan jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE b jsonb; v_prev integer := 0; v_from integer; v_to integer; v_sample integer; v_acc integer;
BEGIN
  IF jsonb_typeof(p_plan) <> 'array' OR jsonb_array_length(p_plan) NOT BETWEEN 1 AND 20 THEN RETURN 'A sampling plan has between 1 and 20 bands'; END IF;
  FOR b IN SELECT x FROM jsonb_array_elements(p_plan) x LOOP
    IF jsonb_typeof(b) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(b) k WHERE k NOT IN ('fromQuantity', 'toQuantity', 'sampleSize', 'acceptNumber')) THEN RETURN 'A band has fromQuantity, toQuantity, sampleSize and acceptNumber'; END IF;
    IF coalesce(b ->> 'fromQuantity', '') !~ '^[0-9]+$' OR coalesce(b ->> 'toQuantity', '') !~ '^[0-9]+$' OR coalesce(b ->> 'sampleSize', '') !~ '^[0-9]+$' OR coalesce(b ->> 'acceptNumber', '') !~ '^[0-9]+$' THEN RETURN 'Every band value is a whole number'; END IF;
    v_from := (b ->> 'fromQuantity')::int; v_to := (b ->> 'toQuantity')::int; v_sample := (b ->> 'sampleSize')::int; v_acc := (b ->> 'acceptNumber')::int;
    IF v_from < 1 OR v_to < v_from THEN RETURN 'A band runs from a lot size of 1 or more up to a larger or equal one'; END IF;
    IF v_from <= v_prev THEN RETURN 'Bands must be in ascending order without overlapping'; END IF;
    IF v_sample < 1 OR v_sample > v_to THEN RETURN 'A band''s sample size is at least 1 and not more than the lot sizes it covers'; END IF;
    IF v_acc >= v_sample THEN RETURN 'The accept number must be below the sample size'; END IF;
    v_prev := v_to;
  END LOOP;
  RETURN NULL;
END $$;
ALTER TABLE public.supplier_inspection_requirements ADD CONSTRAINT supplier_inspection_requirements_plan_valid CHECK (plan IS NULL OR app.inspection_plan_problem(plan) IS NULL);

-- ---------------------------------------------------------------------------
-- What the rules said for a receipt line, how it was inspected, what was decided, and the NCs raised from it
-- ---------------------------------------------------------------------------
CREATE TABLE public.incoming_inspection_determinations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  receipt_line_id uuid NOT NULL,
  rule_id uuid,
  rule_name text,
  strategy text NOT NULL,
  level text NOT NULL,
  required boolean NOT NULL,
  sample_size integer,
  accept_number integer NOT NULL DEFAULT 0,
  operation_code text,
  basis text NOT NULL CHECK (length(basis) BETWEEN 1 AND 1000),
  overridden boolean NOT NULL DEFAULT false,
  determined_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT incoming_inspection_determinations_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT incoming_inspection_determinations_line_key UNIQUE (receipt_line_id),
  CONSTRAINT incoming_inspection_determinations_line_fkey FOREIGN KEY (receipt_line_id, organisation_id) REFERENCES public.goods_receipt_lines (id, organisation_id),
  CONSTRAINT incoming_inspection_determinations_rule_fkey FOREIGN KEY (rule_id, organisation_id) REFERENCES public.supplier_inspection_requirements (id, organisation_id)
);

CREATE TABLE public.incoming_inspections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  receipt_line_id uuid NOT NULL,
  inspection_record_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT incoming_inspections_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT incoming_inspections_line_key UNIQUE (receipt_line_id),
  CONSTRAINT incoming_inspections_record_key UNIQUE (inspection_record_id),
  CONSTRAINT incoming_inspections_line_fkey FOREIGN KEY (receipt_line_id, organisation_id) REFERENCES public.goods_receipt_lines (id, organisation_id),
  CONSTRAINT incoming_inspections_record_fkey FOREIGN KEY (inspection_record_id, organisation_id) REFERENCES public.inspection_records (id, organisation_id)
);

CREATE TABLE public.receipt_line_dispositions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  receipt_line_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('held', 'accepted', 'rejected', 'conditional')),
  reason text CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 3 AND 1000),
  conditions text CHECK (conditions IS NULL OR length(btrim(conditions)) BETWEEN 3 AND 2000),
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT receipt_line_dispositions_line_fkey FOREIGN KEY (receipt_line_id, organisation_id) REFERENCES public.goods_receipt_lines (id, organisation_id),
  CONSTRAINT receipt_line_dispositions_reason CHECK (decision = 'accepted' OR reason IS NOT NULL),
  CONSTRAINT receipt_line_dispositions_conditions CHECK ((decision = 'conditional') = (conditions IS NOT NULL))
);
CREATE INDEX receipt_line_dispositions_line_idx ON public.receipt_line_dispositions (receipt_line_id, decided_at);

CREATE TABLE public.receipt_line_ncrs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  receipt_line_id uuid NOT NULL,
  ncr_id uuid NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT now(),
  linked_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT receipt_line_ncrs_line_fkey FOREIGN KEY (receipt_line_id, organisation_id) REFERENCES public.goods_receipt_lines (id, organisation_id),
  CONSTRAINT receipt_line_ncrs_ncr_fkey FOREIGN KEY (ncr_id, organisation_id) REFERENCES public.nonconformances (id, organisation_id),
  CONSTRAINT receipt_line_ncrs_key UNIQUE (receipt_line_id, ncr_id)
);
CREATE INDEX receipt_line_ncrs_ncr_idx ON public.receipt_line_ncrs (ncr_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['supplier_inspection_requirements', 'incoming_inspection_determinations', 'incoming_inspections', 'receipt_line_dispositions', 'receipt_line_ncrs'] LOOP
    EXECUTE format('CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION audit.record_change(%L)', t, 'organisation_id');
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format($p$CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (app.has_permission(organisation_id, %L))$p$, t || '_select', t,
                   CASE WHEN t = 'supplier_inspection_requirements' THEN 'supplier_quality.read' ELSE 'receiving.read' END);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION app.stamp_created()', t || '_stamp', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.touch_updated()', t || '_touch', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change()', t || '_org_immutable', t);
  END LOOP;
END $$;

-- Determinations, links and dispositions are written once and never changed or deleted.
CREATE FUNCTION app.incoming_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'Incoming inspection records are never changed or deleted once written' USING ERRCODE = 'QM021';
END $$;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['incoming_inspection_determinations', 'incoming_inspections', 'receipt_line_dispositions', 'receipt_line_ncrs'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.incoming_frozen()', t || '_frozen', t);
  END LOOP;
END $$;

-- An approved rule keeps its definition; only its status (superseded, retired) and the stamps may change. (The generated column is left out: it is not yet worked out in a BEFORE trigger.)
CREATE FUNCTION app.requirement_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Inspection requirements are never deleted' USING ERRCODE = 'QM021'; END IF;
  IF OLD.status <> 'draft' AND (to_jsonb(NEW) - ARRAY['status', 'retired_at', 'retired_by', 'retire_reason', 'updated_at', 'updated_by', 'reduces_controls'])
                              IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'retired_at', 'retired_by', 'retire_reason', 'updated_at', 'updated_by', 'reduces_controls']) THEN
    RAISE EXCEPTION 'An approved inspection requirement is never edited: write a new one that supersedes it' USING ERRCODE = 'QM021';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER supplier_inspection_requirements_frozen BEFORE UPDATE OR DELETE ON public.supplier_inspection_requirements FOR EACH ROW EXECUTE FUNCTION app.requirement_frozen();

-- ---------------------------------------------------------------------------
-- Writing rules
-- p_def keys: name, supplierId, partId, partFamilyId, classificationId, riskRating, strategy, level, sampleSize, percentage, skipEvery, acceptNumber, plan, operationCode, rationale, supersedesId
-- p_id NULL makes a new draft; a draft is edited by sending its id (keys absent keep their value). Needs supplier_quality.manage.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.save_inspection_requirement(p_organisation uuid, p_id uuid, p_def jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.supplier_inspection_requirements%ROWTYPE; v_id uuid; k text; n record; v_problem text;
BEGIN
  IF NOT app.is_member(p_organisation) THEN RAISE EXCEPTION 'Organisation not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(p_organisation, 'supplier_quality.manage') THEN RAISE EXCEPTION 'You are not allowed to change inspection requirements' USING ERRCODE = '42501'; END IF;
  IF jsonb_typeof(p_def) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Describe the requirement' USING ERRCODE = 'QM021'; END IF;
  FOR k IN SELECT jsonb_object_keys(p_def) LOOP
    IF k NOT IN ('name', 'supplierId', 'partId', 'partFamilyId', 'classificationId', 'riskRating', 'strategy', 'level', 'sampleSize', 'percentage', 'skipEvery', 'acceptNumber', 'plan', 'operationCode', 'rationale', 'supersedesId') THEN
      RAISE EXCEPTION 'Unknown field %', k USING ERRCODE = 'QM021';
    END IF;
  END LOOP;
  IF p_id IS NOT NULL THEN
    SELECT * INTO r FROM public.supplier_inspection_requirements WHERE id = p_id AND organisation_id = p_organisation FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Inspection requirement not found' USING ERRCODE = 'P0002'; END IF;
    IF r.status <> 'draft' THEN RAISE EXCEPTION 'Only a draft can be edited: write a new requirement that supersedes this one' USING ERRCODE = 'QM021'; END IF;
  END IF;
  n := ROW(NULL); -- placeholder to keep the record type simple
  v_problem := NULL;
  IF p_id IS NULL THEN
    INSERT INTO public.supplier_inspection_requirements (organisation_id, name, strategy, level, sample_size, percentage, skip_every, accept_number, plan, operation_code, rationale,
                                                         supplier_id, part_id, part_family_id, classification_id, risk_rating, supersedes_id)
    VALUES (p_organisation, btrim(coalesce(p_def ->> 'name', '')), coalesce(p_def ->> 'strategy', 'full'), coalesce(p_def ->> 'level', 'normal'),
            nullif(p_def ->> 'sampleSize', '')::int, nullif(p_def ->> 'percentage', '')::numeric, nullif(p_def ->> 'skipEvery', '')::int, coalesce(nullif(p_def ->> 'acceptNumber', '')::int, 0),
            CASE WHEN jsonb_typeof(p_def -> 'plan') = 'array' THEN p_def -> 'plan' END, coalesce(nullif(btrim(coalesce(p_def ->> 'operationCode', '')), ''), 'INCOMING'),
            nullif(btrim(coalesce(p_def ->> 'rationale', '')), ''), nullif(p_def ->> 'supplierId', '')::uuid, nullif(p_def ->> 'partId', '')::uuid, nullif(p_def ->> 'partFamilyId', '')::uuid,
            nullif(p_def ->> 'classificationId', '')::uuid, nullif(p_def ->> 'riskRating', ''), nullif(p_def ->> 'supersedesId', '')::uuid)
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.supplier_inspection_requirements SET
      name = CASE WHEN p_def ? 'name' THEN btrim(p_def ->> 'name') ELSE name END,
      strategy = CASE WHEN p_def ? 'strategy' THEN p_def ->> 'strategy' ELSE strategy END,
      level = CASE WHEN p_def ? 'level' THEN p_def ->> 'level' ELSE level END,
      sample_size = CASE WHEN p_def ? 'sampleSize' THEN nullif(p_def ->> 'sampleSize', '')::int ELSE sample_size END,
      percentage = CASE WHEN p_def ? 'percentage' THEN nullif(p_def ->> 'percentage', '')::numeric ELSE percentage END,
      skip_every = CASE WHEN p_def ? 'skipEvery' THEN nullif(p_def ->> 'skipEvery', '')::int ELSE skip_every END,
      accept_number = CASE WHEN p_def ? 'acceptNumber' THEN coalesce(nullif(p_def ->> 'acceptNumber', '')::int, 0) ELSE accept_number END,
      plan = CASE WHEN p_def ? 'plan' THEN CASE WHEN jsonb_typeof(p_def -> 'plan') = 'array' THEN p_def -> 'plan' END ELSE plan END,
      operation_code = CASE WHEN p_def ? 'operationCode' THEN coalesce(nullif(btrim(coalesce(p_def ->> 'operationCode', '')), ''), 'INCOMING') ELSE operation_code END,
      rationale = CASE WHEN p_def ? 'rationale' THEN nullif(btrim(coalesce(p_def ->> 'rationale', '')), '') ELSE rationale END,
      supplier_id = CASE WHEN p_def ? 'supplierId' THEN nullif(p_def ->> 'supplierId', '')::uuid ELSE supplier_id END,
      part_id = CASE WHEN p_def ? 'partId' THEN nullif(p_def ->> 'partId', '')::uuid ELSE part_id END,
      part_family_id = CASE WHEN p_def ? 'partFamilyId' THEN nullif(p_def ->> 'partFamilyId', '')::uuid ELSE part_family_id END,
      classification_id = CASE WHEN p_def ? 'classificationId' THEN nullif(p_def ->> 'classificationId', '')::uuid ELSE classification_id END,
      risk_rating = CASE WHEN p_def ? 'riskRating' THEN nullif(p_def ->> 'riskRating', '') ELSE risk_rating END,
      supersedes_id = CASE WHEN p_def ? 'supersedesId' THEN nullif(p_def ->> 'supersedesId', '')::uuid ELSE supersedes_id END,
      updated_by = auth.uid()
    WHERE id = p_id RETURNING id INTO v_id;
  END IF;
  SELECT * INTO r FROM public.supplier_inspection_requirements WHERE id = v_id;
  IF r.supersedes_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.supplier_inspection_requirements WHERE id = r.supersedes_id AND status = 'approved') THEN
    RAISE EXCEPTION 'Only an approved requirement can be superseded' USING ERRCODE = 'QM021';
  END IF;
  RETURN v_id;
END $$;

-- Approve a draft: a DIFFERENT person with supplier_quality.approve (never the one who wrote or last edited it). A rule that reduces controls needs a note of at least 10 characters.
-- If it supersedes a rule, that rule is superseded in the same step.
CREATE FUNCTION app.approve_inspection_requirement(p_id uuid, p_note text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.supplier_inspection_requirements%ROWTYPE; v_note text := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  SELECT * INTO r FROM public.supplier_inspection_requirements WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(r.organisation_id) THEN RAISE EXCEPTION 'Inspection requirement not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(r.organisation_id, 'supplier_quality.approve') THEN RAISE EXCEPTION 'You are not allowed to approve inspection requirements' USING ERRCODE = '42501'; END IF;
  IF r.status <> 'draft' THEN RAISE EXCEPTION 'Only a draft can be approved' USING ERRCODE = 'QM021'; END IF;
  IF auth.uid() IS NOT DISTINCT FROM r.created_by OR auth.uid() IS NOT DISTINCT FROM r.updated_by THEN RAISE EXCEPTION 'Someone else approves: you wrote or edited this requirement' USING ERRCODE = 'QM021'; END IF;
  IF r.reduces_controls AND (v_note IS NULL OR length(v_note) < 10) THEN RAISE EXCEPTION 'A requirement that reduces inspection needs a reason of at least 10 characters' USING ERRCODE = 'QM021'; END IF;
  IF v_note IS NOT NULL AND length(v_note) > 1000 THEN RAISE EXCEPTION 'The note is up to 1000 characters' USING ERRCODE = 'QM021'; END IF;
  IF r.supersedes_id IS NOT NULL THEN
    UPDATE public.supplier_inspection_requirements SET status = 'superseded', updated_by = auth.uid() WHERE id = r.supersedes_id AND status = 'approved';
  END IF;
  UPDATE public.supplier_inspection_requirements SET status = 'approved', approved_at = clock_timestamp(), approved_by = auth.uid(), approval_note = v_note, updated_by = auth.uid() WHERE id = r.id;
END $$;

CREATE FUNCTION app.retire_inspection_requirement(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.supplier_inspection_requirements%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.supplier_inspection_requirements WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(r.organisation_id) THEN RAISE EXCEPTION 'Inspection requirement not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(r.organisation_id, 'supplier_quality.manage') THEN RAISE EXCEPTION 'You are not allowed to change inspection requirements' USING ERRCODE = '42501'; END IF;
  IF r.status NOT IN ('draft', 'approved') THEN RAISE EXCEPTION 'That requirement is already %', r.status USING ERRCODE = 'QM021'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'Say why it is being retired (3 to 1000 characters)' USING ERRCODE = 'QM021'; END IF;
  UPDATE public.supplier_inspection_requirements SET status = 'retired', retired_at = now(), retired_by = auth.uid(), retire_reason = btrim(p_reason), updated_by = auth.uid() WHERE id = r.id;
END $$;

-- ---------------------------------------------------------------------------
-- Resolving what to inspect
-- ---------------------------------------------------------------------------
-- A part is "controlled" for incoming inspection when its incoming control-plan operation has an applicable CRITICAL characteristic, or the plan cannot be resolved (conservative).
CREATE FUNCTION app.part_controlled_for_incoming(p_part uuid, p_operation text, p_site uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v jsonb;
BEGIN
  v := app.resolve_inspection_requirements(p_part, p_operation, p_site, NULL);
  IF v ->> 'status' IS DISTINCT FROM 'ok' THEN RETURN true; END IF;
  RETURN EXISTS (SELECT 1 FROM jsonb_array_elements(v -> 'requirements') e WHERE e ->> 'criticality' = 'critical' AND coalesce((e ->> 'applicable')::boolean, true));
END $$;

-- What the approved rules say for this supplier, part and quantity. p_line_id (optional) excludes that line from the history counts used by first-article and skip-lot.
-- Returns {required, ruleId, ruleName, strategy, level, sampleSize, acceptNumber, operationCode, basis, overridden, controlled}.
CREATE FUNCTION app.resolve_incoming_inspection(p_supplier uuid, p_part uuid, p_quantity numeric, p_site uuid, p_line_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  s public.suppliers%ROWTYPE; p public.parts%ROWTYPE; r public.supplier_inspection_requirements%ROWTYPE; v_qty integer; v_prior integer; v_sample integer; v_acc integer; v_required boolean := true;
  v_basis text; v_controlled boolean := false; v_overridden boolean := false; v_strategy text; v_level text; v_op text := 'INCOMING'; b jsonb; v_found boolean := false;
BEGIN
  SELECT * INTO s FROM public.suppliers WHERE id = p_supplier;
  IF NOT FOUND THEN RAISE EXCEPTION 'Supplier not found' USING ERRCODE = 'P0002'; END IF;
  IF p_part IS NULL THEN
    RETURN jsonb_build_object('required', false, 'ruleId', NULL, 'ruleName', NULL, 'strategy', 'none', 'level', 'normal', 'sampleSize', NULL, 'acceptNumber', 0, 'operationCode', NULL,
                              'basis', 'This is a material, not one of our parts, so no control plan applies and no inspection is made through the engine', 'overridden', false, 'controlled', false);
  END IF;
  SELECT * INTO p FROM public.parts WHERE id = p_part AND organisation_id = s.organisation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Part not found' USING ERRCODE = 'P0002'; END IF;
  v_qty := least(greatest(ceil(coalesce(p_quantity, 1))::int, 1), 100000000);

  SELECT q.* INTO r FROM public.supplier_inspection_requirements q
  WHERE q.organisation_id = s.organisation_id AND q.status = 'approved'
    AND (q.supplier_id IS NULL OR q.supplier_id = s.id)
    AND (q.part_id IS NULL OR q.part_id = p.id)
    AND (q.part_family_id IS NULL OR q.part_family_id = p.part_family_id)
    AND (q.classification_id IS NULL OR EXISTS (SELECT 1 FROM public.supplier_classification_links l WHERE l.supplier_id = s.id AND l.classification_id = q.classification_id))
    AND (q.risk_rating IS NULL OR q.risk_rating = s.risk_rating)
  ORDER BY (CASE WHEN q.part_id IS NOT NULL THEN 100 ELSE 0 END + CASE WHEN q.part_family_id IS NOT NULL THEN 50 ELSE 0 END + CASE WHEN q.supplier_id IS NOT NULL THEN 30 ELSE 0 END
            + CASE WHEN q.classification_id IS NOT NULL THEN 20 ELSE 0 END + CASE WHEN q.risk_rating IS NOT NULL THEN 10 ELSE 0 END) DESC, q.approved_at DESC LIMIT 1;
  v_found := FOUND;
  IF NOT v_found THEN
    RETURN jsonb_build_object('required', false, 'ruleId', NULL, 'ruleName', NULL, 'strategy', 'none', 'level', 'normal', 'sampleSize', NULL, 'acceptNumber', 0, 'operationCode', NULL,
                              'basis', 'No approved inspection requirement applies to this supplier and part', 'overridden', false, 'controlled', false);
  END IF;
  v_op := r.operation_code; v_strategy := r.strategy; v_level := r.level; v_acc := r.accept_number;
  v_controlled := app.part_controlled_for_incoming(p.id, v_op, p_site);
  IF r.reduces_controls AND v_controlled THEN
    -- Controls on critical (or unresolvable) parts are never reduced by a rule.
    RETURN jsonb_build_object('required', true, 'ruleId', r.id, 'ruleName', r.name, 'strategy', 'full', 'level', 'increased', 'sampleSize', v_qty, 'acceptNumber', 0, 'operationCode', v_op,
      'basis', format('Rule "%s" would reduce inspection, but this part has a critical characteristic (or no usable control plan) at %s, so every unit is inspected', r.name, v_op), 'overridden', true, 'controlled', true);
  END IF;

  SELECT count(*)::int INTO v_prior FROM public.goods_receipt_lines x JOIN public.goods_receipts g ON g.id = x.goods_receipt_id
   WHERE g.supplier_id = s.id AND g.status = 'received' AND x.part_id = p.id AND (p_line_id IS NULL OR x.id <> p_line_id);
  IF v_strategy = 'full' THEN v_sample := v_qty; v_basis := format('Rule "%s": every unit', r.name);
  ELSIF v_strategy = 'none' THEN v_required := false; v_basis := format('Rule "%s": no incoming inspection', r.name);
  ELSIF v_strategy = 'fixed' THEN v_sample := least(r.sample_size, v_qty); v_basis := format('Rule "%s": a fixed sample of %s', r.name, r.sample_size);
  ELSIF v_strategy = 'percentage' THEN v_sample := least(v_qty, greatest(1, ceil(v_qty * r.percentage / 100)::int)); v_basis := format('Rule "%s": %s%% of the lot', r.name, r.percentage);
  ELSIF v_strategy = 'first_article' THEN
    IF v_prior = 0 THEN v_sample := least(r.sample_size, v_qty); v_basis := format('Rule "%s": first delivery of this part from this supplier, a sample of %s', r.name, r.sample_size);
    ELSE v_required := false; v_basis := format('Rule "%s": first-article inspection is done; this is delivery %s of this part', r.name, v_prior + 1); END IF;
  ELSIF v_strategy = 'skip_lot' THEN
    IF (v_prior + 1) % r.skip_every = 0 THEN v_sample := least(r.sample_size, v_qty); v_basis := format('Rule "%s": every %sth delivery is inspected, a sample of %s', r.name, r.skip_every, r.sample_size);
    ELSE v_required := false; v_basis := format('Rule "%s": skip-lot, inspecting every %sth delivery (this is delivery %s)', r.name, r.skip_every, v_prior + 1); END IF;
  ELSIF v_strategy = 'plan' THEN
    SELECT x INTO b FROM jsonb_array_elements(r.plan) x WHERE v_qty BETWEEN (x ->> 'fromQuantity')::int AND (x ->> 'toQuantity')::int;
    IF b IS NULL THEN
      v_sample := v_qty; v_acc := 0; v_overridden := true; v_basis := format('Rule "%s" has no band for a lot of %s, so every unit is inspected', r.name, v_qty);
    ELSE
      v_sample := least((b ->> 'sampleSize')::int, v_qty); v_acc := (b ->> 'acceptNumber')::int; v_basis := format('Rule "%s": the plan band for %s units', r.name, v_qty);
    END IF;
  END IF;
  RETURN jsonb_build_object('required', v_required, 'ruleId', r.id, 'ruleName', r.name, 'strategy', v_strategy, 'level', v_level, 'sampleSize', CASE WHEN v_required THEN v_sample END,
                            'acceptNumber', CASE WHEN v_required THEN v_acc ELSE 0 END, 'operationCode', CASE WHEN v_required THEN v_op END, 'basis', v_basis, 'overridden', v_overridden, 'controlled', v_controlled);
END $$;

-- The same answer for a screen, before anything is recorded (receiving.read).
CREATE FUNCTION app.preview_incoming_inspection(p_supplier uuid, p_part uuid, p_quantity numeric, p_site uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.suppliers%ROWTYPE;
BEGIN
  SELECT * INTO s FROM public.suppliers WHERE id = p_supplier;
  IF NOT FOUND OR NOT app.is_member(s.organisation_id) THEN RAISE EXCEPTION 'Supplier not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(s.organisation_id, 'receiving.read') THEN RAISE EXCEPTION 'You are not allowed to see incoming inspection' USING ERRCODE = '42501'; END IF;
  RETURN app.resolve_incoming_inspection(p_supplier, p_part, p_quantity, p_site, NULL);
END $$;

-- ---------------------------------------------------------------------------
-- Receipt: determine inspection for each line (replaces the SQ4a function; the same arguments and result)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.record_goods_receipt(p_supplier uuid, p_po uuid, p_site uuid, p_received_on date, p_delivery_note text, p_notes text, p_lines jsonb, p_client_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.suppliers%ROWTYPE; o public.purchase_orders%ROWTYPE; pl public.purchase_order_lines%ROWTYPE; v_year integer := extract(year FROM now())::int; v_n integer; v_id uuid; v_site uuid := p_site;
        l jsonb; i integer := 0; v_part uuid; v_poline uuid; v_material text; v_qty numeric; v_lot_no text; v_lot uuid; v_line uuid; d jsonb;
BEGIN
  s := app.receiving_supplier_for_write(p_supplier);
  IF p_client_key IS NOT NULL THEN
    SELECT id INTO v_id FROM public.goods_receipts WHERE organisation_id = s.organisation_id AND client_key = p_client_key;
    IF FOUND THEN
      IF (SELECT supplier_id FROM public.goods_receipts WHERE id = v_id) <> s.id THEN RAISE EXCEPTION 'That request key was used for another supplier' USING ERRCODE = 'QM021'; END IF;
      RETURN jsonb_build_object('id', v_id, 'created', false);
    END IF;
  END IF;
  IF p_received_on IS NULL OR p_received_on > current_date THEN RAISE EXCEPTION 'Say when it arrived (not in the future)' USING ERRCODE = 'QM021'; END IF;
  IF p_po IS NOT NULL THEN
    SELECT * INTO o FROM public.purchase_orders WHERE id = p_po AND organisation_id = s.organisation_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Purchase order not found' USING ERRCODE = 'P0002'; END IF;
    IF o.supplier_id <> s.id THEN RAISE EXCEPTION 'That purchase order is for another supplier' USING ERRCODE = 'QM021'; END IF;
    IF o.status <> 'open' THEN RAISE EXCEPTION 'That purchase order is %', o.status USING ERRCODE = 'QM021'; END IF;
  END IF;
  IF v_site IS NULL THEN
    IF (SELECT count(*) FROM public.sites WHERE organisation_id = s.organisation_id AND active) = 1 THEN SELECT id INTO v_site FROM public.sites WHERE organisation_id = s.organisation_id AND active; END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM public.sites WHERE id = v_site AND organisation_id = s.organisation_id) THEN RAISE EXCEPTION 'Site not found' USING ERRCODE = 'P0002';
  END IF;
  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR jsonb_array_length(p_lines) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'A receipt needs between 1 and 100 lines' USING ERRCODE = 'QM021'; END IF;
  INSERT INTO app.goods_receipt_counters AS k (organisation_id, year, last_value) VALUES (s.organisation_id, v_year, 1)
  ON CONFLICT (organisation_id, year) DO UPDATE SET last_value = k.last_value + 1 RETURNING last_value INTO v_n;
  INSERT INTO public.goods_receipts (organisation_id, reference, supplier_id, purchase_order_id, site_id, received_on, delivery_note, notes, client_key)
  VALUES (s.organisation_id, 'GR-' || to_char(make_date(v_year, 1, 1), 'YY') || '-' || lpad(v_n::text, 4, '0'), s.id, p_po, v_site, p_received_on,
          nullif(btrim(coalesce(p_delivery_note, '')), ''), nullif(btrim(coalesce(p_notes, '')), ''), p_client_key) RETURNING id INTO v_id;
  FOR l IN SELECT x FROM jsonb_array_elements(p_lines) x LOOP
    i := i + 1;
    IF jsonb_typeof(l) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(l) k WHERE k NOT IN ('poLineId', 'partId', 'material', 'quantity', 'lotNumber', 'notes')) THEN RAISE EXCEPTION 'Line %: unknown field', i USING ERRCODE = 'QM021'; END IF;
    v_poline := nullif(l ->> 'poLineId', '')::uuid; v_part := nullif(l ->> 'partId', '')::uuid; v_material := nullif(btrim(coalesce(l ->> 'material', '')), ''); v_lot_no := nullif(btrim(coalesce(l ->> 'lotNumber', '')), '');
    IF coalesce(l ->> 'quantity', '') !~ '^[0-9]+(\.[0-9]{1,3})?$' OR (l ->> 'quantity')::numeric <= 0 THEN RAISE EXCEPTION 'Line %: the quantity is a number above zero', i USING ERRCODE = 'QM021'; END IF;
    v_qty := (l ->> 'quantity')::numeric;
    IF v_poline IS NOT NULL THEN
      SELECT * INTO pl FROM public.purchase_order_lines WHERE id = v_poline AND organisation_id = s.organisation_id;
      IF NOT FOUND OR p_po IS NULL OR pl.purchase_order_id <> p_po THEN RAISE EXCEPTION 'Line %: that order line is not on this purchase order', i USING ERRCODE = 'QM021'; END IF;
      IF pl.status <> 'open' THEN RAISE EXCEPTION 'Line %: that order line is %', i, pl.status USING ERRCODE = 'QM021'; END IF;
      IF v_part IS NOT NULL AND pl.part_id IS DISTINCT FROM v_part THEN RAISE EXCEPTION 'Line %: that is not the part on the order line', i USING ERRCODE = 'QM021'; END IF;
      v_part := coalesce(v_part, pl.part_id);
      v_material := coalesce(v_material, pl.material);
    END IF;
    IF v_part IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.parts WHERE id = v_part AND organisation_id = s.organisation_id) THEN RAISE EXCEPTION 'Line %: part not found', i USING ERRCODE = 'P0002'; END IF;
    IF v_part IS NULL AND v_material IS NULL THEN RAISE EXCEPTION 'Line %: name a part, a material or an order line', i USING ERRCODE = 'QM021'; END IF;
    v_lot := NULL;
    IF v_lot_no IS NOT NULL THEN
      IF v_part IS NULL THEN RAISE EXCEPTION 'Line %: a lot is of a part, so name the part', i USING ERRCODE = 'QM021'; END IF;
      IF v_lot_no !~ '^\S(.{0,58}\S)?$' THEN RAISE EXCEPTION 'Line %: the lot number is up to 60 characters', i USING ERRCODE = 'QM021'; END IF;
      IF EXISTS (SELECT 1 FROM public.lots WHERE organisation_id = s.organisation_id AND part_id = v_part AND upper(lot_number) = upper(v_lot_no)) THEN
        RAISE EXCEPTION 'Line %: lot % already exists for that part', i, v_lot_no USING ERRCODE = 'QM021';
      END IF;
      INSERT INTO public.lots (organisation_id, lot_number, part_id, origin, supplier_id, site_id, quantity, received_on) VALUES (s.organisation_id, v_lot_no, v_part, 'received', s.id, v_site, v_qty, p_received_on) RETURNING id INTO v_lot;
    END IF;
    INSERT INTO public.goods_receipt_lines (organisation_id, goods_receipt_id, line_number, po_line_id, part_id, material, quantity_received, lot_id, notes)
    VALUES (s.organisation_id, v_id, i, v_poline, v_part, v_material, v_qty, v_lot, nullif(btrim(coalesce(l ->> 'notes', '')), '')) RETURNING id INTO v_line;
    -- What the approved rules say for this line, kept as it was decided. A line that needs inspection holds its lot until it is dispositioned.
    d := app.resolve_incoming_inspection(s.id, v_part, v_qty, v_site, v_line);
    INSERT INTO public.incoming_inspection_determinations (organisation_id, receipt_line_id, rule_id, rule_name, strategy, level, required, sample_size, accept_number, operation_code, basis, overridden)
    VALUES (s.organisation_id, v_line, nullif(d ->> 'ruleId', '')::uuid, d ->> 'ruleName', d ->> 'strategy', d ->> 'level', (d ->> 'required')::boolean, nullif(d ->> 'sampleSize', '')::int,
            coalesce((d ->> 'acceptNumber')::int, 0), d ->> 'operationCode', d ->> 'basis', (d ->> 'overridden')::boolean);
    IF v_lot IS NOT NULL AND (d ->> 'required')::boolean THEN
      UPDATE public.lots SET status = 'on_hold', status_reason = 'Awaiting incoming inspection (' || (SELECT reference FROM public.goods_receipts WHERE id = v_id) || ')' WHERE id = v_lot;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('id', v_id, 'created', true);
END $$;

-- ---------------------------------------------------------------------------
-- Inspecting
-- ---------------------------------------------------------------------------
-- Start the incoming inspection of a receipt line through the shared engine (trigger 'incoming'; the lot number and size are carried on the record). Needs inspection.record at the site.
CREATE FUNCTION app.start_incoming_inspection(p_line uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE x public.goods_receipt_lines%ROWTYPE; g public.goods_receipts%ROWTYPE; d public.incoming_inspection_determinations%ROWTYPE; v_site uuid; v_lot text; v_insp uuid;
BEGIN
  SELECT * INTO x FROM public.goods_receipt_lines WHERE id = p_line;
  IF NOT FOUND OR NOT app.is_member(x.organisation_id) THEN RAISE EXCEPTION 'Receipt line not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO g FROM public.goods_receipts WHERE id = x.goods_receipt_id;
  SELECT * INTO d FROM public.incoming_inspection_determinations WHERE receipt_line_id = x.id;
  IF g.status <> 'received' THEN RAISE EXCEPTION 'That receipt is cancelled' USING ERRCODE = 'QM021'; END IF;
  IF NOT FOUND OR NOT d.required THEN RAISE EXCEPTION 'The inspection requirements do not call for an inspection of this line' USING ERRCODE = 'QM021'; END IF;
  IF EXISTS (SELECT 1 FROM public.incoming_inspections WHERE receipt_line_id = x.id) THEN RAISE EXCEPTION 'This line already has an incoming inspection' USING ERRCODE = 'QM021'; END IF;
  IF EXISTS (SELECT 1 FROM public.receipt_line_dispositions WHERE receipt_line_id = x.id AND decision IN ('accepted', 'rejected', 'conditional')) THEN RAISE EXCEPTION 'This line has already been decided' USING ERRCODE = 'QM021'; END IF;
  v_site := g.site_id;
  IF v_site IS NULL THEN RAISE EXCEPTION 'Record the site the delivery arrived at before inspecting it' USING ERRCODE = 'QM021'; END IF;
  SELECT lot_number INTO v_lot FROM public.lots WHERE id = x.lot_id;
  v_insp := app.start_inspection(v_site, x.part_id, d.operation_code, NULL, NULL, v_lot, NULL, 'incoming', NULL,
                                 format('Incoming inspection of %s (%s): %s', g.reference, coalesce(g.delivery_note, 'no delivery note'), d.basis), least(ceil(x.quantity_received)::int, 100000000));
  INSERT INTO public.incoming_inspections (organisation_id, receipt_line_id, inspection_record_id) VALUES (x.organisation_id, x.id, v_insp);
  RETURN v_insp;
END $$;

-- Where an inspection of a line stands against what was required: samples taken, samples with a failing reading (current readings only), and whether the line is acceptable on that evidence.
CREATE FUNCTION app.incoming_inspection_assessment(p_line uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE x public.goods_receipt_lines%ROWTYPE; d public.incoming_inspection_determinations%ROWTYPE; i public.inspection_records%ROWTYPE; v_samples integer := 0; v_failed integer := 0; v_outcome text; v_state text;
BEGIN
  SELECT * INTO x FROM public.goods_receipt_lines WHERE id = p_line;
  IF NOT FOUND OR NOT app.is_member(x.organisation_id) THEN RAISE EXCEPTION 'Receipt line not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(x.organisation_id, 'receiving.read') THEN RAISE EXCEPTION 'You are not allowed to see incoming inspection' USING ERRCODE = '42501'; END IF;
  SELECT * INTO d FROM public.incoming_inspection_determinations WHERE receipt_line_id = x.id;
  IF NOT FOUND OR NOT d.required THEN
    RETURN jsonb_build_object('state', 'not_required', 'required', false, 'samples', 0, 'failedSamples', 0, 'requiredSamples', NULL, 'acceptNumber', 0, 'outcome', 'acceptable');
  END IF;
  SELECT r.* INTO i FROM public.incoming_inspections n JOIN public.inspection_records r ON r.id = n.inspection_record_id WHERE n.receipt_line_id = x.id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'not_started', 'required', true, 'samples', 0, 'failedSamples', 0, 'requiredSamples', d.sample_size, 'acceptNumber', d.accept_number, 'outcome', 'incomplete');
  END IF;
  SELECT count(*) INTO v_samples FROM public.inspection_samples s WHERE s.inspection_record_id = i.id AND NOT s.is_retest;
  SELECT count(DISTINCT m.sample_id) INTO v_failed FROM public.inspection_measurements m
   WHERE m.inspection_record_id = i.id AND m.result = 'fail' AND NOT EXISTS (SELECT 1 FROM public.inspection_measurements c WHERE c.supersedes_id = m.id);
  v_state := i.status;
  v_outcome := CASE WHEN i.status <> 'completed' THEN 'incomplete' WHEN v_samples < d.sample_size THEN 'incomplete' WHEN v_failed <= d.accept_number THEN 'acceptable' ELSE 'not_acceptable' END;
  RETURN jsonb_build_object('state', v_state, 'required', true, 'inspectionId', i.id, 'inspectionReference', i.reference, 'samples', v_samples, 'failedSamples', v_failed,
                            'requiredSamples', d.sample_size, 'acceptNumber', d.accept_number, 'outcome', v_outcome);
END $$;

-- ---------------------------------------------------------------------------
-- Deciding
-- ---------------------------------------------------------------------------
-- held / accepted / rejected / conditional. Accepting a line that needed inspection needs an acceptable assessment; conditional needs supplier_quality.approve and conditions;
-- leaving "rejected" needs supplier_quality.approve. Accepting or conditionally accepting releases the lot; holding or rejecting keeps it on hold.
CREATE FUNCTION app.disposition_receipt_line(p_line uuid, p_decision text, p_reason text, p_conditions text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE x public.goods_receipt_lines%ROWTYPE; g public.goods_receipts%ROWTYPE; v_current text; v_assess jsonb; v_id uuid; v_reason text := nullif(btrim(coalesce(p_reason, '')), ''); v_cond text := nullif(btrim(coalesce(p_conditions, '')), '');
        lt public.lots%ROWTYPE;
BEGIN
  SELECT * INTO x FROM public.goods_receipt_lines WHERE id = p_line;
  IF NOT FOUND OR NOT app.is_member(x.organisation_id) THEN RAISE EXCEPTION 'Receipt line not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(x.organisation_id, 'receiving.manage') THEN RAISE EXCEPTION 'You are not allowed to decide what happens to received goods' USING ERRCODE = '42501'; END IF;
  SELECT * INTO g FROM public.goods_receipts WHERE id = x.goods_receipt_id FOR UPDATE;
  IF g.status <> 'received' THEN RAISE EXCEPTION 'That receipt is cancelled' USING ERRCODE = 'QM021'; END IF;
  IF p_decision NOT IN ('held', 'accepted', 'rejected', 'conditional') THEN RAISE EXCEPTION 'Decide held, accepted, rejected or conditional' USING ERRCODE = 'QM021'; END IF;
  IF p_decision <> 'accepted' AND (v_reason IS NULL OR length(v_reason) < 3) THEN RAISE EXCEPTION 'Say why (3 to 1000 characters)' USING ERRCODE = 'QM021'; END IF;
  IF p_decision <> 'conditional' AND v_cond IS NOT NULL THEN RAISE EXCEPTION 'Conditions belong to a conditional acceptance' USING ERRCODE = 'QM021'; END IF;
  SELECT decision INTO v_current FROM public.receipt_line_dispositions WHERE receipt_line_id = x.id ORDER BY decided_at DESC, id DESC LIMIT 1;
  IF v_current IS NOT DISTINCT FROM p_decision THEN RAISE EXCEPTION 'That line is already %', p_decision USING ERRCODE = 'QM021'; END IF;
  IF v_current = 'rejected' AND NOT app.has_permission(x.organisation_id, 'supplier_quality.approve') THEN
    RAISE EXCEPTION 'Only an approver can change a rejection' USING ERRCODE = '42501';
  END IF;
  IF p_decision = 'conditional' THEN
    IF NOT app.has_permission(x.organisation_id, 'supplier_quality.approve') THEN RAISE EXCEPTION 'Only an approver can accept goods conditionally' USING ERRCODE = '42501'; END IF;
    IF v_cond IS NULL THEN RAISE EXCEPTION 'State the conditions of the acceptance' USING ERRCODE = 'QM021'; END IF;
  END IF;
  IF p_decision = 'accepted' THEN
    v_assess := app.incoming_inspection_assessment(x.id);
    IF (v_assess ->> 'required')::boolean AND v_assess ->> 'outcome' <> 'acceptable' THEN
      RAISE EXCEPTION 'Inspection is required and the evidence does not support acceptance yet (%): reject, hold or accept conditionally instead',
        CASE v_assess ->> 'state' WHEN 'not_started' THEN 'it has not been started' WHEN 'in_progress' THEN 'it is not complete' ELSE format('%s of %s samples, %s failed, %s allowed', v_assess ->> 'samples', v_assess ->> 'requiredSamples', v_assess ->> 'failedSamples', v_assess ->> 'acceptNumber') END
        USING ERRCODE = 'QM021';
    END IF;
  END IF;
  INSERT INTO public.receipt_line_dispositions (organisation_id, receipt_line_id, decision, reason, conditions) VALUES (x.organisation_id, x.id, p_decision, v_reason, v_cond) RETURNING id INTO v_id;
  IF x.lot_id IS NOT NULL THEN
    SELECT * INTO lt FROM public.lots WHERE id = x.lot_id FOR UPDATE;
    IF lt.status <> 'closed' THEN
      IF p_decision IN ('accepted', 'conditional') AND lt.status = 'on_hold' THEN
        UPDATE public.lots SET status = 'released', status_reason = NULL WHERE id = lt.id;
      ELSIF p_decision IN ('held', 'rejected') AND lt.status <> 'on_hold' THEN
        UPDATE public.lots SET status = 'on_hold', status_reason = left(CASE p_decision WHEN 'rejected' THEN 'Rejected at goods receipt: ' ELSE 'Held at goods receipt: ' END || v_reason, 1000) WHERE id = lt.id;
      END IF;
    END IF;
  END IF;
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------
-- A non-conformance from a receipt line (needs ncr.create). Idempotent: a live NC already raised from the line is returned. Draft unless a category is given (then open).
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.raise_ncr_from_receipt_line(p_line uuid, p_title text, p_description text, p_severity text, p_category uuid, p_quantity numeric) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE x public.goods_receipt_lines%ROWTYPE; g public.goods_receipts%ROWTYPE; o public.purchase_orders%ROWTYPE; lt public.lots%ROWTYPE; v_ncr uuid; v_sev text := coalesce(p_severity, 'major'); v_title text := nullif(btrim(coalesce(p_title, '')), '');
        v_qty numeric := coalesce(p_quantity, NULL); v_ref text;
BEGIN
  SELECT * INTO x FROM public.goods_receipt_lines WHERE id = p_line FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(x.organisation_id) THEN RAISE EXCEPTION 'Receipt line not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(x.organisation_id, 'ncr.create') THEN RAISE EXCEPTION 'You are not allowed to raise non-conformances' USING ERRCODE = '42501'; END IF;
  SELECT * INTO g FROM public.goods_receipts WHERE id = x.goods_receipt_id;
  IF g.status <> 'received' THEN RAISE EXCEPTION 'That receipt is cancelled' USING ERRCODE = 'QM021'; END IF;
  SELECT l.ncr_id INTO v_ncr FROM public.receipt_line_ncrs l JOIN public.nonconformances n ON n.id = l.ncr_id WHERE l.receipt_line_id = x.id AND n.deleted_at IS NULL AND n.stage <> 'cancelled' ORDER BY l.linked_at LIMIT 1;
  IF FOUND THEN RETURN jsonb_build_object('nonconformanceId', v_ncr, 'created', false); END IF;
  IF v_sev NOT IN ('minor', 'major', 'critical') THEN RAISE EXCEPTION 'Severity is minor, major or critical' USING ERRCODE = 'QM021'; END IF;
  IF v_qty IS NOT NULL AND (v_qty <= 0 OR v_qty > x.quantity_received) THEN RAISE EXCEPTION 'The quantity affected is above zero and no more than was received' USING ERRCODE = 'QM021'; END IF;
  IF p_category IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.ncr_classifications WHERE id = p_category AND organisation_id = x.organisation_id AND kind = 'category' AND active) THEN
    RAISE EXCEPTION 'Category not found' USING ERRCODE = 'P0002';
  END IF;
  IF g.purchase_order_id IS NOT NULL THEN SELECT * INTO o FROM public.purchase_orders WHERE id = g.purchase_order_id; END IF;
  IF x.lot_id IS NOT NULL THEN SELECT * INTO lt FROM public.lots WHERE id = x.lot_id; END IF;
  v_title := coalesce(v_title, left('Goods receiving: ' || g.reference || coalesce(' / ' || lt.lot_number, ''), 200));
  INSERT INTO public.nonconformances (organisation_id, reference, source, stage, severity, title, description, part_id, supplier_id, lot_id, lot_number, quantity_affected, purchase_order, site_id, detected_at, detected_by, category_id)
  VALUES (x.organisation_id, 'pending', 'goods_receiving', CASE WHEN p_category IS NOT NULL THEN 'open' ELSE 'draft' END, v_sev, left(v_title, 200),
          coalesce(nullif(btrim(coalesce(p_description, '')), ''), format('Raised from goods receipt %s (delivery note %s).', g.reference, coalesce(g.delivery_note, 'none'))),
          x.part_id, g.supplier_id, x.lot_id, lt.lot_number, coalesce(v_qty, x.quantity_received), o.po_number, g.site_id, g.received_on, auth.uid(), p_category)
  RETURNING id INTO v_ncr;
  INSERT INTO public.receipt_line_ncrs (organisation_id, receipt_line_id, ncr_id) VALUES (x.organisation_id, x.id, v_ncr);
  RETURN jsonb_build_object('nonconformanceId', v_ncr, 'created', true);
END $$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app.incoming_frozen(), app.requirement_frozen(), app.inspection_plan_problem(jsonb), app.part_controlled_for_incoming(uuid, text, uuid), app.resolve_incoming_inspection(uuid, uuid, numeric, uuid, uuid) FROM PUBLIC, anon, authenticated;
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['save_inspection_requirement(uuid,uuid,jsonb)', 'approve_inspection_requirement(uuid,text)', 'retire_inspection_requirement(uuid,text)', 'preview_incoming_inspection(uuid,uuid,numeric,uuid)',
    'record_goods_receipt(uuid,uuid,uuid,date,text,text,jsonb,text)', 'start_incoming_inspection(uuid)', 'incoming_inspection_assessment(uuid)', 'disposition_receipt_line(uuid,text,text,text)',
    'raise_ncr_from_receipt_line(uuid,text,text,text,uuid,numeric)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION app.%s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION app.%s TO authenticated', f);
  END LOOP;
END $$;
