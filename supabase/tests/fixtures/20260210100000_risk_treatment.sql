-- An organisation from before suggested categories that has switched its Equipment category off, loaded right before the migration that adds them:
-- its calibration source must be seeded with no suggestion (a switched-off category is never suggested), the others as usual.
DO $$
DECLARE o uuid;
BEGIN
  INSERT INTO public.organisations (name, slug) VALUES ('Fixture equipment off', 'fixture-equipment-off') RETURNING id INTO o;
  UPDATE public.ncr_classifications SET active = false WHERE organisation_id = o AND kind = 'category' AND code = 'EQUIPMENT';
END $$;
