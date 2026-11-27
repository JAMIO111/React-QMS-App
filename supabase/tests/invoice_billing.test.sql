-- IV1 (docs/invoice-billing-plan.md): paying by invoice. The route and the billing details recorded when it is applied, the one-invoiced-organisation-per-company rule (and the
-- operator's way round it), the seat cap while anything is owed, reporting keys closed until the first invoice is paid, access stopping when an invoice is overdue past its grace, the
-- operator alerts and controls, and that a card organisation is not touched by any of it.
\set ON_ERROR_STOP 1
BEGIN;
\ir helpers.sql

INSERT INTO auth.users (id, email) VALUES
  ('4f000000-0000-0000-0000-000000000c01', 'owner@iv1.test'),
  ('4f000000-0000-0000-0000-000000000c02', 'viewer@iv1.test'),
  ('4f000000-0000-0000-0000-000000000c03', 'cardowner@iv1.test'),
  ('4f000000-0000-0000-0000-000000000c04', 'second@iv1.test'),
  ('4f000000-0000-0000-0000-000000000c05', 'operator@iv1.test');

CREATE FUNCTION pg_temp.api_apply(p_org uuid, p_snapshot jsonb, p_at timestamptz, p_session text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  PERFORM set_config('role', 'qms_api', true);
  BEGIN
    r := app.stripe_apply_subscription(p_org, p_snapshot, p_at, p_session);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('role', 'postgres', true);
    RAISE;
  END;
  PERFORM set_config('role', 'postgres', true);
  RETURN r;
END $$;

-- The API login runs a statement; the answer is whatever the function gives.
CREATE FUNCTION pg_temp.as_api_json(stmt text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  PERFORM set_config('role', 'qms_api', true);
  BEGIN
    EXECUTE stmt INTO r;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('role', 'postgres', true);
    RAISE;
  END;
  PERFORM set_config('role', 'postgres', true);
  RETURN r;
END $$;

CREATE FUNCTION pg_temp.as_api_int(stmt text) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE r integer;
BEGIN
  PERFORM set_config('role', 'qms_api', true);
  BEGIN
    EXECUTE stmt INTO r;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('role', 'postgres', true);
    RAISE;
  END;
  PERFORM set_config('role', 'postgres', true);
  RETURN r;
END $$;

-- The error code a statement fails with ('' when it succeeds).
CREATE FUNCTION pg_temp.state_of(stmt text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE stmt;
  RETURN '';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE;
END $$;

-- An invoice as the API would hand it over (days = how many days from today it is due; negative = already past).
CREATE FUNCTION pg_temp.api_invoice(p_org uuid, p_id text, p_status text, p_total bigint, p_due_in_days integer) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('role', 'qms_api', true);
  BEGIN
    PERFORM app.stripe_apply_invoice(p_org, jsonb_build_object('id', p_id, 'number', 'INV-' || right(p_id, 4), 'status', p_status, 'currency', 'gbp', 'subtotal', p_total, 'tax', 0, 'total', p_total,
      'periodStart', now(), 'periodEnd', now() + interval '1 month', 'created', (now() AT TIME ZONE 'UTC')::date, 'dueDate', (now() AT TIME ZONE 'UTC')::date + p_due_in_days,
      'paidAt', CASE WHEN p_status = 'paid' THEN to_jsonb(now()) END, 'pdfUrl', NULL));
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('role', 'postgres', true);
    RAISE;
  END;
  PERFORM set_config('role', 'postgres', true);
END $$;

-- A subscription snapshot; method 'send_invoice' makes it an invoiced one.
CREATE FUNCTION pg_temp.snap(p_id text, p_status text, p_controller integer, p_contributor integer, p_method text, p_customer text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', p_id, 'customerId', p_customer, 'status', p_status, 'interval', 'month', 'currency', 'gbp',
    'currentPeriodStart', now(), 'currentPeriodEnd', now() + interval '30 days', 'trialStart', NULL, 'trialEnd', NULL, 'cancelAtPeriodEnd', false, 'canceledAt', NULL,
    'collectionMethod', p_method, 'daysUntilDue', CASE WHEN p_method = 'send_invoice' THEN 14 END,
    'items', (SELECT jsonb_agg(i) FROM (
       SELECT jsonb_build_object('priceId', 'price_ctrl_month', 'quantity', p_controller) AS i WHERE p_controller IS NOT NULL
       UNION ALL SELECT jsonb_build_object('priceId', 'price_contrib_month', 'quantity', p_contributor) WHERE p_contributor > 0) x))
$$;

DO $$
DECLARE
  u_owner uuid := '4f000000-0000-0000-0000-000000000c01'; u_view uuid := '4f000000-0000-0000-0000-000000000c02'; u_card uuid := '4f000000-0000-0000-0000-000000000c03';
  u_second uuid := '4f000000-0000-0000-0000-000000000c04'; u_op uuid := '4f000000-0000-0000-0000-000000000c05';
  org uuid; org_card uuid; org2 uuid; owner_role uuid; viewer_role uuid; m_view uuid; r jsonb; details jsonb; sub public.organisation_subscriptions%ROWTYPE; n integer;
BEGIN
  UPDATE public.platform_settings SET value = 'true'::jsonb WHERE key = 'billing_gate_enabled';
  UPDATE public.subscription_prices SET provider_price_id = CASE
    WHEN subscription_plan_id = (SELECT id FROM public.subscription_plans WHERE slug = 'controller') AND billing_interval = 'month' THEN 'price_ctrl_month'
    WHEN subscription_plan_id = (SELECT id FROM public.subscription_plans WHERE slug = 'contributor') AND billing_interval = 'month' THEN 'price_contrib_month' END
  WHERE active AND effective_to IS NULL AND currency = 'GBP';

  PERFORM pg_temp.login(u_owner);
  org := app.start_organisation('Acme Works', 'Plant A', 'PA', 'Europe/London', 'GB', NULL);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_card);
  org_card := app.start_organisation('Card Works', 'Plant C', 'PC', 'Europe/London', 'GB', NULL);
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_second);
  org2 := app.start_organisation('Acme Second', 'Plant S', 'PS', 'Europe/London', 'GB', NULL);
  PERFORM pg_temp.logout();
  SELECT id INTO viewer_role FROM public.roles WHERE organisation_id = org AND key = 'viewer';
  INSERT INTO public.organisation_users (organisation_id, user_id, status) VALUES (org, u_view, 'active') RETURNING id INTO m_view;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) VALUES (org, m_view, viewer_role);
  INSERT INTO public.platform_admins (user_id, note) VALUES (u_op, 'test operator');

  -- Privileges: starting an invoice and the alert job are for the API login only; the question and the form check are for people; the operator's functions refuse anyone else.
  PERFORM pg_temp.assert_eq(has_function_privilege('qms_api', 'app.stripe_start_invoice(uuid, uuid, text, text, jsonb, jsonb)', 'EXECUTE'), true, 'the API login can start an invoiced subscription');
  PERFORM pg_temp.assert_eq(has_function_privilege('authenticated', 'app.stripe_start_invoice(uuid, uuid, text, text, jsonb, jsonb)', 'EXECUTE'), false, 'a signed-in person cannot');
  PERFORM pg_temp.assert_eq(has_function_privilege('authenticated', 'app.system_invoice_overdue_alerts()', 'EXECUTE'), false, 'nor run the alert job');
  PERFORM pg_temp.assert_eq(has_function_privilege('anon', 'app.invoice_first_payment_pending(uuid)', 'EXECUTE'), false, 'anonymous cannot ask whether an invoice is unpaid');
  PERFORM pg_temp.assert_eq(has_function_privilege('anon', 'app.platform_invoice_accounts(integer)', 'EXECUTE'), false, 'nor read the operator list');
  PERFORM pg_temp.assert_eq(has_function_privilege('authenticated', 'app.invoice_first_payment_pending_internal(uuid)', 'EXECUTE'), false, 'the unchecked form is not open to people');

  -- Company identity.
  PERFORM pg_temp.assert_eq(app.company_key('Acme Ltd.'), 'acme', 'Ltd and punctuation do not matter');
  PERFORM pg_temp.assert_eq(app.company_key('ACME  limited'), 'acme', 'nor case, spaces or Limited');
  PERFORM pg_temp.assert_eq(app.company_key('Smith & Sons Limited'), 'smithandsons', 'an ampersand is "and"');
  PERFORM pg_temp.assert_eq(app.vat_key('gb 123 456 789'), 'GB123456789', 'a VAT number without spaces, in capitals');
  PERFORM pg_temp.assert_eq(app.vat_key('  '), NULL::text, 'an empty VAT number is none');

  -- The form's check: an owner may ask; a viewer may not.
  PERFORM pg_temp.login(u_owner);
  PERFORM pg_temp.assert_eq(app.check_invoice_company(org, 'Acme Ltd', 'GB123456789'), ARRAY[]::text[], 'a company nobody else has is fine');
  PERFORM pg_temp.assert_eq(cardinality(app.check_invoice_company(org, '  ', NULL)) >= 1, true, 'a company needs a name');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_view);
  PERFORM pg_temp.assert_fails(format($q$SELECT app.check_invoice_company(%L, 'Acme Ltd', NULL)$q$, org), 'a viewer cannot ask');
  PERFORM pg_temp.logout();

  -- Starting: only an owner, with a company and an address; a retry is the same record.
  details := '{"legalName":"Acme Ltd","billingEmail":"Accounts@Acme.Test","addressLine1":"1 High Street","city":"Leeds","postcode":"LS1 1AA","country":"GB","vatNumber":"GB 123 456 789","poReference":"PO-77"}'::jsonb;
  PERFORM pg_temp.assert_fails(format($q$SELECT pg_temp.as_api_json(format('SELECT app.stripe_start_invoice(%%L, %%L, %%L, %%L, %%L, %%L)', %L, %L, 'key-viewer', 'month', '{"controller":1}', %L))$q$, org, u_view, details::text),
    'a viewer cannot start an invoiced subscription');
  PERFORM pg_temp.assert_fails(format($q$SELECT pg_temp.as_api_json(format('SELECT app.stripe_start_invoice(%%L, %%L, %%L, %%L, %%L, %%L)', %L, %L, 'key-bad', 'month', '{"controller":1}', %L))$q$, org, u_owner, (details - 'addressLine1')::text),
    'a billing address is required');
  PERFORM pg_temp.assert_fails(format($q$SELECT pg_temp.as_api_json(format('SELECT app.stripe_start_invoice(%%L, %%L, %%L, %%L, %%L, %%L)', %L, %L, 'key-bad', 'month', '{"controller":1}', %L))$q$, org, u_owner, (details || '{"billingEmail":"not an email"}')::text),
    'a billing email is required');
  PERFORM pg_temp.assert_fails(format($q$SELECT pg_temp.as_api_json(format('SELECT app.stripe_start_invoice(%%L, %%L, %%L, %%L, %%L, %%L)', %L, %L, 'key-bad', 'month', '{"controller":1}', %L))$q$, org, u_owner, (details || '{"country":"United Kingdom"}')::text),
    'a country is two capitals');
  r := pg_temp.as_api_json(format($q$SELECT app.stripe_start_invoice(%L, %L, 'key-one', 'month', '{"controller":2}', %L)$q$, org, u_owner, details::text));
  PERFORM pg_temp.assert_eq((r ->> 'created')::boolean, true, 'the start is recorded');
  PERFORM pg_temp.assert_eq(r ->> 'sessionId', 'inv_key-one', 'under an id we made');
  PERFORM pg_temp.assert_eq((SELECT billing_details ->> 'vatNumber' FROM public.stripe_checkout_sessions WHERE provider_session_id = 'inv_key-one'), 'GB123456789', 'the VAT number is kept tidy');
  PERFORM pg_temp.assert_eq((SELECT billing_details ->> 'billingEmail' FROM public.stripe_checkout_sessions WHERE provider_session_id = 'inv_key-one'), 'accounts@acme.test', 'and the email in lower case');
  r := pg_temp.as_api_json(format($q$SELECT app.stripe_start_invoice(%L, %L, 'key-one', 'month', '{"controller":2}', %L)$q$, org, u_owner, details::text));
  PERFORM pg_temp.assert_eq((r ->> 'created')::boolean, false, 'a retry with the same key is the same start');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.stripe_checkout_sessions WHERE organisation_id = org), 1::bigint, 'not a second record');
  -- Before the subscription exists, the same attempt with corrected details (a refused VAT number, say) replaces the stored ones.
  r := pg_temp.as_api_json(format($q$SELECT app.stripe_start_invoice(%L, %L, 'key-one', 'month', '{"controller":2}', %L)$q$, org, u_owner, (details || '{"vatNumber":"GB 999 888 777"}')::text));
  PERFORM pg_temp.assert_eq((r ->> 'created')::boolean, false, 'a corrected retry is still the same attempt');
  PERFORM pg_temp.assert_eq((SELECT billing_details ->> 'vatNumber' FROM public.stripe_checkout_sessions WHERE provider_session_id = 'inv_key-one'), 'GB999888777', 'with the corrected VAT number');
  PERFORM pg_temp.as_api_json(format($q$SELECT app.stripe_start_invoice(%L, %L, 'key-one', 'month', '{"controller":2}', %L)$q$, org, u_owner, details::text));

  -- Applying: the route, terms, company and PO are stored; 3 days' grace; the operators are told.
  PERFORM pg_temp.assert_eq((SELECT grace_period_days FROM public.organisation_settings WHERE organisation_id = org), 7, 'a new organisation has the usual 7 days');
  r := pg_temp.api_apply(org, pg_temp.snap('sub_iv1', 'active', 2, 0, 'send_invoice', 'cus_iv1test'), now(), 'inv_key-one');
  SELECT * INTO sub FROM public.organisation_subscriptions WHERE organisation_id = org;
  PERFORM pg_temp.assert_eq((sub.collection_method, sub.payment_terms_days, sub.billing_legal_name, sub.billing_company_key, sub.billing_vat_number, sub.purchase_order, sub.billing_contact_email)::text,
    '(invoice,14,"Acme Ltd",acme,GB123456789,PO-77,accounts@acme.test)', 'the invoice route and the company are stored');
  PERFORM pg_temp.assert_eq(sub.status, 'active', 'active the moment it starts (no trial)');
  PERFORM pg_temp.assert_eq((SELECT grace_period_days FROM public.organisation_settings WHERE organisation_id = org), 3, 'three days of grace for an invoiced organisation');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.platform_invoice_alerts WHERE organisation_id = org AND kind = 'started'), 1::bigint, 'the operators are told it started');
  PERFORM pg_temp.assert_eq(app.organisation_access_open(org), true, 'the organisation is open');
  r := pg_temp.api_apply(org, pg_temp.snap('sub_iv1', 'active', 2, 0, 'send_invoice', 'cus_iv1test'), now() + interval '1 minute');
  PERFORM pg_temp.assert_eq((SELECT collection_method FROM public.organisation_subscriptions WHERE organisation_id = org), 'invoice', 'a later snapshot keeps the route');
  PERFORM pg_temp.assert_eq((SELECT billing_legal_name FROM public.organisation_subscriptions WHERE organisation_id = org), 'Acme Ltd', 'and the company (a webhook carries no details)');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.platform_invoice_alerts WHERE organisation_id = org AND kind = 'started'), 1::bigint, 'and tells the operators once');
  PERFORM pg_temp.assert_fails(format($q$SELECT pg_temp.as_api_json(format('SELECT app.stripe_start_invoice(%%L, %%L, %%L, %%L, %%L, %%L)', %L, %L, 'key-two', 'month', '{"controller":1}', %L))$q$, org, u_owner, details::text),
    'a second start is refused while the subscription is live');

  -- A card organisation is untouched: same defaults, no invoice rules, no alert.
  PERFORM pg_temp.as_api_json(format($q$SELECT to_jsonb(app.stripe_start_checkout(%L, %L, 'cs_test_card1', 'month', '{"controller":1}'))$q$, org_card, u_card));
  r := pg_temp.api_apply(org_card, pg_temp.snap('sub_card', 'active', 1, 0, 'charge_automatically', 'cus_iv1card'), now(), 'cs_test_card1');
  PERFORM pg_temp.assert_eq((SELECT collection_method FROM public.organisation_subscriptions WHERE organisation_id = org_card), 'card', 'a card organisation is a card organisation');
  PERFORM pg_temp.assert_eq((SELECT grace_period_days FROM public.organisation_settings WHERE organisation_id = org_card), 7, 'with its seven days of grace');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.platform_invoice_alerts WHERE organisation_id = org_card), 0::bigint, 'and no alert');
  PERFORM pg_temp.assert_eq(app.invoice_first_payment_pending_internal(org_card), false, 'it never reads as waiting for a first invoice');
  PERFORM pg_temp.api_invoice(org_card, 'in_card_old', 'open', 5000, -30);
  PERFORM pg_temp.assert_eq(app.organisation_access_open(org_card), true, 'an old open invoice on a card organisation does not lock it');
  PERFORM pg_temp.login(u_card);
  PERFORM pg_temp.assert_eq(cardinality(app.check_seat_change(org_card, '{"controller":3}'::jsonb)), 0, 'and does not stop seats being added');
  PERFORM pg_temp.logout();

  -- One invoiced organisation per company.
  PERFORM pg_temp.login(u_second);
  PERFORM pg_temp.assert_eq(cardinality(app.check_invoice_company(org2, 'ACME limited.', NULL)) >= 1, true, 'the same company under another spelling is refused');
  PERFORM pg_temp.assert_eq(cardinality(app.check_invoice_company(org2, 'A Different Name Ltd', 'GB 123456789')) >= 1, true, 'so is the same VAT number');
  PERFORM pg_temp.assert_eq(app.check_invoice_company(org2, 'A Different Name Ltd', 'GB999999999'), ARRAY[]::text[], 'a different company is fine');
  PERFORM pg_temp.assert_eq((app.check_invoice_company(org2, 'Acme Ltd', NULL))[1] LIKE '%already exists%', true, 'the message says what to do');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_fails(format($q$SELECT pg_temp.as_api_json(format('SELECT app.stripe_start_invoice(%%L, %%L, %%L, %%L, %%L, %%L)', %L, %L, 'key-dup', 'month', '{"controller":1}', %L))$q$, org2, u_second, details::text),
    'starting with the same company is refused');
  -- The database backstop: even if two applied at once, the second cannot be stored.
  PERFORM pg_temp.as_api_json(format($q$SELECT to_jsonb(app.stripe_start_checkout(%L, %L, 'cs_test_second', 'month', '{"controller":1}'))$q$, org2, u_second));
  PERFORM pg_temp.api_apply(org2, pg_temp.snap('sub_second', 'active', 1, 0, 'charge_automatically', 'cus_iv1second'), now(), 'cs_test_second');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.organisation_subscriptions SET collection_method = 'invoice', billing_company_key = 'acme' WHERE organisation_id = %L$q$, org2),
    'the table itself refuses a second invoiced subscription for the same company');
  PERFORM pg_temp.assert_fails(format($q$UPDATE public.organisation_subscriptions SET collection_method = 'invoice', billing_vat_number = 'GB123456789' WHERE organisation_id = %L$q$, org2),
    'or the same VAT number');
  -- Only an operator can lift it.
  PERFORM pg_temp.login(u_second);
  PERFORM pg_temp.assert_fails(format($q$SELECT app.set_invoice_company_exempt(%L, true, 'we own both')$q$, org2), 'an owner cannot lift the block themselves');
  PERFORM pg_temp.logout();
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u_op, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  PERFORM set_config('role', 'authenticated', true);
  PERFORM pg_temp.assert_fails(format($q$SELECT app.set_invoice_company_exempt(%L, true, ' ')$q$, org2), 'the operator must give a reason');
  PERFORM app.set_invoice_company_exempt(org2, true, 'A separate legal entity, checked with them');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.assert_eq((SELECT invoice_company_exempt FROM public.organisations WHERE id = org2), true, 'the block is lifted for that organisation');
  PERFORM pg_temp.assert_ok(format($q$UPDATE public.organisation_subscriptions SET collection_method = 'invoice', billing_company_key = 'acme' WHERE organisation_id = %L$q$, org2), 'and it can then be invoiced for the same company');
  UPDATE public.organisation_subscriptions SET collection_method = 'card', billing_company_key = NULL WHERE organisation_id = org2;

  -- The operator can switch invoicing off for an organisation.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u_op, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  PERFORM set_config('role', 'authenticated', true);
  PERFORM app.set_invoice_billing_allowed(org_card, false, 'Not a business account');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_card);
  PERFORM pg_temp.assert_eq((app.check_invoice_company(org_card, 'Card Works Ltd', NULL))[1] LIKE '%not available%', true, 'the form is told it is not available');
  PERFORM pg_temp.logout();

  -- Reporting keys and the seat cap while the first invoice is unpaid. (An open invoice, due in ten days.)
  PERFORM pg_temp.api_invoice(org, 'in_iv1_first', 'open', 6000, 10);
  PERFORM pg_temp.assert_eq(app.invoice_first_payment_pending_internal(org), true, 'the first invoice is not paid');
  -- The hosted payment page is kept on the invoice (an https address only), by the API login.
  PERFORM pg_temp.assert_eq(pg_temp.as_api_int(format($q$SELECT 1 FROM (SELECT app.stripe_set_invoice_url(%L, 'in_iv1_first', 'https://invoice.stripe.test/i/in_iv1_first')) s$q$, org)), 1, 'the API can store the payment page address');
  PERFORM pg_temp.assert_eq((SELECT hosted_invoice_url FROM public.billing_invoices WHERE provider_invoice_id = 'in_iv1_first'), 'https://invoice.stripe.test/i/in_iv1_first', 'on the invoice');
  PERFORM pg_temp.assert_fails(format($q$SELECT pg_temp.as_api_int(format('SELECT 1 FROM (SELECT app.stripe_set_invoice_url(%%L, ''in_iv1_first'', ''http://insecure.test/'')) s', %L))$q$, org), 'an address that is not https is refused');
  PERFORM pg_temp.assert_eq(has_function_privilege('authenticated', 'app.stripe_set_invoice_url(uuid, text, text)', 'EXECUTE'), false, 'and a signed-in person cannot store one');
  PERFORM pg_temp.login(u_owner);
  PERFORM pg_temp.assert_eq(app.invoice_first_payment_pending(org), true, 'a member can ask');
  PERFORM pg_temp.assert_eq(app.has_permission(org, 'integrations.manage'), true, 'the owner holds a Controller seat, so reporting keys are theirs to make');
  PERFORM pg_temp.assert_eq(pg_temp.state_of(format($q$SELECT app.create_reporting_key(%L, 'Power BI', 365, %L, 'abcd1234')$q$, org, repeat('a', 64))), 'QM040', 'but not yet: available once the first invoice is paid');
  PERFORM pg_temp.assert_eq(cardinality(app.check_seat_change(org, '{"controller":2,"contributor":1}'::jsonb)), 1, 'seats cannot be added while the invoice is open');
  PERFORM pg_temp.assert_eq((app.check_seat_change(org, '{"controller":2,"contributor":1}'::jsonb))[1] LIKE '%INV-irst%', true, 'the message names the invoice');
  PERFORM pg_temp.assert_eq(cardinality(app.check_seat_change(org, '{"controller":2,"contributor":0}'::jsonb)), 0, 'the same seats are fine');
  PERFORM pg_temp.assert_eq(cardinality(app.check_seat_change(org, '{"controller":1}'::jsonb)), 0, 'removing a seat is always allowed');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_card);
  PERFORM pg_temp.assert_eq(app.invoice_first_payment_pending(org), false, 'a stranger cannot learn it for another organisation');
  PERFORM pg_temp.logout();

  -- The operators are told when the first invoice passes its due date, once.
  PERFORM pg_temp.assert_eq(pg_temp.as_api_int('SELECT app.system_invoice_overdue_alerts()'), 0, 'nothing is overdue yet');
  UPDATE public.billing_invoices SET due_date = (now() AT TIME ZONE 'UTC')::date - 1 WHERE organisation_id = org;
  PERFORM pg_temp.assert_eq(pg_temp.as_api_int('SELECT app.system_invoice_overdue_alerts()'), 1, 'one overdue first invoice');
  PERFORM pg_temp.assert_eq(pg_temp.as_api_int('SELECT app.system_invoice_overdue_alerts()'), 0, 'and only once');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.platform_invoice_alerts WHERE kind = 'first_invoice_overdue'), 1::bigint, 'recorded for the operators');
  PERFORM pg_temp.assert_eq(app.organisation_access_open(org), true, 'a day late is inside the three days of grace');

  -- The operator's list.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u_op, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  PERFORM set_config('role', 'authenticated', true);
  SELECT count(*) INTO n FROM app.platform_invoice_accounts();
  PERFORM pg_temp.assert_eq(n >= 1, true, 'the operator sees invoiced organisations');
  PERFORM pg_temp.assert_eq((SELECT (first_invoice_paid, open_invoices, open_amount_pence, overdue_days, legal_name)::text FROM app.platform_invoice_accounts() WHERE organisation_id = org),
    '(f,1,6000,1,"Acme Ltd")', 'first invoice unpaid, one open for £60.00, a day late');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.platform_invoice_alerts), 2::bigint, 'the operator reads the alerts');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.login(u_owner);
  PERFORM pg_temp.assert_fails($q$SELECT * FROM app.platform_invoice_accounts()$q$, 'an owner cannot read the operator list');
  PERFORM pg_temp.assert_eq((SELECT count(*) FROM public.platform_invoice_alerts), 0::bigint, 'nor the alerts');
  PERFORM pg_temp.logout();

  -- Access stops when the invoice is overdue past the grace, whatever Stripe says: the subscription is still "active".
  UPDATE public.billing_invoices SET due_date = (now() AT TIME ZONE 'UTC')::date - 5 WHERE organisation_id = org;
  PERFORM pg_temp.assert_eq((SELECT status FROM public.organisation_subscriptions WHERE organisation_id = org), 'active', 'Stripe still calls it active');
  PERFORM pg_temp.assert_eq(app.organisation_access_open(org), false, 'but five days past due with three days of grace, access has stopped');
  PERFORM pg_temp.login(u_owner);
  PERFORM pg_temp.assert_eq(app.organisation_access_state(org), 'lapsed', 'the owner sees it as lapsed');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.api_invoice(org, 'in_iv1_first', 'paid', 6000, -5);
  PERFORM pg_temp.assert_eq(app.organisation_access_open(org), true, 'paying the invoice opens it again at once');
  PERFORM pg_temp.assert_eq(app.invoice_first_payment_pending_internal(org), false, 'and the first invoice is paid');

  -- With the first invoice paid: reporting keys and seats are open (while nothing is owed).
  PERFORM pg_temp.login(u_owner);
  PERFORM pg_temp.assert_eq(pg_temp.state_of(format($q$SELECT app.create_reporting_key(%L, 'Power BI', 365, %L, 'abcd1234')$q$, org, repeat('b', 64))), '', 'a reporting key can be made');
  PERFORM pg_temp.assert_eq(cardinality(app.check_seat_change(org, '{"controller":2,"contributor":1}'::jsonb)), 0, 'and seats can be added');
  PERFORM pg_temp.logout();
  -- ...but a second open invoice (an unpaid increase) stops the next increase, and a paid one does not.
  PERFORM pg_temp.api_invoice(org, 'in_iv1_second', 'open', 2000, 14);
  PERFORM pg_temp.login(u_owner);
  PERFORM pg_temp.assert_eq(cardinality(app.check_seat_change(org, '{"controller":2,"contributor":1}'::jsonb)), 1, 'while any invoice is open, no further increase');
  PERFORM pg_temp.assert_eq(pg_temp.state_of(format($q$SELECT app.create_reporting_key(%L, 'Second', 365, %L, 'efgh5678')$q$, org, repeat('c', 64))), '', 'reporting keys stay open once the first invoice is paid');
  PERFORM pg_temp.logout();
  PERFORM pg_temp.api_invoice(org, 'in_iv1_second', 'paid', 2000, 14);
  PERFORM pg_temp.login(u_owner);
  PERFORM pg_temp.assert_eq(cardinality(app.check_seat_change(org, '{"controller":2,"contributor":1}'::jsonb)), 0, 'paid, seats can go up again');
  PERFORM pg_temp.logout();

  -- Back to card (at a renewal, by starting a card subscription): the grace is the usual seven days again.
  r := pg_temp.api_apply(org, pg_temp.snap('sub_iv1', 'active', 2, 0, 'charge_automatically', 'cus_iv1test'), now() + interval '2 minutes');
  PERFORM pg_temp.assert_eq((SELECT collection_method FROM public.organisation_subscriptions WHERE organisation_id = org), 'card', 'the route can change when the subscription does');
  PERFORM pg_temp.assert_eq((SELECT grace_period_days FROM public.organisation_settings WHERE organisation_id = org), 7, 'with the card grace again');
  PERFORM pg_temp.assert_eq(app.invoice_first_payment_pending_internal(org), false, 'and it is no longer an invoiced organisation');
END $$;

ROLLBACK;
