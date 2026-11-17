-- Member onboarding (docs/seats-and-member-onboarding-plan.md SM6, SM7; slice SM-C).
--
-- Someone who joins an organisation (accepting an invitation, or joining with their company account) sets up their own profile at /welcome; they
-- are not setting up the organisation, which stays the founder's wizard (/setup). Progress is kept per membership in member_onboarding:
--   about          — their name and job title
--   notifications  — they have seen how Fortress tells them things (and may change it)
--   completed      — done; without a seat the last step is the waiting screen (SM4) until someone gives them one.
-- A row is made when a membership becomes active by joining: an invitation accepted (invited → active) or an active membership added to an
-- organisation that already had members (joining with a company account). The founder (the organisation's first member) never gets one, and
-- nobody already a member is sent through it (SM7): no row = nothing to do.
-- The person reads and moves their own row through functions that do not ask for membership, because someone waiting for a seat is not a member yet.

CREATE TABLE public.member_onboarding (
  membership_id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  about_done_at timestamptz,
  notifications_done_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT member_onboarding_membership_fkey FOREIGN KEY (membership_id, organisation_id)
    REFERENCES public.organisation_users (id, organisation_id) ON DELETE CASCADE
);
CREATE INDEX member_onboarding_org_idx ON public.member_onboarding (organisation_id);
ALTER TABLE public.member_onboarding ENABLE ROW LEVEL SECURITY;
CREATE POLICY member_onboarding_select ON public.member_onboarding FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'members.read')
         OR EXISTS (SELECT 1 FROM public.organisation_users m WHERE m.id = membership_id AND m.user_id = (SELECT auth.uid())));
REVOKE ALL ON public.member_onboarding FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.member_onboarding TO authenticated;

-- A membership that has just been joined gets a welcome to go through.
CREATE FUNCTION app.member_onboarding_on_join() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.status <> 'active' OR NEW.user_id IS NULL THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM 'invited' THEN RETURN NULL; END IF;
  -- the founder: the organisation's first member
  IF TG_OP = 'INSERT' AND NOT EXISTS (SELECT 1 FROM public.organisation_users o WHERE o.organisation_id = NEW.organisation_id AND o.id <> NEW.id) THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.member_onboarding (membership_id, organisation_id) VALUES (NEW.id, NEW.organisation_id) ON CONFLICT (membership_id) DO NOTHING;
  RETURN NULL;
END $$;
CREATE TRIGGER organisation_users_member_onboarding AFTER INSERT OR UPDATE OF status ON public.organisation_users
  FOR EACH ROW EXECUTE FUNCTION app.member_onboarding_on_join();

-- The caller's welcomes still to finish, in any organisation (member or waiting for a seat).
CREATE FUNCTION app.my_pending_welcomes()
RETURNS TABLE (organisation_id uuid, name text, about_done boolean, notifications_done boolean, waiting_for_seat boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT o.id, o.name, w.about_done_at IS NOT NULL, w.notifications_done_at IS NOT NULL, coalesce(app.membership_waiting_for_seat(m.id), false)
    FROM public.member_onboarding w
    JOIN public.organisation_users m ON m.id = w.membership_id AND m.user_id = auth.uid() AND m.status = 'active'
    JOIN public.organisations o ON o.id = m.organisation_id AND o.status = 'active'
   WHERE w.completed_at IS NULL
   ORDER BY w.created_at, o.name
$$;

-- Moves the caller's own welcome in an organisation on: 'about', 'notifications' or 'done'.
CREATE FUNCTION app.set_member_onboarding_step(p_organisation_id uuid, p_step text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_m uuid;
BEGIN
  IF p_step NOT IN ('about', 'notifications', 'done') THEN
    RAISE EXCEPTION 'Unknown step %', p_step USING ERRCODE = '22023';
  END IF;
  SELECT m.id INTO v_m FROM public.organisation_users m
   WHERE m.organisation_id = p_organisation_id AND m.user_id = auth.uid() AND m.status = 'active';
  IF v_m IS NULL THEN RAISE EXCEPTION 'You are not a member of this organisation' USING ERRCODE = 'P0002'; END IF;
  UPDATE public.member_onboarding SET
    about_done_at = CASE WHEN p_step = 'about' THEN coalesce(about_done_at, now()) ELSE about_done_at END,
    notifications_done_at = CASE WHEN p_step = 'notifications' THEN coalesce(notifications_done_at, now()) ELSE notifications_done_at END,
    completed_at = CASE WHEN p_step = 'done' THEN coalesce(completed_at, now()) ELSE completed_at END
   WHERE membership_id = v_m;
END $$;

REVOKE ALL ON FUNCTION app.member_onboarding_on_join(), app.my_pending_welcomes(), app.set_member_onboarding_step(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.my_pending_welcomes(), app.set_member_onboarding_step(uuid, text) TO authenticated;
