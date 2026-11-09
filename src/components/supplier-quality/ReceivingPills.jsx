import { PO_STATUS, RECEIPT_STATUS } from "../../lib/receiving";

export const PoStatusPill = ({ status }) => {
  const s = PO_STATUS[status] ?? PO_STATUS.open;
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${s.tone}`}>{s.label}</span>;
};
export const ReceiptStatusPill = ({ status }) => {
  const s = RECEIPT_STATUS[status] ?? RECEIPT_STATUS.received;
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${s.tone}`}>{s.label}</span>;
};
export const LateFlag = ({ days }) => (days > 0 ? <span className="ml-2 whitespace-nowrap rounded-full bg-error-color/15 px-2 py-0.5 text-xs font-medium text-error-color">{days} {days === 1 ? "day" : "days"} late</span> : null);
