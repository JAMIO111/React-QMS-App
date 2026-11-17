/**
 * The Fortress QMS email layout: a branded header, a clear heading, the message, the facts that matter, one button, the address written out in
 * case the button does not work, and a footer that says who sent it and why. Plain, table-based HTML with inline styles (what email clients,
 * Outlook included, render reliably), and a text version with the same words. Everything put in is escaped.
 *
 * Used for invitations (and the company sign-in invitation); the Supabase templates in supabase/templates/ follow the same look.
 */

export interface BrandedEmailInput {
  /** The app's address, for the logo; without it the header is the name in words. */
  appBaseUrl?: string;
  /** Shown by inbox previews after the subject. */
  preheader: string;
  heading: string;
  paragraphs: string[];
  /** A message from a person, shown as a quote with who wrote it. */
  quote?: { text: string; by?: string | null } | null;
  /** Label / value rows (Organisation, Invited by, Role…). Empty values are left out. */
  facts?: Array<[string, string | null | undefined]>;
  button: { label: string; url: string };
  /** Small print under the button (expiry, what to do if it was not expected). */
  notes?: string[];
  /** Why the person got this email. */
  footer: string;
}

const BRAND = '#2563eb';
const INK = '#0f172a';
const TEXT = '#334155';
const MUTED = '#64748b';
const LINE = '#e2e8f0';

export const escapeHtml = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const absolute = (path: string, base?: string) => {
  if (!base) return null;
  try {
    return new URL(path, base).toString();
  } catch {
    return null;
  }
};

export function renderBrandedEmail(input: BrandedEmailInput): { html: string; text: string } {
  const h = escapeHtml;
  const logo = absolute('/fortress-qms.png', input.appBaseUrl);
  const facts = (input.facts ?? []).filter(([, v]) => typeof v === 'string' && v.trim() !== '') as Array<[string, string]>;
  const year = new Date().getUTCFullYear();

  const header = `<tr><td style="background:${INK};padding:20px 32px;border-radius:12px 12px 0 0">
<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
${logo ? `<td style="padding-right:12px;vertical-align:middle"><img src="${h(logo)}" width="36" height="36" alt="" style="display:block;border:0;border-radius:8px"></td>` : ''}
<td style="vertical-align:middle;font-size:18px;font-weight:700;color:#ffffff;letter-spacing:0.2px">Fortress QMS</td>
</tr></table></td></tr>`;

  const paragraphs = input.paragraphs.map((p) => `<p style="margin:0 0 16px;font-size:15px;line-height:24px;color:${TEXT}">${h(p)}</p>`).join('\n');

  const quote = input.quote?.text
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:4px 0 20px"><tr>
<td style="border-left:3px solid ${BRAND};background:#f8fafc;padding:12px 16px;font-size:15px;line-height:23px;color:${TEXT};font-style:italic">“${h(input.quote.text)}”${input.quote.by ? `<div style="margin-top:6px;font-style:normal;font-size:13px;color:${MUTED}">— ${h(input.quote.by)}</div>` : ''}</td>
</tr></table>`
    : '';

  const factRows = facts.length
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 24px;border:1px solid ${LINE};border-radius:8px">
${facts
  .map(
    ([k, v], i) =>
      `<tr><td style="padding:10px 16px;font-size:13px;color:${MUTED};width:38%;${i ? `border-top:1px solid ${LINE};` : ''}">${h(k)}</td><td style="padding:10px 16px;font-size:14px;color:${INK};font-weight:600;${i ? `border-top:1px solid ${LINE};` : ''}">${h(v)}</td></tr>`,
  )
  .join('\n')}
</table>`
    : '';

  // A "bulletproof" button: a table cell with a background, so it shows as a button in Outlook too.
  const button = `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 24px"><tr>
<td style="border-radius:8px;background:${BRAND}"><a href="${h(input.button.url)}" target="_blank" style="display:inline-block;padding:13px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px">${h(input.button.label)}</a></td>
</tr></table>`;

  const notes = (input.notes ?? []).map((n) => `<p style="margin:0 0 10px;font-size:13px;line-height:20px;color:${MUTED}">${h(n)}</p>`).join('\n');

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${h(input.heading)}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${h(input.preheader)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f1f5f9"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px">
${header}
<tr><td style="background:#ffffff;padding:32px 32px 24px;border:1px solid ${LINE};border-top:0;border-radius:0 0 12px 12px">
<h1 style="margin:0 0 20px;font-size:22px;line-height:30px;font-weight:700;color:${INK}">${h(input.heading)}</h1>
${paragraphs}
${quote}
${factRows}
${button}
<p style="margin:0 0 6px;font-size:13px;line-height:20px;color:${MUTED}">If the button does not work, copy this address into your browser:</p>
<p style="margin:0 0 24px;font-size:13px;line-height:20px;word-break:break-all"><a href="${h(input.button.url)}" style="color:${BRAND};text-decoration:underline">${h(input.button.url)}</a></p>
<div style="border-top:1px solid ${LINE};padding-top:16px">${notes}</div>
</td></tr>
<tr><td style="padding:20px 32px;text-align:center;font-size:12px;line-height:18px;color:${MUTED}">
${h(input.footer)}<br>Fortress QMS · Quality management for manufacturers · © ${year}
</td></tr>
</table></td></tr></table>
</body></html>`;

  const text = [
    input.heading,
    '',
    ...input.paragraphs.flatMap((p) => [p, '']),
    ...(input.quote?.text ? [`"${input.quote.text}"${input.quote.by ? ` — ${input.quote.by}` : ''}`, ''] : []),
    ...facts.map(([k, v]) => `${k}: ${v}`),
    ...(facts.length ? [''] : []),
    `${input.button.label}: ${input.button.url}`,
    '',
    ...(input.notes ?? []),
    '',
    '—',
    input.footer,
    'Fortress QMS · Quality management for manufacturers',
  ].join('\n');

  return { html, text };
}
