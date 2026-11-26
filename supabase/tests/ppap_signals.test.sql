-- PPAP PP6b: the workflow triggers (status events and their facts, the dates the worker turns into events once for each due date), the reminders areas for interim approvals
-- and revalidation, and the notice to the owner of a decided submission (who is told, and who is not).
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('5f100000-0000-0000-0000-000000000c01', 'ann@pn.test'), ('5f100000-0000-0000-0000-000000000c02', 'bob@pn.test'),
  ('5f100000-0000-0000-0000-000000000c03', 'cat@pn.test'), ('5f100000-0000-0000-0000-000000000c04', 'dan@pn.test'),
  ('5f100000-0000-0000-0000-000000000c05', 'eve@pn.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

CREATE FUNCTION pg_temp.events_of(p_entity uuid, p_type text) RETURNS bigint LANGUAGE sql SECURITY DEFINER AS $$
  SELECT count(*) FROM public.outbox_events WHERE entity_id = p_entity AND event_type = p_type
$$;
CREATE FUNCTION pg_temp.event_of(p_entity uuid, p_type text) RETURNS public.outbox_events LANGUAGE sql SECURITY DEFINER AS $$
  SELECT * FROM public.outbox_events WHERE entity_id = p_entity AND event_type = p_type ORDER BY id DESC LIMIT 1
$$;
CREATE FUNCTION pg_temp.notices_of(p_entity uuid, p_user uuid) RETURNS bigint LANGUAGE sql SECURITY DEFINER AS $$
  SELECT count(*) FROM public.notifications WHERE entity_type = 'ppap_submissions' AND entity_id = p_entity::text AND recipient_user_id = p_user
$$;

-- A submission sent to the customer: prepared by the owner, the warrant signed by someone else, ready, sent two days ago. Returns its id.
CREATE FUNCTION pg_temp.sent(p_org uuid, p_part uuid, p_cust uuid, p_owner uuid, p_signer uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE s uuid;
BEGIN
  PERFORM pg_temp.login(p_owner);
  s := (app.create_ppap(p_org, jsonb_build_object('partId', p_part, 'customerId', p_cust, 'reason', 'new_part')) ->> 'id')::uuid;
  PERFORM app.save_ppap_psw(s, '{"partWeight": 1, "resultsMeetRequirements": true}'::jsonb);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(p_signer);
  PERFORM app.sign_ppap_psw(s, 'Quality Manager');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(p_owner);
  PERFORM app.mark_ppap_ready(s);
  PERFORM app.submit_ppap(s, current_date - 2, 'Customer portal', NULL);
  PERFORM pg_temp.logout();
  RETURN s;
END $$;

-- Decisions are frozen even for SQL, so to try other expiry dates the test turns the triggers off for one statement (it runs as the owner of the tables).
CREATE FUNCTION pg_temp.ppap_set_interim_end(p_sub uuid, p_end date) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('session_replication_role', 'replica', true);
  UPDATE public.ppap_decisions SET decided_on = p_end - 30, expires_on = p_end WHERE submission_id = p_sub AND kind = 'interim_approved';
  PERFORM set_config('session_replication_role', 'origin', true);
END $$;

CREATE FUNCTION pg_temp.ppap_set_review(p_sub uuid, p_on date) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('session_replication_role', 'replica', true);
  UPDATE public.ppap_submissions SET next_review_on = p_on WHERE id = p_sub;
  PERFORM set_config('session_replication_role', 'origin', true);
END $$;

DO $$
DECLARE
  ann uuid := '5f100000-0000-0000-0000-000000000c01'; bob uuid := '5f100000-0000-0000-0000-000000000c02';
  cat uuid := '5f100000-0000-0000-0000-000000000c03'; dan uuid := '5f100000-0000-0000-0000-000000000c04'; eve uuid := '5f100000-0000-0000-0000-000000000c05';
  org uuid; org2 uuid; u uuid; cust uuid; p1 uuid; p2 uuid; p3 uuid; p4 uuid; rv uuid;
  s1 uuid; s2 uuid; s3 uuid; s4 uuid; f jsonb; ev public.outbox_events%ROWTYPE; res jsonb; today date := (now() AT TIME ZONE 'UTC')::date; review date; r text; n bigint;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('PN Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('PN Beta'); PERFORM pg_temp.logout();
  UPDATE public.organisation_settings SET time_zone = 'UTC' WHERE organisation_id IN (org, org2);
  FOREACH u IN ARRAY ARRAY[bob, cat, dan] LOOP
    INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u, 'active');
  END LOOP;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = CASE WHEN ou.user_id = dan THEN 'quality_manager' WHEN ou.user_id = bob THEN 'viewer' ELSE 'quality_engineer' END)
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id IN (bob, cat, dan);

  PERFORM pg_temp.login(ann);
  INSERT INTO public.customers (organisation_id, code, name) VALUES (org, 'PN-C1', 'Acme Motors') RETURNING id INTO cust;
  FOR n IN 1..4 LOOP
    INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'PN-P' || n, 'Part ' || n) RETURNING id INTO u;
    INSERT INTO public.part_revisions (organisation_id, part_id, revision) VALUES (org, u, 'A') RETURNING id INTO rv;
    UPDATE public.part_revisions SET status = 'released' WHERE id = rv;
    IF n = 1 THEN p1 := u; ELSIF n = 2 THEN p2 := u; ELSIF n = 3 THEN p3 := u; ELSE p4 := u; END IF;
  END LOOP;
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(dan);
  PERFORM app.set_ppap_customer_rules(cust, '{"defaultLevel":1}'::jsonb);
  PERFORM pg_temp.logout();

  -- ---- what a rule can start from ----
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.workflow_triggers() WHERE event_type LIKE 'ppap.%'), 6::bigint, 'six PPAP triggers');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.workflow_triggers() WHERE event_type LIKE 'ppap.%' AND permission = 'ppap.read' AND entity_type = 'ppap'), 6::bigint, 'each is about the submission and needs ppap.read');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.reminder_areas() WHERE key = 'ppap_interim' AND soon_days = 30), 1::bigint, 'the interim area is there');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.reminder_areas() WHERE key = 'ppap_reviews' AND soon_days = 30), 1::bigint, 'the revalidation area is there');

  -- ---- sending ----
  s1 := pg_temp.sent(org, p1, cust, cat, dan);
  PERFORM pg_temp.assert_eq(pg_temp.events_of(s1, 'ppap.submitted'), 1::bigint, 'sending writes one event');
  ev := pg_temp.event_of(s1, 'ppap.submitted');
  PERFORM pg_temp.assert_eq(ev.entity_type, 'ppap', 'about the submission');
  f := app.system_workflow_facts(org, 'ppap', s1, ev.payload);
  PERFORM pg_temp.assert_eq(f ->> 'record_kind', 'ppap', 'it opens the PPAP page');
  PERFORM pg_temp.assert_eq((f ->> 'record_id')::uuid, s1, 'the submission');
  PERFORM pg_temp.assert_eq(f ->> 'direction', 'submitted', 'the direction is a fact');
  PERFORM pg_temp.assert_eq((f ->> 'level')::int, 1, 'so is the level');
  PERFORM pg_temp.assert_eq(f ->> 'reason', 'new_part', 'and the reason');
  PERFORM pg_temp.assert_eq(f ->> 'party', 'Acme Motors', 'and who it is for');
  PERFORM pg_temp.assert_eq(f ->> 'part_number', 'PN-P1', 'and the part');
  PERFORM pg_temp.assert_eq((f ->> 'owner_user_id')::uuid, cat, 'the owner');
  PERFORM pg_temp.assert_eq(f ->> 'to_status', 'submitted', 'and where it moved to');
  PERFORM pg_temp.assert_eq(app.system_workflow_facts(org2, 'ppap', s1, ev.payload), NULL::jsonb, 'another organisation gets no facts');
  PERFORM pg_temp.assert_eq(pg_temp.notices_of(s1, cat), 0::bigint, 'sending is not a decision: nobody is told of it');

  -- ---- an approval by someone else: an event and a notice to the owner ----
  PERFORM pg_temp.login(dan);
  PERFORM app.record_ppap_decision(s1, 'approved', today, 'ACME-OK-1');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(pg_temp.events_of(s1, 'ppap.approved'), 1::bigint, 'the approval writes one event');
  PERFORM pg_temp.assert_eq(pg_temp.events_of(s1, 'ppap.rejected') + pg_temp.events_of(s1, 'ppap.interim_approved'), 0::bigint, 'and no other decision');
  PERFORM pg_temp.assert_eq(pg_temp.notices_of(s1, cat), 1::bigint, 'the owner is told');
  PERFORM pg_temp.assert_eq(pg_temp.notices_of(s1, dan), 0::bigint, 'the person who recorded it is not');
  PERFORM pg_temp.assert_eq(pg_temp.notices_of(s1, bob), 0::bigint, 'nor is anyone else');
  PERFORM pg_temp.assert_eq((SELECT details ->> 'ppap_id' FROM public.notifications WHERE entity_type = 'ppap_submissions' AND entity_id = s1::text AND recipient_user_id = cat), s1::text, 'the notice names the submission');
  PERFORM pg_temp.assert_eq((SELECT bool_and(own_record) FROM public.notification_event_types WHERE key = 'ppap_submissions.updated'), true, 'it is addressed to one person');

  -- ---- a decision by the owner is not news to them ----
  s2 := pg_temp.sent(org, p2, cust, ann, dan);
  PERFORM pg_temp.login(ann);
  PERFORM app.record_ppap_decision(s2, 'rejected', today, NULL, NULL, 'The gauge study was missing');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(pg_temp.events_of(s2, 'ppap.rejected'), 1::bigint, 'a rejection writes its event');
  PERFORM pg_temp.assert_eq(pg_temp.notices_of(s2, ann), 0::bigint, 'the owner who recorded it is not told of their own action');
  f := app.system_workflow_facts(org, 'ppap', s2, (pg_temp.event_of(s2, 'ppap.rejected')).payload);
  PERFORM pg_temp.assert_eq(f ->> 'status', 'rejected', 'the status is a fact');
  PERFORM pg_temp.assert_eq(f ->> 'from_status', 'submitted', 'and where it came from');

  -- ---- an interim approval ----
  s3 := pg_temp.sent(org, p3, cust, cat, dan);
  PERFORM pg_temp.login(dan);
  PERFORM app.record_ppap_decision(s3, 'interim_approved', today, NULL, today + 10, 'Until the new gauge arrives');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(pg_temp.events_of(s3, 'ppap.interim_approved'), 1::bigint, 'an interim approval writes its event');
  PERFORM pg_temp.assert_eq(pg_temp.notices_of(s3, cat), 1::bigint, 'and tells the owner');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.notifications WHERE entity_type = 'ppap_submissions' AND entity_id = s3::text AND body LIKE '%Approved for now%'), 1::bigint, 'in words');

  -- ---- reminders: an interim approval ----
  SELECT count(*) INTO n FROM app.reminder_candidates(org, today) WHERE area = 'ppap_interim' AND record_id = s3 AND user_id = cat AND target_id = s3 AND due_on = today + 10 AND permission = 'ppap.read';
  PERFORM pg_temp.assert_eq(n, 1::bigint, 'the owner is told of an interim approval that runs out within thirty days');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.reminder_candidates(org, today) WHERE area = 'ppap_interim' AND user_id <> cat), 0::bigint, 'and nobody else');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.reminder_candidates(org, today) WHERE area = 'ppap_interim' AND record_id = s1), 0::bigint, 'an approved submission is not an interim one');

  -- ---- reminders: revalidation ----
  review := (SELECT next_review_on FROM public.ppap_submissions WHERE id = s1);
  PERFORM pg_temp.assert_eq(review IS NOT NULL, true, 'an approval has a review date');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.reminder_candidates(org, review - 31) WHERE area = 'ppap_reviews'), 0::bigint, 'not told before thirty days');
  SELECT count(*) INTO n FROM app.reminder_candidates(org, review - 30) WHERE area = 'ppap_reviews' AND record_id = s1 AND user_id = cat AND target_id = s1 AND due_on = review AND permission = 'ppap.read';
  PERFORM pg_temp.assert_eq(n, 1::bigint, 'the owner is told thirty days ahead');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.reminder_candidates(org, review - 30) WHERE area = 'ppap_reviews' AND record_id <> s1), 0::bigint, 'only for approved submissions');

  -- ---- the dates the worker turns into events ----
  res := app.system_emit_ppap_due_events(200);
  PERFORM pg_temp.assert_eq(pg_temp.events_of(s3, 'ppap.interim_expiring'), 1::bigint, 'an interim approval ten days from the end is written');
  PERFORM pg_temp.assert_eq(pg_temp.events_of(s1, 'ppap.interim_expiring'), 0::bigint, 'an approved one writes none');
  PERFORM app.system_emit_ppap_due_events(200);
  PERFORM pg_temp.assert_eq(pg_temp.events_of(s3, 'ppap.interim_expiring'), 1::bigint, 'asking again writes nothing more for the same expiry date');
  ev := pg_temp.event_of(s3, 'ppap.interim_expiring');
  PERFORM pg_temp.assert_eq(ev.payload ->> 'due_on', (today + 10)::text, 'the expiry date is in the event');
  f := app.system_workflow_facts(org, 'ppap', s3, ev.payload);
  PERFORM pg_temp.assert_eq((f ->> 'days_to_expiry')::int, 10, 'the days left are a fact');
  PERFORM pg_temp.assert_eq(f ->> 'record_kind', 'ppap', 'it opens the PPAP page');
  -- too far ahead is not news yet, one that ran out last week is not news any more
  DELETE FROM public.outbox_events WHERE entity_id = s3 AND event_type = 'ppap.interim_expiring';
  PERFORM pg_temp.ppap_set_interim_end(s3, today + 20);
  PERFORM app.system_emit_ppap_due_events(200);
  PERFORM pg_temp.assert_eq(pg_temp.events_of(s3, 'ppap.interim_expiring'), 0::bigint, 'twenty days ahead is not near enough');
  PERFORM pg_temp.ppap_set_interim_end(s3, today - 9);
  PERFORM app.system_emit_ppap_due_events(200);
  PERFORM pg_temp.assert_eq(pg_temp.events_of(s3, 'ppap.interim_expiring'), 0::bigint, 'one that ran out nine days ago is not news');
  PERFORM pg_temp.ppap_set_interim_end(s3, today - 1);
  PERFORM app.system_emit_ppap_due_events(200);
  PERFORM pg_temp.assert_eq(pg_temp.events_of(s3, 'ppap.interim_expiring'), 1::bigint, 'one that ran out yesterday is');
  f := app.system_workflow_facts(org, 'ppap', s3, (pg_temp.event_of(s3, 'ppap.interim_expiring')).payload);
  PERFORM pg_temp.assert_eq((f ->> 'days_to_expiry')::int, -1, 'and is a day past');

  -- a revalidation reached
  PERFORM pg_temp.ppap_set_review(s1, today - 1);
  PERFORM app.system_emit_ppap_due_events(200);
  PERFORM pg_temp.assert_eq(pg_temp.events_of(s1, 'ppap.review_due'), 1::bigint, 'a review date that has been reached is written');
  PERFORM app.system_emit_ppap_due_events(200);
  PERFORM pg_temp.assert_eq(pg_temp.events_of(s1, 'ppap.review_due'), 1::bigint, 'once for that date');
  f := app.system_workflow_facts(org, 'ppap', s1, (pg_temp.event_of(s1, 'ppap.review_due')).payload);
  PERFORM pg_temp.assert_eq((f ->> 'days_overdue')::int, 1, 'days past the date is a fact');
  PERFORM pg_temp.ppap_set_review(s1, today + 10);
  DELETE FROM public.outbox_events WHERE entity_id = s1 AND event_type = 'ppap.review_due';
  PERFORM app.system_emit_ppap_due_events(200);
  PERFORM pg_temp.assert_eq(pg_temp.events_of(s1, 'ppap.review_due'), 0::bigint, 'a review not yet reached is not written');
  -- a withdrawn or rejected submission has nothing to revalidate
  PERFORM pg_temp.ppap_set_review(s2, today - 1);
  PERFORM app.system_emit_ppap_due_events(200);
  PERFORM pg_temp.assert_eq(pg_temp.events_of(s2, 'ppap.review_due'), 0::bigint, 'a rejected submission is not revalidated');

  -- ---- an update that is not a decision tells nobody ----
  s4 := pg_temp.sent(org, p4, cust, cat, dan);
  PERFORM pg_temp.assert_eq(pg_temp.notices_of(s4, cat), 0::bigint, 'a submission only sent has no notice');

  -- ---- who may run the system function ----
  PERFORM pg_temp.login(cat);
  r := pg_temp.fails('SELECT app.system_emit_ppap_due_events(10)');
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a signed-in person cannot write these events');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(has_function_privilege('anon', 'app.system_emit_ppap_due_events(integer)', 'EXECUTE'), false, 'nor can anon');
  PERFORM pg_temp.assert_eq(has_function_privilege('authenticated', 'app.workflow_emit_ppap_status()', 'EXECUTE'), false, 'the status trigger function is not callable by people');
END $$;

ROLLBACK;
