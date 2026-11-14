-- Organisation security SE4 (docs/security-plan.md, decision S9): while an organisation enforces its approved networks, its notification emails
-- carry only "You have a new notification in Fortress — <organisation>" and the link, so titles and descriptions never land in an inbox read on a
-- home network or a phone. The lease now says whether the organisation enforces; the API renders the short email. Monitor mode is unchanged.
-- Same function as in 20260131200000_email_notifications.sql plus the last column (the return type changes, so it is dropped and created again).

DROP FUNCTION app.system_lease_emails(integer, integer);

CREATE FUNCTION app.system_lease_emails(p_limit integer DEFAULT 50, p_lease_seconds integer DEFAULT 120)
RETURNS TABLE (id uuid, organisation_id uuid, organisation_name text, to_address text, recipient_name text, attempts integer,
               event_key text, entity_type text, entity_id text, title text, body text, details jsonb, created_at timestamptz,
               network_restricted boolean)
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
         t.key, n.entity_type, n.entity_id, n.title, n.body, n.details, n.created_at,
         coalesce(s.network_policy = 'enforce', false)
    FROM leased l
    JOIN public.notifications n ON n.id = l.notification_id
    JOIN public.notification_event_types t ON t.id = n.event_type_id
    JOIN public.organisations o ON o.id = l.organisation_id
    LEFT JOIN public.organisation_settings s ON s.organisation_id = l.organisation_id
    LEFT JOIN public.profiles p ON p.id = l.user_id;
END $$;

REVOKE ALL ON FUNCTION app.system_lease_emails(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.system_lease_emails(integer, integer) TO qms_api;
