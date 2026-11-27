-- Custom roles (docs/custom-roles-plan.md, RL1): save and delete, the grant rule, roles.manage kept out, built-in roles fixed, in-use delete refused,
-- the limit, names, versions, and what a person holding a custom role can and cannot do.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('6c000000-0000-0000-0000-000000000101', 'owner@roles.test'),
  ('6c000000-0000-0000-0000-000000000102', 'admin@roles.test'),
  ('6c000000-0000-0000-0000-000000000103', 'tech@roles.test'),
  ('6c000000-0000-0000-0000-000000000104', 'other@roles.test'),
  ('6c000000-0000-0000-0000-000000000105', 'limited@roles.test');

DO $$
DECLARE
  org uuid; org2 uuid; admin_role uuid; m_admin uuid; m_tech uuid; m_lim uuid; r uuid; r2 uuid; r_lim uuid; owner_role uuid;
  n integer;
BEGIN
  PERFORM pg_temp.login('6c000000-0000-0000-0000-000000000101');
  org := app.create_organisation('Roles Works');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login('6c000000-0000-0000-0000-000000000104');
  org2 := app.create_organisation('Other Roles Works');
  PERFORM pg_temp.logout();

  SELECT id INTO admin_role FROM public.roles WHERE organisation_id = org AND key = 'admin';
  SELECT id INTO owner_role FROM public.roles WHERE organisation_id = org AND key = 'owner';
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '6c000000-0000-0000-0000-000000000102', 'active') RETURNING id INTO m_admin;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) VALUES (org, m_admin, admin_role);
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '6c000000-0000-0000-0000-000000000103', 'active') RETURNING id INTO m_tech;

  -- ---- The Owner makes a role -------------------------------------------------------------------------------------------------------------
  PERFORM pg_temp.login('6c000000-0000-0000-0000-000000000101');
  r := app.save_custom_role(org, NULL, '  Calibration tech ', 'Records calibrations', ARRAY['calibration.read', 'calibration.record', 'master_data.read', 'calibration.read']);
  PERFORM pg_temp.assert_eq((SELECT key FROM public.roles WHERE id = r), 'custom_calibration_tech', 'key made from the name');
  PERFORM pg_temp.assert_eq((SELECT name FROM public.roles WHERE id = r), 'Calibration tech', 'name trimmed');
  PERFORM pg_temp.assert_eq((SELECT is_system FROM public.roles WHERE id = r), false, 'not a system role');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.role_permissions WHERE role_id = r), 3::bigint, 'permissions de-duplicated');

  -- Names are unique ignoring case, even against the built-in names; a key is never a built-in key.
  PERFORM pg_temp.assert_fails(format('SELECT app.save_custom_role(%L, NULL, ''calibration TECH'', NULL, ARRAY[''ncr.read''])', org), 'duplicate name ignoring case');
  PERFORM pg_temp.assert_fails(format('SELECT app.save_custom_role(%L, NULL, ''owner'', NULL, ARRAY[''ncr.read''])', org), 'a built-in name');
  r2 := app.save_custom_role(org, NULL, 'Owner!', NULL, ARRAY['ncr.read']);
  PERFORM pg_temp.assert_eq((SELECT key FROM public.roles WHERE id = r2), 'custom_owner', 'custom key never equals a built-in key');
  PERFORM app.delete_custom_role(r2);

  -- ---- What is refused ----------------------------------------------------------------------------------------------------------------------
  PERFORM pg_temp.assert_fails(format('SELECT app.save_custom_role(%L, NULL, ''Empty'', NULL, ARRAY[]::text[])', org), 'no permission');
  PERFORM pg_temp.assert_fails(format('SELECT app.save_custom_role(%L, NULL, ''Bad'', NULL, ARRAY[''nonsense.do''])', org), 'unknown permission');
  PERFORM pg_temp.assert_fails(format('SELECT app.save_custom_role(%L, NULL, ''Boss'', NULL, ARRAY[''ncr.read'', ''roles.manage''])', org), 'roles.manage in a custom role');
  PERFORM pg_temp.assert_fails(format('SELECT app.save_custom_role(%L, NULL, %L, NULL, ARRAY[''ncr.read''])', org, repeat('x', 61)), 'name too long');
  PERFORM pg_temp.assert_fails(format('SELECT app.save_custom_role(%L, NULL, ''  '', NULL, ARRAY[''ncr.read''])', org), 'blank name');
  -- Direct writes meet the same rules (a person writing the tables themselves).
  PERFORM pg_temp.assert_fails(format('INSERT INTO public.role_permissions (role_id, permission_code) VALUES (%L, ''roles.manage'')', r), 'direct roles.manage in a custom role');

  -- Built-in roles are fixed.
  PERFORM pg_temp.assert_fails(format('SELECT app.save_custom_role(%L, %L, ''Owner'', NULL, ARRAY[''ncr.read''])', org, owner_role), 'change a built-in role');
  PERFORM pg_temp.assert_fails(format('SELECT app.delete_custom_role(%L)', owner_role), 'delete a built-in role');

  -- ---- Changing a role --------------------------------------------------------------------------------------------------------------------
  -- The role row is always written (its version moves in a real request; inside this one transaction now() cannot move, so the stamp is the evidence).
  PERFORM pg_temp.assert_eq((SELECT updated_by FROM public.roles WHERE id = r), NULL::uuid, 'not yet updated');
  PERFORM app.save_custom_role(org, r, 'Calibration technician', 'Records and reviews', ARRAY['calibration.read', 'calibration.record', 'calibration.manage']);
  PERFORM pg_temp.assert_eq((SELECT updated_by FROM public.roles WHERE id = r), '6c000000-0000-0000-0000-000000000101'::uuid, 'the role row was written');
  PERFORM pg_temp.assert_eq((SELECT array_agg(permission_code ORDER BY permission_code) FROM public.role_permissions WHERE role_id = r),
                            ARRAY['calibration.manage', 'calibration.read', 'calibration.record'], 'permissions replaced as a whole');
  -- Only the permissions change: the role row is still written.
  UPDATE public.roles SET updated_by = NULL WHERE id = r;
  PERFORM app.save_custom_role(org, r, 'Calibration technician', 'Records and reviews', ARRAY['calibration.read', 'calibration.record']);
  PERFORM pg_temp.assert_eq((SELECT updated_by FROM public.roles WHERE id = r), '6c000000-0000-0000-0000-000000000101'::uuid, 'a permission-only save writes the role row');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.role_permissions WHERE role_id = r), 2::bigint, 'permissions removed');

  -- ---- Someone holds it -------------------------------------------------------------------------------------------------------------------
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) VALUES (org, m_tech, r);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login('6c000000-0000-0000-0000-000000000103');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'calibration.record'), true, 'the holder gets the role''s permission');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'ncr.update'), false, 'and nothing else');
  PERFORM pg_temp.assert_fails(format('SELECT app.save_custom_role(%L, %L, ''Hacked'', NULL, ARRAY[''ncr.read''])', org, r), 'a holder cannot edit roles');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login('6c000000-0000-0000-0000-000000000101');
  PERFORM pg_temp.assert_fails(format('SELECT app.delete_custom_role(%L)', r), 'delete while someone holds it');
  PERFORM pg_temp.assert_fails(format('DELETE FROM public.roles WHERE id = %L', r), 'direct delete while someone holds it');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.user_role_assignments WHERE role_id = r), 1::bigint, 'the assignment is still there');
  -- Changing a role others hold takes effect for them at once.
  PERFORM app.save_custom_role(org, r, 'Calibration technician', 'Records and reviews', ARRAY['calibration.read']);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login('6c000000-0000-0000-0000-000000000103');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'calibration.record'), false, 'a removed permission is gone for the holder');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login('6c000000-0000-0000-0000-000000000101');
  DELETE FROM public.user_role_assignments WHERE role_id = r;
  PERFORM app.delete_custom_role(r);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.roles WHERE id = r), 0::bigint, 'deleted once nobody holds it');
  PERFORM pg_temp.logout();

  -- ---- Who may -------------------------------------------------------------------------------------------------------------------------------
  PERFORM pg_temp.login('6c000000-0000-0000-0000-000000000102');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'members.manage'), true, 'the admin manages people');
  PERFORM pg_temp.assert_fails(format('SELECT app.save_custom_role(%L, NULL, ''Admin role'', NULL, ARRAY[''ncr.read''])', org), 'an admin cannot make roles');
  PERFORM pg_temp.logout();

  -- Another organisation: its owner can neither see nor change this organisation's roles.
  PERFORM pg_temp.login('6c000000-0000-0000-0000-000000000104');
  PERFORM pg_temp.assert_fails(format('SELECT app.save_custom_role(%L, NULL, ''Sneaky'', NULL, ARRAY[''ncr.read''])', org), 'save in another organisation');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login('6c000000-0000-0000-0000-000000000101');
  r := app.save_custom_role(org, NULL, 'Mine', NULL, ARRAY['ncr.read']);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login('6c000000-0000-0000-0000-000000000104');
  PERFORM pg_temp.assert_fails(format('SELECT app.save_custom_role(%L, %L, ''Theirs'', NULL, ARRAY[''ncr.read''])', org2, r), 'change a role from another organisation');
  PERFORM pg_temp.assert_fails(format('SELECT app.delete_custom_role(%L)', r), 'delete a role from another organisation');
  PERFORM pg_temp.logout();

  -- ---- The grant rule ---------------------------------------------------------------------------------------------------------------------
  -- Someone who may manage roles but holds only ncr.read: they can hand out ncr.read, nothing more. (Such a holder cannot be made through the app,
  -- because a custom role cannot carry roles.manage, so the test builds one with the triggers off.)
  SET LOCAL session_replication_role = replica;
  INSERT INTO public.roles (organisation_id, key, name, is_system) VALUES (org, 'custom_limited_manager', 'Limited manager', false) RETURNING id INTO r_lim;
  INSERT INTO public.role_permissions (role_id, permission_code) VALUES (r_lim, 'roles.manage'), (r_lim, 'ncr.read');
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '6c000000-0000-0000-0000-000000000105', 'active') RETURNING id INTO m_lim;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) VALUES (org, m_lim, r_lim);
  SET LOCAL session_replication_role = DEFAULT;
  PERFORM pg_temp.login('6c000000-0000-0000-0000-000000000105');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'roles.manage'), true, 'the limited manager may manage roles');
  r2 := app.save_custom_role(org, NULL, 'Reader copy', NULL, ARRAY['ncr.read']);
  PERFORM pg_temp.assert_fails(format('SELECT app.save_custom_role(%L, NULL, ''Too much'', NULL, ARRAY[''ncr.read'', ''ncr.update''])', org), 'a permission the saver lacks');
  PERFORM pg_temp.assert_fails(format('SELECT app.save_custom_role(%L, %L, ''Reader copy'', NULL, ARRAY[''ncr.read'', ''calibration.manage''])', org, r2), 'adding a permission the saver lacks to an existing role');
  PERFORM app.delete_custom_role(r2);
  PERFORM pg_temp.logout();

  -- ---- The limit --------------------------------------------------------------------------------------------------------------------------
  PERFORM pg_temp.login('6c000000-0000-0000-0000-000000000101');
  SELECT count(*) INTO n FROM public.roles WHERE organisation_id = org AND NOT is_system;
  FOR i IN n + 1 .. 30 LOOP
    PERFORM app.save_custom_role(org, NULL, 'Role number ' || i, NULL, ARRAY['ncr.read']);
  END LOOP;
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.roles WHERE organisation_id = org AND NOT is_system), 30::bigint, 'thirty custom roles');
  PERFORM pg_temp.assert_fails(format('SELECT app.save_custom_role(%L, NULL, ''One too many'', NULL, ARRAY[''ncr.read''])', org), 'the thirty-first role');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
