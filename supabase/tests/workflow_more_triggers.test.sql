-- Workflow rules WF4: the new triggers' events are written (only when they should be), and the facts each new trigger offers are read from the record behind it.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES ('5c000000-0000-0000-0000-000000000a01', 'ann@wf4.test');

DO $$
DECLARE
  ann uuid := '5c000000-0000-0000-0000-000000000a01';
  org uuid; site uuid; s uuid; p uuid; nc uuid; f jsonb; ev public.outbox_events%ROWTYPE; scar uuid; risk uuid; cat uuid; gr uuid; line uuid; qa uuid;
  sc1 uuid; sc2 uuid; mdl uuid; alert uuid;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('WF4 Alpha'); PERFORM pg_temp.logout();
  SELECT id INTO site FROM public.sites WHERE organisation_id = org LIMIT 1;
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'ACME', 'Acme Metals') RETURNING id INTO s;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'BRK-1', 'Bracket') RETURNING id INTO p;

  -- ---- the catalogue ----
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.workflow_triggers()), 21::bigint, 'twenty-one things can start a rule');
  PERFORM pg_temp.assert_eq((SELECT count(DISTINCT event_type) FROM app.workflow_triggers()), 21::bigint, 'each once');

  -- ---- an NC: quantity, title and total cost (live lines, base currency) ----
  PERFORM pg_temp.login(ann);
  INSERT INTO public.nonconformances (organisation_id, source, title, description, severity, quantity_affected, supplier_id, part_id)
    VALUES (org, 'supplier', 'Bent brackets', 'x', 'major', 40, s, p) RETURNING id INTO nc;
  INSERT INTO public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, amount) VALUES (org, nc, 'scrap', 'GBP', 120);
  INSERT INTO public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, amount) VALUES (org, nc, 'scrap', 'GBP', 999);
  PERFORM pg_temp.logout();
  UPDATE public.ncr_costs SET deleted_at = now(), delete_reason = 'Typo' WHERE nonconformance_id = nc AND amount = 999;
  f := app.system_workflow_facts(org, 'nonconformance', nc, '{}');
  PERFORM pg_temp.assert_eq((f ->> 'quantity_affected')::numeric, 40::numeric, 'quantity affected is a number');
  PERFORM pg_temp.assert_eq((f ->> 'total_cost')::numeric, 120::numeric, 'total cost leaves out removed lines');
  PERFORM pg_temp.assert_eq(jsonb_typeof(f -> 'total_cost'), 'number', 'and is a JSON number');
  PERFORM pg_temp.assert_eq(f ->> 'title', 'Bent brackets', 'the title can be tested');
  f := app.system_workflow_facts(org, 'ncr_disposition', nc, '{"decision":"scrap","quantity":5}');
  PERFORM pg_temp.assert_eq((f ->> 'decision', (f ->> 'disposition_quantity')::numeric)::text, '(scrap,5)', 'a disposition event carries its decision and quantity');
  PERFORM pg_temp.assert_eq(f ->> 'record_kind', 'nonconformance', 'and leads to the NC');

  -- ---- an SPC alert ----
  INSERT INTO public.spc_alerts (organisation_id, part_id, part_number, characteristic_key, characteristic_name, operation_code, variant, rule, side, point_at, summary)
    VALUES (org, p, 'BRK-1', 'od', 'Outside diameter', 'OP-10', 'imr', 'we1', 'above', now(), 'Point beyond the upper limit') RETURNING id INTO alert;
  SELECT * INTO ev FROM public.outbox_events WHERE organisation_id = org AND event_type = 'spc.alert.raised';
  PERFORM pg_temp.assert_eq(ev.entity_id, alert, 'an SPC alert writes an event');
  f := app.system_workflow_facts(org, 'spc_alert', alert, ev.payload);
  PERFORM pg_temp.assert_eq((f ->> 'rule', f ->> 'characteristic_key', f ->> 'part_id')::text, '(we1,od,' || p || ')', 'with the rule, characteristic and part');

  -- ---- a SCAR changing status (not on insert, once per change) ----
  INSERT INTO public.supplier_scars (organisation_id, reference, supplier_id, title, severity, response_due_on)
    VALUES (org, 'SCAR-26-0001', s, 'Bent brackets again', 'major', current_date + 14) RETURNING id INTO scar;
  PERFORM pg_temp.assert_eq(pg_temp.count_rows(format($q$SELECT 1 FROM public.outbox_events WHERE entity_id = %L$q$, scar)), 0::bigint, 'a new draft SCAR writes nothing');
  UPDATE public.supplier_scars SET status = 'issued', issued_at = now() WHERE id = scar;
  UPDATE public.supplier_scars SET title = 'Bent brackets, again' WHERE id = scar;
  PERFORM pg_temp.assert_eq(pg_temp.count_rows(format($q$SELECT 1 FROM public.outbox_events WHERE entity_id = %L AND event_type = 'scar.status_changed'$q$, scar)), 1::bigint, 'issuing writes one event, an edit none');
  SELECT * INTO ev FROM public.outbox_events WHERE entity_id = scar;
  f := app.system_workflow_facts(org, 'scar', scar, ev.payload);
  PERFORM pg_temp.assert_eq((f ->> 'from_status', f ->> 'to_status', f ->> 'severity', f ->> 'supplier_id')::text, '(draft,issued,major,' || s || ')', 'from, to, severity and supplier');

  -- ---- a decision on a received line ----
  PERFORM pg_temp.login(ann);
  gr := ((app.record_goods_receipt(s, NULL, site, current_date, 'DN-1', NULL, jsonb_build_array(jsonb_build_object('partId', p, 'quantity', 50)), NULL)) ->> 'id')::uuid;
  SELECT id INTO line FROM public.goods_receipt_lines WHERE goods_receipt_id = gr;
  PERFORM app.disposition_receipt_line(line, 'rejected', 'Out of tolerance', NULL, 20);
  PERFORM pg_temp.logout();
  SELECT * INTO ev FROM public.outbox_events WHERE organisation_id = org AND event_type = 'receipt.line.decided' ORDER BY id DESC LIMIT 1;
  f := app.system_workflow_facts(org, 'receipt_line_disposition', ev.entity_id, ev.payload);
  PERFORM pg_temp.assert_eq((f ->> 'decision', f ->> 'supplier_id', (f ->> 'quantity_rejected')::numeric::int, f ->> 'record_id')::text, '(rejected,' || s || ',20,' || gr || ')',
                            'a rejection carries the supplier, the quantity rejected and leads to the receipt');

  -- ---- a risk assessed ----
  SELECT id INTO cat FROM public.risk_categories WHERE organisation_id = org ORDER BY key LIMIT 1;
  PERFORM pg_temp.login(ann);
  risk := app.create_risk(org, jsonb_build_object('categoryId', cat, 'title', 'Supplier capacity', 'ownerId', ann));
  PERFORM app.assess_risk(risk, 4, 4, 'Big supplier, one source');
  PERFORM pg_temp.logout();
  SELECT * INTO ev FROM public.outbox_events WHERE organisation_id = org AND event_type = 'risk.assessed';
  f := app.system_workflow_facts(org, 'risk_assessment', ev.entity_id, ev.payload);
  PERFORM pg_temp.assert_eq((f ->> 'band', (f ->> 'score')::int, f ->> 'phase', f ->> 'owner_user_id', f ->> 'record_id')::text, '(high,16,inherent,' || ann || ',' || risk || ')',
                            'the band, score, phase and owner, leading to the risk');

  -- ---- a quality alert issued (draft → active only) ----
  PERFORM pg_temp.login(ann);
  INSERT INTO public.quality_alerts (organisation_id, title, category, severity, description, effective_date) VALUES (org, 'Check the bar stock', 'supplier', 'high', 'd', current_date) RETURNING id INTO qa;
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(pg_temp.count_rows(format($q$SELECT 1 FROM public.outbox_events WHERE entity_id = %L$q$, qa)), 0::bigint, 'a draft alert writes nothing');
  UPDATE public.quality_alerts SET status = 'active', issued_at = now(), issued_by = ann WHERE id = qa;
  SELECT * INTO ev FROM public.outbox_events WHERE entity_id = qa;
  PERFORM pg_temp.assert_eq(ev.event_type, 'quality_alert.issued', 'issuing it does');
  f := app.system_workflow_facts(org, 'quality_alert', qa, ev.payload);
  PERFORM pg_temp.assert_eq((f ->> 'severity', f ->> 'category', f ->> 'owner_user_id')::text, '(high,supplier,' || ann || ')', 'with its severity, category and issuer');

  -- ---- a scorecard band falling ----
  SELECT id INTO mdl FROM public.supplier_scorecard_models WHERE organisation_id = org ORDER BY version DESC LIMIT 1;
  INSERT INTO public.supplier_scorecards (organisation_id, supplier_id, period_from, period_to, period_kind, model_id, model_version, config, metrics, components, score, band)
    VALUES (org, s, '2026-09-01', '2026-09-30', 'monthly', mdl, 1, '{}', '{}', '[]', 90, 'good') RETURNING id INTO sc1;
  INSERT INTO public.supplier_scorecards (organisation_id, supplier_id, period_from, period_to, period_kind, model_id, model_version, config, metrics, components, score, band)
    VALUES (org, s, '2026-10-01', '2026-10-31', 'monthly', mdl, 1, '{}', '{}', '[]', 40, 'poor') RETURNING id INTO sc2;
  INSERT INTO public.supplier_band_drops (organisation_id, supplier_id, scorecard_id, previous_scorecard_id, period_kind, period_from, period_to, from_band, to_band, supplier_label, change_label)
    VALUES (org, s, sc2, sc1, 'monthly', '2026-10-01', '2026-10-31', 'good', 'poor', 'ACME · Acme Metals', 'Good → Poor (October 2026)');
  SELECT * INTO ev FROM public.outbox_events WHERE organisation_id = org AND event_type = 'supplier.band_dropped';
  f := app.system_workflow_facts(org, 'supplier_band_drop', ev.entity_id, ev.payload);
  PERFORM pg_temp.assert_eq((f ->> 'from_band', f ->> 'to_band', f ->> 'period_kind', (f ->> 'score')::numeric, f ->> 'record_id')::text, '(good,poor,monthly,40.00,' || s || ')',
                            'from, to, period, score; leads to the supplier');

  -- ---- events already written by the modules now have facts ----
  f := app.system_workflow_facts(org, 'supplier', s, '{"from":"low","to":"high"}');
  PERFORM pg_temp.assert_eq(f ->> 'previous_risk_rating', 'low', 'a risk assessment event says the rating before');
  PERFORM pg_temp.login(ann);
  INSERT INTO public.part_revisions (organisation_id, part_id, revision) VALUES (org, p, 'A');
  UPDATE public.part_revisions SET status = 'released' WHERE part_id = p AND revision = 'A';
  PERFORM pg_temp.logout();
  SELECT * INTO ev FROM public.outbox_events WHERE organisation_id = org AND event_type = 'part.revision.released';
  f := app.system_workflow_facts(org, 'part_revision', ev.entity_id, ev.payload);
  PERFORM pg_temp.assert_eq((f ->> 'revision', f ->> 'part_id', f ->> 'record_kind')::text, '(A,' || p || ',part)', 'a released revision names its part and leads to it');
  PERFORM pg_temp.assert_eq(app.system_workflow_facts(org, 'nothing_like_this', s, '{}') IS NULL, true, 'an unknown kind has no facts');

  -- ---- the event writers are not callable by people ----
  PERFORM pg_temp.assert_eq(has_function_privilege('authenticated', 'app.workflow_emit_scar_status()', 'execute'), false, 'people cannot call the event writers');
END $$;

ROLLBACK;
