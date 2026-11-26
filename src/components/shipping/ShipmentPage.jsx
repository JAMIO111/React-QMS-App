import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { usePermissions } from "../../hooks/useQmsApi";
import { useShipment } from "../../hooks/useShipping";
import { formatDate } from "../../lib/ncr";
import { formatDateTime } from "../../lib/processControl";
import { tracePath } from "../../lib/production";
import { LOT_WARNING, formatQuantity, orderPath, partLabel, shipmentPath } from "../../lib/shipping";
import { useBreadcrumbNames } from "../../lib/breadcrumbs";
import Breadcrumb from "../Breadcrumb";
import CTAButton from "../CTAButton";
import Callout from "../ui/Callout";
import LoadingScreen from "../ui/LoadingScreen";
import MenuCard from "../ui/MenuCard";
import { ErrorNotice } from "../master-data/shared";
import { ReasonDialog } from "./ShippingDialogs";
import { ShipmentStatusPill } from "./ShippingPills";

const Fact = ({ label, children }) => (
  <div className="min-w-0">
    <dt className="text-xs text-secondary-text">{label}</dt>
    <dd className="text-sm text-primary-text">{children ?? "—"}</dd>
  </div>
);

/** One shipment: what left, against which order lines, and the lots it came from (each links to its trace). */
const ShipmentPage = () => {
  const { id } = useParams();
  const { can } = usePermissions();
  const query = useShipment(id);
  useBreadcrumbNames([{ path: shipmentPath(id), label: query.data?.reference }]);
  const [cancelling, setCancelling] = useState(false);
  if (query.isLoading) return <LoadingScreen />;
  if (query.error) return <div className="p-4"><ErrorNotice error={query.error} /></div>;
  const s = query.data;
  const warned = s.lines.filter((l) => l.lot && LOT_WARNING[l.lotStatus]);
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-4 overflow-y-auto p-4">
      <Breadcrumb />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold text-primary-text">{s.reference}</h1>
            <ShipmentStatusPill status={s.status} />
          </div>
          <p className="text-sm text-secondary-text">{s.customer.code} · {s.customer.name} · shipped {formatDate(s.shippedOn)}</p>
        </div>
        {can("shipping.manage") && s.status === "shipped" && <CTAButton type="danger" size="default" onClick={() => setCancelling(true)}>Cancel shipment</CTAButton>}
      </div>
      {s.status === "cancelled" && <Callout tone="warning" title="Cancelled">{s.cancelReason} <span className="text-secondary-text">({s.cancelledBy?.name ?? "Unknown"}, {formatDateTime(s.cancelledAt)}).</span></Callout>}
      {s.status === "shipped" && warned.length > 0 && (
        <Callout tone="warning" title="A lot on this shipment is not in a normal state">
          {warned.map((l) => `${l.lot.lotNumber} is ${LOT_WARNING[l.lotStatus]}`).join("; ")}. This is information only; nothing is stopped.
        </Callout>
      )}

      <MenuCard title="The shipment">
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Fact label="Customer order">{s.customerOrder ? <Link to={orderPath(s.customerOrder.id)} className="text-link-color hover:underline">{s.customerOrder.orderNumber}</Link> : null}</Fact>
          <Fact label="Delivery note">{s.deliveryNote}</Fact>
          <Fact label="Site">{s.site?.name}</Fact>
          <Fact label="Recorded by">{s.createdBy ? `${s.createdBy.name}, ${formatDateTime(s.createdAt)}` : formatDateTime(s.createdAt)}</Fact>
        </dl>
        {s.notes && <p className="mt-3 whitespace-pre-wrap text-sm text-primary-text">{s.notes}</p>}
      </MenuCard>

      <MenuCard title="Lines" subtitle="What left. A lot here is the lot the parts came from.">
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-label="Shipment lines">
            <thead>
              <tr className="text-left text-xs text-secondary-text">
                <th className="py-1 pr-3 font-medium">Part</th>
                <th className="py-1 pr-3 font-medium">Order line</th>
                <th className="py-1 pr-3 text-right font-medium">Shipped</th>
                <th className="py-1 font-medium">Lot</th>
              </tr>
            </thead>
            <tbody>
              {s.lines.map((l) => (
                <tr key={l.id} className="border-t border-border-color align-top">
                  <td className="py-2 pr-3 text-primary-text"><Link to={`/Parts/${l.part.id}`} className="text-link-color hover:underline">{partLabel(l.part)}</Link>{l.notes && <span className="block text-xs text-secondary-text">{l.notes}</span>}</td>
                  <td className="py-2 pr-3 text-secondary-text">{l.orderLine ? `Line ${l.orderLine.lineNumber}` : "—"}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{formatQuantity(l.quantityShipped)}</td>
                  <td className="py-2">{l.lot ? <><Link to={tracePath("lot", l.lot.id)} className="text-link-color hover:underline">{l.lot.lotNumber}</Link>{LOT_WARNING[l.lotStatus] && <span className="ml-2 text-xs text-warning-color">({LOT_WARNING[l.lotStatus]})</span>}</> : <span className="text-secondary-text">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </MenuCard>
      {cancelling && <ReasonDialog title="Cancel this shipment" intro="The shipment is cancelled and kept, with the reason. It no longer counts as shipped." label="Why is it being cancelled?" submitLabel="Cancel shipment" action="cancelShipment" id={s.id} onClose={() => setCancelling(false)} />}
    </div>
  );
};

export default ShipmentPage;
