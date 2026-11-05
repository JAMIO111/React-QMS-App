-- Reusable characteristic templates: manage rights, value rules, unique names, audit, inspectors read only.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('34000000-0000-0000-0000-000000000101', 'owner@tpl.test'),
  ('34000000-0000-0000-0000-000000000103', 'inspector@tpl.test');

CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);
GRANT SELECT ON ids TO authenticated;

DO $$
DECLARE org uuid; m uuid; t uuid;
BEGIN
  PERFORM pg_temp.login('34000000-0000-0000-0000-000000000101');
  org := app.create_organisation('Template Works', 'Plant A', 'PA', NULL);

  INSERT INTO public.characteristic_templates (organisation_id, name, characteristic_key, nominal, lower_limit, upper_limit, unit_code, spc_eligible, chart_type, subgroup_size,
                                               sampling, reactions)
    VALUES (org, 'Outer diameter', 'OD', 25, 24.95, 25.05, 'mm', true, 'imr', 1,
            '[{"triggerType":"first_off","intervalValue":null,"sampleSize":1}]', '[{"triggerType":"out_of_spec","action":"hold","instruction":"Hold the batch"}]')
    RETURNING id INTO t;
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.characteristic_templates (organisation_id, name, characteristic_key, upper_limit, unit_code) VALUES (%L, 'outer DIAMETER', 'OD2', 1, 'mm')$q$, org), 'names unique ignoring case');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.characteristic_templates (organisation_id, name, characteristic_key, lower_limit, upper_limit, unit_code) VALUES (%L, 'Bad limits', 'BAD', 2, 1, 'mm')$q$, org), 'lower limit above upper limit refused');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.characteristic_templates (organisation_id, name, characteristic_key, data_type, unit_code) VALUES (%L, 'Visual with unit', 'VIS', 'attribute', 'mm')$q$, org), 'pass/fail checks have no unit');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.characteristic_templates (organisation_id, name, characteristic_key, upper_limit, unit_code, sampling) VALUES (%L, 'Bad rules', 'BR', 1, 'mm', '{}')$q$, org), 'sampling must be an array');
  INSERT INTO public.characteristic_templates (organisation_id, name, characteristic_key, value_source, spec_key, unit_code)
    VALUES (org, 'Part length', 'LENGTH', 'part_spec', 'LENGTH', 'mm');

  UPDATE public.characteristic_templates SET active = false WHERE id = t;
  PERFORM pg_temp.assert_eq((SELECT active FROM public.characteristic_templates WHERE id = t), false, 'template switched off');

  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM audit.events WHERE entity_type = 'characteristic_templates') >= 3, true, 'changes audited');
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, '34000000-0000-0000-0000-000000000103', 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id)
    SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'inspector';
  INSERT INTO ids VALUES ('org', org), ('t', t);
END $$;

DO $$
DECLARE org uuid := (SELECT v FROM ids WHERE k = 'org'); t uuid := (SELECT v FROM ids WHERE k = 't');
BEGIN
  PERFORM pg_temp.login('34000000-0000-0000-0000-000000000103');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.characteristic_templates), 2::bigint, 'inspector reads templates');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.characteristic_templates (organisation_id, name, characteristic_key, upper_limit, unit_code) VALUES (%L, 'Mine', 'MINE', 1, 'mm')$q$, org), 'inspector cannot add templates');
  PERFORM pg_temp.assert_eq(pg_temp.affected(format($q$UPDATE public.characteristic_templates SET name = 'Changed' WHERE id = %L$q$, t)), 0::bigint, 'inspector cannot change templates');
  PERFORM pg_temp.logout();
END $$;

ROLLBACK;
