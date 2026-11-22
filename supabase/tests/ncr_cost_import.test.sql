-- Importing NC cost lines (docs/cost-import-plan.md): each line goes through the table's own triggers and rate lookup, in its own currency on its own date; links by the source's
-- NC id or the Fortress reference; add only; a closed or cancelled NC takes lines only when it was imported and the cost import was told so; the person needs the right to change
-- the NC; a booked value makes the line Actual; nothing is announced; the run summary says what will wait for a rate.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('5c700000-0000-0000-0000-000000000a01', 'ann@costimp.test'), ('5c700000-0000-0000-0000-000000000a02', 'viv@costimp.test'),
  ('5c700000-0000-0000-0000-000000000a03', 'zed@costimp.test'), ('5c700000-0000-0000-0000-000000000b01', 'bea@costimp.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

-- One source row through the whole import path, as the person who asks. p_settings is merged into the run's frozen settings (as a template's would be).
CREATE FUNCTION pg_temp.import_one(p_org uuid, p_conn uuid, p_user uuid, p_entity text, p_ext text, p_canonical jsonb, p_settings jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE run uuid; owner uuid := gen_random_uuid(); todo jsonb; v_id uuid; row_id uuid; i public.integration_inbox%ROWTYPE;
BEGIN
  PERFORM pg_temp.login(p_user); run := app.request_integration_run(p_conn, p_entity, 'full', NULL, NULL); PERFORM pg_temp.logout();
  UPDATE public.integration_sync_runs SET settings = coalesce(settings, '{}'::jsonb) || p_settings WHERE id = run;
  PERFORM app.system_lease_integration_run(p_org, run, owner, 30);
  PERFORM app.system_stage_integration_records(p_org, run, owner,
    jsonb_build_array(jsonb_build_object('externalId', p_ext, 'payload', jsonb_build_object('id', p_ext), 'canonical', p_canonical)), NULL, true);
  todo := app.system_integration_rows_to_apply(p_org, run, owner, 10);
  IF jsonb_array_length(todo) = 1 THEN
    row_id := (todo -> 0 ->> 'id')::uuid;
    BEGIN
      v_id := app.system_import_record(p_org, run, owner, row_id, (todo -> 0 ->> 'internalId')::uuid, todo -> 0 -> 'canonical');
      PERFORM app.system_apply_integration_row(p_org, run, owner, row_id, v_id, todo -> 0 ->> 'action');
    EXCEPTION WHEN OTHERS THEN
      PERFORM app.system_fail_integration_row(p_org, run, owner, row_id, SQLERRM, NULL);
    END;
  END IF;
  PERFORM pg_temp.logout();
  PERFORM app.system_finish_integration_run(p_org, run, owner);
  SELECT * INTO i FROM public.integration_inbox WHERE run_id = run OR last_run_id = run ORDER BY created_at DESC LIMIT 1;
  RETURN jsonb_build_object('status', i.status, 'internal', i.internal_id, 'errors', i.errors, 'action', i.action, 'run', run);
END $$;

DO $$
DECLARE
  ann uuid := '5c700000-0000-0000-0000-000000000a01'; viv uuid := '5c700000-0000-0000-0000-000000000a02'; zed uuid := '5c700000-0000-0000-0000-000000000a03'; bea uuid := '5c700000-0000-0000-0000-000000000b01';
  org uuid; other uuid; api uuid; cat uuid; site_a uuid; site_b uuid; res jsonb; c public.ncr_costs%ROWTYPE; r_noupdate uuid; r_viewer uuid;
  ncr_a uuid; ncr_b uuid; ncr_hand_closed uuid; ncr_imp_open uuid; ncr_imp_closed uuid; ncr_imp_cancelled uuid; ncr_other uuid; ncr_deleted uuid;
  d date := current_date - 10; base jsonb; ncbase jsonb; events_before bigint; notes_before bigint; n_before integer; refs jsonb; sm jsonb; run uuid; owner uuid := gen_random_uuid();
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('Cost Import Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(bea); other := app.create_organisation('Cost Import Beta'); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, viv, 'active'), (org, zed, 'active');
  -- a role that may run imports and create NCs but not change them (no built-in role is like that), and a viewer
  INSERT INTO public.roles (organisation_id, key, name, is_system) VALUES (org, 'importer', 'Importer', false) RETURNING id INTO r_noupdate;
  INSERT INTO public.role_permissions (role_id, permission_code) VALUES (r_noupdate, 'integrations.read'), (r_noupdate, 'integrations.run'), (r_noupdate, 'ncr.read'), (r_noupdate, 'ncr.create');
  SELECT id INTO r_viewer FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, ou.id, r_noupdate FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id = viv;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, ou.id, r_viewer FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id = zed;
  PERFORM pg_temp.give_controller_seat(org, ann);
  PERFORM pg_temp.give_controller_seat(org, viv);
  cat := pg_temp.cat(org);

  UPDATE public.organisation_settings SET base_currency = 'GBP', vat_rate = 0.2 WHERE organisation_id = org;
  INSERT INTO public.sites (organisation_id, code, name) VALUES (org, 'PA', 'Plant A') RETURNING id INTO site_a;
  INSERT INTO public.sites (organisation_id, code, name) VALUES (org, 'PB', 'Plant B') RETURNING id INTO site_b;
  UPDATE public.sites SET currency = 'EUR' WHERE id = site_b;

  -- rates: ten days ago EUR and USD into GBP (site A), GBP and USD into EUR (site B); today nothing for CAD
  PERFORM pg_temp.seed_rate(d, 'EUR', 'GBP', 0.85);
  PERFORM pg_temp.seed_rate(d, 'USD', 'GBP', 0.79);
  PERFORM pg_temp.seed_rate(d, 'GBP', 'EUR', 1.17);
  PERFORM pg_temp.seed_rate(d, 'USD', 'EUR', 0.92);

  PERFORM pg_temp.login(ann);
  api := app.create_integration_connection(org, 'rest_api', 'ERP', 'erp', '{"baseUrl": "https://erp.example.com", "authType": "none"}'::jsonb);
  PERFORM app.record_integration_connection_test(api, true, 'ok');
  PERFORM app.mark_integration_ready(api);
  PERFORM app.activate_integration_connection(api);
  PERFORM pg_temp.logout();

  -- non-conformances: hand-made ones (open at each site, closed) and ones an import brought in (open, closed, cancelled)
  INSERT INTO public.nonconformances (organisation_id, reference, source, stage, title, site_id, severity, quantity_affected, description, category_id)
    VALUES (org, 'hand-a', 'internal', 'open', 'At plant A', site_a, 'major', 10, 'Scrap', cat) RETURNING id INTO ncr_a;
  INSERT INTO public.nonconformances (organisation_id, reference, source, stage, title, site_id, severity, quantity_affected, description, category_id)
    VALUES (org, 'hand-b', 'internal', 'open', 'At plant B', site_b, 'major', 10, 'Scrap', cat) RETURNING id INTO ncr_b;
  INSERT INTO public.nonconformances (organisation_id, reference, source, stage, title, site_id, severity, quantity_affected, description, category_id, closed_at)
    VALUES (org, 'hand-c', 'internal', 'closed', 'Closed by hand', site_a, 'major', 10, 'Scrap', cat, now()) RETURNING id INTO ncr_hand_closed;
  ncbase := jsonb_build_object('source', 'internal', 'severity', 'minor', 'quantityAffected', 5, 'description', 'Burr', 'categoryId', cat, 'detectedAt', '2026-01-10', 'siteId', site_a);
  res := pg_temp.import_one(org, api, ann, 'nonconformance', 'N-OPEN', ncbase || '{"title": "Imported open", "stage": "open"}');
  ncr_imp_open := (res ->> 'internal')::uuid;
  res := pg_temp.import_one(org, api, ann, 'nonconformance', 'N-CLOSED', ncbase || '{"title": "Imported closed", "stage": "closed", "closedOn": "2026-02-01"}');
  ncr_imp_closed := (res ->> 'internal')::uuid;
  res := pg_temp.import_one(org, api, ann, 'nonconformance', 'N-CANC', jsonb_build_object('source', 'internal', 'title', 'Imported cancelled', 'stage', 'cancelled', 'siteId', site_a));
  ncr_imp_cancelled := (res ->> 'internal')::uuid;
  res := pg_temp.import_one(org, api, ann, 'nonconformance', 'N-DEL', ncbase || '{"title": "Imported then deleted", "stage": "closed", "closedOn": "2026-02-01"}');
  ncr_deleted := (res ->> 'internal')::uuid;
  UPDATE public.nonconformances SET deleted_at = now(), delete_reason = 'test' WHERE id = ncr_deleted;
  INSERT INTO public.nonconformances (organisation_id, reference, source, stage, title, severity, quantity_affected, description, category_id)
    SELECT other, 'hand-o', 'internal', 'open', 'Other organisation', 'major', 10, 'Scrap', pg_temp.cat(other) RETURNING id INTO ncr_other;

  base := jsonb_build_object('nonconformanceId', ncr_a, 'costType', 'scrap', 'incurredOn', d::text, 'currency', 'GBP', 'unitCost', 100);

  -- the kind exists, is add only, never matched and has no disappearing records
  PERFORM pg_temp.assert_eq('ncr_cost' = ANY (app.integration_entity_types()), true, 'cost lines are an importable kind');
  PERFORM pg_temp.assert_eq(app.integration_entity_tracks_missing('ncr_cost'), false, 'nothing "disappears" for them');
  PERFORM pg_temp.assert_eq(app.integration_template_settings('ncr_cost', '{"writeMode": "add_update", "matchExisting": true}'::jsonb), '{"writeMode": "add_only", "matchExisting": false, "costsOnClosed": false}'::jsonb, 'a cost template is always add only, and costs on closed NCs are off unless chosen');
  PERFORM pg_temp.assert_eq((app.integration_template_settings('ncr_cost', '{"costsOnClosed": true}'::jsonb) ->> 'costsOnClosed')::boolean, true, 'and can be switched on');
  PERFORM pg_temp.assert_eq(app.integration_template_settings('machine', '{"costsOnClosed": true}'::jsonb) ? 'costsOnClosed', false, 'other kinds keep exactly what they kept');
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq(app.integration_may_write(org, 'ncr_cost'), true, 'someone who may change NCs may write cost lines');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($q$SELECT app.set_integration_import_settings(%L, 'ncr_cost', '{"writeMode": "add_update"}'::jsonb)$q$, api)), 5), 'QM022', 'the import settings cannot make cost lines update');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(zed);
  PERFORM pg_temp.assert_eq(app.integration_may_write(org, 'ncr_cost'), false, 'a viewer may not');
  PERFORM pg_temp.logout();

  events_before := (SELECT count(*) FROM public.outbox_events WHERE organisation_id = org);
  notes_before := (SELECT count(*) FROM public.notifications WHERE organisation_id = org);

  -- a plain line in the site currency: quantity 1, no VAT, rate 1
  res := pg_temp.import_one(org, api, ann, 'ncr_cost', 'L-1', base);
  PERFORM pg_temp.assert_eq(res ->> 'status', 'applied', 'a line is imported: ' || coalesce(res ->> 'errors', ''));
  SELECT * INTO c FROM public.ncr_costs WHERE id = (res ->> 'internal')::uuid;
  PERFORM pg_temp.assert_eq(c.nonconformance_id, ncr_a, 'on its non-conformance');
  PERFORM pg_temp.assert_eq(c.quantity || '|' || c.amount || '|' || c.vat_treatment || '|' || c.rate_status || '|' || c.base_currency, '1|100.00|none|base|GBP', 'quantity 1, the amount worked out, no VAT, base rate');
  PERFORM pg_temp.assert_eq(c.created_by, ann, 'created by the person who imported');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM audit.events e WHERE e.entity_type = 'ncr_costs' AND e.entity_id = c.id::text AND e.action = 'insert'), 1, 'audited like any cost');
  PERFORM pg_temp.assert_eq(coalesce(current_setting('app.ncr_cost_on_closed', true), 'off'), 'off', 'nothing is left switched on');

  -- a foreign currency, on its own date: the published rate for that day, fixed on the line
  res := pg_temp.import_one(org, api, ann, 'ncr_cost', 'L-2', jsonb_build_object('nonconformanceId', ncr_a, 'costType', 'transport', 'incurredOn', d::text, 'currency', 'eur', 'unitCost', 100, 'quantity', 2));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'applied', 'a euro line (any case) is imported: ' || coalesce(res ->> 'errors', ''));
  SELECT * INTO c FROM public.ncr_costs WHERE id = (res ->> 'internal')::uuid;
  PERFORM pg_temp.assert_eq(c.currency || '|' || c.amount || '|' || c.rate_status || '|' || c.exchange_rate || '|' || c.net_base, 'EUR|200.00|estimated|0.85|170.00', 'converted at the rate for its own date');
  PERFORM pg_temp.assert_eq(c.rate_date, d, 'with that date on the line');
  res := pg_temp.import_one(org, api, ann, 'ncr_cost', 'L-3', jsonb_build_object('nonconformanceId', ncr_a, 'costType', 'labour', 'incurredOn', d::text, 'currency', 'USD', 'unitCost', 100));
  SELECT * INTO c FROM public.ncr_costs WHERE id = (res ->> 'internal')::uuid;
  PERFORM pg_temp.assert_eq(c.net_base, 79.00::numeric, 'a dollar line on the same NC uses the dollar rate: nothing is converted at the file level');
  -- at the other site (euros) the same pounds line is converted the other way, and the organisation figure is kept as well
  res := pg_temp.import_one(org, api, ann, 'ncr_cost', 'L-4', jsonb_build_object('nonconformanceId', ncr_b, 'costType', 'labour', 'incurredOn', d::text, 'currency', 'GBP', 'unitCost', 100));
  SELECT * INTO c FROM public.ncr_costs WHERE id = (res ->> 'internal')::uuid;
  PERFORM pg_temp.assert_eq(c.base_currency || '|' || c.net_base || '|' || c.org_currency || '|' || c.net_org, 'EUR|117.00|GBP|100.00', 'a line at a euro site is stated in euros and in the organisation currency');

  -- no published rate: the line is imported anyway, waiting, and adds to no total
  res := pg_temp.import_one(org, api, ann, 'ncr_cost', 'L-5', jsonb_build_object('nonconformanceId', ncr_a, 'costType', 'labour', 'incurredOn', d::text, 'currency', 'CAD', 'unitCost', 50));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'applied', 'a currency with no rate yet still imports');
  SELECT * INTO c FROM public.ncr_costs WHERE id = (res ->> 'internal')::uuid;
  PERFORM pg_temp.assert_eq(c.rate_status || '|' || coalesce(c.net_base::text, '-'), 'needed|-', 'waiting for a rate and counted nowhere');
  run := (res ->> 'run')::uuid;
  PERFORM pg_temp.login(ann);
  sm := app.integration_cost_run_summary(run);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((sm ->> 'waitingNow')::int, 1, 'the run says one line is still waiting for a rate');

  -- VAT: a percentage in the file; with a treatment and no rate, the organisation's
  res := pg_temp.import_one(org, api, ann, 'ncr_cost', 'V-1', base || '{"vatTreatment": "exclusive", "vatRate": 20}');
  SELECT * INTO c FROM public.ncr_costs WHERE id = (res ->> 'internal')::uuid;
  PERFORM pg_temp.assert_eq((c.vat_rate = 0.2) || '|' || c.net_amount || '|' || c.gross_amount, 'true|100.00|120.00', 'VAT added at the percentage given');
  res := pg_temp.import_one(org, api, ann, 'ncr_cost', 'V-2', base || '{"vatTreatment": "inclusive"}');
  SELECT * INTO c FROM public.ncr_costs WHERE id = (res ->> 'internal')::uuid;
  PERFORM pg_temp.assert_eq((c.vat_rate = 0.2) || '|' || c.net_amount || '|' || c.gross_amount, 'true|83.33|100.00', 'a treatment with no rate takes the organisation''s');
  res := pg_temp.import_one(org, api, ann, 'ncr_cost', 'V-3', base || '{"vatTreatment": "exclusive", "vatRate": 150}');
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'a VAT rate of 150 per cent is refused');

  -- the source's booked value: the line becomes Actual and keeps the published rate beside it
  res := pg_temp.import_one(org, api, ann, 'ncr_cost', 'B-1', jsonb_build_object('nonconformanceId', ncr_a, 'costType', 'scrap', 'incurredOn', d::text, 'currency', 'EUR', 'unitCost', 100, 'bookedValue', 90));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'applied', 'a line with a booked value is imported: ' || coalesce(res ->> 'errors', ''));
  SELECT * INTO c FROM public.ncr_costs WHERE id = (res ->> 'internal')::uuid;
  PERFORM pg_temp.assert_eq(c.rate_status || '|' || (c.exchange_rate = 0.9) || '|' || c.net_base || '|' || c.estimated_rate || '|' || c.override_kind, 'actual|true|90.00|0.85|amount', 'the booked value stands; the published rate is kept as the estimate');
  PERFORM pg_temp.assert_eq(c.override_note ILIKE '%erp%', true, 'and the note says where it came from');
  res := pg_temp.import_one(org, api, ann, 'ncr_cost', 'B-2', base || '{"bookedValue": 90}');
  SELECT * INTO c FROM public.ncr_costs WHERE id = (res ->> 'internal')::uuid;
  PERFORM pg_temp.assert_eq(c.rate_status || '|' || c.net_base, 'base|100.00', 'a booked value on a line already in the site currency is ignored');
  res := pg_temp.import_one(org, api, ann, 'ncr_cost', 'B-3', jsonb_build_object('nonconformanceId', ncr_a, 'costType', 'scrap', 'incurredOn', d::text, 'currency', 'EUR', 'unitCost', 0, 'bookedValue', 5));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'applied', 'a free line with a booked value still imports: nothing to convert');
  res := pg_temp.import_one(org, api, ann, 'ncr_cost', 'B-4', jsonb_build_object('nonconformanceId', ncr_a, 'costType', 'scrap', 'incurredOn', d::text, 'currency', 'CAD', 'unitCost', 100, 'bookedValue', 70));
  SELECT * INTO c FROM public.ncr_costs WHERE id = (res ->> 'internal')::uuid;
  PERFORM pg_temp.assert_eq(c.rate_status || '|' || c.net_base, 'actual|70.00', 'a booked value also settles a line that had no published rate');
  res := pg_temp.import_one(org, api, ann, 'ncr_cost', 'B-5', jsonb_build_object('nonconformanceId', ncr_a, 'costType', 'scrap', 'incurredOn', d::text, 'currency', 'EUR', 'unitCost', 100, 'bookedValue', -4));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'a negative booked value is refused');

  -- what is refused, with the reason
  res := pg_temp.import_one(org, api, ann, 'ncr_cost', 'X-1', base || '{"unitCost": -5}');
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'a negative amount is refused');
  PERFORM pg_temp.assert_eq(res ->> 'errors' ILIKE '%supplier recovery%', true, 'with the advice to import a credit as a recovery or a charge');
  res := pg_temp.import_one(org, api, ann, 'ncr_cost', 'X-2', (base - 'incurredOn'));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'a line with no date is refused: the date decides the rate');
  res := pg_temp.import_one(org, api, ann, 'ncr_cost', 'X-3', (base - 'costType'));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'a line with no cost type is refused');
  res := pg_temp.import_one(org, api, ann, 'ncr_cost', 'X-4', base || '{"costType": "snacks"}');
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'a cost type that is not one of the fifteen is refused');
  res := pg_temp.import_one(org, api, ann, 'ncr_cost', 'X-5', base || '{"currency": "EURO"}');
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'a currency that is not three letters is refused');
  res := pg_temp.import_one(org, api, ann, 'ncr_cost', 'X-6', (base - 'currency'));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'a line with no currency is refused');
  res := pg_temp.import_one(org, api, ann, 'ncr_cost', 'X-7', (base - 'unitCost'));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'a line with no amount is refused');
  res := pg_temp.import_one(org, api, ann, 'ncr_cost', 'X-8', base || '{"quantity": 0}');
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'a quantity of nothing is refused');
  res := pg_temp.import_one(org, api, ann, 'ncr_cost', 'X-9', (base - 'nonconformanceId'));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'a line with no non-conformance is refused');
  res := pg_temp.import_one(org, api, ann, 'ncr_cost', 'X-10', base || jsonb_build_object('nonconformanceId', gen_random_uuid()));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'a non-conformance that does not exist is refused');
  res := pg_temp.import_one(org, api, ann, 'ncr_cost', 'X-11', base || jsonb_build_object('nonconformanceId', ncr_other));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'another organisation''s non-conformance is refused');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.ncr_costs WHERE nonconformance_id = ncr_other), 0, 'and nothing is written to it');

  -- add only: the same source line again writes nothing
  n_before := (SELECT count(*) FROM public.ncr_costs WHERE organisation_id = org);
  res := pg_temp.import_one(org, api, ann, 'ncr_cost', 'L-1', base || '{"unitCost": 999}');
  PERFORM pg_temp.assert_eq(res ->> 'status' IN ('skipped', 'unchanged'), true, 'a source line already imported is not imported again: ' || coalesce(res ->> 'status', ''));
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.ncr_costs WHERE organisation_id = org), n_before::bigint, 'no new line');
  PERFORM pg_temp.assert_eq((SELECT amount FROM public.ncr_costs WHERE id = (SELECT internal_id FROM public.integration_external_records WHERE connection_id = api AND entity_type = 'ncr_cost' AND external_id = 'L-1')), 100.00::numeric, 'and the posted amount is not edited');

  -- closed and cancelled NCs refuse lines unless an import brought them in AND the cost import was told so
  res := pg_temp.import_one(org, api, ann, 'ncr_cost', 'C-1', base || jsonb_build_object('nonconformanceId', ncr_hand_closed));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'a closed NC made in Fortress refuses a line');
  PERFORM pg_temp.assert_eq(res ->> 'errors' ILIKE '%reopen%', true, 'and says to reopen it');
  res := pg_temp.import_one(org, api, ann, 'ncr_cost', 'C-2', base || jsonb_build_object('nonconformanceId', ncr_hand_closed), '{"costsOnClosed": true}');
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'even with the setting on: an NC made in Fortress stays frozen once closed');
  res := pg_temp.import_one(org, api, ann, 'ncr_cost', 'C-3', base || jsonb_build_object('nonconformanceId', ncr_imp_closed));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'an imported closed NC refuses a line while the setting is off');
  res := pg_temp.import_one(org, api, ann, 'ncr_cost', 'C-4', base || jsonb_build_object('nonconformanceId', ncr_imp_closed), '{"costsOnClosed": true}');
  PERFORM pg_temp.assert_eq(res ->> 'status', 'applied', 'with the setting on, an imported closed NC takes it: ' || coalesce(res ->> 'errors', ''));
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.nonconformances WHERE id = ncr_imp_closed), 'closed', 'and stays closed');
  res := pg_temp.import_one(org, api, ann, 'ncr_cost', 'C-5', base || jsonb_build_object('nonconformanceId', ncr_imp_cancelled), '{"costsOnClosed": true}');
  PERFORM pg_temp.assert_eq(res ->> 'status', 'applied', 'so does an imported cancelled NC');
  res := pg_temp.import_one(org, api, ann, 'ncr_cost', 'C-6', base || jsonb_build_object('nonconformanceId', ncr_deleted), '{"costsOnClosed": true}');
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'a deleted NC never does');
  res := pg_temp.import_one(org, api, ann, 'ncr_cost', 'C-7', base || jsonb_build_object('nonconformanceId', ncr_imp_open), '{"costsOnClosed": true}');
  PERFORM pg_temp.assert_eq(res ->> 'status', 'applied', 'an imported open NC takes a line, setting or not');
  -- a booked value works on a closed NC as well
  res := pg_temp.import_one(org, api, ann, 'ncr_cost', 'C-8', jsonb_build_object('nonconformanceId', ncr_imp_closed, 'costType', 'scrap', 'incurredOn', d::text, 'currency', 'EUR', 'unitCost', 100, 'bookedValue', 90), '{"costsOnClosed": true}');
  PERFORM pg_temp.assert_eq((SELECT rate_status FROM public.ncr_costs WHERE id = (res ->> 'internal')::uuid), 'actual', 'a booked value is applied on an imported closed NC too');
  PERFORM pg_temp.assert_eq(coalesce(current_setting('app.ncr_cost_on_closed', true), 'off'), 'off', 'the switch is off again');

  -- nobody else can use the way in: a person who switches it on themselves, and a person adding a cost to the closed NC the usual way
  -- (a person's request is its own transaction: the source the imports above left set in this one is cleared)
  PERFORM set_config('app.source', '', true);
  PERFORM pg_temp.login(ann);
  PERFORM set_config('app.ncr_cost_on_closed', 'on', true);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($q$INSERT INTO public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, unit_cost) VALUES (%L, %L, 'scrap', 'GBP', 5)$q$, org, ncr_imp_closed)), 5), 'QM005',
    'the switch alone does nothing for a person: it needs the integration source');
  PERFORM set_config('app.ncr_cost_on_closed', 'off', true);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($q$INSERT INTO public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, unit_cost) VALUES (%L, %L, 'scrap', 'GBP', 5)$q$, org, ncr_imp_closed)), 5), 'QM005',
    'a person cannot add a cost to an imported closed NC by hand');
  PERFORM pg_temp.logout();

  -- the right to change the NC: the run itself needs it, and the importer checks it again for the person it acts for
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($q$SELECT pg_temp.import_one(%L, %L, %L, 'ncr_cost', 'P-1', %L::jsonb)$q$, org, api, viv, base::text)), 5), '42501', 'someone who may create NCs but not change them cannot start a cost import');
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', zed, 'role', 'authenticated')::text, true);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($q$SELECT app.import_ncr_cost(%L, NULL, %L::jsonb)$q$, org, base::text)), 5), 'QM022', 'and the importer refuses a line for someone without that right');
  PERFORM set_config('request.jwt.claims', '', true);

  -- nothing is announced
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.outbox_events WHERE organisation_id = org), events_before, 'cost lines raise no event');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.notifications WHERE organisation_id = org), notes_before, 'and no notice');

  -- the link to the NC: by the id the source uses (the import map), or by the Fortress reference, ignoring case
  PERFORM pg_temp.login(ann);
  refs := app.integration_reference_check(org, 'nonconformance', 'source', api, ARRAY['N-OPEN', 'N-CLOSED', 'no-such-id']);
  PERFORM pg_temp.assert_eq(refs ->> 'N-OPEN', ncr_imp_open::text, 'the source''s id for an NC finds the NC an earlier import made');
  PERFORM pg_temp.assert_eq(refs ? 'no-such-id', false, 'an id the connection never imported finds nothing');
  refs := app.integration_reference_check(org, 'nonconformance', 'code', NULL, ARRAY[(SELECT lower(reference) FROM public.nonconformances WHERE id = ncr_a), 'NOPE-1']);
  PERFORM pg_temp.assert_eq(refs -> (SELECT lower(reference) FROM public.nonconformances WHERE id = ncr_a), to_jsonb(ncr_a::text), 'a Fortress reference finds it, whatever the case');
  PERFORM pg_temp.assert_eq(refs ? 'NOPE-1', false, 'a reference nobody has finds nothing');
  refs := app.integration_reference_values(org, 'nonconformance', 'Imported closed', 20, 0);
  PERFORM pg_temp.assert_eq((refs ->> 'total')::int, 1, 'the list of allowed values finds an NC by its title');
  PERFORM pg_temp.assert_eq(refs -> 'data' -> 0 ->> 'hint', 'closed', 'with its stage as the hint');
  PERFORM pg_temp.assert_eq((app.integration_reference_values(org, 'nonconformance', 'Imported then deleted', 20, 0) ->> 'total')::int, 0, 'a deleted NC is not in it');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(bea);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($q$SELECT app.integration_reference_check(%L, 'nonconformance', 'code', NULL, ARRAY['x'])$q$, org)), 5), 'P0002', 'another organisation cannot ask');
  PERFORM pg_temp.logout();

  -- the summary before anything is written: a preview run of several rows
  PERFORM pg_temp.login(ann); run := app.request_integration_run(api, 'ncr_cost', 'preview', NULL, NULL); PERFORM pg_temp.logout();
  PERFORM app.system_lease_integration_run(org, run, owner, 30);
  PERFORM app.system_stage_integration_records(org, run, owner, jsonb_build_array(
    jsonb_build_object('externalId', 'S-1', 'payload', '{}'::jsonb, 'canonical', jsonb_build_object('nonconformanceId', ncr_a, 'costType', 'scrap', 'incurredOn', d::text, 'currency', 'EUR', 'unitCost', 1)),
    jsonb_build_object('externalId', 'S-2', 'payload', '{}'::jsonb, 'canonical', jsonb_build_object('nonconformanceId', ncr_a, 'costType', 'scrap', 'incurredOn', d::text, 'currency', 'USD', 'unitCost', 1, 'bookedValue', 1)),
    jsonb_build_object('externalId', 'S-3', 'payload', '{}'::jsonb, 'canonical', jsonb_build_object('nonconformanceId', ncr_a, 'costType', 'scrap', 'incurredOn', d::text, 'currency', 'CAD', 'unitCost', 1)),
    jsonb_build_object('externalId', 'S-4', 'payload', '{}'::jsonb, 'canonical', jsonb_build_object('nonconformanceId', ncr_a, 'costType', 'scrap', 'incurredOn', d::text, 'currency', 'GBP', 'unitCost', 1)),
    jsonb_build_object('externalId', 'S-5', 'payload', '{}'::jsonb, 'canonical', jsonb_build_object('nonconformanceId', ncr_imp_closed, 'costType', 'scrap', 'incurredOn', d::text, 'currency', 'GBP', 'unitCost', 1)),
    jsonb_build_object('externalId', 'S-6', 'payload', '{}'::jsonb, 'canonical', jsonb_build_object('nonconformanceId', ncr_imp_cancelled, 'costType', 'scrap', 'incurredOn', d::text, 'currency', 'gbp', 'unitCost', 1))), NULL, true);
  -- what the API fetches before it writes a line: only the pairs the cache does not answer
  sm := app.system_integration_cost_rates_needed(org, run, owner);
  PERFORM pg_temp.assert_eq(jsonb_array_length(sm), 1, 'only one pair is missing from the cache: the Canadian dollar');
  PERFORM pg_temp.assert_eq(sm -> 0 ->> 'base', 'CAD', 'it is the Canadian dollar');
  PERFORM pg_temp.assert_eq(sm -> 0 -> 'quotes', '["GBP"]'::jsonb, 'wanted in pounds, the site and organisation currency');
  PERFORM pg_temp.assert_eq(sm -> 0 ->> 'requestedOn', d::text, 'on its own day');
  PERFORM app.system_finish_integration_run(org, run, owner);
  PERFORM pg_temp.login(ann);
  sm := app.integration_cost_run_summary(run);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((sm ->> 'lines')::int, 6, 'the summary counts every line in the preview');
  PERFORM pg_temp.assert_eq((sm ->> 'onClosed')::int || '|' || (sm ->> 'onCancelled')::int || '|' || (sm ->> 'booked')::int, '1|1|1', 'how many go onto closed and cancelled NCs, and how many carry a booked value');
  PERFORM pg_temp.assert_eq((SELECT (e ->> 'waiting')::int FROM jsonb_array_elements(sm -> 'currencies') e WHERE e ->> 'currency' = 'CAD'), 1, 'a currency with no published rate will wait');
  PERFORM pg_temp.assert_eq((SELECT (e ->> 'withRate')::int FROM jsonb_array_elements(sm -> 'currencies') e WHERE e ->> 'currency' = 'EUR'), 1, 'one with a rate for its date will not');
  PERFORM pg_temp.assert_eq((SELECT (e ->> 'withRate')::int FROM jsonb_array_elements(sm -> 'currencies') e WHERE e ->> 'currency' = 'GBP'), 3, 'and one already in the site currency needs none, in any case of letters');
  PERFORM pg_temp.login(zed);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($q$SELECT app.integration_cost_run_summary(%L)$q$, run)), 5), 'P0002', 'the summary is for people who read integrations');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($q$SELECT app.integration_cost_run_summary(%L)$q$, (SELECT id FROM public.integration_sync_runs WHERE organisation_id = org AND entity_type = 'nonconformance' LIMIT 1))), 5), 'QM022', 'and only for cost imports');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
