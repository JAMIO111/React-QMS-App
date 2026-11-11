-- Document control DC5: external documents — created with an issuer, always files, revisions recorded as issued without internal review, the origin fixed.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('41000000-0000-0000-0000-000000000b01', 'ann@ex.test'), ('41000000-0000-0000-0000-000000000b02', 'cat@ex.test'), ('41000000-0000-0000-0000-000000000b03', 'eve@ex.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '41000000-0000-0000-0000-000000000b01'; cat uuid := '41000000-0000-0000-0000-000000000b02'; eve uuid := '41000000-0000-0000-0000-000000000b03';
  org uuid; org2 uuid; ext uuid; sop uuid; d1 uuid; d2 uuid; r1 uuid; r2 uuid; r3 uuid; r text;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('EX Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('EX Beta'); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, cat, 'active');
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = 'quality_engineer') FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id = cat;

  PERFORM pg_temp.login(cat);
  SELECT id INTO ext FROM public.document_types WHERE organisation_id = org AND prefix = 'EXT';
  SELECT id INTO sop FROM public.document_types WHERE organisation_id = org AND prefix = 'SOP';
  r := pg_temp.fails(format($f$SELECT app.create_external_document(%L, jsonb_build_object('typeId', %L, 'title', 'Customer spec'))$f$, org, ext));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'an external document names its issuer');
  r := pg_temp.fails(format($f$SELECT app.create_external_document(%L, jsonb_build_object('typeId', %L, 'title', 'X', 'issuer', 'Acme', 'contentKind', 'text'))$f$, org, ext));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'an external document is always a file');
  d1 := app.create_external_document(org, jsonb_build_object('typeId', ext, 'title', 'Acme customer specification', 'issuer', 'Acme Ltd', 'externalReference', 'ACS-1001'));
  PERFORM pg_temp.assert_eq((SELECT number || '/' || origin || '/' || content_kind || '/' || issuer || '/' || external_reference FROM public.documents WHERE id = d1),
    'EXT-001/external/file/Acme Ltd/ACS-1001', 'numbered from its type, with the issuer and their reference');
  SELECT id INTO r1 FROM public.document_revisions WHERE document_id = d1;
  r := pg_temp.fails(format('SELECT app.submit_document_revision(%L)', r1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'no internal review for an external document');
  PERFORM pg_temp.assert_eq(app.document_revision_problems(r1), ARRAY['Upload the main file'], 'an external draft needs only its file');
  PERFORM app.add_document_file(r1, 'main', org || '/document/' || r1 || '/acs.pdf', 'acs.pdf', 'application/pdf', 100);
  r := pg_temp.fails(format('SELECT app.issue_external_revision(%L, %L, current_date)', r1, '3'));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'recording an issue needs documentation.issue');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login(ann);
  r := pg_temp.fails(format('SELECT app.issue_external_revision(%L, %L, current_date)', r1, ''));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'the issuer''s revision is needed');
  PERFORM app.issue_external_revision(r1, 'Issue 3', current_date - 20);
  PERFORM pg_temp.assert_eq((SELECT status || '/' || letter || '/' || issuer_revision || '/' || (effective_from = current_date - 20) FROM public.document_revisions WHERE id = r1),
    'effective/A/Issue 3/true', 'in force at once, our letter A, their Issue 3, effective from the date given');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.documents WHERE id = d1), 'active', 'the document is in force');

  -- the next issue
  r2 := app.start_document_revision(d1);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.document_revision_files WHERE revision_id = r2 AND deleted_at IS NULL), 1::bigint, 'the file is copied forward');
  PERFORM app.add_document_file(r2, 'main', org || '/document/' || r2 || '/acs4.pdf', 'acs4.pdf', 'application/pdf', 100);
  r := pg_temp.fails(format('SELECT app.issue_external_revision(%L, %L, current_date)', r2, 'Issue 4'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'a later issue says what changed');
  PERFORM app.issue_external_revision(r2, 'Issue 4', current_date + 7, 'Tighter flatness tolerance');
  PERFORM pg_temp.assert_eq((SELECT string_agg(letter || ':' || status, ',' ORDER BY sequence) FROM public.document_revisions WHERE document_id = d1), 'A:effective,B:approved',
    'a future date waits; the one in force stays');
  r := pg_temp.fails(format($f$UPDATE public.document_revisions SET issuer_revision = 'x' WHERE id = %L$f$, r2));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'no direct writes');
  PERFORM app.update_external_details(d1, '{"externalReference":"ACS-1001/B"}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT external_reference FROM public.documents WHERE id = d1), 'ACS-1001/B', 'the reference can change');

  -- internal documents keep their review
  d2 := app.create_document(org, jsonb_build_object('typeId', sop, 'title', 'Internal', 'contentKind', 'file'));
  SELECT id INTO r3 FROM public.document_revisions WHERE document_id = d2;
  PERFORM app.add_document_file(r3, 'main', org || '/document/' || r3 || '/i.pdf', 'i.pdf', 'application/pdf', 1);
  r := pg_temp.fails(format('SELECT app.issue_external_revision(%L, %L, current_date)', r3, '1'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'an internal document cannot skip review');
  r := pg_temp.fails(format($f$SELECT app.update_external_details(%L, '{"issuer":"x"}'::jsonb)$f$, d2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'nor has external details');
  PERFORM pg_temp.logout();

  -- the database holds the rules for SQL too
  r := pg_temp.fails(format($f$UPDATE public.documents SET origin = 'internal', issuer = NULL WHERE id = %L$f$, d1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'the origin never changes');
  r := pg_temp.fails(format($f$UPDATE public.document_revisions SET status = 'approved', letter = 'A', approved_at = now(), effective_from = current_date WHERE id = %L$f$, r3));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'an internal draft never goes straight to approved');
  PERFORM pg_temp.login(eve);
  r := pg_temp.fails(format('SELECT app.issue_external_revision(%L, %L, current_date)', r2, 'Hijack'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'another organisation finds nothing');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
