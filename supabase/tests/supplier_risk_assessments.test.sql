-- Supplier Quality SQ2b: the risk model (versions), scoring worked out by the database, append-only assessments, the only writer of risk_rating, permissions, isolation.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('3d000000-0000-0000-0000-000000000901', 'ann@sqr.test'), ('3d000000-0000-0000-0000-000000000902', 'bob@sqr.test'), ('3d000000-0000-0000-0000-000000000903', 'eve@sqr.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;
-- Scores for the default model: every factor the same score, optionally one factor different.
CREATE FUNCTION pg_temp.scores(p_model uuid, p_all integer, p_key text DEFAULT NULL, p_score integer DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_agg(jsonb_build_object('key', f ->> 'key', 'score', CASE WHEN f ->> 'key' = p_key THEN p_score ELSE p_all END, 'note', 'n'))
    FROM public.supplier_risk_models m, jsonb_array_elements(m.factors) f WHERE m.id = p_model
$$;

DO $$
DECLARE
  ann uuid := '3d000000-0000-0000-0000-000000000901'; bob uuid := '3d000000-0000-0000-0000-000000000902'; eve uuid := '3d000000-0000-0000-0000-000000000903';
  org uuid; org2 uuid; s uuid; s2 uuid; viewer_role uuid; qe_role uuid; m1 uuid; m2 uuid; a1 uuid; a2 uuid; a3 uuid; r jsonb; t text; fac jsonb; th jsonb;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('SQR Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('SQR Beta'); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, bob, 'active');
  SELECT id INTO viewer_role FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, viewer_role FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id = bob;

  -- ---- every organisation starts with the default model (version 1) ----
  SELECT id INTO m1 FROM public.supplier_risk_models WHERE organisation_id = org AND version = 1;
  PERFORM pg_temp.assert_eq((SELECT (jsonb_array_length(factors), review_interval_months, reason)::text FROM public.supplier_risk_models WHERE id = m1), '(6,12,"Default model")', 'a default model is seeded: six factors, 12 months');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.supplier_risk_models WHERE organisation_id = org2), 1::bigint, 'and for every organisation');
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_fails(format($f$INSERT INTO public.supplier_risk_models (organisation_id, version, factors, thresholds, review_interval_months, reason) VALUES (%L, 9, '[]', '{}', 12, 'x')$f$, org), 'models are written only through the function');
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'ACME', 'Acme Metals') RETURNING id INTO s;
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'BOLT', 'Bolt Co') RETURNING id INTO s2;

  -- ---- scoring is the database's: index, band, escalation (weights 5, 4, 3, 3, 3, 2 = 20) ----
  r := app.score_supplier_risk(m1, pg_temp.scores(m1, 1));
  PERFORM pg_temp.assert_eq((r ->> 'index') || '/' || (r ->> 'rating'), '1.00/low', 'all low');
  r := app.score_supplier_risk(m1, pg_temp.scores(m1, 2));
  PERFORM pg_temp.assert_eq((r ->> 'index') || '/' || (r ->> 'rating'), '2.00/medium', 'all 2 is medium');
  r := app.score_supplier_risk(m1, pg_temp.scores(m1, 3));
  PERFORM pg_temp.assert_eq((r ->> 'index') || '/' || (r ->> 'rating'), '3.00/high', 'all 3 is high');
  r := app.score_supplier_risk(m1, pg_temp.scores(m1, 4));
  PERFORM pg_temp.assert_eq((r ->> 'index') || '/' || (r ->> 'rating'), '4.00/critical', 'all 4 is critical');
  r := app.score_supplier_risk(m1, pg_temp.scores(m1, 1, 'financial_stability', 4));
  PERFORM pg_temp.assert_eq((r ->> 'index') || '/' || (r ->> 'rating') || '/' || jsonb_array_length(r -> 'escalatedBy'), '1.30/low/0', 'a light factor at 4 barely moves it and does not escalate');
  r := app.score_supplier_risk(m1, pg_temp.scores(m1, 1, 'quality_system', 4));
  PERFORM pg_temp.assert_eq((r ->> 'index') || '/' || (r ->> 'rating'), '1.60/low', 'a heavier factor that does not escalate stays low');
  r := app.score_supplier_risk(m1, pg_temp.scores(m1, 1, 'product_criticality', 4));
  PERFORM pg_temp.assert_eq((r ->> 'index') || '/' || (r ->> 'band') || '/' || (r ->> 'rating'), '1.75/medium/high', 'a critical product raises the rating to at least high (band stays medium)');
  PERFORM pg_temp.assert_eq(r -> 'escalatedBy' ->> 0, 'Criticality of what they supply', 'and says which factor did it');
  r := app.score_supplier_risk(m1, pg_temp.scores(m1, 1, 'regulatory_customer', 4));
  PERFORM pg_temp.assert_eq((r ->> 'index') || '/' || (r ->> 'band') || '/' || (r ->> 'rating'), '1.45/low/high', 'so does a regulatory or customer requirement at 4');
  r := app.score_supplier_risk(m1, pg_temp.scores(m1, 4, 'financial_stability', 1));
  PERFORM pg_temp.assert_eq(r ->> 'rating', 'critical', 'an escalation never lowers a band that is already above high');
  -- bad scores
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.score_supplier_risk(%L, '[]'::jsonb)$f$, m1)), 5), 'QM020', 'every factor must be scored');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.score_supplier_risk(%L, %L::jsonb)$f$, m1, (pg_temp.scores(m1, 2) || '[{"key":"nonsense","score":2}]'::jsonb)::text)), 5), 'QM020', 'a factor outside the model is refused');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.score_supplier_risk(%L, %L::jsonb)$f$, m1, (pg_temp.scores(m1, 2) || (pg_temp.scores(m1, 2) -> 0))::text)), 5), 'QM020', 'a factor scored twice is refused');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.score_supplier_risk(%L, %L::jsonb)$f$, m1, pg_temp.scores(m1, 5)::text)), 5), 'QM020', 'a score above 4 is refused');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.score_supplier_risk(%L, %L::jsonb)$f$, m1, pg_temp.scores(m1, 0)::text)), 5), 'QM020', 'and below 1');

  -- ---- recording: the only writer of risk_rating ----
  PERFORM pg_temp.assert_eq((SELECT risk_rating IS NULL FROM public.suppliers WHERE id = s), true, 'a supplier starts unrated');
  PERFORM pg_temp.assert_fails(format($f$UPDATE public.suppliers SET risk_rating = 'low' WHERE id = %L$f$, s), 'the rating cannot be written directly');
  PERFORM pg_temp.assert_fails(format($f$INSERT INTO public.supplier_risk_assessments (organisation_id, supplier_id, model_id, model_version, factors, risk_index, band, rating, rationale, review_on) VALUES (%L, %L, %L, 1, '[]', 1, 'low', 'low', 'sneaky', current_date + 5)$f$, org, s, m1), 'assessments are written only through the function');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_supplier_risk_assessment(%L, %L::jsonb, 'Initial assessment')$f$, s, pg_temp.scores(m1, 2)::text)), 2), 'ok', 'recording works for a member who manages suppliers');
  a1 := (SELECT id FROM public.supplier_risk_assessments WHERE supplier_id = s AND status = 'current');
  PERFORM pg_temp.assert_eq((SELECT (rating, band, risk_index, model_version, previous_rating IS NULL, review_on = (current_date + interval '12 months')::date, assessed_by = ann)::text FROM public.supplier_risk_assessments WHERE id = a1),
    '(medium,medium,2.00,1,t,t,t)', 'the assessment holds what the database worked out, the model version and the default review date');
  PERFORM pg_temp.assert_eq((SELECT risk_rating FROM public.suppliers WHERE id = s), 'medium', 'and the supplier carries the rating');
  PERFORM pg_temp.assert_eq((SELECT jsonb_array_length(factors) FROM public.supplier_risk_assessments WHERE id = a1), 6, 'every factor and score is frozen on it');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_supplier_risk_assessment(%L, %L::jsonb, 'x')$f$, s, pg_temp.scores(m1, 2)::text)), 5), 'QM020', 'a rationale is needed');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_supplier_risk_assessment(%L, %L::jsonb, 'Next review too soon', current_date)$f$, s, pg_temp.scores(m1, 2)::text)), 5), 'QM020', 'the next review must be after today');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.supplier_risk_assessments WHERE supplier_id = s), 1::bigint, 'refused assessments leave nothing behind');
  -- a second assessment supersedes the first and remembers the rating it replaced
  a2 := app.record_supplier_risk_assessment(s, pg_temp.scores(m1, 1, 'product_criticality', 4), 'Critical product, otherwise sound', current_date + 90);
  PERFORM pg_temp.assert_eq((SELECT (o.status, n.status)::text FROM public.supplier_risk_assessments o, public.supplier_risk_assessments n WHERE o.id = a1 AND n.id = a2), '(superseded,current)', 'the old one is superseded');
  PERFORM pg_temp.assert_eq((SELECT (rating, previous_rating, review_on = current_date + 90)::text FROM public.supplier_risk_assessments WHERE id = a2), '(high,medium,t)', 'the new one knows the rating it replaced and takes a chosen review date');
  PERFORM pg_temp.assert_eq((SELECT risk_rating FROM public.suppliers WHERE id = s), 'high', 'the supplier now carries the new rating');
  PERFORM pg_temp.assert_eq((SELECT escalated_by ->> 0 FROM public.supplier_risk_assessments WHERE id = a2), 'Criticality of what they supply', 'the escalation is kept with it');
  PERFORM pg_temp.assert_fails(format($f$DELETE FROM public.supplier_risk_assessments WHERE id = %L$f$, a1), 'assessments are never deleted');
  PERFORM pg_temp.assert_fails(format($f$UPDATE public.supplier_risk_assessments SET rating = 'low' WHERE id = %L$f$, a1), 'or edited');
  PERFORM pg_temp.logout();

  -- ---- a viewer reads but cannot assess or configure ----
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.supplier_risk_assessments WHERE supplier_id = s), 2::bigint, 'a viewer reads the assessments');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_supplier_risk_assessment(%L, %L::jsonb, 'Viewer says')$f$, s2, pg_temp.scores(m1, 1)::text)), 5), '42501', 'but cannot record one');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.save_supplier_risk_model(%L, %L::jsonb, %L::jsonb, 12, 'Viewer tweak')$f$, org, (SELECT factors FROM public.supplier_risk_models WHERE id = m1)::text, (SELECT thresholds FROM public.supplier_risk_models WHERE id = m1)::text)), 5), '42501', 'or change the model');
  PERFORM pg_temp.logout();

  -- ---- the model changes by version; old assessments keep theirs ----
  PERFORM pg_temp.login(ann);
  SELECT factors, thresholds INTO fac, th FROM public.supplier_risk_models WHERE id = m1;
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.save_supplier_risk_model(%L, %L::jsonb, %L::jsonb, 12, 'No change at all')$f$, org, fac::text, th::text)), 5), 'QM020', 'saving an unchanged model is refused');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.save_supplier_risk_model(%L, %L::jsonb, %L::jsonb, 6, '')$f$, org, fac::text, th::text)), 5), 'QM020', 'a reason is needed');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.save_supplier_risk_model(%L, %L::jsonb, '{"medium_from":3,"high_from":2,"critical_from":4}'::jsonb, 6, 'Backwards bands')$f$, org, fac::text)), 5), 'QM020', 'thresholds must rise');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.save_supplier_risk_model(%L, '[]'::jsonb, %L::jsonb, 6, 'No factors')$f$, org, th::text)), 5), 'QM020', 'a model needs factors');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.save_supplier_risk_model(%L, %L::jsonb, %L::jsonb, 6, 'Heavier weight')$f$, org, replace(fac::text, '"weight": 2', '"weight": 11'), th::text)), 5), 'QM020', 'a weight above 10 is refused');
  m2 := app.save_supplier_risk_model(org, (SELECT jsonb_agg(f) FROM jsonb_array_elements(fac) f WHERE f ->> 'key' <> 'financial_stability'), th, 6, 'Financial stability is covered by the supplier audit');
  PERFORM pg_temp.assert_eq((SELECT (version, review_interval_months, jsonb_array_length(factors))::text FROM public.supplier_risk_models WHERE id = m2), '(2,6,5)', 'a new version with five factors and a 6 month review');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.supplier_risk_models WHERE organisation_id = org), 2::bigint, 'the old version is kept');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_supplier_risk_assessment(%L, %L::jsonb, 'Scores for the old model')$f$, s2, pg_temp.scores(m1, 2)::text)), 5), 'QM020', 'new assessments use the new model: a score for a removed factor is refused');
  a3 := app.record_supplier_risk_assessment(s2, pg_temp.scores(m2, 2), 'First assessment of Bolt');
  PERFORM pg_temp.assert_eq((SELECT (model_version, review_on = (current_date + interval '6 months')::date)::text FROM public.supplier_risk_assessments WHERE id = a3), '(2,t)', 'it is stamped with version 2 and the new review interval');
  PERFORM pg_temp.assert_eq((SELECT model_version FROM public.supplier_risk_assessments WHERE id = a1), 1, 'earlier assessments keep the version they used');
  PERFORM pg_temp.assert_eq((SELECT jsonb_array_length(factors) FROM public.supplier_risk_assessments WHERE id = a2), 6, 'and every factor they were scored on');
  PERFORM pg_temp.logout();

  -- ---- another organisation: nothing crosses ----
  PERFORM pg_temp.login(eve);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.supplier_risk_assessments WHERE organisation_id = org) + (SELECT count(*) FROM public.supplier_risk_models WHERE organisation_id = org), 0::bigint, 'another organisation sees neither models nor assessments');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_supplier_risk_assessment(%L, %L::jsonb, 'Not yours to assess')$f$, s, pg_temp.scores(m1, 1)::text)), 5), 'P0002', 'it cannot assess a foreign supplier (as if it did not exist)');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.save_supplier_risk_model(%L, %L::jsonb, %L::jsonb, 6, 'Not yours either')$f$, org, fac::text, th::text)), 5), 'P0002', 'or change a foreign model');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.score_supplier_risk(%L, %L::jsonb)$f$, m1, pg_temp.scores(m1, 1)::text)), 5), 'P0002', 'or score against one');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) >= 4 FROM public.audit_events WHERE entity_type IN ('supplier_risk_models', 'supplier_risk_assessments')), true, 'models and assessments are audited');
END $$;
ROLLBACK;
