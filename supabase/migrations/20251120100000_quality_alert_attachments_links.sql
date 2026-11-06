-- DOC3: quality alert attachments and links (docs/documentation-plan.md §5, §8).
--
-- * quality_alert_attachments: files on a DRAFT alert (private bucket quality-alert-files at
--   <org>/quality-alerts/<alert id>/<uuid>-<name>). Written only by functions, draft only, removed by
--   marking with a reason (the file stays in storage as evidence; it can be restored while the alert is a draft). A revision copies the rows and keeps pointing at the
--   same stored files.
-- * quality_alert_links: optional references from an alert to a nonconformance, supplier, gauge or
--   calibration. Parts, families and machines are the alert's scope, so there is no separate part link.
--   Replaced as a whole on a draft by app.set_quality_alert_links; copied by a revision.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE public.quality_alert_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  alert_id uuid NOT NULL,
  storage_path text NOT NULL,
  file_name text NOT NULL CHECK (length(btrim(file_name)) BETWEEN 1 AND 255),
  content_type text,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 26214400),
  description text CHECK (description IS NULL OR length(description) <= 500),
  deleted_at timestamptz,
  deleted_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  delete_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT quality_alert_attachments_alert_fkey FOREIGN KEY (alert_id, organisation_id) REFERENCES public.quality_alerts (id, organisation_id) ON DELETE CASCADE,
  CONSTRAINT quality_alert_attachments_key UNIQUE (alert_id, storage_path),
  CONSTRAINT quality_alert_attachments_path CHECK (
    storage_path LIKE organisation_id::text || '/quality-alerts/%/%' AND storage_path NOT LIKE '%..%')
);
CREATE INDEX quality_alert_attachments_alert_idx ON public.quality_alert_attachments (alert_id);

CREATE TABLE public.quality_alert_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  alert_id uuid NOT NULL,
  nonconformance_id uuid,
  supplier_id uuid,
  gauge_id uuid,
  calibration_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT quality_alert_links_alert_fkey FOREIGN KEY (alert_id, organisation_id) REFERENCES public.quality_alerts (id, organisation_id) ON DELETE CASCADE,
  CONSTRAINT quality_alert_links_ncr_fkey FOREIGN KEY (nonconformance_id, organisation_id) REFERENCES public.nonconformances (id, organisation_id),
  CONSTRAINT quality_alert_links_supplier_fkey FOREIGN KEY (supplier_id, organisation_id) REFERENCES public.suppliers (id, organisation_id),
  CONSTRAINT quality_alert_links_gauge_fkey FOREIGN KEY (gauge_id, organisation_id) REFERENCES public.gauges (id, organisation_id),
  CONSTRAINT quality_alert_links_calibration_fkey FOREIGN KEY (calibration_id, organisation_id) REFERENCES public.calibrations (id, organisation_id),
  CONSTRAINT quality_alert_links_one CHECK (num_nonnulls(nonconformance_id, supplier_id, gauge_id, calibration_id) = 1)
);
CREATE UNIQUE INDEX quality_alert_links_key ON public.quality_alert_links
  (alert_id, coalesce(nonconformance_id, supplier_id, gauge_id, calibration_id),
   (nonconformance_id IS NULL), (supplier_id IS NULL), (gauge_id IS NULL));

-- ---------------------------------------------------------------------------
-- Rules, bookkeeping, audit, access
-- ---------------------------------------------------------------------------
-- Only the removal mark moves on an attachment, and only while its alert is a draft.
CREATE FUNCTION app.quality_alert_attachment_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['deleted_at', 'deleted_by', 'delete_reason', 'updated_at', 'updated_by'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['deleted_at', 'deleted_by', 'delete_reason', 'updated_at', 'updated_by']) THEN
    RAISE EXCEPTION 'An attachment cannot be changed, only removed from or restored to a draft' USING ERRCODE = 'QM012';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION app.quality_alert_attachment_no_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'Attachments of a quality alert are never deleted' USING ERRCODE = 'QM012';
END $$;

CREATE TRIGGER quality_alert_attachments_stamp BEFORE INSERT ON public.quality_alert_attachments FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER quality_alert_attachments_rules BEFORE UPDATE ON public.quality_alert_attachments FOR EACH ROW EXECUTE FUNCTION app.quality_alert_attachment_rules();
CREATE TRIGGER quality_alert_attachments_touch BEFORE UPDATE ON public.quality_alert_attachments FOR EACH ROW EXECUTE FUNCTION app.touch_updated();
CREATE TRIGGER quality_alert_attachments_org_immutable BEFORE UPDATE ON public.quality_alert_attachments FOR EACH ROW EXECUTE FUNCTION app.prevent_organisation_change();
CREATE TRIGGER quality_alert_attachments_no_delete BEFORE DELETE ON public.quality_alert_attachments FOR EACH ROW EXECUTE FUNCTION app.quality_alert_attachment_no_delete();
CREATE TRIGGER quality_alert_links_stamp BEFORE INSERT ON public.quality_alert_links FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.quality_alert_attachments FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.quality_alert_links FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');

ALTER TABLE public.quality_alert_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quality_alert_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.quality_alert_attachments, public.quality_alert_links FROM anon, authenticated;
GRANT SELECT ON public.quality_alert_attachments, public.quality_alert_links TO authenticated;
-- A child is visible exactly when its alert is (the alert's own policy applies to this subquery).
CREATE POLICY quality_alert_attachments_select ON public.quality_alert_attachments FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.quality_alerts a WHERE a.id = alert_id));
CREATE POLICY quality_alert_links_select ON public.quality_alert_links FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.quality_alerts a WHERE a.id = alert_id));

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------
-- Records a file already uploaded into the alert's folder. Draft only (documentation.manage).
CREATE FUNCTION app.add_quality_alert_attachment(p_alert_id uuid, p_storage_path text, p_file_name text, p_content_type text,
                                                 p_size_bytes bigint, p_description text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.quality_alerts%ROWTYPE; v_id uuid;
BEGIN
  a := app.quality_alert_for_update(p_alert_id, 'documentation.manage', true);
  IF p_storage_path NOT LIKE a.organisation_id::text || '/quality-alerts/' || a.id::text || '/%' THEN
    RAISE EXCEPTION 'The file must be stored in this alert''s folder' USING ERRCODE = 'QM012';
  END IF;
  INSERT INTO public.quality_alert_attachments (organisation_id, alert_id, storage_path, file_name, content_type, size_bytes, description)
  VALUES (a.organisation_id, a.id, p_storage_path, btrim(p_file_name), p_content_type, p_size_bytes, nullif(btrim(coalesce(p_description, '')), ''))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Takes a file off a draft, with the reason (the stored file is kept, and the file can be restored while the alert is a draft).
CREATE FUNCTION app.remove_quality_alert_attachment(p_attachment_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_alert uuid; v_removed timestamptz;
BEGIN
  SELECT alert_id, deleted_at INTO v_alert, v_removed FROM public.quality_alert_attachments WHERE id = p_attachment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Attachment not found' USING ERRCODE = 'QM012';
  END IF;
  PERFORM app.quality_alert_for_update(v_alert, 'documentation.manage', true);
  IF v_removed IS NOT NULL THEN
    RAISE EXCEPTION 'That file is already removed' USING ERRCODE = 'QM012';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'Say why the file is removed' USING ERRCODE = 'QM012';
  END IF;
  UPDATE public.quality_alert_attachments SET deleted_at = now(), deleted_by = auth.uid(), delete_reason = btrim(p_reason) WHERE id = p_attachment_id;
END $$;

CREATE FUNCTION app.restore_quality_alert_attachment(p_attachment_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_alert uuid; v_removed timestamptz;
BEGIN
  SELECT alert_id, deleted_at INTO v_alert, v_removed FROM public.quality_alert_attachments WHERE id = p_attachment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Attachment not found' USING ERRCODE = 'QM012';
  END IF;
  PERFORM app.quality_alert_for_update(v_alert, 'documentation.manage', true);
  IF v_removed IS NULL THEN
    RAISE EXCEPTION 'That file is not removed' USING ERRCODE = 'QM012';
  END IF;
  UPDATE public.quality_alert_attachments SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL WHERE id = p_attachment_id;
END $$;

-- Replaces a draft's links. p_links: [{"nonconformanceId"|"supplierId"|"gaugeId"|"calibrationId": uuid}]
CREATE FUNCTION app.set_quality_alert_links(p_id uuid, p_links jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.quality_alerts%ROWTYPE; l jsonb;
BEGIN
  a := app.quality_alert_for_update(p_id, 'documentation.manage', true);
  IF jsonb_typeof(coalesce(p_links, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'Links must be a list' USING ERRCODE = 'QM012';
  END IF;
  DELETE FROM public.quality_alert_links WHERE alert_id = p_id;
  FOR l IN SELECT * FROM jsonb_array_elements(coalesce(p_links, '[]'::jsonb)) LOOP
    -- Each link must name a live record of this organisation (readers who cannot see it get no label, see the API).
    IF l ? 'nonconformanceId' AND NOT EXISTS (SELECT 1 FROM public.nonconformances n WHERE n.id = (l ->> 'nonconformanceId')::uuid AND n.organisation_id = a.organisation_id AND n.deleted_at IS NULL) THEN
      RAISE EXCEPTION 'That nonconformance was not found' USING ERRCODE = 'QM012';
    END IF;
    IF l ? 'supplierId' AND NOT EXISTS (SELECT 1 FROM public.suppliers s WHERE s.id = (l ->> 'supplierId')::uuid AND s.organisation_id = a.organisation_id) THEN
      RAISE EXCEPTION 'That supplier was not found' USING ERRCODE = 'QM012';
    END IF;
    IF l ? 'gaugeId' AND NOT EXISTS (SELECT 1 FROM public.gauges g WHERE g.id = (l ->> 'gaugeId')::uuid AND g.organisation_id = a.organisation_id AND g.deleted_at IS NULL) THEN
      RAISE EXCEPTION 'That gauge was not found' USING ERRCODE = 'QM012';
    END IF;
    IF l ? 'calibrationId' AND NOT EXISTS (SELECT 1 FROM public.calibrations c WHERE c.id = (l ->> 'calibrationId')::uuid AND c.organisation_id = a.organisation_id AND c.deleted_at IS NULL) THEN
      RAISE EXCEPTION 'That calibration was not found' USING ERRCODE = 'QM012';
    END IF;
    INSERT INTO public.quality_alert_links (organisation_id, alert_id, nonconformance_id, supplier_id, gauge_id, calibration_id)
    VALUES (a.organisation_id, p_id, (l ->> 'nonconformanceId')::uuid, (l ->> 'supplierId')::uuid, (l ->> 'gaugeId')::uuid, (l ->> 'calibrationId')::uuid);
  END LOOP;
END $$;

-- A revision starts with the same files and links as the alert it replaces.
CREATE OR REPLACE FUNCTION app.revise_quality_alert(p_id uuid, p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.quality_alerts%ROWTYPE; v_new uuid;
BEGIN
  a := app.quality_alert_for_update(p_id, 'documentation.issue', false);
  IF a.status NOT IN ('active', 'expired') THEN
    RAISE EXCEPTION 'Only a current issued alert can be revised' USING ERRCODE = 'QM012';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'Say what is being corrected in this revision' USING ERRCODE = 'QM012';
  END IF;
  IF EXISTS (SELECT 1 FROM public.quality_alerts WHERE organisation_id = a.organisation_id AND alert_number = a.alert_number AND status = 'draft' AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'There is already a draft revision of this alert' USING ERRCODE = 'QM012';
  END IF;
  INSERT INTO public.quality_alerts (organisation_id, alert_number, reference, revision, title, category, severity, description, required_action,
                                     effective_date, expiry_date, acknowledge_by, revision_reason, supersedes_id)
  VALUES (a.organisation_id, a.alert_number, a.reference, a.revision + 1, a.title, a.category, a.severity, a.description, a.required_action,
          NULL, a.expiry_date, NULL, btrim(p_reason), a.id)
  RETURNING id INTO v_new;
  INSERT INTO public.quality_alert_parts (organisation_id, alert_id, part_id, part_family_id)
    SELECT organisation_id, v_new, part_id, part_family_id FROM public.quality_alert_parts WHERE alert_id = p_id;
  INSERT INTO public.quality_alert_machines (organisation_id, alert_id, machine_id)
    SELECT organisation_id, v_new, machine_id FROM public.quality_alert_machines WHERE alert_id = p_id;
  INSERT INTO public.quality_alert_operations (organisation_id, alert_id, operation_code)
    SELECT organisation_id, v_new, operation_code FROM public.quality_alert_operations WHERE alert_id = p_id;
  INSERT INTO public.quality_alert_departments (organisation_id, alert_id, department_id)
    SELECT organisation_id, v_new, department_id FROM public.quality_alert_departments WHERE alert_id = p_id;
  INSERT INTO public.quality_alert_targets (organisation_id, alert_id, department_id, role_id, membership_id)
    SELECT organisation_id, v_new, department_id, role_id, membership_id FROM public.quality_alert_targets WHERE alert_id = p_id;
  INSERT INTO public.quality_alert_links (organisation_id, alert_id, nonconformance_id, supplier_id, gauge_id, calibration_id)
    SELECT organisation_id, v_new, nonconformance_id, supplier_id, gauge_id, calibration_id FROM public.quality_alert_links WHERE alert_id = p_id;
  INSERT INTO public.quality_alert_attachments (organisation_id, alert_id, storage_path, file_name, content_type, size_bytes, description)
    SELECT organisation_id, v_new, storage_path, file_name, content_type, size_bytes, description
      FROM public.quality_alert_attachments WHERE alert_id = p_id AND deleted_at IS NULL;
  RETURN v_new;
END $$;

REVOKE ALL ON FUNCTION app.quality_alert_attachment_rules(), app.quality_alert_attachment_no_delete(),
  app.add_quality_alert_attachment(uuid, text, text, text, bigint, text), app.remove_quality_alert_attachment(uuid, text), app.restore_quality_alert_attachment(uuid),
  app.set_quality_alert_links(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.add_quality_alert_attachment(uuid, text, text, text, bigint, text), app.remove_quality_alert_attachment(uuid, text), app.restore_quality_alert_attachment(uuid),
  app.set_quality_alert_links(uuid, jsonb) TO authenticated;

-- ---------------------------------------------------------------------------
-- Storage: <org>/quality-alerts/<alert id>/... Readable by anyone who can see the alert (so a revision
-- can keep using the files of the revision it copied); uploads only into the folder of a draft the
-- caller manages. Objects are never updated or deleted by users.
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public) VALUES ('quality-alert-files', 'quality-alert-files', false)
ON CONFLICT (id) DO NOTHING;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'storage' AND table_name = 'buckets' AND column_name = 'file_size_limit') THEN
    EXECUTE $q$UPDATE storage.buckets SET file_size_limit = 26214400 WHERE id = 'quality-alert-files'$q$;
  END IF;
END $$;

CREATE FUNCTION app.quality_alert_file_allowed(p_object_name text, p_upload boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT split_part(p_object_name, '/', 2) = 'quality-alerts'
     AND EXISTS (
       SELECT 1 FROM public.quality_alerts a
       WHERE a.id = app.try_uuid(split_part(p_object_name, '/', 3))
         AND a.organisation_id = app.try_uuid(split_part(p_object_name, '/', 1))
         AND a.deleted_at IS NULL
         AND CASE WHEN p_upload
                  THEN a.status = 'draft' AND app.has_permission(a.organisation_id, 'documentation.manage')
                  ELSE (a.status <> 'draft' AND app.has_permission(a.organisation_id, 'documentation.read'))
                       OR app.has_permission(a.organisation_id, 'documentation.manage') END)
$$;
REVOKE ALL ON FUNCTION app.quality_alert_file_allowed(text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.quality_alert_file_allowed(text, boolean) TO authenticated;

CREATE POLICY quality_alert_files_select ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'quality-alert-files' AND app.quality_alert_file_allowed(name, false));
CREATE POLICY quality_alert_files_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'quality-alert-files' AND app.quality_alert_file_allowed(name, true));
