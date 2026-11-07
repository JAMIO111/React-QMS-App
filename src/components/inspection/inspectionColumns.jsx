import { Link } from "react-router-dom";
import { CalendarIcon, CircleAlertIcon, CircleCheckIcon, ClipboardCheckIcon, FactoryIcon, HashIcon, HouseIcon, ListChecksIcon, QrCodeIcon, TagIcon, UsersIcon, WrenchIcon } from "@/components/icons";
import { TRIGGER_LABEL } from "../../lib/inspection";
import { formatDateTime } from "../../lib/processControl";
import { ResultBadge, StatusPill } from "./shared";

/**
 * In-process inspection register columns. `meta.sortKey` is the API sort field; columns without one cannot be
 * sorted (the register is sorted and paged on the server).
 */
const head = (Icon, label, cls = "table-header") => (
  <div className={cls}>
    {Icon && <Icon className="shrink-0" />} {label}
  </div>
);

const col = (id, headerString, header, cell, { size = 140, minSize = 70, maxSize = 400, sortKey, align, accessor } = {}) => ({
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

const plain = (fn) => (info) => <div className="table-row-item">{fn(info.row.original) || "—"}</div>;

export const inspectionColumns = [
  col(
    "reference",
    "Inspection",
    head(ClipboardCheckIcon, "Inspection"),
    (i) => (
      <Link to={`/Inspections/${i.row.original.id}`} className="table-row-item font-medium text-link-color hover:underline" onClick={(e) => e.stopPropagation()}>
        {i.row.original.reference}
      </Link>
    ),
    { size: 140, sortKey: "reference" }
  ),
  col(
    "part",
    "Part",
    head(QrCodeIcon, "Part"),
    (i) => (
      <div className="table-row-item">
        {i.row.original.part.partNumber} <span className="text-secondary-text">rev {i.row.original.partRevision}</span>
      </div>
    ),
    { size: 200, minSize: 110, maxSize: 500, sortKey: "part", accessor: (r) => r.part.partNumber }
  ),
  col("operation", "Operation", head(HashIcon, "Operation"), (i) => <div className="table-row-item font-mono">{i.row.original.operationCode ?? "All"}</div>, {
    size: 110,
    sortKey: "operation",
    accessor: (r) => r.operationCode,
  }),
  col(
    "plan",
    "Control plan",
    head(ListChecksIcon, "Control plan"),
    (i) => (
      <div className="table-row-item">
        {i.row.original.plan.planCode} <span className="text-secondary-text">rev {i.row.original.plan.revisionCode}</span>
      </div>
    ),
    { size: 160, sortKey: "plan", accessor: (r) => r.plan.planCode }
  ),
  col("context", "Work order / lot", head(TagIcon, "Work order / lot"), plain((r) => [r.workOrder, r.lot, r.serial].filter(Boolean).join(" · ")), {
    size: 180,
    sortKey: "context",
    accessor: (r) => r.workOrder,
  }),
  col("trigger", "Trigger", head(WrenchIcon, "Trigger"), plain((r) => TRIGGER_LABEL[r.triggerType]), { size: 140, sortKey: "trigger", accessor: (r) => r.triggerType }),
  col("status", "Status", head(CircleCheckIcon, "Status", "table-header-number"), (i) => <StatusPill status={i.row.original.status} />, { size: 130, sortKey: "status", align: "center" }),
  col(
    "result",
    "Result",
    head(CircleAlertIcon, "Result", "table-header-number"),
    (i) =>
      i.row.original.status === "in_progress" && i.row.original.failures ? (
        <div className="table-row-item text-xs text-error-color">{i.row.original.failures} failed so far</div>
      ) : (
        <ResultBadge result={i.row.original.result} />
      ),
    { size: 130, sortKey: "result", align: "center" }
  ),
  col("failures", "Failed readings", head(CircleAlertIcon, "Failed readings", "table-header-number"), (i) => <div className="table-row-item">{i.getValue()}</div>, {
    size: 130,
    sortKey: "failures",
    align: "center",
  }),
  col("startedAt", "Started", head(CalendarIcon, "Started"), (i) => <div className="table-row-item">{formatDateTime(i.getValue())}</div>, { size: 170, sortKey: "startedAt" }),
  col("operator", "Operator", head(UsersIcon, "Operator"), plain((r) => r.startedBy?.name), { size: 150, sortKey: "operator", accessor: (r) => r.startedBy?.name }),
  col("site", "Site", head(HouseIcon, "Site"), plain((r) => r.site?.name), { size: 140, sortKey: "site", accessor: (r) => r.site?.name }),
  col("machine", "Machine", head(FactoryIcon, "Machine"), plain((r) => (r.machine ? `${r.machine.code} · ${r.machine.name}` : "")), {
    size: 170,
    sortKey: "machine",
    accessor: (r) => r.machine?.code,
  }),
];

/** Shown until a user changes the column set. */
export const DEFAULT_HIDDEN = { failures: false, site: false, machine: false };
