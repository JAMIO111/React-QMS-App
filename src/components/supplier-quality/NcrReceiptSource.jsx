import { Link } from "react-router-dom";
import { formatDate } from "../../lib/ncr";

/** The goods receipt line(s) a non-conformance was raised from. */
const NcrReceiptSource = ({ source }) => (
  <div className="flex flex-col gap-2">
    {source.items.map((i) => (
      <p key={`${i.receiptId}-${i.lineNumber}`} className="text-sm text-primary-text">
        <Link to={`/Supplier-Quality/Goods-Receipts/${i.receiptId}`} className="font-medium text-link-color hover:underline">{i.reference}</Link> · line {i.lineNumber} · received {formatDate(i.receivedOn)}
        {i.deliveryNote ? ` · delivery note ${i.deliveryNote}` : ""}{i.lotNumber ? ` · lot ${i.lotNumber}` : ""} · {i.quantityReceived} received
      </p>
    ))}
  </div>
);

export default NcrReceiptSource;
