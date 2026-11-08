-- Saved filters: personal, up to five per person, organisation and register, a unique name per person, and invisible to everyone else.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('3a000000-0000-0000-0000-000000000801', 'ann@sf.test'), ('3a000000-0000-0000-0000-000000000802', 'bob@sf.test'), ('3a000000-0000-0000-0000-000000000803', 'eve@sf.test');

CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

DO $$
DECLARE
  ann uuid := '3a000000-0000-0000-0000-000000000801'; bob uuid := '3a000000-0000-0000-0000-000000000802'; eve uuid := '3a000000-0000-0000-0000-000000000803';
  org uuid; org2 uuid; m uuid; f1 uuid; n integer; r text;
BEGIN
  PERFORM pg_temp.login(ann);
  org := app.create_organisation('SF Alpha');
  m := (SELECT id FROM public.organisation_users WHERE organisation_id = org AND user_id = ann);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(eve);
  org2 := app.create_organisation('SF Beta');
  PERFORM pg_temp.logout();
  -- Bob is a second member of Alpha.
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, bob, 'active');

  PERFORM pg_temp.assert_eq(app.saved_filter_limit(), 5, 'the limit is five');

  -- ---- saving ----
  PERFORM pg_temp.login(ann);
  INSERT INTO public.saved_filters (organisation_id, scope, name, filters) VALUES (org, 'ncr_register', 'Open majors', '{"stage":"open","severity":"major"}') RETURNING id INTO f1;
  PERFORM pg_temp.assert_eq((SELECT user_id FROM public.saved_filters WHERE id = f1), ann, 'the owner is the signed-in person, set by the database');
  PERFORM pg_temp.assert_eq((SELECT position FROM public.saved_filters WHERE id = f1), 0, 'the first goes first');
  INSERT INTO public.saved_filters (organisation_id, scope, name, filters) VALUES (org, 'ncr_register', 'Mine', '{}');
  PERFORM pg_temp.assert_eq((SELECT position FROM public.saved_filters WHERE name = 'Mine'), 1, 'later ones go to the end');
  r := pg_temp.fails(format($f$INSERT INTO public.saved_filters (organisation_id, scope, name, filters) VALUES (%L, 'ncr_register', 'open MAJORS', '{}')$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), '23505', 'a name is unique per person whatever its case');
  r := pg_temp.fails(format($f$INSERT INTO public.saved_filters (organisation_id, scope, name, filters) VALUES (%L, 'ncr_register', '', '{}')$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), '23514', 'a name is needed');
  r := pg_temp.fails(format($f$INSERT INTO public.saved_filters (organisation_id, scope, name, filters) VALUES (%L, 'ncr_register', ' padded ', '{}')$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), '23514', 'a name has no spaces round it');
  r := pg_temp.fails(format($f$INSERT INTO public.saved_filters (organisation_id, scope, name, filters) VALUES (%L, 'ncr_register', %L, '{}')$f$, org, repeat('x', 41)));
  PERFORM pg_temp.assert_eq(left(r, 5), '23514', 'a name is at most 40 characters');
  r := pg_temp.fails(format($f$INSERT INTO public.saved_filters (organisation_id, scope, name, filters) VALUES (%L, 'ncr_register', 'Arr', '[1]')$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), '23514', 'the filters are an object');
  r := pg_temp.fails(format($f$INSERT INTO public.saved_filters (organisation_id, scope, name, filters) VALUES (%L, 'Bad Scope', 'x1', '{}')$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), '23514', 'the register name is a plain word');

  -- ---- the limit ----
  INSERT INTO public.saved_filters (organisation_id, scope, name, filters) VALUES (org, 'ncr_register', 'Three', '{}'), (org, 'ncr_register', 'Four', '{}'), (org, 'ncr_register', 'Five', '{}');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.saved_filters WHERE user_id = ann AND scope = 'ncr_register'), 5::bigint, 'five can be saved');
  r := pg_temp.fails(format($f$INSERT INTO public.saved_filters (organisation_id, scope, name, filters) VALUES (%L, 'ncr_register', 'Six', '{}')$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), 'QM019', 'a sixth is refused');
  IF r NOT LIKE '%up to 5%' THEN RAISE EXCEPTION 'FAILED: the refusal says why (got %)', r; END IF;
  -- Another register has its own five.
  INSERT INTO public.saved_filters (organisation_id, scope, name, filters) VALUES (org, 'inspections', 'Six elsewhere', '{}');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.saved_filters WHERE scope = 'inspections'), 1::bigint, 'each register has its own five');
  -- Deleting one makes room.
  DELETE FROM public.saved_filters WHERE name = 'Five';
  INSERT INTO public.saved_filters (organisation_id, scope, name, filters) VALUES (org, 'ncr_register', 'Six', '{}');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.saved_filters WHERE user_id = ann AND scope = 'ncr_register'), 5::bigint, 'after a delete a new one fits');

  -- ---- changing ----
  UPDATE public.saved_filters SET name = 'Open majors renamed', filters = '{"stage":"open"}' WHERE id = f1;
  PERFORM pg_temp.assert_eq((SELECT name FROM public.saved_filters WHERE id = f1), 'Open majors renamed', 'a filter can be renamed');
  PERFORM pg_temp.assert_eq((SELECT filters ->> 'stage' FROM public.saved_filters WHERE id = f1), 'open', 'and its filters replaced');
  r := pg_temp.fails(format($f$UPDATE public.saved_filters SET organisation_id = %L WHERE id = %L$f$, org2, f1));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'it cannot be moved to another organisation');
  r := pg_temp.fails(format($f$UPDATE public.saved_filters SET user_id = %L WHERE id = %L$f$, bob, f1));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'or given to someone else');
  r := pg_temp.fails(format($f$UPDATE public.saved_filters SET name = 'Mine' WHERE id = %L$f$, f1));
  PERFORM pg_temp.assert_eq(left(r, 5), '23505', 'a rename cannot take another filter''s name');
  PERFORM pg_temp.logout();

  -- ---- nobody else sees or touches them ----
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.saved_filters), 0::bigint, 'a colleague in the same organisation sees none of them');
  PERFORM pg_temp.assert_eq(pg_temp.affected($f$UPDATE public.saved_filters SET name = 'hijack'$f$), 0::bigint, 'cannot rename them');
  PERFORM pg_temp.assert_eq(pg_temp.affected($f$DELETE FROM public.saved_filters$f$), 0::bigint, 'cannot delete them');
  r := pg_temp.fails(format($f$INSERT INTO public.saved_filters (organisation_id, user_id, scope, name, filters) VALUES (%L, %L, 'ncr_register', 'forged', '{}')$f$, org, ann));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'cannot save one in someone else''s name');
  INSERT INTO public.saved_filters (organisation_id, scope, name, filters) VALUES (org, 'ncr_register', 'Open majors renamed', '{}');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.saved_filters), 1::bigint, 'and has their own, with their own five, and a name that is only unique per person');
  PERFORM pg_temp.logout();

  PERFORM pg_temp.login(eve);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.saved_filters), 0::bigint, 'a member of another organisation sees none');
  r := pg_temp.fails(format($f$INSERT INTO public.saved_filters (organisation_id, scope, name, filters) VALUES (%L, 'ncr_register', 'x1', '{}')$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'and cannot save into an organisation they are not in');
  PERFORM pg_temp.logout();

  -- ---- leaving the organisation hides them (membership is part of the rule) ----
  UPDATE public.organisation_users SET status = 'removed' WHERE organisation_id = org AND user_id = ann;
  PERFORM pg_temp.login(ann);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.saved_filters), 0::bigint, 'a person who left sees none of their filters there');
  PERFORM pg_temp.logout();

  RAISE NOTICE 'saved filters: ok';
END $$;
ROLLBACK;
