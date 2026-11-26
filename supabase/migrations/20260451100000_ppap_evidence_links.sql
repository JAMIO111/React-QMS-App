-- PPAP, slice PP2 (docs/ppap-plan.md): evidence that is a LINK to a record Fortress already holds, with the record's live state, and the freezing that submitting (PP3) will use.
--
--  * ppap_evidence gains kind 'link': target_kind + target_id (a part revision, a control plan revision, an FMEA revision, a change, an inspection, a gauge R&R study, a material
--    certificate, a calibration, a controlled document revision, a gauge, or a control plan characteristic for an initial process study). A file keeps its path, name and size; a link has none.
--  * Which kinds can be evidence for which of the 18 elements is one function (app.ppap_link_kinds). Adding a link needs the caller to be able to READ the record, the record to be in the
--    same organisation, and (for the records that belong to one part) to be for the submission's part. A design FMEA is the evidence of element 4 and a process FMEA of element 6.
--  * The live state of a link (app.ppap_link_state) is the record's own status worked out now: in force, approved, passed, accepted, in date ... or why not. It is read as the caller: a record
--    the caller cannot read answers available = false, never a blank pass. A link whose record is not in good standing is a line in "still needed" (app.ppap_problems, replaced).
--  * Freezing: app.ppap_freeze_links(submission) (internal; PP3's submit calls it) records for every live link the record's label, status, version and a fingerprint of its content, once.
--    After that the link's live fingerprint is compared with the frozen one: "changed since submission", shown, never silent. The frozen columns never change again, even for SQL.
--  * Capability (Cp / Cpk / Pp / Ppk against the agreed minimums) is statistics, worked out by the API from the readings; the database holds the link and the count of readings.

-- ---------------------------------------------------------------------------
-- 1. The evidence table: files and links
-- ---------------------------------------------------------------------------
ALTER TABLE public.ppap_evidence DROP CONSTRAINT IF EXISTS ppap_evidence_kind_check;
ALTER TABLE public.ppap_evidence ALTER COLUMN storage_path DROP NOT NULL;
ALTER TABLE public.ppap_evidence ALTER COLUMN file_name DROP NOT NULL;
ALTER TABLE public.ppap_evidence ALTER COLUMN size_bytes DROP NOT NULL;
ALTER TABLE public.ppap_evidence
  ADD COLUMN target_kind text CHECK (target_kind IS NULL OR target_kind IN ('part_revision', 'control_plan_revision', 'fmea_revision', 'change_request', 'inspection', 'msa_study',
                                                                              'material_certificate', 'calibration', 'document_revision', 'gauge', 'plan_characteristic')),
  ADD COLUMN target_id uuid,
  ADD COLUMN frozen_at timestamptz,
  ADD COLUMN frozen_label text,
  ADD COLUMN frozen_status text,
  ADD COLUMN frozen_version text,
  ADD COLUMN frozen_fingerprint text;
ALTER TABLE public.ppap_evidence
  ADD CONSTRAINT ppap_evidence_kind_check CHECK (kind IN ('file', 'link')),
  ADD CONSTRAINT ppap_evidence_shape_check CHECK (
    (kind = 'file' AND storage_path IS NOT NULL AND file_name IS NOT NULL AND size_bytes IS NOT NULL AND target_kind IS NULL AND target_id IS NULL AND frozen_at IS NULL)
    OR (kind = 'link' AND storage_path IS NULL AND file_name IS NULL AND size_bytes IS NULL AND content_type IS NULL AND target_kind IS NOT NULL AND target_id IS NOT NULL)),
  ADD CONSTRAINT ppap_evidence_frozen_check CHECK (
    (frozen_at IS NULL AND frozen_label IS NULL AND frozen_status IS NULL AND frozen_version IS NULL AND frozen_fingerprint IS NULL)
    OR (frozen_at IS NOT NULL AND frozen_label IS NOT NULL AND frozen_status IS NOT NULL AND frozen_fingerprint IS NOT NULL));
-- One live link to a record per element.
CREATE UNIQUE INDEX ppap_evidence_link_key ON public.ppap_evidence (element_id, target_kind, target_id) WHERE kind = 'link' AND removed_at IS NULL;
CREATE INDEX ppap_evidence_target_idx ON public.ppap_evidence (organisation_id, target_kind, target_id) WHERE kind = 'link';

-- Evidence is added only while the submission is being prepared, is never deleted, and can only be removed (once, with a reason). The one other change is freezing a link when the
-- submission is submitted, inside app.ppap_freeze_links (a transaction setting), once, touching nothing but the frozen columns.
CREATE OR REPLACE FUNCTION app.ppap_evidence_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Evidence is never deleted. Remove it with a reason.' USING ERRCODE = 'QM037'; END IF;
  IF TG_OP = 'UPDATE' AND current_setting('app.ppap_freezing', true) = 'on' THEN
    IF OLD.frozen_at IS NOT NULL OR OLD.kind <> 'link' OR OLD.removed_at IS NOT NULL
       OR (to_jsonb(NEW) - 'frozen_at' - 'frozen_label' - 'frozen_status' - 'frozen_version' - 'frozen_fingerprint' - 'updated_at' - 'updated_by')
          IS DISTINCT FROM (to_jsonb(OLD) - 'frozen_at' - 'frozen_label' - 'frozen_status' - 'frozen_version' - 'frozen_fingerprint' - 'updated_at' - 'updated_by') THEN
      RAISE EXCEPTION 'A link is frozen once, and nothing else about it changes then' USING ERRCODE = 'QM037';
    END IF;
    RETURN NEW;
  END IF;
  SELECT status INTO v_status FROM public.ppap_submissions WHERE id = NEW.submission_id;
  IF v_status NOT IN ('draft', 'in_preparation') THEN RAISE EXCEPTION 'Evidence changes only while the submission is being prepared' USING ERRCODE = 'QM037'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.frozen_at IS NOT NULL THEN RAISE EXCEPTION 'Evidence is frozen when the submission is submitted, not before' USING ERRCODE = 'QM037'; END IF;
  ELSE
    IF OLD.removed_at IS NOT NULL
       OR (to_jsonb(NEW) - 'removed_at' - 'removed_by' - 'remove_reason' - 'updated_at' - 'updated_by')
          IS DISTINCT FROM (to_jsonb(OLD) - 'removed_at' - 'removed_by' - 'remove_reason' - 'updated_at' - 'updated_by') THEN
      RAISE EXCEPTION 'Evidence cannot be changed; it can only be removed, once, with a reason' USING ERRCODE = 'QM037';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Which records can be evidence for which element
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.ppap_link_kinds(p_element_key text) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE p_element_key
    WHEN 'design_records'                 THEN ARRAY['part_revision', 'document_revision']
    WHEN 'engineering_change_documents'   THEN ARRAY['change_request', 'document_revision']
    WHEN 'customer_engineering_approval'  THEN ARRAY['change_request']
    WHEN 'dfmea'                          THEN ARRAY['fmea_revision']
    WHEN 'process_flow_diagram'           THEN ARRAY['control_plan_revision', 'document_revision']
    WHEN 'pfmea'                          THEN ARRAY['fmea_revision']
    WHEN 'control_plan'                   THEN ARRAY['control_plan_revision']
    WHEN 'msa_studies'                    THEN ARRAY['msa_study']
    WHEN 'dimensional_results'            THEN ARRAY['inspection']
    WHEN 'material_performance_tests'     THEN ARRAY['material_certificate', 'document_revision']
    WHEN 'initial_process_studies'        THEN ARRAY['plan_characteristic']
    WHEN 'laboratory_documentation'       THEN ARRAY['calibration', 'document_revision']
    WHEN 'appearance_approval_report'     THEN ARRAY['document_revision']
    WHEN 'sample_production_parts'        THEN ARRAY['document_revision']
    WHEN 'master_sample'                  THEN ARRAY['document_revision']
    WHEN 'checking_aids'                  THEN ARRAY['gauge', 'document_revision']
    WHEN 'customer_specific_requirements' THEN ARRAY['document_revision']
    ELSE ARRAY[]::text[]
  END
$$;

-- The organisation a record belongs to (NULL when there is no such record). Internal.
CREATE FUNCTION app.ppap_target_org(p_kind text, p_id uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v uuid;
BEGIN
  IF p_kind = 'part_revision' THEN SELECT organisation_id INTO v FROM public.part_revisions WHERE id = p_id;
  ELSIF p_kind = 'control_plan_revision' THEN SELECT organisation_id INTO v FROM public.control_plan_revisions WHERE id = p_id;
  ELSIF p_kind = 'fmea_revision' THEN SELECT organisation_id INTO v FROM public.fmea_revisions WHERE id = p_id;
  ELSIF p_kind = 'change_request' THEN SELECT organisation_id INTO v FROM public.change_requests WHERE id = p_id;
  ELSIF p_kind = 'inspection' THEN SELECT organisation_id INTO v FROM public.inspection_records WHERE id = p_id;
  ELSIF p_kind = 'msa_study' THEN SELECT organisation_id INTO v FROM public.msa_studies WHERE id = p_id;
  ELSIF p_kind = 'material_certificate' THEN SELECT organisation_id INTO v FROM public.supplier_material_certificates WHERE id = p_id;
  ELSIF p_kind = 'calibration' THEN SELECT organisation_id INTO v FROM public.calibrations WHERE id = p_id;
  ELSIF p_kind = 'document_revision' THEN SELECT organisation_id INTO v FROM public.document_revisions WHERE id = p_id;
  ELSIF p_kind = 'gauge' THEN SELECT organisation_id INTO v FROM public.gauges WHERE id = p_id;
  ELSIF p_kind = 'plan_characteristic' THEN SELECT organisation_id INTO v FROM public.control_plan_characteristics WHERE id = p_id;
  END IF;
  RETURN v;
END $$;

-- Whether the caller may read the record, by the rule of the record's own module (the policies cannot be asked from a definer function). Internal.
CREATE FUNCTION app.ppap_target_readable(p_kind text, p_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid := app.ppap_target_org(p_kind, p_id); v_site uuid;
BEGIN
  IF v_org IS NULL OR NOT app.is_member(v_org) THEN RETURN false; END IF;
  IF p_kind = 'part_revision' THEN RETURN app.has_permission(v_org, 'master_data.read');
  ELSIF p_kind IN ('control_plan_revision', 'plan_characteristic') THEN RETURN app.has_permission(v_org, 'process_control.read');
  ELSIF p_kind = 'fmea_revision' THEN RETURN app.fmea_revision_readable(p_id);
  ELSIF p_kind = 'change_request' THEN RETURN app.has_permission(v_org, 'change.read');
  ELSIF p_kind = 'inspection' THEN SELECT site_id INTO v_site FROM public.inspection_records WHERE id = p_id; RETURN app.has_permission(v_org, 'inspection.read', v_site);
  ELSIF p_kind = 'msa_study' THEN SELECT g.site_id INTO v_site FROM public.msa_studies s JOIN public.gauges g ON g.id = s.gauge_id WHERE s.id = p_id; RETURN app.has_permission(v_org, 'calibration.read', v_site);
  ELSIF p_kind = 'material_certificate' THEN RETURN app.has_permission(v_org, 'receiving.read');
  ELSIF p_kind = 'calibration' THEN SELECT g.site_id INTO v_site FROM public.calibrations c JOIN public.gauges g ON g.id = c.gauge_id WHERE c.id = p_id; RETURN app.has_permission(v_org, 'calibration.read', v_site);
  ELSIF p_kind = 'document_revision' THEN RETURN app.document_revision_readable(p_id);
  ELSIF p_kind = 'gauge' THEN SELECT site_id INTO v_site FROM public.gauges WHERE id = p_id; RETURN app.has_permission(v_org, 'calibration.read', v_site);
  END IF;
  RETURN false;
END $$;

-- ---------------------------------------------------------------------------
-- 3. What a linked record is now: label, status, whether it is in good standing and, if not, why; a fingerprint of its content and its own version. Internal (no reading check:
--    the callers check). The part is the submission's part (for the records that belong to one part); the element key lets a link be judged for what it is evidence of.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.ppap_target_info(p_kind text, p_id uuid, p_part uuid DEFAULT NULL, p_element text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_label text; v_status text; v_ok boolean; v_problem text; v_fp text; v_ver text; v_mismatch boolean := false; v_part uuid; v_family uuid; v_n bigint; v_covers boolean;
  r record;
BEGIN
  IF p_part IS NOT NULL THEN SELECT part_family_id INTO v_family FROM public.parts WHERE id = p_part; END IF;

  IF p_kind = 'part_revision' THEN
    SELECT pr.*, p.part_number INTO r FROM public.part_revisions pr JOIN public.parts p ON p.id = pr.part_id WHERE pr.id = p_id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    v_label := r.part_number || ' rev ' || r.revision || CASE WHEN r.version > 1 THEN ' v' || r.version ELSE '' END;
    v_status := r.status; v_ok := r.status = 'released'; v_ver := r.updated_at::text; v_fp := md5(r.status || ':' || r.updated_at::text);
    v_mismatch := p_part IS NOT NULL AND r.part_id <> p_part;
    v_problem := CASE WHEN r.status = 'corrected' THEN 'was corrected, so use the corrected version' WHEN r.status <> 'released' THEN 'is ' || replace(r.status, '_', ' ') END;

  ELSIF p_kind = 'control_plan_revision' THEN
    SELECT v.*, c.plan_code INTO r FROM public.control_plan_revisions v JOIN public.control_plans c ON c.id = v.control_plan_id WHERE v.id = p_id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    v_covers := p_part IS NULL OR EXISTS (SELECT 1 FROM public.control_plan_applicability a WHERE a.control_plan_id = r.control_plan_id AND (a.part_id = p_part OR (a.part_id IS NULL AND a.part_family_id = v_family)));
    v_label := r.plan_code || ' rev ' || r.revision_code; v_status := r.status; v_ok := r.status = 'effective' AND v_covers; v_ver := r.updated_at::text; v_fp := md5(r.status || ':' || r.updated_at::text);
    v_problem := CASE WHEN r.status <> 'effective' THEN 'is ' || replace(r.status, '_', ' ') || ', not in force' WHEN NOT v_covers THEN 'does not cover this part' END;

  ELSIF p_kind = 'fmea_revision' THEN
    SELECT v.*, f.number, f.kind AS fmea_kind INTO r FROM public.fmea_revisions v JOIN public.fmeas f ON f.id = v.fmea_id WHERE v.id = p_id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    v_covers := p_part IS NULL OR EXISTS (SELECT 1 FROM public.fmea_links l WHERE l.revision_id = r.id AND ((l.kind = 'part' AND l.part_id = p_part) OR (l.kind = 'part_family' AND l.part_family_id = v_family)));
    v_label := r.number || ' rev ' || coalesce(r.letter, 'draft'); v_status := r.status; v_ok := r.status = 'effective' AND v_covers; v_ver := r.updated_at::text; v_fp := md5(r.status || ':' || r.updated_at::text);
    v_problem := CASE WHEN r.status <> 'effective' THEN 'is ' || replace(r.status, '_', ' ') || ', not in force' WHEN NOT v_covers THEN 'does not cover this part' END;
    IF p_element = 'dfmea' AND r.fmea_kind <> 'design' THEN v_problem := 'is a process FMEA, and this element asks for a design FMEA'; v_ok := false; END IF;
    IF p_element = 'pfmea' AND r.fmea_kind <> 'process' THEN v_problem := 'is a design FMEA, and this element asks for a process FMEA'; v_ok := false; END IF;

  ELSIF p_kind = 'change_request' THEN
    SELECT * INTO r FROM public.change_requests WHERE id = p_id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    v_label := r.reference || ' — ' || r.title; v_status := r.stage; v_ver := r.updated_at::text;
    v_ok := r.stage IN ('approved', 'implementing', 'verifying', 'closed');
    v_problem := CASE WHEN NOT v_ok THEN 'is ' || replace(r.stage, '_', ' ') || ', not approved' END;
    IF v_ok AND p_element = 'customer_engineering_approval' AND coalesce(r.customer_approval, '') NOT IN ('approved', 'waived') THEN
      v_ok := false; v_problem := 'has no recorded customer approval' || CASE WHEN r.customer_approval IS NOT NULL THEN ' (it is ' || replace(r.customer_approval, '_', ' ') || ')' ELSE '' END;
    END IF;
    v_fp := md5(r.stage || ':' || coalesce(r.customer_approval, '') || ':' || r.updated_at::text);

  ELSIF p_kind = 'inspection' THEN
    SELECT * INTO r FROM public.inspection_records WHERE id = p_id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    SELECT count(*) INTO v_n FROM public.inspection_measurements m WHERE m.inspection_record_id = r.id;
    v_label := r.reference || ' (' || to_char(r.started_at, 'YYYY-MM-DD') || ')'; v_status := r.status || coalesce(' / ' || r.result, ''); v_ver := r.updated_at::text;
    v_ok := r.status = 'completed' AND r.result = 'pass'; v_mismatch := p_part IS NOT NULL AND r.part_id <> p_part;
    v_problem := CASE WHEN r.status = 'in_progress' THEN 'is not finished' WHEN r.status = 'abandoned' THEN 'was abandoned' WHEN r.result = 'fail' THEN 'finished with a failure' END;
    v_fp := md5(r.status || ':' || coalesce(r.result, '') || ':' || coalesce(r.completed_at::text, '') || ':' || v_n::text);

  ELSIF p_kind = 'msa_study' THEN
    SELECT s.*, (SELECT x.data_hash FROM public.msa_study_results x WHERE x.study_id = s.id ORDER BY x.created_at DESC LIMIT 1) AS data_hash INTO r FROM public.msa_studies s WHERE s.id = p_id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    v_label := r.reference || ' — ' || r.characteristic_name; v_status := r.status || coalesce(' / ' || replace(r.conclusion, '_', ' '), ''); v_ver := r.updated_at::text;
    v_ok := r.status = 'completed' AND r.conclusion IN ('accepted', 'accepted_with_conditions') AND (r.valid_until IS NULL OR r.valid_until >= current_date);
    v_problem := CASE WHEN r.status IN ('draft', 'collecting') THEN 'is not complete' WHEN r.status = 'cancelled' THEN 'was cancelled' WHEN r.conclusion = 'not_accepted' THEN 'was not accepted'
                      WHEN r.valid_until < current_date THEN 'expired on ' || r.valid_until::text END;
    v_fp := md5(r.status || ':' || coalesce(r.conclusion, '') || ':' || coalesce(r.valid_until::text, '') || ':' || coalesce(r.data_hash, ''));

  ELSIF p_kind = 'material_certificate' THEN
    SELECT * INTO r FROM public.supplier_material_certificates WHERE id = p_id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    v_label := r.certificate_number || coalesce(' · heat ' || r.heat_number, ''); v_status := r.status; v_ver := r.updated_at::text; v_ok := r.status = 'accepted';
    v_mismatch := p_part IS NOT NULL AND r.part_id IS NOT NULL AND r.part_id <> p_part;
    v_problem := CASE WHEN r.status = 'received' THEN 'is waiting to be reviewed' WHEN r.status <> 'accepted' THEN 'was ' || r.status END;
    v_fp := md5(r.status || ':' || r.updated_at::text);

  ELSIF p_kind = 'calibration' THEN
    SELECT c.*, g.asset_number INTO r FROM public.calibrations c JOIN public.gauges g ON g.id = c.gauge_id WHERE c.id = p_id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    v_label := r.reference || ' (' || r.asset_number || ')'; v_status := r.outcome || CASE WHEN r.deleted_at IS NOT NULL THEN ' / removed' ELSE '' END; v_ver := r.updated_at::text;
    v_ok := r.outcome IN ('pass', 'adjusted') AND r.deleted_at IS NULL;
    v_problem := CASE WHEN r.deleted_at IS NOT NULL THEN 'was removed' WHEN r.outcome = 'fail' THEN 'failed' END;
    v_fp := md5(r.outcome || ':' || coalesce(r.deleted_at::text, '') || ':' || r.updated_at::text);

  ELSIF p_kind = 'document_revision' THEN
    SELECT v.*, d.number INTO r FROM public.document_revisions v JOIN public.documents d ON d.id = v.document_id WHERE v.id = p_id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    v_label := r.number || ' rev ' || coalesce(r.letter, 'draft'); v_status := r.status; v_ver := r.updated_at::text; v_ok := r.status = 'effective';
    v_problem := CASE WHEN NOT v_ok THEN 'is ' || replace(r.status, '_', ' ') || ', not in force' END; v_fp := md5(r.status || ':' || r.updated_at::text);

  ELSIF p_kind = 'gauge' THEN
    SELECT * INTO r FROM public.gauges WHERE id = p_id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    v_label := r.asset_number || ' — ' || r.description; v_status := r.status; v_ver := r.updated_at::text;
    v_ok := r.status = 'active' AND r.deleted_at IS NULL AND (r.next_due_on IS NULL OR r.next_due_on >= current_date);
    v_problem := CASE WHEN r.deleted_at IS NOT NULL THEN 'was removed' WHEN r.status <> 'active' THEN 'is ' || replace(r.status, '_', ' ')
                      WHEN r.next_due_on < current_date THEN 'was due for calibration on ' || r.next_due_on::text END;
    v_fp := md5(r.status || ':' || coalesce(r.next_due_on::text, '') || ':' || coalesce(r.last_calibrated_on::text, '') || ':' || coalesce(r.deleted_at::text, ''));

  ELSIF p_kind = 'plan_characteristic' THEN
    SELECT c.*, v.status AS rev_status, v.revision_code, cp.plan_code, cp.id AS plan_id INTO r
      FROM public.control_plan_characteristics c JOIN public.control_plan_revisions v ON v.id = c.control_plan_revision_id JOIN public.control_plans cp ON cp.id = v.control_plan_id WHERE c.id = p_id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    v_covers := p_part IS NULL OR EXISTS (SELECT 1 FROM public.control_plan_applicability a WHERE a.control_plan_id = r.plan_id AND (a.part_id = p_part OR (a.part_id IS NULL AND a.part_family_id = v_family)));
    SELECT count(*) INTO v_n FROM public.inspection_measurements m
      JOIN public.resolved_inspection_requirements q ON q.id = m.requirement_id
      JOIN public.inspection_records ir ON ir.id = q.inspection_record_id
     WHERE ir.part_id = coalesce(p_part, ir.part_id) AND q.characteristic_key = r.characteristic_key AND (m.value_numeric IS NOT NULL OR m.value_pass IS NOT NULL OR m.value_count IS NOT NULL);
    v_label := r.characteristic_key || ' — ' || r.name || ' (' || r.plan_code || ' rev ' || r.revision_code || ')'; v_status := r.rev_status; v_ver := r.updated_at::text;
    v_ok := r.rev_status = 'effective' AND v_covers AND v_n > 0;
    v_problem := CASE WHEN r.rev_status <> 'effective' THEN 'is on a plan revision that is ' || replace(r.rev_status, '_', ' ') WHEN NOT v_covers THEN 'is on a plan that does not cover this part'
                      WHEN v_n = 0 THEN 'has no readings for this part yet' END;
    v_fp := md5(r.rev_status || ':' || v_n::text || ':' || coalesce((SELECT max(m.measured_at)::text FROM public.inspection_measurements m
      JOIN public.resolved_inspection_requirements q ON q.id = m.requirement_id JOIN public.inspection_records ir ON ir.id = q.inspection_record_id
     WHERE ir.part_id = coalesce(p_part, ir.part_id) AND q.characteristic_key = r.characteristic_key), ''));
  ELSE
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object('label', v_label, 'status', v_status, 'ok', coalesce(v_ok, false) AND NOT v_mismatch, 'problem',
                            CASE WHEN v_mismatch THEN 'is for another part' ELSE v_problem END, 'fingerprint', v_fp, 'version', v_ver, 'partMismatch', v_mismatch);
END $$;

-- The state of one link as the caller sees it: available = false when the caller cannot read the record (never a blank pass). A frozen link also says whether the record has
-- changed since it was submitted.
CREATE FUNCTION app.ppap_link_state(p_evidence uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.ppap_evidence%ROWTYPE; s public.ppap_submissions%ROWTYPE; e public.ppap_elements%ROWTYPE; i jsonb;
BEGIN
  SELECT * INTO v FROM public.ppap_evidence WHERE id = p_evidence;
  IF NOT FOUND OR v.kind <> 'link' OR NOT app.ppap_readable(v.submission_id) THEN RAISE EXCEPTION 'Evidence not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO s FROM public.ppap_submissions WHERE id = v.submission_id;
  SELECT * INTO e FROM public.ppap_elements WHERE id = v.element_id;
  IF NOT app.ppap_target_readable(v.target_kind, v.target_id) THEN
    RETURN jsonb_build_object('available', false, 'frozen', v.frozen_at IS NOT NULL, 'frozenLabel', v.frozen_label, 'frozenStatus', v.frozen_status);
  END IF;
  i := app.ppap_target_info(v.target_kind, v.target_id, s.part_id, e.element_key);
  IF i IS NULL THEN RETURN jsonb_build_object('available', false, 'frozen', v.frozen_at IS NOT NULL, 'frozenLabel', v.frozen_label, 'frozenStatus', v.frozen_status); END IF;
  RETURN jsonb_build_object('available', true, 'label', i ->> 'label', 'status', i ->> 'status', 'ok', (i ->> 'ok')::boolean, 'problem', i ->> 'problem',
    'version', i ->> 'version', 'frozen', v.frozen_at IS NOT NULL, 'frozenLabel', v.frozen_label, 'frozenStatus', v.frozen_status, 'frozenAt', v.frozen_at,
    'changedSince', v.frozen_at IS NOT NULL AND v.frozen_fingerprint IS DISTINCT FROM i ->> 'fingerprint');
END $$;

-- ---------------------------------------------------------------------------
-- 4. Adding a link, and freezing the links at submission
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.add_ppap_link(p_element uuid, p_target_kind text, p_target uuid, p_description text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE e public.ppap_elements%ROWTYPE; s public.ppap_submissions%ROWTYPE; v_id uuid; i jsonb; v_org uuid; v_desc text := nullif(btrim(coalesce(p_description, '')), '');
BEGIN
  SELECT * INTO e FROM public.ppap_elements WHERE id = p_element;
  IF NOT FOUND THEN RAISE EXCEPTION 'Element not found' USING ERRCODE = 'P0002'; END IF;
  s := app.ppap_for_edit(e.submission_id);
  SELECT * INTO e FROM public.ppap_elements WHERE id = p_element FOR UPDATE;
  IF e.status = 'waived' THEN RAISE EXCEPTION 'This element is waived. Take the waiver off before adding evidence.' USING ERRCODE = 'QM037'; END IF;
  IF p_target_kind IS NULL OR NOT p_target_kind = ANY (app.ppap_link_kinds(e.element_key)) THEN
    RAISE EXCEPTION 'That kind of record is not evidence for %', (SELECT t.label FROM app.ppap_element_types() t WHERE t.key = e.element_key) USING ERRCODE = 'QM037';
  END IF;
  IF v_desc IS NOT NULL AND length(v_desc) > 500 THEN RAISE EXCEPTION 'The description is up to 500 characters' USING ERRCODE = 'QM037'; END IF;
  v_org := app.ppap_target_org(p_target_kind, p_target);
  IF v_org IS NULL OR v_org <> s.organisation_id THEN RAISE EXCEPTION 'That record was not found in this organisation' USING ERRCODE = 'QM037'; END IF;
  IF NOT app.ppap_target_readable(p_target_kind, p_target) THEN RAISE EXCEPTION 'You are not allowed to read that record, so it cannot be used as evidence' USING ERRCODE = 'QM037'; END IF;
  i := app.ppap_target_info(p_target_kind, p_target, s.part_id, e.element_key);
  IF (i ->> 'partMismatch')::boolean THEN RAISE EXCEPTION 'That record is for another part' USING ERRCODE = 'QM037'; END IF;
  BEGIN
    INSERT INTO public.ppap_evidence (organisation_id, submission_id, element_id, kind, target_kind, target_id, description)
    VALUES (s.organisation_id, s.id, e.id, 'link', p_target_kind, p_target, v_desc) RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'That record is already linked to this element' USING ERRCODE = 'QM037';
  END;
  IF e.status = 'not_started' THEN UPDATE public.ppap_elements SET status = 'in_progress' WHERE id = e.id; END IF;
  PERFORM app.ppap_touch(s.id);
  RETURN v_id;
END $$;

-- Records, for every live link that is not frozen yet, what the linked record is now (label, status, version, a fingerprint of its content). Done once, by the submit function
-- (PP3), inside its transaction. Internal: nobody calls it directly.
CREATE FUNCTION app.ppap_freeze_links(p_submission uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.ppap_submissions%ROWTYPE; v record; i jsonb; n integer := 0;
BEGIN
  SELECT * INTO s FROM public.ppap_submissions WHERE id = p_submission;
  IF NOT FOUND THEN RAISE EXCEPTION 'Submission not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM set_config('app.ppap_freezing', 'on', true);
  FOR v IN SELECT x.*, e.element_key FROM public.ppap_evidence x JOIN public.ppap_elements e ON e.id = x.element_id
            WHERE x.submission_id = p_submission AND x.kind = 'link' AND x.removed_at IS NULL AND x.frozen_at IS NULL LOOP
    i := app.ppap_target_info(v.target_kind, v.target_id, s.part_id, v.element_key);
    IF i IS NULL THEN RAISE EXCEPTION 'A linked record could not be found, so the submission cannot be frozen' USING ERRCODE = 'QM037'; END IF;
    UPDATE public.ppap_evidence SET frozen_at = now(), frozen_label = i ->> 'label', frozen_status = i ->> 'status', frozen_version = i ->> 'version', frozen_fingerprint = i ->> 'fingerprint'
     WHERE id = v.id;
    n := n + 1;
  END LOOP;
  PERFORM set_config('app.ppap_freezing', 'off', true);
  RETURN n;
END $$;

-- ---------------------------------------------------------------------------
-- 5. What a submission still needs: now also a line for every linked record that is not in good standing
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.ppap_problems(p_submission uuid) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.ppap_submissions%ROWTYPE; e record; v record; i jsonb; out text[] := '{}'::text[]; v_live integer;
BEGIN
  IF NOT app.ppap_readable(p_submission) THEN RAISE EXCEPTION 'Submission not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO s FROM public.ppap_submissions WHERE id = p_submission;
  FOR e IN SELECT x.*, t.label, t.ordinal FROM public.ppap_elements x JOIN app.ppap_element_types() t ON t.key = x.element_key
            WHERE x.submission_id = p_submission AND x.requirement = 'required' AND x.status <> 'waived' AND x.element_key <> 'part_submission_warrant' ORDER BY t.ordinal LOOP
    SELECT count(*) INTO v_live FROM public.ppap_evidence v2 WHERE v2.element_id = e.id AND v2.removed_at IS NULL;
    IF v_live = 0 THEN
      out := out || (e.label || ': add evidence, or ask an approver to waive it');
      CONTINUE;
    END IF;
    FOR v IN SELECT * FROM public.ppap_evidence v2 WHERE v2.element_id = e.id AND v2.removed_at IS NULL AND v2.kind = 'link' ORDER BY v2.created_at LOOP
      i := app.ppap_target_info(v.target_kind, v.target_id, s.part_id, e.element_key);
      IF i IS NULL THEN
        out := out || (e.label || ': a linked record cannot be found');
      ELSIF NOT (i ->> 'ok')::boolean THEN
        out := out || (e.label || ': ' || CASE WHEN app.ppap_target_readable(v.target_kind, v.target_id) THEN i ->> 'label' ELSE 'a linked record' END || ' ' || coalesce(i ->> 'problem', 'is not in good standing'));
      END IF;
    END LOOP;
    IF e.status <> 'ready' THEN out := out || (e.label || ': mark it ready'); END IF;
  END LOOP;
  RETURN out;
END $$;

-- ---------------------------------------------------------------------------
-- 6. What can be linked: records of one kind that the caller may read, scoped to the submission's part unless a search is given, each with its own state so the screen can show it
--    beside the name. The same state function as everywhere else; only records of this organisation, newest first.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.ppap_candidates(p_element uuid, p_kind text, p_query text DEFAULT NULL, p_limit integer DEFAULT 30)
RETURNS TABLE (target_id uuid, label text, status text, ok boolean, problem text, linked boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  e public.ppap_elements%ROWTYPE; s public.ppap_submissions%ROWTYPE; v_has_q boolean; v_q text; v_family uuid; v_lim integer := least(greatest(coalesce(p_limit, 30), 1), 50);
  v_ids uuid[]; v_id uuid; i jsonb;
BEGIN
  SELECT * INTO e FROM public.ppap_elements WHERE id = p_element;
  IF NOT FOUND OR NOT app.ppap_readable(e.submission_id) THEN RAISE EXCEPTION 'Element not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO s FROM public.ppap_submissions WHERE id = e.submission_id;
  IF NOT app.has_permission(s.organisation_id, 'ppap.manage') THEN RAISE EXCEPTION 'You are not allowed to prepare PPAP submissions' USING ERRCODE = '42501'; END IF;
  IF p_kind IS NULL OR NOT p_kind = ANY (app.ppap_link_kinds(e.element_key)) THEN RAISE EXCEPTION 'That kind of record is not evidence for this element' USING ERRCODE = 'QM037'; END IF;
  v_has_q := btrim(coalesce(p_query, '')) <> '';
  v_q := '%' || replace(replace(replace(lower(btrim(coalesce(p_query, ''))), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  SELECT part_family_id INTO v_family FROM public.parts WHERE id = s.part_id;

  IF p_kind = 'part_revision' THEN
    v_ids := ARRAY(SELECT x.id FROM public.part_revisions x WHERE x.organisation_id = s.organisation_id AND x.part_id = s.part_id
                    AND (NOT v_has_q OR lower(x.revision) LIKE v_q ESCAPE '\') ORDER BY x.created_at DESC LIMIT v_lim);
  ELSIF p_kind = 'control_plan_revision' THEN
    v_ids := ARRAY(SELECT x.id FROM public.control_plan_revisions x JOIN public.control_plans cp ON cp.id = x.control_plan_id
                    WHERE x.organisation_id = s.organisation_id
                      AND (v_has_q OR EXISTS (SELECT 1 FROM public.control_plan_applicability a WHERE a.control_plan_id = x.control_plan_id AND (a.part_id = s.part_id OR (a.part_id IS NULL AND a.part_family_id = v_family))))
                      AND (NOT v_has_q OR lower(cp.plan_code) LIKE v_q ESCAPE '\' OR lower(cp.title) LIKE v_q ESCAPE '\')
                    ORDER BY (x.status = 'effective') DESC, x.created_at DESC LIMIT v_lim);
  ELSIF p_kind = 'fmea_revision' THEN
    v_ids := ARRAY(SELECT x.id FROM public.fmea_revisions x JOIN public.fmeas f ON f.id = x.fmea_id
                    WHERE x.organisation_id = s.organisation_id AND x.status <> 'discarded' AND f.kind = CASE WHEN e.element_key = 'dfmea' THEN 'design' ELSE 'process' END
                      AND (v_has_q OR EXISTS (SELECT 1 FROM public.fmea_links l WHERE l.revision_id = x.id AND ((l.kind = 'part' AND l.part_id = s.part_id) OR (l.kind = 'part_family' AND l.part_family_id = v_family))))
                      AND (NOT v_has_q OR lower(f.number) LIKE v_q ESCAPE '\' OR lower(f.title) LIKE v_q ESCAPE '\')
                    ORDER BY (x.status = 'effective') DESC, x.created_at DESC LIMIT v_lim);
  ELSIF p_kind = 'change_request' THEN
    v_ids := ARRAY(SELECT x.id FROM public.change_requests x WHERE x.organisation_id = s.organisation_id AND x.stage <> 'cancelled'
                    AND (NOT v_has_q OR lower(x.reference) LIKE v_q ESCAPE '\' OR lower(x.title) LIKE v_q ESCAPE '\') ORDER BY x.created_at DESC LIMIT v_lim);
  ELSIF p_kind = 'inspection' THEN
    v_ids := ARRAY(SELECT x.id FROM public.inspection_records x WHERE x.organisation_id = s.organisation_id AND x.part_id = s.part_id AND x.status <> 'abandoned'
                    AND (NOT v_has_q OR lower(x.reference) LIKE v_q ESCAPE '\' OR lower(coalesce(x.lot, '')) LIKE v_q ESCAPE '\') ORDER BY x.started_at DESC LIMIT v_lim);
  ELSIF p_kind = 'msa_study' THEN
    v_ids := ARRAY(SELECT x.id FROM public.msa_studies x WHERE x.organisation_id = s.organisation_id AND x.status <> 'cancelled' AND (v_has_q OR x.part_id = s.part_id OR x.part_id IS NULL)
                    AND (NOT v_has_q OR lower(x.reference) LIKE v_q ESCAPE '\' OR lower(x.characteristic_name) LIKE v_q ESCAPE '\') ORDER BY x.created_at DESC LIMIT v_lim);
  ELSIF p_kind = 'material_certificate' THEN
    v_ids := ARRAY(SELECT x.id FROM public.supplier_material_certificates x WHERE x.organisation_id = s.organisation_id AND x.status <> 'withdrawn' AND (v_has_q OR x.part_id = s.part_id OR x.part_id IS NULL)
                    AND (NOT v_has_q OR lower(x.certificate_number) LIKE v_q ESCAPE '\' OR lower(coalesce(x.heat_number, '')) LIKE v_q ESCAPE '\' OR lower(coalesce(x.material, '')) LIKE v_q ESCAPE '\')
                    ORDER BY x.created_at DESC LIMIT v_lim);
  ELSIF p_kind = 'calibration' THEN
    v_ids := ARRAY(SELECT x.id FROM public.calibrations x JOIN public.gauges g ON g.id = x.gauge_id WHERE x.organisation_id = s.organisation_id AND x.deleted_at IS NULL
                    AND (NOT v_has_q OR lower(x.reference) LIKE v_q ESCAPE '\' OR lower(g.asset_number) LIKE v_q ESCAPE '\' OR lower(g.description) LIKE v_q ESCAPE '\') ORDER BY x.calibrated_on DESC, x.created_at DESC LIMIT v_lim);
  ELSIF p_kind = 'document_revision' THEN
    v_ids := ARRAY(SELECT x.id FROM public.document_revisions x JOIN public.documents d ON d.id = x.document_id WHERE x.organisation_id = s.organisation_id AND x.status NOT IN ('discarded', 'withdrawn')
                    AND (NOT v_has_q OR lower(d.number) LIKE v_q ESCAPE '\' OR lower(d.title) LIKE v_q ESCAPE '\') ORDER BY (x.status = 'effective') DESC, x.created_at DESC LIMIT v_lim);
  ELSIF p_kind = 'gauge' THEN
    v_ids := ARRAY(SELECT x.id FROM public.gauges x WHERE x.organisation_id = s.organisation_id AND x.deleted_at IS NULL
                    AND (NOT v_has_q OR lower(x.asset_number) LIKE v_q ESCAPE '\' OR lower(x.description) LIKE v_q ESCAPE '\') ORDER BY x.asset_number LIMIT v_lim);
  ELSIF p_kind = 'plan_characteristic' THEN
    v_ids := ARRAY(SELECT x.id FROM public.control_plan_characteristics x JOIN public.control_plan_revisions v ON v.id = x.control_plan_revision_id
                    WHERE x.organisation_id = s.organisation_id AND v.status = 'effective'
                      AND (v_has_q OR EXISTS (SELECT 1 FROM public.control_plan_applicability a WHERE a.control_plan_id = v.control_plan_id AND (a.part_id = s.part_id OR (a.part_id IS NULL AND a.part_family_id = v_family))))
                      AND (NOT v_has_q OR lower(x.characteristic_key) LIKE v_q ESCAPE '\' OR lower(x.name) LIKE v_q ESCAPE '\')
                    ORDER BY x.sequence, x.characteristic_key LIMIT v_lim);
  ELSE
    v_ids := '{}';
  END IF;

  FOREACH v_id IN ARRAY v_ids LOOP
    CONTINUE WHEN NOT app.ppap_target_readable(p_kind, v_id);
    i := app.ppap_target_info(p_kind, v_id, s.part_id, e.element_key);
    CONTINUE WHEN i IS NULL OR (i ->> 'partMismatch')::boolean;
    target_id := v_id; label := i ->> 'label'; status := i ->> 'status'; ok := (i ->> 'ok')::boolean; problem := i ->> 'problem';
    linked := EXISTS (SELECT 1 FROM public.ppap_evidence v WHERE v.element_id = e.id AND v.kind = 'link' AND v.target_kind = p_kind AND v.target_id = v_id AND v.removed_at IS NULL);
    RETURN NEXT;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 7. Privileges
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app.ppap_evidence_rules(), app.ppap_target_org(text, uuid), app.ppap_target_readable(text, uuid), app.ppap_target_info(text, uuid, uuid, text),
  app.ppap_freeze_links(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.ppap_link_kinds(text), app.ppap_link_state(uuid), app.add_ppap_link(uuid, text, uuid, text), app.ppap_candidates(uuid, text, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.ppap_link_kinds(text), app.ppap_link_state(uuid), app.add_ppap_link(uuid, text, uuid, text), app.ppap_candidates(uuid, text, text, integer) TO authenticated;
