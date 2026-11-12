-- Reminders (docs/workflow-engine-plan.md, WK2; decisions W4, W10). Everything built so far works out "overdue" and "due soon" when a page is opened;
-- nothing chased anyone. Now, once a day at the organisation's reminder time, the worker tells each person what of theirs is overdue or due soon:
--
--  * organisation_settings.reminder_time (default 07:00) and time_zone (default: the first active site's, else Europe/London): the organisation's day.
--    "Today", "due soon" and "overdue" are worked out in that zone.
--  * app.reminder_candidates(org, today): one row per thing someone must do, by area (who, what, when it is due, where to go, which permission and site
--    they need to read it). The areas: 8D actions, risk actions, risk reviews, management review actions, NC containment actions, audits due (expected
--    auditor named in person), gauges due for calibration (custodian), documents to read, quality alerts to acknowledge, periodic document reviews (owner),
--    SCAR responses (internal owner), and the person's own competence expiring. Supplier certificates have no person to tell (the expiry watchlist shows them).
--  * public.reminder_digests: one per person per day (the items, counts and a one-line summary) → notice "Your reminders" (own_record, addressed to the
--    person, emailed by default). Nothing is written when there is nothing to say.
--  * public.reminder_overdue_notices: one per person, record and due date, when something first goes overdue (due in the last three days, so a backlog
--    from before this existed is never sent one by one) → notice "<something> is overdue" (own_record, emailed by default).
--  * public.reminder_preferences: a person may switch an area off (in the app and by email); everything else follows the notification preferences.
--  * app.system_run_reminders(): the worker's step (API login only). Each organisation runs once a day, at or after its reminder time, recorded in
--    app.reminder_runs, so nothing is sent twice. Every item is checked as that person: an active member who may read the record (permission and site) and
--    has not switched its area off.
--  * app.my_reminders(org): the caller's own items now (the Reminders page).

-- ---------------------------------------------------------------------------
-- The organisation's day
-- ---------------------------------------------------------------------------
ALTER TABLE public.organisation_settings
  ADD COLUMN reminder_time time NOT NULL DEFAULT '07:00',
  ADD COLUMN time_zone text CHECK (time_zone IS NULL OR length(time_zone) BETWEEN 1 AND 64);
GRANT UPDATE (reminder_time, time_zone) ON public.organisation_settings TO authenticated;

CREATE FUNCTION app.organisation_settings_time_zone_rule() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.time_zone IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = NEW.time_zone) THEN
    RAISE EXCEPTION 'Unknown time zone %', NEW.time_zone USING ERRCODE = '22023';
  END IF;
  IF NEW.reminder_time IS DISTINCT FROM OLD.reminder_time AND (extract(second FROM NEW.reminder_time) <> 0 OR extract(minute FROM NEW.reminder_time)::int % 5 <> 0) THEN
    RAISE EXCEPTION 'The reminder time is on the hour or a multiple of five minutes past it' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER organisation_settings_time_zone_rule BEFORE INSERT OR UPDATE OF time_zone, reminder_time ON public.organisation_settings
  FOR EACH ROW EXECUTE FUNCTION app.organisation_settings_time_zone_rule();

-- The zone the organisation's day is kept in: its own setting, else its first active site's (when that is a known zone), else Europe/London.
CREATE FUNCTION app.organisation_time_zone(p_organisation_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(
    (SELECT s.time_zone FROM public.organisation_settings s WHERE s.organisation_id = p_organisation_id),
    (SELECT si.timezone FROM public.sites si
      WHERE si.organisation_id = p_organisation_id AND si.active AND si.timezone IN (SELECT name FROM pg_catalog.pg_timezone_names)
      ORDER BY si.created_at, si.id LIMIT 1),
    'Europe/London')
$$;

-- ---------------------------------------------------------------------------
-- Areas and a person's choices
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.reminder_areas() RETURNS TABLE (key text, ord integer, label text, description text, soon_days integer)
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  VALUES
    ('capa_actions',     1, '8D actions',                  '8D actions assigned to you',                                  7),
    ('risk_actions',     2, 'Risk actions',                'Risk actions given to you',                                   7),
    ('risk_reviews',     3, 'Risk reviews',                'Risks you own that are due for review',                       7),
    ('review_actions',   4, 'Management review actions',   'Actions from management reviews given to you',                7),
    ('ncr_containment',  5, 'NC containment actions',      'Containment actions on non-conformances you are responsible for', 3),
    ('audits',           6, 'Audits',                      'Audits you are the expected auditor of',                      7),
    ('gauges',           7, 'Gauge calibration',           'Gauges in your custody due for calibration',                 14),
    ('documents_to_read',8, 'Documents to read',           'Documents you are asked to read and acknowledge',             7),
    ('quality_alerts',   9, 'Quality alerts',              'Quality alerts you are asked to acknowledge',                 3),
    ('document_reviews',10, 'Document reviews',            'Documents you own that are due for their periodic review',  30),
    ('scars',           11, 'Supplier corrective actions', 'SCARs you own that are waiting on the supplier''s response',   3),
    ('competence',      12, 'Your competence',             'Your own assessments that are expiring',                     30)
$$;

CREATE TABLE public.reminder_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  area text NOT NULL CHECK (area ~ '^[a-z_]{2,40}$'),
  enabled boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, user_id, area)
);
ALTER TABLE public.reminder_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY reminder_preferences_select ON public.reminder_preferences FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) AND app.is_member(organisation_id));
REVOKE ALL ON public.reminder_preferences FROM anon, authenticated;
GRANT SELECT ON public.reminder_preferences TO authenticated;

-- The caller's areas: each with whether it is on (default on).
CREATE FUNCTION app.my_reminder_areas(p_organisation_id uuid)
RETURNS TABLE (key text, label text, description text, soon_days integer, enabled boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT a.key, a.label, a.description, a.soon_days, coalesce(p.enabled, true)
    FROM app.reminder_areas() a
    LEFT JOIN public.reminder_preferences p ON p.organisation_id = p_organisation_id AND p.user_id = (SELECT auth.uid()) AND p.area = a.key
   WHERE app.is_member(p_organisation_id)
   ORDER BY a.ord
$$;

CREATE FUNCTION app.set_reminder_area(p_organisation_id uuid, p_area text, p_enabled boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT app.is_member(p_organisation_id) THEN RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM app.reminder_areas() a WHERE a.key = p_area) THEN RAISE EXCEPTION 'Unknown reminder area' USING ERRCODE = 'QM010'; END IF;
  IF p_enabled IS NULL THEN RAISE EXCEPTION 'Say whether the area is on or off' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.reminder_preferences (organisation_id, user_id, area, enabled) VALUES (p_organisation_id, auth.uid(), p_area, p_enabled)
  ON CONFLICT (organisation_id, user_id, area) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now();
END $$;

-- ---------------------------------------------------------------------------
-- What each person must do
-- ---------------------------------------------------------------------------
-- One row per thing someone must do that is overdue or due within its area's window, as at p_today (the organisation's day). target_id is the record a
-- link opens; permission and site are what the person needs to read it (null = their own record). Not filtered by person: the caller checks each row
-- as that person.
CREATE FUNCTION app.reminder_candidates(p_organisation_id uuid, p_today date)
RETURNS TABLE (user_id uuid, area text, record_id uuid, target_id uuid, label text, due_on date, permission text, site_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH w AS (SELECT a.key, a.soon_days FROM app.reminder_areas() a),
  rows AS (
    -- 8D actions: the team member's sign-in; the 8D still running.
    SELECT m.user_id, 'capa_actions'::text AS area, a.id AS record_id, c.id AS target_id,
           c.reference || ' · ' || left(a.description, 120) AS label, a.due_date AS due_on, 'capa.read'::text AS permission, NULL::uuid AS site_id
      FROM public.capa_actions a
      JOIN public.capas c ON c.id = a.capa_id AND c.stage NOT IN ('closed', 'cancelled')
      JOIN public.capa_team_members t ON t.id = a.owner_team_member_id AND t.ended_at IS NULL
      JOIN public.organisation_users m ON m.id = t.membership_id
     WHERE a.organisation_id = p_organisation_id AND a.status = 'open' AND a.due_date IS NOT NULL
    UNION ALL
    SELECT a.owner_user_id, 'risk_actions', a.id, r.id, r.reference || ' · ' || left(a.description, 120), a.due_date, 'risk.read', NULL
      FROM public.risk_actions a JOIN public.risks r ON r.id = a.risk_id AND r.status NOT IN ('closed', 'retired')
     WHERE a.organisation_id = p_organisation_id AND a.status = 'open' AND a.due_date IS NOT NULL
    UNION ALL
    SELECT r.owner_user_id, 'risk_reviews', r.id, r.id, r.reference || ' · ' || left(r.title, 120) || ' (review)', r.next_review_on, 'risk.read', NULL
      FROM public.risks r
     WHERE r.organisation_id = p_organisation_id AND r.status NOT IN ('closed', 'retired', 'draft') AND r.next_review_on IS NOT NULL
    UNION ALL
    -- Management review actions: the person's own (they may hold no management review permission).
    SELECT a.owner_user_id, 'review_actions', a.id, mr.id, mr.reference || ' · ' || left(a.description, 120), a.due_date, NULL, NULL
      FROM public.management_review_actions a JOIN public.management_reviews mr ON mr.id = a.review_id
     WHERE a.organisation_id = p_organisation_id AND a.status = 'open' AND a.due_date IS NOT NULL
    UNION ALL
    -- NC containment: the owner employee's linked sign-in; the NC still open.
    SELECT e.auth_id, 'ncr_containment', a.id, n.id, n.reference || ' · ' || left(a.description, 120), a.due_date, 'ncr.read', n.site_id
      FROM public.ncr_containment_actions a
      JOIN public.nonconformances n ON n.id = a.nonconformance_id AND n.deleted_at IS NULL AND n.stage NOT IN ('closed', 'cancelled')
      JOIN public."Employees" e ON e.id = a.owner_employee_id AND e.organisation_id = a.organisation_id AND e.auth_id IS NOT NULL
     WHERE a.organisation_id = p_organisation_id AND a.status = 'open' AND a.due_date IS NOT NULL
    UNION ALL
    -- Audits: scheduled slots of active audits whose expected auditor is a named person, with no completed record (an in-progress one still counts as to do).
    SELECT d.auditor_user_id, 'audits', o.id, d.id, d.reference || ' · ' || left(d.title, 120), o.due_on, 'audits.read', NULL
      FROM public.audit_occurrences o
      JOIN public.audit_definitions d ON d.id = o.audit_definition_id AND d.status = 'active' AND d.auditor_kind = 'person'
     WHERE o.organisation_id = p_organisation_id AND o.status = 'scheduled'
       AND NOT EXISTS (SELECT 1 FROM public.audit_records r WHERE r.occurrence_id = o.id AND r.status = 'completed')
    UNION ALL
    SELECT g.custodian_id, 'gauges', g.id, g.id, g.asset_number || ' · ' || left(g.description, 120), g.next_due_on, 'calibration.read', g.site_id
      FROM public.gauges g
     WHERE g.organisation_id = p_organisation_id AND g.deleted_at IS NULL AND g.status IN ('active', 'in_calibration') AND g.custodian_id IS NOT NULL AND g.next_due_on IS NOT NULL
    UNION ALL
    -- Documents to read: the revision in force, not yet acknowledged.
    SELECT x.user_id, 'documents_to_read', x.id, dd.id, dd.number || ' rev ' || coalesce(r.letter, '?') || ' · ' || left(dd.title, 120), x.due_on, NULL, NULL
      FROM public.document_recipients x
      JOIN public.document_revisions r ON r.id = x.revision_id AND r.status = 'effective'
      JOIN public.documents dd ON dd.id = r.document_id AND dd.status = 'active'
     WHERE x.organisation_id = p_organisation_id AND x.acknowledged_at IS NULL AND x.due_on IS NOT NULL
    UNION ALL
    SELECT x.user_id, 'quality_alerts', x.id, q.id, q.reference || ' · ' || left(q.title, 120), q.acknowledge_by, NULL, NULL
      FROM public.quality_alert_recipients x
      JOIN public.quality_alerts q ON q.id = x.alert_id AND q.status = 'active' AND q.acknowledge_by IS NOT NULL
     WHERE x.organisation_id = p_organisation_id AND x.acknowledged_at IS NULL
    UNION ALL
    SELECT dd.owner_user_id, 'document_reviews', dd.id, dd.id, dd.number || ' · ' || left(dd.title, 120) || ' (periodic review)', dd.next_review_on, 'documentation.read', NULL
      FROM public.documents dd
     WHERE dd.organisation_id = p_organisation_id AND dd.status = 'active' AND dd.next_review_on IS NOT NULL
    UNION ALL
    -- SCARs waiting on the supplier's response.
    SELECT s.owner_user_id, 'scars', s.id, s.id, s.reference || ' · ' || left(s.title, 120) || ' (supplier response)', s.response_due_on, 'supplier_quality.read', NULL
      FROM public.supplier_scars s
     WHERE s.organisation_id = p_organisation_id AND s.status IN ('issued', 'acknowledged', 'revision_requested') AND s.owner_user_id IS NOT NULL AND s.response_due_on IS NOT NULL
    UNION ALL
    -- The person's own competence: current assessments at level 1 or more of an active skill that expire.
    SELECT e.auth_id, 'competence', a.id, a.id, k.name || ' (assessment expires)', a.expires_on, NULL, NULL
      FROM public.competence_assessments a
      JOIN public."Employees" e ON e.id = a.employee_id AND e.organisation_id = a.organisation_id AND e.auth_id IS NOT NULL AND coalesce(e.active, true)
      JOIN public.competence_skills k ON k.id = a.skill_id AND k.active
     WHERE a.organisation_id = p_organisation_id AND a.status = 'current' AND a.level >= 1 AND a.expires_on IS NOT NULL
  )
  SELECT r.user_id, r.area, r.record_id, r.target_id, r.label, r.due_on, r.permission, r.site_id
    FROM rows r JOIN w ON w.key = r.area
   WHERE r.user_id IS NOT NULL AND r.due_on <= p_today + w.soon_days
$$;

-- Whether the person in the current claims may be told about an item: an active member, the area on, and (when the item needs it) the permission at its site.
CREATE FUNCTION app.reminder_item_allowed(p_organisation_id uuid, p_area text, p_permission text, p_site_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app.is_member(p_organisation_id)
     AND NOT EXISTS (SELECT 1 FROM public.reminder_preferences p
                      WHERE p.organisation_id = p_organisation_id AND p.user_id = (SELECT auth.uid()) AND p.area = p_area AND NOT p.enabled)
     AND (p_permission IS NULL OR app.has_permission(p_organisation_id, p_permission, p_site_id))
$$;

-- The caller's own items now, as at their organisation's day (the Reminders page). Every area, even ones switched off (shown as off).
CREATE FUNCTION app.my_reminders(p_organisation_id uuid)
RETURNS TABLE (area text, record_id uuid, target_id uuid, label text, due_on date, overdue boolean, area_enabled boolean, today date)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_today date := (now() AT TIME ZONE app.organisation_time_zone(p_organisation_id))::date;
BEGIN
  IF auth.uid() IS NULL OR NOT app.is_member(p_organisation_id) THEN RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501'; END IF;
  RETURN QUERY
  SELECT c.area, c.record_id, c.target_id, c.label, c.due_on, c.due_on < v_today,
         NOT EXISTS (SELECT 1 FROM public.reminder_preferences p WHERE p.organisation_id = p_organisation_id AND p.user_id = auth.uid() AND p.area = c.area AND NOT p.enabled),
         v_today
    FROM app.reminder_candidates(p_organisation_id, v_today) c
   WHERE c.user_id = auth.uid() AND (c.permission IS NULL OR app.has_permission(p_organisation_id, c.permission, c.site_id))
   ORDER BY c.due_on, c.label;
END $$;

-- ---------------------------------------------------------------------------
-- What is sent
-- ---------------------------------------------------------------------------
CREATE TABLE public.reminder_digests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  day date NOT NULL,
  overdue integer NOT NULL CHECK (overdue >= 0),
  due_soon integer NOT NULL CHECK (due_soon >= 0),
  summary text NOT NULL CHECK (length(summary) BETWEEN 1 AND 2000),
  items jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reminder_digests_once UNIQUE (organisation_id, user_id, day),
  CONSTRAINT reminder_digests_not_empty CHECK (overdue + due_soon > 0)
);
CREATE INDEX reminder_digests_user_idx ON public.reminder_digests (organisation_id, user_id, day DESC);

CREATE TABLE public.reminder_overdue_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  area text NOT NULL CHECK (area ~ '^[a-z_]{2,40}$'),
  record_id uuid NOT NULL,
  target_id uuid NOT NULL,
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 300),
  due_on date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reminder_overdue_notices_once UNIQUE (organisation_id, user_id, area, record_id, due_on)
);

-- Which organisations have had today's run (in their own day). Kept for 60 days.
CREATE TABLE app.reminder_runs (
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  day date NOT NULL,
  ran_at timestamptz NOT NULL DEFAULT now(),
  digests integer NOT NULL DEFAULT 0,
  overdue_notices integer NOT NULL DEFAULT 0,
  PRIMARY KEY (organisation_id, day)
);
REVOKE ALL ON app.reminder_runs FROM PUBLIC, anon, authenticated;

ALTER TABLE public.reminder_digests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reminder_overdue_notices ENABLE ROW LEVEL SECURITY;
CREATE POLICY reminder_digests_select ON public.reminder_digests FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) AND app.is_member(organisation_id));
CREATE POLICY reminder_overdue_notices_select ON public.reminder_overdue_notices FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) AND app.is_member(organisation_id));
REVOKE ALL ON public.reminder_digests, public.reminder_overdue_notices FROM anon, authenticated;
GRANT SELECT ON public.reminder_digests, public.reminder_overdue_notices TO authenticated;

-- Never changed or deleted once written (they are what was sent).
CREATE FUNCTION app.reminder_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'A sent reminder never changes' USING ERRCODE = 'QM010';
END $$;
CREATE TRIGGER reminder_digests_frozen BEFORE UPDATE OR DELETE ON public.reminder_digests FOR EACH ROW EXECUTE FUNCTION app.reminder_frozen();
CREATE TRIGGER reminder_overdue_notices_frozen BEFORE UPDATE OR DELETE ON public.reminder_overdue_notices FOR EACH ROW EXECUTE FUNCTION app.reminder_frozen();

CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.reminder_digests FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.reminder_overdue_notices FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');

INSERT INTO public.notification_event_types
  (key, entity_type, action, group_name, entity_label, description, permission_code, default_on, default_permission_code, label_fields, display_order, own_record, email_default)
VALUES
  ('reminder_digests.created', 'reminder_digests', 'created', 'Reminders', 'Daily reminders', 'Your reminders for today',
   'ncr.read', true, NULL, ARRAY['summary'], 1, true, true),
  ('reminder_overdue_notices.created', 'reminder_overdue_notices', 'created', 'Reminders', 'Overdue', 'Something of yours is now overdue',
   'ncr.read', true, NULL, ARRAY['label', 'due_label'], 2, true, true);

-- ---------------------------------------------------------------------------
-- The daily run (worker step)
-- ---------------------------------------------------------------------------
-- Words for one item in a digest summary.
CREATE FUNCTION app.reminder_item_words(p_label text, p_due date, p_today date) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p_label || ' (' || CASE
    WHEN p_due < p_today THEN 'overdue since ' || to_char(p_due, 'FMDD Mon')
    WHEN p_due = p_today THEN 'due today'
    WHEN p_due = p_today + 1 THEN 'due tomorrow'
    ELSE 'due ' || to_char(p_due, 'FMDD Mon') END || ')'
$$;

-- For every organisation whose reminder time has come today (in its own zone) and that has not run today: a digest for each person with something
-- overdue or due soon, and an overdue notice for each item that went overdue in the last three days. Each item is checked as its person. Returns what it did.
CREATE FUNCTION app.system_run_reminders(p_limit integer DEFAULT 50) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  o record; u record; it record;
  v_claims text := coalesce(current_setting('request.jwt.claims', true), '');
  v_zone text; v_local timestamp; v_today date; v_items jsonb; v_allowed jsonb; v_overdue integer; v_soon integer; v_summary text; v_head text;
  v_digests integer; v_notices integer; v_orgs integer := 0; v_total_digests integer := 0; v_total_notices integer := 0;
BEGIN
  FOR o IN
    SELECT og.id FROM public.organisations og WHERE og.status = 'active' ORDER BY og.created_at
  LOOP
    EXIT WHEN v_orgs >= least(greatest(coalesce(p_limit, 50), 1), 500);
    v_zone := app.organisation_time_zone(o.id);
    v_local := now() AT TIME ZONE v_zone;
    v_today := v_local::date;
    CONTINUE WHEN v_local::time < coalesce((SELECT s.reminder_time FROM public.organisation_settings s WHERE s.organisation_id = o.id), '07:00'::time);
    INSERT INTO app.reminder_runs (organisation_id, day) VALUES (o.id, v_today) ON CONFLICT DO NOTHING;
    CONTINUE WHEN NOT FOUND;
    v_orgs := v_orgs + 1; v_digests := 0; v_notices := 0;

    FOR u IN
      SELECT DISTINCT c.user_id FROM app.reminder_candidates(o.id, v_today) c
      JOIN public.organisation_users ou ON ou.organisation_id = o.id AND ou.user_id = c.user_id AND ou.status = 'active'
    LOOP
      -- Which items this person may be told about, worked out as that person (their permissions, site scope and choices; a reminder is not a session, so
      -- MFA is treated as passed). The rows are then written as the system, so the audit trail does not show the person as their author.
      PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', u.user_id, 'role', 'authenticated', 'aal', 'aal2')::text, true);
      SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.due_on, c.label), '[]'::jsonb) INTO v_allowed
        FROM app.reminder_candidates(o.id, v_today) c
       WHERE c.user_id = u.user_id AND app.reminder_item_allowed(o.id, c.area, c.permission, c.site_id);
      PERFORM set_config('request.jwt.claims', v_claims, true);

      v_items := '[]'::jsonb; v_overdue := 0; v_soon := 0; v_summary := NULL;
      FOR it IN SELECT * FROM jsonb_to_recordset(v_allowed) AS x(area text, record_id uuid, target_id uuid, label text, due_on date)
      LOOP
        IF it.due_on < v_today THEN v_overdue := v_overdue + 1; ELSE v_soon := v_soon + 1; END IF;
        IF jsonb_array_length(v_items) < 50 THEN
          v_items := v_items || jsonb_build_object('area', it.area, 'recordId', it.record_id, 'targetId', it.target_id, 'label', it.label,
                                                   'dueOn', it.due_on, 'overdue', it.due_on < v_today);
        END IF;
        IF (v_overdue + v_soon) <= 5 THEN
          v_summary := concat_ws('; ', v_summary, app.reminder_item_words(it.label, it.due_on, v_today));
        END IF;
        -- Went overdue in the last three days: told once for this due date.
        IF it.due_on < v_today AND it.due_on >= v_today - 3 THEN
          INSERT INTO public.reminder_overdue_notices (organisation_id, user_id, area, record_id, target_id, label, due_on)
          VALUES (o.id, u.user_id, it.area, it.record_id, it.target_id, left(it.label, 300), it.due_on)
          ON CONFLICT ON CONSTRAINT reminder_overdue_notices_once DO NOTHING;
          IF FOUND THEN v_notices := v_notices + 1; END IF;
        END IF;
      END LOOP;
      IF v_overdue + v_soon > 0 THEN
        v_head := concat_ws(', ', CASE WHEN v_overdue > 0 THEN v_overdue || ' overdue' END, CASE WHEN v_soon > 0 THEN v_soon || ' due soon' END);
        v_summary := v_head || ': ' || v_summary || CASE WHEN v_overdue + v_soon > 5 THEN '; and ' || (v_overdue + v_soon - 5) || ' more' ELSE '' END;
        INSERT INTO public.reminder_digests (organisation_id, user_id, day, overdue, due_soon, summary, items)
        VALUES (o.id, u.user_id, v_today, v_overdue, v_soon, left(v_summary, 2000), v_items)
        ON CONFLICT ON CONSTRAINT reminder_digests_once DO NOTHING;
        IF FOUND THEN v_digests := v_digests + 1; END IF;
      END IF;
    END LOOP;
    PERFORM set_config('request.jwt.claims', v_claims, true);
    UPDATE app.reminder_runs SET digests = v_digests, overdue_notices = v_notices WHERE organisation_id = o.id AND day = v_today;
    v_total_digests := v_total_digests + v_digests; v_total_notices := v_total_notices + v_notices;
  END LOOP;
  DELETE FROM app.reminder_runs WHERE day < current_date - 60;
  RETURN jsonb_build_object('organisations', v_orgs, 'digests', v_total_digests, 'overdueNotices', v_total_notices);
END $$;

-- ---------------------------------------------------------------------------
-- The notices: emit_notification as in 20260218100000, plus the two reminder branches (addressed to the person, no actor: the system wrote them).
-- ---------------------------------------------------------------------------
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
  v_risk_row jsonb;
  v_mr_row jsonb;
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

  -- A risk action is news to the person it is given to, when it is added or handed to them; a risk to its owner, likewise. Nothing else about either is.
  IF NEW.entity_type IN ('risk_actions', 'risks', 'management_review_actions') AND (NEW.action = 'delete' OR (NEW.action = 'update' AND NOT (coalesce(NEW.changed_fields, '{}') @> ARRAY['owner_user_id']))) THEN
    RETURN NULL;
  END IF;

  -- Reminders are announced once, when written.
  IF NEW.entity_type IN ('reminder_digests', 'reminder_overdue_notices') AND NEW.action <> 'insert' THEN
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

  -- A risk action tells its person which risk, what to do and by when; a risk tells its new owner which one.
  IF NEW.entity_type = 'risk_actions' THEN
    SELECT to_jsonb(a) || jsonb_build_object(
             'user_id', a.owner_user_id, 'risk_id', r.id, 'risk_label', r.reference || ' · ' || r.title,
             'due_label', CASE WHEN a.due_date IS NULL THEN NULL ELSE 'Due ' || to_char(a.due_date, 'FMDD Mon YYYY') END)
      INTO v_risk_row
      FROM public.risk_actions a JOIN public.risks r ON r.id = a.risk_id
     WHERE a.id = NEW.entity_id::uuid AND a.status = 'open';
    -- Given to yourself: the notice would be for the person who did it, who is never told of their own action.
    IF v_risk_row IS NULL OR (v_risk_row ->> 'user_id')::uuid IS NOT DISTINCT FROM NEW.actor_user_id THEN RETURN NULL; END IF;
    v_row := v_risk_row;
  END IF;
  IF NEW.entity_type = 'risks' THEN
    SELECT to_jsonb(r) || jsonb_build_object('user_id', r.owner_user_id, 'risk_id', r.id, 'risk_label', r.reference || ' · ' || r.title,
             'kind_label', CASE r.kind WHEN 'opportunity' THEN 'Opportunity' ELSE 'Risk' END)
      INTO v_risk_row
      FROM public.risks r
     WHERE r.id = NEW.entity_id::uuid AND r.status NOT IN ('closed', 'retired');
    IF v_risk_row IS NULL OR (v_risk_row ->> 'user_id')::uuid IS NOT DISTINCT FROM NEW.actor_user_id THEN RETURN NULL; END IF;
    v_row := v_risk_row;
  END IF;

  -- A management review action tells its person which review, what to do and by when (they may hold no management review permission: own_record).
  IF NEW.entity_type = 'management_review_actions' THEN
    SELECT to_jsonb(a) || jsonb_build_object(
             'user_id', a.owner_user_id, 'review_id', m.id, 'review_label', m.reference || ' · ' || m.title,
             'due_label', CASE WHEN a.due_date IS NULL THEN NULL ELSE 'Due ' || to_char(a.due_date, 'FMDD Mon YYYY') END)
      INTO v_mr_row
      FROM public.management_review_actions a JOIN public.management_reviews m ON m.id = a.review_id
     WHERE a.id = NEW.entity_id::uuid AND a.status = 'open';
    IF v_mr_row IS NULL OR (v_mr_row ->> 'user_id')::uuid IS NOT DISTINCT FROM NEW.actor_user_id THEN RETURN NULL; END IF;
    v_row := v_mr_row;
  END IF;

  -- An overdue notice says what and since when; the area and the record behind it lead the link.
  IF NEW.entity_type = 'reminder_overdue_notices' THEN
    v_row := v_row || jsonb_build_object('due_label', 'Was due ' || to_char((v_row ->> 'due_on')::date, 'FMDD Mon YYYY'));
  END IF;

  v_body := nullif(concat_ws(' — ', VARIADIC (
    SELECT coalesce(array_agg(nullif(v_row ->> f, '') ORDER BY ord), '{}') FROM unnest(v_type.label_fields) WITH ORDINALITY AS u(f, ord))), '');
  IF v_action = 'updated' AND NEW.changed_fields IS NOT NULL
     AND NEW.entity_type NOT IN ('quality_alert_recipients', 'capa_actions', 'competence_assessments', 'document_signoffs', 'document_recipients', 'document_change_requests', 'risk_actions', 'risks', 'management_review_actions') THEN
    v_what := 'Changed: ' || replace(array_to_string(NEW.changed_fields, ', '), '_', ' ');
    v_body := concat_ws('. ', v_body, left(v_what, 200));
  END IF;

  SELECT coalesce(jsonb_object_agg(k, v_row -> k), '{}'::jsonb) INTO v_details
    FROM unnest(ARRAY['site_id', 'gauge_id', 'control_plan_id', 'part_id', 'source', 'stage', 'status', 'alert_id', 'capa_id', 'connection_id', 'run_id', 'kind',
                      'document_id', 'revision_id', 'role', 'risk_id', 'review_id', 'area', 'target_id']) k
   WHERE v_row ->> k IS NOT NULL;

  -- Notices about one person's own alerts are for that person only.
  IF NEW.entity_type IN ('quality_alert_recipients', 'capa_actions', 'competence_assessments', 'document_signoffs', 'document_recipients', 'document_change_requests', 'risk_actions', 'risks', 'management_review_actions',
                         'reminder_digests', 'reminder_overdue_notices') THEN
    v_recipient := (v_row ->> 'user_id')::uuid;
  END IF;

  INSERT INTO public.notifications (organisation_id, event_type_id, audit_event_id, entity_type, entity_id, title, body, details, actor_user_id, recipient_user_id)
  VALUES (NEW.organisation_id, v_type.id, NEW.id, NEW.entity_type, NEW.entity_id, v_type.description, v_body, v_details,
          CASE WHEN NEW.entity_type IN ('integration_alerts', 'document_recipients', 'reminder_digests', 'reminder_overdue_notices') THEN NULL ELSE NEW.actor_user_id END, v_recipient)
  ON CONFLICT (audit_event_id) DO NOTHING;
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION app.organisation_settings_time_zone_rule(), app.reminder_frozen() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.organisation_time_zone(uuid), app.reminder_areas(), app.my_reminder_areas(uuid), app.set_reminder_area(uuid, text, boolean),
  app.reminder_candidates(uuid, date), app.reminder_item_allowed(uuid, text, text, uuid), app.my_reminders(uuid), app.reminder_item_words(text, date, date),
  app.system_run_reminders(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.organisation_time_zone(uuid), app.reminder_areas(), app.my_reminder_areas(uuid), app.set_reminder_area(uuid, text, boolean),
  app.my_reminders(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION app.system_run_reminders(integer) TO qms_api;
