-- Integrations: more kinds of record a connection can map and preview — machines, employees, gauge types, gauges and non-conformances
-- (beside suppliers, customers, parts, production orders, purchase orders and goods receipts).
--
-- Only the list changes. The CHECK constraints on the run, inbox, external-record, cursor and mapping tables call
-- app.integration_entity_types(), so a longer list widens them all; every existing row is still in it. Writing these records
-- to Fortress still needs an importer for each (IN4 onwards); until then they can be mapped and previewed only.

CREATE OR REPLACE FUNCTION app.integration_entity_types() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT ARRAY['supplier', 'customer', 'part', 'machine', 'employee', 'gauge_type', 'gauge', 'nonconformance',
               'production_order', 'purchase_order', 'goods_receipt']
$$;

CREATE OR REPLACE FUNCTION app.integration_assert_entity(p_entity text) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
BEGIN
  IF p_entity IS NULL OR NOT (p_entity = ANY (app.integration_entity_types())) THEN
    RAISE EXCEPTION 'Choose what to import: suppliers, customers, parts, machines, employees, gauge types, gauges, non-conformances, production orders, purchase orders or goods receipts'
      USING ERRCODE = 'QM022';
  END IF;
END $$;

REVOKE ALL ON FUNCTION app.integration_entity_types(), app.integration_assert_entity(text) FROM PUBLIC, anon, authenticated;
