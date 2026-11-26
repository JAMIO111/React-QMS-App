/** Shared definitions for customer orders and shipments (docs/order-fulfilment-plan.md). */

export const ORDER_STATUS = {
  open: { label: "Open", tone: "bg-info-color/15 text-info-color" },
  closed: { label: "Closed", tone: "bg-success-color/15 text-success-color" },
  cancelled: { label: "Cancelled", tone: "bg-border-color text-secondary-text" },
};
export const SHIPMENT_STATUS = {
  shipped: { label: "Shipped", tone: "bg-success-color/15 text-success-color" },
  cancelled: { label: "Cancelled", tone: "bg-border-color text-secondary-text" },
};

export const ORDER_FILTERS = [
  { value: "open", label: "Open" },
  { value: "late", label: "Late" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];
/** The API query a customer order filter stands for. */
export const orderFilterQuery = (filter) => {
  if (filter === "late") return { status: "open", late: "true" };
  if (filter === "closed") return { status: "closed,cancelled" };
  if (filter === "all") return { status: "all" };
  return { status: "open" };
};

export const SHIPMENT_FILTERS = [
  { value: "shipped", label: "Shipped" },
  { value: "cancelled", label: "Cancelled" },
  { value: "all", label: "All" },
];

export const ORDER_REGISTER = "/Shipping/Orders";
export const SHIPMENT_REGISTER = "/Shipping/Shipments";
export const orderPath = (id) => `${ORDER_REGISTER}/${id}`;
export const shipmentPath = (id) => `${SHIPMENT_REGISTER}/${id}`;

export const partLabel = (p) => (p ? `${p.partNumber} · ${p.name}` : "—");
export const formatQuantity = (q, unit) => `${Number(q).toLocaleString(undefined, { maximumFractionDigits: 3 })}${unit ? ` ${unit}` : ""}`;
/** A lot that is not in a state to go out is worth a word on the shipment (information only). */
export const LOT_WARNING = { on_hold: "on hold", closed: "closed" };
