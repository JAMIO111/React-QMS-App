-- CAPA4: D5 corrective actions (one per occurrence cause, owner and due date), D6 implement and validate (verification needs capa.verify, immutable, stale after
-- a change, a failed one reopens D5 and D6), D7 prevent recurrence, the automatic stage, nothing locks, permissions and isolation.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('3f000000-0000-0000-0000-000000000601', 'owner@capa4.test'),
  ('3f000000-0000-0000-0000-000000000602', 'eng@capa4.test'),
  ('3f000000-0000-0000-0000-000000000603', 'viewer@capa4.test'),
  ('3f000000-0000-0000-0000-000000000604', 'other@capa4.test');

DO $$
DECLARE
  org uuid; org2 uuid; eng_role uuid; viewer_role uuid; m_eng uuid; m_view uuid; c uuid; c2 uuid; rc1 uuid; rc2 uuid; rc3 uuid; rc_other uuid;
  t_owner uuid; t_eng uuid; a1 uuid; a2 uuid; a3 uuid; p1 uuid; v1 uuid;
BEGIN
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000601');
  org := app.create_organisation('Capa Four Works', 'Plant A', 'PA', NULL);
  SELECT id INTO eng_role FROM public.roles WHERE organisation_id = org AND key = 'quality_engineer';
  SELECT id INTO viewer_role FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '3f000000-0000-0000-0000-000000000602', 'active') RETURNING id INTO m_eng;
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '3f000000-0000-0000-0000-000000000603', 'active') RETURNING id INTO m_view;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) VALUES (org, m_eng, eng_role), (org, m_view, viewer_role);
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000604');
  org2 := app.create_organisation('Other Works', 'Plant B', 'PB', NULL);
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000601');
  c := app.start_capa(org, 'Burrs on the bore', 'Burrs on every third part', NULL, NULL, NULL);
  c2 := app.start_capa(org, 'Another 8D', 'Problem', NULL, NULL, NULL);
  SELECT id INTO t_owner FROM public.capa_team_members WHERE capa_id = c AND role = 'leader';
  INSERT INTO public.capa_team_members (organisation_id, capa_id, membership_id, role) VALUES (org, c, m_eng, 'member') RETURNING id INTO t_eng;
  INSERT INTO public.capa_root_causes (organisation_id, capa_id, kind, description, verified, verification_method)
    VALUES (org, c, 'occurrence', 'No tool life limit on the boring bar', true, 'Trial') RETURNING id INTO rc1;
  INSERT INTO public.capa_root_causes (organisation_id, capa_id, kind, description, verified, verification_method)
    VALUES (org, c, 'occurrence', 'Fixture clamps too loose', true, 'Measured') RETURNING id INTO rc2;
  INSERT INTO public.capa_root_causes (organisation_id, capa_id, kind, description, verified, verification_method)
    VALUES (org, c, 'systemic', 'No tool monitoring in the control plan', true, 'Reviewed') RETURNING id INTO rc3;
  INSERT INTO public.capa_root_causes (organisation_id, capa_id, kind, description) VALUES (org, c2, 'occurrence', 'Cause of another 8D') RETURNING id INTO rc_other;

  -- Stage: open until D4 is complete, whatever the actions say.
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.capas WHERE id = c), 'open', 'a new 8D is open');

  -- D5: an action for every occurrence cause, each with an owner and a due date. (No action yet.)
  PERFORM pg_temp.assert_eq(app.capa_step_problems(c, 'd5'), ARRAY['Add a corrective action for: No tool life limit on the boring bar', 'Add a corrective action for: Fixture clamps too loose'], 'an action per occurrence cause');
  PERFORM pg_temp.assert_eq(app.capa_step_problems(c2, 'd5'), ARRAY['Add a corrective action for: Cause of another 8D'], 'each 8D has its own');
  INSERT INTO public.capa_actions (organisation_id, capa_id, phase, description, root_cause_id) VALUES (org, c, 'corrective', 'Set a tool life limit of 500 parts', rc1) RETURNING id INTO a1;
  PERFORM pg_temp.assert_eq(app.capa_step_problems(c, 'd5'), ARRAY['Add a corrective action for: Fixture clamps too loose', '1 corrective action needs an owner and a due date'], 'covered, but it needs an owner and a date');
  UPDATE public.capa_actions SET owner_team_member_id = t_eng, due_date = current_date + 7 WHERE id = a1;
  INSERT INTO public.capa_actions (organisation_id, capa_id, phase, description, root_cause_id, owner_team_member_id, due_date) VALUES (org, c, 'corrective', 'Replace the clamps', rc2, t_owner, current_date + 14) RETURNING id INTO a2;
  PERFORM pg_temp.assert_eq(app.capa_step_problems(c, 'd5'), ARRAY[]::text[], 'D5 is ready');
  UPDATE public.capa_actions SET status = 'cancelled', cancel_reason = 'Superseded' WHERE id = a2;
  PERFORM pg_temp.assert_eq(app.capa_step_problems(c, 'd5'), ARRAY['Add a corrective action for: Fixture clamps too loose'], 'a cancelled action does not cover its cause');
  UPDATE public.capa_actions SET status = 'open' WHERE id = a2;

  -- The cause an action addresses: this 8D's live causes only; can be changed; interim actions have none; phases are fixed.
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.capa_actions (organisation_id, capa_id, phase, description, root_cause_id) VALUES (%L, %L, 'corrective', 'x', %L)$q$, org, c, rc_other), 'a cause of another 8D');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.capa_actions (organisation_id, capa_id, phase, description, root_cause_id) VALUES (%L, %L, 'interim', 'x', %L)$q$, org, c, rc1), 'interim actions have no cause');
  PERFORM pg_temp.assert_ok(format($q$UPDATE public.capa_actions SET root_cause_id = %L WHERE id = %L$q$, rc3, a1), 'the cause can be changed');
  PERFORM pg_temp.assert_ok(format($q$UPDATE public.capa_actions SET root_cause_id = %L WHERE id = %L$q$, rc1, a1), 'and changed back');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.capa_actions SET phase = 'preventive' WHERE id = %L$q$, a1), 'the phase cannot change');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.capa_actions SET root_cause_id = %L WHERE id = %L$q$, rc_other, a1), 'nor a cause of another 8D');

  -- Stage follows the work: open until D4 is complete; then actions in progress, awaiting verification, verified effective.
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.capas WHERE id = c), 'open', 'corrective actions do not move an 8D whose D4 is not complete');
  PERFORM app.capa_complete_step(c, 'd4');
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.capas WHERE id = c), 'actions_in_progress', 'D4 complete: actions in progress');
  UPDATE public.capa_actions SET status = 'done', evidence_note = 'Limit set' WHERE id = a1;
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.capas WHERE id = c), 'actions_in_progress', 'one action is still open');
  UPDATE public.capa_actions SET status = 'done' WHERE id = a2;
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.capas WHERE id = c), 'awaiting_verification', 'all done: awaiting verification');
  PERFORM pg_temp.assert_eq(app.capa_step_problems(c, 'd6'), ARRAY['Verify that the corrective actions worked (needs someone who can verify)'], 'D6 needs a verification');

  -- Verifying needs capa.verify, a method, nothing open and one done; it is a record.
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000602');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.record_capa_verification(%L, true, 'Audit of 3 lots', NULL)$q$, c), 'a quality engineer cannot verify');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.capa_verifications (organisation_id, capa_id, effective, method, actions_fingerprint) VALUES (%L, %L, true, 'x', 'x')$q$, org, c), 'no direct insert');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000601');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.record_capa_verification(%L, true, '  ', NULL)$q$, c), 'a method is needed');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.record_capa_verification(%L, false, 'Audit', NULL)$q$, c), 'a failed verification needs a note');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.record_capa_verification(%L, true, 'Audit', NULL)$q$, c2), 'nothing to verify yet in the other 8D');
  INSERT INTO public.capa_actions (organisation_id, capa_id, phase, description) VALUES (org, c, 'corrective', 'Late addition') RETURNING id INTO a3;
  PERFORM pg_temp.assert_fails(format($q$SELECT app.record_capa_verification(%L, true, 'Audit', NULL)$q$, c), 'an open corrective action blocks verifying');
  UPDATE public.capa_actions SET status = 'cancelled', cancel_reason = 'Not needed' WHERE id = a3;
  v1 := app.record_capa_verification(c, true, '  Audit of 3 lots  ', 'No burrs in 3 lots');
  PERFORM pg_temp.assert_eq((SELECT (effective, method, notes, verified_by IS NOT NULL)::text FROM public.capa_verifications WHERE id = v1), '(t,"Audit of 3 lots","No burrs in 3 lots",t)', 'recorded and stamped');
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.capas WHERE id = c), 'verified_effective', 'verified effective');
  PERFORM pg_temp.assert_eq(app.capa_step_problems(c, 'd6'), ARRAY[]::text[], 'D6 is ready');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.outbox_events WHERE event_type = 'capa.verified' AND entity_id = c), 1::bigint, 'capa.verified recorded');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.capa_verifications SET effective = false WHERE id = %L$q$, v1), 'a verification is never changed');
  PERFORM pg_temp.assert_fails(format($q$DELETE FROM public.capa_verifications WHERE id = %L$q$, v1), 'or deleted');
  PERFORM app.capa_complete_step(c, 'd5');
  PERFORM app.capa_complete_step(c, 'd6');

  -- Nothing locks, but a change makes the verification stale: the stage and D6 notice.
  PERFORM pg_temp.assert_ok(format($q$UPDATE public.capa_actions SET description = 'Set a tool life limit of 400 parts' WHERE id = %L$q$, a1), 'an action can be edited after D5 and D6 are complete');
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.capas WHERE id = c), 'verified_effective', 'editing the words does not undo a verification');
  UPDATE public.capa_actions SET status = 'open' WHERE id = a1;
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.capas WHERE id = c), 'actions_in_progress', 'reopening an action puts the 8D back to actions in progress');
  UPDATE public.capa_actions SET status = 'done' WHERE id = a1;
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.capas WHERE id = c), 'awaiting_verification', 'done again: the earlier verification is stale, so awaiting verification');
  PERFORM pg_temp.assert_eq(app.capa_step_problems(c, 'd6'), ARRAY['The corrective actions changed after the last verification: verify again'], 'D6 says so');

  -- A failed verification returns the 8D to actions in progress and reopens D5 and D6.
  PERFORM app.record_capa_verification(c, false, 'Audit of 5 lots', 'Burrs again on lot 12');
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.capas WHERE id = c), 'actions_in_progress', 'failed: back to actions in progress');
  PERFORM pg_temp.assert_eq((SELECT array_agg(step ORDER BY step) FROM public.capa_steps WHERE capa_id = c AND completed_at IS NOT NULL), ARRAY['d4'], 'D5 and D6 were reopened (only D4 stays complete)');
  PERFORM pg_temp.assert_eq((SELECT reopen_reason FROM public.capa_steps WHERE capa_id = c AND step = 'd6'), 'Verification failed: Burrs again on lot 12', 'with the reason');
  PERFORM pg_temp.assert_eq(app.capa_step_problems(c, 'd6'), ARRAY['The last verification failed: put it right and verify again'], 'D6 says the last one failed');
  INSERT INTO public.capa_actions (organisation_id, capa_id, phase, description, root_cause_id, owner_team_member_id, due_date) VALUES (org, c, 'corrective', 'Add a second inspection', rc1, t_eng, current_date + 3) RETURNING id INTO a3;
  UPDATE public.capa_actions SET status = 'done' WHERE id = a3;
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.capas WHERE id = c), 'awaiting_verification', 'a new action done: awaiting verification again');
  PERFORM app.record_capa_verification(c, true, 'Audit of 5 more lots', 'Clean');
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.capas WHERE id = c), 'verified_effective', 'verified effective again');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.capa_verifications WHERE capa_id = c), 3::bigint, 'every verification is kept');
  -- Reopening D4 takes the stage back to open.
  PERFORM app.capa_reopen_step(c, 'd4', 'A new cause was found');
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.capas WHERE id = c), 'open', 'reopening D4: open');
  PERFORM app.capa_complete_step(c, 'd4');
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.capas WHERE id = c), 'verified_effective', 'D4 complete again: the verification still stands');

  -- D7: lessons learned, and preventive actions done or a reason there are none.
  PERFORM pg_temp.assert_eq(app.capa_step_problems(c, 'd7'), ARRAY['Write the lessons learned', 'Add a preventive action, or say why none is needed'], 'D7 needs both');
  UPDATE public.capas SET d7_lessons_learned = 'Tool life must be in every control plan' WHERE id = c;
  INSERT INTO public.capa_actions (organisation_id, capa_id, phase, description, root_cause_id) VALUES (org, c, 'preventive', 'Add tool life to the control plan template', rc3) RETURNING id INTO p1;
  PERFORM pg_temp.assert_eq(app.capa_step_problems(c, 'd7'), ARRAY['Finish or cancel the 1 open preventive action', 'Add a preventive action, or say why none is needed'], 'an open preventive action blocks');
  UPDATE public.capa_actions SET status = 'done' WHERE id = p1;
  PERFORM pg_temp.assert_eq(app.capa_step_problems(c, 'd7'), ARRAY[]::text[], 'D7 is ready');
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.capas WHERE id = c), 'verified_effective', 'preventive actions do not move the stage');
  UPDATE public.capas SET d7_no_preventive_reason = 'Nothing else is exposed' WHERE id = c2;
  PERFORM pg_temp.assert_eq(app.capa_step_problems(c2, 'd7'), ARRAY['Write the lessons learned'], 'a reason replaces preventive actions');
  PERFORM app.capa_complete_step(c, 'd7');
  PERFORM pg_temp.assert_ok(format($q$UPDATE public.capas SET d7_lessons_learned = 'Edited after D7 was completed' WHERE id = %L$q$, c), 'D7 can still be edited after it is complete');
  PERFORM pg_temp.logout();

  -- A viewer reads but changes nothing.
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000603');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.capa_verifications), 3::bigint, 'a viewer reads verifications');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.record_capa_verification(%L, true, 'x', NULL)$q$, c), 'a viewer cannot verify');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.capa_actions (organisation_id, capa_id, phase, description) VALUES (%L, %L, 'corrective', 'x')$q$, org, c), 'a viewer cannot add an action');
  PERFORM pg_temp.logout();

  -- Isolation.
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000604');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.capa_verifications), 0::bigint, 'isolation: verifications');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.record_capa_verification(%L, true, 'x', NULL)$q$, c), 'isolation: cannot verify another organisation''s 8D');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
