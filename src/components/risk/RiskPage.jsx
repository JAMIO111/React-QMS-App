import { useState } from "react";
import { useParams } from "react-router-dom";
import { ArchiveIcon, LockIcon, PencilIcon, RotateCcwIcon } from "@/components/icons";
import CTAButton from "@/components/CTAButton";
import { describeApiError } from "../../lib/api-client";
import { useToast } from "../../contexts/ToastProvider";
import { useRisk, useRiskModel, useRiskMutation } from "../../hooks/useRisk";
import { useBreadcrumbNames } from "../../lib/breadcrumbs";
import { BAND_LABEL, BAND_PILL, formatDay, isAcceptable, kindLabel, outcomeLabel, reviewWords, statusLabel, statusPill } from "../../lib/risk";
import { ErrorNotice } from "../master-data/shared";
import Callout from "../ui/Callout";
import LoadingScreen from "../ui/LoadingScreen";
import MenuCard from "../ui/MenuCard";
import { AssessDialog, RetireDialog, RiskDialog } from "./RiskDialogs";
import RiskMatrix from "./RiskMatrix";
import { AcceptanceCard, CloseDialog, ReviewsCard, TextDialog, TreatmentCard } from "./RiskTreatment";

const Fact = ({ label, children }) => (
  <div>
    <dt className="text-xs font-medium uppercase tracking-wide text-secondary-text">{label}</dt>
    <dd className="whitespace-pre-wrap text-sm text-primary-text">{children}</dd>
  </div>
);

/** One assessment in force, on the matrix with its reasoning. */
const AssessmentView = ({ current, detail, config, modelVersion, ariaLabel }) => (
  <div className="flex flex-wrap items-start gap-6">
    {config && <RiskMatrix config={config} selected={current} compact ariaLabel={ariaLabel} />}
    <dl className="flex min-w-56 flex-1 flex-col gap-3">
      <Fact label="Score">
        <span className="text-2xl font-semibold">{current.score}</span>{" "}
        <span className={`ml-1 inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${BAND_PILL[current.band]}`}>{BAND_LABEL[current.band]}</span>
      </Fact>
      <Fact label="Likelihood">
        {current.likelihood} · {detail?.likelihoodLabel}
      </Fact>
      <Fact label="Consequence">
        {current.consequence} · {detail?.consequenceLabel}
      </Fact>
      <Fact label="Why">{detail?.rationale}</Fact>
      <Fact label="Assessed">
        {formatDay(current.assessedOn)} by {detail?.assessedBy ?? "Unknown"} · matrix version {current.modelVersion}
        {modelVersion && current.modelVersion !== modelVersion ? ` (the matrix is now version ${modelVersion}: assess again to score it on that)` : ""}
      </Fact>
    </dl>
  </div>
);

/**
 * A risk or an opportunity (`/Risk/Register/:id`): what it is, where it sits before treatment, what is being done, what is left afterwards,
 * whether that is accepted, and when it is looked at again.
 */
const RiskPage = () => {
  const { id } = useParams();
  const query = useRisk(id);
  const model = useRiskModel();
  const mutation = useRiskMutation();
  const { showToast } = useToast();
  const [dialog, setDialog] = useState(null);
  const risk = query.data;
  useBreadcrumbNames([
    { path: `/Risk/Register/${id}`, label: risk ? `${risk.reference} · ${risk.title}` : null },
    { path: "/Risk", label: "Risk", to: "/Risk/Register" },
  ]);

  if (query.isLoading) return <LoadingScreen />;
  if (query.error) return <ErrorNotice error={query.error} />;
  const a = risk.inherent;
  const b = risk.residual;
  const live = !["closed", "retired", "draft"].includes(risk.status);
  const detailOf = (phase) => risk.assessments.find((x) => x.current && x.phase === phase);
  const config = model.data?.config;
  const opportunity = risk.kind === "opportunity";
  const bringBack = () =>
    mutation.mutate({ action: "reactivate", id: risk.id }, { onError: (err) => showToast({ type: "error", title: "Not brought back", message: describeApiError(err) }) });

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold text-primary-text">{risk.reference}</h1>
            <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusPill(risk.status)}`}>{statusLabel(risk.status)}</span>
            <span className="inline-flex rounded-full bg-secondary-bg px-2 py-0.5 text-xs font-medium text-secondary-text">{kindLabel(risk.kind)}</span>
          </div>
          <p className="text-lg text-primary-text">{risk.title}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {risk.canEdit && (
            <CTAButton type="main" onClick={() => setDialog("assess")}>
              {a ? "Assess again" : "Assess it"}
            </CTAButton>
          )}
          {risk.canEdit && (
            <CTAButton type="secondary" icon={PencilIcon} onClick={() => setDialog("edit")}>
              Edit details
            </CTAButton>
          )}
          {risk.canEdit && live && (
            <CTAButton type="secondary" icon={LockIcon} onClick={() => setDialog("close")}>
              Close
            </CTAButton>
          )}
          {risk.canManage && risk.status === "closed" && (
            <CTAButton type="secondary" icon={RotateCcwIcon} onClick={() => setDialog("reopen")}>
              Reopen
            </CTAButton>
          )}
          {risk.canManage && risk.status !== "retired" && (
            <CTAButton type="danger" icon={ArchiveIcon} onClick={() => setDialog("retire")}>
              Retire
            </CTAButton>
          )}
          {risk.canManage && risk.status === "retired" && (
            <CTAButton type="secondary" icon={RotateCcwIcon} loading={mutation.isPending} onClick={bringBack}>
              Bring back
            </CTAButton>
          )}
        </div>
      </header>

      {risk.status === "retired" && (
        <Callout tone="warning" title="Retired">
          {risk.retiredReason} ({formatDay(risk.retiredAt)}). It is kept with its assessments and can be brought back.
        </Callout>
      )}
      {risk.status === "draft" && (
        <Callout tone="info" title="Not assessed yet">
          {risk.canEdit ? "Assess it to put it in the register as open." : "It joins the register as open once it has been assessed."}
        </Callout>
      )}
      {risk.status === "closed" && (
        <Callout tone="success" title={`Closed: ${outcomeLabel(risk.outcome, risk.kind).toLowerCase()}`}>
          {risk.closeNote} ({formatDay(risk.closedAt)}
          {risk.closedBy ? `, ${risk.closedBy}` : ""}). It is kept as it is and can be reopened with a reason.
        </Callout>
      )}
      {live && risk.reopenReason && (
        <Callout tone="info" title="Reopened">
          {risk.reopenReason}
        </Callout>
      )}
      {live && risk.problems.length > 0 && (
        <Callout tone={risk.acceptance.above && !risk.acceptance.accepted && config && !isAcceptable(config, risk.band) ? "warning" : "info"} title="Still needed">
          <ul aria-label="Still needed" className="list-disc pl-5">
            {risk.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Callout>
      )}
      {live && risk.problems.length === 0 && (
        <Callout tone="success" title="Nothing left to do but keep an eye on it">
          {reviewWords(risk) ?? "It has no review date."}
        </Callout>
      )}
      {live && risk.reviewOverdue && <Callout tone="error">{reviewWords(risk)}. Record a review, or assess it again.</Callout>}

      <MenuCard title="Details">
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Fact label="Category">{risk.category.label}</Fact>
          <Fact label="Owner">{risk.owner?.name ?? "—"}</Fact>
          <Fact label="Where">{[risk.site?.name, risk.department?.name].filter(Boolean).join(" · ") || "The whole organisation"}</Fact>
          <Fact label="Raised">{formatDay(risk.createdAt)}</Fact>
          {risk.description && (
            <div className="sm:col-span-2 lg:col-span-4">
              <Fact label="Description">{risk.description}</Fact>
            </div>
          )}
          <div className="sm:col-span-1 lg:col-span-2">
            <Fact label={opportunity ? "What makes it possible" : "Cause"}>{risk.cause ?? "—"}</Fact>
          </div>
          <div className="sm:col-span-1 lg:col-span-2">
            <Fact label={opportunity ? "What would be gained" : "Effect"}>{risk.effect ?? "—"}</Fact>
          </div>
        </dl>
      </MenuCard>

      <MenuCard title="Before treatment" subtitle={opportunity ? "How likely it is and how much it would gain, as things stand." : "How likely it is and how bad it would be, as things stand."}>
        {a ? (
          <AssessmentView current={a} detail={detailOf("inherent")} config={config} modelVersion={model.data?.version} ariaLabel="Where it sits on the matrix" />
        ) : (
          <p className="text-sm text-secondary-text">Not assessed yet.</p>
        )}
      </MenuCard>

      {risk.status !== "draft" && <TreatmentCard risk={risk} />}

      {risk.status !== "draft" && (b || (risk.canEdit && risk.strategy && risk.strategy !== "accept")) && (
        <MenuCard
          title="After treatment"
          subtitle={opportunity ? "Where it stands now that it is being pursued." : "What is left once the treatment is in place."}
          action={
            risk.canEdit && (
              <CTAButton type="secondary" onClick={() => setDialog("residual")}>
                {b ? "Assess what is left again" : "Assess what is left"}
              </CTAButton>
            )
          }
        >
          {b ? (
            <AssessmentView current={b} detail={detailOf("residual")} config={config} modelVersion={model.data?.version} ariaLabel="Where it sits after treatment" />
          ) : (
            <p className="text-sm text-secondary-text">Not assessed yet. Do it once the actions are in place.</p>
          )}
        </MenuCard>
      )}

      {risk.status !== "draft" && <AcceptanceCard risk={risk} />}
      {risk.status !== "draft" && <ReviewsCard risk={risk} />}

      {risk.assessments.length > 1 && (
        <MenuCard title="Assessment history" subtitle="Every assessment is kept; a new one replaces the one before.">
          <ul className="-my-3 divide-y divide-border-color" aria-label="Assessment history">
            {risk.assessments.map((x) => (
              <li key={x.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div className="flex min-w-0 flex-col">
                  <span className="text-sm text-primary-text">
                    <span className="font-medium">{x.phase === "residual" ? "After treatment" : "Before treatment"}:</span> {x.likelihood} × {x.consequence} = {x.score} <span className="text-secondary-text">· {x.likelihoodLabel} × {x.consequenceLabel}</span>
                  </span>
                  <span className="whitespace-pre-wrap text-sm text-secondary-text">{x.rationale}</span>
                  <span className="text-xs text-secondary-text">
                    {formatDay(x.assessedOn)} · {x.assessedBy ?? "Unknown"} · matrix version {x.modelVersion}
                  </span>
                </div>
                <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${BAND_PILL[x.band]}`}>
                  {BAND_LABEL[x.band]}
                  {x.current ? " · current" : ""}
                </span>
              </li>
            ))}
          </ul>
        </MenuCard>
      )}

      {dialog === "edit" && <RiskDialog existing={risk} onClose={() => setDialog(null)} />}
      {dialog === "assess" && <AssessDialog risk={risk} onClose={() => setDialog(null)} />}
      {dialog === "residual" && <AssessDialog risk={risk} phase="residual" onClose={() => setDialog(null)} />}
      {dialog === "close" && <CloseDialog risk={risk} onClose={() => setDialog(null)} />}
      {dialog === "reopen" && (
        <TextDialog title={`Reopen ${risk.reference}`} intro="It comes back into the register where the facts put it, due for a review today." label="Why is it reopened?" confirm="Reopen" command={{ action: "reopen", id: risk.id }} onClose={() => setDialog(null)} />
      )}
      {dialog === "retire" && <RetireDialog risk={risk} onClose={() => setDialog(null)} />}
    </div>
  );
};

export default RiskPage;
