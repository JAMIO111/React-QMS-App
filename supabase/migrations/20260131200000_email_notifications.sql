-- Email notifications (docs/email-oauth-plan.md, slice EM1; decisions E1–E4).
--
-- * Every in-app notification can also be emailed, per person: `notification_preferences.email` (null = the event's default), `enabled` may now be
--   null too (null = follow the default; a row exists while either choice is overridden). Email is on by default (`email_default`) only for notices
--   addressed to one person and for integration alerts.
-- * `email_outbox`: one row per notification and person, never twice. Written only by API-login functions:
--   `app.system_queue_notification_emails` (fan-out: for each notification not yet considered, every active member with a confirmed address who would
--   see it in the app — same permission, site, subscription, preference, addressed-to and not-your-own-action rules, evaluated as that person — and wants
--   it by email), `app.system_lease_emails` (what to send now, with what the API needs to render it) and `app.system_finish_email` (sent / unsent: no
--   provider / failed → back off 1, 4, 16, 64 minutes, failed for good after five attempts).
-- * `integration_alerts`: one per finished import (not a preview) that failed or left something for a person (rejected or failed rows, values to
--   review, records that disappeared); audited, so the existing notification trigger makes event `integration_alerts.created` (permission
--   `integrations.read`, on by default for `integrations.run`, email on by default). Its notice has no actor, so whoever started the import is told too.
-- * `app.platform_email_outbox` (operators, counts and failures only, never content or addresses).

-- ---------------------------------------------------------------------------
-- Preferences
-- ---------------------------------------------------------------------------
ALTER TABLE public.notification_event_types ADD COLUMN email_default boolean NOT NULL DEFAULT false;

ALTER TABLE public.notification_preferences ALTER COLUMN enabled DROP NOT NULL;
ALTER TABLE public.notification_preferences ADD COLUMN email boolean;
ALTER TABLE public.notification_preferences ADD CONSTRAINT notification_preferences_some_choice CHECK (enabled IS NOT NULL OR email IS NOT NULL);

-- Does the signed-in user want this event by email? Only when they get it in the app at all, then their email choice, else the event's default.
CREATE FUNCTION app.notification_email_wanted(p_organisation_id uuid, p_event_type_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app.notification_wanted(p_organisation_id, p_event_type_id) AND coalesce(
    (SELECT p.email FROM public.notification_preferences p
      WHERE p.organisation_id = p_organisation_id AND p.user_id = auth.uid() AND p.event_type_id = p_event_type_id),
    (SELECT t.email_default FROM public.notification_event_types t WHERE t.id = p_event_type_id),
    false)
$$;

DROP FUNCTION app.list_notification_preferences(uuid);
CREATE FUNCTION app.list_notification_preferences(p_organisation_id uuid)
RETURNS TABLE (key text, group_name text, entity_label text, action text, description text,
               enabled boolean, default_enabled boolean, overridden boolean, display_order integer,
               email boolean, email_default boolean, email_overridden boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT t.key, t.group_name, t.entity_label, t.action, t.description,
         app.notification_wanted(p_organisation_id, t.id),
         t.default_on AND (t.default_permission_code IS NULL OR app.has_permission_somewhere(p_organisation_id, t.default_permission_code)),
         p.enabled IS NOT NULL,
         t.display_order,
         app.notification_email_wanted(p_organisation_id, t.id),
         t.email_default,
         p.email IS NOT NULL
  FROM public.notification_event_types t
  LEFT JOIN public.notification_preferences p ON p.organisation_id = p_organisation_id AND p.user_id = auth.uid() AND p.event_type_id = t.id
  WHERE app.is_member(p_organisation_id) AND app.has_permission_somewhere(p_organisation_id, t.permission_code)
  ORDER BY t.display_order, t.action
$$;

-- enabled NULL removes the in-app override (back to the default); the email choice is kept.
CREATE OR REPLACE FUNCTION app.set_notification_preference(p_organisation_id uuid, p_event_key text, p_enabled boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_type public.notification_event_types%ROWTYPE;
BEGIN
  IF NOT app.is_member(p_organisation_id) THEN
    RAISE EXCEPTION 'Not a member of this organisation' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_type FROM public.notification_event_types WHERE key = p_event_key;
  IF NOT FOUND OR NOT app.has_permission_somewhere(p_organisation_id, v_type.permission_code) THEN
    RAISE EXCEPTION 'Unknown notification type' USING ERRCODE = 'QM010';
  END IF;
  IF p_enabled IS NULL THEN
    UPDATE public.notification_preferences SET enabled = NULL, updated_at = now()
     WHERE organisation_id = p_organisation_id AND user_id = auth.uid() AND event_type_id = v_type.id AND email IS NOT NULL;
    DELETE FROM public.notification_preferences
     WHERE organisation_id = p_organisation_id AND user_id = auth.uid() AND event_type_id = v_type.id AND email IS NULL;
  ELSE
    INSERT INTO public.notification_preferences (organisation_id, user_id, event_type_id, enabled)
    VALUES (p_organisation_id, auth.uid(), v_type.id, p_enabled)
    ON CONFLICT (organisation_id, user_id, event_type_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now();
  END IF;
END $$;

-- The email choice for one event: true / false, or NULL for the event's default.
CREATE FUNCTION app.set_notification_email(p_organisation_id uuid, p_event_key text, p_email boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_type public.notification_event_types%ROWTYPE;
BEGIN
  IF NOT app.is_member(p_organisation_id) THEN
    RAISE EXCEPTION 'Not a member of this organisation' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_type FROM public.notification_event_types WHERE key = p_event_key;
  IF NOT FOUND OR NOT app.has_permission_somewhere(p_organisation_id, v_type.permission_code) THEN
    RAISE EXCEPTION 'Unknown notification type' USING ERRCODE = 'QM010';
  END IF;
  IF p_email IS NULL THEN
    UPDATE public.notification_preferences SET email = NULL, updated_at = now()
     WHERE organisation_id = p_organisation_id AND user_id = auth.uid() AND event_type_id = v_type.id AND enabled IS NOT NULL;
    DELETE FROM public.notification_preferences
     WHERE organisation_id = p_organisation_id AND user_id = auth.uid() AND event_type_id = v_type.id AND enabled IS NULL;
  ELSE
    INSERT INTO public.notification_preferences (organisation_id, user_id, event_type_id, email)
    VALUES (p_organisation_id, auth.uid(), v_type.id, p_email)
    ON CONFLICT (organisation_id, user_id, event_type_id) DO UPDATE SET email = EXCLUDED.email, updated_at = now();
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Integration alerts
-- ---------------------------------------------------------------------------
CREATE TABLE public.integration_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  run_id uuid NOT NULL,
  entity_type text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('failed', 'needs_attention')),
  summary text NOT NULL CHECK (length(summary) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id),
  CONSTRAINT integration_alerts_connection_fkey FOREIGN KEY (connection_id, organisation_id) REFERENCES public.integration_connections (id, organisation_id),
  CONSTRAINT integration_alerts_run_fkey FOREIGN KEY (run_id) REFERENCES public.integration_sync_runs (id)
);
CREATE INDEX integration_alerts_org_idx ON public.integration_alerts (organisation_id, created_at DESC);
ALTER TABLE public.integration_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY integration_alerts_select ON public.integration_alerts FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'integrations.read'));
REVOKE ALL ON public.integration_alerts FROM anon, authenticated;
GRANT SELECT ON public.integration_alerts TO authenticated;
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.integration_alerts FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');

-- Read at the end of the transaction (the run's counts, status and disappeared records are all written by then); one alert per run at most.
CREATE FUNCTION app.integration_alert_for_run() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.integration_sync_runs%ROWTYPE; v_conn text; v_parts text[] := '{}'; v_missing integer; v_kind text;
BEGIN
  SELECT * INTO r FROM public.integration_sync_runs WHERE id = NEW.id;
  IF NOT FOUND OR r.kind = 'preview' OR r.status NOT IN ('succeeded', 'partial', 'failed') THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM public.integration_alerts WHERE run_id = r.id) THEN RETURN NULL; END IF;
  v_missing := coalesce((r.missing ->> 'listed')::int, 0) + coalesce((r.missing ->> 'held')::int, 0);
  IF r.rejected > 0 THEN v_parts := v_parts || format('%s rejected', r.rejected); END IF;
  IF r.failed > 0 THEN v_parts := v_parts || format('%s failed', r.failed); END IF;
  IF r.parked > 0 THEN v_parts := v_parts || format('%s to review', r.parked); END IF;
  IF v_missing > 0 THEN v_parts := v_parts || format('%s no longer in the source', v_missing); END IF;
  IF r.status = 'failed' THEN v_kind := 'failed';
  ELSIF cardinality(v_parts) > 0 THEN v_kind := 'needs_attention';
  ELSE RETURN NULL;
  END IF;
  SELECT name INTO v_conn FROM public.integration_connections WHERE id = r.connection_id;
  INSERT INTO public.integration_alerts (organisation_id, connection_id, run_id, entity_type, kind, summary)
  VALUES (r.organisation_id, r.connection_id, r.id, r.entity_type, v_kind, left(concat_ws(' — ',
    v_conn || ': ' || replace(r.entity_type, '_', ' ') || ' import ' || CASE v_kind WHEN 'failed' THEN 'failed' ELSE 'needs attention' END,
    nullif(array_to_string(v_parts, ', '), ''),
    CASE WHEN v_kind = 'failed' THEN nullif(left(r.error_summary, 200), '') END), 500))
  ON CONFLICT (run_id) DO NOTHING;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER integration_sync_runs_alert AFTER UPDATE ON public.integration_sync_runs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.status IN ('succeeded', 'partial', 'failed') AND NEW.kind <> 'preview')
  EXECUTE FUNCTION app.integration_alert_for_run();

INSERT INTO public.notification_event_types
  (key, entity_type, action, group_name, entity_label, description, permission_code, default_on, default_permission_code, label_fields, display_order, email_default)
VALUES ('integration_alerts.created', 'integration_alerts', 'created', 'Integrations', 'Import', 'Import needs attention', 'integrations.read', true, 'integrations.run', ARRAY['summary'], 80, true);

-- Notices addressed to one person are emailed by default.
UPDATE public.notification_event_types SET email_default = true
 WHERE key IN ('quality_alert_recipients.created', 'quality_alert_recipients.updated', 'capa_actions.created', 'capa_actions.updated');

-- ---------------------------------------------------------------------------
-- The notification trigger: links for integration alerts, and no actor (everyone who may see an import's problems is told)
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
BEGIN
  -- A recipient row also changes when they view or acknowledge: only the withdrawal notice is worth a notification.
  IF NEW.entity_type = 'quality_alert_recipients' AND NEW.action = 'update' AND NOT (coalesce(NEW.changed_fields, '{}') @> ARRAY['withdrawn_notified_at']) THEN
    RETURN NULL;
  END IF;

  -- An 8D action notifies the person it is assigned to, when it is added with someone on it or handed to someone else; nothing else about it does.
  IF NEW.entity_type = 'capa_actions' AND (NEW.action = 'delete' OR (NEW.action = 'update' AND NOT (coalesce(NEW.changed_fields, '{}') @> ARRAY['owner_team_member_id']))) THEN
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

  v_body := nullif(concat_ws(' — ', VARIADIC (
    SELECT coalesce(array_agg(nullif(v_row ->> f, '') ORDER BY ord), '{}') FROM unnest(v_type.label_fields) WITH ORDINALITY AS u(f, ord))), '');
  IF v_action = 'updated' AND NEW.changed_fields IS NOT NULL AND NEW.entity_type NOT IN ('quality_alert_recipients', 'capa_actions') THEN
    v_what := 'Changed: ' || replace(array_to_string(NEW.changed_fields, ', '), '_', ' ');
    v_body := concat_ws('. ', v_body, left(v_what, 200));
  END IF;

  SELECT coalesce(jsonb_object_agg(k, v_row -> k), '{}'::jsonb) INTO v_details
    FROM unnest(ARRAY['site_id', 'gauge_id', 'control_plan_id', 'part_id', 'source', 'stage', 'status', 'alert_id', 'capa_id', 'connection_id', 'run_id', 'kind']) k
   WHERE v_row ->> k IS NOT NULL;

  -- Notices about one person's own alerts are for that person only.
  IF NEW.entity_type IN ('quality_alert_recipients', 'capa_actions') THEN v_recipient := (v_row ->> 'user_id')::uuid; END IF;

  INSERT INTO public.notifications (organisation_id, event_type_id, audit_event_id, entity_type, entity_id, title, body, details, actor_user_id, recipient_user_id)
  VALUES (NEW.organisation_id, v_type.id, NEW.id, NEW.entity_type, NEW.entity_id, v_type.description, v_body, v_details,
          CASE WHEN NEW.entity_type = 'integration_alerts' THEN NULL ELSE NEW.actor_user_id END, v_recipient)
  ON CONFLICT (audit_event_id) DO NOTHING;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- The outbox
-- ---------------------------------------------------------------------------
ALTER TABLE public.notifications ADD COLUMN email_queued_at timestamptz;
-- Notices from before email existed are never emailed.
UPDATE public.notifications SET email_queued_at = created_at WHERE email_queued_at IS NULL;
CREATE INDEX notifications_email_pending_idx ON public.notifications (created_at) WHERE email_queued_at IS NULL;

CREATE TABLE public.email_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  notification_id uuid NOT NULL REFERENCES public.notifications (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  to_address text NOT NULL CHECK (length(to_address) BETWEEN 3 AND 320),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'unsent', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  leased_until timestamptz,
  provider text CHECK (provider IS NULL OR length(provider) <= 40),
  provider_message_id text CHECK (provider_message_id IS NULL OR length(provider_message_id) <= 200),
  last_error text CHECK (last_error IS NULL OR length(last_error) <= 1000),
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (notification_id, user_id)
);
CREATE INDEX email_outbox_due_idx ON public.email_outbox (next_attempt_at) WHERE status = 'queued';
CREATE INDEX email_outbox_org_idx ON public.email_outbox (organisation_id, created_at DESC);
ALTER TABLE public.email_outbox ENABLE ROW LEVEL SECURITY;
-- A person may see the emails Fortress sent them; nobody writes the table except the functions below.
CREATE POLICY email_outbox_select ON public.email_outbox FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) AND app.is_member(organisation_id));
REVOKE ALL ON public.email_outbox FROM anon, authenticated;
GRANT SELECT ON public.email_outbox TO authenticated;

-- Fan-out: notices not yet considered, oldest first. A notice older than a day is marked without emailing (a backlog is never mailed out late).
CREATE FUNCTION app.system_queue_notification_emails(p_limit integer DEFAULT 200) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n record; m record; v_claims text := coalesce(current_setting('request.jwt.claims', true), ''); v_queued integer := 0; v_ok boolean;
BEGIN
  FOR n IN
    SELECT * FROM public.notifications WHERE email_queued_at IS NULL ORDER BY created_at LIMIT least(greatest(coalesce(p_limit, 200), 1), 1000) FOR UPDATE SKIP LOCKED
  LOOP
    IF n.created_at > now() - interval '1 day' THEN
      FOR m IN
        SELECT ou.user_id, u.email FROM public.organisation_users ou
        JOIN auth.users u ON u.id = ou.user_id
        JOIN public.organisations o ON o.id = ou.organisation_id AND o.status = 'active'
        WHERE ou.organisation_id = n.organisation_id AND ou.status = 'active'
          AND u.email IS NOT NULL AND u.email_confirmed_at IS NOT NULL AND length(u.email) BETWEEN 3 AND 320
          AND ou.user_id IS DISTINCT FROM n.actor_user_id
          AND (n.recipient_user_id IS NULL OR ou.user_id = n.recipient_user_id)
      LOOP
        -- Evaluated as that person (their permissions, site scope, subscription and preferences); an email is not a session, so MFA is treated as passed.
        PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', m.user_id, 'role', 'authenticated', 'aal', 'aal2')::text, true);
        v_ok := app.notification_can_see(n.organisation_id, n.event_type_id, n.details) AND app.notification_email_wanted(n.organisation_id, n.event_type_id);
        IF v_ok THEN
          INSERT INTO public.email_outbox (organisation_id, notification_id, user_id, to_address)
          VALUES (n.organisation_id, n.id, m.user_id, m.email) ON CONFLICT (notification_id, user_id) DO NOTHING;
          IF FOUND THEN v_queued := v_queued + 1; END IF;
        END IF;
      END LOOP;
      PERFORM set_config('request.jwt.claims', v_claims, true);
    END IF;
    UPDATE public.notifications SET email_queued_at = now() WHERE id = n.id;
  END LOOP;
  RETURN v_queued;
END $$;

-- What to send now: queued, due and not leased by another worker; leased for p_lease_seconds. Carries what the API needs to write the email.
CREATE FUNCTION app.system_lease_emails(p_limit integer DEFAULT 50, p_lease_seconds integer DEFAULT 120)
RETURNS TABLE (id uuid, organisation_id uuid, organisation_name text, to_address text, recipient_name text, attempts integer,
               event_key text, entity_type text, entity_id text, title text, body text, details jsonb, created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT e.id FROM public.email_outbox e
     WHERE e.status = 'queued' AND e.next_attempt_at <= now() AND (e.leased_until IS NULL OR e.leased_until < now())
     ORDER BY e.next_attempt_at LIMIT least(greatest(coalesce(p_limit, 50), 1), 200) FOR UPDATE SKIP LOCKED
  ), leased AS (
    UPDATE public.email_outbox e SET leased_until = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 120), 10), 900)), updated_at = now()
      FROM due WHERE e.id = due.id RETURNING e.*
  )
  SELECT l.id, l.organisation_id, o.name, l.to_address, nullif(btrim(concat_ws(' ', p.first_name, p.surname)), ''), l.attempts,
         t.key, n.entity_type, n.entity_id, n.title, n.body, n.details, n.created_at
    FROM leased l
    JOIN public.notifications n ON n.id = l.notification_id
    JOIN public.notification_event_types t ON t.id = n.event_type_id
    JOIN public.organisations o ON o.id = l.organisation_id
    LEFT JOIN public.profiles p ON p.id = l.user_id;
END $$;

-- The outcome of one send. sent / unsent (no mail provider: kept as it would have been sent) and refused (the provider will never take it) are final;
-- failed backs off 1, 4, 16, 64 minutes and is final after five attempts.
CREATE FUNCTION app.system_finish_email(p_id uuid, p_outcome text, p_provider text DEFAULT NULL, p_message_id text DEFAULT NULL, p_error text DEFAULT NULL)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE e public.email_outbox%ROWTYPE;
BEGIN
  SELECT * INTO e FROM public.email_outbox WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Email not found' USING ERRCODE = 'P0002'; END IF;
  IF e.status <> 'queued' THEN RETURN e.status; END IF;
  IF p_outcome = 'sent' THEN
    UPDATE public.email_outbox SET status = 'sent', sent_at = now(), attempts = e.attempts + 1, provider = left(p_provider, 40), provider_message_id = left(p_message_id, 200),
           last_error = NULL, leased_until = NULL, updated_at = now() WHERE id = e.id;
    RETURN 'sent';
  ELSIF p_outcome = 'unsent' THEN
    UPDATE public.email_outbox SET status = 'unsent', provider = left(p_provider, 40), last_error = left(coalesce(p_error, 'No mail provider is set up'), 1000),
           leased_until = NULL, updated_at = now() WHERE id = e.id;
    RETURN 'unsent';
  ELSIF p_outcome IN ('failed', 'refused') THEN
    IF p_outcome = 'refused' OR e.attempts + 1 >= 5 THEN
      UPDATE public.email_outbox SET status = 'failed', attempts = e.attempts + 1, provider = left(p_provider, 40), last_error = left(p_error, 1000), leased_until = NULL, updated_at = now() WHERE id = e.id;
      RETURN 'failed';
    END IF;
    UPDATE public.email_outbox SET attempts = e.attempts + 1, provider = left(p_provider, 40), last_error = left(p_error, 1000), leased_until = NULL,
           next_attempt_at = now() + make_interval(mins => power(4, e.attempts)::int), updated_at = now() WHERE id = e.id;
    RETURN 'queued';
  END IF;
  RAISE EXCEPTION 'The outcome is sent, unsent, failed or refused' USING ERRCODE = '22023';
END $$;

-- Operators: how email is doing. Counts, the provider and failures with their error — never a subject, a body or an address.
CREATE FUNCTION app.platform_email_outbox(p_hours integer DEFAULT 24) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_since timestamptz := now() - make_interval(hours => least(greatest(coalesce(p_hours, 24), 1), 720));
BEGIN
  IF NOT app.is_platform_admin() THEN RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501'; END IF;
  RETURN jsonb_build_object(
    'since', v_since,
    'counts', (SELECT coalesce(jsonb_object_agg(status, n), '{}'::jsonb) FROM (SELECT status, count(*) AS n FROM public.email_outbox WHERE created_at >= v_since GROUP BY status) s),
    'waiting', (SELECT count(*) FROM public.email_outbox WHERE status = 'queued'),
    'oldestWaiting', (SELECT min(created_at) FROM public.email_outbox WHERE status = 'queued'),
    'lastSent', (SELECT max(sent_at) FROM public.email_outbox WHERE status = 'sent'),
    'providers', (SELECT coalesce(jsonb_agg(DISTINCT provider), '[]'::jsonb) FROM public.email_outbox WHERE created_at >= v_since AND provider IS NOT NULL),
    'notQueued', (SELECT count(*) FROM public.notifications WHERE email_queued_at IS NULL),
    'byEvent', (SELECT coalesce(jsonb_agg(jsonb_build_object('event', key, 'count', n) ORDER BY n DESC), '[]'::jsonb) FROM (
                 SELECT t.key, count(*) AS n FROM public.email_outbox e JOIN public.notifications nn ON nn.id = e.notification_id
                   JOIN public.notification_event_types t ON t.id = nn.event_type_id WHERE e.created_at >= v_since GROUP BY t.key LIMIT 20) x),
    'problems', (SELECT coalesce(jsonb_agg(jsonb_build_object('organisation', o.name, 'event', t.key, 'status', e.status, 'attempts', e.attempts,
                   'error', e.last_error, 'at', e.updated_at) ORDER BY e.updated_at DESC), '[]'::jsonb) FROM (
                 SELECT * FROM public.email_outbox WHERE status IN ('failed') OR (status = 'queued' AND attempts > 0) ORDER BY updated_at DESC LIMIT 25) e
                 JOIN public.organisations o ON o.id = e.organisation_id
                 JOIN public.notifications nn ON nn.id = e.notification_id JOIN public.notification_event_types t ON t.id = nn.event_type_id)
  );
END $$;

REVOKE ALL ON FUNCTION app.notification_email_wanted(uuid, uuid), app.list_notification_preferences(uuid), app.set_notification_email(uuid, text, boolean),
  app.integration_alert_for_run(), app.system_queue_notification_emails(integer), app.system_lease_emails(integer, integer),
  app.system_finish_email(uuid, text, text, text, text), app.platform_email_outbox(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.notification_email_wanted(uuid, uuid), app.list_notification_preferences(uuid), app.set_notification_email(uuid, text, boolean),
  app.platform_email_outbox(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION app.system_queue_notification_emails(integer), app.system_lease_emails(integer, integer), app.system_finish_email(uuid, text, text, text, text) TO qms_api;
