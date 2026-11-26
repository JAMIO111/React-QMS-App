-- PPAP, slice PP5a (docs/ppap-plan.md PP1, PP16): packages RECEIVED from a supplier, recorded by staff. The same record as a submission to a customer, in the other direction:
--
--  * app.create_ppap now makes a received package (direction 'received', a supplierId, no customer): the 18 elements are set from the requirement set's level (the organisation's
--    default level unless one is given; customer rules do not apply to a supplier). A package to a customer still needs a customer and refuses a supplier, and the reverse.
--  * What a received package needs is its evidence: the supplier's files for each required element (the supplier's own signed warrant is the file on element 18; **we do not sign or
--    type a warrant for a supplier**), links to records Fortress holds (e.g. an accepted material certificate), or an approver's waiver. A trigger refuses a typed warrant on a received
--    package. Sending becomes "received on" (the same submit function, which freezes the links), and OUR decision (approved, interim approved, rejected) is recorded by the same
--    function a customer's decision is recorded with.
--  * Resubmission and revalidation work for both directions: a rejected package is replaced by a new one naming it (same part and same supplier).
--  The supplier answering in the portal (PP5b) and the supplier profile, watchlist and inspection recommendation (PP5c) follow. Nothing here changes a supplier's approval status (D3).

-- ---------------------------------------------------------------------------
-- 0. Helper
-- ---------------------------------------------------------------------------
CREATE FUNCTION pg_temp.patch_re(p_fn regprocedure, p_marker text, p_pattern text, p_new text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_def text := replace(pg_get_functiondef(p_fn), E'\r', ''); v_n integer;
BEGIN
  IF position(p_marker IN v_def) > 0 THEN RETURN; END IF;
  SELECT count(*) INTO v_n FROM regexp_matches(v_def, p_pattern, 'g');
  IF v_n <> 1 THEN RAISE EXCEPTION 'Expected the pattern % exactly once in %, found % times', p_pattern, p_fn, v_n; END IF;
  EXECUTE regexp_replace(v_def, p_pattern, p_new);
END $$;

-- ---------------------------------------------------------------------------
-- 1. Starting a package: either direction
-- ---------------------------------------------------------------------------
-- Keys: direction (submitted | received), partId, partRevisionId (default the part's released revision), customerId (submitted) or supplierId (received), siteId, level, reason, notes,
-- ownerId, clientKey, replacesId.
CREATE OR REPLACE FUNCTION app.create_ppap(p_organisation_id uuid, p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  k text; v_part uuid; v_rev uuid; v_customer uuid; v_site uuid; v_level integer; v_reason text; v_owner uuid; v_key text; v_notes text; v_dir text;
  v_set uuid; v_existing uuid; v_rules jsonb; v_year integer; v_n integer; v_id uuid; v_supplier uuid; v_replaces uuid;
BEGIN
  PERFORM app.assert_ppap_manager(p_organisation_id);
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Send the submission as an object' USING ERRCODE = 'QM037'; END IF;
  FOR k IN SELECT jsonb_object_keys(p_data) LOOP
    IF k NOT IN ('direction', 'partId', 'partRevisionId', 'customerId', 'siteId', 'level', 'reason', 'notes', 'ownerId', 'clientKey', 'supplierId', 'replacesId') THEN RAISE EXCEPTION 'Unknown field %', k USING ERRCODE = 'QM037'; END IF;
  END LOOP;
  v_dir := coalesce(p_data ->> 'direction', 'submitted');
  IF v_dir NOT IN ('submitted', 'received') THEN RAISE EXCEPTION 'A submission is sent to a customer or received from a supplier' USING ERRCODE = 'QM037'; END IF;
  v_key := nullif(btrim(coalesce(p_data ->> 'clientKey', '')), '');
  IF v_key IS NOT NULL THEN
    IF length(v_key) NOT BETWEEN 8 AND 80 THEN RAISE EXCEPTION 'A client key is 8 to 80 characters' USING ERRCODE = 'QM037'; END IF;
    SELECT id INTO v_existing FROM public.ppap_submissions WHERE organisation_id = p_organisation_id AND client_key = v_key;
    IF FOUND THEN RETURN jsonb_build_object('id', v_existing, 'created', false); END IF;
  END IF;
  BEGIN v_part := nullif(p_data ->> 'partId', '')::uuid; v_rev := nullif(p_data ->> 'partRevisionId', '')::uuid; v_customer := nullif(p_data ->> 'customerId', '')::uuid; v_supplier := nullif(p_data ->> 'supplierId', '')::uuid;
        v_site := nullif(p_data ->> 'siteId', '')::uuid; v_owner := coalesce(nullif(p_data ->> 'ownerId', '')::uuid, auth.uid());
  EXCEPTION WHEN others THEN RAISE EXCEPTION 'Name the part, revision, customer, supplier, site and owner by id' USING ERRCODE = 'QM037'; END;
  IF v_part IS NULL OR NOT EXISTS (SELECT 1 FROM public.parts p WHERE p.id = v_part AND p.organisation_id = p_organisation_id) THEN RAISE EXCEPTION 'Choose a part of this organisation' USING ERRCODE = 'QM037'; END IF;
  IF v_rev IS NULL THEN SELECT id INTO v_rev FROM public.part_revisions WHERE part_id = v_part AND status = 'released'; END IF;
  IF v_rev IS NULL THEN RAISE EXCEPTION 'Choose the part revision this is for: the part has no released revision' USING ERRCODE = 'QM037'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.part_revisions r WHERE r.id = v_rev AND r.part_id = v_part AND r.organisation_id = p_organisation_id) THEN RAISE EXCEPTION 'That revision is not a revision of this part' USING ERRCODE = 'QM037'; END IF;
  IF v_dir = 'submitted' THEN
    IF v_supplier IS NOT NULL THEN RAISE EXCEPTION 'A submission to a customer does not name a supplier' USING ERRCODE = 'QM037'; END IF;
    IF v_customer IS NULL OR NOT EXISTS (SELECT 1 FROM public.customers c WHERE c.id = v_customer AND c.organisation_id = p_organisation_id) THEN RAISE EXCEPTION 'Choose the customer this is submitted to' USING ERRCODE = 'QM037'; END IF;
  ELSE
    IF v_customer IS NOT NULL THEN RAISE EXCEPTION 'A package received from a supplier does not name a customer' USING ERRCODE = 'QM037'; END IF;
    IF v_supplier IS NULL OR NOT EXISTS (SELECT 1 FROM public.suppliers x WHERE x.id = v_supplier AND x.organisation_id = p_organisation_id) THEN RAISE EXCEPTION 'Choose the supplier this package comes from' USING ERRCODE = 'QM037'; END IF;
  END IF;
  IF v_site IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.sites s WHERE s.id = v_site AND s.organisation_id = p_organisation_id) THEN RAISE EXCEPTION 'That site is not in this organisation' USING ERRCODE = 'QM037'; END IF;
  IF NOT app.is_active_member_user(p_organisation_id, v_owner) THEN RAISE EXCEPTION 'The owner must be an active member of this organisation' USING ERRCODE = 'QM037'; END IF;
  v_reason := p_data ->> 'reason';
  IF v_reason IS NULL OR v_reason NOT IN ('new_part', 'engineering_change', 'tooling', 'discrepancy_correction', 'alternate_material_or_supplier', 'process_change', 'not_produced_12_months', 'customer_request', 'other') THEN
    RAISE EXCEPTION 'Say why this is being submitted' USING ERRCODE = 'QM037';
  END IF;
  v_notes := nullif(btrim(coalesce(p_data ->> 'notes', '')), '');
  IF v_notes IS NOT NULL AND length(v_notes) > 2000 THEN RAISE EXCEPTION 'The notes are up to 2000 characters' USING ERRCODE = 'QM037'; END IF;
  IF p_data ? 'level' AND nullif(p_data ->> 'level', '') IS NOT NULL THEN
    IF (p_data ->> 'level') !~ '^[1-5]$' THEN RAISE EXCEPTION 'The level is 1 to 5' USING ERRCODE = 'QM037'; END IF;
    v_level := (p_data ->> 'level')::integer;
  END IF;
  IF nullif(p_data ->> 'replacesId', '') IS NOT NULL THEN
    BEGIN v_replaces := (p_data ->> 'replacesId')::uuid; EXCEPTION WHEN others THEN RAISE EXCEPTION 'Name the submission it replaces by id' USING ERRCODE = 'QM037'; END;
    IF NOT EXISTS (SELECT 1 FROM public.ppap_submissions r WHERE r.id = v_replaces AND r.organisation_id = p_organisation_id AND r.part_id = v_part AND r.direction = v_dir
                      AND r.customer_id IS NOT DISTINCT FROM v_customer AND r.supplier_id IS NOT DISTINCT FROM v_supplier) THEN
      RAISE EXCEPTION 'Only a submission of the same part with the same customer or supplier can be replaced' USING ERRCODE = 'QM037';
    END IF;
    IF NOT app.ppap_replaceable(v_replaces) THEN RAISE EXCEPTION 'Only a rejected submission, one withdrawn after it was sent, or an approved one (to revalidate) can be replaced' USING ERRCODE = 'QM037'; END IF;
  END IF;
  v_rules := app.ppap_starting_rules(p_organisation_id, v_customer, v_level);
  v_level := (v_rules ->> 'level')::integer;
  SELECT id INTO v_set FROM public.ppap_requirement_sets WHERE organisation_id = p_organisation_id AND current;
  v_year := extract(year FROM current_date)::integer;
  INSERT INTO app.ppap_counters AS c (organisation_id, year, last_value) VALUES (p_organisation_id, v_year, 1)
  ON CONFLICT (organisation_id, year) DO UPDATE SET last_value = c.last_value + 1 RETURNING last_value INTO v_n;
  BEGIN
    INSERT INTO public.ppap_submissions (organisation_id, reference, direction, part_id, part_revision_id, customer_id, supplier_id, site_id, level, reason, requirement_set_id, owner_user_id, notes, client_key, replaces_id)
    VALUES (p_organisation_id, 'PPAP-' || to_char(make_date(v_year, 1, 1), 'YY') || '-' || app.pad_number(v_n, 4), v_dir, v_part, v_rev, v_customer, v_supplier, v_site, v_level, v_reason, v_set, v_owner, v_notes, v_key, v_replaces)
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    IF v_key IS NOT NULL THEN
      SELECT id INTO v_existing FROM public.ppap_submissions WHERE organisation_id = p_organisation_id AND client_key = v_key;
      IF FOUND THEN RETURN jsonb_build_object('id', v_existing, 'created', false); END IF;
    END IF;
    RAISE EXCEPTION 'There is already a live submission of this part revision with this customer or supplier for that reason. Resubmit only after it is rejected or withdrawn.' USING ERRCODE = 'QM037';
  END;
  INSERT INTO public.ppap_elements (organisation_id, submission_id, element_key, requirement)
  SELECT p_organisation_id, v_id, t.key, v_rules -> 'requirements' ->> t.key FROM app.ppap_element_types() t ORDER BY t.ordinal;
  RETURN jsonb_build_object('id', v_id, 'created', true);
END $$;
-- ---------------------------------------------------------------------------
-- 2. Replacing a package, either direction
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.ppap_replaceable(p_submission uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.ppap_submissions s
                  WHERE s.id = p_submission
                    AND (s.status IN ('rejected', 'approved')
                         OR (s.status = 'withdrawn' AND EXISTS (SELECT 1 FROM public.ppap_decisions d WHERE d.submission_id = s.id AND d.kind = 'submitted'))))
$$;

CREATE OR REPLACE FUNCTION app.start_ppap_resubmission(p_submission uuid, p_data jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
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
  v_data := jsonb_strip_nulls(jsonb_build_object('direction', s.direction, 'partId', s.part_id, 'partRevisionId', s.part_revision_id, 'customerId', s.customer_id, 'supplierId', s.supplier_id, 'siteId', s.site_id, 'level', s.level, 'reason', s.reason, 'replacesId', s.id))
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
  IF FOUND AND s.direction = 'submitted' THEN
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
-- 3. What a received package still needs: the warrant element is its evidence like the others, and no signature of ours is asked for
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.ppap_problems(p_submission uuid) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.ppap_submissions%ROWTYPE; e record; v record; i jsonb; w public.ppap_psw%ROWTYPE; out text[] := '{}'::text[]; v_live integer; v_missing text[];
BEGIN
  IF NOT app.ppap_readable(p_submission) THEN RAISE EXCEPTION 'Submission not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO s FROM public.ppap_submissions WHERE id = p_submission;
  FOR e IN SELECT x.*, t.label, t.ordinal FROM public.ppap_elements x JOIN app.ppap_element_types() t ON t.key = x.element_key
            WHERE x.submission_id = p_submission AND x.requirement = 'required' AND x.status <> 'waived' AND (x.element_key <> 'part_submission_warrant' OR s.direction = 'received') ORDER BY t.ordinal LOOP
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
  IF s.direction = 'submitted' AND EXISTS (SELECT 1 FROM public.ppap_elements x WHERE x.submission_id = p_submission AND x.element_key = 'part_submission_warrant' AND x.requirement = 'required' AND x.status <> 'waived') THEN
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

-- The warrant element of a received package behaves like any other element: it is ready only with evidence, and loses its ready mark when its last evidence goes.
SELECT pg_temp.patch_re('app.set_ppap_element(uuid, jsonb)'::regprocedure, $m$s.direction = 'received'$m$,
  $re$e\.element_key <> 'part_submission_warrant'(\s+AND NOT v_has)$re$,
  $new$(e.element_key <> 'part_submission_warrant' OR s.direction = 'received')\1$new$);
SELECT pg_temp.patch_re('app.remove_ppap_evidence(uuid, text)'::regprocedure, $m$s.direction = 'received'$m$,
  $re$e\.element_key <> 'part_submission_warrant'(\s+AND NOT EXISTS)$re$,
  $new$(e.element_key <> 'part_submission_warrant' OR s.direction = 'received')\1$new$);

-- A received package has no warrant of ours: the supplier's own is a file.
CREATE FUNCTION app.ppap_psw_direction_rule() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.ppap_submissions s WHERE s.id = NEW.submission_id AND s.direction = 'received') THEN
    RAISE EXCEPTION 'A package received from a supplier has no warrant of ours. Attach the supplier''s own as a file.' USING ERRCODE = 'QM037';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ppap_psw_direction BEFORE INSERT ON public.ppap_psw FOR EACH ROW EXECUTE FUNCTION app.ppap_psw_direction_rule();
REVOKE ALL ON FUNCTION app.ppap_psw_direction_rule() FROM PUBLIC, anon, authenticated;
