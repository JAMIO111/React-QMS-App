import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { PencilIcon, PlusIcon, XIcon } from "@/components/icons";
import CTAButton from "@/components/CTAButton";
import { useFmea, useFmeaMutation } from "../../hooks/useFmea";
import { useBreadcrumbNames } from "../../lib/breadcrumbs";
import { formatDay, kindLabel, revisionName, revisionPath, revisionPill, revisionStatusLabel, statusLabel, statusPill } from "../../lib/fmea";
import { ErrorNotice, FormError } from "../master-data/shared";
import Callout from "../ui/Callout";
import LoadingScreen from "../ui/LoadingScreen";
import MenuCard from "../ui/MenuCard";
import { FmeaDialog, ReasonDialog } from "./FmeaDialogs";
import { ReviewsCard, StartRevisionDialog } from "./LifecyclePanels";

const Fact = ({ label, children }) => (
  <div>
    <dt className="text-xs font-medium uppercase tracking-wide text-secondary-text">{label}</dt>
    <dd className="whitespace-pre-wrap text-sm text-primary-text">{children}</dd>
  </div>
);

/** An FMEA (`/FMEA/:id`): what it is, who owns it, when it is next reviewed, and its revisions; the analysis itself is on a revision. */
const FmeaPage = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const query = useFmea(id);
  const mutation = useFmeaMutation();
  const [dialog, setDialog] = useState(null);
  const fmea = query.data;
  useBreadcrumbNames([{ path: `/FMEA/${id}`, label: fmea ? `${fmea.number} · ${fmea.title}` : null }]);

  if (query.isLoading) return <LoadingScreen />;
  if (query.error) return <ErrorNotice error={query.error} />;

  const open = (updated) => updated?.inProgress && navigate(revisionPath(fmea.id, updated.inProgress.id));
  // With finished actions waiting, the person chooses whether the new revision takes them in; without, it starts at once.
  const startRevision = () => (fmea.adoptableActions > 0 ? setDialog("start") : mutation.mutate({ action: "startRevision", id: fmea.id }, { onSuccess: open }));

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold text-primary-text">{fmea.number}</h1>
            <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusPill(fmea.status)}`}>{statusLabel(fmea.status)}</span>
            <span className="inline-flex rounded-full bg-secondary-bg px-2 py-0.5 text-xs font-medium text-secondary-text">{kindLabel(fmea.kind)}</span>
            {fmea.waitingForMe && <span className="inline-flex rounded-full bg-warning-color/15 px-2 py-0.5 text-xs font-medium text-warning-color">Waiting for you</span>}
          </div>
          <p className="text-lg text-primary-text">{fmea.title}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {fmea.inProgress && (
            <CTAButton type="main" to={revisionPath(fmea.id, fmea.inProgress.id)}>
              {fmea.inProgress.status === "draft" ? "Open the draft" : "Open the revision"}
            </CTAButton>
          )}
          {fmea.canStartRevision && (
            <CTAButton type="main" icon={PlusIcon} loading={mutation.isPending && mutation.variables?.action === "startRevision"} onClick={startRevision}>
              Start a new revision
            </CTAButton>
          )}
          {fmea.canManage && (
            <CTAButton type="secondary" icon={PencilIcon} onClick={() => setDialog("edit")}>
              Edit details
            </CTAButton>
          )}
          {fmea.canWithdraw && (
            <CTAButton type="danger" icon={XIcon} onClick={() => setDialog("withdraw")}>
              Withdraw
            </CTAButton>
          )}
        </div>
      </header>
      <FormError error={mutation.error} />

      {fmea.status === "withdrawn" && (
        <Callout tone="warning" title="Withdrawn">
          {fmea.withdrawReason}. It is kept as it was; start a new revision to bring it back.
        </Callout>
      )}
      {fmea.reviewOverdue && (
        <Callout tone="warning" title="Review overdue">
          It was due for review on {formatDay(fmea.nextReviewOn)}. Check it still reflects the design or process; start a new revision if it does not.
        </Callout>
      )}

      <MenuCard title="Details">
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Fact label="Owner">{fmea.owner?.name ?? "—"}</Fact>
          <Fact label="Customer">{fmea.customer?.name ?? "—"}</Fact>
          <Fact label="In force">{fmea.currentLetter ? `Rev ${fmea.currentLetter} from ${formatDay(fmea.currentEffectiveFrom)}` : "Not yet"}</Fact>
          <Fact label="Next review">{fmea.nextReviewOn ? formatDay(fmea.nextReviewOn) : "—"}</Fact>
          <Fact label="Reviewed every">{fmea.reviewMonths ? `${fmea.reviewMonths} months` : "12 months (the default)"}</Fact>
          <div className="sm:col-span-2 lg:col-span-3">
            <Fact label="Scope and intended use">{fmea.scopeText ?? "—"}</Fact>
          </div>
        </dl>
      </MenuCard>

      <MenuCard title="Revisions" subtitle="Each revision is frozen once it is approved. A change is made in a new revision that says what changed and why.">
        <ul aria-label="Revisions" className="flex flex-col gap-2">
          {fmea.revisions.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-border-color bg-primary-bg px-3 py-2 text-sm">
              <Link to={revisionPath(fmea.id, r.id)} className="font-medium text-primary-text hover:underline">
                {revisionName(r)}
              </Link>
              <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${revisionPill(r.status)}`}>{revisionStatusLabel(r.status)}</span>
              <span className="text-secondary-text">
                {r.author ? `by ${r.author.name}` : ""}
                {r.effectiveFrom ? ` · from ${formatDay(r.effectiveFrom)}` : ""}
                {r.approver && ["pending_approval", "draft"].includes(r.status) ? ` · approver ${r.approver.name}` : ""}
              </span>
              {r.changeSummary && <span className="basis-full text-secondary-text">{r.changeSummary}</span>}
              {r.discardReason && <span className="basis-full text-secondary-text">Discarded: {r.discardReason}</span>}
            </li>
          ))}
        </ul>
      </MenuCard>

      <ReviewsCard fmea={fmea} onStarted={open} />

      {dialog === "start" && <StartRevisionDialog fmea={fmea} onClose={() => setDialog(null)} onStarted={open} />}
      {dialog === "edit" && <FmeaDialog existing={fmea} onClose={() => setDialog(null)} />}
      {dialog === "withdraw" && (
        <ReasonDialog
          title={`Withdraw ${fmea.number}`}
          intro="It stops being in force and is kept as it was. Start a new revision to bring it back."
          label="Why is it withdrawn?"
          button="Withdraw the FMEA"
          tone="danger"
          action="withdraw"
          id={fmea.id}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
};

export default FmeaPage;
