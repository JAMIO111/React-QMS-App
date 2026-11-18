-- External portal PT5c (docs/external-portal-plan.md decision X17): customer contacts, in the shape of supplier_contacts — several per customer, one primary,
-- deactivated and never deleted. Staff data (master_data.read / .manage), never shown to the customer. Portal sign-ins are not linked to a contact.

CREATE TABLE public.customer_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  job_title text CHECK (job_title IS NULL OR length(btrim(job_title)) BETWEEN 1 AND 120),
  role text NOT NULL DEFAULT 'other' CHECK (role IN ('quality', 'purchasing', 'sales', 'technical', 'accounts', 'logistics', 'management', 'other')),
  email text CHECK (email IS NULL OR length(btrim(email)) BETWEEN 3 AND 200),
  phone text CHECK (phone IS NULL OR length(btrim(phone)) BETWEEN 3 AND 40),
  is_primary boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  notes text CHECK (notes IS NULL OR length(btrim(notes)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT customer_contacts_id_org_key UNIQUE (id, organisation_id),
  CONSTRAINT customer_contacts_customer_fkey FOREIGN KEY (customer_id, organisation_id) REFERENCES public.customers (id, organisation_id),
  CONSTRAINT customer_contacts_primary_active CHECK (NOT is_primary OR active)
);
CREATE INDEX customer_contacts_customer_idx ON public.customer_contacts (customer_id);
CREATE UNIQUE INDEX customer_contacts_one_primary ON public.customer_contacts (customer_id) WHERE is_primary;

CREATE FUNCTION app.customer_contacts_primary() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.is_primary AND NOT NEW.active THEN NEW.is_primary := false; END IF;
  IF NEW.is_primary THEN
    UPDATE public.customer_contacts SET is_primary = false WHERE customer_id = NEW.customer_id AND id <> NEW.id AND is_primary;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_contacts_primary BEFORE INSERT OR UPDATE ON public.customer_contacts FOR EACH ROW EXECUTE FUNCTION app.customer_contacts_primary();
CREATE TRIGGER customer_contacts_stamp BEFORE INSERT ON public.customer_contacts FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER customer_contacts_touch BEFORE UPDATE ON public.customer_contacts FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER customer_contacts_org_immutable BEFORE UPDATE ON public.customer_contacts FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.customer_contacts FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.customer_contacts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.customer_contacts FROM anon, authenticated;
GRANT SELECT, INSERT ON public.customer_contacts TO authenticated;
GRANT UPDATE (name, job_title, role, email, phone, is_primary, active, notes) ON public.customer_contacts TO authenticated;
CREATE POLICY customer_contacts_select ON public.customer_contacts FOR SELECT TO authenticated USING (app.has_permission(organisation_id, 'master_data.read'));
CREATE POLICY customer_contacts_insert ON public.customer_contacts FOR INSERT TO authenticated WITH CHECK (app.has_permission(organisation_id, 'master_data.manage'));
CREATE POLICY customer_contacts_update ON public.customer_contacts FOR UPDATE TO authenticated
  USING (app.has_permission(organisation_id, 'master_data.manage')) WITH CHECK (app.has_permission(organisation_id, 'master_data.manage'));
REVOKE ALL ON FUNCTION app.customer_contacts_primary() FROM PUBLIC, anon, authenticated;
