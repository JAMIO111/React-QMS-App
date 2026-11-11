-- Document control slice DC3 (docs/document-control-plan.md DC4, DC7, DC12, DC16): who must read a document, acknowledgement, restricted documents,
-- and the competence evidence link.
--
--  * document_targets: who must read the document (a department's members, everyone holding a role, or a named person), kept on the document and
--    replaced as a whole by `app.set_document_targets` (documentation.manage).
--  * document_recipients: **fixed when a revision becomes effective** (`app.settle_document` resolves the targets then); every new revision asks again.
--    One row per person: how they were reached, first viewed, acknowledged (with an optional note), and the date it is due when the revision asks for
--    one (`document_revisions.acknowledge_within_days`, set on the draft; due = effective date + days). Written only by functions:
--    `app.mark_document_viewed` (the recipient, first view), `app.acknowledge_document(revision, note)` (the recipient, the revision in force only, once),
--    `app.add_document_recipient(revision, user)` (documentation.manage, later additions; reached via "Added"). Overdue is worked out on read.
--  * Restricted documents (`documents.restricted`, DC16): readable only by the people the document reaches (targets now, or recipients of any revision)
--    and by document managers (plus the owner, authors and signers, as before). A recipient reads their own row; managers read all of them.
--  * Skills a document trains (`document_skills`, `app.set_document_skills`): acknowledging it shows on the person's competence record as evidence, never
--    as an assessment (`app.competence_document_evidence(employee)` for competence.read or the person themselves).
--  * Notice `document_recipients.created` ("A document for you to read", addressed to the person, no actor: it is the system, so the person whose read
--    settled it is told too).
-- Errors QM025 (409 document_rule); another organisation's id P0002 (404).

ALTER TABLE public.documents ADD COLUMN restricted boolean NOT NULL DEFAULT false;
ALTER TABLE public.document_revisions ADD COLUMN acknowledge_within_days integer CHECK (acknowledge_within_days IS NULL OR acknowledge_within_days BETWEEN 1 AND 365);

-- The DC2 freeze also covers how long readers have.
CREATE OR REPLACE FUNCTION app.document_revision_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A revision is never deleted. Discard a draft with a reason.' USING ERRCODE = 'QM025'; END IF;
  IF (NEW.document_id, NEW.sequence, NEW.author_id) IS DISTINCT FROM (OLD.document_id, OLD.sequence, OLD.author_id) THEN
    RAISE EXCEPTION 'A revision''s document, sequence and author never change' USING ERRCODE = 'QM025';
  END IF;
  IF OLD.letter IS NOT NULL AND NEW.letter IS DISTINCT FROM OLD.letter THEN RAISE EXCEPTION 'A revision letter never changes' USING ERRCODE = 'QM025'; END IF;
  IF OLD.status <> 'draft' AND (NEW.change_summary, NEW.body, NEW.body_text, NEW.approver_id, NEW.previous_revision_id, NEW.acknowledge_within_days)
     IS DISTINCT FROM (OLD.change_summary, OLD.body, OLD.body_text, OLD.approver_id, OLD.previous_revision_id, OLD.acknowledge_within_days) THEN
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

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE public.document_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  document_id uuid NOT NULL,
  department_id uuid,
  role_id uuid,
  membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT document_targets_document_fkey FOREIGN KEY (document_id, organisation_id) REFERENCES public.documents (id, organisation_id),
  CONSTRAINT document_targets_department_fkey FOREIGN KEY (department_id, organisation_id) REFERENCES public.departments (id, organisation_id),
  CONSTRAINT document_targets_role_fkey FOREIGN KEY (role_id, organisation_id) REFERENCES public.roles (id, organisation_id),
  CONSTRAINT document_targets_membership_fkey FOREIGN KEY (membership_id, organisation_id) REFERENCES public.organisation_users (id, organisation_id),
  CONSTRAINT document_targets_one CHECK (num_nonnulls(department_id, role_id, membership_id) = 1)
);
CREATE UNIQUE INDEX document_targets_once_key ON public.document_targets (document_id, coalesce(department_id, role_id, membership_id));

CREATE TABLE public.document_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  revision_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users (id),
  reached_via text[] NOT NULL DEFAULT ARRAY[]::text[],
  due_on date,
  first_viewed_at timestamptz,
  acknowledged_at timestamptz,
  acknowledge_note text CHECK (acknowledge_note IS NULL OR length(btrim(acknowledge_note)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT document_recipients_once_key UNIQUE (revision_id, user_id),
  CONSTRAINT document_recipients_revision_fkey FOREIGN KEY (revision_id, organisation_id) REFERENCES public.document_revisions (id, organisation_id)
);
CREATE INDEX document_recipients_user_idx ON public.document_recipients (organisation_id, user_id) WHERE acknowledged_at IS NULL;

CREATE TABLE public.document_skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  document_id uuid NOT NULL,
  skill_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT document_skills_pair_key UNIQUE (document_id, skill_id),
  CONSTRAINT document_skills_document_fkey FOREIGN KEY (document_id, organisation_id) REFERENCES public.documents (id, organisation_id),
  CONSTRAINT document_skills_skill_fkey FOREIGN KEY (skill_id, organisation_id) REFERENCES public.competence_skills (id, organisation_id)
);
CREATE INDEX document_skills_skill_idx ON public.document_skills (skill_id);

-- A recipient row records a first view and an acknowledgement, once each; who and which revision never change; nothing is deleted.
CREATE FUNCTION app.document_recipient_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A recipient is never deleted' USING ERRCODE = 'QM025'; END IF;
  IF (NEW.revision_id, NEW.user_id, NEW.reached_via, NEW.due_on) IS DISTINCT FROM (OLD.revision_id, OLD.user_id, OLD.reached_via, OLD.due_on) THEN
    RAISE EXCEPTION 'Who was asked, and by when, never changes' USING ERRCODE = 'QM025';
  END IF;
  IF OLD.first_viewed_at IS NOT NULL AND NEW.first_viewed_at IS DISTINCT FROM OLD.first_viewed_at THEN RAISE EXCEPTION 'The first view is recorded once' USING ERRCODE = 'QM025'; END IF;
  IF OLD.acknowledged_at IS NOT NULL AND (NEW.acknowledged_at, NEW.acknowledge_note) IS DISTINCT FROM (OLD.acknowledged_at, OLD.acknowledge_note) THEN
    RAISE EXCEPTION 'An acknowledgement is frozen' USING ERRCODE = 'QM025';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_recipients_rules BEFORE UPDATE OR DELETE ON public.document_recipients FOR EACH ROW EXECUTE FUNCTION app.document_recipient_rules();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['document_targets', 'document_recipients', 'document_skills'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION app.stamp_created()', t || '_stamp', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.touch_updated()', t || '_touch', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change()', t || '_org_immutable', t);
    EXECUTE format('CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION audit.record_change(''organisation_id'')', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Who the targets reach, now
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.resolve_document_targets(p_document uuid)
RETURNS TABLE (user_id uuid, via text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH doc AS (SELECT organisation_id FROM public.documents WHERE id = p_document),
  hits AS (
    SELECT dm.membership_id, 'Department: ' || d.name AS via
      FROM public.document_targets t
      JOIN public.department_members dm ON dm.department_id = t.department_id AND dm.ended_at IS NULL
      JOIN public.departments d ON d.id = t.department_id
     WHERE t.document_id = p_document
    UNION ALL
    SELECT a.membership_id, 'Role: ' || r.name
      FROM public.document_targets t
      JOIN public.user_role_assignments a ON a.role_id = t.role_id
      JOIN public.roles r ON r.id = t.role_id
     WHERE t.document_id = p_document
    UNION ALL
    SELECT t.membership_id, 'Named'
      FROM public.document_targets t
     WHERE t.document_id = p_document AND t.membership_id IS NOT NULL
  )
  SELECT m.user_id, array_agg(DISTINCT h.via ORDER BY h.via)
    FROM hits h
    JOIN public.organisation_users m ON m.id = h.membership_id
    JOIN doc ON doc.organisation_id = m.organisation_id
   WHERE m.status = 'active' AND m.user_id IS NOT NULL
   GROUP BY m.user_id
$$;

-- Is the caller one of the document's readers (targeted now, or asked to read any of its revisions)?
CREATE FUNCTION app.document_is_reader(p_document uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.document_recipients x JOIN public.document_revisions r ON r.id = x.revision_id
                  WHERE r.document_id = p_document AND x.user_id = auth.uid())
      OR EXISTS (SELECT 1 FROM app.resolve_document_targets(p_document) t WHERE t.user_id = auth.uid())
$$;

-- ---------------------------------------------------------------------------
-- Reading, with restricted documents (replaces DC2's)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.document_readable(p_document uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.documents d
     WHERE d.id = p_document AND app.is_member(d.organisation_id)
       AND (app.has_permission(d.organisation_id, 'documentation.manage') OR d.owner_user_id = auth.uid()
            OR (d.status IN ('active', 'withdrawn') AND app.has_permission(d.organisation_id, 'documentation.read') AND (NOT d.restricted OR app.document_is_reader(d.id)))
            OR EXISTS (SELECT 1 FROM public.document_revisions r WHERE r.document_id = d.id AND (r.author_id = auth.uid() OR app.document_signer_of(r.id)))))
$$;
CREATE OR REPLACE FUNCTION app.document_revision_readable(p_revision uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.document_revisions r JOIN public.documents d ON d.id = r.document_id
     WHERE r.id = p_revision AND app.is_member(r.organisation_id)
       AND (app.has_permission(r.organisation_id, 'documentation.manage')
            OR r.author_id = auth.uid() OR d.owner_user_id = auth.uid() OR app.document_signer_of(r.id)
            OR (r.status IN ('approved', 'effective', 'superseded', 'withdrawn') AND app.has_permission(r.organisation_id, 'documentation.read')
                AND (NOT d.restricted OR app.document_is_reader(d.id)))))
$$;

ALTER TABLE public.document_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_skills ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.document_targets, public.document_recipients, public.document_skills FROM anon, authenticated;
GRANT SELECT ON public.document_targets, public.document_recipients, public.document_skills TO authenticated;
CREATE POLICY document_targets_select ON public.document_targets FOR SELECT TO authenticated USING (app.document_readable(document_id));
CREATE POLICY document_skills_select ON public.document_skills FOR SELECT TO authenticated USING (app.document_readable(document_id));
-- Managers read every recipient; anyone else only their own row.
CREATE POLICY document_recipients_select ON public.document_recipients FOR SELECT TO authenticated
  USING ((user_id = (SELECT auth.uid()) AND app.is_member(organisation_id)) OR app.has_permission(organisation_id, 'documentation.manage'));

-- ---------------------------------------------------------------------------
-- Header changes (replaces DC1's): adds `restricted`
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.update_document(p_id uuid, p_data jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE d public.documents%ROWTYPE; k text;
BEGIN
  SELECT * INTO d FROM public.documents WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(d.organisation_id) THEN RAISE EXCEPTION 'Document not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_document_manager(d.organisation_id);
  IF d.status = 'discarded' THEN RAISE EXCEPTION '% was discarded and cannot be changed', d.number USING ERRCODE = 'QM025'; END IF;
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Send the changes as an object' USING ERRCODE = 'QM025'; END IF;
  FOR k IN SELECT jsonb_object_keys(p_data) LOOP
    IF k NOT IN ('title', 'description', 'ownerId', 'restricted') THEN RAISE EXCEPTION 'Unknown field % (the number, type and content kind never change)', k USING ERRCODE = 'QM025'; END IF;
  END LOOP;
  IF p_data ? 'title' THEN d.title := btrim(coalesce(p_data ->> 'title', '')); END IF;
  IF p_data ? 'description' THEN d.description := nullif(btrim(coalesce(p_data ->> 'description', '')), ''); END IF;
  IF p_data ? 'ownerId' THEN d.owner_user_id := nullif(p_data ->> 'ownerId', '')::uuid; END IF;
  IF p_data ? 'restricted' THEN d.restricted := coalesce((p_data ->> 'restricted')::boolean, false); END IF;
  IF length(d.title) = 0 OR length(d.title) > 200 THEN RAISE EXCEPTION 'Give the document a title (up to 200 characters)' USING ERRCODE = 'QM025'; END IF;
  IF d.description IS NOT NULL AND length(d.description) > 1000 THEN RAISE EXCEPTION 'The description is up to 1000 characters' USING ERRCODE = 'QM025'; END IF;
  IF d.owner_user_id IS NULL OR NOT app.is_active_member_user(d.organisation_id, d.owner_user_id) THEN
    RAISE EXCEPTION 'The owner must be an active member of this organisation' USING ERRCODE = 'QM025';
  END IF;
  UPDATE public.documents SET title = d.title, description = d.description, owner_user_id = d.owner_user_id, restricted = d.restricted WHERE id = d.id;
END $$;

-- Draft changes (replaces DC1's): adds acknowledgeWithinDays (1–365 days after it takes effect, or null for no deadline).
CREATE OR REPLACE FUNCTION app.update_document_revision(p_revision uuid, p_data jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.document_revisions; v_kind text; k text; v_summary text; v_body jsonb; v_days integer;
BEGIN
  r := app.document_draft_for_update(p_revision);
  SELECT content_kind INTO v_kind FROM public.documents WHERE id = r.document_id;
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Send the changes as an object' USING ERRCODE = 'QM025'; END IF;
  FOR k IN SELECT jsonb_object_keys(p_data) LOOP
    IF k NOT IN ('changeSummary', 'body', 'acknowledgeWithinDays') THEN RAISE EXCEPTION 'Unknown field %', k USING ERRCODE = 'QM025'; END IF;
  END LOOP;
  v_summary := r.change_summary; v_body := r.body; v_days := r.acknowledge_within_days;
  IF p_data ? 'changeSummary' THEN v_summary := nullif(btrim(coalesce(p_data ->> 'changeSummary', '')), ''); END IF;
  IF v_summary IS NOT NULL AND length(v_summary) > 2000 THEN RAISE EXCEPTION 'The change summary is up to 2000 characters' USING ERRCODE = 'QM025'; END IF;
  IF p_data ? 'body' THEN
    IF v_kind <> 'text' THEN RAISE EXCEPTION 'This is a file document: upload its main file instead of writing text' USING ERRCODE = 'QM025'; END IF;
    v_body := CASE WHEN jsonb_typeof(p_data -> 'body') = 'null' THEN NULL ELSE p_data -> 'body' END;
    IF v_body IS NOT NULL AND (jsonb_typeof(v_body) <> 'object' OR v_body ->> 'type' IS DISTINCT FROM 'doc') THEN
      RAISE EXCEPTION 'The text must be an editor document' USING ERRCODE = 'QM025';
    END IF;
    IF v_body IS NOT NULL AND pg_column_size(v_body) > 512000 THEN RAISE EXCEPTION 'The text is too long (at most 500 kB)' USING ERRCODE = 'QM025'; END IF;
  END IF;
  IF p_data ? 'acknowledgeWithinDays' THEN
    v_days := (p_data ->> 'acknowledgeWithinDays')::integer;
    IF v_days IS NOT NULL AND v_days NOT BETWEEN 1 AND 365 THEN RAISE EXCEPTION 'Readers have 1 to 365 days to acknowledge it' USING ERRCODE = 'QM025'; END IF;
  END IF;
  UPDATE public.document_revisions SET change_summary = v_summary, body = v_body, body_text = app.document_body_text(v_body), acknowledge_within_days = v_days WHERE id = r.id;
END $$;

-- ---------------------------------------------------------------------------
-- Readers, skills, viewing and acknowledging
-- ---------------------------------------------------------------------------
-- targets: [{departmentId} | {roleId} | {membershipId}], replaced as a whole.
CREATE FUNCTION app.set_document_targets(p_document uuid, p_targets jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE d public.documents%ROWTYPE; t jsonb; v_dep uuid; v_role uuid; v_mem uuid;
BEGIN
  SELECT * INTO d FROM public.documents WHERE id = p_document FOR UPDATE;
  IF NOT FOUND OR NOT app.document_readable(d.id) THEN RAISE EXCEPTION 'Document not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_document_manager(d.organisation_id);
  IF d.status = 'discarded' THEN RAISE EXCEPTION '% was discarded and cannot be changed', d.number USING ERRCODE = 'QM025'; END IF;
  IF jsonb_typeof(p_targets) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Send the readers as a list' USING ERRCODE = 'QM025'; END IF;
  IF jsonb_array_length(p_targets) > 100 THEN RAISE EXCEPTION 'At most 100 readers entries' USING ERRCODE = 'QM025'; END IF;
  DELETE FROM public.document_targets WHERE document_id = d.id;
  FOR t IN SELECT * FROM jsonb_array_elements(p_targets) LOOP
    v_dep := nullif(t ->> 'departmentId', '')::uuid; v_role := nullif(t ->> 'roleId', '')::uuid; v_mem := nullif(t ->> 'membershipId', '')::uuid;
    IF num_nonnulls(v_dep, v_role, v_mem) <> 1 THEN RAISE EXCEPTION 'Each reader entry is one department, role or person' USING ERRCODE = 'QM025'; END IF;
    IF v_dep IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.departments WHERE id = v_dep AND organisation_id = d.organisation_id) THEN RAISE EXCEPTION 'Department not found' USING ERRCODE = 'QM025'; END IF;
    IF v_role IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.roles WHERE id = v_role AND organisation_id = d.organisation_id) THEN RAISE EXCEPTION 'Role not found' USING ERRCODE = 'QM025'; END IF;
    IF v_mem IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.organisation_users WHERE id = v_mem AND organisation_id = d.organisation_id AND status = 'active') THEN
      RAISE EXCEPTION 'A named reader must be an active member' USING ERRCODE = 'QM025';
    END IF;
    INSERT INTO public.document_targets (organisation_id, document_id, department_id, role_id, membership_id) VALUES (d.organisation_id, d.id, v_dep, v_role, v_mem)
    ON CONFLICT DO NOTHING;
  END LOOP;
END $$;

CREATE FUNCTION app.set_document_skills(p_document uuid, p_skills uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE d public.documents%ROWTYPE; v_ids uuid[] := ARRAY(SELECT DISTINCT unnest(coalesce(p_skills, ARRAY[]::uuid[])));
BEGIN
  SELECT * INTO d FROM public.documents WHERE id = p_document FOR UPDATE;
  IF NOT FOUND OR NOT app.document_readable(d.id) THEN RAISE EXCEPTION 'Document not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_document_manager(d.organisation_id);
  IF cardinality(v_ids) > 0 AND (SELECT count(*) FROM public.competence_skills WHERE id = ANY (v_ids) AND organisation_id = d.organisation_id AND active) <> cardinality(v_ids) THEN
    RAISE EXCEPTION 'Every skill must be an active skill of this organisation' USING ERRCODE = 'QM025';
  END IF;
  DELETE FROM public.document_skills WHERE document_id = d.id AND NOT (skill_id = ANY (v_ids));
  INSERT INTO public.document_skills (organisation_id, document_id, skill_id) SELECT d.organisation_id, d.id, unnest(v_ids) ON CONFLICT DO NOTHING;
END $$;

-- The recipient's first look; does nothing for anyone else (so the API can call it on every open).
CREATE FUNCTION app.mark_document_viewed(p_revision uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  UPDATE public.document_recipients SET first_viewed_at = now()
   WHERE revision_id = p_revision AND user_id = auth.uid() AND first_viewed_at IS NULL AND app.is_member(organisation_id);
$$;

CREATE FUNCTION app.acknowledge_document(p_revision uuid, p_note text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE x public.document_recipients%ROWTYPE; v_status text; v_note text := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  SELECT * INTO x FROM public.document_recipients WHERE revision_id = p_revision AND user_id = auth.uid() FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(x.organisation_id) THEN RAISE EXCEPTION 'You were not asked to read this revision' USING ERRCODE = 'QM025'; END IF;
  SELECT status INTO v_status FROM public.document_revisions WHERE id = p_revision;
  IF v_status <> 'effective' THEN RAISE EXCEPTION 'Only the revision in force is acknowledged (this one is %)', v_status USING ERRCODE = 'QM025'; END IF;
  IF x.acknowledged_at IS NOT NULL THEN RAISE EXCEPTION 'You have already acknowledged it' USING ERRCODE = 'QM025'; END IF;
  IF v_note IS NOT NULL AND length(v_note) > 1000 THEN RAISE EXCEPTION 'The note is up to 1000 characters' USING ERRCODE = 'QM025'; END IF;
  UPDATE public.document_recipients SET acknowledged_at = now(), acknowledge_note = v_note, first_viewed_at = coalesce(first_viewed_at, now()) WHERE id = x.id;
END $$;

-- Someone added later to the revision in force (documentation.manage), e.g. a new starter.
CREATE FUNCTION app.add_document_recipient(p_revision uuid, p_user uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.document_revisions%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.document_revisions WHERE id = p_revision;
  IF NOT FOUND OR NOT app.document_revision_readable(r.id) THEN RAISE EXCEPTION 'Revision not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_document_manager(r.organisation_id);
  IF r.status <> 'effective' THEN RAISE EXCEPTION 'People are added to the revision in force' USING ERRCODE = 'QM025'; END IF;
  IF NOT app.is_active_member_user(r.organisation_id, p_user) THEN RAISE EXCEPTION 'They must be an active member of this organisation' USING ERRCODE = 'QM025'; END IF;
  IF EXISTS (SELECT 1 FROM public.document_recipients WHERE revision_id = r.id AND user_id = p_user) THEN RAISE EXCEPTION 'They are already asked to read it' USING ERRCODE = 'QM025'; END IF;
  INSERT INTO public.document_recipients (organisation_id, revision_id, user_id, reached_via, due_on)
  VALUES (r.organisation_id, r.id, p_user, ARRAY['Added'], CASE WHEN r.acknowledge_within_days IS NULL THEN NULL ELSE current_date + r.acknowledge_within_days END);
END $$;

-- ---------------------------------------------------------------------------
-- Settling (replaces DC2's): the readers are fixed when a revision takes effect
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.settle_document(p_document uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r record; v_prev uuid; v_n integer := 0;
BEGIN
  FOR r IN SELECT id, organisation_id, effective_from, acknowledge_within_days FROM public.document_revisions
            WHERE document_id = p_document AND status = 'approved' AND effective_from <= current_date
            ORDER BY effective_from, approved_at FOR UPDATE
  LOOP
    SELECT id INTO v_prev FROM public.document_revisions WHERE document_id = p_document AND status = 'effective' FOR UPDATE;
    IF v_prev IS NOT NULL THEN
      UPDATE public.document_revisions SET status = 'superseded', superseded_at = now(), superseded_by_id = r.id WHERE id = v_prev;
    END IF;
    UPDATE public.document_revisions SET status = 'effective', effective_at = now() WHERE id = r.id;
    UPDATE public.documents SET status = 'active', current_revision_id = r.id, withdrawn_at = NULL, withdrawn_by = NULL, withdraw_reason = NULL WHERE id = p_document;
    INSERT INTO public.document_recipients (organisation_id, revision_id, user_id, reached_via, due_on)
    SELECT r.organisation_id, r.id, t.user_id, t.via, CASE WHEN r.acknowledge_within_days IS NULL THEN NULL ELSE r.effective_from + r.acknowledge_within_days END
      FROM app.resolve_document_targets(p_document) t
    ON CONFLICT (revision_id, user_id) DO NOTHING;
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $$;

-- ---------------------------------------------------------------------------
-- Competence evidence: documents the person acknowledged that train a skill (never an assessment)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.competence_document_evidence(p_employee uuid)
RETURNS TABLE (document_id uuid, number text, title text, letter text, revision_status text, acknowledged_at timestamptz, skills jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE e public."Employees"%ROWTYPE;
BEGIN
  SELECT * INTO e FROM public."Employees" WHERE id = p_employee;
  IF NOT FOUND OR NOT app.is_member(e.organisation_id) THEN RAISE EXCEPTION 'Employee not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT (app.has_permission(e.organisation_id, 'competence.read') OR app.competence_is_me(e.id)) THEN RAISE EXCEPTION 'Employee not found' USING ERRCODE = 'P0002'; END IF;
  IF e.auth_id IS NULL THEN RETURN; END IF;
  RETURN QUERY
    SELECT d.id, d.number, d.title, r.letter, r.status, x.acknowledged_at,
           (SELECT jsonb_agg(jsonb_build_object('id', k.id, 'code', k.code, 'name', k.name) ORDER BY lower(k.name))
              FROM public.document_skills ds JOIN public.competence_skills k ON k.id = ds.skill_id WHERE ds.document_id = d.id)
      FROM public.document_recipients x
      JOIN public.document_revisions r ON r.id = x.revision_id
      JOIN public.documents d ON d.id = r.document_id
     WHERE x.user_id = e.auth_id AND x.organisation_id = e.organisation_id AND x.acknowledged_at IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.document_skills ds WHERE ds.document_id = d.id)
     ORDER BY x.acknowledged_at DESC
     LIMIT 100;
END $$;

-- ---------------------------------------------------------------------------
-- Notice: "a document for you to read", addressed to the person (no actor: the system fixed the readers)
-- ---------------------------------------------------------------------------
INSERT INTO public.notification_event_types
  (key, entity_type, action, group_name, entity_label, description, permission_code, default_on, default_permission_code, label_fields, display_order, own_record)
VALUES
  ('document_recipients.created', 'document_recipients', 'created', 'Documentation', 'Document to read', 'A document for you to read', 'documentation.read', true, NULL,
   ARRAY['document_label', 'due_label'], 61, true);
UPDATE public.notification_event_types SET email_default = true WHERE key = 'document_recipients.created';

-- emit_notification as in 20260203100000, plus the document recipient branch.
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

  -- A sign-off, or a document to read, is announced to its person when it is created; their own view, decision or acknowledgement is not news to them.
  IF NEW.entity_type IN ('document_signoffs', 'document_recipients') AND NEW.action <> 'insert' THEN
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

  -- A document to read tells its reader which revision and by when.
  IF NEW.entity_type = 'document_recipients' THEN
    SELECT to_jsonb(x) || jsonb_build_object(
             'document_id', d.id, 'revision_id', r.id,
             'document_label', d.number || ' rev ' || coalesce(r.letter, '?') || ' · ' || d.title,
             'due_label', CASE WHEN x.due_on IS NULL THEN NULL ELSE 'Acknowledge by ' || to_char(x.due_on, 'FMDD Mon YYYY') END)
      INTO v_doc_row
      FROM public.document_recipients x
      JOIN public.document_revisions r ON r.id = x.revision_id
      JOIN public.documents d ON d.id = r.document_id
     WHERE x.id = NEW.entity_id::uuid;
    IF v_doc_row IS NULL THEN RETURN NULL; END IF;
    v_row := v_doc_row;
  END IF;

  v_body := nullif(concat_ws(' — ', VARIADIC (
    SELECT coalesce(array_agg(nullif(v_row ->> f, '') ORDER BY ord), '{}') FROM unnest(v_type.label_fields) WITH ORDINALITY AS u(f, ord))), '');
  IF v_action = 'updated' AND NEW.changed_fields IS NOT NULL AND NEW.entity_type NOT IN ('quality_alert_recipients', 'capa_actions', 'competence_assessments', 'document_signoffs', 'document_recipients') THEN
    v_what := 'Changed: ' || replace(array_to_string(NEW.changed_fields, ', '), '_', ' ');
    v_body := concat_ws('. ', v_body, left(v_what, 200));
  END IF;

  SELECT coalesce(jsonb_object_agg(k, v_row -> k), '{}'::jsonb) INTO v_details
    FROM unnest(ARRAY['site_id', 'gauge_id', 'control_plan_id', 'part_id', 'source', 'stage', 'status', 'alert_id', 'capa_id', 'connection_id', 'run_id', 'kind',
                      'document_id', 'revision_id', 'role']) k
   WHERE v_row ->> k IS NOT NULL;

  -- Notices about one person's own alerts are for that person only.
  IF NEW.entity_type IN ('quality_alert_recipients', 'capa_actions', 'competence_assessments', 'document_signoffs', 'document_recipients') THEN
    v_recipient := (v_row ->> 'user_id')::uuid;
  END IF;

  INSERT INTO public.notifications (organisation_id, event_type_id, audit_event_id, entity_type, entity_id, title, body, details, actor_user_id, recipient_user_id)
  VALUES (NEW.organisation_id, v_type.id, NEW.id, NEW.entity_type, NEW.entity_id, v_type.description, v_body, v_details,
          CASE WHEN NEW.entity_type IN ('integration_alerts', 'document_recipients') THEN NULL ELSE NEW.actor_user_id END, v_recipient)
  ON CONFLICT (audit_event_id) DO NOTHING;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app.document_recipient_rules(), app.resolve_document_targets(uuid), app.document_is_reader(uuid), app.set_document_targets(uuid, jsonb),
  app.set_document_skills(uuid, uuid[]), app.mark_document_viewed(uuid), app.acknowledge_document(uuid, text), app.add_document_recipient(uuid, uuid),
  app.competence_document_evidence(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.document_is_reader(uuid), app.set_document_targets(uuid, jsonb), app.set_document_skills(uuid, uuid[]), app.mark_document_viewed(uuid),
  app.acknowledge_document(uuid, text), app.add_document_recipient(uuid, uuid), app.competence_document_evidence(uuid) TO authenticated;
