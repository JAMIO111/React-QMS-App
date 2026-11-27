import { useState } from "react";
import CTAButton from "@/components/CTAButton";
import { useEmployees } from "../../hooks/useNcr";
import { useFmeaActionMutation, useFmeaPeople } from "../../hooks/useFmea";
import { ACTION_KINDS, actionOwnerBody, actionOwnerValue, ratingOptions, ratingWords, toLevel } from "../../lib/fmea";
import { todayIso } from "../../lib/localDate";
import { FormError, TextAreaField } from "../master-data/shared";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";
import { employeeOption } from "@/lib/employees";

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

/** Give an action to a member or to an employee of the register (who needs no sign-in), or change an open one. */
export const ActionDialog = ({ cause, existing, onClose }) => {
  const mutation = useFmeaActionMutation();
  const people = useFmeaPeople();
  const employees = useEmployees();
  const [kind, setKind] = useState(existing?.kind ?? "prevention");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [owner, setOwner] = useState(actionOwnerValue(existing?.owner));
  const [dueOn, setDueOn] = useState(existing?.dueOn ?? todayIso(14));
  const options = [
    ...(people.data ?? []).map((p) => ({ value: `u:${p.id}`, label: p.name, hint: "Member", avatar: { name: p.name, path: p.avatarPath ?? null } })),
    ...(employees.data ?? []).filter((e) => e.active).map((e) => employeeOption(e, { as: "field", value: `e:${e.id}`, hint: e.jobTitle ?? "Employee" })),
  ];
  if (owner && !options.some((o) => o.value === owner)) options.push({ value: owner, label: existing?.owner?.name ?? "Unknown", hint: existing?.owner?.kind === "employee" ? "Employee" : "Member" });
  const ready = description.trim().length >= 3 && owner !== "" && dueOn !== "";

  const save = (e) => {
    e.preventDefault();
    if (!ready) return;
    const body = { kind, description: description.trim(), dueOn, ...actionOwnerBody(owner) };
    mutation.mutate(existing ? { action: "update", id: existing.id, body } : { action: "add", id: cause.id, body }, { onSuccess: onClose });
  };

  return (
    <Dialog title={existing ? "Change the action" : "Add an action"} onClose={onClose} width="max-w-2xl">
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        <p className="text-sm text-secondary-text">
          {cause ? <>To lower the risk of “{cause.text}”. </> : null}Say what is to be done, who does it and by when. When it is finished the person records what they found, and the ratings it brings
          the cause to.
        </p>
        <ComboField label="What kind of action" required value={kind} onChange={(v) => setKind(v ?? "prevention")} options={ACTION_KINDS} />
        <TextAreaField label="What is to be done" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} rows={3} required />
        <ComboField label="Who does it" required value={owner || null} onChange={(v) => setOwner(v ?? "")} options={options} placeholder="Choose a person" hint="Someone from the Employees register needs no sign-in; if they have one, they are told" />
        <RHFDatePickerPopout label="Due" required value={dueOn} onChange={(v) => setDueOn(v ?? "")} valueFormat="iso" minDate={existing ? undefined : new Date(`${todayIso()}T00:00:00`)} />
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={!ready} label={existing ? "Save" : "Add the action"} />
      </form>
    </Dialog>
  );
};

/**
 * Finish an action: what was found (needed), and optionally the occurrence and detection the cause comes to now. The database works out the RPN and the priority from those.
 */
export const CompleteActionDialog = ({ action, cause, scale, onClose }) => {
  const mutation = useFmeaActionMutation();
  const [note, setNote] = useState("");
  const [occurrence, setOccurrence] = useState("");
  const [detection, setDetection] = useState("");
  const ready = note.trim().length >= 3;
  const send = (e) => {
    e.preventDefault();
    if (!ready) return;
    const body = { note: note.trim(), revisedOccurrence: toLevel(occurrence) ?? undefined, revisedDetection: toLevel(detection) ?? undefined };
    mutation.mutate({ action: "complete", id: action.id, body }, { onSuccess: onClose });
  };
  return (
    <Dialog title="Finish the action" onClose={onClose} width="max-w-2xl">
      <form noValidate onSubmit={send} className="flex flex-col gap-3">
        <p className="text-sm text-secondary-text">{action.description}</p>
        <TextAreaField label="What was found" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={3} required hint="What was done and what it showed: the evidence the team will rely on" />
        {cause && scale ? (
          <>
            <p className="text-sm text-secondary-text">
              If this changes the rating, say what it comes to now. Today the cause is rated occurrence {ratingWords(scale.occurrence, cause.occurrence)} and detection {ratingWords(scale.detection, cause.detection)}.
              Leave a rating empty when the action does not change it.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <ComboField label="Occurrence now (O)" value={occurrence || null} onChange={(v) => setOccurrence(v ?? "")} options={ratingOptions(scale.occurrence)} clearable placeholder="Unchanged" />
              <ComboField label="Detection now (D)" value={detection || null} onChange={(v) => setDetection(v ?? "")} options={ratingOptions(scale.detection)} clearable placeholder="Unchanged" />
            </div>
          </>
        ) : (
          <p className="text-sm text-secondary-text">The team works out what ratings it brings the cause to when they next revise the analysis.</p>
        )}
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={!ready} label="Mark as done" type="success" />
      </form>
    </Dialog>
  );
};

/** Cancel an open action, with a reason. */
export const CancelActionDialog = ({ action, onClose }) => {
  const mutation = useFmeaActionMutation();
  const [reason, setReason] = useState("");
  const send = (e) => {
    e.preventDefault();
    mutation.mutate({ action: "cancel", id: action.id, body: { reason: reason.trim() } }, { onSuccess: onClose });
  };
  return (
    <Dialog title="Cancel the action" onClose={onClose}>
      <form noValidate onSubmit={send} className="flex flex-col gap-3">
        <p className="text-sm text-secondary-text">{action.description}</p>
        <TextAreaField label="Why is it cancelled?" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={3} required />
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={reason.trim().length < 3} label="Cancel the action" type="danger" />
      </form>
    </Dialog>
  );
};
