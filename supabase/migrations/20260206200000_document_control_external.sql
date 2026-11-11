-- Document control slice DC5 (docs/document-control-plan.md DC10): external documents.
--
-- External documents (customer specifications, standards, supplier manuals) are documents with origin `external`: their reference and issuer are
-- typed in, they are always files, and each revision carries the issuer's own revision label. They have **no internal review or approval**:
-- someone with documentation.issue records the draft as approved with the date it takes effect (`app.issue_external_revision`), and it settles
-- like any other revision (in force on that date, the previous one superseded, readers asked, next review date set). Readers, restriction,
-- periodic review, links and change requests apply as for internal documents.
--  * `app.create_external_document(org, jsonb)` = `app.create_document` for a file document plus the external details;
--    `app.update_external_details(doc, jsonb)` changes the reference and issuer (documentation.manage).
--  * The origin never changes. An external draft cannot be sent for internal review; an internal one cannot skip it.
-- Controlled PDF copies and the documents dashboard need no database change (the API reads files with the service key after checking the
-- caller may read the revision). Errors QM025 (409 document_rule); another organisation's id P0002 (404).

ALTER TABLE public.documents
  ADD COLUMN origin text NOT NULL DEFAULT 'internal' CHECK (origin IN ('internal', 'external')),
  ADD COLUMN external_reference text CHECK (external_reference IS NULL OR (length(btrim(external_reference)) BETWEEN 1 AND 120 AND external_reference = btrim(external_reference))),
  ADD COLUMN issuer text CHECK (issuer IS NULL OR length(btrim(issuer)) BETWEEN 1 AND 200),
  ADD CONSTRAINT documents_external_state_check CHECK ((origin = 'external') = (issuer IS NOT NULL) AND (origin = 'internal' OR content_kind = 'file'));

ALTER TABLE public.document_revisions
  ADD COLUMN issuer_revision text CHECK (issuer_revision IS NULL OR length(btrim(issuer_revision)) BETWEEN 1 AND 40);

-- Replaces DC1's: the origin never changes either.
CREATE OR REPLACE FUNCTION app.document_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A document is never deleted. Withdraw it with a reason.' USING ERRCODE = 'QM025'; END IF;
  -- Only app.create_external_document marks a document it has just created as external (transaction-local setting).
  IF NEW.number <> OLD.number OR NEW.type_id <> OLD.type_id OR NEW.content_kind <> OLD.content_kind
     OR (NEW.origin <> OLD.origin AND NOT (OLD.origin = 'internal' AND NEW.origin = 'external' AND current_setting('app.document_external_create', true) = 'on')) THEN
    RAISE EXCEPTION 'A document''s number, type, content kind and origin never change' USING ERRCODE = 'QM025';
  END IF;
  IF OLD.status = 'discarded' THEN RAISE EXCEPTION '% was discarded and cannot be changed', OLD.number USING ERRCODE = 'QM025'; END IF;
  RETURN NEW;
END $$;

-- Replaces DC3's: an external draft goes straight to approved (and never to internal review); an internal one never skips review;
-- the issuer's revision label is part of the frozen content.
CREATE OR REPLACE FUNCTION app.document_revision_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_external boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A revision is never deleted. Discard a draft with a reason.' USING ERRCODE = 'QM025'; END IF;
  IF (NEW.document_id, NEW.sequence, NEW.author_id) IS DISTINCT FROM (OLD.document_id, OLD.sequence, OLD.author_id) THEN
    RAISE EXCEPTION 'A revision''s document, sequence and author never change' USING ERRCODE = 'QM025';
  END IF;
  IF OLD.letter IS NOT NULL AND NEW.letter IS DISTINCT FROM OLD.letter THEN RAISE EXCEPTION 'A revision letter never changes' USING ERRCODE = 'QM025'; END IF;
  IF OLD.status <> 'draft' AND (NEW.change_summary, NEW.body, NEW.body_text, NEW.approver_id, NEW.previous_revision_id, NEW.acknowledge_within_days, NEW.issuer_revision)
     IS DISTINCT FROM (OLD.change_summary, OLD.body, OLD.body_text, OLD.approver_id, OLD.previous_revision_id, OLD.acknowledge_within_days, OLD.issuer_revision) THEN
    RAISE EXCEPTION 'Only a draft''s content can change' USING ERRCODE = 'QM025';
  END IF;
  IF OLD.status IN ('discarded', 'superseded', 'withdrawn') THEN RAISE EXCEPTION 'A % revision cannot be changed', OLD.status USING ERRCODE = 'QM025'; END IF;
  IF OLD.status IN ('approved', 'effective') AND (NEW.effective_from, NEW.approved_at, NEW.approved_by) IS DISTINCT FROM (OLD.effective_from, OLD.approved_at, OLD.approved_by) THEN
    RAISE EXCEPTION 'An approved revision is frozen' USING ERRCODE = 'QM025';
  END IF;
  IF NEW.status <> OLD.status THEN
    SELECT origin = 'external' INTO v_external FROM public.documents WHERE id = NEW.document_id;
    IF v_external AND OLD.status = 'draft' AND NEW.status = 'in_review' THEN
      RAISE EXCEPTION 'An external document has no internal review: record the revision as issued instead' USING ERRCODE = 'QM025';
    END IF;
    IF NOT (
         (OLD.status = 'draft' AND NEW.status IN ('in_review', 'discarded'))
      OR (v_external AND OLD.status = 'draft' AND NEW.status = 'approved')
      OR (OLD.status = 'in_review' AND NEW.status IN ('draft', 'awaiting_approval'))
      OR (OLD.status = 'awaiting_approval' AND NEW.status IN ('draft', 'approved'))
      OR (OLD.status = 'approved' AND NEW.status IN ('effective', 'withdrawn'))
      OR (OLD.status = 'effective' AND NEW.status IN ('superseded', 'withdrawn'))) THEN
      RAISE EXCEPTION 'A revision cannot move from % to %', replace(OLD.status, '_', ' '), replace(NEW.status, '_', ' ') USING ERRCODE = 'QM025';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- External documents
-- ---------------------------------------------------------------------------
-- Keys: the create_document keys (except contentKind, always file) plus issuer (required) and externalReference.
CREATE FUNCTION app.create_external_document(p_organisation_id uuid, p_data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_issuer text := btrim(coalesce(p_data ->> 'issuer', '')); v_ref text := nullif(btrim(coalesce(p_data ->> 'externalReference', '')), ''); v_id uuid;
BEGIN
  PERFORM app.assert_document_manager(p_organisation_id);
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Send the document as an object' USING ERRCODE = 'QM025'; END IF;
  IF p_data ? 'contentKind' AND p_data ->> 'contentKind' <> 'file' THEN RAISE EXCEPTION 'An external document is always a file' USING ERRCODE = 'QM025'; END IF;
  IF length(v_issuer) = 0 OR length(v_issuer) > 200 THEN RAISE EXCEPTION 'Name who issues it (up to 200 characters)' USING ERRCODE = 'QM025'; END IF;
  IF v_ref IS NOT NULL AND length(v_ref) > 120 THEN RAISE EXCEPTION 'The issuer''s reference is up to 120 characters' USING ERRCODE = 'QM025'; END IF;
  v_id := app.create_document(p_organisation_id, (p_data - 'issuer' - 'externalReference') || '{"contentKind":"file"}'::jsonb);
  PERFORM set_config('app.document_external_create', 'on', true);
  UPDATE public.documents SET origin = 'external', issuer = v_issuer, external_reference = v_ref WHERE id = v_id;
  PERFORM set_config('app.document_external_create', 'off', true);
  RETURN v_id;
END $$;

CREATE FUNCTION app.update_external_details(p_document uuid, p_data jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE d public.documents%ROWTYPE; k text;
BEGIN
  SELECT * INTO d FROM public.documents WHERE id = p_document FOR UPDATE;
  IF NOT FOUND OR NOT app.document_readable(d.id) THEN RAISE EXCEPTION 'Document not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_document_manager(d.organisation_id);
  IF d.origin <> 'external' THEN RAISE EXCEPTION '% is an internal document' , d.number USING ERRCODE = 'QM025'; END IF;
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Send the changes as an object' USING ERRCODE = 'QM025'; END IF;
  FOR k IN SELECT jsonb_object_keys(p_data) LOOP
    IF k NOT IN ('issuer', 'externalReference') THEN RAISE EXCEPTION 'Unknown field %', k USING ERRCODE = 'QM025'; END IF;
  END LOOP;
  IF p_data ? 'issuer' THEN d.issuer := btrim(coalesce(p_data ->> 'issuer', '')); END IF;
  IF p_data ? 'externalReference' THEN d.external_reference := nullif(btrim(coalesce(p_data ->> 'externalReference', '')), ''); END IF;
  IF d.issuer IS NULL OR length(d.issuer) = 0 OR length(d.issuer) > 200 THEN RAISE EXCEPTION 'Name who issues it (up to 200 characters)' USING ERRCODE = 'QM025'; END IF;
  IF d.external_reference IS NOT NULL AND length(d.external_reference) > 120 THEN RAISE EXCEPTION 'The issuer''s reference is up to 120 characters' USING ERRCODE = 'QM025'; END IF;
  UPDATE public.documents SET issuer = d.issuer, external_reference = d.external_reference WHERE id = d.id;
END $$;

-- Records an external document's draft as issued: its own letter (as for any revision), the issuer's revision label, the date it takes effect
-- (any date: an issuer's revision may already be in force elsewhere) and, from the second revision on, what changed. Needs documentation.issue
-- and a main file; no reviewers or approver. It then settles like any approved revision.
CREATE FUNCTION app.issue_external_revision(p_revision uuid, p_issuer_revision text, p_effective_from date, p_change_summary text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.document_revisions; d public.documents%ROWTYPE; v_label text := btrim(coalesce(p_issuer_revision, '')); v_summary text := nullif(btrim(coalesce(p_change_summary, '')), '');
  v_letter text;
BEGIN
  r := app.document_draft_for_update(p_revision);
  SELECT * INTO d FROM public.documents WHERE id = r.document_id FOR UPDATE;
  IF d.origin <> 'external' THEN RAISE EXCEPTION '% is an internal document: send it for review instead', d.number USING ERRCODE = 'QM025'; END IF;
  IF NOT app.has_permission(d.organisation_id, 'documentation.issue') THEN RAISE EXCEPTION 'Recording an external revision needs the documentation issue permission' USING ERRCODE = '42501'; END IF;
  IF length(v_label) = 0 OR length(v_label) > 40 THEN RAISE EXCEPTION 'Give the issuer''s revision (up to 40 characters)' USING ERRCODE = 'QM025'; END IF;
  IF p_effective_from IS NULL THEN RAISE EXCEPTION 'Say when it takes effect' USING ERRCODE = 'QM025'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.document_revision_files f WHERE f.revision_id = r.id AND f.role = 'main' AND f.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'Upload the main file first' USING ERRCODE = 'QM025';
  END IF;
  IF d.status IN ('active', 'withdrawn') AND coalesce(v_summary, r.change_summary) IS NULL THEN RAISE EXCEPTION 'Say what changed' USING ERRCODE = 'QM025'; END IF;
  IF v_summary IS NOT NULL AND length(v_summary) > 2000 THEN RAISE EXCEPTION 'The change summary is up to 2000 characters' USING ERRCODE = 'QM025'; END IF;
  v_letter := CASE WHEN d.last_letter IS NULL THEN d.start_letter ELSE app.document_letter_after(d.last_letter) END;
  UPDATE public.documents SET last_letter = v_letter WHERE id = d.id;
  UPDATE public.document_revisions SET issuer_revision = v_label, change_summary = coalesce(v_summary, change_summary) WHERE id = r.id;
  UPDATE public.document_revisions SET status = 'approved', letter = v_letter, submitted_at = now(), submitted_by = auth.uid(), approved_at = now(), approved_by = auth.uid(),
         effective_from = p_effective_from
   WHERE id = r.id;
  PERFORM app.settle_document(d.id);
END $$;

-- The "still needed" list: an external draft needs its main file (and, after the first issue, what changed); no reviewers or approver.
CREATE OR REPLACE FUNCTION app.document_revision_problems(p_revision uuid) RETURNS text[]
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
  IF d.origin = 'external' THEN RETURN v; END IF;
  SELECT count(*) INTO v_reviewers FROM public.document_revision_reviewers WHERE revision_id = r.id;
  IF v_reviewers = 0 THEN v := v || 'Name at least one reviewer'::text; END IF;
  IF r.approver_id IS NULL THEN v := v || 'Name the approver'::text; END IF;
  IF r.approver_id IS NOT NULL AND NOT app.is_active_member_user(r.organisation_id, r.approver_id) THEN v := v || 'The approver is no longer an active member'::text; END IF;
  IF EXISTS (SELECT 1 FROM public.document_revision_reviewers x WHERE x.revision_id = r.id AND NOT app.is_active_member_user(r.organisation_id, x.user_id)) THEN
    v := v || 'A reviewer is no longer an active member'::text;
  END IF;
  RETURN v;
END $$;


REVOKE ALL ON FUNCTION app.create_external_document(uuid, jsonb), app.update_external_details(uuid, jsonb), app.issue_external_revision(uuid, text, date, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.create_external_document(uuid, jsonb), app.update_external_details(uuid, jsonb), app.issue_external_revision(uuid, text, date, text) TO authenticated;
