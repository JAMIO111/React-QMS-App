-- CMM ingestion CM2: a feature read in inches is converted to the check's millimetres (value, nominal and limits) and judged on that; units that
-- cannot convert are a problem, not a reading; matching a feature by hand to another check converts again from what was read, which never changes.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES ('5e000000-0000-0000-0000-000000000a01', 'owner@units.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  u uuid := '5e000000-0000-0000-0000-000000000a01'; org uuid; site uuid; part uuid; plan uuid; rev uuid; op uuid; rec uuid; imp uuid; r text;
  od uuid; ang uuid; row_in uuid;
BEGIN
  PERFORM pg_temp.assert_eq(app.convert_measurement(0.5, 'in', 'mm'), 12.7::numeric, 'half an inch is 12.7 mm');
  PERFORM pg_temp.assert_eq(app.convert_measurement(30, 'arcmin', 'deg'), 0.5::numeric, '30 arcminutes is half a degree');
  PERFORM pg_temp.assert_eq(app.convert_measurement(1, 'deg', 'mm'), NULL::numeric, 'degrees do not become millimetres');
  PERFORM pg_temp.assert_eq(app.convert_measurement(7, NULL, 'mm'), 7::numeric, 'no unit read = the check''s unit');

  PERFORM pg_temp.assert_eq(app.import_value_mismatch(0.9961, 'in', 25.3, 'mm', 25.3, 25.5), false, 'our 25.3 mm printed in inches to four places is 0.9961: no difference');
  PERFORM pg_temp.assert_eq(app.import_value_mismatch(0.9950, 'in', 25.3, 'mm', 25.3, 25.5), true, '0.9950 in is a different limit');
  PERFORM pg_temp.assert_eq(app.import_value_mismatch(25.05, 'mm', 25.05, 'mm', 24.95, 25.05), false, 'the same value is no difference');
  PERFORM pg_temp.assert_eq(app.import_value_mismatch(25.1, 'mm', 25.05, 'mm', 24.95, 25.05), true, 'a wider tolerance is a difference');
  PERFORM pg_temp.login(u);
  org := app.create_organisation('Units Works', 'Plant A', 'PA', NULL);
  SELECT id INTO site FROM public.sites WHERE organisation_id = org;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'U-1', 'Shaft') RETURNING id INTO part;
  INSERT INTO public.part_revisions (organisation_id, part_id, revision) VALUES (org, part, 'A');
  UPDATE public.part_revisions SET status = 'released' WHERE part_id = part;
  INSERT INTO public.control_plans (organisation_id, plan_code, title) VALUES (org, 'CP-U', 'Shaft plan') RETURNING id INTO plan;
  INSERT INTO public.control_plan_applicability (organisation_id, control_plan_id, part_id) VALUES (org, plan, part);
  INSERT INTO public.control_plan_revisions (organisation_id, control_plan_id, revision_code, change_reason) VALUES (org, plan, 'A', 'First') RETURNING id INTO rev;
  INSERT INTO public.control_plan_operations (organisation_id, control_plan_revision_id, operation_code, sequence, name) VALUES (org, rev, 'OP-10', 10, 'Turning') RETURNING id INTO op;
  INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, char_number, sequence, name, nominal, lower_limit, upper_limit, unit_code)
    VALUES (org, rev, op, 'OD', '1', 10, 'Outer diameter', 25.4, 25.3, 25.5, 'mm'), (org, rev, op, 'ANG', '2', 20, 'Chamfer angle', 45, 44, 46, 'deg');
  UPDATE public.control_plan_revisions SET status = 'pending_approval' WHERE id = rev;
  UPDATE public.control_plan_revisions SET status = 'approved' WHERE id = rev;
  UPDATE public.control_plan_revisions SET status = 'effective' WHERE id = rev;
  rec := app.start_inspection(site, part);
  SELECT id INTO od FROM public.resolved_inspection_requirements WHERE inspection_record_id = rec AND characteristic_key = 'OD';
  SELECT id INTO ang FROM public.resolved_inspection_requirements WHERE inspection_record_id = rec AND characteristic_key = 'ANG';

  imp := app.create_inspection_import(rec, jsonb_build_object(
    'filePath', org::text || '/inspection/' || rec::text || '/f.csv', 'fileName', 'f.csv', 'fileSha256', repeat('a', 64), 'sizeBytes', 10, 'format', 'table',
    'units', jsonb_build_array(jsonb_build_object('position', 1, 'rows', jsonb_build_array(
      jsonb_build_object('position', 1, 'featureName', 'OD', 'valueText', '1.0015', 'valueNumeric', 1.0015, 'unitRead', 'in',
                         'fileNominal', 1, 'fileLower', 0.9961, 'fileUpper', 1.0039, 'requirementId', od, 'matchKind', 'balloon'),
      jsonb_build_object('position', 2, 'featureName', 'CHAMFER', 'valueText', '45.2', 'valueNumeric', 45.2, 'unitRead', 'mm', 'requirementId', ang, 'matchKind', 'balloon'),
      jsonb_build_object('position', 3, 'featureName', 'EXTRA', 'valueText', '0.5', 'valueNumeric', 0.5, 'unitRead', 'in'))))));

  SELECT id INTO row_in FROM public.inspection_import_rows WHERE import_id = imp AND position = 1;
  PERFORM pg_temp.assert_eq((SELECT (read_value, value_numeric, file_nominal, expected_result, mismatch)::text FROM public.inspection_import_rows WHERE id = row_in),
                            '(1.0015,25.4381000000,25.4000000000,pass,f)', 'inches are converted to the check''s millimetres and judged on our limits');
  PERFORM pg_temp.assert_eq((SELECT problem FROM public.inspection_import_rows WHERE import_id = imp AND position = 2),
                            'The file gives this in mm; Chamfer angle is measured in deg', 'millimetres against degrees is a problem, not a reading');
  PERFORM pg_temp.assert_eq((SELECT value_numeric FROM public.inspection_import_rows WHERE import_id = imp AND position = 3), 0.5::numeric, 'an unmatched feature keeps the value as read');

  -- Matched by hand to the inch-read check: converted from what was read.
  PERFORM app.set_inspection_import_match(row_in, NULL);
  PERFORM pg_temp.assert_eq((SELECT value_numeric FROM public.inspection_import_rows WHERE id = row_in), 1.0015::numeric, 'unmatched again: the value as read');
  PERFORM app.set_inspection_import_match((SELECT id FROM public.inspection_import_rows WHERE import_id = imp AND position = 3), od);
  PERFORM pg_temp.assert_eq((SELECT (value_numeric, expected_result)::text FROM public.inspection_import_rows WHERE import_id = imp AND position = 3),
                            '(12.7000000000,fail)', 'matched by hand, converted again');
  PERFORM pg_temp.logout();
  r := pg_temp.fails(format('UPDATE public.inspection_import_rows SET read_value = 1 WHERE id = %L', row_in));
  PERFORM pg_temp.assert_eq(r LIKE 'QM008:%cannot be changed%', true, 'what was read never changes, even for SQL');
END $$;

ROLLBACK;
