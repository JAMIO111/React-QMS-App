-- Single sign-on SS4 (docs/sso-plan.md SS4, SS5): joining on the first company sign-in (only when switched on, only through the organisation's
-- own provider at a verified domain, as a viewer or inspector, never twice), and moving a password member onto their company account (same
-- address, membership and open work move, finished records stay, each kind in its own sub-transaction, frozen record). The drift check below
-- fails when a migration adds a column that names a user without classifying it in app.user_reference_columns().
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

CREATE FUNCTION pg_temp.session(p_user uuid, p_aal text, p_amr jsonb) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', (jsonb_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)
                                            || CASE WHEN p_amr IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('amr', p_amr) END)::text, true);
  PERFORM set_config('role', 'authenticated', true);
END $$;
CREATE FUNCTION pg_temp.password() RETURNS jsonb LANGUAGE sql AS $$ SELECT '[{"method": "password", "timestamp": 1700000000}]'::jsonb $$;
CREATE FUNCTION pg_temp.saml(p_provider uuid) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_array(jsonb_build_object('method', 'sso/saml', 'provider', p_provider, 'timestamp', 1700000000)) $$;
CREATE FUNCTION pg_temp.assert_true(p boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p IS NOT TRUE THEN RAISE EXCEPTION 'FAILED: %', label; END IF; END $$;
CREATE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE || ': ' || SQLERRM; END $$;

-- ---- drift: every column that names a user is classified ----
DO $$
DECLARE r record; v_missing text := ''; v_gone text := '';
BEGIN
  FOR r IN
    WITH refs AS (
      SELECT c.conrelid::regclass AS rel, a.attname::text AS col
        FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
       WHERE c.contype = 'f' AND cardinality(c.conkey) = 1 AND c.confrelid IN ('auth.users'::regclass, 'public.profiles'::regclass)
      UNION
      SELECT cl.oid::regclass, a.attname::text
        FROM pg_attribute a JOIN pg_class cl ON cl.oid = a.attrelid JOIN pg_namespace ns ON ns.oid = cl.relnamespace
       WHERE cl.relkind = 'r' AND ns.nspname IN ('public', 'app') AND a.attnum > 0 AND NOT a.attisdropped AND a.atttypid = 'uuid'::regtype
         AND (a.attname ~ '(_by|user_id|_user)$' OR a.attname IN ('owner_id', 'custodian_id', 'auth_id', 'approver_id', 'technician_id', 'actor_id'))
    )
    SELECT (SELECT relname FROM pg_class WHERE oid = rel)::text AS tbl, col FROM refs
  LOOP
    IF r.col !~ '_by$' AND NOT EXISTS (SELECT 1 FROM app.user_reference_columns() u WHERE u.table_name = r.tbl AND u.column_name = r.col) THEN
      v_missing := v_missing || format(' %s.%s', r.tbl, r.col);
    END IF;
  END LOOP;
  IF v_missing <> '' THEN
    RAISE EXCEPTION 'FAILED: columns that name a user are not classified in app.user_reference_columns() (moved, history or personal):%', v_missing;
  END IF;
  FOR r IN SELECT * FROM app.user_reference_columns() LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_class cl ON cl.oid = a.attrelid JOIN pg_namespace ns ON ns.oid = cl.relnamespace
                    WHERE ns.nspname IN ('public', 'app') AND cl.relname = r.table_name AND a.attname = r.column_name AND NOT a.attisdropped) THEN
      v_gone := v_gone || format(' %s.%s', r.table_name, r.column_name);
    END IF;
  END LOOP;
  IF v_gone <> '' THEN RAISE EXCEPTION 'FAILED: app.user_reference_columns() names columns that do not exist:%', v_gone; END IF;
END $$;

INSERT INTO auth.users (id, email, is_sso_user) VALUES
  ('5f400000-0000-0000-0000-000000000a01', 'ann@acme.test', false),       -- owner, password
  ('5f400000-0000-0000-0000-000000000a02', 'ivy@acme.test', false),       -- inspector, password
  ('5f400000-0000-0000-0000-000000000a12', 'IVY@acme.test', true),        -- Ivy's company account (address in another case)
  ('5f400000-0000-0000-0000-000000000a03', 'new@acme.test', true),        -- someone new at Acme, company account
  ('5f400000-0000-0000-0000-000000000a04', 'pat@acme.test', true),        -- invited, company account
  ('5f400000-0000-0000-0000-000000000a05', 'eve@acme.test', true),        -- company account, other person than any member
  ('5f400000-0000-0000-0000-000000000b01', 'bob@rival.test', false);

DO $$
DECLARE
  ann uuid := '5f400000-0000-0000-0000-000000000a01'; ivy uuid := '5f400000-0000-0000-0000-000000000a02';
  ivy_sso uuid := '5f400000-0000-0000-0000-000000000a12'; newbie uuid := '5f400000-0000-0000-0000-000000000a03';
  pat uuid := '5f400000-0000-0000-0000-000000000a04'; eve uuid := '5f400000-0000-0000-0000-000000000a05';
  bob uuid := '5f400000-0000-0000-0000-000000000b01';
  sp uuid := '5f4000aa-0000-0000-0000-000000000001';
  org uuid; rival uuid; d uuid; dept uuid; viewer uuid; owner_role uuid; ivy_m uuid; r text; m uuid; emp uuid; f uuid; mv public.sso_account_moves%ROWTYPE;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('SS4 Acme'); d := app.add_sso_domain(org, 'acme.test'); PERFORM pg_temp.logout();
  PERFORM pg_temp.login(bob); rival := app.create_organisation('SS4 Rival'); PERFORM pg_temp.logout();
  PERFORM app.system_sso_domain_check(d, true, NULL, ann);
  PERFORM app.system_sso_save_provider(org, ann, sp, 'https://idp.acme.test/entity', 'https://idp.acme.test/metadata', NULL, ARRAY['acme.test']);
  SELECT id INTO viewer FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  SELECT id INTO owner_role FROM public.roles WHERE organisation_id = org AND key = 'owner';
  INSERT INTO public.departments (organisation_id, site_id, code, name)
    SELECT org, s.id, 'QA', 'Quality' FROM public.sites s WHERE s.organisation_id = org LIMIT 1 RETURNING id INTO dept;
  INSERT INTO public.organisation_users (organisation_id, user_id, status, joined_at) VALUES (org, ivy, 'active', now()) RETURNING id INTO ivy_m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    VALUES (org, ivy_m, (SELECT id FROM public.roles WHERE organisation_id = org AND key = 'inspector'));
  INSERT INTO public.organisation_users (organisation_id, invited_email, status, invited_at) VALUES (org, 'pat@acme.test', 'invited', now());

  -- ---- joining: switched off by default, then on with a safe role ----
  PERFORM pg_temp.session(ann, 'aal1', pg_temp.password());
  PERFORM app.set_sso_mode(org, 'optional');
  r := pg_temp.fails(format($f$SELECT app.set_sso_joining(%L, 'domain', %L, NULL)$f$, org, owner_role));
  PERFORM pg_temp.assert_true(r LIKE 'QM030%viewer or an inspector%', 'never joins as an owner');
  r := pg_temp.fails(format($f$SELECT app.set_sso_joining(%L, 'domain', NULL, NULL)$f$, org));
  PERFORM pg_temp.assert_true(r LIKE 'QM030%Choose the role%', 'a role is needed');
  PERFORM pg_temp.session(newbie, 'aal1', pg_temp.saml(sp));
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.sso_joinable_organisations()), 0::bigint, 'nobody joins while only invited people may');
  PERFORM pg_temp.session(ann, 'aal1', pg_temp.password());
  PERFORM pg_temp.assert_eq(app.set_sso_joining(org, 'domain', viewer, dept), 'domain', 'anyone at the domain may join as a viewer');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_true(EXISTS (SELECT 1 FROM public.sso_changes WHERE organisation_id = org AND kind = 'joining'), 'the change is written down');

  PERFORM pg_temp.session(newbie, 'aal1', pg_temp.password());
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.sso_joinable_organisations()), 0::bigint, 'not without a company sign-in');
  PERFORM pg_temp.session(pat, 'aal1', pg_temp.saml(sp));
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.sso_joinable_organisations()), 0::bigint, 'someone invited accepts the invitation instead');
  PERFORM pg_temp.session(newbie, 'aal1', pg_temp.saml(sp));
  PERFORM pg_temp.assert_true((SELECT role_name = 'Viewer' FROM app.sso_joinable_organisations() WHERE organisation_id = org), 'joinable, as a viewer');
  m := app.join_by_company_sign_in(org);
  PERFORM pg_temp.assert_true(app.is_member(org) AND app.has_permission(org, 'ncr.read'), 'a member with the viewer''s rights');
  PERFORM pg_temp.assert_true(NOT app.has_permission(org, 'ncr.create'), 'and only those');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_true(EXISTS (SELECT 1 FROM public.department_members WHERE membership_id = m AND department_id = dept AND is_primary), 'in the default department');
  PERFORM pg_temp.assert_true(NOT EXISTS (SELECT 1 FROM public.user_subscription_assignments WHERE organisation_membership_id = m), 'with no seat');
  PERFORM pg_temp.assert_true(EXISTS (SELECT 1 FROM public.sso_changes WHERE organisation_id = org AND kind = 'member_joined' AND user_id = newbie), 'owners are told');
  PERFORM pg_temp.session(newbie, 'aal1', pg_temp.saml(sp));
  r := pg_temp.fails(format($f$SELECT app.join_by_company_sign_in(%L)$f$, org));
  PERFORM pg_temp.assert_true(r LIKE 'QM030%', 'never twice');
  r := pg_temp.fails(format($f$SELECT app.join_by_company_sign_in(%L)$f$, rival));
  PERFORM pg_temp.assert_true(r LIKE 'QM030%', 'not another organisation');

  -- ---- matches: Ivy's company account matches her password account (address in any case) ----
  PERFORM pg_temp.session(ann, 'aal1', pg_temp.password());
  PERFORM pg_temp.assert_true((SELECT sso_user_id = ivy_sso AND NOT sso_member FROM app.sso_member_matches(org) WHERE password_user_id = ivy), 'Ivy is matched');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.sso_member_matches(org)), 1::bigint, 'and nobody else');
  PERFORM pg_temp.session(ivy, 'aal1', pg_temp.password());
  r := pg_temp.fails(format($f$SELECT count(*) FROM app.sso_member_matches(%L)$f$, org));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'only member managers see matches');
  r := pg_temp.fails(format($f$SELECT app.move_member_to_sso_account(%L, %L, %L)$f$, org, ivy, ivy_sso));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'nor move people');
  PERFORM pg_temp.session(ivy_sso, 'aal1', pg_temp.saml(sp));
  PERFORM pg_temp.assert_true((SELECT password_user_id = ivy FROM app.my_sso_move_candidates() WHERE organisation_id = org), 'Ivy''s company account sees the move waiting');
  r := pg_temp.fails(format($f$SELECT app.system_move_own_account(%L, %L, %L)$f$, org, ivy, ivy_sso));
  PERFORM pg_temp.assert_eq(left(r, 5), '42501', 'moving yourself goes through the API (which checks the old password)');

  -- ---- refused moves ----
  PERFORM pg_temp.session(ann, 'aal1', pg_temp.password());
  r := pg_temp.fails(format($f$SELECT app.move_member_to_sso_account(%L, %L, %L)$f$, org, ivy, eve));
  PERFORM pg_temp.assert_true(r LIKE 'QM030%different email addresses%', 'a different address is refused');
  r := pg_temp.fails(format($f$SELECT app.move_member_to_sso_account(%L, %L, %L)$f$, org, ivy, ann));
  PERFORM pg_temp.assert_true(r LIKE 'QM030%password account can be moved onto a company account%', 'only onto a company account');
  r := pg_temp.fails(format($f$SELECT app.move_member_to_sso_account(%L, %L, %L)$f$, org, bob, ivy_sso));
  PERFORM pg_temp.assert_true(r LIKE 'QM030%', 'not someone who is not a member');
  PERFORM pg_temp.logout();

  -- ---- the move ----
  INSERT INTO public."Employees" (organisation_id, first_name, surname) VALUES (org, 'Ivy', 'Inspector') RETURNING id INTO emp;
  UPDATE public."Employees" SET auth_id = ivy WHERE id = emp;
  PERFORM pg_temp.login(ivy);
  INSERT INTO public.saved_filters (organisation_id, scope, name, filters) VALUES (org, 'ncr_register', 'Mine', '{"stage":"open"}') RETURNING id INTO f;
  PERFORM pg_temp.logout();
  PERFORM app.system_record_sso_sign_in(org, ivy, 'sso');
  -- Ivy's company account accepted an invitation already: its own membership gives way.
  INSERT INTO public.organisation_users (organisation_id, user_id, status, joined_at) VALUES (org, ivy_sso, 'active', now());

  PERFORM pg_temp.session(ann, 'aal1', pg_temp.password());
  PERFORM app.move_member_to_sso_account(org, ivy, ivy_sso);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT user_id FROM public.organisation_users WHERE id = ivy_m), ivy_sso, 'the membership now belongs to the company account');
  PERFORM pg_temp.assert_true(NOT EXISTS (SELECT 1 FROM public.organisation_users WHERE organisation_id = org AND user_id = ivy AND status <> 'removed'), 'the old account has no membership left');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.organisation_users WHERE organisation_id = org AND user_id = ivy_sso AND status <> 'removed'), 1::bigint, 'one live membership');
  PERFORM pg_temp.assert_eq((SELECT auth_id FROM public."Employees" WHERE id = emp), ivy_sso, 'the employee link moved');
  PERFORM pg_temp.assert_eq((SELECT user_id FROM public.saved_filters WHERE id = f), ivy_sso, 'saved filters moved');
  PERFORM pg_temp.assert_eq((SELECT user_id FROM public.sso_sign_ins WHERE organisation_id = org LIMIT 1), ivy, 'history stays with the old account');
  SELECT * INTO mv FROM public.sso_account_moves WHERE organisation_id = org;
  PERFORM pg_temp.assert_true(mv.from_user_id = ivy AND mv.to_user_id = ivy_sso AND NOT mv.by_self AND (mv.moved ->> 'Employees.auth_id')::int = 1
                                AND (mv.moved ->> 'saved_filters.user_id')::int = 1 AND mv.skipped = '{}'::jsonb, 'the move is written down with what moved');
  r := pg_temp.fails(format($f$UPDATE public.sso_account_moves SET email = 'x' WHERE id = %L$f$, mv.id));
  PERFORM pg_temp.assert_true(r LIKE 'QM030%', 'and frozen');
  PERFORM pg_temp.assert_true(EXISTS (SELECT 1 FROM public.sso_changes WHERE organisation_id = org AND kind = 'account_moved'), 'owners are told');
  PERFORM pg_temp.session(ivy_sso, 'aal1', pg_temp.saml(sp));
  PERFORM pg_temp.assert_true(app.has_permission(org, 'ncr.create'), 'the company account has Ivy''s inspector rights');
  PERFORM pg_temp.session(ann, 'aal1', pg_temp.password());
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.sso_member_matches(org)), 0::bigint, 'no match left');

  -- ---- not the same person ----
  PERFORM pg_temp.logout();
  INSERT INTO auth.users (id, email, is_sso_user) VALUES ('5f400000-0000-0000-0000-000000000a21', 'ann@acme.test', true);
  PERFORM pg_temp.session(ann, 'aal1', pg_temp.password());
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.sso_member_matches(org)), 1::bigint, 'a company account for Ann''s address is a match');
  PERFORM app.dismiss_sso_match(org, ann, '5f400000-0000-0000-0000-000000000a21');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.sso_member_matches(org)), 0::bigint, 'until marked as someone else');
  r := pg_temp.fails(format($f$SELECT app.move_member_to_sso_account(%L, %L, %L)$f$, org, ann, '5f400000-0000-0000-0000-000000000a21'));
  PERFORM pg_temp.assert_true(r LIKE 'QM030%your company account%', 'nobody moves their own account from here');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
