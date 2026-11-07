-- ON3a (docs/onboarding-plan.md §13): Stripe as the source of truth for money and quantities.
--
--  * The API verifies Stripe's signature, re-fetches the subscription/invoice from Stripe and hands the snapshot to the app.stripe_* functions below. Those functions are executable ONLY by the
--    qms_api login (never by `authenticated` or `anon`), so no signed-in person can write billing state. Applying is idempotent, serialised per organisation and ignores a snapshot older than the
--    one already stored (provider_synced_at), so duplicate, replayed and out-of-order events and the Checkout confirm racing the webhook are all safe.
--  * stripe_events records every event id once (status, attempts, error): idempotency and webhook health for the operator.
--  * billing_customers (one Stripe customer per organisation) and stripe_checkout_sessions (who started a checkout, with which seats) are tenant tables written only by those functions.
--  * Controller invariant: while a billing_required organisation has a valid subscription, some active Owner always holds a Controller seat (deferred constraint triggers, QM009).
--  * app.set_subscription_seats (manual provider) is refused for Stripe-billed and billing_required organisations, which closes the self-grant gap left open in ON2.

ALTER TABLE public.subscription_prices ADD COLUMN provider_price_id text CHECK (provider_price_id IS NULL OR provider_price_id ~ '^price_[A-Za-z0-9_]{4,100}$');
CREATE UNIQUE INDEX subscription_prices_provider_key ON public.subscription_prices (provider_price_id) WHERE provider_price_id IS NOT NULL;
ALTER TABLE public.organisation_subscriptions ADD COLUMN provider_synced_at timestamptz;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE public.stripe_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id text NOT NULL UNIQUE CHECK (event_id ~ '^evt_[A-Za-z0-9_]{4,100}$'),
  event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 100),
  organisation_id uuid REFERENCES public.organisations (id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processed', 'failed', 'ignored')),
  attempts integer NOT NULL DEFAULT 1,
  error text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX stripe_events_received_idx ON public.stripe_events (received_at DESC);
ALTER TABLE public.stripe_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.stripe_events FROM anon, authenticated;
GRANT SELECT ON public.stripe_events TO authenticated;
CREATE POLICY stripe_events_select ON public.stripe_events FOR SELECT TO authenticated USING (app.is_platform_admin());

CREATE TABLE public.billing_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL UNIQUE REFERENCES public.organisations (id) ON DELETE CASCADE,
  provider_customer_id text NOT NULL UNIQUE CHECK (provider_customer_id ~ '^cus_[A-Za-z0-9_]{4,100}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL
);

CREATE TABLE public.stripe_checkout_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  provider_session_id text NOT NULL UNIQUE CHECK (provider_session_id ~ '^cs_[A-Za-z0-9_]{4,200}$'),
  membership_id uuid NOT NULL,
  billing_interval text NOT NULL CHECK (billing_interval IN ('month', 'year')),
  seats jsonb NOT NULL CHECK (jsonb_typeof(seats) = 'object'),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'expired')),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT stripe_checkout_sessions_membership_fkey FOREIGN KEY (membership_id, organisation_id)
    REFERENCES public.organisation_users (id, organisation_id) ON DELETE CASCADE
);
CREATE INDEX stripe_checkout_sessions_org_idx ON public.stripe_checkout_sessions (organisation_id, created_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['billing_customers', 'stripe_checkout_sessions'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION app.stamp_created()', t || '_stamp', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.touch_updated()', t || '_touch', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change()', t || '_org_immutable', t);
    EXECUTE format('CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION audit.record_change(%L)', t, 'organisation_id');
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (app.has_permission(organisation_id, %L))', t || '_select', t, 'subscription.read');
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- The Controller rule, in pieces (organisation_subscription_valid is now built from them; behaviour unchanged)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.organisation_subscription_status_ok(p_organisation_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
           SELECT 1 FROM public.organisation_subscriptions s
            WHERE s.organisation_id = p_organisation_id
              AND (s.status IN ('active', 'trialing')
                   OR (s.status = 'past_due' AND coalesce(s.past_due_since, now())
                         + make_interval(days => coalesce((SELECT o.grace_period_days FROM public.organisation_settings o WHERE o.organisation_id = p_organisation_id), 7)) > now())
                   OR (s.status = 'cancelled' AND s.current_period_end > now())))
$$;

CREATE FUNCTION app.organisation_has_owner_controller(p_organisation_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
           SELECT 1 FROM public.user_subscription_assignments a
             JOIN public.subscription_plans p ON p.id = a.subscription_plan_id AND p.slug = 'controller'
             JOIN public.organisation_users m ON m.id = a.organisation_membership_id AND m.status = 'active'
             JOIN public.user_role_assignments ura ON ura.membership_id = m.id
             JOIN public.roles r ON r.id = ura.role_id AND r.key = 'owner'
            WHERE a.organisation_id = p_organisation_id AND a.status = 'active'
              AND a.effective_from <= now() AND (a.effective_to IS NULL OR a.effective_to > now()))
$$;

CREATE OR REPLACE FUNCTION app.organisation_subscription_valid(p_organisation_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app.organisation_subscription_status_ok(p_organisation_id) AND app.organisation_has_owner_controller(p_organisation_id)
$$;

-- While a billing_required organisation has a valid subscription, an active Owner must hold a Controller seat. Checked at commit, so a change that moves the seat in the same transaction is fine.
CREATE FUNCTION app.assert_owner_controller_seat() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid := coalesce(NEW.organisation_id, OLD.organisation_id);
BEGIN
  IF coalesce((SELECT o.billing_required FROM public.organisations o WHERE o.id = v_org), false)
     AND app.organisation_subscription_status_ok(v_org)
     AND NOT app.organisation_has_owner_controller(v_org) THEN
    RAISE EXCEPTION 'An owner must keep a Controller seat while the subscription is active. Give another owner a Controller seat first.' USING ERRCODE = 'QM009';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER user_subscription_assignments_owner_seat AFTER UPDATE OR DELETE ON public.user_subscription_assignments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.assert_owner_controller_seat();
CREATE CONSTRAINT TRIGGER user_role_assignments_owner_seat AFTER UPDATE OR DELETE ON public.user_role_assignments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.assert_owner_controller_seat();
CREATE CONSTRAINT TRIGGER organisation_users_owner_seat AFTER UPDATE OF status ON public.organisation_users
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.assert_owner_controller_seat();

-- ---------------------------------------------------------------------------
-- Manual seats are for manual organisations only
-- ---------------------------------------------------------------------------
-- Same body as before (20251110100000) with one new refusal at the top: seats of a Stripe-billed or billing_required organisation are changed through Stripe.
CREATE OR REPLACE FUNCTION app.set_subscription_seats(p_organisation_id uuid, p_plan_slug text, p_quantity integer, p_interval text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_sub public.organisation_subscriptions%ROWTYPE;
  v_plan public.subscription_plans%ROWTYPE;
  v_price public.subscription_prices%ROWTYPE;
  v_item public.organisation_subscription_items%ROWTYPE;
  v_used integer;
  v_old integer := 0;
BEGIN
  IF NOT app.has_permission(p_organisation_id, 'subscription.manage') THEN
    RAISE EXCEPTION 'Not allowed to manage the subscription' USING ERRCODE = '42501';
  END IF;
  IF coalesce((SELECT o.billing_required FROM public.organisations o WHERE o.id = p_organisation_id), false)
     OR EXISTS (SELECT 1 FROM public.organisation_subscriptions s WHERE s.organisation_id = p_organisation_id AND s.billing_provider = 'stripe') THEN
    RAISE EXCEPTION 'Seats for this organisation are bought and changed through the payment provider.' USING ERRCODE = 'QM009';
  END IF;
  IF p_quantity IS NULL OR p_quantity < 0 OR p_quantity > 10000 THEN
    RAISE EXCEPTION 'Seat quantity must be between 0 and 10000.' USING ERRCODE = 'QM009';
  END IF;
  SELECT * INTO v_plan FROM public.subscription_plans WHERE slug = p_plan_slug AND status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown subscription package.' USING ERRCODE = 'QM009'; END IF;

  SELECT * INTO v_sub FROM public.organisation_subscriptions WHERE organisation_id = p_organisation_id FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.organisation_subscriptions (organisation_id, billing_interval, current_period_end)
    VALUES (p_organisation_id, coalesce(p_interval, 'month'),
            now() + CASE WHEN coalesce(p_interval, 'month') = 'year' THEN interval '1 year' ELSE interval '1 month' END)
    RETURNING * INTO v_sub;
    PERFORM app.log_subscription_event(p_organisation_id, 'subscription_created', NULL, jsonb_build_object('interval', v_sub.billing_interval));
  ELSIF v_sub.status IN ('cancelled', 'incomplete') THEN
    RAISE EXCEPTION 'The subscription is %; it cannot be changed.', v_sub.status USING ERRCODE = 'QM009';
  END IF;

  SELECT * INTO v_price FROM public.subscription_prices
   WHERE subscription_plan_id = v_plan.id AND billing_interval = v_sub.billing_interval AND currency = v_sub.currency
     AND active AND effective_from <= now() AND (effective_to IS NULL OR effective_to > now());
  IF NOT FOUND THEN RAISE EXCEPTION 'No current price for this package.' USING ERRCODE = 'QM009'; END IF;

  SELECT * INTO v_item FROM public.organisation_subscription_items
   WHERE organisation_subscription_id = v_sub.id AND subscription_plan_id = v_plan.id FOR UPDATE;
  IF FOUND THEN
    v_old := v_item.quantity;
    SELECT count(*) INTO v_used FROM public.user_subscription_assignments WHERE subscription_item_id = v_item.id AND status = 'active';
    IF p_quantity < v_used THEN
      RAISE EXCEPTION 'Cannot reduce below the % seats already assigned. Remove assignments first.', v_used USING ERRCODE = 'QM009';
    END IF;
    UPDATE public.organisation_subscription_items
       SET quantity = p_quantity, subscription_price_id = v_price.id, unit_amount_snapshot = v_price.unit_amount
     WHERE id = v_item.id;
  ELSE
    INSERT INTO public.organisation_subscription_items
      (organisation_id, organisation_subscription_id, subscription_plan_id, subscription_price_id, quantity, unit_amount_snapshot, currency)
    VALUES (p_organisation_id, v_sub.id, v_plan.id, v_price.id, p_quantity, v_price.unit_amount, v_sub.currency)
    RETURNING * INTO v_item;
  END IF;

  IF p_quantity <> v_old THEN
    PERFORM app.log_subscription_event(p_organisation_id, CASE WHEN p_quantity > v_old THEN 'seats_added' ELSE 'seats_removed' END, NULL,
      jsonb_build_object('plan', v_plan.slug, 'from', v_old, 'to', p_quantity, 'unitAmount', v_price.unit_amount));
  END IF;
  RETURN v_item.id;
END $$;

-- ---------------------------------------------------------------------------
-- For the signed-in person (the API calls these as them, before it talks to Stripe)
-- ---------------------------------------------------------------------------
-- Problems with buying or changing to these seats ({"controller": 3, "contributor": 0, ...}); an empty array means go ahead. Needs subscription.manage.
CREATE FUNCTION app.check_seat_change(p_organisation_id uuid, p_seats jsonb) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_problems text[] := ARRAY[]::text[]; k text; v integer; v_plan public.subscription_plans%ROWTYPE; v_used integer; v_controller integer;
BEGIN
  IF NOT app.has_permission(p_organisation_id, 'subscription.manage') THEN
    RAISE EXCEPTION 'Not allowed to manage the subscription' USING ERRCODE = '42501';
  END IF;
  IF p_seats IS NULL OR jsonb_typeof(p_seats) <> 'object' THEN
    RAISE EXCEPTION 'Seats must be an object of package and quantity' USING ERRCODE = 'QM009';
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_seats) LOOP
    SELECT * INTO v_plan FROM public.subscription_plans WHERE slug = k AND status = 'active';
    IF NOT FOUND THEN v_problems := array_append(v_problems, format('Unknown package %s.', k)); CONTINUE; END IF;
    IF jsonb_typeof(p_seats -> k) <> 'number' OR (p_seats ->> k) !~ '^[0-9]{1,5}$' THEN
      v_problems := array_append(v_problems, format('%s seats must be a whole number.', v_plan.name)); CONTINUE;
    END IF;
    v := (p_seats ->> k)::integer;
    SELECT count(*) INTO v_used FROM public.user_subscription_assignments a
     WHERE a.organisation_id = p_organisation_id AND a.subscription_plan_id = v_plan.id AND a.status = 'active';
    IF v < v_used THEN
      v_problems := array_append(v_problems, format('%s seats cannot go below the %s in use. Remove the assignments first.', v_plan.name, v_used));
    END IF;
  END LOOP;
  v_controller := coalesce((p_seats ->> 'controller')::integer, 0);
  IF p_seats ? 'controller' AND v_controller < 1 THEN
    v_problems := array_append(v_problems, 'At least one Controller seat is needed: an owner must hold one.');
  END IF;
  RETURN v_problems;
END $$;

-- ---------------------------------------------------------------------------
-- System functions: callable only by the API login (webhook, Checkout confirm, reconcile)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.stripe_status(p_status text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE p_status
    WHEN 'trialing' THEN 'trialing' WHEN 'active' THEN 'active' WHEN 'past_due' THEN 'past_due' WHEN 'unpaid' THEN 'unpaid'
    WHEN 'paused' THEN 'paused' WHEN 'incomplete' THEN 'incomplete'
    WHEN 'canceled' THEN 'cancelled' WHEN 'incomplete_expired' THEN 'cancelled' ELSE NULL END
$$;

-- Records that an event arrived. 'new' (first time), 'retry' (an earlier attempt failed or never finished) or 'duplicate' (already processed or ignored).
CREATE FUNCTION app.stripe_record_event(p_event_id text, p_event_type text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v public.stripe_events%ROWTYPE;
BEGIN
  INSERT INTO public.stripe_events (event_id, event_type) VALUES (p_event_id, p_event_type) ON CONFLICT (event_id) DO NOTHING;
  IF FOUND THEN RETURN 'new'; END IF;
  SELECT * INTO v FROM public.stripe_events WHERE event_id = p_event_id FOR UPDATE;
  IF v.status IN ('processed', 'ignored') THEN RETURN 'duplicate'; END IF;
  UPDATE public.stripe_events SET attempts = attempts + 1, status = 'received', error = NULL WHERE id = v.id;
  RETURN 'retry';
END $$;

CREATE FUNCTION app.stripe_finish_event(p_event_id text, p_status text, p_error text DEFAULT NULL, p_organisation_id uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_status NOT IN ('processed', 'failed', 'ignored') THEN RAISE EXCEPTION 'Unknown event status' USING ERRCODE = 'QM014'; END IF;
  UPDATE public.stripe_events
     SET status = p_status, error = left(p_error, 1000), processed_at = now(), organisation_id = coalesce(p_organisation_id, organisation_id)
   WHERE event_id = p_event_id;
END $$;

-- Which organisation a Stripe customer or subscription belongs to (for events that do not carry our metadata).
CREATE FUNCTION app.stripe_organisation_for(p_customer_id text, p_subscription_id text DEFAULT NULL) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(
    (SELECT s.organisation_id FROM public.organisation_subscriptions s WHERE s.provider_subscription_id = p_subscription_id AND p_subscription_id IS NOT NULL),
    (SELECT c.organisation_id FROM public.billing_customers c WHERE c.provider_customer_id = p_customer_id AND p_customer_id IS NOT NULL))
$$;

CREATE FUNCTION app.stripe_customer_for(p_organisation_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT c.provider_customer_id FROM public.billing_customers c WHERE c.organisation_id = p_organisation_id
$$;

CREATE FUNCTION app.stripe_set_customer(p_organisation_id uuid, p_customer_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.billing_customers (organisation_id, provider_customer_id) VALUES (p_organisation_id, p_customer_id)
  ON CONFLICT (organisation_id) DO NOTHING;
  IF (SELECT c.provider_customer_id FROM public.billing_customers c WHERE c.organisation_id = p_organisation_id) <> p_customer_id THEN
    RAISE EXCEPTION 'This organisation already has a different payment customer.' USING ERRCODE = 'QM009';
  END IF;
END $$;

-- The Stripe price id for a package and interval (GBP, current), or NULL when prices have not been set up in Stripe yet.
CREATE FUNCTION app.stripe_price_for(p_plan_slug text, p_interval text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT pr.provider_price_id FROM public.subscription_prices pr JOIN public.subscription_plans pl ON pl.id = pr.subscription_plan_id
   WHERE pl.slug = p_plan_slug AND pr.billing_interval = p_interval AND pr.currency = 'GBP' AND pr.active AND pr.effective_to IS NULL
$$;

-- Records a Checkout the person started. Only an active owner may start one (they take the first Controller seat). Refused for an organisation that already has a live subscription.
CREATE FUNCTION app.stripe_start_checkout(p_organisation_id uuid, p_user_id uuid, p_session_id text, p_interval text, p_seats jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_member uuid; v_sub public.organisation_subscriptions%ROWTYPE; v_id uuid;
BEGIN
  SELECT m.id INTO v_member FROM public.organisation_users m
   WHERE m.organisation_id = p_organisation_id AND m.user_id = p_user_id AND m.status = 'active'
     AND EXISTS (SELECT 1 FROM public.user_role_assignments a JOIN public.roles r ON r.id = a.role_id AND r.key = 'owner' WHERE a.membership_id = m.id);
  IF v_member IS NULL THEN
    RAISE EXCEPTION 'Only an owner can start the subscription: they hold the first Controller seat.' USING ERRCODE = 'QM009';
  END IF;
  SELECT * INTO v_sub FROM public.organisation_subscriptions WHERE organisation_id = p_organisation_id;
  IF FOUND AND (v_sub.billing_provider = 'manual' OR v_sub.status NOT IN ('cancelled', 'incomplete')) THEN
    RAISE EXCEPTION 'This organisation already has a subscription. Change it from Subscription & billing.' USING ERRCODE = 'QM009';
  END IF;
  INSERT INTO public.stripe_checkout_sessions (organisation_id, provider_session_id, membership_id, billing_interval, seats)
  VALUES (p_organisation_id, p_session_id, v_member, p_interval, p_seats) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Who started a Checkout (for confirming that the person asking is the person who started it).
CREATE FUNCTION app.stripe_checkout_owner(p_organisation_id uuid, p_session_id text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT m.user_id FROM public.stripe_checkout_sessions c JOIN public.organisation_users m ON m.id = c.membership_id
   WHERE c.organisation_id = p_organisation_id AND c.provider_session_id = p_session_id
$$;

-- Applies a subscription as Stripe reports it. p_snapshot:
--   { id, customerId, status, interval, currency, currentPeriodStart, currentPeriodEnd, trialStart, trialEnd, cancelAtPeriodEnd, canceledAt, items: [{ priceId, quantity }] }
-- p_fetched_at is when the API read it from Stripe: an older snapshot than the stored one is ignored. Returns { applied, reason?, status }.
CREATE FUNCTION app.stripe_apply_subscription(p_organisation_id uuid, p_snapshot jsonb, p_fetched_at timestamptz, p_checkout_session_id text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_sub public.organisation_subscriptions%ROWTYPE; v_status text; v_interval text; v_currency text; v_new boolean := false;
  v_past_due_since timestamptz; it jsonb; v_price public.subscription_prices%ROWTYPE; v_item public.organisation_subscription_items%ROWTYPE;
  v_qty integer; v_old integer; v_used integer; v_seen uuid[] := ARRAY[]::uuid[];
  v_item_id uuid; v_member uuid; v_cancel boolean; v_exists boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organisations WHERE id = p_organisation_id) THEN
    RAISE EXCEPTION 'Unknown organisation' USING ERRCODE = 'QM014';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('stripe:' || p_organisation_id::text));

  v_status := app.stripe_status(p_snapshot ->> 'status');
  IF v_status IS NULL THEN RAISE EXCEPTION 'Unknown subscription status' USING ERRCODE = 'QM014'; END IF;
  v_interval := p_snapshot ->> 'interval';
  IF v_interval NOT IN ('month', 'year') THEN RAISE EXCEPTION 'Unknown billing interval' USING ERRCODE = 'QM014'; END IF;
  v_currency := upper(coalesce(p_snapshot ->> 'currency', 'GBP'));
  v_cancel := coalesce((p_snapshot ->> 'cancelAtPeriodEnd')::boolean, false);

  SELECT * INTO v_sub FROM public.organisation_subscriptions WHERE organisation_id = p_organisation_id FOR UPDATE;
  v_exists := FOUND;
  IF v_exists THEN
    IF v_sub.billing_provider = 'stripe' AND v_sub.provider_subscription_id = p_snapshot ->> 'id'
       AND v_sub.provider_synced_at IS NOT NULL AND v_sub.provider_synced_at > p_fetched_at THEN
      RETURN jsonb_build_object('applied', false, 'reason', 'stale', 'status', v_sub.status);
    END IF;
    IF v_sub.billing_provider = 'manual' OR (v_sub.provider_subscription_id IS DISTINCT FROM p_snapshot ->> 'id' AND v_sub.status NOT IN ('cancelled', 'incomplete')) THEN
      RAISE EXCEPTION 'This organisation already has a different subscription.' USING ERRCODE = 'QM009';
    END IF;
  END IF;

  PERFORM app.stripe_set_customer(p_organisation_id, p_snapshot ->> 'customerId');

  v_past_due_since := CASE WHEN v_status = 'past_due' THEN coalesce(CASE WHEN v_sub.status = 'past_due' THEN v_sub.past_due_since END, p_fetched_at) END;
  IF NOT v_exists THEN
    v_new := true;
    INSERT INTO public.organisation_subscriptions (organisation_id, billing_provider, provider_customer_id, provider_subscription_id, status, billing_interval, currency,
      current_period_start, current_period_end, trial_start, trial_end, past_due_since, cancel_at_period_end, cancelled_at, provider_synced_at)
    VALUES (p_organisation_id, 'stripe', p_snapshot ->> 'customerId', p_snapshot ->> 'id', v_status, v_interval, v_currency,
      (p_snapshot ->> 'currentPeriodStart')::timestamptz, (p_snapshot ->> 'currentPeriodEnd')::timestamptz,
      (p_snapshot ->> 'trialStart')::timestamptz, (p_snapshot ->> 'trialEnd')::timestamptz, v_past_due_since, v_cancel,
      (p_snapshot ->> 'canceledAt')::timestamptz, p_fetched_at)
    RETURNING * INTO v_sub;
    PERFORM app.log_subscription_event(p_organisation_id, 'subscription_created', NULL, jsonb_build_object('interval', v_interval, 'provider', 'stripe', 'status', v_status));
  ELSE
    IF v_status = 'past_due' AND v_sub.status <> 'past_due' THEN
      PERFORM app.log_subscription_event(p_organisation_id, 'payment_failed', NULL, jsonb_build_object('status', v_status));
    END IF;
    IF v_cancel AND NOT v_sub.cancel_at_period_end THEN
      PERFORM app.log_subscription_event(p_organisation_id, 'cancellation_requested', NULL, jsonb_build_object('periodEnd', p_snapshot ->> 'currentPeriodEnd'));
    END IF;
    IF v_interval <> v_sub.billing_interval THEN
      PERFORM app.log_subscription_event(p_organisation_id, 'billing_interval_changed', NULL, jsonb_build_object('from', v_sub.billing_interval, 'to', v_interval));
    END IF;
    UPDATE public.organisation_subscriptions SET
      billing_provider = 'stripe', provider_customer_id = p_snapshot ->> 'customerId', provider_subscription_id = p_snapshot ->> 'id', status = v_status,
      billing_interval = v_interval, currency = v_currency,
      current_period_start = (p_snapshot ->> 'currentPeriodStart')::timestamptz, current_period_end = (p_snapshot ->> 'currentPeriodEnd')::timestamptz,
      trial_start = (p_snapshot ->> 'trialStart')::timestamptz, trial_end = (p_snapshot ->> 'trialEnd')::timestamptz,
      past_due_since = v_past_due_since, cancel_at_period_end = v_cancel, cancelled_at = (p_snapshot ->> 'canceledAt')::timestamptz, provider_synced_at = p_fetched_at
    WHERE id = v_sub.id RETURNING * INTO v_sub;
  END IF;

  -- Seats: exactly what Stripe says. A package missing from the snapshot goes to 0; nothing is unassigned automatically.
  FOR it IN SELECT * FROM jsonb_array_elements(coalesce(p_snapshot -> 'items', '[]'::jsonb)) LOOP
    SELECT * INTO v_price FROM public.subscription_prices WHERE provider_price_id = it ->> 'priceId';
    IF NOT FOUND THEN RAISE EXCEPTION 'Unknown Stripe price %', it ->> 'priceId' USING ERRCODE = 'QM014'; END IF;
    v_qty := coalesce((it ->> 'quantity')::integer, 0);
    SELECT * INTO v_item FROM public.organisation_subscription_items WHERE organisation_subscription_id = v_sub.id AND subscription_plan_id = v_price.subscription_plan_id FOR UPDATE;
    IF FOUND THEN
      v_old := v_item.quantity;
      UPDATE public.organisation_subscription_items SET quantity = v_qty, subscription_price_id = v_price.id, unit_amount_snapshot = v_price.unit_amount, currency = v_price.currency WHERE id = v_item.id;
      v_item_id := v_item.id;
    ELSE
      v_old := 0;
      INSERT INTO public.organisation_subscription_items (organisation_id, organisation_subscription_id, subscription_plan_id, subscription_price_id, quantity, unit_amount_snapshot, currency)
      VALUES (p_organisation_id, v_sub.id, v_price.subscription_plan_id, v_price.id, v_qty, v_price.unit_amount, v_price.currency) RETURNING id INTO v_item_id;
    END IF;
    v_seen := array_append(v_seen, v_item_id);
    IF v_qty <> v_old THEN
      PERFORM app.log_subscription_event(p_organisation_id, CASE WHEN v_qty > v_old THEN 'seats_added' ELSE 'seats_removed' END, NULL,
        jsonb_build_object('plan', (SELECT slug FROM public.subscription_plans WHERE id = v_price.subscription_plan_id), 'from', v_old, 'to', v_qty, 'source', 'stripe'));
    END IF;
    SELECT count(*) INTO v_used FROM public.user_subscription_assignments WHERE subscription_item_id = v_item_id AND status = 'active';
    IF v_qty < v_used THEN
      PERFORM app.log_subscription_event(p_organisation_id, 'admin_override', NULL, jsonb_build_object('overAssigned', v_used - v_qty,
        'plan', (SELECT slug FROM public.subscription_plans WHERE id = v_price.subscription_plan_id)));
    END IF;
  END LOOP;
  UPDATE public.organisation_subscription_items SET quantity = 0
   WHERE organisation_subscription_id = v_sub.id AND quantity <> 0 AND NOT (id = ANY (v_seen));

  -- The first Controller seat goes to an owner: whoever started the latest Checkout (if still an active owner), else the longest-standing active owner.
  IF v_status IN ('trialing', 'active', 'past_due') AND NOT app.organisation_has_owner_controller(p_organisation_id) THEN
    SELECT i.id INTO v_item_id FROM public.organisation_subscription_items i JOIN public.subscription_plans pl ON pl.id = i.subscription_plan_id AND pl.slug = 'controller'
     WHERE i.organisation_subscription_id = v_sub.id AND i.quantity > (SELECT count(*) FROM public.user_subscription_assignments a WHERE a.subscription_item_id = i.id AND a.status = 'active');
    IF v_item_id IS NOT NULL THEN
      SELECT m.id INTO v_member FROM public.organisation_users m
       WHERE m.organisation_id = p_organisation_id AND m.status = 'active'
         AND EXISTS (SELECT 1 FROM public.user_role_assignments a JOIN public.roles r ON r.id = a.role_id AND r.key = 'owner' WHERE a.membership_id = m.id)
       ORDER BY (m.id = (SELECT c.membership_id FROM public.stripe_checkout_sessions c WHERE c.organisation_id = p_organisation_id ORDER BY c.created_at DESC LIMIT 1)) DESC, m.created_at, m.id
       LIMIT 1;
      IF v_member IS NOT NULL THEN
        -- Their current package (if any) is replaced by the Controller seat.
        UPDATE public.user_subscription_assignments SET status = 'ended', effective_to = now() WHERE organisation_membership_id = v_member AND status = 'active';
        INSERT INTO public.user_subscription_assignments (organisation_id, organisation_membership_id, subscription_plan_id, subscription_item_id)
        SELECT p_organisation_id, v_member, i.subscription_plan_id, i.id FROM public.organisation_subscription_items i WHERE i.id = v_item_id;
        PERFORM app.log_subscription_event(p_organisation_id, 'package_assigned', v_member, jsonb_build_object('plan', 'controller', 'source', 'stripe'));
      END IF;
    END IF;
  END IF;

  IF p_checkout_session_id IS NOT NULL THEN
    UPDATE public.stripe_checkout_sessions SET status = 'completed', completed_at = coalesce(completed_at, now())
     WHERE organisation_id = p_organisation_id AND provider_session_id = p_checkout_session_id;
  END IF;
  RETURN jsonb_build_object('applied', true, 'new', v_new, 'status', v_sub.status);
END $$;

-- Applies an invoice as Stripe reports it. p_invoice:
--   { id, number, status, currency, subtotal, tax, total, periodStart, periodEnd, created, dueDate, paidAt, pdfUrl, paymentIntentId, paymentStatus: succeeded|failed|pending|refunded }
CREATE FUNCTION app.stripe_apply_invoice(p_organisation_id uuid, p_invoice jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_status text; v_id uuid; v_pay text := p_invoice ->> 'paymentStatus';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organisations WHERE id = p_organisation_id) THEN
    RAISE EXCEPTION 'Unknown organisation' USING ERRCODE = 'QM014';
  END IF;
  v_status := CASE p_invoice ->> 'status' WHEN 'draft' THEN 'draft' WHEN 'open' THEN 'open' WHEN 'paid' THEN 'paid' WHEN 'void' THEN 'void' WHEN 'uncollectible' THEN 'uncollectible' END;
  IF v_status IS NULL THEN RAISE EXCEPTION 'Unknown invoice status' USING ERRCODE = 'QM014'; END IF;
  INSERT INTO public.billing_invoices (organisation_id, provider_invoice_id, invoice_number, currency, subtotal, tax_amount, total_amount, status, period_start, period_end,
                                       invoice_date, due_date, paid_at, invoice_pdf_url)
  VALUES (p_organisation_id, p_invoice ->> 'id', p_invoice ->> 'number', upper(coalesce(p_invoice ->> 'currency', 'GBP')),
          (p_invoice ->> 'subtotal')::bigint, (p_invoice ->> 'tax')::bigint, (p_invoice ->> 'total')::bigint, v_status,
          (p_invoice ->> 'periodStart')::timestamptz, (p_invoice ->> 'periodEnd')::timestamptz, (p_invoice ->> 'created')::date, (p_invoice ->> 'dueDate')::date,
          (p_invoice ->> 'paidAt')::timestamptz, p_invoice ->> 'pdfUrl')
  ON CONFLICT (organisation_id, provider_invoice_id) WHERE provider_invoice_id IS NOT NULL DO UPDATE SET
    invoice_number = EXCLUDED.invoice_number, currency = EXCLUDED.currency, subtotal = EXCLUDED.subtotal, tax_amount = EXCLUDED.tax_amount, total_amount = EXCLUDED.total_amount,
    status = EXCLUDED.status, period_start = EXCLUDED.period_start, period_end = EXCLUDED.period_end, invoice_date = EXCLUDED.invoice_date, due_date = EXCLUDED.due_date,
    paid_at = EXCLUDED.paid_at, invoice_pdf_url = EXCLUDED.invoice_pdf_url
  RETURNING id INTO v_id;
  IF (p_invoice ->> 'paymentIntentId') IS NOT NULL AND v_pay IN ('succeeded', 'failed', 'pending', 'refunded') THEN
    INSERT INTO public.billing_payments (organisation_id, provider_payment_id, invoice_id, amount, currency, status)
    VALUES (p_organisation_id, p_invoice ->> 'paymentIntentId', v_id, (p_invoice ->> 'total')::bigint, upper(coalesce(p_invoice ->> 'currency', 'GBP')), v_pay)
    ON CONFLICT (organisation_id, provider_payment_id) WHERE provider_payment_id IS NOT NULL DO UPDATE SET status = EXCLUDED.status, amount = EXCLUDED.amount;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app.organisation_subscription_status_ok(uuid), app.organisation_has_owner_controller(uuid), app.assert_owner_controller_seat(), app.check_seat_change(uuid, jsonb),
  app.stripe_status(text), app.stripe_record_event(text, text), app.stripe_finish_event(text, text, text, uuid), app.stripe_organisation_for(text, text), app.stripe_customer_for(uuid),
  app.stripe_set_customer(uuid, text), app.stripe_price_for(text, text), app.stripe_start_checkout(uuid, uuid, text, text, jsonb), app.stripe_checkout_owner(uuid, text),
  app.stripe_apply_subscription(uuid, jsonb, timestamptz, text), app.stripe_apply_invoice(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.check_seat_change(uuid, jsonb) TO authenticated;

-- The API's own login (not a signed-in person) runs the system functions. It gets the schema's USAGE and EXECUTE on exactly these; no table privileges.
GRANT USAGE ON SCHEMA app TO qms_api;
GRANT EXECUTE ON FUNCTION app.stripe_record_event(text, text), app.stripe_finish_event(text, text, text, uuid), app.stripe_organisation_for(text, text), app.stripe_customer_for(uuid),
  app.stripe_set_customer(uuid, text), app.stripe_price_for(text, text), app.stripe_start_checkout(uuid, uuid, text, text, jsonb), app.stripe_checkout_owner(uuid, text),
  app.stripe_apply_subscription(uuid, jsonb, timestamptz, text), app.stripe_apply_invoice(uuid, jsonb) TO qms_api;
