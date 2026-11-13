-- Scheduled supplier scorecards (docs/supplier-quality-plan.md, SQ5b). A scorecard has been saved only when someone remembered to; now the worker can save
-- one for every supplier in use at the end of each month, quarter and year, so the trend has no gaps.
--
--  * public.supplier_scorecard_schedules: one row per organisation. Monthly, quarterly and annual are switched on and off SEPARATELY (any, all or none).
--    Scope: every supplier in use (active, not archived or disqualified), or only those holding one of the chosen classifications.
--    Written only by app.set_supplier_scorecard_schedule (supplier_quality.configure). The person who last changed it lends their authority: the figures
--    are worked out as them (they must still be able to see supplier performance, i.e. supplier_quality.read and receiving.read), and when they no longer
--    can, nothing is saved and the schedule says why.
--  * public.supplier_scorecards gains period_kind (monthly | quarterly | annual; null = saved by a person). A scheduled scorecard is unique per supplier,
--    kind and period, so a retried or late tick never saves twice, and it is saved by nobody (created_by is null): "saved by the schedule".
--    A period is saved once it has ended (in the organisation's own day). Switching a kind on starts with the period that last ended; the worker catches
--    up on any it missed while it was down, but not on periods while the kind was switched off.
--  * public.supplier_band_drops: written when a supplier's scheduled band falls from one period to the next of the same kind (good → watch, good → poor,
--    watch → poor; "insufficient data" never counts) → notice "A supplier's score fell" (supplier_quality.read; on by default for supplier_quality.manage,
--    emailed by default). Frozen, never deleted.
--  * app.system_run_scheduled_scorecards(limit): the worker's step (API login only).
-- Nothing here changes a supplier's approval status, risk rating or SCARs: scorecards are information only.

-- ---------------------------------------------------------------------------
-- Periods
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.scorecard_period_unit(p_kind text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE p_kind WHEN 'monthly' THEN 'month' WHEN 'quarterly' THEN 'quarter' WHEN 'annual' THEN 'year' END
$$;

-- The last day of the period of this kind that starts on p_start.
CREATE FUNCTION app.scorecard_period_end(p_kind text, p_start date) RETURNS date
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT (p_start + CASE p_kind WHEN 'monthly' THEN interval '1 month' WHEN 'quarterly' THEN interval '3 months' ELSE interval '1 year' END - interval '1 day')::date
$$;

-- The first day of the latest period of this kind that has ended before p_today.
CREATE FUNCTION app.scorecard_last_finished(p_kind text, p_today date) RETURNS date
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT (date_trunc(app.scorecard_period_unit(p_kind), p_today::timestamp)
          - CASE p_kind WHEN 'monthly' THEN interval '1 month' WHEN 'quarterly' THEN interval '3 months' ELSE interval '1 year' END)::date
$$;

-- ---------------------------------------------------------------------------
-- Scorecards: saved by the schedule
-- ---------------------------------------------------------------------------
ALTER TABLE public.supplier_scorecards ADD COLUMN period_kind text CHECK (period_kind IS NULL OR period_kind IN ('monthly', 'quarterly', 'annual'));
CREATE UNIQUE INDEX supplier_scorecards_scheduled_once ON public.supplier_scorecards (supplier_id, period_kind, period_from) WHERE period_kind IS NOT NULL;

-- ---------------------------------------------------------------------------
-- The schedule
-- ---------------------------------------------------------------------------
CREATE TABLE public.supplier_scorecard_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL UNIQUE REFERENCES public.organisations (id) ON DELETE CASCADE,
  monthly boolean NOT NULL DEFAULT false,
  quarterly boolean NOT NULL DEFAULT false,
  annual boolean NOT NULL DEFAULT false,
  -- The first day of the next period of each kind still to save (set when the kind is switched on, moved on by the worker).
  monthly_next date,
  quarterly_next date,
  annual_next date,
  scope text NOT NULL DEFAULT 'all' CHECK (scope IN ('all', 'classifications')),
  classification_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(classification_ids) <= 50),
  set_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  problem text CHECK (problem IS NULL OR length(problem) BETWEEN 1 AND 500),
  problem_at timestamptz,
  last_saved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_scorecard_schedules_scope CHECK (scope = 'all' OR cardinality(classification_ids) >= 1)
);
ALTER TABLE public.supplier_scorecard_schedules ENABLE ROW LEVEL SECURITY;
CREATE POLICY supplier_scorecard_schedules_select ON public.supplier_scorecard_schedules FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'supplier_quality.read'));
REVOKE ALL ON public.supplier_scorecard_schedules FROM anon, authenticated;
GRANT SELECT ON public.supplier_scorecard_schedules TO authenticated;
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.supplier_scorecard_schedules FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');

-- Sets the schedule (supplier_quality.configure). Keys present are set: monthly, quarterly, annual (true/false), scope ('all' | 'classifications'),
-- classificationIds (the organisation's own, switched on when added). The caller lends their authority to the schedule, so they must be able to see
-- supplier performance themselves. Switching a kind on starts with the period that last ended, in the organisation's own day.
CREATE FUNCTION app.set_supplier_scorecard_schedule(p_organisation uuid, p jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  cur public.supplier_scorecard_schedules%ROWTYPE; v_today date; k text; v_on boolean; v_was boolean; v_next date;
  v_scope text; v_ids uuid[]; v_old_ids uuid[]; v_bad integer;
BEGIN
  IF NOT app.is_member(p_organisation) THEN RAISE EXCEPTION 'Organisation not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(p_organisation, 'supplier_quality.configure') THEN
    RAISE EXCEPTION 'You are not allowed to change the scorecard schedule' USING ERRCODE = '42501';
  END IF;
  IF NOT (app.has_permission(p_organisation, 'supplier_quality.read') AND app.has_permission(p_organisation, 'receiving.read')) THEN
    RAISE EXCEPTION 'The schedule saves scorecards with your authority, so you must be able to see supplier performance (supplier quality and receiving)' USING ERRCODE = 'QM020';
  END IF;
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN RAISE EXCEPTION 'Nothing to change' USING ERRCODE = 'QM020'; END IF;

  INSERT INTO public.supplier_scorecard_schedules (organisation_id) VALUES (p_organisation) ON CONFLICT (organisation_id) DO NOTHING;
  SELECT * INTO cur FROM public.supplier_scorecard_schedules WHERE organisation_id = p_organisation FOR UPDATE;
  v_today := (now() AT TIME ZONE app.organisation_time_zone(p_organisation))::date;

  FOREACH k IN ARRAY ARRAY['monthly', 'quarterly', 'annual'] LOOP
    CONTINUE WHEN NOT p ? k;
    IF jsonb_typeof(p -> k) <> 'boolean' THEN RAISE EXCEPTION '% must be true or false', k USING ERRCODE = 'QM020'; END IF;
    v_on := (p ->> k)::boolean;
    v_was := CASE k WHEN 'monthly' THEN cur.monthly WHEN 'quarterly' THEN cur.quarterly ELSE cur.annual END;
    v_next := CASE k WHEN 'monthly' THEN cur.monthly_next WHEN 'quarterly' THEN cur.quarterly_next ELSE cur.annual_next END;
    IF v_on AND NOT v_was THEN
      -- From the period that last ended; a later "next" means that period was already saved before it was switched off.
      v_next := CASE WHEN v_next IS NOT NULL AND v_next > app.scorecard_last_finished(k, v_today) THEN v_next ELSE app.scorecard_last_finished(k, v_today) END;
    END IF;
    IF k = 'monthly' THEN cur.monthly := v_on; cur.monthly_next := v_next;
    ELSIF k = 'quarterly' THEN cur.quarterly := v_on; cur.quarterly_next := v_next;
    ELSE cur.annual := v_on; cur.annual_next := v_next; END IF;
  END LOOP;

  v_scope := coalesce(p ->> 'scope', cur.scope);
  IF v_scope NOT IN ('all', 'classifications') THEN RAISE EXCEPTION 'Choose every supplier or chosen classifications' USING ERRCODE = 'QM020'; END IF;
  v_old_ids := cur.classification_ids;
  IF p ? 'classificationIds' THEN
    IF jsonb_typeof(p -> 'classificationIds') <> 'array' THEN RAISE EXCEPTION 'classificationIds must be a list' USING ERRCODE = 'QM020'; END IF;
    SELECT coalesce(array_agg(DISTINCT x::uuid), '{}') INTO v_ids FROM jsonb_array_elements_text(p -> 'classificationIds') x;
    -- Each must be this organisation's; one newly added must be switched on (one switched off later may be kept).
    SELECT count(*) INTO v_bad FROM unnest(v_ids) i
     WHERE NOT EXISTS (SELECT 1 FROM public.supplier_classifications c WHERE c.id = i AND c.organisation_id = p_organisation
                         AND (c.active OR i = ANY (v_old_ids)));
    IF v_bad > 0 THEN RAISE EXCEPTION 'Choose classifications of this organisation that are switched on' USING ERRCODE = 'QM020'; END IF;
  ELSE
    v_ids := v_old_ids;
  END IF;
  IF v_scope = 'classifications' AND cardinality(v_ids) = 0 THEN RAISE EXCEPTION 'Choose at least one classification' USING ERRCODE = 'QM020'; END IF;
  IF cardinality(v_ids) > 50 THEN RAISE EXCEPTION 'Choose at most 50 classifications' USING ERRCODE = 'QM020'; END IF;

  UPDATE public.supplier_scorecard_schedules
     SET monthly = cur.monthly, quarterly = cur.quarterly, annual = cur.annual,
         monthly_next = cur.monthly_next, quarterly_next = cur.quarterly_next, annual_next = cur.annual_next,
         scope = v_scope, classification_ids = v_ids, set_by = auth.uid(), problem = NULL, problem_at = NULL, updated_at = now()
   WHERE id = cur.id;
END $$;

-- ---------------------------------------------------------------------------
-- A supplier's band fell
-- ---------------------------------------------------------------------------
CREATE TABLE public.supplier_band_drops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  supplier_id uuid NOT NULL,
  scorecard_id uuid NOT NULL,
  previous_scorecard_id uuid NOT NULL,
  period_kind text NOT NULL CHECK (period_kind IN ('monthly', 'quarterly', 'annual')),
  period_from date NOT NULL,
  period_to date NOT NULL,
  from_band text NOT NULL CHECK (from_band IN ('good', 'watch')),
  to_band text NOT NULL CHECK (to_band IN ('watch', 'poor')),
  supplier_label text NOT NULL CHECK (length(supplier_label) BETWEEN 1 AND 300),
  change_label text NOT NULL CHECK (length(change_label) BETWEEN 1 AND 300),
  -- For the notice's link (the notice carries record_kind / record_id in its details).
  record_kind text GENERATED ALWAYS AS ('supplier') STORED,
  record_id uuid GENERATED ALWAYS AS (supplier_id) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_band_drops_once UNIQUE (scorecard_id),
  CONSTRAINT supplier_band_drops_fall CHECK (from_band = 'good' OR to_band = 'poor'),
  CONSTRAINT supplier_band_drops_supplier_fkey FOREIGN KEY (supplier_id, organisation_id) REFERENCES public.suppliers (id, organisation_id),
  CONSTRAINT supplier_band_drops_scorecard_fkey FOREIGN KEY (scorecard_id, organisation_id) REFERENCES public.supplier_scorecards (id, organisation_id),
  CONSTRAINT supplier_band_drops_previous_fkey FOREIGN KEY (previous_scorecard_id, organisation_id) REFERENCES public.supplier_scorecards (id, organisation_id)
);
CREATE INDEX supplier_band_drops_supplier_idx ON public.supplier_band_drops (supplier_id, created_at DESC);
ALTER TABLE public.supplier_band_drops ENABLE ROW LEVEL SECURITY;
CREATE POLICY supplier_band_drops_select ON public.supplier_band_drops FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'supplier_quality.read'));
REVOKE ALL ON public.supplier_band_drops FROM anon, authenticated;
GRANT SELECT ON public.supplier_band_drops TO authenticated;
CREATE TRIGGER supplier_band_drops_frozen BEFORE UPDATE OR DELETE ON public.supplier_band_drops FOR EACH ROW EXECUTE FUNCTION app.scorecard_frozen();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.supplier_band_drops FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');

INSERT INTO public.notification_event_types
  (key, entity_type, action, group_name, entity_label, description, permission_code, default_on, default_permission_code, label_fields, display_order, own_record, email_default)
VALUES
  ('supplier_band_drops.created', 'supplier_band_drops', 'created', 'Supplier quality', 'Supplier score fell', 'A supplier''s score fell',
   'supplier_quality.read', true, 'supplier_quality.manage', ARRAY['supplier_label', 'change_label'], 90, false, true);

-- ---------------------------------------------------------------------------
-- The worker's step
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.scorecard_band_rank(p_band text) RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE p_band WHEN 'good' THEN 3 WHEN 'watch' THEN 2 WHEN 'poor' THEN 1 END
$$;

-- For every organisation with a kind switched on: each period of that kind that has ended and is not yet done gets a scorecard for every supplier in
-- scope that has none for it, worked out as the person who set the schedule; then the period is done and the next one waits until it ends. At most
-- p_limit scorecards per call (the rest at the next tick). A band that fell since the previous scheduled scorecard of the same kind is announced.
CREATE FUNCTION app.system_run_scheduled_scorecards(p_limit integer DEFAULT 100) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  sch public.supplier_scorecard_schedules%ROWTYPE; sup record; prev record; k text;
  v_claims text := coalesce(current_setting('request.jwt.claims', true), '');
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 1000);
  v_today date; v_next date; v_end date; v_r jsonb; v_id uuid; v_ok boolean; v_left boolean; v_problem text; v_stop boolean;
  v_saved integer := 0; v_drops integer := 0; v_orgs integer := 0; v_org_saved integer;
  v_words text;
BEGIN
  FOR sch IN
    SELECT s.* FROM public.supplier_scorecard_schedules s JOIN public.organisations o ON o.id = s.organisation_id AND o.status = 'active'
     WHERE s.monthly OR s.quarterly OR s.annual ORDER BY s.last_saved_at NULLS FIRST, s.id
  LOOP
    EXIT WHEN v_saved >= v_limit;
    v_today := (now() AT TIME ZONE app.organisation_time_zone(sch.organisation_id))::date;
    v_problem := NULL; v_stop := false; v_org_saved := 0;

    FOREACH k IN ARRAY ARRAY['monthly', 'quarterly', 'annual'] LOOP
      EXIT WHEN v_stop;
      CONTINUE WHEN NOT CASE k WHEN 'monthly' THEN sch.monthly WHEN 'quarterly' THEN sch.quarterly ELSE sch.annual END;
      v_next := CASE k WHEN 'monthly' THEN sch.monthly_next WHEN 'quarterly' THEN sch.quarterly_next ELSE sch.annual_next END;
      v_next := coalesce(v_next, app.scorecard_last_finished(k, v_today));
      LOOP
        v_end := app.scorecard_period_end(k, v_next);
        EXIT WHEN v_end >= v_today;   -- not over yet in the organisation's day

        -- The authority lent to the schedule: still a member who may see supplier performance.
        v_ok := false;
        IF sch.set_by IS NOT NULL THEN
          PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', sch.set_by, 'role', 'authenticated', 'aal', 'aal2')::text, true);
          v_ok := app.is_member(sch.organisation_id) AND app.has_permission(sch.organisation_id, 'supplier_quality.read')
                  AND app.has_permission(sch.organisation_id, 'receiving.read');
          PERFORM set_config('request.jwt.claims', v_claims, true);
        END IF;
        IF NOT v_ok THEN
          v_problem := 'Nothing was saved: the person who set the schedule can no longer see supplier performance. Someone who can should save the schedule again.';
          v_stop := true;
          EXIT;
        END IF;

        v_left := false;
        FOR sup IN
          SELECT s.id, s.code, s.name FROM public.suppliers s
           WHERE s.organisation_id = sch.organisation_id AND s.active AND s.approval_status NOT IN ('archived', 'disqualified')
             AND (sch.scope = 'all' OR EXISTS (SELECT 1 FROM public.supplier_classification_links l
                                                WHERE l.supplier_id = s.id AND l.classification_id = ANY (sch.classification_ids)))
             AND NOT EXISTS (SELECT 1 FROM public.supplier_scorecards c WHERE c.supplier_id = s.id AND c.period_kind = k AND c.period_from = v_next)
           ORDER BY s.code, s.id
        LOOP
          IF v_saved >= v_limit THEN v_left := true; EXIT; END IF;
          BEGIN
            PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', sch.set_by, 'role', 'authenticated', 'aal', 'aal2')::text, true);
            v_r := app.supplier_performance(sup.id, v_next, v_end);
            PERFORM set_config('request.jwt.claims', v_claims, true);
          EXCEPTION WHEN OTHERS THEN
            PERFORM set_config('request.jwt.claims', v_claims, true);
            v_problem := left('Could not score ' || sup.code || ': ' || SQLERRM, 500);
            v_stop := true;
            EXIT;
          END;
          -- Written as the system: saved by nobody, i.e. by the schedule.
          INSERT INTO public.supplier_scorecards (organisation_id, supplier_id, period_from, period_to, period_kind, model_id, model_version, config, metrics, components, score, band, warnings)
          VALUES (sch.organisation_id, sup.id, v_next, v_end, k, (v_r -> 'model' ->> 'id')::uuid, (v_r -> 'model' ->> 'version')::int, v_r -> 'model' -> 'config',
                  v_r -> 'metrics', v_r -> 'components', (v_r ->> 'score')::numeric, v_r ->> 'band', v_r -> 'warnings')
          ON CONFLICT DO NOTHING
          RETURNING id INTO v_id;
          CONTINUE WHEN v_id IS NULL;
          v_saved := v_saved + 1; v_org_saved := v_org_saved + 1;

          SELECT c.id, c.band INTO prev FROM public.supplier_scorecards c
           WHERE c.supplier_id = sup.id AND c.period_kind = k AND c.period_from < v_next ORDER BY c.period_from DESC LIMIT 1;
          IF prev.id IS NOT NULL AND app.scorecard_band_rank(prev.band) IS NOT NULL AND app.scorecard_band_rank(v_r ->> 'band') IS NOT NULL
             AND app.scorecard_band_rank(v_r ->> 'band') < app.scorecard_band_rank(prev.band) THEN
            v_words := CASE k WHEN 'monthly' THEN to_char(v_next, 'FMMonth YYYY')
                              WHEN 'quarterly' THEN 'Q' || extract(quarter FROM v_next) || ' ' || extract(year FROM v_next)
                              ELSE extract(year FROM v_next)::text END;
            INSERT INTO public.supplier_band_drops (organisation_id, supplier_id, scorecard_id, previous_scorecard_id, period_kind, period_from, period_to,
                                                    from_band, to_band, supplier_label, change_label)
            VALUES (sch.organisation_id, sup.id, v_id, prev.id, k, v_next, v_end, prev.band, v_r ->> 'band', left(sup.code || ' · ' || sup.name, 300),
                    left(initcap(prev.band) || ' → ' || initcap(v_r ->> 'band') || ' (' || v_words || ')', 300))
            ON CONFLICT DO NOTHING;
            IF FOUND THEN v_drops := v_drops + 1; END IF;
          END IF;
        END LOOP;
        EXIT WHEN v_stop OR v_left;
        -- Every supplier in scope has this period: on to the next.
        v_next := (v_next + CASE k WHEN 'monthly' THEN interval '1 month' WHEN 'quarterly' THEN interval '3 months' ELSE interval '1 year' END)::date;
        IF k = 'monthly' THEN UPDATE public.supplier_scorecard_schedules SET monthly_next = v_next WHERE id = sch.id;
        ELSIF k = 'quarterly' THEN UPDATE public.supplier_scorecard_schedules SET quarterly_next = v_next WHERE id = sch.id;
        ELSE UPDATE public.supplier_scorecard_schedules SET annual_next = v_next WHERE id = sch.id; END IF;
      END LOOP;
      EXIT WHEN v_saved >= v_limit;
    END LOOP;

    v_orgs := v_orgs + 1;
    UPDATE public.supplier_scorecard_schedules
       SET problem = v_problem, problem_at = CASE WHEN v_problem IS NULL THEN NULL ELSE coalesce(problem_at, now()) END,
           last_saved_at = CASE WHEN v_org_saved > 0 THEN now() ELSE last_saved_at END
     WHERE id = sch.id AND (problem IS DISTINCT FROM v_problem OR v_org_saved > 0);
  END LOOP;
  PERFORM set_config('request.jwt.claims', v_claims, true);
  RETURN jsonb_build_object('organisations', v_orgs, 'saved', v_saved, 'bandDrops', v_drops);
END $$;

REVOKE ALL ON FUNCTION app.scorecard_period_unit(text), app.scorecard_period_end(text, date), app.scorecard_last_finished(text, date), app.scorecard_band_rank(text),
  app.set_supplier_scorecard_schedule(uuid, jsonb), app.system_run_scheduled_scorecards(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.scorecard_period_unit(text), app.scorecard_period_end(text, date), app.scorecard_last_finished(text, date), app.scorecard_band_rank(text),
  app.set_supplier_scorecard_schedule(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION app.system_run_scheduled_scorecards(integer) TO qms_api;
