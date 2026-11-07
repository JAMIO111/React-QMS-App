-- Correcting a released part revision: a correction keeps the drawing's letter and adds a version; the wrong version is kept frozen as `corrected`; new work resolves to
-- the corrected one while existing inspections keep the version they used; only people with approval rights release a correction (the preparer may); corrections are only
-- made and released through the two functions.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('37000000-0000-0000-0000-000000000301', 'owner@corr.test'), ('37000000-0000-0000-0000-000000000302', 'engineer@corr.test'),
  ('37000000-0000-0000-0000-000000000303', 'inspector@corr.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  u_owner uuid := '37000000-0000-0000-0000-000000000301'; u_eng uuid := '37000000-0000-0000-0000-000000000302'; u_insp uuid := '37000000-0000-0000-0000-000000000303';
  org uuid; site uuid; part uuid; plan uuid; prev uuid; op uuid; m uuid;
  v1 uuid; v2 uuid; v3 uuid; b uuid; rec1 uuid; rec2 uuid; res jsonb;
BEGIN
  PERFORM pg_temp.login(u_owner);
  org := app.create_organisation('Correction Works', 'Plant A', 'PA', NULL);
  SELECT id INTO site FROM public.sites WHERE organisation_id = org;
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'COR-100', 'Corrected part') RETURNING id INTO part;
  INSERT INTO public.part_revisions (organisation_id, part_id, revision, drawing_ref) VALUES (org, part, 'A', 'DWG-1') RETURNING id INTO v1;
  INSERT INTO public.part_revision_characteristics (organisation_id, part_revision_id, characteristic_key, nominal, lower_limit, upper_limit, unit_code)
    VALUES (org, v1, 'LENGTH', 100, 99.9, 100.1, 'mm');
  UPDATE public.part_revisions SET status = 'released' WHERE id = v1;
  INSERT INTO public.control_plans (organisation_id, plan_code, title) VALUES (org, 'CP-C', 'Plan') RETURNING id INTO plan;
  INSERT INTO public.control_plan_applicability (organisation_id, control_plan_id, part_id) VALUES (org, plan, part);
  INSERT INTO public.control_plan_revisions (organisation_id, control_plan_id, revision_code, change_reason) VALUES (org, plan, 'A', 'First') RETURNING id INTO prev;
  INSERT INTO public.control_plan_operations (organisation_id, control_plan_revision_id, operation_code, sequence, name) VALUES (org, prev, 'OP-10', 10, 'Turning') RETURNING id INTO op;
  INSERT INTO public.control_plan_characteristics (organisation_id, control_plan_revision_id, operation_id, characteristic_key, sequence, name, nominal, lower_limit, upper_limit, unit_code)
    VALUES (org, prev, op, 'OD', 10, 'Outer diameter', 25, 24.95, 25.05, 'mm');
  UPDATE public.control_plan_revisions SET status = 'pending_approval' WHERE id = prev;
  UPDATE public.control_plan_revisions SET status = 'approved' WHERE id = prev;
  UPDATE public.control_plan_revisions SET status = 'effective' WHERE id = prev;
  rec1 := app.start_inspection(site, part);  -- an inspection on Rev A v1

  PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u_eng, 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'quality_engineer';
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u_insp, 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'inspector';

  -- Who may start one: manage rights on the current released revision, with a reason.
  PERFORM pg_temp.login(u_insp);
  PERFORM pg_temp.assert_fails(format($q$SELECT app.start_part_revision_correction(%L, 'Wrong tolerance')$q$, v1), 'a reader cannot start a correction');
  PERFORM pg_temp.login(u_eng);
  PERFORM pg_temp.assert_fails(format($q$SELECT app.start_part_revision_correction(%L, '   ')$q$, v1), 'a reason is required');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.start_part_revision_correction(%L, %L)$q$, v1, repeat('x', 1001)), 'the reason is at most 1000 characters');
  v2 := app.start_part_revision_correction(v1, '  The drawing says 100.2 max  ');
  PERFORM pg_temp.assert_eq((SELECT revision || '/' || version || '/' || status || '/' || (corrects_id = v1)::text || '/' || correction_reason FROM public.part_revisions WHERE id = v2),
    'A/2/draft/true/The drawing says 100.2 max', 'a draft of the next version of the same letter, with the trimmed reason');
  PERFORM pg_temp.assert_eq((SELECT drawing_ref FROM public.part_revisions WHERE id = v2), 'DWG-1', 'the drawing reference is copied');
  PERFORM pg_temp.assert_eq((SELECT nominal::text || '/' || upper_limit::text FROM public.part_revision_characteristics WHERE part_revision_id = v2 AND characteristic_key = 'LENGTH'), '100/100.1', 'the values are copied');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.start_part_revision_correction(%L, 'Again')$q$, v1), 'one correction in progress at a time');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.start_part_revision_correction(%L, 'A draft is not released')$q$, v2), 'only a released revision can be corrected');

  -- Corrections are made and released only through the functions.
  PERFORM pg_temp.login(u_owner);
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.part_revisions (organisation_id, part_id, revision, version, corrects_id, correction_reason) VALUES (%L, %L, 'A', 3, %L, 'x')$q$, org, part, v1), 'no direct correction insert');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.part_revisions (organisation_id, part_id, revision, version) VALUES (%L, %L, 'A', 5)$q$, org, part), 'no direct version');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.part_revisions SET status = 'released' WHERE id = %L$q$, v2), 'a correction cannot be released as a new revision');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.part_revisions SET status = 'corrected' WHERE id = %L$q$, v1), 'a revision cannot be marked corrected directly');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.part_revisions SET version = 9 WHERE id = %L$q$, v2), 'the version cannot change');

  -- The draft is edited like any draft; the author cannot approve it, the owner can.
  PERFORM pg_temp.login(u_eng);
  UPDATE public.part_revisions SET change_summary = 'Upper limit corrected to match the drawing' WHERE id = v2;
  UPDATE public.part_revision_characteristics SET upper_limit = 100.2 WHERE part_revision_id = v2 AND characteristic_key = 'LENGTH';
  PERFORM pg_temp.assert_eq((SELECT upper_limit::text FROM public.part_revision_characteristics WHERE part_revision_id = v1 AND characteristic_key = 'LENGTH'), '100.1', 'the wrong version keeps its values');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.release_part_revision_correction(%L)$q$, v2), 'an engineer cannot approve');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.release_part_revision_correction(%L)$q$, v1), 'only a correction can be released this way');
  PERFORM pg_temp.login(u_insp);
  PERFORM pg_temp.assert_fails(format($q$SELECT app.release_part_revision_correction(%L)$q$, v2), 'an inspector cannot approve');

  PERFORM pg_temp.login(u_owner);
  PERFORM app.release_part_revision_correction(v2);
  PERFORM pg_temp.assert_eq((SELECT status FROM public.part_revisions WHERE id = v1), 'corrected', 'the wrong version is marked corrected');
  PERFORM pg_temp.assert_eq((SELECT corrected_at IS NOT NULL AND corrected_by = u_owner FROM public.part_revisions WHERE id = v1), true, 'who and when');
  PERFORM pg_temp.assert_eq((SELECT status || '/' || (released_at IS NOT NULL)::text FROM public.part_revisions WHERE id = v2), 'released/true', 'the correction is released');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.part_revisions WHERE part_id = part AND status = 'released'), 1::bigint, 'exactly one released version');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.outbox_events WHERE organisation_id = org AND event_type = 'part.revision.corrected'), 1::bigint, 'a correction event');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.outbox_events WHERE organisation_id = org AND event_type = 'part.revision.released'), 1::bigint, 'no second release event');
  PERFORM pg_temp.assert_eq((SELECT payload ->> 'reason' FROM public.outbox_events WHERE organisation_id = org AND event_type = 'part.revision.corrected'), 'The drawing says 100.2 max', 'the event carries the reason');
  PERFORM pg_temp.login(u_owner);

  -- The wrong version is frozen for good and cannot be corrected again.
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.part_revisions SET drawing_ref = 'X' WHERE id = %L$q$, v1), 'a corrected version cannot be edited');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.part_revision_characteristics SET nominal = 100.1 WHERE part_revision_id = %L$q$, v1), 'its values stay locked');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.part_revisions SET status = 'obsolete' WHERE id = %L$q$, v1), 'it cannot be changed to anything else');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.start_part_revision_correction(%L, 'Too late')$q$, v1), 'a corrected version cannot be corrected');

  -- New work resolves to the corrected version; the earlier inspection keeps the one it used.
  res := app.resolve_inspection_requirements(part);
  PERFORM pg_temp.assert_eq(res -> 'partRevision' ->> 'id', v2::text, 'the resolver uses the corrected version');
  PERFORM pg_temp.assert_eq(res -> 'partRevision' ->> 'revision', 'A', 'and still the drawing''s letter');
  rec2 := app.start_inspection(site, part);
  PERFORM pg_temp.assert_eq((SELECT part_revision_id FROM public.inspection_records WHERE id = rec1), v1, 'the earlier inspection stays on the version it used');
  PERFORM pg_temp.assert_eq((SELECT part_revision_id FROM public.inspection_records WHERE id = rec2), v2, 'the new inspection uses the corrected version');

  -- A correction of the corrected version; discarding it allows another; a later letter makes an open correction unreleasable.
  v3 := app.start_part_revision_correction(v2, 'Second thoughts');
  PERFORM pg_temp.assert_eq((SELECT version FROM public.part_revisions WHERE id = v3), 3, 'versions count up');
  UPDATE public.part_revisions SET status = 'obsolete' WHERE id = v3;  -- discard
  v3 := app.start_part_revision_correction(v2, 'Another go');
  INSERT INTO public.part_revisions (organisation_id, part_id, revision) VALUES (org, part, 'B') RETURNING id INTO b;
  UPDATE public.part_revisions SET status = 'released' WHERE id = b;
  PERFORM pg_temp.assert_eq((SELECT status FROM public.part_revisions WHERE id = v2), 'superseded', 'a later letter supersedes the corrected version');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format($q$SELECT app.release_part_revision_correction(%L)$q$, v3)) LIKE 'QM003: Revision A v2 is no longer the released version%', true, 'a correction of a version that is no longer released is refused, saying why');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.start_part_revision_correction(%L, 'Old one')$q$, v2), 'a superseded revision cannot be corrected (out of scope)');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.part_revisions WHERE id = v1), 'corrected', 'v1 is still marked corrected');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
