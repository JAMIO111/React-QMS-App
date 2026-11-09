-- Supplier Quality SQ2c: assessment templates (versions), assessments scored by the database and frozen, approval decisions proposed by one person and decided by another,
-- and the rule that a supplier is approved only through a decision.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('3e000000-0000-0000-0000-000000000a01', 'ann@sqq.test'), ('3e000000-0000-0000-0000-000000000a02', 'bob@sqq.test'), ('3e000000-0000-0000-0000-000000000a03', 'cat@sqq.test'),
  ('3e000000-0000-0000-0000-000000000a04', 'dan@sqq.test'), ('3e000000-0000-0000-0000-000000000a05', 'eve@sqq.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;
-- Answer every question of an assessment: yes / rating 5 unless overridden ({"key": "no" | "na" | "2"}); a note on failures; the document on evidence questions.
CREATE FUNCTION pg_temp.respond(p_assessment uuid, p_doc uuid, p_over jsonb DEFAULT '{}') RETURNS void LANGUAGE plpgsql AS $$
DECLARE q record; v text; v_ans text; v_rating int; v_note text;
BEGIN
  FOR q IN SELECT x FROM jsonb_array_elements((SELECT questions FROM public.supplier_assessments WHERE id = p_assessment)) x LOOP
    v := p_over ->> (q.x ->> 'key'); v_ans := NULL; v_rating := NULL; v_note := NULL;
    IF q.x ->> 'answerType' = 'yes_no' THEN v_ans := coalesce(v, 'yes'); IF v_ans = 'no' THEN v_note := 'Not in place'; END IF;
    ELSIF q.x ->> 'answerType' = 'rating' THEN v_rating := coalesce(v::int, 5); IF v_rating < (q.x ->> 'passRating')::int THEN v_note := 'Weak'; END IF;
    ELSE v_note := 'Noted'; END IF;
    PERFORM app.record_supplier_assessment_response(p_assessment, q.x ->> 'key', v_ans, v_rating, v_note,
      CASE WHEN (q.x ->> 'evidenceRequired')::boolean AND coalesce(v_ans, '') <> 'na' THEN p_doc END);
  END LOOP;
END $$;

DO $$
DECLARE
  ann uuid := '3e000000-0000-0000-0000-000000000a01'; bob uuid := '3e000000-0000-0000-0000-000000000a02'; cat uuid := '3e000000-0000-0000-0000-000000000a03';
  dan uuid := '3e000000-0000-0000-0000-000000000a04'; eve uuid := '3e000000-0000-0000-0000-000000000a05';
  org uuid; org2 uuid; s uuid; s2 uuid; s3 uuid; sb uuid; m uuid; t1 uuid; t2 uuid; v1 uuid; v2 uuid; v1b uuid; a1 uuid; a2 uuid; a3 uuid; a4 uuid; d1 uuid; d2 uuid; d3 uuid; doc uuid; doc_other uuid;
  r text; qs jsonb; p jsonb; role_id uuid;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('SQQ Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('SQQ Beta'); PERFORM pg_temp.logout();
  FOREACH m IN ARRAY ARRAY[bob, cat, dan] LOOP
    INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, m, 'active');
    SELECT id INTO role_id FROM public.roles WHERE organisation_id = org AND key = CASE m WHEN bob THEN 'viewer' WHEN cat THEN 'quality_manager' ELSE 'quality_engineer' END;
    INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, ou.id, role_id FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id = m;
  END LOOP;

  -- ---- the default template ----
  SELECT t.id, v.id INTO t1, v1 FROM public.supplier_assessment_templates t JOIN public.supplier_assessment_template_versions v ON v.template_id = t.id WHERE t.organisation_id = org AND v.version = 1;
  PERFORM pg_temp.assert_eq((SELECT (jsonb_array_length(questions), pass_mark, reason)::text FROM public.supplier_assessment_template_versions WHERE id = v1), '(11,75,"Default template")', 'a default template is seeded: 11 questions, pass mark 75');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.supplier_assessment_templates WHERE organisation_id = org2), 1::bigint, 'for every organisation');
  qs := (SELECT questions FROM public.supplier_assessment_template_versions WHERE id = v1);

  -- ---- configuring templates needs supplier_quality.configure ----
  PERFORM pg_temp.login(dan);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_supplier_assessment_template(%L, 'Engineer template', NULL, %L::jsonb, 70)$f$, org, qs::text)), 5), '42501', 'an engineer cannot configure templates');
  PERFORM pg_temp.assert_fails(format($f$INSERT INTO public.supplier_assessment_templates (organisation_id, name) VALUES (%L, 'Direct')$f$, org), 'templates are written only through functions');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_supplier_assessment_template(%L, 'supplier QUALIFICATION questionnaire', NULL, %L::jsonb, 70)$f$, org, qs::text)), 5), 'QM020', 'a name is unique ignoring case');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_supplier_assessment_template(%L, 'Bad type', NULL, '[{"key":"aa","text":"x","answerType":"maybe","weight":1,"critical":false,"evidenceRequired":false}]'::jsonb, 70)$f$, org)), 5), 'QM020', 'an unknown answer type is refused');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_supplier_assessment_template(%L, 'Dup keys', NULL, %L::jsonb, 70)$f$, org, (qs || (qs -> 0))::text)), 5), 'QM020', 'duplicate question keys are refused');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_supplier_assessment_template(%L, 'Notes only', NULL, '[{"key":"aa","text":"Say something","answerType":"text","weight":1,"critical":false,"evidenceRequired":false}]'::jsonb, 70)$f$, org)), 5), 'QM020', 'a template with nothing scored is refused');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_supplier_assessment_template(%L, 'Critical note', NULL, '[{"key":"aa","text":"x","answerType":"text","weight":1,"critical":true,"evidenceRequired":false},{"key":"bb","text":"y","answerType":"yes_no","weight":1,"critical":false,"evidenceRequired":false}]'::jsonb, 70)$f$, org)), 5), 'QM020', 'a note question cannot be critical');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.create_supplier_assessment_template(%L, 'Pass mark', NULL, %L::jsonb, 101)$f$, org, qs::text)), 5), 'QM020', 'the pass mark is 1 to 100');
  t2 := app.create_supplier_assessment_template(org, 'Quick check', 'A short questionnaire', '[{"key":"qms","text":"Certified?","answerType":"yes_no","weight":5,"critical":true,"evidenceRequired":false},{"key":"rate","text":"Delivery","answerType":"rating","weight":5,"critical":false,"evidenceRequired":false,"passRating":3}]'::jsonb, 60);
  SELECT id INTO v2 FROM public.supplier_assessment_template_versions WHERE template_id = t2 AND version = 1;
  PERFORM pg_temp.assert_eq((SELECT version FROM public.supplier_assessment_template_versions WHERE id = v2), 1, 'a new template starts at version 1');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.save_supplier_assessment_template_version(%L, %L::jsonb, 75, 'No change')$f$, t1, qs::text)), 5), 'QM020', 'saving an unchanged version is refused');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.save_supplier_assessment_template_version(%L, %L::jsonb, 80, '')$f$, t1, qs::text)), 5), 'QM020', 'a reason is needed');
  v1b := app.save_supplier_assessment_template_version(t1, qs, 80, 'Raised the pass mark');
  PERFORM pg_temp.assert_eq((SELECT (version, pass_mark)::text FROM public.supplier_assessment_template_versions WHERE id = v1b), '(2,80)', 'a changed template is a new version');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.supplier_assessment_template_versions WHERE template_id = t1), 2::bigint, 'and the old version is kept');
  PERFORM app.update_supplier_assessment_template(t2, '{"active": false}'::jsonb);
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'ACME', 'Acme Metals') RETURNING id INTO s;
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'BOLT', 'Bolt Co') RETURNING id INTO s2;
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'CAST', 'Cast Co') RETURNING id INTO s3;
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.start_supplier_assessment(%L, %L)$f$, s, v2)), 5), 'QM020', 'a template that is switched off cannot be used');
  PERFORM app.update_supplier_assessment_template(t2, '{"active": true}'::jsonb);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.start_supplier_assessment(%L, %L)$f$, s, v1)), 5), 'QM020', 'only the current version of a template can be started');
  -- a supplier document to use as evidence (written by the SQ2a function)
  doc := app.add_supplier_document(s, 'certificate', 'ISO certificate', NULL, NULL, NULL, NULL, org::text || '/supplier/' || s::text || '/' || gen_random_uuid() || '-iso.pdf', 'iso.pdf', NULL, 5);
  doc_other := app.add_supplier_document(s2, 'certificate', 'Other certificate', NULL, NULL, NULL, NULL, org::text || '/supplier/' || s2::text || '/' || gen_random_uuid() || '-x.pdf', 'x.pdf', NULL, 5);
  PERFORM pg_temp.logout();

  -- ---- running an assessment: the engineer prepares it ----
  PERFORM pg_temp.login(dan);
  a1 := app.start_supplier_assessment(s, v1b);
  PERFORM pg_temp.assert_eq((SELECT (status, template_name, template_version, pass_mark, reference ~ '^SA-[0-9]{2}-0001$')::text FROM public.supplier_assessments WHERE id = a1), '(in_progress,"Supplier qualification questionnaire",2,80,t)', 'an assessment freezes the template version and pass mark and gets a number');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.start_supplier_assessment(%L, %L)$f$, s, v1b)), 5), 'QM020', 'one assessment at a time per supplier');
  PERFORM pg_temp.assert_fails(format($f$INSERT INTO public.supplier_assessment_responses (organisation_id, assessment_id, question_key, result) VALUES (%L, %L, 'qms_certified', 'pass')$f$, org, a1), 'responses are written only through the function');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_supplier_assessment_response(%L, 'qms_certified', 'maybe', NULL, NULL, NULL)$f$, a1)), 5), 'QM020', 'a yes/no question takes yes, no or n/a');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_supplier_assessment_response(%L, 'inspection', NULL, 6, NULL, NULL)$f$, a1)), 5), 'QM020', 'a rating is 1 to 5');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_supplier_assessment_response(%L, 'qms_certified', 'yes', 3, NULL, NULL)$f$, a1)), 5), 'QM020', 'a yes/no question takes no rating');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_supplier_assessment_response(%L, 'assessor_notes', 'yes', NULL, NULL, NULL)$f$, a1)), 5), 'QM020', 'a note question takes only a note');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_supplier_assessment_response(%L, 'nonsense', 'yes', NULL, NULL, NULL)$f$, a1)), 5), 'QM020', 'an unknown question is refused');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_supplier_assessment_response(%L, 'qms_certified', 'yes', NULL, NULL, %L)$f$, a1, doc_other)), 5), 'QM020', 'evidence must be a document of this supplier');
  PERFORM app.record_supplier_assessment_response(a1, 'qms_certified', 'yes', NULL, 'Certificate seen', doc);
  PERFORM app.record_supplier_assessment_response(a1, 'qms_scope', 'no', NULL, 'Scope excludes machining', NULL);
  PERFORM app.record_supplier_assessment_response(a1, 'inspection', NULL, 2, 'Weak records', NULL);
  PERFORM app.record_supplier_assessment_response(a1, 'inspection', NULL, 4, 'Reviewed again', NULL);
  PERFORM app.record_supplier_assessment_response(a1, 'training', 'na', NULL, NULL, NULL);
  PERFORM pg_temp.assert_eq((SELECT array_agg(question_key || ':' || result ORDER BY question_key) FROM public.supplier_assessment_responses WHERE assessment_id = a1),
    ARRAY['inspection:pass', 'qms_certified:pass', 'qms_scope:fail', 'training:na'], 'the database works out each result; an answer can be changed while in progress');
  p := app.supplier_assessment_progress(a1);
  PERFORM pg_temp.assert_eq((p ->> 'answered') || '/' || (p ->> 'scored'), '4/10', 'progress counts the scored questions answered');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.complete_supplier_assessment(%L, NULL)$f$, a1)), 5), 'QM020', 'an incomplete assessment cannot be completed');
  -- a failure without a note and evidence without a document are "still needed"
  PERFORM app.record_supplier_assessment_response(a1, 'document_control', 'no', NULL, NULL, NULL);
  PERFORM app.record_supplier_assessment_response(a1, 'calibration', 'yes', NULL, NULL, NULL);
  PERFORM pg_temp.assert_eq((SELECT bool_or(x like 'Say why it fails%') FROM jsonb_array_elements_text(app.supplier_assessment_progress(a1) -> 'problems') x), true, 'a failure needs a note');
  PERFORM app.record_supplier_assessment_response(a1, 'qms_certified', 'yes', NULL, 'No file yet', NULL);
  PERFORM pg_temp.assert_eq((SELECT bool_or(x like 'Attach the evidence%') FROM jsonb_array_elements_text(app.supplier_assessment_progress(a1) -> 'problems') x), true, 'and an evidence question needs a document');
  PERFORM app.record_supplier_assessment_response(a1, 'qms_certified', 'yes', NULL, 'Certificate seen', doc);
  PERFORM app.abandon_supplier_assessment(a1, 'Started against the wrong supplier');
  PERFORM pg_temp.assert_eq((SELECT (status, abandon_reason)::text FROM public.supplier_assessments WHERE id = a1), '(abandoned,"Started against the wrong supplier")', 'an assessment is abandoned with a reason and kept');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_supplier_assessment_response(%L, 'qms_scope', 'yes', NULL, NULL, NULL)$f$, a1)), 5), 'QM020', 'an abandoned assessment takes no more answers');

  -- a pass: everything yes, ratings 5 => 100
  a2 := app.start_supplier_assessment(s, v1b);
  PERFORM pg_temp.respond(a2, doc);
  p := app.supplier_assessment_progress(a2);
  PERFORM pg_temp.assert_eq((p ->> 'score') || '/' || (p ->> 'result') || '/' || (p ->> 'criticalFailures'), '100.00/pass/0', 'all yes and top ratings score 100 and pass');
  PERFORM app.complete_supplier_assessment(a2, 'All good');
  PERFORM pg_temp.assert_eq((SELECT (status, score, result, critical_failures, completed_by = dan)::text FROM public.supplier_assessments WHERE id = a2), '(completed,100.00,pass,0,t)', 'completing stores the score and result worked out by the database');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_supplier_assessment_response(%L, 'qms_scope', 'no', NULL, 'Changed my mind', NULL)$f$, a2)), 5), 'QM020', 'a completed assessment is frozen');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.complete_supplier_assessment(%L, NULL)$f$, a2)), 5), 'QM020', 'and cannot be completed twice');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.abandon_supplier_assessment(%L, 'Too late to abandon')$f$, a2)), 5), 'QM020', 'or abandoned');

  -- a critical failure fails the assessment whatever the score: calibration is critical (weight 4 of 35): 31/35 = 88.57
  a3 := app.start_supplier_assessment(s2, v1b);
  PERFORM pg_temp.respond(a3, (SELECT id FROM public.supplier_documents WHERE supplier_id = s2 LIMIT 1), '{"calibration":"no"}');
  p := app.supplier_assessment_progress(a3);
  PERFORM pg_temp.assert_eq((p ->> 'score') || '/' || (p ->> 'result') || '/' || (p ->> 'criticalFailures'), '88.57/fail/1', 'a critical failure fails the assessment despite a high score');
  PERFORM app.complete_supplier_assessment(a3, NULL);
  -- a low score fails without a critical failure: one n/a (5) and four non-critical "no" (4+3+3+3 = 13): 17 of 30 = 56.67
  a4 := app.start_supplier_assessment(s3, v1b);
  PERFORM pg_temp.respond(a4, NULL, '{"qms_certified":"na","qms_scope":"no","document_control":"no","training":"no","traceability":"no"}');
  p := app.supplier_assessment_progress(a4);
  PERFORM pg_temp.assert_eq((p ->> 'score') || '/' || (p ->> 'result') || '/' || (p ->> 'criticalFailures'), '56.67/fail/0', 'a score under the pass mark fails (n/a questions are left out: 17 of 30)');
  PERFORM app.complete_supplier_assessment(a4, NULL);
  PERFORM pg_temp.logout();

  -- ---- a viewer reads but cannot assess or propose ----
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.supplier_assessments WHERE organisation_id = org), 4::bigint, 'a viewer reads assessments');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.start_supplier_assessment(%L, %L)$f$, s, v1b)), 5), '42501', 'but cannot start one');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.propose_supplier_approval(%L, 'approved', 'Viewer says', %L)$f$, s, a2)), 5), '42501', 'or propose an approval');
  PERFORM pg_temp.logout();

  -- ---- approval decisions ----
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.change_supplier_status(%L, 'approved', 'I will just approve it')$f$, s)), 5), 'QM020', 'a direct move to approved is refused, even for an owner');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.change_supplier_status(%L, 'conditional', 'Direct conditional', 'Inspect all')$f$, s)), 5), 'QM020', 'so is a direct conditional approval');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(dan);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.propose_supplier_approval(%L, 'approved', 'No assessment at all')$f$, s)), 5), 'QM020', 'approval needs an assessment or an explicit exception');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.propose_supplier_approval(%L, 'approved', 'Failed assessment', %L, NULL, NULL, 'too short')$f$, s2, a3)), 5), 'QM020', 'a failing assessment needs a proper exception reason (at least 10 characters)');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.propose_supplier_approval(%L, 'suspended', 'Not a decision')$f$, s)), 5), 'QM020', 'a decision approves or conditionally approves');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.propose_supplier_approval(%L, 'approved', 'Wrong supplier assessment', %L)$f$, s, a3)), 5), 'QM020', 'the assessment must be this supplier''s');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.propose_supplier_approval(%L, 'conditional', 'No conditions', %L)$f$, s, a2)), 5), 'QM020', 'a conditional approval states its conditions');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.propose_supplier_approval(%L, 'approved', 'Review today', %L, NULL, current_date)$f$, s, a2)), 5), 'QM020', 'a review date must be after today');
  d1 := app.propose_supplier_approval(s, 'approved', 'Passed the qualification assessment', a2, NULL, current_date + 365);
  PERFORM pg_temp.assert_eq((SELECT (status, from_status, target_status, exception_reason IS NULL, proposed_by = dan)::text FROM public.supplier_approval_decisions WHERE id = d1), '(proposed,pending_approval,approved,t,t)', 'a proposal records who made it and what it moves from');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.propose_supplier_approval(%L, 'approved', 'A second proposal', %L)$f$, s, a2)), 5), 'QM020', 'one proposal at a time per supplier');
  PERFORM pg_temp.assert_eq((SELECT approval_status FROM public.suppliers WHERE id = s), 'pending_approval', 'a proposal changes nothing about the supplier');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.decide_supplier_approval(%L, true, 'I propose, I approve')$f$, d1)), 5), '42501', 'an engineer cannot decide (no approve right)');
  PERFORM pg_temp.assert_fails(format($f$UPDATE public.supplier_approval_decisions SET status = 'approved' WHERE id = %L$f$, d1), 'a decision cannot be written directly');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login(cat);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.decide_supplier_approval(%L, false, '')$f$, d1)), 5), 'QM020', 'a decision needs a note');
  PERFORM app.decide_supplier_approval(d1, true, 'Assessment and certificates reviewed');
  PERFORM pg_temp.assert_eq((SELECT (status, decided_by = cat, status_history_id IS NOT NULL)::text FROM public.supplier_approval_decisions WHERE id = d1), '(approved,t,t)', 'a different approver decides, and the decision links the status history row');
  PERFORM pg_temp.assert_eq((SELECT (approval_status, approval_status_changed_by = cat)::text FROM public.suppliers WHERE id = s), '(approved,t)', 'the supplier is now approved by the decider');
  PERFORM pg_temp.assert_eq((SELECT (h.to_status, h.reason, h.review_on = current_date + 365)::text FROM public.supplier_approval_decisions d JOIN public.supplier_status_history h ON h.id = d.status_history_id WHERE d.id = d1), '(approved,"Passed the qualification assessment",t)', 'the history carries the rationale and review date');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.decide_supplier_approval(%L, true, 'Again')$f$, d1)), 5), 'QM020', 'a decision is final');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.change_supplier_status(%L, 'conditional', 'Direct', 'Inspect all')$f$, s)), 5), 'QM020', 'moves to approved or conditional stay refused once the decision has been made');
  PERFORM app.change_supplier_status(s, 'suspended', 'Late deliveries');
  PERFORM pg_temp.assert_eq((SELECT approval_status FROM public.suppliers WHERE id = s), 'suspended', 'protective moves such as suspension stay direct');
  PERFORM pg_temp.logout();

  -- preparer is never the approver: an owner proposes the reinstatement and cannot decide it
  PERFORM pg_temp.login(ann);
  d2 := app.propose_supplier_approval(s, 'conditional', 'Reinstate with extra checks', a2, 'Inspect every delivery for 3 months', current_date + 90);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.decide_supplier_approval(%L, true, 'Approving my own proposal')$f$, d2)), 5), 'QM020', 'the preparer cannot approve their own proposal, even as an owner');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  PERFORM app.decide_supplier_approval(d2, false, 'Not enough evidence of corrective action yet');
  PERFORM pg_temp.assert_eq((SELECT (status, decision_note, status_history_id IS NULL)::text FROM public.supplier_approval_decisions WHERE id = d2), '(rejected,"Not enough evidence of corrective action yet",t)', 'a rejection keeps its note and changes nothing');
  PERFORM pg_temp.assert_eq((SELECT approval_status FROM public.suppliers WHERE id = s), 'suspended', 'the supplier stays suspended');
  PERFORM pg_temp.logout();

  -- an exception: no passing assessment, so the reason is recorded and flagged
  PERFORM pg_temp.login(dan);
  d3 := app.propose_supplier_approval(s2, 'approved', 'Sole source for a legacy part', a3, NULL, NULL, 'Sole source, the calibration finding is being closed out');
  PERFORM pg_temp.assert_eq((SELECT exception_reason IS NOT NULL FROM public.supplier_approval_decisions WHERE id = d3), true, 'an exception reason is kept on the proposal');
  PERFORM app.withdraw_supplier_approval(d3, 'Withdrawn until the finding is closed');
  PERFORM pg_temp.assert_eq((SELECT (status, decision_note)::text FROM public.supplier_approval_decisions WHERE id = d3), '(withdrawn,"Withdrawn until the finding is closed")', 'the proposer can withdraw it with a reason');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.withdraw_supplier_approval(%L, 'Again')$f$, d3)), 5), 'QM020', 'only a waiting proposal can be withdrawn');
  PERFORM pg_temp.logout();
  -- someone else who is not an approver cannot withdraw; a status that moved since the proposal cannot be approved over
  PERFORM pg_temp.login(dan);
  d3 := app.propose_supplier_approval(s3, 'conditional', 'Conditional pending a re-audit', a4, 'Re-audit within 90 days', current_date + 90, 'Failed on documents only; the re-audit is booked');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.withdraw_supplier_approval(%L, 'Viewer withdraws')$f$, d3)), 5), '42501', 'a viewer cannot withdraw someone else''s proposal');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  PERFORM app.change_supplier_status(s3, 'disqualified', 'Withdrew from the contract');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.decide_supplier_approval(%L, true, 'Approving anyway')$f$, d3)), 5), 'QM020', 'a proposal cannot be approved after the supplier''s status has moved on');
  PERFORM pg_temp.logout();

  -- ---- another organisation: nothing crosses ----
  PERFORM pg_temp.login(eve);
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org2, 'BETA', 'Beta Ltd') RETURNING id INTO sb;
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.supplier_assessments) + (SELECT count(*) FROM public.supplier_approval_decisions) + (SELECT count(*) FROM public.supplier_assessment_responses), 0::bigint, 'another organisation sees none of it');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.start_supplier_assessment(%L, %L)$f$, s, v1b)), 5), 'P0002', 'it cannot start an assessment on a foreign supplier');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.propose_supplier_approval(%L, 'approved', 'Foreign', %L)$f$, s, a2)), 5), 'P0002', 'or propose an approval');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.decide_supplier_approval(%L, true, 'Foreign decision')$f$, d2)), 5), 'P0002', 'or decide one');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.save_supplier_assessment_template_version(%L, %L::jsonb, 70, 'Foreign template')$f$, t1, qs::text)), 5), 'P0002', 'or change a foreign template');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.supplier_assessment_progress(%L)$f$, a2)), 5), 'P0002', 'or read a foreign assessment''s progress');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) >= 8 FROM public.audit_events WHERE entity_type IN ('supplier_assessments', 'supplier_approval_decisions', 'supplier_assessment_templates')), true, 'it is all audited');
END $$;
ROLLBACK;
