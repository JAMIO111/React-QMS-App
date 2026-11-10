import { useState } from "react";
import { useToast } from "../../contexts/ToastProvider";
import { useMasterDataMutation } from "../../hooks/useMasterData";
import { MAX_SERIAL_BATCH, SERIAL_MOVES, SERIAL_STATUS, parseSerialList, rangeNumbers, serialEditable, partLabel } from "../../lib/production";
import { PartPicker, TextAreaField } from "../ncr/Pickers";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import { FormError } from "../master-data/shared";
import { LotPicker, OrderPicker } from "./pickers";
import { StatusBadge, StatusMoves } from "./shared";
import CTAButton from "@/components/CTAButton";
import SlidingToggle from "../ui/SlidingToggle";

const MODES = [
  { id: "single", label: "One" },
  { id: "list", label: "A list" },
  { id: "range", label: "A range" },
];

/**
 * Add serial numbers (one, a pasted list, or a numbered range such as SN-0001 … SN-0050, all or nothing, at most 500) or edit one. A serial number is for one part; naming its
 * lot also gives it that lot's order. Once made, the number and part are fixed; the lot, order and notes can change until it is scrapped.
 */
const SerialDialog = ({ serial, onClose, readOnly = false }) => {
  const creating = !serial;
  const mutation = useMasterDataMutation();
  const { showToast } = useToast();
  const [current, setCurrent] = useState(serial);
  const [mode, setMode] = useState("single");
  const [form, setForm] = useState({
    partId: serial?.part?.id ?? null,
    lotId: serial?.lot?.id ?? null,
    productionOrderId: serial?.productionOrder?.id ?? null,
    serialNumber: "",
    list: "",
    prefix: "",
    from: "1",
    to: "10",
    pad: "4",
    notes: serial?.notes ?? "",
  });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const frozen = !creating && !serialEditable(current);
  const disabled = readOnly || frozen;

  const listed = parseSerialList(form.list);
  const ranged = rangeNumbers({ prefix: form.prefix, from: form.from, to: form.to, pad: form.pad });
  const numbers = mode === "single" ? (form.serialNumber.trim() ? [form.serialNumber.trim()] : []) : mode === "list" ? listed : ranged;
  const tooMany = numbers.length > MAX_SERIAL_BATCH;
  const valid = creating ? !!form.partId && numbers.length > 0 && !tooMany : true;
  const preview = numbers.length > 3 ? `${numbers[0]} … ${numbers[numbers.length - 1]}` : numbers.join(", ");

  const submit = (e) => {
    e.preventDefault();
    const shared = { lotId: form.lotId, productionOrderId: form.productionOrderId, notes: form.notes.trim() || null };
    const body = creating
      ? { partId: form.partId, ...shared, ...(mode === "single" ? { serialNumber: numbers[0] } : { serials: numbers }) }
      : shared;
    mutation.mutate(
      { path: creating ? "/serial-numbers" : `/serial-numbers/${serial.id}`, method: creating ? "POST" : "PATCH", body },
      {
        onSuccess: (data) => {
          const count = creating ? data.data.length : 1;
          showToast({ type: "success", title: "Saved", message: creating ? `${count} serial number${count === 1 ? "" : "s"} added.` : `Serial number ${data.serialNumber} updated.` });
          onClose();
        },
      }
    );
  };

  return (
    <Dialog title={creating ? "New serial numbers" : `Serial number ${serial.serialNumber}`} onClose={onClose} width="max-w-2xl">
      <form onSubmit={submit} noValidate className="flex flex-col gap-4" aria-label={creating ? "New serial numbers" : "Edit serial number"}>
        {!creating && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm text-primary-text">
              <StatusBadge map={SERIAL_STATUS} status={current.status} />
              {current.statusReason && <span className="text-secondary-text">{current.statusReason}</span>}
            </div>
            {!readOnly && <StatusMoves moves={SERIAL_MOVES[current.status]} path={`/serial-numbers/${serial.id}`} noun="Serial number" onDone={setCurrent} />}
          </div>
        )}
        {frozen && <p className="rounded-lg border border-border-color bg-secondary-bg p-2 text-sm text-secondary-text">This serial number is scrapped, so it can no longer be changed.</p>}
        <fieldset disabled={disabled} className="contents">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {creating ? <PartPicker required value={form.partId} onChange={(id) => setForm((f) => ({ ...f, partId: id, lotId: null, productionOrderId: null }))} /> : <Field label="Part" value={partLabel(serial.part)} disabled readOnly hint="Fixed once created" />}
            <LotPicker
              partId={form.partId}
              value={form.lotId}
              current={serial?.lot}
              disabled={!form.partId}
              onChange={(id, item) => setForm((f) => ({ ...f, lotId: id, productionOrderId: item?.productionOrder?.id ?? f.productionOrderId }))}
            />
            <OrderPicker partId={form.partId} value={form.productionOrderId} current={serial?.productionOrder} disabled={!form.partId} onChange={(id) => setForm((f) => ({ ...f, productionOrderId: id }))} />
          </div>
          {creating && (
            <div className="flex flex-col gap-3 rounded-xl border border-border-color p-3">
              <SlidingToggle ariaLabel="How many" mode="tabs" options={MODES.map((m) => ({ value: m.id, label: m.label }))} value={mode} onChange={setMode} />
              {mode === "single" && <Field label="Serial number" required value={form.serialNumber} onChange={set("serialNumber")} maxLength={60} hint="Unique for the part" />}
              {mode === "list" && <TextAreaField label="Serial numbers" required value={form.list} onChange={(v) => setForm((f) => ({ ...f, list: v }))} rows={4} hint="One per line, or separated by commas or spaces" />}
              {mode === "range" && (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Field label="Prefix" value={form.prefix} onChange={set("prefix")} maxLength={40} placeholder="SN-" />
                  <Field label="From" type="number" min="0" required value={form.from} onChange={set("from")} />
                  <Field label="To" type="number" min="0" required value={form.to} onChange={set("to")} />
                  <Field label="Digits" type="number" min="0" max="12" value={form.pad} onChange={set("pad")} hint="Zeros to pad to" />
                </div>
              )}
              <p className={`text-sm ${tooMany ? "text-error-color" : "text-secondary-text"}`} aria-live="polite">
                {tooMany ? `That is ${numbers.length.toLocaleString()}; at most ${MAX_SERIAL_BATCH} at a time.` : numbers.length ? `${numbers.length.toLocaleString()} serial number${numbers.length === 1 ? "" : "s"}: ${preview}` : "Nothing to add yet."}
              </p>
            </div>
          )}
          <TextAreaField label="Notes" value={form.notes} onChange={(v) => setForm((f) => ({ ...f, notes: v }))} maxLength={2000} />
        </fieldset>
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" onClick={onClose} type="neutral" size="md">
            {disabled ? "Close" : "Cancel"}
          </CTAButton>
          {!disabled && (
            <CTAButton buttonType="submit" disabled={mutation.isPending || !valid} loading={mutation.isPending} type="main" size="md">
              {mutation.isPending ? "Saving…" : creating ? `Add ${numbers.length || ""} serial number${numbers.length === 1 ? "" : "s"}`.replace("  ", " ") : "Save changes"}
            </CTAButton>
          )}
        </div>
      </form>
    </Dialog>
  );
};

export default SerialDialog;
