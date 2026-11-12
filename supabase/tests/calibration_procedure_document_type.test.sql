-- The built-in "Calibration procedure" document type: seeded for existing organisations (adopting a type of that name, stepping past a taken
-- prefix) and for new ones, never switched off or deleted, its key fixed; and a gauge type's procedure must be a document of that type.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('3e100000-0000-0000-0000-000000000c01', 'ann@cp.test'), ('3e100000-0000-0000-0000-000000000c02', 'bob@cp.test'),
  ('3e100000-0000-0000-0000-000000000c03', 'eve@cp.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '3e100000-0000-0000-0000-000000000c01'; bob uuid := '3e100000-0000-0000-0000-000000000c02'; eve uuid := '3e100000-0000-0000-0000-000000000c03';
  org uuid; org2 uuid; calp uuid; sop uuid; d_proc uuid; d_sop uuid; d_other uuid; g1 uuid; g2 uuid; r text;
  o1 uuid := (SELECT organisation_id FROM public.document_types WHERE prefix = 'CPX');
  o2 uuid := (SELECT id FROM public.organisations WHERE slug = 'fixture-prefix-taken');
BEGIN
  -- ---- the migration: every organisation has exactly one, adopted or made (fixture) ----
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.organisations o
    WHERE (SELECT count(*) FROM public.document_types t WHERE t.organisation_id = o.id AND t.system_key = 'calibration_procedure') <> 1)::text, '0',
    'every organisation has exactly one calibration procedure type');
  PERFORM pg_temp.assert_eq((SELECT prefix || '|' || btrim(lower(name)) FROM public.document_types WHERE organisation_id = o1 AND system_key = 'calibration_procedure'),
    'CPX|calibration procedure', 'an active type already called Calibration procedure is adopted, with its own prefix');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.document_types WHERE organisation_id = o1 AND lower(btrim(name)) = 'calibration procedure')::text, '1',
    'adopting does not make a second type');
  PERFORM pg_temp.assert_eq((SELECT prefix || '|' || name FROM public.document_types WHERE organisation_id = o2 AND system_key = 'calibration_procedure'),
    'CALP-2|Calibration procedure', 'a taken prefix is stepped past');
  PERFORM pg_temp.assert_eq((SELECT system_key IS NULL FROM public.document_types WHERE organisation_id = o2 AND prefix = 'CALP')::text, 'true',
    'the type that held the prefix is left alone');

  -- ---- a new organisation gets it with the others, and seeding again changes nothing ----
  PERFORM pg_temp.login(ann); org := app.create_organisation('CP Alpha', 'Plant A', 'PA', NULL); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('CP Beta'); PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT string_agg(prefix, ',' ORDER BY sequence) FROM public.document_types WHERE organisation_id = org), 'SOP,WI,FRM,SPEC,POL,EXT,CALP',
    'a new organisation has the six general types and the calibration procedure type');
  SELECT id INTO calp FROM public.document_types WHERE organisation_id = org AND system_key = 'calibration_procedure';
  SELECT id INTO sop FROM public.document_types WHERE organisation_id = org AND prefix = 'SOP';
  PERFORM pg_temp.assert_eq((SELECT name || '|' || content_hint || '|' || active::text FROM public.document_types WHERE id = calp), 'Calibration procedure|text|true', 'named, written text, in use');
  PERFORM app.seed_document_types(org);
  PERFORM app.seed_calibration_procedure_type(org);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.document_types WHERE organisation_id = org)::text, '7', 'seeding again adds nothing');

  -- ---- it cannot be switched off or deleted, and its key is fixed; the rest is the organisation's ----
  PERFORM pg_temp.login(ann);
  r := pg_temp.fails(format($f$SELECT app.save_document_type(%L, '{"active": false}'::jsonb, %L)$f$, org, calp));
  PERFORM pg_temp.assert_eq(r, 'QM025: Calibration procedure is a built-in document type and cannot be switched off', 'a manager cannot switch it off');
  PERFORM app.save_document_type(org, '{"name": "Gauge calibration procedure", "prefix": "GCP", "reviewMonths": 12, "description": "Ours"}'::jsonb, calp);
  PERFORM pg_temp.assert_eq((SELECT name || '|' || prefix || '|' || review_months || '|' || system_key FROM public.document_types WHERE id = calp),
    'Gauge calibration procedure|GCP|12|calibration_procedure', 'it can be renamed, re-prefixed and its interval changed; it stays built in');
  PERFORM app.save_document_type(org, '{"active": false}'::jsonb, sop);
  PERFORM pg_temp.assert_eq((SELECT active::text FROM public.document_types WHERE id = sop), 'false', 'an ordinary type can still be switched off');
  PERFORM app.save_document_type(org, '{"active": true}'::jsonb, sop);
  r := pg_temp.fails(format($f$SELECT app.save_document_type(%L, '{"name": "Mine", "prefix": "MINE", "systemKey": "calibration_procedure"}'::jsonb)$f$, org));
  PERFORM pg_temp.assert_eq(r, 'QM025: Unknown field systemKey', 'the key is not something a manager can send');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.document_types SET active = false WHERE id = %L$q$, calp), 'no table write for a member');
  PERFORM pg_temp.logout();
  -- Held for SQL run by the operator too.
  r := pg_temp.fails(format($f$UPDATE public.document_types SET active = false WHERE id = %L$f$, calp));
  PERFORM pg_temp.assert_eq(r, 'QM025: Gauge calibration procedure is a built-in document type and cannot be switched off', 'not even by SQL');
  r := pg_temp.fails(format($f$DELETE FROM public.document_types WHERE id = %L$f$, calp));
  PERFORM pg_temp.assert_eq(r, 'QM025: A document type is never deleted. Switch it off instead.', 'never deleted');
  r := pg_temp.fails(format($f$UPDATE public.document_types SET system_key = NULL WHERE id = %L$f$, calp));
  PERFORM pg_temp.assert_eq(r, 'QM025: Whether a document type is built in cannot be changed', 'the key cannot be taken off');
  r := pg_temp.fails(format($f$UPDATE public.document_types SET system_key = 'calibration_procedure' WHERE id = %L$f$, sop));
  PERFORM pg_temp.assert_eq(r, 'QM025: Whether a document type is built in cannot be changed', 'nor put on another type');
  r := pg_temp.fails(format($f$INSERT INTO public.document_types (organisation_id, name, prefix, system_key) VALUES (%L, 'Second', 'SEC', 'calibration_procedure')$f$, org2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'a built-in type is not made by hand');
  r := pg_temp.fails(format($f$UPDATE public.document_types SET system_key = 'something_else' WHERE id = %L$f$, sop));
  PERFORM pg_temp.assert_eq(left(r, 5) IN ('QM025', '23514')::text, 'true', 'only known keys');

  -- ---- a gauge type's procedure is a document of that type ----
  PERFORM pg_temp.login(ann);
  d_proc := app.create_document(org, jsonb_build_object('typeId', calp, 'title', 'Caliper calibration', 'contentKind', 'text'));
  d_sop := app.create_document(org, jsonb_build_object('typeId', sop, 'title', 'Goods in', 'contentKind', 'text'));
  PERFORM pg_temp.assert_eq((SELECT number FROM public.documents WHERE id = d_proc), 'GCP-001', 'procedures are numbered from the type''s prefix');
  INSERT INTO public.gauge_types (organisation_id, code, name, procedure_document_id) VALUES (org, 'CAL-150', 'Caliper', d_proc) RETURNING id INTO g1;
  PERFORM pg_temp.assert_eq((SELECT procedure_document_id FROM public.gauge_types WHERE id = g1)::text, d_proc::text, 'a calibration procedure can be chosen when the type is made');
  r := pg_temp.fails(format($f$INSERT INTO public.gauge_types (organisation_id, code, name, procedure_document_id) VALUES (%L, 'MIC-25', 'Micrometer', %L)$f$, org, d_sop));
  PERFORM pg_temp.assert_eq(r, 'QM006: The procedure must be a document of the type Gauge calibration procedure', 'another kind of document is refused when the type is made');
  INSERT INTO public.gauge_types (organisation_id, code, name) VALUES (org, 'MIC-25', 'Micrometer') RETURNING id INTO g2;
  r := pg_temp.fails(format($f$UPDATE public.gauge_types SET procedure_document_id = %L WHERE id = %L$f$, d_sop, g2));
  PERFORM pg_temp.assert_eq(r, 'QM006: The procedure must be a document of the type Gauge calibration procedure', 'and when it is changed');
  UPDATE public.gauge_types SET procedure_document_id = d_proc WHERE id = g2;
  UPDATE public.gauge_types SET procedure_document_id = NULL WHERE id = g2;
  PERFORM pg_temp.assert_eq((SELECT procedure_document_id IS NULL FROM public.gauge_types WHERE id = g2)::text, 'true', 'the procedure can be set and cleared');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.gauge_types SET procedure_document_id = %L WHERE id = %L$q$, gen_random_uuid(), g2), 'a document that does not exist is refused');
  PERFORM pg_temp.logout();

  -- Another organisation's procedure is refused (foreign key), whatever its type.
  PERFORM pg_temp.login(eve);
  d_other := app.create_document(org2, jsonb_build_object('typeId', (SELECT id FROM public.document_types WHERE organisation_id = org2 AND system_key = 'calibration_procedure'),
    'title', 'Their procedure', 'contentKind', 'text'));
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.gauge_types SET procedure_document_id = %L WHERE id = %L$q$, d_other, g2), 'another organisation''s document is refused');
  PERFORM pg_temp.logout();

  -- A link from before the rule is left alone until the procedure itself is changed.
  SET LOCAL session_replication_role = replica;
  UPDATE public.gauge_types SET procedure_document_id = d_sop WHERE id = g2;
  SET LOCAL session_replication_role = origin;
  PERFORM pg_temp.login(ann);
  UPDATE public.gauge_types SET name = 'Micrometer 0-25' WHERE id = g2;
  PERFORM pg_temp.assert_eq((SELECT name || '|' || (procedure_document_id = d_sop)::text FROM public.gauge_types WHERE id = g2), 'Micrometer 0-25|true',
    'an older link stays while other details change');
  PERFORM pg_temp.logout();

  -- A member who cannot read documents (no documentation.read) is still held to the rule: the check does not depend on what they may see.
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, bob, 'active');
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = 'inspector') FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id = bob;
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq(pg_temp.affected(format($q$UPDATE public.gauge_types SET procedure_document_id = %L WHERE id = %L$q$, d_proc, g2))::text, '0',
    'someone who does not manage calibration changes nothing');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
