-- Workflow rules WF4 (docs/workflow-engine-plan.md §6): more things a rule can start from, and more it can test.
--
--  * Thirteen new triggers. Seven use events the modules already write: an NC disposition approved, an 8D verified, an 8D closed, an audit completed, a supplier's
--    risk assessed, a part revision released, a control plan revision changing status. Six need an event written here, by AFTER triggers that only call
--    app.emit_event (nothing else changes): an SPC alert raised, a decision on a received line, a SCAR changing status, a supplier's scorecard band falling
--    (scheduled scorecards, SQ5b), a risk assessed, a quality alert issued.
--  * More facts to test on the existing triggers: an NC's quantity affected, total cost (base currency, live lines) and title; an inspection's work order and lot;
--    an 8D's stage and title; a finding's title.
--  * Numbers and words: the API now tests numbers (more than, less than, at least, at most, equal) and words (contains, does not contain); the facts carry
--    numbers as JSON numbers.
-- app.workflow_triggers() and app.system_workflow_facts() are replaced (both were last defined in 20260221100000); every earlier branch is kept as it was, with
-- the extra keys added. Nothing here writes a record of a module: rules still only tell people, give tasks and hold lots (W6).

-- ---------------------------------------------------------------------------
-- What a rule can start from
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.workflow_triggers() RETURNS TABLE (event_type text, entity_type text, label text, permission text)
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  VALUES
    ('ncr.created',                          'nonconformance',           'A non-conformance is raised',                   'ncr.read'),
    ('ncr.stage_changed',                    'nonconformance',           'A non-conformance moves to another stage',      'ncr.read'),
    ('ncr.disposition.approved',             'ncr_disposition',          'A disposition is approved on a non-conformance', 'ncr.read'),
    ('inspection.measurement.failed',        'inspection_measurement',   'An inspection reading fails',                   'inspection.read'),
    ('spc.alert.raised',                     'spc_alert',                'An SPC alert is raised',                        'spc.read'),
    ('control_plan.revision.status_changed', 'control_plan_revision',    'A control plan revision changes status',        'process_control.read'),
    ('part.revision.released',               'part_revision',            'A part revision is released',                   'master_data.read'),
    ('calibration.recorded',                 'calibration',              'A calibration is recorded',                     'calibration.read'),
    ('gauge.status_changed',                 'gauge',                    'A gauge changes status',                        'calibration.read'),
    ('capa.created',                         'capa',                     'An 8D is started',                              'capa.read'),
    ('capa.verified',                        'capa',                     'An 8D''s actions are verified',                 'capa.read'),
    ('capa.closed',                          'capa',                     'An 8D is closed',                               'capa.read'),
    ('audit.completed',                      'audit_record',             'An audit is completed',                         'audits.read'),
    ('audit.finding.created',                'audit_finding',            'An audit finding is raised',                    'audits.read'),
    ('supplier.approval_status_changed',     'supplier',                 'A supplier''s approval status changes',         'supplier_quality.read'),
    ('supplier.risk_assessed',               'supplier',                 'A supplier''s risk is assessed',                'supplier_quality.read'),
    ('supplier.band_dropped',                'supplier_band_drop',       'A supplier''s scorecard band falls',            'supplier_quality.read'),
    ('scar.status_changed',                  'scar',                     'A SCAR changes status',                         'supplier_quality.read'),
    ('receipt.line.decided',                 'receipt_line_disposition', 'A decision is made on a received line',         'receiving.read'),
    ('risk.assessed',                        'risk_assessment',          'A risk is assessed',                            'risk.read'),
    ('quality_alert.issued',                 'quality_alert',            'A quality alert is issued',                     'documentation.read')
$$;

-- ---------------------------------------------------------------------------
-- The events that were not written before (each trigger only writes to the outbox)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.workflow_emit_spc_alert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.emit_event(NEW.organisation_id, 'spc.alert.raised', 'spc_alert', NEW.id, jsonb_build_object('rule', NEW.rule, 'part_number', NEW.part_number));
  RETURN NULL;
END $$;
CREATE TRIGGER spc_alerts_workflow_event AFTER INSERT ON public.spc_alerts FOR EACH ROW EXECUTE FUNCTION app.workflow_emit_spc_alert();

CREATE FUNCTION app.workflow_emit_receipt_decision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.emit_event(NEW.organisation_id, 'receipt.line.decided', 'receipt_line_disposition', NEW.id,
    jsonb_build_object('receipt_line_id', NEW.receipt_line_id, 'decision', NEW.decision));
  RETURN NULL;
END $$;
CREATE TRIGGER receipt_line_dispositions_workflow_event AFTER INSERT ON public.receipt_line_dispositions FOR EACH ROW EXECUTE FUNCTION app.workflow_emit_receipt_decision();

CREATE FUNCTION app.workflow_emit_scar_status() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.emit_event(NEW.organisation_id, 'scar.status_changed', 'scar', NEW.id, jsonb_build_object('reference', NEW.reference, 'from', OLD.status, 'to', NEW.status));
  RETURN NULL;
END $$;
CREATE TRIGGER supplier_scars_workflow_event AFTER UPDATE OF status ON public.supplier_scars
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION app.workflow_emit_scar_status();

CREATE FUNCTION app.workflow_emit_band_drop() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.emit_event(NEW.organisation_id, 'supplier.band_dropped', 'supplier_band_drop', NEW.id,
    jsonb_build_object('supplier_id', NEW.supplier_id, 'from', NEW.from_band, 'to', NEW.to_band, 'period_kind', NEW.period_kind));
  RETURN NULL;
END $$;
CREATE TRIGGER supplier_band_drops_workflow_event AFTER INSERT ON public.supplier_band_drops FOR EACH ROW EXECUTE FUNCTION app.workflow_emit_band_drop();

CREATE FUNCTION app.workflow_emit_risk_assessed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.emit_event(NEW.organisation_id, 'risk.assessed', 'risk_assessment', NEW.id, jsonb_build_object('risk_id', NEW.risk_id, 'phase', NEW.phase, 'band', NEW.band));
  RETURN NULL;
END $$;
CREATE TRIGGER risk_assessments_workflow_event AFTER INSERT ON public.risk_assessments FOR EACH ROW EXECUTE FUNCTION app.workflow_emit_risk_assessed();

CREATE FUNCTION app.workflow_emit_quality_alert_issued() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.emit_event(NEW.organisation_id, 'quality_alert.issued', 'quality_alert', NEW.id, jsonb_build_object('reference', NEW.reference, 'revision', NEW.revision));
  RETURN NULL;
END $$;
CREATE TRIGGER quality_alerts_workflow_event AFTER UPDATE OF status ON public.quality_alerts
  FOR EACH ROW WHEN (OLD.status = 'draft' AND NEW.status = 'active') EXECUTE FUNCTION app.workflow_emit_quality_alert_issued();

-- ---------------------------------------------------------------------------
-- What a rule can test
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.system_workflow_facts(p_organisation_id uuid, p_entity_type text, p_entity_id uuid, p_payload jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v jsonb;
BEGIN
  IF p_entity_type IN ('nonconformance', 'ncr_disposition') THEN
    SELECT jsonb_build_object('label', n.reference || ' · ' || n.title, 'record_kind', 'nonconformance', 'record_id', n.id, 'site_id', n.site_id, 'owner_user_id', n.owner_id,
             'source', n.source, 'severity', n.severity, 'stage', n.stage, 'to_stage', coalesce(p_payload ->> 'to', n.stage),
             'category', c.code, 'part_id', n.part_id, 'part_family_id', p.part_family_id, 'supplier_id', n.supplier_id, 'customer_id', n.customer_id,
             'title', n.title, 'quantity_affected', n.quantity_affected,
             'total_cost', (SELECT coalesce(sum(k.net_base), 0) FROM public.ncr_costs k WHERE k.nonconformance_id = n.id AND k.deleted_at IS NULL))
      INTO v FROM public.nonconformances n
      LEFT JOIN public.ncr_classifications c ON c.id = n.category_id
      LEFT JOIN public.parts p ON p.id = n.part_id
     WHERE n.id = p_entity_id AND n.organisation_id = p_organisation_id AND n.deleted_at IS NULL;
    IF v IS NOT NULL AND p_entity_type = 'ncr_disposition' THEN
      v := v || coalesce((SELECT jsonb_build_object('decision', d.decision, 'disposition_quantity', d.quantity)
                            FROM public.ncr_dispositions d
                           WHERE d.id = nullif(p_payload ->> 'disposition_id', '')::uuid AND d.nonconformance_id = p_entity_id),
                         jsonb_build_object('decision', p_payload ->> 'decision', 'disposition_quantity', (p_payload ->> 'quantity')::numeric));
    END IF;
  ELSIF p_entity_type = 'inspection_measurement' THEN
    SELECT jsonb_build_object('label', i.reference || ' · ' || coalesce(q.char_number || ' ', '') || q.name || ' failed', 'record_kind', 'inspection', 'record_id', i.id,
             'site_id', i.site_id, 'owner_user_id', m.created_by,
             'part_id', i.part_id, 'part_family_id', p.part_family_id, 'machine_id', i.machine_id, 'operation_code', i.operation_code,
             'characteristic_key', q.characteristic_key, 'criticality', q.criticality, 'trigger_type', i.trigger_type,
             'work_order', i.work_order, 'lot', i.lot)
      INTO v FROM public.inspection_measurements m
      JOIN public.inspection_records i ON i.id = m.inspection_record_id
      JOIN public.resolved_inspection_requirements q ON q.id = m.requirement_id
      LEFT JOIN public.parts p ON p.id = i.part_id
     WHERE m.id = p_entity_id AND m.organisation_id = p_organisation_id;
  ELSIF p_entity_type = 'spc_alert' THEN
    SELECT jsonb_build_object('label', a.part_number || ' · ' || a.characteristic_name || ': ' || a.summary, 'record_kind', 'spc_alert', 'record_id', a.id,
             'site_id', i.site_id, 'owner_user_id', i.created_by, 'rule', a.rule, 'variant', a.variant, 'side', a.side,
             'part_id', a.part_id, 'part_family_id', p.part_family_id, 'machine_id', i.machine_id, 'operation_code', a.operation_code, 'characteristic_key', a.characteristic_key)
      INTO v FROM public.spc_alerts a
      LEFT JOIN public.inspection_records i ON i.id = a.inspection_record_id
      LEFT JOIN public.parts p ON p.id = a.part_id
     WHERE a.id = p_entity_id AND a.organisation_id = p_organisation_id;
  ELSIF p_entity_type = 'control_plan_revision' THEN
    SELECT jsonb_build_object('label', c.plan_code || ' rev ' || r.revision_code, 'record_kind', 'control_plan', 'record_id', c.id, 'site_id', NULL, 'owner_user_id', r.created_by,
             'to_status', coalesce(p_payload ->> 'to', r.status), 'from_status', p_payload ->> 'from', 'plan_code', c.plan_code)
      INTO v FROM public.control_plan_revisions r JOIN public.control_plans c ON c.id = r.control_plan_id
     WHERE r.id = p_entity_id AND r.organisation_id = p_organisation_id;
  ELSIF p_entity_type = 'part_revision' THEN
    SELECT jsonb_build_object('label', p.part_number || ' rev ' || r.revision || ' · ' || p.name, 'record_kind', 'part', 'record_id', p.id, 'site_id', NULL, 'owner_user_id', NULL,
             'part_id', p.id, 'part_family_id', p.part_family_id, 'revision', r.revision)
      INTO v FROM public.part_revisions r JOIN public.parts p ON p.id = r.part_id
     WHERE r.id = p_entity_id AND r.organisation_id = p_organisation_id;
  ELSIF p_entity_type = 'calibration' THEN
    SELECT jsonb_build_object('label', c.reference || ' · ' || g.asset_number || ' ' || g.description, 'record_kind', 'gauge', 'record_id', g.id,
             'site_id', g.site_id, 'owner_user_id', g.custodian_id, 'outcome', c.outcome, 'gauge_type_id', g.gauge_type_id, 'gauge_id', g.id,
             'performed_by', c.performed_by)
      INTO v FROM public.calibrations c JOIN public.gauges g ON g.id = c.gauge_id
     WHERE c.id = p_entity_id AND c.organisation_id = p_organisation_id AND c.deleted_at IS NULL;
  ELSIF p_entity_type = 'gauge' THEN
    SELECT jsonb_build_object('label', g.asset_number || ' · ' || g.description, 'record_kind', 'gauge', 'record_id', g.id,
             'site_id', g.site_id, 'owner_user_id', g.custodian_id, 'status', g.status, 'gauge_type_id', g.gauge_type_id, 'gauge_id', g.id)
      INTO v FROM public.gauges g WHERE g.id = p_entity_id AND g.organisation_id = p_organisation_id AND g.deleted_at IS NULL;
  ELSIF p_entity_type = 'capa' THEN
    SELECT jsonb_build_object('label', c.reference || ' · ' || c.title, 'record_kind', 'capa', 'record_id', c.id, 'site_id', NULL, 'owner_user_id', m.user_id,
             'source', c.source, 'severity', c.severity, 'stage', c.stage, 'title', c.title,
             'effective', CASE WHEN p_payload ? 'effective' THEN CASE WHEN (p_payload ->> 'effective')::boolean THEN 'yes' ELSE 'no' END END)
      INTO v FROM public.capas c LEFT JOIN public.organisation_users m ON m.id = c.owner_membership_id
     WHERE c.id = p_entity_id AND c.organisation_id = p_organisation_id;
  ELSIF p_entity_type = 'audit_record' THEN
    SELECT jsonb_build_object('label', r.reference || ' · ' || r.audit_title, 'record_kind', 'audit_record', 'record_id', r.id, 'site_id', NULL,
             'owner_user_id', coalesce(r.completed_by, r.started_by), 'result', r.result, 'score', r.score, 'audit_type', r.audit_type,
             'critical_failed', r.critical_failed_count, 'failed', r.failed_count,
             'supplier_id', (SELECT t.supplier_id FROM public.audit_record_targets t WHERE t.audit_record_id = r.id AND t.supplier_id IS NOT NULL ORDER BY t.id LIMIT 1),
             'machine_id', (SELECT t.machine_id FROM public.audit_record_targets t WHERE t.audit_record_id = r.id AND t.machine_id IS NOT NULL ORDER BY t.id LIMIT 1))
      INTO v FROM public.audit_records r WHERE r.id = p_entity_id AND r.organisation_id = p_organisation_id;
  ELSIF p_entity_type = 'audit_finding' THEN
    SELECT jsonb_build_object('label', f.reference || ' · ' || f.title, 'record_kind', 'audit_finding', 'record_id', f.id, 'site_id', NULL, 'owner_user_id', e.auth_id,
             'classification', k.key, 'finding_kind', k.kind, 'title', f.title)
      INTO v FROM public.audit_findings f
      JOIN public.audit_finding_classifications k ON k.id = f.classification_id
      LEFT JOIN public."Employees" e ON e.id = f.owner_employee_id AND e.organisation_id = f.organisation_id
     WHERE f.id = p_entity_id AND f.organisation_id = p_organisation_id;
  ELSIF p_entity_type = 'supplier' THEN
    SELECT jsonb_build_object('label', s.code || ' · ' || coalesce(s.display_name, s.name), 'record_kind', 'supplier', 'record_id', s.id, 'site_id', NULL, 'owner_user_id', NULL,
             'approval_status', s.approval_status, 'risk_rating', s.risk_rating, 'supplier_type', s.supplier_type, 'supplier_id', s.id,
             'previous_risk_rating', p_payload ->> 'from')
      INTO v FROM public.suppliers s WHERE s.id = p_entity_id AND s.organisation_id = p_organisation_id;
  ELSIF p_entity_type = 'supplier_band_drop' THEN
    SELECT jsonb_build_object('label', d.supplier_label || ' · ' || d.change_label, 'record_kind', 'supplier', 'record_id', d.supplier_id, 'site_id', NULL, 'owner_user_id', NULL,
             'supplier_id', d.supplier_id, 'from_band', d.from_band, 'to_band', d.to_band, 'period_kind', d.period_kind,
             'approval_status', s.approval_status, 'risk_rating', s.risk_rating, 'score', c.score)
      INTO v FROM public.supplier_band_drops d
      JOIN public.suppliers s ON s.id = d.supplier_id
      JOIN public.supplier_scorecards c ON c.id = d.scorecard_id
     WHERE d.id = p_entity_id AND d.organisation_id = p_organisation_id;
  ELSIF p_entity_type = 'scar' THEN
    SELECT jsonb_build_object('label', x.reference || ' · ' || x.title, 'record_kind', 'scar', 'record_id', x.id, 'site_id', NULL, 'owner_user_id', x.owner_user_id,
             'to_status', coalesce(p_payload ->> 'to', x.status), 'from_status', p_payload ->> 'from', 'severity', x.severity, 'supplier_id', x.supplier_id, 'title', x.title)
      INTO v FROM public.supplier_scars x WHERE x.id = p_entity_id AND x.organisation_id = p_organisation_id;
  ELSIF p_entity_type = 'receipt_line_disposition' THEN
    SELECT jsonb_build_object('label', g.reference || ' line ' || l.line_number || ' · ' || coalesce(p.part_number, l.material, 'material') || ': ' || d.decision,
             'record_kind', 'goods_receipt', 'record_id', g.id, 'site_id', g.site_id, 'owner_user_id', g.created_by,
             'decision', d.decision, 'supplier_id', g.supplier_id, 'part_id', l.part_id, 'part_family_id', p.part_family_id,
             'quantity_received', l.quantity_received, 'quantity_rejected', CASE WHEN d.decision = 'rejected' THEN coalesce(d.quantity_rejected, l.quantity_received) END)
      INTO v FROM public.receipt_line_dispositions d
      JOIN public.goods_receipt_lines l ON l.id = d.receipt_line_id
      JOIN public.goods_receipts g ON g.id = l.goods_receipt_id
      LEFT JOIN public.parts p ON p.id = l.part_id
     WHERE d.id = p_entity_id AND d.organisation_id = p_organisation_id;
  ELSIF p_entity_type = 'risk_assessment' THEN
    SELECT jsonb_build_object('label', k.reference || ' · ' || k.title, 'record_kind', 'risk', 'record_id', k.id, 'site_id', k.site_id, 'owner_user_id', k.owner_user_id,
             'phase', a.phase, 'band', a.band, 'score', a.score, 'previous_band', prev.band, 'kind', k.kind, 'category', c.key, 'title', k.title)
      INTO v FROM public.risk_assessments a
      JOIN public.risks k ON k.id = a.risk_id
      JOIN public.risk_categories c ON c.id = k.category_id
      LEFT JOIN public.risk_assessments prev ON prev.id = a.supersedes_id
     WHERE a.id = p_entity_id AND a.organisation_id = p_organisation_id;
  ELSIF p_entity_type = 'quality_alert' THEN
    SELECT jsonb_build_object('label', q.reference || ' · ' || q.title, 'record_kind', 'quality_alert', 'record_id', q.id, 'site_id', NULL, 'owner_user_id', q.issued_by,
             'severity', q.severity, 'category', q.category, 'revision', q.revision, 'title', q.title)
      INTO v FROM public.quality_alerts q WHERE q.id = p_entity_id AND q.organisation_id = p_organisation_id AND q.deleted_at IS NULL;
  END IF;
  RETURN v;
END $$;

REVOKE ALL ON FUNCTION app.workflow_emit_spc_alert(), app.workflow_emit_receipt_decision(), app.workflow_emit_scar_status(), app.workflow_emit_band_drop(),
  app.workflow_emit_risk_assessed(), app.workflow_emit_quality_alert_issued() FROM PUBLIC, anon, authenticated;
