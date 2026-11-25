import { Link } from "react-router-dom";
import { CalendarIcon, CircleCheckIcon, FileTextIcon, HashIcon, LayersIcon, ListChecksIcon, ListTreeIcon, UsersIcon } from "@/components/icons";
import { REVISION_STATUS, formatDay, fmeaPath, kindLabel, statusLabel, statusPill } from "../../lib/fmea";

/**
 * FMEA register columns. `meta.sortKey` is the API sort field (the register is sorted and paged on the server); `headerString` names the column in the
 * show / hide menu.
 */
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

export const fmeaHref = (m) => fmeaPath(m.id);
const day = (value) => (value ? formatDay(value.slice(0, 10)) : "—");
const text = (value) => <div className="table-row-item"><span className="block truncate">{value || "—"}</span></div>;

export const fmeaColumns = [
  col(
    "number",
    "FMEA",
    head(HashIcon, "FMEA"),
    (i) => (
      <Link to={fmeaHref(i.row.original)} className="table-row-item font-medium text-link-color hover:underline" onClick={(e) => e.stopPropagation()}>
        {i.row.original.number}
      </Link>
    ),
    { size: 130, sortKey: "number" }
  ),
  col("title", "Title", head(FileTextIcon, "Title"), (i) => text(i.row.original.title), { size: 300, minSize: 140, maxSize: 700, sortKey: "title" }),
  col("kind", "Kind", head(ListTreeIcon, "Kind"), (i) => <div className="table-row-item whitespace-nowrap">{kindLabel(i.row.original.kind)}</div>, { size: 130, sortKey: "kind", accessor: (m) => kindLabel(m.kind) }),
  col("covers", "Covers", head(LayersIcon, "Covers"), (i) => text(i.row.original.covers), { size: 240, minSize: 120, maxSize: 600 }),
  col("customer", "Customer", head(UsersIcon, "Customer"), (i) => text(i.row.original.customer?.name), { size: 170, sortKey: "customer", accessor: (m) => m.customer?.name }),
  col("owner", "Owner", head(UsersIcon, "Owner"), (i) => text(i.row.original.owner?.name), { size: 160, sortKey: "owner", accessor: (m) => m.owner?.name }),
  col(
    "effective",
    "In force",
    head(CircleCheckIcon, "In force"),
    (i) => {
      const m = i.row.original;
      return <div className="table-row-item whitespace-nowrap">{m.currentLetter ? `Rev ${m.currentLetter} from ${day(m.currentEffectiveFrom)}` : "—"}</div>;
    },
    { size: 190, sortKey: "effective", accessor: (m) => m.currentEffectiveFrom }
  ),
  col(
    "openRevision",
    "Revision in progress",
    head(ListChecksIcon, "In progress"),
    (i) => {
      const m = i.row.original;
      return m.openRevisionId ? (
        <div className="table-row-item whitespace-nowrap">
          {m.openLetter ? `Rev ${m.openLetter}` : "Draft"} · {REVISION_STATUS[m.openStatus]?.label ?? m.openStatus}
        </div>
      ) : (
        <div className="table-row-item text-secondary-text">—</div>
      );
    },
    { size: 190, accessor: (m) => m.openStatus }
  ),
  col(
    "nextReview",
    "Next review",
    head(CalendarIcon, "Next review"),
    (i) => {
      const m = i.row.original;
      return <div className={`table-row-item whitespace-nowrap ${m.reviewOverdue ? "font-medium text-error-color" : ""}`}>{m.nextReviewOn ? `${day(m.nextReviewOn)}${m.reviewOverdue ? " (overdue)" : ""}` : "—"}</div>;
    },
    { size: 170, sortKey: "nextReview", accessor: (m) => m.nextReviewOn }
  ),
  col(
    "status",
    "Status",
    head(CircleCheckIcon, "Status"),
    (i) => {
      const m = i.row.original;
      return (
        <div className="table-row-item flex items-center gap-2">
          <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusPill(m.status)}`}>{statusLabel(m.status)}</span>
          {m.waitingForMe && <span className="inline-flex rounded-full bg-warning-color/15 px-2 py-0.5 text-xs font-medium text-warning-color">Waiting for you</span>}
        </div>
      );
    },
    { size: 190, sortKey: "status", accessor: (m) => m.status }
  ),
  col("updatedAt", "Updated", head(CalendarIcon, "Updated"), (i) => <div className="table-row-item whitespace-nowrap">{day(i.row.original.updatedAt)}</div>, { size: 130, sortKey: "updatedAt" }),
  col("createdAt", "Created", head(CalendarIcon, "Created"), (i) => <div className="table-row-item whitespace-nowrap">{day(i.row.original.createdAt)}</div>, { size: 130 }),
  col("scopeText", "Scope and intended use", head(FileTextIcon, "Scope"), (i) => text(i.row.original.scopeText), { size: 280, minSize: 120, maxSize: 700 }),
];

/** Shown until a person changes the column set. */
export const DEFAULT_HIDDEN = { createdAt: false, scopeText: false };
