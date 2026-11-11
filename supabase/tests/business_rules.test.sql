-- Audit report fixes C: what a site-limited person sees; purchasing from unusable suppliers; releasing lots and finishing orders under open non-conformances.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES ('34000000-0000-0000-0000-000000000101', 'owner@br.test'), ('34000000-0000-0000-0000-000000000102', 'site@br.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  u_owner uuid := '34000000-0000-0000-0000-000000000101'; u_site uuid := '34000000-0000-0000-0000-000000000102';
  org uuid; site_a uuid; site_b uuid; m uuid; sup uuid; part uuid; part2 uuid; ord uuid; lot uuid; nc uuid; r text;
BEGIN
  PERFORM pg_temp.login(u_owner);
  org := app.create_organisation('Rules Works', 'Plant A', 'PA', NULL);
  SELECT id INTO site_a FROM public.sites WHERE organisation_id = org;
  INSERT INTO public.sites (organisation_id, code, name) VALUES (org, 'PB', 'Plant B') RETURNING id INTO site_b;
  PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u_site, 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id, site_id) SELECT org, m, id, site_b FROM public.roles WHERE organisation_id = org AND key = 'inspector';

  -- ---- H5: a site-limited inspector holds permissions, though none organisation-wide ----
  PERFORM pg_temp.login(u_site);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.my_permissions(org)), 0::bigint, 'no organisation-wide permissions (this decides who may hand out rights)');
  PERFORM pg_temp.assert_eq((SELECT count(*) > 0 FROM app.my_visible_permissions(org)), true, 'but the menus are told what the person holds somewhere');
  PERFORM pg_temp.assert_eq((SELECT bool_or(p = 'inspection.record') FROM app.my_visible_permissions(org) p), true, 'for example recording inspections');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'inspection.record'), false, 'while the check without a site still says no');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'inspection.record', site_b), true, 'and at their own site yes');
  PERFORM pg_temp.logout();

  -- ---- purchasing ----
  PERFORM pg_temp.login(u_owner);
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'ACME', 'Acme Metals') RETURNING id INTO sup;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'BRK-1', 'Bracket') RETURNING id INTO part;
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.create_purchase_order(%L, 'PO-1', current_date, NULL, jsonb_build_array(jsonb_build_object('partId', %L, 'quantity', 5, 'requestedOn', (current_date + 7)::text)))$q$, sup, part)), 'ok', 'a pending supplier can be ordered from');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($q$UPDATE public.suppliers SET active = false WHERE id = %L$q$, sup)), 5), 'QM020', 'a supplier with an open purchase order cannot be switched off');
  PERFORM app.change_supplier_status(sup, 'disqualified', 'Failed three audits', NULL, NULL);
  r := pg_temp.fails(format($q$SELECT app.create_purchase_order(%L, 'PO-2', current_date, NULL, jsonb_build_array(jsonb_build_object('partId', %L, 'quantity', 5, 'requestedOn', (current_date + 7)::text)))$q$, sup, part));
  PERFORM pg_temp.assert_eq(r LIKE 'QM021:%disqualified and cannot be ordered from%', true, 'a disqualified supplier cannot be ordered from: ' || r);
  PERFORM pg_temp.logout();

  -- ---- lots and orders against open non-conformances (rows made as the superuser, the rules are in the database) ----
  INSERT INTO public.production_orders (organisation_id, order_number, part_id, quantity_planned) VALUES (org, 'WO-1', part, 10) RETURNING id INTO ord;
  INSERT INTO public.lots (organisation_id, lot_number, origin, part_id, production_order_id, quantity) VALUES (org, 'L-1', 'produced', part, ord, 10) RETURNING id INTO lot;
  INSERT INTO public.nonconformances (organisation_id, reference, source, title, severity, quantity_affected, description, stage, category_id, lot_id, production_order_id, part_id)
    SELECT org, 'NC-BR-1', 'internal', 'Open NC', 'minor', 5, 'x', 'open', pg_temp.cat(org), lot, ord, part RETURNING id INTO nc;
  UPDATE public.lots SET status = 'on_hold', status_reason = 'Suspect' WHERE id = lot;
  r := pg_temp.fails(format($q$UPDATE public.lots SET status = 'released' WHERE id = %L$q$, lot));
  PERFORM pg_temp.assert_eq(r LIKE 'QM017:%named by an open non-conformance (NC-BR-1)%', true, 'a held lot with an open NC cannot be released: ' || r);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($q$UPDATE public.lots SET status = 'closed' WHERE id = %L$q$, lot)), 5), 'QM017', 'or closed');
  UPDATE public.production_orders SET status = 'released' WHERE id = ord;
  UPDATE public.production_orders SET status = 'in_progress' WHERE id = ord;
  r := pg_temp.fails(format($q$UPDATE public.production_orders SET status = 'completed' WHERE id = %L$q$, ord));
  PERFORM pg_temp.assert_eq(r LIKE 'QM017:%open non-conformance (NC-BR-1)%', true, 'an order with an open NC cannot be completed: ' || r);
  UPDATE public.nonconformances SET stage = 'cancelled', stage_reason = 'Raised in error' WHERE id = nc;
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$UPDATE public.lots SET status = 'released' WHERE id = %L$q$, lot)), 'ok', 'once the NC is cancelled the lot can be released');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$UPDATE public.production_orders SET status = 'completed' WHERE id = %L$q$, ord)), 'ok', 'and the order completed');
  -- A lot named only among an NC's affected lots counts too.
  INSERT INTO public.lots (organisation_id, lot_number, origin, part_id, production_order_id, quantity) VALUES (org, 'L-2', 'produced', part, ord, 10) RETURNING id INTO lot;
  INSERT INTO public.nonconformances (organisation_id, reference, source, title, severity, quantity_affected, description, stage, category_id, part_id)
    SELECT org, 'NC-BR-2', 'internal', 'Affected lot', 'minor', 5, 'x', 'open', pg_temp.cat(org), part RETURNING id INTO nc;
  INSERT INTO public.ncr_affected_lots (organisation_id, nonconformance_id, lot_id, quantity) VALUES (org, nc, lot, 5);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($q$UPDATE public.lots SET status = 'released' WHERE id = %L$q$, lot)), 5), 'QM017', 'a lot among the affected lots of an open NC cannot be released');

  -- A new order for an inactive part is refused.
  INSERT INTO public.parts (organisation_id, part_number, name, active) VALUES (org, 'OLD-1', 'Obsolete', false) RETURNING id INTO part2;
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($q$INSERT INTO public.production_orders (organisation_id, order_number, part_id, quantity_planned) VALUES (%L, 'WO-9', %L, 1)$q$, org, part2)), 5), 'QM017', 'no new order for an inactive part');
END $$;

ROLLBACK;
