-- Change management CH3: tasks and the record they change, the stage that follows from them, the effectiveness check and closing, cancelling, notices, tenancy.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('4e000000-0000-0000-0000-000000000c01', 'ann@ch3.test'), ('4e000000-0000-0000-0000-000000000c02', 'bob@ch3.test'),
  ('4e000000-0000-0000-0000-000000000c03', 'eve@ch3.test'), ('4e000000-0000-0000-0000-000000000c04', 'cat@ch3.test'),
  ('4e000000-0000-0000-0000-000000000c05', 'dan@ch3.test');

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
  ann uuid := '4e000000-0000-0000-0000-000000000c01'; bob uuid := '4e000000-0000-0000-0000-000000000c02';
  eve uuid := '4e000000-0000-0000-0000-000000000c03'; cat uuid := '4e000000-0000-0000-0000-000000000c04'; dan uuid := '4e000000-0000-0000-0000-000000000c05';
  org uuid; org2 uuid; part uuid; sup uuid; rev_a uuid; rev_b uuid; c1 uuid; c2 uuid; c3 uuid; c4 uuid; t1 uuid; t2 uuid; t3 uuid; r text; u uuid; a_design uuid;
  nn bigint; ev_before bigint;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('CH3 Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('CH3 Beta'); PERFORM pg_temp.logout();
  FOREACH u IN ARRAY ARRAY[bob, cat, dan] LOOP
    INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u, 'active');
  END LOOP;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = CASE ou.user_id WHEN cat THEN 'quality_engineer' WHEN dan THEN 'quality_manager' ELSE 'viewer' END)
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id IN (bob, cat, dan);
  UPDATE public.organisation_settings SET change_allow_self_approval = true WHERE organisation_id = org;
  SELECT id INTO a_design FROM public.change_areas WHERE organisation_id = org AND key = 'design';
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'CH3-P1', 'Bracket') RETURNING id INTO part;
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'CH3S', 'Steel Co') RETURNING id INTO sup;
  INSERT INTO public.part_revisions (organisation_id, part_id, revision) VALUES (org, part, 'A') RETURNING id INTO rev_a;

  c1 := pg_temp.approved_change(org, cat, ann, 'Bracket drawing', part);
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.change_requests WHERE id = c1), 'approved', 'the change is approved');

  -- ---- adding tasks ----
  PERFORM pg_temp.login(bob);
  r := pg_temp.fails(format($f$SELECT app.add_change_task(%L, jsonb_build_object('description', 'Do it', 'ownerId', %L))$f$, c1, bob));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a viewer cannot add a task');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  r := pg_temp.fails(format($f$SELECT app.add_change_task(%L, jsonb_build_object('description', 'Do', 'ownerId', %L))$f$, c1, bob));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'a task says what to do');
  r := pg_temp.fails(format($f$SELECT app.add_change_task(%L, jsonb_build_object('description', 'Update the drawing'))$f$, c1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'a task says who does it');
  r := pg_temp.fails(format($f$SELECT app.add_change_task(%L, jsonb_build_object('description', 'Update the drawing', 'ownerId', %L))$f$, c1, eve));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'a task goes to a member of the organisation');
  r := pg_temp.fails(format($f$SELECT app.add_change_task(%L, jsonb_build_object('description', 'Update the drawing', 'ownerId', %L, 'areaId', gen_random_uuid()))$f$, c1, bob));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'an area from elsewhere is refused');
  t1 := app.add_change_task(c1, jsonb_build_object('description', 'Release the new drawing revision', 'ownerId', bob, 'dueOn', current_date + 7, 'areaId', a_design,
          'link', jsonb_build_object('kind', 'part_revision', 'id', rev_a)));
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.change_requests WHERE id = c1), 'implementing', 'a task starts the work');
  PERFORM pg_temp.assert_eq((SELECT link_kind FROM public.change_tasks WHERE id = t1), 'part_revision', 'the task points at the revision');
  PERFORM pg_temp.assert_eq(app.change_task_link_state(t1), 'pending', 'a draft revision is not in force');
  r := pg_temp.fails(format($f$SELECT app.add_change_task(%L, jsonb_build_object('description', 'Same record again', 'ownerId', %L, 'link', jsonb_build_object('kind', 'part_revision', 'id', %L)))$f$, c1, bob, rev_a));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'one open task per record');
  r := pg_temp.fails(format($f$SELECT app.add_change_task(%L, jsonb_build_object('description', 'Strange kind', 'ownerId', %L, 'link', jsonb_build_object('kind', 'moon', 'id', %L)))$f$, c1, bob, rev_a));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'an unknown kind of record is refused');
  r := pg_temp.fails(format($f$SELECT app.add_change_task(%L, jsonb_build_object('description', 'Elsewhere', 'ownerId', %L, 'link', jsonb_build_object('kind', 'supplier', 'id', gen_random_uuid())))$f$, c1, bob));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'a record that is not there is refused');
  t2 := app.add_change_task(c1, jsonb_build_object('description', 'Tell the supplier', 'ownerId', cat, 'link', jsonb_build_object('kind', 'supplier', 'id', sup)));
  PERFORM pg_temp.assert_eq(app.change_task_link_state(t2), 'none', 'a supplier has no lifecycle to wait for');
  PERFORM pg_temp.logout();

  -- ---- changing a task ----
  PERFORM pg_temp.login(cat);
  PERFORM app.update_change_task(t2, '{"description":"Tell the supplier about the new drawing","dueOn":null}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT description FROM public.change_tasks WHERE id = t2), 'Tell the supplier about the new drawing', 'the wording changes');
  r := pg_temp.fails(format($f$SELECT app.update_change_task(%L, '{"ownerId":"%s"}'::jsonb)$f$, t2, eve));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'it cannot be handed to a stranger');
  PERFORM app.update_change_task(t2, format('{"ownerId":"%s"}', dan)::jsonb);
  PERFORM pg_temp.assert_eq((SELECT owner_user_id FROM public.change_tasks WHERE id = t2), dan, 'it can be handed over');
  PERFORM app.link_change_task(t2, NULL, NULL);
  PERFORM pg_temp.assert_eq((SELECT link_kind FROM public.change_tasks WHERE id = t2), NULL, 'a link can be taken away');
  PERFORM pg_temp.logout();
  r := pg_temp.fails(format($f$DELETE FROM public.change_tasks WHERE id = %L$f$, t2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'nobody deletes a task, even with SQL');

  -- ---- completing ----
  PERFORM pg_temp.login(dan);
  r := pg_temp.fails(format('SELECT app.complete_change_task(%L, NULL)', t1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'a manager is stopped while the revision is not in force');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(bob);
  r := pg_temp.fails(format('SELECT app.complete_change_task(%L, NULL)', t2));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'only the person it was given to, or a manager, can finish it');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(dan);
  PERFORM app.complete_change_task(t2, 'Told by phone');
  PERFORM pg_temp.assert_eq((SELECT status || '|' || done_by || '|' || result_note FROM public.change_tasks WHERE id = t2), 'done|' || dan || '|Told by phone', 'done stamps who and the note');
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.change_requests WHERE id = c1), 'implementing', 'one task is still open');
  r := pg_temp.fails(format('SELECT app.complete_change_task(%L, NULL)', t2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'a done task is not done again');
  r := pg_temp.fails(format($f$SELECT app.update_change_task(%L, '{"description":"Changed after"}'::jsonb)$f$, t2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'a done task does not change');
  PERFORM pg_temp.logout();
  -- the owner finishes their own task: release the revision first
  PERFORM pg_temp.login(ann);
  UPDATE public.part_revisions SET status = 'released' WHERE id = rev_a;
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq(app.change_task_link_state(t1), 'in_force'::text, 'the revision is in force');
  PERFORM app.complete_change_task(t1, 'Rev A released');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.change_requests WHERE id = c1), 'verifying', 'every task done: waiting for the check');

  -- ---- the stage follows the tasks ----
  PERFORM pg_temp.login(dan);
  PERFORM app.reopen_change_task(t2, 'Told the wrong supplier');
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.change_requests WHERE id = c1), 'implementing', 'reopening a task goes back to implementing');
  PERFORM pg_temp.assert_eq((SELECT status || '|' || coalesce(done_at::text, '-') || '|' || reopen_reason FROM public.change_tasks WHERE id = t2), 'open|-|Told the wrong supplier', 'reopening clears the stamps and keeps why');
  PERFORM app.cancel_change_task(t2, 'Not needed after all');
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.change_requests WHERE id = c1), 'verifying', 'a cancelled task does not hold it up');
  r := pg_temp.fails(format('SELECT app.reopen_change_task(%L, ''Try again'')', t2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'a cancelled task stays cancelled');
  t3 := app.add_change_task(c1, jsonb_build_object('description', 'Retrain the operators', 'ownerId', cat));
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.change_requests WHERE id = c1), 'implementing', 'a new task goes back to implementing');
  r := pg_temp.fails(format($f$SELECT app.cancel_change_task(%L, 'x')$f$, t3));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'cancelling needs a reason');
  PERFORM app.cancel_change_task(t3, 'Handled by induction');
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.change_requests WHERE id = c1), 'verifying', 'back to the check');
  PERFORM pg_temp.logout();
  -- ---- notices ----
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.notifications WHERE entity_type = 'change_tasks' AND recipient_user_id = bob), 1::bigint, 'bob was given a task');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.notifications WHERE entity_type = 'change_tasks' AND recipient_user_id = cat), 1::bigint, 'cat was given a task by someone else (t3 is by cat to cat: no notice)');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.notifications WHERE entity_type = 'change_tasks' AND recipient_user_id = dan), 1::bigint, 'dan was handed a task');
  PERFORM pg_temp.assert_eq((SELECT bool_and(details ? 'change_id') FROM public.notifications WHERE entity_type = 'change_tasks'), true, 'every task notice names the change');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.notifications WHERE entity_type = 'change_requests' AND recipient_user_id = cat), 1::bigint,
    'the raiser is told of the board''s approval once: the stage moving with the tasks is not news');

  -- ---- the effectiveness check ----
  PERFORM pg_temp.login(bob);
  r := pg_temp.fails(format($f$SELECT app.record_change_review(%L, true, 'Looks fine to me')$f$, c1));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a viewer cannot close a change');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  r := pg_temp.fails(format($f$SELECT app.record_change_review(%L, true, 'x')$f$, c1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'the check needs a note');
  PERFORM app.record_change_review(c1, false, 'Still seeing burrs on the bracket');
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.change_requests WHERE id = c1), 'implementing', 'not effective sends it back');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.change_reviews WHERE change_id = c1 AND result = 'not_effective'), 1::bigint, 'the finding is kept');
  r := pg_temp.fails(format($f$SELECT app.record_change_review(%L, true, 'Burrs gone')$f$, c1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'it must be verifying to be checked');
  t3 := app.add_change_task(c1, jsonb_build_object('description', 'Add deburring to the control plan', 'ownerId', cat));
  PERFORM app.complete_change_task(t3, NULL);
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.change_requests WHERE id = c1), 'verifying', 'the new task is done: checking again');
  -- the customer's answer is in the way until it is given
  PERFORM app.set_change_customer_approval(c1, 'required');
  PERFORM pg_temp.assert_eq((array_to_string(app.change_problems(c1, 'close'), ' | ') LIKE '%customer has not approved%'), true, 'the customer is named as the problem');
  r := pg_temp.fails(format($f$SELECT app.record_change_review(%L, true, 'Burrs gone in three lots')$f$, c1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'closing waits for the customer');
  PERFORM app.set_change_customer_approval(c1, 'approved', 'CUST-77', current_date);
  PERFORM pg_temp.assert_eq(app.change_problems(c1, 'close'), ARRAY[]::text[], 'nothing is in the way');
  PERFORM app.record_change_review(c1, true, 'No burrs in the last three lots');
  PERFORM pg_temp.assert_eq((SELECT stage || '|' || closed_by FROM public.change_requests WHERE id = c1), 'closed|' || cat, 'closed, and by whom');
  PERFORM pg_temp.assert_eq((SELECT closed_at IS NOT NULL FROM public.change_requests WHERE id = c1), true, 'and when');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.change_reviews WHERE change_id = c1), 2::bigint, 'both findings are kept');
  r := pg_temp.fails(format($f$SELECT app.add_change_task(%L, jsonb_build_object('description', 'Too late', 'ownerId', %L))$f$, c1, cat));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'a closed change takes no more tasks');
  r := pg_temp.fails(format($f$SELECT app.reopen_change_task(%L, 'Reopen after close')$f$, t3));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'nor does it reopen one');
  r := pg_temp.fails(format($f$SELECT app.cancel_change(%L, 'Cancel after close')$f$, c1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'a closed change cannot be cancelled');
  PERFORM pg_temp.logout();
  r := pg_temp.fails(format($f$UPDATE public.change_reviews SET note = 'Changed' WHERE change_id = %L$f$, c1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'a review never changes, even with SQL');
  r := pg_temp.fails(format($f$DELETE FROM public.change_reviews WHERE change_id = %L$f$, c1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'nor is it deleted');
  r := pg_temp.fails(format($f$UPDATE public.change_requests SET stage = 'implementing', closed_at = NULL WHERE id = %L$f$, c1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'a closed change stays closed');

  -- ---- a revision no longer in force stops the close ----
  c3 := pg_temp.approved_change(org, cat, ann, 'Bracket rev B', part);
  PERFORM pg_temp.login(ann);
  INSERT INTO public.part_revisions (organisation_id, part_id, revision) VALUES (org, part, 'B') RETURNING id INTO rev_b;
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  t1 := app.add_change_task(c3, jsonb_build_object('description', 'Release rev B', 'ownerId', cat, 'link', jsonb_build_object('kind', 'part_revision', 'id', rev_b)));
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ann);
  UPDATE public.part_revisions SET status = 'released' WHERE id = rev_b;
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  PERFORM app.complete_change_task(t1, NULL);
  PERFORM pg_temp.assert_eq(app.change_problems(c3, 'close'), ARRAY[]::text[], 'in force: nothing in the way');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ann);
  UPDATE public.part_revisions SET status = 'obsolete' WHERE id = rev_b;
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  PERFORM pg_temp.assert_eq((array_to_string(app.change_problems(c3, 'close'), ' | ') LIKE '%not in force%'), true, 'a revision retired since is named');
  r := pg_temp.fails(format($f$SELECT app.record_change_review(%L, true, 'Checked and fine')$f$, c3));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'so it cannot close');
  PERFORM pg_temp.logout();

  -- ---- cancelling a change cancels its open tasks ----
  c4 := pg_temp.approved_change(org, cat, ann, 'To be cancelled', part);
  PERFORM pg_temp.login(cat);
  t1 := app.add_change_task(c4, jsonb_build_object('description', 'Open task one', 'ownerId', bob));
  t2 := app.add_change_task(c4, jsonb_build_object('description', 'Task two, done', 'ownerId', cat));
  PERFORM app.complete_change_task(t2, NULL);
  PERFORM app.cancel_change(c4, 'Superseded by another change');
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.change_requests WHERE id = c4), 'cancelled', 'the change is cancelled');
  PERFORM pg_temp.assert_eq((SELECT status || '|' || cancel_reason FROM public.change_tasks WHERE id = t1), 'cancelled|The change was cancelled', 'its open task is cancelled');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.change_tasks WHERE id = t2), 'done', 'a done task stays done');
  PERFORM pg_temp.logout();

  -- ---- tenancy ----
  PERFORM pg_temp.login(eve);
  r := pg_temp.fails(format($f$SELECT app.add_change_task(%L, jsonb_build_object('description', 'Not mine', 'ownerId', %L))$f$, c3, eve));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'another organisation cannot add a task');
  r := pg_temp.fails(format('SELECT app.complete_change_task(%L, NULL)', t1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'nor complete one');
  r := pg_temp.fails(format('SELECT app.record_change_review(%L, true, ''Not my change'')', c3));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'nor check a change');
  PERFORM pg_temp.assert_eq(app.change_task_link_state(t1) IS NULL, true, 'nor read where a task''s record stands');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.change_tasks), 0::bigint, 'the tasks are invisible');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.change_reviews), 0::bigint, 'and the reviews');
  PERFORM pg_temp.logout();
  RAISE NOTICE 'change tasks and closing: ok';
END $$;
ROLLBACK;
