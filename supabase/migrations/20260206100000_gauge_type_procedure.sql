-- A gauge type's default calibration procedure.
--
-- The procedure a calibration follows is normally the same for every gauge of a type (e.g. WI-CAL-004 for all digital calipers), so the
-- type now carries it. A new calibration starts with the type's procedure filled in; the technician may change it for that record, and the
-- record keeps its own copy (calibrations.procedure_ref), so changing the type later never rewrites calibrations already recorded.
-- Same length rule as calibrations.procedure_ref. Editable by calibration.manage (the existing gauge_types policies), audited like the rest.

ALTER TABLE public.gauge_types
  ADD COLUMN procedure_ref text CHECK (procedure_ref IS NULL OR length(btrim(procedure_ref)) BETWEEN 1 AND 200);

COMMENT ON COLUMN public.gauge_types.procedure_ref IS 'Default calibration procedure for gauges of this type; copied onto a new calibration, which keeps its own value';

GRANT UPDATE (procedure_ref) ON public.gauge_types TO authenticated;
