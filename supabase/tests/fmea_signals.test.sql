-- FMEA FM6c: the workflow triggers (approval event and its facts, the dates the worker turns into events once for each due date, facts only while the record is still
-- live) and the reminders areas for actions and periodic reviews (who is told, when, and who is not).
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('4f100000-0000-0000-0000-000000000b01', 'ann@fs.test'), ('4f100000-0000-0000-0000-000000000b02', 'bob@fs.test'),
  ('4f100000-0000-0000-0000-000000000b03', 'cat@fs.test'), ('4f100000-0000-0000-0000-000000000b04', 'dan@fs.test'),
  ('4f100000-0000-0000-0000-000000000b05', 'gus@fs.test'), ('4f100000-0000-0000-0000-000000000b06', 'eve@fs.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

CREATE FUNCTION pg_temp.events_of(p_entity uuid, p_type text) RETURNS bigint LANGUAGE sql SECURITY DEFINER AS $$
  SELECT count(*) FROM public.outbox_events WHERE entity_id = p_entity AND event_type = p_type
$$;
CREATE FUNCTION pg_temp.event_of(p_entity uuid, p_type text) RETURNS public.outbox_events LANGUAGE sql SECURITY DEFINER AS $$
  SELECT * FROM public.outbox_events WHERE entity_id = p_entity AND event_type = p_type ORDER BY id DESC LIMIT 1
$$;

DO $$
DECLARE
  ann uuid := '4f100000-0000-0000-0000-000000000b01'; bob uuid := '4f100000-0000-0000-0000-000000000b02';
  cat uuid := '4f100000-0000-0000-0000-000000000b03'; dan uuid := '4f100000-0000-0000-0000-000000000b04';
  gus uuid := '4f100000-0000-0000-0000-000000000b05'; eve uuid := '4f100000-0000-0000-0000-000000000b06';
  org uuid; org2 uuid; u uuid; emp uuid; f1 uuid; r1 uuid; it uuid; fn uuid; m1 uuid; ch uuid; a1 uuid; a2 uuid; a3 uuid; f jsonb; ev public.outbox_events%ROWTYPE; res jsonb;
  today date := (now() AT TIME ZONE 'UTC')::date; review date; r text; n bigint;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('FS Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('FS Beta'); PERFORM pg_temp.logout();
  UPDATE public.organisation_settings SET time_zone = 'UTC' WHERE organisation_id IN (org, org2);
  FOREACH u IN ARRAY ARRAY[bob, cat, dan, gus] LOOP
    INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u, 'active');
  END LOOP;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = CASE WHEN ou.user_id = dan THEN 'quality_manager' WHEN ou.user_id IN (bob, gus) THEN 'viewer' ELSE 'quality_engineer' END)
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id IN (bob, cat, dan, gus);
  INSERT INTO public."Employees" (organisation_id, employee_number, first_name, surname, auth_id) VALUES (org, 'E-GUS', 'Gus', 'Fitter', gus) RETURNING id INTO emp;

  -- ---- what a rule can start from ----
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.workflow_triggers() WHERE event_type LIKE 'fmea.%'), 3::bigint, 'three FMEA triggers');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.workflow_triggers() WHERE event_type LIKE 'fmea.%' AND permission = 'fmea.read'), 3::bigint, 'each needs fmea.read');
  PERFORM pg_temp.assert_eq((SELECT entity_type FROM app.workflow_triggers() WHERE event_type = 'fmea.approved'), 'fmea_revision', 'approval is about a revision');
  PERFORM pg_temp.assert_eq((SELECT entity_type FROM app.workflow_triggers() WHERE event_type = 'fmea.action_overdue'), 'fmea_action', 'an overdue action is about the action');
  PERFORM pg_temp.assert_eq((SELECT entity_type FROM app.workflow_triggers() WHERE event_type = 'fmea.review_due'), 'fmea', 'a review is about the FMEA');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.reminder_areas() WHERE key = 'fmea_actions' AND soon_days = 7), 1::bigint, 'the actions area is there');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.reminder_areas() WHERE key = 'fmea_reviews' AND soon_days = 30), 1::bigint, 'the reviews area is there');

  -- ---- an FMEA with a cause that needs attention, two actions, approved today ----
  PERFORM pg_temp.login(cat);
  f1 := app.create_fmea(org, jsonb_build_object('kind', 'process', 'title', 'Machining the bracket',
    'team', jsonb_build_array(jsonb_build_object('userId', cat, 'role', 'lead'), jsonb_build_object('userId', dan, 'role', 'quality')),
    'links', jsonb_build_array(jsonb_build_object('kind', 'operation_code', 'code', 'OP10'))));
  r1 := (SELECT id FROM public.fmea_revisions WHERE fmea_id = f1);
  it := app.save_fmea_item(r1, NULL, '{"kind":"item","name":"Bracket"}'::jsonb);
  fn := app.save_fmea_function(it, NULL, '{"text":"Hold the bore"}'::jsonb);
  m1 := app.save_fmea_failure_mode(fn, NULL, '{"text":"Bore oversize"}'::jsonb);
  PERFORM app.save_fmea_effect(m1, NULL, '{"level":"end_user","text":"Leaks","severity":8}'::jsonb);
  ch := app.save_fmea_cause(m1, NULL, '{"text":"Tool wear","occurrence":8,"detection":8}'::jsonb);
  a1 := app.add_fmea_action(ch, jsonb_build_object('kind', 'prevention', 'description', 'Change the tool every 50 parts', 'ownerUserId', bob, 'dueOn', today + 30));
  a2 := app.add_fmea_action(ch, jsonb_build_object('kind', 'detection', 'description', 'Gauge every tenth part', 'ownerEmployeeId', emp, 'dueOn', today + 30));
  PERFORM app.set_fmea_approver(r1, dan);
  PERFORM app.submit_fmea_revision(r1);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(pg_temp.events_of(r1, 'fmea.approved'), 0::bigint, 'submitting is not approving');
  PERFORM pg_temp.login(dan);
  PERFORM app.approve_fmea_revision(r1, today, NULL);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT status FROM public.fmea_revisions WHERE id = r1), 'effective', 'approved and in force');
  PERFORM pg_temp.assert_eq(pg_temp.events_of(r1, 'fmea.approved'), 1::bigint, 'approving writes one event, though it took effect at once');
  ev := pg_temp.event_of(r1, 'fmea.approved');
  PERFORM pg_temp.assert_eq(ev.entity_type, 'fmea_revision', 'about the revision');
  f := app.system_workflow_facts(org, 'fmea_revision', r1, ev.payload);
  PERFORM pg_temp.assert_eq(f ->> 'record_kind', 'fmea', 'it opens the FMEA page');
  PERFORM pg_temp.assert_eq((f ->> 'record_id')::uuid, f1, 'the FMEA');
  PERFORM pg_temp.assert_eq(f ->> 'fmea_kind', 'process', 'the kind is a fact');
  PERFORM pg_temp.assert_eq((f ->> 'revision_number')::int, 1, 'so is the revision number');
  PERFORM pg_temp.assert_eq((f ->> 'need_attention')::int, 1, 'and how many causes need attention');
  PERFORM pg_temp.assert_eq((f ->> 'high_priority')::int, 1, 'and how many are of high priority');
  PERFORM pg_temp.assert_eq((f ->> 'owner_user_id')::uuid, cat, 'the person who owns it');
  PERFORM pg_temp.assert_eq(app.system_workflow_facts(org2, 'fmea_revision', r1, ev.payload), NULL::jsonb, 'another organisation gets no facts');

  -- ---- reminders: actions ----
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.reminder_candidates(org, today) WHERE area = 'fmea_actions'), 0::bigint, 'not near yet: due in thirty days, told from seven');
  SELECT count(*) INTO n FROM app.reminder_candidates(org, today + 25) WHERE area = 'fmea_actions' AND record_id = a1 AND user_id = bob AND target_id = f1 AND due_on = today + 30 AND permission = 'fmea.read';
  PERFORM pg_temp.assert_eq(n, 1::bigint, 'a member is told of an action given to them');
  SELECT count(*) INTO n FROM app.reminder_candidates(org, today + 25) WHERE area = 'fmea_actions' AND record_id = a2 AND user_id = gus AND target_id = f1;
  PERFORM pg_temp.assert_eq(n, 1::bigint, 'an employee is told through their sign-in');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.reminder_candidates(org, today + 25) WHERE area = 'fmea_actions' AND user_id NOT IN (bob, gus)), 0::bigint, 'nobody else is told');
  PERFORM pg_temp.login(bob);
  PERFORM app.complete_fmea_action(a1, 'Changed every 50 parts');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.reminder_candidates(org, today + 25) WHERE area = 'fmea_actions' AND record_id = a1), 0::bigint, 'a finished action is not asked about');

  -- ---- reminders: the periodic review ----
  review := (SELECT next_review_on FROM public.fmeas WHERE id = f1);
  PERFORM pg_temp.assert_eq(review IS NOT NULL, true, 'an FMEA in force has a review date');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.reminder_candidates(org, review - 31) WHERE area = 'fmea_reviews'), 0::bigint, 'not told before thirty days');
  SELECT count(*) INTO n FROM app.reminder_candidates(org, review - 30) WHERE area = 'fmea_reviews' AND record_id = f1 AND user_id = cat AND target_id = f1 AND due_on = review AND permission = 'fmea.read';
  PERFORM pg_temp.assert_eq(n, 1::bigint, 'its owner is told thirty days ahead');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.reminder_candidates(org, review - 30) WHERE area = 'fmea_reviews' AND user_id <> cat), 0::bigint, 'and nobody else');

  -- ---- the dates the worker turns into events ----
  a3 := a2;
  UPDATE public.fmea_actions SET due_on = today - 2 WHERE id = a3;
  res := app.system_emit_fmea_due_events(200);
  PERFORM pg_temp.assert_eq((res ->> 'actionEvents')::int >= 1, true, 'an action that went overdue two days ago is written');
  PERFORM pg_temp.assert_eq(pg_temp.events_of(a3, 'fmea.action_overdue'), 1::bigint, 'one event for it');
  PERFORM pg_temp.assert_eq(pg_temp.events_of(a1, 'fmea.action_overdue'), 0::bigint, 'a finished action writes none');
  res := app.system_emit_fmea_due_events(200);
  PERFORM pg_temp.assert_eq(pg_temp.events_of(a3, 'fmea.action_overdue'), 1::bigint, 'asking again writes nothing more for the same due date');
  ev := pg_temp.event_of(a3, 'fmea.action_overdue');
  PERFORM pg_temp.assert_eq(ev.payload ->> 'due_on', (today - 2)::text, 'the due date is in the event');
  f := app.system_workflow_facts(org, 'fmea_action', a3, ev.payload);
  PERFORM pg_temp.assert_eq(f ->> 'record_kind', 'fmea', 'it opens the FMEA page');
  PERFORM pg_temp.assert_eq((f ->> 'days_late')::int, 2, 'days late is a fact');
  PERFORM pg_temp.assert_eq(f ->> 'action_kind', 'detection', 'so is the kind of action');
  PERFORM pg_temp.assert_eq((f ->> 'owner_user_id')::uuid, gus, 'the owner is the employee''s sign-in');
  -- a new due date is a new event
  UPDATE public.fmea_actions SET due_on = today - 1 WHERE id = a3;
  PERFORM app.system_emit_fmea_due_events(200);
  PERFORM pg_temp.assert_eq(pg_temp.events_of(a3, 'fmea.action_overdue'), 2::bigint, 'a new due date that passes is told again');
  -- too old to be news
  UPDATE public.fmea_actions SET due_on = today - 9 WHERE id = a3;
  DELETE FROM public.outbox_events WHERE entity_id = a3;
  PERFORM app.system_emit_fmea_due_events(200);
  PERFORM pg_temp.assert_eq(pg_temp.events_of(a3, 'fmea.action_overdue'), 0::bigint, 'an action overdue for nine days is not news');
  UPDATE public.fmea_actions SET due_on = today - 1 WHERE id = a3;
  PERFORM app.system_emit_fmea_due_events(200);
  ev := pg_temp.event_of(a3, 'fmea.action_overdue');
  PERFORM pg_temp.login(gus);
  PERFORM app.complete_fmea_action(a3, 'Gauged every tenth part');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(app.system_workflow_facts(org, 'fmea_action', a3, ev.payload), NULL::jsonb, 'once it is finished there is nothing left to tell');

  -- a review reached
  UPDATE public.fmeas SET next_review_on = today - 1 WHERE id = f1;
  res := app.system_emit_fmea_due_events(200);
  PERFORM pg_temp.assert_eq(pg_temp.events_of(f1, 'fmea.review_due'), 1::bigint, 'a review date that has been reached is written');
  PERFORM app.system_emit_fmea_due_events(200);
  PERFORM pg_temp.assert_eq(pg_temp.events_of(f1, 'fmea.review_due'), 1::bigint, 'once for that date');
  ev := pg_temp.event_of(f1, 'fmea.review_due');
  f := app.system_workflow_facts(org, 'fmea', f1, ev.payload);
  PERFORM pg_temp.assert_eq((f ->> 'days_overdue')::int, 1, 'days past the date is a fact');
  PERFORM pg_temp.assert_eq((f ->> 'owner_user_id')::uuid, cat, 'the owner');
  PERFORM pg_temp.assert_eq(f ->> 'fmea_kind', 'process', 'the kind');
  UPDATE public.fmeas SET next_review_on = today + 10 WHERE id = f1;
  DELETE FROM public.outbox_events WHERE entity_id = f1 AND event_type = 'fmea.review_due';
  PERFORM app.system_emit_fmea_due_events(200);
  PERFORM pg_temp.assert_eq(pg_temp.events_of(f1, 'fmea.review_due'), 0::bigint, 'a review not yet reached is not written');
  PERFORM pg_temp.assert_eq(app.system_workflow_facts(org2, 'fmea', f1, '{}'), NULL::jsonb, 'another organisation gets no facts');

  -- ---- who may run the system function ----
  PERFORM pg_temp.login(cat);
  r := pg_temp.fails('SELECT app.system_emit_fmea_due_events(10)');
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a signed-in person cannot write these events');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(has_function_privilege('anon', 'app.system_emit_fmea_due_events(integer)', 'EXECUTE'), false, 'nor can anon');
END $$;

ROLLBACK;
