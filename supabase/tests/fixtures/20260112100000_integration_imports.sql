-- Gauge types from before codes, loaded right before the gauge type codes migration so that its backfill is exercised:
-- two names that make the same code (the second gets "-2") and a name with nothing usable in a code.
INSERT INTO public.gauge_types (organisation_id, name) SELECT id, 'Fixture micrometer 0–25' FROM public.organisations ORDER BY created_at LIMIT 1;
INSERT INTO public.gauge_types (organisation_id, name) SELECT id, 'fixture MICROMETER 0 25' FROM public.organisations ORDER BY created_at LIMIT 1;
INSERT INTO public.gauge_types (organisation_id, name) SELECT id, '***' FROM public.organisations ORDER BY created_at LIMIT 1;
