import { Link } from "react-router-dom";
import { CalendarIcon, CircleAlertIcon, CircleCheckIcon, FileTextIcon, HashIcon, LinkIcon, ListChecksIcon, TagIcon, UsersIcon } from "@/components/icons";
import { SEVERITIES, SOURCES, capaHref, stepOf } from "../../lib/capa";
import { formatDay } from "../../lib/qualityAlerts";
import { StagePill, StepProgress } from "./shared";

/**
 * 8D register columns. `meta.sortKey` is the API sort field (the register is sorted and paged on the server); `headerString` names the
 * column in the show / hide menu.
 */
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

const plain = (fn) => (info) => <div className="table-row-item">{fn(info.row.original) || "—"}</div>;
const label = (list, id) => list.find((x) => x.id === id)?.name ?? id;

export const capaColumns = [
  col(
    "reference",
    "8D",
    head(HashIcon, "8D"),
    (i) => (
      <Link to={capaHref(i.row.original)} className="table-row-item font-medium text-link-color hover:underline" onClick={(e) => e.stopPropagation()}>
        {i.row.original.reference}
      </Link>
    ),
    { size: 140, sortKey: "reference" }
  ),
  col(
    "title",
    "Title",
    head(FileTextIcon, "Title"),
    (i) => (
      <div className="table-row-item flex-col items-start">
        <span className="truncate">{i.row.original.title}</span>
        {i.row.original.externalReference && <span className="truncate text-xs text-secondary-text">{i.row.original.externalReference}</span>}
      </div>
    ),
    { size: 320, minSize: 140, maxSize: 700, sortKey: "title" }
  ),
  col("stage", "Stage", head(CircleCheckIcon, "Stage", "table-header-number"), (i) => <StagePill stage={i.row.original.stage} />, { size: 180, sortKey: "stage", align: "center" }),
  col(
    "progress",
    "Progress",
    head(ListChecksIcon, "Progress"),
    (i) => {
      const c = i.row.original;
      return (
        <div className="table-row-item" title={stepOf(c.currentStep).title}>
          <StepProgress done={c.stepsDone} current={c.stage === "closed" || c.stage === "cancelled" ? null : c.currentStep} />
        </div>
      );
    },
    { size: 200, sortKey: "progress", accessor: (r) => r.stepsDone }
  ),
  col("owner", "Owner", head(UsersIcon, "Owner"), plain((r) => r.owner?.name), { size: 160, sortKey: "owner", accessor: (r) => r.owner?.name }),
  col(
    "dueDate",
    "Due",
    head(CalendarIcon, "Due"),
    (i) => {
      const c = i.row.original;
      return (
        <div className="table-row-item whitespace-nowrap">
          {formatDay(c.dueDate)}
          {c.overdue && <span className="ml-1 font-medium text-error-color">· Overdue</span>}
        </div>
      );
    },
    { size: 170, sortKey: "dueDate" }
  ),
  col("ncrCount", "Non-conformances", head(LinkIcon, "NCs", "table-header-number"), (i) => <div className="table-row-item tabular-nums">{i.getValue()}</div>, { size: 100, sortKey: "ncrCount", align: "center" }),
  col("severity", "Severity", head(CircleAlertIcon, "Severity"), plain((r) => (r.severity ? label(SEVERITIES, r.severity) : "")), { size: 120, sortKey: "severity" }),
  col("source", "Source", head(TagIcon, "Source"), plain((r) => label(SOURCES, r.source)), { size: 120, sortKey: "source" }),
  col("createdAt", "Started", head(CalendarIcon, "Started"), (i) => <div className="table-row-item whitespace-nowrap">{formatDay(i.row.original.createdAt?.slice(0, 10))}</div>, { size: 140, sortKey: "createdAt" }),
  col("closedAt", "Closed", head(CalendarIcon, "Closed"), (i) => <div className="table-row-item whitespace-nowrap">{i.row.original.closedAt ? formatDay(i.row.original.closedAt.slice(0, 10)) : "—"}</div>, { size: 140, sortKey: "closedAt" }),
];

/** Shown until a user changes the column set. */
export const DEFAULT_HIDDEN = { severity: false, source: false, createdAt: false, closedAt: false };
