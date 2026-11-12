-- Risk register RK2: treatment, actions, residual assessments, acceptance by someone else, the worked-out status, reviews and review dates, closing and reopening.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('4c000000-0000-0000-0000-000000000c01', 'ann@rk2.test'), ('4c000000-0000-0000-0000-000000000c02', 'bob@rk2.test'),
  ('4c000000-0000-0000-0000-000000000c03', 'eve@rk2.test'), ('4c000000-0000-0000-0000-000000000c04', 'cat@rk2.test'),
  ('4c000000-0000-0000-0000-000000000c05', 'dan@rk2.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;
CREATE FUNCTION pg_temp.st(p uuid) RETURNS text LANGUAGE sql AS $$ SELECT status FROM public.risks WHERE id = p $$;

DO $$
DECLARE
  ann uuid := '4c000000-0000-0000-0000-000000000c01'; bob uuid := '4c000000-0000-0000-0000-000000000c02'; eve uuid := '4c000000-0000-0000-0000-000000000c03';
  cat uuid := '4c000000-0000-0000-0000-000000000c04'; dan uuid := '4c000000-0000-0000-0000-000000000c05';
  org uuid; org2 uuid; c uuid; k uuid; k2 uuid; opp uuid; a1 uuid; a2 uuid; acc uuid; acc2 uuid; rv uuid; r text; u uuid;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('RK2 Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('RK2 Beta'); PERFORM pg_temp.logout();
  -- Bob: viewer. Cat: quality engineer (manages, cannot approve). Dan: quality manager (approves).
  FOREACH u IN ARRAY ARRAY[bob, cat, dan] LOOP INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u, 'active'); END LOOP;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = CASE ou.user_id WHEN cat THEN 'quality_engineer' WHEN dan THEN 'quality_manager' ELSE 'viewer' END)
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id IN (bob, cat, dan);

  PERFORM pg_temp.login(cat);
  SELECT id INTO c FROM public.risk_categories WHERE organisation_id = org AND key = 'process';
  k := app.create_risk(org, jsonb_build_object('categoryId', c, 'title', 'Single-source casting supplier'));

  -- ---- nothing before it is assessed ----
  r := pg_temp.fails(format('SELECT app.set_risk_treatment(%L, %L, NULL)', k, 'mitigate'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'no treatment before the risk is assessed');
  r := pg_temp.fails(format('SELECT app.assess_risk(%L, 2, 2, %L, %L)', k, 'after', 'residual'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'no residual assessment before an inherent one');
  PERFORM pg_temp.assert_eq(app.risk_treatment_problems(k), ARRAY['Assess the risk'], 'a draft needs assessing');

  -- ---- assessed: open, with a review date from its band (high = 3 months) ----
  a1 := app.assess_risk(k, 4, 4, 'One foundry, long lead time');
  PERFORM pg_temp.assert_eq(pg_temp.st(k), 'open', 'assessed, no strategy yet: open');
  PERFORM pg_temp.assert_eq((SELECT next_review_on FROM public.risks WHERE id = k), (current_date + interval '3 months')::date, 'a high risk is reviewed in three months');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.risk_reviews WHERE risk_id = k), 0::bigint, 'the first assessment is not a review');
  PERFORM pg_temp.assert_eq(app.risk_treatment_problems(k), ARRAY['Choose what will be done about the risk'], 'what is needed next');

  -- ---- treatment ----
  r := pg_temp.fails(format('SELECT app.set_risk_treatment(%L, %L, NULL)', k, 'exploit'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'only an opportunity is exploited');
  PERFORM app.set_risk_treatment(k, 'mitigate', ' Qualify a second foundry ');
  PERFORM pg_temp.assert_eq((SELECT strategy || '/' || treatment_plan || '/' || status FROM public.risks WHERE id = k), 'mitigate/Qualify a second foundry/treating', 'a strategy makes it treating');

  -- ---- actions ----
  r := pg_temp.fails(format($f$SELECT app.add_risk_action(%L, jsonb_build_object('description', 'x', 'ownerId', %L))$f$, k, eve));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'an action is given to a member of this organisation');
  r := pg_temp.fails(format($f$SELECT app.add_risk_action(%L, '{"description":"  "}'::jsonb)$f$, k));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'an action says what is to be done');
  a1 := app.add_risk_action(k, jsonb_build_object('description', 'Audit the second foundry', 'ownerId', bob, 'dueDate', (current_date + 30)::text));
  a2 := app.add_risk_action(k, '{"description":"Hold six weeks of stock"}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT owner_user_id FROM public.risk_actions WHERE id = a2), cat, 'an action defaults to the risk''s owner');
  PERFORM app.update_risk_action(a2, jsonb_build_object('description', 'Hold eight weeks of stock', 'dueDate', NULL));
  PERFORM pg_temp.assert_eq((SELECT description FROM public.risk_actions WHERE id = a2), 'Hold eight weeks of stock', 'an open action can be changed');
  r := pg_temp.fails(format('SELECT app.complete_risk_action(%L, %L)', a2, '  '));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'done says what was done');
  PERFORM app.complete_risk_action(a2, 'Stock raised to eight weeks');
  r := pg_temp.fails(format($f$SELECT app.update_risk_action(%L, '{"description":"changed"}'::jsonb)$f$, a2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'a finished action is frozen');
  PERFORM app.reopen_risk_action(a2);
  PERFORM pg_temp.assert_eq((SELECT status || coalesce(done_note, '') FROM public.risk_actions WHERE id = a2), 'open', 'reopening clears the result');
  r := pg_temp.fails(format('SELECT app.cancel_risk_action(%L, %L)', a2, 'x'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'a cancellation needs a reason');
  PERFORM app.cancel_risk_action(a2, 'Covered by the second foundry');
  PERFORM pg_temp.assert_eq(app.risk_treatment_problems(k), ARRAY['1 action is still open', 'Assess what is left after treatment'], 'what is still needed');
  PERFORM pg_temp.logout();

  -- the person an action was given to closes it with only read rights; nobody else without manage
  PERFORM pg_temp.login(bob);
  r := pg_temp.fails(format('SELECT app.cancel_risk_action(%L, %L)', a1, 'not mine to cancel'));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'the person it was given to cannot cancel it');
  r := pg_temp.fails(format($f$SELECT app.add_risk_action(%L, '{"description":"mine"}'::jsonb)$f$, k));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a reader cannot add actions');
  PERFORM app.complete_risk_action(a1, 'Audited: approved with two minor findings');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.risk_actions WHERE id = a1), 'done', 'the person it was given to closes it');
  PERFORM pg_temp.logout();

  -- ---- what is left: still high, so it needs accepting by someone else ----
  PERFORM pg_temp.login(cat);
  PERFORM pg_temp.assert_eq(pg_temp.st(k), 'treating', 'no residual assessment yet: still treating');
  r := pg_temp.fails(format('SELECT app.propose_risk_acceptance(%L, %L)', k, 'Accept it as it stands for now'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'nothing to accept before what is left is assessed');
  PERFORM app.assess_risk(k, 3, 4, 'Second foundry approved but not yet producing', 'residual');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.risk_assessments WHERE risk_id = k AND status = 'current'), 2::bigint, 'the inherent one stays current beside the residual');
  PERFORM pg_temp.assert_eq((SELECT outcome FROM public.risk_reviews WHERE risk_id = k), 'reassessed', 'a later assessment is recorded as a review');
  PERFORM pg_temp.assert_eq(pg_temp.st(k), 'treating', 'left high: not monitoring');
  PERFORM pg_temp.assert_eq(app.risk_treatment_problems(k), ARRAY['It is high, above the level the organisation accepts (medium): reduce it, or have it accepted by an approver'], 'it says why');
  r := pg_temp.fails(format('SELECT app.close_risk(%L, %L, %L)', k, 'treated', 'Done with it'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'it cannot be closed as treated while above the level accepted');
  r := pg_temp.fails(format('SELECT app.close_risk(%L, %L, %L)', k, 'accepted', 'We live with it'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'nor as accepted without an approver');
  r := pg_temp.fails(format('SELECT app.propose_risk_acceptance(%L, %L)', k, 'short'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'an acceptance says why');
  acc := app.propose_risk_acceptance(k, 'Second source approved; first parts due next quarter');
  PERFORM pg_temp.assert_eq((SELECT band || '/' || status FROM public.risk_acceptances WHERE id = acc), 'high/proposed', 'proposed, for the band as it stands');
  r := pg_temp.fails(format('SELECT app.propose_risk_acceptance(%L, %L)', k, 'A second proposal alongside the first'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'one proposal at a time');
  PERFORM pg_temp.assert_eq(app.risk_treatment_problems(k), ARRAY['The acceptance is waiting for an approver'], 'waiting');
  r := pg_temp.fails(format('SELECT app.decide_risk_acceptance(%L, true, %L)', acc, 'fine'));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a manager without approval rights cannot decide');
  -- assessing again withdraws the waiting proposal
  PERFORM app.assess_risk(k, 4, 3, 'First parts slipped a month', 'residual');
  PERFORM pg_temp.assert_eq((SELECT status || '/' || decision_note FROM public.risk_acceptances WHERE id = acc), 'withdrawn/The risk was assessed again', 'a new assessment withdraws the proposal');
  PERFORM pg_temp.logout();

  -- the proposer never approves their own
  PERFORM pg_temp.login(dan);
  acc := app.propose_risk_acceptance(k, 'Second source approved; first parts due in two months');
  r := pg_temp.fails(format('SELECT app.decide_risk_acceptance(%L, true, %L)', acc, 'my own'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'not the person who proposed it');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(bob);
  r := pg_temp.fails(format('SELECT app.withdraw_risk_acceptance(%L, %L)', acc, 'not mine'));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a reader cannot withdraw it');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ann);
  r := pg_temp.fails(format('SELECT app.decide_risk_acceptance(%L, true, %L)', acc, ' '));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'a decision carries a note');
  PERFORM app.decide_risk_acceptance(acc, false, 'Not until the first parts are in');
  PERFORM pg_temp.assert_eq(pg_temp.st(k), 'treating', 'rejected: still treating');
  r := pg_temp.fails(format('SELECT app.decide_risk_acceptance(%L, true, %L)', acc, 'changed my mind'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'decided once');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(dan);
  acc2 := app.propose_risk_acceptance(k, 'First parts received and inspected; capacity still limited');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ann);
  PERFORM app.decide_risk_acceptance(acc2, true, 'Accepted until the second source reaches volume');
  PERFORM pg_temp.assert_eq(pg_temp.st(k), 'monitoring', 'accepted by someone else: monitoring');
  PERFORM pg_temp.assert_eq(app.risk_treatment_problems(k), '{}'::text[], 'nothing left to do');
  -- the acceptance holds only for the assessment it named
  PERFORM app.assess_risk(k, 5, 4, 'The first foundry has had a fire', 'residual');
  PERFORM pg_temp.assert_eq(pg_temp.st(k), 'treating', 'assessed again: the acceptance no longer covers it');
  PERFORM pg_temp.assert_eq((SELECT next_review_on FROM public.risks WHERE id = k), (current_date + interval '1 month')::date, 'critical: looked at again in a month');
  PERFORM app.assess_risk(k, 2, 3, 'Second source at volume', 'residual');
  PERFORM pg_temp.assert_eq(pg_temp.st(k), 'monitoring', 'left medium: within the level accepted, no acceptance needed');
  r := pg_temp.fails(format('SELECT app.propose_risk_acceptance(%L, %L)', k, 'No need for this one at all'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'no acceptance for a risk within the level accepted');
  -- a new action takes it back to treating
  a2 := app.add_risk_action(k, '{"description":"Review the supply agreement"}'::jsonb);
  PERFORM pg_temp.assert_eq(pg_temp.st(k), 'treating', 'an open action: treating again');

  -- ---- reviews ----
  r := pg_temp.fails(format('SELECT app.record_risk_review(%L, %L)', k, 'ok'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'a review says what was found');
  r := pg_temp.fails(format('SELECT app.record_risk_review(%L, %L, %L)', k, 'Looked at it', current_date));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'the next review is after today');
  rv := app.record_risk_review(k, 'Both foundries delivering; nothing has changed');
  PERFORM pg_temp.assert_eq((SELECT outcome || '/' || next_review_on FROM public.risk_reviews WHERE id = rv), 'no_change/' || (current_date + interval '6 months')::date, 'medium: six months on');
  PERFORM app.record_risk_review(k, 'Checked early before the contract renewal', current_date + 14);
  PERFORM pg_temp.assert_eq((SELECT next_review_on FROM public.risks WHERE id = k), current_date + 14, 'or the date given');
  r := pg_temp.fails(format('UPDATE public.risk_reviews SET note = %L WHERE id = %L', 'rewritten', rv));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'people cannot write reviews directly');

  -- ---- closing ----
  r := pg_temp.fails(format('SELECT app.close_risk(%L, %L, %L)', k, 'treated', 'Done'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'not closed as treated with an action open');
  r := pg_temp.fails(format('SELECT app.close_risk(%L, %L, %L)', k, 'gone', 'Done'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'an outcome from the list');
  r := pg_temp.fails(format('SELECT app.retire_risk(%L, %L)', k, 'Tidy up'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'not retired with an action open');
  PERFORM app.close_risk(k, 'no_longer_applies', 'The part has been designed out');
  PERFORM pg_temp.assert_eq((SELECT status || '/' || outcome || '/' || coalesce(next_review_on::text, '-') FROM public.risks WHERE id = k), 'closed/no_longer_applies/-', 'closed, with no review date');
  PERFORM pg_temp.assert_eq((SELECT status || '/' || cancel_reason FROM public.risk_actions WHERE id = a2), 'cancelled/The risk was closed', 'its open action is cancelled');
  r := pg_temp.fails(format('SELECT app.set_risk_treatment(%L, %L, NULL)', k, 'avoid'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'a closed risk does not change');
  r := pg_temp.fails(format($f$SELECT app.add_risk_action(%L, '{"description":"late"}'::jsonb)$f$, k));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'nor take actions');
  r := pg_temp.fails(format('SELECT app.reopen_risk(%L, %L)', k, ' '));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'reopening needs a reason');
  PERFORM app.reopen_risk(k, 'The part is back in the range');
  PERFORM pg_temp.assert_eq((SELECT status || '/' || coalesce(outcome, '-') || '/' || next_review_on FROM public.risks WHERE id = k), 'monitoring/-/' || current_date, 'reopened where the facts put it, due for a look');
  PERFORM app.close_risk(k, 'treated', 'Two sources at volume');
  PERFORM app.retire_risk(k, 'Entered twice');
  PERFORM app.reactivate_risk(k);
  PERFORM pg_temp.assert_eq(pg_temp.st(k), 'closed', 'brought back as it was: closed');

  -- ---- accepting outright; an opportunity ----
  k2 := app.create_risk(org, jsonb_build_object('categoryId', c, 'title', 'Minor label misprints'));
  PERFORM app.assess_risk(k2, 2, 2, 'Rare and cosmetic');
  PERFORM app.set_risk_treatment(k2, 'accept', NULL);
  PERFORM pg_temp.assert_eq(pg_temp.st(k2), 'monitoring', 'a low risk that is accepted needs nobody''s approval');
  r := pg_temp.fails(format('SELECT app.close_risk(%L, %L, %L)', k2, 'treated', 'Nothing done'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'an accepted risk is not closed as treated');
  PERFORM app.close_risk(k2, 'accepted', 'Accepted as it is');
  opp := app.create_risk(org, jsonb_build_object('categoryId', c, 'title', 'Bring anodising in house', 'kind', 'opportunity'));
  PERFORM app.assess_risk(opp, 5, 5, 'Large saving, very likely');
  r := pg_temp.fails(format('SELECT app.set_risk_treatment(%L, %L, NULL)', opp, 'mitigate'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'an opportunity is exploited or left');
  PERFORM app.set_risk_treatment(opp, 'exploit', 'Business case to the board');
  PERFORM pg_temp.assert_eq(pg_temp.st(opp), 'monitoring', 'an opportunity needs no acceptance however high it scores');
  r := pg_temp.fails(format('SELECT app.propose_risk_acceptance(%L, %L)', opp, 'An opportunity is not accepted'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'no acceptance for an opportunity');
  PERFORM pg_temp.logout();

  -- ---- tenancy and records, for SQL too ----
  PERFORM pg_temp.login(eve);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.risk_actions) + (SELECT count(*) FROM public.risk_reviews) + (SELECT count(*) FROM public.risk_acceptances), 0::bigint, 'another organisation sees none of it');
  r := pg_temp.fails(format('SELECT app.complete_risk_action(%L, %L)', a1, 'x'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'nor finds an action');
  r := pg_temp.fails(format('SELECT app.decide_risk_acceptance(%L, true, %L)', acc2, 'mine now'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'nor an acceptance');
  r := pg_temp.fails(format('SELECT app.risk_treatment_problems(%L)', k));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'nor a risk''s list');
  PERFORM pg_temp.logout();
  r := pg_temp.fails(format('UPDATE public.risk_reviews SET note = %L WHERE id = %L', 'rewritten', rv));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'a review is frozen even for SQL');
  r := pg_temp.fails(format('UPDATE public.risk_acceptances SET status = %L WHERE id = %L', 'rejected', acc2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'a decided acceptance is frozen even for SQL');
  r := pg_temp.fails(format('DELETE FROM public.risk_actions WHERE id = %L', a1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'an action is never deleted');
END $$;

ROLLBACK;
