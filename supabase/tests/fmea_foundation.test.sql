-- FMEA FM1: permissions and role defaults, creating an FMEA (number, first draft, team, scope), what a draft still needs, submitting, approving (a named approver who
-- is not the preparer), becoming effective, a new revision, sending back, recalling, withdrawing, discarding, the rules the tables hold even for SQL, who reads what, tenancy.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('4d000000-0000-0000-0000-000000000d01', 'ann@fm.test'), ('4d000000-0000-0000-0000-000000000d02', 'bob@fm.test'),
  ('4d000000-0000-0000-0000-000000000d03', 'cat@fm.test'), ('4d000000-0000-0000-0000-000000000d04', 'dan@fm.test'),
  ('4d000000-0000-0000-0000-000000000d05', 'eve@fm.test'), ('4d000000-0000-0000-0000-000000000d06', 'fay@fm.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '4d000000-0000-0000-0000-000000000d01'; bob uuid := '4d000000-0000-0000-0000-000000000d02';
  cat uuid := '4d000000-0000-0000-0000-000000000d03'; dan uuid := '4d000000-0000-0000-0000-000000000d04';
  eve uuid := '4d000000-0000-0000-0000-000000000d05'; fay uuid := '4d000000-0000-0000-0000-000000000d06';
  org uuid; org2 uuid; u uuid; f1 uuid; f2 uuid; f3 uuid; r1 uuid; r2 uuid; r3 uuid; part uuid; part_other uuid; fam uuid; plan uuid; emp uuid; r text; v_problems text[];
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('FM Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('FM Beta'); PERFORM pg_temp.logout();
  -- Bob: viewer (reads). Cat: quality engineer (manages). Dan: quality manager (approves). Fay: quality engineer.
  FOREACH u IN ARRAY ARRAY[bob, cat, dan, fay] LOOP
    INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u, 'active');
  END LOOP;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = CASE ou.user_id WHEN dan THEN 'quality_manager' WHEN bob THEN 'viewer' ELSE 'quality_engineer' END)
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id IN (bob, cat, dan, fay);

  -- ---- permissions and role defaults ----
  PERFORM pg_temp.assert_eq((SELECT array_agg(rp.permission_code ORDER BY rp.permission_code) FROM public.role_permissions rp JOIN public.roles r ON r.id = rp.role_id
    WHERE r.organisation_id = org AND r.key = 'quality_manager' AND rp.permission_code LIKE 'fmea.%'), ARRAY['fmea.approve','fmea.manage','fmea.read'], 'a quality manager holds all three');
  PERFORM pg_temp.assert_eq((SELECT array_agg(rp.permission_code ORDER BY rp.permission_code) FROM public.role_permissions rp JOIN public.roles r ON r.id = rp.role_id
    WHERE r.organisation_id = org AND r.key = 'quality_engineer' AND rp.permission_code LIKE 'fmea.%'), ARRAY['fmea.manage','fmea.read'], 'a quality engineer prepares but does not approve');
  PERFORM pg_temp.assert_eq((SELECT array_agg(rp.permission_code ORDER BY rp.permission_code) FROM public.role_permissions rp JOIN public.roles r ON r.id = rp.role_id
    WHERE r.organisation_id = org AND r.key = 'inspector' AND rp.permission_code LIKE 'fmea.%'), ARRAY['fmea.read'], 'an inspector reads');

  PERFORM pg_temp.login(ann);
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'FM-P1', 'Bracket') RETURNING id INTO part;
  INSERT INTO public.part_families (organisation_id, code, name) VALUES (org, 'FM-F1', 'Brackets') RETURNING id INTO fam;
  INSERT INTO public."Employees" (organisation_id, first_name, surname) VALUES (org, 'Eddie', 'Engineer') RETURNING id INTO emp;
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve);
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org2, 'FM-X1', 'Other') RETURNING id INTO part_other;
  PERFORM pg_temp.logout();

  -- ---- creating an FMEA ----
  PERFORM pg_temp.login(bob);
  r := pg_temp.fails(format($f$SELECT app.create_fmea(%L, '{"kind":"process","title":"x"}'::jsonb)$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a viewer cannot prepare an FMEA');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login(cat);
  r := pg_temp.fails(format($f$SELECT app.create_fmea(%L, '{"kind":"process"}'::jsonb)$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'a title is needed');
  r := pg_temp.fails(format($f$SELECT app.create_fmea(%L, '{"kind":"service","title":"x"}'::jsonb)$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'the kind is design or process');
  r := pg_temp.fails(format($f$SELECT app.create_fmea(%L, '{"kind":"process","title":"x","colour":"red"}'::jsonb)$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'an unknown field is refused');
  r := pg_temp.fails(format($f$SELECT app.create_fmea(%L, jsonb_build_object('kind','process','title','x','ownerId',%L))$f$, org, eve));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'the owner must be a member');
  r := pg_temp.fails(format($f$SELECT app.create_fmea(%L, jsonb_build_object('kind','process','title','x','links',jsonb_build_array(jsonb_build_object('kind','part','id',%L))))$f$, org, part_other));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'another organisation''s part cannot be covered');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmeas WHERE organisation_id = org), 0::bigint, 'a refused create leaves nothing behind');

  f1 := app.create_fmea(org, jsonb_build_object('kind', 'process', 'title', 'Machining of the bracket', 'scopeText', 'Turning and drilling',
    'team', jsonb_build_array(jsonb_build_object('userId', cat, 'role', 'lead'), jsonb_build_object('employeeId', emp, 'role', 'process')),
    'links', jsonb_build_array(jsonb_build_object('kind', 'part', 'id', part), jsonb_build_object('kind', 'part', 'id', part),
                               jsonb_build_object('kind', 'part_family', 'id', fam), jsonb_build_object('kind', 'operation_code', 'code', 'OP10'))));
  PERFORM pg_temp.assert_eq((SELECT number FROM public.fmeas WHERE id = f1), 'FMEA-001', 'the first number');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.fmeas WHERE id = f1), 'draft', 'a new FMEA is a draft');
  PERFORM pg_temp.assert_eq((SELECT owner_user_id FROM public.fmeas WHERE id = f1), cat, 'the owner defaults to the preparer');
  SELECT id INTO r1 FROM public.fmea_revisions WHERE fmea_id = f1;
  PERFORM pg_temp.assert_eq((SELECT status || '/' || sequence || '/' || coalesce(letter, '-') FROM public.fmea_revisions WHERE id = r1), 'draft/1/-', 'a first draft with no letter yet');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_team_members WHERE revision_id = r1), 2::bigint, 'the team');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_links WHERE revision_id = r1), 3::bigint, 'a duplicate link is dropped');
  f2 := app.create_fmea(org, jsonb_build_object('kind', 'design', 'title', 'Bracket design'));
  PERFORM pg_temp.assert_eq((SELECT number FROM public.fmeas WHERE id = f2), 'FMEA-002', 'the next number follows');

  -- ---- team and scope rules ----
  r := pg_temp.fails(format($f$SELECT app.set_fmea_team(%L, jsonb_build_array(jsonb_build_object('userId',%L,'role','lead'), jsonb_build_object('userId',%L,'role','lead')))$f$, r1, cat, fay));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'there is one lead');
  r := pg_temp.fails(format($f$SELECT app.set_fmea_team(%L, jsonb_build_array(jsonb_build_object('userId',%L,'role','boss')))$f$, r1, cat));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'an unknown role is refused');
  r := pg_temp.fails(format($f$SELECT app.set_fmea_team(%L, jsonb_build_array(jsonb_build_object('userId',%L,'role','quality')))$f$, r1, eve));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'only members of this organisation can be on the team');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_team_members WHERE revision_id = r1), 2::bigint, 'a refused team leaves the old one');
  PERFORM app.set_fmea_team(r1, jsonb_build_array(jsonb_build_object('userId', cat, 'role', 'lead'), jsonb_build_object('userId', fay, 'role', 'quality'), jsonb_build_object('employeeId', emp, 'role', 'process')));
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_team_members WHERE revision_id = r1), 3::bigint, 'the team is replaced as a whole');
  PERFORM pg_temp.build_fmea_net(r1);

  -- ---- what a draft still needs ----
  v_problems := app.fmea_revision_problems(r1);
  PERFORM pg_temp.assert_eq(v_problems, ARRAY['Name the approver'], 'only the approver is missing');
  v_problems := app.fmea_revision_problems((SELECT id FROM public.fmea_revisions WHERE fmea_id = f2));
  PERFORM pg_temp.assert_eq(cardinality(v_problems), 5, 'an empty FMEA lacks a lead, a team, a scope, a structure and an approver');
  r := pg_temp.fails(format('SELECT app.submit_fmea_revision(%L)', r1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'it cannot be submitted while something is needed');

  -- ---- the approver ----
  r := pg_temp.fails(format('SELECT app.set_fmea_approver(%L, %L)', r1, cat));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'the preparer cannot be the approver');
  r := pg_temp.fails(format('SELECT app.set_fmea_approver(%L, %L)', r1, fay));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'someone without the approve permission cannot be named');
  r := pg_temp.fails(format('SELECT app.set_fmea_approver(%L, %L)', r1, eve));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'someone outside the organisation cannot be named');
  PERFORM app.set_fmea_approver(r1, dan);
  PERFORM pg_temp.assert_eq(cardinality(app.fmea_revision_problems(r1)), 0, 'nothing is needed now');

  -- ---- submitting freezes the content ----
  PERFORM app.submit_fmea_revision(r1);
  PERFORM pg_temp.assert_eq((SELECT status || '/' || letter FROM public.fmea_revisions WHERE id = r1), 'pending_approval/A', 'submitted, and given its letter');
  r := pg_temp.fails(format($f$SELECT app.set_fmea_team(%L, '[]'::jsonb)$f$, r1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'the team is frozen once submitted');
  r := pg_temp.fails(format($f$SELECT app.set_fmea_links(%L, '[]'::jsonb)$f$, r1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'the scope is frozen once submitted');
  r := pg_temp.fails(format($f$SELECT app.update_fmea_revision(%L, '{"changeSummary":"x"}'::jsonb)$f$, r1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'the wording is frozen once submitted');
  r := pg_temp.fails(format('SELECT app.discard_fmea_revision(%L, %L)', r1, 'no longer wanted'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'a submitted revision cannot be discarded');
  PERFORM pg_temp.logout();

  -- A person who is not the approver cannot approve; the preparer neither; a viewer cannot even see it as a draft before approval.
  PERFORM pg_temp.login(fay);
  r := pg_temp.fails(format('SELECT app.approve_fmea_revision(%L, current_date, NULL)', r1));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'only the named approver approves');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmeas WHERE id = f1), 0::bigint, 'a viewer does not see an FMEA that has not been approved');
  PERFORM pg_temp.logout();

  -- ---- sending back and recalling ----
  PERFORM pg_temp.login(dan);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmeas WHERE id = f1), 1::bigint, 'the approver reads what waits for them');
  r := pg_temp.fails(format('SELECT app.send_back_fmea_revision(%L, %L)', r1, 'x'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'sending back needs a comment');
  PERFORM app.send_back_fmea_revision(r1, 'Add the detection controls');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.fmea_revisions WHERE id = r1), 'draft', 'back to draft');
  PERFORM pg_temp.assert_eq((SELECT returned_comment FROM public.fmea_revisions WHERE id = r1), 'Add the detection controls', 'the comment is kept');
  PERFORM pg_temp.assert_eq((SELECT letter FROM public.fmea_revisions WHERE id = r1), 'A', 'the letter stays');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  PERFORM app.submit_fmea_revision(r1);
  PERFORM pg_temp.assert_eq((SELECT letter FROM public.fmea_revisions WHERE id = r1), 'A', 'a second submission keeps the letter');
  r := pg_temp.fails(format('SELECT app.recall_fmea_revision(%L, %L)', r1, 'x'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'recalling needs a reason');
  PERFORM app.recall_fmea_revision(r1, 'The approver is away');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.fmea_revisions WHERE id = r1), 'draft', 'recalled to draft');
  PERFORM app.submit_fmea_revision(r1);
  PERFORM pg_temp.logout();

  -- ---- approving ----
  PERFORM pg_temp.login(dan);
  r := pg_temp.fails(format('SELECT app.approve_fmea_revision(%L, current_date - 1, NULL)', r1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'it cannot take effect in the past');
  r := pg_temp.fails(format('SELECT app.approve_fmea_revision(%L, NULL, NULL)', r1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'it needs a date');
  PERFORM app.approve_fmea_revision(r1, current_date, 'Looks right');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.fmea_revisions WHERE id = r1), 'effective', 'approved for today, so in force at once');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.fmeas WHERE id = f1), 'active', 'the FMEA is active');
  PERFORM pg_temp.assert_eq((SELECT current_revision_id FROM public.fmeas WHERE id = f1), r1, 'it names the revision in force');
  PERFORM pg_temp.assert_eq((SELECT next_review_on FROM public.fmeas WHERE id = f1), (current_date + interval '12 months')::date, 'a review is due in a year by default');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmeas WHERE id = f1), 1::bigint, 'a viewer reads an FMEA in force');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_team_members WHERE revision_id = r1), 3::bigint, 'and its team');
  PERFORM pg_temp.logout();

  -- ---- a new revision ----
  PERFORM pg_temp.login(cat);
  PERFORM app.update_fmea(f1, '{"reviewMonths": 6}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT next_review_on FROM public.fmeas WHERE id = f1), (current_date + interval '6 months')::date, 'a shorter interval moves the review date');
  r2 := app.start_fmea_revision(f1);
  PERFORM pg_temp.assert_eq((SELECT sequence || '/' || status || '/' || coalesce(letter, '-') FROM public.fmea_revisions WHERE id = r2), '2/draft/-', 'a second draft with no letter yet');
  PERFORM pg_temp.assert_eq((SELECT previous_revision_id FROM public.fmea_revisions WHERE id = r2), r1, 'it follows the revision in force');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_team_members WHERE revision_id = r2), 3::bigint, 'the team is copied');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_links WHERE revision_id = r2), 3::bigint, 'the scope is copied');
  r := pg_temp.fails(format('SELECT app.start_fmea_revision(%L)', f1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'one revision in progress at a time');
  r := pg_temp.fails(format('SELECT app.start_fmea_revision(%L)', f2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'an FMEA never in force carries on with its draft');
  PERFORM app.set_fmea_approver(r2, dan);
  PERFORM pg_temp.assert_eq(app.fmea_revision_problems(r2), ARRAY['Say what changed and why'], 'a later revision says what changed');
  PERFORM app.update_fmea_revision(r2, '{"changeSummary":"Added a gauge check"}'::jsonb);
  PERFORM app.submit_fmea_revision(r2);
  PERFORM pg_temp.assert_eq((SELECT letter FROM public.fmea_revisions WHERE id = r2), 'B', 'the next letter');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(dan);
  PERFORM app.approve_fmea_revision(r2, current_date, NULL);
  PERFORM pg_temp.assert_eq((SELECT status FROM public.fmea_revisions WHERE id = r1), 'superseded', 'the old revision is superseded');
  PERFORM pg_temp.assert_eq((SELECT superseded_by_id FROM public.fmea_revisions WHERE id = r1), r2, 'and says by which');
  PERFORM pg_temp.assert_eq((SELECT current_revision_id FROM public.fmeas WHERE id = f1), r2, 'the FMEA names the new revision');

  -- ---- withdrawing ----
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  r := pg_temp.fails(format('SELECT app.withdraw_fmea(%L, %L)', f1, 'no longer made'));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a preparer cannot withdraw');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(dan);
  r := pg_temp.fails(format('SELECT app.withdraw_fmea(%L, %L)', f1, 'x'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'withdrawing needs a reason');
  PERFORM app.withdraw_fmea(f1, 'Product no longer made');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.fmeas WHERE id = f1), 'withdrawn', 'withdrawn');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.fmea_revisions WHERE id = r2), 'withdrawn', 'its revision in force is withdrawn too');
  PERFORM pg_temp.assert_eq((SELECT next_review_on FROM public.fmeas WHERE id = f1) IS NULL, true, 'no review is due');
  PERFORM pg_temp.logout();
  -- A withdrawn FMEA can be started again.
  PERFORM pg_temp.login(cat);
  r3 := app.start_fmea_revision(f1);
  PERFORM pg_temp.assert_eq((SELECT sequence FROM public.fmea_revisions WHERE id = r3), 3, 'a withdrawn FMEA starts a new revision');
  PERFORM pg_temp.logout();

  -- ---- discarding ----
  PERFORM pg_temp.login(cat);
  r := pg_temp.fails(format('SELECT app.discard_fmea_revision(%L, %L)', (SELECT id FROM public.fmea_revisions WHERE fmea_id = f2), 'x'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'discarding needs a reason');
  PERFORM app.discard_fmea_revision((SELECT id FROM public.fmea_revisions WHERE fmea_id = f2), 'Started by mistake');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.fmeas WHERE id = f2), 'discarded', 'the only draft of a never-used FMEA discards the FMEA');
  r := pg_temp.fails(format($f$SELECT app.update_fmea(%L, '{"title":"again"}'::jsonb)$f$, f2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'a discarded FMEA cannot be changed');
  PERFORM app.discard_fmea_revision(r3, 'Not needed after all');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.fmeas WHERE id = f1), 'withdrawn', 'discarding a later draft leaves a used FMEA as it was');
  PERFORM pg_temp.logout();

  -- ---- what the tables hold even for SQL ----
  r := pg_temp.fails(format('DELETE FROM public.fmeas WHERE id = %L', f1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'an FMEA is never deleted');
  r := pg_temp.fails(format('DELETE FROM public.fmea_revisions WHERE id = %L', r1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'a revision is never deleted');
  r := pg_temp.fails(format($f$UPDATE public.fmea_revisions SET letter = 'Z' WHERE id = %L$f$, r2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'a letter never changes');
  r := pg_temp.fails(format($f$UPDATE public.fmea_revisions SET status = 'effective' WHERE id = %L$f$, r3));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'a revision cannot jump to effective');
  r := pg_temp.fails(format($f$UPDATE public.fmeas SET kind = 'design' WHERE id = %L$f$, f1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'the kind never changes');
  r := pg_temp.fails(format($f$UPDATE public.fmeas SET number = 'FMEA-099' WHERE id = %L$f$, f1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'the number never changes');
  r := pg_temp.fails(format($f$UPDATE public.fmea_revisions SET change_summary = 'edited' WHERE id = %L$f$, r2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM036', 'a revision no longer in draft keeps its wording');
  PERFORM pg_temp.login(cat);
  r := pg_temp.fails(format($f$INSERT INTO public.fmea_revisions (organisation_id, fmea_id, sequence) VALUES (%L, %L, 9)$f$, org, f1));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a signed-in person cannot insert a revision directly');
  r := pg_temp.fails(format($f$UPDATE public.fmeas SET title = 'sneaky' WHERE id = %L$f$, f1));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'nor change an FMEA directly');
  PERFORM pg_temp.logout();

  -- ---- tenancy ----
  PERFORM pg_temp.login(eve);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmeas), 0::bigint, 'another organisation sees none of it');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.fmea_revisions), 0::bigint, 'nor the revisions');
  r := pg_temp.fails(format('SELECT app.start_fmea_revision(%L)', f1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'another organisation''s FMEA is not found');
  r := pg_temp.fails(format($f$SELECT app.create_fmea(%L, '{"kind":"process","title":"x"}'::jsonb)$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'nor can it create one here');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
