-- Organisation logo: path must be in the organisation's own logo folder; members read the logo,
-- only organisation.manage writes it; other organisations see nothing.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('22000000-0000-0000-0000-0000000000a1', 'owner@logo.test'),
  ('22000000-0000-0000-0000-0000000000a2', 'viewer@logo.test'),
  ('22000000-0000-0000-0000-0000000000b1', 'other@logo.test');
INSERT INTO storage.buckets (id, name) VALUES ('org-logos', 'org-logos') ON CONFLICT DO NOTHING;
CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);
GRANT SELECT ON ids TO authenticated;

DO $$
DECLARE org uuid; other uuid; m uuid;
BEGIN
  PERFORM pg_temp.login('22000000-0000-0000-0000-0000000000a1');
  org := app.create_organisation('Logo Works', 'Main', 'MAIN', NULL);
  PERFORM pg_temp.assert_eq((SELECT logo_path FROM public.organisation_settings WHERE organisation_id = org), NULL::text, 'no logo by default');

  -- Owner uploads into the organisation's logo folder and points the setting at it.
  PERFORM pg_temp.assert_ok(format($q$INSERT INTO storage.objects (bucket_id, name) VALUES ('org-logos', %L)$q$, org || '/logo/a.png'), 'owner uploads a logo');
  UPDATE public.organisation_settings SET logo_path = org || '/logo/a.png' WHERE organisation_id = org;
  PERFORM pg_temp.assert_eq((SELECT logo_path FROM public.organisation_settings WHERE organisation_id = org), org || '/logo/a.png', 'logo set');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.organisation_settings SET logo_path = 'elsewhere/logo/a.png' WHERE organisation_id = %L$q$, org), 'logo must be in this organisation''s folder');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.organisation_settings SET logo_path = %L WHERE organisation_id = %L$q$, org || '/logo/../x.png', org), 'no path tricks');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO storage.objects (bucket_id, name) VALUES ('org-logos', %L)$q$, org || '/other/a.png'), 'uploads only into the logo folder');

  PERFORM pg_temp.login('22000000-0000-0000-0000-0000000000b1');
  other := app.create_organisation('Other Works', 'Main', 'MAIN', NULL);
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO storage.objects (bucket_id, name) VALUES ('org-logos', %L)$q$, org || '/logo/b.png'), 'cannot upload into another organisation');
  PERFORM pg_temp.assert_eq(pg_temp.count_rows($q$SELECT 1 FROM storage.objects WHERE bucket_id = 'org-logos'$q$), 0::bigint, 'cannot see another organisation''s logo');

  -- A viewer of the organisation: reads the logo, cannot change it.
  PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '22000000-0000-0000-0000-0000000000a2', 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  INSERT INTO ids VALUES ('org', org);
END $$;

DO $$
DECLARE org uuid := (SELECT v FROM ids WHERE k = 'org');
BEGIN
  PERFORM pg_temp.login('22000000-0000-0000-0000-0000000000a2');
  PERFORM pg_temp.assert_eq(pg_temp.count_rows($q$SELECT 1 FROM storage.objects WHERE bucket_id = 'org-logos'$q$), 1::bigint, 'members read the logo');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO storage.objects (bucket_id, name) VALUES ('org-logos', %L)$q$, org || '/logo/v.png'), 'viewer cannot upload');
  PERFORM pg_temp.assert_eq(pg_temp.affected(format($q$DELETE FROM storage.objects WHERE name = %L$q$, org || '/logo/a.png')), 0::bigint, 'viewer cannot delete');
  PERFORM pg_temp.assert_eq(pg_temp.affected(format($q$UPDATE public.organisation_settings SET logo_path = NULL WHERE organisation_id = %L$q$, org)), 0::bigint, 'viewer cannot clear the setting');

  PERFORM pg_temp.login('22000000-0000-0000-0000-0000000000a1');
  PERFORM pg_temp.assert_eq(pg_temp.affected(format($q$DELETE FROM storage.objects WHERE name = %L$q$, org || '/logo/a.png')), 1::bigint, 'owner removes the old file');
  UPDATE public.organisation_settings SET logo_path = NULL WHERE organisation_id = org;
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) > 0 FROM audit.events WHERE entity_type = 'organisation_settings' AND changed_fields @> ARRAY['logo_path']), true, 'logo changes audited');
END $$;

ROLLBACK;
