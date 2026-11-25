-- FMEA, slice FM3 (docs/fmea-plan.md): the analysis itself, starting an FMEA from a base, and the rules a revision must meet before it is submitted.
--
--  * The analysis is stored as the handbook's nets, per revision: fmea_items (the structure tree: system > sub-system > component for a design FMEA, process item > process step
--    > work element for a process FMEA), fmea_functions (what an item is for, with its requirement), fmea_failure_modes, fmea_effects (each with a severity 1-10 and where it
--    shows: own plant, next plant, end user) and fmea_causes (prevention and detection controls, occurrence and detection 1-10).
--  * The database works the rest out and nothing a client sends for it is trusted: a cause's severity is the HIGHEST severity among its failure mode's effects, and its RPN,
--    priority (high | medium | low) and "needs attention" come from the revision's rating model (app.fmea_score; FM2). A cause needs attention when its priority is high or
--    its severity reaches the model's floor. Changing an effect's severity, or the model, re-scores the causes.
--  * Written only by SECURITY DEFINER functions (fmea.manage), and only while the revision is a draft; the rows are frozen with the revision, even for SQL. A revision freezes
--    the model version it was rated with (fmea_revisions.model_id, taken from the current model when the draft is made); a draft may switch to the latest one, which re-scores it.
--  * Lineage: every row remembers prev_row_id (the row it was copied from when a new revision was started) and base_row_id (the row it came from in a base FMEA), so a later
--    comparison can follow a row through revisions.
--  * Inheritance (decision FM17): an FMEA may be started from a base FMEA of the same kind that is in force. The base's analysis is COPIED into the new draft, with provenance;
--    it is never a live link, so a frozen revision never changes under anyone. fmeas.base_fmea_id and fmea_revisions.based_on_revision_id say where it came from and never
--    change. A per-part FMEA with no base is written from scratch as before.
--  * app.fmea_revision_problems (the "still needed" list) now asks for the analysis: a structure, a function on every item that has no sub-items, a failure mode for every
--    function, an effect with a severity and a cause for every failure mode, occurrence, detection and a control on every cause, and, for a cause that needs attention,
--    a written reason for taking no action (FM4 adds actions as the other way to answer it).
-- Errors QM036 (409 fmea_rule); another organisation's id is P0002 (404).

-- ---------------------------------------------------------------------------
-- 1. What an FMEA and a revision remember
-- ---------------------------------------------------------------------------
ALTER TABLE public.fmeas ADD COLUMN base_fmea_id uuid;
ALTER TABLE public.fmeas ADD CONSTRAINT fmeas_base_fkey FOREIGN KEY (base_fmea_id, organisation_id) REFERENCES public.fmeas (id, organisation_id);
ALTER TABLE public.fmeas ADD CONSTRAINT fmeas_base_not_self CHECK (base_fmea_id IS DISTINCT FROM id);
CREATE INDEX fmeas_base_idx ON public.fmeas (base_fmea_id) WHERE base_fmea_id IS NOT NULL;

ALTER TABLE public.fmea_revisions ADD COLUMN model_id uuid, ADD COLUMN based_on_revision_id uuid;
-- Existing revisions are rated with the organisation's current model (they have no analysis yet). The row triggers are switched off for this one move: it is not a person's change.
ALTER TABLE public.fmea_revisions DISABLE TRIGGER USER;
UPDATE public.fmea_revisions r SET model_id = (SELECT m.id FROM public.fmea_models m WHERE m.organisation_id = r.organisation_id AND m.current);
ALTER TABLE public.fmea_revisions ENABLE TRIGGER USER;
ALTER TABLE public.fmea_revisions ALTER COLUMN model_id SET NOT NULL;
ALTER TABLE public.fmea_revisions ADD CONSTRAINT fmea_revisions_model_fkey FOREIGN KEY (model_id, organisation_id) REFERENCES public.fmea_models (id, organisation_id);
ALTER TABLE public.fmea_revisions ADD CONSTRAINT fmea_revisions_based_on_fkey FOREIGN KEY (based_on_revision_id, organisation_id) REFERENCES public.fmea_revisions (id, organisation_id);

-- A new revision starts on the organisation's current model.
CREATE FUNCTION app.fmea_revision_defaults() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.model_id IS NULL THEN
    SELECT m.id INTO NEW.model_id FROM public.fmea_models m WHERE m.organisation_id = NEW.organisation_id AND m.current;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fmea_revisions_defaults BEFORE INSERT ON public.fmea_revisions FOR EACH ROW EXECUTE FUNCTION app.fmea_revision_defaults();

-- The two rule triggers of FM1, with the new columns in them: the base of an FMEA never changes; the model and the base revision are frozen with the revision.
CREATE OR REPLACE FUNCTION app.fmea_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'An FMEA is never deleted. Discard a draft or withdraw it with a reason.' USING ERRCODE = 'QM036'; END IF;
  IF (NEW.number, NEW.kind) IS DISTINCT FROM (OLD.number, OLD.kind) THEN RAISE EXCEPTION 'An FMEA''s number and kind never change' USING ERRCODE = 'QM036'; END IF;
  IF NEW.base_fmea_id IS DISTINCT FROM OLD.base_fmea_id THEN RAISE EXCEPTION 'The FMEA this one was started from never changes' USING ERRCODE = 'QM036'; END IF;
  IF OLD.status = 'discarded' THEN RAISE EXCEPTION '% is discarded and cannot be changed', OLD.number USING ERRCODE = 'QM036'; END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status IN ('active', 'discarded'))
    OR (OLD.status = 'active' AND NEW.status = 'withdrawn')
    OR (OLD.status = 'withdrawn' AND NEW.status = 'active')) THEN
    RAISE EXCEPTION 'An FMEA cannot move from % to %', OLD.status, NEW.status USING ERRCODE = 'QM036';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.fmea_revision_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A revision is never deleted. Discard a draft with a reason.' USING ERRCODE = 'QM036'; END IF;
  IF (NEW.fmea_id, NEW.sequence, NEW.author_id) IS DISTINCT FROM (OLD.fmea_id, OLD.sequence, OLD.author_id) THEN
    RAISE EXCEPTION 'A revision''s FMEA, sequence and author never change' USING ERRCODE = 'QM036';
  END IF;
  IF NEW.based_on_revision_id IS DISTINCT FROM OLD.based_on_revision_id THEN RAISE EXCEPTION 'The revision this one was started from never changes' USING ERRCODE = 'QM036'; END IF;
  IF OLD.letter IS NOT NULL AND NEW.letter IS DISTINCT FROM OLD.letter THEN RAISE EXCEPTION 'A revision letter never changes' USING ERRCODE = 'QM036'; END IF;
  IF OLD.status <> 'draft' AND (NEW.change_summary, NEW.approver_id, NEW.previous_revision_id, NEW.model_id)
                               IS DISTINCT FROM (OLD.change_summary, OLD.approver_id, OLD.previous_revision_id, OLD.model_id) THEN
    RAISE EXCEPTION 'Only a draft''s content can change' USING ERRCODE = 'QM036';
  END IF;
  IF OLD.status IN ('discarded', 'superseded', 'withdrawn') THEN RAISE EXCEPTION 'A % revision cannot be changed', OLD.status USING ERRCODE = 'QM036'; END IF;
  IF OLD.status IN ('approved', 'effective') AND (NEW.effective_from, NEW.approved_at, NEW.approved_by) IS DISTINCT FROM (OLD.effective_from, OLD.approved_at, OLD.approved_by) THEN
    RAISE EXCEPTION 'An approved revision is frozen' USING ERRCODE = 'QM036';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status IN ('pending_approval', 'discarded'))
    OR (OLD.status = 'pending_approval' AND NEW.status IN ('draft', 'approved'))
    OR (OLD.status = 'approved' AND NEW.status IN ('effective', 'withdrawn'))
    OR (OLD.status = 'effective' AND NEW.status IN ('superseded', 'withdrawn'))) THEN
    RAISE EXCEPTION 'A revision cannot move from % to %', replace(OLD.status, '_', ' '), replace(NEW.status, '_', ' ') USING ERRCODE = 'QM036';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- 2. The tables of the analysis
-- ---------------------------------------------------------------------------
CREATE TABLE public.fmea_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  revision_id uuid NOT NULL,
  parent_id uuid,
  kind text NOT NULL CHECK (kind IN ('system', 'subsystem', 'component', 'item', 'step', 'element')),
  element_type text CHECK (element_type IS NULL OR element_type IN ('man', 'machine', 'material', 'method', 'measurement', 'environment')),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  description text CHECK (description IS NULL OR length(btrim(description)) BETWEEN 1 AND 1000),
  operation_code text CHECK (operation_code IS NULL OR (length(btrim(operation_code)) BETWEEN 1 AND 40 AND operation_code = btrim(operation_code))),
  machine_id uuid,
  part_id uuid,
  position integer NOT NULL DEFAULT 1 CHECK (position BETWEEN 0 AND 100000),
  prev_row_id uuid,
  base_row_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT fmea_items_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT fmea_items_revision_fkey FOREIGN KEY (revision_id, organisation_id) REFERENCES public.fmea_revisions (id, organisation_id),
  CONSTRAINT fmea_items_parent_fkey FOREIGN KEY (parent_id, organisation_id) REFERENCES public.fmea_items (id, organisation_id) ON DELETE CASCADE,
  CONSTRAINT fmea_items_machine_fkey FOREIGN KEY (machine_id, organisation_id) REFERENCES public.machines (id, organisation_id),
  CONSTRAINT fmea_items_part_fkey FOREIGN KEY (part_id, organisation_id) REFERENCES public.parts (id, organisation_id),
  CONSTRAINT fmea_items_prev_fkey FOREIGN KEY (prev_row_id, organisation_id) REFERENCES public.fmea_items (id, organisation_id),
  CONSTRAINT fmea_items_base_fkey FOREIGN KEY (base_row_id, organisation_id) REFERENCES public.fmea_items (id, organisation_id),
  CONSTRAINT fmea_items_element_only_check CHECK (element_type IS NULL OR kind = 'element')
);
CREATE INDEX fmea_items_revision_idx ON public.fmea_items (organisation_id, revision_id, parent_id, position);

CREATE TABLE public.fmea_functions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  revision_id uuid NOT NULL,
  item_id uuid NOT NULL,
  text text NOT NULL CHECK (length(btrim(text)) BETWEEN 1 AND 1000),
  requirement text CHECK (requirement IS NULL OR length(btrim(requirement)) BETWEEN 1 AND 1000),
  characteristic_key text CHECK (characteristic_key IS NULL OR (length(btrim(characteristic_key)) BETWEEN 1 AND 80 AND characteristic_key = btrim(characteristic_key))),
  position integer NOT NULL DEFAULT 1 CHECK (position BETWEEN 0 AND 100000),
  prev_row_id uuid,
  base_row_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT fmea_functions_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT fmea_functions_revision_fkey FOREIGN KEY (revision_id, organisation_id) REFERENCES public.fmea_revisions (id, organisation_id),
  CONSTRAINT fmea_functions_item_fkey FOREIGN KEY (item_id, organisation_id) REFERENCES public.fmea_items (id, organisation_id) ON DELETE CASCADE,
  CONSTRAINT fmea_functions_prev_fkey FOREIGN KEY (prev_row_id, organisation_id) REFERENCES public.fmea_functions (id, organisation_id),
  CONSTRAINT fmea_functions_base_fkey FOREIGN KEY (base_row_id, organisation_id) REFERENCES public.fmea_functions (id, organisation_id)
);
CREATE INDEX fmea_functions_item_idx ON public.fmea_functions (organisation_id, revision_id, item_id, position);

CREATE TABLE public.fmea_failure_modes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  revision_id uuid NOT NULL,
  function_id uuid NOT NULL,
  text text NOT NULL CHECK (length(btrim(text)) BETWEEN 1 AND 500),
  special_class text CHECK (special_class IS NULL OR special_class IN ('critical', 'significant')),
  position integer NOT NULL DEFAULT 1 CHECK (position BETWEEN 0 AND 100000),
  prev_row_id uuid,
  base_row_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT fmea_failure_modes_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT fmea_failure_modes_revision_fkey FOREIGN KEY (revision_id, organisation_id) REFERENCES public.fmea_revisions (id, organisation_id),
  CONSTRAINT fmea_failure_modes_function_fkey FOREIGN KEY (function_id, organisation_id) REFERENCES public.fmea_functions (id, organisation_id) ON DELETE CASCADE,
  CONSTRAINT fmea_failure_modes_prev_fkey FOREIGN KEY (prev_row_id, organisation_id) REFERENCES public.fmea_failure_modes (id, organisation_id),
  CONSTRAINT fmea_failure_modes_base_fkey FOREIGN KEY (base_row_id, organisation_id) REFERENCES public.fmea_failure_modes (id, organisation_id)
);
CREATE INDEX fmea_failure_modes_function_idx ON public.fmea_failure_modes (organisation_id, revision_id, function_id, position);

CREATE TABLE public.fmea_effects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  revision_id uuid NOT NULL,
  failure_mode_id uuid NOT NULL,
  level text NOT NULL CHECK (level IN ('own_plant', 'next_plant', 'end_user')),
  text text NOT NULL CHECK (length(btrim(text)) BETWEEN 1 AND 500),
  severity integer CHECK (severity IS NULL OR severity BETWEEN 1 AND 10),
  position integer NOT NULL DEFAULT 1 CHECK (position BETWEEN 0 AND 100000),
  prev_row_id uuid,
  base_row_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT fmea_effects_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT fmea_effects_revision_fkey FOREIGN KEY (revision_id, organisation_id) REFERENCES public.fmea_revisions (id, organisation_id),
  CONSTRAINT fmea_effects_mode_fkey FOREIGN KEY (failure_mode_id, organisation_id) REFERENCES public.fmea_failure_modes (id, organisation_id) ON DELETE CASCADE,
  CONSTRAINT fmea_effects_prev_fkey FOREIGN KEY (prev_row_id, organisation_id) REFERENCES public.fmea_effects (id, organisation_id),
  CONSTRAINT fmea_effects_base_fkey FOREIGN KEY (base_row_id, organisation_id) REFERENCES public.fmea_effects (id, organisation_id)
);
CREATE INDEX fmea_effects_mode_idx ON public.fmea_effects (organisation_id, revision_id, failure_mode_id, position);

CREATE TABLE public.fmea_causes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  revision_id uuid NOT NULL,
  failure_mode_id uuid NOT NULL,
  text text NOT NULL CHECK (length(btrim(text)) BETWEEN 1 AND 500),
  prevention_controls text CHECK (prevention_controls IS NULL OR length(btrim(prevention_controls)) BETWEEN 1 AND 1000),
  detection_controls text CHECK (detection_controls IS NULL OR length(btrim(detection_controls)) BETWEEN 1 AND 1000),
  occurrence integer CHECK (occurrence IS NULL OR occurrence BETWEEN 1 AND 10),
  detection integer CHECK (detection IS NULL OR detection BETWEEN 1 AND 10),
  -- Worked out by the database from the effects and the revision's model; never sent by a client.
  severity_used integer CHECK (severity_used IS NULL OR severity_used BETWEEN 1 AND 10),
  rpn integer,
  priority text CHECK (priority IS NULL OR priority IN ('high', 'medium', 'low')),
  needs_attention boolean,
  no_action_reason text CHECK (no_action_reason IS NULL OR length(btrim(no_action_reason)) BETWEEN 3 AND 500),
  position integer NOT NULL DEFAULT 1 CHECK (position BETWEEN 0 AND 100000),
  prev_row_id uuid,
  base_row_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT fmea_causes_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT fmea_causes_revision_fkey FOREIGN KEY (revision_id, organisation_id) REFERENCES public.fmea_revisions (id, organisation_id),
  CONSTRAINT fmea_causes_mode_fkey FOREIGN KEY (failure_mode_id, organisation_id) REFERENCES public.fmea_failure_modes (id, organisation_id) ON DELETE CASCADE,
  CONSTRAINT fmea_causes_prev_fkey FOREIGN KEY (prev_row_id, organisation_id) REFERENCES public.fmea_causes (id, organisation_id),
  CONSTRAINT fmea_causes_base_fkey FOREIGN KEY (base_row_id, organisation_id) REFERENCES public.fmea_causes (id, organisation_id),
  -- A priority is worked out only when severity, occurrence and detection are all known, and the RPN is exactly their product.
  CONSTRAINT fmea_causes_scored_check CHECK (
    (rpn IS NULL) = (priority IS NULL) AND (priority IS NULL) = (needs_attention IS NULL)
    AND (rpn IS NULL OR (severity_used IS NOT NULL AND occurrence IS NOT NULL AND detection IS NOT NULL AND rpn = severity_used * occurrence * detection)))
);
CREATE INDEX fmea_causes_mode_idx ON public.fmea_causes (organisation_id, revision_id, failure_mode_id, position);
CREATE INDEX fmea_causes_attention_idx ON public.fmea_causes (organisation_id, revision_id) WHERE needs_attention;

-- ---------------------------------------------------------------------------
-- 3. Rules the tables hold even for SQL
-- ---------------------------------------------------------------------------
-- Only while the revision is a draft; a row stays in its revision; a child sits under a parent of the same revision; an item's kind fits the FMEA's kind and its parent.
CREATE FUNCTION app.fmea_net_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_rev uuid := coalesce(NEW.revision_id, OLD.revision_id); v_status text; v_fmea_kind text; v_parent_rev uuid; v_parent_kind text; v_parent_table text; v_parent_col text; v_parent uuid;
BEGIN
  SELECT r.status, f.kind INTO v_status, v_fmea_kind FROM public.fmea_revisions r JOIN public.fmeas f ON f.id = r.fmea_id WHERE r.id = v_rev;
  IF v_status IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'The analysis changes only while the revision is a draft' USING ERRCODE = 'QM036'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF TG_OP = 'UPDATE' AND NEW.revision_id IS DISTINCT FROM OLD.revision_id THEN RAISE EXCEPTION 'A row stays in its revision' USING ERRCODE = 'QM036'; END IF;

  IF TG_TABLE_NAME = 'fmea_items' THEN
    IF TG_OP = 'UPDATE' AND NEW.kind IS DISTINCT FROM OLD.kind THEN RAISE EXCEPTION 'An item''s kind never changes: remove it and add the right kind' USING ERRCODE = 'QM036'; END IF;
    IF NOT (CASE v_fmea_kind WHEN 'design' THEN NEW.kind IN ('system', 'subsystem', 'component') ELSE NEW.kind IN ('item', 'step', 'element') END) THEN
      RAISE EXCEPTION 'A % FMEA has % in its structure', v_fmea_kind, CASE v_fmea_kind WHEN 'design' THEN 'systems, sub-systems and components' ELSE 'process items, process steps and work elements' END USING ERRCODE = 'QM036';
    END IF;
    IF NEW.parent_id IS NOT NULL THEN
      SELECT revision_id, kind INTO v_parent_rev, v_parent_kind FROM public.fmea_items WHERE id = NEW.parent_id;
      IF v_parent_rev IS DISTINCT FROM NEW.revision_id THEN RAISE EXCEPTION 'An item sits under an item of the same revision' USING ERRCODE = 'QM036'; END IF;
    END IF;
    IF NOT (CASE NEW.kind
              WHEN 'system' THEN NEW.parent_id IS NULL
              WHEN 'subsystem' THEN coalesce(v_parent_kind = 'system', false)
              WHEN 'component' THEN coalesce(v_parent_kind IN ('system', 'subsystem'), false)
              WHEN 'item' THEN NEW.parent_id IS NULL
              WHEN 'step' THEN coalesce(v_parent_kind = 'item', false)
              WHEN 'element' THEN coalesce(v_parent_kind = 'step', false) END) THEN
      RAISE EXCEPTION 'A % goes %', CASE NEW.kind WHEN 'subsystem' THEN 'sub-system' WHEN 'item' THEN 'process item' WHEN 'step' THEN 'process step' WHEN 'element' THEN 'work element' ELSE NEW.kind END,
        CASE NEW.kind WHEN 'system' THEN 'at the top' WHEN 'subsystem' THEN 'under a system' WHEN 'component' THEN 'under a system or a sub-system'
                      WHEN 'item' THEN 'at the top' WHEN 'step' THEN 'under a process item' ELSE 'under a process step' END USING ERRCODE = 'QM036';
    END IF;
  ELSE
    v_parent_table := CASE TG_TABLE_NAME WHEN 'fmea_functions' THEN 'fmea_items' WHEN 'fmea_failure_modes' THEN 'fmea_functions' ELSE 'fmea_failure_modes' END;
    v_parent_col := CASE TG_TABLE_NAME WHEN 'fmea_functions' THEN 'item_id' WHEN 'fmea_failure_modes' THEN 'function_id' ELSE 'failure_mode_id' END;
    v_parent := (to_jsonb(NEW) ->> v_parent_col)::uuid;
    IF TG_OP = 'UPDATE' AND v_parent IS DISTINCT FROM (to_jsonb(OLD) ->> v_parent_col)::uuid THEN RAISE EXCEPTION 'A row stays under its parent' USING ERRCODE = 'QM036'; END IF;
    EXECUTE format('SELECT revision_id FROM public.%I WHERE id = $1', v_parent_table) INTO v_parent_rev USING v_parent;
    IF v_parent_rev IS DISTINCT FROM NEW.revision_id THEN RAISE EXCEPTION 'A row sits under a parent of the same revision' USING ERRCODE = 'QM036'; END IF;
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fmea_items', 'fmea_functions', 'fmea_failure_modes', 'fmea_effects', 'fmea_causes'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.fmea_net_rules()', t || '_rules', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION app.stamp_created()', t || '_stamp', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.touch_updated()', t || '_touch', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change()', t || '_org_immutable', t);
    EXECUTE format('CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION audit.record_change(''organisation_id'')', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (app.fmea_revision_readable(revision_id))', t || '_select', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Scoring: severity from the effects, the rest from the revision's model
-- ---------------------------------------------------------------------------
-- Works out severity_used, rpn, priority and needs_attention for every cause of one failure mode. Only rows whose figures change are written.
CREATE FUNCTION app.fmea_rescore_mode(p_mode uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_rev uuid; v_config jsonb; v_kind text; v_sev integer;
BEGIN
  SELECT m.revision_id INTO v_rev FROM public.fmea_failure_modes m WHERE m.id = p_mode;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT mo.config, f.kind INTO v_config, v_kind
    FROM public.fmea_revisions r JOIN public.fmeas f ON f.id = r.fmea_id JOIN public.fmea_models mo ON mo.id = r.model_id WHERE r.id = v_rev;
  SELECT max(e.severity) INTO v_sev FROM public.fmea_effects e WHERE e.failure_mode_id = p_mode;
  WITH s AS (
    SELECT c.id, v_sev AS sev,
           CASE WHEN v_sev IS NOT NULL AND c.occurrence IS NOT NULL AND c.detection IS NOT NULL THEN app.fmea_score(v_config, v_kind, v_sev, c.occurrence, c.detection) END AS sc
      FROM public.fmea_causes c WHERE c.failure_mode_id = p_mode)
  UPDATE public.fmea_causes c SET
    severity_used = s.sev, rpn = (s.sc ->> 'rpn')::integer, priority = s.sc ->> 'priority', needs_attention = (s.sc ->> 'needsAttention')::boolean
   FROM s
   WHERE s.id = c.id
     AND (c.severity_used IS DISTINCT FROM s.sev OR c.rpn IS DISTINCT FROM (s.sc ->> 'rpn')::integer
          OR c.priority IS DISTINCT FROM s.sc ->> 'priority' OR c.needs_attention IS DISTINCT FROM (s.sc ->> 'needsAttention')::boolean);
END $$;

CREATE FUNCTION app.fmea_rescore_revision(p_revision uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_mode uuid;
BEGIN
  FOR v_mode IN SELECT id FROM public.fmea_failure_modes WHERE revision_id = p_revision LOOP PERFORM app.fmea_rescore_mode(v_mode); END LOOP;
END $$;

-- A draft moves to the organisation's latest rating model and every cause is re-scored with it.
CREATE FUNCTION app.set_fmea_revision_model(p_revision uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.fmea_revisions%ROWTYPE; v_model uuid;
BEGIN
  r := app.fmea_draft_for_update(p_revision);
  SELECT m.id INTO v_model FROM public.fmea_models m WHERE m.organisation_id = r.organisation_id AND m.current;
  IF v_model IS NULL THEN RAISE EXCEPTION 'This organisation has no FMEA rating model' USING ERRCODE = 'QM036'; END IF;
  IF v_model IS DISTINCT FROM r.model_id THEN
    UPDATE public.fmea_revisions SET model_id = v_model WHERE id = r.id;
    PERFORM app.fmea_rescore_revision(r.id);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Writing the analysis (fmea.manage, draft revisions only)
-- ---------------------------------------------------------------------------
-- Small shared checks.
CREATE FUNCTION app.fmea_keys(p_data jsonb, p_allowed text[]) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE k text;
BEGIN
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Send the fields as an object' USING ERRCODE = 'QM036'; END IF;
  FOR k IN SELECT jsonb_object_keys(p_data) LOOP
    IF NOT (k = ANY (p_allowed)) THEN RAISE EXCEPTION 'Unknown field %', k USING ERRCODE = 'QM036'; END IF;
  END LOOP;
END $$;

-- Optional text: trimmed, empty means none, and not longer than allowed.
CREATE FUNCTION app.fmea_text(p_value text, p_label text, p_max integer) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v text := nullif(btrim(coalesce(p_value, '')), '');
BEGIN
  IF v IS NOT NULL AND length(v) > p_max THEN RAISE EXCEPTION '% is up to % characters', p_label, p_max USING ERRCODE = 'QM036'; END IF;
  RETURN v;
END $$;

-- A rating: empty means not rated yet, otherwise a whole number 1 to 10.
CREATE FUNCTION app.fmea_level(p_value text, p_label text) RETURNS integer
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v integer;
BEGIN
  IF p_value IS NULL OR btrim(p_value) = '' THEN RETURN NULL; END IF;
  BEGIN v := btrim(p_value)::integer; EXCEPTION WHEN others THEN RAISE EXCEPTION '% is a whole number from 1 to 10', p_label USING ERRCODE = 'QM036'; END;
  IF v NOT BETWEEN 1 AND 10 THEN RAISE EXCEPTION '% is a whole number from 1 to 10', p_label USING ERRCODE = 'QM036'; END IF;
  RETURN v;
END $$;

-- A position: where among its siblings; empty puts it last.
CREATE FUNCTION app.fmea_position(p_value text, p_next integer) RETURNS integer
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v integer;
BEGIN
  IF p_value IS NULL OR btrim(p_value) = '' THEN RETURN p_next; END IF;
  BEGIN v := btrim(p_value)::integer; EXCEPTION WHEN others THEN RAISE EXCEPTION 'A position is a whole number' USING ERRCODE = 'QM036'; END;
  IF v NOT BETWEEN 0 AND 100000 THEN RAISE EXCEPTION 'A position is 0 to 100000' USING ERRCODE = 'QM036'; END IF;
  RETURN v;
END $$;

-- Keys: parentId, kind (when adding), name, elementType, description, operationCode, machineId, partId, position.
CREATE FUNCTION app.save_fmea_item(p_revision uuid, p_id uuid, p_data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.fmea_revisions%ROWTYPE; i public.fmea_items%ROWTYPE; v_id uuid; v_parent uuid; v_kind text; v_name text; v_type text; v_next integer;
BEGIN
  r := app.fmea_draft_for_update(p_revision);
  PERFORM app.fmea_keys(p_data, ARRAY['parentId', 'kind', 'name', 'elementType', 'description', 'operationCode', 'machineId', 'partId', 'position']);
  IF p_id IS NOT NULL THEN
    SELECT * INTO i FROM public.fmea_items WHERE id = p_id AND revision_id = r.id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Item not found' USING ERRCODE = 'P0002'; END IF;
  END IF;
  v_name := CASE WHEN p_data ? 'name' THEN btrim(coalesce(p_data ->> 'name', '')) ELSE i.name END;
  IF v_name IS NULL OR length(v_name) = 0 THEN RAISE EXCEPTION 'Give the item a name' USING ERRCODE = 'QM036'; END IF;
  IF length(v_name) > 200 THEN RAISE EXCEPTION 'The name is up to 200 characters' USING ERRCODE = 'QM036'; END IF;
  v_type := CASE WHEN p_data ? 'elementType' THEN nullif(btrim(coalesce(p_data ->> 'elementType', '')), '') ELSE i.element_type END;
  IF v_type IS NOT NULL AND v_type NOT IN ('man', 'machine', 'material', 'method', 'measurement', 'environment') THEN RAISE EXCEPTION 'A work element is man, machine, material, method, measurement or environment' USING ERRCODE = 'QM036'; END IF;
  IF v_type IS NOT NULL AND coalesce(CASE WHEN p_id IS NULL THEN p_data ->> 'kind' ELSE i.kind END, '') <> 'element' THEN
    RAISE EXCEPTION 'Only a work element has a type (man, machine, material, method, measurement or environment)' USING ERRCODE = 'QM036';
  END IF;
  BEGIN
    IF p_id IS NULL THEN
      v_kind := p_data ->> 'kind';
      IF v_kind IS NULL THEN RAISE EXCEPTION 'Say what kind of item this is' USING ERRCODE = 'QM036'; END IF;
      v_parent := nullif(p_data ->> 'parentId', '')::uuid;
      SELECT coalesce(max(position), 0) + 1 INTO v_next FROM public.fmea_items WHERE revision_id = r.id AND parent_id IS NOT DISTINCT FROM v_parent;
      INSERT INTO public.fmea_items (organisation_id, revision_id, parent_id, kind, element_type, name, description, operation_code, machine_id, part_id, position)
      VALUES (r.organisation_id, r.id, v_parent, v_kind, v_type, v_name, app.fmea_text(p_data ->> 'description', 'The description', 1000),
              app.fmea_text(p_data ->> 'operationCode', 'The operation code', 40), nullif(p_data ->> 'machineId', '')::uuid, nullif(p_data ->> 'partId', '')::uuid,
              app.fmea_position(p_data ->> 'position', v_next))
      RETURNING id INTO v_id;
    ELSE
      IF p_data ? 'kind' AND p_data ->> 'kind' IS DISTINCT FROM i.kind THEN RAISE EXCEPTION 'An item''s kind never changes: remove it and add the right kind' USING ERRCODE = 'QM036'; END IF;
      UPDATE public.fmea_items SET
        parent_id = CASE WHEN p_data ? 'parentId' THEN nullif(p_data ->> 'parentId', '')::uuid ELSE parent_id END,
        name = v_name, element_type = v_type,
        description = CASE WHEN p_data ? 'description' THEN app.fmea_text(p_data ->> 'description', 'The description', 1000) ELSE description END,
        operation_code = CASE WHEN p_data ? 'operationCode' THEN app.fmea_text(p_data ->> 'operationCode', 'The operation code', 40) ELSE operation_code END,
        machine_id = CASE WHEN p_data ? 'machineId' THEN nullif(p_data ->> 'machineId', '')::uuid ELSE machine_id END,
        part_id = CASE WHEN p_data ? 'partId' THEN nullif(p_data ->> 'partId', '')::uuid ELSE part_id END,
        position = CASE WHEN p_data ? 'position' THEN app.fmea_position(p_data ->> 'position', position) ELSE position END
       WHERE id = i.id;
      v_id := i.id;
    END IF;
  EXCEPTION
    WHEN foreign_key_violation THEN RAISE EXCEPTION 'That parent, machine or part is not in this organisation' USING ERRCODE = 'QM036';
    WHEN invalid_text_representation THEN RAISE EXCEPTION 'A parent, machine or part is named by its id' USING ERRCODE = 'QM036';
  END;
  UPDATE public.fmea_revisions SET updated_at = now() WHERE id = r.id;
  RETURN v_id;
END $$;

-- Keys: text, requirement, characteristicKey, position. Added to an item.
CREATE FUNCTION app.save_fmea_function(p_item uuid, p_id uuid, p_data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.fmea_revisions%ROWTYPE; x public.fmea_functions%ROWTYPE; v_rev uuid; v_item uuid; v_id uuid; v_text text; v_next integer;
BEGIN
  IF p_id IS NOT NULL THEN SELECT revision_id, item_id INTO v_rev, v_item FROM public.fmea_functions WHERE id = p_id;
  ELSE SELECT revision_id, id INTO v_rev, v_item FROM public.fmea_items WHERE id = p_item; END IF;
  IF v_rev IS NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
  r := app.fmea_draft_for_update(v_rev);
  PERFORM app.fmea_keys(p_data, ARRAY['text', 'requirement', 'characteristicKey', 'position']);
  IF p_id IS NOT NULL THEN SELECT * INTO x FROM public.fmea_functions WHERE id = p_id FOR UPDATE; END IF;
  v_text := CASE WHEN p_data ? 'text' THEN btrim(coalesce(p_data ->> 'text', '')) ELSE x.text END;
  IF v_text IS NULL OR length(v_text) = 0 THEN RAISE EXCEPTION 'Say what the function is' USING ERRCODE = 'QM036'; END IF;
  IF length(v_text) > 1000 THEN RAISE EXCEPTION 'The function is up to 1000 characters' USING ERRCODE = 'QM036'; END IF;
  IF p_id IS NULL THEN
    SELECT coalesce(max(position), 0) + 1 INTO v_next FROM public.fmea_functions WHERE item_id = v_item;
    INSERT INTO public.fmea_functions (organisation_id, revision_id, item_id, text, requirement, characteristic_key, position)
    VALUES (r.organisation_id, r.id, v_item, v_text, app.fmea_text(p_data ->> 'requirement', 'The requirement', 1000), app.fmea_text(p_data ->> 'characteristicKey', 'The characteristic key', 80),
            app.fmea_position(p_data ->> 'position', v_next))
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.fmea_functions SET text = v_text,
      requirement = CASE WHEN p_data ? 'requirement' THEN app.fmea_text(p_data ->> 'requirement', 'The requirement', 1000) ELSE requirement END,
      characteristic_key = CASE WHEN p_data ? 'characteristicKey' THEN app.fmea_text(p_data ->> 'characteristicKey', 'The characteristic key', 80) ELSE characteristic_key END,
      position = CASE WHEN p_data ? 'position' THEN app.fmea_position(p_data ->> 'position', position) ELSE position END
     WHERE id = x.id;
    v_id := x.id;
  END IF;
  UPDATE public.fmea_revisions SET updated_at = now() WHERE id = r.id;
  RETURN v_id;
END $$;

-- Keys: text, specialClass (critical | significant | null), position. Added to a function.
CREATE FUNCTION app.save_fmea_failure_mode(p_function uuid, p_id uuid, p_data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.fmea_revisions%ROWTYPE; x public.fmea_failure_modes%ROWTYPE; v_rev uuid; v_fn uuid; v_id uuid; v_text text; v_class text; v_next integer;
BEGIN
  IF p_id IS NOT NULL THEN SELECT revision_id, function_id INTO v_rev, v_fn FROM public.fmea_failure_modes WHERE id = p_id;
  ELSE SELECT revision_id, id INTO v_rev, v_fn FROM public.fmea_functions WHERE id = p_function; END IF;
  IF v_rev IS NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
  r := app.fmea_draft_for_update(v_rev);
  PERFORM app.fmea_keys(p_data, ARRAY['text', 'specialClass', 'position']);
  IF p_id IS NOT NULL THEN SELECT * INTO x FROM public.fmea_failure_modes WHERE id = p_id FOR UPDATE; END IF;
  v_text := CASE WHEN p_data ? 'text' THEN btrim(coalesce(p_data ->> 'text', '')) ELSE x.text END;
  IF v_text IS NULL OR length(v_text) = 0 THEN RAISE EXCEPTION 'Say how it fails' USING ERRCODE = 'QM036'; END IF;
  IF length(v_text) > 500 THEN RAISE EXCEPTION 'The failure mode is up to 500 characters' USING ERRCODE = 'QM036'; END IF;
  v_class := CASE WHEN p_data ? 'specialClass' THEN nullif(btrim(coalesce(p_data ->> 'specialClass', '')), '') ELSE x.special_class END;
  IF v_class IS NOT NULL AND v_class NOT IN ('critical', 'significant') THEN RAISE EXCEPTION 'A special characteristic is critical or significant' USING ERRCODE = 'QM036'; END IF;
  IF p_id IS NULL THEN
    SELECT coalesce(max(position), 0) + 1 INTO v_next FROM public.fmea_failure_modes WHERE function_id = v_fn;
    INSERT INTO public.fmea_failure_modes (organisation_id, revision_id, function_id, text, special_class, position)
    VALUES (r.organisation_id, r.id, v_fn, v_text, v_class, app.fmea_position(p_data ->> 'position', v_next)) RETURNING id INTO v_id;
  ELSE
    UPDATE public.fmea_failure_modes SET text = v_text, special_class = v_class,
      position = CASE WHEN p_data ? 'position' THEN app.fmea_position(p_data ->> 'position', position) ELSE position END WHERE id = x.id;
    v_id := x.id;
  END IF;
  UPDATE public.fmea_revisions SET updated_at = now() WHERE id = r.id;
  RETURN v_id;
END $$;

-- Keys: level (own_plant | next_plant | end_user), text, severity (1-10 or null), position. Added to a failure mode; the causes of that mode are re-scored.
CREATE FUNCTION app.save_fmea_effect(p_mode uuid, p_id uuid, p_data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.fmea_revisions%ROWTYPE; x public.fmea_effects%ROWTYPE; v_rev uuid; v_mode uuid; v_id uuid; v_text text; v_level text; v_sev integer; v_next integer;
BEGIN
  IF p_id IS NOT NULL THEN SELECT revision_id, failure_mode_id INTO v_rev, v_mode FROM public.fmea_effects WHERE id = p_id;
  ELSE SELECT revision_id, id INTO v_rev, v_mode FROM public.fmea_failure_modes WHERE id = p_mode; END IF;
  IF v_rev IS NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
  r := app.fmea_draft_for_update(v_rev);
  PERFORM app.fmea_keys(p_data, ARRAY['level', 'text', 'severity', 'position']);
  IF p_id IS NOT NULL THEN SELECT * INTO x FROM public.fmea_effects WHERE id = p_id FOR UPDATE; END IF;
  v_text := CASE WHEN p_data ? 'text' THEN btrim(coalesce(p_data ->> 'text', '')) ELSE x.text END;
  IF v_text IS NULL OR length(v_text) = 0 THEN RAISE EXCEPTION 'Say what the effect is' USING ERRCODE = 'QM036'; END IF;
  IF length(v_text) > 500 THEN RAISE EXCEPTION 'The effect is up to 500 characters' USING ERRCODE = 'QM036'; END IF;
  v_level := CASE WHEN p_data ? 'level' THEN p_data ->> 'level' ELSE coalesce(x.level, 'end_user') END;
  IF v_level IS NULL OR v_level NOT IN ('own_plant', 'next_plant', 'end_user') THEN RAISE EXCEPTION 'An effect shows at your plant, the next plant or the end user' USING ERRCODE = 'QM036'; END IF;
  v_sev := CASE WHEN p_data ? 'severity' THEN app.fmea_level(p_data ->> 'severity', 'Severity') ELSE x.severity END;
  IF p_id IS NULL THEN
    SELECT coalesce(max(position), 0) + 1 INTO v_next FROM public.fmea_effects WHERE failure_mode_id = v_mode;
    INSERT INTO public.fmea_effects (organisation_id, revision_id, failure_mode_id, level, text, severity, position)
    VALUES (r.organisation_id, r.id, v_mode, v_level, v_text, v_sev, app.fmea_position(p_data ->> 'position', v_next)) RETURNING id INTO v_id;
  ELSE
    UPDATE public.fmea_effects SET level = v_level, text = v_text, severity = v_sev,
      position = CASE WHEN p_data ? 'position' THEN app.fmea_position(p_data ->> 'position', position) ELSE position END WHERE id = x.id;
    v_id := x.id;
  END IF;
  PERFORM app.fmea_rescore_mode(v_mode);
  UPDATE public.fmea_revisions SET updated_at = now() WHERE id = r.id;
  RETURN v_id;
END $$;

-- Keys: text, preventionControls, detectionControls, occurrence, detection (1-10 or null), noActionReason, position. Added to a failure mode; the figures are worked out by the database.
CREATE FUNCTION app.save_fmea_cause(p_mode uuid, p_id uuid, p_data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.fmea_revisions%ROWTYPE; x public.fmea_causes%ROWTYPE; v_rev uuid; v_mode uuid; v_id uuid; v_text text; v_reason text; v_next integer;
BEGIN
  IF p_id IS NOT NULL THEN SELECT revision_id, failure_mode_id INTO v_rev, v_mode FROM public.fmea_causes WHERE id = p_id;
  ELSE SELECT revision_id, id INTO v_rev, v_mode FROM public.fmea_failure_modes WHERE id = p_mode; END IF;
  IF v_rev IS NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
  r := app.fmea_draft_for_update(v_rev);
  PERFORM app.fmea_keys(p_data, ARRAY['text', 'preventionControls', 'detectionControls', 'occurrence', 'detection', 'noActionReason', 'position']);
  IF p_id IS NOT NULL THEN SELECT * INTO x FROM public.fmea_causes WHERE id = p_id FOR UPDATE; END IF;
  v_text := CASE WHEN p_data ? 'text' THEN btrim(coalesce(p_data ->> 'text', '')) ELSE x.text END;
  IF v_text IS NULL OR length(v_text) = 0 THEN RAISE EXCEPTION 'Say what causes it' USING ERRCODE = 'QM036'; END IF;
  IF length(v_text) > 500 THEN RAISE EXCEPTION 'The cause is up to 500 characters' USING ERRCODE = 'QM036'; END IF;
  v_reason := CASE WHEN p_data ? 'noActionReason' THEN app.fmea_text(p_data ->> 'noActionReason', 'The reason', 500) ELSE x.no_action_reason END;
  IF v_reason IS NOT NULL AND length(v_reason) < 3 THEN RAISE EXCEPTION 'The reason is at least 3 characters' USING ERRCODE = 'QM036'; END IF;
  IF p_id IS NULL THEN
    SELECT coalesce(max(position), 0) + 1 INTO v_next FROM public.fmea_causes WHERE failure_mode_id = v_mode;
    INSERT INTO public.fmea_causes (organisation_id, revision_id, failure_mode_id, text, prevention_controls, detection_controls, occurrence, detection, no_action_reason, position)
    VALUES (r.organisation_id, r.id, v_mode, v_text, app.fmea_text(p_data ->> 'preventionControls', 'The prevention controls', 1000), app.fmea_text(p_data ->> 'detectionControls', 'The detection controls', 1000),
            app.fmea_level(p_data ->> 'occurrence', 'Occurrence'), app.fmea_level(p_data ->> 'detection', 'Detection'), v_reason, app.fmea_position(p_data ->> 'position', v_next))
    RETURNING id INTO v_id;
  ELSE
    -- The figures worked out from the ratings are cleared here and put back, from the effects and the model, by the re-score below.
    UPDATE public.fmea_causes SET text = v_text, no_action_reason = v_reason, rpn = NULL, priority = NULL, needs_attention = NULL,
      prevention_controls = CASE WHEN p_data ? 'preventionControls' THEN app.fmea_text(p_data ->> 'preventionControls', 'The prevention controls', 1000) ELSE prevention_controls END,
      detection_controls = CASE WHEN p_data ? 'detectionControls' THEN app.fmea_text(p_data ->> 'detectionControls', 'The detection controls', 1000) ELSE detection_controls END,
      occurrence = CASE WHEN p_data ? 'occurrence' THEN app.fmea_level(p_data ->> 'occurrence', 'Occurrence') ELSE occurrence END,
      detection = CASE WHEN p_data ? 'detection' THEN app.fmea_level(p_data ->> 'detection', 'Detection') ELSE detection END,
      position = CASE WHEN p_data ? 'position' THEN app.fmea_position(p_data ->> 'position', position) ELSE position END
     WHERE id = x.id;
    v_id := x.id;
  END IF;
  PERFORM app.fmea_rescore_mode(v_mode);
  UPDATE public.fmea_revisions SET updated_at = now() WHERE id = r.id;
  RETURN v_id;
END $$;

-- Removes one node and everything under it (kind: item | function | failure_mode | effect | cause). Removing an effect re-scores the causes of its mode.
CREATE FUNCTION app.remove_fmea_node(p_kind text, p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.fmea_revisions%ROWTYPE; v_rev uuid; v_mode uuid;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('item', 'function', 'failure_mode', 'effect', 'cause') THEN RAISE EXCEPTION 'Unknown kind of node' USING ERRCODE = 'QM036'; END IF;
  EXECUTE format('SELECT revision_id FROM public.%I WHERE id = $1', CASE p_kind WHEN 'item' THEN 'fmea_items' WHEN 'function' THEN 'fmea_functions'
                 WHEN 'failure_mode' THEN 'fmea_failure_modes' WHEN 'effect' THEN 'fmea_effects' ELSE 'fmea_causes' END) INTO v_rev USING p_id;
  IF v_rev IS NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
  r := app.fmea_draft_for_update(v_rev);
  IF p_kind = 'effect' THEN SELECT failure_mode_id INTO v_mode FROM public.fmea_effects WHERE id = p_id; END IF;
  EXECUTE format('DELETE FROM public.%I WHERE id = $1', CASE p_kind WHEN 'item' THEN 'fmea_items' WHEN 'function' THEN 'fmea_functions'
                 WHEN 'failure_mode' THEN 'fmea_failure_modes' WHEN 'effect' THEN 'fmea_effects' ELSE 'fmea_causes' END) USING p_id;
  IF v_mode IS NOT NULL THEN PERFORM app.fmea_rescore_mode(v_mode); END IF;
  UPDATE public.fmea_revisions SET updated_at = now() WHERE id = r.id;
END $$;

-- ---------------------------------------------------------------------------
-- 6. Copying an analysis (a new revision, or an FMEA started from a base) with its lineage
-- ---------------------------------------------------------------------------
-- p_mode 'revision': the new revision continues the old one (prev_row_id = the old row; base_row_id carried along).
-- p_mode 'base': the new FMEA starts from a base (base_row_id = the base's row; no prev_row_id).
-- Internal: the caller has checked the right to read the source and to write the target.
CREATE FUNCTION app.fmea_copy_net(p_from uuid, p_to uuid, p_mode text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid;
BEGIN
  IF p_mode NOT IN ('revision', 'base') THEN RAISE EXCEPTION 'Unknown copy mode' USING ERRCODE = 'QM036'; END IF;
  SELECT organisation_id INTO v_org FROM public.fmea_revisions WHERE id = p_to;
  -- Items first without their parents, then the parents by lineage.
  INSERT INTO public.fmea_items (organisation_id, revision_id, parent_id, kind, element_type, name, description, operation_code, machine_id, part_id, position, prev_row_id, base_row_id)
  SELECT o.organisation_id, p_to, NULL, o.kind, o.element_type, o.name, o.description, o.operation_code, o.machine_id, o.part_id, o.position,
         CASE WHEN p_mode = 'revision' THEN o.id END, CASE WHEN p_mode = 'revision' THEN o.base_row_id ELSE o.id END
    FROM public.fmea_items o WHERE o.revision_id = p_from AND o.parent_id IS NULL;
  -- Deeper levels: each pass copies the items whose parent has been copied (a structure is at most three levels deep).
  FOR i IN 1..3 LOOP
    INSERT INTO public.fmea_items (organisation_id, revision_id, parent_id, kind, element_type, name, description, operation_code, machine_id, part_id, position, prev_row_id, base_row_id)
    SELECT o.organisation_id, p_to, n.id, o.kind, o.element_type, o.name, o.description, o.operation_code, o.machine_id, o.part_id, o.position,
           CASE WHEN p_mode = 'revision' THEN o.id END, CASE WHEN p_mode = 'revision' THEN o.base_row_id ELSE o.id END
      FROM public.fmea_items o
      JOIN public.fmea_items n ON n.revision_id = p_to AND (CASE WHEN p_mode = 'revision' THEN n.prev_row_id ELSE n.base_row_id END) = o.parent_id
     WHERE o.revision_id = p_from AND o.parent_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.fmea_items x WHERE x.revision_id = p_to AND (CASE WHEN p_mode = 'revision' THEN x.prev_row_id ELSE x.base_row_id END) = o.id);
  END LOOP;
  INSERT INTO public.fmea_functions (organisation_id, revision_id, item_id, text, requirement, characteristic_key, position, prev_row_id, base_row_id)
  SELECT o.organisation_id, p_to, n.id, o.text, o.requirement, o.characteristic_key, o.position,
         CASE WHEN p_mode = 'revision' THEN o.id END, CASE WHEN p_mode = 'revision' THEN o.base_row_id ELSE o.id END
    FROM public.fmea_functions o JOIN public.fmea_items n ON n.revision_id = p_to AND (CASE WHEN p_mode = 'revision' THEN n.prev_row_id ELSE n.base_row_id END) = o.item_id
   WHERE o.revision_id = p_from;
  INSERT INTO public.fmea_failure_modes (organisation_id, revision_id, function_id, text, special_class, position, prev_row_id, base_row_id)
  SELECT o.organisation_id, p_to, n.id, o.text, o.special_class, o.position,
         CASE WHEN p_mode = 'revision' THEN o.id END, CASE WHEN p_mode = 'revision' THEN o.base_row_id ELSE o.id END
    FROM public.fmea_failure_modes o JOIN public.fmea_functions n ON n.revision_id = p_to AND (CASE WHEN p_mode = 'revision' THEN n.prev_row_id ELSE n.base_row_id END) = o.function_id
   WHERE o.revision_id = p_from;
  INSERT INTO public.fmea_effects (organisation_id, revision_id, failure_mode_id, level, text, severity, position, prev_row_id, base_row_id)
  SELECT o.organisation_id, p_to, n.id, o.level, o.text, o.severity, o.position,
         CASE WHEN p_mode = 'revision' THEN o.id END, CASE WHEN p_mode = 'revision' THEN o.base_row_id ELSE o.id END
    FROM public.fmea_effects o JOIN public.fmea_failure_modes n ON n.revision_id = p_to AND (CASE WHEN p_mode = 'revision' THEN n.prev_row_id ELSE n.base_row_id END) = o.failure_mode_id
   WHERE o.revision_id = p_from;
  INSERT INTO public.fmea_causes (organisation_id, revision_id, failure_mode_id, text, prevention_controls, detection_controls, occurrence, detection, no_action_reason, position, prev_row_id, base_row_id)
  SELECT o.organisation_id, p_to, n.id, o.text, o.prevention_controls, o.detection_controls, o.occurrence, o.detection, o.no_action_reason, o.position,
         CASE WHEN p_mode = 'revision' THEN o.id END, CASE WHEN p_mode = 'revision' THEN o.base_row_id ELSE o.id END
    FROM public.fmea_causes o JOIN public.fmea_failure_modes n ON n.revision_id = p_to AND (CASE WHEN p_mode = 'revision' THEN n.prev_row_id ELSE n.base_row_id END) = o.failure_mode_id
   WHERE o.revision_id = p_from;
  PERFORM app.fmea_rescore_revision(p_to);
END $$;

-- A new draft from the revision in force (or the last one issued): the team, the scope and now the whole analysis are copied (with lineage); the change summary starts empty.
CREATE OR REPLACE FUNCTION app.start_fmea_revision(p_fmea uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE f public.fmeas%ROWTYPE; v_from public.fmea_revisions%ROWTYPE; v_id uuid; v_seq integer;
BEGIN
  f := app.fmea_for_write(p_fmea);
  PERFORM app.settle_fmea(f.id);
  SELECT * INTO f FROM public.fmeas WHERE id = p_fmea;
  IF f.status NOT IN ('active', 'withdrawn') THEN RAISE EXCEPTION '% has never been in force: carry on with its draft', f.number USING ERRCODE = 'QM036'; END IF;
  IF EXISTS (SELECT 1 FROM public.fmea_revisions WHERE fmea_id = f.id AND status IN ('draft', 'pending_approval', 'approved')) THEN
    RAISE EXCEPTION '% already has a revision in progress', f.number USING ERRCODE = 'QM036';
  END IF;
  SELECT * INTO v_from FROM public.fmea_revisions
   WHERE fmea_id = f.id AND status IN ('effective', 'superseded', 'withdrawn') ORDER BY (status = 'effective') DESC, sequence DESC LIMIT 1;
  SELECT coalesce(max(sequence), 0) + 1 INTO v_seq FROM public.fmea_revisions WHERE fmea_id = f.id;
  INSERT INTO public.fmea_revisions (organisation_id, fmea_id, sequence, previous_revision_id, based_on_revision_id)
  VALUES (f.organisation_id, f.id, v_seq, v_from.id, v_from.based_on_revision_id) RETURNING id INTO v_id;
  INSERT INTO public.fmea_team_members (organisation_id, revision_id, employee_id, user_id, role)
  SELECT organisation_id, v_id, employee_id, user_id, role FROM public.fmea_team_members WHERE revision_id = v_from.id;
  INSERT INTO public.fmea_links (organisation_id, revision_id, kind, part_id, part_family_id, control_plan_id, machine_id, supplier_id, customer_id, operation_code)
  SELECT organisation_id, v_id, kind, part_id, part_family_id, control_plan_id, machine_id, supplier_id, customer_id, operation_code FROM public.fmea_links WHERE revision_id = v_from.id;
  PERFORM app.fmea_copy_net(v_from.id, v_id, 'revision');
  RETURN v_id;
END $$;

-- Keys: kind, title, scopeText, customerId, ownerId (default the caller), reviewMonths, team [..], links [..], baseFmeaId (start from an FMEA of the same kind that is in force:
-- its analysis is copied, with lineage, into the first draft; the team and the scope are the new FMEA's own). Makes the FMEA and its first draft revision.
CREATE OR REPLACE FUNCTION app.create_fmea(p_organisation_id uuid, p_data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE k text; v_n integer; v_id uuid; v_rev uuid; v_kind text; v_title text; v_owner uuid; v_customer uuid; v_months integer; v_base uuid; b public.fmeas%ROWTYPE;
BEGIN
  PERFORM app.assert_fmea_manager(p_organisation_id);
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Send the FMEA as an object' USING ERRCODE = 'QM036'; END IF;
  FOR k IN SELECT jsonb_object_keys(p_data) LOOP
    IF k NOT IN ('kind', 'title', 'scopeText', 'customerId', 'ownerId', 'reviewMonths', 'team', 'links', 'baseFmeaId') THEN RAISE EXCEPTION 'Unknown field %', k USING ERRCODE = 'QM036'; END IF;
  END LOOP;
  v_kind := p_data ->> 'kind';
  IF v_kind IS NULL OR v_kind NOT IN ('design', 'process') THEN RAISE EXCEPTION 'An FMEA is a design FMEA or a process FMEA' USING ERRCODE = 'QM036'; END IF;
  v_title := btrim(coalesce(p_data ->> 'title', ''));
  IF length(v_title) = 0 THEN RAISE EXCEPTION 'Give the FMEA a title' USING ERRCODE = 'QM036'; END IF;
  IF length(v_title) > 200 THEN RAISE EXCEPTION 'The title is up to 200 characters' USING ERRCODE = 'QM036'; END IF;
  v_owner := coalesce(nullif(p_data ->> 'ownerId', '')::uuid, auth.uid());
  IF NOT app.is_active_member_user(p_organisation_id, v_owner) THEN RAISE EXCEPTION 'The owner must be an active member of this organisation' USING ERRCODE = 'QM036'; END IF;
  v_customer := nullif(p_data ->> 'customerId', '')::uuid;
  IF v_customer IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.customers c WHERE c.id = v_customer AND c.organisation_id = p_organisation_id) THEN
    RAISE EXCEPTION 'That customer is not in this organisation' USING ERRCODE = 'QM036';
  END IF;
  v_months := nullif(p_data ->> 'reviewMonths', '')::integer;
  IF v_months IS NOT NULL AND v_months NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION 'Review every 1 to 120 months' USING ERRCODE = 'QM036'; END IF;
  v_base := nullif(p_data ->> 'baseFmeaId', '')::uuid;
  IF v_base IS NOT NULL THEN
    SELECT * INTO b FROM public.fmeas WHERE id = v_base AND organisation_id = p_organisation_id;
    IF NOT FOUND OR NOT app.fmea_readable(b.id) THEN RAISE EXCEPTION 'That FMEA is not in this organisation' USING ERRCODE = 'QM036'; END IF;
    IF b.kind <> v_kind THEN RAISE EXCEPTION 'An FMEA can start only from an FMEA of the same kind (% is a % FMEA)', b.number, b.kind USING ERRCODE = 'QM036'; END IF;
    PERFORM app.settle_fmea(b.id);
    SELECT * INTO b FROM public.fmeas WHERE id = v_base;
    IF b.status <> 'active' OR b.current_revision_id IS NULL THEN RAISE EXCEPTION '% is not in force, so a new FMEA cannot start from it', b.number USING ERRCODE = 'QM036'; END IF;
  END IF;
  INSERT INTO app.fmea_counters AS c (organisation_id, last_value) VALUES (p_organisation_id, 1)
  ON CONFLICT (organisation_id) DO UPDATE SET last_value = c.last_value + 1 RETURNING last_value INTO v_n;
  INSERT INTO public.fmeas (organisation_id, number, kind, title, scope_text, customer_id, owner_user_id, review_months, base_fmea_id)
  VALUES (p_organisation_id, 'FMEA-' || app.pad_number(v_n, 3), v_kind, v_title, nullif(btrim(coalesce(p_data ->> 'scopeText', '')), ''), v_customer, v_owner, v_months, v_base)
  RETURNING id INTO v_id;
  INSERT INTO public.fmea_revisions (organisation_id, fmea_id, sequence, based_on_revision_id) VALUES (p_organisation_id, v_id, 1, b.current_revision_id) RETURNING id INTO v_rev;
  IF p_data ? 'team' THEN PERFORM app.set_fmea_team(v_rev, p_data -> 'team'); END IF;
  IF p_data ? 'links' THEN PERFORM app.set_fmea_links(v_rev, p_data -> 'links'); END IF;
  IF v_base IS NOT NULL THEN PERFORM app.fmea_copy_net(b.current_revision_id, v_rev, 'base'); END IF;
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------
-- 7. What a draft still needs: FM1's list, now with the analysis
-- ---------------------------------------------------------------------------
-- "N things have no X (first: ...)" in the words of the list.
CREATE FUNCTION app.fmea_problem(p_count bigint, p_one text, p_many text, p_first text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN p_count = 1 THEN '1 ' || p_one ELSE p_count || ' ' || p_many END || ' (first: ' || left(coalesce(p_first, ''), 60) || ')'
$$;

CREATE OR REPLACE FUNCTION app.fmea_revision_problems(p_revision uuid) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.fmea_revisions%ROWTYPE; f public.fmeas%ROWTYPE; v text[] := ARRAY[]::text[]; n bigint; v_first text; v_floor integer;
BEGIN
  SELECT * INTO r FROM public.fmea_revisions WHERE id = p_revision;
  IF NOT FOUND OR r.status <> 'draft' THEN RETURN v; END IF;
  IF NOT app.fmea_revision_readable(r.id) THEN RETURN v; END IF;
  SELECT * INTO f FROM public.fmeas WHERE id = r.fmea_id;
  IF NOT EXISTS (SELECT 1 FROM public.fmea_team_members WHERE revision_id = r.id AND role = 'lead') THEN v := v || 'Name the team lead'::text; END IF;
  IF (SELECT count(*) FROM public.fmea_team_members WHERE revision_id = r.id) < 2 THEN v := v || 'A team is more than one person: add the rest of the team'::text; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.fmea_links WHERE revision_id = r.id) THEN v := v || 'Say what the FMEA covers (a part, family, control plan, machine or operation)'::text; END IF;

  -- The analysis.
  IF NOT EXISTS (SELECT 1 FROM public.fmea_items WHERE revision_id = r.id) THEN
    v := v || 'Build the structure: add at least one item'::text;
  ELSE
    SELECT count(*), (array_agg(i.name ORDER BY i.position, i.created_at))[1] INTO n, v_first FROM public.fmea_items i
     WHERE i.revision_id = r.id AND NOT EXISTS (SELECT 1 FROM public.fmea_items c WHERE c.parent_id = i.id) AND NOT EXISTS (SELECT 1 FROM public.fmea_functions x WHERE x.item_id = i.id);
    IF n > 0 THEN v := v || app.fmea_problem(n, 'item with nothing below it has no function', 'items with nothing below them have no function', v_first); END IF;
  END IF;
  SELECT count(*), (array_agg(x.text ORDER BY x.position, x.created_at))[1] INTO n, v_first FROM public.fmea_functions x
   WHERE x.revision_id = r.id AND NOT EXISTS (SELECT 1 FROM public.fmea_failure_modes m WHERE m.function_id = x.id);
  IF n > 0 THEN v := v || app.fmea_problem(n, 'function has no failure mode', 'functions have no failure mode', v_first); END IF;
  SELECT count(*), (array_agg(m.text ORDER BY m.position, m.created_at))[1] INTO n, v_first FROM public.fmea_failure_modes m
   WHERE m.revision_id = r.id AND NOT EXISTS (SELECT 1 FROM public.fmea_effects e WHERE e.failure_mode_id = m.id);
  IF n > 0 THEN v := v || app.fmea_problem(n, 'failure mode has no effect', 'failure modes have no effect', v_first); END IF;
  SELECT count(*), (array_agg(e.text ORDER BY e.position, e.created_at))[1] INTO n, v_first FROM public.fmea_effects e WHERE e.revision_id = r.id AND e.severity IS NULL;
  IF n > 0 THEN v := v || app.fmea_problem(n, 'effect has no severity', 'effects have no severity', v_first); END IF;
  SELECT count(*), (array_agg(m.text ORDER BY m.position, m.created_at))[1] INTO n, v_first FROM public.fmea_failure_modes m
   WHERE m.revision_id = r.id AND NOT EXISTS (SELECT 1 FROM public.fmea_causes c WHERE c.failure_mode_id = m.id);
  IF n > 0 THEN v := v || app.fmea_problem(n, 'failure mode has no cause', 'failure modes have no cause', v_first); END IF;
  SELECT count(*), (array_agg(c.text ORDER BY c.position, c.created_at))[1] INTO n, v_first FROM public.fmea_causes c
   WHERE c.revision_id = r.id AND (c.occurrence IS NULL OR c.detection IS NULL);
  IF n > 0 THEN v := v || app.fmea_problem(n, 'cause has no occurrence or detection rating', 'causes have no occurrence or detection rating', v_first); END IF;
  SELECT count(*), (array_agg(c.text ORDER BY c.position, c.created_at))[1] INTO n, v_first FROM public.fmea_causes c
   WHERE c.revision_id = r.id AND c.prevention_controls IS NULL AND c.detection_controls IS NULL;
  IF n > 0 THEN v := v || app.fmea_problem(n, 'cause names no prevention or detection control', 'causes name no prevention or detection control', v_first); END IF;
  SELECT count(*), (array_agg(c.text ORDER BY c.position, c.created_at))[1] INTO n, v_first FROM public.fmea_causes c
   WHERE c.revision_id = r.id AND c.needs_attention AND c.no_action_reason IS NULL;
  IF n > 0 THEN
    SELECT (mo.config ->> 'severityFloor')::integer INTO v_floor FROM public.fmea_models mo WHERE mo.id = r.model_id;
    v := v || (app.fmea_problem(n, 'cause needs attention', 'causes need attention', v_first)
               || ': its priority is high or its severity is ' || coalesce(v_floor::text, '9') || ' or more, so say what will be done or why nothing will be')::text;
  END IF;

  IF f.status IN ('active', 'withdrawn') AND r.change_summary IS NULL THEN v := v || 'Say what changed and why'::text; END IF;
  IF r.approver_id IS NULL THEN v := v || 'Name the approver'::text; END IF;
  IF r.approver_id IS NOT NULL AND NOT app.is_active_member_user(r.organisation_id, r.approver_id) THEN v := v || 'The approver is no longer an active member'::text; END IF;
  IF EXISTS (SELECT 1 FROM public.fmea_team_members m WHERE m.revision_id = r.id AND m.user_id IS NOT NULL AND NOT app.is_active_member_user(r.organisation_id, m.user_id)) THEN
    v := v || 'A team member is no longer an active member'::text;
  END IF;
  RETURN v;
END $$;

-- ---------------------------------------------------------------------------
-- 8. Privileges
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app.fmea_revision_defaults(), app.fmea_net_rules(), app.fmea_rescore_mode(uuid), app.fmea_rescore_revision(uuid), app.fmea_keys(jsonb, text[]),
  app.fmea_text(text, text, integer), app.fmea_level(text, text), app.fmea_position(text, integer), app.fmea_copy_net(uuid, uuid, text), app.fmea_problem(bigint, text, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.set_fmea_revision_model(uuid), app.save_fmea_item(uuid, uuid, jsonb), app.save_fmea_function(uuid, uuid, jsonb), app.save_fmea_failure_mode(uuid, uuid, jsonb),
  app.save_fmea_effect(uuid, uuid, jsonb), app.save_fmea_cause(uuid, uuid, jsonb), app.remove_fmea_node(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.set_fmea_revision_model(uuid), app.save_fmea_item(uuid, uuid, jsonb), app.save_fmea_function(uuid, uuid, jsonb), app.save_fmea_failure_mode(uuid, uuid, jsonb),
  app.save_fmea_effect(uuid, uuid, jsonb), app.save_fmea_cause(uuid, uuid, jsonb), app.remove_fmea_node(text, uuid) TO authenticated;
