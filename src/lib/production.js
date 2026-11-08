/**
 * Production orders, lots and serial numbers: labels, status colours and which status each can move to. The database decides what is allowed (and says so in words);
 * these tables only decide which buttons are offered. Keep them in step with the rules in supabase/migrations/20251210100000_production_traceability.sql.
 */
const pill = {
  neutral: "bg-border-color text-secondary-text",
  brand: "bg-brand-primary/15 text-brand-primary",
  warning: "bg-warning-color/15 text-warning-color",
  success: "bg-success-color/15 text-success-color",
  error: "bg-error-color/15 text-error-color",
};

export const ORDER_STATUS = {
  planned: { label: "Planned", className: pill.neutral },
  released: { label: "Released", className: pill.brand },
  in_progress: { label: "In progress", className: pill.warning },
  completed: { label: "Completed", className: pill.success },
  closed: { label: "Closed", className: pill.neutral },
  cancelled: { label: "Cancelled", className: pill.error },
};
export const OPERATION_STATUS = {
  pending: { label: "Pending", className: pill.neutral },
  in_progress: { label: "In progress", className: pill.warning },
  completed: { label: "Completed", className: pill.success },
  skipped: { label: "Skipped", className: pill.neutral },
};
export const LOT_STATUS = {
  open: { label: "Open", className: pill.brand },
  on_hold: { label: "On hold", className: pill.warning },
  released: { label: "Released", className: pill.success },
  closed: { label: "Closed", className: pill.neutral },
};
export const SERIAL_STATUS = {
  in_production: { label: "In production", className: pill.warning },
  completed: { label: "Completed", className: pill.success },
  scrapped: { label: "Scrapped", className: pill.error },
};
export const LOT_ORIGIN = { produced: "Produced", received: "Received" };

export const statusOptions = (map) => Object.entries(map).map(([value, { label }]) => ({ value, label }));

/** The moves offered for each status: { to, label, reason? } (reason: the move needs a written reason; danger: styled as a warning). */
export const ORDER_MOVES = {
  planned: [{ to: "released", label: "Release" }, { to: "cancelled", label: "Cancel order", reason: "Why is the order cancelled?", danger: true }],
  released: [
    { to: "in_progress", label: "Start" },
    { to: "planned", label: "Back to planned" },
    { to: "cancelled", label: "Cancel order", reason: "Why is the order cancelled?", danger: true },
  ],
  in_progress: [{ to: "completed", label: "Complete" }, { to: "cancelled", label: "Cancel order", reason: "Why is the order cancelled?", danger: true }],
  completed: [{ to: "closed", label: "Close" }, { to: "in_progress", label: "Reopen" }],
  closed: [],
  cancelled: [],
};
export const LOT_MOVES = {
  open: [{ to: "released", label: "Release" }, { to: "on_hold", label: "Put on hold", reason: "Why is the lot on hold?", danger: true }, { to: "closed", label: "Close lot" }],
  on_hold: [{ to: "open", label: "Take off hold" }, { to: "released", label: "Release" }, { to: "closed", label: "Close lot" }],
  released: [{ to: "on_hold", label: "Put on hold", reason: "Why is the lot on hold?", danger: true }, { to: "closed", label: "Close lot" }],
  closed: [],
};
export const SERIAL_MOVES = {
  in_production: [{ to: "completed", label: "Mark completed" }, { to: "scrapped", label: "Scrap", reason: "Why is it scrapped?", danger: true }],
  completed: [{ to: "in_production", label: "Back to production" }, { to: "scrapped", label: "Scrap", reason: "Why is it scrapped?", danger: true }],
  scrapped: [],
};
export const OPERATION_MOVES = {
  pending: [{ to: "in_progress", label: "Start" }, { to: "skipped", label: "Skip" }],
  in_progress: [{ to: "completed", label: "Complete" }, { to: "skipped", label: "Skip" }],
  completed: [{ to: "in_progress", label: "Reopen" }],
  skipped: [{ to: "pending", label: "Undo skip" }],
};

/** Orders and lots that can still be edited (closed, cancelled and scrapped records are frozen by the database). */
export const orderEditable = (o) => !["closed", "cancelled"].includes(o?.status);
export const lotEditable = (l) => l?.status !== "closed";
export const serialEditable = (s) => s?.status !== "scrapped";
export const orderOperationsEditable = (o) => ["planned", "released", "in_progress"].includes(o?.status);

/** The serial numbers a range would make, for the preview ("SN-0001 … SN-0050"). */
export const rangeNumbers = ({ prefix = "", from, to, pad = 0 }) => {
  if (String(from ?? "").trim() === "" || String(to ?? "").trim() === "") return [];
  const a = Number(from);
  const b = Number(to);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < a) return [];
  return Array.from({ length: b - a + 1 }, (_, i) => `${prefix}${String(a + i).padStart(Number(pad) || 0, "0")}`);
};
export const MAX_SERIAL_BATCH = 500;

/** Split a pasted list (new lines, commas, tabs or spaces) into serial numbers, dropping blanks. */
export const parseSerialList = (text) =>
  (text ?? "")
    .split(/[\n,;\t ]+/)
    .map((s) => s.trim())
    .filter(Boolean);

/** Who may make an order from a job's order picker: people who manage production, or inspectors when the organisation allows it. The database decides again. */
export const canCreateOrder = (can, settings) => can("production.manage") || (can("inspection.record") && !!settings?.allowInlineOrders);

/** Whether a side-menu entry is shown: the person may see it, and the organisation setting it depends on (if any) is not switched off. */
export const subMenuVisible = (subItem, canSee, settings) => canSee(subItem.permission) && (!subItem.setting || settings?.[subItem.setting] !== false);

/**
 * Plain-words notices about the production records a job or non-conformance is linked to: a lot on hold, an order that is closed or cancelled, a scrapped serial number.
 * Information only: nothing is blocked.
 */
export const linkNotices = (links) => {
  const out = [];
  if (links?.lot?.status === "on_hold") out.push({ key: "lot", text: `Lot ${links.lot.lotNumber} is on hold${links.lot.statusReason ? `: ${links.lot.statusReason}` : ""}.` });
  if (links?.lot?.status === "closed") out.push({ key: "lot", text: `Lot ${links.lot.lotNumber} is closed.` });
  if (links?.productionOrder && ["closed", "cancelled"].includes(links.productionOrder.status)) out.push({ key: "order", text: `Order ${links.productionOrder.orderNumber} is ${links.productionOrder.status}.` });
  if (links?.serial?.status === "scrapped") out.push({ key: "serial", text: `Serial number ${links.serial.serialNumber} was scrapped.` });
  return out;
};

/** "ROD-100 · Rod" for a part reference { partNumber, name }. */
export const partLabel = (p) => (p ? (p.name && p.name !== p.partNumber ? `${p.partNumber} · ${p.name}` : p.partNumber) : "");

/** The address of the traceability page for an order, a lot or a serial number. */
export const tracePath = (type, id) => `/Production/Traceability?type=${type}&id=${id}`;
export const TRACE_TYPE = { order: "Production order", lot: "Lot", serial: "Serial number" };
