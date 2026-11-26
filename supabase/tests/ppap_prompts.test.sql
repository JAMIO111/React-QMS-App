-- PPAP PP6a: raising a PPAP from a record: who may read the source, what each kind suggests (nothing is saved), and that the reason is set once and never changes.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('8f000000-0000-0000-0000-000000000a01', 'ann@pq.test'), ('8f000000-0000-0000-0000-000000000a02', 'bob@pq.test'),
  ('8f000000-0000-0000-0000-000000000a03', 'cat@pq.test'), ('8f000000-0000-0000-0000-000000000a04', 'eve@pq.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '8f000000-0000-0000-0000-000000000a01'; bob uuid := '8f000000-0000-0000-0000-000000000a02';
  cat uuid := '8f000000-0000-0000-0000-000000000a03'; eve uuid := '8f000000-0000-0000-0000-000000000a04';
  org uuid; org2 uuid; fam uuid; p1 uuid; p2 uuid; p3 uuid; r1a uuid; r1b uuid; r2 uuid; r3 uuid; c1 uuid; c2 uuid; chg uuid; chg2 uuid; chg3 uuid; plan uuid; pr uuid; plan2 uuid; pr2 uuid;
  other_rev uuid; s1 uuid; s2 uuid; d jsonb; r text;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('PQ Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('PQ Beta'); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, bob, 'active'), (org, cat, 'active');
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = CASE ou.user_id WHEN cat THEN 'quality_engineer' ELSE 'viewer' END)
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id IN (bob, cat);

  PERFORM pg_temp.login(ann);
  INSERT INTO public.part_families (organisation_id, code, name) VALUES (org, 'FAM', 'Brackets') RETURNING id INTO fam;
  INSERT INTO public.parts (organisation_id, part_number, name, part_family_id) VALUES (org, 'PQ-1', 'Bracket', fam) RETURNING id INTO p1;
  INSERT INTO public.parts (organisation_id, part_number, name, part_family_id) VALUES (org, 'PQ-2', 'Bracket long', fam) RETURNING id INTO p2;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'PQ-3', 'Washer') RETURNING id INTO p3;
  INSERT INTO public.part_revisions (organisation_id, part_id, revision) VALUES (org, p1, 'A') RETURNING id INTO r1a;
  UPDATE public.part_revisions SET status = 'released' WHERE id = r1a;
  INSERT INTO public.part_revisions (organisation_id, part_id, revision) VALUES (org, p1, 'B') RETURNING id INTO r1b;
  INSERT INTO public.part_revisions (organisation_id, part_id, revision) VALUES (org, p2, 'A') RETURNING id INTO r2;
  UPDATE public.part_revisions SET status = 'released' WHERE id = r2;
  INSERT INTO public.part_revisions (organisation_id, part_id, revision) VALUES (org, p3, 'A') RETURNING id INTO r3;
  UPDATE public.part_revisions SET status = 'released' WHERE id = r3;
  INSERT INTO public.customers (organisation_id, code, name) VALUES (org, 'WAYNE', 'Wayne Ltd') RETURNING id INTO c1;
  INSERT INTO public.customers (organisation_id, code, name) VALUES (org, 'STARK', 'Stark Ltd') RETURNING id INTO c2;
  INSERT INTO public.part_customers (organisation_id, part_id, customer_id, is_primary) VALUES (org, p1, c1, true), (org, p1, c2, false), (org, p2, c1, true);
  chg := app.create_change(org, jsonb_build_object('title', 'New drawing for the bracket', 'typeId', (SELECT id FROM public.change_types WHERE organisation_id = org AND key = 'product_design')));
  PERFORM app.set_change_links(chg, jsonb_build_array(jsonb_build_object('kind', 'part', 'id', p1)));
  chg2 := app.create_change(org, jsonb_build_object('title', 'New oven for the family', 'typeId', (SELECT id FROM public.change_types WHERE organisation_id = org AND key = 'process')));
  PERFORM app.set_change_links(chg2, jsonb_build_array(jsonb_build_object('kind', 'part_family', 'id', fam)));
  chg3 := app.create_change(org, jsonb_build_object('title', 'Different steel for the bracket', 'typeId', (SELECT id FROM public.change_types WHERE organisation_id = org AND key = 'material')));
  PERFORM app.set_change_links(chg3, jsonb_build_array(jsonb_build_object('kind', 'part', 'id', p2), jsonb_build_object('kind', 'customer', 'id', c1)));
  INSERT INTO public.control_plans (organisation_id, plan_code, title) VALUES (org, 'CP-1', 'Bracket plan') RETURNING id INTO plan;
  INSERT INTO public.control_plan_applicability (organisation_id, control_plan_id, part_family_id, part_id) VALUES (org, plan, fam, p1);
  INSERT INTO public.control_plan_revisions (organisation_id, control_plan_id, revision_code, change_reason) VALUES (org, plan, 'A', 'First') RETURNING id INTO pr;
  INSERT INTO public.control_plans (organisation_id, plan_code, title) VALUES (org, 'CP-2', 'Family plan') RETURNING id INTO plan2;
  INSERT INTO public.control_plan_applicability (organisation_id, control_plan_id, part_family_id) VALUES (org, plan2, fam);
  INSERT INTO public.control_plan_revisions (organisation_id, control_plan_id, revision_code, change_reason) VALUES (org, plan2, 'A', 'First') RETURNING id INTO pr2;
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve);
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org2, 'THEIRS', 'Theirs') RETURNING id INTO p3;
  INSERT INTO public.part_revisions (organisation_id, part_id, revision) VALUES (org2, p3, 'A') RETURNING id INTO other_rev;
  PERFORM pg_temp.logout();

  -- ---- a suggestion from each kind of record ----
  PERFORM pg_temp.login(cat);
  d := app.ppap_draft_from('part_revision', r1a);
  PERFORM pg_temp.assert_eq(d ->> 'partId', p1::text, 'a part revision suggests its part');
  PERFORM pg_temp.assert_eq(d ->> 'partRevisionId', r1a::text, 'and itself');
  PERFORM pg_temp.assert_eq(d ->> 'reason', 'new_part', 'the first revision of a part suggests a new part');
  PERFORM pg_temp.assert_eq(d ->> 'customerId', c1::text, 'with two customers the primary one is suggested');
  PERFORM pg_temp.assert_eq(jsonb_array_length(d -> 'customers'), 2, 'and both are offered');
  PERFORM pg_temp.assert_eq((d ->> 'notes') LIKE 'Raised from part revision PQ-1 rev A: Bracket', true, 'the notes say where it came from');
  d := app.ppap_draft_from('part_revision', r1b);
  PERFORM pg_temp.assert_eq(d ->> 'reason', 'engineering_change', 'a later revision suggests an engineering change');
  d := app.ppap_draft_from('part_revision', r2);
  PERFORM pg_temp.assert_eq(d ->> 'customerId', c1::text, 'a part with one customer suggests that customer');
  d := app.ppap_draft_from('change', chg);
  PERFORM pg_temp.assert_eq(d ->> 'reason', 'engineering_change', 'a product design change suggests an engineering change');
  PERFORM pg_temp.assert_eq(d ->> 'partId', p1::text, 'the part it names');
  PERFORM pg_temp.assert_eq(d ->> 'partRevisionId', r1a::text, 'with the revision in force');
  d := app.ppap_draft_from('change', chg2);
  PERFORM pg_temp.assert_eq(d ->> 'reason', 'process_change', 'a process change suggests a process change');
  PERFORM pg_temp.assert_eq(d ->> 'partId', NULL::text, 'a family with two parts names no single part');
  PERFORM pg_temp.assert_eq(jsonb_array_length(d -> 'parts'), 2, 'it lists them for the person to choose');
  d := app.ppap_draft_from('change', chg3);
  PERFORM pg_temp.assert_eq(d ->> 'reason', 'alternate_material_or_supplier', 'a material change suggests an alternate material or supplier');
  PERFORM pg_temp.assert_eq(d ->> 'customerId', c1::text, 'the customer the change names, when they buy the part');
  d := app.ppap_draft_from('control_plan_revision', pr);
  PERFORM pg_temp.assert_eq(d ->> 'reason', 'process_change', 'a control plan revision suggests a process change');
  PERFORM pg_temp.assert_eq(d ->> 'partId', p1::text, 'a plan for one part names it');
  d := app.ppap_draft_from('control_plan_revision', pr2);
  PERFORM pg_temp.assert_eq(jsonb_array_length(d -> 'parts'), 2, 'a plan for a family lists its parts');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.ppap_submissions), 0::bigint, 'a suggestion saves nothing');

  -- ---- who may ask ----
  r := pg_temp.fails(format($f$SELECT app.ppap_draft_from('part_revision', %L)$f$, other_rev));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'another organisation''s record is not found');
  r := pg_temp.fails(format($f$SELECT app.ppap_draft_from('change', %L)$f$, gen_random_uuid()));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'nor is one that does not exist');
  r := pg_temp.fails($f$SELECT app.ppap_draft_from('risk', gen_random_uuid())$f$);
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'nor is a kind that cannot start a PPAP');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(bob);
  r := pg_temp.fails(format($f$SELECT app.ppap_draft_from('part_revision', %L)$f$, r1a));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'a viewer cannot raise a PPAP, even from a record they can read');
  PERFORM pg_temp.logout();

  -- ---- recording where it came from ----
  PERFORM pg_temp.login(cat);
  s1 := (app.create_ppap(org, jsonb_build_object('partId', p1, 'customerId', c1, 'reason', 'engineering_change')) ->> 'id')::uuid;
  s2 := (app.create_ppap(org, jsonb_build_object('partId', p2, 'customerId', c1, 'reason', 'new_part')) ->> 'id')::uuid;
  PERFORM pg_temp.assert_eq((SELECT origin_kind FROM public.ppap_submissions WHERE id = s1), NULL::text, 'a PPAP starts with no origin');
  PERFORM app.set_ppap_origin(s1, 'change', chg);
  PERFORM pg_temp.assert_eq((SELECT origin_kind FROM public.ppap_submissions WHERE id = s1), 'change', 'the origin is recorded');
  PERFORM pg_temp.assert_eq((SELECT origin_id FROM public.ppap_submissions WHERE id = s1), chg, 'with the record');
  r := pg_temp.fails(format($f$SELECT app.set_ppap_origin(%L, 'part_revision', %L)$f$, s1, r1a));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM037', 'it cannot be given a second time');
  PERFORM pg_temp.assert_eq((SELECT origin_kind FROM public.ppap_submissions WHERE id = s1), 'change', 'and nothing changed');
  r := pg_temp.fails(format($f$SELECT app.set_ppap_origin(%L, 'part_revision', %L)$f$, s2, other_rev));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'another organisation''s record cannot be named');
  r := pg_temp.fails(format($f$SELECT app.set_ppap_origin(%L, 'risk', %L)$f$, s2, chg));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM037', 'only the three kinds can be the reason');
  r := pg_temp.fails(format($f$SELECT app.set_ppap_origin(%L, 'change', %L)$f$, gen_random_uuid(), chg));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'a PPAP that is not there is not found');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(bob);
  r := pg_temp.fails(format($f$SELECT app.set_ppap_origin(%L, 'change', %L)$f$, s2, chg));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'a viewer cannot record an origin');
  PERFORM pg_temp.logout();

  -- ---- held for SQL too ----
  r := pg_temp.fails(format($f$UPDATE public.ppap_submissions SET origin_kind = 'part_revision', origin_id = %L WHERE id = %L$f$, r1a, s1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM037', 'SQL cannot change an origin');
  r := pg_temp.fails(format($f$UPDATE public.ppap_submissions SET origin_kind = NULL, origin_id = NULL WHERE id = %L$f$, s1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM037', 'nor clear it');
  r := pg_temp.fails(format($f$UPDATE public.ppap_submissions SET origin_kind = 'change', origin_id = %L WHERE id = %L$f$, chg, s2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM037', 'nor give one outside the function');
  PERFORM pg_temp.assert_eq((SELECT origin_kind FROM public.ppap_submissions WHERE id = s2), NULL::text, 'and nothing was set');
  r := pg_temp.fails(format($f$UPDATE public.ppap_submissions SET origin_kind = 'change' WHERE id = %L$f$, s2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM037', 'a kind with no record is refused (the trigger answers before the check)');
END $$;

ROLLBACK;
