import { Link } from "react-router-dom";
import { formatDate } from "../../lib/ncr";
import { poPath, receiptPath } from "../../lib/receiving";
import { PoStatusPill, ReceiptStatusPill } from "./ReceivingPills";

/** The purchase order table used by the register and the supplier profile. */
export const OrdersList = ({ rows, showSupplier = true }) => (
  <div className="overflow-x-auto">
    <table className="w-full text-sm" aria-label="Purchase orders">
      <thead>
        <tr className="text-left text-xs text-secondary-text">
          <th className="py-1 pr-3 font-medium">Order</th>
          {showSupplier && <th className="py-1 pr-3 font-medium">Supplier</th>}
          <th className="py-1 pr-3 font-medium">Ordered</th>
          <th className="py-1 pr-3 font-medium">Status</th>
          <th className="py-1 pr-3 font-medium">Lines</th>
          <th className="py-1 pr-3 font-medium">Outstanding</th>
          <th className="py-1 font-medium">Next due</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((o) => (
          <tr key={o.id} className="border-t border-border-color align-top">
            <td className="whitespace-nowrap py-2 pr-3"><Link to={poPath(o.id)} className="text-link-color hover:underline">{o.poNumber}</Link></td>
            {showSupplier && <td className="whitespace-nowrap py-2 pr-3"><Link to={`/Suppliers/${o.supplier.id}`} className="text-secondary-text hover:underline">{o.supplier.code} · {o.supplier.name}</Link></td>}
            <td className="whitespace-nowrap py-2 pr-3 text-secondary-text">{formatDate(o.orderedOn)}</td>
            <td className="py-2 pr-3"><PoStatusPill status={o.status} /></td>
            <td className="py-2 pr-3 tabular-nums text-secondary-text">{o.lineCount}</td>
            <td className="py-2 pr-3 tabular-nums text-secondary-text">{o.status === "open" ? o.outstandingLines : "—"}{o.lateLines > 0 && <span className="ml-2 rounded-full bg-error-color/15 px-2 py-0.5 text-xs font-medium text-error-color">{o.lateLines} late</span>}</td>
            <td className="whitespace-nowrap py-2 text-secondary-text">{o.status === "open" && o.nextDueOn ? formatDate(o.nextDueOn) : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

/** The goods receipt table used by the register, the order page and the supplier profile. */
export const ReceiptsList = ({ rows, showSupplier = true }) => (
  <div className="overflow-x-auto">
    <table className="w-full text-sm" aria-label="Goods receipts">
      <thead>
        <tr className="text-left text-xs text-secondary-text">
          <th className="py-1 pr-3 font-medium">Receipt</th>
          {showSupplier && <th className="py-1 pr-3 font-medium">Supplier</th>}
          <th className="py-1 pr-3 font-medium">Received</th>
          <th className="py-1 pr-3 font-medium">Order</th>
          <th className="py-1 pr-3 font-medium">Delivery note</th>
          <th className="py-1 pr-3 font-medium">Lines</th>
          <th className="py-1 font-medium">Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((g) => (
          <tr key={g.id} className="border-t border-border-color align-top">
            <td className="whitespace-nowrap py-2 pr-3"><Link to={receiptPath(g.id)} className="text-link-color hover:underline">{g.reference}</Link></td>
            {showSupplier && <td className="whitespace-nowrap py-2 pr-3"><Link to={`/Suppliers/${g.supplier.id}`} className="text-secondary-text hover:underline">{g.supplier.code} · {g.supplier.name}</Link></td>}
            <td className="whitespace-nowrap py-2 pr-3 text-secondary-text">{formatDate(g.receivedOn)}</td>
            <td className="whitespace-nowrap py-2 pr-3">{g.purchaseOrder ? <Link to={poPath(g.purchaseOrder.id)} className="text-link-color hover:underline">{g.purchaseOrder.poNumber}</Link> : <span className="text-secondary-text">—</span>}</td>
            <td className="py-2 pr-3 text-secondary-text">{g.deliveryNote ?? "—"}</td>
            <td className="py-2 pr-3 tabular-nums text-secondary-text">{g.lineCount}</td>
            <td className="py-2"><ReceiptStatusPill status={g.status} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);
