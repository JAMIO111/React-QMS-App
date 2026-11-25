-- Faster SPC alert evaluation on a save (no change in what alerts are raised).
--
-- A save used to read every stored reading of the characteristic to see whether the new ones signal, and row-level security checks each row it reads
-- (about half a millisecond a reading, growing with the history). The API now finds the newest reading of each inspection with one look per
-- inspection, and reads only the recent inspections when a saved baseline fixes the limits. That look is "the newest reading of this requirement",
-- which wants (requirement_id, measured_at). It also serves every lookup by requirement_id alone, so the plain index it replaces is dropped.
CREATE INDEX inspection_measurements_requirement_time_idx ON public.inspection_measurements (requirement_id, measured_at DESC);
DROP INDEX public.inspection_measurements_requirement_idx;
