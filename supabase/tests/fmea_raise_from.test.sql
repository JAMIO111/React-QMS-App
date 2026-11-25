-- FMEA FM5c-2: raising an FMEA (or a revision) from a record — who may read the source, what each kind suggests, that the reason is set once and never changes.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('4f000000-0000-0000-0000-000000000d01', 'ann@fr.test'), ('4f000000-0000-0000-0000-000000000d02', 'bob@fr.test'),
  ('4f000000-0000-0000-0000-000000000d03', 'eve@fr.test'), ('4f000000-0000-0000-0000-000000000d04', 'cat@fr.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '4f000000-0000-0000-0000-000000000d01'; bob uuid := '4f000000-0000-0000-0000-000000000d02';
  eve uuid := '4f000000-0000-0000-0000-000000000d03'; cat uuid := '4f000000-0000-0000-0000-000000000d04';
  org uuid; org2 uuid; part uuid; sup uuid; mach uuid; nc uuid; nc2 uuid; capa uuid; fnd uuid; scar uuid; chg uuid;
  f1 uuid; r1 uuid; f2 uuid; r2 uuid; d jsonb; r text;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('FR Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('FR Beta'); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, bob, 'active'), (org, cat, 'active');
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = CASE ou.user_id WHEN cat THEN 'quality_engineer' ELSE 'viewer' END)
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id IN (bob, cat);

  PERFORM pg_temp.login(ann);
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'BR-100', 'Bracket') RETURNING id INTO part;
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'CAST', 'Castings Ltd') RETURNING id INTO sup;
  INSERT INTO public.machines (organisation_id, code, name) VALUES (org, 'M1', 'Mill 1') RETURNING id INTO mach;
  INSERT INTO public.nonconformances (organisation_id, source, supplier_id, part_id, causal_process_id, title, severity, quantity_affected, description, stage, category_id, requirement, actual_result)
    VALUES (org, 'supplier', sup, part, mach, 'Porosity in castings', 'major', 20, 'Porosity found at machining', 'open', pg_temp.cat(org), 'No porosity over 0.5 mm', '1.2 mm voids') RETURNING id INTO nc;
  capa := app.start_capa(org, 'Repeat porosity', 'Third porosity NC this quarter', NULL, NULL, NULL);
  PERFORM app.link_capa_ncr(capa, nc);
  chg := app.create_change(org, jsonb_build_object('title', 'Switch casting supplier', 'typeId', (SELECT id FROM public.change_types WHERE organisation_id = org AND key = 'material')));
  PERFORM app.set_change_links(chg, jsonb_build_array(jsonb_build_object('kind', 'part', 'id', part), jsonb_build_object('kind', 'supplier', 'id', sup), jsonb_build_object('kind', 'operation_code', 'code', 'OP20')));
  PERFORM pg_temp.logout();
  -- Rows that are expensive to build through their own modules (an audit finding, a SCAR) are written with triggers and foreign keys off.
  SET LOCAL session_replication_role = replica;
  INSERT INTO public.audit_findings (organisation_id, reference, audit_record_id, classification_id, title, description, requirement)
    VALUES (org, 'AF-26-0001', gen_random_uuid(), gen_random_uuid(), 'No control of tooling', 'Tool store has no log', 'Tooling shall be logged') RETURNING id INTO fnd;
  INSERT INTO public.supplier_scars (organisation_id, reference, supplier_id, title, problem_description, severity, status)
    VALUES (org, 'SCAR-26-0001', sup, 'Porosity again', 'Voids in the casting', 'major', 'draft') RETURNING id INTO scar;
  SET LOCAL session_replication_role = origin;
  PERFORM pg_temp.login(eve);
  INSERT INTO public.nonconformances (organisation_id, source, title, severity, quantity_affected, description, stage, category_id)
    VALUES (org2, 'internal', 'Theirs', 'minor', 1, 'x', 'open', pg_temp.cat(org2)) RETURNING id INTO nc2;
  PERFORM pg_temp.logout();

  -- ---- a suggestion from each kind of record ----
  PERFORM pg_temp.login(cat);
  d := app.fmea_draft_from('ncr', nc);
  PERFORM pg_temp.assert_eq(d ->> 'title', 'Porosity in castings', 'an NC names itself in the title');
  PERFORM pg_temp.assert_eq(d ->> 'kind', 'process', 'a failure on the floor suggests a process FMEA');
  PERFORM pg_temp.assert_eq((d ->> 'scopeText') LIKE 'Raised from non-conformance %: Porosity in castings', true, 'the scope says where it came from');
  PERFORM pg_temp.assert_eq((SELECT array_agg(x ->> 'kind' ORDER BY x ->> 'kind') FROM jsonb_array_elements(d -> 'links') x), ARRAY['machine', 'part', 'supplier'], 'it suggests the part, machine and supplier');
  PERFORM pg_temp.assert_eq(d -> 'source' ->> 'kind', 'ncr', 'it names its source');
  d := app.fmea_draft_from('capa', capa);
  PERFORM pg_temp.assert_eq((SELECT array_agg(x ->> 'kind' ORDER BY x ->> 'kind') FROM jsonb_array_elements(d -> 'links') x), ARRAY['machine', 'part', 'supplier'], 'an 8D suggests the scope of its first NC');
  d := app.fmea_draft_from('audit_finding', fnd);
  PERFORM pg_temp.assert_eq(d ->> 'title', 'No control of tooling', 'a finding suggests its title');
  PERFORM pg_temp.assert_eq(jsonb_array_length(d -> 'links'), 0, 'and no scope');
  d := app.fmea_draft_from('supplier_scar', scar);
  PERFORM pg_temp.assert_eq((SELECT array_agg(x ->> 'kind') FROM jsonb_array_elements(d -> 'links') x), ARRAY['supplier'], 'a SCAR suggests its supplier');
  d := app.fmea_draft_from('change', chg);
  PERFORM pg_temp.assert_eq((SELECT array_agg(x ->> 'kind' ORDER BY x ->> 'kind') FROM jsonb_array_elements(d -> 'links') x), ARRAY['part', 'supplier'], 'a change suggests its part and supplier (not the operation code)');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmeas), 0::bigint, 'a suggestion saves nothing');

  -- ---- who may ask ----
  r := pg_temp.fails(format($f$SELECT app.fmea_draft_from('ncr', %L)$f$, nc2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'another organisation''s record is not found');
  r := pg_temp.fails(format($f$SELECT app.fmea_draft_from('ncr', %L)$f$, gen_random_uuid()));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'nor is one that does not exist');
  r := pg_temp.fails($f$SELECT app.fmea_draft_from('risk', gen_random_uuid())$f$);
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'nor is a kind that cannot start an FMEA');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(bob);
  r := pg_temp.fails(format($f$SELECT app.fmea_draft_from('ncr', %L)$f$, nc));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'a viewer cannot raise an FMEA, even from a record they can read');
  PERFORM pg_temp.logout();

  -- ---- recording where it came from ----
  PERFORM pg_temp.login(cat);
  f1 := app.create_fmea(org, jsonb_build_object('kind', 'process', 'title', 'Machining the bracket',
    'team', jsonb_build_array(jsonb_build_object('userId', cat, 'role', 'lead'), jsonb_build_object('userId', ann, 'role', 'quality'))));
  r1 := (SELECT id FROM public.fmea_revisions WHERE fmea_id = f1);
  PERFORM pg_temp.assert_eq((SELECT origin_kind FROM public.fmeas WHERE id = f1), NULL::text, 'an FMEA starts with no origin');
  PERFORM app.set_fmea_origin('fmea', f1, 'ncr', nc);
  PERFORM pg_temp.assert_eq((SELECT origin_kind FROM public.fmeas WHERE id = f1), 'ncr', 'the origin is recorded');
  PERFORM pg_temp.assert_eq((SELECT origin_id FROM public.fmeas WHERE id = f1), nc, 'with the record');
  r := pg_temp.fails(format($f$SELECT app.set_fmea_origin('fmea', %L, 'capa', %L)$f$, f1, capa));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'it cannot be given a second time');
  PERFORM pg_temp.assert_eq((SELECT origin_kind FROM public.fmeas WHERE id = f1), 'ncr', 'and nothing changed');
  PERFORM app.set_fmea_origin('revision', r1, 'capa', capa);
  PERFORM pg_temp.assert_eq((SELECT origin_kind FROM public.fmea_revisions WHERE id = r1), 'capa', 'a draft revision records its own reason');
  r := pg_temp.fails(format($f$SELECT app.set_fmea_origin('revision', %L, 'ncr', %L)$f$, r1, nc2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'another organisation''s record is not found');
  r := pg_temp.fails(format($f$SELECT app.set_fmea_origin('revision', %L, 'ncr', %L)$f$, r1, nc));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'it cannot be replaced');
  f2 := app.create_fmea(org, jsonb_build_object('kind', 'process', 'title', 'Second',
    'team', jsonb_build_array(jsonb_build_object('userId', cat, 'role', 'lead'), jsonb_build_object('userId', ann, 'role', 'quality'))));
  r2 := (SELECT id FROM public.fmea_revisions WHERE fmea_id = f2);
  r := pg_temp.fails(format($f$SELECT app.set_fmea_origin('fmea', %L, 'ncr', %L)$f$, f2, nc2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'another organisation''s record cannot be named');
  r := pg_temp.fails(format($f$SELECT app.set_fmea_origin('fmea', %L, 'risk', %L)$f$, f2, nc));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'only the five kinds can be the reason');
  r := pg_temp.fails(format($f$SELECT app.set_fmea_origin('fmea', %L, 'ncr', %L)$f$, gen_random_uuid(), nc));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'an FMEA that is not there is not found');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(bob);
  r := pg_temp.fails(format($f$SELECT app.set_fmea_origin('fmea', %L, 'ncr', %L)$f$, f2, nc));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'a viewer cannot record an origin');
  PERFORM pg_temp.logout();

  -- ---- held for SQL too ----
  r := pg_temp.fails(format($f$UPDATE public.fmeas SET origin_kind = 'capa', origin_id = %L WHERE id = %L$f$, capa, f1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'SQL cannot change an origin');
  r := pg_temp.fails(format($f$UPDATE public.fmeas SET origin_kind = NULL, origin_id = NULL WHERE id = %L$f$, f1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'nor clear it');
  r := pg_temp.fails(format($f$UPDATE public.fmeas SET origin_kind = 'ncr', origin_id = %L WHERE id = %L$f$, nc, f2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'nor give one outside the function');
  PERFORM pg_temp.assert_eq((SELECT origin_kind FROM public.fmeas WHERE id = f2), NULL::text, 'and nothing was set');
  r := pg_temp.fails(format($f$UPDATE public.fmeas SET origin_kind = 'ncr' WHERE id = %L$f$, f2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'a kind with no record is refused (the trigger answers before the check)');
END $$;

ROLLBACK;
