-- ON5a (docs/onboarding-plan.md §15): the operator's read-only monitor and the scheduled clean-up.
--
--  * app.platform_organisations / platform_revenue / platform_payments / platform_webhooks / platform_activity: admin-only (allow-list AND an MFA session, else 42501). They return counts, billing
--    and webhook facts only: never an organisation's records, documents or quality data.
--  * organisations.status gains 'archived' (with archived_at / archived_reason): members cannot see or use it (is_member needs 'active'), all data is kept, an operator can undo it with one update.
--  * app.system_reconcile_candidates and app.system_archive_stale_organisations are for the API login only (the scheduled jobs). Archiving is a dry run unless asked otherwise, never touches an
--    organisation that does not require a subscription or has a valid one, and is idempotent.

ALTER TABLE public.organisations
  ADD COLUMN archived_at timestamptz,
  ADD COLUMN archived_reason text CHECK (archived_reason IS NULL OR archived_reason IN ('unpaid_setup', 'lapsed', 'operator'));
ALTER TABLE public.organisations DROP CONSTRAINT organisations_status_check;
ALTER TABLE public.organisations ADD CONSTRAINT organisations_status_check CHECK (status IN ('active', 'suspended', 'archived'));

-- ---------------------------------------------------------------------------
-- One subscription's recurring amount per month, in pence (annual plans divided by 12). Internal helper.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.subscription_monthly_pence(p_subscription_id uuid) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT round(coalesce(sum(i.quantity::numeric * i.unit_amount_snapshot), 0) / CASE WHEN s.billing_interval = 'year' THEN 12 ELSE 1 END)::bigint
    FROM public.organisation_subscriptions s
    LEFT JOIN public.organisation_subscription_items i ON i.organisation_subscription_id = s.id
   WHERE s.id = p_subscription_id
   GROUP BY s.billing_interval
$$;

-- ---------------------------------------------------------------------------
-- The operator's views
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.platform_organisations(p_search text DEFAULT NULL, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
RETURNS TABLE (
  organisation_id uuid, name text, status text, created_at timestamptz, country text, billing_required boolean, onboarding_completed_at timestamptz,
  owner_emails text[], members bigint, subscription_status text, billing_provider text, billing_interval text, trial_end timestamptz, current_period_end timestamptz,
  cancel_at_period_end boolean, past_due_since timestamptz, seats_purchased bigint, seats_assigned bigint, mrr_pence bigint, last_synced_at timestamptz, total_rows bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT app.is_platform_admin() THEN RAISE EXCEPTION 'Platform administrators only' USING ERRCODE = '42501'; END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 200 THEN RAISE EXCEPTION 'Choose between 1 and 200 rows' USING ERRCODE = '22023'; END IF;
  IF p_offset IS NULL OR p_offset < 0 THEN RAISE EXCEPTION 'The offset cannot be negative' USING ERRCODE = '22023'; END IF;
  RETURN QUERY
  WITH owners AS (
    SELECT m.organisation_id AS org, array_agg(DISTINCT lower(u.email::text) ORDER BY lower(u.email::text)) AS emails
      FROM public.organisation_users m
      JOIN public.user_role_assignments a ON a.membership_id = m.id
      JOIN public.roles r ON r.id = a.role_id AND r.key = 'owner'
      JOIN auth.users u ON u.id = m.user_id
     WHERE m.status = 'active'
     GROUP BY m.organisation_id
  ), found AS (
    SELECT o.id, o.name, o.status, o.created_at, o.country, o.billing_required, o.onboarding_completed_at, coalesce(ow.emails, ARRAY[]::text[]) AS owner_emails
      FROM public.organisations o LEFT JOIN owners ow ON ow.org = o.id
     WHERE nullif(btrim(coalesce(p_search, '')), '') IS NULL
        OR position(lower(btrim(p_search)) IN lower(o.name)) > 0
        OR EXISTS (SELECT 1 FROM unnest(coalesce(ow.emails, ARRAY[]::text[])) e WHERE position(lower(btrim(p_search)) IN e) > 0)
  )
  SELECT f.id, f.name, f.status, f.created_at, f.country, f.billing_required, f.onboarding_completed_at, f.owner_emails,
         (SELECT count(*) FROM public.organisation_users m WHERE m.organisation_id = f.id AND m.status = 'active'),
         s.status, s.billing_provider, s.billing_interval, s.trial_end, s.current_period_end, s.cancel_at_period_end, s.past_due_since,
         coalesce((SELECT sum(i.quantity) FROM public.organisation_subscription_items i WHERE i.organisation_subscription_id = s.id), 0)::bigint,
         (SELECT count(*) FROM public.user_subscription_assignments sa WHERE sa.organisation_id = f.id AND sa.status = 'active'),
         CASE WHEN s.id IS NULL THEN 0::bigint ELSE app.subscription_monthly_pence(s.id) END,
         s.provider_synced_at,
         count(*) OVER ()
    FROM found f LEFT JOIN public.organisation_subscriptions s ON s.organisation_id = f.id
   ORDER BY f.created_at DESC, f.id
   LIMIT p_limit OFFSET p_offset;
END $$;

-- Revenue from Stripe-billed subscriptions. Paying = active or past due (still owed); trial = what trials pay if they convert. Pence, excluding VAT.
CREATE FUNCTION app.platform_revenue() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE r jsonb;
BEGIN
  IF NOT app.is_platform_admin() THEN RAISE EXCEPTION 'Platform administrators only' USING ERRCODE = '42501'; END IF;
  WITH subs AS (
    SELECT s.*, app.subscription_monthly_pence(s.id) AS monthly FROM public.organisation_subscriptions s WHERE s.billing_provider = 'stripe'
  ), totals AS (
    SELECT coalesce(sum(monthly) FILTER (WHERE status IN ('active', 'past_due')), 0)::bigint AS mrr,
           coalesce(sum(monthly) FILTER (WHERE status = 'trialing'), 0)::bigint AS trial_mrr,
           count(*) FILTER (WHERE status = 'trialing' AND trial_end IS NOT NULL AND trial_end <= now() + interval '7 days') AS trials_ending,
           count(*) FILTER (WHERE status = 'past_due') AS past_due,
           count(*) FILTER (WHERE cancel_at_period_end AND status IN ('active', 'trialing', 'past_due')) AS cancelling,
           count(*) FILTER (WHERE status = 'cancelled' AND cancelled_at >= now() - interval '30 days') AS cancelled_30
      FROM subs
  )
  SELECT jsonb_build_object(
    'currency', 'GBP',
    'mrrPence', t.mrr, 'arrPence', t.mrr * 12, 'trialMrrPence', t.trial_mrr,
    'trialsEndingSoon', t.trials_ending, 'pastDue', t.past_due, 'cancelling', t.cancelling, 'cancelledLast30Days', t.cancelled_30,
    'newLast30Days', (SELECT count(*) FROM public.subscription_audit_logs l WHERE l.event_type = 'subscription_created' AND l.details ->> 'provider' = 'stripe' AND l.created_at >= now() - interval '30 days'),
    'byStatus', coalesce((SELECT jsonb_object_agg(x.status, x.n) FROM (SELECT s2.status, count(*) AS n FROM subs s2 GROUP BY s2.status) x), '{}'::jsonb),
    'payingByInterval', coalesce((SELECT jsonb_object_agg(x.billing_interval, x.n) FROM (SELECT s2.billing_interval, count(*) AS n FROM subs s2 WHERE s2.status IN ('active', 'past_due') GROUP BY s2.billing_interval) x), '{}'::jsonb),
    'seats', coalesce((
      SELECT jsonb_agg(jsonb_build_object('slug', p.slug, 'name', p.name, 'purchased', coalesce(q.purchased, 0), 'assigned', coalesce(a.assigned, 0)) ORDER BY p.display_order)
        FROM public.subscription_plans p
        LEFT JOIN (SELECT i.subscription_plan_id AS plan, sum(i.quantity) AS purchased
                     FROM public.organisation_subscription_items i JOIN subs s3 ON s3.id = i.organisation_subscription_id AND s3.status IN ('active', 'trialing', 'past_due')
                    GROUP BY i.subscription_plan_id) q ON q.plan = p.id
        LEFT JOIN (SELECT sa.subscription_plan_id AS plan, count(*) AS assigned
                     FROM public.user_subscription_assignments sa JOIN subs s4 ON s4.organisation_id = sa.organisation_id AND s4.status IN ('active', 'trialing', 'past_due')
                    WHERE sa.status = 'active' GROUP BY sa.subscription_plan_id) a ON a.plan = p.id), '[]'::jsonb)
  ) INTO r FROM totals t;
  RETURN r;
END $$;

CREATE FUNCTION app.platform_payments(p_limit integer DEFAULT 50) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT app.is_platform_admin() THEN RAISE EXCEPTION 'Platform administrators only' USING ERRCODE = '42501'; END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 200 THEN RAISE EXCEPTION 'Choose between 1 and 200 rows' USING ERRCODE = '22023'; END IF;
  RETURN jsonb_build_object(
    'invoices', coalesce((SELECT jsonb_agg(t.x ORDER BY t.sort_at DESC) FROM (
        SELECT jsonb_build_object('id', i.id, 'organisationId', i.organisation_id, 'organisation', o.name, 'number', i.invoice_number, 'status', i.status, 'currency', i.currency,
                 'subtotal', i.subtotal, 'tax', i.tax_amount, 'total', i.total_amount, 'invoiceDate', i.invoice_date, 'paidAt', i.paid_at) AS x,
               coalesce(i.paid_at, i.invoice_date::timestamptz, i.created_at) AS sort_at
          FROM public.billing_invoices i JOIN public.organisations o ON o.id = i.organisation_id
         ORDER BY coalesce(i.paid_at, i.invoice_date::timestamptz, i.created_at) DESC LIMIT p_limit) t), '[]'::jsonb),
    'failedPayments', coalesce((SELECT jsonb_agg(jsonb_build_object('organisationId', pm.organisation_id, 'organisation', o.name, 'invoice', i.invoice_number, 'amount', pm.amount, 'currency', pm.currency, 'at', pm.updated_at) ORDER BY pm.updated_at DESC)
        FROM public.billing_payments pm JOIN public.organisations o ON o.id = pm.organisation_id LEFT JOIN public.billing_invoices i ON i.id = pm.invoice_id
       WHERE pm.status = 'failed' AND pm.updated_at >= now() - interval '30 days'), '[]'::jsonb),
    'paidLast30DaysPence', coalesce((SELECT sum(i.total_amount) FROM public.billing_invoices i WHERE i.status = 'paid' AND i.paid_at >= now() - interval '30 days'), 0),
    'taxLast30DaysPence', coalesce((SELECT sum(i.tax_amount) FROM public.billing_invoices i WHERE i.status = 'paid' AND i.paid_at >= now() - interval '30 days'), 0),
    'failedLast30Days', (SELECT count(*) FROM public.billing_payments pm WHERE pm.status = 'failed' AND pm.updated_at >= now() - interval '30 days'));
END $$;

CREATE FUNCTION app.platform_webhooks(p_hours integer DEFAULT 24) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT app.is_platform_admin() THEN RAISE EXCEPTION 'Platform administrators only' USING ERRCODE = '42501'; END IF;
  IF p_hours IS NULL OR p_hours < 1 OR p_hours > 720 THEN RAISE EXCEPTION 'Choose between 1 and 720 hours' USING ERRCODE = '22023'; END IF;
  RETURN jsonb_build_object(
    'hours', p_hours,
    'lastReceivedAt', (SELECT max(e.received_at) FROM public.stripe_events e),
    'lastProcessedAt', (SELECT max(e.processed_at) FROM public.stripe_events e WHERE e.status = 'processed'),
    'counts', jsonb_build_object(
      'received', (SELECT count(*) FROM public.stripe_events e WHERE e.received_at >= now() - make_interval(hours => p_hours)),
      'processed', (SELECT count(*) FROM public.stripe_events e WHERE e.status = 'processed' AND e.received_at >= now() - make_interval(hours => p_hours)),
      'ignored', (SELECT count(*) FROM public.stripe_events e WHERE e.status = 'ignored' AND e.received_at >= now() - make_interval(hours => p_hours)),
      'failed', (SELECT count(*) FROM public.stripe_events e WHERE e.status = 'failed' AND e.received_at >= now() - make_interval(hours => p_hours))),
    'stuck', (SELECT count(*) FROM public.stripe_events e WHERE e.status = 'received' AND e.received_at < now() - interval '5 minutes'),
    'failed', coalesce((SELECT jsonb_agg(jsonb_build_object('eventId', f.event_id, 'type', f.event_type, 'error', left(f.error, 300), 'attempts', f.attempts, 'organisation', f.name, 'receivedAt', f.received_at) ORDER BY f.received_at DESC)
        FROM (SELECT e.*, o.name FROM public.stripe_events e LEFT JOIN public.organisations o ON o.id = e.organisation_id WHERE e.status = 'failed' ORDER BY e.received_at DESC LIMIT 25) f), '[]'::jsonb),
    'types', coalesce((SELECT jsonb_agg(jsonb_build_object('type', t.event_type, 'count', t.n) ORDER BY t.n DESC, t.event_type)
        FROM (SELECT e.event_type, count(*) AS n FROM public.stripe_events e WHERE e.received_at >= now() - make_interval(hours => p_hours) GROUP BY e.event_type ORDER BY count(*) DESC LIMIT 10) t), '[]'::jsonb));
END $$;

-- A combined feed: billing events, organisations started, set-ups finished, organisations archived. Facts about the business, not about anyone's quality records.
CREATE FUNCTION app.platform_activity(p_limit integer DEFAULT 50)
RETURNS TABLE (occurred_at timestamptz, kind text, event text, organisation_id uuid, organisation_name text, details jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT app.is_platform_admin() THEN RAISE EXCEPTION 'Platform administrators only' USING ERRCODE = '42501'; END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 200 THEN RAISE EXCEPTION 'Choose between 1 and 200 rows' USING ERRCODE = '22023'; END IF;
  RETURN QUERY
  SELECT a.at, a.kind, a.event, a.org, o.name, a.details
    FROM (
      SELECT l.created_at AS at, 'billing'::text AS kind, l.event_type AS event, l.organisation_id AS org, l.details - 'unitAmount' AS details FROM public.subscription_audit_logs l
      UNION ALL SELECT s.occurred_at, 'organisation', 'organisation_started', s.organisation_id, '{}'::jsonb FROM public.signup_events s WHERE s.event = 'org_started' AND s.organisation_id IS NOT NULL
      UNION ALL SELECT g.onboarding_completed_at, 'organisation', 'setup_finished', g.id, '{}'::jsonb FROM public.organisations g WHERE g.onboarding_completed_at IS NOT NULL
      UNION ALL SELECT g.archived_at, 'organisation', 'organisation_archived', g.id, jsonb_build_object('reason', g.archived_reason) FROM public.organisations g WHERE g.archived_at IS NOT NULL
    ) a
    JOIN public.organisations o ON o.id = a.org
   ORDER BY a.at DESC
   LIMIT p_limit;
END $$;

-- ---------------------------------------------------------------------------
-- The scheduled jobs (API login only)
-- ---------------------------------------------------------------------------
-- Stripe-billed subscriptions not synced for p_stale_minutes, oldest first (finished ones, over 30 days past their end, are left alone).
CREATE FUNCTION app.system_reconcile_candidates(p_limit integer DEFAULT 50, p_stale_minutes integer DEFAULT 60)
RETURNS TABLE (organisation_id uuid, provider_subscription_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT s.organisation_id, s.provider_subscription_id
    FROM public.organisation_subscriptions s
   WHERE s.billing_provider = 'stripe' AND s.provider_subscription_id IS NOT NULL
     AND (s.provider_synced_at IS NULL OR s.provider_synced_at < now() - make_interval(mins => greatest(p_stale_minutes, 1)))
     AND NOT (s.status = 'cancelled' AND coalesce(s.current_period_end, s.updated_at) < now() - interval '30 days')
   ORDER BY s.provider_synced_at NULLS FIRST, s.organisation_id
   LIMIT least(greatest(p_limit, 1), 200)
$$;

-- Archives organisations nobody uses (the two groups cannot overlap: one never had a real subscription, the other did). Dry run unless told otherwise. Never touches an organisation that does not require a subscription, or has a valid one.
--   unpaid_setup: must have a subscription, never had a real one, set-up not finished, older than p_unpaid_days
--   lapsed:       must have a subscription, it is no longer valid and has been that way for more than p_lapsed_days
CREATE FUNCTION app.system_archive_stale_organisations(p_unpaid_days integer DEFAULT 14, p_lapsed_days integer DEFAULT 90, p_dry_run boolean DEFAULT true) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_unpaid jsonb; v_lapsed jsonb; v_ids uuid[];
BEGIN
  IF p_unpaid_days IS NULL OR p_unpaid_days < 7 OR p_unpaid_days > 365 THEN RAISE EXCEPTION 'Unpaid set-ups are archived after 7 to 365 days' USING ERRCODE = '22023'; END IF;
  IF p_lapsed_days IS NULL OR p_lapsed_days < 30 OR p_lapsed_days > 730 THEN RAISE EXCEPTION 'Lapsed organisations are archived after 30 to 730 days' USING ERRCODE = '22023'; END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object('organisationId', o.id, 'name', o.name, 'createdAt', o.created_at) ORDER BY o.created_at), '[]'::jsonb) INTO v_unpaid
    FROM public.organisations o
   WHERE o.status = 'active' AND o.billing_required AND o.onboarding_completed_at IS NULL AND o.created_at < now() - make_interval(days => p_unpaid_days)
     AND NOT EXISTS (SELECT 1 FROM public.organisation_subscriptions s WHERE s.organisation_id = o.id AND s.status <> 'incomplete');

  SELECT coalesce(jsonb_agg(jsonb_build_object('organisationId', x.id, 'name', x.name, 'lapsedSince', x.lapsed_since) ORDER BY x.lapsed_since), '[]'::jsonb) INTO v_lapsed
    FROM (
      SELECT o.id, o.name,
             CASE s.status WHEN 'past_due' THEN coalesce(s.past_due_since, s.updated_at) + make_interval(days => coalesce(st.grace_period_days, 7))
                           WHEN 'cancelled' THEN coalesce(s.current_period_end, s.cancelled_at, s.updated_at)
                           ELSE s.updated_at END AS lapsed_since
        FROM public.organisations o
        JOIN public.organisation_subscriptions s ON s.organisation_id = o.id AND s.status <> 'incomplete'
        LEFT JOIN public.organisation_settings st ON st.organisation_id = o.id
       WHERE o.status = 'active' AND o.billing_required AND NOT app.organisation_subscription_valid(o.id)
    ) x
   WHERE x.lapsed_since < now() - make_interval(days => p_lapsed_days);

  IF NOT p_dry_run THEN
    SELECT coalesce(array_agg((e ->> 'organisationId')::uuid), ARRAY[]::uuid[]) INTO v_ids FROM jsonb_array_elements(v_unpaid) e;
    UPDATE public.organisations SET status = 'archived', archived_at = now(), archived_reason = 'unpaid_setup' WHERE id = ANY (v_ids) AND status = 'active';
    SELECT coalesce(array_agg((e ->> 'organisationId')::uuid), ARRAY[]::uuid[]) INTO v_ids FROM jsonb_array_elements(v_lapsed) e;
    UPDATE public.organisations SET status = 'archived', archived_at = now(), archived_reason = 'lapsed' WHERE id = ANY (v_ids) AND status = 'active';
  END IF;
  RETURN jsonb_build_object('dryRun', p_dry_run, 'unpaidDays', p_unpaid_days, 'lapsedDays', p_lapsed_days, 'unpaid', v_unpaid, 'lapsed', v_lapsed,
                            'archived', CASE WHEN p_dry_run THEN 0 ELSE jsonb_array_length(v_unpaid) + jsonb_array_length(v_lapsed) END);
END $$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app.subscription_monthly_pence(uuid), app.platform_organisations(text, integer, integer), app.platform_revenue(), app.platform_payments(integer), app.platform_webhooks(integer),
  app.platform_activity(integer), app.system_reconcile_candidates(integer, integer), app.system_archive_stale_organisations(integer, integer, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.platform_organisations(text, integer, integer), app.platform_revenue(), app.platform_payments(integer), app.platform_webhooks(integer), app.platform_activity(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION app.system_reconcile_candidates(integer, integer), app.system_archive_stale_organisations(integer, integer, boolean) TO qms_api;
