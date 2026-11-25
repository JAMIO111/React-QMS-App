-- FMEA FM5c-3: an FMEA joins the risk register and the change workflow (plan FM13, FM14).
--
--   * A risk can name an **FMEA cause** it relates to (risk link kind `fmea_cause`), and a risk can be **raised from** an FMEA cause (origin kind `fmea_cause`).
--   * A change task can change an **FMEA revision** (task link kind `fmea_revision`): the task is finished only once that revision is in force, as for part, plan and document revisions.
--
-- Information only: nothing is blocked because of a link. Needs FM1 to FM5c-2, the risk register (RK3) and change management (CH3) first.
-- The shared functions are rewritten from their live definitions by checked text patches; each patch has a marker so it applies once, and strips Windows line endings (the SQL editor
-- may save the pasted text with them). Safe to run again.

-- ---------------------------------------------------------------------------
-- 0. The patch helper
-- ---------------------------------------------------------------------------
CREATE FUNCTION pg_temp.patch_once(p_fn regprocedure, p_marker text, p_old text, p_new text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_def text := replace(pg_get_functiondef(p_fn), E'\r', ''); v_n integer;
BEGIN
  p_old := replace(p_old, E'\r', '');
  p_new := replace(p_new, E'\r', '');
  IF position(p_marker IN v_def) > 0 THEN RETURN; END IF;
  v_n := (length(v_def) - length(replace(v_def, p_old, ''))) / length(p_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'Expected to find % exactly once in %, found % times', p_old, p_fn, v_n; END IF;
  EXECUTE replace(v_def, p_old, p_new);
END $$;

-- ---------------------------------------------------------------------------
-- 1. Risks: a link to an FMEA cause, and an origin
-- ---------------------------------------------------------------------------
ALTER TABLE public.risk_links ADD COLUMN IF NOT EXISTS fmea_cause_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'risk_links_fmea_cause_fkey') THEN
    ALTER TABLE public.risk_links ADD CONSTRAINT risk_links_fmea_cause_fkey FOREIGN KEY (fmea_cause_id, organisation_id) REFERENCES public.fmea_causes (id, organisation_id);
  END IF;
END $$;

ALTER TABLE public.risk_links DROP CONSTRAINT IF EXISTS risk_links_kind_check;
ALTER TABLE public.risk_links ADD CONSTRAINT risk_links_kind_check
  CHECK (kind IN ('ncr', 'capa', 'audit_finding', 'supplier', 'part', 'part_family', 'machine', 'document', 'operation_code', 'fmea_cause'));
ALTER TABLE public.risk_links DROP CONSTRAINT IF EXISTS risk_links_target_check;
ALTER TABLE public.risk_links ADD CONSTRAINT risk_links_target_check CHECK (
  num_nonnulls(ncr_id, capa_id, audit_finding_id, supplier_id, part_id, part_family_id, machine_id, document_id, fmea_cause_id, operation_code) = 1
  AND CASE kind
    WHEN 'ncr' THEN ncr_id IS NOT NULL WHEN 'capa' THEN capa_id IS NOT NULL WHEN 'audit_finding' THEN audit_finding_id IS NOT NULL
    WHEN 'supplier' THEN supplier_id IS NOT NULL WHEN 'part' THEN part_id IS NOT NULL WHEN 'part_family' THEN part_family_id IS NOT NULL
    WHEN 'machine' THEN machine_id IS NOT NULL WHEN 'document' THEN document_id IS NOT NULL WHEN 'fmea_cause' THEN fmea_cause_id IS NOT NULL
    ELSE operation_code IS NOT NULL END);
DROP INDEX IF EXISTS public.risk_links_target_key;
CREATE UNIQUE INDEX risk_links_target_key ON public.risk_links (risk_id, kind,
  coalesce(ncr_id, capa_id, audit_finding_id, supplier_id, part_id, part_family_id, machine_id, document_id, fmea_cause_id, '00000000-0000-0000-0000-000000000000'::uuid),
  upper(coalesce(operation_code, '')));
CREATE INDEX IF NOT EXISTS risk_links_fmea_cause_idx ON public.risk_links (fmea_cause_id) WHERE fmea_cause_id IS NOT NULL;

ALTER TABLE public.risks DROP CONSTRAINT IF EXISTS risks_origin_kind_check;
ALTER TABLE public.risks ADD CONSTRAINT risks_origin_kind_check CHECK (origin_kind IS NULL OR origin_kind IN ('ncr', 'capa', 'audit_finding', 'fmea_cause'));

-- What an FMEA cause suggests for a risk raised from it. Internal: the caller's rights are checked by app.risk_draft_from.
CREATE OR REPLACE FUNCTION app.risk_draft_from_fmea_cause(p_cause uuid, p_org uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.fmea_causes%ROWTYPE; m public.fmea_failure_modes%ROWTYPE; r public.fmea_revisions%ROWTYPE; f public.fmeas%ROWTYPE; v_effect text; v_links jsonb; v_cat text;
BEGIN
  SELECT * INTO c FROM public.fmea_causes WHERE id = p_cause AND organisation_id = p_org;
  SELECT * INTO m FROM public.fmea_failure_modes WHERE id = c.failure_mode_id;
  SELECT * INTO r FROM public.fmea_revisions WHERE id = c.revision_id;
  SELECT * INTO f FROM public.fmeas WHERE id = r.fmea_id;
  SELECT string_agg(e.text, E'\n' ORDER BY e.severity DESC NULLS LAST, e.position) INTO v_effect FROM public.fmea_effects e WHERE e.failure_mode_id = m.id;
  v_links := jsonb_build_array(jsonb_build_object('kind', 'fmea_cause', 'id', c.id))
    || coalesce((SELECT jsonb_agg(jsonb_build_object('kind', l.kind, 'id', coalesce(l.part_id, l.part_family_id, l.machine_id, l.supplier_id)))
                   FROM public.fmea_links l WHERE l.revision_id = r.id AND l.kind IN ('part', 'part_family', 'machine', 'supplier')), '[]'::jsonb);
  v_cat := CASE WHEN f.kind = 'design' THEN 'product' ELSE 'process' END;
  RETURN jsonb_build_object('kind', 'risk', 'title', left(m.text, 200),
    'description', left('FMEA ' || f.number || ': ' || m.text || ' (cause: ' || c.text || ')', 4000),
    'cause', left(c.text, 2000), 'effect', left(v_effect, 2000), 'links', v_links,
    'categoryId', (SELECT rc.id FROM public.risk_categories rc WHERE rc.organisation_id = p_org AND rc.key = v_cat AND rc.active),
    'source', jsonb_build_object('kind', 'fmea_cause', 'id', c.id, 'reference', f.number, 'title', left(c.text, 200)));
END $$;

-- The caller must be able to read the cause (that is, its revision).
SELECT pg_temp.patch_once('app.risk_source_org(text, uuid)'::regprocedure, 'fmea_cause',
  $old$RETURN NULL;$old$,
  $new$IF p_kind = 'fmea_cause' THEN
    SELECT c.organisation_id INTO v_org FROM public.fmea_causes c WHERE c.id = p_id AND app.fmea_revision_readable(c.revision_id);
    RETURN v_org;
  END IF;
  RETURN NULL;$new$);

SELECT pg_temp.patch_once('app.risk_draft_from(text, uuid)'::regprocedure, 'fmea_cause',
  $old$NOT IN ('ncr', 'capa', 'audit_finding') THEN RAISE EXCEPTION 'A risk is raised from a non-conformance, an 8D or an audit finding'$old$,
  $new$NOT IN ('ncr', 'capa', 'audit_finding', 'fmea_cause') THEN RAISE EXCEPTION 'A risk is raised from a non-conformance, an 8D, an audit finding or an FMEA cause'$new$);
SELECT pg_temp.patch_once('app.risk_draft_from(text, uuid)'::regprocedure, 'risk_draft_from_fmea_cause',
  $old$IF p_kind = 'ncr' THEN
    SELECT * INTO n FROM public.nonconformances WHERE id = p_id;$old$,
  $new$IF p_kind = 'fmea_cause' THEN RETURN app.risk_draft_from_fmea_cause(p_id, v_org); END IF;
  IF p_kind = 'ncr' THEN
    SELECT * INTO n FROM public.nonconformances WHERE id = p_id;$new$);

SELECT pg_temp.patch_once('app.raise_risk_from(text, uuid, jsonb, jsonb)'::regprocedure, 'fmea_cause',
  $old$NOT IN ('ncr', 'capa', 'audit_finding') THEN RAISE EXCEPTION 'A risk is raised from a non-conformance, an 8D or an audit finding'$old$,
  $new$NOT IN ('ncr', 'capa', 'audit_finding', 'fmea_cause') THEN RAISE EXCEPTION 'A risk is raised from a non-conformance, an 8D, an audit finding or an FMEA cause'$new$);

SELECT pg_temp.patch_once('app.set_risk_links(uuid, jsonb)'::regprocedure, 'fmea_cause',
  $old$'machine', 'document', 'operation_code') THEN$old$,
  $new$'machine', 'document', 'operation_code', 'fmea_cause') THEN$new$);
SELECT pg_temp.patch_once('app.set_risk_links(uuid, jsonb)'::regprocedure, 'an FMEA cause or an operation',
  $old$a document or an operation'$old$,
  $new$a document, an FMEA cause or an operation'$new$);

-- ---------------------------------------------------------------------------
-- 2. Change tasks: a task can change an FMEA revision
-- ---------------------------------------------------------------------------
ALTER TABLE public.change_tasks ADD COLUMN IF NOT EXISTS fmea_revision_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'change_tasks_fmea_revision_fkey') THEN
    ALTER TABLE public.change_tasks ADD CONSTRAINT change_tasks_fmea_revision_fkey FOREIGN KEY (fmea_revision_id, organisation_id) REFERENCES public.fmea_revisions (id, organisation_id);
  END IF;
END $$;

ALTER TABLE public.change_tasks DROP CONSTRAINT IF EXISTS change_tasks_link_kind_check;
ALTER TABLE public.change_tasks ADD CONSTRAINT change_tasks_link_kind_check
  CHECK (link_kind IS NULL OR link_kind IN ('part_revision', 'control_plan_revision', 'document_revision', 'gauge_type', 'training_session',
                                            'supplier', 'inspection_requirement', 'quality_alert', 'risk', 'fmea_revision'));
ALTER TABLE public.change_tasks DROP CONSTRAINT IF EXISTS change_tasks_link_state;
ALTER TABLE public.change_tasks ADD CONSTRAINT change_tasks_link_state CHECK (
  num_nonnulls(part_revision_id, control_plan_revision_id, document_revision_id, gauge_type_id, training_session_id, supplier_id,
               inspection_requirement_id, quality_alert_id, risk_id, fmea_revision_id) = CASE WHEN link_kind IS NULL THEN 0 ELSE 1 END
  AND CASE link_kind
        WHEN 'part_revision' THEN part_revision_id IS NOT NULL
        WHEN 'control_plan_revision' THEN control_plan_revision_id IS NOT NULL
        WHEN 'document_revision' THEN document_revision_id IS NOT NULL
        WHEN 'gauge_type' THEN gauge_type_id IS NOT NULL
        WHEN 'training_session' THEN training_session_id IS NOT NULL
        WHEN 'supplier' THEN supplier_id IS NOT NULL
        WHEN 'inspection_requirement' THEN inspection_requirement_id IS NOT NULL
        WHEN 'quality_alert' THEN quality_alert_id IS NOT NULL
        WHEN 'risk' THEN risk_id IS NOT NULL
        WHEN 'fmea_revision' THEN fmea_revision_id IS NOT NULL
        ELSE true END);
DROP INDEX IF EXISTS public.change_tasks_one_open_per_record;
CREATE UNIQUE INDEX change_tasks_one_open_per_record ON public.change_tasks (
  change_id, coalesce(part_revision_id, control_plan_revision_id, document_revision_id, gauge_type_id, training_session_id, supplier_id,
                      inspection_requirement_id, quality_alert_id, risk_id, fmea_revision_id))
  WHERE status = 'open' AND link_kind IS NOT NULL;

SELECT pg_temp.patch_once('app.change_task_set_link(uuid, text, uuid)'::regprocedure, 'fmea_revision',
  $old$WHEN 'risk' THEN 'risks' END;$old$,
  $new$WHEN 'risk' THEN 'risks' WHEN 'fmea_revision' THEN 'fmea_revisions' END;$new$);
SELECT pg_temp.patch_once('app.change_task_set_link(uuid, text, uuid)'::regprocedure, 'fmea_revision_id = CASE',
  $old$risk_id = CASE WHEN p_kind = 'risk' THEN p_record END$old$,
  $new$risk_id = CASE WHEN p_kind = 'risk' THEN p_record END,
      fmea_revision_id = CASE WHEN p_kind = 'fmea_revision' THEN p_record END$new$);

-- Where the revision stands now: in force (effective), replaced (superseded), pending (still being prepared or approved), gone (withdrawn or discarded).
SELECT pg_temp.patch_once('app.change_task_link_state(uuid)'::regprocedure, 'fmea_revisions r',
  $old$ELSE v := 'none';$old$,
  $new$WHEN 'fmea_revision' THEN
      SELECT CASE r.status WHEN 'effective' THEN 'in_force' WHEN 'superseded' THEN 'replaced' WHEN 'draft' THEN 'pending'
                           WHEN 'pending_approval' THEN 'pending' WHEN 'approved' THEN 'pending' ELSE 'gone' END INTO v
        FROM public.fmea_revisions r WHERE r.id = t.fmea_revision_id;
    ELSE v := 'none';$new$);

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app.risk_draft_from_fmea_cause(uuid, uuid) FROM PUBLIC, anon, authenticated;
