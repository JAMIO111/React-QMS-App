-- External portal PT3a (docs/external-portal-plan.md): a supplier sees and answers the SCARs raised against it, through the same rows the staff functions
-- write, and nobody else (another supplier, another organisation, a member) reaches them. Staff are told when a supplier acts.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
  ('5e000000-0000-0000-0000-000000000f01', 'ann@pt3.test', now()), ('5e000000-0000-0000-0000-000000000f02', 'insp@pt3.test', now()),
  ('5e000000-0000-0000-0000-000000000f04', 'sam@acme.pt3.test', now()), ('5e000000-0000-0000-0000-000000000f05', 'ben@bolt.pt3.test', now()),
  ('5e000000-0000-0000-0000-000000000f06', 'eve@pt3.test', now());

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '5e000000-0000-0000-0000-000000000f01'; insp uuid := '5e000000-0000-0000-0000-000000000f02';
  sam uuid := '5e000000-0000-0000-0000-000000000f04'; ben uuid := '5e000000-0000-0000-0000-000000000f05'; eve uuid := '5e000000-0000-0000-0000-000000000f06';
  org uuid; org2 uuid; site uuid; acme uuid; bolt uuid; p_acme uuid; p_bolt uuid; a_sam uuid; a_ben uuid; nc uuid; sc uuid; sc2 uuid; ext uuid; ext2 uuid; f1 uuid; f2 uuid; i integer; f record; r text; j jsonb; k text;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('PT3 Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('PT3 Beta'); PERFORM pg_temp.logout();
  SELECT id INTO site FROM public.sites WHERE organisation_id = org LIMIT 1;
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
  a_sam := app.invite_external_user(p_acme, 'sam@acme.pt3.test', 'admin', NULL);
  a_ben := app.invite_external_user(p_bolt, 'ben@bolt.pt3.test', 'admin', NULL);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(sam); PERFORM app.accept_portal_invitation(a_sam); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ben); PERFORM app.accept_portal_invitation(a_ben); PERFORM pg_temp.logout();
  INSERT INTO public.nonconformances (organisation_id, reference, source, stage, category_id, title, severity, quantity_affected, site_id, supplier_id)
    VALUES (org, 'PT3-NC-1', 'supplier', 'open', pg_temp.cat(org), 'Cracked bar stock', 'major', 10, site, acme) RETURNING id INTO nc;

  -- ---- a draft is never shown ----
  PERFORM pg_temp.login(ann);
  sc := (app.create_supplier_scar(acme, 'Cracked castings', 'Cracks in the bar stock', 'major', current_date + 14, NULL, ARRAY[nc], NULL, NULL) ->> 'id')::uuid;
  PERFORM app.update_supplier_scar(sc, '{"requirementBreached":"No visible cracks","objectiveEvidence":"3 of 10 cracked","containmentRequirements":"Sort the stock"}'::jsonb);
  PERFORM app.add_scar_item(sc, '{"material":"Bar stock","quantity":"10","notes":"Whole delivery"}'::jsonb);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(sam);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.portal_list_scars(org)), 0::bigint, 'a draft SCAR is not listed');
  r := pg_temp.fails(format($f$SELECT app.portal_get_scar(%L)$f$, sc));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'nor readable');
  r := pg_temp.fails(format($f$SELECT app.portal_acknowledge_scar(%L)$f$, sc));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'nor acknowledged');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login(ann); PERFORM app.issue_supplier_scar(sc); PERFORM pg_temp.logout();

  -- ---- who sees it, and exactly what ----
  PERFORM pg_temp.login(sam);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.portal_list_scars(org)), 1::bigint, 'Sam sees the issued SCAR');
  PERFORM pg_temp.assert_eq((SELECT awaiting_response FROM app.portal_list_scars(org)), true, 'awaiting a response');
  j := app.portal_get_scar(sc);
  SELECT string_agg(key, ',' ORDER BY key COLLATE "C") INTO k FROM jsonb_object_keys(j) key;
  PERFORM pg_temp.assert_eq(k, 'canAcknowledge,canRequestExtension,canRespond,cancelReason,contact,containmentRequirements,draftFiles,extensions,issuedAt,items,objectiveEvidence,originalResponseDueOn,overdue,problemDescription,reference,requirementBreached,responseDueOn,responses,severity,status,title',
                            'the external view is these named fields and nothing else');
  PERFORM pg_temp.assert_eq(j ->> 'contact', 'Pat in Quality', 'the contact they are given');
  PERFORM pg_temp.assert_eq(jsonb_array_length(j -> 'items'), 1, 'what is affected');
  PERFORM pg_temp.assert_eq((j ->> 'canAcknowledge')::boolean, true, 'can acknowledge');
  r := pg_temp.fails(format($f$UPDATE public.supplier_scars SET status = 'closed' WHERE id = %L$f$, sc));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a supplier writes no table');
  r := pg_temp.fails(format($f$SELECT count(*) FROM public.supplier_scars WHERE id = %L$f$, sc));
  PERFORM pg_temp.assert_eq(pg_temp.count_rows(format($f$SELECT 1 FROM public.supplier_scars WHERE id = %L$f$, sc)), 0::bigint, 'and reads none directly either');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login(ben);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.portal_list_scars(org)), 0::bigint, 'another supplier sees none');
  r := pg_temp.fails(format($f$SELECT app.portal_get_scar(%L)$f$, sc));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'cannot read it');
  r := pg_temp.fails(format($f$SELECT app.portal_respond_scar(%L, 'root cause here', NULL, 'fix it here', NULL, NULL)$f$, sc));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'cannot answer it');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.portal_list_scars(org)), 0::bigint, 'another organisation sees none');
  r := pg_temp.fails(format($f$SELECT app.portal_get_scar(%L)$f$, sc));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'cannot read it either');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(insp);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.portal_list_scars(org)), 0::bigint, 'a member has no portal access');
  r := pg_temp.fails(format($f$SELECT app.portal_acknowledge_scar(%L)$f$, sc));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'and cannot use the supplier functions');
  r := pg_temp.fails(format($f$SELECT * FROM app.portal_scar_recipients(%L)$f$, sc));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'nor the staff recipients list') ;
  PERFORM pg_temp.logout();

  -- ---- acknowledge ----
  PERFORM pg_temp.login(sam);
  PERFORM app.portal_acknowledge_scar(sc, 'We have it');
  r := pg_temp.fails(format($f$SELECT app.portal_acknowledge_scar(%L)$f$, sc));
  PERFORM pg_temp.assert_eq(r LIKE 'QM032%', true, 'not twice');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT to_status FROM public.supplier_scar_status_history WHERE scar_id = sc ORDER BY changed_at DESC LIMIT 1), 'acknowledged', 'the status history says so');

  -- ---- respond ----
  PERFORM pg_temp.login(sam);
  r := pg_temp.fails(format($f$SELECT app.portal_respond_scar(%L, 'x', NULL, 'fix it here', NULL, NULL)$f$, sc));
  PERFORM pg_temp.assert_eq(r LIKE 'QM032%root cause%', true, 'a root cause is needed');
  r := pg_temp.fails(format($f$SELECT app.portal_respond_scar(%L, 'root cause here', NULL, 'fix it here', NULL, current_date - 1)$f$, sc));
  PERFORM pg_temp.assert_eq(r LIKE 'QM032%past%', true, 'a completion date in the past is refused');
  -- ---- evidence files: unsent first, then sent with the response ----
  PERFORM pg_temp.assert_eq(app.portal_scar_upload_allowed(sc, org || '/scar/' || sc || '/a.pdf'), true, 'the supplier may upload into the SCAR''s own folder');
  PERFORM pg_temp.assert_eq(app.portal_scar_upload_allowed(sc, org || '/scar/' || gen_random_uuid() || '/a.pdf'), false, 'not into another SCAR''s folder');
  PERFORM pg_temp.assert_eq(app.portal_scar_upload_allowed(sc, org || '/ncr/' || sc || '/a.pdf'), false, 'nor another kind of folder');
  PERFORM pg_temp.assert_eq(app.portal_scar_upload_allowed(sc, org || '/scar/' || sc || '/../a.pdf'), false, 'nor up and out of it');
  f1 := app.portal_add_scar_file(sc, org || '/scar/' || sc || '/1-a.pdf', 'a.pdf', 'application/pdf', 1000);
  f2 := app.portal_add_scar_file(sc, org || '/scar/' || sc || '/2-b.pdf', 'b.pdf', 'application/pdf', 2000);
  r := pg_temp.fails(format($f$SELECT app.portal_add_scar_file(%L, %L, 'c.pdf', NULL, 1)$f$, sc, org || '/scar/' || gen_random_uuid() || '/c.pdf'));
  PERFORM pg_temp.assert_eq(r LIKE 'QM032%folder%', true, 'a path outside the folder is refused');
  r := pg_temp.fails(format($f$SELECT app.portal_add_scar_file(%L, %L, 'c.pdf', NULL, 26214401)$f$, sc, org || '/scar/' || sc || '/3-c.pdf'));
  PERFORM pg_temp.assert_eq(r LIKE 'QM032%25 MB%', true, 'over 25 MB is refused');
  PERFORM pg_temp.assert_eq(jsonb_array_length(app.portal_get_scar(sc) -> 'draftFiles'), 2, 'unsent files are listed');
  PERFORM pg_temp.assert_eq(app.portal_remove_scar_file(f2), sc, 'an unsent file can be taken back');
  r := pg_temp.fails(format($f$SELECT app.portal_remove_scar_file(%L)$f$, f2));
  PERFORM pg_temp.assert_eq(r LIKE 'QM032%already removed%', true, 'once');
  FOR i IN 1..9 LOOP PERFORM app.portal_add_scar_file(sc, org || '/scar/' || sc || '/x' || i || '.pdf', 'x.pdf', NULL, 1); END LOOP;
  r := pg_temp.fails(format($f$SELECT app.portal_add_scar_file(%L, %L, 'x.pdf', NULL, 1)$f$, sc, org || '/scar/' || sc || '/x10.pdf'));
  PERFORM pg_temp.assert_eq(r LIKE 'QM032%At most ten%', true, 'at most ten wait to be sent');
  PERFORM pg_temp.assert_eq(app.portal_scar_upload_allowed(sc, org || '/scar/' || sc || '/x10.pdf'), false, 'and the upload check says the same');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ben);
  r := pg_temp.fails(format($f$SELECT app.portal_add_scar_file(%L, %L, 'z.pdf', NULL, 1)$f$, sc, org || '/scar/' || sc || '/z.pdf'));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'another supplier cannot add');
  r := pg_temp.fails(format($f$SELECT * FROM app.portal_scar_file_path(%L)$f$, f1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'nor open');
  r := pg_temp.fails(format($f$SELECT app.portal_remove_scar_file(%L)$f$, f1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'nor take back');
  PERFORM pg_temp.assert_eq(app.portal_scar_upload_allowed(sc, org || '/scar/' || sc || '/z.pdf'), false, 'nor pass the upload check');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(sam);
  FOR f IN SELECT (e ->> 'id')::uuid AS id FROM jsonb_array_elements(app.portal_get_scar(sc) -> 'draftFiles') e WHERE e ->> 'fileName' = 'x.pdf' LOOP PERFORM app.portal_remove_scar_file(f.id); END LOOP;
  PERFORM pg_temp.assert_eq(jsonb_array_length(app.portal_get_scar(sc) -> 'draftFiles'), 1, 'only the first file is left to send');
  PERFORM pg_temp.assert_eq((SELECT storage_path FROM app.portal_scar_file_path(f1)), org || '/scar/' || sc || '/1-a.pdf', 'the supplier can open their own file');
  r := pg_temp.fails(format($f$SELECT * FROM app.portal_scar_file_path(%L)$f$, f2));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'but not one taken back');
  PERFORM app.portal_respond_scar(sc, 'Mould temperature too low', 'Stock sorted', 'Raise the mould temperature and add a check', NULL, current_date + 7, 'Other lots checked', 'Final inspection', 'Pat', 'five_whys');
  PERFORM pg_temp.assert_eq((SELECT status FROM app.portal_list_scars(org)), 'response_received', 'it now waits for review');
  r := pg_temp.fails(format($f$SELECT app.portal_respond_scar(%L, 'root cause here', NULL, 'fix it here', NULL, NULL)$f$, sc));
  PERFORM pg_temp.assert_eq(r LIKE 'QM032%while the SCAR is response received%', true, 'no second answer while it is being reviewed');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT responded_by_name LIKE '%(Acme Castings)' FROM public.supplier_scar_responses WHERE scar_id = sc AND seq = 1), true, 'the response names the supplier and the person');
  PERFORM pg_temp.assert_eq((SELECT responded_on FROM public.supplier_scar_responses WHERE scar_id = sc AND seq = 1), current_date, 'dated today');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.supplier_scar_files WHERE scar_id = sc AND response_id IS NOT NULL AND removed_at IS NULL), 1::bigint, 'the unsent file went with the response');
  r := pg_temp.fails(format($f$UPDATE public.supplier_scar_files SET removed_at = now() WHERE id = %L$f$, f1));
  PERFORM pg_temp.assert_eq(r LIKE '%sent with a response%', true, 'and is kept as it was sent');
  r := pg_temp.fails(format($f$DELETE FROM public.supplier_scar_files WHERE id = %L$f$, f1));
  PERFORM pg_temp.assert_eq(r LIKE '%never deleted%', true, 'never deleted');
  PERFORM pg_temp.login(sam);
  j := app.portal_get_scar(sc);
  PERFORM pg_temp.assert_eq(j -> 'responses' -> 0 -> 'files' -> 0 ->> 'fileName', 'a.pdf', 'the response lists its file');
  PERFORM pg_temp.assert_eq(jsonb_array_length(j -> 'draftFiles'), 0, 'nothing is left unsent');
  r := pg_temp.fails(format($f$SELECT app.portal_remove_scar_file(%L)$f$, f1));
  PERFORM pg_temp.assert_eq(r LIKE 'QM032%stays with it%', true, 'a sent file cannot be taken back');
  PERFORM pg_temp.assert_eq(app.storage_file_allowed('scar-files', org || '/scar/' || sc || '/1-a.pdf', false), false, 'a supplier does not read the bucket directly');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq(app.storage_file_allowed('scar-files', org || '/scar/' || sc || '/1-a.pdf', false), true, 'staff may read it');
  PERFORM pg_temp.assert_eq(app.storage_file_allowed('scar-files', org || '/scar/' || sc || '/1-a.pdf', true), false, 'nobody writes the bucket directly');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.supplier_scar_files WHERE scar_id = sc), 11::bigint, 'staff see every file row, removed ones included');
  PERFORM pg_temp.logout();

  -- ---- staff review it; a revision is asked for and the supplier answers again ----
  PERFORM pg_temp.login(ann);
  PERFORM app.start_scar_review(sc);
  PERFORM app.review_scar_response(sc, 'revision_requested', 'Show the evidence of the new check');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(sam);
  j := app.portal_get_scar(sc);
  PERFORM pg_temp.assert_eq(j -> 'responses' -> 0 -> 'review' ->> 'decision', 'revision_requested', 'the review shows');
  PERFORM pg_temp.assert_eq(j -> 'responses' -> 0 -> 'review' ->> 'note', 'Show the evidence of the new check', 'with its note');
  PERFORM pg_temp.assert_eq((j ->> 'canRespond')::boolean, true, 'and they can answer again');
  PERFORM app.portal_respond_scar(sc, 'Mould temperature too low', NULL, 'Temperature check recorded each shift, evidence attached', NULL, NULL);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.supplier_scar_responses WHERE scar_id = sc), 2::bigint, 'two responses are kept');

  -- ---- more time ----
  PERFORM pg_temp.login(ann);
  sc2 := (app.create_supplier_scar(acme, 'Late deliveries', 'Three late deliveries', 'minor', current_date + 5, NULL, ARRAY[nc], NULL, NULL) ->> 'id')::uuid;
  PERFORM app.issue_supplier_scar(sc2);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(sam);
  r := pg_temp.fails(format($f$SELECT app.portal_request_scar_extension(%L, current_date + 2, 'we need longer')$f$, sc2));
  PERFORM pg_temp.assert_eq(r LIKE 'QM032%later%', true, 'the new date must be later');
  r := pg_temp.fails(format($f$SELECT app.portal_request_scar_extension(%L, current_date + 12, 'x')$f$, sc2));
  PERFORM pg_temp.assert_eq(r LIKE 'QM032%why%', true, 'a reason is needed');
  ext := app.portal_request_scar_extension(sc2, current_date + 12, 'Parts are on a slow boat');
  PERFORM pg_temp.assert_eq((app.portal_get_scar(sc2) ->> 'responseDueOn')::date = current_date + 5, true, 'the date has not moved');
  r := pg_temp.fails(format($f$SELECT app.portal_request_scar_extension(%L, current_date + 13, 'again please')$f$, sc2));
  PERFORM pg_temp.assert_eq(r LIKE 'QM032%already waiting%', true, 'one request at a time');
  PERFORM pg_temp.assert_eq((SELECT bool_and(canrequest) FROM (SELECT (app.portal_get_scar(sc2) ->> 'canRequestExtension')::boolean AS canrequest) q), false, 'the page stops offering it');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ben);
  r := pg_temp.fails(format($f$SELECT app.portal_withdraw_scar_extension(%L, 'not mine to withdraw')$f$, ext));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'another supplier cannot take it back');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(sam);
  PERFORM app.portal_withdraw_scar_extension(ext, 'Found a faster route');
  ext2 := app.portal_request_scar_extension(sc2, current_date + 14, 'After all, the boat is late');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT status FROM public.supplier_scar_extensions WHERE id = ext), 'withdrawn', 'withdrawn by the one who asked');
  PERFORM pg_temp.login(ann);
  PERFORM app.decide_scar_extension(ext2, true, 'Agreed, once');
  PERFORM pg_temp.assert_eq((SELECT response_due_on FROM public.supplier_scars WHERE id = sc2) = current_date + 14, true, 'approving moves the date, as for any extension');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(sam);
  PERFORM pg_temp.assert_eq((app.portal_get_scar(sc2) -> 'extensions' -> 1 ->> 'decisionNote'), 'Agreed, once', 'Sam sees the decision and its note');
  PERFORM pg_temp.logout();

  -- ---- staff are told ----
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.portal_activity WHERE organisation_id = org), 6::bigint, 'six things the supplier did were noted');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.notifications n WHERE n.organisation_id = org AND n.entity_type = 'portal_activity'), 6::bigint, 'and each reached the notification path');
  PERFORM pg_temp.assert_eq((SELECT message FROM public.portal_activity WHERE kind = 'scar_response' ORDER BY created_at LIMIT 1), 'Sent response 1 for review', 'in words');
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.portal_activity), 6::bigint, 'the owner reads the activity');
  PERFORM pg_temp.assert_eq((SELECT array_agg(email ORDER BY email) FROM app.portal_scar_recipients(sc)), ARRAY['sam@acme.pt3.test'], 'and the people to email are the party''s');
  r := pg_temp.fails($f$UPDATE public.portal_activity SET message = 'changed'$f$);
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'activity is not written by hand');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(insp);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.portal_activity), 0::bigint, 'an inspector does not');
  PERFORM pg_temp.logout();

  -- ---- a closed SCAR stays visible; switching the party off ends it ----
  PERFORM pg_temp.login(ann);
  PERFORM app.set_portal_party(org, 'supplier', acme, false);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(sam);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.portal_list_scars(org)), 0::bigint, 'the party switched off: nothing is listed');
  r := pg_temp.fails(format($f$SELECT app.portal_get_scar(%L)$f$, sc));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'nor readable');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
