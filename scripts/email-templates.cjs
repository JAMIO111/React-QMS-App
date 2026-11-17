#!/usr/bin/env node
/**
 * Writes the Supabase Auth email templates (supabase/templates/*.html) from the same layout the API uses for its own emails
 * (api/src/email/branded-email.ts), so every Fortress QMS email looks the same. Run after `npm run api:build`:
 *
 *   npm run api:build && node scripts/email-templates.cjs
 *
 * Each link goes to the app's confirm page with the one-time token added ({{ .RedirectTo }} is already the confirm page, built by the app and
 * the API with ?next=…), so the token is used only when the person presses Continue there, never by email security that opens links first.
 * Paste each file into Supabase → Authentication → Email Templates (see docs/email-setup.md).
 */
const fs = require('node:fs');
const path = require('node:path');
const { renderBrandedEmail } = require('../api/dist/email/branded-email');

const LOGO_BASE = 'https://logo-base.invalid';
const link = (type) => `{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=${type}`;

const templates = {
  invite: {
    subject: "You're invited to join {{ .Data.invited_to }} on Fortress QMS",
    preheader: 'Accept your invitation and set your password.',
    heading: 'Join {{ .Data.invited_to }} on Fortress QMS',
    paragraphs: [
      'You have been invited to join {{ .Data.invited_to }} on Fortress QMS, where the team manages non-conformances, audits, documents and quality records.',
      'Accept the invitation to set your password. It takes less than a minute.',
    ],
    facts: [['Organisation', '{{ .Data.invited_to }}'], ['Your email', '{{ .Email }}']],
    button: { label: 'Accept invitation', url: link('invite') },
    notes: [
      "This invitation was sent to {{ .Email }}. If you weren't expecting it, you can ignore this email: nothing is set up until you accept.",
      'For your security the link works once. If it has expired, ask the person who invited you to send it again.',
    ],
    footer: 'You received this email because someone invited {{ .Email }} to Fortress QMS.',
  },
  'magic-link': {
    subject: 'Your Fortress QMS sign-in link',
    preheader: 'Sign in to Fortress QMS. Your invitation is waiting.',
    heading: 'Sign in to Fortress QMS',
    paragraphs: [
      'Use the button below to sign in to Fortress QMS. If you have been invited to an organisation, the invitation will be waiting for you.',
    ],
    facts: [['Your email', '{{ .Email }}']],
    button: { label: 'Sign in', url: link('magiclink') },
    notes: ["If you didn't ask to sign in, you can ignore this email. The link works once and expires soon."],
    footer: 'You received this email because a sign-in link was requested for {{ .Email }} on Fortress QMS.',
  },
  recovery: {
    subject: 'Reset your Fortress QMS password',
    preheader: 'Choose a new password for your Fortress QMS account.',
    heading: 'Reset your password',
    paragraphs: ['We received a request to reset the password for your Fortress QMS account. Use the button below to choose a new one.'],
    facts: [['Your email', '{{ .Email }}']],
    button: { label: 'Choose a new password', url: link('recovery') },
    notes: [
      "If you didn't ask for this, you can ignore this email: your password stays as it is.",
      'For your security the link works once and expires soon.',
    ],
    footer: 'You received this email because a password reset was requested for {{ .Email }} on Fortress QMS.',
  },
  confirmation: {
    subject: 'Confirm your email for Fortress QMS',
    preheader: 'Confirm your email address to start using Fortress QMS.',
    heading: 'Confirm your email address',
    paragraphs: ['Thanks for signing up to Fortress QMS. Confirm your email address to finish setting up your account.'],
    facts: [['Your email', '{{ .Email }}']],
    button: { label: 'Confirm my email', url: link('email') },
    notes: ["If you didn't create a Fortress QMS account, you can ignore this email."],
    footer: 'You received this email because {{ .Email }} was used to sign up to Fortress QMS.',
  },
  // Fortress has no "change my email" screen (Settings → Account shows it read-only); this covers a change made in Supabase's dashboard or by
  // its admin API. Supabase sets no redirect for those, so the link is built from the Site URL rather than {{ .RedirectTo }}. With "Secure
  // email change" on, both the old and the new address get this email, each with its own token, and both must confirm.
  'email-change': {
    subject: 'Confirm the change to your Fortress QMS email address',
    preheader: 'Confirm the new sign-in address for your Fortress QMS account.',
    heading: 'Confirm your new email address',
    paragraphs: [
      'A change was requested to the email address you use to sign in to Fortress QMS.',
      'Confirm it with the button below. Until it is confirmed you keep signing in with your current address.',
    ],
    facts: [['Current address', '{{ .Email }}'], ['New address', '{{ .NewEmail }}']],
    button: { label: 'Confirm the change', url: '{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email_change&next=/Settings/Account' },
    notes: [
      "If you didn't ask for this, don't press the button and tell your administrator straight away: someone may be trying to take over your account.",
      'For your security the link works once and expires soon.',
    ],
    footer: 'You received this email because a change of sign-in address was requested for a Fortress QMS account.',
  },
};

const dir = path.join(__dirname, '..', 'supabase', 'templates');
fs.mkdirSync(dir, { recursive: true });
const subjects = [];
for (const [name, t] of Object.entries(templates)) {
  const { html } = renderBrandedEmail({ ...t, appBaseUrl: LOGO_BASE });
  // The logo comes from the app (Supabase's Site URL), the links are kept as template variables (escaping & is correct inside an href).
  const out = html.split(`${LOGO_BASE}/fortress-qms.png`).join('{{ .SiteURL }}/fortress-qms.png');
  fs.writeFileSync(path.join(dir, `${name}.html`), out);
  subjects.push(`${name}: ${t.subject}`);
}
fs.writeFileSync(path.join(dir, 'subjects.txt'), subjects.join('\n') + '\n');
console.log(`wrote ${Object.keys(templates).length} templates to supabase/templates/`);
