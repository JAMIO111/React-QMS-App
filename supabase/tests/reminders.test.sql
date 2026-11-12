-- Reminders (docs/workflow-engine-plan.md, WK2): the organisation's day, who is told what (as that person), the daily digest once a day, the overdue notice
-- once per due date, areas switched off, removed members, the notices addressed to the person, and who may call what.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
  ('3e200000-0000-0000-0000-000000000101', 'ann@remind.test', now()),
  ('3e200000-0000-0000-0000-000000000102', 'bob@remind.test', now()),
  ('3e200000-0000-0000-0000-000000000103', 'cat@remind.test', now()),
  ('3e200000-0000-0000-0000-000000000104', 'eve@remind.test', now());

CREATE FUNCTION pg_temp.assert_true(p boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p IS NOT TRUE THEN RAISE EXCEPTION 'FAILED: %', label; END IF; END $$;
CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '3e200000-0000-0000-0000-000000000101'; bob uuid := '3e200000-0000-0000-0000-000000000102';
  cat uuid := '3e200000-0000-0000-0000-000000000103'; eve uuid := '3e200000-0000-0000-0000-000000000104';
  org uuid; org2 uuid; c uuid; k uuid; a_late uuid; a_soon uuid; a_far uuid; a_old uuid; r jsonb; d record; today date; x text; n_before bigint;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('Remind Works', 'Plant A', 'PA', NULL); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('Other Works', 'Plant B', 'PB', NULL); PERFORM pg_temp.logout();
  FOREACH c IN ARRAY ARRAY[bob, cat] LOOP INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, c, 'active'); END LOOP;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = 'viewer')
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id IN (bob, cat);
  -- The other organisation has not reached its reminder time: only org runs.
  UPDATE public.organisation_settings SET time_zone = 'UTC', reminder_time = '23:55' WHERE organisation_id = org2;

  -- ---- the organisation's day ----
  PERFORM pg_temp.assert_eq(app.organisation_time_zone(org), 'Europe/London', 'the first site''s zone (the default site zone) when none is set');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($q$UPDATE public.organisation_settings SET time_zone = 'Mars/Olympus' WHERE organisation_id = %L$q$, org)), 5), '22023', 'an unknown zone is refused');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($q$UPDATE public.organisation_settings SET reminder_time = '07:03' WHERE organisation_id = %L$q$, org)), 5), '22023', 'the time is on a five-minute step');
  UPDATE public.organisation_settings SET time_zone = 'UTC', reminder_time = '00:00' WHERE organisation_id = org;
  PERFORM pg_temp.assert_eq(app.organisation_time_zone(org), 'UTC', 'its own zone when set');
  today := (now() AT TIME ZONE 'UTC')::date;

  -- ---- work for Bob: a risk he owns actions on ----
  PERFORM pg_temp.login(ann);
  SELECT id INTO c FROM public.risk_categories WHERE organisation_id = org AND key = 'process';
  k := app.create_risk(org, jsonb_build_object('categoryId', c, 'title', 'Single-source casting'));
  PERFORM app.assess_risk(k, 4, 4, 'One foundry');
  PERFORM app.set_risk_treatment(k, 'mitigate', 'Second foundry');
  a_late := app.add_risk_action(k, jsonb_build_object('description', 'Audit the foundry', 'ownerId', bob, 'dueDate', (current_date + 30)::text));
  a_soon := app.add_risk_action(k, jsonb_build_object('description', 'Ask for quotes', 'ownerId', bob, 'dueDate', (current_date + 30)::text));
  a_far := app.add_risk_action(k, jsonb_build_object('description', 'Qualify parts', 'ownerId', bob, 'dueDate', (current_date + 30)::text));
  a_old := app.add_risk_action(k, jsonb_build_object('description', 'Long forgotten', 'ownerId', bob, 'dueDate', (current_date + 30)::text));
  PERFORM pg_temp.logout();
  UPDATE public.risk_actions SET due_date = today - 1 WHERE id = a_late;
  UPDATE public.risk_actions SET due_date = today + 2 WHERE id = a_soon;
  UPDATE public.risk_actions SET due_date = today + 20 WHERE id = a_far;
  UPDATE public.risk_actions SET due_date = today - 40 WHERE id = a_old;

  -- ---- what Bob sees on his Reminders page ----
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq((SELECT array_agg(record_id ORDER BY due_on) FROM app.my_reminders(org) WHERE area = 'risk_actions'), ARRAY[a_old, a_late, a_soon],
    'overdue and due within the window, not the one due in 20 days');
  PERFORM pg_temp.assert_eq((SELECT count(*) FILTER (WHERE overdue) FROM app.my_reminders(org)), 2::bigint, 'two of them overdue');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.my_reminder_areas(org)), 12::bigint, 'twelve areas, all on by default');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.my_reminders(org)), 0::bigint, 'nobody sees someone else''s work');
  PERFORM pg_temp.logout();

  -- ---- the run ----
  r := app.system_run_reminders(500);
  PERFORM pg_temp.assert_true(EXISTS (SELECT 1 FROM app.reminder_runs WHERE organisation_id = org AND day = today), 'the organisation whose time has come ran');
  -- (the other organisation's time is 23:55 UTC: it has not run, unless this test happens to run in those last minutes of the day)
  PERFORM pg_temp.assert_true(NOT EXISTS (SELECT 1 FROM app.reminder_runs WHERE organisation_id = org2) OR (now() AT TIME ZONE 'UTC')::time >= '23:55', 'an organisation waits for its own time');
  SELECT * INTO d FROM public.reminder_digests WHERE organisation_id = org AND user_id = bob;
  PERFORM pg_temp.assert_eq(d.overdue || '/' || d.due_soon, '2/1', 'Bob''s digest counts');
  PERFORM pg_temp.assert_true(d.summary LIKE '2 overdue, 1 due soon: %Long forgotten (overdue since %Audit the foundry (overdue since %Ask for quotes (due %', 'the summary in words: ' || d.summary);
  PERFORM pg_temp.assert_eq(jsonb_array_length(d.items), 3, 'the items');
  PERFORM pg_temp.assert_eq((SELECT array_agg(record_id) FROM public.reminder_overdue_notices WHERE organisation_id = org AND user_id = bob), ARRAY[a_late],
    'an overdue notice for what went overdue lately, not for the old backlog');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.reminder_digests WHERE organisation_id = org AND user_id IN (ann, cat)), 0::bigint, 'nothing for people with nothing to do');

  -- the notices: addressed to Bob, no actor, the right event
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.notifications n JOIN public.notification_event_types t ON t.id = n.event_type_id
                               WHERE n.organisation_id = org AND t.key = 'reminder_digests.created' AND n.recipient_user_id = bob AND n.actor_user_id IS NULL), 1::bigint,
    'one digest notice, for Bob');
  SELECT n.body INTO x FROM public.notifications n JOIN public.notification_event_types t ON t.id = n.event_type_id
   WHERE n.organisation_id = org AND t.key = 'reminder_overdue_notices.created' AND n.recipient_user_id = bob;
  PERFORM pg_temp.assert_true(x LIKE '%Audit the foundry — Was due %', 'the overdue notice says what and when: ' || x);
  PERFORM pg_temp.assert_eq((SELECT n.details ->> 'area' FROM public.notifications n JOIN public.notification_event_types t ON t.id = n.event_type_id
                               WHERE n.organisation_id = org AND t.key = 'reminder_overdue_notices.created'), 'risk_actions', 'with its area for the link');
  PERFORM pg_temp.assert_eq((SELECT actor_user_id FROM audit.events WHERE entity_type = 'reminder_digests' AND entity_id = d.id::text), NULL::uuid,
    'the system wrote it, not Bob');
  PERFORM pg_temp.login(cat);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.reminder_digests), 0::bigint, 'nobody reads someone else''s digest');
  PERFORM pg_temp.logout();

  -- ---- never twice ----
  n_before := (SELECT count(*) FROM public.notifications WHERE organisation_id = org);
  r := app.system_run_reminders(500);
  PERFORM pg_temp.assert_true(NOT (r -> 'organisations') IS NULL AND (SELECT count(*) FROM app.reminder_runs WHERE organisation_id = org) = 1, 'an organisation runs once a day');
  PERFORM pg_temp.assert_eq((r ->> 'digests')::int, 0, 'so nothing is sent the second time');
  DELETE FROM app.reminder_runs WHERE organisation_id = org;
  r := app.system_run_reminders(500);
  PERFORM pg_temp.assert_eq((r ->> 'digests')::int || '/' || (r ->> 'overdueNotices')::int, '0/0', 'even run again, the same day sends nothing new');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.notifications WHERE organisation_id = org), n_before, 'and no new notices');

  -- ---- frozen ----
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format('UPDATE public.reminder_digests SET summary = %L WHERE id = %L', 'x', d.id)), 5), 'QM010', 'a sent digest never changes');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format('DELETE FROM public.reminder_digests WHERE id = %L', d.id)), 5), 'QM010', 'nor is deleted');

  -- ---- switching an area off; and a member who left ----
  PERFORM pg_temp.login(bob);
  PERFORM app.set_reminder_area(org, 'risk_actions', false);
  PERFORM pg_temp.assert_eq((SELECT enabled FROM app.my_reminder_areas(org) WHERE key = 'risk_actions'), false, 'switched off');
  PERFORM pg_temp.assert_eq((SELECT bool_and(NOT area_enabled) FROM app.my_reminders(org)), true, 'the page still shows them, marked off');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format('SELECT app.set_reminder_area(%L, %L, true)', org, 'nonsense')), 5), 'QM010', 'an unknown area is refused');
  PERFORM pg_temp.logout();
  DELETE FROM app.reminder_runs WHERE organisation_id = org;
  UPDATE public.risk_actions SET due_date = today - 2 WHERE id = a_soon;
  r := app.system_run_reminders(500);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.reminder_overdue_notices WHERE record_id = a_soon), 0::bigint, 'an area switched off sends nothing');
  PERFORM pg_temp.login(bob);
  PERFORM app.set_reminder_area(org, 'risk_actions', true);
  PERFORM pg_temp.logout();
  UPDATE public.organisation_users SET status = 'removed' WHERE organisation_id = org AND user_id = bob;
  DELETE FROM app.reminder_runs WHERE organisation_id = org;
  r := app.system_run_reminders(500);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.reminder_overdue_notices WHERE record_id = a_soon), 0::bigint, 'a person who left is told nothing');
  UPDATE public.organisation_users SET status = 'active' WHERE organisation_id = org AND user_id = bob;

  -- ---- permission and site, checked as the person ----
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', bob, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  PERFORM pg_temp.assert_eq(app.reminder_item_allowed(org, 'gauges', 'integrations.read', NULL), false, 'an item the person may not read is not sent');
  PERFORM pg_temp.assert_eq(app.reminder_item_allowed(org, 'gauges', NULL, NULL), true, 'their own record needs no permission');
  PERFORM pg_temp.assert_eq(app.reminder_item_allowed(org2, 'gauges', NULL, NULL), false, 'nor anything in an organisation they are not in');
  PERFORM pg_temp.logout();

  -- ---- who may call what ----
  PERFORM pg_temp.assert_eq(has_function_privilege('authenticated', 'app.system_run_reminders(integer)', 'execute'), false, 'people cannot run reminders');
  PERFORM pg_temp.assert_eq(has_function_privilege('qms_api', 'app.system_run_reminders(integer)', 'execute'), true, 'the API login does');
  PERFORM pg_temp.assert_eq(has_function_privilege('authenticated', 'app.reminder_candidates(uuid,date)', 'execute'), false, 'nobody lists everyone''s work');
  PERFORM pg_temp.assert_eq(has_table_privilege('authenticated', 'public.reminder_digests', 'insert'), false, 'nobody writes a digest');
END $$;

ROLLBACK;
