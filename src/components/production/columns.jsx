import { CalendarIcon, CircleCheckIcon, FactoryIcon, HashIcon, HouseIcon, LayersIcon, PackageIcon, TagIcon, UserIcon } from "@/components/icons";
import { Link } from "react-router-dom";
import { LOT_ORIGIN, LOT_STATUS, ORDER_STATUS, SERIAL_STATUS, partLabel, tracePath } from "../../lib/production";
import { formatDate } from "../../lib/ncr";
import { StatusBadge } from "./shared";

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
const plain = (fn) => (info) => <div className="table-row-item">{fn(info.row.original) ?? "—"}</div>;
const strong = (fn) => (info) => <div className="table-row-item font-medium">{fn(info.row.original)}</div>;
const date = (info) => <div className="table-row-item">{info.getValue() ? formatDate(info.getValue()) : "—"}</div>;
const number = (fn) => (info) => <div className="table-row-item justify-end tabular-nums">{fn(info.row.original)?.toLocaleString() ?? "—"}</div>;
const trace = (type) => (info) => (
  <Link to={tracePath(type, info.row.original.id)} className="table-row-item text-link-color hover:underline" onClick={(e) => e.stopPropagation()}>
    Trace
  </Link>
);
const badge = (map) => (info) => <StatusBadge map={map} status={info.getValue()} />;

export const orderColumns = [
  col("orderNumber", "Order", head(HashIcon, "Order"), strong((r) => r.orderNumber), { size: 150, minSize: 100, sortKey: "orderNumber" }),
  col("part", "Part", head(PackageIcon, "Part"), plain((r) => partLabel(r.part)), { size: 260, minSize: 120, maxSize: 500, sortKey: "part", accessor: (r) => partLabel(r.part) }),
  col("customer", "Customer", head(UserIcon, "Customer"), plain((r) => r.customer?.name), { size: 190, sortKey: "customer", accessor: (r) => r.customer?.name }),
  col("quantityPlanned", "Quantity", head(null, "Quantity", "table-header-number"), number((r) => r.quantityPlanned), { size: 110, sortKey: "quantityPlanned", align: "right" }),
  col("dueDate", "Due", head(CalendarIcon, "Due"), date, { size: 130, sortKey: "dueDate" }),
  col("status", "Status", head(CircleCheckIcon, "Status", "table-header-number"), badge(ORDER_STATUS), { size: 130, sortKey: "status", align: "center" }),
  col("site", "Site", head(HouseIcon, "Site"), plain((r) => r.site?.name), { size: 140, accessor: (r) => r.site?.name }),
  col("lotCount", "Lots", head(LayersIcon, "Lots", "table-header-number"), number((r) => r.lotCount), { size: 80, align: "right" }),
  col("serialCount", "Serials", head(TagIcon, "Serials", "table-header-number"), number((r) => r.serialCount), { size: 90, align: "right" }),
  col("createdAt", "Created", head(CalendarIcon, "Created"), date, { size: 130, sortKey: "createdAt" }),
  col("trace", "Trace", head(null, "Trace"), trace("order"), { size: 80, minSize: 70, maxSize: 120, accessor: () => "" }),
];
export const ORDER_HIDDEN = { site: false, lotCount: false, serialCount: false, createdAt: false };

export const lotColumns = [
  col("lotNumber", "Lot", head(HashIcon, "Lot"), strong((r) => r.lotNumber), { size: 150, minSize: 100, sortKey: "lotNumber" }),
  col("part", "Part", head(PackageIcon, "Part"), plain((r) => partLabel(r.part)), { size: 260, minSize: 120, maxSize: 500, sortKey: "part", accessor: (r) => partLabel(r.part) }),
  col("origin", "Origin", head(FactoryIcon, "Origin"), plain((r) => LOT_ORIGIN[r.origin]), { size: 110, sortKey: "origin" }),
  col("productionOrder", "Order", head(HashIcon, "Order"), plain((r) => r.productionOrder?.orderNumber), { size: 140, accessor: (r) => r.productionOrder?.orderNumber }),
  col("supplier", "Supplier", head(UserIcon, "Supplier"), plain((r) => r.supplier?.name), { size: 170, accessor: (r) => r.supplier?.name }),
  col("quantity", "Quantity", head(null, "Quantity", "table-header-number"), number((r) => r.quantity), { size: 110, sortKey: "quantity", align: "right" }),
  col("status", "Status", head(CircleCheckIcon, "Status", "table-header-number"), badge(LOT_STATUS), { size: 120, sortKey: "status", align: "center" }),
  col("serialCount", "Serials", head(TagIcon, "Serials", "table-header-number"), number((r) => r.serialCount), { size: 90, align: "right" }),
  col("site", "Site", head(HouseIcon, "Site"), plain((r) => r.site?.name), { size: 140, accessor: (r) => r.site?.name }),
  col("receivedOn", "Received", head(CalendarIcon, "Received"), date, { size: 130 }),
  col("createdAt", "Created", head(CalendarIcon, "Created"), date, { size: 130, sortKey: "createdAt" }),
  col("trace", "Trace", head(null, "Trace"), trace("lot"), { size: 80, minSize: 70, maxSize: 120, accessor: () => "" }),
];
export const LOT_HIDDEN = { site: false, receivedOn: false, createdAt: false };

export const serialColumns = [
  col("serialNumber", "Serial number", head(HashIcon, "Serial number"), strong((r) => r.serialNumber), { size: 170, minSize: 110, sortKey: "serialNumber" }),
  col("part", "Part", head(PackageIcon, "Part"), plain((r) => partLabel(r.part)), { size: 260, minSize: 120, maxSize: 500, sortKey: "part", accessor: (r) => partLabel(r.part) }),
  col("lot", "Lot", head(LayersIcon, "Lot"), plain((r) => r.lot?.lotNumber), { size: 140, sortKey: "lot", accessor: (r) => r.lot?.lotNumber }),
  col("productionOrder", "Order", head(HashIcon, "Order"), plain((r) => r.productionOrder?.orderNumber), { size: 140, accessor: (r) => r.productionOrder?.orderNumber }),
  col("status", "Status", head(CircleCheckIcon, "Status", "table-header-number"), badge(SERIAL_STATUS), { size: 140, sortKey: "status", align: "center" }),
  col("site", "Site", head(HouseIcon, "Site"), plain((r) => r.site?.name), { size: 140, accessor: (r) => r.site?.name }),
  col("createdAt", "Created", head(CalendarIcon, "Created"), date, { size: 130, sortKey: "createdAt" }),
  col("trace", "Trace", head(null, "Trace"), trace("serial"), { size: 80, minSize: 70, maxSize: 120, accessor: () => "" }),
];
export const SERIAL_HIDDEN = { site: false };
