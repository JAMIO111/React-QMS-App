-- Manufacturing traceability, slice TR3a (docs/phase-3-plan.md): what the pickers, the settings and the backfill of existing free text need from the database.
--  * organisation_settings gains use_lots_and_serials (default on: nothing changes for anyone), allow_inline_orders (default off) and require_production_order (default off).
--  * app.create_order_inline: an order made from a job's order picker, by people with production.manage, or by people who may record inspections when the organisation allows it. Orders only, never lots or serials.
--  * require_production_order is enforced where it matters: a job cannot be completed without a production order.
--  * spc_baselines may keep a baseline whose subgroups are production orders.
--  * app.system_backfill_production_links (API login only; dry run unless asked): turns the work orders, lots and serial numbers typed on existing inspections and non-conformances into production records and links
--    the records to them. It never rewrites typed text, never guesses (a work order typed against several parts is skipped and reported), reuses what exists, and can be run again.

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------
ALTER TABLE public.organisation_settings
  ADD COLUMN use_lots_and_serials boolean NOT NULL DEFAULT true,
  ADD COLUMN allow_inline_orders boolean NOT NULL DEFAULT false,
  ADD COLUMN require_production_order boolean NOT NULL DEFAULT false;
GRANT UPDATE (use_lots_and_serials, allow_inline_orders, require_production_order) ON public.organisation_settings TO authenticated;

-- ---------------------------------------------------------------------------
-- SPC: a subgroup can be one production order (for shops that work to work orders and have no lots).
-- ---------------------------------------------------------------------------
ALTER TABLE public.spc_baselines DROP CONSTRAINT spc_baselines_subgroup_basis_check;
ALTER TABLE public.spc_baselines ADD CONSTRAINT spc_baselines_subgroup_basis_check CHECK (subgroup_basis IN ('inspection', 'day', 'lot', 'order'));

-- ---------------------------------------------------------------------------
-- An order made from the job's order picker
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.create_order_inline(p_order_number text, p_part uuid, p_quantity numeric, p_site uuid DEFAULT NULL, p_customer uuid DEFAULT NULL, p_revision uuid DEFAULT NULL,
                                        p_due date DEFAULT NULL, p_notes text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_org uuid;
  v_id uuid;
BEGIN
  SELECT organisation_id INTO v_org FROM public.parts WHERE id = p_part;
  IF v_org IS NULL OR NOT app.has_permission(v_org, 'production.read', p_site) THEN
    RAISE EXCEPTION 'Part not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT (app.has_permission(v_org, 'production.manage', p_site)
          OR (app.has_permission(v_org, 'inspection.record', p_site)
              AND coalesce((SELECT allow_inline_orders FROM public.organisation_settings WHERE organisation_id = v_org), false))) THEN
    RAISE EXCEPTION 'Creating a production order needs the production.manage permission' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.production_orders (organisation_id, order_number, part_id, part_revision_id, customer_id, site_id, quantity_planned, due_date, notes)
    VALUES (v_org, trim(p_order_number), p_part, p_revision, p_customer, p_site, p_quantity, p_due, nullif(trim(coalesce(p_notes, '')), ''))
    RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION app.create_order_inline(text, uuid, numeric, uuid, uuid, uuid, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.create_order_inline(text, uuid, numeric, uuid, uuid, uuid, date, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Link triggers: while the backfill runs they link only, and leave the typed text exactly as it was.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.inspection_production_links() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_old_order uuid; v_old_lot uuid; v_old_serial uuid;
  v_changed text;
  v_backfill boolean := coalesce(current_setting('app.production_backfill', true), '') = 'on';
  r jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_old_order := OLD.production_order_id; v_old_lot := OLD.lot_id; v_old_serial := OLD.serial_id;
  END IF;
  IF (NEW.production_order_id, NEW.lot_id, NEW.serial_id) IS NOT DISTINCT FROM (v_old_order, v_old_lot, v_old_serial) THEN
    RETURN NEW;
  END IF;
  v_changed := CASE WHEN NEW.serial_id IS NOT NULL AND NEW.serial_id IS DISTINCT FROM v_old_serial THEN 'serial'
                    WHEN NEW.lot_id IS NOT NULL AND NEW.lot_id IS DISTINCT FROM v_old_lot THEN 'lot'
                    WHEN NEW.production_order_id IS NOT NULL AND NEW.production_order_id IS DISTINCT FROM v_old_order THEN 'order' END;
  IF NEW.production_order_id IS NOT NULL OR NEW.lot_id IS NOT NULL OR NEW.serial_id IS NOT NULL THEN
    r := app.production_link_resolve(NEW.organisation_id, NEW.part_id, NEW.production_order_id, NEW.lot_id, NEW.serial_id, v_changed);
    NEW.production_order_id := (r->>'order_id')::uuid;
    NEW.lot_id := (r->>'lot_id')::uuid;
  END IF;
  IF NOT v_backfill THEN
    IF NEW.production_order_id IS NOT NULL AND NEW.production_order_id IS DISTINCT FROM v_old_order THEN NEW.work_order := r->>'order_number'; END IF;
    IF NEW.lot_id IS NOT NULL AND NEW.lot_id IS DISTINCT FROM v_old_lot THEN NEW.lot := r->>'lot_number'; END IF;
    IF NEW.serial_id IS NOT NULL AND NEW.serial_id IS DISTINCT FROM v_old_serial THEN NEW.serial := r->>'serial_number'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.ncr_production_links() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_old_order uuid; v_old_lot uuid; v_old_serial uuid;
  v_changed text;
  v_backfill boolean := coalesce(current_setting('app.production_backfill', true), '') = 'on';
  r jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_old_order := OLD.production_order_id; v_old_lot := OLD.lot_id; v_old_serial := OLD.serial_id;
  END IF;
  IF (NEW.production_order_id, NEW.lot_id, NEW.serial_id) IS NOT DISTINCT FROM (v_old_order, v_old_lot, v_old_serial) THEN
    RETURN NEW;
  END IF;
  v_changed := CASE WHEN NEW.serial_id IS NOT NULL AND NEW.serial_id IS DISTINCT FROM v_old_serial THEN 'serial'
                    WHEN NEW.lot_id IS NOT NULL AND NEW.lot_id IS DISTINCT FROM v_old_lot THEN 'lot'
                    WHEN NEW.production_order_id IS NOT NULL AND NEW.production_order_id IS DISTINCT FROM v_old_order THEN 'order' END;
  IF NEW.production_order_id IS NOT NULL OR NEW.lot_id IS NOT NULL OR NEW.serial_id IS NOT NULL THEN
    r := app.production_link_resolve(NEW.organisation_id, NEW.part_id, NEW.production_order_id, NEW.lot_id, NEW.serial_id, v_changed);
    NEW.production_order_id := (r->>'order_id')::uuid;
    NEW.lot_id := (r->>'lot_id')::uuid;
    NEW.part_id := coalesce(NEW.part_id, (r->>'part_id')::uuid);
  END IF;
  IF NOT v_backfill THEN
    IF NEW.production_order_id IS NOT NULL AND NEW.production_order_id IS DISTINCT FROM v_old_order THEN NEW.work_order := r->>'order_number'; END IF;
    IF NEW.lot_id IS NOT NULL AND NEW.lot_id IS DISTINCT FROM v_old_lot THEN NEW.lot_number := r->>'lot_number'; END IF;
    IF NEW.serial_id IS NOT NULL AND NEW.serial_id IS DISTINCT FROM v_old_serial THEN NEW.serial_number := r->>'serial_number'; END IF;
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- The inspection rules (production_traceability migration) with two additions: the backfill may change the three link columns of any inspection and nothing else, and an organisation that
-- requires a production order does not let a job be completed without one.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.inspection_record_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_missing text;
  v_unhandled text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Only app.start_inspection inserts (users have no INSERT privilege); keep it consistent.
    NEW.status := 'in_progress'; NEW.result := NULL; NEW.completed_at := NULL; NEW.completed_by := NULL; NEW.abandon_reason := NULL;
    NEW.started_at := now();
    RETURN NEW;
  END IF;
  -- The backfill of production links (app.system_backfill_production_links) changes the links and nothing else.
  IF coalesce(current_setting('app.production_backfill', true), '') = 'on' THEN
    IF (to_jsonb(NEW) - ARRAY['production_order_id', 'lot_id', 'serial_id', 'updated_at', 'updated_by']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['production_order_id', 'lot_id', 'serial_id', 'updated_at', 'updated_by']) THEN
      RAISE EXCEPTION 'The backfill may only link production records' USING ERRCODE = 'QM008';
    END IF;
    RETURN NEW;
  END IF;
  -- While the job is running its work order, lot, lot size, serial and production links can be filled in or corrected (app.set_job_details, app.set_job_links);
  -- every other context column is frozen.
  IF (to_jsonb(NEW) - ARRAY['status', 'result', 'completed_at', 'completed_by', 'abandon_reason', 'notes', 'updated_at', 'updated_by']
        - CASE WHEN OLD.status = 'in_progress' AND NEW.status = 'in_progress'
               THEN ARRAY['work_order', 'lot', 'lot_size', 'serial', 'production_order_id', 'lot_id', 'serial_id'] ELSE ARRAY[]::text[] END)
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'result', 'completed_at', 'completed_by', 'abandon_reason', 'notes', 'updated_at', 'updated_by']
        - CASE WHEN OLD.status = 'in_progress' AND NEW.status = 'in_progress'
               THEN ARRAY['work_order', 'lot', 'lot_size', 'serial', 'production_order_id', 'lot_id', 'serial_id'] ELSE ARRAY[]::text[] END) THEN
    RAISE EXCEPTION 'The context and requirements of an inspection cannot change' USING ERRCODE = 'QM008';
  END IF;
  IF OLD.status <> 'in_progress' THEN
    IF NEW IS DISTINCT FROM OLD AND (NEW.status, NEW.result, NEW.notes, NEW.abandon_reason) IS DISTINCT FROM (OLD.status, OLD.result, OLD.notes, OLD.abandon_reason) THEN
      RAISE EXCEPTION 'Inspection % is %', OLD.reference, OLD.status USING ERRCODE = 'QM008';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'in_progress' THEN
    IF (NEW.result, NEW.completed_at, NEW.completed_by, NEW.abandon_reason) IS DISTINCT FROM (OLD.result, OLD.completed_at, OLD.completed_by, OLD.abandon_reason) THEN
      RAISE EXCEPTION 'The result is worked out when the inspection is completed' USING ERRCODE = 'QM008';
    END IF;
    RETURN NEW;
  END IF;
  NEW.completed_at := now();
  NEW.completed_by := auth.uid();
  IF NEW.status = 'abandoned' THEN
    IF coalesce(trim(NEW.abandon_reason), '') = '' THEN
      RAISE EXCEPTION 'Give a reason for abandoning the inspection' USING ERRCODE = 'QM008';
    END IF;
    NEW.result := NULL;
    RETURN NEW;
  END IF;
  -- Completed.
  NEW.abandon_reason := NULL;
  IF NEW.production_order_id IS NULL AND coalesce((SELECT require_production_order FROM public.organisation_settings WHERE organisation_id = NEW.organisation_id), false) THEN
    RAISE EXCEPTION 'Link the job to a production order before completing it' USING ERRCODE = 'QM008';
  END IF;
  SELECT string_agg(q.name, ', ' ORDER BY q.sequence) INTO v_missing
  FROM public.resolved_inspection_requirements q
  WHERE q.inspection_record_id = NEW.id AND q.applicable
    AND NOT EXISTS (SELECT 1 FROM public.inspection_measurements m WHERE m.requirement_id = q.id);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Measure every check before completing; missing: %', v_missing USING ERRCODE = 'QM008';
  END IF;
  -- Every current failed reading needs an acknowledgement or a live NC (one that is not cancelled or deleted).
  SELECT string_agg(q.name || ' (sample ' || s.sample_number || ')', ', ' ORDER BY s.sample_number, q.sequence) INTO v_unhandled
  FROM public.inspection_measurements m
  JOIN public.resolved_inspection_requirements q ON q.id = m.requirement_id
  JOIN public.inspection_samples s ON s.id = m.sample_id
  WHERE m.inspection_record_id = NEW.id AND m.result = 'fail'
    AND NOT EXISTS (SELECT 1 FROM public.inspection_measurements c WHERE c.supersedes_id = m.id)
    AND NOT EXISTS (SELECT 1 FROM public.inspection_failure_acknowledgements a WHERE a.measurement_id = m.id)
    AND app.reading_live_ncr(m.id) IS NULL;
  IF v_unhandled IS NOT NULL THEN
    RAISE EXCEPTION 'Acknowledge or raise an NC for each failed reading before completing: %', v_unhandled USING ERRCODE = 'QM008';
  END IF;
  NEW.result := CASE WHEN EXISTS (
      SELECT 1 FROM public.inspection_measurements m
      WHERE m.inspection_record_id = NEW.id AND m.result = 'fail'
        AND NOT EXISTS (SELECT 1 FROM public.inspection_measurements c WHERE c.supersedes_id = m.id))
    THEN 'fail' ELSE 'pass' END;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- The backfill. Reads the work order, lot and serial typed on an organisation's inspections and non-conformances (only where the matching link is still empty), creates the production records they
-- name, and links the records to them, without touching any typed text. Nothing is guessed:
--   * a work order typed against more than one part is skipped (an order is for one part) and listed, as is one that already exists for another part;
--   * a record with no part, or text that is not a usable number (blank, over 60 characters), is counted and left alone;
--   * an order or lot that already exists (same number, any case, same part) is reused, not duplicated;
--   * a lot is given an order only when every record that names the lot names the same order; a lot named only by supplier NCs is a received lot; a serial number takes its lot the same way.
-- Created orders are "released" with a note, and a planned quantity taken from the largest quantity on an inspection (else 1): people check them. Run it as a dry run first (the default).
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.system_backfill_production_links(p_organisation_id uuid, p_dry_run boolean DEFAULT true) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  rx constant text := '^\S(.{0,58}\S)?$';
  r record;
  v_unusable integer; v_no_part integer;
  v_conflicts integer := 0; v_inspections integer := 0; v_ncrs integer := 0;
  v_orders_new integer; v_orders_matched integer; v_lots_new integer; v_lots_matched integer; v_serials_new integer; v_serials_matched integer;
  v_skipped jsonb;
  v_links integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organisations WHERE id = p_organisation_id) THEN
    RAISE EXCEPTION 'Organisation not found' USING ERRCODE = 'P0002';
  END IF;
  DROP TABLE IF EXISTS pg_temp.pl_src;
  DROP TABLE IF EXISTS pg_temp.pl_orders;
  DROP TABLE IF EXISTS pg_temp.pl_lots;
  DROP TABLE IF EXISTS pg_temp.pl_serials;
  DROP TABLE IF EXISTS pg_temp.pl_links;

  -- What is typed, only where the matching link is empty.
  CREATE TEMP TABLE pl_src ON COMMIT DROP AS
    SELECT 'inspection'::text AS kind, i.id, i.part_id, i.site_id, NULL::text AS source, NULL::uuid AS supplier_id, i.lot_size::numeric AS qty,
           CASE WHEN i.production_order_id IS NULL THEN nullif(btrim(i.work_order), '') END AS wo,
           CASE WHEN i.lot_id IS NULL THEN nullif(btrim(i.lot), '') END AS lot,
           CASE WHEN i.serial_id IS NULL THEN nullif(btrim(i.serial), '') END AS serial,
           i.production_order_id AS has_order, i.lot_id AS has_lot, i.serial_id AS has_serial
      FROM public.inspection_records i WHERE i.organisation_id = p_organisation_id
    UNION ALL
    SELECT 'ncr', n.id, n.part_id, n.site_id, n.source, n.supplier_id, NULL::numeric,
           CASE WHEN n.production_order_id IS NULL THEN nullif(btrim(n.work_order), '') END,
           CASE WHEN n.lot_id IS NULL THEN nullif(btrim(n.lot_number), '') END,
           CASE WHEN n.serial_id IS NULL THEN nullif(btrim(n.serial_number), '') END,
           n.production_order_id, n.lot_id, n.serial_id
      FROM public.nonconformances n WHERE n.organisation_id = p_organisation_id AND n.deleted_at IS NULL;
  DELETE FROM pl_src WHERE wo IS NULL AND lot IS NULL AND serial IS NULL;

  SELECT count(*) INTO v_unusable FROM pl_src WHERE (wo IS NOT NULL AND wo !~ rx) OR (lot IS NOT NULL AND lot !~ rx) OR (serial IS NOT NULL AND serial !~ rx);
  UPDATE pl_src SET wo = NULL WHERE wo !~ rx;
  UPDATE pl_src SET lot = NULL WHERE lot !~ rx;
  UPDATE pl_src SET serial = NULL WHERE serial !~ rx;
  SELECT count(*) INTO v_no_part FROM pl_src WHERE part_id IS NULL;
  DELETE FROM pl_src WHERE part_id IS NULL OR (wo IS NULL AND lot IS NULL AND serial IS NULL);

  -- Orders: one per work order number, for the one part it was typed against.
  CREATE TEMP TABLE pl_orders ON COMMIT DROP AS
    SELECT upper(s.wo) AS k, mode() WITHIN GROUP (ORDER BY s.wo) AS number, count(DISTINCT s.part_id)::integer AS parts, (array_agg(s.part_id))[1] AS part_id,
           greatest(1, coalesce(max(s.qty), 1)) AS qty, CASE WHEN count(DISTINCT s.site_id) = 1 THEN (array_agg(s.site_id) FILTER (WHERE s.site_id IS NOT NULL))[1] END AS site_id,
           NULL::uuid AS existing_id, NULL::text AS problem, NULL::uuid AS id
      FROM pl_src s WHERE s.wo IS NOT NULL GROUP BY upper(s.wo);
  UPDATE pl_orders o SET existing_id = po.id FROM public.production_orders po WHERE po.organisation_id = p_organisation_id AND upper(po.order_number) = o.k;
  UPDATE pl_orders SET problem = 'typed against more than one part' WHERE parts > 1;
  UPDATE pl_orders o SET problem = 'already exists for another part' FROM public.production_orders po WHERE po.id = o.existing_id AND po.part_id <> o.part_id AND o.problem IS NULL;
  UPDATE pl_orders SET id = coalesce(existing_id, gen_random_uuid()) WHERE problem IS NULL;

  -- Lots: one per part and lot number.
  CREATE TEMP TABLE pl_lots ON COMMIT DROP AS
    SELECT s.part_id, upper(s.lot) AS k, mode() WITHIN GROUP (ORDER BY s.lot) AS number,
           bool_and(s.kind = 'ncr' AND s.source = 'supplier') AS received,
           CASE WHEN count(DISTINCT s.supplier_id) = 1 AND bool_and(s.supplier_id IS NOT NULL) THEN (array_agg(s.supplier_id))[1] END AS supplier_id,
           CASE WHEN count(DISTINCT upper(s.wo)) = 1 AND bool_and(s.wo IS NOT NULL) THEN (array_agg(upper(s.wo)))[1] END AS order_key,
           CASE WHEN count(DISTINCT s.site_id) = 1 THEN (array_agg(s.site_id) FILTER (WHERE s.site_id IS NOT NULL))[1] END AS site_id,
           NULL::uuid AS existing_id, NULL::uuid AS order_id, NULL::uuid AS id
      FROM pl_src s WHERE s.lot IS NOT NULL GROUP BY s.part_id, upper(s.lot);
  UPDATE pl_lots l SET existing_id = x.id FROM public.lots x WHERE x.organisation_id = p_organisation_id AND x.part_id = l.part_id AND upper(x.lot_number) = l.k;
  UPDATE pl_lots l SET order_id = o.id FROM pl_orders o WHERE o.k = l.order_key AND o.problem IS NULL AND o.part_id = l.part_id AND NOT l.received AND l.existing_id IS NULL;
  UPDATE pl_lots SET id = coalesce(existing_id, gen_random_uuid());

  -- Serial numbers: one per part and serial.
  CREATE TEMP TABLE pl_serials ON COMMIT DROP AS
    SELECT s.part_id, upper(s.serial) AS k, mode() WITHIN GROUP (ORDER BY s.serial) AS number,
           CASE WHEN count(DISTINCT upper(s.lot)) = 1 AND bool_and(s.lot IS NOT NULL) THEN (array_agg(upper(s.lot)))[1] END AS lot_key,
           CASE WHEN count(DISTINCT upper(s.wo)) = 1 AND bool_and(s.wo IS NOT NULL) THEN (array_agg(upper(s.wo)))[1] END AS order_key,
           CASE WHEN count(DISTINCT s.site_id) = 1 THEN (array_agg(s.site_id) FILTER (WHERE s.site_id IS NOT NULL))[1] END AS site_id,
           NULL::uuid AS existing_id, NULL::uuid AS lot_id, NULL::uuid AS order_id, NULL::uuid AS id
      FROM pl_src s WHERE s.serial IS NOT NULL GROUP BY s.part_id, upper(s.serial);
  UPDATE pl_serials z SET existing_id = x.id FROM public.serial_numbers x WHERE x.organisation_id = p_organisation_id AND x.part_id = z.part_id AND upper(x.serial_number) = z.k;
  UPDATE pl_serials z SET lot_id = l.id FROM pl_lots l WHERE l.part_id = z.part_id AND l.k = z.lot_key AND z.existing_id IS NULL;
  -- A serial number that has a lot takes its order from the lot.
  UPDATE pl_serials z SET order_id = o.id FROM pl_orders o WHERE o.k = z.order_key AND o.problem IS NULL AND o.part_id = z.part_id AND z.lot_id IS NULL AND z.existing_id IS NULL;
  UPDATE pl_serials SET id = coalesce(existing_id, gen_random_uuid());

  SELECT count(*) FILTER (WHERE existing_id IS NULL AND problem IS NULL), count(*) FILTER (WHERE existing_id IS NOT NULL AND problem IS NULL) INTO v_orders_new, v_orders_matched FROM pl_orders;
  SELECT count(*) FILTER (WHERE existing_id IS NULL), count(*) FILTER (WHERE existing_id IS NOT NULL) INTO v_lots_new, v_lots_matched FROM pl_lots;
  SELECT count(*) FILTER (WHERE existing_id IS NULL), count(*) FILTER (WHERE existing_id IS NOT NULL) INTO v_serials_new, v_serials_matched FROM pl_serials;
  SELECT coalesce(jsonb_agg(jsonb_build_object('number', number, 'reason', problem) ORDER BY number) FILTER (WHERE problem IS NOT NULL), '[]'::jsonb) INTO v_skipped FROM (SELECT * FROM pl_orders WHERE problem IS NOT NULL ORDER BY number LIMIT 25) x;

  -- What each record would be linked to.
  CREATE TEMP TABLE pl_links ON COMMIT DROP AS
    SELECT s.kind, s.id, o.id AS order_id, l.id AS lot_id, z.id AS serial_id
      FROM pl_src s
      LEFT JOIN pl_orders o ON o.k = upper(s.wo) AND o.problem IS NULL
      LEFT JOIN pl_lots l ON l.part_id = s.part_id AND l.k = upper(s.lot)
      LEFT JOIN pl_serials z ON z.part_id = s.part_id AND z.k = upper(s.serial);
  DELETE FROM pl_links WHERE order_id IS NULL AND lot_id IS NULL AND serial_id IS NULL;
  SELECT count(*) INTO v_links FROM pl_links;

  IF p_dry_run THEN
    RETURN jsonb_build_object('dryRun', true,
      'orders', jsonb_build_object('new', v_orders_new, 'matched', v_orders_matched, 'skipped', v_skipped),
      'lots', jsonb_build_object('new', v_lots_new, 'matched', v_lots_matched),
      'serialNumbers', jsonb_build_object('new', v_serials_new, 'matched', v_serials_matched),
      'recordsToLink', v_links, 'noPart', v_no_part, 'unusableText', v_unusable, 'conflicts', 0, 'inspectionsLinked', 0, 'ncrsLinked', 0);
  END IF;

  INSERT INTO public.production_orders (id, organisation_id, order_number, part_id, site_id, quantity_planned, status, notes)
    SELECT id, p_organisation_id, number, part_id, site_id, qty, 'released', 'Created from the work order typed on existing records: check the quantity and status.'
      FROM pl_orders WHERE existing_id IS NULL AND problem IS NULL;
  INSERT INTO public.lots (id, organisation_id, lot_number, part_id, origin, production_order_id, supplier_id, site_id, notes)
    SELECT id, p_organisation_id, number, part_id, CASE WHEN received THEN 'received' ELSE 'produced' END, order_id, CASE WHEN received THEN supplier_id END, site_id,
           'Created from the lot typed on existing records.'
      FROM pl_lots WHERE existing_id IS NULL;
  INSERT INTO public.serial_numbers (id, organisation_id, serial_number, part_id, lot_id, production_order_id, site_id, notes)
    SELECT id, p_organisation_id, number, part_id, lot_id, order_id, site_id, 'Created from the serial number typed on existing records.'
      FROM pl_serials WHERE existing_id IS NULL;

  PERFORM set_config('app.production_backfill', 'on', true);
  FOR r IN SELECT * FROM pl_links LOOP
    BEGIN
      IF r.kind = 'inspection' THEN
        UPDATE public.inspection_records SET production_order_id = coalesce(r.order_id, production_order_id), lot_id = coalesce(r.lot_id, lot_id), serial_id = coalesce(r.serial_id, serial_id) WHERE id = r.id;
        v_inspections := v_inspections + 1;
      ELSE
        UPDATE public.nonconformances SET production_order_id = coalesce(r.order_id, production_order_id), lot_id = coalesce(r.lot_id, lot_id), serial_id = coalesce(r.serial_id, serial_id) WHERE id = r.id;
        v_ncrs := v_ncrs + 1;
      END IF;
    EXCEPTION WHEN SQLSTATE 'QM017' THEN
      v_conflicts := v_conflicts + 1;
    END;
  END LOOP;
  PERFORM set_config('app.production_backfill', '', true);

  RETURN jsonb_build_object('dryRun', false,
    'orders', jsonb_build_object('new', v_orders_new, 'matched', v_orders_matched, 'skipped', v_skipped),
    'lots', jsonb_build_object('new', v_lots_new, 'matched', v_lots_matched),
    'serialNumbers', jsonb_build_object('new', v_serials_new, 'matched', v_serials_matched),
    'recordsToLink', v_links, 'noPart', v_no_part, 'unusableText', v_unusable, 'conflicts', v_conflicts, 'inspectionsLinked', v_inspections, 'ncrsLinked', v_ncrs);
END $$;
REVOKE ALL ON FUNCTION app.system_backfill_production_links(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.system_backfill_production_links(uuid, boolean) TO qms_api;
