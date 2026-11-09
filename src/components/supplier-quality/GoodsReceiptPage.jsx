import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { usePermissions } from "../../hooks/useQmsApi";
import { useReceipt } from "../../hooks/useReceiving";
import { formatDate } from "../../lib/ncr";
import { formatDateTime } from "../../lib/processControl";
import { tracePath } from "../../lib/production";
import { formatQuantity, lineLabel, poPath } from "../../lib/receiving";
import Breadcrumb from "../Breadcrumb";
import CTAButton from "../CTAButton";
import Callout from "../ui/Callout";
import LoadingScreen from "../ui/LoadingScreen";
import MenuCard from "../ui/MenuCard";
import { ErrorNotice } from "../master-data/shared";
import { ReasonDialog } from "./ReceivingDialogs";
import { ReceiptStatusPill } from "./ReceivingPills";

const Fact = ({ label, children }) => (
  <div className="min-w-0">
    <dt className="text-xs text-secondary-text">{label}</dt>
    <dd className="text-sm text-primary-text">{children ?? "—"}</dd>
  </div>
);

/** One delivery: what arrived, against which order lines, and the lots it made (each links to its trace). */
const GoodsReceiptPage = () => {
  const { id } = useParams();
  const { can } = usePermissions();
  const query = useReceipt(id);
  const [cancelling, setCancelling] = useState(false);
  if (query.isLoading) return <LoadingScreen />;
  if (query.error) return <div className="p-4"><ErrorNotice error={query.error} /></div>;
  const g = query.data;
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-4 overflow-y-auto p-4">
      <Breadcrumb />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold text-primary-text">{g.reference}</h1>
            <ReceiptStatusPill status={g.status} />
          </div>
          <p className="text-sm text-secondary-text"><Link to={`/Suppliers/${g.supplier.id}`} className="text-link-color hover:underline">{g.supplier.code} · {g.supplier.name}</Link> · received {formatDate(g.receivedOn)}</p>
        </div>
        {can("receiving.manage") && g.status === "received" && <CTAButton type="danger" size="default" onClick={() => setCancelling(true)}>Cancel receipt</CTAButton>}
      </div>
      {g.status === "cancelled" && <Callout tone="warning" title="Cancelled">{g.cancelReason} <span className="text-secondary-text">({g.cancelledBy?.name ?? "Unknown"}, {formatDateTime(g.cancelledAt)}). The lots it made are kept: close them under Production if they are not real.</span></Callout>}

      <MenuCard title="The delivery">
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Fact label="Purchase order">{g.purchaseOrder ? <Link to={poPath(g.purchaseOrder.id)} className="text-link-color hover:underline">{g.purchaseOrder.poNumber}</Link> : null}</Fact>
          <Fact label="Delivery note">{g.deliveryNote}</Fact>
          <Fact label="Site">{g.site?.name}</Fact>
          <Fact label="Recorded by">{g.createdBy ? `${g.createdBy.name}, ${formatDateTime(g.createdAt)}` : formatDateTime(g.createdAt)}</Fact>
        </dl>
        {g.notes && <p className="mt-3 whitespace-pre-wrap text-sm text-primary-text">{g.notes}</p>}
      </MenuCard>

      <MenuCard title="Lines" subtitle="What arrived. A lot here was made by this receipt.">
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-label="Receipt lines">
            <thead>
              <tr className="text-left text-xs text-secondary-text">
                <th className="py-1 pr-3 font-medium">What</th>
                <th className="py-1 pr-3 font-medium">Order line</th>
                <th className="py-1 pr-3 text-right font-medium">Received</th>
                <th className="py-1 font-medium">Lot</th>
              </tr>
            </thead>
            <tbody>
              {g.lines.map((l) => (
                <tr key={l.id} className="border-t border-border-color align-top">
                  <td className="py-2 pr-3 text-primary-text">{l.part ? <Link to={`/Parts/${l.part.id}`} className="text-link-color hover:underline">{lineLabel(l)}</Link> : lineLabel(l)}{l.notes && <span className="block text-xs text-secondary-text">{l.notes}</span>}</td>
                  <td className="py-2 pr-3 text-secondary-text">{l.poLine ? `Line ${l.poLine.lineNumber}` : "—"}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{formatQuantity(l.quantityReceived)}</td>
                  <td className="py-2">{l.lot ? <Link to={tracePath("lot", l.lot.id)} className="text-link-color hover:underline">{l.lot.lotNumber}</Link> : <span className="text-secondary-text">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </MenuCard>
      {cancelling && <ReasonDialog title="Cancel this receipt" intro="The receipt is cancelled and kept, with the reason. The lots it made are kept too." label="Why is it being cancelled?" submitLabel="Cancel receipt" action="cancelReceipt" id={g.id} onClose={() => setCancelling(false)} />}
    </div>
  );
};

export default GoodsReceiptPage;
