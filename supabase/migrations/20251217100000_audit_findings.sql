-- Audits, Phase A (docs/audits-plan.md §11): FINDINGS and promotion to a non-conformance.
--
--  * audit_finding_classifications: per organisation, seeded (major_nc, minor_nc, observation, ofi); audits.manage adds, renames, switches off, reorders. Key and kind never change; nothing is deleted.
--  * audit_findings (AF-YY-NNNN): belongs to one audit record and optionally to one answer; classification, title, what was found, the requirement, owner (employee), due date; open | closed | withdrawn.
--    Written only by functions (audits.perform creates / edits / withdraws; audits.manage closes / reopens). At most one live finding per answer.
--  * audit_finding_attachments: evidence on a finding (functions only, removed with a reason, never deleted), private audit-files bucket under <org>/audit/<record>/findings/<finding>/.
--  * app.create_ncr_from_audit_finding: a draft internal NC, once (idempotent: a live NC already linked is returned, created = false). Replaces app.raise_ncr_from_audit.
--  * A failed CRITICAL answer needs a live finding before the audit can be completed.
-- Errors QM018 → 409 audit_rule.

-- ---------------------------------------------------------------------------
-- Classifications
-- ---------------------------------------------------------------------------
CREATE TABLE public.audit_finding_classifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 60),
  kind text NOT NULL CHECK (kind IN ('nonconformity', 'observation', 'opportunity')),
  default_severity text CHECK (default_severity IN ('critical', 'major', 'minor')),
  sequence integer NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT audit_finding_classifications_key UNIQUE (organisation_id, key),
  CONSTRAINT audit_finding_classifications_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT audit_finding_classifications_severity CHECK (kind = 'nonconformity' OR default_severity IS NULL)
);

CREATE TRIGGER audit_finding_classifications_stamp BEFORE INSERT ON public.audit_finding_classifications FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER audit_finding_classifications_touch BEFORE UPDATE ON public.audit_finding_classifications FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER audit_finding_classifications_org_immutable BEFORE UPDATE ON public.audit_finding_classifications FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.audit_finding_classifications FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.audit_finding_classifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_finding_classifications FROM anon, authenticated;
GRANT SELECT, INSERT ON public.audit_finding_classifications TO authenticated;
-- Key and kind are fixed once created: findings rely on the kind.
GRANT UPDATE (label, default_severity, sequence, active) ON public.audit_finding_classifications TO authenticated;
CREATE POLICY audit_finding_classifications_select ON public.audit_finding_classifications FOR SELECT TO authenticated USING (app.has_permission(organisation_id, 'audits.read'));
CREATE POLICY audit_finding_classifications_insert ON public.audit_finding_classifications FOR INSERT TO authenticated WITH CHECK (app.has_permission(organisation_id, 'audits.manage'));
CREATE POLICY audit_finding_classifications_update ON public.audit_finding_classifications FOR UPDATE TO authenticated
  USING (app.has_permission(organisation_id, 'audits.manage')) WITH CHECK (app.has_permission(organisation_id, 'audits.manage'));

CREATE FUNCTION app.seed_audit_finding_classifications(p_organisation_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO public.audit_finding_classifications (organisation_id, key, label, kind, default_severity, sequence) VALUES
    (p_organisation_id, 'major_nc', 'Major non-conformity', 'nonconformity', 'major', 1),
    (p_organisation_id, 'minor_nc', 'Minor non-conformity', 'nonconformity', 'minor', 2),
    (p_organisation_id, 'observation', 'Observation', 'observation', NULL, 3),
    (p_organisation_id, 'ofi', 'Opportunity for improvement', 'opportunity', NULL, 4)
  ON CONFLICT (organisation_id, key) DO NOTHING
$$;

CREATE FUNCTION app.seed_audit_finding_classifications_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.seed_audit_finding_classifications(NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER organisations_seed_finding_classifications AFTER INSERT ON public.organisations FOR EACH ROW EXECUTE FUNCTION app.seed_audit_finding_classifications_trg();

-- Every organisation that exists now.
SELECT app.seed_audit_finding_classifications(o.id) FROM public.organisations o;

-- ---------------------------------------------------------------------------
-- Findings
-- ---------------------------------------------------------------------------
CREATE TABLE app.audit_finding_counters (
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  year integer NOT NULL,
  last_value integer NOT NULL DEFAULT 0,
  PRIMARY KEY (organisation_id, year)
);

CREATE TABLE public.audit_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  reference text NOT NULL,
  audit_record_id uuid NOT NULL,
  response_id uuid,
  classification_id uuid NOT NULL,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 4000),
  requirement text CHECK (requirement IS NULL OR length(btrim(requirement)) BETWEEN 1 AND 2000),
  owner_employee_id uuid,
  due_on date,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'withdrawn')),
  closed_note text CHECK (closed_note IS NULL OR length(btrim(closed_note)) BETWEEN 1 AND 2000),
  closed_at timestamptz,
  closed_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  reopen_reason text,
  withdraw_reason text CHECK (withdraw_reason IS NULL OR length(btrim(withdraw_reason)) BETWEEN 1 AND 2000),
  withdrawn_at timestamptz,
  withdrawn_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT audit_findings_reference_key UNIQUE (organisation_id, reference),
  CONSTRAINT audit_findings_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT audit_findings_id_record_key UNIQUE (id, audit_record_id),
  CONSTRAINT audit_findings_record_fkey FOREIGN KEY (audit_record_id, organisation_id) REFERENCES public.audit_records (id, organisation_id),
  CONSTRAINT audit_findings_response_fkey FOREIGN KEY (response_id, audit_record_id) REFERENCES public.audit_responses (id, audit_record_id),
  CONSTRAINT audit_findings_classification_fkey FOREIGN KEY (classification_id, organisation_id) REFERENCES public.audit_finding_classifications (id, organisation_id),
  CONSTRAINT audit_findings_owner_fkey FOREIGN KEY (owner_employee_id, organisation_id) REFERENCES public."Employees" (id, organisation_id),
  CONSTRAINT audit_findings_closed_shape CHECK (status <> 'closed' OR (closed_note IS NOT NULL AND closed_at IS NOT NULL)),
  CONSTRAINT audit_findings_withdrawn_shape CHECK (status <> 'withdrawn' OR (withdraw_reason IS NOT NULL AND withdrawn_at IS NOT NULL))
);
CREATE INDEX audit_findings_record_idx ON public.audit_findings (audit_record_id);
CREATE INDEX audit_findings_org_status_idx ON public.audit_findings (organisation_id, status);
CREATE INDEX audit_findings_owner_idx ON public.audit_findings (owner_employee_id) WHERE owner_employee_id IS NOT NULL;
-- At most one live finding per answer.
CREATE UNIQUE INDEX audit_findings_response_live ON public.audit_findings (response_id) WHERE response_id IS NOT NULL AND status <> 'withdrawn';

CREATE TRIGGER audit_findings_stamp BEFORE INSERT ON public.audit_findings FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER audit_findings_touch BEFORE UPDATE ON public.audit_findings FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER audit_findings_org_immutable BEFORE UPDATE ON public.audit_findings FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.audit_findings FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.audit_findings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_findings FROM anon, authenticated;
GRANT SELECT ON public.audit_findings TO authenticated;
CREATE POLICY audit_findings_select ON public.audit_findings FOR SELECT TO authenticated USING (app.has_permission(organisation_id, 'audits.read'));

-- A finding's NC link: the answer is optional now (a standalone finding has none), the finding is new.
ALTER TABLE public.audit_ncr_links ALTER COLUMN response_id DROP NOT NULL;
ALTER TABLE public.audit_ncr_links ADD COLUMN finding_id uuid;
ALTER TABLE public.audit_ncr_links ADD CONSTRAINT audit_ncr_links_finding_fkey FOREIGN KEY (finding_id, audit_record_id) REFERENCES public.audit_findings (id, audit_record_id);
ALTER TABLE public.audit_ncr_links ADD CONSTRAINT audit_ncr_links_finding_key UNIQUE (finding_id, nonconformance_id);
ALTER TABLE public.audit_ncr_links ADD CONSTRAINT audit_ncr_links_source CHECK (response_id IS NOT NULL OR finding_id IS NOT NULL);
CREATE INDEX audit_ncr_links_finding_idx ON public.audit_ncr_links (finding_id) WHERE finding_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Evidence on a finding
-- ---------------------------------------------------------------------------
CREATE TABLE public.audit_finding_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  audit_record_id uuid NOT NULL,
  finding_id uuid NOT NULL,
  storage_path text NOT NULL,
  file_name text NOT NULL CHECK (length(btrim(file_name)) BETWEEN 1 AND 255),
  content_type text,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 26214400),
  deleted_at timestamptz,
  deleted_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  delete_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT audit_finding_attachments_finding_fkey FOREIGN KEY (finding_id, audit_record_id) REFERENCES public.audit_findings (id, audit_record_id),
  CONSTRAINT audit_finding_attachments_org_fkey FOREIGN KEY (audit_record_id, organisation_id) REFERENCES public.audit_records (id, organisation_id),
  CONSTRAINT audit_finding_attachments_key UNIQUE (finding_id, storage_path),
  CONSTRAINT audit_finding_attachments_path CHECK (
    storage_path LIKE organisation_id::text || '/audit/' || audit_record_id::text || '/findings/' || finding_id::text || '/%' AND storage_path NOT LIKE '%..%')
);
CREATE INDEX audit_finding_attachments_finding_idx ON public.audit_finding_attachments (finding_id);

CREATE TRIGGER audit_finding_attachments_stamp BEFORE INSERT ON public.audit_finding_attachments FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER audit_finding_attachments_rules BEFORE UPDATE ON public.audit_finding_attachments FOR EACH ROW EXECUTE FUNCTION app.audit_attachment_rules();
CREATE TRIGGER audit_finding_attachments_touch BEFORE UPDATE ON public.audit_finding_attachments FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER audit_finding_attachments_org_immutable BEFORE UPDATE ON public.audit_finding_attachments FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER audit_finding_attachments_no_delete BEFORE DELETE ON public.audit_finding_attachments FOR EACH ROW EXECUTE FUNCTION app.audit_attachment_no_delete();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.audit_finding_attachments FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.audit_finding_attachments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_finding_attachments FROM anon, authenticated;
GRANT SELECT ON public.audit_finding_attachments TO authenticated;
CREATE POLICY audit_finding_attachments_select ON public.audit_finding_attachments FOR SELECT TO authenticated USING (app.has_permission(organisation_id, 'audits.read'));

-- Storage: question evidence stays as it was (<org>/audit/<record>/<file>, in-progress records only). Finding evidence lives under <org>/audit/<record>/findings/<finding>/<file>
-- and may be uploaded while that finding is open and the record is not abandoned.
CREATE OR REPLACE FUNCTION app.audit_file_allowed(p_object_name text, p_upload boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT split_part(p_object_name, '/', 2) = 'audit'
     AND EXISTS (
       SELECT 1 FROM public.audit_records r
       WHERE r.id = app.try_uuid(split_part(p_object_name, '/', 3))
         AND r.organisation_id = app.try_uuid(split_part(p_object_name, '/', 1))
         AND CASE WHEN p_upload
                  THEN app.has_permission(r.organisation_id, 'audits.perform')
                       AND CASE WHEN split_part(p_object_name, '/', 4) = 'findings'
                                THEN r.status <> 'abandoned'
                                     AND EXISTS (SELECT 1 FROM public.audit_findings f
                                                  WHERE f.id = app.try_uuid(split_part(p_object_name, '/', 5)) AND f.audit_record_id = r.id AND f.status = 'open')
                                ELSE r.status = 'in_progress' END
                  ELSE app.has_permission(r.organisation_id, 'audits.read') END)
$$;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
-- The finding, for someone who may perform audits; the record is not abandoned and (by default) the finding is open.
CREATE FUNCTION app.audit_finding_for_perform(p_id uuid, p_must_be_open boolean DEFAULT true) RETURNS public.audit_findings
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE f public.audit_findings%ROWTYPE; r public.audit_records%ROWTYPE;
BEGIN
  SELECT * INTO f FROM public.audit_findings WHERE id = p_id;
  IF NOT FOUND OR NOT app.has_permission(f.organisation_id, 'audits.read') THEN
    RAISE EXCEPTION 'Finding not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT app.has_permission(f.organisation_id, 'audits.perform') THEN
    RAISE EXCEPTION 'Recording findings needs the audits.perform permission' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO r FROM public.audit_records WHERE id = f.audit_record_id;
  IF r.status = 'abandoned' THEN
    RAISE EXCEPTION '% was abandoned; its findings can no longer be changed', r.reference USING ERRCODE = 'QM018';
  END IF;
  IF p_must_be_open AND f.status <> 'open' THEN
    RAISE EXCEPTION '% is %; it can no longer be changed', f.reference, f.status USING ERRCODE = 'QM018';
  END IF;
  RETURN f;
END $$;

-- The finding's live non-conformance (not cancelled, not deleted), if any.
CREATE FUNCTION app.audit_finding_live_ncr(p_finding uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT n.id FROM public.audit_ncr_links l JOIN public.nonconformances n ON n.id = l.nonconformance_id
   WHERE l.finding_id = p_finding AND n.deleted_at IS NULL AND n.stage <> 'cancelled'
   ORDER BY l.created_at DESC LIMIT 1
$$;

-- ---------------------------------------------------------------------------
-- Create a finding (from an answer, or standalone)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.create_audit_finding(p_record uuid, p_response uuid, p_classification uuid, p_title text, p_description text,
  p_requirement text DEFAULT NULL, p_owner uuid DEFAULT NULL, p_due_on date DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  r public.audit_records%ROWTYPE;
  c public.audit_finding_classifications%ROWTYPE;
  v_year integer := extract(year FROM now())::integer;
  v_n integer;
  v_id uuid;
  v_title text := nullif(btrim(coalesce(p_title, '')), '');
  v_desc text := nullif(btrim(coalesce(p_description, '')), '');
BEGIN
  r := app.audit_record_for_perform(p_record, false);
  IF r.status = 'abandoned' THEN
    RAISE EXCEPTION '% was abandoned; it can no longer be changed', r.reference USING ERRCODE = 'QM018';
  END IF;
  SELECT * INTO c FROM public.audit_finding_classifications WHERE id = p_classification AND organisation_id = r.organisation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Choose how the finding is classified' USING ERRCODE = 'QM018';
  END IF;
  IF NOT c.active THEN
    RAISE EXCEPTION 'The classification "%" is switched off', c.label USING ERRCODE = 'QM018';
  END IF;
  IF v_title IS NULL THEN
    RAISE EXCEPTION 'Give the finding a title' USING ERRCODE = 'QM018';
  END IF;
  IF v_desc IS NULL THEN
    RAISE EXCEPTION 'Say what was found' USING ERRCODE = 'QM018';
  END IF;
  IF p_response IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.audit_responses s WHERE s.id = p_response AND s.audit_record_id = p_record) THEN
      RAISE EXCEPTION 'That answer is not part of this audit' USING ERRCODE = 'QM018';
    END IF;
    IF EXISTS (SELECT 1 FROM public.audit_findings f WHERE f.response_id = p_response AND f.status <> 'withdrawn') THEN
      RAISE EXCEPTION 'That answer already has a finding' USING ERRCODE = 'QM018';
    END IF;
  END IF;
  IF p_owner IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public."Employees" e WHERE e.id = p_owner AND e.organisation_id = r.organisation_id) THEN
    RAISE EXCEPTION 'The owner is not an employee of this organisation' USING ERRCODE = 'QM018';
  END IF;

  INSERT INTO app.audit_finding_counters AS k (organisation_id, year, last_value) VALUES (r.organisation_id, v_year, 1)
  ON CONFLICT (organisation_id, year) DO UPDATE SET last_value = k.last_value + 1 RETURNING last_value INTO v_n;
  INSERT INTO public.audit_findings (organisation_id, reference, audit_record_id, response_id, classification_id, title, description, requirement, owner_employee_id, due_on)
  VALUES (r.organisation_id, 'AF-' || to_char(make_date(v_year, 1, 1), 'YY') || '-' || lpad(v_n::text, 4, '0'), p_record, p_response, p_classification,
          left(v_title, 200), left(v_desc, 4000), left(nullif(btrim(coalesce(p_requirement, '')), ''), 2000), p_owner, p_due_on)
  RETURNING id INTO v_id;
  PERFORM app.emit_event(r.organisation_id, 'audit.finding.created', 'audit_finding', v_id,
    jsonb_build_object('record', r.reference, 'classification', c.key, 'kind', c.kind, 'answer', p_response IS NOT NULL));
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------
-- Edit an open finding. p_changes holds only what changes; a key set to null clears owner, due date and requirement.
-- keys: classificationId, title, description, requirement, ownerId, dueOn
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.update_audit_finding(p_id uuid, p_changes jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  f public.audit_findings%ROWTYPE;
  c public.audit_finding_classifications%ROWTYPE;
  v_class uuid;
  v_title text;
  v_desc text;
  v_req text;
  v_owner uuid;
  v_due date;
BEGIN
  f := app.audit_finding_for_perform(p_id);
  IF p_changes IS NULL OR jsonb_typeof(p_changes) <> 'object' THEN
    RAISE EXCEPTION 'Nothing to change' USING ERRCODE = 'QM018';
  END IF;
  v_class := f.classification_id; v_title := f.title; v_desc := f.description; v_req := f.requirement; v_owner := f.owner_employee_id; v_due := f.due_on;

  IF p_changes ? 'classificationId' THEN
    v_class := nullif(p_changes->>'classificationId', '')::uuid;
    SELECT * INTO c FROM public.audit_finding_classifications WHERE id = v_class AND organisation_id = f.organisation_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Choose how the finding is classified' USING ERRCODE = 'QM018';
    END IF;
    IF v_class <> f.classification_id THEN
      IF NOT c.active THEN
        RAISE EXCEPTION 'The classification "%" is switched off', c.label USING ERRCODE = 'QM018';
      END IF;
      IF c.kind <> 'nonconformity' AND app.audit_finding_live_ncr(p_id) IS NOT NULL THEN
        RAISE EXCEPTION 'This finding has a non-conformance, so it must stay a non-conformity' USING ERRCODE = 'QM018';
      END IF;
    END IF;
  END IF;
  IF p_changes ? 'title' THEN
    v_title := nullif(btrim(coalesce(p_changes->>'title', '')), '');
    IF v_title IS NULL THEN RAISE EXCEPTION 'Give the finding a title' USING ERRCODE = 'QM018'; END IF;
  END IF;
  IF p_changes ? 'description' THEN
    v_desc := nullif(btrim(coalesce(p_changes->>'description', '')), '');
    IF v_desc IS NULL THEN RAISE EXCEPTION 'Say what was found' USING ERRCODE = 'QM018'; END IF;
  END IF;
  IF p_changes ? 'requirement' THEN
    v_req := nullif(btrim(coalesce(p_changes->>'requirement', '')), '');
  END IF;
  IF p_changes ? 'ownerId' THEN
    v_owner := nullif(p_changes->>'ownerId', '')::uuid;
    IF v_owner IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public."Employees" e WHERE e.id = v_owner AND e.organisation_id = f.organisation_id) THEN
      RAISE EXCEPTION 'The owner is not an employee of this organisation' USING ERRCODE = 'QM018';
    END IF;
  END IF;
  IF p_changes ? 'dueOn' THEN
    v_due := nullif(p_changes->>'dueOn', '')::date;
  END IF;

  UPDATE public.audit_findings SET classification_id = v_class, title = left(v_title, 200), description = left(v_desc, 4000), requirement = left(v_req, 2000),
         owner_employee_id = v_owner, due_on = v_due
   WHERE id = p_id;
END $$;

-- ---------------------------------------------------------------------------
-- Withdraw (a finding raised in error; needs a reason; not once it has a live non-conformance), close and reopen
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.withdraw_audit_finding(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE f public.audit_findings%ROWTYPE;
BEGIN
  f := app.audit_finding_for_perform(p_id);
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'Say why the finding is withdrawn' USING ERRCODE = 'QM018';
  END IF;
  IF app.audit_finding_live_ncr(p_id) IS NOT NULL THEN
    RAISE EXCEPTION '% has a non-conformance; cancel that first or close the finding instead', f.reference USING ERRCODE = 'QM018';
  END IF;
  UPDATE public.audit_findings SET status = 'withdrawn', withdraw_reason = btrim(p_reason), withdrawn_at = now(), withdrawn_by = auth.uid() WHERE id = p_id;
END $$;

CREATE FUNCTION app.close_audit_finding(p_id uuid, p_note text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE f public.audit_findings%ROWTYPE; v_ncr uuid; v_stage text; v_ref text;
BEGIN
  SELECT * INTO f FROM public.audit_findings WHERE id = p_id;
  IF NOT FOUND OR NOT app.has_permission(f.organisation_id, 'audits.read') THEN
    RAISE EXCEPTION 'Finding not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT app.has_permission(f.organisation_id, 'audits.manage') THEN
    RAISE EXCEPTION 'Closing a finding needs the audits.manage permission' USING ERRCODE = '42501';
  END IF;
  IF f.status <> 'open' THEN
    RAISE EXCEPTION '% is %', f.reference, f.status USING ERRCODE = 'QM018';
  END IF;
  IF p_note IS NULL OR length(btrim(p_note)) = 0 THEN
    RAISE EXCEPTION 'Say how the finding was resolved' USING ERRCODE = 'QM018';
  END IF;
  v_ncr := app.audit_finding_live_ncr(p_id);
  IF v_ncr IS NOT NULL THEN
    SELECT n.stage, n.reference INTO v_stage, v_ref FROM public.nonconformances n WHERE n.id = v_ncr;
    IF v_stage <> 'closed' THEN
      RAISE EXCEPTION 'Close the non-conformance % first', v_ref USING ERRCODE = 'QM018';
    END IF;
  END IF;
  UPDATE public.audit_findings SET status = 'closed', closed_note = btrim(p_note), closed_at = now(), closed_by = auth.uid(), reopen_reason = NULL WHERE id = p_id;
END $$;

CREATE FUNCTION app.reopen_audit_finding(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE f public.audit_findings%ROWTYPE;
BEGIN
  SELECT * INTO f FROM public.audit_findings WHERE id = p_id;
  IF NOT FOUND OR NOT app.has_permission(f.organisation_id, 'audits.read') THEN
    RAISE EXCEPTION 'Finding not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT app.has_permission(f.organisation_id, 'audits.manage') THEN
    RAISE EXCEPTION 'Reopening a finding needs the audits.manage permission' USING ERRCODE = '42501';
  END IF;
  IF f.status <> 'closed' THEN
    RAISE EXCEPTION '% is %; only a closed finding can be reopened', f.reference, f.status USING ERRCODE = 'QM018';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'Say why the finding is reopened' USING ERRCODE = 'QM018';
  END IF;
  UPDATE public.audit_findings SET status = 'open', reopen_reason = btrim(p_reason), closed_note = NULL, closed_at = NULL, closed_by = NULL WHERE id = p_id;
END $$;

-- ---------------------------------------------------------------------------
-- Promote a finding to a draft non-conformance, once. Returns { nonconformanceId, created }.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.create_ncr_from_audit_finding(p_finding uuid, p_title text DEFAULT NULL, p_description text DEFAULT NULL, p_severity text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  f public.audit_findings%ROWTYPE;
  r public.audit_records%ROWTYPE;
  c public.audit_finding_classifications%ROWTYPE;
  v_ncr uuid;
  v_site uuid;
  v_title text;
  v_severity text;
BEGIN
  -- Lock the finding first: two people pressing the button at once end up with one NC.
  SELECT * INTO f FROM public.audit_findings WHERE id = p_finding FOR UPDATE;
  IF NOT FOUND OR NOT app.has_permission(f.organisation_id, 'audits.read') THEN
    RAISE EXCEPTION 'Finding not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT app.has_permission(f.organisation_id, 'ncr.create') THEN
    RAISE EXCEPTION 'You may not raise non-conformances' USING ERRCODE = '42501';
  END IF;
  IF f.status <> 'open' THEN
    RAISE EXCEPTION '% is %; only an open finding can be raised as a non-conformance', f.reference, f.status USING ERRCODE = 'QM018';
  END IF;
  SELECT * INTO c FROM public.audit_finding_classifications WHERE id = f.classification_id;
  IF c.kind <> 'nonconformity' THEN
    RAISE EXCEPTION 'Only a finding classified as a non-conformity can be raised as a non-conformance' USING ERRCODE = 'QM018';
  END IF;
  SELECT * INTO r FROM public.audit_records WHERE id = f.audit_record_id;
  IF r.status = 'abandoned' THEN
    RAISE EXCEPTION '% was abandoned', r.reference USING ERRCODE = 'QM018';
  END IF;

  v_ncr := app.audit_finding_live_ncr(p_finding);
  IF v_ncr IS NOT NULL THEN
    RETURN jsonb_build_object('nonconformanceId', v_ncr, 'created', false);
  END IF;

  v_title := coalesce(nullif(btrim(coalesce(p_title, '')), ''), f.title);
  v_severity := coalesce(nullif(p_severity, ''), c.default_severity);
  IF v_severity IS NOT NULL AND v_severity NOT IN ('critical', 'major', 'minor') THEN
    RAISE EXCEPTION 'The severity must be critical, major or minor' USING ERRCODE = 'QM018';
  END IF;
  SELECT m.site_id INTO v_site FROM public.audit_record_targets x JOIN public.machines m ON m.id = x.machine_id
   WHERE x.audit_record_id = f.audit_record_id AND m.site_id IS NOT NULL ORDER BY x.created_at LIMIT 1;

  INSERT INTO public.nonconformances (organisation_id, reference, source, stage, severity, title, description, requirement, actual_result, site_id, detected_at, detected_by)
  VALUES (f.organisation_id, 'pending', 'internal', 'draft', v_severity, left(v_title, 200),
          coalesce(nullif(btrim(coalesce(p_description, '')), ''), format('Raised from audit %s, finding %s.', r.reference, f.reference)),
          f.requirement, f.description, v_site, r.performed_on, auth.uid())
  RETURNING id INTO v_ncr;
  INSERT INTO public.audit_ncr_links (organisation_id, audit_record_id, response_id, finding_id, nonconformance_id)
  VALUES (f.organisation_id, f.audit_record_id, f.response_id, f.id, v_ncr);
  PERFORM app.emit_event(f.organisation_id, 'audit.finding.ncr_created', 'audit_finding', f.id,
    jsonb_build_object('finding', f.reference, 'record', r.reference, 'nonconformance_id', v_ncr));
  RETURN jsonb_build_object('nonconformanceId', v_ncr, 'created', true);
END $$;

-- ---------------------------------------------------------------------------
-- Evidence files on a finding
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.add_audit_finding_attachment(p_finding uuid, p_storage_path text, p_file_name text, p_content_type text, p_size_bytes bigint) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE f public.audit_findings%ROWTYPE; v_id uuid;
BEGIN
  f := app.audit_finding_for_perform(p_finding);
  IF p_storage_path NOT LIKE f.organisation_id::text || '/audit/' || f.audit_record_id::text || '/findings/' || f.id::text || '/%' THEN
    RAISE EXCEPTION 'The file must be stored in this finding''s folder' USING ERRCODE = 'QM018';
  END IF;
  INSERT INTO public.audit_finding_attachments (organisation_id, audit_record_id, finding_id, storage_path, file_name, content_type, size_bytes)
  VALUES (f.organisation_id, f.audit_record_id, f.id, p_storage_path, btrim(p_file_name), p_content_type, p_size_bytes) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION app.remove_audit_finding_attachment(p_attachment uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_finding uuid; v_removed timestamptz;
BEGIN
  SELECT finding_id, deleted_at INTO v_finding, v_removed FROM public.audit_finding_attachments WHERE id = p_attachment;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'File not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM app.audit_finding_for_perform(v_finding);
  IF v_removed IS NOT NULL THEN
    RAISE EXCEPTION 'That file is already removed' USING ERRCODE = 'QM018';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'Say why the file is removed' USING ERRCODE = 'QM018';
  END IF;
  UPDATE public.audit_finding_attachments SET deleted_at = now(), deleted_by = auth.uid(), delete_reason = btrim(p_reason) WHERE id = p_attachment;
END $$;

CREATE FUNCTION app.restore_audit_finding_attachment(p_attachment uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_finding uuid; v_removed timestamptz;
BEGIN
  SELECT finding_id, deleted_at INTO v_finding, v_removed FROM public.audit_finding_attachments WHERE id = p_attachment;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'File not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM app.audit_finding_for_perform(v_finding);
  IF v_removed IS NULL THEN
    RAISE EXCEPTION 'That file is not removed' USING ERRCODE = 'QM018';
  END IF;
  UPDATE public.audit_finding_attachments SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL WHERE id = p_attachment;
END $$;

-- ---------------------------------------------------------------------------
-- What is still needed before the record can be completed: a failed critical answer needs a live finding.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.audit_record_problems(p_id uuid) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  r public.audit_records%ROWTYPE;
  v_problems text[] := ARRAY[]::text[];
  v_unanswered integer[];
  v_nofile integer[];
  v_nonote integer[];
  v_nofinding integer[];
BEGIN
  SELECT * INTO r FROM public.audit_records WHERE id = p_id;
  IF NOT FOUND OR NOT app.has_permission(r.organisation_id, 'audits.read') THEN
    RETURN v_problems;
  END IF;
  SELECT coalesce(array_agg(q.sequence ORDER BY q.sequence), ARRAY[]::integer[]) INTO v_unanswered
    FROM public.audit_record_questions q
   WHERE q.audit_record_id = p_id AND q.answer_type NOT IN ('text', 'evidence') AND NOT EXISTS (SELECT 1 FROM public.audit_responses s WHERE s.record_question_id = q.id);
  IF cardinality(v_unanswered) > 0 THEN
    v_problems := array_append(v_problems, CASE WHEN cardinality(v_unanswered) = 1 THEN format('question %s is not answered', v_unanswered[1])
                                                ELSE format('%s questions are not answered (first: question %s)', cardinality(v_unanswered), v_unanswered[1]) END);
  END IF;
  SELECT coalesce(array_agg(q.sequence ORDER BY q.sequence), ARRAY[]::integer[]) INTO v_nofile
    FROM public.audit_record_questions q
   WHERE q.audit_record_id = p_id AND q.answer_type = 'evidence' AND NOT EXISTS (SELECT 1 FROM public.audit_attachments a WHERE a.record_question_id = q.id AND a.deleted_at IS NULL);
  IF cardinality(v_nofile) > 0 THEN
    v_problems := array_append(v_problems, format('add a photograph or document to question%s %s', CASE WHEN cardinality(v_nofile) = 1 THEN '' ELSE 's' END, array_to_string(v_nofile, ', ')));
  END IF;
  SELECT coalesce(array_agg(q.sequence ORDER BY q.sequence), ARRAY[]::integer[]) INTO v_nonote
    FROM public.audit_record_questions q JOIN public.audit_responses s ON s.record_question_id = q.id
   WHERE q.audit_record_id = p_id AND s.result = 'fail' AND s.note IS NULL;
  IF cardinality(v_nonote) > 0 THEN
    v_problems := array_append(v_problems, format('say what was found for the failed question%s: %s', CASE WHEN cardinality(v_nonote) = 1 THEN '' ELSE 's' END, array_to_string(v_nonote, ', ')));
  END IF;
  SELECT coalesce(array_agg(q.sequence ORDER BY q.sequence), ARRAY[]::integer[]) INTO v_nofinding
    FROM public.audit_record_questions q JOIN public.audit_responses s ON s.record_question_id = q.id
   WHERE q.audit_record_id = p_id AND q.critical AND s.result = 'fail'
     AND NOT EXISTS (SELECT 1 FROM public.audit_findings f WHERE f.response_id = s.id AND f.status <> 'withdrawn');
  IF cardinality(v_nofinding) > 0 THEN
    v_problems := array_append(v_problems, format('raise a finding for the failed critical question%s: %s', CASE WHEN cardinality(v_nofinding) = 1 THEN '' ELSE 's' END, array_to_string(v_nofinding, ', ')));
  END IF;
  IF EXISTS (SELECT 1 FROM public.audit_targets t WHERE t.audit_definition_id = r.audit_definition_id)
     AND NOT EXISTS (SELECT 1 FROM public.audit_record_targets x WHERE x.audit_record_id = p_id) THEN
    v_problems := array_append(v_problems, 'choose which machines, operations or departments it was carried out on');
  END IF;
  RETURN v_problems;
END $$;

-- ---------------------------------------------------------------------------
-- The direct path from an answer to a non-conformance goes: a finding is raised first.
-- ---------------------------------------------------------------------------
DROP FUNCTION app.raise_ncr_from_audit(uuid, uuid[], text, text, text);

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
REVOKE ALL ON TABLE app.audit_finding_counters FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.seed_audit_finding_classifications(uuid), app.seed_audit_finding_classifications_trg(),
  app.audit_finding_for_perform(uuid, boolean), app.audit_finding_live_ncr(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.create_audit_finding(uuid, uuid, uuid, text, text, text, uuid, date), app.update_audit_finding(uuid, jsonb),
  app.withdraw_audit_finding(uuid, text), app.close_audit_finding(uuid, text), app.reopen_audit_finding(uuid, text),
  app.create_ncr_from_audit_finding(uuid, text, text, text),
  app.add_audit_finding_attachment(uuid, text, text, text, bigint), app.remove_audit_finding_attachment(uuid, text), app.restore_audit_finding_attachment(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.create_audit_finding(uuid, uuid, uuid, text, text, text, uuid, date), app.update_audit_finding(uuid, jsonb),
  app.withdraw_audit_finding(uuid, text), app.close_audit_finding(uuid, text), app.reopen_audit_finding(uuid, text),
  app.create_ncr_from_audit_finding(uuid, text, text, text),
  app.add_audit_finding_attachment(uuid, text, text, text, bigint), app.remove_audit_finding_attachment(uuid, text), app.restore_audit_finding_attachment(uuid) TO authenticated;
