import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { LinkIcon, PencilIcon, XIcon } from "@/components/icons";
import CTAButton from "@/components/CTAButton";
import { useChange, useChangeAttachmentMutation, useChangeAttachments } from "../../hooks/useChange";
import { useBreadcrumbNames } from "../../lib/breadcrumbs";
import { draftProblems, formatDay, linkKindLabel, linkPath, linkWords, originLabel, recordPath, stageLabel, stagePill, urgencyLabel } from "../../lib/change";
import { ErrorNotice } from "../master-data/shared";
import Callout from "../ui/Callout";
import { AttachmentDrop } from "../ui/FileDrop";
import LoadingScreen from "../ui/LoadingScreen";
import MenuCard from "../ui/MenuCard";
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

/**
 * A change (`/Change/:id`): what is changing and why, where it came from, what it covers and its files. In this first slice a change is a draft
 * (or cancelled); assessing it, the board's sign-off and the tasks that carry it out come next.
 */
const ChangePage = () => {
  const { id } = useParams();
  const query = useChange(id);
  const [dialog, setDialog] = useState(null);
  const change = query.data;
  useBreadcrumbNames([{ path: `/Change/${id}`, label: change ? `${change.reference} · ${change.title}` : null }]);

  if (query.isLoading) return <LoadingScreen />;
  if (query.error) return <ErrorNotice error={query.error} />;
  const problems = change.stage === "draft" ? draftProblems(change) : [];

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold text-primary-text">{change.reference}</h1>
            <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${stagePill(change.stage)}`}>{stageLabel(change.stage)}</span>
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

      {change.stage === "cancelled" && (
        <Callout tone="warning" title="Cancelled">
          {change.cancelReason} ({formatDay(change.cancelledAt)}
          {change.cancelledBy ? `, ${change.cancelledBy}` : ""}). It is kept as it is.
        </Callout>
      )}
      {change.stage === "draft" && problems.length > 0 && (
        <Callout tone="info" title="Still needed before it can be assessed">
          <ul aria-label="Still needed" className="list-disc pl-5">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Callout>
      )}
      {change.stage === "draft" && (
        <Callout tone="info" title="Assessment and sign-off are not built yet">
          For now a change records what is changing, why, where it came from, what it covers and its files. Assessing it, the board&apos;s sign-off and the tasks that carry it out come in the next slices.
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

      <ChangeFiles change={change} />

      {dialog === "edit" && <ChangeDialog existing={change} onClose={() => setDialog(null)} />}
      {dialog === "links" && <LinksDialog change={change} onClose={() => setDialog(null)} />}
      {dialog === "cancel" && <CancelDialog change={change} onClose={() => setDialog(null)} />}
    </div>
  );
};

export default ChangePage;
