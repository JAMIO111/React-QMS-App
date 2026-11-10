-- Custom fields (CF1): definitions (permission, key/type fixed, options never removed, 20 active, retire/reactivate, reorder),
-- values (checked per type, record's own read/write permission, locked records, retired fields and switched-off options kept or cleared),
-- required on save (end of the creating transaction, never cleared) and at a stage (moving into it), tenancy and audit.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('31600000-0000-0000-0000-000000000101', 'owner@cf.test'),
  ('31600000-0000-0000-0000-000000000102', 'viewer@cf.test'),
  ('31600000-0000-0000-0000-000000000103', 'other@cf.test'),
  ('31600000-0000-0000-0000-000000000104', 'engineer@cf.test');

DO $$
DECLARE
  org uuid; other uuid; m uuid; part uuid; part2 uuid; f_text uuid; f_num uuid; f_choice uuid; f_multi uuid; f_person uuid; f_date uuid; f_bool uuid;
  f_req uuid; f_stage uuid; po uuid; po2 uuid; i integer; ids uuid[];
  owner_id uuid := '31600000-0000-0000-0000-000000000101';
  viewer_id uuid := '31600000-0000-0000-0000-000000000102';
  engineer_id uuid := '31600000-0000-0000-0000-000000000104';
BEGIN
  PERFORM pg_temp.login('31600000-0000-0000-0000-000000000103');
  other := app.create_organisation('Other Works', 'Plant O', 'PO', NULL);
  PERFORM pg_temp.login(owner_id);
  org := app.create_organisation('Field Works', 'Plant A', 'PA', NULL);
  PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, viewer_id, 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, engineer_id, 'active') RETURNING id INTO m;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, m, id FROM public.roles WHERE organisation_id = org AND key = 'quality_engineer';

  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.custom_field_definitions WHERE organisation_id = org)::text, '0', 'an organisation starts with no custom fields');

  -- Definitions: only custom_fields.manage, and nobody writes the tables directly.
  PERFORM pg_temp.login(engineer_id);
  PERFORM pg_temp.assert_fails(format($q$SELECT app.save_custom_field(%L, 'part', '{"label": "Finish", "fieldType": "text"}')$q$, org), 'a quality engineer cannot define fields');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.custom_field_definitions (organisation_id, entity_type, key, label, field_type) VALUES (%L, 'part', 'x', 'X', 'text')$q$, org), 'no direct inserts');
  PERFORM pg_temp.login(owner_id);
  f_text := app.save_custom_field(org, 'part', '{"label": "Surface finish", "fieldType": "text", "section": "Finishing", "helpText": "As on the drawing"}');
  PERFORM pg_temp.assert_eq((SELECT key FROM public.custom_field_definitions WHERE id = f_text), 'surface_finish', 'a key is made from the label');
  f_num := app.save_custom_field(org, 'part', '{"label": "Weight", "fieldType": "number", "decimals": 2, "unit": "kg", "min": 0, "max": 1000}');
  f_choice := app.save_custom_field(org, 'part', '{"label": "Coating", "fieldType": "choice", "options": [{"key": "zinc", "label": "Zinc"}, {"key": "paint", "label": "Paint"}]}');
  f_multi := app.save_custom_field(org, 'part', '{"label": "Tests", "fieldType": "multi_choice", "options": [{"key": "salt", "label": "Salt spray"}, {"key": "hard", "label": "Hardness"}]}');
  f_person := app.save_custom_field(org, 'part', '{"label": "Design owner", "fieldType": "person"}');
  f_date := app.save_custom_field(org, 'part', '{"label": "Approved on", "fieldType": "date"}');
  f_bool := app.save_custom_field(org, 'part', '{"label": "Safety critical", "fieldType": "boolean"}');
  PERFORM pg_temp.assert_eq((SELECT string_agg(key, ',' ORDER BY position) FROM public.custom_field_definitions WHERE organisation_id = org AND entity_type = 'part'),
    'surface_finish,weight,coating,tests,design_owner,approved_on,safety_critical', 'fields are placed in the order they were added');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.save_custom_field(%L, 'part', '{"label": "surface FINISH", "fieldType": "text"}')$q$, org), 'labels are unique ignoring case');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.save_custom_field(%L, 'part', '{"label": "Colour", "fieldType": "choice"}')$q$, org), 'a list field needs options');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.save_custom_field(%L, 'part', '{"label": "Colour", "fieldType": "choice", "options": [{"key": "a", "label": "Red"}, {"key": "b", "label": "red"}]}')$q$, org), 'option labels are unique');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.save_custom_field(%L, 'part', '{"label": "Notes", "fieldType": "text", "unit": "kg"}')$q$, org), 'only number fields have a unit');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.save_custom_field(%L, 'part', '{"label": "Notes", "fieldType": "text", "requiredAt": "closed"}')$q$, org), 'a part has no stages to require a field at');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.save_custom_field(%L, 'audit', '{"label": "Notes", "fieldType": "text"}')$q$, org), 'only the listed kinds of record take custom fields');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.save_custom_field(%L, 'part', '{"label": "Weight", "fieldType": "text"}', %L)$q$, org, f_num), 'the type cannot change');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.save_custom_field(%L, 'part', '{"label": "Weight", "key": "mass"}', %L)$q$, org, f_num), 'the key cannot change');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.save_custom_field(%L, 'part', '{"label": "Coating", "options": [{"key": "zinc", "label": "Zinc"}]}', %L)$q$, org, f_choice), 'an option cannot be removed');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.custom_field_definitions SET label = 'X' WHERE id = %L$q$, f_text), 'no direct updates');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.save_custom_field(%L, 'part', '{"label": "Theirs", "fieldType": "text"}')$q$, other), 'no fields in another organisation');

  -- Values: checked per type.
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'CF-1', 'Bracket') RETURNING id INTO part;
  PERFORM app.set_custom_values('part', part, jsonb_build_object('surface_finish', '  Ra 0.8 ', 'weight', '12.50', 'coating', 'zinc', 'tests', jsonb_build_array('salt', 'hard', 'salt'),
    'design_owner', viewer_id, 'approved_on', '2026-11-01', 'safety_critical', true));
  PERFORM pg_temp.assert_eq((SELECT "values"::text FROM public.custom_field_values WHERE record_id = part),
    jsonb_build_object('surface_finish', 'Ra 0.8', 'weight', 12.50, 'coating', 'zinc', 'tests', jsonb_build_array('salt', 'hard'), 'design_owner', viewer_id::text,
      'approved_on', '2026-11-01', 'safety_critical', true)::text, 'values are stored trimmed, numbers as numbers, repeated choices once');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.set_custom_values('part', %L, '{"weight": "abc"}')$q$, part), 'a number must be a number');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.set_custom_values('part', %L, '{"weight": "1.234"}')$q$, part), 'at most the decimals allowed');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.set_custom_values('part', %L, '{"weight": 1001}')$q$, part), 'within the maximum');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.set_custom_values('part', %L, '{"weight": -1}')$q$, part), 'within the minimum');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.set_custom_values('part', %L, '{"approved_on": "2026-02-30"}')$q$, part), 'a real date');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.set_custom_values('part', %L, '{"approved_on": "01/11/2026"}')$q$, part), 'dates as year-month-day');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.set_custom_values('part', %L, '{"safety_critical": "yes"}')$q$, part), 'yes / no is a boolean');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.set_custom_values('part', %L, '{"coating": "gold"}')$q$, part), 'a choice must be an option');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.set_custom_values('part', %L, '{"tests": ["salt", "x"]}')$q$, part), 'every choice must be an option');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.set_custom_values('part', %L, '{"design_owner": "31600000-0000-0000-0000-000000000103"}')$q$, part), 'a person must be a member');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.set_custom_values('part', %L, %L)$q$, part, jsonb_build_object('surface_finish', repeat('x', 501))), 'short text is at most 500 characters');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.set_custom_values('part', %L, '{"nope": 1}')$q$, part), 'an unknown key is refused');
  PERFORM app.set_custom_values('part', part, '{"surface_finish": "", "tests": []}');
  PERFORM pg_temp.assert_eq((SELECT ("values" ? 'surface_finish' OR "values" ? 'tests')::text FROM public.custom_field_values WHERE record_id = part), 'false', 'empty values clear');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.custom_field_values (record_id, organisation_id, entity_type) VALUES (gen_random_uuid(), %L, 'part')$q$, org), 'no direct writes on values');

  -- Switched-off options and retired fields: kept or cleared, never newly chosen.
  PERFORM app.save_custom_field(org, 'part', '{"label": "Coating", "options": [{"key": "zinc", "label": "Zinc", "active": false}, {"key": "paint", "label": "Paint"}, {"key": "anod", "label": "Anodised"}]}', f_choice);
  PERFORM pg_temp.assert_ok(format($q$SELECT app.set_custom_values('part', %L, '{"coating": "zinc", "weight": 13}')$q$, part), 'a switched-off option already held is kept');
  INSERT INTO public.parts (organisation_id, part_number, name) VALUES (org, 'CF-2', 'Plate') RETURNING id INTO part2;
  PERFORM pg_temp.assert_fails(format($q$SELECT app.set_custom_values('part', %L, '{"coating": "zinc"}')$q$, part2), 'a switched-off option cannot be newly chosen');
  PERFORM app.retire_custom_field(f_num, 'No longer recorded');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.set_custom_values('part', %L, '{"weight": 14}')$q$, part), 'a retired field cannot take a new value');
  PERFORM pg_temp.assert_ok(format($q$SELECT app.set_custom_values('part', %L, '{"weight": 13}')$q$, part), 'a retired field keeps its value');
  PERFORM app.set_custom_values('part', part, '{"weight": null}');
  PERFORM pg_temp.assert_eq((SELECT ("values" ? 'weight')::text FROM public.custom_field_values WHERE record_id = part), 'false', 'a retired field can be cleared');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.retire_custom_field(%L, 'x')$q$, f_text), 'retiring needs a reason');
  PERFORM app.reactivate_custom_field(f_num);
  PERFORM pg_temp.assert_eq((SELECT active::text FROM public.custom_field_definitions WHERE id = f_num), 'true', 'a retired field can be brought back');

  -- Twenty active fields per kind of record.
  FOR i IN 1..13 LOOP PERFORM app.save_custom_field(org, 'part', jsonb_build_object('label', 'Extra ' || i, 'fieldType', 'text')); END LOOP;
  PERFORM pg_temp.assert_fails(format($q$SELECT app.save_custom_field(%L, 'part', '{"label": "Extra 21", "fieldType": "text"}')$q$, org), 'at most 20 active fields');
  PERFORM app.retire_custom_field((SELECT id FROM public.custom_field_definitions WHERE organisation_id = org AND label = 'Extra 13'), 'Too many');
  PERFORM pg_temp.assert_ok(format($q$SELECT app.save_custom_field(%L, 'part', '{"label": "Extra 21", "fieldType": "text"}')$q$, org), 'retiring one frees a place');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.reactivate_custom_field(%L)$q$, (SELECT id FROM public.custom_field_definitions WHERE organisation_id = org AND label = 'Extra 13')), 'bringing one back respects the limit');
  PERFORM pg_temp.assert_ok(format($q$SELECT app.save_custom_field(%L, 'machine', '{"label": "Extra 1", "fieldType": "text"}')$q$, org), 'the limit is per kind of record');

  -- Reorder: every field of the kind, once.
  SELECT array_agg(id ORDER BY position DESC) INTO ids FROM public.custom_field_definitions WHERE organisation_id = org AND entity_type = 'part';
  PERFORM app.reorder_custom_fields(org, 'part', ids);
  PERFORM pg_temp.assert_eq((SELECT id FROM public.custom_field_definitions WHERE organisation_id = org AND entity_type = 'part' ORDER BY position LIMIT 1)::text, ids[1]::text, 'fields can be reordered');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.reorder_custom_fields(%L, 'part', %L)$q$, org, ids[1:3]), 'a reorder lists every field');

  -- Reading and writing follow the record's permissions.
  PERFORM pg_temp.login(viewer_id);
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.custom_field_definitions WHERE organisation_id = org AND entity_type = 'part' AND active)::text, '20', 'every member sees the fields');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.custom_field_values WHERE record_id = part)::text, '1', 'whoever can see a part sees its values');
  PERFORM pg_temp.assert_eq(app.get_custom_values('part', part) ->> 'coating', 'zinc', 'values are read through the function');
  PERFORM pg_temp.assert_eq(app.get_custom_values('part', part2)::text, '{}', 'a record without values reads as empty');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM app.custom_field_people(org) WHERE user_id IN (owner_id, engineer_id))::text, '2', 'a viewer can list the people a person field can name');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.set_custom_values('part', %L, '{"coating": "paint"}')$q$, part), 'a viewer cannot fill them in');
  PERFORM pg_temp.login(engineer_id);
  PERFORM pg_temp.assert_ok(format($q$SELECT app.set_custom_values('part', %L, '{"coating": "paint"}')$q$, part), 'whoever can edit the part can fill them in');
  PERFORM pg_temp.login('31600000-0000-0000-0000-000000000103');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.custom_field_values WHERE record_id = part)::text, '0', 'another organisation sees nothing');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.get_custom_values('part', %L)$q$, part), 'reading another organisation''s record is not found');
  PERFORM pg_temp.assert_fails(format($q$SELECT * FROM app.custom_field_people(%L)$q$, org), 'nor its people');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.custom_field_definitions WHERE organisation_id = org)::text, '0', 'nor the fields');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.set_custom_values('part', %L, '{"coating": "paint"}')$q$, part), 'nor writes them');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.retire_custom_field(%L, 'Not mine')$q$, f_text), 'nor retires a field');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM audit.events WHERE entity_type = 'custom_field_values' AND entity_id = part::text)::text > '0', true, 'values are audited against the record');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM audit.events WHERE entity_type = 'custom_field_definitions' AND entity_id = f_choice::text AND action = 'update')::text > '0', true, 'definitions are audited');
END $$;

-- Required on save: checked at the end of the transaction that creates the record, and never cleared.
DO $$
BEGIN
  PERFORM pg_temp.login('31600000-0000-0000-0000-000000000101');
  PERFORM app.save_custom_field((SELECT id FROM public.organisations WHERE name = 'Field Works'), 'machine', '{"label": "Asset tag", "fieldType": "text", "requiredAt": "save"}');
END $$;
SAVEPOINT missing_required;
DO $$
BEGIN
  PERFORM pg_temp.login('31600000-0000-0000-0000-000000000101');
  INSERT INTO public.machines (organisation_id, code, name) VALUES ((SELECT id FROM public.organisations WHERE name = 'Field Works'), 'M-1', 'Lathe');
  PERFORM pg_temp.assert_fails('SET CONSTRAINTS ALL IMMEDIATE', 'a new machine without a required value is refused');
END $$;
ROLLBACK TO missing_required;
SAVEPOINT before_required;
DO $$
DECLARE org uuid := (SELECT id FROM public.organisations WHERE name = 'Field Works'); m uuid; r text;
BEGIN
  PERFORM pg_temp.login('31600000-0000-0000-0000-000000000101');
  INSERT INTO public.machines (organisation_id, code, name) VALUES (org, 'M-2', 'Mill') RETURNING id INTO m;
  PERFORM app.set_custom_values('machine', m, '{"asset_tag": "AT-2"}');
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  PERFORM pg_temp.assert_fails(format($q$SELECT app.set_custom_values('machine', %L, '{"asset_tag": ""}')$q$, m), 'a required value cannot be cleared');
  PERFORM pg_temp.assert_ok(format($q$SELECT app.set_custom_values('machine', %L, '{"asset_tag": "AT-22"}')$q$, m), 'it can be changed');
END $$;
ROLLBACK TO before_required;

-- Required at a stage: moving into that stage or later needs the value; cancelling never does; existing records are not blocked otherwise.
DO $$
DECLARE org uuid := (SELECT id FROM public.organisations WHERE name = 'Field Works'); part uuid; po uuid; po2 uuid;
BEGIN
  PERFORM pg_temp.login('31600000-0000-0000-0000-000000000101');
  SET CONSTRAINTS ALL IMMEDIATE;
  part := (SELECT id FROM public.parts WHERE organisation_id = org AND part_number = 'CF-1');
  INSERT INTO public.production_orders (organisation_id, order_number, part_id, quantity_planned) VALUES (org, 'WO-1', part, 5) RETURNING id INTO po;
  PERFORM app.save_custom_field(org, 'production_order', '{"label": "Customer PO", "fieldType": "text", "requiredAt": "released"}');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.production_orders SET status = 'released' WHERE id = %L$q$, po), 'an order cannot be released without the value');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.production_orders SET status = 'in_progress' WHERE id = %L$q$, po), 'nor skip past the stage');
  PERFORM pg_temp.assert_ok(format($q$UPDATE public.production_orders SET status = 'cancelled', status_reason = 'Not needed' WHERE id = %L$q$, po), 'cancelling is never blocked');
  INSERT INTO public.production_orders (organisation_id, order_number, part_id, quantity_planned) VALUES (org, 'WO-2', part, 5) RETURNING id INTO po2;
  PERFORM app.set_custom_values('production_order', po2, '{"customer_po": "PO-77"}');
  PERFORM pg_temp.assert_ok(format($q$UPDATE public.production_orders SET status = 'released' WHERE id = %L$q$, po2), 'with the value it can be released');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.set_custom_values('production_order', %L, '{"customer_po": "PO-1"}')$q$, po), 'a cancelled order is locked');
  PERFORM pg_temp.assert_ok(format($q$SELECT app.set_custom_values('production_order', %L, '{"customer_po": ""}')$q$, po), 'a save that changes nothing is accepted on a locked record');
  PERFORM app.save_custom_field(org, 'nonconformance', '{"label": "Shift", "fieldType": "choice", "requiredAt": "open", "options": [{"key": "a", "label": "Days"}, {"key": "b", "label": "Nights"}]}');
  PERFORM pg_temp.assert_fails(format($q$INSERT INTO public.nonconformances (organisation_id, source, title, description, severity, quantity_affected, site_id, category_id, stage)
      VALUES (%L, 'internal', 'Burr', 'Burr on edge', 'minor', 1, %L, %L, 'open')$q$, org, (SELECT id FROM public.sites WHERE organisation_id = org LIMIT 1), pg_temp.cat(org)),
    'an NC created already open needs the value');
  PERFORM pg_temp.assert_ok(format($q$INSERT INTO public.nonconformances (organisation_id, source, title, description, severity, quantity_affected, site_id)
      VALUES (%L, 'internal', 'Burr', 'Burr on edge', 'minor', 1, %L)$q$, org, (SELECT id FROM public.sites WHERE organisation_id = org LIMIT 1)),
    'a draft NC does not need it yet');
  PERFORM app.save_custom_field(org, 'production_order', '{"label": "Inspector note", "fieldType": "text", "requiredAt": "completed"}');
  PERFORM pg_temp.assert_ok(format($q$SELECT app.set_custom_values('production_order', %L, '{"customer_po": "PO-78"}')$q$, po2), 'a released order missing a later-stage value can still be edited');
END $$;

ROLLBACK;
