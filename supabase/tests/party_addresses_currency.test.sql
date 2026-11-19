-- Customers and suppliers: a postal address (three lines, town or city, county / state, postcode, country) and a currency. Optional; shaped by CHECKs; written by
-- the same people as the other descriptive columns (master_data.manage, column-level UPDATE); and written by imports (only the mapped fields on an update, a
-- currency code kept in capitals).
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('5fb00000-0000-0000-0000-000000000a01', 'ann@addresses.test'), ('5fb00000-0000-0000-0000-000000000a02', 'bob@addresses.test');

DO $$
DECLARE
  ann uuid := '5fb00000-0000-0000-0000-000000000a01'; bob uuid := '5fb00000-0000-0000-0000-000000000a02';
  org uuid; r_viewer uuid; c uuid; s uuid; v uuid;
BEGIN
  PERFORM pg_temp.login(ann); org := app.create_organisation('Address Works'); PERFORM pg_temp.logout();
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, bob, 'active');
  SELECT id INTO r_viewer FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) SELECT org, ou.id, r_viewer FROM public.organisation_users ou WHERE ou.organisation_id = org AND ou.user_id = bob;

  PERFORM pg_temp.login(ann);
  -- a customer and a supplier with a full address and a currency
  INSERT INTO public.customers (organisation_id, code, name, address_line1, address_line2, address_line3, city, region, postcode, country, currency)
  VALUES (org, 'ACME', 'Acme Ltd', '1 High Street', 'Unit 4', 'Trading Estate', 'Leeds', 'West Yorkshire', 'LS1 1AA', 'GB', 'GBP') RETURNING id INTO c;
  INSERT INTO public.suppliers (organisation_id, code, name, address_line1, address_line3, city, country, currency)
  VALUES (org, 'STEEL', 'Steel Ltd', '2 Mill Road', 'Industrial Park', 'Sheffield', 'GB', 'EUR') RETURNING id INTO s;
  PERFORM pg_temp.assert_eq((SELECT address_line3 || '|' || region || '|' || currency FROM public.customers WHERE id = c), 'Trading Estate|West Yorkshire|GBP', 'a customer keeps its address and currency');
  PERFORM pg_temp.assert_eq((SELECT address_line3 || '|' || currency FROM public.suppliers WHERE id = s), 'Industrial Park|EUR', 'a supplier keeps address line 3 and its currency');
  PERFORM pg_temp.assert_ok(format($q$INSERT INTO public.customers (organisation_id, code, name) VALUES (%L, 'PLAIN', 'No address')$q$, org), 'every address column is optional');
  PERFORM pg_temp.assert_ok(format($q$UPDATE public.customers SET email = 'info@acme.test', phone = '0113 496 0000', website = 'https://acme.test' WHERE id = %L$q$, c), 'a customer keeps the company''s general email, phone and website, as a supplier does');
  PERFORM pg_temp.assert_eq((SELECT email || '|' || phone || '|' || website FROM public.customers WHERE id = c), 'info@acme.test|0113 496 0000|https://acme.test', 'and they are kept');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.customers SET phone = '1' WHERE id = %L$q$, c), 'a phone number needs at least three characters, as for suppliers');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.customers SET email = %L WHERE id = %L$q$, repeat('x', 201), c), 'an email is at most 200 characters');

  -- shape
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.customers SET country = 'gb' WHERE id = %L$q$, c), 'a country is two capital letters');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.customers SET currency = 'POUNDS' WHERE id = %L$q$, c), 'a currency is three capital letters');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.suppliers SET currency = 'eu' WHERE id = %L$q$, s), 'so is a supplier''s');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.customers SET address_line1 = %L WHERE id = %L$q$, repeat('x', 121), c), 'an address line is at most 120 characters');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.customers SET city = '   ' WHERE id = %L$q$, c), 'a blank town is not kept (empty means none)');
  PERFORM pg_temp.assert_ok(format($q$UPDATE public.customers SET address_line2 = NULL, currency = 'USD' WHERE id = %L$q$, c), 'a line can be cleared and a currency changed');
  PERFORM pg_temp.assert_eq((SELECT currency FROM public.customers WHERE id = c), 'USD', 'the change was kept');
  PERFORM pg_temp.logout();

  -- someone without master_data.manage cannot change them
  PERFORM pg_temp.login(bob);
  PERFORM pg_temp.assert_eq(pg_temp.affected(format($q$UPDATE public.customers SET city = 'Hull' WHERE id = %L$q$, c)), 0::bigint, 'a viewer changes nothing');
  PERFORM pg_temp.assert_eq((SELECT city FROM public.customers WHERE id = c), 'Leeds', 'the town is as it was');
  PERFORM pg_temp.logout();

  -- imports: a new record takes every mapped field; an update only the mapped ones; the currency is capitalised
  v := app.import_customer(org, NULL, '{"code":"NEWCO","name":"Newco","addressLine1":"9 Road","addressLine3":"Park","city":"Hull","region":"East Yorkshire","postcode":"HU1 1AA","country":"GB","currency":"eur","email":"info@newco.test","phone":"01482 000000","website":"https://newco.test"}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT address_line1 || '|' || address_line3 || '|' || city || '|' || region || '|' || postcode || '|' || country || '|' || currency FROM public.customers WHERE id = v),
    '9 Road|Park|Hull|East Yorkshire|HU1 1AA|GB|EUR', 'an imported customer takes the address and a capitalised currency');
  PERFORM pg_temp.assert_eq((SELECT email || '|' || phone || '|' || website FROM public.customers WHERE id = v), 'info@newco.test|01482 000000|https://newco.test', 'and the company email, phone and website');
  PERFORM app.import_customer(org, v, '{"city":"York"}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT email FROM public.customers WHERE id = v), 'info@newco.test', 'an update that does not map the email leaves it');
  PERFORM pg_temp.assert_eq((SELECT city || '|' || address_line1 || '|' || currency FROM public.customers WHERE id = v), 'York|9 Road|EUR', 'an update changes only what is mapped');
  PERFORM app.import_customer(org, v, '{"currency":null}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT currency FROM public.customers WHERE id = v) IS NULL, true, 'a mapped, empty currency clears it');
  v := app.import_supplier(org, NULL, '{"code":"SUPP2","name":"Supp Two","addressLine3":"Estate","currency":"usd"}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT address_line3 || '|' || currency FROM public.suppliers WHERE id = v), 'Estate|USD', 'an imported supplier takes line 3 and the currency');
  PERFORM app.import_supplier(org, v, '{"addressLine3":"Park"}'::jsonb);
  PERFORM pg_temp.assert_eq((SELECT address_line3 || '|' || currency FROM public.suppliers WHERE id = v), 'Park|USD', 'a supplier update changes only what is mapped');
  PERFORM pg_temp.assert_fails(format($q$SELECT app.import_customer(%L, NULL, '{"code":"BAD","name":"Bad","currency":"POUNDS"}'::jsonb)$q$, org), 'a bad currency refuses the row');
END $$;

ROLLBACK;
