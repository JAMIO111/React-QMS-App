-- TR4: affected lots on non-conformances — the lots an NC touches with quantities, per-lot dispositions and containment, the lot gate, and NCs that name no lot.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('38000000-0000-0000-0000-000000000501', 'owner@aff.test'), ('38000000-0000-0000-0000-000000000502', 'engineer@aff.test'), ('38000000-0000-0000-0000-000000000503', 'viewer@aff.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  u_owner uuid := '38000000-0000-0000-0000-000000000501'; u_eng uuid := '38000000-0000-0000-0000-000000000502'; u_view uuid := '38000000-0000-0000-0000-000000000503';
  org uuid; m uuid; p1 uuid; p2 uuid; lot1 uuid; lot2 uuid; lot_other uuid; s1 uuid; s2 uuid; s_other uuid;
  nc uuid; nc_plain uuid; a1 uuid; a2 uuid; d1 uuid; d2 uuid; d3 uuid; c1 uuid; r text;
  mk text := $f$INSERT INTO public.nonconformances (organisation_id, source, title, severity, quantity_affected, description, stage, part_id, category_id) VALUES (%L, 'internal', %L, 'minor', 10, 'x', 'open', %L, (SELECT id FROM public.ncr_classifications WHERE organisation_id = %1$L AND kind = 'category' AND code = 'PRODUCT')) RETURNING id$f$;
BEGIN
  PERFORM pg_temp.login(u_owner);
  org := app.create_organisation('Affected Works', 'Plant A', 'PA', NULL);
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'AF-100', 'Rod') RETURNING id INTO p1;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'AF-200', 'Other rod') RETURNING id INTO p2;
  INSERT INTO public.lots (organisation_id, lot_number, part_id, origin, quantity) VALUES (org, 'LOT-1', p1, 'produced', 100) RETURNING id INTO lot1;
  INSERT INTO public.lots (organisation_id, lot_number, part_id, origin, quantity) VALUES (org, 'LOT-2', p1, 'produced', 100) RETURNING id INTO lot2;
  INSERT INTO public.lots (organisation_id, lot_number, part_id, origin) VALUES (org, 'LOT-OTHER', p2, 'produced') RETURNING id INTO lot_other;
  INSERT INTO public.serial_numbers (organisation_id, serial_number, part_id, lot_id) VALUES (org, 'S-1', p1, lot1) RETURNING id INTO s1;
  INSERT INTO public.serial_numbers (organisation_id, serial_number, part_id, lot_id) VALUES (org, 'S-2', p1, lot1) RETURNING id INTO s2;
  INSERT INTO public.serial_numbers (organisation_id, serial_number, part_id, lot_id) VALUES (org, 'S-X', p1, lot2) RETURNING id INTO s_other;
  EXECUTE format(mk, org, 'Names lots', p1) INTO nc;
  EXECUTE format(mk, org, 'No lots at all', p1) INTO nc_plain;
  PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u_eng, 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'quality_engineer';
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u_view, 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'viewer';

  -- ---- affected lots ----
  PERFORM pg_temp.login(u_view);
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.ncr_affected_lots (organisation_id, nonconformance_id, lot_id, quantity) VALUES (%L, %L, %L, 4)$q$, org, nc, lot1), 'a reader cannot add an affected lot');
  PERFORM pg_temp.login(u_eng);
  INSERT INTO public.ncr_affected_lots (organisation_id, nonconformance_id, lot_id, quantity, serial_ids, note) VALUES (org, nc, lot1, 6, ARRAY[s1, s2], 'First lot') RETURNING id INTO a1;
  PERFORM pg_temp.assert_eq((SELECT created_by = u_eng FROM public.ncr_affected_lots WHERE id = a1), true, 'stamped with who added it');
  r := pg_temp.fails(format($q$INSERT INTO public.ncr_affected_lots (organisation_id, nonconformance_id, lot_id, quantity) VALUES (%L, %L, %L, 2)$q$, org, nc, lot1));
  PERFORM pg_temp.assert_eq(r LIKE '23505%', true, 'one live row per lot: ' || r);
  r := pg_temp.fails(format($q$INSERT INTO public.ncr_affected_lots (organisation_id, nonconformance_id, lot_id, quantity) VALUES (%L, %L, %L, 2)$q$, org, nc, lot_other));
  PERFORM pg_temp.assert_eq(r LIKE 'QM005: Lot LOT-OTHER is a lot of another part%', true, 'a lot of another part is refused: ' || r);
  r := pg_temp.fails(format($q$INSERT INTO public.ncr_affected_lots (organisation_id, nonconformance_id, lot_id, quantity) VALUES (%L, %L, %L, 5)$q$, org, nc, lot2));
  PERFORM pg_temp.assert_eq(r LIKE 'QM005: The lots would total 11 but only 10 are affected%', true, 'the lots cannot exceed the quantity affected: ' || r);
  r := pg_temp.fails(format($q$INSERT INTO public.ncr_affected_lots (organisation_id, nonconformance_id, lot_id, quantity, serial_ids) VALUES (%L, %L, %L, 2, ARRAY[%L::uuid])$q$, org, nc, lot2, s1));
  PERFORM pg_temp.assert_eq(r LIKE 'QM005: Serial numbers must be serial numbers of lot LOT-2%', true, 'serials of another lot are refused: ' || r);
  r := pg_temp.fails(format($q$INSERT INTO public.ncr_affected_lots (organisation_id, nonconformance_id, lot_id, quantity, serial_ids) VALUES (%L, %L, %L, 2, ARRAY[%L::uuid, %L::uuid])$q$, org, nc, lot2, s_other, s_other));
  PERFORM pg_temp.assert_eq(r LIKE 'QM005: Serial numbers must be%', true, 'a serial named twice is refused: ' || r);
  INSERT INTO public.ncr_affected_lots (organisation_id, nonconformance_id, lot_id, quantity, serial_ids) VALUES (org, nc, lot2, 4, ARRAY[s_other]) RETURNING id INTO a2;
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.ncr_affected_lots SET lot_id = %L WHERE id = %L$q$, lot2, a1), 'the lot of a row cannot change');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.ncr_affected_lots SET removed_at = now() WHERE id = %L$q$, a2), 'who and when of a removal are not writable');
  PERFORM pg_temp.assert_fails(format($q$DELETE FROM public.ncr_affected_lots WHERE id = %L$q$, a2), 'nothing is deleted');
  r := pg_temp.fails(format($q$UPDATE public.nonconformances SET quantity_affected = 8 WHERE id = %L$q$, nc));
  PERFORM pg_temp.assert_eq(r LIKE 'QM005: The affected lots already total 10%', true, 'the quantity affected cannot drop below the lots: ' || r);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_events WHERE organisation_id = org AND entity_type = 'ncr_affected_lots'), 2::bigint, 'affected lots are audited');
  PERFORM pg_temp.login(u_eng);

  -- ---- per-lot dispositions and containment ----
  r := pg_temp.fails(format($q$INSERT INTO public.ncr_dispositions (organisation_id, nonconformance_id, decision, quantity, instructions, lot_id) VALUES (%L, %L, 'scrap', 1, 'x', %L)$q$, org, nc_plain, lot1));
  PERFORM pg_temp.assert_eq(r LIKE 'QM005: Add the lot to the affected lots%', true, 'a lot not on the NC cannot be named: ' || r);
  INSERT INTO public.ncr_dispositions (organisation_id, nonconformance_id, decision, quantity, instructions, lot_id) VALUES (org, nc, 'scrap', 4, 'Scrap four from LOT-1', lot1) RETURNING id INTO d1;
  r := pg_temp.fails(format($q$INSERT INTO public.ncr_dispositions (organisation_id, nonconformance_id, decision, quantity, instructions, lot_id) VALUES (%L, %L, 'rework', 3, 'x', %L)$q$, org, nc, lot1));
  PERFORM pg_temp.assert_eq(r LIKE 'QM005: Dispositions for this lot would total 7 but only 6 of it are affected%', true, 'per-lot quantity cannot exceed the lot: ' || r);
  INSERT INTO public.ncr_dispositions (organisation_id, nonconformance_id, decision, quantity, instructions, lot_id) VALUES (org, nc, 'rework', 2, 'Rework the rest of LOT-1', lot1) RETURNING id INTO d2;
  r := pg_temp.fails(format($q$UPDATE public.ncr_affected_lots SET quantity = 5 WHERE id = %L$q$, a1));
  PERFORM pg_temp.assert_eq(r LIKE 'QM005: Dispositions already cover 6 of lot LOT-1%', true, 'a lot cannot drop below its dispositions: ' || r);
  INSERT INTO public.ncr_containment_actions (organisation_id, nonconformance_id, kind, description, lot_id) VALUES (org, nc, 'quarantine', 'Hold LOT-2', lot2) RETURNING id INTO c1;
  r := pg_temp.fails(format($q$INSERT INTO public.ncr_containment_actions (organisation_id, nonconformance_id, kind, description, lot_id) VALUES (%L, %L, 'sort', 'x', %L)$q$, org, nc_plain, lot2));
  PERFORM pg_temp.assert_eq(r LIKE 'QM005: Add the lot to the affected lots%', true, 'containment names only affected lots: ' || r);
  r := pg_temp.fails(format($q$UPDATE public.ncr_affected_lots SET removed_reason = 'Raised in error' WHERE id = %L$q$, a2));
  PERFORM pg_temp.assert_eq(r LIKE 'QM005: Lot LOT-2 cannot be removed while 1 disposition(s) or containment action(s) name it%', true, 'a lot named by a containment action cannot be removed: ' || r);
  UPDATE public.ncr_containment_actions SET status = 'done', done_note = 'Held' WHERE id = c1;
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$UPDATE public.ncr_containment_actions SET lot_id = %L WHERE id = %L$q$, lot1, c1)) LIKE 'QM005: This containment action is done%', true, 'the lot of a done action is frozen');
  UPDATE public.ncr_containment_actions SET status = 'open' WHERE id = c1;
  UPDATE public.ncr_containment_actions SET status = 'cancelled', cancel_reason = 'Held elsewhere' WHERE id = c1;

  -- ---- the lot gate ----
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_owner);
  UPDATE public.nonconformances SET containment_not_needed_reason = 'Held in the cage' WHERE id = nc;
  PERFORM app.approve_ncr_disposition(d1); PERFORM app.approve_ncr_disposition(d2);
  INSERT INTO public.ncr_dispositions (organisation_id, nonconformance_id, decision, quantity, instructions) VALUES (org, nc, 'scrap', 4, 'Scrap four, lot not named') RETURNING id INTO d3;
  PERFORM app.approve_ncr_disposition(d3);
  r := pg_temp.fails(format($q$UPDATE public.nonconformances SET stage = 'dispositioned' WHERE id = %L$q$, nc));
  PERFORM pg_temp.assert_eq(r LIKE 'QM005: Before this can move to dispositioned: lot LOT-2: approved dispositions cover 0 of the 4 affected', true, 'every named lot needs its own approved dispositions: ' || r);
  PERFORM app.cancel_ncr_disposition(d3, 'Name the lot');
  INSERT INTO public.ncr_dispositions (organisation_id, nonconformance_id, decision, quantity, instructions, lot_id) VALUES (org, nc, 'scrap', 4, 'Scrap four from LOT-2', lot2) RETURNING id INTO d3;
  PERFORM app.approve_ncr_disposition(d3);
  UPDATE public.nonconformances SET stage = 'dispositioned' WHERE id = nc;
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.nonconformances WHERE id = nc), 'dispositioned', 'covered lots reach Dispositioned');
  PERFORM pg_temp.assert_eq(app.ncr_gate_problems(nc, 'closed'), ARRAY[]::text[], 'nothing left for closure');

  -- ---- removal and restore, and NCs without lots ----
  PERFORM pg_temp.settle_ncr(nc_plain);
  UPDATE public.nonconformances SET stage = 'dispositioned' WHERE id = nc_plain;
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.nonconformances WHERE id = nc_plain), 'dispositioned', 'an NC with no lots follows the old rules exactly');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_eng);
  INSERT INTO public.nonconformances (organisation_id, source, title, severity, quantity_affected, description, stage, part_id, category_id)
    VALUES (org, 'internal', 'Remove and restore', 'minor', 10, 'x', 'open', p1, pg_temp.cat(org)) RETURNING id INTO nc_plain;
  INSERT INTO public.ncr_affected_lots (organisation_id, nonconformance_id, lot_id, quantity) VALUES (org, nc_plain, lot1, 3) RETURNING id INTO a1;
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.ncr_affected_lots SET removed_reason = '  ' WHERE id = %L$q$, a1), 'a removal needs a reason');
  UPDATE public.ncr_affected_lots SET removed_reason = 'Entered by mistake' WHERE id = a1;
  PERFORM pg_temp.assert_eq((SELECT removed_by = u_eng AND removed_at IS NOT NULL FROM public.ncr_affected_lots WHERE id = a1), true, 'removal is stamped');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$UPDATE public.ncr_affected_lots SET quantity = 5 WHERE id = %L$q$, a1)) LIKE 'QM005: Lot LOT-1 is removed%', true, 'a removed lot is frozen');
  INSERT INTO public.ncr_affected_lots (organisation_id, nonconformance_id, lot_id, quantity) VALUES (org, nc_plain, lot1, 2);
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$UPDATE public.ncr_affected_lots SET removed_reason = NULL WHERE id = %L$q$, a1)) LIKE '23505%', true, 'cannot restore while the lot is live again');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
