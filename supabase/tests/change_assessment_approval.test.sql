-- Change management CH2: submitting, the impact assessment, the board, sign-offs and rounds, approval, the cut-in point, the customer approval record,
-- recall and cancel, the raiser's rule, notices, tenancy.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('4d000000-0000-0000-0000-000000000c01', 'ann@ch2.test'), ('4d000000-0000-0000-0000-000000000c02', 'bob@ch2.test'),
  ('4d000000-0000-0000-0000-000000000c03', 'eve@ch2.test'), ('4d000000-0000-0000-0000-000000000c04', 'cat@ch2.test'),
  ('4d000000-0000-0000-0000-000000000c05', 'dan@ch2.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '4d000000-0000-0000-0000-000000000c01'; bob uuid := '4d000000-0000-0000-0000-000000000c02';
  eve uuid := '4d000000-0000-0000-0000-000000000c03'; cat uuid := '4d000000-0000-0000-0000-000000000c04'; dan uuid := '4d000000-0000-0000-0000-000000000c05';
  org uuid; org2 uuid; t_proc uuid; t_tool uuid; f_quality uuid; f_eng uuid; part uuid; c1 uuid; c2 uuid; c3 uuid; c4 uuid; r text; u uuid; s_ann uuid; s_dan uuid; a_design uuid;
  n bigint; lot uuid; ord uuid;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('CH2 Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('CH2 Beta'); PERFORM pg_temp.logout();
  FOREACH u IN ARRAY ARRAY[bob, cat, dan] LOOP
    INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u, 'active');
  END LOOP;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = CASE ou.user_id WHEN cat THEN 'quality_engineer' WHEN dan THEN 'quality_manager' ELSE 'viewer' END)
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id IN (bob, cat, dan);
  SELECT id INTO t_proc FROM public.change_types WHERE organisation_id = org AND key = 'process';
  SELECT id INTO t_tool FROM public.change_types WHERE organisation_id = org AND key = 'tooling';
  SELECT id INTO f_quality FROM public.change_functions WHERE organisation_id = org AND key = 'quality';
  SELECT id INTO f_eng FROM public.change_functions WHERE organisation_id = org AND key = 'engineering';
  SELECT id INTO a_design FROM public.change_areas WHERE organisation_id = org AND key = 'design';
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'CH2-P1', 'Bracket') RETURNING id INTO part;

  -- ---- submitting ----
  PERFORM pg_temp.login(cat);
  c1 := app.create_change(org, jsonb_build_object('title', 'Move bracket', 'typeId', t_proc));
  PERFORM pg_temp.assert_eq(app.change_problems(c1, 'submit'), ARRAY['Say what is changing', 'Say why', 'Say what it covers (parts, machines, suppliers…)'], 'a draft names what is missing');
  r := pg_temp.fails(format('SELECT app.submit_change(%L)', c1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'an incomplete draft cannot be submitted');
  PERFORM app.update_change(c1, '{"description":"Run it on machine 7","reason":"Capacity"}'::jsonb);
  PERFORM app.set_change_links(c1, jsonb_build_array(jsonb_build_object('kind', 'part', 'id', part)));
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(bob);
  r := pg_temp.fails(format('SELECT app.submit_change(%L)', c1));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a viewer cannot submit');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  PERFORM app.submit_change(c1);
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.change_requests WHERE id = c1), 'assessment', 'it is in assessment');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.change_impacts WHERE change_id = c1), 12::bigint, 'a row per area');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.change_impacts WHERE change_id = c1 AND status = 'not_assessed'), 12::bigint, 'all not assessed');
  r := pg_temp.fails(format('SELECT app.submit_change(%L)', c1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'only a draft can be submitted');
  -- wording stays editable in assessment, the type does not
  PERFORM app.update_change(c1, '{"title":"Move bracket to CNC 7"}'::jsonb);
  r := pg_temp.fails(format($f$SELECT app.update_change(%L, jsonb_build_object('typeId', %L))$f$, c1, t_tool));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'the type is fixed once it leaves draft');
  PERFORM app.set_change_links(c1, jsonb_build_array(jsonb_build_object('kind', 'part', 'id', part), jsonb_build_object('kind', 'operation_code', 'code', 'OP10')));
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.change_links WHERE change_id = c1), 2::bigint, 'the scope still changes in assessment');

  -- ---- impacts ----
  r := pg_temp.fails(format('SELECT app.set_change_impact(%L, %L, ''affected'', NULL)', c1, a_design));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'an affected area needs a note');
  r := pg_temp.fails(format('SELECT app.set_change_impact(%L, %L, ''maybe'', NULL)', c1, a_design));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'an area is affected or not');
  r := pg_temp.fails(format('SELECT app.set_change_impact(%L, gen_random_uuid(), ''not_affected'', NULL)', c1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'an area outside the assessment is refused');
  PERFORM app.set_change_impact(c1, a_design, 'affected', 'Drawing gets a new note');
  PERFORM pg_temp.assert_eq((SELECT assessed_by FROM public.change_impacts WHERE change_id = c1 AND area_id = a_design), cat, 'who assessed it is kept');
  PERFORM pg_temp.assert_eq(array_length(app.change_problems(c1, 'board'), 1) > 0, true, 'the board is not open yet');
  PERFORM pg_temp.assert_eq((app.change_problems(c1, 'board'))[1], '11 impact areas still to assess', 'it counts what is left');
  PERFORM app.set_change_impact(c1, ia.area_id, 'not_affected', NULL) FROM public.change_impacts ia WHERE ia.change_id = c1 AND ia.status = 'not_assessed';
  PERFORM app.set_change_impact(c1, a_design, 'not_assessed', NULL);
  PERFORM pg_temp.assert_eq((SELECT status FROM public.change_impacts WHERE change_id = c1 AND area_id = a_design), 'not_assessed', 'an answer can be taken back');
  PERFORM app.set_change_impact(c1, a_design, 'affected', 'Drawing gets a new note');
  PERFORM pg_temp.logout();
  r := pg_temp.fails(format('DELETE FROM public.change_impacts WHERE change_id = %L', c1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'nobody deletes an impact, even with SQL');

  -- ---- the board and sending it ----
  PERFORM pg_temp.login(cat);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.change_signer_candidates(org) WHERE can_approve), 3::bigint, 'ann, cat and dan can sign; bob cannot');
  r := pg_temp.fails(format($f$SELECT app.set_change_board(%L, jsonb_build_array(jsonb_build_object('functionId', %L, 'signerId', %L)))$f$, c1, f_quality, bob));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'a viewer cannot be put on the board');
  r := pg_temp.fails(format($f$SELECT app.set_change_board(%L, jsonb_build_array(jsonb_build_object('functionId', %L, 'signerId', %L), jsonb_build_object('functionId', %L, 'signerId', %L)))$f$, c1, f_quality, dan, f_quality, ann));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'a function appears once');
  r := pg_temp.fails(format($f$SELECT app.set_change_board(%L, jsonb_build_array(jsonb_build_object('functionId', %L, 'signerId', %L)))$f$, c1, f_quality, eve));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'a stranger cannot be put on the board');
  r := pg_temp.fails(format('SELECT app.send_change_to_board(%L)', c1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'no board, no sending');
  -- the raiser is on the board
  PERFORM app.set_change_board(c1, jsonb_build_array(jsonb_build_object('functionId', f_quality, 'signerId', dan), jsonb_build_object('functionId', f_eng, 'signerId', cat)));
  PERFORM pg_temp.assert_eq((array_to_string(app.change_problems(c1, 'board'), ' | ') LIKE '%raised this change%'), true, 'the raiser may not sign their own change');
  PERFORM app.set_change_board(c1, jsonb_build_array(jsonb_build_object('functionId', f_quality, 'signerId', dan), jsonb_build_object('functionId', f_eng, 'signerId', ann)));
  PERFORM pg_temp.assert_eq((array_to_string(app.change_problems(c1, 'board'), ' | ') LIKE '%Say whether the customer%'), true, 'a process change must say about the customer');
  r := pg_temp.fails(format('SELECT app.send_change_to_board(%L)', c1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'so it cannot be sent');
  PERFORM app.set_change_customer_approval(c1, 'not_needed');
  PERFORM pg_temp.assert_eq(app.change_problems(c1, 'board'), ARRAY[]::text[], 'nothing is left in the way');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(bob);
  r := pg_temp.fails(format('SELECT app.send_change_to_board(%L)', c1));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a viewer cannot send it');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  PERFORM app.send_change_to_board(c1);
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.change_requests WHERE id = c1), 'approval', 'it is with the board');
  PERFORM pg_temp.assert_eq((SELECT review_round FROM public.change_requests WHERE id = c1), 1, 'round one');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.change_signoffs WHERE change_id = c1 AND round = 1 AND status = 'pending'), 2::bigint, 'one pending sign-off per function');
  SELECT id INTO s_ann FROM public.change_signoffs WHERE change_id = c1 AND round = 1 AND signer_user_id = ann;
  SELECT id INTO s_dan FROM public.change_signoffs WHERE change_id = c1 AND round = 1 AND signer_user_id = dan;
  r := pg_temp.fails(format('SELECT app.update_change(%L, ''{"title":"Too late"}''::jsonb)', c1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'the wording is closed once it has been to the board');
  r := pg_temp.fails(format($f$SELECT app.set_change_impact(%L, %L, 'not_affected', NULL)$f$, c1, a_design));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'the assessment is closed too');
  PERFORM pg_temp.logout();

  -- ---- deciding ----
  PERFORM pg_temp.login(cat);
  r := pg_temp.fails(format('SELECT app.decide_change_signoff(%L, true, NULL)', s_ann));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a sign-off is for its own signer');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ann);
  PERFORM app.decide_change_signoff(s_ann, true, 'Drawing agreed');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.change_signoffs WHERE id = s_ann), 'approved', 'it is approved');
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.change_requests WHERE id = c1), 'approval', 'one is not all');
  r := pg_temp.fails(format('SELECT app.decide_change_signoff(%L, true, NULL)', s_ann));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'a decided sign-off cannot be decided again');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(dan);
  r := pg_temp.fails(format('SELECT app.decide_change_signoff(%L, false, NULL)', s_dan));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'a rejection needs a comment');
  PERFORM app.decide_change_signoff(s_dan, false, 'Needs a control plan change first');
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.change_requests WHERE id = c1), 'assessment', 'a rejection sends it back');
  PERFORM pg_temp.assert_eq((SELECT return_reason FROM public.change_requests WHERE id = c1), 'Quality: Needs a control plan change first', 'with the reason and the function');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.change_signoffs WHERE id = s_dan), 'rejected', 'the sign-off is rejected');
  PERFORM pg_temp.logout();
  r := pg_temp.fails(format('UPDATE public.change_signoffs SET status = ''approved'' WHERE id = %L', s_dan));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'a decided sign-off is frozen even for SQL');
  r := pg_temp.fails(format('DELETE FROM public.change_signoffs WHERE id = %L', s_dan));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'nor deleted');

  -- round two
  PERFORM pg_temp.login(cat);
  PERFORM app.send_change_to_board(c1);
  PERFORM pg_temp.assert_eq((SELECT review_round FROM public.change_requests WHERE id = c1), 2, 'round two asks everyone again');
  PERFORM pg_temp.assert_eq((SELECT return_reason IS NULL FROM public.change_requests WHERE id = c1), true, 'the return reason is cleared');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.change_signoffs WHERE change_id = c1 AND round = 2 AND status = 'pending'), 2::bigint, 'two new sign-offs');
  SELECT id INTO s_ann FROM public.change_signoffs WHERE change_id = c1 AND round = 2 AND signer_user_id = ann;
  SELECT id INTO s_dan FROM public.change_signoffs WHERE change_id = c1 AND round = 2 AND signer_user_id = dan;
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ann); PERFORM app.decide_change_signoff(s_ann, true, NULL); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(dan); PERFORM app.decide_change_signoff(s_dan, true, 'Control plan updated'); PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.change_requests WHERE id = c1), 'approved', 'the last approval approves it');
  PERFORM pg_temp.assert_eq((SELECT approved_by FROM public.change_requests WHERE id = c1), dan, 'who approved it is kept');
  PERFORM pg_temp.assert_eq((SELECT approved_at IS NOT NULL FROM public.change_requests WHERE id = c1), true, 'and when');

  -- ---- notices ----
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.notifications WHERE entity_type = 'change_signoffs' AND recipient_user_id = ann), 2::bigint, 'ann was asked twice');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.notifications WHERE entity_type = 'change_signoffs' AND recipient_user_id = dan), 2::bigint, 'dan was asked twice');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.notifications WHERE entity_type = 'change_signoffs' AND recipient_user_id = cat), 0::bigint, 'the person who sent it is not told');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.notifications WHERE entity_type = 'change_requests' AND recipient_user_id = cat), 2::bigint, 'the raiser is told it was sent back and approved');
  PERFORM pg_temp.assert_eq((SELECT bool_and(details ? 'change_id') FROM public.notifications WHERE entity_type IN ('change_signoffs', 'change_requests')), true, 'every notice names the change');
  PERFORM pg_temp.assert_eq((SELECT body FROM public.notifications WHERE entity_type = 'change_requests' AND recipient_user_id = cat ORDER BY created_at LIMIT 1), 'ECR-' || lpad((extract(year FROM current_date)::integer % 100)::text, 2, '0') || '-0001 · Move bracket to CNC 7 — Sent back to assessment: Quality: Needs a control plan change first', 'the notice says what happened');

  -- ---- after approval: cut-in point and the customer's approval ----
  PERFORM pg_temp.login(cat);
  r := pg_temp.fails(format($f$SELECT app.set_change_cut_in(%L, '{"kind":"banana"}'::jsonb)$f$, c1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'a cut-in point is none, date, order, lot or serial');
  r := pg_temp.fails(format($f$SELECT app.set_change_cut_in(%L, '{"kind":"date"}'::jsonb)$f$, c1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'a date is needed');
  r := pg_temp.fails(format($f$SELECT app.set_change_cut_in(%L, '{"kind":"lot","lotId":"00000000-0000-0000-0000-0000000000aa"}'::jsonb)$f$, c1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'a lot that is not there is refused');
  PERFORM app.set_change_cut_in(c1, '{"kind":"date","date":"2026-12-01","stockAction":"use_up","stockNote":"Finish the batch on the old fixture"}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT cut_in_date::text FROM public.change_requests WHERE id = c1), '2026-12-01', 'the date is kept');
  PERFORM app.set_change_cut_in(c1, '{"kind":"none"}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT cut_in_date IS NULL AND cut_in_kind = 'none' FROM public.change_requests WHERE id = c1), true, 'a different kind drops the old value');
  PERFORM pg_temp.assert_eq((SELECT stock_action FROM public.change_requests WHERE id = c1), 'use_up', 'what happens to stock is kept');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(dan);
  PERFORM app.set_change_cut_in(c1, '{"kind":"date","date":"2026-12-15"}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT cut_in_date::text FROM public.change_requests WHERE id = c1), '2026-12-15', 'a signer of the round may set it');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(bob);
  r := pg_temp.fails(format($f$SELECT app.set_change_cut_in(%L, '{"kind":"none"}'::jsonb)$f$, c1));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a viewer cannot');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  r := pg_temp.fails(format('SELECT app.set_change_customer_approval(%L, ''waived'', NULL, NULL, ''short'')', c1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'a waiver needs a proper reason');
  r := pg_temp.fails(format('SELECT app.set_change_customer_approval(%L, ''approved'', ''PO-1'', current_date + 3, NULL)', c1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'not in the future');
  PERFORM app.set_change_customer_approval(c1, 'approved', 'ACME-ECN-77');
  PERFORM pg_temp.assert_eq((SELECT customer_approval_on FROM public.change_requests WHERE id = c1), current_date, 'approved is dated today by default');
  PERFORM app.set_change_customer_approval(c1, 'waived', NULL, NULL, 'Internal change with no effect on form, fit or function');
  PERFORM pg_temp.assert_eq((SELECT customer_approval_on IS NULL AND customer_reference IS NULL FROM public.change_requests WHERE id = c1), true, 'a waiver carries no date or reference');
  PERFORM pg_temp.logout();

  -- ---- recall, cancel during approval ----
  PERFORM pg_temp.login(cat);
  c2 := app.create_change(org, jsonb_build_object('title', 'Recalled', 'typeId', t_tool, 'description', 'x', 'reason', 'y', 'links', jsonb_build_array(jsonb_build_object('kind', 'part', 'id', part))));
  PERFORM app.submit_change(c2);
  PERFORM app.set_change_impact(c2, ia.area_id, 'not_affected', NULL) FROM public.change_impacts ia WHERE ia.change_id = c2;
  PERFORM app.set_change_board(c2, jsonb_build_array(jsonb_build_object('functionId', f_quality, 'signerId', dan)));
  PERFORM app.send_change_to_board(c2);
  r := pg_temp.fails(format('SELECT app.recall_change(%L, ''x'')', c2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'a recall needs a reason');
  PERFORM app.recall_change(c2, 'The signer has left the company');
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.change_requests WHERE id = c2), 'assessment', 'recalled');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.change_signoffs WHERE change_id = c2), 'superseded', 'the pending sign-off is superseded');
  r := pg_temp.fails(format('SELECT app.recall_change(%L, ''again please'')', c2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'only a change with the board can be recalled');
  PERFORM app.send_change_to_board(c2);
  PERFORM app.cancel_change(c2, 'Not going ahead');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.change_signoffs WHERE change_id = c2 AND status = 'superseded'), 2::bigint, 'cancelling supersedes what was waiting');
  PERFORM app.cancel_change(c1, 'Superseded by a new design');
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.change_requests WHERE id = c1), 'cancelled', 'an approved change can still be cancelled');
  PERFORM pg_temp.logout();
  r := pg_temp.fails(format('UPDATE public.change_requests SET stage = ''approval'' WHERE id = %L', c1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'a cancelled change cannot move');
  r := pg_temp.fails(format('UPDATE public.change_requests SET stage = ''closed'' WHERE id = %L', c1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'nor closed');

  -- ---- the raiser signing their own change ----
  PERFORM pg_temp.login(ann);
  c3 := app.create_change(org, jsonb_build_object('title', 'Mine', 'typeId', t_tool, 'description', 'x', 'reason', 'y', 'links', jsonb_build_array(jsonb_build_object('kind', 'part', 'id', part))));
  PERFORM app.submit_change(c3);
  PERFORM app.set_change_impact(c3, ia.area_id, 'not_affected', NULL) FROM public.change_impacts ia WHERE ia.change_id = c3;
  PERFORM app.set_change_board(c3, jsonb_build_array(jsonb_build_object('functionId', f_quality, 'signerId', ann)));
  r := pg_temp.fails(format('SELECT app.send_change_to_board(%L)', c3));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'the organisation has not allowed it');
  PERFORM pg_temp.assert_eq((SELECT change_allow_self_approval FROM public.organisation_settings WHERE organisation_id = org), false, 'off by default');
  UPDATE public.organisation_settings SET change_allow_self_approval = true WHERE organisation_id = org;
  PERFORM app.send_change_to_board(c3);
  SELECT id INTO s_ann FROM public.change_signoffs WHERE change_id = c3;
  UPDATE public.organisation_settings SET change_allow_self_approval = false WHERE organisation_id = org;
  r := pg_temp.fails(format('SELECT app.decide_change_signoff(%L, true, NULL)', s_ann));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'switching it off again stops the signing too');
  UPDATE public.organisation_settings SET change_allow_self_approval = true WHERE organisation_id = org;
  PERFORM app.decide_change_signoff(s_ann, true, NULL);
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.change_requests WHERE id = c3), 'approved', 'allowed, the raiser can approve');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  r := pg_temp.fails(format($f$UPDATE public.organisation_settings SET change_allow_self_approval = true WHERE organisation_id = %L$f$, org));
  PERFORM pg_temp.assert_eq(r, 'ok', 'a quality engineer''s write is stopped by row-level security without an error');
  PERFORM pg_temp.assert_eq((SELECT change_allow_self_approval FROM public.organisation_settings WHERE organisation_id = org), true, 'and nothing changed that was not already so');
  PERFORM pg_temp.logout();

  -- ---- tenancy ----
  PERFORM pg_temp.login(eve);
  r := pg_temp.fails(format('SELECT app.submit_change(%L)', c3));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'another organisation cannot submit');
  r := pg_temp.fails(format('SELECT app.decide_change_signoff(%L, true, NULL)', s_ann));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'nor decide');
  r := pg_temp.fails(format('SELECT app.set_change_cut_in(%L, ''{"kind":"none"}''::jsonb)', c3));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'nor set a cut-in point');
  r := pg_temp.fails(format('SELECT app.change_problems(%L, ''board'')', c3));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'nor read what is missing');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.change_signoffs), 0::bigint, 'the sign-offs are invisible');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.change_impacts), 0::bigint, 'so are the impacts');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.change_board), 0::bigint, 'and the board');
  PERFORM pg_temp.logout();
  RAISE NOTICE 'change assessment and approval: ok';
END $$;
ROLLBACK;
