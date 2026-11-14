-- Organisation security SE3 (docs/security-plan.md, decision S3): files go through the API.
--
-- 1. app.storage_file_allowed(bucket, name, write) is the ONE statement of who may read or add a file in each organisation bucket. The storage
--    policies call it, and so does the API before it signs a link, so the two can never disagree.
-- 2. app.storage_direct_allowed(name): while an organisation's network policy is 'enforce', the storage policies of its buckets refuse every
--    request that does not come through the API. The API is recognised by its own login (session_user = 'qms_api'), which a browser cannot
--    be: PostgREST and Storage connect as their own roles. The API has already checked the network in OrganisationGuard.
--    The API's own checks that an uploaded object exists (select 1 from storage.objects … as the person) therefore keep working when enforced.
-- 3. Avatars are the person's own (users/<user id>/…), not the organisation's, and are left as they are.

-- ---------------------------------------------------------------------------
-- The rule per bucket (same expressions as the policies it replaces)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.storage_file_allowed(p_bucket text, p_name text, p_write boolean) RETURNS boolean
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT coalesce(CASE p_bucket
    WHEN 'audit-files'         THEN app.audit_file_allowed(p_name, p_write)
    WHEN 'calibration-files'   THEN app.calibration_file_allowed(p_name, CASE WHEN p_write THEN 'calibration.record' ELSE 'calibration.read' END)
    WHEN 'capa-files'          THEN app.capa_file_allowed(p_name, p_write)
    WHEN 'competence-files'    THEN app.competence_file_allowed(p_name, p_write)
    WHEN 'document-files'      THEN app.document_file_allowed(p_name, p_write)
    WHEN 'inspection-files'    THEN app.inspection_file_allowed(p_name, p_write)
    WHEN 'integration-files'   THEN app.integration_file_allowed(p_name, p_write)
    WHEN 'nc-files'            THEN app.ncr_file_allowed(p_name, CASE WHEN p_write THEN 'ncr.update' ELSE 'ncr.read' END)
    WHEN 'quality-alert-files' THEN app.quality_alert_file_allowed(p_name, p_write)
    WHEN 'supplier-files'      THEN app.supplier_file_allowed(p_name, p_write)
    WHEN 'org-logos'           THEN split_part(p_name, '/', 2) = 'logo' AND CASE WHEN p_write
                                      THEN app.has_permission(app.try_uuid(split_part(p_name, '/', 1)), 'organisation.manage')
                                      ELSE app.is_member(app.try_uuid(split_part(p_name, '/', 1))) END
    ELSE false
  END, false)
$$;

-- Direct access (not through the API) to an organisation's files: refused while the organisation enforces its network policy.
CREATE FUNCTION app.storage_direct_allowed(p_name text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT session_user = 'qms_api'
      OR coalesce((SELECT s.network_policy FROM public.organisation_settings s
                    WHERE s.organisation_id = app.try_uuid(split_part(p_name, '/', 1))), 'off') <> 'enforce'
$$;

REVOKE ALL ON FUNCTION app.storage_file_allowed(text, text, boolean), app.storage_direct_allowed(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.storage_file_allowed(text, text, boolean), app.storage_direct_allowed(text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Policies: the same rules, through the one function, plus the direct-access check
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v record;
BEGIN
  FOR v IN SELECT * FROM (VALUES
      ('audit-files', 'audit_files'), ('calibration-files', 'calibration_files'), ('capa-files', 'capa_files'),
      ('competence-files', 'competence_files'), ('document-files', 'document_files'), ('inspection-files', 'inspection_files'),
      ('integration-files', 'integration_files'), ('nc-files', 'nc_files'), ('quality-alert-files', 'quality_alert_files'),
      ('supplier-files', 'supplier_files'), ('org-logos', 'org_logos')) AS t(bucket, prefix)
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects', v.prefix || '_insert');
    EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects', v.prefix || '_select');
    EXECUTE format($p$CREATE POLICY %I ON storage.objects FOR INSERT TO authenticated
                      WITH CHECK (bucket_id = %L AND app.storage_file_allowed(bucket_id, name, true) AND app.storage_direct_allowed(name))$p$,
                   v.prefix || '_insert', v.bucket);
    EXECUTE format($p$CREATE POLICY %I ON storage.objects FOR SELECT TO authenticated
                      USING (bucket_id = %L AND app.storage_file_allowed(bucket_id, name, false) AND app.storage_direct_allowed(name))$p$,
                   v.prefix || '_select', v.bucket);
  END LOOP;
END $$;

-- Logos are the one organisation bucket where files are replaced and removed.
DROP POLICY IF EXISTS org_logos_update ON storage.objects;
DROP POLICY IF EXISTS org_logos_delete ON storage.objects;
CREATE POLICY org_logos_update ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'org-logos' AND app.has_permission(app.try_uuid(split_part(name, '/', 1)), 'organisation.manage') AND app.storage_direct_allowed(name))
  WITH CHECK (bucket_id = 'org-logos' AND app.storage_file_allowed(bucket_id, name, true) AND app.storage_direct_allowed(name));
CREATE POLICY org_logos_delete ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'org-logos' AND app.has_permission(app.try_uuid(split_part(name, '/', 1)), 'organisation.manage') AND app.storage_direct_allowed(name));
