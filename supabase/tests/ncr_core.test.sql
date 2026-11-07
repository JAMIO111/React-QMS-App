-- Slice 2.4 NCR core: legacy copy, references, minimum content, consistency, stage machine,
-- locking, soft delete, site scoping and isolation.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('20000000-0000-0000-0000-000000000101', 'owner@ncr.test'),
  ('20000000-0000-0000-0000-000000000102', 'engineer@ncr.test'),
  ('20000000-0000-0000-0000-000000000103', 'site.inspector@ncr.test'),
  ('20000000-0000-0000-0000-000000000104', 'other@ncr.test');

CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);
GRANT SELECT ON ids TO authenticated;

DO $$
DECLARE
  legacy uuid;
BEGIN
  -- Legacy copy: fixture NCR NCM-25-001 (Internal, status Open, part P-100, customer Acme).
  SELECT id INTO legacy FROM public."NCM" WHERE ncm_id = 'NCM-25-001';
  PERFORM pg_temp.assert_eq((SELECT reference || '|' || source || '|' || stage FROM public.nonconformances WHERE id = legacy), 'NCM-25-001|internal|open', 'legacy NCR copied with id, reference, source and stage');
  PERFORM pg_temp.assert_eq((SELECT p.part_number || '|' || r.revision FROM public.nonconformances n JOIN public.parts p ON p.id = n.part_id JOIN public.part_revisions r ON r.id = n.part_revision_id WHERE n.id = legacy), 'P-100|A', 'linked to the copied part and its revision');
  PERFORM pg_temp.assert_eq((SELECT c.name FROM public.nonconformances n JOIN public.customers c ON c.id = n.customer_id WHERE n.id = legacy), 'Acme', 'linked to the copied customer');
  PERFORM pg_temp.assert_eq((SELECT fm.name || '|' || sfm.name || '|' || cp.name FROM public.nonconformances n
     JOIN public.ncr_classifications fm ON fm.id = n.failure_mode_id JOIN public.ncr_classifications sfm ON sfm.id = n.sub_failure_mode_id
     JOIN public.ncr_classifications cp ON cp.id = n.causal_process_id WHERE n.id = legacy), 'Dimensional|Oversize|Machining', 'classifications mapped');
  PERFORM pg_temp.assert_eq((SELECT quantity_affected FROM public.nonconformances WHERE id = legacy), 3::numeric, 'quantity copied');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.nonconformances), (SELECT count(*) FROM public."NCM"), 'every legacy NCR copied');
  PERFORM pg_temp.assert_eq((SELECT last_value FROM app.ncr_counters WHERE year = 2025), 1, 'numbering continues after the highest legacy reference');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.outbox_events WHERE entity_type = 'nonconformance'), 0::bigint, 'migration wrote no events');
END $$;

DO $$
DECLARE
  org uuid; other uuid; site_a uuid; site_b uuid; fm uuid; sfm uuid; other_fm uuid; proc uuid;
  part uuid; rev uuid; other_part uuid; cust uuid; ncr uuid; cncr uuid; site_ncr uuid; m uuid; failed boolean;
BEGIN
  PERFORM pg_temp.login('20000000-0000-0000-0000-000000000101');
  org := app.create_organisation('NCR Works', 'Plant A', 'PA', NULL);
  SELECT id INTO site_a FROM public.sites WHERE organisation_id = org;
  INSERT INTO public.sites (organisation_id, code, name) VALUES (org, 'PB', 'Plant B') RETURNING id INTO site_b;
  INSERT INTO public.ncr_classifications (organisation_id, kind, name) VALUES (org, 'failure_mode', 'Dimensional') RETURNING id INTO fm;
  INSERT INTO public.ncr_classifications (organisation_id, kind, parent_id, name) VALUES (org, 'sub_failure_mode', fm, 'Oversize') RETURNING id INTO sfm;
  INSERT INTO public.ncr_classifications (organisation_id, kind, name) VALUES (org, 'failure_mode', 'Cosmetic') RETURNING id INTO other_fm;
  INSERT INTO public.ncr_classifications (organisation_id, kind, name) VALUES (org, 'process', 'Machining') RETURNING id INTO proc;
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.ncr_classifications (organisation_id, kind, name) VALUES (%L, 'sub_failure_mode', 'Orphan')$q$, org), 'sub-failure mode needs a failure mode');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.ncr_classifications (organisation_id, kind, parent_id, name) VALUES (%L, 'sub_failure_mode', %L, 'Under a process')$q$, org, proc), 'parent must be a failure mode');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.ncr_classifications (organisation_id, kind, name) VALUES (%L, 'failure_mode', 'dimensional')$q$, org), 'classification names unique regardless of case');
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'BRK-1', 'Bracket') RETURNING id INTO part;
  INSERT INTO public.part_revisions (organisation_id, part_id, revision) VALUES (org, part, 'A') RETURNING id INTO rev;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'AX-1', 'Axle') RETURNING id INTO other_part;
  INSERT INTO public.customers (organisation_id, code, name) VALUES (org, 'ACME', 'Acme') RETURNING id INTO cust;

  -- Create: the reference is generated (even if one is supplied); drafts need little.
  INSERT INTO public.nonconformances (organisation_id, reference, source, title, site_id, legacy_ncm_id)
    VALUES (org, 'FORGED-1', 'internal', 'Bore oversize', site_a, gen_random_uuid()) RETURNING id INTO ncr;
  PERFORM pg_temp.assert_eq((SELECT reference ~ ('^NCM-' || to_char(current_date, 'YY') || '-001$') FROM public.nonconformances WHERE id = ncr), true, 'reference generated per organisation and year');
  PERFORM pg_temp.assert_eq((SELECT stage || '|' || (legacy_ncm_id IS NULL) || '|' || created_by FROM public.nonconformances WHERE id = ncr), 'draft|true|20000000-0000-0000-0000-000000000101', 'draft, no forged legacy link, stamped creator');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.outbox_events WHERE entity_id = ncr AND event_type = 'ncr.created'), 1::bigint, 'creation event');

  -- Consistency.
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.nonconformances SET part_id = %L, part_revision_id = %L WHERE id = %L$q$, other_part, rev, ncr), 'revision must belong to the part');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.nonconformances SET failure_mode_id = %L, sub_failure_mode_id = %L WHERE id = %L$q$, other_fm, sfm, ncr), 'sub-failure mode must sit under the failure mode');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.nonconformances SET failure_mode_id = %L WHERE id = %L$q$, proc, ncr), 'a process is not a failure mode');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.nonconformances SET reference = 'X-1' WHERE id = %L$q$, ncr), 'reference cannot change');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.nonconformances SET source = 'supplier' WHERE id = %L$q$, ncr), 'source cannot change');

  -- Opening needs the minimum content.
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.nonconformances SET stage = 'open' WHERE id = %L$q$, ncr), 'cannot open without severity and quantity');
  UPDATE public.nonconformances SET part_id = part, part_revision_id = rev, failure_mode_id = fm, sub_failure_mode_id = sfm,
         causal_process_id = proc, severity = 'major', quantity_affected = 4 WHERE id = ncr;
  UPDATE public.nonconformances SET stage = 'open' WHERE id = ncr;
  INSERT INTO public.nonconformances (organisation_id, source, title, severity, quantity_affected, description, stage)
    VALUES (org, 'customer', 'Complaint', 'minor', 1, 'Scratched', 'draft') RETURNING id INTO cncr;
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.nonconformances SET stage = 'open' WHERE id = %L$q$, cncr), 'customer NCRs need the customer to open');
  UPDATE public.nonconformances SET customer_id = cust, customer_reference = 'CLM-9' WHERE id = cncr;
  UPDATE public.nonconformances SET stage = 'open' WHERE id = cncr;
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.nonconformances (organisation_id, source, title, stage) VALUES (%L, 'supplier', 'No supplier', 'open')$q$, org), 'cannot create open without the minimum');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.nonconformances (organisation_id, source, title, stage) VALUES (%L, 'internal', 'Straight to closed', 'closed')$q$, org), 'cannot create closed');

  -- Stage machine.
  PERFORM pg_temp.settle_ncr(ncr);
  UPDATE public.nonconformances SET stage = 'investigating' WHERE id = ncr;
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.nonconformances SET stage = 'open' WHERE id = %L$q$, ncr), 'cannot move backwards');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.nonconformances SET stage = 'draft' WHERE id = %L$q$, ncr), 'cannot return to draft');
  UPDATE public.nonconformances SET stage = 'closed' WHERE id = ncr;
  PERFORM pg_temp.assert_eq((SELECT closed_by::text || '|' || (closed_at IS NOT NULL) FROM public.nonconformances WHERE id = ncr), '20000000-0000-0000-0000-000000000101|true', 'closing stamps who and when');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.nonconformances SET title = 'Edited after closing' WHERE id = %L$q$, ncr), 'closed NCRs are locked');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.nonconformances SET stage = 'open' WHERE id = %L$q$, ncr), 'reopening needs a reason');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.nonconformances SET stage = 'cancelled', stage_reason = 'x' WHERE id = %L$q$, ncr), 'closed NCRs cannot be cancelled');
  UPDATE public.nonconformances SET stage = 'open', stage_reason = 'Customer found more' WHERE id = ncr;
  PERFORM pg_temp.assert_eq((SELECT stage || '|' || (closed_at IS NULL) FROM public.nonconformances WHERE id = ncr), 'open|true', 'reopened and close stamp cleared');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.nonconformances SET stage = 'cancelled' WHERE id = %L$q$, cncr), 'cancelling needs a reason');
  UPDATE public.nonconformances SET stage = 'cancelled', stage_reason = 'Duplicate of an earlier complaint' WHERE id = cncr;
  PERFORM pg_temp.assert_eq((SELECT array_agg(event_type ORDER BY id)::text FROM public.outbox_events WHERE entity_id = ncr AND event_type <> 'ncr.disposition.approved'),
    '{ncr.created,ncr.stage_changed,ncr.stage_changed,ncr.stage_changed,ncr.closed,ncr.stage_changed}', 'stage events written');
  PERFORM pg_temp.assert_fails(format($q$DELETE FROM public.nonconformances WHERE id = %L$q$, ncr), 'NCRs are never hard-deleted');

  -- Members: an engineer (ncr.update, no ncr.delete) and an inspector scoped to Plant B.
  PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '20000000-0000-0000-0000-000000000102', 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'quality_engineer';
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '20000000-0000-0000-0000-000000000103', 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id, site_id)
    SELECT org, m, id, site_b FROM public.roles WHERE organisation_id = org AND key = 'inspector';
  INSERT INTO public.nonconformances (organisation_id, reference, source, title, site_id) VALUES (org, 'B-1', 'internal', 'At plant B', site_b) RETURNING id INTO site_ncr;
  INSERT INTO ids VALUES ('ncr', ncr), ('site_ncr', site_ncr), ('org', org), ('site_a', site_a);

  -- Soft delete needs ncr.delete and a reason.
  PERFORM pg_temp.login('20000000-0000-0000-0000-000000000102');
  UPDATE public.nonconformances SET title = 'Bore oversize on op 20' WHERE id = ncr;
  PERFORM pg_temp.assert_eq((SELECT title FROM public.nonconformances WHERE id = ncr), 'Bore oversize on op 20', 'engineer edits');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.nonconformances SET deleted_at = now(), delete_reason = 'mistake' WHERE id = %L$q$, ncr), 'engineer cannot delete');
  PERFORM pg_temp.login('20000000-0000-0000-0000-000000000101');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.nonconformances SET deleted_at = now() WHERE id = %L$q$, ncr), 'deleting needs a reason');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.nonconformances SET deleted_at = now(), delete_reason = 'x', title = 'sneaky' WHERE id = %L$q$, ncr), 'delete on its own');
  UPDATE public.nonconformances SET deleted_at = '2000-01-01', delete_reason = 'Raised in error' WHERE id = ncr;
  PERFORM pg_temp.assert_eq((SELECT (deleted_at > now() - interval '1 minute') || '|' || deleted_by FROM public.nonconformances WHERE id = ncr), 'true|20000000-0000-0000-0000-000000000101', 'deletion stamped by the system');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.nonconformances SET title = 'Edit while deleted' WHERE id = %L$q$, ncr), 'deleted NCRs are locked');
  UPDATE public.nonconformances SET deleted_at = NULL WHERE id = ncr;
  PERFORM pg_temp.assert_eq((SELECT (deleted_at IS NULL) || '|' || coalesce(delete_reason, '-') FROM public.nonconformances WHERE id = ncr), 'true|-', 'restored');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.outbox_events WHERE entity_id = ncr AND event_type IN ('ncr.deleted', 'ncr.restored')), 2::bigint, 'delete and restore events');
END $$;

-- Site scoping: the Plant B inspector sees only Plant B's NCRs and cannot change them.
DO $$
BEGIN
  PERFORM pg_temp.login('20000000-0000-0000-0000-000000000103');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.nonconformances WHERE organisation_id = (SELECT v FROM ids WHERE k = 'org')), 1::bigint, 'site-scoped user sees only their site');
  PERFORM pg_temp.assert_eq((SELECT id FROM public.nonconformances), (SELECT v FROM ids WHERE k = 'site_ncr'), 'and it is the Plant B NCR');
  UPDATE public.nonconformances SET title = 'Inspector edit' WHERE id = (SELECT v FROM ids WHERE k = 'site_ncr');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.nonconformances (organisation_id, source, title, site_id) VALUES (%L, 'internal', 'At plant A', %L)$q$,
    (SELECT v FROM ids WHERE k = 'org'), (SELECT v FROM ids WHERE k = 'site_a')), 'cannot raise at another site');

  -- API helpers: permission at any scope, and history for readers of the record.
  PERFORM pg_temp.assert_eq(app.has_permission_somewhere((SELECT v FROM ids WHERE k = 'org'), 'ncr.read'), true, 'site-scoped user holds ncr.read somewhere');
  PERFORM pg_temp.assert_eq(app.has_permission((SELECT v FROM ids WHERE k = 'org'), 'ncr.read'), false, 'but not organisation-wide');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.ncr_history((SELECT v FROM ids WHERE k = 'ncr'))), 0::bigint, 'no history for an NCR of another site');
  PERFORM pg_temp.login('20000000-0000-0000-0000-000000000102');
  PERFORM pg_temp.assert_eq((SELECT count(*) > 3 FROM app.ncr_history((SELECT v FROM ids WHERE k = 'ncr'))), true, 'engineer (no audit.read) sees the NCR history');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_events WHERE entity_id = (SELECT v FROM ids WHERE k = 'ncr')::text), 0::bigint, 'but not the full audit trail');

  -- Another organisation sees nothing.
  PERFORM pg_temp.login('20000000-0000-0000-0000-000000000104');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.ncr_history((SELECT v FROM ids WHERE k = 'ncr'))), 0::bigint, 'other organisation gets no history');
  PERFORM pg_temp.assert_eq(app.has_permission_somewhere((SELECT v FROM ids WHERE k = 'org'), 'ncr.read'), false, 'outsider holds nothing');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.nonconformances WHERE organisation_id = (SELECT v FROM ids WHERE k = 'org')), 0::bigint, 'other organisation sees nothing');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT title FROM public.nonconformances WHERE id = (SELECT v FROM ids WHERE k = 'site_ncr')), 'At plant B', 'inspector update had no effect');
  PERFORM pg_temp.assert_eq((SELECT count(*) > 0 FROM audit.events WHERE entity_type = 'nonconformances' AND changed_fields @> ARRAY['stage']), true, 'stage changes audited');
END $$;

ROLLBACK;
