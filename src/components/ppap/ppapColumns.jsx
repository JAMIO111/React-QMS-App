import { Link } from "react-router-dom";
import { BadgeCheckIcon, CalendarIcon, CircleCheckIcon, FileTextIcon, HashIcon, ListChecksIcon, QrCodeIcon, UsersIcon } from "@/components/icons";
import { formatDay, ppapPath, progressWords, reasonLabel, statusLabel, statusPill } from "../../lib/ppap";

/**
 * PPAP register columns. `meta.sortKey` is the API sort field (the register is sorted and paged on the server); `headerString` names the column in the show / hide menu.
 */
const head = (Icon, label) => (
  <div className="table-header">
    {Icon && <Icon className="shrink-0" />} {label}
  </div>
);

const col = (id, headerString, header, cell, { size = 140, minSize = 70, maxSize = 600, sortKey, accessor } = {}) => ({
  id,
  headerString,
  header,
  cell,
  ...(accessor ? { accessorFn: accessor } : { accessorKey: id }),
  size,
  minSize,
  maxSize,
  enableSorting: !!sortKey,
  meta: { sortKey },
});

export const ppapHref = (p) => ppapPath(p.id);
const day = (value) => (value ? formatDay(value.slice(0, 10)) : "—");
const text = (value) => <div className="table-row-item"><span className="block truncate">{value || "—"}</span></div>;
const partWords = (p) => [p.part?.partNumber, p.part?.name].filter(Boolean).join(" · ");

export const ppapColumns = [
  col(
    "reference",
    "Submission",
    head(HashIcon, "Submission"),
    (i) => (
      <Link to={ppapHref(i.row.original)} className="table-row-item font-medium text-link-color hover:underline" onClick={(e) => e.stopPropagation()}>
        {i.row.original.reference}
      </Link>
    ),
    { size: 140, sortKey: "reference" }
  ),
  col("part", "Part", head(QrCodeIcon, "Part"), (i) => text(partWords(i.row.original)), { size: 260, minSize: 120, maxSize: 600, sortKey: "part", accessor: partWords }),
  col("revision", "Revision", head(FileTextIcon, "Revision"), (i) => <div className="table-row-item whitespace-nowrap">{i.row.original.partRevision?.label ?? "—"}</div>, { size: 100, accessor: (p) => p.partRevision?.label }),
  col("customer", "Customer", head(UsersIcon, "Customer"), (i) => text(i.row.original.customer?.name), { size: 180, sortKey: "customer", accessor: (p) => p.customer?.name }),
  col("level", "Level", head(BadgeCheckIcon, "Level"), (i) => <div className="table-row-item whitespace-nowrap">Level {i.row.original.level}</div>, { size: 90, sortKey: "level" }),
  col("reason", "Reason", head(FileTextIcon, "Reason"), (i) => text(reasonLabel(i.row.original.reason)), { size: 220, accessor: (p) => reasonLabel(p.reason) }),
  col(
    "progress",
    "Progress",
    head(ListChecksIcon, "Progress"),
    (i) => <div className="table-row-item whitespace-nowrap">{progressWords(i.row.original.progress)}</div>,
    { size: 230, sortKey: "progress", accessor: (p) => p.progress?.done }
  ),
  col(
    "status",
    "Status",
    head(CircleCheckIcon, "Status"),
    (i) => (
      <div className="table-row-item">
        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusPill(i.row.original.status)}`}>{statusLabel(i.row.original.status)}</span>
      </div>
    ),
    { size: 160, sortKey: "status", accessor: (p) => p.status }
  ),
  col("owner", "Owner", head(UsersIcon, "Owner"), (i) => text(i.row.original.owner?.name), { size: 160, sortKey: "owner", accessor: (p) => p.owner?.name }),
  col("updatedAt", "Updated", head(CalendarIcon, "Updated"), (i) => <div className="table-row-item whitespace-nowrap">{day(i.row.original.updatedAt)}</div>, { size: 130, sortKey: "updatedAt" }),
  col("createdAt", "Created", head(CalendarIcon, "Created"), (i) => <div className="table-row-item whitespace-nowrap">{day(i.row.original.createdAt)}</div>, { size: 130 }),
  col("notes", "Notes", head(FileTextIcon, "Notes"), (i) => text(i.row.original.notes), { size: 280, minSize: 120, maxSize: 700 }),
];

/** Shown until a person changes the column set. */
export const DEFAULT_HIDDEN = { createdAt: false, notes: false };
