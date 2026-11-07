import { useState } from "react";
import Dialog from "../ui/Dialog";
import MenuCard from "../ui/MenuCard";
import RHFComboBox from "../ui/RHFComboBox";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";
import ReasonDialog from "../ncr/ReasonDialog";
import { useCapaMutation } from "../../hooks/useCapa";
import { usePermissions } from "../../hooks/useQmsApi";
import { ACTION_STATUS, ROOT_CAUSE_KINDS, isRunning, roleLabel } from "../../lib/capa";
import { formatDay } from "../../lib/qualityAlerts";
import { FormError, TextAreaField, buttonClass } from "../master-data/shared";

/** The people an action can be assigned to: everyone still on the team. */
const ownerOptions = (capa) => capa.team.filter((t) => !t.endedAt).map((t) => ({ id: t.id, name: t.name, hint: roleLabel(t.role) }));

const causeOptions = (capa) => capa.rootCauses.map((c) => ({ id: c.id, name: c.description, hint: ROOT_CAUSE_KINDS[c.kind]?.label }));

/**
 * Write or change an action, and assign it to the person who will do it (the actionee). `limited` = only who and when (reassigning while the plan step is complete).
 * The dialog is wide and tall enough for the drop-down lists to open without being clipped.
 */
export const ActionDialog = ({ capa, phase, action, withCause, limited = false, onClose }) => {
  const mutation = useCapaMutation();
  const [form, setForm] = useState({ description: action?.description ?? "", ownerTeamMemberId: action?.owner?.teamMemberId ?? null, dueDate: action?.dueDate ?? null, rootCauseId: action?.rootCauseId ?? null });
  const submit = (e) => {
    e.preventDefault();
    const body = limited
      ? { ownerTeamMemberId: form.ownerTeamMemberId, dueDate: form.dueDate }
      : { description: form.description.trim(), ownerTeamMemberId: form.ownerTeamMemberId, dueDate: form.dueDate, ...(withCause ? { rootCauseId: form.rootCauseId } : {}) };
    mutation.mutate(action ? { action: "updateAction", id: action.id, body } : { action: "addAction", id: capa.id, body: { phase, ...body } }, { onSuccess: onClose });
  };
  return (
    <Dialog title={limited ? "Reassign the action" : action ? "Edit action" : "Add an action"} onClose={onClose} width="max-w-2xl">
      <form className="flex min-h-[24rem] flex-col gap-3" noValidate onSubmit={submit}>
        {limited ? (
          <p className="text-sm text-primary-text">{action.description}</p>
        ) : (
          <TextAreaField label="What will be done" required value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={3} maxLength={2000} />
        )}
        {withCause && !limited && (
          <RHFComboBox label="Root cause it addresses" value={form.rootCauseId} onChange={(v) => setForm((f) => ({ ...f, rootCauseId: v ?? null }))} options={causeOptions(capa)} placeholder="Not linked to a cause" hint="The cause from D4 this action removes" />
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <RHFComboBox label="Assigned to" required={phase === "corrective"} value={form.ownerTeamMemberId} onChange={(v) => setForm((f) => ({ ...f, ownerTeamMemberId: v }))} options={ownerOptions(capa)} placeholder="Nobody yet"
            hint="Someone on the team of this 8D. They are told, and can then write the findings and close the action." />
          <RHFDatePickerPopout label="Due date" required={phase === "corrective"} valueFormat="iso" clearable value={form.dueDate} onChange={(v) => setForm((f) => ({ ...f, dueDate: v ?? null }))} placeholder="No due date" />
        </div>
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <button type="button" className={buttonClass.neutral} onClick={onClose}>Cancel</button>
          <button type="submit" className={buttonClass.primary} disabled={mutation.isPending || (!limited && !form.description.trim())}>{mutation.isPending ? "Saving…" : action ? "Save" : "Add action"}</button>
        </div>
      </form>
    </Dialog>
  );
};

/** The findings of an action: what was done and found. Saved as it is (the action stays open), or the action is closed with them. */
export const FindingsDialog = ({ action, closing = false, onClose }) => {
  const mutation = useCapaMutation();
  const [findings, setFindings] = useState(action.evidenceNote ?? "");
  const text = findings.trim();
  return (
    <Dialog title={closing ? "Close the action" : "Update the findings"} onClose={onClose} width="max-w-2xl">
      <form
        className="flex flex-col gap-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate(
            closing ? { action: "completeAction", id: action.id, body: { evidenceNote: text } } : { action: "updateAction", id: action.id, body: { evidenceNote: text || null } },
            { onSuccess: onClose },
          );
        }}>
        <p className="text-sm text-primary-text">{action.description}</p>
        <TextAreaField label="Findings: what was done and what was found" required={closing} value={findings} onChange={(e) => setFindings(e.target.value)} rows={5} maxLength={2000}
          hint={closing ? "Needed to close the action: it is the evidence that the work was done." : "Progress so far. The action stays open until you close it."} />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <button type="button" className={buttonClass.neutral} onClick={onClose}>Cancel</button>
          <button type="submit" className={buttonClass.primary} disabled={mutation.isPending || (closing && !text)}>{mutation.isPending ? "Saving…" : closing ? "Close action" : "Save findings"}</button>
        </div>
      </form>
    </Dialog>
  );
};

/**
 * What a person can do with one action, from who they are and which steps are complete:
 *  - plan (managers, plan step open): add, edit what it is;
 *  - work (the doing step open): the actionee, or a manager, updates the findings, closes and reopens; managers also cancel and reassign.
 * A complete step is read-only until it is reopened.
 */
export const useActionRights = (capa, planStep, doingStep) => {
  const { can } = usePermissions();
  const running = isRunning(capa.stage);
  const done = (k) => !k || capa.steps.find((s) => s.step === k)?.completed;
  const manage = running && can("capa.manage");
  const planOpen = !done(planStep);
  const workOpen = !done(doingStep);
  return { manage, plan: !!planStep && manage && planOpen, work: !!doingStep && running && workOpen, planLocked: !!planStep && planOpen === false, workLocked: !!doingStep && workOpen === false, running };
};

/** One action's buttons, shared by the 8D steps and the My actions page. `rights` is from useActionRights; `limitedReassign` offers who/when only. */
export const ActionButtons = ({ action: a, rights, setDialog, mutation }) => {
  const canWork = rights.work && (rights.manage || a.isAssignee);
  const open = (type) => () => { mutation.reset(); setDialog({ type, action: a }); };
  return (
    <div className="flex flex-wrap gap-2">
      {a.status === "open" && canWork && <button type="button" className={buttonClass.neutral} aria-label={`Update findings: ${a.description}`} onClick={open("findings")}>Update findings</button>}
      {a.status === "open" && canWork && <button type="button" className={buttonClass.primary} aria-label={`Close action: ${a.description}`} onClick={open("close")}>Close action</button>}
      {rights.plan && <button type="button" className={buttonClass.neutral} aria-label={`Edit: ${a.description}`} onClick={open("edit")}>Edit</button>}
      {!rights.plan && rights.manage && rights.work && a.status === "open" && <button type="button" className={buttonClass.neutral} aria-label={`Reassign: ${a.description}`} onClick={open("reassign")}>Reassign</button>}
      {a.status === "open" && rights.manage && rights.work && <button type="button" className={buttonClass.neutral} aria-label={`Cancel: ${a.description}`} onClick={open("cancel")}>Cancel action</button>}
      {a.status === "done" && canWork && <button type="button" className={buttonClass.neutral} aria-label={`Reopen: ${a.description}`} disabled={mutation.isPending} onClick={() => mutation.mutate({ action: "reopenAction", id: a.id })}>Reopen</button>}
      {a.status === "cancelled" && rights.manage && rights.work && <button type="button" className={buttonClass.neutral} aria-label={`Reopen: ${a.description}`} disabled={mutation.isPending} onClick={() => mutation.mutate({ action: "reopenAction", id: a.id })}>Reopen</button>}
    </div>
  );
};

/** The dialog an ActionButtons click opens (add / edit / reassign / findings / close / cancel). */
export const ActionDialogs = ({ capa, phase, withCause, dialog, setDialog, mutation }) => {
  const close = () => setDialog(null);
  if (!dialog) return null;
  if (dialog.type === "add" || dialog.type === "edit" || dialog.type === "reassign") {
    return <ActionDialog capa={capa} phase={phase ?? dialog.action?.phase} action={dialog.action} withCause={withCause} limited={dialog.type === "reassign"} onClose={close} />;
  }
  if (dialog.type === "findings" || dialog.type === "close") return <FindingsDialog action={dialog.action} closing={dialog.type === "close"} onClose={close} />;
  if (dialog.type === "cancel") {
    return (
      <ReasonDialog title="Cancel the action?" label="Why is it no longer needed?" confirmText="Cancel action" pending={mutation.isPending} error={mutation.error} onClose={close}
        onConfirm={(reason) => mutation.mutate({ action: "cancelAction", id: dialog.action.id, body: { reason } }, { onSuccess: close })} />
    );
  }
  return null;
};

/**
 * The actions of one phase. Managers write each action and assign it to a team member (the actionee); the actionee updates the findings and closes it.
 * `planStep` / `doingStep` are the 8D steps that guard planning and doing (interim D3/D3, corrective D5/D6, preventive D7/D7); pass null to switch one off.
 * A complete step is read-only until it is reopened.
 */
const ActionList = ({ capa, phase, planStep, doingStep, title, subtitle, addLabel, emptyText, withCause = false }) => {
  const mutation = useCapaMutation();
  const rights = useActionRights(capa, planStep, doingStep);
  const [dialog, setDialog] = useState(null); // { type, action? }
  const actions = capa.actions.filter((a) => a.phase === phase);
  const locked = (planStep && rights.planLocked) || (doingStep && rights.workLocked);

  return (
    <MenuCard title={title} subtitle={subtitle ?? `${actions.filter((a) => a.status === "done").length} of ${actions.filter((a) => a.status !== "cancelled").length} done`}
      action={rights.plan && addLabel ? <button type="button" className={buttonClass.neutral} onClick={() => { mutation.reset(); setDialog({ type: "add" }); }}>{addLabel}</button> : undefined}>
      {locked && rights.running && <p className="mb-2 text-xs text-secondary-text">{[planStep, doingStep].filter((k, i, all) => k && all.indexOf(k) === i && capa.steps.find((s) => s.step === k)?.completed).map((k) => k.toUpperCase()).join(" and ")} is complete, so these actions are read-only. Reopen it to change them.</p>}
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
                {withCause && <>Addresses: {capa.rootCauses.find((c) => c.id === a.rootCauseId)?.description ?? "no root cause linked"} · </>}
                Assigned to: {a.owner?.name ?? "nobody yet"}{a.isAssignee && <span className="font-medium text-primary-text"> (you)</span>}
                {a.dueDate && <> · Due {formatDay(a.dueDate)}{a.overdue && <span className="font-medium text-error-color"> · overdue</span>}</>}
                {a.status === "done" && a.doneAt && <> · Closed by {a.doneBy?.name ?? "someone"} on {formatDay(a.doneAt.slice(0, 10))}</>}
              </p>
              {a.evidenceNote && <p className="whitespace-pre-wrap text-xs text-primary-text"><span className="text-secondary-text">Findings: </span>{a.evidenceNote}</p>}
              {a.cancelReason && <p className="text-xs text-primary-text"><span className="text-secondary-text">Cancelled: </span>{a.cancelReason}</p>}
              <ActionButtons action={a} rights={rights} setDialog={setDialog} mutation={mutation} />
            </li>
          ))}
        </ul>
      )}
      <FormError error={dialog ? null : mutation.error} />
      <ActionDialogs capa={capa} phase={phase} withCause={withCause} dialog={dialog} setDialog={setDialog} mutation={mutation} />
    </MenuCard>
  );
};

export default ActionList;
