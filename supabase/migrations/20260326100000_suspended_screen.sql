-- A suspended member is told so (not sent to "Start your organisation"): where they were suspended, by whom and when.
-- The app reads this through /me (`suspended`); the membership itself is invisible to the person once it is not active, so this
-- one function (the caller's own memberships only) is the way to see it. Information only: it grants no access.
CREATE FUNCTION app.my_suspensions()
RETURNS TABLE (organisation_id uuid, name text, suspended_at timestamptz, suspended_by uuid, suspended_by_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT o.id, o.name, coalesce(e.created_at, m.updated_at), coalesce(e.actor_user_id, m.updated_by),
         nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.surname, '')), '')
    FROM public.organisation_users m
    JOIN public.organisations o ON o.id = m.organisation_id AND o.status = 'active'
    LEFT JOIN LATERAL (
      -- the latest change that made this membership suspended (the audit trail knows who and when)
      SELECT ev.created_at, ev.actor_user_id
        FROM audit.events ev
       WHERE ev.organisation_id = m.organisation_id AND ev.entity_type = 'organisation_users' AND ev.entity_id = m.id::text
         AND ev.new_values ->> 'status' = 'suspended' AND (ev.previous_values ->> 'status') IS DISTINCT FROM 'suspended'
       ORDER BY ev.seq DESC LIMIT 1
    ) e ON true
    LEFT JOIN public.profiles p ON p.id = coalesce(e.actor_user_id, m.updated_by)
   WHERE m.user_id = auth.uid() AND m.status = 'suspended'
   ORDER BY o.name
$$;

REVOKE ALL ON FUNCTION app.my_suspensions() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.my_suspensions() TO authenticated;
