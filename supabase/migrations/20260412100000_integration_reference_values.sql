-- The values a link to another record can take, for the import mapping screen: the codes that exist in Fortress (with their names) so a person can see
-- what is allowed, and a check of values against them as the mapping is built. Reading only; needs `integrations.read` (a Controller seat).
-- Written as functions rather than reads of the tables because the person mapping a file may hold integrations rights but no right to read parts,
-- employees or machines; what they see is what they could link to anyway (a code and a name), never other columns.

CREATE FUNCTION app.integration_reference_values(p_org uuid, p_kind text, p_search text DEFAULT NULL, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_q text := nullif(btrim(p_search), '');
  v_pat text;
  v_lim integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_off integer := greatest(coalesce(p_offset, 0), 0);
  v_total integer;
  v_data jsonb;
BEGIN
  IF NOT app.is_member(p_org) THEN RAISE EXCEPTION 'Organisation not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(p_org, 'integrations.read') THEN RAISE EXCEPTION 'You are not allowed to do that with integrations' USING ERRCODE = '42501'; END IF;
  IF p_kind NOT IN ('site', 'department', 'unit', 'category', 'supplier', 'customer', 'part', 'machine', 'employee', 'gauge_type') THEN
    RAISE EXCEPTION 'There is no list of values for that kind of record' USING ERRCODE = 'QM022';
  END IF;
  v_pat := CASE WHEN v_q IS NULL THEN '%' ELSE '%' || replace(replace(replace(lower(v_q), '\', '\\'), '%', '\%'), '_', '\_') || '%' END;

  WITH items AS (
    SELECT x.code, x.name, x.hint, x.active, x.duplicate FROM (
      SELECT s.code, s.name, NULL::text AS hint, s.active, false AS duplicate FROM public.sites s WHERE p_kind = 'site' AND s.organisation_id = p_org
      UNION ALL
      SELECT d.code, d.name, st.code, d.active, count(*) OVER (PARTITION BY upper(d.code)) > 1
        FROM public.departments d JOIN public.sites st ON st.id = d.site_id WHERE p_kind = 'department' AND d.organisation_id = p_org
      UNION ALL SELECT u.code, u.name, NULL, true, false FROM public.units u WHERE p_kind = 'unit'
      UNION ALL SELECT c.code, c.name, NULL, c.active, false FROM public.ncr_classifications c WHERE p_kind = 'category' AND c.kind = 'category' AND c.organisation_id = p_org
      UNION ALL SELECT s.code, s.name, NULL, s.active, false FROM public.suppliers s WHERE p_kind = 'supplier' AND s.organisation_id = p_org
      UNION ALL SELECT c.code, c.name, NULL, c.active, false FROM public.customers c WHERE p_kind = 'customer' AND c.organisation_id = p_org
      UNION ALL SELECT p.part_number, p.name, NULL, p.active, false FROM public.parts p WHERE p_kind = 'part' AND p.organisation_id = p_org
      UNION ALL SELECT m.code, m.name, NULL, m.active, false FROM public.machines m WHERE p_kind = 'machine' AND m.organisation_id = p_org
      UNION ALL SELECT e.employee_number, btrim(coalesce(e.first_name, '') || ' ' || coalesce(e.surname, '')), e.job_title, e.active, false
        FROM public."Employees" e WHERE p_kind = 'employee' AND e.organisation_id = p_org AND e.employee_number IS NOT NULL
      UNION ALL SELECT g.code, g.name, NULL, g.active, false FROM public.gauge_types g WHERE p_kind = 'gauge_type' AND g.organisation_id = p_org
    ) x
    WHERE v_q IS NULL OR lower(coalesce(x.code, '')) LIKE v_pat ESCAPE '\' OR lower(coalesce(x.name, '')) LIKE v_pat ESCAPE '\'
  ), page AS (
    SELECT i.*, row_number() OVER (ORDER BY lower(i.code), i.name) AS ord FROM items i ORDER BY lower(i.code), i.name LIMIT v_lim OFFSET v_off
  )
  SELECT (SELECT count(*) FROM items),
         coalesce((SELECT jsonb_agg(jsonb_build_object('code', t.code, 'name', t.name, 'hint', t.hint, 'active', t.active, 'duplicate', t.duplicate) ORDER BY t.ord) FROM page t), '[]'::jsonb)
    INTO v_total, v_data;
  RETURN jsonb_build_object('total', v_total, 'data', v_data);
END $$;

-- Which of these values exist: {value: id} for those found ("ambiguous" for a department code used twice). By the Fortress code, or, for kinds that can be
-- imported, by the id the source gave the record when it was imported through the named connection.
CREATE FUNCTION app.integration_reference_check(p_org uuid, p_kind text, p_mode text, p_connection uuid, p_values text[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_out jsonb := '{}'::jsonb; v text; v_id uuid; v_unit text;
BEGIN
  IF NOT app.is_member(p_org) THEN RAISE EXCEPTION 'Organisation not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(p_org, 'integrations.read') THEN RAISE EXCEPTION 'You are not allowed to do that with integrations' USING ERRCODE = '42501'; END IF;
  IF p_mode NOT IN ('source', 'code') THEN RAISE EXCEPTION 'A reference is matched by the source id or by the Fortress code' USING ERRCODE = 'QM022'; END IF;
  IF cardinality(coalesce(p_values, '{}')) > 2000 THEN RAISE EXCEPTION 'Too many values to check at once' USING ERRCODE = 'QM022'; END IF;
  IF p_mode = 'source' THEN
    IF p_connection IS NULL OR NOT EXISTS (SELECT 1 FROM public.integration_connections c WHERE c.id = p_connection AND c.organisation_id = p_org) THEN
      RAISE EXCEPTION 'Connection not found' USING ERRCODE = 'P0002';
    END IF;
    PERFORM app.integration_assert_entity(p_kind);
    SELECT coalesce(jsonb_object_agg(x.external_id, x.internal_id), '{}'::jsonb) INTO v_out
      FROM public.integration_external_records x
     WHERE x.organisation_id = p_org AND x.connection_id = p_connection AND x.entity_type = p_kind AND x.external_id = ANY (p_values);
    RETURN v_out;
  END IF;
  FOREACH v IN ARRAY coalesce(p_values, '{}') LOOP
    IF p_kind = 'unit' THEN
      SELECT code INTO v_unit FROM public.units WHERE lower(code) = lower(btrim(v));
      IF v_unit IS NOT NULL THEN v_out := v_out || jsonb_build_object(v, v_unit); END IF;
      v_unit := NULL;
    ELSE
      v_id := app.integration_find_by_code(p_org, p_kind, v);
      IF v_id IS NOT NULL THEN v_out := v_out || jsonb_build_object(v, v_id);
      ELSIF p_kind = 'department' AND (SELECT count(*) FROM public.departments WHERE organisation_id = p_org AND upper(code) = upper(btrim(v))) > 1 THEN
        v_out := v_out || jsonb_build_object(v, 'ambiguous');
      END IF;
    END IF;
  END LOOP;
  RETURN v_out;
END $$;

REVOKE ALL ON FUNCTION app.integration_reference_values(uuid, text, text, integer, integer), app.integration_reference_check(uuid, text, text, uuid, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.integration_reference_values(uuid, text, text, integer, integer), app.integration_reference_check(uuid, text, text, uuid, text[]) TO authenticated;
