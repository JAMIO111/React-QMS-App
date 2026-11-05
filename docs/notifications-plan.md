# Notifications (in-app)

- Migration `20251111100000_notifications.sql`: `notification_event_types` (global catalogue: `<entity>.<created|updated|deleted>`, permission, default rule), `notifications` (one row per audited change, written by trigger `emit_notification` on `audit.events`), `notification_preferences` (per-user overrides), `notification_reads`.
- Access = company permission AND subscription (`app.has_permission`) AND the user's preference. Defaults: `default_on`, narrowed by `default_permission_code` (e.g. updates to NCRs default on only for people who can manage them). Own actions never notify; 90-day window.
- Reads/writes go through `app.visible_notifications`, `mark_notifications_read`, `list/set/reset_notification_preferences`; bad types raise `QM010` (404 `notification_type_not_found`).
- API: `GET /notifications`, `POST /notifications/read`, `GET|PUT|DELETE /notification-preferences` (`api/src/notifications/`).
- UI: header bell + `NotificationPane`, Settings → Notifications (`SettingsNotifications.jsx`). Legacy `"Notifications"` tables are unused.
- Email delivery is deferred. New audited tables get an event by adding rows to `notification_event_types`.
