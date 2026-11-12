-- Management review MR3: the person a review action is given to is told, even without any management review permission; nobody else, never the giver.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('5c000000-0000-0000-0000-000000000c01', 'ann@mr3.test'), ('5c000000-0000-0000-0000-000000000c02', 'bob@mr3.test'),
  ('5c000000-0000-0000-0000-000000000c03', 'cat@mr3.test');

CREATE FUNCTION pg_temp.seen(p_user uuid, p_org uuid, p_key text) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
  PERFORM pg_temp.login(p_user);
  SELECT count(*) INTO n FROM app.visible_notifications(p_org) v WHERE v.event_key = p_key;
  PERFORM pg_temp.logout();
  RETURN n;
END $$;

DO $$
DECLARE
  ann uuid := '5c000000-0000-0000-0000-000000000c01'; bob uuid := '5c000000-0000-0000-0000-000000000c02'; cat uuid := '5c000000-0000-0000-0000-000000000c03';
  org uuid; m uuid; a1 uuid; a2 uuid; body text; u uuid; ref text;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('MR3 Alpha'); PERFORM pg_temp.logout();
  -- Bob: inspector (no management review permission). Cat: viewer.
  FOREACH u IN ARRAY ARRAY[bob, cat] LOOP INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u, 'active'); END LOOP;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = CASE ou.user_id WHEN bob THEN 'inspector' ELSE 'viewer' END)
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id IN (bob, cat);

  PERFORM pg_temp.login(ann);
  m := app.plan_management_review(org, '{"title":"H1 review","periodFrom":"2026-01-01","periodTo":"2026-06-30"}'::jsonb);
  PERFORM app.start_management_review(m);
  a1 := app.add_management_review_action(m, jsonb_build_object('description', 'Get three quotes', 'ownerId', bob, 'dueDate', '2030-01-31'));
  a2 := app.add_management_review_action(m, '{"description":"Update the training plan"}'::jsonb);
  PERFORM pg_temp.logout();
  SELECT reference INTO ref FROM public.management_reviews WHERE id = m;

  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'management_review.read'), false, 'Bob holds no management review permission');
  SELECT v.body INTO body FROM app.visible_notifications(org) v WHERE v.event_key = 'management_review_actions.created';
  PERFORM pg_temp.assert_eq(body, ref || ' · H1 review — Get three quotes — Due 31 Jan 2030', 'but he is told which review, what and by when');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.list_notification_preferences(org) p WHERE p.key LIKE 'management_review_actions.%' AND p.email_default), 2::bigint,
                            'and may switch it off; it is emailed by default');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(pg_temp.seen(ann, org, 'management_review_actions.created'), 0::bigint, 'the giver is not told, even of the one she gave herself');
  PERFORM pg_temp.assert_eq(pg_temp.seen(cat, org, 'management_review_actions.created'), 0::bigint, 'nobody else is told');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.notifications WHERE entity_type = 'management_review_actions'), 1::bigint, 'one notice in all');

  -- The owner sees which review their action came from, without reading the review.
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.management_reviews WHERE organisation_id = org), 0::bigint, 'Bob cannot read the review');
  PERFORM pg_temp.assert_eq((SELECT string_agg(reference || ' ' || title, ',') FROM app.my_review_action_reviews(org)), ref || ' H1 review', 'but sees which review his action came from');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.my_review_action_reviews(org)), 0::bigint, 'someone with no action there sees none');
  PERFORM pg_temp.logout();

  -- New words or a due date are not news; handing it over is.
  PERFORM pg_temp.login(ann);
  PERFORM app.update_management_review_action(a2, '{"description":"Update the training plan for 2027","dueDate":"2030-03-01"}'::jsonb);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.notifications WHERE entity_type = 'management_review_actions'), 1::bigint, 'a change of words or date tells nobody');
  PERFORM pg_temp.login(ann);
  PERFORM app.update_management_review_action(a2, jsonb_build_object('ownerId', cat));
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(pg_temp.seen(cat, org, 'management_review_actions.updated'), 1::bigint, 'handing it over tells the new person');

  -- Closing it is not news.
  PERFORM pg_temp.login(bob);
  PERFORM app.complete_management_review_action(a1, 'Done');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.notifications WHERE entity_type = 'management_review_actions'), 2::bigint, 'closing an action tells nobody');
END $$;

ROLLBACK;
