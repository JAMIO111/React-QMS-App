-- Security SE6 (docs/security-plan.md, S11): allowed email domains for invitations (every way of inviting, sub-domains, members outside listed not
-- removed) and the maximum session age setting (owners and admins only; the guard reads it for members only).
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

CREATE FUNCTION pg_temp.assert_true(p boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p IS NOT TRUE THEN RAISE EXCEPTION 'FAILED: %', label; END IF; END $$;
CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

INSERT INTO auth.users (id, email) VALUES
  ('5e000000-0000-0000-0000-000000000a01', 'ann@acme.test'), ('5e000000-0000-0000-0000-000000000a02', 'qm@acme.test'),
  ('5e000000-0000-0000-0000-000000000a03', 'temp@gmail.test'), ('5e000000-0000-0000-0000-000000000a04', 'eve@other.test');

DO $$
DECLARE
  ann uuid := '5e000000-0000-0000-0000-000000000a01'; qm uuid := '5e000000-0000-0000-0000-000000000a02';
  temp uuid := '5e000000-0000-0000-0000-000000000a03'; eve uuid := '5e000000-0000-0000-0000-000000000a04';
  org uuid; r text; d text[]; removed uuid;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('SE6 Acme'); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, qm, 'active'), (org, temp, 'active');
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = 'quality_manager')
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id IN (qm, temp);

  -- ---- only owners and admins set the rules ----
  PERFORM pg_temp.login(qm);
  r := pg_temp.fails(format($f$SELECT app.set_allowed_email_domains(%L, ARRAY['acme.test'])$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a quality manager cannot set the email domains');
  r := pg_temp.fails(format($f$SELECT app.set_max_session_hours(%L, 8)$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'nor the session age');
  r := pg_temp.fails(format($f$UPDATE public.organisation_settings SET max_session_hours = 1 WHERE organisation_id = %L$f$, org));
  PERFORM pg_temp.assert_true(r LIKE '42501%' OR r = 'ok', 'no direct update grant');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT max_session_hours FROM public.organisation_settings WHERE organisation_id = org), NULL::integer, 'nothing changed directly');

  -- ---- email domains: normalised, refused when not a domain ----
  PERFORM pg_temp.login(ann);
  d := app.set_allowed_email_domains(org, ARRAY[' @Acme.test ', 'acme.test', 'acme-group.test']);
  PERFORM pg_temp.assert_eq(d, ARRAY['acme.test', 'acme-group.test'], 'lower case, no @, no duplicates');
  r := pg_temp.fails(format($f$SELECT app.set_allowed_email_domains(%L, ARRAY['not a domain'])$f$, org));
  PERFORM pg_temp.assert_true(r LIKE 'QM029%is not an email domain%', 'a typo is refused with the reason');
  r := pg_temp.fails(format($f$SELECT app.set_allowed_email_domains(%L, ARRAY['localhost'])$f$, org));
  PERFORM pg_temp.assert_true(r LIKE 'QM029%', 'a bare host name is not a domain');

  -- ---- invitations obey them ----
  PERFORM pg_temp.assert_ok(format($q$INSERT INTO public.organisation_users (organisation_id, invited_email, status, invited_at) VALUES (%L, 'new@acme.test', 'invited', now())$q$, org), 'an address at an allowed domain is invited');
  PERFORM pg_temp.assert_ok(format($q$INSERT INTO public.organisation_users (organisation_id, invited_email, status, invited_at) VALUES (%L, 'site@uk.acme.test', 'invited', now())$q$, org), 'a sub-domain is allowed too');
  r := pg_temp.fails(format($q$INSERT INTO public.organisation_users (organisation_id, invited_email, status, invited_at) VALUES (%L, 'friend@gmail.test', 'invited', now())$q$, org));
  PERFORM pg_temp.assert_true(r LIKE 'QM015%only invites addresses at acme.test, acme-group.test%', 'another domain is refused, naming the allowed ones');
  r := pg_temp.fails(format($q$INSERT INTO public.organisation_users (organisation_id, invited_email, status, invited_at) VALUES (%L, 'x@notacme.test', 'invited', now())$q$, org));
  PERFORM pg_temp.assert_true(r LIKE 'QM015%', 'a domain that only ends with the same letters is not a sub-domain');
  PERFORM pg_temp.logout();

  -- ---- a removed member outside the domains cannot be invited again ----
  INSERT INTO public.organisation_users (organisation_id, invited_email, status) VALUES (org, 'old@gmail.test', 'removed') RETURNING id INTO removed;
  r := pg_temp.fails(format($q$UPDATE public.organisation_users SET status = 'invited', invited_at = now() WHERE id = %L$q$, removed));
  PERFORM pg_temp.assert_true(r LIKE 'QM015%', 'inviting again is checked too');

  -- ---- members already outside are listed, never removed ----
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq((SELECT array_agg(email ORDER BY email) FROM app.members_outside_email_domains(org)), ARRAY['temp@gmail.test'], 'the member outside is listed');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT status FROM public.organisation_users WHERE organisation_id = org AND user_id = temp), 'active', 'and stays a member');
  PERFORM pg_temp.login(qm);
  r := pg_temp.fails(format($f$SELECT * FROM app.members_outside_email_domains(%L)$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'the list is for security.read');

  -- ---- an empty list allows anyone again ----
  PERFORM pg_temp.login(ann);
  PERFORM app.set_allowed_email_domains(org, '{}');
  PERFORM pg_temp.assert_ok(format($q$INSERT INTO public.organisation_users (organisation_id, invited_email, status, invited_at) VALUES (%L, 'friend@gmail.test', 'invited', now())$q$, org), 'no domains = anyone');

  -- ---- session age ----
  PERFORM pg_temp.assert_eq(app.set_max_session_hours(org, 12), 12, 'set to 12 hours');
  r := pg_temp.fails(format($f$SELECT app.set_max_session_hours(%L, 0)$f$, org));
  PERFORM pg_temp.assert_true(r LIKE 'QM029%', 'at least an hour');
  r := pg_temp.fails(format($f$SELECT app.set_max_session_hours(%L, 721)$f$, org));
  PERFORM pg_temp.assert_true(r LIKE 'QM029%', 'at most 30 days');
  PERFORM pg_temp.assert_eq(app.max_session_hours(org), 12, 'the guard reads it for a member');
  PERFORM pg_temp.login(eve);
  PERFORM pg_temp.assert_eq(app.max_session_hours(org), NULL::integer, 'and nothing for someone outside the organisation');
  PERFORM pg_temp.login(ann);
  PERFORM app.set_max_session_hours(org, NULL);
  PERFORM pg_temp.assert_eq(app.max_session_hours(org), NULL::integer, 'no limit');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_true(EXISTS (SELECT 1 FROM audit.events WHERE entity_type = 'organisation_settings' AND entity_id = org::text
                                       AND changed_fields @> ARRAY['max_session_hours']), 'changes are audited');
END $$;

ROLLBACK;
