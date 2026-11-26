-- PPAP PP6a: a PPAP can be started from a record that suggests one (a released part revision, an approved change, a control plan revision), and the reason is kept (plan PP13).
-- Where it came from is set once and never changed (the trigger holds it for SQL too). Nothing is started silently: the suggestion saves nothing, a person chooses.
--
-- Needs PP1 to PP5 first. Written so it can be run again: columns and constraints are guarded and functions are replaced.

-- ---------------------------------------------------------------------------
-- 1. Where it came from
-- ---------------------------------------------------------------------------
ALTER TABLE public.ppap_submissions ADD COLUMN IF NOT EXISTS origin_kind text;
ALTER TABLE public.ppap_submissions ADD COLUMN IF NOT EXISTS origin_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ppap_submissions_origin_kind_check') THEN
    ALTER TABLE public.ppap_submissions ADD CONSTRAINT ppap_submissions_origin_kind_check CHECK (origin_kind IS NULL OR origin_kind IN ('part_revision', 'change', 'control_plan_revision'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ppap_submissions_origin_state') THEN
    ALTER TABLE public.ppap_submissions ADD CONSTRAINT ppap_submissions_origin_state CHECK ((origin_kind IS NULL) = (origin_id IS NULL));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS ppap_submissions_origin_idx ON public.ppap_submissions (organisation_id, origin_kind, origin_id) WHERE origin_id IS NOT NULL;

-- Set once, by app.set_ppap_origin, and never changed afterwards (SQL included).
CREATE OR REPLACE FUNCTION app.ppap_origin_fixed() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF OLD.origin_kind IS NOT NULL THEN
    IF NEW.origin_kind IS DISTINCT FROM OLD.origin_kind OR NEW.origin_id IS DISTINCT FROM OLD.origin_id THEN
      RAISE EXCEPTION 'Where a PPAP was raised from never changes' USING ERRCODE = 'QM037';
    END IF;
  ELSIF NEW.origin_kind IS NOT NULL AND coalesce(current_setting('app.ppap_origin', true), '') <> 'on' THEN
    RAISE EXCEPTION 'Where a PPAP was raised from is set when it is raised, not edited' USING ERRCODE = 'QM037';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS ppap_submissions_origin_fixed ON public.ppap_submissions;
CREATE TRIGGER ppap_submissions_origin_fixed BEFORE UPDATE OF origin_kind, origin_id ON public.ppap_submissions FOR EACH ROW EXECUTE FUNCTION app.ppap_origin_fixed();

-- ---------------------------------------------------------------------------
-- 2. Can the caller read the record it would be raised from? (its organisation, or NULL)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.ppap_source_org(p_kind text, p_id uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid;
BEGIN
  IF p_kind = 'part_revision' THEN
    SELECT organisation_id INTO v_org FROM public.part_revisions WHERE id = p_id;
    RETURN CASE WHEN v_org IS NOT NULL AND app.has_permission(v_org, 'master_data.read') THEN v_org END;
  ELSIF p_kind = 'change' THEN
    SELECT organisation_id INTO v_org FROM public.change_requests WHERE id = p_id;
    RETURN CASE WHEN v_org IS NOT NULL AND app.has_permission(v_org, 'change.read') THEN v_org END;
  ELSIF p_kind = 'control_plan_revision' THEN
    SELECT organisation_id INTO v_org FROM public.control_plan_revisions WHERE id = p_id;
    RETURN CASE WHEN v_org IS NOT NULL AND app.has_permission(v_org, 'process_control.read') THEN v_org END;
  END IF;
  RETURN NULL;
END $$;


-- The parts a record is about, for the suggestion and for the prompts: a part revision names its part; a change names the parts it links and the parts of the families it links; a control plan
-- revision names the parts its plan applies to (a family means the family's parts). At most 20. Nothing when the caller cannot read the record.
CREATE OR REPLACE FUNCTION app.ppap_source_parts(p_kind text, p_id uuid) RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_parts uuid[] := '{}';
BEGIN
  IF app.ppap_source_org(p_kind, p_id) IS NULL THEN RETURN '{}'; END IF;
  IF p_kind = 'part_revision' THEN
    SELECT ARRAY[part_id] INTO v_parts FROM public.part_revisions WHERE id = p_id;
  ELSIF p_kind = 'change' THEN
    SELECT coalesce(array_agg(DISTINCT x), '{}') INTO v_parts FROM (
      SELECT l.part_id AS x FROM public.change_links l WHERE l.change_id = p_id AND l.kind = 'part' AND l.part_id IS NOT NULL
      UNION SELECT p.id FROM public.change_links l JOIN public.parts p ON p.part_family_id = l.part_family_id AND p.organisation_id = l.organisation_id WHERE l.change_id = p_id AND l.kind = 'part_family'
    ) s;
  ELSIF p_kind = 'control_plan_revision' THEN
    SELECT coalesce(array_agg(DISTINCT x), '{}') INTO v_parts FROM (
      SELECT a.part_id AS x FROM public.control_plan_applicability a JOIN public.control_plan_revisions r ON r.control_plan_id = a.control_plan_id WHERE r.id = p_id AND a.part_id IS NOT NULL
      UNION SELECT p.id FROM public.control_plan_applicability a JOIN public.control_plan_revisions r ON r.control_plan_id = a.control_plan_id
              JOIN public.parts p ON p.part_family_id = a.part_family_id AND p.organisation_id = a.organisation_id WHERE r.id = p_id AND a.part_id IS NULL
    ) s;
  END IF;
  IF cardinality(v_parts) > 20 THEN v_parts := v_parts[1:20]; END IF;
  RETURN v_parts;
END $$;

-- ---------------------------------------------------------------------------
-- 3. What a record suggests for a PPAP raised from it: nothing is saved, the person chooses
-- ---------------------------------------------------------------------------
-- { partId, partRevisionId, customerId, customers [{id, code, name}], parts [{id, partNumber, name}], reason, notes, source {kind, id, reference, title} }.
-- partId is set only when the record names exactly one part; with several, `parts` lists them and the person picks. The revision is the part's released one.
CREATE OR REPLACE FUNCTION app.ppap_draft_from(p_kind text, p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_org uuid := app.ppap_source_org(p_kind, p_id);
  v_ref text; v_title text; v_reason text := 'other'; v_parts uuid[] := '{}'; v_part uuid; v_rev uuid; v_cust uuid; v_change_customer uuid;
  v_customers jsonb := '[]'::jsonb; v_part_list jsonb := '[]'::jsonb; v_type text; v_first boolean; v_ver integer;
BEGIN
  IF v_org IS NULL OR NOT app.has_permission(v_org, 'ppap.manage') THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;

  IF p_kind = 'part_revision' THEN
    SELECT r.version, p.part_number || ' rev ' || r.revision || CASE WHEN r.version > 1 THEN ' v' || r.version ELSE '' END, p.name
      INTO v_ver, v_ref, v_title FROM public.part_revisions r JOIN public.parts p ON p.id = r.part_id WHERE r.id = p_id;
    v_rev := p_id;
    SELECT NOT EXISTS (SELECT 1 FROM public.part_revisions x, public.part_revisions me WHERE me.id = p_id AND x.part_id = me.part_id AND x.id <> p_id AND (x.created_at, x.revision) < (me.created_at, me.revision)) INTO v_first;
    v_reason := CASE WHEN v_ver > 1 THEN 'discrepancy_correction' WHEN v_first THEN 'new_part' ELSE 'engineering_change' END;
  ELSIF p_kind = 'change' THEN
    SELECT c.reference, c.title, t.key INTO v_ref, v_title, v_type FROM public.change_requests c LEFT JOIN public.change_types t ON t.id = c.type_id WHERE c.id = p_id;
    v_reason := CASE v_type WHEN 'product_design' THEN 'engineering_change' WHEN 'process' THEN 'process_change' WHEN 'tooling' THEN 'tooling' WHEN 'material' THEN 'alternate_material_or_supplier' ELSE 'other' END;
    SELECT l.customer_id INTO v_change_customer FROM public.change_links l WHERE l.change_id = p_id AND l.kind = 'customer' AND l.customer_id IS NOT NULL ORDER BY l.created_at LIMIT 1;
  ELSIF p_kind = 'control_plan_revision' THEN
    SELECT p.plan_code || ' rev ' || r.revision_code, p.title INTO v_ref, v_title FROM public.control_plan_revisions r JOIN public.control_plans p ON p.id = r.control_plan_id WHERE r.id = p_id;
    v_reason := 'process_change';
  END IF;

  v_parts := app.ppap_source_parts(p_kind, p_id);
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'partNumber', p.part_number, 'name', p.name) ORDER BY p.part_number), '[]'::jsonb) INTO v_part_list FROM public.parts p WHERE p.id = ANY (v_parts);
  IF cardinality(v_parts) = 1 THEN
    v_part := v_parts[1];
    IF p_kind <> 'part_revision' THEN SELECT id INTO v_rev FROM public.part_revisions WHERE part_id = v_part AND status = 'released' LIMIT 1; END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'code', c.code, 'name', c.name) ORDER BY pc.is_primary DESC, c.name), '[]'::jsonb) INTO v_customers
      FROM public.part_customers pc JOIN public.customers c ON c.id = pc.customer_id WHERE pc.part_id = v_part;
    IF v_change_customer IS NOT NULL AND EXISTS (SELECT 1 FROM public.part_customers WHERE part_id = v_part AND customer_id = v_change_customer) THEN v_cust := v_change_customer;
    ELSIF jsonb_array_length(v_customers) = 1 THEN v_cust := (v_customers -> 0 ->> 'id')::uuid;
    ELSE SELECT customer_id INTO v_cust FROM public.part_customers WHERE part_id = v_part AND is_primary LIMIT 1; END IF;
  END IF;

  RETURN jsonb_build_object(
    'partId', v_part, 'partRevisionId', v_rev, 'customerId', v_cust, 'customers', v_customers, 'parts', v_part_list, 'reason', v_reason,
    'notes', left('Raised from ' || CASE p_kind WHEN 'part_revision' THEN 'part revision' WHEN 'change' THEN 'change' ELSE 'control plan revision' END || ' ' || v_ref || ': ' || v_title, 2000),
    'source', jsonb_build_object('kind', p_kind, 'id', p_id, 'reference', v_ref, 'title', v_title));
END $$;

-- ---------------------------------------------------------------------------
-- 4. Record where a PPAP was raised from (once, on the one just made)
-- ---------------------------------------------------------------------------
-- ppap.manage, the caller must be able to read the record, and the PPAP must still be one being prepared.
CREATE OR REPLACE FUNCTION app.set_ppap_origin(p_submission uuid, p_kind text, p_source uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid; v_status text; v_has text;
BEGIN
  SELECT organisation_id, status, origin_kind INTO v_org, v_status, v_has FROM public.ppap_submissions WHERE id = p_submission;
  IF v_org IS NULL OR NOT app.has_permission(v_org, 'ppap.manage') THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
  IF p_kind NOT IN ('part_revision', 'change', 'control_plan_revision') THEN RAISE EXCEPTION 'That kind of record cannot be the reason for a PPAP' USING ERRCODE = 'QM037'; END IF;
  IF app.ppap_source_org(p_kind, p_source) IS DISTINCT FROM v_org THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
  IF v_has IS NOT NULL THEN RAISE EXCEPTION 'It already says where it was raised from, and that never changes' USING ERRCODE = 'QM037'; END IF;
  IF v_status NOT IN ('draft', 'in_preparation') THEN RAISE EXCEPTION 'Say why while the PPAP is still being prepared' USING ERRCODE = 'QM037'; END IF;
  PERFORM set_config('app.ppap_origin', 'on', true);
  UPDATE public.ppap_submissions SET origin_kind = p_kind, origin_id = p_source WHERE id = p_submission;
  PERFORM set_config('app.ppap_origin', 'off', true);
END $$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app.ppap_origin_fixed() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.ppap_source_org(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.ppap_source_parts(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.ppap_source_parts(text, uuid) TO authenticated;
REVOKE ALL ON FUNCTION app.ppap_draft_from(text, uuid), app.set_ppap_origin(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.ppap_draft_from(text, uuid), app.set_ppap_origin(uuid, text, uuid) TO authenticated;
