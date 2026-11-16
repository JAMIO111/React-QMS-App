-- Single sign-on SS4 (docs/sso-plan.md, decisions SS4 and SS5): joining on the first company sign-in, and moving a password member onto their
-- company account.
--
-- 1. Joining (SS4 b): organisation_settings.sso_join = 'domain' lets someone who signs in through the organisation's own provider, at one of its
--    verified domains, join with a default role (viewer or inspector only; never owner or admin), an optional default department and no seat.
--    app.set_sso_joining (security.manage); app.sso_joinable_organisations() and app.join_by_company_sign_in(org) for the person signing in.
--    Owners and admins are told (sso_changes kind member_joined). An invitation waiting for the person is accepted the usual way instead.
-- 2. Moving (SS5): Supabase makes a separate user for a company sign-in, never linked to the password account with the same address.
--    app.move_member_to_sso_account(org, old, new) (members.manage on the old membership) and app.system_move_own_account(org, old, new) (the
--    API login, after the person proved the old password) re-point the old membership to the company account, so its roles, departments, seat,
--    and 8D team places (all hang off the membership) move with it; the company account's own membership, if it joined or accepted an
--    invitation already, is marked removed. Then the open work and standing responsibilities named by user id move (app.user_reference_columns()
--    = every column that names a user, classified); finished records keep the old id as history. Each kind of record is moved in its own
--    sub-transaction: what a record's own rules refuse is left and reported, never half-done. sso_account_moves keeps what was moved (frozen).
--    The old account has no membership left in the organisation.
-- 3. Matches: app.sso_member_matches(org) = password members whose address is also a company account at a verified domain; "not the same person"
--    is kept in sso_match_dismissals.
-- Errors QM030 → 409 sso_rule.

ALTER TABLE public.sso_changes DROP CONSTRAINT sso_changes_kind_check;
ALTER TABLE public.sso_changes ADD CONSTRAINT sso_changes_kind_check
  CHECK (kind IN ('mode', 'two_factor', 'break_glass_list', 'break_glass_used', 'recovery', 'joining', 'member_joined', 'account_moved'));

-- ---------------------------------------------------------------------------
-- 1. Joining on the first company sign-in
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.set_sso_joining(p_organisation_id uuid, p_join text, p_role_id uuid, p_department_id uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.organisation_settings; v_role_key text; v_role_name text; v_name text := app.sso_person_name(auth.uid());
BEGIN
  PERFORM app.assert_security_manager(p_organisation_id);
  IF p_join IS NULL OR p_join NOT IN ('invited', 'domain') THEN RAISE EXCEPTION 'Choose invited only or anyone at your domains' USING ERRCODE = 'QM030'; END IF;
  SELECT * INTO s FROM public.organisation_settings WHERE organisation_id = p_organisation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
  IF p_join = 'domain' THEN
    SELECT r.key, r.name INTO v_role_key, v_role_name FROM public.roles r WHERE r.id = p_role_id AND r.organisation_id = p_organisation_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Choose the role people join with' USING ERRCODE = 'QM030'; END IF;
    IF v_role_key NOT IN ('viewer', 'inspector') THEN
      RAISE EXCEPTION 'People who join on their own can only start as a viewer or an inspector' USING ERRCODE = 'QM030';
    END IF;
    IF p_department_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.departments d WHERE d.id = p_department_id AND d.organisation_id = p_organisation_id AND d.active) THEN
      RAISE EXCEPTION 'Choose an active department of this organisation' USING ERRCODE = 'QM030';
    END IF;
  ELSE
    p_role_id := NULL; p_department_id := NULL;
  END IF;
  IF s.sso_join = p_join AND s.sso_default_role_id IS NOT DISTINCT FROM p_role_id AND s.sso_default_department_id IS NOT DISTINCT FROM p_department_id THEN
    RETURN p_join;
  END IF;
  UPDATE public.organisation_settings SET sso_join = p_join, sso_default_role_id = p_role_id, sso_default_department_id = p_department_id
   WHERE organisation_id = p_organisation_id;
  INSERT INTO public.sso_changes (organisation_id, kind, from_value, to_value, user_id, user_name, summary, guidance)
  VALUES (p_organisation_id, 'joining', s.sso_join, p_join, auth.uid(), v_name,
          CASE WHEN p_join = 'domain'
               THEN 'Anyone who signs in with their company account at your verified domains can now join as ' || coalesce(v_role_name, 'a viewer')
               ELSE 'Only people who are invited can join now' END || coalesce(' — changed by ' || v_name, ''),
          CASE WHEN p_join = 'domain'
               THEN 'New people get no seat until someone gives them one. Owners and admins are told of each one who joins.'
               ELSE 'People at your domains still sign in with their company account once they are invited.' END);
  RETURN p_join;
END $$;

-- The organisations this session may join by itself: its company sign-in came through the organisation's own provider, the address is at one of
-- its verified domains, the organisation lets people join, and there is no membership or waiting invitation already.
CREATE FUNCTION app.sso_joinable_organisations()
RETURNS TABLE (organisation_id uuid, name text, role_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT o.id, o.name, r.name
    FROM public.organisation_settings s
    JOIN public.organisations o ON o.id = s.organisation_id AND o.status = 'active'
    JOIN public.roles r ON r.id = s.sso_default_role_id
    JOIN auth.users u ON u.id = auth.uid()
   WHERE s.sso_join = 'domain' AND s.sso_mode <> 'off'
     AND coalesce(u.is_sso_user, false)
     AND app.sso_session_for(s.organisation_id)
     AND app.sso_email_covered(s.organisation_id, u.email::text)
     AND NOT EXISTS (SELECT 1 FROM public.organisation_users m
                      WHERE m.organisation_id = s.organisation_id AND m.status <> 'removed'
                        AND (m.user_id = auth.uid() OR (m.status = 'invited' AND lower(m.invited_email) = lower(u.email::text))))
$$;

CREATE FUNCTION app.join_by_company_sign_in(p_organisation_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.organisation_settings; v_membership uuid; v_name text; v_role text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in first' USING ERRCODE = '42501'; END IF;
  PERFORM 1 FROM public.organisation_settings WHERE organisation_id = p_organisation_id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM app.sso_joinable_organisations() j WHERE j.organisation_id = p_organisation_id) THEN
    RAISE EXCEPTION 'You cannot join this organisation with your company account. Ask an administrator to invite you.' USING ERRCODE = 'QM030';
  END IF;
  SELECT * INTO s FROM public.organisation_settings WHERE organisation_id = p_organisation_id;
  INSERT INTO public.organisation_users (organisation_id, user_id, status, joined_at)
  VALUES (p_organisation_id, auth.uid(), 'active', now()) RETURNING id INTO v_membership;
  INSERT INTO public.user_role_assignments (organisation_id, membership_id, role_id) VALUES (p_organisation_id, v_membership, s.sso_default_role_id);
  IF s.sso_default_department_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.departments d WHERE d.id = s.sso_default_department_id AND d.active) THEN
    INSERT INTO public.department_members (organisation_id, department_id, membership_id, is_primary)
    VALUES (p_organisation_id, s.sso_default_department_id, v_membership, true);
  END IF;
  v_name := app.sso_person_name(auth.uid());
  SELECT r.name INTO v_role FROM public.roles r WHERE r.id = s.sso_default_role_id;
  INSERT INTO public.sso_changes (organisation_id, kind, to_value, user_id, user_name, summary, guidance)
  VALUES (p_organisation_id, 'member_joined', v_role, auth.uid(), v_name,
          coalesce(v_name, 'Someone') || ' joined with their company account as ' || coalesce(v_role, 'a member'),
          'They have no seat yet. Settings → Users & permissions shows them; give them a seat or other roles there, or suspend them if they should not be here.');
  RETURN v_membership;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Every column that names a user, classified (the drift check in supabase/tests/sso_joining_moves.test.sql fails on a new one)
-- ---------------------------------------------------------------------------
-- treatment: membership (re-pointed with the membership) · moved (open work or a standing responsibility in the organisation, moved) ·
-- history (a record of what someone did or was told, kept on the old account) · personal (the account itself, not per organisation).
-- A column whose name ends in _by records who did something and is history unless listed here as moved.
CREATE FUNCTION app.user_reference_columns()
RETURNS TABLE (table_name text, column_name text, treatment text, note text)
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  VALUES
    ('organisation_users', 'user_id', 'membership', 'Roles, departments, seat and 8D team places hang off the membership and move with it'),
    ('Employees', 'auth_id', 'moved', 'The employee record linked to the sign-in'),
    ('audit_definitions', 'auditor_user_id', 'moved', 'Expected auditor of audits in use'),
    ('control_plans', 'owner_id', 'moved', 'Owner of control plans in use'),
    ('document_recipients', 'user_id', 'moved', 'Documents in force still to read'),
    ('document_revision_reviewers', 'user_id', 'moved', 'Reviewer named on a revision not yet approved'),
    ('document_revisions', 'approver_id', 'moved', 'Approver named on a revision not yet approved'),
    ('document_signoffs', 'user_id', 'moved', 'Sign-offs still waiting'),
    ('documents', 'owner_user_id', 'moved', 'Owner of documents not withdrawn or discarded'),
    ('gauges', 'custodian_id', 'moved', 'Custodian of gauges in use'),
    ('management_review_actions', 'owner_user_id', 'moved', 'Open review actions'),
    ('management_review_attendees', 'user_id', 'moved', 'Attendee of reviews not yet held'),
    ('management_reviews', 'chair_user_id', 'moved', 'Chair of reviews not yet held'),
    ('nonconformances', 'owner_id', 'moved', 'Owner of open non-conformances'),
    ('notification_preferences', 'user_id', 'moved', 'Notification choices in this organisation'),
    ('quality_alert_recipients', 'user_id', 'moved', 'Quality alerts in force still to acknowledge'),
    ('quality_objectives', 'owner_user_id', 'moved', 'Owner of objectives in use'),
    ('reminder_preferences', 'user_id', 'moved', 'Reminder choices in this organisation'),
    ('risk_actions', 'owner_user_id', 'moved', 'Open risk actions'),
    ('risks', 'owner_user_id', 'moved', 'Owner of risks not closed or retired'),
    ('saved_filters', 'user_id', 'moved', 'Saved filters in this organisation'),
    ('supplier_scars', 'owner_user_id', 'moved', 'Owner of running SCARs'),
    ('workflow_tasks', 'assignee_user_id', 'moved', 'Open tasks'),
    ('integration_import_settings', 'schedule_set_by', 'moved', 'Whose authority a daily import runs with'),
    ('supplier_scorecard_schedules', 'set_by', 'moved', 'Whose authority scheduled scorecards are worked out with'),
    ('access_denials', 'user_id', 'history', 'Blocked attempts'),
    ('calibrations', 'technician_id', 'history', 'Who calibrated'),
    ('competence_assessments', 'assessor_user_id', 'history', 'Who assessed'),
    ('document_revisions', 'author_id', 'history', 'Who wrote a revision'),
    ('email_outbox', 'user_id', 'history', 'Emails sent'),
    ('integration_agent_events', 'actor_user_id', 'history', 'Who acted on an agent'),
    ('integration_connection_events', 'by', 'history', 'Who acted on a connection'),
    ('notification_reads', 'user_id', 'history', 'Notices read'),
    ('notifications', 'recipient_user_id', 'history', 'Notices addressed to them'),
    ('notifications', 'actor_user_id', 'history', 'Who caused a notice'),
    ('outbox_events', 'actor_user_id', 'history', 'Who caused an event'),
    ('idempotency_keys', 'user_id', 'history', 'Requests already handled'),
    ('quality_alert_events', 'actor_id', 'history', 'Who reopened an alert'),
    ('reminder_digests', 'user_id', 'history', 'Reminders sent'),
    ('reminder_overdue_notices', 'user_id', 'history', 'Overdue notices sent'),
    ('sso_break_glass_members', 'user_id', 'history', 'Break-glass is a password account; the company account cannot be one'),
    ('sso_changes', 'user_id', 'history', 'Single sign-on history'),
    ('sso_sign_ins', 'user_id', 'history', 'Sign-ins'),
    ('subscription_audit_logs', 'actor_user_id', 'history', 'Who changed the subscription'),
    ('workflow_notices', 'user_id', 'history', 'Notices sent'),
    ('sso_account_moves', 'from_user_id', 'history', 'Moves'),
    ('sso_account_moves', 'to_user_id', 'history', 'Moves'),
    ('sso_match_dismissals', 'password_user_id', 'history', 'Pairs that are not the same person'),
    ('sso_match_dismissals', 'sso_user_id', 'history', 'Pairs that are not the same person'),
    ('profiles', 'id', 'personal', 'The account''s own profile'),
    ('platform_admins', 'user_id', 'personal', 'Platform operators'),
    ('signup_events', 'user_id', 'personal', 'Sign-up funnel')
$$;

-- ---------------------------------------------------------------------------
-- 3. Moves and matches
-- ---------------------------------------------------------------------------
CREATE TABLE public.sso_account_moves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  membership_id uuid NOT NULL,
  from_user_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  to_user_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  email text NOT NULL,
  by_self boolean NOT NULL,
  created_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  moved jsonb NOT NULL DEFAULT '{}'::jsonb,     -- {"risks.owner_user_id": 3, …}
  skipped jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {"<column>": "<the rule that refused it>"}
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX sso_account_moves_org_idx ON public.sso_account_moves (organisation_id, created_at DESC);
ALTER TABLE public.sso_account_moves ENABLE ROW LEVEL SECURITY;
CREATE POLICY sso_account_moves_select ON public.sso_account_moves FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'members.read') OR from_user_id = (SELECT auth.uid()) OR to_user_id = (SELECT auth.uid()));
REVOKE ALL ON public.sso_account_moves FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.sso_account_moves TO authenticated;
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.sso_account_moves FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');
CREATE TRIGGER sso_account_moves_frozen BEFORE UPDATE OR DELETE ON public.sso_account_moves FOR EACH ROW EXECUTE FUNCTION app.sso_changes_frozen();

CREATE TABLE public.sso_match_dismissals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations (id) ON DELETE CASCADE,
  password_user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  sso_user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  created_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, password_user_id, sso_user_id)
);
ALTER TABLE public.sso_match_dismissals ENABLE ROW LEVEL SECURITY;
CREATE POLICY sso_match_dismissals_select ON public.sso_match_dismissals FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'members.read'));
REVOKE ALL ON public.sso_match_dismissals FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.sso_match_dismissals TO authenticated;
CREATE TRIGGER audit_changes AFTER INSERT OR UPDATE OR DELETE ON public.sso_match_dismissals FOR EACH ROW EXECUTE FUNCTION audit.record_change('organisation_id');

-- Password members whose address is also a company account at one of the organisation's verified domains (and not marked as someone else).
CREATE FUNCTION app.sso_member_matches(p_organisation_id uuid)
RETURNS TABLE (membership_id uuid, password_user_id uuid, name text, email text, member_status text, sso_user_id uuid, sso_created_at timestamptz,
               sso_last_sign_in_at timestamptz, sso_member boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT app.has_permission(p_organisation_id, 'members.manage') THEN RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501'; END IF;
  RETURN QUERY
  SELECT m.id, m.user_id, app.sso_person_name(m.user_id), pu.email::text, m.status, su.id, su.created_at, su.last_sign_in_at,
         EXISTS (SELECT 1 FROM public.organisation_users x WHERE x.organisation_id = p_organisation_id AND x.user_id = su.id AND x.status <> 'removed')
    FROM public.organisation_users m
    JOIN auth.users pu ON pu.id = m.user_id AND NOT coalesce(pu.is_sso_user, false)
    JOIN auth.users su ON coalesce(su.is_sso_user, false) AND lower(su.email::text) = lower(pu.email::text) AND su.id <> pu.id
   WHERE m.organisation_id = p_organisation_id AND m.status IN ('active', 'suspended')
     AND app.sso_email_covered(p_organisation_id, pu.email::text)
     AND NOT EXISTS (SELECT 1 FROM public.sso_match_dismissals d
                      WHERE d.organisation_id = p_organisation_id AND d.password_user_id = pu.id AND d.sso_user_id = su.id)
   ORDER BY 3, 4;
END $$;

CREATE FUNCTION app.dismiss_sso_match(p_organisation_id uuid, p_password_user_id uuid, p_sso_user_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT app.is_member(p_organisation_id) THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(p_organisation_id, 'members.manage') THEN RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501'; END IF;
  INSERT INTO public.sso_match_dismissals (organisation_id, password_user_id, sso_user_id, created_by)
  VALUES (p_organisation_id, p_password_user_id, p_sso_user_id, auth.uid())
  ON CONFLICT (organisation_id, password_user_id, sso_user_id) DO NOTHING;
END $$;

-- The move itself. Checks that the two accounts are the same person in the eyes of Fortress (one address, the new one a company account at a
-- verified domain, the old one a password member here), then moves. Each kind of record moves in its own sub-transaction.
CREATE FUNCTION app.sso_do_account_move(p_organisation_id uuid, p_old uuid, p_new uuid, p_by_self boolean) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_membership uuid; v_old_email text; v_new_email text; v_new_sso boolean; v_old_sso boolean;
  v_moved jsonb := '{}'; v_skipped jsonb := '{}'; v_step record; v_n bigint; v_move uuid;
  o text := quote_literal(p_old); n text := quote_literal(p_new); g text := quote_literal(p_organisation_id);
  v_name text;
BEGIN
  IF p_old IS NULL OR p_new IS NULL OR p_old = p_new THEN RAISE EXCEPTION 'Choose two different accounts' USING ERRCODE = 'QM030'; END IF;
  SELECT lower(email::text), coalesce(is_sso_user, false) INTO v_old_email, v_old_sso FROM auth.users WHERE id = p_old;
  SELECT lower(email::text), coalesce(is_sso_user, false) INTO v_new_email, v_new_sso FROM auth.users WHERE id = p_new;
  IF v_old_email IS NULL OR v_new_email IS NULL THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT v_new_sso OR v_old_sso THEN RAISE EXCEPTION 'Only a password account can be moved onto a company account' USING ERRCODE = 'QM030'; END IF;
  IF v_old_email <> v_new_email THEN RAISE EXCEPTION 'The two accounts have different email addresses' USING ERRCODE = 'QM030'; END IF;
  IF NOT app.sso_email_covered(p_organisation_id, v_new_email) THEN
    RAISE EXCEPTION 'The address is not at one of this organisation''s verified single sign-on domains' USING ERRCODE = 'QM030';
  END IF;
  SELECT id INTO v_membership FROM public.organisation_users
   WHERE organisation_id = p_organisation_id AND user_id = p_old AND status IN ('active', 'suspended') FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'That person is not a member here with a password account' USING ERRCODE = 'QM030'; END IF;

  -- The company account's own membership (it may have joined or accepted an invitation) gives way to the one that carries the history.
  UPDATE public.organisation_users SET status = 'removed'
   WHERE organisation_id = p_organisation_id AND user_id = p_new AND status <> 'removed' AND id <> v_membership;
  UPDATE public.organisation_users SET user_id = p_new WHERE id = v_membership;

  FOR v_step IN
    SELECT * FROM (VALUES
      ('Employees.auth_id', format('UPDATE public."Employees" SET auth_id = %s WHERE organisation_id = %s AND auth_id = %s', n, g, o)),
      ('audit_definitions.auditor_user_id', format('UPDATE public.audit_definitions SET auditor_user_id = %s WHERE organisation_id = %s AND auditor_user_id = %s AND status = ''active''', n, g, o)),
      ('control_plans.owner_id', format('UPDATE public.control_plans SET owner_id = %s WHERE organisation_id = %s AND owner_id = %s AND active', n, g, o)),
      ('document_recipients.user_id', format('UPDATE public.document_recipients r SET user_id = %s WHERE r.organisation_id = %s AND r.user_id = %s AND r.acknowledged_at IS NULL
          AND EXISTS (SELECT 1 FROM public.document_revisions v WHERE v.id = r.revision_id AND v.status = ''effective'')
          AND NOT EXISTS (SELECT 1 FROM public.document_recipients x WHERE x.revision_id = r.revision_id AND x.user_id = %s)', n, g, o, n)),
      ('document_revision_reviewers.user_id', format('UPDATE public.document_revision_reviewers r SET user_id = %s WHERE r.organisation_id = %s AND r.user_id = %s
          AND EXISTS (SELECT 1 FROM public.document_revisions v WHERE v.id = r.revision_id AND v.status = ''draft'')
          AND NOT EXISTS (SELECT 1 FROM public.document_revision_reviewers x WHERE x.revision_id = r.revision_id AND x.user_id = %s)', n, g, o, n)),
      ('document_revisions.approver_id', format('UPDATE public.document_revisions SET approver_id = %s WHERE organisation_id = %s AND approver_id = %s AND status IN (''draft'', ''in_review'', ''awaiting_approval'')', n, g, o)),
      ('document_signoffs.user_id', format('UPDATE public.document_signoffs SET user_id = %s WHERE organisation_id = %s AND user_id = %s AND decision = ''pending''', n, g, o)),
      ('documents.owner_user_id', format('UPDATE public.documents SET owner_user_id = %s WHERE organisation_id = %s AND owner_user_id = %s AND status IN (''draft'', ''active'')', n, g, o)),
      ('gauges.custodian_id', format('UPDATE public.gauges SET custodian_id = %s WHERE organisation_id = %s AND custodian_id = %s AND deleted_at IS NULL AND status NOT IN (''retired'', ''lost'')', n, g, o)),
      ('management_review_actions.owner_user_id', format('UPDATE public.management_review_actions SET owner_user_id = %s WHERE organisation_id = %s AND owner_user_id = %s AND status = ''open''', n, g, o)),
      ('management_review_attendees.user_id', format('UPDATE public.management_review_attendees a SET user_id = %s WHERE a.organisation_id = %s AND a.user_id = %s
          AND EXISTS (SELECT 1 FROM public.management_reviews r WHERE r.id = a.review_id AND r.status IN (''planned'', ''in_progress''))
          AND NOT EXISTS (SELECT 1 FROM public.management_review_attendees x WHERE x.review_id = a.review_id AND x.user_id = %s)', n, g, o, n)),
      ('management_reviews.chair_user_id', format('UPDATE public.management_reviews SET chair_user_id = %s WHERE organisation_id = %s AND chair_user_id = %s AND status IN (''planned'', ''in_progress'')', n, g, o)),
      ('nonconformances.owner_id', format('UPDATE public.nonconformances SET owner_id = %s WHERE organisation_id = %s AND owner_id = %s AND deleted_at IS NULL AND stage NOT IN (''closed'', ''cancelled'')', n, g, o)),
      ('notification_preferences.user_id', format('UPDATE public.notification_preferences p SET user_id = %s WHERE p.organisation_id = %s AND p.user_id = %s
          AND NOT EXISTS (SELECT 1 FROM public.notification_preferences x WHERE x.organisation_id = p.organisation_id AND x.user_id = %s AND x.event_type_id = p.event_type_id)', n, g, o, n)),
      ('quality_alert_recipients.user_id', format('UPDATE public.quality_alert_recipients r SET user_id = %s WHERE r.organisation_id = %s AND r.user_id = %s AND r.acknowledged_at IS NULL
          AND EXISTS (SELECT 1 FROM public.quality_alerts a WHERE a.id = r.alert_id AND a.status = ''active'')', n, g, o)),
      ('quality_objectives.owner_user_id', format('UPDATE public.quality_objectives SET owner_user_id = %s WHERE organisation_id = %s AND owner_user_id = %s AND retired_at IS NULL', n, g, o)),
      ('reminder_preferences.user_id', format('UPDATE public.reminder_preferences p SET user_id = %s WHERE p.organisation_id = %s AND p.user_id = %s
          AND NOT EXISTS (SELECT 1 FROM public.reminder_preferences x WHERE x.organisation_id = p.organisation_id AND x.user_id = %s AND x.area = p.area)', n, g, o, n)),
      ('risk_actions.owner_user_id', format('UPDATE public.risk_actions SET owner_user_id = %s WHERE organisation_id = %s AND owner_user_id = %s AND status = ''open''', n, g, o)),
      ('risks.owner_user_id', format('UPDATE public.risks SET owner_user_id = %s WHERE organisation_id = %s AND owner_user_id = %s AND status NOT IN (''closed'', ''retired'')', n, g, o)),
      ('saved_filters.user_id', format('UPDATE public.saved_filters f SET user_id = %s WHERE f.organisation_id = %s AND f.user_id = %s
          AND NOT EXISTS (SELECT 1 FROM public.saved_filters x WHERE x.organisation_id = f.organisation_id AND x.user_id = %s AND x.scope = f.scope AND lower(x.name) = lower(f.name))', n, g, o, n)),
      ('supplier_scars.owner_user_id', format('UPDATE public.supplier_scars SET owner_user_id = %s WHERE organisation_id = %s AND owner_user_id = %s AND status NOT IN (''closed'', ''cancelled'')', n, g, o)),
      ('workflow_tasks.assignee_user_id', format('UPDATE public.workflow_tasks SET assignee_user_id = %s WHERE organisation_id = %s AND assignee_user_id = %s AND status = ''open''', n, g, o)),
      ('integration_import_settings.schedule_set_by', format('UPDATE public.integration_import_settings SET schedule_set_by = %s WHERE organisation_id = %s AND schedule_set_by = %s', n, g, o)),
      ('supplier_scorecard_schedules.set_by', format('UPDATE public.supplier_scorecard_schedules SET set_by = %s WHERE organisation_id = %s AND set_by = %s', n, g, o))
    ) AS s(key, stmt)
  LOOP
    BEGIN
      EXECUTE v_step.stmt;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n > 0 THEN v_moved := v_moved || jsonb_build_object(v_step.key, v_n); END IF;
    EXCEPTION WHEN OTHERS THEN
      v_skipped := v_skipped || jsonb_build_object(v_step.key, left(SQLERRM, 300));
    END;
  END LOOP;

  INSERT INTO public.sso_account_moves (organisation_id, membership_id, from_user_id, to_user_id, email, by_self, created_by, moved, skipped)
  VALUES (p_organisation_id, v_membership, p_old, p_new, v_new_email, p_by_self, coalesce(auth.uid(), p_new), v_moved, v_skipped)
  RETURNING id INTO v_move;
  v_name := app.sso_person_name(p_new);
  INSERT INTO public.sso_changes (organisation_id, kind, user_id, user_name, summary, guidance)
  VALUES (p_organisation_id, 'account_moved', p_new, v_name,
          coalesce(v_name, v_new_email) || ' now signs in with their company account; their membership and open work moved across'
            || CASE WHEN p_by_self THEN ' (they confirmed it with their old password)' ELSE '' END,
          'Finished records keep the old account as history. Settings → Users & permissions shows the move.');
  RETURN v_move;
END $$;

-- A member manager moves someone (members.manage, on the old membership).
CREATE FUNCTION app.move_member_to_sso_account(p_organisation_id uuid, p_old uuid, p_new uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_membership uuid;
BEGIN
  IF NOT app.is_member(p_organisation_id) THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT app.has_permission(p_organisation_id, 'members.manage') THEN RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501'; END IF;
  SELECT id INTO v_membership FROM public.organisation_users WHERE organisation_id = p_organisation_id AND user_id = p_old AND status IN ('active', 'suspended');
  IF v_membership IS NOT NULL AND NOT app.can_manage_membership(v_membership) THEN
    RAISE EXCEPTION 'You cannot manage this member' USING ERRCODE = '42501';
  END IF;
  IF p_old = auth.uid() THEN RAISE EXCEPTION 'Move your own account by signing in with your company account' USING ERRCODE = 'QM030'; END IF;
  RETURN app.sso_do_account_move(p_organisation_id, p_old, p_new, false);
END $$;

-- The person moves themselves, signed in with the company account, after the API checked the old account's password.
CREATE FUNCTION app.system_move_own_account(p_organisation_id uuid, p_old uuid, p_new uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RETURN app.sso_do_account_move(p_organisation_id, p_old, p_new, true);
END $$;

-- The organisations where this company account has a password account waiting to be moved (same address, a member there), for the person.
CREATE FUNCTION app.my_sso_move_candidates()
RETURNS TABLE (organisation_id uuid, name text, password_user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT o.id, o.name, pu.id
    FROM auth.users su
    JOIN auth.users pu ON lower(pu.email::text) = lower(su.email::text) AND pu.id <> su.id AND NOT coalesce(pu.is_sso_user, false)
    JOIN public.organisation_users m ON m.user_id = pu.id AND m.status IN ('active', 'suspended')
    JOIN public.organisations o ON o.id = m.organisation_id AND o.status = 'active'
   WHERE su.id = auth.uid() AND coalesce(su.is_sso_user, false) AND app.sso_email_covered(o.id, su.email::text)
$$;

-- Which members sign in with a company account (for the "Company sign-in" mark on Settings → Users). Members only; no addresses.
CREATE FUNCTION app.member_company_accounts(p_organisation_id uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT m.user_id FROM public.organisation_users m JOIN auth.users u ON u.id = m.user_id
   WHERE m.organisation_id = p_organisation_id AND m.status <> 'removed' AND coalesce(u.is_sso_user, false) AND app.is_member(p_organisation_id)
$$;

REVOKE ALL ON FUNCTION app.set_sso_joining(uuid, text, uuid, uuid), app.sso_joinable_organisations(), app.join_by_company_sign_in(uuid),
  app.user_reference_columns(), app.sso_member_matches(uuid), app.dismiss_sso_match(uuid, uuid, uuid), app.sso_do_account_move(uuid, uuid, uuid, boolean),
  app.move_member_to_sso_account(uuid, uuid, uuid), app.system_move_own_account(uuid, uuid, uuid), app.my_sso_move_candidates(),
  app.member_company_accounts(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.set_sso_joining(uuid, text, uuid, uuid), app.sso_joinable_organisations(), app.join_by_company_sign_in(uuid),
  app.sso_member_matches(uuid), app.dismiss_sso_match(uuid, uuid, uuid), app.move_member_to_sso_account(uuid, uuid, uuid), app.my_sso_move_candidates(),
  app.member_company_accounts(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION app.system_move_own_account(uuid, uuid, uuid), app.user_reference_columns() TO qms_api;
