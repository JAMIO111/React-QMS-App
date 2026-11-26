-- app.visible_notifications works out "can see" and "wanted" once per kind of notice; the answer must be exactly what the per-notice rule gives.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql
CREATE FUNCTION pg_temp.assert_true(cond boolean, label text) RETURNS void LANGUAGE sql AS $$ SELECT pg_temp.assert_eq(coalesce(cond, false), true, label) $$;

INSERT INTO auth.users (id, email) VALUES
  ('50000000-0000-0000-0000-000000000101', 'owner@vn.test'),
  ('50000000-0000-0000-0000-000000000102', 'siteonly@vn.test'),
  ('50000000-0000-0000-0000-000000000103', 'viewer@vn.test');

CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);
GRANT SELECT ON ids TO authenticated;

DO $$
DECLARE org uuid; site_b uuid; m uuid;
BEGIN
  PERFORM pg_temp.login('50000000-0000-0000-0000-000000000101');
  org := app.create_organisation('Notice Works', 'Plant A', 'PA', NULL);
  PERFORM pg_temp.logout();
  INSERT INTO public.sites (organisation_id, code, name) VALUES (org, 'PB', 'Plant B') RETURNING id INTO site_b;
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '50000000-0000-0000-0000-000000000102', 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id, site_id)
    SELECT org, m, id, site_b FROM public.roles WHERE organisation_id = org AND key = 'inspector';
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '50000000-0000-0000-0000-000000000103', 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  INSERT INTO ids VALUES ('org', org), ('site_b', site_b);
  -- one notice per event type and per situation: no site, Plant A, Plant B, a JSON null site, addressed to one person, written by one person
  INSERT INTO public.notifications (organisation_id, event_type_id, audit_event_id, entity_type, entity_id, title, details, actor_user_id, recipient_user_id, created_at)
  SELECT org, t.id, gen_random_uuid(), t.entity_type, gen_random_uuid()::text, t.description || ' ' || v.label, v.details, v.actor, v.recipient, now() - (v.age || ' hours')::interval
  FROM public.notification_event_types t
  CROSS JOIN LATERAL (VALUES
    ('none',   '{}'::jsonb,                                         NULL::uuid, NULL::uuid, 1),
    ('a',      jsonb_build_object('site_id', (SELECT id FROM public.sites WHERE organisation_id = org AND code = 'PA')), NULL, NULL, 2),
    ('b',      jsonb_build_object('site_id', site_b),               NULL, NULL, 3),
    ('nullsite', '{"site_id": null}'::jsonb,                        NULL, NULL, 4),
    ('private', '{}'::jsonb,   NULL, '50000000-0000-0000-0000-000000000103'::uuid, 5),
    ('own',    '{}'::jsonb,    '50000000-0000-0000-0000-000000000103'::uuid, NULL, 6),
    ('old',    '{}'::jsonb,    NULL, NULL, 24 * 100)
  ) AS v(label, details, actor, recipient, age);
  -- the owner switches one kind off, the viewer another
  INSERT INTO public.notification_preferences (organisation_id, user_id, event_type_id, enabled)
    SELECT org, '50000000-0000-0000-0000-000000000101', id, false FROM public.notification_event_types ORDER BY key LIMIT 1;
  INSERT INTO public.notification_preferences (organisation_id, user_id, event_type_id, enabled)
    SELECT org, '50000000-0000-0000-0000-000000000103', id, true FROM public.notification_event_types ORDER BY key DESC LIMIT 3;
END $$;

-- For each person, the new function returns exactly the notices the per-notice rule allows.
DO $$
DECLARE
  org uuid := (SELECT v FROM ids WHERE k = 'org');
  u uuid; n_new int; n_old int; n_diff int;
BEGIN
  FOREACH u IN ARRAY ARRAY['50000000-0000-0000-0000-000000000101', '50000000-0000-0000-0000-000000000102', '50000000-0000-0000-0000-000000000103']::uuid[] LOOP
    PERFORM pg_temp.login(u);
    SELECT count(*) INTO n_new FROM app.visible_notifications(org);
    SELECT count(*) INTO n_old
      FROM public.notifications n
     WHERE n.organisation_id = org AND app.is_member(org)
       AND n.created_at > now() - interval '90 days'
       AND n.actor_user_id IS DISTINCT FROM auth.uid()
       AND (n.recipient_user_id IS NULL OR n.recipient_user_id = auth.uid())
       AND app.notification_can_see(n.organisation_id, n.event_type_id, n.details)
       AND app.notification_wanted(n.organisation_id, n.event_type_id);
    SELECT count(*) INTO n_diff FROM (
      (SELECT v.id FROM app.visible_notifications(org) v EXCEPT
       SELECT n.id FROM public.notifications n
        WHERE n.organisation_id = org AND n.created_at > now() - interval '90 days' AND n.actor_user_id IS DISTINCT FROM auth.uid()
          AND (n.recipient_user_id IS NULL OR n.recipient_user_id = auth.uid())
          AND app.notification_can_see(n.organisation_id, n.event_type_id, n.details) AND app.notification_wanted(n.organisation_id, n.event_type_id))
      UNION ALL
      (SELECT n.id FROM public.notifications n
        WHERE n.organisation_id = org AND n.created_at > now() - interval '90 days' AND n.actor_user_id IS DISTINCT FROM auth.uid()
          AND (n.recipient_user_id IS NULL OR n.recipient_user_id = auth.uid())
          AND app.notification_can_see(n.organisation_id, n.event_type_id, n.details) AND app.notification_wanted(n.organisation_id, n.event_type_id)
       EXCEPT SELECT v.id FROM app.visible_notifications(org) v)) d;
    PERFORM pg_temp.assert_eq(n_new, n_old, 'the same number of notices as the per-notice rule for ' || u);
    PERFORM pg_temp.assert_eq(n_diff, 0, 'the same notices as the per-notice rule for ' || u);
  END LOOP;
  PERFORM pg_temp.logout();
END $$;

-- It really did return something for each person, so the comparison above is not empty on both sides; the old ones and a stranger's are left out.
DO $$
DECLARE org uuid := (SELECT v FROM ids WHERE k = 'org');
BEGIN
  PERFORM pg_temp.login('50000000-0000-0000-0000-000000000101');
  PERFORM pg_temp.assert_true((SELECT count(*) FROM app.visible_notifications(org)) > 0, 'the owner sees notices');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.visible_notifications(org) WHERE title LIKE '% old'), 0::bigint, 'nothing older than 90 days');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.visible_notifications(org) WHERE title LIKE '% private'), 0::bigint, 'a notice for one other person is not shown');
  PERFORM pg_temp.login('50000000-0000-0000-0000-000000000103');
  PERFORM pg_temp.assert_true((SELECT count(*) FROM app.visible_notifications(org) WHERE title LIKE '% private') > 0, 'the person it is for sees it');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.visible_notifications(org) WHERE title LIKE '% own'), 0::bigint, 'a person is not told of their own action');
  PERFORM pg_temp.login_anon();
  PERFORM pg_temp.assert_fails($q$SELECT count(*) FROM app.visible_notifications('00000000-0000-0000-0000-000000000000')$q$, 'anon cannot call it');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
