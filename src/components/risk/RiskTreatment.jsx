import { useState } from "react";
import { CheckIcon, PencilIcon, PlusIcon, RotateCcwIcon } from "@/components/icons";
import CTAButton from "@/components/CTAButton";
import { describeApiError } from "../../lib/api-client";
import { todayIso } from "../../lib/localDate";
import { useToast } from "../../contexts/ToastProvider";
import { useCustomFieldPeople } from "../../hooks/useCustomFields";
import { useRiskMutation } from "../../hooks/useRisk";
import { ACCEPTANCE_STATUS, ACTION_STATUS, actionOverdue, BAND_LABEL, BAND_PILL, formatDay, outcomeOptions, strategyLabel, strategyOptions } from "../../lib/risk";
import { FormError, TextAreaField } from "../master-data/shared";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import MenuCard from "../ui/MenuCard";
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

/** One command with a dialog: runs it, closes on success, says why in a toast when it is refused. */
const useCommand = (onClose, failed) => {
  const mutation = useRiskMutation();
  const { showToast } = useToast();
  const run = (command) => mutation.mutate(command, { onSuccess: onClose, onError: (err) => showToast({ type: "error", title: failed, message: describeApiError(err) }) });
  return { mutation, run };
};

/** A dialog that asks for one piece of text (a note or a reason) and sends it as `field`. */
export const TextDialog = ({ title, intro, label, field = "reason", min = 3, max = 500, confirm, type = "main", command, onClose }) => {
  const { mutation, run } = useCommand(onClose, "Not saved");
  const [text, setText] = useState("");
  const ok = text.trim().length >= min;
  return (
    <Dialog title={title} onClose={onClose}>
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) run({ ...command, body: { ...(command.body ?? {}), [field]: text.trim() } });
        }}
      >
        {intro && <p className="text-sm text-secondary-text">{intro}</p>}
        <TextAreaField label={label} value={text} onChange={(e) => setText(e.target.value)} required maxLength={max} rows={3} />
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={!ok} label={confirm} type={type} />
      </form>
    </Dialog>
  );
};

export const TreatmentDialog = ({ risk, onClose }) => {
  const { mutation, run } = useCommand(onClose, "Not saved");
  const [strategy, setStrategy] = useState(risk.strategy ?? null);
  const [plan, setPlan] = useState(risk.treatmentPlan ?? "");
  const opportunity = risk.kind === "opportunity";
  return (
    <Dialog title={`What will be done about ${risk.reference}`} onClose={onClose} width="max-w-xl">
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (strategy) run({ action: "setTreatment", id: risk.id, body: { strategy, plan: plan.trim() || null } });
        }}
      >
        <ComboField label="Approach" required value={strategy} onChange={setStrategy} options={strategyOptions(risk.kind)} placeholder="Choose one" />
        {strategy === "accept" && !opportunity && risk.acceptance?.above && (
          <Callout tone="warning">
            It is {BAND_LABEL[risk.band]?.toLowerCase()}, above the level your organisation accepts ({BAND_LABEL[risk.acceptance.acceptanceBand]?.toLowerCase()}): accepting it needs an approver other than
            the person who proposes it.
          </Callout>
        )}
        <TextAreaField label="The plan" value={plan} onChange={(e) => setPlan(e.target.value)} maxLength={4000} rows={3} hint="Optional: in a few words. The steps themselves are the actions." />
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={!strategy} label="Save" />
      </form>
    </Dialog>
  );
};

export const ActionDialog = ({ risk, action, onClose }) => {
  const { mutation, run } = useCommand(onClose, "Not saved");
  const people = useCustomFieldPeople();
  const [description, setDescription] = useState(action?.description ?? "");
  const [ownerId, setOwnerId] = useState(action?.owner?.id ?? risk.owner?.id ?? null);
  const [dueDate, setDueDate] = useState(action?.dueDate ?? null);
  const options = (people.data ?? []).map((p) => ({ value: p.id, label: p.name }));
  // Someone who has since left stays on the action until it is given to someone else.
  if (action?.owner && !options.some((o) => o.value === action.owner.id)) options.push({ value: action.owner.id, label: action.owner.name, hint: "No longer a member" });
  const ready = description.trim() && ownerId;
  return (
    <Dialog title={action ? "Edit the action" : "Add an action"} onClose={onClose} width="max-w-xl">
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!ready) return;
          const body = { description: description.trim(), ownerId, dueDate: dueDate ?? null };
          run(action ? { action: "updateAction", id: action.id, body } : { action: "addAction", id: risk.id, body });
        }}
      >
        <TextAreaField label="What is to be done" value={description} onChange={(e) => setDescription(e.target.value)} required maxLength={2000} rows={3} />
        <div className="grid gap-3 sm:grid-cols-2">
          <ComboField label="Given to" required value={ownerId} onChange={setOwnerId} options={options} placeholder="Choose a person" />
          <RHFDatePickerPopout label="Due date" valueFormat="iso" clearable value={dueDate} onChange={(v) => setDueDate(v ?? null)} placeholder="No due date" />
        </div>
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={!ready} label={action ? "Save" : "Add action"} />
      </form>
    </Dialog>
  );
};

export const DecideDialog = ({ risk, acceptance, onClose }) => {
  const { mutation, run } = useCommand(onClose, "Not decided");
  const [note, setNote] = useState("");
  const ok = note.trim().length >= 3;
  const decide = (approve) => ok && run({ action: "decideAcceptance", id: acceptance.id, body: { approve, note: note.trim() } });
  return (
    <Dialog title={`Accept ${risk.reference} as it stands?`} onClose={onClose} width="max-w-xl">
      <form noValidate className="flex flex-col gap-3" onSubmit={(e) => e.preventDefault()}>
        <p className="text-sm text-primary-text">
          {acceptance.proposedBy ?? "Someone"} proposes living with this risk at <strong>{BAND_LABEL[acceptance.band]?.toLowerCase()}</strong>, above the level your organisation accepts.
        </p>
        <p className="whitespace-pre-wrap rounded-lg border border-border-color bg-primary-bg p-3 text-sm text-primary-text">{acceptance.rationale}</p>
        <TextAreaField label="Your note" value={note} onChange={(e) => setNote(e.target.value)} required maxLength={1000} rows={3} hint="Kept with the decision. It holds until the risk is assessed again." />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton buttonType="button" type="danger" size="md" disabled={!ok || mutation.isPending} loading={mutation.isPending} onClick={() => decide(false)}>
            Reject
          </CTAButton>
          <CTAButton buttonType="button" type="success" size="md" disabled={!ok || mutation.isPending} loading={mutation.isPending} onClick={() => decide(true)}>
            Approve
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

export const ReviewDialog = ({ risk, onClose }) => {
  const { mutation, run } = useCommand(onClose, "Not recorded");
  const [note, setNote] = useState("");
  const [next, setNext] = useState(null);
  const ok = note.trim().length >= 3;
  return (
    <Dialog title={`Review ${risk.reference}`} onClose={onClose} width="max-w-xl">
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) run({ action: "review", id: risk.id, body: { note: note.trim(), ...(next ? { nextReviewOn: next } : {}) } });
        }}
      >
        <p className="text-sm text-secondary-text">Use this when you have looked at it and nothing has changed. If the likelihood or the consequence has changed, assess it again instead: that counts as the review.</p>
        <TextAreaField label="What you looked at and found" value={note} onChange={(e) => setNote(e.target.value)} required maxLength={2000} rows={3} />
        <RHFDatePickerPopout label="Next review" valueFormat="iso" clearable allowPast={false} minDate={todayIso(1)} value={next} onChange={(v) => setNext(v ?? null)} placeholder="Worked out from its level" hint="Leave empty to use the interval your matrix gives its level" />
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={!ok} label="Record the review" />
      </form>
    </Dialog>
  );
};

export const CloseDialog = ({ risk, onClose }) => {
  const { mutation, run } = useCommand(onClose, "Not closed");
  const [outcome, setOutcome] = useState(null);
  const [note, setNote] = useState("");
  const ok = outcome && note.trim().length >= 3;
  return (
    <Dialog title={`Close ${risk.reference}`} onClose={onClose} width="max-w-xl">
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) run({ action: "close", id: risk.id, body: { outcome, note: note.trim() } });
        }}
      >
        <ComboField label="Closed as" required value={outcome} onChange={setOutcome} options={outcomeOptions(risk.kind)} placeholder="Choose one" />
        {risk.openActions > 0 && outcome && outcome !== "treated" && (
          <Callout tone="warning">
            {risk.openActions} open {risk.openActions === 1 ? "action" : "actions"} will be cancelled.
          </Callout>
        )}
        <TextAreaField label="Closing note" value={note} onChange={(e) => setNote(e.target.value)} required maxLength={2000} rows={3} />
        <p className="text-sm text-secondary-text">A closed risk is kept as it is and has no review date. It can be reopened with a reason.</p>
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={!ok} label="Close it" />
      </form>
    </Dialog>
  );
};

const pill = (tone) => `inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${tone}`;

/** What will be done about the risk: the approach, the plan in words and the actions, each given to a person. */
export const TreatmentCard = ({ risk }) => {
  const [dialog, setDialog] = useState(null);
  const { mutation, run } = useCommand(() => {}, "Not reopened");
  const today = todayIso();
  const edit = risk.canEdit && risk.status !== "draft";
  return (
    <MenuCard
      title="Treatment"
      subtitle={risk.kind === "opportunity" ? "Whether it will be pursued, and the steps." : "What will be done about it, and the steps."}
      action={
        edit && (
          <div className="flex flex-wrap gap-2">
            <CTAButton type="secondary" icon={PencilIcon} onClick={() => setDialog({ kind: "treatment" })}>
              {risk.strategy ? "Change the approach" : "Choose the approach"}
            </CTAButton>
            <CTAButton type="neutral" icon={PlusIcon} onClick={() => setDialog({ kind: "action" })}>
              Add an action
            </CTAButton>
          </div>
        )
      }
    >
      <dl className="flex flex-col gap-3">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-secondary-text">Approach</dt>
          <dd className="text-sm text-primary-text">{risk.strategy ? strategyLabel(risk.strategy, risk.kind) : "Not decided yet"}</dd>
        </div>
        {risk.treatmentPlan && (
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-secondary-text">The plan</dt>
            <dd className="whitespace-pre-wrap text-sm text-primary-text">{risk.treatmentPlan}</dd>
          </div>
        )}
      </dl>
      {risk.actions.length === 0 ? (
        <p className="mt-3 text-sm text-secondary-text">No actions yet.</p>
      ) : (
        <ul aria-label="Actions" className="mt-3 flex flex-col gap-2">
          {risk.actions.map((x) => {
            const late = actionOverdue(x, today);
            return (
              <li key={x.id} className="flex flex-col gap-1 rounded-xl border border-border-color bg-primary-bg p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={pill(ACTION_STATUS[x.status].tone)}>{ACTION_STATUS[x.status].label}</span>
                  {late && <span className={pill("bg-error-color/15 text-error-color")}>Overdue</span>}
                  <span className="text-xs text-secondary-text">
                    {x.owner?.name ?? "Nobody"}
                    {x.mine ? " (you)" : ""} · {x.dueDate ? `due ${formatDay(x.dueDate)}` : "no due date"}
                  </span>
                  <span className="ml-auto flex flex-wrap gap-2">
                    {x.status === "open" && (risk.canManage || x.mine) && !["closed", "retired"].includes(risk.status) && (
                      <CTAButton type="main" size="md" icon={CheckIcon} aria-label={`Mark done: ${x.description}`} onClick={() => setDialog({ kind: "done", action: x })}>
                        Done…
                      </CTAButton>
                    )}
                    {x.status === "open" && risk.canEdit && (
                      <>
                        <CTAButton type="neutral" size="md" aria-label={`Edit action: ${x.description}`} onClick={() => setDialog({ kind: "action", action: x })}>
                          Edit
                        </CTAButton>
                        <CTAButton type="neutral" size="md" aria-label={`Cancel action: ${x.description}`} onClick={() => setDialog({ kind: "cancel", action: x })}>
                          Cancel
                        </CTAButton>
                      </>
                    )}
                    {x.status !== "open" && risk.canEdit && (
                      <CTAButton type="neutral" size="md" icon={RotateCcwIcon} loading={mutation.isPending} aria-label={`Reopen action: ${x.description}`} onClick={() => run({ action: "reopenAction", id: x.id })}>
                        Reopen
                      </CTAButton>
                    )}
                  </span>
                </div>
                <p className="whitespace-pre-wrap text-sm text-primary-text">{x.description}</p>
                {x.status === "done" && (
                  <p className="text-xs text-secondary-text">
                    Done {formatDay(x.doneAt)} by {x.doneBy ?? "Unknown"}: {x.doneNote}
                  </p>
                )}
                {x.status === "cancelled" && (
                  <p className="text-xs text-secondary-text">
                    Cancelled {formatDay(x.cancelledAt)} by {x.cancelledBy ?? "Unknown"}: {x.cancelReason}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {dialog?.kind === "treatment" && <TreatmentDialog risk={risk} onClose={() => setDialog(null)} />}
      {dialog?.kind === "action" && <ActionDialog risk={risk} action={dialog.action} onClose={() => setDialog(null)} />}
      {dialog?.kind === "done" && (
        <TextDialog title="Mark the action done" intro={dialog.action.description} label="What was done" field="note" min={1} max={2000} confirm="Mark done" command={{ action: "completeAction", id: dialog.action.id }} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "cancel" && (
        <TextDialog title="Cancel the action" intro={dialog.action.description} label="Why is it cancelled?" confirm="Cancel the action" type="danger" command={{ action: "cancelAction", id: dialog.action.id }} onClose={() => setDialog(null)} />
      )}
    </MenuCard>
  );
};

/** Living with a risk above the acceptable level: proposed by one person, decided by another. Shown when it applies or has a history. */
export const AcceptanceCard = ({ risk }) => {
  const [dialog, setDialog] = useState(null);
  const a = risk.acceptance;
  if (risk.kind === "opportunity" || (!a?.above && risk.acceptances.length === 0)) return null;
  const canPropose = risk.canEdit && a.above && !a.accepted && !a.waiting && risk.strategy && (risk.strategy === "accept" || risk.residual);
  return (
    <MenuCard
      title="Acceptance"
      subtitle={`A risk above ${BAND_LABEL[a.acceptanceBand]?.toLowerCase() ?? "the acceptable level"} is lived with only when an approver other than the person proposing it agrees.`}
      action={
        canPropose && (
          <CTAButton type="secondary" onClick={() => setDialog({ kind: "propose" })}>
            Propose accepting it
          </CTAButton>
        )
      }
    >
      {a.above && a.accepted && <Callout tone="success">Accepted as it stands. Assessing it again will ask for acceptance afresh.</Callout>}
      {a.above && !a.accepted && !a.waiting && !canPropose && risk.canEdit && (
        <p className="text-sm text-secondary-text">{risk.strategy ? "Assess what is left after treatment first: that is what would be accepted." : "Choose the approach first."}</p>
      )}
      {risk.acceptances.length > 0 && (
        <ul aria-label="Acceptances" className="mt-2 flex flex-col gap-2">
          {risk.acceptances.map((x) => (
            <li key={x.id} className="flex flex-col gap-1 rounded-xl border border-border-color bg-primary-bg p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className={pill(ACCEPTANCE_STATUS[x.status].tone)}>{ACCEPTANCE_STATUS[x.status].label}</span>
                <span className={pill(BAND_PILL[x.band])}>{BAND_LABEL[x.band]}</span>
                {x.status === "approved" && !x.inForce && <span className="text-xs text-secondary-text">for an earlier assessment</span>}
                <span className="ml-auto flex flex-wrap gap-2">
                  {x.canDecide && (
                    <CTAButton type="main" size="md" onClick={() => setDialog({ kind: "decide", acceptance: x })}>
                      Decide…
                    </CTAButton>
                  )}
                  {x.canWithdraw && (
                    <CTAButton type="neutral" size="md" onClick={() => setDialog({ kind: "withdraw", acceptance: x })}>
                      Withdraw
                    </CTAButton>
                  )}
                </span>
              </div>
              <p className="whitespace-pre-wrap text-sm text-primary-text">{x.rationale}</p>
              <p className="text-xs text-secondary-text">
                Proposed {formatDay(x.proposedAt)} by {x.proposedBy ?? "Unknown"}
                {x.decidedAt ? ` · ${x.status} ${formatDay(x.decidedAt)} by ${x.decidedBy ?? "Unknown"}: ${x.decisionNote}` : ""}
              </p>
              {x.status === "proposed" && !x.canDecide && risk.canApprove && <p className="text-xs text-secondary-text">You proposed it, so someone else decides.</p>}
            </li>
          ))}
        </ul>
      )}
      {dialog?.kind === "propose" && (
        <TextDialog
          title={`Propose accepting ${risk.reference}`}
          intro={`It is ${BAND_LABEL[risk.band]?.toLowerCase()}, above the level your organisation accepts. Say why it should be lived with as it is; an approver other than you decides.`}
          label="Why accept it as it stands?"
          field="rationale"
          min={10}
          max={2000}
          confirm="Propose"
          command={{ action: "proposeAcceptance", id: risk.id }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "decide" && <DecideDialog risk={risk} acceptance={dialog.acceptance} onClose={() => setDialog(null)} />}
      {dialog?.kind === "withdraw" && (
        <TextDialog title="Withdraw the proposal" label="Why is it withdrawn?" max={1000} confirm="Withdraw" type="danger" command={{ action: "withdrawAcceptance", id: dialog.acceptance.id }} onClose={() => setDialog(null)} />
      )}
    </MenuCard>
  );
};

/** When it is looked at again, and every time it has been. */
export const ReviewsCard = ({ risk }) => {
  const [open, setOpen] = useState(false);
  const live = ["open", "treating", "monitoring"].includes(risk.status);
  if (!live && risk.reviews.length === 0) return null;
  return (
    <MenuCard
      title="Reviews"
      subtitle="How often it is looked at again follows its level. Assessing it again counts as a review."
      action={
        risk.canEdit && live && (
          <CTAButton type="secondary" onClick={() => setOpen(true)}>
            Record a review
          </CTAButton>
        )
      }
    >
      {live && risk.nextReviewOn && (
        <p className={`text-sm ${risk.reviewOverdue ? "font-medium text-error-color" : "text-primary-text"}`}>
          {risk.reviewOverdue ? `Review overdue: it was due ${formatDay(risk.nextReviewOn)}.` : `Next review ${formatDay(risk.nextReviewOn)}.`}
        </p>
      )}
      {risk.reviews.length === 0 ? (
        <p className="mt-2 text-sm text-secondary-text">Not reviewed yet.</p>
      ) : (
        <ul aria-label="Reviews" className="-mb-3 mt-2 divide-y divide-border-color">
          {risk.reviews.map((v) => (
            <li key={v.id} className="flex flex-col py-3">
              <span className="text-sm text-primary-text">
                {v.outcome === "reassessed" ? "Assessed again" : "No change"} <span className="text-secondary-text">· {formatDay(v.reviewedOn)} · {v.reviewedBy ?? "Unknown"}</span>
              </span>
              <span className="whitespace-pre-wrap text-sm text-secondary-text">{v.note}</span>
              <span className="text-xs text-secondary-text">
                {v.wasDueOn ? `Was due ${formatDay(v.wasDueOn)} · ` : ""}next {formatDay(v.nextReviewOn)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {open && <ReviewDialog risk={risk} onClose={() => setOpen(false)} />}
    </MenuCard>
  );
};
