-- Calibration intervals up to 3,650 (ten years in days) instead of 1,000: gauges kept in days by other systems run to 1,095 (three years) and 1,460 (four
-- years) days, which the old limit refused on import. Applies to gauge types and to a gauge's own interval; nothing else changes.
ALTER TABLE public.gauge_types DROP CONSTRAINT gauge_types_interval_value_check;
ALTER TABLE public.gauge_types ADD CONSTRAINT gauge_types_interval_value_check CHECK (interval_value BETWEEN 1 AND 3650);
ALTER TABLE public.gauges DROP CONSTRAINT gauges_interval_value_check;
ALTER TABLE public.gauges ADD CONSTRAINT gauges_interval_value_check CHECK (interval_value BETWEEN 1 AND 3650);
