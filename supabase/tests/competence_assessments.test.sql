-- Competence CO2: positions held with dates, append-only assessments, the self-assessment rule, own-record visibility.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('3c000000-0000-0000-0000-000000000a01', 'ann@ca.test'), ('3c000000-0000-0000-0000-000000000a02', 'bob@ca.test'),
  ('3c000000-0000-0000-0000-000000000a03', 'eve@ca.test'), ('3c000000-0000-0000-0000-000000000a04', 'cat@ca.test'),
  ('3c000000-0000-0000-0000-000000000a05', 'dee@ca.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '3c000000-0000-0000-0000-000000000a01'; bob uuid := '3c000000-0000-0000-0000-000000000a02'; eve uuid := '3c000000-0000-0000-0000-000000000a03';
  cat uuid := '3c000000-0000-0000-0000-000000000a04'; dee uuid := '3c000000-0000-0000-0000-000000000a05';
  org uuid; org2 uuid; insp uuid; sk uuid; sk2 uuid; pos uuid; pos2 uuid; e_bob uuid; e_cat uuid; e_x uuid; e_off uuid; ep uuid; a1 uuid; a2 uuid; r text; rid uuid;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('CA Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('CA Beta'); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, bob, 'active'), (org, cat, 'active'), (org, dee, 'active');
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = CASE ou.user_id WHEN cat THEN 'quality_engineer' ELSE 'viewer' END)
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id IN (bob, cat, dee);
  -- Employees: Bob (viewer, linked), Cat (quality engineer, linked), X (no sign-in), Off (inactive)
  INSERT INTO public."Employees" (organisation_id, first_name, surname, auth_id) VALUES (org, 'Bob', 'B', bob) RETURNING id INTO e_bob;
  INSERT INTO public."Employees" (organisation_id, first_name, surname, auth_id) VALUES (org, 'Cat', 'C', cat) RETURNING id INTO e_cat;
  INSERT INTO public."Employees" (organisation_id, first_name, surname) VALUES (org, 'Xavier', 'X') RETURNING id INTO e_x;
  INSERT INTO public."Employees" (organisation_id, first_name, surname, active) VALUES (org, 'Off', 'O', false) RETURNING id INTO e_off;

  PERFORM pg_temp.login(ann);
  SELECT id INTO insp FROM public.competence_categories WHERE organisation_id = org AND key = 'inspection';
  sk := app.save_competence_skill(org, jsonb_build_object('code', 'CMM', 'name', 'CMM', 'categoryId', insp, 'refreshMonths', 12));
  sk2 := app.save_competence_skill(org, jsonb_build_object('code', 'VIS', 'name', 'Visual', 'categoryId', insp));
  pos := app.save_competence_position(org, '{"code":"INSP","name":"Inspector"}'::jsonb);
  pos2 := app.save_competence_position(org, '{"code":"SET","name":"Setter"}'::jsonb);
  PERFORM app.set_position_skills(pos, jsonb_build_array(jsonb_build_object('skillId', sk, 'requiredLevel', 3)));

  -- ---- positions held ----
  ep := app.assign_employee_position(e_x, pos, current_date - 60);
  PERFORM pg_temp.assert_eq((SELECT started_on FROM public.competence_employee_positions WHERE id = ep), current_date - 60, 'a position is held from a date');
  r := pg_temp.fails(format($f$SELECT app.assign_employee_position(%L, %L, current_date - 10)$f$, e_x, pos));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'the same position cannot be held twice over the same dates');
  r := pg_temp.fails(format($f$SELECT app.assign_employee_position(%L, %L, current_date + 1)$f$, e_x, pos2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'a start date in the future is refused');
  r := pg_temp.fails(format($f$SELECT app.assign_employee_position(%L, %L, current_date)$f$, e_off, pos2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'an inactive employee cannot be given a position');
  r := pg_temp.fails(format($f$SELECT app.retire_competence_position(%L, 'Not needed any more')$f$, pos));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'a position someone holds cannot be retired');
  r := pg_temp.fails(format($f$SELECT app.end_employee_position(%L, current_date - 90)$f$, ep));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'it cannot end before it began');
  PERFORM app.end_employee_position(ep, current_date - 30);
  PERFORM pg_temp.assert_eq((SELECT ended_on FROM public.competence_employee_positions WHERE id = ep), current_date - 30, 'ending keeps the row');
  r := pg_temp.fails(format($f$SELECT app.end_employee_position(%L)$f$, ep));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'an ended position cannot end again');
  r := pg_temp.fails(format($f$SELECT app.assign_employee_position(%L, %L, current_date - 40)$f$, e_x, pos));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'a new stint cannot overlap the earlier one');
  PERFORM app.assign_employee_position(e_x, pos, current_date - 20);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.competence_employee_positions WHERE employee_id = e_x), 2::bigint, 'a later stint is a second row (history kept)');
  r := pg_temp.fails(format($f$INSERT INTO public.competence_employee_positions (organisation_id, employee_id, position_id, started_on) VALUES (%L, %L, %L, current_date)$f$, org, e_x, pos2));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'no direct table writes');
  PERFORM pg_temp.logout();

  -- cannot reach across organisations
  PERFORM pg_temp.login(eve);
  r := pg_temp.fails(format($f$SELECT app.assign_employee_position(%L, %L, current_date)$f$, e_x, pos));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'another organisation cannot give a position');
  r := pg_temp.fails(format($f$SELECT app.record_competence_assessment(%L, %L, 2, current_date)$f$, e_x, sk));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'or assess');
  PERFORM pg_temp.logout();

  -- ---- who may assess ----
  PERFORM pg_temp.login(bob);
  r := pg_temp.fails(format($f$SELECT app.record_competence_assessment(%L, %L, 2, current_date)$f$, e_x, sk));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a viewer cannot assess');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login(cat);
  r := pg_temp.fails(format($f$SELECT app.assign_employee_position(%L, %L, current_date)$f$, e_x, pos2));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a quality engineer cannot give positions');
  r := pg_temp.fails(format($f$SELECT app.record_competence_assessment(%L, %L, 2, current_date)$f$, e_cat, sk));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'nobody assesses themselves');
  r := pg_temp.fails(format($f$SELECT app.record_competence_assessment(%L, %L, 4, current_date)$f$, e_x, sk));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'level 4 needs competence.manage');
  r := pg_temp.fails(format($f$SELECT app.record_competence_assessment(%L, %L, 5, current_date)$f$, e_x, sk));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'the level is 0 to 4');
  r := pg_temp.fails(format($f$SELECT app.record_competence_assessment(%L, %L, 2, current_date + 1)$f$, e_x, sk));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'not dated in the future');
  r := pg_temp.fails(format($f$SELECT app.record_competence_assessment(%L, %L, 2, current_date)$f$, e_off, sk));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'not for an inactive employee');
  a1 := app.record_competence_assessment(e_x, sk, 2, current_date - 40, NULL, 'First check');
  PERFORM pg_temp.assert_eq((SELECT expires_on FROM public.competence_assessments WHERE id = a1), (current_date - 40 + interval '12 months')::date, 'expiry follows the skill refresh interval');
  PERFORM pg_temp.assert_eq((SELECT assessor_user_id FROM public.competence_assessments WHERE id = a1), cat, 'the assessor is the caller');
  r := pg_temp.fails(format($f$SELECT app.record_competence_assessment(%L, %L, 3, current_date - 50)$f$, e_x, sk));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'not dated before the one it replaces');
  r := pg_temp.fails(format($f$SELECT app.record_competence_assessment(%L, %L, 1, current_date - 5)$f$, e_x, sk));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'a lower level needs a note');
  a2 := app.record_competence_assessment(e_x, sk, 3, current_date - 5, current_date + 100);
  PERFORM pg_temp.assert_eq((SELECT status FROM public.competence_assessments WHERE id = a1), 'superseded', 'the earlier one is superseded');
  PERFORM pg_temp.assert_eq((SELECT supersedes_id FROM public.competence_assessments WHERE id = a2), a1, 'and linked');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.competence_assessments WHERE employee_id = e_x AND skill_id = sk AND status = 'current'), 1::bigint, 'one current');
  PERFORM pg_temp.assert_eq((SELECT expires_on FROM public.competence_assessments WHERE id = a2), current_date + 100, 'a chosen expiry is kept');
  rid := app.record_competence_assessment(e_x, sk, 0, current_date, NULL, 'Left the cell');
  PERFORM pg_temp.assert_eq((SELECT expires_on IS NULL FROM public.competence_assessments WHERE id = rid), true, 'level 0 has no expiry');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.competence_assessments WHERE employee_id = e_x AND skill_id = sk), 3::bigint, 'history is kept');
  r := pg_temp.fails(format($f$UPDATE public.competence_assessments SET level = 4 WHERE id = %L$f$, a1));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'no direct update');
  PERFORM pg_temp.logout();

  -- ---- append-only even for SQL; the owner assesses level 4; retired skills ----
  r := pg_temp.fails(format($f$UPDATE public.competence_assessments SET level = 4 WHERE id = %L$f$, a2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'the trigger refuses a changed assessment');
  r := pg_temp.fails(format($f$DELETE FROM public.competence_assessments WHERE id = %L$f$, a2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'and a deleted one');
  PERFORM pg_temp.login(ann);
  PERFORM app.record_competence_assessment(e_x, sk2, 4, current_date);
  PERFORM pg_temp.assert_eq((SELECT level FROM public.competence_assessments WHERE employee_id = e_x AND skill_id = sk2 AND status = 'current'), 4, 'a manager assesses can train others');
  PERFORM app.retire_competence_skill(sk2, 'Replaced');
  r := pg_temp.fails(format($f$SELECT app.record_competence_assessment(%L, %L, 2, current_date)$f$, e_x, sk2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'no competent level on a retired skill');
  PERFORM app.record_competence_assessment(e_x, sk2, 0, current_date, NULL, 'Skill retired');
  PERFORM app.end_employee_position((SELECT id FROM public.competence_employee_positions WHERE employee_id = e_x AND ended_on IS NULL), current_date);
  PERFORM app.retire_competence_position(pos, 'Not needed any more');
  PERFORM pg_temp.assert_eq((SELECT active FROM public.competence_positions WHERE id = pos), false, 'a position nobody holds can be retired');
  PERFORM pg_temp.logout();

  -- ---- seeing your own record ----
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.competence_assessments), 0::bigint, 'Bob (no record of assessments) sees none');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.competence_skills WHERE organisation_id = org), 2::bigint, 'but reads the skill list to understand his own record');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.my_visible_permissions(org) p WHERE p = 'competence.own'), 1::bigint, 'the menu knows he has a record');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'competence.read'), false, 'without reading anyone else');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  PERFORM app.record_competence_assessment(e_bob, sk, 1, current_date);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.competence_assessments), 1::bigint, 'Bob sees the assessment of himself');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.competence_assessments WHERE employee_id = e_x), 0::bigint, 'and not of anyone else');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(dee);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.competence_assessments), 0::bigint, 'a viewer with no seat and no record sees nothing');
  PERFORM pg_temp.logout();
END $$;
ROLLBACK;
