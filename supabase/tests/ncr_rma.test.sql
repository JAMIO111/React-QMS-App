-- RMA numbers for customer non-conformances: made only by the function, only for a customer NC, numbered per organisation and year, a disposition like
-- any other (quantity limits, approval), and the decision and number never change.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('4b000000-0000-0000-0000-000000000d01', 'owner@rma.test'), ('4b000000-0000-0000-0000-000000000d02', 'insp@rma.test'), ('4b000000-0000-0000-0000-000000000d03', 'other@rma.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  u_owner uuid := '4b000000-0000-0000-0000-000000000d01'; u_insp uuid := '4b000000-0000-0000-0000-000000000d02'; u_other uuid := '4b000000-0000-0000-0000-000000000d03';
  org uuid; org2 uuid; m uuid; cust uuid; nc uuid; nc_int uuid; d1 uuid; d2 uuid; d3 uuid; r text; yy text := to_char(current_date, 'YY');
BEGIN
  PERFORM pg_temp.login(u_other); org2 := app.create_organisation('RMA Other'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_owner);
  org := app.create_organisation('RMA Works', 'Plant A', 'PA', NULL);
  INSERT INTO public.customers (organisation_id, code, name) VALUES (org, 'ACME', 'Acme Ltd') RETURNING id INTO cust;
  INSERT INTO public.nonconformances (organisation_id, source, customer_id, title, severity, quantity_affected, description, stage, category_id)
    VALUES (org, 'customer', cust, 'Burrs on delivered brackets', 'major', 10, 'x', 'open', pg_temp.cat(org)) RETURNING id INTO nc;
  INSERT INTO public.nonconformances (organisation_id, source, title, severity, quantity_affected, description, stage, category_id)
    VALUES (org, 'internal', 'Found in house', 'minor', 5, 'x', 'open', pg_temp.cat(org)) RETURNING id INTO nc_int;
  PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u_insp, 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'viewer';

  PERFORM pg_temp.login(u_owner);
  -- only the function makes one
  r := pg_temp.fails(format($q$INSERT INTO public.ncr_dispositions (organisation_id, nonconformance_id, decision, quantity, instructions, reference) VALUES (%L, %L, 'customer_return', 1, 'x', 'RMA-MINE')$q$, org, nc));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM005', 'a customer return cannot be typed in: ' || r);
  r := pg_temp.fails(format('SELECT app.generate_ncr_rma(%L, 1)', nc_int));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM005', 'only for a customer non-conformance: ' || r);
  r := pg_temp.fails(format('SELECT app.generate_ncr_rma(%L, 0)', nc));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM005', 'a quantity is needed');

  d1 := app.generate_ncr_rma(nc, 4);
  PERFORM pg_temp.assert_eq((SELECT decision || '/' || reference || '/' || quantity || '/' || status || '/' || instructions FROM public.ncr_dispositions WHERE id = d1),
    'customer_return/RMA-' || yy || '-0001/4/proposed/Customer to return the parts under RMA-' || yy || '-0001', 'numbered, proposed, for part of the quantity');
  d2 := app.generate_ncr_rma(nc, 6, ' Return to goods-in, marked for quality ');
  PERFORM pg_temp.assert_eq((SELECT reference || '/' || instructions FROM public.ncr_dispositions WHERE id = d2), 'RMA-' || yy || '-0002/Return to goods-in, marked for quality', 'the next number, with the instructions given');
  r := pg_temp.fails(format('SELECT app.generate_ncr_rma(%L, 1)', nc));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM005', 'never above the quantity affected: ' || r);

  -- the decision and the number are fixed
  r := pg_temp.fails(format($q$UPDATE public.ncr_dispositions SET reference = 'RMA-OTHER' WHERE id = %L$q$, d1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM005', 'the number never changes');
  r := pg_temp.fails(format($q$UPDATE public.ncr_dispositions SET decision = 'scrap' WHERE id = %L$q$, d1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM005', 'nor the decision');
  UPDATE public.ncr_dispositions SET quantity = 3, instructions = 'Three only' WHERE id = d1;
  PERFORM pg_temp.assert_eq((SELECT quantity FROM public.ncr_dispositions WHERE id = d1), 3::numeric, 'the quantity and instructions can change while proposed');
  INSERT INTO public.ncr_dispositions (organisation_id, nonconformance_id, decision, quantity, instructions) VALUES (org, nc, 'scrap', 1, 'Scrap the one kept') RETURNING id INTO d3;
  r := pg_temp.fails(format($q$UPDATE public.ncr_dispositions SET decision = 'customer_return' WHERE id = %L$q$, d3));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM005', 'another disposition cannot become a customer return');

  -- approved and cancelled like any other; a cancelled number is not reused
  PERFORM app.approve_ncr_disposition(d1);
  PERFORM pg_temp.assert_eq((SELECT status FROM public.ncr_dispositions WHERE id = d1), 'approved', 'approved by an approver');
  PERFORM app.cancel_ncr_disposition(d2, 'Customer scrapped them on site');
  d3 := app.generate_ncr_rma(nc, 2);
  PERFORM pg_temp.assert_eq((SELECT reference FROM public.ncr_dispositions WHERE id = d3), 'RMA-' || yy || '-0003', 'a cancelled number is never given again');
  PERFORM pg_temp.logout();

  -- who may
  PERFORM pg_temp.login(u_insp);
  r := pg_temp.fails(format('SELECT app.generate_ncr_rma(%L, 1)', nc));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a reader cannot generate one: ' || r);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_other);
  r := pg_temp.fails(format('SELECT app.generate_ncr_rma(%L, 1)', nc));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'another organisation finds nothing');
  PERFORM pg_temp.logout();

  -- for SQL too
  r := pg_temp.fails(format($q$UPDATE public.ncr_dispositions SET reference = 'X' WHERE id = %L$q$, d2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM005', 'the number is fixed for SQL too');
END $$;

ROLLBACK;
