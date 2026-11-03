-- Phase 1 / slice 1.2 — quality audit trail (docs/phase-1-plan.md §2.4, design brief §3.5 and §11)
--
-- audit.events is append-only: rows are written only by the audit trigger, never updated or
-- deleted (privileges revoked from every API role, plus guard triggers). It is the formal quality
-- audit trail; notifications remain the activity feed.
-- Actor = auth.uid(). Source / reason / correlation id come from transaction settings the API sets
-- per request (app.source, app.reason, app.correlation_id); direct client writes record 'client'.
-- Readable through RLS by members holding audit.read, via public.audit_events.

CREATE SCHEMA audit;
REVOKE ALL ON SCHEMA audit FROM PUBLIC;
GRANT USAGE ON SCHEMA audit TO authenticated, service_role;

CREATE TABLE audit.events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,  -- strict ordering within the trail
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE RESTRICT,
  actor_user_id uuid,                               -- no FK: the trail outlives user accounts
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('insert', 'update', 'delete')),
  previous_values jsonb,
  new_values jsonb,
  changed_fields text[],
  reason text,
  source text NOT NULL,
  correlation_id text,
  transaction_id bigint NOT NULL DEFAULT txid_current(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_org_created_idx ON audit.events (organisation_id, created_at DESC);
CREATE INDEX events_org_entity_idx ON audit.events (organisation_id, entity_type, entity_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Append-only
-- ---------------------------------------------------------------------------
REVOKE ALL ON audit.events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON audit.events TO authenticated, service_role;

CREATE FUNCTION audit.reject_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'audit events are append-only (% rejected)', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER events_no_update BEFORE UPDATE OR DELETE ON audit.events
  FOR EACH ROW EXECUTE FUNCTION audit.reject_change();
CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON audit.events
  FOR EACH STATEMENT EXECUTE FUNCTION audit.reject_change();

ALTER TABLE audit.events ENABLE ROW LEVEL SECURITY;
CREATE POLICY events_select ON audit.events FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'audit.read'));

-- ---------------------------------------------------------------------------
-- Generic change recorder
--   TG_ARGV[0]: how to find the organisation — a column name, or 'via_role' (role_id -> roles)
--   TG_ARGV[1]: entity id expression — a column name, or 'role_permission' (role_id:permission_code)
-- ---------------------------------------------------------------------------
CREATE FUNCTION audit.record_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  old_row jsonb := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) END;
  new_row jsonb := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) END;
  row_data jsonb := coalesce(new_row, old_row);
  org_source text := TG_ARGV[0];
  id_source text := coalesce(TG_ARGV[1], 'id');
  v_org uuid;
  v_entity_id text;
  v_changed text[];
  v_prev jsonb;
  v_new jsonb;
BEGIN
  IF org_source = 'via_role' THEN
    SELECT r.organisation_id INTO v_org FROM public.roles r WHERE r.id = (row_data ->> 'role_id')::uuid;
  ELSE
    v_org := (row_data ->> org_source)::uuid;
  END IF;

  -- System role templates (and permissions of roles already removed) belong to no organisation.
  IF v_org IS NULL THEN
    RETURN NULL;
  END IF;

  v_entity_id := CASE id_source
    WHEN 'role_permission' THEN (row_data ->> 'role_id') || ':' || (row_data ->> 'permission_code')
    ELSE row_data ->> id_source END;

  IF TG_OP = 'UPDATE' THEN
    SELECT array_agg(k ORDER BY k) INTO v_changed
    FROM jsonb_object_keys(new_row) k
    WHERE new_row -> k IS DISTINCT FROM old_row -> k
      AND k NOT IN ('updated_at', 'updated_by');
    IF v_changed IS NULL THEN
      RETURN NULL;  -- nothing but bookkeeping changed
    END IF;
    SELECT jsonb_object_agg(k, old_row -> k), jsonb_object_agg(k, new_row -> k)
      INTO v_prev, v_new
    FROM unnest(v_changed) k;
  ELSE
    v_prev := old_row;
    v_new := new_row;
  END IF;

  INSERT INTO audit.events (organisation_id, actor_user_id, entity_type, entity_id, action,
                            previous_values, new_values, changed_fields, reason, source, correlation_id)
  VALUES (
    v_org,
    auth.uid(),
    TG_TABLE_NAME,
    v_entity_id,
    lower(TG_OP),
    v_prev,
    v_new,
    v_changed,
    nullif(current_setting('app.reason', true), ''),
    coalesce(nullif(current_setting('app.source', true), ''), CASE WHEN auth.uid() IS NULL THEN 'system' ELSE 'client' END),
    nullif(current_setting('app.correlation_id', true), '')
  );
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION audit.record_change(), audit.reject_change() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Audited tables: access control (tenancy) and quality-critical records
-- ---------------------------------------------------------------------------
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.organisations
  FOR EACH ROW EXECUTE FUNCTION audit.record_change('id');
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.organisation_settings
  FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id', 'organisation_id');
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.role_permissions
  FOR EACH ROW EXECUTE FUNCTION audit.record_change('via_role', 'role_permission');

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sites', 'departments', 'organisation_users', 'roles', 'user_role_assignments',
                           'NCM', '8D', 'Costs', 'NC Files', 'Part', 'Status', 'Failure Mode',
                           'Sub-Failure Mode', 'Process'] LOOP
    EXECUTE format('CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.%I '
                   'FOR EACH ROW EXECUTE FUNCTION audit.record_change(''organisation_id'')', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Read access for the frontend (RLS of audit.events applies through security_invoker)
-- ---------------------------------------------------------------------------
CREATE VIEW public.audit_events WITH (security_invoker = true) AS
  SELECT id, seq, organisation_id, actor_user_id, entity_type, entity_id, action, previous_values,
         new_values, changed_fields, reason, source, correlation_id, transaction_id, created_at
  FROM audit.events;
REVOKE ALL ON public.audit_events FROM PUBLIC, anon;
GRANT SELECT ON public.audit_events TO authenticated, service_role;
