import { Link } from "react-router-dom";
import { CalendarIcon, CircleCheckIcon, ClipboardListIcon, FactoryIcon, HashIcon, ShieldCheckIcon, UsersIcon } from "@/components/icons";
import { formatDate } from "../../lib/ncr";
import { formatScore, RESULT_PILL, recordStatusLabel, resultLabel, STATUS_PILL } from "../../lib/audits";

/** Audit records register columns. `meta.sortKey` is the API sort field; columns without one cannot be sorted (the register is sorted and paged on the server). */
const head = (Icon, label, cls = "table-header") => (
  <div className={cls}>
    {Icon && <Icon className="shrink-0" />} {label}
  </div>
);
const col = (id, headerString, header, cell, { size = 140, minSize = 70, maxSize = 500, sortKey, align, accessor } = {}) => ({
  id,
  headerString,
  header,
  cell,
  ...(accessor ? { accessorFn: accessor } : { accessorKey: id }),
  size,
  minSize,
  maxSize,
  enableSorting: !!sortKey,
  meta: { sortKey, ...(align ? { align } : {}) },
});
const plain = (fn) => (info) => <div className="table-row-item">{fn(info.row.original) ?? "—"}</div>;
const pill = (cls, text) => <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{text}</span>;

export const auditRecordColumns = [
  col(
    "reference",
    "Record",
    head(HashIcon, "Record"),
    (i) => (
      <Link to={`/Documentation/Audit-Records/${i.row.original.id}`} className="table-row-item font-medium text-link-color hover:underline" onClick={(e) => e.stopPropagation()}>
        {i.row.original.reference}
      </Link>
    ),
    { size: 120, sortKey: "reference" }
  ),
  col("audit", "Audit", head(ClipboardListIcon, "Audit"), plain((r) => `${r.audit.reference} · ${r.audit.title}`), { size: 280, minSize: 120, sortKey: "audit", accessor: (r) => `${r.audit.reference} ${r.audit.title}` }),
  col("carriedOutOn", "Carried out on", head(FactoryIcon, "Carried out on"), plain((r) => r.carriedOutOn.join(", ") || null), { size: 260, minSize: 120, accessor: (r) => r.carriedOutOn.join(", ") }),
  col("auditor", "Auditor", head(UsersIcon, "Auditor"), plain((r) => r.auditor?.name), { size: 170, accessor: (r) => r.auditor?.name ?? "" }),
  col("scheduledFor", "Scheduled for", head(CalendarIcon, "Scheduled for"), plain((r) => (r.scheduledFor ? formatDate(r.scheduledFor) : "Unscheduled")), { size: 140, accessor: (r) => r.scheduledFor ?? "" }),
  col("performedOn", "Carried out", head(CalendarIcon, "Carried out"), plain((r) => formatDate(r.performedOn)), { size: 130, sortKey: "performedOn" }),
  col("result", "Result", head(ShieldCheckIcon, "Result", "table-header-number"), (i) => (i.row.original.result ? pill(RESULT_PILL[i.row.original.result], resultLabel(i.row.original.result)) : <span className="table-row-item text-secondary-text">—</span>), { size: 100, sortKey: "result", align: "center" }),
  col("score", "Score", head(null, "Score", "table-header-number"), (i) => <div className="table-row-item justify-end tabular-nums">{formatScore(i.row.original.score)}</div>, { size: 90, sortKey: "score", align: "right" }),
  col(
    "failedCount",
    "Failed",
    head(null, "Failed", "table-header-number"),
    (i) => (
      <div className="table-row-item justify-end tabular-nums">
        {i.row.original.failedCount ?? "—"}
        {i.row.original.criticalFailedCount ? <span className="ml-1 text-xs text-error-color">({i.row.original.criticalFailedCount} critical)</span> : null}
      </div>
    ),
    { size: 140, align: "right" }
  ),
  col("status", "Status", head(CircleCheckIcon, "Status", "table-header-number"), (i) => pill(STATUS_PILL[i.row.original.status], recordStatusLabel(i.row.original.status)), { size: 120, sortKey: "status", align: "center" }),
];

export const DEFAULT_HIDDEN = {};
