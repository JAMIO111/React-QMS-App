-- PPAP, fix to PP6b: an approval that a revalidation has replaced is no longer reminded about (ppap_reviews area) and writes no ppap.review_due event; a withdrawn
-- replacement does not count, so the approval is reminded about again.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('5f200000-0000-0000-0000-000000000c01', 'ann@pr.test'), ('5f200000-0000-0000-0000-000000000c03', 'cat@pr.test'), ('5f200000-0000-0000-0000-000000000c04', 'dan@pr.test');

CREATE FUNCTION pg_temp.events_of(p_entity uuid, p_type text) RETURNS bigint LANGUAGE sql SECURITY DEFINER AS $$
  SELECT count(*) FROM public.outbox_events WHERE entity_id = p_entity AND event_type = p_type
$$;

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

-- Review dates move only when a decision or a review is recorded, even for SQL, so the test turns the triggers off for one statement.
CREATE FUNCTION pg_temp.ppap_set_review(p_sub uuid, p_on date) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('session_replication_role', 'replica', true);
  UPDATE public.ppap_submissions SET next_review_on = p_on WHERE id = p_sub;
  PERFORM set_config('session_replication_role', 'origin', true);
END $$;

DO $$
DECLARE
  ann uuid := '5f200000-0000-0000-0000-000000000c01'; cat uuid := '5f200000-0000-0000-0000-000000000c03'; dan uuid := '5f200000-0000-0000-0000-000000000c04';
  org uuid; cust uuid; p1 uuid; rv uuid; s1 uuid; s2 uuid; today date := (now() AT TIME ZONE 'UTC')::date; n bigint;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('PR Alpha'); PERFORM pg_temp.logout();
  UPDATE public.organisation_settings SET time_zone = 'UTC' WHERE organisation_id = org;
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, cat, 'active'), (org, dan, 'active');
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = CASE WHEN ou.user_id = dan THEN 'quality_manager' ELSE 'quality_engineer' END)
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id IN (cat, dan);

  PERFORM pg_temp.login(ann);
  INSERT INTO public.customers (organisation_id, code, name) VALUES (org, 'PR-C1', 'Acme Motors') RETURNING id INTO cust;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'PR-P1', 'Part 1') RETURNING id INTO p1;
  INSERT INTO public.part_revisions (organisation_id, part_id, revision) VALUES (org, p1, 'A') RETURNING id INTO rv;
  UPDATE public.part_revisions SET status = 'released' WHERE id = rv;
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(dan);
  PERFORM app.set_ppap_customer_rules(cust, '{"defaultLevel":1}'::jsonb);
  PERFORM pg_temp.logout();

  -- An approved submission whose revalidation date has been reached.
  s1 := pg_temp.sent(org, p1, cust, cat, dan);
  PERFORM pg_temp.login(dan);
  PERFORM app.record_ppap_decision(s1, 'approved', today, 'ACME-OK-1');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.ppap_set_review(s1, today - 1);

  SELECT count(*) INTO n FROM app.reminder_candidates(org, today) WHERE area = 'ppap_reviews' AND record_id = s1;
  PERFORM pg_temp.assert_eq(n, 1::bigint, 'before a revalidation is started the owner is reminded');

  -- The owner starts the revalidation: a new submission that replaces the approved one.
  PERFORM pg_temp.login(cat);
  s2 := (app.start_ppap_resubmission(s1, '{"reason":"not_produced_12_months"}'::jsonb) ->> 'id')::uuid;
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT replaces_id FROM public.ppap_submissions WHERE id = s2), s1, 'the new submission replaces the approval');

  SELECT count(*) INTO n FROM app.reminder_candidates(org, today) WHERE area = 'ppap_reviews' AND record_id = s1;
  PERFORM pg_temp.assert_eq(n, 0::bigint, 'once it is replaced the approval is not reminded about');
  PERFORM app.system_emit_ppap_due_events(200);
  PERFORM pg_temp.assert_eq(pg_temp.events_of(s1, 'ppap.review_due'), 0::bigint, 'and writes no revalidation event');

  -- A replacement that is withdrawn does not count: the approval is due again.
  PERFORM pg_temp.login(cat);
  PERFORM app.withdraw_ppap(s2, 'Started in error');
  PERFORM pg_temp.logout();
  SELECT count(*) INTO n FROM app.reminder_candidates(org, today) WHERE area = 'ppap_reviews' AND record_id = s1;
  PERFORM pg_temp.assert_eq(n, 1::bigint, 'a withdrawn replacement does not count, so the owner is reminded again');
  PERFORM app.system_emit_ppap_due_events(200);
  PERFORM pg_temp.assert_eq(pg_temp.events_of(s1, 'ppap.review_due'), 1::bigint, 'and the event is written');
END $$;

ROLLBACK;
