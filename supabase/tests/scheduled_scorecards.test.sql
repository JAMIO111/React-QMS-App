-- Scheduled supplier scorecards (SQ5b): monthly, quarterly and annual switched on separately, scope (every supplier or chosen classifications), one scorecard
-- per supplier, kind and period, saved by the schedule with the authority of whoever set it, catch-up, a fallen band announced once, isolation.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('5b000000-0000-0000-0000-000000000a01', 'ann@ss.test'), ('5b000000-0000-0000-0000-000000000a02', 'bob@ss.test'), ('5b000000-0000-0000-0000-000000000a03', 'eve@ss.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '5b000000-0000-0000-0000-000000000a01'; bob uuid := '5b000000-0000-0000-0000-000000000a02'; eve uuid := '5b000000-0000-0000-0000-000000000a03';
  org uuid; org2 uuid; s uuid; s2 uuid; s3 uuid; role_id uuid; cls uuid; cls2 uuid; r jsonb; m0 date; last_month date; sch public.supplier_scorecard_schedules%ROWTYPE;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('SS Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('SS Beta'); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, bob, 'active');
  SELECT id INTO role_id FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, ou.id, role_id FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id = bob;
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'ACME', 'Acme Metals') RETURNING id INTO s;
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'BOLT', 'Bolt Co') RETURNING id INTO s2;
  INSERT INTO public.suppliers (organisation_id, code, name, active) VALUES (org, 'GONE', 'Gone Ltd', false) RETURNING id INTO s3;
  SELECT id INTO cls FROM public.supplier_classifications WHERE organisation_id = org ORDER BY sequence LIMIT 1;
  SELECT id INTO cls2 FROM public.supplier_classifications WHERE organisation_id = org2 ORDER BY sequence LIMIT 1;
  INSERT INTO public.supplier_classification_links (organisation_id, supplier_id, classification_id) VALUES (org, s, cls);
  m0 := (now() AT TIME ZONE app.organisation_time_zone(org))::date;
  last_month := date_trunc('month', m0)::date - interval '1 month';

  -- ---- the periods ----
  PERFORM pg_temp.assert_eq(app.scorecard_last_finished('monthly', '2026-11-13'), '2026-10-01'::date, 'the month that last ended');
  PERFORM pg_temp.assert_eq(app.scorecard_last_finished('quarterly', '2026-11-13'), '2026-07-01'::date, 'the quarter that last ended');
  PERFORM pg_temp.assert_eq(app.scorecard_last_finished('annual', '2026-01-01'), '2025-01-01'::date, 'the year that last ended, on New Year''s day');
  PERFORM pg_temp.assert_eq(app.scorecard_period_end('quarterly', '2026-10-01'), '2026-12-31'::date, 'a quarter ends on its last day');
  PERFORM pg_temp.assert_eq(app.scorecard_period_end('annual', '2024-01-01'), '2024-12-31'::date, 'a leap year too');

  -- ---- setting the schedule ----
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.set_supplier_scorecard_schedule(%L, '{"monthly":true}')$f$, org)), 5), '42501', 'a viewer cannot set the schedule');
  PERFORM pg_temp.logout(); PERFORM pg_temp.login(ann);
  PERFORM app.set_supplier_scorecard_schedule(org, '{"monthly":true}');
  SELECT * INTO sch FROM public.supplier_scorecard_schedules WHERE organisation_id = org;
  PERFORM pg_temp.assert_eq((sch.monthly, sch.quarterly, sch.annual)::text, '(t,f,f)', 'monthly is on, the others stay off');
  PERFORM pg_temp.assert_eq(sch.monthly_next, last_month, 'it starts with the month that last ended');
  PERFORM pg_temp.assert_eq(sch.set_by, ann, 'and remembers whose authority it uses');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.set_supplier_scorecard_schedule(%L, '{"scope":"classifications","classificationIds":[]}')$f$, org)), 5), 'QM020', 'chosen classifications need at least one');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.set_supplier_scorecard_schedule(%L, '{"scope":"classifications","classificationIds":["%s"]}')$f$, org, cls2)), 5), 'QM020', 'and another organisation''s are refused');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.set_supplier_scorecard_schedule(%L, '{"monthly":"yes"}')$f$, org)), 5), 'QM020', 'on or off is true or false');
  PERFORM pg_temp.assert_fails(format($f$UPDATE public.supplier_scorecard_schedules SET annual = true WHERE organisation_id = %L$f$, org), 'nothing writes the schedule directly');
  PERFORM pg_temp.logout();

  -- ---- the worker saves last month for every supplier in use ----
  r := app.system_run_scheduled_scorecards(100);
  PERFORM pg_temp.assert_eq((r ->> 'saved')::int, 2, 'two suppliers in use get a scorecard (the inactive one does not)');
  PERFORM pg_temp.assert_eq(pg_temp.count_rows(format($q$SELECT 1 FROM public.supplier_scorecards WHERE organisation_id = %L AND period_kind = 'monthly' AND period_from = %L
                                                         AND period_to = %L AND created_by IS NULL$q$, org, last_month, app.scorecard_period_end('monthly', last_month))), 2::bigint,
                            'for the whole month, saved by the schedule (nobody)');
  PERFORM pg_temp.assert_eq((SELECT monthly_next FROM public.supplier_scorecard_schedules WHERE organisation_id = org), (last_month + interval '1 month')::date, 'the next month waits until it ends');
  r := app.system_run_scheduled_scorecards(100);
  PERFORM pg_temp.assert_eq((r ->> 'saved')::int, 0, 'running again saves nothing twice');
  PERFORM pg_temp.assert_fails(format($f$INSERT INTO public.supplier_scorecards (organisation_id, supplier_id, period_from, period_to, period_kind, model_id, model_version, config, metrics, components, band)
                                         SELECT organisation_id, supplier_id, period_from, period_to, period_kind, model_id, model_version, config, metrics, components, band FROM public.supplier_scorecards
                                          WHERE organisation_id = %L AND period_kind = 'monthly' LIMIT 1$f$, org), 'one scheduled scorecard per supplier, kind and period, even for SQL');

  -- ---- quarterly and annual, separately, for one classification ----
  PERFORM pg_temp.login(ann);
  PERFORM app.set_supplier_scorecard_schedule(org, jsonb_build_object('quarterly', true, 'annual', true, 'scope', 'classifications', 'classificationIds', jsonb_build_array(cls)));
  PERFORM pg_temp.logout();
  r := app.system_run_scheduled_scorecards(100);
  PERFORM pg_temp.assert_eq((r ->> 'saved')::int, 2, 'a quarter and a year, for the one supplier holding the classification');
  PERFORM pg_temp.assert_eq(pg_temp.count_rows(format($q$SELECT 1 FROM public.supplier_scorecards WHERE supplier_id = %L AND period_kind IN ('quarterly', 'annual')$q$, s2)), 0::bigint, 'the other supplier gets none');
  PERFORM pg_temp.assert_eq((SELECT period_to - period_from FROM public.supplier_scorecards WHERE supplier_id = s AND period_kind = 'annual'),
                            app.scorecard_period_end('annual', app.scorecard_last_finished('annual', m0)) - app.scorecard_last_finished('annual', m0), 'the annual one covers the whole year');
  PERFORM pg_temp.login(ann);
  PERFORM app.set_supplier_scorecard_schedule(org, '{"quarterly":false}');
  PERFORM pg_temp.assert_eq((SELECT (monthly, quarterly, annual)::text FROM public.supplier_scorecard_schedules WHERE organisation_id = org), '(t,f,t)', 'each kind switches off on its own');
  PERFORM pg_temp.logout();

  -- ---- catch-up and a fallen band (scoring stubbed so the bands are known: good two months back and before, poor after) ----
  EXECUTE format($f$CREATE OR REPLACE FUNCTION app.supplier_performance(p_supplier uuid, p_from date, p_to date) RETURNS jsonb LANGUAGE sql SET search_path = '' AS $b$
    SELECT jsonb_build_object('model', jsonb_build_object('id', m.id, 'version', m.version, 'config', m.config), 'metrics', '{}'::jsonb, 'components', '[]'::jsonb, 'warnings', '[]'::jsonb,
                              'score', CASE WHEN p_from < %L THEN 90 ELSE 20 END, 'band', CASE WHEN p_from < %L THEN 'good' ELSE 'poor' END)
      FROM public.suppliers s JOIN public.supplier_scorecard_models m ON m.organisation_id = s.organisation_id WHERE s.id = p_supplier ORDER BY m.version DESC LIMIT 1 $b$ $f$,
    last_month - interval '1 month', last_month - interval '1 month');
  UPDATE public.supplier_scorecard_schedules SET monthly_next = last_month - interval '2 months' WHERE organisation_id = org;
  r := app.system_run_scheduled_scorecards(1);
  PERFORM pg_temp.assert_eq((r ->> 'saved')::int, 1, 'a call saves at most its limit');
  r := app.system_run_scheduled_scorecards(100);
  PERFORM pg_temp.assert_eq((r ->> 'saved')::int, 1, 'and the next carries on: two missed months for the one supplier in scope');
  PERFORM pg_temp.assert_eq(pg_temp.count_rows(format($q$SELECT 1 FROM public.supplier_scorecards WHERE supplier_id = %L AND period_kind = 'monthly'$q$, s)), 3::bigint, 'three months are kept, last month not saved twice');
  PERFORM pg_temp.assert_eq(pg_temp.count_rows(format('SELECT 1 FROM public.supplier_band_drops WHERE supplier_id = %L', s)), 1::bigint, 'good → poor is announced once');
  PERFORM pg_temp.assert_eq((SELECT change_label FROM public.supplier_band_drops WHERE supplier_id = s), 'Good → Poor (' || to_char(last_month - interval '1 month', 'FMMonth YYYY') || ')', 'in words');
  PERFORM pg_temp.assert_eq(pg_temp.count_rows(format($q$SELECT 1 FROM public.notifications WHERE organisation_id = %L AND entity_type = 'supplier_band_drops'
                                                         AND details ->> 'record_id' = %L AND actor_user_id IS NULL$q$, org, s)), 1::bigint, 'as a notice that leads to the supplier, from no one');
  PERFORM pg_temp.assert_fails(format($f$UPDATE public.supplier_band_drops SET to_band = 'watch' WHERE supplier_id = %L$f$, s), 'a band drop never changes');

  -- ---- the authority lent to the schedule ----
  UPDATE public.supplier_scorecard_schedules SET set_by = eve, monthly_next = last_month - interval '4 months' WHERE organisation_id = org;
  r := app.system_run_scheduled_scorecards(100);
  PERFORM pg_temp.assert_eq((r ->> 'saved')::int, 0, 'nothing is saved when the person who set it is no longer a member');
  PERFORM pg_temp.assert_eq((SELECT problem IS NOT NULL FROM public.supplier_scorecard_schedules WHERE organisation_id = org), true, 'and the schedule says why');
  PERFORM pg_temp.login(ann);
  PERFORM app.set_supplier_scorecard_schedule(org, '{}');
  PERFORM pg_temp.assert_eq((SELECT (problem IS NULL AND set_by = ann) FROM public.supplier_scorecard_schedules WHERE organisation_id = org), true, 'saving it again lends a new authority');
  PERFORM pg_temp.logout();

  -- ---- isolation ----
  PERFORM pg_temp.login(eve);
  PERFORM pg_temp.assert_eq(pg_temp.count_rows('SELECT 1 FROM public.supplier_scorecard_schedules'), 0::bigint, 'another organisation cannot read the schedule');
  PERFORM pg_temp.assert_eq(pg_temp.count_rows('SELECT 1 FROM public.supplier_band_drops'), 0::bigint, 'or the band drops');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.set_supplier_scorecard_schedule(%L, '{"monthly":true}')$f$, org)), 5), 'P0002', 'or set it');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq(pg_temp.count_rows('SELECT 1 FROM public.supplier_scorecard_schedules'), 1::bigint, 'a reader of supplier quality sees the schedule');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
