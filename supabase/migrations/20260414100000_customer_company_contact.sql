-- Customers get the company's general email, phone and website, as suppliers already have.
-- These are the company's own general line (a switchboard, info@, the web site), not a person: named people, each with their own email and phone, are kept
-- in the contacts (supplier_contacts, customer_contacts), as many as are needed with one primary.
-- Same shape and limits as the supplier columns, written by the same column-level UPDATE grant.

ALTER TABLE public.customers
  ADD COLUMN email text CHECK (email IS NULL OR length(btrim(email)) BETWEEN 3 AND 200),
  ADD COLUMN phone text CHECK (phone IS NULL OR length(btrim(phone)) BETWEEN 3 AND 40),
  ADD COLUMN website text CHECK (website IS NULL OR length(btrim(website)) BETWEEN 1 AND 200);

GRANT UPDATE (email, phone, website) ON public.customers TO authenticated;

-- Imports of customers take the three fields too (an update changes only the mapped ones).
CREATE OR REPLACE FUNCTION app.import_customer(p_org uuid, p_id uuid, d jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid;
BEGIN
  IF p_id IS NULL THEN
    INSERT INTO public.customers (organisation_id, code, name, display_name, company_number, vat_number, notes, active,
                                  address_line1, address_line2, address_line3, city, region, postcode, country, currency, email, phone, website)
    VALUES (p_org, app.imp_text(d, 'code'), app.imp_text(d, 'name'), app.imp_text(d, 'displayName'), app.imp_text(d, 'companyNumber'), app.imp_text(d, 'vatNumber'),
            app.imp_text(d, 'notes'), coalesce(app.imp_bool(d, 'active'), true),
            app.imp_text(d, 'addressLine1'), app.imp_text(d, 'addressLine2'), app.imp_text(d, 'addressLine3'), app.imp_text(d, 'city'), app.imp_text(d, 'region'),
            app.imp_text(d, 'postcode'), app.imp_text(d, 'country'), upper(app.imp_text(d, 'currency')), app.imp_text(d, 'email'), app.imp_text(d, 'phone'), app.imp_text(d, 'website'))
    RETURNING id INTO v_id;
    RETURN v_id;
  END IF;
  UPDATE public.customers SET
    code = CASE WHEN d ? 'code' THEN app.imp_text(d, 'code') ELSE code END,
    name = CASE WHEN d ? 'name' THEN app.imp_text(d, 'name') ELSE name END,
    display_name = CASE WHEN d ? 'displayName' THEN app.imp_text(d, 'displayName') ELSE display_name END,
    company_number = CASE WHEN d ? 'companyNumber' THEN app.imp_text(d, 'companyNumber') ELSE company_number END,
    vat_number = CASE WHEN d ? 'vatNumber' THEN app.imp_text(d, 'vatNumber') ELSE vat_number END,
    notes = CASE WHEN d ? 'notes' THEN app.imp_text(d, 'notes') ELSE notes END,
    active = CASE WHEN d ? 'active' THEN coalesce(app.imp_bool(d, 'active'), active) ELSE active END,
    address_line1 = CASE WHEN d ? 'addressLine1' THEN app.imp_text(d, 'addressLine1') ELSE address_line1 END,
    address_line2 = CASE WHEN d ? 'addressLine2' THEN app.imp_text(d, 'addressLine2') ELSE address_line2 END,
    address_line3 = CASE WHEN d ? 'addressLine3' THEN app.imp_text(d, 'addressLine3') ELSE address_line3 END,
    city = CASE WHEN d ? 'city' THEN app.imp_text(d, 'city') ELSE city END,
    region = CASE WHEN d ? 'region' THEN app.imp_text(d, 'region') ELSE region END,
    postcode = CASE WHEN d ? 'postcode' THEN app.imp_text(d, 'postcode') ELSE postcode END,
    country = CASE WHEN d ? 'country' THEN app.imp_text(d, 'country') ELSE country END,
    currency = CASE WHEN d ? 'currency' THEN upper(app.imp_text(d, 'currency')) ELSE currency END,
    email = CASE WHEN d ? 'email' THEN app.imp_text(d, 'email') ELSE email END,
    phone = CASE WHEN d ? 'phone' THEN app.imp_text(d, 'phone') ELSE phone END,
    website = CASE WHEN d ? 'website' THEN app.imp_text(d, 'website') ELSE website END,
    updated_at = now(), updated_by = auth.uid()
  WHERE id = p_id AND organisation_id = p_org RETURNING id INTO v_id;
  IF v_id IS NULL THEN RAISE EXCEPTION 'The customer this record was linked to no longer exists' USING ERRCODE = 'QM022'; END IF;
  RETURN v_id;
END $$;

