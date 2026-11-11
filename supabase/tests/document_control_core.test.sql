-- Document control DC1: types, numbering, documents and their draft revisions, text bodies, files, who reads drafts, nothing deleted.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('3d000000-0000-0000-0000-000000000b01', 'ann@dc.test'), ('3d000000-0000-0000-0000-000000000b02', 'bob@dc.test'),
  ('3d000000-0000-0000-0000-000000000b03', 'eve@dc.test'), ('3d000000-0000-0000-0000-000000000b04', 'cat@dc.test'),
  ('3d000000-0000-0000-0000-000000000b05', 'gus@dc.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '3d000000-0000-0000-0000-000000000b01'; bob uuid := '3d000000-0000-0000-0000-000000000b02'; eve uuid := '3d000000-0000-0000-0000-000000000b03';
  cat uuid := '3d000000-0000-0000-0000-000000000b04'; gus uuid := '3d000000-0000-0000-0000-000000000b05';
  org uuid; org2 uuid; sop uuid; frm uuid; t_new uuid; d1 uuid; d2 uuid; d3 uuid; d4 uuid; r1 uuid; r2 uuid; r4 uuid; f1 uuid; f2 uuid; f3 uuid; r text;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('DC Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('DC Beta'); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, bob, 'active'), (org, cat, 'active'), (org, gus, 'suspended');
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = CASE ou.user_id WHEN cat THEN 'quality_engineer' ELSE 'viewer' END)
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id IN (bob, cat, gus);

  -- ---- types: seeded, managed by functions ----
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq((SELECT string_agg(prefix, ',' ORDER BY sequence) FROM public.document_types WHERE organisation_id = org), 'SOP,WI,FRM,SPEC,POL,EXT', 'six types seeded, readable with documentation.read');
  r := pg_temp.fails(format($f$SELECT app.save_document_type(%L, '{"name":"Drawing","prefix":"DWG"}'::jsonb)$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a viewer cannot add a type');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login(cat);
  SELECT id INTO sop FROM public.document_types WHERE organisation_id = org AND prefix = 'SOP';
  SELECT id INTO frm FROM public.document_types WHERE organisation_id = org AND prefix = 'FRM';
  t_new := app.save_document_type(org, '{"name":"Drawing","prefix":"dwg","reviewMonths":60,"contentHint":"file"}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT prefix || '/' || review_months FROM public.document_types WHERE id = t_new), 'DWG/60', 'a type is added; the prefix is upper-cased');
  r := pg_temp.fails(format($f$SELECT app.save_document_type(%L, '{"name":"Other","prefix":"SOP"}'::jsonb)$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'a prefix is unique');
  r := pg_temp.fails(format($f$SELECT app.save_document_type(%L, '{"name":"procedure","prefix":"PR"}'::jsonb)$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'a name is unique among active types, ignoring case');
  r := pg_temp.fails(format($f$SELECT app.save_document_type(%L, '{"name":"Bad","prefix":"-X"}'::jsonb)$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'a prefix starts with a letter or digit');
  r := pg_temp.fails(format($f$SELECT app.save_document_type(%L, '{"name":"Bad","prefix":"BD","reviewMonths":0}'::jsonb)$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'the review interval is 1 to 120 months');
  PERFORM app.save_document_type(org, '{"prefix":"DRG"}'::jsonb, t_new);
  PERFORM pg_temp.assert_eq((SELECT prefix FROM public.document_types WHERE id = t_new), 'DRG', 'an unused prefix can change');
  r := pg_temp.fails(format($f$SELECT app.save_document_type(%L, '{"name":"X"}'::jsonb, %L)$f$, org2, sop));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'another organisation is not found');
  r := pg_temp.fails(format($f$INSERT INTO public.document_types (organisation_id, name, prefix) VALUES (%L, 'X', 'XX')$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'no direct table writes');

  -- ---- documents: numbering ----
  d1 := app.create_document(org, jsonb_build_object('typeId', sop, 'title', 'Control of nonconforming product', 'contentKind', 'text'));
  PERFORM pg_temp.assert_eq((SELECT number || '/' || status || '/' || start_letter FROM public.documents WHERE id = d1), 'SOP-001/draft/A', 'numbered from the type, a draft, to be rev A');
  PERFORM pg_temp.assert_eq((SELECT owner_user_id FROM public.documents WHERE id = d1), cat, 'the creator owns it by default');
  PERFORM pg_temp.assert_eq((SELECT sequence || '/' || status || '/' || coalesce(letter, '-') || '/' || (author_id = cat) FROM public.document_revisions WHERE document_id = d1),
    '1/draft/-/true', 'with a first draft, no letter yet, written by the creator');
  d2 := app.create_document(org, jsonb_build_object('typeId', sop, 'title', 'Calibration', 'contentKind', 'file', 'number', 'sop-007', 'startLetter', 'c'));
  PERFORM pg_temp.assert_eq((SELECT number || '/' || start_letter || '/' || number_typed FROM public.documents WHERE id = d2), 'sop-007/C/true', 'a typed number and letter when bringing a document across');
  d3 := app.create_document(org, jsonb_build_object('typeId', sop, 'title', 'Purchasing', 'contentKind', 'text', 'ownerId', bob));
  PERFORM pg_temp.assert_eq((SELECT number FROM public.documents WHERE id = d3), 'SOP-008', 'a typed SOP-007 moves the sequence past it');
  r := pg_temp.fails(format($f$SELECT app.create_document(%L, jsonb_build_object('typeId', %L, 'title', 'X', 'contentKind', 'file', 'number', 'SOP-001', 'startLetter', 'A'))$f$, org, sop));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'a number is unique ignoring case');
  r := pg_temp.fails(format($f$SELECT app.create_document(%L, jsonb_build_object('typeId', %L, 'title', 'X', 'contentKind', 'file', 'number', 'OLD-1'))$f$, org, sop));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'a typed number needs the letter too');
  r := pg_temp.fails(format($f$SELECT app.create_document(%L, jsonb_build_object('typeId', %L, 'title', 'X', 'contentKind', 'pdf'))$f$, org, sop));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'the content kind is file or text');
  r := pg_temp.fails(format($f$SELECT app.create_document(%L, jsonb_build_object('typeId', %L, 'title', 'X', 'contentKind', 'file', 'ownerId', %L))$f$, org, sop, gus));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'the owner is an active member');
  r := pg_temp.fails(format($f$SELECT app.create_document(%L, jsonb_build_object('typeId', %L, 'title', 'X', 'contentKind', 'file'))$f$, org,
        (SELECT id FROM public.document_types WHERE organisation_id = org2 AND prefix = 'SOP')));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'a type of another organisation is refused');
  r := pg_temp.fails(format($f$SELECT app.create_document(%L, jsonb_build_object('typeId', %L, 'title', 'X', 'contentKind', 'file', 'oops', 1))$f$, org, sop));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'an unknown field is refused');
  r := pg_temp.fails(format($f$SELECT app.save_document_type(%L, '{"prefix":"PROC"}'::jsonb, %L)$f$, org, sop));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'a prefix in use never changes');
  PERFORM app.save_document_type(org, '{"active":false}'::jsonb, t_new);
  r := pg_temp.fails(format($f$SELECT app.create_document(%L, jsonb_build_object('typeId', %L, 'title', 'X', 'contentKind', 'file'))$f$, org, t_new));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'a switched-off type takes no new documents');

  -- ---- header ----
  PERFORM app.update_document(d1, '{"title":"Control of nonconforming product (rev)","description":"Scope: all sites"}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT title FROM public.documents WHERE id = d1), 'Control of nonconforming product (rev)', 'the title changes');
  r := pg_temp.fails(format($f$SELECT app.update_document(%L, '{"contentKind":"file"}'::jsonb)$f$, d1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'the content kind never changes');
  r := pg_temp.fails(format($f$UPDATE public.documents SET number = 'X' WHERE id = %L$f$, d1));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'no direct updates');

  -- ---- a text draft ----
  SELECT id INTO r1 FROM public.document_revisions WHERE document_id = d1;
  PERFORM app.update_document_revision(r1, jsonb_build_object('changeSummary', 'First issue', 'body',
    '{"type":"doc","content":[{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"Purpose"}]},{"type":"paragraph","content":[{"type":"text","text":"Segregate  suspect"},{"type":"text","marks":[{"type":"bold"}],"text":" parts."}]}]}'::jsonb));
  PERFORM pg_temp.assert_eq((SELECT body_text FROM public.document_revisions WHERE id = r1), 'Purpose Segregate suspect parts.', 'the plain text is worked out for search');
  r := pg_temp.fails(format($f$SELECT app.update_document_revision(%L, '{"body":{"type":"paragraph"}}'::jsonb)$f$, r1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'the body is an editor document');
  r := pg_temp.fails(format($f$SELECT app.update_document_revision(%L, '{"body":"<p>x</p>"}'::jsonb)$f$, r1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'no HTML is accepted');
  r := pg_temp.fails(format($f$SELECT app.add_document_file(%L, 'main', %L, 'x.pdf', 'application/pdf', 10)$f$, r1, org || '/document/' || r1 || '/x.pdf'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'a text document has no main file');
  f3 := app.add_document_file(r1, 'attachment', org || '/document/' || r1 || '/flow.png', 'flow.png', 'image/png', 10);
  PERFORM pg_temp.assert_eq((SELECT role FROM public.document_revision_files WHERE id = f3), 'attachment', 'but it may carry attachments');

  -- ---- a file draft ----
  SELECT id INTO r2 FROM public.document_revisions WHERE document_id = d2;
  r := pg_temp.fails(format($f$SELECT app.update_document_revision(%L, '{"body":{"type":"doc"}}'::jsonb)$f$, r2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'a file document has no text body');
  f1 := app.add_document_file(r2, 'main', org || '/document/' || r2 || '/a-cal.docx', 'cal.docx', 'application/msword', 100);
  r := pg_temp.fails(format($f$SELECT app.add_document_file(%L, 'main', %L, 'x.pdf', 'application/pdf', 10)$f$, r2, org || '/document/' || r1 || '/x.pdf'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'a file goes in its own revision''s folder');
  f2 := app.add_document_file(r2, 'main', org || '/document/' || r2 || '/b-cal.pdf', 'cal.pdf', 'application/pdf', 100);
  PERFORM pg_temp.assert_eq((SELECT delete_reason FROM public.document_revision_files WHERE id = f1), 'Replaced by cal.pdf', 'a new main file replaces the old one');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.document_revision_files WHERE revision_id = r2 AND role = 'main' AND deleted_at IS NULL), 1::bigint, 'one live main file');
  r := pg_temp.fails(format($f$SELECT app.restore_document_file(%L)$f$, f1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'a replaced main file comes back only once the current one is removed');
  r := pg_temp.fails(format($f$SELECT app.remove_document_file(%L, 'x')$f$, f2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'removing a file needs a reason');
  PERFORM app.remove_document_file(f2, 'Wrong file');
  PERFORM app.restore_document_file(f1);
  PERFORM pg_temp.assert_eq((SELECT file_name FROM public.document_revision_files WHERE revision_id = r2 AND role = 'main' AND deleted_at IS NULL), 'cal.docx', 'restored');
  PERFORM pg_temp.logout();

  -- ---- who reads drafts ----
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.documents WHERE organisation_id = org), 1::bigint, 'a viewer sees only the draft document they own');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.document_revisions WHERE organisation_id = org), 1::bigint, 'and its draft');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.document_revision_files WHERE organisation_id = org), 0::bigint, 'no other draft files');
  PERFORM pg_temp.assert_eq(app.document_file_allowed(org || '/document/' || r2 || '/a-cal.docx', false), false, 'nor the stored file');
  r := pg_temp.fails(format($f$SELECT app.update_document_revision(%L, '{"changeSummary":"x"}'::jsonb)$f$, (SELECT id FROM public.document_revisions WHERE document_id = d3)));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'an owner without documentation.manage cannot edit the draft');
  r := pg_temp.fails(format($f$SELECT app.update_document_revision(%L, '{"changeSummary":"x"}'::jsonb)$f$, r1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'someone else''s draft is not found');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.documents WHERE organisation_id = org), 3::bigint, 'a document manager sees every draft');
  PERFORM pg_temp.assert_eq(app.document_file_allowed(org || '/document/' || r2 || '/a-cal.docx', false), true, 'and reads its files');
  PERFORM pg_temp.assert_eq(app.document_file_allowed(org || '/document/' || r2 || '/new.pdf', true), true, 'and uploads into a draft');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.documents WHERE organisation_id = org), 0::bigint, 'another organisation sees nothing');
  r := pg_temp.fails(format($f$SELECT app.update_document(%L, '{"title":"x"}'::jsonb)$f$, d1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'and finds nothing');
  PERFORM pg_temp.logout();

  -- ---- discarding ----
  PERFORM pg_temp.login(cat);
  d4 := app.create_document(org, jsonb_build_object('typeId', frm, 'title', 'Old form', 'contentKind', 'file'));
  SELECT id INTO r4 FROM public.document_revisions WHERE document_id = d4;
  r := pg_temp.fails(format($f$SELECT app.discard_document_revision(%L, 'no')$f$, r4));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'discarding needs a reason');
  PERFORM app.discard_document_revision(r4, 'Not needed after all');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.document_revisions WHERE id = r4) || '/' || (SELECT status FROM public.documents WHERE id = d4), 'discarded/discarded',
    'discarding the only draft discards the document');
  r := pg_temp.fails(format($f$SELECT app.update_document_revision(%L, '{"changeSummary":"x"}'::jsonb)$f$, r4));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'a discarded draft cannot change');
  r := pg_temp.fails(format($f$SELECT app.update_document(%L, '{"title":"x"}'::jsonb)$f$, d4));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'nor a discarded document');
  d4 := app.create_document(org, jsonb_build_object('typeId', frm, 'title', 'New form', 'contentKind', 'file'));
  PERFORM pg_temp.assert_eq((SELECT number FROM public.documents WHERE id = d4), 'FRM-002', 'a discarded number is never reused');
  PERFORM pg_temp.logout();

  -- ---- the database holds the rules for SQL too ----
  r := pg_temp.fails(format($f$DELETE FROM public.documents WHERE id = %L$f$, d1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'a document is never deleted');
  r := pg_temp.fails(format($f$DELETE FROM public.document_revisions WHERE id = %L$f$, r1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'a revision is never deleted');
  r := pg_temp.fails(format($f$DELETE FROM public.document_revision_files WHERE id = %L$f$, f3));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'a file is never deleted');
  r := pg_temp.fails(format($f$UPDATE public.documents SET content_kind = 'file' WHERE id = %L$f$, d1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'the kind never changes');
  UPDATE public.document_revisions SET status = 'in_review', letter = 'A' WHERE id = r1;
  r := pg_temp.fails(format($f$UPDATE public.document_revisions SET change_summary = 'x' WHERE id = %L$f$, r1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'content is frozen once submitted');
  r := pg_temp.fails(format($f$UPDATE public.document_revisions SET letter = 'B' WHERE id = %L$f$, r1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'a letter never changes');
  r := pg_temp.fails(format($f$INSERT INTO public.document_revision_files (organisation_id, revision_id, role, storage_path, file_name, size_bytes) VALUES (%L, %L, 'attachment', %L, 'x', 1)$f$,
        org, r1, org || '/document/' || r1 || '/x'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'files are frozen once submitted');
  r := pg_temp.fails(format($f$INSERT INTO public.document_revisions (organisation_id, document_id, sequence, author_id) VALUES (%L, %L, 2, %L)$f$, org, d1, cat));
  PERFORM pg_temp.assert_eq(left(r, 5), '23505', 'one revision in progress per document');
  PERFORM pg_temp.assert_eq(app.document_letter_after(NULL) || app.document_letter_after('A') || ',' || app.document_letter_after('Z') || ',' || app.document_letter_after('AZ')
    || ',' || app.document_letter_after('ZZ'), 'AB,AA,BA,AAA', 'letters run A … Z, AA … ZZ, AAA');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM audit.events WHERE entity_type = 'documents' AND organisation_id = org) > 0, true, 'changes are audited');
END $$;

ROLLBACK;
