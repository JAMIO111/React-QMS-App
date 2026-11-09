-- DOC2: recipients are fixed at issue (departments, roles, named people, de-duplicated), viewing and acknowledging by the
-- recipient only and once, adding people later, withdrawal notices, notifications for the addressed person only, isolation.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('3f000000-0000-0000-0000-000000000101', 'owner@rcpt.test'),
  ('3f000000-0000-0000-0000-000000000102', 'ann@rcpt.test'),
  ('3f000000-0000-0000-0000-000000000103', 'bob@rcpt.test'),
  ('3f000000-0000-0000-0000-000000000104', 'cat@rcpt.test'),
  ('3f000000-0000-0000-0000-000000000105', 'dan@rcpt.test'),
  ('3f000000-0000-0000-0000-000000000106', 'other@rcpt.test');
UPDATE public.profiles SET first_name = n, surname = 'Tester'
  FROM (VALUES ('3f000000-0000-0000-0000-000000000102'::uuid, 'Ann'), ('3f000000-0000-0000-0000-000000000105'::uuid, 'Dan')) v(id, n) WHERE profiles.id = v.id;

DO $$
DECLARE
  org uuid; site uuid; gi uuid; fi uuid; mc uuid; insp uuid; viewer uuid; m_ann uuid; m_bob uuid; m_cat uuid; m_dan uuid;
  a uuid; b uuid; b2 uuid; v1 timestamptz;
BEGIN
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000101');
  org := app.create_organisation('Rcpt Works', 'Plant A', 'PA', NULL);
  SELECT id INTO site FROM public.sites WHERE organisation_id = org;
  INSERT INTO public.departments (organisation_id, site_id, code, name) VALUES (org, site, 'GI', 'Goods-in') RETURNING id INTO gi;
  INSERT INTO public.departments (organisation_id, site_id, code, name) VALUES (org, site, 'FI', 'Final inspection') RETURNING id INTO fi;
  INSERT INTO public.departments (organisation_id, site_id, code, name) VALUES (org, site, 'MC', 'Machining') RETURNING id INTO mc;
  SELECT id INTO insp FROM public.roles WHERE organisation_id = org AND key = 'inspector';
  SELECT id INTO viewer FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  PERFORM pg_temp.logout();

  -- Ann: Goods-in and inspector (reached three ways), Bob: Goods-in, Cat: Final inspection (never targeted), Dan: named only.
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '3f000000-0000-0000-0000-000000000102', 'active') RETURNING id INTO m_ann;
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '3f000000-0000-0000-0000-000000000103', 'active') RETURNING id INTO m_bob;
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '3f000000-0000-0000-0000-000000000104', 'active') RETURNING id INTO m_cat;
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '3f000000-0000-0000-0000-000000000105', 'active') RETURNING id INTO m_dan;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) VALUES (org, m_ann, insp), (org, m_bob, viewer), (org, m_cat, viewer), (org, m_dan, viewer);
  INSERT INTO public.department_members (organisation_id, department_id, membership_id) VALUES (org, gi, m_ann), (org, gi, m_bob), (org, fi, m_cat);

  -- An alert nobody can receive is refused; the preview says how many each target reaches.
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000101');
  INSERT INTO public.quality_alerts (organisation_id, title, category, severity, description, required_action, effective_date, acknowledge_by)
    VALUES (org, 'Wrong spec on bar stock', 'supplier', 'high', 'd', 'a', current_date, current_date + 2) RETURNING id INTO a;
  PERFORM app.set_quality_alert_actions(a, '[{"description":"a"}]'::jsonb);
  PERFORM app.set_quality_alert_scope(a, jsonb_build_object('targets', jsonb_build_array(jsonb_build_object('departmentId', mc))));
  PERFORM pg_temp.assert_fails(format($q$SELECT app.issue_quality_alert(%L)$q$, a), 'an empty department reaches nobody');
  PERFORM pg_temp.assert_eq((app.preview_quality_alert_recipients(a) ->> 'total')::int, 0, 'preview: nobody');
  PERFORM app.set_quality_alert_scope(a, jsonb_build_object('targets', jsonb_build_array(
    jsonb_build_object('departmentId', gi), jsonb_build_object('roleId', insp), jsonb_build_object('membershipId', m_dan), jsonb_build_object('membershipId', m_ann))));
  PERFORM pg_temp.assert_eq((app.preview_quality_alert_recipients(a) ->> 'total')::int, 3, 'preview: Ann, Bob and Dan, each once');
  PERFORM pg_temp.assert_eq((SELECT array_agg((t ->> 'label') || ':' || (t ->> 'count') ORDER BY t ->> 'label') FROM jsonb_array_elements(app.preview_quality_alert_recipients(a) -> 'targets') t),
    ARRAY['Ann Tester:1', 'Dan Tester:1', 'Goods-in:2', 'Inspector:1'], 'preview: what each target reaches');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000102');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.preview_quality_alert_recipients(%L)$q$, a), 'only managers preview recipients');
  PERFORM pg_temp.logout();

  -- Issue: recipients are stored once each, with how they were reached.
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000101');
  PERFORM app.issue_quality_alert(a);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.quality_alert_recipients WHERE alert_id = a), 3::bigint, 'three recipients');
  PERFORM pg_temp.assert_eq((SELECT reached_via FROM public.quality_alert_recipients WHERE membership_id = m_ann), ARRAY['Department: Goods-in', 'Named', 'Role: Inspector'], 'Ann was reached three ways');
  PERFORM pg_temp.assert_eq((SELECT reached_via FROM public.quality_alert_recipients WHERE membership_id = m_bob), ARRAY['Department: Goods-in'], 'Bob through his department');
  PERFORM pg_temp.assert_eq((SELECT alert_reference FROM public.quality_alert_recipients WHERE membership_id = m_dan), 'QA-001 rev A', 'the reference is kept with the recipient');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.quality_alert_recipients), 3::bigint, 'a manager reads every recipient');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.visible_notifications(org) WHERE event_key LIKE 'quality_alert_recipients.%'), 0::bigint, 'the issuer is not told of their own action');
  PERFORM pg_temp.logout();

  -- Notifications: each recipient is told, only they see it, and a person not addressed sees nothing.
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.notifications n JOIN public.notification_event_types t ON t.id = n.event_type_id WHERE t.key = 'quality_alert_recipients.created' AND n.recipient_user_id IS NOT NULL), 3::bigint, 'three notices, each for one person');
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000102');
  PERFORM pg_temp.assert_eq((SELECT body FROM app.visible_notifications(org) WHERE event_key = 'quality_alert_recipients.created'), 'QA-001 rev A — Wrong spec on bar stock', 'Ann is told which alert');
  PERFORM pg_temp.assert_eq((SELECT details ->> 'alert_id' FROM app.visible_notifications(org) WHERE event_key = 'quality_alert_recipients.created'), a::text, 'and where to find it');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.quality_alert_recipients), 1::bigint, 'Ann reads only her own row');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000104');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.visible_notifications(org) WHERE event_key LIKE 'quality_alert_recipients.%'), 0::bigint, 'Cat was not addressed and is told nothing');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.quality_alert_recipients), 0::bigint, 'and reads no recipient rows');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.acknowledge_quality_alert(%L, 'on behalf of Ann')$q$, a), 'nobody acknowledges an alert that is not addressed to them');
  PERFORM pg_temp.logout();

  -- Viewing and acknowledging: by the recipient, once.
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000102');
  PERFORM app.mark_quality_alert_viewed(a);
  SELECT first_viewed_at INTO v1 FROM public.quality_alert_recipients;
  PERFORM pg_temp.assert_eq(v1 IS NOT NULL, true, 'first view recorded');
  PERFORM app.mark_quality_alert_viewed(a);
  PERFORM pg_temp.assert_eq((SELECT first_viewed_at FROM public.quality_alert_recipients), v1, 'the first view is never moved');
  PERFORM pg_temp.assert_fails($q$UPDATE public.quality_alert_recipients SET acknowledged_at = now()$q$, 'no direct writes by the recipient');
  PERFORM app.acknowledge_quality_alert(a, '  Quarantined lot 77  ');
  PERFORM pg_temp.assert_eq((SELECT (acknowledged_at IS NOT NULL, acknowledgement_note)::text FROM public.quality_alert_recipients), '(t,"Quarantined lot 77")', 'acknowledged with the note');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.acknowledge_quality_alert(%L, 'again')$q$, a), 'acknowledged once only');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.visible_notifications(org) WHERE event_key = 'quality_alert_recipients.updated'), 0::bigint, 'viewing and acknowledging notify nobody');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.quality_alert_recipients SET acknowledged_at = now() - interval '1 day' WHERE alert_id = %L AND membership_id = %L$q$, a, m_ann), 'an acknowledgement is frozen, even for the database owner');
  PERFORM pg_temp.assert_fails(format($q$DELETE FROM public.quality_alert_recipients WHERE alert_id = %L$q$, a), 'recipients are never removed');

  -- Adding someone later: managers only, active members, once, and the person is told.
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000101');
  PERFORM app.add_quality_alert_recipient(a, m_cat);
  PERFORM pg_temp.assert_eq((SELECT reached_via FROM public.quality_alert_recipients WHERE membership_id = m_cat), ARRAY['Added later'], 'added later');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.add_quality_alert_recipient(%L, %L)$q$, a, m_cat), 'not twice');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.add_quality_alert_recipient(%L, %L)$q$, a, gen_random_uuid()), 'not a stranger');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000104');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.visible_notifications(org) WHERE event_key = 'quality_alert_recipients.created'), 1::bigint, 'Cat is now told');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000103');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.add_quality_alert_recipient(%L, %L)$q$, a, m_dan), 'a recipient cannot add people');
  PERFORM pg_temp.logout();

  -- Withdrawal tells the recipients; an alert no longer in force cannot be acknowledged.
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000101');
  PERFORM app.withdraw_quality_alert(a, 'Issued in error');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000103');
  PERFORM pg_temp.assert_eq((SELECT title FROM app.visible_notifications(org) WHERE event_key = 'quality_alert_recipients.updated'), 'Quality alert withdrawn', 'Bob is told it is withdrawn, and only his own notice');
  PERFORM pg_temp.assert_eq((SELECT body FROM app.visible_notifications(org) WHERE event_key = 'quality_alert_recipients.updated'), 'QA-001 rev A — Wrong spec on bar stock', 'with the alert named');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.acknowledge_quality_alert(%L, NULL)$q$, a), 'a withdrawn alert is not acknowledged');
  PERFORM pg_temp.logout();

  -- A revision is asked afresh: everyone must acknowledge the new revision, the old one's acknowledgements stay.
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000101');
  INSERT INTO public.quality_alerts (organisation_id, title, category, severity, description, required_action, effective_date)
    VALUES (org, 'Temporary frequency change', 'process', 'low', 'd', 'a', current_date) RETURNING id INTO b;
  PERFORM app.set_quality_alert_actions(b, '[{"description":"a"}]'::jsonb);
  PERFORM app.set_quality_alert_scope(b, jsonb_build_object('targets', jsonb_build_array(jsonb_build_object('departmentId', gi))));
  PERFORM app.issue_quality_alert(b);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000102');
  PERFORM app.acknowledge_quality_alert(b, NULL);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000101');
  b2 := app.revise_quality_alert(b, 'Every 20 minutes, not 30');
  UPDATE public.quality_alerts SET effective_date = current_date WHERE id = b2;
  PERFORM app.issue_quality_alert(b2);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.quality_alert_recipients WHERE alert_id = b2 AND acknowledged_at IS NULL), 2::bigint, 'the new revision asks everyone again');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.quality_alert_recipients WHERE alert_id = b AND acknowledged_at IS NOT NULL), 1::bigint, 'and the old acknowledgement is kept');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000102');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.acknowledge_quality_alert(%L, NULL)$q$, b), 'the superseded revision cannot be acknowledged any more');
  PERFORM pg_temp.logout();

  -- Another organisation sees and does nothing.
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000106');
  PERFORM app.create_organisation('Other Works', 'Plant', 'PX', NULL);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.quality_alert_recipients), 0::bigint, 'another organisation reads no recipients');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.acknowledge_quality_alert(%L, NULL)$q$, a), 'cannot acknowledge a foreign alert');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.add_quality_alert_recipient(%L, %L)$q$, b2, m_dan), 'cannot add to a foreign alert');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.preview_quality_alert_recipients(%L)$q$, b2), 'cannot preview a foreign alert');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) >= 8 FROM public.audit_events WHERE entity_type = 'quality_alert_recipients'), true, 'recipient changes are audited');
END $$;

ROLLBACK;
