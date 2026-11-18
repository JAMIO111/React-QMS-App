-- External portal PT4 (docs/external-portal-plan.md): a supplier's people see their own performance — the Performance tab's figures, named fields only,
-- in the tiles staff chose — and nothing else; the ranking is a quarter and only with five scored suppliers.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
  ('5e000000-0000-0000-0000-000000000f01', 'ann@pt4.test', now()), ('5e000000-0000-0000-0000-000000000f04', 'sam@acme.pt4.test', now()),
  ('5e000000-0000-0000-0000-000000000f05', 'ben@bolt.pt4.test', now()), ('5e000000-0000-0000-0000-000000000f07', 'cat@pt4.test', now());

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '5e000000-0000-0000-0000-000000000f01'; sam uuid := '5e000000-0000-0000-0000-000000000f04'; ben uuid := '5e000000-0000-0000-0000-000000000f05';
  cat uuid := '5e000000-0000-0000-0000-000000000f07';
  org uuid; acme uuid; bolt uuid; p_acme uuid; p_bolt uuid; a_sam uuid; a_ben uuid; j jsonb; r text; k text; expected text; staff jsonb;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('PT4 Alpha'); PERFORM pg_temp.logout();
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'ACME', 'Acme Castings'), (org, 'BOLT', 'Bolt Ltd');
  SELECT id INTO acme FROM public.suppliers WHERE organisation_id = org AND code = 'ACME';
  SELECT id INTO bolt FROM public.suppliers WHERE organisation_id = org AND code = 'BOLT';
  PERFORM pg_temp.login(ann);
  PERFORM app.set_portal_settings(org, true, NULL, false);
  p_acme := app.set_portal_party(org, 'supplier', acme, true, 'Pat in Quality');
  p_bolt := app.set_portal_party(org, 'supplier', bolt, true);
  a_sam := app.invite_external_user(p_acme, 'sam@acme.pt4.test', 'admin', NULL);
  a_ben := app.invite_external_user(p_bolt, 'ben@bolt.pt4.test', 'admin', NULL);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(sam); PERFORM app.accept_portal_invitation(a_sam); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ben); PERFORM app.accept_portal_invitation(a_ben); PERFORM pg_temp.logout();

  -- ---- the supplier sees its own, with named fields only ----
  PERFORM pg_temp.login(sam);
  j := app.portal_get_performance(org, p_acme, 90);
  SELECT string_agg(x, ',' ORDER BY x) INTO k FROM jsonb_object_keys(j) x;
  PERFORM pg_temp.assert_eq(k, 'certs,delivery,ncs,period,quality,scars,score,tiles,trend', 'the figures a supplier gets, and nothing else (no ranking while it is off)');
  SELECT string_agg(x, ',' ORDER BY x) INTO k FROM jsonb_object_keys(j -> 'delivery') x;
  PERFORM pg_temp.assert_eq(k, 'inFull,onTime,otif', 'delivery keys');
  SELECT string_agg(x, ',' ORDER BY x) INTO k FROM jsonb_object_keys(j -> 'quality') x;
  PERFORM pg_temp.assert_eq(k, 'lotRejection,ppm,ppmNc', 'quality keys');
  SELECT string_agg(x, ',' ORDER BY x) INTO k FROM jsonb_object_keys(j -> 'quality' -> 'ppm') x;
  PERFORM pg_temp.assert_eq(k, 'receivedUnits,rejectedUnits,value', 'no records behind the figures are named (no sources)');
  SELECT string_agg(x, ',' ORDER BY x) INTO k FROM jsonb_object_keys(j -> 'ncs') x;
  PERFORM pg_temp.assert_eq(k, 'critical,major,minor,repeat,total', 'NC counts by severity only');
  SELECT string_agg(x, ',' ORDER BY x) INTO k FROM jsonb_object_keys(j -> 'scars') x;
  PERFORM pg_temp.assert_eq(k, 'answeredLate,answeredOnTime,awaitingYou,issued,overdueNow', 'SCAR keys');
  PERFORM pg_temp.assert_eq(j -> 'score' ->> 'band', 'insufficient', 'with no deliveries there is no score yet');
  PERFORM pg_temp.assert_eq((j -> 'period' ->> 'days')::int, 90, 'the period asked for');
  r := pg_temp.fails($f$SELECT 1 FROM public.supplier_scorecards$f$);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.supplier_scorecards), 0::bigint, 'the person reads no tables: scorecards are invisible to them');
  r := pg_temp.fails(format($f$SELECT app.supplier_performance(%L, current_date - 30, current_date)$f$, acme));
  PERFORM pg_temp.assert_eq(left(r, 5) IN ('P0002', '42501'), true, 'the staff function still refuses an outsider');
  r := pg_temp.fails(format($f$SELECT app.portal_get_performance(%L, %L, 90)$f$, org, p_bolt));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'another supplier is not theirs');
  r := pg_temp.fails(format($f$SELECT app.portal_get_performance(%L, %L, 45)$f$, org, p_acme));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM032', 'only 30, 90 or 365 days');
  PERFORM pg_temp.assert_eq(coalesce(current_setting('app.portal_performance', true), ''), '', 'the gate is closed again afterwards');
  PERFORM pg_temp.logout();

  -- ---- a person with no portal access gets nothing ----
  PERFORM pg_temp.login(cat);
  r := pg_temp.fails(format($f$SELECT app.portal_get_performance(%L, %L, 90)$f$, org, p_acme));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'a stranger sees nothing');
  PERFORM pg_temp.logout();

  -- ---- staff choose the tiles; a switched-off tile is left out by the database ----
  PERFORM pg_temp.login(ann);
  PERFORM app.set_portal_party(org, 'supplier', acme, NULL, NULL, '{"delivery": false, "ncs": false, "trend": false}'::jsonb);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(sam);
  j := app.portal_get_performance(org, p_acme, 30);
  SELECT string_agg(x, ',' ORDER BY x) INTO k FROM jsonb_object_keys(j) x;
  PERFORM pg_temp.assert_eq(k, 'certs,period,quality,scars,score,tiles', 'delivery, NCs and the trend are gone');
  PERFORM pg_temp.logout();

  -- ---- ranking: off by default, on only when the organisation says so, and a band needs five scored suppliers ----
  PERFORM pg_temp.login(ann);
  PERFORM app.set_portal_settings(org, NULL, true, NULL);
  PERFORM app.set_portal_party(org, 'supplier', acme, NULL, NULL, '{}'::jsonb);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(sam);
  j := app.portal_get_performance(org, p_acme, 90);
  PERFORM pg_temp.assert_eq((j -> 'ranking' ->> 'enough')::boolean, false, 'two suppliers are not enough to rank');
  PERFORM pg_temp.assert_eq(j -> 'ranking' -> 'band' = 'null'::jsonb, true, 'and no band is given');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ann);
  PERFORM app.set_portal_party(org, 'supplier', acme, NULL, NULL, '{"ranking": false}'::jsonb);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(sam);
  PERFORM pg_temp.assert_eq(app.portal_get_performance(org, p_acme, 90) ? 'ranking', false, 'staff can switch the ranking off for one supplier');
  PERFORM pg_temp.logout();

  -- ---- the band itself ----
  PERFORM pg_temp.assert_eq(app.portal_rank_band(90, ARRAY[90, 80, 70, 60, 50]::numeric[]), 'top_quarter', 'the best of five');
  PERFORM pg_temp.assert_eq(app.portal_rank_band(80, ARRAY[90, 80, 70, 60, 50]::numeric[]), 'top_quarter', 'second of five (one in five is better)');
  PERFORM pg_temp.assert_eq(app.portal_rank_band(70, ARRAY[90, 80, 70, 60, 50]::numeric[]), 'upper_half', 'third of five');
  PERFORM pg_temp.assert_eq(app.portal_rank_band(60, ARRAY[90, 80, 70, 60, 50]::numeric[]), 'lower_half', 'fourth of five');
  PERFORM pg_temp.assert_eq(app.portal_rank_band(50, ARRAY[90, 80, 70, 60, 50]::numeric[]), 'bottom_quarter', 'the last of five');
  PERFORM pg_temp.assert_eq(app.portal_rank_band(90, ARRAY[90, 80, 70, 60]::numeric[]) IS NULL, true, 'four are not enough');
  PERFORM pg_temp.assert_eq(app.portal_rank_band(NULL, ARRAY[90, 80, 70, 60, 50]::numeric[]) IS NULL, true, 'an unscored supplier has no band');
  PERFORM pg_temp.assert_eq(app.portal_rank_band(80, ARRAY[80, 80, 80, 80, 80]::numeric[]), 'top_quarter', 'ties do not push anyone down');
END $$;

ROLLBACK;
