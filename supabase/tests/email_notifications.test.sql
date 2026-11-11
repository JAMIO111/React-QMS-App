-- Email notifications (docs/email-oauth-plan.md, EM1): per-person email choices, the outbox fan-out with the in-app visibility rules, leasing and back-off,
-- integration alerts from finished imports, and who may call what.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
  ('3e000000-0000-0000-0000-000000000101', 'owner@mail.test', now()),
  ('3e000000-0000-0000-0000-000000000102', 'viewer@mail.test', now()),
  ('3e000000-0000-0000-0000-000000000103', 'unconfirmed@mail.test', NULL),
  ('3e000000-0000-0000-0000-000000000104', 'outsider@mail.test', now());

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

CREATE FUNCTION pg_temp.assert_true(p boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p IS NOT TRUE THEN RAISE EXCEPTION 'FAILED: %', label; END IF; END $$;

DO $$
DECLARE
  owner uuid := '3e000000-0000-0000-0000-000000000101'; viewer uuid := '3e000000-0000-0000-0000-000000000102';
  unconfirmed uuid := '3e000000-0000-0000-0000-000000000103'; outsider uuid := '3e000000-0000-0000-0000-000000000104';
  org uuid; org2 uuid; n_id uuid; e_id uuid; v_claims text; leased record; conn uuid; run uuid; alert record; t_qa uuid;
BEGIN
  PERFORM pg_temp.login(owner); org := app.create_organisation('Mail Works', 'Plant A', 'PA', NULL); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(outsider); org2 := app.create_organisation('Other Works', 'Plant B', 'PB', NULL); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, viewer, 'active'), (org, unconfirmed, 'active');
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, r.id FROM public.organisation_users ou JOIN public.roles r ON r.organisation_id = org AND r.key = 'viewer'
     WHERE ou.organisation_id = org AND ou.user_id IN (viewer, unconfirmed);
  PERFORM pg_temp.give_controller_seat(org, owner);

  -- ---- choices ----
  PERFORM pg_temp.login(viewer);
  PERFORM pg_temp.assert_true((SELECT NOT email AND NOT email_default AND NOT email_overridden AND enabled FROM app.list_notification_preferences(org) WHERE key = 'parts.created'),
    'a part is not emailed by default, though it is shown in the app');
  PERFORM app.set_notification_email(org, 'parts.created', true);
  PERFORM pg_temp.assert_true((SELECT email AND email_overridden AND NOT overridden FROM app.list_notification_preferences(org) WHERE key = 'parts.created'), 'the email choice is kept on its own');
  PERFORM pg_temp.assert_eq((SELECT enabled FROM public.notification_preferences WHERE user_id = viewer AND organisation_id = org), NULL::boolean, 'the in-app choice still follows the default');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.set_notification_email(%L, 'nonsense.created', true)$f$, org)), 5), 'QM010', 'an unknown event is refused');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.set_notification_email(%L, 'integration_alerts.created', true)$f$, org)), 5), 'QM010', 'an event the person may not see is refused');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(unconfirmed); PERFORM app.set_notification_email(org, 'parts.created', true); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(outsider);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.set_notification_email(%L, 'parts.created', true)$f$, org)), 5), '42501', 'an outsider cannot choose');
  PERFORM pg_temp.logout();

  -- ---- fan-out ----
  PERFORM pg_temp.login(owner);
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'EM-1', 'Mailed part');
  PERFORM pg_temp.logout();
  v_claims := current_setting('request.jwt.claims', true);
  PERFORM pg_temp.assert_eq(app.system_queue_notification_emails(100), 1, 'one email: the viewer (the owner made it; the other address is unconfirmed)');
  PERFORM pg_temp.assert_eq(coalesce(current_setting('request.jwt.claims', true), ''), coalesce(v_claims, ''), 'the caller''s claims are put back');
  PERFORM pg_temp.assert_eq((SELECT to_address FROM public.email_outbox WHERE organisation_id = org), 'viewer@mail.test', 'to the viewer''s confirmed address');
  PERFORM pg_temp.assert_eq(app.system_queue_notification_emails(100), 0, 'a notice is considered once: never mailed twice');
  PERFORM pg_temp.assert_true(NOT EXISTS (SELECT 1 FROM public.notifications WHERE email_queued_at IS NULL), 'every notice is marked');

  -- in the app off → no email, whatever the email choice
  PERFORM pg_temp.login(viewer); PERFORM app.set_notification_preference(org, 'parts.created', false); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(owner); INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'EM-2', 'Quiet part'); PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(app.system_queue_notification_emails(100), 0, 'a notice switched off in the app is not emailed');
  PERFORM pg_temp.login(viewer);
  PERFORM app.set_notification_preference(org, 'parts.created', NULL);
  PERFORM pg_temp.assert_eq((SELECT email FROM public.notification_preferences WHERE user_id = viewer AND organisation_id = org), true, 'clearing the in-app choice keeps the email one');
  PERFORM app.set_notification_email(org, 'parts.created', NULL);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.notification_preferences WHERE user_id = viewer AND organisation_id = org), 0::bigint, 'with both back to default the row goes');
  PERFORM pg_temp.logout();

  -- a notice addressed to one person: only them, emailed by default; an old notice is never mailed
  SELECT id INTO t_qa FROM public.notification_event_types WHERE key = 'quality_alert_recipients.created';
  PERFORM pg_temp.assert_true((SELECT email_default FROM public.notification_event_types WHERE id = t_qa), 'notices addressed to you are emailed by default');
  INSERT INTO public.notifications (organisation_id, event_type_id, audit_event_id, entity_type, entity_id, title, body, details, actor_user_id, recipient_user_id)
  VALUES (org, t_qa, gen_random_uuid(), 'quality_alert_recipients', gen_random_uuid()::text, 'Quality alert addressed to you', 'QA-001', '{}', NULL, owner) RETURNING id INTO n_id;
  INSERT INTO public.notifications (organisation_id, event_type_id, audit_event_id, entity_type, entity_id, title, body, details, actor_user_id, recipient_user_id, created_at)
  VALUES (org, t_qa, gen_random_uuid(), 'quality_alert_recipients', gen_random_uuid()::text, 'Old', 'QA-000', '{}', NULL, owner, now() - interval '2 days');
  PERFORM pg_temp.assert_eq(app.system_queue_notification_emails(100), 1, 'only the person it is addressed to, and not the two-day-old one');
  PERFORM pg_temp.assert_eq((SELECT user_id FROM public.email_outbox WHERE notification_id = n_id), owner, 'the owner is the one emailed');

  -- ---- leasing and outcomes ----
  SELECT * INTO leased FROM app.system_lease_emails(10, 60) WHERE to_address = 'owner@mail.test';
  PERFORM pg_temp.assert_eq(leased.organisation_name, 'Mail Works', 'the lease carries what the email needs');
  PERFORM pg_temp.assert_eq(leased.event_key, 'quality_alert_recipients.created', 'and the event');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.system_lease_emails(10, 60)), 0::bigint, 'a leased email is not handed out twice');
  e_id := leased.id;
  PERFORM pg_temp.assert_eq(app.system_finish_email(e_id, 'failed', 'resend', NULL, 'HTTP 503'), 'queued', 'a failure is tried again');
  PERFORM pg_temp.assert_true((SELECT attempts = 1 AND next_attempt_at BETWEEN now() + interval '50 seconds' AND now() + interval '70 seconds' AND leased_until IS NULL FROM public.email_outbox WHERE id = e_id), 'after a minute');
  UPDATE public.email_outbox SET next_attempt_at = now() - interval '1 second' WHERE id = e_id;
  PERFORM app.system_finish_email(e_id, 'failed', 'resend', NULL, 'HTTP 503');
  PERFORM pg_temp.assert_true((SELECT next_attempt_at > now() + interval '3 minutes' FROM public.email_outbox WHERE id = e_id), 'then after four minutes');
  PERFORM app.system_finish_email(e_id, 'failed', 'resend', NULL, 'x'); PERFORM app.system_finish_email(e_id, 'failed', 'resend', NULL, 'x');
  PERFORM pg_temp.assert_eq(app.system_finish_email(e_id, 'failed', 'resend', NULL, 'still down'), 'failed', 'and gives up after five attempts');
  PERFORM pg_temp.assert_eq(app.system_finish_email(e_id, 'sent', 'resend', 'm1', NULL), 'failed', 'a final email is not changed again');
  SELECT id INTO e_id FROM public.email_outbox WHERE to_address = 'viewer@mail.test';
  PERFORM pg_temp.assert_eq(app.system_finish_email(e_id, 'unsent', 'none', NULL, NULL), 'unsent', 'without a provider it is kept as not sent');
  PERFORM pg_temp.assert_eq((SELECT last_error FROM public.email_outbox WHERE id = e_id), 'No mail provider is set up', 'with the reason');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails($f$SELECT app.system_finish_email(gen_random_uuid(), 'sent')$f$), 5), 'P0002', 'an unknown email');
  PERFORM pg_temp.assert_eq(app.system_finish_email(e_id, 'sent', 'resend', 'm2', NULL), 'unsent', 'a final email ignores later outcomes');
  INSERT INTO public.email_outbox (organisation_id, notification_id, user_id, to_address) VALUES (org, n_id, viewer, 'viewer@mail.test') RETURNING id INTO e_id;
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.system_finish_email(%L, 'maybe')$f$, e_id)), 5), '22023', 'an unknown outcome is refused');
  PERFORM pg_temp.assert_eq(app.system_finish_email(e_id, 'refused', 'resend', NULL, 'Invalid to address'), 'failed', 'a refusal that will not change is final at once');
  DELETE FROM public.email_outbox WHERE id = e_id;

  -- ---- who sees the outbox ----
  PERFORM pg_temp.login(viewer);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.email_outbox), 1::bigint, 'a person sees only the emails sent to them');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails($f$UPDATE public.email_outbox SET status = 'sent'$f$), 5), '42501', 'and cannot change them');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails($f$SELECT app.system_queue_notification_emails(1)$f$), 5), '42501', 'a signed-in user cannot run the fan-out');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails($f$SELECT * FROM app.system_lease_emails(1, 60)$f$), 5), '42501', 'nor lease emails');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails($f$SELECT app.platform_email_outbox(24)$f$), 5), '42501', 'and only an operator sees the email summary');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(outsider);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.email_outbox), 0::bigint, 'an outsider sees none');
  PERFORM pg_temp.logout();

  -- ---- integration alerts ----
  PERFORM pg_temp.login(owner);
  conn := app.create_integration_connection(org, 'csv', 'Files', 'files', '{}'::jsonb);
  PERFORM pg_temp.logout();
  SET CONSTRAINTS public.integration_sync_runs_alert IMMEDIATE;
  INSERT INTO public.integration_sync_runs (organisation_id, connection_id, entity_type, kind, status, requested_by) VALUES (org, conn, 'machine', 'preview', 'running', owner) RETURNING id INTO run;
  UPDATE public.integration_sync_runs SET status = 'partial', rejected = 3 WHERE id = run;
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.integration_alerts WHERE run_id = run), 0::bigint, 'a preview never alerts');
  INSERT INTO public.integration_sync_runs (organisation_id, connection_id, entity_type, kind, status, requested_by) VALUES (org, conn, 'part', 'full', 'running', owner) RETURNING id INTO run;
  UPDATE public.integration_sync_runs SET status = 'succeeded', created = 5 WHERE id = run;
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.integration_alerts WHERE run_id = run), 0::bigint, 'a clean import does not alert');
  INSERT INTO public.integration_sync_runs (organisation_id, connection_id, entity_type, kind, status, requested_by) VALUES (org, conn, 'supplier', 'full', 'running', owner) RETURNING id INTO run;
  UPDATE public.integration_sync_runs SET status = 'partial', rejected = 2, parked = 1, missing = '{"listed": 4, "held": 0}' WHERE id = run;
  SELECT * INTO alert FROM public.integration_alerts WHERE run_id = run;
  PERFORM pg_temp.assert_eq(alert.kind, 'needs_attention', 'rows for a person make an alert');
  PERFORM pg_temp.assert_eq(alert.summary, 'Files: supplier import needs attention — 2 rejected, 1 to review, 4 no longer in the source', 'that says what is waiting');
  UPDATE public.integration_sync_runs SET updated_at = now() WHERE id = run;
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.integration_alerts WHERE run_id = run), 1::bigint, 'one alert per run');
  PERFORM pg_temp.assert_true((SELECT details ->> 'run_id' = run::text AND details ->> 'connection_id' = conn::text AND actor_user_id IS NULL AND email_queued_at IS NULL
                                 FROM public.notifications WHERE entity_type = 'integration_alerts' AND entity_id = alert.id::text), 'its notice links to the run and has no actor');
  INSERT INTO public.integration_sync_runs (organisation_id, connection_id, entity_type, kind, status, requested_by) VALUES (org, conn, 'customer', 'incremental', 'running', owner) RETURNING id INTO run;
  UPDATE public.integration_sync_runs SET status = 'failed', error_summary = 'The API refused the credential (401)' WHERE id = run;
  PERFORM pg_temp.assert_eq((SELECT summary FROM public.integration_alerts WHERE run_id = run), 'Files: customer import failed — The API refused the credential (401)', 'a failed import alerts with its error');
  -- the Controller (owner, who started it) is emailed by default; the viewer may not see integrations
  DELETE FROM public.email_outbox;
  PERFORM pg_temp.assert_eq(app.system_queue_notification_emails(100), 2, 'both alerts go to the Controller, who started the imports');
  PERFORM pg_temp.assert_true(NOT EXISTS (SELECT 1 FROM public.email_outbox WHERE user_id <> owner), 'and to nobody without integrations.read');
  SET CONSTRAINTS public.integration_sync_runs_alert DEFERRED;
END $$;

ROLLBACK;
