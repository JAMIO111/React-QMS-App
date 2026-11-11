-- Competence CO3: training sessions, attendee lists with own completion dates, evidence files, reading your own sessions.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('3c000000-0000-0000-0000-000000000b01', 'ann@ct.test'), ('3c000000-0000-0000-0000-000000000b02', 'bob@ct.test'),
  ('3c000000-0000-0000-0000-000000000b03', 'eve@ct.test'), ('3c000000-0000-0000-0000-000000000b04', 'cat@ct.test'),
  ('3c000000-0000-0000-0000-000000000b05', 'dee@ct.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '3c000000-0000-0000-0000-000000000b01'; bob uuid := '3c000000-0000-0000-0000-000000000b02'; eve uuid := '3c000000-0000-0000-0000-000000000b03';
  cat uuid := '3c000000-0000-0000-0000-000000000b04'; dee uuid := '3c000000-0000-0000-0000-000000000b05';
  org uuid; org2 uuid; insp uuid; sk uuid; sk_old uuid; e_bob uuid; e_cat uuid; e_x uuid; e_y uuid; e_off uuid; e_foreign uuid;
  s uuid; s2 uuid; a_bob uuid; a_x uuid; a_y uuid; a_x2 uuid; f1 uuid; f2 uuid; r text; n integer; ref text;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('CT Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('CT Beta'); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, bob, 'active'), (org, cat, 'active'), (org, dee, 'active');
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = CASE ou.user_id WHEN cat THEN 'quality_engineer' ELSE 'viewer' END)
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id IN (bob, cat, dee);
  INSERT INTO public."Employees" (organisation_id, first_name, surname, auth_id) VALUES (org, 'Bob', 'B', bob) RETURNING id INTO e_bob;
  INSERT INTO public."Employees" (organisation_id, first_name, surname, auth_id) VALUES (org, 'Cat', 'C', cat) RETURNING id INTO e_cat;
  INSERT INTO public."Employees" (organisation_id, first_name, surname) VALUES (org, 'Xavier', 'X') RETURNING id INTO e_x;
  INSERT INTO public."Employees" (organisation_id, first_name, surname) VALUES (org, 'Yara', 'Y') RETURNING id INTO e_y;
  INSERT INTO public."Employees" (organisation_id, first_name, surname, active) VALUES (org, 'Off', 'O', false) RETURNING id INTO e_off;
  INSERT INTO public."Employees" (organisation_id, first_name, surname) VALUES (org2, 'For', 'Eign') RETURNING id INTO e_foreign;

  PERFORM pg_temp.login(ann);
  SELECT id INTO insp FROM public.competence_categories WHERE organisation_id = org AND key = 'inspection';
  sk := app.save_competence_skill(org, jsonb_build_object('code', 'CMM', 'name', 'CMM', 'categoryId', insp));
  sk_old := app.save_competence_skill(org, jsonb_build_object('code', 'OLD', 'name', 'Old', 'categoryId', insp));
  PERFORM app.retire_competence_skill(sk_old, 'Not used');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login(cat);
  -- ---- create ----
  s := app.create_training_session(org, jsonb_build_object('title', 'CMM basics', 'kind', 'course', 'providerType', 'internal', 'trainerEmployeeId', e_cat,
        'startsOn', current_date - 10, 'hours', 4, 'skillIds', jsonb_build_array(sk)), ARRAY[e_x, e_y, e_bob]);
  ref := (SELECT reference FROM public.competence_training_sessions WHERE id = s);
  PERFORM pg_temp.assert_eq(ref, 'TS-' || to_char(current_date, 'YY') || '-0001', 'numbered per organisation and year');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.competence_session_attendees WHERE session_id = s AND status = 'enrolled'), 3::bigint, 'three people enrolled');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.competence_session_skills WHERE session_id = s), 1::bigint, 'one supported skill');
  r := pg_temp.fails(format($f$SELECT app.create_training_session(%L, '{"title":"X","kind":"course","providerType":"internal","startsOn":"2026-01-01"}'::jsonb)$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'internal needs a trainer');
  r := pg_temp.fails(format($f$SELECT app.create_training_session(%L, '{"title":"X","kind":"course","providerType":"external","startsOn":"2026-01-01"}'::jsonb)$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'external needs a provider name');
  r := pg_temp.fails(format($f$SELECT app.create_training_session(%L, jsonb_build_object('title','X','kind','course','providerType','internal','trainerEmployeeId',%L,'startsOn','2026-01-01'))$f$, org, e_foreign));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'the trainer must be of this organisation');
  r := pg_temp.fails(format($f$SELECT app.create_training_session(%L, jsonb_build_object('title','X','kind','course','providerType','internal','trainerEmployeeId',%L,'startsOn','2026-01-01'), ARRAY[%L]::uuid[])$f$, org, e_cat, e_off));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'attendees must be active');
  r := pg_temp.fails(format($f$SELECT app.create_training_session(%L, jsonb_build_object('title','X','kind','course','providerType','internal','trainerEmployeeId',%L,'startsOn','2026-01-01','skillIds',jsonb_build_array(%L)))$f$, org, e_cat, sk_old));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'a retired skill cannot be supported');
  r := pg_temp.fails(format($f$SELECT app.create_training_session(%L, '{"title":"X","kind":"course","providerType":"external","providerName":"Acme","startsOn":"2026-01-01","oops":1}'::jsonb)$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'an unknown field is refused');
  s2 := app.create_training_session(org, '{"title":"Welding awareness","kind":"external","providerType":"external","providerName":"Acme Training","providerContact":"info@acme.test","startsOn":"2026-01-05"}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT reference FROM public.competence_training_sessions WHERE id = s2), 'TS-' || to_char(current_date, 'YY') || '-0002', 'the next number');
  PERFORM pg_temp.assert_eq((SELECT trainer_employee_id IS NULL FROM public.competence_training_sessions WHERE id = s2), true, 'external has no trainer employee');
  r := pg_temp.fails(format($f$INSERT INTO public.competence_training_sessions (organisation_id, reference, title, kind, provider_type, trainer_employee_id, starts_on) VALUES (%L,'X','X','course','internal',%L,current_date)$f$, org, e_cat));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'no direct table writes');

  -- ---- update ----
  PERFORM app.update_training_session(s, '{"title":"CMM basics (Zeiss)","hours":6,"location":"Metrology lab"}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT (title, hours, location)::text FROM public.competence_training_sessions WHERE id = s), '("CMM basics (Zeiss)",6.00,"Metrology lab")', 'a session is edited while open');
  PERFORM app.update_training_session(s, '{"providerType":"external","providerName":"Zeiss"}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT trainer_employee_id IS NULL AND provider_name = 'Zeiss' FROM public.competence_training_sessions WHERE id = s), true, 'switching provider clears the trainer');
  PERFORM app.update_training_session(s, jsonb_build_object('providerType', 'internal', 'trainerEmployeeId', e_cat));
  PERFORM pg_temp.assert_eq((SELECT provider_name IS NULL FROM public.competence_training_sessions WHERE id = s), true, 'and back clears the provider');

  -- ---- attendees: own dates ----
  SELECT id INTO a_x FROM public.competence_session_attendees WHERE session_id = s AND employee_id = e_x;
  SELECT id INTO a_y FROM public.competence_session_attendees WHERE session_id = s AND employee_id = e_y;
  SELECT id INTO a_bob FROM public.competence_session_attendees WHERE session_id = s AND employee_id = e_bob;
  r := pg_temp.fails(format($f$SELECT app.record_session_attendees(%L, ARRAY[%L]::uuid[], 'completed', current_date + 1)$f$, s, a_x));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'not in the future');
  r := pg_temp.fails(format($f$SELECT app.record_session_attendees(%L, ARRAY[%L]::uuid[], 'completed', current_date - 20)$f$, s, a_x));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'not before the session started');
  r := pg_temp.fails(format($f$SELECT app.record_session_attendees(%L, ARRAY[%L]::uuid[], 'completed')$f$, s, a_x));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'a completed date is needed');
  r := pg_temp.fails(format($f$SELECT app.record_session_attendees(%L, ARRAY[%L]::uuid[], 'failed', current_date - 5)$f$, s, a_x));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'a failure needs a note');
  r := pg_temp.fails(format($f$SELECT app.record_session_attendees(%L, ARRAY[%L]::uuid[], 'passed', current_date - 5)$f$, s, a_x));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'only completed, failed or absent');
  n := app.record_session_attendees(s, ARRAY[a_x, a_y], 'completed', current_date - 8, 'Passed the practical');
  PERFORM pg_temp.assert_eq(n, 2, 'two people completed on one day');
  n := app.record_session_attendees(s, ARRAY[a_bob], 'completed', current_date - 2);
  PERFORM pg_temp.assert_eq((SELECT array_agg(completed_on ORDER BY completed_on) FROM public.competence_session_attendees WHERE session_id = s AND status = 'completed'),
                            ARRAY[current_date - 8, current_date - 8, current_date - 2], 'the same session, completed on different days');
  r := pg_temp.fails(format($f$SELECT app.record_session_attendees(%L, ARRAY[%L]::uuid[], 'completed', current_date - 1)$f$, s, a_x));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'a completed attendee is frozen');
  r := pg_temp.fails(format($f$SELECT app.remove_session_attendee(%L, 'oops')$f$, a_x));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'only an enrolled one can be removed');
  r := pg_temp.fails(format($f$SELECT app.void_session_attendee(%L, 'x')$f$, a_x));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'voiding needs a reason');
  r := pg_temp.fails(format($f$UPDATE public.competence_session_attendees SET status = 'enrolled' WHERE id = %L$f$, a_x));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'no direct update');
  PERFORM pg_temp.logout();
  r := pg_temp.fails(format($f$UPDATE public.competence_session_attendees SET status = 'enrolled', completed_on = NULL WHERE id = %L$f$, a_x));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'the trigger refuses a completed one going back');
  r := pg_temp.fails(format($f$DELETE FROM public.competence_session_attendees WHERE id = %L$f$, a_x));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'and a delete');
  PERFORM pg_temp.login(cat);

  -- correct by voiding and adding again
  PERFORM app.void_session_attendee(a_x, 'Wrong person ticked');
  a_x2 := app.add_session_attendee(s, e_x);
  PERFORM pg_temp.assert_eq((SELECT status FROM public.competence_session_attendees WHERE id = a_x), 'voided', 'voided, kept');
  r := pg_temp.fails(format($f$SELECT app.add_session_attendee(%L, %L)$f$, s, e_x));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'cannot add someone twice');
  r := pg_temp.fails(format($f$SELECT app.add_session_attendee(%L, %L)$f$, s, e_off));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'cannot add an inactive employee');

  -- ---- close, reopen, cancel ----
  r := pg_temp.fails(format($f$SELECT app.close_training_session(%L)$f$, s));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'cannot close while someone is enrolled');
  PERFORM app.record_session_attendees(s, ARRAY[a_x2], 'absent');
  r := pg_temp.fails(format($f$SELECT app.cancel_training_session(%L, 'Called off')$f$, s));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'cannot cancel with a recorded result');
  PERFORM app.close_training_session(s);
  PERFORM pg_temp.assert_eq((SELECT status FROM public.competence_training_sessions WHERE id = s), 'closed', 'closed');
  r := pg_temp.fails(format($f$SELECT app.update_training_session(%L, '{"title":"Changed"}'::jsonb)$f$, s));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'a closed session cannot be edited');
  r := pg_temp.fails(format($f$SELECT app.add_session_attendee(%L, %L)$f$, s, e_cat));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'nor take new people');
  r := pg_temp.fails(format($f$SELECT app.reopen_training_session(%L, 'x')$f$, s));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'reopening needs a reason');
  PERFORM app.reopen_training_session(s, 'Forgot one person');
  PERFORM pg_temp.assert_eq((SELECT (status, reopen_reason)::text FROM public.competence_training_sessions WHERE id = s), '(open,"Forgot one person")', 'reopened with the reason kept');
  PERFORM app.cancel_training_session(s2, 'Provider cancelled');
  r := pg_temp.fails(format($f$SELECT app.add_session_attendee(%L, %L)$f$, s2, e_x));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'a cancelled session takes nobody');
  PERFORM pg_temp.assert_eq((SELECT cancel_reason FROM public.competence_training_sessions WHERE id = s2), 'Provider cancelled', 'the reason is kept');

  -- ---- files ----
  f1 := app.add_competence_attachment(s, NULL, org || '/competence/session/' || s || '/sheet.pdf', 'sheet.pdf', 'application/pdf', 100);
  f2 := app.add_competence_attachment(NULL, a_bob, org || '/competence/attendee/' || a_bob || '/cert.pdf', 'cert.pdf', 'application/pdf', 100, 'Certificate');
  r := pg_temp.fails(format($f$SELECT app.add_competence_attachment(%L, NULL, %L, 'x.pdf', 'application/pdf', 1)$f$, s, org || '/competence/session/' || gen_random_uuid() || '/x.pdf'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'the file must be in the session''s own folder');
  r := pg_temp.fails(format($f$SELECT app.add_competence_attachment(NULL, %L, %L, 'x.pdf', 'application/pdf', 1)$f$, a_x, org || '/competence/attendee/' || a_x || '/x.pdf'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'a voided attendee takes no files');
  r := pg_temp.fails(format($f$SELECT app.add_competence_attachment(%L, %L, 'p', 'x.pdf', 'application/pdf', 1)$f$, s, a_bob));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'one owner only');
  PERFORM app.remove_competence_attachment(f1, 'Wrong sheet');
  r := pg_temp.fails(format($f$SELECT app.remove_competence_attachment(%L, 'again')$f$, f1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'already removed');
  PERFORM app.restore_competence_attachment(f1);
  PERFORM pg_temp.assert_eq((SELECT deleted_at IS NULL FROM public.competence_attachments WHERE id = f1), true, 'restored');
  PERFORM pg_temp.assert_eq(app.competence_file_allowed(org || '/competence/session/' || s || '/new.pdf', true), true, 'upload allowed into a live session folder');
  PERFORM pg_temp.assert_eq(app.competence_file_allowed(org || '/competence/session/' || s2 || '/new.pdf', true), false, 'not into a cancelled session');
  PERFORM pg_temp.logout();
  r := pg_temp.fails(format($f$DELETE FROM public.competence_attachments WHERE id = %L$f$, f1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'files are never deleted');
  r := pg_temp.fails(format($f$DELETE FROM public.competence_training_sessions WHERE id = %L$f$, s));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'sessions are never deleted');

  -- ---- who may do what and see what ----
  PERFORM pg_temp.login(bob);
  r := pg_temp.fails(format($f$SELECT app.create_training_session(%L, '{"title":"X","kind":"course","providerType":"external","providerName":"A","startsOn":"2026-01-01"}'::jsonb)$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a viewer cannot record training');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.competence_training_sessions), 1::bigint, 'Bob sees the session he is on, not the other');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.competence_session_attendees), 1::bigint, 'and only his own attendee row');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.competence_attachments), 2::bigint, 'and the session file and his certificate');
  PERFORM pg_temp.assert_eq(app.competence_file_allowed(org || '/competence/attendee/' || a_bob || '/cert.pdf', false), true, 'he may read his certificate');
  PERFORM pg_temp.assert_eq(app.competence_file_allowed(org || '/competence/attendee/' || a_x2 || '/cert.pdf', false), false, 'not someone else''s');
  PERFORM pg_temp.assert_eq(app.competence_file_allowed(org || '/competence/session/' || s || '/sheet.pdf', true), false, 'and he cannot upload');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(dee);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.competence_training_sessions), 0::bigint, 'a viewer on no session sees none');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.competence_training_sessions), 0::bigint, 'another organisation sees none');
  r := pg_temp.fails(format($f$SELECT app.add_session_attendee(%L, %L)$f$, s, e_foreign));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'another organisation cannot touch it');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.competence_training_sessions), 2::bigint, 'an owner reads everything');
  PERFORM pg_temp.logout();
END $$;
ROLLBACK;
