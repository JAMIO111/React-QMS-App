-- Custom fields (docs/custom-fields-plan.md, slice CF1): organisation-defined extra fields on 13 kinds of record.
--  * custom_field_definitions: per organisation and kind of record; key and type fixed once created; options switched off, never removed;
--    retired with a reason, never deleted; at most 20 active per kind of record, at most 100 options a list. Written only by functions
--    (custom_fields.manage), read by every member, audited.
--  * custom_field_values: one row per record (primary key = the record's id), a jsonb object keyed by field key. Kept apart from the
--    records so their own locking triggers stay untouched. Written only by app.set_custom_values (the record's own edit permission, the
--    record not locked, every value checked against its definition), read under the record's own read permission, audited.
--  * Required, per field: never, when the record is saved (checked at the end of the transaction that creates a record, and a value can
--    never be cleared) or before the record reaches a stage (checked when its stage / status moves into that stage or later). Existing
--    records are never blocked otherwise. Errors QM023 → 409 custom_field_rule.

INSERT INTO public.permissions (code, description) VALUES ('custom_fields.manage', 'Define custom fields on records');
WITH grants(key, perms) AS (VALUES
  ('owner',           ARRAY['custom_fields.manage']),
  ('admin',           ARRAY['custom_fields.manage']),
  ('quality_manager', ARRAY['custom_fields.manage'])
)
INSERT INTO public.role_permissions (role_id, permission_code)
SELECT r.id, unnest(g.perms) FROM public.roles r JOIN grants g ON g.key = r.key WHERE r.is_system
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Kinds of record and their stages
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.custom_field_entities() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT ARRAY['part', 'part_family', 'machine', 'gauge_type', 'gauge', 'supplier', 'customer', 'employee',
               'nonconformance', 'capa', 'inspection', 'production_order', 'lot']
$$;

-- The stages a field can be required at, in order (empty for records without stages). Stages not listed (cancelled, abandoned, on hold)
-- are never a target and never block.
CREATE FUNCTION app.custom_field_stages(p_entity text) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE p_entity
    WHEN 'nonconformance' THEN ARRAY['draft', 'open', 'contained', 'investigating', 'dispositioned', 'awaiting_closure', 'closed']
    WHEN 'capa' THEN ARRAY['open', 'actions_in_progress', 'awaiting_verification', 'verified_effective', 'closed']
    WHEN 'inspection' THEN ARRAY['in_progress', 'completed']
    WHEN 'production_order' THEN ARRAY['planned', 'released', 'in_progress', 'completed', 'closed']
    WHEN 'lot' THEN ARRAY['open', 'released', 'closed']
    ELSE ARRAY[]::text[] END
$$;

-- ---------------------------------------------------------------------------
-- Definitions
-- ---------------------------------------------------------------------------
CREATE TABLE public.custom_field_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type = ANY (app.custom_field_entities())),
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 80 AND label = btrim(label)),
  field_type text NOT NULL CHECK (field_type IN ('text', 'long_text', 'number', 'date', 'boolean', 'choice', 'multi_choice', 'person')),
  help_text text CHECK (help_text IS NULL OR length(help_text) BETWEEN 1 AND 500),
  section text CHECK (section IS NULL OR length(btrim(section)) BETWEEN 1 AND 60),
  position integer NOT NULL DEFAULT 0,
  required_at text NOT NULL DEFAULT 'never',
  options jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) <= 100),
  number_decimals integer CHECK (number_decimals IS NULL OR number_decimals BETWEEN 0 AND 6),
  number_unit text CHECK (number_unit IS NULL OR length(btrim(number_unit)) BETWEEN 1 AND 20),
  number_min numeric,
  number_max numeric,
  active boolean NOT NULL DEFAULT true,
  retired_at timestamptz,
  retired_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  retire_reason text CHECK (retire_reason IS NULL OR length(btrim(retire_reason)) BETWEEN 3 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT custom_field_definitions_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT custom_field_definitions_key_key UNIQUE (organisation_id, entity_type, key),
  CONSTRAINT custom_field_definitions_required CHECK (required_at IN ('never', 'save') OR required_at = ANY (app.custom_field_stages(entity_type))),
  CONSTRAINT custom_field_definitions_options_for_lists CHECK ((field_type IN ('choice', 'multi_choice')) = (jsonb_array_length(options) > 0)),
  CONSTRAINT custom_field_definitions_number_only CHECK (field_type = 'number' OR (number_decimals IS NULL AND number_unit IS NULL AND number_min IS NULL AND number_max IS NULL)),
  CONSTRAINT custom_field_definitions_number_range CHECK (number_min IS NULL OR number_max IS NULL OR number_min <= number_max),
  CONSTRAINT custom_field_definitions_retired CHECK (active = (retired_at IS NULL) AND (active OR retire_reason IS NOT NULL))
);
CREATE UNIQUE INDEX custom_field_definitions_label_key ON public.custom_field_definitions (organisation_id, entity_type, lower(label)) WHERE active;
CREATE INDEX custom_field_definitions_org_entity_idx ON public.custom_field_definitions (organisation_id, entity_type, position);

CREATE TRIGGER custom_field_definitions_touch BEFORE UPDATE ON public.custom_field_definitions FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER custom_field_definitions_org_immutable BEFORE UPDATE ON public.custom_field_definitions FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.custom_field_definitions FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.custom_field_definitions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.custom_field_definitions FROM anon, authenticated;
GRANT SELECT ON public.custom_field_definitions TO authenticated;
CREATE POLICY custom_field_definitions_select ON public.custom_field_definitions FOR SELECT TO authenticated USING (app.is_member(organisation_id));

-- Key and type never change.
CREATE FUNCTION app.custom_field_definition_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF (NEW.entity_type, NEW.key, NEW.field_type) IS DISTINCT FROM (OLD.entity_type, OLD.key, OLD.field_type) THEN
    RAISE EXCEPTION 'The key and type of a custom field cannot change: retire it and add a new one' USING ERRCODE = 'QM023';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER custom_field_definitions_guard BEFORE UPDATE ON public.custom_field_definitions FOR EACH ROW EXECUTE FUNCTION app.custom_field_definition_guard();

-- ---------------------------------------------------------------------------
-- Values
-- ---------------------------------------------------------------------------
CREATE TABLE public.custom_field_values (
  record_id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type = ANY (app.custom_field_entities())),
  "values" jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof("values") = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL
);
CREATE INDEX custom_field_values_org_entity_idx ON public.custom_field_values (organisation_id, entity_type);
CREATE INDEX custom_field_values_values_idx ON public.custom_field_values USING gin ("values" jsonb_path_ops);
CREATE TRIGGER custom_field_values_touch BEFORE UPDATE ON public.custom_field_values FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER custom_field_values_org_immutable BEFORE UPDATE ON public.custom_field_values FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.custom_field_values FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id', 'record_id');

-- Who may read and who may fill in custom values: the record's own permissions.
CREATE FUNCTION app.custom_values_readable(p_org uuid, p_entity text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT CASE p_entity
    WHEN 'gauge' THEN app.has_permission(p_org, 'calibration.read')
    WHEN 'nonconformance' THEN app.has_permission(p_org, 'ncr.read')
    WHEN 'capa' THEN app.has_permission(p_org, 'capa.read')
    WHEN 'inspection' THEN app.has_permission(p_org, 'inspection.read')
    WHEN 'production_order' THEN app.has_permission(p_org, 'production.read')
    WHEN 'lot' THEN app.has_permission(p_org, 'production.read')
    ELSE app.is_member(p_org) END
$$;

CREATE FUNCTION app.custom_values_writable(p_org uuid, p_entity text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT CASE p_entity
    WHEN 'supplier' THEN app.has_permission(p_org, 'master_data.manage') OR app.has_permission(p_org, 'supplier_quality.manage')
    WHEN 'gauge_type' THEN app.has_permission(p_org, 'calibration.manage')
    WHEN 'gauge' THEN app.has_permission(p_org, 'calibration.manage')
    WHEN 'nonconformance' THEN app.has_permission(p_org, 'ncr.update')
    WHEN 'capa' THEN app.has_permission(p_org, 'capa.manage')
    WHEN 'inspection' THEN app.has_permission(p_org, 'inspection.record')
    WHEN 'production_order' THEN app.has_permission(p_org, 'production.manage')
    WHEN 'lot' THEN app.has_permission(p_org, 'production.manage')
    ELSE app.has_permission(p_org, 'master_data.manage') END
$$;

ALTER TABLE public.custom_field_values ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.custom_field_values FROM anon, authenticated;
GRANT SELECT ON public.custom_field_values TO authenticated;
CREATE POLICY custom_field_values_select ON public.custom_field_values FOR SELECT TO authenticated
  USING (app.custom_values_readable(organisation_id, entity_type));

-- A record of a kind: its organisation, its stage (null without stages) and whether it is locked. Nothing when there is no such record.
CREATE FUNCTION app.custom_field_record(p_entity text, p_id uuid, OUT org uuid, OUT stage text, OUT locked boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  CASE p_entity
    WHEN 'part' THEN SELECT organisation_id, NULL, false INTO org, stage, locked FROM public.parts WHERE id = p_id;
    WHEN 'part_family' THEN SELECT organisation_id, NULL, false INTO org, stage, locked FROM public.part_families WHERE id = p_id;
    WHEN 'machine' THEN SELECT organisation_id, NULL, false INTO org, stage, locked FROM public.machines WHERE id = p_id;
    WHEN 'gauge_type' THEN SELECT organisation_id, NULL, false INTO org, stage, locked FROM public.gauge_types WHERE id = p_id;
    WHEN 'gauge' THEN SELECT organisation_id, NULL, deleted_at IS NOT NULL INTO org, stage, locked FROM public.gauges WHERE id = p_id;
    WHEN 'supplier' THEN SELECT organisation_id, NULL, false INTO org, stage, locked FROM public.suppliers WHERE id = p_id;
    WHEN 'customer' THEN SELECT organisation_id, NULL, false INTO org, stage, locked FROM public.customers WHERE id = p_id;
    WHEN 'employee' THEN SELECT organisation_id, NULL, false INTO org, stage, locked FROM public."Employees" WHERE id = p_id;
    WHEN 'nonconformance' THEN SELECT n.organisation_id, n.stage, n.deleted_at IS NOT NULL OR n.stage IN ('closed', 'cancelled') INTO org, stage, locked
      FROM public.nonconformances n WHERE n.id = p_id;
    WHEN 'capa' THEN SELECT c.organisation_id, c.stage, c.stage IN ('closed', 'cancelled') INTO org, stage, locked FROM public.capas c WHERE c.id = p_id;
    WHEN 'inspection' THEN SELECT i.organisation_id, i.status, i.status <> 'in_progress' INTO org, stage, locked FROM public.inspection_records i WHERE i.id = p_id;
    WHEN 'production_order' THEN SELECT o.organisation_id, o.status, o.status IN ('closed', 'cancelled') INTO org, stage, locked FROM public.production_orders o WHERE o.id = p_id;
    WHEN 'lot' THEN SELECT l.organisation_id, l.status, l.status = 'closed' INTO org, stage, locked FROM public.lots l WHERE l.id = p_id;
    ELSE RAISE EXCEPTION 'Custom fields are not available on %', p_entity USING ERRCODE = 'QM023';
  END CASE;
END $$;

-- ---------------------------------------------------------------------------
-- Checking one value
-- ---------------------------------------------------------------------------
-- The value to store for a field (null = no value), or an error written for the person. p_old is what the record holds now, so a value of
-- a switched-off option or a person who has left can be kept.
CREATE FUNCTION app.custom_field_value(d public.custom_field_definitions, p_value jsonb, p_old jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE
  v_text text;
  v_num numeric;
  v_date date;
  v_items jsonb := '[]'::jsonb;
  v_item jsonb;
  v_opt jsonb;
  v_max integer;
BEGIN
  IF p_value IS NULL OR p_value = 'null'::jsonb OR p_value = '""'::jsonb OR p_value = '[]'::jsonb THEN
    RETURN NULL;
  END IF;
  CASE d.field_type
    WHEN 'text', 'long_text' THEN
      IF jsonb_typeof(p_value) NOT IN ('string', 'number') THEN RAISE EXCEPTION '%: give text', d.label USING ERRCODE = 'QM023'; END IF;
      v_text := btrim(p_value #>> '{}');
      IF v_text = '' THEN RETURN NULL; END IF;
      v_max := (ARRAY[500, 5000])[1 + (d.field_type = 'long_text')::int];
      IF length(v_text) > v_max THEN
        RAISE EXCEPTION '%: at most % characters', d.label, v_max USING ERRCODE = 'QM023';
      END IF;
      RETURN to_jsonb(v_text);
    WHEN 'number' THEN
      v_text := btrim(p_value #>> '{}');
      IF jsonb_typeof(p_value) NOT IN ('string', 'number') OR v_text !~ '^-?[0-9]+(\.[0-9]+)?$' THEN
        RAISE EXCEPTION '%: "%" is not a number', d.label, v_text USING ERRCODE = 'QM023';
      END IF;
      v_num := v_text::numeric;
      IF d.number_decimals IS NOT NULL AND scale(v_num) > d.number_decimals AND v_num <> round(v_num, d.number_decimals) THEN
        RAISE EXCEPTION '%: at most % decimal places', d.label, d.number_decimals USING ERRCODE = 'QM023';
      END IF;
      IF d.number_min IS NOT NULL AND v_num < d.number_min THEN RAISE EXCEPTION '%: at least %', d.label, d.number_min USING ERRCODE = 'QM023'; END IF;
      IF d.number_max IS NOT NULL AND v_num > d.number_max THEN RAISE EXCEPTION '%: at most %', d.label, d.number_max USING ERRCODE = 'QM023'; END IF;
      RETURN to_jsonb(v_num);
    WHEN 'date' THEN
      v_text := btrim(p_value #>> '{}');
      IF jsonb_typeof(p_value) <> 'string' OR v_text !~ '^\d{4}-\d{2}-\d{2}$' THEN
        RAISE EXCEPTION '%: give a date as year-month-day', d.label USING ERRCODE = 'QM023';
      END IF;
      BEGIN
        v_date := v_text::date;
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION '%: % is not a date', d.label, v_text USING ERRCODE = 'QM023';
      END;
      IF to_char(v_date, 'YYYY-MM-DD') <> v_text THEN RAISE EXCEPTION '%: % is not a date', d.label, v_text USING ERRCODE = 'QM023'; END IF;
      RETURN to_jsonb(v_text);
    WHEN 'boolean' THEN
      IF jsonb_typeof(p_value) <> 'boolean' THEN RAISE EXCEPTION '%: give yes or no', d.label USING ERRCODE = 'QM023'; END IF;
      RETURN p_value;
    WHEN 'choice' THEN
      IF jsonb_typeof(p_value) <> 'string' THEN RAISE EXCEPTION '%: choose one of the options', d.label USING ERRCODE = 'QM023'; END IF;
      SELECT o INTO v_opt FROM jsonb_array_elements(d.options) o WHERE o ->> 'key' = p_value #>> '{}';
      IF v_opt IS NULL THEN RAISE EXCEPTION '%: "%" is not one of the options', d.label, p_value #>> '{}' USING ERRCODE = 'QM023'; END IF;
      IF NOT coalesce((v_opt ->> 'active')::boolean, true) AND p_value IS DISTINCT FROM p_old THEN
        RAISE EXCEPTION '%: "%" is switched off', d.label, v_opt ->> 'label' USING ERRCODE = 'QM023';
      END IF;
      RETURN p_value;
    WHEN 'multi_choice' THEN
      IF jsonb_typeof(p_value) <> 'array' THEN RAISE EXCEPTION '%: choose from the options', d.label USING ERRCODE = 'QM023'; END IF;
      FOR v_item IN SELECT e FROM jsonb_array_elements(p_value) e LOOP
        IF jsonb_typeof(v_item) <> 'string' THEN RAISE EXCEPTION '%: choose from the options', d.label USING ERRCODE = 'QM023'; END IF;
        SELECT o INTO v_opt FROM jsonb_array_elements(d.options) o WHERE o ->> 'key' = v_item #>> '{}';
        IF v_opt IS NULL THEN RAISE EXCEPTION '%: "%" is not one of the options', d.label, v_item #>> '{}' USING ERRCODE = 'QM023'; END IF;
        IF NOT coalesce((v_opt ->> 'active')::boolean, true) AND NOT coalesce(p_old @> jsonb_build_array(v_item), false) THEN
          RAISE EXCEPTION '%: "%" is switched off', d.label, v_opt ->> 'label' USING ERRCODE = 'QM023';
        END IF;
        IF NOT v_items @> jsonb_build_array(v_item) THEN v_items := v_items || jsonb_build_array(v_item); END IF;
      END LOOP;
      RETURN CASE WHEN jsonb_array_length(v_items) = 0 THEN NULL ELSE v_items END;
    WHEN 'person' THEN
      v_text := p_value #>> '{}';
      IF jsonb_typeof(p_value) <> 'string' OR v_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION '%: choose a person', d.label USING ERRCODE = 'QM023';
      END IF;
      IF p_value IS DISTINCT FROM p_old AND NOT EXISTS (
        SELECT 1 FROM public.organisation_users m WHERE m.organisation_id = d.organisation_id AND m.user_id = v_text::uuid AND m.status = 'active') THEN
        RAISE EXCEPTION '%: that person is not a member of the organisation', d.label USING ERRCODE = 'QM023';
      END IF;
      RETURN to_jsonb(lower(v_text));
  END CASE;
END $$;

-- ---------------------------------------------------------------------------
-- Writing values
-- ---------------------------------------------------------------------------
-- Merge p_values (field key → value; null or empty clears) into a record's values, checking each against its definition. No permission
-- checks: app.set_custom_values (people) and the importers (later) call it after their own checks. Returns the stored values.
CREATE FUNCTION app.write_custom_values(p_entity text, p_record uuid, p_org uuid, p_values jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_old jsonb;
  v_new jsonb;
  v_key text;
  d public.custom_field_definitions;
  v_value jsonb;
BEGIN
  IF p_values IS NULL OR jsonb_typeof(p_values) <> 'object' THEN
    RAISE EXCEPTION 'Custom values must be given as field key → value' USING ERRCODE = 'QM023';
  END IF;
  SELECT "values" INTO v_old FROM public.custom_field_values WHERE record_id = p_record FOR UPDATE;
  v_old := coalesce(v_old, '{}'::jsonb);
  v_new := v_old;
  FOR v_key IN SELECT jsonb_object_keys(p_values) LOOP
    SELECT * INTO d FROM public.custom_field_definitions WHERE organisation_id = p_org AND entity_type = p_entity AND key = v_key;
    IF d.id IS NULL THEN
      RAISE EXCEPTION 'There is no custom field "%" on this kind of record', v_key USING ERRCODE = 'QM023';
    END IF;
    v_value := app.custom_field_value(d, p_values -> v_key, v_old -> v_key);
    IF NOT d.active AND v_value IS DISTINCT FROM (v_old -> v_key) AND v_value IS NOT NULL THEN
      RAISE EXCEPTION '%: this field is retired; its value can only be kept or cleared', d.label USING ERRCODE = 'QM023';
    END IF;
    IF v_value IS NULL THEN
      IF d.active AND d.required_at = 'save' AND v_old ? v_key THEN
        RAISE EXCEPTION '% is required and cannot be cleared', d.label USING ERRCODE = 'QM023';
      END IF;
      v_new := v_new - v_key;
    ELSE
      v_new := jsonb_set(v_new, ARRAY[v_key], v_value);
    END IF;
  END LOOP;
  IF v_new IS DISTINCT FROM v_old THEN
    INSERT INTO public.custom_field_values (record_id, organisation_id, entity_type, "values")
    VALUES (p_record, p_org, p_entity, v_new)
    ON CONFLICT (record_id) DO UPDATE SET "values" = EXCLUDED."values", updated_by = auth.uid()
      WHERE public.custom_field_values.organisation_id = EXCLUDED.organisation_id AND public.custom_field_values.entity_type = EXCLUDED.entity_type;
  END IF;
  RETURN v_new;
END $$;

-- People fill in custom values here: the record's own edit permission, the record not locked.
CREATE FUNCTION app.set_custom_values(p_entity text, p_record uuid, p_values jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r record;
BEGIN
  IF NOT (p_entity = ANY (app.custom_field_entities())) THEN
    RAISE EXCEPTION 'Custom fields are not available on %', p_entity USING ERRCODE = 'QM023';
  END IF;
  SELECT * INTO r FROM app.custom_field_record(p_entity, p_record);
  IF r.org IS NULL OR NOT app.custom_values_readable(r.org, p_entity) THEN
    RAISE EXCEPTION 'Record not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT app.custom_values_writable(r.org, p_entity) THEN
    RAISE EXCEPTION 'You are not allowed to change this record' USING ERRCODE = '42501';
  END IF;
  IF r.locked AND app.write_custom_values_dry(p_entity, p_record, r.org, p_values) THEN
    RAISE EXCEPTION 'This record is closed, so its custom fields cannot change' USING ERRCODE = 'QM023';
  END IF;
  RETURN app.write_custom_values(p_entity, p_record, r.org, p_values);
END $$;

-- A record's custom values for the caller: not found when there is no such record or the caller may not read it; {} when it has none.
CREATE FUNCTION app.get_custom_values(p_entity text, p_record uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE r record;
BEGIN
  IF NOT (p_entity = ANY (app.custom_field_entities())) THEN
    RAISE EXCEPTION 'Custom fields are not available on %', p_entity USING ERRCODE = 'QM023';
  END IF;
  SELECT * INTO r FROM app.custom_field_record(p_entity, p_record);
  IF r.org IS NULL OR NOT app.custom_values_readable(r.org, p_entity) THEN
    RAISE EXCEPTION 'Record not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN coalesce((SELECT "values" FROM public.custom_field_values WHERE record_id = p_record AND entity_type = p_entity), '{}'::jsonb);
END $$;

-- Whether writing p_values would change anything (a locked record accepts a save that changes nothing).
CREATE FUNCTION app.write_custom_values_dry(p_entity text, p_record uuid, p_org uuid, p_values jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_old jsonb := coalesce((SELECT "values" FROM public.custom_field_values WHERE record_id = p_record), '{}'::jsonb);
  v_key text;
  v_value jsonb;
  d public.custom_field_definitions;
BEGIN
  IF p_values IS NULL OR jsonb_typeof(p_values) <> 'object' THEN RETURN true; END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_values) LOOP
    SELECT * INTO d FROM public.custom_field_definitions WHERE organisation_id = p_org AND entity_type = p_entity AND key = v_key;
    IF d.id IS NULL THEN RETURN true; END IF;
    v_value := app.custom_field_value(d, p_values -> v_key, v_old -> v_key);
    IF v_value IS DISTINCT FROM (v_old -> v_key) THEN RETURN true; END IF;
  END LOOP;
  RETURN false;
END $$;

-- The labels of required fields without a value, for a record at a stage: fields required on save, and fields required at that stage or
-- an earlier one (p_stage null = save only).
CREATE FUNCTION app.custom_values_missing(p_entity text, p_record uuid, p_org uuid, p_stage text) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(array_agg(d.label ORDER BY d.position, d.label), ARRAY[]::text[])
  FROM public.custom_field_definitions d
  WHERE d.organisation_id = p_org AND d.entity_type = p_entity AND d.active AND d.required_at <> 'never'
    AND (d.required_at = 'save'
         OR (p_stage IS NOT NULL AND array_position(app.custom_field_stages(p_entity), p_stage) >= array_position(app.custom_field_stages(p_entity), d.required_at)))
    AND NOT coalesce((SELECT v."values" ? d.key FROM public.custom_field_values v WHERE v.record_id = p_record), false)
$$;

-- ---------------------------------------------------------------------------
-- Required checks on the records
-- ---------------------------------------------------------------------------
-- At the end of the transaction that created a record: everything required on save, and at its stage, has a value.
CREATE FUNCTION app.custom_values_required_on_create() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_entity text := TG_ARGV[0];
  v_stage text := CASE WHEN TG_NARGS > 1 THEN to_jsonb(NEW) ->> TG_ARGV[1] END;
  v_missing text[];
BEGIN
  IF NEW.organisation_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.custom_field_definitions d
    WHERE d.organisation_id = NEW.organisation_id AND d.entity_type = v_entity AND d.active AND d.required_at <> 'never') THEN
    RETURN NULL;
  END IF;
  v_missing := app.custom_values_missing(v_entity, NEW.id, NEW.organisation_id, v_stage);
  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'Fill in % first', array_to_string(v_missing, ', ') USING ERRCODE = 'QM023';
  END IF;
  RETURN NULL;
END $$;

-- When a record moves from before a stage to it (or later): what is required by then has a value. Cancelling, abandoning or holding never
-- blocks (those stages are not in the order); a record already at or past a stage is not checked again.
CREATE FUNCTION app.custom_values_stage_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_entity text := TG_ARGV[0];
  v_col text := TG_ARGV[1];
  v_order text[] := app.custom_field_stages(v_entity);
  v_old text := to_jsonb(OLD) ->> v_col;
  v_new text := to_jsonb(NEW) ->> v_col;
  v_old_pos integer := coalesce(array_position(v_order, v_old), 0);
  v_new_pos integer := array_position(v_order, v_new);
  v_missing text[];
BEGIN
  IF v_new_pos IS NULL OR v_old IS NOT DISTINCT FROM v_new THEN RETURN NEW; END IF;
  SELECT coalesce(array_agg(d.label ORDER BY d.position, d.label), ARRAY[]::text[]) INTO v_missing
  FROM public.custom_field_definitions d
  WHERE d.organisation_id = NEW.organisation_id AND d.entity_type = v_entity AND d.active
    AND array_position(v_order, d.required_at) BETWEEN v_old_pos + 1 AND v_new_pos
    AND NOT coalesce((SELECT v."values" ? d.key FROM public.custom_field_values v WHERE v.record_id = NEW.id), false);
  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'Fill in % before this moves to %', array_to_string(v_missing, ', '), replace(v_new, '_', ' ') USING ERRCODE = 'QM023';
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT * FROM (VALUES
    ('parts', 'part', NULL), ('part_families', 'part_family', NULL), ('machines', 'machine', NULL), ('gauge_types', 'gauge_type', NULL),
    ('gauges', 'gauge', NULL), ('suppliers', 'supplier', NULL), ('customers', 'customer', NULL), ('Employees', 'employee', NULL),
    ('nonconformances', 'nonconformance', 'stage'), ('capas', 'capa', 'stage'), ('inspection_records', 'inspection', 'status'),
    ('production_orders', 'production_order', 'status'), ('lots', 'lot', 'status')) AS x(tbl, entity, col)
  LOOP
    EXECUTE format('CREATE CONSTRAINT TRIGGER custom_values_required AFTER INSERT ON public.%I DEFERRABLE INITIALLY DEFERRED '
                   'FOR EACH ROW EXECUTE FUNCTION app.custom_values_required_on_create(%L%s)',
                   t.tbl, t.entity, CASE WHEN t.col IS NULL THEN '' ELSE format(', %L', t.col) END);
    IF t.col IS NOT NULL THEN
      EXECUTE format('CREATE TRIGGER custom_values_stage BEFORE UPDATE OF %I ON public.%I FOR EACH ROW EXECUTE FUNCTION app.custom_values_stage_check(%L, %L)',
                     t.col, t.tbl, t.entity, t.col);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Managing definitions
-- ---------------------------------------------------------------------------
-- The problem with a list of options, or null. Options are {key, label, active}; keys lower case, unique; labels unique ignoring case.
CREATE FUNCTION app.custom_field_options_problem(p_options jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE
    WHEN p_options IS NULL OR jsonb_typeof(p_options) <> 'array' THEN 'Options must be a list'
    WHEN jsonb_array_length(p_options) = 0 THEN 'Give at least one option'
    WHEN jsonb_array_length(p_options) > 100 THEN 'At most 100 options'
    WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(p_options) o
                 WHERE jsonb_typeof(o) <> 'object' OR coalesce(o ->> 'key', '') !~ '^[a-z0-9][a-z0-9_]{0,39}$'
                    OR length(btrim(coalesce(o ->> 'label', ''))) NOT BETWEEN 1 AND 80
                    OR (o ? 'active' AND jsonb_typeof(o -> 'active') <> 'boolean')) THEN 'Every option needs a key (lower case letters, digits, _) and a label of up to 80 characters'
    WHEN (SELECT count(DISTINCT o ->> 'key') FROM jsonb_array_elements(p_options) o) <> jsonb_array_length(p_options) THEN 'Two options have the same key'
    WHEN (SELECT count(DISTINCT lower(btrim(o ->> 'label'))) FROM jsonb_array_elements(p_options) o) <> jsonb_array_length(p_options) THEN 'Two options have the same label'
    ELSE NULL END
$$;

-- A key made from a label, free among the organisation's fields of that kind.
CREATE FUNCTION app.custom_field_key_from(p_org uuid, p_entity text, p_label text) RETURNS text
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE v_base text; v_key text; v_n integer := 1;
BEGIN
  v_base := left(trim(both '_' from regexp_replace(lower(coalesce(p_label, '')), '[^a-z0-9]+', '_', 'g')), 36);
  IF v_base = '' OR v_base !~ '^[a-z]' THEN v_base := 'field_' || v_base; v_base := left(trim(both '_' from v_base), 36); END IF;
  v_key := v_base;
  WHILE EXISTS (SELECT 1 FROM public.custom_field_definitions WHERE organisation_id = p_org AND entity_type = p_entity AND key = v_key) LOOP
    v_n := v_n + 1;
    v_key := v_base || '_' || v_n;
  END LOOP;
  RETURN v_key;
END $$;

-- Create (p_id null) or change a field. p_field: label, fieldType, key (create only), helpText, section, requiredAt, options, decimals, unit,
-- min, max. Key and type never change; an option is never removed (switch it off instead).
CREATE FUNCTION app.save_custom_field(p_org uuid, p_entity text, p_field jsonb, p_id uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  d public.custom_field_definitions;
  v_type text;
  v_options jsonb;
  v_problem text;
  v_id uuid;
  v_label text := btrim(coalesce(p_field ->> 'label', ''));
  v_required text := coalesce(nullif(p_field ->> 'requiredAt', ''), 'never');
  v_lists boolean;
BEGIN
  IF NOT app.has_permission(p_org, 'custom_fields.manage') THEN
    RAISE EXCEPTION 'You are not allowed to manage custom fields' USING ERRCODE = '42501';
  END IF;
  IF NOT (p_entity = ANY (app.custom_field_entities())) THEN
    RAISE EXCEPTION 'Custom fields are not available on %', p_entity USING ERRCODE = 'QM023';
  END IF;
  IF p_id IS NOT NULL THEN
    SELECT * INTO d FROM public.custom_field_definitions WHERE id = p_id AND organisation_id = p_org AND entity_type = p_entity FOR UPDATE;
    IF d.id IS NULL THEN RAISE EXCEPTION 'Custom field not found' USING ERRCODE = 'P0002'; END IF;
    IF p_field ? 'fieldType' AND p_field ->> 'fieldType' IS DISTINCT FROM d.field_type THEN
      RAISE EXCEPTION 'The type of a custom field cannot change: retire it and add a new one' USING ERRCODE = 'QM023';
    END IF;
    IF p_field ? 'key' AND p_field ->> 'key' IS DISTINCT FROM d.key THEN
      RAISE EXCEPTION 'The key of a custom field cannot change' USING ERRCODE = 'QM023';
    END IF;
    v_type := d.field_type;
  ELSE
    v_type := p_field ->> 'fieldType';
    IF v_type IS NULL OR v_type NOT IN ('text', 'long_text', 'number', 'date', 'boolean', 'choice', 'multi_choice', 'person') THEN
      RAISE EXCEPTION 'Choose a type for the field' USING ERRCODE = 'QM023';
    END IF;
    IF (SELECT count(*) FROM public.custom_field_definitions WHERE organisation_id = p_org AND entity_type = p_entity AND active) >= 20 THEN
      RAISE EXCEPTION 'A kind of record can have at most 20 custom fields in use: retire one first' USING ERRCODE = 'QM023';
    END IF;
  END IF;
  IF length(v_label) NOT BETWEEN 1 AND 80 THEN RAISE EXCEPTION 'Give the field a label of up to 80 characters' USING ERRCODE = 'QM023'; END IF;
  IF NOT (v_required IN ('never', 'save') OR v_required = ANY (app.custom_field_stages(p_entity))) THEN
    RAISE EXCEPTION 'A field can be required when the record is saved, or at one of its stages' USING ERRCODE = 'QM023';
  END IF;
  v_lists := v_type IN ('choice', 'multi_choice');
  IF v_lists THEN
    v_options := coalesce(p_field -> 'options', CASE WHEN p_id IS NOT NULL THEN d.options END);
    v_problem := app.custom_field_options_problem(v_options);
    IF v_problem IS NOT NULL THEN RAISE EXCEPTION '%', v_problem USING ERRCODE = 'QM023'; END IF;
    IF p_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(d.options) o
      WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_options) n WHERE n ->> 'key' = o ->> 'key')) THEN
      RAISE EXCEPTION 'An option cannot be removed: switch it off instead' USING ERRCODE = 'QM023';
    END IF;
    SELECT jsonb_agg(jsonb_build_object('key', o ->> 'key', 'label', btrim(o ->> 'label'), 'active', coalesce((o ->> 'active')::boolean, true)))
      INTO v_options FROM jsonb_array_elements(v_options) o;
  ELSIF p_field ? 'options' AND jsonb_array_length(coalesce(p_field -> 'options', '[]'::jsonb)) > 0 THEN
    RAISE EXCEPTION 'Only list fields have options' USING ERRCODE = 'QM023';
  END IF;
  IF v_type <> 'number' AND (p_field ? 'decimals' OR p_field ? 'unit' OR p_field ? 'min' OR p_field ? 'max')
     AND (p_field ->> 'decimals' IS NOT NULL OR p_field ->> 'unit' IS NOT NULL OR p_field ->> 'min' IS NOT NULL OR p_field ->> 'max' IS NOT NULL) THEN
    RAISE EXCEPTION 'Only number fields have decimals, a unit and limits' USING ERRCODE = 'QM023';
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.custom_field_definitions (organisation_id, entity_type, key, label, field_type, help_text, section, position, required_at, options,
                                                 number_decimals, number_unit, number_min, number_max)
    VALUES (p_org, p_entity,
            CASE WHEN nullif(p_field ->> 'key', '') IS NOT NULL THEN p_field ->> 'key' ELSE app.custom_field_key_from(p_org, p_entity, v_label) END,
            v_label, v_type, nullif(btrim(p_field ->> 'helpText'), ''), nullif(btrim(p_field ->> 'section'), ''),
            coalesce((SELECT max(position) + 1 FROM public.custom_field_definitions WHERE organisation_id = p_org AND entity_type = p_entity), 1),
            v_required, CASE WHEN v_lists THEN v_options ELSE '[]'::jsonb END,
            CASE WHEN v_type = 'number' THEN (p_field ->> 'decimals')::integer END, CASE WHEN v_type = 'number' THEN nullif(btrim(p_field ->> 'unit'), '') END,
            CASE WHEN v_type = 'number' THEN (p_field ->> 'min')::numeric END, CASE WHEN v_type = 'number' THEN (p_field ->> 'max')::numeric END)
    RETURNING id INTO v_id;
    RETURN v_id;
  END IF;
  UPDATE public.custom_field_definitions SET
    label = v_label,
    help_text = CASE WHEN p_field ? 'helpText' THEN nullif(btrim(p_field ->> 'helpText'), '') ELSE help_text END,
    section = CASE WHEN p_field ? 'section' THEN nullif(btrim(p_field ->> 'section'), '') ELSE section END,
    required_at = v_required,
    options = CASE WHEN v_lists THEN v_options ELSE options END,
    number_decimals = CASE WHEN v_type = 'number' AND p_field ? 'decimals' THEN (p_field ->> 'decimals')::integer ELSE number_decimals END,
    number_unit = CASE WHEN v_type = 'number' AND p_field ? 'unit' THEN nullif(btrim(p_field ->> 'unit'), '') ELSE number_unit END,
    number_min = CASE WHEN v_type = 'number' AND p_field ? 'min' THEN (p_field ->> 'min')::numeric ELSE number_min END,
    number_max = CASE WHEN v_type = 'number' AND p_field ? 'max' THEN (p_field ->> 'max')::numeric ELSE number_max END,
    updated_by = auth.uid()
  WHERE id = p_id;
  RETURN p_id;
END $$;

CREATE FUNCTION app.retire_custom_field(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE d public.custom_field_definitions;
BEGIN
  SELECT * INTO d FROM public.custom_field_definitions WHERE id = p_id FOR UPDATE;
  IF d.id IS NULL OR NOT app.is_member(d.organisation_id) THEN RAISE EXCEPTION 'Custom field not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(d.organisation_id, 'custom_fields.manage') THEN
    RAISE EXCEPTION 'You are not allowed to manage custom fields' USING ERRCODE = '42501';
  END IF;
  IF NOT d.active THEN RAISE EXCEPTION 'This field is already retired' USING ERRCODE = 'QM023'; END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 3 THEN RAISE EXCEPTION 'Say why the field is retired' USING ERRCODE = 'QM023'; END IF;
  UPDATE public.custom_field_definitions SET active = false, retired_at = now(), retired_by = auth.uid(), retire_reason = btrim(p_reason), updated_by = auth.uid()
  WHERE id = p_id;
END $$;

CREATE FUNCTION app.reactivate_custom_field(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE d public.custom_field_definitions;
BEGIN
  SELECT * INTO d FROM public.custom_field_definitions WHERE id = p_id FOR UPDATE;
  IF d.id IS NULL OR NOT app.is_member(d.organisation_id) THEN RAISE EXCEPTION 'Custom field not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(d.organisation_id, 'custom_fields.manage') THEN
    RAISE EXCEPTION 'You are not allowed to manage custom fields' USING ERRCODE = '42501';
  END IF;
  IF d.active THEN RAISE EXCEPTION 'This field is in use already' USING ERRCODE = 'QM023'; END IF;
  IF (SELECT count(*) FROM public.custom_field_definitions WHERE organisation_id = d.organisation_id AND entity_type = d.entity_type AND active) >= 20 THEN
    RAISE EXCEPTION 'A kind of record can have at most 20 custom fields in use: retire one first' USING ERRCODE = 'QM023';
  END IF;
  UPDATE public.custom_field_definitions SET active = true, retired_at = NULL, retired_by = NULL, retire_reason = NULL, updated_by = auth.uid()
  WHERE id = p_id;
END $$;

-- The order fields are shown in: p_ids lists every field of the kind (active or retired) in the new order.
CREATE FUNCTION app.reorder_custom_fields(p_org uuid, p_entity text, p_ids uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT app.has_permission(p_org, 'custom_fields.manage') THEN
    RAISE EXCEPTION 'You are not allowed to manage custom fields' USING ERRCODE = '42501';
  END IF;
  IF (SELECT count(*) FROM public.custom_field_definitions WHERE organisation_id = p_org AND entity_type = p_entity) <> coalesce(array_length(p_ids, 1), 0)
     OR (SELECT count(*) FROM public.custom_field_definitions WHERE organisation_id = p_org AND entity_type = p_entity AND id = ANY (p_ids)) <> coalesce(array_length(p_ids, 1), 0) THEN
    RAISE EXCEPTION 'Give every field of this kind of record exactly once' USING ERRCODE = 'QM023';
  END IF;
  UPDATE public.custom_field_definitions d SET position = x.n, updated_by = auth.uid()
  FROM unnest(p_ids) WITH ORDINALITY AS x(id, n)
  WHERE d.id = x.id AND d.position IS DISTINCT FROM x.n::integer;
END $$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app.custom_field_record(text, uuid), app.custom_field_value(public.custom_field_definitions, jsonb, jsonb),
  app.write_custom_values(text, uuid, uuid, jsonb), app.write_custom_values_dry(text, uuid, uuid, jsonb),
  app.custom_values_missing(text, uuid, uuid, text), app.custom_values_required_on_create(), app.custom_values_stage_check(),
  app.custom_field_key_from(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.save_custom_field(uuid, text, jsonb, uuid), app.retire_custom_field(uuid, text), app.reactivate_custom_field(uuid),
  app.reorder_custom_fields(uuid, text, uuid[]), app.set_custom_values(text, uuid, jsonb), app.get_custom_values(text, uuid),
  app.custom_values_readable(uuid, text), app.custom_values_writable(uuid, text), app.custom_field_options_problem(jsonb),
  app.custom_field_entities(), app.custom_field_stages(text), app.custom_field_definition_guard() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.save_custom_field(uuid, text, jsonb, uuid), app.retire_custom_field(uuid, text), app.reactivate_custom_field(uuid),
  app.reorder_custom_fields(uuid, text, uuid[]), app.set_custom_values(text, uuid, jsonb), app.get_custom_values(text, uuid),
  app.custom_values_readable(uuid, text), app.custom_values_writable(uuid, text), app.custom_field_options_problem(jsonb),
  app.custom_field_entities(), app.custom_field_stages(text) TO authenticated;
