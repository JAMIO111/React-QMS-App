-- Quality audit trail (Phase 1 slice 1.2): events are written for quality-critical and access
-- changes, carry actor/source/reason/correlation id, cannot be altered, and are only readable
-- inside the organisation by members holding audit.read.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

-- Setup: second organisation with an owner; an inspector in A (no audit.read).
INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-0000-0000-0000000000b1', 'b.owner@example.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'a.inspector@example.test');
INSERT INTO public.organisations (id, name, slug) VALUES ('00000000-0000-0000-0000-00000000000b', 'Other Org', 'other-org');
SELECT app.create_default_roles('00000000-0000-0000-0000-00000000000b');
WITH m AS (
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES
    ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000b1', 'active'),
    ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a2', 'active')
  RETURNING id, organisation_id, user_id
)
INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
SELECT m.organisation_id, m.id, r.id FROM m JOIN public.roles r
  ON r.organisation_id = m.organisation_id
 AND r.key = CASE WHEN m.user_id = '00000000-0000-0000-0000-0000000000b1' THEN 'owner' ELSE 'inspector' END;
INSERT INTO public.customers (id, organisation_id, code, name) VALUES ('00000000-0000-0000-0000-0000000000bb', '00000000-0000-0000-0000-00000000000b', 'B1', 'B customer');

CREATE TEMP TABLE marker AS SELECT coalesce(max(seq), 0) AS seq FROM audit.events;
GRANT SELECT ON marker TO authenticated;

-- ---------------------------------------------------------------------------
-- Changes made by the owner of A are recorded with actor and context
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  e record;
  ncr uuid := '00000000-0000-0000-0000-0000000000c9';
BEGIN
  PERFORM pg_temp.login('00000000-0000-0000-0000-0000000000a1');
  PERFORM set_config('app.source', 'api', true);
  PERFORM set_config('app.reason', 'Customer complaint', true);
  PERFORM set_config('app.correlation_id', 'req-123', true);

  INSERT INTO public.customers (id, organisation_id, code, name, notes) VALUES (ncr, '00000000-0000-0000-0000-00000000000a', 'C900', 'Burr on edge', 'first');
  UPDATE public.customers SET name = 'Burr on edge (deburred)', notes = 'second' WHERE id = ncr;
  UPDATE public.customers SET name = name WHERE id = ncr;  -- no-op: no event

  PERFORM pg_temp.logout();
  DELETE FROM public.customers WHERE id = ncr;  -- people cannot delete customers; the owner of the table can

  PERFORM pg_temp.assert_eq((SELECT count(*) FROM audit.events WHERE entity_id = ncr::text), 3::bigint, 'insert, update, delete recorded; no-op skipped');

  SELECT * INTO e FROM audit.events WHERE entity_id = ncr::text AND action = 'update';
  PERFORM pg_temp.assert_eq(e.entity_type, 'customers', 'entity type');
  PERFORM pg_temp.assert_eq(e.actor_user_id, '00000000-0000-0000-0000-0000000000a1'::uuid, 'actor');
  PERFORM pg_temp.assert_eq(e.organisation_id, '00000000-0000-0000-0000-00000000000a'::uuid, 'organisation');
  PERFORM pg_temp.assert_eq(e.changed_fields, ARRAY['name', 'notes'], 'changed fields (bookkeeping excluded)');
  PERFORM pg_temp.assert_eq(e.previous_values ->> 'name', 'Burr on edge', 'previous value');
  PERFORM pg_temp.assert_eq(e.new_values ->> 'name', 'Burr on edge (deburred)', 'new value');
  PERFORM pg_temp.assert_eq(e.new_values ? 'updated_at', false, 'only changed fields stored on update');
  PERFORM pg_temp.assert_eq(e.source, 'api', 'source');
  PERFORM pg_temp.assert_eq(e.reason, 'Customer complaint', 'reason');
  PERFORM pg_temp.assert_eq(e.correlation_id, 'req-123', 'correlation id');

  SELECT * INTO e FROM audit.events WHERE entity_id = ncr::text AND action = 'delete';
  PERFORM pg_temp.assert_eq(e.previous_values ->> 'code', 'C900', 'deleted row kept in full');
  PERFORM pg_temp.assert_eq(e.new_values, NULL::jsonb, 'delete has no new values');

  PERFORM set_config('app.source', '', true);
  PERFORM set_config('app.reason', '', true);
  PERFORM set_config('app.correlation_id', '', true);
END $$;

-- ---------------------------------------------------------------------------
-- Access changes are recorded (roles, role permissions, memberships, settings)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  custom uuid;
BEGIN
  PERFORM pg_temp.login('00000000-0000-0000-0000-0000000000a1');
  INSERT INTO public.roles (organisation_id, key, name) VALUES ('00000000-0000-0000-0000-00000000000a', 'auditor', 'Auditor') RETURNING id INTO custom;
  INSERT INTO public.role_permissions (role_id, permission_code) VALUES (custom, 'audit.read');
  UPDATE public.organisation_settings SET vat_rate = 0.175 WHERE organisation_id = '00000000-0000-0000-0000-00000000000a';
  UPDATE public.organisation_users SET status = 'suspended' WHERE user_id = '00000000-0000-0000-0000-0000000000a2';
  PERFORM pg_temp.logout();

  PERFORM pg_temp.assert_eq((SELECT count(*) FROM audit.events WHERE entity_type = 'roles' AND entity_id = custom::text AND action = 'insert'), 1::bigint, 'role created');
  PERFORM pg_temp.assert_eq((SELECT organisation_id FROM audit.events WHERE entity_type = 'role_permissions' AND entity_id = custom || ':audit.read'), '00000000-0000-0000-0000-00000000000a'::uuid, 'role permission via role');
  PERFORM pg_temp.assert_eq((SELECT new_values ->> 'vat_rate' FROM audit.events WHERE entity_type = 'organisation_settings' AND seq > (SELECT seq FROM marker)), '0.1750', 'settings change');
  PERFORM pg_temp.assert_eq((SELECT previous_values ->> 'status' || '>' || (new_values ->> 'status') FROM audit.events WHERE entity_type = 'organisation_users' AND action = 'update' AND seq > (SELECT seq FROM marker)), 'active>suspended', 'membership status change');
  PERFORM pg_temp.assert_eq((SELECT source FROM audit.events WHERE entity_type = 'roles' AND entity_id = custom::text), 'client', 'direct client write source');

  -- System role templates belong to no organisation: not audited.
  UPDATE public.roles SET description = 'Read-only access.' WHERE organisation_id IS NULL AND key = 'viewer';
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM audit.events WHERE entity_type = 'roles' AND new_values ->> 'description' = 'Read-only access.'), 0::bigint, 'templates not audited');
END $$;

-- ---------------------------------------------------------------------------
-- Append-only: no role can change or remove events
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  PERFORM pg_temp.login('00000000-0000-0000-0000-0000000000a1');
  PERFORM pg_temp.assert_fails($q$INSERT INTO audit.events (organisation_id, entity_type, entity_id, action, source) VALUES ('00000000-0000-0000-0000-00000000000a', 'customers', 'x', 'insert', 'forged')$q$, 'client forges event');
  PERFORM pg_temp.assert_fails($q$UPDATE audit.events SET reason = 'edited'$q$, 'client edits event');
  PERFORM pg_temp.assert_fails($q$DELETE FROM audit.events$q$, 'client deletes events');
  PERFORM pg_temp.assert_fails($q$TRUNCATE audit.events$q$, 'client truncates events');
  PERFORM pg_temp.assert_fails($q$UPDATE public.audit_events SET reason = 'edited'$q$, 'edit through view');
  PERFORM pg_temp.logout();

  -- Even the table owner is stopped by the guard triggers.
  PERFORM pg_temp.assert_fails($q$UPDATE audit.events SET reason = 'edited'$q$, 'owner edits event');
  PERFORM pg_temp.assert_fails($q$DELETE FROM audit.events$q$, 'owner deletes events');
  PERFORM pg_temp.assert_fails($q$TRUNCATE audit.events$q$, 'owner truncates events');
END $$;

-- ---------------------------------------------------------------------------
-- Read access: audit.read within the organisation only
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  a_events bigint := (SELECT count(*) FROM audit.events WHERE organisation_id = '00000000-0000-0000-0000-00000000000a');
BEGIN
  PERFORM pg_temp.login('00000000-0000-0000-0000-0000000000a1');  -- owner of A
  PERFORM pg_temp.assert_eq(pg_temp.count_rows('SELECT 1 FROM public.audit_events'), a_events, 'A owner sees all A events');
  PERFORM pg_temp.assert_eq(pg_temp.count_rows($q$SELECT 1 FROM public.audit_events WHERE organisation_id = '00000000-0000-0000-0000-00000000000b'$q$), 0::bigint, 'A owner sees no B events');
  PERFORM pg_temp.logout();

  -- Reactivate the inspector (suspended above) to check permission rather than membership.
  UPDATE public.organisation_users SET status = 'active' WHERE user_id = '00000000-0000-0000-0000-0000000000a2';
  PERFORM pg_temp.login('00000000-0000-0000-0000-0000000000a2');  -- inspector: no audit.read
  PERFORM pg_temp.assert_eq(pg_temp.count_rows('SELECT 1 FROM public.audit_events'), 0::bigint, 'inspector sees no events');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login('00000000-0000-0000-0000-0000000000b1');  -- owner of B
  PERFORM pg_temp.assert_eq(pg_temp.count_rows($q$SELECT 1 FROM public.audit_events WHERE organisation_id = '00000000-0000-0000-0000-00000000000a'$q$), 0::bigint, 'B owner sees no A events');
  PERFORM pg_temp.assert_eq(pg_temp.count_rows($q$SELECT 1 FROM public.audit_events WHERE entity_id = '00000000-0000-0000-0000-0000000000bb'$q$), 1::bigint, 'B owner sees B events');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login_anon();
  PERFORM pg_temp.assert_fails('SELECT 1 FROM public.audit_events', 'anon');
  PERFORM pg_temp.assert_fails('SELECT 1 FROM audit.events', 'anon direct');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
