-- ON6a (docs/onboarding-plan.md §16): the go-live checklist, computed from what actually exists in the organisation. Counts in the caller's own organisation only.
--
-- Required (the dashboard card stays until all are done): a valid subscription, a site, a department, someone else invited.
-- Recommended (shown, never keep the card alive): organisation details, a logo, a security decision, someone else has joined, and (optional) a first non-conformance.

CREATE FUNCTION app.go_live_checklist(p_organisation_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_items jsonb; v_required_done boolean;
  v_sub boolean; v_sites integer; v_departments integer; v_invited integer; v_joined integer; v_details boolean; v_logo boolean; v_security boolean; v_ncr integer;
BEGIN
  IF NOT app.has_permission(p_organisation_id, 'organisation.manage') THEN
    RAISE EXCEPTION 'You are not allowed to see this organisation''s set-up' USING ERRCODE = '42501';
  END IF;
  v_sub := app.organisation_subscription_valid(p_organisation_id);
  SELECT count(*) INTO v_sites FROM public.sites s WHERE s.organisation_id = p_organisation_id AND s.active;
  SELECT count(*) INTO v_departments FROM public.departments d WHERE d.organisation_id = p_organisation_id AND d.active;
  SELECT count(*) INTO v_invited FROM public.organisation_users m WHERE m.organisation_id = p_organisation_id AND m.status IN ('invited', 'active');
  SELECT count(*) INTO v_joined FROM public.organisation_users m WHERE m.organisation_id = p_organisation_id AND m.status = 'active';
  SELECT (o.legal_name IS NOT NULL AND o.country IS NOT NULL) INTO v_details FROM public.organisations o WHERE o.id = p_organisation_id;
  SELECT (st.logo_path IS NOT NULL) INTO v_logo FROM public.organisation_settings st WHERE st.organisation_id = p_organisation_id;
  SELECT (coalesce(st.require_mfa, false) OR coalesce((SELECT w.steps ->> 'security' IN ('done', 'skipped') FROM public.organisation_onboarding w WHERE w.organisation_id = p_organisation_id), false))
    INTO v_security FROM public.organisation_settings st WHERE st.organisation_id = p_organisation_id;
  SELECT count(*) INTO v_ncr FROM public.nonconformances n WHERE n.organisation_id = p_organisation_id;

  v_items := jsonb_build_array(
    jsonb_build_object('key', 'subscription', 'required', true,  'done', coalesce(v_sub, false)),
    jsonb_build_object('key', 'site',         'required', true,  'done', v_sites >= 1),
    jsonb_build_object('key', 'departments',  'required', true,  'done', v_departments >= 1),
    jsonb_build_object('key', 'invited',      'required', true,  'done', v_invited >= 2),
    jsonb_build_object('key', 'details',      'required', false, 'done', coalesce(v_details, false)),
    jsonb_build_object('key', 'logo',         'required', false, 'done', coalesce(v_logo, false)),
    jsonb_build_object('key', 'security',     'required', false, 'done', coalesce(v_security, false)),
    jsonb_build_object('key', 'joined',       'required', false, 'done', v_joined >= 2),
    jsonb_build_object('key', 'first_ncr',    'required', false, 'done', v_ncr >= 1));
  SELECT coalesce(bool_and((i ->> 'done')::boolean), true) INTO v_required_done FROM jsonb_array_elements(v_items) i WHERE (i ->> 'required')::boolean;
  RETURN jsonb_build_object('items', v_items, 'requiredDone', v_required_done);
END $$;

REVOKE ALL ON FUNCTION app.go_live_checklist(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.go_live_checklist(uuid) TO authenticated;
