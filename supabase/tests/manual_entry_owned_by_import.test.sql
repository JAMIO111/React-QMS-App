-- Orders and deliveries entered by hand are refused while a scheduled import of that kind is on (QM039), and only then: the import itself, a schedule that is
-- off, a connection that is paused, an archived template, another organisation and the other kinds stay free.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES ('6a700000-0000-0000-0000-000000000a01', 'ann@manualowned.test'), ('6a700000-0000-0000-0000-000000000a02', 'eve@manualowned.test'),
  ('6a700000-0000-0000-0000-000000000a03', 'val@manualowned.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

CREATE FUNCTION pg_temp.po(p_user uuid, p_supplier uuid, p_number text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  PERFORM pg_temp.login(p_user);
  v := pg_temp.fails(format($f$SELECT app.create_purchase_order(%L, %L, current_date, NULL, '[{"material":"steel","quantity":10,"requestedOn":"2031-01-01"}]'::jsonb)$f$, p_supplier, p_number));
  PERFORM pg_temp.logout();
  RETURN left(v, 5);
END $$;

CREATE FUNCTION pg_temp.delivery(p_user uuid, p_supplier uuid) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  PERFORM pg_temp.login(p_user);
  v := pg_temp.fails(format($f$SELECT app.record_goods_receipt(%L, NULL, NULL, current_date, 'DN-1', NULL, '[{"material":"steel","quantity":5}]'::jsonb, NULL)$f$, p_supplier));
  PERFORM pg_temp.logout();
  RETURN left(v, 5);
END $$;

CREATE FUNCTION pg_temp.managed(p_user uuid, p_org uuid) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  PERFORM pg_temp.login(p_user);
  SELECT coalesce(string_agg(area || '=' || connection_name, ',' ORDER BY area), '') INTO v FROM app.import_managed_areas(p_org);
  PERFORM pg_temp.logout();
  RETURN v;
END $$;

DO $$
DECLARE
  ann uuid := '6a700000-0000-0000-0000-000000000a01'; eve uuid := '6a700000-0000-0000-0000-000000000a02'; val uuid := '6a700000-0000-0000-0000-000000000a03';
  org uuid; org2 uuid; api uuid; s uuid; s2 uuid; tpl uuid; tpl_rec uuid; v_err text; cust uuid; prt uuid; tpl_co uuid; tpl_sh uuid;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('Manual Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('Manual Beta'); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, val, 'active');   -- a member with no role at all
  PERFORM pg_temp.give_controller_seat(org, ann);
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'STEEL', 'Steel Co') RETURNING id INTO s;
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org2, 'BEAT', 'Beta Supply') RETURNING id INTO s2;

  PERFORM pg_temp.login(ann);
  api := app.create_integration_connection(org, 'rest_api', 'ERP', 'erp', '{"baseUrl": "https://erp.example.com", "authType": "none"}'::jsonb);
  PERFORM app.record_integration_connection_test(api, true, 'ok');
  PERFORM app.mark_integration_ready(api);
  PERFORM app.activate_integration_connection(api);
  PERFORM app.set_integration_import_settings(api, 'purchase_order', '{"writeMode": "add_update"}'::jsonb);
  PERFORM app.set_integration_import_settings(api, 'goods_receipt', '{"writeMode": "add_only"}'::jsonb);
  tpl := app.create_integration_template(org, 'purchase_order', 'ERP orders', NULL, jsonb_build_object('keyField', 'Id', 'settings', '{"writeMode": "add_update"}'::jsonb,
    'fields', '[{"target": "orderNumber", "source": "No"}]'::jsonb));
  tpl_rec := app.create_integration_template(org, 'goods_receipt', 'ERP deliveries', NULL, jsonb_build_object('keyField', 'Id', 'settings', '{"writeMode": "add_only"}'::jsonb,
    'fields', '[{"target": "supplier", "source": "Vendor"}]'::jsonb));
  PERFORM pg_temp.logout();

  -- ---- nothing is imported on a schedule: hand entry is open ----
  PERFORM pg_temp.assert_eq(pg_temp.po(ann, s, 'PO-HAND-1'), 'ok', 'an order can be entered by hand with no schedule');
  PERFORM pg_temp.assert_eq(pg_temp.delivery(ann, s), 'ok', 'and so can a delivery');
  PERFORM pg_temp.assert_eq(pg_temp.managed(ann, org), '', 'nothing is reported as managed');

  -- ---- a schedule on a template for orders: orders are closed to hand entry, deliveries still open ----
  UPDATE public.integration_import_settings SET schedule = 'daily', template_id = tpl WHERE connection_id = api AND entity_type = 'purchase_order';
  PERFORM pg_temp.assert_eq(pg_temp.po(ann, s, 'PO-HAND-2'), 'QM039', 'a scheduled import of orders refuses an order typed by hand');
  PERFORM pg_temp.assert_eq(pg_temp.delivery(ann, s), 'ok', 'deliveries are a different kind and stay open');
  PERFORM pg_temp.assert_eq(pg_temp.managed(ann, org), 'purchase_orders=ERP', 'the screen is told, with the connection name');
  PERFORM pg_temp.assert_eq(pg_temp.managed(val, org), '', 'a member who cannot read receiving is told nothing');
  PERFORM pg_temp.assert_eq(pg_temp.managed(eve, org), '', 'another organisation sees nothing of it');
  PERFORM pg_temp.assert_eq(pg_temp.po(eve, s2, 'PO-OTHER'), 'ok', 'and is not blocked by it');

  PERFORM pg_temp.login(ann);
  v_err := pg_temp.fails(format($f$SELECT app.create_purchase_order(%L, 'PO-HAND-3', current_date, NULL, '[{"material":"steel","quantity":10,"requestedOn":"2031-01-01"}]'::jsonb)$f$, s));
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(v_err LIKE '%ERP%schedule%', true, 'the message names the connection');

  -- ---- the import itself writes orders ----
  PERFORM pg_temp.login(ann);
  PERFORM set_config('app.source', 'integration', true);
  PERFORM app.create_purchase_order(s, 'PO-IMPORTED', current_date, NULL, '[{"material":"steel","quantity":10,"requestedOn":"2031-01-01"}]'::jsonb);
  PERFORM set_config('app.source', '', true);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.purchase_orders WHERE organisation_id = org AND po_number = 'PO-IMPORTED'), 1, 'the import is exempt');

  -- ---- deliveries follow their own kinds (a running total counts too) ----
  UPDATE public.integration_import_settings SET schedule = 'manual' WHERE connection_id = api AND entity_type = 'purchase_order';
  PERFORM pg_temp.assert_eq(pg_temp.po(ann, s, 'PO-HAND-4'), 'ok', 'switching the schedule off opens hand entry at once');
  UPDATE public.integration_import_settings SET schedule = 'every_15m', template_id = tpl_rec WHERE connection_id = api AND entity_type = 'goods_receipt';
  PERFORM pg_temp.assert_eq(pg_temp.delivery(ann, s), 'QM039', 'a scheduled import of deliveries refuses one typed by hand');
  PERFORM pg_temp.assert_eq(pg_temp.po(ann, s, 'PO-HAND-5'), 'ok', 'orders stay open');
  PERFORM pg_temp.assert_eq(pg_temp.managed(ann, org), 'receipts=ERP', 'any schedule counts, not only daily');

  -- ---- states where no schedule really runs ----
  UPDATE public.integration_connections SET status = 'paused' WHERE id = api;
  PERFORM pg_temp.assert_eq(pg_temp.delivery(ann, s), 'ok', 'a paused connection frees hand entry');
  UPDATE public.integration_connections SET status = 'active' WHERE id = api;
  PERFORM pg_temp.assert_eq(pg_temp.delivery(ann, s), 'QM039', 'and an active one owns it again');
  UPDATE public.integration_templates SET archived_at = now(), archive_reason = 'old' WHERE id = tpl_rec;
  PERFORM pg_temp.assert_eq(pg_temp.delivery(ann, s), 'ok', 'an archived template frees hand entry');
  UPDATE public.integration_templates SET archived_at = NULL, archive_reason = NULL WHERE id = tpl_rec;
  UPDATE public.integration_import_settings SET template_id = NULL WHERE connection_id = api AND entity_type = 'goods_receipt';
  PERFORM pg_temp.assert_eq(pg_temp.delivery(ann, s), 'ok', 'a schedule with no template owns nothing');

  -- ---- customer orders and shipments follow the same rule (their kinds are importable now) ----
  INSERT INTO public.customers (organisation_id, code, name) VALUES (org, 'ACME', 'Acme Motors') RETURNING id INTO cust;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'P-1', 'Bracket') RETURNING id INTO prt;
  PERFORM pg_temp.login(ann);
  PERFORM app.set_integration_import_settings(api, 'customer_order', '{"writeMode": "add_update"}'::jsonb);
  PERFORM app.set_integration_import_settings(api, 'shipment', '{"writeMode": "add_only"}'::jsonb);
  tpl_co := app.create_integration_template(org, 'customer_order', 'ERP customer orders', NULL, jsonb_build_object('keyField', 'Id', 'settings', '{"writeMode": "add_update"}'::jsonb,
    'fields', '[{"target": "orderNumber", "source": "No"}]'::jsonb));
  tpl_sh := app.create_integration_template(org, 'shipment', 'ERP shipments', NULL, jsonb_build_object('keyField', 'Id', 'settings', '{"writeMode": "add_only"}'::jsonb,
    'fields', '[{"target": "quantity", "source": "Qty"}]'::jsonb));
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_customer_order(%L, 'CO-1', NULL, current_date, NULL, '[{"partId":"%s","quantity":1,"requestedOn":"2031-01-01"}]'::jsonb)$f$, cust, prt)), 5), 'ok', 'a customer order can be typed while no schedule is on');
  PERFORM pg_temp.logout();
  UPDATE public.integration_import_settings SET schedule = 'daily', template_id = tpl_co WHERE connection_id = api AND entity_type = 'customer_order';
  UPDATE public.integration_import_settings SET schedule = 'daily', template_id = tpl_sh WHERE connection_id = api AND entity_type = 'shipment';
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_customer_order(%L, 'CO-2', NULL, current_date, NULL, '[{"partId":"%s","quantity":1,"requestedOn":"2031-01-01"}]'::jsonb)$f$, cust, prt)), 5), 'QM039', 'a scheduled import of customer orders refuses one typed by hand');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_shipment(%L, NULL, NULL, current_date, 'DN-1', NULL, '[{"partId":"%s","quantity":1}]'::jsonb, NULL)$f$, cust, prt)), 5), 'QM039', 'and so does one of shipments');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(pg_temp.managed(ann, org), 'customer_orders=ERP,shipments=ERP', 'the screen is told about all of them');
  UPDATE public.integration_import_settings SET schedule = 'manual' WHERE connection_id = api AND entity_type IN ('customer_order', 'shipment');
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_shipment(%L, NULL, NULL, current_date, 'DN-2', NULL, '[{"partId":"%s","quantity":1}]'::jsonb, NULL)$f$, cust, prt)), 5), 'ok', 'switching the schedules off opens both again');
  PERFORM pg_temp.logout();

  -- ---- nobody can call the rule or the guard directly ----
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.import_owner(%L, ARRAY['purchase_order'])$f$, org)), 5), '42501', 'the rule is not callable by people');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
