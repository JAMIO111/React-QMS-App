-- Non-conformances: category and source as separate things (docs/ncr-category-source-plan.md, NS1) — eleven seeded categories per organisation (and managed by the organisation),
-- a category needed to open and not clearable once open, existing NCs grandfathered, the source changed only through app.change_ncr_source with a reason (and what that needs),
-- the customer / supplier rules per source, the eleven sources and no others, the 8D source mapping, and the backfill of factual origins.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('3a000000-0000-0000-0000-000000000a01', 'owner@cs.test'), ('3a000000-0000-0000-0000-000000000a02', 'viewer@cs.test'), ('3a000000-0000-0000-0000-000000000a03', 'other@cs.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  u_owner uuid := '3a000000-0000-0000-0000-000000000a01'; u_view uuid := '3a000000-0000-0000-0000-000000000a02'; u_other uuid := '3a000000-0000-0000-0000-000000000a03';
  org uuid; org2 uuid; m uuid; site uuid; cust uuid; sup uuid;
  c_product uuid; c_process uuid; c_other_org uuid; c_new uuid; fm uuid;
  nc uuid; nc2 uuid; nc3 uuid; nc4 uuid; nc5 uuid; nc_old uuid; cap uuid; n int; src text;
  g_type uuid; gauge uuid;
  b_insp uuid; b_audit uuid; b_cal uuid; b_none uuid; b_cust uuid; b_both uuid;
BEGIN
  PERFORM pg_temp.login(u_owner);
  org := app.create_organisation('Source Works', 'Plant A', 'PA', NULL);
  SELECT id INTO site FROM public.sites WHERE organisation_id = org;
  INSERT INTO public.customers (organisation_id, code, name) VALUES (org, 'CUST', 'Acme') RETURNING id INTO cust;
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'SUP', 'Bar Co') RETURNING id INTO sup;
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_other);
  org2 := app.create_organisation('Other Works', 'Plant B', 'PB', NULL);
  PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u_view, 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'viewer';

  -- ---- what the migration did to data that already existed (fixture: an organisation with an NC whose source was the old "inspection") ----
  PERFORM pg_temp.assert_eq((SELECT source FROM public.nonconformances WHERE reference = 'FIX-INSP'), 'production_inspection', 'a stray "inspection" source became production_inspection');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.ncr_classifications c WHERE c.kind = 'category' AND c.organisation_id = (SELECT organisation_id FROM public.nonconformances WHERE reference = 'FIX-INSP')), 11::bigint, 'an organisation that existed already was given the eleven categories');

  -- ---- the eleven categories, for every organisation ----
  PERFORM pg_temp.assert_eq((SELECT string_agg(name, ',' ORDER BY sort_order) FROM public.ncr_classifications WHERE organisation_id = org AND kind = 'category'),
    'Product,Process,Tooling,Equipment,Calibration,Material,Documentation,Inspection,System,Traceability,Packaging & Handling', 'an organisation starts with the eleven categories, in order');
  PERFORM pg_temp.assert_eq((SELECT string_agg(code, ',' ORDER BY sort_order) FROM public.ncr_classifications WHERE organisation_id = org AND kind = 'category'),
    'PRODUCT,PROCESS,TOOLING,EQUIPMENT,CALIBRATION,MATERIAL,DOCUMENTATION,INSPECTION,SYSTEM,TRACEABILITY,PACKAGING', 'each with a stable code');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.ncr_classifications WHERE organisation_id = org2 AND kind = 'category'), 11::bigint, 'including one created later');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.ncr_classifications WHERE organisation_id = org AND kind = 'category' AND active), 11::bigint, 'all in use');
  c_product := pg_temp.cat(org);
  SELECT id INTO c_process FROM public.ncr_classifications WHERE organisation_id = org AND code = 'PROCESS';
  SELECT id INTO c_other_org FROM public.ncr_classifications WHERE organisation_id = org2 AND code = 'PRODUCT';

  -- ---- organisations add their own ----
  PERFORM pg_temp.login(u_view);
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.ncr_classifications (organisation_id, kind, code, name, sort_order) VALUES (%L, 'category', 'X', 'Hacked', 99)$q$, org), 'a viewer cannot add a category');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_owner);
  INSERT INTO public.ncr_classifications (organisation_id, kind, code, name, sort_order) VALUES (org, 'category', 'SOFTWARE', 'Software', 12) RETURNING id INTO c_new;
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.ncr_classifications (organisation_id, kind, name) VALUES (%L, 'category', 'software')$q$, org), 'a name is unique per organisation, whatever its case');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.ncr_classifications SET kind = 'process' WHERE id = %L$q$, c_new), 'the kind never changes');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.ncr_classifications (organisation_id, kind, name, parent_id) VALUES (%L, 'category', 'Sub', %L)$q$, org, c_product), 'a category has no parent');
  PERFORM pg_temp.assert_ok(format($q$UPDATE public.ncr_classifications SET name = 'Software and IT', active = false WHERE id = %L$q$, c_new), 'a category can be renamed and switched off');
  INSERT INTO public.ncr_classifications (organisation_id, kind, name) VALUES (org, 'failure_mode', 'Crack') RETURNING id INTO fm;

  -- ---- a category on a non-conformance ----
  INSERT INTO public.nonconformances (organisation_id, source, title, description, severity, quantity_affected, site_id) VALUES (org, 'internal', 'Burr on bore', 'Burr', 'minor', 3, site) RETURNING id INTO nc;
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$UPDATE public.nonconformances SET category_id = %L WHERE id = %L$q$, fm, nc)) LIKE 'QM005: The category must be one of%', true, 'only a category can be the category');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.nonconformances SET category_id = %L WHERE id = %L$q$, c_other_org, nc), 'nor one of another organisation');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$UPDATE public.nonconformances SET stage = 'open' WHERE id = %L$q$, nc)) LIKE 'QM005: To open this non-conformance, fill in: category', true, 'a category is needed to open');
  UPDATE public.nonconformances SET category_id = c_product WHERE id = nc;
  UPDATE public.nonconformances SET category_id = NULL WHERE id = nc;
  PERFORM pg_temp.assert_eq((SELECT category_id IS NULL FROM public.nonconformances WHERE id = nc), true, 'a draft can have its category taken away');
  UPDATE public.nonconformances SET stage = 'open', category_id = c_product WHERE id = nc;
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.nonconformances WHERE id = nc), 'open', 'opened with a category');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$UPDATE public.nonconformances SET category_id = NULL WHERE id = %L$q$, nc)) LIKE 'QM005: A category can be changed but not cleared%', true, 'once open it cannot be cleared');
  UPDATE public.nonconformances SET category_id = c_process WHERE id = nc;
  PERFORM pg_temp.assert_eq((SELECT category_id = c_process FROM public.nonconformances WHERE id = nc), true, 'but it can be changed');
  PERFORM pg_temp.logout();

  -- existing non-conformances are grandfathered: open with no category, never blocked
  INSERT INTO public.nonconformances (organisation_id, reference, source, stage, title, severity, quantity_affected, description) VALUES (org, 'OLD-1', 'internal', 'open', 'Before categories', 'minor', 1, 'x') RETURNING id INTO nc_old;
  PERFORM pg_temp.login(u_owner);
  UPDATE public.nonconformances SET title = 'Before categories, edited' WHERE id = nc_old;
  PERFORM pg_temp.assert_eq((SELECT title || '/' || (category_id IS NULL)::text FROM public.nonconformances WHERE id = nc_old), 'Before categories, edited/true', 'an existing NC without a category can still be edited');
  PERFORM pg_temp.logout();

  -- ---- the source ----
  PERFORM pg_temp.login(u_owner);
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.nonconformances SET source = 'calibration' WHERE id = %L$q$, nc), 'the source cannot be edited directly');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.nonconformances SET source_change_reason = 'sneaky' WHERE id = %L$q$, nc), 'nor its reason');
  PERFORM pg_temp.logout();
  -- The trigger's own guard, for a session that could write the columns (a privileged role acting as the owner): the source, its reason and the reference still do not change.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$UPDATE public.nonconformances SET source = 'calibration' WHERE id = %L$q$, nc)) LIKE 'QM005: The source of a non-conformance is changed with a reason%', true, 'the trigger refuses a direct edit of the source');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$UPDATE public.nonconformances SET source_change_reason = 'sneaky' WHERE id = %L$q$, nc)) LIKE 'QM005: The source of a non-conformance is changed with a reason%', true, 'and of its reason');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$UPDATE public.nonconformances SET reference = 'X-9' WHERE id = %L$q$, nc)) LIKE 'QM005: The reference of a non-conformance cannot change', true, 'and of the reference');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_owner);
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.change_ncr_source(%L, 'bogus', 'x')$q$, nc)) LIKE 'QM005: Choose a source', true, 'only one of the eleven');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.change_ncr_source(%L, 'internal', 'x')$q$, nc)) LIKE 'QM005: It already has that source', true, 'a different one');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.change_ncr_source(%L, 'calibration', '  ')$q$, nc)) LIKE 'QM005: Say why the source is changed', true, 'with a reason');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_view);
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.change_ncr_source(%L, 'calibration', 'Gauge failed')$q$, nc)) LIKE '42501:%', true, 'a viewer cannot change it');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_other);
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.change_ncr_source(%L, 'calibration', 'Gauge failed')$q$, nc)) LIKE 'P0002:%', true, 'another organisation cannot see it');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_owner);
  PERFORM app.change_ncr_source(nc, 'calibration', 'The bore gauge failed its calibration');
  PERFORM pg_temp.assert_eq((SELECT source || '/' || source_change_reason FROM public.nonconformances WHERE id = nc), 'calibration/The bore gauge failed its calibration', 'changed, with the reason kept on the record');
  PERFORM pg_temp.assert_eq((SELECT stage || '/' || category_id::text = 'open/' || c_process::text FROM public.nonconformances WHERE id = nc), true, 'nothing else moves');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.outbox_events WHERE organisation_id = org AND event_type = 'ncr.source_changed' AND payload->>'from' = 'internal' AND payload->>'to' = 'calibration'), 1::bigint, 'an event says what changed');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_events WHERE organisation_id = org AND entity_type = 'nonconformances' AND entity_id = nc::text AND changed_fields::text LIKE '%source%'), 1::bigint, 'and the audit trail has it');

  -- the party: only customer / supplier need one, and only to open (goods receiving: optional)
  PERFORM pg_temp.login(u_owner);
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.change_ncr_source(%L, 'customer', 'Customer complaint')$q$, nc)) LIKE 'QM005: Choose the customer first%', true, 'an open NC moving to customer needs the customer');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.change_ncr_source(%L, 'supplier', 'Bad bar stock')$q$, nc)) LIKE 'QM005: Choose the supplier first%', true, 'or the supplier');
  PERFORM app.change_ncr_source(nc, 'goods_receiving', 'Found at goods in');
  PERFORM app.change_ncr_source(nc, 'engineering', 'Wrong specification');
  UPDATE public.nonconformances SET customer_id = cust, supplier_id = sup WHERE id = nc;
  PERFORM app.change_ncr_source(nc, 'customer', 'Customer found it too');
  PERFORM app.change_ncr_source(nc, 'management_review', 'Raised at management review');
  PERFORM pg_temp.assert_eq((SELECT (customer_id = cust AND supplier_id = sup)::text FROM public.nonconformances WHERE id = nc), 'true', 'what was entered for another source is kept');

  INSERT INTO public.nonconformances (organisation_id, source, title, description, severity, quantity_affected, site_id, category_id) VALUES (org, 'internal', 'Draft', 'A draft', 'minor', 1, site, c_product) RETURNING id INTO nc2;
  PERFORM app.change_ncr_source(nc2, 'supplier', 'Turns out to be the supplier''s');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$UPDATE public.nonconformances SET stage = 'open' WHERE id = %L$q$, nc2)) LIKE 'QM005: To open this non-conformance, fill in: supplier', true, 'a draft may change source without the party, but cannot open as a supplier NC without one');
  PERFORM app.change_ncr_source(nc2, 'customer', 'Actually the customer');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$UPDATE public.nonconformances SET stage = 'open' WHERE id = %L$q$, nc2)) LIKE 'QM005: To open this non-conformance, fill in: customer', true, 'a customer NC needs the customer');
  PERFORM app.change_ncr_source(nc2, 'goods_receiving', 'Incoming material');
  UPDATE public.nonconformances SET stage = 'open' WHERE id = nc2;
  PERFORM pg_temp.assert_eq((SELECT stage || '/' || (supplier_id IS NULL)::text FROM public.nonconformances WHERE id = nc2), 'open/true', 'goods receiving opens without a supplier');

  -- closed and deleted NCs are not changed
  INSERT INTO public.nonconformances (organisation_id, source, title, description, severity, quantity_affected, site_id, category_id) VALUES (org, 'internal', 'To close', 'x', 'minor', 1, site, c_product) RETURNING id INTO nc3;
  UPDATE public.nonconformances SET stage = 'open' WHERE id = nc3;
  PERFORM pg_temp.settle_ncr(nc3);
  UPDATE public.nonconformances SET stage = 'closed' WHERE id = nc3;
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.change_ncr_source(%L, 'engineering', 'Too late')$q$, nc3)) LIKE 'QM005: This non-conformance is closed%', true, 'a closed NC must be reopened first');
  INSERT INTO public.nonconformances (organisation_id, source, title, site_id) VALUES (org, 'internal', 'To delete', site) RETURNING id INTO nc4;
  UPDATE public.nonconformances SET deleted_at = now(), delete_reason = 'Duplicate' WHERE id = nc4;
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.change_ncr_source(%L, 'engineering', 'x')$q$, nc4)) LIKE 'QM005: This non-conformance is deleted%', true, 'nor a deleted one');
  PERFORM pg_temp.logout();

  -- exactly eleven sources
  FOREACH src IN ARRAY ARRAY['internal', 'customer', 'supplier', 'internal_audit', 'external_audit', 'production_inspection', 'final_inspection', 'calibration', 'goods_receiving', 'engineering', 'management_review'] LOOP
    INSERT INTO public.nonconformances (organisation_id, reference, source, title) VALUES (org, 'S-' || src, src, 'Source ' || src);
  END LOOP;
  PERFORM pg_temp.assert_eq((SELECT count(DISTINCT source) FROM public.nonconformances WHERE title LIKE 'Source %' AND organisation_id = org), 11::bigint, 'all eleven are accepted');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.nonconformances (organisation_id, reference, source, title) VALUES (%L, 'Z-1', 'inspection', 'The old one')$q$, org), 'the old "inspection" value is gone');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.nonconformances (organisation_id, reference, source, title) VALUES (%L, 'Z-2', 'other', 'Nope')$q$, org), 'and nothing else is accepted');

  -- ---- the 8D follows its NC: customer → customer; supplier and goods receiving → supplier; the rest → internal ----
  PERFORM pg_temp.login(u_owner);
  FOREACH src IN ARRAY ARRAY['customer', 'supplier', 'goods_receiving', 'calibration', 'internal_audit', 'engineering'] LOOP
    INSERT INTO public.nonconformances (organisation_id, source, title, description, severity, quantity_affected, site_id) VALUES (org, src, '8D from ' || src, 'x', 'minor', 1, site) RETURNING id INTO nc5;
    cap := app.start_capa(org, NULL, NULL, NULL, NULL, nc5);
    PERFORM pg_temp.assert_eq((SELECT source FROM public.capas WHERE id = cap),
      CASE src WHEN 'customer' THEN 'customer' WHEN 'supplier' THEN 'supplier' WHEN 'goods_receiving' THEN 'supplier' ELSE 'internal' END, '8D source for ' || src);
  END LOOP;
  PERFORM pg_temp.logout();

  -- ---- the backfill: the record that raised an NC says where it came from; nothing is guessed ----
  INSERT INTO public.nonconformances (organisation_id, reference, source, title) VALUES (org, 'R-b_insp', 'internal', 'B insp') RETURNING id INTO b_insp;
  INSERT INTO public.nonconformances (organisation_id, reference, source, title) VALUES (org, 'R-b_audit', 'internal', 'B audit') RETURNING id INTO b_audit;
  INSERT INTO public.nonconformances (organisation_id, reference, source, title) VALUES (org, 'R-b_cal', 'internal', 'B cal') RETURNING id INTO b_cal;
  INSERT INTO public.nonconformances (organisation_id, reference, source, title) VALUES (org, 'R-b_none', 'internal', 'B none') RETURNING id INTO b_none;
  INSERT INTO public.nonconformances (organisation_id, reference, source, title) VALUES (org, 'R-b_cust', 'customer', 'B customer with inspection') RETURNING id INTO b_cust;
  INSERT INTO public.nonconformances (organisation_id, reference, source, title) VALUES (org, 'R-b_both', 'internal', 'B both') RETURNING id INTO b_both;
  INSERT INTO public.gauge_types (organisation_id, name) VALUES (org, 'Caliper') RETURNING id INTO g_type;
  INSERT INTO public.gauges (organisation_id, asset_number, description, gauge_type_id) VALUES (org, 'G-1', 'Caliper', g_type) RETURNING id INTO gauge;
  INSERT INTO public.calibrations (organisation_id, gauge_id, reference, outcome, nonconformance_id) VALUES (org, gauge, 'CAL-X', 'pass', b_cal);
  SET LOCAL session_replication_role = replica;
  INSERT INTO public.inspection_ncr_links (organisation_id, nonconformance_id, inspection_record_id) VALUES (org, b_insp, gen_random_uuid()), (org, b_cust, gen_random_uuid()), (org, b_both, gen_random_uuid());
  INSERT INTO public.audit_ncr_links (organisation_id, audit_record_id, response_id, nonconformance_id) VALUES (org, gen_random_uuid(), gen_random_uuid(), b_audit), (org, gen_random_uuid(), gen_random_uuid(), b_both);
  SET LOCAL session_replication_role = origin;
  PERFORM pg_temp.assert_eq(app.backfill_ncr_sources(), 4, 'four NCs moved');
  PERFORM pg_temp.assert_eq((SELECT string_agg(title || '=' || source, ', ' ORDER BY title) FROM public.nonconformances WHERE title LIKE 'B %'),
    'B audit=internal_audit, B both=production_inspection, B cal=calibration, B customer with inspection=customer, B insp=production_inspection, B none=internal', 'each by the record that raised it; inspection first; customer and unlinked NCs untouched');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.nonconformances WHERE title LIKE 'B %' AND category_id IS NOT NULL), 0::bigint, 'no category is guessed');
  PERFORM pg_temp.assert_eq(app.backfill_ncr_sources(), 0, 'and running it again changes nothing');

  -- ---- tenancy ----
  PERFORM pg_temp.login(u_other);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.ncr_classifications WHERE kind = 'category' AND organisation_id = org), 0::bigint, 'another organisation sees none of the categories');
  PERFORM pg_temp.assert_eq(pg_temp.affected(format($q$UPDATE public.ncr_classifications SET name = 'Hacked' WHERE organisation_id = %L$q$, org)), 0::bigint, 'and cannot change them');
  PERFORM pg_temp.logout();
  SELECT count(*) INTO n FROM public.audit_events WHERE organisation_id = org AND entity_type = 'ncr_classifications';
  PERFORM pg_temp.assert_eq(n > 0, true, 'categories are audited');
END $$;

ROLLBACK;
