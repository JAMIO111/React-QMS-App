-- Slice 2.1 master data: permissions, part revision lifecycle and outbox events, part number
-- uniqueness, cross-organisation references, and the legacy copy.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('20000000-0000-0000-0000-0000000000f1', 'manager@master.test'),
  ('20000000-0000-0000-0000-0000000000f2', 'inspector@master.test'),
  ('20000000-0000-0000-0000-0000000000f3', 'other@master.test');

DO $$
DECLARE
  org uuid; other uuid; membership uuid; inspector_role uuid;
  cust uuid; foreign_cust uuid; part uuid; rev_a uuid; rev_b uuid;
  failed boolean;
BEGIN
  -- Legacy copy (fixture: part P-100 'Bracket', customer 'Acme'): ids kept, revision A released.
  PERFORM pg_temp.assert_eq((SELECT part_number || '|' || name FROM public.parts WHERE id = '00000000-0000-0000-0000-0000000000b1'), 'P-100|Bracket', 'legacy part copied with its id');
  PERFORM pg_temp.assert_eq((SELECT revision || '|' || status FROM public.part_revisions WHERE part_id = '00000000-0000-0000-0000-0000000000b1'), 'A|released', 'legacy part has released revision A');
  PERFORM pg_temp.assert_eq((SELECT code || '|' || name FROM public.customers WHERE id = '00000000-0000-0000-0000-0000000000c1'), 'C0001|Acme', 'legacy customer copied with a code');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.parts), 1::bigint, 'every legacy part copied (the fixture had one)');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.customers), 1::bigint, 'every legacy customer copied (the fixture had one)');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.suppliers WHERE code <> 'FIXSCAR'), 0::bigint, 'every legacy supplier copied (the fixture had none)');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.outbox_events), 0::bigint, 'migration wrote no events');

  -- Units are a global catalogue.
  PERFORM pg_temp.login('20000000-0000-0000-0000-0000000000f3');
  PERFORM pg_temp.assert_eq((SELECT name FROM public.units WHERE code = 'mm'), 'Millimetre', 'any signed-in user reads units');
  PERFORM pg_temp.assert_fails($q$INSERT INTO public.units (code, name, quantity_kind) VALUES ('ft', 'Foot', 'length')$q$, 'units are read-only');
  other := app.create_organisation('Other Works', 'Main site', 'MAIN', NULL);
  INSERT INTO public.customers (organisation_id, code, name) VALUES (other, 'OTH', 'Other customer') RETURNING id INTO foreign_cust;

  -- Owner (master_data.manage) of a fresh organisation creates master data.
  PERFORM pg_temp.login('20000000-0000-0000-0000-0000000000f1');
  org := app.create_organisation('Master Works', 'Main site', 'MAIN', NULL);
  INSERT INTO public.customers (organisation_id, code, name, display_name) VALUES (org, 'ACME', 'Acme Fabrication Ltd', 'Acme') RETURNING id INTO cust;
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'STEEL', 'Steel Supplies Ltd');
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'BRK-100', 'Bracket') RETURNING id INTO part;
  INSERT INTO public.part_customers (organisation_id, part_id, customer_id) VALUES (org, part, cust);
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.parts (organisation_id, part_number, name) VALUES (%L, 'brk-100', 'Duplicate')$q$, org), 'part numbers unique regardless of case');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.part_customers (organisation_id, part_id, customer_id) VALUES (%L, %L, %L)$q$, org, part, foreign_cust), 'cannot reference another organisation''s customer');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.parts SET organisation_id = %L WHERE id = %L$q$, other, part), 'organisation_id cannot change');
  PERFORM pg_temp.assert_fails(format($q$DELETE FROM public.parts WHERE id = %L$q$, part), 'parts are deactivated, not deleted');
  INSERT INTO public.suppliers (organisation_id, code, name, created_by, created_at)
    VALUES (org, 'FORGE', 'Forged stamps', '20000000-0000-0000-0000-0000000000f3', '2000-01-01');
  PERFORM pg_temp.assert_eq((SELECT created_by::text || '|' || (created_at > now() - interval '1 minute')::text FROM public.suppliers WHERE organisation_id = org AND code = 'FORGE'),
    '20000000-0000-0000-0000-0000000000f1|true', 'created stamps cannot be forged');

  -- Revision lifecycle.
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.part_revisions (organisation_id, part_id, revision, status) VALUES (%L, %L, 'Z', 'released')$q$, org, part), 'cannot create a released revision');
  INSERT INTO public.part_revisions (organisation_id, part_id, revision, drawing_ref) VALUES (org, part, 'A', 'DRG-100') RETURNING id INTO rev_a;
  UPDATE public.part_revisions SET drawing_ref = 'DRG-100 iss 2' WHERE id = rev_a;
  PERFORM pg_temp.assert_eq((SELECT drawing_ref FROM public.part_revisions WHERE id = rev_a), 'DRG-100 iss 2', 'drafts can be edited');
  UPDATE public.part_revisions SET status = 'released' WHERE id = rev_a;
  PERFORM pg_temp.assert_eq((SELECT status || '|' || (released_at IS NOT NULL) || '|' || released_by FROM public.part_revisions WHERE id = rev_a),
    'released|true|20000000-0000-0000-0000-0000000000f1', 'release stamps who and when');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.part_revisions SET drawing_ref = 'changed' WHERE id = %L$q$, rev_a), 'released revisions are locked');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.part_revisions SET status = 'draft' WHERE id = %L$q$, rev_a), 'cannot go back to draft');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.part_revisions SET released_at = now() - interval '1 year' WHERE id = %L$q$, rev_a), 'release date is set by the system');

  INSERT INTO public.part_revisions (organisation_id, part_id, revision) VALUES (org, part, 'B') RETURNING id INTO rev_b;
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.part_revisions (organisation_id, part_id, revision) VALUES (%L, %L, 'b')$q$, org, part), 'revision letters unique per part regardless of case');
  UPDATE public.part_revisions SET status = 'released' WHERE id = rev_b;
  PERFORM pg_temp.assert_eq((SELECT status FROM public.part_revisions WHERE id = rev_a), 'superseded', 'releasing B supersedes A');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.part_revisions WHERE part_id = part AND status = 'released'), 1::bigint, 'one released revision per part');
  UPDATE public.part_revisions SET status = 'obsolete' WHERE id = rev_a;
  PERFORM pg_temp.assert_eq((SELECT status FROM public.part_revisions WHERE id = rev_a), 'obsolete', 'superseded can become obsolete');

  -- Outbox: one event per release, readable with audit.read, never written directly.
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.outbox_events WHERE organisation_id = org AND event_type = 'part.revision.released'), 2::bigint, 'release events written');
  PERFORM pg_temp.assert_eq((SELECT payload ->> 'revision' || '|' || (payload ->> 'part_number') || '|' || (payload ->> 'v') || '|' || actor_user_id
                             FROM public.outbox_events WHERE entity_id = rev_b),
    'B|BRK-100|1|20000000-0000-0000-0000-0000000000f1', 'event payload and actor');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.outbox_events (organisation_id, event_type, entity_type, entity_id) VALUES (%L, 'fake.event', 'x', gen_random_uuid())$q$, org), 'outbox cannot be written directly');
  PERFORM pg_temp.assert_fails('UPDATE public.outbox_events SET processed_at = now()', 'outbox cannot be marked processed by users');
  PERFORM pg_temp.assert_fails($q$SELECT app.emit_event(gen_random_uuid(), 'fake.event', 'x', gen_random_uuid(), '{}')$q$, 'emit_event is not callable by users');

  -- An inspector (master_data.read only) can read but not change master data, nor read the outbox.
  PERFORM pg_temp.logout();
  SELECT id INTO inspector_role FROM public.roles WHERE organisation_id = org AND key = 'inspector';
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '20000000-0000-0000-0000-0000000000f2', 'active') RETURNING id INTO membership;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) VALUES (org, membership, inspector_role);
  PERFORM pg_temp.login('20000000-0000-0000-0000-0000000000f2');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.parts WHERE organisation_id = org), 1::bigint, 'inspector reads parts');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.part_revisions WHERE organisation_id = org), 2::bigint, 'inspector reads revisions');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.parts (organisation_id, part_number, name) VALUES (%L, 'INS-1', 'Nope')$q$, org), 'inspector cannot create parts');
  UPDATE public.customers SET name = 'Hijacked' WHERE id = cust;
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.outbox_events WHERE organisation_id = org), 0::bigint, 'inspector cannot read the outbox');

  -- The other organisation sees none of it.
  PERFORM pg_temp.login('20000000-0000-0000-0000-0000000000f3');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.parts WHERE organisation_id = org), 0::bigint, 'other organisation sees no parts');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.outbox_events WHERE organisation_id = org), 0::bigint, 'other organisation sees no events');

  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT name FROM public.customers WHERE id = cust), 'Acme Fabrication Ltd', 'inspector update had no effect');
  PERFORM pg_temp.assert_eq((SELECT count(*) > 0 FROM audit.events WHERE organisation_id = org AND entity_type = 'part_revisions' AND changed_fields @> ARRAY['status']), true, 'revision status changes audited');
END $$;

ROLLBACK;
