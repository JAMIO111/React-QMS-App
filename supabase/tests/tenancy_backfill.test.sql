-- Backfill of the legacy data (fixtures/20251103000000_baseline.sql) by the Phase 1 migrations.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

DO $$
DECLARE
  org constant uuid := '00000000-0000-0000-0000-00000000000a';
  owner_user constant uuid := '00000000-0000-0000-0000-0000000000a1';
BEGIN
  -- Organisation kept its id and name, gained a slug; settings moved to organisation_settings.
  PERFORM pg_temp.assert_eq((SELECT slug FROM public.organisations WHERE id = org), 'legacy-org-ltd', 'slug generated');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.organisations WHERE id = org), 'active', 'status');
  PERFORM pg_temp.assert_eq((SELECT base_currency FROM public.organisation_settings WHERE organisation_id = org), 'GBP', 'currency moved');
  PERFORM pg_temp.assert_eq((SELECT vat_rate FROM public.organisation_settings WHERE organisation_id = org), 0.2000::numeric(5,4), 'vat moved');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.sites WHERE organisation_id = org AND code = 'MAIN'), 1::bigint, 'default site');

  -- Existing login user: profile from employee record, active Owner membership.
  PERFORM pg_temp.assert_eq((SELECT first_name || ' ' || surname FROM public.profiles WHERE id = owner_user), 'Lee Owner', 'profile backfilled');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.organisation_users WHERE organisation_id = org AND user_id = owner_user), 'active', 'membership');
  PERFORM pg_temp.assert_eq((
    SELECT r.key FROM public.user_role_assignments a
    JOIN public.organisation_users m ON m.id = a.membership_id
    JOIN public.roles r ON r.id = a.role_id
    WHERE m.user_id = owner_user), 'owner', 'owner role');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.roles WHERE organisation_id = org), 6::bigint, 'six roles copied');

  -- Every legacy row now belongs to the organisation.
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public."Employees" WHERE organisation_id = org), 2::bigint, 'employees incl. one without org');
  PERFORM pg_temp.assert_eq((SELECT organisation_id FROM public."NCM" WHERE ncm_id = 'NCM-25-001'), org, 'NCM backfilled');
  PERFORM pg_temp.assert_eq((SELECT organisation_id FROM public."Notification Recipients" LIMIT 1), org, 'recipients inherit org');
  -- Empty-text updated_at converted to timestamptz and then filled from created_at.
  PERFORM pg_temp.assert_eq((SELECT updated_at = created_at FROM public."Sub-Failure Mode" WHERE id = 1), true, 'sub-failure-mode updated_at');
END $$;

ROLLBACK;
