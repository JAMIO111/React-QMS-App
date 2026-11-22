-- External portal PT3c (docs/external-portal-plan.md): a document in force and a quality alert in force can be shared with a party, who reads the curated
-- view (named fields only), opens the document's files and acknowledges once per person and revision; staff see who did. Nobody else reaches any of it.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
  ('5f000000-0000-0000-0000-000000000f01', 'ann@pt3c.test', now()), ('5f000000-0000-0000-0000-000000000f02', 'insp@pt3c.test', now()),
  ('5f000000-0000-0000-0000-000000000f04', 'sam@acme.pt3c.test', now()), ('5f000000-0000-0000-0000-000000000f05', 'ben@bolt.pt3c.test', now()),
  ('5f000000-0000-0000-0000-000000000f06', 'eve@pt3c.test', now()), ('5f000000-0000-0000-0000-000000000f07', 'sue@acme.pt3c.test', now());

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '5f000000-0000-0000-0000-000000000f01'; insp uuid := '5f000000-0000-0000-0000-000000000f02';
  sam uuid := '5f000000-0000-0000-0000-000000000f04'; ben uuid := '5f000000-0000-0000-0000-000000000f05'; eve uuid := '5f000000-0000-0000-0000-000000000f06';
  sue uuid := '5f000000-0000-0000-0000-000000000f07';
  org uuid; org2 uuid; acme uuid; bolt uuid; p_acme uuid; p_bolt uuid; a_sam uuid; a_ben uuid; a_sue uuid; ext uuid; d1 uuid; r1 uuid; r2 uuid; f1 uuid; f_old uuid;
  qa uuid; sd uuid; sa uuid; sd_bolt uuid; j jsonb; k text; r text;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('PT3c Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('PT3c Beta'); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, insp, 'active');
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = 'inspector') FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id = insp;
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'ACME', 'Acme Castings'), (org, 'BOLT', 'Bolt Ltd');
  SELECT id INTO acme FROM public.suppliers WHERE organisation_id = org AND code = 'ACME';
  SELECT id INTO bolt FROM public.suppliers WHERE organisation_id = org AND code = 'BOLT';
  PERFORM pg_temp.login(ann);
  PERFORM app.set_portal_settings(org, true, NULL, false);
  p_acme := app.set_portal_party(org, 'supplier', acme, true, 'Pat in Quality');
  p_bolt := app.set_portal_party(org, 'supplier', bolt, true);
  a_sam := app.invite_external_user(p_acme, 'sam@acme.pt3c.test', 'admin', NULL);
  a_sue := app.invite_external_user(p_acme, 'sue@acme.pt3c.test', 'member', NULL);
  a_ben := app.invite_external_user(p_bolt, 'ben@bolt.pt3c.test', 'admin', NULL);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(sam); PERFORM app.accept_portal_invitation(a_sam); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(sue); PERFORM app.accept_portal_invitation(a_sue); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ben); PERFORM app.accept_portal_invitation(a_ben); PERFORM pg_temp.logout();

  -- A document in force (an external specification: a file, recorded as issued) and a quality alert in force.
  PERFORM pg_temp.login(ann);
  SELECT id INTO ext FROM public.document_types WHERE organisation_id = org AND prefix = 'EXT';
  d1 := app.create_external_document(org, jsonb_build_object('typeId', ext, 'title', 'Packing specification', 'issuer', 'Alpha', 'externalReference', 'PS-1'));
  SELECT id INTO r1 FROM public.document_revisions WHERE document_id = d1;
  PERFORM app.add_document_file(r1, 'main', org || '/document/' || r1 || '/ps.pdf', 'ps.pdf', 'application/pdf', 1000);
  PERFORM app.issue_external_revision(r1, 'Issue 1', current_date - 1);
  INSERT INTO public.quality_alerts (organisation_id, title, category, severity) VALUES (org, 'Cracks in bar stock', 'supplier', 'high') RETURNING id INTO qa;
  PERFORM app.set_quality_alert_scope(qa, jsonb_build_object('targets', jsonb_build_array(jsonb_build_object('membershipId', (SELECT id FROM public.organisation_users WHERE organisation_id = org AND user_id = insp)))));
  UPDATE public.quality_alerts SET description = 'Cracks found in lot 77', required_action = 'a', effective_date = current_date, acknowledge_by = current_date + 5 WHERE id = qa;
  PERFORM app.set_quality_alert_actions(qa, '[{"description":"Sort your stock"},{"description":"Tell us the lots"}]'::jsonb);
  PERFORM app.issue_quality_alert(qa);
  PERFORM pg_temp.logout();

  -- ---- sharing: staff only, anything in force, any party with the portal on ----
  PERFORM pg_temp.login(insp);
  r := pg_temp.fails(format($f$SELECT app.share_with_portal('document', %L, %L)$f$, d1, p_acme));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'an inspector may not share a document');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq((SELECT array_agg(party_name ORDER BY party_name) FROM app.portal_eligible_parties('document', d1)), ARRAY['Acme Castings', 'Bolt Ltd'], 'any party with the portal on is offered');
  sd := app.share_with_portal('document', d1, p_acme);
  sd_bolt := app.share_with_portal('document', d1, p_bolt);
  sa := app.share_with_portal('quality_alert', qa, p_acme);
  r := pg_temp.fails(format($f$SELECT app.share_with_portal('document', %L, %L)$f$, d1, p_acme));
  PERFORM pg_temp.assert_eq(r LIKE 'QM032%already shared%', true, 'not twice');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.list_portal_shares('document', d1)), 2::bigint, 'staff list the shares of a document');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.list_portal_shares('quality_alert', qa)), 1::bigint, 'and of an alert');
  PERFORM pg_temp.logout();

  -- ---- what the party sees ----
  PERFORM pg_temp.login(sam);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.portal_list_shares(org)), 2::bigint, 'Sam lists the document and the alert');
  PERFORM pg_temp.assert_eq((SELECT array_agg(share_id ORDER BY share_id) FROM app.portal_pending_acknowledgements(org)), (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY[sd, sa]) x), 'both wait for him');
  j := app.portal_get_document(sd);
  SELECT string_agg(key, ',' ORDER BY key COLLATE "C") INTO k FROM jsonb_object_keys(j) key;
  PERFORM pg_temp.assert_eq(k, 'acknowledgedAt,body,canAcknowledge,changeSummary,contact,contentKind,description,effectiveFrom,files,number,revision,sharedAt,title,type', 'the document view is these named fields only');
  PERFORM pg_temp.assert_eq(j ->> 'number', 'EXT-001', 'its number');
  PERFORM pg_temp.assert_eq(j ->> 'revision', 'A', 'the revision in force');
  PERFORM pg_temp.assert_eq(j -> 'files' -> 0 ->> 'fileName', 'ps.pdf', 'its file');
  f1 := (j -> 'files' -> 0 ->> 'id')::uuid;
  j := app.portal_get_quality_alert(sa);
  SELECT string_agg(key, ',' ORDER BY key COLLATE "C") INTO k FROM jsonb_object_keys(j) key;
  PERFORM pg_temp.assert_eq(k, 'acknowledgeBy,acknowledgedAt,actions,canAcknowledge,category,contact,description,effectiveDate,expiryDate,reference,revision,severity,sharedAt,status,title', 'the alert view is these named fields only');
  PERFORM pg_temp.assert_eq(jsonb_array_length(j -> 'actions'), 2, 'what is asked of them');
  PERFORM pg_temp.assert_eq(j -> 'actions' -> 0 ? 'machineId', false, 'no machines or departments');
  r := pg_temp.fails(format($f$SELECT app.portal_get_document(%L)$f$, sa));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'an alert is not a document');
  PERFORM pg_temp.assert_eq((SELECT storage_path FROM app.portal_document_file_path(sd, f1)), org || '/document/' || r1 || '/ps.pdf', 'he can open the document''s file');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login(ben);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.portal_list_shares(org)), 1::bigint, 'Bolt sees only what was shared with Bolt');
  r := pg_temp.fails(format($f$SELECT app.portal_get_document(%L)$f$, sd));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'not Acme''s share');
  r := pg_temp.fails(format($f$SELECT app.portal_get_quality_alert(%L)$f$, sa));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'nor Acme''s alert');
  r := pg_temp.fails(format($f$SELECT app.portal_acknowledge_share(%L)$f$, sd));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'nor acknowledge it');
  r := pg_temp.fails(format($f$SELECT * FROM app.portal_document_file_path(%L, %L)$f$, sd, f1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'nor open its file');
  r := pg_temp.fails(format($f$SELECT * FROM app.portal_document_file_path(%L, %L)$f$, sd_bolt, gen_random_uuid()));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'and a file of another document is no file of his');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve);
  r := pg_temp.fails(format($f$SELECT app.portal_get_quality_alert(%L)$f$, sa));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'another organisation sees nothing');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(insp);
  r := pg_temp.fails(format($f$SELECT app.portal_acknowledge_share(%L)$f$, sd));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'a member has no portal access, so cannot use the party''s functions');
  PERFORM pg_temp.logout();

  -- ---- acknowledging: once per person and revision ----
  PERFORM pg_temp.login(sam);
  PERFORM app.portal_acknowledge_share(sd, 'Read and understood');
  PERFORM pg_temp.assert_eq((app.portal_get_document(sd) ->> 'canAcknowledge')::boolean, false, 'it is then acknowledged');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.portal_pending_acknowledgements(org)), 1::bigint, 'one thing is left');
  r := pg_temp.fails(format($f$SELECT app.portal_acknowledge_share(%L)$f$, sd));
  PERFORM pg_temp.assert_eq(r LIKE 'QM032%already acknowledged%', true, 'not twice');
  PERFORM app.portal_acknowledge_share(sa);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(sue);
  PERFORM pg_temp.assert_eq((app.portal_get_document(sd) ->> 'canAcknowledge')::boolean, true, 'a colleague still has to acknowledge for herself');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq((SELECT acknowledged FROM app.portal_ack_summary('document', d1) WHERE share_id = sd), 1, 'staff see one of the party''s people');
  PERFORM pg_temp.assert_eq((SELECT people FROM app.portal_ack_summary('document', d1) WHERE share_id = sd), 2, 'of two');
  PERFORM pg_temp.assert_eq((SELECT person_name || ':' || coalesce(note, '') FROM app.portal_share_acknowledgements(sd)), 'sam:Read and understood', 'and who, with their note');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.portal_activity WHERE organisation_id = org AND kind = 'acknowledged'), 2::bigint, 'staff were told twice');
  r := pg_temp.fails($f$UPDATE public.portal_acknowledgements SET note = 'x'$f$);
  PERFORM pg_temp.assert_eq(r LIKE '%never changed%' OR left(r, 5) = '42501', true, 'an acknowledgement is never changed');

  -- ---- a new revision asks again ----
  UPDATE public.document_revisions SET status = 'superseded' WHERE id = r1;
  INSERT INTO public.document_revisions (organisation_id, document_id, sequence, letter, status, author_id, change_summary, approved_at, effective_from)
    VALUES (org, d1, 2, 'B', 'effective', ann, 'Tighter tolerance', now(), current_date) RETURNING id INTO r2;
  UPDATE public.documents SET current_revision_id = r2 WHERE id = d1;
  PERFORM pg_temp.login(sam);
  j := app.portal_get_document(sd);
  PERFORM pg_temp.assert_eq(j ->> 'revision', 'B', 'the new revision is what he sees');
  PERFORM pg_temp.assert_eq((j ->> 'canAcknowledge')::boolean, true, 'and he is asked again');
  PERFORM pg_temp.assert_eq(jsonb_array_length(j -> 'files'), 0, 'with its own files (none yet)');
  r := pg_temp.fails(format($f$SELECT * FROM app.portal_document_file_path(%L, %L)$f$, sd, f1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'a file of the old revision can no longer be opened');
  PERFORM app.portal_acknowledge_share(sd);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.portal_acknowledgements WHERE share_id = sd), 2::bigint, 'both revisions are on record');

  -- ---- an alert that is no longer in force cannot be acknowledged; withdrawing hides it ----
  PERFORM pg_temp.login(ann);
  PERFORM app.withdraw_portal_share(sd_bolt, 'Not for Bolt');
  PERFORM app.withdraw_quality_alert(qa, 'Issued in error');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(sue);
  r := pg_temp.fails(format($f$SELECT app.portal_acknowledge_share(%L)$f$, sa));
  PERFORM pg_temp.assert_eq(r LIKE 'QM032%no longer in force%', true, 'a withdrawn alert cannot be acknowledged');
  PERFORM pg_temp.assert_eq((app.portal_get_quality_alert(sa) ->> 'canAcknowledge')::boolean, false, 'and the view says so');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ben);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.portal_list_shares(org)), 0::bigint, 'a withdrawn share is gone for the party');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
