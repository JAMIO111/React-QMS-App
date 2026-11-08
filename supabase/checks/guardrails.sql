-- Security guardrails for the whole schema (Phase 1 exit check). Creates the session-local view
-- pg_temp.guardrail_violations and selects from it: one row per violation, empty when every rule
-- holds. Changes nothing persistent, so it is safe to run against the live project too.
-- Used by supabase/tests/guardrails.test.sql.
--
-- Rules
--  1. Every table in public/audit has RLS enabled and at least one SELECT policy.
--  2. Every public table is tenant-owned (organisation_id NOT NULL) unless reviewed as global/shared.
--  3. If signed-in users may UPDATE a tenant row's organisation_id, a trigger must forbid the change.
--  4. anon has no privilege on any table, view, sequence or function in public/app/audit.
--  5. Signed-in users cannot TRUNCATE (bypasses RLS) or write to app/audit tables.
--  6. Every view in public runs with the caller's permissions (security_invoker).
--  7. Every function in public/app/audit has a fixed search_path.
--  8. Quality-critical and access-control tables are covered by the audit trigger.
CREATE OR REPLACE TEMP VIEW guardrail_violations AS
WITH
tables AS (
  SELECT c.oid, n.nspname, c.relname, c.relkind, c.relrowsecurity, c.reloptions
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'app', 'audit') AND c.relkind IN ('r', 'v', 'S')
),
tenant_columns AS MATERIALIZED (
  SELECT t.oid, t.relname FROM tables t
  JOIN pg_attribute a ON a.attrelid = t.oid AND a.attname = 'organisation_id' AND NOT a.attisdropped
  WHERE t.nspname = 'public' AND t.relkind = 'r'
),
updatable_org AS MATERIALIZED (
  SELECT oid, relname FROM tenant_columns
  WHERE has_column_privilege('authenticated', oid, 'organisation_id', 'UPDATE')
),
global_tables(relname, why) AS (VALUES
  ('organisations',    'the tenant itself (id is the organisation)'),
  ('profiles',         'one per login; visible only to self and co-members'),
  ('permissions',      'global catalogue, read-only'),
  ('roles',            'system templates have no organisation; org roles carry organisation_id'),
  ('role_permissions', 'scoped through roles'),
  ('units',            'global catalogue of measurement units, read-only'),
  ('subscription_plans',        'global commercial catalogue, read-only'),
  ('notification_event_types',  'global catalogue of notification events, read-only'),
  ('subscription_prices',       'global commercial catalogue, read-only'),
  ('modules',                   'global module catalogue, read-only'),
  ('features',                  'global feature catalogue, read-only'),
  ('subscription_entitlements', 'global package-to-feature mapping, read-only'),
  ('platform_admins',            'operator allow-list, read only by platform admins with an MFA session'),
  ('signup_events',              'sign-up funnel written by triggers, read only by platform admins with an MFA session'),
  ('platform_settings',          'operator switches (billing gate), changed by SQL, read only by platform admins with an MFA session'),
  ('stripe_events',              'webhook log written by functions for the API login only, read only by platform admins with an MFA session (organisation_id is for the operator, not for tenants)')
),
audited(relname) AS (VALUES
  ('organisations'), ('organisation_settings'), ('sites'), ('departments'), ('organisation_users'),
  ('roles'), ('role_permissions'), ('user_role_assignments'),
  ('customers'), ('suppliers'), ('parts'), ('part_revisions'), ('ncr_classifications'), ('nonconformances'),
  ('ncr_costs'), ('ncr_attachments'), ('ncr_containment_actions'), ('ncr_dispositions'), ('ncr_affected_lots'),
  ('gauge_types'), ('gauge_type_characteristics'), ('gauges'), ('gauge_characteristics'), ('calibrations'),
  ('calibration_readings'), ('calibration_attachments'),
  ('machines'), ('part_families'), ('part_revision_characteristics'), ('control_plans'),
  ('control_plan_applicability'), ('control_plan_revisions'),
  ('control_plan_operations'), ('control_plan_characteristics'), ('characteristic_applicability'),
  ('sampling_rules'), ('reaction_plans'), ('characteristic_templates'), ('part_customers'),
  ('inspection_records'), ('resolved_inspection_requirements'), ('inspection_samples'), ('inspection_measurements'),
  ('organisation_subscriptions'), ('organisation_subscription_items'), ('user_subscription_assignments'),
  ('billing_invoices'), ('billing_payments'),
  ('inspection_ncr_links'), ('inspection_failure_acknowledgements'), ('spc_baselines'), ('spc_alerts'), ('department_members'),
  ('quality_alerts'), ('quality_alert_parts'), ('quality_alert_machines'), ('quality_alert_operations'), ('quality_alert_departments'), ('quality_alert_targets'), ('quality_alert_recipients'), ('quality_alert_attachments'), ('quality_alert_links'),
  ('Employees'), ('capas'), ('capa_steps'), ('capa_team_members'), ('capa_ncr_links'), ('capa_analyses'), ('capa_actions'), ('capa_root_causes'), ('capa_verifications'), ('capa_attachments'), ('organisation_onboarding'), ('billing_customers'), ('stripe_checkout_sessions'),
  ('production_orders'), ('production_operations'), ('lots'), ('serial_numbers'), ('audit_definitions'), ('audit_questions'), ('audit_targets'), ('audit_occurrences'), ('audit_records'), ('audit_record_questions'), ('audit_record_targets'), ('audit_responses'), ('audit_ncr_links'), ('audit_attachments'), ('audit_finding_classifications'), ('audit_findings'), ('audit_finding_attachments'), ('audit_versions'), ('audit_version_questions'), ('audit_version_targets')
)
SELECT rule, object FROM (
  SELECT '1 rls disabled' AS rule, format('%I.%I', nspname, relname) AS object
  FROM tables WHERE relkind = 'r' AND nspname IN ('public', 'audit') AND NOT relrowsecurity
  UNION ALL
  SELECT '1 no select policy', format('%I.%I', t.nspname, t.relname)
  FROM tables t WHERE t.relkind = 'r' AND t.nspname IN ('public', 'audit')
    AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = t.nspname AND p.tablename = t.relname AND p.cmd IN ('SELECT', 'ALL'))
  UNION ALL
  SELECT '2 not tenant-owned', format('public.%I', t.relname)
  FROM tables t WHERE t.nspname = 'public' AND t.relkind = 'r'
    AND t.relname NOT IN (SELECT relname FROM global_tables)
    AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = t.oid AND a.attname = 'organisation_id' AND a.attnotnull AND NOT a.attisdropped)
  UNION ALL
  SELECT '3 organisation_id changeable', format('public.%I', u.relname)
  FROM updatable_org u
  WHERE NOT EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = u.oid AND g.tgfoid = 'app.prevent_organisation_change()'::regprocedure)
  UNION ALL
  SELECT '4 anon table privilege', format('%I.%I', nspname, relname)
  FROM tables WHERE CASE WHEN relkind IN ('r', 'v')
    THEN has_table_privilege('anon', oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') ELSE false END
  UNION ALL
  SELECT '4 anon sequence privilege', format('%I.%I', nspname, relname)
  FROM tables WHERE CASE WHEN relkind = 'S' THEN has_sequence_privilege('anon', oid, 'USAGE, SELECT, UPDATE') ELSE false END
  UNION ALL
  SELECT '4 anon function execute', p.oid::regprocedure::text
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname IN ('public', 'app', 'audit') AND has_function_privilege('anon', p.oid, 'EXECUTE')
  UNION ALL
  SELECT '5 authenticated can truncate', format('%I.%I', nspname, relname)
  FROM tables WHERE CASE WHEN relkind = 'r' THEN has_table_privilege('authenticated', oid, 'TRUNCATE') ELSE false END
  UNION ALL
  SELECT '5 authenticated writes app/audit', format('%I.%I', nspname, relname)
  FROM tables WHERE CASE WHEN relkind = 'r' AND nspname IN ('app', 'audit')
    THEN has_table_privilege('authenticated', oid, 'INSERT, UPDATE, DELETE') ELSE false END
  UNION ALL
  SELECT '6 view without security_invoker', format('public.%I', relname)
  FROM tables WHERE nspname = 'public' AND relkind = 'v'
    AND NOT coalesce(reloptions @> ARRAY['security_invoker=true'] OR reloptions @> ARRAY['security_invoker=on'], false)
  UNION ALL
  SELECT '7 mutable search_path', p.oid::regprocedure::text
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname IN ('public', 'app', 'audit')
    AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%')
  UNION ALL
  SELECT '8 not audited', format('public.%I', a.relname)
  FROM audited a
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
    WHERE c.relnamespace = 'public'::regnamespace AND c.relname = a.relname AND g.tgname = 'audit_changes')
) v
ORDER BY rule, object;

SELECT * FROM guardrail_violations;
