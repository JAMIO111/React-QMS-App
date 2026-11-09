-- Audits, AU1: definitions (header under RLS, checklist and "relevant to" list only through functions), numbering, frequency and auditor rules, who may do what, and isolation.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('38000000-0000-0000-0000-000000000601', 'owner@aud.test'), ('38000000-0000-0000-0000-000000000602', 'eng@aud.test'), ('38000000-0000-0000-0000-000000000603', 'inspector@aud.test'),
  ('38000000-0000-0000-0000-000000000604', 'viewer@aud.test'), ('38000000-0000-0000-0000-000000000605', 'other@aud.test'), ('38000000-0000-0000-0000-000000000606', 'invited@aud.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  u_owner uuid := '38000000-0000-0000-0000-000000000601'; u_eng uuid := '38000000-0000-0000-0000-000000000602'; u_insp uuid := '38000000-0000-0000-0000-000000000603';
  u_view uuid := '38000000-0000-0000-0000-000000000604'; u_other uuid := '38000000-0000-0000-0000-000000000605'; u_inv uuid := '38000000-0000-0000-0000-000000000606';
  org uuid; org2 uuid; m uuid; site uuid; dept uuid; mach uuid; mach2 uuid; role_id uuid; a1 uuid; a2 uuid; a3 uuid; r text; n int;
BEGIN
  PERFORM pg_temp.login(u_owner);
  org := app.create_organisation('Audit Works', 'Plant A', 'PA', NULL);
  SELECT id INTO site FROM public.sites WHERE organisation_id = org;
  INSERT INTO public.departments (organisation_id, site_id, code, name) VALUES (org, site, 'MACH', 'Machining') RETURNING id INTO dept;
  INSERT INTO public.machines (organisation_id, code, name, site_id) VALUES (org, 'CNC-1', 'Lathe', site) RETURNING id INTO mach;
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_other);
  org2 := app.create_organisation('Other Works', 'Plant B', 'PB', NULL);
  INSERT INTO public.machines (organisation_id, code, name) VALUES (org2, 'OTH-1', 'Other lathe') RETURNING id INTO mach2;
  PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u_eng, 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'quality_engineer';
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u_insp, 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'inspector';
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u_view, 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u_inv, 'invited');
  SELECT id INTO role_id FROM public.roles WHERE organisation_id = org AND key = 'inspector';

  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.role_permissions rp JOIN public.roles r ON r.id = rp.role_id WHERE r.organisation_id = org AND rp.permission_code = 'audits.manage'), 4::bigint, 'owner, admin, quality manager and quality engineer manage audits');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.role_permissions rp JOIN public.roles r ON r.id = rp.role_id WHERE r.organisation_id = org AND rp.permission_code = 'audits.perform'), 5::bigint, 'and the inspector may also perform them');

  -- ---- who may write the header ----
  PERFORM pg_temp.login(u_insp);
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.audit_definitions (organisation_id, title, audit_type, frequency_kind, first_due_on) VALUES (%L, 'x', 'process', 'weekly', current_date)$q$, org), 'an inspector cannot define audits');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_eng);
  INSERT INTO public.audit_definitions (organisation_id, audit_number, reference, title, audit_type, frequency_kind, first_due_on, status, retired_at, retired_reason)
    VALUES (org, 99, 'HACK', ' Layered process audit ', 'layered_process', 'weekly', current_date, 'retired', now(), 'x') RETURNING id INTO a1;
  PERFORM pg_temp.assert_eq((SELECT reference || '/' || audit_number || '/' || status FROM public.audit_definitions WHERE id = a1), 'AUD-001/1/active', 'numbered by the database, always active when made');
  INSERT INTO public.audit_definitions (organisation_id, title, audit_type, frequency_kind, first_due_on, grace_days, pass_mark) VALUES (org, 'Housekeeping', 'housekeeping', 'daily', current_date, 1, 90) RETURNING id INTO a2;
  PERFORM pg_temp.assert_eq((SELECT reference FROM public.audit_definitions WHERE id = a2), 'AUD-002', 'the next number follows');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.audit_definitions SET status = 'retired' WHERE id = %L$q$, a1), 'status moves only with the retire function');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.audit_definitions SET reference = 'AUD-050' WHERE id = %L$q$, a1), 'the number is not writable');
  PERFORM pg_temp.assert_fails(format($q$DELETE FROM public.audit_definitions WHERE id = %L$q$, a1), 'nothing is deleted');
  UPDATE public.audit_definitions SET title = 'Layered process audit, CNC', procedure = '1. Walk the cell. 2. Check each item.', pass_mark = 95 WHERE id = a1;
  PERFORM pg_temp.assert_eq((SELECT pass_mark FROM public.audit_definitions WHERE id = a1), 95, 'a definition can be edited');

  -- ---- frequency and auditor rules ----
  r := pg_temp.fails(format($q$INSERT INTO public.audit_definitions (organisation_id, title, audit_type, frequency_kind) VALUES (%L, 'x', 'process', 'monthly')$q$, org));
  PERFORM pg_temp.assert_eq(r LIKE '23514%', true, 'a scheduled audit needs a first due date: ' || r);
  r := pg_temp.fails(format($q$INSERT INTO public.audit_definitions (organisation_id, title, audit_type, frequency_kind, first_due_on) VALUES (%L, 'x', 'process', 'on_demand', current_date)$q$, org));
  PERFORM pg_temp.assert_eq(r LIKE '23514%', true, 'an on-demand audit has no first due date: ' || r);
  r := pg_temp.fails(format($q$INSERT INTO public.audit_definitions (organisation_id, title, audit_type, frequency_kind, first_due_on) VALUES (%L, 'x', 'process', 'every_n_days', current_date)$q$, org));
  PERFORM pg_temp.assert_eq(r LIKE '23514%', true, 'every N days needs N: ' || r);
  INSERT INTO public.audit_definitions (organisation_id, title, audit_type, frequency_kind, first_due_on, frequency_interval) VALUES (org, 'Every ten days', 'system', 'every_n_days', current_date, 10);
  INSERT INTO public.audit_definitions (organisation_id, title, audit_type, frequency_kind) VALUES (org, 'When asked', 'other', 'on_demand');
  r := pg_temp.fails(format($q$INSERT INTO public.audit_definitions (organisation_id, title, audit_type, frequency_kind, first_due_on, auditor_kind) VALUES (%L, 'x', 'process', 'weekly', current_date, 'person')$q$, org));
  PERFORM pg_temp.assert_eq(r LIKE '23514%', true, 'a named person must be given: ' || r);
  r := pg_temp.fails(format($q$UPDATE public.audit_definitions SET auditor_kind = 'person', auditor_user_id = %L WHERE id = %L$q$, u_inv, a1));
  PERFORM pg_temp.assert_eq(r LIKE 'QM018: The auditor must be an active member%', true, 'an invited person is not an auditor yet: ' || r);
  r := pg_temp.fails(format($q$UPDATE public.audit_definitions SET auditor_kind = 'person', auditor_user_id = %L WHERE id = %L$q$, u_other, a1));
  PERFORM pg_temp.assert_eq(r LIKE 'QM018: The auditor must be an active member%', true, 'nor is someone from another organisation: ' || r);
  UPDATE public.audit_definitions SET auditor_kind = 'person', auditor_user_id = u_insp WHERE id = a1;
  UPDATE public.audit_definitions SET auditor_kind = 'role', auditor_user_id = NULL, auditor_role_id = role_id WHERE id = a1;
  UPDATE public.audit_definitions SET auditor_kind = 'department', auditor_role_id = NULL, auditor_department_id = dept WHERE id = a1;
  PERFORM pg_temp.assert_eq((SELECT auditor_kind FROM public.audit_definitions WHERE id = a1), 'department', 'a person, a role or a department can be expected');

  -- ---- the checklist ----
  PERFORM app.set_audit_checklist(a1, '[
    {"question":"Is the cell clean and free of oil?","answerType":"pass_fail","critical":true,"guidance":"Floor, bench, machine"},
    {"question":"Is the first-off sheet signed?","answerType":"yes_no_na","passAnswer":"yes"},
    {"question":"Coolant concentration","answerType":"numeric","unit":"%","lowerLimit":6,"upperLimit":9,"critical":false},
    {"question":"Anything else seen?","answerType":"text"}]'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT string_agg(sequence || answer_type || critical::text, ',' ORDER BY sequence) FROM public.audit_questions WHERE audit_definition_id = a1),
    '1pass_failtrue,2yes_no_nafalse,3numericfalse,4textfalse', 'the checklist is stored in order');
  PERFORM pg_temp.assert_eq((SELECT pass_answer FROM public.audit_questions WHERE audit_definition_id = a1 AND sequence = 2), 'yes', 'a yes/no question knows which answer passes');
  PERFORM app.set_audit_checklist(a1, '[{"question":"Only one now","answerType":"pass_fail"}]'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_questions WHERE audit_definition_id = a1), 1::bigint, 'saving replaces the whole checklist');
  r := pg_temp.fails(format($q$SELECT app.set_audit_checklist(%L, '[{"question":"x","answerType":"numeric","critical":true}]'::jsonb)$q$, a1));
  PERFORM pg_temp.assert_eq(r LIKE 'QM018: Question 1: it cannot be critical unless it can fail%', true, 'a numeric question with no limit cannot be critical: ' || r);
  r := pg_temp.fails(format($q$SELECT app.set_audit_checklist(%L, '[{"question":"x","answerType":"text","critical":true}]'::jsonb)$q$, a1));
  PERFORM pg_temp.assert_eq(r LIKE 'QM018: Question 1: it cannot be critical unless it can fail%', true, 'a note is never critical: ' || r);
  r := pg_temp.fails(format($q$SELECT app.set_audit_checklist(%L, '[{"question":"  ","answerType":"pass_fail"}]'::jsonb)$q$, a1));
  PERFORM pg_temp.assert_eq(r LIKE 'QM018: Question 1: write the question%', true, 'a question needs words: ' || r);
  r := pg_temp.fails(format($q$SELECT app.set_audit_checklist(%L, '[{"question":"x","answerType":"nonsense"}]'::jsonb)$q$, a1));
  PERFORM pg_temp.assert_eq(r LIKE 'QM018: Question 1: choose how it is answered%', true, 'an unknown answer type is refused: ' || r);
  r := pg_temp.fails(format($q$SELECT app.set_audit_checklist(%L, (SELECT jsonb_agg(jsonb_build_object('question','q','answerType','pass_fail')) FROM generate_series(1,101)))$q$, a1));
  PERFORM pg_temp.assert_eq(r LIKE 'QM018: A checklist can have at most 100 questions%', true, 'a checklist has a limit: ' || r);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_questions WHERE audit_definition_id = a1), 1::bigint, 'a refused checklist changes nothing');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.audit_questions (organisation_id, audit_definition_id, sequence, question, answer_type) VALUES (%L, %L, 9, 'x', 'pass_fail')$q$, org, a1), 'questions cannot be written directly');

  -- ---- relevant to ----
  PERFORM app.set_audit_targets(a1, jsonb_build_array(jsonb_build_object('kind','machine','machineId',mach), jsonb_build_object('kind','operation','operationCode','OP-20'), jsonb_build_object('kind','department','departmentId',dept)));
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_targets WHERE audit_definition_id = a1), 3::bigint, 'a machine, an operation and a department');
  r := pg_temp.fails(format($q$SELECT app.set_audit_targets(%L, '[{"kind":"operation","operationCode":"OP-20"},{"kind":"operation","operationCode":"op-20"}]'::jsonb)$q$, a1));
  PERFORM pg_temp.assert_eq(r LIKE 'QM018: The same machine, operation, department or supplier is listed twice%', true, 'an operation twice, in any case: ' || r);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_targets WHERE audit_definition_id = a1), 3::bigint, 'a refused list changes nothing');
  r := pg_temp.fails(format($q$SELECT app.set_audit_targets(%L, jsonb_build_array(jsonb_build_object('kind','machine','machineId',%L)))$q$, a1, mach2));
  PERFORM pg_temp.assert_eq(r LIKE 'P0002:%', true, 'another organisation''s machine is not found: ' || r);
  PERFORM app.set_audit_targets(a1, '[]'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_targets WHERE audit_definition_id = a1), 0::bigint, 'the list can be emptied');
  PERFORM app.set_audit_targets(a1, jsonb_build_array(jsonb_build_object('kind','machine','machineId',mach)));
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.audit_targets (organisation_id, audit_definition_id, kind, operation_code) VALUES (%L, %L, 'operation', 'OP-1')$q$, org, a1), 'targets cannot be written directly');
  PERFORM pg_temp.logout();

  -- ---- retire and reactivate ----
  PERFORM pg_temp.login(u_insp);
  PERFORM pg_temp.assert_eq(pg_temp.fails(format('SELECT app.retire_audit_definition(%L, ''x'')', a1)) LIKE '42501:%', true, 'an inspector cannot retire an audit');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.set_audit_checklist(%L, '[]'::jsonb)$q$, a1)) LIKE '42501:%', true, 'nor change its checklist');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_definitions WHERE organisation_id = org), 4::bigint, 'but can read the audits');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_questions WHERE organisation_id = org), 1::bigint, 'and the checklist');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_view);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_definitions WHERE organisation_id = org), 4::bigint, 'a viewer reads the audits');
  PERFORM pg_temp.assert_eq(pg_temp.affected(format($q$UPDATE public.audit_definitions SET title = 'Hijacked' WHERE id = %L$q$, a1)), 0::bigint, 'and cannot change one');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_eng);
  PERFORM pg_temp.assert_eq(pg_temp.fails(format('SELECT app.retire_audit_definition(%L, ''  '')', a1)) LIKE 'QM018: Give a reason%', true, 'retiring needs a reason');
  PERFORM app.retire_audit_definition(a1, 'Replaced by the new LPA');
  PERFORM pg_temp.assert_eq((SELECT status || '/' || (retired_by = u_eng)::text FROM public.audit_definitions WHERE id = a1), 'retired/true', 'retired, with who');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format('SELECT app.retire_audit_definition(%L, ''again'')', a1)) LIKE 'QM018: AUD-001 is already retired%', true, 'not twice');
  PERFORM app.reactivate_audit_definition(a1);
  PERFORM pg_temp.assert_eq((SELECT status || '/' || (retired_at IS NULL)::text FROM public.audit_definitions WHERE id = a1), 'active/true', 'reactivated');
  PERFORM pg_temp.logout();

  -- ---- isolation and audit trail ----
  PERFORM pg_temp.login(u_other);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_definitions), 0::bigint, 'another organisation sees none of them');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format('SELECT app.retire_audit_definition(%L, ''x'')', a1)) LIKE 'P0002:%', true, 'and cannot find them to retire');
  PERFORM pg_temp.logout();
  SELECT count(*) INTO n FROM public.audit_events WHERE organisation_id = org AND entity_type = 'audit_definitions' AND action = 'update';
  PERFORM pg_temp.assert_eq(n > 0, true, 'changes to a definition are audited');
  PERFORM pg_temp.assert_eq((SELECT count(*) > 0 FROM public.audit_events WHERE organisation_id = org AND entity_type = 'audit_questions'), true, 'and so is the checklist');
END $$;

ROLLBACK;
