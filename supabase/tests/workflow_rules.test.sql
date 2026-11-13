-- Workflow rules WF1 (docs/workflow-engine-plan.md): writing rules and their versions, the trigger catalogue and facts, runs once per version and event, notices
-- and tasks only to people who may read the record (once each), tasks done / reopened / cancelled by the right people, and who may call what.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
  ('3e300000-0000-0000-0000-000000000101', 'ann@wf.test', now()),
  ('3e300000-0000-0000-0000-000000000102', 'bob@wf.test', now()),
  ('3e300000-0000-0000-0000-000000000103', 'cat@wf.test', now()),
  ('3e300000-0000-0000-0000-000000000104', 'eve@wf.test', now());

CREATE FUNCTION pg_temp.assert_true(p boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p IS NOT TRUE THEN RAISE EXCEPTION 'FAILED: %', label; END IF; END $$;
CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '3e300000-0000-0000-0000-000000000101'; bob uuid := '3e300000-0000-0000-0000-000000000102';
  cat uuid := '3e300000-0000-0000-0000-000000000103'; eve uuid := '3e300000-0000-0000-0000-000000000104';
  org uuid; org2 uuid; rule uuid; v1 uuid; v2 uuid; ncr uuid; ev bigint; facts jsonb; run record; run2 record; r jsonb; task uuid; qm_role uuid;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('Flow Works', 'Plant A', 'PA', NULL); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('Other Works', 'Plant B', 'PB', NULL); PERFORM pg_temp.logout();
  FOREACH task IN ARRAY ARRAY[bob, cat] LOOP INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, task, 'active'); END LOOP;
  -- Bob: quality manager (reads NCs, manages workflows). Cat: viewer.
  SELECT id INTO qm_role FROM public.roles WHERE organisation_id = org AND key = 'quality_manager';
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, CASE ou.user_id WHEN bob THEN qm_role ELSE (SELECT id FROM public.roles WHERE organisation_id = org AND key = 'viewer') END
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id IN (bob, cat);

  -- ---- the catalogue ----
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.workflow_triggers()), 8::bigint, 'eight things can start a rule');

  -- ---- writing a rule ----
  PERFORM pg_temp.login(cat);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($q$SELECT app.save_workflow_rule(%L, '{"name":"x","trigger":"ncr.created","actions":[{"type":"notify"}]}')$q$, org)), 5), '42501',
    'a viewer cannot write rules');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.workflow_rules), 0::bigint, 'nor read them');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($q$SELECT app.save_workflow_rule(%L, '{"name":"x","trigger":"nonsense","actions":[{"type":"notify"}]}')$q$, org)), 5), 'QM028',
    'only a catalogue trigger');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($q$SELECT app.save_workflow_rule(%L, '{"name":"x","trigger":"ncr.created","actions":[]}')$q$, org)), 5), 'QM028',
    'a rule does something');
  rule := app.save_workflow_rule(org, jsonb_build_object('name', 'Major NCs to the quality manager', 'trigger', 'ncr.created',
    'conditions', '{"all":[{"field":"severity","op":"in","value":["major","critical"]}]}'::jsonb,
    'actions', jsonb_build_array(jsonb_build_object('type', 'notify', 'recipients', jsonb_build_array(jsonb_build_object('kind', 'role', 'roleId', qm_role)), 'message', 'Have a look'))));
  PERFORM pg_temp.assert_eq((SELECT reference || '/' || current_version || '/' || status FROM public.workflow_rules WHERE id = rule), 'WF-001/1/active', 'WF-001, version 1, active');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($q$SELECT app.save_workflow_rule(%L, '{"conditions":{"all":[]}}', %L)$q$, org, rule)), 5), 'QM028',
    'a change to what it does needs a reason');
  PERFORM app.save_workflow_rule(org, '{"name":"Major NCs to QM"}'::jsonb, rule);
  PERFORM pg_temp.assert_eq((SELECT name || '/' || current_version FROM public.workflow_rules WHERE id = rule), 'Major NCs to QM/1', 'a new name is not a new version');
  PERFORM app.save_workflow_rule(org, jsonb_build_object('conditions', '{"all":[{"field":"severity","op":"in","value":["major","critical"]}]}'::jsonb, 'reason', 'x'), rule);
  PERFORM pg_temp.assert_eq((SELECT current_version FROM public.workflow_rules WHERE id = rule), 1, 'saving the same content changes nothing, even with a reason');
  PERFORM app.save_workflow_rule(org, jsonb_build_object('actions', jsonb_build_array(
    jsonb_build_object('type', 'notify', 'recipients', jsonb_build_array(jsonb_build_object('kind', 'role', 'roleId', qm_role), jsonb_build_object('kind', 'person', 'userId', cat),
                                                                         jsonb_build_object('kind', 'person', 'userId', eve)), 'message', 'Have a look'),
    jsonb_build_object('type', 'task', 'assignee', jsonb_build_object('kind', 'person', 'userId', bob), 'title', 'Check containment', 'dueDays', 2)), 'reason', 'Add a task'), rule);
  SELECT id INTO v2 FROM public.workflow_rule_versions WHERE rule_id = rule AND version = 2;
  PERFORM pg_temp.assert_eq((SELECT reason FROM public.workflow_rule_versions WHERE id = v2), 'Add a task', 'version 2 keeps its reason');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format('UPDATE public.workflow_rule_versions SET reason = %L WHERE id = %L', 'y', v2)), 5), 'QM028', 'a version is frozen, even for SQL');

  -- ---- status ----
  PERFORM pg_temp.login(ann);
  PERFORM app.set_workflow_rule_status(rule, 'paused');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.system_workflow_rules_for(org, 'ncr.created')), 0::bigint, 'a paused rule does not run');
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format('SELECT app.set_workflow_rule_status(%L, %L, NULL)', rule, 'retired')), 5), 'QM028', 'retiring needs a reason');
  PERFORM app.set_workflow_rule_status(rule, 'active');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT rule_version_id FROM app.system_workflow_rules_for(org, 'ncr.created')), v2, 'the active rule runs at its current version');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.system_workflow_rules_for(org, 'ncr.closed')), 0::bigint, 'only for its own trigger');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.system_workflow_rules_for(org2, 'ncr.created')), 0::bigint, 'only in its own organisation');

  -- ---- an NC is raised: facts ----
  INSERT INTO public.nonconformances (organisation_id, reference, source, stage, severity, title, category_id, owner_id)
  VALUES (org, 'NCR-WF-1', 'internal', 'open', 'major', 'Burr on bore', pg_temp.cat(org), cat) RETURNING id INTO ncr;
  SELECT id INTO ev FROM public.outbox_events WHERE entity_id = ncr AND event_type = 'ncr.created';
  IF ev IS NULL THEN
    INSERT INTO public.outbox_events (organisation_id, event_type, entity_type, entity_id) VALUES (org, 'ncr.created', 'nonconformance', ncr) RETURNING id INTO ev;
  END IF;
  facts := app.system_workflow_facts(org, 'nonconformance', ncr, '{}');
  PERFORM pg_temp.assert_eq(facts ->> 'severity' || '/' || (facts ->> 'label') || '/' || (facts ->> 'record_kind') || '/' || (facts ->> 'owner_user_id'),
    'major/NCR-WF-1 · Burr on bore/nonconformance/' || cat, 'the facts about the NC');
  PERFORM pg_temp.assert_eq(app.system_workflow_facts(org2, 'nonconformance', ncr, '{}'), NULL::jsonb, 'no facts across organisations');

  -- ---- a run, once ----
  SELECT * INTO run FROM app.system_record_workflow_run(org, v2, ev, 'ncr.created', 'nonconformance', ncr, facts);
  PERFORM pg_temp.assert_true(run.created, 'a run is recorded');
  SELECT * INTO run2 FROM app.system_record_workflow_run(org, v2, ev, 'ncr.created', 'nonconformance', ncr, facts);
  PERFORM pg_temp.assert_true(NOT run2.created AND run2.run_id = run.run_id, 'the same version and event never run twice');

  -- ---- notify ----
  r := app.system_workflow_notify(run.run_id, 0, (SELECT actions -> 0 -> 'recipients' FROM public.workflow_rule_versions WHERE id = v2), 'Have a look');
  PERFORM pg_temp.assert_eq(r ->> 'told' || '/' || (r ->> 'skipped'), '2/1', 'Bob (holds the quality manager role) and Cat (named) told; Eve (another organisation) skipped: ' || r::text);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.workflow_notices WHERE run_id = run.run_id AND user_id = eve), 0::bigint, 'nobody outside the organisation is told');
  r := app.system_workflow_notify(run.run_id, 0, (SELECT actions -> 0 -> 'recipients' FROM public.workflow_rule_versions WHERE id = v2), 'Have a look');
  PERFORM pg_temp.assert_eq(r ->> 'told', '0', 'a retry tells nobody twice');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.notifications n JOIN public.notification_event_types t ON t.id = n.event_type_id
                               WHERE n.organisation_id = org AND t.key = 'workflow_notices.created' AND n.recipient_user_id = cat AND n.actor_user_id IS NULL), 1::bigint,
    'Cat gets one notice, addressed to her, from nobody');
  PERFORM pg_temp.assert_true((SELECT n.body FROM public.notifications n JOIN public.notification_event_types t ON t.id = n.event_type_id
                                WHERE n.organisation_id = org AND t.key = 'workflow_notices.created' AND n.recipient_user_id = cat) = 'Major NCs to QM — NCR-WF-1 · Burr on bore — Have a look',
    'the notice says which rule, which record and the message');

  -- ---- task ----
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($q$SELECT app.system_workflow_task(%L, 1, '{"kind":"role"}', 'x', NULL, NULL)$q$, run.run_id)), 5), '22023', 'a task goes to one person');
  r := app.system_workflow_task(run.run_id, 1, jsonb_build_object('kind', 'person', 'userId', bob), 'Check containment', NULL, 2);
  PERFORM pg_temp.assert_true((r ->> 'created')::boolean AND r ->> 'reference' ~ '^TSK-[0-9]{2}-0001$', 'a task, numbered: ' || r::text);
  task := (r ->> 'taskId')::uuid;
  PERFORM pg_temp.assert_eq((app.system_workflow_task(run.run_id, 1, jsonb_build_object('kind', 'person', 'userId', bob), 'Check containment', NULL, 2) ->> 'created'), 'false',
    'a retry gives no second task');
  PERFORM pg_temp.assert_eq((SELECT due_on FROM public.workflow_tasks WHERE id = task), (now() AT TIME ZONE app.organisation_time_zone(org))::date + 2, 'due in two days');
  r := app.system_workflow_task(run.run_id, 2, jsonb_build_object('kind', 'person', 'userId', eve), 'x', NULL, NULL);
  PERFORM pg_temp.assert_true(r ? 'skipped', 'a task for someone who may not read the record is not given');
  PERFORM pg_temp.assert_eq(app.system_workflow_action_done(run.run_id, 0, true, '{"told":3}'), 'running', 'one of two actions done');
  PERFORM pg_temp.assert_eq(app.system_workflow_action_done(run.run_id, 1, true, r), 'done', 'both: done');

  -- ---- the task, for its person ----
  PERFORM pg_temp.login(cat);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.workflow_tasks), 0::bigint, 'someone else''s task is not seen');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format('SELECT app.complete_workflow_task(%L, NULL)', task)), 5), 'P0002', 'nor closed');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(bob);
  PERFORM app.complete_workflow_task(task, 'Contained');
  PERFORM pg_temp.assert_eq((SELECT status || '/' || done_note || '/' || (done_by = bob) FROM public.workflow_tasks WHERE id = task), 'done/Contained/true', 'done by its person');
  PERFORM app.reopen_workflow_task(task);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format('UPDATE public.workflow_tasks SET title = %L WHERE id = %L', 'other', task)), 5), 'QM028', 'what a task asks never changes');
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format('SELECT app.cancel_workflow_task(%L, %L)', task, 'x')), 5), 'QM028', 'cancelling needs a reason');
  PERFORM app.cancel_workflow_task(task, 'Raised by mistake');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.workflow_tasks WHERE id = task), 'cancelled', 'cancelled by someone who manages workflows');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.notifications n JOIN public.notification_event_types t ON t.id = n.event_type_id
                               WHERE t.key = 'workflow_tasks.created' AND n.recipient_user_id = bob), 1::bigint, 'Bob was told once, when it was given');

  -- ---- who may call what ----
  PERFORM pg_temp.assert_eq(has_function_privilege('authenticated', 'app.system_workflow_notify(uuid,integer,jsonb,text,jsonb)', 'execute'), false, 'people cannot send notices');
  PERFORM pg_temp.assert_eq(has_function_privilege('authenticated', 'app.system_workflow_facts(uuid,text,uuid,jsonb)', 'execute'), false, 'nor read facts');
  PERFORM pg_temp.assert_eq(has_function_privilege('qms_api', 'app.system_workflow_task(uuid,integer,jsonb,text,text,integer,jsonb)', 'execute'), true, 'the API login gives tasks');
  PERFORM pg_temp.assert_eq(has_table_privilege('authenticated', 'public.workflow_tasks', 'update'), false, 'no table writes');
END $$;

ROLLBACK;
