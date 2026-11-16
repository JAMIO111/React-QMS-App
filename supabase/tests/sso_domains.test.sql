-- Single sign-on SS1 (docs/sso-plan.md, SS3): domains claimed by an organisation and proved by a DNS record. Only owners and admins add and remove
-- them; only the API login records a check; a domain is verified by one organisation at a time; allowed email domains are respected; nothing is
-- deleted; a verified domain whose record goes is flagged, not removed.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

CREATE FUNCTION pg_temp.assert_true(p boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p IS NOT TRUE THEN RAISE EXCEPTION 'FAILED: %', label; END IF; END $$;
CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

INSERT INTO auth.users (id, email) VALUES
  ('5f000000-0000-0000-0000-000000000a01', 'ann@acme.test'), ('5f000000-0000-0000-0000-000000000a02', 'qm@acme.test'),
  ('5f000000-0000-0000-0000-000000000b01', 'bob@rival.test');

DO $$
DECLARE
  ann uuid := '5f000000-0000-0000-0000-000000000a01'; qm uuid := '5f000000-0000-0000-0000-000000000a02'; bob uuid := '5f000000-0000-0000-0000-000000000b01';
  org uuid; rival uuid; d uuid; d2 uuid; rd uuid; r text; n int;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('SS1 Acme'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(bob); rival := app.create_organisation('SS1 Rival'); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, qm, 'active');
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = 'quality_manager')
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id = qm;

  -- ---- settings start off ----
  PERFORM pg_temp.assert_eq((SELECT sso_mode FROM public.organisation_settings WHERE organisation_id = org), 'off', 'single sign-on starts off');
  PERFORM pg_temp.assert_eq((SELECT sso_join FROM public.organisation_settings WHERE organisation_id = org), 'invited', 'invited people only');
  PERFORM pg_temp.assert_eq((SELECT sso_trust_idp_mfa FROM public.organisation_settings WHERE organisation_id = org), true, 'company two-factor trusted');
  PERFORM pg_temp.login(ann);
  r := pg_temp.fails(format($f$UPDATE public.organisation_settings SET sso_mode = 'required' WHERE organisation_id = %L$f$, org));
  PERFORM pg_temp.assert_true(r LIKE '42501%' OR r = 'ok', 'no direct write of the mode');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT sso_mode FROM public.organisation_settings WHERE organisation_id = org), 'off', 'still off');

  -- ---- only owners and admins add domains ----
  PERFORM pg_temp.login(qm);
  r := pg_temp.fails(format($f$SELECT app.add_sso_domain(%L, 'acme.test')$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a quality manager cannot add a domain');
  PERFORM pg_temp.assert_eq(pg_temp.count_rows('SELECT 1 FROM public.organisation_sso_domains'), 0::bigint, 'and cannot read them');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(bob);
  r := pg_temp.fails(format($f$SELECT app.add_sso_domain(%L, 'acme.test')$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'another organisation''s owner gets not found');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login(ann);
  d := app.add_sso_domain(org, ' @Acme.TEST ');
  PERFORM pg_temp.assert_eq((SELECT domain FROM public.organisation_sso_domains WHERE id = d), 'acme.test', 'normalised');
  PERFORM pg_temp.assert_true((SELECT verification_token ~ '^[0-9a-f]{32}$' FROM public.organisation_sso_domains WHERE id = d), 'a random token');
  PERFORM pg_temp.assert_eq((SELECT verified_at FROM public.organisation_sso_domains WHERE id = d), NULL::timestamptz, 'not verified on adding');
  r := pg_temp.fails(format($f$SELECT app.add_sso_domain(%L, 'acme.test')$f$, org));
  PERFORM pg_temp.assert_true(r LIKE 'QM030%already on the list%', 'the same domain twice is refused');
  r := pg_temp.fails(format($f$SELECT app.add_sso_domain(%L, 'not a domain')$f$, org));
  PERFORM pg_temp.assert_true(r LIKE 'QM030%is not an email domain%', 'a typo is refused with the reason');
  -- People cannot write the table, choose the token or mark a domain verified.
  r := pg_temp.fails(format($f$INSERT INTO public.organisation_sso_domains (organisation_id, domain, verification_token) VALUES (%L, 'x.test', repeat('a', 32))$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'no direct insert');
  r := pg_temp.fails(format($f$UPDATE public.organisation_sso_domains SET verified_at = now() WHERE id = %L$f$, d));
  PERFORM pg_temp.assert_true(r LIKE '42501%' OR r = 'ok', 'no direct update');
  PERFORM pg_temp.assert_eq((SELECT verified_at FROM public.organisation_sso_domains WHERE id = d), NULL::timestamptz, 'still not verified');
  r := pg_temp.fails(format($f$SELECT app.system_sso_domain_check(%L, true, null, %L)$f$, d, ann));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a person cannot record a DNS check');
  PERFORM pg_temp.logout();

  -- ---- allowed email domains (SE6) must agree ----
  PERFORM pg_temp.login(ann);
  PERFORM app.set_allowed_email_domains(org, ARRAY['acme.test']);
  r := pg_temp.fails(format($f$SELECT app.add_sso_domain(%L, 'gmail.test')$f$, org));
  PERFORM pg_temp.assert_true(r LIKE 'QM030%only invites people at acme.test%', 'a domain outside the allowed ones is refused');
  d2 := app.add_sso_domain(org, 'uk.acme.test');
  PERFORM pg_temp.assert_true(d2 IS NOT NULL, 'a sub-domain of an allowed one is fine');
  PERFORM pg_temp.logout();

  -- ---- checks (the API login) ----
  PERFORM pg_temp.assert_eq(app.system_sso_domain_check(d, false, NULL, ann), 'unverified', 'no record yet');
  PERFORM pg_temp.assert_true((SELECT check_error LIKE '%not found yet%' AND verified_at IS NULL FROM public.organisation_sso_domains WHERE id = d), 'the reason is kept');
  PERFORM pg_temp.assert_eq(app.system_sso_domain_check(d, true, NULL, ann), 'verified', 'the record is found');
  PERFORM pg_temp.assert_true((SELECT verified_at IS NOT NULL AND verified_by = ann AND check_error IS NULL FROM public.organisation_sso_domains WHERE id = d),
    'verified by the person who asked');

  -- Another organisation may claim it, but not verify it while Acme holds it.
  PERFORM pg_temp.login(bob);
  r := pg_temp.fails(format($f$SELECT app.add_sso_domain(%L, 'acme.test')$f$, rival));
  PERFORM pg_temp.assert_true(r LIKE 'QM030%already used for single sign-on by another organisation%', 'a domain verified elsewhere is refused at once');
  rd := app.add_sso_domain(rival, 'rival.test');
  PERFORM pg_temp.logout();
  -- A claim made before Acme verified (seeded directly): its check is refused, and the index holds even without the function.
  INSERT INTO public.organisation_sso_domains (organisation_id, domain) VALUES (rival, 'acme.test') RETURNING id INTO rd;
  PERFORM pg_temp.assert_eq(app.system_sso_domain_check(rd, true, NULL, bob), 'refused', 'the second organisation cannot verify it');
  PERFORM pg_temp.assert_true((SELECT verified_at IS NULL AND check_error LIKE '%another organisation%' FROM public.organisation_sso_domains WHERE id = rd), 'with the reason');
  r := pg_temp.fails(format($f$UPDATE public.organisation_sso_domains SET verified_at = now() WHERE id = %L$f$, rd));
  PERFORM pg_temp.assert_true(r LIKE '23505%', 'one verified claim of a domain across Fortress (unique index)');

  -- The record disappears: flagged, kept verified; it comes back: flag cleared.
  PERFORM pg_temp.assert_eq(app.system_sso_domain_check(d, false, 'DNS answered NXDOMAIN', NULL), 'failed', 'a verified domain is flagged');
  PERFORM pg_temp.assert_true((SELECT verified_at IS NOT NULL AND check_failed_at IS NOT NULL AND check_error = 'DNS answered NXDOMAIN'
                                 FROM public.organisation_sso_domains WHERE id = d), 'still verified, with the error');
  PERFORM pg_temp.assert_eq(app.system_sso_domain_check(d, true, NULL, NULL), 'verified', 'found again');
  PERFORM pg_temp.assert_true((SELECT check_failed_at IS NULL AND verified_by = ann FROM public.organisation_sso_domains WHERE id = d), 'flag cleared, verifier kept');

  -- Weekly re-check list: only verified domains not checked for a week.
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.system_sso_domains_due(50) x WHERE x.id = d), 0::bigint, 'just checked: not due');
  ALTER TABLE public.organisation_sso_domains DISABLE TRIGGER organisation_sso_domains_touch;
  UPDATE public.organisation_sso_domains SET last_checked_at = now() - interval '8 days' WHERE id = d;
  ALTER TABLE public.organisation_sso_domains ENABLE TRIGGER organisation_sso_domains_touch;
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.system_sso_domains_due(50) x WHERE x.id = d), 1::bigint, 'a week old: due');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.system_sso_domains_due(50) x WHERE x.id = d2), 0::bigint, 'unverified ones are not re-checked');

  -- ---- reading: security.read only, own organisation only ----
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq(pg_temp.count_rows(format('SELECT 1 FROM public.organisation_sso_domains WHERE organisation_id = %L', org)), 0::bigint, 'another organisation sees nothing');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq(pg_temp.count_rows('SELECT 1 FROM public.organisation_sso_domains'), 2::bigint, 'the owner sees their two');

  -- ---- removing: a reason, kept, never deleted ----
  r := pg_temp.fails(format($f$SELECT app.remove_sso_domain(%L, '')$f$, d2));
  PERFORM pg_temp.assert_true(r LIKE 'QM030%Say why%', 'a reason is needed');
  PERFORM app.remove_sso_domain(d, 'Moving to a new provider');
  PERFORM pg_temp.assert_true((SELECT removed_at IS NOT NULL AND verified_at IS NULL AND removed_reason = 'Moving to a new provider'
                                 FROM public.organisation_sso_domains WHERE id = d), 'removed and no longer verified');
  r := pg_temp.fails(format($f$SELECT app.remove_sso_domain(%L, 'again')$f$, d));
  PERFORM pg_temp.assert_true(r LIKE 'QM030%already removed%', 'removing twice is refused');
  PERFORM pg_temp.logout();
  r := pg_temp.fails(format($f$DELETE FROM public.organisation_sso_domains WHERE id = %L$f$, d));
  PERFORM pg_temp.assert_true(r LIKE 'QM030%never deleted%', 'never deleted, even by SQL');
  r := pg_temp.fails(format($f$UPDATE public.organisation_sso_domains SET domain = 'other.test' WHERE id = %L$f$, d2));
  PERFORM pg_temp.assert_true(r LIKE 'QM030%never change%', 'the domain itself never changes');
  -- A removed domain frees it: the rival's earlier claim can now be verified.
  PERFORM pg_temp.assert_eq(app.system_sso_domain_check(rd, true, NULL, bob), 'verified', 'once Acme removed it, the rival can verify');
  -- Acme may claim it again, as a new row.
  PERFORM pg_temp.login(ann);
  r := pg_temp.fails(format($f$SELECT app.add_sso_domain(%L, 'acme.test')$f$, org));
  PERFORM pg_temp.assert_true(r LIKE 'QM030%another organisation%', 'and Acme cannot take it back while the rival holds it');
  PERFORM pg_temp.logout();

  -- ---- audited ----
  SELECT count(*) INTO n FROM audit.events WHERE entity_type = 'organisation_sso_domains' AND entity_id = d::text;
  PERFORM pg_temp.assert_true(n >= 3, 'adding, checking and removing are in the audit trail');
END $$;

ROLLBACK;
