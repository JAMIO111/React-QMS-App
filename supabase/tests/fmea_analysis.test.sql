-- FMEA FM3: the structure (kinds and parents), functions, failure modes, effects and causes; the database working out severity (the highest effect), RPN, priority and
-- "needs attention" from the revision's model; re-scoring when an effect or the model changes; what a draft still needs; frozen once submitted, even for SQL; a new revision
-- and an FMEA started from a base copying the analysis with lineage; who may read and write; tenancy.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('4f000000-0000-0000-0000-000000000f01', 'ann@fa.test'), ('4f000000-0000-0000-0000-000000000f02', 'bob@fa.test'),
  ('4f000000-0000-0000-0000-000000000f03', 'cat@fa.test'), ('4f000000-0000-0000-0000-000000000f04', 'dan@fa.test'),
  ('4f000000-0000-0000-0000-000000000f05', 'eve@fa.test'), ('4f000000-0000-0000-0000-000000000f06', 'fay@fa.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '4f000000-0000-0000-0000-000000000f01'; bob uuid := '4f000000-0000-0000-0000-000000000f02';
  cat uuid := '4f000000-0000-0000-0000-000000000f03'; dan uuid := '4f000000-0000-0000-0000-000000000f04';
  eve uuid := '4f000000-0000-0000-0000-000000000f05'; fay uuid := '4f000000-0000-0000-0000-000000000f06';
  org uuid; org2 uuid; u uuid; part uuid; f1 uuid; fd uuid; r1 uuid; rd uuid; r2 uuid; fc uuid; rc uuid; fdraft uuid; fother uuid;
  it_item uuid; it_step uuid; it_el uuid; it_step2 uuid; fn1 uuid; fn2 uuid; m1 uuid; m2 uuid; e1 uuid; e2 uuid; e3 uuid; c1 uuid; c2 uuid; m_other uuid;
  r text; cfg jsonb; v_model2 uuid; grid jsonb; v_n bigint; v_ids uuid[];
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('FA Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('FA Beta'); PERFORM pg_temp.logout();
  -- Bob: viewer. Cat: quality engineer (manages). Dan: quality manager (approves). Fay: quality engineer.
  FOREACH u IN ARRAY ARRAY[bob, cat, dan, fay] LOOP
    INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u, 'active');
  END LOOP;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = CASE ou.user_id WHEN dan THEN 'quality_manager' WHEN bob THEN 'viewer' ELSE 'quality_engineer' END)
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id IN (bob, cat, dan, fay);
  PERFORM pg_temp.login(ann);
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'FA-P1', 'Bracket') RETURNING id INTO part;
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login(cat);
  f1 := app.create_fmea(org, jsonb_build_object('kind', 'process', 'title', 'Machining the bracket',
    'team', jsonb_build_array(jsonb_build_object('userId', cat, 'role', 'lead'), jsonb_build_object('userId', fay, 'role', 'quality')),
    'links', jsonb_build_array(jsonb_build_object('kind', 'part', 'id', part))));
  r1 := (SELECT id FROM public.fmea_revisions WHERE fmea_id = f1);
  fd := app.create_fmea(org, jsonb_build_object('kind', 'design', 'title', 'Bracket design'));
  rd := (SELECT id FROM public.fmea_revisions WHERE fmea_id = fd);

  PERFORM pg_temp.assert_eq((SELECT model_id FROM public.fmea_revisions WHERE id = r1), (SELECT id FROM public.fmea_models WHERE organisation_id = org AND current), 'a new revision starts on the current model');

  -- ---- the structure: kinds fit the FMEA and the parent ----
  r := pg_temp.fails(format($f$SELECT app.save_fmea_item(%L, NULL, '{"kind":"system","name":"x"}'::jsonb)$f$, r1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'a process FMEA has no systems');
  r := pg_temp.fails(format($f$SELECT app.save_fmea_item(%L, NULL, '{"kind":"item","name":"x"}'::jsonb)$f$, rd));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'a design FMEA has no process items');
  r := pg_temp.fails(format($f$SELECT app.save_fmea_item(%L, NULL, '{"kind":"step","name":"x"}'::jsonb)$f$, r1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'a step needs a process item above it');
  r := pg_temp.fails(format($f$SELECT app.save_fmea_item(%L, NULL, '{"name":"x"}'::jsonb)$f$, r1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'the kind is needed');
  r := pg_temp.fails(format($f$SELECT app.save_fmea_item(%L, NULL, '{"kind":"item"}'::jsonb)$f$, r1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'a name is needed');
  r := pg_temp.fails(format($f$SELECT app.save_fmea_item(%L, NULL, '{"kind":"item","name":"x","colour":"red"}'::jsonb)$f$, r1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'an unknown field is refused');
  it_item := app.save_fmea_item(r1, NULL, '{"kind":"item","name":"Machining line"}'::jsonb);
  it_step := app.save_fmea_item(r1, NULL, jsonb_build_object('kind', 'step', 'name', 'Turn the bore', 'parentId', it_item, 'operationCode', 'OP10'));
  r := pg_temp.fails(format($f$SELECT app.save_fmea_item(%L, NULL, jsonb_build_object('kind','element','name','x','parentId',%L))$f$, r1, it_item));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'a work element goes under a step, not a process item');
  r := pg_temp.fails(format($f$SELECT app.save_fmea_item(%L, NULL, jsonb_build_object('kind','step','name','x','parentId',%L,'elementType','machine'))$f$, r1, it_item));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'only a work element has a type');
  it_el := app.save_fmea_item(r1, NULL, jsonb_build_object('kind', 'element', 'name', 'Lathe', 'parentId', it_step, 'elementType', 'machine'));
  PERFORM pg_temp.assert_eq((SELECT element_type FROM public.fmea_items WHERE id = it_el), 'machine', 'a work element has its 4M type');
  PERFORM pg_temp.assert_eq((SELECT position FROM public.fmea_items WHERE id = it_step), 1, 'positions start at 1 among siblings');
  it_step2 := app.save_fmea_item(r1, NULL, jsonb_build_object('kind', 'step', 'name', 'Drill', 'parentId', it_item));
  PERFORM pg_temp.assert_eq((SELECT position FROM public.fmea_items WHERE id = it_step2), 2, 'a second sibling goes last');
  r := pg_temp.fails(format($f$SELECT app.save_fmea_item(%L, %L, '{"kind":"item"}'::jsonb)$f$, r1, it_step));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'an item''s kind never changes');
  PERFORM app.save_fmea_item(r1, it_step2, '{"name":"Drill the holes"}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT name FROM public.fmea_items WHERE id = it_step2), 'Drill the holes', 'an item is renamed');
  PERFORM pg_temp.assert_eq((SELECT kind FROM public.fmea_items WHERE id = it_step2), 'step', 'and keeps its kind');
  -- A parent in another revision is refused.
  r := pg_temp.fails(format($f$SELECT app.save_fmea_item(%L, NULL, jsonb_build_object('kind','subsystem','name','x','parentId',%L))$f$, rd, it_item));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'a parent must be in the same revision and kind');

  -- ---- functions, failure modes, effects, causes ----
  fn1 := app.save_fmea_function(it_step, NULL, '{"text":"Bore to 12.00 +0.05","requirement":"12.00 +0.05 / -0","characteristicKey":"bore_dia"}'::jsonb);
  fn2 := app.save_fmea_function(it_step2, NULL, '{"text":"Drill four holes"}'::jsonb);
  r := pg_temp.fails(format($f$SELECT app.save_fmea_function(%L, NULL, '{"requirement":"x"}'::jsonb)$f$, it_step));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'a function needs its words');
  m1 := app.save_fmea_failure_mode(fn1, NULL, '{"text":"Bore oversize","specialClass":"critical"}'::jsonb);
  r := pg_temp.fails(format($f$SELECT app.save_fmea_failure_mode(%L, NULL, '{"text":"x","specialClass":"huge"}'::jsonb)$f$, fn1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'a special characteristic is critical or significant');
  m2 := app.save_fmea_failure_mode(fn2, NULL, '{"text":"Hole missing"}'::jsonb);
  e1 := app.save_fmea_effect(m1, NULL, '{"level":"own_plant","text":"Scrap","severity":4}'::jsonb);
  r := pg_temp.fails(format($f$SELECT app.save_fmea_effect(%L, NULL, '{"level":"somewhere","text":"x"}'::jsonb)$f$, m1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'an effect shows at the plant, the next plant or the end user');
  r := pg_temp.fails(format($f$SELECT app.save_fmea_effect(%L, NULL, '{"level":"own_plant","text":"x","severity":11}'::jsonb)$f$, m1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'severity is 1 to 10');
  c1 := app.save_fmea_cause(m1, NULL, '{"text":"Tool wear","preventionControls":"Tool life counter","occurrence":5,"detection":4}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT severity_used || '/' || rpn || '/' || priority || '/' || needs_attention FROM public.fmea_causes WHERE id = c1), '4/80/low/false', 'severity from the only effect, RPN 4 x 5 x 4, low');
  e2 := app.save_fmea_effect(m1, NULL, '{"level":"end_user","text":"Part will not fit","severity":7}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT severity_used || '/' || rpn || '/' || priority FROM public.fmea_causes WHERE id = c1), '7/140/medium', 'the highest effect counts: severity 7, RPN 140, medium');
  e3 := app.save_fmea_effect(m1, NULL, '{"level":"next_plant","text":"Line stop"}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT severity_used FROM public.fmea_causes WHERE id = c1), 7, 'an effect with no severity yet changes nothing');
  PERFORM app.save_fmea_effect(m1, e3, '{"severity":9}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT severity_used || '/' || rpn || '/' || priority || '/' || needs_attention FROM public.fmea_causes WHERE id = c1), '9/180/medium/true',
    'severity 9 reaches the floor: it needs attention whatever the priority says');
  PERFORM app.remove_fmea_node('effect', e3);
  PERFORM pg_temp.assert_eq((SELECT severity_used || '/' || needs_attention FROM public.fmea_causes WHERE id = c1), '7/false', 'removing the severe effect scores the cause again');
  PERFORM app.save_fmea_cause(m1, c1, '{"occurrence":10,"detection":10}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT rpn || '/' || priority || '/' || needs_attention FROM public.fmea_causes WHERE id = c1), '700/high/true', 'high priority needs attention');
  PERFORM app.save_fmea_cause(m1, c1, '{"occurrence":null}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT (rpn IS NULL AND priority IS NULL AND needs_attention IS NULL)::text FROM public.fmea_causes WHERE id = c1), 'true', 'a rating cleared leaves no figures worked out');
  PERFORM pg_temp.assert_eq((SELECT severity_used FROM public.fmea_causes WHERE id = c1), 7, 'but the severity is still known');
  c2 := app.save_fmea_cause(m2, NULL, '{"text":"Drill broken","occurrence":2,"detection":2}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT (severity_used IS NULL AND priority IS NULL)::text FROM public.fmea_causes WHERE id = c2), 'true', 'a cause whose mode has no effect has nothing worked out');
  r := pg_temp.fails(format($f$SELECT app.save_fmea_cause(%L, NULL, '{"text":"x","occurrence":0}'::jsonb)$f$, m1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'occurrence is 1 to 10');
  r := pg_temp.fails(format($f$SELECT app.save_fmea_cause(%L, NULL, '{"text":"x","rpn":1}'::jsonb)$f$, m1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'a client cannot send the worked-out figures');
  r := pg_temp.fails(format($f$SELECT app.save_fmea_cause(%L, %L, '{"noActionReason":"x"}'::jsonb)$f$, m1, c1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'a reason is at least three characters');

  -- ---- what a draft still needs ----
  PERFORM app.save_fmea_cause(m1, c1, '{"occurrence":10}'::jsonb);
  PERFORM app.set_fmea_approver(r1, dan);
  PERFORM pg_temp.assert_eq(app.fmea_revision_problems(r1), ARRAY[
    '1 item with nothing below it has no function (first: Lathe)',
    '1 failure mode has no effect (first: Hole missing)',
    '1 cause names no prevention or detection control (first: Drill broken)',
    '1 cause needs attention (first: Tool wear): its priority is high or its severity is 9 or more, so say what will be done or why nothing will be'],
    'the list names what is missing and the first of each');
  r := pg_temp.fails(format('SELECT app.submit_fmea_revision(%L)', r1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'it cannot be submitted yet');
  -- Taking the empty work element away answers the first; the others are answered one by one.
  PERFORM app.remove_fmea_node('item', it_el);
  PERFORM pg_temp.assert_eq(cardinality(app.fmea_revision_problems(r1)), 3, 'the work element without a function is gone from the list');
  e3 := app.save_fmea_effect(m2, NULL, '{"level":"own_plant","text":"Rework"}'::jsonb);
  PERFORM pg_temp.assert_eq((app.fmea_revision_problems(r1))[1], '1 effect has no severity (first: Rework)', 'an effect with no severity is asked for');
  PERFORM app.save_fmea_effect(m2, e3, '{"severity":3}'::jsonb);
  PERFORM app.save_fmea_cause(m2, c2, '{"detectionControls":"Gauge every part"}'::jsonb);
  PERFORM pg_temp.assert_eq(cardinality(app.fmea_revision_problems(r1)), 1, 'only the cause that needs attention is left');
  PERFORM app.save_fmea_cause(m1, c1, '{"noActionReason":"The customer has accepted this rate"}'::jsonb);
  PERFORM pg_temp.assert_eq(app.fmea_revision_problems(r1), ARRAY[]::text[], 'a written reason answers it');
  -- A mode with no cause and a function with no mode are named too.
  fn1 := app.save_fmea_function(it_step2, NULL, '{"text":"Chamfer the edge"}'::jsonb);
  PERFORM pg_temp.assert_eq((app.fmea_revision_problems(r1))[1], '1 function has no failure mode (first: Chamfer the edge)', 'a function with no failure mode');
  m_other := app.save_fmea_failure_mode(fn1, NULL, '{"text":"Edge sharp"}'::jsonb);
  PERFORM pg_temp.assert_eq(cardinality(app.fmea_revision_problems(r1)), 2, 'then a mode with no effect and no cause');
  PERFORM app.remove_fmea_node('function', fn1);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_failure_modes WHERE id = m_other), 0::bigint, 'removing a function removes what is under it');
  PERFORM pg_temp.assert_eq(app.fmea_revision_problems(r1), ARRAY[]::text[], 'and the draft is complete again');
  PERFORM pg_temp.logout();

  -- ---- who may read and write ----
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_items WHERE revision_id = r1), 0::bigint, 'a viewer does not read the analysis of a draft');
  r := pg_temp.fails(format($f$SELECT app.save_fmea_item(%L, NULL, '{"kind":"item","name":"x"}'::jsonb)$f$, r1));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a viewer cannot write it');
  r := pg_temp.fails(format('SELECT app.remove_fmea_node(%L, %L)', 'cause', c1));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'nor remove a cause');
  r := pg_temp.fails(format('SELECT app.set_fmea_revision_model(%L)', r1));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'nor change the model of a draft');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_items) + (SELECT count(*) FROM public.fmea_causes), 0::bigint, 'another organisation reads none of it');
  r := pg_temp.fails(format($f$SELECT app.save_fmea_cause(%L, %L, '{"text":"hijack"}'::jsonb)$f$, m1, c1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'another organisation cannot change a cause');
  r := pg_temp.fails(format($f$SELECT app.save_fmea_item(%L, NULL, '{"kind":"item","name":"x"}'::jsonb)$f$, r1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'nor add to a revision');
  r := pg_temp.fails(format('SELECT app.remove_fmea_node(%L, %L)', 'item', it_item));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'nor remove an item');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  r := pg_temp.fails(format($f$INSERT INTO public.fmea_items (organisation_id, revision_id, kind, name) VALUES (%L, %L, 'item', 'x')$f$, org, r1));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'no one writes the tables directly');
  r := pg_temp.fails(format($f$UPDATE public.fmea_causes SET text = 'x' WHERE id = %L$f$, c1));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'not even a manager');
  PERFORM pg_temp.logout();
  -- The worked-out figures cannot be forged, even by SQL: the RPN is exactly severity x occurrence x detection.
  r := pg_temp.fails(format($f$UPDATE public.fmea_causes SET rpn = 1 WHERE id = %L$f$, c1));
  PERFORM pg_temp.assert_eq(left(r, 5), '23514', 'a forged RPN is refused');
  r := pg_temp.fails(format($f$UPDATE public.fmea_causes SET priority = NULL WHERE id = %L$f$, c1));
  PERFORM pg_temp.assert_eq(left(r, 5), '23514', 'and a priority cannot be dropped from a rated cause');

  -- ---- submitting freezes the analysis, even for SQL ----
  PERFORM pg_temp.login(cat);
  PERFORM app.submit_fmea_revision(r1);
  r := pg_temp.fails(format($f$SELECT app.save_fmea_cause(%L, %L, '{"text":"changed"}'::jsonb)$f$, m1, c1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'a submitted revision cannot be edited');
  r := pg_temp.fails(format($f$SELECT app.save_fmea_item(%L, NULL, '{"kind":"item","name":"x"}'::jsonb)$f$, r1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'nor have items added');
  r := pg_temp.fails(format('SELECT app.remove_fmea_node(%L, %L)', 'cause', c1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'nor have a cause removed');
  PERFORM pg_temp.logout();
  r := pg_temp.fails(format($f$UPDATE public.fmea_causes SET text = 'sneaky' WHERE id = %L$f$, c1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'SQL cannot change a cause of a submitted revision');
  r := pg_temp.fails(format($f$INSERT INTO public.fmea_effects (organisation_id, revision_id, failure_mode_id, level, text) VALUES (%L, %L, %L, 'own_plant', 'x')$f$, org, r1, m1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'or add an effect');
  r := pg_temp.fails(format('DELETE FROM public.fmea_failure_modes WHERE id = %L', m1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'or delete a failure mode');
  r := pg_temp.fails(format($f$UPDATE public.fmea_revisions SET model_id = %L WHERE id = %L$f$, (SELECT id FROM public.fmea_models WHERE organisation_id = org2 LIMIT 1), r1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'the model of a submitted revision is frozen');
  PERFORM pg_temp.login(dan);
  PERFORM app.approve_fmea_revision(r1, current_date, NULL);
  PERFORM pg_temp.assert_eq((SELECT status FROM public.fmea_revisions WHERE id = r1), 'effective', 'approved and in force');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_causes WHERE revision_id = r1), 2::bigint, 'a viewer reads the analysis of an FMEA in force');
  PERFORM pg_temp.logout();

  -- ---- an FMEA started from a base ----
  PERFORM pg_temp.login(cat);
  fc := app.create_fmea(org, jsonb_build_object('kind', 'process', 'title', 'Machining the bracket (customer B)', 'baseFmeaId', f1));
  rc := (SELECT id FROM public.fmea_revisions WHERE fmea_id = fc);
  PERFORM pg_temp.assert_eq((SELECT base_fmea_id FROM public.fmeas WHERE id = fc), f1, 'it remembers its base');
  PERFORM pg_temp.assert_eq((SELECT based_on_revision_id FROM public.fmea_revisions WHERE id = rc), r1, 'and the revision of the base it came from');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_items WHERE revision_id = rc), 3::bigint, 'the structure is copied');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_functions WHERE revision_id = rc), 2::bigint, 'with its functions');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_failure_modes WHERE revision_id = rc), 2::bigint, 'failure modes');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_effects WHERE revision_id = rc), 3::bigint, 'effects');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_causes WHERE revision_id = rc), 2::bigint, 'and causes');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_items WHERE revision_id = rc AND parent_id IS NOT NULL), 2::bigint, 'the tree keeps its shape');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_causes c JOIN public.fmea_causes b ON b.id = c.base_row_id WHERE c.revision_id = rc AND b.revision_id = r1), 2::bigint, 'every cause points at the base row it came from');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_items WHERE revision_id = rc AND prev_row_id IS NOT NULL), 0::bigint, 'a base copy has no earlier revision of its own');
  PERFORM pg_temp.assert_eq((SELECT severity_used || '/' || rpn || '/' || priority FROM public.fmea_causes WHERE revision_id = rc AND text = 'Tool wear'), '7/700/high', 'the copy is scored');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_team_members WHERE revision_id = rc) + (SELECT count(*) FROM public.fmea_links WHERE revision_id = rc), 0::bigint, 'the team and the scope are the new FMEA''s own');
  PERFORM app.save_fmea_cause((SELECT failure_mode_id FROM public.fmea_causes WHERE revision_id = rc AND text = 'Tool wear'), (SELECT id FROM public.fmea_causes WHERE revision_id = rc AND text = 'Tool wear'), '{"text":"Tool wear (customer B)"}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT text FROM public.fmea_causes WHERE id = c1), 'Tool wear', 'changing the copy leaves the base alone');
  r := pg_temp.fails(format($f$SELECT app.create_fmea(%L, jsonb_build_object('kind','design','title','x','baseFmeaId',%L))$f$, org, f1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'an FMEA starts only from one of the same kind');
  r := pg_temp.fails(format($f$SELECT app.create_fmea(%L, jsonb_build_object('kind','design','title','x','baseFmeaId',%L))$f$, org, fd));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'or from one that is not in force');
  r := pg_temp.fails(format($f$SELECT app.create_fmea(%L, jsonb_build_object('kind','process','title','x','baseFmeaId',%L))$f$, org, gen_random_uuid()));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'or from one that does not exist');
  PERFORM pg_temp.logout();
  r := pg_temp.fails(format($f$UPDATE public.fmeas SET base_fmea_id = NULL WHERE id = %L$f$, fc));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'the base never changes');
  r := pg_temp.fails(format($f$UPDATE public.fmea_revisions SET based_on_revision_id = NULL WHERE id = %L$f$, rc));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'nor the revision it came from');
  PERFORM pg_temp.login(eve);
  r := pg_temp.fails(format($f$SELECT app.create_fmea(%L, jsonb_build_object('kind','process','title','x','baseFmeaId',%L))$f$, org2, f1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'another organisation''s FMEA cannot be a base');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(bob);
  r := pg_temp.fails(format($f$SELECT app.create_fmea(%L, jsonb_build_object('kind','process','title','x','baseFmeaId',%L))$f$, org, f1));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a viewer cannot start one');
  PERFORM pg_temp.logout();

  -- ---- a new revision copies the analysis, with lineage, and takes the model that is current now ----
  PERFORM pg_temp.login(cat);
  r2 := app.start_fmea_revision(f1);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_causes WHERE revision_id = r2), 2::bigint, 'the causes are copied into the new draft');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_items n JOIN public.fmea_items o ON o.id = n.prev_row_id WHERE n.revision_id = r2 AND o.revision_id = r1), 3::bigint, 'each row knows the row it continues');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_causes WHERE revision_id = r2 AND base_row_id IS NOT NULL), 0::bigint, 'an FMEA with no base has no base rows');
  PERFORM pg_temp.assert_eq((SELECT rpn FROM public.fmea_causes WHERE revision_id = r2 AND text = 'Tool wear'), 700, 'and the figures carry over');
  PERFORM pg_temp.logout();
  -- Change the model: a grid in which severity 9-10 is high and a high occurrence is only medium.
  PERFORM pg_temp.login(dan);
  cfg := (SELECT config FROM public.fmea_models WHERE organisation_id = org AND current);
  grid := '[{"sFrom":1,"sTo":8,"oFrom":1,"oTo":5,"dFrom":1,"dTo":10,"priority":"low"},
            {"sFrom":1,"sTo":8,"oFrom":6,"oTo":10,"dFrom":1,"dTo":10,"priority":"medium"},
            {"sFrom":9,"sTo":10,"oFrom":1,"oTo":10,"dFrom":1,"dTo":10,"priority":"high"}]'::jsonb;
  v_model2 := app.save_fmea_model(org, jsonb_set(jsonb_set(cfg, '{method}', '"ap"'), '{apRules}', grid), 'Use the grid');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT model_id FROM public.fmea_revisions WHERE id = r2) <> v_model2, true, 'a draft stays on the model it started with');
  PERFORM pg_temp.login(cat);
  PERFORM app.set_fmea_revision_model(r2);
  PERFORM pg_temp.assert_eq((SELECT model_id FROM public.fmea_revisions WHERE id = r2), v_model2, 'it can move to the latest model');
  PERFORM pg_temp.assert_eq((SELECT rpn || '/' || priority || '/' || needs_attention FROM public.fmea_causes WHERE revision_id = r2 AND text = 'Tool wear'), '700/medium/false', 'and is scored by that model: the grid says medium');
  r := pg_temp.fails(format('SELECT app.set_fmea_revision_model(%L)', r1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'an issued revision keeps its model');
  -- A revision started after the change begins on the new model; the one in force keeps the old.
  PERFORM pg_temp.assert_eq((SELECT priority FROM public.fmea_causes WHERE revision_id = r1 AND text = 'Tool wear'), 'high', 'the revision in force is still scored as it was');

  -- ---- removing a structure item removes everything under it ----
  PERFORM app.remove_fmea_node('item', (SELECT id FROM public.fmea_items WHERE revision_id = r2 AND kind = 'item'));
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_items WHERE revision_id = r2) + (SELECT count(*) FROM public.fmea_functions WHERE revision_id = r2)
    + (SELECT count(*) FROM public.fmea_failure_modes WHERE revision_id = r2) + (SELECT count(*) FROM public.fmea_effects WHERE revision_id = r2)
    + (SELECT count(*) FROM public.fmea_causes WHERE revision_id = r2), 0::bigint, 'the whole tree goes with its top item');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_causes WHERE revision_id = r1), 2::bigint, 'and the revision in force is untouched');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
