import { useState } from "react";
import { HouseIcon } from "@/components/icons";
import { useToast } from "../../contexts/ToastProvider";
import { useMasterDataMutation } from "../../hooks/useMasterData";
import { usePermissions, useSites } from "../../hooks/useQmsApi";
import { LOT_MOVES, LOT_ORIGIN, LOT_STATUS, lotEditable, partLabel } from "../../lib/production";
import { PartPicker, PartyPicker, TextAreaField } from "../ncr/Pickers";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import RHFComboBox from "../ui/RHFComboBox";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";
import { FormError, SelectField } from "../master-data/shared";
import { OrderPicker } from "./pickers";
import { StatusBadge, StatusMoves } from "./shared";
import CTAButton from "@/components/CTAButton";
import CustomFieldsCard, { CustomFieldInputs } from "../custom-fields/CustomFieldsCard";
import { withCustomValues } from "../../lib/customFields";

/**
 * Add or edit a lot. A lot is *produced* (optionally from a production order) or *received* from a supplier. Its number, part, origin and order are fixed once it exists;
 * quantity, notes, supplier (received lots) and received date can change until it is closed. Holding, releasing and closing are separate buttons: a hold needs a reason and
 * never blocks work, it is information for people. `readOnly` shows the details without saving.
 */
const LotDialog = ({ lot, onClose, readOnly = false }) => {
  const creating = !lot;
  const mutation = useMasterDataMutation();
  const { showToast } = useToast();
  const { data: sites } = useSites();
  const siteList = sites?.data ?? [];
  const { can } = usePermissions();
  const [current, setCurrent] = useState(lot);
  const [customValues, setCustomValues] = useState({});
  const [form, setForm] = useState({
    lotNumber: lot?.lotNumber ?? "",
    partId: lot?.part?.id ?? null,
    origin: lot?.origin ?? "produced",
    productionOrderId: lot?.productionOrder?.id ?? null,
    supplierId: lot?.supplier?.id ?? null,
    siteId: lot?.site?.id ?? (siteList.length === 1 ? siteList[0].id : null),
    quantity: lot?.quantity ?? "",
    receivedOn: lot?.receivedOn ?? "",
    notes: lot?.notes ?? "",
  });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const frozen = !creating && !lotEditable(current);
  const disabled = readOnly || frozen;
  const received = form.origin === "received";
  const valid = form.lotNumber.trim() && form.partId && (!form.quantity || Number(form.quantity) > 0);

  const submit = (e) => {
    e.preventDefault();
    const quantity = form.quantity === "" ? null : Number(form.quantity);
    const body = creating
      ? {
          lotNumber: form.lotNumber.trim(),
          partId: form.partId,
          origin: form.origin,
          productionOrderId: received ? null : form.productionOrderId,
          supplierId: received ? form.supplierId : null,
          siteId: form.siteId,
          quantity,
          receivedOn: received ? form.receivedOn || null : null,
          notes: form.notes.trim() || null,
          ...withCustomValues(customValues),
        }
      : { quantity, notes: form.notes.trim() || null, ...(received ? { supplierId: form.supplierId, receivedOn: form.receivedOn || null } : {}) };
    mutation.mutate(
      { path: creating ? "/lots" : `/lots/${lot.id}`, method: creating ? "POST" : "PATCH", body },
      {
        onSuccess: (data) => {
          showToast({ type: "success", title: "Saved", message: `Lot ${data.lotNumber} ${creating ? "created" : "updated"}.` });
          onClose();
        },
      }
    );
  };

  return (
    <Dialog title={creating ? "New lot" : `Lot ${lot.lotNumber}`} onClose={onClose} width="max-w-2xl">
      <form onSubmit={submit} noValidate className="flex flex-col gap-4" aria-label={creating ? "New lot" : "Edit lot"}>
        {!creating && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm text-primary-text">
              <StatusBadge map={LOT_STATUS} status={current.status} />
              {current.statusReason && <span className="text-secondary-text">{current.statusReason}</span>}
            </div>
            {!readOnly && <StatusMoves moves={LOT_MOVES[current.status]} path={`/lots/${lot.id}`} noun="Lot" onDone={setCurrent} />}
          </div>
        )}
        {frozen && <p className="rounded-lg border border-border-color bg-secondary-bg p-2 text-sm text-secondary-text">This lot is closed, so it can no longer be changed.</p>}
        <fieldset disabled={disabled} className="contents">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Lot number" value={form.lotNumber} onChange={set("lotNumber")} required={creating} disabled={!creating || disabled} maxLength={60} hint={creating ? "Unique for the part, e.g. LOT-0042 or a heat number" : "Fixed once created"} />
            {creating ? (
              <SelectField label="Origin" required value={form.origin} onChange={(v) => setForm((f) => ({ ...f, origin: v ?? "produced", productionOrderId: null, supplierId: null }))} options={Object.entries(LOT_ORIGIN).map(([value, label]) => ({ value, label }))} />
            ) : (
              <Field label="Origin" value={LOT_ORIGIN[lot.origin]} disabled readOnly />
            )}
            {creating ? <PartPicker required value={form.partId} onChange={(id) => setForm((f) => ({ ...f, partId: id, productionOrderId: null }))} /> : <Field label="Part" value={partLabel(lot.part)} disabled readOnly hint="Fixed once created" />}
            {received ? (
              <PartyPicker kind="suppliers" label="Supplier" value={form.supplierId} current={lot?.supplier} onChange={(id) => setForm((f) => ({ ...f, supplierId: id }))} />
            ) : creating ? (
              <OrderPicker partId={form.partId} value={form.productionOrderId} onChange={(id) => setForm((f) => ({ ...f, productionOrderId: id }))} />
            ) : (
              <Field label="Production order" value={lot.productionOrder?.orderNumber ?? "—"} disabled readOnly />
            )}
            <Field label="Quantity" type="number" min="1" step="any" value={form.quantity} onChange={set("quantity")} />
            {received && <RHFDatePickerPopout label="Received on" valueFormat="iso" clearable value={form.receivedOn || null} onChange={(d) => setForm((f) => ({ ...f, receivedOn: d ?? "" }))} placeholder="Date received" />}
            {creating && <RHFComboBox label="Site" icon={HouseIcon} placeholder="No site" options={siteList.map((s) => ({ id: s.id, name: `${s.code} · ${s.name}` }))} value={form.siteId} onChange={(id) => setForm((f) => ({ ...f, siteId: id }))} />}
          </div>
          <TextAreaField label="Notes" value={form.notes} onChange={(v) => setForm((f) => ({ ...f, notes: v }))} maxLength={2000} />
        </fieldset>
        {creating && <CustomFieldInputs entityType="lot" values={customValues} onChange={setCustomValues} />}
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" onClick={onClose} type="neutral" size="md">
            {disabled ? "Close" : "Cancel"}
          </CTAButton>
          {!disabled && (
            <CTAButton buttonType="submit" disabled={mutation.isPending || !valid} loading={mutation.isPending} type="main" size="md">
              {mutation.isPending ? "Saving…" : creating ? "Create lot" : "Save changes"}
            </CTAButton>
          )}
        </div>
      </form>
      {!creating && (
        <div className="mt-4">
          <CustomFieldsCard entityType="lot" record={{ ...current, customValues: lot.customValues ?? current.customValues }} editable={!readOnly && can("production.manage") && current.status !== "closed"} />
        </div>
      )}
    </Dialog>
  );
};

export default LotDialog;
