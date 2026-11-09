-- Supplier Quality SQ3b/SQ3c: SCARs (supplier corrective action requests), docs/supplier-quality-plan.md.
--
-- A SCAR asks an EXTERNAL party to investigate and fix a problem and tracks what comes back. It is not the internal 8D (capas), which it may link to for Fortress's own actions.
-- One SCAR names one supplier and links to many of that supplier's non-conformances (never another supplier's). The stages are kept as SEPARATE append-only records:
--   response (what the supplier said), internal review (our decision on a response), implementation (the fix being carried out), effectiveness verification (did it work).
-- Receiving a response never closes a SCAR: it is reviewed, accepted, implemented and verified first, and closing needs an effective verification by someone with supplier_quality.approve.
-- Statuses (ten): draft, issued, acknowledged, response_received, under_review, revision_requested, accepted, verifying, closed, cancelled. Moves are validated by
-- app.scar_transition_allowed and written to supplier_scar_status_history. No table INSERT/UPDATE/DELETE grants: every write is a SECURITY DEFINER function. Nothing is deleted.
-- Creation is idempotent per client key (a retried request returns the same SCAR). Overdue is worked out on read, never stored.

CREATE TABLE app.supplier_scar_counters (
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  year integer NOT NULL,
  last_value integer NOT NULL DEFAULT 0,
  PRIMARY KEY (organisation_id, year)
);
REVOKE ALL ON TABLE app.supplier_scar_counters FROM PUBLIC, anon, authenticated;

CREATE FUNCTION app.scar_transition_allowed(p_from text, p_to text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT (p_from, p_to) IN (
    ('draft', 'issued'), ('draft', 'cancelled'),
    ('issued', 'acknowledged'), ('issued', 'response_received'), ('issued', 'cancelled'),
    ('acknowledged', 'response_received'), ('acknowledged', 'cancelled'),
    ('response_received', 'under_review'), ('response_received', 'cancelled'),
    ('under_review', 'accepted'), ('under_review', 'revision_requested'), ('under_review', 'cancelled'),
    ('revision_requested', 'response_received'), ('revision_requested', 'cancelled'),
    ('accepted', 'verifying'), ('accepted', 'cancelled'),
    ('verifying', 'closed'), ('verifying', 'revision_requested'), ('verifying', 'cancelled'))
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE public.supplier_scars (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  reference text NOT NULL,
  supplier_id uuid NOT NULL,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 3 AND 200),
  problem_description text CHECK (problem_description IS NULL OR length(btrim(problem_description)) BETWEEN 1 AND 4000),
  severity text NOT NULL DEFAULT 'minor' CHECK (severity IN ('minor', 'major', 'critical')),
  contact_id uuid,
  capa_id uuid,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'acknowledged', 'response_received', 'under_review', 'revision_requested', 'accepted', 'verifying', 'closed', 'cancelled')),
  original_response_due_on date,
  response_due_on date,
  client_key text CHECK (client_key IS NULL OR length(client_key) BETWEEN 8 AND 100),
  issued_at timestamptz,
  issued_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  acknowledged_note text CHECK (acknowledged_note IS NULL OR length(btrim(acknowledged_note)) BETWEEN 1 AND 1000),
  closed_at timestamptz,
  closed_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  cancelled_at timestamptz,
  cancelled_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  cancel_reason text CHECK (cancel_reason IS NULL OR length(btrim(cancel_reason)) BETWEEN 3 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT supplier_scars_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT supplier_scars_reference_key UNIQUE (organisation_id, reference),
  CONSTRAINT supplier_scars_supplier_fkey FOREIGN KEY (supplier_id, organisation_id) REFERENCES public.suppliers (id, organisation_id),
  CONSTRAINT supplier_scars_contact_fkey FOREIGN KEY (contact_id, organisation_id) REFERENCES public.supplier_contacts (id, organisation_id),
  CONSTRAINT supplier_scars_capa_fkey FOREIGN KEY (capa_id, organisation_id) REFERENCES public.capas (id, organisation_id),
  CONSTRAINT supplier_scars_issued CHECK (status IN ('draft', 'cancelled') OR (issued_at IS NOT NULL AND response_due_on IS NOT NULL)),
  CONSTRAINT supplier_scars_closed CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
  CONSTRAINT supplier_scars_cancelled CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL) AND (status <> 'cancelled' OR cancel_reason IS NOT NULL))
);
CREATE UNIQUE INDEX supplier_scars_client_key ON public.supplier_scars (organisation_id, client_key) WHERE client_key IS NOT NULL;
CREATE INDEX supplier_scars_supplier_idx ON public.supplier_scars (supplier_id, created_at DESC);
CREATE INDEX supplier_scars_status_idx ON public.supplier_scars (organisation_id, status);

CREATE TABLE public.supplier_scar_ncrs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  scar_id uuid NOT NULL,
  ncr_id uuid NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT now(),
  linked_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  ended_at timestamptz,
  ended_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  end_reason text CHECK (end_reason IS NULL OR length(btrim(end_reason)) BETWEEN 3 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT supplier_scar_ncrs_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT supplier_scar_ncrs_scar_fkey FOREIGN KEY (scar_id, organisation_id) REFERENCES public.supplier_scars (id, organisation_id),
  CONSTRAINT supplier_scar_ncrs_ncr_fkey FOREIGN KEY (ncr_id, organisation_id) REFERENCES public.nonconformances (id, organisation_id),
  CONSTRAINT supplier_scar_ncrs_ended CHECK ((ended_at IS NULL) = (end_reason IS NULL))
);
CREATE UNIQUE INDEX supplier_scar_ncrs_live ON public.supplier_scar_ncrs (scar_id, ncr_id) WHERE ended_at IS NULL;
CREATE INDEX supplier_scar_ncrs_ncr_idx ON public.supplier_scar_ncrs (ncr_id);

CREATE TABLE public.supplier_scar_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  scar_id uuid NOT NULL,
  from_status text,
  to_status text NOT NULL,
  reason text CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 1000),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  changed_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT supplier_scar_status_history_scar_fkey FOREIGN KEY (scar_id, organisation_id) REFERENCES public.supplier_scars (id, organisation_id)
);
CREATE INDEX supplier_scar_status_history_idx ON public.supplier_scar_status_history (scar_id, changed_at);

-- What the supplier said. A new response (seq 2, 3 …) answers a request for revision; earlier ones are kept as they were.
CREATE TABLE public.supplier_scar_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  scar_id uuid NOT NULL,
  seq integer NOT NULL CHECK (seq >= 1),
  root_cause text NOT NULL CHECK (length(btrim(root_cause)) BETWEEN 3 AND 4000),
  containment text CHECK (containment IS NULL OR length(btrim(containment)) BETWEEN 1 AND 4000),
  corrective_action text NOT NULL CHECK (length(btrim(corrective_action)) BETWEEN 3 AND 4000),
  preventive_action text CHECK (preventive_action IS NULL OR length(btrim(preventive_action)) BETWEEN 1 AND 4000),
  planned_completion_on date,
  responded_on date NOT NULL,
  responded_by_name text CHECK (responded_by_name IS NULL OR length(btrim(responded_by_name)) BETWEEN 1 AND 200),
  contact_id uuid,
  received_at timestamptz NOT NULL DEFAULT now(),
  received_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT supplier_scar_responses_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT supplier_scar_responses_scar_fkey FOREIGN KEY (scar_id, organisation_id) REFERENCES public.supplier_scars (id, organisation_id),
  CONSTRAINT supplier_scar_responses_contact_fkey FOREIGN KEY (contact_id, organisation_id) REFERENCES public.supplier_contacts (id, organisation_id),
  CONSTRAINT supplier_scar_responses_seq_key UNIQUE (scar_id, seq)
);

-- Our decision on one response.
CREATE TABLE public.supplier_scar_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  scar_id uuid NOT NULL,
  response_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('accepted', 'revision_requested')),
  note text NOT NULL CHECK (length(btrim(note)) BETWEEN 3 AND 2000),
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT supplier_scar_reviews_scar_fkey FOREIGN KEY (scar_id, organisation_id) REFERENCES public.supplier_scars (id, organisation_id),
  CONSTRAINT supplier_scar_reviews_response_fkey FOREIGN KEY (response_id, organisation_id) REFERENCES public.supplier_scar_responses (id, organisation_id),
  CONSTRAINT supplier_scar_reviews_one_per_response UNIQUE (response_id)
);

-- The accepted fix being carried out.
CREATE TABLE public.supplier_scar_implementations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  scar_id uuid NOT NULL,
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 3 AND 4000),
  implemented_on date NOT NULL,
  evidence_note text CHECK (evidence_note IS NULL OR length(btrim(evidence_note)) BETWEEN 1 AND 2000),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  recorded_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT supplier_scar_implementations_scar_fkey FOREIGN KEY (scar_id, organisation_id) REFERENCES public.supplier_scars (id, organisation_id)
);

-- Did it work.
CREATE TABLE public.supplier_scar_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  scar_id uuid NOT NULL,
  result text NOT NULL CHECK (result IN ('effective', 'not_effective')),
  method text NOT NULL CHECK (length(btrim(method)) BETWEEN 3 AND 1000),
  note text NOT NULL CHECK (length(btrim(note)) BETWEEN 3 AND 2000),
  verified_at timestamptz NOT NULL DEFAULT now(),
  verified_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT supplier_scar_verifications_scar_fkey FOREIGN KEY (scar_id, organisation_id) REFERENCES public.supplier_scars (id, organisation_id)
);

CREATE TABLE public.supplier_scar_extensions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  scar_id uuid NOT NULL,
  previous_due_on date NOT NULL,
  new_due_on date NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
  extended_at timestamptz NOT NULL DEFAULT now(),
  extended_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT supplier_scar_extensions_scar_fkey FOREIGN KEY (scar_id, organisation_id) REFERENCES public.supplier_scars (id, organisation_id),
  CONSTRAINT supplier_scar_extensions_later CHECK (new_due_on > previous_due_on)
);

-- Append-only tables are frozen: no update, no delete, by anyone.
CREATE FUNCTION app.scar_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'SCAR records are never changed or deleted once written' USING ERRCODE = 'QM020';
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['supplier_scars', 'supplier_scar_ncrs', 'supplier_scar_status_history', 'supplier_scar_responses', 'supplier_scar_reviews', 'supplier_scar_implementations', 'supplier_scar_verifications', 'supplier_scar_extensions'] LOOP
    EXECUTE format('CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION audit.record_change(%L)', t, 'organisation_id');
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format($p$CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (app.has_permission(organisation_id, 'supplier_quality.read'))$p$, t || '_select', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION app.stamp_created()', t || '_stamp', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['supplier_scars', 'supplier_scar_ncrs'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.touch_updated()', t || '_touch', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change()', t || '_org_immutable', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['supplier_scar_status_history', 'supplier_scar_responses', 'supplier_scar_reviews', 'supplier_scar_implementations', 'supplier_scar_verifications', 'supplier_scar_extensions'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.scar_frozen()', t || '_frozen', t);
  END LOOP;
END $$;

-- A SCAR's status may only move along an allowed transition, whoever writes it.
CREATE FUNCTION app.scar_status_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT app.scar_transition_allowed(OLD.status, NEW.status) THEN
    RAISE EXCEPTION 'A SCAR cannot move from % to %', replace(OLD.status, '_', ' '), replace(NEW.status, '_', ' ') USING ERRCODE = 'QM020';
  END IF;
  IF NEW.supplier_id IS DISTINCT FROM OLD.supplier_id OR NEW.reference IS DISTINCT FROM OLD.reference THEN
    RAISE EXCEPTION 'The supplier and reference of a SCAR never change' USING ERRCODE = 'QM020';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER supplier_scars_status_guard BEFORE UPDATE ON public.supplier_scars FOR EACH ROW EXECUTE FUNCTION app.scar_status_guard();

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
-- Lock the SCAR and check the caller's permission. Writing needs supplier_quality.manage unless another is named.
CREATE FUNCTION app.scar_for_write(p_scar uuid, p_permission text DEFAULT 'supplier_quality.manage') RETURNS public.supplier_scars
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.supplier_scars%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.supplier_scars WHERE id = p_scar FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(c.organisation_id) THEN RAISE EXCEPTION 'SCAR not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(c.organisation_id, p_permission) THEN RAISE EXCEPTION 'You are not allowed to change this SCAR' USING ERRCODE = '42501'; END IF;
  RETURN c;
END $$;

-- Move the status (validated by the guard trigger too) and write the history row.
CREATE FUNCTION app.scar_set_status(p_scar public.supplier_scars, p_to text, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT app.scar_transition_allowed(p_scar.status, p_to) THEN
    RAISE EXCEPTION 'A SCAR cannot move from % to %', replace(p_scar.status, '_', ' '), replace(p_to, '_', ' ') USING ERRCODE = 'QM020';
  END IF;
  -- The stamps for the new status go in the same statement, so the table's state checks always hold.
  UPDATE public.supplier_scars SET status = p_to, updated_by = auth.uid(),
    issued_at = CASE WHEN p_to = 'issued' THEN now() ELSE issued_at END, issued_by = CASE WHEN p_to = 'issued' THEN auth.uid() ELSE issued_by END,
    acknowledged_at = CASE WHEN p_to = 'acknowledged' THEN now() ELSE acknowledged_at END, acknowledged_by = CASE WHEN p_to = 'acknowledged' THEN auth.uid() ELSE acknowledged_by END,
    acknowledged_note = CASE WHEN p_to = 'acknowledged' THEN nullif(btrim(coalesce(p_reason, '')), '') ELSE acknowledged_note END,
    closed_at = CASE WHEN p_to = 'closed' THEN now() ELSE closed_at END, closed_by = CASE WHEN p_to = 'closed' THEN auth.uid() ELSE closed_by END,
    cancelled_at = CASE WHEN p_to = 'cancelled' THEN now() ELSE cancelled_at END, cancelled_by = CASE WHEN p_to = 'cancelled' THEN auth.uid() ELSE cancelled_by END,
    cancel_reason = CASE WHEN p_to = 'cancelled' THEN btrim(p_reason) ELSE cancel_reason END
  WHERE id = p_scar.id;
  INSERT INTO public.supplier_scar_status_history (organisation_id, scar_id, from_status, to_status, reason) VALUES (p_scar.organisation_id, p_scar.id, p_scar.status, p_to, nullif(btrim(coalesce(p_reason, '')), ''));
END $$;

-- ---------------------------------------------------------------------------
-- Raising and editing
-- ---------------------------------------------------------------------------
-- Create a draft SCAR (optionally linking the supplier's non-conformances and an 8D). Idempotent per client key: a retry returns the same SCAR with created = false.
CREATE FUNCTION app.create_supplier_scar(p_supplier uuid, p_title text, p_description text, p_severity text, p_response_due_on date, p_contact uuid, p_ncrs uuid[], p_capa uuid, p_client_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.suppliers%ROWTYPE; v_year integer := extract(year FROM now())::int; v_n integer; v_id uuid; n uuid;
BEGIN
  s := app.supplier_for_write(p_supplier, 'supplier_quality.manage');
  IF p_client_key IS NOT NULL THEN
    SELECT id INTO v_id FROM public.supplier_scars WHERE organisation_id = s.organisation_id AND client_key = p_client_key;
    IF FOUND THEN
      IF (SELECT supplier_id FROM public.supplier_scars WHERE id = v_id) <> s.id THEN RAISE EXCEPTION 'That request key was used for another supplier' USING ERRCODE = 'QM020'; END IF;
      RETURN jsonb_build_object('id', v_id, 'created', false);
    END IF;
  END IF;
  IF p_title IS NULL OR length(btrim(p_title)) NOT BETWEEN 3 AND 200 THEN RAISE EXCEPTION 'Give the SCAR a title (3 to 200 characters)' USING ERRCODE = 'QM020'; END IF;
  IF p_response_due_on IS NOT NULL AND p_response_due_on < current_date THEN RAISE EXCEPTION 'The response due date cannot be in the past' USING ERRCODE = 'QM020'; END IF;
  IF p_contact IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.supplier_contacts WHERE id = p_contact AND supplier_id = s.id AND organisation_id = s.organisation_id) THEN
    RAISE EXCEPTION 'That contact does not belong to this supplier' USING ERRCODE = 'QM020';
  END IF;
  IF p_capa IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.capas WHERE id = p_capa AND organisation_id = s.organisation_id) THEN RAISE EXCEPTION '8D not found' USING ERRCODE = 'P0002'; END IF;
  INSERT INTO app.supplier_scar_counters AS k (organisation_id, year, last_value) VALUES (s.organisation_id, v_year, 1)
  ON CONFLICT (organisation_id, year) DO UPDATE SET last_value = k.last_value + 1 RETURNING last_value INTO v_n;
  INSERT INTO public.supplier_scars (organisation_id, reference, supplier_id, title, problem_description, severity, contact_id, capa_id, original_response_due_on, response_due_on, client_key)
  VALUES (s.organisation_id, 'SCAR-' || to_char(make_date(v_year, 1, 1), 'YY') || '-' || lpad(v_n::text, 4, '0'), s.id, btrim(p_title), nullif(btrim(coalesce(p_description, '')), ''),
          coalesce(p_severity, 'minor'), p_contact, p_capa, p_response_due_on, p_response_due_on, p_client_key)
  RETURNING id INTO v_id;
  INSERT INTO public.supplier_scar_status_history (organisation_id, scar_id, from_status, to_status, reason) VALUES (s.organisation_id, v_id, NULL, 'draft', 'Created');
  IF p_ncrs IS NOT NULL THEN
    FOREACH n IN ARRAY p_ncrs LOOP PERFORM app.link_scar_ncr(v_id, n); END LOOP;
  END IF;
  RETURN jsonb_build_object('id', v_id, 'created', true);
END $$;

-- Keys present are set. A draft may change everything; once issued only the contact and the 8D link (and never the supplier or reference).
CREATE FUNCTION app.update_supplier_scar(p_scar uuid, p_changes jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.supplier_scars%ROWTYPE; k text; v_contact uuid; v_capa uuid;
BEGIN
  c := app.scar_for_write(p_scar);
  IF c.status IN ('closed', 'cancelled') THEN RAISE EXCEPTION 'A % SCAR cannot be changed', c.status USING ERRCODE = 'QM020'; END IF;
  FOR k IN SELECT jsonb_object_keys(p_changes) LOOP
    IF k NOT IN ('title', 'problemDescription', 'severity', 'responseDueOn', 'contactId', 'capaId') THEN RAISE EXCEPTION 'Unknown field %', k USING ERRCODE = 'QM020'; END IF;
    IF c.status <> 'draft' AND k NOT IN ('contactId', 'capaId') THEN RAISE EXCEPTION 'Once issued only the contact and the 8D link can change (use an extension to move the due date)' USING ERRCODE = 'QM020'; END IF;
  END LOOP;
  IF p_changes ? 'title' AND length(btrim(coalesce(p_changes ->> 'title', ''))) NOT BETWEEN 3 AND 200 THEN RAISE EXCEPTION 'Give the SCAR a title (3 to 200 characters)' USING ERRCODE = 'QM020'; END IF;
  IF p_changes ? 'severity' AND coalesce(p_changes ->> 'severity', '') NOT IN ('minor', 'major', 'critical') THEN RAISE EXCEPTION 'Severity is minor, major or critical' USING ERRCODE = 'QM020'; END IF;
  IF p_changes ? 'responseDueOn' AND (p_changes ->> 'responseDueOn') IS NOT NULL AND (p_changes ->> 'responseDueOn')::date < current_date THEN RAISE EXCEPTION 'The response due date cannot be in the past' USING ERRCODE = 'QM020'; END IF;
  v_contact := CASE WHEN p_changes ? 'contactId' THEN nullif(p_changes ->> 'contactId', '')::uuid ELSE c.contact_id END;
  v_capa := CASE WHEN p_changes ? 'capaId' THEN nullif(p_changes ->> 'capaId', '')::uuid ELSE c.capa_id END;
  IF v_contact IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.supplier_contacts WHERE id = v_contact AND supplier_id = c.supplier_id AND organisation_id = c.organisation_id) THEN
    RAISE EXCEPTION 'That contact does not belong to this supplier' USING ERRCODE = 'QM020';
  END IF;
  IF v_capa IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.capas WHERE id = v_capa AND organisation_id = c.organisation_id) THEN RAISE EXCEPTION '8D not found' USING ERRCODE = 'P0002'; END IF;
  UPDATE public.supplier_scars SET
    title = CASE WHEN p_changes ? 'title' THEN btrim(p_changes ->> 'title') ELSE title END,
    problem_description = CASE WHEN p_changes ? 'problemDescription' THEN nullif(btrim(coalesce(p_changes ->> 'problemDescription', '')), '') ELSE problem_description END,
    severity = CASE WHEN p_changes ? 'severity' THEN p_changes ->> 'severity' ELSE severity END,
    original_response_due_on = CASE WHEN p_changes ? 'responseDueOn' THEN (p_changes ->> 'responseDueOn')::date ELSE original_response_due_on END,
    response_due_on = CASE WHEN p_changes ? 'responseDueOn' THEN (p_changes ->> 'responseDueOn')::date ELSE response_due_on END,
    contact_id = v_contact, capa_id = v_capa, updated_by = auth.uid()
  WHERE id = c.id;
END $$;

-- Link one of THIS supplier's non-conformances (live ones only). Allowed on any SCAR that is not closed or cancelled. Linking twice is a no-op.
CREATE FUNCTION app.link_scar_ncr(p_scar uuid, p_ncr uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.supplier_scars%ROWTYPE; n public.nonconformances%ROWTYPE;
BEGIN
  c := app.scar_for_write(p_scar);
  IF c.status IN ('closed', 'cancelled') THEN RAISE EXCEPTION 'A % SCAR cannot be changed', c.status USING ERRCODE = 'QM020'; END IF;
  SELECT * INTO n FROM public.nonconformances WHERE id = p_ncr AND organisation_id = c.organisation_id;
  IF NOT FOUND OR n.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'Non-conformance not found' USING ERRCODE = 'P0002'; END IF;
  IF n.supplier_id IS DISTINCT FROM c.supplier_id THEN RAISE EXCEPTION 'Only non-conformances that name this supplier can be linked to its SCAR' USING ERRCODE = 'QM020'; END IF;
  IF n.stage = 'cancelled' THEN RAISE EXCEPTION 'A cancelled non-conformance cannot be linked' USING ERRCODE = 'QM020'; END IF;
  INSERT INTO public.supplier_scar_ncrs (organisation_id, scar_id, ncr_id) VALUES (c.organisation_id, c.id, n.id) ON CONFLICT (scar_id, ncr_id) WHERE ended_at IS NULL DO NOTHING;
END $$;

CREATE FUNCTION app.unlink_scar_ncr(p_link uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE l public.supplier_scar_ncrs%ROWTYPE; c public.supplier_scars%ROWTYPE;
BEGIN
  SELECT * INTO l FROM public.supplier_scar_ncrs WHERE id = p_link;
  IF NOT FOUND THEN RAISE EXCEPTION 'Link not found' USING ERRCODE = 'P0002'; END IF;
  c := app.scar_for_write(l.scar_id);
  IF c.status IN ('closed', 'cancelled') THEN RAISE EXCEPTION 'A % SCAR cannot be changed', c.status USING ERRCODE = 'QM020'; END IF;
  IF l.ended_at IS NOT NULL THEN RAISE EXCEPTION 'That link has already ended' USING ERRCODE = 'QM020'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'Say why the non-conformance is being unlinked (3 to 1000 characters)' USING ERRCODE = 'QM020'; END IF;
  IF c.status <> 'draft' AND (SELECT count(*) FROM public.supplier_scar_ncrs WHERE scar_id = c.id AND ended_at IS NULL) = 1 THEN
    RAISE EXCEPTION 'An issued SCAR keeps at least one non-conformance' USING ERRCODE = 'QM020';
  END IF;
  UPDATE public.supplier_scar_ncrs SET ended_at = now(), ended_by = auth.uid(), end_reason = btrim(p_reason) WHERE id = l.id;
END $$;

-- ---------------------------------------------------------------------------
-- The stages
-- ---------------------------------------------------------------------------
-- Issue: needs a title, a response due date and at least one linked non-conformance.
CREATE FUNCTION app.issue_supplier_scar(p_scar uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.supplier_scars%ROWTYPE;
BEGIN
  c := app.scar_for_write(p_scar);
  IF c.status <> 'draft' THEN RAISE EXCEPTION 'Only a draft SCAR can be issued' USING ERRCODE = 'QM020'; END IF;
  IF c.response_due_on IS NULL THEN RAISE EXCEPTION 'Set the date the response is due before issuing' USING ERRCODE = 'QM020'; END IF;
  IF c.response_due_on < current_date THEN RAISE EXCEPTION 'The response due date has passed; set a new one before issuing' USING ERRCODE = 'QM020'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.supplier_scar_ncrs WHERE scar_id = c.id AND ended_at IS NULL) THEN RAISE EXCEPTION 'Link at least one non-conformance before issuing' USING ERRCODE = 'QM020'; END IF;
  PERFORM app.scar_set_status(c, 'issued', 'Issued to the supplier');
END $$;

-- The supplier confirmed they have it (recorded by us on their behalf).
CREATE FUNCTION app.acknowledge_supplier_scar(p_scar uuid, p_note text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.supplier_scars%ROWTYPE;
BEGIN
  c := app.scar_for_write(p_scar);
  IF c.status <> 'issued' THEN RAISE EXCEPTION 'Only an issued SCAR can be acknowledged' USING ERRCODE = 'QM020'; END IF;
  PERFORM app.scar_set_status(c, 'acknowledged', p_note);
END $$;

-- Record a response from the supplier. It never closes the SCAR: it waits for review.
CREATE FUNCTION app.record_scar_response(p_scar uuid, p_root_cause text, p_containment text, p_corrective_action text, p_preventive_action text, p_planned_completion_on date, p_responded_on date, p_responded_by text, p_contact uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.supplier_scars%ROWTYPE; v_seq integer; v_id uuid;
BEGIN
  c := app.scar_for_write(p_scar);
  IF c.status NOT IN ('issued', 'acknowledged', 'revision_requested') THEN RAISE EXCEPTION 'A response cannot be recorded while the SCAR is %', replace(c.status, '_', ' ') USING ERRCODE = 'QM020'; END IF;
  IF p_root_cause IS NULL OR length(btrim(p_root_cause)) NOT BETWEEN 3 AND 4000 THEN RAISE EXCEPTION 'The response needs a root cause (up to 4000 characters)' USING ERRCODE = 'QM020'; END IF;
  IF p_corrective_action IS NULL OR length(btrim(p_corrective_action)) NOT BETWEEN 3 AND 4000 THEN RAISE EXCEPTION 'The response needs a corrective action (up to 4000 characters)' USING ERRCODE = 'QM020'; END IF;
  IF p_responded_on IS NULL OR p_responded_on > current_date THEN RAISE EXCEPTION 'Say when the supplier responded (not in the future)' USING ERRCODE = 'QM020'; END IF;
  IF p_contact IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.supplier_contacts WHERE id = p_contact AND supplier_id = c.supplier_id AND organisation_id = c.organisation_id) THEN
    RAISE EXCEPTION 'That contact does not belong to this supplier' USING ERRCODE = 'QM020';
  END IF;
  SELECT coalesce(max(seq), 0) + 1 INTO v_seq FROM public.supplier_scar_responses WHERE scar_id = c.id;
  INSERT INTO public.supplier_scar_responses (organisation_id, scar_id, seq, root_cause, containment, corrective_action, preventive_action, planned_completion_on, responded_on, responded_by_name, contact_id)
  VALUES (c.organisation_id, c.id, v_seq, btrim(p_root_cause), nullif(btrim(coalesce(p_containment, '')), ''), btrim(p_corrective_action), nullif(btrim(coalesce(p_preventive_action, '')), ''),
          p_planned_completion_on, p_responded_on, nullif(btrim(coalesce(p_responded_by, '')), ''), p_contact) RETURNING id INTO v_id;
  PERFORM app.scar_set_status(c, 'response_received', 'Response ' || v_seq || ' received');
  RETURN v_id;
END $$;

CREATE FUNCTION app.start_scar_review(p_scar uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.supplier_scars%ROWTYPE;
BEGIN
  c := app.scar_for_write(p_scar);
  IF c.status <> 'response_received' THEN RAISE EXCEPTION 'There is no new response to review' USING ERRCODE = 'QM020'; END IF;
  PERFORM app.scar_set_status(c, 'under_review', 'Review started');
END $$;

-- Our decision on the latest response: accepted, or revision_requested (the supplier answers again).
CREATE FUNCTION app.review_scar_response(p_scar uuid, p_decision text, p_note text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.supplier_scars%ROWTYPE; r public.supplier_scar_responses%ROWTYPE; v_id uuid;
BEGIN
  c := app.scar_for_write(p_scar);
  IF c.status <> 'under_review' THEN RAISE EXCEPTION 'Start the review before deciding on the response' USING ERRCODE = 'QM020'; END IF;
  IF p_decision NOT IN ('accepted', 'revision_requested') THEN RAISE EXCEPTION 'Decide accepted or revision requested' USING ERRCODE = 'QM020'; END IF;
  IF p_note IS NULL OR length(btrim(p_note)) NOT BETWEEN 3 AND 2000 THEN RAISE EXCEPTION 'Say why (3 to 2000 characters)' USING ERRCODE = 'QM020'; END IF;
  SELECT * INTO r FROM public.supplier_scar_responses WHERE scar_id = c.id ORDER BY seq DESC LIMIT 1;
  INSERT INTO public.supplier_scar_reviews (organisation_id, scar_id, response_id, decision, note) VALUES (c.organisation_id, c.id, r.id, p_decision, btrim(p_note)) RETURNING id INTO v_id;
  PERFORM app.scar_set_status(c, p_decision, p_note);
  RETURN v_id;
END $$;

-- The accepted fix has been carried out. The first one moves the SCAR to verifying; more can be added while it waits.
CREATE FUNCTION app.record_scar_implementation(p_scar uuid, p_description text, p_implemented_on date, p_evidence_note text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.supplier_scars%ROWTYPE; v_id uuid;
BEGIN
  c := app.scar_for_write(p_scar);
  IF c.status NOT IN ('accepted', 'verifying') THEN RAISE EXCEPTION 'Implementation is recorded once a response is accepted' USING ERRCODE = 'QM020'; END IF;
  IF p_description IS NULL OR length(btrim(p_description)) NOT BETWEEN 3 AND 4000 THEN RAISE EXCEPTION 'Describe what was implemented (up to 4000 characters)' USING ERRCODE = 'QM020'; END IF;
  IF p_implemented_on IS NULL OR p_implemented_on > current_date THEN RAISE EXCEPTION 'Say when it was implemented (not in the future)' USING ERRCODE = 'QM020'; END IF;
  INSERT INTO public.supplier_scar_implementations (organisation_id, scar_id, description, implemented_on, evidence_note)
  VALUES (c.organisation_id, c.id, btrim(p_description), p_implemented_on, nullif(btrim(coalesce(p_evidence_note, '')), '')) RETURNING id INTO v_id;
  IF c.status = 'accepted' THEN PERFORM app.scar_set_status(c, 'verifying', 'Implementation recorded'); END IF;
  RETURN v_id;
END $$;

-- Effectiveness verification (supplier_quality.approve). Effective closes the SCAR; not effective sends it back for a new response.
CREATE FUNCTION app.record_scar_verification(p_scar uuid, p_result text, p_method text, p_note text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.supplier_scars%ROWTYPE; v_id uuid;
BEGIN
  c := app.scar_for_write(p_scar, 'supplier_quality.approve');
  IF c.status <> 'verifying' THEN RAISE EXCEPTION 'Effectiveness is verified after the fix has been implemented' USING ERRCODE = 'QM020'; END IF;
  IF p_result NOT IN ('effective', 'not_effective') THEN RAISE EXCEPTION 'The result is effective or not effective' USING ERRCODE = 'QM020'; END IF;
  IF p_method IS NULL OR length(btrim(p_method)) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'Say how effectiveness was checked (3 to 1000 characters)' USING ERRCODE = 'QM020'; END IF;
  IF p_note IS NULL OR length(btrim(p_note)) NOT BETWEEN 3 AND 2000 THEN RAISE EXCEPTION 'Record what was found (3 to 2000 characters)' USING ERRCODE = 'QM020'; END IF;
  INSERT INTO public.supplier_scar_verifications (organisation_id, scar_id, result, method, note) VALUES (c.organisation_id, c.id, p_result, btrim(p_method), btrim(p_note)) RETURNING id INTO v_id;
  IF p_result = 'effective' THEN
    PERFORM app.scar_set_status(c, 'closed', 'Verified effective');
  ELSE
    PERFORM app.scar_set_status(c, 'revision_requested', 'Not effective: ' || btrim(p_note));
  END IF;
  RETURN v_id;
END $$;

-- Move the response due date later, with a reason. Only while a response is still awaited.
CREATE FUNCTION app.extend_scar_due_date(p_scar uuid, p_new_due_on date, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.supplier_scars%ROWTYPE;
BEGIN
  c := app.scar_for_write(p_scar);
  IF c.status NOT IN ('issued', 'acknowledged', 'revision_requested') THEN RAISE EXCEPTION 'The due date can only move while a response is awaited' USING ERRCODE = 'QM020'; END IF;
  IF p_new_due_on IS NULL OR c.response_due_on IS NULL OR p_new_due_on <= c.response_due_on THEN RAISE EXCEPTION 'The new due date must be later than the current one' USING ERRCODE = 'QM020'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'Say why the due date is moving (3 to 1000 characters)' USING ERRCODE = 'QM020'; END IF;
  INSERT INTO public.supplier_scar_extensions (organisation_id, scar_id, previous_due_on, new_due_on, reason) VALUES (c.organisation_id, c.id, c.response_due_on, p_new_due_on, btrim(p_reason));
  UPDATE public.supplier_scars SET response_due_on = p_new_due_on, updated_by = auth.uid() WHERE id = c.id;
END $$;

CREATE FUNCTION app.cancel_supplier_scar(p_scar uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.supplier_scars%ROWTYPE;
BEGIN
  c := app.scar_for_write(p_scar);
  IF c.status IN ('closed', 'cancelled') THEN RAISE EXCEPTION 'A % SCAR cannot be cancelled', c.status USING ERRCODE = 'QM020'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'Say why the SCAR is being cancelled (3 to 1000 characters)' USING ERRCODE = 'QM020'; END IF;
  PERFORM app.scar_set_status(c, 'cancelled', p_reason);
END $$;

-- ---------------------------------------------------------------------------
-- Privileges: callable by signed-in users; each function checks tenant and permission itself.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app.scar_for_write(uuid, text), app.scar_set_status(public.supplier_scars, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.scar_frozen(), app.scar_status_guard(), app.scar_transition_allowed(text, text) FROM PUBLIC, anon;
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'create_supplier_scar(uuid,text,text,text,date,uuid,uuid[],uuid,text)', 'update_supplier_scar(uuid,jsonb)', 'link_scar_ncr(uuid,uuid)', 'unlink_scar_ncr(uuid,text)',
    'issue_supplier_scar(uuid)', 'acknowledge_supplier_scar(uuid,text)', 'record_scar_response(uuid,text,text,text,text,date,date,text,uuid)', 'start_scar_review(uuid)',
    'review_scar_response(uuid,text,text)', 'record_scar_implementation(uuid,text,date,text)', 'record_scar_verification(uuid,text,text,text)', 'extend_scar_due_date(uuid,date,text)', 'cancel_supplier_scar(uuid,text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION app.%s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION app.%s TO authenticated', f);
  END LOOP;
END $$;
