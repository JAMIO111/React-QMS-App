-- Document control slice DC2 (docs/document-control-plan.md DC2, DC8, DC9, DC15, §3, §6): review and approval, the effective date, supersession,
-- withdrawing, new revisions, and notices to reviewers and the approver.
--
--  * A draft names one or more reviewers (`document_revision_reviewers`) and one approver (`document_revisions.approver_id`), none of them the author;
--    a reviewer may also be the approver (DC15). Replaced as a whole by `app.set_document_signers`, only while it is a draft.
--  * `app.submit_document_revision`: the "still needed" list must be empty (`app.document_revision_problems`). The revision gets its letter the first
--    time it is submitted (after the document's last letter, or the letter typed when it was brought across), and a new review round starts:
--    a pending sign-off per reviewer (`document_signoffs`, round N).
--  * `app.review_document_revision(revision, accept, comment)`: a pending reviewer of the current round. Sending back needs a comment, returns the
--    revision to draft (its other pending sign-offs are closed) and the next submission starts every review again. When every reviewer has
--    accepted it awaits approval and the approver gets a pending sign-off.
--  * `app.approve_document_revision(revision, effective_from, comment)`: the named approver, holding documentation.issue, never the author;
--    effective today or later. `app.send_back_document_revision(revision, comment)`: the approver returns it to draft.
--  * Becoming effective needs no worker (§6): `app.settle_documents(org)` is run by the API when documents are read, and the daily cron runs
--    `app.system_settle_documents()`. An approved revision whose date has come becomes effective, the one in force before it is superseded at the
--    same moment, and the document is active with that revision current. Idempotent.
--  * `app.withdraw_document(document, reason)` (documentation.issue): the revision in force and any approved one waiting are withdrawn; a draft in
--    progress is left alone. A withdrawn document is revised back into use the normal way.
--  * `app.start_document_revision(document)` (documentation.manage): a new draft copying the text, change summary empty, and the live files of the
--    revision in force (or the last one), pointing at the same stored files.
--  * Statuses move only along §3 (trigger, SQL too); approved, effective, superseded and withdrawn revisions are frozen, and so are sign-offs once decided.
--  * Notices (in-app, `own_record`, addressed to one person): "A document is waiting for your review" / "… for your approval" when a sign-off is
--    created for someone; the person who caused it is never told.
-- Errors QM025 (409 document_rule); another organisation's id P0002 (404).

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.document_revisions
  ADD COLUMN approver_id uuid REFERENCES auth.users (id),
  ADD COLUMN review_round integer NOT NULL DEFAULT 0 CHECK (review_round >= 0),
  ADD COLUMN previous_revision_id uuid,
  ADD COLUMN submitted_at timestamptz,
  ADD COLUMN submitted_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  ADD COLUMN approved_at timestamptz,
  ADD COLUMN approved_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  ADD COLUMN effective_from date,
  ADD COLUMN effective_at timestamptz,
  ADD COLUMN superseded_at timestamptz,
  ADD COLUMN superseded_by_id uuid,
  ADD COLUMN withdrawn_at timestamptz,
  ADD COLUMN withdrawn_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  ADD COLUMN withdraw_reason text CHECK (withdraw_reason IS NULL OR length(btrim(withdraw_reason)) BETWEEN 3 AND 500),
  ADD CONSTRAINT document_revisions_previous_fkey FOREIGN KEY (previous_revision_id, organisation_id) REFERENCES public.document_revisions (id, organisation_id),
  ADD CONSTRAINT document_revisions_superseded_by_fkey FOREIGN KEY (superseded_by_id, organisation_id) REFERENCES public.document_revisions (id, organisation_id),
  ADD CONSTRAINT document_revisions_approved_state_check CHECK (
    status NOT IN ('approved', 'effective', 'superseded') OR (approved_at IS NOT NULL AND effective_from IS NOT NULL)),
  ADD CONSTRAINT document_revisions_withdrawn_state_check CHECK ((status = 'withdrawn') = (withdraw_reason IS NOT NULL));
CREATE INDEX document_revisions_due_idx ON public.document_revisions (organisation_id, effective_from) WHERE status = 'approved';

ALTER TABLE public.documents
  ADD COLUMN current_revision_id uuid,
  ADD COLUMN withdrawn_at timestamptz,
  ADD COLUMN withdrawn_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  ADD COLUMN withdraw_reason text CHECK (withdraw_reason IS NULL OR length(btrim(withdraw_reason)) BETWEEN 3 AND 500),
  ADD CONSTRAINT documents_current_revision_fkey FOREIGN KEY (current_revision_id, organisation_id) REFERENCES public.document_revisions (id, organisation_id),
  ADD CONSTRAINT documents_withdrawn_state_check CHECK ((status = 'withdrawn') = (withdraw_reason IS NOT NULL));

-- ---------------------------------------------------------------------------
-- Reviewers named on a draft, and the sign-offs of each review round
-- ---------------------------------------------------------------------------
CREATE TABLE public.document_revision_reviewers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  revision_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT document_revision_reviewers_pair_key UNIQUE (revision_id, user_id),
  CONSTRAINT document_revision_reviewers_revision_fkey FOREIGN KEY (revision_id, organisation_id) REFERENCES public.document_revisions (id, organisation_id)
);
CREATE INDEX document_revision_reviewers_user_idx ON public.document_revision_reviewers (user_id);

CREATE TABLE public.document_signoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  revision_id uuid NOT NULL,
  round integer NOT NULL CHECK (round >= 1),
  role text NOT NULL CHECK (role IN ('reviewer', 'approver')),
  user_id uuid NOT NULL REFERENCES auth.users (id),
  decision text NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending', 'accepted', 'returned', 'approved', 'closed')),
  comment text CHECK (comment IS NULL OR length(btrim(comment)) BETWEEN 1 AND 2000),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT document_signoffs_once_key UNIQUE (revision_id, round, role, user_id),
  CONSTRAINT document_signoffs_revision_fkey FOREIGN KEY (revision_id, organisation_id) REFERENCES public.document_revisions (id, organisation_id),
  CONSTRAINT document_signoffs_role_decision_check CHECK (
    (role = 'reviewer' AND decision IN ('pending', 'accepted', 'returned', 'closed')) OR (role = 'approver' AND decision IN ('pending', 'approved', 'returned', 'closed'))),
  CONSTRAINT document_signoffs_decided_check CHECK ((decision = 'pending') = (decided_at IS NULL)),
  CONSTRAINT document_signoffs_returned_check CHECK (decision <> 'returned' OR comment IS NOT NULL)
);
CREATE INDEX document_signoffs_waiting_idx ON public.document_signoffs (organisation_id, user_id) WHERE decision = 'pending';

-- ---------------------------------------------------------------------------
-- Rules held by triggers
-- ---------------------------------------------------------------------------
-- Replaces the DC1 version: also holds the status moves of §3 and freezes everything about a revision once approved.
CREATE OR REPLACE FUNCTION app.document_revision_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A revision is never deleted. Discard a draft with a reason.' USING ERRCODE = 'QM025'; END IF;
  IF (NEW.document_id, NEW.sequence, NEW.author_id) IS DISTINCT FROM (OLD.document_id, OLD.sequence, OLD.author_id) THEN
    RAISE EXCEPTION 'A revision''s document, sequence and author never change' USING ERRCODE = 'QM025';
  END IF;
  IF OLD.letter IS NOT NULL AND NEW.letter IS DISTINCT FROM OLD.letter THEN RAISE EXCEPTION 'A revision letter never changes' USING ERRCODE = 'QM025'; END IF;
  IF OLD.status <> 'draft' AND (NEW.change_summary, NEW.body, NEW.body_text, NEW.approver_id, NEW.previous_revision_id)
     IS DISTINCT FROM (OLD.change_summary, OLD.body, OLD.body_text, OLD.approver_id, OLD.previous_revision_id) THEN
    RAISE EXCEPTION 'Only a draft''s content can change' USING ERRCODE = 'QM025';
  END IF;
  IF OLD.status IN ('discarded', 'superseded', 'withdrawn') THEN RAISE EXCEPTION 'A % revision cannot be changed', OLD.status USING ERRCODE = 'QM025'; END IF;
  IF OLD.status IN ('approved', 'effective') AND (NEW.effective_from, NEW.approved_at, NEW.approved_by) IS DISTINCT FROM (OLD.effective_from, OLD.approved_at, OLD.approved_by) THEN
    RAISE EXCEPTION 'An approved revision is frozen' USING ERRCODE = 'QM025';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status IN ('in_review', 'discarded'))
    OR (OLD.status = 'in_review' AND NEW.status IN ('draft', 'awaiting_approval'))
    OR (OLD.status = 'awaiting_approval' AND NEW.status IN ('draft', 'approved'))
    OR (OLD.status = 'approved' AND NEW.status IN ('effective', 'withdrawn'))
    OR (OLD.status = 'effective' AND NEW.status IN ('superseded', 'withdrawn'))) THEN
    RAISE EXCEPTION 'A revision cannot move from % to %', replace(OLD.status, '_', ' '), replace(NEW.status, '_', ' ') USING ERRCODE = 'QM025';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION app.document_reviewer_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_status text;
BEGIN
  SELECT status INTO v_status FROM public.document_revisions WHERE id = coalesce(NEW.revision_id, OLD.revision_id);
  IF v_status IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'Reviewers change only while the revision is a draft' USING ERRCODE = 'QM025'; END IF;
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'Replace the reviewers instead of changing one' USING ERRCODE = 'QM025'; END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER document_revision_reviewers_rules BEFORE INSERT OR UPDATE OR DELETE ON public.document_revision_reviewers FOR EACH ROW EXECUTE FUNCTION app.document_reviewer_rules();

CREATE FUNCTION app.document_signoff_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A sign-off is never deleted' USING ERRCODE = 'QM025'; END IF;
  IF OLD.decision <> 'pending' THEN RAISE EXCEPTION 'A sign-off is frozen once decided' USING ERRCODE = 'QM025'; END IF;
  IF (to_jsonb(NEW) - ARRAY['decision', 'comment', 'decided_at', 'updated_at', 'updated_by']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['decision', 'comment', 'decided_at', 'updated_at', 'updated_by']) THEN
    RAISE EXCEPTION 'Only the decision of a sign-off is recorded' USING ERRCODE = 'QM025';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_signoffs_rules BEFORE UPDATE OR DELETE ON public.document_signoffs FOR EACH ROW EXECUTE FUNCTION app.document_signoff_rules();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['document_revision_reviewers', 'document_signoffs'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION app.stamp_created()', t || '_stamp', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.touch_updated()', t || '_touch', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change()', t || '_org_immutable', t);
    EXECUTE format('CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION audit.record_change(''organisation_id'')', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Reading: reviewers and the approver read the revision (and its document) they are named on
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.document_signer_of(p_revision uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.document_revisions r WHERE r.id = p_revision AND r.approver_id = auth.uid())
      OR EXISTS (SELECT 1 FROM public.document_revision_reviewers v WHERE v.revision_id = p_revision AND v.user_id = auth.uid())
      OR EXISTS (SELECT 1 FROM public.document_signoffs s WHERE s.revision_id = p_revision AND s.user_id = auth.uid())
$$;

CREATE OR REPLACE FUNCTION app.document_revision_readable(p_revision uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.document_revisions r JOIN public.documents d ON d.id = r.document_id
     WHERE r.id = p_revision AND app.is_member(r.organisation_id)
       AND (app.has_permission(r.organisation_id, 'documentation.manage')
            OR r.author_id = auth.uid() OR d.owner_user_id = auth.uid() OR app.document_signer_of(r.id)
            OR (r.status IN ('approved', 'effective', 'superseded', 'withdrawn') AND app.has_permission(r.organisation_id, 'documentation.read'))))
$$;
CREATE OR REPLACE FUNCTION app.document_readable(p_document uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.documents d
     WHERE d.id = p_document AND app.is_member(d.organisation_id)
       AND (app.has_permission(d.organisation_id, 'documentation.manage') OR d.owner_user_id = auth.uid()
            OR (d.status IN ('active', 'withdrawn') AND app.has_permission(d.organisation_id, 'documentation.read'))
            OR EXISTS (SELECT 1 FROM public.document_revisions r WHERE r.document_id = d.id AND (r.author_id = auth.uid() OR app.document_signer_of(r.id)))))
$$;

ALTER TABLE public.document_revision_reviewers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_signoffs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.document_revision_reviewers, public.document_signoffs FROM anon, authenticated;
GRANT SELECT ON public.document_revision_reviewers, public.document_signoffs TO authenticated;
CREATE POLICY document_revision_reviewers_select ON public.document_revision_reviewers FOR SELECT TO authenticated USING (app.document_revision_readable(revision_id));
CREATE POLICY document_signoffs_select ON public.document_signoffs FOR SELECT TO authenticated USING (app.document_revision_readable(revision_id));

-- ---------------------------------------------------------------------------
-- What a draft still needs before it can be submitted (also shown by the API)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.document_revision_problems(p_revision uuid) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.document_revisions%ROWTYPE; d public.documents%ROWTYPE; v text[] := ARRAY[]::text[]; v_reviewers integer;
BEGIN
  SELECT * INTO r FROM public.document_revisions WHERE id = p_revision;
  IF NOT FOUND OR r.status <> 'draft' THEN RETURN v; END IF;
  SELECT * INTO d FROM public.documents WHERE id = r.document_id;
  IF d.content_kind = 'text' AND r.body_text IS NULL THEN v := v || 'Write the document''s text'::text; END IF;
  IF d.content_kind = 'file' AND NOT EXISTS (SELECT 1 FROM public.document_revision_files f WHERE f.revision_id = r.id AND f.role = 'main' AND f.deleted_at IS NULL) THEN
    v := v || 'Upload the main file'::text;
  END IF;
  IF d.status IN ('active', 'withdrawn') AND r.change_summary IS NULL THEN v := v || 'Say what changed and why'::text; END IF;
  SELECT count(*) INTO v_reviewers FROM public.document_revision_reviewers WHERE revision_id = r.id;
  IF v_reviewers = 0 THEN v := v || 'Name at least one reviewer'::text; END IF;
  IF r.approver_id IS NULL THEN v := v || 'Name the approver'::text; END IF;
  IF r.approver_id IS NOT NULL AND NOT app.is_active_member_user(r.organisation_id, r.approver_id) THEN v := v || 'The approver is no longer an active member'::text; END IF;
  IF EXISTS (SELECT 1 FROM public.document_revision_reviewers x WHERE x.revision_id = r.id AND NOT app.is_active_member_user(r.organisation_id, x.user_id)) THEN
    v := v || 'A reviewer is no longer an active member'::text;
  END IF;
  RETURN v;
END $$;

-- Who may be named: active members; `can_approve` = holds documentation.issue through an organisation-wide or site role (the check that counts is made
-- again, as the approver, when they approve).
CREATE FUNCTION app.document_signer_candidates(p_organisation_id uuid) RETURNS TABLE (user_id uuid, name text, can_approve boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT ou.user_id, coalesce(nullif(btrim(concat_ws(' ', p.first_name, p.surname)), ''), 'Unnamed'),
         EXISTS (SELECT 1 FROM public.user_role_assignments a JOIN public.role_permissions rp ON rp.role_id = a.role_id
                  WHERE a.membership_id = ou.id AND rp.permission_code = 'documentation.issue')
    FROM public.organisation_users ou LEFT JOIN public.profiles p ON p.id = ou.user_id
   WHERE ou.organisation_id = p_organisation_id AND ou.status = 'active' AND app.has_permission(p_organisation_id, 'documentation.manage')
   ORDER BY 2
$$;

-- ---------------------------------------------------------------------------
-- The draft's reviewers and approver
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.set_document_signers(p_revision uuid, p_reviewers uuid[], p_approver uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.document_revisions; v_ids uuid[] := ARRAY(SELECT DISTINCT unnest(coalesce(p_reviewers, ARRAY[]::uuid[])));
BEGIN
  r := app.document_draft_for_update(p_revision);
  IF cardinality(v_ids) > 20 THEN RAISE EXCEPTION 'At most 20 reviewers' USING ERRCODE = 'QM025'; END IF;
  IF r.author_id = ANY (v_ids) THEN RAISE EXCEPTION 'The author cannot review their own revision' USING ERRCODE = 'QM025'; END IF;
  IF p_approver IS NOT NULL AND p_approver = r.author_id THEN RAISE EXCEPTION 'The author cannot approve their own revision' USING ERRCODE = 'QM025'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(v_ids) u WHERE NOT app.is_active_member_user(r.organisation_id, u))
     OR (p_approver IS NOT NULL AND NOT app.is_active_member_user(r.organisation_id, p_approver)) THEN
    RAISE EXCEPTION 'Reviewers and the approver must be active members of this organisation' USING ERRCODE = 'QM025';
  END IF;
  DELETE FROM public.document_revision_reviewers WHERE revision_id = r.id;
  INSERT INTO public.document_revision_reviewers (organisation_id, revision_id, user_id) SELECT r.organisation_id, r.id, unnest(v_ids);
  UPDATE public.document_revisions SET approver_id = p_approver WHERE id = r.id;
END $$;

-- ---------------------------------------------------------------------------
-- Submitting, reviewing, approving
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.submit_document_revision(p_revision uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.document_revisions; d public.documents%ROWTYPE; v_problems text[]; v_letter text; v_round integer;
BEGIN
  r := app.document_draft_for_update(p_revision);
  v_problems := app.document_revision_problems(r.id);
  IF cardinality(v_problems) > 0 THEN RAISE EXCEPTION 'Still needed: %', array_to_string(v_problems, '; ') USING ERRCODE = 'QM025'; END IF;
  SELECT * INTO d FROM public.documents WHERE id = r.document_id FOR UPDATE;
  v_letter := r.letter;
  IF v_letter IS NULL THEN
    v_letter := CASE WHEN d.last_letter IS NULL THEN d.start_letter ELSE app.document_letter_after(d.last_letter) END;
    UPDATE public.documents SET last_letter = v_letter WHERE id = d.id;
  END IF;
  v_round := r.review_round + 1;
  UPDATE public.document_revisions SET status = 'in_review', letter = v_letter, review_round = v_round, submitted_at = now(), submitted_by = auth.uid() WHERE id = r.id;
  INSERT INTO public.document_signoffs (organisation_id, revision_id, round, role, user_id)
  SELECT r.organisation_id, r.id, v_round, 'reviewer', v.user_id FROM public.document_revision_reviewers v WHERE v.revision_id = r.id;
END $$;

-- Loads and locks a revision for its reviewer or approver: the caller must hold a pending sign-off of that role in the current round.
CREATE FUNCTION app.document_signoff_for(p_revision uuid, p_role text) RETURNS public.document_signoffs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.document_revisions%ROWTYPE; s public.document_signoffs%ROWTYPE;
  v_wanted text := CASE p_role WHEN 'reviewer' THEN 'in_review' ELSE 'awaiting_approval' END;
  v_what text := CASE p_role WHEN 'reviewer' THEN 'review' ELSE 'approval' END;
BEGIN
  SELECT * INTO r FROM public.document_revisions WHERE id = p_revision FOR UPDATE;
  IF NOT FOUND OR NOT app.document_revision_readable(r.id) THEN RAISE EXCEPTION 'Revision not found' USING ERRCODE = 'P0002'; END IF;
  IF r.status <> v_wanted THEN
    RAISE EXCEPTION 'This revision is % and is not waiting for %', replace(r.status, '_', ' '), v_what USING ERRCODE = 'QM025';
  END IF;
  SELECT * INTO s FROM public.document_signoffs
   WHERE revision_id = r.id AND round = r.review_round AND role = p_role AND user_id = auth.uid() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'You are not the % of this revision', p_role USING ERRCODE = '42501'; END IF;
  IF s.decision <> 'pending' THEN RAISE EXCEPTION 'You have already decided (%)', s.decision USING ERRCODE = 'QM025'; END IF;
  RETURN s;
END $$;

-- Back to draft: every pending sign-off of the round is closed; the next submission starts every review again.
CREATE FUNCTION app.document_return_to_draft(p_revision uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  UPDATE public.document_signoffs SET decision = 'closed', decided_at = now() WHERE revision_id = p_revision AND decision = 'pending';
  UPDATE public.document_revisions SET status = 'draft' WHERE id = p_revision;
$$;

CREATE FUNCTION app.review_document_revision(p_revision uuid, p_accept boolean, p_comment text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.document_signoffs; r public.document_revisions%ROWTYPE; v_comment text := nullif(btrim(coalesce(p_comment, '')), '');
BEGIN
  s := app.document_signoff_for(p_revision, 'reviewer');
  IF p_accept IS NULL THEN RAISE EXCEPTION 'Accept it or send it back' USING ERRCODE = 'QM025'; END IF;
  IF NOT p_accept AND (v_comment IS NULL OR length(v_comment) < 3) THEN RAISE EXCEPTION 'Say what needs changing (a comment of at least 3 characters)' USING ERRCODE = 'QM025'; END IF;
  UPDATE public.document_signoffs SET decision = CASE WHEN p_accept THEN 'accepted' ELSE 'returned' END, comment = left(v_comment, 2000), decided_at = now() WHERE id = s.id;
  SELECT * INTO r FROM public.document_revisions WHERE id = p_revision;
  IF NOT p_accept THEN
    PERFORM app.document_return_to_draft(r.id);
  ELSIF NOT EXISTS (SELECT 1 FROM public.document_signoffs WHERE revision_id = r.id AND round = r.review_round AND role = 'reviewer' AND decision <> 'accepted') THEN
    UPDATE public.document_revisions SET status = 'awaiting_approval' WHERE id = r.id;
    INSERT INTO public.document_signoffs (organisation_id, revision_id, round, role, user_id) VALUES (r.organisation_id, r.id, r.review_round, 'approver', r.approver_id);
  END IF;
END $$;

CREATE FUNCTION app.approve_document_revision(p_revision uuid, p_effective_from date, p_comment text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.document_signoffs; r public.document_revisions%ROWTYPE;
BEGIN
  s := app.document_signoff_for(p_revision, 'approver');
  SELECT * INTO r FROM public.document_revisions WHERE id = p_revision;
  IF r.author_id = auth.uid() THEN RAISE EXCEPTION 'The author cannot approve their own revision' USING ERRCODE = 'QM025'; END IF;
  IF NOT app.has_permission(r.organisation_id, 'documentation.issue') THEN RAISE EXCEPTION 'Approving documents needs the documentation issue permission' USING ERRCODE = '42501'; END IF;
  IF p_effective_from IS NULL THEN RAISE EXCEPTION 'Say when it takes effect' USING ERRCODE = 'QM025'; END IF;
  IF p_effective_from < current_date THEN RAISE EXCEPTION 'It cannot take effect before today' USING ERRCODE = 'QM025'; END IF;
  UPDATE public.document_signoffs SET decision = 'approved', comment = left(nullif(btrim(coalesce(p_comment, '')), ''), 2000), decided_at = now() WHERE id = s.id;
  UPDATE public.document_revisions SET status = 'approved', approved_at = now(), approved_by = auth.uid(), effective_from = p_effective_from WHERE id = r.id;
  PERFORM app.settle_document(r.document_id);
END $$;

CREATE FUNCTION app.send_back_document_revision(p_revision uuid, p_comment text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.document_signoffs; v_comment text := nullif(btrim(coalesce(p_comment, '')), '');
BEGIN
  s := app.document_signoff_for(p_revision, 'approver');
  IF v_comment IS NULL OR length(v_comment) < 3 THEN RAISE EXCEPTION 'Say what needs changing (a comment of at least 3 characters)' USING ERRCODE = 'QM025'; END IF;
  UPDATE public.document_signoffs SET decision = 'returned', comment = left(v_comment, 2000), decided_at = now() WHERE id = s.id;
  PERFORM app.document_return_to_draft(p_revision);
END $$;

-- ---------------------------------------------------------------------------
-- Becoming effective (no worker): idempotent, run on read and by the daily cron
-- ---------------------------------------------------------------------------
-- One document: every approved revision whose date has come takes effect in date order; the one in force before it is superseded.
CREATE FUNCTION app.settle_document(p_document uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r record; v_prev uuid; v_n integer := 0;
BEGIN
  FOR r IN SELECT id, organisation_id FROM public.document_revisions
            WHERE document_id = p_document AND status = 'approved' AND effective_from <= current_date
            ORDER BY effective_from, approved_at FOR UPDATE
  LOOP
    SELECT id INTO v_prev FROM public.document_revisions WHERE document_id = p_document AND status = 'effective' FOR UPDATE;
    IF v_prev IS NOT NULL THEN
      UPDATE public.document_revisions SET status = 'superseded', superseded_at = now(), superseded_by_id = r.id WHERE id = v_prev;
    END IF;
    UPDATE public.document_revisions SET status = 'effective', effective_at = now() WHERE id = r.id;
    UPDATE public.documents SET status = 'active', current_revision_id = r.id, withdrawn_at = NULL, withdrawn_by = NULL, withdraw_reason = NULL WHERE id = p_document;
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $$;

CREATE FUNCTION app.settle_documents(p_organisation_id uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_doc uuid; v_n integer := 0;
BEGIN
  IF NOT app.is_member(p_organisation_id) THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
  FOR v_doc IN SELECT DISTINCT document_id FROM public.document_revisions WHERE organisation_id = p_organisation_id AND status = 'approved' AND effective_from <= current_date LOOP
    v_n := v_n + app.settle_document(v_doc);
  END LOOP;
  RETURN v_n;
END $$;

-- The daily cron (API login only), for organisations nobody opened today.
CREATE FUNCTION app.system_settle_documents() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_doc uuid; v_n integer := 0;
BEGIN
  FOR v_doc IN SELECT DISTINCT document_id FROM public.document_revisions WHERE status = 'approved' AND effective_from <= current_date LOOP
    v_n := v_n + app.settle_document(v_doc);
  END LOOP;
  RETURN v_n;
END $$;

-- ---------------------------------------------------------------------------
-- Withdrawing a document, and starting a new revision
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.withdraw_document(p_document uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE d public.documents%ROWTYPE; v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  SELECT * INTO d FROM public.documents WHERE id = p_document FOR UPDATE;
  IF NOT FOUND OR NOT app.document_readable(d.id) THEN RAISE EXCEPTION 'Document not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(d.organisation_id, 'documentation.issue') THEN RAISE EXCEPTION 'Withdrawing documents needs the documentation issue permission' USING ERRCODE = '42501'; END IF;
  PERFORM app.settle_document(d.id);
  SELECT * INTO d FROM public.documents WHERE id = p_document;
  IF d.status <> 'active' THEN RAISE EXCEPTION 'Only a document in force can be withdrawn (% is %)', d.number, d.status USING ERRCODE = 'QM025'; END IF;
  IF length(v_reason) < 3 THEN RAISE EXCEPTION 'Say why it is withdrawn (at least 3 characters)' USING ERRCODE = 'QM025'; END IF;
  UPDATE public.document_revisions SET status = 'withdrawn', withdrawn_at = now(), withdrawn_by = auth.uid(), withdraw_reason = left(v_reason, 500)
   WHERE document_id = d.id AND status IN ('effective', 'approved');
  UPDATE public.documents SET status = 'withdrawn', withdrawn_at = now(), withdrawn_by = auth.uid(), withdraw_reason = left(v_reason, 500) WHERE id = d.id;
END $$;

-- A new draft from the revision in force (or the last one issued): the text and the live files are copied; the change summary starts empty.
CREATE FUNCTION app.start_document_revision(p_document uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE d public.documents%ROWTYPE; v_from public.document_revisions%ROWTYPE; v_id uuid; v_seq integer;
BEGIN
  SELECT * INTO d FROM public.documents WHERE id = p_document FOR UPDATE;
  IF NOT FOUND OR NOT app.document_readable(d.id) THEN RAISE EXCEPTION 'Document not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_document_manager(d.organisation_id);
  IF d.status NOT IN ('active', 'withdrawn') THEN RAISE EXCEPTION '% has never been issued: carry on with its draft', d.number USING ERRCODE = 'QM025'; END IF;
  IF EXISTS (SELECT 1 FROM public.document_revisions WHERE document_id = d.id AND status IN ('draft', 'in_review', 'awaiting_approval', 'approved')) THEN
    RAISE EXCEPTION '% already has a revision in progress', d.number USING ERRCODE = 'QM025';
  END IF;
  SELECT * INTO v_from FROM public.document_revisions
   WHERE document_id = d.id AND status IN ('effective', 'superseded', 'withdrawn') ORDER BY (status = 'effective') DESC, sequence DESC LIMIT 1;
  SELECT coalesce(max(sequence), 0) + 1 INTO v_seq FROM public.document_revisions WHERE document_id = d.id;
  INSERT INTO public.document_revisions (organisation_id, document_id, sequence, author_id, body, body_text, previous_revision_id)
  VALUES (d.organisation_id, d.id, v_seq, auth.uid(), v_from.body, v_from.body_text, v_from.id) RETURNING id INTO v_id;
  INSERT INTO public.document_revision_files (organisation_id, revision_id, role, storage_path, file_name, content_type, size_bytes)
  SELECT organisation_id, v_id, role, storage_path, file_name, content_type, size_bytes
    FROM public.document_revision_files WHERE revision_id = v_from.id AND deleted_at IS NULL ORDER BY created_at;
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------
-- Notices: "a document is waiting for your review / approval", addressed to that person
-- ---------------------------------------------------------------------------
INSERT INTO public.notification_event_types
  (key, entity_type, action, group_name, entity_label, description, permission_code, default_on, default_permission_code, label_fields, display_order, own_record)
VALUES
  ('document_signoffs.created', 'document_signoffs', 'created', 'Documentation', 'Document sign-off', 'A document is waiting for you', 'documentation.read', true, NULL,
   ARRAY['document_label', 'role_label'], 60, true);
UPDATE public.notification_event_types SET email_default = true WHERE key = 'document_signoffs.created';

-- emit_notification as merged in 20260201100000, plus the document sign-off branch.
CREATE OR REPLACE FUNCTION app.emit_notification() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_action text;
  v_type public.notification_event_types%ROWTYPE;
  v_row jsonb := coalesce(NEW.new_values, NEW.previous_values);
  v_what text;
  v_body text;
  v_details jsonb;
  v_recipient uuid;
  v_capa_row jsonb;
  v_comp_row jsonb;
  v_doc_row jsonb;
BEGIN
  -- A recipient row also changes when they view or acknowledge: only the withdrawal notice is worth a notification.
  IF NEW.entity_type = 'quality_alert_recipients' AND NEW.action = 'update' AND NOT (coalesce(NEW.changed_fields, '{}') @> ARRAY['withdrawn_notified_at']) THEN
    RETURN NULL;
  END IF;

  -- An 8D action notifies the person it is assigned to, when it is added with someone on it or handed to someone else; nothing else about it does.
  IF NEW.entity_type = 'capa_actions' AND (NEW.action = 'delete' OR (NEW.action = 'update' AND NOT (coalesce(NEW.changed_fields, '{}') @> ARRAY['owner_team_member_id']))) THEN
    RETURN NULL;
  END IF;

  -- An assessment is announced once, when it is made; superseding the earlier one is not news.
  IF NEW.entity_type = 'competence_assessments' AND NEW.action <> 'insert' THEN
    RETURN NULL;
  END IF;

  -- A sign-off is announced to its person when it is created; their own decision is not news to them.
  IF NEW.entity_type = 'document_signoffs' AND NEW.action <> 'insert' THEN
    RETURN NULL;
  END IF;

  v_action := CASE
    WHEN NEW.action = 'insert' THEN 'created'
    WHEN NEW.action = 'delete' THEN 'deleted'
    WHEN NEW.changed_fields @> ARRAY['deleted_at'] AND NEW.new_values ->> 'deleted_at' IS NOT NULL THEN 'deleted'
    ELSE 'updated' END;

  SELECT * INTO v_type FROM public.notification_event_types t WHERE t.entity_type = NEW.entity_type AND t.action = v_action;
  IF NOT FOUND THEN RETURN NULL; END IF;

  v_row := coalesce(NEW.previous_values, '{}'::jsonb) || coalesce(NEW.new_values, '{}'::jsonb);
  IF NEW.action = 'insert' THEN v_row := NEW.new_values; END IF;
  IF NEW.action = 'delete' THEN v_row := NEW.previous_values; END IF;
  -- An update records only what changed; a recipient notice needs the person and the alert too.
  IF NEW.entity_type = 'quality_alert_recipients' AND NEW.action = 'update' THEN
    v_row := coalesce((SELECT to_jsonb(r) FROM public.quality_alert_recipients r WHERE r.id = NEW.entity_id::uuid), '{}'::jsonb) || v_row;
  END IF;

  IF NEW.entity_type = 'capa_actions' THEN
    SELECT to_jsonb(a) || jsonb_build_object('capa_reference', c.reference, 'capa_title', c.title, 'user_id', m.user_id)
      INTO v_capa_row
      FROM public.capa_actions a
      JOIN public.capas c ON c.id = a.capa_id
      LEFT JOIN public.capa_team_members t ON t.id = a.owner_team_member_id
      LEFT JOIN public.organisation_users m ON m.id = t.membership_id
     WHERE a.id = NEW.entity_id::uuid;
    IF v_capa_row IS NULL OR v_capa_row ->> 'user_id' IS NULL THEN RETURN NULL; END IF;
    v_row := v_capa_row;
  END IF;

  -- An assessment tells the person assessed (their linked sign-in) the skill and the level; nobody else, and no one without a sign-in.
  IF NEW.entity_type = 'competence_assessments' THEN
    SELECT to_jsonb(a) || jsonb_build_object(
             'user_id', e.auth_id, 'skill_name', k.name,
             'level_label', CASE a.level WHEN 0 THEN 'None' WHEN 1 THEN 'Learning' WHEN 2 THEN 'Supervised' WHEN 3 THEN 'Competent' ELSE 'Can train others' END || ' (' || a.level || ')')
      INTO v_comp_row
      FROM public.competence_assessments a
      JOIN public."Employees" e ON e.id = a.employee_id AND e.organisation_id = a.organisation_id
      JOIN public.competence_skills k ON k.id = a.skill_id
     WHERE a.id = NEW.entity_id::uuid;
    IF v_comp_row IS NULL OR v_comp_row ->> 'user_id' IS NULL THEN RETURN NULL; END IF;
    v_row := v_comp_row;
  END IF;

  -- A sign-off tells its reviewer or approver which document (number, letter and title) and what is asked of them.
  IF NEW.entity_type = 'document_signoffs' THEN
    SELECT to_jsonb(s) || jsonb_build_object(
             'document_id', d.id, 'revision_id', r.id,
             'document_label', d.number || ' rev ' || coalesce(r.letter, '?') || ' · ' || d.title,
             'role_label', CASE s.role WHEN 'reviewer' THEN 'Review it' ELSE 'Approve it' END)
      INTO v_doc_row
      FROM public.document_signoffs s
      JOIN public.document_revisions r ON r.id = s.revision_id
      JOIN public.documents d ON d.id = r.document_id
     WHERE s.id = NEW.entity_id::uuid;
    IF v_doc_row IS NULL THEN RETURN NULL; END IF;
    v_row := v_doc_row;
  END IF;

  v_body := nullif(concat_ws(' — ', VARIADIC (
    SELECT coalesce(array_agg(nullif(v_row ->> f, '') ORDER BY ord), '{}') FROM unnest(v_type.label_fields) WITH ORDINALITY AS u(f, ord))), '');
  IF v_action = 'updated' AND NEW.changed_fields IS NOT NULL AND NEW.entity_type NOT IN ('quality_alert_recipients', 'capa_actions', 'competence_assessments', 'document_signoffs') THEN
    v_what := 'Changed: ' || replace(array_to_string(NEW.changed_fields, ', '), '_', ' ');
    v_body := concat_ws('. ', v_body, left(v_what, 200));
  END IF;

  SELECT coalesce(jsonb_object_agg(k, v_row -> k), '{}'::jsonb) INTO v_details
    FROM unnest(ARRAY['site_id', 'gauge_id', 'control_plan_id', 'part_id', 'source', 'stage', 'status', 'alert_id', 'capa_id', 'connection_id', 'run_id', 'kind',
                      'document_id', 'revision_id', 'role']) k
   WHERE v_row ->> k IS NOT NULL;

  -- Notices about one person's own alerts are for that person only.
  IF NEW.entity_type IN ('quality_alert_recipients', 'capa_actions', 'competence_assessments', 'document_signoffs') THEN v_recipient := (v_row ->> 'user_id')::uuid; END IF;

  INSERT INTO public.notifications (organisation_id, event_type_id, audit_event_id, entity_type, entity_id, title, body, details, actor_user_id, recipient_user_id)
  VALUES (NEW.organisation_id, v_type.id, NEW.id, NEW.entity_type, NEW.entity_id, v_type.description, v_body, v_details,
          CASE WHEN NEW.entity_type = 'integration_alerts' THEN NULL ELSE NEW.actor_user_id END, v_recipient)
  ON CONFLICT (audit_event_id) DO NOTHING;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app.document_reviewer_rules(), app.document_signoff_rules(), app.document_signer_of(uuid), app.document_revision_problems(uuid),
  app.document_signer_candidates(uuid), app.set_document_signers(uuid, uuid[], uuid), app.submit_document_revision(uuid), app.document_signoff_for(uuid, text),
  app.document_return_to_draft(uuid), app.review_document_revision(uuid, boolean, text), app.approve_document_revision(uuid, date, text),
  app.send_back_document_revision(uuid, text), app.settle_document(uuid), app.settle_documents(uuid), app.system_settle_documents(),
  app.withdraw_document(uuid, text), app.start_document_revision(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.document_signer_of(uuid), app.document_revision_problems(uuid), app.document_signer_candidates(uuid),
  app.set_document_signers(uuid, uuid[], uuid), app.submit_document_revision(uuid), app.review_document_revision(uuid, boolean, text),
  app.approve_document_revision(uuid, date, text), app.send_back_document_revision(uuid, text), app.settle_documents(uuid),
  app.withdraw_document(uuid, text), app.start_document_revision(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION app.system_settle_documents() TO qms_api;
