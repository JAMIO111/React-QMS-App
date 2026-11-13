-- Workflow rules WF2: testing a rule against a recent event. The latest events of a kind with the facts a rule would test, only those the caller may read; who each
-- action would reach and whether each may be told; nothing written; only for people who manage workflows, only in their own organisation.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
  ('3e400000-0000-0000-0000-000000000101', 'ann@wft.test', now()),
  ('3e400000-0000-0000-0000-000000000102', 'bob@wft.test', now()),
  ('3e400000-0000-0000-0000-000000000103', 'cat@wft.test', now()),
  ('3e400000-0000-0000-0000-000000000104', 'eve@wft.test', now());

CREATE FUNCTION pg_temp.assert_true(p boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p IS NOT TRUE THEN RAISE EXCEPTION 'FAILED: %', label; END IF; END $$;
CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '3e400000-0000-0000-0000-000000000101'; bob uuid := '3e400000-0000-0000-0000-000000000102';
  cat uuid := '3e400000-0000-0000-0000-000000000103'; eve uuid := '3e400000-0000-0000-0000-000000000104';
  org uuid; org2 uuid; ncr uuid; ncr2 uuid; ev bigint; ev2 bigint; ev3 bigint; qm_role uuid; r jsonb; m uuid; before bigint;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('Test Works', 'Plant A', 'PA', NULL); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('Other Works', 'Plant B', 'PB', NULL); PERFORM pg_temp.logout();
  FOREACH m IN ARRAY ARRAY[bob, cat] LOOP INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, m, 'active'); END LOOP;
  SELECT id INTO qm_role FROM public.roles WHERE organisation_id = org AND key = 'quality_manager';
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, CASE ou.user_id WHEN bob THEN qm_role ELSE (SELECT id FROM public.roles WHERE organisation_id = org AND key = 'viewer') END
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id IN (bob, cat);

  INSERT INTO public.nonconformances (organisation_id, reference, source, stage, severity, title, category_id, owner_id)
  VALUES (org, 'NCR-T-1', 'internal', 'open', 'major', 'Burr', pg_temp.cat(org), cat) RETURNING id INTO ncr;
  INSERT INTO public.nonconformances (organisation_id, reference, source, stage, severity, title, category_id)
  VALUES (org, 'NCR-T-2', 'customer', 'draft', 'minor', 'Scratch', pg_temp.cat(org)) RETURNING id INTO ncr2;
  INSERT INTO public.outbox_events (organisation_id, event_type, entity_type, entity_id) VALUES (org, 'ncr.created', 'nonconformance', ncr) RETURNING id INTO ev;
  INSERT INTO public.outbox_events (organisation_id, event_type, entity_type, entity_id) VALUES (org, 'ncr.created', 'nonconformance', ncr2) RETURNING id INTO ev2;
  INSERT INTO public.outbox_events (organisation_id, event_type, entity_type, entity_id) VALUES (org, 'ncr.created', 'nonconformance', gen_random_uuid()) RETURNING id INTO ev3;
  SELECT count(*) INTO before FROM public.workflow_runs;

  -- ---- recent events ----
  PERFORM pg_temp.login(cat);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format('SELECT * FROM app.workflow_recent_events(%L, %L)', org, 'ncr.created')), 5), '42501', 'a viewer cannot test rules');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format('SELECT * FROM app.workflow_recent_events(%L, %L)', org, 'nonsense')), 5), 'QM028', 'only a catalogue trigger');
  PERFORM pg_temp.assert_eq((SELECT string_agg(facts ->> 'label', ',' ORDER BY event_id DESC) FROM app.workflow_recent_events(org, 'ncr.created')),
    'NCR-T-2 · Scratch,NCR-T-1 · Burr', 'newest first, with the facts; an event whose record is gone is left out');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.workflow_recent_events(org, 'ncr.created', 1)), 1::bigint, 'a limit');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format('SELECT * FROM app.workflow_recent_events(%L, %L)', org2, 'ncr.created')), 5), '42501', 'not in another organisation');

  -- ---- who an action would reach ----
  r := app.workflow_preview_people(org, ev, jsonb_build_array(
    jsonb_build_object('type', 'notify', 'recipients', jsonb_build_array(jsonb_build_object('kind', 'role', 'roleId', qm_role), jsonb_build_object('kind', 'record_owner'),
                                                                         jsonb_build_object('kind', 'person', 'userId', eve))),
    jsonb_build_object('type', 'task', 'assignee', jsonb_build_object('kind', 'record_owner'))));
  PERFORM pg_temp.assert_eq(r -> 'facts' ->> 'severity', 'major', 'the facts of the event');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM jsonb_array_elements(r -> 'actions' -> 0 -> 'people') p WHERE (p ->> 'told')::boolean), 2::bigint,
    'Bob (role) and Cat (owner) would be told: ' || r::text);
  PERFORM pg_temp.assert_eq((SELECT p ->> 'told' FROM jsonb_array_elements(r -> 'actions' -> 0 -> 'people') p WHERE p ->> 'userId' = eve::text), 'false', 'Eve would not');
  PERFORM pg_temp.assert_eq(r -> 'actions' -> 1 -> 'people' -> 0 ->> 'userId', cat::text, 'the task would go to the owner');
  r := app.workflow_preview_people(org, ev2, '[{"type":"task","assignee":{"kind":"record_owner"}}]');
  PERFORM pg_temp.assert_eq(r -> 'actions' -> 0 ->> 'total', '0', 'no owner, nobody for the task');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($q$SELECT app.workflow_preview_people(%L, %s, '[]')$q$, org, ev3)), 5), 'P0002', 'a record that is gone');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($q$SELECT app.workflow_preview_people(%L, %s, '[]')$q$, org2, ev)), 5), '42501', 'not across organisations');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($q$SELECT app.workflow_preview_people(%L, %s, '[]')$q$, org2, ev)), 5), 'P0002', 'another organisation''s event is not found');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.workflow_runs), before, 'testing writes nothing');
  PERFORM pg_temp.assert_eq(has_function_privilege('anon', 'app.workflow_preview_people(uuid,bigint,jsonb)', 'execute'), false, 'not for anon');
END $$;

ROLLBACK;
