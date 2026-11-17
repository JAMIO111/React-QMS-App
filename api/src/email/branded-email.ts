/**
 * The Fortress QMS email layout: a branded header, a clear heading, the message, the facts that matter, one button, the address written out in
 * case the button does not work, and a footer that says who sent it and why. Plain, table-based HTML with inline styles (what email clients,
 * Outlook included, render reliably), and a text version with the same words. Everything put in is escaped.
 *
 * Used for invitations (and the company sign-in invitation); the Supabase templates in supabase/templates/ follow the same look.
 */

export interface BrandedEmailInput {
  /** The app's address. Kept for callers; the header no longer uses a picture (work mail often blocks them). */
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
  const facts = (input.facts ?? []).filter(([, v]) => typeof v === 'string' && v.trim() !== '') as Array<[string, string]>;
  const year = new Date().getUTCFullYear();
  // Desktop Outlook (Word's engine) ignores web fonts, max-width, rounded corners and padding on links, and work mail often blocks pictures, so
  // the layout uses table attributes (width, bgcolor) as well as CSS, a button drawn by its table cell, and no
  // pictures at all: the mark in the header is drawn in HTML. Nothing depends on Outlook's conditional comments, because Supabase strips comments
  // (html/template); the column is a fixed 600px table that a small-screen rule makes full width on phones.
  const FONT = "font-family:Arial,'Segoe UI',Helvetica,sans-serif";

  const header = `<tr><td bgcolor="${INK}" style="background-color:${INK};padding:20px 32px;border-radius:12px 12px 0 0">
<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
<td width="36" height="36" bgcolor="${BRAND}" align="center" valign="middle" style="width:36px;height:36px;background-color:${BRAND};border-radius:8px;${FONT};font-size:20px;line-height:36px;font-weight:bold;color:#ffffff;mso-line-height-rule:exactly">F</td>
<td width="12" style="width:12px;font-size:0;line-height:0">&nbsp;</td>
<td valign="middle" style="${FONT};font-size:18px;line-height:24px;font-weight:bold;color:#ffffff">Fortress QMS</td>
</tr></table></td></tr>`;

  const paragraphs = input.paragraphs
    .map((p) => `<p style="margin:0 0 16px;${FONT};font-size:15px;line-height:24px;color:${TEXT}">${h(p)}</p>`)
    .join('\n');

  const quote = input.quote?.text
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:4px 0 20px"><tr>
<td width="3" bgcolor="${BRAND}" style="width:3px;background-color:${BRAND};font-size:0;line-height:0">&nbsp;</td>
<td bgcolor="#f8fafc" style="background-color:#f8fafc;padding:12px 16px;${FONT};font-size:15px;line-height:23px;color:${TEXT};font-style:italic">&ldquo;${h(input.quote.text)}&rdquo;${input.quote.by ? `<div style="margin-top:6px;font-style:normal;font-size:13px;color:${MUTED}">&mdash; ${h(input.quote.by)}</div>` : ''}</td>
</tr></table>`
    : '';

  const factRows = facts.length
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 24px;border:1px solid ${LINE};border-collapse:separate;border-radius:8px">
${facts
  .map(
    ([k, v], i) =>
      `<tr><td width="38%" valign="top" style="padding:10px 16px;${FONT};font-size:13px;line-height:20px;color:${MUTED};${i ? `border-top:1px solid ${LINE};` : ''}">${h(k)}</td><td valign="top" style="padding:10px 16px;${FONT};font-size:14px;line-height:20px;color:${INK};font-weight:bold;word-break:break-word;${i ? `border-top:1px solid ${LINE};` : ''}">${h(v)}</td></tr>`,
  )
  .join('\n')}
</table>`
    : '';

  // A button Outlook draws too: the colour and padding sit on the table cell (Outlook ignores padding on a link). No VML or conditional
  // comments: Supabase renders its templates with Go's html/template, which removes HTML comments.
  const url = h(input.button.url);
  const label = h(input.button.label);
  const button = `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 24px"><tr>
<td align="center" bgcolor="${BRAND}" style="background-color:${BRAND};border-radius:8px;padding:13px 28px;mso-padding-alt:13px 28px"><a href="${url}" target="_blank" style="display:inline-block;${FONT};font-size:15px;line-height:20px;font-weight:bold;color:#ffffff;text-decoration:none">${label}</a></td>
</tr></table>`;

  const notes = (input.notes ?? [])
    .map((n) => `<p style="margin:0 0 10px;${FONT};font-size:13px;line-height:20px;color:${MUTED}">${h(n)}</p>`)
    .join('\n');

  const html = `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only"><title>${h(input.heading)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
<style>body,table,td,p,a,h1{font-family:Arial,sans-serif !important}table{border-collapse:collapse}</style><![endif]-->
<style>:root{color-scheme:light only;supported-color-schemes:light only}a[x-apple-data-detectors]{color:inherit !important;text-decoration:none !important}
@media only screen and (max-width:640px){.fq-wrap{width:100% !important}.fq-pad{padding-left:20px !important;padding-right:20px !important}.fq-outer{padding:16px 8px !important}}</style>
</head>
<body bgcolor="#f1f5f9" style="margin:0;padding:0;background-color:#f1f5f9;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all">${h(input.preheader)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#f1f5f9" style="background-color:#f1f5f9"><tr><td class="fq-outer" align="center" style="padding:32px 16px">
<table role="presentation" class="fq-wrap" width="600" align="center" cellspacing="0" cellpadding="0" border="0" style="width:600px">
${header}
<tr><td class="fq-pad" bgcolor="#ffffff" style="background-color:#ffffff;padding:32px 32px 24px;border:1px solid ${LINE};border-top:0;border-radius:0 0 12px 12px">
<h1 style="margin:0 0 20px;${FONT};font-size:22px;line-height:30px;font-weight:bold;color:${INK}">${h(input.heading)}</h1>
${paragraphs}
${quote}
${factRows}
${button}
<p style="margin:0 0 6px;${FONT};font-size:13px;line-height:20px;color:${MUTED}">If the button does not work, copy this address into your browser:</p>
<p style="margin:0 0 24px;${FONT};font-size:13px;line-height:20px;word-break:break-all"><a href="${url}" style="color:${BRAND};text-decoration:underline">${h(input.button.url)}</a></p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td style="border-top:1px solid ${LINE};padding-top:16px">${notes}</td></tr></table>
</td></tr>
<tr><td align="center" style="padding:20px 32px;${FONT};font-size:12px;line-height:18px;color:${MUTED}">
${h(input.footer)}<br>Fortress QMS &middot; Quality management for manufacturers &middot; &copy; ${year}
</td></tr>
</table>
</td></tr></table>
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
