/**
 * What the screen shows straight after a customer order or shipment action, before the server answers (CLAUDE.md "Optimistic UI"). Only what the request says is guessed:
 * closing or cancelling an order, an agreed date and cancelling a shipment. Recording an order or a shipment is not guessed: the new record's page needs its id and the server
 * numbers it. The server's answer and the refetch replace the guess; a refusal puts the old data back.
 */
import { updateById } from "./optimistic";

const now = () => new Date().toISOString();
const withKey = (key, change) => (row) => (key in row ? change(row) : row);

export const SHIPPING_OPTIMISTIC = new Set(["closeOrder", "cancelOrder", "agreedDate", "cancelShipment"]);

export const guessShipping = (data, { action, id, body = {} } = {}) => {
  switch (action) {
    case "closeOrder":
      return updateById(data, id, withKey("status", (row) =>
        row.status === "open"
          ? { ...row, status: "closed", closedAt: now(), ...("lateLines" in row ? { lateLines: 0 } : {}), ...(Array.isArray(row.lines) ? { lines: row.lines.map((l) => (l.status === "open" ? { ...l, status: "closed" } : l)) } : {}) }
          : row,
      ));
    case "cancelOrder":
      return updateById(data, id, withKey("status", (row) => ({
        ...row,
        status: "cancelled",
        cancelReason: body.reason ?? null,
        ...("lateLines" in row ? { lateLines: 0 } : {}),
        ...(Array.isArray(row.lines) ? { lines: row.lines.map((l) => (l.status === "open" ? { ...l, status: "cancelled" } : l)) } : {}),
      })));
    case "agreedDate":
      return updateById(data, id, withKey("agreedOn", (row) => ({ ...row, agreedOn: body.agreedOn ?? null })));
    case "cancelShipment":
      return updateById(data, id, withKey("status", (row) => ({ ...row, status: "cancelled", cancelReason: body.reason ?? null, cancelledAt: now() })));
    default:
      return data;
  }
};
