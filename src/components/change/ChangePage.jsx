import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { FileTextIcon, LinkIcon, PencilIcon, RotateCcwIcon, SendIcon, XIcon } from "@/components/icons";
import CTAButton from "@/components/CTAButton";
import { useChange, useChangeAttachmentMutation, useChangeAttachments, useChangeMutation } from "../../hooks/useChange";
import { useBreadcrumbNames } from "../../lib/breadcrumbs";
import { formatDay, linkKindLabel, linkPath, linkWords, noticePath, originLabel, recordPath, STEPS, stageLabel, stagePill, stepState, urgencyLabel } from "../../lib/change";
import { ErrorNotice, FormError, TextAreaField } from "../master-data/shared";
import Callout from "../ui/Callout";
import Dialog from "../ui/Dialog";
import { AttachmentDrop } from "../ui/FileDrop";
import LoadingScreen from "../ui/LoadingScreen";
import MenuCard from "../ui/MenuCard";
import { BoardCard, CustomerCard, CutInCard, ImpactCard } from "./ChangeAssessment";
import { CancelDialog, ChangeDialog, LinksDialog } from "./ChangeDialogs";

const Fact = ({ label, children }) => (
  <div>
    <dt className="text-xs font-medium uppercase tracking-wide text-secondary-text">{label}</dt>
    <dd className="whitespace-pre-wrap text-sm text-primary-text">{children}</dd>
  </div>
);

/** A list of what the change covers, each to its record's page when it has one and the reader may open it. */
const CoverList = ({ links }) => (
  <ul aria-label="What it covers" className="flex flex-wrap gap-2">
    {links.map((l) => {
      const to = linkPath(l);
      const chip = (
        <>
          <span className="text-secondary-text">{linkKindLabel(l.kind)}</span> <span className="text-primary-text">{linkWords(l)}</span>
        </>
      );
      return (
        <li key={`${l.kind}:${l.id ?? l.code}`} className="rounded-full border border-border-color bg-primary-bg px-3 py-1 text-sm">
          {to ? (
            <Link to={to} className="hover:underline">
              {chip}
            </Link>
          ) : (
            chip
          )}
        </li>
      );
    })}
  </ul>
);

const ChangeFiles = ({ change }) => {
  const attachments = useChangeAttachments(change.id);
  const mutation = useChangeAttachmentMutation();
  return (
    <AttachmentDrop
      recordId={change.id}
      bucket="change-files"
      folder="change"
      attachments={attachments}
      mutation={mutation}
      attachUrl={`/changes/${change.id}/attachments`}
      itemBase="/change-attachments"
      title="Files"
      subtitle={change.canAddFiles ? "Drawings, customer requests, emails and anything else that belongs with this change." : undefined}
      canEdit={change.canAddFiles}
    />
  );
};

/** The stages a change moves through, with where this one is. */
const Stepper = ({ stage }) => (
  <ol aria-label="Stages" className="flex flex-wrap items-center gap-2 text-sm">
    {STEPS.map((s, i) => {
      const state = stepState(stage, s.stage);
      return (
        <li
          key={s.stage}
          aria-current={state === "current" ? "step" : undefined}
          className={`flex items-center gap-2 rounded-full border px-3 py-1 ${
            state === "current" ? "border-brand-primary bg-brand-primary/10 font-medium text-primary-text" : state === "done" ? "border-success-color/40 text-success-color" : "border-border-color text-secondary-text"
          }`}>
          <span className="text-xs">{state === "done" ? "✓" : i + 1}</span>
          {s.label}
        </li>
      );
    })}
  </ol>
);

/** Take a change back from the board, with a reason. */
const RecallDialog = ({ change, onClose }) => {
  const mutation = useChangeMutation();
  const [reason, setReason] = useState("");
  const send = (e) => {
    e.preventDefault();
    mutation.mutate({ action: "recall", id: change.id, body: { reason: reason.trim() } }, { onSuccess: onClose });
  };
  return (
    <Dialog title={`Take ${change.reference} back from the board`} onClose={onClose}>
      <form noValidate onSubmit={send} className="flex flex-col gap-3">
        <p className="text-sm text-secondary-text">It returns to assessment and the sign-offs still waiting are dropped. Everyone signs again once it is sent to the board.</p>
        <TextAreaField label="Why is it taken back?" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={3} required />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton buttonType="submit" type="main" size="md" disabled={reason.trim().length < 3 || mutation.isPending} loading={mutation.isPending}>
            Take it back
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/**
 * A change (`/Change/:id`): what is changing and why, where it came from, what it covers, the impact assessment, the board and its sign-offs, the
 * cut-in point, the customer's approval and the files. Tasks, carrying the change out and closing it come in the next slices.
 */
const ChangePage = () => {
  const { id } = useParams();
  const query = useChange(id);
  const mutation = useChangeMutation();
  const [dialog, setDialog] = useState(null);
  const change = query.data;
  useBreadcrumbNames([{ path: `/Change/${id}`, label: change ? `${change.reference} · ${change.title}` : null }]);

  if (query.isLoading) return <LoadingScreen />;
  if (query.error) return <ErrorNotice error={query.error} />;
  const stage = change.stage;
  const notReady = change.problems.length > 0;
  const move = (action) => mutation.mutate({ action, id: change.id });

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold text-primary-text">{change.reference}</h1>
            <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${stagePill(stage)}`}>{stageLabel(stage)}</span>
            {change.urgency === "expedited" && <span className="inline-flex rounded-full bg-warning-color/15 px-2 py-0.5 text-xs font-medium text-warning-color">Expedited</span>}
          </div>
          <p className="text-lg text-primary-text">{change.title}</p>
          {change.origin && (
            <p className="text-sm text-secondary-text">
              Raised from {originLabel(change.origin.kind).toLowerCase()}{" "}
              {change.origin.readable ? (
                <Link to={recordPath(change.origin.kind, change.origin.id)} className="font-medium text-primary-text hover:underline">
                  {[change.origin.reference, change.origin.name].filter(Boolean).join(" · ")}
                </Link>
              ) : (
                "you cannot open"
              )}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {change.canSubmit && (
            <CTAButton type="main" icon={SendIcon} disabled={notReady} loading={mutation.isPending && mutation.variables?.action === "submit"} onClick={() => move("submit")}>
              Submit for assessment
            </CTAButton>
          )}
          {change.canSendToBoard && (
            <CTAButton type="main" icon={SendIcon} disabled={notReady} loading={mutation.isPending && mutation.variables?.action === "sendToBoard"} onClick={() => move("sendToBoard")}>
              Send to the board
            </CTAButton>
          )}
          {change.canRecall && (
            <CTAButton type="secondary" icon={RotateCcwIcon} onClick={() => setDialog("recall")}>
              Take back from the board
            </CTAButton>
          )}
          {["approved"].includes(stage) && (
            <CTAButton type="secondary" icon={FileTextIcon} to={noticePath(change.id)}>
              Change notice
            </CTAButton>
          )}
          {change.canEdit && (
            <CTAButton type="secondary" icon={PencilIcon} onClick={() => setDialog("edit")}>
              Edit details
            </CTAButton>
          )}
          {change.canCancel && (
            <CTAButton type="danger" icon={XIcon} onClick={() => setDialog("cancel")}>
              Cancel change
            </CTAButton>
          )}
        </div>
      </header>

      {stage !== "cancelled" && <Stepper stage={stage} />}
      <FormError error={mutation.error} />

      {stage === "cancelled" && (
        <Callout tone="warning" title="Cancelled">
          {change.cancelReason} ({formatDay(change.cancelledAt)}
          {change.cancelledBy ? `, ${change.cancelledBy}` : ""}). It is kept as it is.
        </Callout>
      )}
      {stage === "assessment" && change.returnReason && (
        <Callout tone="warning" title="Sent back">
          {change.returnReason}. Deal with it, then send the change to the board again; everyone signs again.
        </Callout>
      )}
      {stage === "approval" && (
        <Callout tone="info" title="With the board">
          Waiting for {change.signoffs.filter((s) => s.round === change.reviewRound && s.status === "pending").length} sign-off(s).
        </Callout>
      )}
      {stage === "approved" && (
        <Callout tone="success" title="Approved">
          Approved {formatDay(change.approvedAt)}
          {change.approvedBy ? ` by ${change.approvedBy}` : ""}. Tasks to carry it out, and closing it with a check that it worked, come in the next slices.
        </Callout>
      )}
      {["draft", "assessment"].includes(stage) && change.canManage && notReady && (
        <Callout tone="info" title={stage === "draft" ? "Still needed before it can be assessed" : "Still needed before it can go to the board"}>
          <ul aria-label="Still needed" className="list-disc pl-5">
            {change.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Callout>
      )}

      <MenuCard title="Details">
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Fact label="Type">{change.type.label}</Fact>
          <Fact label="Urgency">{urgencyLabel(change.urgency)}</Fact>
          <Fact label="Raised by">{change.raisedBy?.name ?? "—"}</Fact>
          <Fact label="Raised">{formatDay(change.createdAt)}</Fact>
          <div className="sm:col-span-2 lg:col-span-2">
            <Fact label="What is changing">{change.description ?? "—"}</Fact>
          </div>
          <div className="sm:col-span-2 lg:col-span-2">
            <Fact label="Why">{change.reason ?? "—"}</Fact>
          </div>
        </dl>
      </MenuCard>

      <MenuCard
        title="What it covers"
        subtitle="The parts, machines, suppliers and orders this change touches. They stay where they are; each opens to people who may read it."
        action={
          change.canEdit && (
            <CTAButton type="secondary" icon={change.links.length ? PencilIcon : LinkIcon} onClick={() => setDialog("links")}>
              {change.links.length ? "Change" : "Add"}
            </CTAButton>
          )
        }>
        {change.links.length === 0 ? <p className="text-sm text-secondary-text">Nothing yet.</p> : <CoverList links={change.links} />}
      </MenuCard>

      <ImpactCard change={change} />
      <BoardCard change={change} />
      <CutInCard change={change} />
      <CustomerCard change={change} />
      <ChangeFiles change={change} />

      {dialog === "edit" && <ChangeDialog existing={change} onClose={() => setDialog(null)} />}
      {dialog === "links" && <LinksDialog change={change} onClose={() => setDialog(null)} />}
      {dialog === "cancel" && <CancelDialog change={change} onClose={() => setDialog(null)} />}
      {dialog === "recall" && <RecallDialog change={change} onClose={() => setDialog(null)} />}
    </div>
  );
};

export default ChangePage;
