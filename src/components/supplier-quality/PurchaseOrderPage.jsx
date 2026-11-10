import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { usePermissions } from "../../hooks/useQmsApi";
import { usePurchaseOrder, useReceivingMutation } from "../../hooks/useReceiving";
import { formatDate } from "../../lib/ncr";
import { formatDateTime } from "../../lib/processControl";
import { formatQuantity, lineLabel } from "../../lib/receiving";
import { useBreadcrumbNames } from "../../lib/breadcrumbs";
import Breadcrumb from "../Breadcrumb";
import CTAButton from "../CTAButton";
import Callout from "../ui/Callout";
import Dialog from "../ui/Dialog";
import LoadingScreen from "../ui/LoadingScreen";
import MenuCard from "../ui/MenuCard";
import { ErrorNotice, FormError } from "../master-data/shared";
import { AgreedDateDialog, ReasonDialog, RecordReceiptDialog } from "./ReceivingDialogs";
import { ReceiptsList } from "./ReceivingLists";
import { LateFlag, PoStatusPill } from "./ReceivingPills";

const Fact = ({ label, children }) => (
  <div className="min-w-0">
    <dt className="text-xs text-secondary-text">{label}</dt>
    <dd className="text-sm text-primary-text">{children ?? "—"}</dd>
  </div>
);

/** One purchase order: each line's ordered, received and outstanding quantity and whether it is late, and the deliveries recorded against it. */
const PurchaseOrderPage = () => {
  const { id } = useParams();
  const { can } = usePermissions();
  const query = usePurchaseOrder(id);
  useBreadcrumbNames([{ path: `/Supplier-Quality/Purchase-Orders/${id}`, label: query.data?.poNumber }]);
  const [dialog, setDialog] = useState(null);
  const close = () => setDialog(null);
  if (query.isLoading) return <LoadingScreen />;
  if (query.error) return <div className="p-4"><ErrorNotice error={query.error} /></div>;
  const o = query.data;
  const manage = can("receiving.manage");
  const open = o.status === "open";

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-4 overflow-y-auto p-4">
      <Breadcrumb />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold text-primary-text">{o.poNumber}</h1>
            <PoStatusPill status={o.status} />
          </div>
          <p className="text-sm text-secondary-text"><Link to={`/Suppliers/${o.supplier.id}`} className="text-link-color hover:underline">{o.supplier.code} · {o.supplier.name}</Link> · ordered {formatDate(o.orderedOn)}</p>
        </div>
        {manage && open && (
          <div className="flex flex-wrap items-center gap-2">
            <CTAButton type="main" size="default" onClick={() => setDialog({ kind: "receive" })}>Record a delivery</CTAButton>
            <CTAButton type="secondary" size="default" onClick={() => setDialog({ kind: "close" })}>Close order</CTAButton>
            <CTAButton type="danger" size="default" onClick={() => setDialog({ kind: "cancel" })}>Cancel order</CTAButton>
          </div>
        )}
      </div>
      {o.status === "cancelled" && <Callout tone="warning" title="Cancelled">{o.cancelReason}</Callout>}
      {o.status === "closed" && <Callout tone="info" title="Closed">Nothing more is expected on this order{o.closedAt ? ` (closed ${formatDateTime(o.closedAt)})` : ""}.</Callout>}
      {open && o.lateLines > 0 && <Callout tone="error" title={`${o.lateLines} ${o.lateLines === 1 ? "line is" : "lines are"} late`}>Goods are still outstanding past the agreed (else requested) date. Chase the supplier, or record a new agreed date.</Callout>}

      <MenuCard title="Lines" subtitle="A line is late when goods are still outstanding past its latest agreed date, else its requested date. The requested date never changes.">
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-label="Order lines">
            <thead>
              <tr className="text-left text-xs text-secondary-text">
                <th className="py-1 pr-3 font-medium">#</th>
                <th className="py-1 pr-3 font-medium">What</th>
                <th className="py-1 pr-3 text-right font-medium">Ordered</th>
                <th className="py-1 pr-3 text-right font-medium">Received</th>
                <th className="py-1 pr-3 text-right font-medium">Outstanding</th>
                <th className="py-1 pr-3 font-medium">Requested</th>
                <th className="py-1 pr-3 font-medium">Agreed</th>
                <th className="py-1 font-medium" />
              </tr>
            </thead>
            <tbody>
              {o.lines.map((l) => (
                <tr key={l.id} className="border-t border-border-color align-top">
                  <td className="py-2 pr-3 tabular-nums text-secondary-text">{l.lineNumber}</td>
                  <td className="py-2 pr-3 text-primary-text">{l.part ? <Link to={`/Parts/${l.part.id}`} className="text-link-color hover:underline">{lineLabel(l)}</Link> : lineLabel(l)}{l.status !== "open" && <span className="ml-2 text-xs text-secondary-text">({l.status})</span>}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{formatQuantity(l.quantityOrdered, l.unit)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{formatQuantity(l.quantityReceived)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{l.status === "open" ? formatQuantity(l.quantityOutstanding) : "—"}</td>
                  <td className="whitespace-nowrap py-2 pr-3 text-secondary-text">{formatDate(l.requestedOn)}</td>
                  <td className="whitespace-nowrap py-2 pr-3 text-secondary-text">{l.agreedOn ? formatDate(l.agreedOn) : "—"}<LateFlag days={l.daysLate} /></td>
                  <td className="py-2 text-right">{manage && open && l.status === "open" && <button type="button" className="text-xs text-secondary-text hover:underline" aria-label={`Set the agreed date for line ${l.lineNumber}`} onClick={() => setDialog({ kind: "agreed", line: l })}>Agreed date</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {o.notes && <p className="mt-3 whitespace-pre-wrap text-sm text-primary-text">{o.notes}</p>}
      </MenuCard>

      <MenuCard title="Deliveries" subtitle="What has been recorded against this order.">
        {o.receipts.length === 0 ? <p className="text-sm text-secondary-text">Nothing received yet.</p> : <ReceiptsList rows={o.receipts.map((r) => ({ ...r, supplier: o.supplier, purchaseOrder: { id: o.id, poNumber: o.poNumber } }))} showSupplier={false} />}
      </MenuCard>

      {dialog?.kind === "receive" && <RecordReceiptDialog purchaseOrder={{ id: o.id, poNumber: o.poNumber, supplier: o.supplier }} onClose={close} />}
      {dialog?.kind === "agreed" && <AgreedDateDialog line={dialog.line} onClose={close} />}
      {dialog?.kind === "close" && <ReasonDialogClose order={o} onClose={close} />}
      {dialog?.kind === "cancel" && <ReasonDialog title="Cancel this order" intro="The order and its open lines are cancelled and kept, with the reason." label="Why is it being cancelled?" submitLabel="Cancel order" action="cancelOrder" id={o.id} onClose={close} />}
    </div>
  );
};


/** Closing needs no reason: it just says nothing more is expected. */
const ReasonDialogClose = ({ order, onClose }) => {
  const mutation = useReceivingMutation();
  return (
    <Dialog title="Close this order" onClose={onClose} width="max-w-lg">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-secondary-text">Nothing more is expected on {order.poNumber}. Its open lines are closed; what was received stays recorded.</p>
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton buttonType="button" type="main" size="lg" disabled={mutation.isPending} loading={mutation.isPending} onClick={() => mutation.mutate({ action: "closeOrder", id: order.id }, { onSuccess: onClose })}>{mutation.isPending ? "Saving…" : "Close order"}</CTAButton>
        </div>
      </div>
    </Dialog>
  );
};

export default PurchaseOrderPage;
