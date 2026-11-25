-- Change management, slice CH2 (docs/change-management-plan.md): impact assessment, the board, sign-offs and rounds, approval, the cut-in point, the
-- customer approval record, notices.
--
--  * A draft is SUBMITTED (draft -> assessment): it needs what, why and what it covers; a row per active impact area is made, all "not assessed".
--  * In assessment someone with change.manage marks each area affected (with a note) or not affected, and chooses the BOARD: the functions that must
--    sign and who signs for each (an active member who holds change.approve, seat included).
--  * SEND TO BOARD (assessment -> approval) needs every area assessed, a board, scope, the customer question answered when the type needs the customer,
--    and the raiser off the board unless organisation_settings.change_allow_self_approval is on. It starts review round N+1: one pending sign-off per
--    function.
--  * A signer decides their own sign-off (change.approve AND named on this round). A rejection (comment needed) returns the change to assessment and
--    supersedes the other pending sign-offs of the round; the last approval approves the change in the same transaction. A manager can recall a change
--    from the board (reason), which supersedes the pending sign-offs the same way.
--  * The cut-in point (none / date / order / lot / serial, plus what happens to existing stock) and the customer approval record (not_needed / required /
--    requested / approved / rejected / waived with a reason) are recorded and never enforced here.
--  * Notices: a sign-off is announced to its signer; the raiser is told when the board approves or sends the change back.
-- Descriptions stay editable in draft and assessment (the type only in draft); after approval only the cut-in point, customer approval record, files and
-- (CH3) tasks move. Completed sign-offs are frozen. Errors QM035 (409 change_rule).

-- ---------------------------------------------------------------------------
-- 1. The organisation's choice, and the columns the change gains
-- ---------------------------------------------------------------------------
ALTER TABLE public.organisation_settings ADD COLUMN change_allow_self_approval boolean NOT NULL DEFAULT false;
GRANT UPDATE (change_allow_self_approval) ON public.organisation_settings TO authenticated;

ALTER TABLE public.change_requests
  ADD COLUMN review_round integer NOT NULL DEFAULT 0 CHECK (review_round >= 0),
  ADD COLUMN submitted_at timestamptz,
  ADD COLUMN approved_at timestamptz,
  ADD COLUMN approved_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  ADD COLUMN return_reason text CHECK (return_reason IS NULL OR length(btrim(return_reason)) BETWEEN 3 AND 1000),
  ADD COLUMN customer_approval text CHECK (customer_approval IS NULL OR customer_approval IN ('not_needed', 'required', 'requested', 'approved', 'rejected', 'waived')),
  ADD COLUMN customer_reference text CHECK (customer_reference IS NULL OR length(btrim(customer_reference)) BETWEEN 1 AND 200),
  ADD COLUMN customer_approval_on date,
  ADD COLUMN customer_waived_reason text CHECK (customer_waived_reason IS NULL OR length(btrim(customer_waived_reason)) BETWEEN 10 AND 500),
  ADD COLUMN cut_in_kind text NOT NULL DEFAULT 'none' CHECK (cut_in_kind IN ('none', 'date', 'order', 'lot', 'serial')),
  ADD COLUMN cut_in_date date,
  ADD COLUMN cut_in_order_id uuid,
  ADD COLUMN cut_in_lot_id uuid,
  ADD COLUMN cut_in_serial_id uuid,
  ADD COLUMN stock_action text CHECK (stock_action IS NULL OR stock_action IN ('use_up', 'rework', 'scrap', 'return')),
  ADD COLUMN stock_note text CHECK (stock_note IS NULL OR length(btrim(stock_note)) BETWEEN 1 AND 1000),
  ADD CONSTRAINT change_requests_cut_in_order_fkey FOREIGN KEY (cut_in_order_id, organisation_id) REFERENCES public.production_orders (id, organisation_id),
  ADD CONSTRAINT change_requests_cut_in_lot_fkey FOREIGN KEY (cut_in_lot_id, organisation_id) REFERENCES public.lots (id, organisation_id),
  ADD CONSTRAINT change_requests_cut_in_serial_fkey FOREIGN KEY (cut_in_serial_id, organisation_id) REFERENCES public.serial_numbers (id, organisation_id),
  ADD CONSTRAINT change_requests_cut_in_state CHECK (
    num_nonnulls(cut_in_date, cut_in_order_id, cut_in_lot_id, cut_in_serial_id) = CASE cut_in_kind WHEN 'none' THEN 0 ELSE 1 END
    AND CASE cut_in_kind WHEN 'date' THEN cut_in_date IS NOT NULL WHEN 'order' THEN cut_in_order_id IS NOT NULL
                         WHEN 'lot' THEN cut_in_lot_id IS NOT NULL WHEN 'serial' THEN cut_in_serial_id IS NOT NULL ELSE true END),
  ADD CONSTRAINT change_requests_waiver_state CHECK ((customer_approval = 'waived') = (customer_waived_reason IS NOT NULL));

-- ---------------------------------------------------------------------------
-- 2. Impacts, the board and the sign-offs
-- ---------------------------------------------------------------------------
CREATE TABLE public.change_impacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  change_id uuid NOT NULL,
  area_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'not_assessed' CHECK (status IN ('not_assessed', 'affected', 'not_affected')),
  note text CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 1000),
  assessed_at timestamptz,
  assessed_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT change_impacts_key UNIQUE (change_id, area_id),
  CONSTRAINT change_impacts_change_fkey FOREIGN KEY (change_id, organisation_id) REFERENCES public.change_requests (id, organisation_id),
  CONSTRAINT change_impacts_area_fkey FOREIGN KEY (area_id, organisation_id) REFERENCES public.change_areas (id, organisation_id),
  CONSTRAINT change_impacts_state CHECK ((status = 'not_assessed') = (assessed_at IS NULL)),
  CONSTRAINT change_impacts_note CHECK (status <> 'affected' OR note IS NOT NULL)
);

CREATE TABLE public.change_board (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  change_id uuid NOT NULL,
  function_id uuid NOT NULL,
  signer_user_id uuid NOT NULL REFERENCES auth.users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT change_board_key UNIQUE (change_id, function_id),
  CONSTRAINT change_board_change_fkey FOREIGN KEY (change_id, organisation_id) REFERENCES public.change_requests (id, organisation_id),
  CONSTRAINT change_board_function_fkey FOREIGN KEY (function_id, organisation_id) REFERENCES public.change_functions (id, organisation_id)
);

CREATE TABLE public.change_signoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  change_id uuid NOT NULL,
  round integer NOT NULL CHECK (round >= 1),
  function_id uuid NOT NULL,
  signer_user_id uuid NOT NULL REFERENCES auth.users (id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),
  comment text CHECK (comment IS NULL OR length(btrim(comment)) BETWEEN 1 AND 1000),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT change_signoffs_once_key UNIQUE (change_id, round, function_id),
  CONSTRAINT change_signoffs_change_fkey FOREIGN KEY (change_id, organisation_id) REFERENCES public.change_requests (id, organisation_id),
  CONSTRAINT change_signoffs_function_fkey FOREIGN KEY (function_id, organisation_id) REFERENCES public.change_functions (id, organisation_id),
  CONSTRAINT change_signoffs_decided_check CHECK ((status IN ('approved', 'rejected')) = (decided_at IS NOT NULL)),
  CONSTRAINT change_signoffs_rejection_check CHECK (status <> 'rejected' OR comment IS NOT NULL)
);
CREATE INDEX change_signoffs_signer_idx ON public.change_signoffs (organisation_id, signer_user_id) WHERE status = 'pending';
CREATE INDEX change_signoffs_change_idx ON public.change_signoffs (change_id);
CREATE INDEX change_impacts_change_idx ON public.change_impacts (change_id);
CREATE INDEX change_board_change_idx ON public.change_board (change_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['change_impacts', 'change_board', 'change_signoffs'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION app.stamp_created()', t || '_stamp', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.touch_updated()', t || '_touch', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change()', t || '_org_immutable', t);
    EXECUTE format('CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION audit.record_change(''organisation_id'')', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (app.has_permission(organisation_id, ''change.read''))', t || '_select', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Rules the tables hold even for SQL
-- ---------------------------------------------------------------------------
-- The change: stages move only along the allowed steps, and what each stage lets change.
CREATE OR REPLACE FUNCTION app.change_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A change is never deleted. Cancel it with a reason.' USING ERRCODE = 'QM035'; END IF;
  IF NEW.reference IS DISTINCT FROM OLD.reference THEN RAISE EXCEPTION 'A change''s reference never changes' USING ERRCODE = 'QM035'; END IF;
  IF NEW.raised_by IS DISTINCT FROM OLD.raised_by THEN RAISE EXCEPTION 'Who raised a change never changes' USING ERRCODE = 'QM035'; END IF;
  IF (NEW.origin_kind, NEW.origin_id) IS DISTINCT FROM (OLD.origin_kind, OLD.origin_id) THEN
    RAISE EXCEPTION 'The record a change was raised from never changes' USING ERRCODE = 'QM035';
  END IF;
  IF OLD.stage IN ('cancelled', 'rejected', 'closed') AND (to_jsonb(NEW) - 'updated_at' - 'updated_by') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at' - 'updated_by') THEN
    RAISE EXCEPTION '% is % and cannot be changed', OLD.reference, OLD.stage USING ERRCODE = 'QM035';
  END IF;
  IF NEW.stage IS DISTINCT FROM OLD.stage AND NOT (
       (OLD.stage = 'draft'      AND NEW.stage IN ('assessment', 'cancelled'))
    OR (OLD.stage = 'assessment' AND NEW.stage IN ('approval', 'cancelled'))
    OR (OLD.stage = 'approval'   AND NEW.stage IN ('assessment', 'approved', 'cancelled'))
    OR (OLD.stage = 'approved'   AND NEW.stage IN ('cancelled'))) THEN
    RAISE EXCEPTION '% cannot move from % to %', OLD.reference, OLD.stage, NEW.stage USING ERRCODE = 'QM035';
  END IF;
  IF OLD.stage NOT IN ('draft', 'assessment') AND (NEW.title, NEW.description, NEW.reason, NEW.urgency) IS DISTINCT FROM (OLD.title, OLD.description, OLD.reason, OLD.urgency) THEN
    RAISE EXCEPTION 'Once a change has been to the board its title, what, why and urgency no longer change' USING ERRCODE = 'QM035';
  END IF;
  IF OLD.stage <> 'draft' AND NEW.type_id IS DISTINCT FROM OLD.type_id THEN
    RAISE EXCEPTION 'The type of a change is fixed once it leaves draft' USING ERRCODE = 'QM035';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.change_link_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_stage text;
BEGIN
  SELECT stage INTO v_stage FROM public.change_requests WHERE id = coalesce(NEW.change_id, OLD.change_id);
  IF v_stage IS NULL OR v_stage NOT IN ('draft', 'assessment') THEN RAISE EXCEPTION 'What a change covers can be changed only while it is a draft or being assessed' USING ERRCODE = 'QM035'; END IF;
  RETURN coalesce(NEW, OLD);
END $$;

-- Impacts and the board are worked on before the change goes to the board; they are never deleted (the board is replaced as a whole while that is open).
CREATE FUNCTION app.change_assessment_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_stage text;
BEGIN
  SELECT stage INTO v_stage FROM public.change_requests WHERE id = coalesce(NEW.change_id, OLD.change_id);
  IF TG_TABLE_NAME = 'change_impacts' AND TG_OP = 'DELETE' THEN RAISE EXCEPTION 'An impact assessment is never deleted' USING ERRCODE = 'QM035'; END IF;
  IF v_stage IS NULL OR v_stage NOT IN ('draft', 'assessment') THEN
    RAISE EXCEPTION 'The assessment and the board can be changed only before the change goes to the board' USING ERRCODE = 'QM035';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER change_impacts_rules BEFORE INSERT OR UPDATE OR DELETE ON public.change_impacts FOR EACH ROW EXECUTE FUNCTION app.change_assessment_rules();
CREATE TRIGGER change_board_rules BEFORE INSERT OR UPDATE OR DELETE ON public.change_board FOR EACH ROW EXECUTE FUNCTION app.change_assessment_rules();

-- A sign-off is decided once: pending -> approved | rejected | superseded; nothing else changes, nothing is deleted.
CREATE FUNCTION app.change_signoff_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A sign-off is never deleted' USING ERRCODE = 'QM035'; END IF;
  IF OLD.status <> 'pending' THEN RAISE EXCEPTION 'A sign-off that has been decided cannot change' USING ERRCODE = 'QM035'; END IF;
  IF (to_jsonb(NEW) - 'status' - 'comment' - 'decided_at' - 'updated_at' - 'updated_by') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'comment' - 'decided_at' - 'updated_at' - 'updated_by') THEN
    RAISE EXCEPTION 'Only the decision of a sign-off can be set' USING ERRCODE = 'QM035';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER change_signoffs_rules BEFORE UPDATE OR DELETE ON public.change_signoffs FOR EACH ROW EXECUTE FUNCTION app.change_signoff_rules();

-- ---------------------------------------------------------------------------
-- 4. What is still needed, and the people who could sign
-- ---------------------------------------------------------------------------
-- target 'submit' (draft -> assessment) or 'board' (assessment -> approval); empty = nothing in the way.
CREATE FUNCTION app.change_problems(p_change uuid, p_target text) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  c public.change_requests%ROWTYPE; v text[] := '{}'; n integer; r record; v_self boolean; v_needs boolean;
BEGIN
  SELECT * INTO c FROM public.change_requests WHERE id = p_change;
  IF NOT FOUND OR NOT app.has_permission(c.organisation_id, 'change.read') THEN RAISE EXCEPTION 'Change not found' USING ERRCODE = 'P0002'; END IF;
  IF c.description IS NULL THEN v := v || 'Say what is changing'::text; END IF;
  IF c.reason IS NULL THEN v := v || 'Say why'::text; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.change_links l WHERE l.change_id = c.id) THEN v := v || 'Say what it covers (parts, machines, suppliers…)'::text; END IF;
  IF p_target = 'board' THEN
    SELECT count(*) INTO n FROM public.change_impacts i WHERE i.change_id = c.id AND i.status = 'not_assessed';
    IF n > 0 THEN v := v || format('%s impact %s still to assess', n, CASE WHEN n = 1 THEN 'area' ELSE 'areas' END); END IF;
    v_self := coalesce((SELECT s.change_allow_self_approval FROM public.organisation_settings s WHERE s.organisation_id = c.organisation_id), false);
    IF NOT EXISTS (SELECT 1 FROM public.change_board b WHERE b.change_id = c.id) THEN
      v := v || 'Choose at least one function to sign it off'::text;
    ELSE
      FOR r IN SELECT b.signer_user_id, f.label AS function_label, coalesce(nullif(btrim(concat_ws(' ', p.first_name, p.surname)), ''), 'Unnamed') AS name,
                      app.member_may(c.organisation_id, b.signer_user_id, 'change.approve') AS may
                 FROM public.change_board b JOIN public.change_functions f ON f.id = b.function_id LEFT JOIN public.profiles p ON p.id = b.signer_user_id
                WHERE b.change_id = c.id ORDER BY f.sequence, f.label LOOP
        IF NOT r.may THEN v := v || format('%s cannot sign for %s any more: choose someone else', r.name, r.function_label); END IF;
        IF r.signer_user_id = c.raised_by AND NOT v_self THEN
          v := v || format('%s raised this change, so cannot sign it for %s: choose someone else (or allow it in System preferences)', r.name, r.function_label);
        END IF;
      END LOOP;
    END IF;
    v_needs := coalesce((SELECT t.needs_customer_approval FROM public.change_types t WHERE t.id = c.type_id), false);
    IF v_needs AND c.customer_approval IS NULL THEN v := v || 'Say whether the customer has to approve it'::text; END IF;
  END IF;
  RETURN v;
END $$;

-- Members who could be put on the board, and whether they can sign (role AND package level). change.read.
CREATE FUNCTION app.change_signer_candidates(p_organisation_id uuid) RETURNS TABLE (user_id uuid, name text, can_approve boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT ou.user_id, coalesce(nullif(btrim(concat_ws(' ', p.first_name, p.surname)), ''), 'Unnamed'), app.member_may(p_organisation_id, ou.user_id, 'change.approve')
    FROM public.organisation_users ou LEFT JOIN public.profiles p ON p.id = ou.user_id
   WHERE ou.organisation_id = p_organisation_id AND ou.status = 'active' AND app.has_permission(p_organisation_id, 'change.read')
   ORDER BY 2
$$;

-- ---------------------------------------------------------------------------
-- 5. Functions (SECURITY DEFINER): the only way to move a change
-- ---------------------------------------------------------------------------
-- draft -> assessment: what, why and scope are needed; a row per active impact area is made.
CREATE FUNCTION app.submit_change(p_change uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.change_requests%ROWTYPE; v_problems text[];
BEGIN
  c := app.change_for_write(p_change);
  IF c.stage <> 'draft' THEN RAISE EXCEPTION '% is not a draft' , c.reference USING ERRCODE = 'QM035'; END IF;
  v_problems := app.change_problems(c.id, 'submit');
  IF cardinality(v_problems) > 0 THEN RAISE EXCEPTION 'Not ready to assess: %', array_to_string(v_problems, '; ') USING ERRCODE = 'QM035'; END IF;
  INSERT INTO public.change_impacts (organisation_id, change_id, area_id)
  SELECT c.organisation_id, c.id, a.id FROM public.change_areas a WHERE a.organisation_id = c.organisation_id AND a.active
  ON CONFLICT (change_id, area_id) DO NOTHING;
  UPDATE public.change_requests SET stage = 'assessment', submitted_at = now() WHERE id = c.id;
END $$;

-- One area answered: affected (a note says how) or not affected, or put back to not assessed.
CREATE FUNCTION app.set_change_impact(p_change uuid, p_area uuid, p_status text, p_note text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.change_requests%ROWTYPE; v_note text := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  c := app.change_for_write(p_change);
  IF c.stage <> 'assessment' THEN RAISE EXCEPTION 'The impact is assessed while the change is in assessment' USING ERRCODE = 'QM035'; END IF;
  IF p_status IS NULL OR p_status NOT IN ('affected', 'not_affected', 'not_assessed') THEN RAISE EXCEPTION 'An area is affected, not affected or not assessed' USING ERRCODE = 'QM035'; END IF;
  IF p_status = 'affected' AND (v_note IS NULL OR length(v_note) < 3) THEN RAISE EXCEPTION 'Say how the area is affected' USING ERRCODE = 'QM035'; END IF;
  IF p_status = 'not_assessed' THEN v_note := NULL; END IF;
  IF length(coalesce(v_note, '')) > 1000 THEN RAISE EXCEPTION 'The note is up to 1,000 characters' USING ERRCODE = 'QM035'; END IF;
  UPDATE public.change_impacts SET status = p_status, note = v_note,
         assessed_at = CASE WHEN p_status = 'not_assessed' THEN NULL ELSE now() END, assessed_by = CASE WHEN p_status = 'not_assessed' THEN NULL ELSE auth.uid() END
   WHERE change_id = c.id AND area_id = p_area;
  IF NOT FOUND THEN RAISE EXCEPTION 'That area is not part of this change''s assessment' USING ERRCODE = 'QM035'; END IF;
END $$;

-- The board: [{functionId, signerId}], replaced as a whole. An active member who may sign, once per function.
CREATE FUNCTION app.set_change_board(p_change uuid, p_entries jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.change_requests%ROWTYPE; e jsonb; v_fn uuid; v_user uuid; v_name text;
BEGIN
  c := app.change_for_write(p_change);
  IF c.stage <> 'assessment' THEN RAISE EXCEPTION 'The board is chosen while the change is in assessment' USING ERRCODE = 'QM035'; END IF;
  IF jsonb_typeof(coalesce(p_entries, '[]'::jsonb)) <> 'array' THEN RAISE EXCEPTION 'Send the board as a list' USING ERRCODE = 'QM035'; END IF;
  DELETE FROM public.change_board WHERE change_id = c.id;
  FOR e IN SELECT * FROM jsonb_array_elements(coalesce(p_entries, '[]'::jsonb)) LOOP
    BEGIN v_fn := (e ->> 'functionId')::uuid; v_user := (e ->> 'signerId')::uuid; EXCEPTION WHEN others THEN v_fn := NULL; v_user := NULL; END;
    IF v_fn IS NULL OR v_user IS NULL THEN RAISE EXCEPTION 'Each function needs a person to sign for it' USING ERRCODE = 'QM035'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.change_functions f WHERE f.id = v_fn AND f.organisation_id = c.organisation_id AND f.active) THEN
      RAISE EXCEPTION 'Choose active functions of this organisation' USING ERRCODE = 'QM035';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.organisation_users ou WHERE ou.organisation_id = c.organisation_id AND ou.user_id = v_user AND ou.status = 'active') THEN
      RAISE EXCEPTION 'A signer must be an active member of this organisation' USING ERRCODE = 'QM035';
    END IF;
    IF NOT app.member_may(c.organisation_id, v_user, 'change.approve') THEN
      SELECT coalesce(nullif(btrim(concat_ws(' ', p.first_name, p.surname)), ''), 'That person') INTO v_name FROM public.profiles p WHERE p.id = v_user;
      RAISE EXCEPTION '% cannot sign off changes (they need the approve right and a package that includes it)', coalesce(v_name, 'That person') USING ERRCODE = 'QM035';
    END IF;
    BEGIN
      INSERT INTO public.change_board (organisation_id, change_id, function_id, signer_user_id) VALUES (c.organisation_id, c.id, v_fn, v_user);
    EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'Each function appears once on the board' USING ERRCODE = 'QM035';
    END;
  END LOOP;
  UPDATE public.change_requests SET updated_at = now() WHERE id = c.id;
END $$;

-- assessment -> approval: a new round, one pending sign-off per function on the board.
CREATE FUNCTION app.send_change_to_board(p_change uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.change_requests%ROWTYPE; v_problems text[]; v_round integer;
BEGIN
  c := app.change_for_write(p_change);
  IF c.stage <> 'assessment' THEN RAISE EXCEPTION '% is not in assessment', c.reference USING ERRCODE = 'QM035'; END IF;
  v_problems := app.change_problems(c.id, 'board');
  IF cardinality(v_problems) > 0 THEN RAISE EXCEPTION 'Not ready for the board: %', array_to_string(v_problems, '; ') USING ERRCODE = 'QM035'; END IF;
  v_round := c.review_round + 1;
  UPDATE public.change_requests SET stage = 'approval', review_round = v_round, return_reason = NULL WHERE id = c.id;
  INSERT INTO public.change_signoffs (organisation_id, change_id, round, function_id, signer_user_id)
  SELECT c.organisation_id, c.id, v_round, b.function_id, b.signer_user_id FROM public.change_board b WHERE b.change_id = c.id;
END $$;

-- A signer decides their sign-off. A rejection needs a comment and returns the change to assessment; the last approval approves the change.
CREATE FUNCTION app.decide_change_signoff(p_signoff uuid, p_approve boolean, p_comment text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  s public.change_signoffs%ROWTYPE; c public.change_requests%ROWTYPE; v_comment text := nullif(btrim(coalesce(p_comment, '')), ''); v_label text; v_self boolean;
BEGIN
  SELECT * INTO s FROM public.change_signoffs WHERE id = p_signoff;
  IF NOT FOUND OR NOT app.is_member(s.organisation_id) THEN RAISE EXCEPTION 'Sign-off not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO c FROM public.change_requests WHERE id = s.change_id FOR UPDATE;
  SELECT * INTO s FROM public.change_signoffs WHERE id = p_signoff FOR UPDATE;
  IF s.signer_user_id <> auth.uid() THEN RAISE EXCEPTION 'This sign-off is for someone else' USING ERRCODE = '42501'; END IF;
  IF NOT app.has_permission(s.organisation_id, 'change.approve') THEN RAISE EXCEPTION 'You are not allowed to sign off changes' USING ERRCODE = '42501'; END IF;
  IF s.status <> 'pending' OR c.stage <> 'approval' OR s.round <> c.review_round THEN RAISE EXCEPTION 'This sign-off is no longer waiting for a decision' USING ERRCODE = 'QM035'; END IF;
  v_self := coalesce((SELECT o.change_allow_self_approval FROM public.organisation_settings o WHERE o.organisation_id = c.organisation_id), false);
  IF c.raised_by = auth.uid() AND NOT v_self THEN
    RAISE EXCEPTION 'You raised this change, so you cannot sign it off (the organisation can allow that in System preferences)' USING ERRCODE = 'QM035';
  END IF;
  IF p_approve THEN
    UPDATE public.change_signoffs SET status = 'approved', comment = v_comment, decided_at = now() WHERE id = s.id;
    IF NOT EXISTS (SELECT 1 FROM public.change_signoffs x WHERE x.change_id = c.id AND x.round = c.review_round AND x.status = 'pending') THEN
      UPDATE public.change_requests SET stage = 'approved', approved_at = now(), approved_by = auth.uid(), return_reason = NULL WHERE id = c.id;
    END IF;
  ELSE
    IF v_comment IS NULL OR length(v_comment) < 3 THEN RAISE EXCEPTION 'Say why you are sending it back (at least 3 characters)' USING ERRCODE = 'QM035'; END IF;
    SELECT f.label INTO v_label FROM public.change_functions f WHERE f.id = s.function_id;
    UPDATE public.change_signoffs SET status = 'rejected', comment = v_comment, decided_at = now() WHERE id = s.id;
    UPDATE public.change_signoffs SET status = 'superseded' WHERE change_id = c.id AND round = c.review_round AND status = 'pending';
    UPDATE public.change_requests SET stage = 'assessment', return_reason = left(coalesce(v_label, 'The board') || ': ' || v_comment, 1000) WHERE id = c.id;
  END IF;
END $$;

-- A manager takes a change back from the board, with a reason (for example a signer who has left): the pending sign-offs are superseded.
CREATE FUNCTION app.recall_change(p_change uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.change_requests%ROWTYPE; v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  c := app.change_for_write(p_change);
  IF c.stage <> 'approval' THEN RAISE EXCEPTION '% is not with the board', c.reference USING ERRCODE = 'QM035'; END IF;
  IF length(v_reason) < 3 THEN RAISE EXCEPTION 'Say why it is taken back (at least 3 characters)' USING ERRCODE = 'QM035'; END IF;
  UPDATE public.change_signoffs SET status = 'superseded' WHERE change_id = c.id AND round = c.review_round AND status = 'pending';
  UPDATE public.change_requests SET stage = 'assessment', return_reason = left(v_reason, 1000) WHERE id = c.id;
END $$;

-- Keys present are set: kind (none | date | order | lot | serial), date, orderId, lotId, serialId, stockAction, stockNote (null clears). A manager, or a
-- named signer of the current round, may set it until the change is finished.
CREATE FUNCTION app.set_change_cut_in(p_change uuid, p_data jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  c public.change_requests%ROWTYPE; k text; v_kind text; v_date date; v_order uuid; v_lot uuid; v_serial uuid; v_action text; v_note text; v_ok boolean;
BEGIN
  SELECT * INTO c FROM public.change_requests WHERE id = p_change FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(c.organisation_id) THEN RAISE EXCEPTION 'Change not found' USING ERRCODE = 'P0002'; END IF;
  v_ok := app.has_permission(c.organisation_id, 'change.manage')
       OR (app.has_permission(c.organisation_id, 'change.approve')
           AND EXISTS (SELECT 1 FROM public.change_signoffs s WHERE s.change_id = c.id AND s.round = c.review_round AND s.signer_user_id = auth.uid()));
  IF NOT v_ok THEN RAISE EXCEPTION 'You are not allowed to set the cut-in point of this change' USING ERRCODE = '42501'; END IF;
  IF c.stage IN ('closed', 'rejected', 'cancelled') THEN RAISE EXCEPTION '% is % and cannot be changed', c.reference, c.stage USING ERRCODE = 'QM035'; END IF;
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Send the cut-in point as an object' USING ERRCODE = 'QM035'; END IF;
  FOR k IN SELECT jsonb_object_keys(p_data) LOOP
    IF k NOT IN ('kind', 'date', 'orderId', 'lotId', 'serialId', 'stockAction', 'stockNote') THEN RAISE EXCEPTION 'Unknown field %', k USING ERRCODE = 'QM035'; END IF;
  END LOOP;
  v_kind := CASE WHEN p_data ? 'kind' THEN p_data ->> 'kind' ELSE c.cut_in_kind END;
  IF v_kind IS NULL OR v_kind NOT IN ('none', 'date', 'order', 'lot', 'serial') THEN RAISE EXCEPTION 'The cut-in point is none, a date, an order, a lot or a serial number' USING ERRCODE = 'QM035'; END IF;
  BEGIN
    v_date := CASE WHEN p_data ? 'date' THEN nullif(p_data ->> 'date', '')::date ELSE c.cut_in_date END;
    v_order := CASE WHEN p_data ? 'orderId' THEN nullif(p_data ->> 'orderId', '')::uuid ELSE c.cut_in_order_id END;
    v_lot := CASE WHEN p_data ? 'lotId' THEN nullif(p_data ->> 'lotId', '')::uuid ELSE c.cut_in_lot_id END;
    v_serial := CASE WHEN p_data ? 'serialId' THEN nullif(p_data ->> 'serialId', '')::uuid ELSE c.cut_in_serial_id END;
  EXCEPTION WHEN others THEN RAISE EXCEPTION 'That date or record is not valid' USING ERRCODE = 'QM035';
  END;
  -- only what the kind names is kept
  v_date := CASE WHEN v_kind = 'date' THEN v_date END;
  v_order := CASE WHEN v_kind = 'order' THEN v_order END;
  v_lot := CASE WHEN v_kind = 'lot' THEN v_lot END;
  v_serial := CASE WHEN v_kind = 'serial' THEN v_serial END;
  IF v_kind = 'date' AND v_date IS NULL THEN RAISE EXCEPTION 'Choose the date it starts' USING ERRCODE = 'QM035'; END IF;
  IF v_kind = 'order' AND v_order IS NULL THEN RAISE EXCEPTION 'Choose the production order it starts with' USING ERRCODE = 'QM035'; END IF;
  IF v_kind = 'lot' AND v_lot IS NULL THEN RAISE EXCEPTION 'Choose the lot it starts with' USING ERRCODE = 'QM035'; END IF;
  IF v_kind = 'serial' AND v_serial IS NULL THEN RAISE EXCEPTION 'Choose the serial number it starts with' USING ERRCODE = 'QM035'; END IF;
  v_action := CASE WHEN p_data ? 'stockAction' THEN nullif(p_data ->> 'stockAction', '') ELSE c.stock_action END;
  IF v_action IS NOT NULL AND v_action NOT IN ('use_up', 'rework', 'scrap', 'return') THEN RAISE EXCEPTION 'Existing stock is used up, reworked, scrapped or returned' USING ERRCODE = 'QM035'; END IF;
  v_note := CASE WHEN p_data ? 'stockNote' THEN nullif(btrim(coalesce(p_data ->> 'stockNote', '')), '') ELSE c.stock_note END;
  IF length(coalesce(v_note, '')) > 1000 THEN RAISE EXCEPTION 'The stock note is up to 1,000 characters' USING ERRCODE = 'QM035'; END IF;
  BEGIN
    UPDATE public.change_requests SET cut_in_kind = v_kind, cut_in_date = v_date, cut_in_order_id = v_order, cut_in_lot_id = v_lot, cut_in_serial_id = v_serial,
           stock_action = v_action, stock_note = v_note
     WHERE id = c.id;
  EXCEPTION WHEN foreign_key_violation THEN RAISE EXCEPTION 'That order, lot or serial number is not in this organisation' USING ERRCODE = 'QM035';
  END;
END $$;

-- The customer's approval, recorded: status (not_needed | required | requested | approved | rejected | waived), their reference, the day, and for a waiver why.
CREATE FUNCTION app.set_change_customer_approval(p_change uuid, p_status text, p_reference text DEFAULT NULL, p_on date DEFAULT NULL, p_waived_reason text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.change_requests%ROWTYPE; v_ref text := nullif(btrim(coalesce(p_reference, '')), ''); v_why text := nullif(btrim(coalesce(p_waived_reason, '')), '');
BEGIN
  c := app.change_for_write(p_change);
  IF c.stage IN ('closed', 'rejected', 'cancelled') THEN RAISE EXCEPTION '% is % and cannot be changed', c.reference, c.stage USING ERRCODE = 'QM035'; END IF;
  IF p_status IS NULL OR p_status NOT IN ('not_needed', 'required', 'requested', 'approved', 'rejected', 'waived') THEN
    RAISE EXCEPTION 'The customer''s approval is not needed, required, requested, approved, rejected or waived' USING ERRCODE = 'QM035';
  END IF;
  IF p_status = 'waived' AND (v_why IS NULL OR length(v_why) < 10) THEN RAISE EXCEPTION 'Say why the customer''s approval is waived (at least 10 characters)' USING ERRCODE = 'QM035'; END IF;
  IF p_status <> 'waived' THEN v_why := NULL; END IF;
  IF p_on IS NOT NULL AND p_on > current_date THEN RAISE EXCEPTION 'The date cannot be in the future' USING ERRCODE = 'QM035'; END IF;
  UPDATE public.change_requests SET customer_approval = p_status, customer_reference = v_ref, customer_waived_reason = v_why,
         customer_approval_on = CASE WHEN p_status IN ('requested', 'approved', 'rejected') THEN coalesce(p_on, current_date) ELSE NULL END
   WHERE id = c.id;
END $$;

-- Drafts and changes in assessment: the wording, and the type only in draft (replaces the CH1 function).
CREATE OR REPLACE FUNCTION app.update_change(p_change uuid, p_data jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.change_requests%ROWTYPE; k text; v_title text; v_type uuid; v_urgency text;
BEGIN
  c := app.change_for_write(p_change);
  IF c.stage NOT IN ('draft', 'assessment') THEN RAISE EXCEPTION '% has been to the board and its wording no longer changes', c.reference USING ERRCODE = 'QM035'; END IF;
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Send the changes as an object' USING ERRCODE = 'QM035'; END IF;
  FOR k IN SELECT jsonb_object_keys(p_data) LOOP
    IF k NOT IN ('title', 'description', 'reason', 'typeId', 'urgency') THEN RAISE EXCEPTION 'Unknown field %', k USING ERRCODE = 'QM035'; END IF;
  END LOOP;
  v_title := CASE WHEN p_data ? 'title' THEN btrim(coalesce(p_data ->> 'title', '')) ELSE c.title END;
  IF length(v_title) = 0 THEN RAISE EXCEPTION 'Give the change a title' USING ERRCODE = 'QM035'; END IF;
  IF length(v_title) > 200 THEN RAISE EXCEPTION 'The title is up to 200 characters' USING ERRCODE = 'QM035'; END IF;
  v_type := CASE WHEN p_data ? 'typeId' THEN nullif(p_data ->> 'typeId', '')::uuid ELSE c.type_id END;
  IF v_type IS DISTINCT FROM c.type_id AND c.stage <> 'draft' THEN RAISE EXCEPTION 'The type of a change is fixed once it leaves draft' USING ERRCODE = 'QM035'; END IF;
  IF v_type IS NULL OR NOT EXISTS (SELECT 1 FROM public.change_types t WHERE t.id = v_type AND t.organisation_id = c.organisation_id AND (t.active OR t.id = c.type_id)) THEN
    RAISE EXCEPTION 'Choose an active type of change of this organisation' USING ERRCODE = 'QM035';
  END IF;
  v_urgency := CASE WHEN p_data ? 'urgency' THEN p_data ->> 'urgency' ELSE c.urgency END;
  IF v_urgency IS NULL OR v_urgency NOT IN ('normal', 'expedited') THEN RAISE EXCEPTION 'A change is normal or expedited' USING ERRCODE = 'QM035'; END IF;
  UPDATE public.change_requests SET
    title = v_title, type_id = v_type, urgency = v_urgency,
    description = CASE WHEN p_data ? 'description' THEN nullif(btrim(coalesce(p_data ->> 'description', '')), '') ELSE description END,
    reason = CASE WHEN p_data ? 'reason' THEN nullif(btrim(coalesce(p_data ->> 'reason', '')), '') ELSE reason END
  WHERE id = c.id;
END $$;

-- What a change covers can change in assessment too (replaces the CH1 function).
CREATE OR REPLACE FUNCTION app.set_change_links(p_change uuid, p_links jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.change_requests%ROWTYPE; e jsonb; v_kind text; v_id uuid; v_code text;
BEGIN
  c := app.change_for_write(p_change);
  IF c.stage NOT IN ('draft', 'assessment') THEN RAISE EXCEPTION 'What % covers can be changed only while it is a draft or being assessed', c.reference USING ERRCODE = 'QM035'; END IF;
  IF jsonb_typeof(coalesce(p_links, '[]'::jsonb)) <> 'array' THEN RAISE EXCEPTION 'Send the links as a list' USING ERRCODE = 'QM035'; END IF;
  IF jsonb_array_length(coalesce(p_links, '[]'::jsonb)) > 100 THEN RAISE EXCEPTION 'A change covers at most 100 things' USING ERRCODE = 'QM035'; END IF;
  DELETE FROM public.change_links WHERE change_id = c.id;
  FOR e IN SELECT * FROM jsonb_array_elements(coalesce(p_links, '[]'::jsonb)) LOOP
    v_kind := e ->> 'kind';
    IF v_kind IS NULL OR v_kind NOT IN ('part', 'part_family', 'machine', 'supplier', 'customer', 'production_order', 'operation_code') THEN
      RAISE EXCEPTION 'A change covers parts, part families, machines, suppliers, customers, production orders or operations' USING ERRCODE = 'QM035';
    END IF;
    IF v_kind = 'operation_code' THEN
      v_code := btrim(coalesce(e ->> 'code', ''));
      IF length(v_code) NOT BETWEEN 1 AND 40 THEN RAISE EXCEPTION 'An operation code is 1 to 40 characters' USING ERRCODE = 'QM035'; END IF;
      INSERT INTO public.change_links (organisation_id, change_id, kind, operation_code) VALUES (c.organisation_id, c.id, v_kind, v_code) ON CONFLICT DO NOTHING;
    ELSE
      BEGIN v_id := (e ->> 'id')::uuid; EXCEPTION WHEN others THEN v_id := NULL; END;
      IF v_id IS NULL THEN RAISE EXCEPTION 'Each link names the record it is to' USING ERRCODE = 'QM035'; END IF;
      BEGIN
        EXECUTE format('INSERT INTO public.change_links (organisation_id, change_id, kind, %I) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', v_kind || '_id')
          USING c.organisation_id, c.id, v_kind, v_id;
      EXCEPTION WHEN foreign_key_violation THEN
        RAISE EXCEPTION 'That % is not in this organisation', replace(v_kind, '_', ' ') USING ERRCODE = 'QM035';
      END;
    END IF;
  END LOOP;
  UPDATE public.change_requests SET updated_at = now() WHERE id = c.id;
END $$;

-- Cancelling during approval supersedes the pending sign-offs (replaces the CH1 function).
CREATE OR REPLACE FUNCTION app.cancel_change(p_change uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.change_requests%ROWTYPE; v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  c := app.change_for_write(p_change);
  IF c.stage IN ('closed', 'rejected', 'cancelled') THEN RAISE EXCEPTION '% is % and cannot be cancelled', c.reference, c.stage USING ERRCODE = 'QM035'; END IF;
  IF length(v_reason) < 3 THEN RAISE EXCEPTION 'Say why it is cancelled (at least 3 characters)' USING ERRCODE = 'QM035'; END IF;
  UPDATE public.change_signoffs SET status = 'superseded' WHERE change_id = c.id AND status = 'pending';
  UPDATE public.change_requests SET stage = 'cancelled', cancel_reason = left(v_reason, 500), cancelled_at = now(), cancelled_by = auth.uid() WHERE id = c.id;
END $$;

REVOKE ALL ON FUNCTION app.change_assessment_rules(), app.change_signoff_rules() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.change_problems(uuid, text), app.change_signer_candidates(uuid), app.submit_change(uuid), app.set_change_impact(uuid, uuid, text, text),
  app.set_change_board(uuid, jsonb), app.send_change_to_board(uuid), app.decide_change_signoff(uuid, boolean, text), app.recall_change(uuid, text),
  app.set_change_cut_in(uuid, jsonb), app.set_change_customer_approval(uuid, text, text, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.change_problems(uuid, text), app.change_signer_candidates(uuid), app.submit_change(uuid), app.set_change_impact(uuid, uuid, text, text),
  app.set_change_board(uuid, jsonb), app.send_change_to_board(uuid), app.decide_change_signoff(uuid, boolean, text), app.recall_change(uuid, text),
  app.set_change_cut_in(uuid, jsonb), app.set_change_customer_approval(uuid, text, text, date, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. Who a column names (the account-move drift check), and notices
-- ---------------------------------------------------------------------------
-- The function is rewritten from its live definition by a checked text patch: the migration refuses to finish unless the anchor is found exactly once.
CREATE FUNCTION pg_temp.patch(p_fn regprocedure, p_old text, p_new text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_def text := replace(pg_get_functiondef(p_fn), E'\r', ''); v_n integer;
BEGIN
  v_n := (length(v_def) - length(replace(v_def, p_old, ''))) / length(p_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'Expected to find % exactly once in %, found % times', p_old, p_fn, v_n; END IF;
  EXECUTE replace(v_def, p_old, p_new);
END $$;

-- A person named as a signer is a standing responsibility, but it is handled as history: after a move to a company account the pending sign-off still
-- names the old account, which can no longer sign; a manager recalls the change from the board and chooses the board again.
SELECT pg_temp.patch(
  'app.user_reference_columns()'::regprocedure,
  $old$    ('portal_views', 'user_id', 'history', 'Who has seen a shared record'),$old$,
  $new$    ('portal_views', 'user_id', 'history', 'Who has seen a shared record'),
    ('change_board', 'signer_user_id', 'history', 'The person chosen to sign for a function on a change; after a move to a company account a manager recalls the change and chooses again'),
    ('change_signoffs', 'signer_user_id', 'history', 'Who was asked to sign; a sign-off still waiting for the old account is recalled and asked again'),$new$);

INSERT INTO public.notification_event_types
  (key, entity_type, action, group_name, entity_label, description, permission_code, default_on, default_permission_code, label_fields, display_order, own_record, email_default)
VALUES
  ('change_signoffs.created', 'change_signoffs', 'created', 'Change', 'Change sign-off', 'A change is waiting for your sign-off', 'change.read', true, NULL,
   ARRAY['change_label', 'function_label'], 10, true, true),
  ('change_requests.updated', 'change_requests', 'updated', 'Change', 'Change', 'A change you raised was decided', 'change.read', true, NULL,
   ARRAY['change_label', 'decision_label'], 11, true, true);

-- The notification trigger (the 20260303100000 version) with the change notices: a sign-off is announced to its signer when it is created; the raiser
-- is told when the board approves the change or sends it back. Nothing else about a change is announced, and nobody is told of their own action.
SELECT pg_temp.patch('app.emit_notification()'::regprocedure,
  E'  v_mr_row jsonb;\nBEGIN',
  E'  v_mr_row jsonb;\n  v_change_row jsonb;\nBEGIN');
SELECT pg_temp.patch('app.emit_notification()'::regprocedure,
  E'  v_action := CASE\n    WHEN NEW.action = ''insert'' THEN ''created''',
  E'  IF NEW.entity_type = ''change_signoffs'' AND NEW.action <> ''insert'' THEN RETURN NULL; END IF;\n'
  || E'  IF NEW.entity_type = ''change_requests'' AND NOT (NEW.action = ''update'' AND coalesce(NEW.changed_fields, ''{}'') @> ARRAY[''stage''] AND NEW.new_values ->> ''stage'' IN (''approved'', ''assessment'')) THEN RETURN NULL; END IF;\n'
  || E'  v_action := CASE\n    WHEN NEW.action = ''insert'' THEN ''created''');
SELECT pg_temp.patch('app.emit_notification()'::regprocedure,
  E'  -- An overdue notice says what and since when; the area and the record behind it lead the link.',
  E'  -- A change sign-off tells its signer which change and for which function; a decided change tells the person who raised it.\n'
  || E'  IF NEW.entity_type = ''change_signoffs'' THEN\n'
  || E'    SELECT to_jsonb(s) || jsonb_build_object(''user_id'', s.signer_user_id, ''change_id'', c.id, ''change_label'', c.reference || '' · '' || c.title, ''function_label'', ''Sign off for '' || f.label)\n'
  || E'      INTO v_change_row FROM public.change_signoffs s JOIN public.change_requests c ON c.id = s.change_id JOIN public.change_functions f ON f.id = s.function_id\n'
  || E'     WHERE s.id = NEW.entity_id::uuid;\n'
  || E'    IF v_change_row IS NULL OR (v_change_row ->> ''user_id'')::uuid IS NOT DISTINCT FROM NEW.actor_user_id THEN RETURN NULL; END IF;\n'
  || E'    v_row := v_change_row;\n  END IF;\n'
  || E'  IF NEW.entity_type = ''change_requests'' THEN\n'
  || E'    SELECT to_jsonb(c) || jsonb_build_object(''user_id'', c.raised_by, ''change_id'', c.id, ''change_label'', c.reference || '' · '' || c.title,\n'
  || E'             ''decision_label'', CASE WHEN c.stage = ''approved'' THEN ''Approved by the board'' ELSE ''Sent back to assessment: '' || coalesce(c.return_reason, '''') END)\n'
  || E'      INTO v_change_row FROM public.change_requests c WHERE c.id = NEW.entity_id::uuid;\n'
  || E'    IF v_change_row IS NULL OR (v_change_row ->> ''stage'' = ''assessment'' AND coalesce(NEW.previous_values ->> ''stage'', '''') <> ''approval'')\n'
  || E'       OR (v_change_row ->> ''user_id'')::uuid IS NOT DISTINCT FROM NEW.actor_user_id THEN RETURN NULL; END IF;\n'
  || E'    v_row := v_change_row;\n  END IF;\n\n'
  || E'  -- An overdue notice says what and since when; the area and the record behind it lead the link.');
SELECT pg_temp.patch('app.emit_notification()'::regprocedure,
  E'''management_review_actions'') THEN\n    v_what := ''Changed: ''',
  E'''management_review_actions'', ''change_requests'') THEN\n    v_what := ''Changed: ''');
SELECT pg_temp.patch('app.emit_notification()'::regprocedure,
  E'''record_kind'', ''record_id'', ''task_id'']) k',
  E'''record_kind'', ''record_id'', ''task_id'', ''change_id'']) k');
SELECT pg_temp.patch('app.emit_notification()'::regprocedure,
  E'    v_recipient := (v_row ->> ''user_id'')::uuid;\n  END IF;',
  E'    v_recipient := (v_row ->> ''user_id'')::uuid;\n  END IF;\n  IF NEW.entity_type IN (''change_signoffs'', ''change_requests'') THEN v_recipient := (v_row ->> ''user_id'')::uuid; END IF;');
