-- DOC1: quality alerts — numbering, draft editing under RLS, scope and targets through the function, issuing rules,
-- frozen once issued, revisions (copy, supersede), withdrawal, discard, expiry, permissions and isolation.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('3e000000-0000-0000-0000-000000000101', 'owner@qa.test'),
  ('3e000000-0000-0000-0000-000000000102', 'engineer@qa.test'),
  ('3e000000-0000-0000-0000-000000000103', 'viewer@qa.test'),
  ('3e000000-0000-0000-0000-000000000104', 'other@qa.test');

DO $$
DECLARE
  org uuid; site uuid; dept uuid; part uuid; mach uuid; role_id uuid; m uuid; a1 uuid; a2 uuid; rev2 uuid; rev3 uuid;
  scope jsonb;
BEGIN
  PERFORM pg_temp.login('3e000000-0000-0000-0000-000000000101');
  org := app.create_organisation('QA Works', 'Plant A', 'PA', NULL);
  SELECT id INTO site FROM public.sites WHERE organisation_id = org;
  INSERT INTO public.departments (organisation_id, site_id, code, name) VALUES (org, site, 'GI', 'Goods-in') RETURNING id INTO dept;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'HCR-100', 'Rod') RETURNING id INTO part;
  INSERT INTO public.machines (organisation_id, code, name, site_id) VALUES (org, 'L1', 'Lathe 1', site) RETURNING id INTO mach;
  SELECT id INTO role_id FROM public.roles WHERE organisation_id = org AND key = 'inspector';
  PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '3e000000-0000-0000-0000-000000000102', 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'quality_engineer';
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '3e000000-0000-0000-0000-000000000103', 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  INSERT INTO public.department_members (organisation_id, department_id, membership_id) VALUES (org, dept, m);   -- the viewer works in Goods-in
  scope := jsonb_build_object('parts', jsonb_build_array(jsonb_build_object('partId', part)), 'machines', jsonb_build_array(mach),
    'operations', jsonb_build_array('OP-020'), 'departments', jsonb_build_array(dept),
    'targets', jsonb_build_array(jsonb_build_object('departmentId', dept), jsonb_build_object('roleId', role_id)));

  -- A quality engineer drafts: numbers are given, QA-001, QA-002; they cannot choose their own.
  PERFORM pg_temp.login('3e000000-0000-0000-0000-000000000102');
  INSERT INTO public.quality_alerts (organisation_id, alert_number, reference, title, category, severity)
    VALUES (org, 99, 'QA-099', 'Wrong spec on bar stock', 'supplier', 'high') RETURNING id INTO a1;
  INSERT INTO public.quality_alerts (organisation_id, title, category, severity) VALUES (org, 'Gauge out of calibration', 'equipment', 'medium') RETURNING id INTO a2;
  PERFORM pg_temp.assert_eq((SELECT array_agg(reference ORDER BY alert_number) FROM public.quality_alerts), ARRAY['QA-001', 'QA-002'], 'numbers are assigned, whatever was asked');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.quality_alerts (organisation_id, title, category, severity, status) VALUES (%L, 'x', 'product', 'low', 'active')$q$, org), 'cannot insert an issued alert');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.quality_alerts (organisation_id, title, category, severity) VALUES (%L, 'x', 'bogus', 'low')$q$, org), 'category is one of the five');
  UPDATE public.quality_alerts SET description = 'The bar stock certificate says 4140, the drawing needs 4340.', required_action = 'Quarantine all bar stock from lot 77 and tell your supervisor.',
    effective_date = current_date, acknowledge_by = current_date + 2, expiry_date = current_date + 30 WHERE id = a1;
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.quality_alerts SET status = 'active' WHERE id = %L$q$, a1), 'status is not editable directly');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.quality_alerts SET reference = 'QA-500' WHERE id = %L$q$, a1), 'the reference is not editable');
  PERFORM app.set_quality_alert_scope(a1, scope);
  PERFORM pg_temp.assert_fails(format($q$SELECT app.set_quality_alert_actions(%L, '[{"description":" "}]'::jsonb)$q$, a1), 'an action needs a description');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.set_quality_alert_actions(%L, jsonb_build_array(jsonb_build_object('description', 'x', 'machineId', gen_random_uuid())))$q$, a1), 'a machine of another organisation cannot be named');
  PERFORM app.set_quality_alert_actions(a1, jsonb_build_array(
    jsonb_build_object('description', 'Quarantine all bar stock from lot 77.', 'departmentId', dept),
    jsonb_build_object('description', 'Re-check the stock on this lathe.', 'machineId', mach),
    jsonb_build_object('description', 'Tell your supervisor.')));
  PERFORM pg_temp.assert_eq((SELECT array_agg(position ORDER BY position) FROM public.quality_alert_actions WHERE alert_id = a1), ARRAY[1, 2, 3], 'actions keep their order');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.quality_alert_actions WHERE alert_id = a1 AND (department_id IS NOT NULL OR machine_id IS NOT NULL)), 2::bigint, 'two are for a department or a machine');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.quality_alert_actions (organisation_id, alert_id, position, description) VALUES (%L, %L, 9, 'x')$q$, org, a1), 'actions are written only through the function');
  PERFORM pg_temp.assert_eq((SELECT (SELECT count(*) FROM public.quality_alert_parts WHERE alert_id = a1) + (SELECT count(*) FROM public.quality_alert_machines WHERE alert_id = a1)
      + (SELECT count(*) FROM public.quality_alert_operations WHERE alert_id = a1) + (SELECT count(*) FROM public.quality_alert_departments WHERE alert_id = a1)
      + (SELECT count(*) FROM public.quality_alert_targets WHERE alert_id = a1)), 6::bigint, 'scope and targets stored');
  PERFORM app.set_quality_alert_scope(a1, scope);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.quality_alert_targets WHERE alert_id = a1), 2::bigint, 'replacing the scope does not duplicate it');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.quality_alert_targets (organisation_id, alert_id, department_id) VALUES (%L, %L, %L)$q$, org, a1, dept), 'children are written only through the function');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.set_quality_alert_scope(%L, '{"machines":["00000000-0000-0000-0000-000000000000"]}'::jsonb)$q$, a1), 'a machine of another organisation cannot be named');

  -- Issuing needs documentation.issue (an engineer has manage only).
  PERFORM pg_temp.assert_fails(format($q$SELECT app.issue_quality_alert(%L)$q$, a1), 'an engineer cannot issue');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login('3e000000-0000-0000-0000-000000000101');
  -- Issue rules: incomplete alert, high severity without acknowledge-by, no targets.
  PERFORM pg_temp.assert_fails(format($q$SELECT app.issue_quality_alert(%L)$q$, a2), 'incomplete: no description or effective date');
  UPDATE public.quality_alerts SET description = 'd', effective_date = current_date WHERE id = a2;
  PERFORM pg_temp.assert_fails(format($q$SELECT app.issue_quality_alert(%L)$q$, a2), 'no actions');
  PERFORM app.set_quality_alert_actions(a2, '[{"description":"a"}]'::jsonb);
  PERFORM pg_temp.assert_fails(format($q$SELECT app.issue_quality_alert(%L)$q$, a2), 'no targets');
  UPDATE public.quality_alerts SET severity = 'critical' WHERE id = a2;
  PERFORM app.set_quality_alert_scope(a2, jsonb_build_object('targets', jsonb_build_array(jsonb_build_object('departmentId', dept))));
  PERFORM pg_temp.assert_fails(format($q$SELECT app.issue_quality_alert(%L)$q$, a2), 'critical needs an acknowledge-by date');
  UPDATE public.quality_alerts SET severity = 'medium' WHERE id = a2;

  PERFORM app.issue_quality_alert(a1);
  PERFORM pg_temp.assert_eq((SELECT (status, issued_by = '3e000000-0000-0000-0000-000000000101', issued_at IS NOT NULL)::text FROM public.quality_alerts WHERE id = a1), '(active,t,t)', 'issued');
  UPDATE public.quality_alerts SET title = 'changed' WHERE id = a1;   -- row level security hides an issued alert from updates: no row matches
  PERFORM pg_temp.assert_eq((SELECT title FROM public.quality_alerts WHERE id = a1), 'Wrong spec on bar stock', 'an issued alert is not edited');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.set_quality_alert_scope(%L, '{}'::jsonb)$q$, a1), 'an issued alert keeps its scope');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.issue_quality_alert(%L)$q$, a1), 'issued once');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.discard_quality_alert_draft(%L)$q$, a1), 'an issued alert is withdrawn, not discarded');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.quality_alerts SET title = 'changed' WHERE id = %L$q$, a1), 'and the trigger refuses it even without row level security');

  -- A viewer sees the issued alert (and its scope) but not the drafts.
  PERFORM pg_temp.login('3e000000-0000-0000-0000-000000000103');
  PERFORM pg_temp.assert_eq((SELECT array_agg(reference) FROM public.quality_alerts), ARRAY['QA-001'], 'a viewer sees only issued alerts');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.quality_alert_targets), 2::bigint, 'and their targets');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.quality_alerts (organisation_id, title, category, severity) VALUES (%L, 'x', 'product', 'low')$q$, org), 'a viewer cannot draft');
  PERFORM pg_temp.logout();

  -- Revision: copies content and scope, needs a reason, one draft at a time, supersedes the old one when issued.
  PERFORM pg_temp.login('3e000000-0000-0000-0000-000000000101');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.revise_quality_alert(%L, '  ')$q$, a1), 'a revision needs a reason');
  rev2 := app.revise_quality_alert(a1, 'The certificate was for lot 76, not 77');
  PERFORM pg_temp.assert_eq((SELECT array_agg(description ORDER BY position) FROM public.quality_alert_actions WHERE alert_id = rev2), (SELECT array_agg(description ORDER BY position) FROM public.quality_alert_actions WHERE alert_id = a1), 'a revision copies the actions');
  PERFORM pg_temp.assert_eq((SELECT (reference, revision, status, supersedes_id = a1, effective_date IS NULL, acknowledge_by IS NULL)::text FROM public.quality_alerts WHERE id = rev2), '(QA-001,2,draft,t,t,t)', 'a draft revision with fresh dates');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.quality_alert_targets WHERE alert_id = rev2), 2::bigint, 'scope copied');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.revise_quality_alert(%L, 'again')$q$, a1), 'one draft revision at a time');
  UPDATE public.quality_alerts SET effective_date = current_date, acknowledge_by = current_date + 1, title = 'Wrong spec on bar stock (lot 76)' WHERE id = rev2;
  PERFORM app.issue_quality_alert(rev2);
  PERFORM pg_temp.assert_eq((SELECT array_agg(status ORDER BY revision) FROM public.quality_alerts WHERE alert_number = 1), ARRAY['superseded', 'active'], 'the new revision supersedes the old');

  -- Withdraw, discard, expire.
  PERFORM pg_temp.assert_fails(format($q$SELECT app.withdraw_quality_alert(%L, '')$q$, rev2), 'a withdrawal needs a reason');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.withdraw_quality_alert(%L, 'x')$q$, a2), 'a draft is not withdrawn');
  PERFORM app.withdraw_quality_alert(rev2, 'Issued in error');
  PERFORM pg_temp.assert_eq((SELECT (status, withdrawn_reason)::text FROM public.quality_alerts WHERE id = rev2), '(withdrawn,"Issued in error")', 'withdrawn with the reason');
  PERFORM app.discard_quality_alert_draft(a2);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.quality_alerts WHERE id = a2), 0::bigint, 'a discarded draft disappears');
  rev3 := NULL;
  PERFORM pg_temp.logout();
  -- Expiry: a past expiry date makes an active alert expired when the function runs.
  INSERT INTO public.quality_alerts (organisation_id, alert_number, reference, revision, title, category, severity, description, required_action, effective_date, expiry_date, status, issued_at, issued_by)
    VALUES (org, 50, 'QA-050', 1, 'Old news', 'process', 'low', 'd', 'a', current_date - 10, current_date - 1, 'active', now(), '3e000000-0000-0000-0000-000000000101');
  PERFORM pg_temp.login('3e000000-0000-0000-0000-000000000103');
  PERFORM pg_temp.assert_eq(app.expire_quality_alerts(org), 1, 'one alert expired');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.quality_alerts WHERE title = 'Old news'), 'expired', 'now expired');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.quality_alert_events e JOIN public.quality_alerts q ON q.id = e.alert_id WHERE q.title = 'Old news' AND e.kind = 'expired' AND e.previous_expiry = current_date - 1 AND e.actor_id IS NULL), 1::bigint, 'the expiry is in the history');
  PERFORM pg_temp.assert_eq(app.expire_quality_alerts(org), 0, 'expiring twice logs nothing more');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.reopen_quality_alert(%L, current_date + 5, 'still needed')$q$, (SELECT id FROM public.quality_alerts WHERE title = 'Old news')), 'a viewer cannot reopen');
  PERFORM pg_temp.assert_fails($q$SELECT app.system_expire_quality_alerts()$q$, 'a signed-in person cannot run the system job');
  PERFORM pg_temp.logout();
  -- Reopening: documentation.issue, only an expired alert, a new expiry from today, a reason; logged with the old and new dates.
  PERFORM pg_temp.login('3e000000-0000-0000-0000-000000000101');
  DECLARE old_id uuid := (SELECT id FROM public.quality_alerts WHERE title = 'Old news');
  BEGIN
    PERFORM pg_temp.assert_fails(format($q$SELECT app.reopen_quality_alert(%L, current_date + 5, 'x')$q$, a1), 'an alert in force is not reopened');
    PERFORM pg_temp.assert_fails(format($q$SELECT app.reopen_quality_alert(%L, current_date - 1, 'x')$q$, old_id), 'the new expiry cannot be in the past');
    PERFORM pg_temp.assert_fails(format($q$SELECT app.reopen_quality_alert(%L, NULL, 'x')$q$, old_id), 'the new expiry is needed');
    PERFORM pg_temp.assert_fails(format($q$SELECT app.reopen_quality_alert(%L, current_date + 5, ' ')$q$, old_id), 'a reason is needed');
    UPDATE public.quality_alerts SET expiry_date = current_date + 9 WHERE id = old_id;
    PERFORM pg_temp.assert_eq((SELECT expiry_date FROM public.quality_alerts WHERE id = old_id), current_date - 1, 'the expiry of an issued alert is not edited directly');
    PERFORM app.reopen_quality_alert(old_id, current_date + 5, 'Still relevant until the new batch arrives');
    PERFORM pg_temp.assert_eq((SELECT (status, expiry_date = current_date + 5)::text FROM public.quality_alerts WHERE id = old_id), '(active,t)', 'back in force with the new expiry');
    PERFORM pg_temp.assert_eq((SELECT (kind, previous_expiry = current_date - 1, new_expiry = current_date + 5, reason, actor_id IS NOT NULL)::text FROM public.quality_alert_events WHERE alert_id = old_id AND kind = 'reopened'),
      '(reopened,t,t,"Still relevant until the new batch arrives",t)', 'the reopening is in the history');
    UPDATE public.quality_alerts SET expiry_date = current_date + 9 WHERE id = old_id;
    PERFORM pg_temp.assert_eq((SELECT expiry_date FROM public.quality_alerts WHERE id = old_id), current_date + 5, 'and the expiry is frozen again afterwards');
    PERFORM pg_temp.assert_fails(format($q$DELETE FROM public.quality_alert_events WHERE alert_id = %L$q$, old_id), 'history is never deleted');
    PERFORM pg_temp.assert_fails(format($q$UPDATE public.quality_alert_events SET reason = 'x' WHERE alert_id = %L$q$, old_id), 'or changed');
  END;
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) >= 6 FROM public.audit_events WHERE entity_type = 'quality_alerts'), true, 'the lifecycle is audited');

  -- Another organisation sees and does nothing.
  PERFORM pg_temp.login('3e000000-0000-0000-0000-000000000104');
  PERFORM app.create_organisation('Other Works', 'Plant', 'PX', NULL);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.quality_alerts), 0::bigint, 'another organisation sees none');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.withdraw_quality_alert(%L, 'x')$q$, a1), 'cannot withdraw a foreign alert');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.set_quality_alert_scope(%L, '{}'::jsonb)$q$, a1), 'cannot rewrite a foreign scope');
  PERFORM pg_temp.assert_eq(app.expire_quality_alerts(org), 0, 'cannot expire a foreign organisation');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
