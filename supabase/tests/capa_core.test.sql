-- CAPA1: starting an 8D (numbering, nine steps, creator as leader, prefill from an NC), header edits under RLS, team rules,
-- NC links (many-to-many, ended with a reason), step completion in order with the "still needed" list, reopening, cancel/reopen,
-- the closure rule on non-conformances, permissions and isolation between organisations.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('3f000000-0000-0000-0000-000000000301', 'owner@capa.test'),
  ('3f000000-0000-0000-0000-000000000302', 'eng@capa.test'),
  ('3f000000-0000-0000-0000-000000000303', 'viewer@capa.test'),
  ('3f000000-0000-0000-0000-000000000304', 'other@capa.test');
UPDATE public.profiles SET first_name = n, surname = 'Tester'
  FROM (VALUES ('3f000000-0000-0000-0000-000000000302'::uuid, 'Eve'), ('3f000000-0000-0000-0000-000000000303'::uuid, 'Vic')) v(id, n) WHERE profiles.id = v.id;

DO $$
DECLARE
  org uuid; org2 uuid; site uuid; eng_role uuid; viewer_role uuid; m_owner uuid; m_eng uuid; m_view uuid; m_other uuid;
  sup uuid; nc uuid; nc2 uuid; nc3 uuid; c uuid; c2 uuid; link uuid; link2 uuid; team uuid; ext uuid; v_ref text;
BEGIN
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000301');
  org := app.create_organisation('Capa Works', 'Plant A', 'PA', NULL);
  SELECT id INTO site FROM public.sites WHERE organisation_id = org;
  SELECT id INTO eng_role FROM public.roles WHERE organisation_id = org AND key = 'quality_engineer';
  SELECT id INTO viewer_role FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  SELECT id INTO m_owner FROM public.organisation_users WHERE organisation_id = org AND user_id = '3f000000-0000-0000-0000-000000000301';
  PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '3f000000-0000-0000-0000-000000000302', 'active') RETURNING id INTO m_eng;
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '3f000000-0000-0000-0000-000000000303', 'active') RETURNING id INTO m_view;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) VALUES (org, m_eng, eng_role), (org, m_view, viewer_role);

  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000304');
  org2 := app.create_organisation('Other Works', 'Plant B', 'PB', NULL);
  PERFORM pg_temp.logout();
  SELECT id INTO m_other FROM public.organisation_users WHERE organisation_id = org2 LIMIT 1;

  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000301');
  INSERT INTO public.suppliers (organisation_id, code, name) VALUES (org, 'BAR', 'Bar Co') RETURNING id INTO sup;
  INSERT INTO public.nonconformances (organisation_id, source, title, description, requirement, actual_result, severity, quantity_affected, site_id, supplier_id)
    VALUES (org, 'supplier', 'Cracked bar stock', 'Cracks found on lot 77', 'No visible cracks', '3 of 10 cracked', 'major', 3, site, sup) RETURNING id INTO nc;
  INSERT INTO public.nonconformances (organisation_id, source, title, description, severity, quantity_affected, site_id)
    VALUES (org, 'internal', 'Second NC', 'Second problem', 'minor', 1, site) RETURNING id INTO nc2;
  INSERT INTO public.nonconformances (organisation_id, source, title, description, severity, quantity_affected, site_id)
    VALUES (org, 'internal', 'Third NC', 'Third problem', 'minor', 1, site) RETURNING id INTO nc3;
  PERFORM pg_temp.logout();

  -- Starting: from an NC, which supplies the title, problem statement, source and severity; the creator leads.
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000301');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.start_capa(%L, NULL)$q$, org), 'a title or an NC is needed');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.capas (organisation_id, reference, title) VALUES (%L, 'CAPA-X', 'x')$q$, org), 'no direct insert');
  c := app.start_capa(org, NULL, NULL, NULL, NULL, nc);
  SELECT reference INTO v_ref FROM public.capas WHERE id = c;
  PERFORM pg_temp.assert_eq(v_ref, 'CAPA-000001', 'first reference');
  PERFORM pg_temp.assert_eq((SELECT (title, source, severity, stage)::text FROM public.capas WHERE id = c), '("8D: Cracked bar stock",supplier,major,open)', 'prefilled from the NC');
  PERFORM pg_temp.assert_eq((SELECT problem_statement FROM public.capas WHERE id = c), E'Cracks found on lot 77\nRequirement: No visible cracks\nActual: 3 of 10 cracked', 'problem statement from the NC');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.capa_steps WHERE capa_id = c), 9::bigint, 'nine steps');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.capa_steps WHERE capa_id = c AND completed_at IS NOT NULL), 0::bigint, 'none complete');
  PERFORM pg_temp.assert_eq((SELECT role FROM public.capa_team_members WHERE capa_id = c AND membership_id = m_owner), 'leader', 'the creator leads');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.capa_ncr_links WHERE capa_id = c AND nonconformance_id = nc AND ended_at IS NULL), 1::bigint, 'the NC is linked');
  PERFORM pg_temp.assert_eq((SELECT owner_membership_id FROM public.capas WHERE id = c), m_owner, 'the creator owns it');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.outbox_events WHERE event_type = 'capa.created' AND entity_id = c), 1::bigint, 'capa.created recorded');
  c2 := app.start_capa(org, 'Stand-alone 8D', 'Something went wrong', NULL, NULL, NULL);
  PERFORM pg_temp.assert_eq((SELECT reference FROM public.capas WHERE id = c2), 'CAPA-000002', 'numbers count up');
  PERFORM pg_temp.assert_eq((SELECT source FROM public.capas WHERE id = c2), 'internal', 'internal by default');
  PERFORM pg_temp.logout();

  -- Header edits under RLS: manage only, never the stage, nothing about identity.
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000302');
  PERFORM pg_temp.assert_eq(pg_temp.affected(format($q$UPDATE public.capas SET title = 'Cracked bar stock, lot 77', due_date = current_date + 30, severity = 'critical' WHERE id = %L$q$, c)), 1::bigint, 'an engineer edits the header');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.capas SET stage = 'closed' WHERE id = %L$q$, c), 'the stage is not editable');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.capas SET reference = 'CAPA-999999' WHERE id = %L$q$, c), 'the reference is not editable');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.capas SET owner_membership_id = %L WHERE id = %L$q$, m_other, c), 'the owner must be a member of this organisation');
  PERFORM pg_temp.assert_ok(format($q$UPDATE public.capas SET owner_membership_id = %L WHERE id = %L$q$, m_eng, c), 'the owner can be another member');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000303');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.capas), 2::bigint, 'a viewer reads 8Ds');
  PERFORM pg_temp.assert_eq(pg_temp.affected(format($q$UPDATE public.capas SET title = 'Hijacked' WHERE id = %L$q$, c)), 0::bigint, 'a viewer edits nothing');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.start_capa(%L, 'No')$q$, org), 'a viewer cannot start an 8D');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.link_capa_ncr(%L, %L)$q$, c, nc2), 'a viewer cannot link');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.capa_complete_step(%L, 'd0')$q$, c), 'a viewer cannot complete a step');
  PERFORM pg_temp.logout();

  -- Team: members and external contacts, one leader, no duplicates, ended people stay ended.
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000302');
  INSERT INTO public.capa_team_members (organisation_id, capa_id, membership_id, role) VALUES (org, c, m_eng, 'member') RETURNING id INTO team;
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.capa_team_members (organisation_id, capa_id, membership_id, role) VALUES (%L, %L, %L, 'member')$q$, org, c, m_eng), 'a person once');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.capa_team_members (organisation_id, capa_id, membership_id, role) VALUES (%L, %L, %L, 'leader')$q$, org, c, m_view), 'one leader');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.capa_team_members (organisation_id, capa_id, membership_id, external_name, role) VALUES (%L, %L, %L, 'Both', 'member')$q$, org, c, m_view), 'a member or an external contact, not both');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.capa_team_members (organisation_id, capa_id, role) VALUES (%L, %L, 'member')$q$, org, c), 'somebody must be named');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.capa_team_members (organisation_id, capa_id, membership_id, role) VALUES (%L, %L, %L, 'supplier_contact')$q$, org, c, m_view), 'a member cannot be a supplier contact');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.capa_team_members (organisation_id, capa_id, membership_id, role) VALUES (%L, %L, %L, 'member')$q$, org, c, m_other), 'only members of this organisation');
  INSERT INTO public.capa_team_members (organisation_id, capa_id, external_name, external_company, external_email, role)
    VALUES (org, c, 'Sam Supplier', 'Bar Co', 'sam@barco.test', 'supplier_contact') RETURNING id INTO ext;
  PERFORM pg_temp.assert_ok(format($q$UPDATE public.capa_team_members SET ended_at = now() WHERE id = %L$q$, ext), 'a person can leave');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.capa_team_members SET ended_at = NULL WHERE id = %L$q$, ext), 'and stays gone');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.capa_team_members SET role = 'member' WHERE id = %L$q$, ext), 'and is not changed afterwards');
  PERFORM pg_temp.assert_fails(format($q$DELETE FROM public.capa_team_members WHERE id = %L$q$, ext), 'never deleted');
  PERFORM pg_temp.logout();

  -- NC links: many NCs per 8D, one NC in several 8Ds, ended with a reason, never deleted.
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000302');
  link := app.link_capa_ncr(c, nc2);
  PERFORM pg_temp.assert_fails(format($q$SELECT app.link_capa_ncr(%L, %L)$q$, c, nc2), 'not twice');
  PERFORM app.link_capa_ncr(c2, nc2);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.capa_ncr_links WHERE nonconformance_id = nc2 AND ended_at IS NULL), 2::bigint, 'one NC can be in two 8Ds');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.link_capa_ncr(%L, %L)$q$, c, gen_random_uuid()), 'an NC that does not exist');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.unlink_capa_ncr(%L, ' ')$q$, link), 'a reason is needed');
  PERFORM app.unlink_capa_ncr(link, 'Linked by mistake');
  PERFORM pg_temp.assert_eq((SELECT (ended_at IS NOT NULL, end_reason)::text FROM public.capa_ncr_links WHERE id = link), '(t,"Linked by mistake")', 'ended with its reason');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.unlink_capa_ncr(%L, 'again')$q$, link), 'ended once');
  link2 := app.link_capa_ncr(c, nc2);
  PERFORM pg_temp.assert_eq(link2 <> link, true, 'it can be linked again, as a new link');
  PERFORM pg_temp.assert_fails(format($q$DELETE FROM public.capa_ncr_links WHERE id = %L$q$, link), 'never deleted');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.capa_ncr_links (organisation_id, capa_id, nonconformance_id) VALUES (%L, %L, %L)$q$, org, c, nc3), 'links are made by the function');
  PERFORM pg_temp.logout();

  -- Steps: the list of what is missing, completion in order, reopening cascades.
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000301');
  PERFORM pg_temp.assert_eq(app.capa_step_problems(c2, 'd0'), ARRAY[]::text[], 'D0 of 8D 2 is ready (it has a problem statement)');
  UPDATE public.capas SET problem_statement = NULL WHERE id = c2;
  PERFORM pg_temp.assert_eq(app.capa_step_problems(c2, 'd0'), ARRAY['Describe the problem in the problem statement'], 'D0 needs a problem statement');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.capa_complete_step(%L, 'd0')$q$, c2), 'D0 cannot be completed without it');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.capa_complete_step(%L, 'd1')$q$, c), 'D1 before D0');
  PERFORM app.capa_complete_step(c, 'd0', '  Scope agreed  ');
  PERFORM pg_temp.assert_eq((SELECT note FROM public.capa_steps WHERE capa_id = c AND step = 'd0'), 'Scope agreed', 'note kept');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.capa_complete_step(%L, 'd0')$q$, c), 'D0 only once');
  PERFORM pg_temp.assert_eq(app.capa_step_problems(c, 'd1'), ARRAY[]::text[], 'D1 is ready: a leader and two people');
  PERFORM pg_temp.assert_eq(app.capa_step_problems(c2, 'd1'), ARRAY['Add at least two people to the team'], 'one person is not a team');
  PERFORM pg_temp.assert_eq(app.capa_step_problems(c, 'd2'), ARRAY['This step is not available yet'], 'later steps arrive in later slices');
  PERFORM app.capa_complete_step(c, 'd1');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.capa_reopen_step(%L, 'd0', ' ')$q$, c), 'a reason to reopen');
  PERFORM app.capa_reopen_step(c, 'd0', 'The scope changed');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.capa_steps WHERE capa_id = c AND completed_at IS NOT NULL), 0::bigint, 'reopening D0 reopens D1 too');
  PERFORM pg_temp.assert_eq((SELECT reopen_reason FROM public.capa_steps WHERE capa_id = c AND step = 'd1'), 'Reopened with D0: The scope changed', 'and says why');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.capa_reopen_step(%L, 'd0', 'again')$q$, c), 'only a complete step can be reopened');
  PERFORM pg_temp.assert_fails($q$UPDATE public.capa_steps SET completed_at = now()$q$, 'steps are written by functions');
  PERFORM pg_temp.logout();

  -- Closing an NC is refused while a linked 8D is running, allowed once the 8D is cancelled or the link ends.
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000301');
  UPDATE public.nonconformances SET stage = 'open' WHERE id = nc;
  UPDATE public.nonconformances SET stage = 'open' WHERE id = nc2;
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.nonconformances SET stage = 'closed' WHERE id = %L$q$, nc), 'a running 8D blocks closing the NC');
  PERFORM app.cancel_capa(c, 'Raised in error');
  PERFORM pg_temp.assert_ok(format($q$UPDATE public.nonconformances SET stage = 'closed' WHERE id = %L$q$, nc), 'a cancelled 8D no longer blocks closing');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.nonconformances SET stage = 'closed' WHERE id = %L$q$, nc2), 'the other running 8D still blocks the second NC');
  PERFORM app.unlink_capa_ncr((SELECT id FROM public.capa_ncr_links WHERE capa_id = c2 AND nonconformance_id = nc2 AND ended_at IS NULL), 'Not related after all');
  PERFORM pg_temp.assert_ok(format($q$UPDATE public.nonconformances SET stage = 'closed' WHERE id = %L$q$, nc2), 'an ended link no longer blocks closing');
  PERFORM pg_temp.logout();

  -- Cancel and reopen: a reason each way, a cancelled 8D keeps its content and team, and reopening runs it again.
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000301');
  PERFORM pg_temp.assert_eq((SELECT (stage, stage_reason)::text FROM public.capas WHERE id = c), '(cancelled,"Raised in error")', 'cancelled with its reason');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.capas SET title = 'Edited while cancelled' WHERE id = %L$q$, c), 'a cancelled 8D cannot be edited');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.link_capa_ncr(%L, %L)$q$, c, nc3), 'or linked');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.cancel_capa(%L, 'again')$q$, c), 'or cancelled again');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.reopen_capa(%L, ' ')$q$, c), 'a reason to reopen');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.reopen_capa(%L, 'no')$q$, c2), 'a running 8D cannot be reopened');
  PERFORM app.reopen_capa(c, 'It was needed after all');
  PERFORM pg_temp.assert_eq((SELECT stage FROM public.capas WHERE id = c), 'open', 'reopened');
  PERFORM pg_temp.assert_ok(format($q$UPDATE public.capas SET title = 'Edited after reopening' WHERE id = %L$q$, c), 'and editable again');
  PERFORM pg_temp.logout();

  -- Isolation: another organisation sees and changes nothing.
  PERFORM pg_temp.login('3f000000-0000-0000-0000-000000000304');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.capas), 0::bigint, 'isolation: 8Ds');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.capa_steps), 0::bigint, 'isolation: steps');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.capa_team_members), 0::bigint, 'isolation: team');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.capa_ncr_links), 0::bigint, 'isolation: links');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.link_capa_ncr(%L, %L)$q$, c, nc3), 'isolation: cannot link into another organisation''s 8D');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.start_capa(%L, 'Foreign')$q$, org), 'isolation: cannot start an 8D in another organisation');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.start_capa(%L, 'From a foreign NC', NULL, NULL, NULL, %L)$q$, org2, nc), 'isolation: cannot start from another organisation''s NC');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.capa_step_problems(%L, 'd0')$q$, c), 'isolation: the checklist is private too');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
