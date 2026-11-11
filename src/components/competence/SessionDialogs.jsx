import { useState } from "react";
import { XIcon } from "@/components/icons";
import CTAButton from "@/components/CTAButton";
import { describeApiError } from "../../lib/api-client";
import { useToast } from "../../contexts/ToastProvider";
import { useCompetenceMutation, useCompetenceSkills } from "../../hooks/useCompetence";
import { useEmployees } from "../../hooks/useNcr";
import { SESSION_KINDS } from "../../lib/competence";
import { todayIso } from "../../lib/localDate";
import { FormError } from "../master-data/shared";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";

const Buttons = ({ onClose, pending, disabled, saveLabel }) => (
  <div className="flex justify-end gap-2">
    <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
      Cancel
    </CTAButton>
    <CTAButton buttonType="submit" type="main" size="md" disabled={pending || disabled} loading={pending}>
      {pending ? "Saving…" : saveLabel}
    </CTAButton>
  </div>
);

export const useSave = (onDone) => {
  const mutation = useCompetenceMutation();
  const { showToast } = useToast();
  const run = (payload) =>
    mutation.mutate(payload, {
      onSuccess: (result) => onDone?.(result),
      onError: (err) => showToast({ type: "error", title: "Not saved", message: describeApiError(err) }),
    });
  return { mutation, run };
};

/** A list of chosen items as removable chips with a combo to add more. */
const ChipPicker = ({ label, items, options, onChange, placeholder, hint }) => {
  const chosen = new Set(items);
  const available = options.filter((o) => !chosen.has(o.value));
  return (
    <div className="flex flex-col gap-2">
      <ComboField label={label} value={null} onChange={(v) => v && onChange([...items, v])} options={available} placeholder={available.length ? placeholder : "Nothing left to add"} disabled={available.length === 0} hint={hint} />
      {items.length > 0 && (
        <ul aria-label={label} className="flex flex-wrap gap-2">
          {items.map((id) => {
            const name = options.find((o) => o.value === id)?.label ?? id;
            return (
              <li key={id} className="flex items-center gap-1 rounded-full bg-secondary-bg px-3 py-1 text-sm text-primary-text">
                {name}
                <button type="button" aria-label={`Remove ${name}`} onClick={() => onChange(items.filter((x) => x !== id))} className="text-icon-color hover:text-error-color">
                  <XIcon className="h-3.5 w-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

/** Create a session (with its attendee list) or edit an open one. Who runs it follows the provider type: a trainer from the employees register, or an outside provider by name. */
export const SessionDialog = ({ existing, onClose, onSaved }) => {
  const { mutation, run } = useSave((result) => {
    onSaved?.(result);
    onClose();
  });
  const employees = useEmployees();
  const skills = useCompetenceSkills();
  const [title, setTitle] = useState(existing?.title ?? "");
  const [kind, setKind] = useState(existing?.kind ?? null);
  const [providerType, setProviderType] = useState(existing?.providerType ?? null);
  const [trainerId, setTrainerId] = useState(existing?.trainer?.id ?? null);
  const [providerName, setProviderName] = useState(existing?.providerName ?? "");
  const [providerContact, setProviderContact] = useState(existing?.providerContact ?? "");
  const [startsOn, setStartsOn] = useState(existing?.startsOn ?? todayIso());
  const [endsOn, setEndsOn] = useState(existing?.endsOn ?? "");
  const [hours, setHours] = useState(existing?.hours ?? "");
  const [location, setLocation] = useState(existing?.location ?? "");
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [skillIds, setSkillIds] = useState(existing?.skills.map((s) => s.id) ?? []);
  const [attendeeIds, setAttendeeIds] = useState([]);

  const active = (employees.data ?? []).filter((e) => e.active).map((e) => ({ value: e.id, label: e.name, hint: e.jobTitle ?? undefined }));
  const skillOptions = (skills.data?.data ?? []).map((s) => ({ value: s.id, label: s.name, hint: s.code }));
  const internal = providerType === "internal";
  const ready = title.trim() && kind && providerType && startsOn && (internal ? trainerId : providerName.trim());

  const save = (e) => {
    e.preventDefault();
    if (!ready) return;
    const body = {
      title: title.trim(),
      kind,
      providerType,
      trainerEmployeeId: internal ? trainerId : null,
      providerName: internal ? null : providerName.trim(),
      providerContact: internal ? null : providerContact.trim() || null,
      startsOn,
      endsOn: endsOn || null,
      hours: hours === "" ? null : Number(hours),
      location: location.trim() || null,
      notes: notes.trim() || null,
      skillIds,
    };
    run(existing ? { action: "updateSession", id: existing.id, body } : { action: "createSession", body: { ...body, employeeIds: attendeeIds } });
  };

  return (
    <Dialog title={existing ? `Edit ${existing.reference}` : "New training session"} onClose={onClose} width="max-w-2xl">
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        <Field label="Title" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} placeholder="e.g. CMM basics" />
        <div className="grid gap-3 sm:grid-cols-2">
          <ComboField label="Kind" required value={kind} onChange={setKind} options={SESSION_KINDS} placeholder="Choose a kind" />
          <ComboField
            label="Run by"
            required
            value={providerType}
            onChange={setProviderType}
            options={[{ value: "internal", label: "Internal (one of our people)" }, { value: "external", label: "External (an outside provider)" }]}
            placeholder="Internal or external"
          />
        </div>
        {providerType === "internal" && <ComboField label="Trainer" required value={trainerId} onChange={setTrainerId} options={active} placeholder="Choose the trainer" />}
        {providerType === "external" && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Provider or trainer" value={providerName} onChange={(e) => setProviderName(e.target.value)} required maxLength={200} placeholder="e.g. Acme Training" />
            <Field label="Contact" value={providerContact} onChange={(e) => setProviderContact(e.target.value)} maxLength={300} hint="Optional" />
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <RHFDatePickerPopout label="Starts on" required value={startsOn} onChange={(v) => setStartsOn(v ?? "")} valueFormat="iso" />
          <RHFDatePickerPopout label="Ends on" value={endsOn} onChange={(v) => setEndsOn(v ?? "")} valueFormat="iso" clearable placeholder="Same day" />
          <Field label="Hours" type="number" min="0" step="0.5" value={hours} onChange={(e) => setHours(e.target.value)} hint="Optional" />
        </div>
        <Field label="Location" value={location} onChange={(e) => setLocation(e.target.value)} maxLength={200} hint="Optional" />
        <ChipPicker label="Skills it supports" items={skillIds} options={skillOptions} onChange={setSkillIds} placeholder="Add a skill" hint="Training is evidence. It does not make anyone competent by itself." />
        {!existing && <ChipPicker label="Attendees" items={attendeeIds} options={active} onChange={setAttendeeIds} placeholder="Add a person" hint="You can add more people later while the session is open." />}
        <Field label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} hint="Optional" />
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={!ready} saveLabel={existing ? "Save" : "Create session"} />
      </form>
    </Dialog>
  );
};

/** Record the same result for the ticked people on one day (call it again on another day for others). */
export const RecordDialog = ({ session, attendees, onClose }) => {
  const { mutation, run } = useSave(onClose);
  const [outcome, setOutcome] = useState("completed");
  const [completedOn, setCompletedOn] = useState(todayIso());
  const [note, setNote] = useState("");
  const dated = outcome !== "absent";
  const ready = (!dated || completedOn) && (outcome !== "failed" || note.trim().length >= 3);
  const save = (e) => {
    e.preventDefault();
    if (!ready) return;
    run({ action: "recordAttendees", id: session.id, body: { attendeeIds: attendees.map((a) => a.id), outcome, completedOn: dated ? completedOn : undefined, note: note.trim() || null } });
  };
  return (
    <Dialog title={`Record a result for ${attendees.length} ${attendees.length === 1 ? "person" : "people"}`} onClose={onClose}>
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        <p className="text-sm text-secondary-text">{attendees.map((a) => a.employee.name).join(", ")}</p>
        <ComboField
          label="Result"
          required
          value={outcome}
          onChange={(v) => setOutcome(v ?? "completed")}
          options={[{ value: "completed", label: "Completed" }, { value: "failed", label: "Failed" }, { value: "absent", label: "Did not attend" }]}
        />
        {dated && <RHFDatePickerPopout label="Completed on" required value={completedOn} onChange={(v) => setCompletedOn(v ?? "")} valueFormat="iso" minDate={new Date(`${session.startsOn}T00:00:00`)} maxDate={new Date()} />}
        <Field label="Note" required={outcome === "failed"} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} hint={outcome === "failed" ? "Say why" : "Optional"} />
        <p className="text-sm text-secondary-text">This does not assess anyone. Record an assessment on their page when they are ready.</p>
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={!ready} saveLabel="Record" />
      </form>
    </Dialog>
  );
};

/** A reason is needed for removing, voiding, reopening and cancelling. */
export const ReasonDialog = ({ title, intro, action, id, confirm, onClose }) => {
  const { mutation, run } = useSave(onClose);
  const [reason, setReason] = useState("");
  const save = (e) => {
    e.preventDefault();
    if (reason.trim().length < 3) return;
    run({ action, id, body: { reason: reason.trim() } });
  };
  return (
    <Dialog title={title} onClose={onClose}>
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        {intro && <p className="text-sm text-secondary-text">{intro}</p>}
        <Field label="Why?" value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={500} />
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={reason.trim().length < 3} saveLabel={confirm} />
      </form>
    </Dialog>
  );
};

export const AddAttendeeDialog = ({ session, onClose }) => {
  const { mutation, run } = useSave(onClose);
  const employees = useEmployees();
  const [employeeId, setEmployeeId] = useState(null);
  const live = new Set(session.attendees.filter((a) => !["removed", "voided"].includes(a.status)).map((a) => a.employee.id));
  const options = (employees.data ?? []).filter((e) => e.active && !live.has(e.id)).map((e) => ({ value: e.id, label: e.name, hint: e.jobTitle ?? undefined }));
  const save = (e) => {
    e.preventDefault();
    if (employeeId) run({ action: "addAttendee", id: session.id, body: { employeeId } });
  };
  return (
    <Dialog title="Add a person" onClose={onClose}>
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        <ComboField label="Person" required value={employeeId} onChange={setEmployeeId} options={options} placeholder={options.length ? "Choose a person" : "Everyone is already on it"} disabled={options.length === 0} />
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={!employeeId} saveLabel="Add" />
      </form>
    </Dialog>
  );
};
