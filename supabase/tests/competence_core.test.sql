-- Competence CO1: permissions and role defaults, Controller-seat visibility, categories, skills, positions and what a position requires.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('3c000000-0000-0000-0000-000000000901', 'ann@co.test'), ('3c000000-0000-0000-0000-000000000902', 'bob@co.test'),
  ('3c000000-0000-0000-0000-000000000903', 'eve@co.test'), ('3c000000-0000-0000-0000-000000000904', 'cat@co.test'),
  ('3c000000-0000-0000-0000-000000000905', 'dee@co.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '3c000000-0000-0000-0000-000000000901'; bob uuid := '3c000000-0000-0000-0000-000000000902'; eve uuid := '3c000000-0000-0000-0000-000000000903';
  cat uuid := '3c000000-0000-0000-0000-000000000904'; dee uuid := '3c000000-0000-0000-0000-000000000905';
  org uuid; org2 uuid; insp_cat uuid; other_cat uuid; sk uuid; sk2 uuid; sk3 uuid; pos uuid; pos2 uuid; r text; n bigint; role_id uuid;
BEGIN
  PERFORM pg_temp.login(ann);
  org := app.create_organisation('CO Alpha');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve);
  org2 := app.create_organisation('CO Beta');
  PERFORM pg_temp.logout();
  -- Bob: viewer (no competence permission). Cat: quality engineer. Dee: viewer who holds a Controller seat.
  FOR role_id IN SELECT unnest(ARRAY[bob, cat, dee]) LOOP
    INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, role_id, 'active');
  END LOOP;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = CASE ou.user_id WHEN cat THEN 'quality_engineer' ELSE 'viewer' END)
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id IN (bob, cat, dee);
  PERFORM pg_temp.give_controller_seat(org, dee);

  -- ---- permissions and role defaults ----
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.permissions WHERE code LIKE 'competence.%'), 3::bigint, 'three competence permissions exist');
  PERFORM pg_temp.assert_eq((SELECT array_agg(rp.permission_code ORDER BY rp.permission_code) FROM public.role_permissions rp JOIN public.roles r ON r.id = rp.role_id
                              WHERE r.organisation_id = org AND r.key = 'quality_manager' AND rp.permission_code LIKE 'competence.%'), ARRAY['competence.assess','competence.manage','competence.read'], 'a quality manager holds all three');
  PERFORM pg_temp.assert_eq((SELECT array_agg(rp.permission_code ORDER BY rp.permission_code) FROM public.role_permissions rp JOIN public.roles r ON r.id = rp.role_id
                              WHERE r.organisation_id = org AND r.key = 'quality_engineer' AND rp.permission_code LIKE 'competence.%'), ARRAY['competence.assess','competence.read'], 'a quality engineer reads and assesses');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.role_permissions rp JOIN public.roles r ON r.id = rp.role_id
                              WHERE r.organisation_id = org AND r.key IN ('inspector', 'viewer') AND rp.permission_code LIKE 'competence.%'), 0::bigint, 'inspectors and viewers hold none');

  -- ---- categories are seeded ----
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.competence_categories WHERE organisation_id = org), 6::bigint, 'six categories are seeded');
  SELECT id INTO insp_cat FROM public.competence_categories WHERE organisation_id = org AND key = 'inspection';
  SELECT id INTO other_cat FROM public.competence_categories WHERE organisation_id = org AND key = 'other';
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.competence_categories WHERE organisation_id = org2), 0::bigint, 'another organisation is invisible');
  PERFORM pg_temp.logout();

  -- ---- who sees what ----
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'competence.read'), false, 'a viewer cannot read competence');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.competence_categories WHERE organisation_id = org), 0::bigint, 'and sees no categories');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.my_visible_permissions(org) p WHERE p LIKE 'competence.%'), 0::bigint, 'the menu shows nothing');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(dee);
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'competence.read'), true, 'a Controller-seat holder reads everything in the module');
  PERFORM pg_temp.assert_eq(app.has_permission_somewhere(org, 'competence.read'), true, 'also somewhere-style checks');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'competence.manage'), false, 'but cannot manage');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'competence.assess'), false, 'or assess');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.competence_categories WHERE organisation_id = org), 6::bigint, 'and sees the categories');
  PERFORM pg_temp.assert_eq((SELECT array_agg(p ORDER BY p) FROM app.my_permissions(org) p WHERE p LIKE 'competence.%'), ARRAY['competence.read'], 'my_permissions lists the read right');
  PERFORM pg_temp.assert_eq((SELECT array_agg(p ORDER BY p) FROM app.my_visible_permissions(org) p WHERE p LIKE 'competence.%'), ARRAY['competence.read'], 'so does the menu list');
  PERFORM pg_temp.assert_eq(app.has_permission(org2, 'competence.read'), false, 'the seat does not reach another organisation');
  r := pg_temp.fails(format($f$SELECT app.save_competence_skill(%L, '{"code":"X","name":"X","categoryId":"%s"}'::jsonb)$f$, org, insp_cat));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a seat holder cannot write');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'competence.read'), true, 'a quality engineer reads');
  r := pg_temp.fails(format($f$SELECT app.save_competence_skill(%L, '{"code":"X","name":"X","categoryId":"%s"}'::jsonb)$f$, org, insp_cat));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'but cannot manage');
  PERFORM pg_temp.logout();

  -- ---- categories: manage adds and renames; key fixed ----
  PERFORM pg_temp.login(ann);
  INSERT INTO public.competence_categories (organisation_id, key, label) VALUES (org, 'welding', 'Welding');
  UPDATE public.competence_categories SET label = 'Weld inspection' WHERE organisation_id = org AND key = 'welding';
  PERFORM pg_temp.assert_fails($f$UPDATE public.competence_categories SET key = 'x' WHERE key = 'welding'$f$, 'a category key cannot change');
  PERFORM pg_temp.assert_fails(format($f$INSERT INTO public.competence_categories (organisation_id, key, label) VALUES (%L, 'dup', 'inspection')$f$, org), 'a label is unique ignoring case');
  PERFORM pg_temp.assert_fails(format($f$DELETE FROM public.competence_categories WHERE organisation_id = %L$f$, org), 'categories are never deleted');
  PERFORM pg_temp.logout();

  -- ---- skills ----
  PERFORM pg_temp.login(ann);
  sk := app.save_competence_skill(org, jsonb_build_object('code', 'CMM', 'name', 'CMM operation', 'categoryId', insp_cat, 'refreshMonths', 12));
  sk2 := app.save_competence_skill(org, jsonb_build_object('code', 'VIS', 'name', 'Visual inspection', 'categoryId', insp_cat, 'description', 'To the visual standard'));
  PERFORM pg_temp.assert_eq((SELECT (code, name, refresh_months)::text FROM public.competence_skills WHERE id = sk), '(CMM,"CMM operation",12)', 'a skill is saved');
  PERFORM pg_temp.assert_eq((SELECT refresh_months IS NULL FROM public.competence_skills WHERE id = sk2), true, 'refresh is optional');
  r := pg_temp.fails(format($f$SELECT app.save_competence_skill(%L, '{"code":"cmm","name":"Other","categoryId":"%s"}'::jsonb)$f$, org, insp_cat));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'a code is unique ignoring case');
  r := pg_temp.fails(format($f$SELECT app.save_competence_skill(%L, '{"code":"N2","name":"cmm operation","categoryId":"%s"}'::jsonb)$f$, org, insp_cat));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'an active name is unique ignoring case');
  r := pg_temp.fails(format($f$SELECT app.save_competence_skill(%L, '{"code":"BAD","name":"Bad","categoryId":"%s","refreshMonths":0}'::jsonb)$f$, org, insp_cat));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'the refresh interval is 1 to 120 months');
  r := pg_temp.fails(format($f$SELECT app.save_competence_skill(%L, '{"code":"BAD","name":"Bad","categoryId":"%s","oops":1}'::jsonb)$f$, org, insp_cat));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'an unknown field is refused');
  r := pg_temp.fails(format($f$SELECT app.save_competence_skill(%L, '{"code":"BAD","name":"Bad","categoryId":"%s"}'::jsonb)$f$, org, gen_random_uuid()));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'a category that does not exist is refused');
  PERFORM app.save_competence_skill(org, '{"name":"CMM operation (Zeiss)","refreshMonths":24}'::jsonb, sk);
  PERFORM pg_temp.assert_eq((SELECT (name, refresh_months)::text FROM public.competence_skills WHERE id = sk), '("CMM operation (Zeiss)",24)', 'a skill is edited');
  r := pg_temp.fails(format($f$SELECT app.save_competence_skill(%L, '{"code":"NEW"}'::jsonb, %L)$f$, org, sk));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'the code cannot change once created');
  PERFORM app.save_competence_skill(org, '{"refreshMonths":null}'::jsonb, sk);
  PERFORM pg_temp.assert_eq((SELECT refresh_months IS NULL FROM public.competence_skills WHERE id = sk), true, 'null clears the refresh interval');
  r := pg_temp.fails(format($f$INSERT INTO public.competence_skills (organisation_id, code, name, category_id) VALUES (%L, 'Z', 'Z', %L)$f$, org, insp_cat));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'no direct table writes');
  PERFORM pg_temp.logout();

  -- another organisation's skill is not found
  PERFORM pg_temp.login(eve);
  r := pg_temp.fails(format($f$SELECT app.retire_competence_skill(%L, 'because')$f$, sk));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'another organisation cannot touch a skill');
  PERFORM pg_temp.logout();

  -- ---- positions and what they require ----
  PERFORM pg_temp.login(ann);
  pos := app.save_competence_position(org, '{"code":"INSP","name":"CMM inspector","description":"Runs the CMM"}'::jsonb);
  pos2 := app.save_competence_position(org, '{"code":"SET","name":"Setter"}'::jsonb);
  PERFORM app.set_position_skills(pos, jsonb_build_array(jsonb_build_object('skillId', sk, 'requiredLevel', 3), jsonb_build_object('skillId', sk2, 'requiredLevel', 2)));
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.competence_position_skills WHERE position_id = pos), 2::bigint, 'a position requires two skills');
  PERFORM app.set_position_skills(pos, jsonb_build_array(jsonb_build_object('skillId', sk, 'requiredLevel', 4)));
  PERFORM pg_temp.assert_eq((SELECT (count(*), max(required_level))::text FROM public.competence_position_skills WHERE position_id = pos), '(1,4)', 'the list is replaced as a whole');
  r := pg_temp.fails(format($f$SELECT app.set_position_skills(%L, '[{"skillId":"%s","requiredLevel":5}]'::jsonb)$f$, pos, sk));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'a required level is 1 to 4');
  r := pg_temp.fails(format($f$SELECT app.set_position_skills(%L, '[{"skillId":"%s","requiredLevel":2},{"skillId":"%s","requiredLevel":3}]'::jsonb)$f$, pos, sk, sk));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'a skill is listed once');
  r := pg_temp.fails(format($f$SELECT app.set_position_skills(%L, '[{"skillId":"%s","requiredLevel":2}]'::jsonb)$f$, pos, gen_random_uuid()));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'only skills of this organisation');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.competence_position_skills WHERE position_id = pos), 1::bigint, 'a refused list changes nothing');
  r := pg_temp.fails(format($f$SELECT app.save_competence_position(%L, '{"code":"insp","name":"Other"}'::jsonb)$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'a position code is unique ignoring case');

  -- ---- retiring ----
  r := pg_temp.fails(format($f$SELECT app.retire_competence_skill(%L, 'No longer used')$f$, sk));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'a skill an active position requires cannot be retired');
  r := pg_temp.fails(format($f$SELECT app.retire_competence_skill(%L, 'ab')$f$, sk2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'a reason of at least 3 characters is needed');
  PERFORM app.retire_competence_skill(sk2, 'Replaced by the new standard');
  PERFORM pg_temp.assert_eq((SELECT (active, retired_reason, retired_by = ann)::text FROM public.competence_skills WHERE id = sk2), '(f,"Replaced by the new standard",t)', 'a retired skill keeps its reason and who');
  r := pg_temp.fails(format($f$SELECT app.set_position_skills(%L, '[{"skillId":"%s","requiredLevel":2}]'::jsonb)$f$, pos, sk2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'a retired skill cannot be required');
  r := pg_temp.fails(format($f$SELECT app.save_competence_skill(%L, '{"name":"Renamed"}'::jsonb, %L)$f$, org, sk2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'a retired skill cannot be edited');
  sk3 := app.save_competence_skill(org, jsonb_build_object('code', 'VIS2', 'name', 'Visual inspection', 'categoryId', insp_cat));
  r := pg_temp.fails(format($f$SELECT app.reactivate_competence_skill(%L)$f$, sk2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'bringing a skill back when an active one has its name is refused');
  PERFORM app.retire_competence_skill(sk3, 'Duplicate');
  PERFORM app.reactivate_competence_skill(sk2);
  PERFORM pg_temp.assert_eq((SELECT (active, retired_reason IS NULL)::text FROM public.competence_skills WHERE id = sk2), '(t,t)', 'a skill is brought back');

  PERFORM app.retire_competence_position(pos2, 'Merged into inspector');
  PERFORM pg_temp.assert_eq((SELECT active FROM public.competence_positions WHERE id = pos2), false, 'a position is retired');
  r := pg_temp.fails(format($f$SELECT app.set_position_skills(%L, '[]'::jsonb)$f$, pos2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM024', 'a retired position cannot be edited');
  PERFORM app.reactivate_competence_position(pos2);
  PERFORM pg_temp.assert_eq((SELECT active FROM public.competence_positions WHERE id = pos2), true, 'a position is brought back');
  PERFORM pg_temp.assert_fails(format($f$DELETE FROM public.competence_skills WHERE organisation_id = %L$f$, org), 'skills are never deleted');
  PERFORM pg_temp.assert_fails(format($f$DELETE FROM public.competence_positions WHERE organisation_id = %L$f$, org), 'positions are never deleted');
  PERFORM pg_temp.logout();

  -- ---- the audit trail records the changes ----
  PERFORM pg_temp.assert_eq((SELECT count(*) > 0 FROM audit.events WHERE organisation_id = org AND entity_type = 'competence_skills'), true, 'skill changes are audited');
  PERFORM pg_temp.assert_eq((SELECT count(*) > 0 FROM audit.events WHERE organisation_id = org AND entity_type = 'competence_position_skills'), true, 'so is what a position requires');
END $$;

ROLLBACK;
