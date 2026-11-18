-- External portal PT1 (docs/external-portal-plan.md): settings, parties, invitations, accepting, party admins, removal, and above all that an
-- external person is never a member and reads nothing else.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
  ('5c000000-0000-0000-0000-000000000e01', 'ann@pt1.test', now()), ('5c000000-0000-0000-0000-000000000e02', 'insp@pt1.test', now()),
  ('5c000000-0000-0000-0000-000000000e03', 'sam@supplier.test', now()), ('5c000000-0000-0000-0000-000000000e04', 'kim@supplier.test', now()),
  ('5c000000-0000-0000-0000-000000000e05', 'eve@pt1.test', now()), ('5c000000-0000-0000-0000-000000000e06', 'unconfirmed@supplier.test', NULL);

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '5c000000-0000-0000-0000-000000000e01'; insp uuid := '5c000000-0000-0000-0000-000000000e02';
  sam uuid := '5c000000-0000-0000-0000-000000000e03'; kim uuid := '5c000000-0000-0000-0000-000000000e04';
  eve uuid := '5c000000-0000-0000-0000-000000000e05'; unconf uuid := '5c000000-0000-0000-0000-000000000e06';
  org uuid; org2 uuid; sup uuid; sup2 uuid; cus uuid; party uuid; party2 uuid; acc_sam uuid; acc_kim uuid; acc_x uuid; r text; n bigint;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('PT1 Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('PT1 Beta'); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, insp, 'active');
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = 'inspector')
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id = insp;
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'ACME', 'Acme Castings'), (org, 'BOLT', 'Bolt Ltd');
  INSERT INTO public.customers (organisation_id, code, name) VALUES (org, 'CUS1', 'Big Customer');
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org2, 'OTH', 'Other Org Supplier');
  SELECT id INTO sup FROM public.suppliers WHERE organisation_id = org AND code = 'ACME';
  SELECT id INTO sup2 FROM public.suppliers WHERE organisation_id = org AND code = 'BOLT';
  SELECT id INTO cus FROM public.customers WHERE organisation_id = org;

  -- ---- permissions ----
  PERFORM pg_temp.login(insp);
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'external_access.read'), false, 'an inspector does not see external access');
  r := pg_temp.fails(format($f$SELECT app.set_portal_settings(%L, true, NULL, NULL)$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'nor change the settings');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'external_access.manage'), true, 'the owner manages external access');
  PERFORM pg_temp.assert_eq((SELECT portal_enabled FROM public.organisation_settings WHERE organisation_id = org), false, 'the portal starts off');
  PERFORM pg_temp.assert_eq((SELECT portal_require_mfa FROM public.organisation_settings WHERE organisation_id = org), true, 'two-factor on by default');
  r := pg_temp.fails(format($f$UPDATE public.organisation_settings SET portal_enabled = true WHERE organisation_id = %L$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'the switch is not a table write');

  -- Nothing works until the portal and the party are on.
  party := app.set_portal_party(org, 'supplier', sup, false, 'Pat in Quality');
  r := pg_temp.fails(format($f$SELECT app.invite_external_user(%L, 'sam@supplier.test', 'admin', NULL)$f$, party));
  PERFORM pg_temp.assert_eq(r LIKE 'QM032%not switched on%', true, 'the portal is off: no invitation');
  PERFORM app.set_portal_settings(org, true, NULL, false);
  r := pg_temp.fails(format($f$SELECT app.invite_external_user(%L, 'sam@supplier.test', 'admin', NULL)$f$, party));
  PERFORM pg_temp.assert_eq(r LIKE 'QM032%not switched on%', true, 'the party is off: no invitation');
  PERFORM app.set_portal_party(org, 'supplier', sup, true);
  PERFORM pg_temp.assert_eq((SELECT contact_name FROM public.portal_parties WHERE id = party), 'Pat in Quality', 'the contact name is kept when only the switch moves');
  r := pg_temp.fails(format($f$SELECT app.set_portal_party(%L, 'supplier', %L, true)$f$, org, (SELECT id FROM public.suppliers WHERE organisation_id = org2 LIMIT 1)));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'another organisation''s supplier is not found');
  r := pg_temp.fails(format($f$UPDATE public.portal_parties SET supplier_id = %L WHERE id = %L$f$, sup2, party));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a party row is not a table write either');

  -- ---- invitations ----
  acc_sam := app.invite_external_user(party, ' Sam@Supplier.test ', 'admin', 'Welcome to the portal');
  PERFORM pg_temp.assert_eq((SELECT invited_email || '|' || status || '|' || role FROM public.external_access WHERE id = acc_sam), 'sam@supplier.test|invited|admin', 'trimmed, lower case, invited');
  r := pg_temp.fails(format($f$SELECT app.invite_external_user(%L, 'sam@supplier.test', 'member', NULL)$f$, party));
  PERFORM pg_temp.assert_eq(r LIKE 'QM032%already has access%', true, 'no second invitation for the same address');
  r := pg_temp.fails(format($f$SELECT app.invite_external_user(%L, 'insp@pt1.test', 'member', NULL)$f$, party));
  PERFORM pg_temp.assert_eq(r LIKE 'QM032%one of your own people%', true, 'a member cannot be invited as external');
  r := pg_temp.fails(format($f$SELECT app.invite_external_user(%L, 'not-an-address', 'member', NULL)$f$, party));
  PERFORM pg_temp.assert_eq(r LIKE 'QM032%valid email%', true, 'a bad address');
  r := pg_temp.fails(format($f$SELECT app.invite_external_user(%L, 'x@supplier.test', 'owner', NULL)$f$, party));
  PERFORM pg_temp.assert_eq(r LIKE 'QM032%admin or member%', true, 'only admin or member');
  r := pg_temp.fails(format($f$SELECT app.resend_external_invitation(%L)$f$, acc_sam));
  PERFORM pg_temp.assert_eq(r LIKE 'QM032%just sent%', true, 'not resent within a minute');
  PERFORM pg_temp.logout();

  -- ---- accepting ----
  PERFORM pg_temp.login(sam);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.my_portal_invitations()), 1::bigint, 'Sam sees the invitation by address');
  PERFORM pg_temp.assert_eq((SELECT organisation_name || '|' || party_name || '|' || party_kind FROM app.my_portal_invitations()), 'PT1 Alpha|Acme Castings|supplier', 'in words');
  PERFORM pg_temp.assert_eq(app.is_member(org), false, 'the invited person is not a member');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.my_portal_access()), 0::bigint, 'and has no access yet');
  r := pg_temp.fails(format($f$SELECT app.accept_portal_invitation(%L)$f$, acc_sam));
  PERFORM pg_temp.assert_eq(r, 'ok', 'accepted');
  PERFORM pg_temp.assert_eq(app.is_member(org), false, 'still not a member after accepting');
  PERFORM pg_temp.assert_eq((SELECT organisation_name || '|' || role || '|' || coalesce(contact_name, '') FROM app.my_portal_access()), 'PT1 Alpha|admin|Pat in Quality', 'access listed with the contact name');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.portal_my_access(org)), 1::bigint, 'the guard helper answers');
  PERFORM pg_temp.assert_eq((SELECT party_kind || '|' || (supplier_id = sup)::text FROM app.portal_my_access(org)), 'supplier|true', 'with the party');
  PERFORM pg_temp.assert_eq(app.portal_mfa_blocked(org), false, 'two-factor is off for this organisation');
  PERFORM pg_temp.logout();

  -- An unconfirmed address cannot accept.
  PERFORM pg_temp.login(ann);
  PERFORM app.invite_external_user(party, 'unconfirmed@supplier.test', 'member', NULL);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(unconf);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.my_portal_invitations()), 0::bigint, 'an unconfirmed address sees nothing');
  PERFORM pg_temp.logout();

  -- ---- nothing else is readable by an external person ----
  PERFORM pg_temp.login(sam);
  FOREACH r IN ARRAY ARRAY['public.suppliers', 'public.customers', 'public.nonconformances', 'public.supplier_scars', 'public.parts', 'public.organisation_users',
                            'public.notifications', 'public.portal_parties', 'public.organisation_settings', 'audit.events'] LOOP
    PERFORM pg_temp.assert_eq(pg_temp.count_rows('SELECT 1 FROM ' || r || ' WHERE organisation_id = ''' || org || ''''), 0::bigint, 'an external person reads nothing from ' || r);
  END LOOP;
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.external_access), 1::bigint, 'only their own access row');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'ncr.read'), false, 'holds no permission');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'external_access.read'), false, 'not even this one');
  r := pg_temp.fails(format($f$SELECT * FROM app.list_external_access(%L)$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'the people list needs the permission (or a party admin of one party)');
  PERFORM pg_temp.logout();

  -- ---- a party admin invites and removes colleagues, within limits ----
  PERFORM pg_temp.login(sam);
  acc_kim := app.invite_external_user(party, 'kim@supplier.test', 'member', NULL);
  r := pg_temp.fails(format($f$SELECT app.invite_external_user(%L, 'boss@supplier.test', 'admin', NULL)$f$, party));
  PERFORM pg_temp.assert_eq(r LIKE 'QM032%Only the organisation can make someone an admin%', true, 'a party admin cannot make another admin');
  r := pg_temp.fails(format($f$SELECT app.invite_external_user(%L, 'z@other.test', 'member', NULL)$f$, gen_random_uuid()));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'an unknown party is not found');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.list_external_access(org, party)), 3::bigint, 'the admin lists their own party''s people');
  r := pg_temp.fails(format($f$SELECT * FROM app.list_external_access(%L)$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'but not the whole organisation');
  r := pg_temp.fails(format($f$SELECT app.remove_external_access(%L, 'leaving')$f$, acc_sam));
  PERFORM pg_temp.assert_eq(r LIKE 'QM032%cannot remove your own%', true, 'not themselves');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login(kim);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.my_portal_invitations()), 1::bigint, 'Kim sees the invitation');
  PERFORM app.accept_portal_invitation(acc_kim);
  PERFORM pg_temp.assert_eq((SELECT role FROM app.my_portal_access()), 'member', 'a member');
  r := pg_temp.fails(format($f$SELECT app.invite_external_user(%L, 'q@supplier.test', 'member', NULL)$f$, party));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'an ordinary party member cannot invite');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login(sam);
  PERFORM app.remove_external_access(acc_kim, 'Left the company');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.external_access WHERE id = acc_kim), 0::bigint, 'a party admin cannot read the row directly, only through the list');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT status || '|' || removed_reason FROM public.external_access WHERE id = acc_kim), 'removed|Left the company', 'removed with the reason, kept');
  PERFORM pg_temp.login(kim);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.my_portal_access()), 0::bigint, 'Kim has no access any more');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.portal_my_access(org)), 0::bigint, 'the guard helper says none');
  PERFORM pg_temp.logout();

  -- ---- staff: suspend, switch off, tiles, the people list ----
  PERFORM pg_temp.login(ann);
  PERFORM app.set_external_access_suspended(acc_sam, true, 'Under review');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(sam);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.my_portal_access()), 0::bigint, 'suspended: no access');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ann);
  PERFORM app.set_external_access_suspended(acc_sam, false);
  PERFORM app.set_portal_party(org, 'supplier', sup, false);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(sam);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.my_portal_access()), 0::bigint, 'the party switched off: access ends at once');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ann);
  PERFORM app.set_portal_party(org, 'supplier', sup, true, NULL, '{"scorecard": true}');
  PERFORM pg_temp.assert_eq((SELECT tiles->>'scorecard' FROM public.portal_parties WHERE id = party), 'true', 'tiles saved');
  party2 := app.set_portal_party(org, 'customer', cus, true);
  PERFORM pg_temp.assert_eq((SELECT party_kind FROM public.portal_parties WHERE id = party2), 'customer', 'a customer party');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.list_external_access(org)), 3::bigint, 'staff list everyone, removed included');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.list_external_access(org) WHERE last_sign_in_at IS NOT NULL), 2::bigint, 'last sign-in shown');
  r := pg_temp.fails(format($f$DELETE FROM public.external_access WHERE id = %L$f$, acc_sam));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'never deleted');
  r := pg_temp.fails(format($f$SELECT app.remove_external_access(%L, 'x')$f$, acc_kim));
  PERFORM pg_temp.assert_eq(r LIKE 'QM032%reason%' OR r LIKE 'QM032%already removed%', true, 'removing again is refused');
  PERFORM pg_temp.logout();

  -- ---- another organisation's staff see nothing ----
  PERFORM pg_temp.login(eve);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.external_access) + (SELECT count(*) FROM public.portal_parties), 0::bigint, 'another organisation reads nothing');
  r := pg_temp.fails(format($f$SELECT app.invite_external_user(%L, 'a@b.test', 'member', NULL)$f$, party));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'and cannot invite into our party');
  PERFORM pg_temp.logout();

  -- ---- two-factor ----
  PERFORM pg_temp.login(ann);
  PERFORM app.set_portal_settings(org, NULL, NULL, true);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(sam);
  PERFORM pg_temp.assert_eq(app.portal_mfa_blocked(org), true, 'two-factor required and not passed');
  PERFORM pg_temp.assert_eq((SELECT mfa_required FROM app.my_portal_access()), true, 'listed as needing it');
  PERFORM set_config('request.jwt.claims', json_build_object('sub', sam, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  PERFORM pg_temp.assert_eq(app.portal_mfa_blocked(org), false, 'passed');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
