-- A non-conformance carrying the old, never-written source value "inspection", in the migrated legacy organisation, loaded right before the category / source migration
-- so that its clean-up (to production_inspection) and the seeding of categories for an organisation that already exists are exercised.
INSERT INTO public.nonconformances (organisation_id, reference, source, title)
  SELECT id, 'FIX-INSP', 'inspection', 'Stray inspection source' FROM public.organisations ORDER BY created_at LIMIT 1;
