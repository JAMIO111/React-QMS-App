import { useState } from "react";
import CTAButton from "@/components/CTAButton";
import { describeApiError } from "../../lib/api-client";
import { useToast } from "../../contexts/ToastProvider";
import { useAuth } from "../../contexts/AuthProvider";
import { useCustomFieldPeople } from "../../hooks/useCustomFields";
import { useObjectiveMeasures, useObjectiveMutation } from "../../hooks/useManagementReview";
import { DIRECTIONS, FREQUENCIES, formatValue } from "../../lib/qualityObjectives";
import { FormError, TextAreaField } from "../master-data/shared";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";

const Buttons = ({ onClose, pending, disabled, label, type = "main" }) => (
  <div className="flex justify-end gap-2">
    <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
      Cancel
    </CTAButton>
    <CTAButton buttonType="submit" type={type} size="md" disabled={disabled || pending} loading={pending}>
      {label}
    </CTAButton>
  </div>
);

/** Runs one command; closes on success and says why on failure. */
const useRun = (onClose, failed, onSaved) => {
  const mutation = useObjectiveMutation();
  const { showToast } = useToast();
  const run = (command) =>
    mutation.mutate(command, {
      onSuccess: (saved) => {
        onSaved?.(saved);
        onClose();
      },
      onError: (err) => showToast({ type: "error", title: failed, message: describeApiError(err) }),
    });
  return { mutation, run };
};

const numberOrNull = (text) => {
  const t = String(text ?? "").trim().replace(/,/g, "");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
};

/**
 * Define a quality objective, or change one. The measure, frequency and first period are fixed once it exists; a system measure brings its own unit and direction.
 */
export const ObjectiveDialog = ({ existing, onClose, onSaved }) => {
  const { mutation, run } = useRun(onClose, "Not saved", onSaved);
  const measures = useObjectiveMeasures();
  const people = useCustomFieldPeople();
  const { user } = useAuth();
  const [title, setTitle] = useState(existing?.title ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [ownerId, setOwnerId] = useState(existing?.owner?.id ?? user?.id ?? null);
  const [measure, setMeasure] = useState(existing?.measure ?? "manual");
  const [unit, setUnit] = useState(existing?.unit ?? "");
  const [direction, setDirection] = useState(existing?.direction ?? "at_least");
  const [target, setTarget] = useState(existing ? String(existing.target) : "");
  const [frequency, setFrequency] = useState(existing?.frequency ?? "monthly");
  const [startsOn, setStartsOn] = useState(null);

  const list = measures.data?.data ?? [];
  const chosen = list.find((m) => m.key === measure);
  const manual = measure === "manual";
  const options = list.map((m) => ({ value: m.key, label: m.label, hint: m.available ? m.description : "You may not read what this counts", disabled: !m.available && !existing }));
  const personOptions = (people.data ?? []).map((p) => ({ value: p.id, label: p.name }));
  const targetNumber = numberOrNull(target);
  const targetOk = targetNumber !== null && !Number.isNaN(targetNumber) && (manual || chosen?.unit !== "%" || (targetNumber >= 0 && targetNumber <= 100));
  const ready = title.trim() && ownerId && targetOk;

  const save = (e) => {
    e.preventDefault();
    if (!ready) return;
    const body = { title: title.trim(), description: description.trim() || null, ownerId, target: targetNumber };
    if (manual) Object.assign(body, { unit: unit.trim() || null, direction });
    if (!existing) Object.assign(body, { measure, frequency, ...(startsOn ? { startsOn } : {}) });
    run(existing ? { action: "update", id: existing.id, body } : { action: "create", body });
  };

  return (
    <Dialog title={existing ? `Edit ${existing.reference}` : "Define a quality objective"} onClose={onClose} width="max-w-xl">
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        <Field label="Objective" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} placeholder="e.g. Reduce internal non-conformances" />
        <TextAreaField label="Description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} rows={2} hint="Optional: why it matters and how it is measured" />
        <ComboField label="Owner" required value={ownerId} onChange={setOwnerId} options={personOptions} placeholder="Who is responsible for it" />
        <ComboField
          label="Measured by"
          required
          value={measure}
          onChange={(v) => setMeasure(v ?? "manual")}
          options={options}
          disabled={!!existing}
          hint={existing ? "Fixed once the objective exists" : chosen && !manual ? `${chosen.description}. Worked out by the system each period.` : "A value typed in for each period"}
        />
        {manual ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <ComboField label="Met when the value is" required value={direction} onChange={(v) => setDirection(v ?? "at_least")} options={DIRECTIONS} />
            <Field label="Unit" value={unit} onChange={(e) => setUnit(e.target.value)} maxLength={20} placeholder="e.g. %, days, £" hint="Optional" />
          </div>
        ) : (
          chosen && (
            <Callout tone="info">
              Met when the value is {chosen.direction === "at_most" ? "at most" : "at least"} the target, in {chosen.unit}.
            </Callout>
          )
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            label="Target"
            required
            inputMode="decimal"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            error={target.trim() && !targetOk ? (manual || chosen?.unit !== "%" ? "Give a number" : "A percentage is 0 to 100") : undefined}
            hint={targetOk ? formatValue(targetNumber, manual ? unit.trim() || null : chosen?.unit) : undefined}
          />
          <ComboField label="Measured" required value={frequency} onChange={(v) => setFrequency(v ?? "monthly")} options={FREQUENCIES} disabled={!!existing} hint={existing ? "Fixed once the objective exists" : undefined} />
        </div>
        {!existing && (
          <RHFDatePickerPopout label="First period" valueFormat="iso" clearable value={startsOn} onChange={(v) => setStartsOn(v ?? null)} placeholder="The current period" hint="Any day: the period it falls in is the first one" />
        )}
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={!ready} label={existing ? "Save" : "Define it"} />
      </form>
    </Dialog>
  );
};

/** Record the value of a manual objective for one period (newest first). A period that already has a value is corrected, which needs a note. */
export const ValueDialog = ({ objective, onClose }) => {
  const { mutation, run } = useRun(onClose, "Not recorded");
  const periods = [...objective.periods].reverse();
  const [period, setPeriod] = useState(periods[0]?.periodStart ?? null);
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const chosen = periods.find((p) => p.periodStart === period);
  const correcting = chosen?.value !== null && chosen?.value !== undefined;
  const number = numberOrNull(value);
  const ready = period && number !== null && !Number.isNaN(number) && (!correcting || note.trim());
  return (
    <Dialog title={`Record a value for ${objective.reference}`} onClose={onClose}>
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) run({ action: "recordValue", id: objective.id, body: { periodStart: period, value: number, note: note.trim() || null } });
        }}
      >
        <ComboField
          label="Period"
          required
          value={period}
          onChange={setPeriod}
          options={periods.map((p) => ({ value: p.periodStart, label: p.label, hint: p.value !== null && p.value !== undefined ? `Has ${formatValue(p.value, objective.unit)}` : p.current ? "In progress" : undefined }))}
        />
        {correcting && (
          <Callout tone="warning">
            {chosen.label} already has {formatValue(chosen.value, objective.unit)}. A new value replaces it as a correction; the old one is kept.
          </Callout>
        )}
        <Field label={`Value${objective.unit ? ` (${objective.unit})` : ""}`} required inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} error={value.trim() && Number.isNaN(number) ? "Give a number" : undefined} />
        <TextAreaField label={correcting ? "Why is it corrected?" : "Note"} required={correcting} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={2} hint={correcting ? undefined : "Optional: where the figure comes from"} />
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={!ready} label={correcting ? "Record the correction" : "Record it"} />
      </form>
    </Dialog>
  );
};

export const RetireDialog = ({ objective, onClose }) => {
  const { mutation, run } = useRun(onClose, "Not retired");
  const [reason, setReason] = useState("");
  const ok = reason.trim().length >= 3;
  return (
    <Dialog title={`Retire ${objective.reference}`} onClose={onClose}>
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) run({ action: "retire", id: objective.id, body: { reason: reason.trim() } });
        }}
      >
        <p className="text-sm text-secondary-text">Its values are kept. It can be brought back later.</p>
        <TextAreaField label="Why is it retired?" required value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={2} />
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={!ok} label="Retire it" type="danger" />
      </form>
    </Dialog>
  );
};
