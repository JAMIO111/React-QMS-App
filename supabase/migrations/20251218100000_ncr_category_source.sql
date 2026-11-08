-- Non-conformances: CATEGORY and SOURCE as separate things (docs/ncr-category-source-plan.md, slice NS1).
--
--  * Category = what the problem is. Organisation-managed (ncr_classifications kind 'category'), eleven defaults seeded for every organisation (and each new one):
--    Product, Process, Tooling, Equipment, Calibration, Material, Documentation, Inspection, System, Traceability, Packaging & Handling.
--  * Source = where it originated or was detected: a FIXED list of eleven — internal, customer, supplier, internal_audit, external_audit, production_inspection,
--    final_inspection, calibration, goods_receiving, engineering, management_review. Any category/source combination is valid.
--  * A category is needed to open (draft → open); existing non-conformances are grandfathered (no category, never blocked later); once open it can be changed but not cleared.
--  * Source is no longer locked: app.change_ncr_source(ncr, source, reason) (ncr.update, reason required, audited, event ncr.source_changed). Customer / supplier are
--    required to open only for those two sources (goods_receiving: supplier optional). Changing source keeps what was entered for the old one.
--  * Integrations set the source: inspection → production_inspection, audit finding → internal_audit (calibration: API). 8D source: customer → customer;
--    supplier, goods_receiving → supplier; everything else → internal. The production backfill treats goods_receiving like supplier (a lot received).
--  * Backfill of factual origins only (no category is guessed): NCs linked from an inspection → production_inspection, from an audit → internal_audit,
--    from a calibration → calibration; a stray 'inspection' → production_inspection.

-- ---------------------------------------------------------------------------
-- Categories
-- ---------------------------------------------------------------------------
ALTER TABLE public.ncr_classifications DROP CONSTRAINT ncr_classifications_kind_check;
ALTER TABLE public.ncr_classifications ADD CONSTRAINT ncr_classifications_kind_check CHECK (kind IN ('failure_mode', 'sub_failure_mode', 'process', 'category'));

CREATE FUNCTION app.seed_ncr_categories(p_organisation_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO public.ncr_classifications (organisation_id, kind, code, name, sort_order) VALUES
    (p_organisation_id, 'category', 'PRODUCT', 'Product', 1),
    (p_organisation_id, 'category', 'PROCESS', 'Process', 2),
    (p_organisation_id, 'category', 'TOOLING', 'Tooling', 3),
    (p_organisation_id, 'category', 'EQUIPMENT', 'Equipment', 4),
    (p_organisation_id, 'category', 'CALIBRATION', 'Calibration', 5),
    (p_organisation_id, 'category', 'MATERIAL', 'Material', 6),
    (p_organisation_id, 'category', 'DOCUMENTATION', 'Documentation', 7),
    (p_organisation_id, 'category', 'INSPECTION', 'Inspection', 8),
    (p_organisation_id, 'category', 'SYSTEM', 'System', 9),
    (p_organisation_id, 'category', 'TRACEABILITY', 'Traceability', 10),
    (p_organisation_id, 'category', 'PACKAGING', 'Packaging & Handling', 11)
  ON CONFLICT DO NOTHING
$$;

CREATE FUNCTION app.seed_ncr_categories_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.seed_ncr_categories(NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER organisations_seed_ncr_categories AFTER INSERT ON public.organisations FOR EACH ROW EXECUTE FUNCTION app.seed_ncr_categories_trg();

SELECT app.seed_ncr_categories(o.id) FROM public.organisations o;

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.nonconformances DROP CONSTRAINT nonconformances_source_check;
-- A stray 'inspection' (allowed but never written) becomes production_inspection before the widened list is enforced.
UPDATE public.nonconformances SET source = 'production_inspection' WHERE source = 'inspection';
ALTER TABLE public.nonconformances ADD CONSTRAINT nonconformances_source_check CHECK (source IN (
  'internal', 'customer', 'supplier', 'internal_audit', 'external_audit', 'production_inspection', 'final_inspection', 'calibration', 'goods_receiving', 'engineering', 'management_review'));
ALTER TABLE public.nonconformances ADD COLUMN category_id uuid;
ALTER TABLE public.nonconformances ADD COLUMN source_change_reason text CHECK (source_change_reason IS NULL OR length(btrim(source_change_reason)) BETWEEN 1 AND 1000);
ALTER TABLE public.nonconformances ADD CONSTRAINT nonconformances_category_fkey FOREIGN KEY (category_id, organisation_id) REFERENCES public.ncr_classifications (id, organisation_id);
CREATE INDEX nonconformances_category_idx ON public.nonconformances (organisation_id, category_id) WHERE category_id IS NOT NULL;
GRANT UPDATE (category_id) ON public.nonconformances TO authenticated;

-- ---------------------------------------------------------------------------
-- Rules: category must be a category, cannot be cleared once open; the source changes only through app.change_ncr_source
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.nonconformance_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  user_change boolean := coalesce(auth.role(), '') = 'authenticated';
  order_of text[] := ARRAY['open', 'contained', 'investigating', 'dispositioned', 'awaiting_closure', 'closed'];
  from_pos integer;
  to_pos integer;
  content_changed boolean;
BEGIN
  -- Consistency (always).
  IF NEW.part_revision_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.part_revisions r WHERE r.id = NEW.part_revision_id AND r.part_id IS NOT DISTINCT FROM NEW.part_id) THEN
    RAISE EXCEPTION 'The revision does not belong to the selected part' USING ERRCODE = 'QM005';
  END IF;
  IF NEW.category_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.ncr_classifications c WHERE c.id = NEW.category_id AND c.kind = 'category') THEN
    RAISE EXCEPTION 'The category must be one of the organisation''s categories' USING ERRCODE = 'QM005';
  END IF;
  IF NEW.failure_mode_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.ncr_classifications c WHERE c.id = NEW.failure_mode_id AND c.kind = 'failure_mode')
     OR NEW.sub_failure_mode_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.ncr_classifications c WHERE c.id = NEW.sub_failure_mode_id AND c.kind = 'sub_failure_mode'
                                                            AND c.parent_id IS NOT DISTINCT FROM NEW.failure_mode_id)
     OR NEW.causal_process_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.ncr_classifications c WHERE c.id = NEW.causal_process_id AND c.kind = 'process')
     OR NEW.detection_process_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.ncr_classifications c WHERE c.id = NEW.detection_process_id AND c.kind = 'process') THEN
    RAISE EXCEPTION 'A classification does not match its field (or the sub-failure mode is not under the failure mode)' USING ERRCODE = 'QM005';
  END IF;

  IF NOT user_change THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.reference := app.next_ncr_reference(NEW.organisation_id);
    IF NEW.stage NOT IN ('draft', 'open') THEN
      RAISE EXCEPTION 'A new non-conformance starts as draft or open' USING ERRCODE = 'QM005';
    END IF;
    NEW.closed_at := NULL; NEW.closed_by := NULL;
    NEW.deleted_at := NULL; NEW.deleted_by := NULL; NEW.delete_reason := NULL;
    NEW.legacy_ncm_id := NULL;
    IF NEW.stage = 'open' THEN
      PERFORM app.assert_ncr_openable(NEW);
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF NEW.reference <> OLD.reference THEN
    RAISE EXCEPTION 'The reference of a non-conformance cannot change' USING ERRCODE = 'QM005';
  END IF;
  -- The source changes only through app.change_ncr_source, which asks for the reason.
  IF (NEW.source <> OLD.source OR NEW.source_change_reason IS DISTINCT FROM OLD.source_change_reason)
     AND coalesce(current_setting('app.ncr_source_change', true), '') <> 'on' THEN
    RAISE EXCEPTION 'The source of a non-conformance is changed with a reason (change the source), not edited directly' USING ERRCODE = 'QM005';
  END IF;

  -- Soft delete / restore.
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    IF NOT app.has_permission(NEW.organisation_id, 'ncr.delete', NEW.site_id) THEN
      RAISE EXCEPTION 'Deleting non-conformances needs the ncr.delete permission' USING ERRCODE = '42501';
    END IF;
    IF NEW.deleted_at IS NOT NULL THEN
      IF coalesce(trim(NEW.delete_reason), '') = '' THEN
        RAISE EXCEPTION 'Give a reason for deleting' USING ERRCODE = 'QM005';
      END IF;
      NEW.deleted_at := now();
      NEW.deleted_by := auth.uid();
    ELSE
      NEW.deleted_by := NULL;
      NEW.delete_reason := NULL;
    END IF;
    IF app.ncr_content(NEW) IS DISTINCT FROM app.ncr_content(OLD) OR NEW.stage <> OLD.stage THEN
      RAISE EXCEPTION 'Delete or restore on its own, without other changes' USING ERRCODE = 'QM005';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'This non-conformance is deleted; restore it first' USING ERRCODE = 'QM005';
  END IF;
  IF NEW.delete_reason IS DISTINCT FROM OLD.delete_reason OR NEW.deleted_by IS DISTINCT FROM OLD.deleted_by THEN
    RAISE EXCEPTION 'Deletion details are set by the system' USING ERRCODE = 'QM005';
  END IF;

  IF NOT app.has_permission(NEW.organisation_id, 'ncr.update', NEW.site_id) THEN
    RAISE EXCEPTION 'Changing non-conformances needs the ncr.update permission' USING ERRCODE = '42501';
  END IF;

  -- A category can be changed but not taken away once the non-conformance has left draft.
  IF OLD.category_id IS NOT NULL AND NEW.category_id IS NULL AND OLD.stage <> 'draft' THEN
    RAISE EXCEPTION 'A category can be changed but not cleared once the non-conformance is open' USING ERRCODE = 'QM005';
  END IF;

  content_changed := app.ncr_content(NEW) IS DISTINCT FROM app.ncr_content(OLD);

  IF NEW.stage = OLD.stage THEN
    IF content_changed AND OLD.stage IN ('closed', 'cancelled') THEN
      RAISE EXCEPTION 'This non-conformance is %; reopen it to make changes', OLD.stage USING ERRCODE = 'QM005';
    END IF;
    IF NEW.stage_reason IS DISTINCT FROM OLD.stage_reason OR NEW.closed_at IS DISTINCT FROM OLD.closed_at
       OR NEW.closed_by IS DISTINCT FROM OLD.closed_by THEN
      RAISE EXCEPTION 'Stage details change only with the stage' USING ERRCODE = 'QM005';
    END IF;
    RETURN NEW;
  END IF;

  -- Stage change.
  from_pos := array_position(order_of, OLD.stage);
  to_pos := array_position(order_of, NEW.stage);
  IF NEW.stage = 'cancelled' THEN
    IF OLD.stage IN ('closed', 'cancelled') THEN
      RAISE EXCEPTION 'A % non-conformance cannot be cancelled', OLD.stage USING ERRCODE = 'QM005';
    END IF;
    IF coalesce(trim(NEW.stage_reason), '') = '' THEN
      RAISE EXCEPTION 'Give a reason for cancelling' USING ERRCODE = 'QM005';
    END IF;
  ELSIF OLD.stage IN ('closed', 'cancelled') THEN
    IF NEW.stage <> 'open' THEN
      RAISE EXCEPTION 'A % non-conformance can only be reopened', OLD.stage USING ERRCODE = 'QM005';
    END IF;
    IF coalesce(trim(NEW.stage_reason), '') = '' THEN
      RAISE EXCEPTION 'Give a reason for reopening' USING ERRCODE = 'QM005';
    END IF;
    IF content_changed THEN
      RAISE EXCEPTION 'Reopen first, then make changes' USING ERRCODE = 'QM005';
    END IF;
    NEW.closed_at := NULL;
    NEW.closed_by := NULL;
    RETURN NEW;
  ELSIF OLD.stage = 'draft' THEN
    IF NEW.stage <> 'open' THEN
      RAISE EXCEPTION 'A draft is opened first' USING ERRCODE = 'QM005';
    END IF;
  ELSIF to_pos IS NULL OR from_pos IS NULL OR to_pos <= from_pos THEN
    RAISE EXCEPTION 'A % non-conformance cannot move to %', OLD.stage, NEW.stage USING ERRCODE = 'QM005';
  END IF;

  IF OLD.stage = 'draft' THEN
    PERFORM app.assert_ncr_openable(NEW);
  END IF;
  IF NEW.stage = 'closed' THEN
    NEW.closed_at := now();
    NEW.closed_by := auth.uid();
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- Minimum content before a non-conformance leaves draft: now also a category, and the party only for the sources that need one
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.assert_ncr_openable(r public.nonconformances) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE
  missing text[] := ARRAY[]::text[];
BEGIN
  IF r.severity IS NULL THEN missing := array_append(missing, 'severity'); END IF;
  IF r.quantity_affected IS NULL THEN missing := array_append(missing, 'quantity affected'); END IF;
  IF r.part_id IS NULL AND coalesce(trim(r.description), '') = '' THEN missing := array_append(missing, 'part or description'); END IF;
  IF r.category_id IS NULL THEN missing := array_append(missing, 'category'); END IF;
  IF r.source = 'customer' AND r.customer_id IS NULL THEN missing := array_append(missing, 'customer'); END IF;
  IF r.source = 'supplier' AND r.supplier_id IS NULL THEN missing := array_append(missing, 'supplier'); END IF;
  IF cardinality(missing) > 0 THEN
    RAISE EXCEPTION 'To open this non-conformance, fill in: %', array_to_string(missing, ', ') USING ERRCODE = 'QM005';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Change the source, with a reason (ncr.update). Everything entered for the old source stays; an open NC moving to customer / supplier needs the party first.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.change_ncr_source(p_ncr uuid, p_source text, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  n public.nonconformances%ROWTYPE;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
BEGIN
  SELECT * INTO n FROM public.nonconformances WHERE id = p_ncr FOR UPDATE;
  IF NOT FOUND OR NOT app.has_permission(n.organisation_id, 'ncr.read', n.site_id) THEN
    RAISE EXCEPTION 'Non-conformance not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT app.has_permission(n.organisation_id, 'ncr.update', n.site_id) THEN
    RAISE EXCEPTION 'Changing non-conformances needs the ncr.update permission' USING ERRCODE = '42501';
  END IF;
  IF p_source IS NULL OR p_source NOT IN ('internal', 'customer', 'supplier', 'internal_audit', 'external_audit', 'production_inspection', 'final_inspection', 'calibration', 'goods_receiving', 'engineering', 'management_review') THEN
    RAISE EXCEPTION 'Choose a source' USING ERRCODE = 'QM005';
  END IF;
  IF p_source = n.source THEN
    RAISE EXCEPTION 'It already has that source' USING ERRCODE = 'QM005';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'Say why the source is changed' USING ERRCODE = 'QM005';
  END IF;
  IF n.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'This non-conformance is deleted; restore it first' USING ERRCODE = 'QM005';
  END IF;
  IF n.stage <> 'draft' THEN
    IF p_source = 'customer' AND n.customer_id IS NULL THEN
      RAISE EXCEPTION 'Choose the customer first: a customer non-conformance needs one' USING ERRCODE = 'QM005';
    END IF;
    IF p_source = 'supplier' AND n.supplier_id IS NULL THEN
      RAISE EXCEPTION 'Choose the supplier first: a supplier non-conformance needs one' USING ERRCODE = 'QM005';
    END IF;
  END IF;
  PERFORM set_config('app.ncr_source_change', 'on', true);
  UPDATE public.nonconformances SET source = p_source, source_change_reason = left(v_reason, 1000) WHERE id = p_ncr;
  PERFORM set_config('app.ncr_source_change', 'off', true);
  PERFORM app.emit_event(n.organisation_id, 'ncr.source_changed', 'nonconformance', n.id,
    jsonb_build_object('reference', n.reference, 'from', n.source, 'to', p_source, 'reason', v_reason));
END $$;

-- ---------------------------------------------------------------------------
-- Integrations set the source (definitions replaced as they stood, with the source changed)
-- ---------------------------------------------------------------------------
-- It takes an optional category now, because raising straight into "open" needs one.
DROP FUNCTION app.raise_ncr_from_inspection(uuid, uuid[], text, text, text, numeric, text, text, boolean);
CREATE FUNCTION app.raise_ncr_from_inspection(
  p_inspection_id uuid,
  p_measurement_ids uuid[] DEFAULT ARRAY[]::uuid[],
  p_title text DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_severity text DEFAULT NULL,
  p_quantity_affected numeric DEFAULT NULL,
  p_requirement text DEFAULT NULL,
  p_actual_result text DEFAULT NULL,
  p_open boolean DEFAULT false,
  p_category_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  r record;
  v_ids uuid[] := coalesce(p_measurement_ids, ARRAY[]::uuid[]);
  v_distinct uuid[];
  v_found integer;
  v_ncr uuid;
  v_detected date;
  v_title text := nullif(trim(p_title), '');
BEGIN
  SELECT i.id, i.organisation_id, i.site_id, i.part_id, i.part_revision_id, i.work_order, i.lot, i.serial, i.reference, i.status,
         i.production_order_id, i.lot_id, i.serial_id
  INTO r FROM public.inspection_records i WHERE i.id = p_inspection_id;
  IF r.id IS NULL OR NOT app.has_permission(r.organisation_id, 'inspection.read', r.site_id) THEN
    RAISE EXCEPTION 'Inspection not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT app.has_permission(r.organisation_id, 'ncr.create', r.site_id) THEN
    RAISE EXCEPTION 'You may not raise non-conformances' USING ERRCODE = '42501';
  END IF;
  IF v_title IS NULL THEN
    RAISE EXCEPTION 'Give the non-conformance a title' USING ERRCODE = 'QM008';
  END IF;

  SELECT array_agg(DISTINCT x) INTO v_distinct FROM unnest(v_ids) x;
  v_found := coalesce(cardinality(v_distinct), 0);
  IF v_found > 0 THEN
    IF (SELECT count(*) FROM public.inspection_measurements m
        WHERE m.id = ANY (v_distinct) AND m.inspection_record_id = p_inspection_id AND m.result = 'fail') <> v_found THEN
      RAISE EXCEPTION 'Only failed readings of this inspection can be linked to the non-conformance' USING ERRCODE = 'QM008';
    END IF;
    SELECT min(m.measured_at)::date INTO v_detected FROM public.inspection_measurements m WHERE m.id = ANY (v_distinct);
    PERFORM app.assert_readings_free(v_distinct);
  END IF;

  INSERT INTO public.nonconformances (organisation_id, reference, source, stage, severity, title, description, requirement, actual_result,
                                      site_id, part_id, part_revision_id, work_order, lot_number, serial_number,
                                      production_order_id, lot_id, serial_id, quantity_affected, detected_at, detected_by, category_id)
  VALUES (r.organisation_id, 'pending', 'production_inspection', CASE WHEN coalesce(p_open, false) THEN 'open' ELSE 'draft' END,
          nullif(p_severity, ''), left(v_title, 200), nullif(trim(p_description), ''), nullif(trim(p_requirement), ''), nullif(trim(p_actual_result), ''),
          r.site_id, r.part_id, r.part_revision_id, r.work_order, r.lot, r.serial,
          r.production_order_id, r.lot_id, r.serial_id, p_quantity_affected, coalesce(v_detected, current_date), auth.uid(), p_category_id)
  RETURNING id INTO v_ncr;

  IF v_found = 0 THEN
    INSERT INTO public.inspection_ncr_links (organisation_id, nonconformance_id, inspection_record_id) VALUES (r.organisation_id, v_ncr, p_inspection_id);
  ELSE
    INSERT INTO public.inspection_ncr_links (organisation_id, nonconformance_id, inspection_record_id, measurement_id)
    SELECT r.organisation_id, v_ncr, p_inspection_id, x FROM unnest(v_distinct) x;
  END IF;

  PERFORM app.emit_event(r.organisation_id, 'inspection.ncr_raised', 'inspection_record', p_inspection_id,
    jsonb_build_object('reference', r.reference, 'nonconformance_id', v_ncr, 'readings', v_found));
  RETURN v_ncr;
END $$;

CREATE OR REPLACE FUNCTION app.create_ncr_from_audit_finding(p_finding uuid, p_title text DEFAULT NULL, p_description text DEFAULT NULL, p_severity text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  f public.audit_findings%ROWTYPE;
  r public.audit_records%ROWTYPE;
  c public.audit_finding_classifications%ROWTYPE;
  v_ncr uuid;
  v_site uuid;
  v_title text;
  v_severity text;
BEGIN
  -- Lock the finding first: two people pressing the button at once end up with one NC.
  SELECT * INTO f FROM public.audit_findings WHERE id = p_finding FOR UPDATE;
  IF NOT FOUND OR NOT app.has_permission(f.organisation_id, 'audits.read') THEN
    RAISE EXCEPTION 'Finding not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT app.has_permission(f.organisation_id, 'ncr.create') THEN
    RAISE EXCEPTION 'You may not raise non-conformances' USING ERRCODE = '42501';
  END IF;
  IF f.status <> 'open' THEN
    RAISE EXCEPTION '% is %; only an open finding can be raised as a non-conformance', f.reference, f.status USING ERRCODE = 'QM018';
  END IF;
  SELECT * INTO c FROM public.audit_finding_classifications WHERE id = f.classification_id;
  IF c.kind <> 'nonconformity' THEN
    RAISE EXCEPTION 'Only a finding classified as a non-conformity can be raised as a non-conformance' USING ERRCODE = 'QM018';
  END IF;
  SELECT * INTO r FROM public.audit_records WHERE id = f.audit_record_id;
  IF r.status = 'abandoned' THEN
    RAISE EXCEPTION '% was abandoned', r.reference USING ERRCODE = 'QM018';
  END IF;

  v_ncr := app.audit_finding_live_ncr(p_finding);
  IF v_ncr IS NOT NULL THEN
    RETURN jsonb_build_object('nonconformanceId', v_ncr, 'created', false);
  END IF;

  v_title := coalesce(nullif(btrim(coalesce(p_title, '')), ''), f.title);
  v_severity := coalesce(nullif(p_severity, ''), c.default_severity);
  IF v_severity IS NOT NULL AND v_severity NOT IN ('critical', 'major', 'minor') THEN
    RAISE EXCEPTION 'The severity must be critical, major or minor' USING ERRCODE = 'QM018';
  END IF;
  SELECT m.site_id INTO v_site FROM public.audit_record_targets x JOIN public.machines m ON m.id = x.machine_id
   WHERE x.audit_record_id = f.audit_record_id AND m.site_id IS NOT NULL ORDER BY x.created_at LIMIT 1;

  INSERT INTO public.nonconformances (organisation_id, reference, source, stage, severity, title, description, requirement, actual_result, site_id, detected_at, detected_by)
  VALUES (f.organisation_id, 'pending', 'internal_audit', 'draft', v_severity, left(v_title, 200),
          coalesce(nullif(btrim(coalesce(p_description, '')), ''), format('Raised from audit %s, finding %s.', r.reference, f.reference)),
          f.requirement, f.description, v_site, r.performed_on, auth.uid())
  RETURNING id INTO v_ncr;
  INSERT INTO public.audit_ncr_links (organisation_id, audit_record_id, response_id, finding_id, nonconformance_id)
  VALUES (f.organisation_id, f.audit_record_id, f.response_id, f.id, v_ncr);
  PERFORM app.emit_event(f.organisation_id, 'audit.finding.ncr_created', 'audit_finding', f.id,
    jsonb_build_object('finding', f.reference, 'record', r.reference, 'nonconformance_id', v_ncr));
  RETURN jsonb_build_object('nonconformanceId', v_ncr, 'created', true);
END $$;

CREATE OR REPLACE FUNCTION app.start_capa(p_organisation_id uuid, p_title text DEFAULT NULL, p_problem text DEFAULT NULL, p_source text DEFAULT NULL,
                                          p_severity text DEFAULT NULL, p_from_ncr uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n public.nonconformances%ROWTYPE; v_id uuid; v_ref text; v_me uuid; v_title text; v_problem text; v_source text; v_severity text; s text;
        v_what text; v_where text; v_when text; v_how_many text;
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
  v_source := coalesce(nullif(p_source, ''), CASE WHEN n.id IS NULL THEN 'internal' WHEN n.source = 'customer' THEN 'customer' WHEN n.source IN ('supplier', 'goods_receiving') THEN 'supplier' ELSE 'internal' END);
  v_severity := coalesce(nullif(p_severity, ''), n.severity);
  IF n.id IS NOT NULL THEN
    v_title := coalesce(v_title, left('8D: ' || n.title, 200));
    s := nullif(btrim(concat_ws(E'\n', n.description, CASE WHEN n.requirement IS NOT NULL THEN 'Requirement: ' || n.requirement END,
                                      CASE WHEN n.actual_result IS NOT NULL THEN 'Actual: ' || n.actual_result END)), '');
    v_problem := coalesce(v_problem, left(coalesce(s, n.title), 5000));
    v_what := left(nullif(btrim(concat_ws(' · ', n.title, CASE WHEN n.lot_number IS NOT NULL THEN 'Lot ' || n.lot_number END,
                                                  CASE WHEN n.work_order IS NOT NULL THEN 'Work order ' || n.work_order END)), ''), 2000);
    v_where := left(nullif(btrim(coalesce((SELECT c.name FROM public.ncr_classifications c WHERE c.id = n.detection_process_id),
                                          (SELECT st.name FROM public.sites st WHERE st.id = n.site_id), '')), ''), 2000);
    v_when := 'Detected ' || to_char(n.detected_at, 'FMDD Mon YYYY');
    v_how_many := CASE WHEN n.quantity_affected IS NOT NULL
                       THEN trim_scale(n.quantity_affected)::text || CASE WHEN n.quantity_inspected IS NOT NULL THEN ' of ' || trim_scale(n.quantity_inspected)::text || ' inspected' ELSE ' affected' END
                  END;
  END IF;
  IF v_title IS NULL THEN
    RAISE EXCEPTION 'Give the 8D a title' USING ERRCODE = 'QM013';
  END IF;
  v_ref := app.next_capa_reference(p_organisation_id);
  INSERT INTO public.capas (organisation_id, reference, title, problem_statement, source, severity, owner_membership_id, d2_what, d2_where, d2_when, d2_how_many)
  VALUES (p_organisation_id, v_ref, v_title, v_problem, v_source, v_severity, v_me, v_what, v_where, v_when, v_how_many)
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

CREATE OR REPLACE FUNCTION app.system_backfill_production_links(p_organisation_id uuid, p_dry_run boolean DEFAULT true) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  rx constant text := '^\S(.{0,58}\S)?$';
  r record;
  v_unusable integer; v_no_part integer;
  v_conflicts integer := 0; v_inspections integer := 0; v_ncrs integer := 0;
  v_orders_new integer; v_orders_matched integer; v_lots_new integer; v_lots_matched integer; v_serials_new integer; v_serials_matched integer;
  v_skipped jsonb;
  v_links integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organisations WHERE id = p_organisation_id) THEN
    RAISE EXCEPTION 'Organisation not found' USING ERRCODE = 'P0002';
  END IF;
  DROP TABLE IF EXISTS pg_temp.pl_src;
  DROP TABLE IF EXISTS pg_temp.pl_orders;
  DROP TABLE IF EXISTS pg_temp.pl_lots;
  DROP TABLE IF EXISTS pg_temp.pl_serials;
  DROP TABLE IF EXISTS pg_temp.pl_links;

  -- What is typed, only where the matching link is empty.
  CREATE TEMP TABLE pl_src ON COMMIT DROP AS
    SELECT 'inspection'::text AS kind, i.id, i.part_id, i.site_id, NULL::text AS source, NULL::uuid AS supplier_id, i.lot_size::numeric AS qty,
           CASE WHEN i.production_order_id IS NULL THEN nullif(btrim(i.work_order), '') END AS wo,
           CASE WHEN i.lot_id IS NULL THEN nullif(btrim(i.lot), '') END AS lot,
           CASE WHEN i.serial_id IS NULL THEN nullif(btrim(i.serial), '') END AS serial,
           i.production_order_id AS has_order, i.lot_id AS has_lot, i.serial_id AS has_serial
      FROM public.inspection_records i WHERE i.organisation_id = p_organisation_id
    UNION ALL
    SELECT 'ncr', n.id, n.part_id, n.site_id, n.source, n.supplier_id, NULL::numeric,
           CASE WHEN n.production_order_id IS NULL THEN nullif(btrim(n.work_order), '') END,
           CASE WHEN n.lot_id IS NULL THEN nullif(btrim(n.lot_number), '') END,
           CASE WHEN n.serial_id IS NULL THEN nullif(btrim(n.serial_number), '') END,
           n.production_order_id, n.lot_id, n.serial_id
      FROM public.nonconformances n WHERE n.organisation_id = p_organisation_id AND n.deleted_at IS NULL;
  DELETE FROM pl_src WHERE wo IS NULL AND lot IS NULL AND serial IS NULL;

  SELECT count(*) INTO v_unusable FROM pl_src WHERE (wo IS NOT NULL AND wo !~ rx) OR (lot IS NOT NULL AND lot !~ rx) OR (serial IS NOT NULL AND serial !~ rx);
  UPDATE pl_src SET wo = NULL WHERE wo !~ rx;
  UPDATE pl_src SET lot = NULL WHERE lot !~ rx;
  UPDATE pl_src SET serial = NULL WHERE serial !~ rx;
  SELECT count(*) INTO v_no_part FROM pl_src WHERE part_id IS NULL;
  DELETE FROM pl_src WHERE part_id IS NULL OR (wo IS NULL AND lot IS NULL AND serial IS NULL);

  -- Orders: one per work order number, for the one part it was typed against.
  CREATE TEMP TABLE pl_orders ON COMMIT DROP AS
    SELECT upper(s.wo) AS k, mode() WITHIN GROUP (ORDER BY s.wo) AS number, count(DISTINCT s.part_id)::integer AS parts, (array_agg(s.part_id))[1] AS part_id,
           greatest(1, coalesce(max(s.qty), 1)) AS qty, CASE WHEN count(DISTINCT s.site_id) = 1 THEN (array_agg(s.site_id) FILTER (WHERE s.site_id IS NOT NULL))[1] END AS site_id,
           NULL::uuid AS existing_id, NULL::text AS problem, NULL::uuid AS id
      FROM pl_src s WHERE s.wo IS NOT NULL GROUP BY upper(s.wo);
  UPDATE pl_orders o SET existing_id = po.id FROM public.production_orders po WHERE po.organisation_id = p_organisation_id AND upper(po.order_number) = o.k;
  UPDATE pl_orders SET problem = 'typed against more than one part' WHERE parts > 1;
  UPDATE pl_orders o SET problem = 'already exists for another part' FROM public.production_orders po WHERE po.id = o.existing_id AND po.part_id <> o.part_id AND o.problem IS NULL;
  UPDATE pl_orders SET id = coalesce(existing_id, gen_random_uuid()) WHERE problem IS NULL;

  -- Lots: one per part and lot number.
  CREATE TEMP TABLE pl_lots ON COMMIT DROP AS
    SELECT s.part_id, upper(s.lot) AS k, mode() WITHIN GROUP (ORDER BY s.lot) AS number,
           bool_and(s.kind = 'ncr' AND s.source IN ('supplier', 'goods_receiving')) AS received,
           CASE WHEN count(DISTINCT s.supplier_id) = 1 AND bool_and(s.supplier_id IS NOT NULL) THEN (array_agg(s.supplier_id))[1] END AS supplier_id,
           CASE WHEN count(DISTINCT upper(s.wo)) = 1 AND bool_and(s.wo IS NOT NULL) THEN (array_agg(upper(s.wo)))[1] END AS order_key,
           CASE WHEN count(DISTINCT s.site_id) = 1 THEN (array_agg(s.site_id) FILTER (WHERE s.site_id IS NOT NULL))[1] END AS site_id,
           NULL::uuid AS existing_id, NULL::uuid AS order_id, NULL::uuid AS id
      FROM pl_src s WHERE s.lot IS NOT NULL GROUP BY s.part_id, upper(s.lot);
  UPDATE pl_lots l SET existing_id = x.id FROM public.lots x WHERE x.organisation_id = p_organisation_id AND x.part_id = l.part_id AND upper(x.lot_number) = l.k;
  UPDATE pl_lots l SET order_id = o.id FROM pl_orders o WHERE o.k = l.order_key AND o.problem IS NULL AND o.part_id = l.part_id AND NOT l.received AND l.existing_id IS NULL;
  UPDATE pl_lots SET id = coalesce(existing_id, gen_random_uuid());

  -- Serial numbers: one per part and serial.
  CREATE TEMP TABLE pl_serials ON COMMIT DROP AS
    SELECT s.part_id, upper(s.serial) AS k, mode() WITHIN GROUP (ORDER BY s.serial) AS number,
           CASE WHEN count(DISTINCT upper(s.lot)) = 1 AND bool_and(s.lot IS NOT NULL) THEN (array_agg(upper(s.lot)))[1] END AS lot_key,
           CASE WHEN count(DISTINCT upper(s.wo)) = 1 AND bool_and(s.wo IS NOT NULL) THEN (array_agg(upper(s.wo)))[1] END AS order_key,
           CASE WHEN count(DISTINCT s.site_id) = 1 THEN (array_agg(s.site_id) FILTER (WHERE s.site_id IS NOT NULL))[1] END AS site_id,
           NULL::uuid AS existing_id, NULL::uuid AS lot_id, NULL::uuid AS order_id, NULL::uuid AS id
      FROM pl_src s WHERE s.serial IS NOT NULL GROUP BY s.part_id, upper(s.serial);
  UPDATE pl_serials z SET existing_id = x.id FROM public.serial_numbers x WHERE x.organisation_id = p_organisation_id AND x.part_id = z.part_id AND upper(x.serial_number) = z.k;
  UPDATE pl_serials z SET lot_id = l.id FROM pl_lots l WHERE l.part_id = z.part_id AND l.k = z.lot_key AND z.existing_id IS NULL;
  -- A serial number that has a lot takes its order from the lot.
  UPDATE pl_serials z SET order_id = o.id FROM pl_orders o WHERE o.k = z.order_key AND o.problem IS NULL AND o.part_id = z.part_id AND z.lot_id IS NULL AND z.existing_id IS NULL;
  UPDATE pl_serials SET id = coalesce(existing_id, gen_random_uuid());

  SELECT count(*) FILTER (WHERE existing_id IS NULL AND problem IS NULL), count(*) FILTER (WHERE existing_id IS NOT NULL AND problem IS NULL) INTO v_orders_new, v_orders_matched FROM pl_orders;
  SELECT count(*) FILTER (WHERE existing_id IS NULL), count(*) FILTER (WHERE existing_id IS NOT NULL) INTO v_lots_new, v_lots_matched FROM pl_lots;
  SELECT count(*) FILTER (WHERE existing_id IS NULL), count(*) FILTER (WHERE existing_id IS NOT NULL) INTO v_serials_new, v_serials_matched FROM pl_serials;
  SELECT coalesce(jsonb_agg(jsonb_build_object('number', number, 'reason', problem) ORDER BY number) FILTER (WHERE problem IS NOT NULL), '[]'::jsonb) INTO v_skipped FROM (SELECT * FROM pl_orders WHERE problem IS NOT NULL ORDER BY number LIMIT 25) x;

  -- What each record would be linked to.
  CREATE TEMP TABLE pl_links ON COMMIT DROP AS
    SELECT s.kind, s.id, o.id AS order_id, l.id AS lot_id, z.id AS serial_id
      FROM pl_src s
      LEFT JOIN pl_orders o ON o.k = upper(s.wo) AND o.problem IS NULL
      LEFT JOIN pl_lots l ON l.part_id = s.part_id AND l.k = upper(s.lot)
      LEFT JOIN pl_serials z ON z.part_id = s.part_id AND z.k = upper(s.serial);
  DELETE FROM pl_links WHERE order_id IS NULL AND lot_id IS NULL AND serial_id IS NULL;
  SELECT count(*) INTO v_links FROM pl_links;

  IF p_dry_run THEN
    RETURN jsonb_build_object('dryRun', true,
      'orders', jsonb_build_object('new', v_orders_new, 'matched', v_orders_matched, 'skipped', v_skipped),
      'lots', jsonb_build_object('new', v_lots_new, 'matched', v_lots_matched),
      'serialNumbers', jsonb_build_object('new', v_serials_new, 'matched', v_serials_matched),
      'recordsToLink', v_links, 'noPart', v_no_part, 'unusableText', v_unusable, 'conflicts', 0, 'inspectionsLinked', 0, 'ncrsLinked', 0);
  END IF;

  INSERT INTO public.production_orders (id, organisation_id, order_number, part_id, site_id, quantity_planned, status, notes)
    SELECT id, p_organisation_id, number, part_id, site_id, qty, 'released', 'Created from the work order typed on existing records: check the quantity and status.'
      FROM pl_orders WHERE existing_id IS NULL AND problem IS NULL;
  INSERT INTO public.lots (id, organisation_id, lot_number, part_id, origin, production_order_id, supplier_id, site_id, notes)
    SELECT id, p_organisation_id, number, part_id, CASE WHEN received THEN 'received' ELSE 'produced' END, order_id, CASE WHEN received THEN supplier_id END, site_id,
           'Created from the lot typed on existing records.'
      FROM pl_lots WHERE existing_id IS NULL;
  INSERT INTO public.serial_numbers (id, organisation_id, serial_number, part_id, lot_id, production_order_id, site_id, notes)
    SELECT id, p_organisation_id, number, part_id, lot_id, order_id, site_id, 'Created from the serial number typed on existing records.'
      FROM pl_serials WHERE existing_id IS NULL;

  PERFORM set_config('app.production_backfill', 'on', true);
  FOR r IN SELECT * FROM pl_links LOOP
    BEGIN
      IF r.kind = 'inspection' THEN
        UPDATE public.inspection_records SET production_order_id = coalesce(r.order_id, production_order_id), lot_id = coalesce(r.lot_id, lot_id), serial_id = coalesce(r.serial_id, serial_id) WHERE id = r.id;
        v_inspections := v_inspections + 1;
      ELSE
        UPDATE public.nonconformances SET production_order_id = coalesce(r.order_id, production_order_id), lot_id = coalesce(r.lot_id, lot_id), serial_id = coalesce(r.serial_id, serial_id) WHERE id = r.id;
        v_ncrs := v_ncrs + 1;
      END IF;
    EXCEPTION WHEN SQLSTATE 'QM017' THEN
      v_conflicts := v_conflicts + 1;
    END;
  END LOOP;
  PERFORM set_config('app.production_backfill', '', true);

  RETURN jsonb_build_object('dryRun', false,
    'orders', jsonb_build_object('new', v_orders_new, 'matched', v_orders_matched, 'skipped', v_skipped),
    'lots', jsonb_build_object('new', v_lots_new, 'matched', v_lots_matched),
    'serialNumbers', jsonb_build_object('new', v_serials_new, 'matched', v_serials_matched),
    'recordsToLink', v_links, 'noPart', v_no_part, 'unusableText', v_unusable, 'conflicts', v_conflicts, 'inspectionsLinked', v_inspections, 'ncrsLinked', v_ncrs);
END $$;

-- ---------------------------------------------------------------------------
-- Backfill of factual origins only: the record that raised the NC says where it came from. Nothing is guessed, no category is set.
-- A function (not for signed-in users) so it can be run again and tested; it only touches NCs still marked "internal" and returns how many it moved.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.backfill_ncr_sources() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_total integer := 0; v_n integer;
BEGIN
  UPDATE public.nonconformances n SET source = 'production_inspection'
   WHERE n.source = 'internal' AND EXISTS (SELECT 1 FROM public.inspection_ncr_links l WHERE l.nonconformance_id = n.id);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  UPDATE public.nonconformances n SET source = 'internal_audit'
   WHERE n.source = 'internal' AND EXISTS (SELECT 1 FROM public.audit_ncr_links l WHERE l.nonconformance_id = n.id);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  UPDATE public.nonconformances n SET source = 'calibration'
   WHERE n.source = 'internal' AND EXISTS (SELECT 1 FROM public.calibrations c WHERE c.nonconformance_id = n.id);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;
  RETURN v_total;
END $$;
SELECT app.backfill_ncr_sources();

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app.seed_ncr_categories(uuid), app.seed_ncr_categories_trg(), app.backfill_ncr_sources() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.change_ncr_source(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.change_ncr_source(uuid, text, text) TO authenticated;
REVOKE ALL ON FUNCTION app.raise_ncr_from_inspection(uuid, uuid[], text, text, text, numeric, text, text, boolean, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.raise_ncr_from_inspection(uuid, uuid[], text, text, text, numeric, text, text, boolean, uuid) TO authenticated;
