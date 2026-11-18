-- External portal PT6 (docs/external-portal-plan.md §6): the portal's non-conformance and 8D registers.
--
-- Two list functions that give the party's people one row per record SHARED with their party, with the same named fields the shared record shows
-- (nothing more): they let the portal draw a register with sorting, filtering and chosen columns. Sharing stays the gate (decision X2): an NC or 8D that
-- staff have not shared, or have stopped sharing, is not in the list, and a draft or cancelled NC and a deleted one never are.
--  * app.portal_list_ncrs(org): reference, title, stage, severity, detected date, part, lot, quantity affected, their reference / purchase order, when shared,
--    the conversation (comments, new ones since they last looked), whether they have opened it, and whether we are waiting for them to confirm closure.
--  * app.portal_list_capas(org): reference, title, severity, stage, started and closed dates, when shared, the conversation, opened, and closure waiting.
-- No costs, owners, internal sources or notes, no people of ours.

CREATE FUNCTION app.portal_list_ncrs(p_organisation_id uuid)
RETURNS TABLE (share_id uuid, reference text, title text, stage text, severity text, detected_at date, part_number text, part_name text, lot_number text,
               quantity_affected numeric, customer_reference text, purchase_order text, shared_at timestamptz, comments integer, new_comments integer,
               viewed boolean, last_comment_at timestamptz, closure_pending boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT x.id, n.reference, n.title, n.stage, n.severity, n.detected_at, pt.part_number, pt.name, n.lot_number, n.quantity_affected, n.customer_reference, n.purchase_order, x.shared_at,
         (SELECT count(*)::int FROM public.portal_comments m WHERE m.share_id = x.id AND m.withdrawn_at IS NULL),
         (SELECT count(*)::int FROM public.portal_comments m WHERE m.share_id = x.id AND m.withdrawn_at IS NULL AND m.author_side = 'staff'
             AND m.created_at > coalesce(v.last_viewed_at, '-infinity'::timestamptz)),
         v.share_id IS NOT NULL,
         (SELECT max(m.created_at) FROM public.portal_comments m WHERE m.share_id = x.id AND m.withdrawn_at IS NULL),
         x.id IN (SELECT c.share_id FROM app.portal_pending_closures(p_organisation_id) c)
    FROM public.portal_shares x
    JOIN app.portal_my_access(p_organisation_id) a ON a.party_id = x.party_id
    JOIN public.nonconformances n ON n.id = x.nonconformance_id AND n.organisation_id = x.organisation_id AND n.deleted_at IS NULL
    LEFT JOIN public.parts pt ON pt.id = n.part_id AND pt.organisation_id = n.organisation_id
    LEFT JOIN public.portal_views v ON v.share_id = x.id AND v.user_id = auth.uid()
   WHERE x.organisation_id = p_organisation_id AND x.record_kind = 'ncr' AND x.withdrawn_at IS NULL
   ORDER BY n.detected_at DESC NULLS LAST, n.reference DESC
$$;
REVOKE ALL ON FUNCTION app.portal_list_ncrs(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_list_ncrs(uuid) TO authenticated;

CREATE FUNCTION app.portal_list_capas(p_organisation_id uuid)
RETURNS TABLE (share_id uuid, reference text, title text, severity text, stage text, started_at timestamptz, closed_at timestamptz, shared_at timestamptz,
               comments integer, new_comments integer, viewed boolean, last_comment_at timestamptz, closure_pending boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT x.id, c.reference, c.title, c.severity, c.stage, c.created_at, c.closed_at, x.shared_at,
         (SELECT count(*)::int FROM public.portal_comments m WHERE m.share_id = x.id AND m.withdrawn_at IS NULL),
         (SELECT count(*)::int FROM public.portal_comments m WHERE m.share_id = x.id AND m.withdrawn_at IS NULL AND m.author_side = 'staff'
             AND m.created_at > coalesce(v.last_viewed_at, '-infinity'::timestamptz)),
         v.share_id IS NOT NULL,
         (SELECT max(m.created_at) FROM public.portal_comments m WHERE m.share_id = x.id AND m.withdrawn_at IS NULL),
         x.id IN (SELECT p.share_id FROM app.portal_pending_closures(p_organisation_id) p)
    FROM public.portal_shares x
    JOIN app.portal_my_access(p_organisation_id) a ON a.party_id = x.party_id
    JOIN public.capas c ON c.id = x.capa_id AND c.organisation_id = x.organisation_id
    LEFT JOIN public.portal_views v ON v.share_id = x.id AND v.user_id = auth.uid()
   WHERE x.organisation_id = p_organisation_id AND x.record_kind = 'capa' AND x.withdrawn_at IS NULL
   ORDER BY c.created_at DESC, c.reference DESC
$$;
REVOKE ALL ON FUNCTION app.portal_list_capas(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_list_capas(uuid) TO authenticated;
