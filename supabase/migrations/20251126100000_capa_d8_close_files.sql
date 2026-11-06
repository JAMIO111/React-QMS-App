-- CAPA5 (docs/capa-8d-plan.md): D8 close and recognise, evidence files, and the closing rules.
--
--  * `capas.d8_recognition`: the recognition note written when the 8D is closed (set only by `app.close_capa`).
--  * `app.close_capa(id, recognition)` (needs capa.verify): D0 to D7 complete and the 8D verified effective; completes D8, stage -> closed with closed_at/closed_by.
--    D8 cannot be completed any other way. A closed 8D is read-only until `app.reopen_capa`, which now also marks D8 not done again.
--  * `capa_attachments`: evidence files on the 8D (private `capa-files` bucket at `<org>/capa/<capa id>/...`). Written only by functions while the 8D is
--    running (capa.manage); removal is a mark with a reason, never a delete; the files stay readable on a closed 8D (capa.read).
--  * `app.capa_step_problems` now covers D8.

ALTER TABLE public.capas
  ADD COLUMN d8_recognition text CHECK (d8_recognition IS NULL OR length(btrim(d8_recognition)) BETWEEN 1 AND 2000);

CREATE OR REPLACE FUNCTION app.capa_step_problems(p_capa uuid, p_step text) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.capas%ROWTYPE; v_problems text[] := ARRAY[]::text[]; v_leaders integer; v_people integer; v_open integer; v_done integer; v_occurrence integer; v_unverified integer;
        v_missing record; v_incomplete integer; v_state text;
BEGIN
  SELECT * INTO c FROM public.capas WHERE id = p_capa;
  IF NOT FOUND OR NOT app.has_permission(c.organisation_id, 'capa.read') THEN
    RAISE EXCEPTION '8D not found' USING ERRCODE = 'QM013';
  END IF;
  CASE p_step
    WHEN 'd0' THEN
      IF c.problem_statement IS NULL THEN v_problems := array_append(v_problems, 'Describe the problem in the problem statement'); END IF;
    WHEN 'd1' THEN
      SELECT count(*) FILTER (WHERE role = 'leader'), count(*) INTO v_leaders, v_people
        FROM public.capa_team_members WHERE capa_id = p_capa AND ended_at IS NULL;
      IF v_leaders = 0 THEN v_problems := array_append(v_problems, 'Name a team leader'); END IF;
      IF v_people < 2 THEN v_problems := array_append(v_problems, 'Add at least two people to the team'); END IF;
    WHEN 'd2' THEN
      IF c.d2_what IS NULL THEN v_problems := array_append(v_problems, 'Say what is wrong (the What of 5W2H)'); END IF;
      IF c.d2_where IS NULL THEN v_problems := array_append(v_problems, 'Say where it was found (the Where of 5W2H)'); END IF;
      IF c.d2_when IS NULL THEN v_problems := array_append(v_problems, 'Say when it was found (the When of 5W2H)'); END IF;
    WHEN 'd3' THEN
      SELECT count(*) FILTER (WHERE status = 'open'), count(*) FILTER (WHERE status = 'done') INTO v_open, v_done
        FROM public.capa_actions WHERE capa_id = p_capa AND phase = 'interim';
      IF v_open > 0 THEN
        v_problems := array_append(v_problems, format('Finish or cancel the %s open containment %s', v_open, CASE WHEN v_open = 1 THEN 'action' ELSE 'actions' END));
      END IF;
      IF v_done = 0 AND c.d3_no_containment_reason IS NULL THEN
        v_problems := array_append(v_problems, 'Add an interim containment action, or say why none is needed');
      END IF;
    WHEN 'd4' THEN
      SELECT count(*) FILTER (WHERE kind = 'occurrence'), count(*) FILTER (WHERE NOT verified) INTO v_occurrence, v_unverified
        FROM public.capa_root_causes WHERE capa_id = p_capa AND deleted_at IS NULL;
      IF v_occurrence = 0 THEN
        v_problems := array_append(v_problems, 'Record at least one occurrence root cause (why the problem happened)');
      END IF;
      IF v_unverified > 0 THEN
        v_problems := array_append(v_problems, format('Verify the %s root %s not yet verified', v_unverified, CASE WHEN v_unverified = 1 THEN 'cause' ELSE 'causes' END));
      END IF;
    WHEN 'd5' THEN
      SELECT count(*) INTO v_occurrence FROM public.capa_root_causes WHERE capa_id = p_capa AND deleted_at IS NULL AND kind = 'occurrence';
      IF v_occurrence = 0 THEN
        v_problems := array_append(v_problems, 'Record an occurrence root cause in D4 first');
      END IF;
      FOR v_missing IN
        SELECT r.description FROM public.capa_root_causes r
         WHERE r.capa_id = p_capa AND r.deleted_at IS NULL AND r.kind = 'occurrence'
           AND NOT EXISTS (SELECT 1 FROM public.capa_actions a WHERE a.root_cause_id = r.id AND a.phase = 'corrective' AND a.status <> 'cancelled')
         ORDER BY r.created_at
      LOOP
        v_problems := array_append(v_problems, 'Add a corrective action for: ' || left(v_missing.description, 60) || CASE WHEN length(v_missing.description) > 60 THEN '…' ELSE '' END);
      END LOOP;
      SELECT count(*) INTO v_incomplete FROM public.capa_actions
       WHERE capa_id = p_capa AND phase = 'corrective' AND status <> 'cancelled' AND (owner_team_member_id IS NULL OR due_date IS NULL);
      IF v_incomplete > 0 THEN
        v_problems := array_append(v_problems, format('%s corrective %s an owner and a due date', v_incomplete, CASE WHEN v_incomplete = 1 THEN 'action needs' ELSE 'actions need' END));
      END IF;
    WHEN 'd6' THEN
      SELECT count(*) FILTER (WHERE status = 'open'), count(*) FILTER (WHERE status = 'done') INTO v_open, v_done
        FROM public.capa_actions WHERE capa_id = p_capa AND phase = 'corrective';
      IF v_open > 0 THEN
        v_problems := array_append(v_problems, format('Finish or cancel the %s open corrective %s', v_open, CASE WHEN v_open = 1 THEN 'action' ELSE 'actions' END));
      END IF;
      IF v_done = 0 THEN
        v_problems := array_append(v_problems, 'Carry out at least one corrective action');
      END IF;
      v_state := app.capa_verification_state(p_capa);
      IF v_state = 'none' THEN
        v_problems := array_append(v_problems, 'Verify that the corrective actions worked (needs someone who can verify)');
      ELSIF v_state = 'failed' THEN
        v_problems := array_append(v_problems, 'The last verification failed: put it right and verify again');
      ELSIF v_state = 'stale' THEN
        v_problems := array_append(v_problems, 'The corrective actions changed after the last verification: verify again');
      END IF;
    WHEN 'd7' THEN
      IF c.d7_lessons_learned IS NULL THEN v_problems := array_append(v_problems, 'Write the lessons learned'); END IF;
      SELECT count(*) FILTER (WHERE status = 'open'), count(*) FILTER (WHERE status = 'done') INTO v_open, v_done
        FROM public.capa_actions WHERE capa_id = p_capa AND phase = 'preventive';
      IF v_open > 0 THEN
        v_problems := array_append(v_problems, format('Finish or cancel the %s open preventive %s', v_open, CASE WHEN v_open = 1 THEN 'action' ELSE 'actions' END));
      END IF;
      IF v_done = 0 AND c.d7_no_preventive_reason IS NULL THEN
        v_problems := array_append(v_problems, 'Add a preventive action, or say why none is needed');
      END IF;
    WHEN 'd8' THEN
      IF c.stage NOT IN ('closed', 'cancelled') THEN
        FOR v_missing IN SELECT step FROM public.capa_steps WHERE capa_id = p_capa AND step <> 'd8' AND completed_at IS NULL ORDER BY step LOOP
          v_problems := array_append(v_problems, 'Complete ' || upper(v_missing.step) || ' first');
        END LOOP;
        IF c.stage <> 'verified_effective' THEN
          v_problems := array_append(v_problems, 'The corrective actions must be verified as effective before the 8D can be closed');
        END IF;
      END IF;
    ELSE
      v_problems := array_append(v_problems, 'This step is not available yet');
  END CASE;
  RETURN v_problems;
END $$;

-- D8 cannot be completed on its own: closing the 8D completes it.
CREATE OR REPLACE FUNCTION app.capa_complete_step(p_capa uuid, p_step text, p_note text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.capas%ROWTYPE; s public.capa_steps%ROWTYPE; v_problems text[];
BEGIN
  c := app.capa_for_update(p_capa, 'capa.manage');
  IF p_step = 'd8' THEN
    RAISE EXCEPTION 'Close the 8D to complete D8' USING ERRCODE = 'QM013';
  END IF;
  SELECT * INTO s FROM public.capa_steps WHERE capa_id = p_capa AND step = p_step;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown step' USING ERRCODE = 'QM013';
  END IF;
  IF s.completed_at IS NOT NULL THEN
    RAISE EXCEPTION '% is already complete', upper(p_step) USING ERRCODE = 'QM013';
  END IF;
  v_problems := app.capa_step_problems(p_capa, p_step);
  IF cardinality(v_problems) > 0 THEN
    RAISE EXCEPTION '% cannot be completed yet: %', upper(p_step), array_to_string(v_problems, '; ') USING ERRCODE = 'QM013';
  END IF;
  UPDATE public.capa_steps SET completed_at = now(), completed_by = auth.uid(), note = nullif(btrim(coalesce(p_note, '')), '') WHERE id = s.id;
  PERFORM app.capa_recompute_stage(p_capa);
END $$;

-- Closes the 8D (capa.verify): everything done, verified effective. Completes D8 and stamps who and when.
CREATE FUNCTION app.close_capa(p_id uuid, p_recognition text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.capas%ROWTYPE; v_problems text[];
BEGIN
  c := app.capa_for_update(p_id, 'capa.verify');
  v_problems := app.capa_step_problems(p_id, 'd8');
  IF cardinality(v_problems) > 0 THEN
    RAISE EXCEPTION 'The 8D cannot be closed yet: %', array_to_string(v_problems, '; ') USING ERRCODE = 'QM013';
  END IF;
  UPDATE public.capa_steps SET completed_at = now(), completed_by = auth.uid(), note = NULL WHERE capa_id = p_id AND step = 'd8';
  UPDATE public.capas SET stage = 'closed', stage_reason = NULL, closed_at = now(), closed_by = auth.uid(),
         d8_recognition = nullif(btrim(coalesce(p_recognition, '')), '') WHERE id = p_id;
  PERFORM app.emit_event(c.organisation_id, 'capa.closed', 'capa', p_id, jsonb_build_object('reference', c.reference));
END $$;

-- Reopening a closed 8D also marks D8 not done again (the recognition note is kept until the next closure).
CREATE OR REPLACE FUNCTION app.reopen_capa(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.capas%ROWTYPE;
BEGIN
  c := app.capa_for_update(p_id, 'capa.manage', true);
  IF c.stage NOT IN ('closed', 'cancelled') THEN
    RAISE EXCEPTION 'Only a closed or cancelled 8D can be reopened' USING ERRCODE = 'QM013';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'Say why the 8D is being reopened' USING ERRCODE = 'QM013';
  END IF;
  UPDATE public.capas SET stage = 'open', stage_reason = btrim(p_reason), closed_at = NULL, closed_by = NULL WHERE id = p_id;
  UPDATE public.capa_steps SET completed_at = NULL, completed_by = NULL, note = NULL, reopened_at = now(), reopened_by = auth.uid(),
         reopen_reason = 'The 8D was reopened: ' || btrim(p_reason)
   WHERE capa_id = p_id AND step = 'd8' AND completed_at IS NOT NULL;
  PERFORM app.capa_recompute_stage(p_id);
END $$;

-- ---------------------------------------------------------------------------
-- Evidence files
-- ---------------------------------------------------------------------------
CREATE TABLE public.capa_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  capa_id uuid NOT NULL,
  storage_path text NOT NULL,
  file_name text NOT NULL CHECK (length(btrim(file_name)) BETWEEN 1 AND 255),
  content_type text,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 26214400),
  description text CHECK (description IS NULL OR length(description) <= 500),
  deleted_at timestamptz,
  deleted_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  delete_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT capa_attachments_capa_fkey FOREIGN KEY (capa_id, organisation_id) REFERENCES public.capas (id, organisation_id) ON DELETE CASCADE,
  CONSTRAINT capa_attachments_key UNIQUE (capa_id, storage_path),
  CONSTRAINT capa_attachments_path CHECK (storage_path LIKE organisation_id::text || '/capa/%/%' AND storage_path NOT LIKE '%..%')
);
CREATE INDEX capa_attachments_capa_idx ON public.capa_attachments (capa_id);

CREATE FUNCTION app.capa_attachment_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['deleted_at', 'deleted_by', 'delete_reason', 'updated_at', 'updated_by'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['deleted_at', 'deleted_by', 'delete_reason', 'updated_at', 'updated_by']) THEN
    RAISE EXCEPTION 'An attachment cannot be changed, only removed or restored' USING ERRCODE = 'QM013';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION app.capa_attachment_no_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'Files of an 8D are never deleted' USING ERRCODE = 'QM013';
END $$;

CREATE TRIGGER capa_attachments_stamp BEFORE INSERT ON public.capa_attachments FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER capa_attachments_rules BEFORE UPDATE ON public.capa_attachments FOR EACH ROW EXECUTE FUNCTION app.capa_attachment_rules();
CREATE TRIGGER capa_attachments_touch BEFORE UPDATE ON public.capa_attachments FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER capa_attachments_org_immutable BEFORE UPDATE ON public.capa_attachments FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER capa_attachments_no_delete BEFORE DELETE ON public.capa_attachments FOR EACH ROW EXECUTE FUNCTION app.capa_attachment_no_delete();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.capa_attachments FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.capa_attachments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.capa_attachments FROM anon, authenticated;
GRANT SELECT ON public.capa_attachments TO authenticated;
CREATE POLICY capa_attachments_select ON public.capa_attachments FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.capas c WHERE c.id = capa_id));

-- Records a file already uploaded into the 8D's folder. Running 8Ds only (capa.manage).
CREATE FUNCTION app.add_capa_attachment(p_capa uuid, p_storage_path text, p_file_name text, p_content_type text,
                                        p_size_bytes bigint, p_description text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.capas%ROWTYPE; v_id uuid;
BEGIN
  c := app.capa_for_update(p_capa, 'capa.manage');
  IF p_storage_path NOT LIKE c.organisation_id::text || '/capa/' || c.id::text || '/%' THEN
    RAISE EXCEPTION 'The file must be stored in this 8D''s folder' USING ERRCODE = 'QM013';
  END IF;
  INSERT INTO public.capa_attachments (organisation_id, capa_id, storage_path, file_name, content_type, size_bytes, description)
  VALUES (c.organisation_id, c.id, p_storage_path, btrim(p_file_name), p_content_type, p_size_bytes, nullif(btrim(coalesce(p_description, '')), ''))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION app.remove_capa_attachment(p_attachment uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_capa uuid; v_removed timestamptz;
BEGIN
  SELECT capa_id, deleted_at INTO v_capa, v_removed FROM public.capa_attachments WHERE id = p_attachment;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Attachment not found' USING ERRCODE = 'QM013';
  END IF;
  PERFORM app.capa_for_update(v_capa, 'capa.manage');
  IF v_removed IS NOT NULL THEN
    RAISE EXCEPTION 'That file is already removed' USING ERRCODE = 'QM013';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'Say why the file is removed' USING ERRCODE = 'QM013';
  END IF;
  UPDATE public.capa_attachments SET deleted_at = now(), deleted_by = auth.uid(), delete_reason = btrim(p_reason) WHERE id = p_attachment;
END $$;

CREATE FUNCTION app.restore_capa_attachment(p_attachment uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_capa uuid; v_removed timestamptz;
BEGIN
  SELECT capa_id, deleted_at INTO v_capa, v_removed FROM public.capa_attachments WHERE id = p_attachment;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Attachment not found' USING ERRCODE = 'QM013';
  END IF;
  PERFORM app.capa_for_update(v_capa, 'capa.manage');
  IF v_removed IS NULL THEN
    RAISE EXCEPTION 'That file is not removed' USING ERRCODE = 'QM013';
  END IF;
  UPDATE public.capa_attachments SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL WHERE id = p_attachment;
END $$;

-- ---------------------------------------------------------------------------
-- Storage: <org>/capa/<capa id>/... Readable by anyone who can read the 8D; uploads only into a running 8D the caller manages; never updated or deleted.
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public) VALUES ('capa-files', 'capa-files', false)
ON CONFLICT (id) DO NOTHING;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'storage' AND table_name = 'buckets' AND column_name = 'file_size_limit') THEN
    EXECUTE $q$UPDATE storage.buckets SET file_size_limit = 26214400 WHERE id = 'capa-files'$q$;
  END IF;
END $$;

CREATE FUNCTION app.capa_file_allowed(p_object_name text, p_upload boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT split_part(p_object_name, '/', 2) = 'capa'
     AND EXISTS (
       SELECT 1 FROM public.capas c
       WHERE c.id = app.try_uuid(split_part(p_object_name, '/', 3))
         AND c.organisation_id = app.try_uuid(split_part(p_object_name, '/', 1))
         AND CASE WHEN p_upload
                  THEN c.stage NOT IN ('closed', 'cancelled') AND app.has_permission(c.organisation_id, 'capa.manage')
                  ELSE app.has_permission(c.organisation_id, 'capa.read') END)
$$;

CREATE POLICY capa_files_select ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'capa-files' AND app.capa_file_allowed(name, false));
CREATE POLICY capa_files_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'capa-files' AND app.capa_file_allowed(name, true));

REVOKE ALL ON FUNCTION app.capa_attachment_rules(), app.capa_attachment_no_delete(), app.close_capa(uuid, text), app.add_capa_attachment(uuid, text, text, text, bigint, text),
  app.remove_capa_attachment(uuid, text), app.restore_capa_attachment(uuid), app.capa_file_allowed(text, boolean), app.capa_step_problems(uuid, text),
  app.capa_complete_step(uuid, text, text), app.reopen_capa(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.close_capa(uuid, text), app.add_capa_attachment(uuid, text, text, text, bigint, text), app.remove_capa_attachment(uuid, text),
  app.restore_capa_attachment(uuid), app.capa_file_allowed(text, boolean), app.capa_step_problems(uuid, text), app.capa_complete_step(uuid, text, text), app.reopen_capa(uuid, text) TO authenticated;
