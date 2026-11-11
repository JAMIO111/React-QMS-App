import {
  BoxesIcon,
  ChartNoAxesCombinedIcon,
  ClipboardCheckIcon,
  ClipboardListIcon,
  FileTextIcon,
  GaugeIcon,
  GraduationCapIcon,
  TriangleAlertIcon,
  TruckIcon,
} from "@/components/icons";
import { NCR_REGISTER } from "./ncr";
import { KINDS } from "./masterData";

/**
 * The home page's "needs attention" model. Every figure comes from a module's own dashboard (or register) answer, so the home page cannot
 * disagree with the module it points to. A line is `critical` (late, failed, quarantined: act now) or `warning` (waiting, or due soon).
 * Only lines with something to do are kept; a module with none is "all clear".
 */
const OPEN_NC_STAGES = "draft,open,contained,investigating,dispositioned,awaiting_closure";
const n = (value) => (Number.isFinite(value) ? value : 0);
const line = (key, label, count, tone, to) => ({ key, label, count: n(count), tone, to });
const plural = (count, one, many = `${one}s`) => (count === 1 ? one : many);

/** The areas of the app the home page reports on, in the order they are shown, with the permission each needs. */
export const HOME_MODULES = [
  { key: "nc", label: "Non-conformance", icon: TriangleAlertIcon, to: "/Non-Conformance", permission: "ncr.read", period: "12m" },
  { key: "capa", label: "8D corrective actions", icon: ClipboardListIcon, to: "/CAPA", permission: "capa.read" },
  { key: "calibration", label: "Calibration", icon: GaugeIcon, to: "/Calibration", permission: "calibration.read", period: "12m" },
  { key: "processControl", label: "Process control", icon: ChartNoAxesCombinedIcon, to: "/Process-Control", permission: "process_control.read", period: "90d" },
  { key: "audits", label: "Audits", icon: ClipboardCheckIcon, to: "/Audits", permission: "audits.read", period: "90d" },
  { key: "documents", label: "Documents", icon: FileTextIcon, to: "/Documentation", permission: "documentation.read", period: "90d" },
  { key: "supplier", label: "Supplier quality", icon: TruckIcon, to: "/Supplier-Quality", permission: "supplier_quality.read", period: "90d" },
  { key: "competence", label: "Competence", icon: GraduationCapIcon, to: "/Competence", permission: "competence.read", period: "90d" },
  { key: "masterData", label: "Master data", icon: BoxesIcon, to: "/Master-Data", permission: "master_data.read" },
];

/** Per module: the headline figure and every line it could raise, from that module's answer. */
const READERS = {
  nc: (d) => {
    const k = d.kpis;
    const awaiting = d.byStage?.find((s) => s.key === "awaiting_closure")?.count;
    return {
      headline: { value: n(k.open), label: `open ${plural(n(k.open), "non-conformance")}` },
      lines: [
        line("critical", `Critical ${plural(n(k.criticalOpen), "non-conformance")} open`, k.criticalOpen, "critical", `${NCR_REGISTER}?stage=${OPEN_NC_STAGES}&severity=critical`),
        line("awaiting_closure", "Waiting to be closed", awaiting, "warning", `${NCR_REGISTER}?stage=awaiting_closure`),
      ],
    };
  },
  capa: (d) => ({
    headline: { value: n(d.running), label: `running ${plural(n(d.running), "8D")}` },
    lines: [
      line("overdue", `${plural(n(d.overdue), "8D")} past ${n(d.overdue) === 1 ? "its" : "their"} due date`, d.overdue, "critical", "/CAPA?overdue=true"),
      line("verification", "Waiting to be verified", d.awaitingVerification, "warning", "/CAPA?stage=awaiting_verification"),
    ],
  }),
  calibration: (d) => {
    const k = d.kpis;
    return {
      headline: { value: n(k.inUse), label: `${plural(n(k.inUse), "gauge")} in use` },
      lines: [
        line("overdue", `${plural(n(k.overdue), "Gauge")} overdue for calibration`, k.overdue, "critical", "/Calibration/Gauges?due=overdue"),
        line("quarantined", `${plural(n(k.quarantined), "Gauge")} quarantined`, k.quarantined, "critical", "/Calibration/Gauges?status=quarantined"),
        line("due30", "Due in the next 30 days", k.dueNext30, "warning", "/Calibration/Gauges?due=due_30"),
      ],
    };
  },
  processControl: (d) => {
    const k = d.kpis;
    return {
      headline: { value: n(k.inProgress), label: `${plural(n(k.inProgress), "inspection")} in progress` },
      lines: [
        line("failures", "Failed readings with no acknowledgement or NC", k.openFailures, "critical", "/Process-Control"),
        line("spc", `SPC ${plural(n(d.openSpcAlerts), "alert")} open`, d.openSpcAlerts, "critical", "/Process-Control/Alerts"),
        line("approval", `Plan ${plural(n(k.awaitingApproval), "revision")} waiting for approval`, k.awaitingApproval, "warning", "/Process-Control/Plans"),
      ],
    };
  },
  audits: (d) => {
    const k = d.kpis;
    return {
      headline: { value: n(k.openFindings), label: `open ${plural(n(k.openFindings), "finding")}` },
      lines: [
        line("overdue", `${plural(n(k.overdue), "Audit")} overdue`, k.overdue, "critical", "/Audits/Schedule?state=overdue"),
        line("findings", `${plural(n(k.overdueFindings), "Finding")} past ${n(k.overdueFindings) === 1 ? "its" : "their"} due date`, k.overdueFindings, "critical", "/Audits/Findings?overdue=true"),
        line("missed", `${plural(n(k.missed), "Audit")} missed in the last 90 days`, k.missed, "warning", "/Audits"),
      ],
    };
  },
  documents: (d) => {
    const k = d.kpis;
    const waiting = n(k.inReview) + n(k.awaitingApproval);
    return {
      headline: { value: n(k.inForce), label: `${plural(n(k.inForce), "document")} in force` },
      lines: [
        line("reviews", `Periodic ${plural(n(k.reviewsOverdue), "review")} overdue`, k.reviewsOverdue, "critical", "/Documentation/Documents?review=true"),
        line("readers", `${plural(n(k.readersOverdue), "Reader")} past the date to acknowledge`, k.readersOverdue, "critical", "/Documentation"),
        line("waiting", `${plural(waiting, "Revision")} with reviewers or approvers`, waiting, "warning", "/Documentation/Documents"),
        line("changes", `Change ${plural(n(k.changeRequestsOpen), "request")} open`, k.changeRequestsOpen, "warning", "/Documentation/Change-Requests"),
      ],
    };
  },
  supplier: (d) => {
    const k = d.kpis;
    const rec = d.receiving?.available ? d.receiving : null;
    return {
      headline: { value: n(k.suppliers), label: `${plural(n(k.suppliers), "supplier")} in use` },
      lines: [
        line("scars", `Corrective action ${plural(n(k.overdueScars), "response")} overdue`, k.overdueScars, "critical", "/Supplier-Quality/SCARs?filter=overdue"),
        line("expired", `${plural(n(k.expired), "Certificate or document", "Certificates or documents")} expired`, k.expired, "critical", "/Supplier-Quality/Expiry"),
        line("approvals", `Approval ${plural(n(k.approvalsWaiting), "proposal")} waiting for a decision`, k.approvalsWaiting, "warning", "/Supplier-Quality"),
        line("decisions", `Delivered ${plural(n(rec?.awaitingDecision), "line")} waiting for a decision`, rec?.awaitingDecision, "warning", "/Supplier-Quality/Goods-Receipts"),
        line("late", `Order ${plural(n(rec?.lateOrderLines), "line")} past the delivery date`, rec?.lateOrderLines, "warning", "/Supplier-Quality/Purchase-Orders?filter=late"),
        line("expiring", "Expiring within 60 days", k.expiring, "warning", "/Supplier-Quality/Expiry"),
        line("risk", `Risk ${plural(n(k.riskReviewsOverdue), "review")} overdue`, k.riskReviewsOverdue, "warning", "/Supplier-Quality"),
      ],
    };
  },
  competence: (d) => {
    const k = d.kpis;
    return {
      headline: { value: n(k.withGaps), label: `${plural(n(k.withGaps), "person", "people")} with a skill gap` },
      lines: [
        line("expired", `${plural(n(k.expired), "Assessment")} expired`, k.expired, "critical", "/Competence/Matrix?status=expired"),
        line("gaps", `${plural(n(k.gaps), "Skill")} short of what a position needs`, k.gaps, "warning", "/Competence/Matrix?status=gap"),
        line("expiring", "Expiring in the next 30 days", k.expiring30, "warning", "/Competence/Matrix?status=expiring"),
        line("never", `${plural(n(k.neverAssessed), "Person", "People")} never assessed`, k.neverAssessed, "warning", "/Competence"),
      ],
    };
  },
  masterData: (d) => {
    const checks = d.attention ?? [];
    const passing = checks.filter((c) => c.count === 0).length;
    return {
      headline: { value: `${passing} of ${checks.length}`, label: "data-quality checks pass" },
      lines: checks.map((c) => line(c.key, c.label, c.count, "warning", KINDS[c.kind]?.to ?? "/Master-Data")),
    };
  },
};

/**
 * What the home page shows for each module the person may read. `sources[key]` is `{ data, isLoading, error }`.
 * Returns one entry per allowed module: `{ …module, state: "loading" | "error" | "ready", headline, lines (only those with a count) }`.
 */
export const homeModules = (sources, can) =>
  HOME_MODULES.filter((m) => can(m.permission)).map((m) => {
    const source = sources[m.key] ?? {};
    if (source.error) return { ...m, state: "error", lines: [] };
    if (!source.data) return { ...m, state: "loading", lines: [] };
    const { headline, lines } = READERS[m.key](source.data);
    return { ...m, state: "ready", headline, lines: lines.filter((l) => l.count > 0) };
  });

/** The totals for the hero card: how many lines need attention, how many of them are critical, and the critical ones, most first. */
export const summarise = (modules) => {
  const all = modules.flatMap((m) => m.lines.map((l) => ({ ...l, module: m })));
  const critical = all.filter((l) => l.tone === "critical");
  return {
    total: all.length,
    critical: critical.length,
    warning: all.length - critical.length,
    areas: modules.filter((m) => m.lines.length > 0).length,
    clear: modules.filter((m) => m.state === "ready" && m.lines.length === 0).length,
    loading: modules.some((m) => m.state === "loading"),
    urgent: [...critical].sort((a, b) => b.count - a.count),
  };
};
