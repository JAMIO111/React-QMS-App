-- Supplier Quality SQ4b: inspection requirements (draft → approval by a different person → frozen, supersession), the resolver (specificity, strategies, plans, first-article, skip-lot),
-- the protection of controlled parts, determinations and lot holds on receipt, incoming inspection through the shared engine, dispositions, and NCs raised from a receipt line.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('4b000000-0000-0000-0000-000000000a01', 'ann@ii.test'), ('4b000000-0000-0000-0000-000000000a02', 'bob@ii.test'), ('4b000000-0000-0000-0000-000000000a03', 'cat@ii.test'),
  ('4b000000-0000-0000-0000-000000000a04', 'dan@ii.test'), ('4b000000-0000-0000-0000-000000000a05', 'eve@ii.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

-- A part with an effective one-check plan at operation INCOMING (criticality as given).
CREATE FUNCTION pg_temp.part_with_plan(p_org uuid, p_number text, p_criticality text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_part uuid; v_plan uuid; v_rev uuid; v_op uuid;
BEGIN
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (p_org, p_number, p_number) RETURNING id INTO v_part;
  INSERT INTO public.part_revisions (organisation_id, part_id, revision) VALUES (p_org, v_part, 'A');
  UPDATE public.part_revisions SET status = 'released' WHERE part_id = v_part;
  INSERT INTO public.control_plans (organisation_id, plan_code, title) VALUES (p_org, 'CP-' || p_number, 'Incoming ' || p_number) RETURNING id INTO v_plan;
  INSERT INTO public.control_plan_applicability (organisation_id, control_plan_id, part_id) VALUES (p_org, v_plan, v_part);
  INSERT INTO public.control_plan_revisions (organisation_id, control_plan_id, revision_code, change_reason) VALUES (p_org, v_plan, 'A', 'First') RETURNING id INTO v_rev;
  INSERT INTO public.control_plan_operations (organisation_id, control_plan_revision_id, operation_code, sequence, name) VALUES (p_org, v_rev, 'INCOMING', 10, 'Incoming') RETURNING id INTO v_op;
  INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, sequence, name, nominal, lower_limit, upper_limit, unit_code, criticality)
    VALUES (p_org, v_rev, v_op, 'DIA', 10, 'Diameter', 10, 9.9, 10.1, 'mm', p_criticality);
  UPDATE public.control_plan_revisions SET status = 'pending_approval' WHERE id = v_rev;
  UPDATE public.control_plan_revisions SET status = 'approved' WHERE id = v_rev;
  UPDATE public.control_plan_revisions SET status = 'effective' WHERE id = v_rev;
  RETURN v_part;
END $$;

-- One approved rule (written as a draft by one person, approved by another).
CREATE FUNCTION pg_temp.rule(p_org uuid, p_writer uuid, p_approver uuid, p_def jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid;
BEGIN
  PERFORM pg_temp.login(p_writer); v := app.save_inspection_requirement(p_org, NULL, p_def); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(p_approver); PERFORM app.approve_inspection_requirement(v, 'Approved for the test: reasons recorded'); PERFORM pg_temp.logout();
  RETURN v;
END $$;

DO $$
DECLARE
  ann uuid := '4b000000-0000-0000-0000-000000000a01'; bob uuid := '4b000000-0000-0000-0000-000000000a02'; cat uuid := '4b000000-0000-0000-0000-000000000a03';
  dan uuid := '4b000000-0000-0000-0000-000000000a04'; eve uuid := '4b000000-0000-0000-0000-000000000a05';
  org uuid; org2 uuid; site uuid; m uuid; role_id uuid; s1 uuid; s2 uuid; cls uuid; fam uuid; p_min uuid; p_crit uuid; p_noplan uuid; p_fam uuid;
  r1 uuid; r2 uuid; r3 uuid; r_new uuid; v jsonb; gr uuid; line uuid; line2 uuid; insp uuid; samp uuid; v_lot uuid; res jsonb; i integer; ncr jsonb; r_def uuid; r_plan uuid;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('II Alpha', 'Plant A', 'PA', NULL); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('II Beta'); PERFORM pg_temp.logout();
  FOREACH m IN ARRAY ARRAY[bob, cat, dan] LOOP
    INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, m, 'active');
    SELECT id INTO role_id FROM public.roles WHERE organisation_id = org AND key = CASE m WHEN bob THEN 'viewer' WHEN cat THEN 'quality_manager' ELSE 'quality_engineer' END;
    INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, ou.id, role_id FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id = m;
  END LOOP;
  SELECT id INTO site FROM public.sites WHERE organisation_id = org;
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'ACME', 'Acme Metals') RETURNING id INTO s1;
  INSERT INTO public.suppliers (organisation_id, code, name, risk_rating) VALUES (org, 'BOLT', 'Bolt Co', NULL) RETURNING id INTO s2;
  SELECT id INTO cls FROM public.supplier_classifications WHERE organisation_id = org AND key = 'welding';
  INSERT INTO public.supplier_classification_links (organisation_id, supplier_id, classification_id) VALUES (org, s1, cls);
  INSERT INTO public.part_families (organisation_id, code, name) VALUES (org, 'FAM', 'Family') RETURNING id INTO fam;
  PERFORM pg_temp.login(ann);
  p_min := pg_temp.part_with_plan(org, 'P-MIN', 'minor');
  p_crit := pg_temp.part_with_plan(org, 'P-CRIT', 'critical');
  p_fam := pg_temp.part_with_plan(org, 'P-FAM', 'minor');
  UPDATE public.parts SET part_family_id = fam WHERE id = p_fam;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'P-NOPLAN', 'No plan') RETURNING id INTO p_noplan;
  PERFORM pg_temp.logout();

  -- ---- who may write rules, and the shape of a rule ----
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.save_inspection_requirement(%L, NULL, '{"name":"X","strategy":"full"}'::jsonb)$f$, org)), 5), '42501', 'a viewer cannot write a requirement');
  PERFORM pg_temp.assert_fails(format($f$INSERT INTO public.supplier_inspection_requirements (organisation_id, name, strategy) VALUES (%L, 'Direct', 'full')$f$, org), 'rules are written only through functions');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(dan);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.save_inspection_requirement(%L, NULL, '{"name":"X","strategy":"full","sampleSize":5}'::jsonb)$f$, org)), 2), '23', 'a full rule takes no sample size');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.save_inspection_requirement(%L, NULL, '{"name":"X","strategy":"fixed"}'::jsonb)$f$, org)), 2), '23', 'a fixed rule needs a sample size');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.save_inspection_requirement(%L, NULL, '{"name":"X","strategy":"percentage","percentage":150}'::jsonb)$f$, org)), 2), '23', 'a percentage is up to 100');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.save_inspection_requirement(%L, NULL, '{"name":"X","strategy":"plan","plan":[{"fromQuantity":1,"toQuantity":10,"sampleSize":3,"acceptNumber":3}]}'::jsonb)$f$, org)), 2), '23', 'the accept number is below the sample size');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.save_inspection_requirement(%L, NULL, '{"name":"X","strategy":"plan","plan":[{"fromQuantity":1,"toQuantity":10,"sampleSize":3,"acceptNumber":0},{"fromQuantity":5,"toQuantity":20,"sampleSize":5,"acceptNumber":0}]}'::jsonb)$f$, org)), 2), '23', 'plan bands cannot overlap');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.save_inspection_requirement(%L, NULL, '{"name":"X","strategy":"full","price":1}'::jsonb)$f$, org)), 5), 'QM021', 'an unknown field is refused');
  r1 := app.save_inspection_requirement(org, NULL, '{"name":"Default: every unit","strategy":"full","level":"normal"}'::jsonb);
  PERFORM app.save_inspection_requirement(org, r1, '{"name":"Default: every unit (edited)"}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT (status, name)::text FROM public.supplier_inspection_requirements WHERE id = r1), '(draft,"Default: every unit (edited)")', 'a draft can be edited');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.approve_inspection_requirement(%L, 'Fine')$f$, r1)), 5), '42501', 'an engineer cannot approve');
  PERFORM pg_temp.logout();
  -- nobody approves their own work, even with the right to approve
  PERFORM pg_temp.login(ann);
  r_new := app.save_inspection_requirement(org, NULL, '{"name":"Ann''s draft","strategy":"full"}'::jsonb);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.approve_inspection_requirement(%L, 'Approving my own draft')$f$, r_new)), 5), 'QM021', 'an approver cannot approve what they wrote');
  PERFORM app.retire_inspection_requirement(r_new, 'Only a test of the rule');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  PERFORM app.approve_inspection_requirement(r1, 'Every unit until we know the supplier');
  PERFORM pg_temp.assert_eq((SELECT (status, approved_by = cat, reduces_controls)::text FROM public.supplier_inspection_requirements WHERE id = r1), '(approved,t,f)', 'an approver other than the writer approves it');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.save_inspection_requirement(%L, %L, '{"name":"Changed"}'::jsonb)$f$, org, r1)), 5), 'QM021', 'an approved rule is not edited');
  PERFORM pg_temp.assert_fails(format($f$UPDATE public.supplier_inspection_requirements SET name = 'Changed' WHERE id = %L$f$, r1), 'nor written to directly');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.approve_inspection_requirement(%L, 'Again')$f$, r1)), 5), 'QM021', 'only a draft is approved');
  PERFORM pg_temp.logout();
  -- a rule that reduces controls needs a real reason
  PERFORM pg_temp.login(dan);
  r2 := app.save_inspection_requirement(org, NULL, '{"name":"Skip lots","strategy":"skip_lot","level":"skip","sampleSize":3,"skipEvery":2}'::jsonb);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.approve_inspection_requirement(%L, 'ok')$f$, r2)), 5), 'QM021', 'reducing inspection needs a reason of at least 10 characters');
  PERFORM pg_temp.logout();

  -- ---- the resolver ----
  PERFORM pg_temp.login(cat);
  v := app.preview_incoming_inspection(s1, p_min, 100);
  PERFORM pg_temp.assert_eq((v ->> 'strategy', (v ->> 'required')::boolean, (v ->> 'sampleSize')::int)::text, '(full,t,100)', 'the organisation default applies when nothing is more specific');
  v := app.preview_incoming_inspection(s1, NULL, 100);
  PERFORM pg_temp.assert_eq((v ->> 'required')::boolean, false, 'a material has no plan, so no inspection through the engine');
  PERFORM pg_temp.logout();
  r_def := pg_temp.rule(org, dan, cat, '{"name":"Acme: 10 percent","strategy":"percentage","percentage":10,"supplierId":null}'::jsonb);
  PERFORM pg_temp.login(cat);
  v := app.preview_incoming_inspection(s1, p_min, 100);
  PERFORM pg_temp.assert_eq((v ->> 'strategy', (v ->> 'sampleSize')::int)::text, '(percentage,10)', 'a newer rule at the same specificity wins');
  v := app.preview_incoming_inspection(s1, p_min, 7);
  PERFORM pg_temp.assert_eq((v ->> 'sampleSize')::int, 1, 'a percentage is rounded up and at least one unit');
  PERFORM pg_temp.logout();
  r3 := pg_temp.rule(org, dan, cat, format('{"name":"Acme fixed","strategy":"fixed","sampleSize":8,"acceptNumber":1,"supplierId":"%s"}', s1)::jsonb);
  PERFORM pg_temp.rule(org, dan, cat, format('{"name":"Welding suppliers: plan","strategy":"plan","classificationId":"%s","plan":[{"fromQuantity":1,"toQuantity":50,"sampleSize":5,"acceptNumber":0},{"fromQuantity":51,"toQuantity":500,"sampleSize":20,"acceptNumber":1}]}', cls)::jsonb);
  PERFORM pg_temp.rule(org, dan, cat, format('{"name":"Family rule","strategy":"fixed","sampleSize":4,"partFamilyId":"%s"}', fam)::jsonb);
  PERFORM pg_temp.login(cat);
  v := app.preview_incoming_inspection(s1, p_min, 100);
  PERFORM pg_temp.assert_eq((v ->> 'ruleName', (v ->> 'sampleSize')::int, (v ->> 'acceptNumber')::int)::text, '("Acme fixed",8,1)', 'a supplier rule beats a classification rule and the default');
  v := app.preview_incoming_inspection(s1, p_fam, 100);
  PERFORM pg_temp.assert_eq(v ->> 'ruleName', 'Family rule', 'a part family rule beats a supplier rule');
  v := app.preview_incoming_inspection(s2, p_min, 3);
  PERFORM pg_temp.assert_eq((v ->> 'strategy', (v ->> 'sampleSize')::int)::text, '(percentage,1)', 'another supplier only gets the rules that name no supplier');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.preview_incoming_inspection(%L, %L, 5)$f$, (SELECT id FROM public.suppliers WHERE organisation_id = org2), p_min)), 5), 'P0002', 'a foreign supplier is not found');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.preview_incoming_inspection(%L, %L, 5)$f$, s1, p_min)), 5), 'P0002', 'another organisation cannot preview');
  PERFORM pg_temp.logout();
  -- plan bands
  PERFORM pg_temp.login(dan);
  r_new := app.save_inspection_requirement(org, NULL, format('{"name":"Acme fixed (new)","strategy":"plan","supplierId":"%s","supersedesId":"%s","plan":[{"fromQuantity":1,"toQuantity":50,"sampleSize":5,"acceptNumber":0},{"fromQuantity":51,"toQuantity":500,"sampleSize":20,"acceptNumber":1}]}', s1, r3)::jsonb);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  PERFORM app.approve_inspection_requirement(r_new, 'Moving to a plan');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.supplier_inspection_requirements WHERE id = r3), 'superseded', 'approving a replacement supersedes the old rule');
  v := app.preview_incoming_inspection(s1, p_min, 30);
  PERFORM pg_temp.assert_eq((v ->> 'sampleSize')::int, 5, 'the plan band for 30 units');
  v := app.preview_incoming_inspection(s1, p_min, 200);
  PERFORM pg_temp.assert_eq((v ->> 'sampleSize')::int || '/' || (v ->> 'acceptNumber'), '20/1', 'and for 200');
  v := app.preview_incoming_inspection(s1, p_min, 1000);
  PERFORM pg_temp.assert_eq(((v ->> 'sampleSize')::int, (v ->> 'overridden')::boolean)::text, '(1000,t)', 'a lot outside every band is inspected in full');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.save_inspection_requirement(%L, NULL, jsonb_build_object('name', 'Bad', 'strategy', 'full', 'supersedesId', %L))$f$, org, r3)), 5), 'QM021', 'only an approved rule can be superseded');
  PERFORM pg_temp.logout();

  -- ---- controlled parts are never reduced ----
  PERFORM pg_temp.login(ann);
  PERFORM app.approve_inspection_requirement((SELECT id FROM public.supplier_inspection_requirements WHERE name = 'Skip lots'), 'Skip lots for good suppliers, reviewed yearly');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  v := app.preview_incoming_inspection(s2, p_min, 10);
  PERFORM pg_temp.assert_eq((v ->> 'strategy', (v ->> 'required')::boolean)::text, '(skip_lot,f)', 'the newest rule of the same specificity (skip-lot: every second delivery) applies, and the first delivery is skipped');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(dan);
  PERFORM pg_temp.rule(org, dan, ann, format('{"name":"Bolt: no inspection","strategy":"none","level":"skip","rationale":"Trusted supplier, reviewed yearly","supplierId":"%s"}', s2)::jsonb);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  v := app.preview_incoming_inspection(s2, p_min, 10);
  PERFORM pg_temp.assert_eq((v ->> 'required')::boolean, false, 'a part without critical characteristics may have its inspection reduced');
  v := app.preview_incoming_inspection(s2, p_crit, 10);
  PERFORM pg_temp.assert_eq(((v ->> 'required')::boolean, v ->> 'strategy', (v ->> 'overridden')::boolean, (v ->> 'controlled')::boolean, (v ->> 'sampleSize')::int)::text, '(t,full,t,t,10)', 'a part with a critical characteristic is inspected in full whatever the rule says');
  v := app.preview_incoming_inspection(s2, p_noplan, 10);
  PERFORM pg_temp.assert_eq(((v ->> 'required')::boolean, (v ->> 'controlled')::boolean)::text, '(t,t)', 'and so is a part whose plan cannot be resolved');
  PERFORM pg_temp.logout();

  -- ---- a receipt: determination and lot hold ----
  PERFORM pg_temp.login(dan);
  gr := ((app.record_goods_receipt(s2, NULL, site, current_date, 'DN-1', NULL, jsonb_build_array(jsonb_build_object('partId', p_min, 'quantity', 10, 'lotNumber', 'LOT-NONE'), jsonb_build_object('partId', p_crit, 'quantity', 4, 'lotNumber', 'LOT-CRIT')), NULL)) ->> 'id')::uuid;
  SELECT id INTO line2 FROM public.goods_receipt_lines WHERE goods_receipt_id = gr AND line_number = 1;
  SELECT id INTO line FROM public.goods_receipt_lines WHERE goods_receipt_id = gr AND line_number = 2;
  PERFORM pg_temp.assert_eq((SELECT (required, strategy)::text FROM public.incoming_inspection_determinations WHERE receipt_line_id = line2), '(f,none)', 'a rule that says none leaves the line uninspected');
  PERFORM pg_temp.assert_eq((SELECT (required, strategy, overridden, sample_size)::text FROM public.incoming_inspection_determinations WHERE receipt_line_id = line), '(t,full,t,4)', 'the controlled part is determined as full inspection, with the override recorded');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.lots WHERE lot_number = 'LOT-NONE'), 'open', 'a lot that needs no inspection stays open');
  PERFORM pg_temp.assert_eq((SELECT (status, status_reason ~ 'Awaiting incoming inspection')::text FROM public.lots WHERE lot_number = 'LOT-CRIT'), '(on_hold,t)', 'a lot awaiting inspection is held');
  PERFORM pg_temp.assert_fails(format($f$UPDATE public.incoming_inspection_determinations SET required = false WHERE receipt_line_id = %L$f$, line), 'a determination is never changed');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.start_incoming_inspection(%L)$f$, line2)), 5), 'QM021', 'no inspection can be started where none is required');
  PERFORM pg_temp.assert_eq((app.incoming_inspection_assessment(line2) ->> 'state'), 'not_required', 'and the assessment says so');
  PERFORM pg_temp.assert_eq((app.incoming_inspection_assessment(line) ->> 'state', app.incoming_inspection_assessment(line) ->> 'outcome')::text, '(not_started,incomplete)', 'a required inspection that has not started is incomplete');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.disposition_receipt_line(%L, 'accepted', NULL, NULL)$f$, line)), 5), 'QM021', 'goods that need inspection cannot be accepted before it is done');
  PERFORM pg_temp.logout(); PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.start_incoming_inspection(%L)$f$, line)), 5), '42501', 'a viewer cannot start an inspection (the engine needs inspection.record)');
  PERFORM pg_temp.logout();

  -- ---- inspecting through the shared engine ----
  PERFORM pg_temp.login(ann);
  insp := app.start_incoming_inspection(line);
  PERFORM pg_temp.assert_eq((SELECT (trigger_type, lot, lot_size, status, operation_code)::text FROM public.inspection_records WHERE id = insp), '(incoming,LOT-CRIT,4,in_progress,INCOMING)', 'the engine makes the inspection, with the lot and its size');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.start_incoming_inspection(%L)$f$, line)), 5), 'QM021', 'one inspection per line');
  PERFORM pg_temp.assert_eq(app.incoming_inspection_assessment(line) ->> 'state', 'in_progress', 'in progress');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.disposition_receipt_line(%L, 'accepted', NULL, NULL)$f$, line)), 5), 'QM021', 'still not acceptable while the inspection is open');
  FOR i IN 1..3 LOOP
    INSERT INTO public.inspection_samples (organisation_id, inspection_record_id, trigger_type) VALUES (org, insp, 'manual') RETURNING id INTO samp;
    INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_numeric)
      SELECT org, insp, samp, q.id, 10 FROM public.resolved_inspection_requirements q WHERE q.inspection_record_id = insp;
  END LOOP;
  UPDATE public.inspection_records SET status = 'completed' WHERE id = insp;
  PERFORM pg_temp.assert_eq((app.incoming_inspection_assessment(line) ->> 'outcome', app.incoming_inspection_assessment(line) ->> 'samples')::text, '(incomplete,3)', 'complete but with fewer samples than required is still incomplete');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.disposition_receipt_line(%L, 'accepted', NULL, NULL)$f$, line)), 5), 'QM021', 'so it cannot be accepted');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(dan);
  PERFORM app.disposition_receipt_line(line, 'held', 'Waiting for the fourth sample', NULL);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.disposition_receipt_line(%L, 'held', 'Again', NULL)$f$, line)), 5), 'QM021', 'the same decision twice is refused');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.disposition_receipt_line(%L, 'conditional', 'Needed on the line', 'Use on job 12 only')$f$, line)), 5), '42501', 'only an approver accepts conditionally');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.disposition_receipt_line(%L, 'rejected', '', NULL)$f$, line)), 5), 'QM021', 'a rejection needs a reason');
  PERFORM app.disposition_receipt_line(line, 'rejected', 'Four units out of tolerance on the first delivery', NULL);
  PERFORM pg_temp.assert_eq((SELECT status FROM public.lots WHERE lot_number = 'LOT-CRIT'), 'on_hold', 'a rejected lot stays on hold');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.disposition_receipt_line(%L, 'held', 'Second thoughts', NULL)$f$, line)), 5), '42501', 'only an approver changes a rejection');
  -- the NC from the line
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.raise_ncr_from_receipt_line(%L, NULL, NULL, NULL, NULL, NULL)$f$, line)), 5), '42501', 'a viewer cannot raise a non-conformance');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(dan);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.raise_ncr_from_receipt_line(%L, NULL, NULL, 'huge', NULL, NULL)$f$, line)), 5), 'QM021', 'a severity is minor, major or critical');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.raise_ncr_from_receipt_line(%L, NULL, NULL, 'major', NULL, 99)$f$, line)), 5), 'QM021', 'the quantity cannot exceed what was received');
  ncr := app.raise_ncr_from_receipt_line(line, NULL, 'Out of tolerance on arrival', 'major', NULL, 2);
  PERFORM pg_temp.assert_eq((ncr ->> 'created')::boolean, true, 'a non-conformance is raised from the line');
  PERFORM pg_temp.assert_eq((SELECT (source, stage, severity, supplier_id = s2, part_id = p_crit, quantity_affected, lot_number)::text FROM public.nonconformances WHERE id = (ncr ->> 'nonconformanceId')::uuid), '(goods_receiving,draft,major,t,t,2,LOT-CRIT)', 'it is a central goods-receiving NC for that supplier, part, lot and quantity');
  PERFORM pg_temp.assert_eq((app.raise_ncr_from_receipt_line(line, NULL, NULL, 'major', NULL, NULL) ->> 'created')::boolean, false, 'raising again returns the same NC');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.receipt_line_ncrs WHERE receipt_line_id = line), 1::bigint, 'and the link is kept once');
  PERFORM pg_temp.logout();
  -- an approver can reverse a rejection, accept conditionally and release the lot
  PERFORM pg_temp.login(cat);
  PERFORM app.disposition_receipt_line(line, 'conditional', 'Needed on the line; sorted by us', 'Use on job 12 only, 100% re-inspect');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.lots WHERE lot_number = 'LOT-CRIT'), 'released', 'a conditional acceptance releases the lot');
  PERFORM pg_temp.assert_eq((SELECT array_agg(decision ORDER BY decided_at) FROM public.receipt_line_dispositions WHERE receipt_line_id = line), ARRAY['held', 'rejected', 'conditional'], 'every decision is kept in order');
  PERFORM pg_temp.assert_fails(format($f$DELETE FROM public.receipt_line_dispositions WHERE receipt_line_id = %L$f$, line), 'decisions are never deleted');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.retire_inspection_requirement(%L, 'x')$f$, r_def)), 5), 'QM021', 'retiring needs a reason');
  PERFORM app.retire_inspection_requirement(r_def, 'Replaced by the supplier-specific rules');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.supplier_inspection_requirements WHERE id = r_def), 'retired', 'a rule is retired with a reason and kept');
  PERFORM pg_temp.logout();

  -- ---- accepting inspected goods once the evidence supports it ----
  PERFORM pg_temp.login(dan);
  gr := ((app.record_goods_receipt(s1, NULL, site, current_date, 'DN-2', NULL, jsonb_build_array(jsonb_build_object('partId', p_min, 'quantity', 30, 'lotNumber', 'LOT-OK')), NULL)) ->> 'id')::uuid;
  SELECT id INTO line FROM public.goods_receipt_lines WHERE goods_receipt_id = gr;
  PERFORM pg_temp.assert_eq((SELECT (sample_size, accept_number, rule_name)::text FROM public.incoming_inspection_determinations WHERE receipt_line_id = line), '(5,0,"Acme fixed (new)")', 'the plan band for 30 units: 5 samples, accept 0');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ann);
  insp := app.start_incoming_inspection(line);
  FOR i IN 1..5 LOOP
    INSERT INTO public.inspection_samples (organisation_id, inspection_record_id, trigger_type) VALUES (org, insp, 'manual') RETURNING id INTO samp;
    INSERT INTO public.inspection_measurements (organisation_id, inspection_record_id, sample_id, requirement_id, value_numeric)
      SELECT org, insp, samp, q.id, 10 FROM public.resolved_inspection_requirements q WHERE q.inspection_record_id = insp;
  END LOOP;
  UPDATE public.inspection_records SET status = 'completed' WHERE id = insp;
  PERFORM pg_temp.assert_eq((app.incoming_inspection_assessment(line) ->> 'outcome', app.incoming_inspection_assessment(line) ->> 'samples', app.incoming_inspection_assessment(line) ->> 'failedSamples')::text, '(acceptable,5,0)', 'five good samples satisfy the plan');
  PERFORM app.disposition_receipt_line(line, 'accepted', NULL, NULL);
  PERFORM pg_temp.assert_eq((SELECT status FROM public.lots WHERE lot_number = 'LOT-OK'), 'released', 'accepting releases the lot');
  PERFORM pg_temp.logout();

  -- ---- another organisation ----
  PERFORM pg_temp.login(eve);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.supplier_inspection_requirements) + (SELECT count(*) FROM public.incoming_inspection_determinations) + (SELECT count(*) FROM public.incoming_inspections) + (SELECT count(*) FROM public.receipt_line_dispositions) + (SELECT count(*) FROM public.receipt_line_ncrs), 0::bigint, 'another organisation sees none of it');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.disposition_receipt_line(%L, 'held', 'Foreign hold', NULL)$f$, line)), 5), 'P0002', 'it cannot decide on a foreign line');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.start_incoming_inspection(%L)$f$, line)), 5), 'P0002', 'or start its inspection');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.raise_ncr_from_receipt_line(%L, NULL, NULL, NULL, NULL, NULL)$f$, line)), 5), 'P0002', 'or raise an NC from it');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.approve_inspection_requirement(%L, 'Foreign approval')$f$, r1)), 5), 'P0002', 'or approve a foreign rule');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) >= 8 FROM public.audit_events WHERE entity_type IN ('supplier_inspection_requirements', 'incoming_inspection_determinations', 'receipt_line_dispositions', 'incoming_inspections')), true, 'it is all audited');
END $$;
ROLLBACK;
