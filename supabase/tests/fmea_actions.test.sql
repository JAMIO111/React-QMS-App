-- FMEA FM4: actions (who may add, finish, cancel and reopen; the person it is given to may finish theirs with only the read permission), the revised figures the database works
-- out, actions on a draft and on the revision in force but not on one waiting for approval, frozen states even for SQL, carrying open actions to the next revision when it takes
-- effect, adopting finished ones, un-adopting on discard, withdrawing, the still-needed rule, the periodic review, My actions, the notice, and tenancy.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('4f100000-0000-0000-0000-000000000f01', 'ann@fx.test'), ('4f100000-0000-0000-0000-000000000f02', 'bob@fx.test'),
  ('4f100000-0000-0000-0000-000000000f03', 'cat@fx.test'), ('4f100000-0000-0000-0000-000000000f04', 'dan@fx.test'),
  ('4f100000-0000-0000-0000-000000000f05', 'eve@fx.test'), ('4f100000-0000-0000-0000-000000000f06', 'fay@fx.test'),
  ('4f100000-0000-0000-0000-000000000f07', 'hal@fx.test'), ('4f100000-0000-0000-0000-000000000f08', 'gus@fx.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '4f100000-0000-0000-0000-000000000f01'; bob uuid := '4f100000-0000-0000-0000-000000000f02';
  cat uuid := '4f100000-0000-0000-0000-000000000f03'; dan uuid := '4f100000-0000-0000-0000-000000000f04';
  eve uuid := '4f100000-0000-0000-0000-000000000f05'; fay uuid := '4f100000-0000-0000-0000-000000000f06';
  hal uuid := '4f100000-0000-0000-0000-000000000f07'; gus uuid := '4f100000-0000-0000-0000-000000000f08';
  org uuid; org2 uuid; u uuid; part uuid; emp uuid; f1 uuid; r1 uuid; r2 uuid; r3 uuid; it uuid; fn uuid; m1 uuid; m2 uuid; ch uuid; cl uuid; cx uuid; fother uuid; rother uuid;
  a1 uuid; a2 uuid; a3 uuid; a4 uuid; a5 uuid; a6 uuid; a7 uuid; r text; n bigint; v_due date := current_date + 30; v_json jsonb; v_rev_status text;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('FX Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('FX Beta'); PERFORM pg_temp.logout();
  -- Bob, Hal and Gus: viewers. Cat and Fay: quality engineers (manage). Dan: quality manager (approves).
  FOREACH u IN ARRAY ARRAY[bob, cat, dan, fay, hal, gus] LOOP
    INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u, 'active');
  END LOOP;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = CASE WHEN ou.user_id = dan THEN 'quality_manager' WHEN ou.user_id IN (bob, hal, gus) THEN 'viewer' ELSE 'quality_engineer' END)
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id IN (bob, cat, dan, fay, hal, gus);
  PERFORM pg_temp.login(ann);
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'FX-P1', 'Bracket') RETURNING id INTO part;
  INSERT INTO public."Employees" (organisation_id, employee_number, first_name, surname, auth_id) VALUES (org, 'E-GUS', 'Gus', 'Fitter', gus) RETURNING id INTO emp;
  PERFORM pg_temp.logout();

  -- ---- an FMEA with two failure modes: one cause that needs attention (S 8 x O 8 x D 8 = 512, high) and one that does not ----
  PERFORM pg_temp.login(cat);
  f1 := app.create_fmea(org, jsonb_build_object('kind', 'process', 'title', 'Machining the bracket',
    'team', jsonb_build_array(jsonb_build_object('userId', cat, 'role', 'lead'), jsonb_build_object('userId', fay, 'role', 'quality')),
    'links', jsonb_build_array(jsonb_build_object('kind', 'part', 'id', part))));
  r1 := (SELECT id FROM public.fmea_revisions WHERE fmea_id = f1);
  it := app.save_fmea_item(r1, NULL, '{"kind":"item","name":"Bracket"}'::jsonb);
  fn := app.save_fmea_function(it, NULL, '{"text":"Hold the bore"}'::jsonb);
  m1 := app.save_fmea_failure_mode(fn, NULL, '{"text":"Bore oversize"}'::jsonb);
  PERFORM app.save_fmea_effect(m1, NULL, '{"level":"end_user","text":"Leaks","severity":8}'::jsonb);
  ch := app.save_fmea_cause(m1, NULL, '{"text":"Tool wear","occurrence":8,"detection":8}'::jsonb);
  m2 := app.save_fmea_failure_mode(fn, NULL, '{"text":"Burr left"}'::jsonb);
  PERFORM app.save_fmea_effect(m2, NULL, '{"level":"own_plant","text":"Rework","severity":3}'::jsonb);
  cl := app.save_fmea_cause(m2, NULL, '{"text":"Blunt deburr tool","preventionControls":"Tool change schedule","occurrence":2,"detection":2}'::jsonb);
  PERFORM app.set_fmea_approver(r1, dan);
  PERFORM pg_temp.assert_eq((SELECT rpn || '/' || priority FROM public.fmea_causes WHERE id = ch), '512/high', 'the cause that needs attention is scored');
  PERFORM pg_temp.assert_eq(cardinality(app.fmea_revision_problems(r1)), 2, 'it needs a control and an answer (the list says so)');

  -- ---- adding an action ----
  r := pg_temp.fails(format($f$SELECT app.add_fmea_action(%L, jsonb_build_object('kind','prevention','description','Change the tool every 50 parts','ownerUserId',%L,'dueOn',%L))$f$, ch, bob, v_due));
  PERFORM pg_temp.assert_eq(r, 'ok', 'a manager adds an action');
  a1 := (SELECT id FROM public.fmea_actions WHERE cause_id = ch);
  PERFORM pg_temp.assert_eq((SELECT status || '/' || kind || '/' || revision_id::text FROM public.fmea_actions WHERE id = a1), 'open/prevention/' || r1::text, 'it is open, of its kind, on the revision');
  PERFORM pg_temp.assert_eq(cardinality(app.fmea_revision_problems(r1)), 0, 'a live action answers both: needs attention and no control');
  r := pg_temp.fails(format($f$SELECT app.add_fmea_action(%L, jsonb_build_object('kind','sorting','description','x y z','ownerUserId',%L,'dueOn',%L))$f$, ch, bob, v_due));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'a kind is prevention or detection');
  r := pg_temp.fails(format($f$SELECT app.add_fmea_action(%L, jsonb_build_object('kind','detection','description','ok','ownerUserId',%L,'dueOn',%L))$f$, ch, bob, v_due));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'words are needed');
  r := pg_temp.fails(format($f$SELECT app.add_fmea_action(%L, jsonb_build_object('kind','detection','description','Gauge every part','ownerUserId',%L,'dueOn',%L))$f$, ch, bob, (current_date - 1)::text));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'not due in the past');
  r := pg_temp.fails(format($f$SELECT app.add_fmea_action(%L, jsonb_build_object('kind','detection','description','Gauge every part','dueOn',%L))$f$, ch, v_due));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'an owner is needed');
  r := pg_temp.fails(format($f$SELECT app.add_fmea_action(%L, jsonb_build_object('kind','detection','description','Gauge every part','ownerUserId',%L,'ownerEmployeeId',%L,'dueOn',%L))$f$, ch, bob, emp, v_due));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'not two owners');
  r := pg_temp.fails(format($f$SELECT app.add_fmea_action(%L, jsonb_build_object('kind','detection','description','Gauge every part','ownerUserId',%L,'dueOn',%L))$f$, ch, eve, v_due));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'the owner is a member of this organisation');
  r := pg_temp.fails(format($f$SELECT app.add_fmea_action(%L, jsonb_build_object('kind','detection','description','Gauge every part','ownerUserId',%L,'dueOn',%L,'colour','red'))$f$, ch, bob, v_due));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'unknown keys are refused');
  a2 := app.add_fmea_action(ch, jsonb_build_object('kind', 'detection', 'description', 'Gauge every part at OP10', 'ownerEmployeeId', emp, 'dueOn', v_due));
  PERFORM pg_temp.assert_eq((SELECT owner_employee_id FROM public.fmea_actions WHERE id = a2), emp, 'an action may be given to an employee of the register');
  PERFORM pg_temp.logout();

  -- ---- who may do what ----
  PERFORM pg_temp.login(hal);
  r := pg_temp.fails(format($f$SELECT app.add_fmea_action(%L, jsonb_build_object('kind','detection','description','Gauge every part','ownerUserId',%L,'dueOn',%L))$f$, ch, hal, v_due));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a viewer cannot add an action');
  r := pg_temp.fails(format($f$SELECT app.complete_fmea_action(%L, 'Done it')$f$, a1));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a viewer who is not the owner cannot finish it');
  r := pg_temp.fails(format($f$SELECT app.cancel_fmea_action(%L, 'Because I can')$f$, a1));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'nor cancel it');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_actions), 0::bigint, 'a viewer reads no action on a draft they are not on');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve);
  r := pg_temp.fails(format($f$SELECT app.complete_fmea_action(%L, 'Done it')$f$, a1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'another organisation cannot finish it');
  r := pg_temp.fails(format($f$SELECT app.add_fmea_action(%L, jsonb_build_object('kind','detection','description','Gauge every part','ownerUserId',%L,'dueOn',%L))$f$, ch, eve, v_due));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'nor add to a cause');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_actions), 0::bigint, 'nor read');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  r := pg_temp.fails(format($f$INSERT INTO public.fmea_actions (organisation_id, revision_id, cause_id, kind, description, owner_user_id, due_on) VALUES (%L,%L,%L,'detection','x y z',%L,%L)$f$, org, r1, ch, bob, v_due));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'no one writes the table directly');
  PERFORM pg_temp.logout();

  -- ---- the notices: whoever is given an action hears of it, unless they gave it to themselves ----
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.notifications WHERE entity_type = 'fmea_actions' AND recipient_user_id = bob), 1::bigint, 'bob was given an action');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.notifications WHERE entity_type = 'fmea_actions' AND recipient_user_id = gus), 1::bigint, 'gus (an employee with a sign-in) was given one');
  PERFORM pg_temp.assert_eq((SELECT bool_and(details ? 'fmea_id') FROM public.notifications WHERE entity_type = 'fmea_actions'), true, 'each notice names the FMEA');

  -- ---- finishing an action: the person it is given to, with only the read permission ----
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.my_fmea_actions(org, 'open')), 1::bigint, 'bob sees his action in My actions');
  PERFORM pg_temp.assert_eq((SELECT (x ->> 'fmeaNumber') || '/' || (x ->> 'causeText') FROM app.my_fmea_actions(org, 'open') x), 'FMEA-001/Tool wear', 'with the FMEA and the cause it is about');
  r := pg_temp.fails(format($f$SELECT app.complete_fmea_action(%L, '  ')$f$, a1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'what was found is needed');
  r := pg_temp.fails(format($f$SELECT app.complete_fmea_action(%L, 'Tool changed every 50 parts', '{"revisedOccurrence":11}'::jsonb)$f$, a1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'a revised rating is 1 to 10');
  r := pg_temp.fails(format($f$SELECT app.complete_fmea_action(%L, 'Tool changed every 50 parts', '{"revisedRpn":1}'::jsonb)$f$, a1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'the worked-out figures cannot be sent');
  PERFORM app.complete_fmea_action(a1, 'Tool changed every 50 parts', '{"revisedOccurrence":3}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT status FROM app.my_fmea_actions(org, 'done') x, jsonb_to_record(x) AS t(status text)), 'done', 'it is done');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT revised_rpn || '/' || revised_priority || '/' || revised_needs_attention FROM public.fmea_actions WHERE id = a1), '192/medium/false',
    'the database works out the revised figures: 8 x 3 x 8 = 192, medium, and below the severity floor of 9');
  PERFORM pg_temp.assert_eq((SELECT done_by FROM public.fmea_actions WHERE id = a1), bob, 'and who did it');
  PERFORM pg_temp.login(gus);
  PERFORM app.complete_fmea_action(a2, 'Gauged all parts for a week', '{"revisedDetection":2}'::jsonb);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT revised_rpn || '/' || revised_priority FROM public.fmea_actions WHERE id = a2), '128/medium', 'an employee''s linked sign-in finishes theirs too: 8 x 8 x 2 = 128');

  -- a changed rating re-works the revised figures of a finished action
  PERFORM pg_temp.login(cat);
  PERFORM app.save_fmea_cause(m1, ch, '{"detection":4}'::jsonb);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT revised_rpn || '/' || revised_priority FROM public.fmea_actions WHERE id = a1), '96/low', 'rating the cause again re-works a finished action: 8 x 3 x 4 = 96');
  PERFORM pg_temp.assert_eq((SELECT revised_rpn FROM public.fmea_actions WHERE id = a2), 128, 'an action that revises detection keeps its own detection: 8 x 8 x 2');
  PERFORM pg_temp.login(cat);
  PERFORM app.save_fmea_cause(m1, ch, '{"detection":8}'::jsonb);
  PERFORM pg_temp.logout();

  -- ---- frozen states, even for SQL ----
  r := pg_temp.fails(format($f$UPDATE public.fmea_actions SET description = 'Sneaky change' WHERE id = %L$f$, a1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'a finished action is changed by reopening it first');
  UPDATE public.fmea_actions SET revised_rpn = 1, revised_priority = 'high' WHERE id = a1;
  PERFORM pg_temp.assert_eq((SELECT revised_rpn || '/' || revised_priority FROM public.fmea_actions WHERE id = a1), '192/medium', 'the worked-out figures are not the caller''s to write: they are worked out again');
  r := pg_temp.fails(format($f$UPDATE public.fmea_actions SET adopted_in_revision_id = %L WHERE id = %L$f$, r1, a1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'nor is the adopted stamp');
  r := pg_temp.fails(format($f$UPDATE public.fmea_actions SET cause_id = %L WHERE id = %L$f$, cl, a1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'an action stays on its cause');
  PERFORM pg_temp.login(cat);
  r := pg_temp.fails(format($f$SELECT app.update_fmea_action(%L, '{"description":"Different words"}'::jsonb)$f$, a1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'only an open action can be changed');
  r := pg_temp.fails(format($f$SELECT app.cancel_fmea_action(%L, 'No longer wanted')$f$, a1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'nor a finished one cancelled');
  PERFORM app.reopen_fmea_action(a2);
  PERFORM pg_temp.assert_eq((SELECT status || '/' || coalesce(evidence_note, '-') || '/' || coalesce(revised_rpn::text, '-') FROM public.fmea_actions WHERE id = a2), 'open/-/-', 'reopening clears what was found and the revised figures');
  PERFORM app.update_fmea_action(a2, jsonb_build_object('description', 'Gauge every part at OP10 and OP20', 'dueOn', (current_date + 60)::text));
  PERFORM app.cancel_fmea_action(a2, 'The gauge went out for repair');
  r := pg_temp.fails(format($f$SELECT app.reopen_fmea_action(%L)$f$, a2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'a cancelled action stays cancelled');
  -- a cause cannot be rated for a revised figure it has no ratings for
  cx := app.save_fmea_cause(m2, NULL, '{"text":"Unrated one"}'::jsonb);
  a3 := app.add_fmea_action(cx, jsonb_build_object('kind', 'prevention', 'description', 'Rate it later', 'ownerUserId', bob, 'dueOn', v_due));
  r := pg_temp.fails(format($f$SELECT app.complete_fmea_action(%L, 'Done it', '{"revisedOccurrence":3}'::jsonb)$f$, a3));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'revised ratings need a rated cause');
  PERFORM app.remove_fmea_node('cause', cx);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_actions WHERE id = a3), 0::bigint, 'an action goes with its cause on a draft');
  PERFORM pg_temp.logout();

  -- ---- waiting for approval: the revision is frozen, actions included ----
  a2 := NULL;
  PERFORM pg_temp.login(cat);
  a4 := app.add_fmea_action(cl, jsonb_build_object('kind', 'detection', 'description', 'Check the burr by touch at OP10', 'ownerUserId', bob, 'dueOn', v_due));
  PERFORM app.submit_fmea_revision(r1);
  r := pg_temp.fails(format($f$SELECT app.add_fmea_action(%L, jsonb_build_object('kind','detection','description','Another one','ownerUserId',%L,'dueOn',%L))$f$, cl, bob, v_due));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'no new action while it waits for approval');
  r := pg_temp.fails(format($f$SELECT app.cancel_fmea_action(%L, 'Changed my mind')$f$, a4));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'nor a change to an open one');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(bob);
  r := pg_temp.fails(format($f$SELECT app.complete_fmea_action(%L, 'Done it')$f$, a4));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'the owner cannot finish it while it waits');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(dan);
  PERFORM app.approve_fmea_revision(r1, current_date, NULL);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT status FROM public.fmea_revisions WHERE id = r1), 'effective', 'approved and in force');

  -- ---- in force: actions are alive, the analysis is not ----
  PERFORM pg_temp.login(cat);
  a5 := app.add_fmea_action(ch, jsonb_build_object('kind', 'detection', 'description', 'In-process gauging every tenth part', 'ownerUserId', bob, 'dueOn', v_due));
  PERFORM pg_temp.assert_eq((SELECT status FROM public.fmea_actions WHERE id = a5), 'open', 'an action is added to the revision in force');
  r := pg_temp.fails(format($f$SELECT app.save_fmea_cause(%L, %L, '{"detection":2}'::jsonb)$f$, m1, ch));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'but its ratings are frozen');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(bob);
  PERFORM app.complete_fmea_action(a4, 'Checked at OP10 for a month', '{"revisedDetection":1}'::jsonb);
  PERFORM app.reopen_fmea_action(a4);
  PERFORM app.complete_fmea_action(a4, 'Checked at OP10 for a month', '{"revisedDetection":1}'::jsonb);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT revised_rpn || '/' || revised_priority FROM public.fmea_actions WHERE id = a4), '6/low', 'finished on the revision in force: 3 x 2 x 1');

  -- ---- a new revision adopts the finished actions ----
  PERFORM pg_temp.login(cat);
  r2 := app.start_fmea_revision(f1, true);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT occurrence FROM public.fmea_causes WHERE revision_id = r2 AND text = 'Tool wear'), 3, 'the revised occurrence became the cause''s rating');
  PERFORM pg_temp.assert_eq((SELECT prevention_controls FROM public.fmea_causes WHERE revision_id = r2 AND text = 'Tool wear'), 'Change the tool every 50 parts', 'the action''s words joined its controls');
  PERFORM pg_temp.assert_eq((SELECT rpn || '/' || priority FROM public.fmea_causes WHERE revision_id = r2 AND text = 'Tool wear'), '192/medium', 'and it is scored again: 8 x 3 x 8');
  PERFORM pg_temp.assert_eq((SELECT detection || '/' || detection_controls FROM public.fmea_causes WHERE revision_id = r2 AND text = 'Blunt deburr tool'), '1/Check the burr by touch at OP10', 'a detection action adopted');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_actions WHERE adopted_in_revision_id = r2), 2::bigint, 'the finished ones are stamped as adopted');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_actions WHERE revision_id = r2), 0::bigint, 'and the open one is not copied until the new revision takes effect');
  PERFORM pg_temp.login(cat);
  r := pg_temp.fails(format($f$SELECT app.reopen_fmea_action(%L)$f$, a1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'an adopted action cannot be reopened');
  -- discarding the draft gives them back
  PERFORM app.discard_fmea_revision(r2, 'Started by mistake');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_actions WHERE adopted_in_revision_id IS NOT NULL), 0::bigint, 'discarding a draft un-adopts what it had taken in');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.fmea_actions WHERE id = a5), 'open', 'and leaves an open action alone');

  -- ---- a new revision that takes effect carries the open actions on ----
  PERFORM pg_temp.login(cat);
  r3 := app.start_fmea_revision(f1, false);
  PERFORM pg_temp.assert_eq((SELECT occurrence FROM public.fmea_causes WHERE revision_id = r3 AND text = 'Tool wear'), 8, 'without adopting, the ratings are as they were');
  PERFORM app.update_fmea_revision(r3, '{"changeSummary":"Tool change schedule revised"}'::jsonb);
  PERFORM app.set_fmea_approver(r3, dan);
  PERFORM app.save_fmea_cause((SELECT failure_mode_id FROM public.fmea_causes WHERE revision_id = r3 AND text = 'Tool wear'), (SELECT id FROM public.fmea_causes WHERE revision_id = r3 AND text = 'Tool wear'),
    '{"noActionReason":"The customer accepts this rate while the gauging runs","preventionControls":"Tool change schedule"}'::jsonb);
  PERFORM app.submit_fmea_revision(r3);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(dan);
  PERFORM app.approve_fmea_revision(r3, current_date, NULL);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT status FROM public.fmea_revisions WHERE id = r3), 'effective', 'the new revision is in force');
  PERFORM pg_temp.assert_eq((SELECT status || '/' || cancel_reason FROM public.fmea_actions WHERE id = a5), 'cancelled/Carried on in rev B', 'the open action on the old revision was carried on, and says so');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_actions WHERE revision_id = r3 AND status = 'open' AND prev_row_id = a5), 1::bigint, 'as a new open action on the continuing cause');
  PERFORM pg_temp.assert_eq((SELECT description FROM public.fmea_actions WHERE revision_id = r3 AND prev_row_id = a5), 'In-process gauging every tenth part', 'with its own words, owner and due date');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.notifications WHERE entity_type = 'fmea_actions' AND recipient_user_id = bob), 4::bigint, 'carrying an action on is not news (bob was given four: a1, a3, a4, a5; the carried copy adds none)');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.my_fmea_actions(org, 'open') WHERE false), 0::bigint, 'placeholder');
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.my_fmea_actions(org, 'open')), 1::bigint, 'bob has the carried action, not the cancelled one');
  PERFORM pg_temp.logout();

  -- ---- withdrawing ends the open actions ----
  PERFORM pg_temp.login(dan);
  PERFORM app.withdraw_fmea(f1, 'Product no longer made');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_actions WHERE status = 'open'), 0::bigint, 'withdrawing the FMEA cancels what was still open');
  PERFORM pg_temp.assert_eq((SELECT bool_and(cancel_reason = 'The FMEA was withdrawn') FROM public.fmea_actions WHERE revision_id = r3 AND status = 'cancelled'), true, 'with that reason');

  -- ---- the periodic review ----
  PERFORM pg_temp.login(cat);
  r := pg_temp.fails(format('SELECT app.record_fmea_review(%L, %L, %L)', f1, 'no_change', 'Looks right'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'a withdrawn FMEA is not reviewed');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  fother := app.create_fmea(org, jsonb_build_object('kind', 'process', 'title', 'Second FMEA',
    'team', jsonb_build_array(jsonb_build_object('userId', cat, 'role', 'lead'), jsonb_build_object('userId', fay, 'role', 'quality')),
    'links', jsonb_build_array(jsonb_build_object('kind', 'part', 'id', part))));
  rother := (SELECT id FROM public.fmea_revisions WHERE fmea_id = fother);
  PERFORM pg_temp.build_fmea_net(rother);
  PERFORM app.set_fmea_approver(rother, dan);
  PERFORM app.submit_fmea_revision(rother);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(dan);
  PERFORM app.approve_fmea_revision(rother, current_date, NULL);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  r := pg_temp.fails(format('SELECT app.record_fmea_review(%L, %L, %L)', fother, 'no_change', ' '));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'no change needs a note');
  r := pg_temp.fails(format('SELECT app.record_fmea_review(%L, %L, NULL)', fother, 'looked'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'an outcome is no change or a revision');
  PERFORM app.record_fmea_review(fother, 'no_change', 'Checked the ratings against this year''s scrap data');
  PERFORM pg_temp.assert_eq((SELECT next_review_on FROM public.fmeas WHERE id = fother) > current_date + 360, true, 'the next review is a full interval away');
  PERFORM app.record_fmea_review(fother, 'revision_started', NULL);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_revisions WHERE fmea_id = fother AND status = 'draft'), 1::bigint, 'a review can start a revision');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_reviews WHERE fmea_id = fother), 2::bigint, 'both are on the record');
  PERFORM pg_temp.logout();
  r := pg_temp.fails(format($f$UPDATE public.fmea_reviews SET note = 'edited' WHERE fmea_id = %L$f$, fother));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'a review is never changed');
  r := pg_temp.fails(format($f$DELETE FROM public.fmea_reviews WHERE fmea_id = %L$f$, fother));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'or removed');
  PERFORM pg_temp.login(hal);
  r := pg_temp.fails(format('SELECT app.record_fmea_review(%L, %L, %L)', fother, 'no_change', 'Looks right'));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a viewer cannot review');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_reviews WHERE fmea_id = fother), 2::bigint, 'but reads the reviews of an FMEA in force');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_reviews) + (SELECT count(*) FROM public.fmea_actions), 0::bigint, 'another organisation reads neither');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
