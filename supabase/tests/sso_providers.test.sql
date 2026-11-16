-- Single sign-on SS2 (docs/sso-plan.md): the provider record (API login only, one active per organisation, disabled kept, never deleted),
-- names from a company sign-in, and accepting the terms afterwards.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

CREATE FUNCTION pg_temp.assert_true(p boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p IS NOT TRUE THEN RAISE EXCEPTION 'FAILED: %', label; END IF; END $$;
CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

INSERT INTO auth.users (id, email) VALUES
  ('5f100000-0000-0000-0000-000000000a01', 'ann@acme.test'), ('5f100000-0000-0000-0000-000000000b01', 'bob@rival.test');

DO $$
DECLARE
  ann uuid := '5f100000-0000-0000-0000-000000000a01'; bob uuid := '5f100000-0000-0000-0000-000000000b01';
  org uuid; rival uuid; p uuid; p2 uuid; r text; d uuid; sso_user uuid := gen_random_uuid(); n int;
  sp uuid := '5f1000aa-0000-0000-0000-000000000001'; sp2 uuid := '5f1000aa-0000-0000-0000-000000000002';
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('SS2 Acme'); d := app.add_sso_domain(org, 'acme.test'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(bob); rival := app.create_organisation('SS2 Rival'); PERFORM pg_temp.logout();
  PERFORM app.system_sso_domain_check(d, true, NULL, ann);
  PERFORM pg_temp.assert_eq(app.sso_verified_domains(org), ARRAY['acme.test'], 'verified domains listed');

  -- ---- people cannot write the provider or call the system functions ----
  PERFORM pg_temp.login(ann);
  r := pg_temp.fails(format($f$SELECT app.system_sso_save_provider(%L, %L, %L, 'https://idp/x', 'https://idp/metadata', NULL, ARRAY['acme.test'])$f$, org, ann, sp));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a person cannot record a provider');
  r := pg_temp.fails(format($f$INSERT INTO public.organisation_sso_providers (organisation_id, supabase_provider_id, metadata_url) VALUES (%L, %L, 'https://x')$f$, org, sp));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'no direct insert');
  PERFORM pg_temp.logout();

  -- ---- recording a provider (the API login) ----
  p := app.system_sso_save_provider(org, ann, sp, 'https://idp.acme.test/entity', 'https://idp.acme.test/metadata', NULL, ARRAY['acme.test']);
  PERFORM pg_temp.assert_true((SELECT status = 'active' AND created_by = ann AND domains = ARRAY['acme.test'] AND last_synced_at IS NOT NULL
                                 FROM public.organisation_sso_providers WHERE id = p), 'recorded active with its domains');
  PERFORM pg_temp.assert_eq(app.system_sso_save_provider(org, ann, sp, 'https://idp.acme.test/entity', NULL, repeat('a', 64), ARRAY['acme.test']), p,
    'new metadata for the same provider updates the same row');
  PERFORM pg_temp.assert_true((SELECT metadata_url IS NULL AND metadata_sha256 = repeat('a', 64) FROM public.organisation_sso_providers WHERE id = p), 'now XML');
  r := pg_temp.fails(format($f$SELECT app.system_sso_save_provider(%L, %L, %L, 'e', 'https://idp/m', NULL, '{}')$f$, org, ann, sp2));
  PERFORM pg_temp.assert_true(r LIKE 'QM030%already has a single sign-on provider%', 'one active provider per organisation');
  r := pg_temp.fails(format($f$SELECT app.system_sso_save_provider(%L, %L, %L, 'e', 'http://idp/m', NULL, '{}')$f$, rival, bob, sp2));
  PERFORM pg_temp.assert_eq(left(r, 5), '23514', 'only an https metadata address');
  r := pg_temp.fails(format($f$SELECT app.system_sso_save_provider(%L, %L, %L, 'e', 'https://idp/m', NULL, '{}')$f$, rival, bob, sp));
  PERFORM pg_temp.assert_eq(left(r, 5), '23505', 'a Supabase provider belongs to one organisation');

  PERFORM pg_temp.assert_true((SELECT provider_id = p AND verified = ARRAY['acme.test'] FROM app.system_sso_provider_state(org)), 'state for the API');
  PERFORM pg_temp.assert_true((SELECT provider_id IS NULL AND verified = '{}' FROM app.system_sso_provider_state(rival)), 'no provider: one empty row');
  -- ---- syncing domains ----
  PERFORM app.system_sso_provider_synced(p, ARRAY['acme.test', 'uk.acme.test'], NULL);
  PERFORM pg_temp.assert_eq((SELECT domains FROM public.organisation_sso_providers WHERE id = p), ARRAY['acme.test', 'uk.acme.test'], 'domains synced');
  PERFORM app.system_sso_provider_synced(p, ARRAY['x.test'], 'Supabase answered 500');
  PERFORM pg_temp.assert_true((SELECT domains = ARRAY['acme.test', 'uk.acme.test'] AND last_error = 'Supabase answered 500'
                                 FROM public.organisation_sso_providers WHERE id = p), 'a failed sync keeps the last good domains and the error');

  -- ---- reading: security.read, own organisation only ----
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq(pg_temp.count_rows(format('SELECT 1 FROM public.organisation_sso_providers WHERE organisation_id = %L', org)), 0::bigint, 'another organisation sees nothing');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq(pg_temp.count_rows('SELECT 1 FROM public.organisation_sso_providers'), 1::bigint, 'the owner sees theirs');
  PERFORM pg_temp.logout();

  -- ---- disabling: a reason, kept, never deleted or changed again; a new one may then be added ----
  r := pg_temp.fails(format($f$SELECT app.system_sso_disable_provider(%L, %L, 'x')$f$, p, ann));
  PERFORM pg_temp.assert_true(r LIKE 'QM030%Say why%', 'a reason is needed');
  PERFORM app.system_sso_disable_provider(p, ann, 'Moving to a new identity provider');
  PERFORM pg_temp.assert_true((SELECT status = 'disabled' AND disabled_by = ann FROM public.organisation_sso_providers WHERE id = p), 'disabled with who');
  r := pg_temp.fails(format($f$UPDATE public.organisation_sso_providers SET entity_id = 'z' WHERE id = %L$f$, p));
  PERFORM pg_temp.assert_true(r LIKE 'QM030%kept as it was%', 'a disabled provider never changes');
  r := pg_temp.fails(format($f$DELETE FROM public.organisation_sso_providers WHERE id = %L$f$, p));
  PERFORM pg_temp.assert_true(r LIKE 'QM030%never deleted%', 'never deleted');
  p2 := app.system_sso_save_provider(org, ann, sp2, 'https://idp2/entity', 'https://idp2/metadata', NULL, ARRAY['acme.test']);
  PERFORM pg_temp.assert_true(p2 <> p, 'a new provider after disabling the old one');
  SELECT count(*) INTO n FROM audit.events WHERE entity_type = 'organisation_sso_providers';
  PERFORM pg_temp.assert_true(n >= 4, 'audited');

  -- ---- names from a company sign-in ----
  INSERT INTO auth.users (id, email, raw_user_meta_data)
  VALUES (sso_user, 'ada@acme.test', '{"given_name": "Ada", "family_name": "Lovelace", "iss": "https://idp", "custom_claims": {}}');
  PERFORM pg_temp.assert_true((SELECT first_name = 'Ada' AND surname = 'Lovelace' AND terms_accepted_at IS NULL FROM public.profiles WHERE id = sso_user),
    'given and family names, and no terms accepted');
  INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ('5f100000-0000-0000-0000-000000000c01', 'grace@acme.test', '{"name": "Grace Brewster Hopper"}');
  PERFORM pg_temp.assert_true((SELECT first_name = 'Grace' AND surname = 'Brewster Hopper' FROM public.profiles WHERE id = '5f100000-0000-0000-0000-000000000c01'),
    'a full name is split at the first space');
  INSERT INTO auth.users (id, email, raw_user_meta_data)
  VALUES ('5f100000-0000-0000-0000-000000000c02', 'sign@up.test', '{"first_name": "Sam", "surname": "Signup", "given_name": "X", "terms_version": "2026-11"}');
  PERFORM pg_temp.assert_true((SELECT first_name = 'Sam' AND surname = 'Signup' AND terms_version = '2026-11' AND terms_accepted_at IS NOT NULL
                                 FROM public.profiles WHERE id = '5f100000-0000-0000-0000-000000000c02'), 'our own sign-up form still wins');

  -- ---- accepting the terms ----
  PERFORM pg_temp.login(sso_user);
  PERFORM pg_temp.assert_true(app.accept_terms('2026-11') IS NOT NULL, 'accepted');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_true((SELECT terms_version = '2026-11' AND terms_accepted_at IS NOT NULL FROM public.profiles WHERE id = sso_user), 'recorded on their profile');
  PERFORM pg_temp.login(sso_user);
  r := pg_temp.fails($f$SELECT app.accept_terms('not valid!')$f$);
  PERFORM pg_temp.assert_true(r LIKE 'QM030%', 'a nonsense version is refused');
  r := pg_temp.fails(format($f$UPDATE public.profiles SET terms_version = 'x' WHERE id = %L$f$, sso_user));
  PERFORM pg_temp.assert_true(r LIKE '42501%' OR r = 'ok', 'no direct write of the terms');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT terms_version FROM public.profiles WHERE id = sso_user), '2026-11', 'unchanged');
  PERFORM pg_temp.login_anon();
  r := pg_temp.fails($f$SELECT app.accept_terms('2026-11')$f$);
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'not without signing in');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
