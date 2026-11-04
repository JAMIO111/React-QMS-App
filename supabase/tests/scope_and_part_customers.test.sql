-- PC3b: parts with several customers (one primary), plans scoped to a single part (standalone, no
-- family), and precedence: a plan in force for the part itself overrides plans for its family; two at
-- the same level still block.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES ('35000000-0000-0000-0000-000000000101', 'owner@scope.test');

CREATE FUNCTION pg_temp.go_live(rev uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.control_plan_revisions SET status = 'pending_approval' WHERE id = rev;
  UPDATE public.control_plan_revisions SET status = 'approved' WHERE id = rev;
  UPDATE public.control_plan_revisions SET status = 'effective' WHERE id = rev;
END $$;

-- A plan with one fixed characteristic at OP-010, scoped by (family, part); made effective unless told not to.
CREATE FUNCTION pg_temp.plan(org uuid, code text, fam uuid, part uuid, live boolean DEFAULT true) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE plan uuid; rev uuid; op uuid;
BEGIN
  INSERT INTO public.control_plans (organisation_id, plan_code, title) VALUES (org, code, code) RETURNING id INTO plan;
  INSERT INTO public.control_plan_applicability (organisation_id, control_plan_id, part_family_id, part_id) VALUES (org, plan, fam, part);
  INSERT INTO public.control_plan_revisions (organisation_id, control_plan_id, revision_code, change_reason) VALUES (org, plan, 'A', 'First') RETURNING id INTO rev;
  INSERT INTO public.control_plan_operations (organisation_id, control_plan_revision_id, operation_code, name) VALUES (org, rev, 'OP-010', 'Op') RETURNING id INTO op;
  INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, name, upper_limit, unit_code)
    VALUES (org, rev, op, 'OD', 'OD', 1, 'mm');
  IF live THEN PERFORM pg_temp.go_live(rev); END IF;
  RETURN plan;
END $$;

DO $$
DECLARE
  org uuid; fam uuid; p100 uuid; p200 uuid; lone uuid; c1 uuid; c2 uuid; c3 uuid; famplan uuid; partplan uuid; r jsonb; link uuid;
BEGIN
  PERFORM pg_temp.login('35000000-0000-0000-0000-000000000101');
  org := app.create_organisation('Scope Works', 'Plant A', 'PA', NULL);

  -- Customers of a part.
  INSERT INTO public.customers (organisation_id, code, name) VALUES (org, 'ACME', 'Acme') RETURNING id INTO c1;
  INSERT INTO public.customers (organisation_id, code, name) VALUES (org, 'BETA', 'Beta') RETURNING id INTO c2;
  INSERT INTO public.customers (organisation_id, code, name) VALUES (org, 'GAMMA', 'Gamma') RETURNING id INTO c3;
  INSERT INTO public.part_families (organisation_id, code, name) VALUES (org, 'HCR', 'Rods') RETURNING id INTO fam;
  INSERT INTO public.parts (organisation_id, part_number, name, part_family_id) VALUES (org, 'HCR-100', 'Rod 100', fam) RETURNING id INTO p100;
  INSERT INTO public.parts (organisation_id, part_number, name, part_family_id) VALUES (org, 'HCR-200', 'Rod 200', fam) RETURNING id INTO p200;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'SPECIAL-1', 'One-off') RETURNING id INTO lone;
  INSERT INTO public.part_revisions (organisation_id, part_id, revision) SELECT org, id, 'A' FROM public.parts WHERE organisation_id = org;
  UPDATE public.part_revisions SET status = 'released' WHERE organisation_id = org;

  INSERT INTO public.part_customers (organisation_id, part_id, customer_id, customer_part_number) VALUES (org, p100, c1, 'ACME-77') RETURNING id INTO link;
  PERFORM pg_temp.assert_eq((SELECT is_primary FROM public.part_customers WHERE id = link), true, 'first customer is primary');
  INSERT INTO public.part_customers (organisation_id, part_id, customer_id) VALUES (org, p100, c2);
  INSERT INTO public.part_customers (organisation_id, part_id, customer_id, is_primary) VALUES (org, p100, c3, true);
  PERFORM pg_temp.assert_eq((SELECT string_agg(c.code, ',') FROM public.part_customers pc JOIN public.customers c ON c.id = pc.customer_id WHERE pc.part_id = p100 AND pc.is_primary), 'GAMMA', 'primary moves');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.part_customers (organisation_id, part_id, customer_id) VALUES (%L, %L, %L)$q$, org, p100, c1), 'a customer once per part');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.part_customers SET customer_id = %L WHERE id = %L$q$, c2, link), 'customer of a link cannot change');
  DELETE FROM public.part_customers WHERE part_id = p100 AND customer_id = c3;
  -- (Within one transaction the remaining links share a creation time, so which one is promoted is not asserted.)
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.part_customers WHERE part_id = p100 AND is_primary), 1::bigint, 'removing the primary promotes another');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.part_customers WHERE part_id = p100), 2::bigint, 'two customers left');

  -- A scope entry names a family, a part, or both; never neither.
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.control_plans (organisation_id, plan_code, title) VALUES (%L, 'X', 'X'); INSERT INTO public.control_plan_applicability (organisation_id, control_plan_id) SELECT %L, id FROM public.control_plans WHERE plan_code = 'X'$q$, org, org), 'scope needs a family or a part');

  -- Standalone: a part without a family, named by its own plan.
  r := app.resolve_inspection_requirements(lone);
  PERFORM pg_temp.assert_eq(r -> 'problems' -> 0 ->> 'code', 'no_family', 'no family and no plan');
  PERFORM pg_temp.plan(org, 'CP-SPECIAL', NULL, lone);
  r := app.resolve_inspection_requirements(lone);
  PERFORM pg_temp.assert_eq((r ->> 'status', r -> 'plan' ->> 'planCode', r ->> 'scopeLevel')::text, '(ok,CP-SPECIAL,part)', 'standalone plan resolves');

  -- Family plan for both rods; HCR-100 gets its own plan, which overrides the family plan for it only.
  famplan := pg_temp.plan(org, 'CP-HCR', fam, NULL);
  partplan := pg_temp.plan(org, 'CP-HCR-100', NULL, p100, false);
  r := app.resolve_inspection_requirements(p100);
  PERFORM pg_temp.assert_eq((r -> 'plan' ->> 'planCode', r ->> 'scopeLevel')::text, '(CP-HCR,family)', 'a part plan not yet in force does not override');
  PERFORM pg_temp.go_live((SELECT id FROM public.control_plan_revisions WHERE control_plan_id = partplan));
  r := app.resolve_inspection_requirements(p100);
  PERFORM pg_temp.assert_eq((r ->> 'status', r -> 'plan' ->> 'planCode', r ->> 'scopeLevel', r -> 'overriddenPlans' -> 0 ->> 'planCode')::text,
    '(ok,CP-HCR-100,part,CP-HCR)', 'part plan overrides the family plan');
  r := app.resolve_inspection_requirements(p200);
  PERFORM pg_temp.assert_eq((r -> 'plan' ->> 'planCode', jsonb_array_length(r -> 'overriddenPlans'))::text, '(CP-HCR,0)', 'other family members keep the family plan');

  -- Two plans in force for the part itself: ambiguous.
  PERFORM pg_temp.plan(org, 'CP-HCR-100-B', NULL, p100);
  r := app.resolve_inspection_requirements(p100);
  PERFORM pg_temp.assert_eq((r ->> 'status', r -> 'problems' -> 0 ->> 'code')::text, '(blocked,ambiguous_plan)', 'two part plans block');
  PERFORM pg_temp.assert_eq(r -> 'problems' -> 0 ->> 'message' LIKE '%HCR-100 itself%', true, 'says at which level');

  -- Family changes: a part named on its own may move; a part named with its family may not.
  UPDATE public.parts SET part_family_id = fam WHERE id = lone;
  PERFORM pg_temp.assert_eq((SELECT part_family_id FROM public.parts WHERE id = lone), fam, 'standalone part can join a family');
  INSERT INTO public.control_plan_applicability (organisation_id, control_plan_id, part_family_id, part_id) VALUES (org, famplan, fam, p200);
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.parts SET part_family_id = NULL WHERE id = %L$q$, p200), 'named with its family: cannot leave');

  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
