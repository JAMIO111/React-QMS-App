-- Security SE3 (docs/security-plan.md, S3): one rule function per organisation bucket, shared by the storage policies and the API; direct access
-- refused while the organisation enforces its network policy, except for the API's own login (qms_api).
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('5c000000-0000-0000-0000-000000000e01', 'ann@se3.test'), ('5c000000-0000-0000-0000-000000000e02', 'vic@se3.test'),
  ('5c000000-0000-0000-0000-000000000e03', 'eve@se3.test');
INSERT INTO storage.buckets (id, name) VALUES ('org-logos', 'org-logos'), ('avatars', 'avatars') ON CONFLICT DO NOTHING;

DO $$
DECLARE
  ann uuid := '5c000000-0000-0000-0000-000000000e01'; vic uuid := '5c000000-0000-0000-0000-000000000e02'; eve uuid := '5c000000-0000-0000-0000-000000000e03';
  org uuid; org2 uuid;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('SE3 Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('SE3 Beta'); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, vic, 'active');
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = 'viewer')
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id = vic;
  PERFORM set_config('se3.org', org::text, false);

  -- ---- every organisation bucket's policies go through the one function and the direct-access check ----
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
                              AND coalesce(qual, with_check) LIKE '%storage_file_allowed%' AND coalesce(qual, with_check) LIKE '%storage_direct_allowed%'),
                            24::bigint, 'insert and select of the twelve organisation buckets use the shared rule');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
                              AND policyname LIKE 'org_logos_%' AND coalesce(qual, with_check) LIKE '%storage_direct_allowed%'), 4::bigint,
                            'every logo policy checks direct access');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
                              AND policyname LIKE 'avatars_%' AND coalesce(qual, with_check) LIKE '%storage_direct_allowed%'), 0::bigint,
                            'avatars (the person''s own) are left alone');

  -- ---- the rule, as people ----
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq(app.storage_file_allowed('org-logos', org || '/logo/a.png', true), true, 'the owner may add a logo');
  PERFORM pg_temp.assert_eq(app.storage_file_allowed('org-logos', org || '/other/a.png', true), false, 'only into the logo folder');
  PERFORM pg_temp.assert_eq(app.storage_file_allowed('org-logos', org2 || '/logo/a.png', false), false, 'not another organisation''s');
  PERFORM pg_temp.assert_eq(app.storage_file_allowed('avatars', 'users/' || ann || '/a.png', false), false, 'avatars are not an organisation bucket');
  PERFORM pg_temp.assert_eq(app.storage_file_allowed('no-such-bucket', org || '/x', false), false, 'an unknown bucket is refused');
  PERFORM pg_temp.assert_eq(app.storage_file_allowed('nc-files', org || '/ncr/' || gen_random_uuid() || '/x.pdf', false), false,
                            'a folder of a record that does not exist is refused');
  PERFORM pg_temp.assert_eq(app.storage_direct_allowed(org || '/logo/a.png'), true, 'direct access while the policy is off');
  PERFORM pg_temp.assert_ok(format($q$INSERT INTO storage.objects (bucket_id, name) VALUES ('org-logos', %L)$q$, org || '/logo/a.png'), 'direct upload while off');
  PERFORM pg_temp.login(vic);
  PERFORM pg_temp.assert_eq(app.storage_file_allowed('org-logos', org || '/logo/a.png', false), true, 'a viewer reads the logo');
  PERFORM pg_temp.assert_eq(app.storage_file_allowed('org-logos', org || '/logo/b.png', true), false, 'but cannot add one');

  -- ---- enforced: direct access refused, the person still allowed by the rule ----
  PERFORM pg_temp.login(ann);
  PERFORM app.save_organisation_network(org, '{"name": "HQ", "network": "203.0.113.0/24"}', '203.0.113.10');
  PERFORM app.set_network_policy(org, 'enforce', '203.0.113.10');
  PERFORM pg_temp.assert_eq(app.storage_direct_allowed(org || '/logo/a.png'), false, 'no direct access while enforced');
  PERFORM pg_temp.assert_eq(app.storage_direct_allowed(org2 || '/logo/a.png'), true, 'another organisation is not affected');
  PERFORM pg_temp.assert_eq(app.storage_file_allowed('org-logos', org || '/logo/a.png', true), true, 'the rule itself is unchanged (the API checks it)');
  PERFORM pg_temp.assert_eq(pg_temp.count_rows($q$SELECT 1 FROM storage.objects WHERE bucket_id = 'org-logos'$q$), 0::bigint, 'direct reads see nothing');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO storage.objects (bucket_id, name) VALUES ('org-logos', %L)$q$, org || '/logo/b.png'), 'direct uploads refused');
  PERFORM pg_temp.assert_eq(pg_temp.affected(format($q$DELETE FROM storage.objects WHERE name = %L$q$, org || '/logo/a.png')), 0::bigint, 'direct deletes refused');
  PERFORM pg_temp.assert_ok(format($q$INSERT INTO storage.objects (bucket_id, name) VALUES ('avatars', %L)$q$, 'users/' || ann || '/me.png'), 'the person''s own avatar still uploads');
  PERFORM pg_temp.logout();
END $$;

-- ---- the API's own login is let through while enforced (it checked the network already) ----
SET SESSION AUTHORIZATION qms_api;
SELECT set_config('request.jwt.claims', json_build_object('sub', '5c000000-0000-0000-0000-000000000e01', 'role', 'authenticated')::text, true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  IF NOT app.storage_direct_allowed(current_setting('se3.org') || '/logo/a.png') THEN RAISE EXCEPTION 'FAIL: the API login should pass while enforced'; END IF;
  IF (SELECT count(*) FROM storage.objects WHERE bucket_id = 'org-logos') <> 1 THEN RAISE EXCEPTION 'FAIL: through the API the person reads the logo'; END IF;
  INSERT INTO storage.objects (bucket_id, name) VALUES ('org-logos', current_setting('se3.org') || '/logo/c.png');
  RAISE NOTICE 'ok - the API login reads and checks files while enforced';
END $$;
RESET ROLE;
RESET SESSION AUTHORIZATION;

ROLLBACK;
