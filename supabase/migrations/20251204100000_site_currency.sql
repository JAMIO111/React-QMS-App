-- A currency per site: the default for money entered at that site (cost lines on a non-conformance raised there, …).
-- A new site starts with the organisation's currency (organisation_settings.base_currency) unless one is given; existing sites are given theirs.
-- The organisation's base currency stays what totals and exchange rates are worked out in.

ALTER TABLE public.sites ADD COLUMN currency text;

UPDATE public.sites s
   SET currency = coalesce((SELECT st.base_currency FROM public.organisation_settings st WHERE st.organisation_id = s.organisation_id), 'GBP');

ALTER TABLE public.sites
  ALTER COLUMN currency SET NOT NULL,
  ADD CONSTRAINT sites_currency_check CHECK (currency ~ '^[A-Z]{3}$');

CREATE FUNCTION app.site_default_currency() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.currency IS NULL THEN
    SELECT st.base_currency INTO NEW.currency FROM public.organisation_settings st WHERE st.organisation_id = NEW.organisation_id;
    NEW.currency := coalesce(NEW.currency, 'GBP');
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.site_default_currency() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER sites_default_currency BEFORE INSERT ON public.sites FOR EACH ROW EXECUTE FUNCTION app.site_default_currency();
