-- Audits, AU3: records — started only by app.start_audit with a frozen copy of the audit, answers worked out by the database, completion rules (everything answered, a note on every
-- failure, the "carried out on" chosen), the result (critical questions and the pass mark), one record per slot, frozen once completed, raising a non-conformance, and who may do what.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('38000000-0000-0000-0000-000000000801', 'owner@rec.test'), ('38000000-0000-0000-0000-000000000802', 'inspector@rec.test'), ('38000000-0000-0000-0000-000000000803', 'viewer@rec.test'),
  ('38000000-0000-0000-0000-000000000804', 'other@rec.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;
CREATE FUNCTION pg_temp.qid(p_record uuid, p_seq int) RETURNS uuid LANGUAGE sql AS $$ SELECT id FROM public.audit_record_questions WHERE audit_record_id = p_record AND sequence = p_seq $$;

DO $$
DECLARE
  u_owner uuid := '38000000-0000-0000-0000-000000000801'; u_insp uuid := '38000000-0000-0000-0000-000000000802'; u_view uuid := '38000000-0000-0000-0000-000000000803'; u_other uuid := '38000000-0000-0000-0000-000000000804';
  org uuid; org2 uuid; m uuid; site uuid; mach uuid; mach_b uuid; mach_other uuid; dept uuid; def uuid; def2 uuid; def3 uuid; def4 uuid; r5 uuid; occ uuid; occ_skipped uuid; r1 uuid; r2 uuid; r3 uuid; r4 uuid; ncr uuid; ncr2 uuid;
  resp uuid; resp2 uuid; txt text; n int;
BEGIN
  PERFORM pg_temp.login(u_owner);
  org := app.create_organisation('Record Works', 'Plant A', 'PA', NULL);
  SELECT id INTO site FROM public.sites WHERE organisation_id = org;
  INSERT INTO public.departments (organisation_id, site_id, code, name) VALUES (org, site, 'MACH', 'Machining') RETURNING id INTO dept;
  INSERT INTO public.machines (organisation_id, code, name, site_id) VALUES (org, 'CNC-1', 'Lathe', site) RETURNING id INTO mach;
  INSERT INTO public.machines (organisation_id, code, name, site_id) VALUES (org, 'CNC-2', 'Mill', site) RETURNING id INTO mach_b;
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_other);
  org2 := app.create_organisation('Other Works', 'Plant B', 'PB', NULL);
  INSERT INTO public.machines (organisation_id, code, name) VALUES (org2, 'OTH-1', 'Other') RETURNING id INTO mach_other;
  PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u_insp, 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'inspector';
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u_view, 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'viewer';

  -- The audit: five questions (one critical), three things it is relevant to, pass mark 80.
  PERFORM pg_temp.login(u_owner);
  INSERT INTO public.audit_definitions (organisation_id, title, audit_type, procedure, frequency_kind, first_due_on, grace_days, pass_mark)
    VALUES (org, 'Cell audit', 'layered_process', 'Walk the cell.', 'weekly', current_date - 14, 2, 80) RETURNING id INTO def;
  PERFORM app.set_audit_checklist(def, '[
    {"question":"Is the work instruction at the machine?","answerType":"yes_no","passAnswer":"yes","critical":true},
    {"question":"Is the floor clear?","answerType":"pass_fail"},
    {"question":"Coolant concentration","answerType":"numeric","unit":"%","lowerLimit":6,"upperLimit":10},
    {"question":"Any damaged guards?","answerType":"yes_no_na","passAnswer":"no"},
    {"question":"Anything else seen","answerType":"text"}]'::jsonb);
  PERFORM app.set_audit_targets(def, format('[{"kind":"machine","machineId":"%s"},{"kind":"machine","machineId":"%s"},{"kind":"operation","operationCode":"op10"},{"kind":"department","departmentId":"%s"}]', mach, mach_b, dept)::jsonb);
  PERFORM pg_temp.logout();
  UPDATE public.audit_definitions SET created_at = now() - interval '30 days' WHERE id = def;
  PERFORM pg_temp.login(u_owner);
  PERFORM app.generate_audit_occurrences(org, current_date + 14);
  SELECT id INTO occ FROM public.audit_occurrences WHERE audit_definition_id = def AND due_on = current_date - 14;
  SELECT id INTO occ_skipped FROM public.audit_occurrences WHERE audit_definition_id = def AND due_on = current_date - 7;
  PERFORM app.skip_audit_occurrence(occ_skipped, 'Shutdown');
  PERFORM pg_temp.logout();

  -- ---- who may start ----
  PERFORM pg_temp.login(u_view);
  PERFORM pg_temp.assert_eq(pg_temp.fails(format('SELECT app.start_audit(%L)', def)) LIKE '42501:%', true, 'a viewer may read audits but not carry them out');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_other);
  PERFORM pg_temp.assert_eq(pg_temp.fails(format('SELECT app.start_audit(%L)', def)) LIKE 'P0002:%', true, 'another organisation cannot see the audit');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login(u_insp);
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.audit_records (organisation_id, reference, audit_definition_id, audit_reference, audit_title, audit_type, pass_mark) VALUES (%L, 'X', %L, 'A', 'x', 'process', 50)$q$, org, def), 'a record cannot be written directly');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format('SELECT app.start_audit(%L, %L)', def, occ_skipped)) LIKE 'QM018: That scheduled audit was skipped%', true, 'a skipped slot cannot be carried out');

  r1 := app.start_audit(def, occ);
  PERFORM pg_temp.assert_eq((SELECT reference FROM public.audit_records WHERE id = r1), 'AR-' || to_char(current_date, 'YY') || '-0001', 'numbered AR-YY-NNNN');
  PERFORM pg_temp.assert_eq((SELECT audit_reference || '/' || audit_title || '/' || pass_mark || '/' || status || '/' || (started_by = u_insp)::text FROM public.audit_records WHERE id = r1), 'AUD-001/Cell audit/80/in_progress/true', 'the audit is copied into the record, with who started it');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_record_questions WHERE audit_record_id = r1), 5::bigint, 'the checklist is copied');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format('SELECT app.start_audit(%L, %L)', def, occ)) LIKE 'QM018: That scheduled audit is already being done%', true, 'one record per slot');
  PERFORM pg_temp.logout();

  -- Changing the audit afterwards leaves the record as it was started.
  PERFORM pg_temp.login(u_owner);
  PERFORM app.set_audit_checklist(def, '[{"question":"A different question","answerType":"pass_fail"}]'::jsonb);
  UPDATE public.audit_definitions SET title = 'Renamed', pass_mark = 100 WHERE id = def;
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_record_questions WHERE audit_record_id = r1 AND question = 'Is the floor clear?'), 1::bigint, 'the record keeps the questions it was started with');
  PERFORM pg_temp.assert_eq((SELECT audit_title || '/' || pass_mark FROM public.audit_records WHERE id = r1), 'Cell audit/80', 'and the title and pass mark');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.audit_record_questions SET critical = false WHERE audit_record_id = %L$q$, r1), 'the copied questions cannot be edited');
  PERFORM pg_temp.logout();

  -- ---- carried out on ----
  PERFORM pg_temp.login(u_insp);
  PERFORM pg_temp.assert_eq(array_to_string(app.audit_record_problems(r1), ' | ') LIKE '%choose which machines, operations or departments%', true, 'an audit that lists things needs to say which it was carried out on');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.set_audit_record_targets(%L, '[{"kind":"machine","machineId":"%s"}]'::jsonb)$q$, r1, mach_other)) LIKE 'QM018: That machine is not one of%', true, 'only a machine the audit lists');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.set_audit_record_targets(%L, '[{"kind":"operation","operationCode":"OP99"}]'::jsonb)$q$, r1)) LIKE 'QM018: That operation is not one of%', true, 'nor an operation it does not list');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.set_audit_record_targets(%L, '[{"kind":"machine","machineId":"%s"},{"kind":"machine","machineId":"%s"}]'::jsonb)$q$, r1, mach, mach)) LIKE 'QM018: The same machine%', true, 'not the same one twice');
  PERFORM app.set_audit_record_targets(r1, format('[{"kind":"machine","machineId":"%s"},{"kind":"operation","operationCode":"OP10"}]', mach)::jsonb);
  PERFORM pg_temp.assert_eq((SELECT string_agg(label, ',' ORDER BY label) FROM public.audit_record_targets WHERE audit_record_id = r1), 'CNC-1 · Lathe,op10', 'one or several, with a label kept (the audit''s own spelling of an operation)');
  PERFORM app.set_audit_record_targets(r1, format('[{"kind":"machine","machineId":"%s"},{"kind":"machine","machineId":"%s"}]', mach, mach_b)::jsonb);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_record_targets WHERE audit_record_id = r1), 2::bigint, 'the list is replaced as a whole');

  -- ---- answers ----
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.record_audit_response(%L, %L, 'maybe')$q$, r1, pg_temp.qid(r1, 1))) LIKE 'QM018: Answer yes or no%', true, 'a yes/no question takes yes or no');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.record_audit_response(%L, %L, 'yes')$q$, r1, pg_temp.qid(r1, 2))) LIKE 'QM018: Answer pass or fail%', true, 'a pass/fail question takes pass or fail');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.record_audit_response(%L, %L, NULL, NULL, 'x')$q$, r1, pg_temp.qid(r1, 3))) LIKE 'QM018: Enter a number%', true, 'a numeric question needs a number');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.record_audit_response(%L, %L, NULL, NULL, NULL)$q$, r1, pg_temp.qid(r1, 5))) = 'ok', true, 'nothing to say clears an answer');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.record_audit_response(%L, %L, NULL, NULL, '  ')$q$, r1, pg_temp.qid(r1, 5))) = 'ok', true, 'blank is nothing');

  PERFORM app.record_audit_response(r1, pg_temp.qid(r1, 1), 'no');
  PERFORM pg_temp.assert_eq((SELECT result FROM public.audit_responses WHERE record_question_id = pg_temp.qid(r1, 1)), 'fail', 'the passing answer decides: "no" fails a question whose passing answer is yes');
  PERFORM app.record_audit_response(r1, pg_temp.qid(r1, 4), 'no');
  PERFORM pg_temp.assert_eq((SELECT result FROM public.audit_responses WHERE record_question_id = pg_temp.qid(r1, 4)), 'pass', 'and "no" passes the guards question');
  PERFORM app.record_audit_response(r1, pg_temp.qid(r1, 3), NULL, 10);
  PERFORM pg_temp.assert_eq((SELECT result FROM public.audit_responses WHERE record_question_id = pg_temp.qid(r1, 3)), 'pass', 'a number on the upper limit passes');
  PERFORM app.record_audit_response(r1, pg_temp.qid(r1, 3), NULL, 6);
  PERFORM pg_temp.assert_eq((SELECT result FROM public.audit_responses WHERE record_question_id = pg_temp.qid(r1, 3)), 'pass', 'and so does a number exactly on the lower limit');
  PERFORM app.record_audit_response(r1, pg_temp.qid(r1, 3), NULL, 10.01);
  PERFORM pg_temp.assert_eq((SELECT result FROM public.audit_responses WHERE record_question_id = pg_temp.qid(r1, 3)), 'fail', 'just over it fails');
  PERFORM app.record_audit_response(r1, pg_temp.qid(r1, 3), NULL, 5.99);
  PERFORM pg_temp.assert_eq((SELECT result FROM public.audit_responses WHERE record_question_id = pg_temp.qid(r1, 3)), 'fail', 'and so does under the lower limit');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.record_audit_response(%L, %L, 'na')$q$, r1, pg_temp.qid(r1, 3))) LIKE 'QM018: Enter a number%', true, 'only a yes / no / N/A question can be not applicable');
  PERFORM app.record_audit_response(r1, pg_temp.qid(r1, 3), NULL, 8);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_responses WHERE record_question_id = pg_temp.qid(r1, 3)), 1::bigint, 'answering again replaces the answer');
  PERFORM app.record_audit_response(r1, pg_temp.qid(r1, 4), 'na');
  PERFORM pg_temp.assert_eq((SELECT result || '/' || (value_number IS NULL)::text FROM public.audit_responses WHERE record_question_id = pg_temp.qid(r1, 4)), 'na/true', 'not applicable is not scored and keeps no number');

  -- ---- what is still needed ----
  txt := array_to_string(app.audit_record_problems(r1), ' | ');
  PERFORM pg_temp.assert_eq(txt LIKE '%question 2 is not answered%', true, 'unanswered questions are listed');
  PERFORM pg_temp.assert_eq(txt LIKE '%say what was found for the failed question: 1%', true, 'a failure needs a note');
  PERFORM pg_temp.assert_eq(txt LIKE '%choose which machines%', false, 'the targets are chosen, so that is not listed');
  PERFORM pg_temp.assert_eq(txt LIKE '%question 5%', false, 'a note question is not required');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format('SELECT app.complete_audit(%L)', r1)) LIKE 'QM018: Before AR-%can be completed:%', true, 'completing is refused with the reasons');

  PERFORM app.record_audit_response(r1, pg_temp.qid(r1, 2), 'pass');
  PERFORM app.record_audit_response(r1, pg_temp.qid(r1, 1), 'no', NULL, 'Instruction missing at the machine');
  PERFORM app.record_audit_response(r1, pg_temp.qid(r1, 5), NULL, NULL, 'Tidy otherwise');
  PERFORM pg_temp.assert_eq(array_length(app.audit_record_problems(r1), 1) IS NULL, true, 'nothing left');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.update_audit_record(%L, NULL, current_date + 1)$q$, r1)) LIKE 'QM018: An audit cannot have been carried out in the future%', true, 'not in the future');
  PERFORM app.update_audit_record(r1, 'Quiet shift', current_date - 1, true);
  PERFORM pg_temp.assert_eq((SELECT notes || '/' || performed_on FROM public.audit_records WHERE id = r1), 'Quiet shift/' || (current_date - 1), 'notes and date kept');
  PERFORM app.update_audit_record(r1, NULL, NULL, false);
  PERFORM pg_temp.assert_eq((SELECT notes FROM public.audit_records WHERE id = r1), 'Quiet shift', 'leaving the notes alone keeps them');

  -- ---- complete: one critical question failed, so it fails whatever the score ----
  PERFORM app.complete_audit(r1);
  PERFORM pg_temp.assert_eq((SELECT status || '/' || result || '/' || score || '/' || passed_count || '/' || failed_count || '/' || na_count || '/' || critical_failed_count FROM public.audit_records WHERE id = r1),
    'completed/fail/66.67/2/1/1/1', 'passes 2, fails 1, one not applicable: 66.67 %, and a failed critical question');
  PERFORM pg_temp.assert_eq((SELECT completed_by = u_insp FROM public.audit_records WHERE id = r1), true, 'who completed it');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.audit_records SET result = 'pass' WHERE id = %L$q$, r1), 'a record cannot be edited directly');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.record_audit_response(%L, %L, 'yes')$q$, r1, pg_temp.qid(r1, 1))) LIKE 'QM018: % is completed; it can no longer be changed', true, 'a completed record is frozen: answers');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.set_audit_record_targets(%L, '[]'::jsonb)$q$, r1)) LIKE 'QM018: % is completed%', true, 'targets');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.abandon_audit(%L, 'oops')$q$, r1)) LIKE 'QM018: % is completed%', true, 'and it cannot be abandoned');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format('SELECT app.complete_audit(%L)', r1)) LIKE 'QM018: % is completed%', true, 'or completed twice');
  PERFORM pg_temp.logout();

  -- ---- the pass mark and critical questions: a second audit with a mark of 50 ----
  PERFORM pg_temp.login(u_owner);
  INSERT INTO public.audit_definitions (organisation_id, title, audit_type, frequency_kind, pass_mark) VALUES (org, 'Four checks', 'process', 'on_demand', 50) RETURNING id INTO def2;
  PERFORM app.set_audit_checklist(def2, '[{"question":"a","answerType":"pass_fail"},{"question":"b","answerType":"pass_fail"},{"question":"c","answerType":"pass_fail"},{"question":"d","answerType":"pass_fail"}]'::jsonb);
  r2 := app.start_audit(def2);
  PERFORM pg_temp.assert_eq((SELECT occurrence_id IS NULL FROM public.audit_records WHERE id = r2), true, 'an audit can be carried out without a slot');
  PERFORM pg_temp.assert_eq(array_to_string(app.audit_record_problems(r2), '|') LIKE '%choose which%', false, 'an audit that lists nothing needs no "carried out on"');
  PERFORM app.record_audit_response(r2, pg_temp.qid(r2, 1), 'pass');
  PERFORM app.record_audit_response(r2, pg_temp.qid(r2, 2), 'pass');
  PERFORM app.record_audit_response(r2, pg_temp.qid(r2, 3), 'fail', NULL, 'Found');
  PERFORM app.record_audit_response(r2, pg_temp.qid(r2, 4), 'fail', NULL, 'Found too');
  PERFORM app.complete_audit(r2);
  PERFORM pg_temp.assert_eq((SELECT result || '/' || score FROM public.audit_records WHERE id = r2), 'pass/50.00', 'exactly on the pass mark passes');
  r3 := app.start_audit(def2);
  PERFORM app.record_audit_response(r3, pg_temp.qid(r3, 1), 'pass');
  PERFORM app.record_audit_response(r3, pg_temp.qid(r3, 2), 'fail', NULL, 'Found');
  PERFORM app.record_audit_response(r3, pg_temp.qid(r3, 3), 'fail', NULL, 'Found');
  PERFORM app.record_audit_response(r3, pg_temp.qid(r3, 4), 'fail', NULL, 'Found');
  PERFORM app.complete_audit(r3);
  PERFORM pg_temp.assert_eq((SELECT result || '/' || score FROM public.audit_records WHERE id = r3), 'fail/25.00', 'under it fails');
  PERFORM pg_temp.assert_eq((SELECT reference FROM public.audit_records WHERE id = r3), 'AR-' || to_char(current_date, 'YY') || '-0003', 'numbering continues');
  INSERT INTO public.audit_definitions (organisation_id, title, audit_type, frequency_kind, pass_mark) VALUES (org, 'One critical', 'process', 'on_demand', 50) RETURNING id INTO def3;
  PERFORM app.set_audit_checklist(def3, '[{"question":"Safety guard fitted","answerType":"pass_fail","critical":true},{"question":"b","answerType":"pass_fail"},{"question":"c","answerType":"pass_fail"}]'::jsonb);
  r5 := app.start_audit(def3);
  PERFORM app.record_audit_response(r5, pg_temp.qid(r5, 1), 'fail', NULL, 'Guard missing');
  PERFORM app.record_audit_response(r5, pg_temp.qid(r5, 2), 'pass');
  PERFORM app.record_audit_response(r5, pg_temp.qid(r5, 3), 'pass');
  PERFORM app.complete_audit(r5);
  PERFORM pg_temp.assert_eq((SELECT result || '/' || score || '/' || critical_failed_count FROM public.audit_records WHERE id = r5), 'fail/66.67/1', 'a failed critical question fails the audit even when the score is above the pass mark');
  INSERT INTO public.audit_definitions (organisation_id, title, audit_type, frequency_kind, pass_mark) VALUES (org, 'All not applicable', 'process', 'on_demand', 50) RETURNING id INTO def4;
  PERFORM app.set_audit_checklist(def4, '[{"question":"a","answerType":"yes_no_na"},{"question":"b","answerType":"yes_no_na"},{"question":"c","answerType":"yes_no_na"},{"question":"d","answerType":"yes_no_na"}]'::jsonb);
  r4 := app.start_audit(def4);
  FOR n IN 1..4 LOOP PERFORM app.record_audit_response(r4, pg_temp.qid(r4, n), 'na'); END LOOP;
  PERFORM app.complete_audit(r4);
  PERFORM pg_temp.assert_eq((SELECT result || '/' || coalesce(score::text, 'none') FROM public.audit_records WHERE id = r4), 'pass/none', 'when everything is not applicable there is nothing to fail: no score, and a pass');

  -- ---- abandon ----
  r4 := app.start_audit(def2);
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.abandon_audit(%L, '  ')$q$, r4)) LIKE 'QM018: Give a reason%', true, 'abandoning needs a reason');
  PERFORM app.abandon_audit(r4, 'Started by mistake');
  PERFORM pg_temp.assert_eq((SELECT status || '/' || abandon_reason FROM public.audit_records WHERE id = r4), 'abandoned/Started by mistake', 'abandoned, with the reason');
  PERFORM pg_temp.logout();

  -- An abandoned record frees the slot; a retired audit cannot be carried out.
  PERFORM pg_temp.login(u_insp);
  SELECT id INTO occ FROM public.audit_occurrences WHERE audit_definition_id = def AND due_on = current_date - 14;
  PERFORM pg_temp.assert_eq(pg_temp.fails(format('SELECT app.start_audit(%L, %L)', def, occ)) LIKE 'QM018: That scheduled audit is already being done or has been done%', true, 'a completed slot stays done');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_owner);
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.skip_audit_occurrence(%L, 'Machine down')$q$, occ)) LIKE 'QM018: This audit is being done or has been done%', true, 'a slot with a record cannot be skipped');
  SELECT id INTO occ FROM public.audit_occurrences WHERE audit_definition_id = def AND due_on = current_date;
  r4 := app.start_audit(def, occ);
  PERFORM app.abandon_audit(r4, 'Wrong machine');
  r4 := app.start_audit(def, occ);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_records WHERE occurrence_id = occ), 2::bigint, 'an abandoned record frees its slot for another try');
  PERFORM app.abandon_audit(r4, 'Cancelled');
  -- A slot with a record is not removed when the audit changes rhythm or is retired.
  r4 := app.start_audit(def, (SELECT id FROM public.audit_occurrences WHERE audit_definition_id = def AND due_on = current_date + 7));
  PERFORM app.retire_audit_definition(def, 'Replaced');
  PERFORM app.generate_audit_occurrences(org, current_date + 30);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_occurrences WHERE audit_definition_id = def AND due_on = current_date + 7), 1::bigint, 'a future slot that was started early survives retiring (it has a record)');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_occurrences WHERE audit_definition_id = def AND due_on = current_date + 14), 0::bigint, 'while the other future slots go');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format('SELECT app.start_audit(%L)', def)) LIKE 'QM018: % is retired%', true, 'a retired audit cannot be carried out');
  PERFORM app.abandon_audit(r4, 'Tidy up');
  PERFORM pg_temp.logout();

  -- ---- raise a non-conformance from a failed answer ----
  PERFORM pg_temp.login(u_view);
  SELECT id INTO resp FROM public.audit_responses WHERE record_question_id = pg_temp.qid(r1, 1);
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.raise_ncr_from_audit(%L, ARRAY[%L]::uuid[], 'x')$q$, r1, resp)) LIKE '42501:%', true, 'a viewer cannot raise NCs');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_insp);
  SELECT id INTO resp2 FROM public.audit_responses WHERE record_question_id = pg_temp.qid(r1, 2);
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.raise_ncr_from_audit(%L, ARRAY[%L]::uuid[], 'x')$q$, r1, resp2)) LIKE 'QM018: Only failed answers%', true, 'only a failed answer');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.raise_ncr_from_audit(%L, ARRAY[]::uuid[], 'x')$q$, r1)) LIKE 'QM018: Choose at least one%', true, 'at least one');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.raise_ncr_from_audit(%L, ARRAY[%L]::uuid[], ' ')$q$, r1, resp)) LIKE 'QM018: Give the non-conformance a title%', true, 'a title');
  ncr := app.raise_ncr_from_audit(r1, ARRAY[resp], 'Work instruction missing', 'Found during the cell audit', 'minor');
  PERFORM pg_temp.assert_eq((SELECT stage || '/' || source || '/' || title || '/' || severity || '/' || (site_id = site)::text FROM public.nonconformances WHERE id = ncr), 'draft/internal/Work instruction missing/minor/true', 'a draft internal NC, at the site of the machine it was found on');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_ncr_links WHERE nonconformance_id = ncr AND response_id = resp), 1::bigint, 'linked to the answer');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.raise_ncr_from_audit(%L, ARRAY[%L]::uuid[], 'again')$q$, r1, resp)) LIKE 'QM018: A failed answer is already on a non-conformance%', true, 'one live NC per failed answer');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.raise_ncr_from_audit(%L, ARRAY[%L]::uuid[], 'again')$q$, r2, resp)) LIKE 'QM018: Only failed answers%', true, 'and only answers of this record');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_owner);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.outbox_events WHERE organisation_id = org AND event_type = 'audit.ncr_raised'), 1::bigint, 'an event is written');
  UPDATE public.nonconformances SET deleted_at = now(), delete_reason = 'Raised in error' WHERE id = ncr;
  ncr2 := app.raise_ncr_from_audit(r1, ARRAY[resp], 'Raised again');
  PERFORM pg_temp.assert_eq(ncr2 <> ncr, true, 'a deleted draft frees its answer');
  PERFORM pg_temp.logout();

  -- ---- reading: viewers read, strangers do not ----
  PERFORM pg_temp.login(u_view);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_records WHERE organisation_id = org) > 0, true, 'a viewer reads records');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_responses WHERE organisation_id = org) > 0, true, 'and answers');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_other);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_records) + (SELECT count(*) FROM public.audit_responses) + (SELECT count(*) FROM public.audit_record_targets)
    + (SELECT count(*) FROM public.audit_record_questions) + (SELECT count(*) FROM public.audit_ncr_links), 0::bigint, 'another organisation sees nothing');
  PERFORM pg_temp.logout();

  SELECT count(*) INTO n FROM public.audit_events WHERE organisation_id = org AND entity_type IN ('audit_records', 'audit_responses', 'audit_record_targets');
  PERFORM pg_temp.assert_eq(n > 0, true, 'records, answers and targets are audited');
END $$;

ROLLBACK;
