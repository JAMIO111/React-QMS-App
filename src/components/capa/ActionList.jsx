import { useState } from "react";
import Dialog from "../ui/Dialog";
import MenuCard from "../ui/MenuCard";
import RHFComboBox from "../ui/RHFComboBox";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";
import ReasonDialog from "../ncr/ReasonDialog";
import { useCapaMutation } from "../../hooks/useCapa";
import { ACTION_STATUS, ROOT_CAUSE_KINDS, roleLabel } from "../../lib/capa";
import { formatDay } from "../../lib/qualityAlerts";
import { FormError, TextAreaField, buttonClass } from "../master-data/shared";

/** The people an action can be given to: everyone still on the team. */
const ownerOptions = (capa) => capa.team.filter((t) => !t.endedAt).map((t) => ({ id: t.id, name: t.name, hint: roleLabel(t.role) }));

const causeOptions = (capa) => capa.rootCauses.map((c) => ({ id: c.id, name: c.description, hint: ROOT_CAUSE_KINDS[c.kind]?.label }));

const ActionDialog = ({ capa, phase, action, withCause, onClose }) => {
  const mutation = useCapaMutation();
  const [form, setForm] = useState({ description: action?.description ?? "", ownerTeamMemberId: action?.owner?.teamMemberId ?? null, dueDate: action?.dueDate ?? null, rootCauseId: action?.rootCause?.id ?? action?.rootCauseId ?? null });
  const submit = (e) => {
    e.preventDefault();
    const body = { description: form.description.trim(), ownerTeamMemberId: form.ownerTeamMemberId, dueDate: form.dueDate, ...(withCause ? { rootCauseId: form.rootCauseId } : {}) };
    mutation.mutate(action ? { action: "updateAction", id: action.id, body } : { action: "addAction", id: capa.id, body: { phase, ...body } }, { onSuccess: onClose });
  };
  return (
    <Dialog title={action ? "Edit action" : "Add an action"} onClose={onClose}>
      <form className="flex flex-col gap-3" noValidate onSubmit={submit}>
        <TextAreaField label="What will be done" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={3} maxLength={2000} />
        {withCause && <RHFComboBox label="Root cause it addresses" value={form.rootCauseId} onChange={(v) => setForm((f) => ({ ...f, rootCauseId: v ?? null }))} options={causeOptions(capa)} placeholder="Not linked to a cause" hint="The cause from D4 this action removes" />}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <RHFComboBox label="Owner" value={form.ownerTeamMemberId} onChange={(v) => setForm((f) => ({ ...f, ownerTeamMemberId: v }))} options={ownerOptions(capa)} placeholder="Nobody yet" hint="Anyone on the team of this 8D" />
          <RHFDatePickerPopout label="Due date" valueFormat="iso" clearable value={form.dueDate} onChange={(v) => setForm((f) => ({ ...f, dueDate: v ?? null }))} placeholder="No due date" />
        </div>
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <button type="button" className={buttonClass.neutral} onClick={onClose}>Cancel</button>
          <button type="submit" className={buttonClass.primary} disabled={mutation.isPending || !form.description.trim()}>{mutation.isPending ? "Saving…" : action ? "Save" : "Add action"}</button>
        </div>
      </form>
    </Dialog>
  );
};

const DoneDialog = ({ action, onClose }) => {
  const mutation = useCapaMutation();
  const [note, setNote] = useState(action.evidenceNote ?? "");
  return (
    <Dialog title="Mark the action done" onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate({ action: "completeAction", id: action.id, body: note.trim() ? { evidenceNote: note.trim() } : {} }, { onSuccess: onClose });
        }}>
        <p className="text-sm text-primary-text">{action.description}</p>
        <TextAreaField label="What was done, and the evidence (optional)" value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={2000} />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <button type="button" className={buttonClass.neutral} onClick={onClose}>Cancel</button>
          <button type="submit" className={buttonClass.primary} disabled={mutation.isPending}>{mutation.isPending ? "Saving…" : "Mark done"}</button>
        </div>
      </form>
    </Dialog>
  );
};

/**
 * The actions of one phase (interim containment, corrective, preventive): owner from the team, due date, status.
 * Anything can be edited at any time while the 8D is running; "done" and "cancelled" can be undone with Reopen.
 */
const ActionList = ({ capa, phase, editable, title, subtitle, addLabel, emptyText, withCause = false }) => {
  const mutation = useCapaMutation();
  const [dialog, setDialog] = useState(null); // { type: "add" | "edit" | "done" | "cancel", action? }
  const actions = capa.actions.filter((a) => a.phase === phase);
  const close = () => setDialog(null);

  return (
    <MenuCard title={title} subtitle={subtitle ?? `${actions.filter((a) => a.status === "done").length} of ${actions.filter((a) => a.status !== "cancelled").length} done`}
      action={editable ? <button type="button" className={buttonClass.neutral} onClick={() => { mutation.reset(); setDialog({ type: "add" }); }}>{addLabel}</button> : undefined}>
      {actions.length === 0 ? (
        <p className="text-sm text-secondary-text">{emptyText}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border-color" aria-label={title}>
          {actions.map((a) => (
            <li key={a.id} className="flex flex-col gap-2 py-3 text-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className={`max-w-2xl text-primary-text ${a.status === "cancelled" ? "text-secondary-text line-through" : ""}`}>{a.description}</p>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${ACTION_STATUS[a.status].tone}`}>{ACTION_STATUS[a.status].label}</span>
              </div>
              <p className="text-xs text-secondary-text">
                {withCause && <>Addresses: {capa.rootCauses.find((c) => c.id === (a.rootCause?.id ?? a.rootCauseId))?.description ?? "no root cause linked"} · </>}Owner: {a.owner?.name ?? "nobody yet"}
                {a.dueDate && <> · Due {formatDay(a.dueDate)}{a.overdue && <span className="font-medium text-error-color"> · overdue</span>}</>}
                {a.status === "done" && a.doneAt && <> · Done by {a.doneBy?.name ?? "someone"} on {formatDay(a.doneAt.slice(0, 10))}</>}
              </p>
              {a.evidenceNote && <p className="text-xs text-primary-text"><span className="text-secondary-text">Evidence: </span>{a.evidenceNote}</p>}
              {a.cancelReason && <p className="text-xs text-primary-text"><span className="text-secondary-text">Cancelled: </span>{a.cancelReason}</p>}
              {editable && (
                <div className="flex flex-wrap gap-2">
                  {a.status === "open" && <button type="button" className={buttonClass.primary} aria-label={`Mark done: ${a.description}`} onClick={() => { mutation.reset(); setDialog({ type: "done", action: a }); }}>Mark done</button>}
                  <button type="button" className={buttonClass.neutral} aria-label={`Edit: ${a.description}`} onClick={() => { mutation.reset(); setDialog({ type: "edit", action: a }); }}>Edit</button>
                  {a.status === "open" && <button type="button" className={buttonClass.neutral} aria-label={`Cancel: ${a.description}`} onClick={() => { mutation.reset(); setDialog({ type: "cancel", action: a }); }}>Cancel action</button>}
                  {a.status !== "open" && <button type="button" className={buttonClass.neutral} aria-label={`Reopen: ${a.description}`} disabled={mutation.isPending} onClick={() => mutation.mutate({ action: "reopenAction", id: a.id })}>Reopen</button>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <FormError error={dialog ? null : mutation.error} />
      {(dialog?.type === "add" || dialog?.type === "edit") && <ActionDialog capa={capa} phase={phase} action={dialog.action} withCause={withCause} onClose={close} />}
      {dialog?.type === "done" && <DoneDialog action={dialog.action} onClose={close} />}
      {dialog?.type === "cancel" && (
        <ReasonDialog title="Cancel the action?" label="Why is it no longer needed?" confirmText="Cancel action" pending={mutation.isPending} error={mutation.error} onClose={close}
          onConfirm={(reason) => mutation.mutate({ action: "cancelAction", id: dialog.action.id, body: { reason } }, { onSuccess: close })} />
      )}
    </MenuCard>
  );
};

export default ActionList;
