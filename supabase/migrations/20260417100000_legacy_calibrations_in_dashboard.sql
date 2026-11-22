-- Whether legacy calibration records (imported history, no readings) count in the calibration dashboard's figures for a period (calibrated, failed,
-- first-time pass rate, the results chart). Off by default: an organisation that brings years of old calibrations in should not see its first
-- months of Fortress swamped by them, or its pass rate judged on conclusions that have no readings behind them. The gauges' own state (overdue, due
-- soon, quarantined, compliance) always follows the latest calibration, legacy or not, and the legacy records are always on the gauge's history.
-- Changed by people who manage the organisation, like the other organisation settings.
ALTER TABLE public.organisation_settings ADD COLUMN include_legacy_calibrations boolean NOT NULL DEFAULT false;
GRANT UPDATE (include_legacy_calibrations) ON public.organisation_settings TO authenticated;
