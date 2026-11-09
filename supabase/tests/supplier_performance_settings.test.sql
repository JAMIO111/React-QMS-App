-- Supplier performance settings: both PPM measures, the quantity on a rejection, grace days before and after, in-full tolerances and OTIF,
-- the PPM basis in the model, per-supplier overrides (and that a saved scorecard freezes the effective configuration), permissions, validation and tenant isolation.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('5b000000-0000-0000-0000-000000000a01', 'ann@ps.test'), ('5b000000-0000-0000-0000-000000000a02', 'bob@ps.test'), ('5b000000-0000-0000-0000-000000000a03', 'eve@ps.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '5b000000-0000-0000-0000-000000000a01'; bob uuid := '5b000000-0000-0000-0000-000000000a02'; eve uuid := '5b000000-0000-0000-0000-000000000a03';
  org uuid; org2 uuid; s uuid; sb uuid; p1 uuid; role_id uuid; po uuid; r jsonb; cfg jsonb; gr uuid; line uuid; sc uuid; i integer;
  -- five order lines: (received offset, requested offset, ordered, received quantity)
  recv integer[] := ARRAY[-20, -17, -22, -20, -10]; req integer[] := ARRAY[-20, -20, -20, -20, -10]; ord numeric[] := ARRAY[100, 100, 100, 100, 100]; got numeric[] := ARRAY[100, 100, 100, 90, 120];
  lines jsonb := '[]'::jsonb; l1 uuid; l2 uuid; l4 uuid;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('PS Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('PS Beta'); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, bob, 'active');
  SELECT id INTO role_id FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, ou.id, role_id FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id = bob;
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'ACME', 'Acme Metals') RETURNING id INTO s;
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org2, 'BETA', 'Beta Ltd') RETURNING id INTO sb;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'BRK-1', 'Bracket') RETURNING id INTO p1;

  PERFORM pg_temp.login(ann);
  FOR i IN 1..5 LOOP
    lines := lines || jsonb_build_array(jsonb_build_object('material', 'Steel ' || i, 'quantity', ord[i], 'requestedOn', (current_date + req[i])::text));
  END LOOP;
  po := app.create_purchase_order(s, 'PO-PS-1', current_date - 40, NULL, lines);
  FOR i IN 1..5 LOOP
    SELECT id INTO line FROM public.purchase_order_lines WHERE purchase_order_id = po AND line_number = i;
    gr := ((app.record_goods_receipt(s, po, NULL, current_date + recv[i], 'DN-' || i, NULL, jsonb_build_array(jsonb_build_object('poLineId', line, 'quantity', got[i])), NULL)) ->> 'id')::uuid;
    IF i = 1 THEN l1 := (SELECT id FROM public.goods_receipt_lines WHERE goods_receipt_id = gr); END IF;
    IF i = 2 THEN l2 := (SELECT id FROM public.goods_receipt_lines WHERE goods_receipt_id = gr); END IF;
    IF i = 4 THEN l4 := (SELECT id FROM public.goods_receipt_lines WHERE goods_receipt_id = gr); END IF;
  END LOOP;

  -- ---- the quantity on a rejection ----
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.disposition_receipt_line(%L, 'accepted', NULL, NULL, 5)$f$, l1)), 5), 'QM021', 'a quantity belongs to a rejection only');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.disposition_receipt_line(%L, 'rejected', 'Bad', NULL, 0)$f$, l1)), 5), 'QM021', 'a rejected quantity is above zero');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.disposition_receipt_line(%L, 'rejected', 'Bad', NULL, 101)$f$, l1)), 5), 'QM021', 'and no more than was received');
  PERFORM app.disposition_receipt_line(l1, 'rejected', 'Twenty of the hundred were out of tolerance', NULL, 20);
  PERFORM app.disposition_receipt_line(l4, 'rejected', 'The whole line was wrong', NULL);
  -- non-conformances raised from two receipt lines (the NC measure counts the pieces on them, once per line)
  PERFORM app.raise_ncr_from_receipt_line(l1, 'Out of tolerance', NULL, 'minor', NULL, 30);
  PERFORM app.raise_ncr_from_receipt_line(l2, 'Late and damaged', NULL, 'minor', NULL, 40);

  -- ---- both PPM measures, kept apart ----
  r := app.supplier_performance(s, current_date - 60, current_date);
  PERFORM pg_temp.assert_eq((r -> 'metrics' -> 'ppm' ->> 'receivedUnits')::numeric, 510::numeric, 'received units');
  PERFORM pg_temp.assert_eq((r -> 'metrics' -> 'ppm' ->> 'rejectedUnits')::numeric, 110::numeric, 'a part-rejected line counts only its rejected quantity, a whole rejection counts whole');
  PERFORM pg_temp.assert_eq((r -> 'metrics' -> 'ppm' ->> 'value')::numeric, 215686::numeric, 'rejected PPM');
  PERFORM pg_temp.assert_eq((r -> 'metrics' -> 'ppmNc' ->> 'affectedUnits')::numeric, 70::numeric, 'units on linked non-conformances, once per line');
  PERFORM pg_temp.assert_eq((r -> 'metrics' -> 'ppmNc' ->> 'value')::numeric, 137255::numeric, 'NC-based PPM');
  PERFORM pg_temp.assert_eq((r -> 'metrics' -> 'ppmNc' ->> 'lines')::int, 2, 'on two lines');
  PERFORM pg_temp.assert_eq((SELECT w ->> 'detail' FROM jsonb_array_elements(r -> 'components') w WHERE w ->> 'key' = 'ppm') LIKE '%units rejected%', true, 'the default scores the rejected measure');

  -- ---- on time and in full under the defaults (early is never late; no days late allowed; in full = the ordered quantity, up to 10% over) ----
  PERFORM pg_temp.assert_eq((r -> 'metrics' -> 'otd' ->> 'onTime')::int, 4, 'on time: lines 1, 3, 4 and 5 (line 3 is early, which is allowed by default)');
  PERFORM pg_temp.assert_eq((r -> 'metrics' -> 'otd' ->> 'late')::int, 1, 'one line late');
  PERFORM pg_temp.assert_eq((r -> 'metrics' -> 'otd' ->> 'early')::int, 0, 'none counts as too early');
  PERFORM pg_temp.assert_eq((r -> 'metrics' -> 'inFull' ->> 'inFull')::int, 2, 'in full: lines 1 and 3');
  PERFORM pg_temp.assert_eq((r -> 'metrics' -> 'inFull' ->> 'short')::int, 2, 'short: line 2 (nothing by its due date) and line 4 (90 of 100)');
  PERFORM pg_temp.assert_eq((r -> 'metrics' -> 'inFull' ->> 'over')::int, 1, 'over: line 5 (120 of 100)');
  PERFORM pg_temp.assert_eq((r -> 'metrics' -> 'otif' ->> 'otif')::int, 2, 'OTIF: lines 1 and 3 were in full');
  PERFORM pg_temp.assert_eq((SELECT w ->> 'weight' FROM jsonb_array_elements(r -> 'components') w WHERE w ->> 'key' = 'in_full'), '0', 'in full is shown but not scored until it has a weight');

  -- ---- the model: PPM basis, grace days, in-full weight ----
  SELECT config INTO cfg FROM public.supplier_scorecard_models WHERE organisation_id = org ORDER BY version DESC LIMIT 1;
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.save_supplier_scorecard_model(%L, %L::jsonb, 'bad')$f$, org, cfg || '{"ppm_basis":"vibes"}')), 5), 'QM020', 'an unknown PPM basis is refused');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.save_supplier_scorecard_model(%L, %L::jsonb, 'bad')$f$, org, cfg || '{"grace_days_after":61}')), 5), 'QM020', 'grace days are at most 60');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.save_supplier_scorecard_model(%L, %L::jsonb, 'bad')$f$, org, cfg || '{"in_full_over_pct":101}')), 5), 'QM020', 'a tolerance is a percentage');
  -- a strict model first: nothing may be early or late
  PERFORM app.save_supplier_scorecard_model(org, cfg || '{"grace_days_before":0}'::jsonb, 'No early deliveries either');
  r := app.supplier_performance(s, current_date - 60, current_date);
  PERFORM pg_temp.assert_eq((r -> 'metrics' -> 'otd' ->> 'onTime')::int, 3, 'with no days early allowed line 3 is not on time');
  PERFORM pg_temp.assert_eq((r -> 'metrics' -> 'otd' ->> 'early')::int, 1, 'it is early');
  PERFORM pg_temp.assert_eq((r -> 'metrics' -> 'otif' ->> 'otif')::int, 1, 'and only line 1 is on time in full');
  SELECT config INTO cfg FROM public.supplier_scorecard_models WHERE organisation_id = org ORDER BY version DESC LIMIT 1;
  PERFORM app.save_supplier_scorecard_model(org, cfg || '{"ppm_basis":"ncs","grace_days_before":3,"grace_days_after":3}'::jsonb || jsonb_build_object('weights', cfg -> 'weights' || '{"in_full":20}'), 'Score NC PPM, allow three days either way, count in full');
  r := app.supplier_performance(s, current_date - 60, current_date);
  PERFORM pg_temp.assert_eq((SELECT w ->> 'detail' FROM jsonb_array_elements(r -> 'components') w WHERE w ->> 'key' = 'ppm') LIKE '%from non-conformances%', true, 'the NC basis now scores PPM');
  PERFORM pg_temp.assert_eq((r -> 'metrics' -> 'ppm' ->> 'value')::numeric, 215686::numeric, 'and the rejected figure is still worked out');
  PERFORM pg_temp.assert_eq((r -> 'metrics' -> 'otd' ->> 'onTime')::int, 5, 'three days of grace on either side makes all five lines on time');
  PERFORM pg_temp.assert_eq((r -> 'metrics' -> 'otd' ->> 'early')::int, 0, 'none is early');
  PERFORM pg_temp.assert_eq((r -> 'metrics' -> 'inFull' ->> 'inFull')::int, 3, 'with the grace the late delivery counts toward in full: lines 1, 2 and 3');
  PERFORM pg_temp.assert_eq((SELECT (w ->> 'sufficient')::boolean FROM jsonb_array_elements(r -> 'components') w WHERE w ->> 'key' = 'in_full'), true, 'and in full is now scored');

  -- ---- per-supplier overrides ----
  PERFORM pg_temp.logout(); PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.set_supplier_performance_settings(%L, '{"graceDaysAfter":1}'::jsonb)$f$, s)), 5), '42501', 'a viewer cannot change a supplier''s settings');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.supplier_performance_settings), 0, 'and there are none yet');
  PERFORM pg_temp.logout(); PERFORM pg_temp.login(eve);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.set_supplier_performance_settings(%L, '{"graceDaysAfter":1}'::jsonb)$f$, s)), 5), 'P0002', 'another organisation cannot find the supplier');
  PERFORM pg_temp.logout(); PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.set_supplier_performance_settings(%L, '{"nonsense":1}'::jsonb)$f$, s)), 5), 'QM020', 'an unknown setting is refused');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.set_supplier_performance_settings(%L, '{"graceDaysAfter":61}'::jsonb)$f$, s)), 5), 'QM020', 'grace days over 60 are refused');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.set_supplier_performance_settings(%L, '{"otdPolicy":"whenever"}'::jsonb)$f$, s)), 5), 'QM020', 'an unknown date policy is refused');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$INSERT INTO public.supplier_performance_settings (organisation_id, supplier_id, grace_days_after) VALUES (%L, %L, 1)$f$, org, s)), 5), '42501', 'nothing writes the table directly');
  -- this supplier: no grace at all, but a 10% shortfall and 25% excess are in full
  PERFORM app.set_supplier_performance_settings(s, '{"graceDaysBefore":0,"graceDaysAfter":0,"inFullUnderPct":10,"inFullOverPct":25}'::jsonb);
  r := app.supplier_performance(s, current_date - 60, current_date);
  PERFORM pg_temp.assert_eq((r -> 'overrides' ->> 'grace_days_after')::int, 0, 'the overrides are reported');
  PERFORM pg_temp.assert_eq((r -> 'model' -> 'config' ->> 'grace_days_after')::int, 0, 'and win over the organisation''s model');
  PERFORM pg_temp.assert_eq((r -> 'metrics' -> 'otd' ->> 'onTime')::int, 3, 'so on-time is back to the strict count');
  PERFORM pg_temp.assert_eq((r -> 'metrics' -> 'inFull' ->> 'inFull')::int, 4, 'and the wider tolerance puts lines 1, 3, 4 and 5 in full');
  PERFORM pg_temp.assert_eq((r -> 'metrics' -> 'inFull' ->> 'short')::int, 1, 'leaving line 2 short');
  -- a saved scorecard keeps the configuration it was scored with
  sc := app.save_supplier_scorecard(s, current_date - 60, current_date, 'With overrides');
  PERFORM app.set_supplier_performance_settings(s, '{"graceDaysAfter":5}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT (config ->> 'grace_days_after')::int FROM public.supplier_scorecards WHERE id = sc), 0, 'the saved scorecard still shows the configuration it used');
  PERFORM pg_temp.assert_eq((SELECT (config ->> 'in_full_over_pct')::numeric FROM public.supplier_scorecards WHERE id = sc), 25::numeric, 'including the supplier''s tolerance');
  -- clearing an override follows the model again
  PERFORM app.set_supplier_performance_settings(s, '{"graceDaysAfter":null,"graceDaysBefore":null,"inFullUnderPct":null,"inFullOverPct":null}'::jsonb);
  r := app.supplier_performance(s, current_date - 60, current_date);
  PERFORM pg_temp.assert_eq((r -> 'model' -> 'config' ->> 'grace_days_after')::int, 3, 'a cleared override follows the model');
  PERFORM pg_temp.assert_eq(r -> 'overrides', '{}'::jsonb, 'and nothing is reported as overridden');
  -- the date policy can be overridden too
  PERFORM app.set_supplier_performance_settings(s, '{"otdPolicy":"original"}'::jsonb);
  PERFORM pg_temp.assert_eq(app.supplier_performance(s, current_date - 60, current_date) -> 'metrics' -> 'otd' ->> 'policy', 'original', 'a supplier can be judged on the original date');

  -- ---- an older model (none of the new keys) still scores, as before ----
  PERFORM pg_temp.assert_eq((app.score_supplier_performance(cfg - 'ppm_basis' - 'grace_days_before' - 'grace_days_after' - 'in_full_under_pct' - 'in_full_over_pct', app.supplier_performance(s, current_date - 60, current_date) -> 'metrics') ->> 'band') IS NOT NULL, true, 'a model without the new keys still scores');
  PERFORM pg_temp.assert_eq((SELECT w ->> 'sufficient' FROM jsonb_array_elements(app.score_supplier_performance(cfg - 'ppm_basis', app.supplier_performance(s, current_date - 60, current_date) -> 'metrics') -> 'components') w WHERE w ->> 'key' = 'in_full'), 'true', 'and in full is measured when it has data');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
