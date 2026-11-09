-- Supplier Quality SQ6a: a supplier can be what an audit is relevant to - on the definition, in its versions and on the record - without changing the fingerprint of any audit
-- that has no supplier target, and with the same rules as machines, operations and departments (own organisation, no duplicates, only the audit's own on a record).
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES ('5b000000-0000-0000-0000-000000000a01', 'ann@sat.test'), ('5b000000-0000-0000-0000-000000000a02', 'eve@sat.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;
CREATE FUNCTION pg_temp.settle() RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED; RETURN 'ok';
EXCEPTION WHEN OTHERS THEN SET CONSTRAINTS ALL DEFERRED; RETURN SQLSTATE || ': ' || SQLERRM;
END $$;

DO $$
DECLARE
  ann uuid := '5b000000-0000-0000-0000-000000000a01'; eve uuid := '5b000000-0000-0000-0000-000000000a02';
  org uuid; org2 uuid; site uuid; mach uuid; s1 uuid; s2 uuid; s3 uuid; sx uuid; a1 uuid; a2 uuid; rec uuid; r text; old_hash text; v integer;
  base jsonb := '[{"question":"Is the supplier''s quality manual current?","answerType":"pass_fail","critical":true}]';
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('SAT Alpha', 'Plant A', 'PA', NULL); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('SAT Beta'); PERFORM pg_temp.logout();
  SELECT id INTO site FROM public.sites WHERE organisation_id = org;
  INSERT INTO public.machines (organisation_id, code, name, site_id) VALUES (org, 'CNC-1', 'Lathe', site) RETURNING id INTO mach;
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'ACME', 'Acme Metals') RETURNING id INTO s1;
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'BOLT', 'Bolt Co') RETURNING id INTO s2;
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'CAST', 'Cast Ltd') RETURNING id INTO s3;
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org2, 'OTHR', 'Other') RETURNING id INTO sx;

  PERFORM pg_temp.login(ann);
  -- ---- an audit with no supplier target hashes exactly as it always did ----
  INSERT INTO public.audit_definitions (organisation_id, title, audit_type, frequency_kind, first_due_on, pass_mark) VALUES (org, 'Cell audit', 'layered_process', 'weekly', current_date, 90) RETURNING id INTO a2;
  PERFORM app.set_audit_checklist(a2, base);
  PERFORM app.set_audit_targets(a2, jsonb_build_array(jsonb_build_object('kind', 'machine', 'machineId', mach), jsonb_build_object('kind', 'operation', 'operationCode', 'OP-10')));
  PERFORM pg_temp.logout();
  SELECT md5(jsonb_build_object(
    'h', jsonb_build_array(d.title, d.audit_type, d.purpose, d.procedure, d.pass_mark),
    'q', coalesce((SELECT jsonb_agg(app.audit_question_json(q.sequence, q.question, q.guidance, q.answer_type, q.pass_answer, q.unit, q.lower_limit, q.upper_limit, q.nominal, q.options, q.rating_max, q.pass_rating, q.critical) ORDER BY q.sequence)
                     FROM public.audit_questions q WHERE q.audit_definition_id = d.id), '[]'::jsonb),
    't', coalesce((SELECT jsonb_agg(jsonb_build_array(t.kind, coalesce(t.machine_id::text, upper(t.operation_code), t.department_id::text)) ORDER BY t.kind, coalesce(t.machine_id::text, upper(t.operation_code), t.department_id::text))
                     FROM public.audit_targets t WHERE t.audit_definition_id = d.id), '[]'::jsonb))::text) INTO old_hash FROM public.audit_definitions d WHERE d.id = a2;
  PERFORM pg_temp.assert_eq(app.audit_content_hash(a2), old_hash, 'an audit without a supplier target has the fingerprint it had before this change');
  PERFORM pg_temp.login(ann);
  PERFORM app.save_audit_version(a2, NULL);

  -- ---- a supplier-audit definition ----
  INSERT INTO public.audit_definitions (organisation_id, title, audit_type, frequency_kind, first_due_on, pass_mark) VALUES (org, 'Supplier process audit', 'supplier', 'yearly', current_date, 80) RETURNING id INTO a1;
  PERFORM app.set_audit_checklist(a1, base);
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.set_audit_targets(%L, '[{"kind":"supplier","supplierId":"%s"}]'::jsonb)$f$, a1, sx)), 5), 'P0002', 'another organisation''s supplier is not found');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.set_audit_targets(%L, '[{"kind":"supplier","supplierId":"%s"},{"kind":"supplier","supplierId":"%s"}]'::jsonb)$f$, a1, s1, s1)), 5), 'QM018', 'the same supplier twice is refused');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.set_audit_targets(%L, '[{"kind":"planet"}]'::jsonb)$f$, a1)), 5), 'QM018', 'an unknown kind is refused');
  PERFORM pg_temp.assert_fails(format($f$INSERT INTO public.audit_targets (organisation_id, audit_definition_id, kind, supplier_id) VALUES (%L, %L, 'supplier', %L)$f$, org, a1, s1), 'targets are still written only through the function');
  PERFORM app.set_audit_targets(a1, jsonb_build_array(jsonb_build_object('kind', 'supplier', 'supplierId', s1), jsonb_build_object('kind', 'supplier', 'supplierId', s2)));
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_targets WHERE audit_definition_id = a1 AND kind = 'supplier'), 2::bigint, 'two suppliers are listed');
  PERFORM pg_temp.assert_eq(left(pg_temp.settle(), 5), 'QM018', 'changing the targets is refused until it is saved as a version');
  v := app.save_audit_version(a1, NULL);
  PERFORM pg_temp.assert_eq(pg_temp.settle(), 'ok', 'saved as version 1 it may end');
  PERFORM pg_temp.assert_eq((SELECT string_agg(label, ', ' ORDER BY label) FROM public.audit_version_targets t JOIN public.audit_versions x ON x.id = t.audit_version_id WHERE x.audit_definition_id = a1 AND x.version = 1), 'ACME · Acme Metals, BOLT · Bolt Co', 'the version snapshots the suppliers with their names');
  -- swapping a supplier is a content change that needs a reason
  PERFORM app.set_audit_targets(a1, jsonb_build_array(jsonb_build_object('kind', 'supplier', 'supplierId', s1), jsonb_build_object('kind', 'supplier', 'supplierId', s3)));
  PERFORM pg_temp.assert_eq(app.audit_content_changed(a1), true, 'swapping a supplier is a change');
  PERFORM pg_temp.assert_eq(app.save_audit_version(a1, 'Replaced Bolt with Cast'), 2, 'it becomes version 2 with its reason');
  PERFORM pg_temp.assert_eq(pg_temp.settle(), 'ok', 'and may end');

  -- ---- a record carried out on one of the audit's suppliers ----
  rec := app.start_audit(a1, NULL, jsonb_build_array(jsonb_build_object('kind', 'supplier', 'supplierId', s3)));
  PERFORM pg_temp.assert_eq((SELECT label FROM public.audit_record_targets WHERE audit_record_id = rec AND kind = 'supplier'), 'CAST · Cast Ltd', 'the record keeps the supplier it was carried out on');
  PERFORM pg_temp.assert_eq((SELECT supplier_id FROM public.audit_record_targets WHERE audit_record_id = rec), s3, 'by id');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.set_audit_record_targets(%L, '[{"kind":"supplier","supplierId":"%s"}]'::jsonb)$f$, rec, s2)), 5), 'QM018', 'a supplier that is no longer on the audit cannot be chosen');
  PERFORM app.set_audit_record_targets(rec, jsonb_build_array(jsonb_build_object('kind', 'supplier', 'supplierId', s1), jsonb_build_object('kind', 'supplier', 'supplierId', s3)));
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_record_targets WHERE audit_record_id = rec), 2::bigint, 'one or several suppliers can be chosen');
  PERFORM pg_temp.assert_eq(left(pg_temp.fails(format($f$SELECT app.set_audit_record_targets(%L, '[{"kind":"supplier","supplierId":"%s"},{"kind":"supplier","supplierId":"%s"}]'::jsonb)$f$, rec, s1, s1)), 5), 'QM018', 'the same supplier twice on a record is refused');
  PERFORM pg_temp.assert_fails(format($f$INSERT INTO public.audit_record_targets (organisation_id, audit_record_id, kind, supplier_id, label) VALUES (%L, %L, 'supplier', %L, 'x')$f$, org, rec, s2), 'record targets are written only through the function');
  PERFORM pg_temp.assert_eq((SELECT audit_version FROM public.audit_records WHERE id = rec), 2, 'the record says it was started against version 2');
  PERFORM pg_temp.logout();

  -- ---- the shape rule: a row names exactly one thing ----
  PERFORM pg_temp.assert_fails(format($f$INSERT INTO public.audit_targets (organisation_id, audit_definition_id, kind, supplier_id, machine_id) VALUES (%L, %L, 'supplier', %L, %L)$f$, org, a1, s2, mach), 'a supplier row cannot also name a machine');
  PERFORM pg_temp.assert_fails(format($f$INSERT INTO public.audit_targets (organisation_id, audit_definition_id, kind) VALUES (%L, %L, 'supplier')$f$, org, a1), 'or name nothing');
END $$;

ROLLBACK;
