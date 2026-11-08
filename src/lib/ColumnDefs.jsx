import { AlignCenterIcon, BoxIcon, InboxIcon, TagsIcon, CalendarIcon, CircleDashedIcon, LayersIcon, PoundSterlingIcon, QrCodeIcon, TagIcon, TriangleAlertIcon, UsersIcon } from "@/components/icons";
import { formatMoney } from "./costs";
import { SeverityPill, StagePill } from "../components/ncr/Pills";
import { formatDate, sourceLabel } from "./ncr";

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
const totalCost = col(
  "totalCost",
  "Total cost",
  head(PoundSterlingIcon, "Total cost", "table-header-number"),
  (i) => <div className="table-row-item">{i.getValue() ? formatMoney(i.getValue(), i.row.original.costCurrency) : "—"}</div>,
  { size: 120, minSize: 80, sortKey: "totalCost", align: "right" }
);
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

const source = col("source", "Source", head(InboxIcon, "Source"), (i) => <div className="table-row-item">{sourceLabel(i.getValue())}</div>, { size: 170, sortKey: "source" });
const category = col(
  "category",
  "Category",
  head(TagsIcon, "Category"),
  (i) => <div className="table-row-item">{i.getValue()?.name ?? <span className="text-secondary-text">Uncategorised</span>}</div>,
  { size: 160, sortKey: "category" }
);

/** The one register's columns: where it came from (source) and what the problem is (category) come first. */
export const getNcColumns = () => [
  reference, detectedAt, source, category, customer, supplier, workOrder, customerReference, purchaseOrder, part, title, quantity, totalCost,
  failureMode, subFailureMode, causalProcess, severity, stage,
];
/** Columns that start hidden (they only apply to some sources); the column menu shows them. */
export const NC_DEFAULT_HIDDEN = { workOrder: false, customerReference: false, purchaseOrder: false };
