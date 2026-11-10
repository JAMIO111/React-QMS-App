import { useState } from "react";
import { Link } from "react-router-dom";
import { useIncomingMutation, useReceiptLineLookup } from "../../hooks/useIncoming";
import { formatDate } from "../../lib/ncr";
import CTAButton from "../CTAButton";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import { FormError, TextAreaField } from "../master-data/shared";

const lineLabel = (l) => `${l.reference} · line ${l.lineNumber} · ${l.part ? l.part.partNumber : l.material ?? "material"} · ${l.quantityReceived} received`;

/** Link a non-conformance to a received line of its supplier, so its pieces count against that delivery in the supplier's PPM. */
export const LinkReceiptDialog = ({ ncr, onClose }) => {
  const mutation = useIncomingMutation();
  const [search, setSearch] = useState("");
  const [lineId, setLineId] = useState(null);
  const lines = useReceiptLineLookup({ supplierId: ncr.supplier.id, partId: ncr.part?.id, q: search || undefined });
  const options = (lines.data ?? []).map((l) => ({ value: l.id, label: lineLabel(l), hint: `received ${formatDate(l.receivedOn)}${l.deliveryNote ? ` · delivery note ${l.deliveryNote}` : ""}${l.poNumber ? ` · order ${l.poNumber}` : ""}${l.lotNumber ? ` · lot ${l.lotNumber}` : ""}` }));
  return (
    <Dialog title="Link to a received line" onClose={onClose} width="max-w-lg">
      <form noValidate className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (lineId && !mutation.isPending) mutation.mutate({ action: "linkNcr", id: ncr.id, body: { receiptLineId: lineId } }, { onSuccess: onClose }); }}>
        <p className="text-sm text-secondary-text">
          Choose the delivery from {ncr.supplier.name} this non-conformance is about{ncr.part ? ` (lines for ${ncr.part.partNumber} or with no part)` : ""}. Its pieces then count against that delivery in the supplier&apos;s non-conformance PPM, which is more exact than counting them with no delivery. A non-conformance sits on one line only.
        </p>
        <ComboField label="Received line" required value={lineId} onChange={setLineId} options={options} filterLocally={false} onSearchChange={setSearch} placeholder="Search by receipt, delivery note, order, lot or part"
          hint={lines.isLoading ? "Loading…" : options.length ? undefined : "No received lines match"} />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton buttonType="submit" type="main" size="lg" disabled={!lineId || mutation.isPending} loading={mutation.isPending}>{mutation.isPending ? "Linking…" : "Link"}</CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

const UnlinkDialog = ({ item, onClose }) => {
  const mutation = useIncomingMutation();
  const [reason, setReason] = useState("");
  const ok = reason.trim().length >= 3;
  return (
    <Dialog title="End this link" onClose={onClose} width="max-w-md">
      <form noValidate className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (ok && !mutation.isPending) mutation.mutate({ action: "unlinkNcr", id: item.linkId, body: { reason: reason.trim() } }, { onSuccess: onClose }); }}>
        <p className="text-sm text-secondary-text">The pieces stop counting against {item.reference} line {item.lineNumber}. The link stays on record.</p>
        <TextAreaField label="Why is it ending?" required value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={2} />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton buttonType="submit" type="danger" size="lg" disabled={!ok || mutation.isPending} loading={mutation.isPending}>{mutation.isPending ? "Saving…" : "End the link"}</CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/** The goods receipt line a non-conformance came from or was linked to, with the controls to link one or end the link. */
const NcrReceiptSource = ({ source, ncr, canLink = false }) => {
  const [dialog, setDialog] = useState(null); // "link" | { item }
  const items = source?.items ?? [];
  return (
    <div className="flex flex-col gap-2">
      {items.length === 0 && <p className="text-sm text-secondary-text">Not linked to a delivery. Link it to a received line and its pieces count against that delivery in {ncr?.supplier?.name ?? "the supplier"}&apos;s PPM.</p>}
      {items.map((i) => (
        <p key={i.linkId ?? `${i.receiptId}-${i.lineNumber}`} className="flex flex-wrap items-center gap-x-2 text-sm text-primary-text">
          <span>
            <Link to={`/Supplier-Quality/Goods-Receipts/${i.receiptId}`} className="font-medium text-link-color hover:underline">{i.reference}</Link> · line {i.lineNumber} · received {formatDate(i.receivedOn)}
            {i.deliveryNote ? ` · delivery note ${i.deliveryNote}` : ""}{i.lotNumber ? ` · lot ${i.lotNumber}` : ""} · {i.quantityReceived} received
          </span>
          {canLink && i.linkId && <button type="button" className="text-link-color hover:underline" onClick={() => setDialog({ item: i })}>End link</button>}
        </p>
      ))}
      {canLink && items.length === 0 && ncr?.supplier && (
        <CTAButton buttonType="button" type="secondary" size="default" className="self-start" onClick={() => setDialog("link")}>Link to a received line</CTAButton>
      )}
      {dialog === "link" && <LinkReceiptDialog ncr={ncr} onClose={() => setDialog(null)} />}
      {dialog?.item && <UnlinkDialog item={dialog.item} onClose={() => setDialog(null)} />}
    </div>
  );
};

export default NcrReceiptSource;
