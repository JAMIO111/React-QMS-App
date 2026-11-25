-- Change management CH5a: the three workflow triggers (events, facts) and the reminders areas for change tasks and sign-offs.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('4f100000-0000-0000-0000-000000000a01', 'ann@ch5a.test'), ('4f100000-0000-0000-0000-000000000a02', 'bob@ch5a.test'),
  ('4f100000-0000-0000-0000-000000000a03', 'cat@ch5a.test'), ('4f100000-0000-0000-0000-000000000a04', 'dan@ch5a.test');

CREATE FUNCTION pg_temp.events_of(p_change uuid, p_type text) RETURNS bigint LANGUAGE sql SECURITY DEFINER AS $$
  SELECT count(*) FROM public.outbox_events WHERE entity_id = p_change AND event_type = p_type
$$;

CREATE FUNCTION pg_temp.event_of(p_change uuid, p_type text) RETURNS public.outbox_events LANGUAGE sql SECURITY DEFINER AS $$
  SELECT * FROM public.outbox_events WHERE entity_id = p_change AND event_type = p_type ORDER BY id DESC LIMIT 1
$$;

DO $$
DECLARE
  ann uuid := '4f100000-0000-0000-0000-000000000a01'; bob uuid := '4f100000-0000-0000-0000-000000000a02';
  cat uuid := '4f100000-0000-0000-0000-000000000a03'; dan uuid := '4f100000-0000-0000-0000-000000000a04';
  org uuid; part uuid; c uuid; c2 uuid; s uuid; t1 uuid; t2 uuid; t3 uuid; f jsonb; ev public.outbox_events%ROWTYPE; today date := current_date; n integer; u uuid;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('CH5a Alpha'); PERFORM pg_temp.logout();
  FOREACH u IN ARRAY ARRAY[bob, cat, dan] LOOP
    INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u, 'active');
  END LOOP;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = CASE ou.user_id WHEN cat THEN 'quality_engineer' WHEN dan THEN 'quality_manager' ELSE 'viewer' END)
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id IN (bob, cat, dan);
  UPDATE public.organisation_settings SET change_allow_self_approval = true WHERE organisation_id = org;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'CH5-P1', 'Bracket') RETURNING id INTO part;

  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.workflow_triggers() WHERE event_type LIKE 'change.%'), 3::bigint, 'three change triggers');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.workflow_triggers() WHERE event_type LIKE 'change.%' AND permission = 'change.read' AND entity_type = 'change_request'), 3::bigint, 'each needs change.read');

  -- ---- submitted ----
  PERFORM pg_temp.login(cat);
  c := app.create_change(org, jsonb_build_object('title', 'Move bracket to CNC 7', 'typeId', (SELECT id FROM public.change_types WHERE organisation_id = org AND key = 'process'),
        'urgency', 'expedited', 'description', 'What', 'reason', 'Why', 'links', jsonb_build_array(jsonb_build_object('kind', 'part', 'id', part))));
  PERFORM pg_temp.assert_eq(pg_temp.events_of(c, 'change.submitted'), 0::bigint, 'a draft writes nothing');
  PERFORM app.submit_change(c);
  PERFORM pg_temp.assert_eq(pg_temp.events_of(c, 'change.submitted'), 1::bigint, 'submitting writes one event');
  ev := pg_temp.event_of(c, 'change.submitted');
  PERFORM pg_temp.assert_eq(ev.entity_type, 'change_request', 'about the change');
  PERFORM pg_temp.assert_eq(ev.payload ->> 'to', 'assessment', 'to assessment');
  PERFORM pg_temp.logout();
  f := app.system_workflow_facts(org, 'change_request', c, ev.payload);
  PERFORM pg_temp.assert_eq(f ->> 'record_kind', 'change', 'it opens the change page');
  PERFORM pg_temp.assert_eq(f ->> 'urgency', 'expedited', 'the urgency is a fact');
  PERFORM pg_temp.assert_eq(f ->> 'type_key', 'process', 'so is the type');
  PERFORM pg_temp.assert_eq((f ->> 'type_needs_customer')::boolean, true, 'and whether the type usually needs the customer');
  PERFORM pg_temp.assert_eq(f ->> 'from_stage', 'draft', 'where it came from');
  PERFORM pg_temp.assert_eq(f ->> 'to_stage', 'assessment', 'and where it went');
  PERFORM pg_temp.assert_eq((f ->> 'owner_user_id')::uuid, cat, 'the person who raised it');
  PERFORM pg_temp.assert_eq(f -> 'review_result', 'null'::jsonb, 'nothing has been checked yet');
  PERFORM pg_temp.login(cat);

  -- ---- approved ----
  PERFORM app.set_change_impact(c, i.area_id, 'not_affected', NULL) FROM public.change_impacts i WHERE i.change_id = c;
  PERFORM app.set_change_board(c, jsonb_build_array(jsonb_build_object('functionId', (SELECT id FROM public.change_functions WHERE organisation_id = org AND key = 'quality'), 'signerId', ann)));
  PERFORM app.set_change_customer_approval(c, 'not_needed');
  PERFORM app.send_change_to_board(c);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(pg_temp.events_of(c, 'change.approved'), 0::bigint, 'sending to the board is not an approval');
  PERFORM pg_temp.assert_eq(pg_temp.events_of(c, 'change.submitted'), 1::bigint, 'and is not another submission');

  -- the sign-off waits: the signer is reminded from five days, due after seven
  SELECT id INTO s FROM public.change_signoffs WHERE change_id = c AND status = 'pending';
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.reminder_candidates(org, today) WHERE area = 'change_signoffs' AND record_id = s), 0::bigint, 'not yet: it was only just asked for');
  SELECT count(*) INTO n FROM app.reminder_candidates(org, today + 5) WHERE area = 'change_signoffs' AND record_id = s AND user_id = ann AND target_id = c AND due_on = today + 7 AND permission = 'change.approve';
  PERFORM pg_temp.assert_eq(n, 1, 'five days on the signer has a reminder, due seven days after it was asked for');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.reminder_areas() WHERE key = 'change_signoffs' AND soon_days = 2), 1::bigint, 'the area is there');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.reminder_candidates(org, today + 5) WHERE area = 'change_signoffs' AND user_id <> ann), 0::bigint, 'nobody else is told');

  PERFORM pg_temp.login(ann);
  PERFORM app.decide_change_signoff(s, true, NULL);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(pg_temp.events_of(c, 'change.approved'), 1::bigint, 'the last approval writes one event');
  ev := pg_temp.event_of(c, 'change.approved');
  PERFORM pg_temp.assert_eq(ev.payload ->> 'from', 'approval', 'from the board');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.reminder_candidates(org, today) WHERE area = 'change_signoffs'), 0::bigint, 'a decided sign-off is no longer asked about');

  -- ---- tasks: reminders ----
  PERFORM pg_temp.login(cat);
  t1 := app.add_change_task(c, jsonb_build_object('description', 'Update the control plan', 'ownerId', bob, 'dueOn', today + 2));
  t2 := app.add_change_task(c, jsonb_build_object('description', 'Tell the line leaders', 'ownerId', dan));
  t3 := app.add_change_task(c, jsonb_build_object('description', 'Order the new fixture', 'ownerId', bob, 'dueOn', today - 3));
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(pg_temp.events_of(c, 'change.approved'), 1::bigint, 'tasks moving the stage on write no second approval');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.reminder_areas() WHERE key = 'change_tasks' AND soon_days = 3), 1::bigint, 'the tasks area is there');
  SELECT count(*) INTO n FROM app.reminder_candidates(org, today) WHERE area = 'change_tasks' AND record_id = t1 AND user_id = bob AND target_id = c AND due_on = today + 2 AND permission IS NULL;
  PERFORM pg_temp.assert_eq(n, 1, 'the task owner is reminded, with no permission needed (a viewer owns it)');
  PERFORM pg_temp.assert_eq((SELECT due_on FROM app.reminder_candidates(org, today) WHERE area = 'change_tasks' AND record_id = t3), today - 3, 'an overdue task shows its due date');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.reminder_candidates(org, today) WHERE area = 'change_tasks' AND record_id = t2), 0::bigint, 'a task with no due date is not chased');
  PERFORM pg_temp.login(cat);
  PERFORM app.complete_change_task(t3, 'Ordered');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.reminder_candidates(org, today) WHERE area = 'change_tasks' AND record_id = t3), 0::bigint, 'a finished task is not asked about');

  -- ---- closed ----
  PERFORM pg_temp.login(cat);
  PERFORM app.complete_change_task(t1, 'Done');
  PERFORM app.complete_change_task(t2, 'Told them');
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.change_requests WHERE id = c), 'verifying', 'every task done: verifying');
  PERFORM pg_temp.assert_eq(pg_temp.events_of(c, 'change.closed'), 0::bigint, 'not closed yet');
  PERFORM app.record_change_review(c, false, 'Still seeing burrs');
  PERFORM pg_temp.assert_eq(pg_temp.events_of(c, 'change.closed'), 0::bigint, 'a failed check closes nothing');
  PERFORM app.complete_change_task(app.add_change_task(c, jsonb_build_object('description', 'Re-check the bracket', 'ownerId', cat)), 'Checked');
  PERFORM app.record_change_review(c, true, 'No burrs in the last three lots');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.change_requests WHERE id = c), 'closed', 'the effective check closes it');
  PERFORM pg_temp.assert_eq(pg_temp.events_of(c, 'change.closed'), 1::bigint, 'one closing event');
  ev := pg_temp.event_of(c, 'change.closed');
  f := app.system_workflow_facts(org, 'change_request', c, ev.payload);
  PERFORM pg_temp.assert_eq(f ->> 'review_result', 'effective', 'the result of the check is a fact');
  PERFORM pg_temp.assert_eq(f ->> 'to_stage', 'closed', 'closed');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.reminder_candidates(org, today) WHERE area IN ('change_tasks', 'change_signoffs')), 0::bigint, 'a closed change asks for nothing');

  -- ---- a cancelled draft and another organisation's facts ----
  PERFORM pg_temp.login(cat);
  c2 := app.create_change(org, jsonb_build_object('title', 'Never mind', 'typeId', (SELECT id FROM public.change_types WHERE organisation_id = org AND key = 'process')));
  PERFORM app.cancel_change(c2, 'Overtaken by another change');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.outbox_events WHERE entity_id = c2), 0::bigint, 'cancelling a draft writes no workflow event');
  PERFORM pg_temp.assert_eq(app.system_workflow_facts(gen_random_uuid(), 'change_request', c, '{}'), NULL::jsonb, 'another organisation gets no facts');
END $$;

ROLLBACK;
