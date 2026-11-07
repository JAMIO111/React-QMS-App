-- Employees register: the legacy "Employees" table becomes a proper master-data register (employee number, work email, site and
-- department), with server-set created/updated stamps, an audit trail, column-level updates and no deletes (deactivate instead).
-- Existing rows and the references to them (responsible employee on an NC) are untouched.

ALTER TABLE public."Employees"
  ADD COLUMN employee_number text,
  ADD COLUMN email text,
  ADD COLUMN site_id uuid,
  ADD COLUMN department_id uuid;

UPDATE public."Employees" SET active = true WHERE active IS NULL;
ALTER TABLE public."Employees"
  ALTER COLUMN active SET DEFAULT true, ALTER COLUMN active SET NOT NULL,
  ADD CONSTRAINT employees_number_check CHECK (employee_number IS NULL OR length(trim(employee_number)) BETWEEN 1 AND 40),
  ADD CONSTRAINT employees_email_check CHECK (email IS NULL OR (length(email) <= 200 AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')),
  ADD CONSTRAINT employees_site_fkey FOREIGN KEY (site_id, organisation_id) REFERENCES public.sites (id, organisation_id),
  ADD CONSTRAINT employees_department_fkey FOREIGN KEY (department_id, organisation_id) REFERENCES public.departments (id, organisation_id);

-- One employee number per organisation (any case).
CREATE UNIQUE INDEX employees_org_number_key ON public."Employees" (organisation_id, upper(employee_number)) WHERE employee_number IS NOT NULL;

-- A department belongs to one site: naming a department fills in its site, and a site that disagrees is refused.
CREATE FUNCTION app.employee_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_site uuid;
BEGIN
  IF NEW.department_id IS NOT NULL THEN
    SELECT d.site_id INTO v_site FROM public.departments d WHERE d.id = NEW.department_id AND d.organisation_id = NEW.organisation_id;
    IF NEW.site_id IS NULL THEN
      NEW.site_id := v_site;
    ELSIF NEW.site_id <> v_site THEN
      RAISE EXCEPTION 'That department is not at the chosen site' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.employee_rules() FROM PUBLIC;
CREATE TRIGGER employees_rules BEFORE INSERT OR UPDATE ON public."Employees" FOR EACH ROW EXECUTE FUNCTION app.employee_rules();

CREATE TRIGGER employees_stamp BEFORE INSERT ON public."Employees" FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public."Employees" FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');

-- Privileges: no deletes (deactivate instead); updates only to the columns the register edits.
REVOKE DELETE ON public."Employees" FROM authenticated;
DROP POLICY IF EXISTS tenant_delete ON public."Employees";
REVOKE UPDATE ON public."Employees" FROM authenticated;
GRANT UPDATE (first_name, surname, job_title, active, employee_number, email, site_id, department_id) ON public."Employees" TO authenticated;
