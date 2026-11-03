-- Smoke test: the core QMS tables and dashboard functions exist after migrations.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['Organisations','Employees','NCM','Part','Status','Failure Mode','Sub-Failure Mode','Process','Customers','Suppliers','Costs','NC Files'] LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      RAISE EXCEPTION 'missing table public.%', t;
    END IF;
  END LOOP;
  IF to_regprocedure('public.get_nc_kpi_json(timestamptz, timestamptz, text)') IS NULL THEN
    RAISE EXCEPTION 'missing function get_nc_kpi_json';
  END IF;
END $$;

-- get_nc_kpi_json runs against an empty database and returns zero totals.
DO $$
DECLARE r jsonb;
BEGIN
  r := public.get_nc_kpi_json(now() - interval '30 days', now(), 'Internal')::jsonb;
  IF (r -> 'totals' ->> 'record_count')::int <> 0 THEN
    RAISE EXCEPTION 'expected 0 records, got %', r;
  END IF;
END $$;
