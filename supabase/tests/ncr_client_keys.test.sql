-- NC module audit API-13: a client key on a non-conformance, a cost line, a disposition and an RMA number. The key is unique per organisation, fixed once the
-- record is made, and the RMA function answers the record it already made for the same key (taking no second number) and refuses a key used elsewhere.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES ('5c000000-0000-0000-0000-000000000e01', 'owner@keys.test'), ('5c000000-0000-0000-0000-000000000e02', 'other@keys.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  u_owner uuid := '5c000000-0000-0000-0000-000000000e01'; u_other uuid := '5c000000-0000-0000-0000-000000000e02';
  org uuid; org2 uuid; cust uuid; nc uuid; nc2 uuid; d1 uuid; d2 uuid; r text; yy text := to_char(current_date, 'YY'); n_before integer;
BEGIN
  PERFORM pg_temp.login(u_other); org2 := app.create_organisation('Keys Other'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_owner);
  org := app.create_organisation('Keys Works', 'Plant A', 'PA', NULL);
  INSERT INTO public.customers (organisation_id, code, name) VALUES (org, 'ACME', 'Acme Ltd') RETURNING id INTO cust;
  INSERT INTO public.nonconformances (organisation_id, source, customer_id, title, severity, quantity_affected, description, stage, category_id, client_key)
    VALUES (org, 'customer', cust, 'Burrs on brackets', 'major', 20, 'x', 'open', pg_temp.cat(org), 'nc-key-0001') RETURNING id INTO nc;
  INSERT INTO public.nonconformances (organisation_id, source, customer_id, title, severity, quantity_affected, description, stage, category_id)
    VALUES (org, 'customer', cust, 'No key', 'major', 20, 'x', 'open', pg_temp.cat(org)) RETURNING id INTO nc2;

  -- one non-conformance per key in an organisation; any number with none
  r := pg_temp.fails(format($q$INSERT INTO public.nonconformances (organisation_id, source, title, client_key) VALUES (%L, 'internal', 'Twice', 'nc-key-0001')$q$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), '23505', 'a key makes one non-conformance: ' || r);
  r := pg_temp.fails(format($q$INSERT INTO public.nonconformances (organisation_id, source, title, client_key) VALUES (%L, 'internal', 'Short key', 'short')$q$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), '23514', 'a key is 8 to 100 characters: ' || r);
  INSERT INTO public.nonconformances (organisation_id, source, title) VALUES (org, 'internal', 'Plain one'), (org, 'internal', 'Plain two');

  -- the key is written when the record is made and never changed
  r := pg_temp.fails(format($q$UPDATE public.nonconformances SET client_key = 'nc-key-9999' WHERE id = %L$q$, nc));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'the key cannot be changed: ' || r);

  -- cost lines and dispositions: the same per-organisation rule
  INSERT INTO public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, unit_cost, client_key) VALUES (org, nc, 'scrap', 'GBP', 5, 'cost-key-01');
  r := pg_temp.fails(format($q$INSERT INTO public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, unit_cost, client_key) VALUES (%L, %L, 'scrap', 'GBP', 5, 'cost-key-01')$q$, org, nc));
  PERFORM pg_temp.assert_eq(left(r, 5), '23505', 'a key makes one cost line: ' || r);
  INSERT INTO public.ncr_dispositions (organisation_id, nonconformance_id, decision, quantity, instructions, client_key) VALUES (org, nc, 'scrap', 1, 'Scrap one', 'disp-key-01');
  r := pg_temp.fails(format($q$INSERT INTO public.ncr_dispositions (organisation_id, nonconformance_id, decision, quantity, instructions, client_key) VALUES (%L, %L, 'scrap', 1, 'Again', 'disp-key-01')$q$, org, nc));
  PERFORM pg_temp.assert_eq(left(r, 5), '23505', 'a key makes one disposition: ' || r);

  -- RMA: the old four-argument function is gone, the new one answers the same disposition for the same key and takes no second number
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'app' AND p.proname = 'generate_ncr_rma'), 1, 'one RMA function');
  d1 := app.generate_ncr_rma(nc, 4, NULL, NULL, 'rma-key-0001');
  PERFORM pg_temp.assert_eq((SELECT reference || '/' || client_key FROM public.ncr_dispositions WHERE id = d1), 'RMA-' || yy || '-0001/rma-key-0001', 'numbered, with the key kept');
  d2 := app.generate_ncr_rma(nc, 4, NULL, NULL, 'rma-key-0001');
  PERFORM pg_temp.assert_eq(d2, d1, 'the same key answers the same disposition');
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.ncr_dispositions WHERE nonconformance_id = nc AND decision = 'customer_return'), 1, 'one RMA, not two');
  d2 := app.generate_ncr_rma(nc, 4);
  PERFORM pg_temp.assert_eq((SELECT reference FROM public.ncr_dispositions WHERE id = d2), 'RMA-' || yy || '-0002', 'no number was burnt by the retry');
  r := pg_temp.fails(format($q$SELECT app.generate_ncr_rma(%L, 1, NULL, NULL, 'rma-key-0001')$q$, nc2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM005', 'a key used for another non-conformance is refused: ' || r);
  PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM public.ncr_dispositions WHERE nonconformance_id = nc2), 0, 'and nothing was made there');

  -- not callable by people outside (anon) and checked for the caller: another organisation's person cannot use it on this NC
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_other);
  r := pg_temp.fails(format($q$SELECT app.generate_ncr_rma(%L, 1, NULL, NULL, 'rma-key-0001')$q$, nc));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'another organisation cannot see it: ' || r);
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
