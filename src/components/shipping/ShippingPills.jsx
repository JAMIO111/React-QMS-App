import { ORDER_STATUS, SHIPMENT_STATUS } from "../../lib/shipping";

const pill = "inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium";
export const OrderStatusPill = ({ status }) => {
  const s = ORDER_STATUS[status] ?? ORDER_STATUS.open;
  return <span className={`${pill} ${s.tone}`}>{s.label}</span>;
};
export const ShipmentStatusPill = ({ status }) => {
  const s = SHIPMENT_STATUS[status] ?? SHIPMENT_STATUS.shipped;
  return <span className={`${pill} ${s.tone}`}>{s.label}</span>;
};
export const LateFlag = ({ days }) => (days > 0 ? <span className="ml-2 whitespace-nowrap rounded-full bg-error-color/15 px-2 py-0.5 text-xs font-medium text-error-color">{days} {days === 1 ? "day" : "days"} late</span> : null);
