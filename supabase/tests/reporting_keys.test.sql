-- Reporting API keys and report views (docs/reporting-api-plan.md RP1): keys made and revoked only through functions by people who manage integrations,
-- only the hash kept, the API login's lookup refusing revoked / expired / departed-person keys, and the report views running with the caller's rights.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('5b000000-0000-0000-0000-000000000001', 'owner@rpt.test'), ('5b000000-0000-0000-0000-000000000002', 'insp@rpt.test'),
  ('5b000000-0000-0000-0000-000000000003', 'other@rpt.test'), ('5b000000-0000-0000-0000-000000000004', 'site@rpt.test');

CREATE FUNCTION pg_temp.assert_true(p boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p IS NOT TRUE THEN RAISE EXCEPTION 'FAILED: %', label; END IF; END $$;
CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;
CREATE FUNCTION pg_temp.h(t text) RETURNS text LANGUAGE sql AS $$ SELECT encode(sha256(convert_to(t, 'UTF8')), 'hex') $$;
CREATE FUNCTION pg_temp.api(stmt text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  PERFORM set_config('role', 'qms_api', true);
  BEGIN EXECUTE stmt INTO r;
  EXCEPTION WHEN OTHERS THEN PERFORM set_config('role', 'postgres', true); RAISE; END;
  PERFORM set_config('role', 'postgres', true);
  RETURN r;
END $$;

DO $$
DECLARE
  own uuid := '5b000000-0000-0000-0000-000000000001'; insp uuid := '5b000000-0000-0000-0000-000000000002';
  other uuid := '5b000000-0000-0000-0000-000000000003'; v_site uuid := '5b000000-0000-0000-0000-000000000004';
  org uuid; org2 uuid; m uuid; site_b uuid; k1 uuid; k2 uuid; r jsonb; t text; ncr1 uuid; ncr2 uuid; i integer;
BEGIN
  PERFORM pg_temp.login(other); org2 := app.create_organisation('RPT Other'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(own); org := app.create_organisation('RPT Works', 'Plant A', 'PA', NULL); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, insp, 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'inspector';
  PERFORM pg_temp.give_controller_seat(org, own);
  PERFORM pg_temp.give_controller_seat(org2, other);

  -- ---- making a key ----
  PERFORM pg_temp.login(insp);
  t := pg_temp.fails(format($f$SELECT app.create_reporting_key(%L, 'Power BI', 365, %L, 'abcd1234')$f$, org, pg_temp.h('key-1')));
  PERFORM pg_temp.assert_eq(left(t, 5), '42501', 'an inspector cannot make a key');
  PERFORM pg_temp.login(own);
  t := pg_temp.fails(format($f$SELECT app.create_reporting_key(%L, '  ', 365, %L, 'abcd1234')$f$, org, pg_temp.h('key-1')));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%name%', 'a key needs a name');
  t := pg_temp.fails(format($f$SELECT app.create_reporting_key(%L, 'Power BI', 0, %L, 'abcd1234')$f$, org, pg_temp.h('key-1')));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%days%', 'a key lasts at least a day');
  t := pg_temp.fails(format($f$SELECT app.create_reporting_key(%L, 'Power BI', 731, %L, 'abcd1234')$f$, org, pg_temp.h('key-1')));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%days%', 'and at most 730 days');
  t := pg_temp.fails(format($f$SELECT app.create_reporting_key(%L, 'Power BI', 30, 'not-a-hash', 'abcd1234')$f$, org));
  PERFORM pg_temp.assert_eq(left(t, 5), '23514', 'only a SHA-256 hash is accepted');
  r := app.create_reporting_key(org, 'Power BI', 30, pg_temp.h('key-1'), 'abcd1234');
  k1 := (r ->> 'id')::uuid;
  PERFORM pg_temp.assert_eq((SELECT key_hash FROM public.reporting_keys WHERE id = k1), pg_temp.h('key-1'), 'only the hash is kept');
  PERFORM pg_temp.assert_eq((SELECT user_id FROM public.reporting_keys WHERE id = k1), own, 'the key stands for the person who made it');
  PERFORM pg_temp.assert_true((SELECT expires_at > now() + interval '29 days' AND expires_at < now() + interval '31 days' FROM public.reporting_keys WHERE id = k1), 'it expires when asked');
  t := pg_temp.fails(format($f$SELECT app.create_reporting_key(%L, 'Again', 30, %L, 'abcd1234')$f$, org, pg_temp.h('key-1')));
  PERFORM pg_temp.assert_eq(left(t, 5), '23505', 'the same key cannot be stored twice');
  t := pg_temp.fails(format($f$INSERT INTO public.reporting_keys (organisation_id, user_id, name, key_prefix, key_hash, expires_at) VALUES (%L, %L, 'Sneaky', 'abcd1234', %L, now() + interval '1 day')$f$,
                            org, own, pg_temp.h('sneaky')));
  PERFORM pg_temp.assert_eq(left(t, 5), '42501', 'nobody inserts a key directly');
  t := pg_temp.fails(format($f$UPDATE public.reporting_keys SET expires_at = now() + interval '5 years' WHERE id = %L$f$, k1));
  PERFORM pg_temp.assert_eq(left(t, 5), '42501', 'nor changes one');
  t := pg_temp.fails(format($f$DELETE FROM public.reporting_keys WHERE id = %L$f$, k1));
  PERFORM pg_temp.assert_eq(left(t, 5), '42501', 'nor deletes one');
  FOR i IN 2..10 LOOP
    PERFORM app.create_reporting_key(org, 'Key ' || i, 30, pg_temp.h('key-' || i), 'abcd1234');
  END LOOP;
  t := pg_temp.fails(format($f$SELECT app.create_reporting_key(%L, 'Eleventh', 30, %L, 'abcd1234')$f$, org, pg_temp.h('key-11')));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%ten%', 'ten keys at a time');
  PERFORM pg_temp.logout();

  -- ---- who sees them ----
  PERFORM pg_temp.login(own);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.reporting_keys WHERE organisation_id = org), 10::bigint, 'the owner sees the organisation''s keys');
  PERFORM pg_temp.login(other);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.reporting_keys WHERE organisation_id = org), 0::bigint, 'another organisation sees none');
  t := pg_temp.fails(format($f$SELECT app.revoke_reporting_key(%L, 'not mine to revoke')$f$, k1));
  PERFORM pg_temp.assert_eq(left(t, 5), 'P0002', 'another organisation cannot revoke it (and learns nothing)');
  PERFORM pg_temp.login(insp);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.reporting_keys WHERE organisation_id = org), 0::bigint, 'an inspector sees none');
  PERFORM pg_temp.logout();

  -- ---- the API login's lookup ----
  PERFORM pg_temp.login(own);
  t := pg_temp.fails(format($f$SELECT app.system_report_key_lookup(%L, '203.0.113.5')$f$, pg_temp.h('key-1')));
  PERFORM pg_temp.assert_eq(left(t, 5), '42501', 'a person cannot use the lookup');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_true(pg_temp.api(format($f$SELECT app.system_report_key_lookup(%L, '203.0.113.5')$f$, pg_temp.h('nope'))) IS NULL, 'an unknown key is nobody');
  r := pg_temp.api(format($f$SELECT app.system_report_key_lookup(%L, '203.0.113.5')$f$, pg_temp.h('key-1')));
  PERFORM pg_temp.assert_eq((r ->> 'organisationId')::uuid, org, 'a good key names its organisation');
  PERFORM pg_temp.assert_eq((r ->> 'userId')::uuid, own, 'and its person');
  PERFORM pg_temp.assert_eq(r ->> 'email', 'owner@rpt.test', 'and their address');
  PERFORM pg_temp.assert_eq((SELECT last_used_address FROM public.reporting_keys WHERE id = k1), '203.0.113.5', 'its use is recorded');
  UPDATE public.reporting_keys SET expires_at = now() - interval '1 minute' WHERE id = k1;
  PERFORM pg_temp.assert_true(pg_temp.api(format($f$SELECT app.system_report_key_lookup(%L, NULL)$f$, pg_temp.h('key-1'))) IS NULL, 'an expired key is nobody');
  UPDATE public.reporting_keys SET expires_at = now() + interval '1 day' WHERE id = k1;

  -- a key stops with its person: a second administrator makes one, then is suspended
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, v_site, 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'admin';
  PERFORM pg_temp.give_controller_seat(org, v_site);
  PERFORM pg_temp.login(v_site);
  PERFORM app.revoke_reporting_key(k1, 'rotating the first key');  -- frees a slot for the next one
  r := app.create_reporting_key(org, 'Site admin key', 30, pg_temp.h('key-site'), 'wxyz9876');
  k2 := (r ->> 'id')::uuid;
  PERFORM pg_temp.logout();
  r := pg_temp.api(format($f$SELECT app.system_report_key_lookup(%L, NULL)$f$, pg_temp.h('key-site')));
  PERFORM pg_temp.assert_eq((r ->> 'userId')::uuid, v_site, 'a second administrator''s key stands for them');
  UPDATE public.organisation_users SET status = 'suspended' WHERE organisation_id = org AND user_id = v_site;
  PERFORM pg_temp.assert_true(pg_temp.api(format($f$SELECT app.system_report_key_lookup(%L, NULL)$f$, pg_temp.h('key-site'))) IS NULL, 'a suspended person''s key is nobody');
  UPDATE public.organisation_users SET status = 'active' WHERE organisation_id = org AND user_id = v_site;
  PERFORM pg_temp.assert_true(pg_temp.api(format($f$SELECT app.system_report_key_lookup(%L, NULL)$f$, pg_temp.h('key-site'))) IS NOT NULL, 'and works again when they are reinstated');

  -- ---- revoking ----
  PERFORM pg_temp.assert_true(pg_temp.api(format($f$SELECT app.system_report_key_lookup(%L, NULL)$f$, pg_temp.h('key-1'))) IS NULL, 'a revoked key is nobody');
  PERFORM pg_temp.login(insp);
  t := pg_temp.fails(format($f$SELECT app.revoke_reporting_key(%L, 'I should not be able to')$f$, k2));
  PERFORM pg_temp.assert_eq(left(t, 5), 'P0002', 'an inspector cannot even see a key to revoke');
  PERFORM pg_temp.login(own);
  t := pg_temp.fails(format($f$SELECT app.revoke_reporting_key(%L, 'x')$f$, k2));
  PERFORM pg_temp.assert_true(t LIKE 'QM022%why%', 'a reason is needed');
  PERFORM app.revoke_reporting_key(k2, 'The administrator left the project');
  PERFORM app.revoke_reporting_key(k2, 'again');  -- already revoked: nothing happens
  PERFORM pg_temp.assert_eq((SELECT revoked_reason FROM public.reporting_keys WHERE id = k2), 'The administrator left the project', 'the reason is kept, the first one');
  PERFORM pg_temp.assert_eq((SELECT revoked_by FROM public.reporting_keys WHERE id = k2), own, 'with who did it');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_true(pg_temp.api(format($f$SELECT app.system_report_key_lookup(%L, NULL)$f$, pg_temp.h('key-site'))) IS NULL, 'a key revoked by the owner is nobody');
  PERFORM pg_temp.assert_true(
    (SELECT count(*) FROM audit.events WHERE organisation_id = org AND entity_type = 'reporting_keys') >= 11, 'making and revoking keys is audited');

  -- ---- the views run with the caller's rights ----
  PERFORM pg_temp.login(own);
  INSERT INTO public.nonconformances (organisation_id, source, title, severity, quantity_affected, description, stage, category_id)
    VALUES (org, 'internal', 'Burrs on brackets', 'major', 10, 'x', 'open', pg_temp.cat(org)) RETURNING id INTO ncr1;
  INSERT INTO public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, amount) VALUES (org, ncr1, 'scrap', 'GBP', 100);
  INSERT INTO public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, amount) VALUES (org, ncr1, 'supplier_recovery', 'GBP', 30);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.report_non_conformances WHERE reference IS NOT NULL), 1::bigint, 'the owner sees the non-conformance');
  PERFORM pg_temp.assert_eq((SELECT total_cost || '|' || cost_lines || '|' || cost_currency FROM public.report_non_conformances WHERE id = ncr1), '70.00|2|GBP',
                            'its total is the signed sum (a recovery is a credit)');
  PERFORM pg_temp.assert_eq((SELECT sum(net_organisation_currency) FROM public.report_non_conformance_costs WHERE non_conformance_id = ncr1), 70.00, 'the cost lines add up the same way');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.report_non_conformance_costs WHERE non_conformance_reference = (SELECT reference FROM public.nonconformances WHERE id = ncr1)), 2::bigint, 'one row per line');
  PERFORM pg_temp.assert_true((SELECT count(*) FROM public.report_suppliers) >= 0 AND (SELECT count(*) FROM public.report_scars) >= 0
                              AND (SELECT count(*) FROM public.report_receipt_lines) >= 0 AND (SELECT count(*) FROM public.report_supplier_scorecards) >= 0, 'the supplier views can be read');
  PERFORM pg_temp.login(other);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.report_non_conformances), 0::bigint, 'another organisation sees none of it');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.report_non_conformance_costs), 0::bigint, 'nor its costs');
  PERFORM pg_temp.login_anon();
  t := pg_temp.fails('SELECT count(*) FROM public.report_non_conformances');
  PERFORM pg_temp.assert_eq(left(t, 5), '42501', 'an anonymous caller cannot read a report view');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_true((SELECT reloptions @> ARRAY['security_invoker=true'] FROM pg_class WHERE oid = 'public.report_non_conformances'::regclass), 'the views run as their caller');
END $$;

ROLLBACK;
