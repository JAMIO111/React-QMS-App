-- Audits, slice AU2 (docs/audits-plan.md): the SCHEDULE. One slot per audit per period ("occurrence"), generated from the definition's frequency.
--
--  * No worker: app.generate_audit_occurrences(org, until) is run by the API whenever the schedule is opened. It is idempotent: it adds the slots that are missing, never rewrites a
--    slot in the past (so a missed audit stays visible as history), and removes only FUTURE slots that no longer fit a changed frequency. A new audit gets no slots before the day
--    it was defined, so it can never be "missed" before it existed.
--  * Slots follow the first due date on fixed calendar rhythm (monthly = same day each month, clamped to month end); "weekdays only" moves a weekend slot to the Monday.
--  * Done, overdue and missed are worked out when read (from the dates, the grace period and the audit records, AU3), not stored. Only a slot that someone SKIPPED (machine down, shutdown)
--    is stored as such, with a reason; a skipped slot does not count as missed.
--  * The table is read-only to everyone: slots are written by the generator, skipped and unskipped by functions (audits.manage). Errors QM018 → 409 audit_rule.

CREATE TABLE public.audit_occurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  audit_definition_id uuid NOT NULL,
  due_on date NOT NULL,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'skipped')),
  skipped_at timestamptz,
  skipped_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  skipped_reason text CHECK (skipped_reason IS NULL OR length(btrim(skipped_reason)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT audit_occurrences_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT audit_occurrences_definition_fkey FOREIGN KEY (audit_definition_id, organisation_id) REFERENCES public.audit_definitions (id, organisation_id),
  CONSTRAINT audit_occurrences_slot_key UNIQUE (audit_definition_id, due_on),
  CONSTRAINT audit_occurrences_skipped CHECK ((status = 'skipped') = (skipped_at IS NOT NULL) AND (skipped_at IS NULL OR skipped_reason IS NOT NULL))
);
CREATE INDEX audit_occurrences_due_idx ON public.audit_occurrences (organisation_id, due_on);

CREATE TRIGGER audit_occurrences_stamp BEFORE INSERT ON public.audit_occurrences FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER audit_occurrences_touch BEFORE UPDATE ON public.audit_occurrences FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.audit_occurrences FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');

ALTER TABLE public.audit_occurrences ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_occurrences_select ON public.audit_occurrences FOR SELECT TO authenticated USING (app.has_permission(organisation_id, 'audits.read'));
REVOKE ALL ON public.audit_occurrences FROM anon, authenticated;
GRANT SELECT ON public.audit_occurrences TO authenticated;

-- The k-th due date of a definition (before the weekday adjustment).
CREATE FUNCTION app.audit_due_date(p_kind text, p_interval integer, p_first date, p_k integer) RETURNS date
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE p_kind
    WHEN 'daily' THEN p_first + p_k
    WHEN 'weekly' THEN p_first + 7 * p_k
    WHEN 'every_n_days' THEN p_first + p_interval * p_k
    WHEN 'monthly' THEN (p_first + make_interval(months => p_k))::date
    WHEN 'quarterly' THEN (p_first + make_interval(months => 3 * p_k))::date
    WHEN 'six_monthly' THEN (p_first + make_interval(months => 6 * p_k))::date
    WHEN 'yearly' THEN (p_first + make_interval(months => 12 * p_k))::date
  END
$$;

-- Adds the missing slots up to p_until (never more than a year ahead) for every active audit of the organisation; returns how many it added.
CREATE FUNCTION app.generate_audit_occurrences(p_organisation_id uuid, p_until date) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  d public.audit_definitions%ROWTYPE;
  v_until date := least(p_until, current_date + 366);
  v_start date;
  v_step integer;
  v_k integer;
  v_raw date;
  v_due date;
  v_keep date[];
  v_added integer := 0;
  v_n integer;
BEGIN
  IF NOT app.has_permission(p_organisation_id, 'audits.read') THEN
    RAISE EXCEPTION 'Audits not found' USING ERRCODE = 'P0002';
  END IF;
  FOR d IN SELECT * FROM public.audit_definitions WHERE organisation_id = p_organisation_id AND status = 'active' AND frequency_kind <> 'on_demand' LOOP
    -- A slot is never created for a day before the audit was defined, nor more than 120 days back.
    v_start := greatest(d.first_due_on, d.created_at::date, current_date - 120);
    v_step := CASE d.frequency_kind WHEN 'daily' THEN 1 WHEN 'weekly' THEN 7 WHEN 'every_n_days' THEN d.frequency_interval
                                    WHEN 'monthly' THEN 31 WHEN 'quarterly' THEN 92 WHEN 'six_monthly' THEN 184 ELSE 366 END;
    v_k := greatest(0, (v_start - d.first_due_on) / v_step - 1);
    v_keep := ARRAY[]::date[];
    LOOP
      v_raw := app.audit_due_date(d.frequency_kind, d.frequency_interval, d.first_due_on, v_k);
      EXIT WHEN v_raw > v_until OR v_k > 5000;
      v_due := v_raw;
      IF d.weekdays_only THEN
        v_due := v_raw + CASE extract(dow FROM v_raw)::integer WHEN 6 THEN 2 WHEN 0 THEN 1 ELSE 0 END;
      END IF;
      IF v_due >= v_start AND v_due <= v_until THEN
        v_keep := array_append(v_keep, v_due);
        INSERT INTO public.audit_occurrences (organisation_id, audit_definition_id, due_on) VALUES (d.organisation_id, d.id, v_due) ON CONFLICT (audit_definition_id, due_on) DO NOTHING;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_added := v_added + v_n;
      END IF;
      v_k := v_k + 1;
    END LOOP;
    -- A changed frequency removes the future slots that no longer fit; the past is history and stays.
    DELETE FROM public.audit_occurrences o WHERE o.audit_definition_id = d.id AND o.due_on > current_date AND o.status = 'scheduled' AND NOT (o.due_on = ANY (v_keep));
  END LOOP;
  RETURN v_added;
END $$;

-- Skip a slot (machine down, shutdown) with a reason; skipped slots do not count as missed. Unskip puts it back.
CREATE FUNCTION app.skip_audit_occurrence(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o public.audit_occurrences%ROWTYPE;
BEGIN
  SELECT * INTO o FROM public.audit_occurrences WHERE id = p_id;
  IF NOT FOUND OR NOT app.has_permission(o.organisation_id, 'audits.read') THEN
    RAISE EXCEPTION 'Scheduled audit not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT app.has_permission(o.organisation_id, 'audits.manage') THEN
    RAISE EXCEPTION 'Skipping an audit needs the audits.manage permission' USING ERRCODE = '42501';
  END IF;
  IF o.status = 'skipped' THEN
    RAISE EXCEPTION 'This audit is already skipped' USING ERRCODE = 'QM018';
  END IF;
  IF length(btrim(coalesce(p_reason, ''))) = 0 THEN
    RAISE EXCEPTION 'Give a reason for skipping the audit' USING ERRCODE = 'QM018';
  END IF;
  UPDATE public.audit_occurrences SET status = 'skipped', skipped_at = now(), skipped_by = auth.uid(), skipped_reason = btrim(p_reason) WHERE id = p_id;
END $$;

CREATE FUNCTION app.unskip_audit_occurrence(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o public.audit_occurrences%ROWTYPE;
BEGIN
  SELECT * INTO o FROM public.audit_occurrences WHERE id = p_id;
  IF NOT FOUND OR NOT app.has_permission(o.organisation_id, 'audits.read') THEN
    RAISE EXCEPTION 'Scheduled audit not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT app.has_permission(o.organisation_id, 'audits.manage') THEN
    RAISE EXCEPTION 'Changing the schedule needs the audits.manage permission' USING ERRCODE = '42501';
  END IF;
  IF o.status <> 'skipped' THEN
    RAISE EXCEPTION 'This audit is not skipped' USING ERRCODE = 'QM018';
  END IF;
  UPDATE public.audit_occurrences SET status = 'scheduled', skipped_at = NULL, skipped_by = NULL, skipped_reason = NULL WHERE id = p_id;
END $$;

REVOKE ALL ON FUNCTION app.audit_due_date(text, integer, date, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.generate_audit_occurrences(uuid, date), app.skip_audit_occurrence(uuid, text), app.unskip_audit_occurrence(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.generate_audit_occurrences(uuid, date), app.skip_audit_occurrence(uuid, text), app.unskip_audit_occurrence(uuid) TO authenticated;
