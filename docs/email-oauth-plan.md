# Email notifications and OAuth client credentials — plan

Date: 2026-11-11. Two independent features, agreed decisions below. Migrations `20260131100000_integration_oauth_client.sql` and `20260131200000_email_notifications.sql` were applied live on 2026-11-11 (live guardrails 0 violations); they were renamed from `20260124…`/`20260125…` after parallel migrations took those numbers. `20260201100000_notifications_merge.sql` restores the competence notice branch the email migration overwrote.

## Decisions (agreed)

| # | Decision |
|---|---|
| E1 | **One mail transport chosen by env** (`MAIL_PROVIDER`): unset / `none` = **outbox only** — each email is built and queued exactly as it would be sent and marked *not sent: no mail provider*; `resend` = Resend's HTTPS API (`RESEND_API_KEY`, `MAIL_FROM`). Supabase's own mail service sends only its auth templates, so it cannot carry notifications. Switching to Resend for production is an env change, no code change. |
| E2 | **Every notification can be emailed, per person.** Settings → Notifications gets an Email switch beside each event (only where the in-app notice is on). Email is on by default only for notices addressed to one person (quality alert addressed to you or withdrawn, 8D action assigned to you) and for **integration alerts** (new). |
| E3 | **Queue, sent after each action.** Notifications that should be emailed become rows of `email_outbox` (one per notification and person, never twice). The API works the queue right after the request that caused it (fan-out + send, in the background of that request) and a cron catches anything missed. Failures back off (1, 4, 16, 64 minutes; five attempts). |
| E4 | **An email carries the notice's title, short text and a link**; reading the record needs a sign-in, as in the app. Visibility is exactly the in-app rule (permission, site, subscription, preference, addressed-to, not your own action) evaluated for the recipient. Only confirmed addresses of active members. |
| O1 | **OAuth 2.0 client credentials** for REST connections: token address on any **public https host allowed by the organisation's allow-list** (Microsoft Entra, Auth0, Okta…), sent through `SafeHttpClient` with every rule (https/443, public addresses, pinned socket, no redirects). Client id + secret stored in Vault as one credential (`oauth_client`); scope and audience optional; client authentication in the body or with HTTP basic. The access token is **kept in memory until shortly before it expires, never stored**; a 401 drops it and asks once more. |

## Slices

- **OA1 — OAuth client credentials (done).** Migration `20260131100000_integration_oauth_client.sql`: REST provider offers `oauth_client`; `app.integration_config_problem` accepts `authType: oauth_client` with `oauthTokenUrl` (required, same URL rules), `oauthScope`, `oauthAudience`, `oauthClientAuth` (`body` | `basic`); the token host must be allowed for activation; `app.set_integration_credential` checks an `oauth_client` secret is JSON `{clientId, clientSecret}`. API: `SafeHttpClient.post` (form body), `RestApiAdapter` token fetch + cache, config schema, test messages. UI: sign-in type "OAuth client credentials" with token address, scope, audience, client authentication; credential dialog asks client id + secret. Also fixes the basic sign-in credential (the dialog sent `user:password`, the database needs JSON).
- **EM1 — database (done).** Migration `20260131200000_email_notifications.sql`: `notification_event_types.email_default`; `notification_preferences.email` (null = default); `app.notification_email_wanted`, list/set preference functions; `notifications.email_queued_at`; `email_outbox` (functions only); `integration_alerts` (audited, one per finished run that failed or left rows for a person) + event type `integration_alerts.created`; API-login-only `app.system_queue_notification_emails`, `system_lease_emails`, `system_finish_email`, operator `app.platform_email_outbox`.
- **EM2 — API (done).** `api/src/email/`: `MailTransport` (none, resend), templates (text + simple HTML), `EmailService.drain()`, after-request trigger (`EmailKick` interceptor on mutations), cron `GET|POST /internal/cron/email` (scheduled daily in `api/vercel.json`: the Hobby plan allows daily crons only; on Pro make it every few minutes), operator `GET /platform/email`.
- **EM3 — UI + docs (done).** Settings → Notifications Email column (optimistic), platform panel **Email** tab, integration alert notices link to the run, docs and CLAUDE.md.

## Not built

Daily digests, push notifications, per-organisation sender addresses, bounce handling / suppression lists, unsubscribe links in the mail (the Settings page is the switch), OAuth authorisation-code (user sign-in) flows, private-key JWT client assertions.
