-- Integrations IN5 (docs/connectors-plan.md §6.5, §7): production orders can be imported, and field ownership is acted on.
--
-- 1. Production orders. `app.import_production_order` writes an order through the table and its rules as the person who started the run. A new order
--    keeps the status the source gives it (mapped to ours by the template) and the reserved `external_system` / `external_id` are filled from the
--    connection and the key column; people still cannot set either (the rules trigger lets only an import, inside its own call, keep them). On an
--    update the status moves along the allowed transitions one step at a time (planned → released → in progress → completed → closed), so every rule
--    still applies (an order with open operations cannot complete; a closed or cancelled order cannot change; cancelling needs a reason).
-- 2. Field ownership on an update (the mapping or template version the run used, frozen):
--      source_wins   — the import writes it (the default; as before);
--      qms_wins      — set when the record is created, never again by an import ("Fortress wins");
--      manual_review — a value that would change the record is not written: it is parked in `integration_conflicts` for a person to accept
--                      (the value is written then, by them) or reject (Fortress keeps its value, with a reason). A value that agrees with the record
--                      clears any open one. A value already rejected is not parked again until it changes.
--    The database enforces it (`app.system_import_record`), so a mistake in the API can never overwrite a field Fortress owns.
-- 3. The review queue: `integration_conflicts` (functions only, audited, read with integrations.read), `app.decide_integration_conflict`.

-- ---------------------------------------------------------------------------
-- Production orders: one list of status moves, and the import's way past "people cannot set the status or the external id on insert"
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.production_order_transitions() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT ARRAY['planned>released', 'planned>cancelled', 'released>planned', 'released>in_progress', 'released>cancelled',
               'in_progress>completed', 'in_progress>cancelled', 'completed>closed', 'completed>in_progress']
$$;

-- The shortest way from one status to another along the allowed moves (empty when they are the same, null when there is none).
CREATE FUNCTION app.production_order_status_path(p_from text, p_to text) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  WITH RECURSIVE e AS (
    SELECT split_part(t, '>', 1) AS a, split_part(t, '>', 2) AS b FROM unnest(app.production_order_transitions()) t
  ), p (node, path) AS (
    SELECT p_from, ARRAY[]::text[]
    UNION ALL
    SELECT e.b, p.path || e.b FROM p JOIN e ON e.a = p.node
     WHERE e.b <> p_from AND NOT (e.b = ANY (p.path)) AND cardinality(p.path) < 6
  )
  SELECT CASE WHEN p_from = p_to THEN ARRAY[]::text[] ELSE (SELECT path FROM p WHERE node = p_to ORDER BY cardinality(path) LIMIT 1) END
$$;

CREATE OR REPLACE FUNCTION app.production_order_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  user_change boolean := coalesce(auth.role(), '') = 'authenticated';
  -- Set only inside app.import_production_order, for its own insert.
  importing boolean := coalesce(current_setting('app.integration_import', true), '') = 'on';
  v_open text;
BEGIN
  IF NEW.part_revision_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.part_revisions r WHERE r.id = NEW.part_revision_id AND r.part_id = NEW.part_id) THEN
    RAISE EXCEPTION 'The revision does not belong to the order''s part' USING ERRCODE = 'QM017';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF user_change AND NOT importing THEN
      NEW.status := 'planned'; NEW.status_reason := NULL;
      NEW.external_system := NULL; NEW.external_id := NULL;
    END IF;
    RETURN NEW;
  END IF;
  IF NOT user_change THEN
    RETURN NEW;
  END IF;
  IF OLD.status IN ('closed', 'cancelled') THEN
    IF (to_jsonb(NEW) - ARRAY['updated_at', 'updated_by']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['updated_at', 'updated_by']) THEN
      RAISE EXCEPTION 'Order % is %; it can no longer be changed', OLD.order_number, OLD.status USING ERRCODE = 'QM017';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status <> OLD.status THEN
    IF NOT ((OLD.status || '>' || NEW.status) = ANY (app.production_order_transitions())) THEN
      RAISE EXCEPTION 'An order that is % cannot become %', replace(OLD.status, '_', ' '), replace(NEW.status, '_', ' ') USING ERRCODE = 'QM017';
    END IF;
    IF NEW.status = 'cancelled' THEN
      IF length(trim(coalesce(NEW.status_reason, ''))) = 0 THEN
        RAISE EXCEPTION 'Give a reason for cancelling the order' USING ERRCODE = 'QM017';
      END IF;
    ELSE
      NEW.status_reason := NULL;
    END IF;
    IF NEW.status = 'completed' THEN
      SELECT string_agg(operation_code, ', ' ORDER BY sequence) INTO v_open
        FROM public.production_operations WHERE production_order_id = NEW.id AND status IN ('pending', 'in_progress');
      IF v_open IS NOT NULL THEN
        RAISE EXCEPTION 'Complete or skip every operation first; still open: %', v_open USING ERRCODE = 'QM017';
      END IF;
    END IF;
  ELSIF NEW.status_reason IS DISTINCT FROM OLD.status_reason THEN
    RAISE EXCEPTION 'The reason is given with the status' USING ERRCODE = 'QM017';
  END IF;
  RETURN NEW;
END $$;

-- The part revision an order names: the revision letter of that part (any case), the released version first, else the latest.
CREATE FUNCTION app.production_import_revision(p_part uuid, p_rev text) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid;
BEGIN
  IF nullif(btrim(p_rev), '') IS NULL THEN RETURN NULL; END IF;
  SELECT id INTO v_id FROM public.part_revisions
   WHERE part_id = p_part AND upper(revision) = upper(btrim(p_rev))
   ORDER BY (status = 'released') DESC, version DESC LIMIT 1;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'The part has no revision % in Fortress', btrim(p_rev) USING ERRCODE = 'QM022';
  END IF;
  RETURN v_id;
END $$;

CREATE FUNCTION app.import_production_order(p_org uuid, p_id uuid, d jsonb, p_system text DEFAULT NULL, p_external text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  o public.production_orders%ROWTYPE; v_id uuid; v_part uuid; v_rev uuid; v_status text := lower(app.imp_text(d, 'status'));
  v_path text[]; v_step text; v_reason text := app.imp_text(d, 'statusReason');
BEGIN
  IF v_status IS NOT NULL AND v_status NOT IN ('planned', 'released', 'in_progress', 'completed', 'closed', 'cancelled') THEN
    RAISE EXCEPTION 'Status: "%" is not one of planned, released, in progress, completed, closed or cancelled', v_status USING ERRCODE = 'QM022';
  END IF;
  IF p_id IS NULL THEN
    v_part := app.imp_ref(d, 'part');
    v_rev := app.production_import_revision(v_part, app.imp_text(d, 'partRevision'));
    PERFORM set_config('app.integration_import', 'on', true);
    INSERT INTO public.production_orders (organisation_id, order_number, part_id, part_revision_id, customer_id, site_id, quantity_planned, due_date,
                                          status, status_reason, notes, external_system, external_id)
    VALUES (p_org, app.imp_text(d, 'orderNumber'), v_part, v_rev, app.imp_ref(d, 'customer'), app.imp_ref(d, 'site'), app.imp_num(d, 'quantityPlanned'),
            app.imp_date(d, 'dueDate'), coalesce(v_status, 'planned'),
            CASE WHEN v_status = 'cancelled' THEN coalesce(v_reason, 'Cancelled in the source system') END,
            app.imp_text(d, 'notes'), p_system, CASE WHEN p_system IS NOT NULL THEN p_external END)
    RETURNING id INTO v_id;
    PERFORM set_config('app.integration_import', '', true);
    RETURN v_id;
  END IF;

  SELECT * INTO o FROM public.production_orders WHERE id = p_id AND organisation_id = p_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'The production order this record was linked to no longer exists' USING ERRCODE = 'QM022'; END IF;
  v_part := CASE WHEN d ? 'part' THEN coalesce(app.imp_ref(d, 'part'), o.part_id) ELSE o.part_id END;
  v_rev := CASE
    WHEN d ? 'partRevision' THEN app.production_import_revision(v_part, app.imp_text(d, 'partRevision'))
    WHEN v_part IS DISTINCT FROM o.part_id THEN NULL   -- another part: the old part's revision cannot stay
    ELSE o.part_revision_id END;
  UPDATE public.production_orders SET
    order_number = CASE WHEN d ? 'orderNumber' THEN coalesce(app.imp_text(d, 'orderNumber'), order_number) ELSE order_number END,
    part_id = v_part,
    part_revision_id = v_rev,
    customer_id = CASE WHEN d ? 'customer' THEN app.imp_ref(d, 'customer') ELSE customer_id END,
    site_id = CASE WHEN d ? 'site' THEN app.imp_ref(d, 'site') ELSE site_id END,
    quantity_planned = CASE WHEN d ? 'quantityPlanned' THEN coalesce(app.imp_num(d, 'quantityPlanned'), quantity_planned) ELSE quantity_planned END,
    due_date = CASE WHEN d ? 'dueDate' THEN app.imp_date(d, 'dueDate') ELSE due_date END,
    notes = CASE WHEN d ? 'notes' THEN app.imp_text(d, 'notes') ELSE notes END,
    -- An order made by hand and matched by its number takes the source's identity the first time.
    external_system = CASE WHEN external_id IS NULL AND p_system IS NOT NULL AND p_external IS NOT NULL THEN p_system ELSE external_system END,
    external_id = CASE WHEN external_id IS NULL AND p_system IS NOT NULL AND p_external IS NOT NULL THEN p_external ELSE external_id END,
    updated_at = now(), updated_by = auth.uid()
  WHERE id = p_id;
  IF d ? 'status' AND v_status IS NOT NULL AND v_status <> o.status THEN
    v_path := app.production_order_status_path(o.status, v_status);
    IF v_path IS NULL THEN
      RAISE EXCEPTION 'An order that is % cannot become %', replace(o.status, '_', ' '), replace(v_status, '_', ' ') USING ERRCODE = 'QM017';
    END IF;
    FOREACH v_step IN ARRAY v_path LOOP
      UPDATE public.production_orders
         SET status = v_step, status_reason = CASE WHEN v_step = 'cancelled' THEN coalesce(v_reason, 'Cancelled in the source system') END,
             updated_at = now(), updated_by = auth.uid()
       WHERE id = p_id;
    END LOOP;
  END IF;
  RETURN p_id;
END $$;

-- ---------------------------------------------------------------------------
-- Production orders join the importable kinds
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.integration_may_write(p_org uuid, p_entity text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE p_entity
    WHEN 'supplier' THEN app.has_permission(p_org, 'master_data.manage') OR app.has_permission(p_org, 'supplier_quality.manage')
    WHEN 'customer' THEN app.has_permission(p_org, 'master_data.manage')
    WHEN 'part' THEN app.has_permission(p_org, 'master_data.manage')
    WHEN 'machine' THEN app.has_permission(p_org, 'master_data.manage')
    WHEN 'employee' THEN app.has_permission(p_org, 'master_data.manage')
    WHEN 'gauge_type' THEN app.has_permission(p_org, 'calibration.manage')
    WHEN 'gauge' THEN app.has_permission(p_org, 'calibration.manage')
    WHEN 'nonconformance' THEN app.has_permission(p_org, 'ncr.create')
    WHEN 'production_order' THEN app.has_permission(p_org, 'production.manage')
    ELSE false END
$$;

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
    WHEN 'production_order' THEN SELECT id INTO v_id FROM public.production_orders WHERE organisation_id = p_org AND upper(order_number) = upper(v_code);
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
    WHEN 'gauge_type' THEN coalesce(p_data ->> 'code', p_data ->> 'name') WHEN 'gauge' THEN p_data ->> 'assetNumber'
    WHEN 'production_order' THEN p_data ->> 'orderNumber' END), '')
$$;

-- ---------------------------------------------------------------------------
-- The review queue
-- ---------------------------------------------------------------------------
ALTER TABLE public.integration_sync_runs ADD COLUMN parked integer NOT NULL DEFAULT 0;

CREATE TABLE public.integration_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id),
  connection_id uuid NOT NULL,
  run_id uuid NOT NULL,
  inbox_id uuid,
  entity_type text NOT NULL CHECK (entity_type = ANY (app.integration_entity_types())),
  internal_id uuid NOT NULL,
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
  -- The catalogue field (e.g. "status", "site").
  field text NOT NULL CHECK (field ~ '^[A-Za-z][A-Za-z0-9_]{0,99}$'),
  -- What the source sent for that field, as the import would write it (the field, and for a link its resolved `<field>Id` / `<field>Code`).
  source_data jsonb NOT NULL CHECK (jsonb_typeof(source_data) = 'object'),
  -- The columns the value would have changed: {column: {from, to}}. Null when the value could not be applied at all (`apply_error`).
  fortress_change jsonb CHECK (fortress_change IS NULL OR jsonb_typeof(fortress_change) = 'object'),
  apply_error text CHECK (apply_error IS NULL OR length(apply_error) BETWEEN 1 AND 1000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'rejected', 'superseded')),
  decided_at timestamptz,
  decided_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  decision_note text CHECK (decision_note IS NULL OR length(decision_note) BETWEEN 1 AND 1000),
  superseded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT integration_conflicts_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT integration_conflicts_connection_fkey FOREIGN KEY (connection_id, organisation_id) REFERENCES public.integration_connections (id, organisation_id),
  CONSTRAINT integration_conflicts_run_fkey FOREIGN KEY (run_id, organisation_id) REFERENCES public.integration_sync_runs (id, organisation_id),
  CONSTRAINT integration_conflicts_something CHECK (fortress_change IS NOT NULL OR apply_error IS NOT NULL),
  CONSTRAINT integration_conflicts_decided CHECK ((status IN ('accepted', 'rejected')) = (decided_at IS NOT NULL)),
  CONSTRAINT integration_conflicts_rejected_note CHECK (status <> 'rejected' OR decision_note IS NOT NULL),
  CONSTRAINT integration_conflicts_superseded CHECK ((status = 'superseded') = (superseded_at IS NOT NULL))
);
-- At most one value waiting per record and field.
CREATE UNIQUE INDEX integration_conflicts_one_open ON public.integration_conflicts (organisation_id, entity_type, internal_id, field) WHERE status = 'open';
CREATE INDEX integration_conflicts_org_status_idx ON public.integration_conflicts (organisation_id, status, created_at DESC);
CREATE INDEX integration_conflicts_run_idx ON public.integration_conflicts (run_id);
CREATE INDEX integration_conflicts_connection_idx ON public.integration_conflicts (connection_id);
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.integration_conflicts FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.integration_conflicts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.integration_conflicts FROM anon, authenticated;
GRANT SELECT ON public.integration_conflicts TO authenticated;
CREATE POLICY integration_conflicts_select ON public.integration_conflicts FOR SELECT TO authenticated USING (app.has_permission(organisation_id, 'integrations.read'));

-- Only the decision may change, once; nothing is ever deleted.
CREATE FUNCTION app.integration_conflict_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A value parked for review is never deleted' USING ERRCODE = 'QM022'; END IF;
  IF OLD.status <> 'open' THEN RAISE EXCEPTION 'This value has already been dealt with' USING ERRCODE = 'QM022'; END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'decided_at', 'decided_by', 'decision_note', 'superseded_at'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'decided_at', 'decided_by', 'decision_note', 'superseded_at']) THEN
    RAISE EXCEPTION 'Only the decision on a parked value can change' USING ERRCODE = 'QM022';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER integration_conflicts_guard BEFORE UPDATE OR DELETE ON public.integration_conflicts FOR EACH ROW EXECUTE FUNCTION app.integration_conflict_guard();

-- The record as a row (for comparing before and after a value is applied).
CREATE FUNCTION app.integration_record_row(p_entity text, p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v jsonb;
BEGIN
  CASE p_entity
    WHEN 'supplier' THEN SELECT to_jsonb(x) INTO v FROM public.suppliers x WHERE id = p_id;
    WHEN 'customer' THEN SELECT to_jsonb(x) INTO v FROM public.customers x WHERE id = p_id;
    WHEN 'part' THEN SELECT to_jsonb(x) INTO v FROM public.parts x WHERE id = p_id;
    WHEN 'machine' THEN SELECT to_jsonb(x) INTO v FROM public.machines x WHERE id = p_id;
    WHEN 'employee' THEN SELECT to_jsonb(x) INTO v FROM public."Employees" x WHERE id = p_id;
    WHEN 'gauge_type' THEN SELECT to_jsonb(x) INTO v FROM public.gauge_types x WHERE id = p_id;
    WHEN 'gauge' THEN SELECT to_jsonb(x) INTO v FROM public.gauges x WHERE id = p_id;
    WHEN 'nonconformance' THEN SELECT to_jsonb(x) INTO v FROM public.nonconformances x WHERE id = p_id;
    WHEN 'production_order' THEN SELECT to_jsonb(x) INTO v FROM public.production_orders x WHERE id = p_id;
    ELSE v := NULL;
  END CASE;
  RETURN v;
END $$;

-- Write fields to an existing record through its import function (an update: only the fields given change).
CREATE FUNCTION app.integration_apply_fields(p_org uuid, p_entity text, p_id uuid, d jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RETURN CASE p_entity
    WHEN 'supplier' THEN app.import_supplier(p_org, p_id, d)
    WHEN 'customer' THEN app.import_customer(p_org, p_id, d)
    WHEN 'part' THEN app.import_part(p_org, p_id, d)
    WHEN 'machine' THEN app.import_machine(p_org, p_id, d)
    WHEN 'employee' THEN app.import_employee(p_org, p_id, d)
    WHEN 'gauge_type' THEN app.import_gauge_type(p_org, p_id, d)
    WHEN 'gauge' THEN app.import_gauge(p_org, p_id, d)
    WHEN 'production_order' THEN app.import_production_order(p_org, p_id, d)
    ELSE app.integration_no_importer(p_entity) END;
END $$;

-- What a value would change, without changing it: apply it, compare the row, undo. Answers {change: {column: {from, to}} | null, error: text | null}.
CREATE FUNCTION app.integration_review_change(p_org uuid, p_entity text, p_id uuid, d jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_before jsonb; v_after jsonb; v_change jsonb; v_error text;
BEGIN
  v_before := app.integration_record_row(p_entity, p_id);
  BEGIN
    PERFORM app.integration_apply_fields(p_org, p_entity, p_id, d);
    v_after := app.integration_record_row(p_entity, p_id);
    SELECT jsonb_object_agg(b.key, jsonb_build_object('from', b.value, 'to', a.value)) INTO v_change
      FROM jsonb_each(v_before) b JOIN jsonb_each(v_after) a ON a.key = b.key
     WHERE b.value IS DISTINCT FROM a.value AND b.key NOT IN ('updated_at', 'updated_by');
    RAISE EXCEPTION 'undo' USING ERRCODE = 'QM998';
  EXCEPTION
    WHEN SQLSTATE 'QM998' THEN NULL;
    WHEN OTHERS THEN v_error := left(SQLERRM, 1000); v_change := NULL;
  END;
  RETURN jsonb_build_object('change', v_change, 'error', v_error);
END $$;

-- The field rows of the mapping or template version a run used (a retry uses the run the row first came in with).
CREATE FUNCTION app.integration_run_fields(r public.integration_sync_runs, i public.integration_inbox) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_run public.integration_sync_runs%ROWTYPE := r; v_fields jsonb;
BEGIN
  IF v_run.template_version_id IS NULL AND v_run.mapping_id IS NULL AND i.run_id IS DISTINCT FROM r.id THEN
    SELECT * INTO v_run FROM public.integration_sync_runs WHERE id = i.run_id AND organisation_id = r.organisation_id;
  END IF;
  IF v_run.template_version_id IS NOT NULL THEN
    SELECT fields INTO v_fields FROM public.integration_template_versions WHERE id = v_run.template_version_id AND organisation_id = r.organisation_id;
  ELSIF v_run.mapping_id IS NOT NULL THEN
    SELECT fields INTO v_fields FROM public.integration_mappings WHERE id = v_run.mapping_id AND organisation_id = r.organisation_id;
  END IF;
  RETURN coalesce(v_fields, '[]'::jsonb);
END $$;

-- {field: ownership} for the fields that are not "source wins".
CREATE FUNCTION app.integration_ownership(p_fields jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT coalesce(jsonb_object_agg(e ->> 'target', e ->> 'ownership'), '{}'::jsonb)
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_fields) = 'array' THEN p_fields ELSE '[]'::jsonb END) e
   WHERE e ->> 'ownership' IN ('qms_wins', 'manual_review') AND nullif(e ->> 'target', '') IS NOT NULL
$$;

-- A field's own key and the keys its resolved link adds.
CREATE FUNCTION app.integration_field_keys(p_field text) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$ SELECT ARRAY[p_field, p_field || 'Id', p_field || 'Code'] $$;

-- Park (or clear) a value under review for one field of one record. Answers true when a new value was parked.
CREATE FUNCTION app.integration_park_value(r public.integration_sync_runs, i public.integration_inbox, p_internal uuid, p_field text, p_data jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_frag jsonb; v_check jsonb; v_last public.integration_conflicts%ROWTYPE;
BEGIN
  SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb) INTO v_frag FROM jsonb_each(p_data) WHERE key = ANY (app.integration_field_keys(p_field));
  IF v_frag = '{}'::jsonb THEN RETURN false; END IF;
  v_check := app.integration_review_change(r.organisation_id, r.entity_type, p_internal, v_frag);
  IF v_check -> 'change' = 'null'::jsonb AND v_check -> 'error' = 'null'::jsonb THEN
    -- The source now agrees with Fortress: nothing waits any more.
    UPDATE public.integration_conflicts SET status = 'superseded', superseded_at = now()
     WHERE organisation_id = r.organisation_id AND entity_type = r.entity_type AND internal_id = p_internal AND field = p_field AND status = 'open';
    RETURN false;
  END IF;
  SELECT * INTO v_last FROM public.integration_conflicts
   WHERE organisation_id = r.organisation_id AND entity_type = r.entity_type AND internal_id = p_internal AND field = p_field AND status IN ('open', 'rejected')
   ORDER BY created_at DESC, (status = 'open') DESC LIMIT 1;
  -- The same value is already waiting, or a person already said Fortress keeps its own: do not ask again.
  IF FOUND AND v_last.source_data = v_frag THEN RETURN false; END IF;
  UPDATE public.integration_conflicts SET status = 'superseded', superseded_at = now()
   WHERE organisation_id = r.organisation_id AND entity_type = r.entity_type AND internal_id = p_internal AND field = p_field AND status = 'open';
  INSERT INTO public.integration_conflicts (organisation_id, connection_id, run_id, inbox_id, entity_type, internal_id, external_id, field, source_data,
                                            fortress_change, apply_error)
  VALUES (r.organisation_id, r.connection_id, r.id, i.id, r.entity_type, p_internal, i.external_id, p_field, v_frag,
          CASE WHEN jsonb_typeof(v_check -> 'change') = 'object' THEN v_check -> 'change' END, v_check ->> 'error');
  UPDATE public.integration_sync_runs SET parked = parked + 1, updated_at = now() WHERE id = r.id;
  RETURN true;
END $$;

-- ---------------------------------------------------------------------------
-- The import itself: ownership applied on an update, production orders added
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.system_import_record(p_org uuid, p_run uuid, p_owner uuid, p_row uuid, p_internal uuid, p_data jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  r public.integration_sync_runs%ROWTYPE; i public.integration_inbox%ROWTYPE; s jsonb; v_mode text; v_id uuid; v_data jsonb := p_data;
  v_own jsonb; v_field text; v_rule text; v_system text;
BEGIN
  r := app.integration_run_for_system(p_org, p_run, p_owner);
  i := app.integration_row_for_system(r, p_row);
  IF jsonb_typeof(coalesce(p_data, 'null'::jsonb)) <> 'object' THEN RAISE EXCEPTION 'The record has no mapped fields' USING ERRCODE = 'QM022'; END IF;
  s := coalesce(r.settings, app.integration_settings_for(r.connection_id, r.entity_type));
  v_mode := CASE WHEN r.entity_type = 'nonconformance' THEN 'add_only' ELSE coalesce(s ->> 'writeMode', 'add_only') END;
  IF p_internal IS NOT NULL AND v_mode = 'add_only' THEN RAISE EXCEPTION 'This import only adds new records' USING ERRCODE = 'QM022'; END IF;
  IF p_internal IS NULL AND v_mode = 'update_only' THEN RAISE EXCEPTION 'This import only updates existing records' USING ERRCODE = 'QM022'; END IF;
  IF r.requested_by IS NULL THEN RAISE EXCEPTION 'This import has nobody to act for' USING ERRCODE = 'QM022'; END IF;
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', r.requested_by, 'role', 'authenticated')::text, true);
  PERFORM set_config('app.source', 'integration', true);
  PERFORM set_config('app.initiating_user', r.requested_by::text, true);

  -- Field ownership on an update: Fortress-owned fields are left alone; fields under review are compared and, where they differ, parked.
  IF p_internal IS NOT NULL THEN
    v_own := app.integration_ownership(app.integration_run_fields(r, i));
    FOR v_field, v_rule IN SELECT key, value #>> '{}' FROM jsonb_each(v_own) LOOP
      IF v_rule = 'manual_review' AND v_field NOT LIKE 'cf\_%' THEN
        PERFORM app.integration_park_value(r, i, p_internal, v_field, p_data);
      END IF;
      v_data := v_data - app.integration_field_keys(v_field);
    END LOOP;
  END IF;

  IF r.entity_type = 'production_order' THEN
    SELECT external_system INTO v_system FROM public.integration_connections WHERE id = r.connection_id AND organisation_id = p_org;
  END IF;
  v_id := CASE r.entity_type
    WHEN 'supplier' THEN app.import_supplier(p_org, p_internal, v_data)
    WHEN 'customer' THEN app.import_customer(p_org, p_internal, v_data)
    WHEN 'part' THEN app.import_part(p_org, p_internal, v_data)
    WHEN 'machine' THEN app.import_machine(p_org, p_internal, v_data)
    WHEN 'employee' THEN app.import_employee(p_org, p_internal, v_data)
    WHEN 'gauge_type' THEN app.import_gauge_type(p_org, p_internal, v_data)
    WHEN 'gauge' THEN app.import_gauge(p_org, p_internal, v_data)
    WHEN 'nonconformance' THEN app.import_nonconformance(p_org, p_internal, v_data)
    WHEN 'production_order' THEN app.import_production_order(p_org, p_internal, v_data, v_system, i.external_id)
    ELSE app.integration_no_importer(r.entity_type) END;
  PERFORM app.import_custom_values(p_org, r.entity_type, v_id, v_data);
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------
-- A person decides a parked value: accept (the value is written now, by them) or reject (Fortress keeps its own; a reason is needed)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.decide_integration_conflict(p_conflict uuid, p_accept boolean, p_note text DEFAULT NULL) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.integration_conflicts%ROWTYPE; v_note text := nullif(btrim(p_note), '');
BEGIN
  SELECT * INTO c FROM public.integration_conflicts WHERE id = p_conflict FOR UPDATE;
  IF NOT FOUND OR NOT app.has_permission(c.organisation_id, 'integrations.read') THEN
    RAISE EXCEPTION 'Value not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT app.has_permission(c.organisation_id, 'integrations.run') OR NOT app.integration_may_write(c.organisation_id, c.entity_type) THEN
    RAISE EXCEPTION 'Deciding needs the permission to run imports and to edit these records' USING ERRCODE = '42501';
  END IF;
  IF c.status <> 'open' THEN RAISE EXCEPTION 'This value has already been dealt with' USING ERRCODE = 'QM022'; END IF;
  IF p_accept IS NULL THEN RAISE EXCEPTION 'Say whether the value is accepted' USING ERRCODE = 'QM022'; END IF;
  IF v_note IS NOT NULL AND length(v_note) > 1000 THEN RAISE EXCEPTION 'Keep the note to 1000 characters' USING ERRCODE = 'QM022'; END IF;
  IF NOT p_accept AND (v_note IS NULL OR length(v_note) < 3) THEN
    RAISE EXCEPTION 'Say why Fortress keeps its own value' USING ERRCODE = 'QM022';
  END IF;
  IF p_accept THEN
    PERFORM app.integration_apply_fields(c.organisation_id, c.entity_type, c.internal_id, c.source_data);
  END IF;
  UPDATE public.integration_conflicts
     SET status = CASE WHEN p_accept THEN 'accepted' ELSE 'rejected' END, decided_at = now(), decided_by = auth.uid(), decision_note = v_note
   WHERE id = c.id;
  RETURN CASE WHEN p_accept THEN 'accepted' ELSE 'rejected' END;
END $$;

REVOKE ALL ON FUNCTION app.production_order_transitions(), app.production_order_status_path(text, text), app.production_import_revision(uuid, text),
  app.import_production_order(uuid, uuid, jsonb, text, text), app.integration_conflict_guard(), app.integration_record_row(text, uuid),
  app.integration_apply_fields(uuid, text, uuid, jsonb), app.integration_review_change(uuid, text, uuid, jsonb),
  app.integration_run_fields(public.integration_sync_runs, public.integration_inbox), app.integration_ownership(jsonb), app.integration_field_keys(text),
  app.integration_park_value(public.integration_sync_runs, public.integration_inbox, uuid, text, jsonb),
  app.decide_integration_conflict(uuid, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.decide_integration_conflict(uuid, boolean, text) TO authenticated;
