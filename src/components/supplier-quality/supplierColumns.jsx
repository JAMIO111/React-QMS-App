import { Link } from "react-router-dom";
import { BuildingIcon, CalendarIcon, CircleAlertIcon, CircleCheckIcon, HashIcon, MapPinIcon, TagsIcon, TriangleAlertIcon, UsersIcon } from "@/components/icons";
import { typeLabel } from "../../lib/supplierQuality";
import { formatDate } from "../../lib/ncr";
import { ActivityBadge, ApprovalPill, RiskBadge } from "./SupplierBadges";

/** Supplier register columns. `meta.sortKey` is the API sort field (the register is sorted and paged on the server). */
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

export const supplierColumns = [
  col(
    "code",
    "Code",
    head(HashIcon, "Code"),
    (i) => (
      <Link to={`/Suppliers/${i.row.original.id}`} className="table-row-item font-medium text-link-color hover:underline" onClick={(e) => e.stopPropagation()}>
        {i.row.original.code}
      </Link>
    ),
    { size: 120, sortKey: "code" }
  ),
  col(
    "name",
    "Supplier",
    head(BuildingIcon, "Supplier"),
    (i) => (
      <div className="table-row-item flex-col items-start">
        <span className="truncate">{i.row.original.name}</span>
        {i.row.original.displayName && <span className="truncate text-xs text-secondary-text">{i.row.original.displayName}</span>}
      </div>
    ),
    { size: 260, minSize: 120, maxSize: 600, sortKey: "name" }
  ),
  col("approvalStatus", "Approval", head(CircleCheckIcon, "Approval", "table-header-number"), (i) => <ApprovalPill status={i.row.original.approvalStatus} />, { size: 170, sortKey: "approvalStatus", align: "center" }),
  col("active", "Activity", head(CircleCheckIcon, "Activity", "table-header-number"), (i) => <ActivityBadge active={i.row.original.active} />, { size: 100, align: "center" }),
  col("supplierType", "Type", head(TagsIcon, "Type"), plain((r) => typeLabel(r.supplierType)), { size: 160, sortKey: "supplierType" }),
  col(
    "classifications",
    "Classifications",
    head(TagsIcon, "Classifications"),
    (i) => (
      <div className="table-row-item flex-wrap gap-1">
        {i.row.original.classifications.length === 0 && <span className="text-secondary-text">—</span>}
        {i.row.original.classifications.map((c) => (
          <span key={c.id} className="rounded-full border border-border-color bg-secondary-bg px-2 py-0.5 text-xs text-secondary-text">
            {c.label}
          </span>
        ))}
      </div>
    ),
    { size: 240, minSize: 120, maxSize: 600 }
  ),
  col("riskRating", "Risk", head(TriangleAlertIcon, "Risk", "table-header-number"), (i) => <RiskBadge risk={i.row.original.riskRating} />, { size: 150, minSize: 130, sortKey: "riskRating", align: "center" }),
  col("country", "Location", head(MapPinIcon, "Location"), plain((r) => [r.city, r.country].filter(Boolean).join(", ")), { size: 160, sortKey: "country" }),
  col(
    "primaryContact",
    "Primary contact",
    head(UsersIcon, "Primary contact"),
    (i) => {
      const c = i.row.original.primaryContact;
      return (
        <div className="table-row-item flex-col items-start">
          <span className="truncate">{c?.name ?? "—"}</span>
          {c?.email && <span className="truncate text-xs text-secondary-text">{c.email}</span>}
        </div>
      );
    },
    { size: 200 }
  ),
  col(
    "openNcCount",
    "Open NCs",
    head(CircleAlertIcon, "Open NCs", "table-header-number"),
    (i) => {
      const r = i.row.original;
      return r.openNcCount ? (
        <Link to={`/Non-Conformance/Register?supplier=${r.id}&supplierLabel=${encodeURIComponent(r.displayName || r.name)}`} className="table-row-item tabular-nums text-link-color hover:underline" onClick={(e) => e.stopPropagation()}>
          {r.openNcCount}
        </Link>
      ) : (
        <div className="table-row-item tabular-nums text-secondary-text">0</div>
      );
    },
    { size: 100, sortKey: "openNcs", align: "center" }
  ),
  col("createdAt", "Added", head(CalendarIcon, "Added"), (i) => <div className="table-row-item whitespace-nowrap">{formatDate(i.row.original.createdAt?.slice(0, 10))}</div>, { size: 130, sortKey: "createdAt" }),
];

/** Shown until a user changes the column set. */
export const DEFAULT_HIDDEN = { primaryContact: false, createdAt: false, active: false };
