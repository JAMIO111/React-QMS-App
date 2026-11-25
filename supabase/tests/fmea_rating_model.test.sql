-- FMEA FM2: the rating model. A neutral default is seeded for every organisation (RPN, no publisher's grid), a valid model is defined in one place (ten levels of
-- each scale, thresholds, an action priority grid that covers every combination exactly once), the database scores S / O / D, versions are saved only by an approver with
-- a reason, frozen even for SQL, and the default review interval follows the model.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('4e000000-0000-0000-0000-000000000e01', 'ann@fmr.test'), ('4e000000-0000-0000-0000-000000000e02', 'bob@fmr.test'),
  ('4e000000-0000-0000-0000-000000000e03', 'cat@fmr.test'), ('4e000000-0000-0000-0000-000000000e04', 'dan@fmr.test'),
  ('4e000000-0000-0000-0000-000000000e05', 'eve@fmr.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

CREATE FUNCTION pg_temp.expect(p_config jsonb, p_prefix text, p_label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v text := app.fmea_model_problem(p_config);
BEGIN
  IF v IS NULL OR v NOT LIKE p_prefix || '%' THEN RAISE EXCEPTION 'FAILED: % (got %)', p_label, coalesce(v, 'no problem'); END IF;
END $$;

DO $$
DECLARE
  ann uuid := '4e000000-0000-0000-0000-000000000e01'; bob uuid := '4e000000-0000-0000-0000-000000000e02';
  cat uuid := '4e000000-0000-0000-0000-000000000e03'; dan uuid := '4e000000-0000-0000-0000-000000000e04'; eve uuid := '4e000000-0000-0000-0000-000000000e05';
  org uuid; org2 uuid; u uuid; m1 uuid; m2 uuid; m3 uuid; cfg jsonb; grid jsonb; bad jsonb; r text; s jsonb; fm uuid;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('FMR Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('FMR Beta'); PERFORM pg_temp.logout();
  -- Bob: viewer (reads). Cat: quality engineer (manages, cannot approve). Dan: quality manager (approves).
  FOREACH u IN ARRAY ARRAY[bob, cat, dan] LOOP
    INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u, 'active');
  END LOOP;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = CASE ou.user_id WHEN dan THEN 'quality_manager' WHEN bob THEN 'viewer' ELSE 'quality_engineer' END)
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id IN (bob, cat, dan);

  -- ---- the default ----
  SELECT id, config INTO m1, cfg FROM public.fmea_models WHERE organisation_id = org AND current;
  PERFORM pg_temp.assert_eq((SELECT version FROM public.fmea_models WHERE id = m1), 1, 'the default model is version 1');
  PERFORM pg_temp.assert_eq(cfg ->> 'method', 'rpn', 'it rates by RPN: the publisher''s action priority grid is not in the product');
  PERFORM pg_temp.assert_eq(jsonb_array_length(cfg -> 'apRules'), 0, 'with no action priority grid');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_models WHERE organisation_id = org2), 1::bigint, 'every organisation has a model');
  PERFORM pg_temp.assert_eq(jsonb_array_length(cfg -> 'scales' -> 'design' -> 'severity'), 10, 'ten levels of severity');
  PERFORM pg_temp.assert_eq(jsonb_array_length(cfg -> 'scales' -> 'process' -> 'detection'), 10, 'ten levels of detection for a process');
  PERFORM pg_temp.assert_eq(app.fmea_model_problem(cfg), NULL::text, 'and the default is valid');

  -- ---- what a valid model is ----
  PERFORM pg_temp.expect(jsonb_set(cfg, '{method}', '"magic"'), 'The method is rpn or ap', 'the method is rpn or ap');
  PERFORM pg_temp.expect(jsonb_set(cfg, '{rpnMediumFrom}', '200'), 'Medium priority starts at a lo', 'medium starts below high');
  PERFORM pg_temp.expect(jsonb_set(cfg, '{severityFloor}', '11'), 'The severity that alw', 'the severity floor is 1 to 10');
  PERFORM pg_temp.expect(jsonb_set(cfg, '{reviewMonths}', '0'), 'The review interval ', 'the review interval is 1 to 120');
  PERFORM pg_temp.expect(jsonb_set(cfg, '{reviewMonths}', '6.5'), 'The review interval ', 'in whole months');
  PERFORM pg_temp.expect(cfg #- '{scales,design,severity,9}', 'Give ten levels of severi', 'nine levels are not enough');
  PERFORM pg_temp.expect(jsonb_set(cfg, '{scales,process,occurrence,1,label}', '"Very unlikely"'), 'The levels of occurrence (proc', 'the levels need different labels');
  PERFORM pg_temp.expect(jsonb_set(cfg, '{scales,design,detection,0,label}', '""'), 'Each level of detecti', 'a label is needed');
  PERFORM pg_temp.expect(jsonb_set(cfg, '{scales,design,detection,0,criteria}', to_jsonb(repeat('x', 301))), 'A level''s criteria ar', 'criteria are up to 300 characters');
  PERFORM pg_temp.expect(cfg - 'scales', 'Give the rating scal', 'the scales are needed');
  PERFORM pg_temp.expect(jsonb_set(cfg, '{method}', '"ap"'), 'The action priority method nee', 'the ap method needs a grid');

  -- A grid that covers every combination exactly once: low where S is 1-8 and O 1-5, medium where S is 1-8 and O 6-10, high where S is 9-10.
  grid := '[{"sFrom":1,"sTo":8,"oFrom":1,"oTo":5,"dFrom":1,"dTo":10,"priority":"low"},
            {"sFrom":1,"sTo":8,"oFrom":6,"oTo":10,"dFrom":1,"dTo":10,"priority":"medium"},
            {"sFrom":9,"sTo":10,"oFrom":1,"oTo":10,"dFrom":1,"dTo":10,"priority":"high"}]'::jsonb;
  PERFORM pg_temp.assert_eq(app.fmea_model_problem(jsonb_set(jsonb_set(cfg, '{method}', '"ap"'), '{apRules}', grid)), NULL::text, 'a complete grid is valid');
  PERFORM pg_temp.expect(jsonb_set(jsonb_set(cfg, '{method}', '"ap"'), '{apRules}', grid #- '{2}'), 'The action priority grid must cover ever', 'a grid with a gap is refused');
  PERFORM pg_temp.expect(jsonb_set(cfg, '{apRules}', grid || '[{"sFrom":1,"sTo":10,"oFrom":1,"oTo":10,"dFrom":1,"dTo":10,"priority":"low"}]'::jsonb), 'The action priority grid must cover ever', 'a grid with an overlap is refused, even when the method is rpn');
  PERFORM pg_temp.expect(jsonb_set(cfg, '{apRules}', jsonb_set(grid, '{0,sTo}', '0')), 'Each range of the action priori', 'a range stays inside 1 to 10');
  PERFORM pg_temp.expect(jsonb_set(cfg, '{apRules}', jsonb_set(grid, '{0,sFrom}', '9')), 'A range of the action priority ', 'and runs from low to high');
  PERFORM pg_temp.expect(jsonb_set(cfg, '{apRules}', jsonb_set(grid, '{0,priority}', '"urgent"')), 'A priority is high, ', 'a priority is high, medium or low');

  -- ---- scoring on the default (RPN) ----
  PERFORM pg_temp.login(bob);
  s := app.score_fmea(m1, 'process', 10, 10, 10);
  PERFORM pg_temp.assert_eq(s ->> 'priority', 'high', '10 x 10 x 10 is high');
  PERFORM pg_temp.assert_eq((s ->> 'rpn')::int, 1000, 'the RPN is S x O x D');
  PERFORM pg_temp.assert_eq((app.score_fmea(m1, 'process', 5, 5, 4) ->> 'priority'), 'medium', 'an RPN of exactly 100 is medium');
  PERFORM pg_temp.assert_eq((app.score_fmea(m1, 'design', 3, 3, 3) ->> 'priority'), 'low', '27 is low');
  s := app.score_fmea(m1, 'design', 9, 1, 1);
  PERFORM pg_temp.assert_eq(s ->> 'priority', 'low', 'severity 9 with a low RPN is low on the method');
  PERFORM pg_temp.assert_eq((s ->> 'needsAttention')::boolean, true, 'but it always needs attention: the severity floor');
  PERFORM pg_temp.assert_eq((app.score_fmea(m1, 'design', 8, 1, 1) ->> 'needsAttention')::boolean, false, 'severity 8 does not');
  PERFORM pg_temp.assert_eq(app.score_fmea(m1, 'process', 4, 3, 2) ->> 'severityLabel', 'Minor', 'the answer carries the scale''s labels');
  PERFORM pg_temp.assert_eq((app.score_fmea(m1, 'process', 4, 3, 2) ->> 'modelVersion')::int, 1, 'and the model version');
  r := pg_temp.fails(format($f$SELECT app.score_fmea(%L, 'process', 11, 1, 1)$f$, m1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'a level is 1 to 10');
  r := pg_temp.fails(format($f$SELECT app.score_fmea(%L, 'process', NULL, 1, 1)$f$, m1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'and is given');
  r := pg_temp.fails(format($f$SELECT app.score_fmea(%L, 'service', 1, 1, 1)$f$, m1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'the kind is design or process');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login(eve);
  r := pg_temp.fails(format($f$SELECT app.score_fmea(%L, 'process', 1, 1, 1)$f$, m1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'another organisation''s model is not found');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_models WHERE organisation_id = org), 0::bigint, 'and is not visible');
  r := pg_temp.fails(format($f$SELECT app.save_fmea_model(%L, '{}'::jsonb, 'x')$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'nor can it be changed from another organisation');
  PERFORM pg_temp.logout();

  -- ---- saving a version ----
  PERFORM pg_temp.login(cat);
  r := pg_temp.fails(format($f$SELECT app.save_fmea_model(%L, %L::jsonb, 'engineer tries')$f$, org, jsonb_set(cfg, '{reviewMonths}', '6')));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a quality engineer cannot change the model');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login(dan);
  r := pg_temp.fails(format($f$SELECT app.save_fmea_model(%L, %L::jsonb, 'no change')$f$, org, cfg));
  PERFORM pg_temp.assert_eq(left(r, 5) || ' ' || (r LIKE '%Nothing has changed%'), 'QM036 true', 'an unchanged model is refused');
  r := pg_temp.fails(format($f$SELECT app.save_fmea_model(%L, %L::jsonb, 'ab')$f$, org, jsonb_set(cfg, '{reviewMonths}', '6')));
  PERFORM pg_temp.assert_eq(left(r, 5) || ' ' || (r LIKE '%Say why%'), 'QM036 true', 'a reason of at least three characters is needed');
  r := pg_temp.fails(format($f$SELECT app.save_fmea_model(%L, %L::jsonb, 'bad')$f$, org, jsonb_set(cfg, '{rpnHighFrom}', '1')));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'an invalid model is refused');
  r := pg_temp.fails(format($f$SELECT app.save_fmea_model(%L, %L::jsonb, 'extra')$f$, org, cfg || '{"colour":"red"}'));
  PERFORM pg_temp.assert_eq(left(r, 5) || ' ' || (r LIKE '%Nothing has changed%'), 'QM036 true', 'an unknown key is dropped, so it is not a change');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.assert_eq((SELECT max(version) FROM public.fmea_models WHERE organisation_id = org), 1, 'so the model is still version 1');

  PERFORM pg_temp.login(dan);
  m2 := app.save_fmea_model(org, jsonb_set(jsonb_set(cfg, '{reviewMonths}', '6'), '{scales,design,severity,0,criteria}', '"Our own words"'), 'Review twice a year');
  PERFORM pg_temp.assert_eq((SELECT string_agg(version || ':' || current, ',' ORDER BY version) FROM public.fmea_models WHERE organisation_id = org), '1:false,2:true', 'version 2 is current');
  PERFORM pg_temp.assert_eq((SELECT config -> 'scales' -> 'design' -> 'severity' -> 0 ->> 'criteria' FROM public.fmea_models WHERE id = m2), 'Our own words', 'the organisation''s own criteria text is kept');
  PERFORM pg_temp.assert_eq((SELECT reason FROM public.fmea_models WHERE id = m2), 'Review twice a year', 'with its reason');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(app.fmea_default_review_months(org), 6, 'the default review interval follows the current model (asked as the system)');
  PERFORM pg_temp.login(dan);
  -- An action priority grid: saved, and the score follows it, whatever the RPN says.
  m3 := app.save_fmea_model(org, jsonb_set(jsonb_set((SELECT config FROM public.fmea_models WHERE id = m2), '{method}', '"ap"'), '{apRules}', grid), 'Use our own action priority grid');
  PERFORM pg_temp.assert_eq((app.score_fmea(m3, 'process', 9, 1, 1) ->> 'priority'), 'high', 'with the ap method severity 9 is high by the grid');
  PERFORM pg_temp.assert_eq((app.score_fmea(m3, 'process', 8, 10, 10) ->> 'priority'), 'medium', 'and a high RPN can still be medium by the grid');
  PERFORM pg_temp.assert_eq((app.score_fmea(m3, 'process', 2, 2, 2) ->> 'priority'), 'low', 'low by the grid');
  PERFORM pg_temp.assert_eq((app.score_fmea(m3, 'process', 8, 10, 10) ->> 'method'), 'ap', 'the answer says which method rated it');
  PERFORM pg_temp.assert_eq((app.score_fmea(m1, 'process', 8, 10, 10) ->> 'priority'), 'high', 'an earlier version still scores as it did (the RPN is 800)');
  -- The same grid in another order is not a change.
  r := pg_temp.fails(format($f$SELECT app.save_fmea_model(%L, %L::jsonb, 'same grid, other order')$f$, org,
    jsonb_set((SELECT config FROM public.fmea_models WHERE id = m3), '{apRules}', jsonb_build_array(grid -> 2, grid -> 0, grid -> 1))));
  PERFORM pg_temp.assert_eq(left(r, 5) || ' ' || (r LIKE '%Nothing has changed%'), 'QM036 true', 'the grid in another order is not a change');
  PERFORM pg_temp.logout();

  -- ---- versions are frozen, even for SQL ----
  r := pg_temp.fails(format($f$UPDATE public.fmea_models SET config = jsonb_set(config, '{reviewMonths}', '99') WHERE id = %L$f$, m3));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'a version cannot be edited');
  r := pg_temp.fails(format($f$UPDATE public.fmea_models SET reason = 'rewritten' WHERE id = %L$f$, m2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'nor its reason');
  r := pg_temp.fails(format($f$UPDATE public.fmea_models SET current = true WHERE id = %L$f$, m1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'an old version cannot be brought back; a new version is saved instead');
  r := pg_temp.fails(format($f$DELETE FROM public.fmea_models WHERE id = %L$f$, m1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'nor deleted');
  PERFORM pg_temp.login(dan);
  r := pg_temp.fails(format($f$INSERT INTO public.fmea_models (organisation_id, version, config, reason) VALUES (%L, 9, %L::jsonb, 'direct')$f$, org, cfg));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a signed-in person cannot write a model directly');
  r := pg_temp.fails(format($f$UPDATE public.fmea_models SET current = false WHERE id = %L$f$, m3));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'nor retire one');
  PERFORM pg_temp.logout();

  -- ---- a new organisation is seeded ----
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_models), 3::bigint, 'a viewer reads the three versions');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
