-- No seat, no access (docs/seats-and-member-onboarding-plan.md SM3, SM5; slice SM-B).
--
-- In an organisation that enforces packages (every self-serve organisation), an active member without a seat is not a member for anything:
-- RLS, every function and the API refuse them, the same way an unsatisfied two-factor or single sign-on rule does (app.mfa_satisfied, which every
-- membership helper uses). Two exceptions:
--   * someone whose role holds a right that runs the account (app.seat_exempt_permissions(): managing the organisation, members, roles, security,
--     the subscription, seats or billing) stays a member, so an admin without a seat can still give seats and run the account; SM-A already keeps every priced permission from them;
--   * organisations that do not enforce packages (the grandfathered ones) are unchanged.
-- The API answers 403 seat_required (app.seat_blocked_organisations()); the app shows a waiting screen (SM-C).
--
-- seat_requests: when someone becomes an active member without a seat (accepting an invitation with none reserved, joining with a company
-- account, a seat taken away is not counted: the person who did it knows), a row is written at commit and the people who give seats
-- (subscription.seats) are told: "<name> is waiting for a seat". The waiting person can remind them once a day (app.remind_seat_managers).
-- Append-only and frozen; whether someone is still waiting is worked out from their seat, never stored.

-- ---------------------------------------------------------------------------
-- 1. The rule
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.membership_has_seat(p_membership_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_subscription_assignments sa
                  WHERE sa.organisation_membership_id = p_membership_id AND sa.status = 'active'
                    AND sa.effective_from <= now() AND (sa.effective_to IS NULL OR sa.effective_to > now()))
$$;

-- The rights that run the account. Holding one keeps a seatless person a member (they can give seats, manage people and billing); the read-only
-- admin rights (members.read, security.read, subscription.read, invoices.read) do not.
CREATE FUNCTION app.seat_exempt_permissions() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT ARRAY['organisation.manage', 'members.manage', 'roles.manage', 'security.manage', 'subscription.manage', 'subscription.seats',
               'billing_details.manage', 'payment_methods.manage']
$$;

CREATE FUNCTION app.membership_has_admin_right(p_membership_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_role_assignments a JOIN public.role_permissions rp ON rp.role_id = a.role_id
                  WHERE a.membership_id = p_membership_id AND rp.permission_code = ANY (app.seat_exempt_permissions()))
$$;

-- Whether a membership needs a seat it does not have.
CREATE FUNCTION app.membership_waiting_for_seat(p_membership_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT m.status = 'active'
     AND coalesce((SELECT s.entitlements_enforced FROM public.organisation_settings s WHERE s.organisation_id = m.organisation_id), false)
     AND NOT app.membership_has_seat(m.id)
     AND NOT app.membership_has_admin_right(m.id)
    FROM public.organisation_users m WHERE m.id = p_membership_id
$$;

-- For the caller in an organisation: true unless they are an active member waiting for a seat.
CREATE FUNCTION app.seat_satisfied(p_organisation_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT NOT coalesce((SELECT app.membership_waiting_for_seat(m.id) FROM public.organisation_users m
                        WHERE m.organisation_id = p_organisation_id AND m.user_id = auth.uid() AND m.status = 'active'), false)
$$;

-- The membership gate: the 20260318100000_sso_enforcement.sql version (two-factor and single sign-on) and a seat.
CREATE OR REPLACE FUNCTION app.mfa_satisfied(p_organisation_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce((
    SELECT (NOT s.require_mfa OR app.session_aal() = 'aal2' OR (s.sso_trust_idp_mfa AND app.sso_session_for(p_organisation_id)))
       AND (s.sso_mode <> 'required' OR app.session_amr() IS NULL OR app.sso_session_for(p_organisation_id)
            OR (app.session_aal() = 'aal2' AND app.sso_break_glass(p_organisation_id)))
      FROM public.organisation_settings s WHERE s.organisation_id = p_organisation_id), true)
     AND app.seat_satisfied(p_organisation_id)
$$;

-- The caller's organisations that hold them back for want of a seat (after two-factor and single sign-on are met), for the API and /me.
CREATE FUNCTION app.seat_blocked_organisations()
RETURNS TABLE (organisation_id uuid, name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT o.id, o.name
    FROM public.organisation_users m
    JOIN public.organisations o ON o.id = m.organisation_id AND o.status = 'active'
   WHERE m.user_id = auth.uid() AND m.status = 'active'
     AND app.two_factor_satisfied(o.id) AND app.sso_satisfied(o.id)
     AND app.membership_waiting_for_seat(m.id)
   ORDER BY o.name
$$;

-- ---------------------------------------------------------------------------
-- 2. Seat requests: told to the people who give seats
-- ---------------------------------------------------------------------------
CREATE TABLE public.seat_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  membership_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('joined', 'reminder')),
  person_name text NOT NULL,
  summary text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT seat_requests_membership_fkey FOREIGN KEY (membership_id, organisation_id)
    REFERENCES public.organisation_users (id, organisation_id) ON DELETE CASCADE
);
CREATE INDEX seat_requests_membership_idx ON public.seat_requests (membership_id, created_at DESC);
CREATE INDEX seat_requests_org_idx ON public.seat_requests (organisation_id, created_at DESC);
ALTER TABLE public.seat_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY seat_requests_select ON public.seat_requests FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'subscription.seats') OR app.has_permission(organisation_id, 'members.read')
         OR EXISTS (SELECT 1 FROM public.organisation_users m WHERE m.id = membership_id AND m.user_id = (SELECT auth.uid())));
REVOKE ALL ON public.seat_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.seat_requests TO authenticated;
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.seat_requests FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');

CREATE FUNCTION app.seat_requests_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'A seat request is a record and does not change' USING ERRCODE = 'QM009';
END $$;
CREATE TRIGGER seat_requests_frozen BEFORE UPDATE OR DELETE ON public.seat_requests FOR EACH ROW EXECUTE FUNCTION app.seat_requests_frozen();

CREATE FUNCTION app.seat_person_name(p_membership_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(nullif(btrim(concat_ws(' ', p.first_name, p.surname)), ''), u.email::text, 'Someone')
    FROM public.organisation_users m
    LEFT JOIN public.profiles p ON p.id = m.user_id
    LEFT JOIN auth.users u ON u.id = m.user_id
   WHERE m.id = p_membership_id
$$;

-- At commit (so a seat or role given in the same transaction counts): someone who has just become an active member and is waiting for a seat.
CREATE FUNCTION app.seat_request_on_join() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_name text;
BEGIN
  IF NEW.status <> 'active' OR NOT app.membership_waiting_for_seat(NEW.id) THEN RETURN NULL; END IF;
  -- once per stint of membership
  IF EXISTS (SELECT 1 FROM public.seat_requests r WHERE r.membership_id = NEW.id AND r.kind = 'joined'
              AND r.created_at >= coalesce(NEW.joined_at, NEW.created_at) - interval '1 second') THEN
    RETURN NULL;
  END IF;
  v_name := app.seat_person_name(NEW.id);
  INSERT INTO public.seat_requests (organisation_id, membership_id, kind, person_name, summary)
  VALUES (NEW.organisation_id, NEW.id, 'joined', v_name, v_name || ' joined and is waiting for a seat');
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER organisation_users_seat_request
  AFTER INSERT OR UPDATE OF status ON public.organisation_users
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.seat_request_on_join();

-- The waiting person reminds the people who give seats; at most once a day.
CREATE FUNCTION app.remind_seat_managers(p_organisation_id uuid) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_m uuid; v_last timestamptz; v_name text; v_at timestamptz;
BEGIN
  SELECT m.id INTO v_m FROM public.organisation_users m
   WHERE m.organisation_id = p_organisation_id AND m.user_id = auth.uid() AND m.status = 'active';
  IF v_m IS NULL OR NOT app.membership_waiting_for_seat(v_m) THEN
    RAISE EXCEPTION 'You are not waiting for a seat in this organisation' USING ERRCODE = 'QM009';
  END IF;
  SELECT max(r.created_at) INTO v_last FROM public.seat_requests r WHERE r.membership_id = v_m;
  IF v_last IS NOT NULL AND v_last > now() - interval '1 day' THEN
    RAISE EXCEPTION 'They were told on %; you can remind them again a day later', to_char(v_last, 'DD Mon YYYY HH24:MI') USING ERRCODE = 'QM009';
  END IF;
  v_name := app.seat_person_name(v_m);
  INSERT INTO public.seat_requests (organisation_id, membership_id, kind, person_name, summary)
  VALUES (p_organisation_id, v_m, 'reminder', v_name, v_name || ' is still waiting for a seat')
  RETURNING created_at INTO v_at;
  RETURN v_at;
END $$;

-- What the waiting screen shows: who can give seats, and when they were last told.
CREATE FUNCTION app.my_seat_wait(p_organisation_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN m.id IS NULL OR NOT app.membership_waiting_for_seat(m.id) THEN jsonb_build_object('waiting', false)
  ELSE jsonb_build_object(
    'waiting', true,
    'lastToldAt', (SELECT max(r.created_at) FROM public.seat_requests r WHERE r.membership_id = m.id),
    'managers', coalesce((
      SELECT jsonb_agg(DISTINCT app.seat_person_name(om.id))
        FROM public.organisation_users om
        JOIN public.user_role_assignments a ON a.membership_id = om.id
        JOIN public.role_permissions rp ON rp.role_id = a.role_id AND rp.permission_code = 'subscription.seats'
       WHERE om.organisation_id = p_organisation_id AND om.status = 'active' AND om.id <> m.id), '[]'::jsonb))
  END
    FROM (SELECT (SELECT m2.id FROM public.organisation_users m2
                   WHERE m2.organisation_id = p_organisation_id AND m2.user_id = auth.uid() AND m2.status = 'active') AS id) m
$$;

INSERT INTO public.notification_event_types
  (key, entity_type, action, group_name, entity_label, description, permission_code, default_on, default_permission_code, label_fields, display_order, own_record, email_default)
VALUES
  ('seat_requests.created', 'seat_requests', 'created', 'Account', 'Seat', 'Someone is waiting for a seat',
   'subscription.seats', true, NULL, ARRAY['summary'], 1, false, true);

REVOKE ALL ON FUNCTION app.seat_exempt_permissions(), app.membership_has_seat(uuid), app.membership_has_admin_right(uuid), app.membership_waiting_for_seat(uuid),
  app.seat_satisfied(uuid), app.seat_blocked_organisations(), app.seat_requests_frozen(), app.seat_person_name(uuid),
  app.seat_request_on_join(), app.remind_seat_managers(uuid), app.my_seat_wait(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.seat_satisfied(uuid), app.seat_blocked_organisations(), app.remind_seat_managers(uuid), app.my_seat_wait(uuid)
  TO authenticated;
