import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { CheckIcon, LinkIcon, PencilIcon, SendIcon, Undo2Icon, UsersIcon, XIcon } from "@/components/icons";
import CTAButton from "@/components/CTAButton";
import { useFmeaMutation, useFmeaRevision } from "../../hooks/useFmea";
import { useBreadcrumbNames } from "../../lib/breadcrumbs";
import { withVersion } from "../../lib/editConflicts";
import { fmeaPath, formatDay, kindLabel, linkKindLabel, linkPath, linkWords, revisionName, revisionPill, revisionStatusLabel, roleLabel } from "../../lib/fmea";
import { ErrorNotice, FormError, TextAreaField } from "../master-data/shared";
import Callout from "../ui/Callout";
import LoadingScreen from "../ui/LoadingScreen";
import MenuCard from "../ui/MenuCard";
import AnalysisEditor from "./AnalysisEditor";
import CoverageCard from "./CoverageCard";
import { BaseChangesCallout, CompareCard } from "./LifecyclePanels";
import { ApproveDialog, ApproverDialog, LinksDialog, ReasonDialog, TeamDialog } from "./FmeaDialogs";

/** The wording of a draft: what changed and why. Saved as the person leaves the box. */
const SummaryCard = ({ revision, required }) => {
  const mutation = useFmeaMutation();
  const [text, setText] = useState(revision.changeSummary ?? "");
  const save = () => {
    const next = text.trim() || null;
    if (next === (revision.changeSummary ?? null)) return;
    mutation.mutate({ action: "updateRevision", id: revision.id, body: withVersion(revision, { changeSummary: next }) });
  };
  return (
    <MenuCard title="What changed and why" subtitle={required ? "Needed before it can be submitted: this revision follows one that has been in force." : "Optional for a first revision."}>
      <TextAreaField label="What changed and why" value={text} onChange={(e) => setText(e.target.value)} onBlur={save} maxLength={4000} rows={3} required={required} />
    </MenuCard>
  );
};

/** One revision (`/FMEA/:id/revisions/:revisionId`): the team, what it covers, who approves it, and where it stands in review and approval. */
const RevisionPage = () => {
  const { id, revisionId } = useParams();
  const query = useFmeaRevision(revisionId);
  const mutation = useFmeaMutation();
  const [dialog, setDialog] = useState(null);
  const revision = query.data;
  useBreadcrumbNames([
    { path: `/FMEA/${id}`, label: revision ? `${revision.fmea.number} · ${revision.fmea.title}` : null },
    { path: `/FMEA/${id}/revisions/${revisionId}`, label: revision ? revisionName(revision) : null },
  ]);

  if (query.isLoading) return <LoadingScreen />;
  if (query.error) return <ErrorNotice error={query.error} />;
  const status = revision.status;
  const notReady = revision.problems.length > 0;
  const needsSummary = revision.problems.includes("Say what changed and why") || (revision.changeSummary != null && status === "draft");

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold text-primary-text">
              <Link to={fmeaPath(revision.fmeaId)} className="hover:underline">
                {revision.fmea.number}
              </Link>{" "}
              {revisionName(revision)}
            </h1>
            <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${revisionPill(status)}`}>{revisionStatusLabel(status)}</span>
            <span className="inline-flex rounded-full bg-secondary-bg px-2 py-0.5 text-xs font-medium text-secondary-text">{kindLabel(revision.fmea.kind)}</span>
          </div>
          <p className="text-lg text-primary-text">{revision.fmea.title}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {revision.canEdit && (
            <CTAButton type="main" icon={SendIcon} disabled={notReady} loading={mutation.isPending && mutation.variables?.action === "submit"} onClick={() => mutation.mutate({ action: "submit", id: revision.id })}>
              Submit for approval
            </CTAButton>
          )}
          {revision.canDecide && (
            <>
              <CTAButton type="main" icon={CheckIcon} onClick={() => setDialog("approve")}>
                Approve
              </CTAButton>
              <CTAButton type="secondary" icon={Undo2Icon} onClick={() => setDialog("sendBack")}>
                Send back
              </CTAButton>
            </>
          )}
          {revision.canRecall && !revision.canDecide && (
            <CTAButton type="secondary" icon={Undo2Icon} onClick={() => setDialog("recall")}>
              Take back to draft
            </CTAButton>
          )}
          {revision.canEdit && (
            <CTAButton type="danger" icon={XIcon} onClick={() => setDialog("discard")}>
              Discard draft
            </CTAButton>
          )}
        </div>
      </header>
      <FormError error={mutation.error} />

      {status === "draft" && revision.returnedComment && (
        <Callout tone="warning" title="Sent back">
          {revision.returnedComment}
          {revision.returnedBy ? ` (${revision.returnedBy.name}, ${formatDay(revision.returnedAt)})` : ""}. Deal with it, then submit again.
        </Callout>
      )}
      {status === "pending_approval" && (
        <Callout tone="info" title="Waiting for approval">
          {revision.approver ? `${revision.approver.name} approves it.` : "Waiting for the approver."} The revision is frozen while it waits.
        </Callout>
      )}
      {status === "effective" && (
        <Callout tone="success" title="In force">
          Approved {formatDay(revision.approvedAt)}
          {revision.approvedBy ? ` by ${revision.approvedBy.name}` : ""}; in force from {formatDay(revision.effectiveFrom)}.
          {revision.approvalComment ? ` “${revision.approvalComment}”` : ""}
        </Callout>
      )}
      {status === "approved" && (
        <Callout tone="info" title="Approved">
          It takes effect on {formatDay(revision.effectiveFrom)}; until then the revision in force stays in force.
        </Callout>
      )}
      {status === "superseded" && <Callout tone="neutral" title="Superseded">A later revision is in force. This one is kept as it was.</Callout>}
      {status === "withdrawn" && <Callout tone="warning" title="Withdrawn">{revision.withdrawReason}</Callout>}
      {status === "discarded" && <Callout tone="neutral" title="Discarded">{revision.discardReason}</Callout>}
      {status === "draft" && revision.canEdit && notReady && (
        <Callout tone="info" title="Still needed before it can be submitted">
          <ul aria-label="Still needed" className="list-disc pl-5">
            {revision.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Callout>
      )}
      <BaseChangesCallout revision={revision} />
      <AnalysisEditor revision={revision} />
      <CoverageCard revision={revision} />
      <CompareCard revision={revision} />

      <MenuCard
        title="The team"
        subtitle="A cross-functional team: the lead and the people who know the design or the process."
        action={
          revision.canEdit && (
            <CTAButton type="secondary" icon={revision.team.length ? PencilIcon : UsersIcon} onClick={() => setDialog("team")}>
              {revision.team.length ? "Change" : "Add"}
            </CTAButton>
          )
        }>
        {revision.team.length === 0 ? (
          <p className="text-sm text-secondary-text">Nobody yet.</p>
        ) : (
          <ul aria-label="Team" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {revision.team.map((m) => (
              <li key={m.id} className="rounded-xl border border-border-color bg-primary-bg px-3 py-2 text-sm">
                <span className="font-medium text-primary-text">{m.name}</span>
                <span className="block text-secondary-text">
                  {roleLabel(m.role)}
                  {m.jobTitle ? ` · ${m.jobTitle}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </MenuCard>

      <MenuCard
        title="What it covers"
        subtitle="The parts, families, control plans, machines and operations the analysis is about. They stay where they are; each opens to people who may read it."
        action={
          revision.canEdit && (
            <CTAButton type="secondary" icon={revision.links.length ? PencilIcon : LinkIcon} onClick={() => setDialog("links")}>
              {revision.links.length ? "Change" : "Add"}
            </CTAButton>
          )
        }>
        {revision.links.length === 0 ? (
          <p className="text-sm text-secondary-text">Nothing yet.</p>
        ) : (
          <ul aria-label="What it covers" className="flex flex-wrap gap-2">
            {revision.links.map((l) => {
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
        )}
      </MenuCard>

      <MenuCard
        title="Approval"
        subtitle="Someone who holds the approve permission and did not prepare the revision."
        action={
          revision.canEdit && (
            <CTAButton type="secondary" icon={PencilIcon} onClick={() => setDialog("approver")}>
              {revision.approver ? "Change" : "Name the approver"}
            </CTAButton>
          )
        }>
        <dl className="grid gap-4 sm:grid-cols-3">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-secondary-text">Prepared by</dt>
            <dd className="text-sm text-primary-text">{revision.author?.name ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-secondary-text">Approver</dt>
            <dd className="text-sm text-primary-text">{revision.approver?.name ?? "Not named yet"}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-secondary-text">Submitted</dt>
            <dd className="text-sm text-primary-text">{revision.submittedAt ? formatDay(revision.submittedAt) : "—"}</dd>
          </div>
        </dl>
      </MenuCard>

      {(revision.canEdit || revision.changeSummary) &&
        (revision.canEdit ? <SummaryCard revision={revision} required={needsSummary} /> : (
          <MenuCard title="What changed and why">
            <p className="whitespace-pre-wrap text-sm text-primary-text">{revision.changeSummary}</p>
          </MenuCard>
        ))}

      {dialog === "team" && <TeamDialog revision={revision} onClose={() => setDialog(null)} />}
      {dialog === "links" && <LinksDialog revision={revision} onClose={() => setDialog(null)} />}
      {dialog === "approver" && <ApproverDialog revision={revision} onClose={() => setDialog(null)} />}
      {dialog === "approve" && <ApproveDialog revision={revision} onClose={() => setDialog(null)} />}
      {dialog === "sendBack" && (
        <ReasonDialog
          title="Send it back"
          intro="It returns to draft with your comment, and the preparer submits it again once it is dealt with."
          label="What needs changing?"
          button="Send back"
          action="sendBack"
          field="comment"
          id={revision.id}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "recall" && (
        <ReasonDialog
          title="Take it back to draft"
          intro="The approver is no longer asked. Submit it again when it is ready."
          label="Why is it taken back?"
          button="Take it back"
          action="recall"
          id={revision.id}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "discard" && (
        <ReasonDialog
          title="Discard this draft"
          intro="It stays on the record with your reason. The only draft of an FMEA that has never been in force discards the FMEA with it."
          label="Why is it discarded?"
          button="Discard the draft"
          tone="danger"
          action="discard"
          id={revision.id}
          onClose={() => {
            setDialog(null);
          }}
        />
      )}
    </div>
  );
};

export default RevisionPage;
