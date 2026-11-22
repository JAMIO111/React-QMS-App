-- External portal PT2 (docs/external-portal-plan.md): sharing an NC and an 8D with a party, the curated view (named fields only), the conversation,
-- who has seen it, withdrawing, and that nobody else (another party, another organisation, a member without the permission) reaches any of it.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
  ('5d000000-0000-0000-0000-000000000f01', 'ann@pt2.test', now()), ('5d000000-0000-0000-0000-000000000f02', 'insp@pt2.test', now()),
  ('5d000000-0000-0000-0000-000000000f03', 'eng@pt2.test', now()), ('5d000000-0000-0000-0000-000000000f04', 'sam@acme.pt2.test', now()),
  ('5d000000-0000-0000-0000-000000000f05', 'ben@bolt.pt2.test', now()), ('5d000000-0000-0000-0000-000000000f06', 'eve@pt2.test', now());

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '5d000000-0000-0000-0000-000000000f01'; insp uuid := '5d000000-0000-0000-0000-000000000f02'; eng uuid := '5d000000-0000-0000-0000-000000000f03';
  sam uuid := '5d000000-0000-0000-0000-000000000f04'; ben uuid := '5d000000-0000-0000-0000-000000000f05'; eve uuid := '5d000000-0000-0000-0000-000000000f06';
  org uuid; org2 uuid; site uuid; acme uuid; bolt uuid; cus uuid; p_acme uuid; p_bolt uuid; a_sam uuid; a_ben uuid;
  nc uuid; nc_draft uuid; nc_bolt uuid; capa uuid; sh uuid; sh_capa uuid; cm uuid; cm2 uuid; r text; j jsonb; k text;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('PT2 Alpha'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve); org2 := app.create_organisation('PT2 Beta'); PERFORM pg_temp.logout();
  SELECT id INTO site FROM public.sites WHERE organisation_id = org LIMIT 1;
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, insp, 'active'), (org, eng, 'active');
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, ou.id, (SELECT id FROM public.roles WHERE organisation_id = org AND key = CASE ou.user_id WHEN insp THEN 'inspector' ELSE 'quality_engineer' END)
      FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id IN (insp, eng);
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'ACME', 'Acme Castings'), (org, 'BOLT', 'Bolt Ltd');
  INSERT INTO public.customers (organisation_id, code, name) VALUES (org, 'BIG', 'Big Customer');
  SELECT id INTO acme FROM public.suppliers WHERE organisation_id = org AND code = 'ACME';
  SELECT id INTO bolt FROM public.suppliers WHERE organisation_id = org AND code = 'BOLT';

  -- The portal: on, two parties, Sam the admin at Acme and Ben at Bolt (two-factor off for this test).
  PERFORM pg_temp.login(ann);
  PERFORM app.set_portal_settings(org, true, NULL, false);
  p_acme := app.set_portal_party(org, 'supplier', acme, true, 'Pat in Quality');
  p_bolt := app.set_portal_party(org, 'supplier', bolt, true);
  a_sam := app.invite_external_user(p_acme, 'sam@acme.pt2.test', 'admin', NULL);
  a_ben := app.invite_external_user(p_bolt, 'ben@bolt.pt2.test', 'admin', NULL);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(sam); PERFORM app.accept_portal_invitation(a_sam); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(ben); PERFORM app.accept_portal_invitation(a_ben); PERFORM pg_temp.logout();

  -- An NC naming Acme with containment (one done, one cancelled), an approved and a proposed disposition, and a cost (which must never show).
  INSERT INTO public.nonconformances (organisation_id, reference, source, stage, category_id, title, description, requirement, actual_result, severity, quantity_affected, quantity_inspected, site_id, supplier_id, lot_number, purchase_order)
    VALUES (org, 'PT2-NC-1', 'supplier', 'open', pg_temp.cat(org), 'Cracked bar stock', 'Cracks found', 'No visible cracks', '3 of 10 cracked', 'major', 10, 10, site, acme, 'LOT-77', 'PO-1')
    RETURNING id INTO nc;
  INSERT INTO public.nonconformances (organisation_id, reference, source, title, severity, quantity_affected, site_id, supplier_id) VALUES (org, 'PT2-NC-2', 'supplier', 'Draft NC', 'minor', 1, site, acme) RETURNING id INTO nc_draft;
  INSERT INTO public.nonconformances (organisation_id, reference, source, stage, category_id, title, severity, quantity_affected, site_id, supplier_id)
    VALUES (org, 'PT2-NC-3', 'supplier', 'open', pg_temp.cat(org), 'Bolt NC', 'minor', 1, site, bolt) RETURNING id INTO nc_bolt;
  INSERT INTO public.ncr_containment_actions (organisation_id, nonconformance_id, kind, description, status, done_note, done_at)
    VALUES (org, nc, 'quarantine', 'Quarantine lot 77', 'done', 'Lot quarantined in the cage', now());
  INSERT INTO public.ncr_containment_actions (organisation_id, nonconformance_id, kind, description, status, cancel_reason) VALUES (org, nc, 'sort', 'Sort stock', 'cancelled', 'not needed');
  INSERT INTO public.ncr_dispositions (organisation_id, nonconformance_id, decision, quantity, instructions, status, approved_at) VALUES (org, nc, 'return_to_supplier', 5, 'Return the cracked bars', 'approved', now());
  INSERT INTO public.ncr_dispositions (organisation_id, nonconformance_id, decision, quantity, instructions) VALUES (org, nc, 'scrap', 2, 'Proposed only');
  INSERT INTO public.ncr_costs (organisation_id, nonconformance_id, cost_type, currency, amount) VALUES (org, nc, 'scrap', 'GBP', 99);

  -- ---- who may share ----
  PERFORM pg_temp.login(insp);
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'external_access.share'), false, 'an inspector may not share');
  r := pg_temp.fails(format($f$SELECT app.share_with_portal('ncr', %L, %L)$f$, nc, p_acme));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'and is refused');
  r := pg_temp.fails(format($f$SELECT * FROM app.list_portal_shares('ncr', %L)$f$, nc));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'nor sees the shares');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login(eng);
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'external_access.share'), true, 'a quality engineer may');
  PERFORM pg_temp.assert_eq((SELECT array_agg(party_name) FROM app.portal_eligible_parties('ncr', nc)), ARRAY['Acme Castings'], 'only the supplier the NC names is offered');
  r := pg_temp.fails(format($f$SELECT app.share_with_portal('ncr', %L, %L)$f$, nc, p_bolt));
  PERFORM pg_temp.assert_eq(r LIKE 'QM032%only with a supplier or customer it names%', true, 'not with a party it does not name');
  r := pg_temp.fails(format($f$SELECT app.share_with_portal('ncr', %L, %L)$f$, nc_draft, p_acme));
  PERFORM pg_temp.assert_eq(r LIKE 'QM032%Open it first%', true, 'a draft cannot be shared');
  sh := app.share_with_portal('ncr', nc, p_acme);
  r := pg_temp.fails(format($f$SELECT app.share_with_portal('ncr', %L, %L)$f$, nc, p_acme));
  PERFORM pg_temp.assert_eq(r LIKE 'QM032%already shared%', true, 'not twice');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.portal_eligible_parties('ncr', nc)), 0::bigint, 'nobody left to offer it to');
  r := pg_temp.fails(format($f$UPDATE public.portal_shares SET party_id = %L WHERE id = %L$f$, p_bolt, sh));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'a share is not a table write');
  PERFORM pg_temp.logout();

  -- ---- an 8D: only through a linked NC that names the party ----
  PERFORM pg_temp.login(ann);
  capa := app.start_capa(org, NULL, NULL, NULL, NULL, nc);
  PERFORM pg_temp.assert_eq((SELECT array_agg(party_name) FROM app.portal_eligible_parties('capa', capa)), ARRAY['Acme Castings'], 'the 8D can go to the party of its NC');
  sh_capa := app.share_with_portal('capa', capa, p_acme);
  PERFORM pg_temp.logout();

  -- ---- the party's view: the list, then the curated NC ----
  PERFORM pg_temp.login(sam);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.portal_list_shares(org)), 2::bigint, 'Sam sees both shared records');
  PERFORM pg_temp.assert_eq((SELECT bool_or(viewed) FROM app.portal_list_shares(org)), false, 'neither seen yet');
  j := app.portal_get_ncr(sh);
  PERFORM pg_temp.assert_eq((SELECT string_agg(key, ',' ORDER BY key COLLATE "C") FROM jsonb_object_keys(j) AS key),
    'actualResult,contact,containment,customerReference,description,detectedAt,disposition,lotNumber,partName,partNumber,partRevision,purchaseOrder,quantityAffected,quantityInspected,reference,requirement,serialNumber,severity,sharedAt,stage,title',
    'exactly the agreed fields of an NC and nothing else');
  PERFORM pg_temp.assert_eq(j ->> 'title', 'Cracked bar stock', 'the title');
  PERFORM pg_temp.assert_eq(jsonb_array_length(j -> 'containment'), 1, 'cancelled containment is left out');
  PERFORM pg_temp.assert_eq(j -> 'containment' -> 0 ->> 'resultNote', 'Lot quarantined in the cage', 'a done action shows its result');
  PERFORM pg_temp.assert_eq(jsonb_array_length(j -> 'disposition'), 1, 'only the approved disposition');
  PERFORM pg_temp.assert_eq(j -> 'disposition' -> 0 ->> 'decision', 'return_to_supplier', 'the approved one');
  PERFORM pg_temp.assert_eq(j ->> 'contact', 'Pat in Quality', 'the contact name chosen for them');
  PERFORM pg_temp.assert_eq(j::text LIKE '%99%', false, 'no cost');
  j := app.portal_get_capa(sh_capa);
  PERFORM pg_temp.assert_eq((SELECT string_agg(key, ',' ORDER BY key COLLATE "C") FROM jsonb_object_keys(j) AS key),
    'closedAt,contact,containment,correctiveActions,lessonsLearned,noContainmentReason,noPreventiveReason,preventiveActions,problem,problemStatement,reference,rootCauses,severity,sharedAt,stage,teamSize,title,verification',
    'exactly the agreed fields of an 8D');
  r := pg_temp.fails(format($f$SELECT app.portal_get_ncr(%L)$f$, sh_capa));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'an 8D share is not an NC');
  -- Nothing underneath is readable by tables.
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.portal_shares) + (SELECT count(*) FROM public.portal_comments) + (SELECT count(*) FROM public.nonconformances), 0::bigint, 'no table reads for an external person');
  PERFORM app.portal_mark_viewed(sh);
  PERFORM pg_temp.assert_eq((SELECT viewed FROM app.portal_list_shares(org) WHERE share_id = sh), true, 'seen');
  PERFORM pg_temp.logout();
  -- One transaction has one clock: let Sam's first look be an hour ago, so a comment written now is newer than it.
  UPDATE public.portal_views SET last_viewed_at = now() - interval '1 hour' WHERE share_id = sh;

  -- ---- another party and another organisation reach nothing ----
  PERFORM pg_temp.login(ben);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.portal_list_shares(org)), 0::bigint, 'Ben has no shares');
  FOREACH k IN ARRAY ARRAY['portal_get_ncr', 'portal_mark_viewed', 'portal_share_comments'] LOOP
    r := pg_temp.fails(format('SELECT * FROM app.%I(%L)', k, sh));
    PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'Ben cannot reach Acme''s share through ' || k);
  END LOOP;
  r := pg_temp.fails(format($f$SELECT app.add_portal_comment(%L, 'hello')$f$, sh));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'nor comment on it');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.portal_shares) + (SELECT count(*) FROM public.portal_comments) + (SELECT count(*) FROM public.portal_views), 0::bigint, 'another organisation reads nothing');
  r := pg_temp.fails(format($f$SELECT * FROM app.list_portal_shares('ncr', %L)$f$, nc));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'nor lists our shares');
  r := pg_temp.fails(format($f$SELECT app.withdraw_portal_share(%L, 'not yours')$f$, sh));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'nor withdraws one');
  PERFORM pg_temp.logout();

  -- ---- the conversation ----
  PERFORM pg_temp.login(eng);
  cm := app.add_portal_comment(sh, 'Please confirm lot 77 is quarantined at your end');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(sam);
  PERFORM pg_temp.assert_eq((SELECT new_comments FROM app.portal_list_shares(org) WHERE share_id = sh), 1, 'one new comment since Sam last looked');
  PERFORM pg_temp.assert_eq((SELECT author_name FROM app.portal_share_comments(sh)), 'PT2 Alpha', 'staff show as the organisation, never by name');
  PERFORM app.portal_mark_viewed(sh);
  PERFORM pg_temp.assert_eq((SELECT new_comments FROM app.portal_list_shares(org) WHERE share_id = sh), 0, 'looked at, so not new any more');
  cm2 := app.add_portal_comment(sh, 'Confirmed, the lot is held in our cage');
  PERFORM pg_temp.assert_eq((SELECT can_withdraw FROM app.portal_share_comments(sh) WHERE comment_id = cm2), true, 'Sam may withdraw his own within ten minutes');
  PERFORM pg_temp.assert_eq((SELECT can_withdraw FROM app.portal_share_comments(sh) WHERE comment_id = cm), false, 'but not the organisation''s');
  r := pg_temp.fails(format($f$SELECT app.withdraw_portal_comment(%L)$f$, cm));
  PERFORM pg_temp.assert_eq(r LIKE 'QM032%only your own%', true, 'refused');
  r := pg_temp.fails(format($f$UPDATE public.portal_comments SET body = 'x' WHERE id = %L$f$, cm2));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'no table edits');
  r := pg_temp.fails(format($f$SELECT app.add_portal_comment(%L, '   ')$f$, sh));
  PERFORM pg_temp.assert_eq(r LIKE 'QM032%1 to 4,000%', true, 'an empty comment');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eng);
  PERFORM pg_temp.assert_eq((SELECT author_name FROM app.portal_share_comments(sh) WHERE side = 'external'), 'sam (Acme Castings)', 'staff see the person and the company');
  PERFORM pg_temp.assert_eq((SELECT viewers || '|' || external_comments FROM app.list_portal_shares('ncr', nc)), '1|1', 'viewed by one person, one reply');
  PERFORM pg_temp.assert_eq((SELECT first_viewed_at IS NOT NULL FROM app.list_portal_shares('ncr', nc)), true, 'with when');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.portal_share_recipients(sh)), 1::bigint, 'the party''s active people are the email recipients');
  PERFORM pg_temp.logout();
  -- Ten minutes: after that a comment is permanent.
  UPDATE public.portal_comments SET created_at = now() - interval '11 minutes' WHERE id = cm2;
  PERFORM pg_temp.login(sam);
  r := pg_temp.fails(format($f$SELECT app.withdraw_portal_comment(%L)$f$, cm2));
  PERFORM pg_temp.assert_eq(r LIKE 'QM032%within ten minutes%', true, 'too late');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eng);
  cm2 := app.add_portal_comment(sh, 'Oops, wrong lot');
  PERFORM app.withdraw_portal_comment(cm2);
  PERFORM pg_temp.assert_eq((SELECT withdrawn FROM app.portal_share_comments(sh) WHERE comment_id = cm2), true, 'withdrawn keeps its place');
  PERFORM pg_temp.assert_eq((SELECT body IS NULL FROM app.portal_share_comments(sh) WHERE comment_id = cm2), true, 'but not its words');
  PERFORM pg_temp.logout();

  -- ---- withdrawing the share ends it at once ----
  PERFORM pg_temp.login(eng);
  r := pg_temp.fails(format($f$SELECT app.withdraw_portal_share(%L, 'x')$f$, sh));
  PERFORM pg_temp.assert_eq(r LIKE 'QM032%reason%', true, 'a reason is needed');
  PERFORM app.withdraw_portal_share(sh, 'Shared by mistake');
  PERFORM pg_temp.assert_eq((SELECT withdrawn_reason FROM app.list_portal_shares('ncr', nc)), 'Shared by mistake', 'kept with its reason');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.portal_share_comments(sh)), 3::bigint, 'staff still read the thread');
  r := pg_temp.fails(format($f$SELECT app.add_portal_comment(%L, 'still there?')$f$, sh));
  PERFORM pg_temp.assert_eq(r LIKE 'QM032%no longer shared%', true, 'no new comments on a withdrawn share');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(sam);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.portal_list_shares(org)), 1::bigint, 'only the 8D is left');
  r := pg_temp.fails(format($f$SELECT app.portal_get_ncr(%L)$f$, sh));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'the NC is gone for Sam');
  r := pg_temp.fails(format($f$SELECT * FROM app.portal_share_comments(%L)$f$, sh));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'and so is its thread');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eng);
  sh := app.share_with_portal('ncr', nc, p_acme);
  PERFORM pg_temp.assert_eq(sh IS NOT NULL, true, 'it can be shared again');
  PERFORM pg_temp.logout();

  -- ---- switching the party or the portal off ends it too ----
  PERFORM pg_temp.login(ann);
  PERFORM app.set_portal_party(org, 'supplier', acme, false);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(sam);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.portal_list_shares(org)), 0::bigint, 'the party switched off: nothing is listed');
  r := pg_temp.fails(format($f$SELECT app.portal_get_capa(%L)$f$, sh_capa));
  PERFORM pg_temp.assert_eq(left(r, 5), 'P0002', 'nor readable');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
