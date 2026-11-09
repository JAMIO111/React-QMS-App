/** Shared definitions for purchase orders and goods receiving (SQ4a). */

export const PO_STATUS = {
  open: { label: "Open", tone: "bg-info-color/15 text-info-color" },
  closed: { label: "Closed", tone: "bg-success-color/15 text-success-color" },
  cancelled: { label: "Cancelled", tone: "bg-border-color text-secondary-text" },
};
export const RECEIPT_STATUS = {
  received: { label: "Received", tone: "bg-success-color/15 text-success-color" },
  cancelled: { label: "Cancelled", tone: "bg-border-color text-secondary-text" },
};

export const PO_FILTERS = [
  { value: "open", label: "Open" },
  { value: "late", label: "Late" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];
/** The API query a purchase order filter stands for. */
export const poFilterQuery = (filter) => {
  if (filter === "late") return { status: "open", late: "true" };
  if (filter === "closed") return { status: "closed,cancelled" };
  if (filter === "all") return { status: "all" };
  return { status: "open" };
};

export const RECEIPT_FILTERS = [
  { value: "received", label: "Received" },
  { value: "cancelled", label: "Cancelled" },
  { value: "all", label: "All" },
];

export const poPath = (id) => `/Supplier-Quality/Purchase-Orders/${id}`;
export const receiptPath = (id) => `/Supplier-Quality/Goods-Receipts/${id}`;
export const PO_REGISTER = "/Supplier-Quality/Purchase-Orders";
export const RECEIPT_REGISTER = "/Supplier-Quality/Goods-Receipts";

/** What a line is of: the part number and name, else the material in words. */
export const lineLabel = (l) => (l.part ? `${l.part.partNumber} · ${l.part.name}` : (l.material ?? "—"));
export const formatQuantity = (q, unit) => `${Number(q).toLocaleString(undefined, { maximumFractionDigits: 3 })}${unit ? ` ${unit}` : ""}`;
