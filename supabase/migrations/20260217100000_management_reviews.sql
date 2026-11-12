-- Management review, slice MR2 (docs/risk-management-plan.md RM9-RM11, §5): the reviews themselves.
--
--  * management_reviews: MR-YY-NN per organisation and year. Title, the period it reviews, planned date, the day it was held, chair (an active member), minutes
--    (TipTap JSON, as documents; text kept for search). planned -> in_progress (started) -> completed (frozen) | cancelled (reason). Nothing deleted.
--  * management_review_inputs: one row per input section (the fixed list of ISO 9001 9.3.2, app.management_review_sections()), made when the review is planned.
--    The API gathers each data section for the period from the module's own dashboard AS THE PERSON and stores it here as a frozen snapshot (or "not available"
--    to them, never zeros); people add commentary and mark each section reviewed. Two sections are commentary only (changes in context, opportunities for improvement).
--  * management_review_attendees: members or named outsiders, a role, invited / present / apologies; replaced as a whole until the review is completed.
--  * management_review_decisions: what was decided (improvement / resources / QMS change / other).
--  * management_review_actions: description, owner (an active member), due date, optionally the decision it came from; open -> done (note) | cancelled (reason),
--    reopened. Added while the review is held; they live on after it is completed (an owner closes theirs; MR3 lists them in the next review).
--  * Completing needs every section reviewed, someone recorded as present, the day it was held, and at least one decision or a note that none was needed.
--    A completed or cancelled review, its inputs, attendees and decisions never change again (triggers, even for SQL).
--  * No table writes: SECURITY DEFINER functions only (management_review.manage; an action's owner may also close it). Read with management_review.read;
--    an action's owner also reads their action.
-- Errors use QM027 (409 management_review_rule); another organisation's id is P0002 (404).

-- ---------------------------------------------------------------------------
-- The input sections (fixed list, in order)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.management_review_sections() RETURNS TABLE (key text, ord integer, title text, commentary_only boolean)
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT * FROM (VALUES
    ('previous_actions',     1, 'Actions from previous reviews', false),
    ('context',              2, 'Changes in external and internal issues', true),
    ('customer_feedback',    3, 'Customer satisfaction and feedback', false),
    ('quality_objectives',   4, 'Quality objectives', false),
    ('process_performance',  5, 'Process performance and product conformity', false),
    ('nonconformities',      6, 'Nonconformities and corrective actions', false),
    ('monitoring',           7, 'Monitoring and measurement results', false),
    ('audit_results',        8, 'Audit results', false),
    ('external_providers',   9, 'Performance of external providers', false),
    ('resources',           10, 'Adequacy of resources', false),
    ('risks',               11, 'Effectiveness of actions on risks and opportunities', false),
    ('improvement',         12, 'Opportunities for improvement', true)
  ) s(key, ord, title, commentary_only)
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE app.management_review_counters (
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  year integer NOT NULL,
  last_value integer NOT NULL,
  PRIMARY KEY (organisation_id, year)
);
REVOKE ALL ON app.management_review_counters FROM PUBLIC, anon, authenticated;

CREATE TABLE public.management_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  reference text NOT NULL CHECK (reference ~ '^MR-[0-9]{2}-[0-9]{2,}$'),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  period_from date NOT NULL,
  period_to date NOT NULL,
  planned_on date,
  held_on date,
  chair_user_id uuid NOT NULL REFERENCES auth.users (id),
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'in_progress', 'completed', 'cancelled')),
  minutes jsonb CHECK (minutes IS NULL OR (jsonb_typeof(minutes) = 'object' AND minutes ->> 'type' = 'doc' AND pg_column_size(minutes) <= 512000)),
  minutes_text text,
  no_decision_note text CHECK (no_decision_note IS NULL OR length(btrim(no_decision_note)) BETWEEN 3 AND 1000),
  cancel_reason text CHECK (cancel_reason IS NULL OR length(btrim(cancel_reason)) BETWEEN 3 AND 500),
  started_at timestamptz,
  started_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  completed_at timestamptz,
  completed_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  cancelled_at timestamptz,
  cancelled_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT management_reviews_reference_key UNIQUE (organisation_id, reference),
  CONSTRAINT management_reviews_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT management_reviews_period_check CHECK (period_from <= period_to),
  CONSTRAINT management_reviews_completed_check CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  CONSTRAINT management_reviews_cancelled_check CHECK ((status = 'cancelled') = (cancel_reason IS NOT NULL AND cancelled_at IS NOT NULL))
);
CREATE INDEX management_reviews_org_idx ON public.management_reviews (organisation_id, status, period_to DESC);

CREATE TABLE public.management_review_inputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  review_id uuid NOT NULL,
  section text NOT NULL,
  position integer NOT NULL,
  snapshot jsonb CHECK (snapshot IS NULL OR (jsonb_typeof(snapshot) = 'object' AND pg_column_size(snapshot) <= 512000)),
  available boolean,
  gathered_at timestamptz,
  gathered_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  commentary text CHECK (commentary IS NULL OR length(btrim(commentary)) BETWEEN 1 AND 8000),
  reviewed boolean NOT NULL DEFAULT false,
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT management_review_inputs_review_fkey FOREIGN KEY (review_id, organisation_id) REFERENCES public.management_reviews (id, organisation_id),
  CONSTRAINT management_review_inputs_section_key UNIQUE (review_id, section),
  CONSTRAINT management_review_inputs_gathered_check CHECK ((gathered_at IS NULL) = (available IS NULL)),
  CONSTRAINT management_review_inputs_reviewed_check CHECK (reviewed = (reviewed_at IS NOT NULL))
);

CREATE TABLE public.management_review_attendees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  review_id uuid NOT NULL,
  user_id uuid REFERENCES auth.users (id),
  name text CHECK (name IS NULL OR length(btrim(name)) BETWEEN 1 AND 120),
  role text CHECK (role IS NULL OR length(btrim(role)) BETWEEN 1 AND 100),
  attendance text NOT NULL DEFAULT 'invited' CHECK (attendance IN ('invited', 'present', 'apologies')),
  position integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT management_review_attendees_review_fkey FOREIGN KEY (review_id, organisation_id) REFERENCES public.management_reviews (id, organisation_id),
  CONSTRAINT management_review_attendees_who_check CHECK ((user_id IS NULL) <> (name IS NULL))
);
CREATE UNIQUE INDEX management_review_attendees_user_key ON public.management_review_attendees (review_id, user_id) WHERE user_id IS NOT NULL;

CREATE TABLE public.management_review_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  review_id uuid NOT NULL,
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 2000),
  category text NOT NULL CHECK (category IN ('improvement', 'resources', 'qms_change', 'other')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT management_review_decisions_review_fkey FOREIGN KEY (review_id, organisation_id) REFERENCES public.management_reviews (id, organisation_id),
  CONSTRAINT management_review_decisions_id_org_key UNIQUE (id, organisation_id)
);
CREATE INDEX management_review_decisions_review_idx ON public.management_review_decisions (organisation_id, review_id);

CREATE TABLE public.management_review_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  review_id uuid NOT NULL,
  decision_id uuid,
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 2000),
  owner_user_id uuid NOT NULL REFERENCES auth.users (id),
  due_date date,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  done_note text CHECK (done_note IS NULL OR length(btrim(done_note)) BETWEEN 1 AND 2000),
  done_at timestamptz,
  done_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  cancel_reason text CHECK (cancel_reason IS NULL OR length(btrim(cancel_reason)) BETWEEN 3 AND 500),
  cancelled_at timestamptz,
  cancelled_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT management_review_actions_review_fkey FOREIGN KEY (review_id, organisation_id) REFERENCES public.management_reviews (id, organisation_id),
  CONSTRAINT management_review_actions_decision_fkey FOREIGN KEY (decision_id, organisation_id) REFERENCES public.management_review_decisions (id, organisation_id),
  CONSTRAINT management_review_actions_state_check CHECK (((status = 'done') = (done_at IS NOT NULL AND done_note IS NOT NULL)) AND ((status = 'cancelled') = (cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL)))
);
CREATE INDEX management_review_actions_review_idx ON public.management_review_actions (organisation_id, review_id);
CREATE INDEX management_review_actions_owner_idx ON public.management_review_actions (organisation_id, owner_user_id) WHERE status = 'open';

-- ---------------------------------------------------------------------------
-- Freezing (even for SQL)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.management_review_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A management review is never deleted. Cancel it with a reason.' USING ERRCODE = 'QM027'; END IF;
  IF OLD.status IN ('completed', 'cancelled') THEN RAISE EXCEPTION '% is % and cannot change', OLD.reference, OLD.status USING ERRCODE = 'QM027'; END IF;
  IF NEW.reference IS DISTINCT FROM OLD.reference THEN RAISE EXCEPTION 'A review''s reference never changes' USING ERRCODE = 'QM027'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER management_reviews_rules BEFORE UPDATE OR DELETE ON public.management_reviews FOR EACH ROW EXECUTE FUNCTION app.management_review_rules();

-- Inputs, attendees and decisions change only while their review is planned or being held; inputs are never deleted.
CREATE FUNCTION app.management_review_child_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_status text; v_ref text;
BEGIN
  IF TG_OP = 'DELETE' AND TG_TABLE_NAME = 'management_review_inputs' THEN RAISE EXCEPTION 'An input section is never deleted' USING ERRCODE = 'QM027'; END IF;
  SELECT status, reference INTO v_status, v_ref FROM public.management_reviews WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.review_id ELSE NEW.review_id END;
  IF v_status NOT IN ('planned', 'in_progress') THEN RAISE EXCEPTION '% is % and cannot change', v_ref, v_status USING ERRCODE = 'QM027'; END IF;
  IF TG_OP = 'UPDATE' AND NEW.review_id IS DISTINCT FROM OLD.review_id THEN RAISE EXCEPTION 'It belongs to its review' USING ERRCODE = 'QM027'; END IF;
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'management_review_inputs' THEN
    IF to_jsonb(NEW) ->> 'section' IS DISTINCT FROM to_jsonb(OLD) ->> 'section' THEN RAISE EXCEPTION 'A section never changes' USING ERRCODE = 'QM027'; END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER management_review_inputs_rules BEFORE INSERT OR UPDATE OR DELETE ON public.management_review_inputs FOR EACH ROW EXECUTE FUNCTION app.management_review_child_rules();
CREATE TRIGGER management_review_attendees_rules BEFORE INSERT OR UPDATE OR DELETE ON public.management_review_attendees FOR EACH ROW EXECUTE FUNCTION app.management_review_child_rules();
CREATE TRIGGER management_review_decisions_rules BEFORE INSERT OR UPDATE OR DELETE ON public.management_review_decisions FOR EACH ROW EXECUTE FUNCTION app.management_review_child_rules();

-- Actions are never deleted; they are added only while their review is being held, and belong to it.
CREATE FUNCTION app.management_review_action_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'An action is never deleted. Cancel it with a reason.' USING ERRCODE = 'QM027'; END IF;
  IF TG_OP = 'INSERT' AND NOT EXISTS (SELECT 1 FROM public.management_reviews WHERE id = NEW.review_id AND status = 'in_progress') THEN
    RAISE EXCEPTION 'Actions are added while the review is being held' USING ERRCODE = 'QM027';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.review_id IS DISTINCT FROM OLD.review_id OR NEW.decision_id IS DISTINCT FROM OLD.decision_id) THEN
    RAISE EXCEPTION 'An action belongs to its review and decision' USING ERRCODE = 'QM027';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER management_review_actions_rules BEFORE INSERT OR UPDATE OR DELETE ON public.management_review_actions FOR EACH ROW EXECUTE FUNCTION app.management_review_action_rules();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['management_reviews', 'management_review_inputs', 'management_review_attendees', 'management_review_decisions', 'management_review_actions'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION app.stamp_created()', t || '_stamp', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.touch_updated()', t || '_touch', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change()', t || '_org_immutable', t);
    EXECUTE format('CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION audit.record_change(''organisation_id'')', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    IF t <> 'management_review_actions' THEN
      EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (app.has_permission(organisation_id, ''management_review.read''))', t || '_select', t);
    END IF;
  END LOOP;
END $$;
CREATE POLICY management_review_actions_select ON public.management_review_actions FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'management_review.read') OR (owner_user_id = (SELECT auth.uid()) AND app.is_member(organisation_id)));

-- ---------------------------------------------------------------------------
-- Functions (SECURITY DEFINER)
-- ---------------------------------------------------------------------------
-- Lock a review the caller may manage; P0002 for another organisation's or an unknown id.
CREATE FUNCTION app.management_review_for_update(p_review uuid) RETURNS public.management_reviews
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.management_reviews%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.management_reviews WHERE id = p_review FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(r.organisation_id) THEN RAISE EXCEPTION 'Management review not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_objective_manager(r.organisation_id);
  RETURN r;
END $$;

CREATE FUNCTION app.assert_review_open(r public.management_reviews, p_states text[] DEFAULT ARRAY['planned', 'in_progress']) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
BEGIN
  IF NOT r.status = ANY (p_states) THEN
    RAISE EXCEPTION '%', CASE
      WHEN r.status = 'completed' THEN r.reference || ' is completed and cannot change'
      WHEN r.status = 'cancelled' THEN r.reference || ' is cancelled'
      WHEN r.status = 'planned' THEN r.reference || ' has not started yet. Start the review first.'
      ELSE r.reference || ' has already started' END USING ERRCODE = 'QM027';
  END IF;
END $$;

-- Plan a review. Keys: title, periodFrom, periodTo (at most three years), plannedOn, chairId (default the caller). Makes its input sections.
CREATE FUNCTION app.plan_management_review(p_organisation_id uuid, p_data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE k text; v_from date; v_to date; v_chair uuid; v_title text; v_year integer; v_n integer; v_id uuid;
BEGIN
  PERFORM app.assert_objective_manager(p_organisation_id);
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Send the review as an object' USING ERRCODE = 'QM027'; END IF;
  FOR k IN SELECT jsonb_object_keys(p_data) LOOP
    IF k NOT IN ('title', 'periodFrom', 'periodTo', 'plannedOn', 'chairId') THEN RAISE EXCEPTION 'Unknown field %', k USING ERRCODE = 'QM027'; END IF;
  END LOOP;
  v_title := btrim(coalesce(p_data ->> 'title', ''));
  IF length(v_title) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'The title is 1 to 200 characters' USING ERRCODE = 'QM027'; END IF;
  v_from := nullif(p_data ->> 'periodFrom', '')::date;
  v_to := nullif(p_data ->> 'periodTo', '')::date;
  IF v_from IS NULL OR v_to IS NULL OR v_from > v_to THEN RAISE EXCEPTION 'Give the period it reviews: from a day to the same day or later' USING ERRCODE = 'QM027'; END IF;
  IF v_to - v_from > 3 * 366 THEN RAISE EXCEPTION 'A review covers at most three years' USING ERRCODE = 'QM027'; END IF;
  v_chair := coalesce(nullif(p_data ->> 'chairId', '')::uuid, auth.uid());
  IF NOT app.is_active_member_user(p_organisation_id, v_chair) THEN RAISE EXCEPTION 'The chair must be an active member of this organisation' USING ERRCODE = 'QM027'; END IF;
  v_year := extract(year FROM current_date)::integer;
  INSERT INTO app.management_review_counters AS c (organisation_id, year, last_value) VALUES (p_organisation_id, v_year, 1)
  ON CONFLICT (organisation_id, year) DO UPDATE SET last_value = c.last_value + 1 RETURNING last_value INTO v_n;
  INSERT INTO public.management_reviews (organisation_id, reference, title, period_from, period_to, planned_on, chair_user_id)
  VALUES (p_organisation_id, 'MR-' || to_char(current_date, 'YY') || '-' || app.pad_number(v_n, 2), v_title, v_from, v_to, nullif(p_data ->> 'plannedOn', '')::date, v_chair)
  RETURNING id INTO v_id;
  INSERT INTO public.management_review_inputs (organisation_id, review_id, section, position)
  SELECT p_organisation_id, v_id, s.key, s.ord FROM app.management_review_sections() s;
  RETURN v_id;
END $$;

-- Keys present are set: title, plannedOn, chairId; the period only before it starts; heldOn only once it has started (not in the future).
CREATE FUNCTION app.update_management_review(p_review uuid, p_data jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.management_reviews%ROWTYPE; k text; v_from date; v_to date; v_chair uuid; v_title text; v_held date;
BEGIN
  r := app.management_review_for_update(p_review);
  PERFORM app.assert_review_open(r);
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Send the changes as an object' USING ERRCODE = 'QM027'; END IF;
  FOR k IN SELECT jsonb_object_keys(p_data) LOOP
    IF k NOT IN ('title', 'periodFrom', 'periodTo', 'plannedOn', 'chairId', 'heldOn') THEN RAISE EXCEPTION 'Unknown field %', k USING ERRCODE = 'QM027'; END IF;
  END LOOP;
  IF (p_data ? 'periodFrom' OR p_data ? 'periodTo') AND r.status <> 'planned' THEN
    RAISE EXCEPTION 'The period is fixed once the review has started (its inputs were gathered for it)' USING ERRCODE = 'QM027';
  END IF;
  IF p_data ? 'heldOn' AND r.status <> 'in_progress' THEN RAISE EXCEPTION 'The day it was held is recorded once the review has started' USING ERRCODE = 'QM027'; END IF;
  v_title := CASE WHEN p_data ? 'title' THEN btrim(coalesce(p_data ->> 'title', '')) ELSE r.title END;
  IF length(v_title) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'The title is 1 to 200 characters' USING ERRCODE = 'QM027'; END IF;
  v_from := CASE WHEN p_data ? 'periodFrom' THEN nullif(p_data ->> 'periodFrom', '')::date ELSE r.period_from END;
  v_to := CASE WHEN p_data ? 'periodTo' THEN nullif(p_data ->> 'periodTo', '')::date ELSE r.period_to END;
  IF v_from IS NULL OR v_to IS NULL OR v_from > v_to THEN RAISE EXCEPTION 'Give the period it reviews: from a day to the same day or later' USING ERRCODE = 'QM027'; END IF;
  IF v_to - v_from > 3 * 366 THEN RAISE EXCEPTION 'A review covers at most three years' USING ERRCODE = 'QM027'; END IF;
  v_chair := CASE WHEN p_data ? 'chairId' THEN nullif(p_data ->> 'chairId', '')::uuid ELSE r.chair_user_id END;
  IF v_chair IS DISTINCT FROM r.chair_user_id AND (v_chair IS NULL OR NOT app.is_active_member_user(r.organisation_id, v_chair)) THEN
    RAISE EXCEPTION 'The chair must be an active member of this organisation' USING ERRCODE = 'QM027';
  END IF;
  v_held := CASE WHEN p_data ? 'heldOn' THEN nullif(p_data ->> 'heldOn', '')::date ELSE r.held_on END;
  IF p_data ? 'heldOn' AND (v_held IS NULL OR v_held > current_date) THEN RAISE EXCEPTION 'The day it was held is today or earlier' USING ERRCODE = 'QM027'; END IF;
  UPDATE public.management_reviews
     SET title = v_title, period_from = v_from, period_to = v_to, chair_user_id = v_chair, held_on = v_held,
         planned_on = CASE WHEN p_data ? 'plannedOn' THEN nullif(p_data ->> 'plannedOn', '')::date ELSE planned_on END
   WHERE id = r.id;
END $$;

-- Starting it: the meeting is happening (held today unless changed); its inputs can now be gathered.
CREATE FUNCTION app.start_management_review(p_review uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.management_reviews%ROWTYPE;
BEGIN
  r := app.management_review_for_update(p_review);
  PERFORM app.assert_review_open(r, ARRAY['planned']);
  UPDATE public.management_reviews SET status = 'in_progress', held_on = coalesce(held_on, current_date), started_at = now(), started_by = auth.uid() WHERE id = r.id;
END $$;

-- The API's gathering: a data section's snapshot, as gathered for the person, or "not available" to them. Gathering again replaces it and asks for it to be reviewed again.
CREATE FUNCTION app.set_management_review_snapshot(p_review uuid, p_section text, p_available boolean, p_snapshot jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.management_reviews%ROWTYPE; v_only boolean;
BEGIN
  r := app.management_review_for_update(p_review);
  PERFORM app.assert_review_open(r, ARRAY['in_progress']);
  SELECT s.commentary_only INTO v_only FROM app.management_review_sections() s WHERE s.key = p_section;
  IF v_only IS NULL THEN RAISE EXCEPTION 'Unknown section %', p_section USING ERRCODE = 'QM027'; END IF;
  IF v_only THEN RAISE EXCEPTION 'That section is commentary only' USING ERRCODE = 'QM027'; END IF;
  IF p_available IS NULL OR (p_available AND jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object') THEN RAISE EXCEPTION 'Send the figures as an object' USING ERRCODE = 'QM027'; END IF;
  UPDATE public.management_review_inputs
     SET snapshot = CASE WHEN p_available THEN p_snapshot END, available = p_available, gathered_at = now(), gathered_by = auth.uid(),
         reviewed = false, reviewed_at = NULL, reviewed_by = NULL
   WHERE review_id = r.id AND section = p_section;
END $$;

-- Commentary and "reviewed" for one section. Reviewed needs the figures gathered (or, for a commentary-only section, commentary).
CREATE FUNCTION app.set_management_review_input(p_input uuid, p_commentary text, p_reviewed boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE i public.management_review_inputs%ROWTYPE; r public.management_reviews%ROWTYPE; v_only boolean; v_text text := nullif(btrim(coalesce(p_commentary, '')), '');
BEGIN
  SELECT * INTO i FROM public.management_review_inputs WHERE id = p_input;
  IF NOT FOUND THEN RAISE EXCEPTION 'Section not found' USING ERRCODE = 'P0002'; END IF;
  r := app.management_review_for_update(i.review_id);
  PERFORM app.assert_review_open(r, ARRAY['in_progress']);
  IF length(v_text) > 8000 THEN RAISE EXCEPTION 'The commentary is up to 8000 characters' USING ERRCODE = 'QM027'; END IF;
  SELECT s.commentary_only INTO v_only FROM app.management_review_sections() s WHERE s.key = i.section;
  IF coalesce(p_reviewed, false) AND v_only AND v_text IS NULL THEN RAISE EXCEPTION 'Write the commentary before marking this section reviewed' USING ERRCODE = 'QM027'; END IF;
  IF coalesce(p_reviewed, false) AND NOT v_only AND i.gathered_at IS NULL THEN RAISE EXCEPTION 'Gather the figures before marking this section reviewed' USING ERRCODE = 'QM027'; END IF;
  UPDATE public.management_review_inputs
     SET commentary = v_text, reviewed = coalesce(p_reviewed, false),
         reviewed_at = CASE WHEN coalesce(p_reviewed, false) THEN coalesce(reviewed_at, now()) END,
         reviewed_by = CASE WHEN coalesce(p_reviewed, false) THEN coalesce(reviewed_by, auth.uid()) END
   WHERE id = i.id;
END $$;

-- Attendees, replaced as a whole: [{userId} | {name}, role?, attendance invited|present|apologies].
CREATE FUNCTION app.set_management_review_attendees(p_review uuid, p_attendees jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.management_reviews%ROWTYPE; a jsonb; k text; v_user uuid; v_name text; v_role text; v_att text; v_pos integer := 0;
BEGIN
  r := app.management_review_for_update(p_review);
  PERFORM app.assert_review_open(r);
  IF jsonb_typeof(p_attendees) IS DISTINCT FROM 'array' OR jsonb_array_length(p_attendees) > 100 THEN RAISE EXCEPTION 'Send up to 100 attendees as a list' USING ERRCODE = 'QM027'; END IF;
  DELETE FROM public.management_review_attendees WHERE review_id = r.id;
  FOR a IN SELECT x FROM jsonb_array_elements(p_attendees) x LOOP
    IF jsonb_typeof(a) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Each attendee is an object' USING ERRCODE = 'QM027'; END IF;
    FOR k IN SELECT jsonb_object_keys(a) LOOP
      IF k NOT IN ('userId', 'name', 'role', 'attendance') THEN RAISE EXCEPTION 'Unknown field %', k USING ERRCODE = 'QM027'; END IF;
    END LOOP;
    v_user := nullif(a ->> 'userId', '')::uuid;
    v_name := nullif(btrim(coalesce(a ->> 'name', '')), '');
    IF (v_user IS NULL) = (v_name IS NULL) THEN RAISE EXCEPTION 'An attendee is a member or a name, not both' USING ERRCODE = 'QM027'; END IF;
    IF v_user IS NOT NULL AND NOT app.is_active_member_user(r.organisation_id, v_user) THEN RAISE EXCEPTION 'An attendee chosen from the members must be an active member' USING ERRCODE = 'QM027'; END IF;
    IF length(v_name) > 120 THEN RAISE EXCEPTION 'A name is up to 120 characters' USING ERRCODE = 'QM027'; END IF;
    v_role := nullif(btrim(coalesce(a ->> 'role', '')), '');
    IF length(v_role) > 100 THEN RAISE EXCEPTION 'A role is up to 100 characters' USING ERRCODE = 'QM027'; END IF;
    v_att := coalesce(nullif(a ->> 'attendance', ''), 'invited');
    IF v_att NOT IN ('invited', 'present', 'apologies') THEN RAISE EXCEPTION 'Attendance is invited, present or apologies' USING ERRCODE = 'QM027'; END IF;
    IF v_att <> 'invited' AND r.status = 'planned' THEN RAISE EXCEPTION 'Who was present is recorded once the review has started' USING ERRCODE = 'QM027'; END IF;
    v_pos := v_pos + 1;
    BEGIN
      INSERT INTO public.management_review_attendees (organisation_id, review_id, user_id, name, role, attendance, position) VALUES (r.organisation_id, r.id, v_user, v_name, v_role, v_att, v_pos);
    EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'Someone is listed twice' USING ERRCODE = 'QM027';
    END;
  END LOOP;
END $$;

-- The minutes: a TipTap document (as documents), kept with its text.
CREATE FUNCTION app.set_management_review_minutes(p_review uuid, p_minutes jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.management_reviews%ROWTYPE;
BEGIN
  r := app.management_review_for_update(p_review);
  PERFORM app.assert_review_open(r, ARRAY['in_progress']);
  IF p_minutes IS NOT NULL AND (jsonb_typeof(p_minutes) IS DISTINCT FROM 'object' OR p_minutes ->> 'type' IS DISTINCT FROM 'doc') THEN
    RAISE EXCEPTION 'The minutes are a document' USING ERRCODE = 'QM027';
  END IF;
  IF pg_column_size(p_minutes) > 512000 THEN RAISE EXCEPTION 'The minutes are too long' USING ERRCODE = 'QM027'; END IF;
  UPDATE public.management_reviews SET minutes = p_minutes, minutes_text = CASE WHEN p_minutes IS NULL THEN NULL ELSE app.document_body_text(p_minutes) END WHERE id = r.id;
END $$;

-- Decisions: recorded while the review is held.
CREATE FUNCTION app.add_management_review_decision(p_review uuid, p_description text, p_category text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.management_reviews%ROWTYPE; v_id uuid;
BEGIN
  r := app.management_review_for_update(p_review);
  PERFORM app.assert_review_open(r, ARRAY['in_progress']);
  IF length(btrim(coalesce(p_description, ''))) NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'Say what was decided (up to 2000 characters)' USING ERRCODE = 'QM027'; END IF;
  IF coalesce(p_category, '') NOT IN ('improvement', 'resources', 'qms_change', 'other') THEN RAISE EXCEPTION 'A decision is about improvement, resources, a change to the QMS or other' USING ERRCODE = 'QM027'; END IF;
  INSERT INTO public.management_review_decisions (organisation_id, review_id, description, category) VALUES (r.organisation_id, r.id, btrim(p_description), p_category) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION app.update_management_review_decision(p_decision uuid, p_description text, p_category text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE d public.management_review_decisions%ROWTYPE; r public.management_reviews%ROWTYPE;
BEGIN
  SELECT * INTO d FROM public.management_review_decisions WHERE id = p_decision;
  IF NOT FOUND THEN RAISE EXCEPTION 'Decision not found' USING ERRCODE = 'P0002'; END IF;
  r := app.management_review_for_update(d.review_id);
  PERFORM app.assert_review_open(r, ARRAY['in_progress']);
  IF length(btrim(coalesce(p_description, ''))) NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'Say what was decided (up to 2000 characters)' USING ERRCODE = 'QM027'; END IF;
  IF coalesce(p_category, '') NOT IN ('improvement', 'resources', 'qms_change', 'other') THEN RAISE EXCEPTION 'A decision is about improvement, resources, a change to the QMS or other' USING ERRCODE = 'QM027'; END IF;
  UPDATE public.management_review_decisions SET description = btrim(p_description), category = p_category WHERE id = d.id;
END $$;

-- Taking a decision back (while the review is held), unless actions came from it.
CREATE FUNCTION app.remove_management_review_decision(p_decision uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE d public.management_review_decisions%ROWTYPE; r public.management_reviews%ROWTYPE;
BEGIN
  SELECT * INTO d FROM public.management_review_decisions WHERE id = p_decision;
  IF NOT FOUND THEN RAISE EXCEPTION 'Decision not found' USING ERRCODE = 'P0002'; END IF;
  r := app.management_review_for_update(d.review_id);
  PERFORM app.assert_review_open(r, ARRAY['in_progress']);
  IF EXISTS (SELECT 1 FROM public.management_review_actions WHERE decision_id = d.id) THEN RAISE EXCEPTION 'Actions came from this decision; it stays' USING ERRCODE = 'QM027'; END IF;
  DELETE FROM public.management_review_decisions WHERE id = d.id;
END $$;

-- Actions. Keys: description, ownerId (default the caller), dueDate, decisionId (one of this review's decisions).
CREATE FUNCTION app.add_management_review_action(p_review uuid, p_data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.management_reviews%ROWTYPE; k text; v_owner uuid; v_dec uuid; v_text text; v_id uuid;
BEGIN
  r := app.management_review_for_update(p_review);
  PERFORM app.assert_review_open(r, ARRAY['in_progress']);
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Send the action as an object' USING ERRCODE = 'QM027'; END IF;
  FOR k IN SELECT jsonb_object_keys(p_data) LOOP
    IF k NOT IN ('description', 'ownerId', 'dueDate', 'decisionId') THEN RAISE EXCEPTION 'Unknown field %', k USING ERRCODE = 'QM027'; END IF;
  END LOOP;
  v_text := btrim(coalesce(p_data ->> 'description', ''));
  IF length(v_text) NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'Say what is to be done (up to 2000 characters)' USING ERRCODE = 'QM027'; END IF;
  v_owner := coalesce(nullif(p_data ->> 'ownerId', '')::uuid, auth.uid());
  IF NOT app.is_active_member_user(r.organisation_id, v_owner) THEN RAISE EXCEPTION 'An action is given to an active member of this organisation' USING ERRCODE = 'QM027'; END IF;
  v_dec := nullif(p_data ->> 'decisionId', '')::uuid;
  IF v_dec IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.management_review_decisions WHERE id = v_dec AND review_id = r.id) THEN
    RAISE EXCEPTION 'That decision is not one of this review''s' USING ERRCODE = 'QM027';
  END IF;
  INSERT INTO public.management_review_actions (organisation_id, review_id, decision_id, description, owner_user_id, due_date)
  VALUES (r.organisation_id, r.id, v_dec, v_text, v_owner, nullif(p_data ->> 'dueDate', '')::date) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- An action that is still open: its owner and due date may change at any time; its words only while the review is held.
CREATE FUNCTION app.update_management_review_action(p_action uuid, p_data jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.management_review_actions%ROWTYPE; r public.management_reviews%ROWTYPE; k text; v_owner uuid; v_text text;
BEGIN
  SELECT * INTO a FROM public.management_review_actions WHERE id = p_action FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(a.organisation_id) THEN RAISE EXCEPTION 'Action not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_objective_manager(a.organisation_id);
  SELECT * INTO r FROM public.management_reviews WHERE id = a.review_id;
  IF r.status = 'cancelled' THEN RAISE EXCEPTION '% is cancelled', r.reference USING ERRCODE = 'QM027'; END IF;
  IF a.status <> 'open' THEN RAISE EXCEPTION 'The action is % and is reopened before it changes', a.status USING ERRCODE = 'QM027'; END IF;
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Send the changes as an object' USING ERRCODE = 'QM027'; END IF;
  FOR k IN SELECT jsonb_object_keys(p_data) LOOP
    IF k NOT IN ('description', 'ownerId', 'dueDate') THEN RAISE EXCEPTION 'Unknown field %', k USING ERRCODE = 'QM027'; END IF;
  END LOOP;
  IF p_data ? 'description' AND r.status <> 'in_progress' THEN RAISE EXCEPTION 'What an action is fixed once the review is completed' USING ERRCODE = 'QM027'; END IF;
  v_text := CASE WHEN p_data ? 'description' THEN btrim(coalesce(p_data ->> 'description', '')) ELSE a.description END;
  IF length(v_text) NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'Say what is to be done (up to 2000 characters)' USING ERRCODE = 'QM027'; END IF;
  v_owner := CASE WHEN p_data ? 'ownerId' THEN nullif(p_data ->> 'ownerId', '')::uuid ELSE a.owner_user_id END;
  IF v_owner IS DISTINCT FROM a.owner_user_id AND (v_owner IS NULL OR NOT app.is_active_member_user(a.organisation_id, v_owner)) THEN
    RAISE EXCEPTION 'An action is given to an active member of this organisation' USING ERRCODE = 'QM027';
  END IF;
  UPDATE public.management_review_actions SET description = v_text, owner_user_id = v_owner,
         due_date = CASE WHEN p_data ? 'dueDate' THEN nullif(p_data ->> 'dueDate', '')::date ELSE due_date END
   WHERE id = a.id;
END $$;

-- Closing an action with what was done: its owner or a manager.
CREATE FUNCTION app.complete_management_review_action(p_action uuid, p_note text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.management_review_actions%ROWTYPE;
BEGIN
  SELECT * INTO a FROM public.management_review_actions WHERE id = p_action FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(a.organisation_id) OR NOT (app.has_permission(a.organisation_id, 'management_review.read') OR a.owner_user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Action not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT (app.has_permission(a.organisation_id, 'management_review.manage') OR a.owner_user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Only the person the action was given to, or a manager, closes it' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.management_reviews WHERE id = a.review_id AND status = 'cancelled') THEN RAISE EXCEPTION 'Its review is cancelled' USING ERRCODE = 'QM027'; END IF;
  IF a.status <> 'open' THEN RAISE EXCEPTION 'The action is already %', a.status USING ERRCODE = 'QM027'; END IF;
  IF length(btrim(coalesce(p_note, ''))) NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'Say what was done' USING ERRCODE = 'QM027'; END IF;
  UPDATE public.management_review_actions SET status = 'done', done_note = btrim(p_note), done_at = now(), done_by = auth.uid() WHERE id = a.id;
END $$;

CREATE FUNCTION app.cancel_management_review_action(p_action uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.management_review_actions%ROWTYPE;
BEGIN
  SELECT * INTO a FROM public.management_review_actions WHERE id = p_action FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(a.organisation_id) THEN RAISE EXCEPTION 'Action not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_objective_manager(a.organisation_id);
  IF a.status <> 'open' THEN RAISE EXCEPTION 'The action is already %', a.status USING ERRCODE = 'QM027'; END IF;
  IF length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 3 AND 500 THEN RAISE EXCEPTION 'Say why it is cancelled (3 to 500 characters)' USING ERRCODE = 'QM027'; END IF;
  UPDATE public.management_review_actions SET status = 'cancelled', cancel_reason = btrim(p_reason), cancelled_at = now(), cancelled_by = auth.uid() WHERE id = a.id;
END $$;

CREATE FUNCTION app.reopen_management_review_action(p_action uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.management_review_actions%ROWTYPE;
BEGIN
  SELECT * INTO a FROM public.management_review_actions WHERE id = p_action FOR UPDATE;
  IF NOT FOUND OR NOT app.is_member(a.organisation_id) THEN RAISE EXCEPTION 'Action not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.assert_objective_manager(a.organisation_id);
  IF a.status = 'open' THEN RAISE EXCEPTION 'The action is open' USING ERRCODE = 'QM027'; END IF;
  IF EXISTS (SELECT 1 FROM public.management_reviews WHERE id = a.review_id AND status = 'cancelled') THEN RAISE EXCEPTION 'Its review is cancelled' USING ERRCODE = 'QM027'; END IF;
  UPDATE public.management_review_actions SET status = 'open', done_note = NULL, done_at = NULL, done_by = NULL, cancel_reason = NULL, cancelled_at = NULL, cancelled_by = NULL WHERE id = a.id;
END $$;

-- What is still needed before the review can be completed (empty = it can).
CREATE FUNCTION app.management_review_problems(p_review uuid) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.management_reviews%ROWTYPE; v text[] := ARRAY[]::text[]; v_left integer;
BEGIN
  SELECT * INTO r FROM public.management_reviews WHERE id = p_review;
  IF NOT FOUND OR NOT app.has_permission(r.organisation_id, 'management_review.read') THEN RAISE EXCEPTION 'Management review not found' USING ERRCODE = 'P0002'; END IF;
  IF r.status = 'planned' THEN RETURN ARRAY['Start the review']; END IF;
  IF r.status <> 'in_progress' THEN RETURN v; END IF;
  SELECT count(*) INTO v_left FROM public.management_review_inputs WHERE review_id = r.id AND NOT reviewed;
  IF v_left > 0 THEN v := v || (v_left || CASE WHEN v_left = 1 THEN ' input section is' ELSE ' input sections are' END || ' not reviewed yet'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.management_review_attendees WHERE review_id = r.id AND attendance = 'present') THEN v := v || 'Record who was present'::text; END IF;
  IF r.held_on IS NULL THEN v := v || 'Record the day it was held'::text; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.management_review_decisions WHERE review_id = r.id) THEN v := v || 'Record a decision, or say why none was needed'::text; END IF;
  RETURN v;
END $$;

-- Completing it: everything above is in place (a note can stand in for decisions); then it is frozen.
CREATE FUNCTION app.complete_management_review(p_review uuid, p_no_decision_note text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.management_reviews%ROWTYPE; v_problems text[]; v_note text := nullif(btrim(coalesce(p_no_decision_note, '')), '');
BEGIN
  r := app.management_review_for_update(p_review);
  PERFORM app.assert_review_open(r, ARRAY['in_progress']);
  v_problems := app.management_review_problems(r.id);
  IF v_note IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.management_review_decisions WHERE review_id = r.id) THEN RAISE EXCEPTION 'Decisions were recorded, so no note is needed' USING ERRCODE = 'QM027'; END IF;
    IF length(v_note) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'Say why no decision was needed (3 to 1000 characters)' USING ERRCODE = 'QM027'; END IF;
    v_problems := array_remove(v_problems, 'Record a decision, or say why none was needed');
  END IF;
  IF cardinality(v_problems) > 0 THEN RAISE EXCEPTION 'Not yet: %', array_to_string(v_problems, '; ') USING ERRCODE = 'QM027'; END IF;
  UPDATE public.management_reviews SET status = 'completed', no_decision_note = v_note, completed_at = now(), completed_by = auth.uid() WHERE id = r.id;
END $$;

CREATE FUNCTION app.cancel_management_review(p_review uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.management_reviews%ROWTYPE;
BEGIN
  r := app.management_review_for_update(p_review);
  PERFORM app.assert_review_open(r);
  IF length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 3 AND 500 THEN RAISE EXCEPTION 'Say why it is cancelled (3 to 500 characters)' USING ERRCODE = 'QM027'; END IF;
  -- Its open actions go with it (cancelled with the same reason) before the review is frozen.
  UPDATE public.management_review_actions SET status = 'cancelled', cancel_reason = left('Review cancelled: ' || btrim(p_reason), 500), cancelled_at = now(), cancelled_by = auth.uid()
   WHERE review_id = r.id AND status = 'open';
  UPDATE public.management_reviews SET status = 'cancelled', cancel_reason = btrim(p_reason), cancelled_at = now(), cancelled_by = auth.uid() WHERE id = r.id;
END $$;

REVOKE ALL ON FUNCTION app.management_review_sections(), app.management_review_rules(), app.management_review_child_rules(), app.management_review_action_rules(),
  app.management_review_for_update(uuid), app.assert_review_open(public.management_reviews, text[]), app.plan_management_review(uuid, jsonb),
  app.update_management_review(uuid, jsonb), app.start_management_review(uuid), app.set_management_review_snapshot(uuid, text, boolean, jsonb),
  app.set_management_review_input(uuid, text, boolean), app.set_management_review_attendees(uuid, jsonb), app.set_management_review_minutes(uuid, jsonb),
  app.add_management_review_decision(uuid, text, text), app.update_management_review_decision(uuid, text, text), app.remove_management_review_decision(uuid),
  app.add_management_review_action(uuid, jsonb), app.update_management_review_action(uuid, jsonb), app.complete_management_review_action(uuid, text),
  app.cancel_management_review_action(uuid, text), app.reopen_management_review_action(uuid), app.management_review_problems(uuid),
  app.complete_management_review(uuid, text), app.cancel_management_review(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.management_review_sections(), app.plan_management_review(uuid, jsonb), app.update_management_review(uuid, jsonb), app.start_management_review(uuid),
  app.set_management_review_snapshot(uuid, text, boolean, jsonb), app.set_management_review_input(uuid, text, boolean), app.set_management_review_attendees(uuid, jsonb),
  app.set_management_review_minutes(uuid, jsonb), app.add_management_review_decision(uuid, text, text), app.update_management_review_decision(uuid, text, text),
  app.remove_management_review_decision(uuid), app.add_management_review_action(uuid, jsonb), app.update_management_review_action(uuid, jsonb),
  app.complete_management_review_action(uuid, text), app.cancel_management_review_action(uuid, text), app.reopen_management_review_action(uuid),
  app.management_review_problems(uuid), app.complete_management_review(uuid, text), app.cancel_management_review(uuid, text) TO authenticated;
