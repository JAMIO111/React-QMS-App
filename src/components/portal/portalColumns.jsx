import { Link } from "react-router-dom";
import { TriangleAlertIcon, CalendarIcon, CircleCheckIcon, ClipboardListIcon, FileTextIcon, FlaskConicalIcon, HashIcon, MessageSquarePlusIcon, PackageIcon, TagIcon } from "@/components/icons";
import { capaStage, scarPath, scarStatus, SCAR_SEVERITY, sharedPath, shareKindLabel, shortDate, waitingFor } from "../../lib/portal";
import { SEVERITIES, STAGES, stageOf, severityOf } from "../../lib/ncr";

/**
 * Column sets for the portal registers. Each column carries its own `accessorFn`, which is what the register sorts by and the cell shows by default, so
 * a column cannot sort differently from what it displays. Factories take the organisation so a reference links to the right portal.
 */
const head = (Icon, label, cls = "table-header") => (
  <div className={cls}>
    {Icon && <Icon className="shrink-0" />} {label}
  </div>
);

const col = (id, headerString, header, accessorFn, cell, { size = 140, minSize = 70, maxSize = 500, align } = {}) => ({
  id,
  headerString,
  header,
  accessorFn,
  cell,
  size,
  minSize,
  maxSize,
  enableSorting: true,
  meta: { sortKey: id, ...(align ? { align } : {}) },
});

const text = (fn) => (i) => <div className="table-row-item">{fn(i.row.original) || "—"}</div>;
const day = (fn) => (i) => <div className="table-row-item">{shortDate(fn(i.row.original)) || "—"}</div>;
const Pill = ({ tone, children }) => <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>{children}</span>;

const reference = (to) => (i) => {
  const r = i.row.original;
  return (
    // `.table-row-item` is a block that clips its text (it beats `flex` here), so the tag is spaced with its own margin.
    <div className="table-row-item">
      <Link to={to(r)} className="font-medium text-link-color hover:underline">{r.reference}</Link>
      {r.viewed === false && <span className="ml-2 inline-block align-middle"><Pill tone="bg-brand-primary/15 text-brand-primary">New</Pill></span>}
    </div>
  );
};

const conversation = (i) => {
  const r = i.row.original;
  return (
    <div className="table-row-item flex items-center gap-2">
      <span>{r.comments}</span>
      {r.newComments > 0 && <Pill tone="bg-warning-color/15 text-warning-color">{r.newComments} new</Pill>}
    </div>
  );
};
const waiting = (i) => {
  const w = waitingFor(i.row.original);
  return <div className="table-row-item">{w ? <Pill tone="bg-warning-color/15 text-warning-color">{w}</Pill> : "—"}</div>;
};

// ---- Non-conformances ----
export const ncrColumns = (organisationId) => [
  col("reference", "Reference", head(HashIcon, "Reference"), (r) => r.reference, reference((r) => sharedPath(r.id, organisationId)), { size: 170, minSize: 110 }),
  col("title", "Title", head(TagIcon, "Title"), (r) => r.title, text((r) => r.title), { size: 280, minSize: 140 }),
  col("stage", "Stage", head(CircleCheckIcon, "Stage"), (r) => stageOf(r.stage).label, (i) => {
    const s = stageOf(i.row.original.stage);
    return <div className="table-row-item"><Pill tone={s.tone}>{s.label}</Pill></div>;
  }, { size: 140 }),
  col("severity", "Severity", head(TriangleAlertIcon, "Severity"), (r) => ["critical", "major", "minor"].indexOf(r.severity), (i) => {
    const s = severityOf(i.row.original.severity);
    return <div className="table-row-item">{s ? <Pill tone={s.tone}>{s.label}</Pill> : "—"}</div>;
  }, { size: 120 }),
  col("detectedAt", "Detected", head(CalendarIcon, "Detected"), (r) => r.detectedAt, day((r) => r.detectedAt), { size: 130 }),
  col("part", "Part", head(PackageIcon, "Part"), (r) => r.partNumber, text((r) => [r.partNumber, r.partName].filter(Boolean).join(" · ")), { size: 200 }),
  col("lotNumber", "Lot", head(FlaskConicalIcon, "Lot"), (r) => r.lotNumber, text((r) => r.lotNumber), { size: 110 }),
  col("quantityAffected", "Qty affected", head(null, "Qty affected", "table-header-number"), (r) => r.quantityAffected, text((r) => (r.quantityAffected ?? "")), { size: 120, align: "right" }),
  col("customerReference", "Your reference", head(HashIcon, "Your reference"), (r) => r.customerReference, text((r) => r.customerReference), { size: 150 }),
  col("purchaseOrder", "Purchase order", head(HashIcon, "Purchase order"), (r) => r.purchaseOrder, text((r) => r.purchaseOrder), { size: 150 }),
  col("sharedAt", "Shared", head(CalendarIcon, "Shared"), (r) => r.sharedAt, day((r) => r.sharedAt), { size: 130 }),
  col("comments", "Conversation", head(MessageSquarePlusIcon, "Conversation"), (r) => r.comments, conversation, { size: 140 }),
  col("waiting", "Waiting for you", head(CircleCheckIcon, "Waiting for you"), (r) => waitingFor(r), waiting, { size: 160 }),
];
export const NCR_HIDDEN = { customerReference: false, purchaseOrder: false, sharedAt: false };

export const ncrFilters = [
  { type: "pills", key: "stage", label: "Stage", options: STAGES.filter((s) => s.key !== "draft").map((s) => ({ key: s.key, label: s.label })), value: (r) => r.stage },
  { type: "pills", key: "severity", label: "Severity", options: SEVERITIES.map((s) => ({ key: s.key, label: s.label })), value: (r) => r.severity },
  { type: "dates", key: "detected", label: "Detected", direction: "past", value: (r) => r.detectedAt },
  { type: "dates", key: "shared", label: "Shared", direction: "past", value: (r) => r.sharedAt },
  { type: "switch", key: "attention", label: "Needs my attention (new, new replies or waiting for me)", test: (r) => r.viewed === false || r.newComments > 0 || Boolean(waitingFor(r)) },
];
export const ncrSearch = (r) => [r.reference, r.title, r.partNumber, r.partName, r.lotNumber, r.customerReference, r.purchaseOrder].filter(Boolean).join(" ");
export const ncrCsv = (r) => ({
  reference: r.reference, title: r.title, stage: stageOf(r.stage).label, severity: severityOf(r.severity)?.label ?? "", detected: r.detectedAt ?? "",
  part_number: r.partNumber ?? "", part_name: r.partName ?? "", lot: r.lotNumber ?? "", quantity_affected: r.quantityAffected ?? "",
  your_reference: r.customerReference ?? "", purchase_order: r.purchaseOrder ?? "", shared: r.sharedAt ?? "", comments: r.comments,
});

// ---- Corrective action requests (suppliers) ----
export const scarColumns = (organisationId) => [
  col("reference", "Reference", head(HashIcon, "Reference"), (r) => r.reference, reference((r) => scarPath(r.id, organisationId)), { size: 170, minSize: 110 }),
  col("title", "Title", head(TagIcon, "Title"), (r) => r.title, text((r) => r.title), { size: 280, minSize: 140 }),
  col("status", "Status", head(CircleCheckIcon, "Status"), (r) => scarStatus(r.status).label, (i) => {
    const s = scarStatus(i.row.original.status);
    const tone = { warning: "bg-warning-color/15 text-warning-color", info: "bg-info-color/15 text-info-color", success: "bg-success-color/15 text-success-color", neutral: "bg-border-color text-secondary-text" }[s.tone];
    return <div className="table-row-item"><Pill tone={tone}>{s.label}</Pill></div>;
  }, { size: 220 }),
  col("severity", "Severity", head(TriangleAlertIcon, "Severity"), (r) => ["critical", "major", "minor"].indexOf(r.severity), text((r) => SCAR_SEVERITY[r.severity]), { size: 120 }),
  col("issuedAt", "Issued", head(CalendarIcon, "Issued"), (r) => r.issuedAt, day((r) => r.issuedAt), { size: 130 }),
  col("responseDueOn", "Response due", head(CalendarIcon, "Response due"), (r) => r.responseDueOn, (i) => {
    const r = i.row.original;
    return (
      <div className="table-row-item flex items-center gap-2">
        <span>{r.responseDueOn ? shortDate(`${r.responseDueOn}T12:00:00Z`) : "—"}</span>
        {r.overdue && <Pill tone="bg-error-color/15 text-error-color">Overdue</Pill>}
      </div>
    );
  }, { size: 170 }),
  col("responses", "Responses", head(ClipboardListIcon, "Responses", "table-header-number"), (r) => r.responses, text((r) => String(r.responses)), { size: 110, align: "right" }),
  col("openActions", "Actions to do", head(ClipboardListIcon, "Actions to do", "table-header-number"), (r) => r.openActions, (i) => {
    const r = i.row.original;
    return <div className="table-row-item flex items-center gap-2"><span>{r.openActions}</span>{r.lateActions > 0 && <Pill tone="bg-error-color/15 text-error-color">{r.lateActions} late</Pill>}</div>;
  }, { size: 140, align: "right" }),
  col("waiting", "Waiting for you", head(CircleCheckIcon, "Waiting for you"), (r) => waitingFor(r), waiting, { size: 160 }),
];
export const SCAR_HIDDEN = { issuedAt: false, responses: false };
export const scarFilters = [
  { type: "pills", key: "status", label: "Status", options: Object.entries({ issued: "Needs your response", acknowledged: "Acknowledged", response_received: "With us", under_review: "Being reviewed", revision_requested: "Revised response needed", accepted: "Accepted", verifying: "Being checked", closed: "Closed", cancelled: "Cancelled" }).map(([key, label]) => ({ key, label })), value: (r) => r.status },
  { type: "pills", key: "severity", label: "Severity", options: SEVERITIES.map((s) => ({ key: s.key, label: s.label })), value: (r) => r.severity },
  { type: "dates", key: "due", label: "Response due", direction: "future", value: (r) => r.responseDueOn },
  { type: "dates", key: "issued", label: "Issued", direction: "past", value: (r) => r.issuedAt },
  { type: "switch", key: "attention", label: "Needs a response or has actions to do", test: (r) => Boolean(waitingFor(r)) || r.overdue },
];
export const scarSearch = (r) => [r.reference, r.title].filter(Boolean).join(" ");
export const scarCsv = (r) => ({ reference: r.reference, title: r.title, status: scarStatus(r.status).label, severity: SCAR_SEVERITY[r.severity] ?? "", issued: r.issuedAt ?? "", response_due: r.responseDueOn ?? "", responses: r.responses, actions_to_do: r.openActions });

// ---- 8D reports (customers) ----
export const capaColumns = (organisationId) => [
  col("reference", "Reference", head(HashIcon, "Reference"), (r) => r.reference, reference((r) => sharedPath(r.id, organisationId)), { size: 170, minSize: 110 }),
  col("title", "Title", head(TagIcon, "Title"), (r) => r.title, text((r) => r.title), { size: 300, minSize: 140 }),
  col("stage", "Stage", head(CircleCheckIcon, "Stage"), (r) => capaStage(r.stage).label, (i) => {
    const s = capaStage(i.row.original.stage);
    return <div className="table-row-item"><Pill tone={s.tone}>{s.label}</Pill></div>;
  }, { size: 190 }),
  col("severity", "Severity", head(TriangleAlertIcon, "Severity"), (r) => ["critical", "major", "minor"].indexOf(r.severity), (i) => {
    const s = severityOf(i.row.original.severity);
    return <div className="table-row-item">{s ? <Pill tone={s.tone}>{s.label}</Pill> : "—"}</div>;
  }, { size: 120 }),
  col("startedAt", "Started", head(CalendarIcon, "Started"), (r) => r.startedAt, day((r) => r.startedAt), { size: 130 }),
  col("closedAt", "Closed", head(CalendarIcon, "Closed"), (r) => r.closedAt, day((r) => r.closedAt), { size: 130 }),
  col("sharedAt", "Shared", head(CalendarIcon, "Shared"), (r) => r.sharedAt, day((r) => r.sharedAt), { size: 130 }),
  col("comments", "Conversation", head(MessageSquarePlusIcon, "Conversation"), (r) => r.comments, conversation, { size: 140 }),
  col("waiting", "Waiting for you", head(CircleCheckIcon, "Waiting for you"), (r) => waitingFor(r), waiting, { size: 160 }),
];
export const CAPA_HIDDEN = { sharedAt: false };
export const capaFilters = [
  { type: "pills", key: "stage", label: "Stage", options: Object.entries({ open: "Open", actions_in_progress: "Actions in progress", awaiting_verification: "Awaiting verification", verified_effective: "Verified effective", closed: "Closed", cancelled: "Cancelled" }).map(([key, label]) => ({ key, label })), value: (r) => r.stage },
  { type: "pills", key: "severity", label: "Severity", options: SEVERITIES.map((s) => ({ key: s.key, label: s.label })), value: (r) => r.severity },
  { type: "dates", key: "started", label: "Started", direction: "past", value: (r) => r.startedAt },
  { type: "dates", key: "closed", label: "Closed", direction: "past", value: (r) => r.closedAt },
  { type: "switch", key: "attention", label: "Needs my attention (new, new replies or waiting for me)", test: (r) => r.viewed === false || r.newComments > 0 || Boolean(waitingFor(r)) },
];
export const capaSearch = (r) => [r.reference, r.title].filter(Boolean).join(" ");
export const capaCsv = (r) => ({ reference: r.reference, title: r.title, stage: capaStage(r.stage).label, severity: severityOf(r.severity)?.label ?? "", started: r.startedAt ?? "", closed: r.closedAt ?? "", shared: r.sharedAt ?? "", comments: r.comments });

// ---- Documents and quality alerts ----
export const documentColumns = (organisationId) => [
  col("reference", "Reference", head(HashIcon, "Reference"), (r) => r.reference, reference((r) => sharedPath(r.id, organisationId)), { size: 170, minSize: 110 }),
  col("title", "Title", head(FileTextIcon, "Title"), (r) => r.title, text((r) => r.title), { size: 320, minSize: 140 }),
  col("kind", "Type", head(TagIcon, "Type"), (r) => shareKindLabel(r.kind), text((r) => shareKindLabel(r.kind)), { size: 150 }),
  col("status", "Status", head(CircleCheckIcon, "Status"), (r) => r.status, text((r) => r.status?.replace(/_/g, " ")), { size: 130 }),
  col("sharedAt", "Shared", head(CalendarIcon, "Shared"), (r) => r.sharedAt, day((r) => r.sharedAt), { size: 130 }),
  col("comments", "Conversation", head(MessageSquarePlusIcon, "Conversation"), (r) => r.comments, conversation, { size: 140 }),
  col("waiting", "Waiting for you", head(CircleCheckIcon, "Waiting for you"), (r) => waitingFor(r), waiting, { size: 160 }),
];
export const DOCUMENT_HIDDEN = {};
export const documentFilters = [
  { type: "pills", key: "kind", label: "Type", options: [{ key: "document", label: "Document" }, { key: "quality_alert", label: "Quality alert" }], value: (r) => r.kind },
  { type: "dates", key: "shared", label: "Shared", direction: "past", value: (r) => r.sharedAt },
  { type: "switch", key: "attention", label: "Needs my attention (new, new replies or to acknowledge)", test: (r) => r.viewed === false || r.newComments > 0 || Boolean(waitingFor(r)) },
];
export const documentSearch = (r) => [r.reference, r.title].filter(Boolean).join(" ");
export const documentCsv = (r) => ({ reference: r.reference, title: r.title, type: shareKindLabel(r.kind), status: r.status ?? "", shared: r.sharedAt ?? "", comments: r.comments });
