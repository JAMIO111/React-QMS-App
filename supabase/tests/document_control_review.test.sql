-- Document control DC2: reviewers and approver, review rounds, send-back, approval with an effective date, settling (effective / superseded),
-- withdrawing, new revisions copying the last one, frozen revisions and sign-offs, notices to reviewers and the approver.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('3e000000-0000-0000-0000-000000000b01', 'ann@dr.test'), ('3e000000-0000-0000-0000-000000000b02', 'bob@dr.test'),
  ('3e000000-0000-0000-0000-000000000b03', 'cat@dr.test'), ('3e000000-0000-0000-0000-000000000b04', 'dan@dr.test'),
  ('3e000000-0000-0000-0000-000000000b05', 'eve@dr.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  -- ann: owner (writes, issues); bob: quality manager (approver); cat: quality engineer (reviewer, manage, cannot issue); dan: viewer (reviewer); eve: another org.
  ann uuid := '3e000000-0000-0000-0000-000000000b01'; bob uuid := '3e000000-0000-0000-0000-000000000b02'; cat uuid := '3e000000-0000-0000-0000-000000000b03';
  dan uuid := '3e000000-0000-0000-0000-000000000b04'; eve uuid := '3e000000-0000-0000-0000-000000000b05';
  org uuid; org2 uuid; sop uuid; d1 uuid; r1 uuid; r2 uuid; r3 uuid; r text; n bigint;
  v_body jsonb := '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Segregate suspect parts"}]}]}';
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('DR Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('DR Beta'); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, bob, 'active'), (org, cat, 'active'), (org, dan, 'active');
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = CASE ou.user_id WHEN bob THEN 'quality_manager' WHEN cat THEN 'quality_engineer' ELSE 'viewer' END)
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id IN (bob, cat, dan);

  PERFORM pg_temp.login(ann);
  SELECT id INTO sop FROM public.document_types WHERE organisation_id = org AND prefix = 'SOP';
  d1 := app.create_document(org, jsonb_build_object('typeId', sop, 'title', 'Nonconforming product', 'contentKind', 'text'));
  SELECT id INTO r1 FROM public.document_revisions WHERE document_id = d1;
  PERFORM pg_temp.assert_eq((SELECT array_to_string(app.document_revision_problems(r1), '|')), 'Write the document''s text|Name at least one reviewer|Name the approver', 'what a draft still needs');
  r := pg_temp.fails(format('SELECT app.submit_document_revision(%L)', r1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'cannot submit with things still needed');
  PERFORM app.update_document_revision(r1, jsonb_build_object('body', v_body));

  -- ---- signers ----
  r := pg_temp.fails(format('SELECT app.set_document_signers(%L, ARRAY[%L]::uuid[], %L)', r1, ann, bob));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'the author is not a reviewer');
  r := pg_temp.fails(format('SELECT app.set_document_signers(%L, ARRAY[%L]::uuid[], %L)', r1, cat, ann));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'nor the approver');
  r := pg_temp.fails(format('SELECT app.set_document_signers(%L, ARRAY[%L]::uuid[], %L)', r1, eve, bob));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'reviewers are members');
  PERFORM app.set_document_signers(r1, ARRAY[cat, dan], bob);
  PERFORM pg_temp.assert_eq(cardinality(app.document_revision_problems(r1)), 0, 'nothing more needed');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.document_signer_candidates(org) c WHERE c.can_approve), 2::bigint, 'ann and bob can approve');

  -- ---- round 1: a reviewer sends it back ----
  PERFORM app.submit_document_revision(r1);
  PERFORM pg_temp.assert_eq((SELECT status || '/' || letter || '/' || review_round FROM public.document_revisions WHERE id = r1), 'in_review/A/1', 'submitted, given letter A, round 1');
  PERFORM pg_temp.assert_eq((SELECT last_letter FROM public.documents WHERE id = d1), 'A', 'the document remembers the letter');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.document_signoffs WHERE revision_id = r1 AND decision = 'pending' AND role = 'reviewer'), 2::bigint, 'one pending sign-off per reviewer');
  r := pg_temp.fails(format($f$SELECT app.update_document_revision(%L, '{"changeSummary":"x"}'::jsonb)$f$, r1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'content is frozen in review');
  r := pg_temp.fails(format('SELECT app.set_document_signers(%L, ARRAY[%L]::uuid[], %L)', r1, cat, bob));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'and so are the signers');
  r := pg_temp.fails(format('SELECT app.review_document_revision(%L, true)', r1));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'the author is not a reviewer');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login(dan);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.document_revisions WHERE id = r1), 1::bigint, 'a viewer named as reviewer reads the revision');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.documents WHERE id = d1), 1::bigint, 'and its document');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.notifications WHERE recipient_user_id = dan AND entity_type = 'document_signoffs'), 1::bigint, 'and was told it waits for them');
  PERFORM pg_temp.assert_eq((SELECT n.body FROM public.notifications n WHERE n.recipient_user_id = dan AND n.entity_type = 'document_signoffs'), 'SOP-001 rev A · Nonconforming product — Review it', 'naming the document');
  r := pg_temp.fails(format('SELECT app.review_document_revision(%L, false, %L)', r1, 'no'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'sending back needs a comment');
  PERFORM app.review_document_revision(r1, false, 'Section 3 is missing the quarantine label');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.document_revisions WHERE id = r1), 'draft', 'back to draft');
  PERFORM pg_temp.assert_eq((SELECT string_agg(decision, ',' ORDER BY decision) FROM public.document_signoffs WHERE revision_id = r1), 'closed,returned', 'the other pending review is closed');
  r := pg_temp.fails(format($f$UPDATE public.document_signoffs SET comment = 'x' WHERE revision_id = %L$f$, r1));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'no direct writes');
  PERFORM pg_temp.logout();

  -- ---- round 2: both accept, then the approver ----
  PERFORM pg_temp.login(ann);
  PERFORM app.update_document_revision(r1, '{"changeSummary":"Added the quarantine label"}'::jsonb);
  PERFORM app.submit_document_revision(r1);
  PERFORM pg_temp.assert_eq((SELECT letter || '/' || review_round FROM public.document_revisions WHERE id = r1), 'A/2', 'the letter is kept; round 2');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.document_signoffs WHERE revision_id = r1 AND round = 2 AND decision = 'pending'), 2::bigint, 'every review starts again');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat); PERFORM app.review_document_revision(r1, true, 'Fine'); PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT status FROM public.document_revisions WHERE id = r1), 'in_review', 'still waiting for the other reviewer');
  PERFORM pg_temp.login(dan);
  r := pg_temp.fails(format('SELECT app.approve_document_revision(%L, current_date)', r1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'not awaiting approval yet');
  PERFORM app.review_document_revision(r1, true);
  r := pg_temp.fails(format('SELECT app.review_document_revision(%L, true)', r1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'a sign-off is given once');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT status FROM public.document_revisions WHERE id = r1), 'awaiting_approval', 'every reviewer accepted');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.notifications WHERE recipient_user_id = bob AND notifications.body LIKE '%Approve it'), 1::bigint, 'the approver is told');

  PERFORM pg_temp.login(bob);
  r := pg_temp.fails(format('SELECT app.approve_document_revision(%L, current_date - 1)', r1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'not effective before today');
  PERFORM app.approve_document_revision(r1, current_date + 7, 'Approved');
  PERFORM pg_temp.assert_eq((SELECT status || '/' || (effective_from - current_date) FROM public.document_revisions WHERE id = r1), 'approved/7', 'approved, effective in a week');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.documents WHERE id = d1), 'draft', 'not in force until then');
  r := pg_temp.fails(format($f$UPDATE public.document_revisions SET effective_from = current_date WHERE id = %L$f$, r1));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'no direct writes');
  PERFORM pg_temp.logout();
  r := pg_temp.fails(format($f$UPDATE public.document_revisions SET effective_from = current_date WHERE id = %L$f$, r1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'an approved revision is frozen, for SQL too');

  -- ---- settling: the date comes ----
  ALTER TABLE public.document_revisions DISABLE TRIGGER document_revisions_rules;
  UPDATE public.document_revisions SET effective_from = current_date WHERE id = r1;
  ALTER TABLE public.document_revisions ENABLE TRIGGER document_revisions_rules;
  PERFORM pg_temp.login(dan);
  PERFORM pg_temp.assert_eq(app.settle_documents(org), 1, 'settled on read');
  PERFORM pg_temp.assert_eq(app.settle_documents(org), 0, 'idempotent');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT d.status || '/' || (d.current_revision_id = r1) || '/' || r.status FROM public.documents d JOIN public.document_revisions r ON r.id = r1 WHERE d.id = d1),
    'active/true/effective', 'in force, rev A current');

  -- ---- rev B: a new revision copies the text, is approved for today and supersedes A ----
  PERFORM pg_temp.login(ann);
  r2 := app.start_document_revision(d1);
  PERFORM pg_temp.assert_eq((SELECT body_text = 'Segregate suspect parts' AND change_summary IS NULL AND previous_revision_id = r1 FROM public.document_revisions WHERE id = r2), true,
    'the text is copied, the summary starts empty');
  r := pg_temp.fails(format('SELECT app.start_document_revision(%L)', d1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'one revision in progress');
  PERFORM app.set_document_signers(r2, ARRAY[cat], bob);
  PERFORM pg_temp.assert_eq((SELECT array_to_string(app.document_revision_problems(r2), '|')), 'Say what changed and why', 'a later revision says what changed');
  PERFORM app.update_document_revision(r2, '{"changeSummary":"Scope widened"}'::jsonb);
  PERFORM app.submit_document_revision(r2);
  PERFORM pg_temp.assert_eq((SELECT letter FROM public.document_revisions WHERE id = r2), 'B', 'rev B');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat); PERFORM app.review_document_revision(r2, true); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(bob);
  r := pg_temp.fails(format('SELECT app.send_back_document_revision(%L, %L)', r2, 'x'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'the approver sends back with a comment');
  PERFORM app.approve_document_revision(r2, current_date);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT string_agg(letter || ':' || status, ',' ORDER BY sequence) FROM public.document_revisions WHERE document_id = d1), 'A:superseded,B:effective',
    'approved for today takes effect at once and supersedes A');
  PERFORM pg_temp.assert_eq((SELECT superseded_by_id FROM public.document_revisions WHERE id = r1), r2, 'A says what replaced it');

  -- ---- an approver without documentation.issue, and the author approving ----
  PERFORM pg_temp.login(ann);
  r3 := app.start_document_revision(d1);
  PERFORM app.update_document_revision(r3, '{"changeSummary":"Typo"}'::jsonb);
  PERFORM app.set_document_signers(r3, ARRAY[dan], cat);
  PERFORM app.submit_document_revision(r3);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(dan); PERFORM app.review_document_revision(r3, true); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(cat);
  r := pg_temp.fails(format('SELECT app.approve_document_revision(%L, current_date)', r3));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'approving needs documentation.issue');
  PERFORM app.send_back_document_revision(r3, 'I cannot approve this; choose Bob');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT status FROM public.document_revisions WHERE id = r3), 'draft', 'sent back by the approver');

  -- ---- withdrawing ----
  PERFORM pg_temp.login(cat);
  r := pg_temp.fails(format('SELECT app.withdraw_document(%L, %L)', d1, 'Obsolete'));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'withdrawing needs documentation.issue');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ann);
  r := pg_temp.fails(format('SELECT app.withdraw_document(%L, %L)', d1, 'no'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'with a reason');
  PERFORM app.withdraw_document(d1, 'Replaced by the new quality manual');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.documents WHERE id = d1) || '/' || (SELECT status FROM public.document_revisions WHERE id = r2) || '/' || (SELECT status FROM public.document_revisions WHERE id = r3),
    'withdrawn/withdrawn/draft', 'the revision in force is withdrawn; the draft is left alone');
  r := pg_temp.fails(format('SELECT app.withdraw_document(%L, %L)', d1, 'Again'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'only a document in force');
  -- revised back into use
  PERFORM app.set_document_signers(r3, ARRAY[dan], bob);
  PERFORM app.submit_document_revision(r3);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(dan); PERFORM app.review_document_revision(r3, true); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(bob); PERFORM app.approve_document_revision(r3, current_date); PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT status || '/' || coalesce(withdraw_reason, '-') FROM public.documents WHERE id = d1), 'active/-', 'back in force with rev C');
  PERFORM pg_temp.assert_eq((SELECT string_agg(letter || ':' || status, ',' ORDER BY sequence) FROM public.document_revisions WHERE document_id = d1), 'A:superseded,B:withdrawn,C:effective',
    'B stays withdrawn; C is in force');

  -- ---- the database holds the moves, for SQL too ----
  r := pg_temp.fails(format($f$UPDATE public.document_revisions SET status = 'draft' WHERE id = %L$f$, r3));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'an effective revision never returns to draft');
  r := pg_temp.fails(format($f$UPDATE public.document_revisions SET status = 'effective' WHERE id = %L$f$, r1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'a superseded revision is frozen');
  r := pg_temp.fails(format($f$UPDATE public.document_signoffs SET comment = 'changed' WHERE revision_id = %L AND decision <> 'pending'$f$, r1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'a decided sign-off is frozen');
  r := pg_temp.fails(format($f$DELETE FROM public.document_signoffs WHERE revision_id = %L$f$, r1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM025', 'sign-offs are never deleted');
  PERFORM pg_temp.login(eve);
  r := pg_temp.fails(format('SELECT app.start_document_revision(%L)', d1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'another organisation finds nothing');
  r := pg_temp.fails(format('SELECT app.settle_documents(%L)', org));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'nor settles it');
  PERFORM pg_temp.logout();
  SELECT count(*) INTO n FROM public.notifications WHERE entity_type = 'document_signoffs' AND recipient_user_id = ann;
  PERFORM pg_temp.assert_eq(n, 0::bigint, 'the author is never told about their own sign-off requests');
  PERFORM pg_temp.assert_eq(app.system_settle_documents(), 0, 'the cron finds nothing left to settle');
END $$;

ROLLBACK;
