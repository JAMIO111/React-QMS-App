-- Security SE1 (docs/security-plan.md): network allowlisting — permissions, reading and normalising networks, refused ranges, modes, matching
-- (IPv4, IPv6, IPv4-mapped, CIDR edges), lockout prevention, removal, blocked attempts, tenancy.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('5b000000-0000-0000-0000-000000000d01', 'ann@se1.test'), ('5b000000-0000-0000-0000-000000000d02', 'qm@se1.test'),
  ('5b000000-0000-0000-0000-000000000d03', 'eve@se1.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '5b000000-0000-0000-0000-000000000d01'; qm uuid := '5b000000-0000-0000-0000-000000000d02'; eve uuid := '5b000000-0000-0000-0000-000000000d03';
  org uuid; org2 uuid; hq uuid; vpn uuid; f2 uuid; r text;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('SE1 Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('SE1 Beta'); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, qm, 'active');
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = 'quality_manager')
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id = qm;

  -- ---- permissions: owner and admin only ----
  PERFORM pg_temp.login(qm);
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'security.read'), false, 'a quality manager does not see security settings');
  r := pg_temp.fails(format($f$SELECT app.set_network_policy(%L, 'monitor', NULL)$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'nor change them');
  PERFORM pg_temp.assert_eq(app.network_allowed(org, '198.51.100.9'), 'open', 'but the rule is still worked out for members');
  PERFORM pg_temp.logout();

  -- ---- reading networks (internal: as the database owner) ----
  PERFORM pg_temp.assert_eq(app.parse_network(' 203.0.113.10 ')::text, '203.0.113.10/32', 'a single IPv4 address is /32');
  PERFORM pg_temp.assert_eq(app.parse_network('2001:DB8:1234::1')::text, '2001:db8:1234::1/128', 'a single IPv6 address is /128, lower case');
  PERFORM pg_temp.assert_eq(app.parse_network('198.51.100.0/28')::text, '198.51.100.0/28', 'a range');
  PERFORM pg_temp.assert_eq(app.parse_network('2001:db8:1234::/48')::text, '2001:db8:1234::/48', 'an IPv6 range');
  PERFORM pg_temp.assert_eq(app.parse_network('::ffff:203.0.113.10')::text, '203.0.113.10/32', 'an IPv4 address written as IPv6 is IPv4');
  r := pg_temp.fails($f$SELECT app.parse_network('198.51.100.5/28')$f$);
  PERFORM pg_temp.assert_eq(r LIKE 'QM029%did you mean 198.51.100.0/28%', true, 'host bits set: says which network was meant');
  r := pg_temp.fails($f$SELECT app.parse_network('203.0.113.300')$f$);
  PERFORM pg_temp.assert_eq(r LIKE 'QM029%is not an IP address or range%', true, 'not an address');
  r := pg_temp.fails($f$SELECT app.parse_network('')$f$);
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM029', 'empty');
  FOREACH r IN ARRAY ARRAY['10.1.2.3', '192.168.1.0/24', '172.16.0.1', '127.0.0.1', '100.64.0.1', '169.254.1.1', 'fd00::1', 'fe80::1', '::1', '224.0.0.1'] LOOP
    PERFORM pg_temp.assert_eq(pg_temp.fails(format('SELECT app.parse_network(%L)', r)) LIKE 'QM029%private or special%', true, 'refused: ' || r);
  END LOOP;
  PERFORM pg_temp.assert_eq(pg_temp.fails($f$SELECT app.parse_network('0.0.0.0/0')$f$) LIKE 'QM029%too wide%', true, '/0 refused');
  PERFORM pg_temp.assert_eq(pg_temp.fails($f$SELECT app.parse_network('8.0.0.0/7')$f$) LIKE 'QM029%too wide%', true, 'wider than /8 refused');
  PERFORM pg_temp.assert_eq(pg_temp.fails($f$SELECT app.parse_network('2000::/15')$f$) LIKE 'QM029%too wide%', true, 'IPv6 wider than /16 refused');
  PERFORM pg_temp.assert_eq(app.parse_network('8.0.0.0/8')::text, '8.0.0.0/8', '/8 allowed');

  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'security.manage'), true, 'the owner manages security');

  -- ---- enforcing needs a network that includes your own address ----
  r := pg_temp.fails(format($f$SELECT app.set_network_policy(%L, 'enforce', '203.0.113.10')$f$, org));
  PERFORM pg_temp.assert_eq(r LIKE 'QM029%at least one approved network%', true, 'no networks: cannot enforce');
  hq := app.save_organisation_network(org, '{"name":" Headquarters ","network":"203.0.113.10"}', '203.0.113.10');
  PERFORM pg_temp.assert_eq((SELECT name || '|' || network::text || '|' || active::text FROM public.organisation_networks WHERE id = hq), 'Headquarters|203.0.113.10/32|true', 'trimmed and normalised');
  r := pg_temp.fails(format($f$SELECT app.save_organisation_network(%L, '{"name":"headquarters","network":"198.51.100.0/28"}', NULL)$f$, org));
  PERFORM pg_temp.assert_eq(r LIKE 'QM029%already a network called%', true, 'names unique ignoring case');
  r := pg_temp.fails(format($f$SELECT app.save_organisation_network(%L, '{"name":"Again","network":"203.0.113.10/32"}', NULL)$f$, org));
  PERFORM pg_temp.assert_eq(r LIKE 'QM029%already approved%', true, 'a range approved once');
  r := pg_temp.fails(format($f$SELECT app.save_organisation_network(%L, '{"name":"X","network":"203.0.113.1","colour":"red"}', NULL)$f$, org));
  PERFORM pg_temp.assert_eq(r LIKE 'QM029%Unknown field%', true, 'unknown fields refused');
  r := pg_temp.fails(format($f$SELECT app.set_network_policy(%L, 'enforce', '198.51.100.9')$f$, org));
  PERFORM pg_temp.assert_eq(r LIKE 'QM029%(198.51.100.9) is not in an approved network%', true, 'your own address must be covered');
  r := pg_temp.fails(format($f$SELECT app.set_network_policy(%L, 'enforce', NULL)$f$, org));
  PERFORM pg_temp.assert_eq(r LIKE 'QM029%(unknown)%', true, 'no address: cannot enforce');
  r := pg_temp.fails(format($f$SELECT app.set_network_policy(%L, 'lock', NULL)$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM029', 'only the three modes');

  -- ---- monitor: nobody blocked ----
  PERFORM app.set_network_policy(org, 'monitor', NULL);
  PERFORM pg_temp.assert_eq(app.network_allowed(org, '203.0.113.10'), 'allowed', 'monitor: an approved address');
  PERFORM pg_temp.assert_eq(app.network_allowed(org, '198.51.100.9'), 'monitored', 'monitor: another address is recorded, not blocked');
  PERFORM pg_temp.assert_eq(app.network_allowed(org, NULL), 'monitored', 'monitor: no address is recorded, not blocked');

  -- ---- enforce ----
  PERFORM app.set_network_policy(org, 'enforce', '203.0.113.10');
  PERFORM pg_temp.assert_eq((SELECT network_policy || '|' || (network_policy_changed_by = ann)::text FROM public.organisation_settings WHERE organisation_id = org),
                            'enforce|true', 'enforced, who and when kept');
  PERFORM pg_temp.assert_eq(app.network_allowed(org, '203.0.113.10'), 'allowed', 'the approved address');
  PERFORM pg_temp.assert_eq(app.network_allowed(org, '203.0.113.11'), 'denied', 'the next address is not');
  PERFORM pg_temp.assert_eq(app.network_allowed(org, NULL), 'denied', 'no address is denied while enforced');
  PERFORM pg_temp.assert_eq(app.network_allowed(org2, '203.0.113.10'), NULL::text, 'another organisation''s policy is not revealed');
  f2 := app.save_organisation_network(org, '{"name":"Factory 2","network":"198.51.100.0/28"}', '203.0.113.10');
  PERFORM pg_temp.assert_eq(app.network_allowed(org, '198.51.100.0') || '|' || app.network_allowed(org, '198.51.100.15') || '|' || app.network_allowed(org, '198.51.100.16'),
                            'allowed|allowed|denied', 'CIDR edges: first and last in, next out');
  vpn := app.save_organisation_network(org, '{"name":"Company VPN","network":"2001:db8:1234::/48"}', '203.0.113.10');
  PERFORM pg_temp.assert_eq(app.network_allowed(org, '2001:db8:1234:ffff::1') || '|' || app.network_allowed(org, '2001:db8:1235::1'),
                            'allowed|denied', 'IPv6 range');
  PERFORM pg_temp.assert_eq(app.network_allowed(org, '::ffff:198.51.100.3'), 'allowed', 'an IPv4-mapped address matches its IPv4 network');

  -- ---- lockout prevention while enforced ----
  r := pg_temp.fails(format($f$SELECT app.save_organisation_network(%L, '{"active":false}', '203.0.113.10', %L)$f$, org, hq));
  PERFORM pg_temp.assert_eq(r LIKE 'QM029%would block your own address (203.0.113.10)%', true, 'cannot switch off your own network');
  r := pg_temp.fails(format($f$SELECT app.save_organisation_network(%L, '{"network":"203.0.113.20"}', '203.0.113.10', %L)$f$, org, hq));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM029', 'nor move it away from you');
  r := pg_temp.fails(format($f$SELECT app.remove_organisation_network(%L, 'Moving office', '203.0.113.10')$f$, hq));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM029', 'nor remove it');
  PERFORM app.save_organisation_network(org, '{"name":"Head office"}', '203.0.113.10', hq);
  PERFORM pg_temp.assert_eq((SELECT name FROM public.organisation_networks WHERE id = hq), 'Head office', 'a rename is fine');
  PERFORM app.save_organisation_network(org, '{"active":false}', '198.51.100.5', hq);
  PERFORM pg_temp.assert_eq(app.network_allowed(org, '203.0.113.10'), 'denied', 'from inside another network, the old one can be switched off');
  PERFORM app.save_organisation_network(org, '{"active":true}', '198.51.100.5', hq);

  -- ---- removal: kept, hidden, back switched off ----
  r := pg_temp.fails(format($f$SELECT app.remove_organisation_network(%L, 'x', '203.0.113.10')$f$, vpn));
  PERFORM pg_temp.assert_eq(r LIKE 'QM029%Say why%', true, 'a reason is needed');
  PERFORM app.remove_organisation_network(vpn, 'VPN replaced', '203.0.113.10');
  PERFORM pg_temp.assert_eq((SELECT active::text || '|' || removed_reason FROM public.organisation_networks WHERE id = vpn), 'false|VPN replaced', 'removed with the reason');
  PERFORM pg_temp.assert_eq(app.network_allowed(org, '2001:db8:1234::1'), 'denied', 'a removed network allows nothing');
  r := pg_temp.fails(format($f$SELECT app.save_organisation_network(%L, '{"name":"VPN 2"}', '203.0.113.10', %L)$f$, org, vpn));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM029', 'a removed network is not edited');
  PERFORM app.restore_organisation_network(vpn);
  PERFORM pg_temp.assert_eq((SELECT active::text || '|' || (removed_at IS NULL)::text FROM public.organisation_networks WHERE id = vpn), 'false|true', 'back, switched off');
  r := pg_temp.fails(format('DELETE FROM public.organisation_networks WHERE id = %L', vpn));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'no deletes by people');
  r := pg_temp.fails(format($f$UPDATE public.organisation_settings SET network_policy = 'off' WHERE organisation_id = %L$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'the policy is not changed by a table write');
  r := pg_temp.fails(format($f$INSERT INTO public.organisation_networks (organisation_id, name, network) VALUES (%L, 'Sneaky', '8.8.8.0/24')$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'nor networks');

  -- ---- switching off is always allowed ----
  PERFORM app.set_network_policy(org, 'off', '8.8.8.8');
  PERFORM pg_temp.assert_eq(app.network_allowed(org, '8.8.8.8'), 'open', 'off: every address');
  PERFORM pg_temp.logout();

  -- ---- blocked attempts: written by the API login, counted per hour ----
  r := pg_temp.fails(format($f$SELECT app.system_record_access_denial(%L, %L, '8.8.8.8', 'enforce', '/x')$f$, org, ann));
  PERFORM pg_temp.assert_eq(r, 'ok', 'the test runs as the owner of the database here');
  PERFORM app.system_record_access_denial(org, ann, '8.8.8.8', 'enforce', '/api/v1/ncrs?q=secret');
  PERFORM app.system_record_access_denial(org, ann, 'not an address', 'monitor', NULL);
  PERFORM pg_temp.assert_eq((SELECT attempts || '|' || last_path FROM public.access_denials WHERE organisation_id = org AND address = '8.8.8.8'), '2|/api/v1/ncrs',
                            'counted, the query string dropped');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.access_denials WHERE organisation_id = org AND address = 'unknown' AND mode = 'monitor'), 1::bigint, 'an unreadable address is unknown');
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.access_denials WHERE organisation_id = org), 2::bigint, 'the owner reads them');
  r := pg_temp.fails(format($f$SELECT app.system_record_access_denial(%L, %L, '1.1.1.1', 'enforce', '/x')$f$, org, ann));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'people cannot write them');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(qm);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.access_denials WHERE organisation_id = org) + (SELECT count(*) FROM public.organisation_networks WHERE organisation_id = org),
                            0::bigint, 'a quality manager reads neither');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.organisation_networks WHERE organisation_id = org), 0::bigint, 'another organisation reads nothing');
  r := pg_temp.fails(format($f$SELECT app.remove_organisation_network(%L, 'Not mine', NULL)$f$, hq));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'and cannot touch it');
  PERFORM pg_temp.logout();
  UPDATE public.access_denials SET last_at = now() - interval '91 days' WHERE organisation_id = org AND address = 'unknown';
  PERFORM pg_temp.assert_eq(app.system_purge_access_denials(), 1, 'cleared after 90 days');
END $$;

ROLLBACK;
