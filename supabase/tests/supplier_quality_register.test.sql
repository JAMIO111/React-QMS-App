-- Supplier Quality SQ1: the register's extra fields, the approval status (never implied, one function, history), classifications, contacts and product links.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('3b000000-0000-0000-0000-000000000901', 'ann@sq.test'), ('3b000000-0000-0000-0000-000000000902', 'bob@sq.test'), ('3b000000-0000-0000-0000-000000000903', 'eve@sq.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '3b000000-0000-0000-0000-000000000901'; bob uuid := '3b000000-0000-0000-0000-000000000902'; eve uuid := '3b000000-0000-0000-0000-000000000903';
  org uuid; org2 uuid; s uuid; s2 uuid; sb uuid; part uuid; part_b uuid; c1 uuid; c2 uuid; ct1 uuid; ct2 uuid; viewer_role uuid; r text; n bigint;
BEGIN
  PERFORM pg_temp.login(ann);
  org := app.create_organisation('SQ Alpha');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve);
  org2 := app.create_organisation('SQ Beta');
  PERFORM pg_temp.logout();
  -- Bob: an active member of Alpha who is only a Viewer.
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, bob, 'active');
  SELECT id INTO viewer_role FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, viewer_role FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id = bob;

  -- ---- a new supplier never implies approval ----
  PERFORM pg_temp.login(ann);
  INSERT INTO public.suppliers (organisation_id, code, name, approval_status, risk_rating) VALUES (org, 'ACME', 'Acme Metals Ltd', 'approved', 'low') RETURNING id INTO s;
  PERFORM pg_temp.assert_eq((SELECT approval_status FROM public.suppliers WHERE id = s), 'pending_approval', 'a new supplier is Pending Approval whatever the client sends');
  PERFORM pg_temp.assert_eq((SELECT risk_rating FROM public.suppliers WHERE id = s) IS NULL, true, 'and has no risk rating');
  PERFORM pg_temp.assert_eq((SELECT active FROM public.suppliers WHERE id = s), true, 'approval and activity are separate: the supplier is active');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.supplier_status_history WHERE supplier_id = s AND from_status IS NULL AND to_status = 'pending_approval'), 1::bigint, 'the first history row is written');

  -- ---- the new fields; approval status and risk rating cannot be written directly ----
  UPDATE public.suppliers SET supplier_type = 'subcontractor', country = 'GB', city = 'Sheffield', website = 'https://acme.test', purchasing_reference = 'V-100' WHERE id = s;
  PERFORM pg_temp.assert_eq((SELECT supplier_type FROM public.suppliers WHERE id = s), 'subcontractor', 'a supplier has a type');
  PERFORM pg_temp.assert_fails(format($f$UPDATE public.suppliers SET approval_status = 'approved' WHERE id = %L$f$, s), 'approval status cannot be set directly');
  PERFORM pg_temp.assert_fails(format($f$UPDATE public.suppliers SET risk_rating = 'low' WHERE id = %L$f$, s), 'the risk rating cannot be set directly');
  PERFORM pg_temp.assert_fails(format($f$UPDATE public.suppliers SET supplier_type = 'wizard' WHERE id = %L$f$, s), 'an unknown type is refused');
  PERFORM pg_temp.assert_fails(format($f$UPDATE public.suppliers SET country = 'gb' WHERE id = %L$f$, s), 'a country is a two-letter capital code');

  -- ---- changing the status: permission, transitions, reason, conditions, history ----
  r := pg_temp.fails(format($f$SELECT app.change_supplier_status(%L, 'approved', 'Passed the audit')$f$, s));
  PERFORM pg_temp.assert_eq(r = 'ok', true, 'an owner can approve (a quality manager level right)');
  PERFORM pg_temp.assert_eq((SELECT approval_status FROM public.suppliers WHERE id = s), 'approved', 'the status moved');
  PERFORM pg_temp.assert_eq((SELECT approval_status_changed_by FROM public.suppliers WHERE id = s), ann, 'who changed it is recorded');
  r := pg_temp.fails(format($f$SELECT app.change_supplier_status(%L, 'approved', 'again')$f$, s));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM020', 'moving to the same status is refused');
  r := pg_temp.fails(format($f$SELECT app.change_supplier_status(%L, 'pending_approval', 'back')$f$, s));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM020', 'an approved supplier cannot go back to pending');
  r := pg_temp.fails(format($f$SELECT app.change_supplier_status(%L, 'suspended', '')$f$, s));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM020', 'a reason is needed');
  r := pg_temp.fails(format($f$SELECT app.change_supplier_status(%L, 'conditional', 'Late deliveries')$f$, s));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM020', 'a conditional approval needs its conditions');
  r := pg_temp.fails(format($f$SELECT app.change_supplier_status(%L, 'bogus', 'x1x')$f$, s));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM020', 'an unknown status is refused');
  r := pg_temp.fails(format($f$SELECT app.change_supplier_status(%L, 'conditional', 'Late deliveries', 'Inspect every delivery', current_date - 1)$f$, s));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM020', 'a review date in the past is refused');
  PERFORM app.change_supplier_status(s, 'conditional', 'Late deliveries', 'Inspect every delivery', current_date + 90);
  PERFORM pg_temp.assert_eq((SELECT conditions FROM public.supplier_status_history WHERE supplier_id = s AND to_status = 'conditional'), 'Inspect every delivery', 'the conditions are kept');
  PERFORM app.change_supplier_status(s, 'suspended', 'Repeat major non-conformances');
  PERFORM app.change_supplier_status(s, 'disqualified', 'Failed to respond to the corrective action request');
  r := pg_temp.fails(format($f$SELECT app.change_supplier_status(%L, 'approved', 'second chance')$f$, s));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM020', 'a disqualified supplier cannot be approved at once');
  PERFORM app.change_supplier_status(s, 'pending_approval', 'Re-opened for qualification');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.supplier_status_history WHERE supplier_id = s), 6::bigint, 'every change is in the history, none overwritten');
  PERFORM pg_temp.assert_eq((SELECT string_agg(to_status, '>' ORDER BY changed_at, to_status) IS NOT NULL FROM public.supplier_status_history WHERE supplier_id = s), true, 'the history reads');
  PERFORM pg_temp.assert_fails(format($f$UPDATE public.supplier_status_history SET reason = 'edited' WHERE supplier_id = %L$f$, s), 'history cannot be edited');
  PERFORM pg_temp.assert_fails(format($f$DELETE FROM public.supplier_status_history WHERE supplier_id = %L$f$, s), 'history cannot be deleted');
  PERFORM pg_temp.assert_fails(format($f$INSERT INTO public.supplier_status_history (organisation_id, supplier_id, to_status) VALUES (%L, %L, 'approved')$f$, org, s), 'history cannot be written directly');
  PERFORM pg_temp.logout();

  -- A Viewer reads but cannot approve, edit or configure.
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.supplier_status_history WHERE supplier_id = s) > 0, true, 'a viewer can read the history');
  r := pg_temp.fails(format($f$SELECT app.change_supplier_status(%L, 'approved', 'Because I said so')$f$, s));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a viewer cannot change the approval status');
  PERFORM pg_temp.assert_eq(pg_temp.affected(format($f$UPDATE public.suppliers SET city = 'Leeds' WHERE id = %L$f$, s)), 0::bigint, 'a viewer cannot edit a supplier');
  PERFORM pg_temp.assert_fails(format($f$INSERT INTO public.supplier_classifications (organisation_id, key, label) VALUES (%L, 'viewer_made', 'Viewer made')$f$, org), 'a viewer cannot configure classifications');
  PERFORM pg_temp.logout();

  -- ---- classifications: seeded, configurable, multi-select ----
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.supplier_classifications WHERE organisation_id = org), 9::bigint, 'nine classifications are seeded');
  INSERT INTO public.supplier_classifications (organisation_id, key, label, sequence) VALUES (org, 'casting', 'Casting foundry', 10) RETURNING id INTO c1;
  r := pg_temp.fails(format($f$INSERT INTO public.supplier_classifications (organisation_id, key, label) VALUES (%L, 'casting2', 'casting FOUNDRY')$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), '23505', 'a label is unique whatever its case');
  PERFORM pg_temp.assert_fails(format($f$UPDATE public.supplier_classifications SET key = 'renamed' WHERE id = %L$f$, c1), 'the key is fixed');
  UPDATE public.supplier_classifications SET label = 'Foundry (casting)' WHERE id = c1;
  SELECT id INTO c2 FROM public.supplier_classifications WHERE organisation_id = org AND key = 'welding';
  PERFORM app.set_supplier_classifications(s, ARRAY[c1, c2]);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.supplier_classification_links WHERE supplier_id = s), 2::bigint, 'a supplier has several classifications');
  PERFORM app.set_supplier_classifications(s, ARRAY[c2, c2]);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.supplier_classification_links WHERE supplier_id = s), 1::bigint, 'the set is replaced as a whole, duplicates ignored');
  UPDATE public.supplier_classifications SET active = false WHERE id = c1;
  r := pg_temp.fails(format($f$SELECT app.set_supplier_classifications(%L, ARRAY[%L::uuid])$f$, s, c1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM020', 'a classification that is switched off cannot be added');
  PERFORM app.set_supplier_classifications(s, ARRAY[]::uuid[]);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.supplier_classification_links WHERE supplier_id = s), 0::bigint, 'and the set can be emptied');
  PERFORM pg_temp.logout();

  -- ---- contacts: one primary, deactivated not deleted ----
  PERFORM pg_temp.login(ann);
  INSERT INTO public.supplier_contacts (organisation_id, supplier_id, name, role, email, is_primary) VALUES (org, s, 'Pat Quality', 'quality', 'pat@acme.test', true) RETURNING id INTO ct1;
  INSERT INTO public.supplier_contacts (organisation_id, supplier_id, name, role, is_primary) VALUES (org, s, 'Sam Sales', 'sales', true) RETURNING id INTO ct2;
  PERFORM pg_temp.assert_eq((SELECT is_primary FROM public.supplier_contacts WHERE id = ct1), false, 'a new primary contact replaces the old one');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.supplier_contacts WHERE supplier_id = s AND is_primary), 1::bigint, 'one primary per supplier');
  UPDATE public.supplier_contacts SET active = false WHERE id = ct2;
  PERFORM pg_temp.assert_eq((SELECT is_primary FROM public.supplier_contacts WHERE id = ct2), false, 'an inactive contact is not primary');
  PERFORM pg_temp.assert_fails(format($f$DELETE FROM public.supplier_contacts WHERE id = %L$f$, ct1), 'contacts are never deleted');
  PERFORM pg_temp.assert_fails(format($f$INSERT INTO public.supplier_contacts (organisation_id, supplier_id, name, role) VALUES (%L, %L, 'X', 'astronaut')$f$, org, s), 'an unknown role is refused');
  PERFORM pg_temp.logout();

  -- ---- products and services ----
  PERFORM pg_temp.login(ann);
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'BAR-50', 'Bar stock') RETURNING id INTO part;
  INSERT INTO public.supplier_product_links (organisation_id, supplier_id, kind, part_id, supplier_part_number) VALUES (org, s, 'part', part, 'AC-BAR-50');
  INSERT INTO public.supplier_product_links (organisation_id, supplier_id, kind, description) VALUES (org, s, 'service', 'Heat treatment, case hardening');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.supplier_product_links WHERE supplier_id = s), 2::bigint, 'a supplier supplies parts and services');
  PERFORM pg_temp.assert_fails(format($f$INSERT INTO public.supplier_product_links (organisation_id, supplier_id, kind, part_id) VALUES (%L, %L, 'part', %L)$f$, org, s, part), 'a part is linked once');
  PERFORM pg_temp.assert_fails(format($f$INSERT INTO public.supplier_product_links (organisation_id, supplier_id, kind) VALUES (%L, %L, 'material')$f$, org, s), 'a material needs a description');
  PERFORM pg_temp.assert_fails(format($f$INSERT INTO public.supplier_product_links (organisation_id, supplier_id, kind, part_id, description) VALUES (%L, %L, 'service', %L, 'x')$f$, org, s, part), 'a service has no part');
  PERFORM pg_temp.assert_fails(format($f$UPDATE public.supplier_product_links SET part_id = NULL WHERE supplier_id = %L$f$, s), 'what is supplied cannot be changed');
  UPDATE public.supplier_product_links SET active = false WHERE supplier_id = s AND kind = 'service';
  PERFORM pg_temp.logout();

  -- ---- another organisation: nothing crosses ----
  PERFORM pg_temp.login(eve);
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org2, 'BETA', 'Beta Ltd') RETURNING id INTO sb;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org2, 'B-1', 'Beta part') RETURNING id INTO part_b;
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.suppliers WHERE id = s), 0::bigint, 'another organisation cannot see the supplier');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.supplier_contacts WHERE supplier_id = s), 0::bigint, 'nor its contacts');
  r := pg_temp.fails(format($f$SELECT app.change_supplier_status(%L, 'approved', 'Not mine to approve')$f$, s));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'nor change its status (as if it did not exist)');
  r := pg_temp.fails(format($f$INSERT INTO public.supplier_contacts (organisation_id, supplier_id, name) VALUES (%L, %L, 'Intruder')$f$, org2, s));
  PERFORM pg_temp.assert_eq(left(r, 5), '23503', 'nor attach a contact to it');
  r := pg_temp.fails(format($f$INSERT INTO public.supplier_product_links (organisation_id, supplier_id, kind, part_id) VALUES (%L, %L, 'part', %L)$f$, org2, sb, part));
  PERFORM pg_temp.assert_eq(left(r, 5), '23503', 'a supplier cannot be linked to another organisation''s part');
  PERFORM pg_temp.assert_eq(pg_temp.affected(format($f$UPDATE public.suppliers SET city = 'Hijacked' WHERE id = %L$f$, s)), 0::bigint, 'nor edit it');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
