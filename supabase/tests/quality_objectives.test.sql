-- Management review MR1: quality objectives and their values — permissions, the fixed system measures, periods, owners recording values, corrections, tenancy.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('5a000000-0000-0000-0000-000000000c01', 'ann@mr1.test'), ('5a000000-0000-0000-0000-000000000c02', 'bob@mr1.test'),
  ('5a000000-0000-0000-0000-000000000c03', 'eve@mr1.test'), ('5a000000-0000-0000-0000-000000000c04', 'cat@mr1.test'),
  ('5a000000-0000-0000-0000-000000000c05', 'dan@mr1.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '5a000000-0000-0000-0000-000000000c01'; bob uuid := '5a000000-0000-0000-0000-000000000c02'; eve uuid := '5a000000-0000-0000-0000-000000000c03';
  cat uuid := '5a000000-0000-0000-0000-000000000c04'; dan uuid := '5a000000-0000-0000-0000-000000000c05';
  org uuid; org2 uuid; q uuid; s uuid; v1 uuid; v2 uuid; r text; u uuid; this_month date := date_trunc('month', current_date)::date;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('MR1 Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('MR1 Beta'); PERFORM pg_temp.logout();
  -- Bob: viewer. Cat: quality engineer (reads). Dan: inspector (neither).
  FOREACH u IN ARRAY ARRAY[bob, cat, dan] LOOP INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u, 'active'); END LOOP;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = CASE ou.user_id WHEN cat THEN 'quality_engineer' WHEN dan THEN 'inspector' ELSE 'viewer' END)
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id IN (bob, cat, dan);

  -- ---- permissions ----
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'management_review.manage'), false, 'nobody signed in holds nothing');
  PERFORM pg_temp.login(cat);
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'management_review.read') AND NOT app.has_permission(org, 'management_review.manage'), true, 'a quality engineer reads');
  r := pg_temp.fails(format($f$SELECT app.save_quality_objective(%L, '{"title":"x","target":1}'::jsonb)$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'and does not define objectives');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(dan);
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'management_review.read'), false, 'an inspector does not read management reviews');
  PERFORM pg_temp.logout();

  -- ---- a manual objective ----
  PERFORM pg_temp.login(ann);
  r := pg_temp.fails(format($f$SELECT app.save_quality_objective(%L, '{"title":"x"}'::jsonb)$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM027', 'a target is needed');
  r := pg_temp.fails(format($f$SELECT app.save_quality_objective(%L, '{"title":"x","target":"5"}'::jsonb)$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM027', 'the target is a number');
  r := pg_temp.fails(format($f$SELECT app.save_quality_objective(%L, jsonb_build_object('title', 'x', 'target', 1, 'ownerId', %L))$f$, org, eve));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM027', 'the owner is a member of this organisation');
  r := pg_temp.fails(format($f$SELECT app.save_quality_objective(%L, '{"title":"x","target":1,"measure":"made_up"}'::jsonb)$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM027', 'only the fixed measures');
  q := app.save_quality_objective(org, jsonb_build_object('title', ' Customer complaints answered within 5 days ', 'target', 95, 'unit', '%', 'direction', 'at_least',
                                                         'ownerId', dan, 'frequency', 'quarterly', 'startsOn', (current_date - 200)::text));
  PERFORM pg_temp.assert_eq((SELECT reference || '|' || title || '|' || measure || '|' || frequency || '|' || (starts_on = date_trunc('quarter', current_date - 200)::date)::text
                               FROM public.quality_objectives WHERE id = q), 'QO-001|Customer complaints answered within 5 days|manual|quarterly|true', 'numbered, trimmed, the first period aligned');

  -- ---- a system measure: unit and direction are its own ----
  r := pg_temp.fails(format($f$SELECT app.save_quality_objective(%L, '{"title":"Supplier PPM","target":500,"measure":"supplier_ppm","direction":"at_least"}'::jsonb)$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM027', 'a system measure keeps its own direction');
  r := pg_temp.fails(format($f$SELECT app.save_quality_objective(%L, '{"title":"8Ds on time","target":120,"measure":"capa_on_time"}'::jsonb)$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM027', 'a percentage is 0 to 100');
  s := app.save_quality_objective(org, '{"title":"Supplier PPM","target":500,"measure":"supplier_ppm"}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT reference || '|' || unit || '|' || direction || '|' || frequency || '|' || (owner_user_id = ann)::text FROM public.quality_objectives WHERE id = s),
                            'QO-002|PPM|at_most|monthly|true', 'PPM: at most, monthly by default, owned by whoever defined it');
  r := pg_temp.fails(format($f$SELECT app.record_quality_objective_value(%L, current_date, 10)$f$, s));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM027', 'a system measure takes no typed values');

  -- ---- what is fixed ----
  r := pg_temp.fails(format($f$SELECT app.save_quality_objective(%L, '{"frequency":"yearly"}'::jsonb, %L)$f$, org, q));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM027', 'the frequency is fixed');
  PERFORM app.save_quality_objective(org, '{"target":90,"description":"Measured from the complaints log"}'::jsonb, q);
  PERFORM pg_temp.assert_eq((SELECT target FROM public.quality_objectives WHERE id = q), 90::numeric, 'the target can change');
  r := pg_temp.fails(format('UPDATE public.quality_objectives SET measure = %L WHERE id = %L', 'ncr_count', q));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'nobody writes the table directly');
  PERFORM pg_temp.logout();
  r := pg_temp.fails(format('UPDATE public.quality_objectives SET measure = %L WHERE id = %L', 'ncr_count', q));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM027', 'even SQL cannot change the measure');
  r := pg_temp.fails(format('DELETE FROM public.quality_objectives WHERE id = %L', q));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM027', 'nor delete an objective');

  -- ---- values: the owner records them ----
  PERFORM pg_temp.login(dan);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.quality_objectives WHERE organisation_id = org), 1::bigint, 'the owner without the permission reads only their own objective');
  r := pg_temp.fails(format($f$SELECT app.record_quality_objective_value(%L, current_date + 100, 92)$f$, q));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM027', 'not a period that has not started');
  r := pg_temp.fails(format($f$SELECT app.record_quality_objective_value(%L, current_date - 400, 92)$f$, q));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM027', 'not before the first period');
  v1 := app.record_quality_objective_value(q, current_date, 92);
  PERFORM pg_temp.assert_eq((SELECT period_start FROM public.quality_objective_values WHERE id = v1), date_trunc('quarter', current_date)::date, 'any day stands for its quarter');
  r := pg_temp.fails(format($f$SELECT app.record_quality_objective_value(%L, current_date, 93)$f$, q));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM027', 'a second value for the period is a correction and needs a note');
  v2 := app.record_quality_objective_value(q, current_date, 93, 'Two late answers were logged twice');
  PERFORM pg_temp.assert_eq((SELECT string_agg(value::text || ':' || status, ',' ORDER BY value) FROM public.quality_objective_values WHERE objective_id = q),
                            '92.0000:superseded,93.0000:current', 'the correction supersedes; both are kept');
  PERFORM pg_temp.assert_eq((SELECT supersedes_id FROM public.quality_objective_values WHERE id = v2), v1, 'and names what it replaced');
  PERFORM pg_temp.logout();
  r := pg_temp.fails(format('UPDATE public.quality_objective_values SET value = 1 WHERE id = %L', v2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM027', 'a value is never edited');
  r := pg_temp.fails(format('DELETE FROM public.quality_objective_values WHERE id = %L', v1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM027', 'nor deleted');

  -- Someone else who only reads cannot record.
  PERFORM pg_temp.login(cat);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.quality_objectives WHERE organisation_id = org), 2::bigint, 'a reader sees every objective');
  r := pg_temp.fails(format($f$SELECT app.record_quality_objective_value(%L, current_date, 50, 'x')$f$, q));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'but records no values');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.quality_objective_values WHERE organisation_id = org), 0::bigint, 'a viewer sees no values');
  PERFORM pg_temp.logout();

  -- ---- retiring ----
  PERFORM pg_temp.login(ann);
  r := pg_temp.fails(format('SELECT app.retire_quality_objective(%L, %L)', q, 'x'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM027', 'retiring needs a reason');
  PERFORM app.retire_quality_objective(q, 'Replaced by the customer survey');
  r := pg_temp.fails(format($f$SELECT app.record_quality_objective_value(%L, current_date, 95, 'late')$f$, q));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM027', 'a retired objective takes no values');
  r := pg_temp.fails(format($f$SELECT app.save_quality_objective(%L, '{"target":80}'::jsonb, %L)$f$, org, q));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM027', 'nor changes');
  PERFORM app.reactivate_quality_objective(q);
  PERFORM pg_temp.assert_eq((SELECT active AND retired_reason IS NULL FROM public.quality_objectives WHERE id = q), true, 'brought back');
  PERFORM pg_temp.logout();

  -- ---- another organisation ----
  PERFORM pg_temp.login(eve);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.quality_objectives WHERE organisation_id = org), 0::bigint, 'another organisation sees none');
  r := pg_temp.fails(format($f$SELECT app.record_quality_objective_value(%L, current_date, 1, 'x')$f$, q));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'and cannot record one');
  r := pg_temp.fails(format($f$SELECT app.save_quality_objective(%L, '{"target":1}'::jsonb, %L)$f$, org2, q));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'nor change one through its own organisation');
  u := app.save_quality_objective(org2, '{"title":"Own","target":1}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT reference FROM public.quality_objectives WHERE id = u), 'QO-001', 'numbers are per organisation');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.assert_eq((SELECT count(*) FROM audit.events WHERE entity_type IN ('quality_objectives', 'quality_objective_values') AND organisation_id = org) > 0, true, 'audited');
  PERFORM pg_temp.assert_eq(this_month <= current_date, true, 'sanity');
END $$;

ROLLBACK;
