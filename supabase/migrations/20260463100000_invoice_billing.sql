-- IV1 (docs/invoice-billing-plan.md §3a, §4.3): the database half of "pay by invoice".
--
-- An organisation may be billed by invoice (Stripe collection_method send_invoice) instead of by card. This migration adds what that needs and the agreed abuse limits (I9):
--   * organisation_subscriptions says which route it is (card | invoice), the payment terms, the billing contact, the PO reference and the company it is billed to (a normalised name and VAT number);
--   * ONE INVOICED ORGANISATION PER COMPANY: a trigger refuses a second live invoiced subscription with the same company key or VAT number (an operator can lift it for a genuine second entity);
--   * SEAT CAP: app.check_seat_change refuses an increase on an invoiced subscription while any invoice is open or the first invoice is unpaid (decreases are always allowed);
--   * DATA-LEAVING FEATURES: app.invoice_first_payment_pending(org) is the one question every route asks; creating a reporting key refuses while it is true (QM040 -> 403 payable_first in the API);
--   * ACCESS: an invoiced subscription is not valid once its oldest open invoice is past its due date plus the grace days, whatever Stripe still calls it (so access never depends on exactly how
--     Stripe labels an overdue send-invoice subscription); the grace for an invoiced organisation is 3 days, set when the route is applied;
--   * app.stripe_apply_subscription learns the collection method and takes the billing details from the invoice start recorded by app.stripe_start_invoice (API login only);
--   * operator alerts (platform_invoice_alerts) when an organisation starts invoicing and when its first invoice passes its due date, and operator functions to switch the route off for an
--     organisation or to lift the one-per-company block.
-- Card organisations are unchanged: every new column defaults to the card route and every new rule starts with "is this subscription invoiced?".

-- ---------------------------------------------------------------------------
-- Helper for patching live functions (refuses unless the text is found exactly once; does nothing when the marker is already there)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pg_temp.patch_once(p_fn regprocedure, p_marker text, p_old text, p_new text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_def text := replace(pg_get_functiondef(p_fn), E'\r', ''); v_n integer;
BEGIN
  p_old := replace(p_old, E'\r', '');
  p_new := replace(p_new, E'\r', '');
  IF position(p_marker IN v_def) > 0 THEN RETURN; END IF;
  v_n := (length(v_def) - length(replace(v_def, p_old, ''))) / length(p_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'Expected to find % exactly once in %, found % times', p_old, p_fn, v_n; END IF;
  EXECUTE replace(v_def, p_old, p_new);
END $$;

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------
-- Operator-owned (not in any column grant): who may choose invoicing, and whether the one-per-company block is lifted for this organisation.
ALTER TABLE public.organisations
  ADD COLUMN invoice_billing_allowed boolean NOT NULL DEFAULT true,
  ADD COLUMN invoice_company_exempt boolean NOT NULL DEFAULT false,
  ADD COLUMN invoice_billing_note text CHECK (invoice_billing_note IS NULL OR length(invoice_billing_note) <= 500);

ALTER TABLE public.organisation_subscriptions
  ADD COLUMN collection_method text NOT NULL DEFAULT 'card' CHECK (collection_method IN ('card', 'invoice')),
  ADD COLUMN payment_terms_days integer CHECK (payment_terms_days IS NULL OR payment_terms_days BETWEEN 1 AND 120),
  ADD COLUMN billing_contact_email text CHECK (billing_contact_email IS NULL OR length(billing_contact_email) <= 254),
  ADD COLUMN purchase_order text CHECK (purchase_order IS NULL OR length(purchase_order) <= 100),
  ADD COLUMN billing_legal_name text CHECK (billing_legal_name IS NULL OR length(billing_legal_name) BETWEEN 2 AND 200),
  ADD COLUMN billing_company_key text,
  ADD COLUMN billing_vat_number text CHECK (billing_vat_number IS NULL OR length(billing_vat_number) <= 30);
CREATE INDEX organisation_subscriptions_company_idx ON public.organisation_subscriptions (billing_company_key) WHERE collection_method = 'invoice';
CREATE INDEX organisation_subscriptions_vat_idx ON public.organisation_subscriptions (billing_vat_number) WHERE collection_method = 'invoice';

-- The access rule below and the seat rule look for an organisation's open invoices.
CREATE INDEX billing_invoices_open_due_idx ON public.billing_invoices (organisation_id, due_date) WHERE status = 'open';

-- An invoice start is recorded like a checkout (who started it, with which seats), under an id we make: inv_<client key>.
ALTER TABLE public.stripe_checkout_sessions DROP CONSTRAINT stripe_checkout_sessions_provider_session_id_check;
ALTER TABLE public.stripe_checkout_sessions
  ADD CONSTRAINT stripe_checkout_sessions_provider_session_id_check CHECK (provider_session_id ~ '^(cs|inv)_[A-Za-z0-9_-]{4,200}$'),
  ADD COLUMN billing_details jsonb CHECK (billing_details IS NULL OR jsonb_typeof(billing_details) = 'object');

-- Operator alerts: written by functions, read by platform operators only (like stripe_events).
CREATE TABLE public.platform_invoice_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('started', 'first_invoice_overdue')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, kind)
);
ALTER TABLE public.platform_invoice_alerts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.platform_invoice_alerts FROM anon, authenticated;
GRANT SELECT ON public.platform_invoice_alerts TO authenticated;
CREATE POLICY platform_invoice_alerts_select ON public.platform_invoice_alerts FOR SELECT TO authenticated USING (app.is_platform_admin());

-- ---------------------------------------------------------------------------
-- 2. Company identity: one invoiced organisation per company
-- ---------------------------------------------------------------------------
-- Name without case, spaces, punctuation or a trailing Ltd / Limited, so "Acme Ltd." and "ACME limited" are the same company.
CREATE FUNCTION app.company_key(p_name text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT nullif(regexp_replace(regexp_replace(lower(replace(coalesce(p_name, ''), '&', 'and')), '[^[:alnum:]]', '', 'g'), '(limited|ltd)$', ''), '')
$$;

CREATE FUNCTION app.vat_key(p_vat text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT nullif(upper(regexp_replace(coalesce(p_vat, ''), '[^A-Za-z0-9]', '', 'g')), '')
$$;

-- What stops this organisation choosing invoicing with these company details (internal: no permission check).
CREATE FUNCTION app.invoice_company_problems(p_organisation_id uuid, p_legal_name text, p_vat text) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_problems text[] := ARRAY[]::text[]; o public.organisations%ROWTYPE; v_key text := app.company_key(p_legal_name); v_vat text := app.vat_key(p_vat);
BEGIN
  SELECT * INTO o FROM public.organisations WHERE id = p_organisation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown organisation' USING ERRCODE = 'P0002'; END IF;
  IF NOT o.invoice_billing_allowed THEN
    v_problems := array_append(v_problems, 'Paying by invoice is not available for this organisation. Pay by card, or contact us.');
  END IF;
  IF v_key IS NULL THEN
    v_problems := array_append(v_problems, 'Enter the legal name of the company the invoice is for.');
  ELSIF NOT o.invoice_company_exempt AND EXISTS (
          SELECT 1 FROM public.organisation_subscriptions s
           WHERE s.organisation_id <> p_organisation_id AND s.collection_method = 'invoice' AND s.status NOT IN ('cancelled', 'incomplete')
             AND (s.billing_company_key = v_key OR (v_vat IS NOT NULL AND s.billing_vat_number = v_vat))) THEN
    v_problems := array_append(v_problems, 'An organisation for this company already exists. Ask its owner to invite you to it.');
  END IF;
  RETURN v_problems;
END $$;

-- The same, for the form (the person must be able to manage the subscription).
CREATE FUNCTION app.check_invoice_company(p_organisation_id uuid, p_legal_name text, p_vat text) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT app.has_permission(p_organisation_id, 'subscription.manage') THEN
    RAISE EXCEPTION 'Not allowed to manage the subscription' USING ERRCODE = '42501';
  END IF;
  RETURN app.invoice_company_problems(p_organisation_id, p_legal_name, p_vat);
END $$;

-- Backstop for a race the pre-check cannot see: two organisations applying the same company at once.
CREATE FUNCTION app.invoice_company_unique() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_exempt boolean;
BEGIN
  IF NEW.collection_method <> 'invoice' OR NEW.status IN ('cancelled', 'incomplete') OR (NEW.billing_company_key IS NULL AND NEW.billing_vat_number IS NULL) THEN RETURN NEW; END IF;
  SELECT o.invoice_company_exempt INTO v_exempt FROM public.organisations o WHERE o.id = NEW.organisation_id;
  IF coalesce(v_exempt, false) THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('invoice_company:' || coalesce(NEW.billing_company_key, NEW.billing_vat_number)));
  IF EXISTS (SELECT 1 FROM public.organisation_subscriptions s
              WHERE s.organisation_id <> NEW.organisation_id AND s.collection_method = 'invoice' AND s.status NOT IN ('cancelled', 'incomplete')
                AND ((NEW.billing_company_key IS NOT NULL AND s.billing_company_key = NEW.billing_company_key)
                     OR (NEW.billing_vat_number IS NOT NULL AND s.billing_vat_number = NEW.billing_vat_number))) THEN
    RAISE EXCEPTION 'An organisation for this company already exists. Ask its owner to invite you to it.' USING ERRCODE = 'QM009';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER organisation_subscriptions_company_unique
  BEFORE INSERT OR UPDATE OF collection_method, status, billing_company_key, billing_vat_number ON public.organisation_subscriptions
  FOR EACH ROW EXECUTE FUNCTION app.invoice_company_unique();

-- ---------------------------------------------------------------------------
-- 3. Is the first invoice still unpaid? (the question every limited feature asks)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.invoice_first_payment_pending_internal(p_organisation_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.organisation_subscriptions s
     WHERE s.organisation_id = p_organisation_id AND s.billing_provider = 'stripe' AND s.collection_method = 'invoice'
       AND s.status NOT IN ('cancelled', 'incomplete')
       AND NOT EXISTS (SELECT 1 FROM public.billing_invoices i WHERE i.organisation_id = p_organisation_id AND i.status = 'paid' AND i.total_amount > 0))
$$;

-- For the signed-in person: only for an organisation they belong to.
CREATE FUNCTION app.invoice_first_payment_pending(p_organisation_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app.is_member(p_organisation_id) AND app.invoice_first_payment_pending_internal(p_organisation_id)
$$;

-- Creating a reporting key lets data leave: closed while the first invoice is unpaid.
SELECT pg_temp.patch_once('app.create_reporting_key(uuid, text, integer, text, text)'::regprocedure, 'invoice_first_payment_pending',
$old$  IF length(v_name) < 1 OR length(v_name) > 80 THEN$old$,
$new$  IF app.invoice_first_payment_pending_internal(p_organisation_id) THEN
    RAISE EXCEPTION 'Reporting keys are available once your first invoice is paid' USING ERRCODE = 'QM040';
  END IF;
  IF length(v_name) < 1 OR length(v_name) > 80 THEN$new$);

-- ---------------------------------------------------------------------------
-- 4. Access: an invoiced subscription with an overdue invoice is not valid
-- ---------------------------------------------------------------------------
SELECT pg_temp.patch_once('app.organisation_subscription_status_ok(uuid)'::regprocedure, 'invoice_overdue',
$old$OR (s.status = 'cancelled' AND s.current_period_end > now())))$old$,
$new$OR (s.status = 'cancelled' AND s.current_period_end > now()))
              -- invoice_overdue: an invoiced subscription stops when its oldest open invoice is past its due date plus the grace days, whatever Stripe still calls it
              AND NOT (s.collection_method = 'invoice' AND EXISTS (
                    SELECT 1 FROM public.billing_invoices bi
                     WHERE bi.organisation_id = s.organisation_id AND bi.status = 'open' AND bi.due_date IS NOT NULL
                       AND bi.due_date + coalesce((SELECT o.grace_period_days FROM public.organisation_settings o WHERE o.organisation_id = p_organisation_id), 3)
                           < (now() AT TIME ZONE 'UTC')::date)))$new$);

-- ---------------------------------------------------------------------------
-- 5. Seat cap: no increase on an invoiced subscription while an invoice is open or the first one is unpaid
-- ---------------------------------------------------------------------------
SELECT pg_temp.patch_once('app.check_seat_change(uuid, jsonb)'::regprocedure, 'invoice_open',
$old$  RETURN v_problems;$old$,
$new$  -- invoice_open: on an invoiced subscription seats can go up only when nothing is owed
  IF EXISTS (SELECT 1 FROM public.organisation_subscriptions s
              WHERE s.organisation_id = p_organisation_id AND s.billing_provider = 'stripe' AND s.collection_method = 'invoice'
                AND s.status NOT IN ('cancelled', 'incomplete')) THEN
    DECLARE v_increase boolean := false; kk text; v_open public.billing_invoices%ROWTYPE;
    BEGIN
      FOR kk IN SELECT jsonb_object_keys(p_seats) LOOP
        IF (p_seats ->> kk) ~ '^[0-9]{1,5}$' AND (p_seats ->> kk)::integer > coalesce(
             (SELECT i.quantity FROM public.organisation_subscription_items i
                JOIN public.subscription_plans pl ON pl.id = i.subscription_plan_id AND pl.slug = kk
                JOIN public.organisation_subscriptions s ON s.id = i.organisation_subscription_id
               WHERE s.organisation_id = p_organisation_id), 0) THEN
          v_increase := true;
        END IF;
      END LOOP;
      IF v_increase THEN
        SELECT * INTO v_open FROM public.billing_invoices bi
         WHERE bi.organisation_id = p_organisation_id AND bi.status IN ('open', 'draft') ORDER BY bi.due_date NULLS LAST, bi.created_at LIMIT 1;
        IF FOUND THEN
          v_problems := array_append(v_problems, format('Pay %s (£%s%s) before adding seats: seats can be added once nothing is owed.',
            coalesce('invoice ' || v_open.invoice_number, 'the open invoice'), to_char(v_open.total_amount / 100.0, 'FM999,999,990.00'),
            CASE WHEN v_open.due_date IS NOT NULL THEN ', due ' || to_char(v_open.due_date, 'FMDD Mon YYYY') ELSE '' END));
        ELSIF app.invoice_first_payment_pending_internal(p_organisation_id) THEN
          v_problems := array_append(v_problems, 'Seats can be added once your first invoice is paid.');
        END IF;
      END IF;
    END;
  END IF;
  RETURN v_problems;$new$);

-- ---------------------------------------------------------------------------
-- 6. Starting an invoiced subscription (API login only)
-- ---------------------------------------------------------------------------
-- Like app.stripe_start_checkout: only an owner (they hold the first Controller seat), refused with a live subscription, plus the invoice rules (route allowed, one invoiced organisation per
-- company) and the billing details. A retry with the same client key returns the same record. p_details: { legalName, billingEmail, addressLine1, addressLine2?, city, region?, postcode, country,
-- vatNumber?, poReference? }.
CREATE FUNCTION app.stripe_start_invoice(p_organisation_id uuid, p_user_id uuid, p_client_key text, p_interval text, p_seats jsonb, p_details jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_member uuid; v_sub public.organisation_subscriptions%ROWTYPE; v_id uuid; v_session text := 'inv_' || coalesce(p_client_key, '');
  v_name text := btrim(coalesce(p_details ->> 'legalName', '')); v_email text := lower(btrim(coalesce(p_details ->> 'billingEmail', '')));
  v_problems text[]; v_clean jsonb;
BEGIN
  IF p_client_key IS NULL OR p_client_key !~ '^[A-Za-z0-9_-]{4,200}$' THEN RAISE EXCEPTION 'A client key is needed' USING ERRCODE = 'QM009'; END IF;
  IF p_interval NOT IN ('month', 'year') THEN RAISE EXCEPTION 'Choose monthly or annual billing' USING ERRCODE = 'QM009'; END IF;
  SELECT m.id INTO v_member FROM public.organisation_users m
   WHERE m.organisation_id = p_organisation_id AND m.user_id = p_user_id AND m.status = 'active'
     AND EXISTS (SELECT 1 FROM public.user_role_assignments a JOIN public.roles r ON r.id = a.role_id AND r.key = 'owner' WHERE a.membership_id = m.id);
  IF v_member IS NULL THEN
    RAISE EXCEPTION 'Only an owner can start the subscription: they hold the first Controller seat.' USING ERRCODE = 'QM009';
  END IF;
  -- A retry of the same start: the same record.
  SELECT c.id INTO v_id FROM public.stripe_checkout_sessions c WHERE c.organisation_id = p_organisation_id AND c.provider_session_id = v_session;
  IF FOUND THEN RETURN jsonb_build_object('id', v_id, 'sessionId', v_session, 'created', false); END IF;

  SELECT * INTO v_sub FROM public.organisation_subscriptions WHERE organisation_id = p_organisation_id;
  IF FOUND AND (v_sub.billing_provider = 'manual' OR v_sub.status NOT IN ('cancelled', 'incomplete')) THEN
    RAISE EXCEPTION 'This organisation already has a subscription. Change it from Subscription & billing.' USING ERRCODE = 'QM009';
  END IF;

  -- The billing details the invoice needs: a company, an address and an address to send it to.
  IF length(v_name) < 2 OR length(v_name) > 200 THEN RAISE EXCEPTION 'Enter the legal name of the company the invoice is for.' USING ERRCODE = 'QM009'; END IF;
  IF v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' OR length(v_email) > 254 THEN RAISE EXCEPTION 'Enter a valid billing email address.' USING ERRCODE = 'QM009'; END IF;
  IF length(btrim(coalesce(p_details ->> 'addressLine1', ''))) < 2 OR length(btrim(coalesce(p_details ->> 'city', ''))) < 2
     OR length(btrim(coalesce(p_details ->> 'postcode', ''))) < 2 OR coalesce(p_details ->> 'country', '') !~ '^[A-Z]{2}$' THEN
    RAISE EXCEPTION 'Enter the billing address: first line, town or city, postcode and country.' USING ERRCODE = 'QM009';
  END IF;
  v_problems := app.invoice_company_problems(p_organisation_id, v_name, p_details ->> 'vatNumber');
  IF array_length(v_problems, 1) IS NOT NULL THEN RAISE EXCEPTION '%', v_problems[1] USING ERRCODE = 'QM009'; END IF;

  v_clean := jsonb_strip_nulls(jsonb_build_object(
    'legalName', v_name, 'billingEmail', v_email,
    'addressLine1', btrim(p_details ->> 'addressLine1'), 'addressLine2', nullif(btrim(coalesce(p_details ->> 'addressLine2', '')), ''),
    'city', btrim(p_details ->> 'city'), 'region', nullif(btrim(coalesce(p_details ->> 'region', '')), ''),
    'postcode', btrim(p_details ->> 'postcode'), 'country', p_details ->> 'country',
    'vatNumber', app.vat_key(p_details ->> 'vatNumber'), 'poReference', nullif(left(btrim(coalesce(p_details ->> 'poReference', '')), 100), '')));

  INSERT INTO public.stripe_checkout_sessions (organisation_id, provider_session_id, membership_id, billing_interval, seats, billing_details)
  VALUES (p_organisation_id, v_session, v_member, p_interval, p_seats, v_clean) RETURNING id INTO v_id;
  RETURN jsonb_build_object('id', v_id, 'sessionId', v_session, 'created', true, 'details', v_clean);
END $$;

-- ---------------------------------------------------------------------------
-- 7. Applying a subscription learns the collection method (one anchor in the live function)
-- ---------------------------------------------------------------------------
-- After the subscription row is written (before the seats): set the route, terms and billing details; an organisation that becomes invoiced gets 3 days' grace (card keeps what it had: 7, unless an
-- operator changed it) and the operators are told. Snapshot keys used: collectionMethod (send_invoice | charge_automatically), daysUntilDue.
SELECT pg_temp.patch_once('app.stripe_apply_subscription(uuid, jsonb, timestamptz, text)'::regprocedure, 'collectionMethod',
$old$  -- Seats: exactly what Stripe says. A package missing from the snapshot goes to 0; nothing is unassigned automatically.$old$,
$new$  -- The payment route (collectionMethod): invoice or card, with the terms and billing details of an invoice start.
  DECLARE
    v_method text := CASE WHEN p_snapshot ->> 'collectionMethod' = 'send_invoice' THEN 'invoice' ELSE 'card' END;
    v_prev text := v_sub.collection_method; v_details jsonb;
  BEGIN
    IF p_checkout_session_id IS NOT NULL AND v_method = 'invoice' THEN
      SELECT c.billing_details INTO v_details FROM public.stripe_checkout_sessions c
       WHERE c.organisation_id = p_organisation_id AND c.provider_session_id = p_checkout_session_id;
    END IF;
    IF v_method <> v_prev OR v_details IS NOT NULL THEN
      UPDATE public.organisation_subscriptions SET
        collection_method = v_method,
        payment_terms_days = CASE WHEN v_method = 'invoice' THEN coalesce((p_snapshot ->> 'daysUntilDue')::integer, payment_terms_days) END,
        billing_contact_email = CASE WHEN v_method = 'invoice' THEN coalesce(v_details ->> 'billingEmail', billing_contact_email) END,
        purchase_order = CASE WHEN v_method = 'invoice' THEN coalesce(v_details ->> 'poReference', purchase_order) END,
        billing_legal_name = CASE WHEN v_method = 'invoice' THEN coalesce(v_details ->> 'legalName', billing_legal_name) END,
        billing_company_key = CASE WHEN v_method = 'invoice' THEN coalesce(app.company_key(v_details ->> 'legalName'), billing_company_key) END,
        billing_vat_number = CASE WHEN v_method = 'invoice' THEN coalesce(v_details ->> 'vatNumber', billing_vat_number) END
       WHERE id = v_sub.id RETURNING * INTO v_sub;
    END IF;
    IF v_method = 'invoice' AND v_prev <> 'invoice' THEN
      UPDATE public.organisation_settings SET grace_period_days = 3 WHERE organisation_id = p_organisation_id;
      INSERT INTO public.platform_invoice_alerts (organisation_id, kind, details)
      VALUES (p_organisation_id, 'started', jsonb_build_object('legalName', v_sub.billing_legal_name, 'interval', v_sub.billing_interval, 'termsDays', v_sub.payment_terms_days))
      ON CONFLICT (organisation_id, kind) DO NOTHING;
    ELSIF v_method = 'card' AND v_prev = 'invoice' THEN
      UPDATE public.organisation_settings SET grace_period_days = 7 WHERE organisation_id = p_organisation_id;
    END IF;
  END;

  -- Seats: exactly what Stripe says. A package missing from the snapshot goes to 0; nothing is unassigned automatically.$new$);

-- ---------------------------------------------------------------------------
-- 8. Operator alerts and controls
-- ---------------------------------------------------------------------------
-- Run daily by the API's reconcile job: an invoiced organisation whose FIRST invoice is past its due date. Once per organisation.
CREATE FUNCTION app.system_invoice_overdue_alerts() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_n integer;
BEGIN
  WITH due AS (
    SELECT DISTINCT ON (s.organisation_id) s.organisation_id, i.id AS invoice_id, i.invoice_number, i.due_date, i.total_amount
      FROM public.organisation_subscriptions s
      JOIN public.billing_invoices i ON i.organisation_id = s.organisation_id AND i.status = 'open' AND i.due_date < (now() AT TIME ZONE 'UTC')::date
     WHERE s.collection_method = 'invoice' AND s.billing_provider = 'stripe' AND s.status NOT IN ('cancelled', 'incomplete')
       AND app.invoice_first_payment_pending_internal(s.organisation_id)
     ORDER BY s.organisation_id, i.due_date
  ), ins AS (
    INSERT INTO public.platform_invoice_alerts (organisation_id, kind, details)
    SELECT d.organisation_id, 'first_invoice_overdue',
           jsonb_build_object('invoiceNumber', d.invoice_number, 'dueOn', d.due_date, 'totalPence', d.total_amount)
      FROM due d
    ON CONFLICT (organisation_id, kind) DO NOTHING
    RETURNING 1)
  SELECT count(*) INTO v_n FROM ins;
  RETURN v_n;
END $$;

CREATE FUNCTION app.set_invoice_billing_allowed(p_organisation_id uuid, p_allowed boolean, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT app.is_platform_admin() THEN RAISE EXCEPTION 'Platform administrators only' USING ERRCODE = '42501'; END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 3 OR length(p_reason) > 500 THEN RAISE EXCEPTION 'Give a reason (3 to 500 characters)' USING ERRCODE = 'QM009'; END IF;
  UPDATE public.organisations SET invoice_billing_allowed = coalesce(p_allowed, true), invoice_billing_note = btrim(p_reason) WHERE id = p_organisation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown organisation' USING ERRCODE = 'P0002'; END IF;
END $$;

-- Lifts the one-invoiced-organisation-per-company block for a genuine second entity (a subsidiary, a separate site company).
CREATE FUNCTION app.set_invoice_company_exempt(p_organisation_id uuid, p_exempt boolean, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT app.is_platform_admin() THEN RAISE EXCEPTION 'Platform administrators only' USING ERRCODE = '42501'; END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 3 OR length(p_reason) > 500 THEN RAISE EXCEPTION 'Give a reason (3 to 500 characters)' USING ERRCODE = 'QM009'; END IF;
  UPDATE public.organisations SET invoice_company_exempt = coalesce(p_exempt, false), invoice_billing_note = btrim(p_reason) WHERE id = p_organisation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown organisation' USING ERRCODE = 'P0002'; END IF;
END $$;

-- The operator's list of invoiced organisations: route, whether the first invoice is paid, what is open, how late.
CREATE FUNCTION app.platform_invoice_accounts(p_limit integer DEFAULT 100)
RETURNS TABLE (organisation_id uuid, name text, subscription_status text, billing_interval text, legal_name text, billing_email text, purchase_order text, payment_terms_days integer,
               first_invoice_paid boolean, open_invoices bigint, open_amount_pence bigint, oldest_open_due_on date, overdue_days integer,
               billing_allowed boolean, company_exempt boolean, started_at timestamptz, overdue_alerted_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT app.is_platform_admin() THEN RAISE EXCEPTION 'Platform administrators only' USING ERRCODE = '42501'; END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN RAISE EXCEPTION 'Choose between 1 and 500 rows' USING ERRCODE = '22023'; END IF;
  RETURN QUERY
  SELECT o.id, o.name, s.status, s.billing_interval, s.billing_legal_name, s.billing_contact_email, s.purchase_order, s.payment_terms_days,
         NOT app.invoice_first_payment_pending_internal(o.id),
         (SELECT count(*) FROM public.billing_invoices i WHERE i.organisation_id = o.id AND i.status = 'open'),
         coalesce((SELECT sum(i.total_amount) FROM public.billing_invoices i WHERE i.organisation_id = o.id AND i.status = 'open'), 0)::bigint,
         (SELECT min(i.due_date) FROM public.billing_invoices i WHERE i.organisation_id = o.id AND i.status = 'open'),
         coalesce((SELECT greatest(0, (now() AT TIME ZONE 'UTC')::date - min(i.due_date)) FROM public.billing_invoices i WHERE i.organisation_id = o.id AND i.status = 'open'), 0)::integer,
         o.invoice_billing_allowed, o.invoice_company_exempt,
         (SELECT a.created_at FROM public.platform_invoice_alerts a WHERE a.organisation_id = o.id AND a.kind = 'started'),
         (SELECT a.created_at FROM public.platform_invoice_alerts a WHERE a.organisation_id = o.id AND a.kind = 'first_invoice_overdue')
    FROM public.organisation_subscriptions s JOIN public.organisations o ON o.id = s.organisation_id
   WHERE s.collection_method = 'invoice'
   ORDER BY coalesce((SELECT min(i.due_date) FROM public.billing_invoices i WHERE i.organisation_id = o.id AND i.status = 'open'), DATE '9999-12-31'), o.created_at DESC
   LIMIT p_limit;
END $$;

-- ---------------------------------------------------------------------------
-- 9. Privileges
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app.company_key(text), app.vat_key(text), app.invoice_company_problems(uuid, text, text), app.check_invoice_company(uuid, text, text), app.invoice_company_unique(),
  app.invoice_first_payment_pending_internal(uuid), app.invoice_first_payment_pending(uuid), app.stripe_start_invoice(uuid, uuid, text, text, jsonb, jsonb), app.system_invoice_overdue_alerts(),
  app.set_invoice_billing_allowed(uuid, boolean, text), app.set_invoice_company_exempt(uuid, boolean, text), app.platform_invoice_accounts(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.check_invoice_company(uuid, text, text), app.invoice_first_payment_pending(uuid),
  app.set_invoice_billing_allowed(uuid, boolean, text), app.set_invoice_company_exempt(uuid, boolean, text), app.platform_invoice_accounts(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION app.stripe_start_invoice(uuid, uuid, text, text, jsonb, jsonb), app.system_invoice_overdue_alerts(), app.invoice_first_payment_pending_internal(uuid) TO qms_api;
