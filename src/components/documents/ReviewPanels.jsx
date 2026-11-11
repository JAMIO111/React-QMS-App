import { useState } from "react";
import { CheckIcon, Undo2Icon, XIcon } from "@/components/icons";
import CTAButton from "@/components/CTAButton";
import { describeApiError } from "../../lib/api-client";
import { useToast } from "../../contexts/ToastProvider";
import { useDocumentCompare, useDocumentMutation, useDocumentSigners, useSetSigners } from "../../hooks/useDocuments";
import { formatDay, SIGNOFF_DECISION, statusPill } from "../../lib/documents";
import { todayIso } from "../../lib/localDate";
import { FormError } from "../master-data/shared";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import LoadingScreen from "../ui/LoadingScreen";
import MenuCard from "../ui/MenuCard";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";

const useRun = (onDone) => {
  const mutation = useDocumentMutation();
  const { showToast } = useToast();
  const run = (payload) =>
    mutation.mutate(payload, {
      onSuccess: (result) => onDone?.(result),
      onError: (err) => showToast({ type: "error", title: "Not saved", message: describeApiError(err) }),
    });
  return { mutation, run };
};

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

/** Who reviews and who approves a draft: saved as chosen (optimistic). Neither may be the author; the approver must hold documentation.issue. */
export const SignersCard = ({ revision, canEdit }) => {
  const people = useDocumentSigners({ enabled: canEdit });
  const setSigners = useSetSigners(revision.id);
  const { showToast } = useToast();
  const authorId = revision.author?.id;
  const reviewerIds = revision.reviewers.map((r) => r.id);
  const all = (people.data ?? []).filter((p) => p.id !== authorId);
  const nameOf = (id) => all.find((p) => p.id === id)?.name ?? revision.reviewers.find((r) => r.id === id)?.name ?? revision.approver?.name ?? "Unknown";
  const save = (nextReviewers, nextApprover) =>
    setSigners.mutate(
      {
        reviewerIds: nextReviewers,
        approverId: nextApprover,
        reviewers: nextReviewers.map((id) => ({ id, name: nameOf(id) })),
        approver: nextApprover ? { id: nextApprover, name: nameOf(nextApprover) } : null,
      },
      { onError: (err) => showToast({ type: "error", title: "Not saved", message: describeApiError(err) }) },
    );

  if (!canEdit) {
    return (
      <MenuCard title="Reviewers and approver">
        <dl className="grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-secondary-text">Reviewers</dt>
            <dd className="text-sm text-primary-text">{revision.reviewers.map((r) => r.name).join(", ") || "—"}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-secondary-text">Approver</dt>
            <dd className="text-sm text-primary-text">{revision.approver?.name ?? "—"}</dd>
          </div>
        </dl>
      </MenuCard>
    );
  }
  const reviewerOptions = all.filter((p) => !reviewerIds.includes(p.id)).map((p) => ({ value: p.id, label: p.name }));
  const approverOptions = all.map((p) => ({ value: p.id, label: p.name, hint: p.canApprove ? undefined : "Cannot approve documents", disabled: !p.canApprove }));
  return (
    <MenuCard title="Reviewers and approver" subtitle="Each reviewer accepts or sends it back. Once all have accepted, the approver approves it. The author cannot be either; a reviewer may also approve.">
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          <ComboField
            label="Reviewers"
            required
            value={null}
            onChange={(v) => v && save([...reviewerIds, v], revision.approver?.id ?? null)}
            options={reviewerOptions}
            placeholder={reviewerOptions.length ? "Add a reviewer" : "Nobody else to add"}
            disabled={!reviewerOptions.length}
          />
          {revision.reviewers.length > 0 && (
            <ul aria-label="Reviewers" className="flex flex-wrap gap-2">
              {revision.reviewers.map((r) => (
                <li key={r.id} className="flex items-center gap-1 rounded-full bg-primary-bg px-3 py-1 text-sm text-primary-text">
                  {r.name}
                  <button
                    type="button"
                    aria-label={`Remove ${r.name}`}
                    onClick={() => save(reviewerIds.filter((x) => x !== r.id), revision.approver?.id ?? null)}
                    className="text-icon-color hover:text-error-color">
                    <XIcon className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <ComboField label="Approver" required value={revision.approver?.id ?? null} onChange={(v) => save(reviewerIds, v)} options={approverOptions} placeholder="Who approves it" />
      </div>
    </MenuCard>
  );
};

/** Every review round, newest first: who was asked, what they decided and what they said. */
export const SignoffsCard = ({ revision }) => {
  if (!revision.signoffs.length) return null;
  const rounds = [...new Set(revision.signoffs.map((s) => s.round))];
  return (
    <MenuCard title="Reviews and approval">
      <div className="flex flex-col gap-4">
        {rounds.map((round) => (
          <section key={round} aria-label={`Round ${round}`}>
            <h3 className="mb-1 text-sm font-semibold text-secondary-text">
              Round {round}
              {round === revision.reviewRound && revision.status !== "draft" ? " (current)" : ""}
            </h3>
            <ul className="divide-y divide-border-color">
              {revision.signoffs
                .filter((s) => s.round === round)
                .map((s) => (
                  <li key={s.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
                    <div className="flex min-w-0 flex-col">
                      <span className="text-sm text-primary-text">
                        {s.person.name} <span className="text-secondary-text">· {s.role === "reviewer" ? "reviewer" : "approver"}</span>
                      </span>
                      {s.comment && <span className="whitespace-pre-wrap text-sm text-secondary-text">“{s.comment}”</span>}
                    </div>
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusPill(SIGNOFF_DECISION, s.decision)}`}>
                      {SIGNOFF_DECISION[s.decision]?.label ?? s.decision}
                      {s.decidedAt ? ` · ${formatDay(s.decidedAt)}` : ""}
                    </span>
                  </li>
                ))}
            </ul>
          </section>
        ))}
      </div>
    </MenuCard>
  );
};

const SendBackDialog = ({ revision, action, onClose }) => {
  const { mutation, run } = useRun(onClose);
  const [comment, setComment] = useState("");
  const ok = comment.trim().length >= 3;
  const save = (e) => {
    e.preventDefault();
    if (!ok) return;
    run(action === "review" ? { action, id: revision.id, body: { accept: false, comment: comment.trim() } } : { action: "sendBack", id: revision.id, body: { comment: comment.trim() } });
  };
  return (
    <Dialog title="Send it back" onClose={onClose}>
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        <p className="text-sm text-secondary-text">It goes back to the author as a draft. When it is sent again, every reviewer looks at it again.</p>
        <Field label="What needs changing?" value={comment} onChange={(e) => setComment(e.target.value)} required maxLength={2000} />
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={!ok} label="Send back" type="danger" />
      </form>
    </Dialog>
  );
};

const ApproveDialog = ({ revision, onClose }) => {
  const { mutation, run } = useRun(onClose);
  const [effectiveFrom, setEffectiveFrom] = useState(todayIso());
  const [comment, setComment] = useState("");
  const save = (e) => {
    e.preventDefault();
    if (!effectiveFrom) return;
    run({ action: "approve", id: revision.id, body: { effectiveFrom, comment: comment.trim() || undefined } });
  };
  const today = effectiveFrom === todayIso();
  return (
    <Dialog title={`Approve ${revision.document.number} rev ${revision.letter}`} onClose={onClose}>
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        <RHFDatePickerPopout label="Takes effect on" required value={effectiveFrom} onChange={(v) => setEffectiveFrom(v ?? "")} valueFormat="iso" minDate={new Date(`${todayIso()}T00:00:00`)} />
        <p className="text-sm text-secondary-text">
          {today
            ? "It is in force as soon as you approve it, and the revision in force now is superseded."
            : "Until then the revision in force now stays in force; on that day it is superseded."}
        </p>
        <Field label="Comment" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} hint="Optional" />
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={!effectiveFrom} label="Approve" />
      </form>
    </Dialog>
  );
};

/** What is asked of the signed-in person: accept or send back as a reviewer, approve or send back as the approver. */
export const MyTurnCard = ({ revision }) => {
  const { mutation, run } = useRun();
  const [dialog, setDialog] = useState(null);
  if (!revision.myTurn) return null;
  const reviewing = revision.myTurn === "review";
  return (
    <Callout
      tone="info"
      title={reviewing ? "Your review is needed" : "Your approval is needed"}
      action={
        <div className="flex flex-wrap gap-2">
          {reviewing ? (
            <CTAButton type="success" icon={CheckIcon} loading={mutation.isPending} onClick={() => run({ action: "review", id: revision.id, body: { accept: true } })}>
              Accept
            </CTAButton>
          ) : (
            <CTAButton type="success" icon={CheckIcon} onClick={() => setDialog("approve")}>
              Approve
            </CTAButton>
          )}
          <CTAButton type="danger" icon={Undo2Icon} onClick={() => setDialog("back")}>
            Send back
          </CTAButton>
        </div>
      }>
      {reviewing ? "Read it through, then accept it or send it back to the author with what needs changing." : "Every reviewer has accepted it. Approve it with the date it takes effect, or send it back."}
      {dialog === "approve" && <ApproveDialog revision={revision} onClose={() => setDialog(null)} />}
      {dialog === "back" && <SendBackDialog revision={revision} action={reviewing ? "review" : "sendBack"} onClose={() => setDialog(null)} />}
    </Callout>
  );
};

const CHANGE_CLASS = {
  added: "border-l-4 border-success-color bg-success-color/10",
  removed: "border-l-4 border-error-color bg-error-color/10 line-through decoration-error-color/60",
  same: "border-l-4 border-transparent text-secondary-text",
};

/** What changed against the revision it was started from (or the one in force): blocks of text and files. */
export const CompareCard = ({ revision }) => {
  const [open, setOpen] = useState(false);
  const canCompare = Boolean(revision.previousRevisionId || (revision.document.currentRevision && revision.document.currentRevision.id !== revision.id));
  const query = useDocumentCompare(revision.id, { enabled: open && canCompare });
  if (!canCompare) return null;
  const data = query.data;
  const s = data?.textSummary;
  return (
    <MenuCard
      title="What changed"
      subtitle={data?.against ? `Against ${data.against.label}` : "Against the revision it replaces"}
      action={
        <CTAButton type="neutral" onClick={() => setOpen((v) => !v)}>
          {open ? "Hide" : "Compare"}
        </CTAButton>
      }>
      {!open ? (
        <p className="text-sm text-secondary-text">Show the text and files added and removed since the previous revision.</p>
      ) : query.isLoading ? (
        <LoadingScreen />
      ) : query.error ? (
        <FormError error={query.error} />
      ) : (
        <div className="flex flex-col gap-3">
          {revision.document.contentKind === "text" && (
            <>
              <p className="text-sm text-secondary-text">
                {s.added} added, {s.removed} removed, {s.same} unchanged
              </p>
              <ol aria-label="Text changes" className="flex flex-col gap-1">
                {data.text.map((c, i) => (
                  <li key={i} className={`rounded px-2 py-1 text-sm ${CHANGE_CLASS[c.kind]}`}>
                    <span className="sr-only">{c.kind === "same" ? "Unchanged" : c.kind === "added" ? "Added" : "Removed"}: </span>
                    <span className="mr-2 text-xs uppercase tracking-wide text-tertiary-text">{c.block}</span>
                    {c.text}
                  </li>
                ))}
              </ol>
            </>
          )}
          {data.files.length > 0 && (
            <ul aria-label="File changes" className="flex flex-col gap-1">
              {data.files.map((f, i) => (
                <li key={i} className={`rounded px-2 py-1 text-sm ${CHANGE_CLASS[f.kind]}`}>
                  {f.kind === "same" ? "Kept" : f.kind === "added" ? "Added" : "Removed"}: {f.fileName} ({f.role === "main" ? "main file" : "attachment"})
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </MenuCard>
  );
};

/** Submit a draft for review once nothing is still needed. */
export const SubmitButton = ({ revision, beforeSubmit }) => {
  const { mutation, run } = useRun();
  const [settling, setSettling] = useState(false);
  if (!revision.canEdit) return null;
  const submit = async () => {
    setSettling(true);
    try {
      await beforeSubmit?.();
    } catch {
      return; // the save failed and said so; nothing is sent
    } finally {
      setSettling(false);
    }
    run({ action: "submit", id: revision.id });
  };
  return (
    <CTAButton type="main" disabled={revision.problems.length > 0} loading={mutation.isPending || settling} onClick={submit}>
      Send for review
    </CTAButton>
  );
};
