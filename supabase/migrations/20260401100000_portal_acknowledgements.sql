-- External portal, slice PT3c (docs/external-portal-plan.md §6, decisions X2, X3, X11, X12): staff share a controlled document or a quality alert with a
-- supplier or customer, who reads it in the portal and acknowledges it.
--
--  * portal_shares learns two more kinds of record: 'document' (the document, so the party always sees the revision in force) and 'quality_alert' (one
--    alert revision). Everything about sharing (one live share per party and record, withdrawing with a reason, the conversation, "seen", email) is the
--    same as for non-conformances and 8Ds. Both can be shared with any party that has the portal switched on (no record names a party for these).
--  * portal_acknowledgements: one row per person and thing acknowledged (a document REVISION, or the alert), with an optional note. Written only by
--    app.portal_acknowledge_share, frozen, audited. A new revision of a document asks again: the party sees "acknowledged" only for the revision in force.
--  * The external views are functions returning NAMED fields only (PT0 T3). A document shows its number, title, revision, effective date, what changed,
--    the text (written documents) and its files (opened on short links, only files of the revision in force); an alert shows what happened, what is
--    asked, the dates, never departments, machines, attachments, recipients or who issued it.
--  * Staff are told when a party acknowledges (portal_activity, as for SCARs). Quality alert attachments are not shown to the party in this slice.
-- Errors use QM032 (409 portal_rule); a share or file that is not the caller's is P0002 (404).

-- ---------------------------------------------------------------------------
-- Shares of documents and quality alerts
-- ---------------------------------------------------------------------------
ALTER TABLE public.portal_shares DROP CONSTRAINT IF EXISTS portal_shares_record_kind_check;
ALTER TABLE public.portal_shares DROP CONSTRAINT IF EXISTS portal_shares_one_record;
ALTER TABLE public.portal_shares
  ADD COLUMN document_id uuid,
  ADD COLUMN quality_alert_id uuid,
  ADD CONSTRAINT portal_shares_document_fkey FOREIGN KEY (document_id, organisation_id) REFERENCES public.documents (id, organisation_id),
  ADD CONSTRAINT portal_shares_alert_fkey FOREIGN KEY (quality_alert_id, organisation_id) REFERENCES public.quality_alerts (id, organisation_id),
  ADD CONSTRAINT portal_shares_record_kind_check CHECK (record_kind IN ('ncr', 'capa', 'document', 'quality_alert')),
  ADD CONSTRAINT portal_shares_one_record CHECK (
    (record_kind = 'ncr' AND nonconformance_id IS NOT NULL AND capa_id IS NULL AND document_id IS NULL AND quality_alert_id IS NULL)
 OR (record_kind = 'capa' AND capa_id IS NOT NULL AND nonconformance_id IS NULL AND document_id IS NULL AND quality_alert_id IS NULL)
 OR (record_kind = 'document' AND document_id IS NOT NULL AND nonconformance_id IS NULL AND capa_id IS NULL AND quality_alert_id IS NULL)
 OR (record_kind = 'quality_alert' AND quality_alert_id IS NOT NULL AND nonconformance_id IS NULL AND capa_id IS NULL AND document_id IS NULL));
CREATE UNIQUE INDEX portal_shares_document_live_key ON public.portal_shares (party_id, document_id) WHERE withdrawn_at IS NULL AND document_id IS NOT NULL;
CREATE UNIQUE INDEX portal_shares_alert_live_key ON public.portal_shares (party_id, quality_alert_id) WHERE withdrawn_at IS NULL AND quality_alert_id IS NOT NULL;

CREATE OR REPLACE FUNCTION app.portal_share_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A share is never deleted. Withdraw it with a reason.' USING ERRCODE = 'QM032'; END IF;
  IF NEW.party_id <> OLD.party_id OR NEW.record_kind <> OLD.record_kind OR NEW.nonconformance_id IS DISTINCT FROM OLD.nonconformance_id
     OR NEW.capa_id IS DISTINCT FROM OLD.capa_id OR NEW.document_id IS DISTINCT FROM OLD.document_id OR NEW.quality_alert_id IS DISTINCT FROM OLD.quality_alert_id
     OR NEW.shared_at <> OLD.shared_at THEN
    RAISE EXCEPTION 'What a share is for cannot change' USING ERRCODE = 'QM032';
  END IF;
  IF OLD.withdrawn_at IS NOT NULL THEN RAISE EXCEPTION 'A withdrawn share cannot be changed. Share the record again.' USING ERRCODE = 'QM032'; END IF;
  RETURN NEW;
END $$;

-- Activity can now be about a document or an alert, and an acknowledgement.
ALTER TABLE public.portal_activity DROP CONSTRAINT IF EXISTS portal_activity_kind_check;
ALTER TABLE public.portal_activity DROP CONSTRAINT IF EXISTS portal_activity_record_kind_check;
ALTER TABLE public.portal_activity
  ADD CONSTRAINT portal_activity_kind_check CHECK (kind IN ('scar_acknowledged', 'scar_response', 'scar_extension_requested', 'scar_extension_withdrawn', 'comment', 'acknowledged')),
  ADD CONSTRAINT portal_activity_record_kind_check CHECK (record_kind IN ('scar', 'ncr', 'capa', 'document', 'quality_alert'));

-- ---------------------------------------------------------------------------
-- Acknowledgements
-- ---------------------------------------------------------------------------
CREATE TABLE public.portal_acknowledgements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  share_id uuid NOT NULL,
  acknowledged_by uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE CASCADE,
  subject_id uuid NOT NULL,
  subject_label text NOT NULL,
  note text CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 1000),
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT portal_acknowledgements_share_fkey FOREIGN KEY (share_id, organisation_id) REFERENCES public.portal_shares (id, organisation_id),
  CONSTRAINT portal_acknowledgements_once_key UNIQUE (share_id, acknowledged_by, subject_id)
);
CREATE INDEX portal_acknowledgements_share_idx ON public.portal_acknowledgements (share_id, subject_id);
CREATE FUNCTION app.portal_acknowledgement_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN RAISE EXCEPTION 'An acknowledgement is never changed or deleted' USING ERRCODE = 'QM032'; END $$;
CREATE TRIGGER portal_acknowledgements_frozen BEFORE UPDATE OR DELETE ON public.portal_acknowledgements FOR EACH ROW EXECUTE FUNCTION app.portal_acknowledgement_frozen();
CREATE TRIGGER portal_acknowledgements_stamp BEFORE INSERT ON public.portal_acknowledgements FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
CREATE TRIGGER audit_changes AFTER INSERT ON public.portal_acknowledgements FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
ALTER TABLE public.portal_acknowledgements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.portal_acknowledgements FROM anon, authenticated;
GRANT SELECT ON public.portal_acknowledgements TO authenticated;
CREATE POLICY portal_acknowledgements_select ON public.portal_acknowledgements FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'external_access.share'));
REVOKE ALL ON FUNCTION app.portal_acknowledgement_frozen() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Who a record can be shared with, and sharing it
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.portal_eligible_parties(p_kind text, p_record uuid)
RETURNS TABLE (party_id uuid, party_kind text, party_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid;
BEGIN
  IF p_kind = 'ncr' THEN SELECT organisation_id INTO v_org FROM public.nonconformances WHERE id = p_record;
  ELSIF p_kind = 'capa' THEN SELECT organisation_id INTO v_org FROM public.capas WHERE id = p_record;
  ELSIF p_kind = 'document' THEN SELECT organisation_id INTO v_org FROM public.documents WHERE id = p_record;
  ELSIF p_kind = 'quality_alert' THEN SELECT organisation_id INTO v_org FROM public.quality_alerts WHERE id = p_record;
  ELSE RAISE EXCEPTION 'That kind of record cannot be shared' USING ERRCODE = 'QM032'; END IF;
  IF v_org IS NULL OR NOT app.has_permission(v_org, 'external_access.share') THEN RAISE EXCEPTION 'record not found' USING ERRCODE = 'no_data_found'; END IF;
  RETURN QUERY
  SELECT p.id, p.party_kind, coalesce(sup.name, cus.name)
    FROM public.portal_parties p
    JOIN public.organisation_settings s ON s.organisation_id = p.organisation_id AND s.portal_enabled
    LEFT JOIN public.suppliers sup ON sup.id = p.supplier_id
    LEFT JOIN public.customers cus ON cus.id = p.customer_id
   WHERE p.organisation_id = v_org AND p.enabled
     AND CASE p_kind
           WHEN 'ncr' THEN EXISTS (SELECT 1 FROM public.nonconformances n WHERE n.id = p_record AND (n.supplier_id = p.supplier_id OR n.customer_id = p.customer_id))
           WHEN 'capa' THEN EXISTS (SELECT 1 FROM public.capa_ncr_links l JOIN public.nonconformances n ON n.id = l.nonconformance_id
                         WHERE l.capa_id = p_record AND l.ended_at IS NULL AND n.deleted_at IS NULL AND (n.supplier_id = p.supplier_id OR n.customer_id = p.customer_id))
           ELSE true
         END
     AND NOT EXISTS (SELECT 1 FROM public.portal_shares x WHERE x.party_id = p.id AND x.withdrawn_at IS NULL
                      AND ((p_kind = 'ncr' AND x.nonconformance_id = p_record) OR (p_kind = 'capa' AND x.capa_id = p_record)
                        OR (p_kind = 'document' AND x.document_id = p_record) OR (p_kind = 'quality_alert' AND x.quality_alert_id = p_record)))
   ORDER BY 3;
END $$;

CREATE OR REPLACE FUNCTION app.share_with_portal(p_kind text, p_record uuid, p_party uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid; v_id uuid; n public.nonconformances; c public.capas; d public.documents; a public.quality_alerts;
BEGIN
  IF p_kind = 'ncr' THEN
    SELECT * INTO n FROM public.nonconformances WHERE id = p_record;
    IF NOT FOUND THEN RAISE EXCEPTION 'record not found' USING ERRCODE = 'no_data_found'; END IF;
    v_org := n.organisation_id;
    IF NOT app.has_permission(v_org, 'external_access.share') OR NOT app.has_permission(v_org, 'ncr.read', n.site_id) THEN
      RAISE EXCEPTION 'You are not allowed to share this non-conformance' USING ERRCODE = '42501';
    END IF;
    IF n.deleted_at IS NOT NULL OR n.stage IN ('draft', 'cancelled') THEN RAISE EXCEPTION 'Only an open, running or closed non-conformance can be shared. Open it first.' USING ERRCODE = 'QM032'; END IF;
  ELSIF p_kind = 'capa' THEN
    SELECT * INTO c FROM public.capas WHERE id = p_record;
    IF NOT FOUND THEN RAISE EXCEPTION 'record not found' USING ERRCODE = 'no_data_found'; END IF;
    v_org := c.organisation_id;
    IF NOT app.has_permission(v_org, 'external_access.share') OR NOT app.has_permission(v_org, 'capa.read') THEN
      RAISE EXCEPTION 'You are not allowed to share this 8D' USING ERRCODE = '42501';
    END IF;
    IF c.stage = 'cancelled' THEN RAISE EXCEPTION 'A cancelled 8D cannot be shared' USING ERRCODE = 'QM032'; END IF;
  ELSIF p_kind = 'document' THEN
    SELECT * INTO d FROM public.documents WHERE id = p_record;
    IF NOT FOUND THEN RAISE EXCEPTION 'record not found' USING ERRCODE = 'no_data_found'; END IF;
    v_org := d.organisation_id;
    IF NOT app.has_permission(v_org, 'external_access.share') OR NOT app.has_permission(v_org, 'documentation.read') THEN
      RAISE EXCEPTION 'You are not allowed to share this document' USING ERRCODE = '42501';
    END IF;
    IF d.status <> 'active' OR d.current_revision_id IS NULL THEN RAISE EXCEPTION 'Only a document that is in force can be shared' USING ERRCODE = 'QM032'; END IF;
  ELSIF p_kind = 'quality_alert' THEN
    SELECT * INTO a FROM public.quality_alerts WHERE id = p_record AND deleted_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'record not found' USING ERRCODE = 'no_data_found'; END IF;
    v_org := a.organisation_id;
    IF NOT app.has_permission(v_org, 'external_access.share') OR NOT app.has_permission(v_org, 'documentation.read') THEN
      RAISE EXCEPTION 'You are not allowed to share this quality alert' USING ERRCODE = '42501';
    END IF;
    IF a.status <> 'active' THEN RAISE EXCEPTION 'Only a quality alert that is in force can be shared' USING ERRCODE = 'QM032'; END IF;
  ELSE
    RAISE EXCEPTION 'That kind of record cannot be shared' USING ERRCODE = 'QM032';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.portal_parties WHERE id = p_party AND organisation_id = v_org) THEN RAISE EXCEPTION 'party not found' USING ERRCODE = 'no_data_found'; END IF;
  IF EXISTS (SELECT 1 FROM public.portal_shares WHERE party_id = p_party AND withdrawn_at IS NULL
              AND ((p_kind = 'ncr' AND nonconformance_id = p_record) OR (p_kind = 'capa' AND capa_id = p_record)
                OR (p_kind = 'document' AND document_id = p_record) OR (p_kind = 'quality_alert' AND quality_alert_id = p_record))) THEN
    RAISE EXCEPTION 'That record is already shared with them' USING ERRCODE = 'QM032';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.portal_eligible_parties(p_kind, p_record) e WHERE e.party_id = p_party) THEN
    RAISE EXCEPTION '%', CASE WHEN p_kind IN ('ncr', 'capa') THEN 'This record can be shared only with a supplier or customer it names, who has the portal switched on'
                              ELSE 'This can be shared only with a supplier or customer that has the portal switched on' END USING ERRCODE = 'QM032';
  END IF;
  INSERT INTO public.portal_shares (organisation_id, party_id, record_kind, nonconformance_id, capa_id, document_id, quality_alert_id)
  VALUES (v_org, p_party, p_kind, CASE WHEN p_kind = 'ncr' THEN p_record END, CASE WHEN p_kind = 'capa' THEN p_record END,
          CASE WHEN p_kind = 'document' THEN p_record END, CASE WHEN p_kind = 'quality_alert' THEN p_record END)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION app.list_portal_shares(p_kind text, p_record uuid)
RETURNS TABLE (share_id uuid, party_id uuid, party_kind text, party_name text, shared_at timestamptz, shared_by_name text, withdrawn_at timestamptz,
               withdrawn_reason text, viewers integer, first_viewed_at timestamptz, last_viewed_at timestamptz, comments integer, external_comments integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid;
BEGIN
  IF p_kind = 'ncr' THEN SELECT organisation_id INTO v_org FROM public.nonconformances WHERE id = p_record;
  ELSIF p_kind = 'capa' THEN SELECT organisation_id INTO v_org FROM public.capas WHERE id = p_record;
  ELSIF p_kind = 'document' THEN SELECT organisation_id INTO v_org FROM public.documents WHERE id = p_record;
  ELSIF p_kind = 'quality_alert' THEN SELECT organisation_id INTO v_org FROM public.quality_alerts WHERE id = p_record;
  ELSE RAISE EXCEPTION 'That kind of record cannot be shared' USING ERRCODE = 'QM032'; END IF;
  IF v_org IS NULL OR NOT app.has_permission(v_org, 'external_access.share') THEN RAISE EXCEPTION 'record not found' USING ERRCODE = 'no_data_found'; END IF;
  RETURN QUERY
  SELECT x.id, p.id, p.party_kind, coalesce(sup.name, cus.name), x.shared_at, app.portal_person_name(x.shared_by), x.withdrawn_at, x.withdrawn_reason,
         (SELECT count(*)::int FROM public.portal_views v WHERE v.share_id = x.id),
         (SELECT min(v.first_viewed_at) FROM public.portal_views v WHERE v.share_id = x.id),
         (SELECT max(v.last_viewed_at) FROM public.portal_views v WHERE v.share_id = x.id),
         (SELECT count(*)::int FROM public.portal_comments c WHERE c.share_id = x.id AND c.withdrawn_at IS NULL),
         (SELECT count(*)::int FROM public.portal_comments c WHERE c.share_id = x.id AND c.withdrawn_at IS NULL AND c.author_side = 'external')
    FROM public.portal_shares x
    JOIN public.portal_parties p ON p.id = x.party_id AND p.organisation_id = x.organisation_id
    LEFT JOIN public.suppliers sup ON sup.id = p.supplier_id
    LEFT JOIN public.customers cus ON cus.id = p.customer_id
   WHERE x.organisation_id = v_org AND ((p_kind = 'ncr' AND x.nonconformance_id = p_record) OR (p_kind = 'capa' AND x.capa_id = p_record)
                                     OR (p_kind = 'document' AND x.document_id = p_record) OR (p_kind = 'quality_alert' AND x.quality_alert_id = p_record))
   ORDER BY x.withdrawn_at IS NOT NULL, x.shared_at DESC;
END $$;

-- What the party has acknowledged: for each live share of a document or alert, how many of their active people have acknowledged the revision in force.
CREATE FUNCTION app.portal_ack_summary(p_kind text, p_record uuid) RETURNS TABLE (share_id uuid, acknowledged integer, people integer, subject_label text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid;
BEGIN
  IF p_kind = 'document' THEN SELECT organisation_id INTO v_org FROM public.documents WHERE id = p_record;
  ELSIF p_kind = 'quality_alert' THEN SELECT organisation_id INTO v_org FROM public.quality_alerts WHERE id = p_record;
  ELSE RAISE EXCEPTION 'That kind of record is not acknowledged' USING ERRCODE = 'QM032'; END IF;
  IF v_org IS NULL OR NOT app.has_permission(v_org, 'external_access.share') THEN RAISE EXCEPTION 'record not found' USING ERRCODE = 'no_data_found'; END IF;
  RETURN QUERY
  SELECT x.id,
         (SELECT count(DISTINCT k.acknowledged_by)::int FROM public.portal_acknowledgements k
           WHERE k.share_id = x.id AND k.subject_id = coalesce(d.current_revision_id, x.quality_alert_id)),
         (SELECT count(*)::int FROM public.external_access e WHERE e.party_id = x.party_id AND e.status = 'active'),
         CASE WHEN d.id IS NOT NULL THEN d.number || ' rev ' || coalesce(r.letter, '?') ELSE a.reference END
    FROM public.portal_shares x
    LEFT JOIN public.documents d ON d.id = x.document_id
    LEFT JOIN public.document_revisions r ON r.id = d.current_revision_id
    LEFT JOIN public.quality_alerts a ON a.id = x.quality_alert_id
   WHERE x.organisation_id = v_org AND x.withdrawn_at IS NULL
     AND ((p_kind = 'document' AND x.document_id = p_record) OR (p_kind = 'quality_alert' AND x.quality_alert_id = p_record));
END $$;
REVOKE ALL ON FUNCTION app.portal_ack_summary(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_ack_summary(text, uuid) TO authenticated;

-- Who acknowledged, for staff.
CREATE FUNCTION app.portal_share_acknowledgements(p_share uuid) RETURNS TABLE (person_name text, subject_label text, note text, acknowledged_at timestamptz, current boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.portal_shares;
BEGIN
  SELECT * INTO s FROM public.portal_shares WHERE id = p_share;
  IF NOT FOUND OR NOT app.has_permission(s.organisation_id, 'external_access.share') THEN RAISE EXCEPTION 'share not found' USING ERRCODE = 'no_data_found'; END IF;
  RETURN QUERY
  SELECT app.portal_person_name(k.acknowledged_by), k.subject_label, k.note, k.acknowledged_at,
         k.subject_id = coalesce((SELECT d.current_revision_id FROM public.documents d WHERE d.id = s.document_id), s.quality_alert_id)
    FROM public.portal_acknowledgements k WHERE k.share_id = p_share ORDER BY k.acknowledged_at DESC;
END $$;
REVOKE ALL ON FUNCTION app.portal_share_acknowledgements(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_share_acknowledgements(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- The party's list, conversation label and what still needs them
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.portal_list_shares(p_organisation_id uuid)
RETURNS TABLE (share_id uuid, kind text, reference text, title text, status text, shared_at timestamptz, comments integer, new_comments integer, viewed boolean, last_comment_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT x.id, x.record_kind, coalesce(n.reference, c.reference, d.number, qa.reference), coalesce(n.title, c.title, d.title, qa.title),
         coalesce(n.stage, c.stage, d.status, qa.status), x.shared_at,
         (SELECT count(*)::int FROM public.portal_comments m WHERE m.share_id = x.id AND m.withdrawn_at IS NULL),
         (SELECT count(*)::int FROM public.portal_comments m WHERE m.share_id = x.id AND m.withdrawn_at IS NULL AND m.author_side = 'staff'
             AND m.created_at > coalesce(v.last_viewed_at, '-infinity'::timestamptz)),
         v.share_id IS NOT NULL,
         (SELECT max(m.created_at) FROM public.portal_comments m WHERE m.share_id = x.id AND m.withdrawn_at IS NULL)
    FROM public.portal_shares x
    JOIN app.portal_my_access(p_organisation_id) a ON a.party_id = x.party_id
    LEFT JOIN public.nonconformances n ON n.id = x.nonconformance_id AND n.deleted_at IS NULL
    LEFT JOIN public.capas c ON c.id = x.capa_id
    LEFT JOIN public.documents d ON d.id = x.document_id AND d.status = 'active'
    LEFT JOIN public.quality_alerts qa ON qa.id = x.quality_alert_id AND qa.deleted_at IS NULL
    LEFT JOIN public.portal_views v ON v.share_id = x.id AND v.user_id = auth.uid()
   WHERE x.organisation_id = p_organisation_id AND x.withdrawn_at IS NULL AND (n.id IS NOT NULL OR c.id IS NOT NULL OR d.id IS NOT NULL OR qa.id IS NOT NULL)
   ORDER BY coalesce((SELECT max(m.created_at) FROM public.portal_comments m WHERE m.share_id = x.id AND m.withdrawn_at IS NULL), x.shared_at) DESC
$$;

-- Documents and alerts the caller still has to acknowledge (the revision in force of a document, an alert that is in force).
CREATE FUNCTION app.portal_pending_acknowledgements(p_organisation_id uuid) RETURNS TABLE (share_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT x.id
    FROM public.portal_shares x
    JOIN app.portal_my_access(p_organisation_id) a ON a.party_id = x.party_id
    LEFT JOIN public.documents d ON d.id = x.document_id AND d.status = 'active' AND d.current_revision_id IS NOT NULL
    LEFT JOIN public.quality_alerts qa ON qa.id = x.quality_alert_id AND qa.deleted_at IS NULL AND qa.status = 'active'
   WHERE x.organisation_id = p_organisation_id AND x.withdrawn_at IS NULL AND (d.id IS NOT NULL OR qa.id IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM public.portal_acknowledgements k WHERE k.share_id = x.id AND k.acknowledged_by = auth.uid()
                      AND k.subject_id = coalesce(d.current_revision_id, qa.id))
$$;
REVOKE ALL ON FUNCTION app.portal_pending_acknowledgements(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_pending_acknowledgements(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION app.add_portal_comment(p_share uuid, p_body text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.portal_shares; v_id uuid; v_side text; v_label text;
BEGIN
  SELECT * INTO s FROM public.portal_shares WHERE id = p_share;
  IF NOT FOUND THEN RAISE EXCEPTION 'share not found' USING ERRCODE = 'no_data_found'; END IF;
  IF app.has_permission(s.organisation_id, 'external_access.share') THEN v_side := 'staff';
  ELSIF EXISTS (SELECT 1 FROM app.portal_my_access(s.organisation_id) a WHERE a.party_id = s.party_id) THEN v_side := 'external';
  ELSE RAISE EXCEPTION 'share not found' USING ERRCODE = 'no_data_found'; END IF;
  IF s.withdrawn_at IS NOT NULL THEN
    IF v_side = 'external' THEN RAISE EXCEPTION 'share not found' USING ERRCODE = 'no_data_found'; END IF;
    RAISE EXCEPTION 'This record is no longer shared, so it cannot be commented on' USING ERRCODE = 'QM032';
  END IF;
  IF length(btrim(coalesce(p_body, ''))) < 1 OR length(btrim(p_body)) > 4000 THEN RAISE EXCEPTION 'A comment is 1 to 4,000 characters' USING ERRCODE = 'QM032'; END IF;
  INSERT INTO public.portal_comments (organisation_id, share_id, author_side, body) VALUES (s.organisation_id, p_share, v_side, btrim(p_body)) RETURNING id INTO v_id;
  IF v_side = 'external' THEN
    SELECT coalesce(n.reference, c.reference, d.number, qa.reference) || ' · ' || coalesce(n.title, c.title, d.title, qa.title) INTO v_label
      FROM (SELECT 1) one
      LEFT JOIN public.nonconformances n ON n.id = s.nonconformance_id LEFT JOIN public.capas c ON c.id = s.capa_id
      LEFT JOIN public.documents d ON d.id = s.document_id LEFT JOIN public.quality_alerts qa ON qa.id = s.quality_alert_id;
    PERFORM app.portal_note_activity(s.organisation_id, s.party_id, 'comment', s.record_kind::text, coalesce(s.nonconformance_id, s.capa_id, s.document_id, s.quality_alert_id), v_label,
                                     'Commented: ' || left(btrim(p_body), 120));
  END IF;
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------
-- The two external views, the acknowledgement, and a document's files
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.portal_get_document(p_share uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.portal_shares; d public.documents; r public.document_revisions; v_contact text; v_type text; v_ack timestamptz;
BEGIN
  s := app.portal_share_for_external(p_share);
  IF s.record_kind <> 'document' THEN RAISE EXCEPTION 'share not found' USING ERRCODE = 'no_data_found'; END IF;
  SELECT * INTO d FROM public.documents WHERE id = s.document_id AND status = 'active' AND current_revision_id IS NOT NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'share not found' USING ERRCODE = 'no_data_found'; END IF;
  SELECT * INTO r FROM public.document_revisions WHERE id = d.current_revision_id;
  SELECT t.name INTO v_type FROM public.document_types t WHERE t.id = d.type_id;
  SELECT coalesce(p.contact_name, o.name) INTO v_contact FROM public.portal_parties p JOIN public.organisations o ON o.id = p.organisation_id WHERE p.id = s.party_id;
  SELECT k.acknowledged_at INTO v_ack FROM public.portal_acknowledgements k WHERE k.share_id = s.id AND k.acknowledged_by = auth.uid() AND k.subject_id = r.id;
  RETURN jsonb_build_object(
    'number', d.number,
    'title', d.title,
    'description', d.description,
    'type', v_type,
    'contentKind', d.content_kind,
    'revision', r.letter,
    'effectiveFrom', r.effective_from,
    'changeSummary', r.change_summary,
    'body', CASE WHEN d.content_kind = 'text' THEN r.body END,
    'files', coalesce((SELECT jsonb_agg(jsonb_build_object('id', f.id, 'fileName', f.file_name, 'sizeBytes', f.size_bytes, 'role', f.role) ORDER BY f.role, f.created_at)
                         FROM public.document_revision_files f WHERE f.revision_id = r.id AND f.deleted_at IS NULL), '[]'::jsonb),
    'acknowledgedAt', v_ack,
    'canAcknowledge', v_ack IS NULL,
    'sharedAt', s.shared_at,
    'contact', v_contact
  );
END $$;
REVOKE ALL ON FUNCTION app.portal_get_document(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_get_document(uuid) TO authenticated;

CREATE FUNCTION app.portal_get_quality_alert(p_share uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.portal_shares; a public.quality_alerts; v_contact text; v_ack timestamptz;
BEGIN
  s := app.portal_share_for_external(p_share);
  IF s.record_kind <> 'quality_alert' THEN RAISE EXCEPTION 'share not found' USING ERRCODE = 'no_data_found'; END IF;
  SELECT * INTO a FROM public.quality_alerts WHERE id = s.quality_alert_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'share not found' USING ERRCODE = 'no_data_found'; END IF;
  SELECT coalesce(p.contact_name, o.name) INTO v_contact FROM public.portal_parties p JOIN public.organisations o ON o.id = p.organisation_id WHERE p.id = s.party_id;
  SELECT k.acknowledged_at INTO v_ack FROM public.portal_acknowledgements k WHERE k.share_id = s.id AND k.acknowledged_by = auth.uid() AND k.subject_id = a.id;
  RETURN jsonb_build_object(
    'reference', a.reference,
    'revision', a.revision,
    'title', a.title,
    'category', a.category,
    'severity', a.severity,
    'status', a.status,
    'description', a.description,
    'actions', coalesce((SELECT jsonb_agg(jsonb_build_object('position', x.position, 'description', x.description) ORDER BY x.position)
                           FROM public.quality_alert_actions x WHERE x.alert_id = a.id), '[]'::jsonb),
    'effectiveDate', a.effective_date,
    'expiryDate', a.expiry_date,
    'acknowledgeBy', a.acknowledge_by,
    'acknowledgedAt', v_ack,
    'canAcknowledge', v_ack IS NULL AND a.status = 'active',
    'sharedAt', s.shared_at,
    'contact', v_contact
  );
END $$;
REVOKE ALL ON FUNCTION app.portal_get_quality_alert(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_get_quality_alert(uuid) TO authenticated;

-- Acknowledge what is in force: a document's current revision, or an alert that is active. Once per person and thing; staff are told.
CREATE FUNCTION app.portal_acknowledge_share(p_share uuid, p_note text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.portal_shares; d public.documents; a public.quality_alerts; r public.document_revisions; v_subject uuid; v_label text; v_id uuid;
BEGIN
  s := app.portal_share_for_external(p_share);
  IF p_note IS NOT NULL AND length(btrim(p_note)) > 1000 THEN RAISE EXCEPTION 'A note is up to 1,000 characters' USING ERRCODE = 'QM032'; END IF;
  IF s.record_kind = 'document' THEN
    SELECT * INTO d FROM public.documents WHERE id = s.document_id AND status = 'active' AND current_revision_id IS NOT NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'share not found' USING ERRCODE = 'no_data_found'; END IF;
    SELECT * INTO r FROM public.document_revisions WHERE id = d.current_revision_id;
    v_subject := r.id; v_label := d.number || ' rev ' || coalesce(r.letter, '?') || ' · ' || d.title;
  ELSIF s.record_kind = 'quality_alert' THEN
    SELECT * INTO a FROM public.quality_alerts WHERE id = s.quality_alert_id AND deleted_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'share not found' USING ERRCODE = 'no_data_found'; END IF;
    IF a.status <> 'active' THEN RAISE EXCEPTION 'This quality alert is no longer in force, so it cannot be acknowledged' USING ERRCODE = 'QM032'; END IF;
    v_subject := a.id; v_label := a.reference || ' · ' || a.title;
  ELSE
    RAISE EXCEPTION 'That is not something to acknowledge' USING ERRCODE = 'QM032';
  END IF;
  IF EXISTS (SELECT 1 FROM public.portal_acknowledgements k WHERE k.share_id = s.id AND k.acknowledged_by = auth.uid() AND k.subject_id = v_subject) THEN
    RAISE EXCEPTION 'You have already acknowledged this' USING ERRCODE = 'QM032';
  END IF;
  INSERT INTO public.portal_acknowledgements (organisation_id, share_id, subject_id, subject_label, note)
  VALUES (s.organisation_id, s.id, v_subject, v_label, nullif(btrim(coalesce(p_note, '')), '')) RETURNING id INTO v_id;
  PERFORM app.portal_note_activity(s.organisation_id, s.party_id, 'acknowledged', s.record_kind, coalesce(s.document_id, s.quality_alert_id), v_label, 'Acknowledged it');
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION app.portal_acknowledge_share(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_acknowledge_share(uuid, text) TO authenticated;

-- A file of the document revision in force that the caller's party was shared (to sign a short link).
CREATE FUNCTION app.portal_document_file_path(p_share uuid, p_file uuid) RETURNS TABLE (storage_path text, file_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.portal_shares;
BEGIN
  s := app.portal_share_for_external(p_share);
  IF s.record_kind <> 'document' THEN RAISE EXCEPTION 'file not found' USING ERRCODE = 'no_data_found'; END IF;
  RETURN QUERY
  SELECT f.storage_path, f.file_name
    FROM public.document_revision_files f
    JOIN public.documents d ON d.id = s.document_id AND d.status = 'active' AND d.current_revision_id = f.revision_id
   WHERE f.id = p_file AND f.deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'file not found' USING ERRCODE = 'no_data_found'; END IF;
END $$;
REVOKE ALL ON FUNCTION app.portal_document_file_path(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_document_file_path(uuid, uuid) TO authenticated;
