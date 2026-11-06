-- DOC4 exit check: the performance advisor (auth_rls_initplan) flagged five SELECT policies that call auth.uid() once per row.
-- Wrapping it as (select auth.uid()) lets Postgres evaluate it once per statement. Same rules, same results; only the form changes.
-- (The same fix was made for ten policies in the Phase 1 hardening migration.)

DROP POLICY department_members_select ON public.department_members;
CREATE POLICY department_members_select ON public.department_members FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'members.read')
         OR EXISTS (SELECT 1 FROM public.organisation_users m WHERE m.id = membership_id AND m.user_id = (SELECT auth.uid())));

DROP POLICY quality_alert_recipients_select ON public.quality_alert_recipients;
CREATE POLICY quality_alert_recipients_select ON public.quality_alert_recipients FOR SELECT TO authenticated
  USING (app.has_permission(organisation_id, 'documentation.manage')
         OR (user_id = (SELECT auth.uid()) AND app.is_member(organisation_id)));

DROP POLICY notifications_select ON public.notifications;
CREATE POLICY notifications_select ON public.notifications FOR SELECT TO authenticated
  USING (app.notification_can_see(organisation_id, event_type_id, details)
         AND (recipient_user_id IS NULL OR recipient_user_id = (SELECT auth.uid())));

DROP POLICY notification_preferences_select ON public.notification_preferences;
CREATE POLICY notification_preferences_select ON public.notification_preferences FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) AND app.is_member(organisation_id));

DROP POLICY notification_reads_select ON public.notification_reads;
CREATE POLICY notification_reads_select ON public.notification_reads FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) AND app.is_member(organisation_id));
