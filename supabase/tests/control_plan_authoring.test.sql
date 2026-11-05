-- Process control PC2: operations, characteristics (fixed / part-specific / conditional, attribute),
-- part lists, sampling rules and reactions — value rules, draft-only editing, copy into a new
-- revision, submit checks, permissions and history.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('33000000-0000-0000-0000-000000000101', 'owner@pca.test'),
  ('33000000-0000-0000-0000-000000000103', 'inspector@pca.test');

CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);
GRANT SELECT ON ids TO authenticated;

DO $$
DECLARE
  org uuid; fam uuid; p100 uuid; p200 uuid; outside uuid; plan uuid; ra uuid; rb uuid; op uuid; op2 uuid; op_b uuid;
  od uuid; len uuid; groove uuid; vis uuid; m uuid; gt uuid; n bigint;
BEGIN
  PERFORM pg_temp.login('33000000-0000-0000-0000-000000000101');
  org := app.create_organisation('PCA Works', 'Plant A', 'PA', NULL);
  INSERT INTO public.part_families (organisation_id, code, name) VALUES (org, 'HCR', 'Rods') RETURNING id INTO fam;
  INSERT INTO public.parts (organisation_id, part_number, name, part_family_id) VALUES (org, 'HCR-100', 'Rod 100', fam) RETURNING id INTO p100;
  INSERT INTO public.parts (organisation_id, part_number, name, part_family_id) VALUES (org, 'HCR-200', 'Rod 200', fam) RETURNING id INTO p200;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'OTHER', 'Not in family') RETURNING id INTO outside;
  INSERT INTO public.gauge_types (organisation_id, name) VALUES (org, 'Micrometer 0-25') RETURNING id INTO gt;
  INSERT INTO public.control_plans (organisation_id, plan_code, title) VALUES (org, 'CP-1', 'Rods') RETURNING id INTO plan;
  INSERT INTO public.control_plan_applicability (organisation_id, control_plan_id, part_family_id) VALUES (org, plan, fam);
  INSERT INTO public.control_plan_revisions (organisation_id, control_plan_id, revision_code, change_reason) VALUES (org, plan, 'A', 'First') RETURNING id INTO ra;

  -- An empty revision cannot be submitted.
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.control_plan_revisions SET status = 'pending_approval' WHERE id = %L$q$, ra), 'empty revision cannot be submitted');

  -- Operations.
  INSERT INTO public.control_plan_operations (organisation_id, control_plan_revision_id, operation_code, sequence, name, work_centre)
    VALUES (org, ra, ' op-020 ', 20, 'CNC turning', 'Turning') RETURNING id INTO op;
  PERFORM pg_temp.assert_eq((SELECT operation_code FROM public.control_plan_operations WHERE id = op), 'OP-020', 'operation codes normalised');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.control_plan_operations (organisation_id, control_plan_revision_id, operation_code, name) VALUES (%L, %L, 'OP-020', 'Dup')$q$, org, ra), 'one operation per code');
  INSERT INTO public.control_plan_operations (organisation_id, control_plan_revision_id, operation_code, sequence, name) VALUES (org, ra, 'OP-030', 30, 'Grinding') RETURNING id INTO op2;

  -- Characteristic value rules.
  INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, name,
      nominal, lower_limit, upper_limit, unit_code, gauge_type_id, criticality, spc_eligible, chart_type, subgroup_size)
    VALUES (org, ra, op, 'OD', 'Outer diameter', 25, 24.95, 25.05, 'mm', gt, 'critical', true, 'xbar_r', 5) RETURNING id INTO od;
  INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, name,
      value_source, unit_code, spec_key, spc_eligible, chart_type, subgroup_size)
    VALUES (org, ra, op, 'LENGTH', 'Overall length', 'part_spec', 'mm', 'LENGTH', true, 'imr', 1) RETURNING id INTO len;
  INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, name,
      value_source, applies_to, unit_code, spec_key)
    VALUES (org, ra, op2, 'GROOVE_POS', 'Groove position', 'part_spec', 'selected', 'mm', 'GROOVE_POS') RETURNING id INTO groove;
  INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, name, data_type)
    VALUES (org, ra, op2, 'VISUAL', 'Free from chatter marks', 'attribute') RETURNING id INTO vis;
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, name, unit_code, nominal) VALUES (%L, %L, %L, 'X1', 'No limits', 'mm', 1)$q$, org, ra, op), 'fixed values need a limit');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, name, value_source, unit_code, spec_key, upper_limit) VALUES (%L, %L, %L, 'X2', 'Spec with limits', 'part_spec', 'mm', 'X2', 1)$q$, org, ra, op), 'part-specific values come from the part');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, name, value_source, unit_code) VALUES (%L, %L, %L, 'X3', 'No key', 'part_spec', 'mm')$q$, org, ra, op), 'part-specific needs a spec key');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, name, data_type, unit_code) VALUES (%L, %L, %L, 'X4', 'Attr unit', 'attribute', 'mm')$q$, org, ra, op), 'attributes have no unit');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, name, upper_limit, unit_code, spc_eligible, chart_type, subgroup_size) VALUES (%L, %L, %L, 'X5', 'Bad subgroup', 1, 'mm', true, 'imr', 5)$q$, org, ra, op), 'I-MR uses subgroups of one');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, name, upper_limit, unit_code) VALUES (%L, %L, %L, 'OD', 'Dup', 1, 'mm')$q$, org, ra, op), 'one characteristic per key');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.control_plan_characteristics SET characteristic_key = 'DIA' WHERE id = %L$q$, od), 'keys cannot be renamed');
  PERFORM pg_temp.assert_fails(format($q$DELETE FROM public.control_plan_operations WHERE id = %L$q$, op), 'operation with characteristics cannot be removed');

  -- Conditional parts.
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.control_plan_revisions SET status = 'pending_approval' WHERE id = %L$q$, ra), 'conditional characteristic needs parts');
  INSERT INTO public.characteristic_applicability (organisation_id, control_plan_revision_id, plan_characteristic_id, part_id) VALUES (org, ra, groove, p200);
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.characteristic_applicability (organisation_id, control_plan_revision_id, plan_characteristic_id, part_id) VALUES (%L, %L, %L, %L)$q$, org, ra, groove, outside), 'part must be in the plan scope');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.characteristic_applicability (organisation_id, control_plan_revision_id, plan_characteristic_id, part_id) VALUES (%L, %L, %L, %L)$q$, org, ra, od, p100), 'only conditional characteristics list parts');

  -- Sampling and reactions.
  INSERT INTO public.sampling_rules (organisation_id, control_plan_revision_id, plan_characteristic_id, trigger_type, sample_size) VALUES (org, ra, od, 'first_off', 1);
  INSERT INTO public.sampling_rules (organisation_id, control_plan_revision_id, plan_characteristic_id, trigger_type, interval_value, sample_size) VALUES (org, ra, od, 'every_n_minutes', 30, 5);
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.sampling_rules (organisation_id, control_plan_revision_id, plan_characteristic_id, trigger_type, sample_size) VALUES (%L, %L, %L, 'every_n_parts', 1)$q$, org, ra, od), 'every N parts needs N');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.sampling_rules (organisation_id, control_plan_revision_id, plan_characteristic_id, trigger_type, interval_value, sample_size) VALUES (%L, %L, %L, 'first_off', 5, 1)$q$, org, ra, len), 'first-off takes no interval');
  INSERT INTO public.reaction_plans (organisation_id, control_plan_revision_id, plan_characteristic_id, trigger_type, action, instruction) VALUES (org, ra, od, 'out_of_spec', 'hold', 'Stop the machine, quarantine since last good check');
  INSERT INTO public.reaction_plans (organisation_id, control_plan_revision_id, trigger_type, action, instruction) VALUES (org, ra, 'gauge_invalid', 'stop', 'Do not measure with an overdue gauge');

  -- Approve A; content is then locked.
  UPDATE public.control_plan_revisions SET status = 'pending_approval' WHERE id = ra;
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.control_plan_characteristics SET upper_limit = 25.1 WHERE id = %L$q$, od), 'under review: locked');
  UPDATE public.control_plan_revisions SET status = 'approved' WHERE id = ra;
  UPDATE public.control_plan_revisions SET status = 'effective' WHERE id = ra;
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.control_plan_characteristics SET upper_limit = 25.1 WHERE id = %L$q$, od), 'effective: characteristics locked');
  PERFORM pg_temp.assert_fails(format($q$DELETE FROM public.sampling_rules WHERE plan_characteristic_id = %L$q$, od), 'effective: sampling locked');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.control_plan_operations (organisation_id, control_plan_revision_id, operation_code, name) VALUES (%L, %L, 'OP-040', 'x')$q$, org, ra), 'effective: no new operations');
  PERFORM pg_temp.assert_fails(format($q$DELETE FROM public.characteristic_applicability WHERE plan_characteristic_id = %L$q$, groove), 'effective: part list locked');

  -- B copies A; editing B leaves A unchanged.
  INSERT INTO public.control_plan_revisions (organisation_id, control_plan_id, revision_code, change_reason) VALUES (org, plan, 'B', 'Tighter OD') RETURNING id INTO rb;
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.control_plan_operations WHERE control_plan_revision_id = rb), 2::bigint, 'operations copied');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.control_plan_characteristics WHERE control_plan_revision_id = rb), 4::bigint, 'characteristics copied');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.characteristic_applicability WHERE control_plan_revision_id = rb), 1::bigint, 'part lists copied');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.sampling_rules WHERE control_plan_revision_id = rb), 2::bigint, 'sampling copied');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.reaction_plans WHERE control_plan_revision_id = rb), 2::bigint, 'reactions copied');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.reaction_plans WHERE control_plan_revision_id = rb AND plan_characteristic_id IS NULL), 1::bigint, 'revision-wide reaction copied as such');
  SELECT id INTO op_b FROM public.control_plan_operations WHERE control_plan_revision_id = rb AND operation_code = 'OP-020';
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.control_plan_characteristics WHERE control_plan_revision_id = rb AND operation_id = op_b), 2::bigint, 'copies attached to the copied operation');
  UPDATE public.control_plan_characteristics SET lower_limit = 24.98, upper_limit = 25.02 WHERE control_plan_revision_id = rb AND characteristic_key = 'OD';
  PERFORM pg_temp.assert_eq((SELECT upper_limit FROM public.control_plan_characteristics WHERE id = od), 25.05::numeric, 'A keeps its limits');
  -- Switching the groove check to all parts clears its list; removing a characteristic removes its rules.
  UPDATE public.control_plan_characteristics SET applies_to = 'all' WHERE control_plan_revision_id = rb AND characteristic_key = 'GROOVE_POS';
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.characteristic_applicability WHERE control_plan_revision_id = rb), 0::bigint, 'part list cleared');
  DELETE FROM public.control_plan_characteristics WHERE control_plan_revision_id = rb AND characteristic_key = 'OD';
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.sampling_rules WHERE control_plan_revision_id = rb), 0::bigint, 'rules removed with the characteristic');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.sampling_rules WHERE control_plan_revision_id = ra), 2::bigint, 'A keeps its rules');

  -- History covers content, including removed rows.
  SELECT count(*) INTO n FROM app.control_plan_history(plan) WHERE entity_type = 'control_plan_characteristics' AND action = 'delete';
  PERFORM pg_temp.assert_eq(n, 1::bigint, 'removed characteristic in history');
  SELECT count(*) INTO n FROM app.control_plan_history(plan) WHERE entity_type = 'sampling_rules';
  PERFORM pg_temp.assert_eq(n >= 6, true, 'sampling rule changes in history');

  PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '33000000-0000-0000-0000-000000000103', 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'inspector';
  INSERT INTO ids VALUES ('org', org), ('rb', rb), ('op_b', op_b);
END $$;

-- Inspectors read plan content but cannot change it.
DO $$
DECLARE org uuid := (SELECT v FROM ids WHERE k = 'org'); rb uuid := (SELECT v FROM ids WHERE k = 'rb');
BEGIN
  PERFORM pg_temp.login('33000000-0000-0000-0000-000000000103');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.control_plan_characteristics WHERE control_plan_revision_id = rb), 3::bigint, 'inspector reads characteristics');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.control_plan_operations (organisation_id, control_plan_revision_id, operation_code, name) VALUES (%L, %L, 'OP-090', 'x')$q$, org, rb), 'inspector cannot add operations');
  PERFORM pg_temp.assert_eq(pg_temp.affected(format($q$DELETE FROM public.control_plan_characteristics WHERE control_plan_revision_id = %L$q$, rb)), 0::bigint, 'inspector cannot remove characteristics');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
