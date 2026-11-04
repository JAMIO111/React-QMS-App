-- Organisation logo: shown in the app's side menu for every member. The file lives in the private
-- "org-logos" bucket at <organisation id>/logo/<name>; organisation_settings.logo_path points to it.
-- Members can read their organisation's logo; members with organisation.manage (Owners and
-- Admins by default) can upload, replace and remove it. organisation_settings is already audited
-- and covered by RLS (only organisation.manage may update it).

ALTER TABLE public.organisation_settings
  ADD COLUMN logo_path text
    CONSTRAINT organisation_settings_logo_path_check
    CHECK (logo_path IS NULL OR (logo_path LIKE organisation_id::text || '/logo/%' AND logo_path NOT LIKE '%..%' AND length(logo_path) <= 300));

GRANT UPDATE (logo_path) ON public.organisation_settings TO authenticated;

-- Private bucket. Size and type limits are set where the storage schema supports them.
INSERT INTO storage.buckets (id, name, public) VALUES ('org-logos', 'org-logos', false)
ON CONFLICT (id) DO NOTHING;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'storage' AND table_name = 'buckets' AND column_name = 'file_size_limit') THEN
    EXECUTE $q$UPDATE storage.buckets SET file_size_limit = 1048576,
      allowed_mime_types = ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'] WHERE id = 'org-logos'$q$;
  END IF;
END $$;

CREATE POLICY org_logos_select ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'org-logos' AND split_part(name, '/', 2) = 'logo' AND app.is_member(app.try_uuid(split_part(name, '/', 1))));
CREATE POLICY org_logos_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'org-logos' AND split_part(name, '/', 2) = 'logo'
              AND app.has_permission(app.try_uuid(split_part(name, '/', 1)), 'organisation.manage'));
CREATE POLICY org_logos_update ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'org-logos' AND app.has_permission(app.try_uuid(split_part(name, '/', 1)), 'organisation.manage'))
  WITH CHECK (bucket_id = 'org-logos' AND split_part(name, '/', 2) = 'logo'
              AND app.has_permission(app.try_uuid(split_part(name, '/', 1)), 'organisation.manage'));
CREATE POLICY org_logos_delete ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'org-logos' AND app.has_permission(app.try_uuid(split_part(name, '/', 1)), 'organisation.manage'));
