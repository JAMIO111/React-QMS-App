import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PlusIcon, Trash2Icon } from "@/components/icons";
import { usePermissions } from "../../hooks/useQmsApi";
import { usePoLookup, usePurchaseOrder, useReceivingMutation } from "../../hooks/useReceiving";
import { useSupplierRegister } from "../../hooks/useSupplierQuality";
import { formatDate } from "../../lib/ncr";
import { lineLabel, poPath, receiptPath } from "../../lib/receiving";
import { newClientKey } from "../../lib/supplierScars";
import CTAButton from "../CTAButton";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";
import { PartPicker } from "../ncr/Pickers";
import { FormError, TextAreaField } from "../master-data/shared";

const today = () => new Date().toISOString().slice(0, 10);
const inDays = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
let rowId = 0;
const newRow = (over = {}) => ({ id: ++rowId, partId: null, material: "", quantity: "", unit: "", requestedOn: inDays(14), agreedOn: "", lotNumber: "", poLineId: null, label: null, include: true, ...over });

const Shell = ({ title, intro, mutation, ok, submitLabel, onClose, onSubmit, width = "max-w-3xl", children }) => (
  <Dialog title={title} onClose={onClose} width={width}>
    <form noValidate className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (ok && !mutation.isPending) onSubmit(); }}>
      {intro && <p className="text-sm text-secondary-text">{intro}</p>}
      {children}
      <FormError error={mutation.error} />
      <div className="flex justify-end gap-2">
        <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
        <CTAButton buttonType="submit" type="main" size="lg" disabled={!ok || mutation.isPending}>{mutation.isPending ? "Saving…" : submitLabel}</CTAButton>
      </div>
    </form>
  </Dialog>
);

const SupplierField = ({ supplier, supplierId, onChange }) => {
  const [search, setSearch] = useState("");
  const suppliers = useSupplierRegister({ q: search || undefined, pageSize: 25 }, { enabled: !supplier });
  if (supplier) return <p className="text-sm text-primary-text">Supplier: <strong>{supplier.displayName || supplier.name}</strong></p>;
  return <ComboField label="Supplier" required value={supplierId} onChange={onChange} placeholder="Search suppliers…" filterLocally={false} onSearchChange={setSearch}
    options={(suppliers.data?.data ?? []).map((s) => ({ value: s.id, label: `${s.code} · ${s.displayName || s.name}` }))} />;
};

const num = (v) => (v === "" || v === null ? null : Number(v));
const validQty = (v) => Number.isFinite(num(v)) && num(v) > 0;

/** Record a purchase order: who from, its number, and the lines (a part of ours or a material, a quantity, the date it was requested for). */
export const CreatePurchaseOrderDialog = ({ supplier = null, onClose }) => {
  const navigate = useNavigate();
  const { can } = usePermissions();
  const mutation = useReceivingMutation();
  const [supplierId, setSupplierId] = useState(supplier?.id ?? null);
  const [poNumber, setPoNumber] = useState("");
  const [orderedOn, setOrderedOn] = useState(today());
  const [notes, setNotes] = useState("");
  const [rows, setRows] = useState([newRow()]);
  const patch = (id, changes) => setRows((r) => r.map((x) => (x.id === id ? { ...x, ...changes } : x)));
  const rowOk = (r) => (r.partId || r.material.trim()) && validQty(r.quantity) && r.requestedOn;
  const ok = !!supplierId && poNumber.trim() && rows.length > 0 && rows.every(rowOk);
  const submit = () =>
    mutation.mutate(
      {
        action: "createOrder",
        body: {
          supplierId, poNumber: poNumber.trim(), orderedOn, ...(notes.trim() ? { notes: notes.trim() } : {}),
          lines: rows.map((r) => ({ ...(r.partId ? { partId: r.partId } : {}), ...(r.material.trim() ? { material: r.material.trim() } : {}), quantity: Number(r.quantity), ...(r.unit.trim() ? { unit: r.unit.trim() } : {}), requestedOn: r.requestedOn, ...(r.agreedOn ? { agreedOn: r.agreedOn } : {}) })),
        },
      },
      { onSuccess: (po) => { onClose(); navigate(poPath(po.id)); } },
    );
  return (
    <Shell title="Record a purchase order" mutation={mutation} ok={ok} submitLabel="Record order" onClose={onClose} onSubmit={submit}
      intro="What was ordered, and the date each line was originally requested for. That date never changes; the latest agreed date can.">
      <SupplierField supplier={supplier} supplierId={supplierId} onChange={setSupplierId} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Order number" required value={poNumber} onChange={(e) => setPoNumber(e.target.value)} maxLength={40} />
        <RHFDatePickerPopout label="Ordered on" valueFormat="iso" value={orderedOn} onChange={(v) => setOrderedOn(v ?? "")} />
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-secondary-text">Lines</legend>
        {rows.map((r, i) => (
          <div key={r.id} className="grid gap-2 rounded-lg border border-border-color p-2 sm:grid-cols-6">
            {can("master_data.read") && <div className="sm:col-span-2"><PartPicker label={`Line ${i + 1} part`} value={r.partId} onChange={(id) => patch(r.id, { partId: id })} clearable /></div>}
            <Field className={can("master_data.read") ? "sm:col-span-2" : "sm:col-span-3"} label={`Line ${i + 1} material`} value={r.material} onChange={(e) => patch(r.id, { material: e.target.value })} maxLength={200} placeholder="If not one of our parts" />
            <Field label={`Line ${i + 1} quantity`} required type="number" min="0" step="any" value={r.quantity} onChange={(e) => patch(r.id, { quantity: e.target.value })} />
            <Field label={`Line ${i + 1} unit`} value={r.unit} onChange={(e) => patch(r.id, { unit: e.target.value })} maxLength={20} placeholder="pcs, kg…" />
            <div className="sm:col-span-2"><RHFDatePickerPopout label={`Line ${i + 1} requested for`} required valueFormat="iso" value={r.requestedOn} onChange={(v) => patch(r.id, { requestedOn: v ?? "" })} /></div>
            <div className="sm:col-span-2"><RHFDatePickerPopout label={`Line ${i + 1} agreed for`} valueFormat="iso" clearable value={r.agreedOn} onChange={(v) => patch(r.id, { agreedOn: v ?? "" })} placeholder="Same as requested" /></div>
            <div className="flex items-end justify-end">{rows.length > 1 && <button type="button" aria-label={`Remove line ${i + 1}`} className="p-2 text-secondary-text hover:text-error-color" onClick={() => setRows((x) => x.filter((y) => y.id !== r.id))}><Trash2Icon /></button>}</div>
          </div>
        ))}
        <CTAButton buttonType="button" type="secondary" size="default" icon={PlusIcon} className="self-start" onClick={() => setRows((r) => [...r, newRow()])}>Add a line</CTAButton>
      </fieldset>
      <TextAreaField label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} rows={2} />
    </Shell>
  );
};

/**
 * Record a delivery. Against an order, the lines it still expects are listed with the outstanding quantity ready to confirm; without one, add the parts or materials by hand.
 * A line with a lot number makes the received lot, so what arrived can be traced.
 */
export const RecordReceiptDialog = ({ supplier = null, purchaseOrder = null, onClose }) => {
  const navigate = useNavigate();
  const { can } = usePermissions();
  const mutation = useReceivingMutation();
  const clientKey = useRef(newClientKey());
  const [supplierId, setSupplierId] = useState(supplier?.id ?? purchaseOrder?.supplier?.id ?? null);
  const [poId, setPoId] = useState(purchaseOrder?.id ?? null);
  const orders = usePoLookup({ supplierId, enabled: !purchaseOrder });
  const order = usePurchaseOrder(poId);
  const [receivedOn, setReceivedOn] = useState(today());
  const [deliveryNote, setDeliveryNote] = useState("");
  const [notes, setNotes] = useState("");
  const [rows, setRows] = useState([]);
  const patch = (id, changes) => setRows((r) => r.map((x) => (x.id === id ? { ...x, ...changes } : x)));

  // Choosing an order lists its open lines; choosing none leaves one empty line to fill in.
  const loaded = order.data?.id;
  useEffect(() => {
    if (poId && order.data && order.data.id === poId) {
      setRows(order.data.lines.filter((l) => l.status === "open" && l.quantityOutstanding > 0).map((l) => newRow({ poLineId: l.id, label: `Line ${l.lineNumber}: ${lineLabel(l)}`, partId: l.part?.id ?? null, quantity: String(l.quantityOutstanding), include: true })));
    } else if (!poId) {
      setRows([newRow({ include: true })]);
    }
  }, [poId, loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  const used = rows.filter((r) => r.include);
  const ok = !!supplierId && !!receivedOn && used.length > 0 && used.every((r) => (r.poLineId || r.partId || r.material.trim()) && validQty(r.quantity) && (!r.lotNumber.trim() || r.partId));
  const submit = () =>
    mutation.mutate(
      {
        action: "recordReceipt",
        body: {
          supplierId, ...(poId ? { purchaseOrderId: poId } : {}), receivedOn, ...(deliveryNote.trim() ? { deliveryNote: deliveryNote.trim() } : {}), ...(notes.trim() ? { notes: notes.trim() } : {}), clientKey: clientKey.current,
          lines: used.map((r) => ({ ...(r.poLineId ? { poLineId: r.poLineId } : {}), ...(!r.poLineId && r.partId ? { partId: r.partId } : {}), ...(!r.poLineId && r.material.trim() ? { material: r.material.trim() } : {}), quantity: Number(r.quantity), ...(r.lotNumber.trim() ? { lotNumber: r.lotNumber.trim() } : {}) })),
        },
      },
      { onSuccess: (gr) => { onClose(); navigate(receiptPath(gr.id)); } },
    );
  return (
    <Shell title="Record a delivery" mutation={mutation} ok={ok} submitLabel="Record receipt" onClose={onClose} onSubmit={submit}
      intro="What arrived. Name a lot number on a line to make the received lot, so it can be traced and inspected.">
      <SupplierField supplier={supplier ?? purchaseOrder?.supplier} supplierId={supplierId} onChange={(v) => { setSupplierId(v); setPoId(null); }} />
      <div className="grid gap-3 sm:grid-cols-2">
        {purchaseOrder ? <p className="self-end text-sm text-primary-text">Order: <strong>{purchaseOrder.poNumber}</strong></p> : (
          <ComboField label="Against purchase order" value={poId} onChange={setPoId} clearable disabled={!supplierId} placeholder="No order" options={(orders.data ?? []).map((o) => ({ value: o.id, label: o.poNumber }))} />
        )}
        <RHFDatePickerPopout label="Received on" required valueFormat="iso" value={receivedOn} onChange={(v) => setReceivedOn(v ?? "")} maxDate={today()} />
        <Field label="Delivery note" value={deliveryNote} onChange={(e) => setDeliveryNote(e.target.value)} maxLength={100} />
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-secondary-text">Lines</legend>
        {poId && order.isLoading && <p className="text-sm text-secondary-text">Loading the order…</p>}
        {poId && order.data && rows.length === 0 && <p className="text-sm text-secondary-text">This order has nothing outstanding. Choose another order, or record the delivery without one.</p>}
        {rows.map((r, i) => (
          <div key={r.id} className="grid gap-2 rounded-lg border border-border-color p-2 sm:grid-cols-6">
            {r.poLineId ? (
              <label className="flex items-center gap-2 text-sm text-primary-text sm:col-span-6">
                <input type="checkbox" checked={r.include} onChange={(e) => patch(r.id, { include: e.target.checked })} aria-label={`Include ${r.label}`} /> {r.label}
              </label>
            ) : (
              <>
                {can("master_data.read") && <div className="sm:col-span-3"><PartPicker label={`Line ${i + 1} part`} value={r.partId} onChange={(id) => patch(r.id, { partId: id })} clearable /></div>}
                <Field className={can("master_data.read") ? "sm:col-span-3" : "sm:col-span-6"} label={`Line ${i + 1} material`} value={r.material} onChange={(e) => patch(r.id, { material: e.target.value })} maxLength={200} placeholder="If not one of our parts" />
              </>
            )}
            <Field className="sm:col-span-2" label={`Line ${i + 1} quantity received`} required type="number" min="0" step="any" value={r.quantity} onChange={(e) => patch(r.id, { quantity: e.target.value })} disabled={!r.include} />
            <Field className="sm:col-span-3" label={`Line ${i + 1} lot number`} value={r.lotNumber} onChange={(e) => patch(r.id, { lotNumber: e.target.value })} maxLength={60} disabled={!r.include || !r.partId} hint={r.partId ? "Makes the received lot" : r.poLineId ? "A lot is of a part: this order line is a material" : "A lot is of a part: choose the part first"} />
            {!r.poLineId && rows.length > 1 && <div className="flex items-end justify-end"><button type="button" aria-label={`Remove line ${i + 1}`} className="p-2 text-secondary-text hover:text-error-color" onClick={() => setRows((x) => x.filter((y) => y.id !== r.id))}><Trash2Icon /></button></div>}
          </div>
        ))}
        {!poId && <CTAButton buttonType="button" type="secondary" size="default" icon={PlusIcon} className="self-start" onClick={() => setRows((r) => [...r, newRow()])}>Add a line</CTAButton>}
      </fieldset>
      <TextAreaField label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} rows={2} />
    </Shell>
  );
};

export const AgreedDateDialog = ({ line, onClose }) => {
  const mutation = useReceivingMutation();
  const [date, setDate] = useState(line.agreedOn ?? "");
  return (
    <Shell title="Agreed date" width="max-w-md" mutation={mutation} ok submitLabel="Save" onClose={onClose}
      onSubmit={() => mutation.mutate({ action: "agreedDate", id: line.id, body: { agreedOn: date || null } }, { onSuccess: onClose })}
      intro={`Requested for ${formatDate(line.requestedOn)} (that stays). Set the date the supplier has now agreed to, or clear it to go back to the requested date.`}>
      <RHFDatePickerPopout label="Agreed for" valueFormat="iso" clearable value={date} onChange={(v) => setDate(v ?? "")} placeholder="Same as requested" />
    </Shell>
  );
};

/** Asks for a reason, then sends one command (cancel or close). */
export const ReasonDialog = ({ title, intro, label, submitLabel, action, id, onClose }) => {
  const mutation = useReceivingMutation();
  const [reason, setReason] = useState("");
  return (
    <Shell title={title} intro={intro} width="max-w-lg" mutation={mutation} ok={reason.trim().length >= 3} submitLabel={submitLabel} onClose={onClose}
      onSubmit={() => mutation.mutate({ action, id, body: { reason: reason.trim() } }, { onSuccess: onClose })}>
      <TextAreaField label={label} required value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={3} />
    </Shell>
  );
};

