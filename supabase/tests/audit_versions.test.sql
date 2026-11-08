-- Audits: versioned templates. Every change to what a record freezes is a new, numbered version with a reason; the database refuses an unrecorded change; records remember
-- their version; versions are never changed; and an audit that existed before versions got version 1 from its current content (fixture 20251218100000).
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('39000000-0000-0000-0000-000000000701', 'owner@ver.test'), ('39000000-0000-0000-0000-000000000702', 'eng@ver.test'), ('39000000-0000-0000-0000-000000000703', 'inspector@ver.test'),
  ('39000000-0000-0000-0000-000000000704', 'viewer@ver.test'), ('39000000-0000-0000-0000-000000000705', 'other@ver.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

-- What would happen at the end of the transaction: the deferred "is it saved as a version?" check, run now. Back to deferred afterwards.
CREATE FUNCTION pg_temp.settle() RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  SET CONSTRAINTS ALL DEFERRED;
  RETURN SQLSTATE || ': ' || SQLERRM;
END $$;

DO $$
DECLARE
  u_owner uuid := '39000000-0000-0000-0000-000000000701'; u_eng uuid := '39000000-0000-0000-0000-000000000702'; u_insp uuid := '39000000-0000-0000-0000-000000000703';
  u_view uuid := '39000000-0000-0000-0000-000000000704'; u_other uuid := '39000000-0000-0000-0000-000000000705';
  org uuid; org2 uuid; m uuid; site uuid; dept uuid; mach uuid; mach2 uuid; mach3 uuid; a1 uuid; a2 uuid; fx uuid; rec uuid; rec2 uuid; rec3 uuid; v integer; r text; vid uuid;
  base jsonb;
BEGIN
  -- ---- an audit that existed before versions (fixture) ----
  SELECT id INTO fx FROM public.audit_definitions WHERE title = 'Fixture audit';
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_versions WHERE audit_definition_id = fx), 1::bigint, 'an existing audit got exactly one version');
  PERFORM pg_temp.assert_eq((SELECT version || '/' || reason FROM public.audit_versions WHERE audit_definition_id = fx), '1/Existing audit, before versions were kept', 'version 1 says it was made for an existing audit');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_version_questions q JOIN public.audit_versions v ON v.id = q.audit_version_id WHERE v.audit_definition_id = fx), 2::bigint, 'with the questions it had');
  PERFORM pg_temp.assert_eq((SELECT content_hash FROM public.audit_versions WHERE audit_definition_id = fx), app.audit_content_hash(fx), 'and its fingerprint is the current one');
  PERFORM pg_temp.assert_eq((SELECT audit_version FROM public.audit_records WHERE reference = 'FIX-AR-SAME'), 1, 'a record that froze the same content is linked to version 1');
  PERFORM pg_temp.assert_eq((SELECT audit_version FROM public.audit_records WHERE reference = 'FIX-AR-OLD'), NULL::integer, 'a record that froze something else is not linked: nothing is guessed');
  PERFORM pg_temp.assert_eq((SELECT audit_version_id FROM public.audit_records WHERE reference = 'FIX-AR-OLD'), NULL::uuid, 'neither its link');
  PERFORM pg_temp.assert_eq((SELECT audit_version FROM public.audit_records WHERE reference = 'FIX-AR-WORDS'), NULL::integer, 'nor one that froze the same header but another wording of a question');

  PERFORM pg_temp.login(u_owner);
  org := app.create_organisation('Version Works', 'Plant A', 'PA', NULL);
  SELECT id INTO site FROM public.sites WHERE organisation_id = org;
  INSERT INTO public.departments (organisation_id, site_id, code, name) VALUES (org, site, 'MACH', 'Machining') RETURNING id INTO dept;
  INSERT INTO public.machines (organisation_id, code, name, site_id) VALUES (org, 'CNC-1', 'Lathe', site) RETURNING id INTO mach;
  INSERT INTO public.machines (organisation_id, code, name, site_id) VALUES (org, 'CNC-2', 'Mill', site) RETURNING id INTO mach3;
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_other);
  org2 := app.create_organisation('Other Works', 'Plant B', 'PB', NULL);
  PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u_eng, 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'quality_engineer';
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u_insp, 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'inspector';
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u_view, 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'viewer';

  base := '[{"question":"Is the cell clean?","answerType":"pass_fail","critical":true},{"question":"Coolant concentration","answerType":"numeric","unit":"%","lowerLimit":6,"upperLimit":9}]';

  -- ---- a new audit has to be saved as version 1 ----
  PERFORM pg_temp.login(u_eng);
  INSERT INTO public.audit_definitions (organisation_id, title, audit_type, frequency_kind, first_due_on, pass_mark, procedure)
    VALUES (org, 'Layered process audit', 'layered_process', 'weekly', current_date, 90, 'Walk the cell.') RETURNING id INTO a1;
  PERFORM app.set_audit_checklist(a1, base);
  PERFORM app.set_audit_targets(a1, jsonb_build_array(jsonb_build_object('kind', 'machine', 'machineId', mach)));
  PERFORM pg_temp.assert_eq(app.audit_content_changed(a1), true, 'an audit with no version has unsaved content');
  r := pg_temp.settle();
  PERFORM pg_temp.assert_eq(r LIKE 'QM018: A change to an audit is saved as a new version, with a reason%', true, 'a new audit without a version is refused when the transaction ends: ' || r);
  v := app.save_audit_version(a1, NULL);
  PERFORM pg_temp.assert_eq(v, 1, 'the first version is 1');
  PERFORM pg_temp.assert_eq((SELECT reason FROM public.audit_versions WHERE audit_definition_id = a1 AND version = 1), 'First version', 'it needs no reason and says so');
  PERFORM pg_temp.assert_eq(pg_temp.settle(), 'ok', 'and now the transaction may end');
  PERFORM pg_temp.assert_eq(app.audit_content_changed(a1), false, 'nothing is unsaved');
  PERFORM pg_temp.assert_eq((SELECT title || '/' || audit_type || '/' || pass_mark || '/' || procedure FROM public.audit_versions WHERE audit_definition_id = a1 AND version = 1), 'Layered process audit/layered_process/90/Walk the cell.', 'the header is copied');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_version_questions q JOIN public.audit_versions x ON x.id = q.audit_version_id WHERE x.audit_definition_id = a1 AND x.version = 1), 2::bigint, 'the questions are copied');
  PERFORM pg_temp.assert_eq((SELECT t.label FROM public.audit_version_targets t JOIN public.audit_versions x ON x.id = t.audit_version_id WHERE x.audit_definition_id = a1 AND x.version = 1), 'CNC-1 · Lathe', 'and what it is relevant to, with its label');
  PERFORM pg_temp.assert_eq((SELECT created_by FROM public.audit_versions WHERE audit_definition_id = a1 AND version = 1), u_eng, 'who made it is kept');
  PERFORM pg_temp.assert_eq((SELECT length(content_hash) FROM public.audit_versions WHERE audit_definition_id = a1 AND version = 1), 32, 'with the fingerprint of what it holds');
  r := pg_temp.fails(format($q$SELECT app.save_audit_version(%L, 'again')$q$, a1));
  PERFORM pg_temp.assert_eq(r LIKE 'QM018: Nothing has changed since version 1%', true, 'saving with nothing changed is refused: ' || r);

  -- ---- changing the header: a reason is needed ----
  UPDATE public.audit_definitions SET title = 'Layered process audit, CNC cell', pass_mark = 95 WHERE id = a1;
  PERFORM pg_temp.assert_eq(app.audit_content_changed(a1), true, 'a new title is unsaved content');
  r := pg_temp.settle();
  PERFORM pg_temp.assert_eq(r LIKE 'QM018: A change to an audit is saved as a new version, with a reason%', true, 'an unrecorded change is refused: ' || r);
  r := pg_temp.fails(format($q$SELECT app.save_audit_version(%L, NULL)$q$, a1));
  PERFORM pg_temp.assert_eq(r LIKE 'QM018: Give a reason for the change to the audit%', true, 'a change needs a reason: ' || r);
  r := pg_temp.fails(format($q$SELECT app.save_audit_version(%L, '   ')$q$, a1));
  PERFORM pg_temp.assert_eq(r LIKE 'QM018: Give a reason for the change to the audit%', true, 'spaces are not a reason: ' || r);
  r := pg_temp.fails(format($q$SELECT app.save_audit_version(%L, %L)$q$, a1, repeat('x', 1001)));
  PERFORM pg_temp.assert_eq(r LIKE 'QM018: The reason can be at most 1000 characters%', true, 'a reason has a limit: ' || r);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_versions WHERE audit_definition_id = a1), 1::bigint, 'the refused saves made nothing');
  v := app.save_audit_version(a1, '  Raised the pass mark after the January audit ');
  PERFORM pg_temp.assert_eq(v, 2, 'the next version is 2');
  PERFORM pg_temp.assert_eq((SELECT reason FROM public.audit_versions WHERE audit_definition_id = a1 AND version = 2), 'Raised the pass mark after the January audit', 'the reason is kept, trimmed');
  PERFORM pg_temp.assert_eq(pg_temp.settle(), 'ok', 'and the transaction may end');
  PERFORM pg_temp.assert_eq((SELECT title || '/' || pass_mark FROM public.audit_versions WHERE audit_definition_id = a1 AND version = 2), 'Layered process audit, CNC cell/95', 'version 2 holds the new header');
  PERFORM pg_temp.assert_eq((SELECT title || '/' || pass_mark FROM public.audit_versions WHERE audit_definition_id = a1 AND version = 1), 'Layered process audit/90', 'version 1 is as it was');

  -- ---- the pass mark on its own ----
  UPDATE public.audit_definitions SET pass_mark = 96 WHERE id = a1;
  PERFORM pg_temp.assert_eq(app.audit_content_changed(a1), true, 'the pass mark alone is a change');
  UPDATE public.audit_definitions SET pass_mark = 95 WHERE id = a1;
  PERFORM pg_temp.assert_eq(app.audit_content_changed(a1), false, 'put back, it is not');

  -- ---- what is not part of a version ----
  UPDATE public.audit_definitions SET grace_days = 2, frequency_kind = 'monthly', weekdays_only = true WHERE id = a1;
  PERFORM pg_temp.assert_eq(app.audit_content_changed(a1), false, 'the schedule is not content');
  PERFORM pg_temp.assert_eq(pg_temp.settle(), 'ok', 'changing it needs no version');
  PERFORM app.retire_audit_definition(a1, 'Paused for the shutdown');
  PERFORM pg_temp.assert_eq(pg_temp.settle(), 'ok', 'nor does retiring');
  PERFORM app.reactivate_audit_definition(a1);
  r := pg_temp.fails(format($q$SELECT app.save_audit_version(%L, 'nothing')$q$, a1));
  PERFORM pg_temp.assert_eq(r LIKE 'QM018: Nothing has changed since version 2%', true, 'and a version with only a schedule change is refused: ' || r);

  -- ---- the checklist ----
  PERFORM app.set_audit_checklist(a1, base || '[{"question":"Is the floor clear?","answerType":"yes_no_na","passAnswer":"yes"}]'::jsonb);
  r := pg_temp.settle();
  PERFORM pg_temp.assert_eq(r LIKE 'QM018: A change to an audit is saved as a new version%', true, 'a new question is refused until saved: ' || r);
  v := app.save_audit_version(a1, 'Added a question about the floor');
  PERFORM pg_temp.assert_eq(v, 3, 'version 3');
  PERFORM pg_temp.assert_eq(pg_temp.settle(), 'ok', 'settled');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_version_questions q JOIN public.audit_versions x ON x.id = q.audit_version_id WHERE x.audit_definition_id = a1 AND x.version = 3), 3::bigint, 'version 3 has three questions');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_version_questions q JOIN public.audit_versions x ON x.id = q.audit_version_id WHERE x.audit_definition_id = a1 AND x.version = 2), 2::bigint, 'version 2 still has two');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_version_questions q JOIN public.audit_versions x ON x.id = q.audit_version_id WHERE x.audit_definition_id = a1 AND x.version = 1), 2::bigint, 'and version 1');
  -- The same checklist written again changes nothing.
  PERFORM app.set_audit_checklist(a1, base || '[{"question":"Is the floor clear?","answerType":"yes_no_na","passAnswer":"yes"}]'::jsonb);
  PERFORM pg_temp.assert_eq(app.audit_content_changed(a1), false, 'rewriting the same checklist is not a change');
  PERFORM pg_temp.assert_eq(pg_temp.settle(), 'ok', 'and needs no version');
  -- Changing one limit, then the critical flag, then the order are each changes.
  PERFORM app.set_audit_checklist(a1, '[{"question":"Is the cell clean?","answerType":"pass_fail","critical":true},{"question":"Coolant concentration","answerType":"numeric","unit":"%","lowerLimit":6,"upperLimit":9.5},{"question":"Is the floor clear?","answerType":"yes_no_na","passAnswer":"yes"}]');
  PERFORM pg_temp.assert_eq(app.audit_content_changed(a1), true, 'a different limit is a change');
  PERFORM app.set_audit_checklist(a1, '[{"question":"Is the cell clean?","answerType":"pass_fail","critical":false},{"question":"Coolant concentration","answerType":"numeric","unit":"%","lowerLimit":6,"upperLimit":9},{"question":"Is the floor clear?","answerType":"yes_no_na","passAnswer":"yes"}]');
  PERFORM pg_temp.assert_eq(app.audit_content_changed(a1), true, 'the critical flag is a change');
  PERFORM app.set_audit_checklist(a1, '[{"question":"Coolant concentration","answerType":"numeric","unit":"%","lowerLimit":6,"upperLimit":9},{"question":"Is the cell clean?","answerType":"pass_fail","critical":true},{"question":"Is the floor clear?","answerType":"yes_no_na","passAnswer":"yes"}]');
  PERFORM pg_temp.assert_eq(app.audit_content_changed(a1), true, 'the order is a change');
  v := app.save_audit_version(a1, 'Coolant first on the walk');
  PERFORM pg_temp.assert_eq(v, 4, 'version 4');
  PERFORM pg_temp.assert_eq((SELECT question FROM public.audit_version_questions q JOIN public.audit_versions x ON x.id = q.audit_version_id WHERE x.audit_definition_id = a1 AND x.version = 4 AND q.sequence = 1), 'Coolant concentration', 'in its new order');
  PERFORM pg_temp.assert_eq((SELECT question FROM public.audit_version_questions q JOIN public.audit_versions x ON x.id = q.audit_version_id WHERE x.audit_definition_id = a1 AND x.version = 3 AND q.sequence = 1), 'Is the cell clean?', 'and version 3 in the old one');

  -- ---- what it is relevant to ----
  PERFORM app.set_audit_targets(a1, jsonb_build_array(jsonb_build_object('kind', 'machine', 'machineId', mach), jsonb_build_object('kind', 'operation', 'operationCode', 'OP-10'), jsonb_build_object('kind', 'department', 'departmentId', dept)));
  PERFORM pg_temp.assert_eq(app.audit_content_changed(a1), true, 'more things it is relevant to is a change');
  r := pg_temp.settle();
  PERFORM pg_temp.assert_eq(r LIKE 'QM018:%', true, 'refused until saved: ' || r);
  v := app.save_audit_version(a1, 'Now also covers OP-10 and the department');
  PERFORM pg_temp.assert_eq(v, 5, 'version 5');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_version_targets t JOIN public.audit_versions x ON x.id = t.audit_version_id WHERE x.audit_definition_id = a1 AND x.version = 5), 3::bigint, 'version 5 lists three');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_version_targets t JOIN public.audit_versions x ON x.id = t.audit_version_id WHERE x.audit_definition_id = a1 AND x.version = 4), 1::bigint, 'version 4 lists one');
  PERFORM pg_temp.assert_eq((SELECT string_agg(t.label, ', ' ORDER BY t.label) FROM public.audit_version_targets t JOIN public.audit_versions x ON x.id = t.audit_version_id WHERE x.audit_definition_id = a1 AND x.version = 5), 'CNC-1 · Lathe, MACH · Machining, OP-10', 'with their labels');
  PERFORM app.set_audit_targets(a1, jsonb_build_array(jsonb_build_object('kind', 'department', 'departmentId', dept), jsonb_build_object('kind', 'operation', 'operationCode', 'op-10'), jsonb_build_object('kind', 'machine', 'machineId', mach)));
  PERFORM pg_temp.assert_eq(app.audit_content_changed(a1), false, 'the same things in another order, or another case, are not a change');
  PERFORM app.set_audit_targets(a1, jsonb_build_array(jsonb_build_object('kind', 'department', 'departmentId', dept), jsonb_build_object('kind', 'operation', 'operationCode', 'OP-10'), jsonb_build_object('kind', 'machine', 'machineId', mach3)));
  PERFORM pg_temp.assert_eq(app.audit_content_changed(a1), true, 'a different machine, with the same number of things listed, is a change');
  PERFORM app.set_audit_targets(a1, jsonb_build_array(jsonb_build_object('kind', 'department', 'departmentId', dept), jsonb_build_object('kind', 'operation', 'operationCode', 'OP-10'), jsonb_build_object('kind', 'machine', 'machineId', mach)));
  PERFORM pg_temp.assert_eq(app.audit_content_changed(a1), false, 'and putting it back is not');
  UPDATE public.audit_definitions SET purpose = 'Make sure the cell is run as written.' WHERE id = a1;
  v := app.save_audit_version(a1, 'Added a purpose');
  PERFORM pg_temp.assert_eq(v, 6, 'the purpose is part of a version too');
  PERFORM pg_temp.assert_eq(pg_temp.settle(), 'ok', 'settled');

  -- ---- nothing is written directly ----
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.audit_versions (organisation_id, audit_definition_id, version, reason, content_hash, title, audit_type, pass_mark) VALUES (%L, %L, 99, 'x', 'x', 'x', 'process', 90)$q$, org, a1), 'versions cannot be inserted directly');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.audit_versions SET reason = 'rewritten' WHERE audit_definition_id = %L$q$, a1), 'nor changed');
  PERFORM pg_temp.assert_fails(format($q$DELETE FROM public.audit_versions WHERE audit_definition_id = %L$q$, a1), 'nor deleted');
  PERFORM pg_temp.assert_fails($q$UPDATE public.audit_version_questions SET question = 'rewritten'$q$, 'their questions cannot be changed');
  PERFORM pg_temp.assert_fails($q$DELETE FROM public.audit_version_questions$q$, 'or deleted');
  PERFORM pg_temp.assert_fails($q$UPDATE public.audit_version_targets SET label = 'rewritten'$q$, 'their targets cannot be changed');
  PERFORM pg_temp.assert_fails($q$DELETE FROM public.audit_version_targets$q$, 'or deleted');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.snapshot_audit_version(%L, 50, 'sneaky')$q$, a1), 'the snapshot function is not callable by users');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.ensure_audit_version(%L)$q$, a1), 'neither is the one that starts an audit');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.outbox_events WHERE organisation_id = org AND event_type = 'audit.version_saved'), 6::bigint, 'each version was announced');

  -- ---- who may do what ----
  PERFORM pg_temp.login(u_insp);
  r := pg_temp.fails(format($q$SELECT app.save_audit_version(%L, 'I think so')$q$, a1));
  PERFORM pg_temp.assert_eq(r LIKE '42501:%', true, 'carrying out audits is not enough to change one: ' || r);
  PERFORM pg_temp.assert_eq(pg_temp.count_rows(format('SELECT 1 FROM public.audit_versions WHERE audit_definition_id = %L', a1)), 6::bigint, 'but the history can be read');
  PERFORM pg_temp.assert_eq(app.audit_content_changed(a1), false, 'and so can whether something is unsaved');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_view);
  PERFORM pg_temp.assert_eq(pg_temp.count_rows(format('SELECT 1 FROM public.audit_version_questions q JOIN public.audit_versions x ON x.id = q.audit_version_id WHERE x.audit_definition_id = %L', a1)), 16::bigint, 'a viewer reads every version''s questions');
  r := pg_temp.fails(format($q$SELECT app.save_audit_version(%L, 'x')$q$, a1));
  PERFORM pg_temp.assert_eq(r LIKE '42501:%', true, 'a viewer cannot save one: ' || r);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_other);
  PERFORM pg_temp.assert_eq(pg_temp.count_rows('SELECT 1 FROM public.audit_versions WHERE organisation_id = ''' || org || '''::uuid'), 0::bigint, 'another organisation sees no versions');
  r := pg_temp.fails(format($q$SELECT app.audit_content_changed(%L)$q$, a1));
  PERFORM pg_temp.assert_eq(r LIKE 'P0002:%', true, 'nor whether an audit has unsaved content: ' || r);
  r := pg_temp.fails(format($q$SELECT app.save_audit_version(%L, 'x')$q$, a1));
  PERFORM pg_temp.assert_eq(r LIKE 'P0002:%', true, 'nor save one: ' || r);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login_anon();
  PERFORM pg_temp.assert_fails('SELECT * FROM public.audit_versions', 'anon sees nothing');
  PERFORM pg_temp.logout();

  -- ---- records remember their version ----
  PERFORM pg_temp.login(u_insp);
  rec := app.start_audit(a1);
  PERFORM pg_temp.assert_eq((SELECT audit_version FROM public.audit_records WHERE id = rec), 6, 'a record is started against the latest version');
  SELECT id INTO vid FROM public.audit_versions WHERE audit_definition_id = a1 AND version = 6;
  PERFORM pg_temp.assert_eq((SELECT audit_version_id FROM public.audit_records WHERE id = rec), vid, 'and links to it');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_record_questions WHERE audit_record_id = rec), (SELECT count(*) FROM public.audit_version_questions WHERE audit_version_id = vid), 'the record froze the questions of that version');
  PERFORM pg_temp.assert_eq((SELECT string_agg(question, '|' ORDER BY sequence) FROM public.audit_record_questions WHERE audit_record_id = rec), (SELECT string_agg(question, '|' ORDER BY sequence) FROM public.audit_version_questions WHERE audit_version_id = vid), 'word for word');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_eng);
  UPDATE public.audit_definitions SET title = 'Layered process audit, CNC cell (weekly)' WHERE id = a1;
  v := app.save_audit_version(a1, 'Renamed');
  PERFORM pg_temp.assert_eq(v, 7, 'a later version');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT audit_version FROM public.audit_records WHERE id = rec), 6, 'the record in progress stays on version 6');
  PERFORM pg_temp.assert_eq((SELECT audit_title FROM public.audit_records WHERE id = rec), 'Layered process audit, CNC cell', 'with the title it froze');
  PERFORM pg_temp.login(u_insp);
  rec2 := app.start_audit(a1);
  PERFORM pg_temp.assert_eq((SELECT audit_version FROM public.audit_records WHERE id = rec2), 7, 'the next record is on the new version');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_versions WHERE audit_definition_id = a1), 7::bigint, 'starting an audit made no extra version');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.audit_records SET audit_version = NULL WHERE id = %L$q$, rec), 'a record cannot lose its version number and keep the link');

  -- ---- changes made outside the app are recorded when the audit is started ----
  UPDATE public.audit_questions SET question = 'Is the cell spotless?' WHERE audit_definition_id = a1 AND question = 'Is the cell clean?';
  PERFORM pg_temp.assert_eq(pg_temp.settle(), 'ok', 'the check is for people signed in, not for SQL run by the operator');
  PERFORM pg_temp.assert_eq(app.audit_content_hash(a1) <> (SELECT content_hash FROM public.audit_versions WHERE audit_definition_id = a1 AND version = 7), true, 'so the latest version is now out of date');
  PERFORM pg_temp.login(u_insp);
  rec3 := app.start_audit(a1);
  PERFORM pg_temp.assert_eq((SELECT audit_version FROM public.audit_records WHERE id = rec3), 8, 'starting records the difference as a version');
  PERFORM pg_temp.assert_eq((SELECT reason FROM public.audit_versions WHERE audit_definition_id = a1 AND version = 8), 'Changed outside the app; recorded when the audit was started', 'saying so');
  PERFORM pg_temp.assert_eq((SELECT question FROM public.audit_version_questions q JOIN public.audit_versions x ON x.id = q.audit_version_id WHERE x.audit_definition_id = a1 AND x.version = 8 AND q.sequence = 2), 'Is the cell spotless?', 'with what the record froze');
  PERFORM pg_temp.logout();

  -- ---- an audit made without the app has no version until it is started ----
  INSERT INTO public.audit_definitions (organisation_id, title, audit_type, frequency_kind) VALUES (org, 'Made by SQL', 'other', 'on_demand') RETURNING id INTO a2;
  INSERT INTO public.audit_questions (organisation_id, audit_definition_id, sequence, question, answer_type) VALUES (org, a2, 1, 'Is it there?', 'pass_fail');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_versions WHERE audit_definition_id = a2), 0::bigint, 'no version yet');
  PERFORM pg_temp.login(u_insp);
  rec := app.start_audit(a2);
  PERFORM pg_temp.assert_eq((SELECT audit_version FROM public.audit_records WHERE id = rec), 1, 'starting it makes version 1');
  PERFORM pg_temp.assert_eq((SELECT reason FROM public.audit_versions WHERE audit_definition_id = a2 AND version = 1), 'First version', 'a first version');
  PERFORM pg_temp.logout();

  -- ---- a user's change to an audit that was made without versions is refused until it is saved ----
  PERFORM pg_temp.login(u_eng);
  PERFORM app.set_audit_checklist(a2, '[{"question":"Is it there?","answerType":"pass_fail"},{"question":"Is it marked?","answerType":"pass_fail"}]');
  r := pg_temp.settle();
  PERFORM pg_temp.assert_eq(r LIKE 'QM018: A change to an audit is saved as a new version%', true, 'adding a question is refused until it is saved: ' || r);
  PERFORM app.save_audit_version(a2, 'Added a marking question');
  PERFORM pg_temp.assert_eq(pg_temp.settle(), 'ok', 'until it is saved');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
