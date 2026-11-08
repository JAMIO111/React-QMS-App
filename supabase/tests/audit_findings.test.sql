-- Audits, Phase A: findings and promotion to a non-conformance — classifications (seeded per organisation, key and kind fixed), findings written only by functions (numbering, one live finding per
-- answer, edit / withdraw / close / reopen and who may), the rule that a failed critical answer needs a finding, promotion to a draft internal NC (idempotent, freed when the NC is cancelled or deleted),
-- evidence files on a finding (storage policy and rules), and tenancy.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('39000000-0000-0000-0000-000000000901', 'owner@fnd.test'), ('39000000-0000-0000-0000-000000000902', 'inspector@fnd.test'), ('39000000-0000-0000-0000-000000000903', 'viewer@fnd.test'),
  ('39000000-0000-0000-0000-000000000904', 'other@fnd.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;
CREATE FUNCTION pg_temp.qid(p_record uuid, p_seq int) RETURNS uuid LANGUAGE sql AS $$ SELECT id FROM public.audit_record_questions WHERE audit_record_id = p_record AND sequence = p_seq $$;
CREATE FUNCTION pg_temp.cls(p_org uuid, p_key text) RETURNS uuid LANGUAGE sql AS $$ SELECT id FROM public.audit_finding_classifications WHERE organisation_id = p_org AND key = p_key $$;

DO $$
DECLARE
  u_owner uuid := '39000000-0000-0000-0000-000000000901'; u_insp uuid := '39000000-0000-0000-0000-000000000902'; u_view uuid := '39000000-0000-0000-0000-000000000903'; u_other uuid := '39000000-0000-0000-0000-000000000904';
  org uuid; org2 uuid; m uuid; site uuid; mach uuid; def uuid; r1 uuid; r2 uuid; r3 uuid; resp1 uuid; resp2 uuid; resp3 uuid; emp uuid; emp_other uuid;
  f1 uuid; f2 uuid; f3 uuid; f4 uuid; f5 uuid; ncr uuid; ncr2 uuid; att uuid; att2 uuid; att3 uuid; j jsonb; c_new uuid; n bigint; path text;
BEGIN
  PERFORM pg_temp.login(u_owner);
  org := app.create_organisation('Finding Works', 'Plant A', 'PA', NULL);
  SELECT id INTO site FROM public.sites WHERE organisation_id = org;
  INSERT INTO public.machines (organisation_id, code, name, site_id) VALUES (org, 'CNC-1', 'Lathe', site) RETURNING id INTO mach;
  INSERT INTO public."Employees" (organisation_id, first_name, surname) VALUES (org, 'Ada', 'Lovelace') RETURNING id INTO emp;
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_other);
  org2 := app.create_organisation('Other Works', 'Plant B', 'PB', NULL);
  INSERT INTO public."Employees" (organisation_id, first_name, surname) VALUES (org2, 'Grace', 'Hopper') RETURNING id INTO emp_other;
  PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u_insp, 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'inspector';
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u_view, 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'viewer';

  -- ---- classifications ----
  PERFORM pg_temp.assert_eq((SELECT string_agg(key || ':' || kind || ':' || coalesce(default_severity, '-'), ',' ORDER BY sequence) FROM public.audit_finding_classifications WHERE organisation_id = org),
    'major_nc:nonconformity:major,minor_nc:nonconformity:minor,observation:observation:-,ofi:opportunity:-', 'every organisation starts with the four classifications');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_finding_classifications WHERE organisation_id = org2), 4::bigint, 'including one created later');
  PERFORM pg_temp.login(u_view);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_finding_classifications WHERE organisation_id = org), 4::bigint, 'a viewer reads them');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.audit_finding_classifications (organisation_id, key, label, kind) VALUES (%L, 'x_ncr', 'X', 'observation')$q$, org), 'but cannot add one');
  PERFORM pg_temp.assert_eq(pg_temp.affected(format($q$UPDATE public.audit_finding_classifications SET label = 'Hacked' WHERE organisation_id = %L$q$, org)), 0::bigint, 'or rename one');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_owner);
  INSERT INTO public.audit_finding_classifications (organisation_id, key, label, kind, default_severity, sequence) VALUES (org, 'critical_nc', 'Critical non-conformity', 'nonconformity', 'critical', 0) RETURNING id INTO c_new;
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.audit_finding_classifications (organisation_id, key, label, kind) VALUES (%L, 'critical_nc', 'Again', 'observation')$q$, org), 'a key is unique per organisation');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.audit_finding_classifications (organisation_id, key, label, kind, default_severity) VALUES (%L, 'obs_two', 'Obs 2', 'observation', 'major')$q$, org), 'only a non-conformity has a default severity');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.audit_finding_classifications (organisation_id, key, label, kind) VALUES (%L, 'Bad Key', 'Bad', 'observation')$q$, org), 'a key is lower-case letters, digits and underscores');
  PERFORM pg_temp.assert_ok(format($q$UPDATE public.audit_finding_classifications SET label = 'Critical NC', sequence = 9 WHERE id = %L$q$, c_new), 'a manager renames and reorders');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.audit_finding_classifications SET kind = 'observation', default_severity = NULL WHERE id = %L$q$, c_new), 'the kind is fixed once created');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.audit_finding_classifications SET key = 'renamed' WHERE id = %L$q$, c_new), 'and so is the key');
  PERFORM pg_temp.assert_fails(format($q$DELETE FROM public.audit_finding_classifications WHERE id = %L$q$, c_new), 'nothing is deleted');

  -- ---- an audit with three questions (one critical), one record ----
  INSERT INTO public.audit_definitions (organisation_id, title, audit_type, frequency_kind, pass_mark) VALUES (org, 'Cell audit', 'layered_process', 'on_demand', 50) RETURNING id INTO def;
  PERFORM app.set_audit_checklist(def, '[{"question":"Guard fitted","answerType":"pass_fail","critical":true},{"question":"Floor clear","answerType":"pass_fail"},{"question":"Notes tidy","answerType":"pass_fail"}]'::jsonb);
  PERFORM app.set_audit_targets(def, format('[{"kind":"machine","machineId":"%s"}]', mach)::jsonb);
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login(u_insp);
  r1 := app.start_audit(def, NULL, format('[{"kind":"machine","machineId":"%s"}]', mach)::jsonb);
  PERFORM app.record_audit_response(r1, pg_temp.qid(r1, 1), 'fail', NULL, 'Guard missing');
  PERFORM app.record_audit_response(r1, pg_temp.qid(r1, 2), 'fail', NULL, 'Swarf on the floor');
  PERFORM app.record_audit_response(r1, pg_temp.qid(r1, 3), 'pass');
  SELECT id INTO resp1 FROM public.audit_responses WHERE record_question_id = pg_temp.qid(r1, 1);
  SELECT id INTO resp2 FROM public.audit_responses WHERE record_question_id = pg_temp.qid(r1, 2);
  SELECT id INTO resp3 FROM public.audit_responses WHERE record_question_id = pg_temp.qid(r1, 3);
  PERFORM pg_temp.logout();

  -- ---- who may create ----
  PERFORM pg_temp.login(u_view);
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.create_audit_finding(%L, %L, %L, 'x', 'y')$q$, r1, resp1, pg_temp.cls(org, 'major_nc'))) LIKE '42501:%', true, 'a viewer cannot create a finding');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.audit_findings (organisation_id, reference, audit_record_id, classification_id, title, description) VALUES (%L, 'X', %L, %L, 'x', 'y')$q$, org, r1, pg_temp.cls(org, 'major_nc')), 'nor write one directly');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_other);
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.create_audit_finding(%L, %L, %L, 'x', 'y')$q$, r1, resp1, pg_temp.cls(org2, 'major_nc'))) LIKE 'P0002:%', true, 'another organisation cannot see the record');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login(u_insp);
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.create_audit_finding(%L, %L, %L, 'x', 'y')$q$, r1, resp1, pg_temp.cls(org2, 'major_nc'))) LIKE 'QM018: Choose how the finding is classified%', true, 'a classification of another organisation is not accepted');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.create_audit_finding(%L, %L, %L, ' ', 'y')$q$, r1, resp1, pg_temp.cls(org, 'major_nc'))) LIKE 'QM018: Give the finding a title%', true, 'a title is needed');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.create_audit_finding(%L, %L, %L, 'x', ' ')$q$, r1, resp1, pg_temp.cls(org, 'major_nc'))) LIKE 'QM018: Say what was found%', true, 'and what was found');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.create_audit_finding(%L, %L, %L, 'x', 'y', NULL, %L)$q$, r1, resp1, pg_temp.cls(org, 'major_nc'), emp_other)) LIKE 'QM018: The owner is not an employee%', true, 'the owner is an employee of this organisation');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_owner);
  UPDATE public.audit_finding_classifications SET active = false WHERE id = c_new;
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_insp);
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.create_audit_finding(%L, %L, %L, 'x', 'y')$q$, r1, resp1, c_new)) LIKE 'QM018: The classification % is switched off%', true, 'a switched-off classification is refused');

  -- ---- a failed critical answer needs a finding before the record can be completed ----
  PERFORM pg_temp.assert_eq(array_to_string(app.audit_record_problems(r1), ' | ') LIKE '%raise a finding for the failed critical question: 1%', true, 'the critical failure asks for a finding');
  PERFORM pg_temp.assert_eq(array_to_string(app.audit_record_problems(r1), ' | ') LIKE '%question 2%raise%', false, 'but not the other failure');
  f1 := app.create_audit_finding(r1, resp1, pg_temp.cls(org, 'major_nc'), 'Guard missing', 'The guard was not fitted on the lathe', 'Machine guards are fitted at all times', emp, current_date + 14);
  PERFORM pg_temp.assert_eq((SELECT reference FROM public.audit_findings WHERE id = f1), 'AF-' || to_char(current_date, 'YY') || '-0001', 'numbered AF-YY-NNNN');
  PERFORM pg_temp.assert_eq((SELECT status || '/' || (response_id = resp1)::text || '/' || (owner_employee_id = emp)::text || '/' || due_on FROM public.audit_findings WHERE id = f1), 'open/true/true/' || (current_date + 14), 'an open finding on that answer, with owner and due date');
  PERFORM pg_temp.assert_eq(array_to_string(app.audit_record_problems(r1), ' | ') LIKE '%raise a finding%', false, 'and the problem is gone');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.create_audit_finding(%L, %L, %L, 'again', 'again')$q$, r1, resp1, pg_temp.cls(org, 'major_nc'))) LIKE 'QM018: That answer already has a finding%', true, 'one live finding per answer');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.create_audit_finding(%L, %L, %L, 'x', 'y')$q$, r1, gen_random_uuid(), pg_temp.cls(org, 'major_nc'))) LIKE 'QM018: That answer is not part of this audit%', true, 'the answer is one of this record''s');

  -- a withdrawn finding frees its answer; withdrawing needs a reason
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.withdraw_audit_finding(%L, ' ')$q$, f1)) LIKE 'QM018: Say why the finding is withdrawn%', true, 'withdrawing needs a reason');
  f2 := app.create_audit_finding(r1, resp2, pg_temp.cls(org, 'observation'), 'Swarf', 'Swarf on the floor');
  PERFORM app.withdraw_audit_finding(f2, 'Cleaned during the audit');
  PERFORM pg_temp.assert_eq((SELECT status || '/' || withdraw_reason FROM public.audit_findings WHERE id = f2), 'withdrawn/Cleaned during the audit', 'withdrawn, with the reason');
  f2 := app.create_audit_finding(r1, resp2, pg_temp.cls(org, 'minor_nc'), 'Swarf on the floor', 'Swarf on the floor around the lathe', NULL, NULL, NULL);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_findings WHERE response_id = resp2), 2::bigint, 'the withdrawn one stays on record, and the answer has a new finding');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.update_audit_finding(%L, '{"title":"x"}'::jsonb)$q$, (SELECT id FROM public.audit_findings WHERE response_id = resp2 AND status = 'withdrawn'))) LIKE 'QM018: AF-%is withdrawn%', true, 'a withdrawn finding cannot be edited');

  -- a standalone finding (no answer)
  f3 := app.create_audit_finding(r1, NULL, pg_temp.cls(org, 'ofi'), 'Better lighting', 'Lighting at the bench could be improved');
  PERFORM pg_temp.assert_eq((SELECT response_id IS NULL FROM public.audit_findings WHERE id = f3), true, 'a finding needs no answer');

  -- a withdrawn finding no longer covers a failed critical answer
  r3 := app.start_audit(def, NULL, format('[{"kind":"machine","machineId":"%s"}]', mach)::jsonb);
  PERFORM app.record_audit_response(r3, pg_temp.qid(r3, 1), 'fail', NULL, 'Guard missing again');
  PERFORM app.record_audit_response(r3, pg_temp.qid(r3, 2), 'pass');
  PERFORM app.record_audit_response(r3, pg_temp.qid(r3, 3), 'pass');
  f4 := app.create_audit_finding(r3, (SELECT id FROM public.audit_responses WHERE record_question_id = pg_temp.qid(r3, 1)), pg_temp.cls(org, 'major_nc'), 'Guard missing', 'Not fitted');
  PERFORM pg_temp.assert_eq(array_length(app.audit_record_problems(r3), 1) IS NULL, true, 'the finding covers the failed critical answer');
  PERFORM app.withdraw_audit_finding(f4, 'Wrong record');
  PERFORM pg_temp.assert_eq(array_to_string(app.audit_record_problems(r3), ' | ') LIKE '%raise a finding for the failed critical question: 1%', true, 'a withdrawn finding no longer does');
  PERFORM pg_temp.logout();

  -- ---- edit ----
  PERFORM pg_temp.login(u_insp);
  PERFORM app.update_audit_finding(f2, format('{"title":"Swarf under the lathe","ownerId":"%s","dueOn":"%s","requirement":"5S standard"}', emp, current_date + 7)::jsonb);
  PERFORM pg_temp.assert_eq((SELECT title || '/' || (owner_employee_id = emp)::text || '/' || due_on || '/' || requirement FROM public.audit_findings WHERE id = f2), 'Swarf under the lathe/true/' || (current_date + 7) || '/5S standard', 'edited');
  PERFORM app.update_audit_finding(f2, '{"ownerId":null,"dueOn":null,"requirement":null}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT (owner_employee_id IS NULL)::text || '/' || (due_on IS NULL)::text || '/' || (requirement IS NULL)::text || '/' || title FROM public.audit_findings WHERE id = f2), 'true/true/true/Swarf under the lathe', 'null clears owner, due date and requirement; the rest stays');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.update_audit_finding(%L, '{"title":" "}'::jsonb)$q$, f2)) LIKE 'QM018: Give the finding a title%', true, 'the title cannot be emptied');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.update_audit_finding(%L, '{"description":""}'::jsonb)$q$, f2)) LIKE 'QM018: Say what was found%', true, 'nor the description');
  PERFORM app.update_audit_finding(f2, format('{"classificationId":"%s"}', pg_temp.cls(org, 'major_nc'))::jsonb);
  PERFORM pg_temp.assert_eq((SELECT classification_id = pg_temp.cls(org, 'major_nc') FROM public.audit_findings WHERE id = f2), true, 'reclassified');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.update_audit_finding(%L, '{"classificationId":"%s"}'::jsonb)$q$, f2, c_new)) LIKE 'QM018: The classification % is switched off%', true, 'not to a classification that is switched off');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_view);
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.update_audit_finding(%L, '{"title":"x"}'::jsonb)$q$, f2)) LIKE '42501:%', true, 'a viewer cannot edit');
  PERFORM pg_temp.logout();

  -- ---- promotion to a non-conformance ----
  PERFORM pg_temp.login(u_view);
  PERFORM pg_temp.assert_eq(pg_temp.fails(format('SELECT app.create_ncr_from_audit_finding(%L)', f1)) LIKE '42501:%', true, 'a viewer cannot raise an NC');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_insp);
  PERFORM pg_temp.assert_eq(pg_temp.fails(format('SELECT app.create_ncr_from_audit_finding(%L)', f3)) LIKE 'QM018: Only a finding classified as a non-conformity%', true, 'an opportunity for improvement is not raised as an NC');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.create_ncr_from_audit_finding(%L, NULL, NULL, 'huge')$q$, f1)) LIKE 'QM018: The severity must be%', true, 'a severity must be a real one');
  j := app.create_ncr_from_audit_finding(f1);
  ncr := (j->>'nonconformanceId')::uuid;
  PERFORM pg_temp.assert_eq((j->>'created')::boolean, true, 'created');
  PERFORM pg_temp.assert_eq((SELECT stage || '/' || source || '/' || severity || '/' || title || '/' || (site_id = site)::text || '/' || requirement || '/' || actual_result FROM public.nonconformances WHERE id = ncr),
    'draft/internal_audit/major/Guard missing/true/Machine guards are fitted at all times/The guard was not fitted on the lathe', 'a draft internal NC with the finding''s text, the severity of its classification and the site of the machine');
  PERFORM pg_temp.assert_eq((SELECT description FROM public.nonconformances WHERE id = ncr) LIKE 'Raised from audit AR-%, finding AF-%', true, 'the description says where it came from');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_ncr_links WHERE nonconformance_id = ncr AND finding_id = f1 AND response_id = resp1), 1::bigint, 'linked to the finding and its answer');
  j := app.create_ncr_from_audit_finding(f1, 'A different title');
  PERFORM pg_temp.assert_eq(((j->>'nonconformanceId')::uuid = ncr)::text || '/' || (j->>'created'), 'true/false', 'idempotent: the same NC comes back, created = false');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.nonconformances WHERE title IN ('Guard missing', 'A different title') AND organisation_id = org), 1::bigint, 'and no second NC exists');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_ncr_links WHERE finding_id = f1), 1::bigint, 'nor a second link');
  j := app.create_ncr_from_audit_finding(f2, 'Swarf', 'Housekeeping', 'critical');
  PERFORM pg_temp.assert_eq((SELECT severity || '/' || title || '/' || description FROM public.nonconformances WHERE id = (j->>'nonconformanceId')::uuid), 'critical/Swarf/Housekeeping', 'title, description and severity can be given');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.update_audit_finding(%L, '{"classificationId":"%s"}'::jsonb)$q$, f1, pg_temp.cls(org, 'observation'))) LIKE 'QM018: This finding has a non-conformance%', true, 'a finding with a live NC must stay a non-conformity');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.withdraw_audit_finding(%L, 'Raised in error')$q$, f1)) LIKE 'QM018: AF-%has a non-conformance%', true, 'and cannot be withdrawn');
  PERFORM pg_temp.logout();

  -- a deleted or cancelled draft frees the finding
  PERFORM pg_temp.login(u_owner);
  UPDATE public.nonconformances SET deleted_at = now(), delete_reason = 'Raised in error' WHERE id = ncr;
  j := app.create_ncr_from_audit_finding(f1);
  ncr2 := (j->>'nonconformanceId')::uuid;
  PERFORM pg_temp.assert_eq((ncr2 <> ncr)::text || '/' || (j->>'created'), 'true/true', 'a deleted NC frees the finding: a new one is created');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_ncr_links WHERE finding_id = f1), 2::bigint, 'the old link stays as history');

  -- a cancelled NC frees the finding as well
  j := app.create_ncr_from_audit_finding(f2);
  PERFORM pg_temp.assert_eq((j->>'created')::boolean, false, 'f2 already has its NC');
  UPDATE public.nonconformances SET quantity_affected = 3, stage = 'open', category_id = pg_temp.cat(org) WHERE id = (j->>'nonconformanceId')::uuid;
  UPDATE public.nonconformances SET stage = 'cancelled', stage_reason = 'Duplicate' WHERE id = (j->>'nonconformanceId')::uuid;
  j := app.create_ncr_from_audit_finding(f2);
  PERFORM pg_temp.assert_eq((j->>'created')::boolean, true, 'a cancelled NC frees the finding: a new one is created');

  -- ---- close and reopen ----
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_insp);
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.close_audit_finding(%L, 'Fixed')$q$, f3)) LIKE '42501:%', true, 'closing needs audits.manage');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_owner);
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.close_audit_finding(%L, ' ')$q$, f3)) LIKE 'QM018: Say how the finding was resolved%', true, 'closing needs a note');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.close_audit_finding(%L, 'Fixed')$q$, f1)) LIKE 'QM018: Close the non-conformance %first%', true, 'a finding whose NC is still open cannot be closed');
  PERFORM app.close_audit_finding(f3, 'Lights replaced');
  PERFORM pg_temp.assert_eq((SELECT status || '/' || closed_note || '/' || (closed_by = u_owner)::text FROM public.audit_findings WHERE id = f3), 'closed/Lights replaced/true', 'closed with a note, and who closed it');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_insp);
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.reopen_audit_finding(%L, 'Try')$q$, f3)) LIKE '42501:%', true, 'reopening needs audits.manage');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_owner);
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.update_audit_finding(%L, '{"title":"x"}'::jsonb)$q$, f3)) LIKE 'QM018: AF-%is closed%', true, 'a closed finding is frozen');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.reopen_audit_finding(%L, ' ')$q$, f3)) LIKE 'QM018: Say why the finding is reopened%', true, 'reopening needs a reason');
  PERFORM app.reopen_audit_finding(f3, 'Not actually fixed');
  PERFORM pg_temp.assert_eq((SELECT status || '/' || reopen_reason || '/' || (closed_note IS NULL)::text FROM public.audit_findings WHERE id = f3), 'open/Not actually fixed/true', 'reopened with the reason, the closing cleared');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.reopen_audit_finding(%L, 'again')$q$, f3)) LIKE 'QM018: AF-%only a closed finding can be reopened%', true, 'only a closed finding can be reopened');
  -- an NC that is closed lets the finding close
  UPDATE public.nonconformances SET quantity_affected = 5, stage = 'open', category_id = pg_temp.cat(org) WHERE id = ncr2;
  PERFORM pg_temp.settle_ncr(ncr2);
  UPDATE public.nonconformances SET stage = 'closed' WHERE id = ncr2;
  PERFORM app.close_audit_finding(f1, 'Guard fitted and verified');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.audit_findings WHERE id = f1), 'closed', 'a finding closes once its NC is closed');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format('SELECT app.create_ncr_from_audit_finding(%L)', f1)) LIKE 'QM018: AF-%is closed%', true, 'a closed finding is not raised as an NC');
  PERFORM pg_temp.logout();

  -- ---- findings after the record is completed; none once it is abandoned ----
  PERFORM pg_temp.login(u_insp);
  PERFORM app.complete_audit(r1);
  f4 := app.create_audit_finding(r1, resp3, pg_temp.cls(org, 'observation'), 'Late observation', 'Added at review');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.audit_findings WHERE id = f4), 'open', 'a finding can be added to a completed record');
  r2 := app.start_audit(def);
  f5 := app.create_audit_finding(r2, NULL, pg_temp.cls(org, 'ofi'), 'Idea', 'Noted before it was abandoned');
  PERFORM app.abandon_audit(r2, 'Started by mistake');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.update_audit_finding(%L, '{"title":"x"}'::jsonb)$q$, f5)) LIKE 'QM018: AR-%was abandoned%', true, 'a finding of an abandoned record is frozen');
  PERFORM pg_temp.assert_eq(app.audit_file_allowed(org::text || '/audit/' || r2::text || '/findings/' || f5::text || '/x.jpg', true), false, 'and takes no new files');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.create_audit_finding(%L, NULL, %L, 'x', 'y')$q$, r2, pg_temp.cls(org, 'ofi'))) LIKE 'QM018: AR-%was abandoned%', true, 'but not to an abandoned one');
  PERFORM pg_temp.logout();

  -- ---- evidence files ----
  PERFORM pg_temp.login(u_insp);
  path := org::text || '/audit/' || r1::text || '/findings/' || f4::text || '/' || gen_random_uuid()::text || '-photo.jpg';
  PERFORM pg_temp.assert_eq(app.audit_file_allowed(path, true), true, 'files may be uploaded into an open finding''s folder, even on a completed record');
  PERFORM pg_temp.assert_eq(app.audit_file_allowed(org::text || '/audit/' || r1::text || '/findings/' || f1::text || '/x.jpg', true), false, 'not into a closed finding''s');
  PERFORM pg_temp.assert_eq(app.audit_file_allowed(org::text || '/audit/' || r1::text || '/' || gen_random_uuid()::text || '-q.jpg', true), false, 'and a completed record''s question evidence still cannot be added to');
  PERFORM pg_temp.assert_eq(app.audit_file_allowed(org::text || '/audit/' || r2::text || '/findings/' || f4::text || '/x.jpg', true), false, 'a finding''s folder under an abandoned record is refused');
  PERFORM pg_temp.assert_eq(app.audit_file_allowed(org::text || '/audit/' || r3::text || '/findings/' || f4::text || '/x.jpg', true), false, 'and so is one under another record than the finding''s own');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.add_audit_finding_attachment(%L, %L, 'photo.jpg', 'image/jpeg', 100)$q$, f4, org::text || '/audit/' || r1::text || '/findings/' || f1::text || '/x.jpg')) LIKE 'QM018: The file must be stored in this finding%', true, 'a file must be in the finding''s own folder');
  att := app.add_audit_finding_attachment(f4, path, 'photo.jpg', 'image/jpeg', 2048);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_finding_attachments WHERE finding_id = f4 AND deleted_at IS NULL), 1::bigint, 'recorded');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.remove_audit_finding_attachment(%L, ' ')$q$, att)) LIKE 'QM018: Say why the file is removed%', true, 'removing needs a reason');
  PERFORM app.remove_audit_finding_attachment(att, 'Wrong photo');
  PERFORM pg_temp.assert_eq((SELECT delete_reason FROM public.audit_finding_attachments WHERE id = att), 'Wrong photo', 'removed, with the reason');
  PERFORM app.restore_audit_finding_attachment(att);
  PERFORM pg_temp.assert_eq((SELECT deleted_at IS NULL FROM public.audit_finding_attachments WHERE id = att), true, 'and restored');
  PERFORM pg_temp.assert_fails(format($q$DELETE FROM public.audit_finding_attachments WHERE id = %L$q$, att), 'never deleted');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.audit_finding_attachments SET file_name = 'other.jpg' WHERE id = %L$q$, att), 'nor changed');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.add_audit_finding_attachment(%L, %L, 'a.jpg', 'image/jpeg', 1)$q$, f1, org::text || '/audit/' || r1::text || '/findings/' || f1::text || '/a.jpg')) LIKE 'QM018: AF-%is closed%', true, 'no new file on a closed finding');
  -- files on a finding that is then closed can be neither removed nor put back
  att2 := app.add_audit_finding_attachment(f3, org::text || '/audit/' || r1::text || '/findings/' || f3::text || '/' || gen_random_uuid()::text || '-lamp.jpg', 'lamp.jpg', 'image/jpeg', 10);
  att3 := app.add_audit_finding_attachment(f3, org::text || '/audit/' || r1::text || '/findings/' || f3::text || '/' || gen_random_uuid()::text || '-lamp2.jpg', 'lamp2.jpg', 'image/jpeg', 10);
  PERFORM app.remove_audit_finding_attachment(att3, 'Wrong lamp');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_owner);
  PERFORM app.close_audit_finding(f3, 'Lights replaced again');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_insp);
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.remove_audit_finding_attachment(%L, 'Too late')$q$, att2)) LIKE 'QM018: AF-%is closed%', true, 'a file of a closed finding cannot be removed');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.restore_audit_finding_attachment(%L)$q$, att3)) LIKE 'QM018: AF-%is closed%', true, 'or put back');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_view);
  PERFORM pg_temp.assert_eq(app.audit_file_allowed(path, false), true, 'anyone who may read audits reads the file');
  PERFORM pg_temp.assert_eq(app.audit_file_allowed(path, true), false, 'but cannot upload');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_findings WHERE organisation_id = org) > 0, true, 'a viewer reads findings');
  PERFORM pg_temp.logout();

  -- ---- events, tenancy and audit trail ----
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.outbox_events WHERE organisation_id = org AND event_type = 'audit.finding.created'), 7::bigint, 'an event is written for every finding');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.outbox_events WHERE organisation_id = org AND event_type = 'audit.finding.ncr_created'), 4::bigint, 'and for every NC raised from one');
  PERFORM pg_temp.login(u_other);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_findings) + (SELECT count(*) FROM public.audit_finding_attachments), 0::bigint, 'another organisation sees no findings');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_finding_classifications WHERE organisation_id = org), 0::bigint, 'nor the classifications');
  PERFORM pg_temp.assert_eq(app.audit_file_allowed(path, false), false, 'nor the files');
  PERFORM pg_temp.logout();
  SELECT count(*) INTO n FROM public.audit_events WHERE organisation_id = org AND entity_type IN ('audit_findings', 'audit_finding_attachments', 'audit_finding_classifications');
  PERFORM pg_temp.assert_eq(n > 0, true, 'findings, files and classifications are audited');
END $$;

ROLLBACK;
