-- FMEA FM5c-3: a risk can name an FMEA cause and be raised from one; a change task can change an FMEA revision and is finished only once that revision is in force.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('4f000000-0000-0000-0000-000000000e01', 'ann@frc.test'), ('4f000000-0000-0000-0000-000000000e02', 'bob@frc.test'),
  ('4f000000-0000-0000-0000-000000000e03', 'eve@frc.test'), ('4f000000-0000-0000-0000-000000000e04', 'cat@frc.test'),
  ('4f000000-0000-0000-0000-000000000e05', 'dan@frc.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

-- A change taken to the board and approved by its signer (self-approval is on), as the person logged in at the time of the call.
CREATE FUNCTION pg_temp.approved_change(p_org uuid, p_raiser uuid, p_signer uuid, p_title text, p_part uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE c uuid; s uuid;
BEGIN
  PERFORM pg_temp.login(p_raiser);
  c := app.create_change(p_org, jsonb_build_object('title', p_title, 'typeId', (SELECT id FROM public.change_types WHERE organisation_id = p_org AND key = 'process'),
        'description', 'What', 'reason', 'Why', 'links', jsonb_build_array(jsonb_build_object('kind', 'part', 'id', p_part))));
  PERFORM app.submit_change(c);
  PERFORM app.set_change_impact(c, i.area_id, 'not_affected', NULL) FROM public.change_impacts i WHERE i.change_id = c;
  PERFORM app.set_change_board(c, jsonb_build_array(jsonb_build_object('functionId', (SELECT id FROM public.change_functions WHERE organisation_id = p_org AND key = 'quality'), 'signerId', p_signer)));
  PERFORM app.set_change_customer_approval(c, 'not_needed');
  PERFORM app.send_change_to_board(c);
  PERFORM pg_temp.logout();
  SELECT id INTO s FROM public.change_signoffs WHERE change_id = c AND status = 'pending';
  PERFORM pg_temp.login(p_signer);
  PERFORM app.decide_change_signoff(s, true, NULL);
  PERFORM pg_temp.logout();
  RETURN c;
END $$;

DO $$
DECLARE
  ann uuid := '4f000000-0000-0000-0000-000000000e01'; bob uuid := '4f000000-0000-0000-0000-000000000e02';
  eve uuid := '4f000000-0000-0000-0000-000000000e03'; cat uuid := '4f000000-0000-0000-0000-000000000e04'; dan uuid := '4f000000-0000-0000-0000-000000000e05';
  org uuid; org2 uuid; u uuid; part uuid; mach uuid; f1 uuid; r1 uuid; r2 uuid; cause uuid; cause_other uuid; f_other uuid; r_other uuid;
  risk uuid; risk2 uuid; d jsonb; r text; chg uuid; tsk uuid; cat_id uuid;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('FRC Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('FRC Beta'); PERFORM pg_temp.logout();
  FOREACH u IN ARRAY ARRAY[bob, cat, dan] LOOP
    INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u, 'active');
  END LOOP;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = CASE ou.user_id WHEN cat THEN 'quality_engineer' WHEN dan THEN 'quality_manager' ELSE 'viewer' END)
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id IN (bob, cat, dan);
  UPDATE public.organisation_settings SET change_allow_self_approval = true WHERE organisation_id = org;
  SELECT id INTO cat_id FROM public.risk_categories WHERE organisation_id = org AND key = 'process';

  PERFORM pg_temp.login(ann);
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'FRC-P1', 'Bracket') RETURNING id INTO part;
  INSERT INTO public.machines (organisation_id, code, name) VALUES (org, 'FRC-M1', 'Lathe') RETURNING id INTO mach;
  PERFORM pg_temp.logout();

  -- An FMEA with a net (cat prepares it), and one in the other organisation.
  PERFORM pg_temp.login(cat);
  f1 := app.create_fmea(org, jsonb_build_object('kind', 'process', 'title', 'Machining the bracket',
    'team', jsonb_build_array(jsonb_build_object('userId', cat, 'role', 'lead'), jsonb_build_object('userId', dan, 'role', 'quality')),
    'links', jsonb_build_array(jsonb_build_object('kind', 'part', 'id', part), jsonb_build_object('kind', 'machine', 'id', mach))));
  r1 := (SELECT id FROM public.fmea_revisions WHERE fmea_id = f1);
  PERFORM pg_temp.build_fmea_net(r1);
  cause := (SELECT id FROM public.fmea_causes WHERE revision_id = r1 LIMIT 1);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve);
  f_other := app.create_fmea(org2, jsonb_build_object('kind', 'process', 'title', 'Theirs',
    'team', jsonb_build_array(jsonb_build_object('userId', eve, 'role', 'lead'))));
  r_other := (SELECT id FROM public.fmea_revisions WHERE fmea_id = f_other);
  PERFORM pg_temp.build_fmea_net(r_other);
  cause_other := (SELECT id FROM public.fmea_causes WHERE revision_id = r_other LIMIT 1);
  PERFORM pg_temp.logout();

  -- ---- a risk raised from an FMEA cause ----
  PERFORM pg_temp.login(cat);
  d := app.risk_draft_from('fmea_cause', cause);
  PERFORM pg_temp.assert_eq(d ->> 'title', (SELECT text FROM public.fmea_failure_modes WHERE id = (SELECT failure_mode_id FROM public.fmea_causes WHERE id = cause)), 'the failure mode is the risk''s title');
  PERFORM pg_temp.assert_eq(d ->> 'cause', (SELECT text FROM public.fmea_causes WHERE id = cause), 'the cause is the risk''s cause');
  PERFORM pg_temp.assert_eq((d ->> 'effect') IS NOT NULL, true, 'the effects are the risk''s effect');
  PERFORM pg_temp.assert_eq((SELECT array_agg(x ->> 'kind' ORDER BY x ->> 'kind') FROM jsonb_array_elements(d -> 'links') x), ARRAY['fmea_cause', 'machine', 'part'], 'it suggests the cause, the part and the machine');
  PERFORM pg_temp.assert_eq(d -> 'source' ->> 'kind', 'fmea_cause', 'it names its source');
  PERFORM pg_temp.assert_eq((d ->> 'categoryId')::uuid, cat_id, 'a process FMEA suggests the process category');
  r := pg_temp.fails(format($f$SELECT app.risk_draft_from('fmea_cause', %L)$f$, cause_other));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'another organisation''s cause is not found');
  r := pg_temp.fails($f$SELECT app.risk_draft_from('risk', gen_random_uuid())$f$);
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'a kind that cannot start a risk is refused');

  risk := app.raise_risk_from('fmea_cause', cause, jsonb_build_object('title', d ->> 'title', 'categoryId', d ->> 'categoryId', 'description', d ->> 'description'), d -> 'links');
  PERFORM pg_temp.assert_eq((SELECT origin_kind FROM public.risks WHERE id = risk), 'fmea_cause', 'the risk keeps where it came from');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.risk_links WHERE risk_id = risk AND fmea_cause_id = cause), 1::bigint, 'and is linked to the cause');
  r := pg_temp.fails(format($f$SELECT app.set_risk_links(%L, '[]'::jsonb)$f$, risk));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'the link to its origin cannot be removed');
  PERFORM pg_temp.logout();
  r := pg_temp.fails(format($f$UPDATE public.risks SET origin_id = %L WHERE id = %L$f$, gen_random_uuid(), risk));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'the origin cannot be changed, even by SQL');
  PERFORM pg_temp.login(cat);

  -- ---- a link to a cause on any risk ----
  risk2 := app.create_risk(org, jsonb_build_object('title', 'Tool wear on the lathe', 'categoryId', cat_id));
  PERFORM app.set_risk_links(risk2, jsonb_build_array(jsonb_build_object('kind', 'fmea_cause', 'id', cause), jsonb_build_object('kind', 'fmea_cause', 'id', cause)));
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.risk_links WHERE risk_id = risk2), 1::bigint, 'the same cause is linked once');
  r := pg_temp.fails(format($f$SELECT app.set_risk_links(%L, jsonb_build_array(jsonb_build_object('kind', 'fmea_cause', 'id', %L)))$f$, risk2, cause_other));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'another organisation''s cause cannot be linked');
  r := pg_temp.fails(format($f$SELECT app.set_risk_links(%L, jsonb_build_array(jsonb_build_object('kind', 'fmea_cause')))$f$, risk2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'a link names its record');
  r := pg_temp.fails(format($f$SELECT app.set_risk_links(%L, jsonb_build_array(jsonb_build_object('kind', 'fmea_effect', 'id', gen_random_uuid())))$f$, risk2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'only a cause can be linked, not another part of an FMEA');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(bob);
  r := pg_temp.fails(format($f$SELECT app.risk_draft_from('fmea_cause', %L)$f$, cause));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'a viewer cannot read a draft FMEA''s cause, so cannot raise a risk from it');
  PERFORM pg_temp.logout();

  -- ---- a change task that changes an FMEA revision ----
  PERFORM pg_temp.login(cat);
  PERFORM app.set_fmea_approver(r1, dan);
  PERFORM app.submit_fmea_revision(r1);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(dan);
  PERFORM app.approve_fmea_revision(r1, current_date, NULL);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  r2 := app.start_fmea_revision(f1);
  PERFORM pg_temp.logout();

  chg := pg_temp.approved_change(org, cat, ann, 'Rework the machining FMEA', part);
  PERFORM pg_temp.login(cat);
  tsk := app.add_change_task(chg, jsonb_build_object('description', 'Revise the FMEA', 'ownerId', cat, 'link', jsonb_build_object('kind', 'fmea_revision', 'id', r2)));
  PERFORM pg_temp.assert_eq((SELECT link_kind FROM public.change_tasks WHERE id = tsk), 'fmea_revision', 'the task names the revision');
  PERFORM pg_temp.assert_eq(app.change_task_link_state(tsk), 'pending', 'a draft revision is pending');
  r := pg_temp.fails(format($f$SELECT app.complete_change_task(%L, 'done')$f$, tsk));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'the task cannot be finished while the revision is not in force');
  r := pg_temp.fails(format($f$SELECT app.add_change_task(%L, jsonb_build_object('description', 'Again', 'ownerId', %L, 'link', jsonb_build_object('kind', 'fmea_revision', 'id', %L)))$f$, chg, cat, r2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'one open task per revision');
  r := pg_temp.fails(format($f$SELECT app.add_change_task(%L, jsonb_build_object('description', 'Theirs', 'ownerId', %L, 'link', jsonb_build_object('kind', 'fmea_revision', 'id', %L)))$f$, chg, cat, r_other));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'another organisation''s revision cannot be named');
  PERFORM app.update_fmea_revision(r2, '{"changeSummary":"Reworked after the change"}'::jsonb);
  PERFORM app.set_fmea_approver(r2, dan);
  PERFORM app.submit_fmea_revision(r2);
  PERFORM pg_temp.assert_eq(app.change_task_link_state(tsk), 'pending', 'waiting for approval is still pending');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(dan);
  PERFORM app.approve_fmea_revision(r2, current_date, NULL);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  PERFORM pg_temp.assert_eq(app.change_task_link_state(tsk), 'in_force', 'a revision in force is in force');
  PERFORM app.complete_change_task(tsk, 'Revised and approved');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.change_tasks WHERE id = tsk), 'done', 'now the task can be finished');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
