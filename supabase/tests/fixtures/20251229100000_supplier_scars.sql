-- A SCAR with an extension that existed before extensions needed approval, loaded right before the SQ3e migration so that its backfill is exercised:
-- the old extension becomes "approved" (it had already been applied) and the SCAR keeps working.
INSERT INTO public.suppliers (organisation_id, code, name) SELECT id, 'FIXSCAR', 'Fixture SCAR supplier' FROM public.organisations ORDER BY created_at LIMIT 1;
INSERT INTO public.supplier_scars (organisation_id, reference, supplier_id, title, status, issued_at, original_response_due_on, response_due_on)
  SELECT organisation_id, 'SCAR-FIX-0001', id, 'Fixture SCAR', 'issued', now(), current_date + 5, current_date + 12 FROM public.suppliers WHERE code = 'FIXSCAR';
INSERT INTO public.supplier_scar_extensions (organisation_id, scar_id, previous_due_on, new_due_on, reason)
  SELECT organisation_id, id, current_date + 5, current_date + 12, 'Fixture extension' FROM public.supplier_scars WHERE reference = 'SCAR-FIX-0001';
