-- Tenant isolation and permissions (Phase 1 exit criterion, database layer).
--
-- Organisation A = legacy org from the fixture (owner A1). Organisation B is created here with an
-- owner, an admin and a viewer. Other users: an inspector in A, a member of both, an outsider with
-- no membership, and a suspended member of A.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

-- ---------------------------------------------------------------------------
-- Setup (as postgres)
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-0000-0000-0000000000b1', 'b.owner@example.test'),
  ('00000000-0000-0000-0000-0000000000b2', 'b.admin@example.test'),
  ('00000000-0000-0000-0000-0000000000b3', 'b.viewer@example.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'a.inspector@example.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'a.suspended@example.test'),
  ('00000000-0000-0000-0000-0000000000d1', 'dual@example.test'),
  ('00000000-0000-0000-0000-0000000000ff', 'outsider@example.test');

INSERT INTO public.organisations (id, name, slug) VALUES ('00000000-0000-0000-0000-00000000000b', 'Other Org', 'other-org');
INSERT INTO public.organisation_settings (organisation_id) VALUES ('00000000-0000-0000-0000-00000000000b');
INSERT INTO public.sites (id, organisation_id, code, name) VALUES ('00000000-0000-0000-0000-0000000005b1', '00000000-0000-0000-0000-00000000000b', 'MAIN', 'Main');
SELECT app.create_default_roles('00000000-0000-0000-0000-00000000000b');

CREATE FUNCTION pg_temp.add_member(p_org uuid, p_user uuid, p_role text, p_status text DEFAULT 'active') RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE m uuid;
BEGIN
  INSERT INTO public.organisation_users (organisation_id, user_id, status, joined_at)
  VALUES (p_org, p_user, 'active', now()) RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
  SELECT p_org, m, id FROM public.roles WHERE organisation_id = p_org AND key = p_role;
  IF p_status <> 'active' THEN UPDATE public.organisation_users SET status = p_status WHERE id = m; END IF;
  RETURN m;
END $$;

SELECT pg_temp.add_member('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000b1', 'owner');
SELECT pg_temp.add_member('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000b2', 'admin');
SELECT pg_temp.add_member('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000b3', 'viewer');
SELECT pg_temp.add_member('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a2', 'inspector');
SELECT pg_temp.add_member('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a3', 'quality_manager', 'suspended');
SELECT pg_temp.add_member('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000d1', 'viewer');
SELECT pg_temp.add_member('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000d1', 'viewer');

-- Organisation B business data
INSERT INTO public."Status" (id, organisation_id, name, type) VALUES (10, '00000000-0000-0000-0000-00000000000b', 'Open', 'initial');
INSERT INTO public."Failure Mode" (id, organisation_id, code, name) VALUES (10, '00000000-0000-0000-0000-00000000000b', 'VIS', 'Visual');
INSERT INTO public."Part" (id, organisation_id, part_number) VALUES ('00000000-0000-0000-0000-0000000000b9', '00000000-0000-0000-0000-00000000000b', 'B-1');
INSERT INTO public."NCM" (id, organisation_id, ncm_id, date, type, status, quantity_defective, total_cost)
VALUES ('00000000-0000-0000-0000-0000000000bb', '00000000-0000-0000-0000-00000000000b', 'NCM-25-001', now(), 'Internal', 10, 5, 100);
INSERT INTO public."NC Files" (organisation_id, name, path, id_ref, owner)
VALUES ('00000000-0000-0000-0000-00000000000b', 'b.pdf', '00000000-0000-0000-0000-00000000000b/ncr/NCM-25-001/b.pdf', 'NCM-25-001', '00000000-0000-0000-0000-0000000000b1');
INSERT INTO public."Notifications" (id, organisation_id, created_by, title)
VALUES ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000b1', 'B notice');
INSERT INTO public."Notification Recipients" (organisation_id, notification_id, recipient_id)
VALUES ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b3');

INSERT INTO storage.objects (bucket_id, name) VALUES
  ('nc-files', '00000000-0000-0000-0000-00000000000a/ncr/NCM-25-001/a.jpg'),
  ('nc-files', '00000000-0000-0000-0000-00000000000b/ncr/NCM-25-001/b.pdf'),
  ('nc-files', 'legacy_without_org.jpg'),
  ('avatars', 'users/00000000-0000-0000-0000-0000000000a1/me.png'),
  ('avatars', 'users/00000000-0000-0000-0000-0000000000b1/me.png');

-- Every policy check below must hold with constraint triggers firing immediately.
SET CONSTRAINTS ALL IMMEDIATE;

-- ---------------------------------------------------------------------------
-- Anonymous: no access to anything
-- ---------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  PERFORM pg_temp.login_anon();
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v') LOOP
    PERFORM pg_temp.assert_fails(format('SELECT 1 FROM public.%I', r.relname), 'anon reads ' || r.relname);
  END LOOP;
  PERFORM pg_temp.assert_fails($q$SELECT public.get_user_notifications()$q$, 'anon calls rpc');
  PERFORM pg_temp.assert_eq(pg_temp.count_rows('SELECT 1 FROM storage.objects'), 0::bigint, 'anon storage');
  PERFORM pg_temp.logout();
END $$;

-- ---------------------------------------------------------------------------
-- Outsider (signed in, no membership): sees nothing tenant-owned
-- ---------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  PERFORM pg_temp.login('00000000-0000-0000-0000-0000000000ff');
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v')
             AND c.relname NOT IN ('permissions', 'roles', 'role_permissions', 'profiles') LOOP
    PERFORM pg_temp.assert_eq(pg_temp.count_rows(format('SELECT 1 FROM public.%I', r.relname)), 0::bigint, 'outsider reads ' || r.relname);
  END LOOP;
  -- Only system role templates and their permissions are visible; only own profile.
  PERFORM pg_temp.assert_eq(pg_temp.count_rows('SELECT 1 FROM public.roles WHERE organisation_id IS NOT NULL'), 0::bigint, 'outsider org roles');
  PERFORM pg_temp.assert_eq(pg_temp.count_rows('SELECT 1 FROM public.profiles'), 1::bigint, 'outsider sees own profile only');
  PERFORM pg_temp.assert_eq(pg_temp.count_rows('SELECT 1 FROM storage.objects'), 0::bigint, 'outsider storage');
  PERFORM pg_temp.assert_fails($q$INSERT INTO public."NCM" (organisation_id, ncm_id) VALUES ('00000000-0000-0000-0000-00000000000a', 'X-1')$q$, 'outsider insert');
  PERFORM pg_temp.logout();
END $$;

-- ---------------------------------------------------------------------------
-- Owner of A: full access to A, nothing of B
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  PERFORM pg_temp.login('00000000-0000-0000-0000-0000000000a1');
  PERFORM pg_temp.assert_eq(pg_temp.count_rows('SELECT 1 FROM public.organisations'), 1::bigint, 'A owner sees one org');
  PERFORM pg_temp.assert_eq(pg_temp.count_rows($q$SELECT 1 FROM public."NCM"$q$), 1::bigint, 'A owner NCM');
  PERFORM pg_temp.assert_eq(pg_temp.count_rows($q$SELECT 1 FROM public."NCM" WHERE organisation_id = '00000000-0000-0000-0000-00000000000b'$q$), 0::bigint, 'A owner cannot see B NCM by org');
  PERFORM pg_temp.assert_eq(pg_temp.count_rows($q$SELECT 1 FROM public."NCM" WHERE id = '00000000-0000-0000-0000-0000000000bb'$q$), 0::bigint, 'A owner cannot see B NCM by id');
  PERFORM pg_temp.assert_eq(pg_temp.count_rows('SELECT 1 FROM public.v_ncm_internal'), 1::bigint, 'view filtered');
  PERFORM pg_temp.assert_eq(pg_temp.count_rows('SELECT 1 FROM public.v_nc_files'), 1::bigint, 'files view filtered');
  PERFORM pg_temp.assert_eq(pg_temp.count_rows($q$SELECT 1 FROM public."Status"$q$), 2::bigint, 'A lookups only');
  PERFORM pg_temp.assert_eq(pg_temp.count_rows('SELECT 1 FROM public.organisation_users'), 4::bigint, 'A members only');
  PERFORM pg_temp.assert_eq(pg_temp.count_rows($q$SELECT 1 FROM public.profiles WHERE id = '00000000-0000-0000-0000-0000000000b1'$q$), 0::bigint, 'B owner profile hidden');
  PERFORM pg_temp.assert_eq(pg_temp.count_rows($q$SELECT 1 FROM public.profiles WHERE id = '00000000-0000-0000-0000-0000000000d1'$q$), 1::bigint, 'shared member profile visible');
  PERFORM pg_temp.assert_eq(pg_temp.count_rows($q$SELECT 1 FROM public."Notifications"$q$), 1::bigint, 'own notification only');

  -- Writes into B are impossible: direct insert, update/delete by id, cross-org references.
  PERFORM pg_temp.assert_fails($q$INSERT INTO public."NCM" (organisation_id, ncm_id) VALUES ('00000000-0000-0000-0000-00000000000b', 'X-1')$q$, 'insert into B');
  PERFORM pg_temp.assert_eq(pg_temp.affected($q$UPDATE public."NCM" SET description = 'x' WHERE id = '00000000-0000-0000-0000-0000000000bb'$q$), 0::bigint, 'update B row');
  PERFORM pg_temp.assert_eq(pg_temp.affected($q$DELETE FROM public."NCM" WHERE id = '00000000-0000-0000-0000-0000000000bb'$q$), 0::bigint, 'delete B row');
  PERFORM pg_temp.assert_fails($q$TRUNCATE public."NCM" CASCADE$q$, 'truncate bypassing RLS');
  PERFORM pg_temp.assert_fails($q$DELETE FROM public.organisations WHERE id = '00000000-0000-0000-0000-00000000000a'$q$, 'delete own organisation');
  PERFORM pg_temp.assert_fails($q$DELETE FROM public.permissions$q$, 'delete permission catalogue');
  PERFORM pg_temp.assert_fails($q$INSERT INTO public."NCM" (organisation_id, ncm_id, status) VALUES ('00000000-0000-0000-0000-00000000000a', 'X-2', 10)$q$, 'A NCM referencing B status');
  PERFORM pg_temp.assert_fails($q$UPDATE public."NCM" SET organisation_id = '00000000-0000-0000-0000-00000000000b'$q$, 'move row to B');
  PERFORM pg_temp.assert_eq(pg_temp.affected($q$UPDATE public.organisations SET name = 'hijack' WHERE id = '00000000-0000-0000-0000-00000000000b'$q$), 0::bigint, 'rename B');

  -- Normal work inside A.
  PERFORM pg_temp.assert_ok($q$INSERT INTO public."NCM" (organisation_id, ncm_id, status) VALUES ('00000000-0000-0000-0000-00000000000a', 'NCM-25-002', 1)$q$, 'owner creates NCM in A');
  PERFORM pg_temp.assert_eq(pg_temp.affected($q$UPDATE public.organisations SET name = 'Legacy Org Renamed' WHERE id = '00000000-0000-0000-0000-00000000000a'$q$), 1::bigint, 'owner renames own org');
  PERFORM pg_temp.assert_fails($q$UPDATE public.organisations SET status = 'suspended' WHERE id = '00000000-0000-0000-0000-00000000000a'$q$, 'status column not user-editable');

  -- Reporting functions only aggregate the caller's data even when asked for B.
  PERFORM pg_temp.assert_eq((public.get_nc_kpi_json('00000000-0000-0000-0000-00000000000b', now() - interval '1 day', now() + interval '1 day', 'Internal')::jsonb -> 'totals' ->> 'record_count')::int, 0, 'kpi for B is empty');

  -- Storage: A objects and own/shared avatars only.
  PERFORM pg_temp.assert_eq(pg_temp.count_rows($q$SELECT 1 FROM storage.objects WHERE bucket_id = 'nc-files'$q$), 1::bigint, 'A files only');
  PERFORM pg_temp.assert_eq(pg_temp.count_rows($q$SELECT 1 FROM storage.objects WHERE bucket_id = 'avatars'$q$), 1::bigint, 'own avatar only');
  PERFORM pg_temp.assert_fails($q$INSERT INTO storage.objects (bucket_id, name) VALUES ('nc-files', '00000000-0000-0000-0000-00000000000b/x.txt')$q$, 'upload into B');
  PERFORM pg_temp.assert_fails($q$INSERT INTO storage.objects (bucket_id, name) VALUES ('avatars', 'users/00000000-0000-0000-0000-0000000000b1/x.png')$q$, 'upload as someone else');
  PERFORM pg_temp.assert_ok($q$INSERT INTO storage.objects (bucket_id, name) VALUES ('nc-files', '00000000-0000-0000-0000-00000000000a/ncr/x.txt')$q$, 'upload into A');
  PERFORM pg_temp.logout();
END $$;

-- ---------------------------------------------------------------------------
-- Member of both organisations sees both, with each organisation's permissions
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  PERFORM pg_temp.login('00000000-0000-0000-0000-0000000000d1');
  PERFORM pg_temp.assert_eq(pg_temp.count_rows('SELECT 1 FROM public.organisations'), 2::bigint, 'dual member sees two orgs');
  PERFORM pg_temp.assert_eq(pg_temp.count_rows($q$SELECT 1 FROM public."NCM" WHERE organisation_id = '00000000-0000-0000-0000-00000000000b'$q$), 1::bigint, 'dual member B NCM');
  PERFORM pg_temp.assert_fails($q$INSERT INTO public."NCM" (organisation_id, ncm_id) VALUES ('00000000-0000-0000-0000-00000000000b', 'V-1')$q$, 'viewer cannot create');
  PERFORM pg_temp.assert_eq(pg_temp.count_rows('SELECT 1 FROM public.organisation_users'), 2::bigint, 'viewer sees own memberships only');
  PERFORM pg_temp.logout();
END $$;

-- ---------------------------------------------------------------------------
-- Role permissions inside an organisation
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  -- Inspector: can raise, cannot edit, delete or manage lookups.
  PERFORM pg_temp.login('00000000-0000-0000-0000-0000000000a2');
  PERFORM pg_temp.assert_ok($q$INSERT INTO public."NCM" (organisation_id, ncm_id) VALUES ('00000000-0000-0000-0000-00000000000a', 'NCM-25-003')$q$, 'inspector raises NCR');
  PERFORM pg_temp.assert_eq(pg_temp.affected($q$UPDATE public."NCM" SET description = 'x'$q$), 0::bigint, 'inspector cannot edit');
  PERFORM pg_temp.assert_eq(pg_temp.affected($q$DELETE FROM public."NCM"$q$), 0::bigint, 'inspector cannot delete');
  PERFORM pg_temp.assert_fails($q$INSERT INTO public."Status" (organisation_id, name) VALUES ('00000000-0000-0000-0000-00000000000a', 'New')$q$, 'inspector cannot add status');
  PERFORM pg_temp.assert_eq(pg_temp.count_rows('SELECT 1 FROM public.organisation_users'), 1::bigint, 'inspector lacks members.read');
  PERFORM pg_temp.logout();

  -- Suspended member: no access at all.
  PERFORM pg_temp.login('00000000-0000-0000-0000-0000000000a3');
  PERFORM pg_temp.assert_eq(pg_temp.count_rows($q$SELECT 1 FROM public."NCM"$q$), 0::bigint, 'suspended member sees nothing');
  PERFORM pg_temp.assert_eq(pg_temp.count_rows('SELECT 1 FROM public.organisations'), 0::bigint, 'suspended member org');
  PERFORM pg_temp.logout();

  -- Recipient sees the notification; B owner (creator) too; B admin does not.
  PERFORM pg_temp.login('00000000-0000-0000-0000-0000000000b3');
  PERFORM pg_temp.assert_eq(pg_temp.count_rows('SELECT * FROM public.get_user_notifications()'), 1::bigint, 'recipient notification');
  PERFORM pg_temp.assert_eq(pg_temp.affected($q$UPDATE public."Notification Recipients" SET read = true$q$), 1::bigint, 'recipient marks read');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login('00000000-0000-0000-0000-0000000000b2');
  PERFORM pg_temp.assert_eq(pg_temp.count_rows($q$SELECT 1 FROM public."Notifications"$q$), 0::bigint, 'non-recipient');
  PERFORM pg_temp.logout();
END $$;

-- ---------------------------------------------------------------------------
-- Membership and role administration
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  viewer_m uuid := (SELECT id FROM public.organisation_users WHERE user_id = '00000000-0000-0000-0000-0000000000b3');
  owner_m  uuid := (SELECT id FROM public.organisation_users WHERE user_id = '00000000-0000-0000-0000-0000000000b1');
  admin_m  uuid := (SELECT id FROM public.organisation_users WHERE user_id = '00000000-0000-0000-0000-0000000000b2');
  b_owner_role uuid := (SELECT id FROM public.roles WHERE organisation_id = '00000000-0000-0000-0000-00000000000b' AND key = 'owner');
  b_qe_role uuid := (SELECT id FROM public.roles WHERE organisation_id = '00000000-0000-0000-0000-00000000000b' AND key = 'quality_engineer');
BEGIN
  PERFORM pg_temp.login('00000000-0000-0000-0000-0000000000b2');  -- admin of B
  -- Can invite, assign roles they fully hold, and suspend a viewer.
  PERFORM pg_temp.assert_ok($q$INSERT INTO public.organisation_users (organisation_id, invited_email, status) VALUES ('00000000-0000-0000-0000-00000000000b', 'new@example.test', 'invited')$q$, 'admin invites');
  PERFORM pg_temp.assert_ok(format($q$INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) VALUES ('00000000-0000-0000-0000-00000000000b', %L, %L)$q$, viewer_m, b_qe_role), 'admin assigns quality engineer');
  PERFORM pg_temp.assert_eq(pg_temp.affected(format($q$UPDATE public.organisation_users SET status = 'suspended' WHERE id = %L$q$, viewer_m)), 1::bigint, 'admin suspends viewer');
  -- Cannot escalate: Owner role includes permissions the admin lacks.
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) VALUES ('00000000-0000-0000-0000-00000000000b', %L, %L)$q$, admin_m, b_owner_role), 'admin grants self owner');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) VALUES ('00000000-0000-0000-0000-00000000000b', %L, %L)$q$, viewer_m, b_owner_role), 'admin grants owner');
  -- Cannot touch the owner, cannot change own status, cannot add active members directly.
  PERFORM pg_temp.assert_eq(pg_temp.affected(format($q$UPDATE public.organisation_users SET status = 'suspended' WHERE id = %L$q$, owner_m)), 0::bigint, 'admin suspends owner');
  PERFORM pg_temp.assert_eq(pg_temp.affected(format($q$UPDATE public.organisation_users SET status = 'suspended' WHERE id = %L$q$, admin_m)), 0::bigint, 'admin suspends self');
  PERFORM pg_temp.assert_fails($q$INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000ff', 'active')$q$, 'admin adds active member');
  -- Cannot edit system roles or create roles (no roles.manage).
  PERFORM pg_temp.assert_eq(pg_temp.affected(format($q$UPDATE public.roles SET name = 'x' WHERE id = %L$q$, b_owner_role)), 0::bigint, 'admin edits system role');
  PERFORM pg_temp.assert_fails($q$INSERT INTO public.roles (organisation_id, key, name) VALUES ('00000000-0000-0000-0000-00000000000b', 'custom', 'Custom')$q$, 'admin creates role');
  PERFORM pg_temp.logout();

  -- Owner of B creates a custom role but cannot attach permissions to a system role.
  PERFORM pg_temp.login('00000000-0000-0000-0000-0000000000b1');
  PERFORM pg_temp.assert_ok($q$INSERT INTO public.roles (organisation_id, key, name) VALUES ('00000000-0000-0000-0000-00000000000b', 'auditor', 'Auditor')$q$, 'owner creates role');
  PERFORM pg_temp.assert_ok($q$INSERT INTO public.role_permissions (role_id, permission_code) SELECT id, 'audit.read' FROM public.roles WHERE key = 'auditor'$q$, 'owner adds permission');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.role_permissions (role_id, permission_code) VALUES (%L, 'audit.read')$q$, b_qe_role), 'owner edits system role permissions');
  PERFORM pg_temp.logout();
END $$;

-- ---------------------------------------------------------------------------
-- Every organisation keeps an active owner
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  PERFORM pg_temp.assert_fails($q$UPDATE public.organisation_users SET status = 'suspended' WHERE user_id = '00000000-0000-0000-0000-0000000000b1'$q$, 'suspend last owner');
  PERFORM pg_temp.assert_fails($q$DELETE FROM public.user_role_assignments a USING public.roles r WHERE r.id = a.role_id AND r.key = 'owner' AND a.organisation_id = '00000000-0000-0000-0000-00000000000b'$q$, 'remove last owner role');
END $$;

ROLLBACK;
