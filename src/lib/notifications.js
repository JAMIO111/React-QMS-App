import { ncrPath } from "./ncr";
/** Where a notification leads, from its entity type and the ids stored in `details`. */
export function notificationLink(n) {
  const d = n.details ?? {};
  switch (n.entityType) {
    case "nonconformances":
      return d.deleted ? null : ncrPath(n.entityId);
    case "gauges":
      return `/Calibration/Gauges/${n.entityId}`;
    case "calibrations":
      return d.gauge_id ? `/Calibration/Gauges/${d.gauge_id}/calibrations/${n.entityId}` : null;
    case "inspection_records":
      return `/Inspections/${n.entityId}`;
    case "control_plans":
      return `/Process-Control/Plans/${n.entityId}`;
    case "control_plan_revisions":
      return d.control_plan_id ? `/Process-Control/Plans/${d.control_plan_id}/revisions/${n.entityId}` : null;
    case "quality_alert_recipients":
      return d.alert_id ? `/Documentation/Quality-Alerts/${d.alert_id}` : "/Documentation/My-Alerts";
    case "capa_actions":
      return "/CAPA/My-Actions";
    case "risks":
      return `/Risk/Register/${n.entityId}`;
    case "management_review_actions":
      return "/Management-Review/My-Actions";
    case "risk_actions":
      return d.risk_id ? `/Risk/Register/${d.risk_id}` : "/Risk/My-Work";
    case "competence_assessments":
      return "/Competence/Mine";
    case "document_change_requests":
      return d.document_id ? `/Documentation/Documents/${d.document_id}` : "/Documentation/Change-Requests";
    case "document_signoffs":
    case "document_recipients":
      return d.document_id && d.revision_id ? `/Documentation/Documents/${d.document_id}/revisions/${d.revision_id}` : "/Documentation/Documents";
    case "spc_alerts":
      return "/Process-Control/Alerts";
    case "parts":
      return `/Parts/${n.entityId}`;
    case "part_families":
      return `/Part-Families/${n.entityId}`;
    case "user_subscription_assignments":
    case "organisation_subscriptions":
    case "billing_invoices":
      return "/Settings/Subscription";
    case "organisation_users":
      return "/Settings/Users";
    case "integration_alerts":
      return d.connection_id && d.run_id ? `/Settings/Integrations/${d.connection_id}/runs/${d.run_id}` : "/Settings/Integrations";
    default:
      return null;
  }
}

export function timeAgo(iso, now = Date.now()) {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
