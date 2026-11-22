-- External portal PT5d (docs/external-portal-plan.md §6 "Performance (customer)"): a customer's own quality figures — the non-conformances raised against what we
-- supply them and the 8Ds that answer them — as named counts only.
--
--  * Scope: non-conformances that name THIS customer (customer_id, live, past draft) and the live 8Ds linked to them. No other customer, no internal NCs
--    that merely concern a part they buy, no costs, owners or notes, no record references (counts and averages only).
--  * PPM and first-pass yield are NOT here: there is no shipment data to divide by (decision X10 defers delivery performance), and inspection yield
--    would describe our own process rather than their parts. Nothing is invented to fill the gap.
--  * Staff switch the tile off per customer with portal_parties.tiles "figures" = false (on by default).
--  * The caller's own live portal access to a CUSTOMER party decides everything (app.portal_customer_party); the party is never taken from the request.

CREATE FUNCTION app.portal_get_customer_figures(p_org uuid, p_party uuid, p_days integer DEFAULT 90) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_customer uuid := app.portal_customer_party(p_org, p_party); v_tiles jsonb; v_from date; v_to date := current_date; v_nc jsonb; v_capa jsonb;
BEGIN
  IF p_days IS NULL OR p_days NOT IN (30, 90, 365) THEN RAISE EXCEPTION 'Choose 30, 90 or 365 days' USING ERRCODE = 'QM032'; END IF;
  v_from := v_to - (p_days - 1);
  SELECT coalesce(tiles, '{}'::jsonb) INTO v_tiles FROM public.portal_parties WHERE id = p_party;
  IF (v_tiles ->> 'figures') = 'false' THEN RETURN jsonb_build_object('period', jsonb_build_object('from', v_from, 'to', v_to, 'days', p_days), 'available', false); END IF;

  SELECT jsonb_build_object(
      'raised', count(*) FILTER (WHERE n.detected_at BETWEEN v_from AND v_to),
      'critical', count(*) FILTER (WHERE n.detected_at BETWEEN v_from AND v_to AND n.severity = 'critical'),
      'major', count(*) FILTER (WHERE n.detected_at BETWEEN v_from AND v_to AND n.severity = 'major'),
      'minor', count(*) FILTER (WHERE n.detected_at BETWEEN v_from AND v_to AND n.severity = 'minor'),
      'open', count(*) FILTER (WHERE n.stage NOT IN ('closed')),
      'oldestOpenDays', max(v_to - n.detected_at) FILTER (WHERE n.stage NOT IN ('closed')),
      'averageOpenDays', round(avg(v_to - n.detected_at) FILTER (WHERE n.stage NOT IN ('closed')), 1),
      'closedInPeriod', count(*) FILTER (WHERE n.stage = 'closed' AND n.closed_at::date BETWEEN v_from AND v_to),
      'averageDaysToClose', round(avg(n.closed_at::date - n.detected_at) FILTER (WHERE n.stage = 'closed' AND n.closed_at::date BETWEEN v_from AND v_to), 1))
    INTO v_nc
    FROM public.nonconformances n
   WHERE n.organisation_id = p_org AND n.customer_id = v_customer AND n.deleted_at IS NULL AND n.stage NOT IN ('draft', 'cancelled');

  SELECT jsonb_build_object(
      'started', count(*) FILTER (WHERE c.created_at::date BETWEEN v_from AND v_to),
      'inProgress', count(*) FILTER (WHERE c.stage NOT IN ('closed')),
      'closedInPeriod', count(*) FILTER (WHERE c.stage = 'closed' AND c.closed_at::date BETWEEN v_from AND v_to),
      'averageDaysToClose', round(avg(c.closed_at::date - c.created_at::date) FILTER (WHERE c.stage = 'closed' AND c.closed_at::date BETWEEN v_from AND v_to), 1))
    INTO v_capa
    FROM public.capas c
   WHERE c.organisation_id = p_org AND c.stage <> 'cancelled'
     AND EXISTS (SELECT 1 FROM public.capa_ncr_links l JOIN public.nonconformances n ON n.id = l.nonconformance_id AND n.organisation_id = l.organisation_id
                  WHERE l.capa_id = c.id AND l.ended_at IS NULL AND n.customer_id = v_customer AND n.deleted_at IS NULL AND n.stage NOT IN ('draft', 'cancelled'));

  RETURN jsonb_build_object('period', jsonb_build_object('from', v_from, 'to', v_to, 'days', p_days), 'available', true, 'ncs', v_nc, 'capas', v_capa);
END $$;
REVOKE ALL ON FUNCTION app.portal_get_customer_figures(uuid, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.portal_get_customer_figures(uuid, uuid, integer) TO authenticated;
