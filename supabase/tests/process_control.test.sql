-- Process control PC1: machines, part families, part-specific characteristic values (locked once
-- the part revision is released, copied into a new draft), control plans with applicability and
-- the revision lifecycle (only drafts editable, submit/approve/effective/supersede/obsolete,
-- permissions per transition, one draft and one effective revision per plan), events, history.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('32000000-0000-0000-0000-000000000101', 'owner@pc.test'),
  ('32000000-0000-0000-0000-000000000102', 'engineer@pc.test'),
  ('32000000-0000-0000-0000-000000000103', 'inspector@pc.test');

CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);
GRANT SELECT ON ids TO authenticated;

DO $$
DECLARE
  org uuid; site uuid; fam uuid; fam2 uuid; p100 uuid; p200 uuid; other uuid; rev_a uuid; rev_b uuid;
  plan uuid; cr_a uuid; cr_b uuid; cr_c uuid; m uuid;
BEGIN
  PERFORM pg_temp.login('32000000-0000-0000-0000-000000000101');
  org := app.create_organisation('PC Works', 'Plant A', 'PA', NULL);
  SELECT id INTO site FROM public.sites WHERE organisation_id = org;
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'process_control.approve'), true, 'owner may approve plans');

  -- Machines and families.
  INSERT INTO public.machines (organisation_id, code, name, site_id, work_centre) VALUES (org, 'LATHE-01', 'CNC lathe 1', site, 'Turning');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.machines (organisation_id, code, name) VALUES (%L, 'lathe-01', 'Dup')$q$, org), 'machine codes unique ignoring case');
  INSERT INTO public.part_families (organisation_id, code, name) VALUES (org, 'HCR', 'Hydraulic cylinder rods') RETURNING id INTO fam;
  INSERT INTO public.part_families (organisation_id, code, name) VALUES (org, 'PIN', 'Pins') RETURNING id INTO fam2;
  INSERT INTO public.parts (organisation_id, part_number, name, part_family_id) VALUES (org, 'HCR-100', 'Rod 100', fam) RETURNING id INTO p100;
  INSERT INTO public.parts (organisation_id, part_number, name, part_family_id) VALUES (org, 'HCR-200', 'Rod 200', fam) RETURNING id INTO p200;
  INSERT INTO public.parts (organisation_id, part_number, name, part_family_id) VALUES (org, 'PIN-1', 'Pin', fam2) RETURNING id INTO other;

  -- Part-specific values live on the part revision and lock on release.
  INSERT INTO public.part_revisions (organisation_id, part_id, revision) VALUES (org, p100, 'A') RETURNING id INTO rev_a;
  INSERT INTO public.part_revision_characteristics (organisation_id, part_revision_id, characteristic_key, nominal, lower_limit, upper_limit, unit_code)
    VALUES (org, rev_a, 'LENGTH', 100, 99.9, 100.1, 'mm'), (org, rev_a, 'GROOVE_POS', 20, 19.95, 20.05, 'mm');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.part_revision_characteristics (organisation_id, part_revision_id, characteristic_key, nominal, unit_code) VALUES (%L, %L, 'length', 1, 'mm')$q$, org, rev_a), 'keys are upper-case identifiers');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.part_revision_characteristics (organisation_id, part_revision_id, characteristic_key, nominal, lower_limit, upper_limit, unit_code) VALUES (%L, %L, 'BAD', 5, 6, 7, 'mm')$q$, org, rev_a), 'nominal within limits');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.part_revision_characteristics (organisation_id, part_revision_id, characteristic_key, unit_code) VALUES (%L, %L, 'EMPTY', 'mm')$q$, org, rev_a), 'a value needs a nominal or a limit');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.part_revision_characteristics (organisation_id, part_revision_id, characteristic_key, nominal, unit_code) VALUES (%L, %L, 'LENGTH', 1, 'mm')$q$, org, rev_a), 'one value per key');
  INSERT INTO public.part_revision_characteristics (organisation_id, part_revision_id, characteristic_key, upper_limit, unit_code)
    VALUES (org, rev_a, 'RA', 1.6, 'µm');  -- one-sided (maximum only)
  DELETE FROM public.part_revision_characteristics WHERE part_revision_id = rev_a AND characteristic_key = 'RA';
  UPDATE public.part_revisions SET status = 'released' WHERE id = rev_a;
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.part_revision_characteristics SET nominal = 101 WHERE part_revision_id = %L$q$, rev_a), 'released values are locked');
  PERFORM pg_temp.assert_fails(format($q$DELETE FROM public.part_revision_characteristics WHERE part_revision_id = %L$q$, rev_a), 'released values cannot be deleted');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.part_revision_characteristics (organisation_id, part_revision_id, characteristic_key, nominal, unit_code) VALUES (%L, %L, 'NEW', 1, 'mm')$q$, org, rev_a), 'no new values on a released revision');
  INSERT INTO public.part_revisions (organisation_id, part_id, revision) VALUES (org, p100, 'B') RETURNING id INTO rev_b;
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.part_revision_characteristics WHERE part_revision_id = rev_b), 2::bigint, 'new draft copies the released values');
  UPDATE public.part_revision_characteristics SET nominal = 100.5, upper_limit = 100.6 WHERE part_revision_id = rev_b AND characteristic_key = 'LENGTH';
  PERFORM pg_temp.assert_eq((SELECT nominal FROM public.part_revision_characteristics WHERE part_revision_id = rev_a AND characteristic_key = 'LENGTH'), 100::numeric, 'the released revision keeps its value');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.part_revision_characteristics SET characteristic_key = 'LEN' WHERE part_revision_id = %L AND characteristic_key = 'LENGTH'$q$, rev_b), 'keys cannot be renamed');

  -- Control plan and applicability.
  INSERT INTO public.control_plans (organisation_id, plan_code, title) VALUES (org, 'CP-HCR-001', 'Rods – turning and finishing') RETURNING id INTO plan;
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.control_plans (organisation_id, plan_code, title) VALUES (%L, 'cp-hcr-001', 'Dup')$q$, org), 'plan codes unique ignoring case');
  INSERT INTO public.control_plan_applicability (organisation_id, control_plan_id, part_family_id, operation_code) VALUES (org, plan, fam, ' op-020 ');
  PERFORM pg_temp.assert_eq((SELECT operation_code FROM public.control_plan_applicability WHERE control_plan_id = plan), 'OP-020', 'operation codes are normalised');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.control_plan_applicability (organisation_id, control_plan_id, part_family_id, operation_code) VALUES (%L, %L, %L, 'OP-020')$q$, org, plan, fam), 'no duplicate scope');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.control_plan_applicability (organisation_id, control_plan_id, part_family_id, part_id) VALUES (%L, %L, %L, %L)$q$, org, plan, fam, other), 'a named part must be in the family');
  INSERT INTO public.control_plan_applicability (organisation_id, control_plan_id, part_family_id, part_id) VALUES (org, plan, fam, p200);
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.parts SET part_family_id = %L WHERE id = %L$q$, fam2, p200), 'a part named in a plan scope keeps its family');
  DELETE FROM public.control_plan_applicability WHERE control_plan_id = plan AND part_id = p200;
  UPDATE public.parts SET part_family_id = NULL WHERE id = p200;

  -- Revision lifecycle.
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.control_plan_revisions (organisation_id, control_plan_id, revision_code, status) VALUES (%L, %L, 'A', 'effective')$q$, org, plan), 'new revisions start as draft');
  INSERT INTO public.control_plan_revisions (organisation_id, control_plan_id, revision_code) VALUES (org, plan, 'A') RETURNING id INTO cr_a;
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.control_plan_revisions (organisation_id, control_plan_id, revision_code) VALUES (%L, %L, 'B')$q$, org, plan), 'one working copy per plan');
  -- Content (PC2): one operation with one characteristic; later revisions copy it.
  INSERT INTO public.control_plan_operations (organisation_id, control_plan_revision_id, operation_code, name) VALUES (org, cr_a, 'OP-020', 'Turning');
  INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, name, nominal, lower_limit, upper_limit, unit_code)
    SELECT org, cr_a, id, 'OD', 'Outer diameter', 25, 24.95, 25.05, 'mm' FROM public.control_plan_operations WHERE control_plan_revision_id = cr_a;
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.control_plan_revisions SET status = 'pending_approval' WHERE id = %L$q$, cr_a), 'submitting needs a change reason');
  UPDATE public.control_plan_revisions SET change_reason = 'Initial issue', status = 'pending_approval' WHERE id = cr_a;
  PERFORM pg_temp.assert_eq((SELECT submitted_by FROM public.control_plan_revisions WHERE id = cr_a), '32000000-0000-0000-0000-000000000101'::uuid, 'submitter stamped');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.control_plan_revisions SET change_reason = 'Edited' WHERE id = %L$q$, cr_a), 'a revision under review is locked');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.control_plan_revisions SET status = 'effective' WHERE id = %L$q$, cr_a), 'cannot skip approval');
  UPDATE public.control_plan_revisions SET status = 'draft', review_comment = 'Add the groove check' WHERE id = cr_a;
  PERFORM pg_temp.assert_eq((SELECT (status, submitted_at IS NULL, review_comment) FROM public.control_plan_revisions WHERE id = cr_a)::text,
    '(draft,t,"Add the groove check")', 'sent back to draft with a comment');
  UPDATE public.control_plan_revisions SET status = 'pending_approval' WHERE id = cr_a;
  UPDATE public.control_plan_revisions SET status = 'approved', review_comment = 'OK' WHERE id = cr_a;
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.control_plan_revisions SET revision_code = 'A1' WHERE id = %L$q$, cr_a), 'approved revisions are never edited');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.control_plan_revisions SET approved_by = NULL WHERE id = %L$q$, cr_a), 'approval details are system-set');
  UPDATE public.control_plan_revisions SET status = 'effective' WHERE id = cr_a;
  PERFORM pg_temp.assert_eq((SELECT effective_from IS NOT NULL FROM public.control_plan_revisions WHERE id = cr_a), true, 'effective from stamped');

  -- B: future-dated revision cannot be made effective early; C replaces A.
  INSERT INTO public.control_plan_revisions (organisation_id, control_plan_id, revision_code, change_reason, effective_from)
    VALUES (org, plan, 'B', 'Tighter OD', now() + interval '7 days') RETURNING id INTO cr_b;
  PERFORM pg_temp.assert_eq((SELECT supersedes_revision_id FROM public.control_plan_revisions WHERE id = cr_b), cr_a, 'supersedes the effective revision');
  UPDATE public.control_plan_revisions SET status = 'pending_approval' WHERE id = cr_b;
  UPDATE public.control_plan_revisions SET status = 'approved' WHERE id = cr_b;
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.control_plan_revisions SET status = 'effective' WHERE id = %L$q$, cr_b), 'not before its effective date');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.control_plan_revisions SET status = 'superseded' WHERE id = %L$q$, cr_a), 'superseded only by a newer effective revision');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.control_plan_revisions SET status = 'obsolete' WHERE id = %L$q$, cr_b), 'obsolete needs a reason');
  UPDATE public.control_plan_revisions SET status = 'obsolete', obsolete_reason = 'Replaced by C' WHERE id = cr_b;
  INSERT INTO public.control_plan_revisions (organisation_id, control_plan_id, revision_code, change_reason) VALUES (org, plan, 'C', 'Groove check added') RETURNING id INTO cr_c;
  UPDATE public.control_plan_revisions SET status = 'pending_approval' WHERE id = cr_c;
  UPDATE public.control_plan_revisions SET status = 'approved' WHERE id = cr_c;
  UPDATE public.control_plan_revisions SET status = 'effective' WHERE id = cr_c;
  PERFORM pg_temp.assert_eq((SELECT (status, effective_until IS NOT NULL) FROM public.control_plan_revisions WHERE id = cr_a)::text, '(superseded,t)', 'A superseded with an end');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.control_plan_revisions WHERE control_plan_id = plan AND status = 'effective'), 1::bigint, 'one effective revision');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.control_plan_revisions SET status = 'effective' WHERE id = %L$q$, cr_a), 'superseded stays superseded');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.outbox_events WHERE organisation_id = org AND event_type = 'control_plan.revision.status_changed'), 12::bigint, 'status change events');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.control_plan_history(plan) WHERE entity_type = 'control_plan_applicability'), 3::bigint, 'history includes deleted applicability');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.control_plan_history(plan) WHERE entity_type = 'control_plan_revisions') > 10, true, 'history includes revision changes');

  -- An inactive plan takes no new revisions.
  UPDATE public.control_plans SET active = false WHERE id = plan;
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.control_plan_revisions (organisation_id, control_plan_id, revision_code) VALUES (%L, %L, 'D')$q$, org, plan), 'inactive plan');
  UPDATE public.control_plans SET active = true WHERE id = plan;

  -- Members: a quality engineer (author, not approver) and an inspector (read only).
  PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '32000000-0000-0000-0000-000000000102', 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'quality_engineer';
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '32000000-0000-0000-0000-000000000103', 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'inspector';
  INSERT INTO ids VALUES ('org', org), ('plan', plan), ('fam', fam), ('cr_c', cr_c), ('rev_b', rev_b);
END $$;

-- Quality engineer: drafts and submits, cannot approve or retire a live revision.
DO $$
DECLARE org uuid := (SELECT v FROM ids WHERE k = 'org'); plan uuid := (SELECT v FROM ids WHERE k = 'plan'); d uuid;
BEGIN
  PERFORM pg_temp.login('32000000-0000-0000-0000-000000000102');
  INSERT INTO public.control_plan_revisions (organisation_id, control_plan_id, revision_code, change_reason) VALUES (org, plan, 'D', 'Engineer draft') RETURNING id INTO d;
  UPDATE public.control_plan_revisions SET status = 'pending_approval' WHERE id = d;
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.control_plan_revisions SET status = 'approved' WHERE id = %L$q$, d), 'engineer cannot approve');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.control_plan_revisions SET status = 'obsolete', obsolete_reason = 'x' WHERE id = %L$q$, (SELECT v FROM ids WHERE k = 'cr_c')), 'engineer cannot retire the effective revision');
  UPDATE public.control_plan_revisions SET status = 'draft' WHERE id = d;  -- withdraw
  UPDATE public.control_plan_revisions SET status = 'obsolete', obsolete_reason = 'Not needed' WHERE id = d;  -- discard own draft
  PERFORM pg_temp.logout();
END $$;

-- Inspector: reads plans, changes nothing.
DO $$
DECLARE org uuid := (SELECT v FROM ids WHERE k = 'org'); plan uuid := (SELECT v FROM ids WHERE k = 'plan');
BEGIN
  PERFORM pg_temp.login('32000000-0000-0000-0000-000000000103');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.control_plan_revisions WHERE control_plan_id = plan) >= 4, true, 'inspector reads revisions');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.control_plan_revisions (organisation_id, control_plan_id, revision_code) VALUES (%L, %L, 'E')$q$, org, plan), 'inspector cannot draft');
  PERFORM pg_temp.assert_eq(pg_temp.affected(format($q$UPDATE public.control_plans SET title = 'x' WHERE id = %L$q$, plan)), 0::bigint, 'inspector cannot edit plans');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.part_families (organisation_id, code, name) VALUES (%L, 'X', 'X')$q$, org), 'inspector cannot add families');
  PERFORM pg_temp.assert_eq(pg_temp.affected(format($q$DELETE FROM public.part_revision_characteristics WHERE part_revision_id = %L$q$, (SELECT v FROM ids WHERE k = 'rev_b'))), 0::bigint, 'inspector cannot delete spec values');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
