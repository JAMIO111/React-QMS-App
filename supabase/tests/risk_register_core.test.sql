-- Risk register RK1: permissions and role defaults, the seeded matrix and categories, matrix versions, risks, inherent assessments scored by the database,
-- append-only records, retiring, tenancy.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('4a000000-0000-0000-0000-000000000c01', 'ann@rk.test'), ('4a000000-0000-0000-0000-000000000c02', 'bob@rk.test'),
  ('4a000000-0000-0000-0000-000000000c03', 'eve@rk.test'), ('4a000000-0000-0000-0000-000000000c04', 'cat@rk.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '4a000000-0000-0000-0000-000000000c01'; bob uuid := '4a000000-0000-0000-0000-000000000c02';
  eve uuid := '4a000000-0000-0000-0000-000000000c03'; cat uuid := '4a000000-0000-0000-0000-000000000c04';
  org uuid; org2 uuid; c_process uuid; c_other uuid; r1 uuid; r2 uuid; a1 uuid; a2 uuid; m1 uuid; m2 uuid; cfg jsonb; r text; u uuid;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('RK Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('RK Beta'); PERFORM pg_temp.logout();
  -- Bob: viewer (reads). Cat: quality engineer (manages, does not approve).
  FOREACH u IN ARRAY ARRAY[bob, cat] LOOP
    INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u, 'active');
  END LOOP;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = CASE ou.user_id WHEN cat THEN 'quality_engineer' ELSE 'viewer' END)
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id IN (bob, cat);

  -- ---- permissions and role defaults ----
  PERFORM pg_temp.assert_eq((SELECT array_agg(rp.permission_code ORDER BY 1) FROM public.role_permissions rp JOIN public.roles r ON r.id = rp.role_id
    WHERE r.organisation_id = org AND r.key = 'quality_manager' AND rp.permission_code LIKE 'risk.%'), ARRAY['risk.approve','risk.manage','risk.read'], 'a quality manager holds all three');
  PERFORM pg_temp.assert_eq((SELECT array_agg(rp.permission_code ORDER BY 1) FROM public.role_permissions rp JOIN public.roles r ON r.id = rp.role_id
    WHERE r.organisation_id = org AND r.key = 'quality_engineer' AND rp.permission_code LIKE 'risk.%'), ARRAY['risk.manage','risk.read'], 'a quality engineer reads and manages');
  PERFORM pg_temp.assert_eq((SELECT array_agg(rp.permission_code ORDER BY 1) FROM public.role_permissions rp JOIN public.roles r ON r.id = rp.role_id
    WHERE r.organisation_id = org AND r.key = 'viewer' AND rp.permission_code LIKE 'risk.%'), ARRAY['risk.read'], 'a viewer reads');

  -- ---- the seeded matrix and categories ----
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.risk_categories WHERE organisation_id = org), 10::bigint, 'ten categories are seeded');
  SELECT id INTO c_process FROM public.risk_categories WHERE organisation_id = org AND key = 'process';
  SELECT id INTO c_other FROM public.risk_categories WHERE organisation_id = org AND key = 'other';
  SELECT id, config INTO m1, cfg FROM public.risk_models WHERE organisation_id = org AND current;
  PERFORM pg_temp.assert_eq((SELECT version FROM public.risk_models WHERE id = m1), 1, 'the default matrix is version 1');
  PERFORM pg_temp.assert_eq(app.score_risk(org, 1, 4) ->> 'band', 'low', '1 x 4 is low');
  PERFORM pg_temp.assert_eq(app.score_risk(org, 3, 3) ->> 'band', 'medium', '3 x 3 is medium');
  PERFORM pg_temp.assert_eq(app.score_risk(org, 4, 4) ->> 'band', 'high', '4 x 4 is high');
  PERFORM pg_temp.assert_eq(app.score_risk(org, 5, 4) ->> 'band', 'critical', '5 x 4 is critical');
  PERFORM pg_temp.assert_eq(app.score_risk(org, 3, 3) -> 'acceptable', 'true'::jsonb, 'medium is acceptable by default');
  PERFORM pg_temp.assert_eq(app.score_risk(org, 4, 4) -> 'acceptable', 'false'::jsonb, 'high is not');
  PERFORM pg_temp.assert_eq(app.score_risk(org, 2, 5) ->> 'likelihood', 'Unlikely', 'the level is named');
  r := pg_temp.fails(format('SELECT app.score_risk(%L, 0, 3)', org));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'a level is 1 to 5');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.risk_models WHERE organisation_id = org2), 0::bigint, 'another organisation''s matrix is invisible');

  -- ---- raising a risk ----
  r := pg_temp.fails(format($f$SELECT app.create_risk(%L, '{"title":"No category"}'::jsonb)$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'a category is needed');
  r := pg_temp.fails(format($f$SELECT app.create_risk(%L, jsonb_build_object('categoryId', %L, 'title', 'x', 'ownerId', %L))$f$, org, c_process, eve));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'the owner is a member of this organisation');
  r := pg_temp.fails(format($f$SELECT app.create_risk(%L, jsonb_build_object('categoryId', %L, 'title', 'x', 'colour', 'red'))$f$, org, c_process));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'unknown fields are refused');
  r1 := app.create_risk(org, jsonb_build_object('categoryId', c_process, 'title', ' Single source for castings ', 'cause', 'One approved foundry', 'effect', 'Line stop'));
  PERFORM pg_temp.assert_eq((SELECT reference || '/' || kind || '/' || status || '/' || title || '/' || (owner_user_id = ann) FROM public.risks WHERE id = r1),
    'RSK-001/risk/draft/Single source for castings/true', 'numbered, a draft, owned by whoever raised it');
  r2 := app.create_risk(org, jsonb_build_object('kind', 'opportunity', 'categoryId', c_other, 'title', 'Second CMM shift', 'ownerId', cat));
  PERFORM pg_temp.assert_eq((SELECT reference FROM public.risks WHERE id = r2), 'RSK-002', 'the next number');
  PERFORM app.update_risk(r2, '{"kind":"risk","description":"More capacity"}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT kind FROM public.risks WHERE id = r2), 'risk', 'the kind can change while it is a draft');
  PERFORM app.update_risk(r2, '{"kind":"opportunity"}'::jsonb);

  -- ---- assessing ----
  r := pg_temp.fails(format('SELECT app.assess_risk(%L, 4, 4, %L)', r1, ''));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'the reasoning is needed');
  a1 := app.assess_risk(r1, 4, 4, 'Two stoppages last year');
  PERFORM pg_temp.assert_eq((SELECT score || '/' || band || '/' || phase || '/' || status || '/' || model_version FROM public.risk_assessments WHERE id = a1),
    '16/high/inherent/current/1', 'the database scores it against the current matrix');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.risks WHERE id = r1), 'open', 'the first assessment opens the risk');
  r := pg_temp.fails(format($f$SELECT app.update_risk(%L, '{"kind":"opportunity"}'::jsonb)$f$, r1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'once assessed the kind is fixed');
  a2 := app.assess_risk(r1, 3, 3, 'A second foundry is being trialled');
  PERFORM pg_temp.assert_eq((SELECT string_agg(score || ':' || status, ',' ORDER BY created_at, score DESC) FROM public.risk_assessments WHERE risk_id = r1),
    '16:superseded,9:current', 'a new assessment supersedes the old one');
  PERFORM pg_temp.assert_eq((SELECT supersedes_id FROM public.risk_assessments WHERE id = a2), a1, 'and points at it');
  r := pg_temp.fails(format($f$UPDATE public.risk_assessments SET rationale = 'x' WHERE id = %L$f$, a2));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'no direct writes for signed-in users');
  r := pg_temp.fails(format($f$INSERT INTO public.risks (organisation_id, reference, category_id, title, owner_user_id) VALUES (%L, 'RSK-999', %L, 'x', %L)$f$, org, c_process, ann));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'nor direct inserts');

  -- ---- the matrix as versions ----
  cfg := jsonb_set(jsonb_set(cfg, '{bands,2,2}', '"high"'), '{acceptanceBand}', '"low"');
  r := pg_temp.fails(format('SELECT app.save_risk_model(%L, %L::jsonb, %L)', org, cfg, ''));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'a reason is needed');
  r := pg_temp.fails(format('SELECT app.save_risk_model(%L, %L::jsonb, %L)', org, cfg - 'bands', 'x y z'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'the matrix must be whole');
  r := pg_temp.fails(format('SELECT app.save_risk_model(%L, %L::jsonb, %L)', org, jsonb_set(cfg, '{acceptanceBand}', '"critical"'), 'x y z'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'critical is never simply acceptable');
  m2 := app.save_risk_model(org, cfg, 'Tighter on customer impact');
  PERFORM pg_temp.assert_eq((SELECT string_agg(version || ':' || current, ',' ORDER BY version) FROM public.risk_models WHERE organisation_id = org), '1:false,2:true', 'version 2 is current');
  r := pg_temp.fails(format('SELECT app.save_risk_model(%L, %L::jsonb, %L)', org, cfg, 'Again'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'an unchanged matrix is refused');
  PERFORM pg_temp.assert_eq(app.score_risk(org, 3, 3) ->> 'band', 'high', '3 x 3 is high under version 2');
  PERFORM pg_temp.assert_eq(app.score_risk(org, 2, 3) -> 'acceptable', 'false'::jsonb, 'and medium is no longer acceptable');
  PERFORM pg_temp.assert_eq((SELECT band || '/' || model_version FROM public.risk_assessments WHERE id = a2), 'medium/1', 'an existing assessment keeps what it was scored with');
  PERFORM pg_temp.logout();

  -- ---- who may do what ----
  PERFORM pg_temp.login(cat);
  PERFORM app.assess_risk(r2, 2, 2, 'Low effort, modest gain');
  r := pg_temp.fails(format('SELECT app.save_risk_model(%L, %L::jsonb, %L)', org, jsonb_set(cfg, '{acceptanceBand}', '"medium"'), 'Not mine to change'));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'changing the matrix needs risk.approve');
  PERFORM pg_temp.assert_ok(format($f$INSERT INTO public.risk_categories (organisation_id, key, label) VALUES (%L, 'tooling', 'Tooling')$f$, org), 'a manager adds a category');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.risks WHERE organisation_id = org), 2::bigint, 'a viewer reads the register');
  r := pg_temp.fails(format($f$SELECT app.create_risk(%L, jsonb_build_object('categoryId', %L, 'title', 'Not allowed'))$f$, org, c_process));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'but cannot raise a risk');
  r := pg_temp.fails(format('SELECT app.assess_risk(%L, 1, 1, %L)', r1, 'No'));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'or assess one');
  r := pg_temp.fails(format($f$INSERT INTO public.risk_categories (organisation_id, key, label) VALUES (%L, 'nope', 'Nope')$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'or add a category');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.risks WHERE organisation_id = org), 0::bigint, 'another organisation sees nothing');
  r := pg_temp.fails(format('SELECT app.assess_risk(%L, 1, 1, %L)', r1, 'Hijack'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'and finds nothing to assess');
  r := pg_temp.fails(format($f$SELECT app.update_risk(%L, '{"title":"Hijack"}'::jsonb)$f$, r1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'or to change');
  r := pg_temp.fails(format('SELECT app.score_risk(%L, 1, 1)', org));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'or to score');
  PERFORM pg_temp.logout();

  -- ---- retiring ----
  PERFORM pg_temp.login(ann);
  r := pg_temp.fails(format('SELECT app.retire_risk(%L, %L)', r1, ''));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'retiring needs a reason');
  PERFORM app.retire_risk(r1, 'Second foundry approved');
  r := pg_temp.fails(format('SELECT app.assess_risk(%L, 1, 1, %L)', r1, 'After'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'a retired risk is not assessed');
  r := pg_temp.fails(format($f$SELECT app.update_risk(%L, '{"title":"After"}'::jsonb)$f$, r1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'or changed');
  PERFORM app.reactivate_risk(r1);
  PERFORM pg_temp.assert_eq((SELECT status || '/' || (retired_reason IS NULL) FROM public.risks WHERE id = r1), 'open/true', 'brought back as open, because it was assessed');
  -- a switched-off category stays on the risk that has it, but cannot be chosen
  UPDATE public.risk_categories SET active = false WHERE id = c_process;
  PERFORM app.update_risk(r1, '{"title":"Single source for castings (EU)"}'::jsonb);
  r := pg_temp.fails(format($f$SELECT app.update_risk(%L, jsonb_build_object('categoryId', %L))$f$, r2, c_process));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'a switched-off category cannot be chosen');
  PERFORM pg_temp.logout();

  -- ---- the database holds the records for SQL too ----
  r := pg_temp.fails(format($f$UPDATE public.risk_assessments SET rationale = 'rewritten' WHERE id = %L$f$, a2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'an assessment is never rewritten');
  r := pg_temp.fails(format('DELETE FROM public.risk_assessments WHERE id = %L', a1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'or deleted');
  r := pg_temp.fails(format($f$UPDATE public.risk_models SET reason = 'rewritten' WHERE id = %L$f$, m2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'a matrix version is frozen');
  r := pg_temp.fails(format('DELETE FROM public.risks WHERE id = %L', r2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'a risk is never deleted');
  r := pg_temp.fails(format($f$UPDATE public.risks SET reference = 'RSK-777' WHERE id = %L$f$, r2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'and keeps its reference');
END $$;

ROLLBACK;
