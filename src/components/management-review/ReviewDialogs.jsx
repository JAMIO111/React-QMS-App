import { useState } from "react";
import CTAButton from "@/components/CTAButton";
import { PlusIcon, XIcon } from "@/components/icons";
import { describeApiError } from "../../lib/api-client";
import { useToast } from "../../contexts/ToastProvider";
import { useAuth } from "../../contexts/AuthProvider";
import { useCustomFieldPeople } from "../../hooks/useCustomFields";
import { useReviewMutation } from "../../hooks/useManagementReview";
import { ATTENDANCE, DECISION_CATEGORIES } from "../../lib/qualityObjectives";
import { FormError, TextAreaField } from "../master-data/shared";
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

/** Runs one review command: closes on success, says why on failure. */
const useReviewCommand = (onClose, failed = "Not saved", onSaved) => {
  const mutation = useReviewMutation();
  const { showToast } = useToast();
  const run = (command) =>
    mutation.mutate(command, {
      onSuccess: (saved) => {
        onSaved?.(saved);
        onClose?.();
      },
      onError: (err) => showToast({ type: "error", title: failed, message: describeApiError(err) }),
    });
  return { mutation, run };
};

const usePeople = () => (useCustomFieldPeople().data ?? []).map((p) => ({ value: p.id, label: p.name }));

/** Plan a review (or change its details): title, the period it reviews, when, who chairs it. The period is fixed once it starts. */
export const PlanReviewDialog = ({ existing, onClose, onSaved }) => {
  const { mutation, run } = useReviewCommand(onClose, "Not saved", onSaved);
  const { user } = useAuth();
  const people = usePeople();
  const started = existing && existing.status !== "planned";
  const [title, setTitle] = useState(existing?.title ?? "");
  const [from, setFrom] = useState(existing?.periodFrom ?? null);
  const [to, setTo] = useState(existing?.periodTo ?? null);
  const [plannedOn, setPlannedOn] = useState(existing?.plannedOn ?? null);
  const [heldOn, setHeldOn] = useState(existing?.heldOn ?? null);
  const [chairId, setChairId] = useState(existing?.chair?.id ?? user?.id ?? null);
  const ready = title.trim() && from && to && from <= to && chairId;
  const save = (e) => {
    e.preventDefault();
    if (!ready) return;
    const body = { title: title.trim(), plannedOn: plannedOn ?? null, chairId };
    if (!started) Object.assign(body, { periodFrom: from, periodTo: to });
    if (started && heldOn) body.heldOn = heldOn;
    run(existing ? { action: "update", id: existing.id, body } : { action: "plan", body });
  };
  return (
    <Dialog title={existing ? `Edit ${existing.reference}` : "Plan a management review"} onClose={onClose} width="max-w-xl">
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        <Field label="Title" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} placeholder="e.g. Management review, first half of 2026" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <RHFDatePickerPopout label="Reviews the period from" required valueFormat="iso" value={from} onChange={(v) => setFrom(v ?? null)} disabled={started} hint={started ? "Fixed once it has started" : undefined} />
          <RHFDatePickerPopout label="To" required valueFormat="iso" value={to} onChange={(v) => setTo(v ?? null)} disabled={started} minDate={from ? new Date(`${from}T00:00:00`) : undefined} />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <RHFDatePickerPopout label="Planned for" valueFormat="iso" clearable value={plannedOn} onChange={(v) => setPlannedOn(v ?? null)} />
          {started && <RHFDatePickerPopout label="Held on" valueFormat="iso" allowFuture={false} value={heldOn} onChange={(v) => setHeldOn(v ?? null)} />}
        </div>
        <ComboField label="Chair" required value={chairId} onChange={setChairId} options={people} placeholder="Who chairs it" />
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={!ready} label={existing ? "Save" : "Plan it"} />
      </form>
    </Dialog>
  );
};

/** Attendees, replaced as a whole: members or named outsiders, a role and whether they were present (only once the review has started). */
export const AttendeesDialog = ({ review, onClose }) => {
  const { mutation, run } = useReviewCommand(onClose);
  const people = usePeople();
  const started = review.status === "in_progress";
  const [rows, setRows] = useState(() => review.attendees.map((a) => ({ userId: a.userId, name: a.outsider ? a.name : "", role: a.role ?? "", attendance: a.attendance })));
  const [adding, setAdding] = useState(null);
  const [guest, setGuest] = useState("");
  const set = (i, patch) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const nameOf = (r) => (r.userId ? (people.find((p) => p.value === r.userId)?.label ?? "Member") : r.name);
  const chosen = new Set(rows.map((r) => r.userId).filter(Boolean));
  return (
    <Dialog title="Attendees" onClose={onClose} width="max-w-2xl">
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          run({
            action: "setAttendees",
            id: review.id,
            body: { attendees: rows.map((r) => ({ ...(r.userId ? { userId: r.userId } : { name: r.name.trim() }), role: r.role.trim() || null, attendance: started ? r.attendance : "invited" })) },
          });
        }}
      >
        {rows.length === 0 && <p className="text-sm text-secondary-text">No one yet.</p>}
        <ul aria-label="Attendees" className="flex flex-col gap-2">
          {rows.map((r, i) => (
            <li key={r.userId ?? `guest-${i}`} className="grid grid-cols-1 items-end gap-2 rounded-xl border border-border-color p-2 sm:grid-cols-[1fr_1fr_10rem_auto]">
              <span className="pb-2 text-sm font-medium text-primary-text">
                {nameOf(r)}
                {!r.userId && <span className="block text-xs font-normal text-secondary-text">From outside</span>}
              </span>
              <Field label="Role" value={r.role} onChange={(e) => set(i, { role: e.target.value })} maxLength={100} placeholder="e.g. Production manager" />
              {started ? <ComboField label="Attendance" value={r.attendance} onChange={(v) => set(i, { attendance: v ?? "invited" })} options={ATTENDANCE} clearable={false} /> : <span />}
              <button type="button" aria-label={`Take ${nameOf(r)} off`} onClick={() => setRows((x) => x.filter((_, j) => j !== i))} className="mb-2 rounded-md p-1 text-secondary-text hover:text-error-color">
                <XIcon aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
        <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-2">
          <ComboField
            label="Add a member"
            value={adding}
            onChange={(v) => {
              if (v) setRows((r) => [...r, { userId: v, name: "", role: "", attendance: started ? "present" : "invited" }]);
              setAdding(null);
            }}
            options={people.filter((p) => !chosen.has(p.value))}
            placeholder="Choose someone"
          />
          <div className="flex items-end gap-2">
            <Field label="Or someone from outside" value={guest} onChange={(e) => setGuest(e.target.value)} maxLength={120} placeholder="Name" className="flex-1" />
            <CTAButton
              type="secondary"
              size="md"
              disabled={!guest.trim()}
              aria-label="Add the person from outside"
              onClick={() => {
                setRows((r) => [...r, { userId: null, name: guest.trim(), role: "", attendance: started ? "present" : "invited" }]);
                setGuest("");
              }}
            >
              <PlusIcon aria-hidden="true" />
            </CTAButton>
          </div>
        </div>
        {!started && <p className="text-xs text-secondary-text">Who was present is recorded once the review has started.</p>}
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} label="Save attendees" />
      </form>
    </Dialog>
  );
};

export const DecisionDialog = ({ review, existing, onClose }) => {
  const { mutation, run } = useReviewCommand(onClose);
  const [description, setDescription] = useState(existing?.description ?? "");
  const [category, setCategory] = useState(existing?.category ?? "improvement");
  const ready = description.trim() && category;
  return (
    <Dialog title={existing ? "Change the decision" : "Record a decision"} onClose={onClose}>
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!ready) return;
          const body = { description: description.trim(), category };
          run(existing ? { action: "updateDecision", id: existing.id, body } : { action: "addDecision", id: review.id, body });
        }}
      >
        <TextAreaField label="What was decided" required value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} rows={3} />
        <ComboField label="About" required value={category} onChange={(v) => setCategory(v ?? "improvement")} options={DECISION_CATEGORIES} clearable={false} />
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={!ready} label={existing ? "Save" : "Record it"} />
      </form>
    </Dialog>
  );
};

/** Give an action (while the review is held), or move an open one: its owner and due date may change at any time, its words only while the review is held. */
export const ActionDialog = ({ review, existing, onClose }) => {
  const { mutation, run } = useReviewCommand(onClose);
  const { user } = useAuth();
  const people = usePeople();
  const [description, setDescription] = useState(existing?.description ?? "");
  const [ownerId, setOwnerId] = useState(existing?.owner?.id ?? user?.id ?? null);
  const [dueDate, setDueDate] = useState(existing?.dueDate ?? null);
  const [decisionId, setDecisionId] = useState(existing?.decisionId ?? null);
  const wordsFixed = existing && review.status !== "in_progress";
  const ready = description.trim() && ownerId;
  return (
    <Dialog title={existing ? "Change the action" : "Give an action"} onClose={onClose} width="max-w-xl">
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!ready) return;
          const body = { ownerId, dueDate: dueDate ?? null };
          if (!wordsFixed) body.description = description.trim();
          if (!existing && decisionId) body.decisionId = decisionId;
          run(existing ? { action: "updateAction", id: existing.id, body } : { action: "addAction", id: review.id, body });
        }}
      >
        <TextAreaField label="What is to be done" required value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} rows={3} disabled={wordsFixed} hint={wordsFixed ? "Fixed once the review is completed" : undefined} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <ComboField label="Given to" required value={ownerId} onChange={setOwnerId} options={people} placeholder="Who does it" />
          <RHFDatePickerPopout label="Due" valueFormat="iso" clearable value={dueDate} onChange={(v) => setDueDate(v ?? null)} placeholder="No due date" />
        </div>
        {!existing && review.decisions.length > 0 && (
          <ComboField label="From the decision" value={decisionId} onChange={setDecisionId} options={review.decisions.map((d) => ({ value: d.id, label: d.description }))} placeholder="None" clearable />
        )}
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={!ready} label={existing ? "Save" : "Give the action"} />
      </form>
    </Dialog>
  );
};

/** One piece of text (a note or a reason) sent as `field` with a command. */
export const TextDialog = ({ title, intro, label, field = "reason", min = 3, max = 500, confirm, type = "main", command, onClose, optional = false }) => {
  const { mutation, run } = useReviewCommand(onClose);
  const [text, setText] = useState("");
  const ok = !label || optional || text.trim().length >= min;
  return (
    <Dialog title={title} onClose={onClose}>
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) run({ ...command, body: label && text.trim() ? { [field]: text.trim() } : {} });
        }}
      >
        {intro && <p className="text-sm text-secondary-text">{intro}</p>}
        {label && <TextAreaField label={label} value={text} onChange={(e) => setText(e.target.value)} required={!optional} maxLength={max} rows={3} />}
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={!ok} label={confirm} type={type} />
      </form>
    </Dialog>
  );
};
