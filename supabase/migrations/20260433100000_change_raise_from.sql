-- Change management, slice CH4 (docs/change-management-plan.md): raising a change from a record.
--
--  * A change can come from a non-conformance, an 8D, ONE ACTION of an 8D (a corrective or preventive action: "we will change the drawing"), an audit finding,
--    a risk, an ACCEPTED document change request, or a management review decision. The new origin kinds are `capa_action` and `management_review_decision`.
--    The origin is set at creation and never changes (CH1 trigger); the person must be able to read the record it comes from (`app.change_source_org`).
--  * app.change_draft_from(kind, id) suggests the change for a record — title, what, why, the type, and what it covers (the parts, machines, suppliers…
--    the record names) — so the raise dialog starts filled in. It saves nothing; it needs change.manage and the right to read the source.
-- Nothing else is new in the database: the "Changes" card on a record's page and the trace page read through row-level security, as the caller.
-- Errors QM035 (409 change_rule); a record the caller may not read, or another organisation's, is P0002 (404).

-- ---------------------------------------------------------------------------
-- 1. The origin kinds
-- ---------------------------------------------------------------------------
ALTER TABLE public.change_requests DROP CONSTRAINT change_requests_origin_kind_check;
ALTER TABLE public.change_requests ADD CONSTRAINT change_requests_origin_kind_check
  CHECK (origin_kind IS NULL OR origin_kind IN ('ncr', 'capa', 'capa_action', 'audit_finding', 'risk', 'document_change_request', 'management_review_decision'));

-- Whether the caller may read the record a change could be raised from (and which organisation it is in): its organisation, else NULL. A document change
-- request counts only once it has been accepted; an 8D action only when it is a corrective or preventive one.
CREATE OR REPLACE FUNCTION app.change_source_org(p_kind text, p_id uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid; v_site uuid; v_ok boolean;
BEGIN
  IF p_kind = 'ncr' THEN
    SELECT organisation_id, site_id INTO v_org, v_site FROM public.nonconformances WHERE id = p_id AND deleted_at IS NULL;
    RETURN CASE WHEN v_org IS NOT NULL AND app.has_permission(v_org, 'ncr.read', v_site) THEN v_org END;
  ELSIF p_kind = 'capa' THEN
    SELECT organisation_id INTO v_org FROM public.capas WHERE id = p_id;
    RETURN CASE WHEN v_org IS NOT NULL AND app.has_permission(v_org, 'capa.read') THEN v_org END;
  ELSIF p_kind = 'capa_action' THEN
    SELECT organisation_id, phase IN ('corrective', 'preventive') AND status <> 'cancelled' INTO v_org, v_ok FROM public.capa_actions WHERE id = p_id;
    RETURN CASE WHEN v_org IS NOT NULL AND v_ok AND app.has_permission(v_org, 'capa.read') THEN v_org END;
  ELSIF p_kind = 'audit_finding' THEN
    SELECT organisation_id INTO v_org FROM public.audit_findings WHERE id = p_id;
    RETURN CASE WHEN v_org IS NOT NULL AND app.has_permission(v_org, 'audits.read') THEN v_org END;
  ELSIF p_kind = 'risk' THEN
    SELECT organisation_id INTO v_org FROM public.risks WHERE id = p_id;
    RETURN CASE WHEN v_org IS NOT NULL AND app.has_permission(v_org, 'risk.read') THEN v_org END;
  ELSIF p_kind = 'document_change_request' THEN
    SELECT organisation_id, status = 'accepted' INTO v_org, v_ok FROM public.document_change_requests WHERE id = p_id;
    RETURN CASE WHEN v_org IS NOT NULL AND v_ok AND app.has_permission(v_org, 'documentation.manage') THEN v_org END;
  ELSIF p_kind = 'management_review_decision' THEN
    SELECT organisation_id INTO v_org FROM public.management_review_decisions WHERE id = p_id;
    RETURN CASE WHEN v_org IS NOT NULL AND app.has_permission(v_org, 'management_review.read') THEN v_org END;
  END IF;
  RETURN NULL;
END $$;

-- create_change accepts the new kinds (a checked text patch of its live definition: the migration refuses to finish unless each anchor is found once).
CREATE FUNCTION pg_temp.patch(p_fn regprocedure, p_old text, p_new text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_def text := replace(pg_get_functiondef(p_fn), E'\r', ''); v_n integer;
BEGIN
  v_n := (length(v_def) - length(replace(v_def, p_old, ''))) / length(p_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'Expected to find % exactly once in %, found % times', p_old, p_fn, v_n; END IF;
  EXECUTE replace(v_def, p_old, p_new);
END $$;

SELECT pg_temp.patch('app.create_change(uuid, jsonb)'::regprocedure,
  E'v_kind NOT IN (''ncr'', ''capa'', ''audit_finding'', ''risk'', ''document_change_request'')',
  E'v_kind NOT IN (''ncr'', ''capa'', ''capa_action'', ''audit_finding'', ''risk'', ''document_change_request'', ''management_review_decision'')');
SELECT pg_temp.patch('app.create_change(uuid, jsonb)'::regprocedure,
  E'''A change is raised from a non-conformance, an 8D, an audit finding, a risk or a document change request''',
  E'''A change is raised from a non-conformance, an 8D or one of its actions, an audit finding, a risk, an accepted document change request or a management review decision''');

-- ---------------------------------------------------------------------------
-- 2. The suggestion
-- ---------------------------------------------------------------------------
-- {title, description, reason, typeId, urgency, links: [{kind, id | code}], source: {kind, id, reference, title}}. Saves nothing. Links are only the kinds a
-- change can cover (part, part family, machine, supplier, customer, operation); duplicates are dropped.
CREATE FUNCTION app.change_draft_from(p_kind text, p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_org uuid := app.change_source_org(p_kind, p_id);
  n public.nonconformances%ROWTYPE; c public.capas%ROWTYPE; a public.capa_actions%ROWTYPE; f public.audit_findings%ROWTYPE; r public.risks%ROWTYPE;
  d public.document_change_requests%ROWTYPE; m public.management_review_decisions%ROWTYPE; v_review public.management_reviews%ROWTYPE; v_doc public.documents%ROWTYPE;
  v_type text := 'process'; v_links jsonb := '[]'::jsonb; v_out jsonb; v_cause text;
BEGIN
  IF v_org IS NULL OR NOT app.has_permission(v_org, 'change.manage') THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
  IF p_kind = 'ncr' THEN
    SELECT * INTO n FROM public.nonconformances WHERE id = p_id;
    v_type := CASE WHEN n.source IN ('supplier', 'goods_receiving') OR n.supplier_id IS NOT NULL THEN 'material' ELSE 'process' END;
    IF n.part_id IS NOT NULL THEN v_links := v_links || jsonb_build_object('kind', 'part', 'id', n.part_id); END IF;
    IF n.supplier_id IS NOT NULL THEN v_links := v_links || jsonb_build_object('kind', 'supplier', 'id', n.supplier_id); END IF;
    IF n.customer_id IS NOT NULL THEN v_links := v_links || jsonb_build_object('kind', 'customer', 'id', n.customer_id); END IF;
    IF n.causal_process_id IS NOT NULL THEN v_links := v_links || jsonb_build_object('kind', 'machine', 'id', n.causal_process_id); END IF;
    v_out := jsonb_build_object('title', left('Change after ' || n.reference || ': ' || n.title, 200), 'description', NULL,
      'reason', left(concat_ws(E'\n', n.reference || ' · ' || n.title, n.description, 'Requirement: ' || n.requirement, 'Found: ' || n.actual_result), 4000),
      'source', jsonb_build_object('kind', 'ncr', 'id', n.id, 'reference', n.reference, 'title', n.title));
  ELSIF p_kind IN ('capa', 'capa_action') THEN
    IF p_kind = 'capa_action' THEN
      SELECT * INTO a FROM public.capa_actions WHERE id = p_id;
      SELECT * INTO c FROM public.capas WHERE id = a.capa_id;
      SELECT left(string_agg(rc.description, E'\n' ORDER BY rc.created_at), 1500) INTO v_cause FROM public.capa_root_causes rc
       WHERE rc.id = a.root_cause_id AND rc.deleted_at IS NULL;
    ELSE
      SELECT * INTO c FROM public.capas WHERE id = p_id;
      SELECT left(string_agg(rc.description, E'\n' ORDER BY rc.created_at), 1500) INTO v_cause FROM public.capa_root_causes rc
       WHERE rc.capa_id = c.id AND rc.deleted_at IS NULL AND rc.verified_at IS NOT NULL;
    END IF;
    v_links := coalesce((SELECT jsonb_agg(DISTINCT jsonb_build_object('kind', 'part', 'id', k.part_id)) FROM public.capa_ncr_links l
                           JOIN public.nonconformances k ON k.id = l.nonconformance_id WHERE l.capa_id = c.id AND l.ended_at IS NULL AND k.part_id IS NOT NULL), '[]'::jsonb)
             || coalesce((SELECT jsonb_agg(DISTINCT jsonb_build_object('kind', 'supplier', 'id', k.supplier_id)) FROM public.capa_ncr_links l
                           JOIN public.nonconformances k ON k.id = l.nonconformance_id WHERE l.capa_id = c.id AND l.ended_at IS NULL AND k.supplier_id IS NOT NULL), '[]'::jsonb);
    IF p_kind = 'capa_action' THEN
      v_out := jsonb_build_object('title', left(a.description, 200), 'description', left(a.description, 4000),
        'reason', left(concat_ws(E'\n', c.reference || ' · ' || c.title, 'Root cause: ' || v_cause, 'Problem: ' || c.problem_statement), 4000),
        'source', jsonb_build_object('kind', 'capa_action', 'id', a.id, 'reference', c.reference, 'title', left(a.description, 120)));
    ELSE
      v_out := jsonb_build_object('title', left('Change after ' || c.reference || ': ' || c.title, 200), 'description', NULL,
        'reason', left(concat_ws(E'\n', c.reference || ' · ' || c.title, 'Problem: ' || c.problem_statement, 'Root cause: ' || v_cause), 4000),
        'source', jsonb_build_object('kind', 'capa', 'id', c.id, 'reference', c.reference, 'title', c.title));
    END IF;
  ELSIF p_kind = 'audit_finding' THEN
    SELECT * INTO f FROM public.audit_findings WHERE id = p_id;
    v_type := 'documentation';
    v_links := coalesce((SELECT jsonb_agg(jsonb_build_object('kind', 'supplier', 'id', t.supplier_id)) FROM public.audit_record_targets t
                          WHERE t.audit_record_id = f.audit_record_id AND t.supplier_id IS NOT NULL), '[]'::jsonb)
            || coalesce((SELECT jsonb_agg(jsonb_build_object('kind', 'machine', 'id', t.machine_id)) FROM public.audit_record_targets t
                          WHERE t.audit_record_id = f.audit_record_id AND t.machine_id IS NOT NULL), '[]'::jsonb);
    v_out := jsonb_build_object('title', left('Change after ' || f.reference || ': ' || f.title, 200), 'description', NULL,
      'reason', left(concat_ws(E'\n', f.reference || ' · ' || f.title, f.description, 'Requirement: ' || f.requirement), 4000),
      'source', jsonb_build_object('kind', 'audit_finding', 'id', f.id, 'reference', f.reference, 'title', f.title));
  ELSIF p_kind = 'risk' THEN
    SELECT * INTO r FROM public.risks WHERE id = p_id;
    v_links := coalesce((SELECT jsonb_agg(jsonb_build_object('kind', l.kind, 'id', coalesce(l.part_id, l.part_family_id, l.machine_id, l.supplier_id)))
                           FROM public.risk_links l WHERE l.risk_id = r.id AND l.kind IN ('part', 'part_family', 'machine', 'supplier')), '[]'::jsonb)
            || coalesce((SELECT jsonb_agg(jsonb_build_object('kind', 'operation_code', 'code', l.operation_code))
                           FROM public.risk_links l WHERE l.risk_id = r.id AND l.kind = 'operation_code'), '[]'::jsonb);
    v_out := jsonb_build_object('title', left('Change for ' || r.reference || ': ' || r.title, 200), 'description', NULL,
      'reason', left(concat_ws(E'\n', r.reference || ' · ' || r.title, r.description, 'Cause: ' || r.cause, 'Effect: ' || r.effect), 4000),
      'source', jsonb_build_object('kind', 'risk', 'id', r.id, 'reference', r.reference, 'title', r.title));
  ELSIF p_kind = 'document_change_request' THEN
    SELECT * INTO d FROM public.document_change_requests WHERE id = p_id;
    SELECT * INTO v_doc FROM public.documents WHERE id = d.document_id;
    v_type := 'documentation';
    v_links := coalesce((SELECT jsonb_agg(jsonb_build_object('kind', 'part', 'id', l.part_id)) FROM public.document_links l WHERE l.document_id = d.document_id AND l.part_id IS NOT NULL), '[]'::jsonb)
            || coalesce((SELECT jsonb_agg(jsonb_build_object('kind', 'part_family', 'id', l.part_family_id)) FROM public.document_links l WHERE l.document_id = d.document_id AND l.part_family_id IS NOT NULL), '[]'::jsonb)
            || coalesce((SELECT jsonb_agg(jsonb_build_object('kind', 'machine', 'id', l.machine_id)) FROM public.document_links l WHERE l.document_id = d.document_id AND l.machine_id IS NOT NULL), '[]'::jsonb)
            || coalesce((SELECT jsonb_agg(jsonb_build_object('kind', 'operation_code', 'code', l.operation_code)) FROM public.document_links l WHERE l.document_id = d.document_id AND l.operation_code IS NOT NULL), '[]'::jsonb);
    v_out := jsonb_build_object('title', left('Change to ' || v_doc.number || ': ' || v_doc.title, 200), 'description', left(d.what, 4000), 'reason', left(d.why, 4000),
      'source', jsonb_build_object('kind', 'document_change_request', 'id', d.id, 'reference', d.reference, 'title', v_doc.number || ' · ' || v_doc.title));
  ELSE
    SELECT * INTO m FROM public.management_review_decisions WHERE id = p_id;
    SELECT * INTO v_review FROM public.management_reviews WHERE id = m.review_id;
    v_type := CASE m.category WHEN 'qms_change' THEN 'documentation' WHEN 'improvement' THEN 'process' ELSE 'other' END;
    v_out := jsonb_build_object('title', left(m.description, 200), 'description', left(m.description, 4000),
      'reason', left('Decided at management review ' || v_review.reference || ' · ' || v_review.title, 4000),
      'source', jsonb_build_object('kind', 'management_review_decision', 'id', m.id, 'reference', v_review.reference, 'title', left(m.description, 120)));
  END IF;
  RETURN v_out || jsonb_build_object('urgency', 'normal', 'links', coalesce((SELECT jsonb_agg(DISTINCT x) FROM jsonb_array_elements(v_links) x), '[]'::jsonb),
    'typeId', (SELECT t.id FROM public.change_types t WHERE t.organisation_id = v_org AND t.key = v_type AND t.active));
END $$;

REVOKE ALL ON FUNCTION app.change_source_org(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.change_draft_from(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.change_draft_from(text, uuid) TO authenticated;
