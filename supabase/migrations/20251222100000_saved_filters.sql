-- Saved filters: a person's own named filters for a register (first use: the non-conformance register), up to five per person, organisation and register.
--
-- They are personal, like notification preferences: nobody else can see, change or delete them (row-level security by owner AND membership). A filter is the set of URL filters of
-- the register (`filters` is a flat object of text values; the API only accepts the register's own keys). The limit and the unique name per person are enforced here, so no client can go round them.
-- Errors use QM019 (409 saved_filter_rule). Personal preferences are not quality records, so there is no audit trigger (as for notification preferences).

CREATE FUNCTION app.saved_filter_limit() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path = '' AS $$ SELECT 5 $$;

CREATE TABLE public.saved_filters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope ~ '^[a-z][a-z0-9_]{1,39}$'),
  name text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 40),
  filters jsonb NOT NULL CHECK (jsonb_typeof(filters) = 'object' AND pg_column_size(filters) <= 8192),
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX saved_filters_name_key ON public.saved_filters (organisation_id, user_id, scope, lower(name));
CREATE INDEX saved_filters_owner_idx ON public.saved_filters (user_id, organisation_id, scope);

CREATE FUNCTION app.saved_filters_touch() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
CREATE TRIGGER saved_filters_touch BEFORE UPDATE ON public.saved_filters FOR EACH ROW EXECUTE FUNCTION app.saved_filters_touch();

-- At most five per person, organisation and register. The advisory lock makes two saves at the same moment count one after the other.
CREATE FUNCTION app.saved_filters_limit_check() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  -- Row-level security checks the owner after this trigger runs, so refuse another person's name here first (and say nothing about their filters).
  IF auth.uid() IS NOT NULL AND NEW.user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'new row violates row-level security policy for table "saved_filters"' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id::text || NEW.organisation_id::text || NEW.scope, 0));
  IF (SELECT count(*) FROM public.saved_filters f
       WHERE f.user_id = NEW.user_id AND f.organisation_id = NEW.organisation_id AND f.scope = NEW.scope) >= app.saved_filter_limit() THEN
    RAISE EXCEPTION 'You can save up to % filters here. Delete one to save another.', app.saved_filter_limit() USING ERRCODE = 'QM019';
  END IF;
  -- New filters go to the end.
  NEW.position := coalesce((SELECT max(f.position) + 1 FROM public.saved_filters f
                             WHERE f.user_id = NEW.user_id AND f.organisation_id = NEW.organisation_id AND f.scope = NEW.scope), 0);
  RETURN NEW;
END $$;
CREATE TRIGGER saved_filters_limit BEFORE INSERT ON public.saved_filters FOR EACH ROW EXECUTE FUNCTION app.saved_filters_limit_check();

-- Trigger functions are not for calling: nobody (anon included) may execute them.
REVOKE ALL ON FUNCTION app.saved_filter_limit(), app.saved_filters_limit_check(), app.saved_filters_touch() FROM PUBLIC, anon, authenticated;

ALTER TABLE public.saved_filters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.saved_filters FROM anon, authenticated;
-- Only the owner's own columns can be written; the organisation and owner are fixed once saved.
GRANT SELECT, DELETE ON public.saved_filters TO authenticated;
GRANT INSERT (organisation_id, user_id, scope, name, filters) ON public.saved_filters TO authenticated;
GRANT UPDATE (name, filters) ON public.saved_filters TO authenticated;

CREATE POLICY saved_filters_select ON public.saved_filters FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) AND app.is_member(organisation_id));
CREATE POLICY saved_filters_insert ON public.saved_filters FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()) AND app.is_member(organisation_id));
CREATE POLICY saved_filters_update ON public.saved_filters FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()) AND app.is_member(organisation_id))
  WITH CHECK (user_id = (SELECT auth.uid()) AND app.is_member(organisation_id));
CREATE POLICY saved_filters_delete ON public.saved_filters FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()) AND app.is_member(organisation_id));
