-- Security SE5 (docs/security-plan.md, S6): every change of the network policy is written down and told to owners and admins (with no actor, so the
-- person who enforced is told too, and in full even while enforced); a platform operator with an MFA session can put an enforced policy back to
-- monitor (never off), with a reason and how ownership was verified; nobody else can; the history is never changed.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

CREATE FUNCTION pg_temp.login_aal(p_user uuid, p_aal text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
  PERFORM set_config('role', 'authenticated', true);
END $$;
CREATE FUNCTION pg_temp.assert_true(p boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p IS NOT TRUE THEN RAISE EXCEPTION 'FAILED: %', label; END IF; END $$;
CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

INSERT INTO auth.users (id, email) VALUES
  ('5d000000-0000-0000-0000-000000000f01', 'ann@se5.test'), ('5d000000-0000-0000-0000-000000000f02', 'ali@se5.test'),
  ('5d000000-0000-0000-0000-000000000f03', 'ivy@se5.test'), ('5d000000-0000-0000-0000-000000000f04', 'op@se5.test');

DO $$
DECLARE
  ann uuid := '5d000000-0000-0000-0000-000000000f01'; ali uuid := '5d000000-0000-0000-0000-000000000f02';
  ivy uuid := '5d000000-0000-0000-0000-000000000f03'; op uuid := '5d000000-0000-0000-0000-000000000f04';
  org uuid; r text; rec uuid; c public.network_policy_changes%ROWTYPE; n public.notifications%ROWTYPE; t_id uuid;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('SE5 Alpha'); PERFORM pg_temp.logout();
  UPDATE public.profiles SET first_name = 'Ann', surname = 'Owner' WHERE id = ann;
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, ali, 'active'), (org, ivy, 'active');
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = CASE ou.user_id WHEN ali THEN 'admin' ELSE 'inspector' END)
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id IN (ali, ivy);
  INSERT INTO public.platform_admins (user_id, note) VALUES (op, 'operator');
  SELECT id INTO t_id FROM public.notification_event_types WHERE key = 'network_policy_changes.created';

  -- ---- enforcing is written down and told to owners and admins, the enforcer included ----
  PERFORM pg_temp.login(ann);
  PERFORM app.save_organisation_network(org, '{"name": "HQ", "network": "203.0.113.0/24"}', '203.0.113.10');
  PERFORM app.set_network_policy(org, 'enforce', '203.0.113.10');
  SELECT * INTO c FROM public.network_policy_changes WHERE organisation_id = org ORDER BY created_at DESC LIMIT 1;
  PERFORM pg_temp.assert_eq(c.kind || ':' || c.from_mode || '>' || c.to_mode, 'change:off>enforce', 'the change is written down');
  PERFORM pg_temp.assert_eq(c.changed_by_name, 'Ann Owner', 'with who made it');
  PERFORM pg_temp.assert_true(c.guidance LIKE 'If everyone is locked out, an owner can ask Fortress support%', 'and what to do if everyone is locked out');
  PERFORM pg_temp.logout();
  SELECT * INTO n FROM public.notifications WHERE event_type_id = t_id AND entity_id = c.id::text;
  PERFORM pg_temp.assert_true(n.id IS NOT NULL AND n.actor_user_id IS NULL, 'a notice with no actor, so the person who enforced is told too');
  PERFORM pg_temp.assert_true(n.body LIKE '%enforced (only approved networks)%If everyone is locked out%', 'saying what changed and what to do');
  PERFORM pg_temp.assert_true((SELECT email_default FROM public.notification_event_types WHERE id = t_id), 'emailed by default');

  PERFORM pg_temp.login(ali);
  PERFORM pg_temp.assert_eq(pg_temp.count_rows(format($q$SELECT 1 FROM public.network_policy_changes WHERE organisation_id = %L$q$, org)), 1::bigint, 'an admin reads the history');
  PERFORM pg_temp.login(ivy);
  PERFORM pg_temp.assert_eq(pg_temp.count_rows(format($q$SELECT 1 FROM public.network_policy_changes WHERE organisation_id = %L$q$, org)), 0::bigint, 'an inspector does not');

  -- ---- nobody but an operator with an MFA session recovers ----
  r := pg_temp.fails(format($f$SELECT app.platform_recover_network_policy(%L, 'Locked out after a line change', 'Called the owner back on file')$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'not a member');
  PERFORM pg_temp.login_aal(ann, 'aal2');
  r := pg_temp.fails(format($f$SELECT app.platform_recover_network_policy(%L, 'Locked out after a line change', 'Called the owner back on file')$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'not the owner either');
  PERFORM pg_temp.login_aal(op, 'aal1');
  r := pg_temp.fails(format($f$SELECT app.platform_recover_network_policy(%L, 'Locked out after a line change', 'Called the owner back on file')$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'nor an operator without MFA');

  -- ---- the operator recovers: back to monitor (never off), reason and verification kept ----
  PERFORM pg_temp.login_aal(op, 'aal2');
  r := pg_temp.fails(format($f$SELECT app.platform_recover_network_policy(%L, 'short', 'Called the owner back on file')$f$, org));
  PERFORM pg_temp.assert_true(r LIKE 'QM029%Say why%', 'a reason is required');
  r := pg_temp.fails(format($f$SELECT app.platform_recover_network_policy(%L, 'Locked out after a line change', 'no')$f$, org));
  PERFORM pg_temp.assert_true(r LIKE 'QM029%how you checked%', 'and how ownership was verified');
  r := pg_temp.fails(format($f$SELECT app.platform_recover_network_policy(%L, 'Locked out after a line change', 'Called the owner back on file')$f$, gen_random_uuid()));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'an unknown organisation');
  PERFORM pg_temp.assert_eq((SELECT network_policy FROM app.platform_network_policies(ARRAY[org])), 'enforce', 'the operator sees the policy');
  rec := app.platform_recover_network_policy(org, 'Locked out after a line change', 'Called the owner back on the number on file');
  r := pg_temp.fails(format($f$SELECT app.platform_recover_network_policy(%L, 'Locked out after a line change', 'Called the owner back on file')$f$, org));
  PERFORM pg_temp.assert_true(r LIKE 'QM029%not enforcing%', 'nothing to recover once it is not enforced');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT network_policy FROM public.organisation_settings WHERE organisation_id = org), 'monitor', 'back to monitor, not off');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.organisation_networks WHERE organisation_id = org AND active), 1::bigint, 'the approved networks are kept');
  SELECT * INTO c FROM public.network_policy_changes WHERE id = rec;
  PERFORM pg_temp.assert_eq(c.kind || ':' || c.from_mode || '>' || c.to_mode, 'recovery:enforce>monitor', 'written down as a recovery');
  PERFORM pg_temp.assert_eq(c.verification, 'Called the owner back on the number on file', 'with how ownership was verified');
  PERFORM pg_temp.assert_eq(c.changed_by, op, 'and the operator who did it');
  PERFORM pg_temp.assert_true(EXISTS (SELECT 1 FROM public.notifications WHERE event_type_id = t_id AND entity_id = rec::text AND actor_user_id IS NULL
                                       AND body LIKE 'Fortress support put network restrictions back to monitor%'), 'owners and admins are told');
  PERFORM pg_temp.assert_true(EXISTS (SELECT 1 FROM audit.events WHERE entity_type = 'organisation_settings' AND entity_id = org::text
                                       AND new_values ->> 'network_policy' = 'monitor' AND actor_user_id = op), 'and the audit trail has the operator');

  -- ---- a monitor-to-off change by a person is a plain change; the history never changes ----
  PERFORM pg_temp.login(ann);
  PERFORM app.set_network_policy(org, 'off', '203.0.113.10');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT kind FROM public.network_policy_changes WHERE organisation_id = org ORDER BY created_at DESC, kind LIMIT 1), 'change', 'the recovery setting does not leak into later changes');
  r := pg_temp.fails(format($f$UPDATE public.network_policy_changes SET summary = 'x' WHERE id = %L$f$, rec));
  PERFORM pg_temp.assert_true(r LIKE 'QM029%', 'the history is never changed, even by SQL');
  r := pg_temp.fails(format($f$DELETE FROM public.network_policy_changes WHERE id = %L$f$, rec));
  PERFORM pg_temp.assert_true(r LIKE 'QM029%', 'nor deleted');
END $$;

-- ---- while enforced, notices about network restrictions are still emailed in full; others are short ----
DO $$
DECLARE org uuid; leased record;
BEGIN
  SELECT id INTO org FROM public.organisations WHERE name = 'SE5 Alpha';
  UPDATE public.organisation_settings SET network_policy = 'enforce' WHERE organisation_id = org;
  INSERT INTO public.email_outbox (organisation_id, notification_id, user_id, to_address)
    SELECT org, n.id, '5d000000-0000-0000-0000-000000000f01', 'ann@se5.test' FROM public.notifications n
     WHERE n.organisation_id = org AND n.entity_type = 'network_policy_changes' ORDER BY n.created_at LIMIT 1;
  SELECT * INTO leased FROM app.system_lease_emails(10, 60) WHERE to_address = 'ann@se5.test';
  PERFORM pg_temp.assert_eq(leased.network_restricted, false, 'the lockout guidance reaches the inbox even while enforced');
  PERFORM pg_temp.assert_eq(leased.event_key, 'network_policy_changes.created', 'it is the network restrictions notice');
END $$;

ROLLBACK;
