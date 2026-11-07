-- CAPA6: a completed step is read-only until reopened (team, header, links, verifications; actions are covered with their steps), and actions are worked by
-- the person they are assigned to: managers write and assign, the actionee updates the findings and closes, and is told when it is assigned.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('3f000000-0000-0000-0000-000000000801', 'owner@capa6.test'),
  ('3f000000-0000-0000-0000-000000000802', 'actionee@capa6.test'),
  ('3f000000-0000-0000-0000-000000000803', 'other@capa6.test'),
  ('3f000000-0000-0000-0000-000000000804', 'foreign@capa6.test');

DO $$
DECLARE
  org uuid; org2 uuid; viewer_role uuid; m_act uuid; m_other uuid; c uuid; t_act uuid; t_other uuid; a1 uuid; a2 uuid;
BEGIN
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000801');
  org := app.create_organisation('Capa Six Works', 'Plant A', 'PA', NULL);
  SELECT id INTO viewer_role FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '3f000000-0000-0000-0000-000000000802', 'active') RETURNING id INTO m_act;
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '3f000000-0000-0000-0000-000000000803', 'active') RETURNING id INTO m_other;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) VALUES (org, m_act, viewer_role), (org, m_other, viewer_role);
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000804');
  org2 := app.create_organisation('Other Works', 'Plant B', 'PB', NULL);
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000801');
  c := app.start_capa(org, 'Burrs on the bore', 'Burrs on every third part', NULL, NULL, NULL);
  INSERT INTO public.capa_team_members (organisation_id, capa_id, membership_id, role) VALUES (org, c, m_act, 'member') RETURNING id INTO t_act;
  INSERT INTO public.capa_team_members (organisation_id, capa_id, membership_id, role) VALUES (org, c, m_other, 'member') RETURNING id INTO t_other;

  -- Managers write the action and assign it.
  INSERT INTO public.capa_actions (organisation_id, capa_id, phase, description, owner_team_member_id, due_date) VALUES (org, c, 'interim', 'Quarantine lot 77', t_act, current_date + 2) RETURNING id INTO a1;
  INSERT INTO public.capa_actions (organisation_id, capa_id, phase, description, owner_team_member_id, due_date) VALUES (org, c, 'interim', 'Sort lot 78', t_other, current_date + 3) RETURNING id INTO a2;
  PERFORM pg_temp.assert_eq(app.is_capa_action_assignee(a1), false, 'the owner of the 8D is not the actionee of this action');
  PERFORM pg_temp.logout();

  -- The actionee has capa.read only, but works their own action: findings, then close.
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000802');
  PERFORM pg_temp.assert_eq(app.is_capa_action_assignee(a1), true, 'the assignee is recognised');
  PERFORM pg_temp.assert_eq(app.is_capa_action_assignee(a2), false, 'but not for someone else''s action');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.capa_actions (organisation_id, capa_id, phase, description) VALUES (%L, %L, 'interim', 'Self-made')$q$, org, c), 'the actionee cannot add actions');
  PERFORM pg_temp.assert_eq(pg_temp.affected(format($q$UPDATE public.capa_actions SET evidence_note = 'Hijacked' WHERE id = %L$q$, a2)), 0::bigint, 'nor touch an action assigned to someone else');
  PERFORM pg_temp.assert_ok(format($q$UPDATE public.capa_actions SET evidence_note = '30 parts quarantined so far' WHERE id = %L$q$, a1), 'the actionee updates the findings');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.capa_actions SET description = 'Changed' WHERE id = %L$q$, a1), 'but not what the action is');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.capa_actions SET due_date = current_date + 30 WHERE id = %L$q$, a1), 'nor the due date');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.capa_actions SET owner_team_member_id = %L WHERE id = %L$q$, t_other, a1), 'nor who has it');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.capa_actions SET status = 'cancelled', cancel_reason = 'x' WHERE id = %L$q$, a1), 'nor cancel it');
  PERFORM pg_temp.assert_ok(format($q$UPDATE public.capa_actions SET evidence_note = NULL WHERE id = %L$q$, a1), 'findings can be cleared');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.capa_actions SET status = 'done' WHERE id = %L$q$, a1), 'closing needs the findings written');
  PERFORM pg_temp.assert_ok(format($q$UPDATE public.capa_actions SET status = 'done', evidence_note = 'All 120 parts quarantined and tagged' WHERE id = %L$q$, a1), 'the actionee closes it with findings');
  PERFORM pg_temp.assert_eq((SELECT (status, done_by IS NOT NULL)::text FROM public.capa_actions WHERE id = a1), '(done,t)', 'closed and stamped');
  PERFORM pg_temp.assert_ok(format($q$UPDATE public.capa_actions SET status = 'open' WHERE id = %L$q$, a1), 'and can reopen it');
  PERFORM pg_temp.logout();

  -- Notices: the actionee is told about an action assigned to them (not about their own closing), and only they see it.
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.notifications WHERE entity_type = 'capa_actions' AND entity_id = a1::text), 1::bigint, 'one notice for the assignment');
  PERFORM pg_temp.assert_eq((SELECT recipient_user_id FROM public.notifications WHERE entity_type = 'capa_actions' AND entity_id = a1::text), '3f000000-0000-0000-0000-000000000802'::uuid, 'addressed to the actionee');
  PERFORM pg_temp.assert_eq((SELECT body FROM public.notifications WHERE entity_type = 'capa_actions' AND entity_id = a1::text), (SELECT reference FROM public.capas WHERE id = c) || ' — Burrs on the bore — Quarantine lot 77', 'with the 8D and the action');
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000802');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.visible_notifications(org) WHERE entity_type = 'capa_actions'), 1::bigint, 'the actionee sees theirs');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000803');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.visible_notifications(org) WHERE entity_type = 'capa_actions'), 1::bigint, 'the other actionee sees only theirs');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000801');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.visible_notifications(org) WHERE entity_type = 'capa_actions'), 0::bigint, 'the person who assigned them is not told');
  UPDATE public.capa_actions SET owner_team_member_id = t_other WHERE id = a1;
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.notifications WHERE entity_type = 'capa_actions' AND entity_id = a1::text), 2::bigint, 'handing it to someone else notifies them');
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000802');
  PERFORM pg_temp.assert_eq(app.is_capa_action_assignee(a1), false, 'the former actionee no longer works it');
  PERFORM pg_temp.logout();

  -- A completed step is read-only until reopened: the team (D1), the initiation details (D0).
  UPDATE public.capa_steps SET completed_at = now() WHERE capa_id = c AND step IN ('d0', 'd1');
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000801');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.capa_team_members SET role = 'champion' WHERE id = %L$q$, t_act), 'D1 complete: the team cannot change');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.capas SET title = 'Retitled' WHERE id = %L$q$, c), 'D0 complete: the details cannot change');
  PERFORM pg_temp.assert_ok(format($q$UPDATE public.capas SET d2_what = 'Burrs on the bore' WHERE id = %L$q$, c), 'other steps are not affected');
  PERFORM app.capa_reopen_step(c, 'd1', 'A new member joins');
  PERFORM pg_temp.assert_ok(format($q$UPDATE public.capa_team_members SET role = 'champion' WHERE id = %L$q$, t_act), 'D1 reopened: the team can change');
  PERFORM app.capa_reopen_step(c, 'd0', 'Wrong title');
  PERFORM pg_temp.assert_ok(format($q$UPDATE public.capas SET title = 'Retitled' WHERE id = %L$q$, c), 'D0 reopened: the details can change');
  PERFORM pg_temp.logout();

  -- Isolation.
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000804');
  PERFORM pg_temp.assert_eq(app.is_capa_action_assignee(a1), false, 'isolation: not an assignee elsewhere');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.capa_actions), 0::bigint, 'isolation: no actions');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
