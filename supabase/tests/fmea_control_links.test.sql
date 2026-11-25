-- FMEA FM5a: carrying a cause's control to a control plan characteristic. Who may carry and end (fmea.manage and process_control.read), what the cause and the plan must hold
-- (the control being carried, an active plan that names the operation and the characteristic), no duplicates, links on a draft and on the revision in force but not on one waiting
-- for approval or a newer one being prepared, ended links frozen even for SQL, the live links going on to the next revision with the cause that continues theirs (and a base copy
-- bringing none), reading by the people who may read the FMEA, and tenancy.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('4f200000-0000-0000-0000-000000000f01', 'ann@fl.test'), ('4f200000-0000-0000-0000-000000000f02', 'cat@fl.test'),
  ('4f200000-0000-0000-0000-000000000f03', 'dan@fl.test'), ('4f200000-0000-0000-0000-000000000f04', 'hal@fl.test'),
  ('4f200000-0000-0000-0000-000000000f05', 'eve@fl.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '4f200000-0000-0000-0000-000000000f01'; cat uuid := '4f200000-0000-0000-0000-000000000f02'; dan uuid := '4f200000-0000-0000-0000-000000000f03';
  hal uuid := '4f200000-0000-0000-0000-000000000f04'; eve uuid := '4f200000-0000-0000-0000-000000000f05';
  org uuid; org2 uuid; u uuid; part uuid; fam uuid; plan uuid; plan_off uuid; plan2 uuid; ra uuid; op uuid; f1 uuid; r1 uuid; r2 uuid; r3 uuid; it uuid; fn uuid; m1 uuid; m2 uuid; ch uuid; cl uuid;
  l1 uuid; l2 uuid; l3 uuid; fb uuid; rb uuid; r text; n bigint; v_rev uuid;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('FL Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('FL Beta'); PERFORM pg_temp.logout();
  FOREACH u IN ARRAY ARRAY[cat, dan, hal] LOOP
    INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u, 'active');
  END LOOP;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = CASE WHEN ou.user_id = dan THEN 'quality_manager' WHEN ou.user_id = hal THEN 'viewer' ELSE 'quality_engineer' END)
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id IN (cat, dan, hal);

  -- ---- a control plan in force: operation OP-020 with characteristics OD (critical) and VISUAL ----
  PERFORM pg_temp.login(ann);
  INSERT INTO public.part_families (organisation_id, code, name) VALUES (org, 'FLF', 'Brackets') RETURNING id INTO fam;
  INSERT INTO public.parts (organisation_id, part_number, name, part_family_id) VALUES (org, 'FL-P1', 'Bracket', fam) RETURNING id INTO part;
  INSERT INTO public.control_plans (organisation_id, plan_code, title) VALUES (org, 'FL-CP1', 'Brackets') RETURNING id INTO plan;
  INSERT INTO public.control_plan_applicability (organisation_id, control_plan_id, part_family_id) VALUES (org, plan, fam);
  INSERT INTO public.control_plan_revisions (organisation_id, control_plan_id, revision_code, change_reason) VALUES (org, plan, 'A', 'First') RETURNING id INTO ra;
  INSERT INTO public.control_plan_operations (organisation_id, control_plan_revision_id, operation_code, sequence, name) VALUES (org, ra, 'OP-020', 20, 'Turning') RETURNING id INTO op;
  INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, name, nominal, lower_limit, upper_limit, unit_code, criticality)
    VALUES (org, ra, op, 'OD', 'Outer diameter', 25, 24.95, 25.05, 'mm', 'critical');
  INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, name, data_type)
    VALUES (org, ra, op, 'VISUAL', 'Free from burrs', 'attribute');
  UPDATE public.control_plan_revisions SET status = 'pending_approval' WHERE id = ra;
  UPDATE public.control_plan_revisions SET status = 'approved' WHERE id = ra;
  UPDATE public.control_plan_revisions SET status = 'effective' WHERE id = ra;
  -- a plan taken out of use, and a plan of the other organisation
  INSERT INTO public.control_plans (organisation_id, plan_code, title, active) VALUES (org, 'FL-OLD', 'Retired plan', false) RETURNING id INTO plan_off;
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve);
  INSERT INTO public.control_plans (organisation_id, plan_code, title) VALUES (org2, 'FL-B1', 'Beta plan') RETURNING id INTO plan2;
  PERFORM pg_temp.logout();

  -- ---- an FMEA: one cause that needs attention with a prevention control only, one that does not need attention ----
  PERFORM pg_temp.login(cat);
  f1 := app.create_fmea(org, jsonb_build_object('kind', 'process', 'title', 'Turning the bracket',
    'team', jsonb_build_array(jsonb_build_object('userId', cat, 'role', 'lead'), jsonb_build_object('userId', dan, 'role', 'quality')),
    'links', jsonb_build_array(jsonb_build_object('kind', 'part', 'id', part))));
  r1 := (SELECT id FROM public.fmea_revisions WHERE fmea_id = f1);
  it := app.save_fmea_item(r1, NULL, '{"kind":"item","name":"Bracket"}'::jsonb);
  fn := app.save_fmea_function(it, NULL, '{"text":"Hold the bore"}'::jsonb);
  m1 := app.save_fmea_failure_mode(fn, NULL, '{"text":"Bore oversize"}'::jsonb);
  PERFORM app.save_fmea_effect(m1, NULL, '{"level":"end_user","text":"Leaks","severity":8}'::jsonb);
  ch := app.save_fmea_cause(m1, NULL, '{"text":"Tool wear","preventionControls":"Change the tool every 50 parts","occurrence":8,"detection":8}'::jsonb);
  m2 := app.save_fmea_failure_mode(fn, NULL, '{"text":"Burr left"}'::jsonb);
  PERFORM app.save_fmea_effect(m2, NULL, '{"level":"own_plant","text":"Rework","severity":3}'::jsonb);
  cl := app.save_fmea_cause(m2, NULL, '{"text":"Blunt deburr tool","detectionControls":"Touch check at OP20","occurrence":2,"detection":2}'::jsonb);
  PERFORM app.set_fmea_approver(r1, dan);

  -- ---- carrying a control, on a draft ----
  r := pg_temp.fails(format($f$SELECT app.carry_fmea_cause_to_plan(%L, jsonb_build_object('controlKind','prevention','controlPlanId',%L,'operationCode','op-020','characteristicKey','OD','note','Tool life on the plan'))$f$, ch, plan));
  PERFORM pg_temp.assert_eq(r, 'ok', 'a manager carries a prevention control to a plan characteristic');
  l1 := (SELECT id FROM public.fmea_control_links WHERE cause_id = ch);
  PERFORM pg_temp.assert_eq((SELECT control_kind || '/' || operation_code || '/' || characteristic_key || '/' || revision_id::text FROM public.fmea_control_links WHERE id = l1), 'prevention/OP-020/OD/' || r1::text,
    'the link keeps the plan''s own spelling of the operation code and the revision it was made on');
  PERFORM pg_temp.assert_eq((SELECT created_by FROM public.fmea_control_links WHERE id = l1), cat, 'who made it');
  r := pg_temp.fails(format($f$SELECT app.carry_fmea_cause_to_plan(%L, jsonb_build_object('controlKind','prevention','controlPlanId',%L,'operationCode','OP-020','characteristicKey','OD'))$f$, ch, plan));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'the same control is not carried twice to the same characteristic');
  r := pg_temp.fails(format($f$SELECT app.carry_fmea_cause_to_plan(%L, jsonb_build_object('controlKind','detection','controlPlanId',%L,'operationCode','OP-020','characteristicKey','OD'))$f$, ch, plan));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'a detection control the cause does not hold cannot be carried');
  PERFORM app.carry_fmea_cause_to_plan(cl, jsonb_build_object('controlKind', 'detection', 'controlPlanId', plan, 'operationCode', 'OP-020', 'characteristicKey', 'VISUAL'));
  r := pg_temp.fails(format($f$SELECT app.carry_fmea_cause_to_plan(%L, jsonb_build_object('controlKind','prevention','controlPlanId',%L,'operationCode','OP-020','characteristicKey','OD'))$f$, cl, plan));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'nor a prevention control the cause does not hold');
  r := pg_temp.fails(format($f$SELECT app.carry_fmea_cause_to_plan(%L, jsonb_build_object('controlKind','prevention','controlPlanId',%L,'operationCode','OP-020','characteristicKey','NOPE'))$f$, ch, plan));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'the plan must name the characteristic');
  r := pg_temp.fails(format($f$SELECT app.carry_fmea_cause_to_plan(%L, jsonb_build_object('controlKind','prevention','controlPlanId',%L,'operationCode','OP-999','characteristicKey','OD'))$f$, ch, plan));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'and the operation');
  r := pg_temp.fails(format($f$SELECT app.carry_fmea_cause_to_plan(%L, jsonb_build_object('controlKind','prevention','controlPlanId',%L,'operationCode','OP-020','characteristicKey','OD'))$f$, ch, plan_off));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'a plan taken out of use is refused');
  r := pg_temp.fails(format($f$SELECT app.carry_fmea_cause_to_plan(%L, jsonb_build_object('controlKind','prevention','controlPlanId',%L,'operationCode','OP-020','characteristicKey','OD'))$f$, ch, plan2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'another organisation''s plan is not found');
  r := pg_temp.fails(format($f$SELECT app.carry_fmea_cause_to_plan(%L, jsonb_build_object('controlKind','sorting','controlPlanId',%L,'operationCode','OP-020','characteristicKey','OD'))$f$, ch, plan));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'a kind is prevention or detection');
  r := pg_temp.fails(format($f$SELECT app.carry_fmea_cause_to_plan(%L, jsonb_build_object('controlKind','prevention','controlPlanId',%L,'operationCode','OP-020','characteristicKey','OD','colour','red'))$f$, ch, plan));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'unknown keys are refused');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_control_links WHERE ended_at IS NULL), 2::bigint, 'two live links so far');
  PERFORM pg_temp.logout();

  -- ---- who may ----
  PERFORM pg_temp.login(hal);
  r := pg_temp.fails(format($f$SELECT app.carry_fmea_cause_to_plan(%L, jsonb_build_object('controlKind','prevention','controlPlanId',%L,'operationCode','OP-020','characteristicKey','VISUAL'))$f$, ch, plan));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a viewer cannot carry a control');
  r := pg_temp.fails(format($f$SELECT app.end_fmea_control_link(%L, 'No longer wanted')$f$, l1));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'nor end a link');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_control_links), 0::bigint, 'and a viewer reads no link on a draft they are not on');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve);
  r := pg_temp.fails(format($f$SELECT app.carry_fmea_cause_to_plan(%L, jsonb_build_object('controlKind','prevention','controlPlanId',%L,'operationCode','OP-020','characteristicKey','OD'))$f$, ch, plan));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'a stranger to the organisation finds no cause');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_control_links), 0::bigint, 'and reads no link');
  PERFORM pg_temp.logout();

  -- ---- frozen even for SQL: a link is ended, not changed ----
  r := pg_temp.fails(format($f$UPDATE public.fmea_control_links SET characteristic_key = 'VISUAL' WHERE id = %L$f$, l1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'a link cannot be changed');
  r := pg_temp.fails(format($f$UPDATE public.fmea_control_links SET note = 'Another' WHERE id = %L$f$, l1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'not even its note');
  r := pg_temp.fails(format($f$UPDATE public.fmea_control_links SET ended_at = now() WHERE id = %L$f$, l1));
  PERFORM pg_temp.assert_eq(left(r, 5), '23514', 'ending it without a reason is refused by the table');

  -- ---- ending a link ----
  PERFORM pg_temp.login(cat);
  r := pg_temp.fails(format($f$SELECT app.end_fmea_control_link(%L, 'no')$f$, l1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'a reason of at least three characters is needed');
  PERFORM app.end_fmea_control_link(l1, 'Tool life is checked elsewhere');
  PERFORM pg_temp.assert_eq((SELECT end_reason || '/' || (ended_by = cat)::text FROM public.fmea_control_links WHERE id = l1), 'Tool life is checked elsewhere/true', 'the reason and who ended it are kept');
  r := pg_temp.fails(format($f$SELECT app.end_fmea_control_link(%L, 'Again please')$f$, l1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'an ended link cannot be ended again');
  r := pg_temp.fails(format($f$UPDATE public.fmea_control_links SET end_reason = 'Changed my mind' WHERE id = %L$f$, l1));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a person cannot write to the table at all');
  PERFORM pg_temp.logout();
  r := pg_temp.fails(format($f$UPDATE public.fmea_control_links SET end_reason = 'Changed my mind' WHERE id = %L$f$, l1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'an ended link stays as it was, even for SQL');
  PERFORM pg_temp.login(cat);
  l1 := app.carry_fmea_cause_to_plan(ch, jsonb_build_object('controlKind', 'prevention', 'controlPlanId', plan, 'operationCode', 'OP-020', 'characteristicKey', 'OD'));
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_control_links WHERE cause_id = ch), 2::bigint, 'after ending, the same control can be carried again as a new link (the old one stays on record)');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_control_links WHERE cause_id = ch AND ended_at IS NULL), 1::bigint, 'one of them live');

  -- ---- waiting for approval: nothing is carried or ended ----
  PERFORM app.save_fmea_cause(m1, ch, '{"detectionControls":"Gauge every part","noActionReason":"Tool life is carried to the control plan and checked every shift"}'::jsonb);
  PERFORM app.submit_fmea_revision(r1);
  r := pg_temp.fails(format($f$SELECT app.carry_fmea_cause_to_plan(%L, jsonb_build_object('controlKind','detection','controlPlanId',%L,'operationCode','OP-020','characteristicKey','OD'))$f$, ch, plan));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'no new link while the revision waits for approval');
  r := pg_temp.fails(format($f$SELECT app.end_fmea_control_link(%L, 'Because I can')$f$, l1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'nor ending one');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(dan);
  PERFORM app.approve_fmea_revision(r1, current_date, NULL);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT status FROM public.fmea_revisions WHERE id = r1), 'effective', 'approved and in force');

  -- ---- in force: a link is alive ----
  PERFORM pg_temp.login(cat);
  l2 := app.carry_fmea_cause_to_plan(ch, jsonb_build_object('controlKind', 'detection', 'controlPlanId', plan, 'operationCode', 'OP-020', 'characteristicKey', 'OD'));
  PERFORM pg_temp.assert_eq((SELECT revision_id FROM public.fmea_control_links WHERE id = l2), r1, 'a control is carried from the revision in force');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(hal);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_control_links WHERE ended_at IS NULL), 3::bigint, 'once in force a viewer reads the links (they may read the FMEA)');
  PERFORM pg_temp.logout();

  -- ---- a new revision takes the live links, with the cause that continues theirs ----
  PERFORM pg_temp.login(cat);
  r2 := app.start_fmea_revision(f1, false);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_control_links WHERE revision_id = r2), 3::bigint, 'the draft has the three live links');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_control_links n JOIN public.fmea_causes c ON c.id = n.cause_id WHERE n.revision_id = r2 AND c.revision_id = r2 AND c.prev_row_id IN (ch, cl)), 3::bigint,
    'each sits on the cause that continues its cause');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_control_links n JOIN public.fmea_control_links o ON o.id = n.prev_row_id WHERE n.revision_id = r2 AND o.revision_id = r1), 3::bigint, 'and says which link it continues');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_control_links WHERE revision_id = r1 AND ended_at IS NULL), 3::bigint, 'the revision in force keeps its own');
  -- a newer revision is being prepared: the work belongs there
  r := pg_temp.fails(format($f$SELECT app.carry_fmea_cause_to_plan(%L, jsonb_build_object('controlKind','prevention','controlPlanId',%L,'operationCode','OP-020','characteristicKey','VISUAL'))$f$, ch, plan));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'with a newer revision open, no link is made on the one in force');
  r := pg_temp.fails(format($f$SELECT app.end_fmea_control_link(%L, 'Not on the old one')$f$, l2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'nor ended there');
  -- in the draft the links can be ended and made
  v_rev := (SELECT n.id FROM public.fmea_control_links n JOIN public.fmea_causes c ON c.id = n.cause_id WHERE n.revision_id = r2 AND n.prev_row_id = l2);
  PERFORM app.end_fmea_control_link(v_rev, 'The gauge moved to OP-030');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_control_links WHERE revision_id = r2 AND ended_at IS NULL), 2::bigint, 'ended in the draft');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_control_links WHERE revision_id = r1 AND ended_at IS NULL), 3::bigint, 'and still live on the revision in force');
  -- removing a cause from the draft takes its links with it
  PERFORM app.remove_fmea_node('cause', (SELECT id FROM public.fmea_causes WHERE revision_id = r2 AND prev_row_id = cl));
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_control_links WHERE revision_id = r2), 2::bigint, 'a removed cause takes its link with it (the one ended stays with its own cause)');
  PERFORM pg_temp.logout();

  -- ---- a copy from a base brings no links ----
  PERFORM pg_temp.login(cat);
  fb := app.create_fmea(org, jsonb_build_object('kind', 'process', 'title', 'Child of the bracket FMEA', 'baseFmeaId', f1,
    'team', jsonb_build_array(jsonb_build_object('userId', cat, 'role', 'lead'), jsonb_build_object('userId', dan, 'role', 'quality')),
    'links', jsonb_build_array(jsonb_build_object('kind', 'part', 'id', part))));
  rb := (SELECT id FROM public.fmea_revisions WHERE fmea_id = fb);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_causes WHERE revision_id = rb), 2::bigint, 'the child starts with the base''s causes');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_control_links WHERE revision_id = rb), 0::bigint, 'but none of its links: they belong to another part''s plan');
  PERFORM pg_temp.logout();

  -- ---- the table is never written directly by a person ----
  PERFORM pg_temp.login(cat);
  r := pg_temp.fails(format($f$INSERT INTO public.fmea_control_links (organisation_id, revision_id, cause_id, control_kind, control_plan_id, operation_code, characteristic_key) SELECT organisation_id, revision_id, id, 'prevention', %L, 'OP-020', 'OD' FROM public.fmea_causes WHERE id = %L$f$, plan, cl));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'no table insert for a person');
  r := pg_temp.fails(format($f$DELETE FROM public.fmea_control_links WHERE id = %L$f$, l2));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'no delete either');
  r := pg_temp.fails(format($f$UPDATE public.fmea_control_links SET ended_at = now(), end_reason = 'Sneaky' WHERE id = %L$f$, l2));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'nor ending one by hand');
  PERFORM pg_temp.logout();
END $$;
ROLLBACK;
