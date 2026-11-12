-- Risk register RK3 (docs/risk-management-plan.md §13): what a risk is linked to, and raising a risk from a non-conformance, an 8D or an audit finding.
--
--  * `risk_links`: one target per row — a non-conformance, an 8D, an audit finding, a supplier, a part, a part family, a machine, a controlled document,
--    or an operation code (text). Replaced as a whole by app.set_risk_links (risk.manage, while the risk can still change). Links, never copies:
--    the record stays where it is, and who may see its name is that record's own read rule.
--  * Raising from a record: app.risk_draft_from(kind, id) suggests the fields and links (the source must be readable), and
--    app.raise_risk_from(kind, id, data, links) creates the risk through app.create_risk, links the source and records it as the risk's origin.
--    The link to the record a risk was raised from cannot be removed.
-- No table writes: SECURITY DEFINER functions only. Errors QM026 (409 risk_rule); another organisation or a record the caller may not read P0002.

ALTER TABLE public.risks
  ADD COLUMN origin_kind text CHECK (origin_kind IS NULL OR origin_kind IN ('ncr', 'capa', 'audit_finding')),
  ADD COLUMN origin_id uuid,
  ADD CONSTRAINT risks_origin_state_check CHECK ((origin_kind IS NULL) = (origin_id IS NULL));

CREATE TABLE public.risk_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  risk_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('ncr', 'capa', 'audit_finding', 'supplier', 'part', 'part_family', 'machine', 'document', 'operation_code')),
  ncr_id uuid,
  capa_id uuid,
  audit_finding_id uuid,
  supplier_id uuid,
  part_id uuid,
  part_family_id uuid,
  machine_id uuid,
  document_id uuid,
  operation_code text CHECK (operation_code IS NULL OR (length(btrim(operation_code)) BETWEEN 1 AND 40 AND operation_code = btrim(operation_code))),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT risk_links_risk_fkey FOREIGN KEY (risk_id, organisation_id) REFERENCES public.risks (id, organisation_id),
  CONSTRAINT risk_links_ncr_fkey FOREIGN KEY (ncr_id, organisation_id) REFERENCES public.nonconformances (id, organisation_id),
  CONSTRAINT risk_links_capa_fkey FOREIGN KEY (capa_id, organisation_id) REFERENCES public.capas (id, organisation_id),
  CONSTRAINT risk_links_finding_fkey FOREIGN KEY (audit_finding_id, organisation_id) REFERENCES public.audit_findings (id, organisation_id),
  CONSTRAINT risk_links_supplier_fkey FOREIGN KEY (supplier_id, organisation_id) REFERENCES public.suppliers (id, organisation_id),
  CONSTRAINT risk_links_part_fkey FOREIGN KEY (part_id, organisation_id) REFERENCES public.parts (id, organisation_id),
  CONSTRAINT risk_links_family_fkey FOREIGN KEY (part_family_id, organisation_id) REFERENCES public.part_families (id, organisation_id),
  CONSTRAINT risk_links_machine_fkey FOREIGN KEY (machine_id, organisation_id) REFERENCES public.machines (id, organisation_id),
  CONSTRAINT risk_links_document_fkey FOREIGN KEY (document_id, organisation_id) REFERENCES public.documents (id, organisation_id),
  CONSTRAINT risk_links_target_check CHECK (
    num_nonnulls(ncr_id, capa_id, audit_finding_id, supplier_id, part_id, part_family_id, machine_id, document_id, operation_code) = 1
    AND CASE kind
      WHEN 'ncr' THEN ncr_id IS NOT NULL WHEN 'capa' THEN capa_id IS NOT NULL WHEN 'audit_finding' THEN audit_finding_id IS NOT NULL
      WHEN 'supplier' THEN supplier_id IS NOT NULL WHEN 'part' THEN part_id IS NOT NULL WHEN 'part_family' THEN part_family_id IS NOT NULL
      WHEN 'machine' THEN machine_id IS NOT NULL WHEN 'document' THEN document_id IS NOT NULL ELSE operation_code IS NOT NULL END)
);
CREATE UNIQUE INDEX risk_links_target_key ON public.risk_links (risk_id, kind,
  coalesce(ncr_id, capa_id, audit_finding_id, supplier_id, part_id, part_family_id, machine_id, document_id, '00000000-0000-0000-0000-000000000000'::uuid),
  upper(coalesce(operation_code, '')));
CREATE INDEX risk_links_risk_idx ON public.risk_links (organisation_id, risk_id);
CREATE INDEX risk_links_ncr_idx ON public.risk_links (ncr_id) WHERE ncr_id IS NOT NULL;
CREATE INDEX risk_links_capa_idx ON public.risk_links (capa_id) WHERE capa_id IS NOT NULL;
CREATE INDEX risk_links_finding_idx ON public.risk_links (audit_finding_id) WHERE audit_finding_id IS NOT NULL;
CREATE INDEX risk_links_supplier_idx ON public.risk_links (supplier_id) WHERE supplier_id IS NOT NULL;
CREATE INDEX risk_links_part_idx ON public.risk_links (part_id) WHERE part_id IS NOT NULL;
CREATE INDEX risk_links_family_idx ON public.risk_links (part_family_id) WHERE part_family_id IS NOT NULL;
CREATE INDEX risk_links_machine_idx ON public.risk_links (machine_id) WHERE machine_id IS NOT NULL;
CREATE INDEX risk_links_document_idx ON public.risk_links (document_id) WHERE document_id IS NOT NULL;

CREATE TRIGGER risk_links_stamp BEFORE INSERT ON public.risk_links FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER risk_links_touch BEFORE UPDATE ON public.risk_links FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER risk_links_org_immutable BEFORE UPDATE ON public.risk_links FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.risk_links FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.risk_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.risk_links FROM anon, authenticated;
GRANT SELECT ON public.risk_links TO authenticated;
CREATE POLICY risk_links_select ON public.risk_links FOR SELECT TO authenticated USING (app.has_permission(organisation_id, 'risk.read'));

-- The origin of a risk never changes once set (only app.raise_risk_from sets it).
CREATE FUNCTION app.risk_origin_fixed() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF (NEW.origin_kind, NEW.origin_id) IS DISTINCT FROM (OLD.origin_kind, OLD.origin_id) AND OLD.origin_kind IS NOT NULL THEN
    RAISE EXCEPTION 'The record a risk was raised from never changes' USING ERRCODE = 'QM026';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER risks_origin_fixed BEFORE UPDATE OF origin_kind, origin_id ON public.risks FOR EACH ROW EXECUTE FUNCTION app.risk_origin_fixed();

-- Whether the caller may read the record a risk could be raised from (and it is in that organisation): null when not, else its organisation.
CREATE FUNCTION app.risk_source_org(p_kind text, p_id uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid; v_site uuid;
BEGIN
  IF p_kind = 'ncr' THEN
    SELECT organisation_id, site_id INTO v_org, v_site FROM public.nonconformances WHERE id = p_id AND deleted_at IS NULL;
    RETURN CASE WHEN v_org IS NOT NULL AND app.has_permission(v_org, 'ncr.read', v_site) THEN v_org END;
  ELSIF p_kind = 'capa' THEN
    SELECT organisation_id INTO v_org FROM public.capas WHERE id = p_id;
    RETURN CASE WHEN v_org IS NOT NULL AND app.has_permission(v_org, 'capa.read') THEN v_org END;
  ELSIF p_kind = 'audit_finding' THEN
    SELECT organisation_id INTO v_org FROM public.audit_findings WHERE id = p_id;
    RETURN CASE WHEN v_org IS NOT NULL AND app.has_permission(v_org, 'audits.read') THEN v_org END;
  END IF;
  RETURN NULL;
END $$;

-- A suggested risk for a record: {kind, categoryId, title, description, cause, effect, links: [{kind, id | code}], source: {kind, id, reference, title}}.
CREATE FUNCTION app.risk_draft_from(p_kind text, p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_org uuid := app.risk_source_org(p_kind, p_id); n public.nonconformances%ROWTYPE; c public.capas%ROWTYPE; f public.audit_findings%ROWTYPE;
  v_cat text; v_links jsonb := '[]'::jsonb; v_out jsonb;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('ncr', 'capa', 'audit_finding') THEN RAISE EXCEPTION 'A risk is raised from a non-conformance, an 8D or an audit finding' USING ERRCODE = 'QM026'; END IF;
  IF v_org IS NULL OR NOT app.has_permission(v_org, 'risk.read') THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
  IF p_kind = 'ncr' THEN
    SELECT * INTO n FROM public.nonconformances WHERE id = p_id;
    v_cat := CASE WHEN n.source IN ('supplier', 'goods_receiving') OR n.supplier_id IS NOT NULL THEN 'supplier' WHEN n.source = 'customer' THEN 'customer' ELSE 'product' END;
    v_links := jsonb_build_array(jsonb_build_object('kind', 'ncr', 'id', n.id));
    IF n.part_id IS NOT NULL THEN v_links := v_links || jsonb_build_object('kind', 'part', 'id', n.part_id); END IF;
    IF n.supplier_id IS NOT NULL THEN v_links := v_links || jsonb_build_object('kind', 'supplier', 'id', n.supplier_id); END IF;
    IF n.causal_process_id IS NOT NULL THEN v_links := v_links || jsonb_build_object('kind', 'machine', 'id', n.causal_process_id); END IF;
    v_out := jsonb_build_object('title', left(n.title, 200), 'description', left(n.description, 4000), 'cause', NULL, 'effect', NULL,
      'source', jsonb_build_object('kind', 'ncr', 'id', n.id, 'reference', n.reference, 'title', n.title));
  ELSIF p_kind = 'capa' THEN
    SELECT * INTO c FROM public.capas WHERE id = p_id;
    v_cat := 'process';
    v_links := jsonb_build_array(jsonb_build_object('kind', 'capa', 'id', c.id));
    v_out := jsonb_build_object('title', left(c.title, 200), 'description', left(c.problem_statement, 4000),
      'cause', (SELECT left(string_agg(rc.description, E'\n' ORDER BY rc.created_at), 2000) FROM public.capa_root_causes rc
                WHERE rc.capa_id = c.id AND rc.deleted_at IS NULL AND rc.verified_at IS NOT NULL),
      'effect', NULL, 'source', jsonb_build_object('kind', 'capa', 'id', c.id, 'reference', c.reference, 'title', c.title));
  ELSE
    SELECT * INTO f FROM public.audit_findings WHERE id = p_id;
    v_cat := 'compliance';
    v_links := jsonb_build_array(jsonb_build_object('kind', 'audit_finding', 'id', f.id));
    v_links := v_links || coalesce((SELECT jsonb_agg(jsonb_build_object('kind', 'supplier', 'id', t.supplier_id)) FROM public.audit_record_targets t
                                     WHERE t.audit_record_id = f.audit_record_id AND t.supplier_id IS NOT NULL), '[]'::jsonb)
                       || coalesce((SELECT jsonb_agg(jsonb_build_object('kind', 'machine', 'id', t.machine_id)) FROM public.audit_record_targets t
                                     WHERE t.audit_record_id = f.audit_record_id AND t.machine_id IS NOT NULL), '[]'::jsonb);
    v_out := jsonb_build_object('title', left(f.title, 200), 'description', left(f.description, 4000), 'cause', left(f.requirement, 2000), 'effect', NULL,
      'source', jsonb_build_object('kind', 'audit_finding', 'id', f.id, 'reference', f.reference, 'title', f.title));
  END IF;
  RETURN v_out || jsonb_build_object('kind', 'risk', 'links', v_links,
    'categoryId', (SELECT rc.id FROM public.risk_categories rc WHERE rc.organisation_id = v_org AND rc.key = v_cat AND rc.active));
END $$;

-- Replaces every link of a risk. Items: {kind, id} or {kind: 'operation_code', code}. Duplicates are dropped. The record it was raised from stays.
CREATE FUNCTION app.set_risk_links(p_risk uuid, p_links jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.risks%ROWTYPE; e jsonb; v_kind text; v_id uuid; v_code text; v_col text;
BEGIN
  r := app.risk_for_change(p_risk, 'changed');
  IF jsonb_typeof(coalesce(p_links, '[]'::jsonb)) <> 'array' THEN RAISE EXCEPTION 'Send the links as a list' USING ERRCODE = 'QM026'; END IF;
  IF jsonb_array_length(coalesce(p_links, '[]'::jsonb)) > 100 THEN RAISE EXCEPTION 'A risk has at most 100 links' USING ERRCODE = 'QM026'; END IF;
  IF r.origin_kind IS NOT NULL AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(p_links, '[]'::jsonb)) x WHERE x ->> 'kind' = r.origin_kind AND x ->> 'id' = r.origin_id::text) THEN
    RAISE EXCEPTION 'The record % was raised from stays linked', r.reference USING ERRCODE = 'QM026';
  END IF;
  DELETE FROM public.risk_links WHERE risk_id = r.id;
  FOR e IN SELECT * FROM jsonb_array_elements(coalesce(p_links, '[]'::jsonb)) LOOP
    v_kind := e ->> 'kind';
    IF v_kind IS NULL OR v_kind NOT IN ('ncr', 'capa', 'audit_finding', 'supplier', 'part', 'part_family', 'machine', 'document', 'operation_code') THEN
      RAISE EXCEPTION 'A link is to a non-conformance, an 8D, an audit finding, a supplier, a part, a part family, a machine, a document or an operation' USING ERRCODE = 'QM026';
    END IF;
    IF v_kind = 'operation_code' THEN
      v_code := btrim(coalesce(e ->> 'code', ''));
      IF length(v_code) NOT BETWEEN 1 AND 40 THEN RAISE EXCEPTION 'An operation code is 1 to 40 characters' USING ERRCODE = 'QM026'; END IF;
      INSERT INTO public.risk_links (organisation_id, risk_id, kind, operation_code) VALUES (r.organisation_id, r.id, v_kind, v_code) ON CONFLICT DO NOTHING;
    ELSE
      BEGIN v_id := (e ->> 'id')::uuid; EXCEPTION WHEN others THEN v_id := NULL; END;
      IF v_id IS NULL THEN RAISE EXCEPTION 'Each link names the record it is to' USING ERRCODE = 'QM026'; END IF;
      v_col := CASE v_kind WHEN 'ncr' THEN 'ncr_id' WHEN 'capa' THEN 'capa_id' WHEN 'audit_finding' THEN 'audit_finding_id' ELSE v_kind || '_id' END;
      BEGIN
        EXECUTE format('INSERT INTO public.risk_links (organisation_id, risk_id, kind, %I) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', v_col)
          USING r.organisation_id, r.id, v_kind, v_id;
      EXCEPTION WHEN foreign_key_violation THEN
        RAISE EXCEPTION 'That % is not in this organisation', replace(v_kind, '_', ' ') USING ERRCODE = 'QM026';
      END;
    END IF;
  END LOOP;
  UPDATE public.risks SET updated_at = now() WHERE id = r.id;
END $$;

-- Raises a risk from a record: the same fields as app.create_risk, the source linked and kept as the origin, plus any other links given.
CREATE FUNCTION app.raise_risk_from(p_kind text, p_id uuid, p_data jsonb, p_links jsonb DEFAULT '[]'::jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid := app.risk_source_org(p_kind, p_id); v_id uuid; v_links jsonb := coalesce(p_links, '[]'::jsonb);
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('ncr', 'capa', 'audit_finding') THEN RAISE EXCEPTION 'A risk is raised from a non-conformance, an 8D or an audit finding' USING ERRCODE = 'QM026'; END IF;
  IF v_org IS NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
  IF jsonb_typeof(v_links) <> 'array' THEN RAISE EXCEPTION 'Send the links as a list' USING ERRCODE = 'QM026'; END IF;
  v_id := app.create_risk(v_org, p_data);
  UPDATE public.risks SET origin_kind = p_kind, origin_id = p_id WHERE id = v_id;
  PERFORM app.set_risk_links(v_id, jsonb_build_array(jsonb_build_object('kind', p_kind, 'id', p_id)) || v_links);
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION app.risk_origin_fixed(), app.risk_source_org(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.risk_draft_from(text, uuid), app.set_risk_links(uuid, jsonb), app.raise_risk_from(text, uuid, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.risk_draft_from(text, uuid), app.set_risk_links(uuid, jsonb), app.raise_risk_from(text, uuid, jsonb, jsonb) TO authenticated;
