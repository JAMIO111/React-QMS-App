-- Workflow rules WF3: putting a lot on hold with the authority of the person who saved the rule version (held, recorded as them; refused and reported when
-- they may no longer; skipped when there is no lot or it is already held), timers reading the record afresh and doing nothing once the rule is off, inner
-- actions numbered past the top-level ones, and who may call what.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
  ('3e500000-0000-0000-0000-000000000101', 'ann@wf3.test', now()),
  ('3e500000-0000-0000-0000-000000000102', 'bob@wf3.test', now());

CREATE FUNCTION pg_temp.assert_true(p boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p IS NOT TRUE THEN RAISE EXCEPTION 'FAILED: %', label; END IF; END $$;

DO $$
DECLARE
  ann uuid := '3e500000-0000-0000-0000-000000000101'; bob uuid := '3e500000-0000-0000-0000-000000000102';
  org uuid; qm_role uuid; viewer_role uuid; part uuid; lot uuid; lot2 uuid; ncr uuid; ncr2 uuid; ev bigint; ev2 bigint; rule uuid; v1 uuid; v2 uuid;
  facts jsonb; run record; run2 record; r jsonb; t jsonb;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('Hold Works', 'Plant A', 'PA', NULL); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, bob, 'active');
  SELECT id INTO qm_role FROM public.roles WHERE organisation_id = org AND key = 'quality_manager';
  SELECT id INTO viewer_role FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, qm_role FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id = bob;

  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'P-WF3', 'Bracket') RETURNING id INTO part;
  INSERT INTO public.lots (organisation_id, lot_number, part_id, origin) VALUES (org, 'L-1', part, 'produced') RETURNING id INTO lot;
  INSERT INTO public.lots (organisation_id, lot_number, part_id, origin) VALUES (org, 'L-2', part, 'produced') RETURNING id INTO lot2;
  INSERT INTO public.nonconformances (organisation_id, reference, source, stage, severity, title, category_id, part_id, lot_id, owner_id)
  VALUES (org, 'NCR-WF3-1', 'internal', 'open', 'major', 'Crack', pg_temp.cat(org), part, lot, ann) RETURNING id INTO ncr;
  INSERT INTO public.nonconformances (organisation_id, reference, source, stage, severity, title, category_id)
  VALUES (org, 'NCR-WF3-2', 'internal', 'open', 'minor', 'No lot', pg_temp.cat(org)) RETURNING id INTO ncr2;
  INSERT INTO public.outbox_events (organisation_id, event_type, entity_type, entity_id) VALUES (org, 'ncr.created', 'nonconformance', ncr) RETURNING id INTO ev;
  INSERT INTO public.outbox_events (organisation_id, event_type, entity_type, entity_id) VALUES (org, 'ncr.created', 'nonconformance', ncr2) RETURNING id INTO ev2;

  -- Version 1 saved by Ann (owner).
  PERFORM pg_temp.login(ann);
  rule := app.save_workflow_rule(org, '{"name":"Hold the lot","trigger":"ncr.created","actions":[{"type":"hold_lot","reason":"Suspect material"}]}'::jsonb);
  PERFORM pg_temp.logout();
  SELECT id INTO v1 FROM public.workflow_rule_versions WHERE rule_id = rule AND version = 1;

  -- ---- held, as the person who saved the version ----
  facts := app.system_workflow_facts(org, 'nonconformance', ncr, '{}');
  SELECT * INTO run FROM app.system_record_workflow_run(org, v1, ev, 'ncr.created', 'nonconformance', ncr, facts);
  r := app.system_workflow_hold_lot(run.run_id, 0, 'Suspect material');
  PERFORM pg_temp.assert_eq(r ->> 'held' || '/' || (r ->> 'lot'), 'true/L-1', 'the lot is held: ' || r::text);
  PERFORM pg_temp.assert_eq((SELECT status || '/' || status_reason FROM public.lots WHERE id = lot), 'on_hold/Suspect material (Hold the lot)', 'with the reason and the rule');
  PERFORM pg_temp.assert_eq((SELECT updated_by FROM public.lots WHERE id = lot), ann, 'recorded as the person who saved the version');
  PERFORM pg_temp.assert_true(EXISTS (SELECT 1 FROM audit.events e WHERE e.entity_id = lot::text AND e.actor_user_id = ann AND e.action = 'update'), 'the audit trail names her');
  r := app.system_workflow_hold_lot(run.run_id, 0, 'Again');
  PERFORM pg_temp.assert_eq(r ->> 'skipped', 'The lot is already on hold', 'a lot already on hold is left alone');

  SELECT * INTO run2 FROM app.system_record_workflow_run(org, v1, ev2, 'ncr.created', 'nonconformance', ncr2, app.system_workflow_facts(org, 'nonconformance', ncr2, '{}'));
  PERFORM pg_temp.assert_eq(app.system_workflow_hold_lot(run2.run_id, 0, 'x') ->> 'skipped', 'The record names no lot', 'no lot, nothing to hold');

  -- ---- refused when the person who saved the version may no longer ----
  PERFORM pg_temp.login(bob);
  PERFORM app.save_workflow_rule(org, '{"actions":[{"type":"hold_lot","reason":"Hold it"}],"reason":"Bob takes it over"}'::jsonb, rule);
  PERFORM pg_temp.logout();
  SELECT id INTO v2 FROM public.workflow_rule_versions WHERE rule_id = rule AND version = 2;
  PERFORM pg_temp.assert_eq((SELECT created_by FROM public.workflow_rule_versions WHERE id = v2), bob, 'version 2 is Bob''s');
  DELETE FROM public.user_role_assignments WHERE organisation_id = org AND role_id = qm_role;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, viewer_role FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id = bob;
  UPDATE public.nonconformances SET lot_id = lot2 WHERE id = ncr;
  SELECT * INTO run FROM app.system_record_workflow_run(org, v2, ev, 'ncr.created', 'nonconformance', ncr, app.system_workflow_facts(org, 'nonconformance', ncr, '{}'));
  r := app.system_workflow_hold_lot(run.run_id, 0, 'Hold it');
  PERFORM pg_temp.assert_true(r ? 'refused' AND NOT (r ->> 'held')::boolean, 'refused once Bob is only a viewer: ' || r::text);
  PERFORM pg_temp.assert_eq((SELECT status FROM public.lots WHERE id = lot2), 'open', 'the lot is untouched');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.workflow_notices WHERE run_id = run.run_id AND user_id = bob AND message LIKE 'Lot L-2 was not put on hold:%'), 1::bigint,
    'Bob is told why');
  PERFORM pg_temp.assert_eq(coalesce(current_setting('request.jwt.claims', true), ''), '', 'the claims are put back');

  -- ---- timers read the record afresh, and stop once the rule is off ----
  UPDATE public.nonconformances SET severity = 'critical' WHERE id = ncr;
  t := app.system_workflow_timer_facts(run.run_id);
  PERFORM pg_temp.assert_eq(t ->> 'active' || '/' || (t -> 'facts' ->> 'severity'), 'true/critical', 'the facts as they are now: ' || t::text);
  PERFORM pg_temp.login(ann); PERFORM app.set_workflow_rule_status(rule, 'paused'); PERFORM pg_temp.logout();
  t := app.system_workflow_timer_facts(run.run_id);
  PERFORM pg_temp.assert_eq(t ->> 'active' || '/' || (t ->> 'reason'), 'false/The rule is paused now', 'a paused rule''s timers do nothing');

  -- ---- inner actions use their own place; fresh facts decide the owner ----
  UPDATE public.nonconformances SET owner_id = bob WHERE id = ncr;
  facts := app.system_workflow_facts(org, 'nonconformance', ncr, '{}');
  r := app.system_workflow_task(run.run_id, 10, '{"kind":"record_owner"}', 'Chase it', NULL, 1, facts);
  PERFORM pg_temp.assert_eq(r ->> 'created', 'true', 'an inner task at place 10: ' || r::text);
  PERFORM pg_temp.assert_eq((SELECT assignee_user_id FROM public.workflow_tasks WHERE run_id = run.run_id AND action_index = 10), bob, 'to the owner as the record says now');
  r := app.system_workflow_notify(run.run_id, 11, '[{"kind":"person","userId":"3e500000-0000-0000-0000-000000000101"}]', 'Still open', facts);
  PERFORM pg_temp.assert_eq(r ->> 'told', '1', 'an inner notice at place 11');

  -- ---- who may call what ----
  PERFORM pg_temp.assert_eq(has_function_privilege('authenticated', 'app.system_workflow_hold_lot(uuid,integer,text,jsonb)', 'execute'), false, 'people cannot hold lots through a rule');
  PERFORM pg_temp.assert_eq(has_function_privilege('qms_api', 'app.system_workflow_timer_facts(uuid)', 'execute'), true, 'the API login reads timers');
END $$;

ROLLBACK;
