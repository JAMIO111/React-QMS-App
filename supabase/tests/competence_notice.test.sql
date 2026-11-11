-- Competence CO4: the person assessed is told (their linked sign-in only), even without any competence permission.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('3c000000-0000-0000-0000-000000000c01', 'ann@cn.test'), ('3c000000-0000-0000-0000-000000000c02', 'bob@cn.test'),
  ('3c000000-0000-0000-0000-000000000c03', 'eve@cn.test'), ('3c000000-0000-0000-0000-000000000c04', 'cat@cn.test'),
  ('3c000000-0000-0000-0000-000000000c05', 'dee@cn.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '3c000000-0000-0000-0000-000000000c01'; bob uuid := '3c000000-0000-0000-0000-000000000c02'; eve uuid := '3c000000-0000-0000-0000-000000000c03';
  cat uuid := '3c000000-0000-0000-0000-000000000c04'; dee uuid := '3c000000-0000-0000-0000-000000000c05';
  org uuid; org2 uuid; insp uuid; sk uuid; e_bob uuid; e_x uuid; n bigint; body text; r text;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('CN Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('CN Beta'); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, bob, 'active'), (org, cat, 'active'), (org, dee, 'active');
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = CASE ou.user_id WHEN cat THEN 'quality_engineer' ELSE 'viewer' END)
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id IN (bob, cat, dee);
  INSERT INTO public."Employees" (organisation_id, first_name, surname, auth_id) VALUES (org, 'Bob', 'B', bob) RETURNING id INTO e_bob;
  INSERT INTO public."Employees" (organisation_id, first_name, surname) VALUES (org, 'Xavier', 'X') RETURNING id INTO e_x;

  PERFORM pg_temp.login(ann);
  SELECT id INTO insp FROM public.competence_categories WHERE organisation_id = org AND key = 'inspection';
  sk := app.save_competence_skill(org, jsonb_build_object('code', 'CMM', 'name', 'CMM operation', 'categoryId', insp));
  PERFORM pg_temp.logout();

  -- Cat (a quality engineer) assesses Bob (a viewer with a linked sign-in) and Xavier (no sign-in).
  PERFORM pg_temp.login(cat);
  PERFORM app.record_competence_assessment(e_bob, sk, 2, current_date - 5);
  PERFORM app.record_competence_assessment(e_x, sk, 3, current_date - 5);
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'competence.read'), false, 'Bob holds no competence permission');
  SELECT count(*), max(v.body) INTO n, body FROM app.visible_notifications(org) v WHERE v.event_key = 'competence_assessments.created';
  PERFORM pg_temp.assert_eq(n, 1::bigint, 'but he is told he was assessed');
  PERFORM pg_temp.assert_eq(body, 'CMM operation — Supervised (2)', 'with the skill and the level');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.list_notification_preferences(org) p WHERE p.key = 'competence_assessments.created'), 1::bigint, 'and may switch it off');
  PERFORM app.set_notification_preference(org, 'competence_assessments.created', false);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.visible_notifications(org) v WHERE v.event_key = 'competence_assessments.created'), 0::bigint, 'switched off, it no longer shows');
  PERFORM app.set_notification_preference(org, 'competence_assessments.created', NULL);
  PERFORM pg_temp.logout();

  -- Nobody else sees it: not the assessor, not another viewer, not even the owner.
  PERFORM pg_temp.login(cat);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.visible_notifications(org) v WHERE v.event_key = 'competence_assessments.created'), 0::bigint, 'the assessor is not told of their own action');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(dee);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.visible_notifications(org) v WHERE v.event_key = 'competence_assessments.created'), 0::bigint, 'another viewer sees none');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.notifications WHERE entity_type = 'competence_assessments'), 0::bigint, 'nor in the table');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.visible_notifications(org) v WHERE v.event_key = 'competence_assessments.created'), 0::bigint, 'the owner sees none either');
  PERFORM pg_temp.logout();

  -- Only one notice was made (Xavier has no sign-in), and superseding the earlier assessment announces nothing.
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.notifications WHERE entity_type = 'competence_assessments'), 1::bigint, 'one notice in all: no sign-in, no notice');
  PERFORM pg_temp.login(cat);
  PERFORM app.record_competence_assessment(e_bob, sk, 3, current_date);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.notifications WHERE entity_type = 'competence_assessments'), 2::bigint, 'the new assessment announces itself once; the superseded one adds nothing');

  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq((SELECT array_agg(v.body ORDER BY v.created_at) FROM app.visible_notifications(org) v WHERE v.event_key = 'competence_assessments.created'),
                            ARRAY['CMM operation — Supervised (2)', 'CMM operation — Competent (3)'], 'both notices, in order');
  PERFORM pg_temp.logout();

  -- Other organisations are untouched.
  PERFORM pg_temp.login(eve);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.visible_notifications(org2) v WHERE v.event_key = 'competence_assessments.created'), 0::bigint, 'another organisation sees none');
  r := pg_temp.fails(format($f$SELECT app.set_notification_preference(%L, 'competence_assessments.created', false)$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'and cannot set a preference in this one');
  PERFORM pg_temp.logout();
END $$;
ROLLBACK;
