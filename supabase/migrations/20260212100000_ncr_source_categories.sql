-- The category a new non-conformance starts with, per source.
--
-- A category says what the problem is and the source where it was found; they stay independent. This only SUGGESTS a category when someone raises
-- a non-conformance by hand: the form fills it in, the person can change it, and it is still required to open. Nothing here changes an existing
-- non-conformance, and NCs raised from an inspection, audit, calibration, receipt or import keep choosing their own.
--
--  * ncr_source_categories: one row per organisation and source (all eleven), category or none. Seeded for every organisation (and each new one,
--    after its categories): Product for internal, customer, supplier, goods receiving, production and final inspection; Equipment for calibration;
--    System for internal and external audit and management review; none for engineering.
--  * Read by every member (the new-NC form needs it); changed by lookups.manage (the people who manage the NC lists), only the category, only
--    to an active category of the organisation or to none. No inserts or deletes by people: the eleven rows always exist. Audited.
--  * app.my_ncr_site_choices(org): the sites the caller may raise an NC at and the one a new NC starts with (their own site), for the form and
--    for the API, which fills the site of a new NC when the caller may raise NCs at one site only.

CREATE TABLE public.ncr_source_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN (
    'internal', 'customer', 'supplier', 'internal_audit', 'external_audit', 'production_inspection', 'final_inspection', 'calibration', 'goods_receiving',
    'engineering', 'management_review')),
  category_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT ncr_source_categories_source_key UNIQUE (organisation_id, source),
  CONSTRAINT ncr_source_categories_category_fkey FOREIGN KEY (category_id, organisation_id) REFERENCES public.ncr_classifications (id, organisation_id)
);
COMMENT ON TABLE public.ncr_source_categories IS 'The category suggested for a non-conformance raised by hand, per source (a suggestion only; the person can change it)';
CREATE INDEX ncr_source_categories_category_idx ON public.ncr_source_categories (category_id) WHERE category_id IS NOT NULL;

-- Only a category of the organisation, and only an active one when it is chosen (one switched off later is simply not suggested).
CREATE FUNCTION app.ncr_source_category_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.category_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.category_id IS DISTINCT FROM OLD.category_id) AND NOT EXISTS (
       SELECT 1 FROM public.ncr_classifications c
        WHERE c.id = NEW.category_id AND c.organisation_id = NEW.organisation_id AND c.kind = 'category' AND c.active) THEN
    RAISE EXCEPTION 'The suggested category must be one of the organisation''s categories that is in use' USING ERRCODE = 'QM005';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.source IS DISTINCT FROM OLD.source THEN
    RAISE EXCEPTION 'The source of a suggestion cannot change' USING ERRCODE = 'QM005';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ncr_source_categories_rules BEFORE INSERT OR UPDATE ON public.ncr_source_categories FOR EACH ROW EXECUTE FUNCTION app.ncr_source_category_rules();
CREATE TRIGGER ncr_source_categories_stamp BEFORE INSERT ON public.ncr_source_categories FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER ncr_source_categories_touch BEFORE UPDATE ON public.ncr_source_categories FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER ncr_source_categories_org_immutable BEFORE UPDATE ON public.ncr_source_categories FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.ncr_source_categories FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');

ALTER TABLE public.ncr_source_categories ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ncr_source_categories FROM anon, authenticated;
GRANT SELECT ON public.ncr_source_categories TO authenticated;
GRANT UPDATE (category_id) ON public.ncr_source_categories TO authenticated;
CREATE POLICY ncr_source_categories_select ON public.ncr_source_categories FOR SELECT TO authenticated USING (app.is_member(organisation_id));
CREATE POLICY ncr_source_categories_update ON public.ncr_source_categories FOR UPDATE TO authenticated
  USING (app.has_permission(organisation_id, 'lookups.manage')) WITH CHECK (app.has_permission(organisation_id, 'lookups.manage'));

-- ---------------------------------------------------------------------------
-- Seeding: every source once, the suggestion found by the category's code (an organisation that switched the category off gets none)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.seed_ncr_source_categories(p_organisation_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO public.ncr_source_categories (organisation_id, source, category_id)
  SELECT p_organisation_id, d.source,
         (SELECT c.id FROM public.ncr_classifications c
           WHERE c.organisation_id = p_organisation_id AND c.kind = 'category' AND c.active AND upper(c.code) = d.code
           ORDER BY c.sort_order, c.created_at LIMIT 1)
    FROM (VALUES
      ('internal', 'PRODUCT'), ('customer', 'PRODUCT'), ('supplier', 'PRODUCT'), ('goods_receiving', 'PRODUCT'),
      ('production_inspection', 'PRODUCT'), ('final_inspection', 'PRODUCT'), ('calibration', 'EQUIPMENT'),
      ('internal_audit', 'SYSTEM'), ('external_audit', 'SYSTEM'), ('management_review', 'SYSTEM'), ('engineering', NULL)
    ) AS d (source, code)
  ON CONFLICT (organisation_id, source) DO NOTHING
$$;

-- New organisations: this trigger's name sorts after organisations_seed_ncr_categories, so the categories exist when it runs.
CREATE FUNCTION app.seed_ncr_source_categories_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app.seed_ncr_source_categories(NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER organisations_seed_ncr_source_categories AFTER INSERT ON public.organisations FOR EACH ROW EXECUTE FUNCTION app.seed_ncr_source_categories_trg();

SELECT app.seed_ncr_source_categories(o.id) FROM public.organisations o;

REVOKE ALL ON FUNCTION app.seed_ncr_source_categories(uuid), app.seed_ncr_source_categories_trg(), app.ncr_source_category_rules() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The sites the caller may raise a non-conformance at, and the one a new NC starts with
-- ---------------------------------------------------------------------------
-- Choices = active sites where the caller holds ncr.create (an organisation-wide role covers every site, a site-limited one its own).
-- Suggested = the only choice when there is one; otherwise the site of the caller's own employee record (linked to their sign-in), else the site
-- of their primary department, when that site is one of the choices; otherwise none. SECURITY DEFINER only so the caller's OWN employee and
-- department rows can be read whatever their role; nothing about anyone else is returned.
CREATE FUNCTION app.my_ncr_site_choices(p_organisation_id uuid)
RETURNS TABLE (id uuid, code text, name text, suggested boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_hint uuid; v_count integer;
BEGIN
  IF auth.uid() IS NULL OR NOT app.is_member(p_organisation_id) THEN RETURN; END IF;
  SELECT e.site_id INTO v_hint FROM public."Employees" e
   WHERE e.organisation_id = p_organisation_id AND e.auth_id = auth.uid() AND e.active AND e.site_id IS NOT NULL
   LIMIT 1;
  IF v_hint IS NULL THEN
    SELECT d.site_id INTO v_hint
      FROM public.department_members dm
      JOIN public.organisation_users ou ON ou.id = dm.membership_id AND ou.user_id = auth.uid() AND ou.status = 'active'
      JOIN public.departments d ON d.id = dm.department_id AND d.active
     WHERE dm.organisation_id = p_organisation_id AND dm.ended_at IS NULL
     ORDER BY dm.is_primary DESC, dm.joined_at
     LIMIT 1;
  END IF;
  SELECT count(*) INTO v_count FROM public.sites s
   WHERE s.organisation_id = p_organisation_id AND s.active AND app.has_permission(p_organisation_id, 'ncr.create', s.id);
  RETURN QUERY
    SELECT s.id, s.code, s.name, (v_count = 1 OR s.id = v_hint)
      FROM public.sites s
     WHERE s.organisation_id = p_organisation_id AND s.active AND app.has_permission(p_organisation_id, 'ncr.create', s.id)
     ORDER BY s.code;
END $$;
COMMENT ON FUNCTION app.my_ncr_site_choices(uuid) IS 'Sites the caller may raise a non-conformance at, with the one a new NC starts with marked suggested';
REVOKE ALL ON FUNCTION app.my_ncr_site_choices(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.my_ncr_site_choices(uuid) TO authenticated;
