-- Time zone check, cron history purge and the read-policy fast path (migration 20260449100000).
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

CREATE FUNCTION pg_temp.assert_true(cond boolean, label text) RETURNS void LANGUAGE sql AS $$ SELECT pg_temp.assert_eq(coalesce(cond, false), true, label) $$;

INSERT INTO auth.users (id, email) VALUES
  ('49000000-0000-0000-0000-000000000101', 'owner@ez.test'),
  ('49000000-0000-0000-0000-000000000102', 'suspended@ez.test');

CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);
GRANT SELECT ON ids TO authenticated;

DO $$
DECLARE org uuid; m uuid;
BEGIN
  PERFORM pg_temp.login('49000000-0000-0000-0000-000000000101');
  org := app.create_organisation('Zone Works', 'Plant A', 'PA', NULL);
  PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '49000000-0000-0000-0000-000000000102', 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'inspector';
  UPDATE public.organisation_users SET status = 'suspended' WHERE id = m;
  INSERT INTO ids VALUES ('org', org);
END $$;

-- 1. Time zones.
DO $$
DECLARE org uuid := (SELECT v FROM ids WHERE k = 'org');
BEGIN
  PERFORM pg_temp.assert_true(app.valid_time_zone('Europe/London'), 'London is valid');
  PERFORM pg_temp.assert_true(app.valid_time_zone('America/Argentina/Buenos_Aires'), 'three-part names are valid');
  PERFORM pg_temp.assert_true(app.valid_time_zone('Asia/Kolkata'), 'Kolkata is valid');
  PERFORM pg_temp.assert_true(app.valid_time_zone('UTC'), 'UTC is valid');
  PERFORM pg_temp.assert_true(NOT app.valid_time_zone('Mars/Olympus_Mons'), 'an unknown name is not');
  PERFORM pg_temp.assert_true(NOT app.valid_time_zone('EST'), 'an abbreviation is not');
  PERFORM pg_temp.assert_true(NOT app.valid_time_zone('EST5EDT'), 'a POSIX string is not');
  PERFORM pg_temp.assert_true(NOT app.valid_time_zone(''), 'empty is not');
  PERFORM pg_temp.assert_true(NOT app.valid_time_zone(NULL), 'null is not');
  PERFORM pg_temp.assert_true(NOT app.valid_time_zone(repeat('a/', 40)), 'a very long name is not');

  UPDATE public.organisation_settings SET time_zone = NULL WHERE organisation_id = org;
  UPDATE public.sites SET timezone = 'Mars/Olympus_Mons' WHERE organisation_id = org;
  PERFORM pg_temp.assert_eq(app.organisation_time_zone(org), 'Europe/London', 'an unknown site zone falls back');
  UPDATE public.sites SET timezone = 'Asia/Kolkata' WHERE organisation_id = org;
  PERFORM pg_temp.assert_eq(app.organisation_time_zone(org), 'Asia/Kolkata', 'a valid site zone is used');
  UPDATE public.organisation_settings SET time_zone = 'America/New_York' WHERE organisation_id = org;
  PERFORM pg_temp.assert_eq(app.organisation_time_zone(org), 'America/New_York', 'the organisation setting wins');
END $$;

-- 2. Cron history: nothing happens without pg_cron; with it, only old rows go.
DO $$
BEGIN
  PERFORM pg_temp.assert_eq((SELECT app.system_purge_cron_history()), 0, 'no cron schema: nothing to do');
  CREATE SCHEMA cron;
  CREATE TABLE cron.job_run_details (runid bigserial PRIMARY KEY, end_time timestamptz);
  INSERT INTO cron.job_run_details (end_time) VALUES (now() - interval '10 days'), (now() - interval '8 days'), (now() - interval '1 day'), (now());
  PERFORM pg_temp.assert_eq((SELECT app.system_purge_cron_history()), 2, 'two old rows deleted');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM cron.job_run_details), 2::bigint, 'recent rows kept');
  PERFORM pg_temp.assert_eq((SELECT app.system_purge_cron_history(interval '12 hours')), 1, 'a shorter keep deletes more');
END $$;
SELECT pg_temp.login('49000000-0000-0000-0000-000000000101');
DO $$ BEGIN
  PERFORM pg_temp.assert_fails($q$SELECT app.system_purge_cron_history()$q$, 'a signed-in user cannot purge');
END $$;
SELECT pg_temp.logout();

-- 3. Policies: every one is rewritten, with the old check kept as the fall-back.
DO $$
DECLARE r record; n integer := 0;
BEGIN
  FOR r IN
    SELECT tablename, policyname, qual FROM pg_policies
     WHERE schemaname = 'public' AND cmd = 'SELECT'
       AND tablename IN ('goods_receipt_lines','goods_receipts','incoming_inspection_determinations','lots','ncr_affected_lots','ncr_attachments',
                         'ncr_containment_actions','ncr_costs','ncr_dispositions','nonconformances','part_revision_characteristics','part_revisions',
                         'parts','production_operations','production_orders','purchase_order_lines','purchase_orders','receipt_line_dispositions',
                         'serial_numbers','spc_alerts','supplier_scorecards')
       AND policyname = tablename || '_select' OR (tablename = 'ncr_containment_actions' AND policyname = 'ncr_containment_select')
  LOOP
    n := n + 1;
    PERFORM pg_temp.assert_true(r.qual ~ 'orgs_permitted|orgs_member', r.tablename || ' uses the fast path');
    PERFORM pg_temp.assert_true(r.qual ~ 'has_permission|is_member\(', r.tablename || ' keeps the old check');
  END LOOP;
  PERFORM pg_temp.assert_eq(n, 21, 'all 21 policies found');
END $$;

-- app.orgs_member: the caller's active, satisfied memberships only; not callable anonymously.
DO $$
DECLARE org uuid := (SELECT v FROM ids WHERE k = 'org');
BEGIN
  PERFORM pg_temp.login('49000000-0000-0000-0000-000000000101');
  PERFORM pg_temp.assert_eq((SELECT array_agg(o) FROM app.orgs_member() o), ARRAY[org], 'owner: their organisation');
  PERFORM pg_temp.login('49000000-0000-0000-0000-000000000102');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.orgs_member()), 0::bigint, 'suspended: nothing');
  PERFORM pg_temp.login_anon();
  PERFORM pg_temp.assert_fails($q$SELECT count(*) FROM app.orgs_member()$q$, 'anon cannot call it');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
