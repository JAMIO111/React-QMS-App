/**
 * What a notification email says (decision E4): the notice's title and short text, the organisation, and a link to the record. Reading the record still
 * needs a sign-in, exactly as in the app. Plain text and a simple HTML version; everything that came from the database is escaped in the HTML.
 */

export interface EmailRow {
  id: string;
  organisation_name: string;
  to_address: string;
  recipient_name: string | null;
  event_key: string;
  entity_type: string;
  entity_id: string;
  title: string;
  body: string | null;
  details: Record<string, unknown> | null;
  created_at: string | Date;
}

import { reminderPath } from '../reminders/reminder-paths';
import { workflowRecordPath } from '../workflows/catalogue';

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (v: unknown): string | null => (typeof v === 'string' && UUID.test(v) ? v : null);

/** Where the notice leads in the web app. Mirrors `notificationLink` in src/lib/notifications.js (plus integration alerts); null when there is no page. */
export function notificationPath(entityType: string, entityId: string, details: Record<string, unknown> | null): string | null {
  const d = details ?? {};
  const e = id(entityId);
  switch (entityType) {
    case 'nonconformances':
      return d.deleted || !e ? null : `/Non-Conformance/Register/${e}`;
    case 'gauges':
      return e && `/Calibration/Gauges/${e}`;
    case 'calibrations':
      return e && id(d.gauge_id) ? `/Calibration/Gauges/${id(d.gauge_id)}/calibrations/${e}` : null;
    case 'inspection_records':
      return e && `/Inspections/${e}`;
    case 'control_plans':
      return e && `/Process-Control/Plans/${e}`;
    case 'control_plan_revisions':
      return e && id(d.control_plan_id) ? `/Process-Control/Plans/${id(d.control_plan_id)}/revisions/${e}` : null;
    case 'quality_alert_recipients':
      return id(d.alert_id) ? `/Documentation/Quality-Alerts/${id(d.alert_id)}` : '/Documentation/My-Alerts';
    case 'capa_actions':
      return '/CAPA/My-Actions';
    case 'risks':
      return e && `/Risk/Register/${e}`;
    case 'management_review_actions':
      return '/Management-Review/My-Actions';
    case 'risk_actions':
      return id(d.risk_id) ? `/Risk/Register/${id(d.risk_id)}` : '/Risk/My-Work';
    case 'spc_alerts':
      return '/Process-Control/Alerts';
    case 'parts':
      return e && `/Parts/${e}`;
    case 'part_families':
      return e && `/Part-Families/${e}`;
    case 'user_subscription_assignments':
    case 'organisation_subscriptions':
    case 'billing_invoices':
      return '/Settings/Subscription';
    case 'organisation_users':
      return '/Settings/Users';
    case 'workflow_notices':
      return workflowRecordPath(d.record_kind, d.record_id);
    case 'workflow_tasks':
      return '/Tasks';
    case 'reminder_digests':
      return '/Reminders';
    case 'reminder_overdue_notices':
      return reminderPath(d.area, d.target_id);
    case 'supplier_band_drops':
      return id(d.record_id) ? `/Suppliers/${id(d.record_id)}?tab=performance` : '/Supplier-Quality/Watchlist';
    case 'integration_alerts':
      return id(d.connection_id) && id(d.run_id) ? `/Settings/Integrations/${id(d.connection_id)}/runs/${id(d.run_id)}` : '/Settings/Integrations';
    default:
      return null;
  }
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
/** One line, no control characters, bounded: used in the subject. */
const oneLine = (s: string, max: number) => {
  const clean = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
  link: string | null;
}

export function renderNotificationEmail(row: EmailRow, appBaseUrl: string | undefined): RenderedEmail {
  const title = oneLine(row.title, 150);
  const body = row.body ? oneLine(row.body, 600) : null;
  const org = oneLine(row.organisation_name, 120);
  const path = notificationPath(row.entity_type, row.entity_id, row.details);
  let link: string | null = null;
  if (path && appBaseUrl) {
    try {
      link = new URL(path, appBaseUrl).toString();
    } catch {
      link = null;
    }
  }
  const settings = appBaseUrl ? (() => { try { return new URL('/Settings/Notifications', appBaseUrl).toString(); } catch { return null; } })() : null;
  const greeting = str(row.recipient_name) ? `Hello ${oneLine(row.recipient_name!, 80)},` : 'Hello,';
  const subject = oneLine(`${title}${body ? ` — ${body}` : ''}`, 180);
  const when = new Date(row.created_at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

  const text = [
    greeting,
    '',
    `${title} in ${org}.`,
    ...(body ? ['', body] : []),
    '',
    link ? `Open it in Fortress QMS: ${link}` : 'Open Fortress QMS to see it.',
    '',
    `— Fortress QMS, ${when}`,
    settings ? `You get this email because of your notification settings: ${settings}` : 'You get this email because of your notification settings in Fortress QMS.',
  ].join('\n');

  const h = escapeHtml;
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2937">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;border:1px solid #e5e7eb">
<tr><td style="padding:20px 24px;border-bottom:1px solid #e5e7eb;font-weight:600;color:#1d4ed8">Fortress QMS · ${h(org)}</td></tr>
<tr><td style="padding:24px">
<p style="margin:0 0 12px">${h(greeting)}</p>
<p style="margin:0 0 8px;font-size:17px;font-weight:600">${h(title)}</p>
${body ? `<p style="margin:0 0 16px;color:#374151">${h(body)}</p>` : ''}
${link ? `<p style="margin:20px 0"><a href="${h(link)}" style="display:inline-block;background:#1d4ed8;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:6px">Open in Fortress QMS</a></p>` : '<p style="margin:20px 0">Open Fortress QMS to see it.</p>'}
</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280">${h(when)} · You get this email because of your ${settings ? `<a href="${h(settings)}" style="color:#6b7280">notification settings</a>` : 'notification settings'}.</td></tr>
</table></body></html>`;

  return { subject, text, html, link };
}
