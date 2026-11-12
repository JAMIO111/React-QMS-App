-- Risk register RK4: the person a risk action is given to, and a risk's new owner, are told; nobody else, and never the person who did it.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('4e000000-0000-0000-0000-000000000c01', 'ann@rk4.test'), ('4e000000-0000-0000-0000-000000000c02', 'bob@rk4.test'),
  ('4e000000-0000-0000-0000-000000000c03', 'eve@rk4.test'), ('4e000000-0000-0000-0000-000000000c04', 'cat@rk4.test');

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
  ann uuid := '4e000000-0000-0000-0000-000000000c01'; bob uuid := '4e000000-0000-0000-0000-000000000c02'; eve uuid := '4e000000-0000-0000-0000-000000000c03';
  cat uuid := '4e000000-0000-0000-0000-000000000c04';
  org uuid; org2 uuid; c uuid; k uuid; k2 uuid; a1 uuid; a2 uuid; body text; u uuid;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('RK4 Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('RK4 Beta'); PERFORM pg_temp.logout();
  -- Bob: viewer (reads risks). Cat: quality engineer (manages them).
  FOREACH u IN ARRAY ARRAY[bob, cat] LOOP INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u, 'active'); END LOOP;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = CASE ou.user_id WHEN cat THEN 'quality_engineer' ELSE 'viewer' END)
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id IN (bob, cat);

  -- ---- a risk raised by its own owner tells nobody ----
  PERFORM pg_temp.login(cat);
  SELECT id INTO c FROM public.risk_categories WHERE organisation_id = org AND key = 'process';
  k := app.create_risk(org, jsonb_build_object('categoryId', c, 'title', 'Single-source casting supplier'));
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.notifications WHERE entity_type = 'risks'), 0::bigint, 'raising your own risk is no news to you');

  -- ---- a risk raised for someone else tells that person ----
  PERFORM pg_temp.login(cat);
  k2 := app.create_risk(org, jsonb_build_object('categoryId', c, 'title', 'Scrap bin overflow', 'ownerId', bob));
  PERFORM app.assess_risk(k, 4, 4, 'One foundry');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(pg_temp.seen(bob, org, 'risks.created'), 1::bigint, 'Bob is told a risk was given to him');
  PERFORM pg_temp.assert_eq(pg_temp.seen(cat, org, 'risks.created'), 0::bigint, 'the person who raised it is not told');
  PERFORM pg_temp.assert_eq(pg_temp.seen(ann, org, 'risks.created'), 0::bigint, 'nor is anyone else');
  PERFORM pg_temp.login(bob);
  SELECT v.body INTO body FROM app.visible_notifications(org) v WHERE v.event_key = 'risks.created';
  PERFORM pg_temp.assert_eq(body, 'Risk — ' || (SELECT reference FROM public.risks WHERE id = k2) || ' · Scrap bin overflow', 'with the risk named');
  PERFORM pg_temp.assert_eq((SELECT v.details ->> 'risk_id' FROM app.visible_notifications(org) v WHERE v.event_key = 'risks.created'), k2::text, 'and its id for the link');
  PERFORM pg_temp.logout();

  -- ---- assessing, treating or editing a risk is not news; handing it over is ----
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.notifications WHERE entity_type = 'risks'), 1::bigint, 'assessing a risk tells nobody');
  PERFORM pg_temp.login(cat);
  PERFORM app.update_risk(k, jsonb_build_object('title', 'Single-source casting supplier (Midlands)'));
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.notifications WHERE entity_type = 'risks'), 1::bigint, 'a new title tells nobody');
  PERFORM pg_temp.login(cat);
  PERFORM app.update_risk(k, jsonb_build_object('ownerId', bob));
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(pg_temp.seen(bob, org, 'risks.updated'), 1::bigint, 'handing a risk over tells the new owner');
  PERFORM pg_temp.assert_eq(pg_temp.seen(cat, org, 'risks.updated'), 0::bigint, 'not the person who handed it over');

  -- ---- actions ----
  PERFORM pg_temp.login(cat);
  PERFORM app.set_risk_treatment(k, 'mitigate', 'Qualify a second foundry');
  a1 := app.add_risk_action(k, jsonb_build_object('description', 'Audit the second foundry', 'ownerId', bob, 'dueDate', '2030-03-04'));
  a2 := app.add_risk_action(k, jsonb_build_object('description', 'Hold six weeks of stock', 'ownerId', cat));
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(pg_temp.seen(bob, org, 'risk_actions.created'), 1::bigint, 'the person an action is given to is told');
  PERFORM pg_temp.assert_eq(pg_temp.seen(cat, org, 'risk_actions.created'), 0::bigint, 'an action you give yourself is no news');
  PERFORM pg_temp.login(bob);
  SELECT v.body INTO body FROM app.visible_notifications(org) v WHERE v.event_key = 'risk_actions.created';
  PERFORM pg_temp.assert_eq(body, (SELECT reference FROM public.risks WHERE id = k) || ' · Single-source casting supplier (Midlands) — Audit the second foundry — Due 4 Mar 2030',
                            'which risk, what to do and by when');
  -- Completing your own action tells nobody.
  PERFORM app.complete_risk_action(a1, 'Audited, approved');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.notifications WHERE entity_type = 'risk_actions'), 1::bigint, 'closing an action is not news');

  -- Handing an open action over tells the new person; changing its words does not.
  PERFORM pg_temp.login(cat);
  PERFORM app.update_risk_action(a2, '{"description":"Hold eight weeks of stock"}'::jsonb);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.notifications WHERE entity_type = 'risk_actions'), 1::bigint, 'new words tell nobody');
  PERFORM pg_temp.login(cat);
  PERFORM app.update_risk_action(a2, jsonb_build_object('ownerId', bob));
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(pg_temp.seen(bob, org, 'risk_actions.updated'), 1::bigint, 'an action handed over tells the new person');

  -- Both can be switched off, and are emailed by default.
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.list_notification_preferences(org) p WHERE p.key LIKE 'risk%' AND p.email_default), 4::bigint, 'all four are emailed by default');
  PERFORM app.set_notification_preference(org, 'risk_actions.updated', false);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.visible_notifications(org) v WHERE v.event_key = 'risk_actions.updated'), 0::bigint, 'switched off, it no longer shows');
  PERFORM pg_temp.logout();

  -- Another organisation sees nothing.
  PERFORM pg_temp.assert_eq(pg_temp.seen(eve, org2, 'risk_actions.created'), 0::bigint, 'another organisation sees none');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.notifications WHERE organisation_id = org2 AND entity_type IN ('risks', 'risk_actions')), 0::bigint, 'no risk notice was written there');
END $$;

ROLLBACK;
