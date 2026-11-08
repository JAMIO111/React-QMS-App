import { useState } from "react";
import { HouseIcon } from "@/components/icons";
import { useToast } from "../../contexts/ToastProvider";
import { useMasterDataMutation } from "../../hooks/useMasterData";
import { useSites } from "../../hooks/useQmsApi";
import { orderEditable, partLabel } from "../../lib/production";
import { PartPicker, PartyPicker, RevisionPicker, TextAreaField } from "../ncr/Pickers";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import RHFComboBox from "../ui/RHFComboBox";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";
import { FormError } from "../master-data/shared";
import CTAButton from "@/components/CTAButton";


/**
 * Add or edit a production order. The number, part and site are fixed once the order exists (everything made for it is checked against them); the revision it was released on,
 * customer, quantity, due date and notes can change until the order is closed or cancelled. `readOnly` shows the details without saving.
 */
const OrderDialog = ({ order, onClose, readOnly = false, onSaved }) => {
  const creating = !order;
  const frozen = !creating && !orderEditable(order);
  const mutation = useMasterDataMutation();
  const { showToast } = useToast();
  const { data: sites } = useSites();
  const siteList = sites?.data ?? [];
  const [form, setForm] = useState({
    orderNumber: order?.orderNumber ?? "",
    partId: order?.part?.id ?? null,
    partRevisionId: order?.partRevision?.id ?? null,
    customerId: order?.customer?.id ?? null,
    siteId: order?.site?.id ?? (siteList.length === 1 ? siteList[0].id : null),
    quantityPlanned: order?.quantityPlanned ?? "",
    dueDate: order?.dueDate ?? "",
    notes: order?.notes ?? "",
  });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const disabled = readOnly || frozen;
  const quantity = Number(form.quantityPlanned);
  const valid = form.orderNumber.trim() && form.partId && quantity > 0;

  const submit = (e) => {
    e.preventDefault();
    const shared = { partRevisionId: form.partRevisionId, customerId: form.customerId, quantityPlanned: quantity, dueDate: form.dueDate || null, notes: form.notes.trim() || null };
    const body = creating ? { orderNumber: form.orderNumber.trim(), partId: form.partId, siteId: form.siteId, ...shared } : shared;
    mutation.mutate(
      { path: creating ? "/production-orders" : `/production-orders/${order.id}`, method: creating ? "POST" : "PATCH", body },
      {
        onSuccess: (data) => {
          showToast({ type: "success", title: "Saved", message: `Order ${data.orderNumber} ${creating ? "created" : "updated"}.` });
          onSaved?.(data);
          onClose();
        },
      }
    );
  };

  return (
    <Dialog title={creating ? "New production order" : `Order ${order.orderNumber}`} onClose={onClose} width="max-w-2xl">
      <form onSubmit={submit} noValidate className="flex flex-col gap-4" aria-label={creating ? "New production order" : "Edit production order"}>
        {frozen && <p className="rounded-lg border border-border-color bg-secondary-bg p-2 text-sm text-secondary-text">This order is {order.status}, so it can no longer be changed.</p>}
        <fieldset disabled={disabled} className="contents">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Order number" value={form.orderNumber} onChange={set("orderNumber")} required={creating} disabled={!creating || disabled} maxLength={60} hint={creating ? "Unique in the organisation, e.g. WO-1001" : "Fixed once created"} />
            <Field label="Quantity planned" type="number" min="1" step="any" value={form.quantityPlanned} onChange={set("quantityPlanned")} required />
            {creating ? (
              <PartPicker required value={form.partId} onChange={(id) => setForm((f) => ({ ...f, partId: id, partRevisionId: null }))} />
            ) : (
              <Field label="Part" value={partLabel(order.part)} disabled readOnly hint="Fixed once created" />
            )}
            <RevisionPicker partId={form.partId} value={form.partRevisionId} disabled={disabled} label="Revision released on" onChange={(id) => setForm((f) => ({ ...f, partRevisionId: id }))} />
            <PartyPicker kind="customers" label="Customer" value={form.customerId} current={order?.customer} onChange={(id) => setForm((f) => ({ ...f, customerId: id }))} />
            {creating ? (
              <RHFComboBox label="Site" icon={HouseIcon} placeholder="No site" options={siteList.map((s) => ({ id: s.id, name: `${s.code} · ${s.name}` }))} value={form.siteId} onChange={(id) => setForm((f) => ({ ...f, siteId: id }))} />
            ) : (
              <Field label="Site" value={order.site?.name ?? "—"} disabled readOnly hint="Fixed once created" />
            )}
            <RHFDatePickerPopout label="Due date" valueFormat="iso" clearable value={form.dueDate || null} onChange={(d) => setForm((f) => ({ ...f, dueDate: d ?? "" }))} placeholder="No due date" />
          </div>
          <TextAreaField label="Notes" value={form.notes} onChange={(v) => setForm((f) => ({ ...f, notes: v }))} maxLength={2000} />
        </fieldset>
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" onClick={onClose} type="neutral" size="md">
            {disabled ? "Close" : "Cancel"}
          </CTAButton>
          {!disabled && (
            <CTAButton buttonType="submit" disabled={mutation.isPending || !valid} type="main" size="md">
              {mutation.isPending ? "Saving…" : creating ? "Create order" : "Save changes"}
            </CTAButton>
          )}
        </div>
      </form>
    </Dialog>
  );
};

export default OrderDialog;
