import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { BanIcon, FilePlusIcon, PencilIcon } from "@/components/icons";
import CTAButton from "@/components/CTAButton";
import { describeApiError } from "../../lib/api-client";
import { useToast } from "../../contexts/ToastProvider";
import { useCustomFieldPeople } from "../../hooks/useCustomFields";
import { useDocument, useDocumentMutation } from "../../hooks/useDocuments";
import { useBreadcrumbNames } from "../../lib/breadcrumbs";
import { contentKindLabel, DOCUMENT_STATUS, formatDay, revisionLabel, revisionPath, REVISION_STATUS, statusLabel, statusPill } from "../../lib/documents";
import { ErrorNotice, FormError } from "../master-data/shared";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import LoadingScreen from "../ui/LoadingScreen";
import MenuCard from "../ui/MenuCard";
import { ReadersCard, SkillsCard } from "./ReadersPanels";

const Fact = ({ label, children }) => (
  <div className="flex flex-col">
    <dt className="text-xs font-medium uppercase tracking-wide text-secondary-text">{label}</dt>
    <dd className="text-sm text-primary-text">{children}</dd>
  </div>
);

const formatDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "—");

/** Title, description and owner (the number, type and content kind never change). */
const EditDialog = ({ doc, onClose }) => {
  const mutation = useDocumentMutation();
  const people = useCustomFieldPeople();
  const { showToast } = useToast();
  const [title, setTitle] = useState(doc.title);
  const [description, setDescription] = useState(doc.description ?? "");
  const [ownerId, setOwnerId] = useState(doc.owner?.id ?? null);
  const options = (people.data ?? []).map((p) => ({ value: p.id, label: p.name }));
  const ready = title.trim() && ownerId;
  const save = (e) => {
    e.preventDefault();
    if (!ready) return;
    mutation.mutate(
      { action: "updateDocument", id: doc.id, body: { title: title.trim(), description: description.trim() || null, ownerId } },
      { onSuccess: onClose, onError: (err) => showToast({ type: "error", title: "Not saved", message: describeApiError(err) }) },
    );
  };
  return (
    <Dialog title={`Edit ${doc.number}`} onClose={onClose} width="max-w-xl">
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        <Field label="Title" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
        <ComboField label="Owner" required value={ownerId} onChange={setOwnerId} options={options} placeholder="Who looks after it" />
        <Field label="Description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} hint="Optional: scope or purpose" />
        <p className="text-sm text-secondary-text">The number, type and whether it is a file or written here never change.</p>
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton buttonType="submit" type="main" size="md" disabled={!ready || mutation.isPending} loading={mutation.isPending}>
            Save
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/** Withdrawing a document in force: documentation.issue, with a reason. */
const WithdrawDialog = ({ doc, onClose }) => {
  const mutation = useDocumentMutation();
  const { showToast } = useToast();
  const [reason, setReason] = useState("");
  const ok = reason.trim().length >= 3;
  const save = (e) => {
    e.preventDefault();
    if (!ok) return;
    mutation.mutate({ action: "withdraw", id: doc.id, body: { reason: reason.trim() } }, { onSuccess: onClose, onError: (err) => showToast({ type: "error", title: "Not withdrawn", message: describeApiError(err) }) });
  };
  return (
    <Dialog title={`Withdraw ${doc.number}`} onClose={onClose}>
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        <p className="text-sm text-secondary-text">
          The revision in force is withdrawn and the document is no longer in force anywhere. A draft in progress is left as it is. It can be revised back into use later.
        </p>
        <Field label="Why?" value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={500} />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton buttonType="submit" type="danger" size="md" disabled={!ok || mutation.isPending} loading={mutation.isPending}>
            Withdraw
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/** A document (`/Documentation/Documents/:id`): what it is, the revision in force, who owns it, and its revisions. */
const DocumentPage = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const query = useDocument(id);
  const start = useDocumentMutation();
  const { showToast } = useToast();
  const [editing, setEditing] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const doc = query.data;
  useBreadcrumbNames([
    { path: `/Documentation/Documents/${id}`, label: doc ? `${doc.number} · ${doc.title}` : null },
    { path: "/Documentation", label: "Documentation", to: "/Documentation/Documents" },
  ]);

  if (query.isLoading) return <LoadingScreen />;
  if (query.error) return <ErrorNotice error={query.error} />;
  const draft = doc.inProgress;

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold text-primary-text">{doc.number}</h1>
            <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusPill(DOCUMENT_STATUS, doc.status)}`}>{statusLabel(DOCUMENT_STATUS, doc.status)}</span>
          </div>
          <p className="text-lg text-primary-text">{doc.title}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {doc.canStartRevision && (
            <CTAButton
              type="main"
              icon={FilePlusIcon}
              loading={start.isPending}
              onClick={() =>
                start.mutate(
                  { action: "startRevision", id: doc.id },
                  { onSuccess: (rev) => navigate(revisionPath(doc.id, rev.id)), onError: (err) => showToast({ type: "error", title: "Not started", message: describeApiError(err) }) },
                )
              }>
              Start a new revision
            </CTAButton>
          )}
          {doc.canManage && (
            <CTAButton type="secondary" icon={PencilIcon} onClick={() => setEditing(true)}>
              Edit details
            </CTAButton>
          )}
          {doc.canIssue && doc.status === "active" && (
            <CTAButton type="danger" icon={BanIcon} onClick={() => setWithdrawing(true)}>
              Withdraw
            </CTAButton>
          )}
        </div>
      </header>

      {doc.status === "active" && doc.currentRevision && (
        <Callout
          tone="success"
          title={`Rev ${doc.currentRevision.letter} is in force`}
          action={
            <CTAButton type="secondary" to={revisionPath(doc.id, doc.currentRevision.id)}>
              Read it
            </CTAButton>
          }>
          In force since {formatDay(doc.currentRevision.effectiveFrom)}.
        </Callout>
      )}
      {doc.status === "withdrawn" && (
        <Callout tone="error" title="Withdrawn">
          {doc.withdrawReason} ({formatDay(doc.withdrawnAt)}). It is not in force anywhere.
        </Callout>
      )}

      {doc.status === "discarded" && (
        <Callout tone="warning" title="Discarded">
          Its only draft was discarded before it was ever issued. The number {doc.number} is kept and never reused.
        </Callout>
      )}
      {draft && (
        <Callout
          tone="info"
          title={`${statusLabel(REVISION_STATUS, draft.status)} in progress`}
          action={
            <CTAButton type="main" to={revisionPath(doc.id, draft.id)}>
              {draft.status === "draft" && doc.canManage ? "Open the draft" : "Open it"}
            </CTAButton>
          }>
          {draft.status === "approved"
            ? `Rev ${draft.letter} is approved and takes effect on ${formatDay(draft.effectiveFrom)}.`
            : draft.letter
              ? `Rev ${draft.letter} is ${statusLabel(REVISION_STATUS, draft.status).toLowerCase()}.`
              : `It becomes rev ${doc.nextLetter} when it is sent for review.`}
        </Callout>
      )}

      <MenuCard title="Details">
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Fact label="Type">
            {doc.type.name} ({doc.type.prefix})
          </Fact>
          <Fact label="Content">{contentKindLabel(doc.contentKind)}</Fact>
          <Fact label="Owner">{doc.owner?.name ?? "—"}</Fact>
          <Fact label="Created">{formatDate(doc.createdAt)}</Fact>
          {doc.restricted && <Fact label="Access">Restricted to its readers</Fact>}
          {doc.numberTyped && <Fact label="Brought across">Numbered by hand; revisions continue from {doc.startLetter}</Fact>}
          {doc.description && (
            <div className="sm:col-span-2 lg:col-span-4">
              <Fact label="Description">{doc.description}</Fact>
            </div>
          )}
        </dl>
      </MenuCard>

      <div className="grid gap-4 lg:grid-cols-2">
        <ReadersCard doc={doc} />
        <SkillsCard doc={doc} />
      </div>

      <MenuCard title="Revisions" subtitle="Each revision is written, reviewed, approved and then frozen. A change is always a new revision.">
        <ul className="-my-3 divide-y divide-border-color" aria-label="Revisions">
          {doc.revisions.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="flex flex-col">
                <Link to={revisionPath(doc.id, r.id)} className="font-medium text-primary-text hover:underline">
                  {revisionLabel(r, r.status === "draft" ? doc.nextLetter : null)}
                </Link>
                <span className="text-sm text-secondary-text">
                  {r.author?.name ?? "Unknown"} · started {formatDate(r.createdAt)}
                  {r.effectiveFrom ? ` · effective ${formatDay(r.effectiveFrom)}` : ""}
                  {r.changeSummary ? ` · ${r.changeSummary}` : ""}
                  {r.discardReason ? ` · discarded: ${r.discardReason}` : ""}
                </span>
              </div>
              <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusPill(REVISION_STATUS, r.status)}`}>{statusLabel(REVISION_STATUS, r.status)}</span>
            </li>
          ))}
        </ul>
      </MenuCard>

      {editing && <EditDialog doc={doc} onClose={() => setEditing(false)} />}
      {withdrawing && <WithdrawDialog doc={doc} onClose={() => setWithdrawing(false)} />}
    </div>
  );
};

export default DocumentPage;
