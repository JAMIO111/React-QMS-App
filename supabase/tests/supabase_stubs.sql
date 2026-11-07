-- Minimal stand-ins for the Supabase-managed schemas the migrations reference, so migrations
-- can be checked against a plain local Postgres (scripts/db-check.sh). Not applied to Supabase.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text, raw_user_meta_data jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(), email_confirmed_at timestamptz, invited_at timestamptz);

-- Mirrors Supabase (an empty or missing claims setting yields NULL): reads claims set via `set local request.jwt.claims = '{"sub": "...", "role": "..."}'`
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid $$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role' $$;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
$$ SELECT coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb $$;

CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE IF NOT EXISTS storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean DEFAULT false);
CREATE TABLE IF NOT EXISTS storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text REFERENCES storage.buckets(id), name text, owner uuid);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

GRANT USAGE ON SCHEMA public, auth, storage TO anon, authenticated, service_role;

-- Mirror Supabase's defaults: API roles get full table privileges (RLS decides row access), so
-- the migrations' own REVOKEs are what's being tested.
GRANT ALL ON storage.objects, storage.buckets TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.role(), auth.jwt() TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
