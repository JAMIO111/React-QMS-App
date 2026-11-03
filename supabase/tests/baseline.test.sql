-- Smoke test: the core QMS tables and dashboard functions exist after all migrations.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['organisations','Employees','NCM','Part','Status','Failure Mode','Sub-Failure Mode','Process','Customers','Suppliers','Costs','NC Files'] LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      RAISE EXCEPTION 'missing table public.%', t;
    END IF;
  END LOOP;
  IF to_regprocedure('public.get_nc_kpi_json(uuid, timestamptz, timestamptz, text)') IS NULL THEN
    RAISE EXCEPTION 'missing function get_nc_kpi_json';
  END IF;
END $$;

-- get_nc_kpi_json returns zero totals for an organisation with no NCRs.
DO $$
DECLARE r jsonb;
BEGIN
  r := public.get_nc_kpi_json(gen_random_uuid(), now() - interval '30 days', now(), 'Internal')::jsonb;
  IF (r -> 'totals' ->> 'record_count')::int <> 0 THEN
    RAISE EXCEPTION 'expected 0 records, got %', r;
  END IF;
END $$;
