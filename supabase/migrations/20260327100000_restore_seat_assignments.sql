-- Restores app.list_seat_assignments(uuid), which 20251110100000_subscriptions.sql creates but the live database did not have: without it
-- GET /subscription/assignments answered 500, so Settings → Users & permissions showed nobody's seat and could not set one (assigning a seat
-- reads the list first). The definition is the original one; CREATE OR REPLACE makes this safe where the function already exists.
CREATE OR REPLACE FUNCTION app.list_seat_assignments(p_organisation_id uuid)
RETURNS TABLE (membership_id uuid, email text, first_name text, surname text, status text, roles jsonb,
               plan_slug text, plan_name text, assigned_at timestamptz, unit_amount integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT (app.has_permission(p_organisation_id, 'subscription.read') OR app.has_permission(p_organisation_id, 'subscription.seats')) THEN
    RAISE EXCEPTION 'subscription.read required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT m.id, coalesce(u.email::text, m.invited_email), p.first_name, p.surname, m.status,
         coalesce((SELECT jsonb_agg(DISTINCT r.name) FROM public.user_role_assignments a JOIN public.roles r ON r.id = a.role_id
                    WHERE a.membership_id = m.id), '[]'::jsonb),
         pl.slug, pl.name, sa.assigned_at, i.unit_amount_snapshot
  FROM public.organisation_users m
  LEFT JOIN auth.users u ON u.id = m.user_id
  LEFT JOIN public.profiles p ON p.id = m.user_id
  LEFT JOIN public.user_subscription_assignments sa ON sa.organisation_membership_id = m.id AND sa.status = 'active'
  LEFT JOIN public.subscription_plans pl ON pl.id = sa.subscription_plan_id
  LEFT JOIN public.organisation_subscription_items i ON i.id = sa.subscription_item_id
  WHERE m.organisation_id = p_organisation_id AND m.status IN ('active', 'invited', 'suspended')
  ORDER BY lower(coalesce(p.surname, '')), lower(coalesce(p.first_name, '')), lower(coalesce(u.email::text, m.invited_email));
END $$;

REVOKE ALL ON FUNCTION app.list_seat_assignments(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.list_seat_assignments(uuid) TO authenticated;
