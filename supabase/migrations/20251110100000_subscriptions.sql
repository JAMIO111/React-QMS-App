-- Subscription, billing and entitlement (phases 1-2 of the subscription brief; no payment provider yet).
--
-- Two independent systems:
--   * RBAC (roles / permissions)   - what a member is authorised to do. Unchanged.
--   * Subscription entitlement     - what the organisation has bought and which package a member consumes.
-- A restricted action needs both: app.has_permission() now also asks app.has_entitlement(). Package names
-- are never roles or permissions. Billing has its own permissions (subscription.*, invoices.read, ...).
--
-- Rollout safety: entitlements are only enforced for organisations with
-- organisation_settings.entitlements_enforced = true (platform-controlled, not writable by tenants).
-- Existing organisations stay off until they have a subscription and seat assignments.
--
-- Tenants only read the billing tables; every write goes through SECURITY DEFINER functions that check
-- the billing permission, validate seats and write subscription_audit_logs. A payment provider (later)
-- will write through the service role from verified webhooks.

-- ---------------------------------------------------------------------------
-- Billing permissions (independent of QMS approval permissions)
-- ---------------------------------------------------------------------------
INSERT INTO public.permissions (code, description) VALUES
  ('subscription.read',      'View the organisation subscription and seat usage'),
  ('subscription.manage',    'Change, cancel and purchase seats on the organisation subscription'),
  ('subscription.seats',     'Assign and remove subscription packages for members'),
  ('invoices.read',          'View invoices and payments'),
  ('payment_methods.manage', 'Update payment methods through the payment provider'),
  ('billing_details.manage', 'Update billing details');

WITH grants(key, perms) AS (VALUES
  ('owner', ARRAY['subscription.read', 'subscription.manage', 'subscription.seats', 'invoices.read', 'payment_methods.manage', 'billing_details.manage']),
  ('admin', ARRAY['subscription.read', 'subscription.manage', 'subscription.seats', 'invoices.read', 'payment_methods.manage', 'billing_details.manage'])
)
INSERT INTO public.role_permissions (role_id, permission_code)
SELECT r.id, unnest(g.perms) FROM public.roles r JOIN grants g ON g.key = r.key WHERE r.is_system
ON CONFLICT DO NOTHING;

ALTER TABLE public.organisation_settings
  ADD COLUMN entitlements_enforced boolean NOT NULL DEFAULT false,
  ADD COLUMN grace_period_days integer NOT NULL DEFAULT 7 CHECK (grace_period_days BETWEEN 0 AND 90);

-- ---------------------------------------------------------------------------
-- Global catalogue (read-only for tenants): plans, prices, modules, features, entitlements
-- ---------------------------------------------------------------------------
CREATE TABLE public.subscription_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z][a-z0-9_]{1,39}$'),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  description text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  display_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Amounts are integer pence (minor units). Old prices are kept (effective_to) so subscriptions reconcile.
CREATE TABLE public.subscription_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_plan_id uuid NOT NULL REFERENCES public.subscription_plans (id),
  billing_interval text NOT NULL CHECK (billing_interval IN ('month', 'year')),
  currency text NOT NULL DEFAULT 'GBP' CHECK (currency ~ '^[A-Z]{3}$'),
  unit_amount integer NOT NULL CHECK (unit_amount >= 0),
  tax_behaviour text NOT NULL DEFAULT 'exclusive' CHECK (tax_behaviour IN ('exclusive', 'inclusive')),
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscription_prices_period CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE UNIQUE INDEX subscription_prices_current_key
  ON public.subscription_prices (subscription_plan_id, billing_interval, currency) WHERE active AND effective_to IS NULL;

CREATE TABLE public.modules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z][a-z0-9_]{1,39}$'),
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'planned', 'retired')),
  navigation_group text,
  display_order integer NOT NULL DEFAULT 0
);

-- A feature is a capability within a module. permission_code links it to the RBAC permission whose use
-- it restricts (unique: one permission belongs to at most one feature). Permissions without a feature
-- (members, billing, audit, master data, ...) are not subscription-restricted.
CREATE TABLE public.features (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id uuid NOT NULL REFERENCES public.modules (id) ON DELETE CASCADE,
  slug text NOT NULL CHECK (slug ~ '^[a-z][a-z0-9_]{1,59}$'),
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'planned', 'retired')),
  min_access_level text NOT NULL DEFAULT 'view' CHECK (min_access_level IN ('view', 'operational', 'full')),
  permission_code text REFERENCES public.permissions (code),
  UNIQUE (module_id, slug)
);
CREATE UNIQUE INDEX features_permission_key ON public.features (permission_code) WHERE permission_code IS NOT NULL;

-- feature_id NULL = the level for the whole module; a feature row overrides it for that feature.
CREATE TABLE public.subscription_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_plan_id uuid NOT NULL REFERENCES public.subscription_plans (id) ON DELETE CASCADE,
  module_id uuid NOT NULL REFERENCES public.modules (id) ON DELETE CASCADE,
  feature_id uuid REFERENCES public.features (id) ON DELETE CASCADE,
  access_level text NOT NULL CHECK (access_level IN ('none', 'view', 'operational', 'full')),
  enabled boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX subscription_entitlements_module_key
  ON public.subscription_entitlements (subscription_plan_id, module_id) WHERE feature_id IS NULL;
CREATE UNIQUE INDEX subscription_entitlements_feature_key
  ON public.subscription_entitlements (subscription_plan_id, feature_id) WHERE feature_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Tenant tables
-- ---------------------------------------------------------------------------
CREATE TABLE public.organisation_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL UNIQUE REFERENCES public.organisations (id) ON DELETE CASCADE,
  billing_provider text NOT NULL DEFAULT 'manual' CHECK (billing_provider IN ('manual', 'stripe')),
  provider_customer_id text,
  provider_subscription_id text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('trialing', 'active', 'past_due', 'unpaid', 'paused', 'cancelled', 'incomplete')),
  billing_interval text NOT NULL DEFAULT 'month' CHECK (billing_interval IN ('month', 'year')),
  currency text NOT NULL DEFAULT 'GBP' CHECK (currency ~ '^[A-Z]{3}$'),
  current_period_start timestamptz NOT NULL DEFAULT now(),
  current_period_end timestamptz,
  trial_start timestamptz,
  trial_end timestamptz,
  past_due_since timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT organisation_subscriptions_id_org_key UNIQUE (id, organisation_id)
);
CREATE UNIQUE INDEX organisation_subscriptions_provider_key
  ON public.organisation_subscriptions (billing_provider, provider_subscription_id) WHERE provider_subscription_id IS NOT NULL;

CREATE TABLE public.organisation_subscription_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  organisation_subscription_id uuid NOT NULL,
  subscription_plan_id uuid NOT NULL REFERENCES public.subscription_plans (id),
  subscription_price_id uuid NOT NULL REFERENCES public.subscription_prices (id),
  quantity integer NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  unit_amount_snapshot integer NOT NULL CHECK (unit_amount_snapshot >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT organisation_subscription_items_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT organisation_subscription_items_sub_fkey FOREIGN KEY (organisation_subscription_id, organisation_id)
    REFERENCES public.organisation_subscriptions (id, organisation_id) ON DELETE CASCADE,
  UNIQUE (organisation_subscription_id, subscription_plan_id)
);

-- History: a package change ends the old row and inserts a new one.
CREATE TABLE public.user_subscription_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  organisation_membership_id uuid NOT NULL,
  subscription_plan_id uuid NOT NULL REFERENCES public.subscription_plans (id),
  subscription_item_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  assigned_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  ended_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT user_subscription_assignments_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT user_subscription_assignments_membership_fkey FOREIGN KEY (organisation_membership_id, organisation_id)
    REFERENCES public.organisation_users (id, organisation_id) ON DELETE CASCADE,
  CONSTRAINT user_subscription_assignments_item_fkey FOREIGN KEY (subscription_item_id, organisation_id)
    REFERENCES public.organisation_subscription_items (id, organisation_id),
  CONSTRAINT user_subscription_assignments_ended CHECK ((status = 'ended') = (effective_to IS NOT NULL))
);
CREATE UNIQUE INDEX user_subscription_assignments_one_active
  ON public.user_subscription_assignments (organisation_membership_id) WHERE status = 'active';
CREATE INDEX user_subscription_assignments_item_idx ON public.user_subscription_assignments (subscription_item_id) WHERE status = 'active';

CREATE TABLE public.billing_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  provider_invoice_id text,
  invoice_number text,
  currency text NOT NULL DEFAULT 'GBP' CHECK (currency ~ '^[A-Z]{3}$'),
  subtotal bigint NOT NULL CHECK (subtotal >= 0),
  tax_amount bigint NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  total_amount bigint NOT NULL CHECK (total_amount >= 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'paid', 'void', 'uncollectible')),
  period_start timestamptz,
  period_end timestamptz,
  invoice_date date,
  due_date date,
  paid_at timestamptz,
  invoice_pdf_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT billing_invoices_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT billing_invoices_total CHECK (total_amount = subtotal + tax_amount)
);
CREATE UNIQUE INDEX billing_invoices_provider_key ON public.billing_invoices (organisation_id, provider_invoice_id) WHERE provider_invoice_id IS NOT NULL;

-- Never holds card data: payment_method_reference is the provider's opaque id.
CREATE TABLE public.billing_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  provider_payment_id text,
  invoice_id uuid,
  amount bigint NOT NULL CHECK (amount >= 0),
  currency text NOT NULL DEFAULT 'GBP' CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'refunded')),
  payment_method_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT billing_payments_invoice_fkey FOREIGN KEY (invoice_id, organisation_id)
    REFERENCES public.billing_invoices (id, organisation_id)
);
CREATE UNIQUE INDEX billing_payments_provider_key ON public.billing_payments (organisation_id, provider_payment_id) WHERE provider_payment_id IS NOT NULL;

-- Append-only subscription history (assignments, upgrades/downgrades, seats, interval, payment failures, ...).
CREATE TABLE public.subscription_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN (
    'subscription_created', 'package_assigned', 'package_upgraded', 'package_downgraded', 'assignment_removed',
    'seats_added', 'seats_removed', 'billing_interval_changed', 'payment_failed', 'cancellation_requested', 'admin_override')),
  actor_user_id uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  organisation_membership_id uuid,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subscription_audit_logs_org_idx ON public.subscription_audit_logs (organisation_id, created_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['organisation_subscriptions', 'organisation_subscription_items', 'user_subscription_assignments',
                           'billing_invoices', 'billing_payments'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION app.stamp_created()', t || '_stamp', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.touch_updated()', t || '_touch', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change()', t || '_org_immutable', t);
    EXECUTE format('CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION audit.record_change(%L)', t, 'organisation_id');
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Row level security: read-only for tenants
-- ---------------------------------------------------------------------------
ALTER TABLE public.subscription_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.features ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organisation_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organisation_subscription_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_subscription_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_audit_logs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.subscription_plans, public.subscription_prices, public.modules, public.features,
  public.subscription_entitlements, public.organisation_subscriptions, public.organisation_subscription_items,
  public.user_subscription_assignments, public.billing_invoices, public.billing_payments, public.subscription_audit_logs
  FROM anon, authenticated;
GRANT SELECT ON public.subscription_plans, public.subscription_prices, public.modules, public.features,
  public.subscription_entitlements, public.organisation_subscriptions, public.organisation_subscription_items,
  public.user_subscription_assignments, public.billing_invoices, public.billing_payments, public.subscription_audit_logs
  TO authenticated;

CREATE POLICY subscription_plans_select ON public.subscription_plans FOR SELECT TO authenticated USING (true);
CREATE POLICY subscription_prices_select ON public.subscription_prices FOR SELECT TO authenticated USING (true);
CREATE POLICY modules_select ON public.modules FOR SELECT TO authenticated USING (true);
CREATE POLICY features_select ON public.features FOR SELECT TO authenticated USING (true);
CREATE POLICY subscription_entitlements_select ON public.subscription_entitlements FOR SELECT TO authenticated USING (true);

CREATE POLICY organisation_subscriptions_select ON public.organisation_subscriptions FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'subscription.read'));
CREATE POLICY organisation_subscription_items_select ON public.organisation_subscription_items FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'subscription.read'));
CREATE POLICY user_subscription_assignments_select ON public.user_subscription_assignments FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'subscription.read') OR app.has_permission(organisation_id, 'subscription.seats'));
CREATE POLICY billing_invoices_select ON public.billing_invoices FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'invoices.read'));
CREATE POLICY billing_payments_select ON public.billing_payments FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'invoices.read'));
CREATE POLICY subscription_audit_logs_select ON public.subscription_audit_logs FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'subscription.read'));

-- ---------------------------------------------------------------------------
-- Seed: packages, prices (annual = ten monthly payments), modules, features, entitlements
-- ---------------------------------------------------------------------------
INSERT INTO public.subscription_plans (slug, name, description, display_order) VALUES
  ('observer',    'Observer',    'Read-only access to company quality information.', 1),
  ('contributor', 'Contributor', 'Operational interaction with the QMS: record results, submit and complete assigned work.', 2),
  ('controller',  'Controller',  'Full application functionality, subject to company permissions.', 3);

INSERT INTO public.subscription_prices (subscription_plan_id, billing_interval, currency, unit_amount)
SELECT p.id, i.interval, 'GBP', CASE p.slug WHEN 'observer' THEN 500 WHEN 'contributor' THEN 1000 ELSE 2500 END
       * CASE i.interval WHEN 'month' THEN 1 ELSE 10 END
FROM public.subscription_plans p CROSS JOIN (VALUES ('month'), ('year')) AS i(interval);

INSERT INTO public.modules (slug, name, status, navigation_group, display_order) VALUES
  ('document_control',  'Document Control',  'planned', 'Quality', 1),
  ('nonconformance',    'Nonconformance',    'active',  'Quality', 2),
  ('capa',              'CAPA',              'planned', 'Quality', 3),
  ('audits',            'Audits',            'planned', 'Quality', 4),
  ('calibration',       'Calibration',       'active',  'Quality', 5),
  ('control_plans',     'Control Plans',     'active',  'Process control', 6),
  ('inspections',       'Inspections',       'active',  'Process control', 7),
  ('supplier_quality',  'Supplier Quality',  'planned', 'Quality', 8),
  ('risk_management',   'Risk Management',   'planned', 'Quality', 9),
  ('analytics',         'Analytics',         'active',  'Insight', 10);

INSERT INTO public.features (module_id, slug, name, min_access_level, permission_code)
SELECT m.id, f.slug, f.name, f.level, f.perm
FROM (VALUES
  ('nonconformance', 'view_ncrs',            'View nonconformances',              'view',        'ncr.read'),
  ('nonconformance', 'create_ncrs',          'Submit nonconformances',            'operational', 'ncr.create'),
  ('nonconformance', 'edit_ncrs',            'Update nonconformances',            'full',        'ncr.update'),
  ('nonconformance', 'delete_ncrs',          'Delete nonconformances',            'full',        'ncr.delete'),
  ('calibration',    'view_equipment',       'View gauges and calibrations',      'view',        'calibration.read'),
  ('calibration',    'record_calibration',   'Record calibrations',               'operational', 'calibration.record'),
  ('calibration',    'manage_calibration',   'Manage gauges and schedules',       'full',        'calibration.manage'),
  ('control_plans',  'view_control_plans',   'View control plans',                'view',        'process_control.read'),
  ('control_plans',  'manage_control_plans', 'Create and edit plans and revisions','full',       'process_control.manage'),
  ('control_plans',  'release_revisions',    'Release plan revisions',            'full',        'process_control.approve'),
  ('inspections',    'view_inspections',     'View inspections and results',      'view',        'inspection.read'),
  ('inspections',    'record_inspections',   'Record inspection measurements',    'operational', 'inspection.record'),
  ('inspections',    'correct_measurements', 'Correct recorded measurements',     'full',        'inspection.correct'),
  ('inspections',    'override_gauge',       'Record with an invalid gauge',      'full',        'inspection.override_gauge')
) AS f(module, slug, name, level, perm)
JOIN public.modules m ON m.slug = f.module;

-- Initial matrix: Observer views everything; Contributor operates; Controller has full functionality.
INSERT INTO public.subscription_entitlements (subscription_plan_id, module_id, access_level)
SELECT p.id, m.id,
  CASE p.slug
    WHEN 'controller' THEN 'full'
    WHEN 'observer' THEN 'view'
    ELSE CASE WHEN m.slug IN ('control_plans', 'risk_management', 'analytics') THEN 'view' ELSE 'operational' END
  END
FROM public.subscription_plans p CROSS JOIN public.modules m;

-- ---------------------------------------------------------------------------
-- Entitlement engine
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.access_level_rank(p_level text) RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE p_level WHEN 'none' THEN 0 WHEN 'view' THEN 1 WHEN 'operational' THEN 2 WHEN 'full' THEN 3 END
$$;

-- Why (if at all) the caller's subscription state blocks access in this organisation. reason IS NULL = fine.
CREATE FUNCTION app.subscription_state(p_organisation_id uuid)
RETURNS TABLE (reason text, plan_id uuid, plan_slug text, plan_name text, membership_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_membership uuid;
  v_sub public.organisation_subscriptions%ROWTYPE;
  v_grace integer;
  v_assign public.user_subscription_assignments%ROWTYPE;
  v_reason text;
BEGIN
  SELECT m.id INTO v_membership FROM public.organisation_users m
   WHERE m.organisation_id = p_organisation_id AND m.user_id = auth.uid() AND m.status = 'active';
  IF v_membership IS NULL THEN
    RETURN QUERY SELECT 'not_a_member'::text, NULL::uuid, NULL::text, NULL::text, NULL::uuid; RETURN;
  END IF;

  SELECT * INTO v_sub FROM public.organisation_subscriptions s WHERE s.organisation_id = p_organisation_id;
  IF NOT FOUND THEN v_reason := 'no_active_subscription';
  ELSIF v_sub.status IN ('active', 'trialing') THEN v_reason := NULL;
  ELSIF v_sub.status = 'past_due' THEN
    SELECT s.grace_period_days INTO v_grace FROM public.organisation_settings s WHERE s.organisation_id = p_organisation_id;
    v_reason := CASE WHEN coalesce(v_sub.past_due_since, now()) + make_interval(days => coalesce(v_grace, 7)) > now()
                     THEN NULL ELSE 'payment_overdue' END;
  ELSIF v_sub.status = 'unpaid' THEN v_reason := 'payment_overdue';
  ELSIF v_sub.status = 'paused' THEN v_reason := 'subscription_suspended';
  ELSE v_reason := 'no_active_subscription';
  END IF;
  -- A subscription cancelled at period end keeps working until the period ends.
  IF v_reason IS NOT NULL AND v_sub.status = 'cancelled' AND v_sub.current_period_end > now() THEN v_reason := NULL; END IF;

  SELECT a.* INTO v_assign FROM public.user_subscription_assignments a
   WHERE a.organisation_membership_id = v_membership AND a.status = 'active'
     AND a.effective_from <= now() AND (a.effective_to IS NULL OR a.effective_to > now());
  IF NOT FOUND THEN
    RETURN QUERY SELECT coalesce(v_reason, 'no_seat_assigned'), NULL::uuid, NULL::text, NULL::text, v_membership; RETURN;
  END IF;

  IF v_reason IS NULL AND (
       SELECT i.quantity FROM public.organisation_subscription_items i WHERE i.id = v_assign.subscription_item_id)
     < (SELECT count(*) FROM public.user_subscription_assignments x
         WHERE x.subscription_item_id = v_assign.subscription_item_id AND x.status = 'active') THEN
    v_reason := 'insufficient_seats';
  END IF;

  RETURN QUERY SELECT v_reason, p.id, p.slug, p.name, v_membership FROM public.subscription_plans p WHERE p.id = v_assign.subscription_plan_id;
END $$;

-- checkSubscriptionEntitlement(organisation, module, feature) for the signed-in user.
CREATE FUNCTION app.check_entitlement(p_organisation_id uuid, p_module_slug text, p_feature_slug text DEFAULT NULL)
RETURNS TABLE (allowed boolean, reason text, current_plan text, required_plan text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_state record;
  v_module uuid;
  v_feature uuid;
  v_need integer := 1;
  v_have integer := 0;
  v_required text;
BEGIN
  IF NOT coalesce((SELECT s.entitlements_enforced FROM public.organisation_settings s WHERE s.organisation_id = p_organisation_id), false) THEN
    RETURN QUERY SELECT true, 'not_enforced'::text, NULL::text, NULL::text; RETURN;
  END IF;

  SELECT m.id INTO v_module FROM public.modules m WHERE m.slug = p_module_slug;
  IF v_module IS NULL THEN
    RETURN QUERY SELECT false, 'module_not_included'::text, NULL::text, NULL::text; RETURN;
  END IF;
  IF p_feature_slug IS NOT NULL THEN
    SELECT f.id, app.access_level_rank(f.min_access_level) INTO v_feature, v_need
      FROM public.features f WHERE f.module_id = v_module AND f.slug = p_feature_slug;
    IF v_feature IS NULL THEN
      RETURN QUERY SELECT false, 'feature_not_included'::text, NULL::text, NULL::text; RETURN;
    END IF;
  END IF;

  SELECT * INTO v_state FROM app.subscription_state(p_organisation_id);
  IF v_state.reason IS NOT NULL THEN
    RETURN QUERY SELECT false, v_state.reason, v_state.plan_name, NULL::text; RETURN;
  END IF;

  SELECT CASE WHEN e.enabled THEN app.access_level_rank(e.access_level) ELSE 0 END INTO v_have
    FROM public.subscription_entitlements e
   WHERE e.subscription_plan_id = v_state.plan_id AND e.module_id = v_module
     AND (e.feature_id = v_feature OR e.feature_id IS NULL)
   ORDER BY (e.feature_id IS NULL) LIMIT 1;
  v_have := coalesce(v_have, 0);

  IF v_have >= v_need THEN
    RETURN QUERY SELECT true, 'allowed'::text, v_state.plan_name, NULL::text; RETURN;
  END IF;

  SELECT p.name INTO v_required FROM public.subscription_plans p
   JOIN public.subscription_entitlements e ON e.subscription_plan_id = p.id AND e.module_id = v_module AND e.feature_id IS NULL
   WHERE p.status = 'active' AND e.enabled AND app.access_level_rank(e.access_level) >= v_need
   ORDER BY p.display_order LIMIT 1;
  RETURN QUERY SELECT false, CASE WHEN v_have = 0 THEN 'module_not_included' ELSE 'feature_not_included' END,
                       v_state.plan_name, v_required;
END $$;

-- Subscription half of a permission check. Permissions that no feature maps to are not restricted.
CREATE FUNCTION app.has_entitlement(p_organisation_id uuid, p_permission text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_module text;
  v_feature text;
BEGIN
  IF NOT coalesce((SELECT s.entitlements_enforced FROM public.organisation_settings s WHERE s.organisation_id = p_organisation_id), false) THEN
    RETURN true;
  END IF;
  SELECT m.slug, f.slug INTO v_module, v_feature
    FROM public.features f JOIN public.modules m ON m.id = f.module_id WHERE f.permission_code = p_permission;
  IF v_module IS NULL THEN RETURN true; END IF;
  RETURN (SELECT c.allowed FROM app.check_entitlement(p_organisation_id, v_module, v_feature) c);
END $$;

-- What the client needs to hide or explain things: plan, access level per module, and why access is blocked.
CREATE FUNCTION app.my_subscription_access(p_organisation_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_enforced boolean;
  v_state record;
  v_modules jsonb;
BEGIN
  IF NOT app.is_member(p_organisation_id) THEN RETURN NULL; END IF;
  v_enforced := coalesce((SELECT s.entitlements_enforced FROM public.organisation_settings s WHERE s.organisation_id = p_organisation_id), false);
  IF NOT v_enforced THEN
    SELECT jsonb_object_agg(m.slug, 'full') INTO v_modules FROM public.modules m;
    RETURN jsonb_build_object('enforced', false, 'reason', NULL, 'plan', NULL, 'modules', v_modules);
  END IF;
  SELECT * INTO v_state FROM app.subscription_state(p_organisation_id);
  SELECT jsonb_object_agg(m.slug, CASE WHEN v_state.reason IS NOT NULL THEN 'none' ELSE coalesce((
           SELECT CASE WHEN e.enabled THEN e.access_level ELSE 'none' END FROM public.subscription_entitlements e
            WHERE e.subscription_plan_id = v_state.plan_id AND e.module_id = m.id AND e.feature_id IS NULL), 'none') END)
    INTO v_modules FROM public.modules m;
  RETURN jsonb_build_object('enforced', true, 'reason', v_state.reason,
    'plan', CASE WHEN v_state.plan_id IS NULL THEN NULL ELSE jsonb_build_object('slug', v_state.plan_slug, 'name', v_state.plan_name) END,
    'modules', v_modules);
END $$;

-- RBAC AND subscription: the permission check every policy and API route already uses.
CREATE OR REPLACE FUNCTION app.has_permission(
  p_organisation_id uuid, p_permission text, p_site_id uuid DEFAULT NULL, p_department_id uuid DEFAULT NULL
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organisation_users m
    JOIN public.organisations o ON o.id = m.organisation_id AND o.status = 'active'
    JOIN public.user_role_assignments a ON a.membership_id = m.id
    JOIN public.role_permissions rp ON rp.role_id = a.role_id
    WHERE m.organisation_id = p_organisation_id
      AND m.user_id = auth.uid()
      AND m.status = 'active'
      AND rp.permission_code = p_permission
      AND (a.site_id IS NULL OR a.site_id = p_site_id)
      AND (a.department_id IS NULL OR a.department_id = p_department_id)
  ) AND app.mfa_satisfied(p_organisation_id) AND app.has_entitlement(p_organisation_id, p_permission)
$$;

CREATE OR REPLACE FUNCTION app.has_permission_somewhere(p_organisation_id uuid, p_permission text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organisation_users m
    JOIN public.organisations o ON o.id = m.organisation_id AND o.status = 'active'
    JOIN public.user_role_assignments a ON a.membership_id = m.id
    JOIN public.role_permissions rp ON rp.role_id = a.role_id
    WHERE m.organisation_id = p_organisation_id AND m.user_id = auth.uid() AND m.status = 'active'
      AND rp.permission_code = p_permission
  ) AND app.mfa_satisfied(p_organisation_id) AND app.has_entitlement(p_organisation_id, p_permission)
$$;

-- ---------------------------------------------------------------------------
-- Seats and assignments (all tenant writes go through these functions)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.log_subscription_event(p_organisation_id uuid, p_event text, p_membership_id uuid, p_details jsonb)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO public.subscription_audit_logs (organisation_id, event_type, organisation_membership_id, details)
  VALUES (p_organisation_id, p_event, p_membership_id, coalesce(p_details, '{}'::jsonb))
$$;

-- Backstop: the active assignments on an item can never exceed its purchased quantity.
CREATE FUNCTION app.check_seat_capacity() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_qty integer; v_used integer;
BEGIN
  IF NEW.status = 'active' THEN
    SELECT i.quantity INTO v_qty FROM public.organisation_subscription_items i WHERE i.id = NEW.subscription_item_id FOR UPDATE;
    SELECT count(*) INTO v_used FROM public.user_subscription_assignments a
     WHERE a.subscription_item_id = NEW.subscription_item_id AND a.status = 'active' AND a.id <> NEW.id;
    IF v_used >= coalesce(v_qty, 0) THEN
      RAISE EXCEPTION 'There are no free seats for this package. Purchase more seats first.' USING ERRCODE = 'QM009';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER user_subscription_assignments_seats BEFORE INSERT OR UPDATE OF status, subscription_item_id
  ON public.user_subscription_assignments FOR EACH ROW EXECUTE FUNCTION app.check_seat_capacity();

-- Sets the purchased quantity of a package, creating the subscription on first use. Manual billing only:
-- with a payment provider the quantity will come from provider-confirmed state instead.
CREATE FUNCTION app.set_subscription_seats(p_organisation_id uuid, p_plan_slug text, p_quantity integer, p_interval text DEFAULT NULL)
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

-- Gives a member a package (ending any current one: upgrade/downgrade). Refused without a free seat.
CREATE FUNCTION app.assign_subscription_package(p_membership_id uuid, p_plan_slug text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_org uuid;
  v_sub public.organisation_subscriptions%ROWTYPE;
  v_plan public.subscription_plans%ROWTYPE;
  v_item public.organisation_subscription_items%ROWTYPE;
  v_cur public.user_subscription_assignments%ROWTYPE;
  v_cur_order integer;
  v_new uuid;
BEGIN
  SELECT m.organisation_id INTO v_org FROM public.organisation_users m WHERE m.id = p_membership_id;
  IF v_org IS NULL OR NOT app.has_permission(v_org, 'subscription.seats') THEN
    RAISE EXCEPTION 'Not allowed to assign subscription packages' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_plan FROM public.subscription_plans WHERE slug = p_plan_slug AND status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown subscription package.' USING ERRCODE = 'QM009'; END IF;
  SELECT * INTO v_sub FROM public.organisation_subscriptions WHERE organisation_id = v_org;
  IF NOT FOUND OR v_sub.status IN ('cancelled', 'incomplete') THEN
    RAISE EXCEPTION 'The organisation has no active subscription.' USING ERRCODE = 'QM009';
  END IF;
  SELECT * INTO v_item FROM public.organisation_subscription_items
   WHERE organisation_subscription_id = v_sub.id AND subscription_plan_id = v_plan.id FOR UPDATE;
  IF NOT FOUND OR v_item.quantity = 0 THEN
    RAISE EXCEPTION 'No seats have been purchased for %. Purchase seats first.', v_plan.name USING ERRCODE = 'QM009';
  END IF;

  SELECT * INTO v_cur FROM public.user_subscription_assignments WHERE organisation_membership_id = p_membership_id AND status = 'active';
  IF FOUND THEN
    IF v_cur.subscription_plan_id = v_plan.id THEN RETURN v_cur.id; END IF;
    UPDATE public.user_subscription_assignments SET status = 'ended', effective_to = now(), ended_by = auth.uid() WHERE id = v_cur.id;
    SELECT display_order INTO v_cur_order FROM public.subscription_plans WHERE id = v_cur.subscription_plan_id;
  END IF;

  INSERT INTO public.user_subscription_assignments (organisation_id, organisation_membership_id, subscription_plan_id, subscription_item_id)
  VALUES (v_org, p_membership_id, v_plan.id, v_item.id) RETURNING id INTO v_new;

  PERFORM app.log_subscription_event(v_org,
    CASE WHEN v_cur.id IS NULL THEN 'package_assigned' WHEN v_plan.display_order > v_cur_order THEN 'package_upgraded' ELSE 'package_downgraded' END,
    p_membership_id, jsonb_build_object('plan', v_plan.slug, 'previousPlanId', v_cur.subscription_plan_id));
  RETURN v_new;
END $$;

-- Removes the package only. The membership, its roles and company permissions are untouched.
CREATE FUNCTION app.remove_subscription_assignment(p_membership_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_org uuid;
  v_cur public.user_subscription_assignments%ROWTYPE;
BEGIN
  SELECT m.organisation_id INTO v_org FROM public.organisation_users m WHERE m.id = p_membership_id;
  IF v_org IS NULL OR NOT app.has_permission(v_org, 'subscription.seats') THEN
    RAISE EXCEPTION 'Not allowed to remove subscription packages' USING ERRCODE = '42501';
  END IF;
  UPDATE public.user_subscription_assignments SET status = 'ended', effective_to = now(), ended_by = auth.uid()
   WHERE organisation_membership_id = p_membership_id AND status = 'active' RETURNING * INTO v_cur;
  IF v_cur.id IS NOT NULL THEN
    PERFORM app.log_subscription_event(v_org, 'assignment_removed', p_membership_id, jsonb_build_object('planId', v_cur.subscription_plan_id));
  END IF;
END $$;

-- Seat directory: members with their company roles and subscription package as separate fields. Billing
-- administrators may lack members.read, so this reads through its own permission.
CREATE FUNCTION app.list_seat_assignments(p_organisation_id uuid)
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

REVOKE ALL ON FUNCTION app.access_level_rank(text), app.subscription_state(uuid), app.check_entitlement(uuid, text, text),
  app.has_entitlement(uuid, text), app.my_subscription_access(uuid), app.log_subscription_event(uuid, text, uuid, jsonb),
  app.check_seat_capacity(), app.set_subscription_seats(uuid, text, integer, text),
  app.assign_subscription_package(uuid, text), app.remove_subscription_assignment(uuid), app.list_seat_assignments(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.check_entitlement(uuid, text, text), app.my_subscription_access(uuid),
  app.set_subscription_seats(uuid, text, integer, text), app.assign_subscription_package(uuid, text),
  app.remove_subscription_assignment(uuid), app.list_seat_assignments(uuid) TO authenticated;
