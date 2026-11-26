-- PPAP, slice PP3 (docs/ppap-plan.md): the Part Submission Warrant, submitting, the customer's decision, withdrawing what was sent, resubmitting, and the periodic review.
--
--  * ppap_psw: one warrant per submission. The typed fields (weight, purchase order, engineering change level, whether the results meet the requirements and, if not, why) are saved by
--    a PPAP manager while the submission is being prepared; the rest of the form (part, revision, customer, site, reason, level) is read from the submission when it is shown. It is SIGNED
--    by an approver who is NOT the preparer: not the submission's owner, not whoever created it, not whoever last saved the typed fields. Signing freezes the typed fields; an approver can
--    take the signature off (with a reason) while the submission is still being prepared. Submitting freezes it for good.
--  * Submitting (app.submit_ppap): the submission must be ready and its "still needed" list empty NOW (a linked record may have changed since it was marked ready); every link is frozen
--    (app.ppap_freeze_links), the warrant is frozen, the status moves to submitted and a 'submitted' decision is written, all in one transaction.
--  * ppap_decisions: what happened and when, append-only and frozen even for SQL: submitted (when, how), approved, interim approved (expiry date, conditions), rejected (reason), withdrawn
--    (reason), each with the customer's reference and, optionally, their signed warrant as a file. The status moves only through these functions: a transaction setting that only they set
--    (app.ppap_lifecycle) is needed to move a submission to submitted, approved, interim approved or rejected, or to withdraw one that was sent, so even SQL cannot do it by hand.
--    Interim expiry is worked out on read (an interim approval whose date has passed still stands as the customer's last word until a new decision is recorded); nothing is stored.
--  * app.withdraw_ppap is replaced: before sending it is a manager's act as before; once sent it needs ppap.approve and is recorded as a 'withdrawn' decision.
--  * app.start_ppap_resubmission: a NEW submission that names the one it replaces (rejected, withdrawn after sending, or approved and due for revalidation). Links and notes are carried
--    over unfrozen so they follow the current records; files are not copied (they stay on the earlier submission); waivers and the signature are not carried.
--  * ppap_reviews + submissions.next_review_on: an approved submission is reviewed every 12 months by default; a review records "no change" (with a note) and the next date, or the resubmission
--    that was started. Overdue is worked out on read.
--  Not here: notices, workflow triggers and reminders (PP6), the customer answering in the portal (PP4).

-- ---------------------------------------------------------------------------
-- 0. Helpers
-- ---------------------------------------------------------------------------
CREATE FUNCTION pg_temp.patch_once(p_fn regprocedure, p_marker text, p_old text, p_new text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_def text := replace(pg_get_functiondef(p_fn), E'\r', ''); v_n integer;
BEGIN
  IF position(p_marker IN v_def) > 0 THEN RETURN; END IF;
  v_n := (length(v_def) - length(replace(v_def, p_old, ''))) / length(p_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'Expected to find % exactly once in %, found % times', p_old, p_fn, v_n; END IF;
  EXECUTE replace(v_def, p_old, p_new);
END $$;

-- ---------------------------------------------------------------------------
-- 1. The submission: when it is next reviewed, and who may move its status
-- ---------------------------------------------------------------------------
ALTER TABLE public.ppap_submissions ADD COLUMN next_review_on date;

-- The default interval between reviews of an approved submission.
CREATE FUNCTION app.ppap_review_months() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path = '' AS $$ SELECT 12 $$;

CREATE OR REPLACE FUNCTION app.ppap_submission_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_life boolean := current_setting('app.ppap_lifecycle', true) = 'on';
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A PPAP submission is never deleted. Withdraw it with a reason.' USING ERRCODE = 'QM037'; END IF;
  IF (NEW.reference, NEW.direction, NEW.part_id, NEW.part_revision_id, NEW.customer_id, NEW.supplier_id, NEW.requirement_set_id, NEW.replaces_id, NEW.client_key)
     IS DISTINCT FROM (OLD.reference, OLD.direction, OLD.part_id, OLD.part_revision_id, OLD.customer_id, OLD.supplier_id, OLD.requirement_set_id, OLD.replaces_id, OLD.client_key) THEN
    RAISE EXCEPTION 'A submission''s reference, part revision, customer or supplier, requirements and origin never change' USING ERRCODE = 'QM037';
  END IF;
  IF NEW.status <> OLD.status AND NOT app.ppap_status_move_allowed(OLD.status, NEW.status) THEN
    RAISE EXCEPTION 'A submission cannot move from % to %', replace(OLD.status, '_', ' '), replace(NEW.status, '_', ' ') USING ERRCODE = 'QM037';
  END IF;
  -- Sending, the customer's decision and withdrawing what was sent are recorded as decisions, through their own functions only.
  IF NEW.status <> OLD.status AND (NEW.status IN ('submitted', 'approved', 'interim_approved', 'rejected') OR (NEW.status = 'withdrawn' AND OLD.status IN ('submitted', 'interim_approved'))) AND NOT v_life THEN
    RAISE EXCEPTION 'A submission moves to % only by recording it (submit it, record the customer''s decision, or withdraw it)', replace(NEW.status, '_', ' ') USING ERRCODE = 'QM037';
  END IF;
  IF NEW.next_review_on IS DISTINCT FROM OLD.next_review_on AND NOT v_life THEN
    RAISE EXCEPTION 'The review date moves only when a decision or a review is recorded' USING ERRCODE = 'QM037';
  END IF;
  IF OLD.status NOT IN ('draft', 'in_preparation')
     AND (NEW.level, NEW.reason, NEW.site_id, NEW.owner_user_id, NEW.notes) IS DISTINCT FROM (OLD.level, OLD.reason, OLD.site_id, OLD.owner_user_id, OLD.notes) THEN
    RAISE EXCEPTION 'A submission that is %, not being prepared, cannot be changed', replace(OLD.status, '_', ' ') USING ERRCODE = 'QM037';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- 2. The warrant
-- ---------------------------------------------------------------------------
CREATE TABLE public.ppap_psw (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  submission_id uuid NOT NULL,
  part_weight numeric(14, 4) CHECK (part_weight IS NULL OR part_weight > 0),
  weight_unit text CHECK (weight_unit IS NULL OR weight_unit IN ('kg', 'g', 'lb', 'oz')),
  purchase_order text CHECK (purchase_order IS NULL OR length(btrim(purchase_order)) BETWEEN 1 AND 100),
  engineering_change_level text CHECK (engineering_change_level IS NULL OR length(btrim(engineering_change_level)) BETWEEN 1 AND 100),
  results_meet_requirements boolean,
  declaration text CHECK (declaration IS NULL OR length(btrim(declaration)) BETWEEN 1 AND 2000),
  prepared_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  signer_user_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  signer_name text CHECK (signer_name IS NULL OR length(btrim(signer_name)) BETWEEN 1 AND 200),
  signer_title text CHECK (signer_title IS NULL OR length(btrim(signer_title)) BETWEEN 1 AND 100),
  signer_phone text CHECK (signer_phone IS NULL OR length(btrim(signer_phone)) BETWEEN 1 AND 50),
  signed_at timestamptz,
  signed_on date,
  unsigned_at timestamptz,
  unsigned_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  unsign_reason text CHECK (unsign_reason IS NULL OR length(btrim(unsign_reason)) BETWEEN 3 AND 500),
  frozen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT ppap_psw_submission_key UNIQUE (submission_id),
  CONSTRAINT ppap_psw_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT ppap_psw_submission_fkey FOREIGN KEY (submission_id, organisation_id) REFERENCES public.ppap_submissions (id, organisation_id),
  CONSTRAINT ppap_psw_weight_pair CHECK ((part_weight IS NULL) = (weight_unit IS NULL)),
  CONSTRAINT ppap_psw_signed_state CHECK ((signed_at IS NULL) = (signer_user_id IS NULL AND signer_name IS NULL AND signed_on IS NULL) OR (signed_at IS NOT NULL AND signer_user_id IS NOT NULL AND signer_name IS NOT NULL AND signed_on IS NOT NULL)),
  CONSTRAINT ppap_psw_frozen_signed CHECK (frozen_at IS NULL OR signed_at IS NOT NULL)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ppap_psw'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION app.stamp_created()', t || '_stamp', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.touch_updated()', t || '_touch', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change()', t || '_org_immutable', t);
    EXECUTE format('CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION audit.record_change(''organisation_id'')', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
  END LOOP;
END $$;
CREATE POLICY ppap_psw_select ON public.ppap_psw FOR SELECT TO authenticated USING (app.ppap_readable(submission_id));

-- Never deleted. The typed fields change only while the submission is being prepared and the warrant is not signed. The signature (who, when) changes only inside the signing and
-- unsigning functions (a transaction setting); the freeze only inside submit. A frozen warrant changes no more.
CREATE FUNCTION app.ppap_psw_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_status text; v_signing boolean := current_setting('app.ppap_psw_signing', true) = 'on'; v_life boolean := current_setting('app.ppap_lifecycle', true) = 'on';
        v_typed_new jsonb; v_typed_old jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A warrant is never deleted' USING ERRCODE = 'QM037'; END IF;
  SELECT status INTO v_status FROM public.ppap_submissions WHERE id = NEW.submission_id;
  IF TG_OP = 'INSERT' THEN
    IF v_status NOT IN ('draft', 'in_preparation') THEN RAISE EXCEPTION 'The warrant is made while the submission is being prepared' USING ERRCODE = 'QM037'; END IF;
    IF NEW.signed_at IS NOT NULL OR NEW.frozen_at IS NOT NULL THEN RAISE EXCEPTION 'A new warrant is not signed' USING ERRCODE = 'QM037'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.frozen_at IS NOT NULL THEN RAISE EXCEPTION 'The warrant was frozen when the submission was sent and cannot change' USING ERRCODE = 'QM037'; END IF;
  IF NEW.submission_id <> OLD.submission_id THEN RAISE EXCEPTION 'A warrant stays with its submission' USING ERRCODE = 'QM037'; END IF;
  IF NEW.frozen_at IS DISTINCT FROM OLD.frozen_at AND NOT v_life THEN RAISE EXCEPTION 'The warrant is frozen only by submitting' USING ERRCODE = 'QM037'; END IF;
  IF (NEW.signer_user_id, NEW.signer_name, NEW.signer_title, NEW.signer_phone, NEW.signed_at, NEW.signed_on, NEW.unsigned_at, NEW.unsigned_by, NEW.unsign_reason)
     IS DISTINCT FROM (OLD.signer_user_id, OLD.signer_name, OLD.signer_title, OLD.signer_phone, OLD.signed_at, OLD.signed_on, OLD.unsigned_at, OLD.unsigned_by, OLD.unsign_reason) AND NOT v_signing THEN
    RAISE EXCEPTION 'The warrant is signed or unsigned only by signing it' USING ERRCODE = 'QM037';
  END IF;
  v_typed_new := to_jsonb(NEW) - 'signer_user_id' - 'signer_name' - 'signer_title' - 'signer_phone' - 'signed_at' - 'signed_on' - 'unsigned_at' - 'unsigned_by' - 'unsign_reason' - 'frozen_at' - 'updated_at' - 'updated_by';
  v_typed_old := to_jsonb(OLD) - 'signer_user_id' - 'signer_name' - 'signer_title' - 'signer_phone' - 'signed_at' - 'signed_on' - 'unsigned_at' - 'unsigned_by' - 'unsign_reason' - 'frozen_at' - 'updated_at' - 'updated_by';
  IF v_typed_new IS DISTINCT FROM v_typed_old THEN
    IF v_status NOT IN ('draft', 'in_preparation') THEN RAISE EXCEPTION 'The warrant changes only while the submission is being prepared' USING ERRCODE = 'QM037'; END IF;
    IF OLD.signed_at IS NOT NULL THEN RAISE EXCEPTION 'The warrant is signed. An approver must take the signature off before it is changed.' USING ERRCODE = 'QM037'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ppap_psw_rules BEFORE INSERT OR UPDATE OR DELETE ON public.ppap_psw FOR EACH ROW EXECUTE FUNCTION app.ppap_psw_rules();

-- ---------------------------------------------------------------------------
-- 3. Decisions and reviews (append-only, frozen even for SQL)
-- ---------------------------------------------------------------------------
CREATE TABLE public.ppap_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  submission_id uuid NOT NULL,
  seq integer NOT NULL CHECK (seq >= 1),
  kind text NOT NULL CHECK (kind IN ('submitted', 'approved', 'interim_approved', 'rejected', 'withdrawn')),
  decided_on date NOT NULL,
  how text CHECK (how IS NULL OR length(btrim(how)) BETWEEN 1 AND 200),
  their_reference text CHECK (their_reference IS NULL OR length(btrim(their_reference)) BETWEEN 1 AND 100),
  expires_on date,
  note text CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 2000),
  storage_path text,
  file_name text CHECK (file_name IS NULL OR length(btrim(file_name)) BETWEEN 1 AND 255),
  content_type text,
  size_bytes bigint CHECK (size_bytes IS NULL OR (size_bytes >= 0 AND size_bytes <= 26214400)),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT ppap_decisions_seq_key UNIQUE (submission_id, seq),
  CONSTRAINT ppap_decisions_submission_fkey FOREIGN KEY (submission_id, organisation_id) REFERENCES public.ppap_submissions (id, organisation_id),
  CONSTRAINT ppap_decisions_file_shape CHECK ((storage_path IS NULL) = (file_name IS NULL) AND (storage_path IS NULL OR size_bytes IS NOT NULL)),
  CONSTRAINT ppap_decisions_path CHECK (storage_path IS NULL OR (storage_path LIKE organisation_id::text || '/ppap/' || submission_id::text || '/%' AND storage_path NOT LIKE '%..%')),
  CONSTRAINT ppap_decisions_interim_shape CHECK ((kind = 'interim_approved') = (expires_on IS NOT NULL) AND (expires_on IS NULL OR expires_on > decided_on)),
  CONSTRAINT ppap_decisions_reason_shape CHECK (kind NOT IN ('interim_approved', 'rejected', 'withdrawn') OR note IS NOT NULL)
);
CREATE INDEX ppap_decisions_submission_idx ON public.ppap_decisions (organisation_id, submission_id, seq);

CREATE TABLE public.ppap_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  submission_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('no_change', 'resubmission_started')),
  note text CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 1000),
  next_review_on date,
  new_submission_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT ppap_reviews_submission_fkey FOREIGN KEY (submission_id, organisation_id) REFERENCES public.ppap_submissions (id, organisation_id),
  CONSTRAINT ppap_reviews_new_fkey FOREIGN KEY (new_submission_id, organisation_id) REFERENCES public.ppap_submissions (id, organisation_id),
  CONSTRAINT ppap_reviews_shape CHECK ((outcome = 'no_change' AND note IS NOT NULL AND next_review_on IS NOT NULL AND new_submission_id IS NULL)
                                    OR (outcome = 'resubmission_started' AND new_submission_id IS NOT NULL AND next_review_on IS NULL))
);
CREATE INDEX ppap_reviews_submission_idx ON public.ppap_reviews (organisation_id, submission_id, created_at);

CREATE FUNCTION app.ppap_frozen_rows() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'A recorded PPAP decision or review is never changed or deleted' USING ERRCODE = 'QM037';
END $$;

-- A decision or a review is written only by the functions that record it (they set the lifecycle switch), so even SQL cannot add one by hand.
CREATE FUNCTION app.ppap_record_insert_rule() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF current_setting('app.ppap_lifecycle', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'A PPAP decision or review is recorded through its own function, not written directly' USING ERRCODE = 'QM037';
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ppap_decisions', 'ppap_reviews'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION app.ppap_record_insert_rule()', t || '_insert_rule', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION app.stamp_created()', t || '_stamp', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.ppap_frozen_rows()', t || '_frozen', t);
    EXECUTE format('CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION audit.record_change(''organisation_id'')', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
  END LOOP;
END $$;
CREATE POLICY ppap_decisions_select ON public.ppap_decisions FOR SELECT TO authenticated USING (app.ppap_readable(submission_id));
CREATE POLICY ppap_reviews_select ON public.ppap_reviews FOR SELECT TO authenticated USING (app.ppap_readable(submission_id));

-- The customer's signed warrant is uploaded after sending: an approver may upload into a submission that was sent and not finally decided; a manager only while it is being prepared.
CREATE OR REPLACE FUNCTION app.ppap_file_allowed(p_object_name text, p_upload boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT split_part(p_object_name, '/', 2) = 'ppap'
     AND EXISTS (
       SELECT 1 FROM public.ppap_submissions s
        WHERE s.id = app.try_uuid(split_part(p_object_name, '/', 3))
          AND s.organisation_id = app.try_uuid(split_part(p_object_name, '/', 1))
          AND CASE WHEN p_upload
                   THEN (s.status IN ('draft', 'in_preparation') AND app.has_permission(s.organisation_id, 'ppap.manage'))
                     OR (s.status IN ('submitted', 'interim_approved') AND app.has_permission(s.organisation_id, 'ppap.approve'))
                   ELSE app.ppap_readable(s.id) END)
$$;

-- ---------------------------------------------------------------------------
-- 4. What a submission still needs: now also the warrant
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.ppap_problems(p_submission uuid) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.ppap_submissions%ROWTYPE; e record; v record; i jsonb; w public.ppap_psw%ROWTYPE; out text[] := '{}'::text[]; v_live integer; v_missing text[];
BEGIN
  IF NOT app.ppap_readable(p_submission) THEN RAISE EXCEPTION 'Submission not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO s FROM public.ppap_submissions WHERE id = p_submission;
  FOR e IN SELECT x.*, t.label, t.ordinal FROM public.ppap_elements x JOIN app.ppap_element_types() t ON t.key = x.element_key
            WHERE x.submission_id = p_submission AND x.requirement = 'required' AND x.status <> 'waived' AND x.element_key <> 'part_submission_warrant' ORDER BY t.ordinal LOOP
    SELECT count(*) INTO v_live FROM public.ppap_evidence v2 WHERE v2.element_id = e.id AND v2.removed_at IS NULL;
    IF v_live = 0 THEN
      out := out || (e.label || ': add evidence, or ask an approver to waive it');
      CONTINUE;
    END IF;
    FOR v IN SELECT * FROM public.ppap_evidence v2 WHERE v2.element_id = e.id AND v2.removed_at IS NULL AND v2.kind = 'link' ORDER BY v2.created_at LOOP
      i := app.ppap_target_info(v.target_kind, v.target_id, s.part_id, e.element_key);
      IF i IS NULL THEN
        out := out || (e.label || ': a linked record cannot be found');
      ELSIF NOT (i ->> 'ok')::boolean THEN
        out := out || (e.label || ': ' || CASE WHEN app.ppap_target_readable(v.target_kind, v.target_id) THEN i ->> 'label' ELSE 'a linked record' END || ' ' || coalesce(i ->> 'problem', 'is not in good standing'));
      END IF;
    END LOOP;
    IF e.status <> 'ready' THEN out := out || (e.label || ': mark it ready'); END IF;
  END LOOP;
  -- The warrant: typed, then signed by someone who did not prepare it.
  IF EXISTS (SELECT 1 FROM public.ppap_elements x WHERE x.submission_id = p_submission AND x.element_key = 'part_submission_warrant' AND x.requirement = 'required' AND x.status <> 'waived') THEN
    SELECT * INTO w FROM public.ppap_psw WHERE submission_id = p_submission;
    IF NOT FOUND THEN
      out := out || 'Part Submission Warrant: fill it in (weight and whether the results meet the requirements), then ask an approver to sign it'::text;
    ELSE
      v_missing := '{}'::text[];
      IF w.part_weight IS NULL THEN v_missing := v_missing || 'the part weight'::text; END IF;
      IF w.results_meet_requirements IS NULL THEN v_missing := v_missing || 'whether the results meet the requirements'::text; END IF;
      IF w.results_meet_requirements IS FALSE AND w.declaration IS NULL THEN v_missing := v_missing || 'what does not meet them'::text; END IF;
      IF array_length(v_missing, 1) > 0 THEN
        out := out || ('Part Submission Warrant: fill in ' || array_to_string(v_missing, ', '));
      ELSIF w.signed_at IS NULL THEN
        out := out || 'Part Submission Warrant: ask an approver who did not prepare the submission to sign it'::text;
      END IF;
    END IF;
  END IF;
  RETURN out;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Saving, signing and unsigning the warrant
-- ---------------------------------------------------------------------------
-- Keys present are set: partWeight (a number, with weightUnit kg | g | lb | oz; null clears both), purchaseOrder, engineeringChangeLevel, resultsMeetRequirements (true | false | null),
-- declaration. Makes the warrant on first save. Records who saved it last: that person has prepared it and cannot sign it.
CREATE FUNCTION app.save_ppap_psw(p_submission uuid, p_data jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.ppap_submissions%ROWTYPE; w public.ppap_psw%ROWTYPE; k text; v_weight numeric; v_unit text; v_text text;
BEGIN
  s := app.ppap_for_edit(p_submission);
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Send the warrant as an object' USING ERRCODE = 'QM037'; END IF;
  FOR k IN SELECT jsonb_object_keys(p_data) LOOP
    IF k NOT IN ('partWeight', 'weightUnit', 'purchaseOrder', 'engineeringChangeLevel', 'resultsMeetRequirements', 'declaration') THEN RAISE EXCEPTION 'Unknown field %', k USING ERRCODE = 'QM037'; END IF;
  END LOOP;
  INSERT INTO public.ppap_psw (organisation_id, submission_id) VALUES (s.organisation_id, s.id) ON CONFLICT (submission_id) DO NOTHING;
  SELECT * INTO w FROM public.ppap_psw WHERE submission_id = s.id FOR UPDATE;
  IF w.signed_at IS NOT NULL THEN RAISE EXCEPTION 'The warrant is signed. An approver must take the signature off before it is changed.' USING ERRCODE = 'QM037'; END IF;
  v_weight := w.part_weight; v_unit := w.weight_unit;
  IF p_data ? 'partWeight' THEN
    IF jsonb_typeof(p_data -> 'partWeight') = 'null' THEN v_weight := NULL; v_unit := NULL;
    ELSE
      BEGIN v_weight := (p_data ->> 'partWeight')::numeric; EXCEPTION WHEN others THEN RAISE EXCEPTION 'The weight must be a number' USING ERRCODE = 'QM037'; END;
      IF v_weight <= 0 THEN RAISE EXCEPTION 'The weight must be more than zero' USING ERRCODE = 'QM037'; END IF;
      v_unit := coalesce(p_data ->> 'weightUnit', v_unit, 'kg');
    END IF;
  ELSIF p_data ? 'weightUnit' AND jsonb_typeof(p_data -> 'weightUnit') <> 'null' THEN
    v_unit := p_data ->> 'weightUnit';
  END IF;
  IF v_unit IS NOT NULL AND v_unit NOT IN ('kg', 'g', 'lb', 'oz') THEN RAISE EXCEPTION 'The weight unit is kg, g, lb or oz' USING ERRCODE = 'QM037'; END IF;
  IF v_weight IS NOT NULL AND v_unit IS NULL THEN v_unit := 'kg'; END IF;
  UPDATE public.ppap_psw SET part_weight = v_weight, weight_unit = v_unit, prepared_by = auth.uid() WHERE id = w.id;
  IF p_data ? 'purchaseOrder' THEN
    v_text := nullif(btrim(coalesce(p_data ->> 'purchaseOrder', '')), '');
    IF v_text IS NOT NULL AND length(v_text) > 100 THEN RAISE EXCEPTION 'The purchase order is up to 100 characters' USING ERRCODE = 'QM037'; END IF;
    UPDATE public.ppap_psw SET purchase_order = v_text WHERE id = w.id;
  END IF;
  IF p_data ? 'engineeringChangeLevel' THEN
    v_text := nullif(btrim(coalesce(p_data ->> 'engineeringChangeLevel', '')), '');
    IF v_text IS NOT NULL AND length(v_text) > 100 THEN RAISE EXCEPTION 'The engineering change level is up to 100 characters' USING ERRCODE = 'QM037'; END IF;
    UPDATE public.ppap_psw SET engineering_change_level = v_text WHERE id = w.id;
  END IF;
  IF p_data ? 'resultsMeetRequirements' THEN
    IF jsonb_typeof(p_data -> 'resultsMeetRequirements') NOT IN ('boolean', 'null') THEN RAISE EXCEPTION 'Say yes or no: do the results meet the requirements' USING ERRCODE = 'QM037'; END IF;
    UPDATE public.ppap_psw SET results_meet_requirements = (p_data ->> 'resultsMeetRequirements')::boolean WHERE id = w.id;
  END IF;
  IF p_data ? 'declaration' THEN
    v_text := nullif(btrim(coalesce(p_data ->> 'declaration', '')), '');
    IF v_text IS NOT NULL AND length(v_text) > 2000 THEN RAISE EXCEPTION 'The declaration is up to 2000 characters' USING ERRCODE = 'QM037'; END IF;
    UPDATE public.ppap_psw SET declaration = v_text WHERE id = w.id;
  END IF;
  UPDATE public.ppap_elements SET status = 'in_progress' WHERE submission_id = s.id AND element_key = 'part_submission_warrant' AND status = 'not_started';
  PERFORM app.ppap_touch(s.id);
END $$;

-- An approver signs the warrant with their title and phone. Never the person who prepared it: the owner, whoever created the submission, or whoever last saved the typed fields.
CREATE FUNCTION app.sign_ppap_psw(p_submission uuid, p_title text, p_phone text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.ppap_submissions%ROWTYPE; w public.ppap_psw%ROWTYPE; v_title text := nullif(btrim(coalesce(p_title, '')), ''); v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
        v_name text; v_missing text[] := '{}'::text[];
BEGIN
  s := app.ppap_for_edit(p_submission, true);
  SELECT * INTO w FROM public.ppap_psw WHERE submission_id = s.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Fill in the warrant before it is signed' USING ERRCODE = 'QM037'; END IF;
  IF w.signed_at IS NOT NULL THEN RAISE EXCEPTION 'The warrant is already signed' USING ERRCODE = 'QM037'; END IF;
  IF auth.uid() = s.owner_user_id OR auth.uid() = s.created_by OR auth.uid() = w.prepared_by THEN
    RAISE EXCEPTION 'You prepared this submission, so someone else with approval rights must sign the warrant' USING ERRCODE = 'QM037';
  END IF;
  IF w.part_weight IS NULL THEN v_missing := v_missing || 'the part weight'::text; END IF;
  IF w.results_meet_requirements IS NULL THEN v_missing := v_missing || 'whether the results meet the requirements'::text; END IF;
  IF w.results_meet_requirements IS FALSE AND w.declaration IS NULL THEN v_missing := v_missing || 'what does not meet them'::text; END IF;
  IF array_length(v_missing, 1) > 0 THEN RAISE EXCEPTION 'The warrant still needs %', array_to_string(v_missing, ', ') USING ERRCODE = 'QM037'; END IF;
  IF v_title IS NULL THEN RAISE EXCEPTION 'Give your title to sign the warrant' USING ERRCODE = 'QM037'; END IF;
  IF length(v_title) > 100 OR (v_phone IS NOT NULL AND length(v_phone) > 50) THEN RAISE EXCEPTION 'The title is up to 100 characters and the phone number up to 50' USING ERRCODE = 'QM037'; END IF;
  SELECT coalesce(nullif(btrim(concat_ws(' ', p.first_name, p.surname)), ''), (SELECT nullif(btrim(u.email), '') FROM auth.users u WHERE u.id = auth.uid()))
    INTO v_name FROM public.profiles p WHERE p.id = auth.uid();
  IF v_name IS NULL THEN RAISE EXCEPTION 'Your profile has no name to sign with' USING ERRCODE = 'QM037'; END IF;
  PERFORM set_config('app.ppap_psw_signing', 'on', true);
  UPDATE public.ppap_psw SET signer_user_id = auth.uid(), signer_name = left(v_name, 200), signer_title = v_title, signer_phone = v_phone, signed_at = now(), signed_on = current_date,
         unsigned_at = NULL, unsigned_by = NULL, unsign_reason = NULL WHERE id = w.id;
  PERFORM set_config('app.ppap_psw_signing', 'off', true);
  UPDATE public.ppap_elements SET status = 'ready' WHERE submission_id = s.id AND element_key = 'part_submission_warrant' AND status IN ('not_started', 'in_progress');
  PERFORM app.ppap_touch(s.id);
END $$;

-- An approver takes the signature off while the submission is still being prepared, with a reason, so the typed fields can change.
CREATE FUNCTION app.unsign_ppap_psw(p_submission uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.ppap_submissions%ROWTYPE; w public.ppap_psw%ROWTYPE; v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  s := app.ppap_for_edit(p_submission, true);
  SELECT * INTO w FROM public.ppap_psw WHERE submission_id = s.id FOR UPDATE;
  IF NOT FOUND OR w.signed_at IS NULL THEN RAISE EXCEPTION 'The warrant is not signed' USING ERRCODE = 'QM037'; END IF;
  IF length(v_reason) < 3 THEN RAISE EXCEPTION 'Say why the signature is taken off (at least 3 characters)' USING ERRCODE = 'QM037'; END IF;
  PERFORM set_config('app.ppap_psw_signing', 'on', true);
  UPDATE public.ppap_psw SET signer_user_id = NULL, signer_name = NULL, signer_title = NULL, signer_phone = NULL, signed_at = NULL, signed_on = NULL,
         unsigned_at = now(), unsigned_by = auth.uid(), unsign_reason = left(v_reason, 500) WHERE id = w.id;
  PERFORM set_config('app.ppap_psw_signing', 'off', true);
  UPDATE public.ppap_elements SET status = 'in_progress' WHERE submission_id = s.id AND element_key = 'part_submission_warrant' AND status = 'ready';
  PERFORM app.ppap_touch(s.id);
END $$;

-- ---------------------------------------------------------------------------
-- 6. Submitting
-- ---------------------------------------------------------------------------
-- The next decision number for a submission, and the latest decision of a kind.
CREATE FUNCTION app.ppap_next_seq(p_submission uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT coalesce(max(seq), 0) + 1 FROM public.ppap_decisions WHERE submission_id = p_submission $$;

-- Sends the submission: it must be ready and nothing may still be needed (a linked record may have changed since it was marked ready). Freezes every link and the warrant,
-- moves the status and writes the 'submitted' decision. decidedOn is the day it was sent (default today, not in the future); how is how it went (portal, email, courier ...).
CREATE FUNCTION app.submit_ppap(p_submission uuid, p_sent_on date DEFAULT NULL, p_how text DEFAULT NULL, p_note text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.ppap_submissions%ROWTYPE; v_problems text[]; v_on date := coalesce(p_sent_on, current_date); v_how text := nullif(btrim(coalesce(p_how, '')), ''); v_note text := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  s := app.ppap_for_write(p_submission);
  IF s.status <> 'ready' THEN RAISE EXCEPTION '% is %, so it cannot be submitted. Mark it ready first.', s.reference, replace(s.status, '_', ' ') USING ERRCODE = 'QM037'; END IF;
  IF v_on > current_date THEN RAISE EXCEPTION 'It cannot be sent in the future' USING ERRCODE = 'QM037'; END IF;
  IF v_how IS NOT NULL AND length(v_how) > 200 THEN RAISE EXCEPTION 'How it was sent is up to 200 characters' USING ERRCODE = 'QM037'; END IF;
  IF v_note IS NOT NULL AND length(v_note) > 2000 THEN RAISE EXCEPTION 'The note is up to 2000 characters' USING ERRCODE = 'QM037'; END IF;
  v_problems := app.ppap_problems(s.id);
  IF coalesce(array_length(v_problems, 1), 0) > 0 THEN RAISE EXCEPTION 'Something changed since it was marked ready: %', v_problems[1] USING ERRCODE = 'QM037'; END IF;
  PERFORM app.ppap_freeze_links(s.id);
  PERFORM set_config('app.ppap_lifecycle', 'on', true);
  UPDATE public.ppap_psw SET frozen_at = now() WHERE submission_id = s.id AND frozen_at IS NULL;
  UPDATE public.ppap_submissions SET status = 'submitted', submitted_at = now(), submitted_by = auth.uid() WHERE id = s.id;
  INSERT INTO public.ppap_decisions (organisation_id, submission_id, seq, kind, decided_on, how, note) VALUES (s.organisation_id, s.id, app.ppap_next_seq(s.id), 'submitted', v_on, v_how, v_note);
  PERFORM set_config('app.ppap_lifecycle', 'off', true);
END $$;

-- ---------------------------------------------------------------------------
-- 7. The customer's decision
-- ---------------------------------------------------------------------------
-- An approver records what the customer decided: approved, interim_approved (needs an expiry date and the conditions) or rejected (needs the reason). Their reference and their
-- signed warrant (a file in this submission's folder) are optional. A submission that was sent takes a decision; one that is interim takes approved, rejected or a later interim date.
-- Approved is final; a rejected one is never reopened (resubmit instead).
CREATE FUNCTION app.record_ppap_decision(p_submission uuid, p_kind text, p_decided_on date, p_their_reference text DEFAULT NULL, p_expires_on date DEFAULT NULL, p_note text DEFAULT NULL,
                                        p_storage_path text DEFAULT NULL, p_file_name text DEFAULT NULL, p_content_type text DEFAULT NULL, p_size_bytes bigint DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.ppap_submissions%ROWTYPE; v_sent date; v_last public.ppap_decisions%ROWTYPE; v_ref text := nullif(btrim(coalesce(p_their_reference, '')), ''); v_note text := nullif(btrim(coalesce(p_note, '')), '');
        v_review date;
BEGIN
  s := app.ppap_for_write(p_submission, true);
  IF p_kind IS NULL OR p_kind NOT IN ('approved', 'interim_approved', 'rejected') THEN RAISE EXCEPTION 'The customer''s decision is approved, interim approved or rejected' USING ERRCODE = 'QM037'; END IF;
  IF s.status NOT IN ('submitted', 'interim_approved') THEN RAISE EXCEPTION '% is %, so it takes no decision from the customer', s.reference, replace(s.status, '_', ' ') USING ERRCODE = 'QM037'; END IF;
  IF p_decided_on IS NULL THEN RAISE EXCEPTION 'Say the day the customer decided' USING ERRCODE = 'QM037'; END IF;
  IF p_decided_on > current_date THEN RAISE EXCEPTION 'The decision cannot be in the future' USING ERRCODE = 'QM037'; END IF;
  SELECT decided_on INTO v_sent FROM public.ppap_decisions WHERE submission_id = s.id AND kind = 'submitted' ORDER BY seq LIMIT 1;
  IF v_sent IS NOT NULL AND p_decided_on < v_sent THEN RAISE EXCEPTION 'The customer cannot have decided before it was sent (%)', to_char(v_sent, 'DD Mon YYYY') USING ERRCODE = 'QM037'; END IF;
  SELECT * INTO v_last FROM public.ppap_decisions WHERE submission_id = s.id ORDER BY seq DESC LIMIT 1;
  IF p_decided_on < v_last.decided_on THEN RAISE EXCEPTION 'That is earlier than the last decision recorded (%)', to_char(v_last.decided_on, 'DD Mon YYYY') USING ERRCODE = 'QM037'; END IF;
  IF v_ref IS NOT NULL AND length(v_ref) > 100 THEN RAISE EXCEPTION 'Their reference is up to 100 characters' USING ERRCODE = 'QM037'; END IF;
  IF v_note IS NOT NULL AND length(v_note) > 2000 THEN RAISE EXCEPTION 'The note is up to 2000 characters' USING ERRCODE = 'QM037'; END IF;
  IF p_kind = 'interim_approved' THEN
    IF p_expires_on IS NULL THEN RAISE EXCEPTION 'An interim approval needs the date it runs to' USING ERRCODE = 'QM037'; END IF;
    IF p_expires_on <= p_decided_on THEN RAISE EXCEPTION 'The interim approval must run past the day it was given' USING ERRCODE = 'QM037'; END IF;
    IF v_note IS NULL THEN RAISE EXCEPTION 'Write the conditions of the interim approval' USING ERRCODE = 'QM037'; END IF;
    IF s.status = 'interim_approved' AND p_expires_on <= coalesce((SELECT max(expires_on) FROM public.ppap_decisions WHERE submission_id = s.id), p_decided_on) THEN
      RAISE EXCEPTION 'A new interim approval must run later than the one before' USING ERRCODE = 'QM037';
    END IF;
  ELSE
    IF p_expires_on IS NOT NULL THEN RAISE EXCEPTION 'Only an interim approval has an expiry date' USING ERRCODE = 'QM037'; END IF;
    IF p_kind = 'rejected' AND v_note IS NULL THEN RAISE EXCEPTION 'Write why the customer rejected it' USING ERRCODE = 'QM037'; END IF;
  END IF;
  IF p_storage_path IS NOT NULL AND (p_file_name IS NULL OR p_size_bytes IS NULL OR p_storage_path NOT LIKE s.organisation_id::text || '/ppap/' || s.id::text || '/%' OR p_storage_path LIKE '%..%') THEN
    RAISE EXCEPTION 'The file must be stored in this submission''s folder' USING ERRCODE = 'QM037';
  END IF;
  PERFORM set_config('app.ppap_lifecycle', 'on', true);
  IF p_kind = 'approved' THEN v_review := (p_decided_on + make_interval(months => app.ppap_review_months()))::date; END IF;
  UPDATE public.ppap_submissions SET status = p_kind, next_review_on = v_review WHERE id = s.id;
  INSERT INTO public.ppap_decisions (organisation_id, submission_id, seq, kind, decided_on, their_reference, expires_on, note, storage_path, file_name, content_type, size_bytes)
  VALUES (s.organisation_id, s.id, app.ppap_next_seq(s.id), p_kind, p_decided_on, v_ref, CASE WHEN p_kind = 'interim_approved' THEN p_expires_on END, v_note,
          p_storage_path, nullif(btrim(coalesce(p_file_name, '')), ''), p_content_type, p_size_bytes);
  PERFORM set_config('app.ppap_lifecycle', 'off', true);
END $$;

-- ---------------------------------------------------------------------------
-- 8. Withdrawing: before sending a manager's act, as before; once sent an approver's, recorded as a decision
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.withdraw_ppap(p_submission uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.ppap_submissions%ROWTYPE; v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  SELECT * INTO s FROM public.ppap_submissions WHERE id = p_submission;
  IF NOT FOUND OR NOT app.is_member(s.organisation_id) THEN RAISE EXCEPTION 'Submission not found' USING ERRCODE = 'P0002'; END IF;
  IF s.status IN ('submitted', 'interim_approved') THEN
    s := app.ppap_for_write(p_submission, true);
    IF length(v_reason) < 3 THEN RAISE EXCEPTION 'Say why it is withdrawn (at least 3 characters)' USING ERRCODE = 'QM037'; END IF;
    PERFORM set_config('app.ppap_lifecycle', 'on', true);
    UPDATE public.ppap_submissions SET status = 'withdrawn', withdraw_reason = left(v_reason, 500), withdrawn_at = now(), withdrawn_by = auth.uid(), next_review_on = NULL WHERE id = s.id;
    INSERT INTO public.ppap_decisions (organisation_id, submission_id, seq, kind, decided_on, note) VALUES (s.organisation_id, s.id, app.ppap_next_seq(s.id), 'withdrawn', current_date, left(v_reason, 500));
    PERFORM set_config('app.ppap_lifecycle', 'off', true);
    RETURN;
  END IF;
  s := app.ppap_for_write(p_submission);
  IF s.status NOT IN ('draft', 'in_preparation', 'ready') THEN RAISE EXCEPTION '% is %, so it cannot be withdrawn', s.reference, replace(s.status, '_', ' ') USING ERRCODE = 'QM037'; END IF;
  IF length(v_reason) < 3 THEN RAISE EXCEPTION 'Say why it is withdrawn (at least 3 characters)' USING ERRCODE = 'QM037'; END IF;
  UPDATE public.ppap_submissions SET status = 'withdrawn', withdraw_reason = left(v_reason, 500), withdrawn_at = now(), withdrawn_by = auth.uid() WHERE id = s.id;
END $$;

-- ---------------------------------------------------------------------------
-- 9. Resubmission: create_ppap learns replacesId, and the new submission takes what it can from the old one
-- ---------------------------------------------------------------------------
-- Whether a submission may be replaced by a new one: it was rejected, or withdrawn after it was sent, or approved (a revalidation).
CREATE FUNCTION app.ppap_replaceable(p_submission uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.ppap_submissions s
                  WHERE s.id = p_submission AND s.direction = 'submitted'
                    AND (s.status IN ('rejected', 'approved')
                         OR (s.status = 'withdrawn' AND EXISTS (SELECT 1 FROM public.ppap_decisions d WHERE d.submission_id = s.id AND d.kind = 'submitted'))))
$$;

SELECT pg_temp.patch_once('app.create_ppap(uuid, jsonb)'::regprocedure, 'replacesId',
  $old$IF k NOT IN ('direction', 'partId', 'partRevisionId', 'customerId', 'siteId', 'level', 'reason', 'notes', 'ownerId', 'clientKey') THEN$old$,
  $new$IF k NOT IN ('direction', 'partId', 'partRevisionId', 'customerId', 'siteId', 'level', 'reason', 'notes', 'ownerId', 'clientKey', 'replacesId') THEN$new$);
SELECT pg_temp.patch_once('app.create_ppap(uuid, jsonb)'::regprocedure, 'v_replaces',
  $old$  v_set uuid; v_existing uuid; v_rules jsonb; v_year integer; v_n integer; v_id uuid;$old$,
  $new$  v_set uuid; v_existing uuid; v_rules jsonb; v_year integer; v_n integer; v_id uuid; v_replaces uuid;$new$);
SELECT pg_temp.patch_once('app.create_ppap(uuid, jsonb)'::regprocedure, 'Only a rejected',
  $old$  v_rules := app.ppap_starting_rules(p_organisation_id, v_customer, v_level);$old$,
  $new$  IF nullif(p_data ->> 'replacesId', '') IS NOT NULL THEN
    BEGIN v_replaces := (p_data ->> 'replacesId')::uuid; EXCEPTION WHEN others THEN RAISE EXCEPTION 'Name the submission it replaces by id' USING ERRCODE = 'QM037'; END;
    IF NOT EXISTS (SELECT 1 FROM public.ppap_submissions r WHERE r.id = v_replaces AND r.organisation_id = p_organisation_id AND r.part_id = v_part AND r.customer_id = v_customer) THEN
      RAISE EXCEPTION 'Only a submission of the same part to the same customer can be replaced' USING ERRCODE = 'QM037';
    END IF;
    IF NOT app.ppap_replaceable(v_replaces) THEN RAISE EXCEPTION 'Only a rejected submission, one withdrawn after it was sent, or an approved one (to revalidate) can be replaced' USING ERRCODE = 'QM037'; END IF;
  END IF;
  v_rules := app.ppap_starting_rules(p_organisation_id, v_customer, v_level);$new$);
SELECT pg_temp.patch_once('app.create_ppap(uuid, jsonb)'::regprocedure, 'requirement_set_id, owner_user_id, notes, client_key, replaces_id',
  $old$level, reason, requirement_set_id, owner_user_id, notes, client_key)
    VALUES (p_organisation_id, 'PPAP-' || to_char(make_date(v_year, 1, 1), 'YY') || '-' || app.pad_number(v_n, 4), v_dir, v_part, v_rev, v_customer, v_site, v_level, v_reason, v_set, v_owner, v_notes, v_key)$old$,
  $new$level, reason, requirement_set_id, owner_user_id, notes, client_key, replaces_id)
    VALUES (p_organisation_id, 'PPAP-' || to_char(make_date(v_year, 1, 1), 'YY') || '-' || app.pad_number(v_n, 4), v_dir, v_part, v_rev, v_customer, v_site, v_level, v_reason, v_set, v_owner, v_notes, v_key, v_replaces)$new$);

-- Keys (all optional): reason (default the old one), level (default the old one), partRevisionId (default the old one's), ownerId, notes, clientKey. Makes a new submission that
-- names the old one, then carries over the notes of each element, the links (unfrozen, so they follow the current records) and the warrant's typed fields (unsigned). Files are not
-- copied and waivers and signatures are not carried: they belong to the earlier submission. A resubmission of an approved one is recorded as a review of it.
CREATE FUNCTION app.start_ppap_resubmission(p_submission uuid, p_data jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.ppap_submissions%ROWTYPE; k text; v_data jsonb; v_res jsonb; v_new uuid; o record; w public.ppap_psw%ROWTYPE; n integer := 0;
BEGIN
  SELECT * INTO s FROM public.ppap_submissions WHERE id = p_submission;
  IF NOT FOUND OR NOT app.is_member(s.organisation_id) THEN RAISE EXCEPTION 'Submission not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_ppap_manager(s.organisation_id);
  IF jsonb_typeof(coalesce(p_data, '{}'::jsonb)) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Send the changes as an object' USING ERRCODE = 'QM037'; END IF;
  FOR k IN SELECT jsonb_object_keys(coalesce(p_data, '{}'::jsonb)) LOOP
    IF k NOT IN ('reason', 'level', 'partRevisionId', 'ownerId', 'notes', 'clientKey') THEN RAISE EXCEPTION 'Unknown field %', k USING ERRCODE = 'QM037'; END IF;
  END LOOP;
  IF NOT app.ppap_replaceable(s.id) THEN RAISE EXCEPTION '% is %, so it cannot be resubmitted. Only a rejected submission, one withdrawn after it was sent, or an approved one can be.', s.reference, replace(s.status, '_', ' ') USING ERRCODE = 'QM037'; END IF;
  v_data := jsonb_build_object('partId', s.part_id, 'partRevisionId', s.part_revision_id, 'customerId', s.customer_id, 'siteId', s.site_id, 'level', s.level, 'reason', s.reason, 'replacesId', s.id)
            || coalesce(p_data, '{}'::jsonb);
  v_res := app.create_ppap(s.organisation_id, v_data);
  v_new := (v_res ->> 'id')::uuid;
  IF NOT (v_res ->> 'created')::boolean THEN RETURN v_res; END IF;
  -- Notes and links of each element, carried over (a link keeps pointing at the record, not at its old version)
  FOR o IN SELECT e.element_key, e.note, e.id FROM public.ppap_elements e WHERE e.submission_id = s.id LOOP
    UPDATE public.ppap_elements SET note = o.note WHERE submission_id = v_new AND element_key = o.element_key AND o.note IS NOT NULL;
  END LOOP;
  INSERT INTO public.ppap_evidence (organisation_id, submission_id, element_id, kind, target_kind, target_id, description)
  SELECT v.organisation_id, v_new, ne.id, 'link', v.target_kind, v.target_id, v.description
    FROM public.ppap_evidence v
    JOIN public.ppap_elements oe ON oe.id = v.element_id
    JOIN public.ppap_elements ne ON ne.submission_id = v_new AND ne.element_key = oe.element_key
   WHERE v.submission_id = s.id AND v.kind = 'link' AND v.removed_at IS NULL AND ne.requirement <> 'not_required';
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE public.ppap_elements e SET status = 'in_progress'
   WHERE e.submission_id = v_new AND e.status = 'not_started' AND EXISTS (SELECT 1 FROM public.ppap_evidence x WHERE x.element_id = e.id AND x.removed_at IS NULL);
  SELECT * INTO w FROM public.ppap_psw WHERE submission_id = s.id;
  IF FOUND THEN
    INSERT INTO public.ppap_psw (organisation_id, submission_id, part_weight, weight_unit, purchase_order, engineering_change_level, results_meet_requirements, declaration, prepared_by)
    VALUES (s.organisation_id, v_new, w.part_weight, w.weight_unit, w.purchase_order, w.engineering_change_level, w.results_meet_requirements, w.declaration, auth.uid());
    UPDATE public.ppap_elements SET status = 'in_progress' WHERE submission_id = v_new AND element_key = 'part_submission_warrant' AND status = 'not_started';
  END IF;
  IF s.status = 'approved' THEN
    PERFORM set_config('app.ppap_lifecycle', 'on', true);
    INSERT INTO public.ppap_reviews (organisation_id, submission_id, outcome, new_submission_id) VALUES (s.organisation_id, s.id, 'resubmission_started', v_new);
    PERFORM set_config('app.ppap_lifecycle', 'off', true);
  END IF;
  RETURN v_res || jsonb_build_object('linksCarried', n);
END $$;

-- ---------------------------------------------------------------------------
-- 10. The periodic review of an approved submission
-- ---------------------------------------------------------------------------
-- A manager records that an approved submission was reviewed and nothing changed (a note is needed) and when it is next due (default a year on; after today, within five years).
CREATE FUNCTION app.record_ppap_review(p_submission uuid, p_note text, p_next_review_on date DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.ppap_submissions%ROWTYPE; v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_next date;
BEGIN
  s := app.ppap_for_write(p_submission);
  IF s.status <> 'approved' THEN RAISE EXCEPTION '% is %. Only an approved submission is reviewed.', s.reference, replace(s.status, '_', ' ') USING ERRCODE = 'QM037'; END IF;
  IF v_note IS NULL THEN RAISE EXCEPTION 'Write what was checked and that nothing changed' USING ERRCODE = 'QM037'; END IF;
  IF length(v_note) > 1000 THEN RAISE EXCEPTION 'The note is up to 1000 characters' USING ERRCODE = 'QM037'; END IF;
  v_next := coalesce(p_next_review_on, (current_date + make_interval(months => app.ppap_review_months()))::date);
  IF v_next <= current_date THEN RAISE EXCEPTION 'The next review must be after today' USING ERRCODE = 'QM037'; END IF;
  IF v_next > (current_date + interval '5 years')::date THEN RAISE EXCEPTION 'The next review is at most five years away' USING ERRCODE = 'QM037'; END IF;
  PERFORM set_config('app.ppap_lifecycle', 'on', true);
  UPDATE public.ppap_submissions SET next_review_on = v_next WHERE id = s.id;
  INSERT INTO public.ppap_reviews (organisation_id, submission_id, outcome, note, next_review_on) VALUES (s.organisation_id, s.id, 'no_change', v_note, v_next);
  PERFORM set_config('app.ppap_lifecycle', 'off', true);
END $$;

-- ---------------------------------------------------------------------------
-- 11. Privileges
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app.ppap_psw_rules(), app.ppap_frozen_rows(), app.ppap_record_insert_rule(), app.ppap_next_seq(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.ppap_review_months(), app.ppap_replaceable(uuid), app.save_ppap_psw(uuid, jsonb), app.sign_ppap_psw(uuid, text, text), app.unsign_ppap_psw(uuid, text),
  app.submit_ppap(uuid, date, text, text), app.record_ppap_decision(uuid, text, date, text, date, text, text, text, text, bigint), app.start_ppap_resubmission(uuid, jsonb),
  app.record_ppap_review(uuid, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.ppap_review_months(), app.ppap_replaceable(uuid), app.save_ppap_psw(uuid, jsonb), app.sign_ppap_psw(uuid, text, text), app.unsign_ppap_psw(uuid, text),
  app.submit_ppap(uuid, date, text, text), app.record_ppap_decision(uuid, text, date, text, date, text, text, text, text, bigint), app.start_ppap_resubmission(uuid, jsonb),
  app.record_ppap_review(uuid, text, date) TO authenticated;

-- ---------------------------------------------------------------------------
-- 12. Columns that name a user are classified (supabase/tests/sso_joining_moves.test.sql fails otherwise)
-- ---------------------------------------------------------------------------
SELECT pg_temp.patch_once(
  'app.user_reference_columns()'::regprocedure,
  $m$'ppap_psw'$m$,
  $old$    ('ppap_submissions', 'owner_user_id', 'history',$old$,
  $new$    ('ppap_psw', 'signer_user_id', 'history', 'Who signed the Part Submission Warrant; a signature is a record of who signed at the time'),
    ('ppap_submissions', 'owner_user_id', 'history',$new$);
