-- Supplier Quality SQ4c: material certificates - function-only writes, who records and who reviews, traceability and agreement rules (receipt line, lot, part, supplier),
-- duplicates, frozen once reviewed, withdrawal, line summary and tenant isolation.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('4c000000-0000-0000-0000-000000000a01', 'ann@mc.test'), ('4c000000-0000-0000-0000-000000000a02', 'bob@mc.test'), ('4c000000-0000-0000-0000-000000000a03', 'cat@mc.test'), ('4c000000-0000-0000-0000-000000000a04', 'eve@mc.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '4c000000-0000-0000-0000-000000000a01'; bob uuid := '4c000000-0000-0000-0000-000000000a02'; cat uuid := '4c000000-0000-0000-0000-000000000a03'; eve uuid := '4c000000-0000-0000-0000-000000000a04';
  org uuid; org2 uuid; site uuid; s1 uuid; s2 uuid; s_other uuid; p1 uuid; p2 uuid; role_id uuid; m uuid; gr uuid; line uuid; line2 uuid; lot1 uuid; doc uuid; c1 uuid; c2 uuid; c3 uuid; r text;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('MC Alpha', 'Plant A', 'PA', NULL); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('MC Beta'); PERFORM pg_temp.logout();
  FOREACH m IN ARRAY ARRAY[bob, cat] LOOP
    INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, m, 'active');
    SELECT id INTO role_id FROM public.roles WHERE organisation_id = org AND key = CASE m WHEN bob THEN 'viewer' ELSE 'inspector' END;
    INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, ou.id, role_id FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id = m;
  END LOOP;
  SELECT id INTO site FROM public.sites WHERE organisation_id = org;
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'ACME', 'Acme Metals') RETURNING id INTO s1;
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'BOLT', 'Bolt Co') RETURNING id INTO s2;
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org2, 'OTHR', 'Other') RETURNING id INTO s_other;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'BAR-1', 'Steel bar') RETURNING id INTO p1;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'PLATE-1', 'Plate') RETURNING id INTO p2;

  PERFORM pg_temp.login(ann);
  gr := ((app.record_goods_receipt(s1, NULL, site, current_date, 'DN-1', NULL,
    jsonb_build_array(jsonb_build_object('partId', p1, 'quantity', 100, 'lotNumber', 'LOT-A'), jsonb_build_object('material', 'Mystery coil', 'quantity', 5)), NULL)) ->> 'id')::uuid;
  SELECT id INTO line FROM public.goods_receipt_lines WHERE goods_receipt_id = gr AND line_number = 1;
  SELECT id INTO line2 FROM public.goods_receipt_lines WHERE goods_receipt_id = gr AND line_number = 2;
  SELECT lot_id INTO lot1 FROM public.goods_receipt_lines WHERE id = line;
  doc := app.add_supplier_document(s1, 'test_report', 'Mill test report H-100', NULL, current_date, NULL, NULL, org::text || '/supplier/' || s1::text || '/' || gen_random_uuid()::text || '-mtr.pdf', 'mtr.pdf', 'application/pdf', 100);

  -- ---- writes only through functions; who may record ----
  PERFORM pg_temp.assert_fails(format($f$INSERT INTO public.supplier_material_certificates (organisation_id, supplier_id, certificate_number, kind, material, heat_number) VALUES (%L, %L, 'X', 'other', 'm', 'h')$f$, org, s1), 'certificates are written only through functions');
  PERFORM pg_temp.logout(); PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_material_certificate(%L, '{"certificateNumber":"V","kind":"other","material":"m","heatNumber":"h"}'::jsonb)$f$, s1)), 5), '42501', 'a viewer cannot record a certificate');
  PERFORM pg_temp.logout(); PERFORM pg_temp.login(ann);

  -- ---- recording: traced and resolved from the receipt line ----
  c1 := app.record_material_certificate(s1, jsonb_build_object('certificateNumber', 'MTR-100', 'kind', 'mill_test_report', 'heatNumber', 'H-100', 'receiptLineId', line, 'documentId', doc, 'specification', 'EN 10025 S355'));
  PERFORM pg_temp.assert_eq((SELECT (status, part_id = p1, lot_id = lot1, receipt_line_id = line)::text FROM public.supplier_material_certificates WHERE id = c1), '(received,t,t,t)', 'the part and lot come from the receipt line');
  c2 := app.record_material_certificate(s1, jsonb_build_object('certificateNumber', 'COC-7', 'kind', 'certificate_of_conformance', 'receiptLineId', line2));
  PERFORM pg_temp.assert_eq((SELECT (part_id IS NULL, material)::text FROM public.supplier_material_certificates WHERE id = c2), '(t,"Mystery coil")', 'a material line gives the material in words');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_material_certificate(%L, '{"certificateNumber":"N1","kind":"other","material":"m"}'::jsonb)$f$, s1)), 5), 'QM020', 'a certificate must be traceable (line, lot or heat)');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_material_certificate(%L, '{"certificateNumber":"N2","kind":"other","heatNumber":"h"}'::jsonb)$f$, s1)), 5), 'QM020', 'it must say what it covers');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_material_certificate(%L, '{"certificateNumber":"N3","kind":"bogus","material":"m","heatNumber":"h"}'::jsonb)$f$, s1)), 5), '23514', 'an unknown kind is refused');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_material_certificate(%L, jsonb_build_object('certificateNumber', 'N4', 'kind', 'other', 'receiptLineId', %L))$f$, s2, line)), 5), 'QM020', 'a receipt line of another supplier is refused');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_material_certificate(%L, jsonb_build_object('certificateNumber', 'N5', 'kind', 'other', 'receiptLineId', %L, 'partId', %L))$f$, s1, line, p2)), 5), 'QM020', 'the part must agree with the receipt line');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_material_certificate(%L, jsonb_build_object('certificateNumber', 'N6', 'kind', 'other', 'lotId', %L, 'partId', %L))$f$, s1, lot1, p2)), 5), 'QM020', 'the part must agree with the lot');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_material_certificate(%L, jsonb_build_object('certificateNumber', 'N7', 'kind', 'other', 'lotId', %L))$f$, s2, lot1)), 5), 'QM020', 'a lot from another supplier is refused');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_material_certificate(%L, jsonb_build_object('certificateNumber', 'N8', 'kind', 'other', 'material', 'm', 'heatNumber', 'h', 'documentId', %L))$f$, s2, doc)), 5), 'QM020', 'the file must be the supplier''s own document');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_material_certificate(%L, '{"certificateNumber":"mtr-100","kind":"other","material":"m","heatNumber":"h-100"}'::jsonb)$f$, s1)), 5), 'QM020', 'the same number and heat is not recorded twice (any case)');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.record_material_certificate(%L, '{"certificateNumber":"M","kind":"other","material":"m","heatNumber":"h"}'::jsonb)$f$, s_other)), 5), 'P0002', 'another organisation''s supplier is not found');

  -- ---- editing until reviewed ----
  PERFORM app.update_material_certificate(c1, '{"specification":"EN 10025 S355J2","notes":"Rechecked"}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT (specification, notes)::text FROM public.supplier_material_certificates WHERE id = c1), '("EN 10025 S355J2",Rechecked)', 'an unreviewed certificate can be edited');
  PERFORM app.update_material_certificate(c1, '{"notes":null}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT notes FROM public.supplier_material_certificates WHERE id = c1), NULL, 'null clears an optional field');

  -- ---- review: needs supplier_quality.manage; a rejection needs a note ----
  PERFORM pg_temp.logout(); PERFORM pg_temp.login(cat);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.review_material_certificate(%L, true, NULL)$f$, c1)), 5), '42501', 'an inspector records but does not review');
  PERFORM pg_temp.logout(); PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.review_material_certificate(%L, false, NULL)$f$, c2)), 5), 'QM020', 'a rejection needs a note');
  PERFORM app.review_material_certificate(c1, true, 'Heat and chemistry match the order');
  PERFORM pg_temp.assert_eq((SELECT (status, reviewed_by = ann)::text FROM public.supplier_material_certificates WHERE id = c1), '(accepted,t)', 'accepting records who reviewed it');
  PERFORM app.review_material_certificate(c2, false, 'Wrong material grade');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.supplier_material_certificates WHERE id = c2), 'rejected', 'a certificate can be rejected');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.review_material_certificate(%L, true, NULL)$f$, c1)), 5), 'QM020', 'reviewed once');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.update_material_certificate(%L, '{"notes":"x"}'::jsonb)$f$, c1)), 5), 'QM020', 'a reviewed certificate is frozen');
  PERFORM pg_temp.assert_fails(format($f$UPDATE public.supplier_material_certificates SET notes = 'x' WHERE id = %L$f$, c1), 'no direct updates');
  PERFORM pg_temp.assert_fails(format($f$DELETE FROM public.supplier_material_certificates WHERE id = %L$f$, c1), 'never deleted');

  -- ---- the line summary ----
  PERFORM pg_temp.assert_eq((app.receipt_line_certificates(line)), '{"received": 0, "accepted": 1, "rejected": 0}'::jsonb, 'the line counts its accepted certificate');
  PERFORM pg_temp.assert_eq((app.receipt_line_certificates(line2)), '{"received": 0, "accepted": 0, "rejected": 1}'::jsonb, 'and the rejected one on the other line');

  -- ---- withdraw (reason), then record the right one ----
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.withdraw_material_certificate(%L, 'x')$f$, c2)), 5), 'QM020', 'a withdrawal needs a reason');
  PERFORM app.withdraw_material_certificate(c2, 'Wrong supplier document attached');
  PERFORM pg_temp.assert_eq((SELECT (status, withdrawn_by = ann)::text FROM public.supplier_material_certificates WHERE id = c2), '(withdrawn,t)', 'a reviewed certificate can still be withdrawn with a reason');
  PERFORM pg_temp.assert_eq((app.receipt_line_certificates(line2)), '{"received": 0, "accepted": 0, "rejected": 0}'::jsonb, 'a withdrawn certificate no longer counts');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.withdraw_material_certificate(%L, 'again please')$f$, c2)), 5), 'QM020', 'withdrawn once');
  c3 := app.record_material_certificate(s1, jsonb_build_object('certificateNumber', 'COC-7', 'kind', 'certificate_of_conformance', 'receiptLineId', line2));
  PERFORM pg_temp.assert_ok(format($f$SELECT 1 FROM public.supplier_material_certificates WHERE id = %L$f$, c3), 'a withdrawn certificate frees its number for the corrected one');

  -- ---- read access and isolation ----
  PERFORM pg_temp.logout(); PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq(pg_temp.count_rows('SELECT 1 FROM public.supplier_material_certificates'), 3::bigint, 'a viewer can read the certificates');
  PERFORM pg_temp.logout(); PERFORM pg_temp.login(eve);
  PERFORM pg_temp.assert_eq(pg_temp.count_rows('SELECT 1 FROM public.supplier_material_certificates'), 0::bigint, 'another organisation sees none');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.review_material_certificate(%L, true, NULL)$f$, c3)), 5), 'P0002', 'and cannot review them');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
