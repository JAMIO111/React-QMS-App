-- Linking a non-conformance to a received line afterwards, ending the link, and the model setting that counts supplier NCs with no receipt in the NC-based PPM.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('5c000000-0000-0000-0000-000000000a01', 'ann@rl.test'), ('5c000000-0000-0000-0000-000000000a02', 'bob@rl.test'), ('5c000000-0000-0000-0000-000000000a03', 'eve@rl.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '5c000000-0000-0000-0000-000000000a01'; bob uuid := '5c000000-0000-0000-0000-000000000a02'; eve uuid := '5c000000-0000-0000-0000-000000000a03';
  org uuid; org2 uuid; s uuid; s2 uuid; sb uuid; p1 uuid; p2 uuid; role_id uuid; r jsonb; cfg jsonb; l1 uuid; l2 uuid; l3 uuid; l_other uuid; nc1 uuid; nc2 uuid; nc3 uuid; nc4 uuid; nc5 uuid; k1 uuid; k2 uuid; k5 uuid; made jsonb;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('RL Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('RL Beta'); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, bob, 'active');
  SELECT id INTO role_id FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, ou.id, role_id FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id = bob;
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'ACME', 'Acme Metals') RETURNING id INTO s;
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'BOLT', 'Bolt Co') RETURNING id INTO s2;
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org2, 'BETA', 'Beta Ltd') RETURNING id INTO sb;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'BRK-1', 'Bracket') RETURNING id INTO p1;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'BRK-2', 'Bracket 2') RETURNING id INTO p2;

  PERFORM pg_temp.login(ann);
  r := app.record_goods_receipt(s, NULL, NULL, current_date - 3, 'DN-1', NULL, jsonb_build_array(jsonb_build_object('partId', p1, 'quantity', 100), jsonb_build_object('partId', p1, 'quantity', 100), jsonb_build_object('partId', p2, 'quantity', 100)), NULL);
  SELECT id INTO l1 FROM public.goods_receipt_lines WHERE goods_receipt_id = (r ->> 'id')::uuid AND line_number = 1;
  SELECT id INTO l2 FROM public.goods_receipt_lines WHERE goods_receipt_id = (r ->> 'id')::uuid AND line_number = 2;
  SELECT id INTO l3 FROM public.goods_receipt_lines WHERE goods_receipt_id = (r ->> 'id')::uuid AND line_number = 3;
  r := app.record_goods_receipt(s2, NULL, NULL, current_date - 3, 'DN-2', NULL, jsonb_build_array(jsonb_build_object('partId', p1, 'quantity', 10)), NULL);
  SELECT id INTO l_other FROM public.goods_receipt_lines WHERE goods_receipt_id = (r ->> 'id')::uuid;
  INSERT INTO public.nonconformances (organisation_id, source, title, description, severity, quantity_affected, supplier_id, part_id) VALUES (org, 'supplier', 'Bent', 'x', 'minor', 30, s, p1) RETURNING id INTO nc1;
  INSERT INTO public.nonconformances (organisation_id, source, title, description, severity, quantity_affected, supplier_id) VALUES (org, 'supplier', 'Wrong finish', 'x', 'minor', 20, s) RETURNING id INTO nc2;
  INSERT INTO public.nonconformances (organisation_id, source, title, description, severity, supplier_id) VALUES (org, 'supplier', 'Paperwork', 'x', 'minor', s) RETURNING id INTO nc3;
  INSERT INTO public.nonconformances (organisation_id, source, title, description, severity, quantity_affected, supplier_id, part_id) VALUES (org, 'supplier', 'Other supplier', 'x', 'minor', 5, s2, p1) RETURNING id INTO nc4;
  INSERT INTO public.nonconformances (organisation_id, source, title, description, severity, quantity_affected, supplier_id, part_id) VALUES (org, 'supplier', 'Big', 'x', 'major', 500, s, p1) RETURNING id INTO nc5;
  PERFORM pg_temp.logout();

  -- ---- nothing linked: the unlinked pieces are reported apart and, by default, not counted ----
  PERFORM pg_temp.login(ann);
  r := app.supplier_performance(s, current_date - 60, current_date) -> 'metrics' -> 'ppmNc';
  PERFORM pg_temp.assert_eq((r ->> 'receivedUnits')::numeric, 300::numeric, 'received units');
  PERFORM pg_temp.assert_eq((r ->> 'unlinkedUnits')::numeric, 550::numeric, 'pieces on supplier NCs with no receipt are reported');
  PERFORM pg_temp.assert_eq((r ->> 'unlinkedNcs')::int, 4, 'on four non-conformances (the other supplier''s is not included)');
  PERFORM pg_temp.assert_eq((r ->> 'unlinkedWithoutQuantity')::int, 1, 'one has no quantity entered');
  PERFORM pg_temp.assert_eq((r ->> 'value')::numeric, 0::numeric, 'but they do not count by default');
  PERFORM pg_temp.assert_eq(r ->> 'includeUnlinked', 'false', 'the setting is off');

  -- ---- the model setting ----
  SELECT config INTO cfg FROM public.supplier_scorecard_models WHERE organisation_id = org ORDER BY version DESC LIMIT 1;
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.save_supplier_scorecard_model(%L, %L::jsonb, 'bad')$f$, org, cfg || '{"ppm_nc_include_unlinked":"yes"}')), 5), 'QM020', 'the setting is true or false');
  PERFORM app.save_supplier_scorecard_model(org, cfg || '{"ppm_nc_include_unlinked":true,"ppm_basis":"ncs","min_lines":1}'::jsonb, 'Count NCs with no receipt too');
  r := app.supplier_performance(s, current_date - 60, current_date);
  PERFORM pg_temp.assert_eq((r -> 'metrics' -> 'ppmNc' ->> 'value')::numeric, round(550 / 300.0 * 1000000, 0), 'with the setting on they are counted');
  PERFORM pg_temp.assert_eq((r -> 'metrics' -> 'ppmNc' ->> 'affectedUnits')::numeric, 550::numeric, 'in the affected units');
  PERFORM pg_temp.assert_eq((SELECT w ->> 'detail' FROM jsonb_array_elements(r -> 'components') w WHERE w ->> 'key' = 'ppm') LIKE '%550 on 4 with no receipt linked%', true, 'and the score says how much of it has no receipt');
  PERFORM pg_temp.assert_eq((r -> 'metrics' -> 'ppm' ->> 'value')::numeric, 0::numeric, 'the rejected-at-receiving PPM is untouched');

  -- ---- linking ----
  PERFORM pg_temp.logout(); PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.link_ncr_to_receipt_line(%L, %L)$f$, nc1, l1)), 5), '42501', 'a viewer cannot link');
  PERFORM pg_temp.logout(); PERFORM pg_temp.login(eve);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.link_ncr_to_receipt_line(%L, %L)$f$, nc1, l1)), 5), 'P0002', 'another organisation cannot find it');
  PERFORM pg_temp.logout(); PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.link_ncr_to_receipt_line(%L, %L)$f$, nc1, l_other)), 5), 'QM021', 'a receipt from another supplier is refused');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.link_ncr_to_receipt_line(%L, %L)$f$, nc1, l3)), 5), 'QM021', 'so is a line for a different part');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.link_ncr_to_receipt_line(%L, %L)$f$, nc4, l1)), 5), 'QM021', 'and a non-conformance of another supplier');
  k1 := app.link_ncr_to_receipt_line(nc1, l1);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.link_ncr_to_receipt_line(%L, %L)$f$, nc1, l2)), 5), 'QM021', 'a non-conformance sits on one received line only, so its pieces are never counted twice');
  k5 := app.link_ncr_to_receipt_line(nc5, l2);
  r := app.supplier_performance(s, current_date - 60, current_date) -> 'metrics' -> 'ppmNc';
  PERFORM pg_temp.assert_eq((r ->> 'linkedUnits')::numeric, 130::numeric, 'linked pieces count against the line: 30, and 500 capped at the 100 received');
  PERFORM pg_temp.assert_eq((r ->> 'unlinkedUnits')::numeric, 20::numeric, 'what is left unlinked is reported');
  PERFORM pg_temp.assert_eq((r ->> 'unlinkedNcs')::int, 2, 'two NCs');
  PERFORM pg_temp.assert_eq((r ->> 'value')::numeric, round(150 / 300.0 * 1000000, 0), 'with the setting on, linked and unlinked pieces both count');
  PERFORM app.save_supplier_scorecard_model(org, (SELECT config FROM public.supplier_scorecard_models WHERE organisation_id = org ORDER BY version DESC LIMIT 1) || '{"ppm_nc_include_unlinked":false}'::jsonb, 'Linked only again');
  r := app.supplier_performance(s, current_date - 60, current_date) -> 'metrics' -> 'ppmNc';
  PERFORM pg_temp.assert_eq((r ->> 'affectedUnits')::numeric, 130::numeric, 'with the setting off only linked pieces count');
  PERFORM pg_temp.assert_eq((r ->> 'unlinkedUnits')::numeric, 20::numeric, 'and the unlinked ones are still shown');

  -- ---- ending a link ----
  PERFORM pg_temp.logout(); PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.unlink_ncr_from_receipt_line(%L, 'Wrong line')$f$, k1)), 5), '42501', 'a viewer cannot end a link');
  PERFORM pg_temp.logout(); PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.unlink_ncr_from_receipt_line(%L, 'no')$f$, k1)), 5), 'QM021', 'ending a link needs a reason');
  PERFORM app.unlink_ncr_from_receipt_line(k1, 'Linked to the wrong line');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.unlink_ncr_from_receipt_line(%L, 'Again')$f$, k1)), 5), 'QM021', 'a link ends once');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$DELETE FROM public.receipt_line_ncrs WHERE id = %L$f$, k1)), 5), '42501', 'nobody deletes a link through the API');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$DELETE FROM public.receipt_line_ncrs WHERE id = %L$f$, k1)), 5), 'QM021', 'and not even SQL can: a link is never deleted');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$UPDATE public.receipt_line_ncrs SET receipt_line_id = %L WHERE id = %L$f$, l3, k5)), 5), 'QM021', 'its line cannot be changed');
  PERFORM pg_temp.login(ann);
  r := app.supplier_performance(s, current_date - 60, current_date) -> 'metrics' -> 'ppmNc';
  PERFORM pg_temp.assert_eq((r ->> 'linkedUnits')::numeric, 100::numeric, 'an ended link no longer counts');
  PERFORM pg_temp.assert_eq((r ->> 'unlinkedNcs')::int, 3, 'and the NC is unlinked again');
  PERFORM app.link_ncr_to_receipt_line(nc1, l2);
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.receipt_line_ncrs WHERE ncr_id = nc1), 2, 'it can be linked again; the ended link stays on record');

  -- ---- raising an NC from a line looks only at live links ----
  made := app.raise_ncr_from_receipt_line(l3, 'Raised here', NULL, 'minor', NULL, NULL);
  PERFORM pg_temp.assert_eq(made ->> 'created', 'true', 'an NC is raised from a line');
  PERFORM pg_temp.assert_eq(app.raise_ncr_from_receipt_line(l3, 'Raised again', NULL, 'minor', NULL, NULL) ->> 'created', 'false', 'raising again returns the same one');
  PERFORM app.unlink_ncr_from_receipt_line((SELECT id FROM public.receipt_line_ncrs WHERE ncr_id = (made ->> 'nonconformanceId')::uuid AND ended_at IS NULL), 'Raised from the wrong line');
  PERFORM pg_temp.assert_eq(app.raise_ncr_from_receipt_line(l3, 'Raised once more', NULL, 'minor', NULL, NULL) ->> 'created', 'true', 'after the link ended a new one can be raised');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
