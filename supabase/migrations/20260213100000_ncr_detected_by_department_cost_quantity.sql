-- Non-conformance: who detected it, the responsible department, and costs as quantity × unit cost.
--
--  * nonconformances.detected_by_employee_id: the person who found it, from the Employees register (people on the shop floor often have no sign-in,
--    so this is not detected_by, which stays the member who recorded it). Set or changed only to an active employee of the organisation. Existing
--    NCs get the employee linked to the sign-in that recorded them (Employees.auth_id), where there is one; nothing is guessed otherwise.
--  * nonconformances.responsible_department_id: the department responsible for the problem (investigation). Set or changed only to an active
--    department of the organisation. Information only: it grants nobody access.
--    app.my_employee(org) gives the caller their own employee record, which a new NC raised by hand starts with as who detected it.
--    Both are in the column-level UPDATE grant, audited like the rest of the NC, and importable (employee number, department code).
--  * ncr_costs.quantity and unit_cost: a cost line is now quantity × unit cost (quantity may be hours, kilograms or pieces). The database works the
--    amount out (rounded to pennies), so the line's VAT, base-currency figures and the NC totals follow as before. Existing lines become quantity 1
--    at their amount. A write that gives only an amount (older SQL, seeds) still works and means quantity 1 at that amount.

-- ---------------------------------------------------------------------------
-- Who detected it, responsible department
-- ---------------------------------------------------------------------------
ALTER TABLE public.nonconformances
  ADD COLUMN detected_by_employee_id uuid,
  ADD COLUMN responsible_department_id uuid,
  ADD CONSTRAINT nonconformances_detected_employee_fkey FOREIGN KEY (detected_by_employee_id, organisation_id) REFERENCES public."Employees" (id, organisation_id),
  ADD CONSTRAINT nonconformances_responsible_department_fkey FOREIGN KEY (responsible_department_id, organisation_id) REFERENCES public.departments (id, organisation_id);
COMMENT ON COLUMN public.nonconformances.detected_by_employee_id IS 'Who found the problem (Employees register); detected_by is the member who recorded it';
COMMENT ON COLUMN public.nonconformances.responsible_department_id IS 'The department responsible for the problem (information only)';
CREATE INDEX nonconformances_detected_employee_idx ON public.nonconformances (detected_by_employee_id) WHERE detected_by_employee_id IS NOT NULL;
CREATE INDEX nonconformances_responsible_department_idx ON public.nonconformances (responsible_department_id) WHERE responsible_department_id IS NOT NULL;

CREATE FUNCTION app.ncr_people_and_department_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.detected_by_employee_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.detected_by_employee_id IS DISTINCT FROM OLD.detected_by_employee_id)
     AND NOT EXISTS (SELECT 1 FROM public."Employees" e WHERE e.id = NEW.detected_by_employee_id AND e.organisation_id = NEW.organisation_id AND e.active) THEN
    RAISE EXCEPTION 'The person who detected it must be an active employee' USING ERRCODE = 'QM005';
  END IF;
  IF NEW.responsible_department_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.responsible_department_id IS DISTINCT FROM OLD.responsible_department_id)
     AND NOT EXISTS (SELECT 1 FROM public.departments d WHERE d.id = NEW.responsible_department_id AND d.organisation_id = NEW.organisation_id AND d.active) THEN
    RAISE EXCEPTION 'The responsible department must be one of the organisation''s departments that is in use' USING ERRCODE = 'QM005';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER nonconformances_people_and_department BEFORE INSERT OR UPDATE OF detected_by_employee_id, responsible_department_id ON public.nonconformances
  FOR EACH ROW EXECUTE FUNCTION app.ncr_people_and_department_rules();
REVOKE ALL ON FUNCTION app.ncr_people_and_department_rules() FROM PUBLIC, anon, authenticated;

GRANT UPDATE (detected_by_employee_id, responsible_department_id) ON public.nonconformances TO authenticated;

-- The caller's own employee record (linked to their sign-in), which a new NC starts with as who detected it. SECURITY DEFINER only so a member who may
-- not read the Employees register still gets their own row; nothing about anyone else is returned.
CREATE FUNCTION app.my_employee(p_organisation_id uuid) RETURNS TABLE (id uuid, name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT e.id, nullif(trim(concat_ws(' ', e.first_name, e.surname)), '')
    FROM public."Employees" e
   WHERE auth.uid() IS NOT NULL AND app.is_member(p_organisation_id)
     AND e.organisation_id = p_organisation_id AND e.auth_id = auth.uid() AND e.active
   LIMIT 1
$$;
COMMENT ON FUNCTION app.my_employee(uuid) IS 'The caller''s own active employee record in the organisation, if any';
REVOKE ALL ON FUNCTION app.my_employee(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.my_employee(uuid) TO authenticated;

-- Existing NCs: the employee linked to the sign-in that recorded them. Not a user's change, so row triggers (audit, notifications, rules) are off.
ALTER TABLE public.nonconformances DISABLE TRIGGER USER;
UPDATE public.nonconformances n
   SET detected_by_employee_id = e.id
  FROM public."Employees" e
 WHERE n.detected_by_employee_id IS NULL AND n.detected_by IS NOT NULL
   AND e.organisation_id = n.organisation_id AND e.auth_id = n.detected_by;
ALTER TABLE public.nonconformances ENABLE TRIGGER USER;

-- ---------------------------------------------------------------------------
-- Costs: quantity × unit cost
-- ---------------------------------------------------------------------------
ALTER TABLE public.ncr_costs
  ADD COLUMN quantity numeric NOT NULL DEFAULT 1 CHECK (quantity > 0 AND quantity < 1e9),
  ADD COLUMN unit_cost numeric CHECK (unit_cost >= 0 AND unit_cost < 1e12);
COMMENT ON COLUMN public.ncr_costs.quantity IS 'How many (pieces, hours, kilograms…); amount = quantity × unit cost, worked out by the database';
COMMENT ON COLUMN public.ncr_costs.unit_cost IS 'Cost of one, in the line''s currency and VAT treatment';

ALTER TABLE public.ncr_costs DISABLE TRIGGER USER;
UPDATE public.ncr_costs SET unit_cost = amount WHERE unit_cost IS NULL;
ALTER TABLE public.ncr_costs ENABLE TRIGGER USER;
ALTER TABLE public.ncr_costs ALTER COLUMN unit_cost SET NOT NULL;

-- Runs before ncr_costs_amounts (names sort: "ncr_costs_a_quantity" < "ncr_costs_amounts"), so the amount it works out is the one VAT and the base
-- currency are worked from.
CREATE FUNCTION app.ncr_cost_quantity() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.unit_cost IS NULL THEN
      -- Only an amount given: one at that amount.
      NEW.quantity := 1;
      NEW.unit_cost := NEW.amount;
    END IF;
  ELSIF NEW.quantity IS NOT DISTINCT FROM OLD.quantity AND NEW.unit_cost IS NOT DISTINCT FROM OLD.unit_cost AND NEW.amount IS DISTINCT FROM OLD.amount THEN
    -- Only the amount changed: one at the new amount.
    NEW.quantity := 1;
    NEW.unit_cost := NEW.amount;
  END IF;
  IF NEW.unit_cost IS NULL THEN
    RAISE EXCEPTION 'Give the unit cost' USING ERRCODE = 'QM005';
  END IF;
  NEW.amount := round(NEW.quantity * NEW.unit_cost, 2);
  RETURN NEW;
END $$;
CREATE TRIGGER ncr_costs_a_quantity BEFORE INSERT OR UPDATE ON public.ncr_costs FOR EACH ROW EXECUTE FUNCTION app.ncr_cost_quantity();
REVOKE ALL ON FUNCTION app.ncr_cost_quantity() FROM PUBLIC, anon, authenticated;

-- amount may be given without a default now that unit cost is the input (the trigger fills it).
ALTER TABLE public.ncr_costs ALTER COLUMN amount SET DEFAULT 0;
GRANT UPDATE (quantity, unit_cost) ON public.ncr_costs TO authenticated;

-- ---------------------------------------------------------------------------
-- Imports: who detected (employee number) and responsible department (department code)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.import_nonconformance(p_org uuid, p_id uuid, d jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid;
BEGIN
  IF p_id IS NOT NULL THEN RAISE EXCEPTION 'Non-conformances are only ever added: once in Fortress they are managed there' USING ERRCODE = 'QM022'; END IF;
  INSERT INTO public.nonconformances (organisation_id, source, stage, title, severity, description, requirement, actual_result, site_id, part_id, customer_id, supplier_id,
                                      work_order, purchase_order, customer_reference, lot_number, serial_number, quantity_affected, quantity_inspected, detected_at,
                                      detection_process_id, causal_process_id, responsible_employee_id, category_id, detected_by_employee_id, responsible_department_id)
  VALUES (p_org, app.imp_text(d, 'source'), 'draft', app.imp_text(d, 'title'), app.imp_text(d, 'severity'), app.imp_text(d, 'description'), app.imp_text(d, 'requirement'),
          app.imp_text(d, 'actualResult'), app.imp_ref(d, 'site'), app.imp_ref(d, 'part'), app.imp_ref(d, 'customer'), app.imp_ref(d, 'supplier'),
          app.imp_text(d, 'workOrder'), app.imp_text(d, 'purchaseOrder'), app.imp_text(d, 'customerReference'), app.imp_text(d, 'lotNumber'), app.imp_text(d, 'serialNumber'),
          app.imp_num(d, 'quantityAffected'), app.imp_num(d, 'quantityInspected'), coalesce(app.imp_date(d, 'detectedAt'), current_date),
          app.imp_ref(d, 'detectionMachine'), app.imp_ref(d, 'causalMachine'), app.imp_ref(d, 'responsibleEmployee'), app.imp_ref(d, 'category'),
          app.imp_ref(d, 'detectedBy'), app.imp_ref(d, 'responsibleDepartment'))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
