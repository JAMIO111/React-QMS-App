# Email set-up: invitations, sign-in links, password resets

## Why invitation links said "expired or already used" (found 2026-11-17)

Supabase's auth logs showed it: an invitation was sent to a Microsoft 365 mailbox at 10:34:56, and at 10:35:12 — before anyone clicked — a
Microsoft address opened the link (Defender **Safe Links** checks every link in an email). That visit **used the one-time token** and signed the
"user" up. Every later click by the real person got `One-time token not found` → "This link has expired or has already been used". Mimecast,
Proofpoint and similar services do the same. Password-reset and sign-up confirmation links had the same weakness.

**The fix (in the code):** every email link now lands on the app's **confirm page** (`/auth/confirm`), which shows a **Continue** button and uses
the token only when the person presses it (`supabase.auth.verifyOtp({ token_hash, type })`). A scanner that opens the link uses nothing.

For that, the email has to carry the token *to the confirm page* instead of Supabase's own one-click link. There are two ways the emails are sent;
do step 1 in either case.

## 1. Supabase: allow the confirm page as a redirect (required)

Supabase → **Authentication → URL Configuration**:

- **Site URL**: the app's address (for Dev: `https://qms-web-git-dev-jamie-drydens-projects.vercel.app`). The templates load the logo from it.
- **Redirect URLs**: add `https://qms-web-git-dev-jamie-drydens-projects.vercel.app/**` (and later the production address with `/**`).
  Without it Supabase replaces the link's destination with the Site URL and the templates' links break.

## 2a. Supabase sends the emails (works today, no new service)

Supabase → **Authentication → Email Templates**. For each template below, paste the file's whole content into **Message body** and set the
**Subject** from `supabase/templates/subjects.txt`:

| Supabase template | File |
|---|---|
| Invite user | `supabase/templates/invite.html` |
| Magic Link | `supabase/templates/magic-link.html` |
| Reset Password | `supabase/templates/recovery.html` |
| Confirm signup | `supabase/templates/confirmation.html` |
| Change Email Address | `supabase/templates/email-change.html` |

Fortress has no "change my email" screen (Settings → Account shows the address read-only), so the change-email template is only used when an
address is changed in Supabase's dashboard or admin API. Its button is built from the **Site URL** (`{{ .SiteURL }}/auth/confirm?…&type=email_change`),
because those changes carry no redirect. With **Secure email change** on (Authentication → Providers → Email), both the old and the new address
get it and both must confirm.

The other buttons go to `{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=…`: `RedirectTo` is the confirm page with `?next=…`, set by the API
(invitations) and the app (sign-up, password reset), so the link always has a `?` to add to.

Limits of Supabase's built-in mailer: it sends from `noreply@mail.app.supabase.io` and only a few emails an hour. To send from your own
address, set up **custom SMTP** (Supabase → Project Settings → Authentication → SMTP; Resend's SMTP works) with a sender such as
`Fortress QMS <no-reply@your-domain>`. The templates stay the same.

## 2b. The API sends its own invitations (recommended once a mail provider is set up)

Set on the API (Vercel `qms-api`): `MAIL_PROVIDER=resend`, `RESEND_API_KEY` (secret), `MAIL_FROM` (e.g. `Fortress QMS <no-reply@your-domain>`, a
domain verified in Resend). Invitations are then made with Supabase's admin `generate_link` (which sends nothing) and sent by the API, with who
invited them, their message, the role and the expiry date, from your own address. Notification emails use the same provider.
Password resets and sign-up confirmations are still sent by Supabase (2a), so install those templates too (and custom SMTP for the sender).

## How the emails are built to survive work mail

Work mailboxes (desktop Outlook on Windows, Microsoft 365 security) are the hardest place for an email to look right, so the layout:

- uses **no pictures** — Outlook blocks outside pictures by default; the header mark is drawn in HTML;
- puts sizes and colours on the table cells as attributes (`width`, `bgcolor`) as well as in CSS, because Outlook draws with Word's engine;
- draws the button with its table cell (Outlook ignores padding on a link);
- uses **no conditional comments** (`<!--[if mso]>`): Supabase renders its templates with Go's `html/template`, which removes HTML comments;
- is a fixed 600px column, made full width on phones by a small-screen rule;
- has a white header with dark words (Outlook's dark mode turned the old dark header pale) and asks clients for light colours (`color-scheme: light only`); Outlook's dark mode may still recolour it, and its sun button shows the email in light colours.

A banner such as "[EXTERNAL]" or long `safelinks.protection.outlook.com` addresses come from your organisation's mail policy, not the email.
Sending from your own domain (custom SMTP or `MAIL_PROVIDER=resend`) is what most improves trust and keeps the email out of junk.

## Code

- `src/components/auth/ConfirmEmailLink.jsx` (`/auth/confirm`; `safeNext` keeps `next` inside the app), `src/authService.js` (`emailLinkUrl`,
  `verifyEmailLink`).
- `api/src/members/invitation-mailer.service.ts` (`confirmUrl`, own email via `generate_link` + `invitationEmail`, else Supabase's mailer with
  `redirect_to` = the confirm page), `api/src/email/branded-email.ts` (the layout).
- `scripts/email-templates.cjs` writes `supabase/templates/*.html` from the same layout: `npm run api:build && node scripts/email-templates.cjs`.
