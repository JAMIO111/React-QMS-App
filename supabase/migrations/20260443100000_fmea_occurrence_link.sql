-- FMEA FM5b: a failure mode of the analysis can be tied to a failure mode of the organisation's non-conformance register (the living FMEA, plan FM12).
-- The FMEA then shows how many live non-conformances were raised against it, and lists the ones whose failure mode the FMEA never foresaw. Information only:
-- nothing is re-rated and nothing is blocked. The counting is read by the API as the caller (row-level security decides which non-conformances they see).
--
-- Needs FM1 to FM3 first. Safe to run again: the column and index are guarded, the two function changes apply once.

-- ---------------------------------------------------------------------------
-- 1. The link
-- ---------------------------------------------------------------------------
ALTER TABLE public.fmea_failure_modes ADD COLUMN IF NOT EXISTS ncr_failure_mode_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fmea_failure_modes_nc_mode_fkey') THEN
    ALTER TABLE public.fmea_failure_modes ADD CONSTRAINT fmea_failure_modes_nc_mode_fkey
      FOREIGN KEY (ncr_failure_mode_id, organisation_id) REFERENCES public.ncr_classifications (id, organisation_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS fmea_failure_modes_nc_mode_idx ON public.fmea_failure_modes (organisation_id, ncr_failure_mode_id) WHERE ncr_failure_mode_id IS NOT NULL;

-- Counting non-conformances by failure mode over a period reads this: live ones only, so the index leaves out deleted rows.
CREATE INDEX IF NOT EXISTS nonconformances_failure_mode_idx ON public.nonconformances (organisation_id, failure_mode_id, detected_at DESC)
  WHERE failure_mode_id IS NOT NULL AND deleted_at IS NULL;

-- The kind is held for SQL too: only a failure mode of the register can be named (not a sub failure mode, a process or a category).
CREATE FUNCTION app.fmea_failure_mode_nc_rule() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.ncr_failure_mode_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.ncr_failure_mode_id IS DISTINCT FROM OLD.ncr_failure_mode_id) THEN
    IF NOT EXISTS (SELECT 1 FROM public.ncr_classifications c WHERE c.id = NEW.ncr_failure_mode_id AND c.organisation_id = NEW.organisation_id AND c.kind = 'failure_mode') THEN
      RAISE EXCEPTION 'Choose a failure mode from the non-conformance register' USING ERRCODE = 'QM036';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER fmea_failure_modes_nc_rule BEFORE INSERT OR UPDATE OF ncr_failure_mode_id ON public.fmea_failure_modes
  FOR EACH ROW EXECUTE FUNCTION app.fmea_failure_mode_nc_rule();

-- ---------------------------------------------------------------------------
-- 2. Saving a failure mode takes the link (key ncrFailureModeId: an id, or null to clear it)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.save_fmea_failure_mode(p_function uuid, p_id uuid, p_data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.fmea_revisions%ROWTYPE; x public.fmea_failure_modes%ROWTYPE; v_rev uuid; v_fn uuid; v_id uuid; v_text text; v_class text; v_next integer; v_nc uuid;
BEGIN
  IF p_id IS NOT NULL THEN SELECT revision_id, function_id INTO v_rev, v_fn FROM public.fmea_failure_modes WHERE id = p_id;
  ELSE SELECT revision_id, id INTO v_rev, v_fn FROM public.fmea_functions WHERE id = p_function; END IF;
  IF v_rev IS NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
  r := app.fmea_draft_for_update(v_rev);
  PERFORM app.fmea_keys(p_data, ARRAY['text', 'specialClass', 'ncrFailureModeId', 'position']);
  IF p_id IS NOT NULL THEN SELECT * INTO x FROM public.fmea_failure_modes WHERE id = p_id FOR UPDATE; END IF;
  v_text := CASE WHEN p_data ? 'text' THEN btrim(coalesce(p_data ->> 'text', '')) ELSE x.text END;
  IF v_text IS NULL OR length(v_text) = 0 THEN RAISE EXCEPTION 'Say how it fails' USING ERRCODE = 'QM036'; END IF;
  IF length(v_text) > 500 THEN RAISE EXCEPTION 'The failure mode is up to 500 characters' USING ERRCODE = 'QM036'; END IF;
  v_class := CASE WHEN p_data ? 'specialClass' THEN nullif(btrim(coalesce(p_data ->> 'specialClass', '')), '') ELSE x.special_class END;
  IF v_class IS NOT NULL AND v_class NOT IN ('critical', 'significant') THEN RAISE EXCEPTION 'A special characteristic is critical or significant' USING ERRCODE = 'QM036'; END IF;
  v_nc := CASE WHEN p_data ? 'ncrFailureModeId' THEN nullif(btrim(coalesce(p_data ->> 'ncrFailureModeId', '')), '')::uuid ELSE x.ncr_failure_mode_id END;
  -- A failure mode of the register that has been switched off since stays where it is, but cannot be newly chosen.
  IF v_nc IS NOT NULL AND v_nc IS DISTINCT FROM x.ncr_failure_mode_id THEN
    IF NOT EXISTS (SELECT 1 FROM public.ncr_classifications c WHERE c.id = v_nc AND c.organisation_id = r.organisation_id AND c.kind = 'failure_mode') THEN
      RAISE EXCEPTION 'Choose a failure mode from the non-conformance register' USING ERRCODE = 'QM036';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.ncr_classifications c WHERE c.id = v_nc AND c.active) THEN
      RAISE EXCEPTION 'That failure mode is switched off in the non-conformance register' USING ERRCODE = 'QM036';
    END IF;
  END IF;
  IF p_id IS NULL THEN
    SELECT coalesce(max(position), 0) + 1 INTO v_next FROM public.fmea_failure_modes WHERE function_id = v_fn;
    INSERT INTO public.fmea_failure_modes (organisation_id, revision_id, function_id, text, special_class, ncr_failure_mode_id, position)
    VALUES (r.organisation_id, r.id, v_fn, v_text, v_class, v_nc, app.fmea_position(p_data ->> 'position', v_next)) RETURNING id INTO v_id;
  ELSE
    UPDATE public.fmea_failure_modes SET text = v_text, special_class = v_class, ncr_failure_mode_id = v_nc,
      position = CASE WHEN p_data ? 'position' THEN app.fmea_position(p_data ->> 'position', position) ELSE position END WHERE id = x.id;
    v_id := x.id;
  END IF;
  UPDATE public.fmea_revisions SET updated_at = now() WHERE id = r.id;
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------
-- 3. A new revision, and an FMEA started from a base, keep the link (the failure modes of the register belong to the organisation, not to a part)
-- ---------------------------------------------------------------------------
CREATE FUNCTION pg_temp.patch_once(p_fn regprocedure, p_marker text, p_old text, p_new text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_def text := replace(pg_get_functiondef(p_fn), E'\r', ''); v_n integer;
BEGIN
  -- The SQL editor may save the pasted text with Windows line endings: take them out of what we look for and what we put in, as well as out of the live function.
  p_old := replace(p_old, E'\r', '');
  p_new := replace(p_new, E'\r', '');
  IF position(p_marker IN v_def) > 0 THEN RETURN; END IF;
  v_n := (length(v_def) - length(replace(v_def, p_old, ''))) / length(p_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'Expected to find % exactly once in %, found % times', p_old, p_fn, v_n; END IF;
  EXECUTE replace(v_def, p_old, p_new);
END $$;

SELECT pg_temp.patch_once('app.fmea_copy_net(uuid, uuid, text)'::regprocedure, 'ncr_failure_mode_id',
  $old$  INSERT INTO public.fmea_failure_modes (organisation_id, revision_id, function_id, text, special_class, position, prev_row_id, base_row_id)
  SELECT o.organisation_id, p_to, n.id, o.text, o.special_class, o.position,$old$,
  $new$  INSERT INTO public.fmea_failure_modes (organisation_id, revision_id, function_id, text, special_class, ncr_failure_mode_id, position, prev_row_id, base_row_id)
  SELECT o.organisation_id, p_to, n.id, o.text, o.special_class, o.ncr_failure_mode_id, o.position,$new$);

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app.fmea_failure_mode_nc_rule() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.save_fmea_failure_mode(uuid, uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.save_fmea_failure_mode(uuid, uuid, jsonb) TO authenticated;
