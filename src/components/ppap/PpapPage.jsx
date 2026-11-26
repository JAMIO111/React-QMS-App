import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ChevronDownIcon, ChevronRightIcon, PencilIcon, PlusIcon, XIcon } from "@/components/icons";
import CTAButton from "@/components/CTAButton";
import { generateSignedUrl } from "../../api/supabaseApi";
import { useToast } from "../../contexts/ToastProvider";
import { usePpap, usePpapMutation } from "../../hooks/usePpap";
import { describeApiError } from "../../lib/api-client";
import { useBreadcrumbNames } from "../../lib/breadcrumbs";
import { LEVELS, REQUIREMENT_OPTIONS, elementStatusLabel, elementStatusPill, evidenceName, fileSizeLabel, formatDay, levelLabel, linkKindLabel, linkKindsFor, linkVerdict, progressPercent, progressWords, reasonLabel, requirementLabel, statusLabel, statusPill, verdictPill } from "../../lib/ppap";
import { ErrorNotice, TextAreaField } from "../master-data/shared";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import LoadingScreen from "../ui/LoadingScreen";
import MenuCard from "../ui/MenuCard";
import { AddFileDialog, EditPpapDialog, LinkDialog, ReasonDialog } from "./PpapDialogs";

const Fact = ({ label, children }) => (
  <div>
    <dt className="text-xs font-medium uppercase tracking-wide text-secondary-text">{label}</dt>
    <dd className="whitespace-pre-wrap text-sm text-primary-text">{children}</dd>
  </div>
);

const LEVEL_OPTIONS = LEVELS.map((l) => ({ value: String(l), label: levelLabel(l) }));

/** A piece of evidence that is a link to a record: its name, how it stands now (in words and colour), the study judged against the agreed minimum, and what it was when frozen. */
const LinkEvidence = ({ evidence, editable, onRemove }) => {
  const link = evidence.link;
  const verdict = linkVerdict(link);
  const changed = link.state?.changedSince;
  return (
    <li className="flex flex-col gap-0.5 rounded-md border border-border-color p-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-primary-text">{evidenceName(evidence)}</span>
        <span className="text-secondary-text">{linkKindLabel(link.targetKind)}</span>
        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${verdictPill(verdict.tone)}`}>{verdict.tone === "success" ? "In good standing" : verdict.tone === "error" ? "Needs attention" : "Not shown"}</span>
        {evidence.description && <span className="text-primary-text">{evidence.description}</span>}
        {editable && (
          <button type="button" aria-label={`Remove ${evidenceName(evidence)}`} onClick={onRemove} className="ml-auto rounded p-0.5 text-secondary-text hover:text-error-color cursor-pointer">
            <XIcon className="h-4 w-4" />
          </button>
        )}
      </div>
      <p className="text-secondary-text">{verdict.words}</p>
      {link.study && <p className="text-secondary-text">{link.study.text}</p>}
      {link.frozenAt && (
        <p className="text-secondary-text">
          Frozen when submitted: {link.frozenLabel} ({String(link.frozenStatus).replace(/_/g, " ")})
          {changed ? <span className="font-medium text-warning-color"> — it has changed since</span> : ""}
        </p>
      )}
    </li>
  );
};

/** One element of the submission: its requirement and status in the list, and (opened) its evidence, note and what can be done with it. */
const ElementRow = ({ ppap, element, onDialog, mutate, pendingId }) => {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState(element.note ?? "");
  const { showToast } = useToast();
  const editable = ppap.editable;
  const busy = pendingId === element.id;
  const waived = element.status === "waived";
  const live = element.evidence.filter((v) => !v.removedAt);
  const removed = element.evidence.filter((v) => v.removedAt);

  const openFile = async (v) => {
    const url = await generateSignedUrl("ppap-files", v.storagePath);
    if (url) window.open(url, "_blank", "noopener");
    else showToast({ type: "error", title: "The file could not be opened", message: "Try again in a moment." });
  };

  return (
    <li className="border-b border-border-color last:border-0">
      <div className="flex flex-wrap items-center gap-3 px-1 py-2">
        <button type="button" aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} ${element.label}`} onClick={() => setOpen((o) => !o)} className="rounded p-1 hover:bg-secondary-bg cursor-pointer">
          {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
        </button>
        <span className="w-6 shrink-0 text-right text-sm text-secondary-text">{element.ordinal}</span>
        <span className="min-w-48 flex-1 font-medium text-primary-text">{element.label}</span>
        <span className="inline-flex rounded-full bg-secondary-bg px-2 py-0.5 text-xs font-medium text-secondary-text">{requirementLabel(element.requirement)}</span>
        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${elementStatusPill(element.status)}`}>{elementStatusLabel(element.status)}</span>
        <span className="w-28 shrink-0 text-right text-sm text-secondary-text">{element.liveEvidence === 1 ? "1 item" : `${element.liveEvidence} items`}</span>
      </div>
      {open && (
        <div className="flex flex-col gap-3 pb-4 pl-12 pr-1">
          {waived && (
            <Callout tone="warning" title="Waived" action={ppap.canApprove && ppap.editable ? <CTAButton type="neutral" size="md" loading={busy} onClick={() => mutate({ action: "unwaive", id: element.id })}>Take the waiver off</CTAButton> : undefined}>
              {element.waiver.reason} <span className="text-secondary-text">— {element.waiver.by?.name}, {formatDay(element.waiver.at.slice(0, 10))}</span>
            </Callout>
          )}
          {live.length === 0 && removed.length === 0 && <p className="text-sm text-secondary-text">No evidence yet.</p>}
          {live.length > 0 && (
            <ul aria-label={`Evidence for ${element.label}`} className="flex flex-col gap-1">
              {live.map((v) =>
                v.kind === "link" ? (
                  <LinkEvidence key={v.id} evidence={v} editable={editable} onRemove={() => onDialog({ kind: "remove", evidence: v })} />
                ) : (
                  <li key={v.id} className="flex flex-wrap items-center gap-2 text-sm">
                    <button type="button" onClick={() => openFile(v)} className="font-medium text-link-color hover:underline cursor-pointer">
                      {v.fileName}
                    </button>
                    <span className="text-secondary-text">{fileSizeLabel(v.sizeBytes)}</span>
                    {v.description && <span className="text-primary-text">{v.description}</span>}
                    <span className="text-secondary-text">
                      {v.addedBy?.name} · {formatDay(v.addedAt.slice(0, 10))}
                    </span>
                    {editable && (
                      <button type="button" aria-label={`Remove ${v.fileName}`} onClick={() => onDialog({ kind: "remove", evidence: v })} className="rounded p-0.5 text-secondary-text hover:text-error-color cursor-pointer">
                        <XIcon className="h-4 w-4" />
                      </button>
                    )}
                  </li>
                ),
              )}
            </ul>
          )}
          {removed.length > 0 && (
            <ul aria-label="Removed evidence" className="flex flex-col gap-0.5 text-sm text-secondary-text">
              {removed.map((v) => (
                <li key={v.id}>
                  <span className="line-through">{evidenceName(v)}</span> removed: {v.removeReason}
                </li>
              ))}
            </ul>
          )}
          {editable && !waived && (
            <div className="grid gap-3 md:grid-cols-2">
              <ComboField
                label="Requirement"
                value={element.requirement}
                onChange={(v) => v && v !== element.requirement && mutate({ action: "updateElement", id: element.id, body: { requirement: v } })}
                options={REQUIREMENT_OPTIONS}
                clearable={false}
                sort={false}
              />
              <TextAreaField label="Note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} onBlur={() => note.trim() !== (element.note ?? "") && mutate({ action: "updateElement", id: element.id, body: { note: note.trim() || null } })} maxLength={2000} />
            </div>
          )}
          {!editable && element.note && <p className="whitespace-pre-wrap text-sm text-primary-text">{element.note}</p>}
          {editable && (
            <div className="flex flex-wrap gap-2">
              {!waived && linkKindsFor(element.key).length > 0 && (
                <CTAButton type="secondary" size="md" icon={PlusIcon} onClick={() => onDialog({ kind: "link", element })}>
                  Link a record
                </CTAButton>
              )}
              {!waived && (
                <CTAButton type="secondary" size="md" icon={PlusIcon} onClick={() => onDialog({ kind: "file", element })}>
                  Add a file
                </CTAButton>
              )}
              {!waived && element.status !== "ready" && (
                <CTAButton type="main" size="md" loading={busy} onClick={() => mutate({ action: "updateElement", id: element.id, body: { status: "ready" } })}>
                  Mark ready
                </CTAButton>
              )}
              {!waived && element.status === "ready" && (
                <CTAButton type="neutral" size="md" loading={busy} onClick={() => mutate({ action: "updateElement", id: element.id, body: { status: "in_progress" } })}>
                  Not ready after all
                </CTAButton>
              )}
              {ppap.canApprove && !waived && element.requirement === "required" && (
                <CTAButton type="neutral" size="md" onClick={() => onDialog({ kind: "waive", element })}>
                  Waive…
                </CTAButton>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
};

/** A PPAP submission (`/PPAP/:id`): the part and customer, the level and why, the 18 elements with their evidence, what is still needed, and the preparation steps. */
const PpapPage = () => {
  const { id } = useParams();
  const query = usePpap(id);
  const mutation = usePpapMutation();
  const { showToast } = useToast();
  const [dialog, setDialog] = useState(null);
  const ppap = query.data;
  useBreadcrumbNames([{ path: `/PPAP/${id}`, label: ppap ? `${ppap.reference} · ${ppap.part?.partNumber ?? ""}` : null }]);

  if (query.isLoading) return <LoadingScreen />;
  if (query.error) return <ErrorNotice error={query.error} />;

  const fail = (err) => showToast({ type: "error", title: "Not saved", message: describeApiError(err) });
  const mutate = (vars, options) => mutation.mutate(vars, { onError: fail, ...options });
  const pendingAction = (a) => mutation.isPending && mutation.variables?.action === a;
  const pendingId = mutation.isPending ? mutation.variables?.id : null;
  const partWords = [ppap.part?.partNumber, ppap.part?.name].filter(Boolean).join(" · ");
  const percent = progressPercent(ppap.progress);

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold text-primary-text">{ppap.reference}</h1>
            <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusPill(ppap.status)}`}>{statusLabel(ppap.status)}</span>
            <span className="inline-flex rounded-full bg-secondary-bg px-2 py-0.5 text-xs font-medium text-secondary-text">{levelLabel(ppap.level)}</span>
          </div>
          <p className="text-lg text-primary-text">
            {partWords || "Part"}
            {ppap.partRevision?.label ? ` · revision ${ppap.partRevision.label}` : ""}
          </p>
          <p className="text-sm text-secondary-text">
            For {ppap.customer?.name ?? "a customer you cannot read"} · {reasonLabel(ppap.reason)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {ppap.editable && (
            <CTAButton type="neutral" icon={PencilIcon} onClick={() => setDialog({ kind: "edit" })}>
              Edit
            </CTAButton>
          )}
          {ppap.editable && (
            <CTAButton type="main" disabled={!ppap.canMarkReady} title={ppap.canMarkReady ? undefined : "Nothing can be marked ready while something is still needed"} loading={pendingAction("ready")} onClick={() => mutate({ action: "ready", id: ppap.id })}>
              Mark ready
            </CTAButton>
          )}
          {ppap.canReopen && (
            <CTAButton type="neutral" loading={pendingAction("reopen")} onClick={() => mutate({ action: "reopen", id: ppap.id })}>
              Back to preparation
            </CTAButton>
          )}
          {ppap.canWithdraw && (
            <CTAButton type="danger" onClick={() => setDialog({ kind: "withdraw" })}>
              Withdraw
            </CTAButton>
          )}
        </div>
      </header>

      {ppap.status === "withdrawn" && <Callout tone="warning" title="Withdrawn">{ppap.withdrawReason}</Callout>}
      {ppap.status === "ready" && (
        <Callout tone="success" title="Ready">
          Every required element has evidence or a waiver. Sending the submission and recording the customer's decision arrive in a later release; until then you can take it back to preparation.
        </Callout>
      )}
      {ppap.editable && ppap.problems.length > 0 && (
        <Callout tone="info" title={`Still needed before it can be marked ready (${ppap.problems.length})`}>
          <ul aria-label="Still needed" className="mt-1 list-disc pl-5">
            {ppap.problems.slice(0, 6).map((p) => (
              <li key={p}>{p}</li>
            ))}
            {ppap.problems.length > 6 && <li>…and {ppap.problems.length - 6} more</li>}
          </ul>
        </Callout>
      )}

      <MenuCard title="About this submission">
        <dl className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <Fact label="Part">
            {ppap.part?.id ? (
              <Link to={`/Parts/${ppap.part.id}`} className="text-link-color hover:underline">
                {partWords || "Open the part"}
              </Link>
            ) : (
              "—"
            )}
          </Fact>
          <Fact label="Customer">{ppap.customer?.name ?? "—"}</Fact>
          <Fact label="Owner">{ppap.owner?.name ?? "—"}</Fact>
          <Fact label="Site">{ppap.site?.name ?? "—"}</Fact>
          <Fact label="Requirements">Version {ppap.requirementSet?.version ?? "—"}</Fact>
          <Fact label="Started">{formatDay(ppap.createdAt.slice(0, 10))}</Fact>
          <Fact label="Ready">{ppap.readyAt ? formatDay(ppap.readyAt.slice(0, 10)) : "—"}</Fact>
          <Fact label="Notes">{ppap.notes ?? "—"}</Fact>
        </dl>
        {ppap.editable && (
          <div className="border-t border-border-color p-4">
            <div className="max-w-sm">
              <ComboField
                label="Level"
                value={String(ppap.level)}
                onChange={(v) => v && Number(v) !== ppap.level && mutate({ action: "setLevel", id: ppap.id, body: { level: Number(v) } })}
                options={LEVEL_OPTIONS}
                clearable={false}
                sort={false}
                hint="Changing the level sets again the requirement of every element you have not touched."
              />
            </div>
          </div>
        )}
      </MenuCard>

      <MenuCard title="The 18 elements" subtitle={progressWords(ppap.progress)}>
        <div className="px-4 pt-3">
          <div role="progressbar" aria-label="Required elements done" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-2 w-full overflow-hidden rounded-full bg-secondary-bg">
            <div className="h-full rounded-full bg-brand-primary" style={{ width: `${percent}%` }} />
          </div>
        </div>
        <ul aria-label="Elements" className="px-3 py-2">
          {ppap.elements.map((e) => (
            <ElementRow key={e.id} ppap={ppap} element={e} mutate={mutate} pendingId={pendingId} onDialog={setDialog} />
          ))}
        </ul>
        <p className="border-t border-border-color px-4 py-3 text-sm text-secondary-text">
          Evidence is a link to a record Fortress already holds (the control plan, FMEA, inspections, gauge studies, documents) or a file. A link shows what the record is now, and is frozen when the submission is sent. The Part Submission Warrant is generated later.
        </p>
      </MenuCard>

      {dialog?.kind === "edit" && <EditPpapDialog ppap={ppap} onClose={() => setDialog(null)} />}
      {dialog?.kind === "link" && <LinkDialog element={dialog.element} onClose={() => setDialog(null)} />}
      {dialog?.kind === "file" && <AddFileDialog ppap={ppap} element={dialog.element} onClose={() => setDialog(null)} />}
      {dialog?.kind === "withdraw" && (
        <ReasonDialog
          title={`Withdraw ${ppap.reference}`}
          label="Why is it withdrawn"
          submitLabel="Withdraw"
          tone="danger"
          pending={pendingAction("withdraw")}
          error={mutation.error}
          onClose={() => setDialog(null)}
          onSubmit={(reason) => mutation.mutate({ action: "withdraw", id: ppap.id, body: { reason } }, { onSuccess: () => setDialog(null) })}
        />
      )}
      {dialog?.kind === "remove" && (
        <ReasonDialog
          title={`Remove ${evidenceName(dialog.evidence)}`}
          label="Why is it removed"
          hint="It is kept, marked removed with this reason"
          submitLabel="Remove"
          tone="danger"
          pending={pendingAction("removeEvidence")}
          error={mutation.error}
          onClose={() => setDialog(null)}
          onSubmit={(reason) => mutation.mutate({ action: "removeEvidence", id: dialog.evidence.id, body: { reason } }, { onSuccess: () => setDialog(null) })}
        />
      )}
      {dialog?.kind === "waive" && (
        <ReasonDialog
          title={`Waive ${dialog.element.label}`}
          label="Why is it waived"
          hint="At least 10 characters. The reason is kept with the submission."
          minLength={10}
          submitLabel="Waive it"
          pending={pendingAction("waive")}
          error={mutation.error}
          onClose={() => setDialog(null)}
          onSubmit={(reason) => mutation.mutate({ action: "waive", id: dialog.element.id, body: { reason } }, { onSuccess: () => setDialog(null) })}
        />
      )}
    </div>
  );
};

export default PpapPage;
