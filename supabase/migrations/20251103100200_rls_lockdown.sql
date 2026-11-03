-- Phase 1 / slice 1.1 — RLS lockdown (docs/phase-1-plan.md §3)
--
-- * RLS on every public table; access = active membership + role permissions (app.* helpers).
-- * anon loses all access; authenticated gets only the privileges the policies need.
-- * Views recreated with security_invoker and organisation_id; reporting functions take an
--   organisation and run with a fixed search_path; unused/broken functions dropped.
-- * Storage: object paths are organisation-scoped; avatars bucket becomes private.

-- ---------------------------------------------------------------------------
-- Extra helper
-- ---------------------------------------------------------------------------
-- True when p_user_id is an active member of p_organisation_id (for validating recipients etc.).
CREATE FUNCTION app.is_active_member_user(p_organisation_id uuid, p_user_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.organisation_users m
    WHERE m.organisation_id = p_organisation_id AND m.user_id = p_user_id AND m.status = 'active'
  )
$$;
REVOKE ALL ON FUNCTION app.is_active_member_user(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_active_member_user(uuid, uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Privileges: nothing for anon; authenticated limited to what policies allow
-- ---------------------------------------------------------------------------
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM anon, PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon, PUBLIC;

-- Supabase's default privileges give authenticated ALL on every new table. Remove what no policy
-- needs: TRUNCATE (bypasses RLS), REFERENCES, TRIGGER everywhere, and the write privileges each
-- platform table does not support.
REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLES FROM authenticated;
REVOKE INSERT, DELETE ON public.organisations, public.organisation_settings, public.profiles FROM authenticated;
REVOKE DELETE ON public.sites, public.departments, public.organisation_users FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.permissions FROM authenticated;
REVOKE UPDATE ON public.user_role_assignments FROM authenticated;

-- Column-level updates where only some columns are user-editable.
REVOKE UPDATE ON public.organisations, public.organisation_settings, public.profiles,
  public.organisation_users FROM authenticated;
GRANT UPDATE (name) ON public.organisations TO authenticated;
GRANT UPDATE (base_currency, vat_rate, ncr_reference_prefix) ON public.organisation_settings TO authenticated;
GRANT UPDATE (first_name, surname, job_title, avatar_path) ON public.profiles TO authenticated;
GRANT UPDATE (status) ON public.organisation_users TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  public."NCM", public."8D", public."Costs", public."NC Files", public."Part", public."Customers",
  public."Suppliers", public."Addresses", public."Process", public."Failure Mode",
  public."Sub-Failure Mode", public."Status", public."Employees"
TO authenticated;
GRANT SELECT, INSERT ON public."Notifications" TO authenticated;
REVOKE UPDATE, DELETE ON public."Notifications" FROM authenticated;
GRANT SELECT, INSERT ON public."Notification Recipients" TO authenticated;
REVOKE UPDATE, DELETE ON public."Notification Recipients" FROM authenticated;
GRANT UPDATE (read) ON public."Notification Recipients" TO authenticated;

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere in public
-- ---------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'r' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.relname);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Standard tenant policies for the legacy business tables
-- ---------------------------------------------------------------------------
CREATE FUNCTION pg_temp.tenant_policies(tbl text, p_read text, p_create text, p_update text, p_delete text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  read_expr text := CASE WHEN p_read IS NULL THEN 'app.is_member(organisation_id)'
                         ELSE format('app.has_permission(organisation_id, %L)', p_read) END;
BEGIN
  EXECUTE format('CREATE POLICY tenant_select ON public.%I FOR SELECT TO authenticated USING (%s)', tbl, read_expr);
  EXECUTE format('CREATE POLICY tenant_insert ON public.%I FOR INSERT TO authenticated WITH CHECK (app.has_permission(organisation_id, %L))', tbl, p_create);
  EXECUTE format('CREATE POLICY tenant_update ON public.%I FOR UPDATE TO authenticated USING (app.has_permission(organisation_id, %L)) WITH CHECK (app.has_permission(organisation_id, %L))', tbl, p_update, p_update);
  EXECUTE format('CREATE POLICY tenant_delete ON public.%I FOR DELETE TO authenticated USING (app.has_permission(organisation_id, %L))', tbl, p_delete);
END $$;

-- Non-conformance records
DO $$ BEGIN PERFORM pg_temp.tenant_policies('NCM',      'ncr.read', 'ncr.create', 'ncr.update', 'ncr.delete'); END $$;
DO $$ BEGIN PERFORM pg_temp.tenant_policies('8D',       'ncr.read', 'ncr.create', 'ncr.update', 'ncr.delete'); END $$;
DO $$ BEGIN PERFORM pg_temp.tenant_policies('Costs',    'ncr.read', 'ncr.update', 'ncr.update', 'ncr.update'); END $$;
DO $$ BEGIN PERFORM pg_temp.tenant_policies('NC Files', 'ncr.read', 'ncr.update', 'ncr.update', 'ncr.update'); END $$;
-- Master data
DO $$ BEGIN PERFORM pg_temp.tenant_policies('Part',      'master_data.read', 'master_data.manage', 'master_data.manage', 'master_data.manage'); END $$;
DO $$ BEGIN PERFORM pg_temp.tenant_policies('Customers', 'master_data.read', 'master_data.manage', 'master_data.manage', 'master_data.manage'); END $$;
DO $$ BEGIN PERFORM pg_temp.tenant_policies('Suppliers', 'master_data.read', 'master_data.manage', 'master_data.manage', 'master_data.manage'); END $$;
DO $$ BEGIN PERFORM pg_temp.tenant_policies('Addresses', 'master_data.read', 'master_data.manage', 'master_data.manage', 'master_data.manage'); END $$;
DO $$ BEGIN PERFORM pg_temp.tenant_policies('Employees', 'master_data.read', 'master_data.manage', 'master_data.manage', 'master_data.manage'); END $$;
-- Lookups: readable by every member
DO $$ BEGIN PERFORM pg_temp.tenant_policies('Process',          NULL, 'lookups.manage', 'lookups.manage', 'lookups.manage'); END $$;
DO $$ BEGIN PERFORM pg_temp.tenant_policies('Failure Mode',     NULL, 'lookups.manage', 'lookups.manage', 'lookups.manage'); END $$;
DO $$ BEGIN PERFORM pg_temp.tenant_policies('Sub-Failure Mode', NULL, 'lookups.manage', 'lookups.manage', 'lookups.manage'); END $$;
DO $$ BEGIN PERFORM pg_temp.tenant_policies('Status',           NULL, 'lookups.manage', 'lookups.manage', 'lookups.manage'); END $$;

-- Notifications: visible to their creator and recipients; recipients only mark them read.
CREATE POLICY notifications_select ON public."Notifications" FOR SELECT TO authenticated
  USING (app.is_member(organisation_id) AND (
    created_by = auth.uid()
    OR EXISTS (SELECT 1 FROM public."Notification Recipients" r
               WHERE r.notification_id = "Notifications".id AND r.recipient_id = auth.uid())));
CREATE POLICY notifications_insert ON public."Notifications" FOR INSERT TO authenticated
  WITH CHECK (app.is_member(organisation_id) AND created_by = auth.uid());

CREATE POLICY recipients_select ON public."Notification Recipients" FOR SELECT TO authenticated
  USING (recipient_id = auth.uid() AND app.is_member(organisation_id));
CREATE POLICY recipients_insert ON public."Notification Recipients" FOR INSERT TO authenticated
  WITH CHECK (
    app.is_member(organisation_id)
    AND app.is_active_member_user(organisation_id, recipient_id)
    AND EXISTS (SELECT 1 FROM public."Notifications" n
                WHERE n.id = notification_id AND n.created_by = auth.uid()));
CREATE POLICY recipients_update ON public."Notification Recipients" FOR UPDATE TO authenticated
  USING (recipient_id = auth.uid() AND app.is_member(organisation_id))
  WITH CHECK (recipient_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Platform tables
-- ---------------------------------------------------------------------------
CREATE POLICY organisations_select ON public.organisations FOR SELECT TO authenticated
  USING (app.is_member(id));
CREATE POLICY organisations_update ON public.organisations FOR UPDATE TO authenticated
  USING (app.has_permission(id, 'organisation.manage')) WITH CHECK (app.has_permission(id, 'organisation.manage'));

CREATE POLICY settings_select ON public.organisation_settings FOR SELECT TO authenticated
  USING (app.is_member(organisation_id));
CREATE POLICY settings_update ON public.organisation_settings FOR UPDATE TO authenticated
  USING (app.has_permission(organisation_id, 'organisation.manage'))
  WITH CHECK (app.has_permission(organisation_id, 'organisation.manage'));

CREATE POLICY sites_select ON public.sites FOR SELECT TO authenticated USING (app.is_member(organisation_id));
CREATE POLICY sites_insert ON public.sites FOR INSERT TO authenticated
  WITH CHECK (app.has_permission(organisation_id, 'organisation.manage'));
CREATE POLICY sites_update ON public.sites FOR UPDATE TO authenticated
  USING (app.has_permission(organisation_id, 'organisation.manage'))
  WITH CHECK (app.has_permission(organisation_id, 'organisation.manage'));

CREATE POLICY departments_select ON public.departments FOR SELECT TO authenticated USING (app.is_member(organisation_id));
CREATE POLICY departments_insert ON public.departments FOR INSERT TO authenticated
  WITH CHECK (app.has_permission(organisation_id, 'organisation.manage'));
CREATE POLICY departments_update ON public.departments FOR UPDATE TO authenticated
  USING (app.has_permission(organisation_id, 'organisation.manage'))
  WITH CHECK (app.has_permission(organisation_id, 'organisation.manage'));

CREATE POLICY profiles_select ON public.profiles FOR SELECT TO authenticated
  USING (id = auth.uid() OR app.shares_organisation(id));
CREATE POLICY profiles_update ON public.profiles FOR UPDATE TO authenticated
  USING (id = auth.uid()) WITH CHECK (id = auth.uid());

CREATE POLICY members_select ON public.organisation_users FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR app.has_permission(organisation_id, 'members.read'));
CREATE POLICY members_insert ON public.organisation_users FOR INSERT TO authenticated
  WITH CHECK (app.has_permission(organisation_id, 'members.manage') AND status = 'invited' AND user_id IS NULL);
CREATE POLICY members_update ON public.organisation_users FOR UPDATE TO authenticated
  USING (app.has_permission(organisation_id, 'members.manage') AND app.can_manage_membership(id)
         AND user_id IS DISTINCT FROM auth.uid())
  WITH CHECK (app.has_permission(organisation_id, 'members.manage'));

CREATE POLICY permissions_select ON public.permissions FOR SELECT TO authenticated USING (true);

CREATE POLICY roles_select ON public.roles FOR SELECT TO authenticated
  USING (organisation_id IS NULL OR app.is_member(organisation_id));
CREATE POLICY roles_insert ON public.roles FOR INSERT TO authenticated
  WITH CHECK (organisation_id IS NOT NULL AND NOT is_system AND app.has_permission(organisation_id, 'roles.manage'));
CREATE POLICY roles_update ON public.roles FOR UPDATE TO authenticated
  USING (organisation_id IS NOT NULL AND NOT is_system AND app.has_permission(organisation_id, 'roles.manage'))
  WITH CHECK (NOT is_system AND app.has_permission(organisation_id, 'roles.manage'));
CREATE POLICY roles_delete ON public.roles FOR DELETE TO authenticated
  USING (organisation_id IS NOT NULL AND NOT is_system AND app.has_permission(organisation_id, 'roles.manage'));

CREATE POLICY role_permissions_select ON public.role_permissions FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.roles r WHERE r.id = role_id));
CREATE POLICY role_permissions_insert ON public.role_permissions FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.roles r
    WHERE r.id = role_id AND r.organisation_id IS NOT NULL AND NOT r.is_system
      AND app.has_permission(r.organisation_id, 'roles.manage')
      AND permission_code IN (SELECT app.my_permissions(r.organisation_id))));
CREATE POLICY role_permissions_delete ON public.role_permissions FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.roles r
    WHERE r.id = role_id AND r.organisation_id IS NOT NULL AND NOT r.is_system
      AND app.has_permission(r.organisation_id, 'roles.manage')));

CREATE POLICY assignments_select ON public.user_role_assignments FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'members.read')
         OR EXISTS (SELECT 1 FROM public.organisation_users m WHERE m.id = membership_id AND m.user_id = auth.uid()));
CREATE POLICY assignments_insert ON public.user_role_assignments FOR INSERT TO authenticated
  WITH CHECK (app.has_permission(organisation_id, 'members.manage')
              AND app.can_assign_role(organisation_id, role_id)
              AND app.can_manage_membership(membership_id));
CREATE POLICY assignments_delete ON public.user_role_assignments FOR DELETE TO authenticated
  USING (app.has_permission(organisation_id, 'members.manage')
         AND app.can_assign_role(organisation_id, role_id)
         AND app.can_manage_membership(membership_id));

-- ---------------------------------------------------------------------------
-- Views: run with the caller's permissions (RLS applies) and expose organisation_id
-- ---------------------------------------------------------------------------
DROP VIEW public.v_nc_files, public.v_ncm_customer, public.v_ncm_internal, public.v_ncm_supplier;

CREATE VIEW public.v_nc_files WITH (security_invoker = true) AS
 SELECT nc.id, nc.organisation_id, nc.name, nc.type, nc.created_at, nc.size, nc.last_modified,
        nc.path, nc.id_ref, nc.owner,
        p.first_name AS owner_first_name, p.surname AS owner_surname
   FROM public."NC Files" nc
   LEFT JOIN public.profiles p ON p.id = nc.owner;

CREATE VIEW public.v_ncm_customer WITH (security_invoker = true) AS
 SELECT ncm.id, ncm.organisation_id, ncm.ncm_id, ncm.created_at, ncm.type, ncm.date, ncm.claim_ref,
        ncm.customer, c.display_name AS customer_display_name, c.name AS customer_name,
        ncm.status, s.name AS status_name, ncm.failure_mode, fm.name AS failure_mode_name,
        ncm.sub_failure_mode, sfm.name AS sub_failure_mode_name, ncm.causal_process,
        p.name AS causal_process_name, ncm.responsible_operator, ncm.quantity_checked,
        ncm.quantity_defective, ncm.work_order, ncm.description, ncm.total_cost
   FROM public."NCM" ncm
   LEFT JOIN public."Failure Mode" fm ON ncm.failure_mode = fm.id
   LEFT JOIN public."Sub-Failure Mode" sfm ON ncm.sub_failure_mode = sfm.id
   LEFT JOIN public."Status" s ON ncm.status = s.id
   LEFT JOIN public."Process" p ON ncm.causal_process = p.id
   LEFT JOIN public."Customers" c ON ncm.customer = c.id
  WHERE ncm.type = 'Customer';

CREATE VIEW public.v_ncm_internal WITH (security_invoker = true) AS
 SELECT ncm.id, ncm.organisation_id, ncm.ncm_id, ncm.created_at, ncm.type, ncm.date, ncm.customer,
        c.display_name AS customer_display_name, c.name AS customer_name, ncm.status,
        pa.part_number, s.name AS status_name, ncm.failure_mode, fm.name AS failure_mode_name,
        ncm.sub_failure_mode, sfm.name AS sub_failure_mode_name, ncm.causal_process,
        p.name AS causal_process_name, ncm.responsible_operator, ncm.quantity_checked,
        ncm.quantity_defective, ncm.work_order, ncm.description, ncm.total_cost
   FROM public."NCM" ncm
   LEFT JOIN public."Failure Mode" fm ON ncm.failure_mode = fm.id
   LEFT JOIN public."Sub-Failure Mode" sfm ON ncm.sub_failure_mode = sfm.id
   LEFT JOIN public."Status" s ON ncm.status = s.id
   LEFT JOIN public."Process" p ON ncm.causal_process = p.id
   LEFT JOIN public."Customers" c ON ncm.customer = c.id
   LEFT JOIN public."Part" pa ON ncm.part_number = pa.id
  WHERE ncm.type = 'Internal';

CREATE VIEW public.v_ncm_supplier WITH (security_invoker = true) AS
 SELECT ncm.id, ncm.organisation_id, ncm.ncm_id, ncm.created_at, ncm.type, ncm.date,
        pa.part_number, ncm.supplier, ncm.purchase_order, sup.name AS supplier_name,
        sup.display_name AS supplier_display_name, ncm.status, s.name AS status_name,
        ncm.failure_mode, fm.name AS failure_mode_name, ncm.sub_failure_mode,
        sfm.name AS sub_failure_mode_name, ncm.causal_process, p.name AS causal_process_name,
        ncm.responsible_operator, ncm.quantity_checked, ncm.quantity_defective, ncm.work_order,
        ncm.description, ncm.total_cost
   FROM public."NCM" ncm
   LEFT JOIN public."Failure Mode" fm ON ncm.failure_mode = fm.id
   LEFT JOIN public."Sub-Failure Mode" sfm ON ncm.sub_failure_mode = sfm.id
   LEFT JOIN public."Status" s ON ncm.status = s.id
   LEFT JOIN public."Process" p ON ncm.causal_process = p.id
   LEFT JOIN public."Suppliers" sup ON ncm.supplier = sup.id
   LEFT JOIN public."Part" pa ON ncm.part_number = pa.id
  WHERE ncm.type = 'Supplier';

REVOKE ALL ON public.v_nc_files, public.v_ncm_customer, public.v_ncm_internal, public.v_ncm_supplier FROM anon;
GRANT SELECT ON public.v_nc_files, public.v_ncm_customer, public.v_ncm_internal, public.v_ncm_supplier TO authenticated;

-- ---------------------------------------------------------------------------
-- Functions: drop unused/broken ones; tenant-aware, fixed search_path for the rest
-- ---------------------------------------------------------------------------
DROP FUNCTION public.get_aggregated_defects(timestamptz, timestamptz);
DROP FUNCTION public.get_nc_date_trend_data(timestamptz, timestamptz);
DROP FUNCTION public.get_nc_kpi_json(timestamptz, timestamptz);
DROP FUNCTION public.get_ncm_by_type(text);
DROP FUNCTION public.get_ncm_summary_json(timestamptz, timestamptz);
DROP FUNCTION public.get_top_customers_by_rejects(timestamptz, timestamptz);
DROP FUNCTION public.get_nc_kpi_json(timestamptz, timestamptz, text);
DROP FUNCTION public.get_nc_date_trend(timestamptz, timestamptz, text, text);
DROP FUNCTION public.get_user_notifications(uuid);

-- Runs as the caller (RLS applies); additionally scoped to one organisation.
CREATE FUNCTION public.get_nc_kpi_json(
  p_organisation_id uuid, start_date timestamptz, end_date timestamptz, nc_type text
) RETURNS json
LANGUAGE sql STABLE SET search_path = '' AS $function$
with
periods as (
  select start_date as start_date, end_date as end_date,
         start_date - (end_date - start_date) as prev_start,
         end_date - (end_date - start_date) as prev_end
),
current_ncm as (
  select n.*
  from public."NCM" n
  join public."Status" s on n.status = s.id
  join periods p on true
  where n.organisation_id = p_organisation_id
    and s.type != 'omit'
    and n.type = nc_type
    and n.date between p.start_date and p.end_date
),
previous_ncm as (
  select n.*
  from public."NCM" n
  join public."Status" s on n.status = s.id
  join periods p on true
  where n.organisation_id = p_organisation_id
    and s.type != 'omit'
    and n.type = nc_type
    and n.date between p.prev_start and p.prev_end
),
top_entities as (
  select
    case when nc_type = 'Supplier' then sup.id else c.id end as entity_id,
    case when nc_type = 'Supplier' then sup.display_name else c.display_name end as entity_name,
    case when nc_type = 'Supplier' then sup.logo else c.logo end as entity_logo,
    sum(n.quantity_defective) as total_defects
  from current_ncm n
  left join public."Customers" c on n.customer = c.id and nc_type != 'Supplier'
  left join public."Suppliers" sup on n.supplier = sup.id and nc_type = 'Supplier'
  group by 1, 2, 3
  order by total_defects desc
  limit 5
),
top_causal_processes as (
  select cp.id as process_id, cp.name as process_name, cp.code, sum(n.quantity_defective) as total_defects
  from current_ncm n
  join public."Process" cp on n.causal_process = cp.id
  group by cp.id, cp.name, cp.code
  order by total_defects desc
  limit 5
),
current_totals as (
  select coalesce(sum(total_cost), 0) as total_cost, coalesce(sum(quantity_defective), 0) as total_quantity, count(*) as record_count
  from current_ncm
),
previous_totals as (
  select coalesce(sum(total_cost), 0) as total_cost, coalesce(sum(quantity_defective), 0) as total_quantity, count(*) as record_count
  from previous_ncm
),
totals as (
  select jsonb_build_object(
    'total_cost', c.total_cost,
    'total_quantity', c.total_quantity,
    'record_count', c.record_count,
    'cost_change_pct', case when p.total_cost = 0 and c.total_cost = 0 then 0 when p.total_cost = 0 then null
                            else round(100.0 * (c.total_cost - p.total_cost) / p.total_cost, 2) end,
    'quantity_change_pct', case when p.total_quantity = 0 and c.total_quantity = 0 then 0 when p.total_quantity = 0 then null
                                else round(100.0 * (c.total_quantity - p.total_quantity) / p.total_quantity, 2) end,
    'record_count_change_pct', case when p.record_count = 0 and c.record_count = 0 then 0 when p.record_count = 0 then null
                                    else round(100.0 * (c.record_count - p.record_count) / p.record_count, 2) end
  ) as data
  from current_totals c, previous_totals p
),
entities_json as (select jsonb_agg(te) as data from top_entities te),
causal_processes_json as (
  select jsonb_agg(jsonb_build_object('process_id', process_id, 'process_name', process_name,
                                      'code', code, 'total_defects', total_defects)) as data
  from top_causal_processes
),
grouped_subs as (
  select n.failure_mode as failure_mode_id, fm.name as failure_mode_name,
         n.sub_failure_mode as sub_failure_mode_id, sfm.name as sub_failure_mode_name,
         sum(n.quantity_defective) as quantity
  from current_ncm n
  join public."Failure Mode" fm on n.failure_mode = fm.id
  join public."Sub-Failure Mode" sfm on n.sub_failure_mode = sfm.id
  group by n.failure_mode, fm.name, n.sub_failure_mode, sfm.name
),
fm_sfm_quantities_grouped as (
  select jsonb_agg(jsonb_build_object('failure_mode_id', fm.failure_mode_id, 'failure_mode', fm.failure_mode_name,
                                      'total_quantity', fm.total_quantity, 'sub_failure_modes', fm.subs)) as data
  from (
    select failure_mode_id, failure_mode_name, sum(quantity) as total_quantity,
           jsonb_agg(jsonb_build_object('sub_failure_mode_id', sub_failure_mode_id,
                                        'sub_failure_mode', sub_failure_mode_name,
                                        'quantity', quantity) order by quantity desc) as subs
    from grouped_subs
    group by failure_mode_id, failure_mode_name
  ) fm
),
top_parts as (
  select jsonb_agg(jsonb_build_object('part_number', rp.part_number, 'part_name', rp.part_name,
                                      'total_defects', rp.total_defects) order by rp.total_defects desc) as data
  from (
    select p.part_number, p.name as part_name, sum(n.quantity_defective) as total_defects
    from current_ncm n
    join public."Part" p on n.part_number = p.id
    group by p.part_number, p.name
    order by total_defects desc
    limit 5
  ) rp
)
select jsonb_build_object(
  'top_entities', entities_json.data,
  'top_causal_processes', causal_processes_json.data,
  'totals', totals.data,
  'failure_mode_breakdown', fm_sfm_quantities_grouped.data,
  'top_parts', top_parts.data
)::json
from entities_json, causal_processes_json, totals, fm_sfm_quantities_grouped, top_parts;
$function$;

CREATE FUNCTION public.get_nc_date_trend(
  p_organisation_id uuid, start_date timestamptz, end_date timestamptz,
  override_period text DEFAULT NULL, nc_type text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = '' AS $function$
declare
  range_days integer := date_part('day', end_date - start_date);
  interval_unit text;
  step interval;
  result jsonb;
begin
  interval_unit := coalesce(lower(override_period), case
    when range_days <= 1 then 'hour'
    when range_days <= 7 then 'day'
    when range_days <= 90 then 'week'
    when range_days <= 365 then 'month'
    else 'quarter' end);

  if interval_unit not in ('hour', 'day', 'week', 'month', 'quarter', 'year') then
    raise exception 'invalid period %', override_period using errcode = 'invalid_parameter_value';
  end if;

  step := case interval_unit
    when 'hour' then interval '1 hour' when 'day' then interval '1 day'
    when 'week' then interval '1 week' when 'month' then interval '1 month'
    when 'quarter' then interval '3 months' else interval '1 year' end;

  with periods as (
    select generate_series(date_trunc(interval_unit, start_date), date_trunc(interval_unit, end_date), step) as period
  ),
  data as (
    select date_trunc(interval_unit, n.date) as period,
           count(*) as record_count,
           sum(n.quantity_defective) as total_quantity,
           sum(n.total_cost) as total_cost
    from public."NCM" n
    join public."Status" s on n.status = s.id
    where n.organisation_id = p_organisation_id
      and n.date between start_date and end_date
      and s.type != 'omit'
      and (nc_type is null or n.type = nc_type)
    group by 1
  )
  select jsonb_agg(jsonb_build_object(
    'period', p.period,
    'label', to_char(p.period, case interval_unit
      when 'hour' then 'HH24:00 Mon DD' when 'day' then 'DD Mon' when 'week' then '"Week "IW YYYY'
      when 'month' then 'Mon YYYY' when 'quarter' then '"Q"Q YYYY' else 'YYYY' end),
    'record_count', coalesce(d.record_count, 0),
    'total_quantity', coalesce(d.total_quantity, 0),
    'total_cost', coalesce(d.total_cost, 0)
  ) order by p.period)
  into result
  from periods p
  left join data d on p.period = d.period;

  return coalesce(result, '[]'::jsonb);
end;
$function$;

-- The caller's own notifications (no user parameter: always auth.uid()).
CREATE FUNCTION public.get_user_notifications()
RETURNS TABLE(id uuid, organisation_id uuid, title text, body text, meta_data jsonb, doc_ref text,
              read boolean, delivered_at timestamptz, created_by text, avatar_path text)
LANGUAGE sql STABLE SET search_path = '' AS $function$
  select nr.id, n.organisation_id, n.title, n.body, n.meta_data, n.doc_ref, nr.read, nr.delivered_at,
         nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.surname, '')), '') as created_by,
         p.avatar_path
  from public."Notification Recipients" nr
  join public."Notifications" n on n.id = nr.notification_id
  left join public.profiles p on p.id = n.created_by
  where nr.recipient_id = auth.uid()
  order by n.created_at desc
$function$;

REVOKE ALL ON FUNCTION public.get_nc_kpi_json(uuid, timestamptz, timestamptz, text),
  public.get_nc_date_trend(uuid, timestamptz, timestamptz, text, text),
  public.get_user_notifications() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_nc_kpi_json(uuid, timestamptz, timestamptz, text),
  public.get_nc_date_trend(uuid, timestamptz, timestamptz, text, text),
  public.get_user_notifications() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Storage: organisation-scoped paths, private avatars
--   nc-files: <organisation_id>/<...>
--   avatars:  users/<user_id>/<...>
-- ---------------------------------------------------------------------------
UPDATE storage.buckets SET public = false WHERE id = 'avatars';

DROP POLICY IF EXISTS objects_select_policy ON storage.objects;
DROP POLICY IF EXISTS objects_insert_policy ON storage.objects;
DROP POLICY IF EXISTS objects_update_policy ON storage.objects;
DROP POLICY IF EXISTS objects_delete_policy ON storage.objects;

CREATE POLICY nc_files_select ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'nc-files' AND app.has_permission(app.try_uuid(split_part(name, '/', 1)), 'ncr.read'));
CREATE POLICY nc_files_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'nc-files' AND app.has_permission(app.try_uuid(split_part(name, '/', 1)), 'ncr.update'));
CREATE POLICY nc_files_update ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'nc-files' AND app.has_permission(app.try_uuid(split_part(name, '/', 1)), 'ncr.update'))
  WITH CHECK (bucket_id = 'nc-files' AND app.has_permission(app.try_uuid(split_part(name, '/', 1)), 'ncr.update'));
CREATE POLICY nc_files_delete ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'nc-files' AND app.has_permission(app.try_uuid(split_part(name, '/', 1)), 'ncr.update'));

CREATE POLICY avatars_select ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'avatars' AND split_part(name, '/', 1) = 'users'
         AND (split_part(name, '/', 2) = auth.uid()::text
              OR app.shares_organisation(app.try_uuid(split_part(name, '/', 2)))));
CREATE POLICY avatars_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'avatars' AND split_part(name, '/', 1) = 'users' AND split_part(name, '/', 2) = auth.uid()::text);
CREATE POLICY avatars_update ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'avatars' AND split_part(name, '/', 1) = 'users' AND split_part(name, '/', 2) = auth.uid()::text)
  WITH CHECK (bucket_id = 'avatars' AND split_part(name, '/', 1) = 'users' AND split_part(name, '/', 2) = auth.uid()::text);
CREATE POLICY avatars_delete ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'avatars' AND split_part(name, '/', 1) = 'users' AND split_part(name, '/', 2) = auth.uid()::text);
