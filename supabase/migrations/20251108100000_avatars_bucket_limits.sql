-- Profile pictures: give the private "avatars" bucket a real size limit and image-only types.
-- The live bucket had file_size_limit = 0, which storage treats as "nothing may be stored", so
-- every upload was refused as too large even though the app crops pictures to a 512 × 512 WebP
-- (typically 20–80 KB). 2 MB leaves room for the JPEG fallback in browsers without WebP encoding.
-- Reversible: set file_size_limit / allowed_mime_types back to their previous values.

INSERT INTO storage.buckets (id, name, public) VALUES ('avatars', 'avatars', false)
ON CONFLICT (id) DO NOTHING;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'storage' AND table_name = 'buckets' AND column_name = 'file_size_limit') THEN
    EXECUTE $q$UPDATE storage.buckets SET file_size_limit = 2097152,
      allowed_mime_types = ARRAY['image/webp', 'image/jpeg', 'image/png'] WHERE id = 'avatars'$q$;
  END IF;
END $$;
