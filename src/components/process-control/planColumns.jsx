import { Link } from "react-router-dom";
import { CalendarIcon, CircleCheckIcon, FileTextIcon, HashIcon, LayersIcon, ListChecksIcon, UsersIcon } from "@/components/icons";
import { ActiveBadge } from "../master-data/shared";
import { RevisionStatusPill } from "./shared";
import { formatDay } from "../../lib/qualityAlerts";

/**
 * Control plan register columns. `meta.sortKey` is the API sort field (the register is sorted and paged on the server); `headerString` names the
 * column in the show / hide menu.
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

export const planHref = (p) => `/Process-Control/Plans/${p.id}`;
const day = (value) => formatDay(value?.slice(0, 10));

export const planColumns = [
  col(
    "planCode",
    "Plan",
    head(HashIcon, "Plan"),
    (i) => (
      <Link to={planHref(i.row.original)} className="table-row-item font-medium text-link-color hover:underline" onClick={(e) => e.stopPropagation()}>
        {i.row.original.planCode}
      </Link>
    ),
    { size: 160, sortKey: "planCode" }
  ),
  col("title", "Title", head(FileTextIcon, "Title"), (i) => <div className="table-row-item"><span className="block truncate">{i.row.original.title}</span></div>, { size: 320, minSize: 140, maxSize: 700, sortKey: "title" }),
  col(
    "scope",
    "Scope",
    head(LayersIcon, "Scope"),
    (i) => {
      const scope = [...i.row.original.families, ...(i.row.original.parts ?? [])];
      return <div className="table-row-item"><span className="block truncate">{scope.length ? scope.join(", ") : "—"}</span></div>;
    },
    { size: 200, accessor: (p) => [...p.families, ...(p.parts ?? [])].join(", ") }
  ),
  col(
    "effectiveRevision",
    "Effective revision",
    head(CircleCheckIcon, "Effective", "table-header-number"),
    (i) => (i.row.original.effectiveRevision ? <span className="table-row-item font-mono">{i.row.original.effectiveRevision}</span> : <span className="table-row-item text-secondary-text">None</span>),
    { size: 120, sortKey: "effectiveRevision", align: "center" }
  ),
  col(
    "openRevision",
    "Revision in progress",
    head(ListChecksIcon, "In progress"),
    (i) => {
      const open = i.row.original.openRevision;
      return open ? (
        <span className="table-row-item">
          <span className="mr-2 font-mono">{open.revisionCode}</span>
          <RevisionStatusPill status={open.status} />
        </span>
      ) : (
        <span className="table-row-item text-secondary-text">—</span>
      );
    },
    { size: 210, sortKey: "inProgress", accessor: (p) => p.openRevision?.status }
  ),
  col("owner", "Owner", head(UsersIcon, "Owner"), (i) => <div className="table-row-item">{i.row.original.owner?.name ?? "—"}</div>, { size: 160, sortKey: "owner", accessor: (p) => p.owner?.name }),
  col("active", "Status", head(CircleCheckIcon, "Status", "table-header-number"), (i) => <div className="table-row-item"><ActiveBadge active={i.row.original.active} /></div>, { size: 110, sortKey: "active", align: "center" }),
  col("updatedAt", "Updated", head(CalendarIcon, "Updated"), (i) => <div className="table-row-item whitespace-nowrap">{day(i.row.original.updatedAt)}</div>, { size: 130, sortKey: "updatedAt" }),
  col("createdAt", "Created", head(CalendarIcon, "Created"), (i) => <div className="table-row-item whitespace-nowrap">{day(i.row.original.createdAt)}</div>, { size: 130, sortKey: "createdAt" }),
  col("description", "Description", head(FileTextIcon, "Description"), (i) => <div className="table-row-item"><span className="block truncate">{i.row.original.description ?? "—"}</span></div>, { size: 260, minSize: 120, maxSize: 700 }),
];

/** Shown until a user changes the column set. */
export const DEFAULT_HIDDEN = { createdAt: false, description: false };
