-- Risk register RK3: links to records, raising a risk from a non-conformance or an 8D (source linked, origin kept), reading rules and tenancy.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('4d000000-0000-0000-0000-000000000c01', 'ann@rk3.test'), ('4d000000-0000-0000-0000-000000000c02', 'bob@rk3.test'), ('4d000000-0000-0000-0000-000000000c03', 'eve@rk3.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '4d000000-0000-0000-0000-000000000c01'; bob uuid := '4d000000-0000-0000-0000-000000000c02'; eve uuid := '4d000000-0000-0000-0000-000000000c03';
  org uuid; org2 uuid; m uuid; part uuid; part2 uuid; sup uuid; mach uuid; nc uuid; nc2 uuid; capa uuid; k uuid; k2 uuid; d jsonb; r text; c uuid;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('RK3 Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('RK3 Beta'); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, bob, 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'viewer';

  PERFORM pg_temp.login(ann);
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'BR-100', 'Bracket') RETURNING id INTO part;
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'CAST', 'Castings Ltd') RETURNING id INTO sup;
  INSERT INTO public.machines (organisation_id, code, name) VALUES (org, 'M1', 'Mill 1') RETURNING id INTO mach;
  INSERT INTO public.nonconformances (organisation_id, source, supplier_id, part_id, causal_process_id, title, severity, quantity_affected, description, stage, category_id)
    VALUES (org, 'supplier', sup, part, mach, 'Porosity in castings', 'major', 20, 'Porosity found at machining', 'open', pg_temp.cat(org)) RETURNING id INTO nc;
  capa := app.start_capa(org, 'Repeat porosity', 'Third porosity NC this quarter', NULL, NULL, NULL);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve);
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org2, 'X-1', 'Theirs') RETURNING id INTO part2;
  INSERT INTO public.nonconformances (organisation_id, source, title, severity, quantity_affected, description, stage, category_id)
    VALUES (org2, 'internal', 'Theirs', 'minor', 1, 'x', 'open', pg_temp.cat(org2)) RETURNING id INTO nc2;
  PERFORM pg_temp.logout();

  -- ---- a draft from an NC ----
  PERFORM pg_temp.login(ann);
  d := app.risk_draft_from('ncr', nc);
  PERFORM pg_temp.assert_eq(d ->> 'title', 'Porosity in castings', 'the title comes from the NC');
  PERFORM pg_temp.assert_eq((SELECT key FROM public.risk_categories WHERE id = (d ->> 'categoryId')::uuid), 'supplier', 'a supplier NC suggests the supplier category');
  PERFORM pg_temp.assert_eq((SELECT array_agg(x ->> 'kind' ORDER BY x ->> 'kind') FROM jsonb_array_elements(d -> 'links') x), ARRAY['machine', 'ncr', 'part', 'supplier'], 'it suggests the NC, its part, supplier and machine');
  PERFORM pg_temp.assert_eq(d -> 'source' ->> 'reference', (SELECT reference FROM public.nonconformances WHERE id = nc), 'it names the source');
  r := pg_temp.fails(format('SELECT app.risk_draft_from(%L, %L)', 'ncr', nc2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'another organisation''s NC is not found');
  r := pg_temp.fails(format('SELECT app.risk_draft_from(%L, %L)', 'supplier', sup));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'only from an NC, an 8D or a finding');

  -- ---- raising it ----
  k := app.raise_risk_from('ncr', nc, jsonb_build_object('title', 'Porosity from the casting supplier', 'categoryId', d ->> 'categoryId'),
                           jsonb_build_array(jsonb_build_object('kind', 'part', 'id', part), jsonb_build_object('kind', 'ncr', 'id', nc)));
  PERFORM pg_temp.assert_eq((SELECT origin_kind || '/' || status FROM public.risks WHERE id = k), 'ncr/draft', 'raised as a draft with its origin');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.risk_links WHERE risk_id = k), 2::bigint, 'the NC is linked once, and the part');

  -- ---- links ----
  PERFORM app.set_risk_links(k, jsonb_build_array(jsonb_build_object('kind', 'ncr', 'id', nc), jsonb_build_object('kind', 'supplier', 'id', sup),
    jsonb_build_object('kind', 'operation_code', 'code', ' OP20 '), jsonb_build_object('kind', 'operation_code', 'code', 'OP20'), jsonb_build_object('kind', 'capa', 'id', capa)));
  PERFORM pg_temp.assert_eq((SELECT array_agg(kind || coalesce(':' || operation_code, '') ORDER BY kind) FROM public.risk_links WHERE risk_id = k),
    ARRAY['capa', 'ncr', 'operation_code:OP20', 'supplier'], 'replaced as a whole, duplicates dropped, codes trimmed');
  r := pg_temp.fails(format($f$SELECT app.set_risk_links(%L, jsonb_build_array(jsonb_build_object('kind', 'part', 'id', %L)))$f$, k, part));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'the record it was raised from cannot be unlinked');
  r := pg_temp.fails(format($f$SELECT app.set_risk_links(%L, jsonb_build_array(jsonb_build_object('kind', 'ncr', 'id', %L), jsonb_build_object('kind', 'part', 'id', %L)))$f$, k, nc, part2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'a record of another organisation cannot be linked');
  r := pg_temp.fails(format($f$SELECT app.set_risk_links(%L, '[{"kind":"lot","id":"%s"}]'::jsonb)$f$, k, part));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'only the listed kinds');
  r := pg_temp.fails(format('UPDATE public.risks SET origin_kind = NULL, origin_id = NULL WHERE id = %L', k));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'people cannot write the origin');
  r := pg_temp.fails(format('INSERT INTO public.risk_links (organisation_id, risk_id, kind, part_id) VALUES (%L, %L, %L, %L)', org, k, 'part', part));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'nor links');

  -- ---- an 8D, with its verified root causes as the cause ----
  INSERT INTO public.capa_root_causes (organisation_id, capa_id, kind, description) VALUES (org, capa, 'occurrence', 'Gas in the mould') RETURNING id INTO c;
  d := app.risk_draft_from('capa', capa);
  PERFORM pg_temp.assert_eq(d ->> 'cause', NULL::text, 'an unverified cause is not suggested');
  UPDATE public.capa_root_causes SET verified = true, verification_method = 'Sectioned three parts' WHERE id = c;
  d := app.risk_draft_from('capa', capa);
  PERFORM pg_temp.assert_eq(d ->> 'cause', 'Gas in the mould', 'a verified cause is');
  k2 := app.raise_risk_from('capa', capa, jsonb_build_object('title', d ->> 'title', 'categoryId', d ->> 'categoryId'));
  PERFORM pg_temp.assert_eq((SELECT kind FROM public.risk_links WHERE risk_id = k2), 'capa', 'the 8D is linked');
  -- a closed risk keeps its links
  PERFORM app.assess_risk(k2, 2, 2, 'Small');
  PERFORM app.close_risk(k2, 'no_longer_applies', 'Mould replaced');
  r := pg_temp.fails(format($f$SELECT app.set_risk_links(%L, jsonb_build_array(jsonb_build_object('kind', 'capa', 'id', %L)))$f$, k2, capa));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'a closed risk''s links do not change');
  PERFORM pg_temp.logout();

  -- ---- who may ----
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.risk_links WHERE risk_id = k), 4::bigint, 'a reader sees the links');
  r := pg_temp.fails(format('SELECT app.raise_risk_from(%L, %L, %L)', 'ncr', nc, '{"title":"x"}'));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a reader cannot raise a risk');
  r := pg_temp.fails(format($f$SELECT app.set_risk_links(%L, '[]')$f$, k));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'nor change links');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.risk_links), 0::bigint, 'another organisation sees no links');
  r := pg_temp.fails(format('SELECT app.raise_risk_from(%L, %L, %L)', 'ncr', nc, '{"title":"x"}'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'nor raises from another organisation''s NC');
  PERFORM pg_temp.logout();
  r := pg_temp.fails(format('UPDATE public.risks SET origin_kind = %L, origin_id = %L WHERE id = %L', 'capa', capa, k));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM026', 'the origin never changes, even for SQL');
END $$;

ROLLBACK;
