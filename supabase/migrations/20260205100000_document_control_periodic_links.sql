-- Document control slice DC4 (docs/document-control-plan.md DC5, DC6, DC11): periodic review, change requests, and links to where work happens.
--
--  * Periodic review: each type has an interval in months, a document may override it (`documents.review_months`). `documents.next_review_on` is set
--    when a revision takes effect (effective date + interval) and after a review that needed no change (that day + interval); empty while the
--    document is not in force. A review is recorded once by `app.record_document_review(document, outcome, note)` (documentation.manage) in the
--    append-only `document_periodic_reviews`: "no change needed" (note required) or "revision started" (starts a draft from the revision in force).
--    Overdue is worked out on read (next review date before today).
--  * Change requests (`document_change_requests`, `DCR-YY-NNNN`): anyone who may read the document asks for a change (what, why); a document manager
--    accepts it (a new draft is started, or the draft already in progress is used, and the request points at it) or declines it with a reason;
--    the person who asked may withdraw it while it is open. Readable by the person who asked and by document managers. The person who asked is told
--    when it is accepted or declined (notice `document_change_requests.updated`, addressed to them).
--  * Links (`document_links`): parts, part families, machines and operation codes the document applies to, replaced as a whole by
--    `app.set_document_links` (documentation.manage). The API lists the documents in force for a part (and its family), machine or operation where
--    work happens; information only.
-- No table writes: SECURITY DEFINER functions only. Errors QM025 (409 document_rule); another organisation's id P0002 (404).

-- ---------------------------------------------------------------------------
-- Periodic review
-- ---------------------------------------------------------------------------
ALTER TABLE public.documents
  ADD COLUMN review_months integer CHECK (review_months IS NULL OR review_months BETWEEN 1 AND 120),
  ADD COLUMN next_review_on date;
CREATE INDEX documents_next_review_idx ON public.documents (organisation_id, next_review_on) WHERE status = 'active';

-- The interval that applies: the document's own, else its type's.
CREATE FUNCTION app.document_review_months(p_document uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(d.review_months, t.review_months) FROM public.documents d JOIN public.document_types t ON t.id = d.type_id WHERE d.id = p_document
$$;

CREATE TABLE public.document_periodic_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  document_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('no_change', 'revision_started')),
  note text CHECK (note IS NULL OR length(btrim(note)) BETWEEN 3 AND 2000),
  started_revision_id uuid,
  was_due_on date,
  next_review_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT document_periodic_reviews_document_fkey FOREIGN KEY (document_id, organisation_id) REFERENCES public.documents (id, organisation_id),
  CONSTRAINT document_periodic_reviews_revision_fkey FOREIGN KEY (revision_id, organisation_id) REFERENCES public.document_revisions (id, organisation_id),
  CONSTRAINT document_periodic_reviews_started_fkey FOREIGN KEY (started_revision_id, organisation_id) REFERENCES public.document_revisions (id, organisation_id),
  CONSTRAINT document_periodic_reviews_outcome_state_check CHECK ((outcome = 'no_change' AND note IS NOT NULL AND started_revision_id IS NULL) OR (outcome = 'revision_started' AND started_revision_id IS NOT NULL))
);
CREATE INDEX document_periodic_reviews_document_idx ON public.document_periodic_reviews (document_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Change requests
-- ---------------------------------------------------------------------------
CREATE TABLE app.document_change_request_counters (
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  year integer NOT NULL,
  last_value integer NOT NULL DEFAULT 0,
  PRIMARY KEY (organisation_id, year)
);
REVOKE ALL ON app.document_change_request_counters FROM PUBLIC, anon, authenticated;

CREATE TABLE public.document_change_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  reference text NOT NULL,
  document_id uuid NOT NULL,
  what text NOT NULL CHECK (length(btrim(what)) BETWEEN 3 AND 2000),
  why text NOT NULL CHECK (length(btrim(why)) BETWEEN 3 AND 2000),
  requested_by uuid NOT NULL REFERENCES auth.users (id),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'declined', 'withdrawn')),
  revision_id uuid,
  decision_reason text CHECK (decision_reason IS NULL OR length(btrim(decision_reason)) BETWEEN 3 AND 1000),
  decided_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT document_change_requests_reference_key UNIQUE (organisation_id, reference),
  CONSTRAINT document_change_requests_document_fkey FOREIGN KEY (document_id, organisation_id) REFERENCES public.documents (id, organisation_id),
  CONSTRAINT document_change_requests_revision_fkey FOREIGN KEY (revision_id, organisation_id) REFERENCES public.document_revisions (id, organisation_id),
  CONSTRAINT document_change_requests_state_check CHECK (
    (status = 'open' AND revision_id IS NULL AND decided_at IS NULL)
    OR (status = 'accepted' AND revision_id IS NOT NULL AND decided_at IS NOT NULL)
    OR (status = 'declined' AND decision_reason IS NOT NULL AND decided_at IS NOT NULL)
    OR (status = 'withdrawn' AND decided_at IS NOT NULL))
);
CREATE INDEX document_change_requests_document_idx ON public.document_change_requests (document_id, status);
CREATE INDEX document_change_requests_requester_idx ON public.document_change_requests (organisation_id, requested_by);

-- ---------------------------------------------------------------------------
-- Links: where the document applies
-- ---------------------------------------------------------------------------
CREATE TABLE public.document_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  document_id uuid NOT NULL,
  part_id uuid,
  part_family_id uuid,
  machine_id uuid,
  operation_code text CHECK (operation_code IS NULL OR (length(btrim(operation_code)) BETWEEN 1 AND 40 AND operation_code = btrim(operation_code))),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT document_links_document_fkey FOREIGN KEY (document_id, organisation_id) REFERENCES public.documents (id, organisation_id),
  CONSTRAINT document_links_part_fkey FOREIGN KEY (part_id, organisation_id) REFERENCES public.parts (id, organisation_id),
  CONSTRAINT document_links_family_fkey FOREIGN KEY (part_family_id, organisation_id) REFERENCES public.part_families (id, organisation_id),
  CONSTRAINT document_links_machine_fkey FOREIGN KEY (machine_id, organisation_id) REFERENCES public.machines (id, organisation_id),
  CONSTRAINT document_links_one CHECK (num_nonnulls(part_id, part_family_id, machine_id, operation_code) = 1)
);
CREATE UNIQUE INDEX document_links_once_key ON public.document_links (document_id, coalesce(part_id::text, part_family_id::text, machine_id::text, 'op:' || upper(operation_code)));
CREATE INDEX document_links_part_idx ON public.document_links (part_id) WHERE part_id IS NOT NULL;
CREATE INDEX document_links_family_idx ON public.document_links (part_family_id) WHERE part_family_id IS NOT NULL;
CREATE INDEX document_links_machine_idx ON public.document_links (machine_id) WHERE machine_id IS NOT NULL;
CREATE INDEX document_links_operation_idx ON public.document_links (organisation_id, upper(operation_code)) WHERE operation_code IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Rules held by triggers
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.document_review_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'A periodic review is recorded once and never changed or deleted' USING ERRCODE = 'QM025';
END $$;
CREATE TRIGGER document_periodic_reviews_frozen BEFORE UPDATE OR DELETE ON public.document_periodic_reviews FOR EACH ROW EXECUTE FUNCTION app.document_review_frozen();

CREATE FUNCTION app.document_change_request_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A change request is never deleted' USING ERRCODE = 'QM025'; END IF;
  IF (NEW.reference, NEW.document_id, NEW.what, NEW.why, NEW.requested_by) IS DISTINCT FROM (OLD.reference, OLD.document_id, OLD.what, OLD.why, OLD.requested_by) THEN
    RAISE EXCEPTION 'A change request''s wording never changes' USING ERRCODE = 'QM025';
  END IF;
  IF OLD.status <> 'open' THEN RAISE EXCEPTION 'A % change request is final', OLD.status USING ERRCODE = 'QM025'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_change_requests_rules BEFORE UPDATE OR DELETE ON public.document_change_requests FOR EACH ROW EXECUTE FUNCTION app.document_change_request_rules();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['document_periodic_reviews', 'document_change_requests', 'document_links'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION app.stamp_created()', t || '_stamp', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.touch_updated()', t || '_touch', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change()', t || '_org_immutable', t);
    EXECUTE format('CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION audit.record_change(''organisation_id'')', t);
  END LOOP;
END $$;

ALTER TABLE public.document_periodic_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_change_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.document_periodic_reviews, public.document_change_requests, public.document_links FROM anon, authenticated;
GRANT SELECT ON public.document_periodic_reviews, public.document_change_requests, public.document_links TO authenticated;
CREATE POLICY document_periodic_reviews_select ON public.document_periodic_reviews FOR SELECT TO authenticated USING (app.document_readable(document_id));
CREATE POLICY document_links_select ON public.document_links FOR SELECT TO authenticated USING (app.document_readable(document_id));
CREATE POLICY document_change_requests_select ON public.document_change_requests FOR SELECT TO authenticated
  USING ((requested_by = (SELECT auth.uid()) AND app.is_member(organisation_id)) OR app.has_permission(organisation_id, 'documentation.manage'));

-- ---------------------------------------------------------------------------
-- Header changes (replaces DC3's): adds reviewMonths (null = the type's interval); a change moves the next review date
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.update_document(p_id uuid, p_data jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE d public.documents%ROWTYPE; k text; v_from date;
BEGIN
  SELECT * INTO d FROM public.documents WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(d.organisation_id) THEN RAISE EXCEPTION 'Document not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_document_manager(d.organisation_id);
  IF d.status = 'discarded' THEN RAISE EXCEPTION '% was discarded and cannot be changed', d.number USING ERRCODE = 'QM025'; END IF;
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Send the changes as an object' USING ERRCODE = 'QM025'; END IF;
  FOR k IN SELECT jsonb_object_keys(p_data) LOOP
    IF k NOT IN ('title', 'description', 'ownerId', 'restricted', 'reviewMonths') THEN RAISE EXCEPTION 'Unknown field % (the number, type and content kind never change)', k USING ERRCODE = 'QM025'; END IF;
  END LOOP;
  IF p_data ? 'title' THEN d.title := btrim(coalesce(p_data ->> 'title', '')); END IF;
  IF p_data ? 'description' THEN d.description := nullif(btrim(coalesce(p_data ->> 'description', '')), ''); END IF;
  IF p_data ? 'ownerId' THEN d.owner_user_id := nullif(p_data ->> 'ownerId', '')::uuid; END IF;
  IF p_data ? 'restricted' THEN d.restricted := coalesce((p_data ->> 'restricted')::boolean, false); END IF;
  IF p_data ? 'reviewMonths' THEN
    d.review_months := (p_data ->> 'reviewMonths')::integer;
    IF d.review_months IS NOT NULL AND d.review_months NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION 'The review interval is 1 to 120 months' USING ERRCODE = 'QM025'; END IF;
  END IF;
  IF length(d.title) = 0 OR length(d.title) > 200 THEN RAISE EXCEPTION 'Give the document a title (up to 200 characters)' USING ERRCODE = 'QM025'; END IF;
  IF d.description IS NOT NULL AND length(d.description) > 1000 THEN RAISE EXCEPTION 'The description is up to 1000 characters' USING ERRCODE = 'QM025'; END IF;
  IF d.owner_user_id IS NULL OR NOT app.is_active_member_user(d.organisation_id, d.owner_user_id) THEN
    RAISE EXCEPTION 'The owner must be an active member of this organisation' USING ERRCODE = 'QM025';
  END IF;
  UPDATE public.documents SET title = d.title, description = d.description, owner_user_id = d.owner_user_id, restricted = d.restricted, review_months = d.review_months WHERE id = d.id;
  -- A new interval counts from the last review, else from when the revision in force took effect.
  IF p_data ? 'reviewMonths' AND d.status = 'active' THEN
    SELECT coalesce((SELECT max(created_at)::date FROM public.document_periodic_reviews WHERE document_id = d.id AND outcome = 'no_change'
                      AND created_at > (SELECT effective_at FROM public.document_revisions WHERE id = d.current_revision_id)),
                    (SELECT effective_from FROM public.document_revisions WHERE id = d.current_revision_id))
      INTO v_from;
    UPDATE public.documents SET next_review_on = (v_from + make_interval(months => app.document_review_months(d.id)))::date WHERE id = d.id;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Settling (replaces DC3's): the next review date is set when a revision takes effect; withdrawing clears it
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
    UPDATE public.documents SET status = 'active', current_revision_id = r.id, withdrawn_at = NULL, withdrawn_by = NULL, withdraw_reason = NULL,
           next_review_on = (r.effective_from + make_interval(months => app.document_review_months(p_document)))::date
     WHERE id = p_document;
    INSERT INTO public.document_recipients (organisation_id, revision_id, user_id, reached_via, due_on)
    SELECT r.organisation_id, r.id, t.user_id, t.via, CASE WHEN r.acknowledge_within_days IS NULL THEN NULL ELSE r.effective_from + r.acknowledge_within_days END
      FROM app.resolve_document_targets(p_document) t
    ON CONFLICT (revision_id, user_id) DO NOTHING;
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $$;

CREATE FUNCTION app.document_clear_review_on_withdraw() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.status = 'withdrawn' THEN NEW.next_review_on := NULL; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER documents_clear_review_on_withdraw BEFORE UPDATE OF status ON public.documents FOR EACH ROW EXECUTE FUNCTION app.document_clear_review_on_withdraw();

-- Documents already in force get their next review date (effective date + interval).
UPDATE public.documents d SET next_review_on = (r.effective_from + make_interval(months => app.document_review_months(d.id)))::date
  FROM public.document_revisions r WHERE r.id = d.current_revision_id AND d.status = 'active' AND d.next_review_on IS NULL;

-- ---------------------------------------------------------------------------
-- Recording a periodic review
-- ---------------------------------------------------------------------------
-- outcome no_change (note required: what was checked) → next review = today + interval; revision_started → a new draft from the revision in force,
-- the next review date is set again when that revision takes effect. Returns the started revision's id, or null.
CREATE FUNCTION app.record_document_review(p_document uuid, p_outcome text, p_note text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE d public.documents%ROWTYPE; v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_rev uuid; v_next date;
BEGIN
  SELECT * INTO d FROM public.documents WHERE id = p_document FOR UPDATE;
  IF NOT FOUND OR NOT app.document_readable(d.id) THEN RAISE EXCEPTION 'Document not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_document_manager(d.organisation_id);
  IF d.status <> 'active' THEN RAISE EXCEPTION 'Only a document in force is reviewed (% is %)', d.number, d.status USING ERRCODE = 'QM025'; END IF;
  IF p_outcome IS NULL OR p_outcome NOT IN ('no_change', 'revision_started') THEN RAISE EXCEPTION 'The outcome is no change needed, or a revision started' USING ERRCODE = 'QM025'; END IF;
  IF v_note IS NOT NULL AND length(v_note) > 2000 THEN RAISE EXCEPTION 'The note is up to 2000 characters' USING ERRCODE = 'QM025'; END IF;
  IF p_outcome = 'no_change' THEN
    IF v_note IS NULL OR length(v_note) < 3 THEN RAISE EXCEPTION 'Say what was checked (a note of at least 3 characters)' USING ERRCODE = 'QM025'; END IF;
    v_next := (current_date + make_interval(months => app.document_review_months(d.id)))::date;
    UPDATE public.documents SET next_review_on = v_next WHERE id = d.id;
  ELSE
    v_rev := app.start_document_revision(d.id);
  END IF;
  INSERT INTO public.document_periodic_reviews (organisation_id, document_id, revision_id, outcome, note, started_revision_id, was_due_on, next_review_on)
  VALUES (d.organisation_id, d.id, d.current_revision_id, p_outcome, v_note, v_rev, d.next_review_on, coalesce(v_next, d.next_review_on));
  RETURN v_rev;
END $$;

-- ---------------------------------------------------------------------------
-- Change requests
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.raise_document_change_request(p_document uuid, p_what text, p_why text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE d public.documents%ROWTYPE; v_what text := btrim(coalesce(p_what, '')); v_why text := btrim(coalesce(p_why, '')); v_year integer := extract(year FROM current_date)::integer;
  v_n integer; v_id uuid;
BEGIN
  SELECT * INTO d FROM public.documents WHERE id = p_document;
  IF NOT FOUND OR NOT app.document_readable(d.id) THEN RAISE EXCEPTION 'Document not found' USING ERRCODE = 'P0002'; END IF;
  IF d.status NOT IN ('active', 'withdrawn', 'draft') THEN RAISE EXCEPTION '% was discarded', d.number USING ERRCODE = 'QM025'; END IF;
  IF length(v_what) < 3 OR length(v_what) > 2000 THEN RAISE EXCEPTION 'Say what should change (3 to 2000 characters)' USING ERRCODE = 'QM025'; END IF;
  IF length(v_why) < 3 OR length(v_why) > 2000 THEN RAISE EXCEPTION 'Say why (3 to 2000 characters)' USING ERRCODE = 'QM025'; END IF;
  INSERT INTO app.document_change_request_counters AS c (organisation_id, year, last_value) VALUES (d.organisation_id, v_year, 1)
  ON CONFLICT (organisation_id, year) DO UPDATE SET last_value = c.last_value + 1 RETURNING last_value INTO v_n;
  INSERT INTO public.document_change_requests (organisation_id, reference, document_id, what, why, requested_by)
  VALUES (d.organisation_id, 'DCR-' || lpad((v_year % 100)::text, 2, '0') || '-' || lpad(v_n::text, 4, '0'), d.id, v_what, v_why, auth.uid())
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION app.document_change_request_for_update(p_id uuid) RETURNS public.document_change_requests
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.document_change_requests%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.document_change_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(c.organisation_id) OR NOT (c.requested_by = auth.uid() OR app.has_permission(c.organisation_id, 'documentation.manage')) THEN
    RAISE EXCEPTION 'Change request not found' USING ERRCODE = 'P0002';
  END IF;
  IF c.status <> 'open' THEN RAISE EXCEPTION '% is already %', c.reference, c.status USING ERRCODE = 'QM025'; END IF;
  RETURN c;
END $$;

-- Accepting starts a draft (or uses the draft already in progress) and points the request at it. Returns the revision id.
CREATE FUNCTION app.accept_document_change_request(p_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.document_change_requests; v_rev uuid; v_status text;
BEGIN
  c := app.document_change_request_for_update(p_id);
  PERFORM app.assert_document_manager(c.organisation_id);
  SELECT id, status INTO v_rev, v_status FROM public.document_revisions WHERE document_id = c.document_id AND status IN ('draft', 'in_review', 'awaiting_approval', 'approved');
  IF v_rev IS NOT NULL AND v_status <> 'draft' THEN
    RAISE EXCEPTION 'A revision is already %. Accept the request once it has taken effect, or once it is sent back to draft.', replace(v_status, '_', ' ') USING ERRCODE = 'QM025';
  END IF;
  IF v_rev IS NULL THEN v_rev := app.start_document_revision(c.document_id); END IF;
  UPDATE public.document_change_requests SET status = 'accepted', revision_id = v_rev, decided_by = auth.uid(), decided_at = now() WHERE id = c.id;
  RETURN v_rev;
END $$;

CREATE FUNCTION app.decline_document_change_request(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.document_change_requests; v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  c := app.document_change_request_for_update(p_id);
  PERFORM app.assert_document_manager(c.organisation_id);
  IF length(v_reason) < 3 THEN RAISE EXCEPTION 'Say why it is declined (at least 3 characters)' USING ERRCODE = 'QM025'; END IF;
  UPDATE public.document_change_requests SET status = 'declined', decision_reason = left(v_reason, 1000), decided_by = auth.uid(), decided_at = now() WHERE id = c.id;
END $$;

CREATE FUNCTION app.withdraw_document_change_request(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.document_change_requests;
BEGIN
  c := app.document_change_request_for_update(p_id);
  IF c.requested_by <> auth.uid() THEN RAISE EXCEPTION 'Only the person who asked can withdraw it' USING ERRCODE = '42501'; END IF;
  UPDATE public.document_change_requests SET status = 'withdrawn', decided_by = auth.uid(), decided_at = now() WHERE id = c.id;
END $$;

-- ---------------------------------------------------------------------------
-- Links
-- ---------------------------------------------------------------------------
-- links: [{partId} | {partFamilyId} | {machineId} | {operationCode}], replaced as a whole.
CREATE FUNCTION app.set_document_links(p_document uuid, p_links jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE d public.documents%ROWTYPE; l jsonb; v_part uuid; v_fam uuid; v_mach uuid; v_op text;
BEGIN
  SELECT * INTO d FROM public.documents WHERE id = p_document FOR UPDATE;
  IF NOT FOUND OR NOT app.document_readable(d.id) THEN RAISE EXCEPTION 'Document not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_document_manager(d.organisation_id);
  IF d.status = 'discarded' THEN RAISE EXCEPTION '% was discarded and cannot be changed', d.number USING ERRCODE = 'QM025'; END IF;
  IF jsonb_typeof(p_links) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Send the links as a list' USING ERRCODE = 'QM025'; END IF;
  IF jsonb_array_length(p_links) > 200 THEN RAISE EXCEPTION 'At most 200 links' USING ERRCODE = 'QM025'; END IF;
  DELETE FROM public.document_links WHERE document_id = d.id;
  FOR l IN SELECT * FROM jsonb_array_elements(p_links) LOOP
    v_part := nullif(l ->> 'partId', '')::uuid; v_fam := nullif(l ->> 'partFamilyId', '')::uuid; v_mach := nullif(l ->> 'machineId', '')::uuid;
    v_op := nullif(btrim(coalesce(l ->> 'operationCode', '')), '');
    IF num_nonnulls(v_part, v_fam, v_mach, v_op) <> 1 THEN RAISE EXCEPTION 'Each link is one part, part family, machine or operation' USING ERRCODE = 'QM025'; END IF;
    IF v_part IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.parts WHERE id = v_part AND organisation_id = d.organisation_id) THEN RAISE EXCEPTION 'Part not found' USING ERRCODE = 'QM025'; END IF;
    IF v_fam IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.part_families WHERE id = v_fam AND organisation_id = d.organisation_id) THEN RAISE EXCEPTION 'Part family not found' USING ERRCODE = 'QM025'; END IF;
    IF v_mach IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.machines WHERE id = v_mach AND organisation_id = d.organisation_id) THEN RAISE EXCEPTION 'Machine not found' USING ERRCODE = 'QM025'; END IF;
    IF v_op IS NOT NULL AND length(v_op) > 40 THEN RAISE EXCEPTION 'An operation code is up to 40 characters' USING ERRCODE = 'QM025'; END IF;
    INSERT INTO public.document_links (organisation_id, document_id, part_id, part_family_id, machine_id, operation_code) VALUES (d.organisation_id, d.id, v_part, v_fam, v_mach, v_op)
    ON CONFLICT DO NOTHING;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Notice: a change request accepted or declined tells the person who asked
-- ---------------------------------------------------------------------------
INSERT INTO public.notification_event_types
  (key, entity_type, action, group_name, entity_label, description, permission_code, default_on, default_permission_code, label_fields, display_order, own_record)
VALUES
  ('document_change_requests.updated', 'document_change_requests', 'updated', 'Documentation', 'Document change request', 'Your change request was decided', 'documentation.read', true, NULL,
   ARRAY['request_label', 'decision_label'], 62, true);

-- emit_notification as in 20260204100000, plus the change request branch (only accepted / declined, to the person who asked).
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

  -- A change request is news to the person who asked only when it is accepted or declined.
  IF NEW.entity_type = 'document_change_requests' AND NOT (NEW.action = 'update' AND NEW.new_values ->> 'status' IN ('accepted', 'declined')) THEN
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

  -- A decided change request tells the person who asked: which request, for which document, and the decision (with the reason when declined).
  IF NEW.entity_type = 'document_change_requests' THEN
    SELECT to_jsonb(c) || jsonb_build_object(
             'user_id', c.requested_by, 'document_id', d.id, 'revision_id', c.revision_id,
             'request_label', c.reference || ' · ' || d.number || ' ' || d.title,
             'decision_label', CASE c.status WHEN 'accepted' THEN 'Accepted: a revision is being written' ELSE 'Declined: ' || coalesce(c.decision_reason, '') END)
      INTO v_doc_row
      FROM public.document_change_requests c
      JOIN public.documents d ON d.id = c.document_id
     WHERE c.id = NEW.entity_id::uuid;
    IF v_doc_row IS NULL THEN RETURN NULL; END IF;
    v_row := v_doc_row;
  END IF;

  v_body := nullif(concat_ws(' — ', VARIADIC (
    SELECT coalesce(array_agg(nullif(v_row ->> f, '') ORDER BY ord), '{}') FROM unnest(v_type.label_fields) WITH ORDINALITY AS u(f, ord))), '');
  IF v_action = 'updated' AND NEW.changed_fields IS NOT NULL
     AND NEW.entity_type NOT IN ('quality_alert_recipients', 'capa_actions', 'competence_assessments', 'document_signoffs', 'document_recipients', 'document_change_requests') THEN
    v_what := 'Changed: ' || replace(array_to_string(NEW.changed_fields, ', '), '_', ' ');
    v_body := concat_ws('. ', v_body, left(v_what, 200));
  END IF;

  SELECT coalesce(jsonb_object_agg(k, v_row -> k), '{}'::jsonb) INTO v_details
    FROM unnest(ARRAY['site_id', 'gauge_id', 'control_plan_id', 'part_id', 'source', 'stage', 'status', 'alert_id', 'capa_id', 'connection_id', 'run_id', 'kind',
                      'document_id', 'revision_id', 'role']) k
   WHERE v_row ->> k IS NOT NULL;

  -- Notices about one person's own alerts are for that person only.
  IF NEW.entity_type IN ('quality_alert_recipients', 'capa_actions', 'competence_assessments', 'document_signoffs', 'document_recipients', 'document_change_requests') THEN
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
REVOKE ALL ON FUNCTION app.document_review_months(uuid), app.document_review_frozen(), app.document_change_request_rules(), app.document_clear_review_on_withdraw(),
  app.record_document_review(uuid, text, text), app.raise_document_change_request(uuid, text, text), app.document_change_request_for_update(uuid),
  app.accept_document_change_request(uuid), app.decline_document_change_request(uuid, text), app.withdraw_document_change_request(uuid),
  app.set_document_links(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.document_review_months(uuid), app.record_document_review(uuid, text, text), app.raise_document_change_request(uuid, text, text),
  app.accept_document_change_request(uuid), app.decline_document_change_request(uuid, text), app.withdraw_document_change_request(uuid),
  app.set_document_links(uuid, jsonb) TO authenticated;
