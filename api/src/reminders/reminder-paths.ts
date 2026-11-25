/**
 * Where a reminder leads in the web app (WK2), from its area and the record behind it. Built only from known areas and a UUID, so a link in an email can
 * never point anywhere else. Mirrored by `reminderPath` in src/lib/reminders.js.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const REMINDER_AREAS = [
  'capa_actions',
  'risk_actions',
  'risk_reviews',
  'review_actions',
  'ncr_containment',
  'audits',
  'gauges',
  'documents_to_read',
  'quality_alerts',
  'document_reviews',
  'scars',
  'competence',
  'msa_studies',
  'change_tasks',
  'change_signoffs',
  'fmea_actions',
  'fmea_reviews',
] as const;
export type ReminderArea = (typeof REMINDER_AREAS)[number];

export function reminderPath(area: unknown, targetId: unknown): string | null {
  const t = typeof targetId === 'string' && UUID.test(targetId) ? targetId : null;
  switch (area) {
    case 'capa_actions':
      return '/CAPA/My-Actions';
    case 'risk_actions':
    case 'risk_reviews':
      return t ? `/Risk/Register/${t}` : '/Risk/My-Work';
    case 'review_actions':
      return '/Management-Review/My-Actions';
    case 'ncr_containment':
      return t ? `/Non-Conformance/Register/${t}` : null;
    case 'audits':
      return t ? `/Audits/Templates/${t}` : '/Audits/Schedule';
    case 'gauges':
      return t ? `/Calibration/Gauges/${t}` : '/Calibration/Gauges';
    case 'documents_to_read':
      return '/Documentation/My-Documents';
    case 'quality_alerts':
      return t ? `/Documentation/Quality-Alerts/${t}` : '/Documentation/My-Alerts';
    case 'document_reviews':
      return t ? `/Documentation/Documents/${t}` : '/Documentation/Documents';
    case 'scars':
      return t ? `/Supplier-Quality/SCARs/${t}` : '/Supplier-Quality/SCARs';
    case 'competence':
      return '/Competence/Mine';
    case 'msa_studies':
      return t ? `/Calibration/Gauge-RR/${t}` : '/Calibration/Gauge-RR';
    case 'change_tasks':
    case 'change_signoffs':
      return t ? `/Change/${t}` : '/Change/Mine';
    case 'fmea_actions':
      return '/FMEA/My-Actions';
    case 'fmea_reviews':
      return t ? `/FMEA/${t}` : '/FMEA/Register';
    default:
      return null;
  }
}
