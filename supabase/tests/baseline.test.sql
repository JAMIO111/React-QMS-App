-- Smoke test: the core tables exist after all migrations, and the original (legacy) tables, views and functions are gone.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['organisations', 'Employees', 'nonconformances', 'parts', 'customers', 'suppliers', 'machines', 'ncr_classifications', 'ncr_costs', 'ncr_attachments'] LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      RAISE EXCEPTION 'missing table public.%', t;
    END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['NCM', '8D', 'Costs', 'NC Files', 'Part', 'Status', 'Failure Mode', 'Sub-Failure Mode', 'Process', 'Customers', 'Suppliers', 'Addresses', 'Notifications', 'Notification Recipients',
                           'v_nc_files', 'v_ncm_customer', 'v_ncm_internal', 'v_ncm_supplier'] LOOP
    IF to_regclass(format('public.%I', t)) IS NOT NULL THEN
      RAISE EXCEPTION 'the legacy table or view public.% is still there', t;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('get_nc_kpi_json', 'get_nc_date_trend', 'get_user_notifications')) THEN
    RAISE EXCEPTION 'a legacy function is still there';
  END IF;
END $$;
