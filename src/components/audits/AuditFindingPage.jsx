import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeftIcon } from "@/components/icons";
import { useToast } from "../../contexts/ToastProvider";
import { useAuditFinding, useAuditMutation, useFindingAttachments } from "../../hooks/useAudits";
import { usePermissions } from "../../hooks/useQmsApi";
import { FINDING_KIND_PILL, FINDING_STATUS_PILL, findingKindLabel, findingStatusLabel, SEVERITIES } from "../../lib/audits";
import { formatDate, ncrPath } from "../../lib/ncr";
import { formatDateTime } from "../../lib/processControl";
import ReasonDialog from "../ncr/ReasonDialog";
import Dialog from "../ui/Dialog";
import ComboField from "../ui/ComboField";
import { AttachmentDrop } from "../ui/FileDrop";
import MenuCard from "../ui/MenuCard";
import { ErrorNotice, FormError, TextAreaField } from "../master-data/shared";
import FindingDialog from "./FindingDialog";
import CTAButton from "@/components/CTAButton";
import Callout from "../ui/Callout";

const inputClass = "w-full rounded-lg border border-border-color bg-text-input-color px-3 py-1.5 text-sm font-normal text-primary-text focus:outline-none focus:border-brand-primary";

const Fact = ({ label, children }) => (
  <div className="flex min-w-0 flex-col gap-0.5">
    <dt className="text-xs font-medium text-secondary-text">{label}</dt>
    <dd className="text-sm text-primary-text">{children || "—"}</dd>
  </div>
);

/** Raise a draft internal non-conformance from the finding. Nothing is sent that the person did not see; leaving the severity out uses the classification's. */
const CreateNcrDialog = ({ finding, onClose }) => {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const mutation = useAuditMutation();
  const [title, setTitle] = useState(finding.title);
  const [description, setDescription] = useState(`Raised from audit ${finding.record.reference}, finding ${finding.reference}.`);
  const [severity, setSeverity] = useState(null);
  return (
    <Dialog title="Raise a non-conformance" onClose={onClose} width="max-w-2xl">
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate(
            { path: `/audit-findings/${finding.id}/create-ncr`, body: { title: title.trim() || undefined, description: description.trim() || undefined, severity: severity ?? undefined } },
            {
              onSuccess: (res) => {
                showToast(res.created ? { type: "success", title: "Draft non-conformance raised", message: "Review it and open it when it is ready." } : { type: "info", title: "Already raised", message: "This finding already has a non-conformance; here it is." });
                onClose();
                navigate(ncrPath(res.nonconformanceId));
              },
            }
          );
        }}>
        <p className="text-sm text-secondary-text">What was found and the requirement come over from the finding.</p>
        <label className="flex flex-col gap-1 text-sm font-medium text-secondary-text" data-required>
          Title
          <input className={inputClass} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} required aria-required="true" />
        </label>
        <ComboField label="Severity" value={severity} onChange={setSeverity} options={SEVERITIES} placeholder="Use the classification's" />
        <TextAreaField label="Description" rows={4} value={description} maxLength={5000} onChange={(e) => setDescription(e.target.value)} />
        <p className="text-sm text-secondary-text">It is created as a draft internal non-conformance. Nothing else happens until someone opens it.</p>
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" onClick={onClose} type="neutral" size="md">
            Cancel
          </CTAButton>
          <CTAButton buttonType="submit" disabled={!title.trim() || mutation.isPending} loading={mutation.isPending} type="main" size="lg">
            {mutation.isPending ? "Raising…" : "Raise non-conformance"}
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

const Evidence = ({ finding, editable }) => {
  const attachments = useFindingAttachments(finding.id);
  const mutation = useAuditMutation();
  return (
    <AttachmentDrop
      recordId={finding.id}
      bucket="audit-files"
      folder={`audit/${finding.record.id}/findings`}
      attachments={attachments}
      mutation={mutation}
      attachUrl={`/audit-findings/${finding.id}/attachments`}
      itemBase="/audit-finding-attachments"
      title="Photographs and documents"
      subtitle={editable ? "Evidence of what was found." : undefined}
      canEdit={editable}
    />
  );
};

/** One finding (/Documentation/Audit-Findings/:id): what was found, who owns it, the evidence, and the non-conformance raised from it. */
const AuditFindingPage = () => {
  const { id } = useParams();
  const { can } = usePermissions();
  const query = useAuditFinding(id);
  const mutation = useAuditMutation();
  const { showToast } = useToast();
  const [dialog, setDialog] = useState(null);

  if (query.isLoading) return <p className="p-6 text-secondary-text">Loading…</p>;
  if (query.error || !query.data) return <div className="p-6"><ErrorNotice error={query.error ?? new Error("Not found")} /></div>;
  const f = query.data;
  const open = f.status === "open";
  const canPerform = can("audits.perform") && f.record.status !== "abandoned";
  const canManage = can("audits.manage");
  const canRaise = open && f.classification.kind === "nonconformity" && !f.ncr && can("ncr.create");
  const done = (title) => () => {
    showToast({ type: "success", title, message: f.reference });
    setDialog(null);
  };

  return (
    <div className="flex w-full min-w-0 flex-1 min-h-0 flex-col gap-4 overflow-auto bg-primary-bg p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Link to="/Documentation/Audit-Findings" className="flex w-fit items-center gap-1 text-sm text-link-color hover:underline">
            <ArrowLeftIcon /> Audit findings
          </Link>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-semibold text-primary-text">
              {f.reference} · {f.title}
            </h1>
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${FINDING_KIND_PILL[f.classification.kind]}`}>{f.classification.label}</span>
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${FINDING_STATUS_PILL[f.status]}`}>{findingStatusLabel(f.status)}</span>
            {f.overdue && <span className="rounded-full bg-error-color/15 px-2 py-0.5 text-xs font-medium text-error-color">Overdue</span>}
          </div>
          <Link to={`/Documentation/Audit-Records/${f.record.id}`} className="w-fit text-sm text-link-color hover:underline">
            {f.record.reference} · {f.record.audit.title}
          </Link>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canRaise && (
            <CTAButton buttonType="button" type="secondary" size="md" onClick={() => setDialog("ncr")}>
              Create non-conformance
            </CTAButton>
          )}
          {open && canPerform && (
            <CTAButton buttonType="button" type="neutral" size="md" onClick={() => setDialog("edit")}>
              Edit
            </CTAButton>
          )}
          {open && canManage && (
            <CTAButton buttonType="button" type="main" size="lg" onClick={() => setDialog("close")}>
              Close finding
            </CTAButton>
          )}
          {open && canPerform && !f.ncr && (
            <CTAButton buttonType="button" type="danger" size="md" onClick={() => setDialog("withdraw")}>
              Withdraw
            </CTAButton>
          )}
          {f.status === "closed" && canManage && (
            <CTAButton buttonType="button" type="neutral" size="md" onClick={() => setDialog("reopen")}>
              Reopen
            </CTAButton>
          )}
        </div>
      </div>

      {f.status === "closed" && (
        <Callout tone="success" role="status" title="Closed">
          {f.closedBy ? `By ${f.closedBy.name}` : ""}
          {f.closedAt ? ` on ${formatDateTime(f.closedAt)}` : ""}: {f.closedNote}
        </Callout>
      )}
      {f.status === "withdrawn" && (
        <Callout tone="info" role="status" title="Withdrawn">
          {f.withdrawReason}
        </Callout>
      )}
      {open && f.reopenReason && (
        <Callout tone="warning" role="status" title="Reopened">
          {f.reopenReason}
        </Callout>
      )}

      <MenuCard title="The finding" subtitle="What the audit found">
        <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Fact label="Classification">{`${f.classification.label} (${findingKindLabel(f.classification.kind).toLowerCase()})`}</Fact>
          <Fact label="Owner">{f.owner?.name}</Fact>
          <Fact label="Due">{f.dueOn ? formatDate(f.dueOn) : null}</Fact>
          <Fact label="Raised">{`${formatDateTime(f.createdAt)}${f.createdBy ? ` by ${f.createdBy.name}` : ""}`}</Fact>
          <Fact label="Audit carried out">{formatDate(f.record.performedOn)}</Fact>
          <Fact label="From the answer to">{f.answer ? `Question ${f.answer.sequence}: ${f.answer.question}` : "Not tied to a question"}</Fact>
        </dl>
        <div className="mt-4 flex flex-col gap-3">
          <div>
            <p className="text-xs font-medium text-secondary-text">What was found</p>
            <p className="whitespace-pre-wrap text-sm text-primary-text">{f.description}</p>
          </div>
          {f.requirement && (
            <div>
              <p className="text-xs font-medium text-secondary-text">Requirement it was measured against</p>
              <p className="whitespace-pre-wrap text-sm text-primary-text">{f.requirement}</p>
            </div>
          )}
        </div>
      </MenuCard>

      <MenuCard title="Evidence" subtitle="Photographs and documents kept with the finding">
        <Evidence finding={f} editable={open && canPerform} />
      </MenuCard>

      <MenuCard title="Non-conformance" subtitle="A finding classified as a non-conformity can be taken into the non-conformance workflow, once">
        {f.ncr ? (
          <p className="text-sm text-primary-text">
            Raised as{" "}
            <Link to={ncrPath(f.ncr.id)} className="font-medium text-link-color hover:underline">
              {f.ncr.reference}
            </Link>{" "}
            <span className="text-secondary-text">({f.ncr.stage.replace(/_/g, " ")})</span>
            {open && <span className="block text-secondary-text">The finding can be closed once that non-conformance is closed.</span>}
          </p>
        ) : f.classification.kind !== "nonconformity" ? (
          <p className="text-sm text-secondary-text">This finding is {f.classification.kind === "observation" ? "an observation" : "an opportunity for improvement"}, so it is not raised as a non-conformance.</p>
        ) : open ? (
          <p className="text-sm text-secondary-text">{canRaise ? "No non-conformance has been raised from this finding yet." : "No non-conformance has been raised from this finding. Raising one needs permission to create non-conformances."}</p>
        ) : (
          <p className="text-sm text-secondary-text">No non-conformance was raised from this finding.</p>
        )}
      </MenuCard>

      {dialog === "edit" && <FindingDialog record={{ id: f.record.id, reference: f.record.reference }} finding={f} onClose={() => setDialog(null)} />}
      {dialog === "ncr" && <CreateNcrDialog finding={f} onClose={() => setDialog(null)} />}
      {dialog === "close" && (
        <ReasonDialog
          title={`Close ${f.reference}?`}
          label="How was it resolved?"
          confirmText="Close finding"
          pending={mutation.isPending}
          error={mutation.error}
          onClose={() => setDialog(null)}
          onConfirm={(note) => mutation.mutate({ path: `/audit-findings/${f.id}/close`, body: { note } }, { onSuccess: done("Finding closed") })}
        />
      )}
      {dialog === "withdraw" && (
        <ReasonDialog
          title={`Withdraw ${f.reference}?`}
          label="Why was it raised in error?"
          confirmText="Withdraw finding"
          pending={mutation.isPending}
          error={mutation.error}
          onClose={() => setDialog(null)}
          onConfirm={(reason) => mutation.mutate({ path: `/audit-findings/${f.id}/withdraw`, body: { reason } }, { onSuccess: done("Finding withdrawn") })}
        />
      )}
      {dialog === "reopen" && (
        <ReasonDialog
          title={`Reopen ${f.reference}?`}
          label="Why is it being reopened?"
          confirmText="Reopen finding"
          pending={mutation.isPending}
          error={mutation.error}
          onClose={() => setDialog(null)}
          onConfirm={(reason) => mutation.mutate({ path: `/audit-findings/${f.id}/reopen`, body: { reason } }, { onSuccess: done("Finding reopened") })}
        />
      )}
    </div>
  );
};

export default AuditFindingPage;
