-- NC module audit, medium findings in the database (docs/audit-nc-2026-11.md): DB-3 the NC row lock taken by writes to dispositions, containment
-- and affected lots, DB-4 a part change checked against the order, lot, serial number and affected lots, API-6 the reporting dataset moves when a
-- cost line is deleted. (DB-5 is in inspection_ncr_add_readings.test.sql.)
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('3a000000-0000-0000-0000-000000000501', 'owner@med.test'), ('3a000000-0000-0000-0000-000000000502', 'engineer@med.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  u_owner uuid := '3a000000-0000-0000-0000-000000000501'; u_eng uuid := '3a000000-0000-0000-0000-000000000502';
  org uuid; m uuid; p1 uuid; p2 uuid; lot1 uuid; lot_p2 uuid; ord uuid; s1 uuid; nc uuid; nc_plain uuid; nc_cost uuid; c1 uuid; r text; v1 timestamptz; v2 timestamptz;
  mk text := $f$INSERT INTO public.nonconformances (organisation_id, source, title, severity, quantity_affected, description, stage, part_id, category_id) VALUES (%L, 'internal', %L, 'minor', 10, 'x', 'open', %L, (SELECT id FROM public.ncr_classifications WHERE organisation_id = %1$L AND kind = 'category' AND code = 'PRODUCT')) RETURNING id$f$;
BEGIN
  PERFORM pg_temp.login(u_owner);
  org := app.create_organisation('Medium Works', 'Plant A', 'PA', NULL);
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'MD-100', 'Rod') RETURNING id INTO p1;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'MD-200', 'Other rod') RETURNING id INTO p2;
  INSERT INTO public.lots (organisation_id, lot_number, part_id, origin, quantity) VALUES (org, 'LOT-1', p1, 'produced', 100) RETURNING id INTO lot1;
  INSERT INTO public.lots (organisation_id, lot_number, part_id, origin, quantity) VALUES (org, 'LOT-P2', p2, 'produced', 100) RETURNING id INTO lot_p2;
  INSERT INTO public.production_orders (organisation_id, order_number, part_id, quantity_planned) VALUES (org, 'WO-1', p1, 50) RETURNING id INTO ord;
  INSERT INTO public.serial_numbers (organisation_id, serial_number, part_id, lot_id) VALUES (org, 'S-1', p1, lot1) RETURNING id INTO s1;
  EXECUTE format(mk, org, 'Locked by its children', p1) INTO nc;
  EXECUTE format(mk, org, 'Plain', p1) INTO nc_plain;
  EXECUTE format(mk, org, 'With cost', p1) INTO nc_cost;
  PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u_eng, 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'quality_engineer';

  -- ---- DB-3: a write to any of the three tables takes the NC's row lock first. A row lock cannot be told from the foreign key's own key-share lock in
  -- one session, and the race needs two sessions, so this checks what makes it happen: the trigger on each table, firing before the rules, and that a person
  -- with no right to update the NC (the engineer here only reads it through RLS for these writes) can still write, because the lock is taken as the owner. ----
  PERFORM pg_temp.login(u_eng);
  INSERT INTO public.ncr_dispositions (organisation_id, nonconformance_id, decision, quantity, instructions) VALUES (org, nc, 'scrap', 2, 'Scrap two');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_eng);
  INSERT INTO public.ncr_containment_actions (organisation_id, nonconformance_id, kind, description) VALUES (org, nc_plain, 'quarantine', 'Quarantine it');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_eng);
  INSERT INTO public.ncr_affected_lots (organisation_id, nonconformance_id, lot_id, quantity) VALUES (org, nc_cost, lot1, 3);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM pg_trigger WHERE tgname = 'a_ncr_lock_parent' AND NOT tgisinternal), 3::bigint, 'one lock trigger on each of the three tables');
  PERFORM pg_temp.assert_eq((SELECT bool_and(t.tgname < r2.tgname) FROM pg_trigger t JOIN pg_trigger r2 ON r2.tgrelid = t.tgrelid AND r2.tgname LIKE '%\_rules'
                              WHERE t.tgname = 'a_ncr_lock_parent' AND NOT t.tgisinternal), true, 'the lock trigger fires before each table''s rule trigger');

  -- ---- DB-4: a part change must agree with what the NC is already linked to ----
  PERFORM pg_temp.login(u_eng);
  UPDATE public.nonconformances SET part_id = p2 WHERE id = nc_plain;  -- nothing linked: free to change
  PERFORM pg_temp.assert_eq((SELECT part_id FROM public.nonconformances WHERE id = nc_plain), p2, 'an NC with no links takes a new part');
  UPDATE public.nonconformances SET part_id = p1 WHERE id = nc_plain;
  -- a lot of another part
  UPDATE public.nonconformances SET lot_id = lot1 WHERE id = nc_plain;
  r := pg_temp.fails(format($q$UPDATE public.nonconformances SET part_id = %L WHERE id = %L$q$, p2, nc_plain));
  PERFORM pg_temp.assert_eq(r LIKE 'QM005: The new part does not match its lot%', true, 'the part must agree with the lot: ' || r);
  -- the same part is no change at all
  UPDATE public.nonconformances SET part_id = p1, title = 'Plain, renamed' WHERE id = nc_plain;
  -- an order
  UPDATE public.nonconformances SET lot_id = NULL, production_order_id = ord WHERE id = nc_cost;
  r := pg_temp.fails(format($q$UPDATE public.nonconformances SET part_id = %L WHERE id = %L$q$, p2, nc_cost));
  PERFORM pg_temp.assert_eq(r LIKE 'QM005: The new part does not match its production order%', true, 'the part must agree with the order: ' || r);
  -- affected lots (nc has none linked directly): a live affected lot of the old part blocks a new part, a removed one does not
  INSERT INTO public.ncr_affected_lots (organisation_id, nonconformance_id, lot_id, quantity) VALUES (org, nc, lot1, 2);
  r := pg_temp.fails(format($q$UPDATE public.nonconformances SET part_id = %L WHERE id = %L$q$, p2, nc));
  PERFORM pg_temp.assert_eq(r LIKE 'QM005: The new part does not match its affected lots%', true, 'the part must agree with the affected lots: ' || r);
  UPDATE public.ncr_affected_lots SET removed_reason = 'Entered by mistake' WHERE nonconformance_id = nc AND lot_id = lot1;
  UPDATE public.nonconformances SET part_id = p2 WHERE id = nc;
  PERFORM pg_temp.assert_eq((SELECT part_id FROM public.nonconformances WHERE id = nc), p2, 'a removed affected lot no longer holds the part');
  PERFORM pg_temp.logout();

  -- ---- API-6: the reporting dataset moves when a cost line is deleted ----
  PERFORM pg_temp.login(u_eng);
  INSERT INTO public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, amount) VALUES (org, nc_cost, 'scrap', 'GBP', 100) RETURNING id INTO c1;
  PERFORM pg_temp.assert_eq((SELECT cost_lines || '|' || total_cost FROM public.report_non_conformances WHERE id = nc_cost), '1|100.00', 'the cost shows');
  v1 := (SELECT updated_at FROM public.report_non_conformances WHERE id = nc_cost);
  PERFORM pg_temp.logout();
  -- Delete the line an hour later (the clock does not move inside one test, so the change is stated; the triggers are left out for this one step).
  SET LOCAL session_replication_role = replica;
  UPDATE public.ncr_costs SET deleted_at = now(), delete_reason = 'Duplicate', updated_at = now() + interval '1 hour' WHERE id = c1;
  SET LOCAL session_replication_role = origin;
  PERFORM pg_temp.login(u_eng);
  v2 := (SELECT updated_at FROM public.report_non_conformances WHERE id = nc_cost);
  PERFORM pg_temp.assert_eq((SELECT cost_lines FROM public.report_non_conformances WHERE id = nc_cost), 0::bigint, 'the deleted line no longer counts');
  PERFORM pg_temp.assert_eq(v2 > v1 + interval '59 minutes', true, 'but the dataset says the NC changed, so an incremental pull picks it up');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
