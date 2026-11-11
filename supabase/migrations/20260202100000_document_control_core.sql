-- Document control slice DC1 (docs/document-control-plan.md DC1, DC3, DC7, DC9, DC13): document types, documents and their draft revisions, files.
--
--  * document_types: per organisation (seeded: Procedure SOP, Work instruction WI, Form FRM, Specification SPEC, Policy POL, External EXT). Prefix (capitals, digits,
--    hyphen; unique per organisation) is fixed once a document uses the type; own number sequence (`app.document_type_counters`); default review interval in months;
--    a default content kind (a hint only); switched off, never deleted. Written only by `app.save_document_type` (documentation.manage).
--  * documents: the identity (`SOP-001`), separate from its revisions. Number given from the type's sequence, or typed by a manager when bringing an existing document
--    across (unique per organisation ignoring case; a typed `<prefix>-<n>` moves the sequence past it). Content kind `file` | `text` fixed at creation. Owner = an
--    active member. Status draft (never effective yet) -> active (DC2) | withdrawn (DC2) | discarded (its only draft was discarded). `start_letter` is the letter the
--    first submitted revision gets (A, or what was typed); `last_letter` is the last letter given (letters are given at submission, DC2).
--  * document_revisions: sequence 1, 2 …; letter null until submitted; status draft -> in_review -> awaiting_approval -> approved -> effective -> superseded | withdrawn,
--    or discarded (reason). Only draft is used in DC1. One revision in progress per document. Content (change summary, text body) changes only while draft (trigger).
--    A text body is TipTap JSON (an object of type "doc", at most 500 kB) plus its plain text for search, worked out by the database. It is rendered by the editor's
--    own schema in the browser, so no HTML is stored (a deviation from the plan's "sanitised HTML copy", recorded there).
--  * document_revision_files: the main file (file documents, one live per revision) and attachments; private `document-files` bucket at
--    `<org>/document/<revision id>/<uuid>-<name>`; written only while the revision is a draft; removed with a reason, never deleted. A new main file replaces the
--    old one (the old one is removed with the reason "Replaced by …").
-- Reading: an effective-at-some-point document with documentation.read; drafts only by their author, the document's owner and documentation.manage (reviewers and
-- approvers arrive in DC2, restricted documents in DC3). No table writes: SECURITY DEFINER functions only. Errors QM025 (409 document_rule); another organisation's
-- id P0002 (404).

-- ---------------------------------------------------------------------------
-- Document types
-- ---------------------------------------------------------------------------
CREATE TABLE public.document_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  prefix text NOT NULL CHECK (prefix ~ '^[A-Z0-9][A-Z0-9-]{0,9}$'),
  description text CHECK (description IS NULL OR length(btrim(description)) BETWEEN 1 AND 500),
  review_months integer NOT NULL DEFAULT 24 CHECK (review_months BETWEEN 1 AND 120),
  content_hint text NOT NULL DEFAULT 'file' CHECK (content_hint IN ('file', 'text')),
  sequence integer NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT document_types_prefix_key UNIQUE (organisation_id, prefix),
  CONSTRAINT document_types_id_org_key UNIQUE (id, organisation_id)
);
CREATE UNIQUE INDEX document_types_name_key ON public.document_types (organisation_id, lower(btrim(name))) WHERE active;

CREATE TABLE app.document_type_counters (
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  type_id uuid NOT NULL REFERENCES public.document_types (id) ON DELETE CASCADE,
  last_value integer NOT NULL DEFAULT 0,
  PRIMARY KEY (organisation_id, type_id)
);
REVOKE ALL ON app.document_type_counters FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Documents and revisions
-- ---------------------------------------------------------------------------
CREATE TABLE public.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  number text NOT NULL CHECK (length(btrim(number)) BETWEEN 1 AND 40 AND number = btrim(number)),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  type_id uuid NOT NULL,
  content_kind text NOT NULL CHECK (content_kind IN ('file', 'text')),
  description text CHECK (description IS NULL OR length(btrim(description)) BETWEEN 1 AND 1000),
  owner_user_id uuid NOT NULL REFERENCES auth.users (id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'withdrawn', 'discarded')),
  start_letter text NOT NULL DEFAULT 'A' CHECK (start_letter ~ '^[A-Z]{1,3}$'),
  last_letter text CHECK (last_letter IS NULL OR last_letter ~ '^[A-Z]{1,3}$'),
  number_typed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT documents_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT documents_type_fkey FOREIGN KEY (type_id, organisation_id) REFERENCES public.document_types (id, organisation_id)
);
CREATE UNIQUE INDEX documents_number_key ON public.documents (organisation_id, upper(number));
CREATE INDEX documents_type_idx ON public.documents (organisation_id, type_id);

CREATE TABLE public.document_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  document_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 1),
  letter text CHECK (letter IS NULL OR letter ~ '^[A-Z]{1,3}$'),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'in_review', 'awaiting_approval', 'approved', 'effective', 'superseded', 'withdrawn', 'discarded')),
  author_id uuid NOT NULL REFERENCES auth.users (id),
  change_summary text CHECK (change_summary IS NULL OR length(btrim(change_summary)) BETWEEN 1 AND 2000),
  body jsonb CHECK (body IS NULL OR (jsonb_typeof(body) = 'object' AND body ->> 'type' = 'doc' AND pg_column_size(body) <= 512000)),
  body_text text,
  discard_reason text CHECK (discard_reason IS NULL OR length(btrim(discard_reason)) BETWEEN 3 AND 500),
  discarded_at timestamptz,
  discarded_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT document_revisions_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT document_revisions_sequence_key UNIQUE (document_id, sequence),
  CONSTRAINT document_revisions_document_fkey FOREIGN KEY (document_id, organisation_id) REFERENCES public.documents (id, organisation_id),
  CONSTRAINT document_revisions_discard_state_check CHECK ((status = 'discarded') = (discard_reason IS NOT NULL)),
  CONSTRAINT document_revisions_letter_state_check CHECK (status IN ('draft', 'discarded') OR letter IS NOT NULL)
);
CREATE UNIQUE INDEX document_revisions_in_progress_key ON public.document_revisions (document_id)
  WHERE status IN ('draft', 'in_review', 'awaiting_approval', 'approved');
CREATE UNIQUE INDEX document_revisions_letter_key ON public.document_revisions (document_id, letter) WHERE letter IS NOT NULL;
CREATE INDEX document_revisions_org_idx ON public.document_revisions (organisation_id, status);

CREATE TABLE public.document_revision_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  revision_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('main', 'attachment')),
  storage_path text NOT NULL,
  file_name text NOT NULL CHECK (length(btrim(file_name)) BETWEEN 1 AND 255),
  content_type text,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 52428800),
  deleted_at timestamptz,
  deleted_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  delete_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT document_revision_files_revision_fkey FOREIGN KEY (revision_id, organisation_id) REFERENCES public.document_revisions (id, organisation_id),
  -- A later revision may point at a file stored under an earlier revision's folder (copied forward, DC2), so the path is unique per revision only.
  CONSTRAINT document_revision_files_path_key UNIQUE (revision_id, storage_path),
  CONSTRAINT document_revision_files_path CHECK (storage_path LIKE organisation_id::text || '/document/%/%' AND storage_path NOT LIKE '%..%'),
  CONSTRAINT document_revision_files_deleted_check CHECK ((deleted_at IS NULL) = (delete_reason IS NULL))
);
CREATE UNIQUE INDEX document_revision_files_main_key ON public.document_revision_files (revision_id) WHERE role = 'main' AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Rules held by triggers (so SQL run by the operator is held to them too)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.document_type_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A document type is never deleted. Switch it off instead.' USING ERRCODE = 'QM025'; END IF;
  IF NEW.prefix <> OLD.prefix AND EXISTS (SELECT 1 FROM public.documents d WHERE d.type_id = OLD.id) THEN
    RAISE EXCEPTION 'The prefix % is used by documents and cannot change', OLD.prefix USING ERRCODE = 'QM025';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_types_rules BEFORE UPDATE OR DELETE ON public.document_types FOR EACH ROW EXECUTE FUNCTION app.document_type_rules();

CREATE FUNCTION app.document_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A document is never deleted. Withdraw it with a reason.' USING ERRCODE = 'QM025'; END IF;
  IF NEW.number <> OLD.number OR NEW.type_id <> OLD.type_id OR NEW.content_kind <> OLD.content_kind THEN
    RAISE EXCEPTION 'A document''s number, type and content kind never change' USING ERRCODE = 'QM025';
  END IF;
  IF OLD.status = 'discarded' THEN RAISE EXCEPTION '% was discarded and cannot be changed', OLD.number USING ERRCODE = 'QM025'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER documents_rules BEFORE UPDATE OR DELETE ON public.documents FOR EACH ROW EXECUTE FUNCTION app.document_rules();

CREATE FUNCTION app.document_revision_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A revision is never deleted. Discard a draft with a reason.' USING ERRCODE = 'QM025'; END IF;
  IF (NEW.document_id, NEW.sequence, NEW.author_id) IS DISTINCT FROM (OLD.document_id, OLD.sequence, OLD.author_id) THEN
    RAISE EXCEPTION 'A revision''s document, sequence and author never change' USING ERRCODE = 'QM025';
  END IF;
  IF OLD.letter IS NOT NULL AND NEW.letter IS DISTINCT FROM OLD.letter THEN RAISE EXCEPTION 'A revision letter never changes' USING ERRCODE = 'QM025'; END IF;
  IF OLD.status <> 'draft' AND (NEW.change_summary, NEW.body, NEW.body_text) IS DISTINCT FROM (OLD.change_summary, OLD.body, OLD.body_text) THEN
    RAISE EXCEPTION 'Only a draft''s content can change' USING ERRCODE = 'QM025';
  END IF;
  IF OLD.status = 'discarded' THEN RAISE EXCEPTION 'A discarded revision cannot be changed' USING ERRCODE = 'QM025'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_revisions_rules BEFORE UPDATE OR DELETE ON public.document_revisions FOR EACH ROW EXECUTE FUNCTION app.document_revision_rules();

CREATE FUNCTION app.document_file_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Files are never deleted' USING ERRCODE = 'QM025'; END IF;
  SELECT status INTO v_status FROM public.document_revisions WHERE id = coalesce(NEW.revision_id, OLD.revision_id);
  IF v_status IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'Files change only while the revision is a draft' USING ERRCODE = 'QM025'; END IF;
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - ARRAY['deleted_at', 'deleted_by', 'delete_reason', 'updated_at', 'updated_by'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['deleted_at', 'deleted_by', 'delete_reason', 'updated_at', 'updated_by']) THEN
    RAISE EXCEPTION 'A file cannot be changed, only removed or restored' USING ERRCODE = 'QM025';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_revision_files_rules BEFORE INSERT OR UPDATE OR DELETE ON public.document_revision_files FOR EACH ROW EXECUTE FUNCTION app.document_file_rules();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['document_types', 'documents', 'document_revisions', 'document_revision_files'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION app.stamp_created()', t || '_stamp', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.touch_updated()', t || '_touch', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change()', t || '_org_immutable', t);
    EXECUTE format('CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION audit.record_change(''organisation_id'')', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Reading
-- ---------------------------------------------------------------------------
-- A revision's content (and its files) can be read by: documentation.manage; its author; the document's owner; and, once it has been approved, anyone with
-- documentation.read. (Reviewers and approvers: DC2. Restricted documents: DC3.)
CREATE FUNCTION app.document_revision_readable(p_revision uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.document_revisions r JOIN public.documents d ON d.id = r.document_id
     WHERE r.id = p_revision AND app.is_member(r.organisation_id)
       AND (app.has_permission(r.organisation_id, 'documentation.manage')
            OR r.author_id = auth.uid() OR d.owner_user_id = auth.uid()
            OR (r.status IN ('approved', 'effective', 'superseded', 'withdrawn') AND app.has_permission(r.organisation_id, 'documentation.read'))))
$$;
-- A document can be read by documentation.manage, its owner, the author of one of its revisions, and, once it has been in force, documentation.read.
CREATE FUNCTION app.document_readable(p_document uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.documents d
     WHERE d.id = p_document AND app.is_member(d.organisation_id)
       AND (app.has_permission(d.organisation_id, 'documentation.manage') OR d.owner_user_id = auth.uid()
            OR (d.status IN ('active', 'withdrawn') AND app.has_permission(d.organisation_id, 'documentation.read'))
            OR EXISTS (SELECT 1 FROM public.document_revisions r WHERE r.document_id = d.id AND r.author_id = auth.uid())))
$$;

ALTER TABLE public.document_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_revision_files ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.document_types, public.documents, public.document_revisions, public.document_revision_files FROM anon, authenticated;
GRANT SELECT ON public.document_types, public.documents, public.document_revisions, public.document_revision_files TO authenticated;
CREATE POLICY document_types_select ON public.document_types FOR SELECT TO authenticated USING (app.has_permission(organisation_id, 'documentation.read'));
CREATE POLICY documents_select ON public.documents FOR SELECT TO authenticated USING (app.document_readable(id));
CREATE POLICY document_revisions_select ON public.document_revisions FOR SELECT TO authenticated USING (app.document_revision_readable(id));
CREATE POLICY document_revision_files_select ON public.document_revision_files FOR SELECT TO authenticated USING (app.document_revision_readable(revision_id));

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.assert_document_manager(p_organisation_id uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT app.is_member(p_organisation_id) THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(p_organisation_id, 'documentation.manage') THEN RAISE EXCEPTION 'You are not allowed to manage documents' USING ERRCODE = '42501'; END IF;
END $$;

-- The letter after `p` in A, B … Z, AA, AB … ZZ, AAA (bijective base 26). NULL gives A.
CREATE FUNCTION app.document_letter_after(p text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE n integer := 0; i integer; v text := '';
BEGIN
  IF p IS NULL THEN RETURN 'A'; END IF;
  FOR i IN 1 .. length(p) LOOP n := n * 26 + (ascii(substr(p, i, 1)) - 64); END LOOP;
  n := n + 1;
  WHILE n > 0 LOOP
    v := chr(65 + ((n - 1) % 26)) || v;
    n := (n - 1) / 26;
  END LOOP;
  RETURN v;
END $$;

-- The next free number of a type: `<prefix>-NNN`, skipping numbers already typed by hand.
CREATE FUNCTION app.next_document_number(p_organisation_id uuid, p_type uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_prefix text; v_n integer; v_number text;
BEGIN
  SELECT prefix INTO v_prefix FROM public.document_types WHERE id = p_type AND organisation_id = p_organisation_id;
  LOOP
    INSERT INTO app.document_type_counters AS c (organisation_id, type_id, last_value) VALUES (p_organisation_id, p_type, 1)
    ON CONFLICT (organisation_id, type_id) DO UPDATE SET last_value = c.last_value + 1 RETURNING last_value INTO v_n;
    v_number := v_prefix || '-' || lpad(v_n::text, 3, '0');
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.documents WHERE organisation_id = p_organisation_id AND upper(number) = upper(v_number));
  END LOOP;
  RETURN v_number;
END $$;

-- Plain text of a TipTap document, for search: every text node in order, blocks separated by a space.
CREATE FUNCTION app.document_body_text(p_body jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT nullif(btrim(regexp_replace(coalesce(string_agg(t #>> '{}', ' '), ''), '\s+', ' ', 'g')), '')
    FROM jsonb_path_query(p_body, 'strict $.**.text') AS t
   WHERE jsonb_typeof(t) = 'string'
$$;

-- ---------------------------------------------------------------------------
-- Document types
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.seed_document_types(p_organisation_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO public.document_types (organisation_id, name, prefix, review_months, content_hint, sequence) VALUES
    (p_organisation_id, 'Procedure',        'SOP',  24, 'text', 1),
    (p_organisation_id, 'Work instruction', 'WI',   24, 'text', 2),
    (p_organisation_id, 'Form',             'FRM',  36, 'file', 3),
    (p_organisation_id, 'Specification',    'SPEC', 36, 'file', 4),
    (p_organisation_id, 'Policy',           'POL',  12, 'text', 5),
    (p_organisation_id, 'External',         'EXT',  12, 'file', 6)
  ON CONFLICT (organisation_id, prefix) DO NOTHING
$$;
CREATE FUNCTION app.seed_document_types_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.seed_document_types(NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER organisations_seed_document_types AFTER INSERT ON public.organisations FOR EACH ROW EXECUTE FUNCTION app.seed_document_types_trg();
SELECT app.seed_document_types(o.id) FROM public.organisations o;

-- Creates (p_id null) or changes a type. Keys present are set: name, prefix, description, reviewMonths, contentHint, sequence, active.
CREATE FUNCTION app.save_document_type(p_organisation_id uuid, p_data jsonb, p_id uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE t public.document_types; k text; v_id uuid;
BEGIN
  PERFORM app.assert_document_manager(p_organisation_id);
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Send the type as an object' USING ERRCODE = 'QM025'; END IF;
  FOR k IN SELECT jsonb_object_keys(p_data) LOOP
    IF k NOT IN ('name', 'prefix', 'description', 'reviewMonths', 'contentHint', 'sequence', 'active') THEN RAISE EXCEPTION 'Unknown field %', k USING ERRCODE = 'QM025'; END IF;
  END LOOP;
  IF p_id IS NOT NULL THEN
    SELECT * INTO t FROM public.document_types WHERE id = p_id AND organisation_id = p_organisation_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Document type not found' USING ERRCODE = 'P0002'; END IF;
  ELSE
    t.review_months := 24; t.content_hint := 'file'; t.active := true;
    SELECT coalesce(max(sequence), 0) + 1 INTO t.sequence FROM public.document_types WHERE organisation_id = p_organisation_id;
  END IF;
  IF p_data ? 'name' THEN t.name := btrim(coalesce(p_data ->> 'name', '')); END IF;
  IF p_data ? 'prefix' THEN t.prefix := upper(btrim(coalesce(p_data ->> 'prefix', ''))); END IF;
  IF p_data ? 'description' THEN t.description := nullif(btrim(coalesce(p_data ->> 'description', '')), ''); END IF;
  IF p_data ? 'reviewMonths' THEN t.review_months := (p_data ->> 'reviewMonths')::integer; END IF;
  IF p_data ? 'contentHint' THEN t.content_hint := p_data ->> 'contentHint'; END IF;
  IF p_data ? 'sequence' THEN t.sequence := (p_data ->> 'sequence')::integer; END IF;
  IF p_data ? 'active' THEN t.active := (p_data ->> 'active')::boolean; END IF;
  IF t.name IS NULL OR length(t.name) = 0 OR length(t.name) > 80 THEN RAISE EXCEPTION 'Give the type a name (up to 80 characters)' USING ERRCODE = 'QM025'; END IF;
  IF t.prefix IS NULL OR t.prefix !~ '^[A-Z0-9][A-Z0-9-]{0,9}$' THEN
    RAISE EXCEPTION 'The prefix is 1 to 10 capital letters, digits or hyphens, starting with a letter or digit' USING ERRCODE = 'QM025';
  END IF;
  IF t.review_months IS NULL OR t.review_months NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION 'The review interval is 1 to 120 months' USING ERRCODE = 'QM025'; END IF;
  IF t.content_hint IS NULL OR t.content_hint NOT IN ('file', 'text') THEN RAISE EXCEPTION 'The usual content is a file or text' USING ERRCODE = 'QM025'; END IF;
  IF EXISTS (SELECT 1 FROM public.document_types WHERE organisation_id = p_organisation_id AND prefix = t.prefix AND id IS DISTINCT FROM p_id) THEN
    RAISE EXCEPTION 'Another type already uses the prefix %', t.prefix USING ERRCODE = 'QM025';
  END IF;
  IF t.active AND EXISTS (SELECT 1 FROM public.document_types WHERE organisation_id = p_organisation_id AND active AND lower(btrim(name)) = lower(t.name) AND id IS DISTINCT FROM p_id) THEN
    RAISE EXCEPTION 'Another type is already called %', t.name USING ERRCODE = 'QM025';
  END IF;
  IF p_id IS NULL THEN
    INSERT INTO public.document_types (organisation_id, name, prefix, description, review_months, content_hint, sequence, active)
    VALUES (p_organisation_id, t.name, t.prefix, t.description, t.review_months, t.content_hint, t.sequence, t.active) RETURNING id INTO v_id;
    RETURN v_id;
  END IF;
  UPDATE public.document_types SET name = t.name, prefix = t.prefix, description = t.description, review_months = t.review_months, content_hint = t.content_hint,
    sequence = t.sequence, active = t.active WHERE id = p_id;
  RETURN p_id;
END $$;

-- ---------------------------------------------------------------------------
-- Documents
-- ---------------------------------------------------------------------------
-- Creates a document and its first draft revision. Keys: typeId, title, contentKind, description, ownerId (default: the caller), number and startLetter (typed when
-- bringing an existing document across: both or neither). Returns the document id.
CREATE FUNCTION app.create_document(p_organisation_id uuid, p_data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE k text; v_type public.document_types%ROWTYPE; v_title text := btrim(coalesce(p_data ->> 'title', ''));
  v_kind text := p_data ->> 'contentKind'; v_owner uuid := coalesce(nullif(p_data ->> 'ownerId', '')::uuid, auth.uid());
  v_number text := nullif(btrim(coalesce(p_data ->> 'number', '')), ''); v_letter text := upper(nullif(btrim(coalesce(p_data ->> 'startLetter', '')), ''));
  v_desc text := nullif(btrim(coalesce(p_data ->> 'description', '')), ''); v_id uuid; v_n integer;
BEGIN
  PERFORM app.assert_document_manager(p_organisation_id);
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Send the document as an object' USING ERRCODE = 'QM025'; END IF;
  FOR k IN SELECT jsonb_object_keys(p_data) LOOP
    IF k NOT IN ('typeId', 'title', 'contentKind', 'description', 'ownerId', 'number', 'startLetter') THEN RAISE EXCEPTION 'Unknown field %', k USING ERRCODE = 'QM025'; END IF;
  END LOOP;
  SELECT * INTO v_type FROM public.document_types WHERE id = nullif(p_data ->> 'typeId', '')::uuid AND organisation_id = p_organisation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Choose a document type' USING ERRCODE = 'QM025'; END IF;
  IF NOT v_type.active THEN RAISE EXCEPTION 'The type % is switched off', v_type.name USING ERRCODE = 'QM025'; END IF;
  IF length(v_title) = 0 OR length(v_title) > 200 THEN RAISE EXCEPTION 'Give the document a title (up to 200 characters)' USING ERRCODE = 'QM025'; END IF;
  IF v_kind IS NULL OR v_kind NOT IN ('file', 'text') THEN RAISE EXCEPTION 'Say whether the document is a file or written here as text' USING ERRCODE = 'QM025'; END IF;
  IF v_desc IS NOT NULL AND length(v_desc) > 1000 THEN RAISE EXCEPTION 'The description is up to 1000 characters' USING ERRCODE = 'QM025'; END IF;
  IF NOT app.is_active_member_user(p_organisation_id, v_owner) THEN RAISE EXCEPTION 'The owner must be an active member of this organisation' USING ERRCODE = 'QM025'; END IF;
  IF (v_number IS NULL) <> (v_letter IS NULL) THEN
    RAISE EXCEPTION 'When bringing a document across, give both its number and its current revision letter' USING ERRCODE = 'QM025';
  END IF;
  IF v_number IS NOT NULL THEN
    IF length(v_number) > 40 THEN RAISE EXCEPTION 'The number is up to 40 characters' USING ERRCODE = 'QM025'; END IF;
    IF v_letter !~ '^[A-Z]{1,3}$' THEN RAISE EXCEPTION 'The revision letter is 1 to 3 letters (A, B … AA)' USING ERRCODE = 'QM025'; END IF;
    IF EXISTS (SELECT 1 FROM public.documents WHERE organisation_id = p_organisation_id AND upper(number) = upper(v_number)) THEN
      RAISE EXCEPTION 'A document numbered % already exists', v_number USING ERRCODE = 'QM025';
    END IF;
    -- A typed `<prefix>-<n>` moves the type's sequence past it, so the next numbered document does not collide.
    IF upper(v_number) ~ ('^' || v_type.prefix || '-[0-9]{1,9}$') THEN
      v_n := substr(v_number, length(v_type.prefix) + 2)::integer;
      INSERT INTO app.document_type_counters AS c (organisation_id, type_id, last_value) VALUES (p_organisation_id, v_type.id, v_n)
      ON CONFLICT (organisation_id, type_id) DO UPDATE SET last_value = greatest(c.last_value, excluded.last_value);
    END IF;
  ELSE
    v_number := app.next_document_number(p_organisation_id, v_type.id);
  END IF;
  INSERT INTO public.documents (organisation_id, number, title, type_id, content_kind, description, owner_user_id, start_letter, number_typed)
  VALUES (p_organisation_id, v_number, v_title, v_type.id, v_kind, v_desc, v_owner, coalesce(v_letter, 'A'), v_letter IS NOT NULL)
  RETURNING id INTO v_id;
  INSERT INTO public.document_revisions (organisation_id, document_id, sequence, author_id) VALUES (p_organisation_id, v_id, 1, auth.uid());
  RETURN v_id;
END $$;

-- Changes a document's header: title, description, ownerId (keys present are set).
CREATE FUNCTION app.update_document(p_id uuid, p_data jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE d public.documents%ROWTYPE; k text;
BEGIN
  SELECT * INTO d FROM public.documents WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(d.organisation_id) THEN RAISE EXCEPTION 'Document not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_document_manager(d.organisation_id);
  IF d.status = 'discarded' THEN RAISE EXCEPTION '% was discarded and cannot be changed', d.number USING ERRCODE = 'QM025'; END IF;
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Send the changes as an object' USING ERRCODE = 'QM025'; END IF;
  FOR k IN SELECT jsonb_object_keys(p_data) LOOP
    IF k NOT IN ('title', 'description', 'ownerId') THEN RAISE EXCEPTION 'Unknown field % (the number, type and content kind never change)', k USING ERRCODE = 'QM025'; END IF;
  END LOOP;
  IF p_data ? 'title' THEN d.title := btrim(coalesce(p_data ->> 'title', '')); END IF;
  IF p_data ? 'description' THEN d.description := nullif(btrim(coalesce(p_data ->> 'description', '')), ''); END IF;
  IF p_data ? 'ownerId' THEN d.owner_user_id := nullif(p_data ->> 'ownerId', '')::uuid; END IF;
  IF length(d.title) = 0 OR length(d.title) > 200 THEN RAISE EXCEPTION 'Give the document a title (up to 200 characters)' USING ERRCODE = 'QM025'; END IF;
  IF d.description IS NOT NULL AND length(d.description) > 1000 THEN RAISE EXCEPTION 'The description is up to 1000 characters' USING ERRCODE = 'QM025'; END IF;
  IF d.owner_user_id IS NULL OR NOT app.is_active_member_user(d.organisation_id, d.owner_user_id) THEN
    RAISE EXCEPTION 'The owner must be an active member of this organisation' USING ERRCODE = 'QM025';
  END IF;
  UPDATE public.documents SET title = d.title, description = d.description, owner_user_id = d.owner_user_id WHERE id = d.id;
END $$;

-- Loads and locks a draft revision for a change by its author or a document manager.
CREATE FUNCTION app.document_draft_for_update(p_revision uuid) RETURNS public.document_revisions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.document_revisions%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.document_revisions WHERE id = p_revision FOR UPDATE;
  IF NOT FOUND OR NOT app.document_revision_readable(r.id) THEN RAISE EXCEPTION 'Revision not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(r.organisation_id, 'documentation.manage') THEN RAISE EXCEPTION 'You are not allowed to change this draft' USING ERRCODE = '42501'; END IF;
  IF r.status <> 'draft' THEN RAISE EXCEPTION 'Only a draft can be changed (this revision is %)', replace(r.status, '_', ' ') USING ERRCODE = 'QM025'; END IF;
  RETURN r;
END $$;

-- Changes a draft: changeSummary, body (text documents only; a TipTap document object or null). Keys present are set.
CREATE FUNCTION app.update_document_revision(p_revision uuid, p_data jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.document_revisions; v_kind text; k text; v_summary text; v_body jsonb;
BEGIN
  r := app.document_draft_for_update(p_revision);
  SELECT content_kind INTO v_kind FROM public.documents WHERE id = r.document_id;
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Send the changes as an object' USING ERRCODE = 'QM025'; END IF;
  FOR k IN SELECT jsonb_object_keys(p_data) LOOP
    IF k NOT IN ('changeSummary', 'body') THEN RAISE EXCEPTION 'Unknown field %', k USING ERRCODE = 'QM025'; END IF;
  END LOOP;
  v_summary := r.change_summary; v_body := r.body;
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
  UPDATE public.document_revisions SET change_summary = v_summary, body = v_body, body_text = app.document_body_text(v_body) WHERE id = r.id;
END $$;

-- Discards a draft with a reason. Discarding the only revision of a document that was never in force discards the document (its number is kept, never reused).
CREATE FUNCTION app.discard_document_revision(p_revision uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.document_revisions; v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  r := app.document_draft_for_update(p_revision);
  IF length(v_reason) < 3 THEN RAISE EXCEPTION 'Say why the draft is discarded (at least 3 characters)' USING ERRCODE = 'QM025'; END IF;
  UPDATE public.document_revisions SET status = 'discarded', discard_reason = left(v_reason, 500), discarded_at = now(), discarded_by = auth.uid() WHERE id = r.id;
  UPDATE public.documents d SET status = 'discarded' WHERE d.id = r.document_id AND d.status = 'draft'
     AND NOT EXISTS (SELECT 1 FROM public.document_revisions x WHERE x.document_id = d.id AND x.status <> 'discarded');
END $$;

-- ---------------------------------------------------------------------------
-- Files (uploaded first into `<org>/document/<revision id>/...`)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.add_document_file(p_revision uuid, p_role text, p_storage_path text, p_file_name text, p_content_type text, p_size_bytes bigint) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.document_revisions; v_kind text; v_id uuid; v_name text := btrim(coalesce(p_file_name, ''));
BEGIN
  r := app.document_draft_for_update(p_revision);
  SELECT content_kind INTO v_kind FROM public.documents WHERE id = r.document_id;
  IF p_role IS NULL OR p_role NOT IN ('main', 'attachment') THEN RAISE EXCEPTION 'A file is the main file or an attachment' USING ERRCODE = 'QM025'; END IF;
  IF p_role = 'main' AND v_kind <> 'file' THEN RAISE EXCEPTION 'A text document has no main file; add it as an attachment' USING ERRCODE = 'QM025'; END IF;
  IF p_storage_path IS NULL OR p_storage_path NOT LIKE r.organisation_id::text || '/document/' || r.id::text || '/%' OR p_storage_path LIKE '%..%' THEN
    RAISE EXCEPTION 'The file must be stored in this revision''s folder' USING ERRCODE = 'QM025';
  END IF;
  IF length(v_name) = 0 THEN RAISE EXCEPTION 'The file needs a name' USING ERRCODE = 'QM025'; END IF;
  IF p_role = 'main' THEN
    UPDATE public.document_revision_files SET deleted_at = now(), deleted_by = auth.uid(), delete_reason = left('Replaced by ' || v_name, 500)
     WHERE revision_id = r.id AND role = 'main' AND deleted_at IS NULL;
  END IF;
  INSERT INTO public.document_revision_files (organisation_id, revision_id, role, storage_path, file_name, content_type, size_bytes)
  VALUES (r.organisation_id, r.id, p_role, p_storage_path, left(v_name, 255), p_content_type, p_size_bytes)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION app.remove_document_file(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE f public.document_revision_files%ROWTYPE;
BEGIN
  SELECT * INTO f FROM public.document_revision_files WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT app.document_revision_readable(f.revision_id) THEN RAISE EXCEPTION 'File not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.document_draft_for_update(f.revision_id);
  IF f.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'That file is already removed' USING ERRCODE = 'QM025'; END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 3 THEN RAISE EXCEPTION 'Say why the file is removed (at least 3 characters)' USING ERRCODE = 'QM025'; END IF;
  UPDATE public.document_revision_files SET deleted_at = now(), deleted_by = auth.uid(), delete_reason = left(btrim(p_reason), 500) WHERE id = f.id;
END $$;

CREATE FUNCTION app.restore_document_file(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE f public.document_revision_files%ROWTYPE;
BEGIN
  SELECT * INTO f FROM public.document_revision_files WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT app.document_revision_readable(f.revision_id) THEN RAISE EXCEPTION 'File not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.document_draft_for_update(f.revision_id);
  IF f.deleted_at IS NULL THEN RAISE EXCEPTION 'That file is not removed' USING ERRCODE = 'QM025'; END IF;
  IF f.role = 'main' AND EXISTS (SELECT 1 FROM public.document_revision_files WHERE revision_id = f.revision_id AND role = 'main' AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'The revision already has a main file. Remove it first.' USING ERRCODE = 'QM025';
  END IF;
  UPDATE public.document_revision_files SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL WHERE id = f.id;
END $$;

-- ---------------------------------------------------------------------------
-- Storage: <org>/document/<revision id>/<uuid>-<name>. Read by whoever may read the revision; uploads by a document manager into a draft only; never updated or deleted.
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public) VALUES ('document-files', 'document-files', false)
ON CONFLICT (id) DO NOTHING;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'storage' AND table_name = 'buckets' AND column_name = 'file_size_limit') THEN
    EXECUTE $q$UPDATE storage.buckets SET file_size_limit = 52428800 WHERE id = 'document-files'$q$;
  END IF;
END $$;

CREATE FUNCTION app.document_file_allowed(p_object_name text, p_upload boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT split_part(p_object_name, '/', 2) = 'document' AND EXISTS (
    SELECT 1 FROM public.document_revisions r
     WHERE r.id = app.try_uuid(split_part(p_object_name, '/', 3)) AND r.organisation_id = app.try_uuid(split_part(p_object_name, '/', 1))
       AND app.document_revision_readable(r.id)
       AND (NOT p_upload OR (r.status = 'draft' AND app.has_permission(r.organisation_id, 'documentation.manage'))))
$$;
CREATE POLICY document_files_select ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'document-files' AND app.document_file_allowed(name, false));
CREATE POLICY document_files_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'document-files' AND app.document_file_allowed(name, true));

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app.document_type_rules(), app.document_rules(), app.document_revision_rules(), app.document_file_rules(),
  app.document_revision_readable(uuid), app.document_readable(uuid), app.assert_document_manager(uuid), app.document_letter_after(text),
  app.next_document_number(uuid, uuid), app.document_body_text(jsonb), app.seed_document_types(uuid), app.seed_document_types_trg(),
  app.save_document_type(uuid, jsonb, uuid), app.create_document(uuid, jsonb), app.update_document(uuid, jsonb), app.document_draft_for_update(uuid),
  app.update_document_revision(uuid, jsonb), app.discard_document_revision(uuid, text),
  app.add_document_file(uuid, text, text, text, text, bigint), app.remove_document_file(uuid, text), app.restore_document_file(uuid),
  app.document_file_allowed(text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.document_revision_readable(uuid), app.document_readable(uuid), app.document_letter_after(text),
  app.save_document_type(uuid, jsonb, uuid), app.create_document(uuid, jsonb), app.update_document(uuid, jsonb),
  app.update_document_revision(uuid, jsonb), app.discard_document_revision(uuid, text),
  app.add_document_file(uuid, text, text, text, text, bigint), app.remove_document_file(uuid, text), app.restore_document_file(uuid),
  app.document_file_allowed(text, boolean) TO authenticated;
