-- External portal PT3d (docs/external-portal-plan.md): staff set actions on a SCAR; the supplier's people see them (named fields only), complete them with a
-- result note, and nobody else can. Staff rules: open actions only change, cancel needs a reason, a finished one is reopened with a reason, nothing is deleted.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
  ('5d000000-0000-0000-0000-000000000f01', 'ann@pt3d.test', now()), ('5d000000-0000-0000-0000-000000000f02', 'insp@pt3d.test', now()),
  ('5d000000-0000-0000-0000-000000000f04', 'sam@acme.pt3d.test', now()), ('5d000000-0000-0000-0000-000000000f05', 'ben@bolt.pt3d.test', now()),
  ('5d000000-0000-0000-0000-000000000f06', 'eve@pt3d.test', now());

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '5d000000-0000-0000-0000-000000000f01'; insp uuid := '5d000000-0000-0000-0000-000000000f02';
  sam uuid := '5d000000-0000-0000-0000-000000000f04'; ben uuid := '5d000000-0000-0000-0000-000000000f05'; eve uuid := '5d000000-0000-0000-0000-000000000f06';
  org uuid; org2 uuid; site uuid; acme uuid; bolt uuid; p_acme uuid; p_bolt uuid; a_sam uuid; a_ben uuid; nc uuid; sc uuid; ac1 uuid; ac2 uuid; ac3 uuid; r text; j jsonb; k text;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('PT3d Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('PT3d Beta'); PERFORM pg_temp.logout();
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
  a_sam := app.invite_external_user(p_acme, 'sam@acme.pt3d.test', 'admin', NULL);
  a_ben := app.invite_external_user(p_bolt, 'ben@bolt.pt3d.test', 'admin', NULL);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(sam); PERFORM app.accept_portal_invitation(a_sam); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ben); PERFORM app.accept_portal_invitation(a_ben); PERFORM pg_temp.logout();
  INSERT INTO public.nonconformances (organisation_id, reference, source, stage, category_id, title, severity, quantity_affected, site_id, supplier_id)
    VALUES (org, 'PT3D-NC-1', 'supplier', 'open', pg_temp.cat(org), 'Cracked bar stock', 'major', 10, site, acme) RETURNING id INTO nc;

  -- ---- staff add actions, even on a draft; the supplier sees none until the SCAR is issued ----
  PERFORM pg_temp.login(ann);
  sc := (app.create_supplier_scar(acme, 'Cracked castings', 'Cracks in the bar stock', 'major', current_date + 14, NULL, ARRAY[nc], NULL, NULL) ->> 'id')::uuid;
  ac1 := app.add_scar_action(sc, 'Sort the stock in your warehouse', current_date + 7);
  ac2 := app.add_scar_action(sc, 'Send us the heat treatment records', NULL);
  ac3 := app.add_scar_action(sc, 'Re-inspect the next three lots', current_date + 30);
  r := pg_temp.fails(format($f$SELECT app.add_scar_action(%L, 'xx', NULL)$f$, sc));
  PERFORM pg_temp.assert_eq(r LIKE 'QM020%', true, 'a short description is refused');
  r := pg_temp.fails(format($f$SELECT app.add_scar_action(%L, 'Fix it by yesterday', current_date - 1)$f$, sc));
  PERFORM pg_temp.assert_eq(r LIKE 'QM020%', true, 'a date in the past is refused');
  PERFORM app.update_scar_action(ac3, 'Re-inspect the next five lots', current_date + 30);
  PERFORM app.issue_supplier_scar(sc);
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login(insp);
  r := pg_temp.fails(format($f$SELECT app.add_scar_action(%L, 'An inspector cannot ask this', NULL)$f$, sc));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'an inspector may not add actions');
  r := pg_temp.fails(format($f$SELECT app.cancel_scar_action(%L, 'not mine to cancel')$f$, ac2));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'nor cancel them');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve);
  r := pg_temp.fails(format($f$SELECT app.add_scar_action(%L, 'From another organisation', NULL)$f$, sc));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'another organisation cannot reach the SCAR');
  PERFORM pg_temp.logout();

  -- ---- what the supplier sees ----
  PERFORM pg_temp.login(sam);
  j := app.portal_get_scar(sc);
  SELECT string_agg(key, ',' ORDER BY key COLLATE "C") INTO k FROM jsonb_object_keys(j) key;
  PERFORM pg_temp.assert_eq(k, 'actions,canAcknowledge,canRequestExtension,canRespond,cancelReason,contact,containmentRequirements,draftFiles,extensions,issuedAt,items,objectiveEvidence,originalResponseDueOn,overdue,problemDescription,reference,requirementBreached,responseDueOn,responses,severity,status,title',
                            'the external view is these named fields and nothing else');
  PERFORM pg_temp.assert_eq(jsonb_array_length(j -> 'actions'), 3, 'three actions');
  SELECT string_agg(key, ',' ORDER BY key COLLATE "C") INTO k FROM jsonb_object_keys(j -> 'actions' -> 0) key;
  PERFORM pg_temp.assert_eq(k, 'canComplete,completedAt,completedBy,description,dueOn,id,overdue,resultNote,status', 'an action shows these fields only (no who set it)');
  PERFORM pg_temp.assert_eq(j -> 'actions' -> 0 ->> 'description', 'Sort the stock in your warehouse', 'soonest due first');
  PERFORM pg_temp.assert_eq((SELECT open_actions FROM app.portal_scar_action_counts(org) WHERE scar_id = sc), 3, 'three open for the home page');
  r := pg_temp.fails(format($f$UPDATE public.supplier_scar_actions SET status = 'done' WHERE id = %L$f$, ac1));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a supplier writes no table');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ben);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.portal_scar_action_counts(org)), 0::bigint, 'another supplier sees no counts');
  r := pg_temp.fails(format($f$SELECT app.portal_complete_scar_action(%L, 'done by the wrong supplier')$f$, ac1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'and cannot complete the action');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(insp);
  r := pg_temp.fails(format($f$SELECT app.portal_complete_scar_action(%L, 'a member is not the supplier')$f$, ac1));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'a member has no supplier access either');
  PERFORM pg_temp.logout();

  -- ---- the supplier completes one ----
  PERFORM pg_temp.login(sam);
  r := pg_temp.fails(format($f$SELECT app.portal_complete_scar_action(%L, 'ok')$f$, ac1));
  PERFORM pg_temp.assert_eq(r LIKE 'QM032%', true, 'a result note is needed');
  PERFORM pg_temp.assert_eq(app.portal_complete_scar_action(ac1, 'Sorted 480 pieces, 31 scrapped'), sc, 'completing answers with the SCAR');
  r := pg_temp.fails(format($f$SELECT app.portal_complete_scar_action(%L, 'again please')$f$, ac1));
  PERFORM pg_temp.assert_eq(r LIKE 'QM032%already done%', true, 'only once');
  j := app.portal_get_scar(sc);
  PERFORM pg_temp.assert_eq(j -> 'actions' -> 2 ->> 'status', 'done', 'finished actions go last');
  PERFORM pg_temp.assert_eq(j -> 'actions' -> 2 ->> 'resultNote', 'Sorted 480 pieces, 31 scrapped', 'with their note');
  PERFORM pg_temp.assert_eq((j -> 'actions' -> 2 ->> 'canComplete')::boolean, false, 'nothing more to do');
  PERFORM pg_temp.assert_eq((SELECT open_actions FROM app.portal_scar_action_counts(org) WHERE scar_id = sc), 2, 'two are left');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.portal_activity WHERE kind = 'scar_action_done' AND record_id = sc), 1::bigint, 'staff are told');

  -- ---- staff rules on what is finished or cancelled ----
  PERFORM pg_temp.login(ann);
  r := pg_temp.fails(format($f$SELECT app.update_scar_action(%L, 'Change a finished action', NULL)$f$, ac1));
  PERFORM pg_temp.assert_eq(r LIKE 'QM020%', true, 'a finished action is not edited');
  r := pg_temp.fails(format($f$SELECT app.cancel_scar_action(%L, 'cancel a finished action')$f$, ac1));
  PERFORM pg_temp.assert_eq(r LIKE 'QM020%', true, 'nor cancelled');
  r := pg_temp.fails(format($f$SELECT app.cancel_scar_action(%L, 'no')$f$, ac2));
  PERFORM pg_temp.assert_eq(r LIKE 'QM020%', true, 'a cancel needs a real reason');
  PERFORM app.cancel_scar_action(ac2, 'We already hold them');
  r := pg_temp.fails(format($f$SELECT app.reopen_scar_action(%L, 'reopen a cancelled one')$f$, ac2));
  PERFORM pg_temp.assert_eq(r LIKE 'QM020%', true, 'a cancelled action stays cancelled');
  PERFORM app.reopen_scar_action(ac1, 'The count does not match the delivery note');
  PERFORM pg_temp.assert_eq((SELECT status FROM public.supplier_scar_actions WHERE id = ac1), 'open', 'a finished action can be reopened');
  PERFORM pg_temp.assert_eq((SELECT result_note FROM public.supplier_scar_actions WHERE id = ac1) IS NULL, true, 'and its note is cleared');
  r := pg_temp.fails(format($f$DELETE FROM public.supplier_scar_actions WHERE id = %L$f$, ac1));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'nothing is deleted, even by staff');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(sam);
  PERFORM pg_temp.assert_eq(jsonb_array_length(app.portal_get_scar(sc) -> 'actions'), 2, 'a cancelled action is not shown to the supplier');
  PERFORM pg_temp.logout();

  -- ---- a closed SCAR keeps its actions as they were ----
  PERFORM pg_temp.login(ann);
  PERFORM app.cancel_supplier_scar(sc, 'Raised against the wrong supplier');
  r := pg_temp.fails(format($f$SELECT app.add_scar_action(%L, 'Too late to add this', NULL)$f$, sc));
  PERFORM pg_temp.assert_eq(r LIKE 'QM020%', true, 'no new action on a cancelled SCAR');
  r := pg_temp.fails(format($f$SELECT app.cancel_scar_action(%L, 'too late to cancel it')$f$, ac3));
  PERFORM pg_temp.assert_eq(r LIKE 'QM020%', true, 'nor any change');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(sam);
  r := pg_temp.fails(format($f$SELECT app.portal_complete_scar_action(%L, 'complete on a cancelled request')$f$, ac3));
  PERFORM pg_temp.assert_eq(r LIKE 'P0002%' OR r LIKE 'QM032%', true, 'the supplier cannot complete one on a cancelled SCAR');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.portal_scar_action_counts(org)), 0::bigint, 'and the home page counts nothing');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
