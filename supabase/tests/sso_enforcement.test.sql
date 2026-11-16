-- Single sign-on SS3 (docs/sso-plan.md, SS6–SS9): requiring the company sign-in is enforced where the two-factor rule is. Only a session from THIS
-- organisation's provider counts (the whole amr array is searched); a break-glass owner or admin gets in with a password AND two-factor, never a
-- password alone; system work (no amr) is not affected; the company sign-in can meet the two-factor rule; switching on is refused unless it is
-- known to work; what it depends on cannot be removed while in use; every change is written down and told to owners and admins with no actor;
-- an operator can make it optional again.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

-- A signed-in session: aal and the amr methods as Supabase writes them (most recent first).
CREATE FUNCTION pg_temp.session(p_user uuid, p_aal text, p_amr jsonb) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', (jsonb_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)
                                            || CASE WHEN p_amr IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('amr', p_amr) END)::text, true);
  PERFORM set_config('role', 'authenticated', true);
END $$;
CREATE FUNCTION pg_temp.password() RETURNS jsonb LANGUAGE sql AS $$ SELECT '[{"method": "password", "timestamp": 1700000000}]'::jsonb $$;
CREATE FUNCTION pg_temp.saml(p_provider uuid) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_array(jsonb_build_object('method', 'sso/saml', 'provider', p_provider, 'timestamp', 1700000000)) $$;
CREATE FUNCTION pg_temp.assert_true(p boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p IS NOT TRUE THEN RAISE EXCEPTION 'FAILED: %', label; END IF; END $$;
CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

INSERT INTO auth.users (id, email, is_sso_user) VALUES
  ('5f300000-0000-0000-0000-000000000a01', 'ann@acme.test', false), ('5f300000-0000-0000-0000-000000000a02', 'ali@acme.test', false),
  ('5f300000-0000-0000-0000-000000000a03', 'ivy@acme.test', false), ('5f300000-0000-0000-0000-000000000a04', 'sam@acme.test', true),
  ('5f300000-0000-0000-0000-000000000b01', 'bob@rival.test', false), ('5f300000-0000-0000-0000-000000000c01', 'op@fortress.test', false);

DO $$
DECLARE
  ann uuid := '5f300000-0000-0000-0000-000000000a01'; ali uuid := '5f300000-0000-0000-0000-000000000a02';
  ivy uuid := '5f300000-0000-0000-0000-000000000a03'; sam uuid := '5f300000-0000-0000-0000-000000000a04';
  bob uuid := '5f300000-0000-0000-0000-000000000b01'; op uuid := '5f300000-0000-0000-0000-000000000c01';
  sp uuid := '5f3000aa-0000-0000-0000-000000000001'; rival_sp uuid := '5f3000aa-0000-0000-0000-000000000002';
  org uuid; rival uuid; d uuid; rd uuid; p uuid; r text; c public.sso_changes%ROWTYPE; n public.notifications%ROWTYPE; t_id uuid;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('SS3 Acme'); d := app.add_sso_domain(org, 'acme.test'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(bob); rival := app.create_organisation('SS3 Rival'); rd := app.add_sso_domain(rival, 'rival.test'); PERFORM pg_temp.logout();
  UPDATE public.profiles SET first_name = 'Ann', surname = 'Owner' WHERE id = ann;
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, ali, 'active'), (org, ivy, 'active'), (org, sam, 'active');
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = CASE ou.user_id WHEN ali THEN 'admin' ELSE 'inspector' END)
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id IN (ali, ivy, sam);
  INSERT INTO public.platform_admins (user_id, note) VALUES (op, 'operator');
  SELECT id INTO t_id FROM public.notification_event_types WHERE key = 'sso_changes.created';

  -- ---- nothing changes until single sign-on is required ----
  PERFORM pg_temp.session(ann, 'aal1', pg_temp.password());
  PERFORM pg_temp.assert_true(app.is_member(org), 'a password session is a member while single sign-on is off');
  r := pg_temp.fails(format($f$SELECT app.set_sso_mode(%L, 'optional')$f$, org));
  PERFORM pg_temp.assert_true(r LIKE 'QM030%Connect your company%', 'optional needs a connected provider');
  r := pg_temp.fails(format($f$SELECT app.set_sso_mode(%L, 'sometimes')$f$, org));
  PERFORM pg_temp.assert_true(r LIKE 'QM030%Choose off, optional or required%', 'only the three modes');
  PERFORM pg_temp.logout();

  PERFORM app.system_sso_domain_check(d, true, NULL, ann);
  PERFORM app.system_sso_domain_check(rd, true, NULL, bob);
  p := app.system_sso_save_provider(org, ann, sp, 'https://idp.acme.test/entity', 'https://idp.acme.test/metadata', NULL, ARRAY['acme.test']);
  PERFORM app.system_sso_save_provider(rival, bob, rival_sp, 'https://idp.rival.test/entity', 'https://idp.rival.test/metadata', NULL, ARRAY['rival.test']);

  -- ---- optional: passwords still work, and so does the company sign-in ----
  PERFORM pg_temp.session(ivy, 'aal1', pg_temp.password());
  r := pg_temp.fails(format($f$SELECT app.set_sso_mode(%L, 'optional')$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'only security managers change the mode');
  PERFORM pg_temp.session(ann, 'aal1', pg_temp.password());
  PERFORM pg_temp.assert_eq(app.set_sso_mode(org, 'optional'), 'optional', 'optional once a provider is connected');
  PERFORM pg_temp.assert_true(app.is_member(org), 'a password session still works while optional');

  -- ---- required: only after signing in through it ----
  r := pg_temp.fails(format($f$SELECT app.set_sso_mode(%L, 'required')$f$, org));
  PERFORM pg_temp.assert_true(r LIKE 'QM030%Sign in with your company account first%', 'required is refused from a password session');
  PERFORM pg_temp.session(ann, 'aal1', pg_temp.saml(rival_sp));
  r := pg_temp.fails(format($f$SELECT app.set_sso_mode(%L, 'required')$f$, org));
  PERFORM pg_temp.assert_true(r LIKE 'QM030%Sign in with your company account first%', 'and from a session through ANOTHER organisation''s provider');
  PERFORM pg_temp.session(ann, 'aal1', pg_temp.saml(sp));
  PERFORM pg_temp.assert_eq(app.set_sso_mode(org, 'required'), 'required', 'required from a session through its own provider');
  PERFORM pg_temp.logout();

  SELECT * INTO c FROM public.sso_changes WHERE organisation_id = org AND kind = 'mode' ORDER BY created_at DESC, id DESC LIMIT 1;
  PERFORM pg_temp.assert_eq(c.from_value || '>' || c.to_value, 'optional>required', 'the change is written down');
  PERFORM pg_temp.assert_eq(c.user_name, 'Ann Owner', 'with who made it');
  PERFORM pg_temp.assert_true(c.guidance LIKE '%break-glass members%Fortress support%', 'and what to do if the company sign-in stops working');
  SELECT * INTO n FROM public.notifications WHERE event_type_id = t_id AND entity_id = c.id::text;
  PERFORM pg_temp.assert_true(n.id IS NOT NULL AND n.actor_user_id IS NULL, 'a notice with no actor, so the person who changed it is told too');
  PERFORM pg_temp.assert_true((SELECT email_default FROM public.notification_event_types WHERE id = t_id), 'emailed by default');
  r := pg_temp.fails(format($f$UPDATE public.sso_changes SET summary = 'x' WHERE id = %L$f$, c.id));
  PERFORM pg_temp.assert_true(r LIKE 'QM030%never changed%', 'the history is frozen');

  -- ---- who gets in while required ----
  PERFORM pg_temp.session(ivy, 'aal1', pg_temp.password());
  PERFORM pg_temp.assert_true(NOT app.is_member(org), 'a password session is refused');
  PERFORM pg_temp.assert_true(NOT app.has_permission(org, 'ncr.read'), 'and holds no permission');
  PERFORM pg_temp.assert_true(NOT EXISTS (SELECT 1 FROM app.member_organisation_ids() x WHERE x = org), 'nor lists the organisation');
  PERFORM pg_temp.assert_true((SELECT provider_id = sp AND NOT break_glass FROM app.sso_blocked_organisations() WHERE organisation_id = org),
    'the blocked list names the provider to sign in with');
  PERFORM pg_temp.assert_true(NOT EXISTS (SELECT 1 FROM app.mfa_blocked_organisations() WHERE organisation_id = org), 'it is not a two-factor block');
  PERFORM pg_temp.session(ivy, 'aal2', pg_temp.password());
  PERFORM pg_temp.assert_true(NOT app.is_member(org), 'two-factor alone does not replace the company sign-in');
  PERFORM pg_temp.session(ivy, 'aal1', pg_temp.saml(rival_sp));
  PERFORM pg_temp.assert_true(NOT app.is_member(org), 'another organisation''s provider does not count');
  PERFORM pg_temp.session(sam, 'aal1', pg_temp.saml(sp));
  PERFORM pg_temp.assert_true(app.is_member(org) AND app.has_permission(org, 'ncr.read'), 'a session through its own provider gets in');
  PERFORM pg_temp.assert_eq(app.sso_session_method(org), 'sso', 'recorded as a company sign-in');
  PERFORM pg_temp.session(sam, 'aal2', ('[{"method": "totp", "timestamp": 1700000100}]'::jsonb || pg_temp.saml(sp)));
  PERFORM pg_temp.assert_true(app.is_member(org), 'the provider is found anywhere in amr, not only first');
  PERFORM pg_temp.session(sam, 'aal1', '[{"method": "sso/saml"}]'::jsonb);
  PERFORM pg_temp.assert_true(NOT app.is_member(org), 'a company sign-in without a provider id does not count');
  PERFORM pg_temp.session(ivy, 'aal2', NULL);
  PERFORM pg_temp.assert_true(app.is_member(org), 'system work acting for a person (no amr) is not affected');

  -- ---- the session limit is 12 hours unless one is set ----
  PERFORM pg_temp.session(sam, 'aal1', pg_temp.saml(sp));
  PERFORM pg_temp.assert_eq(app.max_session_hours(org), 12, '12 hours while required');
  PERFORM pg_temp.logout();
  UPDATE public.organisation_settings SET max_session_hours = 72 WHERE organisation_id = org;
  PERFORM pg_temp.session(sam, 'aal1', pg_temp.saml(sp));
  PERFORM pg_temp.assert_eq(app.max_session_hours(org), 72, 'a stored limit wins');
  PERFORM pg_temp.logout();
  UPDATE public.organisation_settings SET max_session_hours = NULL WHERE organisation_id = org;

  -- ---- break-glass: owners or admins, at most three, password AND two-factor ----
  PERFORM pg_temp.session(sam, 'aal1', pg_temp.saml(sp));
  r := pg_temp.fails(format($f$SELECT app.set_sso_break_glass(%L, ARRAY[%L]::uuid[])$f$, org, ivy));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'an inspector cannot name them');
  PERFORM pg_temp.session(ann, 'aal1', pg_temp.saml(sp));
  r := pg_temp.fails(format($f$SELECT app.set_sso_break_glass(%L, ARRAY[%L]::uuid[])$f$, org, ivy));
  PERFORM pg_temp.assert_true(r LIKE 'QM030%Only owners and admins%', 'only owners and admins can be break-glass members');
  r := pg_temp.fails(format($f$SELECT app.set_sso_break_glass(%L, ARRAY[%L, %L, %L, %L]::uuid[])$f$, org, ann, ali, ivy, sam));
  PERFORM pg_temp.assert_true(r LIKE 'QM030%At most three%', 'at most three');
  PERFORM pg_temp.assert_eq(app.set_sso_break_glass(org, ARRAY[ali, ali]), 1, 'duplicates count once');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_true(EXISTS (SELECT 1 FROM public.sso_changes WHERE organisation_id = org AND kind = 'break_glass_list'), 'the list change is written down');
  r := pg_temp.fails(format($f$DELETE FROM public.sso_break_glass_members WHERE organisation_id = %L$f$, org));
  PERFORM pg_temp.assert_true(r LIKE 'QM030%never deleted%', 'never deleted');

  PERFORM pg_temp.session(ali, 'aal1', pg_temp.password());
  PERFORM pg_temp.assert_true(NOT app.is_member(org), 'a break-glass member with a password alone is refused');
  PERFORM pg_temp.assert_true((SELECT break_glass FROM app.sso_blocked_organisations() WHERE organisation_id = org), 'and told they are break-glass');
  PERFORM pg_temp.session(ali, 'aal2', pg_temp.password());
  PERFORM pg_temp.assert_true(app.is_member(org), 'with a password and two-factor they get in');
  PERFORM pg_temp.assert_eq(app.sso_session_method(org), 'break_glass', 'recorded as break-glass');
  PERFORM pg_temp.logout();
  UPDATE public.user_role_assignments SET role_id = (SELECT id FROM public.roles WHERE organisation_id = org AND key = 'inspector')
   WHERE membership_id = (SELECT id FROM public.organisation_users WHERE organisation_id = org AND user_id = ali);
  PERFORM pg_temp.session(ali, 'aal2', pg_temp.password());
  PERFORM pg_temp.assert_true(NOT app.is_member(org), 'no longer an owner or admin: break-glass no longer works');
  PERFORM pg_temp.logout();
  UPDATE public.user_role_assignments SET role_id = (SELECT id FROM public.roles WHERE organisation_id = org AND key = 'admin')
   WHERE membership_id = (SELECT id FROM public.organisation_users WHERE organisation_id = org AND user_id = ali);

  -- ---- sign-ins: counted per hour; the first break-glass use is told to owners and admins ----
  PERFORM pg_temp.assert_true(app.system_record_sso_sign_in(org, sam, 'sso'), 'first company sign-in of the hour');
  PERFORM pg_temp.assert_true(NOT app.system_record_sso_sign_in(org, sam, 'sso'), 'then counted');
  PERFORM pg_temp.assert_eq((SELECT count FROM public.sso_sign_ins WHERE organisation_id = org AND user_id = sam), 2, 'two requests');
  PERFORM pg_temp.assert_true(app.system_record_sso_sign_in(org, ali, 'break_glass'), 'first break-glass use');
  PERFORM app.system_record_sso_sign_in(org, ali, 'break_glass');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.sso_changes WHERE organisation_id = org AND kind = 'break_glass_used'), 1::bigint, 'written down once an hour');
  PERFORM pg_temp.assert_true(EXISTS (SELECT 1 FROM public.notifications nn JOIN public.sso_changes cc ON cc.id::text = nn.entity_id
                                       WHERE cc.kind = 'break_glass_used' AND nn.event_type_id = t_id AND nn.actor_user_id IS NULL), 'and told');
  PERFORM pg_temp.session(sam, 'aal1', pg_temp.saml(sp));
  r := pg_temp.fails(format($f$SELECT app.system_record_sso_sign_in(%L, %L, 'sso')$f$, org, sam));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'only the API login records sign-ins');
  PERFORM pg_temp.session(ivy, 'aal2', NULL);
  PERFORM pg_temp.assert_eq(pg_temp.count_rows(format($q$SELECT 1 FROM public.sso_sign_ins WHERE organisation_id = %L$q$, org)), 0::bigint, 'an inspector reads no sign-ins');
  PERFORM pg_temp.session(ali, 'aal2', pg_temp.password());
  PERFORM pg_temp.assert_eq(pg_temp.count_rows(format($q$SELECT 1 FROM public.sso_sign_ins WHERE organisation_id = %L$q$, org)), 2::bigint, 'an admin does');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.sso_password_members(org) WHERE NOT break_glass), 2::bigint, 'password members who would be blocked: Ann and Ivy');
  PERFORM pg_temp.session(bob, 'aal1', pg_temp.password());
  PERFORM pg_temp.assert_eq(pg_temp.count_rows(format($q$SELECT 1 FROM public.sso_changes WHERE organisation_id = %L$q$, org)), 0::bigint, 'another organisation sees nothing');

  -- ---- the company sign-in can meet the two-factor rule ----
  PERFORM pg_temp.logout();
  UPDATE public.organisation_settings SET require_mfa = true WHERE organisation_id = org;
  PERFORM pg_temp.session(sam, 'aal1', pg_temp.saml(sp));
  PERFORM pg_temp.assert_true(app.is_member(org), 'trusted: a company sign-in meets the two-factor rule');
  PERFORM pg_temp.session(ann, 'aal1', pg_temp.saml(sp));
  r := pg_temp.fails(format($f$SELECT app.set_sso_trust_idp_mfa(%L, false)$f$, org));
  PERFORM pg_temp.assert_true(r LIKE 'QM030%Set up two-factor%', 'switching trust off from a session that would then fail is refused');
  PERFORM pg_temp.session(ann, 'aal2', ('[{"method": "totp", "timestamp": 1700000100}]'::jsonb || pg_temp.saml(sp)));
  PERFORM pg_temp.assert_eq(app.set_sso_trust_idp_mfa(org, false), false, 'switched off with two-factor');
  PERFORM pg_temp.session(sam, 'aal1', pg_temp.saml(sp));
  PERFORM pg_temp.assert_true(NOT app.is_member(org), 'not trusted: the company sign-in alone no longer meets it');
  PERFORM pg_temp.assert_true(EXISTS (SELECT 1 FROM app.mfa_blocked_organisations() WHERE organisation_id = org), 'and that is a two-factor block');
  PERFORM pg_temp.assert_true(NOT EXISTS (SELECT 1 FROM app.sso_blocked_organisations() WHERE organisation_id = org), 'not a single sign-on one');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_true(EXISTS (SELECT 1 FROM public.sso_changes WHERE organisation_id = org AND kind = 'two_factor'), 'the trust change is written down');
  UPDATE public.organisation_settings SET require_mfa = false, sso_trust_idp_mfa = true WHERE organisation_id = org;

  -- ---- what it depends on stays while it is in use ----
  PERFORM pg_temp.session(ann, 'aal1', pg_temp.saml(sp));
  r := pg_temp.fails(format($f$SELECT app.remove_sso_domain(%L, 'Moving to a new domain')$f$, d));
  PERFORM pg_temp.assert_true(r LIKE 'QM030%switch single sign-on off%', 'a verified domain is not removed while single sign-on is in use');
  PERFORM pg_temp.logout();
  r := pg_temp.fails(format($f$SELECT app.system_sso_disable_provider(%L, %L, 'Changing provider')$f$, p, ann));
  PERFORM pg_temp.assert_true(r LIKE 'QM030%Switch single sign-on off%', 'nor the provider disconnected');

  -- ---- invitations while required: only at the verified domains ----
  r := pg_temp.fails(format($f$INSERT INTO public.organisation_users (organisation_id, invited_email, status) VALUES (%L, 'guest@elsewhere.test', 'invited')$f$, org));
  PERFORM pg_temp.assert_true(r LIKE 'QM015%requires single sign-on%acme.test%', 'an outside address is refused');
  r := pg_temp.fails(format($f$INSERT INTO public.organisation_users (organisation_id, invited_email, status) VALUES (%L, 'new@uk.acme.test', 'invited')$f$, org));
  PERFORM pg_temp.assert_eq(r, 'ok', 'an address at a sub-domain is fine');

  -- ---- recovery: an operator with MFA makes it optional again ----
  PERFORM pg_temp.session(ann, 'aal2', pg_temp.saml(sp));
  r := pg_temp.fails(format($f$SELECT app.platform_recover_sso(%L, 'The certificate expired overnight', 'Called the owner back on file')$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'only platform operators');
  PERFORM pg_temp.session(op, 'aal1', pg_temp.password());
  r := pg_temp.fails(format($f$SELECT app.platform_recover_sso(%L, 'The certificate expired overnight', 'Called the owner back on file')$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'and only with MFA');
  PERFORM pg_temp.session(op, 'aal2', pg_temp.password());
  r := pg_temp.fails(format($f$SELECT app.platform_recover_sso(%L, 'short', 'Called the owner back on file')$f$, org));
  PERFORM pg_temp.assert_true(r LIKE 'QM030%Say why%', 'a reason is needed');
  PERFORM app.platform_recover_sso(org, 'The certificate expired overnight', 'Called the owner back on file');
  PERFORM pg_temp.assert_true((SELECT sso_mode = 'optional' AND connected FROM app.platform_sso_modes(ARRAY[org])), 'optional again, provider kept');
  r := pg_temp.fails(format($f$SELECT app.platform_recover_sso(%L, 'The certificate expired overnight', 'Called the owner back on file')$f$, org));
  PERFORM pg_temp.assert_true(r LIKE 'QM030%nothing to recover%', 'only while required');
  PERFORM pg_temp.logout();
  SELECT * INTO c FROM public.sso_changes WHERE organisation_id = org ORDER BY created_at DESC, id DESC LIMIT 1;
  PERFORM pg_temp.assert_true(c.kind = 'recovery' AND c.reason LIKE 'The certificate%' AND c.verification LIKE 'Called%', 'the recovery is written down with its reason');
  PERFORM pg_temp.session(ivy, 'aal1', pg_temp.password());
  PERFORM pg_temp.assert_true(app.is_member(org), 'passwords work again');

  -- ---- off: then the provider and domains can go ----
  PERFORM pg_temp.session(ann, 'aal1', pg_temp.password());
  PERFORM app.set_sso_mode(org, 'off');
  PERFORM app.remove_sso_domain(d, 'Moving to a new domain');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(app.sso_verified_domains(org), '{}'::text[], 'domain removed once off');
END $$;

ROLLBACK;
