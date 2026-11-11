-- A gauge type's calibration procedure is a controlled document.
--
-- 20260206100000 gave gauge types a typed procedure reference. The procedure should be one of the organisation's controlled documents
-- (document control, 20260202100000), chosen from a list, so the reference cannot be mistyped and people can open the procedure itself.
-- The typed column is replaced by a link to the document. A new calibration still starts with the procedure's number as its own
-- procedure text (calibrations.procedure_ref), which the technician may change and which never changes afterwards.
--
-- The typed column was added the same day and must be empty: the migration refuses to run if any type has a typed procedure, rather than lose it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.gauge_types WHERE procedure_ref IS NOT NULL) THEN
    RAISE EXCEPTION 'Some gauge types have a typed procedure; link them to documents (or clear them) before running this migration';
  END IF;
END $$;

ALTER TABLE public.gauge_types DROP COLUMN procedure_ref;

ALTER TABLE public.gauge_types
  ADD COLUMN procedure_document_id uuid,
  ADD CONSTRAINT gauge_types_procedure_document_fkey FOREIGN KEY (procedure_document_id, organisation_id)
    REFERENCES public.documents (id, organisation_id);

COMMENT ON COLUMN public.gauge_types.procedure_document_id IS 'The controlled document that is the calibration procedure for gauges of this type; a new calibration starts with its number';

CREATE INDEX gauge_types_procedure_document_idx ON public.gauge_types (procedure_document_id) WHERE procedure_document_id IS NOT NULL;

GRANT UPDATE (procedure_document_id) ON public.gauge_types TO authenticated;
