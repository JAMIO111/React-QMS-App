-- CAPA3: D4 root causes (occurrence, escape, systemic), verification stamped by the database, changing a verified cause withdraws it, causes from
-- analyses (Ishikawa and 5 Whys kinds), removal marks, the D4 checklist, the lock once complete, permissions and isolation.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('3f000000-0000-0000-0000-000000000501', 'owner@capa3.test'),
  ('3f000000-0000-0000-0000-000000000502', 'viewer@capa3.test'),
  ('3f000000-0000-0000-0000-000000000503', 'other@capa3.test');

DO $$
DECLARE
  org uuid; org2 uuid; viewer_role uuid; m_view uuid; c uuid; c2 uuid; why uuid; fish uuid; why2 uuid; rc1 uuid; rc2 uuid; rc3 uuid;
BEGIN
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000501');
  org := app.create_organisation('Capa Three Works', 'Plant A', 'PA', NULL);
  SELECT id INTO viewer_role FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '3f000000-0000-0000-0000-000000000502', 'active') RETURNING id INTO m_view;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) VALUES (org, m_view, viewer_role);
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000503');
  org2 := app.create_organisation('Other Works', 'Plant B', 'PB', NULL);
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000501');
  c := app.start_capa(org, 'Burrs on the bore', 'Burrs on every third part', NULL, NULL, NULL);
  c2 := app.start_capa(org, 'Another 8D', 'Problem', NULL, NULL, NULL);

  -- The checklist: an occurrence cause, and everything verified.
  PERFORM pg_temp.assert_eq(app.capa_step_problems(c, 'd4'), ARRAY['Record at least one occurrence root cause (why the problem happened)'], 'D4 needs an occurrence cause');

  -- Analyses of the D4 kinds (the table allowed them from CAPA2).
  INSERT INTO public.capa_analyses (organisation_id, capa_id, kind, title, step, data)
    VALUES (org, c, 'five_whys', '5 Whys: occurrence', 'd4', '{"kind":"occurrence","whys":[{"because":"The tool was worn"}],"rootCause":"No tool life limit"}') RETURNING id INTO why;
  INSERT INTO public.capa_analyses (organisation_id, capa_id, kind, title, step, data)
    VALUES (org, c, 'ishikawa', 'Ishikawa', 'd4', '{"effect":"Burrs","categories":[]}') RETURNING id INTO fish;
  INSERT INTO public.capa_analyses (organisation_id, capa_id, kind, title, step, data)
    VALUES (org, c2, 'five_whys', 'Other 8D chain', 'd4', '{}') RETURNING id INTO why2;

  -- Causes: unverified at first; from an analysis of this 8D only.
  INSERT INTO public.capa_root_causes (organisation_id, capa_id, kind, description, source_analysis_id)
    VALUES (org, c, 'occurrence', 'No tool life limit on the boring bar', why) RETURNING id INTO rc1;
  PERFORM pg_temp.assert_eq((SELECT (verified, verified_at IS NULL, verified_by IS NULL)::text FROM public.capa_root_causes WHERE id = rc1), '(f,t,t)', 'a new cause is unverified');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.capa_root_causes (organisation_id, capa_id, kind, description, source_analysis_id) VALUES (%L, %L, 'occurrence', 'x', %L)$q$, org, c, why2), 'an analysis of another 8D cannot be the source');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.capa_root_causes (organisation_id, capa_id, kind, description) VALUES (%L, %L, 'bad', 'x')$q$, org, c), 'a known kind');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.capa_root_causes (organisation_id, capa_id, kind, description) VALUES (%L, %L, 'occurrence', '  ')$q$, org, c), 'a description');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.capa_root_causes (organisation_id, capa_id, kind, description, verified) VALUES (%L, %L, 'escape', 'x', true)$q$, org, c), 'verified on insert needs a method');
  PERFORM pg_temp.assert_eq(app.capa_step_problems(c, 'd4'), ARRAY['Verify the 1 root cause not yet verified'], 'one unverified cause');

  -- Verifying: needs a method, stamped by the database, the user cannot set the stamps.
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.capa_root_causes SET verified = true WHERE id = %L$q$, rc1), 'verifying needs a method');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.capa_root_causes SET verified_at = now() WHERE id = %L$q$, rc1), 'the stamp is not a column users can set');
  UPDATE public.capa_root_causes SET verified = true, verification_method = '  Trial with a new tool  ', verification_note = 'Burrs stopped after the tool change' WHERE id = rc1;
  PERFORM pg_temp.assert_eq((SELECT (verified, verified_at IS NOT NULL, verified_by IS NOT NULL, verification_method)::text FROM public.capa_root_causes WHERE id = rc1), '(t,t,t,"  Trial with a new tool  ")', 'verified and stamped');
  PERFORM pg_temp.assert_eq(app.capa_step_problems(c, 'd4'), ARRAY[]::text[], 'D4 is ready');

  -- Escape and systemic causes; the occurrence one is enough for D4, the escape one is advised only.
  INSERT INTO public.capa_root_causes (organisation_id, capa_id, kind, description, verified, verification_method)
    VALUES (org, c, 'escape', 'Final inspection samples 1 in 50', true, 'Checked the sampling plan') RETURNING id INTO rc2;
  INSERT INTO public.capa_root_causes (organisation_id, capa_id, kind, description) VALUES (org, c, 'systemic', 'No tool life monitoring in the control plan') RETURNING id INTO rc3;
  PERFORM pg_temp.assert_eq((SELECT verified FROM public.capa_root_causes WHERE id = rc2), true, 'verified on insert with a method');
  PERFORM pg_temp.assert_eq(app.capa_step_problems(c, 'd4'), ARRAY['Verify the 1 root cause not yet verified'], 'a new unverified cause blocks again');

  -- Changing a verified cause withdraws its verification; editing the note or method does not.
  UPDATE public.capa_root_causes SET verification_note = 'Burrs stopped after the tool change, 3 lots' WHERE id = rc1;
  PERFORM pg_temp.assert_eq((SELECT verified FROM public.capa_root_causes WHERE id = rc1), true, 'editing the note keeps the verification');
  UPDATE public.capa_root_causes SET description = 'No tool life limit on the boring bar or the drill' WHERE id = rc1;
  PERFORM pg_temp.assert_eq((SELECT (verified, verified_at IS NULL)::text FROM public.capa_root_causes WHERE id = rc1), '(f,t)', 'changing the words withdraws the verification');
  UPDATE public.capa_root_causes SET verified = true WHERE id = rc1;
  PERFORM pg_temp.assert_eq((SELECT verified FROM public.capa_root_causes WHERE id = rc1), true, 're-verified with the method it already has');
  UPDATE public.capa_root_causes SET kind = 'systemic' WHERE id = rc1;
  PERFORM pg_temp.assert_eq((SELECT verified FROM public.capa_root_causes WHERE id = rc1), false, 'changing the kind withdraws it too');
  UPDATE public.capa_root_causes SET kind = 'occurrence', verified = true WHERE id = rc1;
  UPDATE public.capa_root_causes SET verified = false WHERE id = rc3;
  UPDATE public.capa_root_causes SET verified = true, verification_method = 'Reviewed the control plan' WHERE id = rc3;
  UPDATE public.capa_root_causes SET verified = false WHERE id = rc3;
  PERFORM pg_temp.assert_eq((SELECT (verified, verified_at IS NULL, verified_by IS NULL)::text FROM public.capa_root_causes WHERE id = rc3), '(f,t,t)', 'verification can be withdrawn');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.capa_root_causes SET source_analysis_id = %L WHERE id = %L$q$, fish, rc1), 'the source cannot change');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.capa_root_causes SET capa_id = %L WHERE id = %L$q$, c2, rc1), 'a cause stays on its 8D');
  PERFORM pg_temp.assert_fails(format($q$DELETE FROM public.capa_root_causes WHERE id = %L$q$, rc1), 'never deleted');

  -- Removal marks the cause; it no longer counts, and stays removed.
  UPDATE public.capa_root_causes SET deleted_at = now() WHERE id = rc3;
  PERFORM pg_temp.assert_eq((SELECT (deleted_at IS NOT NULL, deleted_by IS NOT NULL)::text FROM public.capa_root_causes WHERE id = rc3), '(t,t)', 'removal is stamped');
  PERFORM pg_temp.assert_eq(app.capa_step_problems(c, 'd4'), ARRAY[]::text[], 'a removed cause no longer blocks D4');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.capa_root_causes SET deleted_at = NULL WHERE id = %L$q$, rc3), 'it stays removed');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.capa_root_causes SET description = 'Edited after removal' WHERE id = %L$q$, rc3), 'and cannot be edited');

  -- When D4 is complete the causes and analyses are read-only until it is reopened (earlier steps are not required first).
  PERFORM app.capa_complete_step(c, 'd4');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.capa_root_causes SET description = 'Edited after D4 was completed' WHERE id = %L$q$, rc2), 'a cause cannot be edited after D4 is complete');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.capa_root_causes (organisation_id, capa_id, kind, description) VALUES (%L, %L, 'systemic', 'Added after D4 was completed')$q$, org, c), 'nor added');
  PERFORM app.capa_reopen_step(c, 'd4', 'A new cause came up');
  PERFORM pg_temp.assert_ok(format($q$UPDATE public.capa_root_causes SET description = 'Edited after D4 was reopened' WHERE id = %L$q$, rc2), 'reopened: a cause can be edited');
  PERFORM pg_temp.assert_ok(format($q$INSERT INTO public.capa_root_causes (organisation_id, capa_id, kind, description) VALUES (%L, %L, 'systemic', 'Added after D4 was reopened')$q$, org, c), 'and added');
  PERFORM pg_temp.logout();

  -- A viewer reads but changes nothing.
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000502');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.capa_root_causes), 4::bigint, 'a viewer reads root causes');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.capa_root_causes (organisation_id, capa_id, kind, description) VALUES (%L, %L, 'occurrence', 'x')$q$, org, c), 'a viewer cannot add a cause');
  PERFORM pg_temp.assert_eq(pg_temp.affected(format($q$UPDATE public.capa_root_causes SET verified = true, verification_method = 'x' WHERE id = %L$q$, rc3)), 0::bigint, 'a viewer verifies nothing');
  PERFORM pg_temp.logout();

  -- A cancelled 8D keeps its causes and accepts none.
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000501');
  PERFORM app.cancel_capa(c2, 'Raised twice');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.capa_root_causes (organisation_id, capa_id, kind, description) VALUES (%L, %L, 'occurrence', 'x')$q$, org, c2), 'no causes on a cancelled 8D');
  PERFORM pg_temp.logout();

  -- Isolation.
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000503');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.capa_root_causes), 0::bigint, 'isolation: root causes');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.capa_root_causes (organisation_id, capa_id, kind, description) VALUES (%L, %L, 'occurrence', 'x')$q$, org, c), 'isolation: cannot add a cause to another organisation''s 8D');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.capa_root_causes (organisation_id, capa_id, kind, description) VALUES (%L, %L, 'occurrence', 'x')$q$, org2, c), 'isolation: nor by claiming the organisation');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
