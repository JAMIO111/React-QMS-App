-- Customers and suppliers get a full postal address and a currency.
-- Suppliers already had address line 1 and 2, city, region (county or state), postcode and country (supplier quality register); they gain address line 3 and a
-- currency. Customers gain all of them. The currency is the one the organisation trades with them in (an ISO 4217 code such as GBP); it is information for
-- people and for imports and does not change how totals are worked out (those stay in the organisation's base currency).
-- Every column is optional and written by the same column-level UPDATE grant as the other descriptive columns.

ALTER TABLE public.customers
  ADD COLUMN address_line1 text CHECK (address_line1 IS NULL OR length(btrim(address_line1)) BETWEEN 1 AND 120),
  ADD COLUMN address_line2 text CHECK (address_line2 IS NULL OR length(btrim(address_line2)) BETWEEN 1 AND 120),
  ADD COLUMN address_line3 text CHECK (address_line3 IS NULL OR length(btrim(address_line3)) BETWEEN 1 AND 120),
  ADD COLUMN city text CHECK (city IS NULL OR length(btrim(city)) BETWEEN 1 AND 80),
  ADD COLUMN region text CHECK (region IS NULL OR length(btrim(region)) BETWEEN 1 AND 80),
  ADD COLUMN postcode text CHECK (postcode IS NULL OR length(btrim(postcode)) BETWEEN 1 AND 20),
  ADD COLUMN country text CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  ADD COLUMN currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$');

ALTER TABLE public.suppliers
  ADD COLUMN address_line3 text CHECK (address_line3 IS NULL OR length(btrim(address_line3)) BETWEEN 1 AND 120),
  ADD COLUMN currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$');

GRANT UPDATE (address_line1, address_line2, address_line3, city, region, postcode, country, currency) ON public.customers TO authenticated;
GRANT UPDATE (address_line3, currency) ON public.suppliers TO authenticated;

-- Imports: the same fields, written when the file maps them (an update changes only the mapped fields; a currency code is kept in capitals).
CREATE OR REPLACE FUNCTION app.import_customer(p_org uuid, p_id uuid, d jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid;
BEGIN
  IF p_id IS NULL THEN
    INSERT INTO public.customers (organisation_id, code, name, display_name, company_number, vat_number, notes, active,
                                  address_line1, address_line2, address_line3, city, region, postcode, country, currency)
    VALUES (p_org, app.imp_text(d, 'code'), app.imp_text(d, 'name'), app.imp_text(d, 'displayName'), app.imp_text(d, 'companyNumber'), app.imp_text(d, 'vatNumber'),
            app.imp_text(d, 'notes'), coalesce(app.imp_bool(d, 'active'), true),
            app.imp_text(d, 'addressLine1'), app.imp_text(d, 'addressLine2'), app.imp_text(d, 'addressLine3'), app.imp_text(d, 'city'), app.imp_text(d, 'region'),
            app.imp_text(d, 'postcode'), app.imp_text(d, 'country'), upper(app.imp_text(d, 'currency')))
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
    updated_at = now(), updated_by = auth.uid()
  WHERE id = p_id AND organisation_id = p_org RETURNING id INTO v_id;
  IF v_id IS NULL THEN RAISE EXCEPTION 'The customer this record was linked to no longer exists' USING ERRCODE = 'QM022'; END IF;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION app.import_supplier(p_org uuid, p_id uuid, d jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid;
BEGIN
  IF p_id IS NULL THEN
    INSERT INTO public.suppliers (organisation_id, code, name, display_name, company_number, vat_number, notes, active, supplier_type, email, phone, website,
                                  address_line1, address_line2, address_line3, city, region, postcode, country, currency, purchasing_reference)
    VALUES (p_org, app.imp_text(d, 'code'), app.imp_text(d, 'name'), app.imp_text(d, 'displayName'), app.imp_text(d, 'companyNumber'), app.imp_text(d, 'vatNumber'),
            app.imp_text(d, 'notes'), coalesce(app.imp_bool(d, 'active'), true), app.imp_text(d, 'supplierType'), app.imp_text(d, 'email'), app.imp_text(d, 'phone'),
            app.imp_text(d, 'website'), app.imp_text(d, 'addressLine1'), app.imp_text(d, 'addressLine2'), app.imp_text(d, 'addressLine3'), app.imp_text(d, 'city'),
            app.imp_text(d, 'region'), app.imp_text(d, 'postcode'), app.imp_text(d, 'country'), upper(app.imp_text(d, 'currency')), app.imp_text(d, 'purchasingReference'))
    RETURNING id INTO v_id;
    RETURN v_id;
  END IF;
  UPDATE public.suppliers SET
    code = CASE WHEN d ? 'code' THEN app.imp_text(d, 'code') ELSE code END,
    name = CASE WHEN d ? 'name' THEN app.imp_text(d, 'name') ELSE name END,
    display_name = CASE WHEN d ? 'displayName' THEN app.imp_text(d, 'displayName') ELSE display_name END,
    company_number = CASE WHEN d ? 'companyNumber' THEN app.imp_text(d, 'companyNumber') ELSE company_number END,
    vat_number = CASE WHEN d ? 'vatNumber' THEN app.imp_text(d, 'vatNumber') ELSE vat_number END,
    notes = CASE WHEN d ? 'notes' THEN app.imp_text(d, 'notes') ELSE notes END,
    active = CASE WHEN d ? 'active' THEN coalesce(app.imp_bool(d, 'active'), active) ELSE active END,
    supplier_type = CASE WHEN d ? 'supplierType' THEN app.imp_text(d, 'supplierType') ELSE supplier_type END,
    email = CASE WHEN d ? 'email' THEN app.imp_text(d, 'email') ELSE email END,
    phone = CASE WHEN d ? 'phone' THEN app.imp_text(d, 'phone') ELSE phone END,
    website = CASE WHEN d ? 'website' THEN app.imp_text(d, 'website') ELSE website END,
    address_line1 = CASE WHEN d ? 'addressLine1' THEN app.imp_text(d, 'addressLine1') ELSE address_line1 END,
    address_line2 = CASE WHEN d ? 'addressLine2' THEN app.imp_text(d, 'addressLine2') ELSE address_line2 END,
    address_line3 = CASE WHEN d ? 'addressLine3' THEN app.imp_text(d, 'addressLine3') ELSE address_line3 END,
    city = CASE WHEN d ? 'city' THEN app.imp_text(d, 'city') ELSE city END,
    region = CASE WHEN d ? 'region' THEN app.imp_text(d, 'region') ELSE region END,
    postcode = CASE WHEN d ? 'postcode' THEN app.imp_text(d, 'postcode') ELSE postcode END,
    country = CASE WHEN d ? 'country' THEN app.imp_text(d, 'country') ELSE country END,
    currency = CASE WHEN d ? 'currency' THEN upper(app.imp_text(d, 'currency')) ELSE currency END,
    purchasing_reference = CASE WHEN d ? 'purchasingReference' THEN app.imp_text(d, 'purchasingReference') ELSE purchasing_reference END,
    updated_at = now(), updated_by = auth.uid()
  WHERE id = p_id AND organisation_id = p_org RETURNING id INTO v_id;
  IF v_id IS NULL THEN RAISE EXCEPTION 'The supplier this record was linked to no longer exists' USING ERRCODE = 'QM022'; END IF;
  RETURN v_id;
END $$;
