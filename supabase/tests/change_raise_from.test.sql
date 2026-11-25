-- Change management CH4: raising a change from a record — the new origin kinds, who may read the source, the suggestion for each kind, and that the origin sticks.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('4f000000-0000-0000-0000-000000000c01', 'ann@ch4.test'), ('4f000000-0000-0000-0000-000000000c02', 'bob@ch4.test'),
  ('4f000000-0000-0000-0000-000000000c03', 'eve@ch4.test'), ('4f000000-0000-0000-0000-000000000c04', 'cat@ch4.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '4f000000-0000-0000-0000-000000000c01'; bob uuid := '4f000000-0000-0000-0000-000000000c02';
  eve uuid := '4f000000-0000-0000-0000-000000000c03'; cat uuid := '4f000000-0000-0000-0000-000000000c04';
  org uuid; org2 uuid; m uuid; part uuid; sup uuid; mach uuid; nc uuid; nc2 uuid; capa uuid; act uuid; risk uuid; rev uuid; dec uuid; fnd uuid; dcr uuid; dcr_open uuid; doc uuid;
  d jsonb; r text; c uuid; v_type uuid; t_proc uuid;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('CH4 Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('CH4 Beta'); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, bob, 'active'), (org, cat, 'active');
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = CASE ou.user_id WHEN cat THEN 'quality_engineer' ELSE 'viewer' END)
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id IN (bob, cat);
  SELECT id INTO t_proc FROM public.change_types WHERE organisation_id = org AND key = 'process';

  PERFORM pg_temp.login(ann);
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'BR-100', 'Bracket') RETURNING id INTO part;
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'CAST', 'Castings Ltd') RETURNING id INTO sup;
  INSERT INTO public.machines (organisation_id, code, name) VALUES (org, 'M1', 'Mill 1') RETURNING id INTO mach;
  INSERT INTO public.nonconformances (organisation_id, source, supplier_id, part_id, causal_process_id, title, severity, quantity_affected, description, stage, category_id, requirement, actual_result)
    VALUES (org, 'supplier', sup, part, mach, 'Porosity in castings', 'major', 20, 'Porosity found at machining', 'open', pg_temp.cat(org), 'No porosity over 0.5 mm', '1.2 mm voids') RETURNING id INTO nc;
  capa := app.start_capa(org, 'Repeat porosity', 'Third porosity NC this quarter', NULL, NULL, NULL);
  PERFORM app.link_capa_ncr(capa, nc);
  INSERT INTO public.capa_actions (organisation_id, capa_id, phase, description) VALUES (org, capa, 'corrective', 'Change the drawing to call out a porosity limit') RETURNING id INTO act;
  INSERT INTO public.capa_actions (organisation_id, capa_id, phase, description) VALUES (org, capa, 'interim', 'Sort the stock') RETURNING id INTO dec;
  risk := app.create_risk(org, jsonb_build_object('title', 'Casting porosity', 'categoryId', (SELECT id FROM public.risk_categories WHERE organisation_id = org AND key = 'supplier')));
  PERFORM app.set_risk_links(risk, jsonb_build_array(jsonb_build_object('kind', 'part', 'id', part), jsonb_build_object('kind', 'supplier', 'id', sup), jsonb_build_object('kind', 'operation_code', 'code', 'OP20')));
  rev := app.plan_management_review(org, '{"title":"H1 review","periodFrom":"2026-01-01","periodTo":"2026-06-30"}'::jsonb);
  PERFORM app.start_management_review(rev);
  PERFORM pg_temp.logout();
  -- Rows that are expensive to build through their own modules (an audit finding, a document change request) are written with triggers and foreign keys off.
  SET LOCAL session_replication_role = replica;
  INSERT INTO public.audit_findings (organisation_id, reference, audit_record_id, classification_id, title, description, requirement)
    VALUES (org, 'AF-26-0001', gen_random_uuid(), gen_random_uuid(), 'No control of tooling', 'Tool store has no log', 'Tooling shall be logged') RETURNING id INTO fnd;
  INSERT INTO public.documents (organisation_id, number, title, type_id, content_kind, owner_user_id) VALUES (org, 'SOP-001', 'Deburring', (SELECT id FROM public.document_types WHERE organisation_id = org LIMIT 1), 'text', ann) RETURNING id INTO doc;
  INSERT INTO public.document_links (organisation_id, document_id, part_id) VALUES (org, doc, part);
  INSERT INTO public.document_change_requests (organisation_id, reference, document_id, what, why, requested_by, status, revision_id, decided_by, decided_at)
    VALUES (org, 'DCR-26-0001', doc, 'Add the porosity limit', 'Customer complaint', ann, 'accepted', gen_random_uuid(), ann, now()) RETURNING id INTO dcr;
  INSERT INTO public.document_change_requests (organisation_id, reference, document_id, what, why, requested_by, status)
    VALUES (org, 'DCR-26-0002', doc, 'Reword step 3', 'Unclear', ann, 'open') RETURNING id INTO dcr_open;
  SET LOCAL session_replication_role = origin;
  SELECT id INTO dec FROM public.management_review_decisions LIMIT 1;
  PERFORM pg_temp.login(ann);
  dec := app.add_management_review_decision(rev, 'Update the control plan for all castings', 'improvement');
  act := act;  -- (the corrective action's id is kept)
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve);
  INSERT INTO public.nonconformances (organisation_id, source, title, severity, quantity_affected, description, stage, category_id)
    VALUES (org2, 'internal', 'Theirs', 'minor', 1, 'x', 'open', pg_temp.cat(org2)) RETURNING id INTO nc2;
  PERFORM pg_temp.logout();

  -- ---- a draft from each kind of record ----
  PERFORM pg_temp.login(cat);
  d := app.change_draft_from('ncr', nc);
  PERFORM pg_temp.assert_eq(d ->> 'title', 'Change after ' || (SELECT reference FROM public.nonconformances WHERE id = nc) || ': Porosity in castings', 'an NC names itself in the title');
  PERFORM pg_temp.assert_eq((SELECT key FROM public.change_types WHERE id = (d ->> 'typeId')::uuid), 'material', 'a supplier NC suggests a material change');
  PERFORM pg_temp.assert_eq((SELECT array_agg(x ->> 'kind' ORDER BY x ->> 'kind') FROM jsonb_array_elements(d -> 'links') x), ARRAY['machine', 'part', 'supplier'], 'it suggests the part, supplier and machine');
  PERFORM pg_temp.assert_eq((d ->> 'reason') LIKE '%No porosity over 0.5 mm%' AND (d ->> 'reason') LIKE '%1.2 mm voids%', true, 'the why carries what was required and found');
  PERFORM pg_temp.assert_eq(d -> 'source' ->> 'kind', 'ncr', 'it names its source');
  d := app.change_draft_from('capa', capa);
  PERFORM pg_temp.assert_eq((d ->> 'reason') LIKE '%Third porosity NC this quarter%', true, 'an 8D brings its problem statement');
  PERFORM pg_temp.assert_eq((SELECT array_agg(x ->> 'kind' ORDER BY x ->> 'kind') FROM jsonb_array_elements(d -> 'links') x), ARRAY['part', 'supplier'], 'and the parts and suppliers of its NCs');
  d := app.change_draft_from('capa_action', act);
  PERFORM pg_temp.assert_eq(d ->> 'description', 'Change the drawing to call out a porosity limit', 'an action is what the change does');
  PERFORM pg_temp.assert_eq(d -> 'source' ->> 'kind', 'capa_action', 'and says it came from the action');
  d := app.change_draft_from('audit_finding', fnd);
  PERFORM pg_temp.assert_eq((SELECT key FROM public.change_types WHERE id = (d ->> 'typeId')::uuid), 'documentation', 'a finding suggests a documentation change');
  PERFORM pg_temp.assert_eq((d ->> 'reason') LIKE '%Tooling shall be logged%', true, 'with the requirement as the why');
  d := app.change_draft_from('risk', risk);
  PERFORM pg_temp.assert_eq((SELECT array_agg(x ->> 'kind' ORDER BY x ->> 'kind') FROM jsonb_array_elements(d -> 'links') x), ARRAY['operation_code', 'part', 'supplier'], 'a risk brings what it was linked to');
  d := app.change_draft_from('document_change_request', dcr);
  PERFORM pg_temp.assert_eq(d ->> 'description', 'Add the porosity limit', 'an accepted document change request brings what it asked');
  PERFORM pg_temp.assert_eq((SELECT array_agg(x ->> 'kind') FROM jsonb_array_elements(d -> 'links') x), ARRAY['part'], 'and what the document is linked to');
  d := app.change_draft_from('management_review_decision', dec);
  PERFORM pg_temp.assert_eq(d ->> 'title', 'Update the control plan for all castings', 'a decision is the title');
  PERFORM pg_temp.assert_eq((d ->> 'reason') LIKE '%management review%', true, 'with the review as the why');

  -- ---- what is refused ----
  r := pg_temp.fails(format('SELECT app.change_draft_from(%L, %L)', 'document_change_request', dcr_open));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'a document change request that is still open is not a source');
  r := pg_temp.fails(format('SELECT app.change_draft_from(%L, %L)', 'capa_action', (SELECT id FROM public.capa_actions WHERE description = 'Sort the stock')));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'an interim containment action is not a source');
  r := pg_temp.fails(format('SELECT app.change_draft_from(%L, %L)', 'ncr', nc2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'another organisation''s NC is not found');
  r := pg_temp.fails(format('SELECT app.change_draft_from(%L, %L)', 'supplier', sup));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'a kind that is not a source is not found');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(bob);
  r := pg_temp.fails(format('SELECT app.change_draft_from(%L, %L)', 'ncr', nc));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'someone who cannot manage changes gets no suggestion');
  PERFORM pg_temp.logout();

  -- ---- raising it: each new kind is accepted, and the origin sticks ----
  PERFORM pg_temp.login(cat);
  c := app.create_change(org, jsonb_build_object('title', 'From an 8D action', 'typeId', t_proc, 'origin', jsonb_build_object('kind', 'capa_action', 'id', act)));
  PERFORM pg_temp.assert_eq((SELECT origin_kind FROM public.change_requests WHERE id = c), 'capa_action', 'raised from an 8D action');
  c := app.create_change(org, jsonb_build_object('title', 'From a decision', 'typeId', t_proc, 'origin', jsonb_build_object('kind', 'management_review_decision', 'id', dec)));
  PERFORM pg_temp.assert_eq((SELECT origin_kind FROM public.change_requests WHERE id = c), 'management_review_decision', 'raised from a review decision');
  c := app.create_change(org, jsonb_build_object('title', 'From a request', 'typeId', t_proc, 'origin', jsonb_build_object('kind', 'document_change_request', 'id', dcr)));
  PERFORM pg_temp.assert_eq((SELECT origin_kind FROM public.change_requests WHERE id = c), 'document_change_request', 'raised from an accepted document change request');
  r := pg_temp.fails(format($f$SELECT app.create_change(%L, jsonb_build_object('title', 'x', 'typeId', %L, 'origin', jsonb_build_object('kind', 'document_change_request', 'id', %L)))$f$, org, t_proc, dcr_open));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'a request that is not accepted cannot be an origin');
  r := pg_temp.fails(format($f$SELECT app.create_change(%L, jsonb_build_object('title', 'x', 'typeId', %L, 'origin', jsonb_build_object('kind', 'supplier', 'id', %L)))$f$, org, t_proc, sup));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'a supplier is not an origin');
  r := pg_temp.fails(format($f$SELECT app.create_change(%L, jsonb_build_object('title', 'x', 'typeId', %L, 'origin', jsonb_build_object('kind', 'management_review_decision', 'id', %L)))$f$, org2, t_proc, dec));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'nor can it be raised in an organisation the person does not belong to');
  PERFORM pg_temp.logout();
  r := pg_temp.fails(format('UPDATE public.change_requests SET origin_kind = ''risk'', origin_id = %L WHERE id = %L', risk, c));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM035', 'the origin never changes, even with SQL');
  RAISE NOTICE 'change raise-from: ok';
END $$;
ROLLBACK;
