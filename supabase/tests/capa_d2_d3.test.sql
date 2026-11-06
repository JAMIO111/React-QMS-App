-- CAPA2: D2 (5W2H on the 8D, Is / Is-Not analyses) and D3 (interim containment actions): prefill from an NC, the "still needed" lists,
-- analyses (structured data, removal marks), actions (owner on the team, status stamps, cancel reason, reopening), a team member owning
-- open actions cannot leave, nothing locks after a step is completed, permissions and isolation.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('3f000000-0000-0000-0000-000000000401', 'owner@capa2.test'),
  ('3f000000-0000-0000-0000-000000000402', 'eng@capa2.test'),
  ('3f000000-0000-0000-0000-000000000403', 'viewer@capa2.test'),
  ('3f000000-0000-0000-0000-000000000404', 'other@capa2.test');

DO $$
DECLARE
  org uuid; org2 uuid; site uuid; eng_role uuid; viewer_role uuid; m_eng uuid; m_view uuid;
  sup uuid; nc uuid; c uuid; c2 uuid; t_owner uuid; t_eng uuid; t_ext uuid; an uuid; act uuid; act2 uuid; act3 uuid; v_problems text[];
BEGIN
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000401');
  org := app.create_organisation('Capa Two Works', 'Plant A', 'PA', NULL);
  SELECT id INTO site FROM public.sites WHERE organisation_id = org;
  SELECT id INTO eng_role FROM public.roles WHERE organisation_id = org AND key = 'quality_engineer';
  SELECT id INTO viewer_role FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '3f000000-0000-0000-0000-000000000402', 'active') RETURNING id INTO m_eng;
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '3f000000-0000-0000-0000-000000000403', 'active') RETURNING id INTO m_view;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) VALUES (org, m_eng, eng_role), (org, m_view, viewer_role);
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000404');
  org2 := app.create_organisation('Other Works', 'Plant B', 'PB', NULL);
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000401');
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'BAR', 'Bar Co') RETURNING id INTO sup;
  INSERT INTO public.nonconformances (organisation_id, source, title, description, severity, quantity_affected, quantity_inspected, lot_number, work_order, detected_at, site_id, supplier_id)
    VALUES (org, 'supplier', 'Cracked bar stock', 'Cracks', 'major', 3, 10, '77', 'WO-5', DATE '2026-11-03', site, sup) RETURNING id INTO nc;

  -- Started from an NC: D2 is filled from it (what, where, when, how many); the rest is left for the team.
  c := app.start_capa(org, NULL, NULL, NULL, NULL, nc);
  PERFORM pg_temp.assert_eq((SELECT d2_what FROM public.capas WHERE id = c), 'Cracked bar stock · Lot 77 · Work order WO-5', 'D2 what from the NC');
  PERFORM pg_temp.assert_eq((SELECT d2_where FROM public.capas WHERE id = c), 'Plant A', 'D2 where from the site');
  PERFORM pg_temp.assert_eq((SELECT d2_when FROM public.capas WHERE id = c), 'Detected 3 Nov 2026', 'D2 when from the detection date');
  PERFORM pg_temp.assert_eq((SELECT d2_how_many FROM public.capas WHERE id = c), '3 of 10 inspected', 'D2 how many');
  PERFORM pg_temp.assert_eq((SELECT d2_who IS NULL AND d2_why IS NULL AND d2_how IS NULL FROM public.capas WHERE id = c), true, 'who, why and how are left to the team');
  c2 := app.start_capa(org, 'Stand-alone', 'Problem', NULL, NULL, NULL);
  PERFORM pg_temp.assert_eq((SELECT d2_what IS NULL FROM public.capas WHERE id = c2), true, 'a stand-alone 8D starts with an empty D2');

  -- D2 checklist: what, where and when. Edited with the header.
  PERFORM pg_temp.assert_eq(app.capa_step_problems(c, 'd2'), ARRAY[]::text[], 'D2 is ready when started from an NC');
  PERFORM pg_temp.assert_eq(app.capa_step_problems(c2, 'd2'), ARRAY['Say what is wrong (the What of 5W2H)', 'Say where it was found (the Where of 5W2H)', 'Say when it was found (the When of 5W2H)'], 'D2 needs what, where and when');
  UPDATE public.capas SET d2_what = '  Burrs on the bore  ', d2_who = 'Night shift' WHERE id = c2;
  PERFORM pg_temp.assert_eq((SELECT d2_what FROM public.capas WHERE id = c2), '  Burrs on the bore  ', 'values are stored as typed (the API trims)');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.capas SET d2_why = '%s' WHERE id = %L$q$, repeat('x', 2001), c2), 'too long');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.capas SET d2_who = '   ' WHERE id = %L$q$, c2), 'blank is not a value');

  -- Analyses: structured data, a title, removal is a mark, an object only, never deleted.
  INSERT INTO public.capa_analyses (organisation_id, capa_id, kind, title, step, data)
    VALUES (org, c, 'is_is_not', 'Is / Is-Not', 'd2', '{"rows":[{"key":"what","is":"Cracks","isNot":"Dents"}]}') RETURNING id INTO an;
  PERFORM pg_temp.assert_eq((SELECT data -> 'rows' -> 0 ->> 'is' FROM public.capa_analyses WHERE id = an), 'Cracks', 'structured data kept');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.capa_analyses (organisation_id, capa_id, kind, title, step, data) VALUES (%L, %L, 'is_is_not', 'x', 'd2', '[1]')$q$, org, c), 'data must be an object');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.capa_analyses (organisation_id, capa_id, kind, title, step) VALUES (%L, %L, 'swot', 'x', 'd2')$q$, org, c), 'a known kind');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.capa_analyses (organisation_id, capa_id, kind, title, step, data) VALUES (%L, %L, 'is_is_not', 'Big', 'd2', jsonb_build_object('x', repeat('y', 250000)))$q$, org, c), 'size limit');
  PERFORM pg_temp.assert_ok(format($q$UPDATE public.capa_analyses SET title = 'Is / Is-Not (lot 77)', data = '{"rows":[]}' WHERE id = %L$q$, an), 'an analysis can be edited');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.capa_analyses SET kind = 'five_whys' WHERE id = %L$q$, an), 'the kind cannot change');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.capa_analyses SET capa_id = %L WHERE id = %L$q$, c2, an), 'it stays on its 8D');
  PERFORM pg_temp.assert_fails(format($q$DELETE FROM public.capa_analyses WHERE id = %L$q$, an), 'never deleted');
  PERFORM pg_temp.logout();

  -- Permissions: a viewer reads but writes nothing.
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000403');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.capa_analyses), 1::bigint, 'a viewer reads analyses');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.capa_analyses (organisation_id, capa_id, kind, title, step) VALUES (%L, %L, 'is_is_not', 'x', 'd2')$q$, org, c), 'a viewer cannot add an analysis');
  PERFORM pg_temp.assert_eq(pg_temp.affected(format($q$UPDATE public.capa_analyses SET title = 'Hijacked' WHERE id = %L$q$, an)), 0::bigint, 'a viewer edits nothing');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.capa_actions (organisation_id, capa_id, phase, description) VALUES (%L, %L, 'interim', 'x')$q$, org, c), 'a viewer cannot add an action');
  PERFORM pg_temp.logout();

  -- Actions: owner on the team, starts open, stamps by the database, cancel needs a reason, reopening clears the stamps.
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000401');
  SELECT id INTO t_owner FROM public.capa_team_members WHERE capa_id = c AND role = 'leader';
  INSERT INTO public.capa_team_members (organisation_id, capa_id, membership_id, role) VALUES (org, c, m_eng, 'member') RETURNING id INTO t_eng;
  INSERT INTO public.capa_team_members (organisation_id, capa_id, external_name, role) VALUES (org, c, 'Sam Supplier', 'supplier_contact') RETURNING id INTO t_ext;
  INSERT INTO public.capa_actions (organisation_id, capa_id, phase, description, owner_team_member_id, due_date)
    VALUES (org, c, 'interim', 'Quarantine lot 77', t_eng, current_date + 1) RETURNING id INTO act;
  PERFORM pg_temp.assert_eq((SELECT status FROM public.capa_actions WHERE id = act), 'open', 'starts open');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.capa_actions (organisation_id, capa_id, phase, description, status) VALUES (%L, %L, 'interim', 'x', 'done')$q$, org, c), 'cannot start done');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.capa_actions (organisation_id, capa_id, phase, description, owner_team_member_id) VALUES (%L, %L, 'interim', 'x', %L)$q$, org, c, gen_random_uuid()), 'the owner must be on the team');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.capa_actions (organisation_id, capa_id, phase, description, owner_team_member_id) VALUES (%L, %L, 'interim', 'x', %L)$q$, org, c2, t_eng), 'the owner of another 8D is not on this team');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.capa_actions (organisation_id, capa_id, phase, description) VALUES (%L, %L, 'sideways', 'x')$q$, org, c), 'a known phase');
  PERFORM pg_temp.assert_ok(format($q$INSERT INTO public.capa_actions (organisation_id, capa_id, phase, description, done_at, done_by) VALUES (%L, %L, 'interim', 'forged', now(), %L)$q$, org, c, '3f000000-0000-0000-0000-000000000402'), 'a forged done stamp on insert is accepted but discarded');
  PERFORM pg_temp.assert_eq((SELECT (status, done_at IS NULL, done_by IS NULL)::text FROM public.capa_actions WHERE capa_id = c AND description = 'forged'), '(open,t,t)', 'the forged stamp is gone');
  UPDATE public.capa_actions SET status = 'cancelled', cancel_reason = 'Test row' WHERE capa_id = c AND description = 'forged';
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.capa_actions SET status = 'cancelled' WHERE id = %L$q$, act), 'cancelling needs a reason');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.capa_actions SET done_at = now() - interval '1 year' WHERE id = %L$q$, act), 'the done stamp is not editable');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.capa_actions SET phase = 'corrective' WHERE id = %L$q$, act), 'the phase cannot change');
  PERFORM pg_temp.assert_ok(format($q$UPDATE public.capa_actions SET owner_team_member_id = %L, description = 'Quarantine lot 77 and 78' WHERE id = %L$q$, t_ext, act), 'an external contact can own an action');

  -- A person who owns an open action cannot leave the team.
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.capa_team_members SET ended_at = now() WHERE id = %L$q$, t_ext), 'an owner of open actions cannot leave');
  UPDATE public.capa_actions SET status = 'done', evidence_note = 'Lot 77 and 78 in the quarantine cage' WHERE id = act;
  PERFORM pg_temp.assert_eq((SELECT (status, done_at IS NOT NULL, done_by IS NOT NULL, evidence_note)::text FROM public.capa_actions WHERE id = act), '(done,t,t,"Lot 77 and 78 in the quarantine cage")', 'done is stamped by the database');
  PERFORM pg_temp.assert_ok(format($q$UPDATE public.capa_team_members SET ended_at = now() WHERE id = %L$q$, t_ext), 'once the action is done the person can leave');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.capa_actions (organisation_id, capa_id, phase, description, owner_team_member_id) VALUES (%L, %L, 'interim', 'x', %L)$q$, org, c, t_ext), 'and cannot be given a new action');

  UPDATE public.capa_actions SET status = 'open' WHERE id = act;
  PERFORM pg_temp.assert_eq((SELECT (done_at IS NULL, done_by IS NULL)::text FROM public.capa_actions WHERE id = act), '(t,t)', 'reopening clears the stamps');
  UPDATE public.capa_actions SET status = 'cancelled', cancel_reason = '  Customer has the parts already  ' WHERE id = act;
  PERFORM pg_temp.assert_eq((SELECT (status, cancel_reason)::text FROM public.capa_actions WHERE id = act), '(cancelled,"  Customer has the parts already  ")', 'cancelled with its reason');
  PERFORM pg_temp.assert_fails(format($q$DELETE FROM public.capa_actions WHERE id = %L$q$, act), 'never deleted');

  -- D3 checklist: open actions block, and with none done a reason is needed; nothing locks when the step is complete.
  INSERT INTO public.capa_actions (organisation_id, capa_id, phase, description, owner_team_member_id) VALUES (org, c, 'interim', '100% sort at goods-in', t_eng) RETURNING id INTO act2;
  PERFORM pg_temp.assert_eq(app.capa_step_problems(c, 'd3'), ARRAY['Finish or cancel the 1 open containment action', 'Add an interim containment action, or say why none is needed'], 'one open action and none done');
  UPDATE public.capa_actions SET status = 'done', evidence_note = '1,200 sorted, 3 rejected' WHERE id = act2;
  PERFORM pg_temp.assert_eq(app.capa_step_problems(c, 'd3'), ARRAY[]::text[], 'D3 is ready when an action is done and none is open');
  INSERT INTO public.capa_actions (organisation_id, capa_id, phase, description) VALUES (org, c, 'interim', 'Check the customer''s stock') RETURNING id INTO act3;
  PERFORM pg_temp.assert_eq(app.capa_step_problems(c, 'd3'), ARRAY['Finish or cancel the 1 open containment action'], 'a new open action blocks again');
  UPDATE public.capa_actions SET status = 'cancelled', cancel_reason = 'Not needed' WHERE id = act3;
  PERFORM app.capa_complete_step(c, 'd3');
  PERFORM pg_temp.assert_ok(format($q$UPDATE public.capa_actions SET description = 'Edited after D3 was completed' WHERE id = %L$q$, act2), 'nothing locks: an action can still be edited after D3 is complete');
  PERFORM pg_temp.assert_ok(format($q$INSERT INTO public.capa_actions (organisation_id, capa_id, phase, description) VALUES (%L, %L, 'interim', 'Added after D3 was completed')$q$, org, c), 'or added');
  PERFORM app.capa_complete_step(c, 'd2');
  PERFORM pg_temp.assert_ok(format($q$UPDATE public.capas SET d2_why = 'Edited after D2 was completed' WHERE id = %L$q$, c), 'and D2 can still be edited after it is complete');
  PERFORM pg_temp.assert_ok(format($q$UPDATE public.capa_analyses SET title = 'Edited after D2 was completed' WHERE id = %L$q$, an), 'and so can its analyses');

  -- No containment needed: a reason instead of actions.
  PERFORM pg_temp.assert_eq(app.capa_step_problems(c2, 'd3'), ARRAY['Add an interim containment action, or say why none is needed'], 'nothing yet');
  UPDATE public.capas SET d3_no_containment_reason = 'No product has left the plant' WHERE id = c2;
  PERFORM pg_temp.assert_eq(app.capa_step_problems(c2, 'd3'), ARRAY[]::text[], 'a reason is enough');

  -- Removing an analysis marks it; it stays removed and cannot be edited.
  UPDATE public.capa_analyses SET deleted_at = now() WHERE id = an;
  PERFORM pg_temp.assert_eq((SELECT (deleted_at IS NOT NULL, deleted_by IS NOT NULL)::text FROM public.capa_analyses WHERE id = an), '(t,t)', 'removal is stamped');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.capa_analyses SET deleted_at = NULL WHERE id = %L$q$, an), 'it stays removed');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.capa_analyses SET title = 'Back from the dead' WHERE id = %L$q$, an), 'and cannot be edited');

  -- A cancelled 8D keeps everything and accepts nothing until reopened.
  PERFORM app.cancel_capa(c2, 'Raised twice');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.capa_actions (organisation_id, capa_id, phase, description) VALUES (%L, %L, 'interim', 'x')$q$, org, c2), 'no actions on a cancelled 8D');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.capa_analyses (organisation_id, capa_id, kind, title, step) VALUES (%L, %L, 'is_is_not', 'x', 'd2')$q$, org, c2), 'no analyses on a cancelled 8D');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.capas SET d2_what = 'Edited while cancelled' WHERE id = %L$q$, c2), 'no D2 changes on a cancelled 8D');
  PERFORM pg_temp.logout();

  -- Isolation.
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000404');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.capa_analyses), 0::bigint, 'isolation: analyses');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.capa_actions), 0::bigint, 'isolation: actions');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.capa_actions (organisation_id, capa_id, phase, description) VALUES (%L, %L, 'interim', 'x')$q$, org, c), 'isolation: cannot add an action to another organisation''s 8D');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.capa_actions (organisation_id, capa_id, phase, description) VALUES (%L, %L, 'interim', 'x')$q$, org2, c), 'isolation: nor by claiming the organisation');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
