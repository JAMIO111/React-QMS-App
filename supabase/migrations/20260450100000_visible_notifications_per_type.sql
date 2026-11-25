/*
 * Notifications list: work out "may this person see it" and "do they want it" once per kind of notice, not once per notice.
 *
 * The load test (smoke profile, 71 MB, 12 people) found GET /notifications taking about 4 seconds: app.visible_notifications ran two permission functions
 * (notification_can_see, notification_wanted, each with several lookups) for every notice in the last 90 days, and the list endpoint called it twice.
 * Both answers depend on very little: "wanted" only on the event type (and the caller), "can see" on the event type and the site named in the notice's
 * details. There are about a hundred event types and a handful of sites, so they are now worked out once for each distinct combination found in the
 * window and joined back. The rule itself is unchanged, word for word (app.notification_can_see and app.notification_wanted are still the definitions
 * and are still what is called); only how often they run changes. Same signature, same columns, same rows.
 */

CREATE OR REPLACE FUNCTION app.visible_notifications(p_organisation_id uuid)
RETURNS TABLE (id uuid, event_key text, entity_type text, entity_id text, title text, body text, details jsonb,
               actor_user_id uuid, created_at timestamptz, read_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH cand AS MATERIALIZED (
    SELECT n.id, n.event_type_id, n.organisation_id, n.entity_type, n.entity_id, n.title, n.body, n.details, n.actor_user_id, n.created_at,
           (n.details ? 'site_id') AS has_site, (n.details ->> 'site_id') AS site_text
    FROM public.notifications n
    WHERE n.organisation_id = p_organisation_id
      AND app.is_member(p_organisation_id)
      AND n.created_at > now() - interval '90 days'
      AND n.actor_user_id IS DISTINCT FROM auth.uid()
      AND (n.recipient_user_id IS NULL OR n.recipient_user_id = auth.uid())
  ),
  wanted AS MATERIALIZED (
    SELECT t.event_type_id, app.notification_wanted(p_organisation_id, t.event_type_id) AS ok
    FROM (SELECT DISTINCT c.event_type_id FROM cand c) t
  ),
  seen AS MATERIALIZED (
    SELECT s.event_type_id, s.has_site, s.site_text,
           -- one representative notice per combination: the rule reads only the type and the site from it
           app.notification_can_see(p_organisation_id, s.event_type_id,
             CASE WHEN s.has_site THEN jsonb_build_object('site_id', s.site_text) ELSE '{}'::jsonb END) AS ok
    FROM (SELECT DISTINCT c.event_type_id, c.has_site, c.site_text FROM cand c) s
  )
  SELECT c.id, t.key, c.entity_type, c.entity_id, c.title, c.body, c.details, c.actor_user_id, c.created_at, r.read_at
  FROM cand c
  JOIN public.notification_event_types t ON t.id = c.event_type_id
  JOIN wanted w ON w.event_type_id = c.event_type_id AND w.ok
  JOIN seen s ON s.event_type_id = c.event_type_id AND s.has_site = c.has_site AND s.site_text IS NOT DISTINCT FROM c.site_text AND s.ok
  LEFT JOIN public.notification_reads r ON r.notification_id = c.id AND r.user_id = auth.uid()
$$;
