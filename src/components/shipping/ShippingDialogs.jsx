import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PlusIcon, Trash2Icon } from "@/components/icons";
import { todayIso } from "@/lib/localDate";
import { useOrderLookup, useCustomerOrder, useShippingMutation } from "../../hooks/useShipping";
import { formatDate } from "../../lib/ncr";
import { orderPath, partLabel, shipmentPath } from "../../lib/shipping";
import { newClientKey } from "../../lib/supplierScars";
import CTAButton from "../CTAButton";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";
import { PartPicker, PartyPicker } from "../ncr/Pickers";
import { FormError, TextAreaField } from "../master-data/shared";

const today = () => todayIso();
const inDays = (n) => todayIso(n);
let rowId = 0;
const newRow = (over = {}) => ({ id: ++rowId, partId: null, quantity: "", unit: "", requestedOn: inDays(14), agreedOn: "", lotNumber: "", orderLineId: null, label: null, include: true, ...over });
const num = (v) => (v === "" || v === null ? null : Number(v));
const validQty = (v) => Number.isFinite(num(v)) && num(v) > 0;

const Shell = ({ title, intro, mutation, ok, submitLabel, onClose, onSubmit, width = "max-w-3xl", children }) => (
  <Dialog title={title} onClose={onClose} width={width}>
    <form noValidate className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (ok && !mutation.isPending) onSubmit(); }}>
      {intro && <p className="text-sm text-secondary-text">{intro}</p>}
      {children}
      <FormError error={mutation.error} />
      <div className="flex justify-end gap-2">
        <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
        <CTAButton buttonType="submit" type="main" size="lg" disabled={!ok || mutation.isPending} loading={mutation.isPending}>{mutation.isPending ? "Saving…" : submitLabel}</CTAButton>
      </div>
    </form>
  </Dialog>
);

const CustomerField = ({ customer, customerId, onChange }) =>
  customer ? <p className="text-sm text-primary-text">Customer: <strong>{customer.displayName || customer.name}</strong></p> : <PartyPicker kind="customers" label="Customer" required value={customerId} onChange={onChange} />;

/** Record a customer order: who from, its number, the customer's own order number, and the lines (a part of ours, a quantity, the date the customer asked for). */
export const CreateOrderDialog = ({ customer = null, onClose }) => {
  const navigate = useNavigate();
  const mutation = useShippingMutation();
  const [customerId, setCustomerId] = useState(customer?.id ?? null);
  const [orderNumber, setOrderNumber] = useState("");
  const [customerReference, setCustomerReference] = useState("");
  const [orderedOn, setOrderedOn] = useState(today());
  const [notes, setNotes] = useState("");
  const [rows, setRows] = useState([newRow()]);
  const patch = (id, changes) => setRows((r) => r.map((x) => (x.id === id ? { ...x, ...changes } : x)));
  const rowOk = (r) => r.partId && validQty(r.quantity) && r.requestedOn;
  const ok = !!customerId && orderNumber.trim() && rows.length > 0 && rows.every(rowOk);
  const submit = () =>
    mutation.mutate(
      {
        action: "createOrder",
        body: {
          customerId, orderNumber: orderNumber.trim(), orderedOn, ...(customerReference.trim() ? { customerReference: customerReference.trim() } : {}), ...(notes.trim() ? { notes: notes.trim() } : {}),
          lines: rows.map((r) => ({ partId: r.partId, quantity: Number(r.quantity), ...(r.unit.trim() ? { unit: r.unit.trim() } : {}), requestedOn: r.requestedOn, ...(r.agreedOn ? { agreedOn: r.agreedOn } : {}) })),
        },
      },
      { onSuccess: (o) => { onClose(); navigate(orderPath(o.id)); } },
    );
  return (
    <Shell title="Record a customer order" mutation={mutation} ok={ok} submitLabel="Record order" onClose={onClose} onSubmit={submit}
      intro="What the customer ordered, and the date each line was asked for. That date never changes; the date you confirm to them can.">
      <CustomerField customer={customer} customerId={customerId} onChange={setCustomerId} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Order number" required value={orderNumber} onChange={(e) => setOrderNumber(e.target.value)} maxLength={40} />
        <Field label="Customer's order number" value={customerReference} onChange={(e) => setCustomerReference(e.target.value)} maxLength={60} hint="Their own purchase order number" />
        <RHFDatePickerPopout label="Ordered on" valueFormat="iso" value={orderedOn} onChange={(v) => setOrderedOn(v ?? "")} />
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-secondary-text">Lines</legend>
        {rows.map((r, i) => (
          <div key={r.id} className="grid gap-2 rounded-lg border border-border-color p-2 sm:grid-cols-6">
            <div className="sm:col-span-3"><PartPicker label={`Line ${i + 1} part`} required value={r.partId} onChange={(id) => patch(r.id, { partId: id })} /></div>
            <Field className="sm:col-span-2" label={`Line ${i + 1} quantity`} required type="number" min="0" step="any" value={r.quantity} onChange={(e) => patch(r.id, { quantity: e.target.value })} />
            <Field label={`Line ${i + 1} unit`} value={r.unit} onChange={(e) => patch(r.id, { unit: e.target.value })} maxLength={20} placeholder="pcs…" />
            <div className="sm:col-span-3"><RHFDatePickerPopout label={`Line ${i + 1} requested for`} required valueFormat="iso" value={r.requestedOn} onChange={(v) => patch(r.id, { requestedOn: v ?? "" })} /></div>
            <div className="sm:col-span-2"><RHFDatePickerPopout label={`Line ${i + 1} confirmed for`} valueFormat="iso" clearable value={r.agreedOn} onChange={(v) => patch(r.id, { agreedOn: v ?? "" })} placeholder="Same as requested" /></div>
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
 * Record a shipment. Against an order, the lines it still expects are listed with the outstanding quantity ready to confirm; without one, add the parts by hand.
 * A lot number on a line must be an existing lot of that part (a shipment never makes a lot). Shipping more than was ordered is allowed.
 */
export const RecordShipmentDialog = ({ customer = null, customerOrder = null, onClose }) => {
  const navigate = useNavigate();
  const mutation = useShippingMutation();
  const clientKey = useRef(newClientKey());
  const [customerId, setCustomerId] = useState(customer?.id ?? customerOrder?.customer?.id ?? null);
  const [orderId, setOrderId] = useState(customerOrder?.id ?? null);
  const orders = useOrderLookup({ customerId, enabled: !customerOrder });
  const order = useCustomerOrder(orderId);
  const [shippedOn, setShippedOn] = useState(today());
  const [deliveryNote, setDeliveryNote] = useState("");
  const [notes, setNotes] = useState("");
  const [rows, setRows] = useState([]);
  const patch = (id, changes) => setRows((r) => r.map((x) => (x.id === id ? { ...x, ...changes } : x)));

  // Choosing an order lists its open lines; choosing none leaves one empty line to fill in.
  const loaded = order.data?.id;
  useEffect(() => {
    if (orderId && order.data && order.data.id === orderId) {
      setRows(order.data.lines.filter((l) => l.status === "open" && l.quantityOutstanding > 0).map((l) => newRow({ orderLineId: l.id, label: `Line ${l.lineNumber}: ${partLabel(l.part)}`, partId: l.part.id, quantity: String(l.quantityOutstanding), include: true })));
    } else if (!orderId) {
      setRows([newRow({ include: true })]);
    }
  }, [orderId, loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  const used = rows.filter((r) => r.include);
  const ok = !!customerId && !!shippedOn && used.length > 0 && used.every((r) => (r.orderLineId || r.partId) && validQty(r.quantity));
  const submit = () =>
    mutation.mutate(
      {
        action: "recordShipment",
        body: {
          customerId, ...(orderId ? { customerOrderId: orderId } : {}), shippedOn, ...(deliveryNote.trim() ? { deliveryNote: deliveryNote.trim() } : {}), ...(notes.trim() ? { notes: notes.trim() } : {}), clientKey: clientKey.current,
          lines: used.map((r) => ({ ...(r.orderLineId ? { orderLineId: r.orderLineId } : { partId: r.partId }), quantity: Number(r.quantity), ...(r.lotNumber.trim() ? { lotNumber: r.lotNumber.trim() } : {}) })),
        },
      },
      { onSuccess: (s) => { onClose(); navigate(shipmentPath(s.id)); } },
    );
  return (
    <Shell title="Record a shipment" mutation={mutation} ok={ok} submitLabel="Record shipment" onClose={onClose} onSubmit={submit}
      intro="What left. Name a lot number on a line to say which lot it came from, so a customer problem can be traced to it. The lot must already exist.">
      <CustomerField customer={customer ?? customerOrder?.customer} customerId={customerId} onChange={(v) => { setCustomerId(v); setOrderId(null); }} />
      <div className="grid gap-3 sm:grid-cols-3">
        {customerOrder ? <p className="self-end text-sm text-primary-text">Order: <strong>{customerOrder.orderNumber}</strong></p> : (
          <ComboField label="Against customer order" value={orderId} onChange={setOrderId} clearable disabled={!customerId} placeholder="No order" options={(orders.data ?? []).map((o) => ({ value: o.id, label: o.orderNumber }))} />
        )}
        <RHFDatePickerPopout label="Shipped on" required valueFormat="iso" value={shippedOn} onChange={(v) => setShippedOn(v ?? "")} maxDate={today()} />
        <Field label="Delivery note" value={deliveryNote} onChange={(e) => setDeliveryNote(e.target.value)} maxLength={100} />
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-secondary-text">Lines</legend>
        {orderId && order.isLoading && <p className="text-sm text-secondary-text">Loading the order…</p>}
        {orderId && order.data && rows.length === 0 && <p className="text-sm text-secondary-text">This order has nothing outstanding. Choose another order, or record the shipment without one.</p>}
        {rows.map((r, i) => (
          <div key={r.id} className="grid gap-2 rounded-lg border border-border-color p-2 sm:grid-cols-6">
            {r.orderLineId ? (
              <label className="flex items-center gap-2 text-sm text-primary-text sm:col-span-6">
                <input type="checkbox" checked={r.include} onChange={(e) => patch(r.id, { include: e.target.checked })} aria-label={`Include ${r.label}`} /> {r.label}
              </label>
            ) : (
              <div className="sm:col-span-6"><PartPicker label={`Line ${i + 1} part`} required value={r.partId} onChange={(id) => patch(r.id, { partId: id })} /></div>
            )}
            <Field className="sm:col-span-2" label={`Line ${i + 1} quantity shipped`} required type="number" min="0" step="any" value={r.quantity} onChange={(e) => patch(r.id, { quantity: e.target.value })} disabled={!r.include} />
            <Field className="sm:col-span-3" label={`Line ${i + 1} lot number`} value={r.lotNumber} onChange={(e) => patch(r.id, { lotNumber: e.target.value })} maxLength={60} disabled={!r.include} hint="An existing lot of this part" />
            {!r.orderLineId && rows.length > 1 && <div className="flex items-end justify-end"><button type="button" aria-label={`Remove line ${i + 1}`} className="p-2 text-secondary-text hover:text-error-color" onClick={() => setRows((x) => x.filter((y) => y.id !== r.id))}><Trash2Icon /></button></div>}
          </div>
        ))}
        {!orderId && <CTAButton buttonType="button" type="secondary" size="default" icon={PlusIcon} className="self-start" onClick={() => setRows((r) => [...r, newRow()])}>Add a line</CTAButton>}
      </fieldset>
      <TextAreaField label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} rows={2} />
    </Shell>
  );
};

export const AgreedDateDialog = ({ line, onClose }) => {
  const mutation = useShippingMutation();
  const [date, setDate] = useState(line.agreedOn ?? "");
  return (
    <Shell title="Confirmed date" width="max-w-md" mutation={mutation} ok submitLabel="Save" onClose={onClose}
      onSubmit={() => { mutation.mutate({ action: "agreedDate", id: line.id, body: { agreedOn: date || null } }); onClose(); }}
      intro={`Requested for ${formatDate(line.requestedOn)} (that stays). Set the date confirmed to the customer, or clear it to go back to the requested date.`}>
      <RHFDatePickerPopout label="Confirmed for" valueFormat="iso" clearable value={date} onChange={(v) => setDate(v ?? "")} placeholder="Same as requested" />
    </Shell>
  );
};

/** Asks for a reason, then sends one command (cancel an order or a shipment). Both show at once; a refusal is put back with a toast (useShippingMutation). */
export const ReasonDialog = ({ title, intro, label, submitLabel, action, id, onClose }) => {
  const mutation = useShippingMutation();
  const [reason, setReason] = useState("");
  return (
    <Shell title={title} intro={intro} width="max-w-lg" mutation={mutation} ok={reason.trim().length >= 3} submitLabel={submitLabel} onClose={onClose}
      onSubmit={() => { mutation.mutate({ action, id, body: { reason: reason.trim() } }); onClose(); }}>
      <TextAreaField label={label} required value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={3} />
    </Shell>
  );
};
