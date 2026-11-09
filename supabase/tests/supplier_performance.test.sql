-- Supplier Quality SQ5: performance scorecards - the metrics (PPM, lot rejection, on-time delivery by date policy, NCs, SCARs, certifications), scoring with insufficient data,
-- model versions, frozen snapshots, the watchlist, permissions and tenant isolation.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('5a000000-0000-0000-0000-000000000a01', 'ann@sp.test'), ('5a000000-0000-0000-0000-000000000a02', 'bob@sp.test'), ('5a000000-0000-0000-0000-000000000a03', 'eve@sp.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '5a000000-0000-0000-0000-000000000a01'; bob uuid := '5a000000-0000-0000-0000-000000000a02'; eve uuid := '5a000000-0000-0000-0000-000000000a03';
  org uuid; org2 uuid; s uuid; s2 uuid; sb uuid; p1 uuid; role_id uuid; po uuid; r jsonb; gr uuid; line uuid; cfg jsonb; sc1 uuid; sc2 uuid; scar uuid; nc uuid; i integer;
  recv integer[] := ARRAY[-22, -20, -15, -12, -20, -19]; req integer[] := ARRAY[-20, -20, -20, -30, -20, -20]; agr integer[] := ARRAY[NULL, NULL, NULL, -10, NULL, NULL];
  lines jsonb := '[]'::jsonb; before jsonb;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('SP Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('SP Beta'); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, bob, 'active');
  SELECT id INTO role_id FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, ou.id, role_id FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id = bob;
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'ACME', 'Acme Metals') RETURNING id INTO s;
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'BOLT', 'Bolt Co') RETURNING id INTO s2;
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org2, 'BETA', 'Beta Ltd') RETURNING id INTO sb;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'BRK-1', 'Bracket') RETURNING id INTO p1;

  PERFORM pg_temp.login(ann);
  -- six order lines with different dates; each delivered in full on its own day
  FOR i IN 1..6 LOOP
    lines := lines || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('material', 'Steel ' || i, 'quantity', 100, 'requestedOn', (current_date + req[i])::text, 'agreedOn', (current_date + agr[i])::text)));
  END LOOP;
  po := app.create_purchase_order(s, 'PO-SP-1', current_date - 40, NULL, lines);
  FOR i IN 1..6 LOOP
    SELECT id INTO line FROM public.purchase_order_lines WHERE purchase_order_id = po AND line_number = i;
    gr := ((app.record_goods_receipt(s, po, NULL, current_date + recv[i], 'DN-' || i, NULL, jsonb_build_array(jsonb_build_object('poLineId', line, 'quantity', 100)), NULL)) ->> 'id')::uuid;
    IF i = 3 THEN
      PERFORM app.disposition_receipt_line((SELECT id FROM public.goods_receipt_lines WHERE goods_receipt_id = gr), 'rejected', 'Out of tolerance', NULL);
    END IF;
  END LOOP;
  -- a delivery with no order line, and one cancelled receipt that must not count
  PERFORM app.record_goods_receipt(s, NULL, NULL, current_date - 5, 'DN-LOOSE', NULL, '[{"material":"Loose coil","quantity":50}]'::jsonb, NULL);
  gr := ((app.record_goods_receipt(s, NULL, NULL, current_date - 4, 'DN-CANCEL', NULL, '[{"material":"Cancelled coil","quantity":999}]'::jsonb, NULL)) ->> 'id')::uuid;
  PERFORM app.cancel_goods_receipt(gr, 'Entered twice');
  PERFORM pg_temp.logout();

  -- non-conformances (two on one part = repeats), a certification pair and an answered SCAR
  PERFORM pg_temp.login(ann);
  INSERT INTO public.nonconformances (organisation_id, source, title, description, severity, quantity_affected, supplier_id, part_id) VALUES (org, 'supplier', 'Bent', 'x', 'major', 3, s, p1);
  INSERT INTO public.nonconformances (organisation_id, source, title, description, severity, quantity_affected, supplier_id, part_id) VALUES (org, 'supplier', 'Scratched', 'x', 'minor', 1, s, p1);
  INSERT INTO public.nonconformances (organisation_id, source, title, description, severity, quantity_affected, supplier_id) VALUES (org, 'supplier', 'Wrong material', 'x', 'critical', 1, s) RETURNING id INTO nc;
  INSERT INTO public.nonconformances (organisation_id, source, title, description, severity, quantity_affected, supplier_id) VALUES (org, 'supplier', 'Not this supplier', 'x', 'critical', 1, s2);
  PERFORM app.add_supplier_certification(s, jsonb_build_object('certType', 'iso_9001', 'certificateNumber', 'OLD-1', 'issuingBody', 'BSI', 'expiresOn', (current_date - 5)::text));
  PERFORM app.add_supplier_certification(s, jsonb_build_object('certType', 'iso_14001', 'certificateNumber', 'NEW-1', 'issuingBody', 'BSI', 'expiresOn', (current_date + 300)::text));
  scar := (app.create_supplier_scar(s, 'Wrong material supplied', 'x', 'major', current_date + 14, NULL, ARRAY[nc], NULL, 'sp-key-0001') ->> 'id')::uuid;
  PERFORM app.issue_supplier_scar(scar);
  PERFORM app.record_scar_response(scar, 'Cause found', NULL, 'Fixed', NULL, NULL, current_date, 'Them', NULL);

  -- ---- the metrics, under the default model (agreed dates) ----
  r := app.supplier_performance(s, current_date - 60, current_date);
  PERFORM pg_temp.assert_eq((r -> 'metrics' -> 'deliveries' ->> 'lines')::int, 7, 'seven received lines count; the cancelled receipt does not');
  PERFORM pg_temp.assert_eq((r -> 'metrics' -> 'ppm' ->> 'receivedUnits')::numeric, 650::numeric, 'received units are the six full lines and the loose one');
  PERFORM pg_temp.assert_eq((r -> 'metrics' -> 'ppm' ->> 'value')::numeric, 153846::numeric, 'PPM is rejected units over received units');
  PERFORM pg_temp.assert_eq((r -> 'metrics' -> 'lotRejection' ->> 'rejectedLines')::int, 1, 'one line was rejected');
  PERFORM pg_temp.assert_eq((r -> 'metrics' -> 'lotRejection' ->> 'rate')::numeric, 0.1429::numeric, 'lot rejection is a rate of lines, kept apart from PPM');
  PERFORM pg_temp.assert_eq((r -> 'metrics' -> 'otd' ->> 'matchedLines')::int, 6, 'six lines match an order line');
  PERFORM pg_temp.assert_eq((r -> 'metrics' -> 'otd' ->> 'unmatchedLines')::int, 1, 'the loose delivery is unmatched');
  PERFORM pg_temp.assert_eq((r -> 'metrics' -> 'otd' ->> 'onTime')::int, 4, 'by the agreed date four lines were on time');
  PERFORM pg_temp.assert_eq((r -> 'metrics' -> 'ncs' ->> 'total')::int, 3, 'three NCs name this supplier');
  PERFORM pg_temp.assert_eq((r -> 'metrics' -> 'ncs' ->> 'critical')::int, 1, 'one is critical');
  PERFORM pg_temp.assert_eq((r -> 'metrics' -> 'ncs' ->> 'repeat')::int, 2, 'two NCs on one part are repeats');
  PERFORM pg_temp.assert_eq((r -> 'metrics' -> 'scars' ->> 'answered_on_time')::int, 1, 'the SCAR was answered by its due date');
  PERFORM pg_temp.assert_eq((r -> 'metrics' -> 'certs' ->> 'expired')::int, 1, 'one certification is past its expiry');
  -- scoring: otd 66.7, ppm 0, ncs 35, scar 100, certs 50 under weights 30/30/20/10/10
  PERFORM pg_temp.assert_eq((r ->> 'score')::numeric, 42.00::numeric, 'the score is the weighted average of the components');
  PERFORM pg_temp.assert_eq(r ->> 'band', 'poor', 'which is a poor band');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM jsonb_array_elements(r -> 'warnings') w WHERE w ->> 'code' = 'critical_nc'), 1, 'a critical NC is a warning with its records');
  PERFORM pg_temp.assert_eq((SELECT jsonb_array_length(w -> 'sources') FROM jsonb_array_elements(r -> 'warnings') w WHERE w ->> 'code' = 'cert_expired'), 1, 'and an expired certification names it');
  -- the period is respected
  r := app.supplier_performance(s, current_date - 14, current_date);
  PERFORM pg_temp.assert_eq((r -> 'metrics' -> 'deliveries' ->> 'lines')::int, 2, 'a shorter period sees only its deliveries');
  PERFORM pg_temp.assert_eq(r -> 'components' -> 0 ->> 'sufficient', 'false', 'and says there is not enough data');

  -- ---- insufficient data ----
  r := app.supplier_performance(s2, current_date - 60, current_date);
  PERFORM pg_temp.assert_eq(r ->> 'band', 'insufficient', 'a supplier with nothing recorded has no band');
  PERFORM pg_temp.assert_eq(r -> 'score', 'null'::jsonb, 'and no score, not a misleading one');

  -- ---- model versions and the date policy ----
  PERFORM pg_temp.logout(); PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.save_supplier_scorecard_model(%L, '{}'::jsonb, 'x')$f$, org)), 5), '42501', 'a viewer cannot configure the model');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.save_supplier_scorecard(%L, current_date - 30, current_date, NULL)$f$, s)), 5), '42501', 'or save a scorecard');
  PERFORM pg_temp.assert_eq((app.supplier_performance(s, current_date - 60, current_date) ->> 'score')::numeric, 42.00::numeric, 'but can read the live figures');
  PERFORM pg_temp.logout(); PERFORM pg_temp.login(ann);
  SELECT config INTO cfg FROM public.supplier_scorecard_models WHERE organisation_id = org ORDER BY version DESC LIMIT 1;
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.save_supplier_scorecard_model(%L, %L::jsonb, 'again')$f$, org, cfg)), 5), 'QM020', 'an unchanged model is refused');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.save_supplier_scorecard_model(%L, %L::jsonb, 'bad')$f$, org, cfg || '{"otd_policy":"whenever"}')), 5), 'QM020', 'an unknown date policy is refused');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.save_supplier_scorecard_model(%L, %L::jsonb, 'bad')$f$, org, cfg || '{"good_from":50,"watch_from":60}')), 5), 'QM020', 'bands must rise');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.save_supplier_scorecard_model(%L, %L::jsonb, 'bad')$f$, org, cfg || '{"weights":{"otd":0,"ppm":0,"ncs":0,"scar":0,"certs":0}}')), 5), 'QM020', 'some weight is needed');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.save_supplier_scorecard_model(%L, %L::jsonb, 'x')$f$, org, cfg || '{"ppm_zero":500}')), 5), 'QM020', 'PPM targets must be ordered, and a reason needs three characters');

  -- freeze a scorecard under version 1, then change the model and the data
  sc1 := app.save_supplier_scorecard(s, current_date - 60, current_date, 'Quarterly review');
  PERFORM pg_temp.assert_eq((SELECT (model_version, band, score)::text FROM public.supplier_scorecards WHERE id = sc1), '(1,poor,42.00)', 'a snapshot freezes the model version, band and score');
  PERFORM app.save_supplier_scorecard_model(org, cfg || '{"otd_policy":"original"}', 'Judge us by the original date');
  r := app.supplier_performance(s, current_date - 60, current_date);
  PERFORM pg_temp.assert_eq((r -> 'metrics' -> 'otd' ->> 'onTime')::int, 3, 'by the original date only three lines were on time');
  PERFORM pg_temp.assert_eq((r ->> 'score')::numeric, 37.00::numeric, 'so the score under version 2 differs');
  PERFORM pg_temp.assert_eq((SELECT score FROM public.supplier_scorecards WHERE id = sc1), 42.00::numeric, 'while the old scorecard still says what it said');
  sc2 := app.save_supplier_scorecard(s, current_date - 60, current_date, NULL);
  PERFORM pg_temp.assert_eq((SELECT model_version FROM public.supplier_scorecards WHERE id = sc2), 2, 'a new snapshot uses the new version');
  PERFORM pg_temp.assert_eq(pg_temp.count_rows(format('SELECT 1 FROM public.supplier_scorecards WHERE supplier_id = %L', s)), 2::bigint, 'both snapshots are kept');
  PERFORM pg_temp.assert_fails(format($f$UPDATE public.supplier_scorecards SET score = 100 WHERE id = %L$f$, sc1), 'a scorecard cannot be edited');
  PERFORM pg_temp.assert_fails(format($f$DELETE FROM public.supplier_scorecards WHERE id = %L$f$, sc1), 'or deleted');
  PERFORM pg_temp.assert_fails(format($f$INSERT INTO public.supplier_scorecards (organisation_id, supplier_id, period_from, period_to, model_id, model_version, config, metrics, components, score, band) SELECT organisation_id, supplier_id, period_from, period_to, model_id, model_version, config, metrics, components, 99, 'good' FROM public.supplier_scorecards WHERE id = %L$f$, sc1), 'and nothing can write one directly');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.save_supplier_scorecard(%L, current_date - 30, current_date + 1, NULL)$f$, s)), 5), 'QM020', 'a period cannot end in the future');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.save_supplier_scorecard(%L, current_date - 400, current_date, NULL)$f$, s)), 5), 'QM020', 'or be longer than a year');

  -- ---- watchlist ----
  PERFORM pg_temp.assert_eq((SELECT jsonb_array_length(app.supplier_watchlist(org, 90))), 2, 'both suppliers with something to say are listed (a critical NC is enough)');
  PERFORM pg_temp.assert_eq(app.supplier_watchlist(org, 90) -> 0 ->> 'code', 'ACME', 'the poor one comes first');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM jsonb_array_elements(app.supplier_watchlist(org, 90) -> 1 -> 'warnings') w WHERE w ->> 'code' = 'critical_nc'), 1, 'the other is listed for its critical non-conformance, with no score');
  UPDATE public.suppliers SET active = false WHERE id = s2;
  PERFORM pg_temp.assert_eq((SELECT jsonb_array_length(app.supplier_watchlist(org, 90))), 1, 'an inactive supplier is not on the watchlist');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.supplier_watchlist(%L, 3)$f$, org)), 5), 'QM020', 'the look-back is 7 to 366 days');

  -- ---- isolation ----
  PERFORM pg_temp.logout(); PERFORM pg_temp.login(eve);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.supplier_performance(%L, current_date - 30, current_date)$f$, s)), 5), 'P0002', 'another organisation cannot see the figures');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.save_supplier_scorecard(%L, current_date - 30, current_date, NULL)$f$, s)), 5), 'P0002', 'or save a scorecard');
  PERFORM pg_temp.assert_eq(pg_temp.count_rows('SELECT 1 FROM public.supplier_scorecards'), 0::bigint, 'or read the scorecards');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.supplier_watchlist(%L, 90)$f$, org)), 5), 'P0002', 'or the watchlist');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
