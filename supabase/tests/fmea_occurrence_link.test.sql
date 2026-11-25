-- FMEA FM5b: a failure mode of the analysis can name a failure mode of the non-conformance register. Only a failure mode of the organisation's own register will do (not a sub failure
-- mode, a process or another organisation's), a switched-off one can be kept but not newly chosen, the link is held for SQL too, and a new revision and an FMEA started from a base keep it.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('4f000000-0000-0000-0000-000000000b01', 'ann@fo.test'), ('4f000000-0000-0000-0000-000000000b02', 'cat@fo.test'),
  ('4f000000-0000-0000-0000-000000000b03', 'dan@fo.test'), ('4f000000-0000-0000-0000-000000000b05', 'eve@fo.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '4f000000-0000-0000-0000-000000000b01'; cat uuid := '4f000000-0000-0000-0000-000000000b02';
  dan uuid := '4f000000-0000-0000-0000-000000000b03'; eve uuid := '4f000000-0000-0000-0000-000000000b05';
  org uuid; org2 uuid; u uuid; part uuid; f1 uuid; r1 uuid; r2 uuid; fc uuid; rc uuid;
  nc1 uuid; nc2 uuid; nc_sub uuid; nc_proc uuid; nc_other uuid; m1 uuid; fn1 uuid; it uuid; r text;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('FO Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('FO Beta'); PERFORM pg_temp.logout();
  FOREACH u IN ARRAY ARRAY[cat, dan] LOOP
    INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u, 'active');
  END LOOP;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = CASE ou.user_id WHEN dan THEN 'quality_manager' ELSE 'quality_engineer' END)
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id IN (cat, dan);

  -- The register: two failure modes, a sub failure mode under the first, a process, and a failure mode of the other organisation.
  PERFORM pg_temp.login(ann);
  INSERT INTO public.ncr_classifications (organisation_id, kind, name) VALUES (org, 'failure_mode', 'Bore oversize') RETURNING id INTO nc1;
  INSERT INTO public.ncr_classifications (organisation_id, kind, name) VALUES (org, 'failure_mode', 'Burr left') RETURNING id INTO nc2;
  INSERT INTO public.ncr_classifications (organisation_id, kind, name, parent_id) VALUES (org, 'sub_failure_mode', 'Bore oversize at the mouth', nc1) RETURNING id INTO nc_sub;
  INSERT INTO public.ncr_classifications (organisation_id, kind, name) VALUES (org, 'process', 'Turning') RETURNING id INTO nc_proc;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'FO-P1', 'Bracket') RETURNING id INTO part;
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve);
  INSERT INTO public.ncr_classifications (organisation_id, kind, name) VALUES (org2, 'failure_mode', 'Bore oversize') RETURNING id INTO nc_other;
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login(cat);
  f1 := app.create_fmea(org, jsonb_build_object('kind', 'process', 'title', 'Machining the bracket',
    'team', jsonb_build_array(jsonb_build_object('userId', cat, 'role', 'lead'), jsonb_build_object('userId', dan, 'role', 'quality')),
    'links', jsonb_build_array(jsonb_build_object('kind', 'part', 'id', part))));
  r1 := (SELECT id FROM public.fmea_revisions WHERE fmea_id = f1);
  PERFORM pg_temp.build_fmea_net(r1);
  m1 := (SELECT id FROM public.fmea_failure_modes WHERE revision_id = r1);
  PERFORM pg_temp.assert_eq((SELECT ncr_failure_mode_id FROM public.fmea_failure_modes WHERE id = m1), NULL::uuid, 'a failure mode is tied to nothing at first');

  -- ---- only a failure mode of this organisation's register ----
  r := pg_temp.fails(format($f$SELECT app.save_fmea_failure_mode(NULL, %L, jsonb_build_object('ncrFailureModeId', %L))$f$, m1, nc_sub));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'a sub failure mode is not a failure mode of the register');
  r := pg_temp.fails(format($f$SELECT app.save_fmea_failure_mode(NULL, %L, jsonb_build_object('ncrFailureModeId', %L))$f$, m1, nc_proc));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'nor is a process');
  r := pg_temp.fails(format($f$SELECT app.save_fmea_failure_mode(NULL, %L, jsonb_build_object('ncrFailureModeId', %L))$f$, m1, nc_other));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'nor one of another organisation');
  r := pg_temp.fails(format($f$SELECT app.save_fmea_failure_mode(NULL, %L, jsonb_build_object('ncrFailureModeId', %L))$f$, m1, gen_random_uuid()));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'nor one that does not exist');
  PERFORM pg_temp.assert_eq((SELECT ncr_failure_mode_id FROM public.fmea_failure_modes WHERE id = m1), NULL::uuid, 'a refused choice changes nothing');

  PERFORM app.save_fmea_failure_mode(NULL, m1, jsonb_build_object('ncrFailureModeId', nc1));
  PERFORM pg_temp.assert_eq((SELECT ncr_failure_mode_id FROM public.fmea_failure_modes WHERE id = m1), nc1, 'a failure mode of the register is tied');
  PERFORM app.save_fmea_failure_mode(NULL, m1, '{"text":"Bore oversize (renamed)"}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT ncr_failure_mode_id FROM public.fmea_failure_modes WHERE id = m1), nc1, 'saving other fields leaves the link as it was');
  PERFORM app.save_fmea_failure_mode(NULL, m1, '{"ncrFailureModeId":null}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT ncr_failure_mode_id FROM public.fmea_failure_modes WHERE id = m1), NULL::uuid, 'null clears it');
  r := pg_temp.fails(format($f$SELECT app.save_fmea_failure_mode(NULL, %L, '{"ncrFailureModeId":"not-an-id"}'::jsonb)$f$, m1));
  PERFORM pg_temp.assert_eq(left(r, 1) <> 'o', true, 'something that is not an id is refused');
  r := pg_temp.fails(format($f$SELECT app.save_fmea_failure_mode(NULL, %L, '{"ncFailureMode":"x"}'::jsonb)$f$, m1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'an unknown key is still refused');

  -- ---- one that is switched off stays where it is but cannot be newly chosen ----
  PERFORM app.save_fmea_failure_mode(NULL, m1, jsonb_build_object('ncrFailureModeId', nc2));
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ann);
  UPDATE public.ncr_classifications SET active = false WHERE id = nc2;
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  PERFORM app.save_fmea_failure_mode(NULL, m1, '{"text":"Burr left on the bore"}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT ncr_failure_mode_id FROM public.fmea_failure_modes WHERE id = m1), nc2, 'a switched-off failure mode already tied is kept');
  PERFORM app.save_fmea_failure_mode(NULL, m1, jsonb_build_object('ncrFailureModeId', nc2));
  PERFORM pg_temp.assert_eq((SELECT ncr_failure_mode_id FROM public.fmea_failure_modes WHERE id = m1), nc2, 'and sending it again changes nothing');
  PERFORM app.save_fmea_failure_mode(NULL, m1, jsonb_build_object('ncrFailureModeId', nc1));
  PERFORM app.save_fmea_failure_mode(NULL, m1, '{"ncrFailureModeId":null}'::jsonb);
  r := pg_temp.fails(format($f$SELECT app.save_fmea_failure_mode(NULL, %L, jsonb_build_object('ncrFailureModeId', %L))$f$, m1, nc2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'a switched-off failure mode cannot be newly chosen');
  PERFORM pg_temp.logout();

  -- ---- held for SQL too ----
  r := pg_temp.fails(format($f$UPDATE public.fmea_failure_modes SET ncr_failure_mode_id = %L WHERE id = %L$f$, nc_sub, m1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'SQL cannot tie a sub failure mode');
  r := pg_temp.fails(format($f$UPDATE public.fmea_failure_modes SET ncr_failure_mode_id = %L WHERE id = %L$f$, nc_other, m1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'nor another organisation''s failure mode');
  PERFORM pg_temp.assert_eq((SELECT ncr_failure_mode_id FROM public.fmea_failure_modes WHERE id = m1), NULL::uuid, 'and nothing was changed');

  -- ---- in force, then a new revision and an FMEA from a base keep the link ----
  PERFORM pg_temp.login(cat);
  PERFORM app.save_fmea_failure_mode(NULL, m1, jsonb_build_object('ncrFailureModeId', nc1));
  PERFORM app.set_fmea_approver(r1, dan);
  PERFORM app.submit_fmea_revision(r1);
  r := pg_temp.fails(format($f$SELECT app.save_fmea_failure_mode(NULL, %L, '{"ncrFailureModeId":null}'::jsonb)$f$, m1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'a submitted revision keeps its link');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(dan);
  PERFORM app.approve_fmea_revision(r1, current_date, NULL);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  r2 := app.start_fmea_revision(f1);
  PERFORM pg_temp.assert_eq((SELECT m.ncr_failure_mode_id FROM public.fmea_failure_modes m WHERE m.revision_id = r2), nc1, 'a new revision keeps the link');
  fc := app.create_fmea(org, jsonb_build_object('kind', 'process', 'title', 'Machining the bracket (customer B)', 'baseFmeaId', f1));
  rc := (SELECT id FROM public.fmea_revisions WHERE fmea_id = fc);
  PERFORM pg_temp.assert_eq((SELECT m.ncr_failure_mode_id FROM public.fmea_failure_modes m WHERE m.revision_id = rc), nc1, 'an FMEA started from a base keeps it too: the register belongs to the organisation');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
