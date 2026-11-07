import { CalendarIcon, CircleCheckIcon, FactoryIcon, HouseIcon, KeyRoundIcon, MailIcon, TagIcon, UserIcon, HashIcon } from "@/components/icons";
import { formatDate } from "../../lib/ncr";
import { ActiveBadge } from "./shared";

/**
 * Employees register columns. `meta.sortKey` is the API sort field; columns without one cannot be sorted (the register is sorted and paged on the server).
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

export const employeeColumns = [
  col(
    "name",
    "Name",
    head(UserIcon, "Name"),
    (i) => (
      <div className={`table-row-item font-medium ${i.row.original.active ? "" : "text-secondary-text"}`}>
        {i.row.original.name}
      </div>
    ),
    { size: 210, minSize: 120, maxSize: 500, sortKey: "name" }
  ),
  col("jobTitle", "Job title", head(TagIcon, "Job title"), plain((r) => r.jobTitle), { size: 180, sortKey: "jobTitle" }),
  col("employeeNumber", "Employee no.", head(HashIcon, "Employee no."), plain((r) => r.employeeNumber), { size: 130, sortKey: "employeeNumber" }),
  col("email", "Email", head(MailIcon, "Email"), plain((r) => r.email), { size: 230, minSize: 120, maxSize: 500, sortKey: "email" }),
  col("site", "Site", head(HouseIcon, "Site"), plain((r) => r.site?.name), { size: 150, sortKey: "site", accessor: (r) => r.site?.name }),
  col("department", "Department", head(FactoryIcon, "Department"), plain((r) => r.department?.name), { size: 160, sortKey: "department", accessor: (r) => r.department?.name }),
  col("status", "Status", head(CircleCheckIcon, "Status", "table-header-number"), (i) => <ActiveBadge active={i.row.original.active} />, { size: 110, sortKey: "status", align: "center", accessor: (r) => r.active }),
  col("hasLogin", "Sign-in", head(KeyRoundIcon, "Sign-in", "table-header-number"), (i) => <div className="table-row-item">{i.row.original.hasLogin ? "Yes" : "No"}</div>, { size: 100, align: "center", accessor: (r) => r.hasLogin }),
  col("createdAt", "Added", head(CalendarIcon, "Added"), (i) => <div className="table-row-item">{formatDate(i.getValue())}</div>, { size: 130, sortKey: "createdAt" }),
];

/** Shown until a user changes the column set. */
export const DEFAULT_HIDDEN = { hasLogin: false, createdAt: false };
