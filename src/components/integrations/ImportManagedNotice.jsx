import Callout from "../ui/Callout";

const WORDS = {
  purchase_orders: "Purchase orders",
  receipts: "Deliveries",
  customer_orders: "Customer orders",
  shipments: "Shipments",
};

/**
 * Shown where people would add orders or movements by hand while a scheduled import owns them. Nothing here is a fault: the data arrives from the
 * connection, and typing it too would put every record in twice. Switching the schedule off (Settings → Integrations) opens hand entry again.
 */
const ImportManagedNotice = ({ area, connection }) =>
  connection ? (
    <Callout tone="info" title={`${WORDS[area] ?? "These records"} come from ${connection}`}>
      They arrive on a schedule, so they cannot be entered here. To enter them by hand instead, switch that schedule off in Settings → Integrations.
    </Callout>
  ) : null;

export default ImportManagedNotice;
