-- Every feature is tied to a package (docs/seats-and-member-onboarding-plan.md SM1, SM2; slice SM-A).
--
-- Until now only non-conformance, calibration, control plans and inspections were held back by the subscription: every other permission worked
-- for anyone whose role held it, seat or no seat. This ties every permission to a module and a level, so a package decides what a person may use:
--   view        = reading                    (Observer and up)
--   operational = recording, assigned work   (Contributor and up)
--   full        = creating, managing, approving, setting up (Controller)
-- Admin rights (running the account, not using the QMS) stay outside the packages: app.unpriced_permissions(). They already passed while an
-- organisation waits to pay (app.gated_permissions()); members and security are added here.
-- A permission that is neither priced nor listed as an admin right is refused by the check at the end, and by the SQL test
-- supabase/tests/every_feature_priced.test.sql, so a new permission cannot slip in unpriced.
--
-- Nothing changes in organisations that do not enforce entitlements (the grandfathered ones): app.has_entitlement answers true there.

-- ---------------------------------------------------------------------------
-- 1. Admin rights: never tied to a package
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.unpriced_permissions() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT app.gated_permissions() || ARRAY['members.read', 'members.manage', 'roles.manage', 'security.read', 'security.manage']
$$;
REVOKE ALL ON FUNCTION app.unpriced_permissions() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.unpriced_permissions() TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. Modules: the ones that were "planned" are in use; the missing ones are added
-- ---------------------------------------------------------------------------
UPDATE public.modules SET status = 'active'
 WHERE slug IN ('document_control', 'capa', 'audits', 'supplier_quality', 'risk_management') AND status = 'planned';

INSERT INTO public.modules (slug, name, status, navigation_group, display_order) VALUES
  ('production',        'Production and traceability', 'active', 'Quality',  12),
  ('competence',        'Competence',                  'active', 'Quality',  13),
  ('management_review', 'Management review',           'active', 'Quality',  14),
  ('workflows',         'Workflows',                   'active', 'Insight',  15),
  ('master_data',       'Master data',                 'active', 'Insight',  16)
ON CONFLICT (slug) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Features: one per permission not yet tied to a package
-- ---------------------------------------------------------------------------
INSERT INTO public.features (module_id, slug, name, min_access_level, permission_code)
SELECT m.id, f.slug, f.name, f.level, f.perm
FROM (VALUES
  ('nonconformance',    'approve_dispositions',   'Approve dispositions',                     'full',        'ncr.approve_disposition'),
  ('nonconformance',    'manage_lookups',         'Manage categories and lists',              'full',        'lookups.manage'),
  ('capa',              'view_capas',             'View 8Ds',                                 'view',        'capa.read'),
  ('capa',              'manage_capas',           'Start and run 8Ds',                        'full',        'capa.manage'),
  ('capa',              'verify_capas',           'Verify and close 8Ds',                     'full',        'capa.verify'),
  ('audits',            'view_audits',            'View audits',                              'view',        'audits.read'),
  ('audits',            'perform_audits',         'Carry out audits',                         'operational', 'audits.perform'),
  ('audits',            'manage_audits',          'Define and schedule audits',               'full',        'audits.manage'),
  ('document_control',  'view_documents',         'Read documents and quality alerts',        'view',        'documentation.read'),
  ('document_control',  'manage_documents',       'Write documents and quality alerts',       'full',        'documentation.manage'),
  ('document_control',  'issue_documents',        'Approve and issue documents',              'full',        'documentation.issue'),
  ('supplier_quality',  'view_suppliers',         'View supplier quality',                    'view',        'supplier_quality.read'),
  ('supplier_quality',  'manage_suppliers',       'Manage suppliers, SCARs and assessments',  'full',        'supplier_quality.manage'),
  ('supplier_quality',  'approve_suppliers',      'Approve suppliers',                        'full',        'supplier_quality.approve'),
  ('supplier_quality',  'configure_suppliers',    'Set up supplier quality',                  'full',        'supplier_quality.configure'),
  ('supplier_quality',  'view_receiving',         'View orders and deliveries',               'view',        'receiving.read'),
  ('supplier_quality',  'record_receiving',       'Record deliveries and certificates',       'operational', 'receiving.manage'),
  ('inspections',       'view_spc',               'View control charts',                      'view',        'spc.read'),
  ('inspections',       'manage_spc',             'Save baselines and handle SPC alerts',     'full',        'spc.manage'),
  ('risk_management',   'view_risks',             'View risks',                               'view',        'risk.read'),
  ('risk_management',   'manage_risks',           'Raise and treat risks',                    'full',        'risk.manage'),
  ('risk_management',   'approve_risks',          'Accept risks and change the matrix',       'full',        'risk.approve'),
  ('production',        'view_production',        'View orders, lots and serials',            'view',        'production.read'),
  ('production',        'manage_production',      'Manage orders, lots and serials',          'full',        'production.manage'),
  ('competence',        'view_competence',        'View competence',                          'view',        'competence.read'),
  ('competence',        'assess_competence',      'Assess people and run training',           'operational', 'competence.assess'),
  ('competence',        'manage_competence',      'Set up skills and positions',              'full',        'competence.manage'),
  ('management_review', 'view_management_review', 'View objectives and reviews',              'view',        'management_review.read'),
  ('management_review', 'manage_management_review','Run management reviews',                  'full',        'management_review.manage'),
  ('workflows',         'view_workflows',         'View workflow rules',                      'view',        'workflows.read'),
  ('workflows',         'manage_workflows',       'Write workflow rules',                     'full',        'workflows.manage'),
  ('master_data',       'view_master_data',       'View parts, machines and other lists',     'view',        'master_data.read'),
  ('master_data',       'manage_master_data',     'Manage parts, machines and other lists',   'full',        'master_data.manage'),
  ('master_data',       'manage_custom_fields',   'Manage custom fields',                     'full',        'custom_fields.manage'),
  ('analytics',         'view_audit_trail',       'Read the audit trail',                     'view',        'audit.read'),
  ('integrations',      'view_integrations',      'View integrations',                        'view',        'integrations.read'),
  ('integrations',      'run_integrations',       'Run imports',                              'operational', 'integrations.run'),
  ('integrations',      'manage_integrations',    'Set up integrations',                      'full',        'integrations.manage'),
  ('integrations',      'approve_integrations',   'Activate integrations',                    'full',        'integrations.approve')
) AS f(module, slug, name, level, perm)
JOIN public.modules m ON m.slug = f.module
JOIN public.permissions p ON p.code = f.perm
WHERE NOT EXISTS (SELECT 1 FROM public.features x WHERE x.permission_code = f.perm);

-- ---------------------------------------------------------------------------
-- 4. What each package gives in each module (rows the module does not have yet)
-- ---------------------------------------------------------------------------
-- Observer views; Contributor works (records, carries out, assesses) but only views where the module is set-up work; Controller has it all.
-- Integrations stay Controller-only (they also need a Controller seat, app.holds_controller_seat).
INSERT INTO public.subscription_entitlements (subscription_plan_id, module_id, access_level)
SELECT p.id, m.id,
  CASE
    WHEN p.slug = 'controller' THEN 'full'
    WHEN m.slug = 'integrations' THEN 'none'
    WHEN p.slug = 'observer' THEN 'view'
    WHEN m.slug IN ('management_review', 'workflows', 'master_data') THEN 'view'
    ELSE 'operational'
  END
FROM public.subscription_plans p CROSS JOIN public.modules m
WHERE NOT EXISTS (SELECT 1 FROM public.subscription_entitlements e
                   WHERE e.subscription_plan_id = p.id AND e.module_id = m.id AND e.feature_id IS NULL);

-- ---------------------------------------------------------------------------
-- 5. Nothing left unpriced
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(p.code, ', ' ORDER BY p.code) INTO v_missing
    FROM public.permissions p
   WHERE NOT EXISTS (SELECT 1 FROM public.features f WHERE f.permission_code = p.code)
     AND p.code <> ALL (app.unpriced_permissions());
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Permissions not tied to a package (add a feature, or list them in app.unpriced_permissions()): %', v_missing;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 6. "May this member do this?" for someone other than the caller, seat included
-- ---------------------------------------------------------------------------
-- app.has_permission answers for the signed-in person. Choosing someone for a job (naming a document's approver) must ask the same of them:
-- their role holds the permission AND, where the organisation enforces packages, their seat's package reaches the feature's level. Found by
-- the browser journey: a Contributor was offered as a document approver and then refused when approving.
CREATE FUNCTION app.member_may(p_organisation_id uuid, p_user uuid, p_permission text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.organisation_users m
      JOIN public.user_role_assignments a ON a.membership_id = m.id AND a.site_id IS NULL AND a.department_id IS NULL
      JOIN public.role_permissions rp ON rp.role_id = a.role_id AND rp.permission_code = p_permission
     WHERE m.organisation_id = p_organisation_id AND m.user_id = p_user AND m.status = 'active')
  AND (
    p_permission = ANY (app.unpriced_permissions())
    OR NOT coalesce((SELECT s.entitlements_enforced FROM public.organisation_settings s WHERE s.organisation_id = p_organisation_id), false)
    OR NOT EXISTS (SELECT 1 FROM public.features f WHERE f.permission_code = p_permission)
    OR EXISTS (
      SELECT 1 FROM public.organisation_users m
        JOIN public.user_subscription_assignments sa ON sa.organisation_membership_id = m.id AND sa.status = 'active'
             AND sa.effective_from <= now() AND (sa.effective_to IS NULL OR sa.effective_to > now())
        JOIN public.features f ON f.permission_code = p_permission
        JOIN public.subscription_entitlements e ON e.subscription_plan_id = sa.subscription_plan_id AND e.module_id = f.module_id
             AND (e.feature_id = f.id OR e.feature_id IS NULL) AND e.enabled
       WHERE m.organisation_id = p_organisation_id AND m.user_id = p_user AND m.status = 'active'
         AND app.access_level_rank(e.access_level) >= app.access_level_rank(f.min_access_level)))
$$;
REVOKE ALL ON FUNCTION app.member_may(uuid, uuid, text) FROM PUBLIC, anon, authenticated;

-- Document approvers: only people who may approve, seat included (was: the role alone).
CREATE OR REPLACE FUNCTION app.document_signer_candidates(p_organisation_id uuid) RETURNS TABLE (user_id uuid, name text, can_approve boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT ou.user_id, coalesce(nullif(btrim(concat_ws(' ', p.first_name, p.surname)), ''), 'Unnamed'),
         app.member_may(p_organisation_id, ou.user_id, 'documentation.issue')
    FROM public.organisation_users ou LEFT JOIN public.profiles p ON p.id = ou.user_id
   WHERE ou.organisation_id = p_organisation_id AND ou.status = 'active' AND app.has_permission(p_organisation_id, 'documentation.manage')
   ORDER BY 2
$$;
