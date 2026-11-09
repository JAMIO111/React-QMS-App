-- Supplier Quality SQ2a: certifications and documents — function-only writes, verification, frozen once verified, replacement and renewal, removal with a reason,
-- permissions (read vs manage), tenant isolation and the evidence link.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('3c000000-0000-0000-0000-000000000901', 'ann@sqc.test'), ('3c000000-0000-0000-0000-000000000902', 'bob@sqc.test'), ('3c000000-0000-0000-0000-000000000903', 'eve@sqc.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '3c000000-0000-0000-0000-000000000901'; bob uuid := '3c000000-0000-0000-0000-000000000902'; eve uuid := '3c000000-0000-0000-0000-000000000903';
  org uuid; org2 uuid; s uuid; s2 uuid; sb uuid; viewer_role uuid; d1 uuid; d2 uuid; d3 uuid; c1 uuid; c2 uuid; c3 uuid; r text; path text; path2 uuid := gen_random_uuid();
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('SQC Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('SQC Beta'); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, bob, 'active');
  SELECT id INTO viewer_role FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, viewer_role FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id = bob;

  PERFORM pg_temp.login(ann);
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'ACME', 'Acme Metals') RETURNING id INTO s;
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'BOLT', 'Bolt Co') RETURNING id INTO s2;
  path := org::text || '/supplier/' || s::text || '/' || gen_random_uuid()::text || '-iso.pdf';

  -- ---- documents ----
  PERFORM pg_temp.assert_fails(format($f$INSERT INTO public.supplier_documents (organisation_id, supplier_id, doc_type, title, storage_path, file_name, size_bytes) VALUES (%L, %L, 'other', 'x', %L, 'x.pdf', 1)$f$, org, s, path), 'documents are written only through the function');
  d1 := app.add_supplier_document(s, 'certificate', 'ISO 9001 certificate', 'A', current_date - 30, current_date + 300, 'Scanned copy', path, 'iso.pdf', 'application/pdf', 1000);
  PERFORM pg_temp.assert_eq((SELECT (status, verified_at IS NULL, file_name)::text FROM public.supplier_documents WHERE id = d1), '(current,t,iso.pdf)', 'a document starts current and unverified');
  r := pg_temp.fails(format($f$SELECT app.add_supplier_document(%L, 'bogus', 'x', NULL, NULL, NULL, NULL, %L, 'x.pdf', NULL, 1)$f$, s, org::text || '/supplier/' || s::text || '/a'));
  PERFORM pg_temp.assert_eq(left(r, 5), '23514', 'an unknown document type is refused');
  r := pg_temp.fails(format($f$SELECT app.add_supplier_document(%L, 'other', 'x', NULL, NULL, NULL, NULL, %L, 'x.pdf', NULL, 1)$f$, s, org::text || '/supplier/' || s2::text || '/a'));
  PERFORM pg_temp.assert_eq(left(r, 5), '23514', 'the file must be in the supplier''s own folder');
  r := pg_temp.fails(format($f$SELECT app.add_supplier_document(%L, 'other', 'x', NULL, current_date, current_date - 1, NULL, %L, 'x.pdf', NULL, 1)$f$, s, org::text || '/supplier/' || s::text || '/b'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM020', 'an expiry before the document date is refused');
  PERFORM app.update_supplier_document(d1, '{"title":"ISO 9001:2015 certificate","revision":"B"}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT (title, revision)::text FROM public.supplier_documents WHERE id = d1), '("ISO 9001:2015 certificate",B)', 'an unverified document can be edited');
  PERFORM app.verify_supplier_document(d1, 'Checked against the issuer''s register');
  PERFORM pg_temp.assert_eq((SELECT (verified_at IS NOT NULL, verified_by = ann)::text FROM public.supplier_documents WHERE id = d1), '(t,t)', 'verification records who and when');
  r := pg_temp.fails(format($f$SELECT app.verify_supplier_document(%L, 'again')$f$, d1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM020', 'verified once');
  r := pg_temp.fails(format($f$SELECT app.update_supplier_document(%L, '{"title":"Changed"}'::jsonb)$f$, d1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM020', 'a verified document is frozen');
  -- a new version replaces it; the old one stays as superseded
  d2 := app.add_supplier_document(s, 'certificate', 'ISO 9001:2015 certificate', 'C', current_date, current_date + 365, NULL,
    org::text || '/supplier/' || s::text || '/' || path2::text || '-iso2.pdf', 'iso2.pdf', 'application/pdf', 2000, d1);
  PERFORM pg_temp.assert_eq((SELECT status FROM public.supplier_documents WHERE id = d1), 'superseded', 'the replaced version is superseded, not deleted');
  PERFORM pg_temp.assert_eq((SELECT replaces_id FROM public.supplier_documents WHERE id = d2), d1, 'and the new one points at it');
  r := pg_temp.fails(format($f$SELECT app.add_supplier_document(%L, 'other', 'x', NULL, NULL, NULL, NULL, %L, 'y.pdf', NULL, 1, %L)$f$, s, org::text || '/supplier/' || s::text || '/c', d1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM020', 'a superseded document cannot be replaced again');
  PERFORM pg_temp.assert_fails(format($f$DELETE FROM public.supplier_documents WHERE id = %L$f$, d1), 'documents are never deleted');
  PERFORM pg_temp.assert_fails(format($f$UPDATE public.supplier_documents SET title = 'x' WHERE id = %L$f$, d2), 'no direct updates either');

  -- ---- certifications ----
  PERFORM pg_temp.assert_fails(format($f$INSERT INTO public.supplier_certifications (organisation_id, supplier_id, cert_type, certificate_number, issuing_body) VALUES (%L, %L, 'iso_9001', '1', 'x')$f$, org, s), 'certifications are written only through the function');
  c1 := app.add_supplier_certification(s, jsonb_build_object('certType', 'iso_9001', 'certificateNumber', 'Q-123', 'issuingBody', 'BSI', 'scope', 'Machining',
    'issuedOn', (current_date - 30)::text, 'expiresOn', (current_date + 335)::text, 'documentId', d2));
  PERFORM pg_temp.assert_eq((SELECT (status, document_id = d2, verified_at IS NULL)::text FROM public.supplier_certifications WHERE id = c1), '(current,t,t)', 'a certification with its evidence document');
  r := pg_temp.fails(format($f$SELECT app.add_supplier_certification(%L, %L::jsonb)$f$, s, jsonb_build_object('certType', 'iso_9001', 'certificateNumber', 'Q-1', 'issuingBody', 'BSI', 'documentId', d1)));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM020', 'evidence must be a current document');
  r := pg_temp.fails(format($f$SELECT app.add_supplier_certification(%L, %L::jsonb)$f$, s2, jsonb_build_object('certType', 'iso_9001', 'certificateNumber', 'Q-1', 'issuingBody', 'BSI', 'documentId', d2)));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM020', 'and a document of this supplier, not another');
  r := pg_temp.fails(format($f$SELECT app.add_supplier_certification(%L, %L::jsonb)$f$, s, jsonb_build_object('certType', 'nonsense', 'certificateNumber', 'Q-1', 'issuingBody', 'BSI')));
  PERFORM pg_temp.assert_eq(left(r, 5), '23514', 'an unknown certification type is refused');
  r := pg_temp.fails(format($f$SELECT app.add_supplier_certification(%L, %L::jsonb)$f$, s, jsonb_build_object('certType', 'iso_9001', 'certificateNumber', 'Q-1', 'issuingBody', 'BSI', 'issuedOn', current_date::text, 'expiresOn', (current_date - 1)::text)));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM020', 'an expiry before the issue date is refused');
  PERFORM app.update_supplier_certification(c1, '{"scope":"CNC machining and finishing"}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT scope FROM public.supplier_certifications WHERE id = c1), 'CNC machining and finishing', 'an unverified certification can be edited');
  PERFORM app.verify_supplier_certification(c1, 'Register checked');
  r := pg_temp.fails(format($f$SELECT app.update_supplier_certification(%L, '{"scope":"x"}'::jsonb)$f$, c1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM020', 'a verified certification is frozen');
  r := pg_temp.fails(format($f$SELECT app.remove_supplier_document(%L, 'Wrong file')$f$, d2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM020', 'a document that is the evidence of a current certification cannot be removed');
  c2 := app.renew_supplier_certification(c1, jsonb_build_object('certificateNumber', 'Q-456', 'issuingBody', 'BSI', 'issuedOn', current_date::text, 'expiresOn', (current_date + 365 * 3)::text));
  PERFORM pg_temp.assert_eq((SELECT status FROM public.supplier_certifications WHERE id = c1), 'superseded', 'renewing supersedes the old certification');
  PERFORM pg_temp.assert_eq((SELECT (cert_type, replaces_id = c1, verified_at IS NULL)::text FROM public.supplier_certifications WHERE id = c2), '(iso_9001,t,t)', 'the renewal keeps the type, points at the old one and is not yet verified');
  r := pg_temp.fails(format($f$SELECT app.renew_supplier_certification(%L, '{}'::jsonb)$f$, c1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM020', 'a superseded certification cannot be renewed');
  r := pg_temp.fails(format($f$SELECT app.withdraw_supplier_certification(%L, '')$f$, c2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM020', 'withdrawing needs a reason');
  PERFORM app.withdraw_supplier_certification(c2, 'Certificate suspended by the body');
  PERFORM pg_temp.assert_eq((SELECT (status, withdrawal_reason)::text FROM public.supplier_certifications WHERE id = c2), '(withdrawn,"Certificate suspended by the body")', 'withdrawn with its reason');
  PERFORM pg_temp.assert_fails(format($f$DELETE FROM public.supplier_certifications WHERE id = %L$f$, c2), 'certifications are never deleted');
  -- removing a document needs a reason and keeps the row
  r := pg_temp.fails(format($f$SELECT app.remove_supplier_document(%L, 'x')$f$, d2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM020', 'a removal reason has a minimum length');
  PERFORM app.remove_supplier_document(d2, 'Uploaded in error');
  PERFORM pg_temp.assert_eq((SELECT (status, removal_reason)::text FROM public.supplier_documents WHERE id = d2), '(removed,"Uploaded in error")', 'removed with its reason, the row stays');
  d3 := app.add_supplier_document(s, 'agreement', 'Quality agreement', NULL, NULL, NULL, NULL, org::text || '/supplier/' || s::text || '/' || gen_random_uuid()::text || '-qa.pdf', 'qa.pdf', NULL, 5);
  PERFORM pg_temp.logout();

  -- ---- a viewer can read but not write ----
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.supplier_documents WHERE supplier_id = s), 3::bigint, 'a viewer reads documents (including superseded and removed ones)');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.supplier_certifications WHERE supplier_id = s), 2::bigint, 'and certifications');
  r := pg_temp.fails(format($f$SELECT app.verify_supplier_document(%L, 'x')$f$, d3));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a viewer cannot verify');
  r := pg_temp.fails(format($f$SELECT app.add_supplier_certification(%L, %L::jsonb)$f$, s, jsonb_build_object('certType', 'iso_9001', 'certificateNumber', 'V-1', 'issuingBody', 'BSI')));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'or add a certification');
  r := pg_temp.fails(format($f$SELECT app.remove_supplier_document(%L, 'because')$f$, d3));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'or remove a document');
  PERFORM pg_temp.logout();

  -- ---- another organisation: nothing crosses ----
  PERFORM pg_temp.login(eve);
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org2, 'BETA', 'Beta Ltd') RETURNING id INTO sb;
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.supplier_documents) + (SELECT count(*) FROM public.supplier_certifications), 0::bigint, 'another organisation sees none');
  r := pg_temp.fails(format($f$SELECT app.add_supplier_certification(%L, %L::jsonb)$f$, s, jsonb_build_object('certType', 'iso_9001', 'certificateNumber', 'X', 'issuingBody', 'Y')));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'it cannot add one to a foreign supplier (as if it did not exist)');
  r := pg_temp.fails(format($f$SELECT app.verify_supplier_document(%L, 'x')$f$, d3));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'or verify a foreign document');
  r := pg_temp.fails(format($f$SELECT app.withdraw_supplier_certification(%L, 'Not yours')$f$, c2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'or withdraw a foreign certification');
  PERFORM pg_temp.logout();

  -- ---- audited ----
  PERFORM pg_temp.assert_eq((SELECT count(*) >= 6 FROM public.audit_events WHERE entity_type IN ('supplier_documents', 'supplier_certifications')), true, 'the records are audited');
END $$;
ROLLBACK;
