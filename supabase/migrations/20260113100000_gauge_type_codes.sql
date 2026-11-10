-- Gauge type codes: a short code that identifies a gauge type in the app, in imports and in links from other records, instead of its uuid or its name.
--  * gauge_types.code: required, no spaces at either end, up to 40 characters (the same rule as machine codes), unique per organisation ignoring case,
--    editable by calibration.manage like the name.
--  * Existing gauge types get a code made from their name (capitals, anything else becomes "-"; a number is added when two names make the same code).
--    The backfill runs with the row triggers off: it is not a person's change and would otherwise stamp and notify.
--  * An insert that gives no code gets one made the same way (older callers, seeds and tests keep working); the app always asks for one.
--  * Imports: a gauge type is matched by its code (then, for files made before codes, by its name); the importer writes the code.

-- Make a free code for a gauge type from its name.
CREATE FUNCTION app.gauge_type_code_from_name(p_org uuid, p_name text, p_except uuid DEFAULT NULL) RETURNS text
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE v_base text; v_code text; v_n integer := 1;
BEGIN
  v_base := left(trim(both '-' from upper(regexp_replace(btrim(coalesce(p_name, '')), '[^A-Za-z0-9]+', '-', 'g'))), 36);
  IF v_base = '' THEN v_base := 'TYPE'; END IF;
  v_code := v_base;
  WHILE EXISTS (SELECT 1 FROM public.gauge_types t WHERE t.organisation_id = p_org AND upper(t.code) = v_code AND t.id IS DISTINCT FROM p_except) LOOP
    v_n := v_n + 1;
    v_code := v_base || '-' || v_n;
  END LOOP;
  RETURN v_code;
END $$;

ALTER TABLE public.gauge_types ADD COLUMN code text;

ALTER TABLE public.gauge_types DISABLE TRIGGER USER;
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT id, organisation_id, name FROM public.gauge_types ORDER BY organisation_id, created_at, id LOOP
    UPDATE public.gauge_types SET code = app.gauge_type_code_from_name(t.organisation_id, t.name, t.id) WHERE id = t.id;
  END LOOP;
END $$;
ALTER TABLE public.gauge_types ENABLE TRIGGER USER;

ALTER TABLE public.gauge_types ALTER COLUMN code SET NOT NULL;
ALTER TABLE public.gauge_types ADD CONSTRAINT gauge_types_code_check CHECK (code ~ '^\S(.{0,38}\S)?$');
CREATE UNIQUE INDEX gauge_types_org_code_key ON public.gauge_types (organisation_id, upper(code));
COMMENT ON COLUMN public.gauge_types.code IS 'Identifies the gauge type in the app and in imports; unique per organisation ignoring case';

-- An insert without a code gets one made from the name.
CREATE FUNCTION app.gauge_type_default_code() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  NEW.code := nullif(btrim(NEW.code), '');
  IF NEW.code IS NULL THEN NEW.code := app.gauge_type_code_from_name(NEW.organisation_id, NEW.name); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER gauge_types_default_code BEFORE INSERT ON public.gauge_types FOR EACH ROW EXECUTE FUNCTION app.gauge_type_default_code();

GRANT UPDATE (code) ON public.gauge_types TO authenticated;
REVOKE ALL ON FUNCTION app.gauge_type_code_from_name(uuid, text, uuid), app.gauge_type_default_code() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.gauge_type_code_from_name(uuid, text, uuid), app.gauge_type_default_code() TO authenticated;

-- ---------------------------------------------------------------------------
-- Imports: match and write gauge types by code
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.integration_find_by_code(p_org uuid, p_kind text, p_code text) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid; v_code text := nullif(btrim(p_code), '');
BEGIN
  IF v_code IS NULL THEN RETURN NULL; END IF;
  CASE p_kind
    WHEN 'supplier' THEN SELECT id INTO v_id FROM public.suppliers WHERE organisation_id = p_org AND upper(code) = upper(v_code);
    WHEN 'customer' THEN SELECT id INTO v_id FROM public.customers WHERE organisation_id = p_org AND upper(code) = upper(v_code);
    WHEN 'part' THEN SELECT id INTO v_id FROM public.parts WHERE organisation_id = p_org AND upper(part_number) = upper(v_code);
    WHEN 'machine' THEN SELECT id INTO v_id FROM public.machines WHERE organisation_id = p_org AND upper(code) = upper(v_code);
    WHEN 'employee' THEN SELECT id INTO v_id FROM public."Employees" WHERE organisation_id = p_org AND upper(employee_number) = upper(v_code);
    WHEN 'gauge_type' THEN
      SELECT id INTO v_id FROM public.gauge_types WHERE organisation_id = p_org AND upper(code) = upper(v_code);
      -- Files written before gauge types had codes named them by name.
      IF v_id IS NULL THEN SELECT id INTO v_id FROM public.gauge_types WHERE organisation_id = p_org AND upper(name) = upper(v_code); END IF;
    WHEN 'gauge' THEN SELECT id INTO v_id FROM public.gauges WHERE organisation_id = p_org AND upper(asset_number) = upper(v_code) AND deleted_at IS NULL;
    WHEN 'site' THEN SELECT id INTO v_id FROM public.sites WHERE organisation_id = p_org AND upper(code) = upper(v_code);
    WHEN 'department' THEN
      IF (SELECT count(*) FROM public.departments WHERE organisation_id = p_org AND upper(code) = upper(v_code)) = 1 THEN
        SELECT id INTO v_id FROM public.departments WHERE organisation_id = p_org AND upper(code) = upper(v_code);
      END IF;
    WHEN 'category' THEN SELECT id INTO v_id FROM public.ncr_classifications WHERE organisation_id = p_org AND kind = 'category' AND upper(code) = upper(v_code);
    ELSE RETURN NULL;
  END CASE;
  RETURN v_id;
EXCEPTION WHEN too_many_rows THEN RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION app.integration_record_code(p_entity text, p_data jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT nullif(btrim(CASE p_entity
    WHEN 'supplier' THEN p_data ->> 'code' WHEN 'customer' THEN p_data ->> 'code' WHEN 'machine' THEN p_data ->> 'code'
    WHEN 'part' THEN p_data ->> 'partNumber' WHEN 'employee' THEN p_data ->> 'employeeNumber'
    WHEN 'gauge_type' THEN coalesce(p_data ->> 'code', p_data ->> 'name') WHEN 'gauge' THEN p_data ->> 'assetNumber' END), '')
$$;

CREATE OR REPLACE FUNCTION app.import_gauge_type(p_org uuid, p_id uuid, d jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid;
BEGIN
  IF p_id IS NULL THEN
    INSERT INTO public.gauge_types (organisation_id, code, name, description, interval_value, interval_unit, active)
    VALUES (p_org, app.imp_text(d, 'code'), app.imp_text(d, 'name'), app.imp_text(d, 'description'), coalesce(app.imp_int(d, 'intervalValue'), 12),
            coalesce(app.imp_text(d, 'intervalUnit'), 'months'), coalesce(app.imp_bool(d, 'active'), true))
    RETURNING id INTO v_id;
    RETURN v_id;
  END IF;
  UPDATE public.gauge_types SET
    code = CASE WHEN d ? 'code' THEN coalesce(app.imp_text(d, 'code'), code) ELSE code END,
    name = CASE WHEN d ? 'name' THEN app.imp_text(d, 'name') ELSE name END,
    description = CASE WHEN d ? 'description' THEN app.imp_text(d, 'description') ELSE description END,
    interval_value = CASE WHEN d ? 'intervalValue' THEN coalesce(app.imp_int(d, 'intervalValue'), interval_value) ELSE interval_value END,
    interval_unit = CASE WHEN d ? 'intervalUnit' THEN coalesce(app.imp_text(d, 'intervalUnit'), interval_unit) ELSE interval_unit END,
    active = CASE WHEN d ? 'active' THEN coalesce(app.imp_bool(d, 'active'), active) ELSE active END,
    updated_at = now(), updated_by = auth.uid()
  WHERE id = p_id AND organisation_id = p_org RETURNING id INTO v_id;
  IF v_id IS NULL THEN RAISE EXCEPTION 'The gauge type this record was linked to no longer exists' USING ERRCODE = 'QM022'; END IF;
  RETURN v_id;
END $$;
