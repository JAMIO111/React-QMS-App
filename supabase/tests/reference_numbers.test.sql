-- Running numbers are padded, never cut: NC references have four digits and carry on past 9999; the other numbering keeps its width but goes
-- past 999 (calibrations, quality alerts) instead of repeating an earlier number. References already given never change.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES ('3e200000-0000-0000-0000-000000000d01', 'ann@numbers.test');

DO $$
DECLARE
  ann uuid := '3e200000-0000-0000-0000-000000000d01'; org uuid; yy text := to_char(current_date, 'YY'); r text; v_def text;
BEGIN
  -- The padding itself.
  PERFORM pg_temp.assert_eq(app.pad_number(7, 4), '0007', 'pads to the width');
  PERFORM pg_temp.assert_eq(app.pad_number(1000, 3), '1000', 'a longer number is kept whole, not cut to 100');
  PERFORM pg_temp.assert_eq(app.pad_number(123456, 4), '123456', 'however long');

  PERFORM pg_temp.login(ann); org := app.create_organisation('Numbers Ltd', 'Plant A', 'PA', NULL); PERFORM pg_temp.logout();
  UPDATE public.organisation_settings SET ncr_reference_prefix = 'SNC' WHERE organisation_id = org;

  -- NC references: four digits from the first, and on past 9999 without repeating.
  PERFORM pg_temp.assert_eq(app.next_ncr_reference(org), 'SNC-' || yy || '-0001', 'a new NC has four digits');
  UPDATE app.ncr_counters SET last_value = 9998 WHERE organisation_id = org;
  PERFORM pg_temp.assert_eq(app.next_ncr_reference(org), 'SNC-' || yy || '-9999', 'the last four-digit number');
  PERFORM pg_temp.assert_eq(app.next_ncr_reference(org), 'SNC-' || yy || '-10000', 'then five digits, not a repeat of -1000');

  -- An NC made the ordinary way gets the four-digit form, beside a three-digit one from before, which is left as it was.
  INSERT INTO public.nonconformances (organisation_id, source, title, reference) VALUES (org, 'internal', 'From before', 'SNC-' || yy || '-010');
  UPDATE app.ncr_counters SET last_value = 10 WHERE organisation_id = org;
  PERFORM pg_temp.login(ann);
  INSERT INTO public.nonconformances (organisation_id, source, title) VALUES (org, 'internal', 'New one');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT reference FROM public.nonconformances WHERE organisation_id = org AND title = 'New one'), 'SNC-' || yy || '-0011',
    'the next NC carries on the count in four digits');
  PERFORM pg_temp.assert_eq((SELECT reference FROM public.nonconformances WHERE organisation_id = org AND title = 'From before'), 'SNC-' || yy || '-010',
    'a reference already given keeps its three digits');

  -- Calibrations keep three digits but go past 999.
  PERFORM pg_temp.assert_eq(app.next_calibration_reference(org), 'CAL-' || yy || '-001', 'calibrations still start with three digits');
  UPDATE app.calibration_counters SET last_value = 999 WHERE organisation_id = org;
  PERFORM pg_temp.assert_eq(app.next_calibration_reference(org), 'CAL-' || yy || '-1000', 'the 1,000th calibration is -1000, not -100');

  -- Numbers that never reset by year (quality alerts) go past 999 too.
  INSERT INTO app.quality_alert_counters AS c (organisation_id, last_value) VALUES (org, 999)
  ON CONFLICT (organisation_id) DO UPDATE SET last_value = 999;
  PERFORM pg_temp.login(ann);
  INSERT INTO public.quality_alerts (organisation_id, title, category, severity) VALUES (org, 'Thousandth', 'product', 'low');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT reference FROM public.quality_alerts WHERE organisation_id = org AND title = 'Thousandth'), 'QA-1000',
    'the 1,000th quality alert is QA-1000, not QA-100');

  -- No function pads a running number by cutting it any more.
  SELECT string_agg(p.proname, ', ') INTO r FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('public', 'app', 'audit') AND p.prokind = 'f'
     AND pg_get_functiondef(p.oid) ~ 'lpad\(\s*(v_n|NEW\.alert_number|NEW\.audit_number)::text';
  PERFORM pg_temp.assert_eq(coalesce(r, ''), '', 'no numbering function still uses lpad');

  -- The rewrite changed only the padding: the rest of a rewritten function is as it was (spot check).
  v_def := pg_get_functiondef('app.next_ncr_reference(uuid)'::regprocedure);
  PERFORM pg_temp.assert_eq((position('ncr_reference_prefix' IN v_def) > 0 AND position('EXIT WHEN NOT EXISTS' IN v_def) > 0)::text, 'true',
    'next_ncr_reference still reads the prefix and still skips a number already used');
  PERFORM pg_temp.assert_eq(has_function_privilege('anon', 'app.pad_number(bigint, integer)', 'execute')::text, 'false', 'anonymous callers cannot run it');
END $$;

ROLLBACK;
