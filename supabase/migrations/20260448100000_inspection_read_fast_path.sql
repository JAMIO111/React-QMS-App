/*
 * Reading inspection data checked the caller's permission once per row, per table: the policies call app.has_permission(organisation, 'inspection.read',
 * <the record's site>), a function that joins memberships, roles, MFA, subscription and seat state, and the readings and samples find the site first with
 * a lookup of the record. A chart of 190 readings joins four such tables, about 1.2 ms a reading; a dashboard over a year of readings runs for seconds.
 *
 * The answer cannot change from row to row for someone who holds the permission for the whole organisation: has_permission(org, perm) with no site is true
 * exactly when an organisation-wide assignment grants it (a site-limited one does not match a NULL site), and every other condition in the function is
 * about the organisation, not the site. app.orgs_permitted(perm) lists those organisations, and each policy now says
 *   organisation_id IN (that list)  OR  <the old per-row check>
 * The list does not depend on the row, so Postgres works it out once per statement and hashes it; rows in those organisations are then allowed without
 * the per-row function, and everyone else (site-limited roles, other organisations) falls through to exactly the check that was there before. Nothing is
 * widened: a row is visible now only if it was visible before. Writes keep their own policies.
 */

CREATE OR REPLACE FUNCTION app.orgs_permitted(p_permission text) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT m.organisation_id
  FROM public.organisation_users m
  WHERE m.user_id = auth.uid() AND m.status = 'active'
    AND app.has_permission(m.organisation_id, p_permission)
$$;
REVOKE ALL ON FUNCTION app.orgs_permitted(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.orgs_permitted(text) TO authenticated;

DROP POLICY inspection_records_select ON public.inspection_records;
CREATE POLICY inspection_records_select ON public.inspection_records FOR SELECT TO authenticated
  USING (organisation_id IN (SELECT app.orgs_permitted('inspection.read'))
         OR app.has_permission(organisation_id, 'inspection.read', site_id));

DROP POLICY resolved_inspection_requirements_select ON public.resolved_inspection_requirements;
CREATE POLICY resolved_inspection_requirements_select ON public.resolved_inspection_requirements FOR SELECT TO authenticated
  USING (organisation_id IN (SELECT app.orgs_permitted('inspection.read'))
         OR app.has_permission(organisation_id, 'inspection.read', app.inspection_site(inspection_record_id)));

DROP POLICY inspection_samples_select ON public.inspection_samples;
CREATE POLICY inspection_samples_select ON public.inspection_samples FOR SELECT TO authenticated
  USING (organisation_id IN (SELECT app.orgs_permitted('inspection.read'))
         OR app.has_permission(organisation_id, 'inspection.read', app.inspection_site(inspection_record_id)));

DROP POLICY inspection_measurements_select ON public.inspection_measurements;
CREATE POLICY inspection_measurements_select ON public.inspection_measurements FOR SELECT TO authenticated
  USING (organisation_id IN (SELECT app.orgs_permitted('inspection.read'))
         OR app.has_permission(organisation_id, 'inspection.read', app.inspection_site(inspection_record_id)));
