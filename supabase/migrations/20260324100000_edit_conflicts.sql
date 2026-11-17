-- Edit conflicts EC1 (docs/edit-conflicts-plan.md, decisions EC-D1–EC-D6 agreed 2026-11-17): a save may say which version of the record it was based
-- on, and the database refuses it when the record has been changed since.
--
--  * The version is updated_at to the microsecond, as text (app.row_version). Nothing new is stored.
--  * The API puts the versions a request was based on in the transaction setting app.expected_versions, a JSON object
--    { "<table>:<id>": "<version>" }. app.touch_updated() (which already runs before every update of an edited table) looks its row up there:
--    a different current version raises QM031; a match removes the entry, so further updates of the same row in the same request (stage
--    recomputes, triggers) are not mistaken for conflicts. The check runs inside the update, which holds the row lock, so two saves can never
--    both pass, whether the update is made under RLS or inside a SECURITY DEFINER function.
--  * No setting = as before (last write wins): imports, the worker and scripts are unchanged.
--  * app.edit_conflict_details(table, id, since) says what changed since a version (fields, who, when) from the audit trail, for a member of the
--    record's organisation.

-- ---------------------------------------------------------------------------
-- The version
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.row_version(p_at timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN p_at IS NULL THEN '0' ELSE (extract(epoch FROM p_at) * 1000000)::bigint::text END
$$;
GRANT EXECUTE ON FUNCTION app.row_version(timestamptz) TO authenticated;

-- ---------------------------------------------------------------------------
-- The check, shared by touch_updated and the two tables that set updated_at themselves
-- ---------------------------------------------------------------------------
-- Called with the row as it was before the update. Raises QM031 when the request said it was based on another version of this row.
CREATE FUNCTION app.assert_edit_version(p_table text, p_old jsonb) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_raw text := current_setting('app.expected_versions', true);
  v_expected jsonb;
  v_key text;
  v_current text;
BEGIN
  IF v_raw IS NULL OR v_raw = '' OR p_old ->> 'id' IS NULL THEN
    RETURN;
  END IF;
  v_expected := v_raw::jsonb;
  v_key := p_table || ':' || (p_old ->> 'id');
  IF NOT v_expected ? v_key THEN
    RETURN;
  END IF;
  v_current := app.row_version((p_old ->> 'updated_at')::timestamptz);
  IF v_current IS DISTINCT FROM v_expected ->> v_key THEN
    RAISE EXCEPTION 'Someone else changed this since you opened it'
      USING ERRCODE = 'QM031',
            DETAIL = json_build_object('table', p_table, 'id', p_old ->> 'id', 'version', v_current, 'expected', v_expected ->> v_key)::text;
  END IF;
  -- checked once per request: later updates of the same row in this transaction are the request's own
  PERFORM set_config('app.expected_versions', (v_expected - v_key)::text, true);
END $$;

-- Replaces 20251103100000: the same bookkeeping, plus the check.
CREATE OR REPLACE FUNCTION app.touch_updated() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  PERFORM app.assert_edit_version(TG_TABLE_NAME, to_jsonb(OLD));
  NEW.updated_at := now();
  NEW.updated_by := auth.uid();
  RETURN NEW;
END $$;

-- integration_connections and workflow_rules keep their own updated_at (set by their functions); they get the check alone.
CREATE FUNCTION app.check_edit_version() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  PERFORM app.assert_edit_version(TG_TABLE_NAME, to_jsonb(OLD));
  RETURN NEW;
END $$;

CREATE TRIGGER integration_connections_edit_version BEFORE UPDATE ON public.integration_connections
  FOR EACH ROW EXECUTE FUNCTION app.check_edit_version();
CREATE TRIGGER workflow_rules_edit_version BEFORE UPDATE ON public.workflow_rules
  FOR EACH ROW EXECUTE FUNCTION app.check_edit_version();

-- ---------------------------------------------------------------------------
-- What changed since a version
-- ---------------------------------------------------------------------------
-- For the conflict answer: the record's current version, who changed it last and when, and every field changed by anyone since p_since
-- (bookkeeping columns left out). Only tables that carry the check, only a row of an organisation the caller belongs to; anything else is
-- P0002, so it never tells someone outside the organisation that a record exists.
CREATE FUNCTION app.edit_conflict_details(p_table text, p_id uuid, p_since text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_rel regclass;
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
  EXECUTE format('SELECT organisation_id, updated_at, updated_by FROM %s WHERE id = $1', v_rel) INTO v_org, v_at, v_by USING p_id;
  IF v_org IS NULL OR NOT app.is_member(v_org) THEN
    RAISE EXCEPTION 'Record not found' USING ERRCODE = 'P0002';
  END IF;

  v_since := CASE WHEN p_since ~ '^[0-9]{1,20}$' THEN to_timestamp(p_since::numeric / 1000000) END;

  SELECT coalesce(array_agg(DISTINCT f ORDER BY f), '{}'),
         coalesce(jsonb_agg(DISTINCT jsonb_build_object('id', e.actor_user_id)) FILTER (WHERE e.actor_user_id IS NOT NULL), '[]')
    INTO v_fields, v_people
    FROM audit.events e
    CROSS JOIN LATERAL unnest(coalesce(e.changed_fields, '{}')) f
   WHERE e.organisation_id = v_org
     AND e.entity_type = p_table
     AND e.entity_id = p_id::text
     AND e.action = 'update'
     AND (v_since IS NULL OR e.created_at > v_since)
     AND f NOT IN ('updated_at', 'updated_by');

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

-- The check runs as whoever updates the row (touch_updated is not SECURITY DEFINER), so everyone who updates edited tables may run it.
REVOKE ALL ON FUNCTION app.edit_conflict_details(text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.edit_conflict_details(text, uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION app.assert_edit_version(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.assert_edit_version(text, jsonb) TO authenticated;
REVOKE ALL ON FUNCTION app.row_version(timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION app.check_edit_version() FROM PUBLIC, anon;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qms_api') THEN
    GRANT EXECUTE ON FUNCTION app.assert_edit_version(text, jsonb) TO qms_api;
    GRANT EXECUTE ON FUNCTION app.row_version(timestamptz) TO qms_api;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION app.assert_edit_version(text, jsonb) TO service_role;
    GRANT EXECUTE ON FUNCTION app.row_version(timestamptz) TO service_role;
  END IF;
END $$;
