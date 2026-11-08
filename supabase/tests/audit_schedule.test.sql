-- Audits, AU2: the schedule — slots generated from the frequency (calendar rhythm, month-end clamping, weekdays only), nothing before the audit existed, idempotent generation, a changed
-- frequency removing only future slots, retired and on-demand audits, skipping with a reason, and who may do what.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('38000000-0000-0000-0000-000000000701', 'owner@sch.test'), ('38000000-0000-0000-0000-000000000702', 'inspector@sch.test'), ('38000000-0000-0000-0000-000000000703', 'other@sch.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;
CREATE FUNCTION pg_temp.due(p_def uuid) RETURNS date[] LANGUAGE sql AS $$ SELECT coalesce(array_agg(due_on ORDER BY due_on), ARRAY[]::date[]) FROM public.audit_occurrences WHERE audit_definition_id = p_def $$;

DO $$
DECLARE
  u_owner uuid := '38000000-0000-0000-0000-000000000701'; u_insp uuid := '38000000-0000-0000-0000-000000000702'; u_other uuid := '38000000-0000-0000-0000-000000000703';
  org uuid; org2 uuid; m uuid; w1 uuid; w2 uuid; occ2 uuid; mo uuid; wd uuid; dy uuid; od uuid; rt uuid; ch uuid; n int; occ uuid; sat date; r text;
BEGIN
  PERFORM pg_temp.login(u_owner);
  org := app.create_organisation('Schedule Works', 'Plant A', 'PA', NULL);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_other);
  org2 := app.create_organisation('Other Works', 'Plant B', 'PB', NULL);
  PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u_insp, 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'inspector';

  -- Pure date maths (an internal helper, so run by the test owner): the same day each month, clamped to the end of a shorter month, computed from the first date.
  PERFORM pg_temp.assert_eq(app.audit_due_date('monthly', NULL, DATE '2026-01-31', 1), DATE '2026-02-28', 'monthly clamps to February');
  PERFORM pg_temp.assert_eq(app.audit_due_date('monthly', NULL, DATE '2026-01-31', 2), DATE '2026-03-31', 'and comes back to the 31st (from the first date, not the clamped one)');
  PERFORM pg_temp.assert_eq(app.audit_due_date('monthly', NULL, DATE '2028-01-31', 1), DATE '2028-02-29', 'a leap year');
  PERFORM pg_temp.assert_eq(app.audit_due_date('quarterly', NULL, DATE '2026-11-30', 1), DATE '2027-02-28', 'quarterly');
  PERFORM pg_temp.assert_eq(app.audit_due_date('six_monthly', NULL, DATE '2026-08-31', 1), DATE '2027-02-28', 'six-monthly');
  PERFORM pg_temp.assert_eq(app.audit_due_date('yearly', NULL, DATE '2024-02-29', 1), DATE '2025-02-28', 'yearly from a leap day');
  PERFORM pg_temp.assert_eq(app.audit_due_date('every_n_days', 10, DATE '2026-01-01', 3), DATE '2026-01-31', 'every ten days');
  PERFORM pg_temp.assert_eq(app.audit_due_date('daily', NULL, DATE '2026-01-01', 5), DATE '2026-01-06', 'daily');
  PERFORM pg_temp.login(u_owner);

  INSERT INTO public.audit_definitions (organisation_id, title, audit_type, frequency_kind, first_due_on) VALUES (org, 'Weekly, defined long ago', 'process', 'weekly', current_date - 21) RETURNING id INTO w1;
  INSERT INTO public.audit_definitions (organisation_id, title, audit_type, frequency_kind, first_due_on) VALUES (org, 'Weekly, defined today', 'process', 'weekly', current_date - 21) RETURNING id INTO w2;
  INSERT INTO public.audit_definitions (organisation_id, title, audit_type, frequency_kind, first_due_on) VALUES (org, 'Monthly', 'process', 'monthly', current_date + 3) RETURNING id INTO mo;
  sat := current_date + ((6 - extract(dow FROM current_date)::int + 7) % 7) + 7;
  INSERT INTO public.audit_definitions (organisation_id, title, audit_type, frequency_kind, first_due_on, weekdays_only) VALUES (org, 'Weekly on Saturdays', 'process', 'weekly', sat, true) RETURNING id INTO wd;
  INSERT INTO public.audit_definitions (organisation_id, title, audit_type, frequency_kind, first_due_on, weekdays_only) VALUES (org, 'Daily', 'process', 'daily', current_date, true) RETURNING id INTO dy;
  INSERT INTO public.audit_definitions (organisation_id, title, audit_type, frequency_kind) VALUES (org, 'On demand', 'other', 'on_demand') RETURNING id INTO od;
  INSERT INTO public.audit_definitions (organisation_id, title, audit_type, frequency_kind, first_due_on) VALUES (org, 'To be retired', 'process', 'weekly', current_date) RETURNING id INTO rt;
  INSERT INTO public.audit_definitions (organisation_id, title, audit_type, frequency_kind, first_due_on) VALUES (org, 'Changes rhythm', 'process', 'weekly', current_date - 14) RETURNING id INTO ch;
  PERFORM pg_temp.logout();
  -- One of them was defined a month ago.
  UPDATE public.audit_definitions SET created_at = now() - interval '30 days' WHERE id IN (w1, ch);

  PERFORM pg_temp.login(u_owner);
  n := app.generate_audit_occurrences(org, current_date + 28);
  PERFORM pg_temp.assert_eq(pg_temp.due(w1), ARRAY(SELECT current_date - 21 + 7 * g FROM generate_series(0, 7) g), 'a weekly audit defined long ago has its past slots (they can be missed) and the coming ones');
  PERFORM pg_temp.assert_eq(pg_temp.due(w2), ARRAY(SELECT current_date + 7 * g FROM generate_series(0, 4) g), 'one defined today has no slot before today: it cannot be missed before it existed');
  PERFORM pg_temp.assert_eq(pg_temp.due(mo), ARRAY[current_date + 3], 'a monthly audit, from its first due date (the next one is beyond the horizon)');
  PERFORM pg_temp.assert_eq(pg_temp.due(od), ARRAY[]::date[], 'an audit done on demand has no slots');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_occurrences WHERE audit_definition_id = dy AND extract(dow FROM due_on) IN (0, 6)), 0::bigint, 'a weekdays-only daily audit has no weekend slot');
  PERFORM pg_temp.assert_eq((SELECT count(*) > 15 FROM public.audit_occurrences WHERE audit_definition_id = dy), true, 'but does have the weekdays');
  PERFORM pg_temp.assert_eq((pg_temp.due(wd))[1], sat + 2, 'a Saturday slot moves to the Monday');
  PERFORM pg_temp.assert_eq(n, (SELECT count(*)::int FROM public.audit_occurrences WHERE organisation_id = org), 'generation says how many it added');
  PERFORM pg_temp.assert_eq(app.generate_audit_occurrences(org, current_date + 28), 0, 'generating again adds nothing');

  -- Retiring stops new slots and keeps the old ones.
  PERFORM app.retire_audit_definition(rt, 'No longer needed');
  PERFORM pg_temp.assert_eq(array_length(pg_temp.due(rt), 1) > 0, true, 'a retired audit keeps its slots');
  n := app.generate_audit_occurrences(org, current_date + 70);
  PERFORM pg_temp.assert_eq((pg_temp.due(rt))[array_length(pg_temp.due(rt), 1)] <= current_date + 28, true, 'but gets no new ones');
  PERFORM pg_temp.assert_eq((pg_temp.due(w2))[array_length(pg_temp.due(w2), 1)] > current_date + 63, true, 'while the others reach further as the horizon moves');

  -- A changed rhythm removes future slots only.
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_occurrences WHERE audit_definition_id = ch AND due_on <= current_date), 3::bigint, 'two weeks of past slots and today');
  UPDATE public.audit_definitions SET frequency_kind = 'monthly', first_due_on = current_date + 40 WHERE id = ch;
  PERFORM app.generate_audit_occurrences(org, current_date + 70);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_occurrences WHERE audit_definition_id = ch AND due_on <= current_date), 3::bigint, 'the past stays');
  PERFORM pg_temp.assert_eq((pg_temp.due(ch))[4], current_date + 40, 'and the future follows the new rhythm');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_occurrences WHERE audit_definition_id = ch AND due_on > current_date), 1::bigint, 'with the old future slots gone');

  -- The horizon is capped.
  n := app.generate_audit_occurrences(org, current_date + 5000);
  PERFORM pg_temp.assert_eq((SELECT max(due_on) <= current_date + 366 + 7 FROM public.audit_occurrences WHERE organisation_id = org), true, 'never more than a year ahead');
  PERFORM pg_temp.logout();

  -- ---- who may do what ----
  PERFORM pg_temp.login(u_other);
  PERFORM pg_temp.assert_eq(pg_temp.fails(format('SELECT app.generate_audit_occurrences(%L, current_date)', org)) LIKE 'P0002:%', true, 'another organisation cannot generate or see a schedule');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_occurrences), 0::bigint, 'and sees no slots');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_insp);
  SELECT id INTO occ FROM public.audit_occurrences WHERE audit_definition_id = w2 ORDER BY due_on LIMIT 1;
  PERFORM pg_temp.assert_eq((SELECT count(*) > 0 FROM public.audit_occurrences WHERE organisation_id = org), true, 'an inspector reads the schedule');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format('SELECT app.skip_audit_occurrence(%L, ''x'')', occ)) LIKE '42501:%', true, 'but cannot skip a slot');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.audit_occurrences (organisation_id, audit_definition_id, due_on) VALUES (%L, %L, current_date + 400)$q$, org, w2), 'slots cannot be written directly');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.audit_occurrences SET status = 'skipped' WHERE id = %L$q$, occ), 'nor changed');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login(u_owner);
  PERFORM pg_temp.assert_eq(pg_temp.fails(format('SELECT app.skip_audit_occurrence(%L, ''  '')', occ)) LIKE 'QM018: Give a reason%', true, 'skipping needs a reason');
  PERFORM app.skip_audit_occurrence(occ, 'Machine down for repair');
  PERFORM pg_temp.assert_eq((SELECT status || '/' || skipped_reason || '/' || (skipped_by = u_owner)::text FROM public.audit_occurrences WHERE id = occ), 'skipped/Machine down for repair/true', 'skipped, with who and why');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format('SELECT app.skip_audit_occurrence(%L, ''again'')', occ)) LIKE 'QM018: This audit is already skipped%', true, 'not twice');
  -- A skipped slot further ahead is history too: a change of rhythm that no longer fits it leaves it, while the scheduled slots that do not fit go.
  SELECT id INTO occ2 FROM public.audit_occurrences WHERE audit_definition_id = w2 AND due_on = current_date + 14;
  PERFORM app.skip_audit_occurrence(occ2, 'Shutdown week');
  UPDATE public.audit_definitions SET frequency_kind = 'monthly', first_due_on = current_date + 40 WHERE id = w2;
  PERFORM app.generate_audit_occurrences(org, current_date + 70);
  PERFORM pg_temp.assert_eq((SELECT status FROM public.audit_occurrences WHERE id = occ2), 'skipped', 'a skipped slot is history and is not removed with the future ones');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.audit_occurrences WHERE audit_definition_id = w2 AND due_on > current_date AND status = 'scheduled' AND due_on < current_date + 40), 0::bigint, 'while the scheduled ones that no longer fit are gone');
  PERFORM app.unskip_audit_occurrence(occ);
  PERFORM pg_temp.assert_eq((SELECT status || '/' || (skipped_at IS NULL)::text FROM public.audit_occurrences WHERE id = occ), 'scheduled/true', 'unskipped');
  PERFORM pg_temp.assert_eq(pg_temp.fails(format('SELECT app.unskip_audit_occurrence(%L)', occ)) LIKE 'QM018: This audit is not skipped%', true, 'only a skipped one');
  PERFORM pg_temp.logout();

  SELECT count(*) INTO n FROM public.audit_events WHERE organisation_id = org AND entity_type = 'audit_occurrences';
  PERFORM pg_temp.assert_eq(n > 0, true, 'slots are audited');
END $$;

ROLLBACK;
