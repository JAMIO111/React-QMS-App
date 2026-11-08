-- Where detected / Causal process now point at machines, and the original (pre-multi-tenant) tables are gone.
--
--  1. Every process the non-conformances used to name (ncr_classifications, kind 'process') becomes a machine of the same organisation, reusing a machine that already has
--     that name (any case). Nothing is guessed: names are kept, the machine's description says where it came from, and codes are made from the name (unique per organisation).
--  2. nonconformances.detection_process_id and causal_process_id are re-pointed at those machines (the column names stay: "where detected" and "causal process" are the
--     words people use) and now have foreign keys to public.machines instead of ncr_classifications. The data move is not a user's change, so the row triggers (audit, events,
--     notifications) are switched off for the move and back on straight after. The consistency rule in app.nonconformance_rules no longer checks the old classification kind
--     (the foreign key does it), and app.start_capa takes the 8D's "where" from the machine.
--  3. The legacy tables the app no longer reads are dropped: "NCM", "8D", "Costs", "NC Files", "Part", "Status", "Failure Mode", "Sub-Failure Mode", "Process", "Customers",
--     "Suppliers", "Addresses", "Notifications" and "Notification Recipients", with the old views (v_nc_files, v_ncm_customer, v_ncm_internal, v_ncm_supplier) and functions
--     (get_nc_date_trend, get_nc_kpi_json, get_user_notifications) that only read them. Their data was copied into the multi-tenant tables by earlier migrations. "Employees" stays
--     (it is the employees register). app.create_organisation no longer seeds the legacy statuses. The old process classification rows are left as they are (unused).
-- Drops have no CASCADE: if anything still depends on a legacy table the migration stops instead of removing it.

-- ---------------------------------------------------------------------------
-- 1. Machines from the processes in use
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE _process_machine (classification_id uuid PRIMARY KEY, organisation_id uuid NOT NULL, machine_id uuid NOT NULL) ON COMMIT DROP;

ALTER TABLE public.machines DISABLE TRIGGER USER;
DO $$
DECLARE c record; v_machine uuid; v_base text; v_code text; v_n integer;
BEGIN
  FOR c IN SELECT id, organisation_id, name, active FROM public.ncr_classifications WHERE kind = 'process' ORDER BY organisation_id, lower(name), id LOOP
    SELECT m.id INTO v_machine FROM public.machines m WHERE m.organisation_id = c.organisation_id AND lower(btrim(m.name)) = lower(btrim(c.name)) ORDER BY m.created_at, m.id LIMIT 1;
    IF v_machine IS NULL THEN
      v_base := left(trim(both '-' from upper(regexp_replace(btrim(c.name), '[^A-Za-z0-9]+', '-', 'g'))), 36);
      IF v_base = '' THEN v_base := 'MACHINE'; END IF;
      v_code := v_base; v_n := 1;
      WHILE EXISTS (SELECT 1 FROM public.machines m WHERE m.organisation_id = c.organisation_id AND upper(m.code) = v_code) LOOP
        v_n := v_n + 1;
        v_code := v_base || '-' || v_n;
      END LOOP;
      INSERT INTO public.machines (organisation_id, code, name, description, active)
      VALUES (c.organisation_id, v_code, left(btrim(c.name), 120), 'Made from the process "' || c.name || '" that non-conformances named before they pointed at machines', c.active)
      RETURNING id INTO v_machine;
    END IF;
    INSERT INTO _process_machine VALUES (c.id, c.organisation_id, v_machine);
  END LOOP;
END $$;
ALTER TABLE public.machines ENABLE TRIGGER USER;

-- ---------------------------------------------------------------------------
-- 2. Re-point the non-conformances
-- ---------------------------------------------------------------------------
ALTER TABLE public.nonconformances DISABLE TRIGGER USER;
ALTER TABLE public.nonconformances DROP CONSTRAINT nonconformances_detection_process_fkey, DROP CONSTRAINT nonconformances_causal_process_fkey;
UPDATE public.nonconformances n SET detection_process_id = pm.machine_id
  FROM _process_machine pm WHERE pm.classification_id = n.detection_process_id AND pm.organisation_id = n.organisation_id;
UPDATE public.nonconformances n SET causal_process_id = pm.machine_id
  FROM _process_machine pm WHERE pm.classification_id = n.causal_process_id AND pm.organisation_id = n.organisation_id;
DO $$
DECLARE v_bad bigint;
BEGIN
  SELECT count(*) INTO v_bad FROM public.nonconformances n
   WHERE (n.detection_process_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.machines m WHERE m.id = n.detection_process_id AND m.organisation_id = n.organisation_id))
      OR (n.causal_process_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.machines m WHERE m.id = n.causal_process_id AND m.organisation_id = n.organisation_id));
  IF v_bad > 0 THEN RAISE EXCEPTION 'Where detected / causal process: % non-conformances name something that is not a machine', v_bad; END IF;
END $$;
ALTER TABLE public.nonconformances
  ADD CONSTRAINT nonconformances_detection_machine_fkey FOREIGN KEY (detection_process_id, organisation_id) REFERENCES public.machines (id, organisation_id),
  ADD CONSTRAINT nonconformances_causal_machine_fkey FOREIGN KEY (causal_process_id, organisation_id) REFERENCES public.machines (id, organisation_id);
ALTER TABLE public.nonconformances ENABLE TRIGGER USER;
CREATE INDEX nonconformances_detection_machine_idx ON public.nonconformances (organisation_id, detection_process_id) WHERE detection_process_id IS NOT NULL;
CREATE INDEX nonconformances_causal_machine_idx ON public.nonconformances (organisation_id, causal_process_id) WHERE causal_process_id IS NOT NULL;

-- The consistency rule no longer checks the old classification kind for these two fields (the foreign keys check the machine).
DO $$
DECLARE v_old text; v_new text;
BEGIN
  v_old := pg_get_functiondef('app.nonconformance_rules()'::regprocedure);
  v_new := regexp_replace(v_old, '\s+OR NEW\.causal_process_id IS NOT NULL AND NOT EXISTS \(SELECT 1 FROM public\.ncr_classifications c WHERE c\.id = NEW\.causal_process_id AND c\.kind = ''process''\)', '');
  v_new := regexp_replace(v_new, '\s+OR NEW\.detection_process_id IS NOT NULL AND NOT EXISTS \(SELECT 1 FROM public\.ncr_classifications c WHERE c\.id = NEW\.detection_process_id AND c\.kind = ''process''\)', '');
  IF v_new = v_old OR v_new ILIKE '%c.kind = ''process''%' THEN RAISE EXCEPTION 'app.nonconformance_rules did not have the expected process checks'; END IF;
  EXECUTE v_new;
END $$;

-- The 8D's "where" comes from the machine where the NC was detected.
DO $$
DECLARE v_old text; v_new text;
BEGIN
  v_old := pg_get_functiondef('app.start_capa(uuid,text,text,text,text,uuid)'::regprocedure);
  v_new := replace(v_old, 'SELECT c.name FROM public.ncr_classifications c WHERE c.id = n.detection_process_id', 'SELECT mc.name FROM public.machines mc WHERE mc.id = n.detection_process_id');
  IF v_new = v_old THEN RAISE EXCEPTION 'app.start_capa did not have the expected detection lookup'; END IF;
  EXECUTE v_new;
END $$;

-- ---------------------------------------------------------------------------
-- 3. The legacy objects
-- ---------------------------------------------------------------------------
-- A new organisation no longer gets the legacy starter statuses.
DO $$
DECLARE v_old text; v_new text;
BEGIN
  v_old := pg_get_functiondef('app.create_organisation(text,text,text,text)'::regprocedure);
  v_new := regexp_replace(v_old, '\s*-- Starter NCR statuses[^\n]*\n\s*INSERT INTO public\."Status"[\s\S]*?excluded from reporting''\);', '');
  IF v_new = v_old OR v_new LIKE '%"Status"%' THEN RAISE EXCEPTION 'app.create_organisation did not have the expected legacy status seed'; END IF;
  EXECUTE v_new;
END $$;

DROP VIEW IF EXISTS public.v_nc_files, public.v_ncm_customer, public.v_ncm_internal, public.v_ncm_supplier;
DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('get_nc_date_trend', 'get_nc_kpi_json', 'get_user_notifications') LOOP
    EXECUTE 'DROP FUNCTION ' || f.sig;
  END LOOP;
END $$;

-- One statement, so tables that depend on each other (foreign keys, a policy on one that reads another) go together; still no CASCADE.
DROP TABLE public."Notification Recipients", public."Notifications", public."NC Files", public."Costs", public."NCM", public."8D", public."Addresses", public."Part",
  public."Customers", public."Suppliers", public."Sub-Failure Mode", public."Failure Mode", public."Process", public."Status";
