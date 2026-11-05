-- Notifications: in-app events for creations, updates and deletions across the quality modules.
--
-- Design
--  * One notification row per business event, written by a trigger on audit.events (so every audited
--    table can notify without its own trigger). The row says WHAT happened; WHO sees it is decided when
--    the user reads, as that user:
--      visible = company permission (RLS-style check on the event's read permission, site-aware, which
--                already includes the subscription entitlement) AND the user's preference.
--  * Preference = the user's own override, else the default. The default is data-driven and follows
--    access: an event is on by default only when `default_on` and, where `default_permission_code` is set,
--    the user holds that permission (their role and package). Nothing is stored until someone changes a toggle.
--  * Your own actions never notify you. Read state is per user. All writes go through functions.
--  * In-app only; delivery channels (email, push) can hang off the same rows later.

-- ---------------------------------------------------------------------------
-- Catalogue of event types (global, read-only)
-- ---------------------------------------------------------------------------
CREATE TABLE public.notification_event_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,                       -- '<entity_type>.<created|updated|deleted>'
  entity_type text NOT NULL,                      -- the audited table
  action text NOT NULL CHECK (action IN ('created', 'updated', 'deleted')),
  group_name text NOT NULL,                       -- settings section
  entity_label text NOT NULL,                     -- "Non-conformance"
  description text NOT NULL,
  permission_code text NOT NULL REFERENCES public.permissions (code),  -- needed to see (and be offered) the event
  default_on boolean NOT NULL DEFAULT true,
  default_permission_code text REFERENCES public.permissions (code),   -- on by default only for holders of this
  label_fields text[] NOT NULL DEFAULT '{}',      -- columns shown in the message
  display_order integer NOT NULL DEFAULT 0,
  UNIQUE (entity_type, action)
);

INSERT INTO public.notification_event_types
  (key, entity_type, action, group_name, entity_label, description, permission_code, default_on, default_permission_code, label_fields, display_order)
SELECT e.entity_type || '.' || a.action, e.entity_type, a.action, e.grp, e.noun,
       e.noun || ' ' || CASE a.action WHEN 'created' THEN 'created' WHEN 'updated' THEN 'changed' ELSE 'deleted' END,
       e.perm,
       a.setting <> 'off',
       CASE WHEN a.setting IN ('', 'off') THEN NULL ELSE a.setting END,
       e.fields, e.ord
FROM (VALUES
  ('nonconformances',        'Non-conformance', 'Non-conformance',       'ncr.read',            ARRAY['reference', 'title'],       10, '',                       'ncr.update',           ''),
  ('calibrations',           'Calibration',     'Calibration record',    'calibration.read',    ARRAY['reference'],                20, 'calibration.record',     'calibration.record',   ''),
  ('gauges',                 'Calibration',     'Gauge',                 'calibration.read',    ARRAY['asset_number', 'description'], 21, '',                    'off',                  ''),
  ('inspection_records',     'Inspections',     'Inspection',            'inspection.read',     ARRAY['reference'],                30, 'inspection.record',      'inspection.record',    NULL),
  ('control_plans',          'Control plans',   'Control plan',          'process_control.read', ARRAY['title'],                   40, '',                       'process_control.manage', NULL),
  ('control_plan_revisions', 'Control plans',   'Control plan revision', 'process_control.read', ARRAY['status'],                  41, 'process_control.manage', '',                     NULL),
  ('parts',                  'Master data',     'Part',                  'master_data.read',    ARRAY['part_number', 'name'],      50, '',                       'off',                  NULL),
  ('customers',              'Master data',     'Customer',              'master_data.read',    ARRAY['code', 'name'],             51, '',                       'off',                  NULL),
  ('suppliers',              'Master data',     'Supplier',              'master_data.read',    ARRAY['code', 'name'],             52, '',                       'off',                  NULL),
  ('machines',               'Master data',     'Machine',               'master_data.read',    ARRAY['code', 'name'],             53, 'off',                    'off',                  NULL),
  ('part_families',          'Master data',     'Part family',           'master_data.read',    ARRAY['code', 'name'],             54, 'off',                    'off',                  NULL),
  ('user_subscription_assignments', 'Subscription & billing', 'Package assignment', 'subscription.read', ARRAY['status'],         60, '',                       '',                     NULL),
  ('organisation_subscriptions',    'Subscription & billing', 'Subscription',       'subscription.read', ARRAY['status'],         61, '',                       '',                     NULL),
  ('billing_invoices',       'Subscription & billing', 'Invoice',        'invoices.read',       ARRAY['invoice_number', 'status'], 62, '',                       '',                     NULL),
  ('organisation_users',     'People & access', 'Member',                'members.read',        ARRAY['status'],                   70, 'members.manage',         'members.manage',       NULL)
) AS e(entity_type, grp, noun, perm, fields, ord, c, u, d)
CROSS JOIN LATERAL (VALUES ('created', e.c), ('updated', e.u), ('deleted', e.d)) AS a(action, setting)
WHERE a.setting IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Tenant tables
-- ---------------------------------------------------------------------------
CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  event_type_id uuid NOT NULL REFERENCES public.notification_event_types (id),
  audit_event_id uuid NOT NULL UNIQUE,           -- one notification per audited change
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  title text NOT NULL,
  body text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,    -- site_id and parent ids, for access checks and links
  actor_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_org_created_idx ON public.notifications (organisation_id, created_at DESC);

CREATE TABLE public.notification_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  event_type_id uuid NOT NULL REFERENCES public.notification_event_types (id),
  enabled boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, user_id, event_type_id)
);

CREATE TABLE public.notification_reads (
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  notification_id uuid NOT NULL REFERENCES public.notifications (id) ON DELETE CASCADE,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, notification_id)
);

ALTER TABLE public.notification_event_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_reads ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.notification_event_types, public.notifications, public.notification_preferences, public.notification_reads
  FROM anon, authenticated;
GRANT SELECT ON public.notification_event_types, public.notifications, public.notification_preferences, public.notification_reads
  TO authenticated;

-- ---------------------------------------------------------------------------
-- Access rules
-- ---------------------------------------------------------------------------
-- May the signed-in user see this event at all? Company permission (which includes the package) and site.
CREATE FUNCTION app.notification_can_see(p_organisation_id uuid, p_event_type_id uuid, p_details jsonb)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.notification_event_types t
    WHERE t.id = p_event_type_id
      AND CASE WHEN p_details ? 'site_id'
               THEN app.has_permission(p_organisation_id, t.permission_code, (p_details ->> 'site_id')::uuid)
               ELSE app.has_permission_somewhere(p_organisation_id, t.permission_code) END)
$$;

-- Does the signed-in user want this event? Their override, else the default from their access.
CREATE FUNCTION app.notification_wanted(p_organisation_id uuid, p_event_type_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(
    (SELECT p.enabled FROM public.notification_preferences p
      WHERE p.organisation_id = p_organisation_id AND p.user_id = auth.uid() AND p.event_type_id = p_event_type_id),
    (SELECT t.default_on AND (t.default_permission_code IS NULL
                              OR app.has_permission_somewhere(p_organisation_id, t.default_permission_code))
       FROM public.notification_event_types t WHERE t.id = p_event_type_id),
    false)
$$;

CREATE POLICY notification_event_types_select ON public.notification_event_types FOR SELECT TO authenticated USING (true);
CREATE POLICY notifications_select ON public.notifications FOR SELECT TO authenticated
  USING (app.notification_can_see(organisation_id, event_type_id, details));
CREATE POLICY notification_preferences_select ON public.notification_preferences FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND app.is_member(organisation_id));
CREATE POLICY notification_reads_select ON public.notification_reads FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND app.is_member(organisation_id));

-- ---------------------------------------------------------------------------
-- Writing notifications: every audited change that has an event type
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.emit_notification() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_action text;
  v_type public.notification_event_types%ROWTYPE;
  v_row jsonb := coalesce(NEW.new_values, NEW.previous_values);
  v_what text;
  v_body text;
  v_details jsonb;
BEGIN
  v_action := CASE
    WHEN NEW.action = 'insert' THEN 'created'
    WHEN NEW.action = 'delete' THEN 'deleted'
    WHEN NEW.changed_fields @> ARRAY['deleted_at'] AND NEW.new_values ->> 'deleted_at' IS NOT NULL THEN 'deleted'
    ELSE 'updated' END;

  SELECT * INTO v_type FROM public.notification_event_types t WHERE t.entity_type = NEW.entity_type AND t.action = v_action;
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- Changed values are all an update records, so fall back to the previous ones for the label.
  v_row := coalesce(NEW.previous_values, '{}'::jsonb) || coalesce(NEW.new_values, '{}'::jsonb);
  IF NEW.action = 'insert' THEN v_row := NEW.new_values; END IF;
  IF NEW.action = 'delete' THEN v_row := NEW.previous_values; END IF;

  v_body := nullif(concat_ws(' — ', VARIADIC (
    SELECT coalesce(array_agg(nullif(v_row ->> f, '') ORDER BY ord), '{}') FROM unnest(v_type.label_fields) WITH ORDINALITY AS u(f, ord))), '');
  IF v_action = 'updated' AND NEW.changed_fields IS NOT NULL THEN
    v_what := 'Changed: ' || replace(array_to_string(NEW.changed_fields, ', '), '_', ' ');
    v_body := concat_ws('. ', v_body, left(v_what, 200));
  END IF;

  SELECT coalesce(jsonb_object_agg(k, v_row -> k), '{}'::jsonb) INTO v_details
    FROM unnest(ARRAY['site_id', 'gauge_id', 'control_plan_id', 'part_id', 'source', 'stage', 'status']) k
   WHERE v_row ->> k IS NOT NULL;

  INSERT INTO public.notifications (organisation_id, event_type_id, audit_event_id, entity_type, entity_id, title, body, details, actor_user_id)
  VALUES (NEW.organisation_id, v_type.id, NEW.id, NEW.entity_type, NEW.entity_id, v_type.description, v_body, v_details, NEW.actor_user_id)
  ON CONFLICT (audit_event_id) DO NOTHING;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.emit_notification() FROM PUBLIC;

CREATE TRIGGER emit_notification AFTER INSERT ON audit.events
  FOR EACH ROW EXECUTE FUNCTION app.emit_notification();

-- ---------------------------------------------------------------------------
-- Reading and changing what the signed-in user sees
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.visible_notifications(p_organisation_id uuid)
RETURNS TABLE (id uuid, event_key text, entity_type text, entity_id text, title text, body text, details jsonb,
               actor_user_id uuid, created_at timestamptz, read_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT n.id, t.key, n.entity_type, n.entity_id, n.title, n.body, n.details, n.actor_user_id, n.created_at, r.read_at
  FROM public.notifications n
  JOIN public.notification_event_types t ON t.id = n.event_type_id
  LEFT JOIN public.notification_reads r ON r.notification_id = n.id AND r.user_id = auth.uid()
  WHERE n.organisation_id = p_organisation_id
    AND app.is_member(p_organisation_id)
    AND n.created_at > now() - interval '90 days'
    AND n.actor_user_id IS DISTINCT FROM auth.uid()
    AND app.notification_can_see(n.organisation_id, n.event_type_id, n.details)
    AND app.notification_wanted(n.organisation_id, n.event_type_id)
$$;

CREATE FUNCTION app.mark_notifications_read(p_organisation_id uuid, p_ids uuid[] DEFAULT NULL)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO public.notification_reads (organisation_id, user_id, notification_id)
  SELECT p_organisation_id, auth.uid(), v.id
  FROM app.visible_notifications(p_organisation_id) v
  WHERE v.read_at IS NULL AND (p_ids IS NULL OR v.id = ANY (p_ids))
  ON CONFLICT DO NOTHING
$$;

-- The events the signed-in user may choose from (those they could see), with their effective setting.
CREATE FUNCTION app.list_notification_preferences(p_organisation_id uuid)
RETURNS TABLE (key text, group_name text, entity_label text, action text, description text,
               enabled boolean, default_enabled boolean, overridden boolean, display_order integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT t.key, t.group_name, t.entity_label, t.action, t.description,
         app.notification_wanted(p_organisation_id, t.id),
         t.default_on AND (t.default_permission_code IS NULL OR app.has_permission_somewhere(p_organisation_id, t.default_permission_code)),
         EXISTS (SELECT 1 FROM public.notification_preferences p
                  WHERE p.organisation_id = p_organisation_id AND p.user_id = auth.uid() AND p.event_type_id = t.id),
         t.display_order
  FROM public.notification_event_types t
  WHERE app.is_member(p_organisation_id) AND app.has_permission_somewhere(p_organisation_id, t.permission_code)
  ORDER BY t.display_order, t.action
$$;

-- enabled NULL removes the override (back to the default).
CREATE FUNCTION app.set_notification_preference(p_organisation_id uuid, p_event_key text, p_enabled boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_type public.notification_event_types%ROWTYPE;
BEGIN
  IF NOT app.is_member(p_organisation_id) THEN
    RAISE EXCEPTION 'Not a member of this organisation' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_type FROM public.notification_event_types WHERE key = p_event_key;
  IF NOT FOUND OR NOT app.has_permission_somewhere(p_organisation_id, v_type.permission_code) THEN
    RAISE EXCEPTION 'Unknown notification type' USING ERRCODE = 'QM010';
  END IF;
  IF p_enabled IS NULL THEN
    DELETE FROM public.notification_preferences
     WHERE organisation_id = p_organisation_id AND user_id = auth.uid() AND event_type_id = v_type.id;
  ELSE
    INSERT INTO public.notification_preferences (organisation_id, user_id, event_type_id, enabled)
    VALUES (p_organisation_id, auth.uid(), v_type.id, p_enabled)
    ON CONFLICT (organisation_id, user_id, event_type_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now();
  END IF;
END $$;

CREATE FUNCTION app.reset_notification_preferences(p_organisation_id uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  DELETE FROM public.notification_preferences
   WHERE organisation_id = p_organisation_id AND user_id = auth.uid() AND app.is_member(p_organisation_id)
$$;

REVOKE ALL ON FUNCTION app.notification_can_see(uuid, uuid, jsonb), app.notification_wanted(uuid, uuid),
  app.visible_notifications(uuid), app.mark_notifications_read(uuid, uuid[]),
  app.list_notification_preferences(uuid), app.set_notification_preference(uuid, text, boolean),
  app.reset_notification_preferences(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.notification_can_see(uuid, uuid, jsonb), app.notification_wanted(uuid, uuid),
  app.visible_notifications(uuid), app.mark_notifications_read(uuid, uuid[]),
  app.list_notification_preferences(uuid), app.set_notification_preference(uuid, text, boolean),
  app.reset_notification_preferences(uuid) TO authenticated;
