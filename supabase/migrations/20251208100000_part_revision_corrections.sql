-- Correcting a released part revision (docs/revision-correction-plan.md, RC1).
--
-- A released revision is frozen. When the drawing and the system disagree, the old fix was the next revision letter, which then no longer matched the drawing.
-- A CORRECTION keeps the letter and adds a version ("Rev B v2"): the wrong version stays on record, frozen, marked `corrected`; the corrected one is released
-- in its place. New inspections resolve to the one released row (so they use v2); existing inspections, NCs and plan resolutions keep pointing at the exact
-- row they used (v1), so what was measured against is never rewritten.
--
--  * app.start_part_revision_correction(revision, reason): master_data.manage; only the current released revision; a reason; one open correction at a time.
--    Creates a draft with the next version, values copied from the released one (the existing copy trigger), edited with the ordinary draft rules.
--  * app.release_part_revision_correction(revision): process_control.approve (owner, admin, quality manager; the preparer may approve). One transaction:
--    the old version becomes `corrected`, the draft becomes `released`. The ordinary release path refuses a correction (QM003).
--  * Event: a released correction emits part.revision.corrected (not part.revision.released).
-- Nothing here edits a released record, and nothing is deleted.

ALTER TABLE public.part_revisions
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  ADD COLUMN corrects_id uuid,
  ADD COLUMN correction_reason text CHECK (correction_reason IS NULL OR length(trim(correction_reason)) BETWEEN 1 AND 1000),
  ADD COLUMN corrected_at timestamptz,
  ADD COLUMN corrected_by uuid REFERENCES auth.users (id) ON DELETE SET NULL;

ALTER TABLE public.part_revisions
  ADD CONSTRAINT part_revisions_corrects_fkey FOREIGN KEY (corrects_id, organisation_id) REFERENCES public.part_revisions (id, organisation_id),
  ADD CONSTRAINT part_revisions_correction_shape CHECK ((version = 1) = (corrects_id IS NULL) AND (corrects_id IS NULL OR correction_reason IS NOT NULL)),
  ADD CONSTRAINT part_revisions_corrected_has_date CHECK ((status = 'corrected') = (corrected_at IS NOT NULL));

-- `corrected` joins the statuses.
DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'public.part_revisions'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%''superseded''%' AND pg_get_constraintdef(oid) LIKE '%status%';
  EXECUTE format('ALTER TABLE public.part_revisions DROP CONSTRAINT %I', c);
END $$;
ALTER TABLE public.part_revisions
  ADD CONSTRAINT part_revisions_status_check CHECK (status IN ('draft', 'released', 'superseded', 'obsolete', 'corrected'));

-- The letter is unique per version; one open correction per corrected version.
DROP INDEX public.part_revisions_part_revision_key;
CREATE UNIQUE INDEX part_revisions_part_revision_key ON public.part_revisions (part_id, upper(revision), version);
CREATE UNIQUE INDEX part_revisions_one_open_correction ON public.part_revisions (corrects_id) WHERE status = 'draft' AND corrects_id IS NOT NULL;
CREATE INDEX part_revisions_corrects_idx ON public.part_revisions (corrects_id) WHERE corrects_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Lifecycle: as before, plus corrections are only made and released through the two functions (they switch on app.revision_correction for their transaction).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.part_revision_lifecycle() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  allowed boolean;
  via_function boolean := coalesce(current_setting('app.revision_correction', true), '') = 'on';
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Signed-in users create drafts; data migrations (no JWT) may load history as it was.
    IF auth.role() = 'authenticated' THEN
      IF NEW.status <> 'draft' THEN
        RAISE EXCEPTION 'New revisions start as draft' USING ERRCODE = 'QM003';
      END IF;
      IF NOT via_function AND (NEW.version <> 1 OR NEW.corrects_id IS NOT NULL OR NEW.correction_reason IS NOT NULL) THEN
        RAISE EXCEPTION 'A correction is started from the released revision it corrects' USING ERRCODE = 'QM003';
      END IF;
      NEW.released_at := NULL;
      NEW.released_by := NULL;
      NEW.corrected_at := NULL;
      NEW.corrected_by := NULL;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.part_id <> OLD.part_id THEN
    RAISE EXCEPTION 'A revision cannot move to another part' USING ERRCODE = 'QM003';
  END IF;
  IF OLD.status <> 'draft' AND (NEW.revision, NEW.drawing_ref, NEW.change_summary)
       IS DISTINCT FROM (OLD.revision, OLD.drawing_ref, OLD.change_summary) THEN
    RAISE EXCEPTION 'Revision % is % and can no longer be edited', OLD.revision, OLD.status USING ERRCODE = 'QM003';
  END IF;
  IF (NEW.version, NEW.corrects_id, NEW.correction_reason) IS DISTINCT FROM (OLD.version, OLD.corrects_id, OLD.correction_reason) THEN
    RAISE EXCEPTION 'The version and the reason of a correction cannot change' USING ERRCODE = 'QM003';
  END IF;

  IF NEW.status <> OLD.status THEN
    allowed := (OLD.status, NEW.status) IN (('draft', 'released'), ('draft', 'obsolete'),
                                             ('released', 'superseded'), ('released', 'obsolete'),
                                             ('superseded', 'obsolete'), ('released', 'corrected'));
    IF NOT allowed THEN
      RAISE EXCEPTION 'A % revision cannot become %', OLD.status, NEW.status USING ERRCODE = 'QM003';
    END IF;
    IF NEW.status = 'corrected' THEN
      IF NOT via_function THEN
        RAISE EXCEPTION 'A revision is marked corrected by releasing its correction' USING ERRCODE = 'QM003';
      END IF;
      NEW.corrected_at := now();
      NEW.corrected_by := auth.uid();
    END IF;
    IF NEW.status = 'released' THEN
      IF NEW.corrects_id IS NOT NULL AND NOT via_function THEN
        RAISE EXCEPTION 'A correction is approved and released with the correction release, not as a new revision' USING ERRCODE = 'QM003';
      END IF;
      NEW.released_at := now();
      NEW.released_by := auth.uid();
      -- Supersede the current released revision first (one released revision per part). A correction's old version is already `corrected`.
      UPDATE public.part_revisions SET status = 'superseded'
      WHERE part_id = NEW.part_id AND status = 'released' AND id <> NEW.id;
    END IF;
  ELSIF NEW.released_at IS DISTINCT FROM OLD.released_at OR NEW.released_by IS DISTINCT FROM OLD.released_by
        OR NEW.corrected_at IS DISTINCT FROM OLD.corrected_at OR NEW.corrected_by IS DISTINCT FROM OLD.corrected_by THEN
    RAISE EXCEPTION 'Release and correction details are set by the system' USING ERRCODE = 'QM003';
  END IF;
  RETURN NEW;
END $$;

-- A released correction is announced as a correction, not as a new release.
CREATE OR REPLACE FUNCTION app.part_revision_events() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_number text;
BEGIN
  IF NEW.status = 'released' AND OLD.status = 'draft' THEN
    SELECT part_number INTO v_number FROM public.parts WHERE id = NEW.part_id;
    IF NEW.corrects_id IS NULL THEN
      PERFORM app.emit_event(NEW.organisation_id, 'part.revision.released', 'part_revision', NEW.id,
        jsonb_build_object('part_id', NEW.part_id, 'revision', NEW.revision, 'part_number', v_number));
    ELSE
      PERFORM app.emit_event(NEW.organisation_id, 'part.revision.corrected', 'part_revision', NEW.id,
        jsonb_build_object('part_id', NEW.part_id, 'revision', NEW.revision, 'version', NEW.version, 'corrects_id', NEW.corrects_id,
                           'reason', NEW.correction_reason, 'part_number', v_number));
    END IF;
  END IF;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Start a correction: a draft of the next version of the current released revision.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.start_part_revision_correction(p_revision_id uuid, p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  r public.part_revisions%ROWTYPE;
  v_reason text := trim(coalesce(p_reason, ''));
  v_next integer;
  v_id uuid;
BEGIN
  SELECT * INTO r FROM public.part_revisions WHERE id = p_revision_id;
  IF NOT FOUND OR NOT app.has_permission(r.organisation_id, 'master_data.manage') THEN
    RAISE EXCEPTION 'Part revision not found' USING ERRCODE = 'P0002';
  END IF;
  IF r.status <> 'released' THEN
    RAISE EXCEPTION 'Only the current released revision can be corrected; revision % is %', r.revision, r.status USING ERRCODE = 'QM003';
  END IF;
  IF v_reason = '' THEN
    RAISE EXCEPTION 'Give the reason for the correction' USING ERRCODE = 'QM003';
  END IF;
  IF length(v_reason) > 1000 THEN
    RAISE EXCEPTION 'The reason is at most 1000 characters' USING ERRCODE = 'QM003';
  END IF;
  IF EXISTS (SELECT 1 FROM public.part_revisions c WHERE c.corrects_id = r.id AND c.status = 'draft') THEN
    RAISE EXCEPTION 'Revision % already has a correction in progress', r.revision USING ERRCODE = 'QM003';
  END IF;
  SELECT max(version) + 1 INTO v_next FROM public.part_revisions WHERE part_id = r.part_id AND upper(revision) = upper(r.revision);
  PERFORM set_config('app.revision_correction', 'on', true);
  INSERT INTO public.part_revisions (organisation_id, part_id, revision, drawing_ref, change_summary, status, version, corrects_id, correction_reason)
  VALUES (r.organisation_id, r.part_id, r.revision, r.drawing_ref, r.change_summary, 'draft', v_next, r.id, v_reason)
  RETURNING id INTO v_id;
  PERFORM set_config('app.revision_correction', '', true);
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------
-- Approve and release a correction: the old version becomes `corrected`, the draft becomes `released`, together.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.release_part_revision_correction(p_revision_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  c public.part_revisions%ROWTYPE;
  o public.part_revisions%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.part_revisions WHERE id = p_revision_id;
  IF NOT FOUND OR NOT app.is_member(c.organisation_id) THEN
    RAISE EXCEPTION 'Part revision not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT app.has_permission(c.organisation_id, 'process_control.approve') THEN
    RAISE EXCEPTION 'Releasing a correction needs approval rights' USING ERRCODE = '42501';
  END IF;
  IF c.corrects_id IS NULL OR c.status <> 'draft' THEN
    RAISE EXCEPTION 'Only a correction in draft can be released this way' USING ERRCODE = 'QM003';
  END IF;
  SELECT * INTO o FROM public.part_revisions WHERE id = c.corrects_id FOR UPDATE;
  IF o.status <> 'released' THEN
    RAISE EXCEPTION 'Revision % v% is no longer the released version, so this correction cannot be released; discard it', o.revision, o.version
      USING ERRCODE = 'QM003';
  END IF;
  PERFORM set_config('app.revision_correction', 'on', true);
  UPDATE public.part_revisions SET status = 'corrected' WHERE id = o.id;
  UPDATE public.part_revisions SET status = 'released' WHERE id = c.id;
  PERFORM set_config('app.revision_correction', '', true);
END $$;

REVOKE ALL ON FUNCTION app.start_part_revision_correction(uuid, text), app.release_part_revision_correction(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.start_part_revision_correction(uuid, text), app.release_part_revision_correction(uuid) TO authenticated;
