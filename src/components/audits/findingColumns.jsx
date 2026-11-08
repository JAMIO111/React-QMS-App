import { Link } from "react-router-dom";
import { CalendarIcon, CircleCheckIcon, ClipboardListIcon, HashIcon, TagIcon, TriangleAlertIcon, UserIcon } from "@/components/icons";
import { formatDate, ncrPath } from "../../lib/ncr";
import { FINDING_KIND_PILL, FINDING_STATUS_PILL, findingStatusLabel } from "../../lib/audits";

/** Audit findings register columns. `meta.sortKey` is the API sort field; columns without one cannot be sorted (the register is sorted and paged on the server). */
const head = (Icon, label, cls = "table-header") => (
  <div className={cls}>
    {Icon && <Icon className="shrink-0" />} {label}
  </div>
);
const col = (id, headerString, header, cell, { size = 140, minSize = 70, maxSize = 600, sortKey, align, accessor } = {}) => ({
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

export const findingColumns = [
  col(
    "reference",
    "Finding",
    head(HashIcon, "Finding"),
    (i) => (
      <Link to={`/Documentation/Audit-Findings/${i.row.original.id}`} className="table-row-item font-medium text-link-color hover:underline" onClick={(e) => e.stopPropagation()}>
        {i.row.original.reference}
      </Link>
    ),
    { size: 120, sortKey: "reference" }
  ),
  col("title", "Title", head(ClipboardListIcon, "Title"), plain((r) => r.title), { size: 300, minSize: 120, sortKey: "title" }),
  col("classification", "Classification", head(TagIcon, "Classification"), (i) => pill(FINDING_KIND_PILL[i.row.original.classification.kind], i.row.original.classification.label), {
    size: 190,
    sortKey: "classification",
    accessor: (r) => r.classification.label,
  }),
  col(
    "record",
    "Audit record",
    head(ClipboardListIcon, "Audit record"),
    (i) => (
      <Link to={`/Documentation/Audit-Records/${i.row.original.record.id}`} className="table-row-item text-link-color hover:underline" onClick={(e) => e.stopPropagation()}>
        {i.row.original.record.reference} · {i.row.original.record.audit.title}
      </Link>
    ),
    { size: 240, minSize: 120, sortKey: "record", accessor: (r) => `${r.record.reference} ${r.record.audit.title}` }
  ),
  col("owner", "Owner", head(UserIcon, "Owner"), plain((r) => r.owner?.name), { size: 160, sortKey: "owner", accessor: (r) => r.owner?.name ?? "" }),
  col(
    "dueOn",
    "Due",
    head(CalendarIcon, "Due"),
    (i) => (
      <div className="table-row-item">
        {i.row.original.dueOn ? formatDate(i.row.original.dueOn) : "—"}
        {i.row.original.overdue && <TriangleAlertIcon className="ml-1 text-error-color" aria-label="Overdue" />}
      </div>
    ),
    { size: 130, sortKey: "dueOn", accessor: (r) => r.dueOn ?? "" }
  ),
  col(
    "ncr",
    "Non-conformance",
    head(null, "Non-conformance"),
    (i) =>
      i.row.original.ncr ? (
        <Link to={ncrPath(i.row.original.ncr.id)} className="table-row-item text-link-color hover:underline" onClick={(e) => e.stopPropagation()}>
          {i.row.original.ncr.reference}
        </Link>
      ) : (
        <span className="table-row-item text-secondary-text">—</span>
      ),
    { size: 150, accessor: (r) => r.ncr?.reference ?? "" }
  ),
  col("fileCount", "Files", head(null, "Files", "table-header-number"), (i) => <div className="table-row-item justify-end tabular-nums">{i.row.original.fileCount}</div>, { size: 80, align: "right" }),
  col("status", "Status", head(CircleCheckIcon, "Status", "table-header-number"), (i) => pill(FINDING_STATUS_PILL[i.row.original.status], findingStatusLabel(i.row.original.status)), {
    size: 120,
    sortKey: "status",
    align: "center",
  }),
];

export const DEFAULT_HIDDEN = { fileCount: false };
