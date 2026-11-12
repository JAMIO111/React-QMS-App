-- Document types from before the built-in calibration procedure type, loaded right before its migration so that the seeding is exercised:
-- the first organisation already has an active type called "calibration procedure" (it is adopted, keeping its prefix), and a second
-- organisation made here has another type that already uses the prefix CALP (so the new type takes CALP-2).
DO $$
DECLARE o1 uuid := (SELECT id FROM public.organisations ORDER BY created_at, id LIMIT 1);
        o2 uuid;
BEGIN
  INSERT INTO public.organisations (name, slug) VALUES ('Fixture prefix taken', 'fixture-prefix-taken') RETURNING id INTO o2;
  IF o1 IS NOT NULL THEN
    INSERT INTO public.document_types (organisation_id, name, prefix, review_months, content_hint, sequence) VALUES (o1, ' calibration Procedure ', 'CPX', 12, 'file', 20);
  END IF;
  INSERT INTO public.document_types (organisation_id, name, prefix, review_months, content_hint, sequence) VALUES (o2, 'Calipers', 'CALP', 12, 'file', 20);
END $$;
