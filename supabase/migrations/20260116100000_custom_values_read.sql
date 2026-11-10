-- Custom fields CF2: reading one record's custom values through a function, so the API can answer 404 for a record the caller may not read
-- (instead of an empty set of values). Read-only; changes no data.

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

REVOKE ALL ON FUNCTION app.get_custom_values(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.get_custom_values(text, uuid) TO authenticated;
