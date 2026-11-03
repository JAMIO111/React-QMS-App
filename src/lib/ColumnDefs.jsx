import { AlignCenterIcon, BoxIcon, CalendarIcon, CircleDashedIcon, LayersIcon, QrCodeIcon, TagIcon, TriangleAlertIcon, UsersIcon } from "@/components/icons";
import { SeverityPill, StagePill } from "../components/ncr/Pills";
import { formatDate } from "./ncr";

/**
 * Register columns for each NC type. `meta.sortKey` is the API sort field; columns without one
 * cannot be sorted (the register is sorted and paged on the server).
 */
const head = (Icon, label, cls = "table-header") => (
  <div className={cls}>
    {Icon && <Icon className="shrink-0" />} {label}
  </div>
);
const text = (info) => <div className="table-row-item">{info.getValue() ?? "—"}</div>;
const nameOf = (info) => <div className="table-row-item">{info.getValue()?.name ?? "—"}</div>;

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

const reference = col("reference", "Reference", head(null, "Reference"), (i) => <div className="table-row-item font-medium">{i.getValue()}</div>, { size: 130, sortKey: "reference" });
const detectedAt = col("detectedAt", "Detected", head(CalendarIcon, "Detected"), (i) => <div className="table-row-item">{formatDate(i.getValue())}</div>, { size: 120, sortKey: "detectedAt" });
const title = col("title", "Title", head(AlignCenterIcon, "Title"), text, { size: 260, minSize: 120, maxSize: 600, sortKey: "title" });
const part = col(
  "part",
  "Part",
  head(QrCodeIcon, "Part"),
  (i) => {
    const p = i.getValue();
    return <div className="table-row-item">{p ? `${p.partNumber}${p.revision ? ` · ${p.revision}` : ""}` : "—"}</div>;
  },
  { size: 150, sortKey: "partNumber" }
);
const quantity = col("quantityAffected", "Quantity", head(LayersIcon, "Qty", "table-header-number"), (i) => <div className="table-row-item">{i.getValue() ?? "—"}</div>, {
  size: 90,
  minSize: 60,
  sortKey: "quantityAffected",
  align: "center",
});
const failureMode = col("failureMode", "Failure mode", head(TagIcon, "Failure mode"), nameOf, { size: 170, sortKey: "failureMode" });
const subFailureMode = col("subFailureMode", "Sub-failure mode", head(TagIcon, "Sub-failure mode"), nameOf, { size: 170 });
const causalProcess = col("causalProcess", "Causal process", head(BoxIcon, "Causal process"), nameOf, { size: 160 });
const severity = col("severity", "Severity", head(TriangleAlertIcon, "Severity", "table-header-number"), (i) => <SeverityPill severity={i.getValue()} />, {
  size: 110,
  sortKey: "severity",
  align: "center",
});
const stage = col("stage", "Stage", head(CircleDashedIcon, "Stage", "table-header-number"), (i) => <StagePill stage={i.getValue()} />, {
  size: 140,
  sortKey: "stage",
  align: "center",
});
const workOrder = col("workOrder", "Work order", head(BoxIcon, "Work order"), text, { size: 130 });
const customer = col("customer", "Customer", head(UsersIcon, "Customer"), nameOf, { size: 180, sortKey: "customer" });
const customerReference = col("customerReference", "Customer ref.", head(UsersIcon, "Customer ref."), text, { size: 150 });
const supplier = col("supplier", "Supplier", head(UsersIcon, "Supplier"), nameOf, { size: 180, sortKey: "supplier" });
const purchaseOrder = col("purchaseOrder", "Purchase order", head(BoxIcon, "Purchase order"), text, { size: 150 });

export const getColumnsForNcType = (ncType = "Internal") => {
  const specific = {
    Internal: [customer, workOrder],
    Customer: [customer, customerReference, workOrder],
    Supplier: [supplier, purchaseOrder],
  }[ncType] ?? [];
  return [reference, detectedAt, ...specific, part, title, quantity, failureMode, subFailureMode, causalProcess, severity, stage];
};
