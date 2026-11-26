import { Link } from "react-router-dom";
import { formatDate } from "../../lib/ncr";
import { orderPath, shipmentPath } from "../../lib/shipping";
import { OrderStatusPill, ShipmentStatusPill } from "./ShippingPills";

const customerText = (c) => `${c.code} · ${c.name}`;

/** The customer order table used by the register. */
export const OrdersList = ({ rows, showCustomer = true }) => (
  <div className="overflow-x-auto">
    <table className="w-full text-sm" aria-label="Customer orders">
      <thead>
        <tr className="text-left text-xs text-secondary-text">
          <th className="py-1 pr-3 font-medium">Order</th>
          {showCustomer && <th className="py-1 pr-3 font-medium">Customer</th>}
          <th className="py-1 pr-3 font-medium">Customer's order number</th>
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
            <td className="whitespace-nowrap py-2 pr-3"><Link to={orderPath(o.id)} className="text-link-color hover:underline">{o.orderNumber}</Link></td>
            {showCustomer && <td className="whitespace-nowrap py-2 pr-3 text-secondary-text">{customerText(o.customer)}</td>}
            <td className="py-2 pr-3 text-secondary-text">{o.customerReference ?? "—"}</td>
            <td className="whitespace-nowrap py-2 pr-3 text-secondary-text">{formatDate(o.orderedOn)}</td>
            <td className="py-2 pr-3"><OrderStatusPill status={o.status} /></td>
            <td className="py-2 pr-3 tabular-nums text-secondary-text">{o.lineCount}</td>
            <td className="py-2 pr-3 tabular-nums text-secondary-text">{o.status === "open" ? o.outstandingLines : "—"}{o.lateLines > 0 && <span className="ml-2 rounded-full bg-error-color/15 px-2 py-0.5 text-xs font-medium text-error-color">{o.lateLines} late</span>}</td>
            <td className="whitespace-nowrap py-2 text-secondary-text">{o.status === "open" && o.nextDueOn ? formatDate(o.nextDueOn) : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

/** The shipment table used by the register and the order page. */
export const ShipmentsList = ({ rows, showCustomer = true }) => (
  <div className="overflow-x-auto">
    <table className="w-full text-sm" aria-label="Shipments">
      <thead>
        <tr className="text-left text-xs text-secondary-text">
          <th className="py-1 pr-3 font-medium">Shipment</th>
          {showCustomer && <th className="py-1 pr-3 font-medium">Customer</th>}
          <th className="py-1 pr-3 font-medium">Shipped</th>
          <th className="py-1 pr-3 font-medium">Order</th>
          <th className="py-1 pr-3 font-medium">Delivery note</th>
          <th className="py-1 pr-3 font-medium">Lines</th>
          <th className="py-1 font-medium">Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((s) => (
          <tr key={s.id} className="border-t border-border-color align-top">
            <td className="whitespace-nowrap py-2 pr-3"><Link to={shipmentPath(s.id)} className="text-link-color hover:underline">{s.reference}</Link></td>
            {showCustomer && <td className="whitespace-nowrap py-2 pr-3 text-secondary-text">{customerText(s.customer)}</td>}
            <td className="whitespace-nowrap py-2 pr-3 text-secondary-text">{formatDate(s.shippedOn)}</td>
            <td className="whitespace-nowrap py-2 pr-3">{s.customerOrder ? <Link to={orderPath(s.customerOrder.id)} className="text-link-color hover:underline">{s.customerOrder.orderNumber}</Link> : <span className="text-secondary-text">—</span>}</td>
            <td className="py-2 pr-3 text-secondary-text">{s.deliveryNote ?? "—"}</td>
            <td className="py-2 pr-3 tabular-nums text-secondary-text">{s.lineCount}</td>
            <td className="py-2"><ShipmentStatusPill status={s.status} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);
