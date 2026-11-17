-- Edit conflicts, more records (docs/edit-conflicts-plan.md §8): the More details card (custom_field_values) and action lines.
--
-- Action lines (capa_actions, risk_actions, management_review_actions, ncr_containment_actions) already carry the check: touch_updated runs on
-- them and they are keyed by id. custom_field_values is keyed by record_id (one row per record), so the check never found its row, and all of a
-- record's custom fields live in one jsonb column, so "values changed" would make every save clash. This migration:
--
--  * keys a row by id, else record_id, in app.assert_edit_version and app.edit_conflict_details;
--  * reports a custom values change per field ("values.<field key>": only the keys whose value changed), so two people filling in different
--    custom fields of one record are merged, and only the same field is asked about.
--
-- Nothing else changes; no table, column or grant is added.

CREATE OR REPLACE FUNCTION app.assert_edit_version(p_table text, p_old jsonb) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_raw text := current_setting('app.expected_versions', true);
  v_id text := coalesce(p_old ->> 'id', p_old ->> 'record_id');
  v_expected jsonb;
  v_key text;
  v_current text;
BEGIN
  IF v_raw IS NULL OR v_raw = '' OR v_id IS NULL THEN
    RETURN;
  END IF;
  v_expected := v_raw::jsonb;
  v_key := p_table || ':' || v_id;
  IF NOT v_expected ? v_key THEN
    RETURN;
  END IF;
  v_current := app.row_version((p_old ->> 'updated_at')::timestamptz);
  IF v_current IS DISTINCT FROM v_expected ->> v_key THEN
    RAISE EXCEPTION 'Someone else changed this since you opened it'
      USING ERRCODE = 'QM031',
            DETAIL = json_build_object('table', p_table, 'id', v_id, 'version', v_current, 'expected', v_expected ->> v_key)::text;
  END IF;
  -- checked once per request: later updates of the same row in this transaction are the request's own
  PERFORM set_config('app.expected_versions', (v_expected - v_key)::text, true);
END $$;

CREATE OR REPLACE FUNCTION app.edit_conflict_details(p_table text, p_id uuid, p_since text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_rel regclass;
  v_key text;
  v_org uuid;
  v_at timestamptz;
  v_by uuid;
  v_since timestamptz;
  v_fields text[];
  v_people jsonb;
BEGIN
  v_rel := to_regclass('public.' || quote_ident(p_table));
  IF v_rel IS NULL OR NOT EXISTS (
       SELECT 1 FROM pg_trigger g
        WHERE g.tgrelid = v_rel AND NOT g.tgisinternal
          AND g.tgfoid IN ('app.touch_updated()'::regprocedure, 'app.check_edit_version()'::regprocedure)) THEN
    RAISE EXCEPTION 'Record not found' USING ERRCODE = 'P0002';
  END IF;
  -- the row's key: id, or record_id for one-row-per-record tables (custom_field_values)
  v_key := CASE WHEN EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = v_rel AND a.attname = 'id' AND NOT a.attisdropped) THEN 'id' ELSE 'record_id' END;
  EXECUTE format('SELECT organisation_id, updated_at, updated_by FROM %s WHERE %I = $1', v_rel, v_key) INTO v_org, v_at, v_by USING p_id;
  IF v_org IS NULL OR NOT app.is_member(v_org) THEN
    RAISE EXCEPTION 'Record not found' USING ERRCODE = 'P0002';
  END IF;

  v_since := CASE WHEN p_since ~ '^[0-9]{1,20}$' THEN to_timestamp(p_since::numeric / 1000000) END;

  SELECT coalesce(array_agg(DISTINCT x.name ORDER BY x.name), '{}'),
         coalesce(jsonb_agg(DISTINCT jsonb_build_object('id', e.actor_user_id)) FILTER (WHERE e.actor_user_id IS NOT NULL), '[]')
    INTO v_fields, v_people
    FROM audit.events e
    CROSS JOIN LATERAL (
      SELECT f AS name
        FROM unnest(coalesce(e.changed_fields, '{}')) f
       WHERE f NOT IN ('updated_at', 'updated_by')
         AND NOT (p_table = 'custom_field_values' AND f = 'values')
      UNION ALL
      -- custom fields: each field whose value changed, as "values.<key>"
      SELECT 'values.' || k
        FROM jsonb_object_keys(
               CASE WHEN jsonb_typeof(e.previous_values -> 'values') = 'object' THEN e.previous_values -> 'values' ELSE '{}'::jsonb END
               || CASE WHEN jsonb_typeof(e.new_values -> 'values') = 'object' THEN e.new_values -> 'values' ELSE '{}'::jsonb END) k
       WHERE p_table = 'custom_field_values'
         AND 'values' = ANY (coalesce(e.changed_fields, '{}'))
         AND (e.previous_values -> 'values' -> k) IS DISTINCT FROM (e.new_values -> 'values' -> k)
    ) x
   WHERE e.organisation_id = v_org
     AND e.entity_type = p_table
     AND e.entity_id = p_id::text
     AND e.action = 'update'
     AND (v_since IS NULL OR e.created_at > v_since);

  RETURN jsonb_build_object(
    'version', app.row_version(v_at),
    'changedAt', v_at,
    'changedBy', CASE WHEN v_by IS NULL THEN NULL ELSE (
      SELECT jsonb_build_object('id', p.id, 'name', nullif(btrim(concat_ws(' ', p.first_name, p.surname)), ''))
        FROM public.profiles p WHERE p.id = v_by) END,
    'fields', to_jsonb(v_fields),
    'people', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', nullif(btrim(concat_ws(' ', p.first_name, p.surname)), ''))), '[]')
                 FROM public.profiles p WHERE p.id IN (SELECT (x ->> 'id')::uuid FROM jsonb_array_elements(v_people) x)));
END $$;
