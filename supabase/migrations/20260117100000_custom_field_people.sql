-- Custom fields CF3: the people a "person" custom field can name. Every member who may fill in a record's custom fields must be able to pick
-- a colleague, but row security on organisation_users lets someone without members.read see only their own membership. This function returns
-- only the active members' user id and display name, to members of that organisation. Read-only; changes no data.

CREATE FUNCTION app.custom_field_people(p_org uuid) RETURNS TABLE (user_id uuid, name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT app.is_member(p_org) THEN
    RAISE EXCEPTION 'Organisation not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN QUERY
    SELECT m.user_id, coalesce(nullif(btrim(concat_ws(' ', p.first_name, p.surname)), ''), m.invited_email, 'Unknown')::text
    FROM public.organisation_users m
    LEFT JOIN public.profiles p ON p.id = m.user_id
    WHERE m.organisation_id = p_org AND m.status = 'active' AND m.user_id IS NOT NULL
    ORDER BY 2
    LIMIT 1000;
END $$;

REVOKE ALL ON FUNCTION app.custom_field_people(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.custom_field_people(uuid) TO authenticated;
