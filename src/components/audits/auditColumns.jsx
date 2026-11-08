import { Link } from "react-router-dom";
import { CalendarIcon, CircleCheckIcon, ClipboardListIcon, FactoryIcon, HashIcon, ListChecksIcon, TagIcon, UsersIcon } from "@/components/icons";
import { auditTypeLabel, auditorLabel, frequencyLabel } from "../../lib/audits";

/** Audits register columns. `meta.sortKey` is the API sort field; columns without one cannot be sorted (the register is sorted and paged on the server). */
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

const relevant = (t) => {
  if (!t.machines && !t.operations && !t.departments) return null;
  const parts = [t.machines && `${t.machines} ${t.machines === 1 ? "machine" : "machines"}`, t.operations && `${t.operations} ${t.operations === 1 ? "operation" : "operations"}`, t.departments && `${t.departments} ${t.departments === 1 ? "department" : "departments"}`];
  return `${parts.filter(Boolean).join(", ")}${t.preview.length ? ` (${t.preview.join(", ")}${t.machines + t.operations + t.departments > t.preview.length ? "…" : ""})` : ""}`;
};

const STATUS = { active: "bg-success-color/15 text-success-color", retired: "bg-border-color text-secondary-text" };

export const auditColumns = [
  col(
    "reference",
    "Audit",
    head(HashIcon, "Audit"),
    (i) => (
      <Link to={`/Documentation/Audits/${i.row.original.id}`} className="table-row-item font-medium text-link-color hover:underline" onClick={(e) => e.stopPropagation()}>
        {i.row.original.reference}
      </Link>
    ),
    { size: 110, sortKey: "reference" }
  ),
  col("title", "Title", head(ClipboardListIcon, "Title"), plain((r) => r.title), { size: 280, minSize: 120, sortKey: "title" }),
  col("auditType", "Type", head(TagIcon, "Type"), plain((r) => auditTypeLabel(r.auditType)), { size: 170, sortKey: "type" }),
  col("targets", "Relevant to", head(FactoryIcon, "Relevant to"), plain((r) => relevant(r.targets)), { size: 280, minSize: 120, accessor: (r) => relevant(r.targets) }),
  col("frequency", "Frequency", head(CalendarIcon, "Frequency"), plain((r) => frequencyLabel(r.frequency)), { size: 150, sortKey: "frequency", accessor: (r) => frequencyLabel(r.frequency) }),
  col("auditor", "Expected auditor", head(UsersIcon, "Expected auditor"), plain((r) => (r.auditor.kind === "none" ? null : r.auditor.name)), { size: 190, accessor: (r) => auditorLabel(r.auditor) }),
  col("questionCount", "Questions", head(ListChecksIcon, "Questions", "table-header-number"), (i) => <div className="table-row-item justify-end tabular-nums">{i.row.original.questionCount}{i.row.original.criticalCount ? <span className="ml-1 text-xs text-secondary-text">({i.row.original.criticalCount} critical)</span> : null}</div>, { size: 150, align: "right" }),
  col(
    "status",
    "Status",
    head(CircleCheckIcon, "Status", "table-header-number"),
    (i) => <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${STATUS[i.row.original.status]}`}>{i.row.original.status === "active" ? "Active" : "Retired"}</span>,
    { size: 110, sortKey: "status", align: "center" }
  ),
];

/** Shown until a user changes the column set. */
export const DEFAULT_HIDDEN = {};
