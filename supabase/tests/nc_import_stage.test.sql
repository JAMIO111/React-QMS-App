-- Importing non-conformances with the source's stage (docs/cost-import-plan.md §7): the stage is taken as given, the opening rules still apply, the stage gates are skipped
-- for history only, a stage past open needs the right to approve dispositions, nothing is announced, and a person still cannot insert such an NC by hand.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('5f700000-0000-0000-0000-000000000a01', 'ann@ncstage.test'), ('5f700000-0000-0000-0000-000000000a02', 'viv@ncstage.test'), ('5f700000-0000-0000-0000-000000000a03', 'zed@ncstage.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

CREATE FUNCTION pg_temp.import_one(p_org uuid, p_conn uuid, p_user uuid, p_entity text, p_ext text, p_canonical jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE run uuid; owner uuid := gen_random_uuid(); todo jsonb; v_id uuid; row_id uuid; i public.integration_inbox%ROWTYPE;
BEGIN
  PERFORM pg_temp.login(p_user); run := app.request_integration_run(p_conn, p_entity, 'full', NULL, NULL); PERFORM pg_temp.logout();
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
  SELECT * INTO i FROM public.integration_inbox WHERE run_id = run;
  RETURN jsonb_build_object('status', i.status, 'internal', i.internal_id, 'errors', i.errors, 'action', i.action);
END $$;

DO $$
DECLARE
  ann uuid := '5f700000-0000-0000-0000-000000000a01'; viv uuid := '5f700000-0000-0000-0000-000000000a02'; zed uuid := '5f700000-0000-0000-0000-000000000a03';
  org uuid; api uuid; cat uuid; res jsonb; nc uuid; r_eng uuid; r_viewer uuid; base jsonb; events_before bigint; notes_before bigint;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('NC Stage Alpha'); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, viv, 'active'), (org, zed, 'active');
  -- a custom role that may run imports and create NCs but not approve dispositions (no built-in role is like that)
  INSERT INTO public.roles (organisation_id, key, name, is_system) VALUES (org, 'importer', 'Importer', false) RETURNING id INTO r_eng;
  INSERT INTO public.role_permissions (role_id, permission_code) VALUES (r_eng, 'integrations.read'), (r_eng, 'integrations.run'), (r_eng, 'ncr.read'), (r_eng, 'ncr.create');
  SELECT id INTO r_viewer FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, ou.id, r_eng FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id = viv;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, ou.id, r_viewer FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id = zed;
  PERFORM pg_temp.give_controller_seat(org, ann);
  PERFORM pg_temp.give_controller_seat(org, viv);
  cat := pg_temp.cat(org);

  PERFORM pg_temp.login(ann);
  api := app.create_integration_connection(org, 'rest_api', 'ERP', 'erp', '{"baseUrl": "https://erp.example.com", "authType": "none"}'::jsonb);
  PERFORM app.record_integration_connection_test(api, true, 'ok');
  PERFORM app.mark_integration_ready(api);
  PERFORM app.activate_integration_connection(api);
  PERFORM pg_temp.logout();

  base := jsonb_build_object('source', 'internal', 'severity', 'minor', 'quantityAffected', 5, 'description', 'Burr on the flange', 'categoryId', cat, 'detectedAt', '2026-01-10');

  -- a draft is imported exactly as before: a draft, and the usual event
  res := pg_temp.import_one(org, api, ann, 'nonconformance', 'NC-D', base || '{"title": "Draft one"}');
  PERFORM pg_temp.assert_eq(res ->> 'status', 'applied', 'a draft is imported: ' || coalesce(res ->> 'errors', ''));
  nc := (res ->> 'internal')::uuid;
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.nonconformances WHERE id = nc), 'draft', 'with no stage given it is a draft');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.outbox_events WHERE entity_id = nc AND event_type = 'ncr.created'), 1, 'and raises its event as before');
  events_before := (SELECT count(*) FROM public.outbox_events WHERE organisation_id = org);
  notes_before := (SELECT count(*) FROM public.notifications WHERE organisation_id = org);

  -- closed, as the source has it
  res := pg_temp.import_one(org, api, ann, 'nonconformance', 'NC-C', base || '{"title": "Closed long ago", "stage": "closed", "closedOn": "2026-02-01"}');
  PERFORM pg_temp.assert_eq(res ->> 'status', 'applied', 'a closed one is imported: ' || coalesce(res ->> 'errors', ''));
  nc := (res ->> 'internal')::uuid;
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.nonconformances WHERE id = nc), 'closed', 'it is closed');
  PERFORM pg_temp.assert_eq((SELECT closed_at::date FROM public.nonconformances WHERE id = nc), '2026-02-01'::date, 'on the date the source gave');
  PERFORM pg_temp.assert_eq((SELECT closed_by IS NULL FROM public.nonconformances WHERE id = nc), true, 'closed by nobody in particular: it is history');
  PERFORM pg_temp.assert_eq((SELECT stage_reason IS NULL FROM public.nonconformances WHERE id = nc), true, 'with no stage reason');
  PERFORM pg_temp.assert_eq((SELECT reference IS NOT NULL AND reference <> '' FROM public.nonconformances WHERE id = nc), true, 'and a Fortress reference');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM audit.events e WHERE e.entity_type = 'nonconformances' AND e.entity_id = nc::text AND e.action = 'insert'), 1, 'its audit trail is written as for any record');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.outbox_events WHERE organisation_id = org), events_before, 'history raises no event (so no workflow starts)');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.notifications WHERE organisation_id = org), notes_before, 'and no notice');
  PERFORM pg_temp.assert_eq(coalesce(current_setting('app.ncr_history_import', true), 'off'), 'off', 'the switch is off again afterwards');

  -- closed with no date: the import day; not in the future; not before it was detected
  res := pg_temp.import_one(org, api, ann, 'nonconformance', 'NC-C2', base || '{"title": "Closed no date", "stage": "closed"}');
  PERFORM pg_temp.assert_eq(res ->> 'status', 'applied', 'a closed one with no date is imported');
  PERFORM pg_temp.assert_eq((SELECT closed_at::date FROM public.nonconformances WHERE id = (res ->> 'internal')::uuid), current_date, 'it is closed today');
  res := pg_temp.import_one(org, api, ann, 'nonconformance', 'NC-C3', base || '{"title": "Closed in the future", "stage": "closed", "closedOn": "2999-01-01"}');
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'a closed date in the future is refused');
  res := pg_temp.import_one(org, api, ann, 'nonconformance', 'NC-C4', base || '{"title": "Closed before detected", "stage": "closed", "closedOn": "2025-12-01"}');
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'a closed date before it was detected is refused');

  res := pg_temp.import_one(org, api, ann, 'nonconformance', 'NC-C5', (base - 'detectedAt') || '{"title": "Closed, detected date unknown", "stage": "closed", "closedOn": "2026-02-01"}');
  PERFORM pg_temp.assert_eq(res ->> 'status', 'applied', 'a closed date in the past is fine when the source gave no detected date: ' || coalesce(res ->> 'errors', ''));

  -- open, and the stages between
  res := pg_temp.import_one(org, api, ann, 'nonconformance', 'NC-O', base || '{"title": "Still open", "stage": "open"}');
  PERFORM pg_temp.assert_eq(res ->> 'status', 'applied', 'an open one is imported');
  nc := (res ->> 'internal')::uuid;
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.nonconformances WHERE id = nc), 'open', 'it is open');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.outbox_events WHERE entity_id = nc), 0, 'with no event');
  res := pg_temp.import_one(org, api, ann, 'nonconformance', 'NC-I', base || '{"title": "Investigating", "stage": "investigating"}');
  PERFORM pg_temp.assert_eq(res ->> 'status', 'applied', 'an investigating one is imported with no containment or disposition records');
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.nonconformances WHERE id = (res ->> 'internal')::uuid), 'investigating', 'at that stage');

  -- the opening rules still apply past draft
  res := pg_temp.import_one(org, api, ann, 'nonconformance', 'NC-X1', jsonb_build_object('source', 'internal', 'title', 'No category', 'severity', 'minor', 'quantityAffected', 1, 'description', 'x', 'stage', 'open'));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'no category: refused');
  PERFORM pg_temp.assert_eq(res ->> 'errors' ILIKE '%category%', true, 'and it says what is missing');
  res := pg_temp.import_one(org, api, ann, 'nonconformance', 'NC-X2', (base - 'severity') || '{"title": "No severity", "stage": "closed"}');
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'no severity on a closed one: refused');
  res := pg_temp.import_one(org, api, ann, 'nonconformance', 'NC-X3', base || '{"title": "Customer, no customer", "source": "customer", "stage": "open"}');
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'a customer NC with no customer: refused');
  res := pg_temp.import_one(org, api, ann, 'nonconformance', 'NC-X4', jsonb_build_object('source', 'internal', 'title', 'Draft needs nothing', 'stage', 'draft'));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'applied', 'a draft still needs nothing');
  res := pg_temp.import_one(org, api, ann, 'nonconformance', 'NC-X5', base || '{"title": "Not a stage", "stage": "finished"}');
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'a stage that is not one of the eight is refused');

  -- cancelled: a reason from the source, or a default; needs no opening fields
  res := pg_temp.import_one(org, api, ann, 'nonconformance', 'NC-K1', jsonb_build_object('source', 'internal', 'title', 'Cancelled early', 'stage', 'cancelled'));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'applied', 'a cancelled one is imported without the opening fields: ' || coalesce(res ->> 'errors', ''));
  PERFORM pg_temp.assert_eq((SELECT stage_reason FROM public.nonconformances WHERE id = (res ->> 'internal')::uuid), 'Cancelled in erp', 'with a default reason naming the connection');
  res := pg_temp.import_one(org, api, ann, 'nonconformance', 'NC-K2', jsonb_build_object('source', 'internal', 'title', 'Cancelled, duplicate', 'stage', 'cancelled', 'stageReason', 'Duplicate of NC-7'));
  PERFORM pg_temp.assert_eq((SELECT stage_reason FROM public.nonconformances WHERE id = (res ->> 'internal')::uuid), 'Duplicate of NC-7', 'or the source''s own reason');
  res := pg_temp.import_one(org, api, ann, 'nonconformance', 'NC-K3', base || '{"title": "Open with a reason", "stage": "open", "stageReason": "ignored", "closedOn": "2026-02-01"}');
  PERFORM pg_temp.assert_eq((SELECT stage_reason IS NULL AND closed_at IS NULL FROM public.nonconformances WHERE id = (res ->> 'internal')::uuid), true, 'a reason or a closed date on an NC that is not cancelled or closed is ignored');

  -- who may skip containment and disposition: an importer role may create NCs but not approve dispositions
  res := pg_temp.import_one(org, api, viv, 'nonconformance', 'NC-V1', base || '{"title": "Engineer, closed", "stage": "closed"}');
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'closed needs the right to approve dispositions');
  PERFORM pg_temp.assert_eq(res ->> 'errors' ILIKE '%approve dispositions%', true, 'and says so');
  res := pg_temp.import_one(org, api, viv, 'nonconformance', 'NC-V2', base || '{"title": "Engineer, dispositioned", "stage": "dispositioned"}');
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'so does every stage between open and closed');
  res := pg_temp.import_one(org, api, viv, 'nonconformance', 'NC-V3', base || '{"title": "Engineer, open", "stage": "open"}');
  PERFORM pg_temp.assert_eq(res ->> 'status', 'applied', 'open needs only the right to create');
  res := pg_temp.import_one(org, api, viv, 'nonconformance', 'NC-V4', jsonb_build_object('source', 'internal', 'title', 'Engineer, cancelled', 'stage', 'cancelled'));
  PERFORM pg_temp.assert_eq(res ->> 'status', 'applied', 'and so does cancelled');

  -- a person still cannot make one by hand, and the gates apply once it is in
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($q$INSERT INTO public.nonconformances (organisation_id, source, stage, title, severity, quantity_affected, description, category_id)
    VALUES (%L, 'internal', 'closed', 'By hand', 'minor', 1, 'x', %L)$q$, org, cat)), 5), 'QM005', 'a person cannot insert a closed non-conformance');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($q$UPDATE public.nonconformances SET stage = 'contained' WHERE id = %L$q$, (SELECT id FROM public.nonconformances WHERE organisation_id = org AND title = 'Still open'))), 5), 'QM005',
    'an imported open NC meets the stage gates when a person moves it on');
  PERFORM pg_temp.logout();

  -- a failed row leaves the switch off for the next one
  res := pg_temp.import_one(org, api, ann, 'nonconformance', 'NC-F1', base || '{"title": "Closed before detected again", "stage": "closed", "closedOn": "2025-01-01"}');
  PERFORM pg_temp.assert_eq(res ->> 'status', 'failed', 'a refused row');
  PERFORM pg_temp.assert_eq(coalesce(current_setting('app.ncr_history_import', true), 'off') <> 'on', true, 'leaves nothing switched on behind it');
  res := pg_temp.import_one(org, api, ann, 'nonconformance', 'NC-F2', base || '{"title": "Draft after a refusal", "stage": "draft"}');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.outbox_events WHERE entity_id = (res ->> 'internal')::uuid AND event_type = 'ncr.created'), 1, 'so the next draft still raises its event');
END $$;

ROLLBACK;
