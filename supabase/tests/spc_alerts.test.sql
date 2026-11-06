-- PC11: SPC alerts — raised only through the function, once per point, acknowledged once with a note, never deleted,
-- audited, notified, and visible to spc.read in the own organisation only.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('3c000000-0000-0000-0000-000000000101', 'owner@alerts.test'),
  ('3c000000-0000-0000-0000-000000000102', 'inspector@alerts.test'),
  ('3c000000-0000-0000-0000-000000000103', 'viewer@alerts.test'),
  ('3c000000-0000-0000-0000-000000000104', 'other@alerts.test');

DO $$
DECLARE
  org uuid; part uuid; m uuid; a uuid; n integer; rec uuid; site uuid;
  one jsonb := '[{"characteristicKey":"OD","characteristicName":"Outer diameter","operationCode":"OP-020","variant":"imr","rule":"we1","side":"above","pointAt":"2026-11-05T08:00:00Z","summary":"Rule 1: One point beyond 3σ","inspectionId":null,"inspectionReference":"IPI-26-0001"}]';
BEGIN
  PERFORM pg_temp.login('3c000000-0000-0000-0000-000000000101');
  org := app.create_organisation('Alert Works', 'Plant A', 'PA', NULL);
  SELECT id INTO site FROM public.sites WHERE organisation_id = org;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'HCR-100', 'Rod 100') RETURNING id INTO part;
  PERFORM pg_temp.logout();
  FOREACH a IN ARRAY ARRAY['3c000000-0000-0000-0000-000000000102', '3c000000-0000-0000-0000-000000000103']::uuid[] LOOP
    INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, a, 'active') RETURNING id INTO m;
    INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
      SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = CASE WHEN a = '3c000000-0000-0000-0000-000000000102' THEN 'inspector' ELSE 'viewer' END;
  END LOOP;

  -- An inspector (records inspections) raises an alert; the same point again is ignored.
  PERFORM pg_temp.login('3c000000-0000-0000-0000-000000000102');
  PERFORM pg_temp.assert_eq(app.raise_spc_alerts(org, part, one), 1, 'one alert raised');
  PERFORM pg_temp.assert_eq(app.raise_spc_alerts(org, part, one), 0, 'the same point never raises twice');
  PERFORM pg_temp.assert_eq((SELECT (part_number, status, created_by = '3c000000-0000-0000-0000-000000000102')::text FROM public.spc_alerts), '(HCR-100,open,t)', 'stamped with the part number');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.spc_alerts (organisation_id, part_id, part_number, characteristic_key, characteristic_name, operation_code, variant, rule, point_at, summary)
    VALUES (%L, %L, 'x', 'OD', 'OD', 'OP', 'imr', 'we1', now(), 'x')$q$, org, part), 'no direct inserts');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.spc_alerts SET status = 'acknowledged'$q$), 'no direct updates');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.raise_spc_alerts(%L, %L, '[{"characteristicKey":"OD","characteristicName":"OD","operationCode":"OP","variant":"zzz","rule":"we1","side":null,"pointAt":"2026-11-05T08:00:00Z","summary":"x","inspectionId":null,"inspectionReference":null}]'::jsonb)$q$, org, part), 'only known chart variants');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.acknowledge_spc_alert(%L, 'done')$q$, (SELECT id FROM public.spc_alerts)), 'an inspector cannot acknowledge');
  PERFORM pg_temp.logout();

  -- A viewer reads alerts but cannot raise them; someone from another organisation neither reads nor raises.
  PERFORM pg_temp.login('3c000000-0000-0000-0000-000000000103');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.spc_alerts), 1::bigint, 'a viewer reads alerts');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.raise_spc_alerts(%L, %L, '[]'::jsonb)$q$, org, part), 'a viewer cannot raise alerts');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login('3c000000-0000-0000-0000-000000000104');
  PERFORM app.create_organisation('Other Works', 'Plant', 'PX', NULL);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.spc_alerts), 0::bigint, 'another organisation sees none');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.raise_spc_alerts(%L, %L, '[]'::jsonb)$q$, org, part), 'no alerts in a foreign organisation');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.acknowledge_spc_alert(%L, 'done')$q$, (SELECT id FROM public.spc_alerts WHERE false UNION ALL SELECT gen_random_uuid() LIMIT 1)), 'a foreign alert cannot be acknowledged');
  PERFORM pg_temp.logout();

  -- The owner acknowledges, with a note, once; nothing else about it can change; it is never deleted.
  PERFORM pg_temp.login('3c000000-0000-0000-0000-000000000101');
  SELECT id INTO a FROM public.spc_alerts;
  PERFORM pg_temp.assert_fails(format($q$SELECT app.acknowledge_spc_alert(%L, '   ')$q$, a), 'a note is required');
  PERFORM app.acknowledge_spc_alert(a, 'Tool changed, rechecked the next part');
  PERFORM pg_temp.assert_eq((SELECT (status, acknowledgement_note, acknowledged_by = '3c000000-0000-0000-0000-000000000101')::text FROM public.spc_alerts WHERE id = a),
    '(acknowledged,"Tool changed, rechecked the next part",t)', 'acknowledged with the note');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.acknowledge_spc_alert(%L, 'again')$q$, a), 'acknowledged once only');
  PERFORM pg_temp.logout();
  -- Frozen and undeletable even for the table owner's triggers (direct statements as the superuser run the trigger too).
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.spc_alerts SET summary = 'edited' WHERE id = %L$q$, a), 'an alert is not edited');
  PERFORM pg_temp.assert_fails(format($q$DELETE FROM public.spc_alerts WHERE id = %L$q$, a), 'an alert is never deleted');
  PERFORM pg_temp.assert_eq((SELECT count(*) >= 2 FROM public.audit_events WHERE entity_type = 'spc_alerts'), true, 'raising and acknowledging are audited');

  -- Notifications: raised (on for spc.manage holders by default), seen by the owner (not the inspector who raised it).
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.notifications n JOIN public.notification_event_types t ON t.id = n.event_type_id WHERE t.key = 'spc_alerts.created' AND n.organisation_id = org), 1::bigint, 'a notification for the alert');
  PERFORM pg_temp.login('3c000000-0000-0000-0000-000000000101');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.visible_notifications(org) WHERE event_key = 'spc_alerts.created'), 1::bigint, 'the owner is notified');
  PERFORM pg_temp.assert_eq((SELECT body FROM app.visible_notifications(org) WHERE event_key = 'spc_alerts.created'), 'HCR-100 — Outer diameter — Rule 1: One point beyond 3σ', 'the message names part, characteristic and rule');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login('3c000000-0000-0000-0000-000000000102');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.visible_notifications(org) WHERE event_key = 'spc_alerts.created'), 0::bigint, 'whoever raised it is not told about their own action');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
