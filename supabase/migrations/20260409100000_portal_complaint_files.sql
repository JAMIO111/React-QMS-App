-- External portal PT5e (docs/external-portal-plan.md §6, decisions X3, X11): a customer adds photos or documents to a complaint they raised.
--
--  * The files are ordinary ncr_attachments of the complaint's draft non-conformance (same private nc-files bucket, <org>/ncr/<ncr id>/...), so staff see
--    them on the NC page with no new screen. Nothing else of the NC's files is ever shown to the customer: they see only files added by people of their own
--    party, and can take back only their own.
--  * Only while the complaint is still a draft ("received"); once staff open it the customer talks to us in the shared record's conversation instead.
--    At most ten live files per complaint, 25 MB each (the table's own limit).
--  * Functions only: app.portal_complaint_upload_allowed (the API checks it before it signs an upload with the service key; the API chooses the path),
--    portal_add_complaint_file, portal_remove_complaint_file, portal_complaint_files, portal_complaint_file_path. The caller's own live access to the
--    CUSTOMER party that raised the complaint decides everything (404 otherwise).

-- The complaint of the caller's own party, or no_data_found.
CREATE FUNCTION app.portal_complaint_for_external(p_complaint uuid) RETURNS public.portal_complaints
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.portal_complaints;
BEGIN
  SELECT * INTO c FROM public.portal_complaints WHERE id = p_complaint;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM app.portal_my_access(c.organisation_id) a WHERE a.party_id = c.party_id AND a.party_kind = 'customer') THEN
    RAISE EXCEPTION 'complaint not found' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN c;
END $$;
REVOKE ALL ON FUNCTION app.portal_complaint_for_external(uuid) FROM PUBLIC, anon, authenticated;

-- The id of the non-conformance behind the caller's own complaint (its folder in the bucket), or no_data_found.
CREATE FUNCTION app.portal_complaint_folder(p_complaint uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.portal_complaints;
BEGIN
  c := app.portal_complaint_for_external(p_complaint);
  RETURN c.nonconformance_id;
END $$;
REVOKE ALL ON FUNCTION app.portal_complaint_folder(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_complaint_folder(uuid) TO authenticated;

CREATE FUNCTION app.portal_complaint_upload_allowed(p_complaint uuid, p_path text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.portal_complaints; n public.nonconformances;
BEGIN
  c := app.portal_complaint_for_external(p_complaint);
  SELECT * INTO n FROM public.nonconformances WHERE id = c.nonconformance_id;
  RETURN n.stage = 'draft' AND n.deleted_at IS NULL
     AND p_path LIKE c.organisation_id::text || '/ncr/' || c.nonconformance_id::text || '/%' AND p_path NOT LIKE '%..%'
     AND (SELECT count(*) FROM public.ncr_attachments f WHERE f.nonconformance_id = c.nonconformance_id AND f.deleted_at IS NULL
                AND f.created_by IN (SELECT e.user_id FROM public.external_access e WHERE e.party_id = c.party_id)) < 10;
END $$;
REVOKE ALL ON FUNCTION app.portal_complaint_upload_allowed(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_complaint_upload_allowed(uuid, text) TO authenticated;

CREATE FUNCTION app.portal_add_complaint_file(p_complaint uuid, p_path text, p_name text, p_type text, p_size bigint) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.portal_complaints; v_id uuid;
BEGIN
  c := app.portal_complaint_for_external(p_complaint);
  IF NOT app.portal_complaint_upload_allowed(p_complaint, p_path) THEN
    RAISE EXCEPTION 'Files can be added to a complaint only until we start work on it, and at most ten' USING ERRCODE = 'QM032';
  END IF;
  IF length(btrim(coalesce(p_name, ''))) NOT BETWEEN 1 AND 255 OR p_size IS NULL OR p_size < 0 OR p_size > 26214400 THEN RAISE EXCEPTION 'The file name or size is not valid (25 MB at most)' USING ERRCODE = 'QM032'; END IF;
  INSERT INTO public.ncr_attachments (organisation_id, nonconformance_id, storage_path, file_name, content_type, size_bytes, description)
  VALUES (c.organisation_id, c.nonconformance_id, p_path, btrim(p_name), p_type, p_size, 'Added by the customer with the complaint') RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION app.portal_add_complaint_file(uuid, text, text, text, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_add_complaint_file(uuid, text, text, text, bigint) TO authenticated;

-- Take back a file the caller added themselves, while the complaint is still a draft. Answers with the complaint's id.
CREATE FUNCTION app.portal_remove_complaint_file(p_file uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE f public.ncr_attachments; c public.portal_complaints; n public.nonconformances;
BEGIN
  SELECT * INTO f FROM public.ncr_attachments WHERE id = p_file AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'file not found' USING ERRCODE = 'no_data_found'; END IF;
  SELECT * INTO c FROM public.portal_complaints WHERE nonconformance_id = f.nonconformance_id AND organisation_id = f.organisation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'file not found' USING ERRCODE = 'no_data_found'; END IF;
  c := app.portal_complaint_for_external(c.id);
  IF f.created_by IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'file not found' USING ERRCODE = 'no_data_found'; END IF;
  SELECT * INTO n FROM public.nonconformances WHERE id = c.nonconformance_id;
  IF n.stage <> 'draft' THEN RAISE EXCEPTION 'A file cannot be taken back once we have started work on the complaint' USING ERRCODE = 'QM032'; END IF;
  UPDATE public.ncr_attachments SET deleted_at = now(), delete_reason = 'Taken back by the customer' WHERE id = p_file;
  RETURN c.id;
END $$;
REVOKE ALL ON FUNCTION app.portal_remove_complaint_file(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_remove_complaint_file(uuid) TO authenticated;

-- The files of the party's complaints that people of the party added (never staff's own files on the NC).
CREATE FUNCTION app.portal_complaint_files(p_org uuid, p_party uuid)
RETURNS TABLE (complaint_id uuid, file_id uuid, file_name text, size_bytes bigint, added_at timestamptz, mine boolean, can_remove boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_customer uuid := app.portal_customer_party(p_org, p_party);
BEGIN
  RETURN QUERY
  SELECT c.id, f.id, f.file_name, f.size_bytes, f.created_at, f.created_by = auth.uid(), f.created_by = auth.uid() AND n.stage = 'draft'
    FROM public.portal_complaints c
    JOIN public.nonconformances n ON n.id = c.nonconformance_id AND n.organisation_id = c.organisation_id AND n.customer_id = v_customer
    JOIN public.ncr_attachments f ON f.nonconformance_id = c.nonconformance_id AND f.organisation_id = c.organisation_id AND f.deleted_at IS NULL
   WHERE c.organisation_id = p_org AND c.party_id = p_party
     AND f.created_by IN (SELECT e.user_id FROM public.external_access e WHERE e.party_id = p_party)
   ORDER BY f.created_at;
END $$;
REVOKE ALL ON FUNCTION app.portal_complaint_files(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_complaint_files(uuid, uuid) TO authenticated;

-- The path of one of those files, for a short download link.
CREATE FUNCTION app.portal_complaint_file_path(p_file uuid) RETURNS TABLE (storage_path text, file_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE f public.ncr_attachments; c public.portal_complaints;
BEGIN
  SELECT * INTO f FROM public.ncr_attachments WHERE id = p_file AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'file not found' USING ERRCODE = 'no_data_found'; END IF;
  SELECT * INTO c FROM public.portal_complaints WHERE nonconformance_id = f.nonconformance_id AND organisation_id = f.organisation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'file not found' USING ERRCODE = 'no_data_found'; END IF;
  c := app.portal_complaint_for_external(c.id);
  IF NOT EXISTS (SELECT 1 FROM public.external_access e WHERE e.party_id = c.party_id AND e.user_id = f.created_by) THEN RAISE EXCEPTION 'file not found' USING ERRCODE = 'no_data_found'; END IF;
  RETURN QUERY SELECT f.storage_path, f.file_name;
END $$;
REVOKE ALL ON FUNCTION app.portal_complaint_file_path(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_complaint_file_path(uuid) TO authenticated;
