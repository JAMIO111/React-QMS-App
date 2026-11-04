-- Process control PC3: the requirement resolver on the brief's hydraulic-rod example — fixed,
-- part-specific, conditional and pass/fail characteristics resolved per part; blocked (with reasons)
-- on missing values, unit mismatch, no family, no released revision, no effective plan, ambiguous
-- plans and unknown operations; other organisations' parts are not resolvable.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('34000000-0000-0000-0000-000000000101', 'owner@res.test'),
  ('34000000-0000-0000-0000-000000000201', 'other@res.test');

CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);
GRANT SELECT ON ids TO authenticated;

-- Releases a draft revision with the given values.
CREATE FUNCTION pg_temp.part(org uuid, fam uuid, pn text, vals jsonb, release boolean DEFAULT true) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE p uuid; r uuid; v jsonb;
BEGIN
  INSERT INTO public.parts (organisation_id, part_number, name, part_family_id) VALUES (org, pn, pn, fam) RETURNING id INTO p;
  INSERT INTO public.part_revisions (organisation_id, part_id, revision) VALUES (org, p, 'A') RETURNING id INTO r;
  FOR v IN SELECT * FROM jsonb_array_elements(vals) LOOP
    INSERT INTO public.part_revision_characteristics (organisation_id, part_revision_id, characteristic_key, nominal, lower_limit, upper_limit, unit_code)
    VALUES (org, r, v ->> 'key', (v ->> 'nom')::numeric, (v ->> 'nom')::numeric - 0.1, (v ->> 'nom')::numeric + 0.1, coalesce(v ->> 'unit', 'mm'));
  END LOOP;
  IF release THEN UPDATE public.part_revisions SET status = 'released' WHERE id = r; END IF;
  RETURN p;
END $$;

-- Makes a plan revision effective.
CREATE FUNCTION pg_temp.go_live(rev uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.control_plan_revisions SET status = 'pending_approval' WHERE id = rev;
  UPDATE public.control_plan_revisions SET status = 'approved' WHERE id = rev;
  UPDATE public.control_plan_revisions SET status = 'effective' WHERE id = rev;
END $$;

DO $$
DECLARE
  org uuid; fam uuid; p100 uuid; p200 uuid; p300 uuid; pin uuid; lone uuid; draftonly uuid; plan uuid; rev uuid; op uuid; op30 uuid; groove uuid;
  plan2 uuid; rev2 uuid; r jsonb; req jsonb;
BEGIN
  PERFORM pg_temp.login('34000000-0000-0000-0000-000000000101');
  org := app.create_organisation('Resolver Works', 'Plant A', 'PA', NULL);
  INSERT INTO public.part_families (organisation_id, code, name) VALUES (org, 'HCR', 'Hydraulic cylinder rods') RETURNING id INTO fam;
  p100 := pg_temp.part(org, fam, 'HCR-100', '[{"key":"LENGTH","nom":100}]');
  p200 := pg_temp.part(org, fam, 'HCR-200', '[{"key":"LENGTH","nom":200},{"key":"GROOVE_POS","nom":40}]');
  p300 := pg_temp.part(org, fam, 'HCR-300', '[]');                                -- no LENGTH value
  pin := pg_temp.part(org, fam, 'HCR-IN', '[{"key":"LENGTH","nom":4,"unit":"in"}]'); -- wrong unit
  draftonly := pg_temp.part(org, fam, 'HCR-DRAFT', '[{"key":"LENGTH","nom":50}]', false);
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'LONE', 'No family') RETURNING id INTO lone;

  -- Plan CP-HCR-001 for the family: OD fixed, LENGTH part-specific, GROOVE_POS only on HCR-200, VISUAL pass/fail.
  INSERT INTO public.control_plans (organisation_id, plan_code, title) VALUES (org, 'CP-HCR-001', 'Rods') RETURNING id INTO plan;
  INSERT INTO public.control_plan_applicability (organisation_id, control_plan_id, part_family_id) VALUES (org, plan, fam);
  INSERT INTO public.control_plan_revisions (organisation_id, control_plan_id, revision_code, change_reason) VALUES (org, plan, 'A', 'First') RETURNING id INTO rev;

  -- Before the plan is effective: blocked.
  r := app.resolve_inspection_requirements(p100);
  PERFORM pg_temp.assert_eq(r ->> 'status', 'blocked', 'no effective plan blocks');
  PERFORM pg_temp.assert_eq(r -> 'problems' -> 0 ->> 'code', 'no_effective_plan', 'reason: no effective plan');
  PERFORM pg_temp.assert_eq(r -> 'problems' -> 0 ->> 'message', 'No effective revision of CP-HCR-001', 'names the plan');

  INSERT INTO public.control_plan_operations (organisation_id, control_plan_revision_id, operation_code, sequence, name) VALUES (org, rev, 'OP-020', 20, 'Turning') RETURNING id INTO op;
  INSERT INTO public.control_plan_operations (organisation_id, control_plan_revision_id, operation_code, sequence, name) VALUES (org, rev, 'OP-030', 30, 'Grooving') RETURNING id INTO op30;
  INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, sequence, name, nominal, lower_limit, upper_limit, unit_code, spc_eligible, chart_type, subgroup_size)
    VALUES (org, rev, op, 'OD', 10, 'Outer diameter', 25, 24.95, 25.05, 'mm', true, 'xbar_r', 5);
  INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, sequence, name, value_source, spec_key, unit_code)
    VALUES (org, rev, op, 'LENGTH', 20, 'Overall length', 'part_spec', 'LENGTH', 'mm');
  INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, sequence, name, value_source, applies_to, spec_key, unit_code)
    VALUES (org, rev, op30, 'GROOVE_POS', 10, 'Groove position', 'part_spec', 'selected', 'GROOVE_POS', 'mm') RETURNING id INTO groove;
  INSERT INTO public.characteristic_applicability (organisation_id, control_plan_revision_id, plan_characteristic_id, part_id) VALUES (org, rev, groove, p200);
  INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, sequence, name, data_type)
    VALUES (org, rev, op30, 'VISUAL', 20, 'No chatter marks', 'attribute');
  INSERT INTO public.sampling_rules (organisation_id, control_plan_revision_id, plan_characteristic_id, trigger_type, interval_value, sample_size)
    SELECT org, rev, id, 'every_n_minutes', 30, 5 FROM public.control_plan_characteristics WHERE control_plan_revision_id = rev AND characteristic_key = 'OD';
  INSERT INTO public.reaction_plans (organisation_id, control_plan_revision_id, trigger_type, action, instruction) VALUES (org, rev, 'gauge_invalid', 'stop', 'Use a calibrated gauge');
  PERFORM pg_temp.go_live(rev);

  -- HCR-200: everything applies; LENGTH and GROOVE_POS come from its revision.
  r := app.resolve_inspection_requirements(p200);
  PERFORM pg_temp.assert_eq(r ->> 'status', 'ok', 'HCR-200 resolves');
  PERFORM pg_temp.assert_eq(r -> 'planRevision' ->> 'revisionCode', 'A', 'plan revision named');
  PERFORM pg_temp.assert_eq(r -> 'partRevision' ->> 'revision', 'A', 'part revision named');
  PERFORM pg_temp.assert_eq((SELECT string_agg(e ->> 'characteristicKey', ',') FROM jsonb_array_elements(r -> 'requirements') e), 'OD,LENGTH,GROOVE_POS,VISUAL', 'in operation and sequence order');
  SELECT e INTO req FROM jsonb_array_elements(r -> 'requirements') e WHERE e ->> 'characteristicKey' = 'OD';
  PERFORM pg_temp.assert_eq((req ->> 'nominal', req ->> 'lowerLimit', req ->> 'upperLimit', req ->> 'unitCode')::text, '(25,24.95,25.05,mm)', 'fixed values from the plan');
  PERFORM pg_temp.assert_eq(req -> 'sampling' -> 0 ->> 'sampleSize', '5', 'sampling included');
  PERFORM pg_temp.assert_eq(req -> 'reactions' -> 0 ->> 'action', 'stop', 'general reactions included');
  SELECT e INTO req FROM jsonb_array_elements(r -> 'requirements') e WHERE e ->> 'characteristicKey' = 'LENGTH';
  PERFORM pg_temp.assert_eq((req ->> 'nominal', req ->> 'lowerLimit', req ->> 'upperLimit')::text, '(200,199.9,200.1)', 'HCR-200 length from its revision');
  PERFORM pg_temp.assert_eq(req ->> 'partRevisionCharacteristicId' IS NOT NULL, true, 'source value referenced');
  SELECT e INTO req FROM jsonb_array_elements(r -> 'requirements') e WHERE e ->> 'characteristicKey' = 'GROOVE_POS';
  PERFORM pg_temp.assert_eq((req ->> 'applicable', req ->> 'nominal', req ->> 'applicability')::text, '(true,40,"Selected for HCR-200")', 'groove applies to HCR-200');

  -- HCR-100: groove shown as not applicable with the rule, not dropped.
  r := app.resolve_inspection_requirements(p100);
  PERFORM pg_temp.assert_eq(r ->> 'status', 'ok', 'HCR-100 resolves');
  SELECT e INTO req FROM jsonb_array_elements(r -> 'requirements') e WHERE e ->> 'characteristicKey' = 'GROOVE_POS';
  PERFORM pg_temp.assert_eq((req ->> 'applicable', req ->> 'applicability')::text, '(false,"Only for HCR-200")', 'groove not applicable to HCR-100, with why');
  SELECT e INTO req FROM jsonb_array_elements(r -> 'requirements') e WHERE e ->> 'characteristicKey' = 'LENGTH';
  PERFORM pg_temp.assert_eq(req ->> 'nominal', '100', 'HCR-100 length');

  -- Blocking cases.
  r := app.resolve_inspection_requirements(p300);
  PERFORM pg_temp.assert_eq((r ->> 'status', r -> 'problems' -> 0 ->> 'code', r -> 'problems' -> 0 ->> 'characteristicKey')::text, '(blocked,missing_spec_value,LENGTH)', 'missing part value blocks');
  PERFORM pg_temp.assert_eq(r -> 'problems' -> 0 ->> 'message', 'HCR-300 revision A has no LENGTH value (needed by Overall length)', 'says which value is missing');
  r := app.resolve_inspection_requirements(pin);
  PERFORM pg_temp.assert_eq(r -> 'problems' -> 0 ->> 'code', 'unit_mismatch', 'incompatible unit blocks');
  r := app.resolve_inspection_requirements(lone);
  PERFORM pg_temp.assert_eq(r -> 'problems' -> 0 ->> 'code', 'no_family', 'part without family blocks');
  r := app.resolve_inspection_requirements(draftonly);
  PERFORM pg_temp.assert_eq((SELECT string_agg(e ->> 'code', ',') FROM jsonb_array_elements(r -> 'problems') e), 'no_released_revision', 'no released revision blocks');
  r := app.resolve_inspection_requirements(draftonly, NULL, NULL, (SELECT id FROM public.part_revisions WHERE part_id = draftonly));
  PERFORM pg_temp.assert_eq(r -> 'problems' -> 0 ->> 'code', 'revision_not_released', 'a draft revision cannot be inspected');
  r := app.resolve_inspection_requirements(p100, 'op-090');
  PERFORM pg_temp.assert_eq(r -> 'problems' -> 0 ->> 'code', 'operation_not_in_plan', 'unknown operation blocks');
  r := app.resolve_inspection_requirements(p200, ' op-030 ');
  PERFORM pg_temp.assert_eq((r ->> 'status', jsonb_array_length(r -> 'requirements'))::text, '(ok,2)', 'one operation only');

  -- A second effective plan for the same family is ambiguous until scopes are narrowed.
  INSERT INTO public.control_plans (organisation_id, plan_code, title) VALUES (org, 'CP-HCR-002', 'Rods – final inspection') RETURNING id INTO plan2;
  INSERT INTO public.control_plan_applicability (organisation_id, control_plan_id, part_family_id) VALUES (org, plan2, fam);
  INSERT INTO public.control_plan_revisions (organisation_id, control_plan_id, revision_code, change_reason) VALUES (org, plan2, 'A', 'First') RETURNING id INTO rev2;
  INSERT INTO public.control_plan_operations (organisation_id, control_plan_revision_id, operation_code, name) VALUES (org, rev2, 'OP-090', 'Final') RETURNING id INTO op;
  INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, name, data_type) VALUES (org, rev2, op, 'PACK', 'Packed', 'attribute');
  PERFORM pg_temp.go_live(rev2);
  r := app.resolve_inspection_requirements(p100);
  PERFORM pg_temp.assert_eq((r ->> 'status', r -> 'problems' -> 0 ->> 'code')::text, '(blocked,ambiguous_plan)', 'two plans: ambiguous');
  PERFORM pg_temp.assert_eq(r -> 'problems' -> 0 ->> 'message' LIKE '%CP-HCR-001, CP-HCR-002%', true, 'names both plans');
  PERFORM pg_temp.assert_eq(r -> 'requirements', '[]'::jsonb, 'nothing resolved when ambiguous');
  UPDATE public.control_plan_applicability SET operation_code = 'OP-090' WHERE control_plan_id = plan2;
  UPDATE public.control_plan_applicability SET operation_code = 'OP-020' WHERE control_plan_id = plan;
  PERFORM pg_temp.assert_eq(app.resolve_inspection_requirements(p100) -> 'problems' -> 0 ->> 'code', 'ambiguous_plan', 'without an operation still ambiguous');
  r := app.resolve_inspection_requirements(p100, 'OP-090');
  PERFORM pg_temp.assert_eq((r ->> 'status', r -> 'plan' ->> 'planCode')::text, '(ok,CP-HCR-002)', 'operation picks the plan');
  r := app.resolve_inspection_requirements(p100, 'OP-020');
  PERFORM pg_temp.assert_eq((r ->> 'status', r -> 'plan' ->> 'planCode')::text, '(ok,CP-HCR-001)', 'and the other');

  PERFORM pg_temp.logout();
  INSERT INTO ids VALUES ('p100', p100);
END $$;

-- Another organisation's owner cannot resolve this organisation's parts.
DO $$
BEGIN
  PERFORM pg_temp.login('34000000-0000-0000-0000-000000000201');
  PERFORM app.create_organisation('Other Works');
  PERFORM pg_temp.assert_fails(format('SELECT app.resolve_inspection_requirements(%L)', (SELECT v FROM ids WHERE k = 'p100')), 'other organisation cannot resolve');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
