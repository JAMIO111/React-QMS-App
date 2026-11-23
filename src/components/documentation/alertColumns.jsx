import { Link } from "react-router-dom";
import { CalendarIcon, CircleAlertIcon, CircleCheckIcon, FileTextIcon, HashIcon, TagIcon, UsersIcon } from "@/components/icons";
import { categoryLabel, formatDay, referenceText } from "../../lib/qualityAlerts";
import { SeverityBadge, StatusPill } from "./shared";

/**
 * Quality alert register columns. `meta.sortKey` is the API sort field (the register is sorted and paged on the server); `headerString` names
 * the column in the show / hide menu. The acknowledgement column is for people who manage documentation (the API sends `progress` to no one else).
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

const day = (key) => (i) => <div className="table-row-item whitespace-nowrap">{formatDay(i.row.original[key])}</div>;
const moment = (key) => (i) => <div className="table-row-item whitespace-nowrap">{formatDay(i.row.original[key]?.slice(0, 10))}</div>;

export const alertHref = (a) => `/Documentation/Quality-Alerts/${a.id}`;

export const alertColumns = ({ manage = false } = {}) => [
  col(
    "reference",
    "Alert",
    head(HashIcon, "Alert"),
    (i) => (
      <Link to={alertHref(i.row.original)} className="table-row-item font-medium text-link-color hover:underline" onClick={(e) => e.stopPropagation()}>
        {referenceText(i.row.original)}
      </Link>
    ),
    { size: 150, sortKey: "reference", accessor: (a) => a.reference }
  ),
  col("title", "Title", head(FileTextIcon, "Title"), (i) => <div className="table-row-item"><span className="block truncate">{i.row.original.title}</span></div>, { size: 340, minSize: 140, maxSize: 700, sortKey: "title" }),
  col("category", "Category", head(TagIcon, "Category"), (i) => <div className="table-row-item">{categoryLabel(i.row.original.category)}</div>, { size: 130, sortKey: "category", accessor: (a) => categoryLabel(a.category) }),
  col("severity", "Severity", head(CircleAlertIcon, "Severity"), (i) => <div className="table-row-item"><SeverityBadge severity={i.row.original.severity} /></div>, { size: 130, sortKey: "severity" }),
  col("status", "Status", head(CircleCheckIcon, "Status"), (i) => <div className="table-row-item"><StatusPill alert={i.row.original} /></div>, { size: 170, sortKey: "status" }),
  col("effectiveDate", "Effective", head(CalendarIcon, "Effective"), day("effectiveDate"), { size: 140, sortKey: "effectiveDate" }),
  col("expiryDate", "Expires", head(CalendarIcon, "Expires"), day("expiryDate"), { size: 140, sortKey: "expiryDate" }),
  col("acknowledgeBy", "Acknowledge by", head(CalendarIcon, "Acknowledge by"), day("acknowledgeBy"), { size: 150, sortKey: "acknowledgeBy" }),
  ...(manage
    ? [
        col(
          "progress",
          "Acknowledged",
          head(UsersIcon, "Acknowledged"),
          (i) => {
            const p = i.row.original.progress;
            return (
              <div className="table-row-item whitespace-nowrap">
                {p && p.total > 0 ? (
                  <span>
                    {p.acknowledged} of {p.total}
                    {p.overdue > 0 && <span className="ml-1 font-medium text-error-color">· {p.overdue} overdue</span>}
                  </span>
                ) : (
                  "—"
                )}
              </div>
            );
          },
          { size: 190, accessor: (a) => a.progress?.acknowledged ?? 0 }
        ),
      ]
    : []),
  col("issuedAt", "Issued", head(CalendarIcon, "Issued"), moment("issuedAt"), { size: 130, sortKey: "issuedAt" }),
  col("issuedBy", "Issued by", head(UsersIcon, "Issued by"), (i) => <div className="table-row-item">{i.row.original.issuedBy?.name ?? "—"}</div>, { size: 160, accessor: (a) => a.issuedBy?.name }),
  col("createdBy", "Drafted by", head(UsersIcon, "Drafted by"), (i) => <div className="table-row-item">{i.row.original.createdBy?.name ?? "—"}</div>, { size: 160, accessor: (a) => a.createdBy?.name }),
  col("updatedAt", "Updated", head(CalendarIcon, "Updated"), moment("updatedAt"), { size: 130, sortKey: "updatedAt" }),
];

/** Shown until a user changes the column set. */
export const DEFAULT_HIDDEN = { acknowledgeBy: false, issuedAt: false, issuedBy: false, createdBy: false, updatedAt: false };
