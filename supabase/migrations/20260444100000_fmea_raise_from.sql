-- FMEA FM5c-2: an FMEA, or a new revision of one, can be raised from a record, and the reason is kept (plan FM13). The sources are a non-conformance, an 8D, an audit finding, a
-- supplier corrective action request (SCAR) and a change. Where it came from is set once and never changed (the trigger holds it for SQL too).
--
-- Needs FM1 to FM5b first. Written so it can be run again: columns and constraints are guarded and functions are replaced.

-- ---------------------------------------------------------------------------
-- 1. Where it came from
-- ---------------------------------------------------------------------------
ALTER TABLE public.fmeas ADD COLUMN IF NOT EXISTS origin_kind text;
ALTER TABLE public.fmeas ADD COLUMN IF NOT EXISTS origin_id uuid;
ALTER TABLE public.fmea_revisions ADD COLUMN IF NOT EXISTS origin_kind text;
ALTER TABLE public.fmea_revisions ADD COLUMN IF NOT EXISTS origin_id uuid;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fmeas', 'fmea_revisions'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t || '_origin_kind_check') THEN
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (origin_kind IS NULL OR origin_kind IN (''ncr'', ''capa'', ''audit_finding'', ''supplier_scar'', ''change''))', t, t || '_origin_kind_check');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t || '_origin_state') THEN
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK ((origin_kind IS NULL) = (origin_id IS NULL))', t, t || '_origin_state');
    END IF;
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I (organisation_id, origin_kind, origin_id) WHERE origin_id IS NOT NULL', t || '_origin_idx', t);
  END LOOP;
END $$;

-- Set once, by app.set_fmea_origin, and never changed afterwards (SQL included).
CREATE OR REPLACE FUNCTION app.fmea_origin_fixed() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF OLD.origin_kind IS NOT NULL THEN
    IF NEW.origin_kind IS DISTINCT FROM OLD.origin_kind OR NEW.origin_id IS DISTINCT FROM OLD.origin_id THEN
      RAISE EXCEPTION 'Where an FMEA or a revision was raised from never changes' USING ERRCODE = 'QM036';
    END IF;
  ELSIF NEW.origin_kind IS NOT NULL AND coalesce(current_setting('app.fmea_origin', true), '') <> 'on' THEN
    RAISE EXCEPTION 'Where an FMEA was raised from is set when it is raised, not edited' USING ERRCODE = 'QM036';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS fmeas_origin_fixed ON public.fmeas;
CREATE TRIGGER fmeas_origin_fixed BEFORE UPDATE OF origin_kind, origin_id ON public.fmeas FOR EACH ROW EXECUTE FUNCTION app.fmea_origin_fixed();
DROP TRIGGER IF EXISTS fmea_revisions_origin_fixed ON public.fmea_revisions;
CREATE TRIGGER fmea_revisions_origin_fixed BEFORE UPDATE OF origin_kind, origin_id ON public.fmea_revisions FOR EACH ROW EXECUTE FUNCTION app.fmea_origin_fixed();

-- ---------------------------------------------------------------------------
-- 2. Can the caller read the record it would be raised from? (its organisation, or NULL)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.fmea_source_org(p_kind text, p_id uuid) RETURNS uuid
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
  ELSIF p_kind = 'supplier_scar' THEN
    SELECT organisation_id INTO v_org FROM public.supplier_scars WHERE id = p_id;
    RETURN CASE WHEN v_org IS NOT NULL AND app.has_permission(v_org, 'supplier_quality.read') THEN v_org END;
  ELSIF p_kind = 'change' THEN
    SELECT organisation_id INTO v_org FROM public.change_requests WHERE id = p_id;
    RETURN CASE WHEN v_org IS NOT NULL AND app.has_permission(v_org, 'change.read') THEN v_org END;
  END IF;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 3. What a record suggests for an FMEA raised from it: nothing is saved, the person chooses
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.fmea_draft_from(p_kind text, p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid := app.fmea_source_org(p_kind, p_id); v_ref text; v_title text; v_links jsonb := '[]'::jsonb; n public.nonconformances%ROWTYPE; v_capa_nc uuid;
BEGIN
  IF v_org IS NULL OR NOT app.has_permission(v_org, 'fmea.manage') THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;

  IF p_kind = 'ncr' THEN
    SELECT * INTO n FROM public.nonconformances WHERE id = p_id;
    v_ref := n.reference; v_title := n.title;
    v_links := app.fmea_links_json(n.part_id, n.causal_process_id, n.supplier_id, n.customer_id);
  ELSIF p_kind = 'capa' THEN
    SELECT reference, title INTO v_ref, v_title FROM public.capas WHERE id = p_id;
    SELECT l.nonconformance_id INTO v_capa_nc FROM public.capa_ncr_links l WHERE l.capa_id = p_id AND l.ended_at IS NULL ORDER BY l.created_at LIMIT 1;
    IF v_capa_nc IS NOT NULL THEN
      SELECT * INTO n FROM public.nonconformances WHERE id = v_capa_nc;
      v_links := app.fmea_links_json(n.part_id, n.causal_process_id, n.supplier_id, n.customer_id);
    END IF;
  ELSIF p_kind = 'audit_finding' THEN
    SELECT reference, title INTO v_ref, v_title FROM public.audit_findings WHERE id = p_id;
  ELSIF p_kind = 'supplier_scar' THEN
    SELECT s.reference, s.title INTO v_ref, v_title FROM public.supplier_scars s WHERE s.id = p_id;
    v_links := app.fmea_links_json(NULL, NULL, (SELECT supplier_id FROM public.supplier_scars WHERE id = p_id), NULL);
  ELSIF p_kind = 'change' THEN
    SELECT reference, title INTO v_ref, v_title FROM public.change_requests WHERE id = p_id;
    SELECT coalesce(jsonb_agg(jsonb_build_object('kind', l.kind, 'id', coalesce(l.part_id, l.part_family_id, l.machine_id, l.supplier_id, l.customer_id))), '[]'::jsonb)
      INTO v_links FROM public.change_links l
     WHERE l.change_id = p_id AND l.kind IN ('part', 'part_family', 'machine', 'supplier', 'customer');
  END IF;

  RETURN jsonb_build_object(
    'kind', 'process',
    'title', left(v_title, 200),
    'scopeText', left('Raised from ' || CASE p_kind WHEN 'ncr' THEN 'non-conformance' WHEN 'capa' THEN '8D' WHEN 'audit_finding' THEN 'audit finding' WHEN 'supplier_scar' THEN 'corrective action request' ELSE 'change' END
                      || ' ' || v_ref || ': ' || v_title, 2000),
    'links', v_links,
    'source', jsonb_build_object('kind', p_kind, 'id', p_id, 'reference', v_ref, 'title', v_title));
END $$;

-- The scope an FMEA raised from a record can start with: a part, the machine, a supplier and a customer, whichever the record names.
CREATE OR REPLACE FUNCTION app.fmea_links_json(p_part uuid, p_machine uuid, p_supplier uuid, p_customer uuid) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(x), '[]'::jsonb) FROM (
    SELECT jsonb_build_object('kind', 'part', 'id', p_part) AS x WHERE p_part IS NOT NULL
    UNION ALL SELECT jsonb_build_object('kind', 'machine', 'id', p_machine) WHERE p_machine IS NOT NULL
    UNION ALL SELECT jsonb_build_object('kind', 'supplier', 'id', p_supplier) WHERE p_supplier IS NOT NULL
    UNION ALL SELECT jsonb_build_object('kind', 'customer', 'id', p_customer) WHERE p_customer IS NOT NULL
  ) s
$$;

-- ---------------------------------------------------------------------------
-- 4. Record where an FMEA or a revision was raised from (once, on the one just made)
-- ---------------------------------------------------------------------------
-- p_target is 'fmea' (an FMEA just started) or 'revision' (a draft revision with no origin yet). fmea.manage, and the caller must be able to read the record.
CREATE OR REPLACE FUNCTION app.set_fmea_origin(p_target text, p_id uuid, p_kind text, p_source uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid; v_status text; v_has text;
BEGIN
  IF p_target = 'fmea' THEN
    SELECT organisation_id, origin_kind INTO v_org, v_has FROM public.fmeas WHERE id = p_id;
  ELSIF p_target = 'revision' THEN
    SELECT organisation_id, status, origin_kind INTO v_org, v_status, v_has FROM public.fmea_revisions WHERE id = p_id;
  ELSE
    RAISE EXCEPTION 'An FMEA or a revision' USING ERRCODE = 'QM036';
  END IF;
  IF v_org IS NULL OR NOT app.has_permission(v_org, 'fmea.manage') THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
  IF p_kind NOT IN ('ncr', 'capa', 'audit_finding', 'supplier_scar', 'change') THEN RAISE EXCEPTION 'That kind of record cannot be the reason for an FMEA' USING ERRCODE = 'QM036'; END IF;
  IF app.fmea_source_org(p_kind, p_source) IS DISTINCT FROM v_org THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
  IF v_has IS NOT NULL THEN RAISE EXCEPTION 'It already says where it was raised from, and that never changes' USING ERRCODE = 'QM036'; END IF;
  IF p_target = 'revision' AND v_status <> 'draft' THEN RAISE EXCEPTION 'Say why while the revision is a draft' USING ERRCODE = 'QM036'; END IF;
  PERFORM set_config('app.fmea_origin', 'on', true);
  IF p_target = 'fmea' THEN
    UPDATE public.fmeas SET origin_kind = p_kind, origin_id = p_source WHERE id = p_id;
  ELSE
    UPDATE public.fmea_revisions SET origin_kind = p_kind, origin_id = p_source WHERE id = p_id;
  END IF;
  PERFORM set_config('app.fmea_origin', 'off', true);
END $$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app.fmea_origin_fixed() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.fmea_source_org(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.fmea_links_json(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.fmea_draft_from(text, uuid), app.set_fmea_origin(text, uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.fmea_draft_from(text, uuid), app.set_fmea_origin(text, uuid, text, uuid) TO authenticated;
