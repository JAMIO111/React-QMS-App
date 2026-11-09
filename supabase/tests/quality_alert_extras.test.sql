-- DOC3: attachments (draft only, by functions, kept when removed, copied by a revision) and links (checked, replaced as a
-- whole, copied by a revision), plus the storage rules for the quality-alert-files bucket and isolation between organisations.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('3f000000-0000-0000-0000-000000000201', 'owner@extras.test'),
  ('3f000000-0000-0000-0000-000000000202', 'viewer@extras.test'),
  ('3f000000-0000-0000-0000-000000000203', 'other@extras.test');

DO $$
DECLARE
  org uuid; org2 uuid; site uuid; gi uuid; viewer uuid; m_view uuid; supplier uuid; supplier2 uuid;
  a uuid; a2 uuid; att uuid; att2 uuid; path text; path2 text;
BEGIN
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000201');
  org := app.create_organisation('Extras Works', 'Plant A', 'PA', NULL);
  SELECT id INTO site FROM public.sites WHERE organisation_id = org;
  INSERT INTO public.departments (organisation_id, site_id, code, name) VALUES (org, site, 'GI', 'Goods-in') RETURNING id INTO gi;
  SELECT id INTO viewer FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'SUP1', 'Bar Co') RETURNING id INTO supplier;
  PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '3f000000-0000-0000-0000-000000000202', 'active') RETURNING id INTO m_view;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) VALUES (org, m_view, viewer);
  INSERT INTO public.department_members (organisation_id, department_id, membership_id) VALUES (org, gi, m_view);

  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000203');
  org2 := app.create_organisation('Other Works', 'Plant B', 'PB', NULL);
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org2, 'SUPX', 'Other Co') RETURNING id INTO supplier2;
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000201');
  INSERT INTO public.quality_alerts (organisation_id, title, category, severity, description, required_action, effective_date)
    VALUES (org, 'Wrong spec on bar stock', 'supplier', 'low', 'd', 'a', current_date) RETURNING id INTO a;
  PERFORM app.set_quality_alert_actions(a, '[{"description":"a"}]'::jsonb);
  PERFORM app.set_quality_alert_scope(a, jsonb_build_object('targets', jsonb_build_array(jsonb_build_object('departmentId', gi))));
  path := org::text || '/quality-alerts/' || a::text || '/' || gen_random_uuid() || '-cert.pdf';

  -- Attachments: in the alert's own folder only; direct writes are refused.
  PERFORM pg_temp.assert_fails(format($q$SELECT app.add_quality_alert_attachment(%L, %L, 'x.pdf', 'application/pdf', 5)$q$, a, org::text || '/quality-alerts/' || gen_random_uuid() || '/x.pdf'), 'a file in another alert''s folder is refused');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.add_quality_alert_attachment(%L, %L, 'x.pdf', 'application/pdf', 99999999999)$q$, a, path), 'too large');
  att := app.add_quality_alert_attachment(a, path, 'cert.pdf', 'application/pdf', 1234, '  Mill certificate ');
  PERFORM pg_temp.assert_eq((SELECT description FROM public.quality_alert_attachments WHERE id = att), 'Mill certificate', 'description trimmed');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.quality_alert_attachments (organisation_id, alert_id, storage_path, file_name, size_bytes) VALUES (%L, %L, %L, 'y', 1)$q$, org, a, path || '2'), 'no direct insert');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.add_quality_alert_attachment(%L, %L, 'cert.pdf', 'application/pdf', 1)$q$, a, path), 'the same file twice');

  -- Links: replaced as a whole, checked, one record once.
  PERFORM app.set_quality_alert_links(a, jsonb_build_array(jsonb_build_object('supplierId', supplier)));
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.quality_alert_links WHERE alert_id = a), 1::bigint, 'one link');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.set_quality_alert_links(%L, %L::jsonb)$q$, a, jsonb_build_array(jsonb_build_object('supplierId', supplier2))), 'a supplier of another organisation cannot be linked');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.quality_alert_links WHERE alert_id = a), 1::bigint, 'a refused change leaves the links as they were');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.set_quality_alert_links(%L, %L::jsonb)$q$, a, jsonb_build_array(jsonb_build_object('supplierId', supplier), jsonb_build_object('supplierId', supplier))), 'not twice');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.set_quality_alert_links(%L, %L::jsonb)$q$, a, jsonb_build_array(jsonb_build_object('supplierId', supplier, 'gaugeId', gen_random_uuid()))), 'one record per link');
  PERFORM pg_temp.assert_fails($q$DELETE FROM public.quality_alert_links$q$, 'no direct delete');

  -- A second file, then removed (marked only); a removed file cannot be removed twice.
  path2 := org::text || '/quality-alerts/' || a::text || '/' || gen_random_uuid() || '-photo.jpg';
  att2 := app.add_quality_alert_attachment(a, path2, 'photo.jpg', 'image/jpeg', 10);
  PERFORM app.remove_quality_alert_attachment(att2, '  Wrong photo ');
  PERFORM pg_temp.assert_eq((SELECT (deleted_at IS NOT NULL, delete_reason)::text FROM public.quality_alert_attachments WHERE id = att2), '(t,"Wrong photo")', 'removed is marked, with the reason');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.remove_quality_alert_attachment(%L, 'again')$q$, att2), 'already removed');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.restore_quality_alert_attachment(%L)$q$, att), 'a file that is not removed cannot be restored');
  PERFORM app.restore_quality_alert_attachment(att2);
  PERFORM pg_temp.assert_eq((SELECT deleted_at IS NULL FROM public.quality_alert_attachments WHERE id = att2), true, 'restored');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.remove_quality_alert_attachment(%L, ' ')$q$, att2), 'a reason is needed');
  PERFORM app.remove_quality_alert_attachment(att2, 'Wrong photo');
  PERFORM pg_temp.assert_fails(format($q$DELETE FROM public.quality_alert_attachments WHERE id = %L$q$, att2), 'never deleted');
  PERFORM pg_temp.logout();

  -- A viewer cannot add, remove or link, and cannot see the draft's files.
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000202');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.add_quality_alert_attachment(%L, %L, 'v.pdf', 'application/pdf', 1)$q$, a, org::text || '/quality-alerts/' || a::text || '/v.pdf'), 'a viewer cannot add a file');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.set_quality_alert_links(%L, '[]'::jsonb)$q$, a), 'a viewer cannot change links');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.quality_alert_attachments), 0::bigint, 'a draft''s files are hidden from a viewer');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.quality_alert_links), 0::bigint, 'and its links');
  PERFORM pg_temp.assert_eq(app.quality_alert_file_allowed(path, false), false, 'storage: a viewer cannot read a draft''s file');
  PERFORM pg_temp.assert_eq(app.quality_alert_file_allowed(path, true), false, 'storage: a viewer cannot upload');
  PERFORM pg_temp.logout();

  -- Issued: frozen. Files and links stay readable by a recipient with documentation.read.
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000201');
  PERFORM pg_temp.assert_eq(app.quality_alert_file_allowed(path, true), true, 'storage: the manager uploads into a draft''s folder');
  PERFORM app.issue_quality_alert(a);
  PERFORM pg_temp.assert_fails(format($q$SELECT app.add_quality_alert_attachment(%L, %L, 'late.pdf', 'application/pdf', 1)$q$, a, org::text || '/quality-alerts/' || a::text || '/late.pdf'), 'no files on an issued alert');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.remove_quality_alert_attachment(%L, 'late')$q$, att), 'no removal from an issued alert');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.set_quality_alert_links(%L, '[]'::jsonb)$q$, a), 'no link changes on an issued alert');
  PERFORM pg_temp.assert_eq(app.quality_alert_file_allowed(path, true), false, 'storage: no uploads into an issued alert''s folder');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000202');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.quality_alert_attachments), 2::bigint, 'a recipient sees the files of an issued alert (including the removed mark)');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.quality_alert_links), 1::bigint, 'and its links');
  PERFORM pg_temp.assert_eq(app.quality_alert_file_allowed(path, false), true, 'storage: and can read them');
  PERFORM pg_temp.logout();

  -- Another organisation sees and reads nothing.
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000203');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.quality_alert_attachments), 0::bigint, 'isolation: attachments');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.quality_alert_links), 0::bigint, 'isolation: links');
  PERFORM pg_temp.assert_eq(app.quality_alert_file_allowed(path, false), false, 'isolation: storage');
  PERFORM pg_temp.logout();

  -- A revision starts with the live files and the links, pointing at the same stored files.
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000201');
  a2 := app.revise_quality_alert(a, 'Certificate corrected');
  PERFORM pg_temp.assert_eq((SELECT array_agg(storage_path) FROM public.quality_alert_attachments WHERE alert_id = a2), ARRAY[path], 'the revision copies live files only, same stored file');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.quality_alert_links WHERE alert_id = a2 AND supplier_id = supplier), 1::bigint, 'and the links');
  -- The copy can be removed in the draft without touching the issued alert's row.
  PERFORM app.remove_quality_alert_attachment((SELECT id FROM public.quality_alert_attachments WHERE alert_id = a2), 'Not needed now');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.quality_alert_attachments WHERE alert_id = a AND deleted_at IS NULL), 1::bigint, 'the issued alert keeps its file');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
