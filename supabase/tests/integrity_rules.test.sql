-- Audit report fixes B: an open NC keeps its severity, quantity and description; a containment waiver needs a reason; the base currency is locked once costs exist;
-- membership status moves and re-joining; people named on records are active members; an NC under a running 8D cannot be deleted; gate problems are for readers.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('33000000-0000-0000-0000-000000000101', 'owner@ir.test'), ('33000000-0000-0000-0000-000000000102', 'member@ir.test'),
  ('33000000-0000-0000-0000-000000000103', 'leaver@ir.test'), ('33000000-0000-0000-0000-000000000104', 'other@ir.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  u_owner uuid := '33000000-0000-0000-0000-000000000101'; u_member uuid := '33000000-0000-0000-0000-000000000102';
  u_leaver uuid := '33000000-0000-0000-0000-000000000103'; u_other uuid := '33000000-0000-0000-0000-000000000104';
  org uuid; org2 uuid; m_member uuid; m_leaver uuid; m_new uuid; nc uuid; nc2 uuid; cap uuid; r text; g uuid;
  mk text := $f$INSERT INTO public.nonconformances (organisation_id, source, title, severity, quantity_affected, description, stage, category_id) VALUES (%L, 'internal', %L, 'minor', 10, 'x', 'open', (SELECT id FROM public.ncr_classifications WHERE organisation_id = %1$L AND kind = 'category' AND code = 'PRODUCT')) RETURNING id$f$;
BEGIN
  PERFORM pg_temp.login(u_owner);
  org := app.create_organisation('Integrity Works', 'Plant A', 'PA', NULL);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_other);
  org2 := app.create_organisation('Other Works', 'Plant B', 'PB', NULL);
  PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u_member, 'active') RETURNING id INTO m_member;
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u_leaver, 'active') RETURNING id INTO m_leaver;

  -- ---- H4: an open non-conformance keeps what it needed to open ----
  PERFORM pg_temp.login(u_owner);
  EXECUTE format(mk, org, 'Open one') INTO nc;
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($q$UPDATE public.nonconformances SET severity = NULL WHERE id = %L$q$, nc)), 5), 'QM005', 'the severity cannot be cleared once open');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($q$UPDATE public.nonconformances SET quantity_affected = NULL WHERE id = %L$q$, nc)), 5), 'QM005', 'nor the quantity affected');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($q$UPDATE public.nonconformances SET description = '  ' WHERE id = %L$q$, nc)), 5), 'QM005', 'nor the description when no part is named');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$UPDATE public.nonconformances SET severity = 'major', quantity_affected = 12 WHERE id = %L$q$, nc)), 'ok', 'but they can be changed to other values');
  -- A containment waiver with a throw-away reason does not pass the gate.
  UPDATE public.nonconformances SET containment_not_needed_reason = 'n/a' WHERE id = nc;
  r := pg_temp.fails(format($q$UPDATE public.nonconformances SET stage = 'contained' WHERE id = %L$q$, nc));
  PERFORM pg_temp.assert_eq(r LIKE 'QM005:%at least 10 characters%', true, 'a containment waiver needs a real reason: ' || r);
  UPDATE public.nonconformances SET containment_not_needed_reason = 'The parts never left the cell' WHERE id = nc;
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$UPDATE public.nonconformances SET stage = 'contained' WHERE id = %L$q$, nc)), 'ok', 'a real reason passes');
  -- An NC with no quantity cannot be dispositioned (it was open before the rule existed: made by the superuser).
  PERFORM pg_temp.logout();
  INSERT INTO public.nonconformances (organisation_id, reference, source, title, severity, quantity_affected, description, stage, category_id)
    SELECT org, 'NC-LEGACY-1', 'internal', 'Legacy, no quantity', 'minor', 10, 'x', 'open', pg_temp.cat(org) RETURNING id INTO nc2;
  UPDATE public.nonconformances SET quantity_affected = NULL, containment_not_needed_reason = 'The parts never left the cell', stage = 'contained' WHERE id = nc2;
  PERFORM pg_temp.login(u_owner);
  r := pg_temp.fails(format($q$UPDATE public.nonconformances SET stage = 'dispositioned' WHERE id = %L$q$, nc2));
  PERFORM pg_temp.assert_eq(r LIKE 'QM005:%enter the quantity affected%', true, 'no quantity, no disposition: ' || r);
  -- Only a reader is told what is wrong with an NC (lot numbers and quantities are in the answer).
  PERFORM pg_temp.assert_eq(cardinality(app.ncr_gate_problems(nc2, 'dispositioned')) > 0, true, 'a reader is told what is needed');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_other);
  PERFORM pg_temp.assert_eq(cardinality(app.ncr_gate_problems(nc2, 'dispositioned')), 0, 'another organisation is told nothing');
  PERFORM pg_temp.logout();

  -- ---- H6: the base currency is locked once there are costs ----
  PERFORM pg_temp.login(u_owner);
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$UPDATE public.organisation_settings SET base_currency = 'EUR' WHERE organisation_id = %L$q$, org)), 'ok', 'the currency can change while there are no costs');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$UPDATE public.organisation_settings SET base_currency = 'GBP' WHERE organisation_id = %L$q$, org)), 'ok', 'and back');
  INSERT INTO public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, vat_treatment, vat_rate, amount) VALUES (org, nc, 'scrap', 'GBP', 'none', 0, 100);
  r := pg_temp.fails(format($q$UPDATE public.organisation_settings SET base_currency = 'EUR' WHERE organisation_id = %L$q$, org));
  PERFORM pg_temp.assert_eq(r LIKE 'QM014:%base currency cannot change%', true, 'once costs exist the base currency is locked: ' || r);
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$UPDATE public.organisation_settings SET vat_rate = 0.25 WHERE organisation_id = %L$q$, org)), 'ok', 'other settings are not locked');
  PERFORM pg_temp.logout();

  -- ---- M10: membership status moves ----
  PERFORM pg_temp.login(u_owner);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($q$UPDATE public.organisation_users SET status = 'invited' WHERE id = %L$q$, m_member)), 5), 'QM015', 'an active member cannot go back to invited');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$UPDATE public.organisation_users SET status = 'suspended' WHERE id = %L$q$, m_member)), 'ok', 'active can be suspended');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$UPDATE public.organisation_users SET status = 'active' WHERE id = %L$q$, m_member)), 'ok', 'and brought back');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$UPDATE public.organisation_users SET status = 'removed' WHERE id = %L$q$, m_leaver)), 'ok', 'active can be removed');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($q$UPDATE public.organisation_users SET status = 'active' WHERE id = %L$q$, m_leaver)), 5), 'QM015', 'a removed member cannot be set active again');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($q$UPDATE public.organisation_users SET status = 'invited' WHERE id = %L$q$, m_leaver)), 5), 'QM015', 'or invited: a new invitation is the way back');
  PERFORM pg_temp.logout();

  -- ---- M9: a removed member can be invited again and accept ----
  INSERT INTO public.organisation_users (organisation_id, invited_email, status, invited_at) VALUES (org, 'leaver@ir.test', 'invited', now()) RETURNING id INTO m_new;
  PERFORM pg_temp.login(u_leaver);
  PERFORM pg_temp.assert_eq(app.accept_invitation(m_new), org, 'a removed member accepts a new invitation');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.organisation_users WHERE organisation_id = org AND user_id = u_leaver AND status = 'active'), 1::bigint, 'and is an active member again');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($q$INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (%L, %L, 'active')$q$, org, u_leaver)), 5), '23505', 'but one active membership per person is still enforced');

  -- ---- M12: people named on records are active members ----
  PERFORM pg_temp.login(u_owner);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($q$UPDATE public.nonconformances SET owner_id = %L WHERE id = %L$q$, u_other, nc)), 5), 'QM005', 'an NC owner from another organisation is refused');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$UPDATE public.nonconformances SET owner_id = %L WHERE id = %L$q$, u_member, nc)), 'ok', 'a member is accepted');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($q$UPDATE public.nonconformances SET detected_by = %L WHERE id = %L$q$, u_other, nc)), 5), 'QM005', 'and so is "detected by"');
  UPDATE public.nonconformances SET owner_id = NULL WHERE id = nc;
  UPDATE public.organisation_users SET status = 'suspended' WHERE id = m_member;
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($q$UPDATE public.nonconformances SET owner_id = %L WHERE id = %L$q$, u_member, nc)), 5), 'QM005', 'a suspended member cannot be named either');
  UPDATE public.organisation_users SET status = 'active' WHERE id = m_member;
  INSERT INTO public.gauges (organisation_id, asset_number, description) VALUES (org, 'G-1', 'Caliper') RETURNING id INTO g;
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($q$UPDATE public.gauges SET custodian_id = %L WHERE id = %L$q$, u_other, g)), 5), 'QM006', 'a gauge custodian from another organisation is refused');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$UPDATE public.gauges SET custodian_id = %L WHERE id = %L$q$, u_member, g)), 'ok', 'a member is accepted');
  PERFORM pg_temp.logout();

  -- ---- M13: an NC under a running 8D cannot be deleted ----
  PERFORM pg_temp.login(u_owner);
  cap := app.start_capa(org, 'Cell 8D', 'The same defect again', 'internal', 'major', nc);
  r := pg_temp.fails(format($q$UPDATE public.nonconformances SET deleted_at = now(), delete_reason = 'Duplicate' WHERE id = %L$q$, nc));
  PERFORM pg_temp.assert_eq(r LIKE 'QM005:%8D that is still running%before deleting%', true, 'a linked running 8D blocks deleting the NC: ' || r);
  PERFORM app.cancel_capa(cap, 'Raised by mistake');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$UPDATE public.nonconformances SET deleted_at = now(), delete_reason = 'Duplicate' WHERE id = %L$q$, nc)), 'ok', 'once the 8D is cancelled it can be deleted');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
