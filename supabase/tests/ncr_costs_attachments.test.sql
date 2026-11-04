-- NCR costs and attachments: amounts worked out in the database, locking with the NCR, soft
-- delete, site scoping through the parent NCR, storage folder rules and isolation.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('21000000-0000-0000-0000-000000000101', 'owner@costs.test'),
  ('21000000-0000-0000-0000-000000000102', 'inspector@costs.test'),
  ('21000000-0000-0000-0000-000000000103', 'other@costs.test');

CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);
GRANT SELECT ON ids TO authenticated;

DO $$
DECLARE
  org uuid; other uuid; site_a uuid; site_b uuid; ncr uuid; ncr_b uuid; c uuid; f uuid; m uuid;
BEGIN
  PERFORM pg_temp.login('21000000-0000-0000-0000-000000000101');
  org := app.create_organisation('Cost Works', 'Plant A', 'PA', NULL);
  SELECT id INTO site_a FROM public.sites WHERE organisation_id = org;
  INSERT INTO public.sites (organisation_id, code, name) VALUES (org, 'PB', 'Plant B') RETURNING id INTO site_b;
  UPDATE public.organisation_settings SET base_currency = 'GBP', vat_rate = 0.2 WHERE organisation_id = org;
  INSERT INTO public.nonconformances (organisation_id, reference, source, stage, title, site_id, severity, quantity_affected, description)
    VALUES (org, 'x', 'internal', 'open', 'Scrapped batch', site_a, 'major', 10, 'Scrap') RETURNING id INTO ncr;
  INSERT INTO public.nonconformances (organisation_id, reference, source, title, site_id) VALUES (org, 'x', 'internal', 'At plant B', site_b) RETURNING id INTO ncr_b;

  -- Amounts: inclusive / exclusive / no VAT, rounding, base currency.
  INSERT INTO public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, vat_treatment, vat_rate, amount, net_amount, gross_base)
    VALUES (org, ncr, 'scrap', 'GBP', 'inclusive', 0.2, 120, 999, 999) RETURNING id INTO c;
  PERFORM pg_temp.assert_eq((SELECT net_amount || '|' || vat_amount || '|' || gross_amount || '|' || base_currency || '|' || gross_base FROM public.ncr_costs WHERE id = c),
    '100.00|20.00|120.00|GBP|120.00', 'VAT-inclusive amount split; supplied totals ignored');
  INSERT INTO public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, vat_treatment, vat_rate, amount)
    VALUES (org, ncr, 'labour', 'GBP', 'exclusive', 0.2, 33.33) RETURNING id INTO c;
  PERFORM pg_temp.assert_eq((SELECT net_amount || '|' || vat_amount || '|' || gross_amount FROM public.ncr_costs WHERE id = c), '33.33|6.67|40.00', 'VAT added to exclusive amount');
  INSERT INTO public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, vat_treatment, vat_rate, amount, exchange_rate)
    VALUES (org, ncr, 'transport', 'EUR', 'none', 0.2, 50, 0.85) RETURNING id INTO c;
  PERFORM pg_temp.assert_eq((SELECT vat_rate || '|' || gross_amount || '|' || net_base || '|' || gross_base FROM public.ncr_costs WHERE id = c), '0|50.00|42.50|42.50', 'no VAT; converted to base currency');
  INSERT INTO public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, amount, exchange_rate)
    VALUES (org, ncr, 'admin', 'GBP', 10, 3) RETURNING id INTO c;
  PERFORM pg_temp.assert_eq((SELECT exchange_rate || '|' || gross_base FROM public.ncr_costs WHERE id = c), '1|10.00', 'base-currency costs use rate 1');
  UPDATE public.ncr_costs SET amount = 12 WHERE id = c;
  PERFORM pg_temp.assert_eq((SELECT gross_base FROM public.ncr_costs WHERE id = c), 12.00, 'recalculated on edit');
  PERFORM pg_temp.assert_eq((SELECT created_by FROM public.ncr_costs WHERE id = c), '21000000-0000-0000-0000-000000000101'::uuid, 'creator stamped');

  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, amount) VALUES (%L, %L, 'bribes', 'GBP', 1)$q$, org, ncr), 'unknown cost type');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, amount) VALUES (%L, %L, 'scrap', 'GBP', -1)$q$, org, ncr), 'no negative amounts');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, amount) VALUES (%L, %L, 'scrap', 'pounds', 1)$q$, org, ncr), 'currency is an ISO code');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.ncr_costs SET net_amount = 1 WHERE id = %L$q$, c), 'totals are not user-editable');
  PERFORM pg_temp.assert_fails(format($q$DELETE FROM public.ncr_costs WHERE id = %L$q$, c), 'costs are never hard-deleted');

  -- Soft delete with a reason, stamped by the system; deleted costs are locked; restore.
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.ncr_costs SET deleted_at = now() WHERE id = %L$q$, c), 'deleting a cost needs a reason');
  UPDATE public.ncr_costs SET deleted_at = '2000-01-01', delete_reason = 'Duplicate' WHERE id = c;
  PERFORM pg_temp.assert_eq((SELECT (deleted_at > now() - interval '1 minute') || '|' || deleted_by FROM public.ncr_costs WHERE id = c), 'true|21000000-0000-0000-0000-000000000101', 'deletion stamped');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.ncr_costs SET amount = 99 WHERE id = %L$q$, c), 'deleted costs are locked');
  UPDATE public.ncr_costs SET deleted_at = NULL WHERE id = c;
  PERFORM pg_temp.assert_eq((SELECT coalesce(delete_reason, '-') FROM public.ncr_costs WHERE id = c), '-', 'restored');

  -- Attachments: must sit in this NCR's folder.
  INSERT INTO public.ncr_attachments (organisation_id, nonconformance_id, storage_path, file_name, content_type, size_bytes)
    VALUES (org, ncr, org || '/ncr/' || ncr || '/a1-photo.jpg', 'photo.jpg', 'image/jpeg', 1000) RETURNING id INTO f;
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.ncr_attachments (organisation_id, nonconformance_id, storage_path, file_name, size_bytes) VALUES (%L, %L, %L, 'x', 1)$q$,
    org, ncr, org || '/ncr/' || ncr_b || '/x.jpg'), 'file must be in this NCR''s folder');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.ncr_attachments (organisation_id, nonconformance_id, storage_path, file_name, size_bytes) VALUES (%L, %L, %L, 'x', 1)$q$,
    org, ncr, org || '/ncr/' || ncr || '/../x.jpg'), 'no path tricks');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.ncr_attachments (organisation_id, nonconformance_id, storage_path, file_name, size_bytes) VALUES (%L, %L, %L, 'x', 30000000)$q$,
    org, ncr, org || '/ncr/' || ncr || '/big.bin'), 'files up to 25 MB');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.ncr_attachments SET storage_path = 'elsewhere' WHERE id = %L$q$, f), 'path not editable');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.ncr_attachments SET deleted_at = now() WHERE id = %L$q$, f), 'removing a file needs a reason');
  UPDATE public.ncr_attachments SET deleted_at = now(), delete_reason = 'Wrong photo' WHERE id = f;
  PERFORM pg_temp.assert_eq((SELECT deleted_by FROM public.ncr_attachments WHERE id = f), '21000000-0000-0000-0000-000000000101'::uuid, 'removal stamped');
  UPDATE public.ncr_attachments SET deleted_at = NULL WHERE id = f;

  -- Storage: uploads only into an existing NCR folder of the organisation.
  INSERT INTO storage.buckets (id, name) VALUES ('nc-files', 'nc-files') ON CONFLICT DO NOTHING;
  PERFORM pg_temp.assert_ok(format($q$INSERT INTO storage.objects (bucket_id, name) VALUES ('nc-files', %L)$q$, org || '/ncr/' || ncr || '/a1-photo.jpg'), 'upload into the NCR folder');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO storage.objects (bucket_id, name) VALUES ('nc-files', %L)$q$, org || '/ncr/' || gen_random_uuid() || '/x.jpg'), 'no folder for a missing NCR');
  PERFORM pg_temp.assert_eq(pg_temp.affected(format($q$DELETE FROM storage.objects WHERE name = %L$q$, org || '/ncr/' || ncr || '/a1-photo.jpg')), 0::bigint, 'stored files are not deleted by users');

  -- Members: an inspector scoped to Plant B; an outsider in another organisation.
  PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '21000000-0000-0000-0000-000000000102', 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id, site_id)
    SELECT org, m, id, site_b FROM public.roles WHERE organisation_id = org AND key = 'inspector';
  INSERT INTO public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, amount) VALUES (org, ncr_b, 'sorting', 'GBP', 5);
  PERFORM pg_temp.login('21000000-0000-0000-0000-000000000103');
  other := app.create_organisation('Other Works', 'Main', 'MN', NULL);
  PERFORM pg_temp.logout();
  INSERT INTO ids VALUES ('org', org), ('ncr', ncr), ('ncr_b', ncr_b), ('other', other);
END $$;

-- Site scoping through the parent NCR, and isolation between organisations.
DO $$
DECLARE
  org uuid := (SELECT v FROM ids WHERE k = 'org');
  ncr uuid := (SELECT v FROM ids WHERE k = 'ncr');
BEGIN
  PERFORM pg_temp.login('21000000-0000-0000-0000-000000000102');
  PERFORM pg_temp.assert_eq((SELECT string_agg(cost_type, ',') FROM public.ncr_costs), 'sorting', 'Plant B inspector sees only Plant B costs');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.ncr_attachments), 0::bigint, 'and no Plant A files');
  PERFORM pg_temp.assert_eq(pg_temp.count_rows($q$SELECT 1 FROM storage.objects WHERE bucket_id = 'nc-files'$q$), 0::bigint, 'nor the stored Plant A file');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, amount) VALUES (%L, %L, 'scrap', 'GBP', 1)$q$, org, ncr), 'cannot add costs to another site''s NCR');

  PERFORM pg_temp.login('21000000-0000-0000-0000-000000000103');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.ncr_costs WHERE organisation_id = org), 0::bigint, 'other organisation sees no costs');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.ncr_attachments WHERE organisation_id = org), 0::bigint, 'nor files');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, amount) VALUES (%L, %L, 'scrap', 'GBP', 1)$q$,
    (SELECT v FROM ids WHERE k = 'other'), ncr), 'cannot attach a cost to another organisation''s NCR');

  -- Closed NCRs lock their costs and files.
  PERFORM pg_temp.login('21000000-0000-0000-0000-000000000101');
  UPDATE public.nonconformances SET stage = 'closed' WHERE id = ncr;
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, amount) VALUES (%L, %L, 'scrap', 'GBP', 1)$q$, org, ncr), 'no new costs on a closed NCR');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.ncr_costs SET amount = 1 WHERE nonconformance_id = %L$q$, ncr), 'costs of a closed NCR are locked');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.ncr_attachments (organisation_id, nonconformance_id, storage_path, file_name, size_bytes) VALUES (%L, %L, %L, 'late.jpg', 1)$q$,
    org, ncr, org || '/ncr/' || ncr || '/late.jpg'), 'no new files on a closed NCR');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM audit.events WHERE entity_type IN ('ncr_costs', 'ncr_attachments')) > 5, true, 'costs and files audited');
END $$;

ROLLBACK;
