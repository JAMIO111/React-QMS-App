-- Phase 1 / slice 1.1 — tenancy on the legacy QMS tables (docs/phase-1-plan.md §2.3)
--
-- * organisation_id NOT NULL on every retained business table, backfilled to the organisation
--   that owns the data (the only organisation, or the employee's organisation).
-- * Composite (id, organisation_id) foreign keys so a record can only reference records of its
--   own organisation.
-- * Tenant-scoped uniques; created_by / updated_by / updated_at on every table.
-- * People references (file owner, notification creator/recipient) point at profiles, not Employees.
-- Table names stay as they are until the NCR module is rebuilt in Phase 2.

DO $$
DECLARE
  v_org uuid;
  v_orgs int := (SELECT count(*) FROM public.organisations);
  t text;
  v_rows bigint;
BEGIN
  IF v_orgs = 1 THEN
    SELECT id INTO v_org FROM public.organisations;
  END IF;

  FOREACH t IN ARRAY ARRAY['NCM','8D','Costs','NC Files','Part','Customers','Suppliers','Addresses',
                           'Process','Failure Mode','Sub-Failure Mode','Status'] LOOP
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN organisation_id uuid REFERENCES public.organisations (id) ON DELETE CASCADE', t);
    EXECUTE format('SELECT count(*) FROM public.%I', t) INTO v_rows;
    IF v_rows > 0 THEN
      IF v_org IS NULL THEN
        RAISE EXCEPTION 'cannot backfill %.organisation_id: expected exactly one organisation, found %', t, v_orgs;
      END IF;
      EXECUTE format('UPDATE public.%I SET organisation_id = $1', t) USING v_org;
    END IF;
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN organisation_id SET NOT NULL', t);
  END LOOP;

  -- Employees already has organisation_id (nullable); fill gaps from the only organisation.
  IF EXISTS (SELECT 1 FROM public."Employees" WHERE organisation_id IS NULL) THEN
    IF v_org IS NULL THEN
      RAISE EXCEPTION 'cannot backfill Employees.organisation_id: expected exactly one organisation, found %', v_orgs;
    END IF;
    UPDATE public."Employees" SET organisation_id = v_org WHERE organisation_id IS NULL;
  END IF;
END $$;

ALTER TABLE public."Employees" ALTER COLUMN organisation_id SET NOT NULL;

-- Notifications: rename org -> organisation_id; recipients inherit from their notification.
ALTER TABLE public."Notifications" RENAME COLUMN org TO organisation_id;
ALTER TABLE public."Notifications" RENAME CONSTRAINT "Notifications_org_fkey" TO "Notifications_organisation_id_fkey";
ALTER TABLE public."Notifications" ALTER COLUMN organisation_id SET NOT NULL;

ALTER TABLE public."Notification Recipients"
  ADD COLUMN organisation_id uuid REFERENCES public.organisations (id) ON DELETE CASCADE;
UPDATE public."Notification Recipients" r SET organisation_id = n.organisation_id
FROM public."Notifications" n WHERE n.id = r.notification_id;
DELETE FROM public."Notification Recipients" WHERE organisation_id IS NULL;  -- orphans without a notification
ALTER TABLE public."Notification Recipients" ALTER COLUMN organisation_id SET NOT NULL;

-- ---------------------------------------------------------------------------
-- Audit columns and timestamps
-- ---------------------------------------------------------------------------
ALTER TABLE public."Sub-Failure Mode"
  ALTER COLUMN updated_at TYPE timestamptz USING nullif(trim(updated_at), '')::timestamptz;

UPDATE public."Customers" SET created_at = now() WHERE created_at IS NULL;
UPDATE public."Employees" SET created_at = now() WHERE created_at IS NULL;
UPDATE public."Sub-Failure Mode" SET created_at = now() WHERE created_at IS NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['NCM','8D','Costs','NC Files','Part','Customers','Suppliers','Addresses',
                           'Process','Failure Mode','Sub-Failure Mode','Status','Employees','Notifications'] LOOP
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN created_at SET DEFAULT now(), ALTER COLUMN created_at SET NOT NULL', t);
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS updated_at timestamptz', t);
    EXECUTE format('UPDATE public.%I SET updated_at = coalesce(updated_at, created_at)', t);
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN updated_at SET DEFAULT now(), ALTER COLUMN updated_at SET NOT NULL', t);
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL', t);
    IF t NOT IN ('8D', 'Notifications') THEN  -- these already have created_by
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL', t);
    END IF;
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.touch_updated()', t || '_touch', t);
  END LOOP;
END $$;
ALTER TABLE public."8D" ALTER COLUMN created_by SET DEFAULT auth.uid();

-- ---------------------------------------------------------------------------
-- People references -> profiles (login identities); Employees are personnel
-- ---------------------------------------------------------------------------
ALTER TABLE public."NC Files" DROP CONSTRAINT "NC Files_owner_fkey";
ALTER TABLE public."Notification Recipients" DROP CONSTRAINT "Notification Recipients_recipient_id_fkey";
ALTER TABLE public."Notifications" DROP CONSTRAINT "Notifications_created_by_fkey";

ALTER TABLE public."NC Files" ALTER COLUMN owner SET DEFAULT auth.uid(),
  ADD CONSTRAINT "NC Files_owner_fkey" FOREIGN KEY (owner) REFERENCES public.profiles (id) ON DELETE SET NULL;
ALTER TABLE public."Notification Recipients"
  ADD CONSTRAINT "Notification Recipients_recipient_id_fkey" FOREIGN KEY (recipient_id) REFERENCES public.profiles (id) ON DELETE CASCADE;
ALTER TABLE public."Notifications" ALTER COLUMN created_by SET DEFAULT auth.uid(),
  ADD CONSTRAINT "Notifications_created_by_fkey" FOREIGN KEY (created_by) REFERENCES public.profiles (id) ON DELETE SET NULL;

-- A person can be personnel in several organisations, linked to at most one login per organisation.
ALTER TABLE public."Employees" DROP CONSTRAINT "Employees_auth_id_key";
ALTER TABLE public."Employees" ADD CONSTRAINT "Employees_org_auth_id_key" UNIQUE (organisation_id, auth_id);

-- ---------------------------------------------------------------------------
-- Tenant-scoped uniques
-- ---------------------------------------------------------------------------
ALTER TABLE public."NCM" DROP CONSTRAINT "NCM_ncm_id_key";
ALTER TABLE public."NCM" ADD CONSTRAINT "NCM_org_ncm_id_key" UNIQUE (organisation_id, ncm_id);
ALTER TABLE public."Status" DROP CONSTRAINT "Status_name_key";
ALTER TABLE public."Status" ADD CONSTRAINT "Status_org_name_key" UNIQUE (organisation_id, name);
ALTER TABLE public."8D" DROP CONSTRAINT "8D_id_key";  -- duplicate of the primary key

-- ---------------------------------------------------------------------------
-- Same-organisation references: (id, organisation_id) keys + composite foreign keys
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['NCM','8D','Part','Customers','Suppliers','Process','Failure Mode',
                           'Sub-Failure Mode','Status','Employees','Notifications'] LOOP
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I UNIQUE (id, organisation_id)', t, t || '_id_org_key');
  END LOOP;
END $$;

ALTER TABLE public."NCM"
  DROP CONSTRAINT "NC Internal_failure_mode_fkey",
  DROP CONSTRAINT "NC Internal_status_fkey",
  DROP CONSTRAINT "NCM_causal_process_fkey",
  DROP CONSTRAINT "NCM_customer_fkey",
  DROP CONSTRAINT "NCM_location_detected_fkey",
  DROP CONSTRAINT "NCM_logged_by_fkey1",
  DROP CONSTRAINT "NCM_part_number_fkey",
  DROP CONSTRAINT "NCM_ref_8d_fkey",
  DROP CONSTRAINT "NCM_responsible_operator_fkey",
  DROP CONSTRAINT "NCM_sub_failure_mode_fkey",
  DROP CONSTRAINT "NCM_supplier_fkey";

-- ON DELETE SET NULL (col) needs PG15+: clears only the referencing column, never organisation_id.
ALTER TABLE public."NCM"
  ADD CONSTRAINT "NCM_failure_mode_fkey" FOREIGN KEY (failure_mode, organisation_id) REFERENCES public."Failure Mode" (id, organisation_id),
  ADD CONSTRAINT "NCM_status_fkey" FOREIGN KEY (status, organisation_id) REFERENCES public."Status" (id, organisation_id),
  ADD CONSTRAINT "NCM_causal_process_fkey" FOREIGN KEY (causal_process, organisation_id) REFERENCES public."Process" (id, organisation_id),
  ADD CONSTRAINT "NCM_customer_fkey" FOREIGN KEY (customer, organisation_id) REFERENCES public."Customers" (id, organisation_id),
  ADD CONSTRAINT "NCM_location_detected_fkey" FOREIGN KEY (location_detected, organisation_id) REFERENCES public."Process" (id, organisation_id),
  ADD CONSTRAINT "NCM_logged_by_fkey" FOREIGN KEY (logged_by, organisation_id) REFERENCES public."Employees" (id, organisation_id) ON DELETE SET NULL (logged_by),
  ADD CONSTRAINT "NCM_part_number_fkey" FOREIGN KEY (part_number, organisation_id) REFERENCES public."Part" (id, organisation_id),
  ADD CONSTRAINT "NCM_ref_8d_fkey" FOREIGN KEY (ref_8d, organisation_id) REFERENCES public."8D" (id, organisation_id) ON DELETE SET NULL (ref_8d),
  ADD CONSTRAINT "NCM_responsible_operator_fkey" FOREIGN KEY (responsible_operator, organisation_id) REFERENCES public."Employees" (id, organisation_id) ON DELETE RESTRICT,
  ADD CONSTRAINT "NCM_sub_failure_mode_fkey" FOREIGN KEY (sub_failure_mode, organisation_id) REFERENCES public."Sub-Failure Mode" (id, organisation_id),
  ADD CONSTRAINT "NCM_supplier_fkey" FOREIGN KEY (supplier, organisation_id) REFERENCES public."Suppliers" (id, organisation_id);

ALTER TABLE public."Sub-Failure Mode" DROP CONSTRAINT "Sub-Failure Mode_failure_mode_fkey";
ALTER TABLE public."Sub-Failure Mode"
  ADD CONSTRAINT "Sub-Failure Mode_failure_mode_fkey" FOREIGN KEY (failure_mode, organisation_id) REFERENCES public."Failure Mode" (id, organisation_id);

ALTER TABLE public."Notification Recipients" DROP CONSTRAINT "Notification Recipients_notification_id_fkey";
ALTER TABLE public."Notification Recipients"
  ADD CONSTRAINT "Notification Recipients_notification_id_fkey" FOREIGN KEY (notification_id, organisation_id)
    REFERENCES public."Notifications" (id, organisation_id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- organisation_id is immutable; indexed everywhere
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['NCM','8D','Costs','NC Files','Part','Customers','Suppliers','Addresses',
                           'Process','Failure Mode','Sub-Failure Mode','Status','Employees',
                           'Notifications','Notification Recipients'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change()', t || '_org_immutable', t);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I (organisation_id)', lower(replace(replace(t, ' ', '_'), '-', '_')) || '_organisation_id_idx', t);
  END LOOP;
END $$;

CREATE INDEX "Notification Recipients_recipient_idx" ON public."Notification Recipients" (recipient_id);
