-- NC containment and disposition: containment actions (done needs a note, cancel needs a reason, nothing deleted), dispositions (proposed by editors, approved only through the
-- function by approvers, frozen once approved, quantities never above the quantity affected), the cumulative stage gates, and who may do what.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('38000000-0000-0000-0000-000000000401', 'owner@ncd.test'), ('38000000-0000-0000-0000-000000000402', 'engineer@ncd.test'), ('38000000-0000-0000-0000-000000000403', 'inspector@ncd.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  u_owner uuid := '38000000-0000-0000-0000-000000000401'; u_eng uuid := '38000000-0000-0000-0000-000000000402'; u_insp uuid := '38000000-0000-0000-0000-000000000403';
  org uuid; m uuid; emp uuid; nc uuid; nc2 uuid; nc3 uuid; nc4 uuid;
  c1 uuid; c2 uuid; d1 uuid; d2 uuid; d3 uuid; d4 uuid; r text;
  mk text := $f$INSERT INTO public.nonconformances (organisation_id, source, title, severity, quantity_affected, description, stage) VALUES (%L, 'internal', %L, 'minor', 10, 'x', 'open') RETURNING id$f$;
BEGIN
  PERFORM pg_temp.login(u_owner);
  org := app.create_organisation('Containment Works', 'Plant A', 'PA', NULL);
  INSERT INTO public."Employees" (organisation_id, first_name, surname) VALUES (org, 'Ada', 'Lovelace') RETURNING id INTO emp;
  EXECUTE format(mk, org, 'Main') INTO nc;
  EXECUTE format(mk, org, 'No containment needed') INTO nc2;
  EXECUTE format(mk, org, 'Nothing recorded') INTO nc3;
  EXECUTE format(mk, org, 'Skips ahead') INTO nc4;

  PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u_eng, 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'quality_engineer';
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u_insp, 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'inspector';
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.role_permissions rp JOIN public.roles r ON r.id = rp.role_id
                              WHERE r.organisation_id = org AND rp.permission_code = 'ncr.approve_disposition'), 3::bigint, 'owner, admin and quality manager can approve');

  -- ---- containment ----
  PERFORM pg_temp.login(u_insp);
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.ncr_containment_actions (organisation_id, nonconformance_id, kind, description) VALUES (%L, %L, 'quarantine', 'x')$q$, org, nc), 'a reader cannot add containment');
  PERFORM pg_temp.login(u_eng);
  INSERT INTO public.ncr_containment_actions (organisation_id, nonconformance_id, kind, description, owner_employee_id, due_date, status, done_at)
    VALUES (org, nc, 'quarantine', 'Quarantine lot 77 in the cage', emp, current_date + 1, 'done', now()) RETURNING id INTO c1;
  PERFORM pg_temp.assert_eq((SELECT status || '/' || (done_at IS NULL)::text FROM public.ncr_containment_actions WHERE id = c1), 'open/true', 'a new action is open whatever is sent');
  r := pg_temp.fails(format($q$UPDATE public.nonconformances SET stage = 'contained' WHERE id = %L$q$, nc));
  PERFORM pg_temp.assert_eq(r LIKE 'QM005: Before this can move to contained: 1 containment action is still open', true, 'an open action blocks Contained: ' || r);
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$UPDATE public.ncr_containment_actions SET status = 'done' WHERE id = %L$q$, c1)) LIKE 'QM005: Say what was done%', true, 'done needs a note');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.ncr_containment_actions SET done_at = now() WHERE id = %L$q$, c1), 'who and when are not user-writable');
  UPDATE public.ncr_containment_actions SET status = 'done', done_note = '120 pieces quarantined, none shipped' WHERE id = c1;
  PERFORM pg_temp.assert_eq((SELECT done_by = u_eng AND done_at IS NOT NULL FROM public.ncr_containment_actions WHERE id = c1), true, 'done is stamped by the database');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$UPDATE public.ncr_containment_actions SET description = 'changed' WHERE id = %L$q$, c1)) LIKE 'QM005: This containment action is done; reopen it%', true, 'a done action is frozen');
  UPDATE public.ncr_containment_actions SET status = 'open' WHERE id = c1;
  PERFORM pg_temp.assert_eq((SELECT done_at IS NULL AND done_by IS NULL FROM public.ncr_containment_actions WHERE id = c1), true, 'reopening clears the stamps');
  UPDATE public.ncr_containment_actions SET status = 'done', done_note = 'Done again' WHERE id = c1;
  INSERT INTO public.ncr_containment_actions (organisation_id, nonconformance_id, kind, description) VALUES (org, nc, 'sort', 'Sort the rest') RETURNING id INTO c2;
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.ncr_containment_actions SET status = 'cancelled' WHERE id = %L$q$, c2), 'cancelling needs a reason');
  UPDATE public.ncr_containment_actions SET status = 'cancelled', cancel_reason = 'Covered by the quarantine' WHERE id = c2;
  PERFORM pg_temp.assert_fails(format($q$DELETE FROM public.ncr_containment_actions WHERE id = %L$q$, c2), 'nothing is deleted');
  UPDATE public.nonconformances SET stage = 'contained' WHERE id = nc;
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.nonconformances WHERE id = nc), 'contained', 'containment done, so Contained is reached');

  -- No containment needed: a reason does it; nothing at all does not.
  r := pg_temp.fails(format($q$UPDATE public.nonconformances SET stage = 'contained' WHERE id = %L$q$, nc3));
  PERFORM pg_temp.assert_eq(r LIKE 'QM005: Before this can move to contained: record a containment action, or say why none is needed', true, 'nothing recorded blocks Contained: ' || r);
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.nonconformances SET containment_not_needed_reason = '   ' WHERE id = %L$q$, nc2), 'a blank reason is not a reason');
  UPDATE public.nonconformances SET containment_not_needed_reason = 'Found at first-off, nothing had left the cell' WHERE id = nc2;
  UPDATE public.nonconformances SET stage = 'contained' WHERE id = nc2;

  -- ---- dispositions ----
  INSERT INTO public.ncr_dispositions (organisation_id, nonconformance_id, decision, quantity, instructions, status, approved_at)
    VALUES (org, nc, 'scrap', 6, 'Scrap 6', 'approved', now()) RETURNING id INTO d1;
  PERFORM pg_temp.assert_eq((SELECT status || '/' || (approved_at IS NULL)::text FROM public.ncr_dispositions WHERE id = d1), 'proposed/true', 'a new disposition is proposed whatever is sent');
  r := pg_temp.fails(format($q$INSERT INTO public.ncr_dispositions (organisation_id, nonconformance_id, decision, quantity, instructions) VALUES (%L, %L, 'rework', 5, 'Rework')$q$, org, nc));
  PERFORM pg_temp.assert_eq(r LIKE 'QM005: Dispositions would total 11 but only 10 are affected (6 already covered)', true, 'the quantity cannot exceed the affected: ' || r);
  INSERT INTO public.ncr_dispositions (organisation_id, nonconformance_id, decision, quantity, instructions)
    VALUES (org, nc, 'rework', 4, 'Rework at op 20') RETURNING id INTO d2;
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.ncr_dispositions (organisation_id, nonconformance_id, decision, quantity, instructions) VALUES (%L, %L, 'scrap', 0, 'none')$q$, org, nc), 'a quantity of zero');
  r := pg_temp.fails(format($q$UPDATE public.nonconformances SET stage = 'dispositioned' WHERE id = %L$q$, nc));
  PERFORM pg_temp.assert_eq(r LIKE 'QM005: Before this can move to dispositioned: 2 proposed dispositions are still to approve or cancel; approved dispositions cover 0 of the 10 affected', true, 'proposals block Dispositioned: ' || r);
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.ncr_dispositions SET status = 'approved' WHERE id = %L$q$, d1), 'status is not user-writable');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.approve_ncr_disposition(%L)$q$, d1)) LIKE '42501:%', true, 'an engineer cannot approve');
  PERFORM pg_temp.login(u_insp);
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.approve_ncr_disposition(%L)$q$, d1)) LIKE '42501:%', true, 'an inspector cannot approve');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.ncr_dispositions WHERE nonconformance_id = nc), 2::bigint, 'a reader sees the dispositions');
  PERFORM pg_temp.assert_eq(pg_temp.affected(format($q$UPDATE public.ncr_dispositions SET quantity = 1 WHERE id = %L$q$, d1)), 0::bigint, 'a reader cannot edit (row filtered)');

  PERFORM pg_temp.login(u_owner);
  PERFORM app.approve_ncr_disposition(d1, '  Agreed with the customer  ');
  PERFORM pg_temp.assert_eq((SELECT status || '/' || approved_by::text || '/' || approval_note FROM public.ncr_dispositions WHERE id = d1), 'approved/' || u_owner::text || '/Agreed with the customer', 'approval stamped, note trimmed');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.approve_ncr_disposition(%L)$q$, d1)) LIKE 'QM005: This disposition is approved%', true, 'approved once');
  PERFORM pg_temp.login(u_eng);
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$UPDATE public.ncr_dispositions SET quantity = 5 WHERE id = %L$q$, d1)) LIKE 'QM005: This disposition is approved; only a proposed one can be changed', true, 'an approved disposition is frozen');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.cancel_ncr_disposition(%L, 'Wrong')$q$, d1)) LIKE '42501:%', true, 'an engineer cannot cancel an approved disposition');
  -- Own proposals: edit, cancel with a reason.
  UPDATE public.ncr_dispositions SET quantity = 3, instructions = 'Rework 3 at op 20' WHERE id = d2;
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.cancel_ncr_disposition(%L, '  ')$q$, d2)) LIKE 'QM005: Give a reason%', true, 'a cancel needs a reason');
  PERFORM app.cancel_ncr_disposition(d2, 'Quantity changed');
  PERFORM pg_temp.assert_eq((SELECT status || '/' || cancelled_by::text FROM public.ncr_dispositions WHERE id = d2), 'cancelled/' || u_eng::text, 'a cancelled proposal');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.ncr_dispositions SET quantity = 4 WHERE id = %L$q$, d2), 'a cancelled disposition is frozen');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.cancel_ncr_disposition(%L, 'Again')$q$, d2)) LIKE 'QM005: This disposition is already cancelled', true, 'cancelled once');

  -- A concession needs a reference before it can be approved.
  INSERT INTO public.ncr_dispositions (organisation_id, nonconformance_id, decision, quantity, instructions)
    VALUES (org, nc, 'concession', 4, 'Use as is under customer concession') RETURNING id INTO d3;
  PERFORM pg_temp.login(u_owner);
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.approve_ncr_disposition(%L)$q$, d3)) LIKE 'QM005: A concession needs a reference%', true, 'a concession needs a reference');
  UPDATE public.ncr_dispositions SET reference = 'CUST-CONC-0042' WHERE id = d3;
  -- The quantity affected cannot drop below what is covered; approved coverage lets the NC move on, skipping stages.
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$UPDATE public.nonconformances SET quantity_affected = 8 WHERE id = %L$q$, nc)) LIKE 'QM005: Dispositions already cover 10 items%', true, 'the quantity affected cannot drop below the dispositions');
  PERFORM app.approve_ncr_disposition(d3);
  PERFORM pg_temp.assert_eq(coalesce(array_length(app.ncr_gate_problems(nc, 'closed'), 1), 0), 0, 'nothing left to do for Closed');
  PERFORM pg_temp.assert_eq(array_length(app.ncr_gate_problems(nc3, 'closed'), 1), 2, 'two things still needed on the untouched NC');
  PERFORM pg_temp.login(u_eng);
  UPDATE public.nonconformances SET stage = 'awaiting_closure' WHERE id = nc;  -- Contained straight past Investigating and Dispositioned
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.nonconformances WHERE id = nc), 'awaiting_closure', 'cumulative gates satisfied, so skipping ahead is allowed');

  -- ---- gates cannot be bypassed by skipping ahead ----
  UPDATE public.nonconformances SET containment_not_needed_reason = 'Nothing left the cell' WHERE id = nc4;
  r := pg_temp.fails(format($q$UPDATE public.nonconformances SET stage = 'closed' WHERE id = %L$q$, nc4));
  PERFORM pg_temp.assert_eq(r LIKE 'QM005: Before this can move to closed: approved dispositions cover 0 of the 10 affected', true, 'Open straight to Closed needs dispositions too: ' || r);
  r := pg_temp.fails(format($q$UPDATE public.nonconformances SET stage = 'awaiting_closure' WHERE id = %L$q$, nc4));
  PERFORM pg_temp.assert_eq(r LIKE 'QM005: Before this can move to awaiting closure:%', true, 'and to Awaiting closure: ' || r);
  UPDATE public.nonconformances SET stage = 'investigating' WHERE id = nc4;  -- needs containment only
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.nonconformances WHERE id = nc4), 'investigating', 'Investigating needs containment only');
  -- Cancelling and the rest are not gated.
  UPDATE public.nonconformances SET stage = 'cancelled', stage_reason = 'Raised in error' WHERE id = nc3;
  UPDATE public.nonconformances SET stage = 'open', stage_reason = 'Reopen to check' WHERE id = nc3;

  -- An approver can cancel an approved disposition, which frees its quantity and re-opens the gate.
  PERFORM pg_temp.login(u_owner);
  PERFORM app.cancel_ncr_disposition(d3, 'Customer withdrew the concession');
  PERFORM pg_temp.assert_eq(array_length(app.ncr_gate_problems(nc, 'closed'), 1), 1, 'cancelling an approved disposition reopens the gap');
  INSERT INTO public.ncr_dispositions (organisation_id, nonconformance_id, decision, quantity, instructions) VALUES (org, nc, 'scrap', 4, 'Scrap the rest') RETURNING id INTO d4;
  PERFORM app.approve_ncr_disposition(d4);

  -- A closed NC is locked: no new containment or dispositions.
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.outbox_events WHERE organisation_id = org AND event_type = 'ncr.disposition.approved'), 3::bigint, 'an event for each approval');
  PERFORM pg_temp.login(u_owner);
  UPDATE public.nonconformances SET stage = 'closed' WHERE id = nc;
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.ncr_containment_actions (organisation_id, nonconformance_id, kind, description) VALUES (%L, %L, 'sort', 'late')$q$, org, nc), 'no containment on a closed NC');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.ncr_dispositions (organisation_id, nonconformance_id, decision, quantity, instructions) VALUES (%L, %L, 'scrap', 1, 'late')$q$, org, nc), 'no dispositions on a closed NC');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.cancel_ncr_disposition(%L, 'late')$q$, d4)) LIKE 'QM005: This non-conformance is closed%', true, 'no cancelling on a closed NC');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
