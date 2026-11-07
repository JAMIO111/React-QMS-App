-- CAPA5: D8 close and recognise (needs capa.verify, everything done, verified effective; D8 cannot be completed any other way; closed is read-only until
-- reopened, which marks D8 not done again), evidence files (functions only, removal is a mark, readable on a closed 8D), storage rules and isolation.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('3f000000-0000-0000-0000-000000000701', 'owner@capa5.test'),
  ('3f000000-0000-0000-0000-000000000702', 'eng@capa5.test'),
  ('3f000000-0000-0000-0000-000000000703', 'viewer@capa5.test'),
  ('3f000000-0000-0000-0000-000000000704', 'other@capa5.test');

DO $$
DECLARE
  org uuid; org2 uuid; eng_role uuid; viewer_role uuid; m_eng uuid; m_view uuid; c uuid; rc uuid; a1 uuid; f1 uuid; f2 uuid; path1 text; path2 text;
BEGIN
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000701');
  org := app.create_organisation('Capa Five Works', 'Plant A', 'PA', NULL);
  SELECT id INTO eng_role FROM public.roles WHERE organisation_id = org AND key = 'quality_engineer';
  SELECT id INTO viewer_role FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '3f000000-0000-0000-0000-000000000702', 'active') RETURNING id INTO m_eng;
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '3f000000-0000-0000-0000-000000000703', 'active') RETURNING id INTO m_view;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) VALUES (org, m_eng, eng_role), (org, m_view, viewer_role);
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000704');
  org2 := app.create_organisation('Other Works', 'Plant B', 'PB', NULL);
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000701');
  c := app.start_capa(org, 'Burrs on the bore', 'Burrs on every third part', NULL, NULL, NULL);
  INSERT INTO public.capa_root_causes (organisation_id, capa_id, kind, description, verified, verification_method) VALUES (org, c, 'occurrence', 'No tool life limit', true, 'Trial') RETURNING id INTO rc;
  PERFORM pg_temp.logout();
  -- Steps are written by functions only; the test marks D0 to D7 done directly (as the database owner), leaving D3 open.
  UPDATE public.capa_steps SET completed_at = now() WHERE capa_id = c AND step IN ('d0', 'd1', 'd2', 'd4', 'd7');

  -- D8 says what is missing.
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000701');
  PERFORM pg_temp.assert_eq(app.capa_step_problems(c, 'd8'), ARRAY['Complete D3 first', 'Complete D5 first', 'Complete D6 first', 'The corrective actions must be verified as effective before the 8D can be closed'], 'D8 lists what is missing');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.close_capa(%L, 'Well done')$q$, c), 'cannot close an 8D that is not ready');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.capa_complete_step(%L, 'd8')$q$, c), 'D8 cannot be completed on its own');
  PERFORM pg_temp.logout();

  UPDATE public.capa_steps SET completed_at = now() WHERE capa_id = c AND step = 'd3';
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000701');
  INSERT INTO public.capa_actions (organisation_id, capa_id, phase, description, root_cause_id) VALUES (org, c, 'corrective', 'Set a limit', rc) RETURNING id INTO a1;
  UPDATE public.capa_actions SET status = 'done', evidence_note = 'Limit set' WHERE id = a1;
  PERFORM app.record_capa_verification(c, true, 'Audit of 5 lots', NULL);
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.capas WHERE id = c), 'verified_effective', 'ready: verified effective');
  PERFORM pg_temp.logout();
  UPDATE public.capa_steps SET completed_at = now() WHERE capa_id = c AND step IN ('d5', 'd6');
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000701');
  PERFORM pg_temp.assert_eq(app.capa_step_problems(c, 'd8'), ARRAY[]::text[], 'D8 has nothing missing');
  PERFORM pg_temp.logout();

  -- Only someone with capa.verify closes.
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000702');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.close_capa(%L, 'x')$q$, c), 'an engineer (manage, not verify) cannot close');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000703');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.close_capa(%L, 'x')$q$, c), 'a viewer cannot close');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000704');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.close_capa(%L, 'x')$q$, c), 'another organisation cannot close it');
  PERFORM pg_temp.logout();

  -- Files while running: the engineer adds, the viewer cannot; the folder is checked.
  path1 := org::text || '/capa/' || c::text || '/aaaa-report.pdf';
  path2 := org::text || '/capa/' || c::text || '/bbbb-photo.jpg';
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000702');
  f1 := app.add_capa_attachment(c, path1, 'report.pdf', 'application/pdf', 1000, 'Audit report');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.capa_attachments WHERE capa_id = c), 1::bigint, 'the engineer attached a file');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.add_capa_attachment(%L, %L, 'x.pdf', 'application/pdf', 1, NULL)$q$, c, org::text || '/capa/00000000-0000-0000-0000-000000000000/x.pdf'), 'wrong folder');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.add_capa_attachment(%L, %L, 'report.pdf', 'application/pdf', 1000, NULL)$q$, c, path1), 'the same stored file twice');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.capa_attachments SET file_name = 'renamed' WHERE id = %L$q$, f1), 'a file record cannot be edited');
  PERFORM pg_temp.assert_fails(format($q$DELETE FROM public.capa_attachments WHERE id = %L$q$, f1), 'a file record cannot be deleted');
  PERFORM pg_temp.assert_eq(app.capa_file_allowed(path2, true), true, 'the engineer may upload into a running 8D');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000703');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.capa_attachments WHERE capa_id = c), 1::bigint, 'a viewer sees the file');
  PERFORM pg_temp.assert_eq(app.capa_file_allowed(path1, false), true, 'a viewer may read the stored file');
  PERFORM pg_temp.assert_eq(app.capa_file_allowed(path2, true), false, 'a viewer may not upload');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.add_capa_attachment(%L, %L, 'p.jpg', 'image/jpeg', 1, NULL)$q$, c, path2), 'a viewer cannot attach');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000704');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.capa_attachments), 0::bigint, 'isolation: files');
  PERFORM pg_temp.assert_eq(app.capa_file_allowed(path1, false), false, 'isolation: stored files');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.remove_capa_attachment(%L, 'x')$q$, f1), 'isolation: cannot remove');
  PERFORM pg_temp.logout();

  -- Removal is a mark with a reason, and can be undone.
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000702');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.remove_capa_attachment(%L, ' ')$q$, f1), 'removal needs a reason');
  PERFORM app.remove_capa_attachment(f1, 'Wrong report');
  PERFORM pg_temp.assert_eq((SELECT delete_reason FROM public.capa_attachments WHERE id = f1), 'Wrong report', 'removed with the reason, row kept');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.remove_capa_attachment(%L, 'again')$q$, f1), 'cannot remove twice');
  PERFORM app.restore_capa_attachment(f1);
  PERFORM pg_temp.assert_eq((SELECT deleted_at IS NULL FROM public.capa_attachments WHERE id = f1), true, 'restored');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.restore_capa_attachment(%L)$q$, f1), 'cannot restore a live file');
  PERFORM pg_temp.logout();

  -- Closing.
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000701');
  PERFORM app.close_capa(c, '  Thanks to the whole team  ');
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.capas WHERE id = c), 'closed', 'closed');
  PERFORM pg_temp.assert_eq((SELECT closed_at IS NOT NULL AND closed_by = auth.uid() FROM public.capas WHERE id = c), true, 'closed_at and closed_by are stamped');
  PERFORM pg_temp.assert_eq((SELECT d8_recognition FROM public.capas WHERE id = c), 'Thanks to the whole team', 'recognition stored, trimmed');
  PERFORM pg_temp.assert_eq((SELECT completed_at IS NOT NULL FROM public.capa_steps WHERE capa_id = c AND step = 'd8'), true, 'D8 is complete');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.close_capa(%L, 'again')$q$, c), 'cannot close twice');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.capas SET d8_recognition = 'changed' WHERE id = %L$q$, c), 'the recognition note is not editable');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.add_capa_attachment(%L, %L, 'p.jpg', 'image/jpeg', 1, NULL)$q$, c, path2), 'no new files on a closed 8D');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.remove_capa_attachment(%L, 'late')$q$, f1), 'no removing files on a closed 8D');
  PERFORM pg_temp.assert_eq(app.capa_file_allowed(path2, true), false, 'no uploads to a closed 8D');
  PERFORM pg_temp.assert_eq(app.capa_file_allowed(path1, false), true, 'the files can still be read');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.capa_attachments WHERE capa_id = c), 1::bigint, 'the file is still listed');
  PERFORM pg_temp.assert_eq(app.capa_step_problems(c, 'd8'), ARRAY[]::text[], 'a closed 8D has nothing missing');

  -- Reopening takes it back to the stage the work says, and D8 is not done again.
  PERFORM app.reopen_capa(c, 'Customer asked for more evidence');
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.capas WHERE id = c), 'verified_effective', 'reopened: back to verified effective');
  PERFORM pg_temp.assert_eq((SELECT closed_at IS NULL AND closed_by IS NULL FROM public.capas WHERE id = c), true, 'the closure stamp is cleared');
  PERFORM pg_temp.assert_eq((SELECT completed_at IS NULL FROM public.capa_steps WHERE capa_id = c AND step = 'd8'), true, 'D8 is not done again');
  PERFORM pg_temp.assert_eq((SELECT reopen_reason FROM public.capa_steps WHERE capa_id = c AND step = 'd8'), 'The 8D was reopened: Customer asked for more evidence', 'with the reason');
  PERFORM pg_temp.assert_eq(app.capa_file_allowed(path2, true), true, 'uploads work again');
  PERFORM app.close_capa(c, NULL);
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.capas WHERE id = c), 'closed', 'closed again');
  PERFORM pg_temp.assert_eq((SELECT d8_recognition IS NULL FROM public.capas WHERE id = c), true, 'a blank note replaces the old one');
  PERFORM pg_temp.logout();

  -- An NC linked to the 8D can close once the 8D is verified effective or closed (rule C7 unchanged).
END $$;

ROLLBACK;
