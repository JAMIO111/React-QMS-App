-- FMEA slice FM5a (docs/fmea-plan.md FM11, §3 fmea_control_links): carrying a cause's control to the control plan.
--
-- A prevention or a detection control written on a cause can be CARRIED to a characteristic of a control plan: the link names the plan, the operation code and the
-- characteristic's stable key (so it survives plan revisions), and records who made it and when. Nothing is copied into the plan and nothing is decided for anyone:
-- the link is information, read by the coverage report ("causes that need attention and no plan characteristic covers") and by the control plan revision page.
--
--  * fmea_control_links: functions only, audited, never deleted by a person (a link is ended with a reason); frozen except for ending it;
--  * app.carry_fmea_cause_to_plan / end_fmea_control_link: the cause's revision must be a draft or the revision in force; when a newer revision is being prepared the
--    link is made there (so the two never disagree); the cause must hold the control being carried; the plan must be active and name that operation and characteristic;
--  * a new revision takes the live links of the one it continues (lineage), exactly as it takes the actions.

CREATE TABLE public.fmea_control_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  revision_id uuid NOT NULL,
  cause_id uuid NOT NULL,
  control_kind text NOT NULL CHECK (control_kind IN ('prevention', 'detection')),
  control_plan_id uuid NOT NULL,
  operation_code text NOT NULL CHECK (operation_code ~ '^\S(.{0,28}\S)?$'),
  characteristic_key text NOT NULL CHECK (characteristic_key ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  note text CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 500),
  prev_row_id uuid,
  ended_at timestamptz,
  ended_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  end_reason text CHECK (end_reason IS NULL OR length(btrim(end_reason)) BETWEEN 3 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT fmea_control_links_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT fmea_control_links_revision_fkey FOREIGN KEY (revision_id, organisation_id) REFERENCES public.fmea_revisions (id, organisation_id),
  CONSTRAINT fmea_control_links_cause_fkey FOREIGN KEY (cause_id, organisation_id) REFERENCES public.fmea_causes (id, organisation_id) ON DELETE CASCADE,
  CONSTRAINT fmea_control_links_plan_fkey FOREIGN KEY (control_plan_id, organisation_id) REFERENCES public.control_plans (id, organisation_id),
  CONSTRAINT fmea_control_links_prev_fkey FOREIGN KEY (prev_row_id, organisation_id) REFERENCES public.fmea_control_links (id, organisation_id),
  CONSTRAINT fmea_control_links_ended_check CHECK ((ended_at IS NULL) = (end_reason IS NULL))
);
-- One live link per cause, kind and plan characteristic.
CREATE UNIQUE INDEX fmea_control_links_live_key ON public.fmea_control_links (cause_id, control_kind, control_plan_id, upper(operation_code), characteristic_key) WHERE ended_at IS NULL;
CREATE INDEX fmea_control_links_revision_idx ON public.fmea_control_links (organisation_id, revision_id) WHERE ended_at IS NULL;
CREATE INDEX fmea_control_links_plan_idx ON public.fmea_control_links (organisation_id, control_plan_id, upper(operation_code), characteristic_key) WHERE ended_at IS NULL;

-- A link never changes, except that it can be ended once (with its reason). Held for SQL too.
CREATE FUNCTION app.fmea_control_link_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF OLD.ended_at IS NOT NULL THEN RAISE EXCEPTION 'An ended link stays as it was' USING ERRCODE = 'QM036'; END IF;
  IF NEW.organisation_id IS DISTINCT FROM OLD.organisation_id OR NEW.revision_id IS DISTINCT FROM OLD.revision_id OR NEW.cause_id IS DISTINCT FROM OLD.cause_id
     OR NEW.control_kind IS DISTINCT FROM OLD.control_kind OR NEW.control_plan_id IS DISTINCT FROM OLD.control_plan_id OR NEW.operation_code IS DISTINCT FROM OLD.operation_code
     OR NEW.characteristic_key IS DISTINCT FROM OLD.characteristic_key OR NEW.note IS DISTINCT FROM OLD.note OR NEW.prev_row_id IS DISTINCT FROM OLD.prev_row_id THEN
    RAISE EXCEPTION 'A link is ended, not changed: end it and make a new one' USING ERRCODE = 'QM036';
  END IF;
  IF NEW.ended_at IS NULL THEN RAISE EXCEPTION 'A link can be ended, not brought back: make a new one' USING ERRCODE = 'QM036'; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER fmea_control_links_stamp BEFORE INSERT ON public.fmea_control_links FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER fmea_control_links_a_rules BEFORE UPDATE ON public.fmea_control_links FOR EACH ROW EXECUTE FUNCTION app.fmea_control_link_rules();
CREATE TRIGGER fmea_control_links_touch BEFORE UPDATE ON public.fmea_control_links FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER fmea_control_links_org_immutable BEFORE UPDATE ON public.fmea_control_links FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.fmea_control_links FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');

ALTER TABLE public.fmea_control_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fmea_control_links FROM anon, authenticated;
GRANT SELECT ON public.fmea_control_links TO authenticated;
CREATE POLICY fmea_control_links_select ON public.fmea_control_links FOR SELECT TO authenticated USING (app.fmea_revision_readable(revision_id));

-- ---------------------------------------------------------------------------
-- Writing links
-- ---------------------------------------------------------------------------
-- A link is made or ended on a draft, or on the revision in force; if a newer revision is being prepared the work belongs there. Internal.
CREATE FUNCTION app.fmea_link_writable(p_revision uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.fmea_revisions%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.fmea_revisions WHERE id = p_revision;
  IF NOT FOUND THEN RAISE EXCEPTION 'Revision not found' USING ERRCODE = 'P0002'; END IF;
  IF r.status NOT IN ('draft', 'effective') THEN
    RAISE EXCEPTION 'Controls are carried to the control plan from a draft or from the revision in force, not from one that is %', replace(r.status, '_', ' ') USING ERRCODE = 'QM036';
  END IF;
  IF r.status = 'effective' AND EXISTS (
       SELECT 1 FROM public.fmea_revisions n WHERE n.fmea_id = r.fmea_id AND n.previous_revision_id = r.id AND n.status IN ('draft', 'pending_approval', 'approved')) THEN
    RAISE EXCEPTION 'A newer revision is being prepared: make the link there' USING ERRCODE = 'QM036';
  END IF;
END $$;

-- Keys: controlKind (prevention | detection), controlPlanId, operationCode, characteristicKey, note. The cause must hold that control; the plan must be active and (on a revision
-- of it that is in force or on its way) name that operation and characteristic. The caller needs fmea.manage and process_control.read.
CREATE FUNCTION app.carry_fmea_cause_to_plan(p_cause uuid, p_data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.fmea_causes%ROWTYPE; v_kind text; v_plan uuid; v_op text; v_key text; v_note text; v_canon text; v_id uuid;
BEGIN
  SELECT * INTO c FROM public.fmea_causes WHERE id = p_cause FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(c.organisation_id) THEN RAISE EXCEPTION 'Cause not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_fmea_manager(c.organisation_id);
  IF NOT app.has_permission(c.organisation_id, 'process_control.read') THEN RAISE EXCEPTION 'You need to be able to read control plans to carry a control to one' USING ERRCODE = '42501'; END IF;
  PERFORM app.fmea_keys(p_data, ARRAY['controlKind', 'controlPlanId', 'operationCode', 'characteristicKey', 'note']);
  PERFORM app.fmea_link_writable(c.revision_id);

  v_kind := p_data ->> 'controlKind';
  IF v_kind IS NULL OR v_kind NOT IN ('prevention', 'detection') THEN RAISE EXCEPTION 'Say whether the prevention or the detection control is carried' USING ERRCODE = 'QM036'; END IF;
  IF v_kind = 'prevention' AND c.prevention_controls IS NULL THEN RAISE EXCEPTION 'Write the prevention control on the cause before carrying it to the control plan' USING ERRCODE = 'QM036'; END IF;
  IF v_kind = 'detection' AND c.detection_controls IS NULL THEN RAISE EXCEPTION 'Write the detection control on the cause before carrying it to the control plan' USING ERRCODE = 'QM036'; END IF;

  BEGIN v_plan := nullif(p_data ->> 'controlPlanId', '')::uuid; EXCEPTION WHEN others THEN RAISE EXCEPTION 'The control plan is named by id' USING ERRCODE = 'QM036'; END;
  IF v_plan IS NULL THEN RAISE EXCEPTION 'Choose the control plan' USING ERRCODE = 'QM036'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.control_plans p WHERE p.id = v_plan AND p.organisation_id = c.organisation_id AND p.active) THEN
    RAISE EXCEPTION 'That control plan is not in this organisation, or is no longer in use' USING ERRCODE = 'QM036';
  END IF;
  v_op := btrim(coalesce(p_data ->> 'operationCode', ''));
  v_key := btrim(coalesce(p_data ->> 'characteristicKey', ''));
  IF v_op = '' OR v_key = '' THEN RAISE EXCEPTION 'Choose the operation and the characteristic' USING ERRCODE = 'QM036'; END IF;
  v_note := app.fmea_text(p_data ->> 'note', 'The note', 500);

  SELECT o.operation_code INTO v_canon
    FROM public.control_plan_revisions cr
    JOIN public.control_plan_operations o ON o.control_plan_revision_id = cr.id
    JOIN public.control_plan_characteristics ch ON ch.control_plan_revision_id = cr.id AND ch.operation_id = o.id
   WHERE cr.control_plan_id = v_plan AND cr.organisation_id = c.organisation_id AND cr.status IN ('effective', 'approved', 'pending_approval', 'draft')
     AND upper(o.operation_code) = upper(v_op) AND ch.characteristic_key = v_key
   ORDER BY (cr.status = 'effective') DESC, cr.created_at DESC LIMIT 1;
  IF v_canon IS NULL THEN RAISE EXCEPTION 'That control plan has no characteristic % at operation %', v_key, v_op USING ERRCODE = 'QM036'; END IF;

  IF EXISTS (SELECT 1 FROM public.fmea_control_links l WHERE l.cause_id = c.id AND l.control_kind = v_kind AND l.control_plan_id = v_plan
               AND upper(l.operation_code) = upper(v_canon) AND l.characteristic_key = v_key AND l.ended_at IS NULL) THEN
    RAISE EXCEPTION 'That control is already carried to this characteristic' USING ERRCODE = 'QM036';
  END IF;

  INSERT INTO public.fmea_control_links (organisation_id, revision_id, cause_id, control_kind, control_plan_id, operation_code, characteristic_key, note)
  VALUES (c.organisation_id, c.revision_id, c.id, v_kind, v_plan, v_canon, v_key, v_note) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Ends a link, with the reason. The link stays on record.
CREATE FUNCTION app.end_fmea_control_link(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE l public.fmea_control_links%ROWTYPE; v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  SELECT * INTO l FROM public.fmea_control_links WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(l.organisation_id) THEN RAISE EXCEPTION 'Link not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_fmea_manager(l.organisation_id);
  IF l.ended_at IS NOT NULL THEN RAISE EXCEPTION 'That link has already ended' USING ERRCODE = 'QM036'; END IF;
  IF length(v_reason) < 3 THEN RAISE EXCEPTION 'Say why the link ends (at least 3 characters)' USING ERRCODE = 'QM036'; END IF;
  IF length(v_reason) > 500 THEN RAISE EXCEPTION 'The reason is up to 500 characters' USING ERRCODE = 'QM036'; END IF;
  PERFORM app.fmea_link_writable(l.revision_id);
  UPDATE public.fmea_control_links SET ended_at = now(), ended_by = auth.uid(), end_reason = v_reason WHERE id = l.id;
END $$;

-- ---------------------------------------------------------------------------
-- A new revision takes the live links of the one it continues (by the lineage of the cause). Patched into the copy of the analysis; guarded so it is applied once.
-- ---------------------------------------------------------------------------
CREATE FUNCTION pg_temp.patch_once(p_fn regprocedure, p_marker text, p_old text, p_new text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_def text := replace(pg_get_functiondef(p_fn), E'\r', ''); v_n integer;
BEGIN
  IF position(p_marker IN v_def) > 0 THEN RETURN; END IF;
  v_n := (length(v_def) - length(replace(v_def, p_old, ''))) / length(p_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'Expected to find % exactly once in %, found % times', p_old, p_fn, v_n; END IF;
  EXECUTE replace(v_def, p_old, p_new);
END $$;

SELECT pg_temp.patch_once('app.fmea_copy_net(uuid, uuid, text)'::regprocedure, 'fmea_control_links',
  $old$  PERFORM app.fmea_rescore_revision(p_to);$old$,
  $new$  -- The live links of the controls carried to a control plan go on with the cause that continues theirs (a copy from a base brings none: it is for another part).
  IF p_mode = 'revision' THEN
    INSERT INTO public.fmea_control_links (organisation_id, revision_id, cause_id, control_kind, control_plan_id, operation_code, characteristic_key, note, prev_row_id)
    SELECT l.organisation_id, p_to, n.id, l.control_kind, l.control_plan_id, l.operation_code, l.characteristic_key, l.note, l.id
      FROM public.fmea_control_links l JOIN public.fmea_causes n ON n.revision_id = p_to AND n.prev_row_id = l.cause_id
     WHERE l.revision_id = p_from AND l.ended_at IS NULL;
  END IF;
  PERFORM app.fmea_rescore_revision(p_to);$new$);

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app.fmea_control_link_rules(), app.fmea_link_writable(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.carry_fmea_cause_to_plan(uuid, jsonb), app.end_fmea_control_link(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.carry_fmea_cause_to_plan(uuid, jsonb), app.end_fmea_control_link(uuid, text) TO authenticated;
