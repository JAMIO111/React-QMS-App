-- Management review MR2: plan, start, gather (snapshots), commentary, attendees, minutes, decisions, actions, complete (frozen), cancel, tenancy.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('5b000000-0000-0000-0000-000000000c01', 'ann@mr2.test'), ('5b000000-0000-0000-0000-000000000c02', 'bob@mr2.test'),
  ('5b000000-0000-0000-0000-000000000c03', 'eve@mr2.test'), ('5b000000-0000-0000-0000-000000000c04', 'cat@mr2.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '5b000000-0000-0000-0000-000000000c01'; bob uuid := '5b000000-0000-0000-0000-000000000c02'; eve uuid := '5b000000-0000-0000-0000-000000000c03';
  cat uuid := '5b000000-0000-0000-0000-000000000c04';
  org uuid; org2 uuid; m uuid; m2 uuid; inp uuid; d uuid; a1 uuid; a2 uuid; r text; u uuid; s record;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('MR2 Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('MR2 Beta'); PERFORM pg_temp.logout();
  -- Bob: inspector (no management review permission). Cat: quality engineer (reads).
  FOREACH u IN ARRAY ARRAY[bob, cat] LOOP INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u, 'active'); END LOOP;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = CASE ou.user_id WHEN cat THEN 'quality_engineer' ELSE 'inspector' END)
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id IN (bob, cat);

  -- ---- planning ----
  PERFORM pg_temp.login(cat);
  r := pg_temp.fails(format($f$SELECT app.plan_management_review(%L, '{"title":"x","periodFrom":"2026-01-01","periodTo":"2026-06-30"}'::jsonb)$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a reader does not plan reviews');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ann);
  r := pg_temp.fails(format($f$SELECT app.plan_management_review(%L, '{"title":"x","periodFrom":"2026-06-30","periodTo":"2026-01-01"}'::jsonb)$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM027', 'the period runs forwards');
  r := pg_temp.fails(format($f$SELECT app.plan_management_review(%L, '{"title":"x","periodFrom":"2020-01-01","periodTo":"2026-01-01"}'::jsonb)$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM027', 'at most three years');
  m := app.plan_management_review(org, '{"title":" H1 2026 management review ","periodFrom":"2026-01-01","periodTo":"2026-06-30","plannedOn":"2026-07-15"}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT reference || '|' || title || '|' || status || '|' || (chair_user_id = ann)::text FROM public.management_reviews WHERE id = m),
                            'MR-' || to_char(current_date, 'YY') || '-01|H1 2026 management review|planned|true', 'numbered per year, chaired by whoever planned it');
  PERFORM pg_temp.assert_eq((SELECT string_agg(section, ',' ORDER BY position) FROM public.management_review_inputs WHERE review_id = m),
    'previous_actions,context,customer_feedback,quality_objectives,process_performance,nonconformities,monitoring,audit_results,external_providers,resources,risks,improvement',
    'the twelve input sections, in order');
  PERFORM pg_temp.assert_eq(app.management_review_problems(m), ARRAY['Start the review'], 'nothing else is asked before it starts');

  -- Before it starts: nothing gathered, no decisions, no one present; the period can still move.
  r := pg_temp.fails(format($f$SELECT app.set_management_review_snapshot(%L, 'audit_results', true, '{"figures":[]}'::jsonb)$f$, m));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM027', 'inputs are gathered once it has started');
  r := pg_temp.fails(format($f$SELECT app.add_management_review_decision(%L, 'x', 'other')$f$, m));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM027', 'decisions are taken in the meeting');
  r := pg_temp.fails(format($f$SELECT app.set_management_review_attendees(%L, jsonb_build_array(jsonb_build_object('userId', %L, 'attendance', 'present')))$f$, m, bob));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM027', 'who was present is recorded once it has started');
  PERFORM app.set_management_review_attendees(m, jsonb_build_array(jsonb_build_object('userId', bob, 'role', 'Production'), jsonb_build_object('name', 'Dr Jones', 'role', 'Consultant')));
  r := pg_temp.fails(format($f$SELECT app.set_management_review_attendees(%L, jsonb_build_array(jsonb_build_object('userId', %L)))$f$, m, eve));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM027', 'a member attendee is a member of this organisation');
  r := pg_temp.fails(format($f$SELECT app.set_management_review_attendees(%L, jsonb_build_array(jsonb_build_object('userId', %L), jsonb_build_object('userId', %L)))$f$, m, bob, bob));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM027', 'nobody twice');
  PERFORM app.update_management_review(m, '{"periodTo":"2026-07-31"}'::jsonb);

  -- ---- held ----
  PERFORM app.start_management_review(m);
  PERFORM pg_temp.assert_eq((SELECT status || '|' || (held_on = current_date)::text FROM public.management_reviews WHERE id = m), 'in_progress|true', 'started: held today');
  r := pg_temp.fails(format($f$SELECT app.update_management_review(%L, '{"periodTo":"2026-08-31"}'::jsonb)$f$, m));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM027', 'the period is fixed once started');
  r := pg_temp.fails(format($f$SELECT app.update_management_review(%L, jsonb_build_object('heldOn', (current_date + 2)::text))$f$, m));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM027', 'it was not held in the future');
  PERFORM pg_temp.assert_eq(app.management_review_problems(m),
    ARRAY['12 input sections are not reviewed yet', 'Record who was present', 'Record a decision, or say why none was needed'], 'what is still needed');

  -- Gathering and reviewing.
  r := pg_temp.fails(format($f$SELECT app.set_management_review_snapshot(%L, 'context', true, '{}'::jsonb)$f$, m));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM027', 'a commentary-only section gathers nothing');
  SELECT id INTO inp FROM public.management_review_inputs WHERE review_id = m AND section = 'audit_results';
  r := pg_temp.fails(format('SELECT app.set_management_review_input(%L, NULL, true)', inp));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM027', 'figures are gathered before the section is reviewed');
  PERFORM app.set_management_review_snapshot(m, 'audit_results', true, '{"figures":[{"label":"Completed","value":4}]}'::jsonb);
  PERFORM app.set_management_review_input(inp, 'Good year', true);
  PERFORM pg_temp.assert_eq((SELECT reviewed AND reviewed_by = ann FROM public.management_review_inputs WHERE id = inp), true, 'reviewed, by whom');
  PERFORM app.set_management_review_snapshot(m, 'audit_results', true, '{"figures":[{"label":"Completed","value":5}]}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT reviewed::text || '|' || commentary FROM public.management_review_inputs WHERE id = inp), 'false|Good year', 'gathering again asks for a fresh review, keeping the commentary');
  SELECT id INTO inp FROM public.management_review_inputs WHERE review_id = m AND section = 'context';
  r := pg_temp.fails(format('SELECT app.set_management_review_input(%L, NULL, true)', inp));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM027', 'a commentary-only section needs commentary');
  PERFORM app.set_management_review_snapshot(m, 'resources', false, NULL);
  PERFORM pg_temp.assert_eq((SELECT available::text || '|' || coalesce(snapshot::text, 'none') FROM public.management_review_inputs WHERE review_id = m AND section = 'resources'),
                            'false|none', 'a section the person may not read is stored as not available, with no figures');
  FOR s IN SELECT i.id, i.section, x.commentary_only FROM public.management_review_inputs i JOIN app.management_review_sections() x ON x.key = i.section WHERE i.review_id = m LOOP
    IF NOT s.commentary_only THEN PERFORM app.set_management_review_snapshot(m, s.section, true, '{"figures":[]}'::jsonb); END IF;
    PERFORM app.set_management_review_input(s.id, 'Discussed', true);
  END LOOP;
  PERFORM pg_temp.assert_eq(app.management_review_problems(m), ARRAY['Record who was present', 'Record a decision, or say why none was needed'], 'all sections reviewed');

  -- Attendance, minutes, decisions, actions.
  PERFORM app.set_management_review_attendees(m, jsonb_build_array(jsonb_build_object('userId', ann, 'role', 'Chair', 'attendance', 'present'),
    jsonb_build_object('userId', bob, 'attendance', 'apologies'), jsonb_build_object('name', 'Dr Jones', 'attendance', 'present')));
  r := pg_temp.fails(format($f$SELECT app.set_management_review_minutes(%L, '{"type":"paragraph"}'::jsonb)$f$, m));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM027', 'the minutes are a document');
  PERFORM app.set_management_review_minutes(m, '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Opened at 10:00"}]}]}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT minutes_text FROM public.management_reviews WHERE id = m), 'Opened at 10:00', 'the minutes'' text is kept for search');
  r := pg_temp.fails(format($f$SELECT app.add_management_review_decision(%L, 'x', 'whatever')$f$, m));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM027', 'a decision has a category');
  d := app.add_management_review_decision(m, 'Buy a second CMM', 'resources');
  r := pg_temp.fails(format($f$SELECT app.add_management_review_action(%L, jsonb_build_object('description', 'x', 'decisionId', gen_random_uuid()))$f$, m));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM027', 'an action names one of this review''s decisions');
  a1 := app.add_management_review_action(m, jsonb_build_object('description', 'Get three quotes', 'ownerId', bob, 'dueDate', '2030-01-31', 'decisionId', d));
  a2 := app.add_management_review_action(m, '{"description":"Update the training plan"}'::jsonb);
  r := pg_temp.fails(format('SELECT app.remove_management_review_decision(%L)', d));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM027', 'a decision with actions stays');
  r := pg_temp.fails(format('SELECT app.complete_management_review(%L, %L)', m, 'None were needed'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM027', 'no "none needed" note when decisions exist');
  PERFORM app.complete_management_review(m);
  PERFORM pg_temp.assert_eq((SELECT status || '|' || (completed_by = ann)::text FROM public.management_reviews WHERE id = m), 'completed|true', 'completed');

  -- ---- frozen ----
  r := pg_temp.fails(format($f$SELECT app.update_management_review(%L, '{"title":"Later"}'::jsonb)$f$, m));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM027', 'a completed review cannot change');
  r := pg_temp.fails(format($f$SELECT app.add_management_review_action(%L, '{"description":"Late"}'::jsonb)$f$, m));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM027', 'nor take new actions');
  r := pg_temp.fails(format($f$SELECT app.update_management_review_action(%L, '{"description":"Different"}'::jsonb)$f$, a2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM027', 'an action''s words are fixed once completed');
  PERFORM app.update_management_review_action(a2, '{"dueDate":"2030-06-30"}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT due_date FROM public.management_review_actions WHERE id = a2), '2030-06-30'::date, 'but its due date may move');
  PERFORM pg_temp.logout();
  r := pg_temp.fails(format('UPDATE public.management_reviews SET title = %L WHERE id = %L', 'SQL', m));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM027', 'even SQL cannot change a completed review');
  r := pg_temp.fails(format('UPDATE public.management_review_inputs SET commentary = %L WHERE review_id = %L', 'SQL', m));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM027', 'nor its inputs');
  r := pg_temp.fails(format('DELETE FROM public.management_review_decisions WHERE review_id = %L', m));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM027', 'nor its decisions');
  r := pg_temp.fails(format('DELETE FROM public.management_review_actions WHERE id = %L', a1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM027', 'actions are never deleted');

  -- ---- the action's owner closes it without the permission ----
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.management_reviews WHERE organisation_id = org), 0::bigint, 'an inspector does not read reviews');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.management_review_actions WHERE organisation_id = org), 1::bigint, 'but reads the action given to them');
  r := pg_temp.fails(format('SELECT app.complete_management_review_action(%L, %L)', a2, 'Not mine'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'and nobody else''s');
  r := pg_temp.fails(format('SELECT app.complete_management_review_action(%L, %L)', a1, ''));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM027', 'closing says what was done');
  PERFORM app.complete_management_review_action(a1, 'Three quotes in the shared folder');
  PERFORM pg_temp.assert_eq((SELECT status || '|' || (done_by = bob)::text FROM public.management_review_actions WHERE id = a1), 'done|true', 'closed by its owner');
  r := pg_temp.fails(format('SELECT app.reopen_management_review_action(%L)', a1));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'only a manager reopens');
  PERFORM pg_temp.logout();

  -- ---- cancelling ----
  PERFORM pg_temp.login(ann);
  m2 := app.plan_management_review(org, '{"title":"Extra review","periodFrom":"2026-01-01","periodTo":"2026-03-31"}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT reference FROM public.management_reviews WHERE id = m2), 'MR-' || to_char(current_date, 'YY') || '-02', 'the next number');
  PERFORM app.start_management_review(m2);
  a2 := app.add_management_review_action(m2, '{"description":"Short-lived"}'::jsonb);
  r := pg_temp.fails(format('SELECT app.cancel_management_review(%L, %L)', m2, 'x'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM027', 'cancelling needs a reason');
  PERFORM app.cancel_management_review(m2, 'Merged into the H1 review');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.management_review_actions WHERE id = a2), 'cancelled', 'its open actions go with it');
  r := pg_temp.fails(format('SELECT app.start_management_review(%L)', m2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM027', 'a cancelled review stays cancelled');
  PERFORM pg_temp.logout();

  -- ---- another organisation ----
  PERFORM pg_temp.login(eve);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.management_reviews WHERE organisation_id = org), 0::bigint, 'another organisation sees none');
  r := pg_temp.fails(format($f$SELECT app.update_management_review(%L, '{"title":"x"}'::jsonb)$f$, m));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'nor changes one');
  r := pg_temp.fails(format('SELECT app.management_review_problems(%L)', m));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'nor reads what one still needs');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM audit.events WHERE entity_type LIKE 'management_review%' AND organisation_id = org) > 0, true, 'audited');
END $$;

ROLLBACK;
